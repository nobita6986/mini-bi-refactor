/**
 * WP5B-1 (PR 1) — Role, Capability, Scope & Effective Access Foundation
 * PGlite Database Contract & Regression Suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { projectLinkRecruiterEnvelope } from "../src/lib/admin/account-operation-contract.ts";
import { computeRoleMutationRequestHash } from "../src/lib/direct-entry/role-access-api.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "10000000-0000-4000-8000-000000000001",
  app: "20000000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const COLLISION = {
  auth: "10000000-0000-4000-8000-000000000002",
  app: "20000000-0000-4000-8000-000000000002",
  email: "nobita6986@hrpartner.vn",
  name: "Collision Staff",
};
const ADMIN_2 = {
  auth: "10000000-0000-4000-8000-000000000003",
  app: "20000000-0000-4000-8000-000000000003",
  email: "minh.admin@hrpartner.vn",
  name: "Admin Two",
};
const LUANPT_ORPHAN = {
  auth: "10000000-0000-4000-8000-000000000004",
  app: "20000000-0000-4000-8000-000000000004",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const RECRUITER_USER = {
  auth: "10000000-0000-4000-8000-000000000005",
  app: "20000000-0000-4000-8000-000000000005",
  recruiter: "30000000-0000-4000-8000-000000000005",
  email: "rec.one@hrpartner.vn",
  name: "Recruiter One",
};
const TL_ADMIN = {
  auth: "10000000-0000-4000-8000-000000000006",
  app: "20000000-0000-4000-8000-000000000006",
  recruiter: "30000000-0000-4000-8000-000000000006",
  email: "tl.admin@hrpartner.vn",
  name: "TL Plus Admin",
};
const HIST_DISABLED = {
  auth: "10000000-0000-4000-8000-000000000007",
  app: "20000000-0000-4000-8000-000000000007",
  email: "hist.disabled@hrpartner.vn",
  name: "Historical Disabled",
};
const CTX_HEAD = {
  auth: "10000000-0000-4000-8000-000000000008",
  app: "20000000-0000-4000-8000-000000000008",
  person: "40000000-0000-4000-8000-000000000008",
  email: "dept.head@hrpartner.vn",
  name: "Dept Head User",
};
const ACCT_USER = {
  auth: "10000000-0000-4000-8000-000000000009",
  app: "20000000-0000-4000-8000-000000000009",
  email: "acct.proj@hrpartner.vn",
  name: "Project Accountant User",
};
const PM_USER = {
  auth: "10000000-0000-4000-8000-000000000010",
  app: "20000000-0000-4000-8000-000000000010",
  recruiter: "30000000-0000-4000-8000-000000000010",
  email: "pm.proj@hrpartner.vn",
  name: "Project Manager User",
};
const SERVICE_ACCT = {
  auth: "10000000-0000-4000-8000-000000000011",
  app: "20000000-0000-4000-8000-000000000011",
  email: "svc.bot@hrpartner.vn",
  name: "Service Account Bot",
};
const PERS_TARGET = {
  auth: "10000000-0000-4000-8000-000000000012",
  app: "20000000-0000-4000-8000-000000000012",
  email: "pers.new@hrpartner.vn",
  name: "Personnel Create Target",
};
const LINK_TARGET = {
  auth: "10000000-0000-4000-8000-000000000013",
  app: "20000000-0000-4000-8000-000000000013",
  recruiter: "30000000-0000-4000-8000-000000000013",
  personnelCode: "link.target",
  email: "link.target@hrpartner.vn",
  name: "Recruiter Link Target",
};
const GRANTOR_DELEGATE = {
  auth: "10000000-0000-4000-8000-000000000014",
  app: "20000000-0000-4000-8000-000000000014",
  email: "deleg.grantor@hrpartner.vn",
  name: "Delegation Grantor",
};

const TEAM_ID = "50000000-0000-4000-8000-000000000001";
const PROJECT_ID = "PROJ_WP5_01";

let seq = 1;
function uuidSeq() {
  return `91000000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256Hex(obj) {
  return createHash("sha256").update(JSON.stringify(obj), "utf8").digest("hex");
}

function assertNoEmailOrAt(value, label) {
  const txt = JSON.stringify(value);
  assert.equal(txt.includes("@"), false, `${label} must contain 0 '@' chars`);
  const stack = [value];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
    } else if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        assert.equal(/email/i.test(k), false, `${label} must not expose key '${k}'`);
        stack.push(v);
      }
    }
  }
}

async function seedAccount(
  db,
  user,
  { enabled = true, accountType = "NORMAL", caps = [], scopes = [], teamScopes = [], authzManaged = false } = {},
) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, account_type, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, 1)`,
    [user.app, user.auth, user.name, accountType, enabled, authzManaged],
  );
  for (const cap of caps) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [user.app, cap],
    );
  }
  for (const sk of scopes) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, null, '2020-01-01', true)`,
      [user.app, sk],
    );
  }
  for (const tid of teamScopes) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, '2020-01-01', true)`,
      [user.app, tid],
    );
  }
  if (user.recruiter) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, $2, $3, $4, true, 1)`,
      [user.recruiter, user.name, user.personnelCode ?? null, user.personnelCode ? "STAFF" : null],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2020-01-01', true)`,
      [user.recruiter],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
      [user.app, user.recruiter],
    );
  }
}

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes(WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME));
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }

  await db.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'WP5_TEAM_01', 'Team WP5 Test', true, 1)`,
    [TEAM_ID],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active)
     values ($1, 'WP5 Probe Project', true)
     on conflict (project_id) do nothing`,
    [PROJECT_ID],
  );
  await db.exec(`
    insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
    values ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true)
    on conflict (labor_type_key) do update set active = true;
  `);

  // Legacy Full Admin OWNER + ADMIN_2 + COLLISION (non-admin)
  await seedAccount(db, OWNER, {
    caps: ["entry_admin", "recruiter_master_manage", "team_master_manage", "entry_own"],
    scopes: ["all"],
  });
  await seedAccount(db, COLLISION, {
    caps: ["entry_own"],
    scopes: ["own"],
  });
  await seedAccount(db, ADMIN_2, {
    caps: ["entry_admin", "recruiter_master_manage", "team_master_manage", "audit_view"],
    scopes: ["all"],
  });
  // LUANPT orphan 'all' scope grant with zero capabilities
  await seedAccount(db, LUANPT_ORPHAN, {
    caps: [],
    scopes: ["all"],
  });
  await seedAccount(db, RECRUITER_USER, {
    caps: ["entry_create", "entry_own", "document_view"],
    scopes: ["own"],
  });
  await seedAccount(db, SERVICE_ACCT, { accountType: "SERVICE" });
  await seedAccount(db, PERS_TARGET, { caps: [], scopes: [] });

  await seedAccount(db, LINK_TARGET, { caps: [], scopes: [] });
  // Remove auto-inserted link from seedAccount so link_recruiter RPC can create it cleanly
  await db.query("delete from public.direct_entry_app_user_recruiter_links where app_user_id = $1::uuid", [LINK_TARGET.app]);

  // PM_USER for C4 test
  await seedAccount(db, PM_USER, { caps: [], scopes: [] });
  await db.query(
    `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current)
     values ($1, $2::uuid, '2026-01-01', true)`,
    [PROJECT_ID, PM_USER.recruiter],
  );

  // Historical disabled account (pre-WP5 pattern: closed grants, suspended_by_account_disable = false)
  await seedAccount(db, HIST_DISABLED, { enabled: false });
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
     values ($1::uuid, 'entry_own', '2020-01-01', '2025-01-01', false, false)`,
    [HIST_DISABLED.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current, suspended_by_account_disable)
     values ($1::uuid, 'own', '2020-01-01', '2025-01-01', false, false)`,
    [HIST_DISABLED.app],
  );

  // CTX_HEAD + department
  await seedAccount(db, CTX_HEAD);
  await db.query(
    `insert into public.organization_persons (person_id, employee_code, full_name, status)
     values ($1::uuid, 'EMP-HEAD-01', $2, 'ACTIVE')`,
    [CTX_HEAD.person, CTX_HEAD.name],
  );
  await db.query(
    `insert into public.organization_account_person_links (app_user_id, person_id, started_at, source_kind, reason)
     values ($1::uuid, $2::uuid, now() - interval '1 day', 'ADMIN_MUTATION', 'Test link')`,
    [CTX_HEAD.app, CTX_HEAD.person],
  );

  // ACCT_USER as PROJECT_ACCOUNTANT
  await seedAccount(db, ACCT_USER);
  await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
  await db.query(
    `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
     values ($1, $2::uuid, 1, '2020-01-01', $3::uuid, 'Seed PA')`,
    [PROJECT_ID, ACCT_USER.app, OWNER.app],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

  // GRANTOR_DELEGATE for work_report_delegations
  await seedAccount(db, GRANTOR_DELEGATE, {
    caps: ["report_delegate", "report_assign", "report_review"],
    scopes: ["all"],
  });

  return db;
}

const db = await setupDatabase();

test("1. Pre-cutover state: exact 8-role catalog, legacy bridge vs luanpt orphan all scope, and PT409 AUTHZ_CUTOVER_NOT_READY", async () => {
  const { rows: stateRows } = await db.query("select cutover_ready from public.authz_system_state");
  assert.equal(stateRows.length, 1);
  assert.equal(stateRows[0].cutover_ready, false);

  const { rows: [{ payload: catalog }] } = await db.query(
    "select public.direct_entry_authz_list_roles_admin($1::uuid, $2::uuid) as payload",
    [OWNER.auth, OWNER.app],
  );
  assertNoEmailOrAt(catalog, "list_roles_admin");
  assert.equal(catalog.roles.length, 8);
  assert.equal(catalog.roles.some((r) => r.role_code === "BOD" || r.role_code === "BOD_ADMIN"), false);
  const adminRole = catalog.roles.find((r) => r.role_code === "ADMIN");
  assert.equal(adminRole.display_name, "BoD/Admin");
  assert.equal(adminRole.capabilities.length, 21);

  // Legacy bridge resolves paired effective_grants for RECRUITER_USER
  const { rows: [{ payload: recCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [RECRUITER_USER.auth],
  );
  assertNoEmailOrAt(recCtx, "recruiter resolve_actor_context");
  assert.equal(recCtx.effective_grants.length, 3);
  assert.equal(
    recCtx.effective_grants.every((g) => g.scope_kind === "OWN" && g.source_type === "LEGACY_BRIDGE"),
    true,
  );

  // LUANPT orphan 'all' scope with 0 capabilities produces 0 effective_grants (no fabricated access)
  const { rows: [{ payload: luanCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [LUANPT_ORPHAN.auth],
  );
  assert.deepEqual(luanCtx.effective_grants, []);

  // Pre-cutover assign & revoke MUST fail closed with PT409 AUTHZ_CUTOVER_NOT_READY
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'Pre-cutover assign test', $4::uuid, $5)",
      [OWNER.auth, OWNER.app, COLLISION.app, uuidSeq(), "a".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("AUTHZ_CUTOVER_NOT_READY"),
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'Pre-cutover revoke test', $5::uuid, $6)",
      [OWNER.auth, OWNER.app, COLLISION.app, uuidSeq(), uuidSeq(), "b".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("AUTHZ_CUTOVER_NOT_READY"),
  );
});

test("2. Cutover-ready assign/revoke: idempotency, hash mismatch, contextual role rejection, SHARED/SERVICE block, OCC detail, and NO last-admin lock", async () => {
  await db.query("update public.authz_system_state set cutover_ready = true, cutover_at = clock_timestamp()");

  // Reject contextual role via global assign
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'TEAM_LEADER', 1, 'Should fail contextual role', $4::uuid, $5)",
      [OWNER.auth, OWNER.app, COLLISION.app, uuidSeq(), "c".repeat(64)],
    ),
    (err) => err?.code === "22023" && err.message.includes("CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE"),
  );

  // Reject SERVICE target
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'HR_OPERATOR', 1, 'Reject service acct', $4::uuid, $5)",
      [OWNER.auth, OWNER.app, SERVICE_ACCT.app, uuidSeq(), "d".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("ACCOUNT_TYPE_ROLE_FORBIDDEN"),
  );

  // Assign ADMIN to ADMIN_2 (starting authz_managed flow) with exact request hash
  const idKey1 = uuidSeq();
  const hash1 = computeRoleMutationRequestHash({
    op: "AUTHZ_GLOBAL_ROLE_ASSIGNED",
    actor_app_user_id: OWNER.app,
    target_app_user_id: ADMIN_2.app,
    role_code: "ADMIN",
    expected_account_version: 1,
    reason: "Promote Admin Two via WP5",
  });
  const { rows: [{ payload: assigned }] } = await db.query(
    "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 1, 'Promote Admin Two via WP5', $4::uuid, $5) as payload",
    [OWNER.auth, OWNER.app, ADMIN_2.app, idKey1, hash1],
  );
  assertNoEmailOrAt(assigned, "assign_global_role_admin");
  assert.equal(assigned.replayed, false);
  assert.equal(assigned.account_version, 2);
  assert.equal(assigned.assignment.role_code, "ADMIN");
  assert.equal(assigned.assignment.can_revoke, true);
  assert.equal(assigned.assignment.is_protected, false);

  // Idempotent replay succeeds even after version bumped to 2
  const { rows: [{ payload: replayed }] } = await db.query(
    "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 1, 'Promote Admin Two via WP5', $4::uuid, $5) as payload",
    [OWNER.auth, OWNER.app, ADMIN_2.app, idKey1, hash1],
  );
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.assignment.assignment_id, assigned.assignment.assignment_id);

  // Same idempotency key with DIFFERENT request hash MUST fail with IDEMPOTENCY_CONFLICT
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 1, 'Changed reason', $4::uuid, $5)",
      [OWNER.auth, OWNER.app, ADMIN_2.app, idKey1, "e".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("IDEMPOTENCY_CONFLICT"),
  );

  // Stale expected_account_version throws PT409 VERSION_CONFLICT with current_version in detail
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'Wrong version revoke', $5::uuid, $6)",
      [OWNER.auth, OWNER.app, ADMIN_2.app, assigned.assignment.assignment_id, uuidSeq(), "f".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("VERSION_CONFLICT") && JSON.parse(err.detail).current_version === 2,
  );

  // Verify NO last-admin lock: ADMIN_2 is the ONLY row in authz_account_role_assignments with role_code = 'ADMIN' right now,
  // and revoking it MUST succeed cleanly!
  const revokeHash = computeRoleMutationRequestHash({
    op: "AUTHZ_GLOBAL_ROLE_REVOKED",
    actor_app_user_id: OWNER.app,
    target_app_user_id: ADMIN_2.app,
    assignment_id: assigned.assignment.assignment_id,
    expected_account_version: 2,
    reason: "Revoke sole unprotected ADMIN to prove no last-admin lock",
  });
  const { rows: [{ payload: revoked }] } = await db.query(
    "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 'Revoke sole unprotected ADMIN to prove no last-admin lock', $5::uuid, $6) as payload",
    [OWNER.auth, OWNER.app, ADMIN_2.app, assigned.assignment.assignment_id, uuidSeq(), revokeHash],
  );
  assert.equal(revoked.replayed, false);
  assert.equal(revoked.account_version, 3);
  assert.equal(revoked.assignment.inactive_reason, "REVOKED");

  // Re-grant ADMIN to ADMIN_2 for later tests & inspect audit_events
  await db.query(
    "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 3, 'Re-grant Admin Two', $4::uuid, $5)",
    [OWNER.auth, OWNER.app, ADMIN_2.app, uuidSeq(), sha256Hex({ r: 1 })],
  );
  const { rows: auditRows } = await db.query(
    "select operation_name from public.authz_audit_events where target_app_user_id = $1::uuid order by created_at asc",
    [ADMIN_2.app],
  );
  assert.deepEqual(
    auditRows.map((r) => r.operation_name),
    ["AUTHZ_GLOBAL_ROLE_ASSIGNED", "AUTHZ_GLOBAL_ROLE_REVOKED", "AUTHZ_GLOBAL_ROLE_ASSIGNED"],
  );
});

test("3. PROTECTED_OWNER_ADMIN: unique index, non-ADMIN block, revoke block (including self-revoke), trigger immutability, AND D10 disable/enable allowed", async () => {
  const { rows: [{ assignment_id: ownerAssignId }] } = await db.query(
    `insert into public.authz_account_role_assignments
       (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id, is_protected, protected_reason)
     values ($1::uuid, 'ADMIN', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'Canonical Owner protected assignment', $1::uuid, true, 'PROTECTED_OWNER_ADMIN')
     returning assignment_id`,
    [OWNER.app],
  );
  await db.query("update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid", [OWNER.app]);

  // 2nd is_protected = true fails partial unique index (23505)
  await assert.rejects(
    db.query(
      `insert into public.authz_account_role_assignments
         (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id, is_protected, protected_reason)
       values ($1::uuid, 'ADMIN', 'GLOBAL', 'BACKFILL_SNAPSHOT', 'Second protected invalid', $2::uuid, true, 'PROTECTED_OWNER_ADMIN')`,
      [ADMIN_2.app, OWNER.app],
    ),
    (err) => err?.code === "23505",
  );

  // Trigger rejects is_protected = true on non-ADMIN role
  await assert.rejects(
    db.query(
      `insert into public.authz_account_role_assignments
         (app_user_id, role_code, scope_kind, source_kind, reason, assigned_by_app_user_id, is_protected)
       values ($1::uuid, 'RECRUITER', 'GLOBAL', 'ADMIN_ASSIGNMENT', 'Invalid non-admin protected', $2::uuid, true)`,
      [COLLISION.app, OWNER.app],
    ),
  );

  // Trigger blocks SQL DELETE and SQL UPDATE modifying is_protected or ending protected assignment
  await assert.rejects(
    db.query("delete from public.authz_account_role_assignments where assignment_id = $1::uuid", [ownerAssignId]),
  );
  await assert.rejects(
    db.query(
      "update public.authz_account_role_assignments set ended_at = now(), ended_reason = 'tamper', ended_by_app_user_id = $2::uuid where assignment_id = $1::uuid",
      [ownerAssignId, ADMIN_2.app],
    ),
  );

  // RPC revoke (including Owner self-revoke) rejects with PT409 AUTHZ_PROTECTED_ASSIGNMENT & 0 version bump
  const { rows: [{ version: vBefore }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [OWNER.app],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Self revoke attempt', $6::uuid, $7)",
      [OWNER.auth, OWNER.app, OWNER.app, ownerAssignId, vBefore, uuidSeq(), "a".repeat(64)],
    ),
    (err) => err?.code === "PT409" && err.message.includes("AUTHZ_PROTECTED_ASSIGNMENT"),
  );
  const { rows: [{ version: vAfter }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [OWNER.app],
  );
  assert.equal(vAfter, vBefore);

  // Disable & Re-enable Owner by ADMIN_2 MUST succeed (suspending effective_grants while preserving is_protected = true)
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Test disable protected Owner', $5)",
    [ADMIN_2.auth, ADMIN_2.app, OWNER.app, vBefore, `disable-owner-${seq++}`],
  );
  const { rows: [{ payload: disabledOwnerDetail }] } = await db.query(
    "select public.direct_entry_authz_get_account_access_admin($1::uuid, $2::uuid, $3::uuid) as payload",
    [ADMIN_2.auth, ADMIN_2.app, OWNER.app],
  );
  assert.equal(disabledOwnerDetail.account.enabled, false);
  assert.deepEqual(disabledOwnerDetail.blocking_reasons, ["ACCOUNT_DISABLED"]);
  assert.deepEqual(disabledOwnerDetail.effective_grants, []);
  assert.equal(disabledOwnerDetail.assigned_global_roles[0].is_protected, true);

  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable protected Owner', $5)",
    [ADMIN_2.auth, ADMIN_2.app, OWNER.app, vBefore + 1, `enable-owner-${seq++}`],
  );
  const { rows: [{ payload: enabledOwnerCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [OWNER.auth],
  );
  assert.equal(enabledOwnerCtx.enabled, true);
  assert.equal(enabledOwnerCtx.effective_grants.length, 21);
});

test("4. D10 lifecycle: TL revoke while disabled preserves ADMIN grants, and pre-WP5 disabled historical account does NOT resurrect", async () => {
  // Seed TL_ADMIN as authz_managed ADMIN + verified recruiter + designated TEAM_LEADER
  await seedAccount(db, TL_ADMIN, { caps: [], scopes: [], authzManaged: true });
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2020-01-01', true)`,
    [TL_ADMIN.recruiter, TEAM_ID],
  );
  await db.query(
    "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', 1, 'Seed TL_ADMIN', $4::uuid, $5)",
    [OWNER.auth, OWNER.app, TL_ADMIN.app, uuidSeq(), "b".repeat(64)],
  );
  const { rows: [{ result: tlDesig }] } = await db.query(
    "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Designate TL_ADMIN', $5) as result",
    [OWNER.auth, OWNER.app, TEAM_ID, TL_ADMIN.app, `tl-desig-${seq++}`],
  );
  assert.ok(tlDesig);

  const { rows: [{ version: tlVer }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [TL_ADMIN.app],
  );
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Disable TL_ADMIN', $5)",
    [OWNER.auth, OWNER.app, TL_ADMIN.app, tlVer, `tl-dis-${seq++}`],
  );

  // Revoke TEAM_LEADER while disabled
  const { rows: [{ version: teamVer }] } = await db.query(
    "select version from public.teams where team_id = $1::uuid",
    [TEAM_ID],
  );
  await db.query(
    "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, public.direct_entry_authorization_date(), $4, 'Revoke TL while disabled', $5)",
    [OWNER.auth, OWNER.app, TEAM_ID, teamVer, `tl-rev-${seq++}`],
  );

  // Re-enable TL_ADMIN -> ADMIN grants (including report_view@ALL & report_analytics_view@ALL) MUST remain intact!
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable TL_ADMIN', $5)",
    [OWNER.auth, OWNER.app, TL_ADMIN.app, tlVer + 1, `tl-en-${seq++}`],
  );
  const { rows: [{ payload: tlAfter }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [TL_ADMIN.auth],
  );
  assert.equal(tlAfter.effective_grants.some((g) => g.capability === "report_view" && g.scope_kind === "ALL"), true);
  assert.equal(
    tlAfter.effective_grants.some((g) => g.capability === "report_analytics_view" && g.scope_kind === "ALL"),
    true,
  );
  assert.equal(
    tlAfter.effective_grants.some((g) => g.scope_kind === "CONTEXT_TEAM"),
    false,
    "revoked TL contextual grants must stay cleared after re-enable",
  );

  // Pre-WP5 historical disabled account must NOT resurrect closed grants when enabled
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, 1, 'Re-enable pre-WP5 historical disabled', $4)",
    [OWNER.auth, OWNER.app, HIST_DISABLED.app, `hist-en-${seq++}`],
  );
  const { rows: [{ payload: histCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [HIST_DISABLED.auth],
  );
  assert.deepEqual(histCtx.effective_grants, []);
});

test("5. Contextual roles (DEPARTMENT_HEAD, PROJECT_ACCOUNTANT), work_reports delegation, C4 PM-only, account_type guard, and create_personnel/link_recruiter", async () => {
  // Query existing RECRUITMENT department
  const { rows: [{ department_id: deptId }] } = await db.query(
    "select department_id from public.organization_departments where code = 'RECRUITMENT' limit 1",
  );
  await db.query(
    `insert into public.organization_person_department_memberships (person_id, department_id, started_at, source_kind, reason)
     values ($1::uuid, $2::uuid, now() - interval '2 days', 'ADMIN_MUTATION', 'Dept Member probe')`,
    [CTX_HEAD.person, deptId],
  );
  await db.query(
    `insert into public.organization_department_heads (department_id, person_id, started_at, source_kind, reason)
     values ($1::uuid, $2::uuid, now() - interval '1 day', 'ADMIN_MUTATION', 'Dept Head probe')`,
    [deptId, CTX_HEAD.person],
  );

  const { rows: [{ payload: headActive }] } = await db.query(
    "select public.direct_entry_authz_get_account_access_admin($1::uuid, $2::uuid, $3::uuid) as payload",
    [OWNER.auth, OWNER.app, CTX_HEAD.app],
  );
  assert.equal(headActive.contextual_assignments[0].role_code, "DEPARTMENT_HEAD");
  assert.equal(headActive.contextual_assignments[0].is_effective, true);

  // Flip linked person to INACTIVE -> is_effective = false & inactive_reason = PERSON_INACTIVE
  await db.query(
    "update public.organization_persons set status = 'INACTIVE', deactivated_at = now(), deactivated_by_user_id = $2::uuid, deactivate_reason = 'Probe inactive person' where person_id = $1::uuid",
    [CTX_HEAD.person, OWNER.app],
  );
  const { rows: [{ payload: headInactivePerson }] } = await db.query(
    "select public.direct_entry_authz_get_account_access_admin($1::uuid, $2::uuid, $3::uuid) as payload",
    [OWNER.auth, OWNER.app, CTX_HEAD.app],
  );
  assert.equal(headInactivePerson.contextual_assignments[0].is_effective, false);
  assert.equal(headInactivePerson.contextual_assignments[0].inactive_reason, "PERSON_INACTIVE");

  // PROJECT_ACCOUNTANT emits vendor_finance_view at CONTEXT_PROJECT
  const { rows: [{ payload: acctCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [ACCT_USER.auth],
  );
  assert.deepEqual(
    acctCtx.effective_grants.filter((g) => g.role_code !== undefined || g.capability === "vendor_finance_view").map((g) => ({
      capability: g.capability,
      scope_kind: g.scope_kind,
      scope_id: g.scope_id,
    })),
    [{ capability: "vendor_finance_view", scope_kind: "CONTEXT_PROJECT", scope_id: PROJECT_ID }],
  );

  // work_reports active delegation appears in module_authorities
  const tplId = uuidSeq();
  const verId = uuidSeq();
  await db.query(
    `insert into public.work_report_templates (template_id, template_code, display_name, default_frequency, status, created_by_user_id)
     values ($1::uuid, 'TPL_WP5_01', 'WP5 Probe Template', 'DAILY', 'DRAFT', $2::uuid)`,
    [tplId, GRANTOR_DELEGATE.app],
  );
  await db.query(
    `insert into public.work_report_template_versions (version_id, template_id, version_no, status, schema_json, metric_contract_json, schema_checksum, published_by_user_id, published_at)
     values ($1::uuid, $2::uuid, 1, 'PUBLISHED', '{}'::jsonb, '{}'::jsonb, repeat('a', 64), $3::uuid, now())`,
    [verId, tplId, GRANTOR_DELEGATE.app],
  );
  await db.query(
    "update public.work_report_templates set status = 'ACTIVE', current_published_version_id = $1::uuid where template_id = $2::uuid",
    [verId, tplId],
  );
  await db.query(
    `insert into public.work_report_delegations (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id, scope_kind, effective_from, effective_to, state, is_current)
     values ($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'all', now() - interval '1 day', now() + interval '30 days', 'ACTIVE', true)`,
    [GRANTOR_DELEGATE.app, ACCT_USER.app, tplId, verId],
  );
  const { rows: [{ payload: acctDetail }] } = await db.query(
    "select public.direct_entry_authz_get_account_access_admin($1::uuid, $2::uuid, $3::uuid) as payload",
    [OWNER.auth, OWNER.app, ACCT_USER.app],
  );
  assertNoEmailOrAt(acctDetail, "acct_detail");
  assert.equal(acctDetail.module_authorities.some((m) => m.module === "work_reports" && m.authority_code === "REPORT_REVIEWER" && m.is_effective === true), true);

  // C4: Pure ADMIN without PM assignment MUST be denied recruitment_post_create (42501); PM succeeds
  const { rows: [{ industrial_park_id: parkId }] } = await db.query(
    "select industrial_park_id from public.industrial_parks where industrial_park_code = 'VP_BA_THIEN_1' limit 1",
  );
  const briefPayload = {
    project_id: PROJECT_ID,
    industrial_park_id: parkId,
    general: {
      customer_name: "Công ty TNHH Điện tử Việt Hàn",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Sản xuất linh kiện điện tử",
      job_description: "Lắp ráp và kiểm tra ngoại quan linh kiện điện tử",
      environment_types: ["CLEAN_ROOM", "NORMAL_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Trần Quản Lý",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục các ngày trong tuần",
      expected_headcount: 100,
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: "Test tay khéo và phỏng vấn trực tiếp",
      other_requirements_text: "Không dị ứng phòng sạch",
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 ngày công tiêu chuẩn",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Không đi muộn về sớm",
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: "300000",
      seniority_allowance_conditions: "Từ tháng thứ 2",
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9500000",
      average_income_max_vnd: "13000000",
      salary_payment_schedule: "Ngày 10 hàng tháng qua ngân hàng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ngày 25 hàng tháng",
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: "240000",
      day_shift_11h_vnd: "350000",
      night_shift_8h_vnd: "290000",
      night_shift_11h_vnd: "420000",
      sunday_day_11h_vnd: "520000",
      sunday_night_11h_vnd: "600000",
      holiday_day_11h_vnd: "780000",
      holiday_night_11h_vnd: "880000",
      ppe_provided: true,
      ppe_details: "Phát miễn phí 2 bộ quần áo và giày phòng sạch",
      other_benefits: "Hỗ trợ 2 bữa ăn ca tại nhà máy",
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
    },
  };

  await assert.rejects(
    db.query(
      "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4)",
      [ADMIN_2.auth, ADMIN_2.app, JSON.stringify(briefPayload), uuidSeq()],
    ),
    (err) => err?.code === "42501",
    "C4: Pure ADMIN without PM assignment must be denied recruitment_post_create",
  );
  const { rows: [{ result: pmCreated }] } = await db.query(
    "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4) as result",
    [PM_USER.auth, PM_USER.app, JSON.stringify(briefPayload), uuidSeq()],
  );
  assert.ok(pmCreated?.post?.brief_id);

  // org_department_set_account_type_admin blocks converting account with open authz_account_role_assignments to SHARED
  const { rows: [{ version: admin2Ver }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [ADMIN_2.app],
  );
  await assert.rejects(
    db.query(
      "select public.org_department_set_account_type_admin($1::uuid, $2::uuid, $3::uuid, 'SHARED', $4, 'Block convert with authz role', $5::uuid, $6)",
      [OWNER.auth, OWNER.app, ADMIN_2.app, admin2Ver, uuidSeq(), "f".repeat(64)],
    ),
    (err) => err?.code === "PT409" && !err.message.includes("VERSION_CONFLICT"),
  );

  // create_personnel auto-seeds EMPLOYEE_BASE + RECRUITER
  await db.query(
    "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, 1, 'pers.new', 'STAFF', null, 'Auto-seed personnel', $4)",
    [OWNER.auth, OWNER.app, PERS_TARGET.app, `create-pers-${seq++}`],
  );
  const { rows: persRoles } = await db.query(
    "select role_code, source_kind from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null order by role_code",
    [PERS_TARGET.app],
  );
  assert.deepEqual(persRoles, [
    { role_code: "EMPLOYEE_BASE", source_kind: "PERSONNEL_LINK_AUTO" },
    { role_code: "RECRUITER", source_kind: "PERSONNEL_LINK_AUTO" },
  ]);

  // link_recruiter auto-seeds EMPLOYEE_BASE + RECRUITER and preserves exact D3-C link envelope
  const { rows: [{ payload: linkPayload }] } = await db.query(
    "select public.direct_entry_account_operation_link_recruiter($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, 1, 'Auto-seed link recruiter', $5) as payload",
    [OWNER.auth, OWNER.app, LINK_TARGET.recruiter, LINK_TARGET.app, `link-rec-${seq++}`],
  );
  assert.notEqual(
    projectLinkRecruiterEnvelope(linkPayload),
    null,
    "link_recruiter RPC payload must match LinkRecruiterEnvelope contract (including valid_from)",
  );
  const { rows: linkRoles } = await db.query(
    "select role_code, source_kind from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null order by role_code",
    [LINK_TARGET.app],
  );
  assert.deepEqual(linkRoles, [
    { role_code: "EMPLOYEE_BASE", source_kind: "PERSONNEL_LINK_AUTO" },
    { role_code: "RECRUITER", source_kind: "PERSONNEL_LINK_AUTO" },
  ]);

  // list_accounts_summary_admin check + zero @/email check
  const { rows: [{ payload: summary }] } = await db.query(
    "select public.direct_entry_authz_list_accounts_summary_admin($1::uuid, $2::uuid, null, 'true', 'ADMIN', 1, 20) as payload",
    [OWNER.auth, OWNER.app],
  );
  assertNoEmailOrAt(summary, "list_accounts_summary_admin");
  assert.ok(summary.total >= 2);
});
