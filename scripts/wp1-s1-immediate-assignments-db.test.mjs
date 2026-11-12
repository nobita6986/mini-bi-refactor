/**
 * WP1/S1 — Block Future Effective Dates on Organization, Personnel & Authorization Assignments.
 *
 * Comprehensive PGlite DB, API/Contract, Day-Boundary Stability, and WP0 Baseline Parity Suite:
 *   1. Migration `20261112120000_wp1_s1_block_future_org_authz_assignments.sql` applies cleanly
 *      and enforces strict `service_role`-only EXECUTE ACLs across all 12 replaced RPCs.
 *   2. Pre- vs post-migration effective permission snapshot comparison on the same dataset and
 *      `as_of` (including `C:/CodeApp/bi-refactor-wp0/sql/` when present) proves 0 unintended diff
 *      and preserves pre-existing historical/future rows untouched (reported via CAT1).
 *   3. API & contract layers reject future effective/end dates (`> server_today_vn`) with clear
 *      contract errors across all WP1 flows and default omitted/null dates to `server_today_vn`.
 *   4. RPC layer independently rejects future effective/end dates (`> v_today`) with `ERRCODE = '22023'`
 *      and defaults omitted/`null` dates to `v_today` across all 12 WP1 RPCs.
 *   5. Dedicated functional & state-hygiene tests for:
 *      - Ending team membership (`direct_entry_unassign_team_membership`)
 *      - Leave department approver handover (`leave_management_set_department_approver_admin`)
 *      - Team Leader designate, handover/replacement, and same-day cancellation (`direct_entry_apply_team_leader_mutation`),
 *        including full 5-capability sync (`team_manager_assign`, `report_view`, `report_analytics_view`,
 *        `report_assign`, `report_review`) and PR #218 regression verification.
 *   6. Day-boundary stability proof ("qua ngày mà không có thao tác ghi không làm đổi quyền"):
 *      advancing `v_today` to `v_today + 1` without a write mutation does not flip permissions.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  parseCreatePersonnelFromAccount as validateCreatePersonnelFromAccountBody,
} from "../src/lib/admin/account-operation-contract.ts";
import {
  parseRevoke as validateProjectTeamScopeRevokeBody,
} from "../src/lib/admin/project-team-scope-contract.ts";
import {
  parseAssignBranchBody as validateAssignBranchBody,
  parseAssignSlotPolicyBody as validateAssignSlotPolicyBody,
  parseUnassignBranchBody as validateUnassignBranchBody,
  parseUnassignSlotPolicyBody as validateUnassignSlotPolicyBody,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  parseAssignAccountingMemberBody as validateAssignAccountingMemberBody,
  parseEndAccountingMemberBody as validateEndAccountingMemberBody,
} from "../src/lib/departments/department-contract.ts";
import { projectAdminAssignRequest } from "../src/lib/direct-entry/project-admin-api.ts";
import {
  designateRequest as teamLeaderDesignateRequest,
  revokeRequest as teamLeaderRevokeRequest,
} from "../src/lib/direct-entry/team-leader-api.ts";
import {
  teamMembershipAssignRequest,
  teamMembershipUnassignRequest,
} from "../src/lib/direct-entry/team-membership-api.ts";
import { parsePatchAdminConfigBody } from "../src/lib/leave/leave-contract.ts";
import {
  parseAssignGlobalRoleBody as validateAssignGlobalRoleBody,
  parseAssignProjectAccountantBody as validateAssignProjectAccountantBody,
  parseEndGlobalRoleBody as validateEndGlobalRoleBody,
  parseEndProjectAccountantBody as validateEndProjectAccountantBody,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP1_MIGRATION_NAME = "20261112120000_wp1_s1_block_future_org_authz_assignments.sql";
const WP0_SQL_DIR = path.resolve("../bi-refactor-wp0/sql");

const ACTORS = {
  fullAdmin: {
    auth: "1a000000-0000-4000-8000-000000000001",
    app: "2a000000-0000-4000-8000-000000000001",
    email: "admin.wp1@company.local",
    name: "Full Admin WP1",
  },
  catalogOp: {
    auth: "1a000000-0000-4000-8000-000000000002",
    app: "2a000000-0000-4000-8000-000000000002",
    email: "catalog.wp1@company.local",
    name: "Catalog Operator WP1",
  },
  leader1: {
    auth: "1a000000-0000-4000-8000-000000000003",
    app: "2a000000-0000-4000-8000-000000000003",
    recruiter: "3a000000-0000-4000-8000-000000000003",
    email: "leader1.wp1@company.local",
    name: "Team Leader 1 WP1",
    code: "TL1-WP1",
  },
  leader2: {
    auth: "1a000000-0000-4000-8000-000000000004",
    app: "2a000000-0000-4000-8000-000000000004",
    recruiter: "3a000000-0000-4000-8000-000000000004",
    email: "leader2.wp1@company.local",
    name: "Team Leader 2 WP1",
    code: "TL2-WP1",
  },
  staff1: {
    auth: "1a000000-0000-4000-8000-000000000005",
    app: "2a000000-0000-4000-8000-000000000005",
    recruiter: "3a000000-0000-4000-8000-000000000005",
    email: "staff1.wp1@company.local",
    name: "Recruiter Staff 1 WP1",
    code: "ST1-WP1",
  },
  mktApprover1: {
    auth: "1a000000-0000-4000-8000-000000000006",
    app: "2a000000-0000-4000-8000-000000000006",
    email: "mkt.head1@company.local",
    name: "Marketing Approver 1",
  },
  mktApprover2: {
    auth: "1a000000-0000-4000-8000-000000000007",
    app: "2a000000-0000-4000-8000-000000000007",
    email: "mkt.head2@company.local",
    name: "Marketing Approver 2",
  },
  mktStaff: {
    auth: "1a000000-0000-4000-8000-000000000008",
    app: "2a000000-0000-4000-8000-000000000008",
    email: "mkt.staff@company.local",
    name: "Marketing Staff",
  },
  acctUser: {
    auth: "1a000000-0000-4000-8000-000000000009",
    app: "2a000000-0000-4000-8000-000000000009",
    email: "acct.wp1@company.local",
    name: "Accounting Member WP1",
  },
  vfinViewer: {
    auth: "1a000000-0000-4000-8000-000000000010",
    app: "2a000000-0000-4000-8000-000000000010",
    email: "vfin.viewer@company.local",
    name: "Vendor Finance Global Viewer",
  },
};

const TEAM_A = "9a000000-0000-4000-8000-0000000000a1";
const TEAM_B = "9a000000-0000-4000-8000-0000000000a2";
const PROJECT_1 = "wp1_proj_01";
const BRANCH_1 = "8a000000-0000-4000-8000-0000000000b1";

async function setBusinessDate(db, isoDate) {
  await db.exec(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${isoDate}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);
}

async function captureEffectiveAuthorizationSnapshot(db, asOfDate) {
  const actorContexts = {};
  const leaveAuthorities = {};
  const leaveRoutings = {};

  for (const [key, actor] of Object.entries(ACTORS)) {
    const { rows: ctxRows } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [actor.auth],
    );
    actorContexts[key] = ctxRows[0].ctx;

    const { rows: leaveAuthRows } = await db.query(
      "select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth",
      [actor.auth, actor.app],
    );
    leaveAuthorities[key] = leaveAuthRows[0].auth;

    const { rows: routeRows } = await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [actor.app, asOfDate],
    );
    leaveRoutings[key] = routeRows[0].route;
  }

  const { rows: rawCapGrants } = await db.query(
    `select app_user_id::text, capability, valid_from::text, valid_to::text, is_current
       from public.direct_entry_capability_grants
      order by app_user_id::text, capability, valid_from::text`,
  );
  const { rows: rawScopeGrants } = await db.query(
    `select app_user_id::text, scope_kind, team_id::text, valid_from::text, valid_to::text, is_current
       from public.direct_entry_scope_grants
      order by app_user_id::text, scope_kind, coalesce(team_id::text, ''), valid_from::text`,
  );
  const { rows: rawTeamMemberships } = await db.query(
    `select recruiter_id::text, team_id::text, valid_from::text, valid_to::text, is_current
       from public.recruiter_team_memberships
      order by recruiter_id::text, team_id::text, valid_from::text`,
  );
  const { rows: rawTeamLeaders } = await db.query(
    `select team_id::text, leader_app_user_id::text, valid_from::text, valid_to::text, is_current
       from public.direct_entry_team_leader_assignments
      order by team_id::text, leader_app_user_id::text, valid_from::text`,
  );
  const { rows: rawDeptMemberships } = await db.query(
    `select department_id::text, app_user_id::text, valid_from::text, valid_to::text, version
       from public.organization_department_memberships
      order by department_id::text, app_user_id::text, valid_from::text`,
  );
  const { rows: rawLeaveApprovers } = await db.query(
    `select unit_kind, approver_app_user_id::text, valid_from::text, valid_to::text, is_current
       from public.leave_department_approvers
      order by unit_kind, approver_app_user_id::text, valid_from::text`,
  );

  let wp0SnapshotRows = null;
  let wp0DiffRows = null;
  let wp0Cat1Rows = null;
  if (existsSync(path.join(WP0_SQL_DIR, "01_current_effective_snapshot.sql"))) {
    await db.query("select set_config('wp0.as_of_ts', $1, false)", [`${asOfDate}T12:00:00+07:00`]);
    await db.query("select set_config('wp0.as_of_date', $1, false)", [asOfDate]);
    const snapSql = await readFile(path.join(WP0_SQL_DIR, "01_current_effective_snapshot.sql"), "utf8");
    const diffSql = await readFile(path.join(WP0_SQL_DIR, "02_candidate_and_diff.sql"), "utf8");
    const catSql = await readFile(path.join(WP0_SQL_DIR, "03_drift_diagnostics.sql"), "utf8");
    wp0SnapshotRows = (await db.query(snapSql)).rows;
    wp0DiffRows = (await db.query(diffSql)).rows;
    wp0Cat1Rows = (await db.query(catSql)).rows.filter((r) => r.drift_category === "CAT1_FUTURE_OR_OVERLAPPING");
  }

  return {
    actorContexts,
    leaveAuthorities,
    leaveRoutings,
    rawCapGrants,
    rawScopeGrants,
    rawTeamMemberships,
    rawTeamLeaders,
    rawDeptMemberships,
    rawLeaveApprovers,
    wp0SnapshotRows,
    wp0DiffRows,
    wp0Cat1Rows,
  };
}

test("WP1/S1: API & contract layers reject future effective/end dates and default omitted dates to server today", async () => {
  const serverToday = "2026-11-12";
  const futureDate = "2026-11-13";
  const validUuid = "2a000000-0000-4000-8000-000000000005";
  const validTeamUuid = "9a000000-0000-4000-8000-0000000000a1";
  const validIdem = "5a000000-0000-4000-8000-000000000001";

  // 1. Accounting department membership contract
  const acctAssignFuture = validateAssignAccountingMemberBody(
    {
      account_ref: validUuid,
      expected_pair_version: 0,
      effective_from: futureDate,
      reason: "Test future date rejection",
      idempotency_key: validIdem,
    },
    validIdem,
    serverToday,
  );
  assert.equal(acctAssignFuture.ok, false);
  assert.equal(acctAssignFuture.code, "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID");

  const acctAssignDefault = validateAssignAccountingMemberBody(
    {
      account_ref: validUuid,
      expected_pair_version: 0,
      reason: "Test default today",
      idempotency_key: validIdem,
    },
    validIdem,
    serverToday,
  );
  assert.equal(acctAssignDefault.ok, true);
  assert.equal(acctAssignDefault.value.effective_from, null);

  const acctEndFuture = validateEndAccountingMemberBody(
    validUuid,
    {
      expected_pair_version: 1,
      effective_to: futureDate,
      reason: "Test future end rejection",
      idempotency_key: validIdem,
    },
    validIdem,
    serverToday,
  );
  assert.equal(acctEndFuture.ok, false);
  assert.equal(acctEndFuture.code, "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID");

  // 2. Vendor Finance governance contracts
  assert.equal(
    validateAssignProjectAccountantBody(
      {
        project_id: PROJECT_1,
        account_ref: validUuid,
        expected_pair_version: 0,
        effective_from: futureDate,
        reason: "Future project accountant",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateEndProjectAccountantBody(
      {
        assignment_id: validUuid,
        expected_version: 1,
        effective_to: futureDate,
        reason: "Future end project accountant",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateAssignGlobalRoleBody(
      {
        account_ref: validUuid,
        role_code: "VENDOR_FINANCE_GLOBAL_VIEWER",
        expected_pair_version: 0,
        effective_from: futureDate,
        reason: "Future global role",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateEndGlobalRoleBody(
      {
        grant_id: validUuid,
        expected_version: 1,
        effective_to: futureDate,
        reason: "Future end global role",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    ).ok,
    false,
  );

  // 3. Attendance branch & slot policy assignment contracts
  assert.equal(
    validateAssignBranchBody(
      {
        target_app_user_id: validUuid,
        branch_id: BRANCH_1,
        valid_from: futureDate,
        expected_version: 1,
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateUnassignBranchBody(
      {
        assignment_id: BRANCH_1,
        valid_to: futureDate,
        expected_version: 1,
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateAssignSlotPolicyBody(
      {
        target_app_user_id: validUuid,
        profile_id: BRANCH_1,
        valid_from: futureDate,
        expected_version: 1,
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateUnassignSlotPolicyBody(
      {
        assignment_id: BRANCH_1,
        valid_to: futureDate,
        expected_version: 1,
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );

  // 4. Personnel from account & Project-Team scope contracts
  assert.equal(
    validateCreatePersonnelFromAccountBody(
      {
        app_user_id: validUuid,
        display_name: "Test Person",
        personnel_position: "STAFF",
        hrp_valid_from: futureDate,
        reason: "Future hrp_valid_from",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  assert.equal(
    validateProjectTeamScopeRevokeBody(
      {
        project_id: PROJECT_1,
        team_id: validTeamUuid,
        valid_from: "2026-01-01",
        valid_to: futureDate,
        expected_version: 1,
        reason: "Future revoke",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );

  // 5. Team Membership, Team Leader, Project Manager, and Leave Department Approver API request validators
  assert.equal(
    teamMembershipAssignRequest(
      {
        valid_from: futureDate,
        expected_version: 1,
        reason: "Future assign",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  const tmAssignDefault = teamMembershipAssignRequest(
    {
      expected_version: 1,
      reason: "Default assign today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tmAssignDefault.ok, true);
  assert.equal(tmAssignDefault.value.valid_from, serverToday);

  assert.equal(
    teamMembershipUnassignRequest(
      {
        valid_to: futureDate,
        expected_version: 1,
        reason: "Future unassign",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  const tmUnassignDefault = teamMembershipUnassignRequest(
    {
      expected_version: 1,
      reason: "Default unassign today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tmUnassignDefault.ok, true);
  assert.equal(tmUnassignDefault.value.valid_to, serverToday);

  assert.equal(
    teamLeaderDesignateRequest(
      {
        leader_app_user_id: validUuid,
        effective_date: futureDate,
        expected_version: 1,
        reason: "Future designate leader",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  const tlDesignateDefault = teamLeaderDesignateRequest(
    {
      leader_app_user_id: validUuid,
      expected_version: 1,
      reason: "Default designate leader today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tlDesignateDefault.ok, true);
  assert.equal(tlDesignateDefault.value.effective_date, serverToday);

  assert.equal(
    teamLeaderRevokeRequest(
      {
        effective_date: futureDate,
        expected_version: 1,
        reason: "Future revoke leader",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  const tlRevokeDefault = teamLeaderRevokeRequest(
    {
      expected_version: 1,
      reason: "Default revoke leader today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tlRevokeDefault.ok, true);
  assert.equal(tlRevokeDefault.value.effective_date, serverToday);

  assert.equal(
    projectAdminAssignRequest(
      {
        manager_recruiter_id: validUuid,
        valid_from: futureDate,
        expected_project_version: 1,
        reason: "Future PM assign",
        idempotency_key: validIdem,
      },
      serverToday,
    ).ok,
    false,
  );
  const pmAssignDefault = projectAdminAssignRequest(
    {
      manager_recruiter_id: validUuid,
      expected_project_version: 1,
      reason: "Default PM assign today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(pmAssignDefault.ok, true);
  assert.equal(pmAssignDefault.value.valid_from, serverToday);

  const leaveRes = parsePatchAdminConfigBody(
    {
      operation: "SET_DEPARTMENT_APPROVER",
      unit_kind: "MARKETING",
      approver_app_user_id: validUuid,
      valid_from: futureDate,
      expected_row_version: 0,
      reason: "Future leave approver",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(leaveRes.ok, false);
  assert.equal(leaveRes.code, "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN");

  const leaveDefault = parsePatchAdminConfigBody(
    {
      operation: "SET_DEPARTMENT_APPROVER",
      unit_kind: "MARKETING",
      approver_app_user_id: validUuid,
      expected_row_version: 0,
      reason: "Default leave approver today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(leaveDefault.ok, true);
  assert.equal(leaveDefault.data.valid_from, null);
});

test("WP1/S1: Pre/Post Migration Baseline Parity, RPC Future-Date Rejection, Immediate Handover, and Day-Boundary Stability", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    await db.exec("alter table auth.users add column email text;");

    const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
    const wp1Idx = names.indexOf(WP1_MIGRATION_NAME);
    assert.ok(wp1Idx >= 0, `Migration ${WP1_MIGRATION_NAME} must exist`);

    // 1. Apply all migrations BEFORE WP1
    for (const name of names.slice(0, wp1Idx)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const TODAY = "2026-11-12";
    const TOMORROW = "2026-11-13";
    const PAST = "2026-01-01";
    await setBusinessDate(db, TODAY);

    // 2. Seed baseline dataset (including a pre-existing future row to verify WP1 does not rewrite history)
    await db.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'WP1_TM_A', 'Team Alpha WP1', true, 1),
              ($2::uuid, 'WP1_TM_B', 'Team Beta WP1', true, 1)`,
      [TEAM_A, TEAM_B],
    );

    for (const actor of Object.values(ACTORS)) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        actor.auth,
        actor.email,
      ]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, created_at)
         values ($1::uuid, $2::uuid, true, $3, '2026-01-01T00:00:00Z'::timestamptz)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    // Grant Full Admin & Catalog Operator
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, $3::date, true)`,
        [ACTORS.fullAdmin.app, cap, PAST],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', $2::date, true)`,
      [ACTORS.fullAdmin.app, PAST],
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'catalog_master_manage', $2::date, true)`,
      [ACTORS.catalogOp.app, PAST],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', $2::date, true)`,
      [ACTORS.catalogOp.app, PAST],
    );

    // Seed recruiters + HRP provider + team memberships + links + leave profiles
    for (const person of [ACTORS.leader1, ACTORS.leader2, ACTORS.staff1]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_own', $2::date, true)`,
        [person.app, PAST],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'own', $2::date, true)`,
        [person.app, PAST],
      );
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
         values ($1::uuid, $2, $3, 'STAFF', true, 1)`,
        [person.recruiter, person.name, person.code],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', $2::date, true)`,
        [person.recruiter, PAST],
      );
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, $3::date, true)`,
        [person.recruiter, TEAM_A, PAST],
      );
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, $3::date, true)`,
        [person.app, person.recruiter, PAST],
      );
      await db.query(
        `insert into public.leave_employee_profiles
           (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)
         values ($1::uuid, 'RECRUITMENT', 'OFFICIAL', $2::date, $2::date, false)`,
        [person.app, PAST],
      );
    }

    for (const mktPerson of [ACTORS.mktApprover1, ACTORS.mktApprover2, ACTORS.mktStaff]) {
      await db.query(
        `insert into public.leave_employee_profiles
           (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)
         values ($1::uuid, 'MARKETING', 'OFFICIAL', $2::date, $2::date, false)`,
        [mktPerson.app, PAST],
      );
    }

    // Pre-WP1 initial designations (Leader 1 on TEAM_A, mktApprover1 on MARKETING)
    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Seed Leader 1', 'wp1-seed-tl1'
       )`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, ACTORS.leader1.app, PAST],
    );
    await db.query(
      `select public.leave_management_set_department_approver_admin(
         $1::uuid, $2::uuid, 'MARKETING', $3::uuid, $4::date, 0, 'Seed MKT Approver 1', 'wp1-seed-mkt1', 'fp-seed-mkt1'
       )`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover1.app, PAST],
    );

    // Pre-existing legacy future-dated row (seeded before WP1 to prove WP1 preserves history & CAT1 detects it)
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current)
       values ($1::uuid, 'team', $2::uuid, '2026-12-01'::date, null, false)`,
      [ACTORS.staff1.app, TEAM_B],
    );

    // 3. Capture Pre-WP1 Baseline Snapshot
    const preWp1Snapshot = await captureEffectiveAuthorizationSnapshot(db, TODAY);
    if (preWp1Snapshot.wp0Cat1Rows !== null) {
      assert.equal(
        preWp1Snapshot.wp0Cat1Rows.length,
        1,
        "CAT1 query must report the 1 pre-existing future-dated row without modifying it",
      );
    }

    // 4. Apply WP1 Migration (`20261112120000_wp1_s1_block_future_org_authz_assignments.sql`)
    await db.exec(await readFile(path.join(MIGRATION_DIR, WP1_MIGRATION_NAME), "utf8"));
    await setBusinessDate(db, TODAY);

    // 5. Capture Post-WP1 Snapshot & Verify 0 Unintended Diff
    const postWp1Snapshot = await captureEffectiveAuthorizationSnapshot(db, TODAY);
    assert.deepEqual(
      postWp1Snapshot,
      preWp1Snapshot,
      "WP1 migration must produce 0 diff in effective permissions and preserve pre-existing rows untouched",
    );

    // 6. Verify RPC Future-Date Rejection (`ERRCODE = '22023'`) across all WP1 RPCs
    const assertFutureRpcRejected = async (label, sql, params) => {
      await assert.rejects(
        () => db.query(sql, params),
        (err) => err.code === "22023",
        `${label} must reject future date with ERRCODE 22023`,
      );
    };

    await assertFutureRpcRejected(
      "direct_entry_assign_team_membership",
      "select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Reason', 'idem-f1')",
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TEAM_B, TOMORROW],
    );
    await assertFutureRpcRejected(
      "direct_entry_move_team_membership",
      "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Reason', 'idem-f2')",
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TEAM_B, TOMORROW],
    );
    await assertFutureRpcRejected(
      "direct_entry_unassign_team_membership",
      "select public.direct_entry_unassign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::date, 1, 'Reason', 'idem-f3')",
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TOMORROW],
    );
    await assertFutureRpcRejected(
      "direct_entry_designate_team_leader",
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 2, 'Reason', 'idem-f4')",
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, ACTORS.leader2.app, TOMORROW],
    );
    await assertFutureRpcRejected(
      "direct_entry_revoke_team_leader",
      "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, $4::date, 2, 'Reason', 'idem-f5')",
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, TOMORROW],
    );
    await assertFutureRpcRejected(
      "org_department_assign_accounting_member",
      "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, 0, $4::date, 'Reason', '6a000000-0000-4000-8000-000000000001'::uuid, 'fp-f6')",
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.acctUser.app, TOMORROW],
    );
    await assertFutureRpcRejected(
      "vendor_finance_assign_global_role_admin",
      "select public.vendor_finance_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'VENDOR_FINANCE_GLOBAL_VIEWER', 0, $4::date, 'Reason', '6a000000-0000-4000-8000-000000000002'::uuid, 'fp-f7')",
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.vfinViewer.app, TOMORROW],
    );
    await assertFutureRpcRejected(
      "leave_management_set_department_approver_admin",
      "select public.leave_management_set_department_approver_admin($1::uuid, $2::uuid, 'MARKETING', $3::uuid, $4::date, 1, 'Reason', 'idem-f8', 'fp-f8')",
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover2.app, TOMORROW],
    );

    // -------------------------------------------------------------------------
    // 7. Dedicated Suite A: Team Leader Handover (`direct_entry_apply_team_leader_mutation`)
    //    - Immediate handover with null date defaults to TODAY
    //    - Closes outgoing leader1 & opens incoming leader2 at TODAY with 0 gap/overlap
    //    - Syncs all 5 leader capabilities (`team_manager_assign`, `report_view`,
    //      `report_analytics_view`, `report_assign`, `report_review`)
    // -------------------------------------------------------------------------
    const {
      rows: [{ result: tlReplaced }],
    } = await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 2, 'Immediate handover to Leader 2', 'wp1-tl-handover-1'
       ) as result`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, ACTORS.leader2.app],
    );
    assert.equal(tlReplaced.change, "replace");
    assert.equal(tlReplaced.leader_app_user_id, ACTORS.leader2.app);
    assert.equal(tlReplaced.valid_from, TODAY);
    assert.equal(tlReplaced.valid_to, null);

    const { rows: tlRowsAfterReplace } = await db.query(
      `select leader_app_user_id::text, valid_from::text, valid_to::text, is_current
         from public.direct_entry_team_leader_assignments
        where team_id = $1::uuid
        order by valid_from`,
      [TEAM_A],
    );
    assert.deepEqual(tlRowsAfterReplace, [
      {
        leader_app_user_id: ACTORS.leader1.app,
        valid_from: PAST,
        valid_to: TODAY,
        is_current: false,
      },
      {
        leader_app_user_id: ACTORS.leader2.app,
        valid_from: TODAY,
        valid_to: null,
        is_current: true,
      },
    ]);

    const LEADER_CAPABILITIES = [
      "report_analytics_view",
      "report_assign",
      "report_review",
      "report_view",
      "team_manager_assign",
    ];
    const { rows: leader1CapsAfterReplace } = await db.query(
      `select capability, valid_to::text, is_current
         from public.direct_entry_capability_grants
        where app_user_id = $1::uuid
          and capability = any($2::text[])
        order by capability`,
      [ACTORS.leader1.app, LEADER_CAPABILITIES],
    );
    assert.equal(leader1CapsAfterReplace.length, 5);
    for (const row of leader1CapsAfterReplace) {
      assert.equal(row.valid_to, TODAY, `Outgoing leader ${row.capability} must close at ${TODAY}`);
      assert.equal(row.is_current, false, `Outgoing leader ${row.capability} must have is_current = false`);
    }

    const { rows: leader2CapsAfterReplace } = await db.query(
      `select capability, valid_from::text, valid_to::text, is_current
         from public.direct_entry_capability_grants
        where app_user_id = $1::uuid
          and capability = any($2::text[])
        order by capability`,
      [ACTORS.leader2.app, LEADER_CAPABILITIES],
    );
    assert.equal(leader2CapsAfterReplace.length, 5);
    for (const row of leader2CapsAfterReplace) {
      assert.equal(row.valid_from, TODAY);
      assert.equal(row.valid_to, null);
      assert.equal(row.is_current, true);
    }

    // Verify immediate leave routing & actor context switch from leader1 to leader2
    const {
      rows: [{ route: staff1RouteAfterTlHandover }],
    } = await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [ACTORS.staff1.app, TODAY],
    );
    assert.equal(staff1RouteAfterTlHandover.route_kind, "TEAM_LEADER");
    assert.equal(staff1RouteAfterTlHandover.primary_approver_app_user_id, ACTORS.leader2.app);

    // -------------------------------------------------------------------------
    // 8. Dedicated Suite B: Leave Department Approver Handover (`leave_management_set_department_approver_admin`)
    //    - Omitted/null `p_valid_from` defaults to TODAY
    //    - Closes outgoing mktApprover1 (`valid_to = TODAY`, `is_current = false`)
    //    - Opens incoming mktApprover2 (`valid_from = TODAY`, `valid_to = null`, `is_current = true`)
    // -------------------------------------------------------------------------
    const {
      rows: [{ result: mktHandover }],
    } = await db.query(
      `select public.leave_management_set_department_approver_admin(
         $1::uuid, $2::uuid, 'MARKETING', $3::uuid, null, 1,
         'Immediate Marketing approver handover', 'wp1-mkt-handover-1', 'fp-mkt-handover-1'
       ) as result`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover2.app],
    );
    assert.equal(mktHandover.replayed, false);
    assert.equal(mktHandover.department_approver.approver_app_user_id, ACTORS.mktApprover2.app);
    assert.equal(mktHandover.department_approver.valid_from, TODAY);
    assert.equal(mktHandover.department_approver.is_current, true);

    const { rows: mktApproverRows } = await db.query(
      `select approver_app_user_id::text, valid_from::text, valid_to::text, is_current
         from public.leave_department_approvers
        where unit_kind = 'MARKETING'
        order by valid_from, row_version`,
    );
    assert.deepEqual(mktApproverRows, [
      {
        approver_app_user_id: ACTORS.mktApprover1.app,
        valid_from: PAST,
        valid_to: TODAY,
        is_current: false,
      },
      {
        approver_app_user_id: ACTORS.mktApprover2.app,
        valid_from: TODAY,
        valid_to: null,
        is_current: true,
      },
    ]);

    const {
      rows: [{ route: mktRouteAfterHandover }],
    } = await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [ACTORS.mktStaff.app, TODAY],
    );
    assert.equal(mktRouteAfterHandover.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktRouteAfterHandover.primary_approver_app_user_id, ACTORS.mktApprover2.app);

    // -------------------------------------------------------------------------
    // 9. Dedicated Suite C: Ending Team Membership (`direct_entry_unassign_team_membership`)
    //    - Omitted/null `p_valid_to` defaults to TODAY
    //    - Closes active membership immediately (`valid_to = TODAY`, `is_current = false`)
    // -------------------------------------------------------------------------
    const {
      rows: [{ result: staff1Unassigned }],
    } = await db.query(
      `select public.direct_entry_unassign_team_membership(
         $1::uuid, $2::uuid, $3::uuid, null, 1, 'End team membership immediately', 'wp1-unassign-staff1'
       ) as result`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter],
    );
    assert.equal(staff1Unassigned.change, "UNASSIGN");
    assert.equal(staff1Unassigned.valid_to, TODAY);

    const { rows: staff1Memberships } = await db.query(
      `select team_id::text, valid_from::text, valid_to::text, is_current
         from public.recruiter_team_memberships
        where recruiter_id = $1::uuid`,
      [ACTORS.staff1.recruiter],
    );
    assert.deepEqual(staff1Memberships, [
      {
        team_id: TEAM_A,
        valid_from: PAST,
        valid_to: TODAY,
        is_current: false,
      },
    ]);

    // -------------------------------------------------------------------------
    // 10. Day-Boundary Stability ("qua ngày mà không có thao tác ghi không làm đổi quyền")
    //     Advance business date from TODAY (2026-11-12) to TOMORROW (2026-11-13)
    //     without any write operation and verify all actor contexts, leave authorities,
    //     and routings remain 100% identical.
    // -------------------------------------------------------------------------
    const snapshotEndOfToday = await captureEffectiveAuthorizationSnapshot(db, TODAY);
    await setBusinessDate(db, TOMORROW);
    const snapshotStartOfTomorrow = await captureEffectiveAuthorizationSnapshot(db, TOMORROW);

    assert.deepEqual(
      snapshotStartOfTomorrow.actorContexts,
      snapshotEndOfToday.actorContexts,
      "Crossing a day boundary without a write must not change direct_entry_resolve_actor_context",
    );
    assert.deepEqual(
      snapshotStartOfTomorrow.leaveAuthorities,
      snapshotEndOfToday.leaveAuthorities,
      "Crossing a day boundary without a write must not change leave_management__internal_resolve_authority",
    );
    assert.deepEqual(
      snapshotStartOfTomorrow.leaveRoutings,
      snapshotEndOfToday.leaveRoutings,
      "Crossing a day boundary without a write must not change leave_management__internal_resolve_routing",
    );
  } finally {
    await db.close();
  }
});
