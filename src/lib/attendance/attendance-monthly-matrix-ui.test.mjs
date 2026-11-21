import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_ATTENDANCE_SLOT_POLICY,
  evaluateAttendanceDaySlots,
} from "./attendance-monthly-matrix-contract.ts";
import {
  ATTENDANCE_MISSING_EMPLOYEE_NAME_LABEL,
  describeAttendanceCheckinDistanceTarget,
  isAttendanceLoginOrCodeLike,
  resolveAttendanceEmployeeDisplayIdentity,
} from "./attendance-report-contract.ts";
import {
  ATTENDANCE_TIME_UNVERIFIED_HINT,
  ATTENDANCE_TIME_VERIFIED_HINT,
  DEFAULT_TABLE_HORIZONTAL_STEP_PX,
  DEFAULT_TABLE_VERTICAL_STEP_PX,
  FULL_ATTENDANCE_ADMIN_WORKSPACE_TABS,
  MATRIX_EXPLAINED_APPROVED_LABEL,
  MATRIX_EXPLANATION_PENDING_LABEL,
  MATRIX_EXPLANATION_REJECTED_LABEL,
  MATRIX_LEGEND_ITEMS,
  MATRIX_OUT_OF_SCOPE_LABEL,
  MIN_TABLE_HORIZONTAL_STEP_PX,
  MIN_TABLE_VERTICAL_STEP_PX,
  TABLE_HORIZONTAL_SCROLL_STEP_SCALE,
  TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO,
  TABLE_SCROLL_VERTICAL_VIEWPORT_STEP_RATIO,
  TEAM_LEADER_ATTENDANCE_WORKSPACE_TABS,
  buildAssignEmployeeToBranchPayload,
  buildAssignEmployeeToSlotPolicyPayload,
  buildCreateSlotPolicyPayload,
  buildDecideAttendanceExplanationPayload,
  buildGoogleMapsCoordinatesUrl,
  buildMonthlyMatrixExportUrl,
  buildMonthlyMatrixReportQuery,
  buildSubmitAttendanceExplanationPayload,
  buildUnassignEmployeeFromBranchPayload,
  buildUnassignEmployeeFromSlotPolicyPayload,
  buildUpsertBranchPayload,
  buildUpsertSlotPolicyProfilePayload,
  computeClampedTableScrollTarget,
  computeTableScrollAvailability,
  computeTableScrollStepPx,
  describeAttendanceTimeVerification,
  describeBranchAssignmentStatus,
  describeMatrixDayCell,
  describeMatrixDayVerification,
  describeSlotPolicyAssignmentStatus,
  formatEmployeeSlotPolicySummaryLabel,
  formatMatrixDistanceStatusLabel,
  formatMatrixWeekdayLabel,
  getAllowedAttendanceAdminWorkspaceTabs,
  getCurrentVnBusinessDate,
  getVietnamCurrentYearMonth,
  mapAttendanceExplanationMutationError,
  mapBranchAdminMutationError,
  mapMonthlyMatrixExportError,
  mapMonthlyMatrixReportError,
  mapSlotPolicyMutationError,
  resolveAttendanceAdminWorkspaceMode,
  resolveEffectiveAttendanceAdminWorkspaceTab,
  resolveFloatingTableNavPositionClass,
  resolveMutualExclusiveEmployeeOrSearch,
  validateMonthlyMatrixFilters,
} from "./attendance-monthly-matrix-ui-model.ts";
import {
  buildAttendanceMonthlyMatrixXlsx,
  formatMatrixDayCellText,
  formatMatrixExplanationSummary,
} from "./attendance-monthly-matrix-xlsx.ts";

const managerSource = readFileSync(
  new URL("../../components/admin/attendance-report-manager.tsx", import.meta.url),
  "utf8",
);
const matrixPanelSource = readFileSync(
  new URL("../../components/admin/attendance-monthly-matrix-panel.tsx", import.meta.url),
  "utf8",
);
const detailedMatrixPanelSource = readFileSync(
  new URL("../../components/dashboard/detailed-recruitment-matrix-panel.tsx", import.meta.url),
  "utf8",
);
const explanationWorkspaceSource = readFileSync(
  new URL("../../components/attendance/attendance-explanation-workspace.tsx", import.meta.url),
  "utf8",
);
const floatingTableNavSource = readFileSync(
  new URL("../../components/ui/floating-table-nav.tsx", import.meta.url),
  "utf8",
);

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const INTENT_KEY = "44444444-4444-4444-8444-444444444444";

test("monthly matrix query builder: enforces year_month, branch_id, default page_size=25 and mutual exclusion between employee_id and search", () => {
  const currentMonth = getVietnamCurrentYearMonth(new Date("2026-10-15T05:00:00Z"));
  assert.equal(currentMonth, "2026-10");

  // Search mode ignores employeeId even if passed
  const searchQuery = buildMonthlyMatrixReportQuery({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "search",
    employeeId: EMPLOYEE_ID,
    search: "  Nguyễn Văn A ",
  });
  const searchParams = new URLSearchParams(searchQuery);
  assert.equal(searchParams.get("year_month"), "2026-10");
  assert.equal(searchParams.get("branch_id"), BRANCH_ID);
  assert.equal(searchParams.get("search"), "Nguyễn Văn A");
  assert.equal(searchParams.get("employee_id"), null);
  assert.equal(searchParams.get("page"), "1");
  assert.equal(searchParams.get("page_size"), "25");

  // Employee mode ignores search even if passed
  const employeeQuery = buildMonthlyMatrixReportQuery({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "employee",
    employeeId: EMPLOYEE_ID,
    search: "Nguyễn Văn A",
    page: 3,
  });
  const empParams = new URLSearchParams(employeeQuery);
  assert.equal(empParams.get("year_month"), "2026-10");
  assert.equal(empParams.get("branch_id"), BRANCH_ID);
  assert.equal(empParams.get("employee_id"), EMPLOYEE_ID);
  assert.equal(empParams.get("search"), null);
  assert.equal(empParams.get("page"), "3");
  assert.equal(empParams.get("page_size"), "25");

  // Fallback mutual exclusion when filterMode is omitted
  const resolved = resolveMutualExclusiveEmployeeOrSearch({
    employeeId: EMPLOYEE_ID,
    search: "conflict",
  });
  assert.equal(resolved.employeeId, EMPLOYEE_ID);
  assert.equal(resolved.search, null);

  assert.equal(
    validateMonthlyMatrixFilters({
      yearMonth: "2026-10",
      filterMode: "search",
      employeeId: "",
      search: "NV001",
    }),
    null,
  );
  assert.notEqual(
    validateMonthlyMatrixFilters({
      yearMonth: "2026-13",
      filterMode: "search",
      employeeId: "",
      search: "",
    }),
    null,
  );
});

test("monthly matrix day cell presentation: renders CHECKED_IN, APPROVED_LEAVE, CHECKED_IN_AND_LEAVE, NO_CHECKIN with red highlight and never 'vắng không phép'", () => {
  const baseCell = {
    business_date: "2026-10-05",
    day_of_month: 5,
    has_checkin: false,
    checkin_count: 0,
    first_checkin_id: null,
    last_checkin_id: null,
    first_captured_at: null,
    first_captured_at_local: null,
    first_time_local: null,
    last_captured_at: null,
    last_captured_at_local: null,
    last_time_local: null,
    verified_checkin_count: 0,
    unverified_checkin_count: 0,
    distance_target_kind: null,
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
    hq_version_used: null,
    distance_status: null,
    distance_meters: null,
    min_distance_meters: null,
    max_distance_meters: null,
    has_approved_leave: false,
    approved_leave_units: 0,
    approved_leaves: [],
    day_status: "NO_CHECKIN",
  };

  // 1. NO_CHECKIN -> "Chưa có lượt chấm", red tone, never "vắng không phép", 5 default slots
  const noCheckin = describeMatrixDayCell(baseCell);
  assert.equal(noCheckin.statusLabel, "Chưa có lượt chấm");
  assert.equal(noCheckin.tone, "red");
  assert.equal(noCheckin.isRedHighlight, true);
  assert.equal(noCheckin.slots.length, 5);
  assert.deepEqual(
    noCheckin.slots.map((s) => `${s.slotShortLabel}:${s.targetTime}`),
    ["Time 1:07:30", "Time 2:10:00", "Time 3:13:00", "Time 4:15:00", "Time 5:16:30"],
  );
  for (const slot of noCheckin.slots) {
    assert.equal(slot.slotStatus, "MISSING");
    assert.equal(slot.statusLabel, "Chưa có lượt chấm");
    assert.equal(slot.tone, "red");
  }
  assert.equal(/vắng không phép/i.test(noCheckin.statusLabel), false);

  const upcoming = describeMatrixDayCell({
    ...baseCell,
    day_status: "UPCOMING",
    missing_slot_count: 0,
    slots: evaluateAttendanceDaySlots({
      policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
      checkins: [],
      approved_leaves: [],
    }).slots.map((slot) => ({ ...slot, slot_status: "UPCOMING" })),
  });
  assert.equal(upcoming.statusLabel, "Chưa đến giờ chấm");
  assert.equal(upcoming.tone, "sky");
  assert.equal(upcoming.isRedHighlight, false);
  assert.ok(upcoming.slots.every((slot) => slot.statusLabel === "Chưa đến giờ chấm"));
  assert.ok(upcoming.slots.every((slot) => !slot.isMissingHighlight));

  // 2. APPROVED_LEAVE -> red tone + explicit leave type and session (FULL, AM, PM)
  const approvedLeave = describeMatrixDayCell({
    ...baseCell,
    has_approved_leave: true,
    approved_leave_units: 1,
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-05",
        session_code: "AM",
        leave_type: "ANNUAL",
        half_day_units: 1,
      },
    ],
    day_status: "APPROVED_LEAVE",
  });
  assert.equal(approvedLeave.statusLabel, "Nghỉ phép đã duyệt");
  assert.equal(approvedLeave.tone, "red");
  assert.equal(approvedLeave.isRedHighlight, true);
  assert.equal(approvedLeave.leaveBadges.length, 1);
  assert.equal(approvedLeave.leaveBadges[0].leaveTypeLabel, "Phép năm");
  assert.equal(approvedLeave.leaveBadges[0].sessionLabel, "Sáng");
  assert.equal(approvedLeave.leaveBadges[0].label, "Phép năm (Sáng)");

  // 3. CHECKED_IN -> emerald tone, time range, verification, branch distance
  const checkedIn = describeMatrixDayCell({
    ...baseCell,
    has_checkin: true,
    checkin_count: 2,
    first_time_local: "08:02",
    last_time_local: "17:35",
    verified_checkin_count: 2,
    unverified_checkin_count: 0,
    distance_target_kind: "BRANCH",
    branch_code_used: "HN-CG",
    distance_status: "COMPUTED",
    distance_meters: 145.4,
    day_status: "CHECKED_IN",
  });
  assert.equal(checkedIn.statusLabel, "Có check-in");
  assert.equal(checkedIn.tone, "emerald");
  assert.equal(checkedIn.isRedHighlight, false);
  assert.equal(checkedIn.timeRangeLabel, "08:02 – 17:35 (2 lượt)");
  assert.equal(
    checkedIn.verificationLabel,
    "Tất cả lượt đã xác thực (2/2 lượt) — Đã xác minh (Mốc máy chủ)",
  );
  assert.deepEqual(checkedIn.verification, {
    kind: "ALL_VERIFIED",
    icon: "check",
    tone: "emerald",
    hint: "Tất cả lượt đã xác thực (2/2 lượt) — Đã xác minh (Mốc máy chủ)",
    ariaLabel: "Tất cả lượt đã xác thực (2/2 lượt) — Đã xác minh (Mốc máy chủ)",
    verifiedCount: 2,
    unverifiedCount: 0,
    totalCount: 2,
  });
  assert.equal(checkedIn.distanceLabel, "CN: HN-CG · 145 m");

  // 4. CHECKED_IN_AND_LEAVE -> amber tone, both check-in and leave info
  const both = describeMatrixDayCell({
    ...baseCell,
    has_checkin: true,
    checkin_count: 1,
    first_time_local: "08:15",
    last_time_local: "08:15",
    verified_checkin_count: 0,
    unverified_checkin_count: 1,
    distance_target_kind: "HQ",
    distance_status: "HQ_NOT_CONFIGURED",
    has_approved_leave: true,
    approved_leave_units: 0.5,
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-05",
        session_code: "PM",
        leave_type: "UNPAID",
        half_day_units: 1,
      },
    ],
    day_status: "CHECKED_IN_AND_LEAVE",
  });
  assert.equal(both.statusLabel, "Có check-in & Nghỉ phép");
  assert.equal(both.tone, "amber");
  assert.equal(both.distanceLabel, "HQ · HQ chưa cấu hình tọa độ");
  assert.equal(both.leaveBadges[0].label, "Không lương (Chiều)");

  assert.equal(formatMatrixWeekdayLabel(1), "T2");
  assert.equal(formatMatrixWeekdayLabel(7), "CN");
  assert.equal(
    formatMatrixDistanceStatusLabel("BRANCH_NOT_CONFIGURED", null, "BRANCH", "HCM-01"),
    "CN: HCM-01 · Chi nhánh chưa cấu hình tọa độ",
  );
});

test("monthly matrix Excel export: builds export URL without pagination and maps 422/409/403 errors", () => {
  const url = buildMonthlyMatrixExportUrl({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "employee",
    employeeId: EMPLOYEE_ID,
    search: "ignored",
  });
  assert.ok(url.startsWith("/api/admin/attendance/monthly-matrix/export?"));
  const parsed = new URL(url, "https://example.test");
  assert.equal(parsed.searchParams.get("year_month"), "2026-10");
  assert.equal(parsed.searchParams.get("branch_id"), BRANCH_ID);
  assert.equal(parsed.searchParams.get("employee_id"), EMPLOYEE_ID);
  assert.equal(parsed.searchParams.get("search"), null);
  assert.equal(parsed.searchParams.get("page"), null);
  assert.equal(parsed.searchParams.get("page_size"), null);

  const rowLimitMsg = mapMonthlyMatrixExportError(
    422,
    "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED",
  );
  assert.match(rowLimitMsg, /1\.000/);

  const incompleteMsg = mapMonthlyMatrixExportError(
    409,
    "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE",
  );
  assert.match(incompleteMsg, /thay đổi.*thử lại/i);

  const deniedMsg = mapMonthlyMatrixExportError(403, "ATTENDANCE_REPORT_ACCESS_DENIED");
  assert.match(deniedMsg, /không có quyền/i);

  const filterConflictMsg = mapMonthlyMatrixReportError(
    400,
    "ATTENDANCE_REPORT_FILTER_CONFLICT",
  );
  assert.match(filterConflictMsg, /không gửi đồng thời/i);
});

test("HRP branch management & employee assignment: validates payloads, blocks inactive branch assignment, and maps OCC/overlap/idempotency errors", () => {
  // 1. Upsert branch requires all-or-nothing coordinates
  assert.equal(
    buildUpsertBranchPayload({
      branchCode: "hn-01",
      displayName: "Chi nhánh Hà Nội",
      address: "Cầu Giấy",
      latitudeInput: "21.0285",
      longitudeInput: "",
      active: true,
      expectedVersion: 0,
      idempotencyKey: INTENT_KEY,
    }).ok,
    false,
  );

  const createdBranch = buildUpsertBranchPayload({
    branchCode: "hn-01",
    displayName: "Chi nhánh Hà Nội",
    address: "Cầu Giấy",
    latitudeInput: "21.028511",
    longitudeInput: "105.804817",
    active: true,
    expectedVersion: 0,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(createdBranch.ok, true);
  assert.deepEqual(createdBranch.body, {
    branch_code: "HN-01",
    display_name: "Chi nhánh Hà Nội",
    address: "Cầu Giấy",
    latitude: 21.028511,
    longitude: 105.804817,
    active: true,
    expected_version: 0,
    idempotency_key: INTENT_KEY,
  });

  // 2. Prevent assigning employee to an inactive branch
  const inactiveAssign = buildAssignEmployeeToBranchPayload({
    appUserId: EMPLOYEE_ID,
    branch: { branch_id: BRANCH_ID, active: false, version: 2 },
    validFrom: "2026-10-20",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(inactiveAssign.ok, false);
  assert.match(inactiveAssign.message, /ngừng hoạt động/i);

  // 3. Valid assignment sends app_user_id, branch_id, valid_from, expected_version (branch version), idempotency_key
  const activeAssign = buildAssignEmployeeToBranchPayload({
    appUserId: EMPLOYEE_ID,
    branch: { branch_id: BRANCH_ID, active: true, version: 2 },
    validFrom: "2026-10-20",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(activeAssign.ok, true);
  assert.deepEqual(activeAssign.body, {
    app_user_id: EMPLOYEE_ID,
    branch_id: BRANCH_ID,
    valid_from: "2026-10-20",
    expected_version: 2,
    idempotency_key: INTENT_KEY,
  });

  // 4. Unassign sends valid_to, expected_version (assignment version), idempotency_key
  const unassign = buildUnassignEmployeeFromBranchPayload({
    validTo: "2026-10-31",
    expectedVersion: 3,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(unassign.ok, true);
  assert.deepEqual(unassign.body, {
    valid_to: "2026-10-31",
    expected_version: 3,
    idempotency_key: INTENT_KEY,
  });

  // 5. Assignment status description
  assert.equal(
    describeBranchAssignmentStatus({
      effective: true,
      valid_from: "2026-10-01",
      valid_to: null,
    }).statusLabel,
    "Đang hiệu lực",
  );
  assert.equal(
    describeBranchAssignmentStatus({
      effective: false,
      valid_from: "2026-12-01",
      valid_to: null,
    }).statusLabel,
    "Sắp hiệu lực",
  );
  assert.equal(
    describeBranchAssignmentStatus({
      effective: false,
      valid_from: "2026-09-01",
      valid_to: "2026-09-30",
    }).canUnassign,
    false,
  );

  // 6. Error mapping for branch mutations
  for (const [code, expectedConflict] of [
    ["ATTENDANCE_BRANCH_CODE_CONFLICT", true],
    ["ATTENDANCE_BRANCH_VERSION_CONFLICT", true],
    ["ATTENDANCE_BRANCH_INACTIVE", false],
    ["ATTENDANCE_BRANCH_TARGET_USER_INVALID", false],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP", true],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED", true],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID", false],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT", true],
    ["IDEMPOTENCY_CONFLICT", true],
    ["ATTENDANCE_BRANCH_WRITE_DENIED", false],
  ]) {
    const mapped = mapBranchAdminMutationError(409, code);
    assert.equal(mapped.isConflict, expectedConflict, `conflict flag for ${code}`);
    assert.ok(mapped.message.length > 10);
  }
});

test("Google Maps coordinate link helper and detailed attendance GpsDetailCell wiring", () => {
  assert.equal(
    buildGoogleMapsCoordinatesUrl(10.776889, 106.700806),
    "https://www.google.com/maps/search/?api=1&query=10.776889,106.700806",
  );
  assert.equal(buildGoogleMapsCoordinatesUrl(-0, 105.8), "https://www.google.com/maps/search/?api=1&query=0,105.8");
  assert.equal(buildGoogleMapsCoordinatesUrl(null, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, null), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(Number.NaN, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, Number.POSITIVE_INFINITY), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(91, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, 181), null);

  // Verify GpsDetailCell in attendance-report-manager.tsx renders <a> with target="_blank" and rel="noreferrer"
  const gpsCellBlock = managerSource.match(/function GpsDetailCell[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(gpsCellBlock.length > 0, "GpsDetailCell must exist in attendance-report-manager.tsx");
  assert.match(gpsCellBlock, /buildGoogleMapsCoordinatesUrl\(item\.latitude,\s*item\.longitude\)/);
  assert.match(gpsCellBlock, /href=\{googleMapsUrl\}/);
  assert.match(gpsCellBlock, /target="_blank"/);
  assert.match(gpsCellBlock, /rel="noreferrer"/);
  // Accuracy and note remain outside the <a> tag
  assert.match(gpsCellBlock, /<\/a>\s*\{item\.accuracy_meters !== null/);
  assert.match(gpsCellBlock, /Ghi chú: \{item\.note\}/);

  // Verify tabs and sections are wired in attendance-report-manager.tsx and attendance-monthly-matrix-panel.tsx
  assert.match(managerSource, /role="tablist"/);
  assert.match(managerSource, /Chi tiết lượt chấm công/);
  assert.match(managerSource, /Báo cáo tháng/);
  assert.match(managerSource, /Giải trình chấm công/);
  assert.match(managerSource, /Chi nhánh HRP/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/monthly-matrix/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/branches/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/branches\/assignments/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/slot-policies/);
  assert.match(matrixPanelSource, /can_manage_branches/);
  assert.match(matrixPanelSource, /can_manage_slot_policy/);
  assert.match(matrixPanelSource, /Chỉ xem \(BoD\)/);
  assert.match(matrixPanelSource, /Chưa có lượt chấm/);
  assert.equal(/vắng không phép/i.test(matrixPanelSource), false);
});

test("Flexible slot assignment (5-slot default & custom 4-slot): preserves multiple check-ins in same slot, applies earlier-slot tie-break on equidistant times, and enforces exact tolerance boundaries", () => {
  // Verify 5-slot default seed (Time 1: 07:30, Time 2: 10:00, Time 3: 13:00, Time 4: 15:00, Time 5: 16:30, ±15m)
  assert.equal(DEFAULT_ATTENDANCE_SLOT_POLICY.slots.length, 5);
  assert.deepEqual(
    DEFAULT_ATTENDANCE_SLOT_POLICY.slots.map((s) => ({
      label: s.slot_label,
      time: s.target_time,
      before: s.grace_before_minutes,
      after: s.grace_after_minutes,
    })),
    [
      { label: "Time 1", time: "07:30", before: 15, after: 15 },
      { label: "Time 2", time: "10:00", before: 15, after: 15 },
      { label: "Time 3", time: "13:00", before: 15, after: 15 },
      { label: "Time 4", time: "15:00", before: 15, after: 15 },
      { label: "Time 5", time: "16:30", before: 15, after: 15 },
    ],
  );

  // Evaluate against a 4-slot policy (08:00, 11:00, 13:00, 17:00, ±15m) to verify custom slot count + tie-breaks:
  const customFourSlotPolicy = {
    version: 2,
    slots: [
      {
        slot_code: "SLOT_1",
        slot_index: 1,
        slot_label: "Time 1",
        session_code: "AM",
        target_time: "08:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
      {
        slot_code: "SLOT_2",
        slot_index: 2,
        slot_label: "Time 2",
        session_code: "AM",
        target_time: "11:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
      {
        slot_code: "SLOT_3",
        slot_index: 3,
        slot_label: "Time 3",
        session_code: "PM",
        target_time: "13:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
      {
        slot_code: "SLOT_4",
        slot_index: 4,
        slot_label: "Time 4",
        session_code: "PM",
        target_time: "17:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
    ],
  };

  // 1. Multiple check-ins in SLOT_1 (07:45 exact boundary, 07:40 early by 20m -> Sớm 20p, 08:15 exact boundary, 08:25 late by 25m -> Muộn 25p)
  // Plus equidistant tie-breakers:
  // - 09:30 (570m) equidistant between SLOT_1 (08:00=480m, diff 90m) and SLOT_2 (11:00=660m, diff 90m) -> assigned to SLOT_1
  // - 12:00 (720m) equidistant between SLOT_2 (11:00=660m, diff 60m) and SLOT_3 (13:00=780m, diff 60m) -> assigned to SLOT_2
  // - 15:00 (900m) equidistant between SLOT_3 (13:00=780m, diff 120m) and SLOT_4 (17:00=1020m, diff 120m) -> assigned to SLOT_3
  const evaluated = evaluateAttendanceDaySlots({
    policy: customFourSlotPolicy,
    checkins: [
      {
        checkin_id: "c-0825",
        sequence_in_day: 4,
        captured_at: "2026-10-05T01:25:00Z",
        captured_at_local: "2026-10-05 08:25:00",
        time_local: "08:25",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 12,
      },
      {
        checkin_id: "c-0740",
        sequence_in_day: 1,
        captured_at: "2026-10-05T00:40:00Z",
        captured_at_local: "2026-10-05 07:40:00",
        time_local: "07:40",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 10,
      },
      {
        checkin_id: "c-0745",
        sequence_in_day: 2,
        captured_at: "2026-10-05T00:45:00Z",
        captured_at_local: "2026-10-05 07:45:00",
        time_local: "07:45",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 10,
      },
      {
        checkin_id: "c-0815",
        sequence_in_day: 3,
        captured_at: "2026-10-05T01:15:00Z",
        captured_at_local: "2026-10-05 08:15:00",
        time_local: "08:15",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 11,
      },
      {
        checkin_id: "c-0930-tie",
        sequence_in_day: 5,
        captured_at: "2026-10-05T02:30:00Z",
        captured_at_local: "2026-10-05 09:30:00",
        time_local: "09:30",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 15,
      },
      {
        checkin_id: "c-1200-tie",
        sequence_in_day: 6,
        captured_at: "2026-10-05T05:00:00Z",
        captured_at_local: "2026-10-05 12:00:00",
        time_local: "12:00",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 15,
      },
      {
        checkin_id: "c-1500-tie",
        sequence_in_day: 7,
        captured_at: "2026-10-05T08:00:00Z",
        captured_at_local: "2026-10-05 15:00:00",
        time_local: "15:00",
        time_verified: false,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 20,
      },
    ],
    approved_leaves: [],
  });

  // SLOT_1 receives 07:40, 07:45, 08:15, 08:25, and 09:30 sorted chronologically ascending
  const slot1 = evaluated.slots[0];
  assert.equal(slot1.slot_code, "SLOT_1");
  assert.equal(slot1.checkins.length, 5);
  assert.deepEqual(
    slot1.checkins.map((c) => c.time_local),
    ["07:40", "07:45", "08:15", "08:25", "09:30"],
  );
  // 07:40 is 20m before 08:00 (grace_before = 15m) -> EARLY
  assert.equal(slot1.checkins[0].deviation_status, "EARLY");
  assert.equal(slot1.checkins[0].delta_minutes, -20);
  assert.equal(slot1.checkins[0].over_grace_minutes, 5);
  // 07:45 is exactly 15m before 08:00 (equal to grace_before = 15m) -> ON_TIME (no warning)
  assert.equal(slot1.checkins[1].deviation_status, "ON_TIME");
  assert.equal(slot1.checkins[1].delta_minutes, -15);
  assert.equal(slot1.checkins[1].over_grace_minutes, 0);
  // 08:15 is exactly 15m after 08:00 (equal to grace_after = 15m) -> ON_TIME (no warning)
  assert.equal(slot1.checkins[2].deviation_status, "ON_TIME");
  assert.equal(slot1.checkins[2].delta_minutes, 15);
  assert.equal(slot1.checkins[2].over_grace_minutes, 0);
  // 08:25 is 25m after 08:00 -> LATE
  assert.equal(slot1.checkins[3].deviation_status, "LATE");
  assert.equal(slot1.checkins[3].delta_minutes, 25);
  assert.equal(slot1.checkins[3].over_grace_minutes, 10);
  // 09:30 tied between SLOT_1 (08:00) and SLOT_2 (11:00) -> assigned to SLOT_1
  assert.equal(slot1.checkins[4].deviation_status, "LATE");
  assert.equal(slot1.checkins[4].delta_minutes, 90);

  // SLOT_2 receives 12:00 tie-break
  const slot2 = evaluated.slots[1];
  assert.equal(slot2.slot_code, "SLOT_2");
  assert.deepEqual(slot2.checkins.map((c) => c.time_local), ["12:00"]);
  assert.equal(slot2.checkins[0].deviation_status, "LATE");
  assert.equal(slot2.checkins[0].delta_minutes, 60);

  // SLOT_3 receives 15:00 tie-break
  const slot3 = evaluated.slots[2];
  assert.equal(slot3.slot_code, "SLOT_3");
  assert.deepEqual(slot3.checkins.map((c) => c.time_local), ["15:00"]);
  assert.equal(slot3.checkins[0].deviation_status, "LATE");
  assert.equal(slot3.checkins[0].delta_minutes, 120);

  // SLOT_4 has no check-ins and no leave -> MISSING
  const slot4 = evaluated.slots[3];
  assert.equal(slot4.slot_code, "SLOT_4");
  assert.equal(slot4.slot_status, "MISSING");
  assert.equal(evaluated.missing_slot_count, 1);
  assert.equal(evaluated.late_or_early_checkin_count, 5);

  // Verify UI presentation & Excel cell text formatting for this day cell
  const cellProjection = {
    business_date: "2026-10-05",
    day_of_month: 5,
    policy_version_used: 2,
    has_checkin: true,
    checkin_count: 7,
    first_checkin_id: "c-0740",
    last_checkin_id: "c-1500-tie",
    first_captured_at: "2026-10-05T00:40:00Z",
    first_captured_at_local: "2026-10-05 07:40:00",
    first_time_local: "07:40",
    last_captured_at: "2026-10-05T08:00:00Z",
    last_captured_at_local: "2026-10-05 15:00:00",
    last_time_local: "15:00",
    verified_checkin_count: 6,
    unverified_checkin_count: 1,
    distance_target_kind: "HQ",
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
    hq_version_used: 1,
    distance_status: "COMPUTED",
    distance_meters: 10,
    min_distance_meters: 10,
    max_distance_meters: 20,
    has_approved_leave: false,
    approved_leave_units: 0,
    approved_leaves: [],
    day_status: "CHECKED_IN",
    missing_slot_count: evaluated.missing_slot_count,
    late_or_early_checkin_count: evaluated.late_or_early_checkin_count,
    slots: evaluated.slots,
  };

  const presentation = describeMatrixDayCell(cellProjection);
  assert.equal(presentation.slots[0].checkins[0].deviationBadgeLabel, "Sớm 20p");
  assert.equal(presentation.slots[0].checkins[1].deviationBadgeLabel, null);
  assert.equal(presentation.slots[0].checkins[2].deviationBadgeLabel, null);
  assert.equal(presentation.slots[0].checkins[3].deviationBadgeLabel, "Muộn 25p");
  assert.equal(presentation.slots[3].statusLabel, "Chưa có lượt chấm");

  const excelText = formatMatrixDayCellText(cellProjection);
  assert.match(excelText, /Time 1 \(08:00\): 07:40 \(Sớm 20p\), 07:45, 08:15, 08:25 \(Muộn 25p\), 09:30 \(Muộn 90p\)/);
  assert.match(excelText, /Time 4 \(17:00\): Chưa có lượt chấm/);
  assert.equal(/vắng không phép/i.test(excelText), false);
});

test("5-slot default leave coverage: FULL covers all 5 slots, AM covers Time 1..2 (< 12:00), PM covers Time 3..5 (>= 12:00)", () => {
  const amEval = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-06",
        session_code: "AM",
        leave_type: "ANNUAL",
        half_day_units: 1,
      },
    ],
  });
  assert.equal(amEval.slots.length, 5);
  assert.equal(amEval.slots[0].slot_status, "LEAVE_COVERED");
  assert.equal(amEval.slots[1].slot_status, "LEAVE_COVERED");
  assert.equal(amEval.slots[2].slot_status, "MISSING");
  assert.equal(amEval.slots[3].slot_status, "MISSING");
  assert.equal(amEval.slots[4].slot_status, "MISSING");
  assert.equal(amEval.missing_slot_count, 3);

  const pmEval = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-06",
        session_code: "PM",
        leave_type: "SICK",
        half_day_units: 1,
      },
    ],
  });
  assert.equal(pmEval.slots[0].slot_status, "MISSING");
  assert.equal(pmEval.slots[1].slot_status, "MISSING");
  assert.equal(pmEval.slots[2].slot_status, "LEAVE_COVERED");
  assert.equal(pmEval.slots[3].slot_status, "LEAVE_COVERED");
  assert.equal(pmEval.slots[4].slot_status, "LEAVE_COVERED");
  assert.equal(pmEval.missing_slot_count, 2);

  const fullEval = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-06",
        session_code: "FULL",
        leave_type: "MATERNITY",
        half_day_units: 2,
      },
    ],
  });
  for (const slot of fullEval.slots) {
    assert.equal(slot.slot_status, "LEAVE_COVERED");
  }
  assert.equal(fullEval.missing_slot_count, 0);
});

test("Slot policy payload builder, error mapper, and legend items", () => {
  assert.equal(MATRIX_LEGEND_ITEMS.length, 6);

  const validPolicy = buildCreateSlotPolicyPayload({
    effectiveFromDate: "2026-11-01",
    slot1Time: "07:30",
    slot1GraceBeforeInput: "15",
    slot1GraceAfterInput: "10",
    slot2Time: "11:30",
    slot2GraceBeforeInput: "10",
    slot2GraceAfterInput: "15",
    slot3Time: "13:00",
    slot3GraceBeforeInput: "15",
    slot3GraceAfterInput: "15",
    slot4Time: "17:00",
    slot4GraceBeforeInput: "15",
    slot4GraceAfterInput: "20",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(validPolicy.ok, true);
  if (validPolicy.ok) {
    assert.equal(validPolicy.body.effective_from_date, "2026-11-01");
    assert.equal(validPolicy.body.slots[0].target_time, "07:30");
    assert.equal(validPolicy.body.slots[0].grace_after_minutes, 10);
    assert.equal(validPolicy.body.expected_version, 1);
  }

  // Non-monotonic slot times rejected
  const nonMonotonic = buildCreateSlotPolicyPayload({
    effectiveFromDate: "2026-11-01",
    slot1Time: "11:30",
    slot1GraceBeforeInput: "15",
    slot1GraceAfterInput: "15",
    slot2Time: "11:00",
    slot2GraceBeforeInput: "15",
    slot2GraceAfterInput: "15",
    slot3Time: "13:00",
    slot3GraceBeforeInput: "15",
    slot3GraceAfterInput: "15",
    slot4Time: "17:00",
    slot4GraceBeforeInput: "15",
    slot4GraceAfterInput: "15",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(nonMonotonic.ok, false);

  // Grace minutes out of range 0..240 rejected
  const badGrace = buildCreateSlotPolicyPayload({
    effectiveFromDate: "2026-11-01",
    slot1Time: "08:00",
    slot1GraceBeforeInput: "300",
    slot1GraceAfterInput: "15",
    slot2Time: "11:00",
    slot2GraceBeforeInput: "15",
    slot2GraceAfterInput: "15",
    slot3Time: "13:00",
    slot3GraceBeforeInput: "15",
    slot3GraceAfterInput: "15",
    slot4Time: "17:00",
    slot4GraceBeforeInput: "15",
    slot4GraceAfterInput: "15",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(badGrace.ok, false);

  for (const [code, expectedConflict] of [
    ["ATTENDANCE_SLOT_POLICY_OVERLAP", true],
    ["ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT", true],
    ["IDEMPOTENCY_CONFLICT", true],
    ["ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST", false],
    ["ATTENDANCE_SLOT_POLICY_WRITE_DENIED", false],
    ["ATTENDANCE_SLOT_POLICY_INVALID", false],
  ]) {
    const mapped = mapSlotPolicyMutationError(409, code);
    assert.equal(mapped.isConflict, expectedConflict, `conflict flag for ${code}`);
    assert.ok(mapped.message.length > 10);
  }
});

test("Wave 2 attendance explanations: approved explanation marks slot EXPLAINED_APPROVED without creating check-ins; rejected explanation retains MISSING/OUT_OF_GRACE and shows 'Giải trình bị từ chối'", () => {
  const explanations = [
    {
      explanation_id: "55555555-5555-4555-8555-555555555551",
      slot_code: "SLOT_1",
      status: "APPROVED",
      original_slot_status: "MISSING",
      reason: "Đi gặp ứng viên tại dự án",
      decision_note: "Đồng ý giải trình",
      submitted_at: "2026-10-07T02:00:00Z",
      decided_at: "2026-10-07T03:00:00Z",
    },
    {
      explanation_id: "55555555-5555-4555-8555-555555555552",
      slot_code: "SLOT_2",
      status: "REJECTED",
      original_slot_status: "OUT_OF_GRACE",
      reason: "Kẹt xe đường Vành đai 3",
      decision_note: "Không đủ căn cứ",
      submitted_at: "2026-10-07T04:00:00Z",
      decided_at: "2026-10-07T05:00:00Z",
    },
    {
      explanation_id: "55555555-5555-4555-8555-555555555553",
      slot_code: "SLOT_3",
      status: "PENDING",
      original_slot_status: "MISSING",
      reason: "Điện thoại hết pin",
      decision_note: null,
      submitted_at: "2026-10-07T06:00:00Z",
      decided_at: null,
    },
  ];

  const evaluated = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [
      {
        checkin_id: "c-1025",
        sequence_in_day: 1,
        captured_at: "2026-10-07T03:25:00Z",
        captured_at_local: "2026-10-07 10:25:00",
        time_local: "10:25",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 10,
      },
    ],
    approved_leaves: [],
    explanations,
  });

  // SLOT_1 had no check-in, but explanation is APPROVED -> slot_status becomes EXPLAINED_APPROVED, checkins remains []
  assert.equal(evaluated.slots[0].slot_code, "SLOT_1");
  assert.equal(evaluated.slots[0].slot_status, "EXPLAINED_APPROVED");
  assert.equal(evaluated.slots[0].checkins.length, 0);
  assert.equal(evaluated.slots[0].explanation?.status, "APPROVED");

  // SLOT_2 had a late check-in (10:25 vs 10:00 +15m) and explanation is REJECTED -> keeps OUT_OF_GRACE
  assert.equal(evaluated.slots[1].slot_code, "SLOT_2");
  assert.equal(evaluated.slots[1].slot_status, "OUT_OF_GRACE");
  assert.equal(evaluated.slots[1].checkins.length, 1);
  assert.equal(evaluated.slots[1].explanation?.status, "REJECTED");

  // SLOT_3 has PENDING explanation -> keeps MISSING
  assert.equal(evaluated.slots[2].slot_code, "SLOT_3");
  assert.equal(evaluated.slots[2].slot_status, "MISSING");
  assert.equal(evaluated.slots[2].explanation?.status, "PENDING");

  // Missing slots = SLOT_3, SLOT_4, SLOT_5 (3 slots, since SLOT_1 is EXPLAINED_APPROVED and SLOT_2 has check-in)
  assert.equal(evaluated.missing_slot_count, 3);

  const cellProjection = {
    business_date: "2026-10-07",
    day_of_month: 7,
    policy_version_used: 1,
    has_checkin: true,
    checkin_count: 1,
    first_checkin_id: "c-1025",
    last_checkin_id: "c-1025",
    first_captured_at: "2026-10-07T03:25:00Z",
    first_captured_at_local: "2026-10-07 10:25:00",
    first_time_local: "10:25",
    last_captured_at: "2026-10-07T03:25:00Z",
    last_captured_at_local: "2026-10-07 10:25:00",
    last_time_local: "10:25",
    verified_checkin_count: 1,
    unverified_checkin_count: 0,
    distance_target_kind: "HQ",
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
    hq_version_used: 1,
    distance_status: "COMPUTED",
    distance_meters: 10,
    min_distance_meters: 10,
    max_distance_meters: 10,
    has_approved_leave: false,
    approved_leave_units: 0,
    approved_leaves: [],
    day_status: "CHECKED_IN",
    missing_slot_count: evaluated.missing_slot_count,
    late_or_early_checkin_count: evaluated.late_or_early_checkin_count,
    slots: evaluated.slots,
  };

  const presentation = describeMatrixDayCell(cellProjection);
  assert.equal(presentation.slots[0].statusLabel, MATRIX_EXPLAINED_APPROVED_LABEL);
  assert.equal(presentation.slots[0].explanationStatusLabel, MATRIX_EXPLAINED_APPROVED_LABEL);
  assert.equal(presentation.slots[0].tone, "emerald");
  assert.equal(presentation.slots[1].explanationStatusLabel, MATRIX_EXPLANATION_REJECTED_LABEL);
  assert.equal(presentation.slots[1].tone, "amber");
  assert.equal(presentation.slots[2].explanationStatusLabel, MATRIX_EXPLANATION_PENDING_LABEL);
  assert.equal(presentation.slots[2].tone, "red");

  const excelText = formatMatrixDayCellText(cellProjection);
  assert.match(excelText, /Time 1 \(07:30\): Giải trình được duyệt/);
  assert.match(excelText, /Time 2 \(10:00\): 10:25 \(Muộn 25p\) · Giải trình bị từ chối/);
  assert.match(excelText, /Time 3 \(13:00\): Chưa có lượt chấm · Chờ duyệt giải trình/);

  const explanationSummary = formatMatrixExplanationSummary(cellProjection);
  assert.match(explanationSummary, /Time 1: Giải trình được duyệt \(Đi gặp ứng viên tại dự án\)/);
  assert.match(explanationSummary, /Time 2: Giải trình bị từ chối \(Kẹt xe đường Vành đai 3\)/);
  assert.match(explanationSummary, /Time 3: Chờ duyệt giải trình \(Điện thoại hết pin\)/);
});

test("Wave 2 attendance explanation payload builders and error mapper", () => {
  const validSubmit = buildSubmitAttendanceExplanationPayload({
    businessDate: "2026-10-07",
    slotCode: "SLOT_1",
    reason: "  Đi khảo sát thực địa dự án  ",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(validSubmit.ok, true);
  if (validSubmit.ok) {
    assert.deepEqual(validSubmit.body, {
      business_date: "2026-10-07",
      slot_code: "SLOT_1",
      reason: "Đi khảo sát thực địa dự án",
      idempotency_key: INTENT_KEY,
    });
  }

  assert.equal(
    buildSubmitAttendanceExplanationPayload({
      businessDate: "2026-10-07",
      slotCode: "SLOT_1",
      reason: "   ",
      idempotencyKey: INTENT_KEY,
    }).ok,
    false,
  );

  const validDecision = buildDecideAttendanceExplanationPayload({
    decision: "APPROVE",
    expectedRowVersion: 1,
    decisionNote: "  Xác nhận công tác  ",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(validDecision.ok, true);
  if (validDecision.ok) {
    assert.deepEqual(validDecision.body, {
      decision: "APPROVE",
      expected_row_version: 1,
      decision_note: "Xác nhận công tác",
      idempotency_key: INTENT_KEY,
    });
  }

  for (const [code, expectedConflict] of [
    ["ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED", true],
    ["ATTENDANCE_EXPLANATION_ALREADY_DECIDED", true],
    ["ATTENDANCE_EXPLANATION_VERSION_CONFLICT", true],
    ["IDEMPOTENCY_CONFLICT", true],
    ["ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE", false],
    ["ATTENDANCE_EXPLANATION_DECISION_DENIED", false],
  ]) {
    const mapped = mapAttendanceExplanationMutationError(409, code);
    assert.equal(mapped.isConflict, expectedConflict, `conflict flag for ${code}`);
    assert.ok(mapped.message.length > 10);
  }

  assert.match(explanationWorkspaceSource, /\/api\/attendance\/explanations/);
  assert.match(explanationWorkspaceSource, /\/api\/attendance\/explanations\/approvals/);
});

test("Hotfix 1 & 2: FloatingTableNav viewport portal & bottom-right placement, arrow-only accessible controls, 70% horizontal scroll step, and unchanged vertical scroll step", () => {
  assert.deepEqual(computeTableScrollAvailability(null), {
    hasHorizontalOverflow: false,
    hasVerticalOverflow: false,
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
    canScrollUp: false,
    canScrollDown: false,
  });

  assert.deepEqual(
    computeTableScrollAvailability({
      scrollLeft: 0,
      scrollTop: 50,
      scrollWidth: 1600,
      clientWidth: 800,
      scrollHeight: 900,
      clientHeight: 400,
    }),
    {
      hasHorizontalOverflow: true,
      hasVerticalOverflow: true,
      hasOverflow: true,
      canScrollLeft: false,
      canScrollRight: true,
      canScrollUp: true,
      canScrollDown: true,
    },
  );

  // 1. FloatingTableNav defaults to bottom-right,
  // portals to document.body so it is fixed to viewport (never trapped by transformed/overflow ancestors),
  // and keeps the compact UI without the "Điều hướng bảng" text label
  assert.equal(resolveFloatingTableNavPositionClass(), "fixed bottom-4 right-4 z-40");
  assert.equal(
    resolveFloatingTableNavPositionClass("bottom-right"),
    "fixed bottom-4 right-4 z-40",
  );
  assert.equal(
    resolveFloatingTableNavPositionClass("bottom-left"),
    "fixed bottom-4 left-4 z-40",
  );
  assert.match(floatingTableNavSource, /createPortal\(navNode,\s*document\.body\)/);
  assert.match(floatingTableNavSource, /resolveFloatingTableNavPositionClass\(position\)/);
  assert.doesNotMatch(floatingTableNavSource, /<span[^>]*>\s*Điều hướng bảng\s*<\/span>/);

  // Detailed Report ("Báo cáo chi tiết") and other pages use the default bottom-right position
  assert.match(
    detailedMatrixPanelSource,
    /<FloatingTableNav[\s\S]*?tableLabel="Báo cáo chi tiết"/,
  );
  assert.doesNotMatch(detailedMatrixPanelSource, /position="bottom-left"/);
  assert.doesNotMatch(matrixPanelSource, /position="bottom-left"/);
  assert.doesNotMatch(managerSource, /position="bottom-left"/);

  // All 4 arrow buttons retain accessible names (aria-label) and tooltips (title)
  for (const label of [
    "Cuộn bảng sang trái",
    "Cuộn bảng sang phải",
    "Cuộn bảng lên trên",
    "Cuộn bảng xuống dưới",
  ]) {
    assert.match(floatingTableNavSource, new RegExp(`aria-label="${label}"`));
    assert.match(floatingTableNavSource, new RegExp(`title="${label}`));
  }

  // Shared component used across Báo cáo tháng and Báo cáo chi tiết
  assert.match(matrixPanelSource, /FloatingTableNav/);
  assert.match(managerSource, /FloatingTableNav/);
  assert.match(detailedMatrixPanelSource, /FloatingTableNav/);

  // 2. Horizontal scroll step is reduced to 70% of previous horizontal step (0.75 * 0.7 = 0.525, min 196px, fallback 392px),
  // while vertical scroll step remains unchanged (0.75, min 240px, fallback 360px)
  assert.equal(TABLE_HORIZONTAL_SCROLL_STEP_SCALE, 0.7);
  assert.equal(TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO, 0.525);
  assert.equal(MIN_TABLE_HORIZONTAL_STEP_PX, 196);
  assert.equal(DEFAULT_TABLE_HORIZONTAL_STEP_PX, 392);
  assert.equal(TABLE_SCROLL_VERTICAL_VIEWPORT_STEP_RATIO, 0.75);
  assert.equal(MIN_TABLE_VERTICAL_STEP_PX, 240);
  assert.equal(DEFAULT_TABLE_VERTICAL_STEP_PX, 360);

  assert.equal(computeTableScrollStepPx(1200), 630); // 70% of 900
  assert.equal(computeTableScrollStepPx(1000), 525); // 70% of 750
  assert.equal(computeTableScrollStepPx(800), 420); // 70% of 600
  assert.equal(computeTableScrollStepPx(300), 196); // 70% of 280
  assert.equal(computeTableScrollStepPx(0), 392); // 70% of 560
  assert.equal(
    computeTableScrollStepPx(600, {
      minStepPx: MIN_TABLE_VERTICAL_STEP_PX,
      fallbackStepPx: DEFAULT_TABLE_VERTICAL_STEP_PX,
      ratio: TABLE_SCROLL_VERTICAL_VIEWPORT_STEP_RATIO,
    }),
    450,
  );

  const metrics = {
    scrollLeft: 200,
    scrollTop: 100,
    scrollWidth: 2400,
    clientWidth: 1000, // horizontal step = 525 (70% of 750), maxLeft = 1400
    scrollHeight: 1500,
    clientHeight: 600, // vertical step = 450 (unchanged), maxTop = 900
  };
  assert.deepEqual(computeClampedTableScrollTarget(metrics, "right"), {
    left: 725,
    top: 100,
    deltaLeft: 525,
    deltaTop: 0,
  });
  assert.deepEqual(computeClampedTableScrollTarget(metrics, "left"), {
    left: 0,
    top: 100,
    deltaLeft: -200,
    deltaTop: 0,
  });
  assert.deepEqual(computeClampedTableScrollTarget(metrics, "down"), {
    left: 200,
    top: 550,
    deltaLeft: 0,
    deltaTop: 450,
  });
  assert.deepEqual(computeClampedTableScrollTarget(metrics, "up"), {
    left: 200,
    top: 0,
    deltaLeft: 0,
    deltaTop: -100,
  });

  // Clamps cleanly at right/bottom edge without overshooting
  assert.deepEqual(
    computeClampedTableScrollTarget({ ...metrics, scrollLeft: 1100 }, "right"),
    {
      left: 1400,
      top: 100,
      deltaLeft: 300,
      deltaTop: 0,
    },
  );
  assert.deepEqual(
    computeClampedTableScrollTarget({ ...metrics, scrollTop: 700 }, "down"),
    {
      left: 200,
      top: 900,
      deltaLeft: 0,
      deltaTop: 200,
    },
  );

  // Adapts when viewport resizes (e.g., 1600px wide -> 840px step, clamped to maxLeft = 800)
  assert.deepEqual(
    computeClampedTableScrollTarget({ ...metrics, clientWidth: 1600, scrollLeft: 0 }, "right"),
    {
      left: 800,
      top: 100,
      deltaLeft: 800,
      deltaTop: 0,
    },
  );

  // Smooth horizontal scroll in Detailed Recruitment Matrix uses a settle timer so topScrollRef doesn't cancel smooth scrolling after 1 frame
  assert.match(detailedMatrixPanelSource, /syncingScrollTimerRef/);
  assert.match(detailedMatrixPanelSource, /computeTableScrollStepPx\(tableEl\.clientWidth\)/);

  // Attendance check-in detail table attaches scrollRef directly to DataTableContainer's scrollable viewport
  assert.match(managerSource, /scrollRef=\{checkinsTableContainerRef\}/);
});

test("Hotfix 3: describeAttendanceCheckinDistanceTarget distinguishes branch vs headquarters snapshot at check-in time", () => {
  // Branch check-in with computed distance
  const branchComputed = describeAttendanceCheckinDistanceTarget({
    distance_status: "COMPUTED",
    distance_meters: 120.4,
    hq_version_used: null,
    branch_id_used: BRANCH_ID,
    branch_code_used: "HRP-HN",
    branch_name_used: "Chi nhánh Hà Nội",
    branch_version_used: 3,
  });
  assert.equal(branchComputed.targetKind, "BRANCH");
  assert.equal(branchComputed.tone, "computed");
  assert.equal(branchComputed.subtitleText, "Theo chi nhánh Chi nhánh Hà Nội v3");
  assert.equal(branchComputed.detailSectionTitle, "Khoảng cách tới chi nhánh");

  // Even if legacy/defensive payload has hq_version_used alongside branch_id_used, branch snapshot wins
  const branchWithFallbackCode = describeAttendanceCheckinDistanceTarget({
    distance_status: "COMPUTED",
    distance_meters: 85,
    hq_version_used: 1,
    branch_id_used: BRANCH_ID,
    branch_code_used: "HRP-BN",
    branch_name_used: null,
    branch_version_used: 2,
  });
  assert.equal(branchWithFallbackCode.targetKind, "BRANCH");
  assert.equal(branchWithFallbackCode.subtitleText, "Theo chi nhánh HRP-BN v2");

  // Headquarters check-in with computed distance
  const hqComputed = describeAttendanceCheckinDistanceTarget({
    distance_status: "COMPUTED",
    distance_meters: 45,
    hq_version_used: 4,
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
  });
  assert.equal(hqComputed.targetKind, "HQ");
  assert.equal(hqComputed.tone, "computed");
  assert.equal(hqComputed.subtitleText, "Theo trụ sở v4");
  assert.equal(hqComputed.detailSectionTitle, "Khoảng cách tới trụ sở");

  // Branch without coordinates at check-in time
  const branchNotConfigured = describeAttendanceCheckinDistanceTarget({
    distance_status: "BRANCH_NOT_CONFIGURED",
    distance_meters: null,
    hq_version_used: null,
    branch_id_used: BRANCH_ID,
    branch_code_used: "HRP-DN",
    branch_name_used: "Chi nhánh Đà Nẵng",
    branch_version_used: 1,
  });
  assert.equal(branchNotConfigured.targetKind, "BRANCH");
  assert.equal(branchNotConfigured.tone, "not_configured");
  assert.equal(branchNotConfigured.primaryText, "Chi nhánh chưa cấu hình tọa độ");
  assert.equal(
    branchNotConfigured.subtitleText,
    "Theo chi nhánh Chi nhánh Đà Nẵng v1 (chưa cấu hình tọa độ tại thời điểm chấm công)",
  );
  assert.equal(branchNotConfigured.detailSectionTitle, "Khoảng cách tới chi nhánh");

  // Headquarters without coordinates at check-in time
  const hqNotConfigured = describeAttendanceCheckinDistanceTarget({
    distance_status: "HQ_NOT_CONFIGURED",
    distance_meters: null,
    hq_version_used: null,
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
  });
  assert.equal(hqNotConfigured.targetKind, "HQ");
  assert.equal(hqNotConfigured.tone, "not_configured");
  assert.equal(hqNotConfigured.primaryText, "Trụ sở chưa cấu hình");
  assert.equal(hqNotConfigured.subtitleText, "Chưa cấu hình trụ sở tại thời điểm chấm công");
  assert.equal(hqNotConfigured.detailSectionTitle, "Khoảng cách tới trụ sở");

  // Both DistanceCell and AttendanceCheckinDetailBody use describeAttendanceCheckinDistanceTarget
  assert.match(managerSource, /describeAttendanceCheckinDistanceTarget\(item\)/);
});

test("Hotfix 4: resolveAttendanceEmployeeDisplayIdentity normalizes employee full names and prevents login_id from appearing as primary name", async () => {
  // Real full name is preserved (including single-word names stored in lowercase or title case)
  assert.equal(isAttendanceLoginOrCodeLike("Nguyễn Thị Huệ", "NV001", "huent.td"), false);
  assert.equal(isAttendanceLoginOrCodeLike("an", null, null), false);
  assert.equal(isAttendanceLoginOrCodeLike("nam", "NV099", "namnv.td"), false);
  assert.equal(isAttendanceLoginOrCodeLike("An", null, null), false);
  assert.equal(isAttendanceLoginOrCodeLike("Huệ", null, null), false);

  // If a single-word value exactly matches loginId or personnelCode, it is recognized as a login/code
  assert.equal(isAttendanceLoginOrCodeLike("nam", null, "nam"), true);
  assert.equal(isAttendanceLoginOrCodeLike("nam", "nam", null), true);

  assert.deepEqual(
    resolveAttendanceEmployeeDisplayIdentity({
      displayName: "nam",
      personnelCode: "NV099",
      loginId: "namnv.td",
    }),
    {
      displayName: "nam",
      personnelCode: "NV099",
      isMissingFullName: false,
    },
  );

  assert.deepEqual(
    resolveAttendanceEmployeeDisplayIdentity({
      displayName: "Nguyễn Thị Huệ",
      personnelCode: "NV001",
      loginId: "huent.td",
    }),
    {
      displayName: "Nguyễn Thị Huệ",
      personnelCode: "NV001",
      isMissingFullName: false,
    },
  );

  // Login ID like "anhhn.td" or "lannt.hrp" is detected as non-full-name and moved to secondary code when personnelCode is absent
  assert.equal(isAttendanceLoginOrCodeLike("anhhn.td", null, null), true);
  assert.equal(isAttendanceLoginOrCodeLike("user@company.vn", null, null), true);
  assert.equal(isAttendanceLoginOrCodeLike("NV_MAT_01", "NV_MAT_01", null), true);

  assert.deepEqual(
    resolveAttendanceEmployeeDisplayIdentity({
      displayName: "anhhn.td",
      personnelCode: null,
    }),
    {
      displayName: ATTENDANCE_MISSING_EMPLOYEE_NAME_LABEL,
      personnelCode: "anhhn.td",
      isMissingFullName: true,
    },
  );

  assert.deepEqual(
    resolveAttendanceEmployeeDisplayIdentity({
      displayName: "anhhn.td",
      personnelCode: "NV088",
      loginId: "anhhn.td",
    }),
    {
      displayName: ATTENDANCE_MISSING_EMPLOYEE_NAME_LABEL,
      personnelCode: "NV088",
      isMissingFullName: true,
    },
  );

  // Monthly Matrix Excel export also normalizes login-like display names
  const xlsxBytes = await buildAttendanceMonthlyMatrixXlsx({
    year_month: "2026-10",
    from_date: "2026-10-01",
    to_date: "2026-10-01",
    calendar_days: [
      {
        business_date: "2026-10-01",
        day_of_month: 1,
        day_of_week: 4,
        is_weekend: false,
      },
    ],
    items: [
      {
        app_user_id: EMPLOYEE_ID,
        employee_display_name: "anhhn.td",
        personnel_code: null,
        branch: null,
        summary: {
          checkin_day_count: 0,
          total_checkins: 0,
          approved_leave_day_count: 0,
          approved_leave_units: 0,
          no_checkin_without_leave_day_count: 1,
        },
        days: [],
      },
    ],
  });
  assert.ok(xlsxBytes.byteLength > 0);
});

test("Multi-Profile Slot Policies UI payload builders, assignment immediate effect guard (no future dates), and mixed-profile Excel export (2-slot, 5-slot, Default)", async () => {
  const CUSTOM_PROFILE_ID = "88888888-8888-4888-8888-888888888888";

  // 1. Create named profile payload with 2 slots
  const createProf = buildUpsertSlotPolicyProfilePayload({
    profileId: null,
    profileCode: "hanh_chinh",
    displayName: "Hành chính",
    description: "Khung giờ 2 mốc hành chính",
    active: true,
    expectedProfileVersion: 0,
    effectiveFromDate: "2026-10-01",
    slots: [
      { slotLabel: "Ca sáng", targetTime: "08:00", graceBeforeInput: "15", graceAfterInput: "15" },
      { slotLabel: "Ca chiều", targetTime: "17:00", graceBeforeInput: "15", graceAfterInput: "15" },
    ],
    expectedVersion: 0,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(createProf.ok, true);
  if (createProf.ok) {
    assert.equal(createProf.body.profile_code, "HANH_CHINH");
    assert.equal(createProf.body.display_name, "Hành chính");
    assert.equal(createProf.body.slots?.length, 2);
  }

  // 2. Assign employee to profile: immediate effect, blocks Default profile, Inactive profile, and Future dates
  const sampleProfile = {
    profile_id: CUSTOM_PROFILE_ID,
    profile_code: "HANH_CHINH",
    display_name: "Hành chính",
    description: null,
    is_default: false,
    active: true,
    version: 2,
    active_assignment_count: 0,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    latest_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    versions: [DEFAULT_ATTENDANCE_SLOT_POLICY],
  };

  const assignImmediate = buildAssignEmployeeToSlotPolicyPayload({
    appUserId: EMPLOYEE_ID,
    profile: sampleProfile,
    todayVn: "2026-10-25",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(assignImmediate.ok, true);
  if (assignImmediate.ok) {
    assert.equal(assignImmediate.body.valid_from, "2026-10-25");
    assert.equal(assignImmediate.body.expected_version, 0);
  }

  const assignSwitchExisting = buildAssignEmployeeToSlotPolicyPayload({
    appUserId: EMPLOYEE_ID,
    profile: sampleProfile,
    expectedVersion: 1,
    todayVn: "2026-10-25",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(assignSwitchExisting.ok, true);
  if (assignSwitchExisting.ok) {
    assert.equal(assignSwitchExisting.body.expected_version, 1);
  }

  // Future date (> todayVn) is rejected
  const assignFuture = buildAssignEmployeeToSlotPolicyPayload({
    appUserId: EMPLOYEE_ID,
    profile: sampleProfile,
    validFrom: "2026-10-26",
    todayVn: "2026-10-25",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(assignFuture.ok, false);

  // Past date (< todayVn) is rejected
  const assignPast = buildAssignEmployeeToSlotPolicyPayload({
    appUserId: EMPLOYEE_ID,
    profile: sampleProfile,
    validFrom: "2026-10-24",
    todayVn: "2026-10-25",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(assignPast.ok, false);

  // Default profile is rejected
  const assignDefault = buildAssignEmployeeToSlotPolicyPayload({
    appUserId: EMPLOYEE_ID,
    profile: { ...sampleProfile, is_default: true },
    todayVn: "2026-10-25",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(assignDefault.ok, false);

  // Unassign immediate effect and future/past date guard
  const unassignOk = buildUnassignEmployeeFromSlotPolicyPayload({
    todayVn: "2026-10-25",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(unassignOk.ok, true);
  if (unassignOk.ok) {
    assert.equal(unassignOk.body.valid_to, "2026-10-25");
  }

  const unassignFuture = buildUnassignEmployeeFromSlotPolicyPayload({
    validTo: "2026-10-26",
    todayVn: "2026-10-25",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(unassignFuture.ok, false);

  const unassignPast = buildUnassignEmployeeFromSlotPolicyPayload({
    validTo: "2026-10-24",
    todayVn: "2026-10-25",
    expectedVersion: 1,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(unassignPast.ok, false);

  // 3. Employee slot policy summary label & assignment status
  assert.equal(
    formatEmployeeSlotPolicySummaryLabel({
      slot_policy_profile: {
        profile_id: CUSTOM_PROFILE_ID,
        profile_code: "HANH_CHINH",
        display_name: "Hành chính",
        is_default: false,
        slot_count: 2,
      },
      days: [],
    }),
    "Hành chính",
  );
  assert.equal(
    describeSlotPolicyAssignmentStatus({
      effective: true,
      valid_from: "2026-10-05",
      valid_to: null,
      superseded_same_day: false,
    }).canUnassign,
    true,
  );

  // 4. Mixed-profile Excel workbook (2-slot employee + 5-slot Default employee in the same workbook)
  const ExcelJS = (await import("exceljs")).default;
  const twoSlotPolicy = {
    ...DEFAULT_ATTENDANCE_SLOT_POLICY,
    profile_id: CUSTOM_PROFILE_ID,
    profile_code: "HANH_CHINH",
    profile_name: "Hành chính",
    is_default: false,
    version: 1,
    slots: [
      {
        slot_code: "SLOT_1",
        slot_index: 1,
        slot_label: "Ca sáng",
        session_code: "AM",
        target_time: "08:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
      {
        slot_code: "SLOT_2",
        slot_index: 2,
        slot_label: "Ca chiều",
        session_code: "PM",
        target_time: "17:00",
        grace_before_minutes: 15,
        grace_after_minutes: 15,
      },
    ],
  };

  const eval2Slots = evaluateAttendanceDaySlots({
    policy: twoSlotPolicy,
    checkins: [
      {
        checkin_id: "c-hc-1",
        sequence_in_day: 1,
        captured_at: "2026-10-05T01:00:00Z",
        captured_at_local: "2026-10-05 08:00:00",
        time_local: "08:00",
        time_verified: true,
        distance_target_kind: "HQ",
        distance_status: "COMPUTED",
        distance_meters: 10,
      },
    ],
    approved_leaves: [],
  });
  const eval5Slots = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [],
  });

  const mixedXlsxBytes = await buildAttendanceMonthlyMatrixXlsx({
    year_month: "2026-10",
    from_date: "2026-10-05",
    to_date: "2026-10-05",
    calendar_days: [
      {
        business_date: "2026-10-05",
        day_of_month: 5,
        day_of_week: 1,
        is_weekend: false,
      },
    ],
    slot_policy: {
      current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
      month_policies: [DEFAULT_ATTENDANCE_SLOT_POLICY, twoSlotPolicy],
      profiles: [
        {
          profile_id: DEFAULT_ATTENDANCE_SLOT_POLICY.profile_id,
          profile_code: "DEFAULT",
          display_name: "Mặc định",
          description: null,
          is_default: true,
          active: true,
          version: 1,
          current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
          month_policies: [DEFAULT_ATTENDANCE_SLOT_POLICY],
        },
        {
          profile_id: CUSTOM_PROFILE_ID,
          profile_code: "HANH_CHINH",
          display_name: "Hành chính",
          description: "Khung giờ 2 mốc",
          is_default: false,
          active: true,
          version: 1,
          current_policy: twoSlotPolicy,
          month_policies: [twoSlotPolicy],
        },
      ],
    },
    items: [
      {
        app_user_id: EMPLOYEE_ID,
        employee_display_name: "Nguyễn Hành Chính",
        personnel_code: "NV_HC_01",
        branch: null,
        slot_policy_profile: {
          profile_id: CUSTOM_PROFILE_ID,
          profile_code: "HANH_CHINH",
          display_name: "Hành chính",
          is_default: false,
          slot_count: 2,
        },
        summary: {
          checkin_day_count: 1,
          total_checkins: 1,
          approved_leave_day_count: 0,
          approved_leave_units: 0,
          no_checkin_without_leave_day_count: 0,
        },
        days: [
          {
            business_date: "2026-10-05",
            day_of_month: 5,
            policy_profile_id_used: CUSTOM_PROFILE_ID,
            policy_profile_code_used: "HANH_CHINH",
            policy_profile_name_used: "Hành chính",
            policy_version_used: 1,
            has_checkin: true,
            checkin_count: 1,
            first_checkin_id: "c-hc-1",
            last_checkin_id: "c-hc-1",
            first_captured_at: "2026-10-05T01:00:00Z",
            first_captured_at_local: "2026-10-05 08:00:00",
            first_time_local: "08:00",
            last_captured_at: "2026-10-05T01:00:00Z",
            last_captured_at_local: "2026-10-05 08:00:00",
            last_time_local: "08:00",
            verified_checkin_count: 1,
            unverified_checkin_count: 0,
            distance_target_kind: "HQ",
            branch_id_used: null,
            branch_code_used: null,
            branch_name_used: null,
            branch_version_used: null,
            hq_version_used: 1,
            distance_status: "COMPUTED",
            distance_meters: 10,
            min_distance_meters: 10,
            max_distance_meters: 10,
            has_approved_leave: false,
            approved_leave_units: 0,
            approved_leaves: [],
            day_status: "CHECKED_IN",
            missing_slot_count: eval2Slots.missing_slot_count,
            late_or_early_checkin_count: eval2Slots.late_or_early_checkin_count,
            slots: eval2Slots.slots,
          },
        ],
      },
      {
        app_user_id: "77777777-7777-4777-8777-777777777777",
        employee_display_name: "Trần Mặc Định",
        personnel_code: "NV_MD_02",
        branch: null,
        slot_policy_profile: {
          profile_id: DEFAULT_ATTENDANCE_SLOT_POLICY.profile_id,
          profile_code: "DEFAULT",
          display_name: "Mặc định",
          is_default: true,
          slot_count: 5,
        },
        summary: {
          checkin_day_count: 0,
          total_checkins: 0,
          approved_leave_day_count: 0,
          approved_leave_units: 0,
          no_checkin_without_leave_day_count: 1,
        },
        days: [
          {
            business_date: "2026-10-05",
            day_of_month: 5,
            policy_profile_id_used: DEFAULT_ATTENDANCE_SLOT_POLICY.profile_id,
            policy_profile_code_used: "DEFAULT",
            policy_profile_name_used: "Mặc định",
            policy_version_used: 1,
            has_checkin: false,
            checkin_count: 0,
            first_checkin_id: null,
            last_checkin_id: null,
            first_captured_at: null,
            first_captured_at_local: null,
            first_time_local: null,
            last_captured_at: null,
            last_captured_at_local: null,
            last_time_local: null,
            verified_checkin_count: 0,
            unverified_checkin_count: 0,
            distance_target_kind: null,
            branch_id_used: null,
            branch_code_used: null,
            branch_name_used: null,
            branch_version_used: null,
            hq_version_used: null,
            distance_status: null,
            distance_meters: null,
            min_distance_meters: null,
            max_distance_meters: null,
            has_approved_leave: false,
            approved_leave_units: 0,
            approved_leaves: [],
            day_status: "NO_CHECKIN",
            missing_slot_count: eval5Slots.missing_slot_count,
            late_or_early_checkin_count: 0,
            slots: eval5Slots.slots,
          },
        ],
      },
    ],
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(mixedXlsxBytes);

  const matrixSheet = wb.getWorksheet("Ma trận chấm công");
  assert.ok(matrixSheet);
  // Row 2 = Nguyễn Hành Chính (2 slots), Row 3 = Trần Mặc Định (5 slots)
  assert.equal(matrixSheet.getRow(2).getCell(6).value, "Hành chính");
  assert.equal(matrixSheet.getRow(3).getCell(6).value, "Mặc định");
  assert.match(String(matrixSheet.getRow(2).getCell(12).value), /\[Khung giờ: Hành chính v1\]/);

  const detailSheet = wb.getWorksheet("Chi tiết theo ngày");
  assert.ok(detailSheet);
  // Row 2 = Nguyễn Hành Chính on 2026-10-05: has 2 slots; Mốc 3..5 (columns 10..12) are empty!
  assert.equal(detailSheet.getRow(2).getCell(6).value, "Hành chính (v1)");
  assert.equal(detailSheet.getRow(2).getCell(7).value, 2);
  assert.match(String(detailSheet.getRow(2).getCell(8).value), /Ca sáng \(08:00\): 08:00/);
  assert.match(String(detailSheet.getRow(2).getCell(9).value), /Ca chiều \(17:00\): Chưa có lượt chấm/);
  assert.equal(detailSheet.getRow(2).getCell(10).value, "");
  assert.equal(detailSheet.getRow(2).getCell(11).value, "");
  assert.equal(detailSheet.getRow(2).getCell(12).value, "");

  // Row 3 = Trần Mặc Định on 2026-10-05: has 5 slots; Mốc 1..5 all populated!
  assert.equal(detailSheet.getRow(3).getCell(6).value, "Mặc định (v1)");
  assert.equal(detailSheet.getRow(3).getCell(7).value, 5);
  assert.match(String(detailSheet.getRow(3).getCell(12).value), /Time 5 \(16:30\): Chưa có lượt chấm/);

  const legendSheet = wb.getWorksheet("Chú giải & Khung giờ");
  assert.ok(legendSheet);
});

test("Attendance Config Hotfix: dedicated 'Cấu hình chấm công' tab, slot policy assignment dropdown, streamlined check-in overview cards, collapsible monthly legend, and preserved check-in distance display", () => {
  // 1. Slot policy profile assignment dropdown & mount-time fetch
  assert.match(
    matrixPanelSource,
    /export function AttendanceSlotPolicySummaryCard\(/,
    "AttendanceSlotPolicySummaryCard should be exported for the dedicated configuration tab",
  );
  assert.match(
    matrixPanelSource,
    /useEffect\(\(\) => \{\s*const controller = new AbortController\(\);\s*void \(async \(\) => \{\s*try \{\s*const response = await fetch\("\/api\/admin\/attendance\/slot-policies"/,
    "AttendanceSlotPolicySummaryCard should fetch slot policies on mount",
  );
  assert.match(
    matrixPanelSource,
    /const assignableProfiles = useMemo\(\s*\(\) => availableProfiles\.filter\(\(prof\) => prof\.active && !prof\.is_default\),\s*\[availableProfiles\],\s*\);/,
    "Assignment dropdown should list active non-default named profiles",
  );
  assert.match(
    matrixPanelSource,
    /<select[\s\S]*?id="slot-policy-assign-profile"[\s\S]*?\{assignableProfiles\.map\(\(prof\) =>/,
    "slot-policy-assign-profile select should render assignableProfiles",
  );

  // 2. Separate 'Cấu hình chấm công' tab at the end of the tab row; no duplication in report tabs
  assert.match(
    managerSource,
    /id="attendance-tab-branches"[\s\S]*?Chi nhánh HRP[\s\S]*?<\/button>[\s\S]*?allowedTabs\.includes\("config"\)[\s\S]*?<button[\s\S]*?id="attendance-tab-config"[\s\S]*?aria-controls="attendance-panel-config"[\s\S]*?Cấu hình chấm công\s*<\/button>/,
    "'Cấu hình chấm công' tab must be at the end of the tab row after 'Chi nhánh HRP'",
  );
  assert.match(
    managerSource,
    /effectiveTab === "config" && allowedTabs\.includes\("config"\)\s*\?\s*\(\s*<div\s+id="attendance-panel-config"\s+role="tabpanel"\s+aria-labelledby="attendance-tab-config"[\s\S]*?title="Vị trí trụ sở tính khoảng cách"[\s\S]*?<AttendanceSlotPolicySummaryCard/,
    "Both Headquarters Location card and Slot Policy configuration card must render inside #attendance-panel-config",
  );
  const monthlyMatrixSectionSource =
    matrixPanelSource.split("export function AttendanceMonthlyMatrixSection()")[1] ?? "";
  assert.equal(
    monthlyMatrixSectionSource.includes("<AttendanceSlotPolicySummaryCard"),
    false,
    "AttendanceMonthlyMatrixSection ('Báo cáo tháng') must not repeat AttendanceSlotPolicySummaryCard",
  );
  assert.equal(
    explanationWorkspaceSource.includes("Vị trí trụ sở tính khoảng cách"),
    false,
    "Explanation workspace must not repeat Headquarters Location config",
  );
  assert.equal(
    explanationWorkspaceSource.includes("AttendanceSlotPolicySummaryCard"),
    false,
    "Explanation workspace must not repeat Slot Policy config",
  );

  // 3. Remove the 3 redundant KPI cards from 'Chi tiết lượt chấm công' overview while keeping remaining 3 cards, OffsetPager, and FloatingTableNav
  assert.equal(
    managerSource.includes("Khoảng cách trung bình tới trụ sở"),
    false,
    "Removed 'Khoảng cách trung bình tới trụ sở' card from check-in overview",
  );
  assert.equal(
    managerSource.includes("Khoảng cách xa nhất tới trụ sở"),
    false,
    "Removed 'Khoảng cách xa nhất tới trụ sở' card from check-in overview",
  );
  assert.equal(
    managerSource.includes("Phân trang máy chủ"),
    false,
    "Removed 'Phân trang máy chủ' card from check-in overview",
  );
  assert.equal(
    managerSource.includes("Tổng lượt chấm công") &&
      managerSource.includes("Xác minh thời gian") &&
      managerSource.includes("Độ phủ tính khoảng cách"),
    true,
    "Kept the 3 core overview cards in 'Chi tiết lượt chấm công'",
  );
  assert.match(
    managerSource,
    /<FloatingTableNav[\s\S]*?containerRef=\{checkinsTableContainerRef\}[\s\S]*?tableLabel="Chi tiết lượt chấm công"/,
    "Kept FloatingTableNav on the check-in detail table",
  );
  assert.match(
    managerSource,
    /<OffsetPager[\s\S]*?ariaLabel="Phân trang danh sách lượt chấm công"/,
    "Kept OffsetPager on the check-in detail table",
  );

  // 4. Collapsible color legend in 'Báo cáo tháng' with accessible button & aria attributes
  assert.match(
    monthlyMatrixSectionSource,
    /const \[legendExpanded, setLegendExpanded\] = useState\(false\);/,
    "Monthly matrix color legend state should be toggleable",
  );
  assert.match(
    monthlyMatrixSectionSource,
    /aria-expanded=\{legendExpanded\}\s+aria-controls="attendance-matrix-color-legend"[\s\S]*?\{legendExpanded \? "Thu gọn chú giải màu sắc" : "Mở chú giải màu sắc"\}/,
    "Monthly matrix color legend toggle button must expose aria-expanded, aria-controls, and clear label",
  );
  assert.match(
    monthlyMatrixSectionSource,
    /id="attendance-matrix-color-legend"\s+hidden=\{!legendExpanded\}/,
    "Monthly matrix color legend content container must match aria-controls id and toggle hidden state",
  );

  // 5. Preserve existing check-in location and distance display without nearest-location calculation
  assert.match(
    managerSource,
    /<GpsDetailCell item=\{item\} \/>[\s\S]*?<DistanceCell item=\{item\} \/>/,
    "Individual check-in rows preserve GpsDetailCell and DistanceCell display",
  );
});

test("Team Leader attendance workspace mode: restricts tabs to checkins and monthly-matrix, never renders or mounts explanations/branches/config, and fails closed to checkins", () => {
  const attendancePageSource = readFileSync(
    new URL("../../app/admin/attendance/page.tsx", import.meta.url),
    "utf8",
  );

  // 1. Server-derived workspace mode resolution
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
    }),
    "full",
  );
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["entry_privileged_edit"],
      scopes: [{ kind: "all" }],
    }),
    "full",
  );
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["report_analytics_view", "report_view"],
      scopes: [{ kind: "all" }],
    }),
    "full",
  );
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["team_manager_assign", "report_view", "report_analytics_view"],
      scopes: [{ kind: "team" }],
    }),
    "team-leader",
  );

  // 2. Allowed tabs per mode & fail-closed tab fallback
  assert.deepEqual(getAllowedAttendanceAdminWorkspaceTabs("full"), [
    "checkins",
    "monthly-matrix",
    "explanations",
    "branches",
    "config",
  ]);
  assert.deepEqual(FULL_ATTENDANCE_ADMIN_WORKSPACE_TABS, [
    "checkins",
    "monthly-matrix",
    "explanations",
    "branches",
    "config",
  ]);
  assert.deepEqual(getAllowedAttendanceAdminWorkspaceTabs("team-leader"), [
    "checkins",
    "monthly-matrix",
  ]);
  assert.deepEqual(TEAM_LEADER_ATTENDANCE_WORKSPACE_TABS, ["checkins", "monthly-matrix"]);

  assert.equal(resolveEffectiveAttendanceAdminWorkspaceTab("checkins", "team-leader"), "checkins");
  assert.equal(
    resolveEffectiveAttendanceAdminWorkspaceTab("monthly-matrix", "team-leader"),
    "monthly-matrix",
  );
  for (const forbiddenTab of ["explanations", "branches", "config"]) {
    assert.equal(
      resolveEffectiveAttendanceAdminWorkspaceTab(forbiddenTab, "team-leader"),
      "checkins",
      `forbidden tab ${forbiddenTab} must fall back to checkins in team-leader mode`,
    );
    assert.equal(
      resolveEffectiveAttendanceAdminWorkspaceTab(forbiddenTab, "full"),
      forbiddenTab,
      `tab ${forbiddenTab} remains allowed in full mode`,
    );
  }

  // 3. Page and manager wiring ensure unallowed tabs are neither rendered nor mounted
  assert.match(attendancePageSource, /resolveAttendanceAdminWorkspaceMode\(/);
  assert.match(
    attendancePageSource,
    /<AttendanceReportManager workspaceMode=\{workspaceMode\} \/>/,
  );
  assert.match(
    managerSource,
    /getAllowedAttendanceAdminWorkspaceTabs\(workspaceMode\)/,
  );
  assert.match(
    managerSource,
    /resolveEffectiveAttendanceAdminWorkspaceTab\(\s*activeTab,\s*workspaceMode/,
  );
  assert.match(
    managerSource,
    /effectiveTab === "explanations" && allowedTabs\.includes\("explanations"\)/,
  );
  assert.match(
    managerSource,
    /effectiveTab === "branches" && allowedTabs\.includes\("branches"\)/,
  );
  assert.match(
    managerSource,
    /effectiveTab === "config" && allowedTabs\.includes\("config"\)/,
  );
});

test("Compact /admin/attendance header & shared AttendanceVerificationBadge icon-with-tooltip across check-in and monthly matrix tables", () => {
  const verificationBadgeSource = readFileSync(
    new URL("../../components/attendance/attendance-verification-badge.tsx", import.meta.url),
    "utf8",
  );
  const adminNavSource = readFileSync(
    new URL("../admin/admin-navigation.ts", import.meta.url),
    "utf8",
  );

  // 1. /admin/attendance top header removes 'Báo cáo chấm công' h1 and description line while keeping Admin subnav tab and 'Làm mới' button
  assert.equal(/<h1[^>]*>[\s\S]*?Báo cáo chấm công[\s\S]*?<\/h1>/.test(managerSource), false);
  assert.equal(
    managerSource.includes("Tổng quan và chi tiết lượt chấm công theo ngày nghiệp vụ hệ thống"),
    false,
  );
  assert.match(adminNavSource, /label:\s*"Báo cáo chấm công"/);
  assert.match(adminNavSource, /href:\s*"\/admin\/attendance"/);
  assert.match(managerSource, /onClick=\{requestReload\}/);
  assert.match(managerSource, /\? "Đang tải\.\.\." : "Làm mới"/);
  assert.match(managerSource, /role="tablist"/);

  // 2. Single check-in verification indicator model (VERIFIED vs UNVERIFIED)
  assert.equal(ATTENDANCE_TIME_VERIFIED_HINT, "Đã xác minh (Mốc máy chủ)");
  assert.equal(ATTENDANCE_TIME_UNVERIFIED_HINT, "Chưa xác minh (Đồng hồ thiết bị)");
  assert.deepEqual(describeAttendanceTimeVerification(true), {
    kind: "VERIFIED",
    icon: "check",
    tone: "emerald",
    hint: "Đã xác minh (Mốc máy chủ)",
    ariaLabel: "Đã xác minh (Mốc máy chủ)",
  });
  assert.deepEqual(describeAttendanceTimeVerification(false), {
    kind: "UNVERIFIED",
    icon: "clock-warning",
    tone: "amber",
    hint: "Chưa xác minh (Đồng hồ thiết bị)",
    ariaLabel: "Chưa xác minh (Đồng hồ thiết bị)",
  });

  // 3. Monthly matrix day aggregate verification distinguishes ALL_VERIFIED, PARTIAL_VERIFIED, NONE_VERIFIED, and null when no check-in
  assert.equal(
    describeMatrixDayVerification({
      has_checkin: false,
      checkin_count: 0,
      verified_checkin_count: 0,
      unverified_checkin_count: 0,
    }),
    null,
  );

  const allVerified = describeMatrixDayVerification({
    has_checkin: true,
    checkin_count: 3,
    verified_checkin_count: 3,
    unverified_checkin_count: 0,
  });
  assert.deepEqual(allVerified, {
    kind: "ALL_VERIFIED",
    icon: "check",
    tone: "emerald",
    hint: "Tất cả lượt đã xác thực (3/3 lượt) — Đã xác minh (Mốc máy chủ)",
    ariaLabel: "Tất cả lượt đã xác thực (3/3 lượt) — Đã xác minh (Mốc máy chủ)",
    verifiedCount: 3,
    unverifiedCount: 0,
    totalCount: 3,
  });

  const partialVerified = describeMatrixDayVerification({
    has_checkin: true,
    checkin_count: 3,
    verified_checkin_count: 2,
    unverified_checkin_count: 1,
  });
  assert.deepEqual(partialVerified, {
    kind: "PARTIAL_VERIFIED",
    icon: "clock-warning",
    tone: "amber",
    hint: "Xác thực một phần (2/3 lượt): 2 lượt đã xác minh (Mốc máy chủ), 1 lượt chưa xác minh (Đồng hồ thiết bị)",
    ariaLabel:
      "Xác thực một phần (2/3 lượt): 2 lượt đã xác minh (Mốc máy chủ), 1 lượt chưa xác minh (Đồng hồ thiết bị)",
    verifiedCount: 2,
    unverifiedCount: 1,
    totalCount: 3,
  });

  const noneVerified = describeMatrixDayVerification({
    has_checkin: true,
    checkin_count: 2,
    verified_checkin_count: 0,
    unverified_checkin_count: 2,
  });
  assert.deepEqual(noneVerified, {
    kind: "NONE_VERIFIED",
    icon: "alert-warning",
    tone: "red",
    hint: "Chưa có lượt nào được xác thực (0/2 lượt): 2 lượt chưa xác minh (Đồng hồ thiết bị)",
    ariaLabel:
      "Chưa có lượt nào được xác thực (0/2 lượt): 2 lượt chưa xác minh (Đồng hồ thiết bị)",
    verifiedCount: 0,
    unverifiedCount: 2,
    totalCount: 2,
  });

  // 4. Shared AttendanceVerificationBadge component uses existing Radix Tooltip & Lucide icons (single hint via Tooltip without duplicate native title or uncontained sr-only) and preserves sync delay note
  const dataTableSource = readFileSync(
    new URL("../../components/ui/data-table.tsx", import.meta.url),
    "utf8",
  );
  assert.match(verificationBadgeSource, /from "lucide-react"/);
  assert.match(verificationBadgeSource, /from "radix-ui"/);
  assert.match(verificationBadgeSource, /Tooltip\.Provider/);
  assert.match(verificationBadgeSource, /Tooltip\.Trigger asChild/);
  assert.match(verificationBadgeSource, /Tooltip\.Content/);
  assert.match(verificationBadgeSource, /aria-label=\{indicator\.ariaLabel\}/);
  assert.equal(verificationBadgeSource.includes("title={indicator.hint}"), false);
  assert.equal(verificationBadgeSource.includes('className="sr-only"'), false);
  assert.match(dataTableSource, /relative overflow-hidden rounded-xl/);
  assert.match(dataTableSource, /relative overflow-x-auto/);

  assert.match(
    managerSource,
    /<th scope="col" className=\{cn\(DATA_TABLE_TH_CLASS, "text-center"\)\}>\s*Thời gian\s*<\/th>/,
  );
  assert.match(
    managerSource,
    /<td\s+data-label="Thời gian"\s+className=\{cn\(DATA_TABLE_TD_CLASS, "text-center"\)\}\s*>/,
  );

  const timeVerificationCellBlock =
    managerSource.match(/function TimeVerificationCell[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(
    timeVerificationCellBlock,
    /className="flex flex-col items-center justify-center gap-1 text-center"/,
  );
  assert.match(timeVerificationCellBlock, /<AttendanceVerificationBadge indicator=\{verification\} \/>/);
  assert.match(timeVerificationCellBlock, /formatSyncDelayNote\(item\.sync_delay_seconds\)/);

  const matrixDayCellBlock =
    matrixPanelSource.match(/function MatrixDayCell[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(
    matrixDayCellBlock,
    /<AttendanceVerificationBadge indicator=\{presentation\.verification\} \/>/,
  );
  assert.equal(matrixDayCellBlock.includes("{presentation.verificationLabel}"), false);
});

test("WP7B D-WP7B-01: resolveAttendanceAdminWorkspaceMode enforces paired @ ALL so DEPARTMENT_HEAD and dual-role HR_OPERATOR + TEAM_LEADER get read-only team-leader mode", () => {
  const DEPT_ID = "77000000-0000-4000-8000-000000000001";
  const TEAM_ID = "77000000-0000-4000-8000-000000000002";

  // 1. DEPARTMENT_HEAD -> "team-leader" (tabs ["checkins", "monthly-matrix"] only)
  const deptHeadMode = resolveAttendanceAdminWorkspaceMode({
    capabilities: ["report_view", "report_analytics_view"],
    scopes: [{ kind: "own" }],
    effective_grants: [
      { capability: "report_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  });
  assert.equal(deptHeadMode, "team-leader");
  assert.deepEqual(getAllowedAttendanceAdminWorkspaceTabs(deptHeadMode), ["checkins", "monthly-matrix"]);

  // 2. Dual-role HR_OPERATOR @ ALL + TEAM_LEADER @ CONTEXT_TEAM -> strictly "team-leader", never "full"
  const dualRoleMode = resolveAttendanceAdminWorkspaceMode({
    capabilities: [
      "recruiter_master_manage",
      "team_master_manage",
      "catalog_master_manage",
      "team_manager_assign",
      "report_view",
      "report_analytics_view",
    ],
    scopes: [{ kind: "all" }, { kind: "team" }],
    effective_grants: [
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_manager_assign", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_ID, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_ID, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_ID, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
  });
  assert.equal(dualRoleMode, "team-leader");

  // 3. Paired Full Admin & Paired BoD @ ALL -> "full"
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
      effective_grants: [
        { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    "full",
  );
  assert.equal(
    resolveAttendanceAdminWorkspaceMode({
      capabilities: ["report_view", "report_analytics_view"],
      scopes: [{ kind: "all" }],
      effective_grants: [
        { capability: "report_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "report_analytics_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    "full",
  );
});

test("WP7B D-WP7B-02: out-of-scope past UPCOMING cell presentation vs true future UPCOMING vs past EXPLAINED_APPROVED across UI model, MatrixDayCell, and XLSX export", async () => {
  assert.equal(MATRIX_OUT_OF_SCOPE_LABEL, "Ngoài phạm vi / Không áp dụng");
  assert.equal(getCurrentVnBusinessDate(new Date("2026-10-22T16:59:59.000Z")), "2026-10-22");
  assert.equal(getCurrentVnBusinessDate(new Date("2026-10-22T17:00:00.000Z")), "2026-10-23");

  const upcomingSlots = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [],
  }).slots.map((slot) => ({ ...slot, slot_status: "UPCOMING" }));

  const makeDayCell = (overrides) => ({
    business_date: "2026-10-10",
    day_of_month: 10,
    policy_version_used: 1,
    has_checkin: false,
    checkin_count: 0,
    first_checkin_id: null,
    last_checkin_id: null,
    first_captured_at: null,
    first_captured_at_local: null,
    first_time_local: null,
    last_captured_at: null,
    last_captured_at_local: null,
    last_time_local: null,
    verified_checkin_count: 0,
    unverified_checkin_count: 0,
    distance_target_kind: null,
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
    hq_version_used: null,
    distance_status: null,
    distance_meters: null,
    min_distance_meters: null,
    max_distance_meters: null,
    has_approved_leave: false,
    approved_leave_units: 0,
    approved_leaves: [],
    day_status: "UPCOMING",
    missing_slot_count: 0,
    late_or_early_checkin_count: 0,
    slots: upcomingSlots,
    ...overrides,
  });

  const pastOutOfScopeCell = makeDayCell({ business_date: "2026-10-10", day_of_month: 10 });
  const todayUpcomingCell = makeDayCell({ business_date: "2026-10-15", day_of_month: 15 });
  const futureUpcomingCell = makeDayCell({ business_date: "2026-10-20", day_of_month: 20 });

  const explainedApprovedEval = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [],
    explanations: [
      {
        explanation_id: "88000000-0000-4000-8000-000000000001",
        slot_code: "SLOT_1",
        status: "APPROVED",
        original_slot_status: "MISSING",
        reason: "Công tác khách hàng",
        decision_note: "Đã duyệt",
        submitted_at: "2026-10-11T02:00:00Z",
        decided_at: "2026-10-11T03:00:00Z",
      },
    ],
  });
  const pastExplainedApprovedCell = makeDayCell({
    business_date: "2026-10-11",
    day_of_month: 11,
    day_status: "NO_CHECKIN",
    missing_slot_count: explainedApprovedEval.missing_slot_count,
    slots: explainedApprovedEval.slots,
  });

  // 1. Omitted options preserves legacy behavior 100%
  const legacyPastUpcoming = describeMatrixDayCell(pastOutOfScopeCell);
  assert.equal(legacyPastUpcoming.isOutOfScopeOrExempt, false);
  assert.equal(legacyPastUpcoming.statusLabel, "Chưa đến giờ chấm");

  // 2. Past UPCOMING cell with todayBusinessDate="2026-10-15" -> out-of-scope presentation
  const outOfScopePres = describeMatrixDayCell(pastOutOfScopeCell, { todayBusinessDate: "2026-10-15" });
  assert.equal(outOfScopePres.isOutOfScopeOrExempt, true);
  assert.equal(outOfScopePres.statusLabel, MATRIX_OUT_OF_SCOPE_LABEL);
  assert.equal(outOfScopePres.tone, "sky");
  assert.equal(outOfScopePres.isRedHighlight, false);
  assert.ok(outOfScopePres.slots.length === 5);
  assert.ok(outOfScopePres.slots.every((s) => s.statusLabel === "—"));
  assert.ok(outOfScopePres.slots.every((s) => s.summaryText === MATRIX_OUT_OF_SCOPE_LABEL));
  assert.ok(outOfScopePres.slots.every((s) => s.isMissingHighlight === false));
  assert.equal(
    formatMatrixDayCellText(pastOutOfScopeCell, { todayBusinessDate: "2026-10-15" }),
    "— (Ngoài phạm vi)",
  );

  // 3. Today and true future UPCOMING cells remain "Chưa đến giờ chấm"
  for (const nonPastCell of [todayUpcomingCell, futureUpcomingCell]) {
    const pres = describeMatrixDayCell(nonPastCell, { todayBusinessDate: "2026-10-15" });
    assert.equal(pres.isOutOfScopeOrExempt, false);
    assert.equal(pres.statusLabel, "Chưa đến giờ chấm");
    assert.ok(pres.slots.every((s) => s.statusLabel === "Chưa đến giờ chấm"));
    assert.match(
      formatMatrixDayCellText(nonPastCell, { todayBusinessDate: "2026-10-15" }),
      /Chưa đến giờ chấm/,
    );
  }

  // 4. Past EXPLAINED_APPROVED cell is NEVER classified as out-of-scope
  const explainedPres = describeMatrixDayCell(pastExplainedApprovedCell, {
    todayBusinessDate: "2026-10-15",
  });
  assert.equal(explainedPres.isOutOfScopeOrExempt, false);
  assert.equal(explainedPres.slots[0].slotStatus, "EXPLAINED_APPROVED");
  assert.equal(explainedPres.slots[0].statusLabel, MATRIX_EXPLAINED_APPROVED_LABEL);
  assert.match(
    formatMatrixDayCellText(pastExplainedApprovedCell, { todayBusinessDate: "2026-10-15" }),
    /Giải trình được duyệt/,
  );

  // 5. XLSX workbook renders slate fill + "— (Ngoài phạm vi)" on Sheet 1 and statusLabel + "—" slots on Sheet 2
  const xlsxBytes = await buildAttendanceMonthlyMatrixXlsx(
    {
      year_month: "2026-10",
      from_date: "2026-10-10",
      to_date: "2026-10-20",
      calendar_days: [
        { business_date: "2026-10-10", day_of_month: 10, day_of_week: 6 },
        { business_date: "2026-10-11", day_of_month: 11, day_of_week: 7 },
        { business_date: "2026-10-20", day_of_month: 20, day_of_week: 2 },
      ],
      items: [
        {
          app_user_id: EMPLOYEE_ID,
          employee_display_name: "Nguyễn Văn A",
          personnel_code: "NV001",
          enabled: true,
          branch: null,
          summary: {
            checkin_day_count: 0,
            total_checkins: 0,
            approved_leave_day_count: 0,
            approved_leave_units: 0,
            checkin_and_leave_day_count: 0,
            no_checkin_day_count: 1,
            no_checkin_without_leave_day_count: 1,
            distance_computed_count: 0,
            distance_unavailable_count: 0,
            min_distance_meters: null,
            max_distance_meters: null,
          },
          days: [pastOutOfScopeCell, pastExplainedApprovedCell, futureUpcomingCell],
        },
      ],
    },
    { todayBusinessDate: "2026-10-15" },
  );

  const importedExcel = await import("exceljs");
  const excel = importedExcel.default ?? importedExcel;
  const wb = new excel.Workbook();
  await wb.xlsx.load(Buffer.from(xlsxBytes));

  const sheet1 = wb.getWorksheet("Ma trận chấm công");
  assert.ok(sheet1);
  // Base headers = 11 columns -> day 1 (2026-10-10) = col 12, day 2 (2026-10-11) = col 13, day 3 (2026-10-20) = col 14
  const row2 = sheet1.getRow(2);
  assert.equal(row2.getCell(12).value, "— (Ngoài phạm vi)");
  assert.equal(row2.getCell(12).fill?.fgColor?.argb, "FFF1F5F9");
  assert.match(String(row2.getCell(13).value), /Giải trình được duyệt/);
  assert.match(String(row2.getCell(14).value), /Chưa đến giờ chấm/);
  assert.equal(row2.getCell(14).fill?.fgColor?.argb, "FFF0F9FF");

  const sheet2 = wb.getWorksheet("Chi tiết theo ngày");
  assert.ok(sheet2);
  // Row 2 = 2026-10-10 (out-of-scope), Row 3 = 2026-10-11 (explained), Row 4 = 2026-10-20 (future)
  const detailOutOfScopeRow = sheet2.getRow(2);
  assert.equal(detailOutOfScopeRow.getCell(1).value, "2026-10-10");
  assert.equal(detailOutOfScopeRow.getCell(5).value, MATRIX_OUT_OF_SCOPE_LABEL);
  for (let slotCol = 8; slotCol <= 12; slotCol += 1) {
    assert.equal(detailOutOfScopeRow.getCell(slotCol).value, "—", `slot col ${slotCol}`);
  }
  const detailExplainedRow = sheet2.getRow(3);
  assert.equal(detailExplainedRow.getCell(1).value, "2026-10-11");
  assert.match(String(detailExplainedRow.getCell(8).value), /Giải trình được duyệt/);
  const detailFutureRow = sheet2.getRow(4);
  assert.equal(detailFutureRow.getCell(1).value, "2026-10-20");
  assert.equal(detailFutureRow.getCell(5).value, "Chưa đến giờ chấm");
  assert.match(String(detailFutureRow.getCell(8).value), /Chưa đến giờ chấm/);

  // 6. Past partial exit day (e.g. Person INACTIVE at 12:00 -> SLOT_1..2 MISSING, SLOT_3..5 UPCOMING)
  //    keeps day red/NO_CHECKIN with missingSlotCount=2 while past post-cutoff UPCOMING slots render
  //    MATRIX_OUT_OF_SCOPE_LABEL ("—") instead of "Chưa đến giờ chấm" in UI & XLSX!
  const partialExitSlots = evaluateAttendanceDaySlots({
    policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    checkins: [],
    approved_leaves: [],
  }).slots.map((slot, idx) => ({
    ...slot,
    slot_status: idx < 2 ? "MISSING" : "UPCOMING",
  }));
  const pastPartialExitCell = makeDayCell({
    business_date: "2026-10-10",
    day_of_month: 10,
    day_status: "NO_CHECKIN",
    missing_slot_count: 2,
    slots: partialExitSlots,
  });
  const partialExitPres = describeMatrixDayCell(pastPartialExitCell, {
    todayBusinessDate: "2026-10-15",
  });
  assert.equal(partialExitPres.isOutOfScopeOrExempt, false);
  assert.equal(partialExitPres.dayStatus, "NO_CHECKIN");
  assert.equal(partialExitPres.missingSlotCount, 2);
  assert.equal(partialExitPres.tone, "red");
  assert.equal(partialExitPres.isRedHighlight, true);
  assert.equal(partialExitPres.slots[0].slotStatus, "MISSING");
  assert.equal(partialExitPres.slots[0].isMissingHighlight, true);
  assert.equal(partialExitPres.slots[1].slotStatus, "MISSING");
  assert.equal(partialExitPres.slots[1].isMissingHighlight, true);
  for (let i = 2; i < 5; i += 1) {
    assert.equal(partialExitPres.slots[i].slotStatus, "UPCOMING");
    assert.equal(partialExitPres.slots[i].isMissingHighlight, false);
    assert.equal(partialExitPres.slots[i].statusLabel, "—");
    assert.equal(partialExitPres.slots[i].summaryText, MATRIX_OUT_OF_SCOPE_LABEL);
  }
  const partialExitText = formatMatrixDayCellText(pastPartialExitCell, {
    todayBusinessDate: "2026-10-15",
  });
  assert.match(partialExitText, /Time 1 \(07:30\): Chưa có lượt chấm/);
  assert.match(partialExitText, /Time 2 \(10:00\): Chưa có lượt chấm/);
  assert.match(partialExitText, /Time 3 \(13:00\): Ngoài phạm vi \/ Không áp dụng/);
  assert.equal(/Chưa đến giờ chấm/.test(partialExitText), false);

  // 7. MatrixDayCell UI component wires getCurrentVnBusinessDate() and compact muted slate pill
  const matrixDayCellBlock =
    matrixPanelSource.match(/function MatrixDayCell[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.match(matrixDayCellBlock, /todayBusinessDate:\s*getCurrentVnBusinessDate\(\)/);
  assert.match(matrixDayCellBlock, /if\s*\(presentation\.isOutOfScopeOrExempt\)/);
  assert.match(matrixDayCellBlock, /border-slate-200 bg-slate-50\/70/);
  assert.match(matrixDayCellBlock, /— Ngoài phạm vi/);
  assert.equal(MATRIX_LEGEND_ITEMS.length, 6);
});
