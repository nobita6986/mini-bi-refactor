/**
 * PRE-W2-HF Project<->Team authority - real PostgreSQL concurrency regression.
 *
 * Proves the locked lock order (project row -> mapping row -> leader/team context ->
 * revalidate -> write) closes the revoke race:
 *   - revoke commits first  -> the leader assign/unassign is denied with 42501;
 *   - the leader assignment commits first -> the revoke succeeds afterwards and
 *     never rewrites the committed assignment history.
 *
 * Mirrors scripts/p3-1-w02a-concurrency.test.mjs (initdb + pg_ctl; skipped when no
 * PostgreSQL server binaries are available).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const AUTHORITY_MIGRATION = "20261015100000_pre_w2_hf_project_team_authority.sql";

const TEAM_A = "33000000-0000-4000-8000-000000000011";
const ADMIN_AUTH = "33000000-0000-4000-8000-000000000101";
const ADMIN_APP = "33000000-0000-4000-8000-000000000201";
const LEADER_AUTH = "33000000-0000-4000-8000-000000000103";
const LEADER_APP = "33000000-0000-4000-8000-000000000203";
const LEADER_RECRUITER = "33000000-0000-4000-8000-000000000303";
const MANAGER_AUTH = "33000000-0000-4000-8000-000000000104";
const MANAGER_APP = "33000000-0000-4000-8000-000000000204";
const MANAGER_RECRUITER = "33000000-0000-4000-8000-000000000304";
const MANAGER2_AUTH = "33000000-0000-4000-8000-000000000105";
const MANAGER2_APP = "33000000-0000-4000-8000-000000000205";
const MANAGER2_RECRUITER = "33000000-0000-4000-8000-000000000305";
const PROJECT = "pt-race-active";
const PAST = "2020-01-01";
const PID = process.pid;

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
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

async function connect(port, database = "postgres", applicationName = "pt-authority-test") {
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
  assert.fail(`session ${applicationName} did not block on a PostgreSQL lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;"
      + " create schema auth; create table auth.users (id uuid primary key);",
  );
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(AUTHORITY_MIGRATION), 93, "the Project<->Team authority migration remains #94");
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function call(client, name, args) {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  return (await client.query(`select public.${name}(${placeholders}) as data`, args)).rows[0].data;
}

async function grantMapping(client, actor, project, team, expected, reason, validFrom = null) {
  return call(client, "direct_entry_grant_project_team_scope",
    [actor.auth, actor.app, project, team, expected, validFrom, reason,
      `grant-${PID}-${reason.replaceAll(" ", "-")}`]);
}

const admin = { auth: ADMIN_AUTH, app: ADMIN_APP };

async function seed(client) {
  const { rows: [{ today }] } = await client.query(
    "select public.direct_entry_authorization_date()::text as today",
  );
  await client.query(
    "insert into public.teams(team_id,code,display_name,active) values ($1,'PT_LOCK','Lock Team',true)",
    [TEAM_A],
  );
  await client.query("insert into auth.users(id) values ($1),($2),($3),($4)",
    [ADMIN_AUTH, LEADER_AUTH, MANAGER_AUTH, MANAGER2_AUTH]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)"
      + " values ($1,$2,true,'Full Admin'),($3,$4,true,'Team Leader'),"
      + "($5,$6,true,'Manager'),($7,$8,true,'Second Manager')",
    [ADMIN_APP, ADMIN_AUTH, LEADER_APP, LEADER_AUTH, MANAGER_APP, MANAGER_AUTH,
      MANAGER2_APP, MANAGER2_AUTH],
  );
  await client.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)"
      + " values ($1,'entry_admin',$2,true),($1,'recruiter_master_manage',$2,true),($1,'team_master_manage',$2,true),"
      + "($3,'team_manager_assign',$2,true),($4,'entry_create',$2,true),($5,'entry_create',$2,true)",
    [ADMIN_APP, PAST, LEADER_APP, MANAGER_APP, MANAGER2_APP],
  );
  await client.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from,is_current)"
      + " values ($1,'all',null,$2,true),($3,'team',$4,$2,true),($5,'own',null,$2,true),($6,'own',null,$2,true)",
    [ADMIN_APP, PAST, LEADER_APP, TEAM_A, MANAGER_APP, MANAGER2_APP],
  );
  await client.query(
    "insert into public.recruiters(recruiter_id,display_name,personnel_code,personnel_position,active)"
      + " values ($1,'Team Leader','leader-race','TEAM_LEADER',true),"
      + "($2,'Manager','manager-race','STAFF',true),"
      + "($3,'Second Manager','manager-race-2','STAFF',true)",
    [LEADER_RECRUITER, MANAGER_RECRUITER, MANAGER2_RECRUITER],
  );
  await client.query(
    "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from,is_current)"
      + " values ($1,'hrp',$2,true),($3,'hrp',$2,true),($4,'hrp',$2,true)",
    [LEADER_RECRUITER, PAST, MANAGER_RECRUITER, MANAGER2_RECRUITER],
  );
  await client.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from,is_current)"
      + " values ($1,$2,$3,true),($4,$2,$3,true),($5,$2,$3,true)",
    [LEADER_RECRUITER, TEAM_A, PAST, MANAGER_RECRUITER, MANAGER2_RECRUITER],
  );
  await client.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from,is_current)"
      + " values ($1,$3,true,$2,true),($4,$5,true,$2,true),($6,$7,true,$2,true)",
    [LEADER_APP, PAST, LEADER_RECRUITER, MANAGER_APP, MANAGER_RECRUITER,
      MANAGER2_APP, MANAGER2_RECRUITER],
  );
  await client.query("begin");
  await client.query("select set_config('direct_entry.team_leader_marker','on',true)");
  await client.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from,is_current) values ($1,$2,$3,$4,true)",
    [TEAM_A, LEADER_APP, LEADER_RECRUITER, PAST],
  );
  await client.query("commit");
  await client.query(
    "insert into public.direct_entry_projects(project_id,display_name,active,version)"
      + " values ($1,'Race Project',true,1)",
    [PROJECT],
  );
  await grantMapping(client, admin, PROJECT, TEAM_A, 0, "seed grant for the races");
  return today;
}

async function currentOpenMapping(client) {
  const listing = await call(client, "direct_entry_list_project_team_scopes_admin",
    [ADMIN_AUTH, ADMIN_APP, PROJECT, TEAM_A, false, 1, 25]);
  const open = listing.mappings.find((row) => row.state === "CURRENT");
  assert.ok(open, "the fixture must keep an open mapping for this pair");
  return open;
}

async function pairVersion(client) {
  const { rows } = await client.query(
    "select coalesce(max(version), 0)::int as pair_version"
      + " from public.direct_entry_project_team_scopes where project_id=$1 and team_id=$2",
    [PROJECT, TEAM_A],
  );
  return rows[0].pair_version;
}

test("PRE-W2-HF Project<->Team: batch mapping and revoke races prove the locked lock order",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the real concurrency regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pt-authority-race-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const port = await freePort();
    let serverStarted = false;
    let adminClient;
    let observer;
    let setup;
    let revokeSession;
    let leaderSession;
    let inTx = [];
    let databaseName;
    const rollbackAll = async (sessions) => {
      for (const session of sessions) {
        await session.query("rollback").catch(() => {});
        await session.end().catch(() => {});
      }
      inTx = [];
    };

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
      databaseName = `pt_race_${process.pid}`;
      adminClient = await connect(port);
      await adminClient.query(`create database ${databaseName}`);

      // ------------------------------------------------------------------
      // Stage 1: revoke commits first -> the leader assignment and the
      // leader unassignment are both denied (42501).
      // ------------------------------------------------------------------
      setup = await connect(port, databaseName, "pt-race-setup");
      await applyMigrations(setup);
      const today = await seed(setup);
      await setup.end();
      setup = undefined;
      {
        const prepare = await connect(port, databaseName, "pt-prepare");
        const openMapping = await currentOpenMapping(prepare);
        await prepare.end();

        revokeSession = await connect(port, databaseName, "pt-race-revoke");
        leaderSession = await connect(port, databaseName, "pt-race-assign");
        observer = await connect(port, databaseName, "pt-race-observer");
        inTx = [revokeSession, leaderSession, observer];

        await revokeSession.query("begin");
        await call(revokeSession, "direct_entry_revoke_project_team_scope",
          [ADMIN_AUTH, ADMIN_APP, openMapping.mapping_id, 1, null,
            "race revoke before the assignment", `revoke-${PID}-first`]);
        const assignPending = leaderSession.query(
          "select public.direct_entry_assign_project_manager($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            LEADER_AUTH, LEADER_APP, PROJECT, MANAGER_RECRUITER, today, 1,
            "race assignment during revoke", `assign-during-revoke-${PID}`,
          ],
        );
        await waitUntilBlocked(observer, "pt-race-assign");
        await revokeSession.query("commit");
        await assert.rejects(assignPending, (error) => error.code === "42501",
          "a revoked mapping denies the leader assignment committed after it");

        // The revoked mapping blocks the leader unassignment too (Admin cleans up).
        const assignment = await call(observer, "direct_entry_assign_project_manager",
          [
            ADMIN_AUTH, ADMIN_APP, PROJECT, MANAGER_RECRUITER, today, 1,
            "seeded assignment for the denied unassign", `seed-assign-${PID}`,
          ]);
        const { rows: [{ version: projectVersion }] } = await observer.query(
          "select version from public.direct_entry_projects where project_id=$1", [PROJECT],
        );
        try {
          await leaderSession.query(
            "select public.direct_entry_unassign_project_manager($1,$2,$3,$4,$5,$6,$7) as data",
            [
              LEADER_AUTH, LEADER_APP, assignment.assignment_id, assignment.version,
              projectVersion, "leader unassign after revoke", `unassign-after-revoke-${PID}`,
            ],
          );
          assert.fail("the leader unassignment must be denied once the mapping is revoked");
        } catch (error) {
          assert.equal(error.code, "42501",
            "the leader unassignment is denied once the mapping is revoked");
        }
        await rollbackAll(inTx);
      }

      // ------------------------------------------------------------------
      // Stage 2: the leader assignment commits first -> the revoke follows
      // and never rewrites the committed assignment history.
      // ------------------------------------------------------------------
      {
        const pairClient = await connect(port, databaseName, "pt-pair");
        const pairVersionBefore = await pairVersion(pairClient);
        await pairClient.end();
        const grantClient = await connect(port, databaseName, "pt-regrant");
        const grant = await grantMapping(grantClient, admin, PROJECT, TEAM_A, pairVersionBefore,
          "regrant for the assign-first stage", today);
        const { rows: [{ version: projectVersion }] } = await grantClient.query(
          "select version from public.direct_entry_projects where project_id=$1", [PROJECT],
        );
        await grantClient.end();

        leaderSession = await connect(port, databaseName, "pt-race-leader-first");
        revokeSession = await connect(port, databaseName, "pt-race-revoke-second");
        observer = await connect(port, databaseName, "pt-race-observer-2");
        inTx = [leaderSession, revokeSession];

        await leaderSession.query("begin");
        const assigned = await call(leaderSession, "direct_entry_assign_project_manager",
          [
            LEADER_AUTH, LEADER_APP, PROJECT, MANAGER2_RECRUITER, today, projectVersion,
            "leader assignment commits first", `leader-assign-first-${PID}`,
          ]);

        await revokeSession.query("begin");
        const revokePending = call(revokeSession, "direct_entry_revoke_project_team_scope",
          [ADMIN_AUTH, ADMIN_APP, grant.mapping_id, grant.version, null,
            "revoke processed after the committed assignment", `revoke-after-assign-${PID}`]);
        await waitUntilBlocked(observer, "pt-race-revoke-second");
        await leaderSession.query("commit");
        await revokePending;
        await revokeSession.query("commit");
        await rollbackAll(inTx);

        const checker = await connect(port, databaseName, "pt-race-check");
        const { rows: [mappingAfter] } = await checker.query(
          "select version, valid_to, revoked_at from public.direct_entry_project_team_scopes"
            + " where mapping_id=$1", [grant.mapping_id],
        );
        assert.equal(mappingAfter.version, grant.version + 1,
          "the revoke after mutation bumps the pair version");
        assert.notEqual(mappingAfter.valid_to, null, "the revoke after mutation closes the interval");
        const { rows: [assignmentAfter] } = await checker.query(
          "select version, valid_to, revoked_at from public.direct_entry_project_manager_assignments"
            + " where assignment_id=$1", [assigned.assignment_id],
        );
        assert.equal(assignmentAfter.version, 1, "the committed assignment stays intact");
        assert.equal(assignmentAfter.valid_to, null, "the committed assignment stays open");
        await checker.end();
        await observer.end();
        observer = undefined;
      }

      // ------------------------------------------------------------------
      // Stage 3: simultaneous grants serialize on the project and the loser
      // returns an explicit skip. Concurrent versionless revokes serialize
      // too; the second observes the committed close and leaves no residue.
      // ------------------------------------------------------------------
      {
        const grantFirst = await connect(port, databaseName, "pt-batch-grant-first");
        const grantSecond = await connect(port, databaseName, "pt-batch-grant-second");
        observer = await connect(port, databaseName, "pt-batch-observer");
        inTx = [grantFirst, grantSecond];

        await grantFirst.query("begin");
        const firstBatch = await call(grantFirst, "direct_entry_grant_project_team_scopes_batch",
          [ADMIN_AUTH, ADMIN_APP, TEAM_A, [PROJECT], "concurrent first", `batch-first-${PID}`]);
        assert.equal(firstBatch.created.length, 1);
        assert.deepEqual(firstBatch.skipped, []);

        await grantSecond.query("begin");
        const secondPending = call(grantSecond, "direct_entry_grant_project_team_scopes_batch",
          [ADMIN_AUTH, ADMIN_APP, TEAM_A, [PROJECT], "concurrent second", `batch-second-${PID}`]);
        await waitUntilBlocked(observer, "pt-batch-grant-second");
        await grantFirst.query("commit");
        const secondBatch = await secondPending;
        assert.deepEqual(secondBatch.created, []);
        assert.equal(secondBatch.skipped.length, 1);
        assert.equal(secondBatch.skipped[0].mapping_id, firstBatch.created[0].mapping_id);
        await grantSecond.query("commit");
        await rollbackAll(inTx);
        await observer.end();
        observer = undefined;

        const revokeFirst = await connect(port, databaseName, "pt-batch-revoke-first");
        const revokeSecond = await connect(port, databaseName, "pt-batch-revoke-second");
        observer = await connect(port, databaseName, "pt-batch-revoke-observer");
        inTx = [revokeFirst, revokeSecond];
        await revokeFirst.query("begin");
        const firstRevoke = await call(revokeFirst, "direct_entry_revoke_project_team_scope",
          [ADMIN_AUTH, ADMIN_APP, firstBatch.created[0].mapping_id, null,
            "concurrent first revoke", `batch-revoke-first-${PID}`]);
        assert.equal(firstRevoke.revoked, true);

        await revokeSecond.query("begin");
        const secondRevokePending = call(revokeSecond, "direct_entry_revoke_project_team_scope",
          [ADMIN_AUTH, ADMIN_APP, firstBatch.created[0].mapping_id, null,
            "concurrent second revoke", `batch-revoke-second-${PID}`]);
        await waitUntilBlocked(observer, "pt-batch-revoke-second");
        await revokeFirst.query("commit");
        await assert.rejects(secondRevokePending, (error) => error.code === "22023",
          "the second versionless revoke observes the first committed revoke");
        await revokeSecond.query("rollback");
        await rollbackAll(inTx);
        await observer.end();
        observer = undefined;

        const verify = await connect(port, databaseName, "pt-batch-race-verify");
        const { rows: [raceState] } = await verify.query(`
          select
            (select count(*)::int from public.direct_entry_project_team_scopes
              where project_id=$1 and team_id=$2 and valid_to is null) as open_mappings,
            (select count(*)::int from public.direct_entry_audit_events
              where action='project_team_scope_grant' and resource_ref=$3) as grant_audits,
            (select count(*)::int from public.direct_entry_rpc_idempotency
              where idempotency_key='batch-revoke-second-${PID}') as losing_revoke_idempotency
        `, [PROJECT, TEAM_A, firstBatch.created[0].mapping_id]);
        assert.equal(raceState.open_mappings, 0);
        assert.equal(raceState.grant_audits, 1);
        assert.equal(raceState.losing_revoke_idempotency, 0);
        await verify.end();
      }

      // Final state: no residue from the denied leader mutations.
      const finalReader = await connect(port, databaseName, "pt-race-final");
      const { rows: [finalState] } = await finalReader.query(`
        select
          (select count(*)::int from public.direct_entry_project_manager_assignments) as assignments,
          (select count(*)::int from public.direct_entry_rpc_idempotency
            where idempotency_key='assign-during-revoke-${PID}') as denied_idempotency
      `);
      assert.equal(finalState.denied_idempotency, 0,
        "a denied leader write leaves no idempotency residue");
      assert.equal(finalState.assignments, 2, "exactly the committed assignments survive");
      await finalReader.end();
    } finally {
      await rollbackAll(inTx);
      await observer?.end().catch(() => {});
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
