/**
 * WP10-4 — Org Department Heads Cutover Real PG18 Before/After Acceptance Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated PostgreSQL 18 cluster.
 * Verifies Before (0..241 ending at `20261125150000`) vs After (`242` `20261125200000`) across BOTH
 * Leave (`leave_management_*`) AND Attendance Explanations (`attendance_*`):
 *   1. Database audit: 0 `public` functions in `pg_proc` contain `leave_department_approvers` in `prosrc`;
 *      `leave_department_approvers` table & historical rows remain intact.
 *   2. Cutover routing matrix:
 *      - MARKETING (Org Head `Nguyễn Kim Tú`): employees -> `DEPARTMENT_HEAD` (`routed_department_id = MKT`);
 *        Tú's own Leave & Explanations -> `ADMIN_BOD_DIRECT` + self-approval block.
 *      - IT & ACCOUNTING with pre-cutover active `leave_department_approvers`: after `242` without Org Head ->
 *        `ADMIN_BOD_FALLBACK` (`DEPARTMENT_APPROVER_NOT_CONFIGURED`), legacy approver `is_department_approver = false`
 *        (retaining `can_approve_requests = true` ONLY while holding open `PENDING` snapshot). Designating Org Head
 *        immediately switches new Leave & Explanations to `DEPARTMENT_HEAD`.
 *      - Preserved contracts: Recruitment member -> `TEAM_LEADER`, Recruitment TL -> `ADMIN_BOD_DIRECT`,
 *        #32 cross-dept Marketing TL -> Marketing Org Head, Custom `OPERATIONS` -> Org Head.
 *   3. Full lifecycle + security + Head swap (`Nguyễn Kim Tú` -> `Nguyễn Kim Tú 2`) + Disabled Head (`u.enabled = false`)
 *      + Out-of-route actor (`42501` forbidden on inbox / decide / cancel).
 *   4. Dedicated `APPROVED` cancellation verification (`routed_department_id` present AND `routed_department_id IS NULL`)
 *      plus fail-closed checks after Head replaced, ended, or disabled (even with legacy `leave_department_approvers` row).
 *   5. Admin overview (`department_approvers` + `department_*`), retired `leave_management_set_department_approver_admin`
 *      (`42501` non-admin / `PT409 LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN` Admin/BoD, 0 writes),
 *      and `direct_entry_authz_get_account_groups_admin` (`DEPARTMENT_HEAD` for active Org Heads only, never `LEAVE_DEPARTMENT_APPROVER`).
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

import {
  projectAttendanceExplanationApprovalInbox,
  projectAttendanceMyExplanationsOverview,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
  computeEndHeadFingerprint,
} from "../src/lib/departments/department-contract.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_3_MIGRATION_NAME = "20261125150000_wp10_3_leave_org_department_cutover.sql";
const WP10_4_MIGRATION_NAME = "20261125200000_wp10_4_org_department_heads_cutover.sql";

const OWNER = {
  auth: "50100000-0000-4000-8000-00000000a001",
  app: "50100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-4",
};
const LUANPT = {
  auth: "50100000-0000-4000-8000-00000000a002",
  app: "50100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "50100000-0000-4000-8000-00000000a003",
  app: "50100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "50100000-0000-4000-8000-00000000a004",
  app: "50100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `50110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}

function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
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
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceQuery(client, sql, params = []) {
  await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'; set local role service_role");
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpc(client, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
}

async function setBusinessDate(setup, isoDate) {
  await setup.query(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${isoDate}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);
}

async function seedLegacyAdmin(client, user) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed)
     values ($1::uuid, $2::uuid, $3, true, false)`,
    [user.app, user.auth, user.name],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedPlainAccount(client, loginPrefix, displayName) {
  const authId = nextUuid();
  const appId = nextUuid();
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    authId,
    `${loginPrefix}@hrpartner.local`,
  ]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [appId, authId, displayName],
  );
  return { auth: authId, app: appId, login: loginPrefix, name: displayName };
}

test("WP10-4 Org Department Heads Cutover (PG18): Before vs After, Routing Matrix, Lifecycle, Approved Cancel & Retirement", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-4-dept-heads-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], { ignoreOutput: true });
    run(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "wp10-4-setup");
    const observer = await connect(port, "wp10-4-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const wp103Idx = files.indexOf(WP10_3_MIGRATION_NAME);
    const wp104Idx = files.indexOf(WP10_4_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(wp103Idx > groupsIdx, "WP10-3 migration must exist");
    assert.equal(wp104Idx, wp103Idx + 1, "WP10-4 migration must immediately follow WP10-3");

    // -------------------------------------------------------------------------
    // Phase 0: Apply 0..241 (BEFORE 20261125200000)
    // -------------------------------------------------------------------------
    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i <= wp103Idx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as today_vn
      ),
      workdays as (
        select gs::date as d
          from d, generate_series(d.today_vn - 20, d.today_vn - 1, interval '1 day') as gs
         where extract(dow from gs) <> 0
         order by gs desc
      )
      select today_vn::text,
             extract(year from today_vn)::int as leave_year,
             (select array_agg(d::text) from (select d from workdays limit 8) w) as past_workdays,
             (
               case
                 when extract(day from today_vn)::int >= 12
                   then date_trunc('month', today_vn)::date
                 else (date_trunc('month', today_vn)::date + 10)
               end
             )::text as ld_base
        from d
    `);
    const leaveDays = Array.from({ length: 10 }, (_, idx) => {
      const dt = new Date(`${dates.ld_base}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() + idx);
      return dt.toISOString().slice(0, 10);
    });
    const expDates = dates.past_workdays;
    await setBusinessDate(setup, dates.today_vn);

    // Seed teams (`rec_team`, `marketing`), project, scopes, banks
    const TEAM_REC = nextUuid();
    const TEAM_MKT = nextUuid();
    const PRJ_1 = "wp10-4-prj-1";
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'rec_team', 'Recruitment Team', true, 1),
              ($2::uuid, 'marketing', 'Marketing Rec Team', true, 1)`,
      [TEAM_REC, TEAM_MKT],
    );
    await setup.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project WP10-4', true)",
      [PRJ_1],
    );
    await setup.query(
      "insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)",
    );
    for (const tid of [TEAM_REC, TEAM_MKT]) {
      await setup.query(
        "insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id) values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)",
        [PRJ_1, tid, OWNER.app],
      );
    }

    const { rows: sysDeptRows } = await setup.query(
      "select department_id, system_key, name from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING')",
    );
    const deptByKey = Object.fromEntries(sysDeptRows.map((d) => [d.system_key, d.department_id]));
    const deptNameByKey = Object.fromEntries(sysDeptRows.map((d) => [d.system_key, d.name]));
    assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.IT && deptByKey.ACCOUNTING);

    const opsCreate = await serviceRpc(setup, "org_department_create_department_admin", [
      OWNER.auth,
      OWNER.app,
      "OPERATIONS",
      "Phòng Vận hành",
      "Tạo phòng ban OPERATIONS",
      nextUuid(),
      computeCreateDepartmentFingerprint({
        actor_app_user_id: OWNER.app,
        code: "OPERATIONS",
        name: "Phòng Vận hành",
        reason: "Tạo phòng ban OPERATIONS",
      }),
    ]);
    const opsDeptId = opsCreate.department.department_id;

    async function onboardOrgUser(tag, deptId, displayName, { withRecruiter = false, position = "STAFF", teamId = null } = {}) {
      const acc = await seedPlainAccount(setup, `wp104.${tag}`, displayName);
      const empCode = `EMP-W4-${tag.toUpperCase()}`;
      const p = (
        await serviceRpc(setup, "org_department_create_person_admin", [
          OWNER.auth,
          OWNER.app,
          empCode,
          acc.name,
          "2025-01-01",
          deptId,
          acc.app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: acc.name,
            joined_on: "2025-01-01",
            initial_department_ref: deptId,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ])
      ).person;
      let recruiterId = null;
      if (withRecruiter) {
        const cp = await serviceRpc(setup, "direct_entry_account_operation_create_personnel", [
          OWNER.auth,
          OWNER.app,
          acc.app,
          p.active_account_link.account_version,
          acc.login,
          position,
          null,
          `Create recruiter ${tag}`,
          nextUuid(),
        ]);
        recruiterId = cp.recruiter_id;
        if (teamId) {
          await serviceRpc(setup, "direct_entry_assign_team_membership", [
            OWNER.auth,
            OWNER.app,
            recruiterId,
            teamId,
            null,
            cp.version,
            `Assign team ${tag}`,
            nextUuid(),
          ]);
        }
      }
      await serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
        OWNER.auth,
        OWNER.app,
        acc.app,
        "OFFICIAL",
        null,
        "2025-01-01",
        "2025-03-01",
        null,
        0,
        0,
        `Leave profile ${tag}`,
        `lp-${tag}-${seq++}`,
        sha256(`lp-${tag}-${acc.app}`),
      ]);
      const { rows: [pRef] } = await observer.query("select version from public.organization_persons where person_id = $1::uuid", [p.person_id]);
      return { acc, person: { ...p, version: pRef.version }, recruiterId };
    }

    async function designateDeptHead(deptId, personId, label, expectedHeadId = null) {
      const { rows: [dRow] } = await observer.query(
        "select version from public.organization_departments where department_id = $1::uuid",
        [deptId],
      );
      return serviceRpc(setup, "org_department_designate_head_admin", [
        OWNER.auth,
        OWNER.app,
        deptId,
        personId,
        dRow.version,
        expectedHeadId,
        label,
        nextUuid(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: deptId,
          person_id: personId,
          expected_department_version: dRow.version,
          expected_current_head_assignment_id: expectedHeadId,
          reason: label,
        }),
      ]);
    }

    async function endDeptHead(deptId, headAssignmentId, label) {
      const { rows: [dRow] } = await observer.query(
        "select version from public.organization_departments where department_id = $1::uuid",
        [deptId],
      );
      return serviceRpc(setup, "org_department_end_head_admin", [
        OWNER.auth,
        OWNER.app,
        deptId,
        dRow.version,
        headAssignmentId,
        label,
        nextUuid(),
        computeEndHeadFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: deptId,
          expected_department_version: dRow.version,
          expected_current_head_assignment_id: headAssignmentId,
          reason: label,
        }),
      ]);
    }

    // Seed Personas
    const mktHeadTu = await onboardOrgUser("mkttu", deptByKey.MARKETING, "Nguyễn Kim Tú");
    const mktHeadAssign1 = await designateDeptHead(deptByKey.MARKETING, mktHeadTu.person.person_id, "Bổ nhiệm Nguyễn Kim Tú");
    const mktHeadTu2 = await onboardOrgUser("mkttu2", deptByKey.MARKETING, "Nguyễn Kim Tú 2");
    const mktEmp = await onboardOrgUser("mktemp", deptByKey.MARKETING, "Nhân viên Marketing");
    const mktPeer = await onboardOrgUser("mktpeer", deptByKey.MARKETING, "Đồng nghiệp Marketing");
    const mktCrossTl = await onboardOrgUser("mktctl", deptByKey.MARKETING, "Cross-Dept Marketing TL", {
      withRecruiter: true,
      position: "TEAM_LEADER",
      teamId: TEAM_MKT,
    });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_MKT, mktCrossTl.acc.app, null, 1, "Designate Cross-Dept MKT TL", nextUuid(),
    ]);

    const itLegacyApprover = await onboardOrgUser("itleg", deptByKey.IT, "IT Legacy Approver");
    const itEmp = await onboardOrgUser("itemp", deptByKey.IT, "IT Employee");
    const itFutureHead = await onboardOrgUser("ithead", deptByKey.IT, "IT Org Head");

    const acctLegacyApprover = await onboardOrgUser("acctleg", deptByKey.ACCOUNTING, "Accounting Legacy Approver");
    const acctEmp = await onboardOrgUser("acctemp", deptByKey.ACCOUNTING, "Accounting Employee");
    const acctFutureHead = await onboardOrgUser("accthead", deptByKey.ACCOUNTING, "Accounting Org Head");

    const recTl = await onboardOrgUser("rectl", deptByKey.RECRUITMENT, "Recruitment TL", {
      withRecruiter: true,
      position: "TEAM_LEADER",
      teamId: TEAM_REC,
    });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_REC, recTl.acc.app, null, 1, "Designate Rec TL", nextUuid(),
    ]);
    const recEmp = await onboardOrgUser("recemp", deptByKey.RECRUITMENT, "Recruitment Member", {
      withRecruiter: true,
      teamId: TEAM_REC,
    });

    const opsHead = await onboardOrgUser("opshead", opsDeptId, "Operations Head");
    const opsHeadAssign = await designateDeptHead(opsDeptId, opsHead.person.person_id, "Bổ nhiệm Trưởng phòng Vận hành");
    const opsEmp = await onboardOrgUser("opsemp", opsDeptId, "Operations Employee");
    assert.ok(opsHeadAssign.active_head.head_assignment_id);

    // Seed pre-cutover active rows in legacy `leave_department_approvers` for IT, ACCOUNTING, AND MARKETING (Tú)
    for (const [uk, appId] of [
      ["IT", itLegacyApprover.acc.app],
      ["ACCOUNTING", acctLegacyApprover.acc.app],
      ["MARKETING", mktHeadTu.acc.app],
    ]) {
      await serviceRpc(setup, "leave_management_set_department_approver_admin", [
        OWNER.auth, OWNER.app, uk, appId, null, 0, `Pre-cutover legacy ${uk}`, `pre-da-${uk}-${seq++}`, sha256(`pre-da-${uk}`),
      ]);
    }

    // BEFORE 242: IT & ACCOUNTING route to legacy approvers; IT legacy approver gets 1 PENDING Leave + 1 PENDING Exp
    const preItSummary = await serviceRpc(setup, "leave_management_get_my_summary", [itEmp.acc.auth, itEmp.acc.app, dates.leave_year]);
    assert.equal(preItSummary.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(preItSummary.routing.primary_approver_app_user_id, itLegacyApprover.acc.app);

    const preItPendingLeave = await serviceRpc(setup, "leave_management_create_request", [
      itEmp.acc.auth, itEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[0], session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-242 IT pending leave", `pre-it-l-${seq++}`, sha256("pre-it-l"),
    ]);
    const preItPendingExp = await serviceRpc(setup, "attendance_submit_explanation", [
      itEmp.acc.auth, itEmp.acc.app, expDates[0], "SLOT_1",
      "Pre-242 IT pending exp", nextUuid(), sha256("pre-it-e"),
    ]);
    assert.equal(preItPendingLeave.request.primary_approver_app_user_id, itLegacyApprover.acc.app);
    assert.equal(preItPendingExp.explanation.primary_approver.app_user_id, itLegacyApprover.acc.app);

    // Prepare Pre-242 APPROVED Marketing Leave + Exp pairs for Section 4:
    //   Pair A: routed_department_id = MKT
    //   Pair B: legacy routed_department_id IS NULL + unit_kind_snapshot = 'MARKETING' + primary_approver_app_user_id = Tú
    async function createAndApproveMktPair(day, expDate, slot, tag, makeNullDeptId = false) {
      const lr = await serviceRpc(setup, "leave_management_create_request", [
        mktEmp.acc.auth, mktEmp.acc.app,
        JSON.stringify([{ leave_date: day, session_code: "AM", leave_type: "ANNUAL" }]),
        `MKT leave ${tag}`, `mkt-l-${tag}-${seq++}`, sha256(`mkt-l-${tag}`),
      ]);
      const lApp = await serviceRpc(setup, "leave_management_decide_request", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, lr.request.request_id, "APPROVE", 1,
        `Approve ${tag}`, `mkt-la-${tag}-${seq++}`, sha256(`mkt-la-${tag}`),
      ]);
      const er = await serviceRpc(setup, "attendance_submit_explanation", [
        mktEmp.acc.auth, mktEmp.acc.app, expDate, slot,
        `MKT exp ${tag}`, nextUuid(), sha256(`mkt-e-${tag}`),
      ]);
      const eApp = await serviceRpc(setup, "attendance_decide_explanation", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, er.explanation.explanation_id, "APPROVE", 1,
        `Approve exp ${tag}`, nextUuid(), sha256(`mkt-ea-${tag}`),
      ]);
      if (makeNullDeptId) {
        await setup.query(
          "update public.leave_requests set routed_department_id = null, routed_department_code = null, routed_department_name = null where request_id = $1::uuid",
          [lApp.request.request_id],
        );
        await setup.query(
          "update public.attendance_explanations set routed_department_id = null, routed_department_code = null, routed_department_name = null where explanation_id = $1::uuid",
          [eApp.explanation.explanation_id],
        );
      }
      return { leaveId: lApp.request.request_id, expId: eApp.explanation.explanation_id };
    }

    const pairActiveCancelWithDept = await createAndApproveMktPair(leaveDays[0], expDates[0], "SLOT_1", "active-dept", false);
    const pairActiveCancelNullDept = await createAndApproveMktPair(leaveDays[1], expDates[0], "SLOT_2", "active-null", true);
    const pairEndedFailWithDept = await createAndApproveMktPair(leaveDays[2], expDates[1], "SLOT_1", "ended-dept", false);
    const pairEndedFailNullDept = await createAndApproveMktPair(leaveDays[3], expDates[1], "SLOT_2", "ended-null", true);
    const pairReplaceFailWithDept = await createAndApproveMktPair(leaveDays[4], expDates[2], "SLOT_1", "replace-dept", false);
    const pairReplaceFailNullDept = await createAndApproveMktPair(leaveDays[5], expDates[2], "SLOT_2", "replace-null", true);

    const { rows: preLegacyRows } = await observer.query(
      "select approver_assignment_id::text, unit_kind, approver_app_user_id::text, is_current from public.leave_department_approvers order by approver_assignment_id",
    );
    assert.equal(preLegacyRows.length, 3);

    // -------------------------------------------------------------------------
    // Phase 1: Apply 242 (`20261125200000_wp10_4_org_department_heads_cutover.sql`)
    // -------------------------------------------------------------------------
    await setup.query(await readFile(path.join(MIGRATION_DIR, WP10_4_MIGRATION_NAME), "utf8"));

    // =========================================================================
    // 1. Database Audit
    // =========================================================================
    const { rows: remainingLegacyRefs } = await observer.query(`
      select p.oid::regprocedure::text as sig
        from pg_catalog.pg_proc p
       where p.pronamespace = 'public'::pg_catalog.regnamespace
         and p.prokind in ('f', 'p')
         and p.prosrc ~* 'leave_department_approvers'
    `);
    assert.deepEqual(remainingLegacyRefs, [], "Zero public functions may reference leave_department_approvers after 242");

    const { rows: postLegacyRows } = await observer.query(
      "select approver_assignment_id::text, unit_kind, approver_app_user_id::text, is_current from public.leave_department_approvers order by approver_assignment_id",
    );
    assert.deepEqual(postLegacyRows, preLegacyRows, "leave_department_approvers table and rows must remain intact");

    // =========================================================================
    // 2. Cutover Routing Matrix (Leave & Attendance Explanations)
    // =========================================================================
    // 2a. MARKETING employee -> Tú (DEPARTMENT_HEAD, routed_department_id = MKT); Tú -> ADMIN_BOD_DIRECT + self-approval block
    const mktEmpLeave = await serviceRpc(setup, "leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[6], session_code: "AM", leave_type: "ANNUAL" }]),
      "Post-242 MKT emp leave", `p242-mkt-l-${seq++}`, sha256("p242-mkt-l"),
    ]);
    assert.equal(mktEmpLeave.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktEmpLeave.request.primary_approver_app_user_id, mktHeadTu.acc.app);
    const { rows: [mktEmpLeaveDb] } = await observer.query(
      "select routed_department_id::text, routed_department_code from public.leave_requests where request_id = $1::uuid",
      [mktEmpLeave.request.request_id],
    );
    assert.equal(mktEmpLeaveDb.routed_department_id, deptByKey.MARKETING);
    assert.equal(mktEmpLeaveDb.routed_department_code, "MARKETING");

    const mktEmpExp = projectSubmitAttendanceExplanationResult(
      await serviceRpc(setup, "attendance_submit_explanation", [
        mktEmp.acc.auth, mktEmp.acc.app, expDates[3], "SLOT_1",
        "Post-242 MKT emp exp", nextUuid(), sha256("p242-mkt-e"),
      ]),
    );
    assert.ok(mktEmpExp);
    assert.equal(mktEmpExp.explanation.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktEmpExp.explanation.primary_approver?.app_user_id, mktHeadTu.acc.app);

    const tuLeave = await serviceRpc(setup, "leave_management_create_request", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app,
      JSON.stringify([{ leave_date: leaveDays[0], session_code: "AM", leave_type: "ANNUAL" }]),
      "Tú own leave", `tu-own-l-${seq++}`, sha256("tu-own-l"),
    ]);
    assert.equal(tuLeave.request.route_kind, "ADMIN_BOD_DIRECT");
    assert.equal(tuLeave.request.primary_approver_app_user_id, null);

    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_decide_request", [
          mktHeadTu.acc.auth, mktHeadTu.acc.app, tuLeave.request.request_id, "APPROVE", 1,
          "Self approve leave", `tu-self-l-${seq++}`, sha256("tu-self-l"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_SELF_APPROVAL_FORBIDDEN"),
    );

    const tuExp = projectSubmitAttendanceExplanationResult(
      await serviceRpc(setup, "attendance_submit_explanation", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, expDates[0], "SLOT_1",
        "Tú own exp", nextUuid(), sha256("tu-own-e"),
      ]),
    );
    assert.ok(tuExp);
    assert.equal(tuExp.explanation.route_kind, "ADMIN_BOD_DIRECT");
    assert.equal(tuExp.explanation.primary_approver, null);

    await assert.rejects(
      () =>
        serviceRpc(setup, "attendance_decide_explanation", [
          mktHeadTu.acc.auth, mktHeadTu.acc.app, tuExp.explanation.explanation_id, "APPROVE", 1,
          "Self approve exp", nextUuid(), sha256("tu-self-e"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN"),
    );

    // 2b. IT & ACCOUNTING (legacy approver rows exist, NO Org Head yet) -> ADMIN_BOD_FALLBACK
    for (const [label, emp] of [["IT", itEmp], ["ACCOUNTING", acctEmp]]) {
      const sum = await serviceRpc(setup, "leave_management_get_my_summary", [emp.acc.auth, emp.acc.app, dates.leave_year]);
      assert.equal(sum.routing.route_kind, "ADMIN_BOD_FALLBACK", `${label} must fall back before Org Head`);
      assert.equal(sum.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");
      assert.equal(sum.routing.primary_approver_app_user_id, null);

      const ov = projectAttendanceMyExplanationsOverview(
        await serviceRpc(setup, "attendance_get_my_explanations_overview", [emp.acc.auth, emp.acc.app, expDates[0], 20, 0]),
      );
      assert.ok(ov);
      assert.equal(ov.routing.route_kind, "ADMIN_BOD_FALLBACK");
      assert.equal(ov.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");
    }

    // Legacy approvers lose is_department_approver immediately; can_approve_requests stays true ONLY with open PENDING snapshot
    const acctLegSum = await serviceRpc(setup, "leave_management_get_my_summary", [
      acctLegacyApprover.acc.auth, acctLegacyApprover.acc.app, dates.leave_year,
    ]);
    assert.equal(acctLegSum.authority.is_department_approver, false);
    assert.equal(acctLegSum.authority.can_approve_requests, false);

    const itLegSumPending = await serviceRpc(setup, "leave_management_get_my_summary", [
      itLegacyApprover.acc.auth, itLegacyApprover.acc.app, dates.leave_year,
    ]);
    assert.equal(itLegSumPending.authority.is_department_approver, false);
    assert.equal(itLegSumPending.authority.can_approve_requests, true, "IT legacy approver retains inbox only for pre-242 PENDING snapshot");

    // IT legacy approver decides pre-242 PENDING Leave + Explanation, then loses can_approve_requests
    const itDecLeave = await serviceRpc(setup, "leave_management_decide_request", [
      itLegacyApprover.acc.auth, itLegacyApprover.acc.app, preItPendingLeave.request.request_id,
      "APPROVE", 1, "Approve pre-242 IT pending", `it-leg-l-${seq++}`, sha256("it-leg-l"),
    ]);
    assert.equal(itDecLeave.request.status, "APPROVED");
    const itDecExp = await serviceRpc(setup, "attendance_decide_explanation", [
      itLegacyApprover.acc.auth, itLegacyApprover.acc.app, preItPendingExp.explanation.explanation_id,
      "APPROVE", 1, "Approve pre-242 IT exp", nextUuid(), sha256("it-leg-e"),
    ]);
    assert.equal(itDecExp.explanation.status, "APPROVED");

    const itLegSumCleared = await serviceRpc(setup, "leave_management_get_my_summary", [
      itLegacyApprover.acc.auth, itLegacyApprover.acc.app, dates.leave_year,
    ]);
    assert.equal(itLegSumCleared.authority.is_department_approver, false);
    assert.equal(itLegSumCleared.authority.can_approve_requests, false);

    // 2c. Designating active Org Heads for ACCOUNTING & IT immediately switches new Leave & Explanations to DEPARTMENT_HEAD
    await designateDeptHead(deptByKey.ACCOUNTING, acctFutureHead.person.person_id, "Bổ nhiệm Trưởng phòng Kế toán");
    await designateDeptHead(deptByKey.IT, itFutureHead.person.person_id, "Bổ nhiệm Trưởng phòng IT");

    for (const [label, emp, head, deptId] of [
      ["ACCOUNTING", acctEmp, acctFutureHead, deptByKey.ACCOUNTING],
      ["IT", itEmp, itFutureHead, deptByKey.IT],
    ]) {
      const lr = await serviceRpc(setup, "leave_management_create_request", [
        emp.acc.auth, emp.acc.app,
        JSON.stringify([{ leave_date: leaveDays[1], session_code: "AM", leave_type: "ANNUAL" }]),
        `${label} post-head leave`, `post-hd-l-${label}-${seq++}`, sha256(`post-hd-l-${label}`),
      ]);
      assert.equal(lr.request.route_kind, "DEPARTMENT_HEAD");
      assert.equal(lr.request.primary_approver_app_user_id, head.acc.app);

      const er = projectSubmitAttendanceExplanationResult(
        await serviceRpc(setup, "attendance_submit_explanation", [
          emp.acc.auth, emp.acc.app, expDates[1], "SLOT_1",
          `${label} post-head exp`, nextUuid(), sha256(`post-hd-e-${label}`),
        ]),
      );
      assert.ok(er);
      assert.equal(er.explanation.route_kind, "DEPARTMENT_HEAD");
      assert.equal(er.explanation.primary_approver?.app_user_id, head.acc.app);
      const { rows: [erDb] } = await observer.query(
        "select routed_department_id::text from public.attendance_explanations where explanation_id = $1::uuid",
        [er.explanation.explanation_id],
      );
      assert.equal(erDb.routed_department_id, deptId);
    }

    // 2d. Preserved contracts: Recruitment member -> TEAM_LEADER, Recruitment TL -> ADMIN_BOD_DIRECT,
    //     #32 cross-dept Marketing TL -> Marketing Org Head Tú, Custom OPERATIONS -> opsHead
    const preservedChecks = [
      { label: "RECRUITMENT member", emp: recEmp, route: "TEAM_LEADER", approver: recTl.acc.app },
      { label: "RECRUITMENT TL", emp: recTl, route: "ADMIN_BOD_DIRECT", approver: null },
      { label: "#32 Marketing cross-dept TL", emp: mktCrossTl, route: "DEPARTMENT_HEAD", approver: mktHeadTu.acc.app, approverActor: mktHeadTu },
      { label: "Custom OPERATIONS", emp: opsEmp, route: "DEPARTMENT_HEAD", approver: opsHead.acc.app },
    ];
    for (const c of preservedChecks) {
      const lr = await serviceRpc(setup, "leave_management_create_request", [
        c.emp.acc.auth, c.emp.acc.app,
        JSON.stringify([{ leave_date: leaveDays[2], session_code: "AM", leave_type: "UNPAID" }]),
        `Preserved ${c.label}`, `pres-l-${seq++}`, sha256(`pres-l-${c.label}`),
      ]);
      assert.equal(lr.request.route_kind, c.route, `${c.label} leave route_kind`);
      assert.equal(lr.request.primary_approver_app_user_id, c.approver, `${c.label} leave approver`);

      const er = projectSubmitAttendanceExplanationResult(
        await serviceRpc(setup, "attendance_submit_explanation", [
          c.emp.acc.auth, c.emp.acc.app, expDates[2], "SLOT_1",
          `Preserved exp ${c.label}`, nextUuid(), sha256(`pres-e-${c.label}`),
        ]),
      );
      assert.ok(er);
      assert.equal(er.explanation.route_kind, c.route, `${c.label} exp route_kind`);
      assert.equal(er.explanation.primary_approver?.app_user_id ?? null, c.approver, `${c.label} exp approver`);

      if (c.approverActor) {
        const decL = await serviceRpc(setup, "leave_management_decide_request", [
          c.approverActor.acc.auth, c.approverActor.acc.app, lr.request.request_id, "APPROVE", 1,
          `Approve ${c.label}`, `pres-la-${seq++}`, sha256(`pres-la-${c.label}`),
        ]);
        assert.equal(decL.request.status, "APPROVED");
        const decE = await serviceRpc(setup, "attendance_decide_explanation", [
          c.approverActor.acc.auth, c.approverActor.acc.app, er.explanation.explanation_id, "APPROVE", 1,
          `Approve exp ${c.label}`, nextUuid(), sha256(`pres-ea-${c.label}`),
        ]);
        assert.equal(decE.explanation.status, "APPROVED");
      }
    }

    // =========================================================================
    // 4a & 3a. Dedicated APPROVED Cancel (Tú active) + Out-of-Route Actor + Reject Lifecycle
    // =========================================================================
    // Out-of-route actor (opsHead & mktPeer) cannot see mktEmp PENDING items or decide/cancel
    const opsLeaveInbox = await serviceRpc(setup, "leave_management_list_approval_inbox", [
      opsHead.acc.auth, opsHead.acc.app, "PENDING", 50, 0,
    ]);
    assert.equal(opsLeaveInbox.items.some((i) => i.request_id === mktEmpLeave.request.request_id), false);
    const opsExpInbox = projectAttendanceExplanationApprovalInbox(
      await serviceRpc(setup, "attendance_list_explanation_approval_inbox", [
        opsHead.acc.auth, opsHead.acc.app, "PENDING", 50, 0,
      ]),
    );
    assert.ok(opsExpInbox);
    assert.equal(opsExpInbox.items.some((i) => i.explanation_id === mktEmpExp.explanation.explanation_id), false);

    await assert.rejects(
      () => serviceRpc(setup, "leave_management_list_approval_inbox", [mktPeer.acc.auth, mktPeer.acc.app, "PENDING", 50, 0]),
      (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );
    await assert.rejects(
      () => serviceRpc(setup, "attendance_list_explanation_approval_inbox", [mktPeer.acc.auth, mktPeer.acc.app, "PENDING", 50, 0]),
      (err) => err?.code === "42501",
    );

    for (const outActor of [opsHead, mktPeer]) {

      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_decide_request", [
            outActor.acc.auth, outActor.acc.app, mktEmpLeave.request.request_id, "APPROVE", 1,
            "Out-of-route", `oor-l-${seq++}`, sha256(`oor-l-${outActor.acc.app}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
      );
      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_decide_request", [
            outActor.acc.auth, outActor.acc.app, pairActiveCancelWithDept.leaveId, "CANCEL_APPROVED", 2,
            "Out-of-route cancel", `oor-lc-${seq++}`, sha256(`oor-lc-${outActor.acc.app}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
      );
      await assert.rejects(
        () =>
          serviceRpc(setup, "attendance_decide_explanation", [
            outActor.acc.auth, outActor.acc.app, mktEmpExp.explanation.explanation_id, "APPROVE", 1,
            "Out-of-route exp", nextUuid(), sha256(`oor-e-${outActor.acc.app}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("ATTENDANCE_EXPLANATION_DECIDE_DENIED"),
      );
    }

    // Lifecycle REJECT on Leave + Explanation by active Head Tú
    const mktRejLeave = await serviceRpc(setup, "leave_management_decide_request", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, mktEmpLeave.request.request_id, "REJECT", 1,
      "Từ chối thử nghiệm", `rej-mkt-l-${seq++}`, sha256("rej-mkt-l"),
    ]);
    assert.equal(mktRejLeave.request.status, "REJECTED");

    const mktRejExp = await serviceRpc(setup, "attendance_decide_explanation", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, mktEmpExp.explanation.explanation_id, "REJECT", 1,
      "Từ chối giải trình thử nghiệm", nextUuid(), sha256("rej-mkt-e"),
    ]);
    assert.equal(mktRejExp.explanation.status, "REJECTED");

    // Active Head Tú cancels BOTH APPROVED Leave requests (routed_department_id = MKT AND routed_department_id IS NULL)
    for (const [label, pair, expectedDeptId] of [
      ["routed_department_id = MKT", pairActiveCancelWithDept, deptByKey.MARKETING],
      ["routed_department_id IS NULL", pairActiveCancelNullDept, null],
    ]) {
      const cancelled = await serviceRpc(setup, "leave_management_decide_request", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.leaveId, "CANCEL_APPROVED", 2,
        `Active head cancel (${label})`, `can-act-${seq++}`, sha256(`can-act-${pair.leaveId}`),
      ]);
      assert.equal(cancelled.request.status, "CANCELLED", `${label} cancel must succeed while Tú is active Org Head`);
      const { rows: [lRow] } = await observer.query(
        "select unit_kind_snapshot, routed_department_id::text, primary_approver_app_user_id::text from public.leave_requests where request_id = $1::uuid",
        [pair.leaveId],
      );
      assert.equal(lRow.unit_kind_snapshot, "MARKETING");
      assert.equal(lRow.routed_department_id, expectedDeptId);
      assert.equal(lRow.primary_approver_app_user_id, mktHeadTu.acc.app);

      // Attendance Explanation: attendance_decide_explanation supports only APPROVE/REJECT (`CANCEL_APPROVED` -> 22023),
      // while `attendance_explanation__internal_can_actor_decide` is true for active Head Tú (hitting PT409 ALREADY_DECIDED rather than 42501)
      const { rows: [canExp] } = await setup.query(
        "select public.attendance_explanation__internal_can_actor_decide($1::uuid, ae, $2::date) as ok from public.attendance_explanations ae where ae.explanation_id = $3::uuid",
        [mktHeadTu.acc.app, dates.today_vn, pair.expId],
      );
      assert.equal(canExp.ok, true, `${label}: active Head must pass can_actor_decide on APPROVED explanation`);

      await assert.rejects(
        () =>
          serviceRpc(setup, "attendance_decide_explanation", [
            mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.expId, "CANCEL_APPROVED", 2,
            "Unsupported cancel", nextUuid(), sha256(`exp-can-inv-${pair.expId}`),
          ]),
        (err) => err?.code === "22023" && String(err?.message).includes("ATTENDANCE_EXPLANATION_DECISION_INVALID"),
      );
      await assert.rejects(
        () =>
          serviceRpc(setup, "attendance_decide_explanation", [
            mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.expId, "REJECT", 2,
            "Already decided", nextUuid(), sha256(`exp-alr-${pair.expId}`),
          ]),
        (err) => err?.code === "PT409" && String(err?.message).includes("ATTENDANCE_EXPLANATION_ALREADY_DECIDED"),
      );
    }

    // =========================================================================
    // 4b. ENDED Org Head fails closed on APPROVED Cancel (with & without routed_department_id)
    //     even though legacy `leave_department_approvers` row for Tú still exists!
    // =========================================================================
    await endDeptHead(deptByKey.MARKETING, mktHeadAssign1.active_head.head_assignment_id, "Kết thúc nhiệm kỳ Trưởng phòng Tú");

    for (const [label, pair] of [
      ["ended w/ routed_department_id", pairEndedFailWithDept],
      ["ended w/ routed_department_id IS NULL", pairEndedFailNullDept],
    ]) {
      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_decide_request", [
            mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.leaveId, "CANCEL_APPROVED", 2,
            "Ended head cancel", `can-end-${seq++}`, sha256(`can-end-${pair.leaveId}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
        `${label}: ended Head must be blocked from CANCEL_APPROVED despite legacy table row`,
      );
      const { rows: [canExpEnd] } = await setup.query(
        "select public.attendance_explanation__internal_can_actor_decide($1::uuid, ae, $2::date) as ok from public.attendance_explanations ae where ae.explanation_id = $3::uuid",
        [mktHeadTu.acc.app, dates.today_vn, pair.expId],
      );
      assert.equal(canExpEnd.ok, false, `${label}: ended Head must fail can_actor_decide on APPROVED explanation`);
      await assert.rejects(
        () =>
          serviceRpc(setup, "attendance_decide_explanation", [
            mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.expId, "REJECT", 2,
            "Ended head exp decide", nextUuid(), sha256(`exp-end-${pair.expId}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("ATTENDANCE_EXPLANATION_DECIDE_DENIED"),
      );
    }

    // Re-designate Tú as MKT Head for Head-Swap test
    const mktHeadAssign2 = await designateDeptHead(deptByKey.MARKETING, mktHeadTu.person.person_id, "Bổ nhiệm lại Nguyễn Kim Tú");

    // =========================================================================
    // 3b & 4c. Replace Department Head (Tú -> Tú 2): PENDING snapshot + New Routing + APPROVED Cancel Fail-Closed
    // =========================================================================
    const preSwapLeave = await serviceRpc(setup, "leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[7], session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-swap pending leave", `preswap-l-${seq++}`, sha256("preswap-l"),
    ]);
    const preSwapExp = projectSubmitAttendanceExplanationResult(
      await serviceRpc(setup, "attendance_submit_explanation", [
        mktEmp.acc.auth, mktEmp.acc.app, expDates[4], "SLOT_1",
        "Pre-swap pending exp", nextUuid(), sha256("preswap-e"),
      ]),
    );
    assert.ok(preSwapExp);
    assert.equal(preSwapLeave.request.primary_approver_app_user_id, mktHeadTu.acc.app);
    assert.equal(preSwapExp.explanation.primary_approver?.app_user_id, mktHeadTu.acc.app);

    const mktHeadAssignTu2 = await designateDeptHead(
      deptByKey.MARKETING,
      mktHeadTu2.person.person_id,
      "Thay thế Trưởng phòng Tú -> Tú 2",
      mktHeadAssign2.active_head.head_assignment_id,
    );

    // Snapshot untouched
    const { rows: [preSwapLeaveDb] } = await observer.query(
      "select primary_approver_app_user_id::text, routed_department_id::text, status from public.leave_requests where request_id = $1::uuid",
      [preSwapLeave.request.request_id],
    );
    assert.deepEqual(preSwapLeaveDb, {
      primary_approver_app_user_id: mktHeadTu.acc.app,
      routed_department_id: deptByKey.MARKETING,
      status: "PENDING",
    });

    // New Head Tú 2 CANNOT approve/reject former Head Tú's PENDING items
    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_decide_request", [
          mktHeadTu2.acc.auth, mktHeadTu2.acc.app, preSwapLeave.request.request_id, "APPROVE", 1,
          "Tú 2 thử duyệt đơn cũ của Tú", `tu2-steal-l-${seq++}`, sha256("tu2-steal-l"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "attendance_decide_explanation", [
          mktHeadTu2.acc.auth, mktHeadTu2.acc.app, preSwapExp.explanation.explanation_id, "APPROVE", 1,
          "Tú 2 thử duyệt giải trình cũ của Tú", nextUuid(), sha256("tu2-steal-e"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("ATTENDANCE_EXPLANATION_DECIDE_DENIED"),
    );

    // Replaced Head Tú CANNOT cancel already-APPROVED items (with & without routed_department_id)
    for (const [label, pair] of [
      ["replaced w/ routed_department_id", pairReplaceFailWithDept],
      ["replaced w/ routed_department_id IS NULL", pairReplaceFailNullDept],
    ]) {
      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_decide_request", [
            mktHeadTu.acc.auth, mktHeadTu.acc.app, pair.leaveId, "CANCEL_APPROVED", 2,
            "Replaced head cancel", `can-rep-${seq++}`, sha256(`can-rep-${pair.leaveId}`),
          ]),
        (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
        `${label}: replaced Head must be blocked from CANCEL_APPROVED`,
      );
      const { rows: [canExpRep] } = await setup.query(
        "select public.attendance_explanation__internal_can_actor_decide($1::uuid, ae, $2::date) as ok from public.attendance_explanations ae where ae.explanation_id = $3::uuid",
        [mktHeadTu.acc.app, dates.today_vn, pair.expId],
      );
      assert.equal(canExpRep.ok, false, `${label}: replaced Head must fail can_actor_decide`);
    }

    // Former Head Tú retains authority for pre-swap PENDING Leave & Explanation and decides them cleanly
    const tuSumDuringPending = await serviceRpc(setup, "leave_management_get_my_summary", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, dates.leave_year,
    ]);
    assert.equal(tuSumDuringPending.authority.is_department_approver, false);
    assert.equal(tuSumDuringPending.authority.can_approve_requests, true);

    const tuApprovedPreSwapLeave = await serviceRpc(setup, "leave_management_decide_request", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, preSwapLeave.request.request_id, "APPROVE", 1,
      "Tú duyệt đơn cũ trước bàn giao", `tu-fin-l-${seq++}`, sha256("tu-fin-l"),
    ]);
    assert.equal(tuApprovedPreSwapLeave.request.status, "APPROVED");
    const tuApprovedPreSwapExp = await serviceRpc(setup, "attendance_decide_explanation", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, preSwapExp.explanation.explanation_id, "APPROVE", 1,
      "Tú duyệt giải trình cũ trước bàn giao", nextUuid(), sha256("tu-fin-e"),
    ]);
    assert.equal(tuApprovedPreSwapExp.explanation.status, "APPROVED");

    const tuSumAfterCleared = await serviceRpc(setup, "leave_management_get_my_summary", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, dates.leave_year,
    ]);
    assert.equal(tuSumAfterCleared.authority.can_approve_requests, false);

    // New Leave & Explanation submitted after swap route to New Head Tú 2
    const postSwapLeave = await serviceRpc(setup, "leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[8], session_code: "AM", leave_type: "ANNUAL" }]),
      "Post-swap leave to Tú 2", `postswap-l-${seq++}`, sha256("postswap-l"),
    ]);
    assert.equal(postSwapLeave.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(postSwapLeave.request.primary_approver_app_user_id, mktHeadTu2.acc.app);

    const postSwapExp = projectSubmitAttendanceExplanationResult(
      await serviceRpc(setup, "attendance_submit_explanation", [
        mktEmp.acc.auth, mktEmp.acc.app, expDates[5], "SLOT_1",
        "Post-swap exp to Tú 2", nextUuid(), sha256("postswap-e"),
      ]),
    );
    assert.ok(postSwapExp);
    assert.equal(postSwapExp.explanation.primary_approver?.app_user_id, mktHeadTu2.acc.app);

    // Prepare 2 APPROVED pairs owned by Tú 2 (with routed_department_id=MKT and NULL) to verify Disabled Head fail-closed
    const tu2ApprovedLeaveWithDept = await serviceRpc(setup, "leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[9], session_code: "AM", leave_type: "ANNUAL" }]),
      "Tú 2 approved w/ dept", `tu2-ad-l-${seq++}`, sha256("tu2-ad-l"),
    ]);
    await serviceRpc(setup, "leave_management_decide_request", [
      mktHeadTu2.acc.auth, mktHeadTu2.acc.app, tu2ApprovedLeaveWithDept.request.request_id, "APPROVE", 1,
      "Tú 2 approve", `tu2-ad-la-${seq++}`, sha256("tu2-ad-la"),
    ]);
    const tu2ApprovedLeaveNullDept = await serviceRpc(setup, "leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: leaveDays[9], session_code: "PM", leave_type: "ANNUAL" }]),
      "Tú 2 approved null dept", `tu2-an-l-${seq++}`, sha256("tu2-an-l"),
    ]);
    await serviceRpc(setup, "leave_management_decide_request", [
      mktHeadTu2.acc.auth, mktHeadTu2.acc.app, tu2ApprovedLeaveNullDept.request.request_id, "APPROVE", 1,
      "Tú 2 approve null", `tu2-an-la-${seq++}`, sha256("tu2-an-la"),
    ]);
    await setup.query(
      "update public.leave_requests set routed_department_id = null, routed_department_code = null, routed_department_name = null where request_id = $1::uuid",
      [tu2ApprovedLeaveNullDept.request.request_id],
    );
    const tu2ApprovedExpNullDept = await serviceRpc(setup, "attendance_submit_explanation", [
      mktEmp.acc.auth, mktEmp.acc.app, expDates[6], "SLOT_1",
      "Tú 2 approved exp null", nextUuid(), sha256("tu2-an-e"),
    ]);
    await serviceRpc(setup, "attendance_decide_explanation", [
      mktHeadTu2.acc.auth, mktHeadTu2.acc.app, tu2ApprovedExpNullDept.explanation.explanation_id, "APPROVE", 1,
      "Tú 2 approve exp null", nextUuid(), sha256("tu2-an-ea"),
    ]);
    await setup.query(
      "update public.attendance_explanations set routed_department_id = null, routed_department_code = null, routed_department_name = null where explanation_id = $1::uuid",
      [tu2ApprovedExpNullDept.explanation.explanation_id],
    );

    // =========================================================================
    // 3c & 4d. Disabled Org Head account (`u.enabled = false`)
    // =========================================================================
    await setup.query("update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid", [
      mktHeadTu2.acc.app,
    ]);

    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_decide_request", [
          mktHeadTu2.acc.auth, mktHeadTu2.acc.app, postSwapLeave.request.request_id, "APPROVE", 1,
          "Disabled decide pending leave", `dis-pl-${seq++}`, sha256("dis-pl"),
        ]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "attendance_decide_explanation", [
          mktHeadTu2.acc.auth, mktHeadTu2.acc.app, postSwapExp.explanation.explanation_id, "APPROVE", 1,
          "Disabled decide pending exp", nextUuid(), sha256("dis-pe"),
        ]),
      (err) => err?.code === "42501",
    );
    for (const reqId of [tu2ApprovedLeaveWithDept.request.request_id, tu2ApprovedLeaveNullDept.request.request_id]) {
      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_decide_request", [
            mktHeadTu2.acc.auth, mktHeadTu2.acc.app, reqId, "CANCEL_APPROVED", 2,
            "Disabled cancel approved", `dis-ca-${seq++}`, sha256(`dis-ca-${reqId}`),
          ]),
        (err) => err?.code === "42501",
      );
    }
    const { rows: [canExpDis] } = await setup.query(
      "select public.attendance_explanation__internal_can_actor_decide($1::uuid, ae, $2::date) as ok from public.attendance_explanations ae where ae.explanation_id = $3::uuid",
      [mktHeadTu2.acc.app, dates.today_vn, tu2ApprovedExpNullDept.explanation.explanation_id],
    );
    assert.equal(canExpDis.ok, false, "Disabled Head must fail can_actor_decide");

    // Employee requests fall back to ADMIN_BOD_FALLBACK while Head is disabled
    const mktWhileHeadDisabled = await serviceRpc(setup, "leave_management_get_my_summary", [
      mktEmp.acc.auth, mktEmp.acc.app, dates.leave_year,
    ]);
    assert.equal(mktWhileHeadDisabled.routing.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(mktWhileHeadDisabled.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");
    const mktExpWhileDisabled = projectAttendanceMyExplanationsOverview(
      await serviceRpc(setup, "attendance_get_my_explanations_overview", [
        mktEmp.acc.auth, mktEmp.acc.app, expDates[7], 20, 0,
      ]),
    );
    assert.ok(mktExpWhileDisabled);
    assert.equal(mktExpWhileDisabled.routing.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(mktExpWhileDisabled.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");

    // =========================================================================
    // 5. Admin Overview, Legacy RPC Retirement, Group Overview
    // =========================================================================
    // 5a. leave_management_get_admin_overview returns active eligible Org Heads (excluding disabled Tú 2, excluding RECRUITMENT)
    const adminOverview = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ACTIVE",
    ]);
    const approverRows = adminOverview.department_approvers;
    assert.equal(
      approverRows.some((r) => r.approver_app_user_id === itLegacyApprover.acc.app || r.approver_app_user_id === acctLegacyApprover.acc.app),
      false,
      "Stale leave_department_approvers rows must NEVER appear in admin overview",
    );
    assert.equal(
      approverRows.some((r) => r.approver_app_user_id === mktHeadTu2.acc.app),
      false,
      "Disabled Org Head Tú 2 must be excluded from admin overview department_approvers",
    );
    for (const [deptId, deptCode, sysKey, headAppId] of [
      [deptByKey.IT, "IT", "IT", itFutureHead.acc.app],
      [deptByKey.ACCOUNTING, "ACCOUNTING", "ACCOUNTING", acctFutureHead.acc.app],
      [opsDeptId, "OPERATIONS", null, opsHead.acc.app],
    ]) {
      const row = approverRows.find((r) => r.department_id === deptId);
      assert.ok(row, `Admin overview must include active Org Head for ${deptCode}`);
      assert.equal(row.department_code, deptCode);
      assert.equal(row.department_system_key, sysKey);
      assert.equal(row.approver_app_user_id, headAppId);
      assert.equal(row.is_current, true);
      assert.ok(row.department_name);
    }

    // Re-enable Tú 2 and verify MARKETING appears in admin overview & routing restores
    await setup.query("update public.direct_entry_app_users set enabled = true where app_user_id = $1::uuid", [
      mktHeadTu2.acc.app,
    ]);
    const adminOverviewAfterEnable = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ACTIVE",
    ]);
    const mktOverviewRow = adminOverviewAfterEnable.department_approvers.find((r) => r.department_id === deptByKey.MARKETING);
    assert.ok(mktOverviewRow);
    assert.equal(mktOverviewRow.approver_app_user_id, mktHeadTu2.acc.app);
    assert.equal(mktOverviewRow.department_name, deptNameByKey.MARKETING);

    // 5b. leave_management_set_department_approver_admin retirement (42501 non-admin, PT409 Admin/BoD, 0 writes)
    const { rows: [auditBeforeRetire] } = await observer.query(`
      select (select count(*)::int from public.leave_department_approvers) as da_cnt,
             (select count(*)::int from public.leave_audit_events) as audit_cnt,
             (select count(*)::int from public.leave_idempotency_records) as idem_cnt
    `);
    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_set_department_approver_admin", [
          mktEmp.acc.auth, mktEmp.acc.app, "IT", mktEmp.acc.app, null, 0,
          "Non-admin attempt", `retire-non-${seq++}`, sha256("retire-non"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN"),
    );
    for (const adm of [OWNER, LUANPT]) {
      await assert.rejects(
        () =>
          serviceRpc(setup, "leave_management_set_department_approver_admin", [
            adm.auth, adm.app, "IT", itLegacyApprover.acc.app, null, 0,
            "Admin retired attempt", `retire-adm-${seq++}`, sha256(`retire-adm-${adm.app}`),
          ]),
        (err) => err?.code === "PT409" && String(err?.message).includes("LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN"),
      );
    }
    const { rows: [auditAfterRetire] } = await observer.query(`
      select (select count(*)::int from public.leave_department_approvers) as da_cnt,
             (select count(*)::int from public.leave_audit_events) as audit_cnt,
             (select count(*)::int from public.leave_idempotency_records) as idem_cnt
    `);
    assert.deepEqual(auditAfterRetire, auditBeforeRetire, "Retired legacy RPC must perform zero writes");

    // 5c. direct_entry_authz_get_account_groups_admin: DEPARTMENT_HEAD for active Org Heads only; never LEAVE_DEPARTMENT_APPROVER
    const tu2Groups = await serviceRpc(setup, "direct_entry_authz_get_account_groups_admin", [
      OWNER.auth, OWNER.app, mktHeadTu2.acc.app,
    ]);
    assert.deepEqual(
      tu2Groups.resource_assignments.filter((a) => a.assignment_kind === "DEPARTMENT_HEAD"),
      [{ assignment_kind: "DEPARTMENT_HEAD", resource_ref: deptByKey.MARKETING, resource_label: deptNameByKey.MARKETING }],
    );

    for (const nonHead of [mktHeadTu, itLegacyApprover, acctLegacyApprover, mktEmp]) {
      const grp = await serviceRpc(setup, "direct_entry_authz_get_account_groups_admin", [
        OWNER.auth, OWNER.app, nonHead.acc.app,
      ]);
      assert.equal(
        grp.resource_assignments.some((a) => a.assignment_kind === "DEPARTMENT_HEAD" || a.assignment_kind === "LEAVE_DEPARTMENT_APPROVER"),
        false,
        `${nonHead.acc.login} must have neither DEPARTMENT_HEAD nor LEAVE_DEPARTMENT_APPROVER`,
      );
    }
    assert.equal(
      tu2Groups.resource_assignments.some((a) => a.assignment_kind === "LEAVE_DEPARTMENT_APPROVER"),
      false,
    );
    assert.ok(mktHeadAssignTu2.active_head.head_assignment_id);
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
