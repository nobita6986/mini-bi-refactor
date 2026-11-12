import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autoAllocateDraftDaysByBalance,
  buildMonthlyLeaveReportExportUrl,
  buildMonthlyLeaveReportQuery,
  buildOpeningBatchApplyRows,
  canApplyOpeningBatch,
  canWithdrawOwnLeaveRequest,
  computeOpeningBatchDraftSignature,
  decideLeavePageAccess,
  evaluateLeaveRequestDraft,
  fetchAllLeaveAdminEmployeeOptions,
  formatHalfDayUnits,
  formatIsoDateVi,
  formatLeaveAdminAccountOptionLabel,
  formatSignedHalfDayUnits,
  halfDayUnitsToDays,
  isEligibleLeaveAdminDropdownEmployee,
  isEligibleLeaveOpeningBalanceEmployee,
  leaveDecisionActionLabel,
  leaveEmploymentStatusBadge,
  leaveErrorMessage,
  leaveFallbackReasonLabel,
  leaveLedgerEntryTypeLabel,
  leaveOpeningRowErrorLabel,
  leaveRequestStatusBadge,
  leaveRouteKindLabel,
  leaveSessionHalfDayUnits,
  leaveSessionLabel,
  leaveSessionShortLabel,
  leaveTypeBadge,
  leaveTypeLabel,
  leaveTypeShortLabel,
  leaveUnitKindLabel,
  mergeLeaveAdminKnownAccounts,
  parseDaysInputToHalfDayUnits,
  parseOpeningBalanceBulkText,
  resolveAdminSelectorEmployeeOptions,
  resolveAppliedOpeningRowCount,
  resolveDepartmentApproverMutationPayload,
  resolveKnownLeaveAccountLabel,
  resolveLeaveAdminDropdownEmployees,
  resolveLeaveOpeningBalanceEmployees,
  resolveOpeningRowSelectOptions,
  resolveVisibleLeaveTabs,
  isAmbiguousLeaveMutationFailure,
  validateApproverDecisionInput,
} from "./leave-ui-model.ts";

test("WP2 half-day unit conversions and formatters preserve 1 unit = 0.5 day", () => {
  assert.equal(halfDayUnitsToDays(0), 0);
  assert.equal(halfDayUnitsToDays(1), 0.5);
  assert.equal(halfDayUnitsToDays(2), 1);
  assert.equal(halfDayUnitsToDays(3), 1.5);

  assert.equal(formatHalfDayUnits(0), "0 ngày");
  assert.equal(formatHalfDayUnits(1), "0,5 ngày");
  assert.equal(formatHalfDayUnits(2), "1 ngày");
  assert.equal(formatHalfDayUnits(5), "2,5 ngày");

  assert.equal(formatSignedHalfDayUnits(3), "+1,5 ngày");
  assert.equal(formatSignedHalfDayUnits(-2), "-1 ngày");
  assert.equal(formatSignedHalfDayUnits(0), "0 ngày");

  assert.equal(parseDaysInputToHalfDayUnits("0"), 0);
  assert.equal(parseDaysInputToHalfDayUnits("0.5"), 1);
  assert.equal(parseDaysInputToHalfDayUnits("0,5"), 1);
  assert.equal(parseDaysInputToHalfDayUnits("1.5"), 3);
  assert.equal(parseDaysInputToHalfDayUnits("12"), 24);
  assert.equal(parseDaysInputToHalfDayUnits("0.3"), null);
  assert.equal(parseDaysInputToHalfDayUnits("-1"), null);
  assert.equal(parseDaysInputToHalfDayUnits("abc"), null);
});

test("WP2 session units and Vietnamese labels match WP1 leave contract", () => {
  assert.equal(leaveSessionHalfDayUnits("FULL"), 2);
  assert.equal(leaveSessionHalfDayUnits("AM"), 1);
  assert.equal(leaveSessionHalfDayUnits("PM"), 1);

  assert.equal(leaveSessionShortLabel("FULL"), "Cả ngày");
  assert.equal(leaveSessionShortLabel("AM"), "Buổi sáng");
  assert.equal(leaveSessionShortLabel("PM"), "Buổi chiều");
  assert.equal(leaveSessionLabel("FULL"), "Cả ngày (1 ngày)");

  assert.equal(leaveUnitKindLabel("RECRUITMENT"), "Tuyển dụng");
  assert.equal(leaveUnitKindLabel("MARKETING"), "Marketing");
  assert.equal(leaveUnitKindLabel("IT"), "IT");
  assert.equal(leaveUnitKindLabel("ACCOUNTING"), "Kế toán");

  assert.equal(leaveEmploymentStatusBadge("OFFICIAL").label, "Chính thức");
  assert.equal(leaveEmploymentStatusBadge("PROBATION").label, "Thử việc");
  assert.equal(leaveEmploymentStatusBadge("UNCONFIGURED").label, "Chưa cấu hình");

  assert.equal(leaveRequestStatusBadge("PENDING").label, "Chờ duyệt");
  assert.equal(leaveRequestStatusBadge("APPROVED").label, "Đã duyệt");
  assert.equal(leaveRequestStatusBadge("REJECTED").label, "Từ chối");
  assert.equal(leaveRequestStatusBadge("CANCELLED").label, "Đã hủy sau duyệt");
  assert.equal(leaveRequestStatusBadge("WITHDRAWN").label, "Đã tự rút");

  assert.equal(leaveTypeBadge("ANNUAL").label, "Phép năm");
  assert.equal(leaveTypeBadge("BEREAVEMENT").label, "Nghỉ tang");
  assert.equal(leaveTypeBadge("MARRIAGE").label, "Nghỉ cưới");
  assert.equal(leaveTypeBadge("SICK").label, "Nghỉ ốm");
  assert.equal(leaveTypeBadge("UNPAID").label, "Nghỉ không lương");
  assert.equal(leaveTypeShortLabel("MARRIAGE"), "Nghỉ cưới");
  assert.ok(leaveTypeLabel("BEREAVEMENT").includes("tối đa 3 ngày"));
  assert.ok(leaveTypeLabel("SICK").includes("tối đa 7 ngày"));
  assert.equal(leaveRouteKindLabel("TEAM_LEADER", "Team Alpha"), "Team Leader (Team Alpha)");
  assert.equal(
    leaveRouteKindLabel("DEPARTMENT_HEAD", null, "MARKETING"),
    "Trưởng bộ phận (Marketing)",
  );
  assert.ok(leaveFallbackReasonLabel("TEAM_WITHOUT_ACTIVE_LEADER")?.includes("Team Leader"));
  assert.equal(formatIsoDateVi("2026-03-31"), "31/03/2026");
});

test("WP2 decideLeavePageAccess and resolveVisibleLeaveTabs project strictly from server authority", () => {
  assert.equal(decideLeavePageAccess({ enabledFlag: "false", actor: null }), "NOT_FOUND");
  assert.equal(
    decideLeavePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideLeavePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "ACTOR_DISABLED" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );

  // Regular employee: only personal tab
  const staffTabs = resolveVisibleLeaveTabs({
    app_user_id: "u1",
    is_shared_non_employee: false,
    is_full_admin: false,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: false,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: false,
    can_view_monthly_report: false,
    can_manage_config: false,
  });
  assert.deepEqual(
    staffTabs.map((t) => t.id),
    ["personal"],
  );

  // Team Leader / Approver: personal + approvals with badge count
  const leaderTabs = resolveVisibleLeaveTabs(
    {
      app_user_id: "u2",
      is_shared_non_employee: false,
      is_full_admin: false,
      is_bod: false,
      is_hr_operator: false,
      is_hr_report_viewer: false,
      is_team_leader: true,
      is_department_approver: false,
      can_submit_request: true,
      can_approve_requests: true,
      can_view_monthly_report: false,
      can_manage_config: false,
    },
    4,
  );
  assert.deepEqual(
    leaderTabs.map((t) => ({ id: t.id, badge: t.badgeCount ?? null })),
    [
      { id: "personal", badge: null },
      { id: "approvals", badge: 4 },
    ],
  );

  // HR Report Viewer: personal + reports
  const hrViewerTabs = resolveVisibleLeaveTabs({
    app_user_id: "u3",
    is_shared_non_employee: false,
    is_full_admin: false,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: true,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: false,
    can_view_monthly_report: true,
    can_manage_config: false,
  });
  assert.deepEqual(
    hrViewerTabs.map((t) => t.id),
    ["personal", "reports"],
  );

  // Full Admin / BoD: all 4 tabs
  const adminTabs = resolveVisibleLeaveTabs({
    app_user_id: "u4",
    is_shared_non_employee: false,
    is_full_admin: true,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: false,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: true,
    can_view_monthly_report: true,
    can_manage_config: true,
  });
  assert.deepEqual(
    adminTabs.map((t) => t.id),
    ["personal", "approvals", "admin", "reports"],
  );
});

test("WP2 evaluateLeaveRequestDraft validates explicit leave types, per-type day limits, multi-type allocation, and balance", () => {
  const officialBalance = {
    has_profile: true,
    profile_configured: true,
    employment_status: "OFFICIAL",
    work_start_date: "2025-01-15",
    official_effective_date: "2025-03-15",
    available_units: 6, // 3 days available
  };

  // 1. Official employee with 1 FULL day + 1 AM half-day = 3 units (1.5 days) ANNUAL, sufficient balance
  const okOfficial = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "AM", leave_type: "ANNUAL" },
    ],
    reason: "",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(okOfficial.valid, true);
  assert.equal(okOfficial.reason_error, null);
  assert.equal(okOfficial.total_units, 3);
  assert.equal(okOfficial.total_days, 1.5);
  assert.equal(okOfficial.annual_units, 3);
  assert.equal(okOfficial.non_annual_units, 0);
  assert.equal(okOfficial.unpaid_notice, null);

  // 2. Requesting 4 days ANNUAL when only 3 days (6 units) remain -> blocked with split suggestion
  const insufficient = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-13", session_code: "FULL", leave_type: "ANNUAL" },
    ],
    reason: "Nghỉ phép 4 ngày",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(insufficient.valid, false);
  assert.equal(insufficient.exceeds_available_balance, true);
  assert.equal(insufficient.can_split_excess_annual_to_unpaid, true);

  // Auto-splitting 4 days with 3 days (6 units) available -> 3 days ANNUAL + 1 day UNPAID, now valid!
  const splitDays = autoAllocateDraftDaysByBalance(
    [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-13", session_code: "FULL", leave_type: "ANNUAL" },
    ],
    6,
    "UNPAID",
  );
  assert.deepEqual(
    splitDays.map((d) => d.leave_type),
    ["ANNUAL", "ANNUAL", "ANNUAL", "UNPAID"],
  );
  const validAfterSplit = evaluateLeaveRequestDraft({
    days: splitDays,
    reason: "Nghỉ phép 4 ngày chia 3 phép năm + 1 không lương",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(validAfterSplit.valid, true);
  assert.equal(validAfterSplit.annual_units, 6);
  assert.equal(validAfterSplit.non_annual_units, 2);

  // Auto-splitting when 0.5 day (1 unit) ANNUAL remains on a FULL day -> splits that date into AM ANNUAL + PM UNPAID
  const halfDaySplit = autoAllocateDraftDaysByBalance(
    [{ leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" }],
    1,
    "UNPAID",
  );
  assert.deepEqual(halfDaySplit, [
    { leave_date: "2026-05-10", session_code: "AM", leave_type: "ANNUAL" },
    { leave_date: "2026-05-10", session_code: "PM", leave_type: "UNPAID" },
  ]);

  // 3. Non-annual leave (UNPAID / SICK / MARRIAGE / BEREAVEMENT) with 0 available annual balance is valid
  const unpaidWithZeroBalance = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2026-05-12", session_code: "PM", leave_type: "UNPAID" }],
    reason: "Việc riêng",
    leaveYear: 2026,
    balance: {
      has_profile: true,
      profile_configured: true,
      employment_status: "PROBATION",
      work_start_date: "2026-05-01",
      official_effective_date: null,
      available_units: 0,
    },
  });
  assert.equal(unpaidWithZeroBalance.valid, true);
  assert.equal(unpaidWithZeroBalance.total_units, 1);
  assert.equal(unpaidWithZeroBalance.annual_units, 0);
  assert.equal(unpaidWithZeroBalance.non_annual_units, 1);

  // 4. Per-request type limits: BEREAVEMENT > 3 days (6 units) is rejected
  const overBereavement = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-13", session_code: "AM", leave_type: "BEREAVEMENT" },
    ],
    reason: "",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(overBereavement.valid, false);
  assert.deepEqual(
    overBereavement.exceeded_type_limits.map((item) => item.leave_type),
    ["BEREAVEMENT"],
  );

  // 5. Duplicate date with same leave_type in the same request is rejected, but AM + PM with different leave_type is allowed
  const duplicate = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-15", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-05-15", session_code: "PM", leave_type: "ANNUAL" },
    ],
    reason: "Trùng ngày",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.duplicate_dates.length, 1);

  const sameDateDiffTypes = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-15", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-05-15", session_code: "PM", leave_type: "SICK" },
    ],
    reason: "Sáng phép năm chiều nghỉ ốm",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(sameDateDiffTypes.valid, true);

  // 6. Cross-year date is rejected
  const wrongYear = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2027-01-02", session_code: "FULL", leave_type: "ANNUAL" }],
    reason: "Khác năm",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(wrongYear.valid, false);
  assert.equal(wrongYear.out_of_year_dates.length, 1);
});

test("WP2 canWithdrawOwnLeaveRequest and validateApproverDecisionInput enforce action rules", () => {
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-1" },
    }),
    true,
  );
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
    }),
    false,
  );
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-2" },
    }),
    false,
  );

  // Self approval forbidden
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "APPROVE",
      reason: "",
    }).ok,
    false,
  );

  // Approve pending request without reason is ok
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "APPROVE",
      reason: "",
    }).ok,
    true,
  );

  // Reject without a reason is allowed
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "REJECT",
      reason: "   ",
    }).ok,
    true,
  );
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "REJECT",
      reason: "Thiếu nhân sự trực ca",
    }).ok,
    true,
  );

  // Cancel approved requires APPROVED status but not a reason
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
      decision: "CANCEL_APPROVED",
      reason: "",
    }).ok,
    true,
  );
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
      decision: "CANCEL_APPROVED",
      reason: "Nhân sự đi làm lại theo điều động",
    }).ok,
    true,
  );
  assert.equal(leaveDecisionActionLabel("CANCEL_APPROVED"), "Hủy đơn đã duyệt (hoàn phép)");
});

test("WP2 Opening Balance bulk parser and mandatory preview-before-apply guard", () => {
  const employees = [
    {
      account: {
        app_user_id: "11111111-1111-4111-8111-111111111105",
        display_name: "Nguyen Van A",
        login_id: "nguyenvana",
        personnel_code: "NV005",
        recruiter_id: null,
        account_enabled: true,
      },
      profile: {
        employment_status: "OFFICIAL",
      },
      routing: {},
      balance: {},
    },
    {
      account: {
        app_user_id: "11111111-1111-4111-8111-111111111106",
        display_name: "Tran Van B",
        login_id: "tranvanb",
        personnel_code: "NV006",
        recruiter_id: null,
        account_enabled: true,
      },
      profile: {
        employment_status: "OFFICIAL",
      },
      routing: {},
      balance: {},
    },
  ];
  const bulk = parseOpeningBalanceBulkText(
    [
      "NV005\t2\t1.5\t0.5\tChốt đầu năm",
      "11111111-1111-4111-8111-111111111106,0,3,1,Nhân sự IT",
    ].join("\n"),
    employees,
  );
  assert.equal(bulk.parseErrors.length, 0);
  assert.equal(bulk.rows.length, 2);
  assert.deepEqual(bulk.rows[0], {
    app_user_id: "11111111-1111-4111-8111-111111111105",
    carry_over_units: 4,
    opening_current_year_units: 3,
    seniority_units: 1,
    note: "Chốt đầu năm",
  });
  assert.deepEqual(bulk.rows[1], {
    app_user_id: "11111111-1111-4111-8111-111111111106",
    carry_over_units: 0,
    opening_current_year_units: 6,
    seniority_units: 2,
    note: "Nhân sự IT",
  });

  const sig1 = computeOpeningBatchDraftSignature(2026, bulk.rows);
  const sig2 = computeOpeningBatchDraftSignature(2026, [
    ...bulk.rows.slice(0, 1),
    { ...bulk.rows[1], seniority_units: 4 },
  ]);
  assert.notEqual(sig1, sig2);

  const validPreview = {
    leave_year: 2026,
    carry_over_expires_after_date: "2026-03-31",
    valid: true,
    has_carry_over_expiry_error: false,
    row_count: 2,
    error_row_count: 0,
    total_carry_over_units: 4,
    total_opening_current_year_units: 9,
    total_seniority_units: 3,
    rows: [],
  };

  // Allowed when preview succeeded and signatures match; admin reason is optional
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
    }).ok,
    true,
  );

  // Blocked when draft was modified after preview (signature mismatch)
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: [
        ...bulk.rows.slice(0, 1),
        { ...bulk.rows[1], seniority_units: 4 },
      ],
      preview: validPreview,
      previewSignature: sig1,
    }).ok,
    false,
  );

  // Optional reason does not block applying a valid preview
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
    }).ok,
    true,
  );

  // Blocked when preview has error rows
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: { ...validPreview, valid: false, error_row_count: 1 },
      previewSignature: sig1,
    }).ok,
    false,
  );
});

test("WP2 Monthly report query and export URL builders include server-side filters", () => {
  const qs = buildMonthlyLeaveReportQuery({
    month: "2026-10",
    unit_kind: "MARKETING",
    search: "  Nguyen Van A ",
    limit: 50,
    offset: 100,
  });
  assert.equal(
    qs,
    "?month=2026-10&unit_kind=MARKETING&search=Nguyen+Van+A&limit=50&offset=100",
  );

  const exportUrl = buildMonthlyLeaveReportExportUrl({
    month: "2026-10",
    unit_kind: "ALL",
    search: "NV001",
  });
  assert.equal(
    exportUrl,
    "/api/leave/reports/monthly/export?month=2026-10&search=NV001",
  );

  assert.ok(leaveOpeningRowErrorLabel("LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED").includes("hạn"));
  assert.ok(leaveOpeningRowErrorLabel("EMPLOYEE_NOT_OFFICIAL").includes("Chính thức"));
  assert.ok(leaveErrorMessage("LEAVE_SHARED_ACCOUNT_FORBIDDEN").includes("dùng chung"));
});

test("Admin dropdown employee options with >25 accounts stay independent of profile table pagination/search/filter, restrict opening balance to OFFICIAL employees only, and preserve selected opening row labels", async () => {
  // Build 76 accounts matching RED distribution:
  // - 66 active non-shared accounts (indices 1..66):
  //   - 44 OFFICIAL employees (idx % 3 !== 0)
  //   - 11 PROBATION employees (idx % 6 === 3)
  //   - 11 UNCONFIGURED employees (idx % 6 === 0)
  // - 2 active shared non-employee accounts (indices 67..68)
  // - 8 inactive non-shared accounts (indices 69..76)
  const makeUuid = (n) =>
    `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

  const all76Employees = Array.from({ length: 76 }, (_, i) => {
    const idx = i + 1;
    const isShared = idx === 67 || idx === 68;
    const isActive = idx <= 68;
    const code = `NV${String(idx).padStart(3, "0")}`;
    const employmentStatus =
      idx % 6 === 0
        ? "UNCONFIGURED"
        : idx % 3 === 0
          ? "PROBATION"
          : "OFFICIAL";
    return {
      account: {
        app_user_id: makeUuid(idx),
        display_name: isShared ? `Tài Khoản Dùng Chung ${idx}` : `Nhân Sự ${code}`,
        login_id: isShared ? `shared${idx}` : `nhansu${String(idx).padStart(3, "0")}`,
        personnel_code: isShared ? null : code,
        recruiter_id: null,
        account_enabled: isActive,
      },
      profile: {
        app_user_id: makeUuid(idx),
        is_shared_non_employee: isShared,
        employment_status: employmentStatus,
        unit_kind: "RECRUITMENT",
        work_start_date: "2025-01-01",
        official_effective_date: employmentStatus === "OFFICIAL" ? "2025-03-01" : null,
        next_seniority_effective_date: null,
        next_seniority_units: 0,
        notes: null,
        row_version: 1,
      },
      routing: {},
      balance: {},
    };
  });

  const active68Employees = all76Employees.filter((e) => e.account.account_enabled);
  const inactive8Employees = all76Employees.filter((e) => !e.account.account_enabled);
  assert.equal(active68Employees.length, 68);
  assert.equal(inactive8Employees.length, 8);

  // 1. Multi-page catalog loader fetches all 68 active accounts across 25-row pages
  // and filters out the 2 shared accounts to produce all 66 eligible accounts.
  const fetchedQueries = [];
  const catalogResult = await fetchAllLeaveAdminEmployeeOptions(async (query) => {
    fetchedQueries.push(query);
    const slice = active68Employees.slice(query.offset, query.offset + query.limit);
    return {
      ok: true,
      data: {
        total_employees: active68Employees.length,
        employees: slice,
      },
    };
  }, 25);

  assert.equal(catalogResult.ok, true);
  assert.deepEqual(fetchedQueries, [
    { limit: 25, offset: 0, account_status: "ACTIVE" },
    { limit: 25, offset: 25, account_status: "ACTIVE" },
    { limit: 25, offset: 50, account_status: "ACTIVE" },
  ]);
  assert.equal(catalogResult.allEmployees.length, 68);
  assert.equal(catalogResult.employees.length, 66);

  // Verify ineligible accounts (shared or inactive) are excluded from general admin dropdowns,
  // and PROBATION/UNCONFIGURED accounts are additionally excluded from Opening Balance initialization.
  for (const emp of all76Employees) {
    if (emp.profile.is_shared_non_employee || !emp.account.account_enabled) {
      assert.equal(isEligibleLeaveAdminDropdownEmployee(emp), false);
      assert.equal(isEligibleLeaveOpeningBalanceEmployee(emp), false);
      assert.equal(
        catalogResult.employees.some(
          (item) => item.account.app_user_id === emp.account.app_user_id,
        ),
        false,
      );
    } else {
      assert.equal(isEligibleLeaveAdminDropdownEmployee(emp), true);
      assert.equal(
        isEligibleLeaveOpeningBalanceEmployee(emp),
        emp.profile.employment_status === "OFFICIAL",
      );
      assert.equal(
        catalogResult.employees.some(
          (item) => item.account.app_user_id === emp.account.app_user_id,
        ),
        true,
      );
    }
  }

  const expected66Ids = catalogResult.employees.map((e) => e.account.app_user_id);
  assert.equal(resolveLeaveAdminDropdownEmployees(all76Employees).length, 66);
  const openingOfficial44 = resolveLeaveOpeningBalanceEmployees(catalogResult.employees);
  assert.equal(openingOfficial44.length, 44);
  assert.ok(
    openingOfficial44.every((e) => e.profile.employment_status === "OFFICIAL"),
    "Opening balance options must only include OFFICIAL employees",
  );
  const expected44OfficialIds = openingOfficial44.map((e) => e.account.app_user_id);

  // 2. Changing profile table page (page 1, page 2, page 3), search keyword, or account_status filter
  // must NOT change the dropdown option sets used by department approver / module grant (66) or opening balance (44 OFFICIAL).
  const page1Employees = active68Employees.slice(0, 25);
  const page2Employees = active68Employees.slice(25, 50);
  const page3Employees = active68Employees.slice(50, 68);
  const searchedSingleEmployee = [active68Employees[42]];
  const searchedEmpty = [];

  for (const tablePageSlice of [
    page1Employees,
    page2Employees,
    page3Employees,
    searchedSingleEmployee,
    searchedEmpty,
    inactive8Employees,
    all76Employees.slice(50, 76),
  ]) {
    const resolvedOptions = resolveAdminSelectorEmployeeOptions({
      optionCatalogEmployees: catalogResult.employees,
      fallbackPageEmployees: tablePageSlice,
      optionCatalogLoaded: true,
    });
    assert.equal(resolvedOptions.length, 66);
    assert.deepEqual(
      resolvedOptions.map((e) => e.account.app_user_id),
      expected66Ids,
    );

    const resolvedOpeningOfficials = resolveLeaveOpeningBalanceEmployees(resolvedOptions);
    assert.equal(resolvedOpeningOfficials.length, 44);
    assert.deepEqual(
      resolvedOpeningOfficials.map((e) => e.account.app_user_id),
      expected44OfficialIds,
    );
  }

  // Even before catalog finishes loading, fallback filters out shared & inactive accounts
  const fallbackFromMixedPage = resolveAdminSelectorEmployeeOptions({
    optionCatalogEmployees: [],
    fallbackPageEmployees: all76Employees.slice(60, 76), // 6 eligible (61..66) + 2 shared (67..68) + 8 inactive (69..76)
    optionCatalogLoaded: false,
  });
  assert.equal(fallbackFromMixedPage.length, 6);
  assert.deepEqual(
    fallbackFromMixedPage.map((e) => e.account.app_user_id),
    all76Employees.slice(60, 66).map((e) => e.account.app_user_id),
  );
  // Among 61..66, 61, 62, 64, 65 are OFFICIAL (4), while 63 is PROBATION and 66 is UNCONFIGURED
  const fallbackOpeningOfficials = resolveLeaveOpeningBalanceEmployees(fallbackFromMixedPage);
  assert.equal(fallbackOpeningOfficials.length, 4);

  // 3. Preserve display name / login code for already-selected OFFICIAL choices in opening balance rows
  // when list data reloads or when profile table queries change.
  const selectedPage3Employee = active68Employees[58]; // index 59 (NV059, OFFICIAL, on page 3)
  assert.equal(selectedPage3Employee.profile.employment_status, "OFFICIAL");
  const selectedUserId = selectedPage3Employee.account.app_user_id;
  const expectedLabel = formatLeaveAdminAccountOptionLabel(selectedPage3Employee.account);
  assert.equal(expectedLabel, "Nhân Sự NV059 (@nhansu059)");

  let knownAccountsById = mergeLeaveAdminKnownAccounts(
    new Map(),
    catalogResult.allEmployees.map((e) => e.account),
  );
  // Simulate profile table switching to INACTIVE filter or a narrow search page
  knownAccountsById = mergeLeaveAdminKnownAccounts(
    knownAccountsById,
    inactive8Employees.map((e) => e.account),
  );

  const selectedLabelSnapshot = resolveKnownLeaveAccountLabel(
    selectedUserId,
    knownAccountsById,
    openingOfficial44,
  );
  assert.equal(selectedLabelSnapshot, "Nhân Sự NV059 (@nhansu059)");

  // Normal state with full catalog loaded: only 44 OFFICIAL options are present, including NV059
  const rowOptionsNormal = resolveOpeningRowSelectOptions({
    eligibleEmployees: catalogResult.employees,
    selectedAppUserId: selectedUserId,
    knownAccountsById,
    fallbackLabel: selectedLabelSnapshot,
  });
  assert.equal(rowOptionsNormal.length, 44);
  assert.equal(
    rowOptionsNormal.find((opt) => opt.app_user_id === selectedUserId)?.label,
    "Nhân Sự NV059 (@nhansu059)",
  );
  // Confirm probation (NV003) and unconfigured (NV006) are NOT in the opening balance select options
  assert.equal(
    rowOptionsNormal.some((opt) => opt.app_user_id === makeUuid(3)),
    false,
  );
  assert.equal(
    rowOptionsNormal.some((opt) => opt.app_user_id === makeUuid(6)),
    false,
  );

  // Simulate sparse account metadata on reload: knownAccountsById and fallbackLabel preserve the display name/login
  // for an OFFICIAL employee without falling back to raw UUID
  const sparseOfficialCatalog = catalogResult.employees.map((emp) =>
    emp.account.app_user_id === selectedUserId
      ? {
          ...emp,
          account: {
            ...emp.account,
            display_name: "",
            login_id: null,
            personnel_code: null,
          },
        }
      : emp,
  );
  const rowOptionsWithKnownLookup = resolveOpeningRowSelectOptions({
    eligibleEmployees: sparseOfficialCatalog,
    selectedAppUserId: selectedUserId,
    knownAccountsById,
    fallbackLabel: selectedLabelSnapshot,
  });
  assert.equal(rowOptionsWithKnownLookup.length, 44);
  assert.equal(
    rowOptionsWithKnownLookup.find((opt) => opt.app_user_id === selectedUserId)?.label,
    "Nhân Sự NV059 (@nhansu059)",
  );

  const rowOptionsFromFallbackLabel = resolveOpeningRowSelectOptions({
    eligibleEmployees: sparseOfficialCatalog,
    selectedAppUserId: selectedUserId,
    knownAccountsById: new Map(),
    fallbackLabel: selectedLabelSnapshot,
  });
  assert.equal(
    rowOptionsFromFallbackLabel.find((opt) => opt.app_user_id === selectedUserId)?.label,
    "Nhân Sự NV059 (@nhansu059)",
  );

  // Non-official or removed employees must NEVER be re-added to the dropdown even if passed as selectedAppUserId
  for (const nonOfficialSelectedId of [
    makeUuid(3), // PROBATION
    makeUuid(6), // UNCONFIGURED
    makeUuid(67), // SHARED
    makeUuid(70), // INACTIVE
  ]) {
    const optionsWithNonOfficialSelected = resolveOpeningRowSelectOptions({
      eligibleEmployees: catalogResult.employees,
      selectedAppUserId: nonOfficialSelectedId,
      knownAccountsById,
      fallbackLabel: "Nhân Sự Không Hợp Lệ",
    });
    assert.equal(optionsWithNonOfficialSelected.length, 44);
    assert.equal(
      optionsWithNonOfficialSelected.some(
        (opt) => opt.app_user_id === nonOfficialSelectedId,
      ),
      false,
    );
  }

  // If NV059's profile changes from OFFICIAL to PROBATION, NV059 is removed from the dropdown options even if still selected
  const catalogAfterDemotionToProbation = catalogResult.employees.map((emp) =>
    emp.account.app_user_id === selectedUserId
      ? {
          ...emp,
          profile: {
            ...emp.profile,
            employment_status: "PROBATION",
          },
        }
      : emp,
  );
  const rowOptionsAfterDemotion = resolveOpeningRowSelectOptions({
    eligibleEmployees: catalogAfterDemotionToProbation,
    selectedAppUserId: selectedUserId,
    knownAccountsById,
    fallbackLabel: selectedLabelSnapshot,
  });
  assert.equal(rowOptionsAfterDemotion.length, 43);
  assert.equal(
    rowOptionsAfterDemotion.some((opt) => opt.app_user_id === selectedUserId),
    false,
  );

  // 4. Bulk text parser resolves OFFICIAL employees beyond page 1 (e.g. NV059 on page 3)
  // and rejects PROBATION (NV003), UNCONFIGURED (NV006), shared (shared67), inactive (NV070), and unknown UUIDs
  const bulkValidBeyondPage1 = parseOpeningBalanceBulkText(
    "NV059\t2\t1.5\t0.5\tNhân sự chính thức trang 3",
    catalogResult.employees,
  );
  assert.equal(bulkValidBeyondPage1.parseErrors.length, 0);
  assert.equal(bulkValidBeyondPage1.rows.length, 1);
  assert.equal(bulkValidBeyondPage1.rows[0].app_user_id, selectedUserId);

  const bulkProbationRejected = parseOpeningBalanceBulkText(
    "NV003\t1\t1\t0\tNhân sự thử việc",
    catalogResult.employees,
  );
  assert.equal(bulkProbationRejected.rows.length, 0);
  assert.equal(bulkProbationRejected.parseErrors.length, 1);

  const bulkProbationUuidRejected = parseOpeningBalanceBulkText(
    `${makeUuid(3)}\t1\t1\t0\tUUID nhân sự thử việc`,
    catalogResult.employees,
  );
  assert.equal(bulkProbationUuidRejected.rows.length, 0);
  assert.equal(bulkProbationUuidRejected.parseErrors.length, 1);

  const bulkUnconfiguredRejected = parseOpeningBalanceBulkText(
    "NV006\t1\t1\t0\tNhân sự chưa cấu hình",
    catalogResult.employees,
  );
  assert.equal(bulkUnconfiguredRejected.rows.length, 0);
  assert.equal(bulkUnconfiguredRejected.parseErrors.length, 1);

  const bulkSharedRejected = parseOpeningBalanceBulkText(
    "shared67\t1\t1\t0\tTài khoản dùng chung",
    all76Employees,
  );
  assert.equal(bulkSharedRejected.rows.length, 0);
  assert.equal(bulkSharedRejected.parseErrors.length, 1);

  const bulkInactiveRejected = parseOpeningBalanceBulkText(
    "NV070\t1\t1\t0\tTài khoản ngừng hoạt động",
    all76Employees,
  );
  assert.equal(bulkInactiveRejected.rows.length, 0);
  assert.equal(bulkInactiveRejected.parseErrors.length, 1);
});

test("Opening balance reconciliation helpers: resolveAppliedOpeningRowCount never returns undefined and buildOpeningBatchApplyRows attaches preview snapshot expectations", () => {
  // 1. Direct top-level applied_row_count from updated RPC contract
  assert.equal(
    resolveAppliedOpeningRowCount(
      {
        replayed: false,
        batch_id: "b-1",
        applied_row_count: 3,
        batch: { batch_id: "b-1", row_count: 3 },
        applied_rows: [{}, {}, {}],
      },
      1,
    ),
    3,
  );

  // 2. Legacy RPC shape without top-level applied_row_count -> falls back to batch.row_count
  assert.equal(
    resolveAppliedOpeningRowCount(
      {
        replayed: false,
        batch: { batch_id: "b-2", row_count: 2 },
        applied_rows: [{}, {}],
      },
      1,
    ),
    2,
  );

  // 3. Fallback to applied_rows.length when batch is omitted
  assert.equal(
    resolveAppliedOpeningRowCount(
      {
        applied_rows: [{ app_user_id: "u1" }, { app_user_id: "u2" }, { app_user_id: "u3" }, { app_user_id: "u4" }],
      },
      1,
    ),
    4,
  );

  // 4. Fallback to fallbackRowCount when payload is sparse
  assert.equal(resolveAppliedOpeningRowCount({}, 5), 5);
  assert.equal(resolveAppliedOpeningRowCount(null, 2), 2);
  assert.equal(resolveAppliedOpeningRowCount(undefined, 0), 0);

  // 5. buildOpeningBatchApplyRows attaches expected cutoff date and current-year balance state from preview
  const draftRows = [
    {
      app_user_id: "11111111-1111-4111-8111-111111111105",
      carry_over_units: 0,
      opening_current_year_units: 2,
      seniority_units: 0,
      note: "Đối soát còn 1 ngày",
    },
  ];
  const preview = {
    leave_year: 2026,
    as_of_date: "2026-11-05",
    carry_over_expires_after_date: "2026-03-31",
    valid: true,
    has_carry_over_expiry_error: false,
    row_count: 1,
    error_row_count: 0,
    total_carry_over_units: 0,
    total_opening_current_year_units: 2,
    total_seniority_units: 0,
    rows: [
      {
        row_index: 1,
        app_user_id: "11111111-1111-4111-8111-111111111105",
        account: null,
        as_of_date: "2026-11-05",
        carry_over_units: 0,
        opening_current_year_units: 2,
        current_year_accrued_units: 6,
        current_year_granted_units: 6,
        current_year_locked_units: 2,
        current_year_available_units: 4,
        delta_current_year_units: -4,
        profile_row_version: 3,
        seniority_units: 0,
        note: "Đối soát còn 1 ngày",
        valid: true,
        errors: [],
      },
    ],
  };

  const applyRows = buildOpeningBatchApplyRows(draftRows, preview);
  assert.deepEqual(applyRows, [
    {
      app_user_id: "11111111-1111-4111-8111-111111111105",
      carry_over_units: 0,
      opening_current_year_units: 2,
      seniority_units: 0,
      note: "Đối soát còn 1 ngày",
      expected_as_of_date: "2026-11-05",
      expected_current_year_granted_units: 6,
      expected_current_year_locked_units: 2,
      expected_profile_row_version: 3,
    },
  ]);

  assert.ok(
    leaveOpeningRowErrorLabel("OPENING_TARGET_BELOW_LOCKED_BALANCE").includes(
      "giữ chỗ",
    ),
  );
  assert.ok(
    leaveOpeningRowErrorLabel("SENIORITY_LOT_ALREADY_EXISTS").includes(
      "phép thâm niên",
    ),
  );
  assert.equal(
    leaveLedgerEntryTypeLabel("ADJUST_OPENING_CURRENT_YEAR_DECREASE", -4),
    "Điều chỉnh giảm số dư đầu kỳ năm hiện tại (đối soát)",
  );
  assert.equal(
    leaveLedgerEntryTypeLabel("ADJUST_OPENING_CURRENT_YEAR_INCREASE", 4),
    "Điều chỉnh tăng số dư đầu kỳ năm hiện tại (đối soát)",
  );
  assert.equal(
    leaveLedgerEntryTypeLabel("GRANT_OPENING_CURRENT_YEAR", -2),
    "Điều chỉnh giảm số dư đầu kỳ năm hiện tại (đối soát)",
  );
  assert.equal(
    leaveLedgerEntryTypeLabel("GRANT_OPENING_CURRENT_YEAR", 2),
    "Khởi tạo số dư đầu kỳ năm hiện tại",
  );
  assert.ok(
    leaveErrorMessage("LEAVE_OPENING_PREVIEW_STALE").includes("Xem trước"),
  );
});

test("resolveDepartmentApproverMutationPayload sends valid_from: null, normalizes optional reason, and preserves idempotency_key on ambiguous retry", () => {
  let seq = 0;
  const nextKey = () => `leave-dept-approver-test-${++seq}`;

  const firstAttempt = resolveDepartmentApproverMutationPayload({
    unitKind: "MARKETING",
    approverAppUserId: "  11111111-1111-4111-8111-111111111101  ",
    expectedRowVersion: 2,
    reason: "   ",
    pendingPayload: null,
    createIdempotencyKey: nextKey,
  });

  assert.deepEqual(firstAttempt, {
    operation: "SET_DEPARTMENT_APPROVER",
    unit_kind: "MARKETING",
    approver_app_user_id: "11111111-1111-4111-8111-111111111101",
    valid_from: null,
    expected_row_version: 2,
    reason: null,
    idempotency_key: "leave-dept-approver-test-1",
  });

  assert.equal(isAmbiguousLeaveMutationFailure("network_error"), true);
  assert.equal(
    isAmbiguousLeaveMutationFailure({ ok: false, status: 431, errorCode: "LEAVE_INTERNAL_ERROR" }),
    true,
  );
  assert.equal(
    isAmbiguousLeaveMutationFailure({ ok: false, status: 503, errorCode: "LEAVE_UNAVAILABLE" }),
    true,
  );
  assert.equal(
    isAmbiguousLeaveMutationFailure({ ok: false, status: 422, errorCode: "LEAVE_REASON_INVALID" }),
    false,
  );
  assert.equal(
    isAmbiguousLeaveMutationFailure({ ok: false, status: 409, errorCode: "LEAVE_ROW_VERSION_CONFLICT" }),
    false,
  );

  // Retrying after an ambiguous outcome (even if the form stayed open across midnight)
  // reuses the exact same payload and idempotency_key
  const retryAttempt = resolveDepartmentApproverMutationPayload({
    unitKind: "MARKETING",
    approverAppUserId: "11111111-1111-4111-8111-111111111101",
    expectedRowVersion: 2,
    reason: "",
    pendingPayload: firstAttempt,
    createIdempotencyKey: nextKey,
  });
  assert.equal(retryAttempt, firstAttempt);
  assert.equal(retryAttempt.idempotency_key, "leave-dept-approver-test-1");
  assert.equal(seq, 1);

  // Changing inputs after clearing/unlocking generates a fresh idempotency_key
  const changedAttempt = resolveDepartmentApproverMutationPayload({
    unitKind: "IT",
    approverAppUserId: "11111111-1111-4111-8111-111111111101",
    expectedRowVersion: 0,
    reason: "Bổ nhiệm người duyệt IT",
    pendingPayload: firstAttempt,
    createIdempotencyKey: nextKey,
  });
  assert.equal(changedAttempt.idempotency_key, "leave-dept-approver-test-2");
  assert.equal(changedAttempt.valid_from, null);
  assert.equal(changedAttempt.reason, "Bổ nhiệm người duyệt IT");
});

