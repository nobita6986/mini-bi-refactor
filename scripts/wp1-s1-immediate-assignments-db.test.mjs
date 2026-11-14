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
  assignTeamMembership,
  teamMembershipAssignRequest,
  teamMembershipUnassignRequest,
  unassignTeamMembership,
} from "../src/lib/direct-entry/team-membership-api.ts";
import { createTeamMembershipRepository } from "../src/lib/direct-entry/team-membership-repository.ts";
import { handlePatchLeaveAdminConfig } from "../src/lib/leave/leave-api.ts";
import { parsePatchAdminConfigBody } from "../src/lib/leave/leave-contract.ts";
import { createLeaveRepository } from "../src/lib/leave/leave-repository.ts";
import {
  isAmbiguousLeaveMutationFailure,
  resolveDepartmentApproverMutationPayload,
} from "../src/lib/leave/leave-ui-model.ts";
import {
  parseAssignGlobalRoleBody as validateAssignGlobalRoleBody,
  parseAssignProjectAccountantBody as validateAssignProjectAccountantBody,
  parseEndGlobalRoleBody as validateEndGlobalRoleBody,
  parseEndProjectAccountantBody as validateEndProjectAccountantBody,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import {
  buildAssignGlobalRoleRequest,
  buildAssignProjectAccountantRequest,
  buildEndGlobalRoleRequest,
  buildEndProjectAccountantRequest,
} from "../src/lib/vendor-finance/ui-model.ts";
import {
  RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
} from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  createWorkReportDelegation,
  listWorkReportDelegations,
  revokeWorkReportDelegation,
} from "../src/lib/work-reports/delegation-api.ts";
import { createDelegationRepository } from "../src/lib/work-reports/delegation-repository.ts";
import {
  applyDelegationCreateDraftEdit,
  createInitialDelegationCreateDraftState,
  isDelegationViewData,
  submitDelegationCreateAttempt,
} from "../src/lib/work-reports/delegation-ui-model.ts";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP1_MIGRATION_NAME = "20261112120000_wp1_s1_block_future_org_authz_assignments.sql";
const WP1_LAST_HOTFIX_MIGRATION_NAME = "20261112180000_hf_wp1_leave_department_approver_optional_reason.sql";
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
  await db.query("select set_config('direct_entry.test_authorization_date', $1, false)", [isoDate]);
  await db.query("select set_config('leave.test_business_date', $1, false)", [isoDate]);
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

test("WP1/S1: API & contract layers reject future and past effective/end dates and keep omitted dates null for server derivation", async () => {
  const serverToday = "2026-11-12";
  const futureDate = "2026-11-13";
  const pastDate = "2026-11-11";
  const validUuid = "2a000000-0000-4000-8000-000000000005";
  const validTeamUuid = "9a000000-0000-4000-8000-0000000000a1";
  const validIdem = "5a000000-0000-4000-8000-000000000001";

  // 1. Accounting department membership contract
  for (const invalidDate of [futureDate, pastDate]) {
    const acctAssignInvalid = validateAssignAccountingMemberBody(
      {
        account_ref: validUuid,
        expected_pair_version: 0,
        effective_from: invalidDate,
        reason: "Test non-today date rejection",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    );
    assert.equal(acctAssignInvalid.ok, false);
    assert.equal(acctAssignInvalid.code, "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID");

    const acctEndInvalid = validateEndAccountingMemberBody(
      validUuid,
      {
        expected_pair_version: 1,
        effective_to: invalidDate,
        reason: "Test non-today end rejection",
        idempotency_key: validIdem,
      },
      validIdem,
      serverToday,
    );
    assert.equal(acctEndInvalid.ok, false);
    assert.equal(acctEndInvalid.code, "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID");
  }

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

  // 2. Vendor Finance governance contracts (future and past rejected)
  for (const invalidDate of [futureDate, pastDate]) {
    assert.equal(
      validateAssignProjectAccountantBody(
        {
          project_id: PROJECT_1,
          account_ref: validUuid,
          expected_pair_version: 0,
          effective_from: invalidDate,
          reason: "Invalid project accountant date",
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
          effective_to: invalidDate,
          reason: "Invalid end project accountant date",
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
          effective_from: invalidDate,
          reason: "Invalid global role date",
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
          effective_to: invalidDate,
          reason: "Invalid end global role date",
          idempotency_key: validIdem,
        },
        validIdem,
        serverToday,
      ).ok,
      false,
    );
  }

  // 3. Attendance branch & slot policy assignment contracts
  for (const invalidDate of [futureDate, pastDate]) {
    assert.equal(
      validateAssignBranchBody(
        {
          target_app_user_id: validUuid,
          branch_id: BRANCH_1,
          valid_from: invalidDate,
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
          valid_to: invalidDate,
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
          valid_from: invalidDate,
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
          valid_to: invalidDate,
          expected_version: 1,
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
  }

  // 4. Personnel from account & Project-Team scope contracts
  for (const invalidDate of [futureDate, pastDate]) {
    assert.equal(
      validateCreatePersonnelFromAccountBody(
        {
          app_user_id: validUuid,
          display_name: "Test Person",
          personnel_position: "STAFF",
          hrp_valid_from: invalidDate,
          reason: "Non-today hrp_valid_from",
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
          valid_to: invalidDate,
          expected_version: 1,
          reason: "Non-today revoke",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
  }

  // 5. Team Membership, Team Leader, Project Manager, and Leave Department Approver API request validators
  for (const invalidDate of [futureDate, pastDate]) {
    assert.equal(
      teamMembershipAssignRequest(
        {
          valid_from: invalidDate,
          expected_version: 1,
          reason: "Non-today assign",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
    assert.equal(
      teamMembershipUnassignRequest(
        {
          valid_to: invalidDate,
          expected_version: 1,
          reason: "Non-today unassign",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
    assert.equal(
      teamLeaderDesignateRequest(
        {
          leader_app_user_id: validUuid,
          effective_date: invalidDate,
          expected_version: 1,
          reason: "Non-today designate leader",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
    assert.equal(
      teamLeaderRevokeRequest(
        {
          effective_date: invalidDate,
          expected_version: 1,
          reason: "Non-today revoke leader",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
    assert.equal(
      projectAdminAssignRequest(
        {
          manager_recruiter_id: validUuid,
          valid_from: invalidDate,
          expected_project_version: 1,
          reason: "Non-today PM assign",
          idempotency_key: validIdem,
        },
        serverToday,
      ).ok,
      false,
    );
  }

  const tmAssignDefault = teamMembershipAssignRequest(
    {
      expected_version: 1,
      reason: "Default assign today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tmAssignDefault.ok, true);
  assert.equal(tmAssignDefault.value.valid_from, null);

  const tmUnassignDefault = teamMembershipUnassignRequest(
    {
      expected_version: 1,
      reason: "Default unassign today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tmUnassignDefault.ok, true);
  assert.equal(tmUnassignDefault.value.valid_to, null);

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
  assert.equal(tlDesignateDefault.value.effective_date, null);

  const tlRevokeDefault = teamLeaderRevokeRequest(
    {
      expected_version: 1,
      reason: "Default revoke leader today",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(tlRevokeDefault.ok, true);
  assert.equal(tlRevokeDefault.value.effective_date, null);

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
  assert.equal(pmAssignDefault.value.valid_from, null);

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

  const leavePastRes = parsePatchAdminConfigBody(
    {
      operation: "SET_DEPARTMENT_APPROVER",
      unit_kind: "MARKETING",
      approver_app_user_id: validUuid,
      valid_from: pastDate,
      expected_row_version: 0,
      reason: "Past leave approver",
      idempotency_key: validIdem,
    },
    serverToday,
  );
  assert.equal(leavePastRes.ok, false);
  assert.equal(leavePastRes.code, "LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN");

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
  const leaveDefaultTomorrow = parsePatchAdminConfigBody(
    {
      operation: "SET_DEPARTMENT_APPROVER",
      unit_kind: "MARKETING",
      approver_app_user_id: validUuid,
      expected_row_version: 0,
      reason: "Default leave approver today",
      idempotency_key: validIdem,
    },
    futureDate,
  );
  assert.equal(leaveDefaultTomorrow.ok, true);
  assert.equal(
    leaveDefault.data.request_fingerprint,
    leaveDefaultTomorrow.data.request_fingerprint,
    "Cross-midnight leave department approver request fingerprint must remain identical when valid_from is omitted",
  );

  // 6. Vendor Finance UI model builders reject both future and past dates and accept null
  for (const invalidDate of [futureDate, pastDate]) {
    assert.equal(
      buildAssignProjectAccountantRequest({
        project_id: PROJECT_1,
        accountant_ref: validUuid,
        valid_from: invalidDate,
        authorization_date: serverToday,
        expected_version: 0,
        reason: "Non-today project accountant UI request",
        idempotency_key: validIdem,
      }).ok,
      false,
    );
    assert.equal(
      buildEndProjectAccountantRequest({
        expected_version: 1,
        valid_to: invalidDate,
        authorization_date: serverToday,
        reason: "Non-today end project accountant UI request",
        idempotency_key: validIdem,
      }).ok,
      false,
    );
    assert.equal(
      buildAssignGlobalRoleRequest({
        account_ref: validUuid,
        role_code: "GLOBAL_VIEWER",
        valid_from: invalidDate,
        authorization_date: serverToday,
        expected_version: 0,
        reason: "Non-today global role UI request",
        idempotency_key: validIdem,
      }).ok,
      false,
    );
    assert.equal(
      buildEndGlobalRoleRequest({
        expected_version: 1,
        valid_to: invalidDate,
        authorization_date: serverToday,
        reason: "Non-today end global role UI request",
        idempotency_key: validIdem,
      }).ok,
      false,
    );
  }

  const vfinAssignUiNull = buildAssignProjectAccountantRequest({
    project_id: PROJECT_1,
    accountant_ref: validUuid,
    valid_from: null,
    authorization_date: serverToday,
    expected_version: 0,
    reason: "Null date project accountant UI request",
    idempotency_key: validIdem,
  });
  assert.equal(vfinAssignUiNull.ok, true);
  assert.equal(vfinAssignUiNull.request.body.valid_from, null);

  const vfinEndUiNull = buildEndProjectAccountantRequest({
    expected_version: 1,
    valid_to: null,
    authorization_date: serverToday,
    reason: "Null date end project accountant UI request",
    idempotency_key: validIdem,
  });
  assert.equal(vfinEndUiNull.ok, true);
  assert.equal(vfinEndUiNull.request.body.valid_to, null);

  // 7. Work Reports Delegation API rejects client-supplied effective_from / effective_to
  for (const badPayload of [
    {
      capability: "report_review",
      delegate_app_user_id: validUuid,
      template_id: validUuid,
      scope_kind: "team",
      scope_id: validTeamUuid,
      idempotency_key: validIdem,
      effective_from: `${serverToday}T00:00:00.000Z`,
    },
    {
      capability: "report_assign",
      delegate_app_user_id: validUuid,
      template_id: validUuid,
      scope_kind: "team",
      scope_id: validTeamUuid,
      idempotency_key: validIdem,
      effective_to: `${futureDate}T23:59:59.000Z`,
    },
  ]) {
    const req = new Request("https://app.test/api/work-reports/delegations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
        host: "app.test",
        "sec-fetch-site": "same-origin",
        "idempotency-key": validIdem,
      },
      body: JSON.stringify(badPayload),
    });
    const res = await createWorkReportDelegation(req, "true", {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: ACTORS.leader1.auth,
            app_user_id: ACTORS.leader1.app,
            capabilities: ["report_assign", "report_review"],
          },
        },
      }),
      repository: {
        create: async () => {
          throw new Error("repository.create must not be called when client sends effective_from/effective_to");
        },
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "WORK_REPORT_DELEGATION_INVALID");
  }
});

test("WP1/S1: Pre/Post Migration Baseline Parity, RPC Future-Date Rejection, Immediate Handover, and Day-Boundary Stability", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    await db.exec("alter table auth.users add column email text;");

    const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
    const wp1Idx = names.indexOf(WP1_MIGRATION_NAME);
    assert.ok(wp1Idx >= 0, `Migration ${WP1_MIGRATION_NAME} must exist`);
    const wp1HotfixIdx = names.indexOf(WP1_LAST_HOTFIX_MIGRATION_NAME);
    assert.ok(wp1HotfixIdx >= wp1Idx, `Migration ${WP1_LAST_HOTFIX_MIGRATION_NAME} must exist at or after WP1`);

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
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'WP1 Project 01', true, 1)`,
      [PROJECT_1],
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

    // 4. Apply WP1 Migration (`20261112120000_wp1_s1_block_future_org_authz_assignments.sql`) through WP1 hotfix
    for (const name of names.slice(wp1Idx, wp1HotfixIdx + 1)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await setBusinessDate(db, TODAY);

    // 5. Capture Post-WP1 Snapshot & Verify 0 Unintended Diff
    const postWp1Snapshot = await captureEffectiveAuthorizationSnapshot(db, TODAY);
    assert.deepEqual(
      postWp1Snapshot,
      preWp1Snapshot,
      "WP1 migration must produce 0 diff in effective permissions and preserve pre-existing rows untouched",
    );

    // 5b. Apply post-WP1 migrations (WP2A/WP3B/WP5B-1) and verify additive-only context parity
    for (const name of names.slice(wp1HotfixIdx + 1)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await setBusinessDate(db, TODAY);

    const postForwardSnapshot = await captureEffectiveAuthorizationSnapshot(db, TODAY);
    const normalizedForwardActorContexts = Object.fromEntries(
      Object.entries(postForwardSnapshot.actorContexts).map(([actorKey, ctx]) => {
        assert.equal(
          Array.isArray(ctx.assigned_roles),
          true,
          `${actorKey} direct_entry_resolve_actor_context must include assigned_roles array`,
        );
        assert.equal(
          Array.isArray(ctx.effective_grants),
          true,
          `${actorKey} direct_entry_resolve_actor_context must include effective_grants array`,
        );
        const { assigned_roles: _assignedRoles, effective_grants: _effectiveGrants, ...legacyCtx } = ctx;
        return [actorKey, legacyCtx];
      }),
    );
    assert.deepEqual(
      { ...postForwardSnapshot, actorContexts: normalizedForwardActorContexts },
      preWp1Snapshot,
      "Post-WP1 migrations (including WP5B-1) must preserve pre-existing actor context fields, leave authorities, and raw tables identically",
    );

    // 6. Verify RPC Future-Date AND Past-Date Rejection (`ERRCODE = '22023'`) across all WP1 RPCs
    const YESTERDAY = "2026-11-11";
    const assertInvalidDateRpcRejected = async (label, sql, params) => {
      await assert.rejects(
        () => db.query(sql, params),
        (err) => err.code === "22023",
        `${label} must reject non-today date with ERRCODE 22023`,
      );
    };

    for (const [tag, badDate] of [
      ["future", TOMORROW],
      ["past", YESTERDAY],
    ]) {
      await assertInvalidDateRpcRejected(
        `direct_entry_assign_team_membership (${tag})`,
        "select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Reason', $6)",
        [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TEAM_B, badDate, `idem-f1-${tag}`],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_move_team_membership (${tag})`,
        "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 1, 'Reason', $6)",
        [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TEAM_B, badDate, `idem-f2-${tag}`],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_unassign_team_membership (${tag})`,
        "select public.direct_entry_unassign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::date, 1, 'Reason', $5)",
        [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, badDate, `idem-f3-${tag}`],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_designate_team_leader (${tag})`,
        "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 2, 'Reason', $6)",
        [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, ACTORS.leader2.app, badDate, `idem-f4-${tag}`],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_revoke_team_leader (${tag})`,
        "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, $4::date, 2, 'Reason', $5)",
        [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, badDate, `idem-f5-${tag}`],
      );
      await assertInvalidDateRpcRejected(
        `org_department_assign_accounting_member (${tag})`,
        "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, 0, $4::date, 'Reason', $5::uuid, $6)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          ACTORS.acctUser.app,
          badDate,
          tag === "future"
            ? "6a000000-0000-4000-8000-000000000001"
            : "6a000000-0000-4000-8000-000000000011",
          `fp-f6-${tag}`,
        ],
      );
      await assertInvalidDateRpcRejected(
        `vendor_finance_assign_global_role_admin (${tag})`,
        "select public.vendor_finance_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'VENDOR_FINANCE_GLOBAL_VIEWER', 0, $4::date, 'Reason', $5::uuid, $6)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          ACTORS.vfinViewer.app,
          badDate,
          tag === "future"
            ? "6a000000-0000-4000-8000-000000000002"
            : "6a000000-0000-4000-8000-000000000012",
          `fp-f7-${tag}`,
        ],
      );
      await assertInvalidDateRpcRejected(
        `leave_management_set_department_approver_admin (${tag})`,
        "select public.leave_management_set_department_approver_admin($1::uuid, $2::uuid, 'MARKETING', $3::uuid, $4::date, 1, 'Reason', $5, $6)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          ACTORS.mktApprover2.app,
          badDate,
          `idem-f8-${tag}`,
          `fp-f8-${tag}`,
        ],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_grant_project_team_scope (${tag})`,
        "select public.direct_entry_grant_project_team_scope($1::uuid, $2::uuid, $3::text, $4::uuid, 0, $5::date, 'Reason', $6::text)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          PROJECT_1,
          TEAM_A,
          badDate,
          `idem-f9-${tag}`,
        ],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_assign_project_manager (${tag})`,
        "select public.direct_entry_assign_project_manager($1::uuid, $2::uuid, $3::text, $4::uuid, $5::date, 1, 'Reason', $6::text)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          PROJECT_1,
          ACTORS.leader1.recruiter,
          badDate,
          `idem-f10-${tag}`,
        ],
      );
      await assertInvalidDateRpcRejected(
        `direct_entry_account_operation_create_personnel (${tag})`,
        "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, 1, 'PC-01', 'STAFF', $4::date, 'Reason', $5::text)",
        [
          ACTORS.fullAdmin.auth,
          ACTORS.fullAdmin.app,
          ACTORS.vfinViewer.app,
          badDate,
          `idem-f11-${tag}`,
        ],
      );
    }

    // Grant report_delegate to leader1 & leader2 for work_report_create_delegation tests
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_delegate', $3::date, true),
              ($2::uuid, 'report_delegate', $3::date, true)`,
      [ACTORS.leader1.app, ACTORS.leader2.app, PAST],
    );

    const TEMPLATE_1 = "30000000-0000-4000-8000-000000000001";
    const TEMPLATE_VER_1 = "40000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into public.work_report_templates (template_id, template_code, display_name, default_frequency, status, version, created_by_user_id)
       values ($1::uuid, 'WP1_DAILY_TPL', 'WP1 Daily Template', 'DAILY', 'ACTIVE', 1, $2::uuid)`,
      [TEMPLATE_1, ACTORS.fullAdmin.app],
    );
    await db.query(
      `insert into public.work_report_template_versions (version_id, template_id, version_no, status, schema_json, metric_contract_json, schema_checksum, requires_review, published_by_user_id, published_at)
       values ($1::uuid, $2::uuid, 1, 'PUBLISHED', $3::jsonb, $4::jsonb, repeat('a', 64), true, $5::uuid, now())`,
      [
        TEMPLATE_VER_1,
        TEMPLATE_1,
        JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
        JSON.stringify(buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA)),
        ACTORS.fullAdmin.app,
      ],
    );
    await db.query(
      `update public.work_report_templates set current_published_version_id = $1::uuid where template_id = $2::uuid`,
      [TEMPLATE_VER_1, TEMPLATE_1],
    );

    // Verify work_report_create_delegation rejects client-supplied effective_from / effective_to
    await assertInvalidDateRpcRejected(
      "work_report_create_delegation (client effective_from)",
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, $6::timestamptz, null, 'fp-del-bad-from'
       )`,
      [
        ACTORS.leader1.auth,
        ACTORS.leader1.app,
        ACTORS.staff1.app,
        TEMPLATE_1,
        TEAM_A,
        `${TODAY}T00:00:00Z`,
      ],
    );
    await assertInvalidDateRpcRejected(
      "work_report_create_delegation (client effective_to)",
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'team', $5::uuid, null, $6::timestamptz, 'fp-del-bad-to'
       )`,
      [
        ACTORS.leader1.auth,
        ACTORS.leader1.app,
        ACTORS.staff1.app,
        TEMPLATE_1,
        TEAM_A,
        `${TOMORROW}T23:59:59Z`,
      ],
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

    // -------------------------------------------------------------------------
    // 11. Dedicated Suite D: Cross-Midnight Idempotency Replay (RPC & API)
    //     Retrying the same request with the same Idempotency-Key after the
    //     server business date changes from TODAY (2026-11-12) to TOMORROW (2026-11-13)
    //     must replay the committed result rather than raising 22023.
    // -------------------------------------------------------------------------
    const {
      rows: [{ result: staff1UnassignedReplayTomorrow }],
    } = await db.query(
      `select public.direct_entry_unassign_team_membership(
         $1::uuid, $2::uuid, $3::uuid, null, 1, 'End team membership immediately', 'wp1-unassign-staff1'
       ) as result`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter],
    );
    assert.deepEqual(
      staff1UnassignedReplayTomorrow,
      staff1Unassigned,
      "Cross-midnight RPC retry of direct_entry_unassign_team_membership must return committed result",
    );

    const {
      rows: [{ result: tlReplacedReplayTomorrow }],
    } = await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 2, 'Immediate handover to Leader 2', 'wp1-tl-handover-1'
       ) as result`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, TEAM_A, ACTORS.leader2.app],
    );
    assert.deepEqual(
      tlReplacedReplayTomorrow,
      tlReplaced,
      "Cross-midnight RPC retry of direct_entry_designate_team_leader must return committed result",
    );

    const {
      rows: [{ result: mktHandoverReplayTomorrow }],
    } = await db.query(
      `select public.leave_management_set_department_approver_admin(
         $1::uuid, $2::uuid, 'MARKETING', $3::uuid, null, 1,
         'Immediate Marketing approver handover', 'wp1-mkt-handover-1', 'fp-mkt-handover-1'
       ) as result`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover2.app],
    );
    assert.equal(mktHandoverReplayTomorrow.replayed, true);
    assert.equal(mktHandoverReplayTomorrow.department_approver.valid_from, TODAY);

    // End-to-end API + Repository + DB cross-midnight retry for assignTeamMembership & unassignTeamMembership
    const pgliteRepo = createTeamMembershipRepository(async (fnName, args) => {
      try {
        if (fnName === "direct_entry_assign_team_membership") {
          const { rows } = await db.query(
            `select public.direct_entry_assign_team_membership(
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7::text, $8::text
             ) as data`,
            [
              args.p_auth_subject,
              args.p_app_user_id,
              args.p_recruiter_id,
              args.p_team_id,
              args.p_valid_from,
              args.p_expected_version,
              args.p_reason,
              args.p_idempotency_key,
            ],
          );
          return { data: rows[0].data, error: null };
        }
        if (fnName === "direct_entry_unassign_team_membership") {
          const { rows } = await db.query(
            `select public.direct_entry_unassign_team_membership(
               $1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6::text, $7::text
             ) as data`,
            [
              args.p_auth_subject,
              args.p_app_user_id,
              args.p_recruiter_id,
              args.p_valid_to,
              args.p_expected_version,
              args.p_reason,
              args.p_idempotency_key,
            ],
          );
          return { data: rows[0].data, error: null };
        }
        return { data: null, error: { code: "XX000", message: "Unsupported RPC in test" } };
      } catch (err) {
        return { data: null, error: { code: err.code, message: err.message } };
      }
    });

    const apiDeps = {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: ACTORS.catalogOp.auth,
            app_user_id: ACTORS.catalogOp.app,
          },
        },
      }),
      repository: pgliteRepo,
    };

    const assignKeyAcrossMidnight = "7a000000-0000-4000-8000-000000000001";
    const makeAssignReq = () =>
      new Request(
        `https://app.test/api/admin/catalog/personnel/${ACTORS.staff1.recruiter}/team-memberships/${TEAM_A}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.test",
            host: "app.test",
            "sec-fetch-site": "same-origin",
            "idempotency-key": assignKeyAcrossMidnight,
          },
          body: JSON.stringify({
            expected_version: 2,
            reason: "Re-assign staff1 on 2026-11-13 before midnight",
            idempotency_key: assignKeyAcrossMidnight,
          }),
        },
      );

    // Execute initial assign on 2026-11-13 (TOMORROW)
    const assignRes1 = await assignTeamMembership(
      makeAssignReq(),
      ACTORS.staff1.recruiter,
      TEAM_A,
      "true",
      apiDeps,
    );
    assert.equal(assignRes1.status, 200);
    const assignBody1 = await assignRes1.json();
    assert.equal(assignBody1.ok, true);
    assert.equal(assignBody1.membership.valid_from, TOMORROW);

    // Advance clock across midnight to 2026-11-14 and retry the exact same API request
    const DAY_AFTER_TOMORROW = "2026-11-14";
    await setBusinessDate(db, DAY_AFTER_TOMORROW);
    const assignRes2 = await assignTeamMembership(
      makeAssignReq(),
      ACTORS.staff1.recruiter,
      TEAM_A,
      "true",
      apiDeps,
    );
    assert.equal(assignRes2.status, 200);
    const assignBody2 = await assignRes2.json();
    assert.deepEqual(
      assignBody2,
      assignBody1,
      "Cross-midnight API retry of assignTeamMembership must replay 200 OK with committed payload",
    );

    // Now test unassignTeamMembership API retry across midnight (2026-11-14 -> 2026-11-15)
    const unassignKeyAcrossMidnight = "7a000000-0000-4000-8000-000000000002";
    const makeUnassignReq = () =>
      new Request(
        `https://app.test/api/admin/catalog/personnel/${ACTORS.staff1.recruiter}/team-memberships/unassign`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.test",
            host: "app.test",
            "sec-fetch-site": "same-origin",
            "idempotency-key": unassignKeyAcrossMidnight,
          },
          body: JSON.stringify({
            expected_version: 3,
            reason: "Unassign staff1 before midnight",
            idempotency_key: unassignKeyAcrossMidnight,
          }),
        },
      );

    const unassignRes1 = await unassignTeamMembership(
      makeUnassignReq(),
      ACTORS.staff1.recruiter,
      "true",
      apiDeps,
    );
    assert.equal(unassignRes1.status, 200);
    const unassignBody1 = await unassignRes1.json();
    assert.equal(unassignBody1.ok, true);
    assert.equal(unassignBody1.membership.valid_to, DAY_AFTER_TOMORROW);

    await setBusinessDate(db, "2026-11-15");
    const unassignRes2 = await unassignTeamMembership(
      makeUnassignReq(),
      ACTORS.staff1.recruiter,
      "true",
      apiDeps,
    );
    assert.equal(unassignRes2.status, 200);
    const unassignBody2 = await unassignRes2.json();
    assert.deepEqual(
      unassignBody2,
      unassignBody1,
      "Cross-midnight API retry of unassignTeamMembership must replay 200 OK with committed payload",
    );

    // -------------------------------------------------------------------------
    // 12. Dedicated Suite E: Project-Team Scope & PM Assignment Immediate Effect + Cross-Midnight Retry
    // -------------------------------------------------------------------------
    await setBusinessDate(db, "2026-11-15");
    const {
      rows: [{ result: ptScopeGranted }],
    } = await db.query(
      `select public.direct_entry_grant_project_team_scope(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, null, 'Grant project-team scope immediately', 'wp1-pt-scope-1'
       ) as result`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, PROJECT_1, TEAM_A],
    );
    assert.equal(ptScopeGranted.valid_from, "2026-11-15");
    assert.equal(ptScopeGranted.valid_to, null);
    assert.equal(ptScopeGranted.created, true);

    const {
      rows: [{ result: pmAssigned }],
    } = await db.query(
      `select public.direct_entry_assign_project_manager(
         $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, 'Assign PM immediately', 'wp1-pm-assign-1'
       ) as result`,
      [ACTORS.leader2.auth, ACTORS.leader2.app, PROJECT_1, ACTORS.leader2.recruiter],
    );
    assert.equal(pmAssigned.manager_recruiter_id, ACTORS.leader2.recruiter);
    assert.equal(pmAssigned.valid_from, "2026-11-15");
    assert.equal(pmAssigned.valid_to, null);
    assert.equal(pmAssigned.already_assigned, false);

    // Advance date across midnight to 2026-11-16 and replay both with the same Idempotency-Key
    await setBusinessDate(db, "2026-11-16");
    const {
      rows: [{ result: ptScopeReplay }],
    } = await db.query(
      `select public.direct_entry_grant_project_team_scope(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, null, 'Grant project-team scope immediately', 'wp1-pt-scope-1'
       ) as result`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, PROJECT_1, TEAM_A],
    );
    assert.deepEqual(
      ptScopeReplay,
      ptScopeGranted,
      "Cross-midnight retry of direct_entry_grant_project_team_scope must replay committed result",
    );

    const {
      rows: [{ result: pmAssignReplay }],
    } = await db.query(
      `select public.direct_entry_assign_project_manager(
         $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, 'Assign PM immediately', 'wp1-pm-assign-1'
       ) as result`,
      [ACTORS.leader2.auth, ACTORS.leader2.app, PROJECT_1, ACTORS.leader2.recruiter],
    );
    assert.deepEqual(
      pmAssignReplay,
      pmAssigned,
      "Cross-midnight retry of direct_entry_assign_project_manager must replay committed result",
    );

    // -------------------------------------------------------------------------
    // 13. Dedicated Suite F: Work Reports Delegation (`report_assign` & `report_review`)
    //     - Server records `effective_from` immediately on creation; `effective_to` is null
    //     - Retry with same `Idempotency-Key` returns committed result
    //     - Delegated permission persists across day boundaries ("quyền vẫn còn qua ngày")
    //     - Revocation ends delegated permission immediately (`state = 'REVOKED'`, `is_current = false`, `revoked_at` set)
    //     - Direct permissions of the delegate continue to work after delegation revocation
    // -------------------------------------------------------------------------
    // Re-assign staff1 to TEAM_A on 2026-11-16 so staff1 is an active member of TEAM_A
    await db.query(
      `select public.direct_entry_assign_team_membership(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 4, 'Re-assign staff1 to TEAM_A for delegation test', 'wp1-staff1-rejoin-team-a'
       )`,
      [ACTORS.catalogOp.auth, ACTORS.catalogOp.app, ACTORS.staff1.recruiter, TEAM_A],
    );

    const delAssignIdem = "8a000000-0000-4000-8000-000000000011";
    const delReviewIdem = "8a000000-0000-4000-8000-000000000012";

    const {
      rows: [{ result: delAssignCreated }],
    } = await db.query(
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid,
         'team', $5::uuid, null, null, $6::text
       ) as result`,
      [ACTORS.leader2.auth, ACTORS.leader2.app, ACTORS.staff1.app, TEMPLATE_1, TEAM_A, delAssignIdem],
    );
    assert.ok(delAssignCreated.delegation_id);
    assert.equal(typeof delAssignCreated.effective_from, "string");
    assert.equal(delAssignCreated.effective_to, null);
    assert.equal(delAssignCreated.state, "ACTIVE");
    assert.equal(delAssignCreated.status, "ACTIVE");
    assert.equal(delAssignCreated.version, 1);

    const {
      rows: [{ result: delReviewCreated }],
    } = await db.query(
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid,
         'team', $5::uuid, null, null, $6::text
       ) as result`,
      [ACTORS.leader2.auth, ACTORS.leader2.app, ACTORS.staff1.app, TEMPLATE_1, TEAM_A, delReviewIdem],
    );
    assert.ok(delReviewCreated.delegation_id);
    assert.equal(typeof delReviewCreated.effective_from, "string");
    assert.equal(delReviewCreated.effective_to, null);
    assert.equal(delReviewCreated.state, "ACTIVE");
    assert.equal(delReviewCreated.status, "ACTIVE");

    // Retry with same Idempotency-Key returns committed result
    const {
      rows: [{ result: delAssignReplayed }],
    } = await db.query(
      `select public.work_report_create_delegation(
         $1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid,
         'team', $5::uuid, null, null, $6::text
       ) as result`,
      [ACTORS.leader2.auth, ACTORS.leader2.app, ACTORS.staff1.app, TEMPLATE_1, TEAM_A, delAssignIdem],
    );
    assert.deepEqual(delAssignReplayed, delAssignCreated);

    // Advance business date to next day (2026-11-17) and verify open-ended delegations remain active across days
    await setBusinessDate(db, "2026-11-17");

    const {
      rows: [{ ctx: staff1CtxWithDelegation }],
    } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [ACTORS.staff1.auth],
    );
    assert.ok(
      Array.isArray(staff1CtxWithDelegation.effective_report_review_scopes) &&
        staff1CtxWithDelegation.effective_report_review_scopes.some(
          (s) => s.kind === "team" && s.team_id === TEAM_A,
        ),
      "Delegate must retain effective_report_review_scopes for TEAM_A across day boundary",
    );

    const {
      rows: [{ has_assign: hasDelegatedAssign, has_review: hasDelegatedReview }],
    } = await db.query(
      `select public.work_report__internal_has_any_capability_authority($1::uuid, 'report_assign') as has_assign,
              public.work_report__internal_has_any_capability_authority($1::uuid, 'report_review') as has_review`,
      [ACTORS.staff1.app],
    );
    assert.equal(hasDelegatedAssign, true, "Delegate must retain report_assign authority across day boundary");
    assert.equal(hasDelegatedReview, true, "Delegate must retain report_review authority across day boundary");

    const { rows: staff1ReviewAuthRows } = await db.query(
      `select acting_scope_kind, acting_team_id::text, delegation_id::text
         from public.work_report__internal_resolve_capability_authority(
           $1::uuid, 'report_review', $2::uuid, $3::uuid
         )`,
      [ACTORS.staff1.app, TEMPLATE_1, TEAM_A],
    );
    assert.deepEqual(staff1ReviewAuthRows, [
      {
        acting_scope_kind: "team",
        acting_team_id: TEAM_A,
        delegation_id: delReviewCreated.delegation_id,
      },
    ]);

    const { rows: staff1DelegatedAssignAuthRows } = await db.query(
      `select acting_scope_kind, acting_team_id::text, delegation_id::text
         from public.work_report__internal_resolve_capability_authority(
           $1::uuid, 'report_assign', $2::uuid, $3::uuid
         )`,
      [ACTORS.staff1.app, TEMPLATE_1, TEAM_A],
    );
    assert.deepEqual(staff1DelegatedAssignAuthRows, [
      {
        acting_scope_kind: "team",
        acting_team_id: TEAM_A,
        delegation_id: delAssignCreated.delegation_id,
      },
    ]);

    // Also grant staff1 a direct `report_assign` capability + TEAM_A scope grant before revoking delegations
    // so we verify direct permissions of the delegate continue to work after delegation revocation
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'report_assign', '2026-11-17'::date, null, true)`,
      [ACTORS.staff1.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current)
       values ($1::uuid, 'team', $2::uuid, '2026-11-17'::date, null, true)`,
      [ACTORS.staff1.app, TEAM_A],
    );

    // Revoke both delegations and verify immediate termination + history timestamp (`revoked_at`)
    const revAssignIdem = "8a000000-0000-4000-8000-000000000021";
    const revReviewIdem = "8a000000-0000-4000-8000-000000000022";

    const {
      rows: [{ result: delAssignRevoked }],
    } = await db.query(
      `select public.work_report_revoke_delegation(
         $1::uuid, $2::uuid, $3::uuid, 1, $4::text
       ) as result`,
      [
        ACTORS.leader2.auth,
        ACTORS.leader2.app,
        delAssignCreated.delegation_id,
        revAssignIdem,
      ],
    );
    assert.equal(delAssignRevoked.state, "REVOKED");
    assert.equal(delAssignRevoked.status, "REVOKED");
    assert.equal(delAssignRevoked.version, 2);

    // Retry revoke with same Idempotency-Key returns committed result
    const {
      rows: [{ result: delAssignRevokeReplay }],
    } = await db.query(
      `select public.work_report_revoke_delegation(
         $1::uuid, $2::uuid, $3::uuid, 1, $4::text
       ) as result`,
      [
        ACTORS.leader2.auth,
        ACTORS.leader2.app,
        delAssignCreated.delegation_id,
        revAssignIdem,
      ],
    );
    assert.deepEqual(delAssignRevokeReplay, delAssignRevoked);

    const {
      rows: [{ result: delReviewRevoked }],
    } = await db.query(
      `select public.work_report_revoke_delegation(
         $1::uuid, $2::uuid, $3::uuid, 1, $4::text
       ) as result`,
      [
        ACTORS.leader2.auth,
        ACTORS.leader2.app,
        delReviewCreated.delegation_id,
        revReviewIdem,
      ],
    );
    assert.equal(delReviewRevoked.state, "REVOKED");
    assert.equal(delReviewRevoked.status, "REVOKED");
    assert.equal(delReviewRevoked.version, 2);

    // Verify DB history columns on revoked rows (`state = 'REVOKED'`, `is_current = false`, `revoked_at` populated, `effective_to` null)
    const { rows: revokedDelRows } = await db.query(
      `select delegation_id::text, state, is_current, effective_to, revoked_at, revoked_by_user_id::text
         from public.work_report_delegations
        where delegation_id = any($1::uuid[])
        order by capability`,
      [[delAssignCreated.delegation_id, delReviewCreated.delegation_id]],
    );
    assert.equal(revokedDelRows.length, 2);
    for (const row of revokedDelRows) {
      assert.equal(row.state, "REVOKED");
      assert.equal(row.is_current, false);
      assert.equal(row.effective_to, null);
      assert.ok(row.revoked_at !== null, "Server must record revoked_at timestamp for history");
      assert.equal(row.revoked_by_user_id, ACTORS.leader2.app);
    }

    // Verify delegated report_review on TEAM_A is gone immediately, while direct permissions (entry_own + direct report_assign on TEAM_A) still work
    const {
      rows: [{ ctx: staff1CtxAfterRevoke }],
    } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [ACTORS.staff1.auth],
    );
    assert.equal(
      staff1CtxAfterRevoke.capabilities.includes("report_review"),
      false,
      "Revoked report_review delegation must not be in capabilities",
    );
    assert.equal(
      staff1CtxAfterRevoke.effective_report_review_scopes,
      undefined,
      "Revoked delegation effective_report_review_scopes must be removed immediately",
    );
    assert.ok(
      staff1CtxAfterRevoke.capabilities.includes("entry_own"),
      "Delegate direct capability entry_own must still work after delegation revocation",
    );
    assert.ok(
      staff1CtxAfterRevoke.capabilities.includes("report_assign"),
      "Delegate direct capability report_assign must still work after delegation revocation",
    );
    assert.ok(
      staff1CtxAfterRevoke.teams.some((t) => t.team_id === TEAM_A),
      "Delegate direct scope TEAM_A must still work after delegation revocation",
    );

    const {
      rows: [{ has_assign: hasAssignAfterRevoke, has_review: hasReviewAfterRevoke }],
    } = await db.query(
      `select public.work_report__internal_has_any_capability_authority($1::uuid, 'report_assign') as has_assign,
              public.work_report__internal_has_any_capability_authority($1::uuid, 'report_review') as has_review`,
      [ACTORS.staff1.app],
    );
    assert.equal(hasAssignAfterRevoke, true, "Direct report_assign authority must remain true after delegation revocation");
    assert.equal(hasReviewAfterRevoke, false, "Delegated report_review authority must become false immediately on revocation");

    const { rows: staff1DirectAssignOnTeamA } = await db.query(
      `select acting_scope_kind, acting_team_id::text, delegation_id::text
         from public.work_report__internal_resolve_capability_authority(
           $1::uuid, 'report_assign', $2::uuid, $3::uuid
         )`,
      [ACTORS.staff1.app, TEMPLATE_1, TEAM_A],
    );
    assert.deepEqual(staff1DirectAssignOnTeamA, [
      {
        acting_scope_kind: "team",
        acting_team_id: TEAM_A,
        delegation_id: null,
      },
    ]);

    const { rows: staff1RevokedReviewOnTeamA } = await db.query(
      `select acting_scope_kind, acting_team_id::text, delegation_id::text
         from public.work_report__internal_resolve_capability_authority(
           $1::uuid, 'report_review', $2::uuid, $3::uuid
         )`,
      [ACTORS.staff1.app, TEMPLATE_1, TEAM_A],
    );
    assert.equal(
      staff1RevokedReviewOnTeamA.length,
      0,
      "Revoked report_review on TEAM_A must immediately return 0 authority rows",
    );

    // -------------------------------------------------------------------------
    // 14. Dedicated Suite G: Full UI Draft -> API -> Repository -> Named-Parameter SQL Integration
    //     for Work Reports Delegation (`createDelegationRepository` + `p_scope_team_id` + `is_effective` + Retry Safety)
    //     - Calls PostgreSQL RPCs using the exact named parameters sent by `createDelegationRepository`
    //       (`p_scope_team_id => $7`, etc.), catching any parameter name mismatch between TS and SQL.
    //     - Simulates a lost response after server commit on `submitDelegationCreateAttempt`:
    //       verifies `ambiguous_retry_locked` freezes payload & `Idempotency-Key`, retry replays 200 OK
    //       without creating a duplicate delegation record, and revoking the single delegation removes all
    //       delegated review authority.
    //     - Calls `listWorkReportDelegations` when DB has both active (`is_effective: true`) and revoked
    //       (`is_effective: false`, `revoked_at !== null`) delegations and verifies 200 OK parser acceptance.
    // -------------------------------------------------------------------------
    const pgliteNamedRpcCalls = [];
    const pgliteNamedRpc = async (name, args = {}) => {
      const entries = Object.entries(args);
      pgliteNamedRpcCalls.push({ name, paramNames: entries.map(([k]) => k) });
      const namedCall = entries
        .map(([paramName], idx) => `${paramName} => $${idx + 1}`)
        .join(", ");
      try {
        const { rows } = await db.query(
          `select public.${name}(${namedCall}) as data`,
          entries.map(([, value]) => value),
        );
        return { data: rows[0]?.data ?? null, error: null };
      } catch (err) {
        return {
          data: null,
          error: { code: err.code, message: err.message },
        };
      }
    };

    const delegationRepo = createDelegationRepository(pgliteNamedRpc);
    const delegationApiDeps = {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: ACTORS.leader2.auth,
            app_user_id: ACTORS.leader2.app,
          },
        },
      }),
      repository: delegationRepo,
    };

    // Prepare UI draft state for creating a `report_review` delegation to `staff1` on `TEAM_A`
    let uiKeySeq = 0;
    const nextUiKey = () => `9b000000-0000-4000-8000-${String(++uiKeySeq).padStart(12, "0")}`;
    let draft = createInitialDelegationCreateDraftState(nextUiKey);
    draft = applyDelegationCreateDraftEdit(draft, { capability: "report_review" }, nextUiKey);
    draft = applyDelegationCreateDraftEdit(draft, { delegate_id: ACTORS.staff1.app }, nextUiKey);
    draft = applyDelegationCreateDraftEdit(draft, { template_id: TEMPLATE_1 }, nextUiKey);
    draft = applyDelegationCreateDraftEdit(draft, { scope_index: "0" }, nextUiKey);
    const committedAttemptKey = draft.idempotency_key;
    const selectedTeamScope = {
      scope_kind: "team",
      scope_id: TEAM_A,
      label: "Team A",
    };

    // First attempt: API + Repository + SQL commit the delegation row, then response is lost on network
    let dropResponseAfterCommit = true;
    const e2eFetch = async (url, init = {}) => {
      const req = new Request(`https://app.test${url}`, {
        method: init.method ?? "GET",
        headers: {
          origin: "https://app.test",
          host: "app.test",
          "sec-fetch-site": "same-origin",
          ...(init.headers ?? {}),
        },
        body: init.body,
      });
      const res = await createWorkReportDelegation(req, "true", delegationApiDeps);
      assert.equal(res.status, 200, "Underlying API -> Repository -> SQL create must succeed (200)");
      if (dropResponseAfterCommit) {
        dropResponseAfterCommit = false;
        throw new Error("Simulated lost HTTP response after DB commit");
      }
      return res;
    };

    const lostUiAttempt = await submitDelegationCreateAttempt({
      state: draft,
      selectedScope: selectedTeamScope,
      fetchImpl: e2eFetch,
      nextIdempotencyKey: nextUiKey,
    });
    assert.equal(lostUiAttempt.ok, false);
    assert.equal(lostUiAttempt.next_state.ambiguous_retry_locked, true);
    assert.equal(lostUiAttempt.next_state.idempotency_key, committedAttemptKey);

    // Verify `createDelegationRepository` passed `p_scope_team_id` by name to SQL
    const createCall = pgliteNamedRpcCalls.find((c) => c.name === "work_report_create_delegation");
    assert.ok(createCall, "work_report_create_delegation must be invoked via named RPC");
    assert.ok(
      createCall.paramNames.includes("p_scope_team_id"),
      "Repository must pass p_scope_team_id and SQL RPC must accept p_scope_team_id",
    );

    // Attempting to edit the form while locked after lost response must be blocked
    const afterBlockedEdit = applyDelegationCreateDraftEdit(
      lostUiAttempt.next_state,
      { capability: "report_assign" },
      nextUiKey,
    );
    assert.equal(afterBlockedEdit.idempotency_key, committedAttemptKey);
    assert.equal(afterBlockedEdit.capability, "report_review");

    // Second attempt (user clicks retry): re-sends the exact same Idempotency-Key & payload and succeeds (200)
    const replayedUiAttempt = await submitDelegationCreateAttempt({
      state: afterBlockedEdit,
      selectedScope: selectedTeamScope,
      fetchImpl: e2eFetch,
      nextIdempotencyKey: nextUiKey,
    });
    assert.equal(replayedUiAttempt.ok, true);
    assert.equal(replayedUiAttempt.submitted_payload.idempotency_key, committedAttemptKey);
    assert.equal(replayedUiAttempt.next_state.ambiguous_retry_locked, false);
    assert.notEqual(replayedUiAttempt.next_state.idempotency_key, committedAttemptKey);

    // Verify only ONE active delegation row was created despite the lost response + retry
    const { rows: activeReviewDelegationsAfterRetry } = await db.query(
      `select delegation_id::text
         from public.work_report_delegations
        where delegate_app_user_id = $1::uuid
          and capability = 'report_review'
          and state = 'ACTIVE'
          and is_current = true`,
      [ACTORS.staff1.app],
    );
    assert.equal(
      activeReviewDelegationsAfterRetry.length,
      1,
      "Lost response + retry must create only 1 active delegation row",
    );
    const e2eCreatedDelegationId = activeReviewDelegationsAfterRetry[0].delegation_id;

    // Call `listWorkReportDelegations` via API -> Repository -> SQL when DB has both active and revoked rows
    const listApiRes = await listWorkReportDelegations(
      new Request("https://app.test/api/work-reports/delegations"),
      "true",
      delegationApiDeps,
    );
    assert.equal(
      listApiRes.status,
      200,
      "listWorkReportDelegations must return 200 OK when both active and revoked delegations exist",
    );
    const listApiBody = await listApiRes.json();
    assert.equal(listApiBody.ok, true);
    assert.equal(
      isDelegationViewData(listApiBody.data),
      true,
      "UI parser isDelegationViewData must accept SQL list payload",
    );
    const listedActive = listApiBody.data.items.find(
      (item) => item.delegation_id === e2eCreatedDelegationId,
    );
    const listedRevoked = listApiBody.data.items.filter((item) => item.state === "REVOKED");
    assert.ok(listedActive, "Active delegation must be present in list response");
    assert.equal(listedActive.state, "ACTIVE");
    assert.equal(listedActive.status, "ACTIVE");
    assert.equal(listedActive.is_current, true);
    assert.equal(listedActive.is_effective, true);
    assert.equal(listedActive.revoked_at, null);
    assert.ok(listedRevoked.length >= 2, "Revoked delegations must be present in list response");
    for (const revItem of listedRevoked) {
      assert.equal(revItem.state, "REVOKED");
      assert.equal(revItem.status, "REVOKED");
      assert.equal(revItem.is_current, false);
      assert.equal(revItem.is_effective, false);
      assert.equal(typeof revItem.revoked_at, "string");
    }

    // Revoke that single delegation via API -> Repository -> Named-Parameter SQL and verify delegate loses review authority
    const revokeApiKey = "9b000000-0000-4000-8000-000000000099";
    const revokeApiRes = await revokeWorkReportDelegation(
      new Request(
        `https://app.test/api/work-reports/delegations/${e2eCreatedDelegationId}/revoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://app.test",
            host: "app.test",
            "sec-fetch-site": "same-origin",
            "idempotency-key": revokeApiKey,
          },
          body: JSON.stringify({
            expected_version: listedActive.version,
            idempotency_key: revokeApiKey,
          }),
        },
      ),
      e2eCreatedDelegationId,
      "true",
      delegationApiDeps,
    );
    assert.equal(revokeApiRes.status, 200);
    const {
      rows: [{ has_review: hasReviewAfterSingleRevoke }],
    } = await db.query(
      `select public.work_report__internal_has_any_capability_authority($1::uuid, 'report_review') as has_review`,
      [ACTORS.staff1.app],
    );
    assert.equal(
      hasReviewAfterSingleRevoke,
      false,
      "Revoking the single delegation after retry must leave 0 active delegated review authority",
    );

    // -------------------------------------------------------------------------
    // 15. Dedicated Suite H: Leave Department Approver Optional Reason + Cross-Midnight Form & Retry E2E
    //     (`20261112180000_hf_wp1_leave_department_approver_optional_reason.sql` + `handlePatchLeaveAdminConfig`
    //      + `createLeaveRepository` + `resolveDepartmentApproverMutationPayload`)
    //     - `reason = null`, `""`, `"   "` succeed (200 OK) and store `reason = null`
    //     - Valid non-empty `reason` succeeds (200 OK) and stores trimmed `reason`
    //     - Invalid `reason` (> 500 chars or control character) fails with 422 `LEAVE_REASON_INVALID`
    //     - Form opened on day D (2026-11-17) and submitted on day D+1 (2026-11-18) with `valid_from: null`
    //       succeeds with `valid_from = 2026-11-18`
    //     - Ambiguous failure (lost response / 431 / 503) followed by retry on day D+2 (2026-11-19) preserves
    //       exact payload & `idempotency_key` and replays 200 OK (`replayed: true`)
    // -------------------------------------------------------------------------
    const leaveRepo = createLeaveRepository(pgliteNamedRpc);
    const leaveApiDeps = {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: ACTORS.fullAdmin.auth,
            app_user_id: ACTORS.fullAdmin.app,
            enabled: true,
          },
        },
      }),
      repository: leaveRepo,
    };

    const callPatchLeaveDeptApprover = (bodyPayload) =>
      handlePatchLeaveAdminConfig(
        new Request("https://app.test/api/leave/admin/config", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            origin: "https://app.test",
            host: "app.test",
            "sec-fetch-site": "same-origin",
            "idempotency-key": bodyPayload.idempotency_key,
          },
          body: JSON.stringify(bodyPayload),
        }),
        "true",
        leaveApiDeps,
      );

    // 15.1 Form opened on 2026-11-17 (`as_of_date = 2026-11-17`), submitted after midnight on 2026-11-18 with `reason = ""`
    await setBusinessDate(db, "2026-11-18");
    const nullReasonPayload = resolveDepartmentApproverMutationPayload({
      unitKind: "IT",
      approverAppUserId: ACTORS.mktApprover1.app,
      expectedRowVersion: 0,
      reason: "",
      pendingPayload: null,
      createIdempotencyKey: () => "hf-dept-approver-null-reason-1",
    });
    assert.equal(nullReasonPayload.valid_from, null);
    assert.equal(nullReasonPayload.reason, null);

    const nullReasonRes = await callPatchLeaveDeptApprover(nullReasonPayload);
    assert.equal(nullReasonRes.status, 200);
    const nullReasonJson = await nullReasonRes.json();
    assert.equal(nullReasonJson.ok, true);
    assert.equal(nullReasonJson.data.replayed, false);
    assert.equal(nullReasonJson.data.department_approver.unit_kind, "IT");
    assert.equal(nullReasonJson.data.department_approver.approver_app_user_id, ACTORS.mktApprover1.app);
    assert.equal(nullReasonJson.data.department_approver.valid_from, "2026-11-18");
    assert.equal(nullReasonJson.data.department_approver.reason, null);
    assert.equal(nullReasonJson.data.department_approver.row_version, 1);

    // 15.2 Whitespace-only reason (`"   "`) via API -> Repository -> SQL also normalizes to `null` and succeeds
    const blankReasonPayload = resolveDepartmentApproverMutationPayload({
      unitKind: "IT",
      approverAppUserId: ACTORS.mktApprover2.app,
      expectedRowVersion: 1,
      reason: "   ",
      pendingPayload: null,
      createIdempotencyKey: () => "hf-dept-approver-blank-reason-2",
    });
    const blankReasonRes = await callPatchLeaveDeptApprover(blankReasonPayload);
    assert.equal(blankReasonRes.status, 200);
    const blankReasonJson = await blankReasonRes.json();
    assert.equal(blankReasonJson.ok, true);
    assert.equal(blankReasonJson.data.department_approver.approver_app_user_id, ACTORS.mktApprover2.app);
    assert.equal(blankReasonJson.data.department_approver.reason, null);
    assert.equal(blankReasonJson.data.department_approver.row_version, 2);

    // Also verify direct SQL RPC call with whitespace-only `p_reason = '   '` stores `reason = null`
    const {
      rows: [{ result: sqlBlankReasonResult }],
    } = await db.query(
      `select public.leave_management_set_department_approver_admin(
         $1::uuid, $2::uuid, 'ACCOUNTING', $3::uuid, null, 0,
         '   ', 'hf-sql-blank-reason-1', 'fp-hf-sql-blank-reason-1'
       ) as result`,
      [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover1.app],
    );
    assert.equal(sqlBlankReasonResult.department_approver.reason, null);

    // 15.3 Valid non-empty reason + ambiguous failure followed by cross-midnight retry (`2026-11-18` -> `2026-11-19`)
    const validReasonPayload = resolveDepartmentApproverMutationPayload({
      unitKind: "IT",
      approverAppUserId: ACTORS.mktApprover1.app,
      expectedRowVersion: 2,
      reason: "  Bổ nhiệm lại người duyệt IT  ",
      pendingPayload: null,
      createIdempotencyKey: () => "hf-dept-approver-valid-reason-3",
    });
    assert.equal(validReasonPayload.reason, "Bổ nhiệm lại người duyệt IT");

    // First attempt commits on 2026-11-18, but client experiences an ambiguous failure (e.g. network drop / 431 / 503)
    const committedResBeforeDrop = await callPatchLeaveAdminConfigWithCapture(validReasonPayload);
    async function callPatchLeaveAdminConfigWithCapture(payload) {
      return callPatchLeaveDeptApprover(payload);
    }
    assert.equal(committedResBeforeDrop.status, 200);
    const committedJson = await committedResBeforeDrop.json();
    assert.equal(committedJson.data.replayed, false);
    assert.equal(committedJson.data.department_approver.reason, "Bổ nhiệm lại người duyệt IT");
    assert.equal(committedJson.data.department_approver.valid_from, "2026-11-18");
    assert.equal(committedJson.data.department_approver.row_version, 3);

    // Simulate ambiguous failure classification and cross-midnight retry on 2026-11-19
    assert.equal(
      isAmbiguousLeaveMutationFailure({ ok: false, status: 431, errorCode: "LEAVE_INTERNAL_ERROR" }),
      true,
    );
    await setBusinessDate(db, "2026-11-19");
    const retryPayloadAcrossMidnight = resolveDepartmentApproverMutationPayload({
      unitKind: "IT",
      approverAppUserId: ACTORS.mktApprover1.app,
      expectedRowVersion: validReasonPayload.expected_row_version,
      reason: "  Bổ nhiệm lại người duyệt IT  ",
      pendingPayload: validReasonPayload,
      createIdempotencyKey: () => "should-not-be-used",
    });
    assert.equal(retryPayloadAcrossMidnight, validReasonPayload);

    const replayedResAcrossMidnight = await callPatchLeaveDeptApprover(retryPayloadAcrossMidnight);
    assert.equal(replayedResAcrossMidnight.status, 200);
    const replayedJson = await replayedResAcrossMidnight.json();
    assert.equal(replayedJson.ok, true);
    assert.equal(replayedJson.data.replayed, true);
    assert.equal(replayedJson.data.department_approver.valid_from, "2026-11-18");
    assert.equal(replayedJson.data.department_approver.reason, "Bổ nhiệm lại người duyệt IT");
    assert.equal(replayedJson.data.department_approver.row_version, 3);

    // 15.4 Invalid non-empty reason (> 2000 chars or control character) is still rejected with `LEAVE_REASON_INVALID`
    const overlongReasonRes = await callPatchLeaveDeptApprover({
      operation: "SET_DEPARTMENT_APPROVER",
      unit_kind: "IT",
      approver_app_user_id: ACTORS.mktApprover2.app,
      valid_from: null,
      expected_row_version: 3,
      reason: "x".repeat(2001),
      idempotency_key: "hf-dept-approver-overlong-reason",
    });
    assert.equal(overlongReasonRes.status, 400);
    const overlongJson = await overlongReasonRes.json();
    assert.equal(overlongJson.code, "LEAVE_REASON_INVALID");

    await assert.rejects(
      () =>
        db.query(
          `select public.leave_management_set_department_approver_admin(
             $1::uuid, $2::uuid, 'IT', $3::uuid, null, 3,
             $4::text, 'hf-sql-overlong-reason', 'fp-hf-sql-overlong-reason'
           )`,
          [ACTORS.fullAdmin.auth, ACTORS.fullAdmin.app, ACTORS.mktApprover2.app, "x".repeat(2001)],
        ),
      (err) => err.code === "22023" && String(err.message).includes("LEAVE_REASON_INVALID"),
      "SQL RPC must still enforce LEAVE_REASON_INVALID on non-empty invalid reason",
    );
  } finally {
    await db.close();
  }
});
