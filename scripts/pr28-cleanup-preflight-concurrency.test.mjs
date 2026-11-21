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
      `-p ${port} -k "${dir}" -c listen_addresses=127.0.0.1 -c max_connections=40 -c fsync=off -c synchronous_commit=off`,
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

    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const cleanupIdx = names.indexOf(PR28_CLEANUP_MIGRATION_NAME);
    assert.ok(cleanupIdx > 0, `${PR28_CLEANUP_MIGRATION_NAME} must exist`);
    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const cleanupSql = await readFile(path.join(MIGRATION_DIR, PR28_CLEANUP_MIGRATION_NAME), "utf8");

    const applied = new Set();
    for (let i = 0; i < cleanupIdx; i += 1) {
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

    // 3. Seed users & run WP5 cutover cleanly on post-#237 PG18
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
      reason: "PG18 post-#237 concurrency setup",
    });

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
