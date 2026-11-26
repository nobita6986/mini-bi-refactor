import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeBeforeApplyMigrationGuards,
  createWp1072bArchiveGuard,
  createWp1072bMissingArchiveGuard,
  createWp1073dArchiveGuard,
  createWp1073dMissingArchiveGuard,
  extractS0T1CAllowlistSignatures,
  isWp1073dMigrationName,
  loadAndVerifyWp1073dArchiveManifest,
  migrationChecksum,
  migrationSqlForTransaction,
  parseLeaveProfileUnitKindArchiveCsv,
  R1_2_MIGRATION_NAME,
  R1_2_SERVICE_RPC_SIGNATURE,
  runMigrationApply,
  runMigrationValidation,
  S0_T1_C_CURRENT_CHECKSUM,
  S0_T1_C_MIGRATION_NAME,
  S0_T1_C_PRE_PR92_CHECKSUM,
  WP10_7_2B_MIGRATION_NAME,
  WP10_7_3D_MIGRATION_SUFFIX,
} from "./lib/migration-validation.mjs";
import {
  computeWp1073dBundleFingerprint,
  formatWp1073dTableArchiveCsv,
  parseWp1073dTableArchiveCsv,
  WP10_7_3D_ARCHIVE_FORMAT_VERSION,
  WP10_7_3D_BUNDLE_TABLE_KEY,
  WP10_7_3D_LOCK_ORDER_SQL,
} from "./lib/wp10-7-3d-legacy-grants-archive.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

test("explicit local PostgreSQL mode disables TLS", () => {
  const previousMode = process.env.SUPABASE_DB_SSL_MODE;
  const previousWarn = console.warn;
  process.env.SUPABASE_DB_SSL_MODE = "disable";
  console.warn = () => {};
  try {
    assert.equal(buildSslOptions(), false);
  } finally {
    console.warn = previousWarn;
    if (previousMode === undefined) delete process.env.SUPABASE_DB_SSL_MODE;
    else process.env.SUPABASE_DB_SSL_MODE = previousMode;
  }
});

test("migration checksum is stable across LF and CRLF checkouts", () => {
  const lf = "create table example (id integer);\nselect 1;\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(migrationChecksum(crlf), migrationChecksum(lf));
});

test("transaction wrapper removal accepts only an exact outer BEGIN/COMMIT", () => {
  const wrapped = "-- header\nbegin;\nselect $body$begin; commit;$body$;\ncommit; -- trailer\n";
  assert.equal(migrationSqlForTransaction(wrapped), "\nselect $body$begin; commit;$body$;\n");
  const commented = "begin;\nselect 1; -- BEGIN; COMMIT; stays in line comment\n/* BEGIN; COMMIT; stays in block comment */\ncommit;\n";
  assert.equal(migrationSqlForTransaction(commented),
    "\nselect 1; -- BEGIN; COMMIT; stays in line comment\n/* BEGIN; COMMIT; stays in block comment */\n");
  assert.equal(migrationSqlForTransaction("select 'begin; commit;';\n"), "select 'begin; commit;';\n");
  assert.throws(() => migrationSqlForTransaction("begin; select 1;"), /exactly BEGIN; \.\.\. COMMIT;/);
  assert.throws(() => migrationSqlForTransaction("select 1; commit;"), /transaction wrapper/);
  assert.throws(() => migrationSqlForTransaction("start transaction; select 1; commit;"), /transaction wrapper/);
  assert.throws(() => migrationSqlForTransaction("begin; select 1; commit; select 2; commit;"), /transaction wrapper/);
});

async function withMigrations(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-validation-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "001_applied.sql"), "select 1;\n");
    await writeFile(path.join(directory, "002_pending.sql"), "select 2;\n");
    await writeFile(path.join(directory, "003_changed.sql"), "select 3;\n");
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dry-run uses SELECT only and reports applied, pending, and checksum mismatch", async () => {
  await withMigrations(async (directory) => {
    const statements = [];
    const output = [];
    let closed = false;
    const client = {
      async connect() {},
      async query(sql) {
        statements.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
        if (sql === "select version, checksum from public.schema_migrations") {
          return {
            rows: [
              { version: "001_applied.sql", checksum: migrationChecksum("select 1;\n") },
              { version: "003_changed.sql", checksum: "old-checksum" },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      async end() {
        closed = true;
      },
    };
    const result = await runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
      createClient: () => client,
      log: (line) => output.push(line),
    });

    assert.deepEqual(result.mismatches, ["003_changed.sql"]);
    assert.match(output.join("\n"), /APPLIED 001_applied\.sql/);
    assert.match(output.join("\n"), /PENDING 002_pending\.sql/);
    assert.match(output.join("\n"), /CHECKSUM MISMATCH 003_changed\.sql/);
    assert.equal(closed, true);
    assert.ok(statements.length > 0);
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)), statements.join("\n"));
  });
});

test("dry-run reports all migrations pending when schema_migrations is absent", async () => {
  await withMigrations(async (directory) => {
    const output = [];
    const result = await runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
      createClient: () => ({
        async connect() {},
        async query(sql) {
          assert.match(sql, /^\s*select\b/i);
          return { rows: [{ exists: false }] };
        },
        async end() {},
      }),
      log: (line) => output.push(line),
    });
    assert.deepEqual(result.mismatches, []);
    assert.equal(output.filter((line) => line.startsWith("PENDING ")).length, 3);
    assert.match(output.join("\n"), /no table was created/);
  });
});

test("offline validation reads all files without loading config or creating a DB client", async () => {
  await withMigrations(async (directory) => {
    const output = [];
    let clientsCreated = 0;
    const result = await runMigrationValidation({
      mode: "offline",
      directory,
      loadConfig: async () => {
        throw new Error("offline must not load database configuration");
      },
      createClient: () => {
        clientsCreated += 1;
        throw new Error("offline must not create a database client");
      },
      log: (line) => output.push(line),
    });
    assert.equal(result.migrations.length, 3);
    assert.equal(clientsCreated, 0);
    assert.match(output.join("\n"), /OFFLINE VALIDATION/);
    assert.match(output.join("\n"), /applied\/pending status was not checked/);
    assert.equal(output.some((line) => /^(APPLIED|PENDING|CHECKSUM MISMATCH)\b/.test(line)), false);
  });
});

test("dry-run surfaces database connection failures", async () => {
  await withMigrations(async (directory) => {
    await assert.rejects(runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://unreachable" }),
      createClient: () => ({
        async connect() {
          throw new Error("database unavailable");
        },
      }),
      log() {},
    }), /database unavailable/);
  });
});

test("migration #124 pre-PR #92 and post-PR #92 checksums are locked to exact verified SHA-256 digests", async () => {
  const currentSql = await readFile(
    path.resolve("supabase/migrations", S0_T1_C_MIGRATION_NAME),
    "utf8",
  );
  assert.equal(
    migrationChecksum(currentSql),
    S0_T1_C_CURRENT_CHECKSUM,
    "current #124 source checksum must match S0_T1_C_CURRENT_CHECKSUM",
  );

  const pr92AddedLine =
    "       and p.proowner <> 'direct_entry_catalog_bootstrap_executor'::regrole\n";
  assert.ok(
    currentSql.replace(/\r\n?/g, "\n").includes(pr92AddedLine),
    "#124 source contains the single PR #92 executor filter line",
  );
  const prePr92Sql = currentSql
    .replace(/\r\n?/g, "\n")
    .replace(pr92AddedLine, "");
  assert.equal(
    migrationChecksum(prePr92Sql),
    S0_T1_C_PRE_PR92_CHECKSUM,
    "reconstructed pre-PR #92 #124 checksum must match S0_T1_C_PRE_PR92_CHECKSUM",
  );
  assert.equal(extractS0T1CAllowlistSignatures(currentSql).length, 140);
});

test("migration #124 compatibility: accepts verified pre-PR #92 checksum only when postconditions pass, never modifies ledger, and fails closed on unknown checksums or other migrations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-124-compat-"));
  try {
    const s0Sql = await readFile(
      path.resolve("supabase/migrations", S0_T1_C_MIGRATION_NAME),
      "utf8",
    );
    const r21Name = "20261021120000_r2_1_change_request_queues_and_project_team_guard.sql";
    await writeFile(path.join(directory, "001_init.sql"), "select 1;\n");
    await writeFile(path.join(directory, S0_T1_C_MIGRATION_NAME), s0Sql);
    await writeFile(path.join(directory, R1_2_MIGRATION_NAME), "select 2;\n");
    await writeFile(path.join(directory, r21Name), "select 3;\n");

    const allowlist = [
      ...extractS0T1CAllowlistSignatures(s0Sql),
      R1_2_SERVICE_RPC_SIGNATURE,
    ].sort();

    const makePostconditionRow = (overrides = {}) => ({
      exposed_client_or_public_count: 0,
      actual_service_signatures: allowlist,
      expected_service_signatures: allowlist,
      missing_allowlist_count: 0,
      missing_owner_exec_count: 0,
      unsafe_secdef_search_path_count: 0,
      bootstrap_executor_intact: true,
      ...overrides,
    });

    // 1. Pre-PR #92 checksum + passing postconditions -> dry-run PASS (SELECT-only) & apply skips #124 without touching its ledger row and applies #129:
    {
      const statements = [];
      const dryRunLogs = [];
      const dryRunResult = await runMigrationValidation({
        mode: "dry-run",
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
        createClient: () => ({
          async connect() {},
          async query(sql) {
            statements.push(sql);
            if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: "001_init.sql", checksum: migrationChecksum("select 1;\n") },
                  { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_PRE_PR92_CHECKSUM },
                  { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                ],
              };
            }
            if (sql.includes("exposed_client_or_public_count")) {
              return { rows: [makePostconditionRow()] };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
          async end() {},
        }),
        log: (line) => dryRunLogs.push(line),
      });
      assert.deepEqual(dryRunResult.mismatches, []);
      assert.match(
        dryRunLogs.join("\n"),
        /APPLIED 20261020180000_s0_t1_c_rpc_acl_allowlist\.sql \(verified pre-PR #92 historical checksum compatibility\)/,
      );
      assert.match(dryRunLogs.join("\n"), new RegExp(`PENDING ${r21Name}`));
      assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)));

      const insertedLedger = [];
      const executedMigrations = [];
      const applyLogs = [];
      const applyResult = await runMigrationApply({
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "oyykqfxkyqhxgrfntokl" }),
        createClient: () => ({
          async connect() {},
          async query(sql, params) {
            if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: "001_init.sql", checksum: migrationChecksum("select 1;\n") },
                  { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_PRE_PR92_CHECKSUM },
                  { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                ],
              };
            }
            if (sql.includes("exposed_client_or_public_count")) {
              return { rows: [makePostconditionRow()] };
            }
            if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
            if (sql.includes("insert into public.schema_migrations")) {
              insertedLedger.push(params);
              return { rows: [] };
            }
            if (sql.includes("information_schema.tables")) return { rows: [] };
            if (/\bupdate\b|\bdelete\b/i.test(sql)) {
              throw new Error(`Forbidden ledger mutation: ${sql}`);
            }
            executedMigrations.push(sql);
            return { rows: [] };
          },
          async end() {},
        }),
        log: (line) => applyLogs.push(line),
      });
      assert.equal(applyResult.appliedCount, 1);
      assert.equal(applyResult.skippedCount, 3);
      assert.deepEqual(executedMigrations, ["select 3;\n"]);
      assert.deepEqual(insertedLedger, [[r21Name, migrationChecksum("select 3;\n")]]);
      assert.match(applyLogs.join("\n"), /SKIP\s+20261020180000_s0_t1_c_rpc_acl_allowlist\.sql/);
    }

    // 2. Pre-PR #92 checksum + failing security postconditions -> FAIL CLOSED in both dry-run and apply:
    for (const [label, brokenOverride] of [
      ["client exposure", { exposed_client_or_public_count: 1 }],
      ["service_role allowlist drift", { actual_service_signatures: ["public.unexpected_rpc()"] }],
      ["missing owner execute", { missing_owner_exec_count: 1 }],
      ["unsafe SECURITY DEFINER search_path", { unsafe_secdef_search_path_count: 1 }],
      ["bootstrap executor tampered", { bootstrap_executor_intact: false }],
    ]) {
      const dryRun = await runMigrationValidation({
        mode: "dry-run",
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
        createClient: () => ({
          async connect() {},
          async query(sql) {
            if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_PRE_PR92_CHECKSUM },
                  { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                ],
              };
            }
            if (sql.includes("exposed_client_or_public_count")) {
              return { rows: [makePostconditionRow(brokenOverride)] };
            }
            return { rows: [] };
          },
          async end() {},
        }),
        log() {},
      });
      assert.deepEqual(
        dryRun.mismatches,
        [S0_T1_C_MIGRATION_NAME],
        `dry-run must reject #124 historical checksum when ${label}`,
      );

      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
          createClient: () => ({
            async connect() {},
            async query(sql) {
              if (sql === "select version, checksum from public.schema_migrations") {
                return {
                  rows: [
                    { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_PRE_PR92_CHECKSUM },
                    { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                  ],
                };
              }
              if (sql.includes("exposed_client_or_public_count")) {
                return { rows: [makePostconditionRow(brokenOverride)] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          log() {},
          errorLog() {},
        }),
        /checksum mismatch/,
        `apply must reject #124 historical checksum when ${label}`,
      );
    }

    // 3. Unknown checksum on #124 or modified checksum on another migration -> FAIL CLOSED without running postcondition query:
    for (const [badVersion, badChecksum] of [
      [S0_T1_C_MIGRATION_NAME, "0000000000000000000000000000000000000000000000000000000000000000"],
      ["001_init.sql", S0_T1_C_PRE_PR92_CHECKSUM],
    ]) {
      const dryRun = await runMigrationValidation({
        mode: "dry-run",
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
        createClient: () => ({
          async connect() {},
          async query(sql) {
            if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [{ version: badVersion, checksum: badChecksum }],
              };
            }
            throw new Error(`Postcondition query must not run for ${badVersion}: ${sql}`);
          },
          async end() {},
        }),
        log() {},
      });
      assert.deepEqual(dryRun.mismatches, [badVersion]);
    }

    // 4. Current #124 checksum MATCH + failing live ACL postconditions MUST STILL FAIL CLOSED
    //    (checksum match !== live ACL parity; both dry-run and apply must distinguish postcondition failure from checksum mismatch):
    for (const [label, brokenOverride] of [
      ["client exposure", { exposed_client_or_public_count: 558 }],
      ["extra service_role on helper", { actual_service_signatures: [...allowlist, "public.direct_entry_lock_account_operation(uuid)"].sort() }],
      ["missing allowlisted RPC service_role", { actual_service_signatures: allowlist.slice(1) }],
      ["missing owner execute", { missing_owner_exec_count: 1 }],
      ["unsafe SECURITY DEFINER search_path", { unsafe_secdef_search_path_count: 1 }],
      ["bootstrap executor tampered", { bootstrap_executor_intact: false }],
    ]) {
      const dryRunLogs = [];
      const dryRun = await runMigrationValidation({
        mode: "dry-run",
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
        createClient: () => ({
          async connect() {},
          async query(sql) {
            if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_CURRENT_CHECKSUM },
                  { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                ],
              };
            }
            if (sql.includes("exposed_client_or_public_count")) {
              return { rows: [makePostconditionRow(brokenOverride)] };
            }
            return { rows: [] };
          },
          async end() {},
        }),
        log: (line) => dryRunLogs.push(line),
      });
      assert.deepEqual(
        dryRun.mismatches,
        [S0_T1_C_MIGRATION_NAME],
        `dry-run must fail closed when #124 current checksum matches but live ACL drifts (${label})`,
      );
      assert.match(
        dryRunLogs.join("\n"),
        /POSTCONDITION FAILED 20261020180000_s0_t1_c_rpc_acl_allowlist\.sql/,
        `dry-run log must separate checksum match from postcondition failure (${label})`,
      );

      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
          createClient: () => ({
            async connect() {},
            async query(sql) {
              if (sql === "select version, checksum from public.schema_migrations") {
                return {
                  rows: [
                    { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_CURRENT_CHECKSUM },
                    { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                  ],
                };
              }
              if (sql.includes("exposed_client_or_public_count")) {
                return { rows: [makePostconditionRow(brokenOverride)] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          log() {},
          errorLog() {},
        }),
        /postcondition failed/i,
        `apply must fail closed when #124 current checksum matches but live ACL drifts (${label})`,
      );
    }

    // 5. Current #124 checksum MATCH + passing live ACL postconditions -> dry-run PASS (SELECT-only) & apply skips cleanly:
    {
      const statements = [];
      const dryRunLogs = [];
      const dryRun = await runMigrationValidation({
        mode: "dry-run",
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
        createClient: () => ({
          async connect() {},
          async query(sql) {
            statements.push(sql);
            if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: S0_T1_C_MIGRATION_NAME, checksum: S0_T1_C_CURRENT_CHECKSUM },
                  { version: R1_2_MIGRATION_NAME, checksum: migrationChecksum("select 2;\n") },
                ],
              };
            }
            if (sql.includes("exposed_client_or_public_count")) {
              return { rows: [makePostconditionRow()] };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
          async end() {},
        }),
        log: (line) => dryRunLogs.push(line),
      });
      assert.deepEqual(dryRun.mismatches, []);
      assert.ok(statements.some((s) => s.includes("exposed_client_or_public_count")), "dry-run must run live postcondition check even on exact checksum match");
      assert.ok(statements.every((s) => /^\s*select\b/i.test(s)), "dry-run must stay strictly SELECT-only");
      assert.match(dryRunLogs.join("\n"), /APPLIED 20261020180000_s0_t1_c_rpc_acl_allowlist\.sql \(checksum matches; security postconditions verified\)/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parseLeaveProfileUnitKindArchiveCsv validates header, UUIDs, unit_kind enum, duplicates, and computes canonical SHA-256", () => {
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "00000000-0000-4000-8000-000000000002";
  const expectedCanonical = createHash("sha256")
    .update(`${idA}|IT\n${idB}|MARKETING`, "utf8")
    .digest("hex");

  // Unsorted CRLF input with uppercase UUID normalizes to ascending order & lowercase UUID
  const parsed = parseLeaveProfileUnitKindArchiveCsv(
    `app_user_id,unit_kind\r\n${idB.toUpperCase()},MARKETING\r\n${idA},IT\r\n`,
  );
  assert.deepEqual(parsed, {
    rowCount: 2,
    canonicalSha256: expectedCanonical,
  });

  // Empty 0-row CSV hashes empty string ""
  const emptyParsed = parseLeaveProfileUnitKindArchiveCsv("app_user_id,unit_kind\n");
  assert.deepEqual(emptyParsed, {
    rowCount: 0,
    canonicalSha256: createHash("sha256").update("", "utf8").digest("hex"),
  });

  assert.throws(
    () => parseLeaveProfileUnitKindArchiveCsv("wrong,header\n"),
    /exact header: app_user_id,unit_kind/,
  );
  assert.throws(
    () => parseLeaveProfileUnitKindArchiveCsv(`app_user_id,unit_kind\nnot-a-uuid,IT\n`),
    /invalid app_user_id UUID/,
  );
  assert.throws(
    () => parseLeaveProfileUnitKindArchiveCsv(`app_user_id,unit_kind\n${idA},INVALID_KIND\n`),
    /invalid unit_kind/,
  );
  assert.throws(
    () => parseLeaveProfileUnitKindArchiveCsv(`app_user_id,unit_kind\n${idA},IT\n${idA.toUpperCase()},MARKETING\n`),
    /duplicate app_user_id/,
  );
  assert.throws(
    () => parseLeaveProfileUnitKindArchiveCsv(`app_user_id,unit_kind\n${idA},IT,extra\n`),
    /invalid column count/,
  );
});

test("runMigrationApply with createWp1072bArchiveGuard locks table before parity, rolls back cleanly on mismatch, and commits on match", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-251-guard-"));
  try {
    const preMigration = "20261126190000_wp10_7_2a_stop_leave_profile_unit_kind_mirror.sql";
    const preSql = "select 250;\n";
    const m251Sql = "begin;\nselect 251;\ncommit;\n";
    await writeFile(path.join(directory, preMigration), preSql);
    await writeFile(path.join(directory, WP10_7_2B_MIGRATION_NAME), m251Sql);

    const expectedSha = createHash("sha256")
      .update("00000000-0000-4000-8000-000000000001|IT", "utf8")
      .digest("hex");
    const guard = createWp1072bArchiveGuard({
      expectedRowCount: 1,
      expectedCanonicalSha256: expectedSha,
    });

    // 1. Mismatch (count or sha256) -> LOCK TABLE runs first, then parity fails, ROLLBACK runs, #251 SQL and schema_migrations INSERT never run
    {
      const ops = [];
      let rolledBack = false;
      let committed = false;
      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              if (sql === "commit") {
                committed = true;
                return { rows: [] };
              }
              if (sql.includes("from public.leave_employee_profiles p")) {
                return {
                  rows: [{ row_count: "2", canonical_sha256: "f".repeat(64) }],
                };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          beforeApplyMigration: guard,
          log() {},
          errorLog() {},
        }),
        /WP10-7-2B archive parity check failed in transaction/,
      );

      assert.equal(rolledBack, true);
      assert.equal(committed, false);
      const lockIdx = ops.findIndex((o) =>
        o.sql.includes("LOCK TABLE public.leave_employee_profiles IN ACCESS EXCLUSIVE MODE"),
      );
      const parityIdx = ops.findIndex((o) =>
        o.sql.includes("from public.leave_employee_profiles p"),
      );
      assert.ok(lockIdx >= 0 && parityIdx > lockIdx, "LOCK TABLE must execute before parity query");
      assert.equal(
        ops.some((o) => o.sql.includes("select 251;")),
        false,
        "#251 DDL must not execute when parity fails",
      );
      assert.equal(
        ops.some((o) => o.sql.includes("insert into public.schema_migrations")),
        false,
        "schema_migrations insert must not execute when parity fails",
      );
    }

    // 2. Match -> non-#251 skips guard, #251 runs LOCK TABLE -> parity -> #251 SQL -> schema_migrations INSERT -> COMMIT
    {
      const ops = [];
      const result = await runMigrationApply({
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
        createClient: () => ({
          async connect() {},
          async query(sql, params) {
            ops.push({ sql, params });
            if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return { rows: [] };
            }
            if (sql.includes("from public.leave_employee_profiles p")) {
              return {
                rows: [{ row_count: "1", canonical_sha256: expectedSha }],
              };
            }
            return { rows: [] };
          },
          async end() {},
        }),
        beforeApplyMigration: guard,
        log() {},
        errorLog() {},
      });

      assert.equal(result.appliedCount, 2);
      assert.equal(result.skippedCount, 0);
      assert.equal(
        ops.filter((o) => o.sql.includes("LOCK TABLE public.leave_employee_profiles IN ACCESS EXCLUSIVE MODE")).length,
        1,
        "guard locks table only for #251, not #250",
      );
      const lockIdx = ops.findIndex((o) =>
        o.sql.includes("LOCK TABLE public.leave_employee_profiles IN ACCESS EXCLUSIVE MODE"),
      );
      const parityIdx = ops.findIndex((o) =>
        o.sql.includes("from public.leave_employee_profiles p"),
      );
      const ddlIdx = ops.findIndex((o) => o.sql.includes("select 251;"));
      const ledgerIdx = ops.findIndex(
        (o) =>
          o.sql.includes("insert into public.schema_migrations") &&
          o.params?.[0] === WP10_7_2B_MIGRATION_NAME,
      );
      const commitIdx = ops.findIndex((o, idx) => idx > ledgerIdx && o.sql === "commit");
      assert.ok(
        lockIdx >= 0 &&
          parityIdx > lockIdx &&
          ddlIdx > parityIdx &&
          ledgerIdx > ddlIdx &&
          commitIdx > ledgerIdx,
        "LOCK -> parity -> #251 DDL -> schema_migrations -> COMMIT order must hold",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scripts/apply-migrations.mjs CLI rejects invalid archive verification flags and CSV mismatches fail-closed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "apply-mig-cli-"));
  try {
    const csvPath = path.join(tempDir, "archive.csv");
    const idA = "00000000-0000-4000-8000-000000000001";
    const validSha = createHash("sha256").update(`${idA}|IT`, "utf8").digest("hex");
    await writeFile(csvPath, `app_user_id,unit_kind\n${idA},IT\n`, "utf8");

    const runCli = (args) =>
      spawnSync(process.execPath, ["scripts/apply-migrations.mjs", ...args], {
        encoding: "utf8",
        windowsHide: true,
      });

    for (const [label, args, pattern] of [
      ["unknown arg", ["--bogus"], /Tham số không hợp lệ/],
      ["incomplete pair", ["--verify-wp10-7-2b-archive", csvPath], /phải truyền đủ bộ 3 tham số/],
      ["combined with offline", ["--offline", "--verify-wp10-7-2b-archive", csvPath, "--wp10-7-2b-expected-count", "1", "--wp10-7-2b-expected-sha256", validSha], /--offline hoặc --dry-run/],
      ["bad expected count", ["--verify-wp10-7-2b-archive", csvPath, "--wp10-7-2b-expected-count", "-1", "--wp10-7-2b-expected-sha256", validSha], /expected-count không hợp lệ/],
      ["bad expected sha", ["--verify-wp10-7-2b-archive", csvPath, "--wp10-7-2b-expected-count", "1", "--wp10-7-2b-expected-sha256", "abc"], /expected-sha256 không hợp lệ/],
      ["csv mismatch", [`--verify-wp10-7-2b-archive=${csvPath}`, "--wp10-7-2b-expected-count=2", `--wp10-7-2b-expected-sha256=${validSha}`], /archive CSV không khớp tham số kỳ vọng/],
    ]) {
      const res = runCli(args);
      assert.notEqual(res.status, 0, `${label} must fail`);
      assert.match(res.stderr, pattern, `${label} error message`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scripts/apply-migrations.mjs CLI accepts pnpm '--' separator with --offline", () => {
  const res = spawnSync(
    process.execPath,
    ["scripts/apply-migrations.mjs", "--", "--offline"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /OFFLINE VALIDATION/);
});

test("createWp1072bMissingArchiveGuard and direct runMigrationApply fail closed when #251 is pending without archive verification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-251-default-gate-"));
  try {
    const preMigration = "20261126190000_wp10_7_2a_stop_leave_profile_unit_kind_mirror.sql";
    const preSql = "select 250;\n";
    const m251Sql = "begin;\nselect 251;\ncommit;\n";
    await writeFile(path.join(directory, preMigration), preSql);
    await writeFile(path.join(directory, WP10_7_2B_MIGRATION_NAME), m251Sql);

    // 1. Default CLI guard (`createWp1072bMissingArchiveGuard`): blocks pending #251 before DDL even on 0-row DB, allows #250, skips when #251 already recorded
    {
      const ops = [];
      let rolledBack = false;
      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          beforeApplyMigration: createWp1072bMissingArchiveGuard(),
          log() {},
          errorLog() {},
        }),
        /requires verified archive parity before dropping public\.leave_employee_profiles\.unit_kind/,
      );
      assert.equal(rolledBack, true);
      assert.equal(ops.some((o) => o.sql.includes("select 251;")), false);
      assert.equal(ops.some((o) => o.sql.includes("insert into public.schema_migrations")), false);
    }

    // 2. When #251 is already in schema_migrations with matching checksum, default missing-archive guard is NOT invoked and #251 is skipped cleanly
    {
      const ops = [];
      const res = await runMigrationApply({
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
        createClient: () => ({
          async connect() {},
          async query(sql, params) {
            ops.push({ sql, params });
            if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: preMigration, checksum: migrationChecksum(preSql) },
                  { version: WP10_7_2B_MIGRATION_NAME, checksum: migrationChecksum(m251Sql) },
                ],
              };
            }
            return { rows: [] };
          },
          async end() {},
        }),
        beforeApplyMigration: createWp1072bMissingArchiveGuard(),
        log() {},
        errorLog() {},
      });
      assert.equal(res.appliedCount, 0);
      assert.equal(res.skippedCount, 2);
      assert.equal(ops.some((o) => o.sql === "begin"), false);
    }

    // 3. Direct library call without beforeApplyMigration: blocks populated leave_employee_profiles before DDL, allows 0-row fresh bootstrap DB
    for (const [liveCount, shouldReject] of [[5, true], [0, false]]) {
      const ops = [];
      let rolledBack = false;
      const exec = () =>
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              if (sql.includes("from public.leave_employee_profiles")) {
                return { rows: [{ row_count: String(liveCount) }] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          log() {},
          errorLog() {},
        });
      if (shouldReject) {
        await assert.rejects(exec, /requires verified archive parity when public\.leave_employee_profiles has existing rows/);
        assert.equal(rolledBack, true);
        assert.equal(ops.some((o) => o.sql.includes("select 251;")), false);
        assert.equal(ops.some((o) => o.sql.includes("insert into public.schema_migrations")), false);
      } else {
        const res = await exec();
        assert.equal(res.appliedCount, 1);
        assert.ok(ops.some((o) => o.sql.includes("select 251;")));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// =============================================================================
// WP10-7 Slice 3D — 3-Table Legacy Grants Archive, Guard & Runner CLI Tests
// =============================================================================

async function writeSyntheticWp1073dArchiveBundle(targetDir) {
  const grantCapA = "10000000-0000-4000-8000-000000000001";
  const grantCapB = "10000000-0000-4000-8000-000000000002";
  const grantScopeA = "20000000-0000-4000-8000-000000000001";
  const grantScopeB = "20000000-0000-4000-8000-000000000002";
  const userA = "30000000-0000-4000-8000-000000000001";
  const teamA = "40000000-0000-4000-8000-000000000001";
  const leaderAsgnA = "50000000-0000-4000-8000-000000000001";

  const capRows = [
    {
      grant_id: grantCapA,
      app_user_id: userA,
      capability: "report_view",
      valid_from: "2026-01-01",
      valid_to: null,
      created_at_utc: "2026-01-01T00:00:00.000000Z",
      is_current: true,
      suspended_by_account_disable: false,
    },
    {
      grant_id: grantCapB,
      app_user_id: userA,
      capability: "payment_view",
      valid_from: "2026-01-01",
      valid_to: "2026-02-01",
      created_at_utc: "2026-01-02T12:34:56.654321Z",
      is_current: false,
      suspended_by_account_disable: true,
    },
  ];
  const scopeRows = [
    {
      grant_id: grantScopeA,
      app_user_id: userA,
      scope_kind: "all",
      team_id: null,
      valid_from: "2026-01-01",
      valid_to: null,
      created_at_utc: "2026-01-01T00:00:00.000000Z",
      is_current: true,
      suspended_by_account_disable: false,
    },
    {
      grant_id: grantScopeB,
      app_user_id: userA,
      scope_kind: "team",
      team_id: teamA,
      valid_from: "2026-01-05",
      valid_to: "2026-01-10",
      created_at_utc: "2026-01-05T08:00:00.000000Z",
      is_current: false,
      suspended_by_account_disable: false,
    },
  ];
  const bridgeRows = [
    {
      leader_assignment_id: leaderAsgnA,
      capability: "report_view",
      capability_grant_id: grantCapA,
    },
  ];

  const tables = {};
  for (const [tableName, rows] of [
    ["direct_entry_capability_grants", capRows],
    ["direct_entry_scope_grants", scopeRows],
    ["work_report_team_leader_capability_grants", bridgeRows],
  ]) {
    const csvText = formatWp1073dTableArchiveCsv(tableName, rows);
    const parsed = parseWp1073dTableArchiveCsv(tableName, csvText);
    const jsonText = `${JSON.stringify({ table_name: tableName, row_count: parsed.rowCount, canonical_sha256: parsed.canonicalSha256, rows: parsed.rows }, null, 2)}\n`;
    const csvFile = `${tableName}.archive.csv`;
    const jsonFile = `${tableName}.archive.json`;
    await writeFile(path.join(targetDir, csvFile), csvText, "utf8");
    await writeFile(path.join(targetDir, jsonFile), jsonText, "utf8");
    tables[tableName] = {
      row_count: parsed.rowCount,
      canonical_sha256: parsed.canonicalSha256,
      csv_file: csvFile,
      json_file: jsonFile,
      csv_sha256: createHash("sha256").update(csvText, "utf8").digest("hex"),
      json_sha256: createHash("sha256").update(jsonText, "utf8").digest("hex"),
    };
  }

  const bundle = computeWp1073dBundleFingerprint(tables);
  const manifest = {
    format_version: WP10_7_3D_ARCHIVE_FORMAT_VERSION,
    exported_at: "2026-11-27T00:00:00.000Z",
    tables,
    bundle,
  };
  const manifestPath = path.join(targetDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath, manifest, tables, bundle };
}

test("WP10-7-3D filename matcher is timestamp-agnostic and strict", () => {
  assert.equal(isWp1073dMigrationName(`20261127050000${WP10_7_3D_MIGRATION_SUFFIX}`), true);
  assert.equal(isWp1073dMigrationName(`20261201235959${WP10_7_3D_MIGRATION_SUFFIX}`), true);
  assert.equal(isWp1073dMigrationName(`20261127_wp10_7_3d_drop_direct_entry_legacy_grants.sql`), false);
  assert.equal(isWp1073dMigrationName(WP10_7_2B_MIGRATION_NAME), false);
  assert.equal(isWp1073dMigrationName(null), false);
});

test("WP10-7-3D archive CSV parser & manifest loader normalize canonically and fail closed on corruption", async () => {
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "00000000-0000-4000-8000-000000000002";
  const userA = "00000000-0000-4000-8000-000000000010";
  const teamA = "00000000-0000-4000-8000-000000000020";

  // Unsorted CRLF + quoted empty nullable valid_to + uppercase UUIDs normalize identically
  const capParsed = parseWp1073dTableArchiveCsv(
    "direct_entry_capability_grants",
    [
      "grant_id,app_user_id,capability,valid_from,valid_to,created_at_utc,is_current,suspended_by_account_disable",
      `${idB.toUpperCase()},${userA.toUpperCase()},entry_create,2026-01-02,"",2026-01-02T00:00:00.000000Z,true,false`,
      `${idA},${userA},payment_view,2026-01-01,2026-01-05,2026-01-01T00:00:00.000000Z,false,true`,
    ].join("\r\n") + "\r\n",
  );
  const expectedCapSha = createHash("sha256")
    .update(
      [
        `${idA}|${userA}|payment_view|2026-01-01|2026-01-05|2026-01-01T00:00:00.000000Z|false|true`,
        `${idB}|${userA}|entry_create|2026-01-02||2026-01-02T00:00:00.000000Z|true|false`,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  assert.equal(capParsed.rowCount, 2);
  assert.equal(capParsed.canonicalSha256, expectedCapSha);

  // Empty 0-row CSV hashes empty string
  const emptyBridge = parseWp1073dTableArchiveCsv(
    "work_report_team_leader_capability_grants",
    "leader_assignment_id,capability,capability_grant_id\n",
  );
  assert.equal(emptyBridge.rowCount, 0);
  assert.equal(emptyBridge.canonicalSha256, createHash("sha256").update("", "utf8").digest("hex"));

  // Fail-closed validation checks
  assert.throws(
    () => parseWp1073dTableArchiveCsv("direct_entry_capability_grants", "wrong,header\n"),
    /exact header/,
  );
  assert.throws(
    () =>
      parseWp1073dTableArchiveCsv(
        "direct_entry_scope_grants",
        `grant_id,app_user_id,scope_kind,team_id,valid_from,valid_to,created_at_utc,is_current,suspended_by_account_disable\n${idA},${userA},team,,2026-01-01,,2026-01-01T00:00:00.000000Z,true,false\n`,
      ),
    /scope_kind\/team_id invariant violation/,
  );
  assert.throws(
    () =>
      parseWp1073dTableArchiveCsv(
        "direct_entry_scope_grants",
        `grant_id,app_user_id,scope_kind,team_id,valid_from,valid_to,created_at_utc,is_current,suspended_by_account_disable\n${idA},${userA},all,${teamA},2026-01-01,,2026-01-01T00:00:00.000000Z,true,false\n`,
      ),
    /scope_kind\/team_id invariant violation/,
  );
  assert.throws(
    () =>
      parseWp1073dTableArchiveCsv(
        "work_report_team_leader_capability_grants",
        `leader_assignment_id,capability,capability_grant_id\n${idA},entry_admin,${idB}\n`,
      ),
    /invalid bridge capability/,
  );
  assert.throws(
    () =>
      parseWp1073dTableArchiveCsv(
        "work_report_team_leader_capability_grants",
        `leader_assignment_id,capability,capability_grant_id\n${idA},report_view,${idB}\n${idA.toUpperCase()},report_view,${idB}\n`,
      ),
    /duplicate primary key/,
  );

  // Manifest loader round-trip & tamper rejection
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-3d-manifest-"));
  try {
    const { manifestPath, manifest, bundle } = await writeSyntheticWp1073dArchiveBundle(tmpDir);
    const loaded = await loadAndVerifyWp1073dArchiveManifest(manifestPath);
    assert.equal(loaded.expectedBundle.row_count, 5);
    assert.equal(loaded.expectedBundle.canonical_sha256, bundle.canonical_sha256);

    // Tamper CSV -> fails closed
    const bridgeCsvPath = path.join(tmpDir, "work_report_team_leader_capability_grants.archive.csv");
    const origBridgeCsv = await readFile(bridgeCsvPath, "utf8");
    await writeFile(bridgeCsvPath, `${origBridgeCsv}\n`, "utf8");
    await assert.rejects(
      () => loadAndVerifyWp1073dArchiveManifest(manifestPath),
      /CSV file digest mismatch/,
    );
    await writeFile(bridgeCsvPath, origBridgeCsv, "utf8");

    // Path traversal in manifest -> fails closed
    const badManifestPath = path.join(tmpDir, "bad-manifest.json");
    const badManifest = structuredClone(manifest);
    badManifest.tables.direct_entry_capability_grants.csv_file = "../escape.csv";
    await writeFile(badManifestPath, JSON.stringify(badManifest), "utf8");
    await assert.rejects(
      () => loadAndVerifyWp1073dArchiveManifest(badManifestPath),
      /path traversal rejected/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("runMigrationApply with createWp1073dArchiveGuard locks all 3 tables before parity, rolls back on drift, and commits on match", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-3d-guard-"));
  const archiveDir = await mkdtemp(path.join(os.tmpdir(), "migration-3d-arc-"));
  try {
    const preMigration = "20261127020000_wp10_7_3c_stop_legacy_sync.sql";
    const m3dName = `20261127050000${WP10_7_3D_MIGRATION_SUFFIX}`;
    const preSql = "select 254;\n";
    const m3dSql = "begin;\nselect 255;\ncommit;\n";
    await writeFile(path.join(directory, preMigration), preSql);
    await writeFile(path.join(directory, m3dName), m3dSql);

    const { manifestPath } = await writeSyntheticWp1073dArchiveBundle(archiveDir);
    const loaded = await loadAndVerifyWp1073dArchiveManifest(manifestPath);
    const guard = createWp1073dArchiveGuard(loaded);

    const liveRowsMatching = [
      {
        table_name: "direct_entry_capability_grants",
        row_count: String(loaded.expectedTables.direct_entry_capability_grants.row_count),
        canonical_sha256: loaded.expectedTables.direct_entry_capability_grants.canonical_sha256,
      },
      {
        table_name: "direct_entry_scope_grants",
        row_count: String(loaded.expectedTables.direct_entry_scope_grants.row_count),
        canonical_sha256: loaded.expectedTables.direct_entry_scope_grants.canonical_sha256,
      },
      {
        table_name: "work_report_team_leader_capability_grants",
        row_count: String(loaded.expectedTables.work_report_team_leader_capability_grants.row_count),
        canonical_sha256: loaded.expectedTables.work_report_team_leader_capability_grants.canonical_sha256,
      },
      {
        table_name: WP10_7_3D_BUNDLE_TABLE_KEY,
        row_count: String(loaded.expectedBundle.row_count),
        canonical_sha256: loaded.expectedBundle.canonical_sha256,
      },
    ];

    // 1. Drift on any table -> LOCK TABLE runs first, parity fails, ROLLBACK runs, 3D DDL & schema_migrations INSERT never run
    for (const driftedTable of [
      "direct_entry_capability_grants",
      "direct_entry_scope_grants",
      "work_report_team_leader_capability_grants",
    ]) {
      const ops = [];
      let rolledBack = false;
      let committed = false;
      const driftedRows = liveRowsMatching.map((r) =>
        r.table_name === driftedTable ? { ...r, row_count: String(Number(r.row_count) + 1) } : r,
      );
      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              if (sql === "commit") {
                committed = true;
                return { rows: [] };
              }
              if (sql.includes("WITH cap_manifest AS")) {
                return { rows: driftedRows };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          beforeApplyMigration: guard,
          log() {},
          errorLog() {},
        }),
        new RegExp(`WP10-7-3D archive parity check failed in transaction:.*${driftedTable}`),
      );
      assert.equal(rolledBack, true);
      assert.equal(committed, false);
      const lockIdx = ops.findIndex((o) => o.sql === WP10_7_3D_LOCK_ORDER_SQL);
      const parityIdx = ops.findIndex((o) => o.sql.includes("WITH cap_manifest AS"));
      assert.ok(lockIdx >= 0 && parityIdx > lockIdx, `LOCK TABLE must execute before parity for ${driftedTable}`);
      assert.equal(ops.some((o) => o.sql.includes("select 255;")), false);
      assert.equal(ops.some((o) => o.sql.includes("insert into public.schema_migrations")), false);
    }

    // 2. Match -> non-3D skips guard, 3D runs LOCK -> parity -> DDL -> schema_migrations INSERT -> COMMIT
    {
      const ops = [];
      const res = await runMigrationApply({
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
        createClient: () => ({
          async connect() {},
          async query(sql, params) {
            ops.push({ sql, params });
            if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
            if (sql === "select version, checksum from public.schema_migrations") return { rows: [] };
            if (sql.includes("WITH cap_manifest AS")) return { rows: liveRowsMatching };
            return { rows: [] };
          },
          async end() {},
        }),
        beforeApplyMigration: composeBeforeApplyMigrationGuards(
          createWp1072bMissingArchiveGuard(),
          guard,
        ),
        log() {},
        errorLog() {},
      });
      assert.equal(res.appliedCount, 2);
      assert.equal(res.skippedCount, 0);
      assert.equal(ops.filter((o) => o.sql === WP10_7_3D_LOCK_ORDER_SQL).length, 1);
      const lockIdx = ops.findIndex((o) => o.sql === WP10_7_3D_LOCK_ORDER_SQL);
      const parityIdx = ops.findIndex((o) => o.sql.includes("WITH cap_manifest AS"));
      const ddlIdx = ops.findIndex((o) => o.sql.includes("select 255;"));
      const ledgerIdx = ops.findIndex(
        (o) => o.sql.includes("insert into public.schema_migrations") && o.params?.[0] === m3dName,
      );
      const commitIdx = ops.findIndex((o, idx) => idx > ledgerIdx && o.sql === "commit");
      assert.ok(lockIdx >= 0 && parityIdx > lockIdx && ddlIdx > parityIdx && ledgerIdx > ddlIdx && commitIdx > ledgerIdx);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
  }
});

test("createWp1073dMissingArchiveGuard and direct runMigrationApply fail closed when 3D is pending without archive and skip cleanly once recorded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-3d-default-gate-"));
  try {
    const preMigration = "20261127020000_wp10_7_3c_stop_legacy_sync.sql";
    const m3dName = `20261127060000${WP10_7_3D_MIGRATION_SUFFIX}`;
    const preSql = "select 254;\n";
    const m3dSql = "begin;\nselect 255;\ncommit;\n";
    await writeFile(path.join(directory, preMigration), preSql);
    await writeFile(path.join(directory, m3dName), m3dSql);

    // 1. Default missing-archive guard blocks pending 3D BEFORE DDL and BEFORE schema_migrations write
    {
      const ops = [];
      let rolledBack = false;
      await assert.rejects(
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          beforeApplyMigration: createWp1073dMissingArchiveGuard(),
          log() {},
          errorLog() {},
        }),
        /requires verified 3-table archive parity before dropping/,
      );
      assert.equal(rolledBack, true);
      assert.equal(ops.some((o) => o.sql.includes("select 255;")), false);
      assert.equal(ops.some((o) => o.sql.includes("insert into public.schema_migrations")), false);
    }

    // 2. Already recorded 3D migration skips cleanly by checksum without invoking missing-archive guard
    {
      const ops = [];
      const res = await runMigrationApply({
        directory,
        loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
        createClient: () => ({
          async connect() {},
          async query(sql, params) {
            ops.push({ sql, params });
            if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
            if (sql === "select version, checksum from public.schema_migrations") {
              return {
                rows: [
                  { version: preMigration, checksum: migrationChecksum(preSql) },
                  { version: m3dName, checksum: migrationChecksum(m3dSql) },
                ],
              };
            }
            return { rows: [] };
          },
          async end() {},
        }),
        beforeApplyMigration: createWp1073dMissingArchiveGuard(),
        log() {},
        errorLog() {},
      });
      assert.equal(res.appliedCount, 0);
      assert.equal(res.skippedCount, 2);
      assert.equal(ops.some((o) => o.sql === "begin"), false);
    }

    // 3. Direct runMigrationApply without beforeApplyMigration: blocks populated legacy tables (>0 rows), allows 0-row fresh bootstrap DB
    for (const [counts, shouldReject] of [
      [{ cap_count: "1", scope_count: "0", bridge_count: "0" }, true],
      [{ cap_count: "0", scope_count: "2", bridge_count: "0" }, true],
      [{ cap_count: "0", scope_count: "0", bridge_count: "1" }, true],
      [{ cap_count: "0", scope_count: "0", bridge_count: "0" }, false],
    ]) {
      const ops = [];
      let rolledBack = false;
      const exec = () =>
        runMigrationApply({
          directory,
          loadConfig: async () => ({ databaseUrl: "postgres://synthetic", projectRef: "reqtest" }),
          createClient: () => ({
            async connect() {},
            async query(sql, params) {
              ops.push({ sql, params });
              if (sql.includes("create table if not exists public.schema_migrations")) return { rows: [] };
              if (sql === "select version, checksum from public.schema_migrations") {
                return { rows: [{ version: preMigration, checksum: migrationChecksum(preSql) }] };
              }
              if (sql === "rollback") {
                rolledBack = true;
                return { rows: [] };
              }
              if (sql.includes("cap_count") && sql.includes("bridge_count")) {
                return { rows: [counts] };
              }
              return { rows: [] };
            },
            async end() {},
          }),
          log() {},
          errorLog() {},
        });
      if (shouldReject) {
        await assert.rejects(
          exec,
          /requires verified 3-table archive parity when legacy grant tables have existing rows/,
        );
        assert.equal(rolledBack, true);
        assert.equal(ops.some((o) => o.sql.includes("select 255;")), false);
        assert.equal(ops.some((o) => o.sql.includes("insert into public.schema_migrations")), false);
      } else {
        const res = await exec();
        assert.equal(res.appliedCount, 1);
        assert.ok(ops.some((o) => o.sql.includes("select 255;")));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scripts/apply-migrations.mjs CLI validates WP10-7-3D archive flags fail-closed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "apply-mig-3d-cli-"));
  try {
    const { manifestPath, bundle } = await writeSyntheticWp1073dArchiveBundle(tempDir);
    const wrongBundleSha = bundle.canonical_sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    const runCli = (args) =>
      spawnSync(process.execPath, ["scripts/apply-migrations.mjs", ...args], {
        encoding: "utf8",
        windowsHide: true,
      });

    for (const [label, args, pattern] of [
      ["bundle sha without manifest", ["--wp10-7-3d-expected-bundle-sha256", bundle.canonical_sha256], /yêu cầu đi kèm --wp10-7-3d-archive-manifest/],
      ["combined with offline", ["--offline", "--wp10-7-3d-archive-manifest", manifestPath], /--offline hoặc --dry-run/],
      ["combined with dry-run", ["--dry-run", "--wp10-7-3d-archive-manifest", manifestPath], /--offline hoặc --dry-run/],
      ["bad bundle sha hex", ["--wp10-7-3d-archive-manifest", manifestPath, "--wp10-7-3d-expected-bundle-sha256", "not-hex"], /expected-bundle-sha256 không hợp lệ/],
      ["manifest bundle sha mismatch", [`--wp10-7-3d-archive-manifest=${manifestPath}`, `--wp10-7-3d-expected-bundle-sha256=${wrongBundleSha}`], /archive manifest không khớp --wp10-7-3d-expected-bundle-sha256/],
      ["missing manifest path", ["--wp10-7-3d-archive-manifest", path.join(tempDir, "missing.json")], /ENOENT/],
    ]) {
      const res = runCli(args);
      assert.notEqual(res.status, 0, `${label} must fail`);
      assert.match(res.stderr, pattern, `${label} error message`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
