/**
 * WP1/S1 — Real PostgreSQL Concurrency Regression Suite for Immediate Assignments.
 *
 * Proves against isolated local PostgreSQL (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Deterministic lock-hold race on Ending Team Membership (`direct_entry_unassign_team_membership`):
 *      two concurrent operators unassigning the same recruiter (`expected_version = 1`, `p_valid_to = null`)
 *      serialize on the recruiter row lock; strictly 1 succeeds (`recruiter_version = 2`, `is_current = false`)
 *      and the contender rejects with `PT409` (`recruiter version conflict`), with 0 duplicate revisions.
 *   2. Deterministic lock-hold race on Leave Department Approver Handover (`leave_management_set_department_approver_admin`):
 *      two concurrent admins replacing the `MARKETING` approver (`expected_row_version = 1`, `p_valid_from = null`)
 *      serialize on `leave_management__internal_lock_unit('MARKETING')`; strictly 1 succeeds (`row_version = 2`)
 *      and the contender rejects with `PT409` (`LEAVE_ROW_VERSION_CONFLICT`), preserving a single active approver.
 *   3. Deterministic lock-hold race on Team Leader Handover (`direct_entry_designate_team_leader`):
 *      two concurrent operators replacing `LEADER_1` on `TEAM_RACE` (`expected_version = 2`, `p_effective_date = null`)
 *      with `LEADER_2` vs `LEADER_3` serialize on the `teams` row lock; strictly 1 succeeds (`version = 3`),
 *      the contender rejects with `PT409` (`team version conflict`), and all 5 leader capabilities are cleanly
 *      closed on `LEADER_1`, active on the winner (`LEADER_2`), and absent on the loser (`LEADER_3`).
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
const WP1_MIGRATION_NAME = "20261112120000_wp1_s1_block_future_org_authz_assignments.sql";

const ADMIN = {
  auth: "1b000000-0000-4000-8000-000000000001",
  app: "2b000000-0000-4000-8000-000000000001",
  name: "Full Admin Race",
};
const LEADER_1 = {
  auth: "1b000000-0000-4000-8000-000000000002",
  app: "2b000000-0000-4000-8000-000000000002",
  recruiter: "3b000000-0000-4000-8000-000000000002",
  code: "TL_WP1_1",
  name: "Leader 1 Race",
};
const LEADER_2 = {
  auth: "1b000000-0000-4000-8000-000000000003",
  app: "2b000000-0000-4000-8000-000000000003",
  recruiter: "3b000000-0000-4000-8000-000000000003",
  code: "TL_WP1_2",
  name: "Leader 2 Race",
};
const LEADER_3 = {
  auth: "1b000000-0000-4000-8000-000000000004",
  app: "2b000000-0000-4000-8000-000000000004",
  recruiter: "3b000000-0000-4000-8000-000000000004",
  code: "TL_WP1_3",
  name: "Leader 3 Race",
};
const MEMBER_1 = {
  auth: "1b000000-0000-4000-8000-000000000005",
  app: "2b000000-0000-4000-8000-000000000005",
  recruiter: "3b000000-0000-4000-8000-000000000005",
  code: "MEM_WP1_1",
  name: "Member 1 Race",
};
const MKT_APP_1 = {
  auth: "1b000000-0000-4000-8000-000000000006",
  app: "2b000000-0000-4000-8000-000000000006",
  name: "Marketing Approver 1",
};
const MKT_APP_2 = {
  auth: "1b000000-0000-4000-8000-000000000007",
  app: "2b000000-0000-4000-8000-000000000007",
  name: "Marketing Approver 2",
};
const MKT_APP_3 = {
  auth: "1b000000-0000-4000-8000-000000000008",
  app: "2b000000-0000-4000-8000-000000000008",
  name: "Marketing Approver 3",
};

const TEAM_RACE = "4b000000-0000-4000-8000-000000000001";
const TODAY = "2026-11-12";
const PAST = "2026-01-01";

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

async function connect(port, database = "postgres", applicationName = "wp1-s1-race") {
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
  assert.ok(
    names.includes(WP1_MIGRATION_NAME),
    `migration inventory must include ${WP1_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seedFixture(client) {
  await client.query(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${TODAY}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);

  await client.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'WP1_RACE_TM', 'Team Race WP1', true, 1)`,
    [TEAM_RACE],
  );

  for (const person of [
    ADMIN,
    LEADER_1,
    LEADER_2,
    LEADER_3,
    MEMBER_1,
    MKT_APP_1,
    MKT_APP_2,
    MKT_APP_3,
  ]) {
    await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
      person.auth,
      `${person.name.toLowerCase().replaceAll(" ", ".")}@company.local`,
    ]);
    await client.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
       values ($1::uuid, $2::uuid, true, $3)`,
      [person.app, person.auth, person.name],
    );
  }

  for (const cap of [
    "entry_admin",
    "recruiter_master_manage",
    "team_master_manage",
    "catalog_master_manage",
  ]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, $3::date, true)`,
      [ADMIN.app, cap, PAST],
    );
  }
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', $2::date, true)`,
    [ADMIN.app, PAST],
  );

  for (const person of [LEADER_1, LEADER_2, LEADER_3, MEMBER_1]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', $2::date, true)`,
      [person.app, PAST],
    );
    await client.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', $2::date, true)`,
      [person.app, PAST],
    );
    await client.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, $2, $3, 'STAFF', true, 1)`,
      [person.recruiter, person.name, person.code],
    );
    await client.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', $2::date, true)`,
      [person.recruiter, PAST],
    );
    await client.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::date, true)`,
      [person.recruiter, TEAM_RACE, PAST],
    );
    await client.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, $3::date, true)`,
      [person.app, person.recruiter, PAST],
    );
  }

  for (const mkt of [MKT_APP_1, MKT_APP_2, MKT_APP_3]) {
    await client.query(
      `insert into public.leave_employee_profiles
         (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)
       values ($1::uuid, 'MARKETING', 'OFFICIAL', $2::date, $2::date, false)`,
      [mkt.app, PAST],
    );
  }

  // Initial Team Leader 1 on TEAM_RACE (version becomes 2)
  await client.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Seed Leader 1', 'race-seed-tl1'
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_RACE, LEADER_1.app, PAST],
  );

  // Initial Marketing Approver 1 (row_version = 1)
  await client.query(
    `select public.leave_management_set_department_approver_admin(
       $1::uuid, $2::uuid, 'MARKETING', $3::uuid, $4::date, 0, 'Seed MKT Approver 1', 'race-seed-mkt1', 'fp-race-seed-mkt1'
     )`,
    [ADMIN.auth, ADMIN.app, MKT_APP_1.app, PAST],
  );
}

test("WP1/S1 Real PostgreSQL Concurrency: Team Membership Unassign, Leave Department Approver, and Team Leader Handover", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries (initdb/pg_ctl) not found in environment");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wp1-s1-pg-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  let started = false;

  try {
    run(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    run(
      pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-o",
        `-h 127.0.0.1 -p ${port} -k ""`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "postgres", "wp1-setup");
    const c1 = await connect(port, "postgres", "wp1-c1");
    const c2 = await connect(port, "postgres", "wp1-c2");

    try {
      await applyMigrations(setup);
      await seedFixture(setup);

      // -----------------------------------------------------------------------
      // Race 1: Concurrent Ending of Team Membership (`direct_entry_unassign_team_membership`)
      // -----------------------------------------------------------------------
      await c1.query("begin");
      const r1Win = await c1.query(
        `select public.direct_entry_unassign_team_membership(
           $1::uuid, $2::uuid, $3::uuid, null, 1, 'Operator 1 unassign', 'race-unassign-1'
         ) as res`,
        [ADMIN.auth, ADMIN.app, MEMBER_1.recruiter],
      );
      assert.equal(r1Win.rows[0].res.change, "UNASSIGN");
      assert.equal(r1Win.rows[0].res.valid_to, TODAY);

      const c2UnassignPromise = c2
        .query(
          `select public.direct_entry_unassign_team_membership(
             $1::uuid, $2::uuid, $3::uuid, null, 1, 'Operator 2 unassign', 'race-unassign-2'
           ) as res`,
          [ADMIN.auth, ADMIN.app, MEMBER_1.recruiter],
        )
        .then(
          (res) => ({ ok: true, res }),
          (err) => ({ ok: false, code: err.code, message: err.message }),
        );

      await waitUntilBlocked(setup, "wp1-c2");
      await c1.query("commit");

      const r1Lose = await c2UnassignPromise;
      assert.equal(r1Lose.ok, false, "Second concurrent unassign must fail with version conflict");
      assert.equal(r1Lose.code, "PT409");

      const { rows: memberRevs } = await setup.query(
        "select count(*)::int as cnt from public.direct_entry_team_membership_revisions where recruiter_id = $1::uuid",
        [MEMBER_1.recruiter],
      );
      assert.equal(memberRevs[0].cnt, 1, "Strictly 1 revision recorded for MEMBER_1 unassign");

      // -----------------------------------------------------------------------
      // Race 2: Concurrent Leave Department Approver Handover (`leave_management_set_department_approver_admin`)
      // -----------------------------------------------------------------------
      await c1.query("begin");
      const r2Win = await c1.query(
        `select public.leave_management_set_department_approver_admin(
           $1::uuid, $2::uuid, 'MARKETING', $3::uuid, null, 1,
           'Handover to MKT Approver 2', 'race-mkt-1', 'fp-race-mkt-1'
         ) as res`,
        [ADMIN.auth, ADMIN.app, MKT_APP_2.app],
      );
      assert.equal(r2Win.rows[0].res.department_approver.approver_app_user_id, MKT_APP_2.app);
      assert.equal(r2Win.rows[0].res.department_approver.row_version, 2);

      const c2MktPromise = c2
        .query(
          `select public.leave_management_set_department_approver_admin(
             $1::uuid, $2::uuid, 'MARKETING', $3::uuid, null, 1,
             'Handover to MKT Approver 3', 'race-mkt-2', 'fp-race-mkt-2'
           ) as res`,
          [ADMIN.auth, ADMIN.app, MKT_APP_3.app],
        )
        .then(
          (res) => ({ ok: true, res }),
          (err) => ({ ok: false, code: err.code, message: err.message }),
        );

      await waitUntilBlocked(setup, "wp1-c2");
      await c1.query("commit");

      const r2Lose = await c2MktPromise;
      assert.equal(r2Lose.ok, false, "Second concurrent leave approver handover must fail with PT409");
      assert.equal(r2Lose.code, "PT409");

      const { rows: currentMktRows } = await setup.query(
        `select approver_app_user_id::text, valid_from::text, valid_to::text, is_current, row_version
           from public.leave_department_approvers
          where unit_kind = 'MARKETING' and is_current = true`,
      );
      assert.equal(currentMktRows.length, 1);
      assert.equal(currentMktRows[0].approver_app_user_id, MKT_APP_2.app);
      assert.equal(currentMktRows[0].valid_from, TODAY);
      assert.equal(currentMktRows[0].valid_to, null);

      // -----------------------------------------------------------------------
      // Race 3: Concurrent Team Leader Handover (`direct_entry_designate_team_leader`)
      // -----------------------------------------------------------------------
      await c1.query("begin");
      const r3Win = await c1.query(
        `select public.direct_entry_designate_team_leader(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 2,
           'Handover to Leader 2', 'race-tl-1'
         ) as res`,
        [ADMIN.auth, ADMIN.app, TEAM_RACE, LEADER_2.app],
      );
      assert.equal(r3Win.rows[0].res.change, "replace");
      assert.equal(r3Win.rows[0].res.leader_app_user_id, LEADER_2.app);
      assert.equal(r3Win.rows[0].res.version, 3);

      const c2TlPromise = c2
        .query(
          `select public.direct_entry_designate_team_leader(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 2,
             'Handover to Leader 3', 'race-tl-2'
           ) as res`,
          [ADMIN.auth, ADMIN.app, TEAM_RACE, LEADER_3.app],
        )
        .then(
          (res) => ({ ok: true, res }),
          (err) => ({ ok: false, code: err.code, message: err.message }),
        );

      await waitUntilBlocked(setup, "wp1-c2");
      await c1.query("commit");

      const r3Lose = await c2TlPromise;
      assert.equal(r3Lose.ok, false, "Second concurrent team leader handover must fail with PT409");
      assert.equal(r3Lose.code, "PT409");

      const { rows: activeLeaders } = await setup.query(
        `select leader_app_user_id::text, valid_from::text, valid_to::text, is_current
           from public.direct_entry_team_leader_assignments
          where team_id = $1::uuid and is_current = true`,
        [TEAM_RACE],
      );
      assert.deepEqual(activeLeaders, [
        {
          leader_app_user_id: LEADER_2.app,
          valid_from: TODAY,
          valid_to: null,
          is_current: true,
        },
      ]);

      const { rows: leader3Caps } = await setup.query(
        `select capability from public.direct_entry_capability_grants
          where app_user_id = $1::uuid and capability <> 'entry_own'`,
        [LEADER_3.app],
      );
      assert.equal(leader3Caps.length, 0, "Contender LEADER_3 must have 0 leader capabilities");
    } finally {
      await c1.end().catch(() => {});
      await c2.end().catch(() => {});
      await setup.end().catch(() => {});
    }
  } finally {
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
