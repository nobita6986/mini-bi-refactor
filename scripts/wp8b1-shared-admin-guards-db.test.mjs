/**
 * WP8B-1 — Shared Admin / Catalog Operator / Project Admin SQL Guards on WP5 Paired Effective Access
 * PGlite End-to-End Database, Before/After Behavioral Diff, Domain Caller Matrix, Bootstrap Compat
 * & Live TS Error-Parser Verification Suite.
 *
 * Covers:
 *   1. Migration #226 hygiene (0 '@', 0 SAVEPOINT, 0 ALTER DEFAULT PRIVILEGES, single outer BEGIN/COMMIT,
 *      LF/CRLF-identical SHA-256), atomic rollback safety, exact 336 service_role RPC allowlist
 *      (0 new public RPCs), strict internal ACL/owner/search_path/overload checks, and
 *      pg_get_functiondef compatibility on direct_entry_assert_project_admin.
 *   2. Explicit BEFORE (#225) vs AFTER (#226) behavioral diff proof on real business callers for
 *      branches that genuinely change — cleanly distinguishing canonical contract personas from
 *      simulated DB-level drift / stale-legacy / non-standard direct-grant fixtures.
 *   3. Post-cutover canonical business caller matrix across Account, Person/Department (STABLE + writes),
 *      Project & Catalog, Attendance (HQ location), Finance (Department Accounting bridge), and
 *      Team Leader / PM / PA / HR_OPERATOR / narrow Project Admin / disabled / wrong mapping /
 *      revoked role / protected Owner ADMIN invariants.
 *   4. Pre-cutover (authz_managed = false) bootstrap & R1 current-state compatibility (including
 *      no cross-source pairing even pre-cutover) and live TS error-parser compatibility
 *      (Vendor Finance, Department, Organization repositories).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  computeAssignAccountingMemberFingerprint,
  computeCreateDepartmentFingerprint,
} from "../src/lib/departments/department-contract.ts";
import { createServiceDepartmentRepository } from "../src/lib/departments/department-repository.ts";
import { createServiceOrganizationRepository } from "../src/lib/organization/person-repository.ts";
import { classifyVendorFinanceRpcError } from "../src/lib/vendor-finance/vendor-finance-repository.ts";
import { migrationChecksum } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8A_MIGRATION_NAME = "20261120090000_wp8a_finance_org_authz.sql";
const WP8B1_MIGRATION_NAME = "20261120120000_wp8b1_shared_admin_guards.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18b10000-0000-4000-8000-000000000001",
  app: "28b10000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical WP8B1",
};
const LUANPT = {
  auth: "18b10000-0000-4000-8000-000000000002",
  app: "28b10000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18b10000-0000-4000-8000-000000000003",
  app: "28b10000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18b10000-0000-4000-8000-000000000004",
  app: "28b10000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "18b10000-0000-4000-8000-000000000005",
  app: "28b10000-0000-4000-8000-000000000005",
  email: "hrop.wp8b1@hrpartner.vn",
  name: "HR Operator WP8B1",
};
const CATALOG_ONLY = {
  auth: "18b10000-0000-4000-8000-000000000006",
  app: "28b10000-0000-4000-8000-000000000006",
  email: "catonly.wp8b1@hrpartner.vn",
  name: "Catalog Only Direct Grant",
};
const PROJECT_ADMIN_ONLY = {
  auth: "18b10000-0000-4000-8000-000000000007",
  app: "28b10000-0000-4000-8000-000000000007",
  email: "prjadmin.wp8b1@hrpartner.vn",
  name: "Project Admin Direct Grant",
};
const TL_USER = {
  auth: "18b10000-0000-4000-8000-000000000008",
  app: "28b10000-0000-4000-8000-000000000008",
  recruiter: "38b10000-0000-4000-8000-000000000008",
  email: "tl.wp8b1@hrpartner.vn",
  name: "Team Leader WP8B1",
};
const PM_USER = {
  auth: "18b10000-0000-4000-8000-000000000009",
  app: "28b10000-0000-4000-8000-000000000009",
  recruiter: "38b10000-0000-4000-8000-000000000009",
  email: "pm.wp8b1@hrpartner.vn",
  name: "Project Manager WP8B1",
};
const PA_USER = {
  auth: "18b10000-0000-4000-8000-000000000010",
  app: "28b10000-0000-4000-8000-000000000010",
  email: "pa.wp8b1@hrpartner.vn",
  name: "Project Accountant WP8B1",
};
const HR_TL_COMBO = {
  auth: "18b10000-0000-4000-8000-000000000011",
  app: "28b10000-0000-4000-8000-000000000011",
  recruiter: "38b10000-0000-4000-8000-000000000011",
  email: "hrtl.wp8b1@hrpartner.vn",
  name: "HR Operator Plus TL",
};
const HR_PA_COMBO = {
  auth: "18b10000-0000-4000-8000-000000000012",
  app: "28b10000-0000-4000-8000-000000000012",
  email: "hrpa.wp8b1@hrpartner.vn",
  name: "HR Operator Plus PA",
};
const RECRUITER_USER = {
  auth: "18b10000-0000-4000-8000-000000000013",
  app: "28b10000-0000-4000-8000-000000000013",
  recruiter: "38b10000-0000-4000-8000-000000000013",
  email: "recruiter.wp8b1@hrpartner.vn",
  name: "Recruiter Staff WP8B1",
};
const BASE_USER = {
  auth: "18b10000-0000-4000-8000-000000000014",
  app: "28b10000-0000-4000-8000-000000000014",
  email: "base.wp8b1@hrpartner.vn",
  name: "Employee Base WP8B1",
};
const DISABLED_ADMIN = {
  auth: "18b10000-0000-4000-8000-000000000015",
  app: "28b10000-0000-4000-8000-000000000015",
  email: "disabled.admin.wp8b1@hrpartner.vn",
  name: "Disabled Admin WP8B1",
};
const DRIFT_D1_HR_STALE = {
  auth: "18b10000-0000-4000-8000-000000000016",
  app: "28b10000-0000-4000-8000-000000000016",
  email: "drift.d1.wp8b1@hrpartner.vn",
  name: "Drift D1 HR Stale EntryAdmin",
};
const DRIFT_D2_BASE_STALE = {
  auth: "18b10000-0000-4000-8000-000000000017",
  app: "28b10000-0000-4000-8000-000000000017",
  email: "drift.d2.wp8b1@hrpartner.vn",
  name: "Drift D2 Base Stale FullAdmin",
};
const DRIFT_D3_CROSS_SCOPE = {
  auth: "18b10000-0000-4000-8000-000000000018",
  app: "28b10000-0000-4000-8000-000000000018",
  email: "drift.d3.wp8b1@hrpartner.vn",
  name: "Drift D3 Cross Scope DirectGrant",
};
const TARGET_USER = {
  auth: "18b10000-0000-4000-8000-000000000019",
  app: "28b10000-0000-4000-8000-000000000019",
  email: "target.wp8b1@hrpartner.vn",
  name: "Target Lifecycle User",
};
const TL_CANDIDATE = {
  auth: "18b10000-0000-4000-8000-000000000020",
  app: "28b10000-0000-4000-8000-000000000020",
  recruiter: "38b10000-0000-4000-8000-000000000020",
  email: "tlcand.wp8b1@hrpartner.vn",
  name: "TL Candidate WP8B1",
};

const TEAM_1 = "48b10000-0000-4000-8000-000000000001";
const TEAM_2 = "48b10000-0000-4000-8000-000000000002";
const TEAM_3 = "48b10000-0000-4000-8000-000000000003";
const PRJ_1 = "wp8b1_prj_1";
const PRJ_2 = "wp8b1_prj_2";

const ADMIN_SEED_CAPS = [
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
];

let seq = 1;
function nextUuid() {
  return `98b10000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stripOuterTransaction(sql) {
  return sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDbUpTo(migrations, inclusiveLastName) {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  for (const m of migrations) {
    await db.exec(m.sql);
    if (m.name === inclusiveLastName) break;
  }
  return db;
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("set role service_role;");
  try {
    const { rows } = await db.query(`select public.${fnName}(${placeholders}) as res`, args);
    return rows[0]?.res;
  } finally {
    await db.exec("reset role;");
  }
}

async function expectServiceRpcError(db, fnName, args, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await serviceRpc(db, fnName, args);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected ${fnName} to fail with ${expectedCode}`);
  assert.equal(caught.code, expectedCode, `Expected SQLSTATE ${expectedCode} on ${fnName}, got ${caught.code}: ${caught.message}`);
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message on ${fnName}: ${caught.message}`);
  }
  return caught;
}

async function seedAccount(db, user, { enabled = true } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, $4)",
    [user.app, user.auth, user.name, enabled],
  );
}

async function seedRecruiterAndTeam(db, user, teamId) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
    [user.recruiter, user.name],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
    [user.recruiter],
  );
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
    [user.recruiter, teamId],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [user.app, user.recruiter],
  );
}

async function assignGlobalRole(db, actor, target, roleCode, reason) {
  const ver = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(db, "direct_entry_authz_assign_global_role_admin", [
    actor.auth,
    actor.app,
    target.app,
    roleCode,
    ver,
    reason,
    key,
    sha256(`assign:${target.app}:${roleCode}:${key}`),
  ]);
}

async function revokeGlobalRole(db, actor, target, assignmentId, reason) {
  const ver = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(db, "direct_entry_authz_revoke_global_role_admin", [
    actor.auth,
    actor.app,
    target.app,
    assignmentId,
    ver,
    reason,
    key,
    sha256(`revoke:${target.app}:${assignmentId}:${key}`),
  ]);
}

async function seedPostCutoverWorld(db) {
  const users = [
    OWNER,
    LUANPT,
    LIENVU,
    NGATTT,
    HR_OP,
    CATALOG_ONLY,
    PROJECT_ADMIN_ONLY,
    TL_USER,
    PM_USER,
    PA_USER,
    HR_TL_COMBO,
    HR_PA_COMBO,
    RECRUITER_USER,
    BASE_USER,
    DISABLED_ADMIN,
    DRIFT_D1_HR_STALE,
    DRIFT_D2_BASE_STALE,
    DRIFT_D3_CROSS_SCOPE,
    TARGET_USER,
    TL_CANDIDATE,
  ];
  for (const u of users) {
    await seedAccount(db, u);
  }

  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of ADMIN_SEED_CAPS) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [adm.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
      [adm.app],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
    [LUANPT.app],
  );

  // Teams & Projects
  await db.query(
    `insert into public.teams (team_id, code, display_name, active) values
      ($1::uuid, 'WP8B1_T1', 'Team WP8B1 One', true),
      ($2::uuid, 'WP8B1_T2', 'Team WP8B1 Two', true),
      ($3::uuid, 'WP8B1_T3', 'Team WP8B1 Three', true)`,
    [TEAM_1, TEAM_2, TEAM_3],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active) values
      ($1, 'Project WP8B1 One', true),
      ($2, 'Project WP8B1 Two', true)`,
    [PRJ_1, PRJ_2],
  );

  // Run canonical WP5B-2 cutover (sets authz_managed = true on all accounts, protects OWNER)
  const cutoverPlan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
  const cutoverResult = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: cutoverPlan.manifest_fingerprint,
  });
  assert.equal(cutoverResult.status, "APPLIED", "WP5 cutover must succeed");

  await seedRecruiterAndTeam(db, TL_USER, TEAM_1);
  await seedRecruiterAndTeam(db, PM_USER, TEAM_1);
  await seedRecruiterAndTeam(db, HR_TL_COMBO, TEAM_2);
  await seedRecruiterAndTeam(db, RECRUITER_USER, TEAM_1);
  await seedRecruiterAndTeam(db, TL_CANDIDATE, TEAM_3);

  // Assign canonical global roles
  await assignGlobalRole(db, OWNER, HR_OP, "HR_OPERATOR", "Seed canonical HR_OPERATOR");
  await assignGlobalRole(db, OWNER, HR_TL_COMBO, "HR_OPERATOR", "Seed HR_OPERATOR for HR+TL");
  await assignGlobalRole(db, OWNER, HR_PA_COMBO, "HR_OPERATOR", "Seed HR_OPERATOR for HR+PA");
  await assignGlobalRole(db, OWNER, RECRUITER_USER, "RECRUITER", "Seed canonical RECRUITER");
  await assignGlobalRole(db, OWNER, DISABLED_ADMIN, "ADMIN", "Seed ADMIN before disabling");
  await assignGlobalRole(db, OWNER, DRIFT_D1_HR_STALE, "HR_OPERATOR", "Seed HR_OPERATOR for Drift D1");

  // Disable DISABLED_ADMIN through canonical lifecycle RPC
  const disabledAdminVer = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [DISABLED_ADMIN.app])
  ).rows[0].version;
  await serviceRpc(db, "direct_entry_disable_app_user", [
    OWNER.auth,
    OWNER.app,
    DISABLED_ADMIN.app,
    disabledAdminVer,
    "Disable admin for WP8B-1 negative matrix",
    `wp8b1-disable-admin-${nextUuid()}`,
  ]);

  // Designate contextual TEAM_LEADERs through canonical RPC
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_1,
    TL_USER.app,
    null,
    1,
    "Designate canonical TL on TEAM_1",
    `wp8b1-tl1-${nextUuid()}`,
  ]);
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_2,
    HR_TL_COMBO.app,
    null,
    1,
    "Designate TL on TEAM_2 for HR_OPERATOR+TL combo",
    `wp8b1-tl2-${nextUuid()}`,
  ]);

  // Assign contextual PM on PRJ_1 (not PRJ_2)
  await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_1,
    PM_USER.recruiter,
    null,
    1,
    "Assign PM on PRJ_1",
    `wp8b1-pm1-${nextUuid()}`,
  ]);

  // Assign contextual PA: PA_USER on PRJ_1, HR_PA_COMBO on PRJ_2 (1 active PA per project)
  await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
  await db.query(
    `insert into public.vendor_finance_project_accountants
      (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
     values
      ($1, $3::uuid, 1, '2026-01-01', $5::uuid, 'Seed PA'),
      ($2, $4::uuid, 1, '2026-01-01', $5::uuid, 'Seed HR+PA')`,
    [PRJ_1, PRJ_2, PA_USER.app, HR_PA_COMBO.app, OWNER.app],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

  // Narrow valid DIRECT_GRANT personas:
  // (a) CATALOG_ONLY: catalog_master_manage @ ALL only (no team_master_manage, no entry_admin)
  await db.query(
    `insert into public.authz_direct_capability_grants
      (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values ($1::uuid, 'catalog_master_manage', 'ALL', null, 'EXCEPTION_GRANT', 'Narrow catalog-only direct grant', $2::uuid)`,
    [CATALOG_ONLY.app, OWNER.app],
  );
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [CATALOG_ONLY.app]);

  // (b) PROJECT_ADMIN_ONLY: entry_admin @ ALL only (NOT Full Admin triple, NOT catalog_master_manage)
  await db.query(
    `insert into public.authz_direct_capability_grants
      (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values ($1::uuid, 'entry_admin', 'ALL', null, 'EXCEPTION_GRANT', 'Narrow project-admin direct grant', $2::uuid)`,
    [PROJECT_ADMIN_ONLY.app, OWNER.app],
  );
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [PROJECT_ADMIN_ONLY.app]);

  // -------------------------------------------------------------------------
  // SIMULATED DRIFT / STALE LEGACY FIXTURES (NOT canonical API-reachable states;
  // constructed via DB owner writes solely to prove BEFORE #225 vs AFTER #226 delta)
  // -------------------------------------------------------------------------

  // Drift D1: HR_OPERATOR (authz_managed = true) + stale uncleaned legacy entry_admin row
  await db.query(
    `insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
     values ($1::uuid, 'entry_admin', '2026-01-01', true, false)`,
    [DRIFT_D1_HR_STALE.app],
  );

  // Drift D2: EMPLOYEE_BASE (authz_managed = true) + stale legacy Full Admin triple + stale 'all' scope
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage", "catalog_master_manage"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
       values ($1::uuid, $2, '2026-01-01', true, false)`,
      [DRIFT_D2_BASE_STALE.app, cap],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from, is_current, suspended_by_account_disable)
     values ($1::uuid, 'all', '2026-01-01', true, false)`,
    [DRIFT_D2_BASE_STALE.app],
  );

  // Drift D3: Non-standard cross-scope direct grants on authz_managed = true:
  //   entry_admin @ CONTEXT_TEAM + catalog_master_manage @ CONTEXT_TEAM
  //   + recruiter_master_manage @ ALL + team_master_manage @ ALL
  //   then synced via sync_legacy_grants (which flattens caps & 'all' scope into legacy tables).
  await db.query(
    `insert into public.authz_direct_capability_grants
      (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values
      ($1::uuid, 'entry_admin', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Simulated non-ALL entry_admin drift fixture', $3::uuid),
      ($1::uuid, 'catalog_master_manage', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Simulated non-ALL catalog drift fixture', $3::uuid),
      ($1::uuid, 'recruiter_master_manage', 'ALL', null, 'EXCEPTION_GRANT', 'Simulated ALL recruiter_master_manage', $3::uuid),
      ($1::uuid, 'team_master_manage', 'ALL', null, 'EXCEPTION_GRANT', 'Simulated ALL team_master_manage', $3::uuid)`,
    [DRIFT_D3_CROSS_SCOPE.app, TEAM_1, OWNER.app],
  );
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [DRIFT_D3_CROSS_SCOPE.app]);
}

// =============================================================================
// TEST 1: Migration #226 Hygiene, Atomic Rollback, ACL & Function Metadata
// =============================================================================
test("WP8B-1 [1/4]: Migration #226 hygiene, atomic rollback, exact 336 service_role RPCs, strict internal ACL & pg_get_functiondef", async () => {
  const migrations = await loadMigrations();
  const idx8a = migrations.findIndex((m) => m.name === WP8A_MIGRATION_NAME);
  const idx8b1 = migrations.findIndex((m) => m.name === WP8B1_MIGRATION_NAME);
  assert.ok(idx8a >= 0, `${WP8A_MIGRATION_NAME} must exist`);
  assert.equal(idx8b1, idx8a + 1, `${WP8B1_MIGRATION_NAME} must sort immediately after #225 WP8A`);

  const wp8b1 = migrations[idx8b1];
  assert.equal(wp8b1.sql.includes("@"), false, "WP8B-1 migration must contain 0 '@' characters");
  assert.equal(/\bSAVEPOINT\b/i.test(wp8b1.sql), false, "WP8B-1 migration must contain 0 SAVEPOINT");
  assert.equal(/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(wp8b1.sql), false, "WP8B-1 must not use ALTER DEFAULT PRIVILEGES");
  assert.match(wp8b1.sql, /^\s*(?:--[^\n]*\n|\s)*begin\s*;/i, "must start with outer BEGIN;");
  assert.match(wp8b1.sql, /commit\s*;\s*$/i, "must end with outer COMMIT;");

  const lfDigest = migrationChecksum(wp8b1.sql.replace(/\r\n/g, "\n"));
  const crlfDigest = migrationChecksum(wp8b1.sql.replace(/\r?\n/g, "\r\n"));
  assert.equal(lfDigest, crlfDigest, "LF and CRLF checksums must be identical");
  assert.equal(lfDigest.length, 64);

  const db = await createDbUpTo(migrations, WP8A_MIGRATION_NAME);
  try {
    const guards = [
      "public.direct_entry_assert_actor_app_user_admin(uuid,uuid)",
      "public.direct_entry_assert_catalog_operator(uuid,uuid)",
      "public.direct_entry_assert_project_admin(uuid,uuid)",
    ];

    const beforeDefs = {};
    for (const sig of guards) {
      beforeDefs[sig] = (
        await db.query("select pg_get_functiondef($1::regprocedure) as src", [sig])
      ).rows[0].src;
    }
    const serviceCountBefore = (
      await db.query(
        `select count(*)::int as cnt
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(serviceCountBefore, 336, "Baseline #225 must have exact 336 service_role RPCs");

    // Atomic rollback proof: inject division-by-zero before commit
    const bodyWithoutTx = stripOuterTransaction(wp8b1.sql);
    await assert.rejects(
      () => db.exec(`begin;\n${bodyWithoutTx}\nselect 1 / 0;\ncommit;`),
      (err) => err.code === "22012",
    );
    await db.exec("rollback;");
    for (const sig of guards) {
      const afterRollback = (
        await db.query("select pg_get_functiondef($1::regprocedure) as src", [sig])
      ).rows[0].src;
      assert.equal(afterRollback, beforeDefs[sig], `Rollback must leave ${sig} untouched`);
    }

    // Apply #226 cleanly
    await db.exec(wp8b1.sql);

    const serviceCountAfter = (
      await db.query(
        `select count(*)::int as cnt
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(serviceCountAfter, 336, "WP8B-1 must preserve exact 336 service_role RPCs (0 new public RPCs)");

    for (const sig of guards) {
      const meta = (
        await db.query(
          `select p.prosecdef,
                  p.proconfig,
                  has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
                  has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
                  pg_get_functiondef(p.oid) as src
             from pg_proc p
            where p.oid = $1::regprocedure`,
          [sig],
        )
      ).rows[0];
      assert.equal(meta.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(
        Array.isArray(meta.proconfig) && meta.proconfig.includes("search_path=pg_catalog, public"),
        `${sig} must lock search_path=pg_catalog, public`,
      );
      assert.equal(meta.owner_exec, true, `${sig} owner EXECUTE must remain intact`);
      assert.equal(meta.public_exec, false, `${sig} PUBLIC EXECUTE must be revoked`);
      assert.equal(meta.anon_exec, false, `${sig} anon EXECUTE must be revoked`);
      assert.equal(meta.auth_exec, false, `${sig} authenticated EXECUTE must be revoked`);
      assert.equal(meta.service_exec, false, `${sig} service_role EXECUTE must be revoked`);
      assert.match(meta.src, /direct_entry_authz__internal_has_paired_capability/, `${sig} must use WP5 paired helper`);
    }

    // Preserve p3-1-w02a source invariants on direct_entry_assert_project_admin
    const prjGuardSrc = (
      await db.query("select pg_get_functiondef('public.direct_entry_assert_project_admin(uuid,uuid)'::regprocedure) as src")
    ).rows[0].src;
    assert.match(prjGuardSrc, /direct_entry_assert_actor/);
    assert.doesNotMatch(prjGuardSrc, /direct_entry_assert_catalog_operator/);
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 2: Explicit BEFORE (#225) vs AFTER (#226) Behavioral Diff Proof
// =============================================================================
test("WP8B-1 [2/4]: BEFORE (#225) vs AFTER (#226) proof on real business callers (simulated drift/stale-legacy fixtures)", async () => {
  const migrations = await loadMigrations();
  const dbBefore = await createDbUpTo(migrations, WP8A_MIGRATION_NAME);
  const dbAfter = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);

  try {
    await seedPostCutoverWorld(dbBefore);
    await seedPostCutoverWorld(dbAfter);

    // --- Drift D1: HR_OPERATOR (authz_managed=true) + stale legacy entry_admin ---
    // BEFORE (#225): legacy guards falsely allowed Full Admin & Project Admin, and spoofed catalog audit as 'entry_admin'
    const d1BeforeUsers = await serviceRpc(dbBefore, "direct_entry_list_app_users_admin", [
      DRIFT_D1_HR_STALE.auth,
      DRIFT_D1_HR_STALE.app,
    ]);
    assert.ok(Array.isArray(d1BeforeUsers.accounts), "BEFORE #225: Drift D1 falsely passed Full Admin account list");
    const d1BeforeDepts = await serviceRpc(dbBefore, "org_department_list_departments_admin", [
      DRIFT_D1_HR_STALE.auth,
      DRIFT_D1_HR_STALE.app,
    ]);
    assert.ok(Array.isArray(d1BeforeDepts.departments), "BEFORE #225: Drift D1 falsely passed Full Admin department list");
    const d1BeforeEpisodes = await serviceRpc(dbBefore, "direct_entry_lookup_worker_episodes", [
      DRIFT_D1_HR_STALE.auth,
      DRIFT_D1_HR_STALE.app,
      PRJ_1,
      "Worker",
      null,
    ]);
    assert.ok(d1BeforeEpisodes, "BEFORE #225: Drift D1 falsely passed Project Admin episode lookup");
    await serviceRpc(dbBefore, "direct_entry_create_vendor", [
      DRIFT_D1_HR_STALE.auth,
      DRIFT_D1_HR_STALE.app,
      0,
      "wp8b1_v_d1_before",
      "Vendor D1 Before",
      "2026-01-01",
      "Before audit authority check",
      `v-d1-before-${nextUuid()}`,
    ]);
    const d1BeforeAuditCap = (
      await dbBefore.query(
        "select capability from public.direct_entry_audit_events where app_user_id = $1::uuid and resource_ref = 'wp8b1_v_d1_before' order by created_at desc limit 1",
        [DRIFT_D1_HR_STALE.app],
      )
    ).rows[0].capability;
    assert.equal(d1BeforeAuditCap, "entry_admin", "BEFORE #225: Drift D1 spoofed catalog audit capability as entry_admin");

    // AFTER (#226): Drift D1 strictly DENIED on Full Admin & Project Admin; catalog op uses truthful 'catalog_master_manage'
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_list_app_users_admin",
      [DRIFT_D1_HR_STALE.auth, DRIFT_D1_HR_STALE.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      dbAfter,
      "org_department_list_departments_admin",
      [DRIFT_D1_HR_STALE.auth, DRIFT_D1_HR_STALE.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      dbAfter,
      "attendance_set_hq_location",
      [
        DRIFT_D1_HR_STALE.auth,
        DRIFT_D1_HR_STALE.app,
        21.0285,
        105.8542,
        0,
        nextUuid(),
        sha256("hq-d1-denied"),
      ],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_lookup_worker_episodes",
      [DRIFT_D1_HR_STALE.auth, DRIFT_D1_HR_STALE.app, PRJ_1, "Worker", null],
      "42501",
      /capability denied/,
    );
    await serviceRpc(dbAfter, "direct_entry_create_vendor", [
      DRIFT_D1_HR_STALE.auth,
      DRIFT_D1_HR_STALE.app,
      0,
      "wp8b1_v_d1_after",
      "Vendor D1 After",
      "2026-01-01",
      "After truthful audit authority check",
      `v-d1-after-${nextUuid()}`,
    ]);
    const d1AfterAuditCap = (
      await dbAfter.query(
        "select capability from public.direct_entry_audit_events where app_user_id = $1::uuid and resource_ref = 'wp8b1_v_d1_after' order by created_at desc limit 1",
        [DRIFT_D1_HR_STALE.app],
      )
    ).rows[0].capability;
    assert.equal(d1AfterAuditCap, "catalog_master_manage", "AFTER #226: Drift D1 records truthful catalog_master_manage");

    // --- Drift D2: EMPLOYEE_BASE (authz_managed=true) + stale legacy Full Admin triple + stale 'all' scope ---
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_list_app_users_admin", [DRIFT_D2_BASE_STALE.auth, DRIFT_D2_BASE_STALE.app]),
      "BEFORE #225: Drift D2 falsely passed Full Admin",
    );
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_create_vendor", [
        DRIFT_D2_BASE_STALE.auth,
        DRIFT_D2_BASE_STALE.app,
        0,
        "wp8b1_v_d2_before",
        "Vendor D2 Before",
        "2026-01-01",
        "Drift D2 before",
        `v-d2-before-${nextUuid()}`,
      ]),
      "BEFORE #225: Drift D2 falsely passed Catalog Operator",
    );
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_lookup_worker_episodes", [
        DRIFT_D2_BASE_STALE.auth,
        DRIFT_D2_BASE_STALE.app,
        PRJ_1,
        "Worker",
        null,
      ]),
      "BEFORE #225: Drift D2 falsely passed Project Admin",
    );

    await expectServiceRpcError(
      dbAfter,
      "direct_entry_list_app_users_admin",
      [DRIFT_D2_BASE_STALE.auth, DRIFT_D2_BASE_STALE.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_create_vendor",
      [
        DRIFT_D2_BASE_STALE.auth,
        DRIFT_D2_BASE_STALE.app,
        0,
        "wp8b1_v_d2_after",
        "Vendor D2 After",
        "2026-01-01",
        "Drift D2 after",
        `v-d2-after-${nextUuid()}`,
      ],
      "42501",
      /catalog operator denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_create_project",
      [
        DRIFT_D2_BASE_STALE.auth,
        DRIFT_D2_BASE_STALE.app,
        "wp8b1_prj_d2_after",
        "Denied D2 Project",
        "Drift D2 after",
        `prj-d2-after-${nextUuid()}`,
      ],
      "42501",
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_lookup_worker_episodes",
      [DRIFT_D2_BASE_STALE.auth, DRIFT_D2_BASE_STALE.app, PRJ_1, "Worker", null],
      "42501",
      /capability denied/,
    );

    // --- Drift D3: Cross-scope direct grants (entry_admin@CONTEXT_TEAM + catalog_master_manage@CONTEXT_TEAM + recruiter/team@ALL) ---
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_list_app_users_admin", [DRIFT_D3_CROSS_SCOPE.auth, DRIFT_D3_CROSS_SCOPE.app]),
      "BEFORE #225: Drift D3 falsely passed Full Admin via flattened legacy tables",
    );
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_create_vendor", [
        DRIFT_D3_CROSS_SCOPE.auth,
        DRIFT_D3_CROSS_SCOPE.app,
        0,
        "wp8b1_v_d3_before",
        "Vendor D3 Before",
        "2026-01-01",
        "Drift D3 before",
        `v-d3-before-${nextUuid()}`,
      ]),
      "BEFORE #225: Drift D3 falsely passed Catalog Operator via flattened legacy tables",
    );
    assert.ok(
      await serviceRpc(dbBefore, "direct_entry_lookup_worker_episodes", [
        DRIFT_D3_CROSS_SCOPE.auth,
        DRIFT_D3_CROSS_SCOPE.app,
        PRJ_1,
        "Worker",
        null,
      ]),
      "BEFORE #225: Drift D3 falsely passed Project Admin via flattened legacy tables",
    );

    await expectServiceRpcError(
      dbAfter,
      "direct_entry_list_app_users_admin",
      [DRIFT_D3_CROSS_SCOPE.auth, DRIFT_D3_CROSS_SCOPE.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_create_vendor",
      [
        DRIFT_D3_CROSS_SCOPE.auth,
        DRIFT_D3_CROSS_SCOPE.app,
        0,
        "wp8b1_v_d3_after",
        "Vendor D3 After",
        "2026-01-01",
        "Drift D3 after",
        `v-d3-after-${nextUuid()}`,
      ],
      "42501",
      /catalog operation requires all scope/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_lookup_worker_episodes",
      [DRIFT_D3_CROSS_SCOPE.auth, DRIFT_D3_CROSS_SCOPE.app, PRJ_1, "Worker", null],
      "42501",
      /project administration requires all scope/,
    );
  } finally {
    await dbBefore.close();
    await dbAfter.close();
  }
});

// =============================================================================
// TEST 3: Canonical Post-Cutover Business Caller Matrix Across All Domains
// =============================================================================
test("WP8B-1 [3/4]: Canonical post-cutover business callers (Account, Org/Person, Project/Catalog, Attendance, Finance, HR_OPERATOR, Project Admin, TL/PM/PA, Revoke, Disabled, Owner)", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);

  try {
    await seedPostCutoverWorld(db);

    // -------------------------------------------------------------------------
    // 3A. Canonical Full Admin (OWNER + LUANPT + LIENVU) succeeds across all 5 domains
    // -------------------------------------------------------------------------
    // Account list + detail + disable/enable + idempotency replay
    const accountList = await serviceRpc(db, "direct_entry_list_app_users_admin", [LUANPT.auth, LUANPT.app]);
    assert.ok(accountList.total >= 20, "LUANPT (ADMIN) can list app users");

    const disableKey = `wp8b1-disable-target-${nextUuid()}`;
    const targetVer0 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TARGET_USER.app])
    ).rows[0].version;
    const disabledRes = await serviceRpc(db, "direct_entry_disable_app_user", [
      LUANPT.auth,
      LUANPT.app,
      TARGET_USER.app,
      targetVer0,
      "WP8B-1 lifecycle test disable",
      disableKey,
    ]);
    assert.equal(disabledRes.change, "disable");
    const disabledReplay = await serviceRpc(db, "direct_entry_disable_app_user", [
      LUANPT.auth,
      LUANPT.app,
      TARGET_USER.app,
      targetVer0,
      "WP8B-1 lifecycle test disable",
      disableKey,
    ]);
    assert.equal(disabledReplay.version, disabledRes.version, "Idempotent replay on disable_app_user must succeed");
    const enabledRes = await serviceRpc(db, "direct_entry_enable_app_user", [
      LUANPT.auth,
      LUANPT.app,
      TARGET_USER.app,
      disabledRes.version,
      "WP8B-1 lifecycle test re-enable",
      `wp8b1-enable-target-${nextUuid()}`,
    ]);
    assert.equal(enabledRes.change, "enable");

    // Account create bootstrap flow (begin -> claim -> finalize_create) preserves authz_managed=true + EMPLOYEE_BASE
    const beginCreate = await serviceRpc(db, "direct_entry_account_operation_begin", [
      OWNER.auth,
      OWNER.app,
      "CREATE_ACCOUNT",
      "newuser.wp8b1",
      "New User WP8B1",
      null,
      "Create new post-cutover account",
      `wp8b1-create-begin-${nextUuid()}`,
    ]);
    await serviceRpc(db, "direct_entry_account_operation_claim", [
      OWNER.auth,
      OWNER.app,
      beginCreate.intent_id,
      beginCreate.intent_token,
    ]);
    const newAuthId = nextUuid();
    await db.query("insert into auth.users (id, email) values ($1::uuid, 'newuser.wp8b1@hrpartner.vn')", [newAuthId]);
    const finalized = await serviceRpc(db, "direct_entry_account_operation_finalize_create", [
      OWNER.auth,
      OWNER.app,
      beginCreate.intent_id,
      beginCreate.intent_token,
      newAuthId,
      `wp8b1-create-finalize-${nextUuid()}`,
    ]);
    assert.ok(finalized.app_user_id);
    const createdRow = (
      await db.query("select authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid", [
        finalized.app_user_id,
      ])
    ).rows[0];
    assert.equal(createdRow.authz_managed, true, "Newly created account post-cutover must stay authz_managed=true");

    // Person / Department (STABLE read + write)
    const depts = await serviceRpc(db, "org_department_list_departments_admin", [OWNER.auth, OWNER.app]);
    assert.ok(depts.departments.length >= 1, "STABLE org_department_list_departments_admin succeeds");
    const createDeptKey = nextUuid();
    const createDeptFp = computeCreateDepartmentFingerprint({
      actor_app_user_id: OWNER.app,
      code: "WP8B1_OPS",
      name: "WP8B1 Operations",
      reason: "WP8B-1 dept create test",
    });
    const createdDept = await serviceRpc(db, "org_department_create_department_admin", [
      OWNER.auth,
      OWNER.app,
      "WP8B1_OPS",
      "WP8B1 Operations",
      "WP8B-1 dept create test",
      createDeptKey,
      createDeptFp,
    ]);
    assert.equal(createdDept.department.code, "WP8B1_OPS");

    // Finance (Org Accounting bridge)
    const acctAssignKey = nextUuid();
    const acctAssignFp = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: OWNER.app,
      account_ref: TARGET_USER.app,
      expected_pair_version: 0,
      effective_from: null,
      reason: "WP8B-1 assign accounting member",
    });
    const acctAssign = await serviceRpc(db, "org_department_assign_accounting_member", [
      OWNER.auth,
      OWNER.app,
      TARGET_USER.app,
      0,
      null,
      "WP8B-1 assign accounting member",
      acctAssignKey,
      acctAssignFp,
    ]);
    assert.ok(acctAssign, "Full Admin can assign accounting member");
    const acctMembers = await serviceRpc(db, "org_department_list_accounting_memberships_admin", [OWNER.auth, OWNER.app]);
    assert.ok(Array.isArray(acctMembers.memberships));

    // Attendance HQ location
    const hqRes = await serviceRpc(db, "attendance_set_hq_location", [
      OWNER.auth,
      OWNER.app,
      21.0285,
      105.8542,
      0,
      nextUuid(),
      sha256("wp8b1-hq-v1"),
    ]);
    assert.equal(hqRes.hq.version, 1, "Full Admin can set HQ location");

    // Project & Catalog + Project-Team Scope + Episode lookup
    const adminPrj = await serviceRpc(db, "direct_entry_create_project", [
      OWNER.auth,
      OWNER.app,
      "wp8b1_admin_prj",
      "Admin Created Project",
      "WP8B-1 admin create project",
      `wp8b1-admin-prj-${nextUuid()}`,
    ]);
    assert.equal(adminPrj.project_id, "wp8b1_admin_prj");
    const adminVendor = await serviceRpc(db, "direct_entry_create_vendor", [
      OWNER.auth,
      OWNER.app,
      0,
      "wp8b1_admin_vendor",
      "Admin Created Vendor",
      "2026-01-01",
      "WP8B-1 admin create vendor",
      `wp8b1-admin-vendor-${nextUuid()}`,
    ]);
    assert.equal(adminVendor.vendor_id, "wp8b1_admin_vendor");
    const ptsRes = await serviceRpc(db, "direct_entry_grant_project_team_scopes_batch", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      [PRJ_1],
      "WP8B-1 grant project team scope batch",
      `wp8b1-pts-${nextUuid()}`,
    ]);
    assert.equal(ptsRes.created.length, 1, "Full Admin can grant project-team scope batch");
    const adminEpisodes = await serviceRpc(db, "direct_entry_lookup_worker_episodes", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      "Worker",
      null,
    ]);
    assert.ok(adminEpisodes);

    // Owner protection remains enforced (cannot revoke protected OWNER ADMIN)
    const ownerAssignId = (
      await db.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and is_protected = true and ended_at is null",
        [OWNER.app],
      )
    ).rows[0].assignment_id;
    const ownerVer = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [OWNER.app])
    ).rows[0].version;
    await expectServiceRpcError(
      db,
      "direct_entry_authz_revoke_global_role_admin",
      [
        LUANPT.auth,
        LUANPT.app,
        OWNER.app,
        ownerAssignId,
        ownerVer,
        "Attempt to revoke protected Owner ADMIN",
        nextUuid(),
        sha256("revoke-owner-must-fail"),
      ],
      "PT409",
      /AUTHZ_PROTECTED_ASSIGNMENT/,
    );

    // -------------------------------------------------------------------------
    // 3B. Canonical HR_OPERATOR: keeps catalog + project-catalog + TL designation (team_master_manage),
    //     denied account admin, org/dept admin, HQ location, project-team scope, and direct project_admin
    // -------------------------------------------------------------------------
    const hrVendor = await serviceRpc(db, "direct_entry_create_vendor", [
      HR_OP.auth,
      HR_OP.app,
      0,
      "wp8b1_hr_vendor",
      "HR Created Vendor",
      "2026-01-01",
      "HR catalog op",
      `wp8b1-hr-v-${nextUuid()}`,
    ]);
    assert.equal(hrVendor.vendor_id, "wp8b1_hr_vendor");
    const hrPersonnel = await serviceRpc(db, "direct_entry_create_personnel", [
      HR_OP.auth,
      HR_OP.app,
      0,
      "wp8b1.hr.p1",
      "HR Created Personnel",
      "STAFF",
      "2026-01-01",
      "HR catalog op",
      `wp8b1-hr-p-${nextUuid()}`,
    ]);
    assert.equal(hrPersonnel.personnel_code, "wp8b1.hr.p1");
    const hrTeam = await serviceRpc(db, "direct_entry_create_team", [
      HR_OP.auth,
      HR_OP.app,
      0,
      "WP8B1_HR_TEAM",
      "HR Created Team",
      "HR catalog op",
      `wp8b1-hr-t-${nextUuid()}`,
    ]);
    assert.equal(hrTeam.code, "WP8B1_HR_TEAM");
    const hrLaborType = await serviceRpc(db, "direct_entry_create_labor_type", [
      HR_OP.auth,
      HR_OP.app,
      0,
      "WP8B1_HR_LT",
      "HR Created Labor Type",
      10,
      "HR catalog op",
      `wp8b1-hr-lt-${nextUuid()}`,
    ]);
    assert.equal(hrLaborType.labor_type_key, "WP8B1_HR_LT");
    const hrProject = await serviceRpc(db, "direct_entry_create_project", [
      HR_OP.auth,
      HR_OP.app,
      "wp8b1_hr_prj",
      "HR Created Project",
      "HR catalog op",
      `wp8b1-hr-prj-${nextUuid()}`,
    ]);
    assert.equal(hrProject.project_id, "wp8b1_hr_prj");
    // HR_OPERATOR has team_master_manage @ ALL (WP5B-2) -> can designate TL
    const hrTl = await serviceRpc(db, "direct_entry_designate_team_leader", [
      HR_OP.auth,
      HR_OP.app,
      TEAM_3,
      TL_CANDIDATE.app,
      null,
      1,
      "HR_OPERATOR designates TL via team_master_manage @ ALL",
      `wp8b1-hr-tl-${nextUuid()}`,
    ]);
    assert.ok(hrTl.assignment_id);

    // HR_OPERATOR DENIED on all Full Admin and direct Project Admin callers
    await expectServiceRpcError(db, "direct_entry_list_app_users_admin", [HR_OP.auth, HR_OP.app], "42501", /actor is not a Full Admin/);
    await expectServiceRpcError(
      db,
      "direct_entry_disable_app_user",
      [HR_OP.auth, HR_OP.app, TARGET_USER.app, enabledRes.version, "Denied disable", `hr-dis-${nextUuid()}`],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_account_operation_begin",
      [HR_OP.auth, HR_OP.app, "CREATE_ACCOUNT", "denied.hr", "Denied HR", null, "Denied", `hr-beg-${nextUuid()}`],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(db, "org_department_list_departments_admin", [HR_OP.auth, HR_OP.app], "42501", /actor is not a Full Admin/);
    await expectServiceRpcError(
      db,
      "direct_entry_grant_project_team_scopes_batch",
      [HR_OP.auth, HR_OP.app, TEAM_1, [PRJ_2], "Denied PTS", `hr-pts-${nextUuid()}`],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      db,
      "attendance_set_hq_location",
      [HR_OP.auth, HR_OP.app, 21.0, 105.8, 1, nextUuid(), sha256("hr-hq-denied")],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [HR_OP.auth, HR_OP.app, PRJ_1, "Worker", null],
      "42501",
      /capability denied/,
    );

    // -------------------------------------------------------------------------
    // 3C. Narrow catalog_master_manage @ ALL only: catalog allowed; TL designation, Full Admin & Project Admin denied
    // -------------------------------------------------------------------------
    const catOnlyVendor = await serviceRpc(db, "direct_entry_create_vendor", [
      CATALOG_ONLY.auth,
      CATALOG_ONLY.app,
      0,
      "wp8b1_catonly_v",
      "Catalog Only Vendor",
      "2026-01-01",
      "Narrow catalog op",
      `wp8b1-co-v-${nextUuid()}`,
    ]);
    assert.equal(catOnlyVendor.vendor_id, "wp8b1_catonly_v");
    await expectServiceRpcError(
      db,
      "direct_entry_designate_team_leader",
      [CATALOG_ONLY.auth, CATALOG_ONLY.app, TEAM_3, TL_CANDIDATE.app, null, 2, "Denied TL by catalog-only", `co-tl-${nextUuid()}`],
      "42501",
    );
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [CATALOG_ONLY.auth, CATALOG_ONLY.app, PRJ_1, "Worker", null],
      "42501",
      /capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_list_app_users_admin",
      [CATALOG_ONLY.auth, CATALOG_ONLY.app],
      "42501",
      /actor is not a Full Admin/,
    );

    // -------------------------------------------------------------------------
    // 3D. Narrow Project Admin (entry_admin @ ALL only): NOT escalated to Full Admin triple!
    // -------------------------------------------------------------------------
    assert.ok(
      await serviceRpc(db, "direct_entry_lookup_worker_episodes", [
        PROJECT_ADMIN_ONLY.auth,
        PROJECT_ADMIN_ONLY.app,
        PRJ_1,
        "Worker",
        null,
      ]),
      "entry_admin @ ALL alone MUST pass direct_entry_assert_project_admin",
    );
    const paOnlyPrj = await serviceRpc(db, "direct_entry_create_project", [
      PROJECT_ADMIN_ONLY.auth,
      PROJECT_ADMIN_ONLY.app,
      "wp8b1_paonly_prj",
      "Project Admin Created Project",
      "Narrow project admin",
      `wp8b1-pao-prj-${nextUuid()}`,
    ]);
    assert.equal(paOnlyPrj.project_id, "wp8b1_paonly_prj");
    // Denied Full Admin & Catalog Operator
    await expectServiceRpcError(
      db,
      "direct_entry_list_app_users_admin",
      [PROJECT_ADMIN_ONLY.auth, PROJECT_ADMIN_ONLY.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_create_vendor",
      [
        PROJECT_ADMIN_ONLY.auth,
        PROJECT_ADMIN_ONLY.app,
        0,
        "wp8b1_pao_v_denied",
        "Denied Vendor",
        "2026-01-01",
        "Denied",
        `pao-v-${nextUuid()}`,
      ],
      "42501",
      /catalog operator denied/,
    );
    await expectServiceRpcError(
      db,
      "org_department_list_departments_admin",
      [PROJECT_ADMIN_ONLY.auth, PROJECT_ADMIN_ONLY.app],
      "42501",
      /actor is not a Full Admin/,
    );

    // -------------------------------------------------------------------------
    // 3E. Contextual & Multi-Role Negative Matrix (TL, PM, PA, HR+TL, HR+PA, RECRUITER, BASE)
    // -------------------------------------------------------------------------
    for (const [persona, label] of [
      [TL_USER, "TEAM_LEADER"],
      [PM_USER, "PROJECT_MANAGER"],
      [PA_USER, "PROJECT_ACCOUNTANT"],
      [HR_TL_COMBO, "HR_OPERATOR + TEAM_LEADER"],
      [HR_PA_COMBO, "HR_OPERATOR + PROJECT_ACCOUNTANT"],
      [RECRUITER_USER, "RECRUITER"],
      [BASE_USER, "EMPLOYEE_BASE"],
    ]) {
      await expectServiceRpcError(
        db,
        "direct_entry_list_app_users_admin",
        [persona.auth, persona.app],
        "42501",
        /actor is not a Full Admin/,
      );
      await expectServiceRpcError(
        db,
        "org_department_list_departments_admin",
        [persona.auth, persona.app],
        "42501",
        /actor is not a Full Admin/,
      );
      await expectServiceRpcError(
        db,
        "attendance_set_hq_location",
        [persona.auth, persona.app, 21.0, 105.8, 1, nextUuid(), sha256(`hq-denied-${label}`)],
        "42501",
        /actor is not a Full Admin/,
      );
      await expectServiceRpcError(
        db,
        "direct_entry_grant_project_team_scopes_batch",
        [persona.auth, persona.app, TEAM_1, [PRJ_2], `Denied ${label}`, `pts-d-${nextUuid()}`],
        "42501",
        /actor is not a Full Admin/,
      );
      // PRJ_2 episode lookup: none of these personas is PM of PRJ_2 or Project Admin
      await expectServiceRpcError(
        db,
        "direct_entry_lookup_worker_episodes",
        [persona.auth, persona.app, PRJ_2, "Worker", null],
        "42501",
        /capability denied/,
      );
    }

    // PM allowed on assigned PRJ_1 (PM branch), denied on PRJ_2 (already asserted above)
    assert.ok(
      await serviceRpc(db, "direct_entry_lookup_worker_episodes", [PM_USER.auth, PM_USER.app, PRJ_1, "Worker", null]),
      "PM remains authorized on assigned PRJ_1",
    );

    // Non-catalog personas denied catalog operations
    for (const persona of [TL_USER, PM_USER, PA_USER, RECRUITER_USER, BASE_USER]) {
      await expectServiceRpcError(
        db,
        "direct_entry_create_vendor",
        [persona.auth, persona.app, 0, `denied_${nextUuid().slice(-6)}`, "Denied", "2026-01-01", "Denied", `v-d-${nextUuid()}`],
        "42501",
        /catalog operator denied/,
      );
    }

    // -------------------------------------------------------------------------
    // 3F. Wrong mapping, Disabled account, and Revoked ADMIN role fail closed immediately
    // -------------------------------------------------------------------------
    for (const [badAuth, badApp, label] of [
      [OWNER.auth, BASE_USER.app, "mismatched auth_subject/app_user_id"],
      [DISABLED_ADMIN.auth, DISABLED_ADMIN.app, "disabled ADMIN account"],
    ]) {
      await expectServiceRpcError(db, "direct_entry_list_app_users_admin", [badAuth, badApp], "42501", /actor mapping denied/);
      await expectServiceRpcError(
        db,
        "direct_entry_create_vendor",
        [badAuth, badApp, 0, `bad_${label.slice(0, 4)}_${nextUuid().slice(-4)}`, "Denied", "2026-01-01", "Denied", `bad-v-${nextUuid()}`],
        "42501",
        /actor mapping denied/,
      );
      await expectServiceRpcError(
        db,
        "direct_entry_lookup_worker_episodes",
        [badAuth, badApp, PRJ_1, "Worker", null],
        "42501",
        /actor mapping denied/,
      );
    }

    // Revoke secondary ADMIN (LIENVU) -> immediately loses all 3 guard authorities
    const lienvuAssignId = (
      await db.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
        [LIENVU.app],
      )
    ).rows[0].assignment_id;
    await revokeGlobalRole(db, OWNER, LIENVU, lienvuAssignId, "WP8B-1 revoke secondary admin");
    await expectServiceRpcError(db, "direct_entry_list_app_users_admin", [LIENVU.auth, LIENVU.app], "42501", /actor is not a Full Admin/);
    await expectServiceRpcError(
      db,
      "direct_entry_create_vendor",
      [LIENVU.auth, LIENVU.app, 0, "wp8b1_revoked_v", "Denied", "2026-01-01", "Denied", `rev-v-${nextUuid()}`],
      "42501",
      /catalog operator denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [LIENVU.auth, LIENVU.app, PRJ_1, "Worker", null],
      "42501",
      /capability denied/,
    );
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 4: Pre-Cutover (authz_managed = false) Bootstrap/R1 Compat & Live TS Error Parsers
// =============================================================================
test("WP8B-1 [4/4]: Pre-cutover (authz_managed=false) R1 compat, zero cross-source pairing & live TS error parsers", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);

  try {
    const PRE_ADMIN = {
      auth: "18b20000-0000-4000-8000-000000000001",
      app: "28b20000-0000-4000-8000-000000000001",
      email: "pre.admin@hrpartner.vn",
      name: "Pre-Cutover R1 Admin",
    };
    const PRE_CATALOG = {
      auth: "18b20000-0000-4000-8000-000000000002",
      app: "28b20000-0000-4000-8000-000000000002",
      email: "pre.catalog@hrpartner.vn",
      name: "Pre-Cutover R1 Catalog",
    };
    const PRE_CROSS_SOURCE = {
      auth: "18b20000-0000-4000-8000-000000000003",
      app: "28b20000-0000-4000-8000-000000000003",
      email: "pre.cross@hrpartner.vn",
      name: "Pre-Cutover Cross-Source Denied",
    };
    const PRE_DISABLED = {
      auth: "18b20000-0000-4000-8000-000000000004",
      app: "28b20000-0000-4000-8000-000000000004",
      email: "pre.disabled@hrpartner.vn",
      name: "Pre-Cutover Disabled",
    };

    const PRE_CROSS_SOURCE_SYM = {
      auth: "18b20000-0000-4000-8000-000000000005",
      app: "28b20000-0000-4000-8000-000000000005",
      email: "pre.cross.sym@hrpartner.vn",
      name: "Pre-Cutover Cross-Source Symmetric Denied",
    };

    await seedAccount(db, PRE_ADMIN);
    await seedAccount(db, PRE_CATALOG);
    await seedAccount(db, PRE_CROSS_SOURCE);
    await seedAccount(db, PRE_DISABLED, { enabled: false });
    await seedAccount(db, PRE_CROSS_SOURCE_SYM);

    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'PRE_T1', 'Pre Team', true)",
      [TEAM_1],
    );
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Pre Project', true)",
      [PRJ_1],
    );

    // Pre-cutover R1 current-state row with inert historical valid_to = '2021-01-01', is_current = true
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
         values ($1::uuid, $2, '2020-01-01', '2021-01-01', true)`,
        [PRE_ADMIN.app, cap],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
       values ($1::uuid, 'all', '2020-01-01', '2021-01-01', true)`,
      [PRE_ADMIN.app],
    );

    // Pre-cutover catalog operator with R1 current row
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'catalog_master_manage', '2020-01-01', '2021-01-01', true)`,
      [PRE_CATALOG.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
       values ($1::uuid, 'all', '2020-01-01', '2021-01-01', true)`,
      [PRE_CATALOG.app],
    );

    // Pre-cutover cross-source test: canonical entry_admin @ CONTEXT_TEAM + legacy scope='all' (NO legacy entry_admin!)
    await db.query(
      `insert into public.authz_direct_capability_grants
        (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, 'entry_admin', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Pre-cutover cross-source test', $3::uuid)`,
      [PRE_CROSS_SOURCE.app, TEAM_1, PRE_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [PRE_CROSS_SOURCE.app],
    );

    // Pre-cutover symmetric cross-source test: legacy entry_admin (no legacy 'all' scope)
    // + unrelated canonical DIRECT_GRANT (audit_view @ ALL) -> MUST NOT cross-pair!
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true)`,
      [PRE_CROSS_SOURCE_SYM.app],
    );
    await db.query(
      `insert into public.authz_direct_capability_grants
        (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, 'audit_view', 'ALL', null, 'EXCEPTION_GRANT', 'Pre-cutover unrelated ALL grant', $2::uuid)`,
      [PRE_CROSS_SOURCE_SYM.app, PRE_ADMIN.app],
    );

    // Pre-cutover R1 admin & catalog work cleanly
    assert.ok(await serviceRpc(db, "direct_entry_list_app_users_admin", [PRE_ADMIN.auth, PRE_ADMIN.app]));
    assert.ok(
      await serviceRpc(db, "direct_entry_create_vendor", [
        PRE_CATALOG.auth,
        PRE_CATALOG.app,
        0,
        "pre_cat_vendor",
        "Pre Catalog Vendor",
        "2026-01-01",
        "Pre-cutover catalog compat",
        `pre-v-${nextUuid()}`,
      ]),
    );
    assert.ok(
      await serviceRpc(db, "direct_entry_lookup_worker_episodes", [PRE_ADMIN.auth, PRE_ADMIN.app, PRJ_1, "Worker", null]),
    );

    // Pre-cutover cross-source MUST FAIL CLOSED in BOTH directions (zero canonical x legacy cross-pairing!)
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [PRE_CROSS_SOURCE.auth, PRE_CROSS_SOURCE.app, PRJ_1, "Worker", null],
      "42501",
      /project administration requires all scope/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_list_app_users_admin",
      [PRE_CROSS_SOURCE.auth, PRE_CROSS_SOURCE.app],
      "42501",
      /actor is not a Full Admin/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [PRE_CROSS_SOURCE_SYM.auth, PRE_CROSS_SOURCE_SYM.app, PRJ_1, "Worker", null],
      "42501",
      /project administration requires all scope/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_list_app_users_admin",
      [PRE_CROSS_SOURCE_SYM.auth, PRE_CROSS_SOURCE_SYM.app],
      "42501",
      /actor is not a Full Admin/,
    );

    // Null UUID actor parameters fail closed with 'actor mapping denied' (42501)
    await expectServiceRpcError(
      db,
      "direct_entry_list_app_users_admin",
      [null, PRE_ADMIN.app],
      "42501",
      /actor mapping denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_lookup_worker_episodes",
      [PRE_ADMIN.auth, null, PRJ_1, "Worker", null],
      "42501",
      /actor mapping denied/,
    );

    // Live SQL error -> TS repository error parser verification
    const nonAdminErr = await expectServiceRpcError(
      db,
      "org_department_list_departments_admin",
      [PRE_CATALOG.auth, PRE_CATALOG.app],
      "42501",
      /actor is not a Full Admin/,
    );
    const disabledErr = await expectServiceRpcError(
      db,
      "org_department_list_departments_admin",
      [PRE_DISABLED.auth, PRE_DISABLED.app],
      "42501",
      /actor mapping denied/,
    );

    assert.equal(
      classifyVendorFinanceRpcError({ code: nonAdminErr.code, message: nonAdminErr.message }, "mutation"),
      "VENDOR_FINANCE_ADMIN_DENIED",
      "classifyVendorFinanceRpcError must continue mapping 'actor is not a Full Admin' to VENDOR_FINANCE_ADMIN_DENIED",
    );
    assert.equal(
      classifyVendorFinanceRpcError({ code: disabledErr.code, message: disabledErr.message }, "read"),
      "ACTOR_NOT_AVAILABLE",
      "classifyVendorFinanceRpcError must continue mapping 'actor mapping denied' to ACTOR_NOT_AVAILABLE",
    );

    const rpcParamTypes = {
      org_department_list_departments_admin: {
        p_auth_subject: "uuid",
        p_app_user_id: "uuid",
        p_include_inactive: "boolean",
        p_as_of: "timestamptz",
      },
      org_department_list_persons_admin: {
        p_auth_subject: "uuid",
        p_app_user_id: "uuid",
        p_search: "text",
        p_status: "text",
        p_department_id: "uuid",
        p_link_state: "text",
        p_as_of: "timestamptz",
        p_page: "integer",
        p_page_size: "integer",
      },
    };
    const pgliteRpcCaller = async (fnName, params) => {
      const types = rpcParamTypes[fnName] ?? {};
      const entries = Object.entries(params ?? {});
      const namedArgs = entries
        .map(([k], i) => `${k} => $${i + 1}${types[k] ? `::${types[k]}` : ""}`)
        .join(", ");
      const values = entries.map(([, v]) => (v === undefined ? null : v));
      await db.exec("set role service_role;");
      try {
        const { rows } = await db.query(`select public.${fnName}(${namedArgs}) as res`, values);
        return { data: rows[0]?.res ?? null, error: null };
      } catch (err) {
        return { data: null, error: { code: err.code, message: err.message } };
      } finally {
        await db.exec("reset role;");
      }
    };

    const deptRepo = createServiceDepartmentRepository(pgliteRpcCaller);
    const deptDenied = await deptRepo.listDepartments({
      auth_subject: PRE_CATALOG.auth,
      app_user_id: PRE_CATALOG.app,
      include_inactive: true,
      as_of: null,
    });
    assert.equal(deptDenied.ok, false);
    assert.equal(deptDenied.code, "DEPARTMENT_ACCESS_DENIED");
    const deptDisabled = await deptRepo.listDepartments({
      auth_subject: PRE_DISABLED.auth,
      app_user_id: PRE_DISABLED.app,
      include_inactive: true,
      as_of: null,
    });
    assert.equal(deptDisabled.ok, false);
    assert.equal(deptDisabled.code, "ACTOR_NOT_AVAILABLE");

    const orgRepo = createServiceOrganizationRepository(pgliteRpcCaller);
    const orgDenied = await orgRepo.listPersons({
      auth_subject: PRE_CATALOG.auth,
      app_user_id: PRE_CATALOG.app,
      search: null,
      status: null,
      department_id: null,
      link_state: null,
      as_of: null,
      page: 1,
      page_size: 25,
    });
    assert.equal(orgDenied.ok, false);
    assert.equal(orgDenied.code, "FORBIDDEN");
    const orgDisabled = await orgRepo.listPersons({
      auth_subject: PRE_DISABLED.auth,
      app_user_id: PRE_DISABLED.app,
      search: null,
      status: null,
      department_id: null,
      link_state: null,
      as_of: null,
      page: 1,
      page_size: 25,
    });
    assert.equal(orgDisabled.ok, false);
    assert.equal(orgDisabled.code, "ACTOR_NOT_AVAILABLE");
  } finally {
    await db.close();
  }
});
