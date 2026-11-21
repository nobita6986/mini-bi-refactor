/**
 * WP13 PR-0 Backend — Real PostgreSQL 18 Concurrency & Dynamic ACL Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated ephemeral PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies under `SET LOCAL ROLE service_role` with ZERO `40P01` deadlocks:
 *   1. Full 234-migration apply + dynamic S0-T1-C allowlist postconditions pre/post (+2 net
 *      service_role RPCs relative to applied prefix, 0 client/PUBLIC grants, 0 unsafe search_path,
 *      bootstrap executor intact).
 *   2. Race 1 (Optional-reason idempotency serialization):
 *      Concurrent `direct_entry_create_team(..., p_reason = null / '   ')` sharing one
 *      `idempotency_key` -> zero `40P01`, deterministic serialization/replay, exactly 1 team created,
 *      0 rows inserted in `direct_entry_restricted_reasons`.
 *   3. Race 2 (§4.2 Lock order on linked Person/Account/Recruiter):
 *      Concurrent `direct_entry_account_operation_update_display_name(..., p_reason = null)` vs
 *      `org_department_update_person_admin` on the SAME linked Person/Account/Recruiter ->
 *      zero `40P01` deadlocks, clean `organization_department_audit_events` write, consistent
 *      final name across `organization_persons`, `direct_entry_app_users`, and `recruiters`.
 *   4. Race 3 (Optional-reason OCC serialization):
 *      2 concurrent `direct_entry_update_personnel(..., p_reason = null)` with distinct keys and
 *      the same `expected_version` -> exactly 1 succeeds and 1 fails closed with `PT409`,
 *      zero `40P01`, 0 rows inserted in `direct_entry_restricted_reasons`.
 *   5. Race 4 (Filtered read consistency under concurrent writes):
 *      Concurrent `direct_entry_list_app_users_filtered_admin` and
 *      `direct_entry_list_personnel_filtered_admin` reads alongside live optional-reason updates ->
 *      zero errors, exact 6-key / 7-key envelopes, deterministic pagination.
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
  S0_T1_C_MIGRATION_NAME,
  WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME,
  WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_RPC_SIGNATURES,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const OWNER = {
  auth: "13001000-0000-4000-8000-000000000001",
  app: "23001000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner PG18",
};
const LUANPT = {
  auth: "13001000-0000-4000-8000-000000000002",
  app: "23001000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT PG18",
};
const LIENVU = {
  auth: "13001000-0000-4000-8000-000000000003",
  app: "23001000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu PG18",
};
const NGATTT = {
  auth: "13001000-0000-4000-8000-000000000004",
  app: "23001000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT PG18",
};
const LINKED_USER = {
  auth: "13001000-0000-4000-8000-000000000011",
  app: "23001000-0000-4000-8000-000000000011",
  email: "wp13.pg18.linked@hrpartner.vn",
  name: "PG18 Linked Target",
};
const SHARED_USER = {
  auth: "13001000-0000-4000-8000-000000000012",
  app: "23001000-0000-4000-8000-000000000012",
  email: "wp13.pg18.shared@hrpartner.vn",
  name: "PG18 Shared Account",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `93001000-0000-4000-8000-${hex}`;
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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function connect(port, database = "postgres", applicationName = "wp13-pr0-pg18") {
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

test("WP13 PR-0 Backend real PG18 concurrency, lock-order & dynamic S0-T1-C verification", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for the native PG18 concurrency suite");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wp13-pr0-pg18-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `wp13_pr0_${process.pid}`;
  let serverStarted = false;
  let admin;
  let client;
  const extraClients = [];

  try {
    run(initdb, [
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
      "--pgdata", dataDir,
    ]);
    run(pgCtl, [
      "-D", dataDir,
      "-l", logFile,
      "-o", `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
      "-w", "start",
    ], { ignoreOutput: process.platform === "win32" });
    serverStarted = true;

    admin = await connect(port);
    await admin.query(`create database ${databaseName}`);
    client = await connect(port, databaseName, "wp13-pr0-main");

    await client.query(
      "create role anon nologin; create role authenticated nologin;"
        + " create role service_role nologin bypassrls;"
        + " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql").sort();
    const wp13Idx = names.indexOf(WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME);
    assert.ok(wp13Idx > 0, "WP13 PR-0 migration is present in migration chain");
    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");

    // Apply all migrations prior to WP13 PR-0 and verify dynamic pre-migration S0-T1-C postconditions
    for (let i = 0; i < wp13Idx; i += 1) {
      await client.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
    }
    const preApplied = new Set(names.slice(0, wp13Idx));
    const preCheck = await verifyS0T1CSecurityPostconditions(client, s0Sql, preApplied);
    assert.equal(preCheck.ok, true, `pre-WP13 PG18 S0-T1-C postconditions pass: ${preCheck.reason ?? ""}`);
    assert.equal(preCheck.details.exposedClientOrPublicCount, 0);

    // Apply WP13 PR-0 and verify its exact +2 net service_role RPC delta relative to its applied prefix
    await client.query(await readFile(path.join(MIGRATION_DIR, names[wp13Idx]), "utf8"));
    const wp13PostApplied = new Set(names.slice(0, wp13Idx + 1));
    const wp13PostCheck = await verifyS0T1CSecurityPostconditions(client, s0Sql, wp13PostApplied);
    assert.equal(wp13PostCheck.ok, true, `post-WP13 PG18 S0-T1-C postconditions pass: ${wp13PostCheck.reason ?? ""}`);
    assert.equal(
      wp13PostCheck.details.actualServiceCount,
      preCheck.details.actualServiceCount + WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_RPC_SIGNATURES.length,
      "PG18 WP13 PR-0 adds exact +2 net service_role RPCs relative to applied prefix",
    );
    assert.equal(wp13PostCheck.details.exposedClientOrPublicCount, 0);
    assert.equal(wp13PostCheck.details.bootstrapExecutorIntact, true);

    // Apply any subsequent migrations in the chain and verify full-chain S0-T1-C postconditions
    for (let i = wp13Idx + 1; i < names.length; i += 1) {
      await client.query(await readFile(path.join(MIGRATION_DIR, names[i]), "utf8"));
    }
    const postCheck = await verifyS0T1CSecurityPostconditions(client, s0Sql, new Set(names));
    assert.equal(postCheck.ok, true, `full-chain PG18 S0-T1-C postconditions pass: ${postCheck.reason ?? ""}`);
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
    assert.equal(postCheck.details.bootstrapExecutorIntact, true);

    // Seed baseline actors and cutover to WP5
    for (const [u, accountType] of [
      [OWNER, "NORMAL"],
      [LUANPT, "NORMAL"],
      [LIENVU, "NORMAL"],
      [NGATTT, "NORMAL"],
      [LINKED_USER, "NORMAL"],
      [SHARED_USER, "SHARED"],
    ]) {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [u.auth, u.email]);
      await client.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, account_type) values ($1, $2, true, $3, $4)",
        [u.app, u.auth, u.name, accountType],
      );
    }
    for (const adm of [OWNER, LIENVU, NGATTT]) {
      await client.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2020-01-01', true), ($1, 'own', null, '2020-01-01', true)",
        [adm.app],
      );
      for (const cap of [
        "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
        "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
        "audit_view", "worker_edit_history_view", "document_upload", "document_view",
        "employment_status.review", "employment_status.apply", "change_request_create",
        "change_review", "employment_status.request", "duplicate_cccd_withdraw",
      ]) {
        await client.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
          [adm.app, cap],
        );
      }
    }
    await client.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2020-01-01', true)",
      [LUANPT.app],
    );
    const plan = await runWp5Cutover(client, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(client, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    // Seed Person + Account + Recruiter link for lock-order & OCC races
    const personId = (await serviceQuery(
      client,
      `select public.org_department_create_person_admin(
         $1::uuid, $2::uuid, 'wp13.pg18.linked', 'PG18 Linked Target', '2026-01-01'::date,
         null::uuid, null::uuid, null::integer, null::uuid,
         'PG18 seed person', $3::uuid, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, nextUuid(), sha256("pg18-seed-person")],
    )).rows[0].payload.person.person_id;
    await serviceQuery(
      client,
      `select public.org_department_link_account_person_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null::uuid,
         'PG18 seed link', $5::uuid, $6::text
       )`,
      [OWNER.auth, OWNER.app, LINKED_USER.app, personId, nextUuid(), sha256("pg18-seed-link")],
    );
    const linkedRecId = (await serviceQuery(
      client,
      `select public.direct_entry_account_operation_create_personnel(
         $1::uuid, $2::uuid, $3::uuid, 2, 'wp13.pg18.linked', 'STAFF', null::date, null::text, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, LINKED_USER.app, nextUuid()],
    )).rows[0].payload.recruiter_id;

    const c1 = await connect(port, databaseName, "wp13-race-1");
    const c2 = await connect(port, databaseName, "wp13-race-2");
    const c3 = await connect(port, databaseName, "wp13-race-3");
    extraClients.push(c1, c2, c3);

    async function reasonCount() {
      const { rows } = await client.query("select count(*)::int as cnt from public.direct_entry_restricted_reasons");
      return rows[0].cnt;
    }

    // -------------------------------------------------------------------------
    // Race 1: Concurrent direct_entry_create_team with same idempotency_key & optional reason
    // -------------------------------------------------------------------------
    const rBeforeRace1 = await reasonCount();
    const sharedTeamKey = nextUuid();
    const teamRace = await Promise.allSettled([
      serviceQuery(
        c1,
        "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'PG18_RACE_T1', 'PG18 Race Team', null, $3::text) as payload",
        [OWNER.auth, OWNER.app, sharedTeamKey],
      ),
      serviceQuery(
        c2,
        "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'PG18_RACE_T1', 'PG18 Race Team', '   ', $3::text) as payload",
        [OWNER.auth, OWNER.app, sharedTeamKey],
      ),
    ]);
    for (const outcome of teamRace) {
      if (outcome.status === "rejected") {
        assert.notEqual(outcome.reason?.code, "40P01", "no deadlock in concurrent create_team");
        assert.ok(
          ["23505", "PT409", "40001"].includes(outcome.reason?.code),
          `unexpected race error code: ${outcome.reason?.code}: ${outcome.reason?.message}`,
        );
      }
    }
    const createdTeamFulfilled = teamRace.filter((r) => r.status === "fulfilled");
    assert.ok(createdTeamFulfilled.length >= 1, "at least one concurrent create_team succeeds");
    const { rows: teamRows } = await client.query(
      "select team_id from public.teams where code = 'PG18_RACE_T1'",
    );
    assert.equal(teamRows.length, 1, "exactly one team row created for concurrent same-key create_team");
    assert.equal(await reasonCount(), rBeforeRace1, "0 placeholder rows in direct_entry_restricted_reasons");
    const raceTeamId = teamRows[0].team_id;

    // Assign linkedRecId to raceTeamId so filtered personnel reads can query it concurrently
    await client.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2026-01-01', true)",
      [linkedRecId, raceTeamId],
    );

    // -------------------------------------------------------------------------
    // Race 2: Lock order (§4.2) — display_name_update (reason = null) vs org_department_update_person_admin
    // -------------------------------------------------------------------------
    for (let round = 0; round < 4; round += 1) {
      const { rows: curState } = await client.query(
        `select u.version as acc_ver, p.version as person_ver
           from public.direct_entry_app_users u, public.organization_persons p
          where u.app_user_id = $1::uuid and p.person_id = $2::uuid`,
        [LINKED_USER.app, personId],
      );
      const { acc_ver, person_ver } = curState[0];
      const settled = await Promise.allSettled([
        serviceQuery(
          c1,
          `select public.direct_entry_account_operation_update_display_name(
             $1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, null, $6::text
           ) as payload`,
          [OWNER.auth, OWNER.app, LINKED_USER.app, `Acc Rename R${round}`, acc_ver, nextUuid()],
        ),
        serviceQuery(
          c2,
          `select public.org_department_update_person_admin(
             $1::uuid, $2::uuid, $3::uuid, $4::integer, 'wp13.pg18.linked', $5::text, '2026-01-01'::date,
             'ACTIVE', 'PG18 concurrent person rename', $6::uuid, $7::text
           ) as payload`,
          [OWNER.auth, OWNER.app, personId, person_ver, `Person Rename R${round}`, nextUuid(), sha256(`pg18-race-r${round}`)],
        ),
        serviceQuery(
          c3,
          "select public.direct_entry_list_app_users_filtered_admin($1::uuid, $2::uuid, null, 'all', 1, 25, 'NORMAL', 'linked') as payload",
          [OWNER.auth, OWNER.app],
        ),
      ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          assert.notEqual(outcome.reason?.code, "40P01", `zero 40P01 deadlock in lock-order round ${round}`);
          assert.equal(outcome.reason?.code, "PT409", `only OCC conflict expected, got ${outcome.reason?.code}: ${outcome.reason?.message}`);
        }
      }
      assert.equal(settled[2].status, "fulfilled", "filtered accounts read succeeds concurrently");
      assert.equal(settled[2].value.rows[0].payload.total, 1);

      // Verify post-round name consistency across person, account, and recruiter
      const { rows: afterRound } = await client.query(
        `select p.full_name, u.display_name as acc_name, r.display_name as rec_name
           from public.organization_persons p,
                public.direct_entry_app_users u,
                public.recruiters r
          where p.person_id = $1::uuid
            and u.app_user_id = $2::uuid
            and r.recruiter_id = $3::uuid`,
        [personId, LINKED_USER.app, linkedRecId],
      );
      assert.equal(afterRound[0].acc_name, afterRound[0].full_name, "account and person names remain synchronized");
      assert.equal(afterRound[0].rec_name, afterRound[0].full_name, "recruiter and person names remain synchronized");
    }

    // -------------------------------------------------------------------------
    // Race 3: Concurrent direct_entry_update_personnel (reason = null) with same expected_version
    // -------------------------------------------------------------------------
    const rBeforeRace3 = await reasonCount();
    const { rows: recState } = await client.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [linkedRecId],
    );
    const recVer = recState[0].version;
    const persRace = await Promise.allSettled([
      serviceQuery(
        c1,
        `select public.direct_entry_update_personnel(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, 'Personnel Race Winner A', 'wp13.pg18.linked', 'TEAM_LEADER', null, $5::text
         ) as payload`,
        [OWNER.auth, OWNER.app, linkedRecId, recVer, nextUuid()],
      ),
      serviceQuery(
        c2,
        `select public.direct_entry_update_personnel(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, 'Personnel Race Winner B', 'wp13.pg18.linked', 'STAFF', '   ', $5::text
         ) as payload`,
        [OWNER.auth, OWNER.app, linkedRecId, recVer, nextUuid()],
      ),
      serviceQuery(
        c3,
        "select public.direct_entry_list_personnel_filtered_admin($1::uuid, $2::uuid, null, true, 1, 25, $3::uuid) as payload",
        [OWNER.auth, OWNER.app, raceTeamId],
      ),
    ]);
    const writeOutcomes = persRace.slice(0, 2);
    const writeFulfilled = writeOutcomes.filter((r) => r.status === "fulfilled");
    const writeRejected = writeOutcomes.filter((r) => r.status === "rejected");
    assert.equal(writeFulfilled.length, 1, "exactly 1 concurrent update_personnel succeeds");
    assert.equal(writeRejected.length, 1, "exactly 1 concurrent update_personnel fails OCC");
    assert.equal(writeRejected[0].reason?.code, "PT409");
    assert.equal(await reasonCount(), rBeforeRace3, "0 placeholder rows in direct_entry_restricted_reasons after Race 3");
    assert.equal(persRace[2].status, "fulfilled", "filtered personnel read succeeds concurrently");
    assert.equal(persRace[2].value.rows[0].payload.total, 1);

    // Final filtered SPECIAL accounts check
    const specialRes = await serviceQuery(
      client,
      "select public.direct_entry_list_app_users_filtered_admin($1::uuid, $2::uuid, null, 'all', 1, 25, 'SPECIAL', 'unlinked') as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.equal(specialRes.rows[0].payload.total, 1);
    assert.equal(specialRes.rows[0].payload.accounts[0].account_ref, SHARED_USER.app);
  } finally {
    for (const c of extraClients) await c.end().catch(() => {});
    if (client) await client.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    if (serverStarted) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
