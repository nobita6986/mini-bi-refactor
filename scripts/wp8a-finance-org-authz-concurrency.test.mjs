/**
 * WP8A — Salary Advance + Vendor Finance on Canonical WP3 Org & WP5 Paired Effective Access
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks under `SET ROLE service_role`:
 *   Race 1: `salary_advance_create_request` (PM) vs `direct_entry_unassign_project_manager`
 *           (Team Leader path: `direct_entry_projects FOR UPDATE -> direct_entry_app_users FOR UPDATE`)
 *           proving canonical `[2] projects FOR SHARE -> [3] vfin_project (SHARED) -> [5] app_users FOR SHARE`
 *           is deadlock-free and fails closed with `42501` once PM assignment is revoked.
 *   Race 2: `salary_advance_transition_request(APPROVE)` (PA) vs `org_department_end_person_member_admin`
 *           (WP3 end `ACCOUNTING` membership).
 *   Race 3: `salary_advance_transition_request(APPROVE)` (PA) vs `vendor_finance_end_project_accountant_admin`
 *           (exclusive `vfin_project` vs shared `vfin_project`).
 *   Race 4: `salary_advance_transition_request(APPROVE)` (PA) vs `direct_entry_disable_app_user`.
 *   Race 5: `vendor_finance_record_entry` (PA) vs `org_department_transfer_person_member_admin`
 *           (WP3 `ACCOUNTING -> MARKETING`).
 *   Race 6: `vendor_finance_record_payment_with_offset` (PA) vs `vendor_finance_end_project_accountant_admin`
 *           (atomic all-or-nothing: zero ledger entry AND zero shared advance movement after PA end).
 *   Race 7: `vendor_finance_fund_shared_advance` (`CASH_HOLDER_RECORD_BEHALF`) vs
 *           `vendor_finance_end_global_role_admin` (`vfin_global_role` SHARED vs EXCLUSIVE).
 *   Race 8: `vendor_finance_record_entry` (secondary `ADMIN`) vs
 *           `direct_entry_authz_revoke_global_role_admin` (`ADMIN`) AND `direct_entry_disable_app_user`.
 *   Race 9: `vendor_finance_assign_project_accountant_admin` vs `org_department_end_person_member_admin`
 *           on target PA (`app_users` ASC lock order + re-verify under lock -> `PT409`).
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

import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8A_MIGRATION_NAME = "20261120090000_wp8a_finance_org_authz.sql";

const OWNER = {
  auth: "18900000-0000-4000-8000-000000000001",
  app: "28900000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Race",
};
const LUANPT = {
  auth: "18900000-0000-4000-8000-000000000002",
  app: "28900000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18900000-0000-4000-8000-000000000003",
  app: "28900000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18900000-0000-4000-8000-000000000004",
  app: "28900000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const TL_USER = {
  auth: "18900000-0000-4000-8000-000000000005",
  app: "28900000-0000-4000-8000-000000000005",
  recruiter: "38900000-0000-4000-8000-000000000005",
  email: "tl.race.wp8a@hrpartner.vn",
  name: "Team Leader Race",
};
const PM_R1 = {
  auth: "18900000-0000-4000-8000-000000000006",
  app: "28900000-0000-4000-8000-000000000006",
  recruiter: "38900000-0000-4000-8000-000000000006",
  email: "pm.r1.wp8a@hrpartner.vn",
  name: "PM Race 1",
};
const PA_R2 = {
  auth: "18900000-0000-4000-8000-000000000007",
  app: "28900000-0000-4000-8000-000000000007",
  email: "pa.r2.wp8a@hrpartner.vn",
  name: "PA Race 2 EndDept",
};
const PA_R3 = {
  auth: "18900000-0000-4000-8000-000000000008",
  app: "28900000-0000-4000-8000-000000000008",
  email: "pa.r3.wp8a@hrpartner.vn",
  name: "PA Race 3 EndPA",
};
const PA_R4 = {
  auth: "18900000-0000-4000-8000-000000000009",
  app: "28900000-0000-4000-8000-000000000009",
  email: "pa.r4.wp8a@hrpartner.vn",
  name: "PA Race 4 Disable",
};
const PA_R5 = {
  auth: "18900000-0000-4000-8000-000000000010",
  app: "28900000-0000-4000-8000-000000000010",
  email: "pa.r5.wp8a@hrpartner.vn",
  name: "PA Race 5 Transfer",
};
const PA_R6 = {
  auth: "18900000-0000-4000-8000-000000000011",
  app: "28900000-0000-4000-8000-000000000011",
  email: "pa.r6.wp8a@hrpartner.vn",
  name: "PA Race 6 PayOffset",
};
const CASH_R7 = {
  auth: "18900000-0000-4000-8000-000000000012",
  app: "28900000-0000-4000-8000-000000000012",
  email: "cash.r7.wp8a@hrpartner.vn",
  name: "Cash Holder Race 7",
};
const ADMIN_R8A = {
  auth: "18900000-0000-4000-8000-000000000013",
  app: "28900000-0000-4000-8000-000000000013",
  email: "admin.r8a.wp8a@hrpartner.vn",
  name: "Secondary Admin Race 8A Revoke",
};
const ADMIN_R8B = {
  auth: "18900000-0000-4000-8000-000000000014",
  app: "28900000-0000-4000-8000-000000000014",
  email: "admin.r8b.wp8a@hrpartner.vn",
  name: "Secondary Admin Race 8B Disable",
};
const PA_R9 = {
  auth: "18900000-0000-4000-8000-000000000015",
  app: "28900000-0000-4000-8000-000000000015",
  email: "pa.r9.wp8a@hrpartner.vn",
  name: "PA Race 9 Target EndDept",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  TL_USER,
  PM_R1,
  PA_R2,
  PA_R3,
  PA_R4,
  PA_R5,
  PA_R6,
  CASH_R7,
  ADMIN_R8A,
  ADMIN_R8B,
  PA_R9,
];

const TEAM_RACE = "48900000-0000-4000-8000-000000000001";
const VENDOR_RACE = "wp8a_race_vendor";
const PRJ_R1 = "wp8a_race_p1";
const PRJ_R2 = "wp8a_race_p2";
const PRJ_R3 = "wp8a_race_p3";
const PRJ_R4 = "wp8a_race_p4";
const PRJ_R5 = "wp8a_race_p5";
const PRJ_R6 = "wp8a_race_p6";
const PRJ_R8 = "wp8a_race_p8";
const PRJ_R9 = "wp8a_race_p9";

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `98900000-0000-4000-8000-${hex}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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

async function connect(port, appName) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceRpc(client, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpcInTx(client, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("set local role service_role");
  const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
  return rows[0]?.res;
}

function asSettled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await observer.query(
      `select wait_event_type, wait_event, state
         from pg_stat_activity
        where application_name = $1`,
      [appName],
    );
    if (rows.length > 0 && rows[0].wait_event_type === "Lock") {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${appName} to block on Lock`);
}

function makeWorkerDetails(displayName) {
  const unknown = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: unknown,
    national_id: unknown,
    address: unknown,
    phone: unknown,
  };
}

const initdb = binary("initdb");
const pgCtl = binary("pg_ctl");

test(
  "WP8A Real PostgreSQL 18 Concurrency: 11 bidirectional deterministic lock-barrier cross-domain races (0 deadlocks, fail-closed, linearizable)",
  { skip: !initdb || !pgCtl ? "PostgreSQL binaries not available" : false },
  async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bi-wp8a-pg-"));
    const pgData = path.join(tmpRoot, "data");
    const logFile = path.join(tmpRoot, "postgres.log");
    const port = await freePort();
    let started = false;
    const clients = [];

    try {
      run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"], {
        ignoreOutput: true,
      });
      run(pgCtl, ["-D", pgData, "-l", logFile, "-w", "-o", `-F -h 127.0.0.1 -p ${port} -k ""`, "start"], {
        ignoreOutput: true,
      });
      started = true;

      const setup = await connect(port, "wp8a-setup");
      const w1 = await connect(port, "wp8a-w1");
      const w2 = await connect(port, "wp8a-w2");
      const observer = await connect(port, "wp8a-obs");
      clients.push(setup, w1, w2, observer);

      // Apply all migrations through WP8A
      await setup.query(
        "create role anon; create role authenticated; create role service_role;" +
          " create schema auth; create table auth.users (id uuid primary key, email text);",
      );
      const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
      assert.ok(names.includes(WP8A_MIGRATION_NAME), `${WP8A_MIGRATION_NAME} must exist`);
      for (const name of names) {
        await setup.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }

      // Seed accounts & WP5 cutover
      for (const u of ALL_USERS) {
        await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
        await setup.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
          [u.app, u.auth, u.name],
        );
      }
      for (const adm of [OWNER, LIENVU, NGATTT]) {
        for (const cap of [
          "entry_admin",
          "entry_team",
          "entry_own",
          "entry_create",
          "submission_create",
          "entry_privileged_edit",
          "entry_restore",
          "recruiter_master_manage",
          "team_master_manage",
          "audit_view",
          "worker_edit_history_view",
          "document_upload",
          "document_view",
          "employment_status.review",
          "employment_status.apply",
          "change_request_create",
          "change_review",
          "employment_status.request",
          "duplicate_cccd_withdraw",
        ]) {
          await setup.query(
            "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
            [adm.app, cap],
          );
        }
        await setup.query(
          "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
          [adm.app],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
        [LUANPT.app],
      );

      const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
      assert.equal(plan.action_diff.unexpected_diff_count, 0);
      const applied = await runWp5Cutover(setup, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: plan.manifest_fingerprint,
      });
      assert.equal(applied.status, "APPLIED");

      async function assignWp5Role(target, roleCode) {
        const { rows: [u] } = await setup.query(
          "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
          [target.app],
        );
        return serviceRpc(setup, "direct_entry_authz_assign_global_role_admin", [
          OWNER.auth,
          OWNER.app,
          target.app,
          roleCode,
          u.version,
          `Assign ${roleCode} race`,
          nextUuid(),
          sha256(`role:${target.app}:${roleCode}:${seq}`),
        ]);
      }

      const adminR8aAssign = await assignWp5Role(ADMIN_R8A, "ADMIN");
      await assignWp5Role(ADMIN_R8B, "ADMIN");

      // Seed Team, TL, PM, Projects, Vendor
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP8A_RACE_TEAM', 'Đội Race WP8A', true)",
        [TEAM_RACE],
      );
      for (const [u, code, pos] of [
        [TL_USER, "TL-R01", "TEAM_LEADER"],
        [PM_R1, "PM-R01", "STAFF"],
      ]) {
        await setup.query(
          "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, $4, true)",
          [u.recruiter, u.name, code, pos],
        );
        await setup.query(
          "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
          [u.recruiter],
        );
        await setup.query(
          "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
          [u.recruiter, TEAM_RACE],
        );
        await setup.query(
          "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
          [u.app, u.recruiter],
        );
        await assignWp5Role(u, "RECRUITER");
      }

      // Designate TL_USER as active Team Leader on TEAM_RACE
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
        [TEAM_RACE, TL_USER.app, TL_USER.recruiter],
      );
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
        [TL_USER.app, TEAM_RACE],
      );
      await setup.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [TL_USER.app]);

      for (const pid of [PRJ_R1, PRJ_R2, PRJ_R3, PRJ_R4, PRJ_R5, PRJ_R6, PRJ_R8, PRJ_R9]) {
        await setup.query(
          "insert into public.direct_entry_projects (project_id, display_name, active, version) values ($1, $2, true, 1)",
          [pid, `Dự án ${pid}`],
        );
        await setup.query(
          "select public.direct_entry_grant_project_team_scope($1::uuid, $2::uuid, $3::text, $4::uuid, 0, null::date, $5::text, $6::text)",
          [
            OWNER.auth,
            OWNER.app,
            pid,
            TEAM_RACE,
            `Grant ${pid} to TEAM_RACE`,
            `pts-${pid}-${nextUuid()}`,
          ],
        );
      }

      // Assign PM_R1 to PRJ_R1..PRJ_R4
      for (const pid of [PRJ_R1, PRJ_R2, PRJ_R3, PRJ_R4]) {
        await setup.query(
          "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current) values ($1, $2::uuid, '2026-01-01', true)",
          [pid, PM_R1.recruiter],
        );
      }

      await setup.query(
        "insert into public.vendors (vendor_id, display_name, active) values ($1, 'NCC Race WP8A', true)",
        [VENDOR_RACE],
      );

      // WP3 Persons in ACCOUNTING for PA_R2..PA_R6, PA_R9
      const { rows: [acctDept] } = await setup.query(
        "select department_id from public.organization_departments where system_key = 'ACCOUNTING'",
      );
      const { rows: [mktDept] } = await setup.query(
        "select department_id from public.organization_departments where system_key = 'MARKETING'",
      );

      async function createAcctPerson(target, code) {
        const { rows: [u] } = await setup.query(
          "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
          [target.app],
        );
        const res = await serviceRpc(setup, "org_department_create_person_admin", [
          OWNER.auth,
          OWNER.app,
          code,
          target.name,
          "2025-01-01",
          acctDept.department_id,
          target.app,
          u.version,
          null,
          `Create ${code} race`,
          nextUuid(),
          sha256(`person:${code}:${seq}`),
        ]);
        return res.person;
      }

      const pPaR2 = await createAcctPerson(PA_R2, "KT-R02");
      await createAcctPerson(PA_R3, "KT-R03");
      await createAcctPerson(PA_R4, "KT-R04");
      const pPaR5 = await createAcctPerson(PA_R5, "KT-R05");
      await createAcctPerson(PA_R6, "KT-R06");
      const pPaR9 = await createAcctPerson(PA_R9, "KT-R09");

      async function assignPa(projectId, targetUser) {
        return serviceRpc(setup, "vendor_finance_assign_project_accountant_admin", [
          OWNER.auth,
          OWNER.app,
          projectId,
          targetUser.app,
          0,
          null,
          `Assign PA ${targetUser.name} on ${projectId}`,
          nextUuid(),
          sha256(`pa:${projectId}:${targetUser.app}:${seq}`),
        ]);
      }
      await assignPa(PRJ_R1, PA_R3);
      await assignPa(PRJ_R2, PA_R2);
      const paR3Assign = await assignPa(PRJ_R3, PA_R3);
      await assignPa(PRJ_R4, PA_R4);
      await assignPa(PRJ_R5, PA_R5);
      const paR6Assign = await assignPa(PRJ_R6, PA_R6);
      await assignPa(PRJ_R8, PA_R2);

      // Assign CASH_HOLDER_RECORD_BEHALF to CASH_R7
      const cashR7Role = await serviceRpc(setup, "vendor_finance_assign_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        CASH_R7.app,
        "CASH_HOLDER_RECORD_BEHALF",
        0,
        null,
        "Assign Cash Holder Race 7",
        nextUuid(),
        sha256(`cash-r7:${seq}`),
      ]);

      // Fund shared advance & initial debt on PRJ_R6 so Race 6 can attempt record_payment_with_offset
      await serviceRpc(setup, "vendor_finance_fund_shared_advance", [
        CASH_R7.auth,
        CASH_R7.app,
        VENDOR_RACE,
        "50000000",
        "2026-10-01",
        "Seed shared advance for Race 6",
        nextUuid(),
        sha256(`seed-adv-r6:${seq}`),
      ]);
      await serviceRpc(setup, "vendor_finance_record_entry", [
        PA_R6.auth,
        PA_R6.app,
        VENDOR_RACE,
        PRJ_R6,
        "SEASONAL",
        "DEBT_RECORDED",
        "30000000",
        "2026-10-02",
        "Seed debt for Race 6",
        nextUuid(),
        sha256(`seed-debt-r6:${seq}`),
      ]);

      // Seed SUBMITTED workers for Races 1..4
      async function seedWorker(projectId, empCode) {
        const batch = await serviceRpc(setup, "direct_entry_create_batch", [
          PM_R1.auth,
          PM_R1.app,
          JSON.stringify([
            {
              project_id: projectId,
              first_work_date: "2026-10-01",
              employee_code: empCode,
              worker_details: makeWorkerDetails(`Công nhân ${empCode}`),
              recruiter_id: PM_R1.recruiter,
              labor_type: "TEMPORARY",
            },
          ]),
          `race-batch-${nextUuid()}`,
        ]);
        await serviceRpc(setup, "direct_entry_transition_submission", [
          PM_R1.auth,
          PM_R1.app,
          batch.submission_id,
          1,
          "SUBMITTED",
          `race-sub-${nextUuid()}`,
        ]);
        const { rows: [e] } = await setup.query(
          "select entry_id from public.direct_entries where submission_id = $1::uuid",
          [batch.submission_id],
        );
        return e.entry_id;
      }

      const wR1 = await seedWorker(PRJ_R1, "hrp-2026-990001");
      const wR2 = await seedWorker(PRJ_R2, "hrp-2026-990002");
      const wR3 = await seedWorker(PRJ_R3, "hrp-2026-990003");
      const wR4 = await seedWorker(PRJ_R4, "hrp-2026-990004");

      async function createSalReq(projectId, workerId) {
        const res = await serviceRpc(setup, "salary_advance_create_request", [
          PM_R1.auth,
          PM_R1.app,
          projectId,
          workerId,
          "2000000",
          `Seed request on ${projectId}`,
          `seed-sal-${nextUuid()}`,
          sha256(`seed-sal:${projectId}:${seq}`),
          "CASH",
        ]);
        return res.request.request_id;
      }
      const reqR2 = await createSalReq(PRJ_R2, wR2);
      const reqR3 = await createSalReq(PRJ_R3, wR3);
      const reqR4 = await createSalReq(PRJ_R4, wR4);

      // =======================================================================
      // RACE 1A (Revoke-first) & RACE 1B (Write-first reverse direction):
      // salary_advance_create_request (PM) vs direct_entry_unassign_project_manager (TL path)
      // =======================================================================
      // 1B first (Write-first reverse barrier on PRJ_R1 before revoking PM_R1):
      // w1 (PM) runs salary_advance_create_request inside BEGIN (holds projects FOR SHARE -> vfin_project SHARED -> app_users FOR SHARE),
      // w2 (TL) calls direct_entry_unassign_project_manager and blocks on projects FOR UPDATE,
      // w1 commits -> w2 completes cleanly with ZERO 40P01 deadlocks!
      const { rows: [pm1Assign] } = await setup.query(
        `select a.assignment_id, a.version, p.version as project_version
           from public.direct_entry_project_manager_assignments a
           join public.direct_entry_projects p on p.project_id = a.project_id
          where a.project_id = $1 and a.manager_recruiter_id = $2::uuid and a.is_current = true`,
        [PRJ_R1, PM_R1.recruiter],
      );
      await w1.query("begin");
      const r1bCreate = await serviceRpcInTx(w1, "salary_advance_create_request", [
        PM_R1.auth,
        PM_R1.app,
        PRJ_R1,
        wR1,
        "1100000",
        "Race 1B create truoc khi TL thu hoi PM",
        `race1b-create-${nextUuid()}`,
        sha256(`race1b-create:${seq}`),
        "CASH",
      ]);
      assert.ok(r1bCreate?.request?.request_id, "Race 1B: create succeeds inside open tx");
      const r1bUnassignP = asSettled(
        serviceRpc(w2, "direct_entry_unassign_project_manager", [
          TL_USER.auth,
          TL_USER.app,
          pm1Assign.assignment_id,
          pm1Assign.version,
          pm1Assign.project_version,
          "Race 1B TL thu hoi PM_R1 doi sau create_request",
          `race1b-unassign-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r1bUnassign = await r1bUnassignP;
      assert.equal(r1bUnassign.status, "fulfilled", `Race 1B: TL unassign must succeed after PM create commits (got ${r1bUnassign.reason?.code}: ${r1bUnassign.reason?.message})`);

      // Re-assign PM_R1 on PRJ_R1 so Race 1A tests the opposite (Revoke-first) direction!
      const { rows: [p1VerAfterUnassign] } = await setup.query(
        "select version from public.direct_entry_projects where project_id = $1",
        [PRJ_R1],
      );
      await setup.query(
        `select public.direct_entry_assign_project_manager(
           $1::uuid, $2::uuid, $3::text, $4::uuid, null::date, $5::integer, 'Re-assign PM_R1 for Race 1A'::text, $6::text
         )`,
        [OWNER.auth, OWNER.app, PRJ_R1, PM_R1.recruiter, p1VerAfterUnassign.version, `re-pm1-${nextUuid()}`],
      );
      const { rows: [pm1AssignA] } = await setup.query(
        `select a.assignment_id, a.version, p.version as project_version
           from public.direct_entry_project_manager_assignments a
           join public.direct_entry_projects p on p.project_id = a.project_id
          where a.project_id = $1 and a.manager_recruiter_id = $2::uuid and a.is_current = true`,
        [PRJ_R1, PM_R1.recruiter],
      );
      // 1A (Revoke-first barrier): w1 (TL) begins unassign (locks projects FOR UPDATE -> app_users FOR UPDATE),
      // w2 (PM) starts create_request and blocks on projects FOR SHARE, w1 commits -> w2 MUST reject 42501 with 0 deadlocks!
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_unassign_project_manager", [
        TL_USER.auth,
        TL_USER.app,
        pm1AssignA.assignment_id,
        pm1AssignA.version,
        pm1AssignA.project_version,
        "TL thu hồi PM_R1 khỏi PRJ_R1 trong Race 1A",
        `race1-unassign-${nextUuid()}`,
      ]);
      const r1OutcomeP = asSettled(
        serviceRpc(w2, "salary_advance_create_request", [
          PM_R1.auth,
          PM_R1.app,
          PRJ_R1,
          wR1,
          "1000000",
          "Race 1 create sau khi TL thu hồi PM",
          `race1-create-${nextUuid()}`,
          sha256(`race1-create:${seq}`),
          "CASH",
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r1Outcome = await r1OutcomeP;
      assert.equal(r1Outcome.status, "rejected", "Race 1: PM create must fail closed after TL revoke");
      assert.notEqual(r1Outcome.reason?.code, "40P01", "Race 1: zero deadlocks");
      assert.equal(r1Outcome.reason?.code, "42501");
      assert.match(String(r1Outcome.reason?.message), /SALARY_ADVANCE_ACCESS_DENIED/);

      // =======================================================================
      // RACE 2: salary_advance_transition_request(APPROVE) vs org_department_end_person_member_admin (WP3 end ACCOUNTING)
      // =======================================================================
      const { rows: [pa2Mem] } = await setup.query(
        `select pm.membership_id, p.version as person_version
           from public.organization_person_department_memberships pm
           join public.organization_persons p on p.person_id = pm.person_id
          where pm.person_id = $1::uuid and pm.ended_at is null`,
        [pPaR2.person_id],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "org_department_end_person_member_admin", [
        OWNER.auth,
        OWNER.app,
        acctDept.department_id,
        pa2Mem.membership_id,
        pa2Mem.person_version,
        "Race 2 kết thúc ACCOUNTING của PA_R2",
        nextUuid(),
        sha256(`race2-end-dept:${seq}`),
      ]);
      const r2OutcomeP = asSettled(
        serviceRpc(w2, "salary_advance_transition_request", [
          PA_R2.auth,
          PA_R2.app,
          reqR2,
          "APPROVE",
          1,
          null,
          `race2-approve-${nextUuid()}`,
          sha256(`race2-approve:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r2Outcome = await r2OutcomeP;
      assert.equal(r2Outcome.status, "rejected", "Race 2: APPROVE must reject after WP3 end ACCOUNTING");
      assert.notEqual(r2Outcome.reason?.code, "40P01", "Race 2: zero deadlocks");
      assert.equal(r2Outcome.reason?.code, "42501");
      assert.match(String(r2Outcome.reason?.message), /SALARY_ADVANCE_ACCESS_DENIED/);
      const { rows: [r2State] } = await setup.query(
        "select request_state from public.salary_advance_requests where request_id = $1::uuid",
        [reqR2],
      );
      assert.equal(r2State.request_state, "OPEN");

      // =======================================================================
      // RACE 3: salary_advance_transition_request(APPROVE) vs vendor_finance_end_project_accountant_admin
      // =======================================================================
      await w1.query("begin");
      await serviceRpcInTx(w1, "vendor_finance_end_project_accountant_admin", [
        OWNER.auth,
        OWNER.app,
        paR3Assign.assignment_id,
        1,
        null,
        "Race 3 kết thúc PA_R3 trên PRJ_R3",
        nextUuid(),
        sha256(`race3-end-pa:${seq}`),
      ]);
      const r3OutcomeP = asSettled(
        serviceRpc(w2, "salary_advance_transition_request", [
          PA_R3.auth,
          PA_R3.app,
          reqR3,
          "APPROVE",
          1,
          null,
          `race3-approve-${nextUuid()}`,
          sha256(`race3-approve:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r3Outcome = await r3OutcomeP;
      assert.equal(r3Outcome.status, "rejected", "Race 3: APPROVE must reject after PA end");
      assert.notEqual(r3Outcome.reason?.code, "40P01", "Race 3: zero deadlocks");
      assert.equal(r3Outcome.reason?.code, "42501");
      assert.match(String(r3Outcome.reason?.message), /SALARY_ADVANCE_ACCESS_DENIED/);

      // =======================================================================
      // RACE 4: salary_advance_transition_request(APPROVE) vs direct_entry_disable_app_user
      // =======================================================================
      const { rows: [pa4Ver] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [PA_R4.app],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        PA_R4.app,
        pa4Ver.version,
        "Race 4 khóa tài khoản PA_R4",
        `race4-disable-${nextUuid()}`,
      ]);
      const r4OutcomeP = asSettled(
        serviceRpc(w2, "salary_advance_transition_request", [
          PA_R4.auth,
          PA_R4.app,
          reqR4,
          "APPROVE",
          1,
          null,
          `race4-approve-${nextUuid()}`,
          sha256(`race4-approve:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r4Outcome = await r4OutcomeP;
      assert.equal(r4Outcome.status, "rejected", "Race 4: APPROVE must reject after account disable");
      assert.notEqual(r4Outcome.reason?.code, "40P01", "Race 4: zero deadlocks");
      assert.equal(r4Outcome.reason?.code, "42501");

      // =======================================================================
      // RACE 5A (Transfer-first) & RACE 5B (Write-first reverse direction):
      // vendor_finance_record_entry (PA) vs org_department_transfer_person_member_admin (ACCOUNTING -> MARKETING)
      // =======================================================================
      // 5B (Write-first reverse barrier): w1 (PA_R5) records entry inside BEGIN (holds projects FOR SHARE -> vfin_project -> app_users FOR SHARE),
      // w2 (Owner) transfers PA_R5 ACCOUNTING -> MARKETING and blocks on app_users FOR UPDATE,
      // w1 commits -> w2 transfer commits cleanly afterward with ZERO 40P01 deadlocks!
      const { rows: [pa5MemB] } = await setup.query(
        `select pm.membership_id, p.version as person_version
           from public.organization_person_department_memberships pm
           join public.organization_persons p on p.person_id = pm.person_id
          where pm.person_id = $1::uuid and pm.ended_at is null`,
        [pPaR5.person_id],
      );
      await w1.query("begin");
      const r5bEntry = await serviceRpcInTx(w1, "vendor_finance_record_entry", [
        PA_R5.auth,
        PA_R5.app,
        VENDOR_RACE,
        PRJ_R5,
        "SEASONAL",
        "DEBT_RECORDED",
        "2000000",
        "2026-10-05",
        "Race 5B ghi so truoc khi chuyen phong",
        nextUuid(),
        sha256(`race5b-entry:${seq}`),
      ]);
      assert.ok(r5bEntry?.entry?.entry_id, "Race 5B: entry recorded inside open tx");
      const r5bTransferP = asSettled(
        serviceRpc(w2, "org_department_transfer_person_member_admin", [
          OWNER.auth,
          OWNER.app,
          pPaR5.person_id,
          mktDept.department_id,
          pa5MemB.person_version,
          pa5MemB.membership_id,
          "Race 5B chuyen PA_R5 sang MARKETING doi sau record_entry",
          nextUuid(),
          sha256(`race5b-transfer:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r5bTransfer = await r5bTransferP;
      assert.equal(r5bTransfer.status, "fulfilled", `Race 5B: transfer must succeed after record_entry commits (got ${r5bTransfer.reason?.code}: ${r5bTransfer.reason?.message})`);

      // Transfer PA_R5 back to ACCOUNTING so Race 5A tests the opposite (Transfer-first) direction!
      const { rows: [pa5MemBack] } = await setup.query(
        `select pm.membership_id, p.version as person_version
           from public.organization_person_department_memberships pm
           join public.organization_persons p on p.person_id = pm.person_id
          where pm.person_id = $1::uuid and pm.ended_at is null`,
        [pPaR5.person_id],
      );
      await serviceRpc(setup, "org_department_transfer_person_member_admin", [
        OWNER.auth,
        OWNER.app,
        pPaR5.person_id,
        acctDept.department_id,
        pa5MemBack.person_version,
        pa5MemBack.membership_id,
        "Return PA_R5 to ACCOUNTING for Race 5A",
        nextUuid(),
        sha256(`race5a-return:${seq}`),
      ]);
      const { rows: [pa5Mem] } = await setup.query(
        `select pm.membership_id, p.version as person_version
           from public.organization_person_department_memberships pm
           join public.organization_persons p on p.person_id = pm.person_id
          where pm.person_id = $1::uuid and pm.ended_at is null`,
        [pPaR5.person_id],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "org_department_transfer_person_member_admin", [
        OWNER.auth,
        OWNER.app,
        pPaR5.person_id,
        mktDept.department_id,
        pa5Mem.person_version,
        pa5Mem.membership_id,
        "Race 5A chuyển PA_R5 sang MARKETING",
        nextUuid(),
        sha256(`race5-transfer:${seq}`),
      ]);
      const r5OutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_record_entry", [
          PA_R5.auth,
          PA_R5.app,
          VENDOR_RACE,
          PRJ_R5,
          "SEASONAL",
          "DEBT_RECORDED",
          "5000000",
          "2026-10-05",
          "Race 5A ghi sổ sau khi chuyển phòng",
          nextUuid(),
          sha256(`race5-entry:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r5Outcome = await r5OutcomeP;
      assert.equal(r5Outcome.status, "rejected", "Race 5A: record_entry must fail closed after transfer out of ACCOUNTING");
      assert.notEqual(r5Outcome.reason?.code, "40P01", "Race 5A: zero deadlocks");
      assert.equal(r5Outcome.reason?.code, "42501");
      const { rows: [r5Cnt] } = await setup.query(
        "select count(*)::int as cnt from public.vendor_finance_entries where project_id = $1",
        [PRJ_R5],
      );
      assert.equal(r5Cnt.cnt, 1, "Race 5A/5B: strictly 1 ledger entry (5B before transfer; 0 from rejected 5A)");

      // =======================================================================
      // RACE 6: vendor_finance_record_payment_with_offset (PA) vs vendor_finance_end_project_accountant_admin
      // =======================================================================
      await w1.query("begin");
      await serviceRpcInTx(w1, "vendor_finance_end_project_accountant_admin", [
        OWNER.auth,
        OWNER.app,
        paR6Assign.assignment_id,
        1,
        null,
        "Race 6 kết thúc PA_R6 trên PRJ_R6",
        nextUuid(),
        sha256(`race6-end-pa:${seq}`),
      ]);
      const r6OutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_record_payment_with_offset", [
          PA_R6.auth,
          PA_R6.app,
          VENDOR_RACE,
          PRJ_R6,
          "SEASONAL",
          "10000000",
          "5000000",
          "2026-10-06",
          "Race 6 thanh toán + khấu trừ sau khi kết thúc PA",
          nextUuid(),
          sha256(`race6-pay-offset:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r6Outcome = await r6OutcomeP;
      assert.equal(r6Outcome.status, "rejected", "Race 6: payment+offset must reject after PA end");
      assert.notEqual(r6Outcome.reason?.code, "40P01", "Race 6: zero deadlocks");
      assert.equal(r6Outcome.reason?.code, "42501");
      const { rows: [r6AdvSum] } = await setup.query(
        "select coalesce(sum(balance_delta_minor), 0)::text as s from public.vendor_finance_shared_advance_movements where vendor_id = $1",
        [VENDOR_RACE],
      );
      assert.equal(r6AdvSum.s, "50000000", "Race 6: shared advance balance completely untouched");

      // =======================================================================
      // RACE 7: vendor_finance_fund_shared_advance (CASH_HOLDER_RECORD_BEHALF) vs vendor_finance_end_global_role_admin
      // =======================================================================
      await w1.query("begin");
      await serviceRpcInTx(w1, "vendor_finance_end_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        cashR7Role.role_grant_id,
        1,
        null,
        "Race 7 kết thúc CASH_HOLDER_RECORD_BEHALF",
        nextUuid(),
        sha256(`race7-end-role:${seq}`),
      ]);
      const r7OutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_fund_shared_advance", [
          CASH_R7.auth,
          CASH_R7.app,
          VENDOR_RACE,
          "7000000",
          "2026-10-07",
          "Race 7 chi ứng sau khi bị thu hồi global role",
          nextUuid(),
          sha256(`race7-fund:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r7Outcome = await r7OutcomeP;
      assert.equal(r7Outcome.status, "rejected", "Race 7: fund_shared_advance must fail closed after global role end");
      assert.notEqual(r7Outcome.reason?.code, "40P01", "Race 7: zero deadlocks");
      assert.equal(r7Outcome.reason?.code, "42501");

      // =======================================================================
      // RACE 8A: vendor_finance_record_entry (ADMIN_R8A) vs direct_entry_authz_revoke_global_role_admin (ADMIN)
      // =======================================================================
      const { rows: [adm8aVer] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [ADMIN_R8A.app],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        ADMIN_R8A.app,
        adminR8aAssign.assignment.assignment_id,
        adm8aVer.version,
        "Race 8A thu hồi ADMIN của ADMIN_R8A",
        nextUuid(),
        sha256(`race8a-revoke:${seq}`),
      ]);
      const r8aOutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_record_entry", [
          ADMIN_R8A.auth,
          ADMIN_R8A.app,
          VENDOR_RACE,
          PRJ_R8,
          "SEASONAL",
          "DEBT_RECORDED",
          "4000000",
          "2026-10-08",
          "Race 8A ghi sổ sau thu hồi ADMIN",
          nextUuid(),
          sha256(`race8a-entry:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r8aOutcome = await r8aOutcomeP;
      assert.equal(r8aOutcome.status, "rejected", "Race 8A: record_entry must fail closed after ADMIN revoke");
      assert.notEqual(r8aOutcome.reason?.code, "40P01", "Race 8A: zero deadlocks");
      assert.equal(r8aOutcome.reason?.code, "42501");

      // =======================================================================
      // RACE 8B: vendor_finance_record_entry (ADMIN_R8B) vs direct_entry_disable_app_user
      // =======================================================================
      const { rows: [adm8bVer] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [ADMIN_R8B.app],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        ADMIN_R8B.app,
        adm8bVer.version,
        "Race 8B khóa ADMIN_R8B",
        `race8b-disable-${nextUuid()}`,
      ]);
      const r8bOutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_record_entry", [
          ADMIN_R8B.auth,
          ADMIN_R8B.app,
          VENDOR_RACE,
          PRJ_R8,
          "SEASONAL",
          "DEBT_RECORDED",
          "4000000",
          "2026-10-08",
          "Race 8B ghi sổ sau khóa tài khoản ADMIN",
          nextUuid(),
          sha256(`race8b-entry:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r8bOutcome = await r8bOutcomeP;
      assert.equal(r8bOutcome.status, "rejected", "Race 8B: record_entry must fail closed after ADMIN disable");
      assert.notEqual(r8bOutcome.reason?.code, "40P01", "Race 8B: zero deadlocks");
      assert.equal(r8bOutcome.reason?.code, "42501");

      // =======================================================================
      // RACE 9: vendor_finance_assign_project_accountant_admin vs org_department_end_person_member_admin on target PA_R9
      // =======================================================================
      const { rows: [pa9Mem] } = await setup.query(
        `select pm.membership_id, p.version as person_version
           from public.organization_person_department_memberships pm
           join public.organization_persons p on p.person_id = pm.person_id
          where pm.person_id = $1::uuid and pm.ended_at is null`,
        [pPaR9.person_id],
      );
      await w1.query("begin");
      await serviceRpcInTx(w1, "org_department_end_person_member_admin", [
        OWNER.auth,
        OWNER.app,
        acctDept.department_id,
        pa9Mem.membership_id,
        pa9Mem.person_version,
        "Race 9 kết thúc ACCOUNTING của PA_R9 trước khi gán PA",
        nextUuid(),
        sha256(`race9-end-dept:${seq}`),
      ]);
      const r9OutcomeP = asSettled(
        serviceRpc(w2, "vendor_finance_assign_project_accountant_admin", [
          OWNER.auth,
          OWNER.app,
          PRJ_R9,
          PA_R9.app,
          0,
          null,
          "Race 9 gán PA_R9 vào PRJ_R9 trong khi bị rút khỏi ACCOUNTING",
          nextUuid(),
          sha256(`race9-assign-pa:${seq}`),
        ]),
      );
      await waitUntilBlocked(observer, "wp8a-w2");
      await w1.query("commit");
      const r9Outcome = await r9OutcomeP;
      assert.equal(r9Outcome.status, "rejected", "Race 9: assign PA must fail closed once target loses ACCOUNTING");
      assert.notEqual(r9Outcome.reason?.code, "40P01", "Race 9: zero deadlocks");
      assert.equal(r9Outcome.reason?.code, "42200");
      assert.match(String(r9Outcome.reason?.message), /VENDOR_FINANCE_ACCOUNTANT_NOT_ELIGIBLE/);
      const { rows: [r9PaCnt] } = await setup.query(
        "select count(*)::int as cnt from public.vendor_finance_project_accountants where project_id = $1",
        [PRJ_R9],
      );
      assert.equal(r9PaCnt.cnt, 0, "Race 9: zero PA rows committed for non-ACCOUNTING target");

      // =======================================================================
      // RACE 10 (P1 AB-BA Lock-Order Regression):
      // Higher-UUID admin (ADMIN_R8A = ...0013) reverses an entry owned by lower-UUID
      // accountant (PA_R6 = ...0011) while w1 locks {PA_R6, ADMIN_R8A} in ascending
      // UUID order FOR UPDATE (matching WP5 role / WP3 multi-link mutations).
      // Because reverse_entry locks {PA_R6, ADMIN_R8A} in ASC order FOR SHARE BEFORE
      // INSERT FK check, w2 blocks on PA_R6 first, w1 acquires ADMIN_R8A FOR UPDATE
      // with ZERO 40P01 deadlock, commits, and w2 reverses cleanly!
      // =======================================================================
      await assignWp5Role(ADMIN_R8A, "ADMIN");
      const { rows: [r6OrigEntry] } = await setup.query(
        `select entry_id from public.vendor_finance_entries
          where project_id = $1 and responsible_accountant_user_id = $2::uuid
          order by created_at asc limit 1`,
        [PRJ_R6, PA_R6.app],
      );
      assert.ok(r6OrigEntry?.entry_id, "Race 10: seeded PA_R6 entry must exist");

      await w1.query("begin");
      // Step 1 of ASC pair lock: hold lower UUID (PA_R6) FOR UPDATE
      await w1.query("select 1 from public.direct_entry_app_users where app_user_id = $1::uuid for update", [PA_R6.app]);

      const r10ReverseP = asSettled(
        serviceRpc(w2, "vendor_finance_reverse_entry", [
          ADMIN_R8A.auth,
          ADMIN_R8A.app,
          r6OrigEntry.entry_id,
          "2026-10-10",
          "Race 10 đảo bút toán PA_R6 bằng ADMIN_R8A có UUID lớn hơn",
          nextUuid(),
          sha256(`race10-rev:${seq}`),
        ]),
      );
      // w2 MUST block on PA_R6 (lower UUID) BEFORE locking ADMIN_R8A (higher UUID)
      await waitUntilBlocked(observer, "wp8a-w2");
      // Step 2 of ASC pair lock: w1 acquires higher UUID (ADMIN_R8A) FOR UPDATE -> succeeds immediately (zero 40P01!)
      await w1.query("select 1 from public.direct_entry_app_users where app_user_id = $1::uuid for update", [ADMIN_R8A.app]);
      await w1.query("commit");

      const r10Reverse = await r10ReverseP;
      assert.equal(
        r10Reverse.status,
        "fulfilled",
        `Race 10: reverse_entry must complete with zero 40P01 deadlock (got ${r10Reverse.reason?.code}: ${r10Reverse.reason?.message})`,
      );
      assert.ok(r10Reverse.value?.reversal_entry?.entry_id);
    } finally {
      for (const c of clients) {
        await c.end().catch(() => {});
      }
      if (started) {
        spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
          encoding: "utf8",
          windowsHide: true,
          stdio: "ignore",
        });
      }
      await rm(tmpRoot, { recursive: true, force: true });
    }
  },
);
