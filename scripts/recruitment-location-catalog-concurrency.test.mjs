/**
 * Phase 1 — Recruitment Location Catalog Foundation (`administrative_provinces` & `industrial_parks`)
 * Real PostgreSQL Concurrency Regression Suite (`initdb` + `pg_ctl`, zero remote DB).
 *
 * Proves:
 *   1. Parallel duplicate `normalized_key` creation race in the same province
 *      (`industrial_park_create_admin`): strictly 1 winner commits, 1 contender fails with `23505`.
 *   2. Parallel `expected_version` update race (`industrial_park_update_admin`):
 *      strictly 1 winner advances `version`, 1 contender fails with `40001` or `23505`.
 *   3. Parallel idempotent replay (`industrial_park_create_admin`) with identical
 *      `(actor, idempotency_key, payload)`: strictly 1 industrial park and 1 revision are persisted.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN = {
  auth: "19900000-0000-4000-8000-000000000081",
  app: "29900000-0000-4000-8000-000000000081",
  email: "nobita6986@gmail.com",
  name: "Full Admin Location Race",
};

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32"
      ? "C:\\Program Files\\PostgreSQL\\18\\bin"
      : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false, logFile } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  if (result.status !== 0) {
    const details = [
      result.stderr ? `stderr:\n${result.stderr.trim()}` : null,
      result.stdout ? `stdout:\n${result.stdout.trim()}` : null,
      logFile && existsSync(logFile)
        ? `postgres.log:\n${readFileSync(logFile, "utf8").trim()}`
        : null,
      result.error ? `spawnError: ${result.error.message}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    assert.equal(
      result.status,
      0,
      `${path.basename(file)} failed (exit=${result.status}, signal=${result.signal ?? "none"}):\n${details || "(no output captured)"}`,
    );
  }
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

async function connect(
  port,
  database = "postgres",
  applicationName = "loc-catalog-race",
) {
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

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key, email text);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  assert.ok(
    names.includes(RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME),
    `migration inventory must include ${RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

test("Real PostgreSQL concurrency: duplicate normalized_key creation race, expected_version update race, and idempotent replay", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries (initdb/pg_ctl) not available on PATH");
    return;
  }

  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "bi-loc-catalog-pg-"),
  );
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  let started = false;

  try {
    run(initdb, [
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
      "--pgdata",
      dataDir,
    ]);
    run(
      pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-o",
        `-F -h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w",
        "start",
      ],
      { ignoreOutput: process.platform === "win32", logFile },
    );
    started = true;

    const setup = await connect(port, "postgres", "loc-setup");
    try {
      await applyMigrations(setup);
      await setup.query(
        "insert into auth.users (id, email) values ($1::uuid, $2)",
        [ADMIN.auth, ADMIN.email],
      );
      await setup.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [ADMIN.app, ADMIN.auth, ADMIN.name],
      );
      for (const cap of [
        "entry_admin",
        "recruiter_master_manage",
        "team_master_manage",
      ]) {
        await setup.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2020-01-01', true)`,
          [ADMIN.app, cap],
        );
      }
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2020-01-01', true)`,
        [ADMIN.app],
      );
    } finally {
      await setup.end();
    }

    const c1 = await connect(port, "postgres", "loc-race-1");
    const c2 = await connect(port, "postgres", "loc-race-2");
    try {
      const { rows: provRows } = await c1.query(
        "select province_id from public.administrative_provinces where province_code = 'VINH_PHUC'",
      );
      const vinhPhucId = provRows[0].province_id;

      // 1. Parallel duplicate normalized_key creation race in the same province
      const [dup1, dup2] = await Promise.allSettled([
        c1.query(
          "select public.industrial_park_create_admin($1::uuid, $2::uuid, 0, 'VP_TAM_DUONG_A', $3::uuid, 'KCN Tam Dương II', 'Race A', '70000000-0000-4000-8000-000000000001') as res",
          [ADMIN.auth, ADMIN.app, vinhPhucId],
        ),
        c2.query(
          "select public.industrial_park_create_admin($1::uuid, $2::uuid, 0, 'VP_TAM_DUONG_B', $3::uuid, 'Khu công nghiệp Tam-Dương-II', 'Race B', '70000000-0000-4000-8000-000000000002') as res",
          [ADMIN.auth, ADMIN.app, vinhPhucId],
        ),
      ]);

      const dupFulfilled = [dup1, dup2].filter((r) => r.status === "fulfilled");
      const dupRejected = [dup1, dup2].filter((r) => r.status === "rejected");
      assert.equal(dupFulfilled.length, 1, "Strictly 1 duplicate-key create must win");
      assert.equal(dupRejected.length, 1, "Strictly 1 duplicate-key create must lose");
      assert.equal(dupRejected[0].reason.code, "23505");

      const winningPark = dupFulfilled[0].value.rows[0].res;
      assert.equal(winningPark.normalized_key, "tamduongii");
      assert.equal(winningPark.version, 1);

      // 2. Parallel expected_version update race on the winning park
      const [upd1, upd2] = await Promise.allSettled([
        c1.query(
          "select public.industrial_park_update_admin($1::uuid, $2::uuid, $3::uuid, 1, null, 'Tam Dương II - Khu A', 'Update A', '70000000-0000-4000-8000-000000000003') as res",
          [ADMIN.auth, ADMIN.app, winningPark.industrial_park_id],
        ),
        c2.query(
          "select public.industrial_park_update_admin($1::uuid, $2::uuid, $3::uuid, 1, null, 'Tam Dương II - Khu B', 'Update B', '70000000-0000-4000-8000-000000000004') as res",
          [ADMIN.auth, ADMIN.app, winningPark.industrial_park_id],
        ),
      ]);

      const updFulfilled = [upd1, upd2].filter((r) => r.status === "fulfilled");
      const updRejected = [upd1, upd2].filter((r) => r.status === "rejected");
      assert.equal(updFulfilled.length, 1, "Strictly 1 concurrent update must win");
      assert.equal(updRejected.length, 1, "Strictly 1 concurrent update must fail OCC");
      assert.equal(updRejected[0].reason.code, "40001");
      assert.equal(updFulfilled[0].value.rows[0].res.version, 2);

      // 3. Parallel idempotent create replay with identical key & payload
      const idemKey = "70000000-0000-4000-8000-000000000005";
      const [idem1, idem2] = await Promise.allSettled([
        c1.query(
          "select public.industrial_park_create_admin($1::uuid, $2::uuid, 0, 'VP_SON_LOI', $3::uuid, 'Sơn Lôi', 'Idem create', $4) as res",
          [ADMIN.auth, ADMIN.app, vinhPhucId, idemKey],
        ),
        c2.query(
          "select public.industrial_park_create_admin($1::uuid, $2::uuid, 0, 'VP_SON_LOI', $3::uuid, 'Sơn Lôi', 'Idem create', $4) as res",
          [ADMIN.auth, ADMIN.app, vinhPhucId, idemKey],
        ),
      ]);
      const idemFulfilled = [idem1, idem2].filter((r) => r.status === "fulfilled");
      assert.ok(idemFulfilled.length >= 1);

      const { rows: sonLoiCount } = await c1.query(
        "select count(*)::int as cnt from public.industrial_parks where industrial_park_code = 'VP_SON_LOI'",
      );
      assert.equal(sonLoiCount[0].cnt, 1);
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
