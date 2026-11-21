/**
 * WP5B-1 — Real PostgreSQL Concurrency Regression Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`
 * and imports zero `"server-only"` or `.ts` modules) against an isolated local
 * PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Proves under `SET ROLE service_role` with ZERO `40P01` deadlocks:
 *   1. Duplicate global role assign race (lock-hold + parallel burst):
 *      strictly 1 commits, contender rejects `PT409`, open row count = 1.
 *   2. Opposite-direction `(actor, target)` lock-order race (`assign_global_role`
 *      vs `disable_app_user` with swapped UUIDs): both acquire `direct_entry_app_users`
 *      locks in ascending `app_user_id` order (`0` `40P01` deadlocks, consistent state).
 *   3. Concurrent actor authority loss (`revoke ADMIN` on actor vs actor calling
 *      `assign_global_role` on a third user): serialized cleanly, `0` `40P01`,
 *      actor loses authority and rejects `42501`.
 *   4. Parallel `PROTECTED_OWNER_ADMIN` revoke race (Owner self-revoke + another Admin):
 *      both reject `PT409 AUTHZ_PROTECTED_ASSIGNMENT`, `0` version bump, protected
 *      assignment remains open.
 *   5. `enable_app_user` vs `designate_team_leader` (replace TL) — both T0 pause pattern
 *      (target account lock held before replace) and reverse replace-first + burst:
 *      `0` `40P01` deadlocks, `0` resurrected TL authority, independent grants intact.
 *   6. `enable_app_user` vs `revoke_team_leader` — both T0 pause pattern and reverse
 *      revoke-first + burst: `0` `40P01` deadlocks, `0` resurrected TL authority,
 *      independent grants intact.
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

import { WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "19500000-0000-4000-8000-000000000001",
  app: "29500000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const ADMIN_A = {
  auth: "19500000-0000-4000-8000-000000000002",
  app: "29500000-0000-4000-8000-000000000002",
  email: "admin.a@hrpartner.vn",
  name: "WP5 Race Admin A",
};
const ADMIN_B = {
  auth: "19500000-0000-4000-8000-000000000003",
  app: "29500000-0000-4000-8000-000000000003",
  email: "admin.b@hrpartner.vn",
  name: "WP5 Race Admin B",
};
const ADMIN_A2 = {
  auth: "19500000-0000-4000-8000-000000000004",
  app: "29500000-0000-4000-8000-000000000004",
  email: "admin.a2@hrpartner.vn",
  name: "WP5 Race Admin A2",
};
const ADMIN_B2 = {
  auth: "19500000-0000-4000-8000-000000000005",
  app: "29500000-0000-4000-8000-000000000005",
  email: "admin.b2@hrpartner.vn",
  name: "WP5 Race Admin B2",
};
const ADMIN_X = {
  auth: "19500000-0000-4000-8000-000000000006",
  app: "29500000-0000-4000-8000-000000000006",
  email: "admin.x@hrpartner.vn",
  name: "WP5 Race Admin X",
};
const ADMIN_Y = {
  auth: "19500000-0000-4000-8000-000000000007",
  app: "29500000-0000-4000-8000-000000000007",
  email: "admin.y@hrpartner.vn",
  name: "WP5 Race Admin Y",
};
const ADMIN_Y2 = {
  auth: "19500000-0000-4000-8000-000000000008",
  app: "29500000-0000-4000-8000-000000000008",
  email: "admin.y2@hrpartner.vn",
  name: "WP5 Race Admin Y2",
};
const USER_DUP = {
  auth: "19500000-0000-4000-8000-000000000011",
  app: "29500000-0000-4000-8000-000000000011",
  email: "user.dup@hrpartner.vn",
  name: "WP5 Race User Dup",
};
const USER_DUP2 = {
  auth: "19500000-0000-4000-8000-000000000012",
  app: "29500000-0000-4000-8000-000000000012",
  email: "user.dup2@hrpartner.vn",
  name: "WP5 Race User Dup2",
};
const USER_Z = {
  auth: "19500000-0000-4000-8000-000000000013",
  app: "29500000-0000-4000-8000-000000000013",
  email: "user.z@hrpartner.vn",
  name: "WP5 Race User Z",
};
const USER_Z2 = {
  auth: "19500000-0000-4000-8000-000000000014",
  app: "29500000-0000-4000-8000-000000000014",
  email: "user.z2@hrpartner.vn",
  name: "WP5 Race User Z2",
};

const TL_5A_OLD = {
  auth: "19500000-0000-4000-8000-000000000021",
  app: "29500000-0000-4000-8000-000000000021",
  recruiter: "39500000-0000-4000-8000-000000000021",
  email: "tl.5a.old@hrpartner.vn",
  name: "WP5 Race TL 5A Old",
};
const TL_5A_NEW = {
  auth: "19500000-0000-4000-8000-000000000022",
  app: "29500000-0000-4000-8000-000000000022",
  recruiter: "39500000-0000-4000-8000-000000000022",
  email: "tl.5a.new@hrpartner.vn",
  name: "WP5 Race TL 5A New",
};
const TL_5B_NEW = {
  auth: "19500000-0000-4000-8000-000000000023",
  app: "29500000-0000-4000-8000-000000000023",
  recruiter: "39500000-0000-4000-8000-000000000023",
  email: "tl.5b.new@hrpartner.vn",
  name: "WP5 Race TL 5B New",
};
const TL_5B_OLD = {
  auth: "19500000-0000-4000-8000-000000000024",
  app: "29500000-0000-4000-8000-000000000024",
  recruiter: "39500000-0000-4000-8000-000000000024",
  email: "tl.5b.old@hrpartner.vn",
  name: "WP5 Race TL 5B Old",
};
const TL_5C_OLD = {
  auth: "19500000-0000-4000-8000-000000000025",
  app: "29500000-0000-4000-8000-000000000025",
  recruiter: "39500000-0000-4000-8000-000000000025",
  email: "tl.5c.old@hrpartner.vn",
  name: "WP5 Race TL 5C Old",
};
const TL_5C_NEW = {
  auth: "19500000-0000-4000-8000-000000000026",
  app: "29500000-0000-4000-8000-000000000026",
  recruiter: "39500000-0000-4000-8000-000000000026",
  email: "tl.5c.new@hrpartner.vn",
  name: "WP5 Race TL 5C New",
};
const TL_6A_OLD = {
  auth: "19500000-0000-4000-8000-000000000027",
  app: "29500000-0000-4000-8000-000000000027",
  recruiter: "39500000-0000-4000-8000-000000000027",
  email: "tl.6a.old@hrpartner.vn",
  name: "WP5 Race TL 6A Old",
};
const TL_6B_OLD = {
  auth: "19500000-0000-4000-8000-000000000028",
  app: "29500000-0000-4000-8000-000000000028",
  recruiter: "39500000-0000-4000-8000-000000000028",
  email: "tl.6b.old@hrpartner.vn",
  name: "WP5 Race TL 6B Old",
};
const TL_6C_OLD = {
  auth: "19500000-0000-4000-8000-000000000029",
  app: "29500000-0000-4000-8000-000000000029",
  recruiter: "39500000-0000-4000-8000-000000000029",
  email: "tl.6c.old@hrpartner.vn",
  name: "WP5 Race TL 6C Old",
};

const TL_USERS = [
  TL_5A_OLD,
  TL_5A_NEW,
  TL_5B_NEW,
  TL_5B_OLD,
  TL_5C_OLD,
  TL_5C_NEW,
  TL_6A_OLD,
  TL_6B_OLD,
  TL_6C_OLD,
];

const ALL_USERS = [
  OWNER,
  ADMIN_A,
  ADMIN_B,
  ADMIN_A2,
  ADMIN_B2,
  ADMIN_X,
  ADMIN_Y,
  ADMIN_Y2,
  USER_DUP,
  USER_DUP2,
  USER_Z,
  USER_Z2,
  ...TL_USERS,
];

let keySeq = 1;
function nextKey() {
  const hex = (keySeq++).toString(16).padStart(12, "0");
  return `99500000-0000-4000-8000-${hex}`;
}

function sha256RequestHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

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
  assert.equal(
    result.status,
    0,
    `${path.basename(file)} failed:\n${result.stderr || result.stdout}`,
  );
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

async function connect(port, database = "postgres", applicationName = "wp5-race") {
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

async function waitUntilBlocked(observer, applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where application_name = $1",
      [applicationName],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`session ${applicationName} did not block on PostgreSQL lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key, email text);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql")
    .sort();
  assert.ok(
    names.includes(WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME),
    `migration inventory must include ${WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

const ASSIGN_SQL =
  "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7::uuid, $8) as data";
const REVOKE_SQL =
  "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const DISABLE_SQL =
  "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const ENABLE_SQL =
  "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const DESIGNATE_TL_SQL =
  "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, $5::int, $6, $7) as data";
const REVOKE_TL_SQL =
  "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, null::date, $4::int, $5, $6) as data";

function assignArgs(actor, targetAppId, roleCode, expectedVersion, reason) {
  const idempotencyKey = nextKey();
  return [
    actor.auth,
    actor.app,
    targetAppId,
    roleCode,
    expectedVersion,
    reason,
    idempotencyKey,
    sha256RequestHash({
      op: "AUTHZ_GLOBAL_ROLE_ASSIGNED",
      actor_app_user_id: actor.app,
      target_app_user_id: targetAppId,
      role_code: roleCode,
      expected_account_version: expectedVersion,
      reason,
      idempotency_key: idempotencyKey,
    }),
  ];
}

function revokeArgs(actor, targetAppId, assignmentId, expectedVersion, reason) {
  const idempotencyKey = nextKey();
  return [
    actor.auth,
    actor.app,
    targetAppId,
    assignmentId,
    expectedVersion,
    reason,
    idempotencyKey,
    sha256RequestHash({
      op: "AUTHZ_GLOBAL_ROLE_REVOKED",
      actor_app_user_id: actor.app,
      target_app_user_id: targetAppId,
      assignment_id: assignmentId,
      expected_account_version: expectedVersion,
      reason,
      idempotency_key: idempotencyKey,
    }),
  ];
}

function assertNotDeadlockAndSingleWinner(settled, label) {
  for (const r of settled) {
    if (r.status === "rejected") {
      assert.notEqual(r.reason?.code, "40P01", `${label}: deadlock 40P01 must never occur`);
      assert.equal(
        r.reason?.code,
        "PT409",
        `${label}: contender must reject with PT409, got ${r.reason?.code} ${r.reason?.message}`,
      );
    }
  }
  const winners = settled.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1, `${label}: strictly 1 contender must succeed`);
  assert.equal(settled.length - winners.length, settled.length - 1);
  return winners[0].value.rows[0].data;
}

test("WP5B-1 real PostgreSQL concurrency: duplicate assign, swap-order lock, actor authority loss, and protected Owner revoke serialize with 0 deadlocks", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wp5b1-role-access-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `wp5_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
  let blocker;
  let worker1;
  let worker2;

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
        `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w",
        "start",
      ],
      { ignoreOutput: process.platform === "win32" },
    );
    serverStarted = true;

    adminClient = await connect(port);
    await adminClient.query(`create database ${databaseName}`);

    setup = await connect(port, databaseName, "wp5-setup");
    await applyMigrations(setup);

    // Enable cutover state in this isolated test cluster to exercise live mutations
    await setup.query("update public.authz_system_state set cutover_ready = true");

    for (const user of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        user.auth,
        user.email,
      ]);
      await setup.query(
        `insert into public.direct_entry_app_users
           (app_user_id, auth_subject, display_name, account_type, enabled, authz_managed, version)
         values ($1::uuid, $2::uuid, $3, 'NORMAL', true, true, 1)`,
        [user.app, user.auth, user.name],
      );
    }

    // Seed canonical Owner with PROTECTED_OWNER_ADMIN + synced legacy Full Admin grants
    const {
      rows: [{ assignment_id: ownerAssignId }],
    } = await setup.query(
      `insert into public.authz_account_role_assignments
         (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id, is_protected, protected_reason)
       values ($1::uuid, 'ADMIN', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'Seed protected Owner', $1::uuid, true, 'PROTECTED_OWNER_ADMIN')
       returning assignment_id`,
      [OWNER.app],
    );
    await setup.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [
      OWNER.app,
    ]);

    await setup.query("set role service_role");
    const adminAssignIds = new Map();
    for (const admin of [ADMIN_A, ADMIN_B, ADMIN_A2, ADMIN_B2, ADMIN_X, ADMIN_Y, ADMIN_Y2]) {
      const res = await setup.query(
        ASSIGN_SQL,
        assignArgs(OWNER, admin.app, "ADMIN", 1, `Seed ${admin.name}`),
      );
      adminAssignIds.set(admin.app, res.rows[0].data.assignment.assignment_id);
    }
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "wp5-observer");
    blocker = await connect(port, databaseName, "wp5-blocker");
    worker1 = await connect(port, databaseName, "wp5-worker-1");
    worker2 = await connect(port, databaseName, "wp5-worker-2");

    // -------------------------------------------------------------------------
    // Race 1a: Deterministic lock-hold duplicate global role assign on USER_DUP
    // -------------------------------------------------------------------------
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    await worker1.query(
      ASSIGN_SQL,
      assignArgs(OWNER, USER_DUP.app, "HR_OPERATOR", 1, "Dup assign worker 1"),
    );

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedDup = worker2.query(
      ASSIGN_SQL,
      assignArgs(ADMIN_X, USER_DUP.app, "HR_OPERATOR", 1, "Dup assign worker 2"),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("commit");
    await assert.rejects(
      blockedDup,
      (err) => err?.code !== "40P01" && err?.code === "PT409",
    );
    await worker2.query("rollback");

    assert.equal(
      (
        await observer.query(
          "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null",
          [USER_DUP.app],
        )
      ).rows[0].cnt,
      1,
    );

    // -------------------------------------------------------------------------
    // Race 1b: Parallel burst duplicate global role assign on USER_DUP2
    // -------------------------------------------------------------------------
    await worker1.query("set role service_role");
    await worker2.query("set role service_role");

    const dupBurst = await Promise.allSettled([
      worker1.query(
        ASSIGN_SQL,
        assignArgs(OWNER, USER_DUP2.app, "HR_OPERATOR", 1, "Burst dup 1"),
      ),
      worker2.query(
        ASSIGN_SQL,
        assignArgs(ADMIN_X, USER_DUP2.app, "HR_OPERATOR", 1, "Burst dup 2"),
      ),
    ]);
    assertNotDeadlockAndSingleWinner(dupBurst, "Race 1b parallel duplicate assign");
    assert.equal(
      (
        await observer.query(
          "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null",
          [USER_DUP2.app],
        )
      ).rows[0].cnt,
      1,
    );

    // -------------------------------------------------------------------------
    // Race 2a: Deterministic lock-order proof on swapped (actor, target) pairs
    //   ADMIN_A.app < ADMIN_B.app:
    //   blocker holds FOR UPDATE on ADMIN_A -> BOTH worker1 (A -> B assign)
    //   AND worker2 (B -> A disable) must block on ADMIN_A first (ascending UUID).
    // -------------------------------------------------------------------------
    await worker1.query("set role service_role");
    await worker2.query("set role service_role");

    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [ADMIN_A.app],
    );

    const swapW1 = worker1.query(
      ASSIGN_SQL,
      assignArgs(ADMIN_A, ADMIN_B.app, "HR_OPERATOR", 2, "Swap assign A->B"),
    );

    const swapW2 = worker2.query(DISABLE_SQL, [
      ADMIN_B.auth,
      ADMIN_B.app,
      ADMIN_A.app,
      2,
      "Swap disable B->A",
      `wp5-swap-dis-${keySeq++}`,
    ]);

    await waitUntilBlocked(observer, "wp5-worker-1");
    await waitUntilBlocked(observer, "wp5-worker-2");
    await blocker.query("rollback");

    const swapLockHoldResults = await Promise.allSettled([swapW1, swapW2]);
    for (const r of swapLockHoldResults) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01", "Race 2a must never deadlock (40P01)");
        assert.equal(r.reason?.code, "42501");
      }
    }
    assert.equal(swapLockHoldResults[1].status, "fulfilled", "disable(B->A) must commit in swap lock-hold");

    // Verify consistent post-race state
    const {
      rows: [{ enabled: aEnabled }],
    } = await observer.query(
      "select enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [ADMIN_A.app],
    );
    assert.equal(aEnabled, false, "ADMIN_B was still active ADMIN so disable(ADMIN_A) completes");

    // -------------------------------------------------------------------------
    // Race 2b: Parallel opposite-direction burst (ADMIN_A2 <-> ADMIN_B2)
    // -------------------------------------------------------------------------
    await worker1.query("set role service_role");
    await worker2.query("set role service_role");

    const swapBurst = await Promise.allSettled([
      worker1.query(
        ASSIGN_SQL,
        assignArgs(ADMIN_A2, ADMIN_B2.app, "HR_OPERATOR", 2, "Swap burst A2->B2"),
      ),
      worker2.query(DISABLE_SQL, [
        ADMIN_B2.auth,
        ADMIN_B2.app,
        ADMIN_A2.app,
        2,
        "Swap burst B2->A2",
        `wp5-swap-burst-dis-${keySeq++}`,
      ]),
    ]);
    for (const r of swapBurst) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01", "Race 2b must never deadlock (40P01)");
        assert.equal(r.reason?.code, "42501");
      }
    }
    assert.equal(swapBurst[1].status, "fulfilled", "disable(B2->A2) must commit in swap burst");

    // -------------------------------------------------------------------------
    // Race 3a: Lock-hold concurrent actor authority loss vs role assignment
    //   worker1: ADMIN_X revokes ADMIN_Y's ADMIN role (locks X then Y).
    //   worker2: ADMIN_Y assigns HR_OPERATOR to USER_Z (locks Y then Z -> blocks on Y).
    //   After worker1 commits, worker2 MUST re-check ADMIN_Y and reject 42501.
    // -------------------------------------------------------------------------
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    await worker1.query(
      REVOKE_SQL,
      revokeArgs(
        ADMIN_X,
        ADMIN_Y.app,
        adminAssignIds.get(ADMIN_Y.app),
        2,
        "Revoke ADMIN_Y authority lock-hold",
      ),
    );

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedAuthLoss = worker2.query(
      ASSIGN_SQL,
      assignArgs(ADMIN_Y, USER_Z.app, "HR_OPERATOR", 1, "Assign during authority loss"),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("commit");
    await assert.rejects(
      blockedAuthLoss,
      (err) => err?.code !== "40P01" && err?.code === "42501",
      "worker2 must fail closed with 42501 after losing ADMIN under lock",
    );
    await worker2.query("rollback");

    assert.equal(
      (
        await observer.query(
          "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null",
          [USER_Z.app],
        )
      ).rows[0].cnt,
      0,
    );

    // -------------------------------------------------------------------------
    // Race 3b: Parallel burst actor authority loss (ADMIN_Y2 vs USER_Z2)
    // -------------------------------------------------------------------------
    await worker1.query("set role service_role");
    await worker2.query("set role service_role");

    const authLossBurst = await Promise.allSettled([
      worker1.query(
        REVOKE_SQL,
        revokeArgs(
          ADMIN_X,
          ADMIN_Y2.app,
          adminAssignIds.get(ADMIN_Y2.app),
          2,
          "Revoke ADMIN_Y2 parallel",
        ),
      ),
      worker2.query(
        ASSIGN_SQL,
        assignArgs(ADMIN_Y2, USER_Z2.app, "HR_OPERATOR", 1, "Assign by ADMIN_Y2 parallel"),
      ),
    ]);
    assert.equal(authLossBurst[0].status, "fulfilled", "ADMIN_X revoke on ADMIN_Y2 must commit");
    if (authLossBurst[1].status === "rejected") {
      assert.notEqual(authLossBurst[1].reason?.code, "40P01");
      assert.equal(authLossBurst[1].reason?.code, "42501");
      assert.equal(
        (
          await observer.query(
            "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null",
            [USER_Z2.app],
          )
        ).rows[0].cnt,
        0,
      );
    }

    // -------------------------------------------------------------------------
    // Race 4: Parallel PROTECTED_OWNER_ADMIN revoke race (self-revoke + ADMIN_X)
    // -------------------------------------------------------------------------
    const {
      rows: [{ version: ownerVerBefore }],
    } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [OWNER.app],
    );

    const protectedRace = await Promise.allSettled([
      worker1.query(
        REVOKE_SQL,
        revokeArgs(OWNER, OWNER.app, ownerAssignId, ownerVerBefore, "Owner parallel self-revoke"),
      ),
      worker2.query(
        REVOKE_SQL,
        revokeArgs(ADMIN_X, OWNER.app, ownerAssignId, ownerVerBefore, "Admin parallel revoke Owner"),
      ),
    ]);
    for (const r of protectedRace) {
      assert.equal(r.status, "rejected", "PROTECTED_OWNER_ADMIN revoke must always reject");
      assert.notEqual(r.reason?.code, "40P01");
      assert.equal(r.reason?.code, "PT409");
      assert.match(r.reason?.message ?? "", /AUTHZ_PROTECTED_ASSIGNMENT/);
    }

    const {
      rows: [{ version: ownerVerAfter }],
    } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [OWNER.app],
    );
    assert.equal(ownerVerAfter, ownerVerBefore, "Protected reject must produce 0 version bump");

    const { rows: protectedRows } = await observer.query(
      "select assignment_id, is_protected, protected_reason, ended_at from public.authz_account_role_assignments where assignment_id = $1::uuid",
      [ownerAssignId],
    );
    assert.equal(protectedRows.length, 1);
    assert.equal(protectedRows[0].is_protected, true);
    assert.equal(protectedRows[0].protected_reason, "PROTECTED_OWNER_ADMIN");
    assert.equal(protectedRows[0].ended_at, null);

    const {
      rows: [{ cnt: ownerRevokeAudits }],
    } = await observer.query(
      "select count(*)::int as cnt from public.authz_audit_events where target_app_user_id = $1::uuid and operation_name = 'AUTHZ_GLOBAL_ROLE_REVOKED'",
      [OWNER.app],
    );
    assert.equal(ownerRevokeAudits, 0, "Protected reject must produce 0 partial audit writes");

    // -------------------------------------------------------------------------
    // Helper for Races 5 & 6: seed team + recruiter links + RECRUITER/HR_OPERATOR + disabled TL
    // -------------------------------------------------------------------------
    const setupTlRaceTeam = async (code, teamId, oldTl, newTl = null) => {
      await observer.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, $2, $3, true, 1)`,
        [teamId, code, `Race Team ${code}`],
      );
      const members = newTl ? [oldTl, newTl] : [oldTl];
      for (const m of members) {
        await observer.query(
          `insert into public.recruiters (recruiter_id, display_name, active, version)
           values ($1::uuid, $2, true, 1)`,
          [m.recruiter, m.name],
        );
        await observer.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
           values ($1::uuid, 'hrp', '2020-01-01', true)`,
          [m.recruiter],
        );
        await observer.query(
          `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
           values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
          [m.app, m.recruiter],
        );
        await observer.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2020-01-01', true)`,
          [m.recruiter, teamId],
        );
        for (const roleCode of ["RECRUITER", "HR_OPERATOR"]) {
          const {
            rows: [{ version: vCur }],
          } = await observer.query(
            "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
            [m.app],
          );
          await observer.query("set role service_role");
          try {
            await observer.query(ASSIGN_SQL, assignArgs(OWNER, m.app, roleCode, vCur, `Seed ${roleCode}`));
          } finally {
            await observer.query("reset role");
          }
        }
      }
      await observer.query("set role service_role");
      try {
        await observer.query(DESIGNATE_TL_SQL, [
          OWNER.auth,
          OWNER.app,
          teamId,
          oldTl.app,
          1,
          `Initial designate ${code}`,
          nextKey(),
        ]);
      } finally {
        await observer.query("reset role");
      }
      const {
        rows: [{ version: vOldBeforeDisable }],
      } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [oldTl.app],
      );
      await observer.query("set role service_role");
      try {
        await observer.query(DISABLE_SQL, [
          OWNER.auth,
          OWNER.app,
          oldTl.app,
          vOldBeforeDisable,
          `Disable ${code} TL`,
          nextKey(),
        ]);
      } finally {
        await observer.query("reset role");
      }
      const {
        rows: [{ version: oldVer }],
      } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [oldTl.app],
      );
      const {
        rows: [{ version: teamVer }],
      } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamId],
      );
      return { oldVer, teamVer };
    };

    const assertIndependentGrantsIntact = async (user, label) => {
      const { rows: grantRows } = await observer.query(
        "select capability from public.direct_entry_capability_grants where app_user_id = $1::uuid and is_current = true and valid_to is null order by capability",
        [user.app],
      );
      const caps = grantRows.map((r) => r.capability);
      for (const expected of ["audit_view", "document_view", "entry_own", "recruiter_master_manage", "team_master_manage"]) {
        assert.ok(caps.includes(expected), `${label}: independent grant ${expected} must remain intact`);
      }
      const { rows: scopeRows } = await observer.query(
        "select scope_kind, team_id from public.direct_entry_scope_grants where app_user_id = $1::uuid and is_current = true and valid_to is null",
        [user.app],
      );
      assert.ok(scopeRows.some((r) => r.scope_kind === "own"), `${label}: own scope must remain intact`);
      assert.ok(scopeRows.some((r) => r.scope_kind === "all"), `${label}: HR_OPERATOR all scope must remain intact`);
    };

    const settleTx = async (client, queryPromise) => {
      try {
        const res = await queryPromise;
        await client.query("commit");
        return { status: "fulfilled", value: res };
      } catch (err) {
        await client.query("rollback");
        return { status: "rejected", reason: err };
      }
    };

    // -------------------------------------------------------------------------
    // Race 5a: T0 exact pause-at-disabled-TL pattern (enable vs replace TL)
    // worker1 holds TL_5A_OLD FOR UPDATE -> worker2 calls designate_team_leader
    // (blocks cleanly on account lock, BEFORE teams) -> worker1 calls enable & commits
    // -------------------------------------------------------------------------
    await Promise.all([worker1.query("reset role"), worker2.query("reset role")]);
    const TEAM_5A = "59500000-0000-4000-8000-000000000051";
    const s5a = await setupTlRaceTeam("RACE_TL_5A", TEAM_5A, TL_5A_OLD, TL_5A_NEW);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [TL_5A_OLD.app],
    );
    const p5aReplace = settleTx(
      worker2,
      worker2.query(DESIGNATE_TL_SQL, [
        OWNER.auth,
        OWNER.app,
        TEAM_5A,
        TL_5A_NEW.app,
        s5a.teamVer,
        "Race 5a replace while enable paused",
        nextKey(),
      ]),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("set local role service_role");
    const p5aEnable = settleTx(
      worker1,
      worker1.query(ENABLE_SQL, [
        OWNER.auth,
        OWNER.app,
        TL_5A_OLD.app,
        s5a.oldVer,
        "Race 5a enable old TL",
        nextKey(),
      ]),
    );
    const [r5aEnable, r5aReplace] = await Promise.all([p5aEnable, p5aReplace]);
    assert.notEqual(r5aEnable.reason?.code, "40P01", "Race 5a enable must never deadlock (40P01)");
    assert.notEqual(r5aReplace.reason?.code, "40P01", "Race 5a replace must never deadlock (40P01)");
    assert.equal(r5aEnable.status, "fulfilled", `Race 5a enable failed: ${r5aEnable.reason?.message}`);
    assert.equal(r5aReplace.status, "fulfilled", `Race 5a replace failed: ${r5aReplace.reason?.message}`);

    const { rows: tla5a } = await observer.query(
      "select leader_app_user_id, is_current, valid_to, suspended_by_account_disable from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true",
      [TEAM_5A],
    );
    assert.equal(tla5a.length, 1);
    assert.equal(tla5a[0].leader_app_user_id, TL_5A_NEW.app, "Race 5a: incoming TL_5A_NEW must hold current TL");
    assert.equal(
      (
        await observer.query(
          "select count(*)::int as cnt from public.work_report_team_leader_capability_grants x join public.direct_entry_capability_grants g on g.grant_id = x.capability_grant_id where g.app_user_id = $1::uuid and g.is_current = true and g.valid_to is null",
          [TL_5A_OLD.app],
        )
      ).rows[0].cnt,
      0,
      "Race 5a: outgoing TL_5A_OLD must have 0 open WR TL grants",
    );
    await assertIndependentGrantsIntact(TL_5A_OLD, "Race 5a old TL");

    // -------------------------------------------------------------------------
    // Race 5b: Reverse replace-first + opposite UUID order (TL_5B_NEW < TL_5B_OLD)
    // worker1 runs designate_team_leader uncommitted -> worker2 calls enable (blocks)
    // -> worker1 commits -> enable must NEVER resurrect replaced TL
    // -------------------------------------------------------------------------
    const TEAM_5B = "59500000-0000-4000-8000-000000000052";
    const s5b = await setupTlRaceTeam("RACE_TL_5B", TEAM_5B, TL_5B_OLD, TL_5B_NEW);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(DESIGNATE_TL_SQL, [
      OWNER.auth,
      OWNER.app,
      TEAM_5B,
      TL_5B_NEW.app,
      s5b.teamVer,
      "Race 5b replace uncommitted",
      nextKey(),
    ]);
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const p5bEnable = settleTx(
      worker2,
      worker2.query(ENABLE_SQL, [
        OWNER.auth,
        OWNER.app,
        TL_5B_OLD.app,
        s5b.oldVer,
        "Race 5b enable after replace",
        nextKey(),
      ]),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("commit");
    const r5bEnable = await p5bEnable;
    assert.notEqual(r5bEnable.reason?.code, "40P01", "Race 5b enable must never deadlock (40P01)");
    if (r5bEnable.status === "rejected") {
      assert.equal(r5bEnable.reason?.code, "PT409", `Race 5b unexpected reject: ${r5bEnable.reason?.message}`);
      const {
        rows: [{ version: vAfterReplace }],
      } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [TL_5B_OLD.app],
      );
      await observer.query("set role service_role");
      await observer.query(ENABLE_SQL, [
        OWNER.auth,
        OWNER.app,
        TL_5B_OLD.app,
        vAfterReplace,
        "Race 5b enable after version refresh",
        nextKey(),
      ]);
      await observer.query("reset role");
    }
    const { rows: tla5b } = await observer.query(
      "select leader_app_user_id, is_current, valid_to, suspended_by_account_disable from public.direct_entry_team_leader_assignments where team_id = $1::uuid and leader_app_user_id = $2::uuid",
      [TEAM_5B, TL_5B_OLD.app],
    );
    assert.equal(tla5b.every((r) => !r.is_current && !r.suspended_by_account_disable && r.valid_to !== null), true, "Race 5b: replaced TL must NOT resurrect after enable");
    const { rows: cur5b } = await observer.query(
      "select leader_app_user_id from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true",
      [TEAM_5B],
    );
    assert.deepEqual(cur5b.map((r) => r.leader_app_user_id), [TL_5B_NEW.app]);
    assert.equal(
      (
        await observer.query(
          "select count(*)::int as cnt from public.work_report_team_leader_capability_grants x join public.direct_entry_capability_grants g on g.grant_id = x.capability_grant_id where g.app_user_id = $1::uuid and g.is_current = true and g.valid_to is null",
          [TL_5B_OLD.app],
        )
      ).rows[0].cnt,
      0,
      "Race 5b: outgoing TL_5B_OLD must have 0 open WR TL grants after enable",
    );
    await assertIndependentGrantsIntact(TL_5B_OLD, "Race 5b old TL");

    // -------------------------------------------------------------------------
    // Race 5c: True simultaneous enable vs replace collision behind blocker barrier
    // -------------------------------------------------------------------------
    const TEAM_5C = "59500000-0000-4000-8000-000000000053";
    const s5c = await setupTlRaceTeam("RACE_TL_5C", TEAM_5C, TL_5C_OLD, TL_5C_NEW);
    await blocker.query("begin");
    await blocker.query("select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update", [TL_5C_OLD.app]);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const p5cEnable = settleTx(
      worker1,
      worker1.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_5C_OLD.app, s5c.oldVer, "Race 5c enable", nextKey()]),
    );
    const p5cReplace = settleTx(
      worker2,
      worker2.query(DESIGNATE_TL_SQL, [OWNER.auth, OWNER.app, TEAM_5C, TL_5C_NEW.app, s5c.teamVer, "Race 5c replace", nextKey()]),
    );
    await Promise.all([waitUntilBlocked(observer, "wp5-worker-1"), waitUntilBlocked(observer, "wp5-worker-2")]);
    await blocker.query("rollback");
    const [r5cE, r5cR] = await Promise.all([p5cEnable, p5cReplace]);
    assert.notEqual(r5cE.reason?.code, "40P01", "Race 5c enable must never deadlock (40P01)");
    assert.notEqual(r5cR.reason?.code, "40P01", "Race 5c replace must never deadlock (40P01)");
    assert.equal(r5cR.status, "fulfilled", `Race 5c replace must succeed cleanly: ${r5cR.reason?.message}`);
    assert.deepEqual(
      (await observer.query("select leader_app_user_id from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true", [TEAM_5C])).rows.map((r) => r.leader_app_user_id),
      [TL_5C_NEW.app],
    );

    // -------------------------------------------------------------------------
    // Race 6a & 6b: enable_app_user vs revoke_team_leader (T0 pause + reverse revoke-first + simultaneous)
    // -------------------------------------------------------------------------
    const TEAM_6A = "59500000-0000-4000-8000-000000000061";
    const s6a = await setupTlRaceTeam("RACE_TL_6A", TEAM_6A, TL_6A_OLD);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query("select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update", [TL_6A_OLD.app]);
    const p6aRevoke = settleTx(
      worker2,
      worker2.query(REVOKE_TL_SQL, [OWNER.auth, OWNER.app, TEAM_6A, s6a.teamVer, "Race 6a revoke while enable paused", nextKey()]),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("set local role service_role");
    const p6aEnable = settleTx(
      worker1,
      worker1.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_6A_OLD.app, s6a.oldVer, "Race 6a enable old TL", nextKey()]),
    );
    const [r6aEnable, r6aRevoke] = await Promise.all([p6aEnable, p6aRevoke]);
    assert.notEqual(r6aEnable.reason?.code, "40P01", "Race 6a enable must never deadlock (40P01)");
    assert.notEqual(r6aRevoke.reason?.code, "40P01", "Race 6a revoke must never deadlock (40P01)");
    assert.equal(r6aEnable.status, "fulfilled", `Race 6a enable failed: ${r6aEnable.reason?.message}`);
    assert.equal(r6aRevoke.status, "fulfilled", `Race 6a revoke failed: ${r6aRevoke.reason?.message}`);
    assert.equal(
      (await observer.query("select count(*)::int as cnt from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true", [TEAM_6A])).rows[0].cnt,
      0,
    );
    assert.equal(
      (await observer.query("select count(*)::int as cnt from public.work_report_team_leader_capability_grants x join public.direct_entry_capability_grants g on g.grant_id = x.capability_grant_id where g.app_user_id = $1::uuid and g.is_current = true and g.valid_to is null", [TL_6A_OLD.app])).rows[0].cnt,
      0,
    );
    await assertIndependentGrantsIntact(TL_6A_OLD, "Race 6a revoked TL");

    // Race 6b: revoke commits BEFORE enable -> enable MUST NOT resurrect revoked TL
    const TEAM_6B = "59500000-0000-4000-8000-000000000062";
    const s6b = await setupTlRaceTeam("RACE_TL_6B", TEAM_6B, TL_6B_OLD);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(REVOKE_TL_SQL, [OWNER.auth, OWNER.app, TEAM_6B, s6b.teamVer, "Race 6b revoke uncommitted", nextKey()]);
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const p6bEnable = settleTx(
      worker2,
      worker2.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_6B_OLD.app, s6b.oldVer, "Race 6b enable after revoke", nextKey()]),
    );
    await waitUntilBlocked(observer, "wp5-worker-2");
    await worker1.query("commit");
    const r6bEnable = await p6bEnable;
    assert.notEqual(r6bEnable.reason?.code, "40P01", "Race 6b enable must never deadlock (40P01)");
    if (r6bEnable.status === "rejected") {
      assert.equal(r6bEnable.reason?.code, "PT409", `Race 6b unexpected reject: ${r6bEnable.reason?.message}`);
      const {
        rows: [{ version: v6bCur }],
      } = await observer.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_6B_OLD.app]);
      await observer.query("set role service_role");
      await observer.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_6B_OLD.app, v6bCur, "Race 6b enable refresh", nextKey()]);
      await observer.query("reset role");
    }
    const { rows: tla6b } = await observer.query(
      "select is_current, valid_to, suspended_by_account_disable from public.direct_entry_team_leader_assignments where team_id = $1::uuid and leader_app_user_id = $2::uuid",
      [TEAM_6B, TL_6B_OLD.app],
    );
    assert.equal(tla6b.every((r) => !r.is_current && !r.suspended_by_account_disable && r.valid_to !== null), true, "Race 6b: revoked TL must NOT resurrect on enable");
    assert.equal(
      (await observer.query("select count(*)::int as cnt from public.direct_entry_scope_grants where app_user_id = $1::uuid and scope_kind = 'team' and is_current = true and valid_to is null", [TL_6B_OLD.app])).rows[0].cnt,
      0,
      "Race 6b: revoked TL must have 0 open CONTEXT_TEAM scopes after enable",
    );
    await assertIndependentGrantsIntact(TL_6B_OLD, "Race 6b revoked TL");

    // Race 6c: Simultaneous enable vs revoke behind blocker barrier
    const TEAM_6C = "59500000-0000-4000-8000-000000000063";
    const s6c = await setupTlRaceTeam("RACE_TL_6C", TEAM_6C, TL_6C_OLD);
    await blocker.query("begin");
    await blocker.query("select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update", [TL_6C_OLD.app]);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const p6cEnable = settleTx(
      worker1,
      worker1.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_6C_OLD.app, s6c.oldVer, "Race 6c enable", nextKey()]),
    );
    const p6cRevoke = settleTx(
      worker2,
      worker2.query(REVOKE_TL_SQL, [OWNER.auth, OWNER.app, TEAM_6C, s6c.teamVer, "Race 6c revoke", nextKey()]),
    );
    await Promise.all([waitUntilBlocked(observer, "wp5-worker-1"), waitUntilBlocked(observer, "wp5-worker-2")]);
    await blocker.query("rollback");
    const [r6cE, r6cR] = await Promise.all([p6cEnable, p6cRevoke]);
    assert.notEqual(r6cE.reason?.code, "40P01", "Race 6c enable must never deadlock (40P01)");
    assert.notEqual(r6cR.reason?.code, "40P01", "Race 6c revoke must never deadlock (40P01)");
    assert.equal(r6cR.status, "fulfilled", `Race 6c revoke must succeed cleanly: ${r6cR.reason?.message}`);
    assert.equal(
      (await observer.query("select count(*)::int as cnt from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true", [TEAM_6C])).rows[0].cnt,
      0,
    );
  } finally {
    await Promise.allSettled(
      [worker1, worker2, blocker, observer, setup, adminClient]
        .filter(Boolean)
        .map((client) => client.end()),
    );
    if (serverStarted && pgCtl) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
