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

    // All 17 retired service_role RPC signatures + dead org helper are gone
    for (const sig of [
      ...PR28_CLEANUP_RETIRED_RPC_SIGNATURES,
      "public.org_department__internal_has_personal_assignments(uuid, timestamp with time zone)",
    ]) {
      const { rows } = await db.query("select to_regprocedure($1)::text as reg", [sig]);
      assert.equal(rows[0].reg, null, `retired signature must be absent: ${sig}`);
    }

    // Zero active runtime public.* routines read/write retired per-account role/direct/module tables
    const { rows: retiredAuthzProcs } = await db.query(`
      select p.proname, p.oid::regprocedure::text as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind in ('f', 'p')
         and p.proname not in (
           'direct_entry_authz__internal_backfill_legacy_to_groups',
           'vendor_finance__internal_global_role_guard',
           'vendor_finance__internal_reset_transactional_ledgers'
         )
         and regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~* '\\m(authz_account_role_assignments|authz_direct_capability_grants|vendor_finance_global_roles|leave_module_grants)\\M'
    `);
    assert.deepEqual(
      retiredAuthzProcs,
      [],
      `0 active runtime public routines may touch retired per-account authz/module tables: ${JSON.stringify(retiredAuthzProcs)}`,
    );

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

    const ownerGroupsRes = await serviceQuery(
      db,
      "select public.direct_entry_authz_get_account_groups_admin($1::uuid, $2::uuid, $3::uuid) as payload",
      [OWNER.auth, OWNER.app, OWNER.app],
    );
    assert.ok(ownerGroupsRes.rows[0].payload?.memberships?.some((m) => m.group_code === "SYSTEM_ADMIN"));

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

test("4. PR28-T0-R1 Cutover Oracle: pre-upgrade HR_OPERATOR & group-only control lose catalog_master_manage immediately on group edit/disable/remove with provenance & history preserved", async () => {
  const migrations = await loadMigrations();
  const grpIdx = migrations.findIndex((m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(grpIdx > 0);
  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    for (let i = 0; i < grpIdx; i += 1) {
      await db.exec(migrations[i].sql);
    }

    const MIGRATED_HR = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "migrated.hr@hrpartner.vn",
      name: "Migrated HR Operator",
    };
    const PURE_HR = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "pure.hr@hrpartner.vn",
      name: "Group Only HR Operator",
    };

    for (const u of [OWNER, LUANPT, LIENVU, NGATTT, MIGRATED_HR, PURE_HR]) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2020-01-01', true)",
        [adm.app],
      );
      for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
        await db.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2020-01-01', true)",
          [adm.app, cap],
        );
      }
    }

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
      actorAppUserId: OWNER.app,
      reason: "R1 pre-upgrade cutover",
    });

    // Assign legacy HR_OPERATOR global role to MIGRATED_HR BEFORE #236
    const assignRoleKey = nextUuid();
    await serviceQuery(
      db,
      `select public.direct_entry_authz_assign_global_role_admin(
         $1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'Pre-upgrade HR Operator', $4::uuid, $5::text
       )`,
      [OWNER.auth, OWNER.app, MIGRATED_HR.app, assignRoleKey, sha256(assignRoleKey)],
    );
    const origRoleRow = (
      await db.query(
        `select assignment_id::text as id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null`,
        [MIGRATED_HR.app],
      )
    ).rows[0];
    assert.ok(origRoleRow?.id);

    // Apply #236 + #237
    for (let i = grpIdx; i < migrations.length; i += 1) {
      await db.exec(migrations[i].sql);
    }

    // Verify MIGRATED_HR backfilled with exact relational provenance AND original history row preserved
    const provRows = (
      await db.query(
        `select m.membership_id::text, m.group_id::text, m.source_kind, m.migrated_from_source, m.migrated_from_id::text, g.code, g.version, g.department_id::text
           from public.authz_user_group_members m
           join public.authz_user_groups g on g.group_id = m.group_id
          where m.app_user_id = $1::uuid and m.ended_at is null`,
        [MIGRATED_HR.app],
      )
    ).rows;
    assert.equal(provRows.length, 1);
    assert.equal(provRows[0].code, "HR_CATALOG_OPERATOR");
    assert.equal(provRows[0].source_kind, "BACKFILL_MIGRATION");
    assert.equal(provRows[0].migrated_from_source, "authz_account_role_assignments");
    assert.equal(provRows[0].migrated_from_id, origRoleRow.id);

    const hrGroupId = provRows[0].group_id;
    const hrDeptId = provRows[0].department_id;
    let hrGroupVersion = provRows[0].version;

    // Assign group-only PURE_HR to HR_CATALOG_OPERATOR
    const pureVer = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [PURE_HR.app])
    ).rows[0].version;
    const pureAssignKey = nextUuid();
    await serviceQuery(
      db,
      `select public.direct_entry_authz_assign_group_member_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Pure group HR control', $6::uuid, $7::text
       )`,
      [OWNER.auth, OWNER.app, PURE_HR.app, hrGroupId, pureVer, pureAssignKey, sha256(pureAssignKey)],
    );

    const hasCatalogManage = async (user) => {
      const ctx = (
        await serviceQuery(db, "select public.direct_entry_resolve_actor_context($1::uuid) as ctx", [user.auth])
      ).rows[0].ctx;
      return {
        inCaps: Array.isArray(ctx.capabilities) && ctx.capabilities.includes("catalog_master_manage"),
        inEffective:
          Array.isArray(ctx.effective_grants) &&
          ctx.effective_grants.some((g) => g.capability === "catalog_master_manage" && g.scope_kind === "ALL"),
      };
    };
    const assertCatalogGuard = async (user, expectAllow) => {
      if (expectAllow) {
        await db.query("select public.direct_entry_assert_catalog_operator($1::uuid, $2::uuid)", [user.auth, user.app]);
      } else {
        await assert.rejects(
          () => db.query("select public.direct_entry_assert_catalog_operator($1::uuid, $2::uuid)", [user.auth, user.app]),
          (err) => err?.code === "42501",
        );
      }
    };

    // Baseline: both ALLOW
    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: true, inEffective: true });
    assert.deepEqual(await hasCatalogManage(PURE_HR), { inCaps: true, inEffective: true });
    await assertCatalogGuard(MIGRATED_HR, true);
    await assertCatalogGuard(PURE_HR, true);

    // 1. Edit HR_CATALOG_OPERATOR to DROP catalog_master_manage -> BOTH immediately DENIED!
    const dropKey = nextUuid();
    const dropRes = await serviceQuery(
      db,
      `select public.direct_entry_authz_update_group_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::integer,
         'Vận hành nhân sự & Danh mục', 'Drop catalog_master_manage',
         $5::uuid, null::uuid, true,
         array['recruiter_master_manage', 'team_master_manage', 'audit_view', 'document_view']::text[],
         '[]'::jsonb, 'Drop catalog_master_manage for R1 oracle', $6::uuid, $7::text
       ) as payload`,
      [OWNER.auth, OWNER.app, hrGroupId, hrGroupVersion, hrDeptId, dropKey, sha256(dropKey)],
    );
    hrGroupVersion = dropRes.rows[0].payload.version;

    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: false, inEffective: false });
    assert.deepEqual(await hasCatalogManage(PURE_HR), { inCaps: false, inEffective: false });
    await assertCatalogGuard(MIGRATED_HR, false);
    await assertCatalogGuard(PURE_HR, false);

    // 2. Re-add catalog_master_manage -> BOTH immediately ALLOWED again!
    const readdKey = nextUuid();
    const readdRes = await serviceQuery(
      db,
      `select public.direct_entry_authz_update_group_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::integer,
         'Vận hành nhân sự & Danh mục', 'Restore catalog_master_manage',
         $5::uuid, null::uuid, true,
         array['recruiter_master_manage', 'team_master_manage', 'audit_view', 'document_view', 'catalog_master_manage']::text[],
         '[]'::jsonb, 'Restore catalog_master_manage', $6::uuid, $7::text
       ) as payload`,
      [OWNER.auth, OWNER.app, hrGroupId, hrGroupVersion, hrDeptId, readdKey, sha256(readdKey)],
    );
    hrGroupVersion = readdRes.rows[0].payload.version;

    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: true, inEffective: true });
    assert.deepEqual(await hasCatalogManage(PURE_HR), { inCaps: true, inEffective: true });
    await assertCatalogGuard(MIGRATED_HR, true);
    await assertCatalogGuard(PURE_HR, true);

    // 3. Disable group (active = false) -> BOTH immediately DENIED!
    const disableKey = nextUuid();
    const disableRes = await serviceQuery(
      db,
      `select public.direct_entry_authz_update_group_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::integer,
         'Vận hành nhân sự & Danh mục', 'Disable group',
         $5::uuid, null::uuid, false,
         array['recruiter_master_manage', 'team_master_manage', 'audit_view', 'document_view', 'catalog_master_manage']::text[],
         '[]'::jsonb, 'Disable HR group', $6::uuid, $7::text
       ) as payload`,
      [OWNER.auth, OWNER.app, hrGroupId, hrGroupVersion, hrDeptId, disableKey, sha256(disableKey)],
    );
    hrGroupVersion = disableRes.rows[0].payload.version;

    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: false, inEffective: false });
    assert.deepEqual(await hasCatalogManage(PURE_HR), { inCaps: false, inEffective: false });
    await assertCatalogGuard(MIGRATED_HR, false);
    await assertCatalogGuard(PURE_HR, false);

    // 4. Re-enable group, remove MIGRATED_HR -> immediately DENIED, and re-running backfill MUST NOT resurrect!
    const enableKey = nextUuid();
    await serviceQuery(
      db,
      `select public.direct_entry_authz_update_group_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::integer,
         'Vận hành nhân sự & Danh mục', 'Re-enable group',
         $5::uuid, null::uuid, true,
         array['recruiter_master_manage', 'team_master_manage', 'audit_view', 'document_view', 'catalog_master_manage']::text[],
         '[]'::jsonb, 'Re-enable HR group', $6::uuid, $7::text
       )`,
      [OWNER.auth, OWNER.app, hrGroupId, hrGroupVersion, hrDeptId, enableKey, sha256(enableKey)],
    );
    const migVer = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [MIGRATED_HR.app])
    ).rows[0].version;
    const rmKey = nextUuid();
    await serviceQuery(
      db,
      `select public.direct_entry_authz_remove_group_member_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Remove migrated HR', $6::uuid, $7::text
       )`,
      [OWNER.auth, OWNER.app, MIGRATED_HR.app, provRows[0].membership_id, migVer, rmKey, sha256(rmKey)],
    );

    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: false, inEffective: false });
    await assertCatalogGuard(MIGRATED_HR, false);
    // Re-run backfill helper -> at-most-once provenance MUST NOT resurrect ended membership
    await db.query("select public.direct_entry_authz__internal_backfill_legacy_to_groups()");
    assert.deepEqual(await hasCatalogManage(MIGRATED_HR), { inCaps: false, inEffective: false });
    await assertCatalogGuard(MIGRATED_HR, false);

    // Historical role assignment row remains intact in DB
    const histCount = (
      await db.query("select count(*)::int as cnt from public.authz_account_role_assignments where assignment_id = $1::uuid", [
        origRoleRow.id,
      ])
    ).rows[0].cnt;
    assert.equal(histCount, 1, "historical role assignment row must never be deleted");
  } finally {
    await db.close();
  }
});

test("5. PR28-T0-R2 Cutover Oracle: pre-upgrade CASH_HOLDER + HR_LEAVE_OPERATOR + HR_REPORT_VIEWER cut over 1:1 to groups, revoke cleanly, preserve independent PA/TL & zero escalation", async () => {
  const migrations = await loadMigrations();
  const grpIdx = migrations.findIndex((m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(grpIdx > 0);
  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    for (let i = 0; i < grpIdx; i += 1) {
      await db.exec(migrations[i].sql);
    }

    const MODULE_USER = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "module.cash.leave@hrpartner.vn",
      name: "Module Cash And Leave User",
    };
    const VIEWER_ONLY = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "leave.viewer.only@hrpartner.vn",
      name: "Leave Viewer Only",
    };

    for (const u of [OWNER, LUANPT, LIENVU, NGATTT, MODULE_USER, VIEWER_ONLY]) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2020-01-01', true)",
        [adm.app],
      );
      for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
        await db.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2020-01-01', true)",
          [adm.app, cap],
        );
      }
    }

    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
      actorAppUserId: OWNER.app,
      reason: "R2 pre-upgrade cutover",
    });

    // Seed pre-upgrade CASH_HOLDER, HR_LEAVE_OPERATOR, HR_REPORT_VIEWER + independent PROJECT_ACCOUNTANT & TEAM_LEADER
    const pMod = nextUuid();
    const accDeptId = (
      await db.query("select department_id from public.organization_departments where system_key = 'ACCOUNTING'")
    ).rows[0].department_id;
    const teamR2 = nextUuid();
    await db.query(
      "insert into public.organization_persons (person_id, employee_code, full_name, status) values ($1::uuid, 'NV-R2-MOD', 'Module User', 'ACTIVE')",
      [pMod],
    );
    await db.query(
      "insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason) values ($1::uuid, $2::uuid, '2025-01-01T00:00:00Z', 'Active link')",
      [MODULE_USER.app, pMod],
    );
    await db.query(
      "insert into public.organization_person_department_memberships (person_id, department_id, started_at, reason) values ($1::uuid, $2::uuid, '2025-01-01T00:00:00Z', 'Accounting dept')",
      [pMod, accDeptId],
    );
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ('proj_r2_indep', 'Dự án R2 độc lập', true)",
    );
    const recR2 = nextUuid();
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'TEAM_R2_INDEP', 'Đội R2 độc lập', true)",
      [teamR2],
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, 'Rec R2 Indep', true)",
      [recR2],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2025-01-01', true)",
      [MODULE_USER.app, recR2],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1::uuid, $2::uuid, '2025-01-01')",
      [recR2, teamR2],
    );
    await db.query(
      "insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::uuid, '2025-01-01', true)",
      [teamR2, MODULE_USER.app, recR2],
    );

    const vfinKey = nextUuid();
    await serviceQuery(
      db,
      `select public.vendor_finance_assign_global_role_admin(
         $1::uuid, $2::uuid, $3::uuid, 'CASH_HOLDER', 0, null::date, 'Pre-upgrade cash holder', $4::uuid, $5::text
       )`,
      [OWNER.auth, OWNER.app, MODULE_USER.app, vfinKey, sha256(vfinKey)],
    );
    await db.exec("begin; set local vendor_finance.admin_write_marker = 'on';");
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, valid_from, version, assigned_by_user_id, assign_reason)
       values ('proj_r2_indep', $1::uuid, '2026-01-01', 1, $2::uuid, 'Independent PA assignment')`,
      [MODULE_USER.app, OWNER.app],
    );
    await db.exec("commit;");

    const lvModKey = `lv-mod-${nextUuid()}`;
    await serviceQuery(
      db,
      `select public.leave_management_manage_module_grant_admin(
         $1::uuid, $2::uuid, 'GRANT', $3::uuid, 'HR_LEAVE_OPERATOR', null::integer, 'Pre-upgrade HR leave operator', $4::text, $5::text
       )`,
      [OWNER.auth, OWNER.app, MODULE_USER.app, lvModKey, sha256(lvModKey)],
    );
    const lvViewKey = `lv-view-${nextUuid()}`;
    await serviceQuery(
      db,
      `select public.leave_management_manage_module_grant_admin(
         $1::uuid, $2::uuid, 'GRANT', $3::uuid, 'HR_REPORT_VIEWER', null::integer, 'Pre-upgrade HR report viewer only', $4::text, $5::text
       )`,
      [OWNER.auth, OWNER.app, VIEWER_ONLY.app, lvViewKey, sha256(lvViewKey)],
    );

    // Apply #236 + #237
    for (let i = grpIdx; i < migrations.length; i += 1) {
      await db.exec(migrations[i].sql);
    }

    // 5a. GET account groups immediately lists BOTH backfilled D4 memberships AND independent resource assignments!
    const acctGroups = (
      await serviceQuery(
        db,
        "select public.direct_entry_authz_get_account_groups_admin($1::uuid, $2::uuid, $3::uuid) as payload",
        [OWNER.auth, OWNER.app, MODULE_USER.app],
      )
    ).rows[0].payload;
    assert.deepEqual(
      acctGroups.memberships.map((m) => m.group_code).sort(),
      ["LEAVE_HR_OPERATIONS", "VFIN_CASH_HOLDER"],
    );
    assert.deepEqual(
      acctGroups.resource_assignments.map((r) => r.assignment_kind).sort(),
      ["PROJECT_ACCOUNTANT", "TEAM_LEADER"],
    );

    // 5b. Leave admin overview projects module_grants strictly from groups
    const lvOverview = (
      await serviceQuery(
        db,
        "select public.leave_management_get_admin_overview($1::uuid, $2::uuid, null, 50, 0, 'all') as payload",
        [OWNER.auth, OWNER.app],
      )
    ).rows[0].payload;
    const modOverviewGrant = lvOverview.module_grants.find(
      (g) => g.app_user_id === MODULE_USER.app && g.role_code === "HR_LEAVE_OPERATOR",
    );
    assert.ok(modOverviewGrant, "Leave admin overview must show group-sourced HR_LEAVE_OPERATOR");
    assert.ok(modOverviewGrant.reason.startsWith("Qua nhóm quyền:"));

    // 5c. VIEWER_ONLY backfilled 1:1 to LEAVE_REPORT_VIEWER -> ZERO privilege escalation!
    const viewerAuth = (
      await db.query("select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth", [
        VIEWER_ONLY.auth,
        VIEWER_ONLY.app,
      ])
    ).rows[0].auth;
    assert.equal(viewerAuth.is_hr_report_viewer, true);
    assert.equal(viewerAuth.can_view_monthly_report, true);
    assert.equal(viewerAuth.is_hr_operator, false, "HR_REPORT_VIEWER must NEVER escalate to HR_LEAVE_OPERATOR");
    assert.equal(viewerAuth.can_manage_config, false, "HR_REPORT_VIEWER must NEVER gain can_manage_config");

    // 5d. Remove MODULE_USER from BOTH VFIN_CASH_HOLDER and LEAVE_HR_OPERATIONS
    let modVersion = acctGroups.account_version;
    for (const mem of acctGroups.memberships) {
      const k = nextUuid();
      const rmRes = await serviceQuery(
        db,
        `select public.direct_entry_authz_remove_group_member_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Revoke D4 group', $6::uuid, $7::text
         ) as payload`,
        [OWNER.auth, OWNER.app, MODULE_USER.app, mem.membership_id, modVersion, k, sha256(k)],
      );
      modVersion = rmRes.rows[0].payload.account_version;
    }

    // Immediately after removing both groups: ZERO hidden global Finance/Leave authority!
    const vfinAfter = (
      await db.query("select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth", [
        MODULE_USER.auth,
        MODULE_USER.app,
      ])
    ).rows[0].auth;
    assert.equal(vfinAfter.global_role_code, null);
    assert.equal(vfinAfter.can_fund_vendor_advance, false);
    assert.equal(vfinAfter.reconcile_scope, "ASSIGNED_PROJECTS", "independent PROJECT_ACCOUNTANT stays intact");
    assert.equal(vfinAfter.active_assigned_project_count, 1);

    const leaveAfter = (
      await db.query("select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth", [
        MODULE_USER.auth,
        MODULE_USER.app,
      ])
    ).rows[0].auth;
    assert.equal(leaveAfter.is_hr_operator, false);
    assert.equal(leaveAfter.can_manage_config, false);
    assert.equal(leaveAfter.can_view_monthly_report, false);
    assert.equal(leaveAfter.is_team_leader, true, "independent TEAM_LEADER stays intact");

    // Account groups endpoint reflects exact reality: memberships = [], resource_assignments still shows PA + TL
    const acctGroupsAfter = (
      await serviceQuery(
        db,
        "select public.direct_entry_authz_get_account_groups_admin($1::uuid, $2::uuid, $3::uuid) as payload",
        [OWNER.auth, OWNER.app, MODULE_USER.app],
      )
    ).rows[0].payload;
    assert.equal(acctGroupsAfter.memberships.length, 0);
    assert.deepEqual(
      acctGroupsAfter.resource_assignments.map((r) => r.assignment_kind).sort(),
      ["PROJECT_ACCOUNTANT", "TEAM_LEADER"],
    );

    // End independent PA too -> active_assigned_project_count drops to 0, shared advance apply drops to false
    await db.exec("begin; set local vendor_finance.admin_write_marker = 'on';");
    await db.query(
      "update public.vendor_finance_project_accountants set valid_to = '2026-01-02', ended_at = clock_timestamp(), ended_by_user_id = $2::uuid, end_reason = 'End PA for R2 check' where accountant_user_id = $1::uuid",
      [MODULE_USER.app, OWNER.app],
    );
    await db.exec("commit;");
    const vfinNoPa = (
      await db.query("select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth", [
        MODULE_USER.auth,
        MODULE_USER.app,
      ])
    ).rows[0].auth;
    assert.equal(vfinNoPa.active_assigned_project_count, 0);
    assert.equal(vfinNoPa.can_apply_vendor_advance, false);
    assert.equal(vfinNoPa.can_fund_vendor_advance, false);
    assert.equal(vfinNoPa.global_role_code, null);

    // End ACCOUNTING dept membership via real admin RPC -> full NONE (matches non-Accounting user with 0 groups & 0 PA)
    const memRow = (
      await db.query(
        "select membership_id::text as id, version from public.organization_person_department_memberships where person_id = $1::uuid and ended_at is null",
        [pMod],
      )
    ).rows[0];
    const endDeptKey = nextUuid();
    await serviceQuery(
      db,
      "select public.org_department_end_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'End accounting dept for R2 check', $6::uuid, $7::text)",
      [OWNER.auth, OWNER.app, accDeptId, memRow.id, memRow.version, endDeptKey, sha256(endDeptKey)],
    );
    const vfinNone = (
      await db.query("select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth", [
        MODULE_USER.auth,
        MODULE_USER.app,
      ])
    ).rows[0].auth;
    assert.equal(vfinNone.allowed, false);
    assert.equal(vfinNone.can_reconcile, false);
    assert.equal(vfinNone.reconcile_scope, "NONE");
    assert.equal(vfinNone.can_fund_vendor_advance, false);

    // Historical legacy rows remain preserved untouched
    assert.equal(
      (await db.query("select count(*)::int as cnt from public.vendor_finance_global_roles where app_user_id = $1::uuid", [MODULE_USER.app])).rows[0].cnt,
      1,
    );
    assert.equal(
      (await db.query("select count(*)::int as cnt from public.leave_module_grants where app_user_id = $1::uuid", [MODULE_USER.app])).rows[0].cnt,
      1,
    );
  } finally {
    await db.close();
  }
});

test("6. PR28 Gate 3 & Gate 4 Fail-Closed Preflight: unmappable direct grants & uncutover legacy grants block #237 while mappable direct grants cut over & revoke cleanly", async () => {
  const migrations = await loadMigrations();
  const grpIdx = migrations.findIndex((m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  const cleanupIdx = migrations.findIndex((m) => m.name === PR28_CLEANUP_MIGRATION_NAME);
  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    for (let i = 0; i <= grpIdx; i += 1) {
      await db.exec(migrations[i].sql);
    }

    const uDirect = { auth: nextUuid(), app: nextUuid(), email: "direct.exc@hrpartner.vn", name: "Direct Exception User" };
    const uUncut = { auth: nextUuid(), app: nextUuid(), email: "uncutover@hrpartner.vn", name: "Uncutover Legacy User" };
    for (const u of [OWNER, uDirect, uUncut]) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed) values ($1::uuid, $2::uuid, $3, true, $4)",
        [u.app, u.auth, u.name, u !== uUncut],
      );
    }
    const adminGrpId = (
      await db.query("select group_id from public.authz_user_groups where code = 'SYSTEM_ADMIN'")
    ).rows[0].group_id;
    await db.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason)
       values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Seed test admin')`,
      [adminGrpId, OWNER.app],
    );

    const teamId = nextUuid();
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'TEAM_DG_MAP', 'Đội DG Map', true)",
      [teamId],
    );

    // 6a. Insert UNMAPPABLE direct grant (report_view @ ALL for non-Admin -> must NOT auto-upgrade to Admin!)
    await db.query(
      `insert into public.authz_direct_capability_grants (app_user_id, capability, scope_kind, scope_id, source_kind, reason)
       values ($1::uuid, 'report_view', 'ALL', null, 'EXCEPTION_GRANT', 'Unmappable org-wide report exception')`,
      [uDirect.app],
    );
    // Also insert MAPPABLE direct grants (vendor_finance_view @ ALL + entry_team @ CONTEXT_TEAM)
    await db.query(
      `insert into public.authz_direct_capability_grants (app_user_id, capability, scope_kind, scope_id, source_kind, reason)
       values ($1::uuid, 'vendor_finance_view', 'ALL', null, 'EXCEPTION_GRANT', 'Mappable accounting view'),
              ($1::uuid, 'entry_team', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Mappable team entry')`,
      [uDirect.app, teamId],
    );

    const mUnmap = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mUnmap.cleanup_migration_safe, false);
    assert.equal(mUnmap.authorization_cutover_manifest.unmappable_direct_grant_count, 1);
    assert.equal(
      mUnmap.authorization_cutover_manifest.active_direct_grants.filter((g) => g.classification === "MAPPABLE_TO_GROUP").length,
      2,
    );

    await assert.rejects(
      () => db.exec(migrations[cleanupIdx].sql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNMAPPABLE_DIRECT_GRANTS"),
    );
    await db.exec("rollback;");

    // Resolve the unmappable direct grant (end it) and test Gate 4 (uncutover enabled user with active legacy grants)
    await db.query(
      "update public.authz_direct_capability_grants set ended_at = clock_timestamp(), ended_reason = 'Resolved by T0 decision', ended_by_app_user_id = $2::uuid where app_user_id = $1::uuid and capability = 'report_view'",
      [uDirect.app, OWNER.app],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_create', '2025-01-01', true)",
      [uUncut.app],
    );
    const mUncut = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mUncut.cleanup_migration_safe, false);
    assert.equal(mUncut.authorization_cutover_manifest.unmappable_direct_grant_count, 0);
    assert.equal(mUncut.authorization_cutover_manifest.uncutover_legacy_grant_user_count, 1);

    await assert.rejects(
      () => db.exec(migrations[cleanupIdx].sql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNCUTOVER_LEGACY_GRANTS"),
    );
    await db.exec("rollback;");

    // Resolve Gate 4 -> #237 succeeds cleanly and backfills the 2 mappable direct grants into groups!
    await db.query("update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid", [uUncut.app]);
    const mReady = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mReady.cleanup_migration_safe, true);

    await db.exec(migrations[cleanupIdx].sql);

    // Verify uDirect received both mappable groups with provenance and revoking them immediately drops both caps!
    const dirGroups = (
      await serviceQuery(
        db,
        "select public.direct_entry_authz_get_account_groups_admin($1::uuid, $2::uuid, $3::uuid) as payload",
        [OWNER.auth, OWNER.app, uDirect.app],
      )
    ).rows[0].payload;
    assert.equal(dirGroups.memberships.length, 2);
    assert.ok(dirGroups.memberships.some((m) => m.group_code === "ACCOUNTING_OPERATIONS"));
    assert.ok(dirGroups.memberships.some((m) => m.group_code.startsWith("MIGRATED_TEAM_") && m.group_code.endsWith("_ENTRY_TEAM")));

    const ctxBefore = (
      await serviceQuery(db, "select public.direct_entry_resolve_actor_context($1::uuid) as ctx", [uDirect.auth])
    ).rows[0].ctx;
    assert.ok(ctxBefore.capabilities.includes("vendor_finance_view"));
    assert.ok(ctxBefore.capabilities.includes("entry_team"));

    let uVer = dirGroups.account_version;
    for (const mem of dirGroups.memberships) {
      const k = nextUuid();
      const res = await serviceQuery(
        db,
        `select public.direct_entry_authz_remove_group_member_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Revoke migrated direct grant group', $6::uuid, $7::text
         ) as payload`,
        [OWNER.auth, OWNER.app, uDirect.app, mem.membership_id, uVer, k, sha256(k)],
      );
      uVer = res.rows[0].payload.account_version;
    }

    const ctxAfter = (
      await serviceQuery(db, "select public.direct_entry_resolve_actor_context($1::uuid) as ctx", [uDirect.auth])
    ).rows[0].ctx;
    assert.equal(ctxAfter.capabilities.includes("vendor_finance_view"), false, "no direct-grant fallback resurrection");
    assert.equal(ctxAfter.capabilities.includes("entry_team"), false, "no direct-grant fallback resurrection");
  } finally {
    await db.close();
  }
});
