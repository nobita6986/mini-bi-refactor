/**
 * WP3B — TM-12 Real PostgreSQL Concurrency Regression Suite.
 *
 * Proves against isolated local PostgreSQL (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Deterministic lock-hold race on `org_department_transfer_person_member_admin`:
 *      strictly 1 commits, contender rejects with `PT409` (`0` `40P01` deadlocks), active dept row <= 1.
 *   2. Deterministic lock-hold race on `org_department_designate_head_admin`:
 *      strictly 1 commits, contender rejects with `PT409`, active HEAD row for dept <= 1.
 *   3. Parallel `org_department_link_account_person_admin` races (both same-account & same-person):
 *      strictly 1 wins, contenders reject `PT409`, active links per account & per person <= 1.
 *   4. Parallel cross-writer race (`org_department_assign_accounting_member` vs
 *      `org_department_assign_person_member_admin` into `MARKETING`):
 *      strictly 1 wins, 1 rejects `PT409`, zero `40P01` deadlocks, and legacy `ACCOUNTING` projection
 *      stays consistent with `person_department_memberships`.
 *   5. Parallel 3-way display name sync race (`direct_entry_account_operation_update_display_name`
 *      vs `org_department_update_person_admin`):
 *      serializes cleanly (`0` `40P01`, any loser is `PT409`), and `persons.full_name`,
 *      `direct_entry_app_users.display_name`, `recruiters.display_name` end identical.
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
  computeAssignAccountingMemberFingerprint,
  computeAssignPersonMemberFingerprint,
  computeDesignateHeadFingerprint,
  computeEndHeadFingerprint,
  computeEndPersonMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUpdatePersonFingerprint,
} from "../src/lib/organization/person-contract.ts";
import { WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN_1 = {
  auth: "19200000-0000-4000-8000-000000000001",
  app: "29200000-0000-4000-8000-000000000001",
  name: "WP3 Admin One",
};
const ADMIN_2 = {
  auth: "19200000-0000-4000-8000-000000000002",
  app: "29200000-0000-4000-8000-000000000002",
  name: "WP3 Admin Two",
};
const USERS = Array.from({ length: 5 }, (_, i) => ({
  auth: `19200000-0000-4000-8000-00000000001${i + 1}`,
  app: `29200000-0000-4000-8000-00000000001${i + 1}`,
  name: `WP3 Target User ${i + 1}`,
}));
const REC_SYNC = {
  id: "39200000-0000-4000-8000-000000000005",
  code: "REC-SYNC-05",
  name: "WP3 Target User 5",
};

let keySeq = 1;
function nextKey() {
  const hex = (keySeq++).toString(16).padStart(12, "0");
  return `99200000-0000-4000-8000-${hex}`;
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

async function connect(port, database = "postgres", applicationName = "wp3-race") {
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
    names.includes(WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME),
    `migration inventory must include ${WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seedActors(client) {
  for (const person of [ADMIN_1, ADMIN_2, ...USERS]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.name.toLowerCase().replaceAll(" ", ".")}@company.local`,
    ]);
    await client.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, account_type, enabled, version) values ($1, $2, $3, 'NORMAL', true, 1)",
      [person.app, person.auth, person.name],
    );
  }
  for (const admin of [ADMIN_1, ADMIN_2]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1, 'entry_admin', '2026-01-01', true),
              ($1, 'recruiter_master_manage', '2026-01-01', true),
              ($1, 'team_master_manage', '2026-01-01', true)`,
      [admin.app],
    );
    await client.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1, 'all', '2026-01-01', true)`,
      [admin.app],
    );
  }
  await client.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, 'STAFF', true)`,
    [REC_SYNC.id, REC_SYNC.name, REC_SYNC.code],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
     values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
    [REC_SYNC.id],
  );
  await client.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
    [USERS[4].app, REC_SYNC.id],
  );
}

const CREATE_PERSON_SQL =
  "select public.org_department_create_person_admin($1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7::uuid, $8::int, $9::uuid, $10, $11::uuid, $12) as data";
const TRANSFER_SQL =
  "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data";
const DESIGNATE_HEAD_SQL =
  "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data";
const END_HEAD_SQL =
  "select public.org_department_end_head_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6, $7::uuid, $8) as data";
const END_PERSON_DEPT_SQL =
  "select public.org_department_end_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const LINK_SQL =
  "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::int, $7::uuid, $8, $9::uuid, $10) as data";
const ASSIGN_ACCT_SQL =
  "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6, $7::uuid, $8) as data";
const ASSIGN_PERSON_DEPT_SQL =
  "select public.org_department_assign_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const UPDATE_PERSON_SQL =
  "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7::date, $8, $9, $10::uuid, $11) as data";
const UPDATE_DISPLAY_NAME_SQL =
  "select public.direct_entry_account_operation_update_display_name($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6, $7) as data";

async function createPerson(client, { code, fullName, deptId = null, accountRef = null, expectedAccountVer = null, recruiterId = null, reason }) {
  const key = nextKey();
  const fp = computeCreatePersonFingerprint(ADMIN_1.app, {
    employee_code: code,
    full_name: fullName,
    joined_on: null,
    initial_department_ref: deptId,
    account_ref: accountRef,
    expected_account_version: expectedAccountVer,
    recruiter_id: recruiterId,
    reason,
    idempotency_key: key,
  });
  const res = await client.query(CREATE_PERSON_SQL, [
    ADMIN_1.auth,
    ADMIN_1.app,
    code,
    fullName,
    null,
    deptId,
    accountRef,
    expectedAccountVer,
    recruiterId,
    reason,
    key,
    fp,
  ]);
  return res.rows[0].data.person;
}

function assertNotDeadlockAndSingleWinner(settled, label) {
  for (const r of settled) {
    if (r.status === "rejected") {
      assert.notEqual(r.reason?.code, "40P01", `${label}: deadlock 40P01 must never occur`);
      assert.equal(r.reason?.code, "PT409", `${label}: contender must reject with PT409, got ${r.reason?.code} ${r.reason?.message}`);
    }
  }
  const winners = settled.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1, `${label}: strictly 1 contender must succeed`);
  assert.equal(settled.length - winners.length, settled.length - 1);
  return winners[0].value.rows[0].data;
}

test("WP3B TM-12 real PostgreSQL concurrency: transfer, head, link, cross-writer accounting, and 3-way name sync serialize cleanly with 0 deadlocks", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wp3b-person-org-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `wp3b_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
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

    setup = await connect(port, databaseName, "wp3-setup");
    await applyMigrations(setup);
    await seedActors(setup);

    const deptRows = (await setup.query("select department_id, system_key from public.organization_departments")).rows;
    const deptByKey = new Map(deptRows.map((r) => [r.system_key, r.department_id]));
    const recDeptId = deptByKey.get("RECRUITMENT");
    const mktDeptId = deptByKey.get("MARKETING");
    const itDeptId = deptByKey.get("IT");

    await setup.query("set role service_role");
    const pTransfer = await createPerson(setup, {
      code: "TM12-TR-01",
      fullName: "Transfer Race Person",
      deptId: recDeptId,
      reason: "Setup transfer race",
    });
    const pHead1 = await createPerson(setup, {
      code: "TM12-HD-01",
      fullName: "Head Candidate One",
      deptId: itDeptId,
      reason: "Setup head 1",
    });
    const pHead2 = await createPerson(setup, {
      code: "TM12-HD-02",
      fullName: "Head Candidate Two",
      deptId: itDeptId,
      reason: "Setup head 2",
    });
    const pLinkA = await createPerson(setup, { code: "TM12-LK-01", fullName: "Link Person A", reason: "Setup link A" });
    const pLinkB = await createPerson(setup, { code: "TM12-LK-02", fullName: "Link Person B", reason: "Setup link B" });
    const pLinkC = await createPerson(setup, { code: "TM12-LK-03", fullName: "Link Person C", reason: "Setup link C" });
    const pCross = await createPerson(setup, {
      code: "TM12-CR-01",
      fullName: "Cross Writer Person",
      accountRef: USERS[3].app,
      expectedAccountVer: 1,
      reason: "Setup cross-writer race",
    });
    const pSync = await createPerson(setup, {
      code: "TM12-SY-01",
      fullName: REC_SYNC.name,
      accountRef: USERS[4].app,
      expectedAccountVer: 1,
      recruiterId: REC_SYNC.id,
      reason: "Setup 3-way display name sync",
    });
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "wp3-observer");
    worker1 = await connect(port, databaseName, "wp3-worker-1");
    worker2 = await connect(port, databaseName, "wp3-worker-2");

    // -------------------------------------------------------------------------
    // Stage 1: Deterministic lock-hold race on `transfer_person_member_admin`
    // -------------------------------------------------------------------------
    const kTr1 = nextKey();
    const kTr2 = nextKey();
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    await worker1.query(TRANSFER_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      pTransfer.person_id,
      mktDeptId,
      pTransfer.version,
      pTransfer.active_department.membership_id,
      "Transfer worker 1",
      kTr1,
      computeTransferPersonDepartmentFingerprint(ADMIN_1.app, pTransfer.person_id, {
        target_department_ref: mktDeptId,
        expected_person_version: pTransfer.version,
        expected_current_membership_id: pTransfer.active_department.membership_id,
        reason: "Transfer worker 1",
        idempotency_key: kTr1,
      }),
    ]);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedTransfer = worker2.query(TRANSFER_SQL, [
      ADMIN_2.auth,
      ADMIN_2.app,
      pTransfer.person_id,
      itDeptId,
      pTransfer.version,
      pTransfer.active_department.membership_id,
      "Transfer worker 2",
      kTr2,
      computeTransferPersonDepartmentFingerprint(ADMIN_2.app, pTransfer.person_id, {
        target_department_ref: itDeptId,
        expected_person_version: pTransfer.version,
        expected_current_membership_id: pTransfer.active_department.membership_id,
        reason: "Transfer worker 2",
        idempotency_key: kTr2,
      }),
    ]);
    await waitUntilBlocked(observer, "wp3-worker-2");
    await worker1.query("commit");
    await assert.rejects(blockedTransfer, (err) => err.code === "PT409");
    await worker2.query("rollback");

    assert.equal(
      (await observer.query(
        "select count(*)::int as cnt from public.organization_person_department_memberships where person_id = $1::uuid and ended_at is null",
        [pTransfer.person_id],
      )).rows[0].cnt,
      1,
    );

    // -------------------------------------------------------------------------
    // Stage 2: Deterministic lock-hold race on `designate_head_admin`
    // -------------------------------------------------------------------------
    const kHd1 = nextKey();
    const kHd2 = nextKey();
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    await worker1.query(DESIGNATE_HEAD_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      itDeptId,
      pHead1.person_id,
      1,
      null,
      "Head worker 1",
      kHd1,
      computeDesignateHeadFingerprint({
        actor_app_user_id: ADMIN_1.app,
        department_id: itDeptId,
        person_id: pHead1.person_id,
        expected_department_version: 1,
        expected_current_head_assignment_id: null,
        reason: "Head worker 1",
      }),
    ]);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedHead = worker2.query(DESIGNATE_HEAD_SQL, [
      ADMIN_2.auth,
      ADMIN_2.app,
      itDeptId,
      pHead2.person_id,
      1,
      null,
      "Head worker 2",
      kHd2,
      computeDesignateHeadFingerprint({
        actor_app_user_id: ADMIN_2.app,
        department_id: itDeptId,
        person_id: pHead2.person_id,
        expected_department_version: 1,
        expected_current_head_assignment_id: null,
        reason: "Head worker 2",
      }),
    ]);
    await waitUntilBlocked(observer, "wp3-worker-2");
    await worker1.query("commit");
    await assert.rejects(blockedHead, (err) => err.code === "PT409");
    await worker2.query("rollback");

    assert.equal(
      (await observer.query(
        "select count(*)::int as cnt from public.organization_department_heads where department_id = $1::uuid and ended_at is null",
        [itDeptId],
      )).rows[0].cnt,
      1,
    );

    // Set role service_role on autocommit workers for parallel burst stages
    await worker1.query("set role service_role");
    await worker2.query("set role service_role");

    // -------------------------------------------------------------------------
    // Stage 3a: Parallel `link_account_person_admin` race on SAME account (USERS[0])
    // -------------------------------------------------------------------------
    const kLk1 = nextKey();
    const kLk2 = nextKey();
    const sameAcctRace = await Promise.allSettled([
      worker1.query(LINK_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        USERS[0].app,
        pLinkA.person_id,
        1,
        1,
        null,
        "Link acct to A",
        kLk1,
        computeLinkAccountPersonFingerprint(ADMIN_1.app, USERS[0].app, {
          person_id: pLinkA.person_id,
          expected_account_version: 1,
          expected_person_version: 1,
          confirmed_recruiter_id: null,
          reason: "Link acct to A",
          idempotency_key: kLk1,
        }),
      ]),
      worker2.query(LINK_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        USERS[0].app,
        pLinkB.person_id,
        1,
        1,
        null,
        "Link acct to B",
        kLk2,
        computeLinkAccountPersonFingerprint(ADMIN_2.app, USERS[0].app, {
          person_id: pLinkB.person_id,
          expected_account_version: 1,
          expected_person_version: 1,
          confirmed_recruiter_id: null,
          reason: "Link acct to B",
          idempotency_key: kLk2,
        }),
      ]),
    ]);
    assertNotDeadlockAndSingleWinner(sameAcctRace, "Stage 3a same-account link race");
    assert.equal(
      (await observer.query(
        "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and ended_at is null",
        [USERS[0].app],
      )).rows[0].cnt,
      1,
    );

    // -------------------------------------------------------------------------
    // Stage 3b: Parallel `link_account_person_admin` race on SAME person (pLinkC)
    // -------------------------------------------------------------------------
    const kLk3 = nextKey();
    const kLk4 = nextKey();
    const samePersonRace = await Promise.allSettled([
      worker1.query(LINK_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        USERS[1].app,
        pLinkC.person_id,
        1,
        1,
        null,
        "Link U2 to C",
        kLk3,
        computeLinkAccountPersonFingerprint(ADMIN_1.app, USERS[1].app, {
          person_id: pLinkC.person_id,
          expected_account_version: 1,
          expected_person_version: 1,
          confirmed_recruiter_id: null,
          reason: "Link U2 to C",
          idempotency_key: kLk3,
        }),
      ]),
      worker2.query(LINK_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        USERS[2].app,
        pLinkC.person_id,
        1,
        1,
        null,
        "Link U3 to C",
        kLk4,
        computeLinkAccountPersonFingerprint(ADMIN_2.app, USERS[2].app, {
          person_id: pLinkC.person_id,
          expected_account_version: 1,
          expected_person_version: 1,
          confirmed_recruiter_id: null,
          reason: "Link U3 to C",
          idempotency_key: kLk4,
        }),
      ]),
    ]);
    assertNotDeadlockAndSingleWinner(samePersonRace, "Stage 3b same-person link race");
    assert.equal(
      (await observer.query(
        "select count(*)::int as cnt from public.organization_account_person_links where person_id = $1::uuid and ended_at is null",
        [pLinkC.person_id],
      )).rows[0].cnt,
      1,
    );

    // -------------------------------------------------------------------------
    // Stage 4: Parallel cross-writer race: legacy `assign_accounting_member`
    //          vs WP3 `assign_person_member_admin` (`MARKETING`)
    // -------------------------------------------------------------------------
    const kCrossAcct = nextKey();
    const kCrossMkt = nextKey();
    const crossRace = await Promise.allSettled([
      worker1.query(ASSIGN_ACCT_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        USERS[3].app,
        0,
        null,
        "Cross assign accounting",
        kCrossAcct,
        computeAssignAccountingMemberFingerprint({
          actor_app_user_id: ADMIN_1.app,
          account_ref: USERS[3].app,
          expected_pair_version: 0,
          effective_from: null,
          reason: "Cross assign accounting",
        }),
      ]),
      worker2.query(ASSIGN_PERSON_DEPT_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        mktDeptId,
        pCross.person_id,
        pCross.version,
        "Cross assign marketing",
        kCrossMkt,
        computeAssignPersonMemberFingerprint({
          actor_app_user_id: ADMIN_2.app,
          department_id: mktDeptId,
          person_id: pCross.person_id,
          expected_person_version: pCross.version,
          reason: "Cross assign marketing",
        }),
      ]),
    ]);
    assertNotDeadlockAndSingleWinner(crossRace, "Stage 4 cross-writer ACCOUNTING vs MARKETING race");
    const crossDepts = (
      await observer.query(
        `select d.system_key
           from public.organization_person_department_memberships m
           join public.organization_departments d on d.department_id = m.department_id
          where m.person_id = $1::uuid and m.ended_at is null`,
        [pCross.person_id],
      )
    ).rows;
    assert.equal(crossDepts.length, 1);
    const legacyAcctActive = (
      await observer.query(
        "select count(*)::int as cnt from public.organization_department_memberships where app_user_id = $1::uuid and valid_to is null",
        [USERS[3].app],
      )
    ).rows[0].cnt;
    assert.equal(legacyAcctActive, crossDepts[0].system_key === "ACCOUNTING" ? 1 : 0);

    // -------------------------------------------------------------------------
    // Stage 5: Parallel 3-way display name sync race (Account side vs Person side)
    // -------------------------------------------------------------------------
    const pSyncUserVer = (
      await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [USERS[4].app],
      )
    ).rows[0].version;
    const kSyncPerson = nextKey();
    const nameRace = await Promise.allSettled([
      worker1.query(UPDATE_DISPLAY_NAME_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        USERS[4].app,
        "Tên Từ Account Side",
        pSyncUserVer,
        "Sync from account side",
        nextKey(),
      ]),
      worker2.query(UPDATE_PERSON_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        pSync.person_id,
        pSync.version,
        "TM12-SY-01",
        "Tên Từ Person Side",
        null,
        "ACTIVE",
        "Sync from person side",
        kSyncPerson,
        computeUpdatePersonFingerprint(ADMIN_2.app, pSync.person_id, {
          expected_person_version: pSync.version,
          employee_code: "TM12-SY-01",
          full_name: "Tên Từ Person Side",
          joined_on: null,
          status: "ACTIVE",
          reason: "Sync from person side",
          idempotency_key: kSyncPerson,
        }),
      ]),
    ]);
    // Both serialize without deadlock; any loser rejects with PT409, and at least one wins
    for (const r of nameRace) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01");
        assert.equal(r.reason?.code, "PT409", `Stage 5 rejection must be PT409, got ${r.reason?.code} ${r.reason?.message}`);
      }
    }
    assert.ok(nameRace.some((r) => r.status === "fulfilled"), "at least one name update must win");

    const syncState = (
      await observer.query(
        `select p.full_name, u.display_name as user_name, r.display_name as rec_name
           from public.organization_persons p
           join public.direct_entry_app_users u on u.app_user_id = $2::uuid
           join public.recruiters r on r.recruiter_id = $3::uuid
          where p.person_id = $1::uuid`,
        [pSync.person_id, USERS[4].app, REC_SYNC.id],
      )
    ).rows[0];
    assert.equal(syncState.user_name, syncState.full_name);
    assert.equal(syncState.rec_name, syncState.full_name);
    assert.ok(["Tên Từ Account Side", "Tên Từ Person Side"].includes(syncState.full_name));

    // -------------------------------------------------------------------------
    // Stage 6 (P1-4 Fix): Deterministic HEAD handover vs outgoing-HEAD races
    //   - Replace HEAD (A -> B) vs transfer_person_member(A) in BOTH arrival orders & BOTH UUID orders
    //   - Replace HEAD (A -> B) vs end_person_member(A)
    //   - Replace HEAD (A -> B) vs update_person(A -> INACTIVE)
    //   - End HEAD(A) vs transfer_person_member(A) in BOTH arrival orders
    //   Asserts 0 `40P01` deadlocks, 0 timeouts, canonical PT409/commit outcomes, and all invariants hold.
    // -------------------------------------------------------------------------
    const blocker = await connect(port, databaseName, "wp3-head-blocker");
    const actorA = await connect(port, databaseName, "wp3-head-actor-a");
    const actorB = await connect(port, databaseName, "wp3-head-actor-b");

    async function assertOrgInvariants(label) {
      const badDepts = (
        await observer.query(
          `select count(*)::int as cnt from (
             select department_id from public.organization_department_heads where ended_at is null group by department_id having count(*) > 1
           ) x`,
        )
      ).rows[0].cnt;
      assert.equal(badDepts, 0, `${label}: <= 1 active HEAD per department`);

      const invalidHeads = (
        await observer.query(
          `select count(*)::int as cnt
             from public.organization_department_heads h
             join public.organization_persons p on p.person_id = h.person_id
             left join public.organization_person_department_memberships m
               on m.person_id = h.person_id and m.department_id = h.department_id and m.ended_at is null
            where h.ended_at is null and (p.status <> 'ACTIVE' or m.membership_id is null)`,
        )
      ).rows[0].cnt;
      assert.equal(invalidHeads, 0, `${label}: every active HEAD must be ACTIVE member of the department`);

      const multiMembership = (
        await observer.query(
          `select count(*)::int as cnt from (
             select person_id from public.organization_person_department_memberships where ended_at is null group by person_id having count(*) > 1
           ) y`,
        )
      ).rows[0].cnt;
      assert.equal(multiMembership, 0, `${label}: <= 1 active department per person`);
    }

    async function getDeptAndHead(deptId) {
      const dept = (
        await observer.query("select department_id, version from public.organization_departments where department_id = $1::uuid", [deptId])
      ).rows[0];
      const head = (
        await observer.query(
          "select head_assignment_id, person_id, version from public.organization_department_heads where department_id = $1::uuid and ended_at is null",
          [deptId],
        )
      ).rows[0] ?? null;
      return { dept, head };
    }

    async function getPersonState(personId) {
      const res = await actorA.query(
        "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, null) as data",
        [ADMIN_1.auth, ADMIN_1.app, personId],
      );
      return res.rows[0].data.person;
    }

    async function runBarrierRace(label, barrierSql, barrierParams, firstFn, firstName, secondFn, secondName) {
      await Promise.all([
        actorA.query("set statement_timeout = '8s'"),
        actorB.query("set statement_timeout = '8s'"),
      ]);
      await blocker.query("begin");
      await blocker.query(barrierSql, barrierParams);

      await actorA.query("begin; set local role service_role");
      const firstPromise = firstFn(actorA)
        .then(async (value) => {
          await actorA.query("commit");
          return { ok: true, value };
        })
        .catch(async (error) => {
          await actorA.query("rollback");
          return { ok: false, code: error.code, message: error.message };
        });

      await waitUntilBlocked(observer, firstName);

      await actorB.query("begin; set local role service_role");
      const secondPromise = secondFn(actorB)
        .then(async (value) => {
          await actorB.query("commit");
          return { ok: true, value };
        })
        .catch(async (error) => {
          await actorB.query("rollback");
          return { ok: false, code: error.code, message: error.message };
        });

      await waitUntilBlocked(observer, secondName);
      await blocker.query("commit");

      const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
      for (const [tag, res] of [[firstName, firstRes], [secondName, secondRes]]) {
        if (!res.ok) {
          assert.notEqual(res.code, "40P01", `${label} (${tag}): PostgreSQL deadlock 40P01 must never occur (${res.message})`);
          assert.equal(res.code, "PT409", `${label} (${tag}): unexpected error ${res.code} ${res.message}`);
        }
      }
      assert.ok(firstRes.ok || secondRes.ok, `${label}: at least one transaction must commit`);
      await assertOrgInvariants(label);
      return { firstRes, secondRes };
    }

    try {
      await actorA.query("set role service_role");
      await actorB.query("set role service_role");

      // Create two dedicated candidates and determine ascending/descending UUID order
      const cand1 = await createPerson(actorA, { code: "S6-HD-01", fullName: "Stage 6 Head One", deptId: itDeptId, reason: "Stage 6 setup" });
      const cand2 = await createPerson(actorA, { code: "S6-HD-02", fullName: "Stage 6 Head Two", deptId: itDeptId, reason: "Stage 6 setup" });
      const [lowPerson, highPerson] =
        cand1.person_id < cand2.person_id ? [cand1, cand2] : [cand2, cand1];

      // Replace existing IT head with lowPerson so outgoing < candidate
      let itState = await getDeptAndHead(itDeptId);
      const kInit = nextKey();
      await actorA.query(DESIGNATE_HEAD_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        itDeptId,
        lowPerson.person_id,
        itState.dept.version,
        itState.head.head_assignment_id,
        "Set lowPerson HEAD",
        kInit,
        computeDesignateHeadFingerprint({
          actor_app_user_id: ADMIN_1.app,
          department_id: itDeptId,
          person_id: lowPerson.person_id,
          expected_department_version: itState.dept.version,
          expected_current_head_assignment_id: itState.head.head_assignment_id,
          reason: "Set lowPerson HEAD",
        }),
      ]);

      // 6a: T0 reproduction direction: blocker locks IT dept -> transfer(lowPerson) arrives first -> replace(lowPerson -> highPerson) arrives second
      itState = await getDeptAndHead(itDeptId);
      let lowState = await getPersonState(lowPerson.person_id);
      const k6aTr = nextKey();
      const k6aRep = nextKey();
      const res6a = await runBarrierRace(
        "Stage 6a replace(low->high) vs transfer(low) [transfer first]",
        "select department_id from public.organization_departments where department_id = $1::uuid for update",
        [itDeptId],
        (c) =>
          c.query(TRANSFER_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            lowPerson.person_id,
            mktDeptId,
            lowState.version,
            lowState.active_department.membership_id,
            "6a transfer lowPerson",
            k6aTr,
            computeTransferPersonDepartmentFingerprint(ADMIN_1.app, lowPerson.person_id, {
              target_department_ref: mktDeptId,
              expected_person_version: lowState.version,
              expected_current_membership_id: lowState.active_department.membership_id,
              reason: "6a transfer lowPerson",
              idempotency_key: k6aTr,
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(DESIGNATE_HEAD_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            itDeptId,
            highPerson.person_id,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6a replace low->high",
            k6aRep,
            computeDesignateHeadFingerprint({
              actor_app_user_id: ADMIN_2.app,
              department_id: itDeptId,
              person_id: highPerson.person_id,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6a replace low->high",
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6a.secondRes.ok, true, "6a replacement must succeed");
      assert.equal(res6a.firstRes.ok, false, "6a transfer while still HEAD must reject PT409");
      assert.match(res6a.firstRes.message, /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/);

      // 6b: Reverse UUID order (outgoing highPerson > candidate lowPerson) AND replace arrives FIRST holding persons, transfer(highPerson) arrives second
      itState = await getDeptAndHead(itDeptId);
      let highState = await getPersonState(highPerson.person_id);
      const k6bRep = nextKey();
      const k6bTr = nextKey();
      const res6b = await runBarrierRace(
        "Stage 6b replace(high->low) vs transfer(high) [replace first]",
        "select department_id from public.organization_departments where department_id = $1::uuid for update",
        [itDeptId],
        (c) =>
          c.query(DESIGNATE_HEAD_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            itDeptId,
            lowPerson.person_id,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6b replace high->low",
            k6bRep,
            computeDesignateHeadFingerprint({
              actor_app_user_id: ADMIN_2.app,
              department_id: itDeptId,
              person_id: lowPerson.person_id,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6b replace high->low",
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(TRANSFER_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            highPerson.person_id,
            mktDeptId,
            highState.version,
            highState.active_department.membership_id,
            "6b transfer highPerson",
            k6bTr,
            computeTransferPersonDepartmentFingerprint(ADMIN_1.app, highPerson.person_id, {
              target_department_ref: mktDeptId,
              expected_person_version: highState.version,
              expected_current_membership_id: highState.active_department.membership_id,
              reason: "6b transfer highPerson",
              idempotency_key: k6bTr,
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6b.firstRes.ok, true, "6b replacement must succeed");
      assert.equal(res6b.secondRes.ok, true, "6b transfer after replace committed must succeed serially");

      // Move highPerson back to IT for 6c/6d/6e
      highState = await getPersonState(highPerson.person_id);
      const kBack = nextKey();
      await actorA.query(TRANSFER_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        highPerson.person_id,
        itDeptId,
        highState.version,
        highState.active_department.membership_id,
        "Move highPerson back to IT",
        kBack,
        computeTransferPersonDepartmentFingerprint(ADMIN_1.app, highPerson.person_id, {
          target_department_ref: itDeptId,
          expected_person_version: highState.version,
          expected_current_membership_id: highState.active_department.membership_id,
          reason: "Move highPerson back to IT",
          idempotency_key: kBack,
        }),
      ]);

      // 6c: Replace HEAD (low -> high) vs end_person_member(low)
      itState = await getDeptAndHead(itDeptId);
      lowState = await getPersonState(lowPerson.person_id);
      const k6cEnd = nextKey();
      const k6cRep = nextKey();
      const res6c = await runBarrierRace(
        "Stage 6c replace(low->high) vs end_person_member(low)",
        "select department_id from public.organization_departments where department_id = $1::uuid for update",
        [itDeptId],
        (c) =>
          c.query(END_PERSON_DEPT_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            itDeptId,
            lowState.active_department.membership_id,
            lowState.version,
            "6c end member low",
            k6cEnd,
            computeEndPersonMemberFingerprint({
              actor_app_user_id: ADMIN_1.app,
              department_id: itDeptId,
              membership_id: lowState.active_department.membership_id,
              expected_person_version: lowState.version,
              reason: "6c end member low",
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(DESIGNATE_HEAD_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            itDeptId,
            highPerson.person_id,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6c replace low->high",
            k6cRep,
            computeDesignateHeadFingerprint({
              actor_app_user_id: ADMIN_2.app,
              department_id: itDeptId,
              person_id: highPerson.person_id,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6c replace low->high",
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6c.secondRes.ok, true);
      assert.equal(res6c.firstRes.ok, false);
      assert.match(res6c.firstRes.message, /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/);

      // 6d: Replace HEAD (high -> low) vs update_person(high -> INACTIVE) while blocker holds lowPerson lock
      itState = await getDeptAndHead(itDeptId);
      highState = await getPersonState(highPerson.person_id);
      const k6dRep = nextKey();
      const k6dDeact = nextKey();
      const res6d = await runBarrierRace(
        "Stage 6d replace(high->low) vs update_person(high -> INACTIVE)",
        "select person_id from public.organization_persons where person_id = $1::uuid for update",
        [lowPerson.person_id],
        (c) =>
          c.query(DESIGNATE_HEAD_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            itDeptId,
            lowPerson.person_id,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6d replace high->low",
            k6dRep,
            computeDesignateHeadFingerprint({
              actor_app_user_id: ADMIN_2.app,
              department_id: itDeptId,
              person_id: lowPerson.person_id,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6d replace high->low",
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(UPDATE_PERSON_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            highPerson.person_id,
            highState.version,
            highState.employee_code,
            highState.full_name,
            null,
            "INACTIVE",
            "6d deactivate outgoing HEAD",
            k6dDeact,
            computeUpdatePersonFingerprint(ADMIN_1.app, highPerson.person_id, {
              expected_person_version: highState.version,
              employee_code: highState.employee_code,
              full_name: highState.full_name,
              joined_on: null,
              status: "INACTIVE",
              reason: "6d deactivate outgoing HEAD",
              idempotency_key: k6dDeact,
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6d.firstRes.ok, true);
      assert.equal(res6d.secondRes.ok, true, "6d deactivation after HEAD replacement must succeed cleanly");

      // 6e: end_head_admin(low) vs transfer_person_member(low -> MARKETING) in BOTH arrival orders
      itState = await getDeptAndHead(itDeptId);
      lowState = await getPersonState(lowPerson.person_id);
      const k6eEndHead = nextKey();
      const k6eTr = nextKey();
      const res6e = await runBarrierRace(
        "Stage 6e end_head(low) vs transfer(low) [end_head first]",
        "select department_id from public.organization_departments where department_id = $1::uuid for update",
        [itDeptId],
        (c) =>
          c.query(END_HEAD_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            itDeptId,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6e end head low",
            k6eEndHead,
            computeEndHeadFingerprint({
              actor_app_user_id: ADMIN_1.app,
              department_id: itDeptId,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6e end head low",
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(TRANSFER_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            lowPerson.person_id,
            mktDeptId,
            lowState.version,
            lowState.active_department.membership_id,
            "6e transfer low after end_head",
            k6eTr,
            computeTransferPersonDepartmentFingerprint(ADMIN_2.app, lowPerson.person_id, {
              target_department_ref: mktDeptId,
              expected_person_version: lowState.version,
              expected_current_membership_id: lowState.active_department.membership_id,
              reason: "6e transfer low after end_head",
              idempotency_key: k6eTr,
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6e.firstRes.ok, true);
      assert.equal(res6e.secondRes.ok, true);

      // Re-transfer lowPerson back to IT, designate HEAD, then test transfer arriving BEFORE end_head
      lowState = await getPersonState(lowPerson.person_id);
      const kBackLow = nextKey();
      await actorA.query(TRANSFER_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        lowPerson.person_id,
        itDeptId,
        lowState.version,
        lowState.active_department.membership_id,
        "Back to IT for 6f",
        kBackLow,
        computeTransferPersonDepartmentFingerprint(ADMIN_1.app, lowPerson.person_id, {
          target_department_ref: itDeptId,
          expected_person_version: lowState.version,
          expected_current_membership_id: lowState.active_department.membership_id,
          reason: "Back to IT for 6f",
          idempotency_key: kBackLow,
        }),
      ]);
      itState = await getDeptAndHead(itDeptId);
      const kDes6f = nextKey();
      await actorA.query(DESIGNATE_HEAD_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        itDeptId,
        lowPerson.person_id,
        itState.dept.version,
        null,
        "Designate IT head for 6f",
        kDes6f,
        computeDesignateHeadFingerprint({
          actor_app_user_id: ADMIN_1.app,
          department_id: itDeptId,
          person_id: lowPerson.person_id,
          expected_department_version: itState.dept.version,
          expected_current_head_assignment_id: null,
          reason: "Designate IT head for 6f",
        }),
      ]);

      itState = await getDeptAndHead(itDeptId);
      lowState = await getPersonState(lowPerson.person_id);
      const k6fTr = nextKey();
      const k6fEndHead = nextKey();
      const res6f = await runBarrierRace(
        "Stage 6f end_head(low) vs transfer(low) [transfer first]",
        "select department_id from public.organization_departments where department_id = $1::uuid for update",
        [itDeptId],
        (c) =>
          c.query(TRANSFER_SQL, [
            ADMIN_2.auth,
            ADMIN_2.app,
            lowPerson.person_id,
            mktDeptId,
            lowState.version,
            lowState.active_department.membership_id,
            "6f transfer while HEAD",
            k6fTr,
            computeTransferPersonDepartmentFingerprint(ADMIN_2.app, lowPerson.person_id, {
              target_department_ref: mktDeptId,
              expected_person_version: lowState.version,
              expected_current_membership_id: lowState.active_department.membership_id,
              reason: "6f transfer while HEAD",
              idempotency_key: k6fTr,
            }),
          ]),
        "wp3-head-actor-a",
        (c) =>
          c.query(END_HEAD_SQL, [
            ADMIN_1.auth,
            ADMIN_1.app,
            itDeptId,
            itState.dept.version,
            itState.head.head_assignment_id,
            "6f end head",
            k6fEndHead,
            computeEndHeadFingerprint({
              actor_app_user_id: ADMIN_1.app,
              department_id: itDeptId,
              expected_department_version: itState.dept.version,
              expected_current_head_assignment_id: itState.head.head_assignment_id,
              reason: "6f end head",
            }),
          ]),
        "wp3-head-actor-b",
      );
      assert.equal(res6f.secondRes.ok, true);
      assert.equal(res6f.firstRes.ok, false);
      assert.match(res6f.firstRes.message, /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/);
    } finally {
      await Promise.allSettled([blocker, actorA, actorB].map((client) => client.end()));
    }
  } finally {
    await Promise.allSettled(
      [worker1, worker2, observer, setup, adminClient]
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
