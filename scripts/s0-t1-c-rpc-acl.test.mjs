/**
 * S0-T1-C RPC ACL regression on an isolated, native PostgreSQL cluster.
 *
 * Starts initdb/pg_ctl in a temporary directory, applies the current migration
 * baseline, simulates broad staging grants, then applies the S0-T1-C forward
 * migration. It reads catalog metadata and uses scratch-only trigger probes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  F1_WORK_REPORTS_MIGRATION_NAME,
  F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_MIGRATION_NAME,
  F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
  F1_WORK_REPORTS_ASSIGNMENT_TRACKING_MIGRATION_NAME,
  F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
  F1_5_WORK_REPORTS_ANALYTICS_MIGRATION_NAME,
  F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
  F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
  F2_WORK_REPORTS_REVIEW_AND_DELEGATION_MIGRATION_NAME,
  F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES,
  PROJECT_TEAM_SCOPE_SEARCH_MIGRATION_NAME,
  PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE,
  WF01_WORKFORCE_SNAPSHOT_MIGRATION_NAME,
  WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE,
  WF02_WORKFORCE_BALANCE_WAITING_MIGRATION_NAME,
  DUPLICATE_CCCD_SELF_SERVICE_MIGRATION_NAME,
  DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES,
  WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME,
  WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
  ATTENDANCE_WP1_MIGRATION_NAME,
  ATTENDANCE_WP1_RPC_SIGNATURES,
  ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES,
  ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_MIGRATION_NAME,
  ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE,
  HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME,
  HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES,
  HF_OFFBOARDING_REPORT_QUERY_PERFORMANCE_MIGRATION_NAME,
  ATTENDANCE_SELF_HISTORY_MIGRATION_NAME,
  ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES,
  ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME,
  ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES,
  VFIN_01_BACKEND_MIGRATION_NAME,
  VFIN_01_BACKEND_RPC_SIGNATURES,
  HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_MIGRATION_NAME,
  HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES,
  VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME,
  VFIN_02_PROJECT_LEDGERS_RPC_SIGNATURES,
  HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_MIGRATION_NAME,
  HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_RPC_SIGNATURES,
  VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME,
  VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES,
  CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME,
  CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES,
  PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME,
  PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
  CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME,
  CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
  WORK_REPORTS_ANDROID_SYNC_AND_UX_MIGRATION_NAME,
  WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE,
  ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_MIGRATION_NAME,
  ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES,
  LEAVE_MANAGEMENT_WP1_MIGRATION_NAME,
  LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES,
  LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_MIGRATION_NAME,
  LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE,
  SALARY_ADVANCE_WP1_MIGRATION_NAME,
  SALARY_ADVANCE_WP1_RPC_SIGNATURES,
  HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_MIGRATION_NAME,
  HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_RPC_SIGNATURE,
  HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_MIGRATION_NAME,
  HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_RPC_SIGNATURE,
  HF_SALARY_ADVANCE_PM_WORKER_HISTORY_MIGRATION_NAME,
  HF_SALARY_ADVANCE_PM_WORKER_HISTORY_RPC_SIGNATURE,
  T1A_HOTFIX_SALARY_ADVANCE_ACTOR_ACCESS_RPC_SIGNATURE,
  HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_MIGRATION_NAME,
  HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES,
  DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_MIGRATION_NAME,
  DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE,
  WORKER_EDIT_HISTORY_ADMIN_RPC_SIGNATURES,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES,
  ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_MIGRATION_NAME,
  ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES,
  ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME,
  ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES,
  ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME,
  ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES,
  WORKER_DIRECTORY_LABOR_TYPE_FILTER_MIGRATION_NAME,
  WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES,
  VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME,
  VFIN_04_SHARED_VENDOR_ADVANCE_NEW_RPC_SIGNATURES,
  VFIN_04_SHARED_VENDOR_ADVANCE_RPC_SIGNATURES,
  VFIN_05_COMBINED_PAYMENT_OFFSET_MIGRATION_NAME,
  VFIN_05_COMBINED_PAYMENT_OFFSET_NEW_RPC_SIGNATURES,
  VFIN_05_COMBINED_PAYMENT_OFFSET_RPC_SIGNATURES,
  RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME,
  RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES,
  RECRUITMENT_POSTS_MIGRATION_NAME,
  RECRUITMENT_POSTS_RPC_SIGNATURES,
  RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME,
  RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES,
  RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME,
  RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES,
  RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME,
  RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES,
  OFFBOARDING_REPORT_MIGRATION_NAME,
  OFFBOARDING_REPORT_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
  runMigrationApply,
  runMigrationValidation,
  S0_T1_C_PRE_PR92_CHECKSUM,
} from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const ACL_MIGRATION = "20261020180000_s0_t1_c_rpc_acl_allowlist.sql";
const R1_2_MIGRATION = "20261021100000_r1_2_worker_management_uat_fixes.sql";
const R2_1_MIGRATION = "20261021120000_r2_1_change_request_queues_and_project_team_guard.sql";
const R1_2_SERVICE_RPC =
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text)";
const TARGET_PATTERN = "^(direct_entry_|worker_edit_history_|work_report_|attendance_|org_department_|vendor_finance_|leave_management_|salary_advance_|hrp_sync_|ai_report_|ai_provider_config_|recruitment_|administrative_province_|industrial_park_|(expand|replace|reject|upsert)_daily_recruitment|record_recruitment_source_failure_|set_updated_at$)";

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "s0-t1-c-acl") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function prepareDatabase(client) {
  await client.query(
    "create role anon nologin; create role authenticated nologin;"
      + " create role service_role nologin bypassrls;"
      + " create schema auth; create table auth.users (id uuid primary key);"
      + " create table public.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now());",
  );
}

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function applyMigrations(client, names) {
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function aclSnapshot(client) {
  const { rows } = await client.query(
    `select p.oid::bigint as oid,
            p.proname,
            p.oid::pg_catalog.regprocedure::text as signature,
            p.prosecdef,
            pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
            pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
            pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
            exists (
              select 1
                from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
            ) as public_exec
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname ~ $1
      order by p.proname, p.oid::pg_catalog.regprocedure::text`,
    [TARGET_PATTERN],
  );
  return rows;
}

async function policySnapshot(client) {
  const { rows } = await client.query(
    `select p.polrelid::pg_catalog.regclass::text as table_name,
            p.polname,
            p.polcmd,
            p.polpermissive,
            p.polroles::text as role_oids,
            pg_catalog.pg_get_expr(p.polqual, p.polrelid) as using_expr,
            pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
       from pg_catalog.pg_policy p
       join pg_catalog.pg_class c on c.oid = p.polrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
      order by table_name, p.polname`,
  );
  return rows;
}

async function miniBiPolicyRoutineDependencies(client) {
  const { rows } = await client.query(
    `select pol.polrelid::pg_catalog.regclass::text as table_name,
            pol.polname,
            p.oid::pg_catalog.regprocedure::text as function_signature
       from pg_catalog.pg_depend d
       join pg_catalog.pg_policy pol
         on d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass and d.objid = pol.oid
       join pg_catalog.pg_proc p
         on d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = p.oid
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname ~ $1
      order by table_name, pol.polname, function_signature`,
    [TARGET_PATTERN],
  );
  return rows;
}

async function triggerSnapshot(client) {
  const { rows } = await client.query(
    `select t.tgrelid::pg_catalog.regclass::text as table_name,
            t.tgname,
            t.tgfoid::pg_catalog.regprocedure::text as function_signature,
            pg_catalog.pg_get_triggerdef(t.oid, true) as definition
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
      order by table_name, t.tgname`,
  );
  return rows;
}

async function aclDefaultsSnapshot(client) {
  const { rows } = await client.query(
    `select d.defaclrole::regrole::text as role_name,
            d.defaclnamespace::regnamespace::text as schema_name,
            d.defaclobjtype,
            d.defaclacl::text as acl
       from pg_catalog.pg_default_acl d
      order by role_name, schema_name, d.defaclobjtype`,
  );
  return rows;
}

test("S0-T1-C revokes broad Mini BI RPC ACLs while preserving the server allowlist and trigger paths",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the native ACL regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "s0-t1-c-rpc-acl-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const port = await freePort();
    const databaseName = `s0_t1c_${process.pid}`;
    let serverStarted = false;
    let admin;
    let client;

    try {
      run(initdb, [
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--pgdata", dataDir,
      ]);
      run(pgCtl, [
        "-D", dataDir,
        "-l", logFile,
        "-o", `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w", "start",
      ], { ignoreOutput: process.platform === "win32" });
      serverStarted = true;

      admin = await connect(port);
      await admin.query(`create database ${databaseName}`);
      client = await connect(port, databaseName, "s0-t1-c-setup");
      await prepareDatabase(client);
      const names = await migrationNames();
      const aclMigrationIndex = names.indexOf(ACL_MIGRATION);
      assert.notEqual(aclMigrationIndex, -1, "the T1-C migration is present in the migration chain");
      assert.ok(names.slice(0, aclMigrationIndex).includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
        "the selected c29 baseline is applied before the T1-C migration");
      await applyMigrations(client, names.slice(0, aclMigrationIndex));

      const before = await aclSnapshot(client);
      const sourceService = before.filter((row) => row.service_exec);
      const sourceOpen = before.filter((row) => row.anon_exec || row.authenticated_exec || row.public_exec);
      const sourceAnon = before.filter((row) => row.anon_exec).length;
      const sourceAuthenticated = before.filter((row) => row.authenticated_exec).length;
      const sourcePublic = before.filter((row) => row.public_exec).length;
      const sourceSecurityDefiner = before.filter((row) => row.prosecdef).length;
      assert.equal(sourceOpen.length, 1, "only the audit trigger helper has an open source-baseline grant");
      assert.deepEqual(sourceOpen.map((row) => row.signature), ["ai_report_audit_immutable()"],
        "the only open source-baseline routine is the audit trigger helper");

      const policiesBefore = await policySnapshot(client);
      const policyRoutineDependenciesBefore = await miniBiPolicyRoutineDependencies(client);
      assert.deepEqual(policyRoutineDependenciesBefore, [],
        "no RLS policy directly depends on a Mini BI RPC whose client EXECUTE grant is removed");
      const triggersBefore = await triggerSnapshot(client);
      const defaultsBefore = await aclDefaultsSnapshot(client);

      await client.query(
        "create role s0_t1c_runner nologin bypassrls;"
          + " grant postgres to s0_t1c_runner with admin false, inherit true, set false;"
          + " grant direct_entry_catalog_bootstrap_executor to s0_t1c_runner"
          + " with admin true, inherit false, set false;",
      );
      const { rows: runnerMembershipBefore } = await client.query(
        `select m.grantor::regrole::text as grantor, m.admin_option, m.inherit_option, m.set_option
           from pg_catalog.pg_auth_members m
          where m.member = 's0_t1c_runner'::regrole
            and m.roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
          order by grantor`,
      );
      assert.equal(runnerMembershipBefore.length, 1);
      assert.equal(runnerMembershipBefore[0].set_option, false,
        "the migration runner has ADMIN but not SET on the executor role");
      const { rows: runnerSetBefore } = await client.query(
        `select pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'SET') as can_set_executor`,
      );
      assert.equal(runnerSetBefore[0].can_set_executor, false,
        "the migration runner must use the temporary scoped membership path");

      // Reproduce the live bootstrap-owner ACL drift before broad staging grants.
      await client.query("set role direct_entry_catalog_bootstrap_executor");
      await client.query(
        "grant execute on function public.direct_entry_catalog_bootstrap_projection(),"
          + " public.direct_entry_catalog_bootstrap_plan(uuid,uuid),"
          + " public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)"
          + " to public, anon, authenticated, service_role",
      );
      await client.query("reset role");

      // Model the broad staging ACL with catalog-only grants inside this disposable cluster.
      await client.query(
        "create function public.s0_t1c_unrelated_probe() returns integer language sql immutable as $$ select 1 $$;"
          + " grant execute on all functions in schema public to public, anon, authenticated, service_role;",
      );
      const broadened = await aclSnapshot(client);
      assert.equal(broadened.filter((row) => row.anon_exec).length, broadened.length);
      assert.equal(broadened.filter((row) => row.authenticated_exec).length, broadened.length);
      assert.equal(broadened.filter((row) => row.service_exec).length, broadened.length);
      const migration = await readFile(path.join(MIGRATION_DIR, ACL_MIGRATION), "utf8");
      await client.query("set session authorization s0_t1c_runner");
      try {
        await client.query("begin");
        await client.query(migration);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        await client.query("reset session authorization");
      }
      const { rows: runnerMembershipAfter } = await client.query(
        `select m.grantor::regrole::text as grantor, m.admin_option, m.inherit_option, m.set_option
           from pg_catalog.pg_auth_members m
          where m.member = 's0_t1c_runner'::regrole
            and m.roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
          order by grantor`,
      );
      assert.deepEqual(runnerMembershipAfter, runnerMembershipBefore,
        "the migration removes its temporary SET membership and preserves the original role grant");
      const { rows: runnerSetAfter } = await client.query(
        `select pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'SET') as can_set_executor`,
      );
      assert.equal(runnerSetAfter[0].can_set_executor, false,
        "the temporary SET capability does not survive migration commit");
      const policiesAfterAcl = await policySnapshot(client);
      const triggersAfterAcl = await triggerSnapshot(client);
      const defaultsAfterAcl = await aclDefaultsSnapshot(client);
      assert.deepEqual(policiesAfterAcl, policiesBefore, "the ACL migration leaves RLS policy definitions and role lists unchanged");
      assert.deepEqual(await miniBiPolicyRoutineDependencies(client), policyRoutineDependenciesBefore,
        "the ACL migration leaves RLS policy function dependencies unchanged");
      assert.deepEqual(triggersAfterAcl, triggersBefore, "the ACL migration leaves trigger bindings unchanged");
      assert.deepEqual(defaultsAfterAcl, defaultsBefore,
        "the ACL migration does not alter global or schema default privileges");
      const r2_1Index = names.indexOf(R2_1_MIGRATION);
      assert.notEqual(r2_1Index, -1, "the R2.1 migration is present in the migration chain");
      await applyMigrations(client, names.slice(aclMigrationIndex + 1, r2_1Index));

      // Seed schema_migrations for #1..#128 with #124 carrying its pre-PR #92 historical checksum:
      for (const appliedName of names.slice(0, r2_1Index)) {
        const sqlText = await readFile(path.join(MIGRATION_DIR, appliedName), "utf8");
        const checksum =
          appliedName === ACL_MIGRATION
            ? S0_T1_C_PRE_PR92_CHECKSUM
            : migrationChecksum(sqlText);
        await client.query(
          "insert into public.schema_migrations (version, checksum) values ($1, $2)",
          [appliedName, checksum],
        );
      }

      const passthroughClient = () => ({
        async connect() {},
        query: (sql, params) => client.query(sql, params),
        async end() {},
      });

      // Verify fail-closed when an internal helper's ACL is broadened on a DB with #124's pre-PR #92 checksum:
      await client.query(
        "grant execute on function public.set_updated_at() to service_role",
      );
      await client.query("set session authorization s0_t1c_runner");
      try {
        const failedPreflight = await runMigrationValidation({
          mode: "dry-run",
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.deepEqual(
          failedPreflight.mismatches,
          [ACL_MIGRATION],
          "historical #124 checksum must fail closed when ACL postconditions are violated",
        );
      } finally {
        await client.query("reset session authorization");
      }
      await client.query(
        "revoke execute on function public.set_updated_at() from service_role",
      );

      // Reproduce the broad staging table ACL before WF-01, then verify the forward migration removes it.
      await client.query(
        "grant all on table public.direct_entry_employment_status_events to public, anon, authenticated, service_role",
      );

      // Verify preflight dry-run PASSES and official runMigrationApply applies #129 onward under non-superuser s0_t1c_runner
      // without mutating #124's historical ledger checksum or re-executing #124:
      await client.query("set session authorization s0_t1c_runner");
      try {
        const preflight = await runMigrationValidation({
          mode: "dry-run",
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.deepEqual(preflight.mismatches, [], "preflight dry-run passes when #124 postconditions hold");

        const applySummary = await runMigrationApply({
          directory: MIGRATION_DIR,
          loadConfig: async () => ({ databaseUrl: "postgres://local", projectRef: "s0t1" }),
          createClient: passthroughClient,
          log() {},
        });
        assert.equal(
          applySummary.appliedCount,
          names.length - r2_1Index,
          "only migrations from #129 onward are applied",
        );
        assert.equal(applySummary.skippedCount, r2_1Index, "all 128 prior migrations are skipped");
      } finally {
        await client.query("reset session authorization");
      }

      const { rows: statusTableAclAfter } = await client.query(
        `select coalesce(grantee_role.rolname, 'PUBLIC') as grantee, acl.privilege_type
           from pg_catalog.pg_class c
           cross join lateral pg_catalog.aclexplode(
             coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
           ) acl
           left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl.grantee
          where c.oid = 'public.direct_entry_employment_status_events'::pg_catalog.regclass
            and (acl.grantee = 0 or acl.grantee in (
              'anon'::pg_catalog.regrole,
              'authenticated'::pg_catalog.regrole,
              'service_role'::pg_catalog.regrole
            ))
          order by grantee, acl.privilege_type`,
      );
      assert.deepEqual(statusTableAclAfter, [],
        "the forward migration removes every direct table privilege from PUBLIC and client/service roles");

      const { rows: ledger124After } = await client.query(
        "select checksum from public.schema_migrations where version = $1",
        [ACL_MIGRATION],
      );
      assert.equal(
        ledger124After[0]?.checksum,
        S0_T1_C_PRE_PR92_CHECKSUM,
        "compatibility check never rewrites #124's historical ledger checksum",
      );
      const { rows: ledgerCountAfter } = await client.query(
        "select count(*)::integer as total from public.schema_migrations",
      );
      assert.equal(ledgerCountAfter[0]?.total, names.length, "ledger reaches every migration source entry after applying the pending tail");

      const expectedSignatures = [...migration.matchAll(/^\s+'(public\.[^']+)'[,]?$/gm)]
        .map((match) => match[1]);
      const r1_2Migration = await readFile(path.join(MIGRATION_DIR, R1_2_MIGRATION), "utf8");
      const r1_2Normalized = r1_2Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const r1_2Grant = "grant execute on function " + R1_2_SERVICE_RPC.toLowerCase() + " to service_role;";
      const r1_2Revoke = "revoke all on function " + R1_2_SERVICE_RPC.toLowerCase() +
        " from public, anon, authenticated, service_role;";
      assert.ok(r1_2Normalized.includes(r1_2Grant),
        "R1.2 explicitly grants only its new search RPC to service_role");
      assert.ok(r1_2Normalized.includes(r1_2Revoke),
        "R1.2 revokes client and inherited role access before adding the service grant");
      const f1Migration = await readFile(path.join(MIGRATION_DIR, F1_WORK_REPORTS_MIGRATION_NAME), "utf8");
      assert.match(
        f1Migration,
        /revoke all on function %s from public, anon, authenticated, service_role/,
        "F1 Work Reports revokes all work_report_* functions before granting allowlisted RPCs",
      );
      const assignmentOptionsMigration = await readFile(
        path.join(MIGRATION_DIR, F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_MIGRATION_NAME), "utf8",
      );
      const assignmentOptionsNormalized = assignmentOptionsMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const assignmentOptionsGrant = `grant execute on function ${F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE.toLowerCase()} to service_role;`;
      const assignmentOptionsRevoke = `revoke all on function ${F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`;
      assert.ok(assignmentOptionsNormalized.includes(assignmentOptionsGrant),
        "assignment options RPC is explicitly granted only to service_role");
      assert.ok(assignmentOptionsNormalized.includes(assignmentOptionsRevoke),
        "assignment options RPC revokes default/client EXECUTE before granting service_role");
      const assignmentTrackingMigration = await readFile(
        path.join(MIGRATION_DIR, F1_WORK_REPORTS_ASSIGNMENT_TRACKING_MIGRATION_NAME), "utf8",
      );
      const assignmentTrackingNormalized = assignmentTrackingMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const assignmentTrackingGrant = `grant execute on function ${F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE.toLowerCase()} to service_role;`;
      const assignmentTrackingRevoke = `revoke all on function ${F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`;
      assert.ok(assignmentTrackingNormalized.includes(assignmentTrackingGrant),
        "assignment tracking RPC is explicitly granted only to service_role");
      assert.ok(assignmentTrackingNormalized.includes(assignmentTrackingRevoke),
        "assignment tracking RPC revokes client and inherited EXECUTE before granting service_role");
      const f1_5AnalyticsMigration = await readFile(
        path.join(MIGRATION_DIR, F1_5_WORK_REPORTS_ANALYTICS_MIGRATION_NAME), "utf8",
      );
      assert.match(
        f1_5AnalyticsMigration,
        /revoke all on function public\.work_report__internal_resolve_analytics_scope\(uuid, uuid, boolean, uuid, uuid, uuid\)\s+from public, anon, authenticated, service_role;/i,
        "F1.5 internal analytics scope helper revokes EXECUTE from all roles including service_role",
      );
      const f2ReviewAndDelegationMigration = await readFile(
        path.join(MIGRATION_DIR, F2_WORK_REPORTS_REVIEW_AND_DELEGATION_MIGRATION_NAME), "utf8",
      );
      assert.match(
        f2ReviewAndDelegationMigration,
        /revoke all on function public\.work_report__internal_resolve_capability_authority\(uuid, text, uuid, uuid, timestamptz\)\s+from public, anon, authenticated, service_role;/i,
        "F2 internal capability authority helper revokes EXECUTE from all roles including service_role",
      );
      const wf01Migration = await readFile(
        path.join(MIGRATION_DIR, WF01_WORKFORCE_SNAPSHOT_MIGRATION_NAME), "utf8",
      );
      const wf01Normalized = wf01Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const wf01Grant = `grant execute on function ${WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE.toLowerCase()} to service_role;`;
      const wf01Revoke = `revoke all on function ${WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`;
      assert.ok(wf01Normalized.includes(wf01Grant),
        "WF-01 workforce reporting RPC is explicitly granted only to service_role");
      assert.ok(wf01Normalized.includes(wf01Revoke),
        "WF-01 workforce reporting RPC revokes client and inherited EXECUTE before granting service_role");
      const wf02Migration = await readFile(
        path.join(MIGRATION_DIR, WF02_WORKFORCE_BALANCE_WAITING_MIGRATION_NAME), "utf8",
      );
      const wf02Normalized = wf02Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      assert.ok(wf02Normalized.includes(wf01Grant),
        "WF-02 workforce reporting RPC is explicitly granted only to service_role");
      assert.ok(wf02Normalized.includes(wf01Revoke),
        "WF-02 workforce reporting RPC revokes client and inherited EXECUTE before granting service_role");
      const searchMigration = await readFile(
        path.join(MIGRATION_DIR, PROJECT_TEAM_SCOPE_SEARCH_MIGRATION_NAME), "utf8",
      );
      const searchNormalized = searchMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      const searchGrant = `grant execute on function ${PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE.toLowerCase()} to service_role;`;
      const searchRevoke = `revoke all on function ${PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`;
      assert.ok(searchNormalized.includes(searchGrant),
        "Project<->Team mapping search RPC is explicitly granted only to service_role");
      assert.ok(searchNormalized.includes(searchRevoke),
        "Project<->Team mapping search RPC revokes client and inherited EXECUTE before granting service_role");
      const duplicateSelfServiceMigration = await readFile(
        path.join(MIGRATION_DIR, DUPLICATE_CCCD_SELF_SERVICE_MIGRATION_NAME), "utf8",
      );
      const duplicateSelfServiceNormalized = duplicateSelfServiceMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      for (const sig of DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(duplicateSelfServiceNormalized.includes(sigGrant),
          `duplicate CCCD self-service RPC ${sig} is explicitly granted only to service_role`);
        assert.ok(duplicateSelfServiceNormalized.includes(sigRevoke),
          `duplicate CCCD self-service RPC ${sig} revokes client and inherited EXECUTE before granting service_role`);
      }
      assert.match(
        duplicateSelfServiceMigration,
        /revoke all on function public\.direct_entry__internal_apply_entry_void\(\s*uuid,\s*uuid,\s*uuid,\s*integer,\s*uuid,\s*text,\s*text,\s*text,\s*uuid\s*\)\s*from public, anon, authenticated, service_role;/i,
        "shared internal entry-void helper revokes EXECUTE from all roles including service_role",
      );
      const workReportsReaderMigration = await readFile(
        path.join(MIGRATION_DIR, WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME), "utf8",
      );
      const workReportsReaderNormalized = workReportsReaderMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      for (const sig of WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(workReportsReaderNormalized.includes(sigGrant),
          `Work Reports reader RPC ${sig} is explicitly granted only to service_role`);
        assert.ok(workReportsReaderNormalized.includes(sigRevoke),
          `Work Reports reader RPC ${sig} revokes client and inherited EXECUTE before granting service_role`);
      }
      const attendanceWp1Migration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_WP1_MIGRATION_NAME), "utf8",
      );
      const attendanceWp1Normalized = attendanceWp1Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      for (const sig of ATTENDANCE_WP1_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(attendanceWp1Normalized.includes(sigGrant),
          `Attendance WP1 RPC ${sig} is explicitly granted only to service_role`);
        assert.ok(attendanceWp1Normalized.includes(sigRevoke),
          `Attendance WP1 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`);
      }
      assert.match(
        attendanceWp1Migration,
        /revoke all on function public\.attendance__internal_immutable_guard\(\)\s+from public, anon, authenticated, service_role;/i,
        "Attendance WP1 immutable guard trigger helper revokes EXECUTE from all roles including service_role",
      );
      const offboardingMigration = await readFile(
        path.join(MIGRATION_DIR, OFFBOARDING_REPORT_MIGRATION_NAME), "utf8",
      );
      const offboardingNormalized = offboardingMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      for (const sig of OFFBOARDING_REPORT_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(offboardingNormalized.includes(sigGrant),
          `Offboarding RPC ${sig} is explicitly granted only to service_role`);
        assert.ok(offboardingNormalized.includes(sigRevoke),
          `Offboarding RPC ${sig} revokes client and inherited EXECUTE before granting service_role`);
      }
      const asyncPhotoMigration = await readFile(
        path.join(MIGRATION_DIR, ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_MIGRATION_NAME), "utf8",
      );
      const asyncPhotoNormalized = asyncPhotoMigration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      assert.ok(
        asyncPhotoNormalized.includes(
          `grant execute on function ${ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE.toLowerCase()} to service_role;`,
        ),
        "Attendance private-photo RPC is explicitly granted only to service_role",
      );
      assert.ok(
        asyncPhotoNormalized.includes(
          `revoke all on function ${ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`,
        ),
        "Attendance private-photo RPC revokes client and inherited EXECUTE before granting service_role",
      );
      const hfOffboardingAndAttendanceMigration = await readFile(
        path.join(MIGRATION_DIR, HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME),
        "utf8",
      );
      const hfOffboardingAndAttendanceNormalized = hfOffboardingAndAttendanceMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          hfOffboardingAndAttendanceNormalized.includes(sigGrant),
          `HF offboarding/attendance RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          hfOffboardingAndAttendanceNormalized.includes(sigRevoke),
          `HF offboarding/attendance RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      const hfOffboardingPerfMigration = await readFile(
        path.join(MIGRATION_DIR, HF_OFFBOARDING_REPORT_QUERY_PERFORMANCE_MIGRATION_NAME),
        "utf8",
      );
      const hfOffboardingPerfNormalized = hfOffboardingPerfMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      assert.ok(
        hfOffboardingPerfNormalized.includes(
          "revoke all on function public.direct_entry_offboarding_authority(uuid, uuid) from public, anon, authenticated, service_role;",
        ),
        "HF offboarding performance authority helper revokes EXECUTE from all runtime roles",
      );
      assert.ok(
        hfOffboardingPerfNormalized.includes(
          "revoke all on function public.direct_entry__internal_offboarding_candidates(text, uuid, date) from public, anon, authenticated, service_role;",
        ),
        "HF offboarding performance internal candidate helper revokes EXECUTE from all runtime roles",
      );
      for (const sig of [
        ...OFFBOARDING_REPORT_RPC_SIGNATURES,
        "public.direct_entry_offboarding_hide_snapshot(uuid, uuid, uuid, uuid, text, text)",
      ]) {
        assert.ok(
          hfOffboardingPerfNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `HF offboarding performance RPC ${sig} revokes inherited EXECUTE before granting service_role`,
        );
        assert.ok(
          hfOffboardingPerfNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `HF offboarding performance RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const attendanceSelfHistoryMigration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_SELF_HISTORY_MIGRATION_NAME), "utf8",
      );
      const attendanceSelfHistoryNormalized = attendanceSelfHistoryMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          attendanceSelfHistoryNormalized.includes(sigGrant),
          `Attendance self-history RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          attendanceSelfHistoryNormalized.includes(sigRevoke),
          `Attendance self-history RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      const orgShell01Migration = await readFile(
        path.join(MIGRATION_DIR, ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME),
        "utf8",
      );
      const orgShell01Normalized = orgShell01Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          orgShell01Normalized.includes(sigGrant),
          `ORG-SHELL-01 RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          orgShell01Normalized.includes(sigRevoke),
          `ORG-SHELL-01 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      assert.match(
        orgShell01Migration,
        /revoke all on function public\.org_department__internal_resolve_vfin_default_authority\(uuid, uuid, date\)\s+from public, anon, authenticated, service_role;/i,
        "ORG-SHELL-01 internal VFIN default authority primitive revokes EXECUTE from all roles including service_role",
      );
      const vfin01Migration = await readFile(
        path.join(MIGRATION_DIR, VFIN_01_BACKEND_MIGRATION_NAME),
        "utf8",
      );
      const vfin01Normalized = vfin01Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of VFIN_01_BACKEND_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          vfin01Normalized.includes(sigGrant),
          `VFIN-01 RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          vfin01Normalized.includes(sigRevoke),
          `VFIN-01 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      assert.match(
        vfin01Migration,
        /revoke all on function public\.vendor_finance__internal_resolve_authority\(uuid, uuid\)\s+from public, anon, authenticated, service_role;/i,
        "VFIN-01 internal authority primitive revokes EXECUTE from all roles including service_role",
      );
      const hfWorkReportsMigration = await readFile(
        path.join(MIGRATION_DIR, HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_MIGRATION_NAME),
        "utf8",
      );
      const hfWorkReportsNormalized = hfWorkReportsMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          hfWorkReportsNormalized.includes(sigGrant),
          `HF Work Reports RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          hfWorkReportsNormalized.includes(sigRevoke),
          `HF Work Reports RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      const vfin02Migration = await readFile(
        path.join(MIGRATION_DIR, VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME),
        "utf8",
      );
      const vfin02Normalized = vfin02Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of VFIN_02_PROJECT_LEDGERS_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          vfin02Normalized.includes(sigGrant),
          `VFIN-02 RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          vfin02Normalized.includes(sigRevoke),
          `VFIN-02 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      const hfVfin02Migration = await readFile(
        path.join(MIGRATION_DIR, HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_MIGRATION_NAME),
        "utf8",
      );
      const hfVfin02Normalized = hfVfin02Migration.replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").toLowerCase();
      assert.equal(HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_RPC_SIGNATURES.length, 23);
      for (const sig of HF_VFIN_02_IMPLICIT_VENDOR_PROJECT_RPC_SIGNATURES) {
        assert.ok(hfVfin02Normalized.includes(`grant execute on function ${sig.toLowerCase()} to service_role;`));
        assert.ok(hfVfin02Normalized.includes(`revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`));
      }
      assert.match(hfVfin02Migration, /drop function public\.vendor_finance_list_project_vendors_admin\(/i);
      assert.match(hfVfin02Migration, /drop function public\.vendor_finance_set_project_vendor_link_admin\(/i);
      assert.match(
        vfin02Migration,
        /revoke all on function public\.vendor_finance__internal_can_actor_write_subledger\(jsonb, uuid, text, text, text, uuid\)\s+from public, anon, authenticated, service_role;/i,
        "VFIN-02 internal sub-ledger write guard revokes EXECUTE from all roles including service_role",
      );
      const cccdQrStage1Migration = await readFile(
        path.join(MIGRATION_DIR, CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME),
        "utf8",
      );
      const cccdQrStage1Normalized = cccdQrStage1Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          cccdQrStage1Normalized.includes(sigGrant),
          `CCCD QR Stage 1 RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          cccdQrStage1Normalized.includes(sigRevoke),
          `CCCD QR Stage 1 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      assert.ok(
        cccdQrStage1Normalized.includes(
          "revoke all on function public.direct_entry__internal_assert_cccd_qr_read_access(uuid, uuid, uuid) from public, anon, authenticated, service_role;",
        ),
        "CCCD QR Stage 1 internal read-access helper revokes EXECUTE from all roles including service_role",
      );
      assert.ok(
        cccdQrStage1Normalized.includes(
          "revoke all on function public.direct_entry__internal_project_cccd_qr_extraction(public.direct_entry_cccd_qr_extractions, jsonb) from public, anon, authenticated, service_role;",
        ),
        "CCCD QR Stage 1 internal projection helper revokes EXECUTE from all roles including service_role",
      );
      const preWave2CccdReviewMigration = await readFile(
        path.join(MIGRATION_DIR, PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME),
        "utf8",
      );
      const preWave2CccdReviewNormalized = preWave2CccdReviewMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          preWave2CccdReviewNormalized.includes(sigGrant),
          `Pre-Wave-2 CCCD Review RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          preWave2CccdReviewNormalized.includes(sigRevoke),
          `Pre-Wave-2 CCCD Review RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }
      const cccdManualResolutionMigration = await readFile(
        path.join(MIGRATION_DIR, CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME),
        "utf8",
      );
      const cccdManualResolutionNormalized = cccdManualResolutionMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      const cccdManualSig = CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE;
      assert.ok(
        cccdManualResolutionNormalized.includes(
          `grant execute on function ${cccdManualSig} to service_role;`,
        ),
        "manual CCCD review RPC is explicitly granted only to service_role",
      );
      assert.ok(
        cccdManualResolutionNormalized.includes(
          `revoke all on function ${cccdManualSig} from public, anon, authenticated, service_role;`,
        ),
        "manual CCCD review RPC revokes client and inherited EXECUTE before granting service_role",
      );
      assert.ok(
        preWave2CccdReviewNormalized.includes(
          "revoke all on function public.direct_entry__internal_resolve_cccd_review_authority(uuid, uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated, service_role;",
        ),
        "Pre-Wave-2 CCCD Review internal authority helper revokes EXECUTE from all roles including service_role",
      );
      assert.ok(
        preWave2CccdReviewNormalized.includes(
          "revoke all on function public.direct_entry__internal_recompute_cccd_reconciliation(uuid, uuid) from public, anon, authenticated, service_role;",
        ),
        "Pre-Wave-2 CCCD Review internal reconciliation helper revokes EXECUTE from all roles including service_role",
      );

      const workReportsAndroidSyncMigration = await readFile(
        path.join(MIGRATION_DIR, WORK_REPORTS_ANDROID_SYNC_AND_UX_MIGRATION_NAME),
        "utf8",
      );
      const workReportsAndroidSyncNormalized = workReportsAndroidSyncMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      assert.ok(
        workReportsAndroidSyncNormalized.includes(
          `grant execute on function ${WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE} to service_role;`,
        ),
        "work_report_get_assignment_detail RPC is explicitly granted only to service_role",
      );
      assert.ok(
        workReportsAndroidSyncNormalized.includes(
          `revoke all on function ${WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE} from public, anon, authenticated, service_role;`,
        ),
        "work_report_get_assignment_detail RPC revokes client and inherited EXECUTE before granting service_role",
      );

      const adminLinkPersonnelAccountMigration = await readFile(
        path.join(MIGRATION_DIR, ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_MIGRATION_NAME),
        "utf8",
      );
      const adminLinkPersonnelAccountNormalized = adminLinkPersonnelAccountMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          adminLinkPersonnelAccountNormalized.includes(sigGrant),
          `Admin Link Personnel Account RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          adminLinkPersonnelAccountNormalized.includes(sigRevoke),
          `Admin Link Personnel Account RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }

      const vfin03ContractTypeLedgersMigration = await readFile(
        path.join(MIGRATION_DIR, VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME),
        "utf8",
      );
      const vfin03ContractTypeLedgersNormalized = vfin03ContractTypeLedgersMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of [
        "public.vendor_finance_list_vendors(uuid, uuid, text, text, text, text, uuid, text, text, integer, integer)",
        "public.vendor_finance_get_vendor(uuid, uuid, text, text, uuid, text, text)",
        "public.vendor_finance_list_vendor_entries(uuid, uuid, text, bigint, text, integer, text, uuid, text, text, text)",
        "public.vendor_finance_list_vendor_reconciliations(uuid, uuid, text, integer, integer, text, uuid, text, text)",
        "public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)",
        "public.vendor_finance_preview_opening_batch(uuid, uuid, text, text, date, jsonb)",
        "public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)",
        "public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)",
        "public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)",
        "public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)",
      ]) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          vfin03ContractTypeLedgersNormalized.includes(sigGrant),
          `VFIN-03 RPC ${sig} is explicitly granted only to service_role`,
        );
        assert.ok(
          vfin03ContractTypeLedgersNormalized.includes(sigRevoke),
          `VFIN-03 RPC ${sig} revokes client and inherited EXECUTE before granting service_role`,
        );
      }

      const leaveWp1Migration = await readFile(
        path.join(MIGRATION_DIR, LEAVE_MANAGEMENT_WP1_MIGRATION_NAME),
        "utf8",
      );
      const leaveWp1Normalized = leaveWp1Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES) {
        assert.ok(
          leaveWp1Normalized.includes(sig.toLowerCase()),
          `Leave Management WP1 migration includes signature ${sig}`,
        );
      }

      expectedSignatures.push(R1_2_SERVICE_RPC, ...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
        F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
        F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
        ...F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
        ...F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES,
        WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE,
        PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE,
        ...DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES,
        ...WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
        ...ATTENDANCE_WP1_RPC_SIGNATURES,
        ...ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES,
        ...OFFBOARDING_REPORT_RPC_SIGNATURES,
        ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE,
        ...HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES,
        ...ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES,
        ...ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES,
        ...VFIN_05_COMBINED_PAYMENT_OFFSET_RPC_SIGNATURES,
        ...HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES,
        ...CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES,
        ...PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
        CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
        WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE,
        ...ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES,
        ...LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES,
        LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE,
        ...SALARY_ADVANCE_WP1_RPC_SIGNATURES,
        HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_RPC_SIGNATURE,
        HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_RPC_SIGNATURE,
        HF_SALARY_ADVANCE_PM_WORKER_HISTORY_RPC_SIGNATURE,
        T1A_HOTFIX_SALARY_ADVANCE_ACTOR_ACCESS_RPC_SIGNATURE,
        ...HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES,
        DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE,
        ...WORKER_EDIT_HISTORY_ADMIN_RPC_SIGNATURES,
        ...ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES,
        ...ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES,
        ...ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES,
        ...ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES,
        ...ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES,
        ...WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES,
        ...RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES,
        ...RECRUITMENT_POSTS_RPC_SIGNATURES,
        ...RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES,
        ...RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES,
        ...RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES);
      assert.ok(expectedSignatures.length > 0, "the explicit server/invoker allowlist is not empty");
      assert.equal(new Set(expectedSignatures).size, expectedSignatures.length, "the allowlist has no duplicates");
      const { rows: resolvedExpected } = await client.query(
        "select signature, pg_catalog.to_regprocedure(signature)::oid::bigint as oid"
          + " from unnest($1::text[]) as signatures(signature) order by 1",
        [expectedSignatures],
      );
      assert.ok(resolvedExpected.every((row) => row.oid !== null), "all explicit allowlist signatures resolve");
      const expectedOids = resolvedExpected.map((row) => String(row.oid)).sort();
      const expectedOidSet = new Set(expectedOids);
      const sourceServiceOidSet = new Set(sourceService.map((row) => String(row.oid)));
      const allowlistMissingFromSource = resolvedExpected
        .filter((row) => !sourceServiceOidSet.has(String(row.oid))).map((row) => row.signature);
      assert.deepEqual(
        allowlistMissingFromSource,
        [R1_2_SERVICE_RPC, ...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
          F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
          F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
          ...F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
          ...F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES,
          WF01_WORKFORCE_SNAPSHOT_RPC_SIGNATURE,
          PROJECT_TEAM_SCOPE_SEARCH_RPC_SIGNATURE,
          ...DUPLICATE_CCCD_SELF_SERVICE_RPC_SIGNATURES,
          ...WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
          ...ATTENDANCE_WP1_RPC_SIGNATURES,
          ...ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES,
          ...OFFBOARDING_REPORT_RPC_SIGNATURES,
          ASYNC_DOCUMENTS_ATTENDANCE_PHOTO_RPC_SIGNATURE,
          ...HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_RPC_SIGNATURES,
          ...ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES,
          ...ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES,
          ...VFIN_05_COMBINED_PAYMENT_OFFSET_RPC_SIGNATURES,
          ...HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES,
          ...CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES,
          ...PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
          CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
          WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE,
          ...ADMIN_LINK_EXISTING_PERSONNEL_ACCOUNT_RPC_SIGNATURES,
          ...LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES,
          LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE,
          ...SALARY_ADVANCE_WP1_RPC_SIGNATURES,
          HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_RPC_SIGNATURE,
          HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_RPC_SIGNATURE,
          HF_SALARY_ADVANCE_PM_WORKER_HISTORY_RPC_SIGNATURE,
          T1A_HOTFIX_SALARY_ADVANCE_ACTOR_ACCESS_RPC_SIGNATURE,
          ...HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES,
          DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE,
          ...WORKER_EDIT_HISTORY_ADMIN_RPC_SIGNATURES,
          ...ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES,
          ...ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES,
          ...ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES,
          ...ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES,
          ...ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES,
          ...WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES,
          ...RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES,
          ...RECRUITMENT_POSTS_RPC_SIGNATURES,
          ...RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES,
          ...RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES,
          ...RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES].sort(),
        "only explicitly reviewed post-S0 RPCs add service_role grants after the S0 baseline",
      );
      const recruitmentLocationCatalogMigration = await readFile(
        path.join(MIGRATION_DIR, RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME),
        "utf8",
      );
      const recruitmentLocationCatalogNormalized = recruitmentLocationCatalogMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES) {
        assert.ok(
          recruitmentLocationCatalogNormalized.includes(sig.toLowerCase()),
          `recruitment location catalog migration includes signature ${sig}`,
        );
      }
      const recruitmentPostsMigration = await readFile(
        path.join(MIGRATION_DIR, RECRUITMENT_POSTS_MIGRATION_NAME),
        "utf8",
      );
      const recruitmentPostsNormalized = recruitmentPostsMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of RECRUITMENT_POSTS_RPC_SIGNATURES) {
        assert.ok(
          recruitmentPostsNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `recruitment posts RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          recruitmentPostsNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `recruitment posts RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      for (const internalSig of [
        "public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)",
        "public.recruitment_post__internal_actor_label(uuid)",
        "public.recruitment_post__internal_idempotency_begin(uuid, text, text, text)",
        "public.recruitment_post__internal_filter_hash(text, uuid, uuid, text, date, date)",
        "public.recruitment_post__internal_normalize_payload(text, jsonb)",
        "public.recruitment_post__internal_snapshot(public.recruitment_project_briefs, text[])",
        "public.recruitment_post__internal_projection(public.recruitment_project_briefs, uuid)",
        "public.recruitment_post__internal_briefs_write_guard()",
        "public.recruitment_post__internal_brief_labor_write_guard()",
        "public.recruitment_post__internal_guard_park_province_change()",
      ]) {
        assert.ok(
          recruitmentPostsNormalized.includes(
            `revoke all on function ${internalSig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `recruitment posts internal helper ${internalSig} revokes EXECUTE from all roles including service_role`,
        );
      }
      const recruitmentPostListMineMigration = await readFile(
        path.join(MIGRATION_DIR, RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME),
        "utf8",
      );
      const recruitmentPostListMineNormalized = recruitmentPostListMineMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of [
        "public.recruitment_post_list(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)",
        ...RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES,
      ]) {
        assert.ok(
          recruitmentPostListMineNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `recruitment posts list/mine RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          recruitmentPostListMineNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `recruitment posts list/mine RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const recruitmentPostPublicFeedV1Migration = await readFile(
        path.join(MIGRATION_DIR, RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME),
        "utf8",
      );
      const recruitmentPostPublicFeedV1Normalized = recruitmentPostPublicFeedV1Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES) {
        assert.ok(
          recruitmentPostPublicFeedV1Normalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `recruitment posts public feed v1 RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          recruitmentPostPublicFeedV1Normalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `recruitment posts public feed v1 RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const recruitmentPostListWithFacetsMigration = await readFile(
        path.join(MIGRATION_DIR, RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME),
        "utf8",
      );
      const recruitmentPostListWithFacetsNormalized = recruitmentPostListWithFacetsMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES) {
        assert.ok(
          recruitmentPostListWithFacetsNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `recruitment posts list with facets RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          recruitmentPostListWithFacetsNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `recruitment posts list with facets RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const attendanceSlotPolicyFourSlotMigration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_MIGRATION_NAME),
        "utf8",
      );
      const attendanceSlotPolicyFourSlotNormalized = attendanceSlotPolicyFourSlotMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_SLOT_POLICY_AND_FOUR_SLOT_MATRIX_RPC_SIGNATURES) {
        assert.ok(
          attendanceSlotPolicyFourSlotNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `attendance slot policy RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          attendanceSlotPolicyFourSlotNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `attendance slot policy RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const attendanceFlexibleSlotPolicyMigration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME),
        "utf8",
      );
      const attendanceFlexibleSlotPolicyNormalized = attendanceFlexibleSlotPolicyMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES) {
        assert.ok(
          attendanceFlexibleSlotPolicyNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `attendance flexible slot policy RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          attendanceFlexibleSlotPolicyNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `attendance flexible slot policy RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const attendanceExplanationsWave2Migration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME),
        "utf8",
      );
      const attendanceExplanationsWave2Normalized = attendanceExplanationsWave2Migration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES) {
        assert.ok(
          attendanceExplanationsWave2Normalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `attendance explanations wave2 RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          attendanceExplanationsWave2Normalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `attendance explanations wave2 RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const attendanceMultiSlotPolicyProfilesMigration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME),
        "utf8",
      );
      const attendanceMultiSlotPolicyProfilesNormalized = attendanceMultiSlotPolicyProfilesMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES) {
        assert.ok(
          attendanceMultiSlotPolicyProfilesNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `attendance multi slot policy profiles RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          attendanceMultiSlotPolicyProfilesNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `attendance multi slot policy profiles RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const dashboardDetailedMatrixCatalogMigration = await readFile(
        path.join(MIGRATION_DIR, DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_MIGRATION_NAME),
        "utf8",
      );
      const attendanceMonthlyMatrixBranchesMigration = await readFile(
        path.join(MIGRATION_DIR, ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME),
        "utf8",
      );
      const attendanceMonthlyMatrixBranchesNormalized = attendanceMonthlyMatrixBranchesMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      for (const sig of ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES) {
        assert.ok(
          attendanceMonthlyMatrixBranchesNormalized.includes(
            `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`,
          ),
          `attendance monthly matrix / branch / project location / hrp catalog RPC ${sig} revokes inherited RPC grants`,
        );
        assert.ok(
          attendanceMonthlyMatrixBranchesNormalized.includes(
            `grant execute on function ${sig.toLowerCase()} to service_role;`,
          ),
          `attendance monthly matrix / branch / project location / hrp catalog RPC ${sig} grants EXECUTE only to service_role`,
        );
      }
      const dashboardDetailedMatrixCatalogNormalized =
        dashboardDetailedMatrixCatalogMigration
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .toLowerCase();
      assert.ok(
        dashboardDetailedMatrixCatalogNormalized.includes(
          `revoke all on function ${DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE.toLowerCase()} from public, anon, authenticated, service_role;`,
        ),
        "detailed recruitment matrix catalog RPC revokes inherited RPC grants before granting service_role",
      );
      assert.ok(
        dashboardDetailedMatrixCatalogNormalized.includes(
          `grant execute on function ${DASHBOARD_DETAILED_RECRUITMENT_MATRIX_CATALOG_RPC_SIGNATURE.toLowerCase()} to service_role;`,
        ),
        "detailed recruitment matrix catalog RPC grants RPC execution only to service_role",
      );
      const hfDuplicateCccdResignedWithdrawAndWorkerFiltersMigration = await readFile(
        path.join(MIGRATION_DIR, HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_MIGRATION_NAME),
        "utf8",
      );
      const hfDuplicateCccdResignedWithdrawAndWorkerFiltersNormalized =
        hfDuplicateCccdResignedWithdrawAndWorkerFiltersMigration
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .toLowerCase();
      for (const sig of HF_DUPLICATE_CCCD_RESIGNED_WITHDRAW_AND_WORKER_FILTERS_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          hfDuplicateCccdResignedWithdrawAndWorkerFiltersNormalized.includes(sigRevoke),
          `duplicate CCCD resigned withdraw / worker filters RPC ${sig} revokes inherited RPC grants before granting service_role`,
        );
        assert.ok(
          hfDuplicateCccdResignedWithdrawAndWorkerFiltersNormalized.includes(sigGrant),
          `duplicate CCCD resigned withdraw / worker filters RPC ${sig} grants RPC execution only to service_role`,
        );
      }
      const workerDirectoryLaborTypeFilterMigration = await readFile(
        path.join(MIGRATION_DIR, WORKER_DIRECTORY_LABOR_TYPE_FILTER_MIGRATION_NAME),
        "utf8",
      );
      const workerDirectoryLaborTypeFilterNormalized =
        workerDirectoryLaborTypeFilterMigration
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .toLowerCase();
      for (const sig of WORKER_DIRECTORY_LABOR_TYPE_FILTER_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          workerDirectoryLaborTypeFilterNormalized.includes(sigRevoke),
          `worker directory labor_type filter RPC ${sig} revokes inherited RPC grants before granting service_role`,
        );
        assert.ok(
          workerDirectoryLaborTypeFilterNormalized.includes(sigGrant),
          `worker directory labor_type filter RPC ${sig} grants RPC execution only to service_role`,
        );
      }
      const vfin04SharedVendorAdvanceMigration = await readFile(
        path.join(MIGRATION_DIR, VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME),
        "utf8",
      );
      const vfin04SharedVendorAdvanceNormalized =
        vfin04SharedVendorAdvanceMigration
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .toLowerCase();
      for (const sig of VFIN_04_SHARED_VENDOR_ADVANCE_NEW_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          vfin04SharedVendorAdvanceNormalized.includes(sigRevoke),
          `VFIN-04 shared advance RPC ${sig} revokes inherited RPC grants before granting service_role`,
        );
        assert.ok(
          vfin04SharedVendorAdvanceNormalized.includes(sigGrant),
          `VFIN-04 shared advance RPC ${sig} grants RPC execution only to service_role`,
        );
      }
      const vfin05CombinedPaymentOffsetMigration = await readFile(
        path.join(MIGRATION_DIR, VFIN_05_COMBINED_PAYMENT_OFFSET_MIGRATION_NAME),
        "utf8",
      );
      const vfin05CombinedPaymentOffsetNormalized =
        vfin05CombinedPaymentOffsetMigration
          .replace(/\s+/g, " ")
          .replace(/\(\s+/g, "(")
          .replace(/\s+\)/g, ")")
          .toLowerCase();
      for (const sig of VFIN_05_COMBINED_PAYMENT_OFFSET_NEW_RPC_SIGNATURES) {
        const sigGrant = `grant execute on function ${sig.toLowerCase()} to service_role;`;
        const sigRevoke = `revoke all on function ${sig.toLowerCase()} from public, anon, authenticated, service_role;`;
        assert.ok(
          vfin05CombinedPaymentOffsetNormalized.includes(sigRevoke),
          `VFIN-05 combined payment+offset RPC ${sig} revokes inherited RPC grants before granting service_role`,
        );
        assert.ok(
          vfin05CombinedPaymentOffsetNormalized.includes(sigGrant),
          `VFIN-05 combined payment+offset RPC ${sig} grants RPC execution only to service_role`,
        );
      }
      const hfSalaryAdvancePmWorkerHistoryMigration = await readFile(
        path.join(MIGRATION_DIR, HF_SALARY_ADVANCE_PM_WORKER_HISTORY_MIGRATION_NAME),
        "utf8",
      );
      assert.match(
        hfSalaryAdvancePmWorkerHistoryMigration,
        /revoke all on function[\s\S]*public\.salary_advance_list_project_worker_history\(uuid, uuid, text, uuid, text, text, text, text, text, integer\)[\s\S]*from public, anon, authenticated, service_role;/i,
        "salary advance PM worker history migration revokes inherited RPC grants before granting service_role",
      );
      assert.match(
        hfSalaryAdvancePmWorkerHistoryMigration,
        /grant execute on function[\s\S]*public\.salary_advance_list_project_worker_history\(uuid, uuid, text, uuid, text, text, text, text, text, integer\)[\s\S]*to service_role;/i,
        "salary advance PM worker history migration grants RPC execution only to service_role",
      );
      const hfSalaryAdvanceWorkerHistoryMigration = await readFile(
        path.join(MIGRATION_DIR, HF_SALARY_ADVANCE_VENDOR_EXCLUSION_AND_WORKER_HISTORY_MIGRATION_NAME),
        "utf8",
      );
      assert.match(
        hfSalaryAdvanceWorkerHistoryMigration,
        /revoke all on function[\s\S]*public\.salary_advance_list_worker_history\(uuid, uuid, uuid, text, text, text, text, text, integer\)[\s\S]*from public, anon, authenticated, service_role;/i,
        "salary advance worker history migration revokes inherited RPC grants before granting service_role",
      );
      assert.match(
        hfSalaryAdvanceWorkerHistoryMigration,
        /grant execute on function[\s\S]*public\.salary_advance_list_worker_history\(uuid, uuid, uuid, text, text, text, text, text, integer\)[\s\S]*to service_role;/i,
        "salary advance worker history migration grants RPC execution only to service_role",
      );
      const hfSalaryAdvanceActorMigration = await readFile(
        path.join(MIGRATION_DIR, HF_SALARY_ADVANCE_ACTOR_DISPLAY_NAME_MIGRATION_NAME),
        "utf8",
      );
      assert.match(
        hfSalaryAdvanceActorMigration,
        /revoke all on function[\s\S]*public\.salary_advance_create_request\(uuid, uuid, text, uuid, text, text, text, text, text\)[\s\S]*from public, anon, authenticated, service_role;/i,
        "salary advance hotfix migration revokes inherited RPC grants before granting service_role",
      );
      assert.match(
        hfSalaryAdvanceActorMigration,
        /grant execute on function[\s\S]*public\.salary_advance_create_request\(uuid, uuid, text, uuid, text, text, text, text, text\)[\s\S]*to service_role;/i,
        "salary advance hotfix migration grants RPC execution only to service_role",
      );
      const salaryAdvanceWp1Migration = await readFile(
        path.join(MIGRATION_DIR, SALARY_ADVANCE_WP1_MIGRATION_NAME),
        "utf8",
      );
      assert.match(
        salaryAdvanceWp1Migration,
        /revoke all on function[\s\S]*public\.salary_advance_get_actor_context\(uuid, uuid\)[\s\S]*from public, anon, authenticated, service_role;/i,
        "salary advance WP1 migration revokes inherited RPC grants before granting service_role",
      );
      assert.match(
        salaryAdvanceWp1Migration,
        /grant execute on function[\s\S]*public\.salary_advance_get_actor_context\(uuid, uuid\)[\s\S]*to service_role;/i,
        "salary advance WP1 migration grants RPC execution only to service_role",
      );
      const leaveAccountStatusMigration = await readFile(
        path.join(MIGRATION_DIR, LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_MIGRATION_NAME),
        "utf8",
      );
      const leaveAccountStatusMigrationNormalized = leaveAccountStatusMigration
        .replace(/\s+/g, " ")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .toLowerCase();
      assert.ok(
        leaveAccountStatusMigrationNormalized.includes(LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE),
        "leave account status migration defines the filtered admin overview RPC",
      );
      assert.ok(
        leaveAccountStatusMigrationNormalized.includes(
          `revoke all on function ${LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE} from public, anon, authenticated, service_role;`,
        ),
        "leave account status migration revokes inherited RPC grants",
      );
      assert.ok(
        leaveAccountStatusMigrationNormalized.includes(
          `grant execute on function ${LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE} to service_role;`,
        ),
        "leave account status migration grants RPC execution only to service_role",
      );
      const removedSourceService = sourceService
        .filter((row) => !expectedOidSet.has(String(row.oid))).map((row) => row.signature).sort();

      const after = await aclSnapshot(client);
      assert.ok(after.every((row) => !row.anon_exec && !row.authenticated_exec && !row.public_exec),
        "no current or later Mini BI RPC exposes EXECUTE to anon, authenticated or PUBLIC");
      const serviceOids = after.filter((row) => row.service_exec).map((row) => String(row.oid)).sort();
      assert.deepEqual(serviceOids, expectedOids, "service_role EXECUTE exactly matches the explicit allowlist");
      assert.ok(after.every((row) => row.owner_exec), "function owners retain owner EXECUTE");

      const { rows: bootstrapOwner } = await client.query(
        `select pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)', 'EXECUTE') as plan_exec,
          pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as apply_exec,
          pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor',
          'public.direct_entry_catalog_bootstrap_projection()', 'EXECUTE') as projection_exec,
          pg_catalog.pg_has_role('s0_t1c_runner',
          'direct_entry_catalog_bootstrap_executor', 'MEMBER') as membership_unchanged`,
      );
      assert.equal(bootstrapOwner[0].plan_exec, true, "catalog bootstrap executor retains its intended plan rights");
      assert.equal(bootstrapOwner[0].apply_exec, true, "catalog bootstrap executor retains its intended apply rights");
      assert.equal(bootstrapOwner[0].projection_exec, true, "catalog bootstrap executor retains owner rights to its private projection helper");
      assert.equal(bootstrapOwner[0].membership_unchanged, true, "the migration does not alter executor role membership");

      // Open-schema functions outside Mini BI's name families are untouched.
      const { rows: unrelated } = await client.query(
        `select pg_catalog.has_function_privilege('anon', 'public.s0_t1c_unrelated_probe()', 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('service_role', 'public.s0_t1c_unrelated_probe()', 'EXECUTE') as service_exec`,
      );
      assert.equal(unrelated[0].anon_exec, true);
      assert.equal(unrelated[0].service_exec, true);

      // Neither client role can invoke a SECURITY DEFINER entry point directly.
      for (const role of ["anon", "authenticated"]) {
        await client.query(`set role ${role}`);
        await assert.rejects(
          client.query("select public.direct_entry_resolve_actor_context($1::uuid)",
            ["00000000-0000-4000-8000-000000000001"]),
          (error) => error?.code === "42501",
          `${role} must be rejected by function EXECUTE ACL before the RPC body runs`,
        );
        await client.query("reset role");
      }

      // A representative allowlisted server RPC returns a constant and reads no application rows.
      await client.query("set role service_role");
      const capability = await client.query("select public.ai_report_review_capability() as value");
      await client.query("reset role");
      assert.equal(capability.rows[0].value.ok, true, "service_role can still call an allowlisted server RPC");

      // WF-01 regression on ephemeral native PostgreSQL:
      // 1. Verify catalog invariants for direct_entry_workforce_reporting_scoped (SECURITY DEFINER, owner privileges
      //    on FORCE RLS table direct_entry_employment_status_events, locked search_path, and strict EXECUTE ACL).
      const assertWf01CatalogInvariants = async (expectedOwnerName) => {
        const { rows: wf01Catalog } = await client.query(
          `select
             p.oid::pg_catalog.regprocedure::text as signature,
             p.prosecdef,
             p.proconfig,
             owner_role.rolname as proc_owner,
             owner_role.rolsuper as owner_is_super,
             owner_role.rolbypassrls as owner_bypassrls,
             table_owner_role.rolname as status_table_owner,
             facts_owner_role.rolname as facts_rpc_owner,
             pg_catalog.pg_has_role(p.proowner, c.relowner, 'USAGE') as owner_has_table_owner_privs,
             c.relrowsecurity as status_rls_enabled,
             c.relforcerowsecurity as status_rls_forced,
             (select count(*)::integer from pg_catalog.pg_policy pol where pol.polrelid = c.oid) as status_policy_count,
             pg_catalog.has_table_privilege(p.proowner, c.oid, 'SELECT') as owner_status_select,
             pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_status_select,
             pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_status_select,
             pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') as service_status_select,
             pg_catalog.has_function_privilege(p.proowner, 'public.direct_entry_reporting_resolve_audience(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE') as owner_resolve_audience_exec,
             pg_catalog.has_function_privilege(p.proowner, 'public.direct_entry_reporting_authorized_entries(uuid, uuid)'::pg_catalog.regprocedure, 'EXECUTE') as owner_authorized_entries_exec,
             pg_catalog.has_function_privilege(p.proowner, 'public.direct_entry_authorization_date()'::pg_catalog.regprocedure, 'EXECUTE') as owner_auth_date_exec,
             pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
             pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
             pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as public_role_exec,
             exists (
               select 1
                 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                where a.grantee = 0
                  and a.privilege_type = 'EXECUTE'
             ) as public_acl_exec
           from pg_catalog.pg_proc p
           join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
           join pg_catalog.pg_class c on c.oid = 'public.direct_entry_employment_status_events'::pg_catalog.regclass
           join pg_catalog.pg_roles table_owner_role on table_owner_role.oid = c.relowner
           join pg_catalog.pg_proc facts_proc on facts_proc.oid = 'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)'::pg_catalog.regprocedure
           join pg_catalog.pg_roles facts_owner_role on facts_owner_role.oid = facts_proc.proowner
           where p.oid = 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure`,
        );
        assert.equal(wf01Catalog.length, 1, "direct_entry_workforce_reporting_scoped exists in pg_proc");
        const row = wf01Catalog[0];
        assert.equal(row.signature, "direct_entry_workforce_reporting_scoped(uuid,uuid,jsonb)");
        assert.equal(row.prosecdef, true, "direct_entry_workforce_reporting_scoped must be SECURITY DEFINER");
        assert.equal(row.proc_owner, expectedOwnerName, `expected owner ${expectedOwnerName}`);
        assert.equal(row.status_table_owner, "postgres");
        assert.equal(row.facts_rpc_owner, "postgres");
        assert.equal(row.owner_has_table_owner_privs, true, "RPC owner must hold table owner privileges");
        assert.equal(row.status_rls_enabled, true, "direct_entry_employment_status_events has RLS enabled");
        assert.equal(row.status_rls_forced, true, "direct_entry_employment_status_events has FORCE RLS enabled");
        assert.equal(row.status_policy_count, 0, "direct_entry_employment_status_events is default-deny (0 permissive policies)");
        assert.equal(row.owner_status_select, true, "RPC owner has SELECT on direct_entry_employment_status_events");
        assert.equal(Boolean(row.owner_is_super || row.owner_bypassrls), true, "RPC owner bypasses FORCE RLS on direct_entry_employment_status_events");
        assert.equal(row.anon_status_select, false, "anon has no SELECT on direct_entry_employment_status_events");
        assert.equal(row.authenticated_status_select, false, "authenticated has no SELECT on direct_entry_employment_status_events");
        assert.equal(row.service_status_select, false, "service_role has no direct SELECT on direct_entry_employment_status_events");
        assert.equal(row.owner_resolve_audience_exec, true, "RPC owner can execute direct_entry_reporting_resolve_audience");
        assert.equal(row.owner_authorized_entries_exec, true, "RPC owner can execute direct_entry_reporting_authorized_entries");
        assert.equal(row.owner_auth_date_exec, true, "RPC owner can execute direct_entry_authorization_date");
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"], "search_path is locked to pg_catalog, public");
        assert.equal(row.owner_exec, true, "RPC owner retains EXECUTE");
        assert.equal(row.service_exec, true, "service_role has EXECUTE");
        assert.equal(row.anon_exec, false, "anon does not have EXECUTE");
        assert.equal(row.authenticated_exec, false, "authenticated does not have EXECUTE");
        assert.equal(row.public_role_exec, false, "PUBLIC does not have EXECUTE");
        assert.equal(row.public_acl_exec, false, "proacl has no PUBLIC (grantee=0) EXECUTE grant");
      };

      const assertWf01RuntimeReadUnderServiceRole = async () => {
        for (const role of ["anon", "authenticated"]) {
          await client.query(`set role ${role}`);
          try {
            await assert.rejects(
              client.query(
                "select public.direct_entry_workforce_reporting_scoped($1::uuid, $2::uuid, '{}'::jsonb)",
                ["00000000-0000-4000-8000-000000000901", "00000000-0000-4000-8000-000000000902"],
              ),
              (error) => error?.code === "42501",
              `${role} must be rejected by function EXECUTE ACL on direct_entry_workforce_reporting_scoped`,
            );
          } finally {
            await client.query("reset role");
          }
        }

        await client.query("set role service_role");
        try {
          await assert.rejects(
            client.query("select count(*) from public.direct_entry_employment_status_events"),
            (error) => error?.code === "42501",
            "service_role must not have direct table SELECT on direct_entry_employment_status_events",
          );
        } finally {
          await client.query("reset role");
        }

        await client.query("begin");
        try {
          const authSub = "00000000-0000-4000-8000-000000000901";
          const appUser = "00000000-0000-4000-8000-000000000902";
          const teamId = "00000000-0000-4000-8000-000000000903";
          const recId = "00000000-0000-4000-8000-000000000904";
          const candId = "00000000-0000-4000-8000-000000000905";
          const subId = "00000000-0000-4000-8000-000000000906";
          const entryId = "00000000-0000-4000-8000-000000000907";
          const reasonId = "00000000-0000-4000-8000-000000000908";
          const eventId = "00000000-0000-4000-8000-000000000909";

          await client.query("insert into auth.users (id) values ($1)", [authSub]);
          await client.query(
            "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1, $2, true, 'WF01 Probe Actor')",
            [appUser, authSub],
          );
          await client.query(
            "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2020-01-01', true)",
            [appUser],
          );
          await client.query(
            "insert into public.teams (team_id, code, display_name) values ($1, 'WF01_T', 'WF01 Team')",
            [teamId],
          );
          await client.query(
            "insert into public.recruiters (recruiter_id, display_name) values ($1, 'WF01 Recruiter')",
            [recId],
          );
          await client.query(
            "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1, 'hrp', '2020-01-01', true)",
            [recId],
          );
          await client.query(
            "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
            [recId, teamId],
          );
          await client.query(
            "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1, 'wf01 rec', '2020-01-01')",
            [recId],
          );
          await client.query(
            "insert into public.direct_entry_projects (project_id, display_name) values ('wf01_proj', 'WF01 Project')",
          );
          await client.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candId]);
          await client.query(
            "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1, $2, 'DRAFT')",
            [subId, appUser],
          );
          await client.query(
            `insert into public.direct_entries (
               entry_id, submission_id, candidate_id, created_by_user_id, project_id,
               first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
             ) values (
               $1, $2, $3, $4, 'wf01_proj', '2026-03-05', 'hrp-2026-990001',
               '{"display_name":"WF01 Worker","date_of_birth":{"state":"omitted"},"national_id":{"state":"omitted"},"address":{"state":"omitted"},"phone":{"state":"omitted"}}'::jsonb,
               $5, $6, 'hrp', 'TEMPORARY'
             )`,
            [entryId, subId, candId, appUser, recId, teamId],
          );
          await client.query("set constraints all immediate");
          await client.query(
            "alter table public.direct_entry_submissions disable trigger direct_entry_submission_transition",
          );
          await client.query(
            "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = 2 where submission_id = $1",
            [subId],
          );
          await client.query(
            "alter table public.direct_entry_submissions enable trigger direct_entry_submission_transition",
          );
          await client.query("set constraints all deferred");
          await client.query(
            "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'WF01 probe')",
            [reasonId, appUser],
          );
          await client.query(
            `insert into public.direct_entry_employment_status_events (
               event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
               version, actor_user_id, reason_id, supersedes_event_id
             ) values ($1, $2, 'ON', '2026-03-05', null, null, 1, $3, $4, null)`,
            [eventId, entryId, appUser, reasonId],
          );

          await client.query("set role service_role");
          try {
            const { rows: wf01Probe } = await client.query(
              "select public.direct_entry_workforce_reporting_scoped($1::uuid, $2::uuid, $3::jsonb) as payload",
              [authSub, appUser, JSON.stringify({ from: "2026-03-01", to: "2026-03-10", project: "wf01 project" })],
            );
            assert.equal(wf01Probe[0]?.payload?.snapshot?.eligible_episode_total, 1);
            assert.equal(wf01Probe[0]?.payload?.snapshot?.on_count, 1, "SECURITY DEFINER owner must read ON event across FORCE RLS");
            assert.equal(wf01Probe[0]?.payload?.snapshot?.unknown_count, 0);
            assert.equal(wf01Probe[0]?.payload?.transitions?.initial?.on?.event_count, 1);
            assert.equal(wf01Probe[0]?.payload?.balance?.applicable, true);
            assert.equal(wf01Probe[0]?.payload?.balance?.by_status?.on?.new_episode_inflow_count, 1);
            assert.equal(wf01Probe[0]?.payload?.balance?.by_status?.on?.closing_count, 1);
            assert.equal(wf01Probe[0]?.payload?.waiting?.direct_on_episode_count, 1);
          } finally {
            await client.query("reset role");
          }
        } finally {
          await client.query("rollback");
        }
      };

      // Verify both under non-superuser BYPASSRLS migration runner (`s0_t1c_runner`) and under the
      // `load-supabase-config.mjs` `postgres` owner alignment path:
      await assertWf01CatalogInvariants("s0_t1c_runner");
      await assertWf01RuntimeReadUnderServiceRole();

      // Verify fail-closed migration self-check when an operator role lacks BYPASSRLS and cannot align owner to `postgres`:
      await client.query("begin");
      try {
        await client.query("alter role s0_t1c_runner nobypassrls");
        await client.query("set local session authorization s0_t1c_runner");
        await assert.rejects(
          client.query(migrationSqlForTransaction(wf01Migration)),
          (error) =>
            error?.code === "55000" &&
            String(error?.message).includes("WF-01 RPC security definer owner/RLS/ACL boundary drift"),
          "WF-01 migration must fail closed if function owner cannot bypass FORCE RLS on direct_entry_employment_status_events",
        );
      } finally {
        await client.query("rollback");
      }

      await client.query("begin");
      try {
        await client.query("alter role s0_t1c_runner nobypassrls");
        await client.query("set local session authorization s0_t1c_runner");
        await assert.rejects(
          client.query(migrationSqlForTransaction(wf02Migration)),
          (error) =>
            error?.code === "55000" &&
            String(error?.message).includes("WF-02 RPC security definer owner/RLS/ACL boundary drift"),
          "WF-02 migration must fail closed if function owner cannot bypass FORCE RLS on direct_entry_employment_status_events",
        );
      } finally {
        await client.query("rollback");
      }

      // Verify owner alignment to `postgres` when the runner has SET on `postgres` (or connects as `postgres` per `load-supabase-config.mjs`):
      await client.query(migrationSqlForTransaction(wf02Migration));
      await assertWf01CatalogInvariants("postgres");
      await assertWf01RuntimeReadUnderServiceRole();

      // Real PostgreSQL concurrency proof for duplicate CCCD self-withdraw under service_role:
      // two concurrent creators self-withdrawing the two episodes of a 2-row ON duplicate pair
      // must serialize without deadlock so exactly one withdraws and the survivor stays active.
      {
        const dupTeam = "00000000-0000-4000-8000-000000009911";
        const dupRec = "00000000-0000-4000-8000-000000009921";
        const c1Auth = "00000000-0000-4000-8000-000000009931";
        const c1App = "00000000-0000-4000-8000-000000009941";
        const c2Auth = "00000000-0000-4000-8000-000000009932";
        const c2App = "00000000-0000-4000-8000-000000009942";
        const e1 = "00000000-0000-4000-8000-000000009951";
        const e2 = "00000000-0000-4000-8000-000000009952";
        await client.query(
          "insert into public.teams (team_id, code, display_name) values ($1, 'DUP_RACE_TEAM', 'Dup Race Team')",
          [dupTeam],
        );
        await client.query(
          "insert into public.direct_entry_projects (project_id, display_name) values ('dup_race_proj', 'Dup Race Project')",
        );
        await client.query(
          "insert into public.recruiters (recruiter_id, display_name) values ($1, 'Dup Race Recruiter')",
          [dupRec],
        );
        await client.query(
          "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1, 'hrp', '2020-01-01', true)",
          [dupRec],
        );
        await client.query(
          "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
          [dupRec, dupTeam],
        );
        await client.query("insert into auth.users (id) values ($1), ($2)", [c1Auth, c2Auth]);
        await client.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1, $2, true, 'Creator One'), ($3, $4, true, 'Creator Two')",
          [c1App, c1Auth, c2App, c2Auth],
        );
        for (const [idx, creatorApp, entryId] of [[1, c1App, e1], [2, c2App, e2]]) {
          const candId = `00000000-0000-4000-8000-00000000996${idx}`;
          const subId = `00000000-0000-4000-8000-00000000997${idx}`;
          const reasonId = `00000000-0000-4000-8000-00000000998${idx}`;
          await client.query("begin");
          await client.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candId]);
          await client.query(
            "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1, $2, 'DRAFT')",
            [subId, creatorApp],
          );
          await client.query(
            `insert into public.direct_entries (
               entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
               employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
             ) values ($1, $2, $3, $4, 'dup_race_proj', '2026-10-10', $5, $6::jsonb, $7, $8, 'hrp', 'TEMPORARY')`,
            [
              entryId, subId, candId, creatorApp, `hrp-2026-99990${idx}`,
              JSON.stringify({
                display_name: `Race Worker ${idx}`,
                date_of_birth: { state: "unknown" },
                national_id: { state: "provided", value: "088200009999" },
                address: { state: "unknown" },
                phone: { state: "unknown" },
              }),
              dupRec, dupTeam,
            ],
          );
          await client.query(
            "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'seed ON')",
            [reasonId, creatorApp],
          );
          await client.query(
            `insert into public.direct_entry_employment_status_events
               (entry_id, status, effective_date, version, actor_user_id, reason_id)
             values ($1, 'ON', '2026-10-10', 1, $2, $3)`,
            [entryId, creatorApp, reasonId],
          );
          await client.query("commit");
        }

        const conn1 = await connect(port, databaseName, "dup-race-1");
        const conn2 = await connect(port, databaseName, "dup-race-2");
        try {
          await conn1.query("set role service_role");
          await conn2.query("set role service_role");
          const settled = await Promise.allSettled([
            conn1.query(
              "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid, $2::uuid, $3::uuid, 1, 'race 1', 'idem-race-1')",
              [c1Auth, c1App, e1],
            ),
            conn2.query(
              "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid, $2::uuid, $3::uuid, 1, 'race 2', 'idem-race-2')",
              [c2Auth, c2App, e2],
            ),
          ]);
          const fulfilled = settled.filter((r) => r.status === "fulfilled");
          const rejected = settled.filter((r) => r.status === "rejected");
          assert.equal(fulfilled.length, 1, "exactly one concurrent self-withdraw succeeds on a 2-row duplicate pair");
          assert.equal(rejected.length, 1, "the second concurrent self-withdraw fails closed");
          assert.equal(rejected[0].reason?.code, "PT409");
          assert.match(String(rejected[0].reason?.message), /not an active duplicate/i);

          const { rows: survivors } = await client.query(
            "select count(*)::int as n from public.direct_entries where entry_id = any($1::uuid[]) and voided_at is null",
            [[e1, e2]],
          );
          assert.equal(survivors[0].n, 1, "exactly one active episode survives");
        } finally {
          await conn1.end().catch(() => {});
          await conn2.end().catch(() => {});
        }
      }

      // Trigger calls do not consult function EXECUTE ACL at row-update time.
      await client.query(
        "create table public.s0_t1c_updated_at_probe(updated_at timestamptz not null);"
          + " insert into public.s0_t1c_updated_at_probe values ('2000-01-01 UTC');"
          + " create trigger s0_t1c_updated_at_before_update before update on public.s0_t1c_updated_at_probe"
          + " for each row execute function public.set_updated_at();"
          + " grant select, update on public.s0_t1c_updated_at_probe to service_role;"
          + " create table public.s0_t1c_immutable_probe(id integer primary key);"
          + " insert into public.s0_t1c_immutable_probe values (1);"
          + " create trigger s0_t1c_immutable_before_update before update or delete on public.s0_t1c_immutable_probe"
          + " for each row execute function public.ai_report_audit_immutable();"
          + " grant select, update, delete on public.s0_t1c_immutable_probe to service_role;",
      );
      await client.query("set role service_role");
      const { rows: updatedAtRows } = await client.query(
        "update public.s0_t1c_updated_at_probe set updated_at='2001-01-01 UTC' returning updated_at",
      );
      await client.query("reset role");
      assert.notEqual(new Date(updatedAtRows.at(-1).updated_at).toISOString(), "2001-01-01T00:00:00.000Z",
        "the existing updated_at trigger still fires without a direct service_role EXECUTE grant");
      await client.query("set role service_role");
      await assert.rejects(
        client.query("update public.s0_t1c_immutable_probe set id=1 where id=1"),
        (error) => error?.code === "P0001" && error.message.includes("append-only"),
        "the immutable trigger still rejects a mutation without direct function EXECUTE",
      );
      await client.query("reset role");

      // Keep a lightweight static guard on the actor source boundary this ACL change relies on.
      const actorRepository = await readFile(path.join(ROOT, "src", "lib", "direct-entry", "actor-context-repository.ts"), "utf8");
      const actorAuth = await readFile(path.join(ROOT, "src", "lib", "auth", "direct-entry-v2.ts"), "utf8");
      const supabaseServer = await readFile(path.join(ROOT, "src", "lib", "supabase", "server.ts"), "utf8");
      assert.match(actorRepository, /createServiceSupabaseClient\(\)/);
      assert.match(actorRepository, /p_auth_subject:\s*authSubject/);
      assert.match(actorAuth, /input\.session\.auth_subject/);
      assert.match(supabaseServer, /SUPABASE_SECRET_KEY/);

      t.diagnostic(`Mini BI RPC ACL: source functions=${before.length}, SECURITY DEFINER=${sourceSecurityDefiner}, anon=${sourceAnon}, authenticated=${sourceAuthenticated}, PUBLIC=${sourcePublic}, service_role=${sourceService.length}; source service grants removed=${removedSourceService.length}, allowlist grants added=${allowlistMissingFromSource.length}; allowlisted service_role=${serviceOids.length}, client/PUBLIC EXECUTE=0`);
    } finally {
      await client?.query("reset role").catch(() => {});
      await client?.end().catch(() => {});
      await admin?.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]).catch(() => {});
      await admin?.query(`drop database if exists ${databaseName}`).catch(() => {});
      await admin?.end().catch(() => {});
      if (serverStarted) {
        const pgCtlPath = pgCtl;
        spawnSync(pgCtlPath, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          encoding: "utf8", windowsHide: true, stdio: "ignore",
        });
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
