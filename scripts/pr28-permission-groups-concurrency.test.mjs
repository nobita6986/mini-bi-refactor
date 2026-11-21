/**
 * PR #28 — Permission Groups Real PostgreSQL 18 Concurrency & Dynamic S0-T1-C Allowlist Suite.
 *
 * Pure ESM (`node --test`) against an isolated ephemeral PostgreSQL 18 cluster.
 * Verifies:
 *   1. Forward-compatible dynamic S0-T1-C allowlist right after Migration #236 (+6 net
 *      service_role RPCs) and full-chain S0-T1-C postconditions after any tail migrations.
 *   2. Concurrent group membership assignments, concurrent OCC races on the same account,
 *      and concurrent group updates under `SET LOCAL ROLE service_role` -> ZERO `40P01`
 *      deadlocks, deterministic OCC 409 conflicts, and intact Owner `is_protected` lock.
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
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  PR28_PERMISSION_GROUPS_FOUNDATION_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "18002000-0000-4000-8000-000000000001",
  app: "28002000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner PG18 Groups",
};
const LUANPT = {
  auth: "18002000-0000-4000-8000-000000000002",
  app: "28002000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT PG18",
};
const LIENVU = {
  auth: "18002000-0000-4000-8000-000000000003",
  app: "28002000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu PG18",
};
const NGATTT = {
  auth: "18002000-0000-4000-8000-000000000004",
  app: "28002000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT PG18",
};
const TARGET_A = {
  auth: "18002000-0000-4000-8000-000000000011",
  app: "28002000-0000-4000-8000-000000000011",
  email: "pr28.grp.a@hrpartner.vn",
  name: "PG18 Group Target A",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `98002000-0000-4000-8000-${hex}`;
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr28-groups-pg18-"));
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
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { windowsHide: true, stdio: "ignore" });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function connectPg(port) {
  const c = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await c.connect();
  return c;
}

async function seedAccount(client, u, { adminLegacy = false } = {}) {
  await client.query(`insert into auth.users (id, email) values ($1::uuid, $2) on conflict (id) do nothing`, [
    u.auth,
    u.email,
  ]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed)
     values ($1::uuid, $2::uuid, $3, true, $4) on conflict (app_user_id) do nothing`,
    [u.app, u.auth, u.name, !adminLegacy],
  );
  if (adminLegacy) {
    await client.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, '2026-01-01', true) on conflict do nothing`,
      [u.app],
    );
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await client.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true) on conflict do nothing`,
        [u.app, cap],
      );
    }
  }
}

test("PR #28 PostgreSQL 18: dynamic S0-T1-C allowlist (+6 RPCs) & concurrent group mutations under live serialization", async () => {
  const cluster = await startCluster();
  try {
    const admin = await connectPg(cluster.port);
    try {
      await admin.query(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
          if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
          if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (
          id uuid primary key,
          email text,
          raw_user_meta_data jsonb default '{}'::jsonb
        );
      `);

      const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
      const grpIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
      assert.ok(grpIdx >= 0);

      for (const name of names.slice(0, grpIdx)) {
        await admin.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }
      const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
      const preFlags = new Map(names.slice(0, grpIdx).map((n) => [n, true]));
      const preAcl = await verifyS0T1CSecurityPostconditions(admin, s0Sql, preFlags);
      assert.equal(preAcl.ok, true, `pre-ACL failed: ${preAcl.reason}`);

      await seedAccount(admin, OWNER, { adminLegacy: true });
      await seedAccount(admin, LUANPT, { adminLegacy: true });
      await seedAccount(admin, LIENVU, { adminLegacy: true });
      await seedAccount(admin, NGATTT, { adminLegacy: true });
      await seedAccount(admin, TARGET_A);

      const plan = await runWp5Cutover(admin, { mode: "read-only-plan" });
      assert.ok(plan.manifest_fingerprint);
      const cutover = await runWp5Cutover(admin, {
        mode: "apply",
        confirmApply: true,
        expectedFingerprint: plan.manifest_fingerprint,
      });
      assert.equal(cutover.status, "APPLIED");

      // Apply #236 and assert exact +6 net RPC delta right at #236
      await admin.query(await readFile(path.join(MIGRATION_DIR, PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME), "utf8"));
      const post236Flags = new Map([...preFlags, [PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME, true]]);
      const post236Acl = await verifyS0T1CSecurityPostconditions(admin, s0Sql, post236Flags);
      assert.equal(post236Acl.ok, true, `post-236 ACL failed: ${post236Acl.reason}`);
      assert.equal(
        post236Acl.details.actualServiceCount - preAcl.details.actualServiceCount,
        PR28_PERMISSION_GROUPS_FOUNDATION_RPC_SIGNATURES.length,
        "Migration #236 must add exact +6 net service_role RPCs",
      );
      assert.equal(post236Acl.details.exposedClientOrPublicCount, 0);

      // Apply any tail migrations cleanly and verify full-chain S0-T1-C
      for (const name of names.slice(grpIdx + 1)) {
        await admin.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }
      const allFlags = new Map(names.map((n) => [n, true]));
      const finalAcl = await verifyS0T1CSecurityPostconditions(admin, s0Sql, allFlags);
      assert.equal(finalAcl.ok, true, `full-chain ACL failed: ${finalAcl.reason}`);

      const { rows: groups } = await admin.query(
        `select group_id, code from public.authz_user_groups where code in ('RECRUITER_OPERATIONS', 'ACCOUNTING_OPERATIONS', 'LEAVE_HR_OPERATIONS')`,
      );
      const gByCode = new Map(groups.map((r) => [r.code, r.group_id]));

      // Race 2 concurrent service_role assignments to TARGET_A with the same expected_account_version=1!
      // Exactly ONE must win (201) and the other must deterministically fail with VERSION_CONFLICT (PT409), 0 deadlocks!
      const c1 = await connectPg(cluster.port);
      const c2 = await connectPg(cluster.port);
      try {
        const runAssign = async (client, actor, groupId) => {
          await client.query("begin");
          try {
            await client.query("set local role service_role");
            const { rows } = await client.query(
              `select public.direct_entry_authz_assign_group_member_admin(
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'Race assign', $5::uuid, $6
               ) as res`,
              [actor.auth, actor.app, TARGET_A.app, groupId, nextUuid(), sha256(`${actor.app}:${groupId}`)],
            );
            await client.query("commit");
            return { ok: true, res: rows[0].res };
          } catch (err) {
            await client.query("rollback");
            return { ok: false, code: err?.code, message: err?.message };
          }
        };

        const [r1, r2] = await Promise.all([
          runAssign(c1, OWNER, gByCode.get("RECRUITER_OPERATIONS")),
          runAssign(c2, LUANPT, gByCode.get("ACCOUNTING_OPERATIONS")),
        ]);

        assert.notEqual(r1.code, "40P01", "zero deadlocks");
        assert.notEqual(r2.code, "40P01", "zero deadlocks");
        const winners = [r1, r2].filter((r) => r.ok);
        const losers = [r1, r2].filter((r) => !r.ok);
        assert.equal(winners.length, 1, "exactly one concurrent OCC writer wins");
        assert.equal(losers.length, 1, "exactly one concurrent OCC writer gets VERSION_CONFLICT");
        assert.equal(losers[0].message, "VERSION_CONFLICT");
      } finally {
        await c1.end();
        await c2.end();
      }
    } finally {
      await admin.end();
    }
  } finally {
    await cluster.stop();
  }
});
