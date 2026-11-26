/**
 * ORG-SHELL-01 — Real PostgreSQL Concurrency Regression Suite (Mandatory Item #18).
 *
 * Proves against isolated local PostgreSQL (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Deterministic lock-hold race: two Full Admins concurrently assigning the same
 *      user to `ACCOUNTING` serialize cleanly; strictly 1 wins (`version = 1`), the
 *      contender rejects with `PT409` (`DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT`), and
 *      active row count never exceeds 1.
 *   2. Parallel burst race: 4 concurrent connections racing `assign` on a fresh user
 *      produce strictly 1 winner and 3 `PT409` conflicts, 1 active row, 1 audit row.
 *   3. Concurrent idempotent retry: 2 concurrent calls with the same `(actor, key, fp)`
 *      serialize cleanly, create 1 membership + 1 audit row, and replay the identical
 *      `membership_id` (`replayed: true`).
 *   4. Concurrent `end` race & `end` vs `assign` race: strictly 1 `end` wins (`version = 2`),
 *      contender rejects (`PT409`), zero deadlocks, and active rows per user <= 1 at all times.
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
  computeEndAccountingMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import { ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN_1 = {
  auth: "19100000-0000-4000-8000-000000000001",
  app: "29100000-0000-4000-8000-000000000001",
  name: "Full Admin One",
};
const ADMIN_2 = {
  auth: "19100000-0000-4000-8000-000000000002",
  app: "29100000-0000-4000-8000-000000000002",
  name: "Full Admin Two",
};
const TARGET_1 = {
  auth: "19100000-0000-4000-8000-000000000011",
  app: "29100000-0000-4000-8000-000000000011",
  name: "Target User One",
};
const TARGET_2 = {
  auth: "19100000-0000-4000-8000-000000000012",
  app: "29100000-0000-4000-8000-000000000012",
  name: "Target User Two",
};
const TARGET_3 = {
  auth: "19100000-0000-4000-8000-000000000013",
  app: "29100000-0000-4000-8000-000000000013",
  name: "Target User Three",
};

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

async function connect(port, database = "postgres", applicationName = "org-shell-race") {
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
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  assert.ok(
    names.includes(ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME),
    `migration inventory must include ${ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seedActors(client) {
  for (const person of [ADMIN_1, ADMIN_2, TARGET_1, TARGET_2, TARGET_3]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.name.toLowerCase().replaceAll(" ", ".")}@company.local`,
    ]);
    await client.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1, $2, $3, true)",
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
}

const ASSIGN_SQL =
  "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6::text, $7::uuid, $8::text) as data";
const END_SQL =
  "select public.org_department_end_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6::text, $7::uuid, $8::text) as data";

test("ORG-SHELL-01 real PostgreSQL concurrency: concurrent assign, burst, idempotent retry, and end serialize without duplicate active rows or deadlocks", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "org-shell-01-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `org_shell_01_race_${process.pid}`;
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

    setup = await connect(port, databaseName, "org-shell-setup");
    await applyMigrations(setup);
    await seedActors(setup);
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "org-shell-observer");
    worker1 = await connect(port, databaseName, "org-shell-worker-1");
    worker2 = await connect(port, databaseName, "org-shell-worker-2");

    // -------------------------------------------------------------------------
    // Stage 1: Deterministic lock-hold race on `assign` (two admins, same target)
    // -------------------------------------------------------------------------
    const reasonA = "Admin 1 gán Kế toán";
    const fpA = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      account_ref: TARGET_1.app,
      expected_pair_version: 0,
      effective_from: null,
      reason: reasonA,
    });
    const reasonB = "Admin 2 gán Kế toán cùng lúc";
    const fpB = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_2.app,
      account_ref: TARGET_1.app,
      expected_pair_version: 0,
      effective_from: null,
      reason: reasonB,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winAssignRes = await worker1.query(ASSIGN_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      TARGET_1.app,
      0,
      null,
      reasonA,
      "81000000-0000-4000-8000-000000000001",
      fpA,
    ]);
    const target1MembershipId = winAssignRes.rows[0].data.membership.membership_id;
    assert.equal(winAssignRes.rows[0].data.membership.version, 1);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedAssign = worker2.query(ASSIGN_SQL, [
      ADMIN_2.auth,
      ADMIN_2.app,
      TARGET_1.app,
      0,
      null,
      reasonB,
      "81000000-0000-4000-8000-000000000002",
      fpB,
    ]);

    await waitUntilBlocked(observer, "org-shell-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      blockedAssign,
      (err) => err.code === "PT409",
      "contending assign must reject with PT409 once winner commits",
    );
    await worker2.query("rollback");

    // -------------------------------------------------------------------------
    // Stage 2: Parallel 4-connection burst on `TARGET_2`
    // -------------------------------------------------------------------------
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(port, databaseName, `org-shell-burst-${i}`);
      await c.query("set role service_role");
      burstClients.push(c);
    }

    const burstOutcomes = await Promise.allSettled(
      burstClients.map((client, idx) => {
        const actor = idx % 2 === 0 ? ADMIN_1 : ADMIN_2;
        const reason = `Burst assign #${idx}`;
        const idem = `82000000-0000-4000-8000-00000000000${idx + 1}`;
        const fp = computeAssignAccountingMemberFingerprint({
          actor_app_user_id: actor.app,
          account_ref: TARGET_2.app,
          expected_pair_version: 0,
          effective_from: null,
          reason,
        });
        return client.query(ASSIGN_SQL, [
          actor.auth,
          actor.app,
          TARGET_2.app,
          0,
          null,
          reason,
          idem,
          fp,
        ]);
      }),
    );

    const burstFulfilled = burstOutcomes.filter((o) => o.status === "fulfilled");
    const burstRejected = burstOutcomes.filter((o) => o.status === "rejected");
    assert.equal(burstFulfilled.length, 1, "strictly 1 parallel assign must win");
    assert.equal(burstRejected.length, 3, "other 3 parallel assigns must reject");
    for (const r of burstRejected) {
      assert.equal(r.reason.code, "PT409");
    }

    // -------------------------------------------------------------------------
    // Stage 3: Concurrent idempotent retry (same admin, key, and fingerprint)
    // -------------------------------------------------------------------------
    const retryKey = "83000000-0000-4000-8000-000000000001";
    const retryReason = "Idempotent concurrent assign";
    const retryFp = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      account_ref: TARGET_3.app,
      expected_pair_version: 0,
      effective_from: null,
      reason: retryReason,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const firstIdem = await worker1.query(ASSIGN_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      TARGET_3.app,
      0,
      null,
      retryReason,
      retryKey,
      retryFp,
    ]);
    assert.equal(firstIdem.rows[0].data.replayed, false);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const secondIdemPending = worker2.query(ASSIGN_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      TARGET_3.app,
      0,
      null,
      retryReason,
      retryKey,
      retryFp,
    ]);

    await waitUntilBlocked(observer, "org-shell-worker-2");
    await worker1.query("commit");

    const secondIdem = await secondIdemPending;
    await worker2.query("commit");
    assert.equal(secondIdem.rows[0].data.replayed, true);
    assert.equal(
      secondIdem.rows[0].data.membership.membership_id,
      firstIdem.rows[0].data.membership.membership_id,
    );

    // -------------------------------------------------------------------------
    // Stage 4: Concurrent `end` race on `TARGET_1` + `end` vs `assign` race
    // -------------------------------------------------------------------------
    const endReason1 = "Admin 1 kết thúc membership";
    const endFp1 = computeEndAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      membership_id: target1MembershipId,
      expected_pair_version: 1,
      effective_to: null,
      reason: endReason1,
    });
    const endReason2 = "Admin 2 kết thúc cùng lúc";
    const endFp2 = computeEndAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_2.app,
      membership_id: target1MembershipId,
      expected_pair_version: 1,
      effective_to: null,
      reason: endReason2,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winEnd = await worker1.query(END_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      target1MembershipId,
      1,
      null,
      endReason1,
      "84000000-0000-4000-8000-000000000001",
      endFp1,
    ]);
    assert.equal(winEnd.rows[0].data.membership.version, 2);
    assert.equal(winEnd.rows[0].data.membership.state, "HISTORY");

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const blockedEnd = worker2.query(END_SQL, [
      ADMIN_2.auth,
      ADMIN_2.app,
      target1MembershipId,
      1,
      null,
      endReason2,
      "84000000-0000-4000-8000-000000000002",
      endFp2,
    ]);

    await waitUntilBlocked(observer, "org-shell-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      blockedEnd,
      (err) => err.code === "PT409",
      "losing concurrent end must reject with PT409",
    );
    await worker2.query("rollback");

    // Also race an `end` on TARGET_2 (`expected_pair_version = 1`) against a speculative
    // `re-assign` (`expected_pair_version = 2`) across two admins -> zero deadlocks, <= 1 active row
    const target2MembershipId = burstFulfilled[0].value.rows[0].data.membership.membership_id;
    const t2EndReason = "Kết thúc TARGET_2 trong race";
    const t2EndFp = computeEndAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      membership_id: target2MembershipId,
      expected_pair_version: 1,
      effective_to: null,
      reason: t2EndReason,
    });
    const t2ReReason = "Bổ nhiệm lại TARGET_2 trong race";
    const t2ReFp = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_2.app,
      account_ref: TARGET_2.app,
      expected_pair_version: 2,
      effective_from: null,
      reason: t2ReReason,
    });

    const crossRace = await Promise.allSettled([
      burstClients[0].query(END_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        target2MembershipId,
        1,
        null,
        t2EndReason,
        "85000000-0000-4000-8000-000000000001",
        t2EndFp,
      ]),
      burstClients[1].query(ASSIGN_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        TARGET_2.app,
        2,
        null,
        t2ReReason,
        "85000000-0000-4000-8000-000000000002",
        t2ReFp,
      ]),
    ]);
    for (const outcome of crossRace) {
      if (outcome.status === "rejected") {
        assert.notEqual(outcome.reason.code, "40P01", "must never deadlock (40P01)");
      }
    }

    // Final invariant verification across the entire database:
    // - Zero user has > 1 open membership row (`valid_to is null`)
    // - TARGET_1 has 0 open rows, 1 history row (version = 2)
    // - TARGET_3 has 1 open row (version = 1) and 1 audit row despite 2 concurrent retries
    const { rows: dupOpenRows } = await observer.query(
      `select department_id, app_user_id, count(*)::int as open_count
         from public.organization_department_memberships
        where valid_to is null
        group by department_id, app_user_id
       having count(*) > 1`,
    );
    assert.deepEqual(dupOpenRows, [], "zero user may ever hold > 1 active/open membership row");

    const { rows: t1Summary } = await observer.query(
      `select count(*) filter (where valid_to is null)::int as open_n,
              count(*)::int as total_n,
              max(version)::int as max_v
         from public.organization_department_memberships
        where app_user_id = $1`,
      [TARGET_1.app],
    );
    assert.deepEqual(t1Summary[0], { open_n: 0, total_n: 1, max_v: 2 });

    const { rows: t3Summary } = await observer.query(
      `select (select count(*)::int from public.organization_department_memberships where app_user_id = $1) as mem_n,
              (select count(*)::int from public.organization_department_audit_events where target_app_user_id = $1) as audit_n`,
      [TARGET_3.app],
    );
    assert.deepEqual(t3Summary[0], { mem_n: 1, audit_n: 1 });
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
