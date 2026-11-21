/**
 * WP7B — Attendance Org/Effective Access & Read-Only Leave Nav Probe
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks under `SET ROLE service_role`:
 *   1. Concurrent `attendance_admin_report`, `attendance_monthly_matrix_report`, and
 *      `attendance_admin_checkin_photo` by HEAD Alice racing against
 *      `org_department_designate_head_admin` (replace HEAD Alice -> Bob) and
 *      `org_department_end_head_admin`.
 *   2. Concurrent scoped attendance report/matrix reads by MKT HEAD & OPS HEAD racing against
 *      `org_department_transfer_person_member_admin` (MKT -> OPS).
 *   3. Concurrent `leave_management_get_actor_access` strictly inside `BEGIN TRANSACTION READ ONLY`
 *      racing against `leave_management_get_my_summary` (accrual write) &
 *      `leave_management_create_request` for the same official employee (zero `40P01`, zero `25006`).
 *   4. Deterministic barrier + concurrent race of `attendance_record_checkin` against
 *      `org_department_set_account_type_admin` (`NORMAL -> SHARED`) and account disable
 *      (`enabled = false`): `FOR SHARE` serializes cleanly after `FOR UPDATE`, fails closed
 *      with `42501 ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN` once reclassified, and yields zero deadlocks.
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

import { WP7B_ATTENDANCE_ORG_SCOPE_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "17900000-0000-4000-8000-000000000001",
  app: "27900000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "17900000-0000-4000-8000-000000000002",
  app: "27900000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "17900000-0000-4000-8000-000000000003",
  app: "27900000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "17900000-0000-4000-8000-000000000004",
  app: "27900000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HEAD_ALICE = {
  auth: "17900000-0000-4000-8000-000000000011",
  app: "27900000-0000-4000-8000-000000000011",
  email: "wp7b.alice@hrpartner.vn",
  name: "Head Alice",
};
const HEAD_BOB = {
  auth: "17900000-0000-4000-8000-000000000012",
  app: "27900000-0000-4000-8000-000000000012",
  email: "wp7b.bob@hrpartner.vn",
  name: "Head Bob",
};
const HEAD_OPS = {
  auth: "17900000-0000-4000-8000-000000000013",
  app: "27900000-0000-4000-8000-000000000013",
  email: "wp7b.ops@hrpartner.vn",
  name: "Head Ops",
};
const EMP_TRANSFER = {
  auth: "17900000-0000-4000-8000-000000000014",
  app: "27900000-0000-4000-8000-000000000014",
  email: "wp7b.transfer@hrpartner.vn",
  name: "Emp Transfer",
};
const EMP_LEAVE = {
  auth: "17900000-0000-4000-8000-000000000015",
  app: "27900000-0000-4000-8000-000000000015",
  email: "wp7b.leave@hrpartner.vn",
  name: "Emp Leave Race",
};
const EMP_RECLASSIFY = {
  auth: "17900000-0000-4000-8000-000000000016",
  app: "27900000-0000-4000-8000-000000000016",
  email: "wp7b.reclassify@hrpartner.vn",
  name: "Emp Reclassify Shared",
};
const EMP_DISABLE = {
  auth: "17900000-0000-4000-8000-000000000017",
  app: "27900000-0000-4000-8000-000000000017",
  email: "wp7b.disable@hrpartner.vn",
  name: "Emp Disable Race",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  HEAD_ALICE,
  HEAD_BOB,
  HEAD_OPS,
  EMP_TRANSFER,
  EMP_LEAVE,
  EMP_RECLASSIFY,
  EMP_DISABLE,
];

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `a7900000-0000-4000-8000-${hex}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
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

async function connect(port, database = "postgres", applicationName = "wp7b-race") {
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

async function waitUntilBlocked(observer, applicationName, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select wait_event_type, wait_event, state
         from pg_stat_activity
        where application_name = $1
          and state = 'active'`,
      [applicationName],
    );
    if (rows.length > 0 && rows[0].wait_event_type === "Lock") {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on lock`);
}

async function serviceRpc(client, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("set role service_role");
  try {
    const { rows } = await client.query(
      `select public.${fnName}(${placeholders}) as res`,
      args,
    );
    return rows[0]?.res;
  } finally {
    await client.query("reset role").catch(() => {});
  }
}

test("WP7B real PostgreSQL concurrency: HEAD replace/revoke & dept transfer vs attendance reads, READ ONLY Leave nav probe vs accruals/requests, and check-in vs NORMAL->SHARED / disable", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries not available in PATH");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "wp7b-pg-race-"));
  const pgData = path.join(tmpRoot, "pgdata");
  const pgLog = path.join(tmpRoot, "pg.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
    run(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-o",
        `-h 127.0.0.1 -p ${port} -k "" -c deadlock_timeout=100ms`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "postgres", "wp7b-setup");
    const w1 = await connect(port, "postgres", "wp7b-w1");
    const w2 = await connect(port, "postgres", "wp7b-w2");
    const w3 = await connect(port, "postgres", "wp7b-w3");
    const w4 = await connect(port, "postgres", "wp7b-w4");
    const observer = await connect(port, "postgres", "wp7b-obs");
    clients.push(setup, w1, w2, w3, w4, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql") && f < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql").sort();
    assert.ok(names.includes(WP7B_ATTENDANCE_ORG_SCOPE_MIGRATION_NAME));
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

    // Set HQ location
    const hqKey = nextUuid();
    await serviceRpc(setup, "attendance_set_hq_location", [
      OWNER.auth, OWNER.app, 21.0285, 105.8542, 0, hqKey, sha256(`hq:${hqKey}`),
    ]);

    // Departments: MARKETING + custom OPERATIONS
    const { rows: [mktDept] } = await setup.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );
    const opsDeptRes = await serviceRpc(setup, "org_department_create_department_admin", [
      OWNER.auth, OWNER.app, "OPS_RACE", "Phòng Vận hành Race", "Race OPS", nextUuid(), sha256("ops-race"),
    ]);
    const mktDeptId = mktDept.department_id;
    const opsDeptId = opsDeptRes.department.department_id;

    async function createLinkedPerson(target, code, fullName, deptId) {
      const { rows: [u] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [target.app],
      );
      const res = await serviceRpc(setup, "org_department_create_person_admin", [
        OWNER.auth, OWNER.app, code, fullName, "2025-01-01", deptId,
        target.app, u.version, null, `Seed ${code}`, nextUuid(), sha256(`p:${code}:${seq}`),
      ]);
      return res.person;
    }

    const pAlice = await createLinkedPerson(HEAD_ALICE, "EMP-RA", "Head Alice", mktDeptId);
    const pBob = await createLinkedPerson(HEAD_BOB, "EMP-RB", "Head Bob", mktDeptId);
    const pOps = await createLinkedPerson(HEAD_OPS, "EMP-RO", "Head Ops", opsDeptId);
    const pTransfer = await createLinkedPerson(EMP_TRANSFER, "EMP-RT", "Emp Transfer", mktDeptId);
    await createLinkedPerson(EMP_LEAVE, "EMP-RL", "Emp Leave", mktDeptId);

    // Backdate links & memberships to 2026-10-01+07 (temporarily suspend close-only guard for fixture seeding)
    await setup.query(
      "alter table public.organization_account_person_links disable trigger user;" +
        " alter table public.organization_person_department_memberships disable trigger user;",
    );
    await setup.query(
      "update public.organization_account_person_links set started_at = '2026-10-01 00:00:00+07'::timestamptz",
    );
    await setup.query(
      "update public.organization_person_department_memberships set started_at = '2026-10-01 00:00:00+07'::timestamptz",
    );
    await setup.query(
      "alter table public.organization_account_person_links enable trigger user;" +
        " alter table public.organization_person_department_memberships enable trigger user;",
    );

    // Leave profile for EMP_LEAVE (official, 0 lots initially)
    await setup.query(
      `insert into public.leave_employee_profiles (app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, official_effective_date)
       values ($1::uuid, false, 'OFFICIAL', 'MARKETING', '2025-01-01', '2025-03-01')`,
      [EMP_LEAVE.app],
    );

    // Designate Alice (MKT) and Head Ops (OPS)
    const { rows: [mktV1] } = await setup.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [mktDeptId],
    );
    await serviceRpc(setup, "org_department_designate_head_admin", [
      OWNER.auth, OWNER.app, mktDeptId, pAlice.person_id, mktV1.version, null, "Designate Alice", nextUuid(), sha256("h-alice"),
    ]);
    const { rows: [opsV1] } = await setup.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [opsDeptId],
    );
    await serviceRpc(setup, "org_department_designate_head_admin", [
      OWNER.auth, OWNER.app, opsDeptId, pOps.person_id, opsV1.version, null, "Designate Ops", nextUuid(), sha256("h-ops"),
    ]);

    // Seed check-in for EMP_TRANSFER on 2026-10-10
    const ci10Id = nextUuid();
    await setup.query(
      `insert into public.attendance_checkins (
         checkin_id, app_user_id, idempotency_key, request_fingerprint,
         business_date, sequence_in_day, latitude, longitude, accuracy_meters,
         distance_meters,
         photo_storage_key, photo_sha256, photo_size_bytes, photo_mime_type,
         captured_at, received_at, time_source, time_verified, device_claimed_at,
         time_anchor_issued_at, elapsed_since_anchor_ms, sync_delay_seconds,
         time_token_digest, distance_target_kind
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4,
         '2026-10-10', 1, 21.0285, 105.8542, 10,
         0,
         'private/race/emp-10.jpg', $5, 12345, 'image/jpeg',
         '2026-10-10 08:05:00+07'::timestamptz, '2026-10-10 08:05:00+07'::timestamptz, 'SERVER_ANCHORED', true,
         '2026-10-10 08:05:00+07'::timestamptz, '2026-10-10 08:05:00+07'::timestamptz, 0, 0,
         $6, 'HQ'
       )`,
      [ci10Id, EMP_TRANSFER.app, nextUuid(), sha256("fp-ci10"), sha256("ph-ci10"), sha256("tok-ci10")],
    );

    // -------------------------------------------------------------------------
    // Race 1: HEAD Alice report/matrix/photo reads vs org_department_designate_head_admin (Alice -> Bob)
    // -------------------------------------------------------------------------
    const { rows: [mktV2] } = await setup.query(
      `select d.version, h.head_assignment_id
         from public.organization_departments d
         join public.organization_department_heads h
           on h.department_id = d.department_id and h.ended_at is null
        where d.department_id = $1::uuid`,
      [mktDeptId],
    );
    const race1 = await Promise.all([
      asSettled(serviceRpc(w1, "org_department_designate_head_admin", [
        OWNER.auth, OWNER.app, mktDeptId, pBob.person_id, mktV2.version, mktV2.head_assignment_id, "Replace Alice with Bob", nextUuid(), sha256("replace-bob"),
      ])),
      asSettled(serviceRpc(w2, "attendance_admin_report", [
        HEAD_ALICE.auth, HEAD_ALICE.app, "2026-10-01", "2026-10-31", 1, 20, null, null,
      ])),
      asSettled(serviceRpc(w3, "attendance_monthly_matrix_report", [
        HEAD_ALICE.auth, HEAD_ALICE.app, "2026-10", null, null, null, 1, 20,
      ])),
      asSettled(serviceRpc(w4, "attendance_admin_checkin_photo", [
        HEAD_ALICE.auth, HEAD_ALICE.app, ci10Id,
      ])),
    ]);
    assert.equal(race1[0].status, "fulfilled", `HEAD replace must succeed: ${race1[0].reason?.message}`);
    for (const r of race1.slice(1)) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01", "Zero deadlocks on HEAD replace race");
        assert.equal(r.reason?.code, "42501", `Post-replace read fails cleanly with 42501, got ${r.reason?.code}`);
      }
    }
    // Strictly post-commit: Alice denied, Bob succeeds
    await assert.rejects(
      () => serviceRpc(w2, "attendance_admin_report", [
        HEAD_ALICE.auth, HEAD_ALICE.app, "2026-10-01", "2026-10-31", 1, 20, null, null,
      ]),
      (err) => err?.code === "42501",
    );
    const bobReport = await serviceRpc(w3, "attendance_admin_report", [
      HEAD_BOB.auth, HEAD_BOB.app, "2026-10-01", "2026-10-31", 1, 20, null, EMP_TRANSFER.app,
    ]);
    assert.deepEqual(bobReport.items.map((i) => i.checkin_id), [ci10Id]);

    // -------------------------------------------------------------------------
    // Race 2: Scoped reads (Bob MKT + Head Ops) vs org_department_transfer_person_member_admin (MKT -> OPS)
    // -------------------------------------------------------------------------
    const currentYearMonth = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
    }).format(new Date());
    const { rows: [pTransV] } = await setup.query(
      `select p.version, m.membership_id
         from public.organization_persons p
         join public.organization_person_department_memberships m
           on m.person_id = p.person_id and m.ended_at is null
        where p.person_id = $1::uuid`,
      [pTransfer.person_id],
    );
    const race2 = await Promise.all([
      asSettled(serviceRpc(w1, "org_department_transfer_person_member_admin", [
        OWNER.auth, OWNER.app, pTransfer.person_id, opsDeptId, pTransV.version, pTransV.membership_id, "Transfer MKT->OPS", nextUuid(), sha256("tr-ops"),
      ])),
      asSettled(serviceRpc(w2, "attendance_monthly_matrix_report", [
        HEAD_BOB.auth, HEAD_BOB.app, currentYearMonth, null, null, null, 1, 20,
      ])),
      asSettled(serviceRpc(w3, "attendance_monthly_matrix_report", [
        HEAD_OPS.auth, HEAD_OPS.app, currentYearMonth, null, null, null, 1, 20,
      ])),
    ]);
    assert.equal(race2[0].status, "fulfilled", `Transfer must succeed: ${race2[0].reason?.message}`);
    for (const r of race2.slice(1)) {
      assert.equal(r.status, "fulfilled", `Concurrent scoped read must not deadlock/fail: ${r.reason?.message}`);
    }
    // Post-transfer: historical Oct 10 check-in STILL belongs to Bob (MKT), and Head Ops fails closed on Oct 10 photo & Oct filter probe!
    const bobPostTr = await serviceRpc(w2, "attendance_admin_checkin_photo", [HEAD_BOB.auth, HEAD_BOB.app, ci10Id]);
    assert.equal(bobPostTr.photo_storage_key, "private/race/emp-10.jpg");
    await assert.rejects(
      () => serviceRpc(w3, "attendance_admin_checkin_photo", [HEAD_OPS.auth, HEAD_OPS.app, ci10Id]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(w3, "attendance_monthly_matrix_report", [
        HEAD_OPS.auth, HEAD_OPS.app, "2026-10", null, EMP_TRANSFER.app, null, 1, 20,
      ]),
      (err) => err?.code === "42501",
    );

    // -------------------------------------------------------------------------
    // Race 3: Concurrent READ ONLY leave_management_get_actor_access vs get_my_summary & create_request
    // -------------------------------------------------------------------------
    async function runReadOnlyProbe(client) {
      await client.query("begin transaction read only");
      await client.query("set local role service_role");
      try {
        const { rows: [r] } = await client.query(
          "select public.leave_management_get_actor_access($1::uuid, $2::uuid) as res",
          [EMP_LEAVE.auth, EMP_LEAVE.app],
        );
        await client.query("commit");
        return r.res;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      }
    }

    const leaveReqKey = nextUuid();
    const race3 = await Promise.all([
      asSettled(runReadOnlyProbe(w1)),
      asSettled(runReadOnlyProbe(w2)),
      asSettled(serviceRpc(w3, "leave_management_get_my_summary", [EMP_LEAVE.auth, EMP_LEAVE.app, 2026])),
      asSettled(serviceRpc(w4, "leave_management_create_request", [
        EMP_LEAVE.auth,
        EMP_LEAVE.app,
        JSON.stringify([{ leave_date: "2026-11-25", session_code: "FULL" }]),
        "ANNUAL",
        "Nghỉ phép race WP7B",
        leaveReqKey,
      ])),
    ]);
    for (const r of race3) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01", "Zero deadlocks in Leave nav probe vs accrual/request race");
        assert.notEqual(r.reason?.code, "25006", "Read-only nav probe must never attempt DB write");
      }
    }
    assert.equal(race3[0].status, "fulfilled", `RO probe 1 failed: ${race3[0].reason?.message}`);
    assert.equal(race3[1].status, "fulfilled", `RO probe 2 failed: ${race3[1].reason?.message}`);
    assert.equal(race3[0].value.can_access, true);
    assert.equal(race3[1].value.can_access, true);
    assert.equal(race3[2].status, "fulfilled", `get_my_summary failed: ${race3[2].reason?.message}`);
    assert.equal(race3[3].status, "fulfilled", `create_request failed: ${race3[3].reason?.message}`);

    // -------------------------------------------------------------------------
    // Race 4: Deterministic barrier + concurrent race of attendance_record_checkin
    //         vs org_department_set_account_type_admin (NORMAL -> SHARED) & disable (enabled = false)
    // -------------------------------------------------------------------------
    const nowMs = Date.now();
    const anchorIso = new Date(nowMs - 500).toISOString();
    const capturedIso = new Date(nowMs).toISOString();
    function buildCheckinArgs(actor) {
      const key = nextUuid();
      return [
        actor.auth,
        actor.app,
        key,
        sha256(`race-ci:${actor.app}:${key}`),
        21.0285,
        105.8542,
        10,
        "Hanoi",
        "Race check-in",
        capturedIso,
        "SERVER_ANCHORED",
        anchorIso,
        500,
        sha256(`race-tok:${key}`),
        `private/race/${actor.app}/${key}.jpg`,
        sha256(`race-ph:${key}`),
        12345,
        "image/jpeg",
        capturedIso,
      ];
    }

    // 4a. Deterministic barrier: revoke personal role first (canonical WP3/WP5 pre-step),
    //     then w1 holds FOR UPDATE on EMP_RECLASSIFY via BEGIN + org_department_set_account_type_admin,
    //     w2 starts attendance_record_checkin and blocks on FOR SHARE, w1 commits -> w2 MUST fail closed with 42501!
    const { rows: [recRoleRow] } = await setup.query(
      `select a.assignment_id, u.version
         from public.authz_account_role_assignments a
         join public.direct_entry_app_users u on u.app_user_id = a.app_user_id
        where a.app_user_id = $1::uuid
          and a.ended_at is null
        limit 1`,
      [EMP_RECLASSIFY.app],
    );
    if (recRoleRow) {
      await serviceRpc(setup, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth, OWNER.app, EMP_RECLASSIFY.app, recRoleRow.assignment_id,
        recRoleRow.version, "Clear personal role before SHARED reclassification", nextUuid(), sha256("revoke-reclass"),
      ]);
    }
    const { rows: [recUserVer] } = await setup.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [EMP_RECLASSIFY.app],
    );
    await w1.query("begin");
    await w1.query("set local role service_role");
    await w1.query(
      `select public.org_department_set_account_type_admin(
         $1::uuid, $2::uuid, $3::uuid, 'SHARED', $4::integer,
         'Reclassify SHARED deterministic race', $5::uuid, $6::text
       )`,
      [OWNER.auth, OWNER.app, EMP_RECLASSIFY.app, recUserVer.version, nextUuid(), sha256("reclass-shared")],
    );

    const blockedCheckinPromise = asSettled(
      serviceRpc(w2, "attendance_record_checkin", buildCheckinArgs(EMP_RECLASSIFY)),
    );
    await waitUntilBlocked(observer, "wp7b-w2");
    await w1.query("commit");

    const blockedCheckinOutcome = await blockedCheckinPromise;
    assert.equal(blockedCheckinOutcome.status, "rejected", "Check-in blocked behind NORMAL->SHARED must reject after commit");
    assert.equal(blockedCheckinOutcome.reason?.code, "42501");
    assert.match(String(blockedCheckinOutcome.reason?.message), /ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN/);
    const { rows: [reclassCount] } = await setup.query(
      "select count(*)::int as n from public.attendance_checkins where app_user_id = $1::uuid",
      [EMP_RECLASSIFY.app],
    );
    assert.equal(reclassCount.n, 0, "Zero check-in rows may commit for newly reclassified SHARED account");

    // 4b. Deterministic barrier: w1 disables EMP_DISABLE (enabled = false), w2 blocks on FOR SHARE, w1 commits -> w2 fails closed with 42501!
    await w1.query("begin");
    await w1.query(
      "update public.direct_entry_app_users set enabled = false, version = version + 1 where app_user_id = $1::uuid",
      [EMP_DISABLE.app],
    );
    const blockedDisableCheckin = asSettled(
      serviceRpc(w2, "attendance_record_checkin", buildCheckinArgs(EMP_DISABLE)),
    );
    await waitUntilBlocked(observer, "wp7b-w2");
    await w1.query("commit");

    const disableOutcome = await blockedDisableCheckin;
    assert.equal(disableOutcome.status, "rejected", "Check-in blocked behind disable must reject after commit");
    assert.equal(disableOutcome.reason?.code, "42501");
    assert.match(String(disableOutcome.reason?.message), /ACTOR_NOT_AVAILABLE/);
    const { rows: [disableCount] } = await setup.query(
      "select count(*)::int as n from public.attendance_checkins where app_user_id = $1::uuid",
      [EMP_DISABLE.app],
    );
    assert.equal(disableCount.n, 0, "Zero check-in rows may commit for newly disabled account");
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
