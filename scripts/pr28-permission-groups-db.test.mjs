import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  assignAccountGroupAdmin,
  createPermissionGroupAdmin,
  getAccountGroupsAdmin,
  listPermissionGroupsAdmin,
  removeAccountGroupAdmin,
  updatePermissionGroupAdmin,
} from "../src/lib/admin/permission-group-api.ts";
import { createServicePermissionGroupRepository } from "../src/lib/admin/permission-group-repository.ts";
import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  PR28_PERMISSION_GROUPS_FOUNDATION_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const SAME_ORIGIN_JSON = {
  host: "bi.local",
  origin: "https://bi.local",
  "content-type": "application/json",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `77000000-0000-4000-8000-${hex}`;
}

const OWNER = {
  auth: "77000000-0000-4000-8000-00000000a001",
  app: "77000000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner Admin PR28",
};
const LUANPT = {
  auth: "77000000-0000-4000-8000-00000000a002",
  app: "77000000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "77000000-0000-4000-8000-00000000a003",
  app: "77000000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "77000000-0000-4000-8000-00000000a004",
  app: "77000000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

async function initAuthSchema(db) {
  await db.exec(`
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
}

async function listMigrationFiles() {
  const files = await readdir(MIGRATION_DIR);
  return files.filter((f) => f.endsWith(".sql")).sort();
}

async function seedBaseUser(db, user, { enabled = true, adminLegacy = false, authzManaged = true } = {}) {
  await db.query(`insert into auth.users (id, email) values ($1::uuid, $2) on conflict (id) do nothing`, [
    user.auth,
    user.email,
  ]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed)
     values ($1::uuid, $2::uuid, $3, $4, $5)
     on conflict (app_user_id) do nothing`,
    [user.app, user.auth, user.name, enabled, authzManaged],
  );
  if (adminLegacy) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, '2026-01-01', true) on conflict do nothing`,
      [user.app],
    );
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true) on conflict do nothing`,
        [user.app, cap],
      );
    }
  }
}

async function createBootstrappedDb() {
  const db = new PGlite();
  await initAuthSchema(db);
  const names = await listMigrationFiles();
  const groupsIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(groupsIdx >= 0);

  // Apply up to BEFORE Migration #236, seed canonical 4 BoD/Admin users & run WP5 cutover,
  // THEN apply Migration #236 to prove real idempotent backfill of Owner is_protected + ADMIN!
  for (const name of names.slice(0, groupsIdx)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await seedBaseUser(db, OWNER, { enabled: true, adminLegacy: true, authzManaged: false });
  await seedBaseUser(db, LUANPT, { enabled: true, adminLegacy: true, authzManaged: false });
  await seedBaseUser(db, LIENVU, { enabled: true, adminLegacy: true, authzManaged: false });
  await seedBaseUser(db, NGATTT, { enabled: true, adminLegacy: true, authzManaged: false });

  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.ok(plan.manifest_fingerprint);
  const apply = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(apply.status, "APPLIED");

  // Now apply Migration #236
  await db.exec(await readFile(path.join(MIGRATION_DIR, PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME), "utf8"));
  return db;
}

const RPC_TYPES = {
  direct_entry_authz_list_groups_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_department_id: "uuid",
    p_include_inactive: "boolean",
  },
  direct_entry_authz_create_group_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_code: "text",
    p_name: "text",
    p_description: "text",
    p_department_id: "uuid",
    p_team_id: "uuid",
    p_capabilities: "text[]",
    p_module_roles: "jsonb",
    p_reason: "text",
    p_idempotency_key: "uuid",
    p_request_hash: "text",
  },
  direct_entry_authz_update_group_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_group_id: "uuid",
    p_expected_version: "integer",
    p_name: "text",
    p_description: "text",
    p_department_id: "uuid",
    p_team_id: "uuid",
    p_active: "boolean",
    p_capabilities: "text[]",
    p_module_roles: "jsonb",
    p_reason: "text",
    p_idempotency_key: "uuid",
    p_request_hash: "text",
  },
  direct_entry_authz_assign_group_member_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_target_app_user_id: "uuid",
    p_group_id: "uuid",
    p_expected_account_version: "integer",
    p_reason: "text",
    p_idempotency_key: "uuid",
    p_request_hash: "text",
  },
  direct_entry_authz_remove_group_member_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_target_app_user_id: "uuid",
    p_membership_id: "uuid",
    p_expected_account_version: "integer",
    p_reason: "text",
    p_idempotency_key: "uuid",
    p_request_hash: "text",
  },
  direct_entry_authz_get_account_groups_admin: {
    p_auth_subject: "uuid",
    p_actor_app_user_id: "uuid",
    p_target_app_user_id: "uuid",
  },
};

function createPgliteNamedRpc(db) {
  return async (fnName, params) => {
    const typeMap = RPC_TYPES[fnName];
    assert.ok(typeMap, `missing RPC_TYPES for ${fnName}`);
    const entries = Object.entries(params);
    const placeholders = entries.map(([k], i) => `${k} => $${i + 1}::${typeMap[k]}`).join(", ");
    const values = entries.map(([k, v]) => (typeMap[k] === "jsonb" && v !== null ? JSON.stringify(v) : v));
    try {
      const { rows } = await db.query(`select public.${fnName}(${placeholders}) as res`, values);
      return { data: rows[0]?.res ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: err?.code ?? null,
          message: err?.message ?? String(err),
          details: err?.detail ?? null,
        },
      };
    }
  };
}

function makeDbSessionResolver(db, actor) {
  return async () => {
    const { rows } = await db.query(`select public.direct_entry_resolve_actor_context($1::uuid) as ctx`, [actor.auth]);
    const ctx = rows[0]?.ctx;
    if (!ctx) return { actor: { ok: false, reason: "ACTOR_NOT_AVAILABLE" } };
    const scopes = Array.isArray(ctx.scopes)
      ? ctx.scopes
      : Array.isArray(ctx.all_scope_grants)
        ? ctx.all_scope_grants.map((s) => ({
            kind: s.scope_kind ?? s.kind,
            reference: s.team_id ?? s.scope_kind ?? "all",
            valid_from: s.valid_from ?? "2026-01-01",
            valid_to: s.valid_to ?? null,
          }))
        : [];
    return {
      actor: {
        ok: true,
        actor: {
          ...ctx,
          auth_subject: actor.auth,
          app_user_id: ctx.app_user_id ?? actor.app,
          capabilities: Array.isArray(ctx.capabilities) ? ctx.capabilities : [],
          scopes,
          effective_grants: Array.isArray(ctx.effective_grants) ? ctx.effective_grants : [],
        },
      },
    };
  };
}

test("1. Migration #236 hygiene, atomic rollback, dynamic S0-T1-C allowlist (+6 RPCs), and 5 seed groups + Owner backfill", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("\r\n"), false, "Migration #236 must use LF line endings");
  assert.equal(sql.includes("@"), false, "Migration #236 must have zero literal @");
  assert.equal(/\bsavepoint\b/i.test(sql), false, "zero SAVEPOINT");
  assert.equal(/'40001'/.test(sql), false, "zero '40001'");
  assert.equal(/alter default privileges/i.test(sql), false, "zero ALTER DEFAULT PRIVILEGES");

  const db = new PGlite();
  try {
    await initAuthSchema(db);
    const names = await listMigrationFiles();
    const groupsIdx = names.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const preApplied = names.slice(0, groupsIdx);
    for (const name of preApplied) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(preApplied.map((n) => [n, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);

    // Atomic rollback leaves zero drift
    const stripped = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await db.exec("begin;");
    await db.exec(stripped);
    await db.exec("rollback;");
    const afterRb = await db.query(`select to_regclass('public.authz_user_groups') as tbl`);
    assert.equal(afterRb.rows[0].tbl, null, "rollback must leave zero new tables");

    // Apply #236 cleanly
    await db.exec(sql);
    const postFlags = new Map([...preFlags, [PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(db, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(
      postCheck.details.actualServiceCount - preCheck.details.actualServiceCount,
      PR28_PERMISSION_GROUPS_FOUNDATION_RPC_SIGNATURES.length,
      "exact +6 net service_role RPCs",
    );
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "zero client/PUBLIC EXECUTE grants");

    // Seed groups check (11 exact 1:1 D1/D4 seed groups)
    const { rows: groups } = await db.query(`
      select g.code, g.name, g.is_system_admin, g.team_id, d.system_key as dept_key,
             (select count(*)::int from public.authz_user_group_capabilities c where c.group_id = g.group_id and c.ended_at is null) as cap_count,
             (select count(*)::int from public.authz_user_group_module_roles mr where mr.group_id = g.group_id and mr.ended_at is null) as mr_count
        from public.authz_user_groups g
        join public.organization_departments d on d.department_id = g.department_id
       order by g.code
    `);
    assert.equal(groups.length, 11);
    const byCode = new Map(groups.map((r) => [r.code, r]));
    assert.equal(byCode.get("SYSTEM_ADMIN")?.cap_count, 21);
    assert.equal(byCode.get("SYSTEM_ADMIN")?.name, "BoD/Admin");
    assert.equal(byCode.get("SYSTEM_ADMIN")?.dept_key, "MANAGEMENT_BOD");
    assert.equal(byCode.get("HR_CATALOG_OPERATOR")?.cap_count, 5);
    assert.equal(byCode.get("RECRUITER_OPERATIONS")?.cap_count, 7);
    assert.equal(byCode.get("ACCOUNTING_OPERATIONS")?.cap_count, 1);
    assert.equal(byCode.get("LEAVE_HR_OPERATIONS")?.mr_count, 1);
    assert.equal(byCode.get("LEAVE_REPORT_VIEWER")?.mr_count, 1);
    assert.equal(byCode.get("LEAVE_BOD_APPROVER")?.mr_count, 1);
    assert.equal(byCode.get("VFIN_GLOBAL_VIEWER")?.mr_count, 1);
    assert.equal(byCode.get("VFIN_GLOBAL_RECONCILER")?.mr_count, 1);
    assert.equal(byCode.get("VFIN_CASH_HOLDER")?.mr_count, 1);
    assert.equal(byCode.get("VFIN_CASH_HOLDER_RECORD_BEHALF")?.mr_count, 1);
  } finally {
    await db.close();
  }
});

test("2. D1 Anti-Cartesian & Ceiling Enforcement: no cross-group stitching, no MANAGEMENT_BOD auto-admin, no entry_admin on regular groups", async () => {
  const db = await createBootstrappedDb();
  try {
    const repo = createServicePermissionGroupRepository(createPgliteNamedRpc(db));
    const ownerDeps = { resolveSession: makeDbSessionResolver(db, OWNER), repository: repo };

    const { rows: depts } = await db.query(
      `select department_id, system_key from public.organization_departments`,
    );
    const deptByKey = new Map(depts.map((d) => [d.system_key, d.department_id]));

    // Seed 2 recruitment teams T1 and T2
    const t1 = nextUuid();
    const t2 = nextUuid();
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TEAM_PR28_1', 'Đội PR28 1', true),
              ($2::uuid, 'TEAM_PR28_2', 'Đội PR28 2', true)`,
      [t1, t2],
    );

    // Ceiling 1: Regular dept group CANNOT receive entry_admin
    const badAdminRes = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          code: "FAKE_ADMIN",
          name: "Nhóm giả Admin",
          department_id: deptByKey.get("MANAGEMENT_BOD"),
          capabilities: ["entry_admin"],
        }),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(badAdminRes.status, 400);
    assert.equal((await badAdminRes.json()).code, "GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP");

    // Ceiling 2: Team group MUST belong to RECRUITMENT department
    const badTeamDeptRes = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          code: "ACC_TEAM_BAD",
          name: "Kế toán gắn đội sai",
          department_id: deptByKey.get("ACCOUNTING"),
          team_id: t1,
          capabilities: ["entry_team"],
        }),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(badTeamDeptRes.status, 400);
    assert.equal((await badTeamDeptRes.json()).code, "GROUP_TEAM_REQUIRES_RECRUITMENT_DEPARTMENT");

    // Ceiling 3: Team group CANNOT hold module_roles
    const badTeamMrRes = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          code: "TEAM_MR_BAD",
          name: "Đội có module role sai",
          department_id: deptByKey.get("RECRUITMENT"),
          team_id: t1,
          capabilities: ["entry_team"],
          module_roles: [{ module_code: "leave", role_code: "HR_REPORT_VIEWER" }],
        }),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(badTeamMrRes.status, 400);
    assert.equal((await badTeamMrRes.json()).code, "GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP");

    // Create 2 valid team groups: Group A (T1: entry_team + report_view), Group B (T2: report_review)
    const gARes = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          code: "TEAM_T1_VIEW",
          name: "Quản lý Đội 1",
          department_id: deptByKey.get("RECRUITMENT"),
          team_id: t1,
          capabilities: ["entry_team", "report_view"],
        }),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(gARes.status, 201);
    const gA = (await gARes.json()).group;

    const gBRes = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          code: "TEAM_T2_REVIEW",
          name: "Duyệt báo cáo Đội 2",
          department_id: deptByKey.get("RECRUITMENT"),
          team_id: t2,
          capabilities: ["report_review"],
        }),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(gBRes.status, 201);
    const gB = (await gBRes.json()).group;

    // Seed user U with MANAGEMENT_BOD department membership (MUST NOT auto-grant Admin!)
    const uCross = { auth: nextUuid(), app: nextUuid(), email: "cross.group@hrpartner.vn", name: "Cross Group User" };
    await seedBaseUser(db, uCross, { enabled: true, authzManaged: true });
    const pBod = nextUuid();
    await db.query(
      `insert into public.organization_persons (person_id, employee_code, full_name, status)
       values ($1::uuid, 'NV-BOD-MEM', 'BOD Member Not Admin', 'ACTIVE')`,
      [pBod],
    );
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-01T00:00:00Z', 'Seed BOD member')`,
      [uCross.app, pBod],
    );
    await db.query(
      `insert into public.organization_person_department_memberships (person_id, department_id, started_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-01T00:00:00Z', 'Member of MANAGEMENT_BOD')`,
      [pBod, deptByKey.get("MANAGEMENT_BOD")],
    );

    // Verify MANAGEMENT_BOD membership alone NEVER grants SYSTEM_ADMIN
    const { rows: bodAdminCheck } = await db.query(
      `select public.direct_entry_authz__internal_group_is_system_admin($1::uuid) as is_admin`,
      [uCross.app],
    );
    assert.equal(bodAdminCheck[0].is_admin, false, "MANAGEMENT_BOD dept membership must NEVER grant Admin");
    const nonAdminList = await listPermissionGroupsAdmin(
      new Request("https://bi.local/api/admin/access/groups"),
      "true",
      { resolveSession: makeDbSessionResolver(db, uCross), repository: repo },
    );
    assert.equal(nonAdminList.status, 403);

    // Assign U to BOTH Group A (T1) and Group B (T2)
    const a1 = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uCross.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: gA.group_id, expected_account_version: 1 }),
      }),
      uCross.app,
      "true",
      ownerDeps,
    );
    assert.equal(a1.status, 201);
    const v2 = (await a1.json()).membership.account_version;

    const a2 = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uCross.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: gB.group_id, expected_account_version: v2 }),
      }),
      uCross.app,
      "true",
      ownerDeps,
    );
    assert.equal(a2.status, 201);

    // Anti-Cartesian verification on direct group primitives & compatibility projection
    const { rows: checks } = await db.query(
      `select
         public.direct_entry_authz__internal_group_has_capability($1::uuid, 'entry_team', null, $2::uuid) as et_t1,
         public.direct_entry_authz__internal_group_has_capability($1::uuid, 'entry_team', null, $3::uuid) as et_t2,
         public.direct_entry_authz__internal_group_has_capability($1::uuid, 'report_review', null, $2::uuid) as rr_t1,
         public.direct_entry_authz__internal_group_has_capability($1::uuid, 'report_review', null, $3::uuid) as rr_t2,
         public.direct_entry_authz__internal_group_team_ids($1::uuid, 'entry_team') as et_teams,
         public.direct_entry_authz__internal_group_team_ids($1::uuid, 'report_review') as rr_teams,
         public.direct_entry_authz__internal_resolve_effective_grants($1::uuid) as grants`,
      [uCross.app, t1, t2],
    );
    assert.equal(checks[0].et_t1, true);
    assert.equal(checks[0].et_t2, false, "entry_team from T1 group must NEVER leak to T2");
    assert.equal(checks[0].rr_t1, false, "report_review from T2 group must NEVER leak to T1");
    assert.equal(checks[0].rr_t2, true);
    assert.deepEqual(checks[0].et_teams, [t1]);
    assert.deepEqual(checks[0].rr_teams, [t2]);

    const grants = checks[0].grants;
    assert.equal(
      grants.some((g) => g.scope_kind === "ALL"),
      false,
      "team-scoped groups must NEVER emit ALL scope",
    );
    assert.equal(
      grants.some((g) => g.capability === "entry_team" && g.scope_id === t2),
      false,
    );
    assert.equal(
      grants.some((g) => g.capability === "report_review" && g.scope_id === t1),
      false,
    );
  } finally {
    await db.close();
  }
});

test("3. D2/D3 Owner Protection, Non-Protected Admin Removal, C4 PM-Only Recruitment Posts & D10 Disabled", async () => {
  const db = await createBootstrappedDb();
  try {
    const repo = createServicePermissionGroupRepository(createPgliteNamedRpc(db));
    const ownerDeps = { resolveSession: makeDbSessionResolver(db, OWNER), repository: repo };

    // Verify Owner was backfilled into SYSTEM_ADMIN with is_protected = true
    const ownerGroupsRes = await getAccountGroupsAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${OWNER.app}/groups`),
      OWNER.app,
      "true",
      ownerDeps,
    );
    assert.equal(ownerGroupsRes.status, 200);
    const ownerGroups = await ownerGroupsRes.json();
    const ownerAdminMem = ownerGroups.memberships.find((m) => m.group_code === "SYSTEM_ADMIN");
    assert.ok(ownerAdminMem, "Owner must have backfilled SYSTEM_ADMIN membership");
    assert.equal(ownerAdminMem.is_protected, true);
    assert.equal(ownerAdminMem.can_remove, false);
    assert.equal(ownerAdminMem.cannot_remove_reason, "PROTECTED_OWNER_ADMIN");

    // Attempt to remove Owner from SYSTEM_ADMIN (even by Owner!) -> 409 AUTHZ_PROTECTED_ASSIGNMENT, 0 version bump
    const ownerVerBefore = ownerGroups.account_version;
    const remOwnerRes = await removeAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${OWNER.app}/groups/${ownerAdminMem.membership_id}`, {
        method: "DELETE",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ expected_account_version: ownerVerBefore }),
      }),
      OWNER.app,
      ownerAdminMem.membership_id,
      "true",
      ownerDeps,
    );
    assert.equal(remOwnerRes.status, 409);
    assert.equal((await remOwnerRes.json()).code, "AUTHZ_PROTECTED_ASSIGNMENT");
    const ownerVerAfter = (
      await db.query(`select version from public.direct_entry_app_users where app_user_id = $1::uuid`, [OWNER.app])
    ).rows[0].version;
    assert.equal(ownerVerAfter, ownerVerBefore, "blocked Owner removal must not bump version");

    // Direct SQL DELETE / UPDATE on protected Owner membership also blocked by DB trigger!
    await assert.rejects(
      db.query(`delete from public.authz_user_group_members where membership_id = $1::uuid`, [ownerAdminMem.membership_id]),
      /AUTHZ_PROTECTED_ASSIGNMENT/,
    );
    await assert.rejects(
      db.query(
        `update public.authz_user_group_members set ended_at = now(), ended_by_app_user_id = $2::uuid where membership_id = $1::uuid`,
        [ownerAdminMem.membership_id, OWNER.app],
      ),
      /AUTHZ_PROTECTED_ASSIGNMENT/,
    );

    // Non-protected Admin (LUANPT) CAN be removed cleanly (and closes backfilled ADMIN role) while preserving independent TL assignment!
    const teamId = nextUuid();
    const tlRecId = nextUuid();
    await db.query(
      `insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'TL_KEEP_T', 'Đội giữ TL', true)`,
      [teamId],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Luan TL Recruiter', 'REC-TL-KEEP', true)`,
      [tlRecId],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, is_current, valid_from)
       values ($1::uuid, 'hrp', null, true, '2026-01-01')`,
      [tlRecId],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, is_current, valid_from)
       values ($1::uuid, $2::uuid, true, true, '2026-01-01')`,
      [LUANPT.app, tlRecId],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (leader_app_user_id, leader_recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [LUANPT.app, tlRecId, teamId],
    );

    const luanGroups = await (
      await getAccountGroupsAdmin(
        new Request(`https://bi.local/api/admin/access/accounts/${LUANPT.app}/groups`),
        LUANPT.app,
        "true",
        ownerDeps,
      )
    ).json();
    const luanAdminMem = luanGroups.memberships.find((m) => m.group_code === "SYSTEM_ADMIN");
    assert.ok(luanAdminMem && luanAdminMem.is_protected === false && luanAdminMem.can_remove === true);

    const remLuanRes = await removeAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${LUANPT.app}/groups/${luanAdminMem.membership_id}`, {
        method: "DELETE",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ expected_account_version: luanGroups.account_version, reason: "Rút quyền BoD/Admin" }),
      }),
      LUANPT.app,
      luanAdminMem.membership_id,
      "true",
      ownerDeps,
    );
    assert.equal(remLuanRes.status, 200);

    // LUANPT immediately loses Admin access, while keeping independent TEAM_LEADER assignment!
    const luanAfter = await db.query(
      `select
         public.direct_entry_authz__internal_group_is_system_admin($1::uuid) as is_sys_admin,
         public.direct_entry_authz__internal_has_paired_capability($1::uuid, 'entry_admin', 'ALL', null) as has_admin,
         public.direct_entry_authz__internal_has_paired_capability($1::uuid, 'entry_team', 'CONTEXT_TEAM', $2::text) as has_tl`,
      [LUANPT.app, teamId],
    );
    assert.equal(luanAfter.rows[0].is_sys_admin, false);
    assert.equal(luanAfter.rows[0].has_admin, false, "revoking SYSTEM_ADMIN group must immediately revoke entry_admin");
    assert.equal(luanAfter.rows[0].has_tl, true, "independent TEAM_LEADER assignment must remain untouched");

    // C4 invariant: SYSTEM_ADMIN group member who is NOT active PM of project P CANNOT create recruitment post for P!
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active) values ('proj_c4_test', 'Dự án C4', true)`,
    );
    const { rows: pmCheck } = await db.query(
      `select public.direct_entry_actor_is_assigned_project_manager($1::uuid, 'proj_c4_test') as is_pm`,
      [OWNER.app],
    );
    assert.equal(pmCheck[0].is_pm, false, "SYSTEM_ADMIN must NOT bypass C4 active PM requirement");

    // D10: Disabled Owner resolves 0 grants & is_system_admin = false while keeping protected membership intact
    await db.query(`update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid`, [OWNER.app]);
    const disabledCheck = await db.query(
      `select
         public.direct_entry_authz__internal_group_is_system_admin($1::uuid) as is_sys_admin,
         public.direct_entry_authz__internal_resolve_effective_grants($1::uuid) as grants`,
      [OWNER.app],
    );
    assert.equal(disabledCheck.rows[0].is_sys_admin, false);
    assert.deepEqual(disabledCheck.rows[0].grants, []);
  } finally {
    await db.close();
  }
});

test("4. D4 Group-Managed Finance & Leave Module Roles + Idempotency + OCC (Zero Side-Effects on Resource Assignments)", async () => {
  const db = await createBootstrappedDb();
  try {
    const repo = createServicePermissionGroupRepository(createPgliteNamedRpc(db));
    const ownerDeps = { resolveSession: makeDbSessionResolver(db, OWNER), repository: repo };

    const { rows: depts } = await db.query(
      `select department_id, system_key from public.organization_departments`,
    );
    const deptByKey = new Map(depts.map((d) => [d.system_key, d.department_id]));

    // Create a D4 VFIN Cash Holder group
    const createKey = nextUuid();
    const createBody = {
      code: "VFIN_CASH_GROUP",
      name: "Thủ quỹ Tài chính NCC",
      description: "Quản lý cấp vốn & đối soát NCC toàn công ty",
      department_id: deptByKey.get("ACCOUNTING"),
      team_id: null,
      capabilities: ["vendor_finance_view"],
      module_roles: [{ module_code: "vendor_finance", role_code: "CASH_HOLDER" }],
      reason: "Tạo nhóm thủ quỹ theo D4",
    };
    const c1 = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": createKey },
        body: JSON.stringify(createBody),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(c1.status, 201);
    const cashGroup = (await c1.json()).group;

    // Idempotency replay returns same group with replayed = true
    const cReplay = await createPermissionGroupAdmin(
      new Request("https://bi.local/api/admin/access/groups", {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": createKey },
        body: JSON.stringify(createBody),
      }),
      "true",
      ownerDeps,
    );
    assert.equal(cReplay.status, 200);
    assert.equal((await cReplay.json()).group.replayed, true);

    // Seed an Accounting user U_FIN holding direct GLOBAL_VIEWER + PROJECT_ACCOUNTANT on Project P1
    const uFin = { auth: nextUuid(), app: nextUuid(), email: "u.fin.d4@hrpartner.vn", name: "Accountant D4" };
    await seedBaseUser(db, uFin, { enabled: true, authzManaged: true });
    const pFin = nextUuid();
    await db.query(
      `insert into public.organization_persons (person_id, employee_code, full_name, status)
       values ($1::uuid, 'NV-FIN-D4', 'Accountant D4', 'ACTIVE')`,
      [pFin],
    );
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-01T00:00:00Z', 'Seed Fin')`,
      [uFin.app, pFin],
    );
    await db.query(
      `insert into public.organization_person_department_memberships (person_id, department_id, started_at, reason)
       values ($1::uuid, $2::uuid, '2026-01-01T00:00:00Z', 'Seed Accounting Dept')`,
      [pFin, deptByKey.get("ACCOUNTING")],
    );
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active) values ('proj_d4_vfin', 'Dự án D4', true)`,
    );
    await db.exec("begin; set local vendor_finance.admin_write_marker = 'on';");
    await db.query(
      `insert into public.vendor_finance_global_roles (app_user_id, role_code, valid_from, version, granted_by_user_id, grant_reason)
       values ($1::uuid, 'GLOBAL_VIEWER', '2026-01-01', 1, $2::uuid, 'Direct viewer')`,
      [uFin.app, OWNER.app],
    );
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, valid_from, version, assigned_by_user_id, assign_reason)
       values ('proj_d4_vfin', $1::uuid, '2026-01-01', 1, $2::uuid, 'Assigned PA')`,
      [uFin.app, OWNER.app],
    );
    await db.exec("commit;");

    // Before joining Cash Holder group: resolves GLOBAL_VIEWER (can_fund = false)
    const finBefore = (
      await db.query(`select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uFin.auth,
        uFin.app,
      ])
    ).rows[0].auth;
    assert.equal(finBefore.global_role_code, "GLOBAL_VIEWER");
    assert.equal(finBefore.can_fund_vendor_advance, false);
    assert.equal(finBefore.active_assigned_project_count, 1);

    // Assign U_FIN to VFIN_CASH_GROUP -> elevates immediately to CASH_HOLDER!
    const assignFin = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uFin.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: cashGroup.group_id, expected_account_version: 1 }),
      }),
      uFin.app,
      "true",
      ownerDeps,
    );
    assert.equal(assignFin.status, 201);
    const finMembership = (await assignFin.json()).membership;

    const finDuring = (
      await db.query(`select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uFin.auth,
        uFin.app,
      ])
    ).rows[0].auth;
    assert.equal(finDuring.global_role_code, "CASH_HOLDER");
    assert.equal(finDuring.can_fund_vendor_advance, true);
    assert.equal(finDuring.reconcile_scope, "ALL");

    // Stale OCC version on remove -> 409 VERSION_CONFLICT with current_version
    const staleRemove = await removeAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uFin.app}/groups/${finMembership.membership_id}`, {
        method: "DELETE",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ expected_account_version: 1 }),
      }),
      uFin.app,
      finMembership.membership_id,
      "true",
      ownerDeps,
    );
    assert.equal(staleRemove.status, 409);
    const staleBody = await staleRemove.json();
    assert.equal(staleBody.code, "VERSION_CONFLICT");
    assert.equal(staleBody.current_version, finMembership.account_version);

    // Remove U_FIN from VFIN_CASH_GROUP -> drops back to direct GLOBAL_VIEWER AND keeps PROJECT_ACCOUNTANT!
    const okRemove = await removeAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uFin.app}/groups/${finMembership.membership_id}`, {
        method: "DELETE",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ expected_account_version: finMembership.account_version }),
      }),
      uFin.app,
      finMembership.membership_id,
      "true",
      ownerDeps,
    );
    assert.equal(okRemove.status, 200);

    const finAfter = (
      await db.query(`select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uFin.auth,
        uFin.app,
      ])
    ).rows[0].auth;
    assert.equal(finAfter.global_role_code, "GLOBAL_VIEWER");
    assert.equal(finAfter.can_fund_vendor_advance, false);
    assert.equal(finAfter.active_assigned_project_count, 1, "independent PROJECT_ACCOUNTANT must stay intact");

    // D4 Leave HR Operations group test (assign -> immediate HR_LEAVE_OPERATOR + HR_REPORT_VIEWER -> remove -> immediate revoke)
    const uLeave = { auth: nextUuid(), app: nextUuid(), email: "u.leave.d4@hrpartner.vn", name: "Leave HR User" };
    await seedBaseUser(db, uLeave, { enabled: true, authzManaged: true });
    const leaveGroupId = (
      await db.query(`select group_id from public.authz_user_groups where code = 'LEAVE_HR_OPERATIONS'`)
    ).rows[0].group_id;

    const lvBefore = (
      await db.query(`select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uLeave.auth,
        uLeave.app,
      ])
    ).rows[0].auth;
    assert.equal(lvBefore.is_hr_operator, false);
    assert.equal(lvBefore.can_manage_config, false);

    const assignLv = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uLeave.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: leaveGroupId, expected_account_version: 1 }),
      }),
      uLeave.app,
      "true",
      ownerDeps,
    );
    assert.equal(assignLv.status, 201);
    const lvMem = (await assignLv.json()).membership;

    const lvDuring = (
      await db.query(`select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uLeave.auth,
        uLeave.app,
      ])
    ).rows[0].auth;
    assert.equal(lvDuring.is_hr_operator, true);
    assert.equal(lvDuring.is_hr_report_viewer, false, "1:1 LEAVE_HR_OPERATIONS holds HR_LEAVE_OPERATOR only");
    assert.equal(lvDuring.can_view_monthly_report, true);
    assert.equal(lvDuring.can_manage_config, true);

    // Update group to drop HR_LEAVE_OPERATOR -> member immediately loses is_hr_operator while keeping HR_REPORT_VIEWER!
    const updRes = await updatePermissionGroupAdmin(
      new Request(`https://bi.local/api/admin/access/groups/${leaveGroupId}`, {
        method: "PATCH",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({
          expected_version: 1,
          name: "Quản trị Nghỉ phép HR",
          description: "Chỉ xem báo cáo nghỉ phép",
          department_id: deptByKey.get("RECRUITMENT"),
          team_id: null,
          active: true,
          capabilities: [],
          module_roles: [{ module_code: "leave", role_code: "HR_REPORT_VIEWER" }],
        }),
      }),
      leaveGroupId,
      "true",
      ownerDeps,
    );
    assert.equal(updRes.status, 200);

    const lvAfterUpdate = (
      await db.query(`select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uLeave.auth,
        uLeave.app,
      ])
    ).rows[0].auth;
    assert.equal(lvAfterUpdate.is_hr_operator, false);
    assert.equal(lvAfterUpdate.is_hr_report_viewer, true);
    assert.equal(lvAfterUpdate.can_manage_config, false);

    // Remove user from group -> loses HR_REPORT_VIEWER too
    const remLv = await removeAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uLeave.app}/groups/${lvMem.membership_id}`, {
        method: "DELETE",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ expected_account_version: lvMem.account_version }),
      }),
      uLeave.app,
      lvMem.membership_id,
      "true",
      ownerDeps,
    );
    assert.equal(remLv.status, 200);
    const lvAfterRemove = (
      await db.query(`select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uLeave.auth,
        uLeave.app,
      ])
    ).rows[0].auth;
    assert.equal(lvAfterRemove.is_hr_report_viewer, false);
  } finally {
    await db.close();
  }
});

test("5. Ponytail Security Hardening: P1-1 dept group ceiling, P1-3 uncutover legacy-grant guard, P2-1 auth-before-group-lock oracle fix", async () => {
  const db = await createBootstrappedDb();
  try {
    const repo = createServicePermissionGroupRepository(createPgliteNamedRpc(db));
    const ownerDeps = { resolveSession: makeDbSessionResolver(db, OWNER), repository: repo };
    const { rows: depts } = await db.query(
      `select department_id, system_key from public.organization_departments`,
    );
    const deptByKey = new Map(depts.map((d) => [d.system_key, d.department_id]));

    // P1-1: Regular department group must reject report_view, report_analytics_view, and vendor_finance_record
    for (const forbiddenCap of ["report_view", "report_analytics_view", "vendor_finance_record"]) {
      const badRes = await createPermissionGroupAdmin(
        new Request("https://bi.local/api/admin/access/groups", {
          method: "POST",
          headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
          body: JSON.stringify({
            code: `BAD_${forbiddenCap.toUpperCase()}`,
            name: `Nhóm vượt trần ${forbiddenCap}`,
            department_id: deptByKey.get("ACCOUNTING"),
            team_id: null,
            capabilities: [forbiddenCap],
          }),
        }),
        "true",
        ownerDeps,
      );
      assert.equal(badRes.status, 400, `${forbiddenCap} must be rejected on regular dept group`);
      assert.equal((await badRes.json()).code, "GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP");
    }

    // P1-1: Assigning ACCOUNTING_OPERATIONS must NOT grant vendor_finance_record / can_fund_vendor_advance / ALL record_scope
    const uAcc = { auth: nextUuid(), app: nextUuid(), email: "u.acc.p11@hrpartner.vn", name: "Accounting Viewer" };
    await seedBaseUser(db, uAcc, { enabled: true, authzManaged: true });
    const accGroupId = (
      await db.query(`select group_id from public.authz_user_groups where code = 'ACCOUNTING_OPERATIONS'`)
    ).rows[0].group_id;
    const assignAcc = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uAcc.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: accGroupId, expected_account_version: 1 }),
      }),
      uAcc.app,
      "true",
      ownerDeps,
    );
    assert.equal(assignAcc.status, 201);
    const accFinAuth = (
      await db.query(`select public.vendor_finance__internal_resolve_authority($1::uuid, $2::uuid) as auth`, [
        uAcc.auth,
        uAcc.app,
      ])
    ).rows[0].auth;
    assert.equal(accFinAuth.can_fund_vendor_advance, false);
    assert.notEqual(accFinAuth.record_scope, "ALL");

    // P1-3: Uncutover authz_managed = false account WITH active legacy direct_entry_capability_grants MUST fail closed (409 AUTHZ_CUTOVER_NOT_READY)
    const uLegacy = { auth: nextUuid(), app: nextUuid(), email: "u.legacy.p13@hrpartner.vn", name: "Uncutover Legacy User" };
    await seedBaseUser(db, uLegacy, { enabled: true, authzManaged: false });
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_create', '2025-01-01', true)`,
      [uLegacy.app],
    );
    const uncutoverRes = await assignAccountGroupAdmin(
      new Request(`https://bi.local/api/admin/access/accounts/${uLegacy.app}/groups`, {
        method: "POST",
        headers: { ...SAME_ORIGIN_JSON, "idempotency-key": nextUuid() },
        body: JSON.stringify({ group_id: accGroupId, expected_account_version: 1 }),
      }),
      uLegacy.app,
      "true",
      ownerDeps,
    );
    assert.equal(uncutoverRes.status, 409);
    assert.equal((await uncutoverRes.json()).code, "AUTHZ_CUTOVER_NOT_READY");
    const legacyState = (
      await db.query(
        `select authz_managed,
                (select count(*)::int from public.direct_entry_capability_grants g where g.app_user_id = u.app_user_id and g.is_current) as legacy_grants
           from public.direct_entry_app_users u
          where u.app_user_id = $1::uuid`,
        [uLegacy.app],
      )
    ).rows[0];
    assert.deepEqual(legacyState, { authz_managed: false, legacy_grants: 1 });

    // P2-1: Non-admin calling direct_entry_authz_assign_group_member_admin with a nonexistent group_id gets AUTHZ_FORBIDDEN (not GROUP_NOT_FOUND oracle)
    await assert.rejects(
      db.query(
        `select public.direct_entry_authz_assign_group_member_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'Oracle probe', $5::uuid, $6::text
         )`,
        [uAcc.auth, uAcc.app, uAcc.app, nextUuid(), nextUuid(), "a".repeat(64)],
      ),
      (err) => err?.code === "42501" && String(err?.message ?? "").includes("AUTHZ_FORBIDDEN"),
    );
  } finally {
    await db.close();
  }
});
