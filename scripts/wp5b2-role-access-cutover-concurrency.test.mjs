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
 *      `ai_provider_config_save` & `assign_global_role_admin`):
 *      serialized via row locks on `direct_entry_app_users`, 0 `40P01`, loser returns `AI_FORBIDDEN` / `42501`.
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
const AI_SAVE_SQL =
  "select public.ai_provider_config_save($1, $2::int, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) as data";

function buildAiEnvelope(configId, version, profile, url, model) {
  return {
    envelope_version: 2,
    algorithm: "aes-256-gcm",
    key_id: "k1",
    config_id: configId,
    provider_profile: profile,
    config_version: version,
    api_base_url: url,
    model,
    iv: Buffer.alloc(12, 3).toString("base64"),
    ciphertext: Buffer.from("pg18-race-cipher").toString("base64"),
    authentication_tag: Buffer.alloc(16, 4).toString("base64"),
    created_at: "2026-11-18T16:00:00.000Z",
  };
}

test("WP5B-2 real PostgreSQL concurrency: cutover race, idempotency vs OCC, AI authority loss, and HR_OPERATOR R1 TL lock-order", async (t) => {
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

    // -------------------------------------------------------------------------
    // Race 1: Concurrent runWp5Cutover(..., { mode: "apply" }) behind barrier
    // -------------------------------------------------------------------------
    const roPlan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(roPlan.action_diff.unexpected_diff_count, 0);
    const expectedFingerprint = roPlan.manifest_fingerprint;

    await blocker.query("begin");
    await blocker.query(
      "select singleton_id from public.authz_system_state where singleton_id = true for update",
    );

    const cutP1 = runWp5Cutover(worker1, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint,
    });
    const cutP2 = runWp5Cutover(worker2, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint,
    });

    await Promise.all([
      waitUntilBlocked(observer, "wp5b2-w1"),
      waitUntilBlocked(observer, "wp5b2-w2"),
    ]);
    await blocker.query("rollback");

    const [cutR1, cutR2] = await Promise.all([cutP1, cutP2]);
    assert.deepEqual(
      [cutR1.status, cutR2.status].sort(),
      ["ALREADY_APPLIED_NOOP", "APPLIED"],
      "Concurrent cutover apply must produce strictly one APPLIED and one ALREADY_APPLIED_NOOP",
    );

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
    // Race 3a: Concurrent authority loss: OWNER revokes NGATTT ADMIN vs NGATTT calling ai_provider_config_save
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

    // Hold revoke uncommitted while AI save blocks on NGATTT FOR SHARE -> revoke commits -> AI save sees authority loss -> AI_FORBIDDEN!
    await worker1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    await worker1.query(REVOKE_SQL, [
      OWNER.auth,
      OWNER.app,
      NGATTT.app,
      ngaAssign.assignment_id,
      ngaAssign.version,
      "Revoke NGATTT during AI save",
      nextUuidKey(),
      sha256Hex({ op: "revoke-nga-ai" }),
    ]);

    await worker2.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
    const aiRacePromise = settleTx(
      worker2,
      worker2.query(AI_SAVE_SQL, [
        "pilot",
        null,
        "openai-compatible",
        "https://api.openai.com/v1",
        "api.openai.com",
        "gpt-4o-mini",
        JSON.stringify(buildAiEnvelope("pilot", 1, "openai-compatible", "https://api.openai.com/v1", "gpt-4o-mini")),
        "d".repeat(16),
        NGATTT.app,
        "config_created",
      ]),
    );
    await waitUntilBlocked(observer, "wp5b2-w2");
    await worker1.query("commit");

    const aiRaceResult = await aiRacePromise;
    assert.equal(aiRaceResult.status, "fulfilled", `ai_provider_config_save threw unexpectedly: ${aiRaceResult.reason?.message}`);
    assert.deepEqual(
      { ok: aiRaceResult.value.rows[0].data.ok, code: aiRaceResult.value.rows[0].data.code },
      { ok: false, code: "AI_FORBIDDEN" },
      "NGATTT losing ADMIN under lock must cause ai_provider_config_save to return AI_FORBIDDEN",
    );
    const { rows: [{ cnt: aiCount }] } = await observer.query("select count(*)::int as cnt from public.ai_provider_configs");
    assert.equal(aiCount, 0, "Denied AI save must not insert into ai_provider_configs");

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
