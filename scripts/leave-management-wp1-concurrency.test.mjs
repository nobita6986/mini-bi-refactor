/**
 * LEAVE-WP1 — Real PostgreSQL Concurrency Regression Suite.
 *
 * Proves against isolated local PostgreSQL (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Parallel accrual materialization burst: 4 concurrent connections calling
 *      `leave_management_get_my_summary` for the same employee serialize cleanly
 *      under `leave_management__internal_lock_employee`, producing zero duplicate
 *      monthly accrual lots or ledger entries.
 *   2. Deterministic lock-hold race on overlapping `leave_management_create_request`:
 *      two concurrent requests for the same employee & date serialize on the
 *      per-employee advisory lock; strictly 1 wins and the contender rejects with
 *      `22023` (`LEAVE_REQUEST_DATE_OVERLAP`).
 *   3. Deterministic lock-hold race on `leave_management_decide_request`: two
 *      approvers racing on the same `PENDING` request (`expected_row_version = 1`)
 *      serialize cleanly; strictly 1 wins (`row_version = 2`) and the contender
 *      rejects with `PT409` (`LEAVE_ROW_VERSION_CONFLICT`), with zero double-deduction.
 *   4. Cross-operation race (`APPROVE` vs `withdraw_request` on the same `PENDING`
 *      request): strictly 1 succeeds, the contender rejects fail-closed, zero
 *      deadlocks (`40P01`), and lot/ledger invariants hold.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { LEAVE_MANAGEMENT_WP1_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN_1 = {
  auth: "19200000-0000-4000-8000-000000000001",
  app: "29200000-0000-4000-8000-000000000001",
  name: "Full Admin Leave",
};
const LEADER_1 = {
  auth: "19200000-0000-4000-8000-000000000002",
  app: "29200000-0000-4000-8000-000000000002",
  recruiter: "39200000-0000-4000-8000-000000000002",
  code: "TL_RACE_01",
  name: "Team Leader Race",
};
const EMP_1 = {
  auth: "19200000-0000-4000-8000-000000000011",
  app: "29200000-0000-4000-8000-000000000011",
  recruiter: "39200000-0000-4000-8000-000000000011",
  code: "EMP_RACE_01",
  name: "Employee Race One",
};
const EMP_2 = {
  auth: "19200000-0000-4000-8000-000000000012",
  app: "29200000-0000-4000-8000-000000000012",
  recruiter: "39200000-0000-4000-8000-000000000012",
  code: "EMP_RACE_02",
  name: "Employee Race Two",
};
const TEAM_RACE = "49200000-0000-4000-8000-000000000001";

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

async function connect(port, database = "postgres", applicationName = "leave-wp1-race") {
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
    .filter((name) => name.endsWith(".sql") && name < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql")
    .sort();
  assert.ok(
    names.includes(LEAVE_MANAGEMENT_WP1_MIGRATION_NAME),
    `migration inventory must include ${LEAVE_MANAGEMENT_WP1_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seedActorsAndProfiles(client) {
  // Pin business date to 2026-03-15 (Month 3 => 3 months * 2 units = 6 half-day units)
  await client.query(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '2026-03-15'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);

  for (const person of [ADMIN_1, LEADER_1, EMP_1, EMP_2]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.name.toLowerCase().replaceAll(" ", ".")}@company.local`,
    ]);
    await client.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1, $2, $3, true)",
      [person.app, person.auth, person.name],
    );
  }

  await client.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1, 'entry_admin', '2025-01-01', true),
            ($1, 'recruiter_master_manage', '2025-01-01', true),
            ($1, 'team_master_manage', '2025-01-01', true)`,
    [ADMIN_1.app],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1, 'all', '2025-01-01', true)`,
    [ADMIN_1.app],
  );

  await client.query(
    "insert into public.teams (team_id, code, display_name, active) values ($1, 'TEAM_RACE', 'Team Race', true)",
    [TEAM_RACE],
  );

  for (const rec of [LEADER_1, EMP_1, EMP_2]) {
    await client.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, active) values ($1, $2, $3, true)",
      [rec.recruiter, rec.name, rec.code],
    );
    await client.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2025-01-01', true)",
      [rec.app, rec.recruiter],
    );
    await client.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2025-01-01', true)",
      [rec.recruiter, TEAM_RACE],
    );
  }

  await client.query(
    "insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current) values ($1, $2, $3, '2025-01-01', true)",
    [TEAM_RACE, LEADER_1.app, LEADER_1.recruiter],
  );

  // Configure leave profiles for EMP_1 and EMP_2 without triggering summary yet on EMP_1
  // so Stage 1 can test concurrent initial accrual materialization on EMP_1
  await client.query(
    `insert into public.leave_employee_profiles (
       app_user_id, is_shared_non_employee, employment_status, unit_kind,
       work_start_date, official_effective_date, next_seniority_units, row_version, updated_by_app_user_id
     ) values
       ($1, false, 'OFFICIAL', 'RECRUITMENT', '2025-01-01', '2025-03-01', 0, 1, $3),
       ($2, false, 'OFFICIAL', 'RECRUITMENT', '2025-01-01', '2025-03-01', 0, 1, $3)`,
    [EMP_1.app, EMP_2.app, ADMIN_1.app],
  );
}

const SUMMARY_SQL =
  "select public.leave_management_get_my_summary($1::uuid, $2::uuid, $3::int) as data";
const CREATE_REQ_SQL =
  "select public.leave_management_create_request($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::text, $6::text) as data";
const DECIDE_REQ_SQL =
  "select public.leave_management_decide_request($1::uuid, $2::uuid, $3::uuid, $4::text, $5::int, $6::text, $7::text, $8::text) as data";
const WITHDRAW_REQ_SQL =
  "select public.leave_management_withdraw_request($1::uuid, $2::uuid, $3::uuid, $4::int, $5::text, $6::text, $7::text) as data";
const PREVIEW_OPENING_SQL =
  "select public.leave_management_preview_opening_batch($1::uuid, $2::uuid, $3::int, $4::jsonb) as data";
const APPLY_OPENING_SQL =
  "select public.leave_management_apply_opening_batch($1::uuid, $2::uuid, $3::int, $4::jsonb, $5::text, $6::text, $7::text) as data";

test("LEAVE-WP1 real PostgreSQL concurrency: accrual burst, overlapping requests, concurrent decisions, and approve-vs-withdraw serialize cleanly", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "leave-wp1-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `leave_wp1_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
  let worker1;
  let worker2;
  const burstClients = [];

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

    setup = await connect(port, databaseName, "leave-wp1-setup");
    await applyMigrations(setup);
    await seedActorsAndProfiles(setup);
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "leave-wp1-observer");
    worker1 = await connect(port, databaseName, "leave-wp1-worker-1");
    worker2 = await connect(port, databaseName, "leave-wp1-worker-2");

    // -------------------------------------------------------------------------
    // Stage 1: 4-connection parallel burst materializing monthly accruals on EMP_1
    // -------------------------------------------------------------------------
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(port, databaseName, `leave-wp1-burst-${i}`);
      await c.query("set role service_role");
      burstClients.push(c);
    }

    const summaryBurst = await Promise.all(
      burstClients.map((client) =>
        client.query(SUMMARY_SQL, [EMP_1.auth, EMP_1.app, 2026]),
      ),
    );
    for (const res of summaryBurst) {
      assert.equal(res.rows[0].data.balance.monthly_accrued_units, 6);
      assert.equal(res.rows[0].data.balance.available_units, 6);
    }

    const { rows: emp1LotCheck } = await observer.query(
      `select count(*)::int as lot_count, coalesce(sum(granted_units), 0)::int as total_units
         from public.leave_lots
        where app_user_id = $1 and leave_year = 2026`,
      [EMP_1.app],
    );
    assert.deepEqual(emp1LotCheck[0], { lot_count: 3, total_units: 6 });

    // -------------------------------------------------------------------------
    // Stage 2: Deterministic lock-hold race on overlapping `create_request`
    // -------------------------------------------------------------------------
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winReqRes = await worker1.query(CREATE_REQ_SQL, [
      EMP_1.auth,
      EMP_1.app,
      JSON.stringify([{ leave_date: "2026-03-20", session_code: "AM" }]),
      "Xin nghỉ buổi sáng 20/03 (luồng 1)",
      "race-create-idem-1",
      "fp-race-create-1",
    ]);
    const emp1ReqId = winReqRes.rows[0].data.request.request_id;
    assert.equal(winReqRes.rows[0].data.request.status, "PENDING");
    assert.equal(winReqRes.rows[0].data.request.row_version, 1);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedCreate = worker2.query(CREATE_REQ_SQL, [
      EMP_1.auth,
      EMP_1.app,
      JSON.stringify([{ leave_date: "2026-03-20", session_code: "FULL" }]),
      "Xin nghỉ cả ngày 20/03 trùng lịch (luồng 2)",
      "race-create-idem-2",
      "fp-race-create-2",
    ]);
    blockedCreate.catch(() => {});

    await waitUntilBlocked(observer, "leave-wp1-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      blockedCreate,
      (err) =>
        (err.code === "23505" || err.code === "22023") &&
        String(err.message).includes("LEAVE_REQUEST_OVERLAP"),
      "overlapping concurrent create_request must reject with LEAVE_REQUEST_OVERLAP",
    );
    await worker2.query("rollback");

    // -------------------------------------------------------------------------
    // Stage 3: Deterministic lock-hold race on `decide_request` (expected_row_version = 1)
    // -------------------------------------------------------------------------
    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winDecideRes = await worker1.query(DECIDE_REQ_SQL, [
      LEADER_1.auth,
      LEADER_1.app,
      emp1ReqId,
      "APPROVE",
      1,
      "Team Leader duyệt đơn",
      "race-decide-idem-1",
      "fp-race-decide-1",
    ]);
    assert.equal(winDecideRes.rows[0].data.request.status, "APPROVED");
    assert.equal(winDecideRes.rows[0].data.request.row_version, 2);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedDecide = worker2.query(DECIDE_REQ_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      emp1ReqId,
      "REJECT",
      1,
      "Admin từ chối cùng lúc",
      "race-decide-idem-2",
      "fp-race-decide-2",
    ]);
    blockedDecide.catch(() => {});

    await waitUntilBlocked(observer, "leave-wp1-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      blockedDecide,
      (err) =>
        err.code === "PT409" &&
        String(err.message).includes("LEAVE_ROW_VERSION_CONFLICT"),
      "contending decide_request with stale row_version must reject with PT409",
    );
    await worker2.query("rollback");

    // -------------------------------------------------------------------------
    // Stage 4: Cross-operation race (`APPROVE` vs `withdraw_request` on EMP_2)
    // -------------------------------------------------------------------------
    const emp2CreateRes = await burstClients[0].query(CREATE_REQ_SQL, [
      EMP_2.auth,
      EMP_2.app,
      JSON.stringify([{ leave_date: "2026-03-25", session_code: "FULL" }]),
      "Xin nghỉ 25/03 để test race duyệt vs rút đơn",
      "race-emp2-create-1",
      "fp-race-emp2-create-1",
    ]);
    const emp2ReqId = emp2CreateRes.rows[0].data.request.request_id;

    const crossOutcomes = await Promise.allSettled([
      burstClients[0].query(DECIDE_REQ_SQL, [
        LEADER_1.auth,
        LEADER_1.app,
        emp2ReqId,
        "APPROVE",
        1,
        "Leader duyệt trong race",
        "race-emp2-approve-1",
        "fp-race-emp2-approve-1",
      ]),
      burstClients[1].query(WITHDRAW_REQ_SQL, [
        EMP_2.auth,
        EMP_2.app,
        emp2ReqId,
        1,
        "Nhân viên tự rút đơn trong race",
        "race-emp2-withdraw-1",
        "fp-race-emp2-withdraw-1",
      ]),
    ]);

    const crossFulfilled = crossOutcomes.filter((o) => o.status === "fulfilled");
    const crossRejected = crossOutcomes.filter((o) => o.status === "rejected");
    assert.equal(crossFulfilled.length, 1, "strictly 1 of approve vs withdraw must win");
    assert.equal(crossRejected.length, 1, "the losing operation must reject");
    assert.notEqual(
      crossRejected[0].reason.code,
      "40P01",
      "approve vs withdraw must never deadlock (40P01)",
    );
    assert.ok(
      ["PT409", "22023"].includes(crossRejected[0].reason.code),
      `expected PT409 or 22023 on losing contender, got ${crossRejected[0].reason.code}`,
    );

    // Final invariant check on EMP_1: 6 granted, 1 reserved, 0 consumed, 5 available
    const { rows: emp1LotsFinal } = await observer.query(
      `select coalesce(sum(granted_units), 0)::int as granted,
              coalesce(sum(reserved_units), 0)::int as reserved,
              coalesce(sum(consumed_units), 0)::int as consumed
         from public.leave_lots
        where app_user_id = $1 and leave_year = 2026`,
      [EMP_1.app],
    );
    assert.deepEqual(emp1LotsFinal[0], { granted: 6, reserved: 1, consumed: 0 });

    // -------------------------------------------------------------------------
    // Stage 5: Deterministic lock-hold race on `apply_opening_batch`
    // -------------------------------------------------------------------------
    const openingRowsPayload = JSON.stringify([
      {
        app_user_id: EMP_1.app,
        carry_over_units: 0,
        opening_current_year_units: 2,
        seniority_units: 0,
        note: "Đối soát số dư mục tiêu còn 1 ngày (2 units)",
      },
    ]);

    const previewRes = await burstClients[0].query(PREVIEW_OPENING_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      2026,
      openingRowsPayload,
    ]);
    assert.equal(previewRes.rows[0].data.valid, true);
    assert.equal(previewRes.rows[0].data.rows[0].current_year_granted_units, 6);
    assert.equal(previewRes.rows[0].data.rows[0].current_year_locked_units, 1);
    assert.equal(previewRes.rows[0].data.rows[0].delta_current_year_units, -4);

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winOpeningApply = await worker1.query(APPLY_OPENING_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      2026,
      openingRowsPayload,
      "Chốt số dư mục tiêu 1 ngày (luồng 1)",
      "race-opening-apply-1",
      "fp-race-opening-apply-1",
    ]);
    assert.equal(winOpeningApply.rows[0].data.applied_row_count, 1);
    assert.equal(
      winOpeningApply.rows[0].data.applied_rows[0].balance.total_granted_units,
      2,
    );
    assert.equal(
      winOpeningApply.rows[0].data.applied_rows[0].balance.available_units,
      1,
    );

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedOpeningApply = worker2.query(APPLY_OPENING_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      2026,
      openingRowsPayload,
      "Chốt số dư mục tiêu 1 ngày (luồng 2 trùng lúc)",
      "race-opening-apply-2",
      "fp-race-opening-apply-2",
    ]);
    blockedOpeningApply.catch(() => {});

    await waitUntilBlocked(observer, "leave-wp1-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      blockedOpeningApply,
      (err) =>
        err.code === "40001" &&
        String(err.message).includes("LEAVE_OPENING_PREVIEW_STALE"),
      "contending apply_opening_batch after state changed must reject with 40001 LEAVE_OPENING_PREVIEW_STALE",
    );
    await worker2.query("rollback");

    const { rows: emp1LotsAfterOpeningRace } = await observer.query(
      `select coalesce(sum(granted_units), 0)::int as granted,
              coalesce(sum(reserved_units), 0)::int as reserved,
              coalesce(sum(consumed_units), 0)::int as consumed
         from public.leave_lots
        where app_user_id = $1 and leave_year = 2026`,
      [EMP_1.app],
    );
    assert.deepEqual(emp1LotsAfterOpeningRace[0], {
      granted: 2,
      reserved: 1,
      consumed: 0,
    });
  } finally {
    await worker1?.query("rollback").catch(() => {});
    await worker2?.query("rollback").catch(() => {});
    for (const c of burstClients) {
      await c.end().catch(() => {});
    }
    await observer?.end().catch(() => {});
    await worker1?.end().catch(() => {});
    await worker2?.end().catch(() => {});
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
