/**
 * WP13 PR-0 Backend — PGlite End-to-End Verification Suite.
 *
 * Covers:
 *   1. Migration hygiene & relative dependency order: 0 `@`, 0 literal `SAVEPOINT`, 0 `'40001'`,
 *      0 `ALTER DEFAULT PRIVILEGES`, LF checksum, atomic rollback zero drift, dynamic S0-T1-C
 *      allowlist postconditions (+2 net service_role RPCs relative to applied prefix), 0 client/
 *      PUBLIC exposure, exact single pg_proc signature per touched routine (zero ambiguous overload),
 *      and legacy 2-arg / 6-arg call compatibility.
 *   2. GAP-BE-03 (Accounts server-side filter before pagination):
 *      - Full HTTP handler (`listAccounts`) + repository (`createAccountAccessRepository`) +
 *        real PGlite named-arg SQL RPC execution across `account_type` (all/NORMAL/SHARED/SERVICE/
 *        SPECIAL), `link_state` (all/linked/unlinked), `enabled`, and `search`.
 *      - Deterministic multi-page pagination (`page=1`, `page=2+`) with tie-breaker `app_user_id`,
 *        exact `total`, 0 duplicates, 0 missing rows, exact 6 response keys.
 *      - Ended historical `organization_account_person_links` (`ended_at IS NOT NULL`) classified
 *        as `unlinked`, never `linked`.
 *      - Invalid/malformed SQL & HTTP params (`22023` / `400 ACCOUNT_INVALID`), RBAC & disabled actor.
 *   3. GAP-BE-06 (Personnel server-side `team_id` filter before pagination):
 *      - Full HTTP handler (`listPersonnelCatalog`) + repository (`createPersonnelCatalogRepository`)
 *        + real PGlite named-arg SQL RPC execution.
 *      - Multi-page pagination (`page=1`, `page=2+`), exact `total`, exact 7 response keys.
 *      - Historical team membership (`is_current = false`) excluded; vendor excluded; inactive
 *        non-vendor team still queryable; `__system_vendor__` & unknown UUID -> `P0002` / `404`.
 *      - Invalid UUID -> `400 PERSONNEL_INVALID`; RBAC (`HR_OPERATOR` / Full Admin allowed; plain
 *        `RECRUITER` & disabled actor denied `42501` before team existence probing).
 *   4. GAP-BE-04 Part 1 (Optional `p_reason` restored on exact 3 RPCs):
 *      - `direct_entry_create_team`, `direct_entry_update_personnel`, and
 *        `direct_entry_account_operation_update_display_name` accept `null`, `""`, `"   "`, valid
 *        text, and reject `> 4000` chars (`22023`), without creating placeholder rows in
 *        `direct_entry_restricted_reasons` (`reason_id IS NULL`).
 *      - Verified on BOTH unlinked AND Person-linked accounts/recruiters (including sync to
 *        `organization_persons` and secondary `organization_department_audit_events` with null,
 *        empty, trailing-space-at-500, and control-char reasons).
 *      - Idempotency replay, payload mismatch (`22023`), OCC (`PT409`), RBAC (`42501`), and
 *        negative boundary proof that `org_department_*` RPCs still require reason (`22023`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  S0_T1_C_MIGRATION_NAME,
  WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME,
  WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME,
  WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { listAccounts } from "../src/lib/direct-entry/app-user-access-api.ts";
import { createAccountAccessRepository } from "../src/lib/direct-entry/app-user-access-repository.ts";
import { listPersonnelCatalog } from "../src/lib/direct-entry/personnel-catalog-api.ts";
import { createPersonnelCatalogRepository } from "../src/lib/direct-entry/personnel-catalog-repository.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP9_MIGRATION_NAME = "20261121090000_wp9_org_obligations.sql";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "13000000-0000-4000-8000-000000000001",
  app: "23000000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "13000000-0000-4000-8000-000000000091",
  app: "23000000-0000-4000-8000-000000000091",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "13000000-0000-4000-8000-000000000092",
  app: "23000000-0000-4000-8000-000000000092",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "13000000-0000-4000-8000-000000000093",
  app: "23000000-0000-4000-8000-000000000093",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "13000000-0000-4000-8000-000000000002",
  app: "23000000-0000-4000-8000-000000000002",
  email: "hr.operator@hrpartner.vn",
  name: "HR Operator Only",
};
const REC_ACTOR = {
  auth: "13000000-0000-4000-8000-000000000003",
  app: "23000000-0000-4000-8000-000000000003",
  email: "plain.rec@hrpartner.vn",
  name: "Plain Recruiter",
};
const DISABLED_ADMIN = {
  auth: "13000000-0000-4000-8000-000000000004",
  app: "23000000-0000-4000-8000-000000000004",
  email: "disabled.admin@hrpartner.vn",
  name: "Disabled Admin",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `93000000-0000-4000-8000-${hex}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

let cachedMigrations = null;
async function loadMigrations() {
  if (cachedMigrations) return cachedMigrations;
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  cachedMigrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
      return { name, sql, checksum: migrationChecksum(sql) };
    }),
  );
  return cachedMigrations;
}

async function applyPrefix(db, migrations, endExclusive) {
  for (let i = 0; i < endExclusive; i += 1) {
    await db.exec(migrations[i].sql);
  }
}

async function serviceQuery(db, sql, params = []) {
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const res = await db.query(sql, params);
    await db.exec("commit");
    return res;
  } catch (error) {
    await db.exec("rollback").catch(() => {});
    throw error;
  }
}

async function expectServiceError(db, sql, params, expectedCode, messagePattern) {
  await assert.rejects(
    () => serviceQuery(db, sql, params),
    (error) => {
      assert.equal(error?.code, expectedCode, `expected SQLSTATE ${expectedCode}, got ${error?.code}: ${error?.message}`);
      if (messagePattern) {
        assert.match(String(error?.message ?? ""), messagePattern);
      }
      return true;
    },
  );
}

/**
 * PostgREST-faithful named-argument RPC adapter backed by real PGlite SQL under `service_role`.
 */
const RPC_PARAM_TYPES = {
  direct_entry_list_app_users_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_search: "text",
    p_enabled: "text",
    p_page: "integer",
    p_page_size: "integer",
  },
  direct_entry_list_app_users_filtered_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_search: "text",
    p_enabled: "text",
    p_page: "integer",
    p_page_size: "integer",
    p_account_type: "text",
    p_link_state: "text",
  },
  direct_entry_list_personnel_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_search: "text",
    p_include_inactive: "boolean",
    p_page: "integer",
    p_page_size: "integer",
  },
  direct_entry_list_personnel_filtered_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_search: "text",
    p_include_inactive: "boolean",
    p_page: "integer",
    p_page_size: "integer",
    p_team_id: "uuid",
  },
};

function createPgliteNamedRpc(db, trace = []) {
  return async (name, args) => {
    trace.push([name, args]);
    const paramMap = RPC_PARAM_TYPES[name];
    assert.ok(paramMap, `unexpected RPC call: ${name}`);
    const entries = Object.entries(args);
    const placeholders = entries.map(([key], idx) => {
      const sqlType = paramMap[key];
      assert.ok(sqlType, `unexpected arg ${key} for ${name}`);
      return `${key} => $${idx + 1}::${sqlType}`;
    });
    const values = entries.map(([, val]) => val);
    try {
      const res = await serviceQuery(
        db,
        `select public.${name}(${placeholders.join(", ")}) as payload`,
        values,
      );
      return { data: res.rows[0]?.payload ?? null, error: null };
    } catch (error) {
      return { data: null, error: { code: error?.code, message: error?.message } };
    }
  };
}

function sessionFor(actor) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: actor.auth,
        app_user_id: actor.app,
        display_name: actor.name,
        enabled: true,
        capabilities: [],
        scopes: [],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
      },
    },
  });
}

async function seedUser(db, user, { enabled = true, accountType = "NORMAL" } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
    user.auth,
    user.email,
  ]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, account_type)
     values ($1, $2, $3, $4, $5)
     on conflict (app_user_id) do nothing`,
    [user.app, user.auth, enabled, user.name, accountType],
  );
}

async function grantLegacyAdmin(db, appUserId) {
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2020-01-01', true), ($1, 'own', null, '2020-01-01', true)",
    [appUserId],
  );
  for (const cap of [
    "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
    "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
    "audit_view", "worker_edit_history_view", "document_upload", "document_view",
    "employment_status.review", "employment_status.apply", "change_request_create",
    "change_review", "employment_status.request", "duplicate_cccd_withdraw",
  ]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
      [appUserId, cap],
    );
  }
}

async function bootCutoverDb() {
  const migrations = await loadMigrations();
  const db = new PGlite();
  await db.exec(ROLE_PREAMBLE);
  await applyPrefix(db, migrations, migrations.length);

  for (const u of [OWNER, LUANPT, LIENVU, NGATTT, HR_OP, REC_ACTOR]) {
    await seedUser(db, u);
  }
  await seedUser(db, DISABLED_ADMIN, { enabled: false });
  for (const adm of [OWNER, LIENVU, NGATTT, DISABLED_ADMIN]) {
    await grantLegacyAdmin(db, adm.app);
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2020-01-01', true)",
    [LUANPT.app],
  );

  // Run canonical WP5 cutover so OWNER gets ADMIN role
  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  // Assign HR_OPERATOR to HR_OP and RECRUITER to REC_ACTOR
  const hrRes = await serviceQuery(
    db,
    `select public.direct_entry_authz_assign_global_role_admin(
       $1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'WP13 test HR_OP', $4::uuid, $5::text
     )`,
    [OWNER.auth, OWNER.app, HR_OP.app, nextUuid(), sha256("wp13-seed-hr")],
  );
  assert.ok(hrRes.rows.length === 1);

  const recRes = await serviceQuery(
    db,
    `select public.direct_entry_authz_assign_global_role_admin(
       $1::uuid, $2::uuid, $3::uuid, 'RECRUITER', 1, 'WP13 test REC_ACTOR', $4::uuid, $5::text
     )`,
    [OWNER.auth, OWNER.app, REC_ACTOR.app, nextUuid(), sha256("wp13-seed-rec")],
  );
  assert.ok(recRes.rows.length === 1);

  return db;
}

test("1. Migration hygiene, dynamic S0-T1-C allowlist (+2 net), atomic rollback, zero overload drift, legacy compatibility", async () => {
  const migrations = await loadMigrations();
  const wp3bIdx = migrations.findIndex((m) => m.name === WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME);
  const wp9Idx = migrations.findIndex((m) => m.name === WP9_MIGRATION_NAME);
  const wp13Idx = migrations.findIndex((m) => m.name === WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME);
  const s0Migration = migrations.find((m) => m.name === S0_T1_C_MIGRATION_NAME);

  assert.ok(wp3bIdx >= 0 && wp9Idx >= 0 && wp13Idx >= 0, "dependency migrations exist");
  assert.ok(wp13Idx > wp3bIdx && wp13Idx > wp9Idx, "WP13 PR-0 migration is ordered strictly after WP3B and WP9");

  const wp13 = migrations[wp13Idx];
  assert.equal(wp13.sql.includes("@"), false, "WP13 PR-0 migration contains 0 literal '@' characters");
  assert.equal(/\bsavepoint\b/i.test(wp13.sql), false, "WP13 PR-0 migration contains 0 SAVEPOINT statements");
  assert.equal(wp13.sql.includes("'40001'"), false, "WP13 PR-0 migration contains 0 literal '40001' SQLSTATE");
  assert.equal(/\balter\s+default\s+privileges\b/i.test(wp13.sql), false, "WP13 PR-0 migration contains 0 ALTER DEFAULT PRIVILEGES");
  assert.equal(wp13.checksum, migrationChecksum(wp13.sql.replace(/\n/g, "\r\n")), "LF/CRLF checksum invariance");
  assert.ok(migrationSqlForTransaction(wp13.sql).length > 100, "valid BEGIN; ... COMMIT; transaction wrapper");

  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    await applyPrefix(db, migrations, wp13Idx);

    const preApplied = new Set(migrations.slice(0, wp13Idx).map((m) => m.name));
    const prePost = await verifyS0T1CSecurityPostconditions(db, s0Migration.sql, preApplied);
    assert.equal(prePost.ok, true, `pre-WP13 S0-T1-C postconditions pass: ${prePost.reason ?? ""}`);
    const preCount = prePost.details.actualServiceCount;
    assert.equal(prePost.details.exposedClientOrPublicCount, 0);

    // Atomic rollback leaves zero drift
    await db.exec("begin");
    await db.exec(migrationSqlForTransaction(wp13.sql));
    await db.exec("rollback");

    const afterRollback = await verifyS0T1CSecurityPostconditions(db, s0Migration.sql, preApplied);
    assert.equal(afterRollback.ok, true, "post-rollback S0-T1-C postconditions match pre-WP13");
    assert.equal(afterRollback.details.actualServiceCount, preCount, "rollback leaves zero new service_role RPCs");
    const { rows: rolledBackProcs } = await db.query(
      `select proname from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('direct_entry_list_app_users_filtered_admin', 'direct_entry_list_personnel_filtered_admin')`,
    );
    assert.deepEqual(rolledBackProcs, [], "rollback leaves zero new functions in pg_proc");

    // Apply forward
    await db.exec(wp13.sql);

    const postApplied = new Set(migrations.slice(0, wp13Idx + 1).map((m) => m.name));
    const postCheck = await verifyS0T1CSecurityPostconditions(db, s0Migration.sql, postApplied);
    assert.equal(postCheck.ok, true, `post-WP13 S0-T1-C postconditions pass: ${postCheck.reason ?? ""}`);
    assert.equal(
      postCheck.details.actualServiceCount,
      preCount + WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_RPC_SIGNATURES.length,
      `WP13 PR-0 adds exactly +${WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_RPC_SIGNATURES.length} net service_role RPCs`,
    );
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "0 client or PUBLIC function EXECUTE grants");
    assert.equal(postCheck.details.unsafeSecdefSearchPathCount, 0, "0 unsafe SECURITY DEFINER search_path");
    assert.equal(postCheck.details.bootstrapExecutorIntact, true, "catalog bootstrap executor intact");

    // Verify exact single pg_proc signature on each touched routine (no ambiguous overload)
    const { rows: touchedCounts } = await db.query(
      `select p.proname, count(*)::int as cnt, array_agg(p.oid::pg_catalog.regprocedure::text) as sigs
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
        group by p.proname
        order by p.proname`,
      [[
        "direct_entry_list_app_users_admin",
        "direct_entry_list_app_users_filtered_admin",
        "direct_entry_list_personnel_admin",
        "direct_entry_list_personnel_filtered_admin",
        "direct_entry_create_team",
        "direct_entry_update_personnel",
        "direct_entry_account_operation_update_display_name",
      ]],
    );
    assert.equal(touchedCounts.length, 7);
    for (const row of touchedCounts) {
      assert.equal(row.cnt, 1, `expected single pg_proc signature for ${row.proname}, got ${JSON.stringify(row.sigs)}`);
    }

    // Client roles blocked at function EXECUTE ACL on both new filtered RPCs
    for (const role of ["anon", "authenticated"]) {
      await db.exec("begin");
      try {
        await db.exec(`set local role ${role}`);
        await assert.rejects(
          () => db.query(
            "select public.direct_entry_list_app_users_filtered_admin($1::uuid, $2::uuid, null, 'all', 1, 25, 'all', 'all')",
            [OWNER.auth, OWNER.app],
          ),
          (err) => err?.code === "42501",
          `${role} blocked on direct_entry_list_app_users_filtered_admin`,
        );
      } finally {
        await db.exec("rollback");
      }
      await db.exec("begin");
      try {
        await db.exec(`set local role ${role}`);
        await assert.rejects(
          () => db.query(
            "select public.direct_entry_list_personnel_filtered_admin($1::uuid, $2::uuid, null, true, 1, 25, null)",
            [OWNER.auth, OWNER.app],
          ),
          (err) => err?.code === "42501",
          `${role} blocked on direct_entry_list_personnel_filtered_admin`,
        );
      } finally {
        await db.exec("rollback");
      }
    }

    // Legacy 2-arg default calls and 6-arg calls work cleanly under service_role
    await seedUser(db, OWNER);
    await grantLegacyAdmin(db, OWNER.app);
    const twoArgAcc = await serviceQuery(
      db,
      "select public.direct_entry_list_app_users_admin($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.equal(twoArgAcc.rows[0].payload.total, 1);
    const twoArgPers = await serviceQuery(
      db,
      "select public.direct_entry_list_personnel_admin($1::uuid, $2::uuid) as payload",
      [OWNER.auth, OWNER.app],
    );
    assert.equal(twoArgPers.rows[0].payload.total, 0);
  } finally {
    await db.close();
  }
});

test("2. GAP-BE-03: Accounts server-side filter before pagination (SQL + API + repository + ended link + RBAC)", async () => {
  const db = await bootCutoverDb();
  try {
    // Seed diverse accounts covering every account_type, link_state, enabled, tie-break name, and ended historical link
    const accounts = {
      normLinked1: { auth: nextUuid(), app: nextUuid(), email: "alpha.one@hrpartner.vn", name: "Tie Name Same" },
      normLinked2: { auth: nextUuid(), app: nextUuid(), email: "alpha.one@hrpartner.vn", name: "Tie Name Same" },
      normLinkedDisabled: { auth: nextUuid(), app: nextUuid(), email: "beta.dis@hrpartner.vn", name: "Beta Linked Disabled" },
      normUnlinkedNever: { auth: nextUuid(), app: nextUuid(), email: "gamma.unlinked@hrpartner.vn", name: "Gamma Never Linked" },
      normHistoricalEnded: { auth: nextUuid(), app: nextUuid(), email: "delta.ended@hrpartner.vn", name: "Delta Ended Link" },
      sharedEnabled: { auth: nextUuid(), app: nextUuid(), email: "shared.one@hrpartner.vn", name: "Shared One" },
      sharedDisabled: { auth: nextUuid(), app: nextUuid(), email: "shared.two@hrpartner.vn", name: "Shared Two" },
      serviceEnabled: { auth: nextUuid(), app: nextUuid(), email: "svc.one@hrpartner.vn", name: "Service One" },
      serviceDisabled: { auth: nextUuid(), app: nextUuid(), email: "svc.two@hrpartner.vn", name: "Service Two" },
    };

    await seedUser(db, accounts.normLinked1, { enabled: true, accountType: "NORMAL" });
    await seedUser(db, accounts.normLinked2, { enabled: true, accountType: "NORMAL" });
    await seedUser(db, accounts.normLinkedDisabled, { enabled: false, accountType: "NORMAL" });
    await seedUser(db, accounts.normUnlinkedNever, { enabled: true, accountType: "NORMAL" });
    await seedUser(db, accounts.normHistoricalEnded, { enabled: true, accountType: "NORMAL" });
    await seedUser(db, accounts.sharedEnabled, { enabled: true, accountType: "SHARED" });
    await seedUser(db, accounts.sharedDisabled, { enabled: false, accountType: "SHARED" });
    await seedUser(db, accounts.serviceEnabled, { enabled: true, accountType: "SERVICE" });
    await seedUser(db, accounts.serviceDisabled, { enabled: false, accountType: "SERVICE" });

    // Create 4 persons via canonical RPC and link active + ended historical
    const personIds = {};
    const linkIds = {};
    for (const [key, empCode, fullName] of [
      ["normLinked1", "WP13-001", "Tie Name Same"],
      ["normLinked2", "WP13-002", "Tie Name Same"],
      ["normLinkedDisabled", "WP13-003", "Beta Linked Disabled"],
      ["normHistoricalEnded", "WP13-004", "Delta Ended Link"],
    ]) {
      const pRes = await serviceQuery(
        db,
        `select public.org_department_create_person_admin(
           $1::uuid, $2::uuid, $3::text, $4::text, '2026-01-01'::date,
           null::uuid, null::uuid, null::integer, null::uuid,
           'WP13 seed person', $5::uuid, $6::text
         ) as payload`,
        [OWNER.auth, OWNER.app, empCode, fullName, nextUuid(), sha256(`seed-person-${key}`)],
      );
      personIds[key] = pRes.rows[0].payload.person.person_id;

      const lRes = await serviceQuery(
        db,
        `select public.org_department_link_account_person_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null::uuid,
           'WP13 seed link', $5::uuid, $6::text
         ) as payload`,
        [OWNER.auth, OWNER.app, accounts[key].app, personIds[key], nextUuid(), sha256(`seed-link-${key}`)],
      );
      linkIds[key] = lRes.rows[0].payload.link.link_id;
    }

    // Unlink normHistoricalEnded so it has ONLY an ended historical link (ended_at IS NOT NULL)
    await serviceQuery(
      db,
      `select public.org_department_unlink_account_person_admin(
         $1::uuid, $2::uuid, $3::uuid, 2, 2, $4::uuid,
         'WP13 end link', $5::uuid, $6::text
       )`,
      [OWNER.auth, OWNER.app, accounts.normHistoricalEnded.app, linkIds.normHistoricalEnded, nextUuid(), sha256("seed-unlink-delta")],
    );

    const trace = [];
    const repo = createAccountAccessRepository(createPgliteNamedRpc(db, trace));
    const ownerDeps = { resolveSession: sessionFor(OWNER), repository: repo };

    async function fetchAllPages(queryString, pageSize = 2) {
      const collected = [];
      let total = null;
      let page = 1;
      while (true) {
        const sep = queryString ? `${queryString}&` : "";
        const res = await listAccounts(
          new Request(`https://app.test/api/admin/access/accounts?${sep}page=${page}&page_size=${pageSize}`),
          "true",
          ownerDeps,
        );
        assert.equal(res.status, 200, `${queryString} page=${page}`);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.deepEqual(
          Object.keys(body.list).sort(),
          ["accounts", "enabled", "page", "page_size", "search", "total"],
          "exact 6-key response envelope preserved",
        );
        if (total === null) total = body.list.total;
        assert.equal(body.list.total, total, "total stays stable across pages");
        collected.push(...body.list.accounts);
        if (collected.length >= total || body.list.accounts.length === 0) break;
        page += 1;
        assert.ok(page <= 20, "pagination loop terminates");
      }
      const refs = collected.map((a) => a.account_ref);
      assert.equal(new Set(refs).size, refs.length, `zero duplicate rows across pages for ${queryString}`);
      assert.equal(refs.length, total, `collected count equals total for ${queryString}`);
      return { total, accounts: collected, refs: new Set(refs) };
    }

    // Check unfiltered routing (all/all -> legacy 6-arg RPC)
    trace.length = 0;
    const allResult = await fetchAllPages("", 2);
    assert.equal(allResult.total, 16, "7 baseline users + 9 seeded accounts = 16");
    assert.ok(trace.every(([name]) => name === "direct_entry_list_app_users_admin"));

    // Verify tie-breaker determinism between normLinked1 and normLinked2 (same display_name & login prefix)
    const tieOrdered = allResult.accounts
      .filter((a) => a.account_ref === accounts.normLinked1.app || a.account_ref === accounts.normLinked2.app)
      .map((a) => a.account_ref);
    assert.deepEqual(
      tieOrdered,
      [accounts.normLinked1.app, accounts.normLinked2.app].sort(),
      "identical display_name/login accounts sorted deterministically by app_user_id",
    );

    // Filtered combinations route to 8-arg RPC and match exact expected sets
    trace.length = 0;
    const normalOnly = await fetchAllPages("account_type=NORMAL", 2);
    assert.equal(normalOnly.total, 12);
    assert.ok(normalOnly.accounts.every((a) => a.account_type === "NORMAL"));
    assert.ok(trace.every(([name]) => name === "direct_entry_list_app_users_filtered_admin"));

    const sharedOnly = await fetchAllPages("account_type=SHARED", 1);
    assert.equal(sharedOnly.total, 2);
    assert.deepEqual([...sharedOnly.refs].sort(), [accounts.sharedEnabled.app, accounts.sharedDisabled.app].sort());

    const serviceOnly = await fetchAllPages("account_type=SERVICE", 1);
    assert.equal(serviceOnly.total, 2);
    assert.deepEqual([...serviceOnly.refs].sort(), [accounts.serviceEnabled.app, accounts.serviceDisabled.app].sort());

    const specialOnly = await fetchAllPages("account_type=SPECIAL", 2);
    assert.equal(specialOnly.total, 4, "SPECIAL = SHARED + SERVICE");
    assert.deepEqual(
      [...specialOnly.refs].sort(),
      [
        accounts.sharedEnabled.app,
        accounts.sharedDisabled.app,
        accounts.serviceEnabled.app,
        accounts.serviceDisabled.app,
      ].sort(),
    );

    const linkedOnly = await fetchAllPages("link_state=linked", 2);
    assert.equal(linkedOnly.total, 3, "only active links (ended_at IS NULL) count as linked");
    assert.ok(linkedOnly.accounts.every((a) => a.active_person_link !== null));
    assert.equal(linkedOnly.refs.has(accounts.normHistoricalEnded.app), false, "ended historical link MUST NOT be in linked");

    const unlinkedOnly = await fetchAllPages("link_state=unlinked", 2);
    assert.equal(unlinkedOnly.total, 13);
    assert.ok(unlinkedOnly.accounts.every((a) => a.active_person_link === null));
    assert.equal(unlinkedOnly.refs.has(accounts.normHistoricalEnded.app), true, "ended historical link MUST be in unlinked");

    // Combined filters: NORMAL + linked + enabled=false
    const normLinkedDis = await fetchAllPages("account_type=NORMAL&link_state=linked&enabled=false", 2);
    assert.equal(normLinkedDis.total, 1);
    assert.equal(normLinkedDis.accounts[0].account_ref, accounts.normLinkedDisabled.app);

    // Combined filters: SPECIAL + unlinked + enabled=true + search=Service
    const specialSearch = await fetchAllPages("account_type=SPECIAL&link_state=unlinked&enabled=true&search=Service", 2);
    assert.equal(specialSearch.total, 1);
    assert.equal(specialSearch.accounts[0].account_ref, accounts.serviceEnabled.app);

    // Combined filters: SPECIAL + linked -> 0 rows
    const specialLinked = await fetchAllPages("account_type=SPECIAL&link_state=linked", 2);
    assert.equal(specialLinked.total, 0);
    assert.deepEqual(specialLinked.accounts, []);

    // Invalid SQL parameters fail closed with 22023
    for (const [acctType, linkState] of [
      ["INVALID", "all"],
      [null, "all"],
      ["normal", "all"],
      ["all", "INVALID"],
      ["all", null],
      ["all", "LINKED"],
    ]) {
      await expectServiceError(
        db,
        "select public.direct_entry_list_app_users_filtered_admin($1::uuid, $2::uuid, null, 'all', 1, 25, $3::text, $4::text)",
        [OWNER.auth, OWNER.app, acctType, linkState],
        "22023",
      );
    }

    // RBAC: HR_OPERATOR & RECRUITER denied (42501 / HTTP 403 ACCOUNT_DENIED); disabled admin denied
    for (const deniedActor of [HR_OP, REC_ACTOR, DISABLED_ADMIN]) {
      const deniedRes = await listAccounts(
        new Request("https://app.test/api/admin/access/accounts?account_type=SPECIAL"),
        "true",
        { resolveSession: sessionFor(deniedActor), repository: repo },
      );
      assert.deepEqual([deniedRes.status, await deniedRes.json()], [403, { ok: false, code: "ACCOUNT_DENIED" }]);
    }
  } finally {
    await db.close();
  }
});

test("3. GAP-BE-06: Personnel server-side team_id filter before pagination (SQL + API + repository + vendor/inactive/RBAC)", async () => {
  const db = await bootCutoverDb();
  try {
    // Create Team A (active), Team B (active), Team C (will be set inactive)
    const teamA = (await serviceQuery(
      db,
      `select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'WP13_TEAM_A', 'Team Alpha', null, $3::text) as payload`,
      [OWNER.auth, OWNER.app, nextUuid()],
    )).rows[0].payload.team_id;
    const teamB = (await serviceQuery(
      db,
      `select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'WP13_TEAM_B', 'Team Beta', null, $3::text) as payload`,
      [OWNER.auth, OWNER.app, nextUuid()],
    )).rows[0].payload.team_id;
    const teamC = (await serviceQuery(
      db,
      `select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'WP13_TEAM_C', 'Team Inactive', null, $3::text) as payload`,
      [OWNER.auth, OWNER.app, nextUuid()],
    )).rows[0].payload.team_id;

    // Fetch __system_vendor__ team_id (seed if absent in fresh DB)
    let { rows: vendorTeamRows } = await db.query(
      "select team_id from public.teams where code = '__system_vendor__'",
    );
    let vendorTeamId = vendorTeamRows[0]?.team_id;
    if (!vendorTeamId) {
      vendorTeamId = nextUuid();
      await db.query(
        "insert into public.teams (team_id, code, display_name, active) values ($1, '__system_vendor__', 'Vendor System', true)",
        [vendorTeamId],
      );
    }

    async function seedHrpRecruiter(code, displayName, { active = true } = {}) {
      const id = nextUuid();
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
         values ($1, $2, $3, 'STAFF', $4, 1)`,
        [id, displayName, code, active],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
         values ($1, 'hrp', null, '2026-01-01', true)`,
        [id],
      );
      return id;
    }

    // Team A: 3 active (2 share same display_name for tie-breaker) + 1 deactivated via canonical RPC
    const recA1 = await seedHrpRecruiter("wp13.a1", "Alpha Tie", { active: true });
    const recA2 = await seedHrpRecruiter("wp13.a2", "Alpha Tie", { active: true });
    const recA3 = await seedHrpRecruiter("wp13.a3", "Alpha Zulu", { active: true });
    const recADeactivated = await seedHrpRecruiter("wp13.a4", "Alpha Off", { active: true });
    // Moved from Team A (is_current=false) -> Team B (is_current=true)
    const recMoved = await seedHrpRecruiter("wp13.moved", "Moved Member", { active: true });
    // Team B only
    const recBOnly = await seedHrpRecruiter("wp13.b1", "Beta Solo", { active: true });
    // Inactive Team C member
    const recC = await seedHrpRecruiter("wp13.c1", "Gamma Inactive Team", { active: true });
    // No team membership
    const recNoTeam = await seedHrpRecruiter("wp13.none", "Unassigned HRP", { active: true });

    for (const recId of [recA1, recA2, recA3, recADeactivated]) {
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1, $2, '2026-01-01', true)`,
        [recId, teamA],
      );
    }
    // Historical Team A membership (is_current=false) + current Team B membership (is_current=true)
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
       values ($1, $2, '2026-01-01', '2026-02-01', false),
              ($1, $3, '2026-02-01', null, true)`,
      [recMoved, teamA, teamB],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2026-01-01', true)`,
      [recBOnly, teamB],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2026-01-01', true)`,
      [recC, teamC],
    );

    // Deactivate recADeactivated via canonical RPC (R1 trigger clears current provider/team memberships)
    await serviceQuery(
      db,
      "select public.direct_entry_set_personnel_active($1::uuid, $2::uuid, $3::uuid, false, 1, null, $4::text)",
      [OWNER.auth, OWNER.app, recADeactivated, nextUuid()],
    );

    // Deactivate Team C (R1 trigger clears Team C's current team memberships; team remains queryable -> 200 empty, NOT 404)
    await serviceQuery(
      db,
      `select public.direct_entry_set_team_active($1::uuid, $2::uuid, $3::uuid, false, 1, null, $4::text)`,
      [OWNER.auth, OWNER.app, teamC, nextUuid()],
    );

    // Seed a vendor recruiter (NOT HRP) — MUST NEVER appear
    const vendorId = "wp13_vendor_x";
    await db.query("insert into public.vendors (vendor_id, display_name, active) values ($1, 'Vendor X', true)", [vendorId]);
    const recVendor = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active, version)
       values ($1, 'Vendor Recruiter', 'wp13.vnd', true, 1)`,
      [recVendor],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1, 'vendor', $2, '2026-01-01', true)`,
      [recVendor, vendorId],
    );

    const trace = [];
    const repo = createPersonnelCatalogRepository(createPgliteNamedRpc(db, trace));
    const hrDeps = { resolveSession: sessionFor(HR_OP), repository: repo };

    async function fetchAllPersonnel(queryString, pageSize = 2, deps = hrDeps) {
      const collected = [];
      let total = null;
      let page = 1;
      while (true) {
        const sep = queryString ? `${queryString}&` : "";
        const res = await listPersonnelCatalog(
          new Request(`https://app.test/api/admin/catalog/personnel?${sep}page=${page}&page_size=${pageSize}`),
          "true",
          deps,
        );
        assert.equal(res.status, 200, `${queryString} page=${page}`);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.deepEqual(
          Object.keys(body.list).sort(),
          ["authorization_date", "include_inactive", "page", "page_size", "personnel", "search", "total"],
          "exact 7-key personnel response envelope preserved",
        );
        if (total === null) total = body.list.total;
        assert.equal(body.list.total, total);
        collected.push(...body.list.personnel);
        if (collected.length >= total || body.list.personnel.length === 0) break;
        page += 1;
        assert.ok(page <= 20);
      }
      const ids = collected.map((p) => p.recruiter_id);
      assert.equal(new Set(ids).size, ids.length, "zero duplicate rows across pages");
      assert.equal(ids.length, total, "collected count equals total");
      return { total, personnel: collected, ids: new Set(ids) };
    }

    // Unfiltered routes to 6-arg RPC and includes unassigned HRP recruiter, excludes vendor & deactivated HRP
    trace.length = 0;
    const unfiltered = await fetchAllPersonnel("", 3);
    assert.equal(unfiltered.total, 7, "all 7 current HRP recruiters, 0 vendor, 0 revoked-provider deactivated");
    assert.equal(unfiltered.ids.has(recNoTeam), true);
    assert.equal(unfiltered.ids.has(recVendor), false);
    assert.equal(unfiltered.ids.has(recADeactivated), false);
    assert.ok(trace.every(([name]) => name === "direct_entry_list_personnel_admin"));

    // Filtered Team A (page_size=2 across 2 pages): 3 current HRP members (excludes recMoved, recADeactivated, recVendor, recNoTeam)
    trace.length = 0;
    const teamAAll = await fetchAllPersonnel(`team_id=${teamA}&include_inactive=true`, 2);
    assert.equal(teamAAll.total, 3);
    assert.deepEqual(
      [...teamAAll.ids].sort(),
      [recA1, recA2, recA3].sort(),
      "historical member recMoved, deactivated member, and unassigned excluded from Team A",
    );
    assert.ok(trace.every(([name]) => name === "direct_entry_list_personnel_filtered_admin"));
    // Tie-break determinism on same display_name ("Alpha Tie")
    const tieOrder = teamAAll.personnel
      .filter((p) => p.recruiter_id === recA1 || p.recruiter_id === recA2)
      .map((p) => p.recruiter_id);
    assert.deepEqual(tieOrder, [recA1, recA2].sort());

    // Filtered Team A (include_inactive=false): 3 active HRP members
    const teamAActive = await fetchAllPersonnel(`team_id=${teamA}&include_inactive=false`, 2);
    assert.equal(teamAActive.total, 3);

    // Filtered Team A + search
    const teamASearch = await fetchAllPersonnel(`team_id=${teamA}&search=Zulu`, 2);
    assert.equal(teamASearch.total, 1);
    assert.equal(teamASearch.personnel[0].recruiter_id, recA3);

    // Filtered Team B includes recMoved (current) + recBOnly
    const teamBAll = await fetchAllPersonnel(`team_id=${teamB}`, 2);
    assert.equal(teamBAll.total, 2);
    assert.deepEqual([...teamBAll.ids].sort(), [recMoved, recBOnly].sort());

    // Inactive non-vendor Team C is still queryable (200 OK, total=0 after R1 deactivation clears current memberships; NOT 404!)
    const teamCAll = await fetchAllPersonnel(`team_id=${teamC}`, 2);
    assert.equal(teamCAll.total, 0);
    assert.deepEqual(teamCAll.personnel, []);

    // Full Admin also allowed
    const ownerCheck = await fetchAllPersonnel(`team_id=${teamB}`, 2, {
      resolveSession: sessionFor(OWNER),
      repository: repo,
    });
    assert.equal(ownerCheck.total, 2);

    // __system_vendor__ and unknown UUID -> P0002 / HTTP 404 PERSONNEL_NOT_FOUND
    for (const missingTeam of [vendorTeamId, nextUuid()]) {
      const res = await listPersonnelCatalog(
        new Request(`https://app.test/api/admin/catalog/personnel?team_id=${missingTeam}`),
        "true",
        hrDeps,
      );
      assert.deepEqual([res.status, await res.json()], [404, { ok: false, code: "PERSONNEL_NOT_FOUND" }]);
    }

    // RBAC: plain RECRUITER and disabled admin denied (42501 / HTTP 403 PERSONNEL_DENIED) even on nonexistent team_id
    const nonexistentTeam = nextUuid();
    for (const deniedActor of [REC_ACTOR, DISABLED_ADMIN]) {
      const res = await listPersonnelCatalog(
        new Request(`https://app.test/api/admin/catalog/personnel?team_id=${nonexistentTeam}`),
        "true",
        { resolveSession: sessionFor(deniedActor), repository: repo },
      );
      assert.deepEqual(
        [res.status, await res.json()],
        [403, { ok: false, code: "PERSONNEL_DENIED" }],
        "authorization runs BEFORE team existence check (no UUID probing)",
      );
    }
  } finally {
    await db.close();
  }
});

test("4. GAP-BE-04 Part 1: Optional p_reason restored on exact 3 RPCs (unlinked + Person-linked sync, idempotency, OCC, boundary)", async () => {
  const db = await bootCutoverDb();
  try {
    async function restrictedReasonCount() {
      const { rows } = await db.query("select count(*)::int as cnt from public.direct_entry_restricted_reasons");
      return rows[0].cnt;
    }

    // -------------------------------------------------------------------------
    // 4.1 direct_entry_create_team
    // -------------------------------------------------------------------------
    const r0 = await restrictedReasonCount();
    const teamKeyNull = nextUuid();
    const teamNull = (await serviceQuery(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T1', 'Optional Team Null', null, $3::text) as payload",
      [OWNER.auth, OWNER.app, teamKeyNull],
    )).rows[0].payload;
    assert.equal(teamNull.created, true);
    assert.equal(await restrictedReasonCount(), r0, "null reason inserts 0 placeholder rows in direct_entry_restricted_reasons");

    // Verify RECRUITMENT department binding + null reason_id in revision & audit
    const { rows: teamMeta } = await db.query(
      `select t.department_id, d.system_key, rev.reason_id as rev_reason, aud.reason_id as aud_reason
         from public.teams t
         join public.organization_departments d on d.department_id = t.department_id
         join public.direct_entry_team_revisions rev on rev.revision_id = $2::uuid
         join public.direct_entry_audit_events aud on aud.team_revision_id = $2::uuid
        where t.team_id = $1::uuid`,
      [teamNull.team_id, teamNull.revision_id],
    );
    assert.equal(teamMeta[0].system_key, "RECRUITMENT");
    assert.equal(teamMeta[0].rev_reason, null);
    assert.equal(teamMeta[0].aud_reason, null);

    // Same-key replay with whitespace reason returns exact prior payload
    const teamReplay = (await serviceQuery(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T1', 'Optional Team Null', '   ', $3::text) as payload",
      [OWNER.auth, OWNER.app, teamKeyNull],
    )).rows[0].payload;
    assert.deepEqual(teamReplay, teamNull);

    // Same-key reuse with different payload fails 22023
    await expectServiceError(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T1', 'Different Name', null, $3::text)",
      [OWNER.auth, OWNER.app, teamKeyNull],
      "22023",
      /idempotency key reused with different input/i,
    );

    // Empty and whitespace reasons create cleanly with 0 restricted reasons
    for (const [code, reason] of [["OPT_T2", ""], ["OPT_T3", "   \t  "]]) {
      await serviceQuery(
        db,
        "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, $3::text, $4::text, $5::text, $6::text)",
        [OWNER.auth, OWNER.app, code, `Team ${code}`, reason, nextUuid()],
      );
    }
    assert.equal(await restrictedReasonCount(), r0);

    // Non-empty reason stores exactly +1 restricted reason row
    await serviceQuery(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T4', 'Team With Reason', '  Valid team note  ', $3::text)",
      [OWNER.auth, OWNER.app, nextUuid()],
    );
    assert.equal(await restrictedReasonCount(), r0 + 1);

    // Overlong reason (> 4000) rejected with 22023
    await expectServiceError(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T5', 'Team Too Long', $3::text, $4::text)",
      [OWNER.auth, OWNER.app, "x".repeat(4001), nextUuid()],
      "22023",
      /reason exceeds maximum length/i,
    );

    // Unauthorized actor blocked 42501
    await expectServiceError(
      db,
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'OPT_T6', 'Denied Team', null, $3::text)",
      [REC_ACTOR.auth, REC_ACTOR.app, nextUuid()],
      "42501",
    );

    // -------------------------------------------------------------------------
    // 4.2 direct_entry_update_personnel (unlinked + Person-linked sync)
    // -------------------------------------------------------------------------
    const unlinkedRecId = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1, 'Unlinked Rec', 'opt.unlinked', 'STAFF', true, 1)`,
      [unlinkedRecId],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1, 'hrp', null, '2026-01-01', true)`,
      [unlinkedRecId],
    );

    const r1 = await restrictedReasonCount();
    const updUnlinkedKey = nextUuid();
    const updUnlinked = (await serviceQuery(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 1, 'Unlinked Rec V2', 'opt.unlinked', 'TEAM_LEADER', null, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, unlinkedRecId, updUnlinkedKey],
    )).rows[0].payload;
    assert.equal(updUnlinked.version, 2);
    assert.equal(await restrictedReasonCount(), r1, "unlinked personnel update with null reason adds 0 restricted reasons");

    // Same-key replay (0 version bump)
    const updUnlinkedReplay = (await serviceQuery(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 1, 'Unlinked Rec V2', 'opt.unlinked', 'TEAM_LEADER', '   ', $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, unlinkedRecId, updUnlinkedKey],
    )).rows[0].payload;
    assert.deepEqual(updUnlinkedReplay, updUnlinked);

    // Stale OCC fails PT409
    await expectServiceError(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 1, 'Unlinked Rec V3', 'opt.unlinked', 'STAFF', null, $4::text
       )`,
      [OWNER.auth, OWNER.app, unlinkedRecId, nextUuid()],
      "PT409",
    );

    // Now create a Person-linked Account + Recruiter pair to exercise full sync & org audit insert!
    const linkedUser = { auth: nextUuid(), app: nextUuid(), email: "linked.sync@hrpartner.vn", name: "Linked Sync Orig" };
    await seedUser(db, linkedUser, { enabled: true, accountType: "NORMAL" });
    const linkedPersonId = (await serviceQuery(
      db,
      `select public.org_department_create_person_admin(
         $1::uuid, $2::uuid, 'linked.sync', 'Linked Sync Orig', '2026-01-01'::date,
         null::uuid, null::uuid, null::integer, null::uuid,
         'Seed linked person for WP13', $3::uuid, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, nextUuid(), sha256("wp13-linked-person")],
    )).rows[0].payload.person.person_id;
    await serviceQuery(
      db,
      `select public.org_department_link_account_person_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null::uuid,
         'Link account to person', $5::uuid, $6::text
       )`,
      [OWNER.auth, OWNER.app, linkedUser.app, linkedPersonId, nextUuid(), sha256("wp13-link-sync")],
    );
    const linkedRecId = (await serviceQuery(
      db,
      `select public.direct_entry_account_operation_create_personnel(
         $1::uuid, $2::uuid, $3::uuid, 2, 'linked.sync', 'STAFF', null::date, null::text, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, linkedUser.app, nextUuid()],
    )).rows[0].payload.recruiter_id;

    const r2 = await restrictedReasonCount();
    // Update linked recruiter with p_reason = null -> MUST sync Person + Account + org_department_audit_events cleanly!
    const updLinkedPers = (await serviceQuery(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 1, 'Linked Sync Personnel Null', 'linked.sync', 'STAFF', null, $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, linkedRecId, nextUuid()],
    )).rows[0].payload;
    assert.equal(updLinkedPers.version, 2);
    assert.equal(await restrictedReasonCount(), r2, "linked personnel update with null reason adds 0 restricted reasons");

    const { rows: syncAfterPers } = await db.query(
      `select p.full_name, u.display_name, u.version as acc_ver,
              (select a.reason from public.organization_department_audit_events a
                where a.target_person_id = p.person_id and a.action = 'PERSON_UPDATED'
                order by a.created_at desc limit 1) as org_audit_reason
         from public.organization_persons p
         join public.direct_entry_app_users u on u.app_user_id = $2::uuid
        where p.person_id = $1::uuid`,
      [linkedPersonId, linkedUser.app],
    );
    assert.equal(syncAfterPers[0].full_name, "Linked Sync Personnel Null");
    assert.equal(syncAfterPers[0].display_name, "Linked Sync Personnel Null");
    assert.equal(syncAfterPers[0].org_audit_reason, "Synced from personnel_update");

    // Edge case: 500-char boundary with trailing space at index 500 + control character '\x07'
    const trickyReason = `${"a".repeat(498)}\u0007 b`;
    await serviceQuery(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 2, 'Linked Sync Edge Reason', 'linked.sync', 'STAFF', $4::text, $5::text
       )`,
      [OWNER.auth, OWNER.app, linkedRecId, trickyReason, nextUuid()],
    );
    assert.equal(await restrictedReasonCount(), r2 + 1);

    // Overlong reason on update_personnel -> 22023
    await expectServiceError(
      db,
      `select public.direct_entry_update_personnel(
         $1::uuid, $2::uuid, $3::uuid, 3, 'Linked Too Long', 'linked.sync', 'STAFF', $4::text, $5::text
       )`,
      [OWNER.auth, OWNER.app, linkedRecId, "z".repeat(4001), nextUuid()],
      "22023",
      /reason exceeds maximum length/i,
    );

    // -------------------------------------------------------------------------
    // 4.3 direct_entry_account_operation_update_display_name (unlinked + Person-linked sync)
    // -------------------------------------------------------------------------
    const { rows: curAccVer } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [linkedUser.app],
    );
    const accVerBefore = curAccVer[0].version;
    const r3 = await restrictedReasonCount();

    const dispKeyNull = nextUuid();
    const dispNull = (await serviceQuery(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'Linked Sync Account Null', $4::integer, null, $5::text
       ) as payload`,
      [OWNER.auth, OWNER.app, linkedUser.app, accVerBefore, dispKeyNull],
    )).rows[0].payload;
    assert.equal(dispNull.version, accVerBefore + 1);
    assert.equal(dispNull.recruiter_id, linkedRecId);
    assert.equal(await restrictedReasonCount(), r3, "linked display_name update with null reason adds 0 restricted reasons");

    const { rows: syncAfterAcc } = await db.query(
      `select p.full_name, r.display_name as rec_name, rev.reason_id as acc_rev_reason,
              (select a.reason from public.organization_department_audit_events a
                where a.target_person_id = p.person_id and a.action = 'PERSON_UPDATED'
                order by a.created_at desc limit 1) as org_audit_reason
         from public.organization_persons p
         join public.recruiters r on r.recruiter_id = $2::uuid
         join public.direct_entry_app_user_revisions rev on rev.revision_id = $3::uuid
        where p.person_id = $1::uuid`,
      [linkedPersonId, linkedRecId, dispNull.revision_id],
    );
    assert.equal(syncAfterAcc[0].full_name, "Linked Sync Account Null");
    assert.equal(syncAfterAcc[0].rec_name, "Linked Sync Account Null");
    assert.equal(syncAfterAcc[0].acc_rev_reason, null);
    assert.equal(syncAfterAcc[0].org_audit_reason, "Synced from account display_name_update");

    // Replay same key with '' and '   ' canonicalizes to null -> exact replay (0 version bump)
    for (const equivReason of ["", "   "]) {
      const replayed = (await serviceQuery(
        db,
        `select public.direct_entry_account_operation_update_display_name(
           $1::uuid, $2::uuid, $3::uuid, 'Linked Sync Account Null', $4::integer, $5::text, $6::text
         ) as payload`,
        [OWNER.auth, OWNER.app, linkedUser.app, accVerBefore, equivReason, dispKeyNull],
      )).rows[0].payload;
      assert.deepEqual(replayed, dispNull);
    }

    // Same key with non-null reason -> different payload hash -> 22023
    await expectServiceError(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'Linked Sync Account Null', $4::integer, 'different note', $5::text
       )`,
      [OWNER.auth, OWNER.app, linkedUser.app, accVerBefore, dispKeyNull],
      "22023",
      /idempotency key reused with different input/i,
    );

    // Unlinked account rename with whitespace reason + stale OCC + overlong reason + unauthorized
    const unlinkedAcc = { auth: nextUuid(), app: nextUuid(), email: "unlinked.rename@hrpartner.vn", name: "Before Rename" };
    await seedUser(db, unlinkedAcc, { enabled: true, accountType: "NORMAL" });
    const r4 = await restrictedReasonCount();
    const unlinkedDisp = (await serviceQuery(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'After Rename', 1, '   ', $4::text
       ) as payload`,
      [OWNER.auth, OWNER.app, unlinkedAcc.app, nextUuid()],
    )).rows[0].payload;
    assert.equal(unlinkedDisp.version, 2);
    assert.equal(unlinkedDisp.recruiter_id, null);
    assert.equal(await restrictedReasonCount(), r4);

    await expectServiceError(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'Stale Rename', 1, null, $4::text
       )`,
      [OWNER.auth, OWNER.app, unlinkedAcc.app, nextUuid()],
      "PT409",
    );
    await expectServiceError(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'Too Long Reason', 2, $4::text, $5::text
       )`,
      [OWNER.auth, OWNER.app, unlinkedAcc.app, "y".repeat(4001), nextUuid()],
      "22023",
      /reason exceeds maximum length/i,
    );
    await expectServiceError(
      db,
      `select public.direct_entry_account_operation_update_display_name(
         $1::uuid, $2::uuid, $3::uuid, 'Denied Rename', 2, null, $4::text
       )`,
      [HR_OP.auth, HR_OP.app, unlinkedAcc.app, nextUuid()],
      "42501",
    );

    // -------------------------------------------------------------------------
    // 4.4 Negative Boundary: Other mandatory-reason RPCs remain STRICTLY required!
    // -------------------------------------------------------------------------
    for (const badReason of [null, "", "   "]) {
      await expectServiceError(
        db,
        `select public.org_department_create_person_admin(
           $1::uuid, $2::uuid, 'MUST-REASON-01', 'Must Reason Person', '2026-01-01'::date,
           null::uuid, null::uuid, null::integer, null::uuid,
           $3::text, $4::uuid, $5::text
         )`,
        [OWNER.auth, OWNER.app, badReason, nextUuid(), sha256(`must-create-${String(badReason)}`)],
        "22023",
      );
      await expectServiceError(
        db,
        `select public.org_department_update_person_admin(
           $1::uuid, $2::uuid, $3::uuid, 1, 'linked.sync', 'Must Reason Updated', '2026-01-01'::date,
           'ACTIVE', $4::text, $5::uuid, $6::text
         )`,
        [OWNER.auth, OWNER.app, linkedPersonId, badReason, nextUuid(), sha256(`must-update-${String(badReason)}`)],
        "22023",
      );
    }
  } finally {
    await db.close();
  }
});
