/**
 * WP5B-2 — Real PostgreSQL Concurrency Regression Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`
 * and imports zero `"server-only"` or `.ts` modules) against an isolated local
 * PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Proves under `SET ROLE service_role` / transaction barriers with ZERO `40P01` deadlocks:
 *   1. Concurrent `runWp5Cutover(..., { mode: "apply" })` race:
 *      1 wins `APPLIED`, 1 returns `ALREADY_APPLIED_NOOP`, 0 duplicate role/exception rows.
 *   2. Concurrent role grant/revoke race:
 *      same `Idempotency-Key` replays identical response before OCC;
 *      distinct `Idempotency-Key` yields 1 winner + 1 `PT409` (`VERSION_CONFLICT`).
 *   3. Concurrent actor authority loss (`revoke ADMIN` and `disable` actor racing
 *      `direct_entry_authz_assign_global_role_admin`):
 *      serialized via row locks on `direct_entry_app_users`, 0 `40P01`, loser returns `42501`.
 *   4. R1 lock-order regression under `HR_OPERATOR` (`team_master_manage @ ALL`, non-`ADMIN`):
 *      `enable_app_user` vs `designate_team_leader` (replace TL) and `revoke_team_leader`:
 *      0 `40P01` deadlocks across multiple rounds, 0 resurrected TL authority.
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
import { WP5_ROLE_CATALOG } from "./lib/wp5-cutover-manifest.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "19600000-0000-4000-8000-000000000001",
  app: "29600000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "19600000-0000-4000-8000-000000000002",
  app: "29600000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "19600000-0000-4000-8000-000000000003",
  app: "29600000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "19600000-0000-4000-8000-000000000004",
  app: "29600000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "19600000-0000-4000-8000-000000000005",
  app: "29600000-0000-4000-8000-000000000005",
  email: "hr.op@hrpartner.vn",
  name: "HR Operator",
};
const STAFF_REPLAY = {
  auth: "19600000-0000-4000-8000-000000000006",
  app: "29600000-0000-4000-8000-000000000006",
  email: "staff.replay@hrpartner.vn",
  name: "Staff Idem Replay",
};
const STAFF_OCC = {
  auth: "19600000-0000-4000-8000-000000000007",
  app: "29600000-0000-4000-8000-000000000007",
  email: "staff.occ@hrpartner.vn",
  name: "Staff OCC Race",
};
const STAFF_AUTH_LOSS = {
  auth: "19600000-0000-4000-8000-000000000008",
  app: "29600000-0000-4000-8000-000000000008",
  email: "staff.loss@hrpartner.vn",
  name: "Staff Authority Loss",
};
const TL_R1_A_OLD = {
  auth: "19600000-0000-4000-8000-000000000021",
  app: "29600000-0000-4000-8000-000000000021",
  recruiter: "39600000-0000-4000-8000-000000000021",
  email: "tl.r1a.old@hrpartner.vn",
  name: "TL R1A Old",
};
const TL_R1_A_NEW = {
  auth: "19600000-0000-4000-8000-000000000022",
  app: "29600000-0000-4000-8000-000000000022",
  recruiter: "39600000-0000-4000-8000-000000000022",
  email: "tl.r1a.new@hrpartner.vn",
  name: "TL R1A New",
};
const TL_R1_B_OLD = {
  auth: "19600000-0000-4000-8000-000000000023",
  app: "29600000-0000-4000-8000-000000000023",
  recruiter: "39600000-0000-4000-8000-000000000023",
  email: "tl.r1b.old@hrpartner.vn",
  name: "TL R1B Old",
};
const TL_R1_C_ITERS = [1, 2, 3].map((iter) => ({
  auth: `19600000-0000-4000-8000-00000000003${iter}`,
  app: `29600000-0000-4000-8000-00000000003${iter}`,
  recruiter: `39600000-0000-4000-8000-00000000003${iter}`,
  email: `tl.r1c${iter}.old@hrpartner.vn`,
  name: `TL R1C${iter} Old`,
}));
const RACE_D10_REC = {
  auth: "19600000-0000-4000-8000-000000000041",
  app: "29600000-0000-4000-8000-000000000041",
  recruiter: "39600000-0000-4000-8000-000000000041",
  email: "race.d10.rec@hrpartner.vn",
  name: "Race D10 Recruiter",
};
const RACE_TL_CAND = {
  auth: "19600000-0000-4000-8000-000000000042",
  app: "29600000-0000-4000-8000-000000000042",
  recruiter: "39600000-0000-4000-8000-000000000042",
  email: "race.tl.cand@hrpartner.vn",
  name: "Race TL Candidate",
};
const ZZZ_LOCK_ANCHOR = {
  auth: "19600000-0000-4000-8000-0000000000ff",
  app: "ffffffff-0000-4000-8000-0000000000ff",
  email: "zzz.lock.anchor@hrpartner.vn",
  name: "ZZZ Lock Anchor",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  HR_OP,
  STAFF_REPLAY,
  STAFF_OCC,
  STAFF_AUTH_LOSS,
  TL_R1_A_OLD,
  TL_R1_A_NEW,
  TL_R1_B_OLD,
  ...TL_R1_C_ITERS,
  RACE_D10_REC,
  RACE_TL_CAND,
  ZZZ_LOCK_ANCHOR,
];

let keySeq = 1;
function nextUuidKey() {
  return `99600000-0000-4000-8000-${(keySeq++).toString(16).padStart(12, "0")}`;
}

function sha256Hex(payload) {
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

async function connect(port, database = "postgres", applicationName = "wp5b2-race") {
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
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(names.includes(WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME));
  assert.ok(names.includes("20261118160000_wp5b2_role_access_cutover.sql"));
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
const BEGIN_OP_SQL =
  "select public.direct_entry_account_operation_begin($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8) as data";
const CLAIM_OP_SQL =
  "select public.direct_entry_account_operation_claim($1::uuid, $2::uuid, $3::uuid, $4::uuid) as data";
const FINALIZE_CREATE_SQL =
  "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as data";

test("WP5B-2 real PostgreSQL concurrency: cutover race, idempotency vs OCC, concurrent ADMIN revoke authority loss, and HR_OPERATOR R1 TL lock-order", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wp5b2-cutover-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `wp5b2_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
  let blocker;
  let worker1;
  let worker2;
  let worker3;
  let worker4;

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

    setup = await connect(port, databaseName, "wp5b2-setup");
    await applyMigrations(setup);

    const legacyRecruiterCaps = WP5_ROLE_CATALOG.RECRUITER.capabilities.map((c) => c.capability);
    for (const user of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        user.auth,
        user.email,
      ]);
      await setup.query(
        `insert into public.direct_entry_app_users
           (app_user_id, auth_subject, display_name, account_type, enabled, authz_managed, version)
         values ($1::uuid, $2::uuid, $3, 'NORMAL', true, false, 1)`,
        [user.app, user.auth, user.name],
      );
      if (user.recruiter) {
        await setup.query(
          `insert into public.recruiters (recruiter_id, display_name, active, version)
           values ($1::uuid, $2, true, 1)`,
          [user.recruiter, user.name],
        );
        await setup.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
           values ($1::uuid, 'hrp', '2020-01-01', true)`,
          [user.recruiter],
        );
        await setup.query(
          `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
           values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
          [user.app, user.recruiter],
        );
        for (const cap of legacyRecruiterCaps) {
          await setup.query(
            `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
             values ($1::uuid, $2, '2020-01-01', true)`,
            [user.app, cap],
          );
        }
        await setup.query(
          `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
           values ($1::uuid, 'own', '2020-01-01', true)`,
          [user.app],
        );
      }
    }

    // Seed initial admin & HR_OPERATOR legacy grants for realistic cutover manifest
    for (const admin of [OWNER, LIENVU, NGATTT]) {
      for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage", "entry_own"]) {
        await setup.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2020-01-01', true)`,
          [admin.app, cap],
        );
      }
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2020-01-01', true)`,
        [admin.app],
      );
    }
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2020-01-01', true)`,
      [LUANPT.app],
    );
    for (const cap of WP5_ROLE_CATALOG.HR_OPERATOR.capabilities.map((c) => c.capability)) {
      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2020-01-01', true)`,
        [HR_OP.app, cap],
      );
    }
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2020-01-01', true)`,
      [HR_OP.app],
    );

    observer = await connect(port, databaseName, "wp5b2-observer");
    blocker = await connect(port, databaseName, "wp5b2-blocker");
    worker1 = await connect(port, databaseName, "wp5b2-w1");
    worker2 = await connect(port, databaseName, "wp5b2-w2");
    worker3 = await connect(port, databaseName, "wp5b2-w3");
    worker4 = await connect(port, databaseName, "wp5b2-w4");

    const asSettled = (promise) =>
      promise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );

    // -------------------------------------------------------------------------
    // Pre-cutover R1a/R1b: Drift BEFORE direct_entry_app_users lock must abort
    // cleanly with CUTOVER_FINGERPRINT_MISMATCH and NEVER clobber restored grants
    // -------------------------------------------------------------------------
    const TEAM_PRE_RACE = "59600000-0000-4000-8000-000000000009";
    await observer.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'WP5B2_PRE_RACE', 'Pre-Cutover Drift Team', true, 1)`,
      [TEAM_PRE_RACE],
    );
    await observer.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2020-01-01', true)`,
      [RACE_TL_CAND.recruiter, TEAM_PRE_RACE],
    );

    // Suspend RACE_D10_REC cleanly via WP5B-1 D10 disable before generating plan
    await worker2.query("set role service_role");
    await worker2.query(DISABLE_SQL, [
      NGATTT.auth,
      NGATTT.app,
      RACE_D10_REC.app,
      1,
      "Pre-cutover D10 suspend for R1a",
      `r1a-dis-${keySeq++}`,
    ]);
    await worker2.query("reset role");

    // R1a: Stale read-only plan -> cutover starts -> pauses right before locking RACE_D10_REC ->
    // 2nd connection commits enable_app_user (restoring 7 grants) -> cutover wakes up ->
    // MUST abort with CUTOVER_FINGERPRINT_MISMATCH and preserve all 7 restored grants!
    const stalePlanR1a = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(stalePlanR1a.action_diff.unexpected_diff_count, 0);

    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [OWNER.app],
    );
    const r1aCutPromise = asSettled(
      runWp5Cutover(worker1, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: stalePlanR1a.manifest_fingerprint,
      }),
    );
    await waitUntilBlocked(observer, "wp5b2-w1");

    await worker2.query("set role service_role");
    await worker2.query(ENABLE_SQL, [
      NGATTT.auth,
      NGATTT.app,
      RACE_D10_REC.app,
      2,
      "R1a concurrent enable right before cutover app_user lock",
      `r1a-en-${keySeq++}`,
    ]);
    await worker2.query("reset role");

    const { rows: [restoredMidRace] } = await observer.query(
      `select u.enabled,
              pg_catalog.jsonb_array_length(public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)) as grant_cnt
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
      [RACE_D10_REC.app],
    );
    assert.deepEqual(restoredMidRace, { enabled: true, grant_cnt: 7 });

    await blocker.query("rollback");
    const r1aCutRes = await r1aCutPromise;
    assert.equal(r1aCutRes.status, "rejected", "R1a cutover with stale fingerprint must abort");
    assert.notEqual(r1aCutRes.reason?.code, "40P01");
    assert.match(String(r1aCutRes.reason?.message), /CUTOVER_FINGERPRINT_MISMATCH/);

    const { rows: [afterR1aUser] } = await observer.query(
      `select u.enabled,
              u.authz_managed,
              pg_catalog.jsonb_array_length(public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)) as grant_cnt,
              (select cutover_ready from public.authz_system_state where singleton_id = true) as cutover_ready
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
      [RACE_D10_REC.app],
    );
    assert.deepEqual(afterR1aUser, {
      enabled: true,
      authz_managed: false,
      grant_cnt: 7,
      cutover_ready: false,
    });

    // R1b-1 (Disable direction): read-only plan sees enabled=true -> 2nd connection commits disable ->
    // cutover MUST abort with CUTOVER_FINGERPRINT_MISMATCH and keep D10 suspension intact.
    const stalePlanR1bDisable = await runWp5Cutover(setup, { mode: "read-only-plan" });
    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [OWNER.app],
    );
    const r1bDisableCut = asSettled(
      runWp5Cutover(worker1, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: stalePlanR1bDisable.manifest_fingerprint,
      }),
    );
    await waitUntilBlocked(observer, "wp5b2-w1");

    await worker2.query("set role service_role");
    await worker2.query(DISABLE_SQL, [
      NGATTT.auth,
      NGATTT.app,
      RACE_D10_REC.app,
      3,
      "R1b concurrent disable right before cutover app_user lock",
      `r1b-dis-${keySeq++}`,
    ]);
    await worker2.query("reset role");
    await blocker.query("rollback");

    const r1bDisableRes = await r1bDisableCut;
    assert.equal(r1bDisableRes.status, "rejected");
    assert.notEqual(r1bDisableRes.reason?.code, "40P01");
    assert.match(String(r1bDisableRes.reason?.message), /CUTOVER_FINGERPRINT_MISMATCH/);

    // R1b-2 (Assignment source direction): read-only plan -> 2nd connection designates TL ->
    // cutover MUST abort with CUTOVER_FINGERPRINT_MISMATCH and rollback cleanly.
    const stalePlanR1bTl = await runWp5Cutover(setup, { mode: "read-only-plan" });
    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [OWNER.app],
    );
    const r1bTlCut = asSettled(
      runWp5Cutover(worker1, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: stalePlanR1bTl.manifest_fingerprint,
      }),
    );
    await waitUntilBlocked(observer, "wp5b2-w1");

    await worker2.query("set role service_role");
    await worker2.query(DESIGNATE_TL_SQL, [
      NGATTT.auth,
      NGATTT.app,
      TEAM_PRE_RACE,
      RACE_TL_CAND.app,
      1,
      "R1b concurrent TL designate before cutover app_user lock",
      `r1b-tl-${keySeq++}`,
    ]);
    await worker2.query("reset role");
    await blocker.query("rollback");

    const r1bTlRes = await r1bTlCut;
    assert.equal(r1bTlRes.status, "rejected");
    assert.notEqual(r1bTlRes.reason?.code, "40P01");
    assert.match(String(r1bTlRes.reason?.message), /CUTOVER_FINGERPRINT_MISMATCH/);

    // -------------------------------------------------------------------------
    // R3 (Finalize-first -> Cutover-second behind intent barrier):
    //   Exact T0 deadlock regression — finalize_create acquires authz_system_state FOR SHARE
    //   BEFORE idempotency INSERT (FK KEY SHARE on direct_entry_app_users) and BEFORE intent lock.
    //   Cutover waits cleanly on authz_system_state FOR UPDATE -> 0 40P01 deadlocks!
    //   Once finalize commits pre-cutover, cutover wakes up, detects new account, and aborts
    //   stale plan safely with CUTOVER_FINGERPRINT_MISMATCH.
    // -------------------------------------------------------------------------
    const raceFinFirstAuth = "19600000-0000-4000-8000-0000000000fd";
    await setup.query("insert into auth.users (id, email) values ($1::uuid, 'race.finfirst@hrpartner.vn')", [
      raceFinFirstAuth,
    ]);
    await setup.query("set role service_role");
    const { rows: [{ data: r3Began }] } = await setup.query(BEGIN_OP_SQL, [
      OWNER.auth,
      OWNER.app,
      "CREATE_ACCOUNT",
      "race.finfirst",
      "Race Finalize First Account",
      null,
      "R3 finalize before cutover deadlock regression",
      `r3-begin-${keySeq++}`,
    ]);
    await setup.query(CLAIM_OP_SQL, [OWNER.auth, OWNER.app, r3Began.intent_id, r3Began.intent_token]);
    await setup.query("reset role");

    const stalePlanR3 = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(stalePlanR3.action_diff.unexpected_diff_count, 0);

    await blocker.query("begin");
    await blocker.query(
      "select intent_id from public.direct_entry_account_operation_intents where intent_id = $1::uuid for update",
      [r3Began.intent_id],
    );

    await worker3.query("set role service_role");
    const r3FinalizeP = asSettled(
      worker3.query(FINALIZE_CREATE_SQL, [
        OWNER.auth,
        OWNER.app,
        r3Began.intent_id,
        r3Began.intent_token,
        raceFinFirstAuth,
        `r3-fin-${keySeq++}`,
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w3");

    const r3CutoverP = asSettled(
      runWp5Cutover(worker2, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: stalePlanR3.manifest_fingerprint,
      }),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");

    await blocker.query("rollback");
    const [r3FinalizeRes, r3CutoverRes] = await Promise.all([r3FinalizeP, r3CutoverP]);
    await worker3.query("reset role");

    assert.notEqual(r3FinalizeRes.reason?.code, "40P01", "R3 finalize must not deadlock");
    assert.equal(r3FinalizeRes.status, "fulfilled", `R3 finalize failed: ${r3FinalizeRes.reason?.message}`);
    assert.equal(r3FinalizeRes.value.rows[0].data.intent_state, "APPLIED");
    const r3FinFirstAccountId = r3FinalizeRes.value.rows[0].data.app_user_id;

    assert.notEqual(r3CutoverRes.reason?.code, "40P01", "R3 cutover must not deadlock with finalize_create");
    assert.equal(r3CutoverRes.status, "rejected", "R3 cutover must reject stale fingerprint after new account commit");
    assert.match(String(r3CutoverRes.reason?.message), /CUTOVER_FINGERPRINT_MISMATCH/);

    const { rows: [preCutFinFirst] } = await observer.query(
      `select u.enabled, u.authz_managed, u.version,
              (select cutover_ready from public.authz_system_state where singleton_id = true) as cutover_ready
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
      [r3FinFirstAccountId],
    );
    assert.deepEqual(preCutFinFirst, {
      enabled: true,
      authz_managed: false,
      version: 1,
      cutover_ready: false,
    });

    // -------------------------------------------------------------------------
    // Race 1 (Combined Cutover Barrier: concurrent apply + R1c reverse enable + R2 cutover-first -> finalize-second)
    //   - prepare standalone CREATE_ACCOUNT intent before barrier
    //   - blocker locks ZZZ_LOCK_ANCHOR.app -> worker1 holds authz_system_state FOR UPDATE &
    //     locks OWNER..RACE_TL_CAND FOR UPDATE, pausing right at ZZZ_LOCK_ANCHOR.app
    //   - worker2 races runWp5Cutover, worker3 races enable_app_user on RACE_D10_REC,
    //     worker4 races finalize_create -> ALL serialize cleanly with 0 deadlocks!
    // -------------------------------------------------------------------------
    const raceNewAuth = "19600000-0000-4000-8000-0000000000fe";
    await setup.query("insert into auth.users (id, email) values ($1::uuid, 'race.newacct@hrpartner.vn')", [
      raceNewAuth,
    ]);
    await setup.query("set role service_role");
    const { rows: [{ data: r2Began }] } = await setup.query(BEGIN_OP_SQL, [
      OWNER.auth,
      OWNER.app,
      "CREATE_ACCOUNT",
      "race.newacct",
      "Race Standalone Account",
      null,
      "R2 concurrent finalize_create during cutover",
      `r2-begin-${keySeq++}`,
    ]);
    await setup.query(CLAIM_OP_SQL, [OWNER.auth, OWNER.app, r2Began.intent_id, r2Began.intent_token]);
    await setup.query("reset role");

    const roPlan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(roPlan.action_diff.unexpected_diff_count, 0);
    const expectedFingerprint = roPlan.manifest_fingerprint;

    const { rows: [{ version: r1cVer }] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [RACE_D10_REC.app],
    );

    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [ZZZ_LOCK_ANCHOR.app],
    );

    const cutP1 = runWp5Cutover(worker1, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint,
    });
    await waitUntilBlocked(observer, "wp5b2-w1");

    const cutP2 = runWp5Cutover(worker2, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint,
    });
    await worker3.query("set role service_role");
    const r1cEnableP = asSettled(
      worker3.query(ENABLE_SQL, [
        NGATTT.auth,
        NGATTT.app,
        RACE_D10_REC.app,
        r1cVer,
        "R1c reverse race enable after cutover locked app_user",
        `r1c-en-${keySeq++}`,
      ]),
    );
    await worker4.query("set role service_role");
    const r2FinalizeP = asSettled(
      worker4.query(FINALIZE_CREATE_SQL, [
        OWNER.auth,
        OWNER.app,
        r2Began.intent_id,
        r2Began.intent_token,
        raceNewAuth,
        `r2-fin-${keySeq++}`,
      ]),
    );

    await Promise.all([
      waitUntilBlocked(observer, "wp5b2-w2"),
      waitUntilBlocked(observer, "wp5b2-w3"),
      waitUntilBlocked(observer, "wp5b2-w4"),
    ]);
    await blocker.query("rollback");

    const [cutR1, cutR2, r1cEnableRes, r2FinalizeRes] = await Promise.all([
      cutP1,
      cutP2,
      r1cEnableP,
      r2FinalizeP,
    ]);
    await Promise.all([worker3.query("reset role"), worker4.query("reset role")]);

    assert.deepEqual(
      [cutR1.status, cutR2.status].sort(),
      ["ALREADY_APPLIED_NOOP", "APPLIED"],
      "Concurrent cutover apply must produce strictly one APPLIED and one ALREADY_APPLIED_NOOP",
    );
    assert.notEqual(r1cEnableRes.reason?.code, "40P01");
    assert.equal(r1cEnableRes.status, "fulfilled", `R1c enable failed: ${r1cEnableRes.reason?.message}`);
    assert.notEqual(r2FinalizeRes.reason?.code, "40P01");
    assert.equal(r2FinalizeRes.status, "fulfilled", `R2 finalize failed: ${r2FinalizeRes.reason?.message}`);

    const { rows: [postR1c] } = await observer.query(
      `select u.enabled,
              u.authz_managed,
              pg_catalog.jsonb_array_length(public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)) as grant_cnt
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
      [RACE_D10_REC.app],
    );
    assert.deepEqual(
      postR1c,
      { enabled: true, authz_managed: true, grant_cnt: 7 },
      "R1c reverse race must preserve D10 roles and restore all 7 grants",
    );

    const r2AccountId = r2FinalizeRes.value.rows[0].data.app_user_id;
    assert.equal(r2FinalizeRes.value.rows[0].data.intent_state, "APPLIED");
    const { rows: [postR2Acct] } = await observer.query(
      `select u.enabled,
              u.authz_managed,
              u.account_type,
              pg_catalog.jsonb_array_length(public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)) as grant_cnt
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
      [r2AccountId],
    );
    assert.deepEqual(postR2Acct, {
      enabled: true,
      authz_managed: true,
      account_type: "NORMAL",
      grant_cnt: 0,
    });
    const { rows: postR2Roles } = await observer.query(
      "select role_code from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null",
      [r2AccountId],
    );
    assert.deepEqual(postR2Roles, [{ role_code: "EMPLOYEE_BASE" }]);

    const { rows: [postR3FinFirst] } = await observer.query(
      "select enabled, authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid",
      [r3FinFirstAccountId],
    );
    assert.deepEqual(postR3FinFirst, { enabled: true, authz_managed: true });
    const { rows: postR3Roles } = await observer.query(
      "select role_code from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null",
      [r3FinFirstAccountId],
    );
    assert.deepEqual(postR3Roles, [{ role_code: "EMPLOYEE_BASE" }]);

    const postRaceCutoverNoop = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint,
    });
    assert.equal(postRaceCutoverNoop.status, "ALREADY_APPLIED_NOOP");

    const { rows: [{ cnt: auditApplies }] } = await observer.query(
      "select count(*)::int as cnt from public.authz_audit_events where operation_name = 'WP5B2_CUTOVER_APPLY'",
    );
    assert.equal(auditApplies, 1, "Concurrent cutover must emit strictly 1 WP5B2_CUTOVER_APPLY audit row");

    const { rows: [{ cnt: dupOpenRoles }] } = await observer.query(
      `select count(*)::int as cnt from (
         select app_user_id, role_code
           from public.authz_account_role_assignments
          where ended_at is null
          group by app_user_id, role_code
         having count(*) > 1
       ) dup`,
    );
    assert.equal(dupOpenRoles, 0, "Zero duplicate open global role assignments allowed");

    // -------------------------------------------------------------------------
    // Race 2: Same Idempotency-Key replay vs distinct Idempotency-Key OCC conflict
    // -------------------------------------------------------------------------
    const replayIdem = nextUuidKey();
    const replayHash = sha256Hex({ race: "idem-replay", target: STAFF_REPLAY.app });
    const replayArgs = [OWNER.auth, OWNER.app, STAFF_REPLAY.app, "HR_OPERATOR", 1, "Concurrent idem replay", replayIdem, replayHash];

    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [STAFF_REPLAY.app],
    );
    await Promise.all([worker1.query("set role service_role"), worker2.query("set role service_role")]);
    const rp1 = worker1.query(ASSIGN_SQL, replayArgs);
    const rp2 = worker2.query(ASSIGN_SQL, replayArgs);
    await Promise.all([waitUntilBlocked(observer, "wp5b2-w1"), waitUntilBlocked(observer, "wp5b2-w2")]);
    await blocker.query("rollback");

    const [rr1, rr2] = await Promise.all([rp1, rp2]);
    assert.equal(rr1.rows[0].data.assignment_id, rr2.rows[0].data.assignment_id);
    assert.deepEqual(
      [Boolean(rr1.rows[0].data.replayed), Boolean(rr2.rows[0].data.replayed)].sort(),
      [false, true],
    );

    const k1 = nextUuidKey();
    const k2 = nextUuidKey();
    await blocker.query("begin");
    await blocker.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [STAFF_OCC.app],
    );
    const occ1 = worker1.query(ASSIGN_SQL, [
      OWNER.auth,
      OWNER.app,
      STAFF_OCC.app,
      "HR_OPERATOR",
      1,
      "OCC race key 1",
      k1,
      sha256Hex({ k: k1 }),
    ]);
    const occ2 = worker2.query(ASSIGN_SQL, [
      OWNER.auth,
      OWNER.app,
      STAFF_OCC.app,
      "RECRUITER",
      1,
      "OCC race key 2",
      k2,
      sha256Hex({ k: k2 }),
    ]);
    await Promise.all([waitUntilBlocked(observer, "wp5b2-w1"), waitUntilBlocked(observer, "wp5b2-w2")]);
    await blocker.query("rollback");

    const occSettled = await Promise.allSettled([occ1, occ2]);
    const occWinners = occSettled.filter((r) => r.status === "fulfilled");
    const occLosers = occSettled.filter((r) => r.status === "rejected");
    assert.equal(occWinners.length, 1);
    assert.equal(occLosers.length, 1);
    assert.notEqual(occLosers[0].reason?.code, "40P01");
    assert.equal(occLosers[0].reason?.code, "PT409");

    // -------------------------------------------------------------------------
    // Race 3a: Concurrent authority loss: OWNER revokes NGATTT ADMIN vs NGATTT calling assign_global_role_admin
    // -------------------------------------------------------------------------
    await Promise.all([worker1.query("reset role"), worker2.query("reset role")]);
    const { rows: [ngaAssign] } = await observer.query(
      `select a.assignment_id, u.version
         from public.authz_account_role_assignments a
         join public.direct_entry_app_users u on u.app_user_id = a.app_user_id
        where a.app_user_id = $1::uuid and a.role_code = 'ADMIN' and a.ended_at is null`,
      [NGATTT.app],
    );

    const settleTx = async (client, promise) => {
      try {
        const res = await promise;
        await client.query("commit");
        return { status: "fulfilled", value: res };
      } catch (err) {
        await client.query("rollback").catch(() => {});
        return { status: "rejected", reason: err };
      }
    };

    // Hold revoke uncommitted while NGATTT's assign blocks on NGATTT row lock -> revoke commits -> assign sees authority loss -> 42501!
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(REVOKE_SQL, [
      OWNER.auth,
      OWNER.app,
      NGATTT.app,
      ngaAssign.assignment_id,
      ngaAssign.version,
      "Revoke NGATTT during concurrent assign",
      nextUuidKey(),
      sha256Hex({ op: "revoke-nga-admin" }),
    ]);

    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const revokeRacePromise = settleTx(
      worker2,
      worker2.query(ASSIGN_SQL, [
        NGATTT.auth,
        NGATTT.app,
        STAFF_AUTH_LOSS.app,
        "HR_OPERATOR",
        1,
        "NGATTT assign during ADMIN revoke race",
        nextUuidKey(),
        sha256Hex({ op: "nga-assign-during-revoke" }),
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");
    await worker1.query("commit");

    const revokeRaceResult = await revokeRacePromise;
    assert.equal(revokeRaceResult.status, "rejected");
    assert.notEqual(revokeRaceResult.reason?.code, "40P01");
    assert.equal(
      revokeRaceResult.reason?.code,
      "42501",
      "NGATTT losing ADMIN under lock must cause concurrent assign_global_role_admin to reject with 42501",
    );
    const { rows: [{ cnt: grantedCount }] } = await observer.query(
      "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'HR_OPERATOR' and ended_at is null",
      [STAFF_AUTH_LOSS.app],
    );
    assert.equal(grantedCount, 0, "Denied concurrent assign must not grant HR_OPERATOR");

    // -------------------------------------------------------------------------
    // Race 3b: Concurrent disable of LIENVU vs LIENVU calling assign_global_role_admin
    // -------------------------------------------------------------------------
    await Promise.all([worker1.query("reset role"), worker2.query("reset role")]);
    const { rows: [{ version: lienVer }] } = await observer.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [LIENVU.app],
    );
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(DISABLE_SQL, [
      OWNER.auth,
      OWNER.app,
      LIENVU.app,
      lienVer,
      "Disable LIENVU during assign race",
      `dis-lien-${keySeq++}`,
    ]);
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const assignLossPromise = settleTx(
      worker2,
      worker2.query(ASSIGN_SQL, [
        LIENVU.auth,
        LIENVU.app,
        STAFF_AUTH_LOSS.app,
        "HR_OPERATOR",
        1,
        "Assign during disable race",
        nextUuidKey(),
        sha256Hex({ loss: STAFF_AUTH_LOSS.app }),
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");
    await worker1.query("commit");

    const assignLossRes = await assignLossPromise;
    assert.equal(assignLossRes.status, "rejected");
    assert.notEqual(assignLossRes.reason?.code, "40P01");
    assert.equal(assignLossRes.reason?.code, "42501");

    // -------------------------------------------------------------------------
    // Race 4: R1 lock-order regression under HR_OPERATOR (non-ADMIN, team_master_manage @ ALL)
    //   enable_app_user (by OWNER) vs designate_team_leader / revoke_team_leader (by HR_OP)
    // -------------------------------------------------------------------------
    const setupTeamForHrOpRace = async (teamId, code, oldTl, newTl = null) => {
      await observer.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, $2, $3, true, 1)`,
        [teamId, code, `HR_OP Race Team ${code}`],
      );
      const members = newTl ? [oldTl, newTl] : [oldTl];
      for (const m of members) {
        await observer.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2020-01-01', true)`,
          [m.recruiter, teamId],
        );
      }
      await observer.query("set role service_role");
      try {
        await observer.query(DESIGNATE_TL_SQL, [
          HR_OP.auth,
          HR_OP.app,
          teamId,
          oldTl.app,
          1,
          `HR_OP seed TL ${code}`,
          `seed-tl-${keySeq++}`,
        ]);
      } finally {
        await observer.query("reset role");
      }
      const { rows: [{ version: oldV }] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [oldTl.app],
      );
      await observer.query("set role service_role");
      try {
        await observer.query(DISABLE_SQL, [
          OWNER.auth,
          OWNER.app,
          oldTl.app,
          oldV,
          `Disable ${code} TL`,
          `dis-tl-${keySeq++}`,
        ]);
      } finally {
        await observer.query("reset role");
      }
      const { rows: [{ version: oldVer }] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [oldTl.app],
      );
      const { rows: [{ version: teamVer }] } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamId],
      );
      return { oldVer, teamVer };
    };

    // 4a: Lock-hold on oldTl -> HR_OP designates replacement TL -> OWNER enables oldTl
    const TEAM_R1_A = "59600000-0000-4000-8000-000000000001";
    const sA = await setupTeamForHrOpRace(TEAM_R1_A, "WP5B2_HR_R1A", TL_R1_A_OLD, TL_R1_A_NEW);

    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
    await worker1.query(
      "select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update",
      [TL_R1_A_OLD.app],
    );
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const pReplace = settleTx(
      worker2,
      worker2.query(DESIGNATE_TL_SQL, [
        HR_OP.auth,
        HR_OP.app,
        TEAM_R1_A,
        TL_R1_A_NEW.app,
        sA.teamVer,
        "HR_OP replace TL vs enable",
        `hr-rep-${keySeq++}`,
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");
    await worker1.query("set local role service_role");
    const pEnableA = settleTx(
      worker1,
      worker1.query(ENABLE_SQL, [
        OWNER.auth,
        OWNER.app,
        TL_R1_A_OLD.app,
        sA.oldVer,
        "OWNER enable replaced TL",
        `en-r1a-${keySeq++}`,
      ]),
    );
    const [rEnableA, rReplaceA] = await Promise.all([pEnableA, pReplace]);
    assert.notEqual(rEnableA.reason?.code, "40P01");
    assert.notEqual(rReplaceA.reason?.code, "40P01");
    assert.equal(rEnableA.status, "fulfilled", `4a enable failed: ${rEnableA.reason?.message}`);
    assert.equal(rReplaceA.status, "fulfilled", `4a replace failed: ${rReplaceA.reason?.message}`);

    const { rows: activeTla } = await observer.query(
      "select leader_app_user_id from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true",
      [TEAM_R1_A],
    );
    assert.deepEqual(activeTla.map((r) => r.leader_app_user_id), [TL_R1_A_NEW.app]);

    // 4b: HR_OP revokes TL uncompressed -> OWNER enables oldTl (reverse order + burst verification)
    const TEAM_R1_B = "59600000-0000-4000-8000-000000000002";
    const sB = await setupTeamForHrOpRace(TEAM_R1_B, "WP5B2_HR_R1B", TL_R1_B_OLD);
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(REVOKE_TL_SQL, [
      HR_OP.auth,
      HR_OP.app,
      TEAM_R1_B,
      sB.teamVer,
      "HR_OP revoke uncommitted",
      `hr-rev-${keySeq++}`,
    ]);
    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const pEnableB = settleTx(
      worker2,
      worker2.query(ENABLE_SQL, [
        OWNER.auth,
        OWNER.app,
        TL_R1_B_OLD.app,
        sB.oldVer,
        "Enable after HR_OP revoke",
        `en-r1b-${keySeq++}`,
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");
    await worker1.query("commit");
    const rEnableB = await pEnableB;
    assert.notEqual(rEnableB.reason?.code, "40P01");
    if (rEnableB.status === "rejected") {
      assert.equal(rEnableB.reason?.code, "PT409");
      const { rows: [{ version: vB }] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [TL_R1_B_OLD.app],
      );
      await observer.query("set role service_role");
      await observer.query(ENABLE_SQL, [OWNER.auth, OWNER.app, TL_R1_B_OLD.app, vB, "Refresh enable", `en-r1b-ref-${keySeq++}`]);
      await observer.query("reset role");
    }
    const { rows: openScopesB } = await observer.query(
      "select count(*)::int as cnt from public.direct_entry_scope_grants where app_user_id = $1::uuid and scope_kind = 'team' and is_current = true and valid_to is null",
      [TL_R1_B_OLD.app],
    );
    assert.equal(openScopesB[0].cnt, 0, "4b: revoked TL must have 0 resurrected team scopes on enable");

    // 4c: Simultaneous barrier burst enable vs HR_OP revoke_team_leader across 3 iterations
    for (let iter = 1; iter <= 3; iter += 1) {
      const teamId = `59600000-0000-4000-8000-00000000010${iter}`;
      const tlCand = TL_R1_C_ITERS[iter - 1];
      const sC = await setupTeamForHrOpRace(teamId, `WP5B2_HR_R1C_${iter}`, tlCand);

      await blocker.query("begin");
      await blocker.query("select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update", [tlCand.app]);
      await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
      await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
      const pE = settleTx(worker1, worker1.query(ENABLE_SQL, [OWNER.auth, OWNER.app, tlCand.app, sC.oldVer, `Iter ${iter} enable`, `it-e-${iter}-${keySeq++}`]));
      const pR = settleTx(worker2, worker2.query(REVOKE_TL_SQL, [HR_OP.auth, HR_OP.app, teamId, sC.teamVer, `Iter ${iter} revoke`, `it-r-${iter}-${keySeq++}`]));
      await Promise.all([waitUntilBlocked(observer, "wp5b2-w1"), waitUntilBlocked(observer, "wp5b2-w2")]);
      await blocker.query("rollback");
      const [re, rr] = await Promise.all([pE, pR]);
      assert.notEqual(re.reason?.code, "40P01", `Iter ${iter} enable must not deadlock`);
      assert.notEqual(rr.reason?.code, "40P01", `Iter ${iter} revoke must not deadlock`);
      assert.equal(rr.status, "fulfilled", `Iter ${iter} HR_OP revoke must succeed: ${rr.reason?.message}`);
    }
  } finally {
    await Promise.allSettled(
      [worker1, worker2, worker3, worker4, blocker, observer, setup, adminClient]
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
