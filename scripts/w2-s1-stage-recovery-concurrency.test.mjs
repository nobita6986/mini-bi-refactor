import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { seedSubmissionReadFixture } from "./lib/s04c-submission-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const OWNER = {
  auth_subject: "11000000-0000-4000-8000-000000000001",
  app_user_id: "21000000-0000-4000-8000-000000000001",
};

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  return spawnSync(candidate, ["--version"], { encoding: "utf8" }).error ? null : candidate;
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

async function connect(port, database, applicationName) {
  const client = new Client({
    host: "127.0.0.1", port, user: "postgres", database, application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function waitUntilBlocked(observer, applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where application_name=$1",
      [applicationName],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`session ${applicationName} did not block on a PostgreSQL lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
    " create schema auth; create table auth.users (id uuid primary key);",
  );
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  for (const name of names) await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
}

test("stage recovery and cleanup serialize with completion, batch RPC and stage claims", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for the real recovery race regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "w2s1-stage-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `w2s1_stage_race_${process.pid}`;
  let serverStarted = false;
  let admin;
  let setup;
  let blocker;
  let recovery;
  let completion;
  let observer;
  let recoveryRequest;
  let completionRequest;
  let batchRecoveryRequest;
  let batchRequest;
  try {
    run(initdb, [
      "--username=postgres", "--auth-local=trust", "--auth-host=trust",
      "--no-locale", "--encoding=UTF8", "--pgdata", dataDir,
    ]);
    run(pgCtl, [
      "-D", dataDir, "-l", logFile,
      "-o", `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
      "-w", "start",
    ], { ignoreOutput: process.platform === "win32" });
    serverStarted = true;
    admin = await connect(port, "postgres", "w2s1-admin");
    await admin.query(`create database ${databaseName}`);
    setup = await connect(port, databaseName, "w2s1-setup");
    await applyMigrations(setup);
    const fixture = await seedSubmissionReadFixture({
      query: (...args) => setup.query(...args),
      exec: (sql) => setup.query(sql),
    });
    const entryId = fixture.draft.entryIds[0];
    await setup.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
      " values ($1,'document_upload','2020-01-01',true)",
      [OWNER.app_user_id],
    );
    const { rows: [{ version }] } = await setup.query(
      "select version from public.direct_entries where entry_id=$1",
      [entryId],
    );
    const reservation = (await setup.query(
      "select public.direct_entry_reserve_document_direct_upload(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::integer,'WORKER_PORTRAIT'," +
      "'w2s1-race-reserve',256,'image/jpeg',null) data",
      [OWNER.auth_subject, OWNER.app_user_id, entryId, version],
    )).rows[0].data;
    const checksum = "a".repeat(64);
    await setup.query(
      "select public.direct_entry_finalize_document_direct_upload(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer," +
      "'w2s1-race-finalize','validated',$6,256,'image/jpeg') data",
      [
        OWNER.auth_subject, OWNER.app_user_id, entryId, reservation.document_id,
        reservation.entry_version, checksum,
      ],
    );
    const stageId = "b8000000-0000-4000-8000-000000000001";
    const claimKey = "b9000000-0000-4000-8000-000000000001";
    await setup.query(
      "select public.direct_entry_create_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, stageId, checksum],
    );
    await setup.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, stageId, claimKey],
    );
    await setup.end();
    setup = undefined;

    blocker = await connect(port, databaseName, "w2s1-row-blocker");
    recovery = await connect(port, databaseName, "w2s1-recovery");
    completion = await connect(port, databaseName, "w2s1-completion");
    observer = await connect(port, databaseName, "w2s1-observer");
    const createKey = "b9000000-0000-4000-8000-000000000003";
    const concurrentCreates = await Promise.all([
      recovery.query(
        "select public.direct_entry_create_worker_portrait_stage_idempotent(" +
        "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4,$5) data",
        [OWNER.auth_subject, OWNER.app_user_id, "b8000000-0000-4000-8000-000000000003",
          checksum, createKey],
      ),
      completion.query(
        "select public.direct_entry_create_worker_portrait_stage_idempotent(" +
        "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4,$5) data",
        [OWNER.auth_subject, OWNER.app_user_id, "b8000000-0000-4000-8000-000000000004",
          checksum, createKey],
      ),
    ]);
    const createResults = concurrentCreates.map((result) => result.rows[0].data);
    assert.equal(createResults[0].stage.stage_id, createResults[1].stage.stage_id,
      "simultaneous same-key requests return one stage id");
    assert.deepEqual(createResults.map((result) => result.replayed).sort(), [false, true]);
    assert.equal((await observer.query(
      "select count(*)::integer count from public.direct_entry_worker_portrait_stages" +
      " where created_by_user_id=$1 and create_idempotency_key=$2",
      [OWNER.app_user_id, createKey],
    )).rows[0].count, 1, "only one persistent stage is created");

    await blocker.query("begin");
    await blocker.query(
      "select stage_id from public.direct_entry_worker_portrait_stages where stage_id=$1 for update",
      [stageId],
    );
    recoveryRequest = recovery.query(
      "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid)",
      [OWNER.auth_subject, OWNER.app_user_id, stageId],
    );
    completionRequest = completion.query(
      "select public.direct_entry_complete_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid)",
      [
        OWNER.auth_subject, OWNER.app_user_id, stageId, claimKey, entryId,
        reservation.document_id,
      ],
    );
    await waitUntilBlocked(observer, "w2s1-recovery");
    await waitUntilBlocked(observer, "w2s1-completion");
    await blocker.query("commit");

    const results = await Promise.allSettled([recoveryRequest, completionRequest]);
    const { rows: [state] } = await observer.query(
      "select status,claim_idempotency_key,entry_id,document_id" +
      " from public.direct_entry_worker_portrait_stages where stage_id=$1",
      [stageId],
    );
    if (state.status === "ATTACHED") {
      assert.equal(results[1].status, "fulfilled", "completion can win before recovery");
      assert.equal(results[0].status, "rejected", "recovery detects attachment after waiting");
      assert.equal(state.claim_idempotency_key, claimKey);
      assert.equal(state.entry_id, entryId);
      assert.equal(state.document_id, reservation.document_id);
    } else {
      assert.equal(state.status, "STAGED");
      assert.equal(state.claim_idempotency_key, null);
      assert.equal(state.entry_id, null);
      assert.equal(state.document_id, null);
      assert.equal(results[0].status, "fulfilled", "recovery can win before completion");
      assert.equal(results[1].status, "rejected", "completion cannot attach after recovery");
    }

    const batchStageId = "b8000000-0000-4000-8000-000000000002";
    const batchKey = "b9000000-0000-4000-8000-000000000002";
    await observer.query(
      "select public.direct_entry_create_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, batchStageId, checksum],
    );
    await observer.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, batchStageId, batchKey],
    );

    await blocker.query("begin");
    await blocker.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2, 0))",
      [OWNER.app_user_id, batchKey],
    );
    batchRecoveryRequest = recovery.query(
      "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid) data",
      [OWNER.auth_subject, OWNER.app_user_id, batchStageId],
    );
    batchRequest = completion.query(
      "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
      "$1::uuid,$2::uuid,'worker-profile/1.1',$3::jsonb,$4::text,array[$5::uuid]) data",
      [
        OWNER.auth_subject, OWNER.app_user_id,
        JSON.stringify([{
          project_id: "s02c_project",
          first_work_date: "2026-10-20",
          provider_type: "hrp",
          recruiter_id: "93000000-0000-4000-8000-0000000000c1",
          labor_type: "TEMPORARY",
          display_name: "Concurrent batch worker",
          worker_details: {
            gender: { state: "provided", value: "OTHER" },
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            national_id_issued_at: { state: "omitted" },
            national_id_issued_place: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          general_note: { state: "omitted" },
          payment: null,
          employment: null,
        }]),
        batchKey, batchStageId,
      ],
    );
    await waitUntilBlocked(observer, "w2s1-recovery");
    await waitUntilBlocked(observer, "w2s1-completion");
    await blocker.query("commit");

    const batchResults = await Promise.allSettled([batchRecoveryRequest, batchRequest]);
    const { rows: [batchStage] } = await observer.query(
      "select status,claim_idempotency_key from public.direct_entry_worker_portrait_stages" +
      " where stage_id=$1",
      [batchStageId],
    );
    if (batchStage.status === "STAGED") {
      assert.equal(batchResults[0].status, "fulfilled",
        "recovery may acquire the advisory lock before batch creation");
      assert.equal(batchResults[0].value.rows[0].data.status, "STAGED");
      assert.equal(batchResults[1].status, "rejected",
        "the batch RPC cannot create workers from a stage released by recovery");
      assert.equal(batchStage.claim_idempotency_key, null);
    } else {
      assert.equal(batchStage.status, "CLAIMED");
      assert.equal(batchStage.claim_idempotency_key, batchKey);
      assert.equal(batchResults[1].status, "fulfilled",
        "batch creation may acquire the advisory lock before recovery");
      assert.equal(batchResults[1].value.rows[0].data.entry_ids.length, 1);
      assert.equal(batchResults[0].status, "fulfilled",
        "recovery preserves the claim when the batch result has committed");
      assert.equal(batchResults[0].value.rows[0].data.status, "CLAIMED");
      assert.equal(batchResults[0].value.rows[0].data.claim_idempotency_key, batchKey);
    }

    const cleanupRaceStageId = "b8000000-0000-4000-8000-000000000005";
    const cleanupRaceKey = "b9000000-0000-4000-8000-000000000005";
    const cleanupToken = "c9000000-0000-4000-8000-000000000005";
    await observer.query(
      "select public.direct_entry_create_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
      [OWNER.auth_subject, OWNER.app_user_id, cleanupRaceStageId, checksum],
    );
    await observer.query(
      "update public.direct_entry_worker_portrait_stages" +
      " set created_at=clock_timestamp()-interval '25 hours' where stage_id=$1",
      [cleanupRaceStageId],
    );
    const [cleanupRace, batchClaimRace] = await Promise.allSettled([
      recovery.query(
        "select public.direct_entry_claim_expired_worker_portrait_stage_cleanup($1::uuid,50) ids",
        [cleanupToken],
      ),
      completion.query(
        "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
        [OWNER.auth_subject, OWNER.app_user_id, cleanupRaceStageId, cleanupRaceKey],
      ),
    ]);
    const { rows: [cleanupRaceState] } = await observer.query(
      "select status,claim_idempotency_key from public.direct_entry_worker_portrait_stages" +
      " where stage_id=$1",
      [cleanupRaceStageId],
    );
    assert.equal(cleanupRace.status, "fulfilled");
    if (cleanupRaceState.status === "CANCELLED") {
      assert.deepEqual(cleanupRace.value.rows[0].ids, [cleanupRaceStageId]);
      assert.equal(batchClaimRace.status, "rejected",
        "a stage atomically claimed for cleanup cannot be claimed into a batch");
    } else {
      assert.equal(cleanupRaceState.status, "CLAIMED");
      assert.equal(cleanupRaceState.claim_idempotency_key, cleanupRaceKey);
      assert.equal(batchClaimRace.status, "fulfilled",
        "the batch claim wins without allowing the reaper to select the stage");
      assert.deepEqual(cleanupRace.value.rows[0].ids, []);
    }
  } finally {
    await blocker?.query("rollback").catch(() => {});
    await recoveryRequest?.catch(() => {});
    await completionRequest?.catch(() => {});
    await batchRecoveryRequest?.catch(() => {});
    await batchRequest?.catch(() => {});
    await observer?.end().catch(() => {});
    await recovery?.end().catch(() => {});
    await completion?.end().catch(() => {});
    await blocker?.end().catch(() => {});
    await setup?.end().catch(() => {});
    await admin?.query(`drop database if exists ${databaseName}`).catch(() => {});
    await admin?.end().catch(() => {});
    if (serverStarted) {
      const pgCtl = binary("pg_ctl");
      if (pgCtl) spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
        encoding: "utf8", windowsHide: true,
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
