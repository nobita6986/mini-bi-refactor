/**
 * Hotfix: Block Move & Unassign on Active or Restorable Team Leader Assignment
 * Isolated Real PostgreSQL 18 Barrier Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test`) against an isolated PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 * Forces `SET LOCAL ROLE service_role`, `deadlock_timeout = '100ms'`, `statement_timeout = '8s'`, and verifies
 * genuine lock-wait via BOTH `pg_stat_activity.wait_event_type = 'Lock'` AND `pg_locks.granted = false`.
 *
 * Covers (all with ZERO `40P01` deadlocks and ZERO invariant violations):
 *   1. `direct_entry_designate_team_leader` vs `direct_entry_move_team_membership` (both barrier orders + trials)
 *   2. `direct_entry_designate_team_leader` vs `direct_entry_unassign_team_membership` (both barrier orders + trials)
 *   3. `direct_entry_disable_app_user` (and `enable_app_user`) vs `direct_entry_move_team_membership` (both barrier orders + trials)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const HF_MIGRATION_NAME = "20261126130000_hf_block_move_unassign_active_team_leader.sql";
const EXPECTED_TL_GUARD_MSG = "recruiter holds active or restorable team leader assignment";

const OWNER = {
  auth: "93000000-0000-4000-8000-00000000a001",
  app: "93000000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner HF PG18",
};
const LUANPT = {
  auth: "93000000-0000-4000-8000-00000000a002",
  app: "93000000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "93000000-0000-4000-8000-00000000a003",
  app: "93000000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "93000000-0000-4000-8000-00000000a004",
  app: "93000000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `93100000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `hf_pg18_${prefix}_${seq++}`;
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function runBin(file, args, { ignoreOutput = false } = {}) {
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
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceQuery(client, sql, params = []) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role",
  );
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function beginServiceTx(client) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role",
  );
}

function settleInTx(client, queryPromise) {
  return queryPromise.then(
    async (value) => {
      await client.query("commit");
      return { status: "fulfilled", value };
    },
    async (reason) => {
      await client.query("rollback").catch(() => {});
      return { status: "rejected", reason };
    },
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select a.pid,
              a.application_name,
              a.wait_event_type,
              a.wait_event,
              l.locktype,
              l.mode,
              coalesce(l.relation::regclass::text, l.locktype) as relation_name
         from pg_stat_activity a
         join pg_locks l
           on l.pid = a.pid
          and l.granted = false
        where a.application_name = $1
          and a.state = 'active'
          and a.wait_event_type = 'Lock'
        limit 1`,
      [appName],
    );
    if (rows.length === 1) {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const { rows: snap } = await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event, left(query, 120) as query_prefix
       from pg_stat_activity
      where application_name = $1`,
    [appName],
  );
  throw new Error(`Timed out waiting for ${appName} to block on Lock. Snapshot: ${JSON.stringify(snap)}`);
}

function assertNotDeadlock(res, label) {
  if (res?.status === "rejected") {
    assert.notEqual(res.reason?.code, "40P01", `${label} raised 40P01 deadlock: ${res.reason?.message}`);
  }
}

async function seedLegacyAdmin(client, user) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

const ASSIGN_TEAM_SQL =
  "select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const MOVE_TEAM_SQL =
  "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const UNASSIGN_TEAM_SQL =
  "select public.direct_entry_unassign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7) as data";
const DESIGNATE_TL_SQL =
  "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const DISABLE_USER_SQL =
  "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const ENABLE_USER_SQL =
  "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const CREATE_PERSON_SQL =
  "select public.org_department_create_person_admin($1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7::uuid, $8::int, $9::uuid, $10, $11::uuid, $12) as data";
const CREATE_PERSONNEL_SQL =
  "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7::date, $8, $9) as data";

test("HF PG18 Concurrency: designate_team_leader vs move/unassign & disable/enable vs move serialize cleanly with 0 40P01 deadlocks and 0 invariant violations", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL 18 initdb/pg_ctl binaries are required for real concurrency test");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hf-tl-guard-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "hf-tl-setup");
    const observer = await connect(port, "hf-tl-observer");
    const w1 = await connect(port, "hf-tl-w1");
    const w2 = await connect(port, "hf-tl-w2");
    clients.push(setup, observer, w1, w2);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;"
      + " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(groupsIdx > 0);
    assert.ok(files.includes(HF_MIGRATION_NAME));

    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i < files.length; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [{ today }] } = await setup.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const { rows: [recDept] } = await setup.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );

    async function assertZeroInvariantViolations(label) {
      const { rows: violations } = await observer.query(
        `select a.assignment_id, a.team_id as tl_team_id, a.leader_recruiter_id,
                m.team_id as mem_team_id
           from public.direct_entry_team_leader_assignments a
           left join public.recruiter_team_memberships m
             on m.recruiter_id = a.leader_recruiter_id
            and (m.valid_to is null or (m.valid_from <= public.direct_entry_authorization_date() and public.direct_entry_authorization_date() < m.valid_to))
          where (
            a.is_current = true
            or a.suspended_by_account_disable = true
            or public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, public.direct_entry_authorization_date())
          )
            and (m.team_id is distinct from a.team_id)`,
      );
      assert.deepEqual(
        violations,
        [],
        `${label}: zero recruiters may hold active/restorable TL on T1 while membership is moved/unassigned: ${JSON.stringify(violations)}`,
      );
    }

    async function seedCandidateInTeam(tag, teamId) {
      const auth = nextUuid();
      const app = nextUuid();
      const name = `Candidate ${tag}`;
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, `${tag}@hrpartner.local`]);
      await setup.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
         values ($1::uuid, $2::uuid, $3, true, true, 1)`,
        [app, auth, name],
      );
      const empCode = `EMP-${tag.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      const personRes = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          empCode,
          name,
          "2025-01-01",
          recDept.department_id,
          app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: name,
            joined_on: "2025-01-01",
            initial_department_ref: recDept.department_id,
            account_ref: app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ])
      ).rows[0].data;
      const recRes = (
        await serviceQuery(setup, CREATE_PERSONNEL_SQL, [
          OWNER.auth, OWNER.app, app, personRes.person.active_account_link.account_version, tag, "STAFF", null, `Create ${tag}`, nextKey(`rec_${tag}`),
        ])
      ).rows[0].data;
      const recruiterId = recRes.recruiter_id;
      await serviceQuery(setup, ASSIGN_TEAM_SQL, [
        OWNER.auth, OWNER.app, recruiterId, teamId, null, 1, `Assign ${tag}`, nextKey(`asg_${tag}`),
      ]);
      const { rows: [recRow] } = await observer.query(
        "select version from public.recruiters where recruiter_id = $1::uuid",
        [recruiterId],
      );
      const { rows: [accRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [app],
      );
      return { auth, app, recruiterId, recruiterVersion: recRow.version, accountVersion: accRow.version };
    }

    async function seedPairTeams(tag) {
      const t1 = nextUuid();
      const t2 = nextUuid();
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, $3, $4, true, 1), ($2::uuid, $5, $6, true, 1)`,
        [t1, t2, `HF_T1_${tag}`, `Team 1 ${tag}`, `HF_T2_${tag}`, `Team 2 ${tag}`],
      );
      return { t1, t2 };
    }

    // -------------------------------------------------------------------------
    // 1. designate_team_leader vs move_team_membership (both barrier orders)
    // -------------------------------------------------------------------------
    {
      const { t1, t2 } = await seedPairTeams("des_move_1");
      const cand = await seedCandidateInTeam("dm1", t1);

      // 1A: Move holds U & R first -> Designate blocks on Lock -> Move commits -> Designate rejects cleanly
      await beginServiceTx(w1);
      await w1.query(MOVE_TEAM_SQL, [
        OWNER.auth, OWNER.app, cand.recruiterId, t2, today, cand.recruiterVersion, "Barrier move first", nextKey("b_mv1"),
      ]);
      await beginServiceTx(w2);
      const pDes = settleInTx(
        w2,
        w2.query(DESIGNATE_TL_SQL, [
          OWNER.auth, OWNER.app, t1, cand.app, today, 1, "Barrier designate second", nextKey("b_des1"),
        ]),
      );
      const waitDes = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitDes.wait_event_type, "Lock");
      await w1.query("commit");
      const rDes = await pDes;
      assertNotDeadlock(rDes, "1A designate after move");
      assert.equal(rDes.status, "rejected");
      assert.notEqual(rDes.reason?.code, "40P01");
      await assertZeroInvariantViolations("1A");
    }

    {
      const { t1, t2 } = await seedPairTeams("des_move_2");
      const cand = await seedCandidateInTeam("dm2", t1);

      // 1B: Designate holds U & R & T first -> Move blocks on Lock -> Designate commits -> Move rejects PT409 active TL
      await beginServiceTx(w1);
      await w1.query(DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, t1, cand.app, today, 1, "Barrier designate first", nextKey("b_des2"),
      ]);
      await beginServiceTx(w2);
      const pMv = settleInTx(
        w2,
        w2.query(MOVE_TEAM_SQL, [
          OWNER.auth, OWNER.app, cand.recruiterId, t2, today, cand.recruiterVersion, "Barrier move second", nextKey("b_mv2"),
        ]),
      );
      const waitMv = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitMv.wait_event_type, "Lock");
      await w1.query("commit");
      const rMv = await pMv;
      assertNotDeadlock(rMv, "1B move after designate");
      assert.equal(rMv.status, "rejected");
      assert.equal(rMv.reason?.code, "PT409");
      assert.equal(rMv.reason?.message, EXPECTED_TL_GUARD_MSG);
      await assertZeroInvariantViolations("1B");
    }

    // -------------------------------------------------------------------------
    // 2. designate_team_leader vs unassign_team_membership (both barrier orders)
    // -------------------------------------------------------------------------
    {
      const { t1 } = await seedPairTeams("des_un_1");
      const cand = await seedCandidateInTeam("du1", t1);

      // 2A: Unassign holds U & R first -> Designate blocks on Lock -> Unassign commits -> Designate rejects cleanly
      await beginServiceTx(w1);
      await w1.query(UNASSIGN_TEAM_SQL, [
        OWNER.auth, OWNER.app, cand.recruiterId, today, cand.recruiterVersion, "Barrier unassign first", nextKey("b_un1"),
      ]);
      await beginServiceTx(w2);
      const pDes = settleInTx(
        w2,
        w2.query(DESIGNATE_TL_SQL, [
          OWNER.auth, OWNER.app, t1, cand.app, today, 1, "Barrier designate after unassign", nextKey("b_des3"),
        ]),
      );
      const waitDes = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitDes.wait_event_type, "Lock");
      await w1.query("commit");
      const rDes = await pDes;
      assertNotDeadlock(rDes, "2A designate after unassign");
      assert.equal(rDes.status, "rejected");
      assert.notEqual(rDes.reason?.code, "40P01");
      await assertZeroInvariantViolations("2A");
    }

    {
      const { t1 } = await seedPairTeams("des_un_2");
      const cand = await seedCandidateInTeam("du2", t1);

      // 2B: Designate holds U & R & T first -> Unassign blocks on Lock -> Designate commits -> Unassign rejects PT409 active TL
      await beginServiceTx(w1);
      await w1.query(DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, t1, cand.app, today, 1, "Barrier designate before unassign", nextKey("b_des4"),
      ]);
      await beginServiceTx(w2);
      const pUn = settleInTx(
        w2,
        w2.query(UNASSIGN_TEAM_SQL, [
          OWNER.auth, OWNER.app, cand.recruiterId, today, cand.recruiterVersion, "Barrier unassign second", nextKey("b_un2"),
        ]),
      );
      const waitUn = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitUn.wait_event_type, "Lock");
      await w1.query("commit");
      const rUn = await pUn;
      assertNotDeadlock(rUn, "2B unassign after designate");
      assert.equal(rUn.status, "rejected");
      assert.equal(rUn.reason?.code, "PT409");
      assert.equal(rUn.reason?.message, EXPECTED_TL_GUARD_MSG);
      await assertZeroInvariantViolations("2B");
    }

    // -------------------------------------------------------------------------
    // 3. disable_app_user / enable_app_user vs move_team_membership (both barrier orders)
    // -------------------------------------------------------------------------
    {
      const { t1, t2 } = await seedPairTeams("dis_mv_1");
      const tl = await seedCandidateInTeam("dismv1", t1);
      await serviceQuery(setup, DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, t1, tl.app, today, 1, "Designate TL before disable race", nextKey("des_dismv1"),
      ]);
      const { rows: [accRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [tl.app],
      );
      const { rows: [recRow] } = await observer.query(
        "select version from public.recruiters where recruiter_id = $1::uuid",
        [tl.recruiterId],
      );

      // 3A: Disable holds U first -> Move blocks on Lock -> Disable commits (suspends TL) -> Move rejects PT409 restorable TL
      await beginServiceTx(w1);
      await w1.query(DISABLE_USER_SQL, [
        OWNER.auth, OWNER.app, tl.app, accRow.version, "Barrier disable TL first", nextKey("b_dis1"),
      ]);
      await beginServiceTx(w2);
      const pMv = settleInTx(
        w2,
        w2.query(MOVE_TEAM_SQL, [
          OWNER.auth, OWNER.app, tl.recruiterId, t2, today, recRow.version, "Barrier move during disable", nextKey("b_mv_dis1"),
        ]),
      );
      const waitMv = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitMv.wait_event_type, "Lock");
      await w1.query("commit");
      const rMv = await pMv;
      assertNotDeadlock(rMv, "3A move after disable");
      assert.equal(rMv.status, "rejected");
      assert.equal(rMv.reason?.code, "PT409");
      assert.equal(rMv.reason?.message, EXPECTED_TL_GUARD_MSG);
      await assertZeroInvariantViolations("3A");

      // 3B: Enable holds U first -> Move blocks on Lock -> Enable commits (restores TL) -> Move rejects PT409 active TL
      const { rows: [accRow2] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [tl.app],
      );
      await beginServiceTx(w1);
      await w1.query(ENABLE_USER_SQL, [
        OWNER.auth, OWNER.app, tl.app, accRow2.version, "Barrier enable TL first", nextKey("b_en1"),
      ]);
      await beginServiceTx(w2);
      const pMv2 = settleInTx(
        w2,
        w2.query(MOVE_TEAM_SQL, [
          OWNER.auth, OWNER.app, tl.recruiterId, t2, today, recRow.version, "Barrier move during enable", nextKey("b_mv_en1"),
        ]),
      );
      const waitMv2 = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitMv2.wait_event_type, "Lock");
      await w1.query("commit");
      const rMv2 = await pMv2;
      assertNotDeadlock(rMv2, "3B move after enable");
      assert.equal(rMv2.status, "rejected");
      assert.equal(rMv2.reason?.code, "PT409");
      assert.equal(rMv2.reason?.message, EXPECTED_TL_GUARD_MSG);
      await assertZeroInvariantViolations("3B");
    }

    {
      const { t1, t2 } = await seedPairTeams("dis_mv_2");
      const nonTl = await seedCandidateInTeam("dismv2", t1);

      // 3C: Move holds U & R first -> Disable blocks on Lock -> Move commits -> Disable commits cleanly, 0 40P01
      await beginServiceTx(w1);
      await w1.query(MOVE_TEAM_SQL, [
        OWNER.auth, OWNER.app, nonTl.recruiterId, t2, today, nonTl.recruiterVersion, "Barrier move before disable", nextKey("b_mv_dis2"),
      ]);
      await beginServiceTx(w2);
      const pDis = settleInTx(
        w2,
        w2.query(DISABLE_USER_SQL, [
          OWNER.auth, OWNER.app, nonTl.app, nonTl.accountVersion, "Barrier disable after move", nextKey("b_dis2"),
        ]),
      );
      const waitDis = await waitUntilBlocked(observer, "hf-tl-w2");
      assert.equal(waitDis.wait_event_type, "Lock");
      await w1.query("commit");
      const rDis = await pDis;
      assertNotDeadlock(rDis, "3C disable after move");
      assert.equal(rDis.status, "fulfilled", `Disable after move should succeed cleanly: ${rDis.reason?.message}`);
      await assertZeroInvariantViolations("3C");
    }

    // -------------------------------------------------------------------------
    // 4. Multi-trial concurrent Promise.all races across all 3 pairs (0 40P01, 0 invariant violations)
    // -------------------------------------------------------------------------
    for (let trial = 0; trial < 4; trial += 1) {
      // Trial pair A: designate vs move
      {
        const { t1, t2 } = await seedPairTeams(`trial_dm_${trial}`);
        const cand = await seedCandidateInTeam(`tdm_${trial}`, t1);
        const [r1, r2] = await Promise.all([
          serviceQuery(w1, DESIGNATE_TL_SQL, [
            OWNER.auth, OWNER.app, t1, cand.app, today, 1, `Trial designate ${trial}`, nextKey(`t_des_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
          serviceQuery(w2, MOVE_TEAM_SQL, [
            OWNER.auth, OWNER.app, cand.recruiterId, t2, today, cand.recruiterVersion, `Trial move ${trial}`, nextKey(`t_mv_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
        ]);
        assertNotDeadlock(r1, `trial ${trial} designate`);
        assertNotDeadlock(r2, `trial ${trial} move`);
        assert.notEqual(
          r1.status === "fulfilled" && r2.status === "fulfilled",
          true,
          `trial ${trial}: designate and move must NEVER both succeed`,
        );
        await assertZeroInvariantViolations(`trial_dm_${trial}`);
      }

      // Trial pair B: designate vs unassign
      {
        const { t1 } = await seedPairTeams(`trial_du_${trial}`);
        const cand = await seedCandidateInTeam(`tdu_${trial}`, t1);
        const [r1, r2] = await Promise.all([
          serviceQuery(w1, DESIGNATE_TL_SQL, [
            OWNER.auth, OWNER.app, t1, cand.app, today, 1, `Trial designate u ${trial}`, nextKey(`t_desu_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
          serviceQuery(w2, UNASSIGN_TEAM_SQL, [
            OWNER.auth, OWNER.app, cand.recruiterId, today, cand.recruiterVersion, `Trial unassign ${trial}`, nextKey(`t_un_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
        ]);
        assertNotDeadlock(r1, `trial ${trial} designate-unassign`);
        assertNotDeadlock(r2, `trial ${trial} unassign`);
        assert.notEqual(
          r1.status === "fulfilled" && r2.status === "fulfilled",
          true,
          `trial ${trial}: designate and unassign must NEVER both succeed`,
        );
        await assertZeroInvariantViolations(`trial_du_${trial}`);
      }

      // Trial pair C: disable vs move on active TL
      {
        const { t1, t2 } = await seedPairTeams(`trial_dismv_${trial}`);
        const tl = await seedCandidateInTeam(`tdismv_${trial}`, t1);
        await serviceQuery(setup, DESIGNATE_TL_SQL, [
          OWNER.auth, OWNER.app, t1, tl.app, today, 1, `Trial TL ${trial}`, nextKey(`t_tl_${trial}`),
        ]);
        const { rows: [accRow] } = await observer.query(
          "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
          [tl.app],
        );
        const { rows: [recRow] } = await observer.query(
          "select version from public.recruiters where recruiter_id = $1::uuid",
          [tl.recruiterId],
        );
        const [r1, r2] = await Promise.all([
          serviceQuery(w1, DISABLE_USER_SQL, [
            OWNER.auth, OWNER.app, tl.app, accRow.version, `Trial disable ${trial}`, nextKey(`t_dis_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
          serviceQuery(w2, MOVE_TEAM_SQL, [
            OWNER.auth, OWNER.app, tl.recruiterId, t2, today, recRow.version, `Trial move vs disable ${trial}`, nextKey(`t_mvd_${trial}`),
          ]).then((v) => ({ status: "fulfilled", value: v }), (reason) => ({ status: "rejected", reason })),
        ]);
        assertNotDeadlock(r1, `trial ${trial} disable`);
        assertNotDeadlock(r2, `trial ${trial} move-vs-disable`);
        assert.equal(r1.status, "fulfilled", `trial ${trial} disable must succeed`);
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.equal(r2.reason?.message, EXPECTED_TL_GUARD_MSG);
        await assertZeroInvariantViolations(`trial_dismv_${trial}`);
      }
    }

    console.log("[PG18 HF TL Guard Concurrency] All barrier & concurrent race checks passed with 0 40P01 deadlocks and 0 invariant violations.");
  } finally {
    for (const c of clients) {
      await c?.query("rollback").catch(() => {});
      await c?.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
