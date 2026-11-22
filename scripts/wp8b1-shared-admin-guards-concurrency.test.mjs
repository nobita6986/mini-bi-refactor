/**
 * WP8B-1 — Shared Admin / Catalog Operator / Project Admin SQL Guards on WP5 Paired Effective Access
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks and ZERO `0A000` volatility errors under `SET LOCAL ROLE service_role`:
 *   Race 1A & 1B (Bidirectional): `direct_entry_disable_app_user` (holds `direct_entry_app_users FOR UPDATE/SHARE`
 *     + `idempotency FOR UPDATE` BEFORE calling `direct_entry_assert_actor_app_user_admin`) racing against
 *     `direct_entry_authz_revoke_global_role_admin` on the secondary Admin actor -> zero deadlock,
 *     immediate fail-closed `42501` (`actor is not a Full Admin`) once revoke commits.
 *   Race 2 (Deterministic lock barrier): `direct_entry_account_operation_finalize_create` (holds
 *     `authz_system_state FOR SHARE` BEFORE calling `direct_entry_assert_actor_app_user_admin`, then
 *     takes FK `KEY SHARE` on actor in `direct_entry_rpc_idempotency`) blocked deterministically behind
 *     open `direct_entry_disable_app_user` (`FOR UPDATE` on `ADMIN_R2`) -> zero lock-order inversion,
 *     followed by post-disable fail-closed `42501` (`actor mapping denied`) on `account_operation_begin`.
 *   Race 3A & 3B:
 *     - 3A: `HR_OPERATOR` calls `direct_entry_assign_project_manager` (`catalog_operator`) blocked behind
 *       open `direct_entry_grant_project_team_scopes_batch` (`app_user_admin`) -> zero deadlock, then
 *       revoking `HR_OPERATOR` denies subsequent `direct_entry_create_vendor` with `42501`.
 *     - 3B: `TEAM_LEADER` calls `direct_entry_assign_project_manager` (exercises `v_authority = 'team_manager_assign'`
 *       -> post-lock `direct_entry_lock_project_team_manager_context` [9 row/advisory locks] ->
 *       `direct_entry_assert_team_leader_read_authority` -> `direct_entry_assert_catalog_operator`)
 *       blocked deterministically behind open `direct_entry_update_project` (called by narrow
 *       `entry_admin @ ALL` Project Admin -> `direct_entry_assert_project_admin`) -> exercises ALL 3 guards
 *       under real lock contention with zero `40P01` deadlocks.
 *   Race 4 (Deterministic MVCC overlap): while `w1` holds an uncommitted `direct_entry_authz_revoke_global_role_admin`
 *     on `ADMIN_R4`, `w2` executes `STABLE` `org_department_list_departments_admin` (succeeds with 0 `0A000`
 *     and 0 blocking); after `w1` commits, `STABLE` org read, `attendance_set_hq_location`, and
 *     `org_department_assign_accounting_member` all immediately fail closed with `42501` (`actor is not a Full Admin`).
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
const WP8B1_MIGRATION_NAME = "20261120120000_wp8b1_shared_admin_guards.sql";

const OWNER = {
  auth: "18c10000-0000-4000-8000-000000000001",
  app: "28c10000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Race WP8B1",
};
const LUANPT = {
  auth: "18c10000-0000-4000-8000-000000000002",
  app: "28c10000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c10000-0000-4000-8000-000000000003",
  app: "28c10000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c10000-0000-4000-8000-000000000004",
  app: "28c10000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const ADMIN_R1A = {
  auth: "18c10000-0000-4000-8000-000000000005",
  app: "28c10000-0000-4000-8000-000000000005",
  email: "admin.r1a.wp8b1@hrpartner.vn",
  name: "Admin Race 1A",
};
const TARGET_R1A = {
  auth: "18c10000-0000-4000-8000-000000000006",
  app: "28c10000-0000-4000-8000-000000000006",
  email: "target.r1a.wp8b1@hrpartner.vn",
  name: "Target Race 1A",
};
const ADMIN_R1B = {
  auth: "18c10000-0000-4000-8000-000000000007",
  app: "28c10000-0000-4000-8000-000000000007",
  email: "admin.r1b.wp8b1@hrpartner.vn",
  name: "Admin Race 1B",
};
const TARGET_R1B = {
  auth: "18c10000-0000-4000-8000-000000000008",
  app: "28c10000-0000-4000-8000-000000000008",
  email: "target.r1b.wp8b1@hrpartner.vn",
  name: "Target Race 1B",
};
const ADMIN_R2 = {
  auth: "18c10000-0000-4000-8000-000000000009",
  app: "28c10000-0000-4000-8000-000000000009",
  email: "admin.r2.wp8b1@hrpartner.vn",
  name: "Admin Race 2",
};
const HR_R3 = {
  auth: "18c10000-0000-4000-8000-000000000010",
  app: "28c10000-0000-4000-8000-000000000010",
  email: "hr.r3.wp8b1@hrpartner.vn",
  name: "HR Operator Race 3",
};
const PM_CAND_R3 = {
  auth: "18c10000-0000-4000-8000-000000000011",
  app: "28c10000-0000-4000-8000-000000000011",
  recruiter: "38c10000-0000-4000-8000-000000000011",
  email: "pmcand.r3.wp8b1@hrpartner.vn",
  name: "PM Candidate Race 3",
};
const TL_R3 = {
  auth: "18c10000-0000-4000-8000-000000000014",
  app: "28c10000-0000-4000-8000-000000000014",
  recruiter: "38c10000-0000-4000-8000-000000000014",
  email: "tl.r3.wp8b1@hrpartner.vn",
  name: "Team Leader Race 3",
};
const PM_CAND_R3_B = {
  auth: "18c10000-0000-4000-8000-000000000015",
  app: "28c10000-0000-4000-8000-000000000015",
  recruiter: "38c10000-0000-4000-8000-000000000015",
  email: "pmcand.r3b.wp8b1@hrpartner.vn",
  name: "PM Candidate Race 3B",
};
const PRJ_ADMIN_R3 = {
  auth: "18c10000-0000-4000-8000-000000000016",
  app: "28c10000-0000-4000-8000-000000000016",
  email: "prjadmin.r3.wp8b1@hrpartner.vn",
  name: "Project Admin Race 3",
};
const ADMIN_R4 = {
  auth: "18c10000-0000-4000-8000-000000000012",
  app: "28c10000-0000-4000-8000-000000000012",
  email: "admin.r4.wp8b1@hrpartner.vn",
  name: "Admin Race 4",
};
const ACCT_TARGET_R4 = {
  auth: "18c10000-0000-4000-8000-000000000013",
  app: "28c10000-0000-4000-8000-000000000013",
  email: "accttarget.r4.wp8b1@hrpartner.vn",
  name: "Accounting Target Race 4",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  ADMIN_R1A,
  TARGET_R1A,
  ADMIN_R1B,
  TARGET_R1B,
  ADMIN_R2,
  HR_R3,
  PM_CAND_R3,
  TL_R3,
  PM_CAND_R3_B,
  PRJ_ADMIN_R3,
  ADMIN_R4,
  ACCT_TARGET_R4,
];

const TEAM_R3 = "48c10000-0000-4000-8000-000000000001";
const PRJ_R3 = "wp8b1_race_p3";

const ADMIN_SEED_CAPS = [
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
];

let seq = 1;
function nextUuid() {
  return `98c10000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
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
      "select wait_event_type from pg_stat_activity where application_name = $1",
      [appName],
    );
    if (rows[0]?.wait_event_type === "Lock") {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${appName} to block on Lock`);
}

async function assignRole(client, target, roleCode, reason) {
  const ver = (
    await client.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(client, "direct_entry_authz_assign_global_role_admin", [
    OWNER.auth,
    OWNER.app,
    target.app,
    roleCode,
    ver,
    reason,
    key,
    sha256(`assign:${target.app}:${roleCode}:${key}`),
  ]);
}

async function activeAssignmentId(client, appUserId, roleCode) {
  const { rows } = await client.query(
    "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = $2 and ended_at is null",
    [appUserId, roleCode],
  );
  assert.equal(rows.length, 1, `Expected 1 active ${roleCode} assignment for ${appUserId}`);
  return rows[0].assignment_id;
}

const initdb = binary("initdb");
const pgCtl = binary("pg_ctl");

test(
  "WP8B-1 Real PostgreSQL 18 Concurrency: bidirectional lock-before-guard races across Account, Project/Catalog, Attendance & STABLE Org reads (0 deadlocks, 0 0A000, fail-closed)",
  { skip: !initdb || !pgCtl ? "PostgreSQL binaries not available" : false },
  async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "bi-wp8b1-pg-"));
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

      const setup = await connect(port, "wp8b1-setup");
      const w1 = await connect(port, "wp8b1-w1");
      const w2 = await connect(port, "wp8b1-w2");
      const observer = await connect(port, "wp8b1-obs");
      clients.push(setup, w1, w2, observer);

      await setup.query(
        "create role anon; create role authenticated; create role service_role;" +
          " create schema auth; create table auth.users (id uuid primary key, email text);",
      );
      const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
      assert.ok(names.includes(WP8B1_MIGRATION_NAME), `${WP8B1_MIGRATION_NAME} must exist`);
      for (const name of names) {
        await setup.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
        if (name === WP8B1_MIGRATION_NAME) break;
      }

      // Seed accounts + WP5 cutover
      for (const u of ALL_USERS) {
        await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
        await setup.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
          [u.app, u.auth, u.name],
        );
      }
      for (const adm of [OWNER, LIENVU, NGATTT]) {
        for (const cap of ADMIN_SEED_CAPS) {
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

      await setup.query(
        "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP8B1_RT3', 'Race Team 3', true)",
        [TEAM_R3],
      );
      await setup.query(
        "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Race Project 3', true)",
        [PRJ_R3],
      );
      const cutoverPlan = await runWp5Cutover(setup, { mode: "read-only-plan" });
      assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
      const cutover = await runWp5Cutover(setup, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: cutoverPlan.manifest_fingerprint,
      });
      assert.equal(cutover.status, "APPLIED");

      for (const recUser of [PM_CAND_R3, TL_R3, PM_CAND_R3_B]) {
        await setup.query(
          "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
          [recUser.recruiter, recUser.name],
        );
        await setup.query(
          "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
          [recUser.recruiter],
        );
        await setup.query(
          "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
          [recUser.recruiter, TEAM_R3],
        );
        await setup.query(
          "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
          [recUser.app, recUser.recruiter],
        );
      }

      // Assign roles for race actors
      await assignRole(setup, ADMIN_R1A, "ADMIN", "Race 1A secondary admin");
      await assignRole(setup, ADMIN_R1B, "ADMIN", "Race 1B secondary admin");
      await assignRole(setup, ADMIN_R2, "ADMIN", "Race 2 secondary admin");
      await assignRole(setup, HR_R3, "HR_OPERATOR", "Race 3 HR operator");
      await assignRole(setup, ADMIN_R4, "ADMIN", "Race 4 secondary admin");

      // Designate TL_R3 on TEAM_R3 and give PRJ_ADMIN_R3 narrow entry_admin @ ALL direct grant
      await serviceRpc(setup, "direct_entry_designate_team_leader", [
        OWNER.auth,
        OWNER.app,
        TEAM_R3,
        TL_R3.app,
        null,
        1,
        "Race 3B Team Leader on TEAM_R3",
        `r3b-tl-${nextUuid()}`,
      ]);
      await setup.query(
        `insert into public.authz_direct_capability_grants
          (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, 'entry_admin', 'ALL', null, 'EXCEPTION_GRANT', 'Race 3B narrow project admin', $2::uuid)`,
        [PRJ_ADMIN_R3.app, OWNER.app],
      );
      await setup.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [PRJ_ADMIN_R3.app]);

      // =========================================================================
      // RACE 1A: w1 revokes ADMIN from ADMIN_R1A (holds lock) while w2 (ADMIN_R1A)
      // calls direct_entry_disable_app_user (locks direct_entry_app_users BEFORE guard)
      // =========================================================================
      const r1aAssign = await activeAssignmentId(setup, ADMIN_R1A.app, "ADMIN");
      const r1aAdminVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_R1A.app])
      ).rows[0].version;
      const r1aTargetVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TARGET_R1A.app])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        ADMIN_R1A.app,
        r1aAssign,
        r1aAdminVer,
        "Race 1A revoke ADMIN before disable_app_user",
        nextUuid(),
        sha256("r1a-revoke"),
      ]);

      const r1aDisablePromise = asSettled(
        serviceRpc(w2, "direct_entry_disable_app_user", [
          ADMIN_R1A.auth,
          ADMIN_R1A.app,
          TARGET_R1A.app,
          r1aTargetVer,
          "Race 1A disable must fail after ADMIN revoked",
          `r1a-disable-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8b1-w2");
      await w1.query("commit");

      const r1aDisableRes = await r1aDisablePromise;
      assert.equal(r1aDisableRes.status, "rejected", "Race 1A: disable_app_user must fail closed after revoke");
      assert.notEqual(r1aDisableRes.reason.code, "40P01", "Race 1A must never deadlock");
      assert.equal(r1aDisableRes.reason.code, "42501");
      assert.match(r1aDisableRes.reason.message, /actor is not a Full Admin/);
      assert.equal(
        (await observer.query("select enabled from public.direct_entry_app_users where app_user_id = $1::uuid", [TARGET_R1A.app]))
          .rows[0].enabled,
        true,
        "Race 1A: TARGET_R1A must remain enabled",
      );

      // =========================================================================
      // RACE 1B (Reverse barrier): w1 (ADMIN_R1B) executes disable_app_user first
      // (holds direct_entry_app_users locks), while w2 (OWNER) revokes ADMIN_R1B
      // =========================================================================
      const r1bAssign = await activeAssignmentId(setup, ADMIN_R1B.app, "ADMIN");
      const r1bAdminVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_R1B.app])
      ).rows[0].version;
      const r1bTargetVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TARGET_R1B.app])
      ).rows[0].version;

      await w1.query("begin");
      const r1bDisabled = await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        ADMIN_R1B.auth,
        ADMIN_R1B.app,
        TARGET_R1B.app,
        r1bTargetVer,
        "Race 1B disable before revoke commits",
        `r1b-disable-${nextUuid()}`,
      ]);
      assert.equal(r1bDisabled.change, "disable");

      const r1bRevokePromise = asSettled(
        serviceRpc(w2, "direct_entry_authz_revoke_global_role_admin", [
          OWNER.auth,
          OWNER.app,
          ADMIN_R1B.app,
          r1bAssign,
          r1bAdminVer,
          "Race 1B revoke while disable holds locks",
          nextUuid(),
          sha256("r1b-revoke"),
        ]),
      );
      await waitUntilBlocked(observer, "wp8b1-w2");
      await w1.query("commit");

      const r1bRevokeRes = await r1bRevokePromise;
      assert.equal(r1bRevokeRes.status, "fulfilled", `Race 1B revoke must succeed cleanly (0 deadlocks): ${r1bRevokeRes.reason?.message}`);
      // Subsequent enable attempt by revoked ADMIN_R1B fails closed
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_enable_app_user", [
            ADMIN_R1B.auth,
            ADMIN_R1B.app,
            TARGET_R1B.app,
            r1bDisabled.version,
            "Race 1B post-revoke enable must fail",
            `r1b-enable-${nextUuid()}`,
          ]),
        (err) => err.code === "42501" && /actor is not a Full Admin/.test(err.message),
      );

      // =========================================================================
      // RACE 2 (Deterministic lock barrier): w1 holds direct_entry_disable_app_user
      // (FOR UPDATE on ADMIN_R2) while w2 calls direct_entry_account_operation_finalize_create
      // (authz_system_state FOR SHARE -> guard -> idempotency_begin FK KEY SHARE on ADMIN_R2)
      // =========================================================================
      const r2Begin = await serviceRpc(setup, "direct_entry_account_operation_begin", [
        ADMIN_R2.auth,
        ADMIN_R2.app,
        "CREATE_ACCOUNT",
        "r2.created.wp8b1",
        "Race 2 Created Account",
        null,
        "Race 2 begin before disable",
        `r2-begin-${nextUuid()}`,
      ]);
      await serviceRpc(setup, "direct_entry_account_operation_claim", [
        ADMIN_R2.auth,
        ADMIN_R2.app,
        r2Begin.intent_id,
        r2Begin.intent_token,
      ]);
      const r2NewAuth = nextUuid();
      await setup.query("insert into auth.users (id, email) values ($1::uuid, 'r2.created.wp8b1@hrpartner.vn')", [r2NewAuth]);

      const r2AdminVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_R2.app])
      ).rows[0].version;

      await w1.query("begin");
      const r2Disabled = await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        ADMIN_R2.app,
        r2AdminVer,
        "Race 2 disable ADMIN_R2 while finalize_create races",
        `r2-disable-${nextUuid()}`,
      ]);
      assert.equal(r2Disabled.change, "disable");

      // w2 acquires authz_system_state FOR SHARE, passes guard on MVCC pre-commit snapshot,
      // then deterministically blocks on direct_entry_rpc_idempotency FK KEY SHARE vs w1's FOR UPDATE on ADMIN_R2!
      const r2FinalizePromise = asSettled(
        serviceRpc(w2, "direct_entry_account_operation_finalize_create", [
          ADMIN_R2.auth,
          ADMIN_R2.app,
          r2Begin.intent_id,
          r2Begin.intent_token,
          r2NewAuth,
          `r2-finalize-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8b1-w2");
      await w1.query("commit");

      const r2FinalizeRes = await r2FinalizePromise;
      if (r2FinalizeRes.status === "rejected") {
        assert.notEqual(r2FinalizeRes.reason.code, "40P01", "Race 2 finalize_create must never deadlock");
      }
      // After disable commits, any further account_operation_begin by ADMIN_R2 MUST fail closed
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_account_operation_begin", [
            ADMIN_R2.auth,
            ADMIN_R2.app,
            "CREATE_ACCOUNT",
            "r2.denied.wp8b1",
            "Race 2 Denied",
            null,
            "Post-disable denied",
            `r2-post-disable-${nextUuid()}`,
          ]),
        (err) => err.code === "42501" && /actor mapping denied/.test(err.message),
      );

      // =========================================================================
      // RACE 3A & 3B:
      //   3A: HR_OPERATOR assign_project_manager (catalog_operator) blocked behind open
      //       grant_project_team_scopes_batch (app_user_admin), followed by HR_OPERATOR revoke.
      //   3B: TEAM_LEADER assign_project_manager (exercises v_authority='team_manager_assign' ->
      //       post-lock lock_project_team_manager_context [9 locks] -> assert_team_leader_read_authority
      //       -> catalog_operator) blocked behind open update_project by narrow entry_admin@ALL
      //       Project Admin (exercises direct_entry_assert_project_admin!).
      // =========================================================================
      const r3Assign = await activeAssignmentId(setup, HR_R3.app, "HR_OPERATOR");
      const r3HrVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [HR_R3.app])
      ).rows[0].version;

      await w1.query("begin");
      const r3Pts = await serviceRpcInTx(w1, "direct_entry_grant_project_team_scopes_batch", [
        OWNER.auth,
        OWNER.app,
        TEAM_R3,
        [PRJ_R3],
        "Race 3A grant project-team scope batch",
        `r3-pts-${nextUuid()}`,
      ]);
      assert.ok(r3Pts);

      const r3AssignPmPromise = asSettled(
        serviceRpc(w2, "direct_entry_assign_project_manager", [
          HR_R3.auth,
          HR_R3.app,
          PRJ_R3,
          PM_CAND_R3.recruiter,
          null,
          1,
          "Race 3A HR_OPERATOR assign PM",
          `r3-pm-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8b1-w2");
      await w1.query("commit");

      const r3AssignPmRes = await r3AssignPmPromise;
      assert.equal(r3AssignPmRes.status, "fulfilled", `Race 3A assign_project_manager must succeed (0 deadlocks): ${r3AssignPmRes.reason?.message}`);

      // Race 3B: narrow Project Admin (entry_admin @ ALL) holds FOR UPDATE on PRJ_R3 via update_project
      // (exercises direct_entry_assert_project_admin), while TL_R3 calls assign_project_manager on PRJ_R3
      // (exercises post-lock lock_project_team_manager_context -> assert_team_leader_read_authority -> catalog_operator)
      const prjVerBefore3b = (
        await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_R3])
      ).rows[0].version;
      await w1.query("begin");
      const r3bUpdated = await serviceRpcInTx(w1, "direct_entry_update_project", [
        PRJ_ADMIN_R3.auth,
        PRJ_ADMIN_R3.app,
        PRJ_R3,
        prjVerBefore3b,
        "Race Project 3 Updated",
        "Race 3B narrow Project Admin update",
        `r3b-upd-${nextUuid()}`,
      ]);
      assert.equal(r3bUpdated.version, prjVerBefore3b + 1);

      const r3bTlAssignPromise = asSettled(
        serviceRpc(w2, "direct_entry_assign_project_manager", [
          TL_R3.auth,
          TL_R3.app,
          PRJ_R3,
          PM_CAND_R3_B.recruiter,
          null,
          prjVerBefore3b + 1,
          "Race 3B TL assign PM hitting post-lock catalog_operator check",
          `r3b-tl-pm-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8b1-w2");
      await w1.query("commit");

      const r3bTlAssignRes = await r3bTlAssignPromise;
      assert.equal(
        r3bTlAssignRes.status,
        "fulfilled",
        `Race 3B TL assign_project_manager (post-lock catalog_operator) must succeed with 0 deadlocks: ${r3bTlAssignRes.reason?.message}`,
      );

      // Now revoke HR_OPERATOR from HR_R3 and verify immediate denial on project/catalog callers
      await serviceRpc(w1, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        HR_R3.app,
        r3Assign,
        r3HrVer,
        "Race 3 revoke HR_OPERATOR",
        nextUuid(),
        sha256("r3-revoke-hr"),
      ]);
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_create_vendor", [
            HR_R3.auth,
            HR_R3.app,
            0,
            "r3_denied_vendor",
            "Denied Vendor",
            "2026-01-01",
            "Post-revoke denied",
            `r3-v-denied-${nextUuid()}`,
          ]),
        (err) => err.code === "42501" && /catalog operator denied/.test(err.message),
      );

      // =========================================================================
      // RACE 4 (Deterministic MVCC overlap): STABLE read org_department_list_departments_admin
      // while w1 holds uncommitted ADMIN revoke (proves zero 0A000 and zero lock blocking),
      // then post-commit fail-closed 42501 across STABLE org read, HQ write & accounting assign
      // =========================================================================
      const r4HqBefore = await serviceRpc(w2, "attendance_set_hq_location", [
        ADMIN_R4.auth,
        ADMIN_R4.app,
        21.0285,
        105.8542,
        0,
        nextUuid(),
        sha256("r4-hq-v1"),
      ]);
      assert.equal(r4HqBefore.hq.version, 1);

      const r4Assign = await activeAssignmentId(setup, ADMIN_R4.app, "ADMIN");
      const r4AdminVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_R4.app])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        ADMIN_R4.app,
        r4Assign,
        r4AdminVer,
        "Race 4 uncommitted revoke ADMIN_R4",
        nextUuid(),
        sha256("r4-revoke"),
      ]);
      // While w1 holds exclusive lock on ADMIN_R4, STABLE read in w2 MUST succeed immediately under MVCC
      // without blocking on any row lock and without throwing 0A000!
      const r4DeptsDuringUncommittedRevoke = await serviceRpc(w2, "org_department_list_departments_admin", [
        ADMIN_R4.auth,
        ADMIN_R4.app,
      ]);
      assert.ok(Array.isArray(r4DeptsDuringUncommittedRevoke.departments));
      await w1.query("commit");

      // Post-revoke: STABLE org read, HQ write, and accounting member assign ALL fail closed with 42501
      await assert.rejects(
        () => serviceRpc(w2, "org_department_list_departments_admin", [ADMIN_R4.auth, ADMIN_R4.app]),
        (err) => err.code === "42501" && /actor is not a Full Admin/.test(err.message),
      );
      await assert.rejects(
        () =>
          serviceRpc(w2, "attendance_set_hq_location", [
            ADMIN_R4.auth,
            ADMIN_R4.app,
            10.7769,
            106.7009,
            1,
            nextUuid(),
            sha256("r4-hq-v2-denied"),
          ]),
        (err) => err.code === "42501" && /actor is not a Full Admin/.test(err.message),
      );
      await assert.rejects(
        () =>
          serviceRpc(w2, "org_department_assign_accounting_member", [
            ADMIN_R4.auth,
            ADMIN_R4.app,
            ACCT_TARGET_R4.app,
            0,
            null,
            "Race 4 denied accounting assign",
            nextUuid(),
            sha256("r4-acct-denied"),
          ]),
        (err) => err.code === "42501" && /actor is not a Full Admin/.test(err.message),
      );
    } finally {
      for (const c of clients) {
        await c.end().catch(() => {});
      }
      if (started) {
        spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
      }
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  },
);
