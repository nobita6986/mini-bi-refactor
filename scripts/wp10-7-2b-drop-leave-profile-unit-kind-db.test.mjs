/**
 * WP10-7 Slice 2B — Drop Legacy `public.leave_employee_profiles.unit_kind` Column
 * Real Isolated PostgreSQL 18 Upgrade (0..250 -> #251), Failure Gates, Live Behavior & Restore Drill.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl` + `psql`).
 *
 * Verifies ALL mandatory WP10-7 Slice 2B contract requirements:
 *   1. Migration #251 hygiene & atomic rollback zero drift.
 *   2. Upgrade from #250 (0..250 -> #251) on isolated native PostgreSQL 18:
 *      - Rich pre-251 fixture across IT, MARKETING, ACCOUNTING, custom departments (OPERATIONS/SALES),
 *        disabled unlinked user with mismatched legacy `unit_kind = 'MARKETING'`,
 *        pre-251 profile save (capturing Idempotency-Key + request_fingerprint + response),
 *        and pre-251 PENDING Leave request & PENDING Attendance Explanation (snapshots & routing).
 *      - Archive `(app_user_id, unit_kind)` CSV + `row_count` + canonical UTF-8 SHA-256 digest
 *        to `os.tmpdir()` (outside Git) and source-still-matches gate immediately before `#251`.
 *      - Non-public-schema failure gates BEFORE clean apply:
 *        * `app_custom` PL/pgSQL function with unqualified `SELECT unit_kind INTO ... FROM public.leave_employee_profiles` -> SQLSTATE `55000` (column/trigger/helper/rows intact).
 *        * `app_custom.v_leave_unit` view selecting `unit_kind` from `public.leave_employee_profiles` -> SQLSTATE `55000` (column/trigger/helper/rows intact).
 *      - Clean `#251` apply: `unit_kind` column, `leave_employee_profiles_unit_kind_chk`,
 *        `leave_employee_profiles_org_guard_trg`, and `org_department__internal_guard_leave_profile()` dropped,
 *        `+0` net `service_role` RPCs & S0-T1-C ACL preserved.
 *   3. Post-drop live behavior & snapshot preservation:
 *      - `leave_requests.unit_kind_snapshot` & `attendance_explanations.unit_kind_snapshot` 100% preserved
 *        and pre-251 PENDING requests `APPROVE`d cleanly.
 *      - Upsert profile (UPDATE existing + brand-new INSERT with `expected_row_version = 0`) succeeds
 *        (`0` `42703` errors) returning Org-derived `unit_kind` across `profile`, `balance`, `routing`, `leave_audit_events`.
 *      - Pre-251 `Idempotency-Key` replay AFTER `IT -> MARKETING` transfer returns exact cached response (`replayed: true`, `0` new audit events).
 *      - `IT <-> MARKETING` transfers bump `row_version`, stale `expected_row_version` -> `PT409 LEAVE_ROW_VERSION_CONFLICT` (`409`),
 *        reload + save succeeds; same-dept `full_name` edit does NOT bump `row_version`.
 *      - Monthly report `unit_kind` filter (`IT`, `MARKETING`, `UNCLASSIFIED`) & `buildLeaveMonthlyReportXlsx` export pass.
 *      - WP2A shadow preflight (`assertWp2aShadowSchemaCompatible`) fails closed cleanly on post-`#251` DB.
 *   4. Full Restore Drill matching the Slice 2B runbook:
 *      - Mutate DB post-`#251`: update 1 surviving profile (`row_version` bump + `notes` change),
 *        insert 1 brand-new post-251 profile, delete 1 archived profile.
 *      - Snapshot non-`unit_kind` columns + `row_version` of all profiles.
 *      - Execute exact runbook restore SQL in single `BEGIN; ... COMMIT;` via `psql` using `os.tmpdir()` CSV.
 *      - Assert `attnotnull`, `DEFAULT 'UNCLASSIFIED'`, CHECK constraint, active guard trigger,
 *        `row_version` & all other columns 100% unchanged, surviving archived profiles match archived
 *        `unit_kind` & canonical SHA-256 over surviving IDs, and brand-new post-251 profile has `'UNCLASSIFIED'`.
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
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  leaveHttpStatusForError,
  parsePatchAdminConfigBody,
} from "../src/lib/leave/leave-contract.ts";
import { buildLeaveMonthlyReportXlsx } from "../src/lib/leave/leave-export.ts";
import { createLeaveRepository } from "../src/lib/leave/leave-repository.ts";
import {
  computeCreatePersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUpdatePersonFingerprint,
  projectTransferPersonDepartmentResponse,
} from "../src/lib/organization/person-contract.ts";
import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { assertWp2aShadowSchemaCompatible } from "./run-wp2a-effective-access-shadow.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_7_2A_MIGRATION_NAME =
  "20261126190000_wp10_7_2a_stop_leave_profile_unit_kind_mirror.sql";
const WP10_7_2B_MIGRATION_NAME =
  "20261126210000_wp10_7_2b_drop_leave_profile_unit_kind.sql";

const OWNER = {
  auth: "94200000-0000-4000-8000-00000000a001",
  app: "94200000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-2B",
};
const LUANPT = {
  auth: "94200000-0000-4000-8000-00000000a002",
  app: "94200000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "94200000-0000-4000-8000-00000000a003",
  app: "94200000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "94200000-0000-4000-8000-00000000a004",
  app: "94200000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `94210000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_7_2b_${prefix}_${seq++}`;
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

function runBin(file, args, { ignoreOutput = false, input = undefined } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(input !== undefined ? { input } : {}),
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
  return result;
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
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role",
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

async function computeDbUnitKindManifest(observer) {
  await observer.query("begin transaction isolation level repeatable read read only");
  try {
    const { rows: [row] } = await observer.query(`
      select count(*)::int as row_count,
             coalesce(
               pg_catalog.string_agg(app_user_id::text || '|' || unit_kind, E'\\n' order by app_user_id asc),
               ''
             ) as canonical_payload
        from public.leave_employee_profiles
    `);
    await observer.query("rollback");
    return {
      rowCount: row.row_count,
      canonicalPayload: row.canonical_payload,
      canonicalSha256: sha256(row.canonical_payload),
    };
  } catch (err) {
    await observer.query("rollback").catch(() => {});
    throw err;
  }
}

test("WP10-7 Slice 2B (PG18): Drop leave_employee_profiles.unit_kind across 0..250 -> #251 upgrade, failure gates, live ops & restore drill", async () => {
  const wp1072bSql = await readFile(path.join(MIGRATION_DIR, WP10_7_2B_MIGRATION_NAME), "utf8");
  assert.equal(wp1072bSql.includes("\r\n"), false, "Migration #251 must use LF line endings");
  assert.equal(wp1072bSql.replace(/--[^\n]*/g, "").includes("@"), false, "Migration #251 must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(wp1072bSql), false, "Migration #251 must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(wp1072bSql), false, "Migration #251 must contain zero '40001'");
  assert.equal(/alter\s+default\s+privileges/i.test(wp1072bSql), false, "Migration #251 must contain zero ALTER DEFAULT PRIVILEGES");
  assert.match(wp1072bSql, /drop\s+column\s+unit_kind\s+restrict\s*;/i, "Migration #251 must DROP COLUMN unit_kind RESTRICT");
  assert.equal(/\bcascade\b/i.test(wp1072bSql.replace(/--[^\n]*/g, "")), false, "Migration #251 must NEVER use CASCADE");

  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  const psqlBin = binary("psql");
  assert.ok(initdb && pgCtl && psqlBin, "PostgreSQL 18 initdb/pg_ctl/psql binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-2b-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const archiveCsvPath = path.join(tmpDir, "leave_employee_profiles_unit_kind.archive.csv");
  const archiveCsvPosix = archiveCsvPath.replaceAll("\\", "/");
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

    const setup = await connect(port, "wp10-7-2b-setup");
    const observer = await connect(port, "wp10-7-2b-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const wp1072aIdx = files.indexOf(WP10_7_2A_MIGRATION_NAME);
    const wp1072bIdx = files.indexOf(WP10_7_2B_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(wp1072aIdx > groupsIdx, "WP10-7 Slice 2A migration #250 must exist");
    assert.equal(wp1072bIdx, wp1072aIdx + 1, "WP10-7 Slice 2B migration #251 must immediately follow #250");

    // -------------------------------------------------------------------------
    // 1. Seed pre-#250 stored unit_kind rows, then upgrade to #250 & finish pre-#251 fixture
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

    for (let i = groupsIdx; i < wp1072aIdx; i += 1) {
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
             )::text as d1
        from d
    `);
    await setBusinessDate(setup, dates.today_vn);

    const TEAM_REC = nextUuid();
    const PRJ_1 = "wp10-7-2b-prj-1";
    await setup.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'rec_2b', 'Recruitment 2B', true, 1)",
      [TEAM_REC],
    );
    await setup.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project WP10-7-2B', true)",
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
      const acc = await seedPlainAccount(setup, `wp1072b.${tag}`, displayName);
      const empCode = `EMP-72B-${tag.toUpperCase()}-${seq++}`;
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

    // Extra archived profile that we will delete in the post-251 restore drill
    const toDeleteArchivedUser = await onboardOrgUser("todel", deptByKey.IT, "Archived To Delete");

    // Disabled unlinked user with mismatched legacy unit_kind = 'MARKETING'
    const disabledUnlinkedMkt = await seedPlainAccount(setup, "wp1072b.disunlmkt", "Disabled Unlinked MKT");
    await upsertProfile(disabledUnlinkedMkt.app, { unitKind: "MARKETING", reason: "Pre-250 unlinked profile" });
    await setup.query(
      "update public.leave_employee_profiles set unit_kind = 'MARKETING' where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    await serviceRpc(setup, "direct_entry_disable_app_user", [
      OWNER.auth, OWNER.app, disabledUnlinkedMkt.app, 1, "Disable unlinked legacy user", nextKey("dis_unl"),
    ]);

    for (const acc of [
      itHead.acc,
      itMember.acc,
      mktHead.acc,
      mktMember.acc,
      acctHead.acc,
      acctMember.acc,
      opsHead.acc,
      opsMember.acc,
      salesHead.acc,
      toDeleteArchivedUser.acc,
    ]) {
      await upsertProfile(acc.app, { reason: "Pre-250 seed profile" });
    }

    // Apply Migration #250 so the database is genuinely at #250 (pre-251)
    await setup.query(await readFile(path.join(MIGRATION_DIR, files[wp1072aIdx]), "utf8"));

    // At #250 (pre-251): capture pre-251 profile save (Idempotency-Key + request_fingerprint)
    const preItIdemKey = "wp10-7-2b-pre-251-it-replay";
    const preItReason = "Pre-251 IT profile upsert";
    const preItPayload = {
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: itMember.acc.app,
      employment_status: "OFFICIAL",
      unit_kind: "IT",
      work_start_date: "2024-01-01",
      official_effective_date: "2024-03-01",
      next_seniority_effective_date: "2029-01-01",
      next_seniority_units: 2,
      expected_row_version: 1,
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
      expectedRowVersion: 1,
      reason: preItReason,
      idemKey: preItIdemKey,
      fingerprint: preItFingerprint,
    });
    assert.equal(preItSaved.replayed, false);
    assert.equal(preItSaved.profile.unit_kind, "IT");
    assert.equal(preItSaved.profile.row_version, 2);

    const { rows: [{ cnt: preItAuditCount }] } = await observer.query(
      `select count(*)::int as cnt
         from public.leave_audit_events
        where target_app_user_id = $1::uuid
          and event_type = 'EMPLOYEE_PROFILE_UPSERTED'`,
      [itMember.acc.app],
    );
    assert.equal(preItAuditCount, 2);

    // Pre-251 PENDING Leave & Attendance Explanation requests
    const preItLeave = await serviceRpc(setup, "leave_management_create_request", [
      itMember.acc.auth,
      itMember.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-251 IT pending leave",
      nextKey("pre_it_l"),
      sha256("pre-251-it-l"),
    ]);
    assert.equal(preItLeave.request.unit_kind_snapshot, "IT");
    assert.equal(preItLeave.request.primary_approver_app_user_id, itHead.acc.app);

    const preItExp = await serviceRpc(setup, "attendance_submit_explanation", [
      itMember.acc.auth,
      itMember.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-251 IT pending explanation",
      nextUuid(),
      sha256("pre-251-it-e"),
    ]);
    assert.equal(preItExp.explanation.primary_approver.app_user_id, itHead.acc.app);

    const preOpsLeave = await serviceRpc(setup, "leave_management_create_request", [
      opsMember.acc.auth,
      opsMember.acc.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Pre-251 OPS pending leave",
      nextKey("pre_ops_l"),
      sha256("pre-251-ops-l"),
    ]);
    assert.equal(preOpsLeave.request.unit_kind_snapshot, "UNCLASSIFIED");
    assert.equal(preOpsLeave.request.primary_approver_app_user_id, opsHead.acc.app);

    const preOpsExp = await serviceRpc(setup, "attendance_submit_explanation", [
      opsMember.acc.auth,
      opsMember.acc.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Pre-251 OPS pending explanation",
      nextUuid(),
      sha256("pre-251-ops-e"),
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

    // Capture S0-T1-C & service_role RPC count before #251
    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(files.slice(0, wp1072bIdx).map((f) => [f, true]));
    const preS0Check = await verifyS0T1CSecurityPostconditions(observer, s0Sql, preFlags);
    assert.equal(preS0Check.ok, true, `pre-251 S0-T1-C check failed: ${preS0Check.reason}`);
    const { rows: [{ cnt: prePublicRoutineCount }] } = await observer.query(
      `select count(*)::int as cnt
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname not like '\\_\\_%' escape '\\'
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );

    // -------------------------------------------------------------------------
    // 2. Archive (app_user_id, unit_kind) CSV to os.tmpdir() + SHA-256 + Source-Still-Matches Gate
    // -------------------------------------------------------------------------
    runBin(
      psqlBin,
      [`postgresql://postgres@127.0.0.1:${port}/postgres`, "-X", "-v", "ON_ERROR_STOP=1"],
      {
        input: [
          "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
          `\\copy (SELECT app_user_id::text AS app_user_id, unit_kind FROM public.leave_employee_profiles ORDER BY app_user_id ASC) TO '${archiveCsvPosix}' WITH (FORMAT csv, HEADER true)`,
          "ROLLBACK;",
        ].join("\n"),
      },
    );

    const archiveManifest = await computeDbUnitKindManifest(observer);
    assert.equal(archiveManifest.rowCount, 11, "Pre-251 archive must contain all 11 seeded leave profiles");

    const archiveCsvText = await readFile(archiveCsvPath, "utf8");
    const csvLines = archiveCsvText.trim().split(/\r?\n/);
    assert.equal(csvLines[0], "app_user_id,unit_kind");
    const archivedEntries = csvLines.slice(1).map((line) => {
      const [appUserId, unitKind] = line.split(",");
      assert.ok(appUserId && unitKind, `Invalid archive CSV row: ${line}`);
      return { app_user_id: appUserId, unit_kind: unitKind };
    });
    assert.equal(archivedEntries.length, archiveManifest.rowCount);
    const archivedCanonicalFromCsv = archivedEntries
      .map((e) => `${e.app_user_id}|${e.unit_kind}`)
      .join("\n");
    assert.equal(sha256(archivedCanonicalFromCsv), archiveManifest.canonicalSha256);

    const archivedByUserId = new Map(archivedEntries.map((e) => [e.app_user_id, e.unit_kind]));
    assert.equal(archivedByUserId.get(itMember.acc.app), "IT");
    assert.equal(archivedByUserId.get(mktMember.acc.app), "MARKETING");
    assert.equal(archivedByUserId.get(acctMember.acc.app), "ACCOUNTING");
    assert.equal(archivedByUserId.get(opsMember.acc.app), "UNCLASSIFIED");
    assert.equal(archivedByUserId.get(disabledUnlinkedMkt.app), "MARKETING");

    // Source-still-matches gate immediately before applying #251
    const preDropGateManifest = await computeDbUnitKindManifest(observer);
    assert.equal(preDropGateManifest.rowCount, archiveManifest.rowCount);
    assert.equal(preDropGateManifest.canonicalSha256, archiveManifest.canonicalSha256);

    // -------------------------------------------------------------------------
    // 3. Atomic Rollback + Non-Public-Schema Failure Gates (Function & View)
    // -------------------------------------------------------------------------
    async function assertUnitKindIntact(label) {
      const { rows: [col] } = await observer.query(
        `select 1 as ok
           from pg_catalog.pg_attribute a
          where a.attrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
            and a.attname = 'unit_kind'
            and a.attnum > 0
            and not a.attisdropped`,
      );
      assert.ok(col, `${label}: unit_kind column must remain intact`);
      const { rows: [trg] } = await observer.query(
        `select 1 as ok
           from pg_catalog.pg_trigger t
          where t.tgrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
            and t.tgname = 'leave_employee_profiles_org_guard_trg'
            and not t.tgisinternal`,
      );
      assert.ok(trg, `${label}: guard trigger must remain intact`);
      const { rows: [fn] } = await observer.query(
        "select pg_catalog.to_regprocedure('public.org_department__internal_guard_leave_profile()') as oid",
      );
      assert.ok(fn.oid !== null, `${label}: guard helper function must remain intact`);
      const currentManifest = await computeDbUnitKindManifest(observer);
      assert.equal(currentManifest.rowCount, archiveManifest.rowCount, `${label}: row count must stay intact`);
      assert.equal(currentManifest.canonicalSha256, archiveManifest.canonicalSha256, `${label}: stored values must stay intact`);
    }

    // Atomic rollback check
    const stripped251 = wp1072bSql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await setup.query("begin");
    await setup.query(stripped251);
    await setup.query("rollback");
    await assertUnitKindIntact("Atomic rollback");

    // Gate A: Non-public schema PL/pgSQL function reading unqualified `unit_kind` from `public.leave_employee_profiles`
    await setup.query(`
      create schema app_custom;
      create function app_custom.probe_leave_unit(p_user_id uuid)
      returns text
      language plpgsql
      as $fn$
      declare
        v_unit text;
      begin
        select unit_kind into v_unit
          from public.leave_employee_profiles
         where app_user_id = p_user_id;
        return v_unit;
      end;
      $fn$;
    `);
    await assert.rejects(
      () => setup.query(wp1072bSql),
      (err) => err?.code === "55000",
      "Migration #251 MUST fail closed (SQLSTATE 55000) when app_custom PL/pgSQL function reads unit_kind",
    );
    await setup.query("rollback").catch(() => {});
    await assertUnitKindIntact("Blocked by app_custom PL/pgSQL function");
    await setup.query("drop function app_custom.probe_leave_unit(uuid);");

    // Gate B: Non-public schema view selecting `unit_kind` from `public.leave_employee_profiles`
    await setup.query(`
      create view app_custom.v_leave_unit as
      select app_user_id, unit_kind
        from public.leave_employee_profiles;
    `);
    await assert.rejects(
      () => setup.query(wp1072bSql),
      (err) => err?.code === "55000",
      "Migration #251 MUST fail closed (SQLSTATE 55000) when app_custom.v_leave_unit view reads unit_kind",
    );
    await setup.query("rollback").catch(() => {});
    await assertUnitKindIntact("Blocked by app_custom.v_leave_unit view");
    await setup.query("drop view app_custom.v_leave_unit; drop schema app_custom;");

    // -------------------------------------------------------------------------
    // 4. Clean Apply #251 & Catalog Postconditions
    // -------------------------------------------------------------------------
    await setup.query(wp1072bSql);

    const { rows: [postSchema] } = await observer.query(`
      select
        exists (
          select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'leave_employee_profiles' and column_name = 'unit_kind'
        ) as has_info_col,
        exists (
          select 1 from pg_catalog.pg_attribute a
           where a.attrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
             and a.attname = 'unit_kind'
             and a.attnum > 0
             and not a.attisdropped
        ) as has_attr_col,
        exists (
          select 1 from pg_catalog.pg_constraint c
           where c.conrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
             and c.conname = 'leave_employee_profiles_unit_kind_chk'
        ) as has_chk,
        exists (
          select 1 from pg_catalog.pg_trigger t
           where t.tgrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
             and t.tgname = 'leave_employee_profiles_org_guard_trg'
             and not t.tgisinternal
        ) as has_trg,
        pg_catalog.to_regprocedure('public.org_department__internal_guard_leave_profile()') as guard_fn_oid
    `);
    assert.equal(postSchema.has_info_col, false, "unit_kind must be absent from information_schema.columns");
    assert.equal(postSchema.has_attr_col, false, "unit_kind must be absent from pg_attribute");
    assert.equal(postSchema.has_chk, false, "leave_employee_profiles_unit_kind_chk must be absent");
    assert.equal(postSchema.has_trg, false, "leave_employee_profiles_org_guard_trg must be absent");
    assert.equal(postSchema.guard_fn_oid, null, "org_department__internal_guard_leave_profile() must be dropped");

    const postFlags = new Map([...preFlags, [WP10_7_2B_MIGRATION_NAME, true]]);
    const postS0Check = await verifyS0T1CSecurityPostconditions(observer, s0Sql, postFlags);
    assert.equal(postS0Check.ok, true, `post-251 S0-T1-C check failed: ${postS0Check.reason}`);
    assert.equal(postS0Check.details.actualServiceCount, preS0Check.details.actualServiceCount, "+0 net service_role RPCs");
    assert.equal(postS0Check.details.exposedClientOrPublicCount, 0, "0 client/PUBLIC EXECUTE grants");

    const { rows: [{ cnt: postPublicRoutineCount }] } = await observer.query(
      `select count(*)::int as cnt
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname not like '\\_\\_%' escape '\\'
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(postPublicRoutineCount, prePublicRoutineCount, "#251 must add +0 net service_role public RPCs");

    // -------------------------------------------------------------------------
    // 5. Post-Drop Live Behavior, Replay, 409 OCC, Snapshots, Report & WP2A Preflight
    // -------------------------------------------------------------------------
    // 5a. Snapshot preservation + approve pre-251 PENDING requests
    const { rows: postPendingLeaveRows } = await observer.query(
      `select request_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.leave_requests
        where request_id = any($1::uuid[])
        order by request_id`,
      [[preItLeave.request.request_id, preOpsLeave.request.request_id]],
    );
    assert.deepEqual(postPendingLeaveRows, prePendingLeaveRows, "leave_requests.unit_kind_snapshot must match 100%");

    const { rows: postPendingExpRows } = await observer.query(
      `select explanation_id::text, unit_kind_snapshot, route_kind, primary_approver_app_user_id::text,
              routed_department_id::text, routed_department_code, routed_department_name, status
         from public.attendance_explanations
        where explanation_id = any($1::uuid[])
        order by explanation_id`,
      [[preItExp.explanation.explanation_id, preOpsExp.explanation.explanation_id]],
    );
    assert.deepEqual(postPendingExpRows, prePendingExpRows, "attendance_explanations.unit_kind_snapshot must match 100%");

    const itBalBeforeApprove = await serviceRpc(setup, "leave_management_get_my_summary", [
      itMember.acc.auth, itMember.acc.app, dates.leave_year,
    ]);
    for (const [approver, leaveReq, expRow, tag] of [
      [itHead.acc, preItLeave.request, preItExp.explanation, "it"],
      [opsHead.acc, preOpsLeave.request, preOpsExp.explanation, "ops"],
    ]) {
      const decLeave = await serviceRpc(setup, "leave_management_decide_request", [
        approver.auth, approver.app, leaveReq.request_id, "APPROVE", 1,
        `Approve pre-251 ${tag} leave`, nextKey(`dec_l_${tag}`), sha256(`dec-l-${tag}`),
      ]);
      assert.equal(decLeave.request.status, "APPROVED");

      const decExp = await serviceRpc(setup, "attendance_decide_explanation", [
        approver.auth, approver.app, expRow.explanation_id, "APPROVE", 1,
        `Approve pre-251 ${tag} exp`, nextUuid(), sha256(`dec-e-${tag}`),
      ]);
      assert.equal(decExp.explanation.status, "APPROVED");
    }
    const itBalAfterApprove = await serviceRpc(setup, "leave_management_get_my_summary", [
      itMember.acc.auth, itMember.acc.app, dates.leave_year,
    ]);
    assert.equal(itBalAfterApprove.balance.unit_kind, "IT");
    assert.equal(itBalAfterApprove.balance.consumed_units, 1);
    assert.equal(itBalAfterApprove.balance.available_units, itBalBeforeApprove.balance.available_units - 1);

    // Helper readers
    async function readDbRowVersion(appUserId) {
      const { rows: [row] } = await observer.query(
        "select app_user_id::text, employment_status, row_version, notes from public.leave_employee_profiles where app_user_id = $1::uuid",
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
      const projected = projectTransferPersonDepartmentResponse(transferRes);
      assert.ok(projected);
      return transferRes;
    }

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

    // 5b. Post-drop UPDATE existing + brand-new INSERT (expected_row_version = 0)
    const acctUpdateRes = await upsertProfile(acctMember.acc.app, {
      expectedRowVersion: 1,
      reason: "Post-251 update existing ACCOUNTING profile",
    });
    assert.equal(acctUpdateRes.replayed, false);
    assert.equal(acctUpdateRes.profile.unit_kind, "ACCOUNTING");
    assert.equal(acctUpdateRes.balance.unit_kind, "ACCOUNTING");
    assert.equal(acctUpdateRes.routing.unit_kind, "ACCOUNTING");
    assert.equal(acctUpdateRes.profile.row_version, 2);
    assert.equal((await readLatestUpsertAudit(acctMember.acc.app)).latest.payload.unit_kind, "ACCOUNTING");

    const mktNewRes = await upsertProfile(mktNewUser.acc.app, {
      expectedRowVersion: 0,
      reason: "Post-251 brand-new INSERT MARKETING profile",
    });
    assert.equal(mktNewRes.replayed, false);
    assert.equal(mktNewRes.profile.unit_kind, "MARKETING");
    assert.equal(mktNewRes.balance.unit_kind, "MARKETING");
    assert.equal(mktNewRes.routing.unit_kind, "MARKETING");
    assert.equal(mktNewRes.profile.row_version, 1);
    assert.equal((await readLatestUpsertAudit(mktNewUser.acc.app)).latest.payload.unit_kind, "MARKETING");

    // 5c. Transfer IT -> MARKETING, pre-251 Idempotency-Key replay, 409 OCC, reload + save, transfer back
    const v0 = preItSaved.profile.row_version;
    assert.equal(v0, 2);
    await transferPerson(itMember.person.person_id, deptByKey.MARKETING, "Post-251 IT -> MARKETING");
    assert.equal((await readDbRowVersion(itMember.acc.app)).row_version, v0 + 1);

    const preReplayParsed = parsePatchAdminConfigBody(preItPayload);
    assert.equal(preReplayParsed.ok, true);
    const replayAfterTransfer = await leaveRepo.patchAdminConfig({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      ...preReplayParsed.data,
    });
    assert.equal(replayAfterTransfer.ok, true);
    assert.equal(replayAfterTransfer.data.replayed, true);
    assert.deepEqual(replayAfterTransfer.data.profile, preItSaved.profile);
    assert.equal(replayAfterTransfer.data.profile.unit_kind, "IT");
    assert.equal(replayAfterTransfer.data.profile.row_version, v0);
    assert.equal((await readLatestUpsertAudit(itMember.acc.app)).count, preItAuditCount);
    assert.equal((await readDbRowVersion(itMember.acc.app)).row_version, v0 + 1);

    // Stale expected_row_version -> PT409 LEAVE_ROW_VERSION_CONFLICT (HTTP 409)
    const staleRes = await leaveRepo.patchAdminConfig({
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
        reason: "Post-251 stale save",
        idempotency_key: nextKey("stale_251"),
      }).data,
    });
    assert.deepEqual(staleRes, { ok: false, code: "LEAVE_ROW_VERSION_CONFLICT" });
    assert.equal(leaveHttpStatusForError(staleRes.code), 409);

    // Reload -> MARKETING + V0 + 1, save -> succeeds
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
      reason: "Post-251 reloaded save in MARKETING",
    });
    assert.equal(saveMktSuccess.profile.unit_kind, "MARKETING");
    assert.equal(saveMktSuccess.profile.row_version, v0 + 2);

    // Transfer back MARKETING -> IT
    await transferPerson(itMember.person.person_id, deptByKey.IT, "Post-251 MARKETING -> IT");
    assert.equal((await readDbRowVersion(itMember.acc.app)).row_version, v0 + 3);
    const saveItBack = await upsertProfile(itMember.acc.app, {
      expectedRowVersion: v0 + 3,
      nextSenDate: "2029-01-01",
      nextSenUnits: 2,
      reason: "Post-251 reloaded save back in IT",
    });
    assert.equal(saveItBack.profile.unit_kind, "IT");
    assert.equal(saveItBack.profile.row_version, v0 + 4);

    // Same-dept full_name edit does NOT bump row_version
    const vAcctBeforeRename = (await readDbRowVersion(acctMember.acc.app)).row_version;
    const { rows: [acctP] } = await observer.query(
      "select version, employee_code, joined_on::text as joined_on from public.organization_persons where person_id = $1::uuid",
      [acctMember.person.person_id],
    );
    await serviceRpc(setup, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      acctMember.person.person_id,
      acctP.version,
      acctP.employee_code,
      "Nhân sự Kế toán Sau #251",
      acctP.joined_on,
      "ACTIVE",
      "Post-251 same-dept rename",
      nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, acctMember.person.person_id, {
        expected_person_version: acctP.version,
        employee_code: acctP.employee_code,
        full_name: "Nhân sự Kế toán Sau #251",
        joined_on: acctP.joined_on,
        status: "ACTIVE",
        reason: "Post-251 same-dept rename",
      }),
    ]);
    assert.equal((await readDbRowVersion(acctMember.acc.app)).row_version, vAcctBeforeRename);

    // Re-enable disabledUnlinkedMkt -> UNCLASSIFIED in monthly report & live flows
    const { rows: [disAcc] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [disabledUnlinkedMkt.app],
    );
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth, OWNER.app, disabledUnlinkedMkt.app, disAcc.version,
      "Post-251 re-enable unlinked user", nextKey("en_unl_251"),
    ]);

    // 5d. Monthly report filter (IT, MARKETING, UNCLASSIFIED) & XLSX export
    const itReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "IT", null, 200, 0,
    ]);
    assert.equal(itReport.rows.some((r) => r.app_user_id === itMember.acc.app), true);
    assert.equal(itReport.rows.some((r) => r.app_user_id === mktNewUser.acc.app), false);

    const mktReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "MARKETING", null, 200, 0,
    ]);
    assert.equal(mktReport.rows.some((r) => r.app_user_id === mktNewUser.acc.app), true);
    assert.equal(mktReport.rows.some((r) => r.app_user_id === disabledUnlinkedMkt.app), false);

    const unclassReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "UNCLASSIFIED", null, 200, 0,
    ]);
    assert.equal(unclassReport.rows.some((r) => r.app_user_id === disabledUnlinkedMkt.app), true);
    assert.equal(unclassReport.rows.some((r) => r.app_user_id === opsMember.acc.app), true);

    const allReport = await serviceRpc(setup, "leave_management_monthly_report", [
      OWNER.auth, OWNER.app, dates.ym, "ALL", null, 200, 0,
    ]);
    const itReportRow = allReport.rows.find((r) => r.app_user_id === itMember.acc.app);
    assert.ok(itReportRow);
    assert.equal(itReportRow.unit_kind, "IT");
    assert.equal(itReportRow.month_annual_leave_units, 1);

    const xlsxBytes = await buildLeaveMonthlyReportXlsx(allReport);
    assert.ok(xlsxBytes.byteLength > 100);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(xlsxBytes));
    const sheet = workbook.getWorksheet(`Nghỉ phép ${dates.ym}`);
    assert.ok(sheet, `Worksheet Nghỉ phép ${dates.ym} must exist`);
    let foundExportRow = false;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (
        row.getCell(1).value === (itReportRow.account.personnel_code ?? "") &&
        row.getCell(2).value === itReportRow.account.display_name
      ) {
        foundExportRow = true;
        assert.equal(row.getCell(4).value, itReportRow.org_department.department_name);
        assert.equal(row.getCell(12).value, "0.5");
      }
    });
    assert.equal(foundExportRow, true);

    // Post-drop Attendance Explanation routing check
    const postExpRaw = await serviceRpc(setup, "attendance_submit_explanation", [
      itMember.acc.auth, itMember.acc.app, dates.yesterday_vn, "SLOT_2",
      "Post-251 IT explanation", nextUuid(), sha256("post-251-it-e"),
    ]);
    const postExp = projectSubmitAttendanceExplanationResult(postExpRaw);
    assert.ok(postExp);
    assert.equal(postExp.explanation.primary_approver.app_user_id, itHead.acc.app);
    const itExpOv = projectAttendanceMyExplanationsOverview(
      await serviceRpc(setup, "attendance_get_my_explanations_overview", [
        itMember.acc.auth, itMember.acc.app, dates.yesterday_vn, 20, 0,
      ]),
    );
    assert.equal(itExpOv.routing.unit_kind, "IT");

    // 5e. WP2A shadow preflight fails closed cleanly on post-#251 DB
    await assert.rejects(
      () => assertWp2aShadowSchemaCompatible(observer),
      (err) =>
        String(err?.message).includes("public.leave_employee_profiles.is_shared_non_employee") &&
        String(err?.message).includes("public.leave_department_approvers"),
    );

    // -------------------------------------------------------------------------
    // 6. Full Restore Drill (Matching Slice 2B Runbook)
    // -------------------------------------------------------------------------
    // 6a. Mutate post-251 DB:
    //   - Update 1 surviving profile (acctMember: bump row_version & change notes)
    //   - Insert 1 brand-new post-251 profile (post251NewUser, not in archive)
    //   - Delete 1 archived profile (toDeleteArchivedUser)
    const acctVerForDrill = (await readDbRowVersion(acctMember.acc.app)).row_version;
    await upsertProfile(acctMember.acc.app, {
      expectedRowVersion: acctVerForDrill,
      reason: "Post-251 restore drill mutated notes",
    });
    const post251NewUser = await onboardOrgUser("post251new", deptByKey.IT, "Post-251 Brand New User");
    await upsertProfile(post251NewUser.acc.app, {
      expectedRowVersion: 0,
      reason: "Post-251 brand new profile outside archive",
    });
    await setup.query("delete from public.leave_employee_profiles where app_user_id = $1::uuid", [
      toDeleteArchivedUser.acc.app,
    ]);

    // Snapshot non-unit_kind columns + row_version of ALL profiles before restore
    const { rows: preRestoreSnapshots } = await observer.query(`
      select app_user_id::text,
             employment_status,
             work_start_date::text as work_start_date,
             official_effective_date::text as official_effective_date,
             next_seniority_effective_date::text as next_seniority_effective_date,
             next_seniority_units,
             notes,
             row_version,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc,
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc,
             updated_by_app_user_id::text as updated_by_app_user_id
        from public.leave_employee_profiles
       order by app_user_id asc
    `);

    // 6b. Execute exact runbook restore SQL in a single BEGIN; ... COMMIT; transaction
    const restoreSql = [
      "BEGIN;",
      "ALTER TABLE public.leave_employee_profiles",
      "  ADD COLUMN unit_kind text NOT NULL DEFAULT 'UNCLASSIFIED',",
      "  ADD CONSTRAINT leave_employee_profiles_unit_kind_chk CHECK (",
      "    unit_kind IN (",
      "      'UNCLASSIFIED',",
      "      'RECRUITMENT',",
      "      'MARKETING',",
      "      'IT',",
      "      'ACCOUNTING',",
      "      'MANAGEMENT_BOD'",
      "    )",
      "  );",
      "CREATE TEMP TABLE _wp10_7_2b_unit_kind_restore (",
      "  app_user_id uuid PRIMARY KEY,",
      "  unit_kind text NOT NULL",
      ") ON COMMIT DROP;",
      `\\copy _wp10_7_2b_unit_kind_restore (app_user_id, unit_kind) FROM '${archiveCsvPosix}' WITH (FORMAT csv, HEADER true)`,
      "UPDATE public.leave_employee_profiles lp",
      "   SET unit_kind = s.unit_kind",
      "  FROM _wp10_7_2b_unit_kind_restore s",
      " WHERE lp.app_user_id = s.app_user_id;",
      "CREATE OR REPLACE FUNCTION public.org_department__internal_guard_leave_profile()",
      "RETURNS trigger",
      "LANGUAGE plpgsql",
      "SECURITY DEFINER",
      "SET search_path = pg_catalog, public",
      "AS $function$",
      "BEGIN",
      "  IF tg_op = 'INSERT' THEN",
      "    IF new.unit_kind IS DISTINCT FROM 'UNCLASSIFIED' THEN",
      "      RAISE EXCEPTION 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'",
      "        USING ERRCODE = '22023';",
      "    END IF;",
      "  ELSIF tg_op = 'UPDATE' THEN",
      "    IF new.unit_kind IS DISTINCT FROM old.unit_kind THEN",
      "      RAISE EXCEPTION 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'",
      "        USING ERRCODE = '22023';",
      "    END IF;",
      "  END IF;",
      "  RETURN new;",
      "END;",
      "$function$;",
      "REVOKE ALL ON FUNCTION public.org_department__internal_guard_leave_profile() FROM PUBLIC, anon, authenticated, service_role;",
      "DO $$",
      "DECLARE",
      "  v_upsert_owner text;",
      "BEGIN",
      "  SELECT pg_catalog.pg_get_userbyid(p.proowner)",
      "    INTO v_upsert_owner",
      "    FROM pg_catalog.pg_proc p",
      "    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace",
      "   WHERE n.nspname = 'public'",
      "     AND p.proname = 'leave_management_upsert_employee_profile_admin'",
      "   LIMIT 1;",
      "  IF v_upsert_owner IS NOT NULL THEN",
      "    EXECUTE pg_catalog.format('ALTER FUNCTION public.org_department__internal_guard_leave_profile() OWNER TO %I', v_upsert_owner);",
      "  END IF;",
      "END $$;",
      "CREATE TRIGGER leave_employee_profiles_org_guard_trg",
      "  BEFORE INSERT OR UPDATE ON public.leave_employee_profiles",
      "  FOR EACH ROW",
      "  EXECUTE FUNCTION public.org_department__internal_guard_leave_profile();",
      "COMMIT;",
    ].join("\n");

    runBin(
      psqlBin,
      [`postgresql://postgres@127.0.0.1:${port}/postgres`, "-X", "-v", "ON_ERROR_STOP=1"],
      { input: restoreSql },
    );

    // 6c. Assert restored schema, guard trigger, preserved columns/row_version, & SHA-256 parity
    const { rows: [restoredAttr] } = await observer.query(`
      select a.attnotnull,
             pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
             c.column_default
        from pg_catalog.pg_attribute a
        join information_schema.columns c
          on c.table_schema = 'public'
         and c.table_name = 'leave_employee_profiles'
         and c.column_name = a.attname
       where a.attrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
         and a.attname = 'unit_kind'
         and a.attnum > 0
         and not a.attisdropped
    `);
    assert.ok(restoredAttr, "Restored unit_kind attribute must exist");
    assert.equal(restoredAttr.attnotnull, true);
    assert.equal(restoredAttr.data_type, "text");
    assert.equal(restoredAttr.column_default, "'UNCLASSIFIED'::text");

    const { rows: [restoredChk] } = await observer.query(`
      select pg_catalog.pg_get_constraintdef(c.oid, true) as def
        from pg_catalog.pg_constraint c
       where c.conrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
         and c.conname = 'leave_employee_profiles_unit_kind_chk'
         and c.contype = 'c'
    `);
    assert.ok(restoredChk, "Restored leave_employee_profiles_unit_kind_chk must exist");
    for (const allowed of ["UNCLASSIFIED", "RECRUITMENT", "MARKETING", "IT", "ACCOUNTING", "MANAGEMENT_BOD"]) {
      assert.ok(restoredChk.def.includes(allowed), `CHECK constraint must include ${allowed}`);
    }

    const { rows: [restoredGuard] } = await observer.query(`
      select t.tgenabled::text as tgenabled,
             p.prosecdef,
             p.proconfig,
             pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
             pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
         and t.tgname = 'leave_employee_profiles_org_guard_trg'
         and not t.tgisinternal
    `);
    assert.ok(restoredGuard, "Restored guard trigger must exist");
    assert.equal(restoredGuard.tgenabled, "O");
    assert.equal(restoredGuard.prosecdef, true);
    assert.ok(restoredGuard.proconfig.includes("search_path=pg_catalog, public"));
    assert.equal(restoredGuard.pub_exec, false);
    assert.equal(restoredGuard.svc_exec, false);

    // Guard trigger blocks direct UPDATE unit_kind and direct INSERT with 'IT'
    await assert.rejects(
      () => setup.query(
        "update public.leave_employee_profiles set unit_kind = 'MARKETING' where app_user_id = $1::uuid",
        [post251NewUser.acc.app],
      ),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );
    const guardInsertAcc = await seedPlainAccount(setup, "wp1072b.restins", "Restore Insert Guard");
    await assert.rejects(
      () => setup.query(
        `insert into public.leave_employee_profiles (app_user_id, employment_status, unit_kind, row_version)
         values ($1::uuid, 'UNCONFIGURED', 'IT', 1)`,
        [guardInsertAcc.app],
      ),
      (err) => err?.code === "22023" && String(err?.message).includes("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"),
    );

    // All non-unit_kind columns + row_version must be 100% unchanged vs pre-restore snapshot
    const { rows: postRestoreSnapshots } = await observer.query(`
      select app_user_id::text,
             employment_status,
             work_start_date::text as work_start_date,
             official_effective_date::text as official_effective_date,
             next_seniority_effective_date::text as next_seniority_effective_date,
             next_seniority_units,
             notes,
             row_version,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc,
             to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc,
             updated_by_app_user_id::text as updated_by_app_user_id
        from public.leave_employee_profiles
       order by app_user_id asc
    `);
    assert.deepEqual(
      postRestoreSnapshots,
      preRestoreSnapshots,
      "Restore MUST leave row_version and all non-unit_kind columns 100% unchanged",
    );

    // Surviving archived profiles match archived unit_kind & canonical SHA-256 over surviving IDs;
    // post-251 profiles default to 'UNCLASSIFIED'
    const { rows: restoredUnitRows } = await observer.query(
      "select app_user_id::text, unit_kind from public.leave_employee_profiles order by app_user_id asc",
    );
    const restoredById = new Map(restoredUnitRows.map((r) => [r.app_user_id, r.unit_kind]));
    assert.equal(restoredById.get(post251NewUser.acc.app), "UNCLASSIFIED", "Post-251 profile must retain DEFAULT 'UNCLASSIFIED'");
    assert.equal(restoredById.get(mktNewUser.acc.app), "UNCLASSIFIED", "Post-250/pre-251 unarchived profile created after #251 must have DEFAULT 'UNCLASSIFIED'");
    assert.equal(restoredById.has(toDeleteArchivedUser.acc.app), false, "Deleted archived profile must NOT be resurrected");

    const survivingArchiveEntries = archivedEntries.filter((e) => restoredById.has(e.app_user_id));
    assert.equal(survivingArchiveEntries.length, archiveManifest.rowCount - 1);
    for (const entry of survivingArchiveEntries) {
      assert.equal(
        restoredById.get(entry.app_user_id),
        entry.unit_kind,
        `Surviving profile ${entry.app_user_id} must restore archived unit_kind=${entry.unit_kind}`,
      );
    }
    const expectedSurvivingSha256 = sha256(
      survivingArchiveEntries.map((e) => `${e.app_user_id}|${e.unit_kind}`).join("\n"),
    );
    const actualSurvivingSha256 = sha256(
      restoredUnitRows
        .filter((r) => archivedByUserId.has(r.app_user_id))
        .map((r) => `${r.app_user_id}|${r.unit_kind}`)
        .join("\n"),
    );
    assert.equal(actualSurvivingSha256, expectedSurvivingSha256, "Canonical SHA-256 over surviving archived IDs must match 100%");
    assert.equal(restoredById.get(acctMember.acc.app), "ACCOUNTING");
    assert.equal(restoredById.get(disabledUnlinkedMkt.app), "MARKETING");
    assert.equal(
      postRestoreSnapshots.find((r) => r.app_user_id === acctMember.acc.app).notes,
      "Post-251 restore drill mutated notes",
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
