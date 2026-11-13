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
