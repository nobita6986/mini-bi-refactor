import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractS0T1CAllowlistSignatures,
  migrationChecksum,
  migrationSqlForTransaction,
  R1_2_MIGRATION_NAME,
  R1_2_SERVICE_RPC_SIGNATURE,
  runMigrationApply,
  runMigrationValidation,
  S0_T1_C_CURRENT_CHECKSUM,
  S0_T1_C_MIGRATION_NAME,
  S0_T1_C_PRE_PR92_CHECKSUM,
} from "./lib/migration-validation.mjs";
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
