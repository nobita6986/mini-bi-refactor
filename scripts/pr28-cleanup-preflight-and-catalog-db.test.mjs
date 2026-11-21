/**
 * PR #28 — Migration #237 Fail-Closed Preflight, Zero-Legacy-Refs Audit,
 * Dynamic S0-T1-C Allowlist & Cross-Module Post-Cleanup Functional Smoke (PGlite).
 *
 * Verifies:
 *   1. Migration #237 hygiene (LF, 0 @, 0 SAVEPOINT, 0 '40001', 0 ALTER DEFAULT PRIVILEGES),
 *      fail-closed preflight stop before any DDL when legacy SERVICE/SHARED or
 *      is_shared_non_employee=true rows exist, and atomic rollback zero drift.
 *   2. Post-#237 zero-legacy-refs audit:
 *      - 0 active public.* routines referencing account_type / is_shared_non_employee /
 *        'SHARED' / 'SERVICE'.
 *      - 0 direct_entry_app_users.account_type or leave_employee_profiles.is_shared_non_employee columns.
 *      - All 7 retired RPC signatures resolve NULL via to_regprocedure.
 *      - Clean 13-arg leave_management_upsert_employee_profile_admin has service_role-only EXECUTE.
 *      - leave_management__internal_resolve_authority preserves direct_entry_catalog_bootstrap_executor grant.
 *      - Historical audit CHECK constraint preserves 'ACCOUNT_TYPE_UPDATED'.
 *      - Dynamic S0-T1-C security postconditions PASS (0 client/PUBLIC EXECUTE).
 *      - 0 non-test production files in src/ reference account_type or is_shared_non_employee.
 *      - Read-only manifest builder operates cleanly post-#237.
 *   3. Post-#237 end-to-end cross-module functional smoke:
 *      - Unlinked legacy personal account (39 UAT model), active Person, Permission Groups,
 *        direct_entry_resolve_actor_context (keeping capabilities/scopes/allowed_worker_tabs),
 *        direct_entry_list_app_users_admin (6-key clean projection),
 *        leave_management_get_actor_access (5-key clean projection),
 *        13-arg leave_management_upsert_employee_profile_admin,
 *        attendance_get_my_explanations_overview (clean viewer without is_shared_non_employee),
 *        and Owner is_protected lock.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  PR28_CLEANUP_ADDED_RPC_SIGNATURES,
  PR28_CLEANUP_MIGRATION_NAME,
  PR28_CLEANUP_RETIRED_RPC_SIGNATURES,
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  migrationChecksum,
  migrationSqlForTransaction,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { buildLegacyTechnicalIdentityManifest } from "./lib/pr28-legacy-identity-manifest.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const OWNER = {
  auth: "19000000-0000-4000-8000-000000000001",
  app: "29000000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Cleanup Smoke",
};
const LUANPT = {
  auth: "19000000-0000-4000-8000-000000000002",
  app: "29000000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT Smoke",
};
const LIENVU = {
  auth: "19000000-0000-4000-8000-000000000003",
  app: "29000000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu Smoke",
};
const NGATTT = {
  auth: "19000000-0000-4000-8000-000000000004",
  app: "29000000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT Smoke",
};
const UNLINKED_LEGACY = {
  auth: "19000000-0000-4000-8000-000000000011",
  app: "29000000-0000-4000-8000-000000000011",
  email: "legacy.personal@hrpartner.vn",
  name: "Legacy Unlinked Personal",
};
const LINKED_EMP = {
  auth: "19000000-0000-4000-8000-000000000012",
  app: "29000000-0000-4000-8000-000000000012",
  email: "linked.emp@hrpartner.vn",
  name: "Linked Active Employee",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `99000000-0000-4000-8000-${hex}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

let cachedMigrations = null;
async function loadMigrations() {
  if (cachedMigrations) return cachedMigrations;
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  cachedMigrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
      return { name, sql, checksum: migrationChecksum(sql) };
    }),
  );
  return cachedMigrations;
}

async function serviceQuery(db, sql, params = []) {
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const res = await db.query(sql, params);
    await db.exec("commit");
    return res;
  } catch (error) {
    await db.exec("rollback").catch(() => {});
    throw error;
  }
}

test("1. Migration #237 hygiene, fail-closed preflight gate before DDL, and atomic rollback zero drift", async () => {
  const migrations = await loadMigrations();
  const cleanupIdx = migrations.findIndex((m) => m.name === PR28_CLEANUP_MIGRATION_NAME);
  assert.ok(cleanupIdx > 0, `${PR28_CLEANUP_MIGRATION_NAME} must exist`);
  const cleanup = migrations[cleanupIdx];
  const noComments = cleanup.sql.replace(/--[^\n]*/g, "");

  assert.equal(cleanup.sql.includes("\r"), false, "LF line endings only");
  assert.equal(cleanup.sql.includes("@"), false, "zero literal @");
  assert.equal(/\bsavepoint\b/i.test(noComments), false, "zero SAVEPOINT");
  assert.equal(noComments.includes("'40001'"), false, "zero '40001'");
  assert.equal(/alter\s+default\s+privileges/i.test(noComments), false, "zero ALTER DEFAULT PRIVILEGES");
  assert.match(noComments.trim(), /^begin;/i);
  assert.match(noComments.trim(), /commit;$/i);

  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    for (let i = 0; i < cleanupIdx; i += 1) {
      await db.exec(migrations[i].sql);
    }

    // Seed an unresolved SERVICE account -> #237 MUST fail closed BEFORE any DDL
    const svcAuth = "19000000-0000-4000-8000-000000000091";
    const svcApp = "29000000-0000-4000-8000-000000000091";
    await db.query("insert into auth.users (id, email) values ($1::uuid, 'svc@local')", [svcAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type) values ($1::uuid, $2::uuid, 'Legacy Service', false, 'SERVICE')",
      [svcApp, svcAuth],
    );
    await assert.rejects(
      () => db.exec(cleanup.sql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES"),
      "SERVICE row must block #237 before DDL",
    );
    await db.exec("rollback").catch(() => {});

    // Verify 0 DDL leaked after abort (account_type + hrp_sync_catalog still exist)
    const afterSvcAbort = await db.query(`
      select
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='direct_entry_app_users' and column_name='account_type') as has_account_type,
        (to_regprocedure('public.hrp_sync_catalog(uuid, uuid, uuid)') is not null) as has_hrp_sync
    `);
    assert.deepEqual(afterSvcAbort.rows[0], { has_account_type: true, has_hrp_sync: true });

    // Switch to SHARED -> MUST ALSO fail closed BEFORE any DDL
    await db.query("update public.direct_entry_app_users set account_type = 'SHARED' where app_user_id = $1::uuid", [svcApp]);
    await assert.rejects(
      () => db.exec(cleanup.sql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES"),
      "SHARED row must block #237 before DDL",
    );
    await db.exec("rollback").catch(() => {});

    // Clear account_type to NORMAL, set leave_employee_profiles.is_shared_non_employee = true -> MUST fail closed
    await db.query("update public.direct_entry_app_users set account_type = 'NORMAL' where app_user_id = $1::uuid", [svcApp]);
    await db.query(
      "insert into public.leave_employee_profiles (app_user_id, unit_kind, is_shared_non_employee) values ($1::uuid, 'UNCLASSIFIED', true)",
      [svcApp],
    );
    await assert.rejects(
      () => db.exec(cleanup.sql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_SHARED_PROFILES"),
      "is_shared_non_employee=true must block #237 before DDL",
    );
    await db.exec("rollback").catch(() => {});

    // Clear shared flag -> atomic ROLLBACK rehearsal leaves zero schema drift
    await db.query("update public.leave_employee_profiles set is_shared_non_employee = false where app_user_id = $1::uuid", [svcApp]);
    await db.exec(`begin;\n${migrationSqlForTransaction(cleanup.sql)}\nrollback;`);
    const afterRollback = await db.query(`
      select
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='direct_entry_app_users' and column_name='account_type') as has_account_type,
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='leave_employee_profiles' and column_name='is_shared_non_employee') as has_shared_col
    `);
    assert.deepEqual(afterRollback.rows[0], { has_account_type: true, has_shared_col: true });

    // Forward apply succeeds cleanly once legacy rows are resolved
    await db.exec(cleanup.sql);
    const afterApply = await db.query(`
      select
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='direct_entry_app_users' and column_name='account_type') as has_account_type,
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='leave_employee_profiles' and column_name='is_shared_non_employee') as has_shared_col
    `);
    assert.deepEqual(afterApply.rows[0], { has_account_type: false, has_shared_col: false });
  } finally {
    await db.close();
  }
});

test("2. Post-#237 zero-legacy-refs audit, dynamic S0-T1-C allowlist, bootstrap grant, history preservation & src/ scan", async () => {
  const migrations = await loadMigrations();
  const s0Sql = migrations.find((m) => m.name === S0_T1_C_MIGRATION_NAME).sql;
  const cleanupIdx = migrations.findIndex((m) => m.name === PR28_CLEANUP_MIGRATION_NAME);

  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    const applied = new Set();
    for (let i = 0; i <= cleanupIdx; i += 1) {
      await db.exec(migrations[i].sql);
      applied.add(migrations[i].name);
    }

    // Zero active public.* routines reference retired concepts
    const { rows: legacyProcs } = await db.query(`
      select p.oid::regprocedure::text as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind in ('f', 'p')
         and (
           pg_catalog.pg_get_functiondef(p.oid) ~* '\\m(account_type|is_shared_non_employee)\\M'
           or pg_catalog.pg_get_functiondef(p.oid) ~ '''(SHARED|SERVICE)'''
         )
    `);
    assert.deepEqual(legacyProcs, [], `0 active public routines may reference retired columns/types: ${JSON.stringify(legacyProcs)}`);

    // All 7 retired signatures are gone
    for (const sig of PR28_CLEANUP_RETIRED_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as reg", [sig]);
      assert.equal(rows[0].reg, null, `retired signature must be absent: ${sig}`);
    }

    // Clean 13-arg leave_management_upsert_employee_profile_admin exists with service_role-only EXECUTE
    for (const sig of PR28_CLEANUP_ADDED_RPC_SIGNATURES) {
      const { rows } = await db.query(
        `select
           to_regprocedure($1) is not null as exists,
           has_function_privilege('service_role', $1, 'EXECUTE') as svc_exec,
           has_function_privilege('authenticated', $1, 'EXECUTE') as auth_exec,
           has_function_privilege('anon', $1, 'EXECUTE') as anon_exec,
           has_function_privilege('public', $1, 'EXECUTE') as pub_exec`,
        [sig],
      );
      assert.deepEqual(rows[0], {
        exists: true,
        svc_exec: true,
        auth_exec: false,
        anon_exec: false,
        pub_exec: false,
      });
    }

    // Bootstrap executor grant on leave_management__internal_resolve_authority preserved
    const { rows: bootRows } = await db.query(`
      select
        has_function_privilege('direct_entry_catalog_bootstrap_executor', 'public.leave_management__internal_resolve_authority(uuid, uuid)', 'EXECUTE') as boot_exec,
        has_function_privilege('service_role', 'public.leave_management__internal_resolve_authority(uuid, uuid)', 'EXECUTE') as svc_exec,
        has_function_privilege('authenticated', 'public.leave_management__internal_resolve_authority(uuid, uuid)', 'EXECUTE') as auth_exec,
        has_function_privilege('anon', 'public.leave_management__internal_resolve_authority(uuid, uuid)', 'EXECUTE') as anon_exec
    `);
    assert.deepEqual(bootRows[0], {
      boot_exec: true,
      svc_exec: false,
      auth_exec: false,
      anon_exec: false,
    });

    // Historical audit & idempotency CHECK constraints still accept 'ACCOUNT_TYPE_UPDATED'
    const { rows: chkRows } = await db.query(`
      select conname, pg_catalog.pg_get_constraintdef(oid) as def
        from pg_catalog.pg_constraint
       where conname in (
         'organization_department_audit_events_action_chk',
         'organization_department_idempotency_action_chk'
       )
       order by conname
    `);
    assert.equal(chkRows.length, 2);
    for (const r of chkRows) {
      assert.ok(r.def.includes("ACCOUNT_TYPE_UPDATED"), `${r.conname} must preserve ACCOUNT_TYPE_UPDATED history`);
    }

    // Dynamic S0-T1-C security postconditions PASS
    const postCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, applied);
    assert.equal(postCheck.ok, true, `S0-T1-C postconditions failed: ${JSON.stringify(postCheck)}`);
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
    assert.equal(postCheck.details.missingAllowlistCount, 0);

    // Manifest builder operates cleanly post-#237
    const postManifest = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(postManifest.schema_state.has_account_type_column, false);
    assert.equal(postManifest.schema_state.has_is_shared_non_employee_column, false);
    assert.equal(postManifest.overall_status, "NO_CANDIDATES");
    assert.equal(postManifest.cleanup_migration_safe, true);

    // Zero non-test production files in src/ reference account_type or is_shared_non_employee
    const prodSrcFiles = walkFiles(path.join(ROOT, "src")).filter(
      (f) => !f.endsWith(".test.mjs") && !f.endsWith(".test.ts"),
    );
    const offending = [];
    for (const full of prodSrcFiles) {
      const txt = readFileSync(full, "utf8");
      if (/\b(account_type|is_shared_non_employee)\b/.test(txt)) {
        offending.push(path.relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
    assert.deepEqual(offending, [], `0 production src/ files may reference retired columns: ${JSON.stringify(offending)}`);
  } finally {
    await db.close();
  }
});

test("3. Post-#237 cross-module E2E smoke: unlinked personal account, active Person, 13-arg Leave upsert, Attendance, Groups & Owner lock", async () => {
  const migrations = await loadMigrations();
  const grpIdx = migrations.findIndex((m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(grpIdx > 0);
  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    // Mirror real production rollout path: #001..#235 -> WP5 cutover -> #236 (auto-backfills Owner protected SYSTEM_ADMIN group) -> #237
    for (let i = 0; i < grpIdx; i += 1) {
      await db.exec(migrations[i].sql);
    }

    for (const u of [OWNER, LUANPT, LIENVU, NGATTT, UNLINKED_LEGACY, LINKED_EMP]) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }

    // Legacy admin grants for Owner + 3 named BoD/Admin accounts before cutover
    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2020-01-01', true), ($1::uuid, 'own', null, '2020-01-01', true)",
        [adm.app],
      );
      for (const cap of [
        "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
        "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
        "audit_view", "worker_edit_history_view", "document_upload", "document_view",
        "employment_status.review", "employment_status.apply", "change_request_create",
        "change_review", "employment_status.request", "duplicate_cccd_withdraw",
      ]) {
        await db.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2020-01-01', true)",
          [adm.app, cap],
        );
      }
    }

    // Run WP5 cutover cleanly before applying #236 + #237
    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
      actorAppUserId: OWNER.app,
      reason: "PR28 post-#237 smoke cutover",
    });

    // Apply #236 + #237 (and any trailing migrations)
    for (let i = grpIdx; i < migrations.length; i += 1) {
      await db.exec(migrations[i].sql);
    }

    // Seed active Person for LINKED_EMP
    const deptRows = await db.query(
      "select department_id::text as id from public.organization_departments where system_key = 'RECRUITMENT' limit 1",
    );
    const deptId = deptRows.rows[0].id;
    const empVerRes = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [LINKED_EMP.app],
    );
    const createKey = nextUuid();
    await serviceQuery(
      db,
      `select public.org_department_create_person_admin(
         $1::uuid, $2::uuid, 'EMP-237', 'Linked Active Employee', '2025-01-10'::date,
         $3::uuid, $4::uuid, $5::integer, null::uuid, 'Smoke person', $6::uuid, $7::text
       )`,
      [OWNER.auth, OWNER.app, deptId, LINKED_EMP.app, empVerRes.rows[0].version, createKey, sha256(createKey)],
    );

    // 3a. Unified directory lists UNLINKED_LEGACY without fabricating Person and with 0 account_type keys
    const dirRes = await serviceQuery(
      db,
      "select public.org_department_list_user_directory_admin($1::uuid, $2::uuid, null, 'unlinked_account', 'all', 'all', null, null, 1, 25) as payload",
      [OWNER.auth, OWNER.app],
    );
    const unlinkedRow = dirRes.rows[0].payload.entries.find((e) => e.account_ref === UNLINKED_LEGACY.app);
    assert.ok(unlinkedRow, "unlinked legacy personal account remains manageable in unified directory");
    assert.equal(unlinkedRow.record_kind, "UNLINKED_ACCOUNT");
    assert.equal(JSON.stringify(dirRes.rows[0].payload).includes("account_type"), false);

    // 3b. direct_entry_list_app_users_admin returns exact 6-key clean projection without account_type
    const listRes = await serviceQuery(
      db,
      "select public.direct_entry_list_app_users_admin($1::uuid, $2::uuid, null, 'all', 1, 25) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.deepEqual(Object.keys(listRes.rows[0].payload.accounts[0]).sort(), [
      "account_ref",
      "active_person_link",
      "display_name",
      "enabled",
      "login_id",
      "version",
    ]);

    // 3c. direct_entry_resolve_actor_context keeps capabilities/scopes/allowed_worker_tabs (Bổ sung 4.2 mobile compat)
    const ctxRes = await serviceQuery(
      db,
      "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
      [OWNER.auth],
    );
    const ctx = ctxRes.rows[0].payload;
    assert.equal(ctx.app_user_id, OWNER.app);
    assert.equal(ctx.enabled, true);
    assert.ok(Array.isArray(ctx.capabilities) && ctx.capabilities.includes("entry_admin"));
    assert.ok(Array.isArray(ctx.all_scope_grants) && ctx.all_scope_grants.length >= 1);
    assert.ok(Array.isArray(ctx.effective_grants) && ctx.effective_grants.length >= 1);
    assert.ok(Array.isArray(ctx.allowed_worker_tabs));

    // 3d. Clean 13-arg leave_management_upsert_employee_profile_admin succeeds & leave_management_get_actor_access returns clean 5-key JSON
    const upsertKey = `smoke-13arg-${nextUuid()}`;
    const upsertRes = await serviceQuery(
      db,
      `select public.leave_management_upsert_employee_profile_admin(
         $1::uuid, $2::uuid, $3::uuid, 'OFFICIAL', 'RECRUITMENT',
         '2025-01-10'::date, '2025-03-10'::date, null::date,
         0, null::integer, 'Smoke 13-arg profile upsert', $4::text, $5::text
       ) as payload`,
      [OWNER.auth, OWNER.app, LINKED_EMP.app, upsertKey, sha256(upsertKey)],
    );
    assert.equal(upsertRes.rows[0].payload.profile.employment_status, "OFFICIAL");
    assert.equal("is_shared_non_employee" in upsertRes.rows[0].payload.profile, false);

    const leaveAccessRes = await serviceQuery(
      db,
      "select public.leave_management_get_actor_access($1::uuid, $2::uuid) as payload",
      [UNLINKED_LEGACY.auth, UNLINKED_LEGACY.app],
    );
    assert.deepEqual(Object.keys(leaveAccessRes.rows[0].payload).sort(), [
      "can_access",
      "can_approve_requests",
      "can_manage_config",
      "can_submit_request",
      "can_view_monthly_report",
    ]);
    assert.equal(leaveAccessRes.rows[0].payload.can_submit_request, true);

    // 3e. attendance_get_my_explanations_overview returns clean viewer without is_shared_non_employee
    const attRes = await serviceQuery(
      db,
      "select public.attendance_get_my_explanations_overview($1::uuid, $2::uuid, null::date, 20, 0) as payload",
      [UNLINKED_LEGACY.auth, UNLINKED_LEGACY.app],
    );
    assert.equal(attRes.rows[0].payload.viewer.can_submit_explanation, true);
    assert.equal("is_shared_non_employee" in attRes.rows[0].payload.viewer, false);

    // 3f. Expanded post-#237 cross-module smoke across Work Reports, Leave, Attendance, Salary Advance, Vendor Finance & Direct Entry
    const wrDelRes = await serviceQuery(
      db,
      "select public.work_report_list_delegations($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(wrDelRes.rows[0].payload && Array.isArray(wrDelRes.rows[0].payload.items));

    const attNonEmpRes = await db.query(
      "select public.attendance__internal_is_non_employee_account($1::uuid, null::timestamptz) as is_non_emp",
      [UNLINKED_LEGACY.app],
    );
    assert.equal(attNonEmpRes.rows[0].is_non_emp, false);

    const leaveMySumRes = await serviceQuery(
      db,
      "select public.leave_management_get_my_summary($1::uuid, $2::uuid, 2026) as payload",
      [UNLINKED_LEGACY.auth, UNLINKED_LEGACY.app],
    );
    assert.ok(leaveMySumRes.rows[0].payload);

    const leaveAdminOverviewRes = await serviceQuery(
      db,
      "select public.leave_management_get_admin_overview($1::uuid, $2::uuid, null, 25, 0, 'all') as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(leaveAdminOverviewRes.rows[0].payload);
    assert.equal(JSON.stringify(leaveAdminOverviewRes.rows[0].payload).includes("is_shared_non_employee"), false);

    const leaveMonthRes = await serviceQuery(
      db,
      "select public.leave_management_monthly_report($1::uuid, $2::uuid, '2026-11', null, null, 25, 0) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(leaveMonthRes.rows[0].payload);

    const salAuthRes = await db.query(
      "select public.salary_advance__internal_resolve_authority($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(salAuthRes.rows[0].payload);

    const vfinAuthRes = await db.query(
      "select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(vfinAuthRes.rows[0].payload);

    const vfinGlobalRes = await serviceQuery(
      db,
      "select public.vendor_finance_list_global_roles_admin($1::uuid, $2::uuid, null, true, 1, 25) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(vfinGlobalRes.rows[0].payload);

    const vfinMonthlyRes = await serviceQuery(
      db,
      "select public.vendor_finance_get_monthly_report($1::uuid, $2::uuid, '2026-11', null, null, null, 'all') as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(vfinMonthlyRes.rows[0].payload);

    const matrixCatalogRes = await serviceQuery(
      db,
      "select public.direct_entry_reporting_detailed_matrix_catalog($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(matrixCatalogRes.rows[0].payload);

    const workerAudRes = await db.query(
      "select public.direct_entry_worker_directory_audience($1::uuid, $2::uuid, 'all', null) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.ok(workerAudRes.rows[0].payload);

    // 3g. Owner SYSTEM_ADMIN group membership remains DB-protected (cannot be removed)
    const ownerGroupRes = await db.query(
      `select m.membership_id::text as membership_id, u.version as account_version
         from public.authz_user_group_members m
         join public.direct_entry_app_users u on u.app_user_id = m.app_user_id
        where m.app_user_id = $1::uuid and m.is_protected = true and m.ended_at is null`,
      [OWNER.app],
    );
    assert.equal(ownerGroupRes.rows.length, 1);
    const rmKey = nextUuid();
    await assert.rejects(
      () =>
        serviceQuery(
          db,
          "select public.direct_entry_authz_remove_group_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Attempt revoke Owner', $6::uuid, $7::text)",
          [
            OWNER.auth,
            OWNER.app,
            OWNER.app,
            ownerGroupRes.rows[0].membership_id,
            ownerGroupRes.rows[0].account_version,
            rmKey,
            sha256(rmKey),
          ],
        ),
      (err) => err?.code === "PT409" && String(err?.message ?? "").includes("AUTHZ_PROTECTED_ASSIGNMENT"),
    );
  } finally {
    await db.close();
  }
});
