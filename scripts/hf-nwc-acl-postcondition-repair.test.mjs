/**
 * P0 Hotfix Regression Suite (Real PostgreSQL):
 *   1. Unconditional S0-T1-C live ACL postcondition checks even when ledger checksum
 *      matches S0_T1_C_CURRENT_CHECKSUM (catches client exposure, extra service_role
 *      on internal helpers/triggers, and missing service_role on allowlisted RPCs).
 *   2. Dynamic canonical allowlist derivation strictly from applied migrations
 *      (ignores unapplied local migrations such as WP7A, zero hardcoded counts).
 *   3. Safe routine ACL alignment under non-superuser NWC-like `nwc_postgres`
 *      (`rolsuper=false, rolcreaterole=true, rolbypassrls=true`, `MEMBER=true, SET=false`)
 *      covering BOTH multi-grantor bootstrap topologies:
 *        - Topology A: 2 external grantors (`supabase_admin_sim` ADMIN=true, `ops_grantor` ADMIN=false)
 *        - Topology B: 1 external grantor (`supabase_admin_sim` ADMIN=true) + 1 existing
 *          direct self-grantor row (`grantor=nwc_postgres, admin=false, inherit=false, set=false`)
 *      proving byte-for-byte `pg_auth_members` restoration before commit AND on error/rollback.
 *   4. Missing ADMIN OPTION fail-closed diagnostic (never skips the 3 bootstrap routines).
 *   5. Non-owner ACL grantor check & strict preservation of schema_migrations, routine bodies,
 *      pg_default_acl, unrelated public routines, and the 4 bootstrap executor helper grants.
 *   6. CLI safety guards (--confirm-apply, --expected-fingerprint, --nwc-staging --config, remote URL block).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { parseCliArgs, resolveSafeConnectionTarget, runRoutineAclAlignmentCli } from "./align-routine-acl.mjs";
import {
  buildExpectedS0T1CAllowlist,
  R1_2_MIGRATION_NAME,
  runMigrationApply,
  runMigrationValidation,
  S0_T1_C_CURRENT_CHECKSUM,
  S0_T1_C_MIGRATION_NAME,
} from "./lib/migration-validation.mjs";
import {
  executeRoutineAclAlignmentInTransaction,
  inspectBootstrapRoleContext,
} from "./lib/routine-acl-alignment.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
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
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port, user = "postgres", database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user,
    database,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

test("CLI argument & target safety guards fail closed on unsafe or incomplete invocations", () => {
  assert.throws(() => parseCliArgs(["--apply", "--db-url", "postgres://postgres@127.0.0.1:5432/postgres"]), /APPLY_REQUIRES_CONFIRM/);
  assert.throws(
    () => parseCliArgs(["--apply", "--confirm-apply", "--db-url", "postgres://postgres@127.0.0.1:5432/postgres"]),
    /APPLY_REQUIRES_FINGERPRINT/,
  );
  assert.throws(() => parseCliArgs(["--preflight", "--dry-run", "--db-url", "postgres://postgres@127.0.0.1:5432/postgres"]), /CLI_MODE_CONFLICT/);
  assert.throws(() => parseCliArgs(["--nwc-staging"]), /NWC_CONFIG_REQUIRED/);
  assert.throws(() => parseCliArgs(["--preflight"]), /TARGET_REQUIRED/);
  assert.throws(
    () => resolveSafeConnectionTarget(parseCliArgs(["--preflight", "--db-url", "postgres://user:pass@db.example.supabase.co:5432/postgres"])),
    /REMOTE_TARGET_BLOCKED/,
  );
});

test("Dynamic allowlist scales strictly with applied migrations (zero hardcoded routine count)", async () => {
  const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
  const baseOnly = buildExpectedS0T1CAllowlist(s0Sql, new Map([[S0_T1_C_MIGRATION_NAME, S0_T1_C_CURRENT_CHECKSUM]]));
  const withR1_2 = buildExpectedS0T1CAllowlist(
    s0Sql,
    new Map([
      [S0_T1_C_MIGRATION_NAME, S0_T1_C_CURRENT_CHECKSUM],
      [R1_2_MIGRATION_NAME, "dummy"],
    ]),
  );
  assert.equal(baseOnly.length, 140);
  assert.equal(withR1_2.length, 141);
});

test("Real PostgreSQL NWC ACL drift detection, multi-grantor bootstrap role elevation/restoration, unapplied-migration isolation, and preservation", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries not available in PATH");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hf-nwc-acl-pg-"));
  const pgData = path.join(tmpRoot, "pgdata");
  const pgLog = path.join(tmpRoot, "pg.log");
  const extraMigDir = path.join(tmpRoot, "migrations_with_unapplied");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
    run(
      pgCtl,
      ["-D", pgData, "-l", pgLog, "-o", `-h 127.0.0.1 -p ${port} -k ""`, "start"],
      { ignoreOutput: true },
    );
    started = true;

    const superClient = await connect(port, "postgres");
    clients.push(superClient);

    // Build exact Supabase/NWC-like role topology:
    // - supabase_admin_sim (superuser)
    // - ops_grantor (superuser secondary grantor to test multi-grantor pg_auth_members)
    // - nwc_postgres (NON-SUPERUSER login with CREATEROLE + BYPASSRLS, matching NWC postgres)
    // - limited_operator (NON-SUPERUSER with MEMBER=true, ADMIN=false, SET=false)
    await superClient.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create role supabase_admin_sim superuser login;
      create role ops_grantor nosuperuser login;
      create role migration_installer superuser login;
      create role nwc_postgres login createrole bypassrls nosuperuser;
      create role limited_operator login nosuperuser;
      create schema auth;
      create table auth.users (id uuid primary key, email text unique);
      grant usage on schema auth to nwc_postgres, migration_installer;
      grant all on table auth.users to nwc_postgres, migration_installer;
      alter schema public owner to migration_installer;
    `);

    // Apply all current repo migrations cleanly via migration_installer, then transfer
    // ownership of all public objects (except the 3 bootstrap-executor-owned functions)
    // to non-superuser nwc_postgres (exact NWC runtime ownership topology).
    const migrationNames = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const installerUrl = `postgres://migration_installer@127.0.0.1:${port}/postgres`;
    const nwcUrl = `postgres://nwc_postgres@127.0.0.1:${port}/postgres`;
    const applyRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: installerUrl, projectRef: "local" }),
      createClient: (url) => new Client({ connectionString: url, ssl: false }),
      log() {},
      errorLog() {},
    });
    assert.equal(applyRes.appliedCount, migrationNames.length);
    await superClient.query(`
      reassign owned by migration_installer to nwc_postgres;
      grant all on schema public to nwc_postgres;
    `);

    // Add an unrelated public function (simulating Supabase extension helper) that must remain untouched
    await superClient.query(`
      create function public.unrelated_extension_helper() returns integer language sql as 'select 42';
      grant execute on function public.unrelated_extension_helper() to public, anon, authenticated, service_role;
    `);

    // Prepare a directory with an extra UNAPPLIED local migration (simulating WP7A #223 present locally
    // while target DB only has 222 applied migrations)
    await cp(MIGRATION_DIR, extraMigDir, { recursive: true });
    await writeFile(
      path.join(extraMigDir, "20991231235959_unapplied_future_wp7a_sim.sql"),
      "begin;\ncreate or replace function public.leave_management_unapplied_future_rpc() returns integer language sql security definer set search_path = pg_catalog, public as 'select 1';\nrevoke all on function public.leave_management_unapplied_future_rpc() from public, anon, authenticated, service_role;\ngrant execute on function public.leave_management_unapplied_future_rpc() to service_role;\ncommit;\n",
      "utf8",
    );

    // Helper: inject NWC-style ACL drift across non-bootstrap routines, internal helpers, triggers,
    // allowlisted RPCs (removing service_role from one), AND all 3 bootstrap executor routines
    async function injectNwcStyleDrift({ includeNonOwnerGrantor = false } = {}) {
      await superClient.query(`
        grant execute on function
          public.direct_entry_resolve_actor_context(uuid),
          public.direct_entry_lock_account_operation(uuid),
          public.set_updated_at(),
          public.direct_entry_catalog_bootstrap_plan(uuid, uuid),
          public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text),
          public.direct_entry_catalog_bootstrap_projection()
        to public, anon, authenticated, service_role;
        revoke all on function public.leave_management_get_my_summary(uuid, uuid, integer) from public, anon, authenticated, service_role;
      `);
      if (includeNonOwnerGrantor) {
        // Explicit grant issued by supabase_admin_sim (non-owner superuser) on a nwc_postgres-owned routine
        await superClient.query(`
          begin;
          set local role supabase_admin_sim;
          grant execute on function public.direct_entry_resolve_actor_context(uuid) to anon;
          commit;
        `);
      }
    }

    // -------------------------------------------------------------------------
    // Scenario 1 (Topology A): 2 external grantors (`supabase_admin_sim` ADMIN=true,
    // `ops_grantor` ADMIN=false), BOTH SET=false & INHERIT=false, `nwc_postgres` MEMBER=true, SET=false.
    // -------------------------------------------------------------------------
    await superClient.query(`
      do $$
      declare r record;
      begin
        for r in
          select pg_get_userbyid(m.grantor) as grantor_name
            from pg_auth_members m
           where m.roleid = 'direct_entry_catalog_bootstrap_executor'::regrole
             and m.member = 'nwc_postgres'::regrole
        loop
          execute format('revoke direct_entry_catalog_bootstrap_executor from nwc_postgres granted by %I', r.grantor_name);
        end loop;
      end $$;
      begin;
      set local role supabase_admin_sim;
      grant direct_entry_catalog_bootstrap_executor to ops_grantor with admin true, inherit false, set false;
      grant direct_entry_catalog_bootstrap_executor to nwc_postgres with admin true, inherit false, set false;
      commit;
      begin;
      set local role ops_grantor;
      grant direct_entry_catalog_bootstrap_executor to nwc_postgres with admin false, inherit false, set false;
      commit;
    `);

    await injectNwcStyleDrift({ includeNonOwnerGrantor: true });

    const nwcClient = await connect(port, "nwc_postgres");
    clients.push(nwcClient);

    // Verify exact NWC-like role state (MEMBER=true, USAGE=false, SET=false, 2 rows)
    const topoACtx = await inspectBootstrapRoleContext(nwcClient);
    assert.equal(topoACtx.actor.rolsuper, false);
    assert.equal(topoACtx.actor.rolcreaterole, true);
    assert.equal(topoACtx.actor.member, true);
    assert.equal(topoACtx.actor.usage, false);
    assert.equal(topoACtx.actor.can_set, false);
    assert.equal(
      topoACtx.memberships.filter((m) => m.member_name === "nwc_postgres").length,
      2,
    );
    assert.equal(topoACtx.elevationStrategy, "TEMP_GRANT_MEMBERSHIP_AND_REVOKE_MEMBERSHIP");

    // 1a. Verify runMigrationValidation & runMigrationApply FAIL CLOSED despite matching #124 checksum!
    const dryRunLogs = [];
    const failedDryRun = await runMigrationValidation({
      mode: "dry-run",
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: nwcUrl }),
      createClient: (url) => new Client({ connectionString: url, ssl: false }),
      log: (line) => dryRunLogs.push(line),
    });
    assert.deepEqual(failedDryRun.mismatches, [S0_T1_C_MIGRATION_NAME]);
    assert.equal(failedDryRun.postconditionFailures.length, 1);
    assert.match(dryRunLogs.join("\n"), /POSTCONDITION FAILED 20261020180000_s0_t1_c_rpc_acl_allowlist\.sql/);

    await assert.rejects(
      runMigrationApply({
        directory: MIGRATION_DIR,
        loadConfig: async () => ({ databaseUrl: nwcUrl }),
        createClient: (url) => new Client({ connectionString: url, ssl: false }),
        log() {},
        errorLog() {},
      }),
      /postcondition failed/i,
    );

    // 1b. Preflight against extraMigDir (containing unapplied future migration!) MUST use only 222 applied migrations
    const preflightReport = await runRoutineAclAlignmentCli(
      ["--preflight", "--db-url", nwcUrl, "--migrations-dir", extraMigDir],
      { log() {} },
    );
    assert.equal(preflightReport.summary.appliedMigrationCount, migrationNames.length);
    assert.equal(preflightReport.summary.unappliedLocalMigrationCount, 1);
    assert.equal(preflightReport.summary.missingCanonicalSignatureCount, 0);
    assert.equal(preflightReport.summary.unexpectedLiveSignatureCount, 0);
    assert.equal(preflightReport.summary.bootstrapMismatchCount, 3);
    assert.equal(preflightReport.summary.missingServiceRoleCount, 1);
    assert.ok(preflightReport.summary.extraServiceRoleCount >= 3);
    assert.equal(preflightReport.summary.postconditionsOk, false);
    assert.match(preflightReport.planFingerprint, /^[0-9a-f]{64}$/);

    // 1c. Rehearsal dry-run aligns everything cleanly inside tx and rolls back without persisting changes
    const dryRunReport = await runRoutineAclAlignmentCli(
      ["--dry-run", "--db-url", nwcUrl, "--migrations-dir", extraMigDir],
      { log() {} },
    );
    assert.equal(dryRunReport.rolledBack, true, "R2: dry-run must report rolledBack=true only after ROLLBACK succeeds");
    assert.equal(dryRunReport.afterSummary.mismatchCount, 0);
    assert.equal(dryRunReport.afterSummary.exposedClientOrPublicCount, 0);
    assert.equal(dryRunReport.afterSummary.postconditionsOk, true);
    assert.equal(dryRunReport.actions.bootstrapAligned, 3);
    assert.equal(dryRunReport.actions.bootstrapMembershipsRestoredExact, true);
    assert.deepEqual(dryRunReport.bootstrapAfter.memberships, dryRunReport.bootstrapBefore.memberships);
    // Confirm dry-run truly rolled back (drift still present in live DB!)
    const afterDryRunPreflight = await runRoutineAclAlignmentCli(
      ["--preflight", "--db-url", nwcUrl, "--migrations-dir", extraMigDir],
      { log() {} },
    );
    assert.equal(afterDryRunPreflight.summary.mismatchCount, preflightReport.summary.mismatchCount);
    assert.deepEqual(afterDryRunPreflight.bootstrapContext.memberships, topoACtx.memberships);

    // 1c-fault (R2): if ROLLBACK fails after rehearsal, CLI must fail closed and emit NO success report
    const r2FailOut = path.join(tmpRoot, "r2-rollback-fail-report.json");
    const r2Logs = [];
    await assert.rejects(
      runRoutineAclAlignmentCli(
        ["--dry-run", "--db-url", nwcUrl, "--migrations-dir", extraMigDir, "--out", r2FailOut],
        {
          log: (line) => r2Logs.push(line),
          createClient: (opts) => {
            const realClient = new Client(opts);
            const origQuery = realClient.query.bind(realClient);
            realClient.query = async (sql, params) => {
              if (typeof sql === "string" && sql.trim().toLowerCase() === "rollback") {
                throw new Error("SIMULATED_ROLLBACK_TRANSPORT_FAILURE");
              }
              return origQuery(sql, params);
            };
            return realClient;
          },
        },
      ),
      /DRY_RUN_ROLLBACK_FAILED/,
    );
    assert.equal(r2Logs.length, 0, "R2: must not emit success JSON log when ROLLBACK fails");
    await assert.rejects(access(r2FailOut), { code: "ENOENT" });

    // 1d. Error injected mid-apply after bootstrap elevation -> rollback restores pg_auth_members & ACLs byte-for-byte!
    await nwcClient.query("begin");
    await assert.rejects(
      executeRoutineAclAlignmentInTransaction(nwcClient, {
        migrationsDir: extraMigDir,
        expectedFingerprint: preflightReport.planFingerprint,
        injectErrorAfterBootstrapElevation: true,
      }),
      /INJECTED_TEST_FAILURE_AFTER_BOOTSTRAP_ELEVATION/,
    );
    await nwcClient.query("rollback");
    const afterErrorCtx = await inspectBootstrapRoleContext(nwcClient);
    assert.equal(afterErrorCtx.actor.can_set, false, "SET must remain false after failed transaction rollback");
    assert.deepEqual(afterErrorCtx.memberships, topoACtx.memberships, "pg_auth_members must be identical after rollback");

    // 1e. Stale fingerprint rejected before any write
    await assert.rejects(
      runRoutineAclAlignmentCli(
        [
          "--apply",
          "--confirm-apply",
          "--expected-fingerprint",
          "0".repeat(64),
          "--db-url",
          nwcUrl,
          "--migrations-dir",
          extraMigDir,
        ],
        { log() {} },
      ),
      /PLAN_FINGERPRINT_MISMATCH/,
    );

    // 1f. Controlled apply with exact preflight fingerprint succeeds & preserves all invariants!
    const applyReportA = await runRoutineAclAlignmentCli(
      [
        "--apply",
        "--confirm-apply",
        "--expected-fingerprint",
        preflightReport.planFingerprint,
        "--db-url",
        nwcUrl,
        "--migrations-dir",
        extraMigDir,
      ],
      { log() {} },
    );
    assert.equal(applyReportA.postCommitSummary.mismatchCount, 0);
    assert.equal(applyReportA.postCommitSummary.exposedClientOrPublicCount, 0);
    assert.equal(applyReportA.postCommitSummary.extraServiceRoleCount, 0);
    assert.equal(applyReportA.postCommitSummary.missingServiceRoleCount, 0);
    assert.equal(applyReportA.postCommitSummary.postconditionsOk, true);
    assert.equal(applyReportA.actions.bootstrapAligned, 3);
    assert.deepEqual(applyReportA.postCommitBootstrapMemberships, topoACtx.memberships);
    assert.deepEqual(applyReportA.postCommitPreservationHashes, applyReportA.preservationHashes);
    assert.equal(applyReportA.postCommitBootstrapActor.can_set, false);
    assert.deepEqual(applyReportA.postCommitVerification, {
      committed: true,
      readOnlyTransaction: "REPEATABLE READ READ ONLY ... ROLLBACK",
      aclPostconditionsOk: true,
      mismatchCount: 0,
      preservationHashesUnchanged: true,
      bootstrapMembershipsRestoredExact: true,
      bootstrapRoleStateUnchanged: true,
      passed: true,
    });

    // Verify SET is STILL false post-commit and runMigrationValidation now PASSES!
    const postApplyCtxA = await inspectBootstrapRoleContext(nwcClient);
    assert.equal(postApplyCtxA.actor.can_set, false);
    assert.deepEqual(postApplyCtxA.memberships, topoACtx.memberships);

    const cleanValidation = await runMigrationValidation({
      mode: "dry-run",
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: nwcUrl }),
      createClient: (url) => new Client({ connectionString: url, ssl: false }),
      log() {},
    });
    assert.deepEqual(cleanValidation.mismatches, []);
    assert.deepEqual(cleanValidation.postconditionFailures, []);

    // Verify unrelated public function was NEVER touched
    const { rows: [unrelated] } = await superClient.query(
      "select has_function_privilege('anon', 'public.unrelated_extension_helper()'::regprocedure, 'EXECUTE') as anon_ok",
    );
    assert.equal(unrelated.anon_ok, true, "Unrelated public function must stay untouched");

    // -------------------------------------------------------------------------
    // Scenario 2 (Topology B): Existing direct self-grantor row!
    //   Row 1: grantor=supabase_admin_sim (admin=true, inherit=false, set=false)
    //   Row 2: grantor=nwc_postgres      (admin=false, inherit=false, set=false)
    // Old S0 migration guard refused this topology; our tool handles it via
    // GRANT ... WITH SET TRUE + REVOKE SET OPTION FOR ... GRANTED BY current_user
    // and restores BOTH pg_auth_members rows byte-for-byte!
    // -------------------------------------------------------------------------
    await superClient.query(`
      begin;
      set local role ops_grantor;
      revoke direct_entry_catalog_bootstrap_executor from nwc_postgres;
      commit;
    `);
    await nwcClient.query(`
      grant direct_entry_catalog_bootstrap_executor to nwc_postgres with admin false, inherit false, set false;
    `);
    await injectNwcStyleDrift();

    const topoBCtx = await inspectBootstrapRoleContext(nwcClient);
    assert.equal(topoBCtx.actor.member, true);
    assert.equal(topoBCtx.actor.can_set, false);
    assert.equal(
      topoBCtx.memberships.filter((m) => m.member_name === "nwc_postgres").length,
      2,
    );
    assert.equal(topoBCtx.existingSelfGrantRow?.grantor_name, "nwc_postgres");
    assert.equal(topoBCtx.existingSelfGrantRow?.admin_option, false);
    assert.equal(topoBCtx.existingSelfGrantRow?.inherit_option, false);
    assert.equal(topoBCtx.existingSelfGrantRow?.set_option, false);
    assert.equal(topoBCtx.elevationStrategy, "TEMP_GRANT_SET_OPTION_AND_REVOKE_SET_OPTION");

    const preflightB = await runRoutineAclAlignmentCli(
      ["--preflight", "--db-url", nwcUrl, "--migrations-dir", MIGRATION_DIR],
      { log() {} },
    );
    assert.equal(preflightB.summary.bootstrapMismatchCount, 3);

    const applyReportB = await runRoutineAclAlignmentCli(
      [
        "--apply",
        "--confirm-apply",
        "--expected-fingerprint",
        preflightB.planFingerprint,
        "--db-url",
        nwcUrl,
        "--migrations-dir",
        MIGRATION_DIR,
      ],
      { log() {} },
    );
    assert.equal(applyReportB.postCommitSummary.mismatchCount, 0);
    assert.equal(applyReportB.postCommitSummary.postconditionsOk, true);
    assert.equal(applyReportB.actions.bootstrapElevationUsed, "TEMP_GRANT_SET_OPTION_AND_REVOKE_SET_OPTION");
    assert.equal(applyReportB.actions.bootstrapAligned, 3);
    assert.deepEqual(
      applyReportB.postCommitBootstrapMemberships,
      topoBCtx.memberships,
      "Topology B must restore BOTH pg_auth_members rows (including self-grantor row) byte-for-byte",
    );
    const postApplyCtxB = await inspectBootstrapRoleContext(nwcClient);
    assert.equal(postApplyCtxB.actor.can_set, false);
    assert.equal(applyReportB.postCommitVerification.passed, true);
    assert.equal(applyReportB.postCommitVerification.preservationHashesUnchanged, true);
    assert.equal(applyReportB.postCommitVerification.bootstrapMembershipsRestoredExact, true);
    assert.equal(applyReportB.postCommitVerification.bootstrapRoleStateUnchanged, true);
    assert.deepEqual(applyReportB.postCommitPreservationHashes, applyReportB.preservationHashes);

    // -------------------------------------------------------------------------
    // Scenario 2b (R3 fault injection #1): Post-COMMIT preservation drift while
    // keeping ALL target routine ACLs clean (pg_default_acl changed right after COMMIT).
    // CLI MUST fail closed with explicit "already committed / forward-fix" error
    // and MUST NOT revert aligned routine ACLs back to exposed state!
    // -------------------------------------------------------------------------
    await injectNwcStyleDrift();
    const preflightR3a = await runRoutineAclAlignmentCli(
      ["--preflight", "--db-url", nwcUrl, "--migrations-dir", MIGRATION_DIR],
      { log() {} },
    );
    const r3aOut = path.join(tmpRoot, "r3a-postcommit-fail.json");
    const r3aLogs = [];
    await assert.rejects(
      runRoutineAclAlignmentCli(
        [
          "--apply",
          "--confirm-apply",
          "--expected-fingerprint",
          preflightR3a.planFingerprint,
          "--db-url",
          nwcUrl,
          "--migrations-dir",
          MIGRATION_DIR,
          "--out",
          r3aOut,
        ],
        {
          log: (line) => r3aLogs.push(line),
          afterCommitHook: async () => {
            await superClient.query(
              "alter default privileges for role nwc_postgres in schema public grant execute on functions to anon",
            );
          },
        },
      ),
      (err) => {
        assert.match(err.message, /POST_COMMIT_VERIFY_FAILED/);
        assert.match(err.message, /TRANSACTION ALREADY COMMITTED/i);
        assert.match(err.message, /NOT ROLLED BACK/i);
        assert.match(err.message, /forward-fix/i);
        assert.match(err.message, /defaultPrivilegesHash/);
        return true;
      },
    );
    assert.equal(r3aLogs.length, 0, "R3: must not emit success report on post-COMMIT verification failure");
    await assert.rejects(access(r3aOut), { code: "ENOENT" });
    // Target routine ACLs MUST remain aligned (never re-exposed)
    const afterR3aValidation = await runMigrationValidation({
      mode: "dry-run",
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: nwcUrl }),
      createClient: (url) => new Client({ connectionString: url, ssl: false }),
      log() {},
    });
    assert.deepEqual(afterR3aValidation.mismatches, []);
    assert.deepEqual(afterR3aValidation.postconditionFailures, []);
    // Restore default privileges cleanly for subsequent scenario
    await superClient.query(
      "alter default privileges for role nwc_postgres in schema public revoke execute on functions from anon",
    );

    // -------------------------------------------------------------------------
    // Scenario 2c (R3 fault injection #2): Post-COMMIT bootstrap membership/SET
    // widening while keeping ALL target routine ACLs clean.
    // CLI MUST detect widened role state/membership and report committed + forward-fix!
    // -------------------------------------------------------------------------
    await injectNwcStyleDrift();
    const preflightR3b = await runRoutineAclAlignmentCli(
      ["--preflight", "--db-url", nwcUrl, "--migrations-dir", MIGRATION_DIR],
      { log() {} },
    );
    const r3bOut = path.join(tmpRoot, "r3b-postcommit-fail.json");
    const r3bLogs = [];
    await assert.rejects(
      runRoutineAclAlignmentCli(
        [
          "--apply",
          "--confirm-apply",
          "--expected-fingerprint",
          preflightR3b.planFingerprint,
          "--db-url",
          nwcUrl,
          "--migrations-dir",
          MIGRATION_DIR,
          "--out",
          r3bOut,
        ],
        {
          log: (line) => r3bLogs.push(line),
          afterCommitHook: async () => {
            await nwcClient.query(
              "grant direct_entry_catalog_bootstrap_executor to nwc_postgres with set true",
            );
          },
        },
      ),
      (err) => {
        assert.match(err.message, /POST_COMMIT_VERIFY_FAILED/);
        assert.match(err.message, /TRANSACTION ALREADY COMMITTED/i);
        assert.match(err.message, /NOT ROLLED BACK/i);
        assert.match(err.message, /forward-fix/i);
        assert.match(err.message, /bootstrapMembershipsHash/);
        assert.match(err.message, /BOOTSTRAP_MEMBERSHIP_RESTORE_DRIFT/);
        assert.match(err.message, /SET changed \(false -> true\)/);
        return true;
      },
    );
    assert.equal(r3bLogs.length, 0);
    await assert.rejects(access(r3bOut), { code: "ENOENT" });
    // Target routine ACLs remain aligned
    const afterR3bValidation = await runMigrationValidation({
      mode: "dry-run",
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl: nwcUrl }),
      createClient: (url) => new Client({ connectionString: url, ssl: false }),
      log() {},
    });
    assert.deepEqual(afterR3bValidation.mismatches, []);
    assert.deepEqual(afterR3bValidation.postconditionFailures, []);
    // Restore SET=false cleanly
    await nwcClient.query(
      "revoke set option for direct_entry_catalog_bootstrap_executor from nwc_postgres granted by nwc_postgres",
    );

    // -------------------------------------------------------------------------
    // Scenario 3 (Topology C): Operator with MEMBER=true, ADMIN=false, SET=false
    // MUST fail closed with clear operator precondition diagnostic (NEVER skip the 3 functions!).
    // -------------------------------------------------------------------------
    await superClient.query(`
      begin;
      set local role supabase_admin_sim;
      grant direct_entry_catalog_bootstrap_executor to limited_operator with admin false, inherit false, set false;
      commit;
      grant select on public.schema_migrations to limited_operator;
      grant execute on function public.direct_entry_catalog_bootstrap_projection() to anon, service_role;
    `);
    const limitedClient = await connect(port, "limited_operator");
    clients.push(limitedClient);

    const limitedCtx = await inspectBootstrapRoleContext(limitedClient);
    assert.equal(limitedCtx.canExecuteBootstrapAlignment, false);
    assert.equal(limitedCtx.elevationStrategy, "BLOCKED_MISSING_ADMIN_OPTION");

    await limitedClient.query("begin");
    await assert.rejects(
      executeRoutineAclAlignmentInTransaction(limitedClient, { migrationsDir: MIGRATION_DIR }),
      /BOOTSTRAP_EXECUTOR_PRECONDITION_FAILED/,
    );
    await limitedClient.query("rollback");
  } finally {
    await Promise.allSettled(clients.map((c) => c.end()));
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
