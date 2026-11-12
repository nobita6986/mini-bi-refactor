import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAssignAccountingMemberFingerprint,
  computeEndAccountingMemberFingerprint,
  departmentHttpStatusForError,
  parseAssignAccountingMemberBody,
  parseDepartmentIdParam,
  parseEndAccountingMemberBody,
  parseListAccountingCandidatesQuery,
  parseListAccountingMembershipsQuery,
  parseListDepartmentsQuery,
  parseListRecruitmentTeamsQuery,
  projectAccountingCandidateListResponse,
  projectAccountingMembershipListResponse,
  projectAccountingMembershipMutationResponse,
  projectDepartmentDetailResponse,
  projectDepartmentListResponse,
  projectRecruitmentTeamsResponse,
} from "./department-contract.ts";
import { resolveOrgShellVfinDefaultAuthority } from "./department-vfin-authority.ts";

const DEPT_RECRUITMENT = "11111111-1111-4111-8111-111111111111";
const DEPT_ACCOUNTING = "22222222-2222-4222-8222-222222222222";
const USER_REF = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const IDEM_KEY = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date());

test("department query parsers enforce strict allowlisted query parameters and bounds", () => {
  assert.equal(
    parseListDepartmentsQuery(new URL("https://bi.local/api/admin/departments")).ok,
    true,
  );
  assert.deepEqual(
    parseListDepartmentsQuery(new URL("https://bi.local/api/admin/departments?extra=1")),
    { ok: false, code: "DEPARTMENT_QUERY_INVALID" },
  );

  assert.deepEqual(
    parseDepartmentIdParam(
      DEPT_ACCOUNTING.toUpperCase(),
      new URL(`https://bi.local/api/admin/departments/${DEPT_ACCOUNTING}`),
    ),
    { ok: true, value: DEPT_ACCOUNTING },
  );
  assert.deepEqual(
    parseDepartmentIdParam(
      "not-a-uuid",
      new URL("https://bi.local/api/admin/departments/not-a-uuid"),
    ),
    { ok: false, code: "DEPARTMENT_QUERY_INVALID" },
  );

  const membershipsQuery = parseListAccountingMembershipsQuery(
    new URL(
      "https://bi.local/api/admin/departments/accounting/memberships?search=%20Nguyen%20&include_history=true&page=2&page_size=50",
    ),
  );
  assert.deepEqual(membershipsQuery, {
    ok: true,
    value: {
      search: "Nguyen",
      include_history: true,
      page: 2,
      page_size: 50,
    },
  });

  // Duplicate, unknown, blank search, or out-of-range pagination fail closed
  assert.deepEqual(
    parseListAccountingMembershipsQuery(
      new URL("https://bi.local/api/admin/departments/accounting/memberships?page=1&page=2"),
    ),
    { ok: false, code: "DEPARTMENT_QUERY_INVALID" },
  );
  assert.deepEqual(
    parseListAccountingMembershipsQuery(
      new URL("https://bi.local/api/admin/departments/accounting/memberships?role=admin"),
    ),
    { ok: false, code: "DEPARTMENT_QUERY_INVALID" },
  );
  assert.deepEqual(
    parseListAccountingMembershipsQuery(
      new URL("https://bi.local/api/admin/departments/accounting/memberships?search=%20%20"),
    ),
    { ok: false, code: "DEPARTMENT_SEARCH_INVALID" },
  );
  assert.deepEqual(
    parseListAccountingCandidatesQuery(
      new URL("https://bi.local/api/admin/departments/accounting/candidates?page_size=101"),
    ),
    { ok: false, code: "DEPARTMENT_QUERY_INVALID" },
  );
  assert.deepEqual(
    parseListRecruitmentTeamsQuery(
      new URL(
        "https://bi.local/api/admin/departments/recruitment/teams?include_inactive=false&search=HCM",
      ),
    ),
    {
      ok: true,
      value: {
        search: "HCM",
        include_inactive: false,
        page: 1,
        page_size: 25,
      },
    },
  );
});

test("assign and end body parsers fail closed on missing, extra, wrong-type, or forbidden authority fields", () => {
  const validAssign = parseAssignAccountingMemberBody(
    {
      account_ref: USER_REF.toUpperCase(),
      expected_pair_version: 0,
      effective_from: TODAY_VN,
      reason: "  Bổ nhiệm nhân sự Phòng Kế toán  ",
      idempotency_key: IDEM_KEY,
    },
    IDEM_KEY.toUpperCase(),
  );
  assert.deepEqual(validAssign, {
    ok: true,
    value: {
      account_ref: USER_REF,
      expected_pair_version: 0,
      effective_from: TODAY_VN,
      reason: "Bổ nhiệm nhân sự Phòng Kế toán",
      idempotency_key: IDEM_KEY,
    },
  });

  // Forbidden client authority keys must never pass
  for (const forbiddenField of [
    "app_user_id",
    "auth_subject",
    "actor",
    "capability",
    "capabilities",
    "scope",
    "scopes",
    "role",
    "roles",
    "team_id",
  ]) {
    const res = parseAssignAccountingMemberBody(
      {
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Thử gửi field cấm",
        idempotency_key: IDEM_KEY,
        [forbiddenField]: "injected",
      },
      IDEM_KEY,
    );
    assert.deepEqual(
      res,
      { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" },
      `forbidden field ${forbiddenField} must fail closed`,
    );
  }

  // Extra unknown key rejected
  assert.deepEqual(
    parseAssignAccountingMemberBody(
      {
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Có key lạ",
        idempotency_key: IDEM_KEY,
        department_key: "RECRUITMENT",
      },
      IDEM_KEY,
    ),
    { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" },
  );

  // Header/body Idempotency-Key mismatch rejected
  assert.deepEqual(
    parseAssignAccountingMemberBody(
      {
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Lệch idempotency",
        idempotency_key: IDEM_KEY,
      },
      DEPT_ACCOUNTING,
    ),
    { ok: false, code: "IDEMPOTENCY_KEY_INVALID" },
  );

  // Invalid calendar date rejected
  assert.deepEqual(
    parseAssignAccountingMemberBody(
      {
        account_ref: USER_REF,
        expected_pair_version: 0,
        effective_from: "2026-02-30",
        reason: "Ngày không tồn tại",
        idempotency_key: IDEM_KEY,
      },
      IDEM_KEY,
    ),
    { ok: false, code: "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID" },
  );

  // Blank reason rejected
  assert.deepEqual(
    parseEndAccountingMemberBody(
      MEMBERSHIP_ID,
      {
        expected_pair_version: 1,
        reason: "   ",
        idempotency_key: IDEM_KEY,
      },
      IDEM_KEY,
    ),
    { ok: false, code: "DEPARTMENT_MEMBERSHIP_REASON_INVALID" },
  );

  // Version 0 on end rejected (must be >= 1)
  assert.deepEqual(
    parseEndAccountingMemberBody(
      MEMBERSHIP_ID,
      {
        expected_pair_version: 0,
        reason: "Kết thúc membership",
        idempotency_key: IDEM_KEY,
      },
      IDEM_KEY,
    ),
    { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" },
  );
});

test("request fingerprints are deterministic and separate assign from end", () => {
  const fpAssign1 = computeAssignAccountingMemberFingerprint({
    actor_app_user_id: ACTOR_ID.toUpperCase(),
    account_ref: USER_REF.toUpperCase(),
    expected_pair_version: 0,
    effective_from: "2026-10-24",
    reason: "Gán Kế toán",
  });
  const fpAssign2 = computeAssignAccountingMemberFingerprint({
    actor_app_user_id: ACTOR_ID,
    account_ref: USER_REF,
    expected_pair_version: 0,
    effective_from: "2026-10-24",
    reason: "Gán Kế toán",
  });
  const fpAssignChanged = computeAssignAccountingMemberFingerprint({
    actor_app_user_id: ACTOR_ID,
    account_ref: USER_REF,
    expected_pair_version: 0,
    effective_from: "2026-10-25",
    reason: "Gán Kế toán",
  });
  const fpEnd = computeEndAccountingMemberFingerprint({
    actor_app_user_id: ACTOR_ID,
    membership_id: MEMBERSHIP_ID,
    expected_pair_version: 1,
    effective_to: "2026-10-24",
    reason: "Gán Kế toán",
  });

  assert.equal(fpAssign1, fpAssign2);
  assert.match(fpAssign1, /^[0-9a-f]{64}$/);
  assert.notEqual(fpAssign1, fpAssignChanged);
  assert.notEqual(fpAssign1, fpEnd);
  assert.equal(departmentHttpStatusForError("IDEMPOTENCY_CONFLICT"), 409);
});

test("response projectors accept canonical shapes and fail closed on PII or schema drift", () => {
  const listPayload = {
    authorization_date: "2026-10-24",
    departments: [
      {
        department_id: DEPT_RECRUITMENT,
        system_key: "RECRUITMENT",
        code: "RECRUITMENT",
        name: "Phòng Tuyển dụng",
        is_active: true,
        membership_mode: "READ_ONLY_TEAMS_PROJECTION",
        default_policy_code: "EXISTING_TEAM_AUTHORITY_READ_ONLY",
        active_member_count: null,
        team_count: 3,
        active_team_count: 2,
        created_at: "2026-10-24T00:00:00.000Z",
        updated_at: "2026-10-24T00:00:00.000Z",
      },
      {
        department_id: DEPT_ACCOUNTING,
        system_key: "ACCOUNTING",
        code: "ACCOUNTING",
        name: "Phòng Kế toán",
        is_active: true,
        membership_mode: "MANAGED_MEMBERSHIP",
        default_policy_code: "VENDOR_FINANCE_VIEW_AND_RECORD",
        active_member_count: 1,
        team_count: null,
        active_team_count: null,
        created_at: "2026-10-24T00:00:00.000Z",
        updated_at: "2026-10-24T00:00:00.000Z",
      },
    ],
  };
  assert.ok(projectDepartmentListResponse(listPayload));
  assert.ok(
    projectDepartmentDetailResponse({
      authorization_date: "2026-10-24",
      department: listPayload.departments[1],
    }),
  );

  const membershipSample = {
    membership_id: MEMBERSHIP_ID,
    department_id: DEPT_ACCOUNTING,
    account_ref: USER_REF,
    display_name: "Nguyễn Thị Kế Toán",
    login_id: "ketoan01",
    personnel_code: "ketoan01",
    account_enabled: true,
    valid_from: "2026-10-24",
    valid_to: null,
    state: "CURRENT",
    effective: true,
    version: 1,
    pair_version: 1,
    granted_by_display_name: "Quản trị viên",
    revoked_by_display_name: null,
    revoked_at: null,
    created_at: "2026-10-24T01:02:03.456Z",
    updated_at: "2026-10-24T01:02:03.456Z",
  };

  assert.ok(
    projectAccountingMembershipMutationResponse({
      replayed: false,
      membership: membershipSample,
    }),
  );
  assert.ok(
    projectAccountingMembershipListResponse({
      authorization_date: "2026-10-24",
      department_id: DEPT_ACCOUNTING,
      include_history: false,
      search: null,
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      memberships: [membershipSample],
    }),
  );

  // Full email leaked in login_id must fail closed
  assert.equal(
    projectAccountingMembershipMutationResponse({
      replayed: false,
      membership: { ...membershipSample, login_id: "ketoan01@company.vn" },
    }),
    null,
  );

  // Extra auth_subject or grant_reason field in projection must fail closed
  assert.equal(
    projectAccountingCandidateListResponse({
      authorization_date: "2026-10-24",
      department_id: DEPT_ACCOUNTING,
      search: null,
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      candidates: [
        {
          account_ref: USER_REF,
          display_name: "Nguyễn Thị Kế Toán",
          login_id: "ketoan01",
          personnel_code: "ketoan01",
          account_enabled: true,
          has_active_membership: false,
          open_membership_id: null,
          pair_version: 0,
          auth_subject: ACTOR_ID,
        },
      ],
    }),
    null,
  );

  // Reserved __system_vendor__ team must never pass Recruitment team projector
  assert.equal(
    projectRecruitmentTeamsResponse({
      authorization_date: "2026-10-24",
      department_id: DEPT_RECRUITMENT,
      system_key: "RECRUITMENT",
      include_inactive: true,
      search: null,
      page: 1,
      page_size: 25,
      total: 1,
      has_more: false,
      teams: [
        {
          team_id: DEPT_RECRUITMENT,
          code: "__system_vendor__",
          display_name: "System Vendor",
          active: true,
          version: 1,
        },
      ],
    }),
    null,
  );
});

test("resolveOrgShellVfinDefaultAuthority honors only Full Admin or active immutable ACCOUNTING system_key", () => {
  assert.deepEqual(
    resolveOrgShellVfinDefaultAuthority({
      enabled: true,
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
      department_memberships: [],
    }),
    {
      allowed: true,
      authority_source: "full_admin",
      can_view: true,
      can_record: true,
    },
  );

  assert.deepEqual(
    resolveOrgShellVfinDefaultAuthority({
      enabled: true,
      capabilities: ["entry_own"],
      scopes: [{ kind: "own" }],
      department_memberships: [
        { system_key: "ACCOUNTING", is_department_active: true, effective: true },
      ],
    }),
    {
      allowed: true,
      authority_source: "accounting_department",
      can_view: true,
      can_record: true,
    },
  );

  // Disabled actor, ended membership, inactive department, RECRUITMENT, catalog_master_manage,
  // and retired payment_view / payment_edit must all fail closed.
  assert.equal(
    resolveOrgShellVfinDefaultAuthority({
      enabled: false,
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
      department_memberships: [
        { system_key: "ACCOUNTING", is_department_active: true, effective: true },
      ],
    }).allowed,
    false,
  );
  assert.equal(
    resolveOrgShellVfinDefaultAuthority({
      enabled: true,
      capabilities: ["catalog_master_manage", "payment_view", "payment_edit", "report_analytics_view"],
      scopes: [{ kind: "all" }],
      department_memberships: [
        { system_key: "RECRUITMENT", is_department_active: true, effective: true },
        { system_key: "ACCOUNTING", is_department_active: true, effective: false },
      ],
    }).allowed,
    false,
  );
});
