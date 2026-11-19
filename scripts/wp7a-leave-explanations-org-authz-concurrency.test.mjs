/**
 * WP7A — Leave Management & Attendance Explanations Real PostgreSQL Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks under `SET ROLE service_role`:
 *   1. `org_department_designate_head_admin` (replace HEAD Alice -> Bob) racing
 *      against `leave_management_create_request` and `attendance_submit_explanation`.
 *   2. `org_department_transfer_person_member_admin` (MARKETING -> OPERATIONS) racing
 *      against `leave_management_create_request` and `attendance_submit_explanation`.
 *   3. Concurrent `leave_management_decide_request` & `attendance_decide_explanation`
 *      racing against `direct_entry_authz_revoke_global_role_admin` (non-Owner ADMIN)
 *      plus idempotency replay before OCC.
 *   4. Concurrent reverse-ordered `leave_management_preview_opening_batch` ([A, B] vs [B, A])
 *      and concurrent initial `leave_management_set_department_approver_admin` for IT.
 *   5. Same-day Team Leader revoke/replace (`direct_entry_designate_team_leader`) preserves
 *      frozen pending Leave & Explanation snapshots while routing new ones to the replacement TL.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "17700000-0000-4000-8000-000000000001",
  app: "27700000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "17700000-0000-4000-8000-000000000002",
  app: "27700000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "17700000-0000-4000-8000-000000000003",
  app: "27700000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "17700000-0000-4000-8000-000000000004",
  app: "27700000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HEAD_ALICE = {
  auth: "17700000-0000-4000-8000-000000000011",
  app: "27700000-0000-4000-8000-000000000011",
  email: "race.alice@hrpartner.vn",
  name: "Head Alice",
};
const HEAD_BOB = {
  auth: "17700000-0000-4000-8000-000000000012",
  app: "27700000-0000-4000-8000-000000000012",
  email: "race.bob@hrpartner.vn",
  name: "Head Bob",
};
const HEAD_CHARLIE = {
  auth: "17700000-0000-4000-8000-000000000013",
  app: "27700000-0000-4000-8000-000000000013",
  email: "race.charlie@hrpartner.vn",
  name: "Head Charlie",
};
const EMP_MKT_A = {
  auth: "17700000-0000-4000-8000-000000000014",
  app: "27700000-0000-4000-8000-000000000014",
  email: "race.emp.a@hrpartner.vn",
  name: "Emp MKT A",
};
const EMP_MKT_B = {
  auth: "17700000-0000-4000-8000-000000000015",
  app: "27700000-0000-4000-8000-000000000015",
  email: "race.emp.b@hrpartner.vn",
  name: "Emp MKT B",
};
const TL_1 = {
  auth: "17700000-0000-4000-8000-000000000016",
  app: "27700000-0000-4000-8000-000000000016",
  recruiter: "37700000-0000-4000-8000-000000000016",
  email: "race.tl1@hrpartner.vn",
  name: "Race TL 1",
};
const TL_2 = {
  auth: "17700000-0000-4000-8000-000000000017",
  app: "27700000-0000-4000-8000-000000000017",
  recruiter: "37700000-0000-4000-8000-000000000017",
  email: "race.tl2@hrpartner.vn",
  name: "Race TL 2",
};
const REC_EMP = {
  auth: "17700000-0000-4000-8000-000000000018",
  app: "27700000-0000-4000-8000-000000000018",
  recruiter: "37700000-0000-4000-8000-000000000018",
  email: "race.rec@hrpartner.vn",
  name: "Race Recruiter",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  HEAD_ALICE,
  HEAD_BOB,
  HEAD_CHARLIE,
  EMP_MKT_A,
  EMP_MKT_B,
  TL_1,
  TL_2,
  REC_EMP,
];

const TEAM_RACE = "47700000-0000-4000-8000-000000000001";

let seq = 1;
function nextUuid() {
  return `99700000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val)).digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "wp7a-race") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function asSettled(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

test("WP7A real PostgreSQL concurrency: org HEAD/transfer vs Leave/Explanations, admin revoke race, opening preview lock order, and TL handover", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries not available in PATH");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "wp7a-pg-race-"));
  const pgData = path.join(tmpRoot, "pgdata");
  const pgLog = path.join(tmpRoot, "pg.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
    run(pgCtl, [
      "-D",
      pgData,
      "-l",
      pgLog,
      "-o",
      `-h 127.0.0.1 -p ${port} -k "" -c deadlock_timeout=100ms`,
      "start",
    ], { ignoreOutput: true });
    started = true;

    const setup = await connect(port, "postgres", "wp7a-setup");
    const w1 = await connect(port, "postgres", "wp7a-w1");
    const w2 = await connect(port, "postgres", "wp7a-w2");
    const w3 = await connect(port, "postgres", "wp7a-w3");
    const observer = await connect(port, "postgres", "wp7a-obs");
    clients.push(setup, w1, w2, w3, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(names.includes("20261119120000_wp7a_leave_explanations_org_authz.sql"));
    for (const name of names) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    for (const u of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await setup.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1::uuid, $2::uuid, true, $3)",
        [u.app, u.auth, u.name],
      );
    }

    for (const adm of [OWNER, LIENVU, NGATTT]) {
      for (const cap of [
        "entry_admin",
        "entry_team",
        "entry_own",
        "entry_create",
        "submission_create",
        "entry_privileged_edit",
        "entry_restore",
        "recruiter_master_manage",
        "team_master_manage",
        "audit_view",
        "worker_edit_history_view",
        "document_upload",
        "document_view",
        "employment_status.review",
        "employment_status.apply",
        "change_request_create",
        "change_review",
        "employment_status.request",
        "duplicate_cccd_withdraw",
      ]) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [adm.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
        [adm.app],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [LUANPT.app],
    );

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    await setup.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'RACE_T1', 'Team Race 1', true)",
      [TEAM_RACE],
    );
    for (const [u, code, pos] of [
      [TL_1, "NV-RTL1", "TEAM_LEADER"],
      [TL_2, "NV-RTL2", "STAFF"],
      [REC_EMP, "NV-REMP", "STAFF"],
    ]) {
      await setup.query(
        "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, $4, true)",
        [u.recruiter, u.name, code, pos],
      );
      await setup.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
        [u.recruiter],
      );
      await setup.query(
        "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
        [u.app, u.recruiter],
      );
      await setup.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
        [u.recruiter, TEAM_RACE],
      );
    }
    // Org departments + Persons + MARKETING HEAD = Alice + OPERATIONS HEAD = Charlie
    const { rows: [mktDept] } = await setup.query(
      "select department_id, version from public.organization_departments where system_key = 'MARKETING'",
    );
    await setup.query("set role service_role");
    await setup.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'Setup Race TL 1', $5) as data",
      [OWNER.auth, OWNER.app, TEAM_RACE, TL_1.app, `tl-init-${seq++}`],
    );
    const opsCreated = (
      await setup.query(
        "select public.org_department_create_department_admin($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7) as data",
        [OWNER.auth, OWNER.app, "OPS_RACE", "Phòng Vận hành Race", "Setup ops dept", nextUuid(), sha256("ops-race")],
      )
    ).rows[0].data;
    const opsDeptId = opsCreated.department.department_id;

    async function makePerson(u, code, fullName, deptId) {
      await setup.query("reset role");
      const { rows: [acc] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [u.app],
      );
      await setup.query("set role service_role");
      const res = (
        await setup.query(
          "select public.org_department_create_person_admin($1::uuid, $2::uuid, $3, $4, '2025-01-01'::date, $5::uuid, $6::uuid, $7::int, null::uuid, $8, $9::uuid, $10) as data",
          [OWNER.auth, OWNER.app, code, fullName, deptId, u.app, acc.version, `Create ${code}`, nextUuid(), sha256(code)],
        )
      ).rows[0].data;
      return res.person;
    }

    const pAlice = await makePerson(HEAD_ALICE, "RC-ALICE", "Trưởng Phòng Alice", mktDept.department_id);
    const pBob = await makePerson(HEAD_BOB, "RC-BOB", "Trưởng Phòng Bob", mktDept.department_id);
    const pCharlie = await makePerson(HEAD_CHARLIE, "RC-CHARLIE", "Trưởng Phòng Charlie", opsDeptId);
    const pEmpA = await makePerson(EMP_MKT_A, "RC-EMPA", "Nhân Viên MKT A", mktDept.department_id);
    await makePerson(EMP_MKT_B, "RC-EMPB", "Nhân Viên MKT B", mktDept.department_id);

    const headARes = (
      await setup.query(
        "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, null::uuid, $6, $7::uuid, $8) as data",
        [OWNER.auth, OWNER.app, mktDept.department_id, pAlice.person_id, mktDept.version, "Initial MKT head", nextUuid(), sha256("init-alice")],
      )
    ).rows[0].data;
    await setup.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, null::uuid, $6, $7::uuid, $8) as data",
      [OWNER.auth, OWNER.app, opsDeptId, pCharlie.person_id, opsCreated.department.version, "Initial OPS head", nextUuid(), sha256("init-charlie")],
    );

    // OFFICIAL profiles for EMP_MKT_A, EMP_MKT_B, REC_EMP
    for (const [u, unit] of [
      [EMP_MKT_A, "MARKETING"],
      [EMP_MKT_B, "MARKETING"],
      [REC_EMP, "RECRUITMENT"],
    ]) {
      await setup.query(
        "select public.leave_management_upsert_employee_profile_admin($1::uuid, $2::uuid, $3::uuid, false, 'OFFICIAL', $4, '2025-01-01'::date, '2025-03-01'::date, null::date, 0, 0, 'setup', $5, $6)",
        [OWNER.auth, OWNER.app, u.app, unit, `prof-${u.app}`, sha256(`prof-${u.app}`)],
      );
    }
    await setup.query("reset role");

    const { rows: [{ y1, y2, y3, d1, d2, d3, d4 }] } = await observer.query(
      `select ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1)::text as y1,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 2)::text as y2,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 3)::text as y3,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 2)::text as d1,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 3)::text as d2,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 4)::text as d3,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 5)::text as d4`,
    );

    for (const c of [w1, w2, w3]) {
      await c.query("set role service_role");
    }

    // -------------------------------------------------------------------------
    // Race 1: org_department_designate_head_admin (Alice -> Bob) vs
    //         leave_management_create_request + attendance_submit_explanation
    // -------------------------------------------------------------------------
    const [r1Head, r1Leave, r1Exp] = await Promise.all([
      asSettled(
        w1.query(
          "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data",
          [
            OWNER.auth,
            OWNER.app,
            mktDept.department_id,
            pBob.person_id,
            headARes.department_version,
            headARes.active_head.head_assignment_id,
            "Race replace MKT head Alice -> Bob",
            nextUuid(),
            sha256("race-head-bob"),
          ],
        ),
      ),
      asSettled(
        w2.query(
          "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6) as data",
          [
            EMP_MKT_A.auth,
            EMP_MKT_A.app,
            JSON.stringify([{ leave_date: d1, session_code: "AM", leave_type: "UNPAID" }]),
            "Leave concurrent with HEAD swap",
            `race1-l-${seq++}`,
            sha256("race1-l"),
          ],
        ),
      ),
      asSettled(
        w3.query(
          "select public.attendance_submit_explanation($1::uuid, $2::uuid, $3::date, 'SLOT_1', $4, $5, $6) as data",
          [
            EMP_MKT_A.auth,
            EMP_MKT_A.app,
            y1,
            "Explanation concurrent with HEAD swap",
            nextUuid(),
            sha256("race1-e"),
          ],
        ),
      ),
    ]);

    for (const [label, res] of [["R1 head", r1Head], ["R1 leave", r1Leave], ["R1 exp", r1Exp]]) {
      assert.notEqual(res.reason?.code, "40P01", `${label} must never deadlock`);
      assert.equal(res.status, "fulfilled", `${label} failed: ${res.reason?.message}`);
    }
    const r1LeaveApprover = r1Leave.value.rows[0].data.request.primary_approver_app_user_id;
    const r1ExpApprover = r1Exp.value.rows[0].data.explanation.primary_approver?.app_user_id;
    assert.ok([HEAD_ALICE.app, HEAD_BOB.app].includes(r1LeaveApprover), "Leave approver must be valid Alice or Bob");
    assert.ok([HEAD_ALICE.app, HEAD_BOB.app].includes(r1ExpApprover), "Explanation approver must be valid Alice or Bob");

    // -------------------------------------------------------------------------
    // Race 2: org_department_transfer_person_member_admin (MARKETING -> OPS_RACE)
    //         vs leave_management_create_request + attendance_submit_explanation
    // -------------------------------------------------------------------------
    const { rows: [mEmpA] } = await observer.query(
      `select m.membership_id, p.version as person_version
         from public.organization_person_department_memberships m
         join public.organization_persons p on p.person_id = m.person_id
        where m.person_id = $1::uuid and m.ended_at is null`,
      [pEmpA.person_id],
    );
    const [r2Transfer, r2Leave, r2Exp] = await Promise.all([
      asSettled(
        w1.query(
          "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data",
          [
            OWNER.auth,
            OWNER.app,
            pEmpA.person_id,
            opsDeptId,
            mEmpA.person_version,
            mEmpA.membership_id,
            "Race transfer EMP_MKT_A -> OPS_RACE",
            nextUuid(),
            sha256("race-transfer-ops"),
          ],
        ),
      ),
      asSettled(
        w2.query(
          "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6) as data",
          [
            EMP_MKT_A.auth,
            EMP_MKT_A.app,
            JSON.stringify([{ leave_date: d2, session_code: "AM", leave_type: "UNPAID" }]),
            "Leave concurrent with dept transfer",
            `race2-l-${seq++}`,
            sha256("race2-l"),
          ],
        ),
      ),
      asSettled(
        w3.query(
          "select public.attendance_submit_explanation($1::uuid, $2::uuid, $3::date, 'SLOT_1', $4, $5, $6) as data",
          [
            EMP_MKT_A.auth,
            EMP_MKT_A.app,
            y2,
            "Explanation concurrent with dept transfer",
            nextUuid(),
            sha256("race2-e"),
          ],
        ),
      ),
    ]);

    for (const [label, res] of [["R2 transfer", r2Transfer], ["R2 leave", r2Leave], ["R2 exp", r2Exp]]) {
      assert.notEqual(res.reason?.code, "40P01", `${label} must never deadlock`);
      assert.equal(res.status, "fulfilled", `${label} failed: ${res.reason?.message}`);
    }
    assert.ok([HEAD_BOB.app, HEAD_CHARLIE.app].includes(r2Leave.value.rows[0].data.request.primary_approver_app_user_id));
    assert.ok([HEAD_BOB.app, HEAD_CHARLIE.app].includes(r2Exp.value.rows[0].data.explanation.primary_approver?.app_user_id));

    // -------------------------------------------------------------------------
    // Race 3: Concurrent decide_request (LUANPT ADMIN vs HEAD_CHARLIE) +
    //         direct_entry_authz_revoke_global_role_admin revoking LUANPT ADMIN
    // -------------------------------------------------------------------------
    const leave3Res = (
      await w2.query(
        "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6) as data",
        [
          EMP_MKT_A.auth,
          EMP_MKT_A.app,
          JSON.stringify([{ leave_date: d3, session_code: "AM", leave_type: "UNPAID" }]),
          "Leave 3 for decide vs revoke ADMIN race",
          `race3-l-${seq++}`,
          sha256("race3-l"),
        ],
      )
    ).rows[0].data;
    assert.equal(leave3Res.request.primary_approver_app_user_id, HEAD_CHARLIE.app);
    const { rows: [luanRow] } = await observer.query(
      `select u.version, a.assignment_id
         from public.direct_entry_app_users u
         join public.authz_account_role_assignments a
           on a.app_user_id = u.app_user_id and a.role_code = 'ADMIN' and a.ended_at is null
        where u.app_user_id = $1::uuid`,
      [LUANPT.app],
    );

    const charlieDecideKey = `race3-charlie-dec-${seq++}`;
    const charlieDecideFp = sha256("race3-charlie-dec");
    const [r3RevokeLuan, r3LuanDecide, r3CharlieDecide] = await Promise.all([
      asSettled(
        w1.query(
          "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data",
          [OWNER.auth, OWNER.app, LUANPT.app, luanRow.assignment_id, luanRow.version, "Revoke LUANPT during race", nextUuid(), sha256("rev-luan-r3")],
        ),
      ),
      asSettled(
        w2.query(
          "select public.leave_management_decide_request($1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'Luan decide', $4, $5) as data",
          [LUANPT.auth, LUANPT.app, leave3Res.request.request_id, `race3-luan-dec-${seq++}`, sha256("race3-luan-dec")],
        ),
      ),
      asSettled(
        w3.query(
          "select public.leave_management_decide_request($1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'Charlie decide', $4, $5) as data",
          [HEAD_CHARLIE.auth, HEAD_CHARLIE.app, leave3Res.request.request_id, charlieDecideKey, charlieDecideFp],
        ),
      ),
    ]);

    assert.notEqual(r3RevokeLuan.reason?.code, "40P01");
    assert.equal(r3RevokeLuan.status, "fulfilled");
    assert.notEqual(r3LuanDecide.reason?.code, "40P01");
    assert.notEqual(r3CharlieDecide.reason?.code, "40P01");
    const decideWinners = [r3LuanDecide, r3CharlieDecide].filter((r) => r.status === "fulfilled");
    assert.equal(decideWinners.length, 1, "Exactly one approver must win leave_management_decide_request");

    // -------------------------------------------------------------------------
    // Race 4: Reverse-ordered leave_management_preview_opening_batch ([A, B] vs [B, A])
    //         and concurrent initial leave_management_set_department_approver_admin('IT')
    // -------------------------------------------------------------------------
    const yearNow = Number(d1.slice(0, 4));
    const [r4Prev1, r4Prev2] = await Promise.all([
      asSettled(
        w1.query(
          "select public.leave_management_preview_opening_batch($1::uuid, $2::uuid, $3::int, $4::jsonb) as data",
          [
            OWNER.auth,
            OWNER.app,
            yearNow,
            JSON.stringify([
              { app_user_id: EMP_MKT_A.app, carry_over_units: 0, opening_current_year_units: 10, seniority_units: 0 },
              { app_user_id: EMP_MKT_B.app, carry_over_units: 0, opening_current_year_units: 10, seniority_units: 0 },
            ]),
          ],
        ),
      ),
      asSettled(
        w2.query(
          "select public.leave_management_preview_opening_batch($1::uuid, $2::uuid, $3::int, $4::jsonb) as data",
          [
            LIENVU.auth,
            LIENVU.app,
            yearNow,
            JSON.stringify([
              { app_user_id: EMP_MKT_B.app, carry_over_units: 0, opening_current_year_units: 10, seniority_units: 0 },
              { app_user_id: EMP_MKT_A.app, carry_over_units: 0, opening_current_year_units: 10, seniority_units: 0 },
            ]),
          ],
        ),
      ),
    ]);
    assert.notEqual(r4Prev1.reason?.code, "40P01", "Reverse-ordered preview_opening_batch must never deadlock");
    assert.notEqual(r4Prev2.reason?.code, "40P01", "Reverse-ordered preview_opening_batch must never deadlock");
    assert.equal(r4Prev1.status, "fulfilled");
    assert.equal(r4Prev2.status, "fulfilled");

    const [r4Dept1, r4Dept2] = await Promise.all([
      asSettled(
        w1.query(
          "select public.leave_management_set_department_approver_admin($1::uuid, $2::uuid, 'IT', $3::uuid, null::date, 0, 'Init IT 1', $4, $5) as data",
          [OWNER.auth, OWNER.app, HEAD_ALICE.app, `it-init-1-${seq++}`, sha256("it-init-1")],
        ),
      ),
      asSettled(
        w2.query(
          "select public.leave_management_set_department_approver_admin($1::uuid, $2::uuid, 'IT', $3::uuid, null::date, 0, 'Init IT 2', $4, $5) as data",
          [LIENVU.auth, LIENVU.app, HEAD_BOB.app, `it-init-2-${seq++}`, sha256("it-init-2")],
        ),
      ),
    ]);
    const deptWins = [r4Dept1, r4Dept2].filter((r) => r.status === "fulfilled");
    const deptLosses = [r4Dept1, r4Dept2].filter((r) => r.status === "rejected");
    assert.equal(deptWins.length, 1, "Initial set_department_approver_admin race must have 1 winner");
    assert.equal(deptLosses.length, 1);
    assert.notEqual(deptLosses[0].reason?.code, "40P01");
    assert.equal(deptLosses[0].reason?.code, "PT409", "Losing initial set_department_approver_admin must return PT409 OCC, not 23505");

    // -------------------------------------------------------------------------
    // Race 5: Same-day TL handover (TL_1 -> TL_2) preserves frozen Leave & Explanation
    //         snapshot while routing new requests immediately to TL_2
    // -------------------------------------------------------------------------
    const recLeave1 = (
      await w1.query(
        "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6) as data",
        [
          REC_EMP.auth,
          REC_EMP.app,
          JSON.stringify([{ leave_date: d3, session_code: "AM", leave_type: "UNPAID" }]),
          "Recruiter leave before TL handover",
          `r5-l1-${seq++}`,
          sha256("r5-l1"),
        ],
      )
    ).rows[0].data;
    assert.equal(recLeave1.request.primary_approver_app_user_id, TL_1.app);

    const recExp1 = (
      await w1.query(
        "select public.attendance_submit_explanation($1::uuid, $2::uuid, $3::date, 'SLOT_1', $4, $5, $6) as data",
        [REC_EMP.auth, REC_EMP.app, y3, "Recruiter explanation before TL handover", nextUuid(), sha256("r5-e1")],
      )
    ).rows[0].data;
    assert.equal(recExp1.explanation.primary_approver.app_user_id, TL_1.app);

    const { rows: [teamRow] } = await observer.query(
      "select version from public.teams where team_id = $1::uuid",
      [TEAM_RACE],
    );
    await w1.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, $5::int, $6, $7) as data",
      [OWNER.auth, OWNER.app, TEAM_RACE, TL_2.app, teamRow.version, "Replace TL1 -> TL2 same day", `tl-swap-${seq++}`],
    );

    // TL_2 MUST NOT decide frozen pending recLeave1 / recExp1
    await assert.rejects(
      () =>
        w2.query(
          "select public.leave_management_decide_request($1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'TL2 steal', $4, $5) as data",
          [TL_2.auth, TL_2.app, recLeave1.request.request_id, `r5-steal-l1-${seq++}`, sha256("r5-steal-l1")],
        ),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      () =>
        w2.query(
          "select public.attendance_decide_explanation($1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'TL2 steal exp', $4, $5) as data",
          [TL_2.auth, TL_2.app, recExp1.explanation.explanation_id, nextUuid(), sha256("r5-steal-e1")],
        ),
      (err) => err.code === "42501",
    );

    // New Leave routes immediately to TL_2, and TL_2 approves cleanly
    const recLeave2 = (
      await w1.query(
        "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6) as data",
        [
          REC_EMP.auth,
          REC_EMP.app,
          JSON.stringify([{ leave_date: d4, session_code: "AM", leave_type: "UNPAID" }]),
          "Recruiter leave after TL handover",
          `r5-l2-${seq++}`,
          sha256("r5-l2"),
        ],
      )
    ).rows[0].data;
    assert.equal(recLeave2.request.primary_approver_app_user_id, TL_2.app);

    const tl2Approved = (
      await w2.query(
        "select public.leave_management_decide_request($1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'TL2 approve new', $4, $5) as data",
        [TL_2.auth, TL_2.app, recLeave2.request.request_id, `r5-tl2-ok-${seq++}`, sha256("r5-tl2-ok")],
      )
    ).rows[0].data;
    assert.equal(tl2Approved.request.status, "APPROVED");

    for (const c of [w1, w2, w3]) {
      await c.query("reset role");
    }
  } finally {
    await Promise.allSettled(clients.map((c) => c.end()));
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
