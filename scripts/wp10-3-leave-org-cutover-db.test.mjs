/**
 * WP10-3 — Leave & Attendance Explanation Org Cutover Real PG18 Before/After Acceptance Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated PostgreSQL 18 cluster.
 * Verifies Before (0..240 ending at `20261125120000`) vs After (applying `241` `20261125150000`) across ALL 6 personas:
 *   1. RECRUITMENT (Team Leader + ordinary member)
 *   2. MARKETING (ordinary member + #32 cross-department Recruitment TL)
 *   3. IT
 *   4. ACCOUNTING
 *   5. Custom Org department (`OPERATIONS`, `system_key IS NULL`, active head)
 *   6. Missing Org link (stale `unit_kind = 'MARKETING'`) + linked-missing-dept + INACTIVE Org person + UNCONFIGURED profile
 *
 * Covers:
 *   - Balance summary (`leave_management_get_my_summary` / `_compute_balance_summary`)
 *   - Monthly report (`leave_management_monthly_report` filtering, row projection, `org_department`)
 *   - Admin overview (`leave_management_get_admin_overview` + `org_department`)
 *   - Leave create & Attendance Explanation submit/overview (shared `_resolve_routing_snapshot` + strict TS projection)
 *   - Profile upsert (`p_unit_kind = null` & conflicting legacy `p_unit_kind`), direct SQL guard trigger, and Org transfer sync
 *   - Pre-cutover PENDING Leave requests & Attendance Explanations snapshot/approver preservation
 *   - #32 project-scoped Direct Entry & TL reporting isolation non-regression
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

import { projectAttendanceMyExplanationsOverview, projectSubmitAttendanceExplanationResult } from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
  computeEndPersonMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  computeCreatePersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUpdatePersonFingerprint,
} from "../src/lib/organization/person-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const CROSS_DEPT_MIGRATION_NAME = "20261125120000_cross_department_recruitment_guards.sql";
const WP10_3_MIGRATION_NAME = "20261125150000_wp10_3_leave_org_department_cutover.sql";

const OWNER = {
  auth: "40100000-0000-4000-8000-00000000a001",
  app: "40100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-3",
};
const LUANPT = {
  auth: "40100000-0000-4000-8000-00000000a002",
  app: "40100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "40100000-0000-4000-8000-00000000a003",
  app: "40100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "40100000-0000-4000-8000-00000000a004",
  app: "40100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `40110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
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

function makeFullProfileRow({ projectId, recruiterId, code, name, cccd, firstWorkDate }) {
  return {
    project_id: projectId,
    first_work_date: firstWorkDate,
    employee_code: code,
    recruiter_id: recruiterId,
    labor_type: "TEMPORARY",
    display_name: name,
    worker_details: {
      gender: { state: "provided", value: "OTHER" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: cccd },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
  };
}

test("WP10-3 Leave Org Cutover (PG18): Before vs After across all 6 personas, profile guards, PENDING preservation & #32 non-regression", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-3-cutover-pg18-"));
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

    const setup = await connect(port, "wp10-3-setup");
    const observer = await connect(port, "wp10-3-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const crossDeptIdx = files.indexOf(CROSS_DEPT_MIGRATION_NAME);
    const wp103Idx = files.indexOf(WP10_3_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(crossDeptIdx > groupsIdx, "PR #32 cross-dept migration must exist");
    assert.equal(wp103Idx, crossDeptIdx + 1, "WP10-3 migration must immediately follow 20261125120000");

    // -------------------------------------------------------------------------
    // Phase 0: Apply 0..240 (BEFORE 20261125150000)
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

    for (let i = groupsIdx; i <= crossDeptIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as today_vn
      )
      select today_vn::text,
             (today_vn - 1)::text as yesterday_vn,
             to_char(today_vn, 'YYYY-MM') as ym,
             extract(year from today_vn)::int as leave_year,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then date_trunc('month', today_vn)::date
                 else (date_trunc('month', today_vn)::date + 10)
               end
             )::text as d1,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then (date_trunc('month', today_vn)::date + 1)
                 else (date_trunc('month', today_vn)::date + 11)
               end
             )::text as d2,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then (date_trunc('month', today_vn)::date + 2)
                 else (date_trunc('month', today_vn)::date + 12)
               end
             )::text as d3
        from d
    `);
    await setBusinessDate(setup, dates.today_vn);

    // Seed projects, teams (`rec_team`, `marketing`), project-team scopes, banks
    const TEAM_REC = nextUuid();
    const TEAM_MKT = nextUuid();
    const PRJ_1 = "wp10-3-prj-1";
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'rec_team', 'Recruitment Alpha', true, 1),
              ($2::uuid, 'marketing', 'Marketing Rec Team', true, 1)`,
      [TEAM_REC, TEAM_MKT],
    );
    await setup.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project WP10-3', true)",
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
      "select department_id, system_key from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING')",
    );
    const deptByKey = Object.fromEntries(sysDeptRows.map((d) => [d.system_key, d.department_id]));
    assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.IT && deptByKey.ACCOUNTING);

    // Create custom Org department OPERATIONS (system_key IS NULL)
    const opsCreate = await serviceRpc(setup, "org_department_create_department_admin", [
      OWNER.auth,
      OWNER.app,
      "OPERATIONS",
      "Phòng Vận hành",
      "Tạo phòng ban tùy chỉnh OPERATIONS",
      nextUuid(),
      computeCreateDepartmentFingerprint({
        actor_app_user_id: OWNER.app,
        code: "OPERATIONS",
        name: "Phòng Vận hành",
        reason: "Tạo phòng ban tùy chỉnh OPERATIONS",
      }),
    ]);
    const opsDeptId = opsCreate.department.department_id;

    async function onboardOrgUser(tag, deptId, { withRecruiter = false, position = "STAFF", teamId = null } = {}) {
      const acc = await seedPlainAccount(setup, `wp103.${tag}`, `User ${tag}`);
      const empCode = `EMP-W3-${tag.toUpperCase()}`;
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
      const { rows: [pRef] } = await observer.query("select version from public.organization_persons where person_id = $1::uuid", [p.person_id]);
      return { acc, person: { ...p, version: pRef.version }, recruiterId };
    }

    async function designateDeptHead(deptId, personId, label) {
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
        null,
        label,
        nextUuid(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: deptId,
          person_id: personId,
          expected_department_version: dRow.version,
          expected_current_head_assignment_id: null,
          reason: label,
        }),
      ]);
    }

    async function upsertLeaveProfile(targetAppId, unitKind, expectedVersion = 0, reason = "Seed leave profile") {
      return serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
        OWNER.auth,
        OWNER.app,
        targetAppId,
        "OFFICIAL",
        unitKind,
        "2025-01-01",
        "2025-03-01",
        null,
        0,
        expectedVersion,
        reason,
        `seed-lp-${seq++}`,
        sha256(`seed-lp-${targetAppId}-${seq}`),
      ]);
    }

    // Seed all 6 personas BEFORE 20261125150000:
    // 1. RECRUITMENT (TL + Member)
    const recTl = await onboardOrgUser("rectl", deptByKey.RECRUITMENT, { withRecruiter: true, position: "TEAM_LEADER", teamId: TEAM_REC });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_REC, recTl.acc.app, null, 1, "Designate Rec TL", nextUuid(),
    ]);
    const recMember = await onboardOrgUser("recmem", deptByKey.RECRUITMENT, { withRecruiter: true, teamId: TEAM_REC });

    // 2. MARKETING (Head + Member + #32 cross-dept Recruitment TL on `marketing` team)
    const mktHead = await onboardOrgUser("mkthead", deptByKey.MARKETING);
    await designateDeptHead(deptByKey.MARKETING, mktHead.person.person_id, "Set MKT Head");
    const mktMember = await onboardOrgUser("mktmem", deptByKey.MARKETING, { withRecruiter: true, teamId: TEAM_MKT });
    const mktCrossTl = await onboardOrgUser("mktcrosstl", deptByKey.MARKETING, { withRecruiter: true, position: "TEAM_LEADER", teamId: TEAM_MKT });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_MKT, mktCrossTl.acc.app, null, 1, "Designate Cross-Dept MKT TL", nextUuid(),
    ]);

    // 3. IT (Head + Member)
    const itHead = await onboardOrgUser("ithead", deptByKey.IT);
    await designateDeptHead(deptByKey.IT, itHead.person.person_id, "Set IT Head");
    const itMember = await onboardOrgUser("itmem", deptByKey.IT);

    // 4. ACCOUNTING (Head + Member)
    const acctHead = await onboardOrgUser("accthead", deptByKey.ACCOUNTING);
    await designateDeptHead(deptByKey.ACCOUNTING, acctHead.person.person_id, "Set ACCT Head");
    const acctMember = await onboardOrgUser("acctmem", deptByKey.ACCOUNTING);

    // 5. Custom Org department OPERATIONS (Head + Member)
    const opsHead = await onboardOrgUser("opshead", opsDeptId);
    await designateDeptHead(opsDeptId, opsHead.person.person_id, "Set OPS Head");
    const opsMember = await onboardOrgUser("opsmem", opsDeptId);

    // 6. Edge personas:
    // 6a. Missing Org link with stale unit_kind = 'MARKETING' (allowed BEFORE 241)
    const unlinkedStaleMkt = await seedPlainAccount(setup, "wp103.unlinkedmkt", "Unlinked Stale MKT");
    // 6b. Linked active Person with NO active dept membership
    const linkedNoDept = await onboardOrgUser("linkednodept", deptByKey.MARKETING);
    // 6c. Linked INACTIVE Person (stale unit_kind = 'MARKETING' retained in table)
    const linkedInactive = await onboardOrgUser("linkedinactive", deptByKey.MARKETING);
    // 6d. UNCONFIGURED profile (linked to MARKETING, no leave_employee_profiles row)
    const unconfiguredMkt = await onboardOrgUser("unconfmkt", deptByKey.MARKETING);

    for (const [acc, uk] of [
      [recTl.acc, "RECRUITMENT"],
      [recMember.acc, "RECRUITMENT"],
      [mktHead.acc, "MARKETING"],
      [mktMember.acc, "MARKETING"],
      [mktCrossTl.acc, "MARKETING"],
      [itHead.acc, "IT"],
      [itMember.acc, "IT"],
      [acctHead.acc, "ACCOUNTING"],
      [acctMember.acc, "ACCOUNTING"],
      [opsHead.acc, "UNCLASSIFIED"],
      [opsMember.acc, "UNCLASSIFIED"],
      [unlinkedStaleMkt, "MARKETING"],
      [linkedNoDept.acc, "MARKETING"],
      [linkedInactive.acc, "MARKETING"],
    ]) {
      await upsertLeaveProfile(acc.app, uk, 0, `Before cutover profile ${uk}`);
    }

    // End linkedNoDept's department membership & set linkedInactive person to INACTIVE
    await serviceRpc(setup, "org_department_end_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      deptByKey.MARKETING,
      linkedNoDept.person.active_department.membership_id,
      linkedNoDept.person.version,
      "Remove dept membership",
      nextUuid(),
      computeEndPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.MARKETING,
        membership_id: linkedNoDept.person.active_department.membership_id,
        expected_person_version: linkedNoDept.person.version,
        reason: "Remove dept membership",
      }),
    ]);
    await serviceRpc(setup, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      linkedInactive.person.person_id,
      linkedInactive.person.version,
      linkedInactive.person.employee_code,
      linkedInactive.person.full_name,
      "2025-01-01",
      "INACTIVE",
      "Deactivate Org person",
      nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, linkedInactive.person.person_id, {
        expected_person_version: linkedInactive.person.version,
        employee_code: linkedInactive.person.employee_code,
        full_name: linkedInactive.person.full_name,
        joined_on: "2025-01-01",
        status: "INACTIVE",
        reason: "Deactivate Org person",
      }),
    ]);

    // -------------------------------------------------------------------------
    // BEFORE (0..240) Assertions & Pre-Cutover PENDING Requests/Explanations
    // -------------------------------------------------------------------------
    const beforeUnlinkedSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      unlinkedStaleMkt.auth,
      unlinkedStaleMkt.app,
      dates.leave_year,
    ]);
    assert.equal(beforeUnlinkedSummary.balance.unit_kind, "MARKETING", "BEFORE 241: unlinked profile uses legacy unit_kind");
    assert.equal(beforeUnlinkedSummary.routing.unit_kind, "MARKETING");
    assert.equal(beforeUnlinkedSummary.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(beforeUnlinkedSummary.routing.primary_approver_app_user_id, mktHead.acc.app);
    assert.equal("org_department" in beforeUnlinkedSummary, false, "BEFORE 241: org_department not present yet");

    const beforeMonthlyMkt = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth,
      OWNER.app,
      dates.ym,
      "MARKETING",
      null,
      200,
      0,
    ]);
    assert.equal(
      beforeMonthlyMkt.rows.some((r) => r.app_user_id === unlinkedStaleMkt.app),
      true,
      "BEFORE 241: monthly_report(MARKETING) still includes unlinked stale MARKETING profile",
    );

    // Create pre-cutover PENDING Leave requests & Attendance Explanations (on unlinkedStaleMkt, mktCrossTl, opsMember)
    const preUnlinkedLeave = await serviceRpc(setup, "leave_management_create_request", [
      unlinkedStaleMkt.auth,
      unlinkedStaleMkt.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-cutover unlinked legacy MARKETING leave",
      `pre-unl-l-${seq++}`,
      sha256("pre-unl-l"),
    ]);
    assert.equal(preUnlinkedLeave.request.unit_kind_snapshot, "MARKETING");
    assert.equal(preUnlinkedLeave.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(preUnlinkedLeave.request.primary_approver_app_user_id, mktHead.acc.app);

    const preUnlinkedExp = await serviceRpc(setup, "attendance_submit_explanation", [
      unlinkedStaleMkt.auth,
      unlinkedStaleMkt.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-cutover unlinked legacy MARKETING explanation",
      nextUuid(),
      sha256("pre-unl-e"),
    ]);
    assert.equal(preUnlinkedExp.explanation.route_kind, "DEPARTMENT_HEAD");
    assert.equal(preUnlinkedExp.explanation.primary_approver.app_user_id, mktHead.acc.app);

    const preCrossTlLeave = await serviceRpc(setup, "leave_management_create_request", [
      mktCrossTl.acc.auth,
      mktCrossTl.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-cutover cross-dept TL leave",
      `pre-ctl-l-${seq++}`,
      sha256("pre-ctl-l"),
    ]);
    assert.equal(preCrossTlLeave.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(preCrossTlLeave.request.primary_approver_app_user_id, mktHead.acc.app);

    const preCrossTlExp = await serviceRpc(setup, "attendance_submit_explanation", [
      mktCrossTl.acc.auth,
      mktCrossTl.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-cutover cross-dept TL explanation",
      nextUuid(),
      sha256("pre-ctl-e"),
    ]);
    assert.equal(preCrossTlExp.explanation.primary_approver.app_user_id, mktHead.acc.app);

    const preOpsLeave = await serviceRpc(setup, "leave_management_create_request", [
      opsMember.acc.auth,
      opsMember.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-cutover custom OPS leave",
      `pre-ops-l-${seq++}`,
      sha256("pre-ops-l"),
    ]);
    assert.equal(preOpsLeave.request.unit_kind_snapshot, "UNCLASSIFIED");
    assert.equal(preOpsLeave.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(preOpsLeave.request.primary_approver_app_user_id, opsHead.acc.app);

    const preOpsExp = await serviceRpc(setup, "attendance_submit_explanation", [
      opsMember.acc.auth,
      opsMember.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-cutover custom OPS explanation",
      nextUuid(),
      sha256("pre-ops-e"),
    ]);
    assert.equal(preOpsExp.explanation.primary_approver.app_user_id, opsHead.acc.app);

    // Record exact pre-cutover PENDING snapshots from DB tables
    const { rows: prePendingLeaveRows } = await observer.query(
      `select request_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.leave_requests
        where request_id = any($1::uuid[])
        order by request_id`,
      [[preUnlinkedLeave.request.request_id, preCrossTlLeave.request.request_id, preOpsLeave.request.request_id]],
    );
    const { rows: prePendingExpRows } = await observer.query(
      `select explanation_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.attendance_explanations
        where explanation_id = any($1::uuid[])
        order by explanation_id`,
      [[preUnlinkedExp.explanation.explanation_id, preCrossTlExp.explanation.explanation_id, preOpsExp.explanation.explanation_id]],
    );

    // -------------------------------------------------------------------------
    // Phase 1: Apply 241 (`20261125150000_wp10_3_leave_org_department_cutover.sql`)
    // -------------------------------------------------------------------------
    await setup.query(await readFile(path.join(MIGRATION_DIR, WP10_3_MIGRATION_NAME), "utf8"));

    // -------------------------------------------------------------------------
    // Phase 2: AFTER Cutover Verification across ALL 6 personas
    // -------------------------------------------------------------------------
    // 2a. Balance Summary + org_department across all 6 personas
    const personaExpectations = [
      { label: "RECRUITMENT member", user: recMember.acc, unitKind: "RECRUITMENT", routeKind: "TEAM_LEADER", approver: recTl.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.RECRUITMENT, deptSysKey: "RECRUITMENT", configured: true },
      { label: "RECRUITMENT TL", user: recTl.acc, unitKind: "RECRUITMENT", routeKind: "ADMIN_BOD_DIRECT", approver: null, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.RECRUITMENT, deptSysKey: "RECRUITMENT", configured: true },
      { label: "MARKETING member", user: mktMember.acc, unitKind: "MARKETING", routeKind: "DEPARTMENT_HEAD", approver: mktHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.MARKETING, deptSysKey: "MARKETING", configured: true },
      { label: "MARKETING cross-dept TL (#32)", user: mktCrossTl.acc, unitKind: "MARKETING", routeKind: "DEPARTMENT_HEAD", approver: mktHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.MARKETING, deptSysKey: "MARKETING", configured: true },
      { label: "IT member", user: itMember.acc, unitKind: "IT", routeKind: "DEPARTMENT_HEAD", approver: itHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.IT, deptSysKey: "IT", configured: true },
      { label: "ACCOUNTING member", user: acctMember.acc, unitKind: "ACCOUNTING", routeKind: "DEPARTMENT_HEAD", approver: acctHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.ACCOUNTING, deptSysKey: "ACCOUNTING", configured: true },
      { label: "Custom OPERATIONS member", user: opsMember.acc, unitKind: "UNCLASSIFIED", routeKind: "DEPARTMENT_HEAD", approver: opsHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: opsDeptId, deptSysKey: null, deptCode: "OPERATIONS", configured: true },
      { label: "Unlinked stale MARKETING", user: unlinkedStaleMkt, unitKind: "UNCLASSIFIED", routeKind: "ADMIN_BOD_FALLBACK", approver: null, hasLink: false, personStatus: null, deptId: null, deptSysKey: null, configured: true },
      { label: "Linked missing dept", user: linkedNoDept.acc, unitKind: "UNCLASSIFIED", routeKind: "ADMIN_BOD_FALLBACK", approver: null, hasLink: true, personStatus: "ACTIVE", deptId: null, deptSysKey: null, configured: true },
      { label: "Linked INACTIVE person", user: linkedInactive.acc, unitKind: "UNCLASSIFIED", routeKind: "ADMIN_BOD_FALLBACK", approver: null, hasLink: true, personStatus: "INACTIVE", deptId: null, deptSysKey: null, configured: true },
      { label: "UNCONFIGURED MARKETING", user: unconfiguredMkt.acc, unitKind: "MARKETING", routeKind: "DEPARTMENT_HEAD", approver: mktHead.acc.app, hasLink: true, personStatus: "ACTIVE", deptId: deptByKey.MARKETING, deptSysKey: "MARKETING", configured: false },
    ];

    for (const exp of personaExpectations) {
      const summary = await serviceRpc(setup, "leave_management_get_my_summary", [
        exp.user.auth,
        exp.user.app,
        dates.leave_year,
      ]);
      assert.equal(summary.balance.unit_kind, exp.unitKind, `${exp.label}: balance.unit_kind`);
      assert.equal(summary.balance.profile_configured, exp.configured, `${exp.label}: profile_configured`);
      assert.equal(summary.routing.unit_kind, exp.unitKind, `${exp.label}: routing.unit_kind`);
      assert.equal(summary.routing.route_kind, exp.routeKind, `${exp.label}: routing.route_kind`);
      assert.equal(summary.routing.primary_approver_app_user_id, exp.approver, `${exp.label}: approver`);
      assert.equal(summary.org_department.has_active_person_link, exp.hasLink, `${exp.label}: has_active_person_link`);
      assert.equal(summary.org_department.person_status, exp.personStatus, `${exp.label}: person_status`);
      assert.equal(summary.org_department.department_id, exp.deptId, `${exp.label}: department_id`);
      assert.equal(summary.org_department.department_system_key, exp.deptSysKey, `${exp.label}: department_system_key`);
      if (exp.deptCode) {
        assert.equal(summary.org_department.department_code, exp.deptCode, `${exp.label}: department_code`);
      }

      // Attendance Explanation overview must also pass strict TS projection
      const attOverviewRaw = await serviceRpc(setup, "attendance_get_my_explanations_overview", [
        exp.user.auth,
        exp.user.app,
        dates.yesterday_vn,
        20,
        0,
      ]);
      const attOverview = projectAttendanceMyExplanationsOverview(attOverviewRaw);
      assert.ok(attOverview, `${exp.label}: strict TS attendance_get_my_explanations_overview projection`);
      assert.equal(attOverview.routing.route_kind, exp.routeKind, `${exp.label}: att overview route_kind`);
      assert.equal(attOverview.routing.unit_kind, exp.unitKind, `${exp.label}: att overview unit_kind`);
      assert.equal(attOverview.routing.primary_approver?.app_user_id ?? null, exp.approver, `${exp.label}: att overview approver`);
    }

    // Prove unlinkedStaleMkt's balance math (granted/available/reserved/pending) is 100% preserved after cutover
    const afterUnlinkedSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      unlinkedStaleMkt.auth,
      unlinkedStaleMkt.app,
      dates.leave_year,
    ]);
    assert.equal(afterUnlinkedSummary.balance.total_granted_units, preUnlinkedLeave.balance.total_granted_units);
    assert.equal(afterUnlinkedSummary.balance.available_units, preUnlinkedLeave.balance.available_units);
    assert.equal(afterUnlinkedSummary.balance.reserved_units, preUnlinkedLeave.balance.reserved_units);
    assert.equal(afterUnlinkedSummary.balance.pending_annual_units, preUnlinkedLeave.balance.pending_annual_units);
    assert.equal(afterUnlinkedSummary.balance.pending_annual_units, 1);

    // 2b. Monthly report filtering & row fields + org_department
    const afterMonthlyMkt = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "MARKETING", null, 200, 0,
    ]);
    const mktIds = new Set(afterMonthlyMkt.rows.map((r) => r.app_user_id));
    assert.equal(mktIds.has(mktMember.acc.app), true);
    assert.equal(mktIds.has(mktCrossTl.acc.app), true);
    assert.equal(mktIds.has(unconfiguredMkt.acc.app), true);
    assert.equal(mktIds.has(unlinkedStaleMkt.app), false, "AFTER 241: monthly_report(MARKETING) MUST exclude unlinked stale MARKETING");
    assert.equal(mktIds.has(linkedNoDept.acc.app), false, "AFTER 241: monthly_report(MARKETING) MUST exclude linked-missing-dept");
    assert.equal(mktIds.has(linkedInactive.acc.app), false, "AFTER 241: monthly_report(MARKETING) MUST exclude INACTIVE person");

    const afterMonthlyUnclassified = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "UNCLASSIFIED", null, 200, 0,
    ]);
    const unclassMap = new Map(afterMonthlyUnclassified.rows.map((r) => [r.app_user_id, r]));
    for (const uid of [opsMember.acc.app, unlinkedStaleMkt.app, linkedNoDept.acc.app, linkedInactive.acc.app]) {
      assert.equal(unclassMap.has(uid), true, `AFTER 241: monthly_report(UNCLASSIFIED) must include ${uid}`);
      assert.equal(unclassMap.get(uid).unit_kind, "UNCLASSIFIED");
    }
    assert.equal(unclassMap.get(opsMember.acc.app).org_department.department_id, opsDeptId);
    assert.equal(unclassMap.get(opsMember.acc.app).org_department.department_code, "OPERATIONS");
    assert.equal(unclassMap.get(unlinkedStaleMkt.app).org_department.has_active_person_link, false);

    for (const [filterKey, expectedId] of [
      ["RECRUITMENT", recMember.acc.app],
      ["IT", itMember.acc.app],
      ["ACCOUNTING", acctMember.acc.app],
    ]) {
      const rep = await serviceRpc(setup, "leave_management_monthly_report", [
        OWNER.auth, OWNER.app, dates.ym, filterKey, null, 200, 0,
      ]);
      const row = rep.rows.find((r) => r.app_user_id === expectedId);
      assert.ok(row, `monthly_report(${filterKey}) must contain ${expectedId}`);
      assert.equal(row.unit_kind, filterKey);
      assert.equal(row.org_department.department_system_key, filterKey);
    }

    // 2c. Admin overview + org_department
    const adminOverview = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ALL",
    ]);
    const empMap = new Map(adminOverview.employees.map((e) => [e.account.app_user_id, e]));
    assert.equal(empMap.get(unlinkedStaleMkt.app).profile.unit_kind, "UNCLASSIFIED");
    assert.equal(empMap.get(unlinkedStaleMkt.app).org_department.has_active_person_link, false);
    assert.equal(empMap.get(linkedInactive.acc.app).profile.unit_kind, "UNCLASSIFIED");
    assert.equal(empMap.get(linkedInactive.acc.app).org_department.person_status, "INACTIVE");
    assert.equal(empMap.get(opsMember.acc.app).profile.unit_kind, "UNCLASSIFIED");
    assert.equal(empMap.get(opsMember.acc.app).org_department.department_code, "OPERATIONS");
    assert.equal(empMap.get(unconfiguredMkt.acc.app).profile.employment_status, "UNCONFIGURED");
    assert.equal(empMap.get(unconfiguredMkt.acc.app).profile.unit_kind, "MARKETING");
    assert.equal(empMap.get(unconfiguredMkt.acc.app).org_department.department_system_key, "MARKETING");

    // 2d. NEW Leave Request & NEW Attendance Explanation routing AFTER 241
    const postNewLeaveChecks = [
      { user: recMember.acc, unit: "RECRUITMENT", route: "TEAM_LEADER", approver: recTl.acc.app, deptId: null },
      { user: recTl.acc, unit: "RECRUITMENT", route: "ADMIN_BOD_DIRECT", approver: null, deptId: null },
      { user: mktCrossTl.acc, unit: "MARKETING", route: "DEPARTMENT_HEAD", approver: mktHead.acc.app, deptId: deptByKey.MARKETING },
      { user: itMember.acc, unit: "IT", route: "DEPARTMENT_HEAD", approver: itHead.acc.app, deptId: deptByKey.IT },
      { user: acctMember.acc, unit: "ACCOUNTING", route: "DEPARTMENT_HEAD", approver: acctHead.acc.app, deptId: deptByKey.ACCOUNTING },
      { user: opsMember.acc, unit: "UNCLASSIFIED", route: "DEPARTMENT_HEAD", approver: opsHead.acc.app, deptId: opsDeptId },
      { user: unlinkedStaleMkt, unit: "UNCLASSIFIED", route: "ADMIN_BOD_FALLBACK", approver: null, deptId: null },
      { user: linkedNoDept.acc, unit: "UNCLASSIFIED", route: "ADMIN_BOD_FALLBACK", approver: null, deptId: null },
      { user: linkedInactive.acc, unit: "UNCLASSIFIED", route: "ADMIN_BOD_FALLBACK", approver: null, deptId: null },
      { user: unconfiguredMkt.acc, unit: "MARKETING", route: "DEPARTMENT_HEAD", approver: mktHead.acc.app, deptId: deptByKey.MARKETING },
    ];

    for (const c of postNewLeaveChecks) {
      const lRes = await serviceRpc(setup, "leave_management_create_request", [
        c.user.auth,
        c.user.app,
        JSON.stringify([{ leave_date: dates.d2, session_code: "AM", leave_type: "UNPAID" }]),
        `Post-cutover leave (${c.unit})`,
        `post-l-${c.user.app}-${seq++}`,
        sha256(`post-l-${c.user.app}-${seq}`),
      ]);
      assert.equal(lRes.request.unit_kind_snapshot, c.unit, `post leave unit_kind_snapshot for ${c.user.login}`);
      assert.equal(lRes.request.route_kind, c.route, `post leave route_kind for ${c.user.login}`);
      assert.equal(lRes.request.primary_approver_app_user_id, c.approver, `post leave approver for ${c.user.login}`);
      const { rows: [lDb] } = await observer.query(
        "select routed_department_id::text from public.leave_requests where request_id = $1::uuid",
        [lRes.request.request_id],
      );
      assert.equal(lDb.routed_department_id, c.deptId, `post leave routed_department_id for ${c.user.login}`);

      const eRaw = await serviceRpc(setup, "attendance_submit_explanation", [
        c.user.auth,
        c.user.app,
        dates.yesterday_vn,
        "SLOT_2",
        `Post-cutover exp (${c.unit})`,
        nextUuid(),
        sha256(`post-e-${c.user.app}-${seq}`),
      ]);
      const eProj = projectSubmitAttendanceExplanationResult(eRaw);
      assert.ok(eProj, `strict TS submit explanation projection for ${c.user.login}`);
      assert.equal(eProj.explanation.route_kind, c.route, `post exp route_kind for ${c.user.login}`);
      assert.equal(eProj.explanation.primary_approver?.app_user_id ?? null, c.approver, `post exp approver for ${c.user.login}`);
      const { rows: [eDb] } = await observer.query(
        "select unit_kind_snapshot, routed_department_id::text from public.attendance_explanations where explanation_id = $1::uuid",
        [eProj.explanation.explanation_id],
      );
      assert.equal(eDb.unit_kind_snapshot, c.unit, `post exp unit_kind_snapshot for ${c.user.login}`);
      assert.equal(eDb.routed_department_id, c.deptId, `post exp routed_department_id for ${c.user.login}`);
    }

    // 2e. Profile save via leave_management_upsert_employee_profile_admin + direct SQL guard + Org transfer sync
    // Unconfigured Marketing user saved with p_unit_kind = null -> becomes OFFICIAL with MARKETING
    const saveUnconf = await serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
      OWNER.auth, OWNER.app, unconfiguredMkt.acc.app, "OFFICIAL", null,
      "2024-02-01", "2024-04-01", "2029-02-01", 2, 0,
      "Save unconfigured without p_unit_kind", `save-unconf-${seq++}`, sha256("save-unconf"),
    ]);
    assert.equal(saveUnconf.profile.employment_status, "OFFICIAL");
    assert.equal(saveUnconf.profile.unit_kind, "MARKETING");
    assert.equal(saveUnconf.profile.work_start_date, "2024-02-01");
    assert.equal(saveUnconf.profile.official_effective_date, "2024-04-01");
    assert.equal(saveUnconf.profile.next_seniority_effective_date, "2029-02-01");
    assert.equal(saveUnconf.profile.next_seniority_units, 2);
    assert.equal(saveUnconf.profile.notes, "Save unconfigured without p_unit_kind");

    // Legacy caller sending conflicting p_unit_kind = 'IT' for Marketing Org user -> ignored, persists MARKETING!
    const mktVer = empMap.get(mktMember.acc.app).profile.row_version;
    const saveMktConflict = await serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
      OWNER.auth, OWNER.app, mktMember.acc.app, "OFFICIAL", "IT",
      "2024-06-01", "2024-08-01", "2029-06-01", 4, mktVer,
      "Legacy conflicting IT ignored for MARKETING", `save-mkt-conf-${seq++}`, sha256("save-mkt-conf"),
    ]);
    assert.equal(saveMktConflict.profile.unit_kind, "MARKETING", "p_unit_kind='IT' MUST NOT overwrite MARKETING Org");
    assert.equal(saveMktConflict.profile.next_seniority_units, 4);
    assert.equal(saveMktConflict.profile.notes, "Legacy conflicting IT ignored for MARKETING");

    // Legacy caller sending p_unit_kind = 'MARKETING' for unlinked user -> ignored, persists UNCLASSIFIED!
    const unlinkedVer = empMap.get(unlinkedStaleMkt.app).profile.row_version;
    const saveUnlinkedLegacy = await serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
      OWNER.auth, OWNER.app, unlinkedStaleMkt.app, "OFFICIAL", "MARKETING",
      "2025-01-01", "2025-03-01", null, 0, unlinkedVer,
      "Cannot revive legacy MARKETING on unlinked", `save-unl-revive-${seq++}`, sha256("save-unl-revive"),
    ]);
    assert.equal(saveUnlinkedLegacy.profile.unit_kind, "UNCLASSIFIED", "Cannot revive legacy MARKETING on unlinked profile");
    assert.equal(saveUnlinkedLegacy.profile.notes, "Cannot revive legacy MARKETING on unlinked");

    // Invalid p_unit_kind still rejected with LEAVE_PROFILE_INVALID
    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
          OWNER.auth, OWNER.app, mktMember.acc.app, "OFFICIAL", "INVALID_UNIT",
          "2024-06-01", "2024-08-01", null, 0, saveMktConflict.profile.row_version,
          "Invalid enum", `save-bogus-${seq++}`, sha256("save-bogus"),
        ]),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_INVALID"),
    );

    // Direct SQL UPDATE unit_kind on linked user & aligned INACTIVE linked user fails closed via trigger
    await assert.rejects(
      () =>
        setup.query("update public.leave_employee_profiles set unit_kind = 'IT' where app_user_id = $1::uuid", [
          mktMember.acc.app,
        ]),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );
    await assert.rejects(
      () =>
        setup.query("update public.leave_employee_profiles set unit_kind = 'MARKETING' where app_user_id = $1::uuid", [
          linkedInactive.acc.app,
        ]),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );

    // Org transfer MARKETING -> IT still syncs leave_employee_profiles.unit_kind = 'IT'
    const { rows: [mktMemOrg] } = await observer.query(
      `select p.version as pv, m.membership_id as mid
         from public.organization_persons p
         join public.organization_person_department_memberships m on m.person_id = p.person_id and m.ended_at is null
        where p.person_id = $1::uuid`,
      [mktMember.person.person_id],
    );
    await serviceRpc(setup, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      mktMember.person.person_id,
      deptByKey.IT,
      mktMemOrg.pv,
      mktMemOrg.mid,
      "Transfer mktMember MARKETING -> IT",
      nextUuid(),
      computeTransferPersonDepartmentFingerprint(OWNER.app, mktMember.person.person_id, {
        target_department_ref: deptByKey.IT,
        expected_person_version: mktMemOrg.pv,
        expected_current_membership_id: mktMemOrg.mid,
        reason: "Transfer mktMember MARKETING -> IT",
      }),
    ]);
    const { rows: [syncedRow] } = await observer.query(
      "select unit_kind from public.leave_employee_profiles where app_user_id = $1::uuid",
      [mktMember.acc.app],
    );
    assert.equal(syncedRow.unit_kind, "IT", "Org transfer must sync transitional leave_employee_profiles.unit_kind");

    // 2f. Pre-cutover PENDING Leave requests & Attendance Explanations 100% preserved & approvable!
    const { rows: postPendingLeaveRows } = await observer.query(
      `select request_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.leave_requests
        where request_id = any($1::uuid[])
        order by request_id`,
      [[preUnlinkedLeave.request.request_id, preCrossTlLeave.request.request_id, preOpsLeave.request.request_id]],
    );
    assert.deepEqual(postPendingLeaveRows, prePendingLeaveRows, "Pre-cutover PENDING Leave requests must remain 100% unchanged");

    const { rows: postPendingExpRows } = await observer.query(
      `select explanation_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.attendance_explanations
        where explanation_id = any($1::uuid[])
        order by explanation_id`,
      [[preUnlinkedExp.explanation.explanation_id, preCrossTlExp.explanation.explanation_id, preOpsExp.explanation.explanation_id]],
    );
    assert.deepEqual(postPendingExpRows, prePendingExpRows, "Pre-cutover PENDING Attendance Explanations must remain 100% unchanged");

    // Original approvers decide all 3 pre-cutover PENDING Leave requests & Attendance Explanations cleanly!
    for (const [approver, leaveReq, expRow, tag] of [
      [mktHead.acc, preUnlinkedLeave.request, preUnlinkedExp.explanation, "pre-unlinked"],
      [mktHead.acc, preCrossTlLeave.request, preCrossTlExp.explanation, "pre-cross-tl"],
      [opsHead.acc, preOpsLeave.request, preOpsExp.explanation, "pre-ops"],
    ]) {
      const decLeave = await serviceRpc(setup, "leave_management_decide_request", [
        approver.auth, approver.app, leaveReq.request_id, "APPROVE", 1,
        `Approve ${tag} leave post-cutover`, `dec-l-${tag}-${seq++}`, sha256(`dec-l-${tag}`),
      ]);
      assert.equal(decLeave.request.status, "APPROVED");

      const decExp = await serviceRpc(setup, "attendance_decide_explanation", [
        approver.auth, approver.app, expRow.explanation_id, "APPROVE", 1,
        `Approve ${tag} exp post-cutover`, nextUuid(), sha256(`dec-e-${tag}`),
      ]);
      assert.equal(decExp.explanation.status, "APPROVED");
    }

    // 2g. #32 project-scoped Direct Entry & TL non-regression after 241
    const recCat = await serviceRpc(setup, "direct_entry_input_catalog", [
      recMember.acc.auth, recMember.acc.app, dates.today_vn,
    ]);
    assert.equal(recCat.recruiters.some((r) => r.recruiter_id === mktCrossTl.recruiterId), true);
    assert.equal(recCat.recruiters.some((r) => r.recruiter_id === recMember.recruiterId), true);

    const mktDeBatch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      mktCrossTl.acc.auth,
      mktCrossTl.acc.app,
      "worker-profile/1.2",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_1,
          recruiterId: mktCrossTl.recruiterId,
          code: "hrp-2026-300001",
          name: "Worker MKT PostCutover",
          cccd: "079200003001",
          firstWorkDate: dates.today_vn,
        }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(setup, "direct_entry_transition_submission", [
      mktCrossTl.acc.auth, mktCrossTl.acc.app, mktDeBatch.submission_id, 1, "SUBMITTED", nextUuid(),
    ]);
    const recDeBatch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      recMember.acc.auth,
      recMember.acc.app,
      "worker-profile/1.2",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_1,
          recruiterId: recMember.recruiterId,
          code: "hrp-2026-300002",
          name: "Worker REC PostCutover",
          cccd: "079200003002",
          firstWorkDate: dates.today_vn,
        }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(setup, "direct_entry_transition_submission", [
      recMember.acc.auth, recMember.acc.app, recDeBatch.submission_id, 1, "SUBMITTED", nextUuid(),
    ]);

    const mktTlFacts = await serviceRpc(setup, "direct_entry_reporting_scoped_facts", [
      mktCrossTl.acc.auth, mktCrossTl.acc.app, JSON.stringify({}),
    ]);
    assert.equal(mktTlFacts.audience.audience, "team");
    assert.deepEqual(mktTlFacts.audience.team_ids, [TEAM_MKT]);
    assert.deepEqual(
      mktTlFacts.facts.map((f) => f.entry_id),
      [mktDeBatch.entry_ids[0]],
      "Cross-dept Marketing TL must remain scoped strictly to marketing team after WP10-3 cutover",
    );
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
