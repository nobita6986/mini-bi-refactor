/**
 * WP10-7 Slice 1B — Drop Legacy `public.leave_department_approvers` Table
 * Dual-Engine (PGlite + Isolated Real PostgreSQL 18) Regression & Security Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) covering BOTH:
 *   - Upgrade path (`0..244` -> `#245`) on PGlite AND isolated PostgreSQL 18
 *   - Fresh install (`0..245`) on PGlite AND isolated PostgreSQL 18
 *
 * Verifies:
 *   1) Migration `#245` hygiene (LF, 0 `@`, 0 `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`),
 *      atomic rollback zero drift, `DROP TABLE ... RESTRICT`, S0-T1-C ACL (`+0` net RPCs, 9-arg stub
 *      preserved & `service_role`-only), 0 `pg_proc` refs to `leave_department_approvers`,
 *      snapshots/audit/`unit_kind`/grant/Work Reports tables intact.
 *   2) Leave & Attendance Explanation routing after `#245`:
 *      - Department Head (Marketing employee -> Nguyễn Kim Tú / Head; Head's own request -> BoD/Admin)
 *      - Team Leader (Recruitment employee -> TL; TL's own request -> BoD/Admin)
 *      - BoD/Admin fallback & direct (Accounting / IT when no Org Dept Head)
 *   3) Cancel historical `APPROVED` leave request missing `routed_department_id` after `#245`
 *      (both Org Department Head AND Admin/BoD succeed cleanly).
 *   4) `SET_DEPARTMENT_APPROVER` API `handlePatchLeaveAdminConfig` -> HTTP `409 LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN`;
 *      SQL RPC stub `leave_management_set_department_approver_admin` -> `PT409 LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN`
 *      (and `42501` for non-admin); `LEAVE_DEPARTMENT_APPROVER` parser/label preserved.
 *   5) Archive & restore drill on isolated PostgreSQL 18:
 *      - Seed rows into `leave_department_approvers` on `244`, snapshot exact columns/DDL + compute
 *        canonical row count & SHA-256 checksum + `pg_dump`, apply `#245` (`to_regclass(...) is null`),
 *        restore table/constraints/indexes/RLS/rows from archive into isolated DB, assert 100% match.
 *   6) Operational tools compatibility: `buildLegacyTechnicalIdentityManifest` returns real
 *      `leave_approver_total` on `244` AND `0` cleanly on `245`; WP2A shadow preflight fails closed
 *      cleanly on `245` while historical `wp2a-effective-access-shadow-db.test.mjs` remains green.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

import {
  projectAttendanceMyExplanationsOverview,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  computeDesignateHeadFingerprint,
} from "../src/lib/departments/department-contract.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import { handlePatchLeaveAdminConfig } from "../src/lib/leave/leave-api.ts";
import { createLeaveRepository } from "../src/lib/leave/leave-repository.ts";
import { projectAccountGroupsResponse } from "../src/lib/admin/permission-group-contract.ts";
import { formatResourceAssignmentKindLabel } from "../src/lib/admin/permission-group-ui-model.ts";
import { buildLegacyTechnicalIdentityManifest } from "./lib/pr28-legacy-identity-manifest.mjs";
import { assertWp2aShadowSchemaCompatible } from "./run-wp2a-effective-access-shadow.mjs";
import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_7_1B_MIGRATION_NAME = "20261126093000_wp10_7_1b_drop_leave_department_approvers.sql";
const LEGACY_APPROVER_STUB_SIG =
  "public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)";

const ROLE_PREAMBLE = `
  do $$
  begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
`;

const OWNER = {
  auth: "90100000-0000-4000-8000-00000000a001",
  app: "90100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-1B",
};
const LUANPT = {
  auth: "90100000-0000-4000-8000-00000000a002",
  app: "90100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "90100000-0000-4000-8000-00000000a003",
  app: "90100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "90100000-0000-4000-8000-00000000a004",
  app: "90100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `90110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
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

async function connectPg(port, appName, database = "postgres") {
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

function wrapPgClient(client, name) {
  return {
    name,
    async exec(sql) {
      await client.query(sql);
    },
    async query(sql, params = []) {
      return client.query(sql, params);
    },
    async serviceQuery(sql, params = []) {
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
    },
    async serviceRpc(fnName, args = [], casts = []) {
      const placeholders = args
        .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
        .join(", ");
      const res = await this.serviceQuery(`select public.${fnName}(${placeholders}) as data`, args);
      return res.rows[0]?.data;
    },
    async readOnly(fn) {
      await client.query("begin transaction read only");
      try {
        return await fn(client);
      } finally {
        await client.query("rollback").catch(() => {});
      }
    },
  };
}

async function createPgliteEngine() {
  const db = new PGlite();
  const { rows: [verRow] } = await db.query("select version() as v");
  return {
    name: `PGlite (${verRow.v})`,
    async exec(sql) {
      await db.exec(sql);
    },
    async query(sql, params = []) {
      return db.query(sql, params);
    },
    async serviceQuery(sql, params = []) {
      await db.exec("begin; set local role service_role");
      try {
        const res = await db.query(sql, params);
        await db.exec("commit");
        return res;
      } catch (err) {
        await db.exec("rollback").catch(() => {});
        throw err;
      }
    },
    async serviceRpc(fnName, args = [], casts = []) {
      const placeholders = args
        .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
        .join(", ");
      const res = await this.serviceQuery(`select public.${fnName}(${placeholders}) as data`, args);
      return res.rows[0]?.data;
    },
    async readOnly(fn) {
      await db.exec("begin transaction read only");
      try {
        return await fn(db);
      } finally {
        await db.exec("rollback").catch(() => {});
      }
    },
    async close() {
      await db.close();
    },
  };
}

async function setBusinessDate(engine, isoDate) {
  await engine.exec(`
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

async function inspectLegacyApproverStub(engine) {
  const { rows } = await engine.query(
    `select p.oid::regprocedure::text as sig,
            p.proname,
            p.proowner,
            p.prosecdef,
            p.proconfig,
            pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
            pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
            pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
            (select count(*)::int
               from pg_catalog.pg_proc p2
               join pg_catalog.pg_namespace n2 on n2.oid = p2.pronamespace
              where n2.nspname = 'public' and p2.proname = p.proname) as overload_count
       from pg_catalog.pg_proc p
      where p.oid = $1::regprocedure`,
    [LEGACY_APPROVER_STUB_SIG],
  );
  assert.equal(rows.length, 1, "9-arg leave_management_set_department_approver_admin stub must exist");
  return rows[0];
}

async function seedLegacyAdmin(engine, user) {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await engine.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await engine.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedFreshSystemAdmin(engine, user, isProtected) {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [user.app, user.auth, user.name],
  );
  const { rows: [sysGrp] } = await engine.query(
    "select group_id from public.authz_user_groups where code = 'SYSTEM_ADMIN'",
  );
  assert.ok(sysGrp?.group_id, "SYSTEM_ADMIN group must exist on fresh install");
  await engine.query(
    `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, is_protected, reason)
     values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', $3, 'WP10-7-1B fresh install admin seed')`,
    [sysGrp.group_id, user.app, isProtected],
  );
}

async function seedPlainAccount(engine, loginPrefix, displayName) {
  const authId = nextUuid();
  const appId = nextUuid();
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    authId,
    `${loginPrefix}@hrpartner.local`,
  ]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [appId, authId, displayName],
  );
  return { auth: authId, app: appId, login: loginPrefix, name: displayName };
}

async function onboardOrgUser(engine, tag, deptId, displayName, { withRecruiter = false, position = "STAFF", teamId = null } = {}) {
  const acc = await seedPlainAccount(engine, `wp107.${tag}`, displayName);
  const empCode = `EMP-W7-${tag.toUpperCase()}-${seq++}`;
  const p = (
    await engine.serviceRpc("org_department_create_person_admin", [
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
    const cp = await engine.serviceRpc("direct_entry_account_operation_create_personnel", [
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
      await engine.serviceRpc("direct_entry_assign_team_membership", [
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
  await engine.serviceRpc("leave_management_upsert_employee_profile_admin", [
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
  return { acc, person: p, recruiterId };
}

async function designateDeptHead(engine, deptId, personId, label, expectedHeadId = null) {
  const { rows: [dRow] } = await engine.query(
    "select version from public.organization_departments where department_id = $1::uuid",
    [deptId],
  );
  return engine.serviceRpc("org_department_designate_head_admin", [
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

async function computeDates(engine) {
  const { rows: [dates] } = await engine.query(`
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
  return { todayVn: dates.today_vn, leaveYear: dates.leave_year, leaveDays, expDates: dates.past_workdays };
}

async function snapshotLeaveDeptApproversSchemaAndRows(engine) {
  const { rows: columns } = await engine.query(`
    select ordinal_position::int as ordinal_position,
           column_name,
           data_type,
           udt_name,
           is_nullable,
           column_default
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'leave_department_approvers'
     order by ordinal_position
  `);
  const { rows: constraints } = await engine.query(`
    select c.conname,
           c.contype::text as contype,
           pg_catalog.pg_get_constraintdef(c.oid, true) as definition
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.leave_department_approvers'::pg_catalog.regclass
     order by c.conname
  `);
  const { rows: indexes } = await engine.query(`
    select indexname,
           indexdef
      from pg_catalog.pg_indexes
     where schemaname = 'public'
       and tablename = 'leave_department_approvers'
     order by indexname
  `);
  const { rows: [rls] } = await engine.query(`
    select relrowsecurity,
           relforcerowsecurity
      from pg_catalog.pg_class
     where oid = 'public.leave_department_approvers'::pg_catalog.regclass
  `);
  const { rows: dataRows } = await engine.query(`
    select approver_assignment_id::text as approver_assignment_id,
           unit_kind,
           approver_app_user_id::text as approver_app_user_id,
           valid_from::text as valid_from,
           valid_to::text as valid_to,
           is_current,
           reason,
           row_version::int as row_version,
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at_utc,
           updated_by_app_user_id::text as updated_by_app_user_id
      from public.leave_department_approvers
     order by approver_assignment_id::text asc
  `);
  const canonicalJson = JSON.stringify(dataRows);
  return {
    columns,
    constraints,
    indexes,
    rls,
    rowCount: dataRows.length,
    rows: dataRows,
    sha256: sha256(canonicalJson),
  };
}

async function assertPost245CatalogInvariants(engine) {
  const { rows: [reg] } = await engine.query(`
    select pg_catalog.to_regclass('public.leave_department_approvers') as tbl,
           pg_catalog.to_regclass('public.leave_department_approvers_current_uidx') as idx
  `);
  assert.equal(reg.tbl, null, "public.leave_department_approvers must be dropped");
  assert.equal(reg.idx, null, "leave_department_approvers_current_uidx must be dropped");

  const { rows: procRefs } = await engine.query(`
    select p.oid::pg_catalog.regprocedure::text as sig
      from pg_catalog.pg_proc p
     where p.pronamespace = 'public'::pg_catalog.regnamespace
       and p.prokind in ('f', 'p')
       and p.prosrc ~* 'leave_department_approvers'
  `);
  assert.deepEqual(procRefs, [], "0 public routines may reference leave_department_approvers after #245");

  const stub = await inspectLegacyApproverStub(engine);
  assert.equal(stub.overload_count, 1);
  assert.equal(stub.prosecdef, true);
  assert.ok(stub.proconfig.includes("search_path=pg_catalog, public"));
  assert.equal(stub.pub_exec, false);
  assert.equal(stub.anon_exec, false);
  assert.equal(stub.auth_exec, false);
  assert.equal(stub.svc_exec, true);

  const preservedTables = [
    "public.leave_requests",
    "public.attendance_explanations",
    "public.leave_employee_profiles",
    "public.organization_department_heads",
    "public.leave_audit_events",
    "public.attendance_explanation_audit_events",
    "public.authz_audit_events",
    "public.authz_group_audit_events",
    "public.direct_entry_audit_events",
    "public.organization_department_audit_events",
    "public.vendor_finance_audit_events",
    "public.work_report_audit_events",
    "public.leave_module_grants",
    "public.direct_entry_capability_grants",
    "public.direct_entry_scope_grants",
    "public.authz_direct_capability_grants",
    "public.work_report_team_leader_capability_grants",
    "public.work_report_templates",
    "public.work_report_assignments",
    "public.work_report_obligations",
    "public.work_report_submissions",
    "public.work_report_metric_values",
  ];
  for (const tbl of preservedTables) {
    const { rows: [r] } = await engine.query("select pg_catalog.to_regclass($1) as oid", [tbl]);
    assert.ok(r.oid !== null, `Preserved table ${tbl} must remain intact`);
  }

  for (const [tbl, col] of [
    ["public.leave_requests", "unit_kind_snapshot"],
    ["public.attendance_explanations", "unit_kind_snapshot"],
    ["public.leave_employee_profiles", "unit_kind"],
  ]) {
    const { rows } = await engine.query(
      `select 1
         from pg_catalog.pg_attribute a
        where a.attrelid = pg_catalog.to_regclass($1)
          and a.attname = $2
          and a.attnum > 0
          and not a.attisdropped`,
      [tbl, col],
    );
    assert.equal(rows.length, 1, `Preserved column ${tbl}.${col} must remain intact`);
  }
}

async function runPost245FunctionalMatrix(engine, { mode, onPre245Ready = null }) {
  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const dropIdx = files.indexOf(WP10_7_1B_MIGRATION_NAME);
  assert.ok(dropIdx > 0, "WP10-7 Slice 1B migration #245 must exist");
  assert.equal(dropIdx, files.length - 1, "WP10-7 Slice 1B migration #245 must be latest migration");
  const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(groupsIdx > 0 && groupsIdx < dropIdx);

  await engine.exec(ROLE_PREAMBLE);

  if (mode === "upgrade") {
    for (let i = 0; i < groupsIdx; i += 1) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(engine, OWNER);
    await seedLegacyAdmin(engine, LUANPT);
    await seedLegacyAdmin(engine, LIENVU);
    await seedLegacyAdmin(engine, NGATTT);

    const plan = await runWp5Cutover(engine, { mode: "read-only-plan" });
    const applied = await runWp5Cutover(engine, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i < dropIdx; i += 1) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
  } else {
    for (let i = 0; i <= dropIdx; i += 1) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedFreshSystemAdmin(engine, OWNER, true);
    await seedFreshSystemAdmin(engine, LUANPT, false);
    await seedFreshSystemAdmin(engine, LIENVU, false);
    await seedFreshSystemAdmin(engine, NGATTT, false);
  }

  const dates = await computeDates(engine);
  await setBusinessDate(engine, dates.todayVn);

  const TEAM_REC = nextUuid();
  await engine.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'wp107_rec', 'Recruitment Team WP10-7', true, 1)`,
    [TEAM_REC],
  );

  const { rows: sysDeptRows } = await engine.query(
    "select department_id, system_key, name from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING')",
  );
  const deptByKey = Object.fromEntries(sysDeptRows.map((d) => [d.system_key, d.department_id]));
  assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.IT && deptByKey.ACCOUNTING);

  const mktHeadTu = await onboardOrgUser(engine, `mkttu_${mode}`, deptByKey.MARKETING, "Nguyễn Kim Tú");
  await designateDeptHead(engine, deptByKey.MARKETING, mktHeadTu.person.person_id, "Bổ nhiệm Nguyễn Kim Tú");
  const mktEmp = await onboardOrgUser(engine, `mktemp_${mode}`, deptByKey.MARKETING, "Nhân viên Marketing");

  const recTl = await onboardOrgUser(engine, `rectl_${mode}`, deptByKey.RECRUITMENT, "Recruitment TL", {
    withRecruiter: true,
    position: "TEAM_LEADER",
    teamId: TEAM_REC,
  });
  await engine.serviceRpc("direct_entry_designate_team_leader", [
    OWNER.auth, OWNER.app, TEAM_REC, recTl.acc.app, null, 1, "Designate Rec TL", nextUuid(),
  ]);
  const recEmp = await onboardOrgUser(engine, `recemp_${mode}`, deptByKey.RECRUITMENT, "Recruitment Member", {
    withRecruiter: true,
    teamId: TEAM_REC,
  });

  const acctEmp = await onboardOrgUser(engine, `acct_${mode}`, deptByKey.ACCOUNTING, "Accounting Employee");
  const itEmp = await onboardOrgUser(engine, `it_${mode}`, deptByKey.IT, "IT Employee");

  // Historical APPROVED leave requests missing routed_department_id (seeded before #245 in upgrade mode)
  let histLeaveForHeadCancel;
  let histLeaveForAdminCancel;

  async function createApprovedNullDeptLeave(day, tag) {
    const lr = await engine.serviceRpc("leave_management_create_request", [
      mktEmp.acc.auth, mktEmp.acc.app,
      JSON.stringify([{ leave_date: day, session_code: "AM", leave_type: "ANNUAL" }]),
      `Hist leave ${tag}`, `hist-l-${tag}-${seq++}`, sha256(`hist-l-${tag}`),
    ]);
    await engine.serviceRpc("leave_management_decide_request", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, lr.request.request_id, "APPROVE", 1,
      `Approve ${tag}`, `hist-la-${tag}-${seq++}`, sha256(`hist-la-${tag}`),
    ]);
    await engine.query(
      "update public.leave_requests set routed_department_id = null, routed_department_code = null, routed_department_name = null where request_id = $1::uuid",
      [lr.request.request_id],
    );
    return lr.request.request_id;
  }

  if (mode === "upgrade") {
    histLeaveForHeadCancel = await createApprovedNullDeptLeave(dates.leaveDays[0], "upg-head");
    histLeaveForAdminCancel = await createApprovedNullDeptLeave(dates.leaveDays[1], "upg-adm");

    // Seed representative rows in legacy public.leave_department_approvers on #244:
    //   - MARKETING active row (bound via n8nAuthSubject/n8nAppUserId to test manifest helper on #244 vs #245)
    //   - IT active row
    //   - MARKETING historical non-current row (exercising valid_to, is_current=false, updated_by_app_user_id)
    //   - ACCOUNTING row with reason=null
    const legacySvcApprover = await seedPlainAccount(engine, "wp107.svcleg", "Legacy Binding Candidate");
    await engine.query(
      `insert into public.leave_department_approvers (
         approver_assignment_id, unit_kind, approver_app_user_id, valid_from, valid_to, is_current, reason, row_version, updated_by_app_user_id
       ) values
         ($1::uuid, 'MARKETING', $2::uuid, '2026-10-01', null, true, 'Pre-drop archive MARKETING', 1, $5::uuid),
         ($3::uuid, 'IT', $4::uuid, '2026-10-02', null, true, 'Pre-drop archive IT', 2, $5::uuid),
         ($6::uuid, 'MARKETING', $4::uuid, '2026-09-01', '2026-09-30', false, 'Historical closed row', 1, $7::uuid),
         ($8::uuid, 'ACCOUNTING', $4::uuid, '2026-10-03', null, true, null, 1, null)`,
      [
        nextUuid(),
        legacySvcApprover.app,
        nextUuid(),
        itEmp.acc.app,
        OWNER.app,
        nextUuid(),
        LUANPT.app,
        nextUuid(),
      ],
    );

    // Check operational manifest helper on #244 returns real leave_approver_total = 1
    const manifestBindings = {
      n8nAuthSubject: legacySvcApprover.auth,
      n8nAppUserId: legacySvcApprover.app,
    };
    const manifest244 = await engine.readOnly((c) =>
      buildLegacyTechnicalIdentityManifest(c, manifestBindings),
    );
    const svcCandidate244 = manifest244.candidates.find((c) => c.app_user_id === legacySvcApprover.app);
    assert.ok(svcCandidate244, "Binding candidate must appear in #244 manifest");
    assert.equal(svcCandidate244.human_contamination.leave_approver_total, 1, "On #244 manifest must return real leave_approver_total = 1");
    assert.equal(svcCandidate244.classification, "BLOCKED_HUMAN_OR_OWNER_CONFLICT");

    // WP2A shadow preflight passes on #244 while leave_department_approvers still exists
    await assertWp2aShadowSchemaCompatible(engine);

    if (onPre245Ready) {
      await onPre245Ready({ engine, dates });
    }

    // Apply #245
    await engine.exec(await readFile(path.join(MIGRATION_DIR, WP10_7_1B_MIGRATION_NAME), "utf8"));

    // Check operational manifest helper on #245 projects leave_approver_total = 0 cleanly
    const manifest245 = await engine.readOnly((c) =>
      buildLegacyTechnicalIdentityManifest(c, manifestBindings),
    );
    const svcCandidate245 = manifest245.candidates.find((c) => c.app_user_id === legacySvcApprover.app);
    assert.ok(svcCandidate245, "Binding candidate must still appear cleanly in #245 manifest");
    assert.equal(svcCandidate245.human_contamination.leave_approver_total, 0, "On #245 manifest must project leave_approver_total = 0 cleanly");
  } else {
    // Fresh install already has #245 applied; verify manifest returns cleanly with 0 candidates / no error
    const manifestFresh = await engine.readOnly((c) => buildLegacyTechnicalIdentityManifest(c));
    assert.ok(Array.isArray(manifestFresh.candidates));
    histLeaveForHeadCancel = await createApprovedNullDeptLeave(dates.leaveDays[0], "fresh-head");
    histLeaveForAdminCancel = await createApprovedNullDeptLeave(dates.leaveDays[1], "fresh-adm");
  }

  // WP2A shadow preflight must fail closed cleanly on #245
  await assert.rejects(
    () => assertWp2aShadowSchemaCompatible(engine),
    (err) => String(err?.message).includes("public.leave_department_approvers is absent on this target"),
    "WP2A shadow preflight must fail closed cleanly after #245",
  );

  // Assert post-#245 catalog invariants
  await assertPost245CatalogInvariants(engine);

  // =========================================================================
  // 2. Leave & Attendance Explanation Routing after #245
  // =========================================================================
  // 2a. Department Head: Marketing employee -> Nguyễn Kim Tú; Tú's own -> ADMIN_BOD_DIRECT
  const mktSummary = await engine.serviceRpc("leave_management_get_my_summary", [
    mktEmp.acc.auth, mktEmp.acc.app, dates.leaveYear,
  ]);
  assert.equal(mktSummary.routing.route_kind, "DEPARTMENT_HEAD");
  assert.equal(mktSummary.routing.primary_approver_app_user_id, mktHeadTu.acc.app);

  const mktLeave = await engine.serviceRpc("leave_management_create_request", [
    mktEmp.acc.auth, mktEmp.acc.app,
    JSON.stringify([{ leave_date: dates.leaveDays[2], session_code: "AM", leave_type: "ANNUAL" }]),
    "Post-245 MKT leave", `p245-mkt-l-${seq++}`, sha256("p245-mkt-l"),
  ]);
  assert.equal(mktLeave.request.route_kind, "DEPARTMENT_HEAD");
  assert.equal(mktLeave.request.primary_approver_app_user_id, mktHeadTu.acc.app);
  const { rows: [mktLeaveDb] } = await engine.query(
    "select routed_department_id::text, unit_kind_snapshot from public.leave_requests where request_id = $1::uuid",
    [mktLeave.request.request_id],
  );
  assert.equal(mktLeaveDb.routed_department_id, deptByKey.MARKETING);
  assert.equal(mktLeaveDb.unit_kind_snapshot, "MARKETING");

  const mktLeaveApp = await engine.serviceRpc("leave_management_decide_request", [
    mktHeadTu.acc.auth, mktHeadTu.acc.app, mktLeave.request.request_id, "APPROVE", 1,
    "Head approve leave", `p245-mkt-la-${seq++}`, sha256("p245-mkt-la"),
  ]);
  assert.equal(mktLeaveApp.request.status, "APPROVED");

  const mktExp = projectSubmitAttendanceExplanationResult(
    await engine.serviceRpc("attendance_submit_explanation", [
      mktEmp.acc.auth, mktEmp.acc.app, dates.expDates[0], "SLOT_1",
      "Post-245 MKT exp", nextUuid(), sha256("p245-mkt-e"),
    ]),
  );
  assert.ok(mktExp);
  assert.equal(mktExp.explanation.route_kind, "DEPARTMENT_HEAD");
  assert.equal(mktExp.explanation.primary_approver?.app_user_id, mktHeadTu.acc.app);
  const mktExpApp = await engine.serviceRpc("attendance_decide_explanation", [
    mktHeadTu.acc.auth, mktHeadTu.acc.app, mktExp.explanation.explanation_id, "APPROVE", 1,
    "Head approve exp", nextUuid(), sha256("p245-mkt-ea"),
  ]);
  assert.equal(mktExpApp.explanation.status, "APPROVED");

  // Head's own request -> ADMIN_BOD_DIRECT + self-approval forbidden; Admin approves cleanly
  const tuOwnLeave = await engine.serviceRpc("leave_management_create_request", [
    mktHeadTu.acc.auth, mktHeadTu.acc.app,
    JSON.stringify([{ leave_date: dates.leaveDays[3], session_code: "AM", leave_type: "ANNUAL" }]),
    "Tú own leave", `p245-tu-l-${seq++}`, sha256("p245-tu-l"),
  ]);
  assert.equal(tuOwnLeave.request.route_kind, "ADMIN_BOD_DIRECT");
  assert.equal(tuOwnLeave.request.primary_approver_app_user_id, null);
  await assert.rejects(
    () =>
      engine.serviceRpc("leave_management_decide_request", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, tuOwnLeave.request.request_id, "APPROVE", 1,
        "Self approve blocked", `p245-tu-self-l-${seq++}`, sha256("p245-tu-self-l"),
      ]),
    (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_SELF_APPROVAL_FORBIDDEN"),
  );
  const tuOwnLeaveApproved = await engine.serviceRpc("leave_management_decide_request", [
    OWNER.auth, OWNER.app, tuOwnLeave.request.request_id, "APPROVE", 1,
    "BoD approve head leave", `p245-tu-bod-l-${seq++}`, sha256("p245-tu-bod-l"),
  ]);
  assert.equal(tuOwnLeaveApproved.request.status, "APPROVED");

  const tuOwnExp = projectSubmitAttendanceExplanationResult(
    await engine.serviceRpc("attendance_submit_explanation", [
      mktHeadTu.acc.auth, mktHeadTu.acc.app, dates.expDates[1], "SLOT_1",
      "Tú own exp", nextUuid(), sha256("p245-tu-e"),
    ]),
  );
  assert.ok(tuOwnExp);
  assert.equal(tuOwnExp.explanation.route_kind, "ADMIN_BOD_DIRECT");
  assert.equal(tuOwnExp.explanation.primary_approver, null);
  await assert.rejects(
    () =>
      engine.serviceRpc("attendance_decide_explanation", [
        mktHeadTu.acc.auth, mktHeadTu.acc.app, tuOwnExp.explanation.explanation_id, "APPROVE", 1,
        "Self approve exp blocked", nextUuid(), sha256("p245-tu-self-e"),
      ]),
    (err) => err?.code === "42501" && String(err?.message).includes("ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN"),
  );
  const tuOwnExpApproved = await engine.serviceRpc("attendance_decide_explanation", [
    OWNER.auth, OWNER.app, tuOwnExp.explanation.explanation_id, "APPROVE", 1,
    "BoD approve head exp", nextUuid(), sha256("p245-tu-bod-e"),
  ]);
  assert.equal(tuOwnExpApproved.explanation.status, "APPROVED");

  // 2b. Team Leader: Recruitment employee -> TL; TL's own -> ADMIN_BOD_DIRECT
  const recLeave = await engine.serviceRpc("leave_management_create_request", [
    recEmp.acc.auth, recEmp.acc.app,
    JSON.stringify([{ leave_date: dates.leaveDays[4], session_code: "AM", leave_type: "ANNUAL" }]),
    "Post-245 REC leave", `p245-rec-l-${seq++}`, sha256("p245-rec-l"),
  ]);
  assert.equal(recLeave.request.route_kind, "TEAM_LEADER");
  assert.equal(recLeave.request.primary_approver_app_user_id, recTl.acc.app);
  const recLeaveApp = await engine.serviceRpc("leave_management_decide_request", [
    recTl.acc.auth, recTl.acc.app, recLeave.request.request_id, "APPROVE", 1,
    "TL approve", `p245-rec-la-${seq++}`, sha256("p245-rec-la"),
  ]);
  assert.equal(recLeaveApp.request.status, "APPROVED");

  const recExp = projectSubmitAttendanceExplanationResult(
    await engine.serviceRpc("attendance_submit_explanation", [
      recEmp.acc.auth, recEmp.acc.app, dates.expDates[2], "SLOT_1",
      "Post-245 REC exp", nextUuid(), sha256("p245-rec-e"),
    ]),
  );
  assert.ok(recExp);
  assert.equal(recExp.explanation.route_kind, "TEAM_LEADER");
  assert.equal(recExp.explanation.primary_approver?.app_user_id, recTl.acc.app);
  const recExpApp = await engine.serviceRpc("attendance_decide_explanation", [
    recTl.acc.auth, recTl.acc.app, recExp.explanation.explanation_id, "APPROVE", 1,
    "TL approve exp", nextUuid(), sha256("p245-rec-ea"),
  ]);
  assert.equal(recExpApp.explanation.status, "APPROVED");

  const recTlOwnLeave = await engine.serviceRpc("leave_management_create_request", [
    recTl.acc.auth, recTl.acc.app,
    JSON.stringify([{ leave_date: dates.leaveDays[5], session_code: "AM", leave_type: "ANNUAL" }]),
    "TL own leave", `p245-rectl-l-${seq++}`, sha256("p245-rectl-l"),
  ]);
  assert.equal(recTlOwnLeave.request.route_kind, "ADMIN_BOD_DIRECT");
  assert.equal(recTlOwnLeave.request.primary_approver_app_user_id, null);

  // 2c. BoD/Admin fallback & direct (ACCOUNTING & IT when no Org Dept Head)
  for (const [label, emp, dayIdx, expIdx] of [
    ["ACCOUNTING", acctEmp, 6, 3],
    ["IT", itEmp, 7, 4],
  ]) {
    const sum = await engine.serviceRpc("leave_management_get_my_summary", [
      emp.acc.auth, emp.acc.app, dates.leaveYear,
    ]);
    assert.equal(sum.routing.route_kind, "ADMIN_BOD_FALLBACK", `${label} leave summary fallback`);
    assert.equal(sum.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");
    assert.equal(sum.routing.primary_approver_app_user_id, null);

    const lr = await engine.serviceRpc("leave_management_create_request", [
      emp.acc.auth, emp.acc.app,
      JSON.stringify([{ leave_date: dates.leaveDays[dayIdx], session_code: "AM", leave_type: "ANNUAL" }]),
      `${label} fallback leave`, `p245-fb-l-${label}-${seq++}`, sha256(`p245-fb-l-${label}`),
    ]);
    assert.equal(lr.request.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(lr.request.primary_approver_app_user_id, null);
    const lrDec = await engine.serviceRpc("leave_management_decide_request", [
      LUANPT.auth, LUANPT.app, lr.request.request_id, "APPROVE", 1,
      `BoD approve ${label} fallback`, `p245-fb-la-${label}-${seq++}`, sha256(`p245-fb-la-${label}`),
    ]);
    assert.equal(lrDec.request.status, "APPROVED");

    const ov = projectAttendanceMyExplanationsOverview(
      await engine.serviceRpc("attendance_get_my_explanations_overview", [
        emp.acc.auth, emp.acc.app, dates.expDates[expIdx], 20, 0,
      ]),
    );
    assert.ok(ov);
    assert.equal(ov.routing.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(ov.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");

    const er = projectSubmitAttendanceExplanationResult(
      await engine.serviceRpc("attendance_submit_explanation", [
        emp.acc.auth, emp.acc.app, dates.expDates[expIdx], "SLOT_1",
        `${label} fallback exp`, nextUuid(), sha256(`p245-fb-e-${label}`),
      ]),
    );
    assert.ok(er);
    assert.equal(er.explanation.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(er.explanation.primary_approver, null);
    const erDec = await engine.serviceRpc("attendance_decide_explanation", [
      LUANPT.auth, LUANPT.app, er.explanation.explanation_id, "APPROVE", 1,
      `BoD approve ${label} fallback exp`, nextUuid(), sha256(`p245-fb-ea-${label}`),
    ]);
    assert.equal(erDec.explanation.status, "APPROVED");
  }

  // =========================================================================
  // 3. Cancel historical APPROVED leave request missing routed_department_id
  // =========================================================================
  const headCancelled = await engine.serviceRpc("leave_management_decide_request", [
    mktHeadTu.acc.auth, mktHeadTu.acc.app, histLeaveForHeadCancel, "CANCEL_APPROVED", 2,
    "Org Dept Head cancel historical APPROVED w/ null routed_department_id",
    `hist-can-head-${seq++}`, sha256(`hist-can-head-${histLeaveForHeadCancel}`),
  ]);
  assert.equal(headCancelled.request.status, "CANCELLED");

  const adminCancelled = await engine.serviceRpc("leave_management_decide_request", [
    OWNER.auth, OWNER.app, histLeaveForAdminCancel, "CANCEL_APPROVED", 2,
    "Admin/BoD cancel historical APPROVED w/ null routed_department_id",
    `hist-can-adm-${seq++}`, sha256(`hist-can-adm-${histLeaveForAdminCancel}`),
  ]);
  assert.equal(adminCancelled.request.status, "CANCELLED");

  for (const id of [histLeaveForHeadCancel, histLeaveForAdminCancel]) {
    const { rows: [r] } = await engine.query(
      "select status, routed_department_id, unit_kind_snapshot from public.leave_requests where request_id = $1::uuid",
      [id],
    );
    assert.equal(r.status, "CANCELLED");
    assert.equal(r.routed_department_id, null);
    assert.equal(r.unit_kind_snapshot, "MARKETING");
  }

  // =========================================================================
  // 4. SET_DEPARTMENT_APPROVER API 409 + SQL RPC stub PT409 + parser/label
  // =========================================================================
  const leaveRepo = createLeaveRepository(async (rpcName, args) => {
    try {
      const data = await engine.serviceRpc(rpcName, Object.values(args));
      return { data, error: null };
    } catch (err) {
      return { data: null, error: { code: err?.code, message: String(err?.message ?? err) } };
    }
  });
  const patchRes = await handlePatchLeaveAdminConfig(
    new Request("https://app.test/api/leave/admin/config", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
        host: "app.test",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        operation: "SET_DEPARTMENT_APPROVER",
        unit_kind: "MARKETING",
        approver_app_user_id: mktHeadTu.acc.app,
        valid_from: null,
        expected_row_version: 0,
        reason: "Retired check",
        idempotency_key: `wp107-api-409-${seq++}`,
      }),
    }),
    "true",
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: OWNER.auth,
            app_user_id: OWNER.app,
            enabled: true,
          },
        },
      }),
      repository: leaveRepo,
    },
  );
  assert.equal(patchRes.status, 409);
  assert.equal((await patchRes.json()).code, "LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN");

  const { rows: [countsBeforeStub] } = await engine.query(`
    select (select count(*)::int from public.leave_audit_events) as audit_cnt,
           (select count(*)::int from public.leave_idempotency_records) as idem_cnt
  `);
  await assert.rejects(
    () =>
      engine.serviceRpc("leave_management_set_department_approver_admin", [
        mktEmp.acc.auth, mktEmp.acc.app, "IT", mktEmp.acc.app, null, 0,
        "Non-admin stub call", `stub-non-${seq++}`, sha256("stub-non"),
      ]),
    (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN"),
  );
  for (const adm of [OWNER, LUANPT]) {
    await assert.rejects(
      () =>
        engine.serviceRpc("leave_management_set_department_approver_admin", [
          adm.auth, adm.app, "IT", mktHeadTu.acc.app, null, 0,
          "Admin stub call", `stub-adm-${seq++}`, sha256(`stub-adm-${adm.app}`),
        ]),
      (err) => err?.code === "PT409" && String(err?.message).includes("LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN"),
    );
  }
  const { rows: [countsAfterStub] } = await engine.query(`
    select (select count(*)::int from public.leave_audit_events) as audit_cnt,
           (select count(*)::int from public.leave_idempotency_records) as idem_cnt
  `);
  assert.deepEqual(countsAfterStub, countsBeforeStub, "Retired SQL stub must perform zero writes");

  // LEAVE_DEPARTMENT_APPROVER parser & UI label preserved
  const parsedGroups = projectAccountGroupsResponse({
    as_of: "2026-11-26T00:00:00Z",
    account_ref: mktHeadTu.acc.app,
    account_version: 1,
    enabled: true,
    memberships: [],
    resource_assignments: [
      {
        assignment_kind: "LEAVE_DEPARTMENT_APPROVER",
        resource_ref: "MARKETING",
        resource_label: "Marketing (Legacy)",
      },
    ],
  });
  assert.ok(parsedGroups, "projectAccountGroupsResponse must continue parsing LEAVE_DEPARTMENT_APPROVER");
  assert.equal(parsedGroups.resource_assignments[0].assignment_kind, "LEAVE_DEPARTMENT_APPROVER");
  assert.deepEqual(formatResourceAssignmentKindLabel("LEAVE_DEPARTMENT_APPROVER"), {
    label: "Người duyệt phép bộ phận",
    tone: "info",
  });

  // Live direct_entry_authz_get_account_groups_admin after #245 returns DEPARTMENT_HEAD, never LEAVE_DEPARTMENT_APPROVER
  const headGroups = await engine.serviceRpc("direct_entry_authz_get_account_groups_admin", [
    OWNER.auth, OWNER.app, mktHeadTu.acc.app,
  ]);
  assert.ok(
    headGroups.resource_assignments.some((a) => a.assignment_kind === "DEPARTMENT_HEAD"),
    "Active Org Dept Head must appear as DEPARTMENT_HEAD",
  );
  assert.equal(
    headGroups.resource_assignments.some((a) => a.assignment_kind === "LEAVE_DEPARTMENT_APPROVER"),
    false,
    "LEAVE_DEPARTMENT_APPROVER must never be emitted at runtime after #245",
  );
}

// =============================================================================
// TEST 1 (PGlite): Migration #245 hygiene, atomic rollback, RESTRICT, S0-T1-C ACL
// =============================================================================
test("WP10-7-1B #1 (PGlite): Migration #245 hygiene, atomic rollback zero drift, RESTRICT drop & S0-T1-C ACL (+0 net RPCs)", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP10_7_1B_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("\r\n"), false, "Migration #245 must use LF line endings");
  assert.equal(sql.replace(/--[^\n]*/g, "").includes("@"), false, "Migration #245 must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(sql), false, "Migration #245 must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(sql), false, "Migration #245 must contain zero '40001'");
  assert.equal(/alter default privileges/i.test(sql), false, "Migration #245 must contain zero ALTER DEFAULT PRIVILEGES");
  assert.match(sql, /drop\s+table\s+public\.leave_department_approvers\s+restrict\s*;/i);
  assert.equal(/drop\s+table\s+[^\n;]*\bcascade\b/i.test(sql), false, "Migration #245 must NEVER use CASCADE");

  const engine = await createPgliteEngine();
  try {
    await engine.exec(ROLE_PREAMBLE);
    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const dropIdx = files.indexOf(WP10_7_1B_MIGRATION_NAME);
    assert.ok(dropIdx > 0, "WP10-7 Slice 1B migration #245 must exist");
    const preApplied = files.slice(0, dropIdx);
    for (const name of preApplied) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    // Seed 1 row in public.leave_department_approvers to confirm atomic rollback preserves data too
    const dummyUser = await seedPlainAccount(engine, "wp107.rb", "Rollback Check User");
    await engine.query(
      `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, is_current, reason)
       values ('MARKETING', $1::uuid, '2026-10-01', true, 'Rollback probe')`,
      [dummyUser.app],
    );

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(preApplied.map((n) => [n, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);
    const preStub = await inspectLegacyApproverStub(engine);

    // Atomic rollback leaves zero drift
    const stripped = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await engine.exec("begin;");
    await engine.exec(stripped);
    await engine.exec("rollback;");

    const { rows: [afterRollback] } = await engine.query(`
      select pg_catalog.to_regclass('public.leave_department_approvers') as tbl,
             (select count(*)::int from public.leave_department_approvers) as cnt
    `);
    assert.ok(afterRollback.tbl !== null, "Atomic rollback must keep public.leave_department_approvers");
    assert.equal(afterRollback.cnt, 1, "Atomic rollback must preserve rows");
    assert.deepEqual(await inspectLegacyApproverStub(engine), preStub, "Atomic rollback must keep stub unchanged");

    // Apply #245 cleanly
    await engine.exec(sql);
    const postFlags = new Map([...preFlags, [WP10_7_1B_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(postCheck.details.actualServiceCount, preCheck.details.actualServiceCount, "+0 net service_role RPCs");
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "0 client/PUBLIC EXECUTE grants");

    await assertPost245CatalogInvariants(engine);
  } finally {
    await engine.close();
  }
});

// =============================================================================
// TEST 2 (PGlite): Upgrade path (0..244 -> #245)
// =============================================================================
test("WP10-7-1B #2 (PGlite): Upgrade path (0..244 -> #245) routing, historical cancel, 409/PT409 & manifest", async () => {
  const engine = await createPgliteEngine();
  try {
    await runPost245FunctionalMatrix(engine, { mode: "upgrade" });
  } finally {
    await engine.close();
  }
});

// =============================================================================
// TEST 3 (PGlite): Fresh install (0..245)
// =============================================================================
test("WP10-7-1B #3 (PGlite): Fresh install (0..245) routing, historical cancel, 409/PT409 & manifest", async () => {
  const engine = await createPgliteEngine();
  try {
    await runPost245FunctionalMatrix(engine, { mode: "fresh" });
  } finally {
    await engine.close();
  }
});

// =============================================================================
// TEST 4 (Isolated Real PostgreSQL 18): Upgrade (0..244 -> #245), Fresh (0..245),
//        Archive & Restore Drill (pg_dump + psql), and Operational Tools
// =============================================================================
test("WP10-7-1B #4 (Real PG18): Upgrade + Fresh Install + Archive/Restore Drill (SHA-256) + Routing/Cancel/409", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  const pgDump = binary("pg_dump");
  const psqlBin = binary("psql");
  assert.ok(initdb && pgCtl && pgDump && psqlBin, "PostgreSQL 18 initdb/pg_ctl/pg_dump/psql binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-1b-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const archiveSqlPath = path.join(tmpDir, "leave_department_approvers_archive.sql");
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

    const upgradeClient = await connectPg(port, "wp10-7-1b-upgrade", "postgres");
    clients.push(upgradeClient);
    const upgradeEngine = wrapPgClient(upgradeClient, "PG18-upgrade");

    let preDropSnapshot = null;
    await runPost245FunctionalMatrix(upgradeEngine, {
      mode: "upgrade",
      onPre245Ready: async ({ engine }) => {
        preDropSnapshot = await snapshotLeaveDeptApproversSchemaAndRows(engine);
        assert.equal(preDropSnapshot.rowCount, 4, "Must snapshot 4 seeded rows before #245");
        assert.equal(preDropSnapshot.columns.length, 11, "Must capture all 11 columns");
        assert.equal(preDropSnapshot.indexes.length, 2, "Must capture PK + current_uidx indexes");
        assert.equal(preDropSnapshot.rls.relrowsecurity, true);
        assert.equal(preDropSnapshot.rls.relforcerowsecurity, true);

        // Dump table DDL, constraints, indexes, RLS, and rows via pg_dump
        runBin(pgDump, [
          "-h", "127.0.0.1",
          "-p", String(port),
          "-U", "postgres",
          "-d", "postgres",
          "--table=public.leave_department_approvers",
          "--no-owner",
          "--no-privileges",
          "-f", archiveSqlPath,
        ]);
      },
    });
    assert.ok(preDropSnapshot, "Archive snapshot must have been captured on #244");

    // Restore drill into an isolated database in the same PG18 cluster
    await upgradeClient.query("create database wp10_7_1b_restore_drill");
    const restoreClient = await connectPg(port, "wp10-7-1b-restore", "wp10_7_1b_restore_drill");
    clients.push(restoreClient);

    // Seed referenced FK user IDs into minimal direct_entry_app_users in isolated DB so real FKs validate
    const fkUserIds = [
      ...new Set(
        preDropSnapshot.rows
          .flatMap((r) => [r.approver_app_user_id, r.updated_by_app_user_id])
          .filter(Boolean),
      ),
    ];
    await restoreClient.query(
      "create table public.direct_entry_app_users (app_user_id uuid primary key)",
    );
    await restoreClient.query(
      "insert into public.direct_entry_app_users (app_user_id) select unnest($1::uuid[])",
      [fkUserIds],
    );

    runBin(psqlBin, [
      "-h", "127.0.0.1",
      "-p", String(port),
      "-U", "postgres",
      "-d", "wp10_7_1b_restore_drill",
      "-v", "ON_ERROR_STOP=1",
      "-f", archiveSqlPath,
    ]);

    const restoreEngine = wrapPgClient(restoreClient, "PG18-restore-drill");
    const restoredSnapshot = await snapshotLeaveDeptApproversSchemaAndRows(restoreEngine);

    assert.deepEqual(restoredSnapshot.columns, preDropSnapshot.columns, "Restored columns must match 100%");
    assert.deepEqual(restoredSnapshot.constraints, preDropSnapshot.constraints, "Restored constraints must match 100%");
    assert.deepEqual(restoredSnapshot.indexes, preDropSnapshot.indexes, "Restored indexes must match 100%");
    assert.deepEqual(restoredSnapshot.rls, preDropSnapshot.rls, "Restored RLS flags must match 100%");
    assert.equal(restoredSnapshot.rowCount, preDropSnapshot.rowCount, "Restored row count must match 100%");
    assert.equal(restoredSnapshot.sha256, preDropSnapshot.sha256, "Restored canonical SHA-256 checksum must match 100%");

    // Fresh install (0..245) in another isolated database in the same PG18 cluster
    await upgradeClient.query("create database wp10_7_1b_fresh");
    const freshClient = await connectPg(port, "wp10-7-1b-fresh", "wp10_7_1b_fresh");
    clients.push(freshClient);
    const freshEngine = wrapPgClient(freshClient, "PG18-fresh");
    await runPost245FunctionalMatrix(freshEngine, { mode: "fresh" });
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
