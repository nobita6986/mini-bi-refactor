/**
 * WP10-7 Slice 2A — Retire Live Dependencies on `leave_employee_profiles.unit_kind`
 * Real Isolated PostgreSQL 18 Upgrade (0..249 -> #250) & Concurrency Acceptance Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies ALL mandatory WP10-7 Slice 2A contract requirements:
 *   1. Pre-migration fixture at 249 baseline migrations (BEFORE #250):
 *      - IT, MARKETING, ACCOUNTING, custom departments (OPERATIONS & SALES, system_key IS NULL),
 *        disabled unlinked account with mismatched legacy `unit_kind = 'MARKETING'`,
 *        disabled linked IT account, unconfigured MARKETING account, and pre-migration
 *        PENDING Leave request + PENDING Attendance Explanation snapshots.
 *      - Captures pre-migration `leave_management_upsert_employee_profile_admin` response,
 *        Idempotency-Key, request_fingerprint, and audit count on IT member.
 *   2. Migration #250 upgrade (249 -> 250):
 *      - Preserves `leave_employee_profiles.unit_kind` column and 100% of stored values.
 *      - Drops `org_department__internal_sync_leave_profile_from_org`.
 *      - Zero live readers/writers of `leave_employee_profiles.unit_kind` or
 *        `app.org_leave_profile_sync` in PostgreSQL catalog (`pg_proc`, `pg_depend`).
 *      - Preserves S0-T1-C security & RPC ACL postconditions (+0 net public RPCs).
 *   3. Mandatory 409 Stale-Version Conflict Flow (IT <-> MARKETING):
 *      - Transfer IT -> MARKETING bumps `row_version` (`V0 -> V0 + 1`) while DB `unit_kind` stays `'IT'`.
 *      - Stale save (`V0`) rejects `PT409` / `LEAVE_ROW_VERSION_CONFLICT` (HTTP 409) with 0 profile/audit writes.
 *      - Reload (`get_admin_overview` -> `MARKETING`, `V0 + 1`) + save (`V0 + 1`) succeeds (`MARKETING` in response/audit, DB `'IT'`).
 *      - Transfer back MARKETING -> IT bumps `V0 + 2 -> V0 + 3`; stale save (`V0 + 2`) -> 409; reload + save succeeds (`IT`).
 *   4. Mandatory Same-Department Rename Non-Bump + Status ACTIVE <-> INACTIVE Bump:
 *      - `org_department_update_person_admin` changing `full_name` in same dept (`ACTIVE`) does NOT bump `row_version`.
 *      - Status `ACTIVE -> INACTIVE` and `INACTIVE -> ACTIVE` DO bump `row_version`.
 *   5. Remaining Org RPC classification change paths + PG18 Concurrency:
 *      - Custom dept transfer (`OPERATIONS -> SALES`, both `system_key IS NULL`) bumps `row_version`.
 *      - `org_department_unlink_account_person_admin` & `org_department_link_account_person_admin` bump `row_version`.
 *      - `org_department_end_person_member_admin` & `org_department_assign_person_member_admin` bump `row_version`.
 *      - `org_department_create_person_admin` linking existing account with profile bumps `row_version`.
 *      - `org_department_assign_accounting_member` & `org_department_end_accounting_member` (linked person) bump `row_version`.
 *      - Concurrent `org_department_transfer_person_member_admin` vs `leave_management_upsert_employee_profile_admin`
 *        (both lock-wait barrier orders + multi-trial `Promise.all` races): ZERO `40P01` deadlocks!
 *   6. Pre-migration Idempotency-Key replay AFTER department transfer:
 *      - Replaying pre-migration IT upsert key + fingerprint after IT -> MARKETING returns
 *        `replayed = true`, exact prior profile (`'IT'`, old `row_version`), ZERO new `leave_audit_events`.
 *   7. Disabled -> Re-enabled account + mismatched legacy `unit_kind` + new profile INSERT:
 *      - Re-enable disabled unlinked user (stored `'MARKETING'`) -> live flows return `'UNCLASSIFIED'`, DB stays `'MARKETING'`.
 *      - Link to IT -> `row_version` bumps, live flows return `'IT'`, DB stays `'MARKETING'`.
 *      - New profile INSERT for linked MARKETING user -> returns `'MARKETING'`, audit `'MARKETING'`, DB stays `'UNCLASSIFIED'`.
 *   8. Frozen-column guard trigger:
 *      - Direct SQL `UPDATE` setting `unit_kind = 'IT'`, `SET LOCAL app.org_leave_profile_sync = 'on'` + `UPDATE`,
 *        and direct SQL `INSERT` with `unit_kind = 'IT'` all fail with `22023` / `LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN`.
 *   9. Preserved pre-migration PENDING Leave & Explanation snapshots + approver DECIDE (`APPROVE`),
 *      balance math, routing, `monthly_report` filter, and `buildLeaveMonthlyReportXlsx` export.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { Client } from "pg";

import {
  projectAttendanceMyExplanationsOverview,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  computeAssignAccountingMemberFingerprint,
  computeAssignPersonMemberFingerprint,
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
  computeEndAccountingMemberFingerprint,
  computeEndPersonMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  leaveHttpStatusForError,
  parsePatchAdminConfigBody,
} from "../src/lib/leave/leave-contract.ts";
import { buildLeaveMonthlyReportXlsx } from "../src/lib/leave/leave-export.ts";
import { createLeaveRepository } from "../src/lib/leave/leave-repository.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUnlinkAccountPersonFingerprint,
  computeUpdatePersonFingerprint,
  projectTransferPersonDepartmentResponse,
} from "../src/lib/organization/person-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const LAST_BASELINE_MIGRATION_NAME =
  "20261126163000_hf_worker_edit_history_employee_code_substring.sql";
const WP10_7_2A_MIGRATION_NAME =
  "20261126190000_wp10_7_2a_stop_leave_profile_unit_kind_mirror.sql";

const OWNER = {
  auth: "94100000-0000-4000-8000-00000000a001",
  app: "94100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-2A",
};
const LUANPT = {
  auth: "94100000-0000-4000-8000-00000000a002",
  app: "94100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "94100000-0000-4000-8000-00000000a003",
  app: "94100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "94100000-0000-4000-8000-00000000a004",
  app: "94100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const UPSERT_LEAVE_PROFILE_SQL = `
  select public.leave_management_upsert_employee_profile_admin(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
    $6::date, $7::date, $8::date, $9::int, $10::int,
    $11::text, $12::text, $13::text
  ) as data
`;

const TRANSFER_PERSON_SQL = `
  select public.org_department_transfer_person_member_admin(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int,
    $6::uuid, $7::text, $8::uuid, $9::text
  ) as data
`;

let seq = 1;
function nextUuid() {
  return `94110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_7_2a_${prefix}_${seq++}`;
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

function runBin(file, args, { ignoreOutput = false } = {}) {
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
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'; set local role service_role",
  );
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpc(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
  const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
}

async function beginServiceTx(client) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'; set local role service_role",
  );
}

function settleInTx(client, queryPromise) {
  return queryPromise.then(
    async (value) => {
      await client.query("commit");
      return { status: "fulfilled", value };
    },
    async (reason) => {
      await client.query("rollback").catch(() => {});
      return { status: "rejected", reason };
    },
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select a.pid,
              a.application_name,
              a.wait_event_type,
              a.wait_event,
              l.locktype,
              l.mode,
              coalesce(l.relation::regclass::text, l.locktype) as relation_name
         from pg_stat_activity a
         join pg_locks l
           on l.pid = a.pid
          and l.granted = false
        where a.application_name = $1
          and a.state = 'active'
          and a.wait_event_type = 'Lock'
        limit 1`,
      [appName],
    );
    if (rows.length === 1) {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const { rows: snap } = await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event, left(query, 120) as query_prefix
       from pg_stat_activity
      where application_name = $1`,
    [appName],
  );
  throw new Error(`Timed out waiting for ${appName} to block on Lock. Snapshot: ${JSON.stringify(snap)}`);
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
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
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

test("WP10-7 Slice 2A (PG18): Retire live dependencies on leave_employee_profiles.unit_kind across 0..249 -> #250 upgrade & concurrency", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-2a-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
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

    const setup = await connect(port, "wp10-7-2a-setup");
    const observer = await connect(port, "wp10-7-2a-observer");
    const wH = await connect(port, "wp10-7-2a-wH");
    const w1 = await connect(port, "wp10-7-2a-w1");
    const w2 = await connect(port, "wp10-7-2a-w2");
    clients.push(setup, observer, wH, w1, w2);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const baselineCutoffIdx = files.indexOf(LAST_BASELINE_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.equal(baselineCutoffIdx, 248, "Expected 249 baseline migrations ending at 20261126163000");
    assert.equal(
      files.indexOf(WP10_7_2A_MIGRATION_NAME),
      baselineCutoffIdx + 1,
      `Expected ${WP10_7_2A_MIGRATION_NAME} immediately following ${LAST_BASELINE_MIGRATION_NAME}`,
    );

    // -------------------------------------------------------------------------
    // 1. Pre-Migration Fixture (at 249 migrations, BEFORE #250)
    // -------------------------------------------------------------------------
    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i <= baselineCutoffIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as today_vn
      ),
      workdays as (
        select gs::date as wd
          from d, generate_series(d.today_vn - 20, d.today_vn - 1, interval '1 day') as gs
         where extract(dow from gs) <> 0
         order by gs desc
      )
      select today_vn::text,
             (select wd::text from workdays limit 1) as yesterday_vn,
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
             )::text as d2
        from d
    `);
    await setBusinessDate(setup, dates.today_vn);

    const TEAM_REC = nextUuid();
    const PRJ_1 = "wp10-7-2a-prj-1";
    await setup.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'rec_2a', 'Recruitment 2A', true, 1)",
      [TEAM_REC],
    );
    await setup.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project WP10-7-2A', true)",
      [PRJ_1],
    );
    await setup.query(
      "insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)",
    );
    await setup.query(
      "insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id) values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)",
      [PRJ_1, TEAM_REC, OWNER.app],
    );

    const { rows: sysDeptRows } = await setup.query(
      "select department_id, system_key from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')",
    );
    const deptByKey = Object.fromEntries(sysDeptRows.map((d) => [d.system_key, d.department_id]));
    assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.IT && deptByKey.ACCOUNTING);

    async function createCustomDept(code, name) {
      const reason = `Create custom dept ${code}`;
      const res = await serviceRpc(setup, "org_department_create_department_admin", [
        OWNER.auth,
        OWNER.app,
        code,
        name,
        reason,
        nextUuid(),
        computeCreateDepartmentFingerprint({
          actor_app_user_id: OWNER.app,
          code,
          name,
          reason,
        }),
      ]);
      return res.department.department_id;
    }

    const opsDeptId = await createCustomDept("OPERATIONS", "Phòng Vận hành");
    const salesDeptId = await createCustomDept("SALES", "Phòng Kinh doanh");

    async function onboardOrgUser(tag, deptId, displayName) {
      const acc = await seedPlainAccount(setup, `wp1072a.${tag}`, displayName);
      const empCode = `EMP-72A-${tag.toUpperCase()}-${seq++}`;
      const p = (
        await serviceRpc(setup, "org_department_create_person_admin", [
          OWNER.auth,
          OWNER.app,
          empCode,
          acc.name,
          "2024-01-01",
          deptId,
          acc.app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: acc.name,
            joined_on: "2024-01-01",
            initial_department_ref: deptId,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ])
      ).person;
      const { rows: [pRef] } = await observer.query(
        "select version from public.organization_persons where person_id = $1::uuid",
        [p.person_id],
      );
      return { acc, person: { ...p, version: pRef.version } };
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

    async function upsertProfile(targetAppId, {
      status = "OFFICIAL",
      unitKind = null,
      workStart = "2024-01-01",
      officialDate = "2024-03-01",
      nextSenDate = null,
      nextSenUnits = 0,
      expectedRowVersion = 0,
      reason = "Seed leave profile",
      idemKey = nextKey("lp"),
      fingerprint = null,
    } = {}) {
      const fp = fingerprint ?? sha256(JSON.stringify({
        op: "UPSERT_EMPLOYEE_PROFILE",
        target_app_user_id: targetAppId.toLowerCase(),
        employment_status: status,
        unit_kind: unitKind ?? "UNCLASSIFIED",
        work_start_date: workStart,
        official_effective_date: officialDate,
        next_seniority_effective_date: nextSenDate,
        next_seniority_units: nextSenUnits,
        expected_row_version: expectedRowVersion,
        reason,
      }));
      return serviceRpc(
        setup,
        "leave_management_upsert_employee_profile_admin",
        [
          OWNER.auth,
          OWNER.app,
          targetAppId,
          status,
          unitKind,
          workStart,
          officialDate,
          nextSenDate,
          nextSenUnits,
          expectedRowVersion,
          reason,
          idemKey,
          fp,
        ],
        ["uuid", "uuid", "uuid", "text", "text", "date", "date", "date", "int", "int", "text", "text", "text"],
      );
    }

    // Seed all Org heads & members BEFORE #250
    const itHead = await onboardOrgUser("ithead", deptByKey.IT, "Trưởng phòng IT");
    await designateDeptHead(deptByKey.IT, itHead.person.person_id, "Designate IT Head");
    const itMember = await onboardOrgUser("itmem", deptByKey.IT, "Nhân sự IT");

    const mktHead = await onboardOrgUser("mkthead", deptByKey.MARKETING, "Trưởng phòng Marketing");
    await designateDeptHead(deptByKey.MARKETING, mktHead.person.person_id, "Designate MKT Head");
    const mktMember = await onboardOrgUser("mktmem", deptByKey.MARKETING, "Nhân sự Marketing");
    const mktNewUser = await onboardOrgUser("mktnew", deptByKey.MARKETING, "Nhân sự Marketing Mới");

    const acctHead = await onboardOrgUser("accthead", deptByKey.ACCOUNTING, "Trưởng phòng Kế toán");
    await designateDeptHead(deptByKey.ACCOUNTING, acctHead.person.person_id, "Designate ACCT Head");
    const acctMember = await onboardOrgUser("acctmem", deptByKey.ACCOUNTING, "Nhân sự Kế toán");

    const opsHead = await onboardOrgUser("opshead", opsDeptId, "Trưởng phòng Vận hành");
    await designateDeptHead(opsDeptId, opsHead.person.person_id, "Designate OPS Head");
    const opsMember = await onboardOrgUser("opsmem", opsDeptId, "Nhân sự Vận hành");
    const salesHead = await onboardOrgUser("saleshead", salesDeptId, "Trưởng phòng Kinh doanh");
    await designateDeptHead(salesDeptId, salesHead.person.person_id, "Designate SALES Head");

    // Disabled unlinked user with mismatched legacy unit_kind = 'MARKETING'
    const disabledUnlinkedMkt = await seedPlainAccount(setup, "wp1072a.disunlmkt", "Disabled Unlinked MKT");
    await upsertProfile(disabledUnlinkedMkt.app, { unitKind: "MARKETING", reason: "Pre-250 unlinked profile" });
    await setup.query(
      "update public.leave_employee_profiles set unit_kind = 'MARKETING' where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    // Verify BEFORE #250 that live flows ignore & do NOT overwrite legacy unit_kind = 'MARKETING'
    const preDisOverview = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ALL",
    ]);
    assert.equal(
      preDisOverview.employees.find((e) => e.account.app_user_id === disabledUnlinkedMkt.app).profile.unit_kind,
      "UNCLASSIFIED",
    );
    const preDisSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      disabledUnlinkedMkt.auth, disabledUnlinkedMkt.app, dates.leave_year,
    ]);
    assert.equal(preDisSummary.balance.unit_kind, "UNCLASSIFIED");
    const { rows: [preDisDb] } = await observer.query(
      "select unit_kind from public.leave_employee_profiles where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    assert.equal(preDisDb.unit_kind, "MARKETING");
    await serviceRpc(setup, "direct_entry_disable_app_user", [
      OWNER.auth, OWNER.app, disabledUnlinkedMkt.app, 1, "Disable unlinked legacy user", nextKey("dis_unl"),
    ]);

    // Disabled linked IT user
    const disabledLinkedIt = await onboardOrgUser("dislinkedit", deptByKey.IT, "Disabled Linked IT");
    await upsertProfile(disabledLinkedIt.acc.app, { unitKind: "IT", reason: "Pre-250 disabled IT profile" });
    await serviceRpc(setup, "direct_entry_disable_app_user", [
      OWNER.auth, OWNER.app, disabledLinkedIt.acc.app,
      disabledLinkedIt.person.active_account_link.account_version,
      "Disable linked IT user", nextKey("dis_it"),
    ]);

    // Additional fixtures for Requirement 5 & Concurrency
    const unlinkRelinkUser = await onboardOrgUser("unlinkrelink", deptByKey.MARKETING, "Unlink Relink User");
    const endAssignUser = await onboardOrgUser("endassign", deptByKey.MARKETING, "End Assign User");
    const createLinkExistingAcc = await seedPlainAccount(setup, "wp1072a.createlink", "Create Link Existing");
    const acctFlowUser = await onboardOrgUser("acctflow", deptByKey.MARKETING, "Accounting Flow User");
    const concRaceUser = await onboardOrgUser("concrace", deptByKey.IT, "Concurrency Race User");
    const concRecRaceUser = await onboardOrgUser("concrecrace", deptByKey.IT, "Concurrency Recruiter Race User");
    const concRecCp = await serviceRpc(setup, "direct_entry_account_operation_create_personnel", [
      OWNER.auth,
      OWNER.app,
      concRecRaceUser.acc.app,
      concRecRaceUser.person.active_account_link.account_version,
      concRecRaceUser.acc.login,
      "STAFF",
      null,
      "Create recruiter for AB-BA lock-order barrier",
      nextUuid(),
    ]);
    concRecRaceUser.recruiterId = concRecCp.recruiter_id;

    for (const acc of [
      itHead.acc,
      mktHead.acc,
      mktMember.acc,
      acctHead.acc,
      acctMember.acc,
      opsHead.acc,
      opsMember.acc,
      salesHead.acc,
      unlinkRelinkUser.acc,
      endAssignUser.acc,
      createLinkExistingAcc,
      acctFlowUser.acc,
      concRaceUser.acc,
      concRecRaceUser.acc,
    ]) {
      await upsertProfile(acc.app, { reason: "Pre-250 seed profile" });
    }

    // End acctFlowUser's initial dept membership so org_department_assign_accounting_member can attach ACCOUNTING cleanly
    await serviceRpc(setup, "org_department_end_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      deptByKey.MARKETING,
      acctFlowUser.person.active_department.membership_id,
      acctFlowUser.person.version,
      "Prepare acctFlowUser without active dept",
      nextUuid(),
      computeEndPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.MARKETING,
        membership_id: acctFlowUser.person.active_department.membership_id,
        expected_person_version: acctFlowUser.person.version,
        reason: "Prepare acctFlowUser without active dept",
      }),
    ]);

    // Capture pre-migration leave_management_upsert_employee_profile_admin on itMember (BEFORE #250!)
    const preItIdemKey = "wp10-7-2a-pre-250-it-replay";
    const preItReason = "Pre-250 IT profile upsert";
    const preItPayload = {
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: itMember.acc.app,
      employment_status: "OFFICIAL",
      unit_kind: "IT",
      work_start_date: "2024-01-01",
      official_effective_date: "2024-03-01",
      next_seniority_effective_date: "2029-01-01",
      next_seniority_units: 2,
      expected_row_version: 0,
      reason: preItReason,
      idempotency_key: preItIdemKey,
    };
    const preItFingerprint = parsePatchAdminConfigBody(preItPayload).data.request_fingerprint;
    const preItSaved = await upsertProfile(itMember.acc.app, {
      status: "OFFICIAL",
      unitKind: "IT",
      workStart: "2024-01-01",
      officialDate: "2024-03-01",
      nextSenDate: "2029-01-01",
      nextSenUnits: 2,
      expectedRowVersion: 0,
      reason: preItReason,
      idemKey: preItIdemKey,
      fingerprint: preItFingerprint,
    });
    assert.equal(preItSaved.replayed, false);
    assert.equal(preItSaved.profile.unit_kind, "IT");
    assert.equal(preItSaved.profile.row_version, 1);

    const { rows: [{ cnt: preItAuditCount }] } = await observer.query(
      `select count(*)::int as cnt
         from public.leave_audit_events
        where target_app_user_id = $1::uuid
          and event_type = 'EMPLOYEE_PROFILE_UPSERTED'`,
      [itMember.acc.app],
    );
    assert.equal(preItAuditCount, 1);

    // Pre-migration PENDING Leave requests & PENDING Attendance Explanations (IT, MARKETING, OPERATIONS)
    const preItLeave = await serviceRpc(setup, "leave_management_create_request", [
      itMember.acc.auth,
      itMember.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-250 IT pending leave",
      nextKey("pre_it_l"),
      sha256("pre-250-it-l"),
    ]);
    assert.equal(preItLeave.request.unit_kind_snapshot, "IT");
    assert.equal(preItLeave.request.primary_approver_app_user_id, itHead.acc.app);

    const preItExp = await serviceRpc(setup, "attendance_submit_explanation", [
      itMember.acc.auth,
      itMember.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-250 IT pending explanation",
      nextUuid(),
      sha256("pre-250-it-e"),
    ]);
    assert.equal(preItExp.explanation.primary_approver.app_user_id, itHead.acc.app);

    const preOpsLeave = await serviceRpc(setup, "leave_management_create_request", [
      opsMember.acc.auth,
      opsMember.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-250 OPS pending leave",
      nextKey("pre_ops_l"),
      sha256("pre-250-ops-l"),
    ]);
    assert.equal(preOpsLeave.request.unit_kind_snapshot, "UNCLASSIFIED");
    assert.equal(preOpsLeave.request.primary_approver_app_user_id, opsHead.acc.app);

    const preOpsExp = await serviceRpc(setup, "attendance_submit_explanation", [
      opsMember.acc.auth,
      opsMember.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-250 OPS pending explanation",
      nextUuid(),
      sha256("pre-250-ops-e"),
    ]);
    assert.equal(preOpsExp.explanation.primary_approver.app_user_id, opsHead.acc.app);

    const { rows: prePendingLeaveRows } = await observer.query(
      `select request_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.leave_requests
        where request_id = any($1::uuid[])
        order by request_id`,
      [[preItLeave.request.request_id, preOpsLeave.request.request_id]],
    );
    const { rows: prePendingExpRows } = await observer.query(
      `select explanation_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.attendance_explanations
        where explanation_id = any($1::uuid[])
        order by explanation_id`,
      [[preItExp.explanation.explanation_id, preOpsExp.explanation.explanation_id]],
    );

    // Snapshot ALL pre-migration leave_employee_profiles.unit_kind values + public routine count
    const { rows: preStoredUnitKinds } = await observer.query(
      "select app_user_id::text, unit_kind, row_version from public.leave_employee_profiles order by app_user_id",
    );
    const { rows: [{ cnt: prePublicRoutineCount }] } = await observer.query(
      `select count(*)::int as cnt
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname not like '\\_\\_%' escape '\\'
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );

    // -------------------------------------------------------------------------
    // 2. Apply Migration #250 (249 -> 250 upgrade) & Catalog Verification
    // -------------------------------------------------------------------------
    for (let i = baselineCutoffIdx + 1; i < files.length; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: unitKindCol } = await observer.query(
      `select column_name, data_type, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'leave_employee_profiles'
          and column_name = 'unit_kind'`,
    );
    assert.equal(unitKindCol.length, 1, "leave_employee_profiles.unit_kind column must still exist for Slice 2B");

    const { rows: postStoredUnitKinds } = await observer.query(
      "select app_user_id::text, unit_kind, row_version from public.leave_employee_profiles order by app_user_id",
    );
    assert.deepEqual(
      postStoredUnitKinds,
      preStoredUnitKinds,
      "Migration #250 MUST preserve 100% of pre-existing leave_employee_profiles.unit_kind & row_version values",
    );

    const { rows: droppedSyncFn } = await observer.query(
      `select p.oid::regprocedure::text as sig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proname = 'org_department__internal_sync_leave_profile_from_org'
               or p.prosrc ~* 'org_department__internal_sync_leave_profile_from_org')`,
    );
    assert.deepEqual(droppedSyncFn, [], "org_department__internal_sync_leave_profile_from_org must be dropped with zero refs");

    const { rows: syncMarkerRefs } = await observer.query(
      `select p.oid::regprocedure::text as sig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosrc ~* 'org_leave_profile_sync'`,
    );
    assert.deepEqual(syncMarkerRefs, [], "Zero pg_proc functions may reference app.org_leave_profile_sync");

    const { rows: liveProfileUnitKindReadersWriters } = await observer.query(
      `select p.oid::regprocedure::text as sig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname <> 'org_department__internal_guard_leave_profile'
          and p.prosrc ~* 'leave_employee_profiles'
          and (
            p.prosrc ~* 'leave_employee_profiles\\.unit_kind'
            or p.prosrc ~* '\\mset\\s+[^;]*\\munit_kind\\s*='
            or p.prosrc ~* 'insert\\s+into\\s+(?:public\\.)?leave_employee_profiles\\s*\\([^)]*\\munit_kind\\M'
            or p.prosrc ~* '\\m(?:v_profile|v_existing_profile|v_prof|lp|p)\\.unit_kind\\M'
          )`,
    );
    assert.deepEqual(
      liveProfileUnitKindReadersWriters,
      [],
      "Zero live functions outside frozen-column guard may read or write leave_employee_profiles.unit_kind",
    );

    const { rows: catalogDepends } = await observer.query(
      `select distinct c2.relname as obj_name, 'view_or_rule' as kind
         from pg_catalog.pg_depend d
         join pg_catalog.pg_attribute a
           on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
         join pg_catalog.pg_rewrite rw on rw.oid = d.objid
         join pg_catalog.pg_class c2 on c2.oid = rw.ev_class
        where d.refobjid = 'public.leave_employee_profiles'::regclass
          and a.attname = 'unit_kind'
       union all
       select distinct p.oid::regprocedure::text as obj_name, 'sql_proc' as kind
         from pg_catalog.pg_depend d
         join pg_catalog.pg_attribute a
           on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
         join pg_catalog.pg_proc p on p.oid = d.objid
        where d.refobjid = 'public.leave_employee_profiles'::regclass
          and a.attname = 'unit_kind'
          and p.proname <> 'org_department__internal_guard_leave_profile'`,
    );
    assert.deepEqual(catalogDepends, [], "pg_depend must have zero live views/routines depending on leave_employee_profiles.unit_kind");

    const { rows: [{ cnt: postPublicRoutineCount }] } = await observer.query(
      `select count(*)::int as cnt
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname not like '\\_\\_%' escape '\\'
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(postPublicRoutineCount, prePublicRoutineCount, "#250 must add +0 net service_role public RPCs");

    // -------------------------------------------------------------------------
    // 3. MANDATORY 409 Stale-Version Conflict Flow (IT <-> MARKETING)
    //    + 6. Pre-migration Idempotency-Key Replay After Department Transfer
    // -------------------------------------------------------------------------
    const leaveRepo = createLeaveRepository(async (fn, args) => {
      try {
        const data = await serviceRpc(setup, fn, [
          args.p_actor_auth_subject,
          args.p_actor_app_user_id,
          args.p_target_app_user_id,
          args.p_employment_status,
          args.p_unit_kind,
          args.p_work_start_date,
          args.p_official_effective_date,
          args.p_next_seniority_effective_date,
          args.p_next_seniority_units,
          args.p_expected_row_version,
          args.p_reason,
          args.p_idempotency_key,
          args.p_request_fingerprint,
        ]);
        return { data, error: null };
      } catch (err) {
        return { data: null, error: { code: err?.code, message: err?.message } };
      }
    });

    async function readDbLeaveProfile(appUserId) {
      const { rows: [row] } = await observer.query(
        "select app_user_id::text, employment_status, unit_kind, row_version, notes from public.leave_employee_profiles where app_user_id = $1::uuid",
        [appUserId],
      );
      return row;
    }

    async function readLatestUpsertAudit(appUserId) {
      const { rows } = await observer.query(
        `select audit_event_id, reason, payload
           from public.leave_audit_events
          where target_app_user_id = $1::uuid
            and event_type = 'EMPLOYEE_PROFILE_UPSERTED'
          order by created_at desc, audit_event_id desc`,
        [appUserId],
      );
      return { count: rows.length, latest: rows[0] ?? null };
    }

    async function transferPerson(personId, targetDeptId, label) {
      const { rows: [cur] } = await observer.query(
        `select p.version as pv, m.membership_id as mid
           from public.organization_persons p
           join public.organization_person_department_memberships m
             on m.person_id = p.person_id and m.ended_at is null
          where p.person_id = $1::uuid`,
        [personId],
      );
      const transferRes = await serviceRpc(setup, "org_department_transfer_person_member_admin", [
        OWNER.auth,
        OWNER.app,
        personId,
        targetDeptId,
        cur.pv,
        cur.mid,
        label,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, personId, {
          target_department_ref: targetDeptId,
          expected_person_version: cur.pv,
          expected_current_membership_id: cur.mid,
          reason: label,
        }),
      ]);
      const projectedTransfer = projectTransferPersonDepartmentResponse(transferRes);
      assert.ok(projectedTransfer, "Transfer response must satisfy strict TS contract projection");
      return transferRes;
    }

    const v0 = preItSaved.profile.row_version;
    assert.equal(v0, 1);

    // Transfer itMember IT -> MARKETING
    await transferPerson(itMember.person.person_id, deptByKey.MARKETING, "Transfer itMember IT -> MARKETING");

    const afterItToMktDb = await readDbLeaveProfile(itMember.acc.app);
    assert.equal(afterItToMktDb.row_version, v0 + 1, "IT -> MARKETING transfer must bump row_version to V0 + 1");
    assert.equal(afterItToMktDb.unit_kind, "IT", "DB column leave_employee_profiles.unit_kind MUST remain 'IT'");

    // Requirement 6: Replay pre-migration Idempotency-Key + fingerprint AFTER IT -> MARKETING transfer
    const preReplayParsed = parsePatchAdminConfigBody(preItPayload);
    assert.equal(preReplayParsed.ok, true);
    const replayAfterTransfer = await leaveRepo.patchAdminConfig({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      ...preReplayParsed.data,
    });
    assert.equal(replayAfterTransfer.ok, true, "Pre-migration Idempotency-Key replay after transfer must succeed");
    assert.equal(replayAfterTransfer.data.replayed, true);
    assert.deepEqual(replayAfterTransfer.data.profile, preItSaved.profile);
    assert.equal(replayAfterTransfer.data.profile.unit_kind, "IT");
    assert.equal(replayAfterTransfer.data.profile.row_version, v0);
    assert.equal((await readLatestUpsertAudit(itMember.acc.app)).count, preItAuditCount, "Replay must emit 0 new audit events");
    assert.equal((await readDbLeaveProfile(itMember.acc.app)).row_version, v0 + 1, "Replay must not alter current row_version");

    // Stale save with V0 -> PT409 / LEAVE_ROW_VERSION_CONFLICT (HTTP 409) and zero writes
    const auditBeforeStale1 = (await readLatestUpsertAudit(itMember.acc.app)).count;
    await assert.rejects(
      () => upsertProfile(itMember.acc.app, { expectedRowVersion: v0, reason: "Stale V0 save" }),
      (err) => err?.code === "PT409" && String(err?.message).includes("LEAVE_ROW_VERSION_CONFLICT"),
    );
    const staleRepoRes = await leaveRepo.patchAdminConfig({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      ...parsePatchAdminConfigBody({
        operation: "UPSERT_EMPLOYEE_PROFILE",
        target_app_user_id: itMember.acc.app,
        employment_status: "OFFICIAL",
        work_start_date: "2024-01-01",
        official_effective_date: "2024-03-01",
        next_seniority_effective_date: "2029-01-01",
        next_seniority_units: 2,
        expected_row_version: v0,
        reason: "Stale V0 save via repo",
        idempotency_key: nextKey("stale_v0_repo"),
      }).data,
    });
    assert.deepEqual(staleRepoRes, { ok: false, code: "LEAVE_ROW_VERSION_CONFLICT" });
    assert.equal(leaveHttpStatusForError(staleRepoRes.code), 409);
    assert.equal((await readLatestUpsertAudit(itMember.acc.app)).count, auditBeforeStale1);
    assert.equal((await readDbLeaveProfile(itMember.acc.app)).row_version, v0 + 1);

    // Reload via get_admin_overview -> returns MARKETING + V0 + 1; save with V0 + 1 succeeds
    const reload1 = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ALL",
    ]);
    const reloadedIt1 = reload1.employees.find((e) => e.account.app_user_id === itMember.acc.app);
    assert.equal(reloadedIt1.profile.unit_kind, "MARKETING");
    assert.equal(reloadedIt1.profile.row_version, v0 + 1);

    const saveMktSuccess = await upsertProfile(itMember.acc.app, {
      expectedRowVersion: v0 + 1,
      nextSenDate: "2029-01-01",
      nextSenUnits: 2,
      reason: "Reloaded V0+1 save in MARKETING",
    });
    assert.equal(saveMktSuccess.replayed, false);
    assert.equal(saveMktSuccess.profile.unit_kind, "MARKETING");
    assert.equal(saveMktSuccess.profile.row_version, v0 + 2);
    const auditAfterMktSave = await readLatestUpsertAudit(itMember.acc.app);
    assert.equal(auditAfterMktSave.count, auditBeforeStale1 + 1);
    assert.equal(auditAfterMktSave.latest.payload.unit_kind, "MARKETING");
    assert.equal((await readDbLeaveProfile(itMember.acc.app)).unit_kind, "IT", "DB unit_kind must stay 'IT'");

    // Transfer back MARKETING -> IT -> row_version bumps to V0 + 3
    await transferPerson(itMember.person.person_id, deptByKey.IT, "Transfer itMember MARKETING -> IT");
    const afterMktToItDb = await readDbLeaveProfile(itMember.acc.app);
    assert.equal(afterMktToItDb.row_version, v0 + 3);
    assert.equal(afterMktToItDb.unit_kind, "IT");

    // Stale save with V0 + 2 -> 409
    await assert.rejects(
      () => upsertProfile(itMember.acc.app, { expectedRowVersion: v0 + 2, reason: "Stale V0+2 save" }),
      (err) => err?.code === "PT409" && String(err?.message).includes("LEAVE_ROW_VERSION_CONFLICT"),
    );

    // Reload + save with V0 + 3 -> succeeds with IT
    const reload2 = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ALL",
    ]);
    const reloadedIt2 = reload2.employees.find((e) => e.account.app_user_id === itMember.acc.app);
    assert.equal(reloadedIt2.profile.unit_kind, "IT");
    assert.equal(reloadedIt2.profile.row_version, v0 + 3);

    const saveItSuccess = await upsertProfile(itMember.acc.app, {
      expectedRowVersion: v0 + 3,
      nextSenDate: "2029-01-01",
      nextSenUnits: 2,
      reason: "Reloaded V0+3 save back in IT",
    });
    assert.equal(saveItSuccess.profile.unit_kind, "IT");
    assert.equal(saveItSuccess.profile.row_version, v0 + 4);
    assert.equal((await readLatestUpsertAudit(itMember.acc.app)).latest.payload.unit_kind, "IT");
    assert.equal((await readDbLeaveProfile(itMember.acc.app)).unit_kind, "IT");

    // -------------------------------------------------------------------------
    // 4. MANDATORY Same-Department Rename Non-Bump + ACTIVE <-> INACTIVE Bump
    // -------------------------------------------------------------------------
    async function updatePerson(personId, { employeeCode, fullName, status, reason }) {
      const { rows: [pRow] } = await observer.query(
        "select version, employee_code, full_name, joined_on::text as joined_on from public.organization_persons where person_id = $1::uuid",
        [personId],
      );
      const code = employeeCode ?? pRow.employee_code;
      const name = fullName ?? pRow.full_name;
      return serviceRpc(setup, "org_department_update_person_admin", [
        OWNER.auth,
        OWNER.app,
        personId,
        pRow.version,
        code,
        name,
        pRow.joined_on,
        status,
        reason,
        nextUuid(),
        computeUpdatePersonFingerprint(OWNER.app, personId, {
          expected_person_version: pRow.version,
          employee_code: code,
          full_name: name,
          joined_on: pRow.joined_on,
          status,
          reason,
        }),
      ]);
    }

    const vAcct0 = (await readDbLeaveProfile(acctMember.acc.app)).row_version;
    await updatePerson(acctMember.person.person_id, {
      fullName: "Nhân sự Kế toán Đổi Tên",
      status: "ACTIVE",
      reason: "Same-dept rename",
    });
    assert.equal(
      (await readDbLeaveProfile(acctMember.acc.app)).row_version,
      vAcct0,
      "Same-department rename with status='ACTIVE' MUST NOT bump leave_employee_profiles.row_version",
    );

    await updatePerson(acctMember.person.person_id, {
      fullName: "Nhân sự Kế toán Đổi Tên",
      status: "INACTIVE",
      reason: "Deactivate person",
    });
    assert.equal(
      (await readDbLeaveProfile(acctMember.acc.app)).row_version,
      vAcct0 + 1,
      "Person status ACTIVE -> INACTIVE MUST bump leave_employee_profiles.row_version",
    );
    const acctInactiveSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      acctMember.acc.auth, acctMember.acc.app, dates.leave_year,
    ]);
    assert.equal(acctInactiveSummary.balance.unit_kind, "UNCLASSIFIED");

    await updatePerson(acctMember.person.person_id, {
      fullName: "Nhân sự Kế toán Đổi Tên",
      status: "ACTIVE",
      reason: "Reactivate person",
    });
    assert.equal(
      (await readDbLeaveProfile(acctMember.acc.app)).row_version,
      vAcct0 + 2,
      "Person status INACTIVE -> ACTIVE MUST bump leave_employee_profiles.row_version",
    );
    const acctActiveSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      acctMember.acc.auth, acctMember.acc.app, dates.leave_year,
    ]);
    assert.equal(acctActiveSummary.balance.unit_kind, "ACCOUNTING");

    // -------------------------------------------------------------------------
    // 5. Remaining Org RPC Classification Change Paths + PG18 Concurrency
    // -------------------------------------------------------------------------
    // 5a. Custom dept transfer (OPERATIONS -> SALES, both system_key IS NULL) bumps row_version
    const vOps0 = (await readDbLeaveProfile(opsMember.acc.app)).row_version;
    await transferPerson(opsMember.person.person_id, salesDeptId, "Custom dept OPERATIONS -> SALES");
    assert.equal(
      (await readDbLeaveProfile(opsMember.acc.app)).row_version,
      vOps0 + 1,
      "Custom department transfer (OPERATIONS -> SALES) must bump row_version",
    );
    const opsSalesSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      opsMember.acc.auth, opsMember.acc.app, dates.leave_year,
    ]);
    assert.equal(opsSalesSummary.org_department.department_id, salesDeptId);
    assert.equal(opsSalesSummary.org_department.department_code, "SALES");
    assert.equal(opsSalesSummary.routing.primary_approver_app_user_id, salesHead.acc.app);

    // 5b. Unlink & Link Account <-> Person bump row_version
    const vUnlink0 = (await readDbLeaveProfile(unlinkRelinkUser.acc.app)).row_version;
    const { rows: [ulInfo] } = await observer.query(
      `select u.version as acc_ver, p.version as person_ver, l.link_id
         from public.direct_entry_app_users u
         join public.organization_account_person_links l on l.app_user_id = u.app_user_id and l.ended_at is null
         join public.organization_persons p on p.person_id = l.person_id
        where u.app_user_id = $1::uuid`,
      [unlinkRelinkUser.acc.app],
    );
    await serviceRpc(setup, "org_department_unlink_account_person_admin", [
      OWNER.auth,
      OWNER.app,
      unlinkRelinkUser.acc.app,
      ulInfo.acc_ver,
      ulInfo.person_ver,
      ulInfo.link_id,
      "Unlink account person",
      nextUuid(),
      computeUnlinkAccountPersonFingerprint(OWNER.app, unlinkRelinkUser.acc.app, {
        expected_account_version: ulInfo.acc_ver,
        expected_person_version: ulInfo.person_ver,
        expected_link_id: ulInfo.link_id,
        reason: "Unlink account person",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(unlinkRelinkUser.acc.app)).row_version, vUnlink0 + 1);
    assert.equal((await readDbLeaveProfile(unlinkRelinkUser.acc.app)).unit_kind, "MARKETING");

    await serviceRpc(setup, "org_department_link_account_person_admin", [
      OWNER.auth,
      OWNER.app,
      unlinkRelinkUser.acc.app,
      unlinkRelinkUser.person.person_id,
      ulInfo.acc_ver + 1,
      ulInfo.person_ver + 1,
      null,
      "Relink account person",
      nextUuid(),
      computeLinkAccountPersonFingerprint(OWNER.app, unlinkRelinkUser.acc.app, {
        person_id: unlinkRelinkUser.person.person_id,
        expected_account_version: ulInfo.acc_ver + 1,
        expected_person_version: ulInfo.person_ver + 1,
        confirmed_recruiter_id: null,
        reason: "Relink account person",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(unlinkRelinkUser.acc.app)).row_version, vUnlink0 + 2);
    assert.equal((await readDbLeaveProfile(unlinkRelinkUser.acc.app)).unit_kind, "MARKETING");

    // 5c. End & Assign person department membership bump row_version
    const vEndAssign0 = (await readDbLeaveProfile(endAssignUser.acc.app)).row_version;
    const { rows: [eaInfo] } = await observer.query(
      `select p.version as pv, m.membership_id as mid, m.department_id as dept_id
         from public.organization_persons p
         join public.organization_person_department_memberships m
           on m.person_id = p.person_id and m.ended_at is null
        where p.person_id = $1::uuid`,
      [endAssignUser.person.person_id],
    );
    await serviceRpc(setup, "org_department_end_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      eaInfo.dept_id,
      eaInfo.mid,
      eaInfo.pv,
      "End person dept membership",
      nextUuid(),
      computeEndPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: eaInfo.dept_id,
        membership_id: eaInfo.mid,
        expected_person_version: eaInfo.pv,
        reason: "End person dept membership",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(endAssignUser.acc.app)).row_version, vEndAssign0 + 1);

    await serviceRpc(setup, "org_department_assign_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      deptByKey.IT,
      endAssignUser.person.person_id,
      eaInfo.pv + 1,
      "Assign person dept membership to IT",
      nextUuid(),
      computeAssignPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.IT,
        person_id: endAssignUser.person.person_id,
        expected_person_version: eaInfo.pv + 1,
        reason: "Assign person dept membership to IT",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(endAssignUser.acc.app)).row_version, vEndAssign0 + 2);
    assert.equal((await readDbLeaveProfile(endAssignUser.acc.app)).unit_kind, "MARKETING");

    // 5d. org_department_create_person_admin linking existing account with profile bumps row_version
    const vCreateLink0 = (await readDbLeaveProfile(createLinkExistingAcc.app)).row_version;
    await serviceRpc(setup, "org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      "EMP-72A-CREATELINK",
      createLinkExistingAcc.name,
      "2024-01-01",
      deptByKey.IT,
      createLinkExistingAcc.app,
      1,
      null,
      "Create person linking existing account with profile",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-72A-CREATELINK",
        full_name: createLinkExistingAcc.name,
        joined_on: "2024-01-01",
        initial_department_ref: deptByKey.IT,
        account_ref: createLinkExistingAcc.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Create person linking existing account with profile",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(createLinkExistingAcc.app)).row_version, vCreateLink0 + 1);
    assert.equal((await readDbLeaveProfile(createLinkExistingAcc.app)).unit_kind, "UNCLASSIFIED");

    // 5e. org_department_assign_accounting_member & org_department_end_accounting_member (linked person)
    const vAcctFlow0 = (await readDbLeaveProfile(acctFlowUser.acc.app)).row_version;
    const assignAcctRes = await serviceRpc(setup, "org_department_assign_accounting_member", [
      OWNER.auth,
      OWNER.app,
      acctFlowUser.acc.app,
      0,
      null,
      "Assign accounting member on linked person",
      nextUuid(),
      computeAssignAccountingMemberFingerprint({
        actor_app_user_id: OWNER.app,
        account_ref: acctFlowUser.acc.app,
        expected_pair_version: 0,
        effective_from: null,
        reason: "Assign accounting member on linked person",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(acctFlowUser.acc.app)).row_version, vAcctFlow0 + 1);

    await serviceRpc(setup, "org_department_end_accounting_member", [
      OWNER.auth,
      OWNER.app,
      assignAcctRes.membership.membership_id,
      assignAcctRes.membership.pair_version,
      null,
      "End accounting member on linked person",
      nextUuid(),
      computeEndAccountingMemberFingerprint({
        actor_app_user_id: OWNER.app,
        membership_id: assignAcctRes.membership.membership_id,
        expected_pair_version: assignAcctRes.membership.pair_version,
        effective_to: null,
        reason: "End accounting member on linked person",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(acctFlowUser.acc.app)).row_version, vAcctFlow0 + 2);

    // 5f. PG18 Concurrency: org_department_transfer_person_member_admin vs leave_management_upsert_employee_profile_admin
    {
      // Barrier A: Transfer holds lock first -> Upsert blocks on Lock -> Transfer commits -> Upsert rejects PT409
      const { rows: [cOrgA] } = await observer.query(
        `select p.version as pv, m.membership_id as mid, lp.row_version as rv
           from public.organization_persons p
           join public.organization_person_department_memberships m
             on m.person_id = p.person_id and m.ended_at is null
           join public.leave_employee_profiles lp on lp.app_user_id = $2::uuid
          where p.person_id = $1::uuid`,
        [concRaceUser.person.person_id, concRaceUser.acc.app],
      );
      await beginServiceTx(w1);
      await w1.query(TRANSFER_PERSON_SQL, [
        OWNER.auth, OWNER.app, concRaceUser.person.person_id, deptByKey.MARKETING,
        cOrgA.pv, cOrgA.mid, "Barrier A transfer", nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, concRaceUser.person.person_id, {
          target_department_ref: deptByKey.MARKETING,
          expected_person_version: cOrgA.pv,
          expected_current_membership_id: cOrgA.mid,
          reason: "Barrier A transfer",
        }),
      ]);
      await beginServiceTx(w2);
      const pUpsertA = settleInTx(
        w2,
        w2.query(UPSERT_LEAVE_PROFILE_SQL, [
          OWNER.auth, OWNER.app, concRaceUser.acc.app, "OFFICIAL", null,
          "2024-01-01", "2024-03-01", null, 0, cOrgA.rv,
          "Barrier A stale upsert", nextKey("bar_a_up"), sha256("bar-a-up"),
        ]),
      );
      const waitA = await waitUntilBlocked(observer, "wp10-7-2a-w2");
      assert.equal(waitA.wait_event_type, "Lock");
      await w1.query("commit");
      const rA = await pUpsertA;
      assert.equal(rA.status, "rejected");
      assert.notEqual(rA.reason?.code, "40P01");
      assert.equal(rA.reason?.code, "PT409");
      assert.match(String(rA.reason?.message), /LEAVE_ROW_VERSION_CONFLICT/);
      assert.equal((await readDbLeaveProfile(concRaceUser.acc.app)).row_version, cOrgA.rv + 1);

      // Barrier B: Upsert holds lock first -> Transfer blocks on Lock -> Upsert commits -> Transfer succeeds
      const { rows: [cOrgB] } = await observer.query(
        `select p.version as pv, m.membership_id as mid, lp.row_version as rv
           from public.organization_persons p
           join public.organization_person_department_memberships m
             on m.person_id = p.person_id and m.ended_at is null
           join public.leave_employee_profiles lp on lp.app_user_id = $2::uuid
          where p.person_id = $1::uuid`,
        [concRaceUser.person.person_id, concRaceUser.acc.app],
      );
      await beginServiceTx(w1);
      await w1.query(UPSERT_LEAVE_PROFILE_SQL, [
        OWNER.auth, OWNER.app, concRaceUser.acc.app, "OFFICIAL", null,
        "2024-01-01", "2024-03-01", null, 0, cOrgB.rv,
        "Barrier B upsert first", nextKey("bar_b_up"), sha256("bar-b-up"),
      ]);
      await beginServiceTx(w2);
      const pTransB = settleInTx(
        w2,
        w2.query(TRANSFER_PERSON_SQL, [
          OWNER.auth, OWNER.app, concRaceUser.person.person_id, deptByKey.IT,
          cOrgB.pv, cOrgB.mid, "Barrier B transfer second", nextUuid(),
          computeTransferPersonDepartmentFingerprint(OWNER.app, concRaceUser.person.person_id, {
            target_department_ref: deptByKey.IT,
            expected_person_version: cOrgB.pv,
            expected_current_membership_id: cOrgB.mid,
            reason: "Barrier B transfer second",
          }),
        ]),
      );
      const waitB = await waitUntilBlocked(observer, "wp10-7-2a-w2");
      assert.equal(waitB.wait_event_type, "Lock");
      await w1.query("commit");
      const rB = await pTransB;
      assert.equal(rB.status, "fulfilled", `Barrier B transfer should succeed: ${rB.reason?.message}`);
      assert.equal((await readDbLeaveProfile(concRaceUser.acc.app)).row_version, cOrgB.rv + 2);

      // Barrier C (AB-BA lock-order proof):
      //   wH holds recruiters(R) FOR UPDATE ->
      //   w1 runs transfer: locks P->D->M->U(FOR UPDATE) and blocks on R ->
      //   w2 runs upsert: must block on U(FOR KEY SHARE) BEFORE locking leave_employee_profiles ->
      //   wH commits -> w1 updates leave_employee_profiles & commits -> w2 rejects PT409 (0 40P01)
      const { rows: [cOrgC] } = await observer.query(
        `select p.version as pv, m.membership_id as mid, lp.row_version as rv
           from public.organization_persons p
           join public.organization_person_department_memberships m
             on m.person_id = p.person_id and m.ended_at is null
           join public.leave_employee_profiles lp on lp.app_user_id = $2::uuid
          where p.person_id = $1::uuid`,
        [concRecRaceUser.person.person_id, concRecRaceUser.acc.app],
      );
      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'");
      await wH.query(
        "select recruiter_id from public.recruiters where recruiter_id = $1::uuid for update",
        [concRecRaceUser.recruiterId],
      );
      await beginServiceTx(w1);
      const pTransC = settleInTx(
        w1,
        w1.query(TRANSFER_PERSON_SQL, [
          OWNER.auth, OWNER.app, concRecRaceUser.person.person_id, deptByKey.MARKETING,
          cOrgC.pv, cOrgC.mid, "Barrier C transfer holding U blocked on R", nextUuid(),
          computeTransferPersonDepartmentFingerprint(OWNER.app, concRecRaceUser.person.person_id, {
            target_department_ref: deptByKey.MARKETING,
            expected_person_version: cOrgC.pv,
            expected_current_membership_id: cOrgC.mid,
            reason: "Barrier C transfer holding U blocked on R",
          }),
        ]),
      );
      const waitC1 = await waitUntilBlocked(observer, "wp10-7-2a-w1");
      assert.equal(waitC1.wait_event_type, "Lock");
      const { rows: [pidCheck1] } = await observer.query(
        `select pg_catalog.pg_blocking_pids($1::int) as blockers,
                (select pg_backend_pid()) as obs_pid,
                (select pid from pg_stat_activity where application_name = 'wp10-7-2a-wH' limit 1) as wh_pid`,
        [waitC1.pid],
      );
      assert.equal(pidCheck1.blockers.includes(pidCheck1.wh_pid), true, "w1 must be blocked by wH holding recruiters lock");

      await beginServiceTx(w2);
      const pUpsertC = settleInTx(
        w2,
        w2.query(UPSERT_LEAVE_PROFILE_SQL, [
          OWNER.auth, OWNER.app, concRecRaceUser.acc.app, "OFFICIAL", null,
          "2024-01-01", "2024-03-01", null, 0, cOrgC.rv,
          "Barrier C upsert waiting on U before leave_employee_profiles", nextKey("bar_c_up"), sha256("bar-c-up"),
        ]),
      );
      const waitC2 = await waitUntilBlocked(observer, "wp10-7-2a-w2");
      assert.equal(waitC2.wait_event_type, "Lock");
      const { rows: [pidCheck2] } = await observer.query(
        `select pg_catalog.pg_blocking_pids($1::int) as blockers,
                exists (
                  select 1
                    from pg_locks l
                   where l.pid = $1::int
                     and l.relation = 'public.leave_employee_profiles'::regclass
                     and l.granted = true
                ) as holds_leave_profile_lock`,
        [waitC2.pid],
      );
      assert.equal(pidCheck2.blockers.includes(waitC1.pid), true, "w2 must be blocked by w1 holding U");
      assert.equal(pidCheck2.holds_leave_profile_lock, false, "w2 must block on U BEFORE locking leave_employee_profiles");

      await wH.query("commit");
      const [rC1, rC2] = await Promise.all([pTransC, pUpsertC]);
      assert.equal(
        rC1.status,
        "fulfilled",
        `Barrier C transfer must succeed without 40P01: ${rC1.reason?.code} ${rC1.reason?.message}`,
      );
      assert.equal(rC2.status, "rejected");
      assert.notEqual(rC2.reason?.code, "40P01");
      assert.equal(rC2.reason?.code, "PT409");
      assert.match(String(rC2.reason?.message), /LEAVE_ROW_VERSION_CONFLICT/);
      assert.equal((await readDbLeaveProfile(concRecRaceUser.acc.app)).row_version, cOrgC.rv + 1);

      // 12 concurrent Promise.all trials
      for (let trial = 0; trial < 12; trial += 1) {
        const targetDept = trial % 2 === 0 ? deptByKey.MARKETING : deptByKey.IT;
        const { rows: [cTrial] } = await observer.query(
          `select p.version as pv, m.membership_id as mid, lp.row_version as rv
             from public.organization_persons p
             join public.organization_person_department_memberships m
               on m.person_id = p.person_id and m.ended_at is null
             join public.leave_employee_profiles lp on lp.app_user_id = $2::uuid
            where p.person_id = $1::uuid`,
          [concRaceUser.person.person_id, concRaceUser.acc.app],
        );
        const [resTransfer, resUpsert] = await Promise.all([
          serviceQuery(w1, TRANSFER_PERSON_SQL, [
            OWNER.auth, OWNER.app, concRaceUser.person.person_id, targetDept,
            cTrial.pv, cTrial.mid, `Trial ${trial} transfer`, nextUuid(),
            computeTransferPersonDepartmentFingerprint(OWNER.app, concRaceUser.person.person_id, {
              target_department_ref: targetDept,
              expected_person_version: cTrial.pv,
              expected_current_membership_id: cTrial.mid,
              reason: `Trial ${trial} transfer`,
            }),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
          serviceQuery(w2, UPSERT_LEAVE_PROFILE_SQL, [
            OWNER.auth, OWNER.app, concRaceUser.acc.app, "OFFICIAL", null,
            "2024-01-01", "2024-03-01", null, 0, cTrial.rv,
            `Trial ${trial} upsert`, nextKey(`tr_up_${trial}`), sha256(`tr-up-${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
        ]);
        assert.equal(
          resTransfer.status,
          "fulfilled",
          `Trial ${trial} transfer must succeed without 40P01: ${resTransfer.reason?.code} ${resTransfer.reason?.message}`,
        );
        if (resUpsert.status === "rejected") {
          assert.notEqual(resUpsert.reason?.code, "40P01", `Trial ${trial} raised 40P01 deadlock`);
          assert.equal(resUpsert.reason?.code, "PT409");
        } else {
          assert.equal((await readDbLeaveProfile(concRaceUser.acc.app)).row_version, cTrial.rv + 2);
        }
      }
    }

    // -------------------------------------------------------------------------
    // 7. Disabled -> Re-enabled Account + Legacy Mismatched unit_kind + New Profile INSERT
    // -------------------------------------------------------------------------
    const { rows: [disUnlAcc] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth, OWNER.app, disabledUnlinkedMkt.app, disUnlAcc.version,
      "Re-enable unlinked user with mismatched legacy unit_kind", nextKey("en_unl"),
    ]);

    const { rows: [disLinkedItAcc] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [disabledLinkedIt.acc.app],
    );
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth, OWNER.app, disabledLinkedIt.acc.app, disLinkedItAcc.version,
      "Re-enable linked IT user", nextKey("en_it"),
    ]);
    const reenabledItSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      disabledLinkedIt.acc.auth, disabledLinkedIt.acc.app, dates.leave_year,
    ]);
    assert.equal(reenabledItSummary.balance.unit_kind, "IT");

    // Re-enabled unlinked user: all live flows MUST return UNCLASSIFIED while DB column remains 'MARKETING'
    const disOverview = await serviceRpc(setup, "leave_management_get_admin_overview", [
      OWNER.auth, OWNER.app, null, 200, 0, "ALL",
    ]);
    assert.equal(disOverview.employees.find((e) => e.account.app_user_id === disabledUnlinkedMkt.app).profile.unit_kind, "UNCLASSIFIED");
    const disSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      disabledUnlinkedMkt.auth, disabledUnlinkedMkt.app, dates.leave_year,
    ]);
    assert.equal(disSummary.balance.unit_kind, "UNCLASSIFIED");
    assert.equal(disSummary.routing.unit_kind, "UNCLASSIFIED");
    const disRepMkt = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "MARKETING", null, 200, 0,
    ]);
    assert.equal(disRepMkt.rows.some((r) => r.app_user_id === disabledUnlinkedMkt.app), false);
    const disRepUnclass = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "UNCLASSIFIED", null, 200, 0,
    ]);
    assert.equal(disRepUnclass.rows.some((r) => r.app_user_id === disabledUnlinkedMkt.app), true);

    const disBeforeUpsertVer = (await readDbLeaveProfile(disabledUnlinkedMkt.app)).row_version;
    const disUpsertRes = await upsertProfile(disabledUnlinkedMkt.app, {
      expectedRowVersion: disBeforeUpsertVer,
      reason: "Upsert re-enabled unlinked user",
    });
    assert.equal(disUpsertRes.profile.unit_kind, "UNCLASSIFIED");
    assert.equal((await readLatestUpsertAudit(disabledUnlinkedMkt.app)).latest.payload.unit_kind, "UNCLASSIFIED");
    assert.equal((await readDbLeaveProfile(disabledUnlinkedMkt.app)).unit_kind, "MARKETING", "DB unit_kind must remain 'MARKETING'");

    // Link re-enabled user to IT via create_person_admin -> row_version bumps, live flows return IT, DB stays 'MARKETING'
    const { rows: [disUnlAcc2] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    const verBeforeLinkIt = (await readDbLeaveProfile(disabledUnlinkedMkt.app)).row_version;
    await serviceRpc(setup, "org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      "EMP-72A-REENABLE-IT",
      disabledUnlinkedMkt.name,
      "2024-01-01",
      deptByKey.IT,
      disabledUnlinkedMkt.app,
      disUnlAcc2.version,
      null,
      "Link re-enabled user to IT",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-72A-REENABLE-IT",
        full_name: disabledUnlinkedMkt.name,
        joined_on: "2024-01-01",
        initial_department_ref: deptByKey.IT,
        account_ref: disabledUnlinkedMkt.app,
        expected_account_version: disUnlAcc2.version,
        recruiter_id: null,
        reason: "Link re-enabled user to IT",
      }),
    ]);
    assert.equal((await readDbLeaveProfile(disabledUnlinkedMkt.app)).row_version, verBeforeLinkIt + 1);
    assert.equal((await readDbLeaveProfile(disabledUnlinkedMkt.app)).unit_kind, "MARKETING");
    const linkedItSummary = await serviceRpc(setup, "leave_management_get_my_summary", [
      disabledUnlinkedMkt.auth, disabledUnlinkedMkt.app, dates.leave_year,
    ]);
    assert.equal(linkedItSummary.balance.unit_kind, "IT");
    assert.equal(linkedItSummary.routing.primary_approver_app_user_id, itHead.acc.app);

    // Brand-new profile INSERT via upsert_employee_profile_admin for linked MARKETING user (mktNewUser)
    const newProfileRes = await upsertProfile(mktNewUser.acc.app, {
      expectedRowVersion: 0,
      reason: "Brand-new profile insert for linked MARKETING user",
    });
    assert.equal(newProfileRes.replayed, false);
    assert.equal(newProfileRes.profile.unit_kind, "MARKETING");
    assert.equal(newProfileRes.profile.row_version, 1);
    assert.equal((await readLatestUpsertAudit(mktNewUser.acc.app)).latest.payload.unit_kind, "MARKETING");
    assert.equal(
      (await readDbLeaveProfile(mktNewUser.acc.app)).unit_kind,
      "UNCLASSIFIED",
      "New profile INSERT must leave DB column unit_kind at default 'UNCLASSIFIED'",
    );

    // -------------------------------------------------------------------------
    // 8. Frozen-Column Guard Trigger Verification
    // -------------------------------------------------------------------------
    await assert.rejects(
      () => setup.query(
        "update public.leave_employee_profiles set unit_kind = 'IT' where app_user_id = $1::uuid",
        [mktNewUser.acc.app],
      ),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );

    await setup.query("begin");
    try {
      await setup.query("set local app.org_leave_profile_sync = 'on'");
      await assert.rejects(
        () => setup.query(
          "update public.leave_employee_profiles set unit_kind = 'IT' where app_user_id = $1::uuid",
          [mktNewUser.acc.app],
        ),
        (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
      );
    } finally {
      await setup.query("rollback");
    }

    const sqlInsertAcc = await seedPlainAccount(setup, "wp1072a.sqlinsguard", "SQL Insert Guard");
    await assert.rejects(
      () => setup.query(
        `insert into public.leave_employee_profiles (app_user_id, employment_status, unit_kind, row_version)
         values ($1::uuid, 'UNCONFIGURED', 'IT', 1)`,
        [sqlInsertAcc.app],
      ),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );

    // -------------------------------------------------------------------------
    // 9. Preserved Pre-Migration PENDING Snapshots + Approver DECIDE + Balance + Report + XLSX Export
    // -------------------------------------------------------------------------
    const { rows: postPendingLeaveRows } = await observer.query(
      `select request_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.leave_requests
        where request_id = any($1::uuid[])
        order by request_id`,
      [[preItLeave.request.request_id, preOpsLeave.request.request_id]],
    );
    assert.deepEqual(postPendingLeaveRows, prePendingLeaveRows, "Pre-migration PENDING Leave snapshots must be preserved");

    const { rows: postPendingExpRows } = await observer.query(
      `select explanation_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.attendance_explanations
        where explanation_id = any($1::uuid[])
        order by explanation_id`,
      [[preItExp.explanation.explanation_id, preOpsExp.explanation.explanation_id]],
    );
    assert.deepEqual(postPendingExpRows, prePendingExpRows, "Pre-migration PENDING Explanation snapshots must be preserved");

    const itBalBeforeApprove = await serviceRpc(setup, "leave_management_get_my_summary", [
      itMember.acc.auth, itMember.acc.app, dates.leave_year,
    ]);
    assert.equal(itBalBeforeApprove.balance.pending_annual_units, 1);
    assert.equal(itBalBeforeApprove.balance.reserved_units, 0);
    assert.equal(itBalBeforeApprove.balance.consumed_units, 0);

    for (const [approver, leaveReq, expRow, tag] of [
      [itHead.acc, preItLeave.request, preItExp.explanation, "it"],
      [opsHead.acc, preOpsLeave.request, preOpsExp.explanation, "ops"],
    ]) {
      const decLeave = await serviceRpc(setup, "leave_management_decide_request", [
        approver.auth, approver.app, leaveReq.request_id, "APPROVE", 1,
        `Approve pre-250 ${tag} leave`, nextKey(`dec_l_${tag}`), sha256(`dec-l-${tag}`),
      ]);
      assert.equal(decLeave.request.status, "APPROVED");

      const decExp = await serviceRpc(setup, "attendance_decide_explanation", [
        approver.auth, approver.app, expRow.explanation_id, "APPROVE", 1,
        `Approve pre-250 ${tag} exp`, nextUuid(), sha256(`dec-e-${tag}`),
      ]);
      assert.equal(decExp.explanation.status, "APPROVED");
    }

    const itBalAfterApprove = await serviceRpc(setup, "leave_management_get_my_summary", [
      itMember.acc.auth, itMember.acc.app, dates.leave_year,
    ]);
    assert.equal(itBalAfterApprove.balance.unit_kind, "IT");
    assert.equal(itBalAfterApprove.balance.pending_annual_units, 0);
    assert.equal(itBalAfterApprove.balance.reserved_units, 0);
    assert.equal(itBalAfterApprove.balance.consumed_units, 1);
    assert.equal(
      itBalAfterApprove.balance.available_units,
      itBalBeforeApprove.balance.available_units - 1,
    );

    // Post-250 Attendance Explanation & Leave routing verification
    const postItExpRaw = await serviceRpc(setup, "attendance_submit_explanation", [
      itMember.acc.auth, itMember.acc.app, dates.yesterday_vn, "SLOT_2",
      "Post-250 IT explanation", nextUuid(), sha256("post-250-it-e"),
    ]);
    const postItExp = projectSubmitAttendanceExplanationResult(postItExpRaw);
    assert.ok(postItExp);
    assert.equal(postItExp.explanation.primary_approver.app_user_id, itHead.acc.app);
    const itExpOverview = projectAttendanceMyExplanationsOverview(
      await serviceRpc(setup, "attendance_get_my_explanations_overview", [
        itMember.acc.auth, itMember.acc.app, dates.yesterday_vn, 20, 0,
      ]),
    );
    assert.equal(itExpOverview.routing.unit_kind, "IT");

    // Monthly report filtering + buildLeaveMonthlyReportXlsx export verification
    const mktReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "MARKETING", null, 200, 0,
    ]);
    assert.equal(mktReport.rows.some((r) => r.app_user_id === mktNewUser.acc.app), true);
    assert.equal(mktReport.rows.some((r) => r.app_user_id === disabledUnlinkedMkt.app), false);

    const allReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "ALL", null, 200, 0,
    ]);
    const itRowInReport = allReport.rows.find((r) => r.app_user_id === itMember.acc.app);
    assert.ok(itRowInReport);
    assert.equal(itRowInReport.unit_kind, "IT");
    assert.equal(itRowInReport.month_annual_leave_units, 1);

    const xlsxBytes = await buildLeaveMonthlyReportXlsx(allReport);
    assert.ok(xlsxBytes.byteLength > 100);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(xlsxBytes));
    const sheet = workbook.getWorksheet(`Nghỉ phép ${dates.ym}`);
    assert.ok(sheet, `Worksheet Nghỉ phép ${dates.ym} must exist`);
    let foundItExportRow = false;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (
        row.getCell(1).value === (itRowInReport.account.personnel_code ?? "") &&
        row.getCell(2).value === itRowInReport.account.display_name
      ) {
        foundItExportRow = true;
        assert.equal(row.getCell(4).value, itRowInReport.org_department.department_name);
        assert.equal(row.getCell(12).value, "0.5");
      }
    });
    assert.equal(foundItExportRow, true, "Exported workbook must contain itMember row with Org department name and 0.5d annual leave");
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
