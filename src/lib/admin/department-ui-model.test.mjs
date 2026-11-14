import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPARTMENT_ERROR_CODES,
  departmentHttpStatusForError,
  parseAssignAccountingMemberBody,
  parseEndAccountingMemberBody,
  parseListAccountingCandidatesQuery,
  parseListAccountingMembershipsQuery,
  parseListRecruitmentTeamsQuery,
} from "../departments/department-contract.ts";
import {
  ACCOUNTING_DEFAULT_POLICY_DESCRIPTION,
  DEPARTMENT_UI_MAX_REASON_LENGTH,
  DEPARTMENT_UI_MAX_SEARCH_LENGTH,
  DEPARTMENT_UI_PAGE_SIZE,
  ORGANIZATIONAL_DEFAULT_POLICY_DESCRIPTION,
  RECRUITMENT_DEFAULT_POLICY_DESCRIPTION,
  RESERVED_VENDOR_TEAM_CODE,
  buildAccountingCandidatesQuery,
  buildAccountingMembershipsQuery,
  buildAssignAccountingMemberRequest,
  buildEndAccountingMemberRequest,
  buildRecruitmentTeamsQuery,
  canManageDepartmentMemberships,
  candidateAvailabilityBadge,
  classifyDepartmentMutationResponse,
  classifyDepartmentReadError,
  departmentDefaultPolicyDescription,
  departmentMembershipModeLabel,
  departmentScaleSummary,
  formatAccountSecondaryMeta,
  isCandidateAssignable,
  isReservedVendorTeam,
  membershipStateBadge,
  newDepartmentIdempotencyKey,
  normalizeDepartmentUuid,
  projectAccountingCandidatesEnvelope,
  projectAccountingMembershipMutationEnvelope,
  projectAccountingMembershipsEnvelope,
  projectDepartmentDetailEnvelope,
  projectDepartmentListEnvelope,
  projectRecruitmentTeamsEnvelope,
  sanitizeDepartmentSearchInput,
  visibleRecruitmentTeams,
} from "./department-ui-model.ts";

const RECRUITMENT_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNTING_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const TEAM_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666";

function makeRecruitmentDepartment(overrides = {}) {
  return {
    department_id: RECRUITMENT_ID,
    system_key: "RECRUITMENT",
    code: "RECRUITMENT",
    name: "Phòng Tuyển dụng",
    is_active: true,
    version: 1,
    membership_mode: "MANAGED_MEMBERSHIP_AND_TEAMS",
    default_policy_code: "EXISTING_TEAM_AUTHORITY_READ_ONLY",
    active_member_count: 0,
    team_count: 6,
    active_team_count: 5,
    active_head: null,
    created_at: "2026-10-20T08:00:00.000Z",
    updated_at: "2026-10-20T08:00:00.000Z",
    ...overrides,
  };
}

function makeAccountingDepartment(overrides = {}) {
  return {
    department_id: ACCOUNTING_ID,
    system_key: "ACCOUNTING",
    code: "ACCOUNTING",
    name: "Phòng Kế toán",
    is_active: true,
    version: 1,
    membership_mode: "MANAGED_MEMBERSHIP",
    default_policy_code: "VENDOR_FINANCE_VIEW_AND_RECORD",
    active_member_count: 2,
    team_count: null,
    active_team_count: null,
    active_head: null,
    created_at: "2026-10-20T08:00:00.000Z",
    updated_at: "2026-10-20T08:00:00.000Z",
    ...overrides,
  };
}

function makeMarketingDepartment(overrides = {}) {
  return {
    department_id: "33333333-4444-4444-8444-333333333333",
    system_key: "MARKETING",
    code: "MARKETING",
    name: "Phòng Marketing",
    is_active: true,
    version: 2,
    membership_mode: "MANAGED_MEMBERSHIP",
    default_policy_code: "ORGANIZATIONAL_MEMBERSHIP_ONLY",
    active_member_count: 3,
    team_count: null,
    active_team_count: null,
    active_head: {
      head_assignment_id: "99999999-1111-4111-8111-999999999999",
      person_id: "88888888-1111-4111-8111-888888888888",
      employee_code: "MKT-001",
      full_name: "Trần Trưởng Phòng",
      started_at: "2026-10-20T08:00:00.000Z",
      version: 1,
    },
    created_at: "2026-10-20T08:00:00.000Z",
    updated_at: "2026-10-20T08:00:00.000Z",
    ...overrides,
  };
}

function makeMembership(overrides = {}) {
  return {
    membership_id: MEMBERSHIP_ID,
    department_id: ACCOUNTING_ID,
    account_ref: ACCOUNT_ID,
    display_name: "Nguyễn Thị Kế Toán",
    login_id: "nv001",
    personnel_code: "NS001",
    account_enabled: true,
    valid_from: "2026-10-20",
    valid_to: null,
    state: "CURRENT",
    effective: true,
    version: 1,
    pair_version: 1,
    granted_by_display_name: "Quản trị Hệ thống",
    revoked_by_display_name: null,
    revoked_at: null,
    created_at: "2026-10-20T08:30:00.000Z",
    updated_at: "2026-10-20T08:30:00.000Z",
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    account_ref: ACCOUNT_ID,
    display_name: "Trần Văn Ứng Viên",
    login_id: "nv002",
    personnel_code: "NS002",
    account_enabled: true,
    has_active_membership: false,
    open_membership_id: null,
    pair_version: 0,
    ...overrides,
  };
}

test("query builders enforce contract bounds and round-trip cleanly through T1A server parsers", () => {
  assert.equal(
    sanitizeDepartmentSearchInput(`  Kế\u0000toán\n${"x".repeat(200)}`),
    `  Kếtoán${"x".repeat(DEPARTMENT_UI_MAX_SEARCH_LENGTH - 8)}`,
  );

  // Recruitment teams query
  assert.equal(buildRecruitmentTeamsQuery({ search: "", includeInactive: true, page: 0 }), null);
  assert.equal(buildRecruitmentTeamsQuery({ search: "", includeInactive: true, page: 1001 }), null);
  assert.equal(
    buildRecruitmentTeamsQuery({ search: "abc\u0007", includeInactive: true, page: 1 }),
    null,
  );

  const recBlank = buildRecruitmentTeamsQuery({
    search: "   ",
    includeInactive: false,
    page: 2,
  });
  assert.ok(recBlank);
  assert.equal(recBlank.has("search"), false);
  const parsedRecBlank = parseListRecruitmentTeamsQuery(
    new URL(`http://localhost/api/admin/departments/recruitment/teams?${recBlank.toString()}`),
  );
  assert.deepEqual(parsedRecBlank, {
    ok: true,
    value: {
      search: null,
      include_inactive: false,
      page: 2,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
    },
  });

  const recSearch = buildRecruitmentTeamsQuery({
    search: "  Nhóm Bắc Ninh  ",
    includeInactive: true,
    page: 1,
  });
  assert.ok(recSearch);
  const parsedRecSearch = parseListRecruitmentTeamsQuery(
    new URL(`http://localhost/api/admin/departments/recruitment/teams?${recSearch.toString()}`),
  );
  assert.deepEqual(parsedRecSearch, {
    ok: true,
    value: {
      search: "Nhóm Bắc Ninh",
      include_inactive: true,
      page: 1,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
    },
  });

  // Accounting memberships query
  const memQuery = buildAccountingMembershipsQuery({
    search: "  NS001 ",
    includeHistory: true,
    page: 3,
  });
  assert.ok(memQuery);
  const parsedMem = parseListAccountingMembershipsQuery(
    new URL(`http://localhost/api/admin/departments/accounting/memberships?${memQuery.toString()}`),
  );
  assert.deepEqual(parsedMem, {
    ok: true,
    value: {
      search: "NS001",
      include_history: true,
      page: 3,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
    },
  });

  // Accounting candidates query
  const candQuery = buildAccountingCandidatesQuery({ search: "   ", page: 1 });
  assert.ok(candQuery);
  assert.equal(candQuery.has("search"), false);
  const parsedCand = parseListAccountingCandidatesQuery(
    new URL(`http://localhost/api/admin/departments/accounting/candidates?${candQuery.toString()}`),
  );
  assert.deepEqual(parsedCand, {
    ok: true,
    value: {
      search: null,
      page: 1,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
    },
  });
});

test("department list & detail projectors validate system invariants and fail closed", () => {
  const recruitment = makeRecruitmentDepartment();
  const accounting = makeAccountingDepartment();
  const marketing = makeMarketingDepartment();
  const custom = makeMarketingDepartment({
    department_id: "77777777-2222-4222-8222-777777777777",
    system_key: null,
    code: "DESIGN",
    name: "Phòng Thiết kế",
    active_head: null,
  });

  const projectedList = projectDepartmentListEnvelope({
    ok: true,
    authorization_date: "2026-10-24",
    as_of: "2026-10-24T08:00:00.000Z",
    departments: [recruitment, accounting, marketing, custom],
  });
  assert.ok(projectedList);
  assert.equal(projectedList.departments.length, 4);
  assert.equal(projectedList.departments[0].name, "Phòng Tuyển dụng");
  assert.equal(projectedList.departments[1].name, "Phòng Kế toán");
  assert.equal(projectedList.departments[2].active_head?.employee_code, "MKT-001");
  assert.equal(projectedList.departments[3].system_key, null);

  // Extra fields, wrong mode/policy, or impossible calendar dates fail closed
  assert.equal(
    projectDepartmentListEnvelope({
      ok: true,
      authorization_date: "2026-02-30",
      as_of: "2026-10-24T08:00:00.000Z",
      departments: [recruitment],
    }),
    null,
  );
  assert.equal(
    projectDepartmentListEnvelope({
      ok: true,
      authorization_date: "2026-10-24",
      as_of: "2026-10-24T08:00:00.000Z",
      departments: [makeRecruitmentDepartment({ membership_mode: "MANAGED_MEMBERSHIP" })],
    }),
    null,
  );
  assert.equal(
    projectDepartmentListEnvelope({
      ok: true,
      authorization_date: "2026-10-24",
      as_of: "2026-10-24T08:00:00.000Z",
      departments: [makeAccountingDepartment({ team_count: 1 })],
    }),
    null,
  );

  // Detail envelope enforces expectedDepartmentId match
  const detailOk = projectDepartmentDetailEnvelope(
    {
      ok: true,
      authorization_date: "2026-10-24",
      as_of: "2026-10-24T08:00:00.000Z",
      department: accounting,
    },
    ACCOUNTING_ID.toUpperCase(),
  );
  assert.ok(detailOk);
  assert.equal(detailOk.department.department_id, ACCOUNTING_ID);

  assert.equal(
    projectDepartmentDetailEnvelope(
      {
        ok: true,
        authorization_date: "2026-10-24",
        as_of: "2026-10-24T08:00:00.000Z",
        department: accounting,
      },
      RECRUITMENT_ID,
    ),
    null,
  );
});

test("recruitment teams projector and filter strictly hide and reject __system_vendor__", () => {
  const validTeam = {
    team_id: TEAM_ID,
    code: "TEAM_HN_01",
    display_name: "Nhóm Tuyển dụng Hà Nội 1",
    active: true,
    version: 2,
  };
  const vendorSentinel = {
    team_id: "77777777-7777-4777-8777-777777777777",
    code: RESERVED_VENDOR_TEAM_CODE,
    display_name: "System Vendor Sentinel",
    active: true,
    version: 1,
  };

  assert.equal(isReservedVendorTeam(vendorSentinel), true);
  assert.equal(isReservedVendorTeam(validTeam), false);
  assert.deepEqual(visibleRecruitmentTeams([validTeam, vendorSentinel]), [validTeam]);

  const query = { search: "", includeInactive: true, page: 1 };
  const okEnvelope = projectRecruitmentTeamsEnvelope(
    {
      ok: true,
      authorization_date: "2026-10-24",
      department_id: RECRUITMENT_ID,
      system_key: "RECRUITMENT",
      include_inactive: true,
      search: null,
      page: 1,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
      total: 1,
      has_more: false,
      teams: [validTeam],
    },
    query,
    RECRUITMENT_ID,
  );
  assert.ok(okEnvelope);
  assert.equal(okEnvelope.teams.length, 1);

  // Any response leaking __system_vendor__ is rejected fail-closed at the projection boundary
  assert.equal(
    projectRecruitmentTeamsEnvelope(
      {
        ok: true,
        authorization_date: "2026-10-24",
        department_id: RECRUITMENT_ID,
        system_key: "RECRUITMENT",
        include_inactive: true,
        search: null,
        page: 1,
        page_size: DEPARTMENT_UI_PAGE_SIZE,
        total: 2,
        has_more: false,
        teams: [validTeam, vendorSentinel],
      },
      query,
      RECRUITMENT_ID,
    ),
    null,
  );

  // Stale/mismatched query echo is rejected
  assert.equal(
    projectRecruitmentTeamsEnvelope(
      {
        ok: true,
        authorization_date: "2026-10-24",
        department_id: RECRUITMENT_ID,
        system_key: "RECRUITMENT",
        include_inactive: false,
        search: null,
        page: 1,
        page_size: DEPARTMENT_UI_PAGE_SIZE,
        total: 1,
        has_more: false,
        teams: [validTeam],
      },
      query,
      RECRUITMENT_ID,
    ),
    null,
  );
});

test("accounting memberships & candidates projectors enforce history, email-redaction, and OCC invariants", () => {
  const currentRow = makeMembership();
  const scheduledRow = makeMembership({
    membership_id: "88888888-8888-4888-8888-888888888888",
    valid_from: "2026-11-01",
    state: "SCHEDULED",
    effective: false,
    version: 1,
    pair_version: 2,
  });
  const historyRow = makeMembership({
    membership_id: "99999999-9999-4999-8999-999999999999",
    valid_from: "2026-10-01",
    valid_to: "2026-10-15",
    state: "HISTORY",
    effective: false,
    version: 2,
    pair_version: 2,
    revoked_by_display_name: "Quản trị Hệ thống",
    revoked_at: "2026-10-15T09:00:00.000Z",
  });

  const projected = projectAccountingMembershipsEnvelope(
    {
      ok: true,
      authorization_date: "2026-10-24",
      department_id: ACCOUNTING_ID,
      include_history: true,
      search: null,
      page: 1,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
      total: 3,
      has_more: false,
      memberships: [currentRow, scheduledRow, historyRow],
    },
    { search: "", includeHistory: true, page: 1 },
    ACCOUNTING_ID,
  );
  assert.ok(projected);
  assert.equal(projected.memberships.length, 3);

  // Rejects synthetic email in login_id, HISTORY without valid_to, or pair_version < version
  assert.equal(
    projectAccountingMembershipsEnvelope(
      {
        ok: true,
        authorization_date: "2026-10-24",
        department_id: ACCOUNTING_ID,
        include_history: false,
        search: null,
        page: 1,
        page_size: DEPARTMENT_UI_PAGE_SIZE,
        total: 1,
        has_more: false,
        memberships: [makeMembership({ login_id: "nv001@internal.example" })],
      },
      { search: "", includeHistory: false, page: 1 },
      ACCOUNTING_ID,
    ),
    null,
  );
  assert.equal(
    projectAccountingMembershipMutationEnvelope({
      ok: true,
      replayed: false,
      membership: makeMembership({ state: "HISTORY", effective: false }),
    }),
    null,
  );

  // Candidates projection & assignability rules
  const assignable = makeCandidate();
  const activeMember = makeCandidate({
    account_ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    has_active_membership: true,
    open_membership_id: MEMBERSHIP_ID,
    pair_version: 1,
  });
  const scheduledMember = makeCandidate({
    account_ref: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    has_active_membership: false,
    open_membership_id: MEMBERSHIP_ID,
    pair_version: 3,
  });
  const disabledAccount = makeCandidate({
    account_ref: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    account_enabled: false,
  });

  const candList = projectAccountingCandidatesEnvelope(
    {
      ok: true,
      authorization_date: "2026-10-24",
      department_id: ACCOUNTING_ID,
      search: "nv",
      page: 1,
      page_size: DEPARTMENT_UI_PAGE_SIZE,
      total: 4,
      has_more: false,
      candidates: [assignable, activeMember, scheduledMember, disabledAccount],
    },
    { search: " nv ", page: 1 },
    ACCOUNTING_ID,
  );
  assert.ok(candList);
  assert.equal(isCandidateAssignable(assignable), true);
  assert.equal(isCandidateAssignable(activeMember), false);
  assert.equal(isCandidateAssignable(scheduledMember), false);
  assert.equal(isCandidateAssignable(disabledAccount), false);

  assert.equal(candidateAvailabilityBadge(assignable).label, "Có thể gán");
  assert.equal(candidateAvailabilityBadge(activeMember).label, "Đang là thành viên");
  assert.equal(candidateAvailabilityBadge(scheduledMember).label, "Đã có lịch tham gia");
  assert.equal(candidateAvailabilityBadge(disabledAccount).label, "Tài khoản ngừng hoạt động");
});

test("assign & end request builders emit exact contract payloads accepted by server parsers", () => {
  const generatedKey = newDepartmentIdempotencyKey();
  assert.ok(normalizeDepartmentUuid(generatedKey));

  // Assign: first-time candidate (expectedPairVersion = 0), default effective_from = null
  const assignBuilt = buildAssignAccountingMemberRequest({
    accountRef: ACCOUNT_ID,
    expectedPairVersion: 0,
    effectiveFrom: "   ",
    reason: "  Phân công phụ trách đối soát Vendor Q4  ",
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(assignBuilt.ok, true);
  if (assignBuilt.ok) {
    assert.deepEqual(Object.keys(assignBuilt.body).sort(), [
      "account_ref",
      "effective_from",
      "expected_pair_version",
      "idempotency_key",
      "reason",
    ]);
    const serverCheck = parseAssignAccountingMemberBody(
      assignBuilt.body,
      assignBuilt.idempotencyKey,
    );
    assert.deepEqual(serverCheck, {
      ok: true,
      value: {
        account_ref: ACCOUNT_ID,
        expected_pair_version: 0,
        effective_from: null,
        reason: "Phân công phụ trách đối soát Vendor Q4",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    });
  }

  // Assign validation failures
  assert.equal(
    buildAssignAccountingMemberRequest({
      accountRef: "not-a-uuid",
      expectedPairVersion: 0,
      reason: "hợp lệ",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildAssignAccountingMemberRequest({
      accountRef: ACCOUNT_ID,
      expectedPairVersion: -1,
      reason: "hợp lệ",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildAssignAccountingMemberRequest({
      accountRef: ACCOUNT_ID,
      expectedPairVersion: 1,
      effectiveFrom: "2026-02-29",
      reason: "hợp lệ",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildAssignAccountingMemberRequest({
      accountRef: ACCOUNT_ID,
      expectedPairVersion: 1,
      reason: "   ",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildAssignAccountingMemberRequest({
      accountRef: ACCOUNT_ID,
      expectedPairVersion: 1,
      reason: "x".repeat(DEPARTMENT_UI_MAX_REASON_LENGTH + 1),
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );

  // End: CURRENT membership with valid effective_to equal to businessToday
  const todayVn = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const endCurrent = buildEndAccountingMemberRequest({
    membershipId: MEMBERSHIP_ID,
    expectedPairVersion: 2,
    membershipState: "CURRENT",
    validFrom: "2026-10-10",
    authorizationDate: todayVn,
    effectiveTo: todayVn,
    reason: "Điều chuyển sang bộ phận khác",
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(endCurrent.ok, true);
  if (endCurrent.ok) {
    assert.deepEqual(Object.keys(endCurrent.body).sort(), [
      "effective_to",
      "expected_pair_version",
      "idempotency_key",
      "reason",
    ]);
    const serverEndCheck = parseEndAccountingMemberBody(
      endCurrent.membershipId,
      endCurrent.body,
      endCurrent.idempotencyKey,
    );
    assert.deepEqual(serverEndCheck, {
      ok: true,
      value: {
        membership_id: MEMBERSHIP_ID,
        expected_pair_version: 2,
        effective_to: todayVn,
        reason: "Điều chuyển sang bộ phận khác",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    });
  }

  // End: SCHEDULED membership must keep effective_to = null (immediate cancellation)
  const endScheduledOk = buildEndAccountingMemberRequest({
    membershipId: MEMBERSHIP_ID,
    expectedPairVersion: 1,
    membershipState: "SCHEDULED",
    validFrom: "2026-11-01",
    authorizationDate: "2026-10-24",
    effectiveTo: "",
    reason: "Hủy lịch phân công trước ngày bắt đầu",
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.equal(endScheduledOk.ok, true);
  if (endScheduledOk.ok) {
    assert.equal(endScheduledOk.body.effective_to, null);
  }

  assert.equal(
    buildEndAccountingMemberRequest({
      membershipId: MEMBERSHIP_ID,
      expectedPairVersion: 1,
      membershipState: "SCHEDULED",
      validFrom: "2026-11-01",
      authorizationDate: "2026-10-24",
      effectiveTo: "2026-11-01",
      reason: "Hủy",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildEndAccountingMemberRequest({
      membershipId: MEMBERSHIP_ID,
      expectedPairVersion: 1,
      membershipState: "CURRENT",
      validFrom: "2026-10-20",
      authorizationDate: "2026-10-24",
      effectiveTo: "2026-10-19",
      reason: "Sai ngày",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildEndAccountingMemberRequest({
      membershipId: MEMBERSHIP_ID,
      expectedPairVersion: 1,
      membershipState: "CURRENT",
      validFrom: "2026-10-20",
      authorizationDate: "2026-10-24",
      effectiveTo: "2026-10-25",
      reason: "Tương lai",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildEndAccountingMemberRequest({
      membershipId: MEMBERSHIP_ID,
      expectedPairVersion: 2,
      membershipState: "HISTORY",
      validFrom: "2026-10-01",
      reason: "Đã kết thúc",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );
});

test("read & mutation classifiers cover every DepartmentErrorCode and idempotency key lifecycle", () => {
  // Success 201 (new assign) & 200 (idempotent replay)
  const createdOutcome = classifyDepartmentMutationResponse(
    201,
    { ok: true, replayed: false, membership: makeMembership() },
    "assign",
  );
  assert.equal(createdOutcome.kind, "applied");
  if (createdOutcome.kind === "applied") {
    assert.equal(createdOutcome.replayed, false);
    assert.match(createdOutcome.message, /Đã gán Nguyễn Thị Kế Toán vào Phòng Kế toán/);
  }

  const replayedEnd = classifyDepartmentMutationResponse(
    200,
    {
      ok: true,
      replayed: true,
      membership: makeMembership({
        valid_to: "2026-10-24",
        state: "HISTORY",
        effective: false,
        version: 2,
        pair_version: 2,
        revoked_by_display_name: "Quản trị Hệ thống",
        revoked_at: "2026-10-24T09:00:00.000Z",
      }),
    },
    "end",
  );
  assert.equal(replayedEnd.kind, "applied");
  if (replayedEnd.kind === "applied") {
    assert.equal(replayedEnd.replayed, true);
    assert.match(replayedEnd.message, /đã được ghi nhận trước đó/);
  }

  // End does not accept HTTP 201; malformed 200 fails closed
  assert.equal(
    classifyDepartmentMutationResponse(
      201,
      { ok: true, replayed: false, membership: makeMembership() },
      "end",
    ).kind,
    "unavailable",
  );
  assert.equal(
    classifyDepartmentMutationResponse(200, { ok: true }, "assign").kind,
    "unavailable",
  );

  // Every backend error code maps to a deterministic sanitized Vietnamese outcome
  for (const code of DEPARTMENT_ERROR_CODES) {
    const status = departmentHttpStatusForError(code);
    const payload = { ok: false, code, message: "raw backend message should not leak" };

    const readErr = classifyDepartmentReadError(status, payload);
    assert.doesNotMatch(readErr.message, /raw backend message/);

    const mutErr = classifyDepartmentMutationResponse(status, payload, "assign");
    assert.notEqual(mutErr.kind, "applied");
    if (mutErr.kind !== "applied") {
      assert.doesNotMatch(mutErr.message, /raw backend message/);
      if (code === "DEPARTMENT_UNAVAILABLE" || code === "UNAUTHENTICATED") {
        assert.equal(
          mutErr.resetIdempotencyKey,
          false,
          `${code} must preserve Idempotency-Key for safe retry`,
        );
      } else {
        assert.equal(
          mutErr.resetIdempotencyKey,
          true,
          `${code} must rotate Idempotency-Key when user edits/reloads`,
        );
      }
    }
  }

  // Feature-off 404 ({ ok: false, code: "NOT_FOUND" }) vs unknown department 404
  assert.equal(
    classifyDepartmentReadError(404, { ok: false, code: "NOT_FOUND" }).kind,
    "unavailable",
  );
  assert.equal(
    classifyDepartmentReadError(404, { ok: false, code: "DEPARTMENT_NOT_FOUND" }).kind,
    "not-found",
  );
});

test("department policy and membership capability helpers lock Recruitment read-only and Accounting text", () => {
  const recruitment = makeRecruitmentDepartment();
  const accounting = makeAccountingDepartment();
  const inactiveAccounting = makeAccountingDepartment({ is_active: false });
  const marketing = makeMarketingDepartment();

  assert.equal(canManageDepartmentMemberships(recruitment), false);
  assert.equal(canManageDepartmentMemberships(accounting), true);
  assert.equal(canManageDepartmentMemberships(inactiveAccounting), false);
  assert.equal(canManageDepartmentMemberships(marketing), false);

  assert.equal(
    departmentDefaultPolicyDescription(accounting),
    "Xem và ghi nhận tài chính Vendor",
  );
  assert.equal(
    ACCOUNTING_DEFAULT_POLICY_DESCRIPTION,
    "Xem và ghi nhận tài chính Vendor",
  );
  assert.equal(
    departmentDefaultPolicyDescription(recruitment),
    RECRUITMENT_DEFAULT_POLICY_DESCRIPTION,
  );
  assert.equal(
    departmentDefaultPolicyDescription(marketing),
    ORGANIZATIONAL_DEFAULT_POLICY_DESCRIPTION,
  );

  assert.equal(departmentMembershipModeLabel(accounting), "Quản lý thành viên");
  assert.equal(departmentMembershipModeLabel(recruitment), "Chỉ đọc danh sách Nhóm");
  assert.equal(departmentMembershipModeLabel(marketing), "Quản lý theo cơ cấu tổ chức");
  assert.equal(departmentScaleSummary(recruitment), "5 / 6 nhóm hoạt động");
  assert.equal(departmentScaleSummary(accounting), "2 thành viên đang hiệu lực");
  assert.equal(departmentScaleSummary(marketing), "3 thành viên đang hiệu lực");

  assert.deepEqual(membershipStateBadge("CURRENT"), {
    label: "Đang hiệu lực",
    tone: "success",
  });
  assert.deepEqual(membershipStateBadge("SCHEDULED"), {
    label: "Sắp hiệu lực",
    tone: "warning",
  });
  assert.deepEqual(membershipStateBadge("HISTORY"), {
    label: "Lịch sử",
    tone: "neutral",
  });

  assert.equal(
    formatAccountSecondaryMeta({ login_id: "nv001", personnel_code: "NS001" }),
    "Tài khoản: nv001 · Mã NS: NS001",
  );
  assert.equal(
    formatAccountSecondaryMeta({ login_id: "NS001", personnel_code: "NS001" }),
    "Tài khoản: NS001",
  );
  assert.equal(
    formatAccountSecondaryMeta({ login_id: null, personnel_code: null }),
    null,
  );
});

test("WP4 department CRUD, HEAD, and Person membership builders enforce OCC, Idempotency-Key, and zero scheduling fields", async () => {
  const model = await import("./department-ui-model.ts");
  const KEY = "60000000-0000-4000-8000-000000000099";
  const DEPT_ID = "40000000-0000-4000-8000-000000000003";
  const PERSON_ID = "70000000-0000-4000-8000-000000000001";
  const HEAD_ID = "80000000-0000-4000-8000-000000000002";

  // Custom vs seeded department active toggle policy
  assert.equal(model.canToggleDepartmentActive({ system_key: null }), true);
  assert.equal(model.canToggleDepartmentActive({ system_key: "RECRUITMENT" }), false);
  assert.equal(model.canToggleDepartmentActive({ system_key: "ACCOUNTING" }), false);
  assert.equal(model.canToggleDepartmentActive({ system_key: "MANAGEMENT_BOD" }), false);

  // Create custom department validates uppercase code and excludes scheduling keys
  assert.equal(
    model.buildCreateDepartmentRequest({
      code: "bad code!",
      name: "Phòng Mới",
      reason: "Tạo mới",
      idempotencyKey: KEY,
    }).ok,
    false,
  );
  const createdReq = model.buildCreateDepartmentRequest({
    code: "OPS_CENTRAL",
    name: "Phòng Vận hành Miền Trung",
    reason: "Mở rộng chi nhánh",
    idempotencyKey: KEY,
  });
  assert.equal(createdReq.ok, true);
  if (createdReq.ok) {
    assert.deepEqual(createdReq.body, {
      code: "OPS_CENTRAL",
      name: "Phòng Vận hành Miền Trung",
      reason: "Mở rộng chi nhánh",
      idempotency_key: KEY,
    });
  }

  // Update department validates expected_department_version and no scheduling keys
  const updateReq = model.buildUpdateDepartmentRequest({
    expectedDepartmentVersion: 4,
    name: "Phòng Vận hành 2",
    isActive: false,
    reason: "Tạm ngừng",
    idempotencyKey: KEY,
  });
  assert.equal(updateReq.ok, true);
  if (updateReq.ok) {
    assert.equal(updateReq.body.expected_department_version, 4);
    assert.equal("started_at" in updateReq.body, false);
    assert.equal("ended_at" in updateReq.body, false);
  }

  // Assign & End Person membership
  const assignPerson = model.buildAssignDepartmentPersonMemberRequest({
    personId: PERSON_ID,
    expectedPersonVersion: 2,
    reason: "Bổ sung thành viên",
    idempotencyKey: KEY,
  });
  assert.equal(assignPerson.ok, true);
  if (assignPerson.ok) {
    assert.deepEqual(Object.keys(assignPerson.body).sort(), [
      "expected_person_version",
      "idempotency_key",
      "person_id",
      "reason",
    ]);
  }
  const endPerson = model.buildEndDepartmentPersonMemberRequest({
    expectedPersonVersion: 3,
    reason: "Kết thúc phân công",
    idempotencyKey: KEY,
  });
  assert.equal(endPerson.ok, true);

  // Designate & End HEAD
  const designateHead = model.buildDesignateDepartmentHeadRequest({
    personId: PERSON_ID,
    expectedDepartmentVersion: 5,
    expectedCurrentHeadAssignmentId: HEAD_ID,
    reason: "Thay trưởng phòng",
    idempotencyKey: KEY,
  });
  assert.equal(designateHead.ok, true);
  if (designateHead.ok) {
    assert.equal(designateHead.body.expected_department_version, 5);
    assert.equal(designateHead.body.expected_current_head_assignment_id, HEAD_ID);
  }
  const endHead = model.buildEndDepartmentHeadRequest({
    expectedDepartmentVersion: 6,
    expectedCurrentHeadAssignmentId: HEAD_ID,
    reason: "Miễn nhiệm trưởng phòng",
    idempotencyKey: KEY,
  });
  assert.equal(endHead.ok, true);

  // WP3 error classification: PERSON_IS_ACTIVE_DEPARTMENT_HEAD, VERSION_CONFLICT, uncertain retry, session loss
  const activeHeadErr = model.classifyWp3DepartmentMutationFailure(409, {
    ok: false,
    code: "PERSON_IS_ACTIVE_DEPARTMENT_HEAD",
  });
  assert.equal(activeHeadErr.kind, "active-head");
  assert.match(activeHeadErr.message, /Trưởng phòng/);
  assert.equal(activeHeadErr.preserveIdempotencyKey, false);

  const conflictErr = model.classifyWp3DepartmentMutationFailure(409, {
    ok: false,
    code: "VERSION_CONFLICT",
  });
  assert.equal(conflictErr.kind, "conflict");
  assert.equal(conflictErr.needsReload, true);
  assert.equal(conflictErr.preserveIdempotencyKey, false);

  const uncertainErr = model.classifyWp3DepartmentMutationFailure(503, null);
  assert.equal(uncertainErr.kind, "uncertain");
  assert.equal(uncertainErr.preserveIdempotencyKey, true);
  assert.equal(uncertainErr.needsReload, true);

  const sessionErr = model.classifyWp3DepartmentMutationFailure(401, {
    ok: false,
    code: "UNAUTHENTICATED",
  });
  assert.equal(sessionErr.kind, "session-lost");

  // Queries
  assert.equal(
    model.buildDepartmentHeadsQuery({
      departmentId: DEPT_ID,
      includeHistory: true,
      page: 1,
    })?.toString(),
    "include_history=true&page=1&page_size=25",
  );
  assert.equal(
    model.buildDepartmentPersonMembershipsQuery({
      departmentId: DEPT_ID,
      status: "active",
      search: "An",
      page: 2,
    })?.toString(),
    "status=active&page=2&page_size=25&search=An",
  );
});
