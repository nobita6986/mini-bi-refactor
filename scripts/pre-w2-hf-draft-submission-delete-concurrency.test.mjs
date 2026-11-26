/**
 * PRE-W2-HF draft-submission deletion race against DRAFT -> SUBMITTED.
 * Uses isolated local PostgreSQL only; no remote database URL is read.
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
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const DELETE_AUTH = ACTORS.proposer.auth_subject;
const DELETE_APP = ACTORS.proposer.app_user_id;

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
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

async function connect(port, database = "postgres", applicationName = "draft-delete-race") {
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
      "select wait_event_type from pg_stat_activity where application_name=$1",
      [applicationName],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`session ${applicationName} did not block on the submission row lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;"
      + " create schema auth; create table auth.users (id uuid primary key);",
  );
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf("20261019130000_pre_w2_hf_draft_submission_delete.sql"), 121, "migration chronology remains append-only");
  for (const name of names) await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
}

async function createDraft(client, suffix) {
  const code = `hrp-2026-${String(710000 + suffix).padStart(6, "0")}`;
  const rows = [{
    project_id: PROJECT_ID,
    first_work_date: "2026-10-15",
    employee_code: code,
    worker_details: {
      display_name: `Concurrency draft ${suffix}`,
      date_of_birth: { state: "unknown" },
      national_id: { state: "unknown" },
      address: { state: "unknown" },
      phone: { state: "unknown" },
    },
    recruiter_id: RECRUITER_A,
    labor_type: "TEMPORARY",
  }];
  await client.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text)",
    [DELETE_AUTH, DELETE_APP, JSON.stringify(rows), `s122_pg_create_${suffix}`],
  );
  const { rows: [entry] } = await client.query(
    "select submission_id from public.direct_entries where employee_code=$1",
    [code],
  );
  return entry.submission_id;
}

async function deleteSubmission(client, submissionId, key) {
  return client.query(
    "select public.direct_entry_delete_draft_submission($1::uuid,$2::uuid,$3::uuid,1,$4::text)",
    [DELETE_AUTH, DELETE_APP, submissionId, key],
  );
}

async function submit(client, submissionId, key) {
  return client.query(
    "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,1,'SUBMITTED',$4::text)",
    [DELETE_AUTH, DELETE_APP, submissionId, key],
  );
}

test("submission deletion and submission create/submit serialize on the same aggregate lock", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for the real delete-submit race regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "draft-submission-delete-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  let serverStarted = false;
  let adminClient;
  let setup;
  let deleter;
  let submitter;
  let observer;
  let databaseName;
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
    databaseName = `draft_delete_${process.pid}`;
    adminClient = await connect(port);
    await adminClient.query(`create database ${databaseName}`);
    setup = await connect(port, databaseName, "draft-delete-setup");
    await applyMigrations(setup);
    const first = await seedChangeRequestFixture(setup, { submissionWorkflow: "draft" });
    const secondSubmission = await createDraft(setup, 1);
    await setup.end();
    setup = undefined;

    deleter = await connect(port, databaseName, "draft-delete-first");
    submitter = await connect(port, databaseName, "draft-submit-second");
    observer = await connect(port, databaseName, "draft-delete-observer");

    await deleter.query("begin");
    const firstDelete = await deleteSubmission(deleter, first.submissionId, "s122_race_delete_first");
    assert.equal(firstDelete.rows[0].direct_entry_delete_draft_submission.deleted, true);
    const waitingSubmit = submit(submitter, first.submissionId, "s122_race_submit_second");
    await waitUntilBlocked(observer, "draft-submit-second");
    await deleter.query("commit");
    await assert.rejects(waitingSubmit, (error) => error.code === "PT409",
      "submit loses after the atomic deletion commits");

    await submitter.query("begin");
    const firstSubmit = await submit(submitter, secondSubmission, "s122_race_submit_first");
    assert.equal(firstSubmit.rows[0].direct_entry_transition_submission.state, "SUBMITTED");
    const waitingDelete = deleteSubmission(deleter, secondSubmission, "s122_race_delete_second");
    await waitUntilBlocked(observer, "draft-delete-first");
    await submitter.query("commit");
    await assert.rejects(waitingDelete, (error) => error.code === "55000",
      "deletion loses after DRAFT -> SUBMITTED commits");

    const { rows: finalRows } = await observer.query(
      "select state,version from public.direct_entry_submissions where submission_id=any($1::uuid[])" +
      " order by submission_id",
      [[first.submissionId, secondSubmission]],
    );
    assert.deepEqual(finalRows.map(({ state }) => state).sort(), ["DELETED", "SUBMITTED"]);
    assert.deepEqual(finalRows.map(({ version }) => version), [2, 2]);
    const { rows: idempotency } = await observer.query(
      "select idempotency_key from public.direct_entry_rpc_idempotency" +
      " where action in ('draft_submission_delete','submission_transition')" +
      " and idempotency_key in ('s122_race_submit_second','s122_race_delete_second')",
    );
    assert.deepEqual(idempotency, [], "the losing race leaves no idempotency residue");
  } finally {
    await deleter?.query("rollback").catch(() => {});
    await submitter?.query("rollback").catch(() => {});
    await observer?.end().catch(() => {});
    await deleter?.end().catch(() => {});
    await submitter?.end().catch(() => {});
    await setup?.end().catch(() => {});
    await adminClient?.query(`drop database if exists ${databaseName}`).catch(() => {});
    await adminClient?.end().catch(() => {});
    if (serverStarted) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
