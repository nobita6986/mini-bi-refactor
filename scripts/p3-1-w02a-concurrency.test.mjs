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
const TEAM_A = "22000000-0000-4000-8000-000000000011";
const TEAM_B = "22000000-0000-4000-8000-000000000012";
const ADMIN_AUTH = "22000000-0000-4000-8000-000000000101";
const ADMIN_APP = "22000000-0000-4000-8000-000000000201";
const LEADER_AUTH = "22000000-0000-4000-8000-000000000103";
const LEADER_APP = "22000000-0000-4000-8000-000000000203";
const MANAGER_APP = "22000000-0000-4000-8000-000000000204";
const LEADER_RECRUITER = "22000000-0000-4000-8000-000000000303";
const MANAGER_RECRUITER = "22000000-0000-4000-8000-000000000304";
const SECOND_MANAGER_APP = "22000000-0000-4000-8000-000000000205";
const SECOND_MANAGER_RECRUITER = "22000000-0000-4000-8000-000000000305";
const PROJECT = "w02a-concurrency-active";
const PAST = "2020-01-01";

function uuid(n) {
  return `22000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "w02a-test") {
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
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seed(client) {
  const { rows: [{ today }] } = await client.query(
    "select public.direct_entry_authorization_date()::text as today",
  );
  await client.query(
    "insert into public.teams(team_id,code,display_name,active) values"
      + " ($1,'W02A_LOCK','Lock Team',true),($2,'W02A_OTHER','Other Team',true)",
    [TEAM_A, TEAM_B],
  );
  await client.query(
    "insert into auth.users(id) values ($1),($2),($3),($4)",
    [ADMIN_AUTH, LEADER_AUTH, uuid(104), uuid(105)],
  );
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)"
      + " values ($1,$2,true,'Catalog Operator'),($3,$4,true,'Team Leader'),"
      + "($5,$6,true,'Manager'),($7,$8,true,'Second Manager')",
    [
      ADMIN_APP, ADMIN_AUTH, LEADER_APP, LEADER_AUTH,
      MANAGER_APP, uuid(104), SECOND_MANAGER_APP, uuid(105),
    ],
  );
  await client.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)"
      + " values ($1,'catalog_master_manage',$2,true),($1,'recruiter_master_manage',$2,true),($1,'team_master_manage',$2,true),"
      + "($3,'team_manager_assign',$2,true)",
    [ADMIN_APP, PAST, LEADER_APP],
  );
  await client.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from,is_current)"
      + " values ($1,'all',null,$2,true),($3,'team',$4,$2,true)",
    [ADMIN_APP, PAST, LEADER_APP, TEAM_A],
  );
  await client.query(
    "insert into public.recruiters"
      + "(recruiter_id,display_name,personnel_code,personnel_position,active)"
      + " values ($1,'Team Leader','leader-lock','TEAM_LEADER',true),"
      + "($2,'Manager','manager-lock','STAFF',true),"
      + "($3,'Second Manager','manager-lock-2','STAFF',true)",
    [LEADER_RECRUITER, MANAGER_RECRUITER, SECOND_MANAGER_RECRUITER],
  );
  await client.query(
    "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from,is_current)"
      + " values ($1,'hrp',$4,true),($2,'hrp',$4,true),($3,'hrp',$4,true)",
    [LEADER_RECRUITER, MANAGER_RECRUITER, SECOND_MANAGER_RECRUITER, PAST],
  );
  await client.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from,is_current)"
      + " values ($1,$4,$5,true),($2,$4,$5,true),($3,$4,$5,true)",
    [LEADER_RECRUITER, MANAGER_RECRUITER, SECOND_MANAGER_RECRUITER, TEAM_A, PAST],
  );
  await client.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from,is_current)"
      + " values ($1,$3,true,$6,true),($2,$4,true,$6,true),($5,$7,true,$6,true)",
    [
      LEADER_APP, MANAGER_APP, LEADER_RECRUITER, MANAGER_RECRUITER,
      SECOND_MANAGER_APP, PAST, SECOND_MANAGER_RECRUITER,
    ],
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
      + " values ($1,'Concurrency Project',true,1)",
    [PROJECT],
  );
  // PRE-W2-HF Project<->Team mapping: the leader assignment is authorized for this pair,
  // so the race denials below come from the team move / leader revoke, not the mapping.
  const { rows: [{ reason_id: mappingReason }] } = await client.query(
    "select public.direct_entry_reason($1,'seed mapping') as reason_id",
    [ADMIN_APP],
  );
  await client.query(
    "insert into public.direct_entry_project_team_scopes"
      + "(project_id,team_id,valid_from,version,granted_by_user_id,reason_id,is_current)"
      + " values ($1,$2,$3,1,$4,$5,true)",
    [PROJECT, TEAM_A, PAST, ADMIN_APP, mappingReason],
  );
  return today;
}

test("P3.1-W02A serializes leader revocation and manager transfer against assignment in real PostgreSQL sessions",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the real concurrency regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "w02a-concurrency-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const port = await freePort();
    let serverStarted = false;
    let adminClient;
    let observer;
    let setup;
    let moveSession;
    let revokeSession;
    let assignSession;
    let assignment;
    let databaseName;
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
      run(pgCtl, [
        "-D", dataDir,
        "-l", logFile,
        "-o", `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w", "start",
      ], { ignoreOutput: process.platform === "win32" });
      serverStarted = true;
      databaseName = `w02a_${process.pid}`;
      adminClient = await connect(port);
      await adminClient.query(`create database ${databaseName}`);
      setup = await connect(port, databaseName, "w02a-setup");
      try {
        await applyMigrations(setup);
        const today = await seed(setup);
        const { rows: [{ version: managerVersion }] } = await setup.query(
          "select version from public.recruiters where recruiter_id=$1",
          [MANAGER_RECRUITER],
        );
        await setup.end();
        setup = undefined;

        moveSession = await connect(port, databaseName, "w02a-move");
        revokeSession = await connect(port, databaseName, "w02a-revoke");
        assignSession = await connect(port, databaseName, "w02a-assign");
        observer = await connect(port, databaseName, "w02a-observer");

        await moveSession.query("begin");
        await moveSession.query(
          "select public.direct_entry_move_team_membership($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ADMIN_AUTH, ADMIN_APP, MANAGER_RECRUITER, TEAM_B, today, managerVersion,
            "concurrency test manager team move", `move-${process.pid}`,
          ],
        );
        assignment = assignSession.query(
          "select public.direct_entry_assign_project_manager($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            LEADER_AUTH, LEADER_APP, PROJECT, MANAGER_RECRUITER, today, 1,
            "concurrency test assignment during team move", `assign-move-${process.pid}`,
          ],
        );
        await waitUntilBlocked(observer, "w02a-assign");
        await moveSession.query("commit");
        await assert.rejects(assignment, (error) => error.code === "42501");
        assignment = undefined;

        const { rows: [{ version: teamVersion }] } = await observer.query(
          "select version from public.teams where team_id=$1",
          [TEAM_A],
        );
        await revokeSession.query("begin");
        await revokeSession.query(
          "select public.direct_entry_revoke_team_leader($1,$2,$3,$4,$5,$6,$7)",
          [
            ADMIN_AUTH, ADMIN_APP, TEAM_A, today, teamVersion,
            "concurrency test leader revocation", `revoke-${process.pid}`,
          ],
        );
        assignment = assignSession.query(
          "select public.direct_entry_assign_project_manager($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            LEADER_AUTH, LEADER_APP, PROJECT, SECOND_MANAGER_RECRUITER, today, 1,
            "concurrency test assignment during leader revoke", `assign-revoke-${process.pid}`,
          ],
        );
        await waitUntilBlocked(observer, "w02a-assign");
        await revokeSession.query("commit");
        await assert.rejects(assignment, (error) => error.code === "42501");

        const { rows: [state] } = await observer.query(`
          select
            (select count(*)::int from public.direct_entry_project_manager_assignments) as assignments,
            (select version from public.direct_entry_projects where project_id=$1) as project_version,
            (select count(*)::int from public.direct_entry_project_revisions where project_id=$1) as revisions,
            (select count(*)::int from public.direct_entry_rpc_idempotency
              where app_user_id=$2 and action='project_manager_assignment_assign'
                and idempotency_key=any($3::text[])) as assignment_idempotency,
            (select count(*)::int from public.direct_entry_audit_events
              where action='project_manager_assignment_assign') as assignment_audits
        `, [
          PROJECT, LEADER_APP,
          [`assign-move-${process.pid}`, `assign-revoke-${process.pid}`],
        ]);
        assert.deepEqual(state, {
            assignments: 0,
            project_version: 1,
            revisions: 0,
            assignment_idempotency: 0,
            assignment_audits: 0,
        }, "a rejected post-revocation write leaves no assignment, revision, or replay residue");
      } finally {
        await setup?.end().catch(() => {});
      }
    } finally {
      await revokeSession?.query("rollback").catch(() => {});
      await assignment?.catch(() => {});
      await observer?.end().catch(() => {});
      await assignSession?.end().catch(() => {});
      await revokeSession?.end().catch(() => {});
      await moveSession?.end().catch(() => {});
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
