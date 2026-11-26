/**
 * PR #28 — Migration #237 Real PostgreSQL 18 Preflight, ACL & Post-Cleanup Concurrency Suite.
 *
 * Pure ESM (`node --test`) against an isolated ephemeral PostgreSQL 18 cluster.
 * Verifies:
 *   1. Fail-closed preflight abort on real PG18 when a legacy SERVICE row exists
 *      (raises PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES with 0 DDL applied).
 *   2. Forward apply after resolving legacy row -> dynamic S0-T1-C security postconditions
 *      PASS (0 client/PUBLIC EXECUTE, 0 legacy pg_proc refs, 0 retired signatures).
 *   3. Post-#237 concurrent 13-arg leave_management_upsert_employee_profile_admin and
 *      concurrent direct_entry_authz_assign_group_member_admin under SET LOCAL ROLE service_role:
 *      0 deadlocks (40P01), deterministic OCC/idempotency, and intact Owner is_protected lock.
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

import {
  PR28_CLEANUP_MIGRATION_NAME,
  PR28_CLEANUP_RETIRED_RPC_SIGNATURES,
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "19002000-0000-4000-8000-000000000001",
  app: "29002000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner PG18 Cleanup",
};
const LUANPT = {
  auth: "19002000-0000-4000-8000-000000000002",
  app: "29002000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT PG18 Cleanup",
};
const LIENVU = {
  auth: "19002000-0000-4000-8000-000000000003",
  app: "29002000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu PG18 Cleanup",
};
const NGATTT = {
  auth: "19002000-0000-4000-8000-000000000004",
  app: "29002000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT PG18 Cleanup",
};
const TARGET = {
  auth: "19002000-0000-4000-8000-000000000011",
  app: "29002000-0000-4000-8000-000000000011",
  email: "cleanup.target@hrpartner.vn",
  name: "Cleanup Target User",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `99002000-0000-4000-8000-${hex}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function binary(name) {
  const binDir = process.env.P3_1_W02A_PG_BIN
    ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

function runBin(bin, args, { ignoreOutput = false } = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  if (r.status !== 0) {
    throw new Error(`${path.basename(bin)} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
}

async function startCluster() {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL binaries (initdb/pg_ctl) are required");
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr28-cleanup-pg18-"));
  const dataDir = path.join(dir, "data");
  const logFile = path.join(dir, "pg.log");
  const port = await freePort();
  runBin(initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"]);
  runBin(
    pgCtl,
    [
      "-D",
      dataDir,
      "-l",
      logFile,
      "-o",
      `-p ${port} -k "${dir}" -c listen_addresses=127.0.0.1 -c max_connections=40 -c fsync=off -c synchronous_commit=off -c deadlock_timeout=100ms`,
      "-w",
      "start",
    ],
    { ignoreOutput: true },
  );
  return {
    port,
    async stop() {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function connect(port, database = "postgres") {
  const c = new Client({ host: "127.0.0.1", port, user: "postgres", database });
  await c.connect();
  return c;
}

async function serviceQuery(client, sql, params = []) {
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

test("PR #28 #237 PG18: fail-closed preflight, S0-T1-C postconditions, and post-cleanup concurrency", async () => {
  const cluster = await startCluster();
  let admin = null;
  const workers = [];
  try {
    admin = await connect(cluster.port, "postgres");
    await admin.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    `);

    const names = (await readdir(MIGRATION_DIR))
      .filter((f) => f.endsWith(".sql") && f <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
      .sort();
    const grpIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const cleanupIdx = names.indexOf(PR28_CLEANUP_MIGRATION_NAME);
    assert.ok(grpIdx > 0 && cleanupIdx > grpIdx, `${PR28_CLEANUP_MIGRATION_NAME} must follow ${PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME}`);
    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const cleanupSql = await readFile(path.join(MIGRATION_DIR, PR28_CLEANUP_MIGRATION_NAME), "utf8");

    // Mirror real production rollout path: #001..#235 -> WP5 cutover -> #236 -> preflight Gate 1 -> #237
    const applied = new Set();
    for (let i = 0; i < grpIdx; i += 1) {
      await admin.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
      applied.add(names[i]);
    }

    for (const u of [OWNER, LUANPT, LIENVU, NGATTT, TARGET]) {
      await admin.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await admin.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      await admin.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2020-01-01', true), ($1::uuid, 'own', null, '2020-01-01', true)",
        [adm.app],
      );
      for (const cap of [
        "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
        "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
        "audit_view", "worker_edit_history_view", "document_upload", "document_view",
        "employment_status.review", "employment_status.apply", "change_request_create",
        "change_review", "employment_status.request", "duplicate_cccd_withdraw",
      ]) {
        await admin.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2020-01-01', true)",
          [adm.app, cap],
        );
      }
    }

    const plan = await runWp5Cutover(admin, { mode: "read-only-plan" });
    await runWp5Cutover(admin, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
      actorAppUserId: OWNER.app,
      reason: "PG18 pre-#236 WP5 cutover setup",
    });

    // Apply #236 (backfills Owner & BoD/Admin into SYSTEM_ADMIN group)
    for (let i = grpIdx; i < cleanupIdx; i += 1) {
      await admin.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
      applied.add(names[i]);
    }

    // 1. Fail-closed preflight gate on real PG18
    const svcAuth = "19002000-0000-4000-8000-000000000099";
    const svcApp = "29002000-0000-4000-8000-000000000099";
    await admin.query("insert into auth.users (id, email) values ($1::uuid, 'pg18.svc@local')", [svcAuth]);
    await admin.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type) values ($1::uuid, $2::uuid, 'PG18 Legacy Service', false, 'SERVICE')",
      [svcApp, svcAuth],
    );
    await assert.rejects(
      () => admin.query(cleanupSql),
      (err) => String(err?.message ?? "").includes("PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES"),
    );
    await admin.query("rollback").catch(() => {});

    // Resolve and apply #237 + any trailing migrations
    await admin.query("delete from public.direct_entry_app_users where app_user_id = $1::uuid", [svcApp]);
    await admin.query("delete from auth.users where id = $1::uuid", [svcAuth]);
    for (let i = cleanupIdx; i < names.length; i += 1) {
      await admin.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
      applied.add(names[i]);
    }

    // 2. Verify S0-T1-C security postconditions & zero legacy refs on real PG18
    const postCheck = await verifyS0T1CSecurityPostconditions(admin, s0Sql, applied);
    assert.equal(postCheck.ok, true, JSON.stringify(postCheck));
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
    for (const sig of PR28_CLEANUP_RETIRED_RPC_SIGNATURES) {
      const { rows } = await admin.query("select to_regprocedure($1)::text as reg", [sig]);
      assert.equal(rows[0].reg, null, `retired signature must be absent on PG18: ${sig}`);
    }

    // 4. Concurrent 13-arg leave_management_upsert_employee_profile_admin (same idempotency key -> replay-safe, 0 deadlocks)
    const sameProfileKey = `pg18-13arg-${nextUuid()}`;
    const c1 = await connect(cluster.port, "postgres");
    const c2 = await connect(cluster.port, "postgres");
    workers.push(c1, c2);

    const profileRace = await Promise.allSettled([
      serviceQuery(
        c1,
        `select public.leave_management_upsert_employee_profile_admin(
           $1::uuid, $2::uuid, $3::uuid, 'OFFICIAL', 'RECRUITMENT',
           '2025-01-10'::date, '2025-03-10'::date, null::date,
           0, null::integer, 'Concurrent 13-arg upsert', $4::text, $5::text
         ) as payload`,
        [OWNER.auth, OWNER.app, TARGET.app, sameProfileKey, sha256(sameProfileKey)],
      ),
      serviceQuery(
        c2,
        `select public.leave_management_upsert_employee_profile_admin(
           $1::uuid, $2::uuid, $3::uuid, 'OFFICIAL', 'RECRUITMENT',
           '2025-01-10'::date, '2025-03-10'::date, null::date,
           0, null::integer, 'Concurrent 13-arg upsert', $4::text, $5::text
         ) as payload`,
        [OWNER.auth, OWNER.app, TARGET.app, sameProfileKey, sha256(sameProfileKey)],
      ),
    ]);
    for (const r of profileRace) {
      if (r.status === "rejected") {
        assert.notEqual(r.reason?.code, "40P01", "zero deadlocks permitted");
      }
    }
    const succeededProfiles = profileRace.filter((r) => r.status === "fulfilled");
    assert.ok(succeededProfiles.length >= 1, "at least one concurrent 13-arg leave upsert must succeed");
    assert.equal(succeededProfiles[0].value.rows[0].payload.profile.employment_status, "OFFICIAL");
    assert.equal("is_shared_non_employee" in succeededProfiles[0].value.rows[0].payload.profile, false);

    // 5. Concurrent group assignment OCC race on TARGET (distinct groups, same expected_account_version -> exactly 1 wins, 1 gets PT409, 0 deadlocks)
    const { rows: deptRows } = await admin.query(
      "select department_id::text as id from public.organization_departments where system_key = 'RECRUITMENT' limit 1",
    );
    const g1Key = nextUuid();
    const g2Key = nextUuid();
    const g1Res = (await serviceQuery(
      admin,
      "select public.direct_entry_authz_create_group_admin($1::uuid, $2::uuid, 'PG18_G1', 'Nhóm PG18 1', null, $3::uuid, null, array['entry_create']::text[], '[]'::jsonb, 'Create G1', $4::uuid, $5::text) as p",
      [OWNER.auth, OWNER.app, deptRows[0].id, g1Key, sha256(g1Key)],
    )).rows[0].p;
    const g2Res = (await serviceQuery(
      admin,
      "select public.direct_entry_authz_create_group_admin($1::uuid, $2::uuid, 'PG18_G2', 'Nhóm PG18 2', null, $3::uuid, null, array['document_view']::text[], '[]'::jsonb, 'Create G2', $4::uuid, $5::text) as p",
      [OWNER.auth, OWNER.app, deptRows[0].id, g2Key, sha256(g2Key)],
    )).rows[0].p;
    const g1 = g1Res.group_id ?? g1Res.group?.group_id;
    const g2 = g2Res.group_id ?? g2Res.group?.group_id;
    assert.ok(g1 && g2, `expected group_ids from create_group_admin, got ${JSON.stringify([g1Res, g2Res])}`);

    const { rows: verRows } = await admin.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [TARGET.app],
    );
    const startVer = verRows[0].version;
    const a1Key = nextUuid();
    const a2Key = nextUuid();
    const occRace = await Promise.allSettled([
      serviceQuery(
        c1,
        "select public.direct_entry_authz_assign_group_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Race 1', $6::uuid, $7::text)",
        [OWNER.auth, OWNER.app, TARGET.app, g1, startVer, a1Key, sha256(a1Key)],
      ),
      serviceQuery(
        c2,
        "select public.direct_entry_authz_assign_group_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'Race 2', $6::uuid, $7::text)",
        [OWNER.auth, OWNER.app, TARGET.app, g2, startVer, a2Key, sha256(a2Key)],
      ),
    ]);
    const okCount = occRace.filter((r) => r.status === "fulfilled").length;
    const conflictCount = occRace.filter((r) => r.status === "rejected" && r.reason?.code === "PT409").length;
    assert.equal(okCount, 1, `exactly 1 OCC winner expected, got ${okCount}`);
    assert.equal(conflictCount, 1, `exactly 1 PT409 conflict expected, got ${conflictCount}`);
  } finally {
    for (const c of workers) await c.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await cluster.stop();
  }
});

async function waitForLockWait(mon, pid, expectedBlockerPid = null, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await mon.query(
      `select a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) as blocking_pids
         from pg_stat_activity a
        where a.pid = $1`,
      [pid],
    );
    const row = rows[0];
    if (
      row
      && row.wait_event_type === "Lock"
      && (row.blocking_pids?.length ?? 0) > 0
      && (expectedBlockerPid === null || row.blocking_pids.includes(expectedBlockerPid))
    ) {
      const waitingLocks = (await mon.query(
        `select locktype, mode, relation::regclass::text as relation, granted
           from pg_locks
          where pid = $1 and not granted`,
        [pid],
      )).rows;
      return { ...row, waitingLocks };
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  const snap = (await mon.query(
    "select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocking_pids from pg_stat_activity where pid = $1",
    [pid],
  )).rows;
  throw new Error(`Timed out waiting for pid ${pid} to enter Lock wait (expectedBlocker=${expectedBlockerPid}): ${JSON.stringify(snap)}`);
}

test("PR #28 #237 PG18: Marketing retirement lock-order concurrency against real admin RPCs (both start directions, 0 deadlocks)", async (t) => {
  const MKT_EXTRA = {
    auth: "00000000-0000-4000-8000-000000000001",
    app: "00000000-0000-4000-8000-000000000001",
    email: "extra.recruiter.barrier@fixture.local",
    name: "Extra Recruiter Barrier",
  };
  const MKT_TARGETS = [
    {
      app: "6772d4bb-edd6-4a7d-9092-621d37d072a7",
      auth: "19002370-0000-4000-8000-000000000011",
      recruiter: "39002370-0000-4000-8000-000000000011",
      name: "Marketing Vĩnh Phúc",
    },
    {
      app: "b206918e-38ae-482e-b3f2-0e96593655dc",
      auth: "19002370-0000-4000-8000-000000000012",
      recruiter: "39002370-0000-4000-8000-000000000012",
      name: "Marketing Bắc Giang",
    },
  ];
  const MKT_IDS = MKT_TARGETS.map((x) => x.app);

  const names = (await readdir(MIGRATION_DIR))
    .filter((f) => f.endsWith(".sql") && f <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  const grpIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  const cleanupIdx = names.indexOf(PR28_CLEANUP_MIGRATION_NAME);
  assert.ok(grpIdx > 0 && cleanupIdx > grpIdx);
  const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
  const cleanupSql = await readFile(path.join(MIGRATION_DIR, PR28_CLEANUP_MIGRATION_NAME), "utf8");
  const start = cleanupSql.indexOf("-- Owner decision 2026-11-22:");
  const end = cleanupSql.indexOf("$pr28_retire_marketing$;", start);
  assert.ok(start > 0 && end > start, "Marketing retirement prefix must precede cleanup gates");
  const prefixSql = cleanupSql.slice(start, end + "$pr28_retire_marketing$;".length);

  const cluster = await startCluster();
  let ctrl = null;
  let dbSeq = 0;

  async function withFreshDb(fn) {
    const dbName = `pr28_mkt_conc_${++dbSeq}`;
    await ctrl.query(`create database ${dbName} template pr28_mkt_lock_tpl`);
    const mon = await connect(cluster.port, dbName);
    const helper = await connect(cluster.port, dbName);
    const s1 = await connect(cluster.port, dbName);
    const s2 = await connect(cluster.port, dbName);
    try {
      return await fn({ dbName, mon, helper, s1, s2 });
    } finally {
      await helper.end().catch(() => {});
      await s1.end().catch(() => {});
      await s2.end().catch(() => {});
      await mon.end().catch(() => {});
      await ctrl.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
    }
  }

  async function targetSummary(client) {
    return (await client.query(
      `select u.app_user_id, u.enabled, u.version,
              (select count(*)::int from public.leave_employee_profiles p where p.app_user_id = u.app_user_id) as profiles,
              (select count(*)::int from public.leave_audit_events a where a.target_app_user_id = u.app_user_id and a.event_type = 'EMPLOYEE_PROFILE_RETIRED') as archives
         from public.direct_entry_app_users u
        where u.app_user_id = any($1::uuid[])
        order by u.app_user_id`,
      [MKT_IDS],
    )).rows;
  }

  async function assertOwnerProtectedIntact(client) {
    const roleCount = (await client.query(
      "select count(*)::int as n from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and is_protected and ended_at is null",
      [OWNER.app],
    )).rows[0].n;
    const grpCount = (await client.query(
      "select count(*)::int as n from public.authz_user_group_members where app_user_id = $1::uuid and is_protected and ended_at is null",
      [OWNER.app],
    )).rows[0].n;
    assert.equal(roleCount, 1, "Owner protected role assignment must remain intact");
    assert.equal(grpCount, 1, "Owner protected SYSTEM_ADMIN group membership must remain intact");
  }

  try {
    ctrl = await connect(cluster.port, "postgres");
    await ctrl.query("create database pr28_mkt_lock_tpl");
    const tpl = await connect(cluster.port, "pr28_mkt_lock_tpl");
    try {
      await tpl.query(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
        create schema auth;
        create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
      `);
      for (let i = 0; i < grpIdx; i += 1) {
        await tpl.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
      }
      for (const u of [OWNER, LUANPT, LIENVU, NGATTT]) {
        await tpl.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
        await tpl.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
          [u.app, u.auth, u.name],
        );
        await tpl.query(
          "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2020-01-01', true), ($1::uuid, 'own', null, '2020-01-01', true)",
          [u.app],
        );
        for (const cap of [
          "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
          "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
          "audit_view", "worker_edit_history_view", "document_upload", "document_view",
          "employment_status.review", "employment_status.apply", "change_request_create",
          "change_review", "employment_status.request", "duplicate_cccd_withdraw",
        ]) {
          await tpl.query(
            "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2020-01-01', true)",
            [u.app, cap],
          );
        }
      }
      const plan = await runWp5Cutover(tpl, { mode: "read-only-plan" });
      await runWp5Cutover(tpl, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: plan.manifest_fingerprint,
        actorAppUserId: OWNER.app,
        reason: "PG18 Marketing lock-order template setup",
      });
      for (let i = grpIdx; i < cleanupIdx; i += 1) {
        await tpl.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
      }
      await tpl.query("insert into auth.users (id, email) values ($1::uuid, $2)", [MKT_EXTRA.auth, MKT_EXTRA.email]);
      await tpl.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version) values ($1::uuid, $2::uuid, $3, true, true, 2)",
        [MKT_EXTRA.app, MKT_EXTRA.auth, MKT_EXTRA.name],
      );
      await tpl.query(
        "insert into public.authz_account_role_assignments (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id) values ($1::uuid, 'RECRUITER', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'barrier', $2::uuid)",
        [MKT_EXTRA.app, OWNER.app],
      );
      for (const u of MKT_TARGETS) {
        await tpl.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, `${u.app}@fixture.local`]);
        await tpl.query(
          "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version) values ($1::uuid, $2::uuid, $3, true, true, 2)",
          [u.app, u.auth, u.name],
        );
        await tpl.query(
          "insert into public.authz_account_role_assignments (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id) values ($1::uuid, 'EMPLOYEE_BASE', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'fixture', $2::uuid), ($1::uuid, 'RECRUITER', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'fixture', $2::uuid)",
          [u.app, OWNER.app],
        );
        await tpl.query("insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)", [u.recruiter, u.name]);
        await tpl.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2020-01-01', true)", [u.recruiter]);
        await tpl.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2020-01-01', true)", [u.app, u.recruiter]);
        await tpl.query("insert into public.leave_employee_profiles (app_user_id, is_shared_non_employee, employment_status, unit_kind, updated_by_app_user_id) values ($1::uuid, true, 'UNCONFIGURED', 'UNCLASSIFIED', $2::uuid)", [u.app, OWNER.app]);
      }
      await tpl.query("select public.direct_entry_authz__internal_backfill_legacy_to_groups()");
      for (const u of [MKT_EXTRA, ...MKT_TARGETS]) {
        await tpl.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [u.app]);
      }
    } finally {
      await tpl.end();
    }

    const updateGroupSql = `select public.direct_entry_authz_update_group_admin(
      $1::uuid, $2::uuid, $3::uuid, $4::integer,
      $5::text, $6::text, $7::uuid, null::uuid, true,
      array['entry_create','entry_own','submission_create','document_upload','document_view','change_request_create','employment_status.request']::text[],
      '[]'::jsonb, 'Concurrent update group', $8::uuid, $9::text
    ) as payload`;

    await t.test("1A: direct_entry_authz_update_group_admin starts first (mid-flight pause) -> #237 waits on group without locking accounts, 0 deadlocks", () =>
      withFreshDb(async ({ mon, helper, s1, s2 }) => {
        const grp = (await mon.query("select group_id::text as id, department_id::text as dept, name, version from public.authz_user_groups where code = 'RECRUITER_OPERATIONS'")).rows[0];
        const hPid = (await helper.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        // Pause S1 inside direct_entry_authz_update_group_admin AFTER locking RECRUITER_OPERATIONS FOR UPDATE and BEFORE locking Owner/Targets
        await helper.query("begin");
        await helper.query("select 1 from public.direct_entry_app_users where app_user_id = $1::uuid for update", [MKT_EXTRA.app]);

        const k1 = nextUuid();
        await s1.query("begin");
        await s1.query("set local role service_role");
        await s1.query("set local lock_timeout = '5000ms'");
        const s1Promise = s1.query(updateGroupSql, [OWNER.auth, OWNER.app, grp.id, grp.version, grp.name, "Updated while #237 waits", grp.dept, k1, sha256(k1)])
          .then(async (res) => { await s1.query("commit"); return { ok: true, payload: res.rows[0].payload }; })
          .catch(async (e) => { await s1.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        await waitForLockWait(mon, s1Pid, hPid);

        // Start #237 prefix -> must block at Step A on authz_user_groups (blocked by S1) holding 0 tuple locks on direct_entry_app_users
        await s2.query("begin");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(prefixSql)
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        const s2AppUserTupleLocks = (await mon.query(
          `select count(*)::int as n from pg_locks
            where pid = $1 and relation = 'public.direct_entry_app_users'::regclass and mode like '%Row%'`,
          [s2Pid],
        )).rows[0].n;
        assert.equal(s2AppUserTupleLocks, 0, "#237 must wait on authz_user_groups BEFORE locking direct_entry_app_users");

        await helper.query("rollback");
        const [r1, r2] = await Promise.all([s1Promise, s2Promise]);
        assert.notEqual(r1.code, "40P01", `zero deadlocks permitted: ${JSON.stringify(r1)}`);
        assert.notEqual(r2.code, "40P01", `zero deadlocks permitted: ${JSON.stringify(r2)}`);
        assert.equal(r1.ok, true, `update_group_admin must commit cleanly: ${JSON.stringify(r1)}`);
        assert.equal(r2.ok, true, `#237 prefix must commit cleanly after update_group_admin: ${JSON.stringify(r2)}`);
        assert.equal(r1.payload.version, grp.version + 1);

        const st = await targetSummary(mon);
        assert.ok(st.every((r) => !r.enabled && r.profiles === 0 && r.archives === 1), JSON.stringify(st));
        assert.equal((await mon.query("select version from public.authz_user_groups where group_id = $1::uuid", [grp.id])).rows[0].version, grp.version + 1);
        await assertOwnerProtectedIntact(mon);

        // Full #237 remains idempotently applicable with canonical S0-T1-C ACL
        await mon.query(cleanupSql);
        const post = await verifyS0T1CSecurityPostconditions(mon, s0Sql, new Set(names.slice(0, cleanupIdx + 1)));
        assert.equal(post.ok, true, JSON.stringify(post));
      }),
    );

    await t.test("1B: #237 starts first -> direct_entry_authz_update_group_admin hits 55P03 under short timeout and succeeds cleanly after #237 commits (0 deadlocks)", () =>
      withFreshDb(async ({ mon, s1, s2 }) => {
        const grp = (await mon.query("select group_id::text as id, department_id::text as dept, name, version from public.authz_user_groups where code = 'RECRUITER_OPERATIONS'")).rows[0];
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        // 1B-timeout: controlled lock_timeout -> 55P03
        await s1.query("begin");
        await s1.query(prefixSql);

        const kTimeout = nextUuid();
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '300ms'");
        let errTimeout = null;
        try {
          await s2.query(updateGroupSql, [OWNER.auth, OWNER.app, grp.id, grp.version, grp.name, "Timeout probe", grp.dept, kTimeout, sha256(kTimeout)]);
        } catch (e) {
          errTimeout = { code: e?.code, message: String(e?.message ?? e) };
        }
        await s2.query("rollback").catch(() => {});
        assert.equal(errTimeout?.code, "55P03", `expected 55P03 lock_not_available, got ${JSON.stringify(errTimeout)}`);

        // 1B-commit: S2 blocks on S1, S1 commits, S2 wakes up and succeeds cleanly
        const kCommit = nextUuid();
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(updateGroupSql, [OWNER.auth, OWNER.app, grp.id, grp.version, grp.name, "Committed after #237", grp.dept, kCommit, sha256(kCommit)])
          .then(async (res) => { await s2.query("commit"); return { ok: true, payload: res.rows[0].payload }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("commit");
        const r2 = await s2Promise;
        assert.notEqual(r2.code, "40P01", `zero deadlocks permitted: ${JSON.stringify(r2)}`);
        assert.equal(r2.ok, true, `update_group_admin must succeed after #237 commits: ${JSON.stringify(r2)}`);
        assert.equal(r2.payload.version, grp.version + 1);
        const st = await targetSummary(mon);
        assert.ok(st.every((r) => !r.enabled && r.profiles === 0 && r.archives === 1));
        await assertOwnerProtectedIntact(mon);
      }),
    );

    await t.test("2A: direct_entry_authz_remove_group_member_admin starts first (mid-flight pause before audit FK KEY SHARE) -> #237 FOR KEY SHARE creates 0 reverse deadlock cycle", () =>
      withFreshDb(async ({ mon, helper, s1, s2 }) => {
        const memId = (await mon.query(
          "select membership_id::text as id from public.authz_user_group_members where app_user_id = $1::uuid and ended_at is null limit 1",
          [MKT_TARGETS[0].app],
        )).rows[0].id;
        const hPid = (await helper.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        // Pause S1 inside remove_group_member_admin AFTER locking direct_entry_app_users(Owner, Target1) FOR UPDATE and BEFORE INSERT authz_group_audit_events (group FOR KEY SHARE)
        await helper.query("begin");
        await helper.query("select 1 from public.authz_user_group_members where membership_id = $1::uuid for update", [memId]);

        const k1 = nextUuid();
        await s1.query("begin");
        await s1.query("set local role service_role");
        await s1.query("set local lock_timeout = '5000ms'");
        const s1Promise = s1.query(
          "select public.direct_entry_authz_remove_group_member_admin($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'Concurrent remove first',$5::uuid,$6::text) as payload",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, memId, k1, sha256(k1)],
        )
          .then(async (res) => { await s1.query("commit"); return { ok: true, payload: res.rows[0].payload }; })
          .catch(async (e) => { await s1.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        await waitForLockWait(mon, s1Pid, hPid);

        // Start #237 prefix -> acquires group FOR KEY SHARE (compatible with S1's later FK KEY SHARE!), then waits cleanly on S1's direct_entry_app_users FOR UPDATE
        await s2.query("begin");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(prefixSql)
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await helper.query("rollback");
        const [r1, r2] = await Promise.all([s1Promise, s2Promise]);
        assert.notEqual(r1.code, "40P01", `zero reverse deadlocks permitted: ${JSON.stringify(r1)}`);
        assert.notEqual(r2.code, "40P01", `zero reverse deadlocks permitted: ${JSON.stringify(r2)}`);
        assert.equal(r1.ok, true, `remove_group_member_admin must commit cleanly: ${JSON.stringify(r1)}`);
        assert.equal(r2.ok, true, `#237 prefix must complete cleanly after remove_group_member_admin: ${JSON.stringify(r2)}`);

        const st = await targetSummary(mon);
        assert.ok(st.every((r) => !r.enabled && r.profiles === 0 && r.archives === 1), JSON.stringify(st));
        await assertOwnerProtectedIntact(mon);
      }),
    );

    await t.test("2B: #237 starts first -> direct_entry_authz_remove_group_member_admin hits 55P03 under short timeout, PT409 on commit, and succeeds on rollback (0 deadlocks)", async () => {
      await withFreshDb(async ({ mon, s1, s2 }) => {
        const memId = (await mon.query(
          "select membership_id::text as id from public.authz_user_group_members where app_user_id = $1::uuid and ended_at is null limit 1",
          [MKT_TARGETS[0].app],
        )).rows[0].id;
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        await s1.query("begin");
        await s1.query(prefixSql);

        // 2B-timeout: 55P03
        const kTimeout = nextUuid();
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '300ms'");
        let errTimeout = null;
        try {
          await s2.query(
            "select public.direct_entry_authz_remove_group_member_admin($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'Timeout remove',$5::uuid,$6::text)",
            [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, memId, kTimeout, sha256(kTimeout)],
          );
        } catch (e) {
          errTimeout = { code: e?.code, message: String(e?.message ?? e) };
        }
        await s2.query("rollback").catch(() => {});
        assert.equal(errTimeout?.code, "55P03", `expected 55P03, got ${JSON.stringify(errTimeout)}`);

        // 2B-commit: PT409 GROUP_MEMBERSHIP_ALREADY_ENDED
        const kCommit = nextUuid();
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(
          "select public.direct_entry_authz_remove_group_member_admin($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'Commit remove',$5::uuid,$6::text)",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, memId, kCommit, sha256(kCommit)],
        )
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("commit");
        const r2 = await s2Promise;
        assert.equal(r2.ok, false);
        assert.equal(r2.code, "PT409", `expected PT409 after #237 commit, got ${JSON.stringify(r2)}`);
        assert.match(r2.message, /GROUP_MEMBERSHIP_ALREADY_ENDED/);
        assert.ok((await targetSummary(mon)).every((r) => !r.enabled && r.profiles === 0 && r.archives === 1));
        await assertOwnerProtectedIntact(mon);
      });

      // 2B-rollback: #237 rolls back -> waiting remove_group_member_admin wakes up and succeeds cleanly
      await withFreshDb(async ({ mon, s1, s2 }) => {
        const memId = (await mon.query(
          "select membership_id::text as id from public.authz_user_group_members where app_user_id = $1::uuid and ended_at is null limit 1",
          [MKT_TARGETS[0].app],
        )).rows[0].id;
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        await s1.query("begin");
        await s1.query(prefixSql);

        const kRb = nextUuid();
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(
          "select public.direct_entry_authz_remove_group_member_admin($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'After #237 rollback',$5::uuid,$6::text) as payload",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, memId, kRb, sha256(kRb)],
        )
          .then(async (res) => { await s2.query("commit"); return { ok: true, payload: res.rows[0].payload }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("rollback");
        const r2 = await s2Promise;
        assert.equal(r2.ok, true, `remove_group_member_admin must succeed after #237 rollback: ${JSON.stringify(r2)}`);
        assert.equal(r2.payload.account_version, 3);
        const st = await targetSummary(mon);
        assert.ok(st.every((r) => r.enabled && r.profiles === 1 && r.archives === 0), JSON.stringify(st));
        await assertOwnerProtectedIntact(mon);
      });
    });

    await t.test("3A: direct_entry_disable_app_user starts first -> #237 waits, fails closed INCOMPLETE on commit and succeeds on rollback (0 deadlocks)", async () => {
      // 3A-commit: disable commits without retirement audit -> #237 fails closed INCOMPLETE and preserves Target2
      await withFreshDb(async ({ mon, s1, s2 }) => {
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        await s1.query("begin");
        await s1.query("set local role service_role");
        await s1.query(
          "select public.direct_entry_disable_app_user($1::uuid,$2::uuid,$3::uuid,2,'Concurrent disable first',$4::text)",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, `disable-first-${nextUuid()}`],
        );

        await s2.query("begin");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(prefixSql)
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("commit");
        const r2 = await s2Promise;
        assert.equal(r2.ok, false);
        assert.notEqual(r2.code, "40P01", `zero deadlocks permitted: ${JSON.stringify(r2)}`);
        assert.match(r2.message, /PR28_MARKETING_RETIREMENT_INCOMPLETE/);
        const st = await targetSummary(mon);
        assert.equal(st[0].enabled, false);
        assert.equal(st[1].enabled, true, "Target2 must remain untouched when #237 rolls back");
        assert.ok(st.every((r) => r.profiles === 1 && r.archives === 0));
        await assertOwnerProtectedIntact(mon);
      });

      // 3A-rollback: disable rolls back -> #237 wakes up and retires both cleanly
      await withFreshDb(async ({ mon, s1, s2 }) => {
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        await s1.query("begin");
        await s1.query("set local role service_role");
        await s1.query(
          "select public.direct_entry_disable_app_user($1::uuid,$2::uuid,$3::uuid,2,'Concurrent disable rollback',$4::text)",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, `disable-rb-${nextUuid()}`],
        );

        await s2.query("begin");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(prefixSql)
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("rollback");
        const r2 = await s2Promise;
        assert.equal(r2.ok, true, `#237 must succeed after disable rollback: ${JSON.stringify(r2)}`);
        assert.ok((await targetSummary(mon)).every((r) => !r.enabled && r.profiles === 0 && r.archives === 1));
        await assertOwnerProtectedIntact(mon);
      });
    });

    await t.test("3B: #237 starts first -> direct_entry_disable_app_user hits 55P03 under short timeout and PT409 version conflict on commit (0 deadlocks)", () =>
      withFreshDb(async ({ mon, s1, s2 }) => {
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        await s1.query("begin");
        await s1.query(prefixSql);

        // 3B-timeout: 55P03
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '300ms'");
        let errTimeout = null;
        try {
          await s2.query(
            "select public.direct_entry_disable_app_user($1::uuid,$2::uuid,$3::uuid,2,'Timeout disable',$4::text)",
            [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, `disable-to-${nextUuid()}`],
          );
        } catch (e) {
          errTimeout = { code: e?.code, message: String(e?.message ?? e) };
        }
        await s2.query("rollback").catch(() => {});
        assert.equal(errTimeout?.code, "55P03", `expected 55P03, got ${JSON.stringify(errTimeout)}`);

        // 3B-commit: PT409 app user version conflict
        await s2.query("begin");
        await s2.query("set local role service_role");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(
          "select public.direct_entry_disable_app_user($1::uuid,$2::uuid,$3::uuid,2,'Commit disable',$4::text)",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, `disable-cm-${nextUuid()}`],
        )
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        const s2LockWait = await waitForLockWait(mon, s2Pid, s1Pid);
        assert.ok(s2LockWait.waitingLocks.length > 0, `expected explicit pg_locks wait record for S2, got ${JSON.stringify(s2LockWait)}`);

        await s1.query("commit");
        const r2 = await s2Promise;
        assert.equal(r2.ok, false);
        assert.equal(r2.code, "PT409", `expected PT409 version conflict after #237 commit, got ${JSON.stringify(r2)}`);
        assert.match(r2.message, /version conflict/i);
        assert.ok((await targetSummary(mon)).every((r) => !r.enabled && r.profiles === 0 && r.archives === 1));
        await assertOwnerProtectedIntact(mon);
      }),
    );

    await t.test("4: concurrent direct_entry_authz_assign_group_member_admin adds target to another group between Step A and Step B -> 0 deadlocks and fail-closed PROFILE_CHANGED", () =>
      withFreshDb(async ({ mon, s1, s2 }) => {
        const otherGroup = (await mon.query(
          "select group_id::text as id from public.authz_user_groups where code = 'HR_CATALOG_OPERATOR' and active limit 1",
        )).rows[0];
        assert.ok(otherGroup?.id, "HR_CATALOG_OPERATOR group must exist");
        const s1Pid = (await s1.query("select pg_backend_pid() as pid")).rows[0].pid;
        const s2Pid = (await s2.query("select pg_backend_pid() as pid")).rows[0].pid;

        // S1 assigns Target1 to HR_CATALOG_OPERATOR inside BEGIN (holds HR_CATALOG_OPERATOR FOR SHARE + Owner/Target1 FOR UPDATE)
        const kAssign = nextUuid();
        await s1.query("begin");
        await s1.query("set local role service_role");
        await s1.query(
          "select public.direct_entry_authz_assign_group_member_admin($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'Concurrent group add between Step A and B',$5::uuid,$6::text)",
          [OWNER.auth, OWNER.app, MKT_TARGETS[0].app, otherGroup.id, kAssign, sha256(kAssign)],
        );

        // S2 starts #237 prefix -> completes Step A (RECRUITER_OPERATIONS FOR KEY SHARE) and blocks at Step B on S1's direct_entry_app_users FOR UPDATE
        await s2.query("begin");
        await s2.query("set local lock_timeout = '5000ms'");
        const s2Promise = s2.query(prefixSql)
          .then(async () => { await s2.query("commit"); return { ok: true }; })
          .catch(async (e) => { await s2.query("rollback").catch(() => {}); return { ok: false, code: e?.code, message: String(e?.message ?? e) }; });
        await waitForLockWait(mon, s2Pid, s1Pid);

        // S1 commits -> Target1 now belongs to HR_CATALOG_OPERATOR (added after Step A)
        await s1.query("commit");
        const r2 = await s2Promise;
        assert.equal(r2.ok, false);
        assert.notEqual(r2.code, "40P01", `zero deadlocks permitted: ${JSON.stringify(r2)}`);
        assert.match(r2.message, new RegExp(`PR28_MARKETING_RETIREMENT_PROFILE_CHANGED: ${MKT_TARGETS[0].app}`));
        const st = await targetSummary(mon);
        assert.equal(st.length, 2);
        assert.ok(st.every((r) => r.enabled && r.profiles === 1 && r.archives === 0), JSON.stringify(st));
        await assertOwnerProtectedIntact(mon);
      }),
    );
  } finally {
    if (ctrl) await ctrl.end().catch(() => {});
    await cluster.stop();
  }
});
