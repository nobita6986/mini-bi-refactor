/**
 * PR #28 Phase A — Unified User Directory Real PostgreSQL 18 Concurrency & Dynamic ACL Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated ephemeral PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies under `SET LOCAL ROLE service_role` with ZERO `40P01` deadlocks:
 *   1. Full 235-migration apply + dynamic S0-T1-C allowlist postconditions pre/post (+2 net
 *      service_role RPCs relative to applied prefix, 0 client/PUBLIC grants, 0 unsafe search_path,
 *      bootstrap executor intact).
 *   2. Concurrent unified directory list/detail reads (`org_department_list_user_directory_admin`
 *      and `org_department_get_user_directory_entry_admin`) executing alongside live Person create,
 *      Account-Person link/unlink, and Account disable mutations -> zero `40P01` deadlocks, zero
 *      errors, exact post-state `P + U - C` count invariant, and deterministic multi-page pagination.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  PR28_UNIFIED_USER_DIRECTORY_READER_MIGRATION_NAME,
  PR28_UNIFIED_USER_DIRECTORY_READER_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "18001000-0000-4000-8000-000000000001",
  app: "28001000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner PG18 PR28",
};
const LUANPT = {
  auth: "18001000-0000-4000-8000-000000000002",
  app: "28001000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT PG18",
};
const LIENVU = {
  auth: "18001000-0000-4000-8000-000000000003",
  app: "28001000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu PG18",
};
const NGATTT = {
  auth: "18001000-0000-4000-8000-000000000004",
  app: "28001000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT PG18",
};
const TARGET_A = {
  auth: "18001000-0000-4000-8000-000000000011",
  app: "28001000-0000-4000-8000-000000000011",
  email: "pr28.pg18.a@hrpartner.vn",
  name: "PG18 User A",
};
const TARGET_B = {
  auth: "18001000-0000-4000-8000-000000000012",
  app: "28001000-0000-4000-8000-000000000012",
  email: "pr28.pg18.b@hrpartner.vn",
  name: "PG18 User B",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `98001000-0000-4000-8000-${hex}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
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
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function connect(port, database, appName) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: appName,
  });
  await client.connect();
  return client;
}

async function serviceQuery(port, database, appName, sql, params = []) {
  const client = await connect(port, database, appName);
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

const initdb = binary("initdb");
const pgCtl = binary("pg_ctl");
const externalDatabaseUrl = process.env.PR28_PG_TEST_DATABASE_URL || process.env.WP13_PR0_PG_TEST_DATABASE_URL || null;

test(
  "PR #28 Phase A PostgreSQL 18: 235-migration dynamic S0-T1-C allowlist & concurrent unified directory reads under live mutations",
  { skip: !externalDatabaseUrl && (!initdb || !pgCtl) },
  async () => {
    let tempDir = null;
    let dataDir = null;
    let port = null;
    let admin = null;
    let client = null;
    const databaseName = `pr28_dir_${Date.now().toString(36)}`;
    let serverStarted = false;

    try {
      if (!externalDatabaseUrl) {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "pr28-dir-pg-"));
        dataDir = path.join(tempDir, "data");
        port = await freePort();
        run(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"]);
        run(
          pgCtl,
          [
            "-D",
            dataDir,
            "-l",
            path.join(tempDir, "pg.log"),
            "-o",
            `-p ${port} -k "${tempDir}" -c listen_addresses=127.0.0.1 -c max_connections=40`,
            "-w",
            "start",
          ],
          { ignoreOutput: true },
        );
        serverStarted = true;
      }

      admin = externalDatabaseUrl
        ? new Client({ connectionString: externalDatabaseUrl })
        : await connect(port, "postgres", "pr28-admin");
      if (externalDatabaseUrl) await admin.connect();
      await admin.query(`create database ${databaseName}`);

      client = externalDatabaseUrl
        ? new Client({
            connectionString: externalDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`),
          })
        : await connect(port, databaseName, "pr28-main");
      if (externalDatabaseUrl) await client.connect();

      await client.query(
        "create role anon; create role authenticated; create role service_role;" +
          " create schema auth; create table auth.users (id uuid primary key, email text);",
      );

      const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
      const pr28Idx = names.indexOf(PR28_UNIFIED_USER_DIRECTORY_READER_MIGRATION_NAME);
      assert.ok(pr28Idx >= 0, "PR #28 migration must exist");

      const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");

      for (let i = 0; i < pr28Idx; i += 1) {
        const sql = await readFile(path.join(MIGRATION_DIR, names[i]), "utf8");
        await client.query(sql);
      }

      const preCheck = await verifyS0T1CSecurityPostconditions(
        client,
        s0Sql,
        new Set(names.slice(0, pr28Idx)),
      );
      assert.equal(preCheck.ok, true, `pre-PR28 S0-T1-C failed: ${preCheck.reason}`);

      // Apply PR #28 migration #235 and verify exact +2 net delta relative to its applied prefix
      await client.query(await readFile(path.join(MIGRATION_DIR, names[pr28Idx]), "utf8"));
      const pr28PostCheck = await verifyS0T1CSecurityPostconditions(
        client,
        s0Sql,
        new Set(names.slice(0, pr28Idx + 1)),
      );
      assert.equal(pr28PostCheck.ok, true, `post-PR28 S0-T1-C failed: ${pr28PostCheck.reason}`);
      assert.equal(
        pr28PostCheck.details.actualServiceCount,
        preCheck.details.actualServiceCount + PR28_UNIFIED_USER_DIRECTORY_READER_RPC_SIGNATURES.length,
      );
      assert.equal(pr28PostCheck.details.exposedClientOrPublicCount, 0);
      assert.equal(pr28PostCheck.details.unsafeSecdefSearchPathCount, 0);
      assert.equal(pr28PostCheck.details.bootstrapExecutorIntact, true);

      // Seed actors & run WP5 cutover BEFORE applying #236/#237 group-only cutover (real production order)
      for (const u of [OWNER, LUANPT, LIENVU, NGATTT, TARGET_A, TARGET_B]) {
        await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
        await client.query(
          `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
           values ($1::uuid, $2::uuid, $3, true)`,
          [u.app, u.auth, u.name],
        );
      }
      for (const adm of [OWNER, LIENVU, NGATTT]) {
        await client.query(
          `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
           values ($1::uuid, 'all', null, '2020-01-01', true), ($1::uuid, 'own', null, '2020-01-01', true)`,
          [adm.app],
        );
        for (const cap of [
          "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
          "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
          "audit_view", "worker_edit_history_view", "document_upload", "document_view",
          "employment_status.review", "employment_status.apply", "change_request_create",
          "change_review", "employment_status.request", "duplicate_cccd_withdraw",
        ]) {
          await client.query(
            `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
             values ($1::uuid, $2, '2020-01-01', true)`,
            [adm.app, cap],
          );
        }
      }
      await client.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'all', null, '2020-01-01', true)`,
        [LUANPT.app],
      );
      const plan = await runWp5Cutover(client, { mode: "read-only-plan" });
      assert.equal(plan.action_diff.unexpected_diff_count, 0);
      const applied = await runWp5Cutover(client, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: plan.manifest_fingerprint,
      });
      assert.equal(applied.status, "APPLIED");

      // Apply subsequent migrations (#236/#237) and verify full-chain S0-T1-C postconditions
      for (let i = pr28Idx + 1; i < names.length; i += 1) {
        const sql = await readFile(path.join(MIGRATION_DIR, names[i]), "utf8");
        await client.query(sql);
      }
      const postCheck = await verifyS0T1CSecurityPostconditions(client, s0Sql, new Set(names));
      assert.equal(postCheck.ok, true, `full-chain S0-T1-C failed: ${postCheck.reason}`);
      assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
      assert.equal(postCheck.details.unsafeSecdefSearchPathCount, 0);
      assert.equal(postCheck.details.bootstrapExecutorIntact, true);

      const { rows: [recDept] } = await client.query(
        "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
      );

      // Run concurrent unified directory reads alongside live Person creation + Account disable!
      const createKey = nextUuid();
      const disableKey = nextUuid();
      const createFp = sha256(`pg18-create-person-${createKey}`);

      const runService = (appName, sql, params) =>
        externalDatabaseUrl
          ? (async () => {
              const c = new Client({
                connectionString: externalDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${databaseName}$1`),
              });
              await c.connect();
              try {
                await c.query("begin");
                await c.query("set local role service_role");
                const r = await c.query(sql, params);
                await c.query("commit");
                return r;
              } catch (e) {
                await c.query("rollback").catch(() => {});
                throw e;
              } finally {
                await c.end().catch(() => {});
              }
            })()
          : serviceQuery(port, databaseName, appName, sql, params);

      const settled = await Promise.all([
        runService(
          "pr28-create-person",
          `select public.org_department_create_person_admin(
             $1::uuid, $2::uuid, 'PG18-EMP-A', 'PG18 Linked Person A', '2026-01-10'::date,
             $3::uuid, $4::uuid, 1, null, 'PG18 link create', $5::uuid, $6
           ) as res`,
          [OWNER.auth, OWNER.app, recDept.department_id, TARGET_A.app, createKey, createFp],
        ),
        runService(
          "pr28-disable-b",
          `select public.direct_entry_disable_app_user(
             $1::uuid, $2::uuid, $3::uuid, 1, 'PG18 disable target B', $4
           ) as res`,
          [OWNER.auth, OWNER.app, TARGET_B.app, disableKey],
        ),
        runService(
          "pr28-read-page1",
          `select public.org_department_list_user_directory_admin(
             $1::uuid, $2::uuid, null, 'all', 'all', 'all', null, null, 1, 2
           ) as res`,
          [OWNER.auth, OWNER.app],
        ),
        runService(
          "pr28-read-page2",
          `select public.org_department_list_user_directory_admin(
             $1::uuid, $2::uuid, null, 'all', 'all', 'all', null, null, 2, 2
           ) as res`,
          [OWNER.auth, OWNER.app],
        ),
        runService(
          "pr28-detail-a",
          `select public.org_department_get_user_directory_entry_admin(
             $1::uuid, $2::uuid, null, $3::uuid, null
           ) as res`,
          [OWNER.auth, OWNER.app, TARGET_A.app],
        ),
      ]);

      const createdPersonId = settled[0].rows[0].res.person.person_id;
      assert.ok(createdPersonId);

      // Post-state exact invariant: P=1, U=6, C=1 => total = 6
      const postList = await runService(
        "pr28-post-list",
        `select public.org_department_list_user_directory_admin(
           $1::uuid, $2::uuid, null, 'all', 'all', 'all', null, null, 1, 50
         ) as res`,
        [OWNER.auth, OWNER.app],
      );
      const body = postList.rows[0].res;
      assert.equal(body.total, 6);
      assert.deepEqual(body.summary, {
        total_all: 6,
        linked_count: 1,
        person_only_count: 0,
        unlinked_account_count: 5,
        conflict_count: 0,
      });

      const byKey = new Map(body.entries.map((e) => [e.directory_entry_key, e]));
      assert.equal(byKey.get(`person:${createdPersonId}`)?.record_kind, "LINKED_PERSON_ACCOUNT");
      assert.equal(byKey.get(`person:${createdPersonId}`)?.account_ref, TARGET_A.app);
      assert.equal(byKey.get(`account:${TARGET_B.app}`)?.record_kind, "UNLINKED_ACCOUNT");
      assert.equal(byKey.get(`account:${TARGET_B.app}`)?.login_state, "DISABLED");
    } finally {
      await client?.end().catch(() => {});
      if (admin) {
        await admin
          .query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName])
          .catch(() => {});
        await admin.query(`drop database if exists ${databaseName}`).catch(() => {});
        await admin.end().catch(() => {});
      }
      if (serverStarted && pgCtl && dataDir) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          encoding: "utf8",
          windowsHide: true,
          stdio: "ignore",
        });
      }
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  },
);
