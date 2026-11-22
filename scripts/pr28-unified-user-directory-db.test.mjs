/**
 * PR #28 Phase A — Unified User Directory Real SQL Reader & Rev 2 8-Case Fixture Proof (PGlite).
 *
 * Proves all Rev 2 merge-rule requirements BEFORE writing unified UI:
 *   1. Migration #235 hygiene & dynamic S0-T1-C allowlist:
 *      - LF line endings, 0 literal `@`, 0 literal `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`,
 *        0 `account_type` references inside the new directory reader routines.
 *      - Atomic rollback produces zero drift.
 *      - Dynamic S0-T1-C allowlist postconditions pre/post (+2 net `service_role` RPCs relative to
 *        applied prefix, 0 client/PUBLIC EXECUTE grants, exact single `pg_proc` signature per RPC).
 *   2. ALL 8 Rev 2 merge-rule cases on the REAL SQL reader + REAL TS repository & HTTP handlers:
 *      - Case 1: Person with valid 1:1 active account-person link -> 1 merged row (`LINKED_PERSON_ACCOUNT`)
 *                with exact Person ID, Account ref, active link ID, and active department.
 *      - Case 2: Person without active Account -> 1 row (`PERSON_ONLY`, `login_state = 'NO_ACCOUNT'`).
 *      - Case 3: Unlinked personal Account -> 1 row (`UNLINKED_ACCOUNT`) in main list, no auto-Person.
 *      - Case 4: Same full_name & email/login prefix with NO canonical link -> 2 separate rows, NEVER merged.
 *      - Case 5: Only historical ended link -> 2 separate rows at current `v_as_of`; 1 merged row at
 *                historical `p_as_of` inside `[started_at, ended_at)`; `link_history` preserved in detail.
 *      - Case 6: Valid link with disabled Account (`enabled=false`, Person `ACTIVE`) AND valid link with
 *                inactive Person (`INACTIVE`, Account `enabled=true`) -> still 1 row each, independent
 *                statuses preserved, orthogonal `person_status` + `login_state` filters exact.
 *      - Case 7: Conflicting / multiple effective links:
 *                (7a) Normal DB enforces 1:1 uniqueness & non-overlap via indexes + trigger.
 *                (7b) Dedicated isolated anomaly PGlite DB proves the reader NEVER picks `LIMIT 1` or
 *                     drops any account: emits `PERSON_LINK_CONFLICT` & `ACCOUNT_LINK_CONFLICT` separately
 *                     with `link_conflict = true`, `identity_mutation_blocked = true`, and exact
 *                     `conflict_details` (`link_ids`, `related_person_ids`, `related_account_refs`).
 *      - Case 8: Recruiter-only row (HRP and vendor) -> 0 directory rows fabricated.
 *   3. Total row count invariant (`P + U - C`), exact source IDs, filter-before-COUNT (including escaped
 *      `_` and `%` search tokens, `department_id`, `record_kind`, `person_status`, `login_state`),
 *      deterministic server pagination across page boundaries (`page_size = 2` and `3`, 0 duplicates,
 *      0 dropped rows), deep-link detail lookup (`person_id` vs `account_ref`), RBAC (`42501`),
 *      and zero leakage of `auth_subject` or `account_type`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  PR28_UNIFIED_USER_DIRECTORY_READER_MIGRATION_NAME,
  PR28_UNIFIED_USER_DIRECTORY_READER_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME,
  migrationChecksum,
  migrationSqlForTransaction,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import {
  getUserDirectoryEntryAdmin,
  listUserDirectoryAdmin,
} from "../src/lib/organization/user-directory-api.ts";
import { createServiceUserDirectoryRepository } from "../src/lib/organization/user-directory-repository.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18000000-0000-4000-8000-000000000001",
  app: "28000000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Admin PR28",
};
const LUANPT = {
  auth: "18000000-0000-4000-8000-000000000091",
  app: "28000000-0000-4000-8000-000000000091",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18000000-0000-4000-8000-000000000092",
  app: "28000000-0000-4000-8000-000000000092",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18000000-0000-4000-8000-000000000093",
  app: "28000000-0000-4000-8000-000000000093",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "18000000-0000-4000-8000-000000000002",
  app: "28000000-0000-4000-8000-000000000002",
  email: "hr.operator@hrpartner.vn",
  name: "HR Operator PR28",
};
const REC_ACTOR = {
  auth: "18000000-0000-4000-8000-000000000003",
  app: "28000000-0000-4000-8000-000000000003",
  email: "plain.rec@hrpartner.vn",
  name: "Plain Recruiter PR28",
};
const DISABLED_ADMIN = {
  auth: "18000000-0000-4000-8000-000000000004",
  app: "28000000-0000-4000-8000-000000000004",
  email: "disabled.admin@hrpartner.vn",
  name: "Disabled Admin PR28",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `98000000-0000-4000-8000-${hex}`;
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

const RPC_PARAM_TYPES = {
  org_department_list_user_directory_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_search: "text",
    p_record_kind: "text",
    p_person_status: "text",
    p_login_state: "text",
    p_department_id: "uuid",
    p_as_of: "timestamptz",
    p_page: "integer",
    p_page_size: "integer",
  },
  org_department_get_user_directory_entry_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_person_id: "uuid",
    p_account_ref: "uuid",
    p_as_of: "timestamptz",
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

function makeFullAdminSession(actor) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: actor.auth,
        app_user_id: actor.app,
        enabled: true,
        capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
        scopes: [{ kind: "all" }],
        effective_grants: [
          { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
        ],
      },
    },
  });
}

async function seedBaseUser(db, user, { enabled = true } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
     values ($1::uuid, $2::uuid, $3, $4)`,
    [user.app, user.auth, user.name, enabled],
  );
}

async function grantLegacyAdmin(db, appUserId) {
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2020-01-01', true), ($1::uuid, 'own', null, '2020-01-01', true)`,
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
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [appUserId, cap],
    );
  }
}

async function seedPersonDirect(
  db,
  { personId, employeeCode, fullName, status = "ACTIVE", joinedOn = "2026-01-10", recruiterId = null },
) {
  await db.query(
    `insert into public.organization_persons
       (person_id, employee_code, full_name, status, joined_on, recruiter_id, deactivated_at, deactivated_by_user_id, deactivate_reason)
     values (
       $1::uuid, $2, $3, $4, $5::date, $6::uuid,
       case when $4 = 'INACTIVE' then '2026-08-01T00:00:00Z'::timestamptz else null end,
       case when $4 = 'INACTIVE' then $7::uuid else null end,
       case when $4 = 'INACTIVE' then 'Resigned fixture' else null end
     )`,
    [personId, employeeCode, fullName, status, joinedOn, recruiterId, OWNER.app],
  );
}

async function createBootstrappedDb() {
  const migrations = await loadMigrations();
  const pr28ReaderIdx = migrations.findIndex(
    (m) => m.name === PR28_UNIFIED_USER_DIRECTORY_READER_MIGRATION_NAME,
  );
  assert.ok(pr28ReaderIdx >= 0, "PR #28 unified user directory migration must exist");

  const db = new PGlite();
  await db.exec(ROLE_PREAMBLE);
  // Real production rollout order: #001..#235 -> WP5 cutover -> pre-cutover roles -> #236 (groups) -> #237 (cleanup).
  await applyPrefix(db, migrations, pr28ReaderIdx + 1);

  for (const u of [OWNER, LUANPT, LIENVU, NGATTT, HR_OP, REC_ACTOR]) {
    await seedBaseUser(db, u);
  }
  await seedBaseUser(db, DISABLED_ADMIN, { enabled: false });
  for (const adm of [OWNER, LIENVU, NGATTT, DISABLED_ADMIN]) {
    await grantLegacyAdmin(db, adm.app);
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2020-01-01', true)`,
    [LUANPT.app],
  );

  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  await serviceQuery(
    db,
    `select public.direct_entry_authz_assign_global_role_admin(
       $1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'PR28 test HR_OP', $4::uuid, $5::text
     )`,
    [OWNER.auth, OWNER.app, HR_OP.app, nextUuid(), sha256("pr28-seed-hr")],
  );
  await serviceQuery(
    db,
    `select public.direct_entry_authz_assign_global_role_admin(
       $1::uuid, $2::uuid, $3::uuid, 'RECRUITER', 1, 'PR28 test REC_ACTOR', $4::uuid, $5::text
     )`,
    [OWNER.auth, OWNER.app, REC_ACTOR.app, nextUuid(), sha256("pr28-seed-rec")],
  );

  // Apply #236 (permission groups foundation & backfill) and #237 (group-only cutover & legacy cleanup).
  for (const m of migrations.slice(pr28ReaderIdx + 1)) {
    await db.exec(m.sql);
  }

  return db;
}

test("1. Migration #235 hygiene, atomic rollback zero drift, and dynamic S0-T1-C allowlist (+2 net service_role RPCs)", async () => {
  const migrations = await loadMigrations();
  const wp13Idx = migrations.findIndex(
    (m) => m.name === WP13_PR0_BACKEND_FILTERS_OPTIONAL_REASON_MIGRATION_NAME,
  );
  const pr28Idx = migrations.findIndex(
    (m) => m.name === PR28_UNIFIED_USER_DIRECTORY_READER_MIGRATION_NAME,
  );
  assert.ok(wp13Idx >= 0, "WP13 PR-0 migration must exist");
  assert.ok(pr28Idx > wp13Idx, "PR #28 unified user directory migration must sort strictly after WP13 PR-0");

  const migration = migrations[pr28Idx];
  assert.equal(migration.sql.includes("\r\n"), false, "migration #235 must use LF line endings");
  assert.equal(migration.sql.includes("@"), false, "migration #235 must contain zero literal @ characters");
  assert.equal(/\bsavepoint\b/i.test(migration.sql), false, "migration #235 must contain zero literal SAVEPOINT");
  assert.equal(migration.sql.includes("'40001'"), false, "migration #235 must contain zero literal '40001'");
  assert.equal(
    /alter\s+default\s+privileges/i.test(migration.sql),
    false,
    "migration #235 must contain zero ALTER DEFAULT PRIVILEGES",
  );
  assert.equal(
    /\baccount_type\b/i.test(
      migration.sql.replace(/--[^\n]*/g, ""),
    ),
    false,
    "PR #28 unified user directory SQL bodies must have zero runtime dependency on account_type",
  );

  const s0Sql = migrations.find((m) => m.name === S0_T1_C_MIGRATION_NAME)?.sql;
  assert.ok(s0Sql, "S0-T1-C migration must exist");

  const db = new PGlite();
  try {
    await db.exec(ROLE_PREAMBLE);
    await applyPrefix(db, migrations, pr28Idx);
    const appliedPre = new Set(migrations.slice(0, pr28Idx).map((m) => m.name));
    const preCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, appliedPre);
    assert.equal(preCheck.ok, true, `pre-PR28 S0-T1-C postconditions failed: ${preCheck.reason}`);
    const preCount = preCheck.details.actualServiceCount;

    // Atomic rollback check -> zero drift
    await db.exec("begin");
    await db.exec(migrationSqlForTransaction(migration.sql));
    await db.exec("rollback");
    const postRollbackCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, appliedPre);
    assert.equal(postRollbackCheck.ok, true, `post-rollback S0-T1-C failed: ${postRollbackCheck.reason}`);
    assert.equal(postRollbackCheck.details.actualServiceCount, preCount);

    // Apply forward
    await db.exec(migration.sql);
    const appliedPost = new Set(migrations.slice(0, pr28Idx + 1).map((m) => m.name));
    const postCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, appliedPost);
    assert.equal(postCheck.ok, true, `post-PR28 S0-T1-C postconditions failed: ${postCheck.reason}`);
    assert.equal(
      postCheck.details.actualServiceCount,
      preCount + PR28_UNIFIED_USER_DIRECTORY_READER_RPC_SIGNATURES.length,
      "PR #28 unified directory migration adds exactly +2 net service_role RPCs",
    );
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0);
    assert.equal(postCheck.details.unsafeSecdefSearchPathCount, 0);

    // Exact single overload per new RPC
    const { rows: procRows } = await db.query(
      `select proname, count(*)::int as cnt
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and proname in (
            'org_department_list_user_directory_admin',
            'org_department_get_user_directory_entry_admin'
          )
        group by proname
        order by proname`,
    );
    assert.deepEqual(procRows, [
      { proname: "org_department_get_user_directory_entry_admin", cnt: 1 },
      { proname: "org_department_list_user_directory_admin", cnt: 1 },
    ]);
  } finally {
    await db.close();
  }
});

test("2. Rev 2 Cases 1-6 & 8 + Exact Total (P+U-C), Source IDs, Filter-Before-COUNT, Pagination Boundaries, Detail Deep-Links & RBAC", async () => {
  const db = await createBootstrappedDb();
  try {
    const { rows: depts } = await db.query(
      `select department_id, system_key
         from public.organization_departments
        where system_key in ('RECRUITMENT', 'ACCOUNTING')
        order by system_key`,
    );
    const deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));
    const recDeptId = deptByKey.RECRUITMENT;
    const accDeptId = deptByKey.ACCOUNTING;
    assert.ok(recDeptId && accDeptId);

    // Case 1: Person + valid active 1:1 link + active RECRUITMENT department
    const pCase1 = nextUuid();
    const uCase1 = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "case1.linked@hrpartner.vn",
      name: "Alpha Linked User",
    };
    const lCase1 = nextUuid();
    await seedBaseUser(db, uCase1, { enabled: true });
    await seedPersonDirect(db, {
      personId: pCase1,
      employeeCode: "NV-C01",
      fullName: "Alpha Linked User",
      status: "ACTIVE",
    });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-10T00:00:00Z', null, 'Case 1 fixture link')`,
      [lCase1, uCase1.app, pCase1],
    );
    await db.query(
      `insert into public.organization_person_department_memberships (person_id, department_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-10T00:00:00Z', null, 'Case 1 fixture dept')`,
      [pCase1, recDeptId],
    );

    // Case 2: Person without Account
    const pCase2 = nextUuid();
    await seedPersonDirect(db, {
      personId: pCase2,
      employeeCode: "NV-C02",
      fullName: "Bravo Person Only",
      status: "ACTIVE",
    });
    await db.query(
      `insert into public.organization_person_department_memberships (person_id, department_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-12T00:00:00Z', null, 'Case 2 fixture dept')`,
      [pCase2, accDeptId],
    );

    // Case 3: Unlinked personal accounts (simulating legacy 39 accounts + special underscore/percent search tokens)
    const uCase3a = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "legacy_39_user@hrpartner.vn",
      name: "Charlie Legacy_39 Account",
    };
    const uCase3b = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "legacyX39Xuser@hrpartner.vn",
      name: "Charlie LegacyX39X Account",
    };
    await seedBaseUser(db, uCase3a, { enabled: true });
    await seedBaseUser(db, uCase3b, { enabled: false });

    // Case 4: Same full_name & matching email/login prefix, NO canonical link -> MUST remain 2 separate rows!
    const pCase4 = nextUuid();
    const uCase4 = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "delta.dupname@hrpartner.vn",
      name: "Delta Same Name",
    };
    await seedBaseUser(db, uCase4, { enabled: true });
    await seedPersonDirect(db, {
      personId: pCase4,
      employeeCode: "NV-C04",
      fullName: "Delta Same Name",
      status: "ACTIVE",
    });

    // Case 5: Only historical ended link (2026-01-01 -> 2026-06-01) -> NOT merged at current time, MERGED at 2026-03-15!
    const pCase5 = nextUuid();
    const uCase5 = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "echo.histlink@hrpartner.vn",
      name: "Echo Historical Link",
    };
    const lCase5 = nextUuid();
    await seedBaseUser(db, uCase5, { enabled: true });
    await seedPersonDirect(db, {
      personId: pCase5,
      employeeCode: "NV-C05",
      fullName: "Echo Historical Link",
      status: "ACTIVE",
    });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason, ended_reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'Case 5 historical link', 'Ended historically')`,
      [lCase5, uCase5.app, pCase5],
    );

    // Case 6a: Valid active link, Person ACTIVE + Account DISABLED
    const pCase6a = nextUuid();
    const uCase6a = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "foxtrot.disabledlogin@hrpartner.vn",
      name: "Foxtrot Active Person Disabled Login",
    };
    const lCase6a = nextUuid();
    await seedBaseUser(db, uCase6a, { enabled: false });
    await seedPersonDirect(db, {
      personId: pCase6a,
      employeeCode: "NV-C06A",
      fullName: "Foxtrot Active Person Disabled Login",
      status: "ACTIVE",
    });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-15T00:00:00Z', null, 'Case 6a fixture link')`,
      [lCase6a, uCase6a.app, pCase6a],
    );

    // Case 6b: Valid active link, Person INACTIVE + Account ENABLED
    const pCase6b = nextUuid();
    const uCase6b = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "golf.inactiveperson@hrpartner.vn",
      name: "Golf Inactive Person Enabled Login",
    };
    const lCase6b = nextUuid();
    await seedBaseUser(db, uCase6b, { enabled: true });
    await seedPersonDirect(db, {
      personId: pCase6b,
      employeeCode: "NV-C06B",
      fullName: "Golf Inactive Person Enabled Login",
      status: "INACTIVE",
    });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-16T00:00:00Z', null, 'Case 6b fixture link')`,
      [lCase6b, uCase6b.app, pCase6b],
    );

    // Case 8: Recruiter-only proxy rows (HRP recruiter + Vendor recruiter, NO Person & NO Account)
    const hrpOnlyRecId = nextUuid();
    const vendorOnlyRecId = nextUuid();
    const vendorId = "vnd_pr28_case8";
    await db.query(
      `insert into public.vendors (vendor_id, display_name, active)
       values ($1, 'Vendor Case 8', true)`,
      [vendorId],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Hotel Recruiter Only Proxy', 'REC-ONLY-01', true),
              ($2::uuid, 'India Vendor Proxy Only', 'VND-ONLY-01', true)`,
      [hrpOnlyRecId, vendorOnlyRecId],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2026-01-01'),
              ($2::uuid, 'vendor', $3, true, '2026-01-01')`,
      [hrpOnlyRecId, vendorOnlyRecId, vendorId],
    );

    // Compute exact ground-truth P, U, C at current time (2026-11-21T15:00:00Z)
    const CURRENT_AS_OF = "2026-11-21T15:00:00.000Z";
    const HIST_AS_OF = "2026-03-15T00:00:00.000Z";
    const { rows: [counts] } = await db.query(
      `select
         (select count(*)::int from public.organization_persons) as p_count,
         (select count(*)::int from public.direct_entry_app_users) as u_count,
         (select count(*)::int from public.organization_account_person_links
           where started_at <= $1::timestamptz
             and (ended_at is null or $1::timestamptz < ended_at)) as c_count`,
      [CURRENT_AS_OF],
    );
    const expectedTotal = counts.p_count + counts.u_count - counts.c_count;
    assert.equal(counts.p_count, 6, "6 persons seeded");
    assert.equal(counts.u_count, 14, "7 base + 7 fixture accounts");
    assert.equal(counts.c_count, 3, "3 currently effective links (Case 1, 6a, 6b)");
    assert.equal(expectedTotal, 17, "exact P + U - C = 6 + 14 - 3 = 17");

    // Wire real HTTP handlers + real repository + real PGlite SQL
    const repo = createServiceUserDirectoryRepository(createPgliteNamedRpc(db));
    const deps = { resolveSession: makeFullAdminSession(OWNER), repository: repo };

    // Full list at CURRENT_AS_OF
    const allRes = await listUserDirectoryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory?as_of=${encodeURIComponent(CURRENT_AS_OF)}&page=1&page_size=100`,
      ),
      "true",
      deps,
    );
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.equal(allBody.ok, true);
    assert.equal(allBody.total, expectedTotal);
    assert.equal(allBody.entries.length, expectedTotal);
    assert.deepEqual(allBody.summary, {
      total_all: 17,
      linked_count: 3,
      person_only_count: 3,
      unlinked_account_count: 11,
      conflict_count: 0,
    });

    // Zero auth_subject or account_type leakage anywhere in serialized response
    const rawJson = JSON.stringify(allBody);
    assert.equal(rawJson.includes("account_type"), false, "no account_type key in unified response");
    assert.equal(rawJson.includes(uCase1.auth), false, "no auth_subject leak in unified response");

    const byKey = new Map(allBody.entries.map((e) => [e.directory_entry_key, e]));

    // Verify Case 1 (Linked 1:1)
    const e1 = byKey.get(`person:${pCase1}`);
    assert.ok(e1);
    assert.equal(e1.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(e1.person_id, pCase1);
    assert.equal(e1.account_ref, uCase1.app);
    assert.equal(e1.active_link_id, lCase1);
    assert.equal(e1.login_state, "ENABLED");
    assert.equal(e1.person.active_department.department_id, recDeptId);
    assert.equal(byKey.has(`account:${uCase1.app}`), false, "linked account must not appear as duplicate row");

    // Verify Case 2 (Person without Account)
    const e2 = byKey.get(`person:${pCase2}`);
    assert.ok(e2);
    assert.equal(e2.record_kind, "PERSON_ONLY");
    assert.equal(e2.login_state, "NO_ACCOUNT");
    assert.equal(e2.account_ref, null);
    assert.equal(e2.account, null);
    assert.equal(e2.person.active_department.department_id, accDeptId);

    // Verify Case 3 (Unlinked personal Account stays in main list, zero Person synthesized)
    const e3a = byKey.get(`account:${uCase3a.app}`);
    assert.ok(e3a);
    assert.equal(e3a.record_kind, "UNLINKED_ACCOUNT");
    assert.equal(e3a.person_id, null);
    assert.equal(e3a.person, null);
    assert.equal(e3a.account.login_id, "legacy_39_user");
    assert.equal(e3a.login_state, "ENABLED");

    // Verify Case 4 (Same name/email without canonical link -> 2 distinct rows, NEVER merged!)
    const e4p = byKey.get(`person:${pCase4}`);
    const e4u = byKey.get(`account:${uCase4.app}`);
    assert.ok(e4p && e4u, "Case 4 must emit both Person and Account as separate rows");
    assert.equal(e4p.record_kind, "PERSON_ONLY");
    assert.equal(e4u.record_kind, "UNLINKED_ACCOUNT");
    assert.equal(e4p.display_name, "Delta Same Name");
    assert.equal(e4u.display_name, "Delta Same Name");
    const c4SearchRes = await listUserDirectoryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory?search=${encodeURIComponent("Delta Same Name")}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
      ),
      "true",
      deps,
    );
    const c4Search = await c4SearchRes.json();
    assert.equal(c4Search.total, 2, "searching shared name returns 2 distinct unmerged rows");

    // Verify Case 5 (Historical ended link only -> 2 rows at CURRENT_AS_OF; 1 merged row at HIST_AS_OF!)
    const e5p = byKey.get(`person:${pCase5}`);
    const e5u = byKey.get(`account:${uCase5.app}`);
    assert.ok(e5p && e5u, "Case 5 must NOT merge on ended historical link at current time");
    assert.equal(e5p.record_kind, "PERSON_ONLY");
    assert.equal(e5u.record_kind, "UNLINKED_ACCOUNT");

    const histRes = await listUserDirectoryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory?search=${encodeURIComponent("Echo Historical Link")}&as_of=${encodeURIComponent(HIST_AS_OF)}`,
      ),
      "true",
      deps,
    );
    const histBody = await histRes.json();
    assert.equal(histBody.total, 1, "Case 5 MUST merge at historical as_of inside [started_at, ended_at)");
    assert.equal(histBody.entries[0].record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(histBody.entries[0].person_id, pCase5);
    assert.equal(histBody.entries[0].account_ref, uCase5.app);
    assert.equal(histBody.entries[0].active_link_id, lCase5);

    // Detail lookup at current time preserves link_history on BOTH Person and unlinked Account!
    const detailHistAccRes = await getUserDirectoryEntryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uCase5.app}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
      ),
      "true",
      deps,
    );
    assert.equal(detailHistAccRes.status, 200);
    const detailHistAcc = await detailHistAccRes.json();
    assert.equal(detailHistAcc.entry.record_kind, "UNLINKED_ACCOUNT");
    assert.equal(detailHistAcc.entry.link_history.length, 1);
    assert.equal(detailHistAcc.entry.link_history[0].link_id, lCase5);
    assert.equal(detailHistAcc.entry.link_history[0].ended_at, "2026-06-01T00:00:00.000Z");

    // Verify Case 6a & 6b (Independent Person status vs Account enabled + orthogonal filters!)
    const e6a = byKey.get(`person:${pCase6a}`);
    assert.ok(e6a);
    assert.equal(e6a.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(e6a.person.status, "ACTIVE");
    assert.equal(e6a.account.enabled, false);
    assert.equal(e6a.login_state, "DISABLED");

    const e6b = byKey.get(`person:${pCase6b}`);
    assert.ok(e6b);
    assert.equal(e6b.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(e6b.person.status, "INACTIVE");
    assert.equal(e6b.account.enabled, true);
    assert.equal(e6b.login_state, "ENABLED");

    const f6a = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?person_status=active&login_state=disabled&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(f6a.total, 1);
    assert.equal(f6a.entries[0].person_id, pCase6a);

    const f6b = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?person_status=inactive&login_state=enabled&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(f6b.total, 1);
    assert.equal(f6b.entries[0].person_id, pCase6b);

    // Verify Case 8 (Recruiter-only proxy rows NEVER appear in directory)
    const c8Hrp = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?search=${encodeURIComponent("Hotel Recruiter Only Proxy")}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(c8Hrp.total, 0);
    const c8Vendor = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?search=${encodeURIComponent("India Vendor Proxy Only")}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(c8Vendor.total, 0);

    // Verify Filter-Before-COUNT: escaped literal `_` in search matches ONLY legacy_39_user, NOT legacyX39Xuser!
    const underscoreSearch = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?search=${encodeURIComponent("legacy_39_")}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(underscoreSearch.total, 1, "escaped underscore search must not act as SQL wildcard");
    assert.equal(underscoreSearch.entries[0].account_ref, uCase3a.app);

    // Verify Filter-Before-COUNT by department_id
    const deptFilter = await (
      await listUserDirectoryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory?department_id=${accDeptId}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(deptFilter.total, 1);
    assert.equal(deptFilter.entries[0].person_id, pCase2);

    // Verify Deterministic Server Pagination Across Page Boundaries (page_size = 3 and page_size = 2)
    for (const pageSize of [3, 2]) {
      const collectedKeys = [];
      let page = 1;
      while (true) {
        const pageRes = await listUserDirectoryAdmin(
          new Request(
            `https://bi.local/api/admin/organization/user-directory?as_of=${encodeURIComponent(CURRENT_AS_OF)}&page=${page}&page_size=${pageSize}`,
          ),
          "true",
          deps,
        );
        assert.equal(pageRes.status, 200);
        const pageBody = await pageRes.json();
        assert.equal(pageBody.total, expectedTotal);
        const expectedHasMore = page * pageSize < expectedTotal;
        assert.equal(pageBody.has_more, expectedHasMore);
        for (const entry of pageBody.entries) {
          collectedKeys.push(entry.directory_entry_key);
        }
        if (!pageBody.has_more) break;
        page += 1;
      }
      assert.equal(
        collectedKeys.length,
        expectedTotal,
        `page_size=${pageSize} sweep must cover all ${expectedTotal} rows`,
      );
      assert.equal(
        new Set(collectedKeys).size,
        expectedTotal,
        `page_size=${pageSize} sweep must have zero duplicates across page boundaries`,
      );
      assert.deepEqual(
        collectedKeys,
        allBody.entries.map((e) => e.directory_entry_key),
        `page_size=${pageSize} sweep order must match single-page canonical order exactly`,
      );
    }

    // Verify Deep-Link Detail Resolution: querying by account_ref of a linked user resolves to merged Person+Account!
    const deepLinkedRes = await getUserDirectoryEntryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uCase1.app}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
      ),
      "true",
      deps,
    );
    assert.equal(deepLinkedRes.status, 200);
    const deepLinked = await deepLinkedRes.json();
    assert.equal(deepLinked.entry.directory_entry_key, `person:${pCase1}`);
    assert.equal(deepLinked.entry.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(deepLinked.entry.person_id, pCase1);
    assert.equal(deepLinked.entry.account_ref, uCase1.app);
    assert.equal(deepLinked.entry.department_history.length, 1);
    assert.equal(deepLinked.entry.link_history.length, 1);

    // Deep-Link Detail Resolution: querying by account_ref of unlinked account resolves cleanly (never redirects blindly to Person!)
    const deepUnlinkedRes = await getUserDirectoryEntryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uCase3a.app}&as_of=${encodeURIComponent(CURRENT_AS_OF)}`,
      ),
      "true",
      deps,
    );
    assert.equal(deepUnlinkedRes.status, 200);
    const deepUnlinked = await deepUnlinkedRes.json();
    assert.equal(deepUnlinked.entry.directory_entry_key, `account:${uCase3a.app}`);
    assert.equal(deepUnlinked.entry.record_kind, "UNLINKED_ACCOUNT");
    assert.equal(deepUnlinked.entry.person, null);

    // SQL RBAC enforcement (HR_OPERATOR, RECRUITER, DISABLED_ADMIN -> 42501)
    for (const deniedActor of [HR_OP, REC_ACTOR, DISABLED_ADMIN]) {
      await assert.rejects(
        () =>
          serviceQuery(
            db,
            "select public.org_department_list_user_directory_admin($1::uuid, $2::uuid)",
            [deniedActor.auth, deniedActor.app],
          ),
        (err) => err?.code === "42501",
        `${deniedActor.name} must be denied by SQL RBAC`,
      );
      await assert.rejects(
        () =>
          serviceQuery(
            db,
            "select public.org_department_get_user_directory_entry_admin($1::uuid, $2::uuid, $3::uuid, null)",
            [deniedActor.auth, deniedActor.app, pCase1],
          ),
        (err) => err?.code === "42501",
        `${deniedActor.name} must be denied detail read by SQL RBAC`,
      );
    }

    // Case 7a: Normal schema constraints block inserting a 2nd active link on same Person or same Account
    await assert.rejects(
      () =>
        db.query(
          `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
           values ($1::uuid, $2::uuid, '2026-02-01T00:00:00Z', null, 'Case 7a dup person link')`,
          [uCase3a.app, pCase1],
        ),
      /unique|overlap|ACCOUNT_OR_PERSON_ALREADY_LINKED|duplicate/i,
      "normal DB must reject 2nd active link for the same person",
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
           values ($1::uuid, $2::uuid, '2026-02-01T00:00:00Z', null, 'Case 7a dup account link')`,
          [uCase1.app, pCase2],
        ),
      /unique|overlap|ACCOUNT_OR_PERSON_ALREADY_LINKED|duplicate/i,
      "normal DB must reject 2nd active link for the same account",
    );
  } finally {
    await db.close();
  }
});

test("3. Rev 2 Case 7b (Isolated Anomaly Fixture): Conflicting / Multiple Effective Links NEVER Pick LIMIT 1 or Lose Accounts", async () => {
  const db = await createBootstrappedDb();
  try {
    // Deliberately drop unique indexes & disable guard trigger ONLY inside this isolated test DB
    // to construct a real multi-active-link anomaly fixture and prove defensive reader behavior.
    await db.exec(`
      drop index if exists public.organization_account_person_links_active_account_uidx;
      drop index if exists public.organization_account_person_links_active_person_uidx;
      alter table public.organization_account_person_links
        disable trigger organization_account_person_links_invariants_guard_trg;
    `);

    // Anomaly A: 1 Person linked to 2 Accounts simultaneously (P1 <-> U1a and P1 <-> U1b)
    const p1 = nextUuid();
    const u1a = { auth: nextUuid(), app: nextUuid(), email: "conf.u1a@hrpartner.vn", name: "Conflict Account 1A" };
    const u1b = { auth: nextUuid(), app: nextUuid(), email: "conf.u1b@hrpartner.vn", name: "Conflict Account 1B" };
    const l1a = nextUuid();
    const l1b = nextUuid();
    await seedPersonDirect(db, { personId: p1, employeeCode: "NV-CONF-1", fullName: "Conflict Person 1" });
    await seedBaseUser(db, u1a, { enabled: true });
    await seedBaseUser(db, u1b, { enabled: false });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01T00:00:00Z', null, 'Anomaly A link 1'),
              ($4::uuid, $5::uuid, $3::uuid, '2026-02-01T00:00:00Z', null, 'Anomaly A link 2')`,
      [l1a, u1a.app, p1, l1b, u1b.app],
    );

    // Anomaly B: 1 Account linked to 2 Persons simultaneously (U2 <-> P2a and U2 <-> P2b)
    const p2a = nextUuid();
    const p2b = nextUuid();
    const u2 = { auth: nextUuid(), app: nextUuid(), email: "conf.u2@hrpartner.vn", name: "Conflict Shared Account 2" };
    const l2a = nextUuid();
    const l2b = nextUuid();
    await seedPersonDirect(db, { personId: p2a, employeeCode: "NV-CONF-2A", fullName: "Conflict Person 2A" });
    await seedPersonDirect(db, { personId: p2b, employeeCode: "NV-CONF-2B", fullName: "Conflict Person 2B" });
    await seedBaseUser(db, u2, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-05T00:00:00Z', null, 'Anomaly B link 1'),
              ($4::uuid, $2::uuid, $5::uuid, '2026-02-05T00:00:00Z', null, 'Anomaly B link 2')`,
      [l2a, u2.app, p2a, l2b, p2b],
    );

    const repo = createServiceUserDirectoryRepository(createPgliteNamedRpc(db));
    const deps = { resolveSession: makeFullAdminSession(OWNER), repository: repo };

    const conflictRes = await listUserDirectoryAdmin(
      new Request("https://bi.local/api/admin/organization/user-directory?record_kind=conflict&page=1&page_size=50"),
      "true",
      deps,
    );
    assert.equal(conflictRes.status, 200);
    const conflictBody = await conflictRes.json();

    // All 6 involved records (3 Persons + 3 Accounts) must appear as separate conflict rows; 0 dropped, 0 merged!
    assert.equal(conflictBody.total, 6);
    assert.equal(conflictBody.summary.conflict_count, 6);
    assert.equal(conflictBody.summary.linked_count, 0, "conflicted endpoints must NEVER produce merged rows");

    const byKey = new Map(conflictBody.entries.map((e) => [e.directory_entry_key, e]));

    // Person P1 has MULTIPLE_ACTIVE_LINKS_FOR_PERSON with both link IDs and both accounts
    const ep1 = byKey.get(`person:${p1}`);
    assert.ok(ep1);
    assert.equal(ep1.record_kind, "PERSON_LINK_CONFLICT");
    assert.equal(ep1.account_ref, null);
    assert.equal(ep1.link_conflict, true);
    assert.equal(ep1.identity_mutation_blocked, true);
    assert.equal(ep1.conflict_details.reason, "MULTIPLE_ACTIVE_LINKS_FOR_PERSON");
    assert.deepEqual(ep1.conflict_details.link_ids, [l1a, l1b].sort());
    assert.deepEqual(ep1.conflict_details.related_account_refs, [u1a.app, u1b.app].sort());

    // BOTH Accounts U1a and U1b remain visible and manageable (NEVER silently dropped!)
    for (const [u, lId, expectedLogin] of [
      [u1a, l1a, "ENABLED"],
      [u1b, l1b, "DISABLED"],
    ]) {
      const eu = byKey.get(`account:${u.app}`);
      assert.ok(eu, `account ${u.name} must remain visible`);
      assert.equal(eu.record_kind, "ACCOUNT_LINK_CONFLICT");
      assert.equal(eu.person_id, null);
      assert.equal(eu.login_state, expectedLogin);
      assert.equal(eu.link_conflict, true);
      assert.equal(eu.identity_mutation_blocked, true);
      assert.equal(eu.conflict_details.reason, "ENDPOINT_LINK_CONFLICT");
      assert.deepEqual(eu.conflict_details.link_ids, [lId]);
      assert.deepEqual(eu.conflict_details.related_person_ids, [p1]);
    }

    // Account U2 has MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT with both link IDs and both persons
    const eu2 = byKey.get(`account:${u2.app}`);
    assert.ok(eu2);
    assert.equal(eu2.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(eu2.person_id, null);
    assert.equal(eu2.link_conflict, true);
    assert.equal(eu2.identity_mutation_blocked, true);
    assert.equal(eu2.conflict_details.reason, "MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT");
    assert.deepEqual(eu2.conflict_details.link_ids, [l2a, l2b].sort());
    assert.deepEqual(eu2.conflict_details.related_person_ids, [p2a, p2b].sort());

    // Both P2a and P2b remain visible as PERSON_LINK_CONFLICT
    for (const [pId, lId] of [
      [p2a, l2a],
      [p2b, l2b],
    ]) {
      const ep = byKey.get(`person:${pId}`);
      assert.ok(ep);
      assert.equal(ep.record_kind, "PERSON_LINK_CONFLICT");
      assert.equal(ep.conflict_details.reason, "ENDPOINT_LINK_CONFLICT");
      assert.deepEqual(ep.conflict_details.link_ids, [lId]);
      assert.deepEqual(ep.conflict_details.related_account_refs, [u2.app]);
    }

    // Detail lookup on conflicted account U2 does NOT arbitrarily resolve to P2a or P2b!
    const detailU2Res = await getUserDirectoryEntryAdmin(
      new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${u2.app}`),
      "true",
      deps,
    );
    assert.equal(detailU2Res.status, 200);
    const detailU2 = await detailU2Res.json();
    assert.equal(detailU2.entry.directory_entry_key, `account:${u2.app}`);
    assert.equal(detailU2.entry.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(detailU2.entry.identity_mutation_blocked, true);
    assert.equal(detailU2.entry.link_history.length, 2);

    // Anomaly C (Ponytail P1-2b): Person P_multi (recruiter_id IS NULL) linked to U_multi holding
    // 2 distinct effective verified recruiters (pre-guard/corrupted multi-recruiter state).
    await db.exec(`
      alter table public.direct_entry_app_user_recruiter_links disable trigger all;
    `);
    const rM1 = nextUuid();
    const rM2 = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Recruiter Multi 1', 'REC-M1', true),
              ($2::uuid, 'Recruiter Multi 2', 'REC-M2', true)`,
      [rM1, rM2],
    );
    const pMulti = nextUuid();
    const uMulti = { auth: nextUuid(), app: nextUuid(), email: "multi.rec@hrpartner.vn", name: "Multi Rec Account" };
    await seedPersonDirect(db, { personId: pMulti, employeeCode: "NV-MULTI", fullName: "Multi Rec Person", recruiterId: null });
    await seedBaseUser(db, uMulti, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-10T00:00:00Z', null, 'Link before multi recruiter conflict')`,
      [uMulti.app, pMulti],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, valid_from)
       values ($1::uuid, $2::uuid, true, true, '2026-01-11'),
              ($1::uuid, $3::uuid, true, true, '2026-01-12')`,
      [uMulti.app, rM1, rM2],
    );
    const multiAccDetail = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uMulti.app}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(multiAccDetail.entry.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(multiAccDetail.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");
    const multiPersonDetail = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?person_id=${pMulti}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(multiPersonDetail.entry.record_kind, "PERSON_LINK_CONFLICT");
    assert.equal(multiPersonDetail.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");
  } finally {
    await db.close();
  }
});

test("4. Rev 2 Case 7c (Recruiter-vs-Person Contradiction in Normal Schema) & >25-Row Default Page-Boundary Sweep", async () => {
  const db = await createBootstrappedDb();
  try {
    // Seed 2 HRP recruiters R1 and R2
    const r1 = nextUuid();
    const r2 = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Recruiter One PR28', 'REC-PR28-1', true),
              ($2::uuid, 'Recruiter Two PR28', 'REC-PR28-2', true)`,
      [r1, r2],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2026-01-01'),
              ($2::uuid, 'hrp', null, true, '2026-01-01')`,
      [r1, r2],
    );

    // Person P_rec has recruiter_id = R1, actively linked to Account U_rec,
    // while U_rec has a verified current recruiter link to DIFFERENT recruiter R2!
    const pRec = nextUuid();
    const uRec = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "recruiter.mismatch@hrpartner.vn",
      name: "Recruiter Mismatch User",
    };
    const lRec = nextUuid();
    await seedPersonDirect(db, {
      personId: pRec,
      employeeCode: "NV-REC-CONF",
      fullName: "Recruiter Mismatch Person",
      recruiterId: r1,
    });
    await seedBaseUser(db, uRec, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (link_id, app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01T00:00:00Z', null, 'Valid person-account link before mismatch')`,
      [lRec, uRec.app, pRec],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, valid_from)
       values ($1::uuid, $2::uuid, true, true, '2026-02-01')`,
      [uRec.app, r2],
    );

    // Also seed 22 additional unlinked accounts so total unified rows exceed default page_size=25 (>25 boundary proof!)
    for (let i = 1; i <= 22; i += 1) {
      const pad = String(i).padStart(2, "0");
      await seedBaseUser(db, {
        auth: nextUuid(),
        app: nextUuid(),
        email: `legacy.boundary.${pad}@hrpartner.vn`,
        name: `Legacy Boundary Account ${pad}`,
      });
    }

    const repo = createServiceUserDirectoryRepository(createPgliteNamedRpc(db));
    const deps = { resolveSession: makeFullAdminSession(OWNER), repository: repo };

    // Verify Case 7c: recruiter mismatch flagged on BOTH Person and Account without dropping or merging!
    const confRes = await listUserDirectoryAdmin(
      new Request("https://bi.local/api/admin/organization/user-directory?record_kind=conflict"),
      "true",
      deps,
    );
    assert.equal(confRes.status, 200);
    const confBody = await confRes.json();
    assert.equal(confBody.total, 2);
    const byKey = new Map(confBody.entries.map((e) => [e.directory_entry_key, e]));
    assert.equal(byKey.get(`person:${pRec}`)?.record_kind, "PERSON_LINK_CONFLICT");
    assert.equal(byKey.get(`person:${pRec}`)?.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");
    assert.equal(byKey.get(`person:${pRec}`)?.identity_mutation_blocked, true);
    assert.equal(byKey.get(`account:${uRec.app}`)?.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(byKey.get(`account:${uRec.app}`)?.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");
    assert.equal(byKey.get(`account:${uRec.app}`)?.identity_mutation_blocked, true);

    // Historical as_of = 2026-01-15 (BEFORE conflicting recruiter link valid_from 2026-02-01) cleanly merges!
    const histRes = await getUserDirectoryEntryAdmin(
      new Request(
        `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uRec.app}&as_of=2026-01-15T00:00:00Z`,
      ),
      "true",
      deps,
    );
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.equal(histBody.entry.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(histBody.entry.link_conflict, false);

    // Default page_size=25 boundary proof: 7 base + 2 conflict + 22 boundary = 31 total rows
    // Page 1 has rows 1..25 (has_more=true), Page 2 has rows 26..31 (has_more=false), 0 overlap/gaps!
    const p1 = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?page=1&page_size=25"),
        "true",
        deps,
      )
    ).json();
    const p2 = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?page=2&page_size=25"),
        "true",
        deps,
      )
    ).json();
    assert.equal(p1.total, 31);
    assert.equal(p1.entries.length, 25);
    assert.equal(p1.has_more, true);
    assert.equal(p2.total, 31);
    assert.equal(p2.entries.length, 6);
    assert.equal(p2.has_more, false);

    const combinedKeys = [
      ...p1.entries.map((e) => e.directory_entry_key),
      ...p2.entries.map((e) => e.directory_entry_key),
    ];
    assert.equal(new Set(combinedKeys).size, 31, "zero duplicates across default 25-row page 1/page 2 boundary");
    const singlePage = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?page=1&page_size=100"),
        "true",
        deps,
      )
    ).json();
    assert.deepEqual(
      combinedKeys,
      singlePage.entries.map((e) => e.directory_entry_key),
      "page 1 + page 2 boundary rows match exact canonical single-page order",
    );

    // Ponytail P2-2: record_kind filter counts match summary buckets 1:1 (conflicts excluded from person & unlinked_account!)
    const personFilter = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?record_kind=person"),
        "true",
        deps,
      )
    ).json();
    assert.equal(
      personFilter.total,
      singlePage.summary.linked_count + singlePage.summary.person_only_count,
      "record_kind=person total must match summary.linked_count + person_only_count",
    );
    const unlinkedFilter = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?record_kind=unlinked_account"),
        "true",
        deps,
      )
    ).json();
    assert.equal(
      unlinkedFilter.total,
      singlePage.summary.unlinked_account_count,
      "record_kind=unlinked_account total must match summary.unlinked_account_count",
    );

    // Ponytail P2-1: search MUST NOT match hidden email domain (@hrpartner.vn / @gmail.com)
    const domainSearch = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?search=hrpartner.vn"),
        "true",
        deps,
      )
    ).json();
    assert.equal(domainSearch.total, 0, "search must not leak hidden auth.users email domain");

    // Ponytail P1-1a: R1-deactivated open-ended recruiter link (is_current=false, suspended=false, valid_to=NULL)
    // MUST NOT falsely trigger RECRUITER_IDENTITY_CONFLICT when pinning as_of=<now>!
    const rOld = nextUuid();
    const rNew = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Recruiter Old Deactivated', 'REC-OLD-1', false),
              ($2::uuid, 'Recruiter New Active', 'REC-NEW-1', true)`,
      [rOld, rNew],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2025-01-01'),
              ($2::uuid, 'hrp', null, true, '2026-01-01')`,
      [rOld, rNew],
    );
    const pP1a = nextUuid();
    const uP1a = { auth: nextUuid(), app: nextUuid(), email: "p1a.clean@hrpartner.vn", name: "P1a Clean User" };
    await seedPersonDirect(db, { personId: pP1a, employeeCode: "NV-P1A", fullName: "P1a Clean User", recruiterId: rNew });
    await seedBaseUser(db, uP1a, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-10T00:00:00Z', null, 'Clean link after old recruiter deactivated')`,
      [uP1a.app, pP1a],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, suspended_by_account_disable, valid_from, valid_to)
       values ($1::uuid, $2::uuid, true, false, false, '2025-01-01', null)`,
      [uP1a.app, rOld],
    );
    const p1aNull = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uP1a.app}`),
        "true",
        deps,
      )
    ).json();
    const p1aPinned = await (
      await getUserDirectoryEntryAdmin(
        new Request(
          `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uP1a.app}&as_of=2026-11-21T15:00:00Z`,
        ),
        "true",
        deps,
      )
    ).json();
    assert.equal(p1aNull.entry.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(p1aPinned.entry.record_kind, "LINKED_PERSON_ACCOUNT", "pinned as_of must agree with null as_of on R1-deactivated link");

    // Ponytail P1-1b: Account disabled with conflicting recruiter link (is_current=false, suspended_by_account_disable=true)
    // MUST STILL flag RECRUITER_IDENTITY_CONFLICT even when p_as_of IS NULL!
    await db.query(
      `update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid`,
      [uRec.app],
    );
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set is_current = false, suspended_by_account_disable = true
        where app_user_id = $1::uuid`,
      [uRec.app],
    );
    const p1bDisabled = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uRec.app}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(p1bDisabled.entry.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(p1bDisabled.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");

    // Ponytail P1-2a: Person P_cross has recruiter_id = R_cross, linked to U_cross1, while OTHER account U_cross2 owns R_cross!
    const rCross = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Recruiter Cross Owned', 'REC-CROSS-1', true)`,
      [rCross],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2026-01-01')`,
      [rCross],
    );
    const pCross = nextUuid();
    const uCross1 = { auth: nextUuid(), app: nextUuid(), email: "cross1@hrpartner.vn", name: "Cross Account 1" };
    const uCross2 = { auth: nextUuid(), app: nextUuid(), email: "cross2@hrpartner.vn", name: "Cross Account 2" };
    await seedPersonDirect(db, { personId: pCross, employeeCode: "NV-CROSS", fullName: "Cross Person", recruiterId: rCross });
    await seedBaseUser(db, uCross1, { enabled: true });
    await seedBaseUser(db, uCross2, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-10T00:00:00Z', null, 'Link before cross recruiter conflict')`,
      [uCross1.app, pCross],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, valid_from)
       values ($1::uuid, $2::uuid, true, true, '2026-01-15')`,
      [uCross2.app, rCross],
    );
    const crossDetail = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?person_id=${pCross}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(crossDetail.entry.record_kind, "PERSON_LINK_CONFLICT");
    assert.equal(crossDetail.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");

    // Ponytail P1-2b (Normal Schema Condition 2): Person P_null_rec (recruiter_id IS NULL) linked to U_stolen
    // whose verified effective recruiter R_stolen belongs to ANOTHER Person P_rec_owner!
    const rStolen = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Recruiter Owned By Other Person', 'REC-STOLEN', true)`,
      [rStolen],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2026-01-01')`,
      [rStolen],
    );
    const pRecOwner = nextUuid();
    const pNullRec = nextUuid();
    const uStolen = { auth: nextUuid(), app: nextUuid(), email: "stolen.rec@hrpartner.vn", name: "Stolen Rec Account" };
    await seedPersonDirect(db, { personId: pRecOwner, employeeCode: "NV-OWNER-REC", fullName: "Owner Of Recruiter", recruiterId: rStolen });
    await seedPersonDirect(db, { personId: pNullRec, employeeCode: "NV-NULL-REC", fullName: "Null Rec Person", recruiterId: null });
    await seedBaseUser(db, uStolen, { enabled: true });
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-10T00:00:00Z', null, 'Link where account holds another persons recruiter')`,
      [uStolen.app, pNullRec],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, valid_from)
       values ($1::uuid, $2::uuid, true, true, '2026-01-11')`,
      [uStolen.app, rStolen],
    );
    const stolenAccDetail = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uStolen.app}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(stolenAccDetail.entry.record_kind, "ACCOUNT_LINK_CONFLICT");
    assert.equal(stolenAccDetail.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");
    const stolenPersonDetail = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?person_id=${pNullRec}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(stolenPersonDetail.entry.record_kind, "PERSON_LINK_CONFLICT");
    assert.equal(stolenPersonDetail.entry.conflict_details?.reason, "RECRUITER_IDENTITY_CONFLICT");

    // Ponytail P2-3: Whitespace-only email local-part projects login_id = null cleanly (never 503!)
    const uSpace = { auth: nextUuid(), app: nextUuid(), email: "   @hrpartner.vn", name: "Whitespace Local Email" };
    await seedBaseUser(db, uSpace, { enabled: true });
    const spaceDetailRes = await getUserDirectoryEntryAdmin(
      new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uSpace.app}`),
      "true",
      deps,
    );
    assert.equal(spaceDetailRes.status, 200);
    const spaceDetail = await spaceDetailRes.json();
    assert.equal(spaceDetail.entry.account.login_id, null);
  } finally {
    await db.close();
  }
});

test("5. UX-01 DB E2E: Completing legacy account-only entry (create-new-person+dept OR link-existing-person) collapses into 1 linked user directory row without creating new auth account", async () => {
  const db = await createBootstrappedDb();
  try {
    const repo = createServiceUserDirectoryRepository(createPgliteNamedRpc(db));
    const deps = { resolveSession: makeFullAdminSession(OWNER), repository: repo };
    const deptRow = (
      await db.query(
        `select department_id, name from public.organization_departments where is_active = true order by code limit 1`,
      )
    ).rows[0];
    assert.ok(deptRow?.department_id, "Active department must exist");

    // Path A: Legacy personal account without Person -> create Person + Department + Link atomically via org_department_create_person_admin
    const uLegacyCreate = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "legacy.ux01.create@hrpartner.vn",
      name: "Nhân Viên Cũ Tạo Hồ Sơ",
    };
    await seedBaseUser(db, uLegacyCreate, { enabled: true });

    const beforeCreate = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?search=legacy.ux01.create"),
        "true",
        deps,
      )
    ).json();
    assert.equal(beforeCreate.total, 1);
    assert.equal(beforeCreate.entries[0].record_kind, "UNLINKED_ACCOUNT");
    assert.equal(beforeCreate.entries[0].person_id, null);
    assert.equal(beforeCreate.entries[0].account.version, 1);

    const authCountBefore = Number((await db.query(`select count(*) as c from auth.users`)).rows[0].c);
    const createRes = (
      await serviceQuery(
        db,
        `select public.org_department_create_person_admin(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::date, $6::uuid, $7::uuid, $8::integer, null::uuid, $9::text, $10::uuid, $11::text
         ) as payload`,
        [
          OWNER.auth,
          OWNER.app,
          "NV-UX01-A",
          "Nhân Viên Cũ Tạo Hồ Sơ",
          "2026-02-01",
          deptRow.department_id,
          uLegacyCreate.app,
          1,
          "Hoàn thiện hồ sơ nhân viên và phòng ban cho tài khoản hiện hữu",
          nextUuid(),
          sha256("ux01-create-and-link"),
        ],
      )
    ).rows[0].payload;
    const createdPersonId = createRes.person.person_id;
    assert.ok(createdPersonId);

    // Zero new Auth accounts created!
    const authCountAfter = Number((await db.query(`select count(*) as c from auth.users`)).rows[0].c);
    assert.equal(authCountAfter, authCountBefore, "UX-01 completion must NEVER create a second Auth account");

    const afterCreate = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?search=legacy.ux01.create"),
        "true",
        deps,
      )
    ).json();
    assert.equal(afterCreate.total, 1, "Account-only entry must collapse cleanly into 1 linked row");
    assert.equal(afterCreate.entries[0].record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(afterCreate.entries[0].person_id, createdPersonId);
    assert.equal(afterCreate.entries[0].person.employee_code, "NV-UX01-A");
    assert.equal(afterCreate.entries[0].person.active_department.department_id, deptRow.department_id);

    const detailAfterCreate = await (
      await getUserDirectoryEntryAdmin(
        new Request(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${uLegacyCreate.app}`),
        "true",
        deps,
      )
    ).json();
    assert.equal(detailAfterCreate.entry.record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(detailAfterCreate.entry.person_id, createdPersonId);

    // Path B: Legacy personal account + existing unlinked Person -> explicit manual link via org_department_link_account_person_admin
    const uLegacyLink = {
      auth: nextUuid(),
      app: nextUuid(),
      email: "legacy.ux01.link@hrpartner.vn",
      name: "Nhân Viên Cũ Gắn Sẵn",
    };
    await seedBaseUser(db, uLegacyLink, { enabled: true });
    const existingPersonId = nextUuid();
    await seedPersonDirect(db, {
      personId: existingPersonId,
      employeeCode: "NV-UX01-B",
      fullName: "Nhân Viên Cũ Gắn Sẵn",
      status: "ACTIVE",
    });

    const beforeLink = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?search=G%E1%BA%AFn%20S%E1%BA%B5n"),
        "true",
        deps,
      )
    ).json();
    assert.equal(beforeLink.total, 2, "Before explicit link, unlinked account and unlinked person remain 2 separate rows (zero auto-merge)");

    await serviceQuery(
      db,
      `select public.org_department_link_account_person_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null::uuid, $5::text, $6::uuid, $7::text
       )`,
      [
        OWNER.auth,
        OWNER.app,
        uLegacyLink.app,
        existingPersonId,
        "Liên kết tài khoản đăng nhập hiện hữu với hồ sơ nhân viên",
        nextUuid(),
        sha256("ux01-link-existing"),
      ],
    );

    const afterLink = await (
      await listUserDirectoryAdmin(
        new Request("https://bi.local/api/admin/organization/user-directory?search=G%E1%BA%AFn%20S%E1%BA%B5n"),
        "true",
        deps,
      )
    ).json();
    assert.equal(afterLink.total, 1, "Explicit manual link collapses the 2 entries into 1 linked row");
    assert.equal(afterLink.entries[0].record_kind, "LINKED_PERSON_ACCOUNT");
    assert.equal(afterLink.entries[0].person_id, existingPersonId);
    assert.equal(afterLink.entries[0].account_ref, uLegacyLink.app);
  } finally {
    await db.close();
  }
});
