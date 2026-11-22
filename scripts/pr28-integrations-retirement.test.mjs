import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { buildLegacyTechnicalIdentityManifest } from "./lib/pr28-legacy-identity-manifest.mjs";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const abs = (rel) => path.join(ROOT, rel);

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

test("1. Retired n8n BoD API and HRP Sync routes, auth, dispatcher, contracts & env templates are completely removed (zero fallback to Admin)", () => {
  const mustBeRemoved = [
    "src/app/api/integrations/n8n/v1/query/route.ts",
    "src/app/api/integrations/n8n/v1/catalog/route.ts",
    "src/app/api/integrations/hrp/v1/catalog/route.ts",
    "src/lib/integrations/n8n/auth.ts",
    "src/lib/integrations/n8n/catalog.ts",
    "src/lib/integrations/n8n/dispatcher.ts",
    "src/lib/integrations/n8n/http-handlers.ts",
    "src/lib/integrations/n8n/query-contract.ts",
    "src/lib/integrations/n8n/n8n-bod-api.test.mjs",
    "src/lib/integrations/hrp/auth.ts",
    "src/lib/integrations/hrp/catalog-api.ts",
    "src/lib/integrations/hrp/catalog-contract.ts",
  ];
  for (const rel of mustBeRemoved) {
    assert.equal(existsSync(abs(rel)), false, `${rel} must be deleted`);
  }

  // Zero surviving production src/ files reference retired endpoints, env vars, or hrp_sync_catalog
  const prodSrcFiles = walkFiles(abs("src")).filter(
    (f) => !f.endsWith(".test.mjs") && !f.endsWith(".test.ts"),
  );
  assert.ok(prodSrcFiles.length > 100);
  for (const full of prodSrcFiles) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const content = readFileSync(full, "utf8");
    assert.equal(content.includes("/api/integrations/n8n/"), false, `${rel} must not reference /api/integrations/n8n/`);
    assert.equal(content.includes("/api/integrations/hrp/"), false, `${rel} must not reference /api/integrations/hrp/`);
    assert.equal(/process\.env\.N8N_BOD_[A-Z0-9_]+/.test(content), false, `${rel} must not read N8N_BOD_* env`);
    assert.equal(/process\.env\.HRP_SYNC_[A-Z0-9_]+/.test(content), false, `${rel} must not read HRP_SYNC_* env`);
    assert.equal(content.includes("hrp_sync_catalog"), false, `${rel} must not call hrp_sync_catalog`);
  }

  // .env.example no longer advertises retired N8N_BOD_* or HRP_SYNC_* env vars
  const envExample = readFileSync(abs(".env.example"), "utf8");
  assert.equal(/^N8N_BOD_/m.test(envExample), false);
  assert.equal(/^HRP_SYNC_/m.test(envExample), false);
});

test("2. Public jobs feed, mobile APIs, shared BI repos, and Vendor Shared Advance remain completely intact", () => {
  const mustStayIntact = [
    "src/app/feeds/jobs.v1.json/route.ts",
    "src/lib/recruitment-posts/api.ts",
    "src/lib/recruitment-posts/repository.ts",
    "src/lib/vendor-finance/vendor-finance-contract.ts",
    "src/lib/work-reports/submission-repository.ts",
    "src/lib/attendance/attendance-report-repository.ts",
  ];
  for (const rel of mustStayIntact) {
    assert.equal(existsSync(abs(rel)), true, `${rel} must be preserved`);
  }
  const feedRoute = readFileSync(abs("src/app/feeds/jobs.v1.json/route.ts"), "utf8");
  assert.equal(feedRoute.includes("integrations/hrp"), false);
  assert.equal(feedRoute.includes("integrations/n8n"), false);
});

test("3. Read-only Legacy Technical Identity Manifest accurately classifies all 4 states & CASCADE hazards on PGlite", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    `);

    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const grpIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(grpIdx >= 0);
    for (const name of names.slice(0, grpIdx + 1)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    // State 1: NO_CANDIDATES on clean DB -> cleanup_migration_safe = true
    const cleanManifest = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(cleanManifest.overall_status, "NO_CANDIDATES");
    assert.equal(cleanManifest.cleanup_migration_safe, true);
    assert.equal(cleanManifest.candidates.length, 0);
    assert.ok(cleanManifest.schema_state.scanned_fk_column_count >= 150, "dynamically scans full FK schema");
    assert.match(cleanManifest.manifest_fingerprint, /^[a-f0-9]{64}$/);

    // State 2: ZERO_REF_CANDIDATE (SERVICE account with 0 FK/audit/cascade refs)
    const svcCleanAuth = "66000000-0000-4000-8000-000000000001";
    const svcCleanApp = "66000000-0000-4000-8000-000000000011";
    await db.query(`insert into auth.users (id, email) values ($1::uuid, 'svc.clean@local')`, [svcCleanAuth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type)
       values ($1::uuid, $2::uuid, 'Clean Service Account', false, 'SERVICE')`,
      [svcCleanApp, svcCleanAuth],
    );
    const m2 = await buildLegacyTechnicalIdentityManifest(db, { n8nAuthSubject: svcCleanAuth });
    assert.equal(m2.overall_status, "ZERO_REF_CANDIDATES_ONLY");
    assert.equal(m2.cleanup_migration_safe, false);
    assert.equal(m2.candidates.length, 1);
    assert.equal(m2.candidates[0].classification, "ZERO_REF_CANDIDATE");
    assert.equal(m2.candidates[0].hard_delete_forbidden, false);
    assert.ok(m2.candidates[0].discovery_sources.includes("BINDING_N8N_AUTH_SUBJECT"));
    assert.ok(m2.candidates[0].discovery_sources.includes("DB_ACCOUNT_TYPE_SERVICE"));

    // State 3: HISTORICAL_REF_PRESERVE_REQUIRED (audit ref + CASCADE hazard in leave_employee_profiles)
    await db.query(
      `insert into public.direct_entry_audit_events (app_user_id, auth_subject, action, capability, resource_ref, outcome)
       values ($1::uuid, $2::uuid, 'hrp_sync_catalog_read', 'integration_hrp_catalog', 'hrp:1', 'ALLOW')`,
      [svcCleanApp, svcCleanAuth],
    );
    await db.query(
      `insert into public.leave_employee_profiles (app_user_id, unit_kind, is_shared_non_employee)
       values ($1::uuid, 'UNCLASSIFIED', true)`,
      [svcCleanApp],
    );
    const m3 = await buildLegacyTechnicalIdentityManifest(db, { hrpAuthSubject: svcCleanAuth });
    assert.equal(m3.overall_status, "HISTORICAL_REF_PRESERVE_REQUIRED");
    assert.equal(m3.candidates[0].classification, "HISTORICAL_REF_PRESERVE_REQUIRED");
    assert.equal(m3.candidates[0].hard_delete_forbidden, true);
    assert.ok(m3.candidates[0].references.total_restrict_or_no_action_refs >= 1);
    assert.ok(m3.candidates[0].references.total_cascade_hazard_refs >= 1);
    assert.equal(m3.candidates[0].references.cascade_hazard_by_column["public.leave_employee_profiles.app_user_id"], 1);
    assert.equal(m3.candidates[0].references.non_fk_audit_by_column["public.direct_entry_audit_events.auth_subject"], 1);

    // State 4: BLOCKED_HUMAN_OR_OWNER_CONFLICT (NORMAL account with stale is_shared_non_employee + active Person link)
    const splitAuth = "66000000-0000-4000-8000-000000000002";
    const splitApp = "66000000-0000-4000-8000-000000000012";
    const splitPerson = "66000000-0000-4000-8000-000000000022";
    await db.query(`insert into auth.users (id, email) values ($1::uuid, 'split@hrpartner.vn')`, [splitAuth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type)
       values ($1::uuid, $2::uuid, 'Split Human User', true, 'NORMAL')`,
      [splitApp, splitAuth],
    );
    await db.query(
      `insert into public.leave_employee_profiles (app_user_id, unit_kind, is_shared_non_employee)
       values ($1::uuid, 'RECRUITMENT', true)`,
      [splitApp],
    );
    await db.query(
      `insert into public.organization_persons (person_id, employee_code, full_name, status)
       values ($1::uuid, 'NV-SPLIT', 'Split Human User', 'ACTIVE')`,
      [splitPerson],
    );
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-01T00:00:00Z', 'Active link')`,
      [splitApp, splitPerson],
    );

    const m4 = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(m4.overall_status, "BLOCKED_HUMAN_OR_OWNER_CONFLICT");
    const splitCand = m4.candidates.find((c) => c.app_user_id === splitApp);
    assert.ok(splitCand);
    assert.equal(splitCand.classification, "BLOCKED_HUMAN_OR_OWNER_CONFLICT");
    assert.equal(splitCand.human_contamination.person_link_open, 1);
  } finally {
    await db.close();
  }
});

test("4. Authorization Cutover Manifest gates #237 preflight on unmappable direct grants & uncutover legacy grants", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    `);

    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const grpIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(grpIdx >= 0);
    for (const name of names.slice(0, grpIdx + 1)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const uAuth = "67000000-0000-4000-8000-000000000001";
    const uApp = "67000000-0000-4000-8000-000000000011";
    const teamId = "67000000-0000-4000-8000-000000000099";
    await db.query(`insert into auth.users (id, email) values ($1::uuid, 'gate.manifest@hrpartner.vn')`, [uAuth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type, authz_managed)
       values ($1::uuid, $2::uuid, 'Gate Manifest User', true, 'NORMAL', false)`,
      [uApp, uAuth],
    );
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'gate-team', 'Gate Team', true)`,
      [teamId],
    );

    // 1) Active legacy direct_entry_capability_grants on enabled authz_managed=false -> Gate 4 blocks cleanup_migration_safe
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', '2026-01-01', true)`,
      [uApp],
    );
    const mGate4 = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mGate4.cleanup_migration_safe, false);
    assert.equal(mGate4.authorization_cutover_manifest.uncutover_legacy_grant_user_count, 1);
    assert.equal(mGate4.authorization_cutover_manifest.unmappable_direct_grant_count, 0);

    // Mark account cutover (authz_managed=true) -> Gate 4 clears
    await db.query(`update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid`, [uApp]);
    const mAfterCutover = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mAfterCutover.cleanup_migration_safe, true);
    assert.equal(mAfterCutover.authorization_cutover_manifest.uncutover_legacy_grant_user_count, 0);

    // 2) Add mappable direct grant (catalog_master_manage @ ALL -> HR_CATALOG_OPERATOR) -> still cleanup_migration_safe = true!
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, started_at, reason)
       values ($1::uuid, 'catalog_master_manage', 'ALL', null, 'EXCEPTION_GRANT', now(), 'Mappable direct grant')`,
      [uApp],
    );
    const mMappable = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mMappable.cleanup_migration_safe, true);
    assert.equal(mMappable.authorization_cutover_manifest.active_direct_grant_count, 1);
    assert.equal(mMappable.authorization_cutover_manifest.unmappable_direct_grant_count, 0);
    assert.equal(mMappable.authorization_cutover_manifest.active_direct_grants[0].classification, "MAPPABLE_TO_GROUP");

    // 3) Add unmappable direct grant (report_view @ ALL -> must NOT auto-upgrade to Admin) -> Gate 3 blocks cleanup_migration_safe!
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, started_at, reason)
       values ($1::uuid, 'report_view', 'ALL', null, 'EXCEPTION_GRANT', now(), 'Unmappable direct grant')`,
      [uApp],
    );
    const mGate3 = await buildLegacyTechnicalIdentityManifest(db, {});
    assert.equal(mGate3.cleanup_migration_safe, false);
    assert.equal(mGate3.authorization_cutover_manifest.unmappable_direct_grant_count, 1);
    const unmappable = mGate3.authorization_cutover_manifest.active_direct_grants.find(
      (g) => g.classification === "UNMAPPABLE_REQUIRES_T0_DECISION",
    );
    assert.ok(unmappable);
    assert.equal(unmappable.capability, "report_view");
    assert.equal(unmappable.scope_kind, "ALL");
  } finally {
    await db.close();
  }
});
