/**
 * WP10-5 — Actor Session Context Cutover (`direct_entry_resolve_actor_context`)
 * Real PG18 + PGlite Dual-Engine Before/After Acceptance & Security Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against BOTH:
 *   1. PGlite (`@electric-sql/pglite`) — migration hygiene, atomic rollback, S0-T1-C ACLs,
 *      and full 13-scenario Before vs After cutover matrix.
 *   2. Isolated PostgreSQL 18 cluster (`initdb` + `pg_ctl`) — full 13-scenario Before vs After
 *      cutover matrix on real PG18 engine.
 *
 * Verifies Before (0..242 ending at `20261125200000`) vs After (`243` `20261125220000`):
 *   1) Full Admin / BoD
 *   2) Catalog-only user
 *   3) HR Operator
 *   4) Team Leader
 *   5) Project Manager (both standalone & with Recruiter group)
 *   6) Project Accountant (`vendor_finance_view @ CONTEXT_PROJECT`, both standalone AND paired
 *      with an ALL-scoped group): assigned projects only, ZERO `/finance` leak in
 *      `capabilities`, `all_scope_grants`, TS nav, or VFIN RPCs
 *   7) Scope-only account (scope grant without capability)
 *   8) Zero-permission account
 *   9) Unmigrated account (`authz_managed = false`): continues resolving via legacy branch
 *  10) Multi-group account: grant 2 groups, revoke 1 group -> revoked rights gone, remaining intact
 *  11) Disabled -> revoked while disabled -> re-enabled -> revoked rights NEVER resurrect
 *  12) Mirror-independence proof: deleting & poisoning `direct_entry_capability_grants` and
 *      `direct_entry_scope_grants` on `authz_managed = true` produces ZERO change / ZERO leak
 *  13) RPC-only rollback rehearsal: restoring ONLY pre-243 `direct_entry_resolve_actor_context(uuid)`
 *      (definition + owner + ACL) reverts all personas to exact pre-243 snapshots with zero table/grant edits,
 *      then re-applies migration #243 cleanly before mutation & mirror-poison tests
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

import { createAuthSessionResponse } from "../src/lib/auth/auth-session-core.ts";
import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideAttendanceReportPageAccess,
  decideDirectEntryPageAccess,
  decideProjectOperationsPageAccess,
  decideWorkerOperationsPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import {
  hasPairedAllReportingAccess,
  hasPairedFullAdmin,
  projectClientCapabilities,
  projectClientScopes,
  resolveActor,
} from "../src/lib/auth/direct-entry-v2.ts";
import { createDirectEntrySessionResponse } from "../src/lib/direct-entry/session-bootstrap.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import { computeAssignProjectAccountantFingerprint } from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import {
  adminAreaNavPredicate,
  adminAuthorityNavPredicate,
  adminSecurityNavPredicate,
  catalogOperatorNavPredicate,
  directEntryNavPredicate,
  projectAdminNavPredicate,
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  workerOperationsNavPredicate,
  workerOperationsTeamScopePredicate,
} from "../src/lib/navigation/registry-capability.ts";
import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_4_MIGRATION_NAME = "20261125200000_wp10_4_org_department_heads_cutover.sql";
const WP10_5_MIGRATION_NAME = "20261125220000_wp10_5_actor_context_group_authz_cutover.sql";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const OWNER = {
  auth: "60100000-0000-4000-8000-00000000a001",
  app: "60100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-5",
};
const LUANPT = {
  auth: "60100000-0000-4000-8000-00000000a002",
  app: "60100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "60100000-0000-4000-8000-00000000a003",
  app: "60100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "60100000-0000-4000-8000-00000000a004",
  app: "60100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `60110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}

function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function runBin(file, args, { ignoreOutput = false } = {}) {
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
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connectPg(port, appName) {
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

async function createPgliteEngine() {
  const db = new PGlite();
  return {
    name: "PGlite",
    async exec(sql) {
      await db.exec(sql);
    },
    async query(sql, params = []) {
      return db.query(sql, params);
    },
    async serviceQuery(sql, params = []) {
      await db.exec("begin; set local role service_role");
      try {
        const res = await db.query(sql, params);
        await db.exec("commit");
        return res;
      } catch (err) {
        await db.exec("rollback").catch(() => {});
        throw err;
      }
    },
    async serviceRpc(fnName, args = [], casts = []) {
      const placeholders = args
        .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
        .join(", ");
      const res = await this.serviceQuery(`select public.${fnName}(${placeholders}) as data`, args);
      return res.rows[0]?.data;
    },
    async close() {
      await db.close();
    },
  };
}

async function createPg18Engine() {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required for PG18 test");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-5-actor-cutover-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  let client = null;

  try {
    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;
    client = await connectPg(port, "wp10-5-pg18");
    const verRes = await client.query("show server_version");
    const serverVersion = verRes.rows[0]?.server_version ?? "unknown";
    return {
      name: `PostgreSQL ${serverVersion}`,
      async exec(sql) {
        await client.query(sql);
      },
      async query(sql, params = []) {
        return client.query(sql, params);
      },
      async serviceQuery(sql, params = []) {
        await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'; set local role service_role");
        try {
          const res = await client.query(sql, params);
          await client.query("commit");
          return res;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      },
      async serviceRpc(fnName, args = [], casts = []) {
        const placeholders = args
          .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
          .join(", ");
        const res = await this.serviceQuery(`select public.${fnName}(${placeholders}) as data`, args);
        return res.rows[0]?.data;
      },
      async close() {
        await client?.end().catch(() => {});
        if (started) {
          spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
        }
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await client?.end().catch(() => {});
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function seedLegacyAdmin(engine, user) {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await engine.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await engine.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedAccount(engine, loginPrefix, displayName, { authzManaged = true, enabled = true } = {}) {
  const auth = nextUuid();
  const app = nextUuid();
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    auth,
    `${loginPrefix}@hrpartner.local`,
  ]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, $4, $5, 1)`,
    [app, auth, displayName, enabled, authzManaged],
  );
  return { auth, app, login: loginPrefix, name: displayName };
}

async function resolveActorContext(engine, user) {
  return engine.serviceRpc("direct_entry_resolve_actor_context", [user.auth], ["uuid"]);
}

async function resolveTsActor(engine, user, atIso) {
  const raw = await resolveActorContext(engine, user);
  const res = await resolveActor({
    session: {
      auth_subject: user.auth,
      provider: "supabase",
      authenticated_at: atIso,
    },
    repository: {
      loadByAuthSubject: async (sub) => {
        assert.equal(sub, user.auth);
        return raw;
      },
    },
    at: atIso,
  });
  return { raw, res };
}

async function getAccountVersion(engine, appUserId) {
  const { rows } = await engine.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [appUserId],
  );
  return rows[0].version;
}

async function assignGroup(engine, targetAppUserId, groupId, reason) {
  const ver = await getAccountVersion(engine, targetAppUserId);
  const idempKey = nextUuid();
  const reqHash = sha256(
    JSON.stringify({
      op: "ASSIGN_GROUP_MEMBER",
      account_ref: targetAppUserId,
      group_id: groupId,
      expected_account_version: ver,
      reason,
    }),
  );
  return engine.serviceRpc(
    "direct_entry_authz_assign_group_member_admin",
    [OWNER.auth, OWNER.app, targetAppUserId, groupId, ver, reason, idempKey, reqHash],
    ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
  );
}

async function removeGroup(engine, targetAppUserId, membershipId, reason) {
  const ver = await getAccountVersion(engine, targetAppUserId);
  const idempKey = nextUuid();
  const reqHash = sha256(
    JSON.stringify({
      op: "REMOVE_GROUP_MEMBER",
      account_ref: targetAppUserId,
      membership_id: membershipId,
      expected_account_version: ver,
      reason,
    }),
  );
  return engine.serviceRpc(
    "direct_entry_authz_remove_group_member_admin",
    [OWNER.auth, OWNER.app, targetAppUserId, membershipId, ver, reason, idempKey, reqHash],
    ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
  );
}

async function setAccountEnabled(engine, targetAppUserId, enable, reason) {
  const ver = await getAccountVersion(engine, targetAppUserId);
  const fnName = enable ? "direct_entry_enable_app_user" : "direct_entry_disable_app_user";
  return engine.serviceRpc(
    fnName,
    [OWNER.auth, OWNER.app, targetAppUserId, ver, reason, `status-${nextUuid()}`],
    ["uuid", "uuid", "uuid", "integer", "text", "text"],
  );
}

async function inspectActorRpcMeta(engine) {
  const { rows: [meta] } = await engine.query(`
    select
      pg_catalog.pg_get_functiondef(p.oid) as fn_def,
      p.proowner::oid::text as proowner_oid,
      pg_catalog.pg_get_userbyid(p.proowner)::text as proowner_name,
      p.prosecdef,
      p.provolatile::text as provolatile,
      coalesce(p.proconfig, array[]::text[]) as proconfig,
      pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as acl_service_role,
      pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as acl_public,
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as acl_anon,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as acl_authenticated
    from pg_catalog.pg_proc p
    where p.oid = 'public.direct_entry_resolve_actor_context(uuid)'::regprocedure
  `);
  return meta;
}

async function snapshotRollbackProtectedTables(engine) {
  const [appUsers, groupMembers, tlAssignments, paAssignments, pmAssignments, deptHeads] = await Promise.all([
    engine.query("select app_user_id::text, enabled, authz_managed from public.direct_entry_app_users order by app_user_id"),
    engine.query("select membership_id::text, app_user_id::text, group_id::text, ended_at from public.authz_user_group_members order by membership_id"),
    engine.query("select assignment_id::text, team_id::text, leader_app_user_id::text, is_current, valid_to from public.direct_entry_team_leader_assignments order by assignment_id"),
    engine.query("select assignment_id::text, project_id, accountant_user_id::text, ended_at, valid_to from public.vendor_finance_project_accountants order by assignment_id"),
    engine.query("select assignment_id::text, project_id, manager_recruiter_id::text, is_current, revoked_at from public.direct_entry_project_manager_assignments order by assignment_id"),
    engine.query("select head_assignment_id::text, department_id::text, person_id::text, ended_at from public.organization_department_heads order by head_assignment_id"),
  ]);
  return {
    appUsers: appUsers.rows,
    groupMembers: groupMembers.rows,
    tlAssignments: tlAssignments.rows,
    paAssignments: paAssignments.rows,
    pmAssignments: pmAssignments.rows,
    deptHeads: deptHeads.rows,
  };
}

async function assertSessionScopeMetadata(label, res, { expectedTeamIds = [], expectedTeamValidFrom = null, expectedAllValidFrom = null }) {
  assert.equal(res.ok, true, `${label}: TS resolveActor ok`);
  const authRes = await createAuthSessionResponse(async () => ({ actor: res }));
  assert.equal(authRes.status, 200, `${label}: /api/auth/session status 200`);
  const authBody = await authRes.json();
  assert.equal(authBody.ok, true);

  const deRes = await createDirectEntrySessionResponse("true", async () => ({
    actor: res,
    response_headers: {},
  }));
  assert.equal(deRes.status, 200, `${label}: /api/direct-entry/session status 200`);
  const deBody = await deRes.json();
  assert.equal(deBody.ok, true);

  for (const [surface, actorObj] of [
    ["/api/auth/session", authBody.actor],
    ["/api/direct-entry/session", deBody.actor],
  ]) {
    const scopes = actorObj.scopes;
    assert.ok(Array.isArray(scopes), `${label} (${surface}): scopes array`);
    const ownScopes = scopes.filter((s) => s.kind === "own");
    assert.equal(ownScopes.length, 1, `${label} (${surface}): exactly 1 own scope`);
    assert.equal(ownScopes[0].valid_from, "0001-01-01", `${label} (${surface}): own valid_from === 0001-01-01`);
    assert.equal(ownScopes[0].valid_to, null, `${label} (${surface}): own valid_to === null`);

    const teamScopes = scopes.filter((s) => s.kind === "team");
    assert.deepEqual(
      teamScopes.map((s) => s.reference).sort(),
      [...expectedTeamIds].sort(),
      `${label} (${surface}): team scope refs`,
    );
    for (const ts of teamScopes) {
      assert.equal(ts.valid_from, expectedTeamValidFrom, `${label} (${surface}): team valid_from`);
      assert.equal(ts.valid_to, null, `${label} (${surface}): team valid_to === null`);
    }

    const allScopes = scopes.filter((s) => s.kind === "all");
    if (expectedAllValidFrom !== null) {
      assert.equal(allScopes.length, 1, `${label} (${surface}): exactly 1 all scope`);
      assert.equal(allScopes[0].valid_from, expectedAllValidFrom, `${label} (${surface}): all valid_from`);
      assert.equal(allScopes[0].valid_to, null, `${label} (${surface}): all valid_to === null`);
    } else {
      assert.equal(allScopes.length, 0, `${label} (${surface}): 0 all scopes`);
    }
  }
}

function normalizeScopeRefs(scopes) {
  return [...scopes].map((s) => `${s.kind}:${s.reference}`).sort();
}

function assertActorParity(label, beforeCtx, afterCtx, beforeTs, afterTs, { expectedAfterAddedCaps = [] } = {}) {
  assert.equal(afterCtx.auth_subject, beforeCtx.auth_subject, `${label}: auth_subject parity`);
  assert.equal(afterCtx.app_user_id, beforeCtx.app_user_id, `${label}: app_user_id parity`);
  assert.equal(afterCtx.display_name, beforeCtx.display_name, `${label}: display_name parity`);
  assert.equal(afterCtx.enabled, beforeCtx.enabled, `${label}: enabled parity`);
  const expectedCaps = [...new Set([...beforeCtx.capabilities, ...expectedAfterAddedCaps])].sort();
  assert.deepEqual(afterCtx.capabilities, expectedCaps, `${label}: capabilities parity`);
  assert.deepEqual(afterCtx.teams, beforeCtx.teams, `${label}: teams parity`);
  assert.deepEqual(
    afterCtx.team_scope_grants.map((g) => g.team_id),
    beforeCtx.team_scope_grants.map((g) => g.team_id),
    `${label}: team_scope_grants team_ids parity`,
  );
  assert.equal(
    afterCtx.all_scope_grants.length,
    beforeCtx.all_scope_grants.length,
    `${label}: all_scope_grants count parity`,
  );
  assert.deepEqual(afterCtx.allowed_worker_tabs, beforeCtx.allowed_worker_tabs, `${label}: allowed_worker_tabs parity`);
  assert.deepEqual(afterCtx.effective_grants, beforeCtx.effective_grants, `${label}: effective_grants parity`);
  assert.deepEqual(afterCtx.assigned_roles, beforeCtx.assigned_roles, `${label}: assigned_roles parity`);
  assert.deepEqual(
    afterCtx.effective_report_review_scopes ?? [],
    beforeCtx.effective_report_review_scopes ?? [],
    `${label}: effective_report_review_scopes parity`,
  );
  assert.deepEqual(
    afterCtx.recruiter_links.map((l) => l.recruiter_id),
    beforeCtx.recruiter_links.map((l) => l.recruiter_id),
    `${label}: recruiter_links parity`,
  );

  assert.equal(afterTs.ok, beforeTs.ok, `${label}: TS resolveActor ok parity`);
  if (afterTs.ok && beforeTs.ok) {
    assert.deepEqual(
      projectClientCapabilities(afterTs.actor),
      projectClientCapabilities(beforeTs.actor),
      `${label}: projectClientCapabilities parity`,
    );
    assert.deepEqual(
      normalizeScopeRefs(projectClientScopes(afterTs.actor)),
      normalizeScopeRefs(projectClientScopes(beforeTs.actor)),
      `${label}: projectClientScopes parity`,
    );
    assert.deepEqual(
      afterTs.actor.allowed_worker_tabs ?? [],
      beforeTs.actor.allowed_worker_tabs ?? [],
      `${label}: TS allowed_worker_tabs parity`,
    );
  }
}

async function runWp105CutoverMatrix(engine) {
  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  const wp104Idx = files.indexOf(WP10_4_MIGRATION_NAME);
  const wp105Idx = files.indexOf(WP10_5_MIGRATION_NAME);
  assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
  assert.ok(wp104Idx > groupsIdx, "WP10-4 migration must exist");
  assert.equal(wp105Idx, wp104Idx + 1, "WP10-5 migration must immediately follow WP10-4");

  await engine.exec(ROLE_PREAMBLE);

  // Phase 0: Apply 0..242 (BEFORE 20261125220000)
  for (let i = 0; i < groupsIdx; i += 1) {
    await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }
  await seedLegacyAdmin(engine, OWNER);
  await seedLegacyAdmin(engine, LUANPT);
  await seedLegacyAdmin(engine, LIENVU);
  await seedLegacyAdmin(engine, NGATTT);

  const plan = await runWp5Cutover(engine, { mode: "read-only-plan" });
  const applied = await runWp5Cutover(engine, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  for (let i = groupsIdx; i <= wp104Idx; i += 1) {
    await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }

  const { rows: [dateRow] } = await engine.query(
    "select public.direct_entry_authorization_date()::text as authz_date",
  );
  const todayStr = dateRow.authz_date;
  const atIso = `${todayStr}T09:00:00Z`;

  // Seed Teams, Projects, Banks, Departments, and Custom Permission Groups
  const TEAM_1 = nextUuid();
  const TEAM_2 = nextUuid();
  const PRJ_1 = "wp10-5-prj-1";
  const PRJ_2 = "wp10-5-prj-2";
  const PRJ_3 = "wp10-5-prj-3";
  await engine.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'team_wp105_1', 'Đội WP10-5 Một', true, 1),
            ($2::uuid, 'team_wp105_2', 'Đội WP10-5 Hai', true, 1)`,
    [TEAM_1, TEAM_2],
  );
  await engine.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ($1, 'Dự án WP10-5 Một', true, 1),
            ($2, 'Dự án WP10-5 Hai', true, 1),
            ($3, 'Dự án WP10-5 Ba', true, 1)`,
    [PRJ_1, PRJ_2, PRJ_3],
  );
  await engine.query(
    "insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)",
  );
  for (const prj of [PRJ_1, PRJ_2, PRJ_3]) {
    for (const tid of [TEAM_1, TEAM_2]) {
      await engine.query(
        `insert into public.direct_entry_project_team_scopes
           (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
         values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)`,
        [prj, tid, OWNER.app],
      );
    }
  }

  const { rows: deptRows } = await engine.query(
    "select department_id, system_key from public.organization_departments where system_key in ('RECRUITMENT', 'ACCOUNTING', 'IT', 'HR')",
  );
  const deptByKey = Object.fromEntries(deptRows.map((r) => [r.system_key, r.department_id]));
  assert.ok(deptByKey.RECRUITMENT && deptByKey.ACCOUNTING && deptByKey.IT);

  const { rows: sysGroups } = await engine.query(
    "select group_id, code from public.authz_user_groups where code in ('SYSTEM_ADMIN', 'HR_CATALOG_OPERATOR', 'RECRUITER_OPERATIONS')",
  );
  const groupByCode = Object.fromEntries(sysGroups.map((g) => [g.code, g.group_id]));
  assert.ok(groupByCode.SYSTEM_ADMIN && groupByCode.HR_CATALOG_OPERATOR && groupByCode.RECRUITER_OPERATIONS);

  const catGroupCreate = await engine.serviceRpc(
    "direct_entry_authz_create_group_admin",
    [
      OWNER.auth,
      OWNER.app,
      "CATALOG_ONLY_WP105",
      "Nhóm Danh mục WP10-5",
      "Chỉ quản lý danh mục chung",
      deptByKey.IT,
      null,
      ["catalog_master_manage"],
      JSON.stringify([]),
      "Tạo nhóm catalog-only WP10-5",
      nextUuid(),
      sha256("CATALOG_ONLY_WP105"),
    ],
    ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
  );
  const CATALOG_GROUP_ID = catGroupCreate.group_id;

  const team2GroupCreate = await engine.serviceRpc(
    "direct_entry_authz_create_group_admin",
    [
      OWNER.auth,
      OWNER.app,
      "TEAM_2_OPS_WP105",
      "Nhóm Đội 2 WP10-5",
      "Theo dõi tuyển dụng Đội 2",
      deptByKey.RECRUITMENT,
      TEAM_2,
      ["entry_team", "report_view"],
      JSON.stringify([]),
      "Tạo nhóm đội 2 WP10-5",
      nextUuid(),
      sha256("TEAM_2_OPS_WP105"),
    ],
    ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
  );
  const TEAM2_GROUP_ID = team2GroupCreate.group_id;

  const emptyCapGroupCreate = await engine.serviceRpc(
    "direct_entry_authz_create_group_admin",
    [
      OWNER.auth,
      OWNER.app,
      "EMPTY_CAP_WP105",
      "Nhóm Rỗng WP10-5",
      "Nhóm không có capability",
      deptByKey.IT,
      null,
      [],
      JSON.stringify([]),
      "Tạo nhóm rỗng WP10-5",
      nextUuid(),
      sha256("EMPTY_CAP_WP105"),
    ],
    ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
  );
  const EMPTY_CAP_GROUP_ID = emptyCapGroupCreate.group_id;

  async function onboardOrg(tag, deptId, displayName, { withRecruiter = false, position = "STAFF", teamId = null } = {}) {
    const acc = await seedAccount(engine, `wp105.${tag}`, displayName, { authzManaged: true });
    const empCode = `EMP-W5-${tag.toUpperCase()}`;
    const p = (
      await engine.serviceRpc(
        "org_department_create_person_admin",
        [
          OWNER.auth,
          OWNER.app,
          empCode,
          acc.name,
          "2025-01-01",
          deptId,
          acc.app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: acc.name,
            joined_on: "2025-01-01",
            initial_department_ref: deptId,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ],
        ["uuid", "uuid", "text", "text", "date", "uuid", "uuid", "integer", "uuid", "text", "uuid", "text"],
      )
    ).person;

    let recruiterId = null;
    if (withRecruiter) {
      const cp = await engine.serviceRpc(
        "direct_entry_account_operation_create_personnel",
        [
          OWNER.auth,
          OWNER.app,
          acc.app,
          p.active_account_link.account_version,
          acc.login,
          position,
          null,
          `Create recruiter ${tag}`,
          nextUuid(),
        ],
        ["uuid", "uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      );
      recruiterId = cp.recruiter_id;
      if (teamId) {
        await engine.serviceRpc(
          "direct_entry_assign_team_membership",
          [OWNER.auth, OWNER.app, recruiterId, teamId, null, cp.version, `Assign team ${tag}`, nextUuid()],
          ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
        );
      }
    }
    return { acc, person: p, recruiterId };
  }

  // 2) Catalog-only user
  const CATALOG_ONLY = await seedAccount(engine, "wp105.catalog", "Catalog Only User");
  await assignGroup(engine, CATALOG_ONLY.app, CATALOG_GROUP_ID, "Assign Catalog Only");

  // 3) HR Operator
  const HR_OP = await seedAccount(engine, "wp105.hrop", "HR Operator User");
  await assignGroup(engine, HR_OP.app, groupByCode.HR_CATALOG_OPERATOR, "Assign HR Operator");

  // 4) Team Leader (TEAM_1)
  const TL_ORG = await onboardOrg("tl", deptByKey.RECRUITMENT, "Team Leader One", {
    withRecruiter: true,
    position: "TEAM_LEADER",
    teamId: TEAM_1,
  });
  const TL_USER = TL_ORG.acc;
  await engine.serviceRpc(
    "direct_entry_designate_team_leader",
    [OWNER.auth, OWNER.app, TEAM_1, TL_USER.app, null, 1, "Designate TL_1", `tl1-${nextUuid()}`],
    ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
  );

  // 5) Project Manager (PRJ_1) + auto-assigned RECRUITER_OPERATIONS, and standalone PM (PRJ_1)
  const PM_ORG = await onboardOrg("pm", deptByKey.RECRUITMENT, "Project Manager Ops", {
    withRecruiter: true,
    position: "STAFF",
    teamId: TEAM_1,
  });
  const PM_USER = PM_ORG.acc;
  await engine.serviceRpc(
    "direct_entry_assign_project_manager",
    [OWNER.auth, OWNER.app, PRJ_1, PM_ORG.recruiterId, null, 1, "Assign PM on PRJ_1", `pm1-${nextUuid()}`],
    ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
  );

  const PM_SOLO_ORG = await onboardOrg("pmsolo", deptByKey.RECRUITMENT, "Project Manager Standalone", {
    withRecruiter: true,
    position: "STAFF",
    teamId: TEAM_2,
  });
  const PM_STANDALONE = PM_SOLO_ORG.acc;
  const { rows: soloGroupRows } = await engine.query(
    "select membership_id from public.authz_user_group_members where app_user_id = $1::uuid and ended_at is null",
    [PM_STANDALONE.app],
  );
  for (const row of soloGroupRows) {
    await removeGroup(engine, PM_STANDALONE.app, row.membership_id, "Strip group for pure standalone PM");
  }
  const { rows: [prj1Row] } = await engine.query(
    "select version from public.direct_entry_projects where project_id = $1",
    [PRJ_1],
  );
  await engine.serviceRpc(
    "direct_entry_assign_project_manager",
    [OWNER.auth, OWNER.app, PRJ_1, PM_SOLO_ORG.recruiterId, null, prj1Row.version, "Assign standalone PM on PRJ_1", `pm2-${nextUuid()}`],
    ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
  );

  // 6) Project Accountant (standalone AND paired with ALL-scoped group)
  const PA_SOLO_ORG = await onboardOrg("pasolo", deptByKey.ACCOUNTING, "Project Accountant Standalone");
  const PA_STANDALONE = PA_SOLO_ORG.acc;
  await engine.serviceRpc(
    "vendor_finance_assign_project_accountant_admin",
    [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      PA_STANDALONE.app,
      0,
      null,
      "Assign PA Standalone on PRJ_1",
      nextUuid(),
      computeAssignProjectAccountantFingerprint({
        actor_app_user_id: OWNER.app,
        project_id: PRJ_1,
        accountant_user_id: PA_STANDALONE.app,
        expected_version: 0,
        valid_from: null,
        reason: "Assign PA Standalone on PRJ_1",
      }),
    ],
    ["uuid", "uuid", "text", "uuid", "integer", "date", "text", "uuid", "text"],
  );

  const PA_ALL_ORG = await onboardOrg("paall", deptByKey.ACCOUNTING, "Project Accountant + ALL Group");
  const PA_WITH_ALL_GRP = PA_ALL_ORG.acc;
  await assignGroup(engine, PA_WITH_ALL_GRP.app, CATALOG_GROUP_ID, "Assign ALL-scoped Catalog Group to PA");
  await engine.serviceRpc(
    "vendor_finance_assign_project_accountant_admin",
    [
      OWNER.auth,
      OWNER.app,
      PRJ_3,
      PA_WITH_ALL_GRP.app,
      0,
      null,
      "Assign PA_WITH_ALL_GRP on PRJ_3",
      nextUuid(),
      computeAssignProjectAccountantFingerprint({
        actor_app_user_id: OWNER.app,
        project_id: PRJ_3,
        accountant_user_id: PA_WITH_ALL_GRP.app,
        expected_version: 0,
        valid_from: null,
        reason: "Assign PA_WITH_ALL_GRP on PRJ_3",
      }),
    ],
    ["uuid", "uuid", "text", "uuid", "integer", "date", "text", "uuid", "text"],
  );

  // 7) Scope-only account (scope grant without capability) + empty-cap group account
  const SCOPE_ONLY = await seedAccount(engine, "wp105.scopeonly", "Scope Only Account");
  await engine.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [SCOPE_ONLY.app],
  );
  const EMPTY_CAP_USER = await seedAccount(engine, "wp105.emptycap", "Empty Cap Group Account");
  await assignGroup(engine, EMPTY_CAP_USER.app, EMPTY_CAP_GROUP_ID, "Assign empty cap group");

  // 8) Zero-permission account
  const ZERO_PERM = await seedAccount(engine, "wp105.zero", "Zero Permission Account");

  // 9) Unmigrated legacy account (authz_managed = false)
  const UNMIGRATED_LEGACY = await seedAccount(engine, "wp105.unmig", "Unmigrated Legacy Account", {
    authzManaged: false,
  });
  await engine.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'own', null, '2026-01-01', true),
            ($1::uuid, 'all', null, '2026-01-01', true)`,
    [UNMIGRATED_LEGACY.app],
  );
  for (const cap of ["entry_create", "entry_own", "submission_create", "catalog_master_manage"]) {
    await engine.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [UNMIGRATED_LEGACY.app, cap],
    );
  }

  // 10) Multi-group account
  const MULTI_GROUP = await seedAccount(engine, "wp105.multigrp", "Multi Group Account");
  const multiCatAssign = await assignGroup(engine, MULTI_GROUP.app, CATALOG_GROUP_ID, "Multi: Catalog");
  const multiHrAssign = await assignGroup(engine, MULTI_GROUP.app, groupByCode.HR_CATALOG_OPERATOR, "Multi: HR Op");

  // 11) Disabled -> revoked while disabled -> re-enabled account
  const DISABLE_REVOKE = await seedAccount(engine, "wp105.disrev", "Disable Revoke Account");
  const disCatAssign = await assignGroup(engine, DISABLE_REVOKE.app, CATALOG_GROUP_ID, "DisRev: Catalog");
  await assignGroup(engine, DISABLE_REVOKE.app, groupByCode.HR_CATALOG_OPERATOR, "DisRev: HR Op");

  // Capture BEFORE snapshots for all personas + pre-243 RPC metadata
  const pre243Meta = await inspectActorRpcMeta(engine);
  assert.equal(pre243Meta.acl_service_role, true);
  assert.equal(pre243Meta.acl_public, false);
  assert.equal(pre243Meta.acl_anon, false);
  assert.equal(pre243Meta.acl_authenticated, false);

  const parityPersonas = [
    ["OWNER", OWNER],
    ["CATALOG_ONLY", CATALOG_ONLY],
    ["HR_OP", HR_OP],
    ["TL_USER", TL_USER],
    ["PM_USER", PM_USER],
    ["PM_STANDALONE", PM_STANDALONE],
    ["PA_STANDALONE", PA_STANDALONE],
    ["PA_WITH_ALL_GRP", PA_WITH_ALL_GRP],
    ["ZERO_PERM", ZERO_PERM],
    ["EMPTY_CAP_USER", EMPTY_CAP_USER],
    ["UNMIGRATED_LEGACY", UNMIGRATED_LEGACY],
    ["MULTI_GROUP", MULTI_GROUP],
    ["DISABLE_REVOKE", DISABLE_REVOKE],
  ];
  const allRollbackPersonas = [...parityPersonas, ["SCOPE_ONLY", SCOPE_ONLY]];

  const beforeSnapshots = new Map();
  for (const [label, user] of allRollbackPersonas) {
    const snap = await resolveTsActor(engine, user, atIso);
    const authRes = await createAuthSessionResponse(async () => ({ actor: snap.res }));
    const deRes = await createDirectEntrySessionResponse("true", async () => ({
      actor: snap.res,
      response_headers: {},
    }));
    beforeSnapshots.set(label, {
      ...snap,
      authSession: await authRes.json(),
      directEntrySession: await deRes.json(),
    });
  }

  // Verify pre-243 TL_USER already carries report_review @ CONTEXT_TEAM & effective_report_review_scopes
  {
    const preTl = beforeSnapshots.get("TL_USER").raw;
    assert.ok(
      Array.isArray(preTl.effective_report_review_scopes) && preTl.effective_report_review_scopes.length > 0,
      "PRE-243 TL_USER must carry non-empty effective_report_review_scopes",
    );
    assert.equal(
      preTl.effective_report_review_scopes.some((s) => s.kind === "team" && s.team_id === TEAM_1),
      true,
      "PRE-243 TL_USER effective_report_review_scopes includes TEAM_1",
    );
    assert.equal(
      preTl.effective_grants.some(
        (g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_1,
      ),
      true,
      "PRE-243 TL_USER effective_grants includes report_review @ CONTEXT_TEAM",
    );
  }

  // Also verify SCOPE_ONLY pre-cutover leaked `all_scope_grants` from legacy mirror (demonstrating what WP10-5 fixes!)
  assert.equal(beforeSnapshots.get("SCOPE_ONLY").raw.all_scope_grants.length, 1, "BEFORE 243: legacy reader exposed scope-only row");

  // ---------------------------------------------------------------------------
  // Phase 1: Apply 243 (`20261125220000_wp10_5_actor_context_group_authz_cutover.sql`)
  // ---------------------------------------------------------------------------
  const wp105Sql = await readFile(path.join(MIGRATION_DIR, files[wp105Idx]), "utf8");
  await engine.exec(wp105Sql);
  const post243Meta = await inspectActorRpcMeta(engine);

  // Check 1..9 Before vs After parity
  for (const [label, user] of parityPersonas) {
    const after = await resolveTsActor(engine, user, atIso);
    const before = beforeSnapshots.get(label);
    const expectedAfterAddedCaps = label === "TL_USER" ? ["entry_team"] : [];
    assertActorParity(label, before.raw, after.raw, before.res, after.res, { expectedAfterAddedCaps });
  }

  // Verify Persona 1 (OWNER Full Admin / BoD)
  {
    const { raw, res } = await resolveTsActor(engine, OWNER, atIso);
    assert.equal(res.ok, true);
    assert.equal(hasPairedFullAdmin(res.actor), true);
    assert.equal(hasPairedAllReportingAccess(res.actor), true);
    assert.equal(adminAuthorityNavPredicate(res.actor), true);
    assert.equal(vendorFinanceNavPredicate(res.actor), true);
    assert.equal(decideAccountAccessPageAccess({ actor: res }).toString(), "ALLOW");
    assert.ok(raw.capabilities.includes("entry_admin"));
    assert.equal(raw.all_scope_grants.length, 1);
  }

  // Verify Persona 2 (Catalog-only)
  {
    const { raw, res } = await resolveTsActor(engine, CATALOG_ONLY, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.capabilities, ["catalog_master_manage"]);
    assert.equal(raw.all_scope_grants.length, 1);
    assert.deepEqual(raw.teams, []);
    assert.equal(catalogOperatorNavPredicate(res.actor), true);
    assert.equal(adminAreaNavPredicate(res.actor), true);
    assert.equal(adminSecurityNavPredicate(res.actor), false);
    assert.equal(vendorFinanceNavPredicate(res.actor), false);
    assert.equal(directEntryNavPredicate(res.actor), false);
    assert.equal(decideAdminAreaAccess({ actor: res }), "ALLOW");
    assert.equal(decideAccountAccessPageAccess({ actor: res }), "ACCESS_DENIED");
    assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: res }), "ACCESS_DENIED");
  }

  // Verify Persona 3 (HR Operator)
  {
    const { raw, res } = await resolveTsActor(engine, HR_OP, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.capabilities, [
      "audit_view",
      "catalog_master_manage",
      "document_view",
      "recruiter_master_manage",
      "team_master_manage",
    ]);
    assert.equal(raw.all_scope_grants.length, 1);
    assert.equal(raw.assigned_roles.some((r) => r.role_code === "HR_OPERATOR"), true);
    assert.equal(adminAreaNavPredicate(res.actor), true);
    assert.equal(adminSecurityNavPredicate(res.actor), false);
    assert.equal(vendorFinanceNavPredicate(res.actor), false);
  }

  // Verify Persona 4 (Team Leader)
  {
    const { raw, res } = await resolveTsActor(engine, TL_USER, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.teams.map((t) => t.team_id), [TEAM_1]);
    assert.deepEqual(raw.team_scope_grants.map((g) => g.team_id), [TEAM_1]);
    assert.deepEqual(raw.all_scope_grants, []);
    assert.ok(raw.capabilities.includes("team_manager_assign"));
    assert.ok(
      Array.isArray(raw.effective_report_review_scopes) && raw.effective_report_review_scopes.length > 0,
      "TL_USER must retain non-empty effective_report_review_scopes post-243",
    );
    assert.equal(
      raw.effective_report_review_scopes.some((s) => s.kind === "team" && s.team_id === TEAM_1),
      true,
    );
    assert.equal(
      raw.effective_grants.some(
        (g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_1,
      ),
      true,
    );
    assert.ok(raw.allowed_worker_tabs.includes("team"));
    assert.equal(raw.allowed_worker_tabs.includes("all"), false);
    assert.equal(raw.assigned_roles.some((r) => r.role_code === "TEAM_LEADER" && r.scope_id === TEAM_1), true);
    assert.equal(projectAdminNavPredicate(res.actor), true);
    assert.equal(workerOperationsTeamScopePredicate(res.actor), true);
    assert.equal(decideAttendanceReportPageAccess({ actor: res }), "ALLOW");
    assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true, actor: res }), "ALLOW");
    assert.equal(vendorFinanceNavPredicate(res.actor), false);
  }

  // Verify Persona 5 (Project Manager — both ops and standalone)
  {
    const { raw: pmRaw, res: pmRes } = await resolveTsActor(engine, PM_USER, atIso);
    assert.equal(pmRes.ok, true);
    assert.ok(pmRaw.allowed_worker_tabs.includes("managed"));
    assert.ok(pmRaw.allowed_worker_tabs.includes("uploader"));
    assert.equal(pmRaw.assigned_roles.some((r) => r.role_code === "PROJECT_MANAGER" && r.scope_id === PRJ_1), true);
    assert.equal(workerOperationsNavPredicate(pmRes.actor), true);
    assert.equal(vendorFinanceNavPredicate(pmRes.actor), false);

    const { raw: soloRaw, res: soloRes } = await resolveTsActor(engine, PM_STANDALONE, atIso);
    assert.equal(soloRes.ok, true);
    assert.deepEqual(soloRaw.capabilities, []);
    assert.deepEqual(soloRaw.all_scope_grants, []);
    assert.deepEqual(soloRaw.allowed_worker_tabs, ["uploader", "recruited", "managed"]);
    assert.equal(soloRaw.assigned_roles.some((r) => r.role_code === "PROJECT_MANAGER" && r.scope_id === PRJ_1), true);
    assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: soloRes }), "ALLOW");
    assert.equal(vendorFinanceNavPredicate(soloRes.actor), false);
  }

  // Verify Persona 6 (Project Accountant: standalone AND paired with ALL-scoped group)
  for (const [label, paUser, assignedPrj, deniedPrj, expectedCaps, expectedAllCount] of [
    ["PA_STANDALONE", PA_STANDALONE, PRJ_1, PRJ_3, [], 0],
    ["PA_WITH_ALL_GRP", PA_WITH_ALL_GRP, PRJ_3, PRJ_1, ["catalog_master_manage"], 1],
  ]) {
    const { raw, res } = await resolveTsActor(engine, paUser, atIso);
    assert.equal(res.ok, true, `${label}: TS resolveActor ok`);
    assert.deepEqual(raw.capabilities, expectedCaps, `${label}: zero vendor_finance_view leak in capabilities`);
    assert.equal(raw.capabilities.includes("vendor_finance_view"), false, `${label}: capabilities MUST exclude vendor_finance_view`);
    assert.equal(raw.capabilities.includes("vendor_finance_record"), false, `${label}: capabilities MUST exclude vendor_finance_record`);
    assert.equal(raw.all_scope_grants.length, expectedAllCount, `${label}: expected all_scope_grants count`);
    assert.equal(
      raw.effective_grants.some(
        (g) => g.capability === "vendor_finance_view" && g.scope_kind === "CONTEXT_PROJECT" && g.scope_id === assignedPrj,
      ),
      true,
      `${label}: effective_grants retains CONTEXT_PROJECT:${assignedPrj}`,
    );
    assert.equal(
      raw.effective_grants.some((g) => g.capability === "vendor_finance_view" && g.scope_kind === "ALL"),
      false,
      `${label}: effective_grants MUST NOT contain vendor_finance_view @ ALL`,
    );
    assert.equal(
      raw.assigned_roles.some((r) => r.role_code === "PROJECT_ACCOUNTANT" && r.scope_id === assignedPrj),
      true,
      `${label}: assigned_roles includes PROJECT_ACCOUNTANT @ ${assignedPrj}`,
    );

    // TS session & nav checks: ZERO /finance leak!
    assert.deepEqual(projectClientCapabilities(res.actor), expectedCaps, `${label}: client capabilities exclude VFIN`);
    assert.equal(vendorFinanceNavPredicate(res.actor), false, `${label}: vendorFinanceNavPredicate MUST be false`);
    assert.equal(vendorFinanceRecordNavPredicate(res.actor), false, `${label}: vendorFinanceRecordNavPredicate MUST be false`);

    const sessionRes = await createDirectEntrySessionResponse("true", async () => ({
      actor: res,
      response_headers: {},
    }));
    const sessionBody = await sessionRes.json();
    assert.equal(sessionBody.ok, true);
    assert.equal(sessionBody.actor.capabilities.includes("vendor_finance_view"), false, `${label}: session bootstrap excludes VFIN`);

    const authRes = await createAuthSessionResponse(async () => ({ actor: res }));
    const authBody = await authRes.json();
    assert.equal(authBody.ok, true);
    assert.equal(authBody.actor.capabilities.includes("vendor_finance_view"), false, `${label}: /api/auth/session excludes VFIN`);

    // Real DB VFIN RPCs: ONLY assigned project accessible; unassigned projects denied (42501)!
    const vfinAccess = await engine.serviceRpc("vendor_finance_get_actor_access", [paUser.auth, paUser.app], ["uuid", "uuid"]);
    assert.equal(vfinAccess.can_view, true);
    assert.equal(vfinAccess.visibility_scope, "PROJECT_SCOPED", `${label}: VFIN visibility restricted to PROJECT_SCOPED`);
    assert.equal(vfinAccess.record_scope, "ASSIGNED_PROJECTS", `${label}: VFIN record_scope restricted to ASSIGNED_PROJECTS`);
    assert.equal(vfinAccess.reconcile_scope, "ASSIGNED_PROJECTS", `${label}: VFIN reconcile_scope restricted to ASSIGNED_PROJECTS`);
    assert.equal(vfinAccess.authority_source, "accounting_department");
    assert.equal(vfinAccess.can_fund_vendor_advance, false);
    assert.equal(vfinAccess.can_manage_project_assignments, false);
    assert.equal(vfinAccess.active_assigned_project_count, 1);

    const ctxOpts = await engine.serviceRpc("vendor_finance_list_actor_context_options", [paUser.auth, paUser.app], ["uuid", "uuid"]);
    assert.deepEqual(ctxOpts.projects.map((p) => p.project_id), [assignedPrj], `${label}: actor context options only include ${assignedPrj}`);

    const prjAssignedList = await engine.serviceRpc(
      "vendor_finance_list_vendors",
      [paUser.auth, paUser.app, null, "all", "all", assignedPrj, null, "all", "all", 1, 25],
      ["uuid", "uuid", "text", "text", "text", "text", "uuid", "text", "text", "integer", "integer"],
    );
    assert.ok(Array.isArray(prjAssignedList.vendors), `${label}: ${assignedPrj} list succeeds`);

    for (const forbiddenPrj of [PRJ_2, deniedPrj]) {
      await assert.rejects(
        () =>
          engine.serviceRpc(
            "vendor_finance_list_vendors",
            [paUser.auth, paUser.app, null, "all", "all", forbiddenPrj, null, "all", "all", 1, 25],
            ["uuid", "uuid", "text", "text", "text", "text", "uuid", "text", "text", "integer", "integer"],
          ),
        (err) => err?.code === "42501",
        `${label}: unassigned ${forbiddenPrj} MUST be rejected with 42501`,
      );
    }
  }

  // Verify Persona 7 (Scope-only & Empty-cap group -> zero capabilities, zero scopes)
  for (const [label, user] of [
    ["SCOPE_ONLY", SCOPE_ONLY],
    ["EMPTY_CAP_USER", EMPTY_CAP_USER],
  ]) {
    const { raw, res } = await resolveTsActor(engine, user, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.capabilities, [], `${label}: capabilities empty`);
    assert.deepEqual(raw.teams, [], `${label}: teams empty`);
    assert.deepEqual(raw.team_scope_grants, [], `${label}: team_scope_grants empty`);
    assert.deepEqual(raw.all_scope_grants, [], `${label}: all_scope_grants empty`);
    assert.deepEqual(raw.effective_grants, [], `${label}: effective_grants empty`);
    assert.deepEqual(raw.allowed_worker_tabs, [], `${label}: allowed_worker_tabs empty`);
  }

  // Verify Persona 8 (Zero-permission)
  {
    const { raw, res } = await resolveTsActor(engine, ZERO_PERM, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.capabilities, []);
    assert.deepEqual(raw.teams, []);
    assert.deepEqual(raw.team_scope_grants, []);
    assert.deepEqual(raw.all_scope_grants, []);
    assert.deepEqual(raw.effective_grants, []);
    assert.deepEqual(raw.assigned_roles, []);
    assert.deepEqual(raw.allowed_worker_tabs, []);
    assert.equal(adminAreaNavPredicate(res.actor), false);
    assert.equal(directEntryNavPredicate(res.actor), false);
    assert.equal(vendorFinanceNavPredicate(res.actor), false);
    assert.equal(workerOperationsNavPredicate(res.actor), false);
  }

  // Verify Persona 9 (Unmigrated authz_managed = false continues resolving via legacy branch)
  {
    const { raw, res } = await resolveTsActor(engine, UNMIGRATED_LEGACY, atIso);
    assert.equal(res.ok, true);
    assert.deepEqual(raw.capabilities, ["catalog_master_manage", "entry_create", "entry_own", "submission_create"]);
    assert.equal(raw.all_scope_grants.length, 1);
    assert.equal(catalogOperatorNavPredicate(res.actor), true);
    assert.equal(directEntryNavPredicate(res.actor), true);
  }

  // Session-response `valid_from`/`valid_to` metadata assertions (post-243)
  {
    const { rows: [authDateRow] } = await engine.query(
      "select public.direct_entry_authorization_date()::text as auth_date",
    );
    const authDate = authDateRow.auth_date;
    assert.equal(authDate, todayStr);

    await assertSessionScopeMetadata("TL_USER", (await resolveTsActor(engine, TL_USER, atIso)).res, {
      expectedTeamIds: [TEAM_1],
      expectedTeamValidFrom: authDate,
      expectedAllValidFrom: null,
    });
    for (const [label, user] of [
      ["OWNER", OWNER],
      ["CATALOG_ONLY", CATALOG_ONLY],
      ["HR_OP", HR_OP],
      ["PA_WITH_ALL_GRP", PA_WITH_ALL_GRP],
    ]) {
      await assertSessionScopeMetadata(label, (await resolveTsActor(engine, user, atIso)).res, {
        expectedTeamIds: [],
        expectedAllValidFrom: authDate,
      });
    }
    await assertSessionScopeMetadata("UNMIGRATED_LEGACY", (await resolveTsActor(engine, UNMIGRATED_LEGACY, atIso)).res, {
      expectedTeamIds: [],
      expectedAllValidFrom: "2026-01-01",
    });
  }

  // ---------------------------------------------------------------------------
  // Phase 1b: Isolated RPC-Only Rollback Rehearsal (BEFORE Personas 10/11/12)
  // Restores ONLY pre-243 `direct_entry_resolve_actor_context(uuid)` + owner + ACL,
  // verifies exact pre-243 behavior & zero table/grant edits, then re-applies #243.
  // ---------------------------------------------------------------------------
  {
    const preRollbackTables = await snapshotRollbackProtectedTables(engine);
    const ownerIdent = `"${pre243Meta.proowner_name.replaceAll('"', '""')}"`;

    await engine.exec(`
      begin;
      ${pre243Meta.fn_def};
      alter function public.direct_entry_resolve_actor_context(uuid) owner to ${ownerIdent};
      revoke all on function public.direct_entry_resolve_actor_context(uuid) from public, anon, authenticated, service_role;
      grant execute on function public.direct_entry_resolve_actor_context(uuid) to service_role;
      commit;
    `);

    const restoredMeta = await inspectActorRpcMeta(engine);
    assert.deepEqual(restoredMeta, pre243Meta, "RPC-only rollback restores exact function def, owner, security, volatility, search_path, and ACL");

    for (const [label, user] of allRollbackPersonas) {
      const rolledBackCtx = await resolveActorContext(engine, user);
      assert.deepEqual(
        rolledBackCtx,
        beforeSnapshots.get(label).raw,
        `RPC-only rollback (${label}): direct_entry_resolve_actor_context matches pre-243 baseline`,
      );
    }

    const postRollbackTables = await snapshotRollbackProtectedTables(engine);
    assert.deepEqual(
      postRollbackTables,
      preRollbackTables,
      "RPC-only rollback must leave 0 row changes across app_users, group_members, TL, PA, PM, and dept_heads",
    );

    // Re-apply migration #243 cleanly before running Personas 10, 11, and 12
    await engine.exec(wp105Sql);
    const reappliedMeta = await inspectActorRpcMeta(engine);
    assert.deepEqual(reappliedMeta, post243Meta, "Re-applying migration #243 restores exact post-243 RPC metadata");
  }

  // Verify Persona 10 (Multi-group: grant 2 groups, revoke 1 -> revoked rights gone, remaining intact)
  {
    const beforeRevoke = await resolveActorContext(engine, MULTI_GROUP);
    assert.deepEqual(beforeRevoke.capabilities, [
      "audit_view",
      "catalog_master_manage",
      "document_view",
      "recruiter_master_manage",
      "team_master_manage",
    ]);
    assert.equal(beforeRevoke.all_scope_grants.length, 1);

    await removeGroup(engine, MULTI_GROUP.app, multiHrAssign.membership_id, "Revoke HR_CATALOG_OPERATOR from Multi");
    const afterRevoke = await resolveActorContext(engine, MULTI_GROUP);
    assert.deepEqual(afterRevoke.capabilities, ["catalog_master_manage"]);
    assert.equal(afterRevoke.all_scope_grants.length, 1, "remaining CATALOG_ONLY group preserves ALL scope");
    assert.deepEqual(afterRevoke.assigned_roles, [], "revoked HR_OPERATOR role removed");
    assert.ok(multiCatAssign.membership_id);

    // Multi team-group test: grant TEAM_2_OPS_GRP + TEAM_1 TL/group, then revoke TEAM_2_OPS_GRP
    const multiTeamUser = await seedAccount(engine, "wp105.multiteam", "Multi Team Group User");
    const team1GroupCreate = await engine.serviceRpc(
      "direct_entry_authz_create_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        "TEAM_1_OPS_WP105",
        "Nhóm Đội 1 WP10-5",
        "Theo dõi tuyển dụng Đội 1",
        deptByKey.RECRUITMENT,
        TEAM_1,
        ["entry_team"],
        JSON.stringify([]),
        "Tạo nhóm đội 1 WP10-5",
        nextUuid(),
        sha256("TEAM_1_OPS_WP105"),
      ],
      ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
    );
    await assignGroup(engine, multiTeamUser.app, team1GroupCreate.group_id, "Assign Team 1 group");
    const t2Mem = await assignGroup(engine, multiTeamUser.app, TEAM2_GROUP_ID, "Assign Team 2 group");

    const mtBoth = await resolveActorContext(engine, multiTeamUser);
    assert.deepEqual(mtBoth.teams.map((t) => t.team_id).sort(), [TEAM_1, TEAM_2].sort());
    assert.deepEqual(mtBoth.capabilities, ["entry_team", "report_view"]);

    await removeGroup(engine, multiTeamUser.app, t2Mem.membership_id, "Revoke Team 2 group");
    const mtOnly1 = await resolveActorContext(engine, multiTeamUser);
    assert.deepEqual(mtOnly1.teams.map((t) => t.team_id), [TEAM_1], "TEAM_2 removed, TEAM_1 intact");
    assert.deepEqual(mtOnly1.capabilities, ["entry_team"], "report_view from TEAM_2 gone, entry_team from TEAM_1 intact");
  }

  // Verify Persona 11 (Disabled -> revoked while disabled -> re-enabled -> revoked rights NEVER resurrect!)
  {
    await setAccountEnabled(engine, DISABLE_REVOKE.app, false, "Disable before revoking Catalog group");
    const disabledCtx = await resolveActorContext(engine, DISABLE_REVOKE);
    assert.equal(disabledCtx.enabled, false);
    assert.deepEqual(disabledCtx.capabilities, []);
    assert.deepEqual(disabledCtx.recruiter_links, []);
    assert.deepEqual(disabledCtx.teams, []);
    assert.deepEqual(disabledCtx.team_scope_grants, []);
    assert.deepEqual(disabledCtx.all_scope_grants, []);
    assert.deepEqual(disabledCtx.allowed_worker_tabs, []);
    assert.deepEqual(disabledCtx.effective_grants, []);
    assert.deepEqual(disabledCtx.assigned_roles, []);
    assert.equal("effective_report_review_scopes" in disabledCtx, false);

    const { res: disabledTs } = await resolveTsActor(engine, DISABLE_REVOKE, atIso);
    assert.equal(disabledTs.ok, false);
    if (!disabledTs.ok) assert.equal(disabledTs.reason, "ACTOR_DISABLED");

    // Revoke CATALOG_ONLY_GRP while account is disabled
    await removeGroup(engine, DISABLE_REVOKE.app, disCatAssign.membership_id, "Revoke Catalog group while disabled");

    // Even if a stale suspended legacy mirror row existed for catalog_master_manage, re-enabling MUST NOT resurrect it
    await setAccountEnabled(engine, DISABLE_REVOKE.app, true, "Re-enable after revoking while disabled");
    const reenabledCtx = await resolveActorContext(engine, DISABLE_REVOKE);
    assert.equal(reenabledCtx.enabled, true);
    assert.equal(
      reenabledCtx.capabilities.includes("catalog_master_manage"),
      true,
      "HR_CATALOG_OPERATOR also carries catalog_master_manage; check group provenance",
    );
    assert.equal(
      reenabledCtx.effective_grants.some((g) => g.source_id === disCatAssign.membership_id),
      false,
      "Revoked membership MUST NEVER resurrect on re-enable",
    );

    // Repeat with disjoint capability: assign TEAM2_GROUP_ID (`entry_team`, `report_view`), disable, revoke TEAM2_GROUP_ID, re-enable
    const disTeamAssign = await assignGroup(engine, DISABLE_REVOKE.app, TEAM2_GROUP_ID, "Assign Team 2 for disable-revoke");
    await setAccountEnabled(engine, DISABLE_REVOKE.app, false, "Disable before revoking Team 2");
    await removeGroup(engine, DISABLE_REVOKE.app, disTeamAssign.membership_id, "Revoke Team 2 while disabled");
    await setAccountEnabled(engine, DISABLE_REVOKE.app, true, "Re-enable after Team 2 revoke");
    const afterTeamRevoke = await resolveActorContext(engine, DISABLE_REVOKE);
    assert.equal(afterTeamRevoke.capabilities.includes("entry_team"), false, "entry_team MUST NOT resurrect");
    assert.equal(afterTeamRevoke.capabilities.includes("report_view"), false, "report_view MUST NOT resurrect");
    assert.deepEqual(afterTeamRevoke.teams, [], "TEAM_2 MUST NOT resurrect");
    assert.equal(afterTeamRevoke.assigned_roles.some((r) => r.role_code === "HR_OPERATOR"), true, "non-revoked HR_OPERATOR intact");
  }

  // Verify Persona 12 (Mirror-independence proof: delete AND poison legacy mirror tables for authz_managed = true)
  {
    const targets = [OWNER, CATALOG_ONLY, HR_OP, TL_USER, PA_WITH_ALL_GRP, ZERO_PERM];
    const baselineBeforePoison = new Map();
    for (const u of targets) {
      baselineBeforePoison.set(u.app, await resolveActorContext(engine, u));
    }

    // 12a. Delete ALL legacy mirror rows for authz_managed = true accounts
    const appIds = targets.map((u) => u.app);
    await engine.query(
      "delete from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])",
      [appIds],
    );
    await engine.query(
      "delete from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])",
      [appIds],
    );

    for (const u of targets) {
      const afterDelete = await resolveActorContext(engine, u);
      assert.deepEqual(
        afterDelete,
        baselineBeforePoison.get(u.app),
        `Mirror-independence (DELETE): ${u.name} MUST be identical with 0 legacy mirror rows`,
      );
    }

    // 12b. Insert divergent / escalated legacy mirror rows (e.g. entry_admin + vendor_finance_record + all + TEAM_2)
    for (const u of [CATALOG_ONLY, PA_WITH_ALL_GRP, ZERO_PERM, TL_USER]) {
      await engine.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'all', null, '2026-01-01', true)
         on conflict do nothing`,
        [u.app],
      );
      await engine.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)
         on conflict do nothing`,
        [u.app, TEAM_2],
      );
      for (const bogusCap of ["entry_admin", "vendor_finance_record", "vendor_finance_view", "entry_restore"]) {
        await engine.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2026-01-01', true)
           on conflict do nothing`,
          [u.app, bogusCap],
        );
      }
    }

    for (const u of targets) {
      const afterPoison = await resolveActorContext(engine, u);
      assert.deepEqual(
        afterPoison,
        baselineBeforePoison.get(u.app),
        `Mirror-independence (POISON): ${u.name} MUST ignore bogus legacy mirror rows`,
      );
    }

    // Verify legacy tables remain intact on schema
    const { rows: [tbls] } = await engine.query(`
      select to_regclass('public.direct_entry_capability_grants')::text as cg,
             to_regclass('public.direct_entry_scope_grants')::text as sg
    `);
    assert.equal(tbls.cg, "direct_entry_capability_grants");
    assert.equal(tbls.sg, "direct_entry_scope_grants");
  }
}

test("WP10-5 #1 (PGlite): Migration #243 hygiene, atomic rollback zero drift, and S0-T1-C RPC ACL postconditions", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP10_5_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("\r\n"), false, "WP10-5 migration must use LF line endings");
  assert.equal(sql.replace(/--[^\n]*/g, "").includes("@"), false, "WP10-5 SQL statements must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(sql), false, "WP10-5 migration must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(sql), false, "WP10-5 migration must contain zero '40001'");
  assert.equal(/alter default privileges/i.test(sql), false, "WP10-5 migration must contain zero ALTER DEFAULT PRIVILEGES");

  const engine = await createPgliteEngine();
  try {
    await engine.exec(ROLE_PREAMBLE);
    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const wp105Idx = files.indexOf(WP10_5_MIGRATION_NAME);
    assert.ok(wp105Idx > 0, "WP10-5 migration must exist");
    const preApplied = files.slice(0, wp105Idx);
    for (const name of preApplied) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(preApplied.map((n) => [n, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);

    const { rows: [preSrc] } = await engine.query(
      "select pg_get_functiondef('public.direct_entry_resolve_actor_context(uuid)'::regprocedure) as def",
    );

    // Atomic rollback leaves zero drift
    const stripped = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await engine.exec("begin;");
    await engine.exec(stripped);
    await engine.exec("rollback;");

    const { rows: [afterRollbackSrc] } = await engine.query(
      "select pg_get_functiondef('public.direct_entry_resolve_actor_context(uuid)'::regprocedure) as def",
    );
    assert.equal(afterRollbackSrc.def, preSrc.def, "atomic rollback must leave direct_entry_resolve_actor_context unchanged");

    // Apply migration cleanly
    await engine.exec(sql);
    const postFlags = new Map([...preFlags, [WP10_5_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(postCheck.details.actualServiceCount, preCheck.details.actualServiceCount, "exact +0 net service_role RPCs");
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "zero client/PUBLIC EXECUTE grants");

    const { rows: [procInfo] } = await engine.query(`
      select p.prosecdef, p.provolatile, p.proconfig
        from pg_catalog.pg_proc p
       where p.oid = 'public.direct_entry_resolve_actor_context(uuid)'::regprocedure
    `);
    assert.equal(procInfo.prosecdef, true);
    assert.equal(procInfo.provolatile, "s");
    assert.ok(procInfo.proconfig.includes("search_path=pg_catalog, public"));
  } finally {
    await engine.close();
  }
});

test("WP10-5 #2 (PGlite): Before vs After cutover matrix across all 13 personas & security invariants", async () => {
  const engine = await createPgliteEngine();
  try {
    await runWp105CutoverMatrix(engine);
  } finally {
    await engine.close();
  }
});

test("WP10-5 #3 (Real PostgreSQL 18): Before vs After cutover matrix across all 13 personas & security invariants", async () => {
  const engine = await createPg18Engine();
  try {
    console.log(`[WP10-5] Running real DB cutover suite on engine: ${engine.name}`);
    await runWp105CutoverMatrix(engine);
  } finally {
    await engine.close();
  }
});
