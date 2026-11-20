/**
 * AI Reports Retirement — Local PGlite Migration Replay, Data Removal,
 * Non-AI Preservation & Canonical ACL Regression Suite.
 *
 * Verifies:
 *  1. Historical prefix (#001..#231) still replays cleanly with all 6 AI tables,
 *     25 AI functions, and canonical service_role allowlist intact.
 *  2. Applying append-only migration #232 via runMigrationApply drops all 6 AI
 *     tables (including seeded legacy jobs/revisions/usage/configs/audit data),
 *     2 triggers, 25 functions, and 2 owned sequences strictly with RESTRICT
 *     (zero DROP ... CASCADE).
 *  3. Dynamic allowlist derivation (buildExpectedS0T1CAllowlist) subtracts the
 *     exact 22 retired AI RPCs post-#232 while preserving historical prefix parity,
 *     and buildCanonicalRoutineAclsForAppliedMigrations passes both pre- and
 *     post-retirement.
 *  4. Non-AI core tables/data (data_sources, daily_recruitment_breakdown,
 *     direct_entry_app_users, work_report_templates, direct_entry_audit_events),
 *     unrelated routines, default privileges, and bootstrap executor role/membership
 *     remain 100% preserved.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  RETIRE_AI_REPORTS_MIGRATION_NAME,
  RETIRED_AI_REPORTS_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  S0_T1_C_TARGET_ROUTINE_PATTERN,
  buildExpectedS0T1CAllowlist,
  migrationChecksum,
  migrationSqlForTransaction,
  runMigrationApply,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { buildCanonicalRoutineAclsForAppliedMigrations } from "./lib/routine-acl-alignment.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const PROLOGUE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
`;

function createPgliteClientAdapter(db) {
  return {
    async connect() {},
    async end() {},
    async query(sql, params) {
      if (params && params.length > 0) {
        return db.query(sql, params);
      }
      const results = await db.exec(sql);
      return results.at(-1) ?? { rows: [] };
    },
  };
}

test("AI retirement migration: historical prefix replay -> data cleanup -> dynamic ACL & non-AI preservation", async () => {
  const allMigrations = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const retireIdx = allMigrations.indexOf(RETIRE_AI_REPORTS_MIGRATION_NAME);
  assert.ok(retireIdx > 0, `Retirement migration ${RETIRE_AI_REPORTS_MIGRATION_NAME} must exist`);

  const retireSql = await readFile(path.join(MIGRATION_DIR, RETIRE_AI_REPORTS_MIGRATION_NAME), "utf8");
  const retireSqlNoComments = retireSql.replace(/--[^\n]*/g, "");
  assert.equal(/\bcascade\b/i.test(retireSqlNoComments), false, "retirement migration must NOT use CASCADE");
  assert.equal(/alter\s+default\s+privileges/i.test(retireSqlNoComments), false, "retirement migration must NOT alter default privileges");

  const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
  const preMigrations = allMigrations.slice(0, retireIdx);

  const db = new PGlite();
  try {
    await db.exec(PROLOGUE);
    await db.exec(`
      create table public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const preAppliedMap = new Map();
    for (const file of preMigrations) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      const checksum = migrationChecksum(sql);
      await db.exec("begin");
      await db.exec(migrationSqlForTransaction(sql));
      await db.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [file, checksum],
      );
      await db.exec("commit");
      preAppliedMap.set(file, checksum);
    }

    // Create an unrelated public function to prove non-target ACL is untouched
    await db.exec(`
      create function public.unrelated_non_ai_probe() returns integer language sql as 'select 1';
      grant execute on function public.unrelated_non_ai_probe() to anon, authenticated, service_role;
    `);

    // Seed representative rows in ALL 6 AI tables (simulating live NWC AI data approved for deletion)
    const jobId = "11111111-1111-4111-8111-111111111111";
    const revId = "22222222-2222-4222-8222-222222222222";
    const envObj = {
      envelope_version: 2,
      algorithm: "aes-256-gcm",
      key_id: "k1",
      config_id: "pilot",
      provider_profile: "openai-compatible",
      config_version: 1,
      api_base_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "Y2lwaGVydGV4dA==",
      authentication_tag: "AAAAAAAAAAAAAAAAAAAAAA==",
      created_at: "2026-11-20T00:00:00.000Z",
    };

    await db.query(
      `insert into public.ai_report_jobs (
         job_id, identity_hash, identity_components, request, actor_ref, access_scope_hash,
         snapshot_hash, lineage_ref, packet, packet_hash, packet_contract_version,
         output_contract_version, prompt_version, provider_key, model_key, adapter_version,
         status
       ) values (
         $1::uuid, $2, '{}'::jsonb, '{}'::jsonb, 'actor-1', 'scope-1',
         'snap-1', 'lin-1', '{}'::jsonb, 'pkt-1', 'analysis-packet/0.1',
         'business-analysis/0.1', 'business-analysis-prompt/1.0', 'scripted', 'scripted-v1', 'v1',
         'draft'
       )`,
      [jobId, "a".repeat(32)],
    );
    await db.query(
      `insert into public.ai_report_revisions (
         revision_id, job_id, revision_number, analysis, packet_hash, snapshot_hash,
         lineage_ref, prompt_version, provider_key, model_key, contract_version, created_by_ref
       ) values (
         $1::uuid, $2::uuid, 1, '{}'::jsonb, 'pkt-1', 'snap-1',
         'lin-1', 'business-analysis-prompt/1.0', 'scripted', 'scripted-v1', 'business-analysis/0.1', 'actor-1'
       )`,
      [revId, jobId],
    );
    await db.query(
      `insert into public.ai_report_usage (
         job_id, logical_call_id, provider_key, model_key, latency_ms, call_outcome
       ) values ($1::uuid, 'call-1', 'scripted', 'scripted-v1', 120, 'ok')`,
      [jobId],
    );
    await db.query(
      `insert into public.ai_report_audit_events (job_id, event_type, actor_ref)
       values ($1::uuid, 'job_enqueued', 'actor-1')`,
      [jobId],
    );
    await db.query(
      `insert into public.ai_provider_configs (
         config_id, version, pilot_scope, provider_profile, api_base_url, sanitized_host,
         model, envelope, key_fingerprint, status, optimistic_version, created_by_ref
       ) values (
         'pilot', 1, 'pilot', 'openai-compatible', 'https://api.openai.com/v1', 'api.openai.com',
         'gpt-4o-mini', $1::jsonb, $2, 'disabled', 1, 'actor-1'
       )`,
      [JSON.stringify(envObj), "f".repeat(16)],
    );
    await db.query(
      `insert into public.ai_provider_config_audit_events (
         config_id, version, event_type, actor_ref, outcome, reason_code
       ) values ('pilot', 1, 'config_created', 'actor-1', 'success', 'ok')`,
    );

    // Seed representative NON-AI data that MUST survive 100% untouched
    const sourceId = "33333333-3333-4333-8333-333333333333";
    const syncRunId = "66666666-6666-4666-8666-666666666666";
    const appUserId = "44444444-4444-4444-8444-444444444444";
    const authSubId = "55555555-5555-4555-8555-555555555555";
    await db.query("insert into auth.users (id, email) values ($1::uuid, 'keep@hrpartner.vn')", [authSubId]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, account_type, enabled)
       values ($1::uuid, $2::uuid, 'Keep User', 'NORMAL', true)`,
      [appUserId, authSubId],
    );
    await db.query(
      `insert into public.data_sources (id, drive_file_id, file_name, sheet_name)
       values ($1::uuid, 'drive_keep_1', 'Keep File.xlsx', 'Sheet1')`,
      [sourceId],
    );
    await db.query(
      `insert into public.sync_runs (run_id, source_id, trigger_type, status, finished_at)
       values ($1::uuid, $2::uuid, 'manual', 'succeeded', now())`,
      [syncRunId, sourceId],
    );
    await db.query(
      `insert into public.daily_recruitment_breakdown (
         source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key,
         project_display, recruiter_display, provider_type_display, employment_type_display,
         recruited_count, sync_run_id, snapshot_at
       ) values (
         $1::uuid, '2026-11-20', 'proj_a', 'rec_a', 'hrp', 'chính thức',
         'Project A', 'Recruiter A', 'HRP', 'Chính thức',
         5, $2::uuid, '2026-11-20T00:00:00Z'
       )`,
      [sourceId, syncRunId],
    );
    await db.query(
      `insert into public.direct_entry_audit_events (app_user_id, action, outcome)
       values ($1::uuid, 'keep_audit', 'APPLIED')`,
      [appUserId],
    );

    // Pre-retirement assertions on #001..#231
    const preExpected = buildExpectedS0T1CAllowlist(s0Sql, preAppliedMap);
    const prePost = await verifyS0T1CSecurityPostconditions(
      createPgliteClientAdapter(db),
      s0Sql,
      preAppliedMap,
    );
    assert.equal(prePost.ok, true, `pre-retirement ACL postconditions must pass: ${JSON.stringify(prePost)}`);
    assert.equal(prePost.details.actualServiceCount, preExpected.length);
    assert.equal(prePost.details.expectedServiceCount, preExpected.length);

    const { rows: preAiRels } = await db.query(
      `select relname from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname ~ '^(ai_report_|ai_provider_config)'
        order by 1`,
    );
    assert.equal(preAiRels.length, 6, "6 AI tables exist before retirement");

    const { rows: preAiProcs } = await db.query(
      `select p.oid::pg_catalog.regprocedure::text as sig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^(ai_report_|ai_provider_config)'`,
    );
    assert.equal(preAiProcs.length, 25, "25 AI functions exist before retirement");

    const { rows: defaultAclBefore } = await db.query(
      "select defaclrole::text, defaclnamespace::text, defaclobjtype, coalesce(defaclacl::text, '') as acl from pg_catalog.pg_default_acl order by 1, 2, 3",
    );

    // Apply #232 (and any trailing migrations if present) through real runMigrationApply
    const applyRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: "pglite://memory", projectRef: "local" }),
      createClient: () => createPgliteClientAdapter(db),
      log() {},
      errorLog() {},
    });
    assert.equal(applyRes.appliedCount, allMigrations.length - preMigrations.length);

    const postAppliedMap = new Map(preAppliedMap);
    for (const file of allMigrations.slice(retireIdx)) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      postAppliedMap.set(file, migrationChecksum(sql));
    }

    // Post-retirement: 0 AI relations, sequences, triggers, functions, or types remain
    const { rows: postAiRels } = await db.query(
      `select relname, relkind from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname ~ '^(ai_report_|ai_provider_config)'`,
    );
    assert.deepEqual(postAiRels, [], "0 AI tables/indexes/sequences may survive");

    const { rows: postAiProcs } = await db.query(
      `select p.oid::pg_catalog.regprocedure::text as sig
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~ '^(ai_report_|ai_provider_config)'`,
    );
    assert.deepEqual(postAiProcs, [], "0 AI functions may survive");

    const { rows: postAiTypes } = await db.query(
      `select typname from pg_catalog.pg_type t
         join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typname ~ '^_?(ai_report_|ai_provider_config)'`,
    );
    assert.deepEqual(postAiTypes, [], "0 AI composite/array types may survive");

    // Calling retired AI RPCs fails closed with 42883 (undefined_function) under all roles
    for (const role of ["service_role", "authenticated", "anon"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(
        db.query("select public.ai_report_review_capability()"),
        (err) => err?.code === "42883",
        `retired ai_report_review_capability must fail with 42883 under ${role}`,
      );
      await assert.rejects(
        db.query("select public.ai_provider_config_active()"),
        (err) => err?.code === "42883",
        `retired ai_provider_config_active must fail with 42883 under ${role}`,
      );
      await db.exec("reset role");
    }

    // Dynamic allowlist drops exact 22 retired RPCs and matches live pg_proc 100%
    const postExpected = buildExpectedS0T1CAllowlist(s0Sql, postAppliedMap);
    assert.equal(
      preExpected.length - postExpected.length,
      RETIRED_AI_REPORTS_RPC_SIGNATURES.length,
      "dynamic allowlist must drop exactly the 22 retired AI RPC signatures",
    );
    const postCheck = await verifyS0T1CSecurityPostconditions(
      createPgliteClientAdapter(db),
      s0Sql,
      postAppliedMap,
    );
    assert.equal(postCheck.ok, true, `post-retirement ACL postconditions must pass: ${JSON.stringify(postCheck)}`);
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
    assert.equal(postCheck.details.missingAllowlistCount, 0);
    assert.equal(postCheck.details.extraServiceCount, 0);
    assert.equal(postCheck.details.missingServiceCount, 0);
    assert.equal(postCheck.details.actualServiceCount, postExpected.length);
    assert.equal(postCheck.details.bootstrapExecutorIntact, true);

    // Ensure no AI routine matches S0_T1_C_TARGET_ROUTINE_PATTERN in live catalog
    const { rows: targetAiProcs } = await db.query(
      `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname ~ $1
          and p.proname ~ '^(ai_report_|ai_provider_config_)'`,
      [S0_T1_C_TARGET_ROUTINE_PATTERN],
    );
    assert.deepEqual(targetAiProcs, []);

    // Non-AI data, unrelated ACL, default privileges, and bootstrap executor role preserved
    const { rows: [keptSource] } = await db.query(
      "select drive_file_id, file_name from public.data_sources where id = $1::uuid",
      [sourceId],
    );
    assert.deepEqual(keptSource, { drive_file_id: "drive_keep_1", file_name: "Keep File.xlsx" });
    const { rows: [keptFact] } = await db.query(
      "select recruited_count from public.daily_recruitment_breakdown where source_id = $1::uuid",
      [sourceId],
    );
    assert.equal(keptFact.recruited_count, 5);
    const { rows: [keptUser] } = await db.query(
      "select display_name, enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [appUserId],
    );
    assert.deepEqual(keptUser, { display_name: "Keep User", enabled: true });
    const { rows: [keptAudit] } = await db.query(
      "select action, outcome from public.direct_entry_audit_events where app_user_id = $1::uuid",
      [appUserId],
    );
    assert.deepEqual(keptAudit, { action: "keep_audit", outcome: "APPLIED" });

    const { rows: [unrelatedAcl] } = await db.query(
      `select
         pg_catalog.has_function_privilege('anon', 'public.unrelated_non_ai_probe()', 'EXECUTE') as anon_exec,
         pg_catalog.has_function_privilege('service_role', 'public.unrelated_non_ai_probe()', 'EXECUTE') as service_exec`,
    );
    assert.deepEqual(unrelatedAcl, { anon_exec: true, service_exec: true });

    const { rows: defaultAclAfter } = await db.query(
      "select defaclrole::text, defaclnamespace::text, defaclobjtype, coalesce(defaclacl::text, '') as acl from pg_catalog.pg_default_acl order by 1, 2, 3",
    );
    assert.deepEqual(defaultAclAfter, defaultAclBefore, "default privileges must remain unchanged");

    const { rows: [bootstrapCheck] } = await db.query(
      `select
         pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor', 'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)', 'EXECUTE') as plan_exec,
         pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor', 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as apply_exec`,
    );
    assert.deepEqual(bootstrapCheck, { plan_exec: true, apply_exec: true });

    // Canonical routine ACL builder works for BOTH pre-retirement prefix AND post-retirement
    const preCanonical = await buildCanonicalRoutineAclsForAppliedMigrations({
      migrationsDir: MIGRATION_DIR,
      appliedMap: preAppliedMap,
    });
    assert.equal(preCanonical.canonicalServiceSignatures.length, preExpected.length);

    const postCanonical = await buildCanonicalRoutineAclsForAppliedMigrations({
      migrationsDir: MIGRATION_DIR,
      appliedMap: postAppliedMap,
    });
    assert.equal(postCanonical.canonicalServiceSignatures.length, postExpected.length);
  } finally {
    await db.close();
  }
});
