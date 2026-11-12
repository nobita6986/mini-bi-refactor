import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_SEARCH_LENGTH,
  isValidIsoCalendarDate,
  type AttendanceDistanceStatus,
} from "./attendance-report-contract.ts";
import {
  ATTENDANCE_EXPLANATION_DECISIONS,
  ATTENDANCE_EXPLANATION_MAX_DECISION_NOTE_LENGTH,
  ATTENDANCE_EXPLANATION_MAX_REASON_LENGTH,
  ATTENDANCE_EXPLANATION_MIN_REASON_LENGTH,
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT,
  ATTENDANCE_SLOT_CODES,
  ATTENDANCE_SLOT_MAX_COUNT,
  ATTENDANCE_SLOT_MAX_GRACE_MINUTES,
  ATTENDANCE_SLOT_MIN_COUNT,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME,
  SLOT_PROFILE_CODE_PATTERN,
  evaluateAttendanceDaySlots,
  isValidYearMonth,
  type AttendanceBranchAssignmentAdminItemProjection,
  type AttendanceCheckinDeviationStatus,
  type AttendanceDistanceTargetKind,
  type AttendanceExplanationDecision,
  type AttendanceExplanationStatus,
  type AttendanceMatrixLeaveSessionCode,
  type AttendanceMatrixLeaveType,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixDaySlotProjection,
  type AttendanceMonthlyMatrixDayStatus,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixSlotExplanationProjection,
  type AttendanceSlotCode,
  type AttendanceSlotPolicyAssignmentAdminItemProjection,
  type AttendanceSlotSessionCode,
  type AttendanceSlotStatus,
} from "./attendance-monthly-matrix-contract.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AttendanceAdminWorkspaceTab =
  | "checkins"
  | "monthly-matrix"
  | "explanations"
  | "branches"
  | "config";

export type AttendanceAdminWorkspaceMode = "full" | "team-leader";

export const FULL_ATTENDANCE_ADMIN_WORKSPACE_TABS: readonly AttendanceAdminWorkspaceTab[] = [
  "checkins",
  "monthly-matrix",
  "explanations",
  "branches",
  "config",
] as const;

export const TEAM_LEADER_ATTENDANCE_WORKSPACE_TABS: readonly AttendanceAdminWorkspaceTab[] = [
  "checkins",
  "monthly-matrix",
] as const;

export function resolveAttendanceAdminWorkspaceMode(
  actor:
    | {
        readonly capabilities: readonly string[];
        readonly scopes: readonly { readonly kind: string }[];
      }
    | null
    | undefined,
): AttendanceAdminWorkspaceMode {
  if (!actor) return "team-leader";
  const hasAllScope = actor.scopes.some((scope) => scope.kind === "all");
  const isFullAdmin =
    hasAllScope &&
    actor.capabilities.includes("entry_admin") &&
    actor.capabilities.includes("recruiter_master_manage") &&
    actor.capabilities.includes("team_master_manage");
  const isBod =
    hasAllScope &&
    (actor.capabilities.includes("entry_privileged_edit") ||
      (actor.capabilities.includes("report_analytics_view") &&
        actor.capabilities.includes("report_view")));
  return isFullAdmin || isBod ? "full" : "team-leader";
}

export function getAllowedAttendanceAdminWorkspaceTabs(
  mode: AttendanceAdminWorkspaceMode,
): readonly AttendanceAdminWorkspaceTab[] {
  return mode === "full"
    ? FULL_ATTENDANCE_ADMIN_WORKSPACE_TABS
    : TEAM_LEADER_ATTENDANCE_WORKSPACE_TABS;
}

export function resolveEffectiveAttendanceAdminWorkspaceTab(
  activeTab: AttendanceAdminWorkspaceTab | string | null | undefined,
  mode: AttendanceAdminWorkspaceMode,
): AttendanceAdminWorkspaceTab {
  const allowed = getAllowedAttendanceAdminWorkspaceTabs(mode);
  if (
    typeof activeTab === "string" &&
    (allowed as readonly string[]).includes(activeTab)
  ) {
    return activeTab as AttendanceAdminWorkspaceTab;
  }
  return "checkins";
}

export type MatrixEmployeeFilterMode = "employee" | "search";

export const MATRIX_MISSING_SLOT_LABEL = "Chưa có lượt chấm";
export const MATRIX_EXPLAINED_APPROVED_LABEL = "Giải trình được duyệt";
export const MATRIX_EXPLANATION_REJECTED_LABEL = "Giải trình bị từ chối";
export const MATRIX_EXPLANATION_PENDING_LABEL = "Chờ duyệt giải trình";

export const EXPLANATION_STATUS_LABELS: Readonly<
  Record<AttendanceExplanationStatus, string>
> = {
  PENDING: MATRIX_EXPLANATION_PENDING_LABEL,
  APPROVED: MATRIX_EXPLAINED_APPROVED_LABEL,
  REJECTED: MATRIX_EXPLANATION_REJECTED_LABEL,
};

export const EXPLANATION_APPROVER_SOURCE_LABELS: Readonly<Record<string, string>> = {
  TEAM_LEADER: "Trưởng nhóm trực tiếp",
  DEPARTMENT_HEAD: "Trưởng bộ phận / Phòng ban",
  ADMIN_BOD_DIRECT: "Ban Giám đốc / Admin",
  ADMIN_BOD_FALLBACK: "Admin / Ban Giám đốc (dự phòng)",
  TEAM_APPROVER: "Người duyệt theo nhóm/tuyến cấu hình",
  DEPARTMENT_APPROVER: "Người duyệt theo phòng ban",
  DIRECT_REPORT: "Quản lý trực tiếp",
  FALLBACK_ADMIN: "Admin nhân sự (dự phòng)",
  UNCONFIGURED: "Chưa cấu hình người duyệt",
};

export const MATRIX_WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
  7: "CN",
};

export const MATRIX_LEAVE_TYPE_LABELS: Readonly<Record<AttendanceMatrixLeaveType, string>> = {
  ANNUAL: "Phép năm",
  BEREAVEMENT: "Nghỉ tang",
  MARRIAGE: "Nghỉ cưới",
  SICK: "Nghỉ ốm",
  UNPAID: "Không lương",
  MATERNITY: "Thai sản",
};

export const MATRIX_LEAVE_SESSION_LABELS: Readonly<
  Record<AttendanceMatrixLeaveSessionCode, string>
> = {
  FULL: "Cả ngày",
  AM: "Sáng",
  PM: "Chiều",
};

export const MATRIX_SLOT_SHORT_LABELS: Readonly<Record<AttendanceSlotCode, string>> = {
  SLOT_1: "Time 1",
  SLOT_2: "Time 2",
  SLOT_3: "Time 3",
  SLOT_4: "Time 4",
  SLOT_5: "Time 5",
  SLOT_6: "Time 6",
  SLOT_7: "Time 7",
  SLOT_8: "Time 8",
  SLOT_9: "Time 9",
  SLOT_10: "Time 10",
  SLOT_11: "Time 11",
  SLOT_12: "Time 12",
};

export const MATRIX_DAY_STATUS_LABELS: Readonly<Record<AttendanceMonthlyMatrixDayStatus, string>> =
  {
    CHECKED_IN: "Có check-in",
    APPROVED_LEAVE: "Nghỉ phép đã duyệt",
    CHECKED_IN_AND_LEAVE: "Có check-in & Nghỉ phép",
    NO_CHECKIN: MATRIX_MISSING_SLOT_LABEL,
    UPCOMING: "Chưa đến giờ chấm",
  };

export type MatrixDayCellTone = "emerald" | "red" | "amber" | "sky";

export type MatrixSlotTone = "emerald" | "amber" | "sky" | "red";

export const ATTENDANCE_TIME_VERIFIED_HINT = "Đã xác minh (Mốc máy chủ)";
export const ATTENDANCE_TIME_UNVERIFIED_HINT = "Chưa xác minh (Đồng hồ thiết bị)";

export type AttendanceVerificationVisualKind =
  | "VERIFIED"
  | "UNVERIFIED"
  | "ALL_VERIFIED"
  | "PARTIAL_VERIFIED"
  | "NONE_VERIFIED";

export type AttendanceVerificationIconKind =
  | "check"
  | "clock-warning"
  | "alert-warning";

export type AttendanceVerificationTone = "emerald" | "amber" | "red";

export type AttendanceVerificationIndicatorView = {
  kind: AttendanceVerificationVisualKind;
  icon: AttendanceVerificationIconKind;
  tone: AttendanceVerificationTone;
  hint: string;
  ariaLabel: string;
  verifiedCount?: number;
  unverifiedCount?: number;
  totalCount?: number;
};

export function describeAttendanceTimeVerification(
  timeVerified: boolean,
): AttendanceVerificationIndicatorView {
  if (timeVerified) {
    return {
      kind: "VERIFIED",
      icon: "check",
      tone: "emerald",
      hint: ATTENDANCE_TIME_VERIFIED_HINT,
      ariaLabel: ATTENDANCE_TIME_VERIFIED_HINT,
    };
  }
  return {
    kind: "UNVERIFIED",
    icon: "clock-warning",
    tone: "amber",
    hint: ATTENDANCE_TIME_UNVERIFIED_HINT,
    ariaLabel: ATTENDANCE_TIME_UNVERIFIED_HINT,
  };
}

export function describeMatrixDayVerification(
  cell: Pick<
    AttendanceMonthlyMatrixDayCellProjection,
    "has_checkin" | "checkin_count" | "verified_checkin_count" | "unverified_checkin_count"
  >,
): AttendanceVerificationIndicatorView | null {
  if (!cell.has_checkin || cell.checkin_count <= 0) {
    return null;
  }
  const totalCount = cell.checkin_count;
  const verifiedCount = cell.verified_checkin_count;
  const unverifiedCount = cell.unverified_checkin_count;

  if (unverifiedCount === 0 && verifiedCount > 0) {
    const hint = `Tất cả lượt đã xác thực (${verifiedCount}/${totalCount} lượt) — ${ATTENDANCE_TIME_VERIFIED_HINT}`;
    return {
      kind: "ALL_VERIFIED",
      icon: "check",
      tone: "emerald",
      hint,
      ariaLabel: hint,
      verifiedCount,
      unverifiedCount,
      totalCount,
    };
  }

  if (verifiedCount > 0 && unverifiedCount > 0) {
    const hint = `Xác thực một phần (${verifiedCount}/${totalCount} lượt): ${verifiedCount} lượt đã xác minh (Mốc máy chủ), ${unverifiedCount} lượt chưa xác minh (Đồng hồ thiết bị)`;
    return {
      kind: "PARTIAL_VERIFIED",
      icon: "clock-warning",
      tone: "amber",
      hint,
      ariaLabel: hint,
      verifiedCount,
      unverifiedCount,
      totalCount,
    };
  }

  const effectiveUnverified = unverifiedCount > 0 ? unverifiedCount : totalCount;
  const hint = `Chưa có lượt nào được xác thực (0/${totalCount} lượt): ${effectiveUnverified} lượt chưa xác minh (Đồng hồ thiết bị)`;
  return {
    kind: "NONE_VERIFIED",
    icon: "alert-warning",
    tone: "red",
    hint,
    ariaLabel: hint,
    verifiedCount: 0,
    unverifiedCount: effectiveUnverified,
    totalCount,
  };
}

export type MatrixLeaveBadgeView = {
  requestId: string;
  leaveType: AttendanceMatrixLeaveType;
  leaveTypeLabel: string;
  sessionCode: AttendanceMatrixLeaveSessionCode;
  sessionLabel: string;
  halfDayUnits: number;
  label: string;
};

export type MatrixSlotCheckinPresentation = {
  checkinId: string;
  sequenceInDay: number;
  timeLocal: string;
  timeVerified: boolean;
  deviationStatus: AttendanceCheckinDeviationStatus;
  deltaMinutes: number;
  overGraceMinutes: number;
  deviationBadgeLabel: string | null;
  displayText: string;
};

export type MatrixSlotPresentation = {
  slotCode: AttendanceSlotCode;
  slotIndex: number;
  sessionCode: AttendanceSlotSessionCode;
  slotLabel: string;
  slotShortLabel: string;
  slotTitle: string;
  targetTime: string;
  graceBeforeMinutes: number;
  graceAfterMinutes: number;
  isLeaveCovered: boolean;
  slotStatus: AttendanceSlotStatus;
  statusLabel: string;
  tone: MatrixSlotTone;
  isMissingHighlight: boolean;
  isOutOfGraceHighlight: boolean;
  checkins: MatrixSlotCheckinPresentation[];
  explanation: AttendanceMonthlyMatrixSlotExplanationProjection | null;
  explanationStatusLabel: string | null;
  explanationBadgeTone: "emerald" | "amber" | "red" | null;
  summaryText: string;
};

export type MatrixDayCellPresentation = {
  dayStatus: AttendanceMonthlyMatrixDayStatus;
  statusLabel: string;
  tone: MatrixDayCellTone;
  isRedHighlight: boolean;
  policyProfileIdUsed: string;
  policyProfileCodeUsed: string;
  policyProfileNameUsed: string;
  policyVersionUsed: number;
  policyBadgeLabel: string;
  hasCheckin: boolean;
  checkinCount: number;
  missingSlotCount: number;
  lateOrEarlyCheckinCount: number;
  timeRangeLabel: string | null;
  verification: AttendanceVerificationIndicatorView | null;
  verificationLabel: string | null;
  distanceLabel: string | null;
  targetBadgeLabel: string | null;
  hasApprovedLeave: boolean;
  approvedLeaveUnits: number;
  leaveBadges: MatrixLeaveBadgeView[];
  slots: MatrixSlotPresentation[];
};

export type MatrixLegendItem = {
  key: string;
  tone: MatrixSlotTone;
  badgeText: string;
  title: string;
  description: string;
};

export const MATRIX_LEGEND_ITEMS: readonly MatrixLegendItem[] = [
  {
    key: "on-time",
    tone: "emerald",
    badgeText: "Đúng khung giờ",
    title: "Có lượt chấm trong phạm vi dung sai",
    description:
      "Lượt chấm được gán về mốc gần nhất và nằm trong khoảng dung sai cho phép trước/sau giờ mục tiêu (bao gồm đúng biên dung sai).",
  },
  {
    key: "out-of-grace",
    tone: "amber",
    badgeText: "Sớm Xp / Muộn Xp",
    title: "Có lượt chấm nhưng lệch ngoài dung sai",
    description:
      "Lượt chấm vẫn thuộc mốc gần nhất và hiển thị kèm cảnh báo số phút sớm hoặc muộn so với giờ chuẩn của mốc đó để HR rà soát.",
  },
  {
    key: "leave-covered",
    tone: "sky",
    badgeText: "Nghỉ phép đã duyệt",
    title: "Mốc thuộc buổi/ngày có đơn nghỉ phép đã duyệt",
    description:
      "Đơn nghỉ phép Cả ngày bao phủ toàn bộ các mốc trong ngày; nghỉ buổi Sáng bao phủ các mốc buổi sáng (< 12:00); nghỉ buổi Chiều bao phủ các mốc buổi chiều (>= 12:00) (không đánh dấu thiếu lượt chấm).",
  },
  {
    key: "explained-approved",
    tone: "emerald",
    badgeText: MATRIX_EXPLAINED_APPROVED_LABEL,
    title: "Mốc có giải trình chấm công đã được duyệt",
    description:
      "Nhân viên đã gửi giải trình cho mốc thiếu chấm công hoặc lệch dung sai và được cấp có thẩm quyền phê duyệt (không tạo lượt check-in giả, không sửa dữ liệu gốc).",
  },
  {
    key: "explanation-rejected",
    tone: "red",
    badgeText: MATRIX_EXPLANATION_REJECTED_LABEL,
    title: "Mốc có giải trình bị từ chối",
    description:
      "Mốc giữ nguyên trạng thái thiếu chấm công hoặc lệch khung giờ ban đầu và hiển thị rõ nhãn Giải trình bị từ chối.",
  },
  {
    key: "missing-slot",
    tone: "red",
    badgeText: MATRIX_MISSING_SLOT_LABEL,
    title: "Mốc chưa có lượt chấm & không có phép duyệt",
    description:
      "Tô nổi bật để HR HRP đối chiếu nghĩa vụ chấm công thực tế của từng nhân sự; đây là tín hiệu rà soát, không tự động kết luận vắng không phép.",
  },
] as const;

export function getVietnamCurrentYearMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export function getVietnamTodayIsoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Builds a Google Maps search URL when both latitude and longitude are valid finite numbers.
 * Returns null if either coordinate is missing, NaN, or infinite.
 */
export function buildGoogleMapsCoordinatesUrl(
  latitude: unknown,
  longitude: unknown,
): string | null {
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  const normalizedLat = Object.is(latitude, -0) ? 0 : latitude;
  const normalizedLon = Object.is(longitude, -0) ? 0 : longitude;
  return `https://www.google.com/maps/search/?api=1&query=${normalizedLat},${normalizedLon}`;
}

/**
 * Enforces mutual exclusion between employee_id and search.
 * Never sends both employee_id and search at the same time.
 */
export function resolveMutualExclusiveEmployeeOrSearch(input: {
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
}): { employeeId: string | null; search: string | null } {
  const trimmedEmployeeId = typeof input.employeeId === "string" ? input.employeeId.trim() : "";
  const trimmedSearch = typeof input.search === "string" ? input.search.trim() : "";

  if (input.filterMode === "employee") {
    return {
      employeeId: trimmedEmployeeId.length > 0 ? trimmedEmployeeId : null,
      search: null,
    };
  }
  if (input.filterMode === "search") {
    return {
      employeeId: null,
      search: trimmedSearch.length > 0 ? trimmedSearch : null,
    };
  }
  if (trimmedEmployeeId.length > 0) {
    return { employeeId: trimmedEmployeeId, search: null };
  }
  if (trimmedSearch.length > 0) {
    return { employeeId: null, search: trimmedSearch };
  }
  return { employeeId: null, search: null };
}

export function buildMonthlyMatrixReportQuery(input: {
  yearMonth: string;
  branchId?: string | null;
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}): string {
  const params = new URLSearchParams();
  const trimmedMonth = input.yearMonth.trim();
  if (trimmedMonth.length > 0) {
    params.set("year_month", trimmedMonth);
  }
  const trimmedBranch = typeof input.branchId === "string" ? input.branchId.trim() : "";
  if (trimmedBranch.length > 0) {
    params.set("branch_id", trimmedBranch);
  }

  const { employeeId, search } = resolveMutualExclusiveEmployeeOrSearch(input);
  if (employeeId !== null) {
    params.set("employee_id", employeeId);
  } else if (search !== null) {
    params.set("search", search);
  }

  const safePage =
    typeof input.page === "number" && Number.isSafeInteger(input.page) && input.page >= 1
      ? input.page
      : 1;
  const safePageSize =
    typeof input.pageSize === "number" &&
    Number.isSafeInteger(input.pageSize) &&
    input.pageSize >= 1
      ? input.pageSize
      : ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE;

  params.set("page", String(safePage));
  params.set("page_size", String(safePageSize));
  return params.toString();
}

export function buildMonthlyMatrixExportUrl(input: {
  yearMonth: string;
  branchId?: string | null;
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
}): string {
  const params = new URLSearchParams();
  const trimmedMonth = input.yearMonth.trim();
  if (trimmedMonth.length > 0) {
    params.set("year_month", trimmedMonth);
  }
  const trimmedBranch = typeof input.branchId === "string" ? input.branchId.trim() : "";
  if (trimmedBranch.length > 0) {
    params.set("branch_id", trimmedBranch);
  }

  const { employeeId, search } = resolveMutualExclusiveEmployeeOrSearch(input);
  if (employeeId !== null) {
    params.set("employee_id", employeeId);
  } else if (search !== null) {
    params.set("search", search);
  }

  const query = params.toString();
  return query.length > 0
    ? `/api/admin/attendance/monthly-matrix/export?${query}`
    : "/api/admin/attendance/monthly-matrix/export";
}

export function formatMatrixWeekdayLabel(dayOfWeek: number): string {
  return MATRIX_WEEKDAY_LABELS[dayOfWeek] ?? `T${dayOfWeek}`;
}

export function formatMatrixDistanceTargetLabel(
  kind: AttendanceDistanceTargetKind | null,
  branchCodeUsed: string | null,
): string | null {
  if (kind === "BRANCH") {
    return branchCodeUsed ? `CN: ${branchCodeUsed}` : "Chi nhánh";
  }
  if (kind === "HQ") {
    return "HQ";
  }
  return null;
}

export function formatMatrixDistanceStatusLabel(
  status: AttendanceDistanceStatus | null,
  distanceMeters: number | null,
  targetKind: AttendanceDistanceTargetKind | null,
  branchCodeUsed: string | null,
): string | null {
  if (!status) return null;
  const prefix = formatMatrixDistanceTargetLabel(targetKind, branchCodeUsed);
  const withPrefix = (detail: string) => (prefix ? `${prefix} · ${detail}` : detail);

  if (status === "COMPUTED" && typeof distanceMeters === "number" && Number.isFinite(distanceMeters)) {
    const distanceText =
      distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(2)} km`
        : `${Math.round(distanceMeters)} m`;
    return withPrefix(distanceText);
  }
  if (status === "BRANCH_NOT_CONFIGURED") {
    return withPrefix("Chi nhánh chưa cấu hình tọa độ");
  }
  if (status === "HQ_NOT_CONFIGURED") {
    return withPrefix("HQ chưa cấu hình tọa độ");
  }
  if (status === "INVALID_GPS") {
    return withPrefix("GPS không hợp lệ");
  }
  return null;
}

export function formatCheckinDeviationBadgeLabel(
  deviationStatus: AttendanceCheckinDeviationStatus,
  deltaMinutes: number,
): string | null {
  const absDelta = Math.abs(Math.trunc(deltaMinutes));
  if (deviationStatus === "EARLY" && absDelta > 0) {
    return `Sớm ${absDelta}p`;
  }
  if (deviationStatus === "LATE" && absDelta > 0) {
    return `Muộn ${absDelta}p`;
  }
  return null;
}

function resolveSessionLeaveCoverageLabel(
  sessionCode: AttendanceSlotSessionCode,
  leaveBadges: readonly MatrixLeaveBadgeView[],
): string {
  const matching = leaveBadges.filter(
    (badge) => badge.sessionCode === "FULL" || badge.sessionCode === sessionCode,
  );
  if (matching.length === 0) {
    return "Nghỉ phép đã duyệt";
  }
  return `Nghỉ phép: ${matching.map((item) => item.label).join(", ")}`;
}

function resolveRawDaySlots(
  cell: AttendanceMonthlyMatrixDayCellProjection,
): {
  policyProfileIdUsed: string;
  policyProfileCodeUsed: string;
  policyProfileNameUsed: string;
  policyVersionUsed: number;
  missingSlotCount: number;
  lateOrEarlyCheckinCount: number;
  slots: AttendanceMonthlyMatrixDaySlotProjection[];
} {
  const policyProfileIdUsed =
    typeof cell.policy_profile_id_used === "string" && cell.policy_profile_id_used.trim().length > 0
      ? cell.policy_profile_id_used.trim().toLowerCase()
      : DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID;
  const policyProfileCodeUsed =
    typeof cell.policy_profile_code_used === "string" &&
    cell.policy_profile_code_used.trim().length > 0
      ? cell.policy_profile_code_used.trim()
      : DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE;
  const policyProfileNameUsed =
    typeof cell.policy_profile_name_used === "string" &&
    cell.policy_profile_name_used.trim().length > 0
      ? cell.policy_profile_name_used.trim()
      : DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME;

  if (
    Array.isArray(cell.slots) &&
    cell.slots.length >= ATTENDANCE_SLOT_MIN_COUNT &&
    cell.slots.length <= ATTENDANCE_SLOT_MAX_COUNT
  ) {
    return {
      policyProfileIdUsed,
      policyProfileCodeUsed,
      policyProfileNameUsed,
      policyVersionUsed:
        typeof cell.policy_version_used === "number" && cell.policy_version_used >= 1
          ? cell.policy_version_used
          : 1,
      missingSlotCount:
        typeof cell.missing_slot_count === "number"
          ? cell.missing_slot_count
          : cell.slots.filter((s) => s.slot_status === "MISSING").length,
      lateOrEarlyCheckinCount:
        typeof cell.late_or_early_checkin_count === "number"
          ? cell.late_or_early_checkin_count
          : cell.slots.reduce(
              (acc, s) =>
                acc + s.checkins.filter((c) => c.deviation_status !== "ON_TIME").length,
              0,
            ),
      slots: cell.slots,
    };
  }

  const synthesizedCheckins: {
    checkin_id: string;
    sequence_in_day: number;
    captured_at: string;
    captured_at_local: string;
    time_local: string;
    time_verified: boolean;
    distance_target_kind: AttendanceDistanceTargetKind | null;
    distance_status: AttendanceDistanceStatus | null;
    distance_meters: number | null;
  }[] = [];

  if (
    cell.has_checkin &&
    cell.first_checkin_id &&
    cell.first_captured_at &&
    cell.first_captured_at_local &&
    cell.first_time_local
  ) {
    synthesizedCheckins.push({
      checkin_id: cell.first_checkin_id,
      sequence_in_day: 1,
      captured_at: cell.first_captured_at,
      captured_at_local: cell.first_captured_at_local,
      time_local: cell.first_time_local,
      time_verified: cell.unverified_checkin_count === 0,
      distance_target_kind: cell.distance_target_kind,
      distance_status: cell.distance_status,
      distance_meters: cell.distance_meters,
    });
    if (
      cell.checkin_count > 1 &&
      cell.last_checkin_id &&
      cell.last_checkin_id.toLowerCase() !== cell.first_checkin_id.toLowerCase() &&
      cell.last_captured_at &&
      cell.last_captured_at_local &&
      cell.last_time_local
    ) {
      synthesizedCheckins.push({
        checkin_id: cell.last_checkin_id,
        sequence_in_day: cell.checkin_count,
        captured_at: cell.last_captured_at,
        captured_at_local: cell.last_captured_at_local,
        time_local: cell.last_time_local,
        time_verified: cell.unverified_checkin_count === 0,
        distance_target_kind: cell.distance_target_kind,
        distance_status: cell.distance_status,
        distance_meters: cell.max_distance_meters,
      });
    }
  }

  const evaluated = evaluateAttendanceDaySlots({
    checkins: synthesizedCheckins,
    approved_leaves: cell.approved_leaves,
  });

  return {
    policyProfileIdUsed,
    policyProfileCodeUsed,
    policyProfileNameUsed,
    policyVersionUsed: evaluated.policy_version_used,
    missingSlotCount: evaluated.missing_slot_count,
    lateOrEarlyCheckinCount: evaluated.late_or_early_checkin_count,
    slots: evaluated.slots,
  };
}

export function formatEmployeeSlotPolicySummaryLabel(
  employee: Pick<
    AttendanceMonthlyMatrixEmployeeRowProjection,
    "slot_policy_profile" | "days"
  >,
): string {
  const profileNamesInMonth = employee.slot_policy_profile?.profile_names_in_month ?? [];
  if (profileNamesInMonth.length > 1) {
    return profileNamesInMonth.join(" → ");
  }
  if (
    typeof employee.slot_policy_profile?.display_name === "string" &&
    employee.slot_policy_profile.display_name.trim().length > 0
  ) {
    return employee.slot_policy_profile.display_name.trim();
  }
  const distinctDayNames: string[] = [];
  for (const day of employee.days ?? []) {
    const name =
      typeof day.policy_profile_name_used === "string" && day.policy_profile_name_used.trim().length > 0
        ? day.policy_profile_name_used.trim()
        : null;
    if (name && !distinctDayNames.includes(name)) {
      distinctDayNames.push(name);
    }
  }
  if (distinctDayNames.length > 1) {
    return distinctDayNames.join(" → ");
  }
  if (distinctDayNames.length === 1) {
    return distinctDayNames[0]!;
  }
  return DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME;
}

export function describeMatrixDayCell(
  cell: AttendanceMonthlyMatrixDayCellProjection,
): MatrixDayCellPresentation {
  const statusLabel = MATRIX_DAY_STATUS_LABELS[cell.day_status];

  const leaveBadges: MatrixLeaveBadgeView[] = cell.approved_leaves.map((item) => {
    const leaveTypeLabel = MATRIX_LEAVE_TYPE_LABELS[item.leave_type] ?? item.leave_type;
    const sessionLabel = MATRIX_LEAVE_SESSION_LABELS[item.session_code] ?? item.session_code;
    return {
      requestId: item.request_id,
      leaveType: item.leave_type,
      leaveTypeLabel,
      sessionCode: item.session_code,
      sessionLabel,
      halfDayUnits: item.half_day_units,
      label: `${leaveTypeLabel} (${sessionLabel})`,
    };
  });

  const resolvedSlots = resolveRawDaySlots(cell);

  const slots: MatrixSlotPresentation[] = resolvedSlots.slots.map((slot) => {
    const rawSlotLabel = typeof slot.slot_label === "string" ? slot.slot_label.trim() : "";
    const slotShortLabel =
      rawSlotLabel.length > 0
        ? rawSlotLabel
        : (MATRIX_SLOT_SHORT_LABELS[slot.slot_code] ?? `Time ${slot.slot_index}`);
    const slotTitle = `${slotShortLabel} (${slot.target_time})`;

    const checkins: MatrixSlotCheckinPresentation[] = slot.checkins.map((item) => {
      const deviationBadgeLabel = formatCheckinDeviationBadgeLabel(
        item.deviation_status,
        item.delta_minutes,
      );
      const displayText = deviationBadgeLabel
        ? `${item.time_local} (${deviationBadgeLabel})`
        : item.time_local;
      return {
        checkinId: item.checkin_id,
        sequenceInDay: item.sequence_in_day,
        timeLocal: item.time_local,
        timeVerified: item.time_verified,
        deviationStatus: item.deviation_status,
        deltaMinutes: item.delta_minutes,
        overGraceMinutes: item.over_grace_minutes,
        deviationBadgeLabel,
        displayText,
      };
    });

    let tone: MatrixSlotTone;
    let slotStatusLabel: string;
    let summaryText: string;
    const explanation = slot.explanation ?? null;
    let explanationStatusLabel: string | null = null;
    let explanationBadgeTone: "emerald" | "amber" | "red" | null = null;

    if (slot.slot_status === "EXPLAINED_APPROVED") {
      tone = "emerald";
      slotStatusLabel = MATRIX_EXPLAINED_APPROVED_LABEL;
      explanationStatusLabel = MATRIX_EXPLAINED_APPROVED_LABEL;
      explanationBadgeTone = "emerald";
      summaryText =
        checkins.length > 0
          ? `${checkins.map((c) => c.displayText).join(", ")} · ${MATRIX_EXPLAINED_APPROVED_LABEL}`
          : MATRIX_EXPLAINED_APPROVED_LABEL;
    } else if (slot.slot_status === "ON_TIME") {
      tone = "emerald";
      slotStatusLabel = "Đúng khung giờ";
      summaryText = checkins.map((c) => c.displayText).join(", ");
    } else if (slot.slot_status === "OUT_OF_GRACE") {
      tone = "amber";
      slotStatusLabel = "Lệch khung giờ";
      summaryText = checkins.map((c) => c.displayText).join(", ");
    } else if (slot.slot_status === "LEAVE_COVERED") {
      tone = "sky";
      slotStatusLabel = resolveSessionLeaveCoverageLabel(slot.session_code, leaveBadges);
      summaryText = slotStatusLabel;
    } else if (slot.slot_status === "UPCOMING") {
      tone = "sky";
      slotStatusLabel = "Chưa đến giờ chấm";
      summaryText = slotStatusLabel;
    } else {
      tone = "red";
      slotStatusLabel = MATRIX_MISSING_SLOT_LABEL;
      summaryText = MATRIX_MISSING_SLOT_LABEL;
    }

    if (slot.slot_status !== "EXPLAINED_APPROVED" && explanation) {
      if (explanation.status === "REJECTED") {
        explanationStatusLabel = MATRIX_EXPLANATION_REJECTED_LABEL;
        explanationBadgeTone = "red";
        summaryText = `${summaryText} · ${MATRIX_EXPLANATION_REJECTED_LABEL}`;
      } else if (explanation.status === "PENDING") {
        explanationStatusLabel = MATRIX_EXPLANATION_PENDING_LABEL;
        explanationBadgeTone = "amber";
        summaryText = `${summaryText} · ${MATRIX_EXPLANATION_PENDING_LABEL}`;
      } else if (explanation.status === "APPROVED") {
        explanationStatusLabel = MATRIX_EXPLAINED_APPROVED_LABEL;
        explanationBadgeTone = "emerald";
        summaryText = `${summaryText} · ${MATRIX_EXPLAINED_APPROVED_LABEL}`;
      }
    }

    return {
      slotCode: slot.slot_code,
      slotIndex: slot.slot_index,
      sessionCode: slot.session_code,
      slotLabel: slotShortLabel,
      slotShortLabel,
      slotTitle,
      targetTime: slot.target_time,
      graceBeforeMinutes: slot.grace_before_minutes,
      graceAfterMinutes: slot.grace_after_minutes,
      isLeaveCovered: slot.is_leave_covered,
      slotStatus: slot.slot_status,
      statusLabel: slotStatusLabel,
      tone,
      isMissingHighlight: slot.slot_status === "MISSING",
      isOutOfGraceHighlight: slot.slot_status === "OUT_OF_GRACE",
      checkins,
      explanation,
      explanationStatusLabel,
      explanationBadgeTone,
      summaryText,
    };
  });

  let tone: MatrixDayCellTone;
  if (cell.day_status === "NO_CHECKIN" || cell.day_status === "APPROVED_LEAVE") {
    tone = "red";
  } else if (cell.day_status === "CHECKED_IN_AND_LEAVE") {
    tone = "amber";
  } else if (cell.day_status === "UPCOMING") {
    tone = "sky";
  } else {
    tone = "emerald";
  }

  let timeRangeLabel: string | null = null;
  const verification = describeMatrixDayVerification(cell);
  const verificationLabel = verification ? verification.hint : null;
  if (cell.has_checkin) {
    const first = cell.first_time_local ?? "--:--";
    const last = cell.last_time_local ?? first;
    timeRangeLabel =
      cell.checkin_count > 1 && last !== first
        ? `${first} – ${last} (${cell.checkin_count} lượt)`
        : cell.checkin_count > 1
          ? `${first} (${cell.checkin_count} lượt)`
          : `${first} (1 lượt)`;
  }

  const targetBadgeLabel = formatMatrixDistanceTargetLabel(
    cell.distance_target_kind,
    cell.branch_code_used,
  );
  const distanceLabel = cell.has_checkin
    ? formatMatrixDistanceStatusLabel(
        cell.distance_status,
        cell.distance_meters,
        cell.distance_target_kind,
        cell.branch_code_used,
      )
    : null;

  const policyBadgeLabel = `KG: ${resolvedSlots.policyProfileNameUsed} v${resolvedSlots.policyVersionUsed}`;

  return {
    dayStatus: cell.day_status,
    statusLabel,
    tone,
    isRedHighlight: tone === "red",
    policyProfileIdUsed: resolvedSlots.policyProfileIdUsed,
    policyProfileCodeUsed: resolvedSlots.policyProfileCodeUsed,
    policyProfileNameUsed: resolvedSlots.policyProfileNameUsed,
    policyVersionUsed: resolvedSlots.policyVersionUsed,
    policyBadgeLabel,
    hasCheckin: cell.has_checkin,
    checkinCount: cell.checkin_count,
    missingSlotCount: resolvedSlots.missingSlotCount,
    lateOrEarlyCheckinCount: resolvedSlots.lateOrEarlyCheckinCount,
    timeRangeLabel,
    verification,
    verificationLabel,
    distanceLabel,
    targetBadgeLabel,
    hasApprovedLeave: cell.has_approved_leave,
    approvedLeaveUnits: cell.approved_leave_units,
    leaveBadges,
    slots,
  };
}

export function validateMonthlyMatrixFilters(input: {
  yearMonth: string;
  filterMode: MatrixEmployeeFilterMode;
  employeeId: string;
  search: string;
}): string | null {
  const trimmedMonth = input.yearMonth.trim();
  if (!isValidYearMonth(trimmedMonth)) {
    return "Tháng báo cáo phải đúng định dạng YYYY-MM (năm từ 2000 đến 2100).";
  }
  if (input.filterMode === "employee" && input.employeeId.trim() !== "") {
    if (!UUID_PATTERN.test(input.employeeId.trim())) {
      return "Nhân sự được chọn không hợp lệ.";
    }
  }
  if (input.filterMode === "search" && input.search.trim() !== "") {
    const trimmedSearch = input.search.trim();
    if (
      trimmedSearch.length > 100 ||
      trimmedSearch.length > ATTENDANCE_REPORT_MAX_SEARCH_LENGTH ||
      CONTROL_CHAR_PATTERN.test(trimmedSearch)
    ) {
      return "Từ khóa tìm kiếm tối đa 100 ký tự và không chứa ký tự điều khiển.";
    }
  }
  return null;
}

export function mapMonthlyMatrixReportError(status: number, code: string | null): string {
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (status === 403 || code === "ATTENDANCE_REPORT_ACCESS_DENIED") {
    return "Tài khoản hiện tại không có quyền xem báo cáo ma trận chấm công tháng.";
  }
  if (code === "ATTENDANCE_MATRIX_MONTH_INVALID") {
    return "Tháng báo cáo không hợp lệ (định dạng YYYY-MM).";
  }
  if (code === "ATTENDANCE_REPORT_FILTER_CONFLICT") {
    return "Chỉ được lọc theo nhân sự cụ thể hoặc tìm kiếm từ khóa, không gửi đồng thời cả hai.";
  }
  if (code === "ATTENDANCE_REPORT_BRANCH_INVALID") {
    return "Chi nhánh lọc không hợp lệ.";
  }
  if (code === "ATTENDANCE_REPORT_EMPLOYEE_INVALID") {
    return "Nhân sự lọc không hợp lệ.";
  }
  if (code === "ATTENDANCE_REPORT_SEARCH_INVALID") {
    return "Từ khóa tìm kiếm không hợp lệ (tối đa 100 ký tự).";
  }
  return "Không thể tải báo cáo ma trận chấm công tháng lúc này. Vui lòng thử lại.";
}

export function mapMonthlyMatrixExportError(status: number, code: string | null): string {
  if (status === 422 || code === "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED") {
    return `Báo cáo vượt giới hạn xuất tối đa ${ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT.toLocaleString("vi-VN")} nhân viên. Vui lòng lọc theo chi nhánh hoặc từ khóa tìm kiếm trước khi xuất Excel.`;
  }
  if (status === 409 || code === "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE") {
    return "Dữ liệu chấm công hoặc nghỉ phép vừa thay đổi trong lúc xuất tệp. Vui lòng bấm Xuất Excel để thử lại.";
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (status === 403 || code === "ATTENDANCE_REPORT_ACCESS_DENIED") {
    return "Tài khoản hiện tại không có quyền xuất Excel báo cáo ma trận chấm công.";
  }
  if (code === "ATTENDANCE_REPORT_FILTER_CONFLICT") {
    return "Bộ lọc xuất báo cáo không hợp lệ (không gửi đồng thời mã nhân sự và từ khóa tìm kiếm).";
  }
  return "Không thể xuất tệp Excel ma trận chấm công lúc này. Vui lòng thử lại.";
}

export type BranchMutationPayloadResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

export function buildCreateSlotPolicyPayload(input: {
  profileId?: string | null;
  profileCode?: string | null;
  displayName?: string | null;
  description?: string | null;
  active?: boolean;
  expectedProfileVersion?: number;
  effectiveFromDate: string;
  slots?: readonly {
    slotCode?: AttendanceSlotCode;
    slotLabel?: string;
    targetTime: string;
    graceBeforeInput: string | number;
    graceAfterInput: string | number;
  }[];
  slot1Time?: string;
  slot1GraceBeforeInput?: string | number;
  slot1GraceAfterInput?: string | number;
  slot2Time?: string;
  slot2GraceBeforeInput?: string | number;
  slot2GraceAfterInput?: string | number;
  slot3Time?: string;
  slot3GraceBeforeInput?: string | number;
  slot3GraceAfterInput?: string | number;
  slot4Time?: string;
  slot4GraceBeforeInput?: string | number;
  slot4GraceAfterInput?: string | number;
  expectedVersion: number;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const effectiveFromDate = input.effectiveFromDate.trim();
  if (!isValidIsoCalendarDate(effectiveFromDate)) {
    return {
      ok: false,
      message: "Ngày bắt đầu hiệu lực phải đúng định dạng YYYY-MM-DD.",
    };
  }
  if (input.todayVn && effectiveFromDate < input.todayVn) {
    return {
      ok: false,
      message: `Ngày bắt đầu hiệu lực không được lùi về quá khứ (phải từ ${input.todayVn} trở đi) để bảo toàn lịch sử báo cáo.`,
    };
  }

  let normalizedProfileId: string | undefined;
  if (typeof input.profileId === "string" && input.profileId.trim().length > 0) {
    const trimmed = input.profileId.trim().toLowerCase();
    if (!UUID_PATTERN.test(trimmed)) {
      return { ok: false, message: "Cấu hình khung giờ được chọn không hợp lệ." };
    }
    normalizedProfileId = trimmed;
  }

  let normalizedProfileCode: string | undefined;
  if (typeof input.profileCode === "string" && input.profileCode.trim().length > 0) {
    const upperCode = input.profileCode.trim().toUpperCase();
    if (!SLOT_PROFILE_CODE_PATTERN.test(upperCode)) {
      return {
        ok: false,
        message:
          "Mã cấu hình khung giờ chỉ được chứa chữ in hoa A-Z, số 0-9 và các ký tự ., _, :, - (tối đa 64 ký tự).",
      };
    }
    normalizedProfileCode = upperCode;
  }

  let normalizedDisplayName: string | undefined;
  if (typeof input.displayName === "string" && input.displayName.trim().length > 0) {
    const trimmedName = input.displayName.trim();
    if (trimmedName.length > 128 || CONTROL_CHAR_PATTERN.test(trimmedName)) {
      return {
        ok: false,
        message: "Tên cấu hình khung giờ tối đa 128 ký tự và không chứa ký tự điều khiển.",
      };
    }
    normalizedDisplayName = trimmedName;
  }

  let normalizedDescription: string | undefined;
  if (typeof input.description === "string") {
    const trimmedDesc = input.description.trim();
    if (trimmedDesc.length > 500 || ADDRESS_CONTROL_CHAR_PATTERN.test(trimmedDesc)) {
      return {
        ok: false,
        message: "Mô tả cấu hình tối đa 500 ký tự và không chứa ký tự điều khiển.",
      };
    }
    normalizedDescription = trimmedDesc;
  }

  const rawSlots =
    Array.isArray(input.slots)
      ? input.slots
      : input.slot1Time !== undefined &&
          input.slot2Time !== undefined &&
          input.slot3Time !== undefined &&
          input.slot4Time !== undefined
        ? [
            {
              slotLabel: "Time 1",
              targetTime: input.slot1Time,
              graceBeforeInput: input.slot1GraceBeforeInput ?? "",
              graceAfterInput: input.slot1GraceAfterInput ?? "",
            },
            {
              slotLabel: "Time 2",
              targetTime: input.slot2Time,
              graceBeforeInput: input.slot2GraceBeforeInput ?? "",
              graceAfterInput: input.slot2GraceAfterInput ?? "",
            },
            {
              slotLabel: "Time 3",
              targetTime: input.slot3Time,
              graceBeforeInput: input.slot3GraceBeforeInput ?? "",
              graceAfterInput: input.slot3GraceAfterInput ?? "",
            },
            {
              slotLabel: "Time 4",
              targetTime: input.slot4Time,
              graceBeforeInput: input.slot4GraceBeforeInput ?? "",
              graceAfterInput: input.slot4GraceAfterInput ?? "",
            },
          ]
        : null;

  if (
    !rawSlots ||
    rawSlots.length < ATTENDANCE_SLOT_MIN_COUNT ||
    rawSlots.length > ATTENDANCE_SLOT_MAX_COUNT
  ) {
    return {
      ok: false,
      message: `Cấu hình khung giờ cần có từ ${ATTENDANCE_SLOT_MIN_COUNT} đến ${ATTENDANCE_SLOT_MAX_COUNT} mốc chấm công trong ngày.`,
    };
  }

  const normalizedSlots: {
    slot_code: AttendanceSlotCode;
    slot_index: number;
    slot_label: string;
    target_time: string;
    grace_before_minutes: number;
    grace_after_minutes: number;
  }[] = [];

  for (let i = 0; i < rawSlots.length; i += 1) {
    const raw = rawSlots[i]!;
    const slotIndex = i + 1;
    const slotCode = ATTENDANCE_SLOT_CODES[i]!;
    const rawLabel = typeof raw.slotLabel === "string" ? raw.slotLabel.trim() : "";
    const slotLabel = rawLabel.length > 0 ? rawLabel : `Time ${slotIndex}`;
    if (slotLabel.length > 64 || CONTROL_CHAR_PATTERN.test(slotLabel)) {
      return {
        ok: false,
        message: `Tên mốc thứ ${slotIndex} tối đa 64 ký tự và không chứa ký tự điều khiển.`,
      };
    }

    const targetTime = raw.targetTime.trim();

    if (!HH_MM_PATTERN.test(targetTime)) {
      return {
        ok: false,
        message: `Giờ chuẩn của ${slotLabel} phải đúng định dạng 24h HH:MM (ví dụ 07:30, 16:30).`,
      };
    }

    const beforeStr = String(raw.graceBeforeInput).trim();
    const afterStr = String(raw.graceAfterInput).trim();
    if (!/^\d+$/.test(beforeStr) || !/^\d+$/.test(afterStr)) {
      return {
        ok: false,
        message: `Dung sai trước/sau của ${slotLabel} phải là số nguyên từ 0 đến ${ATTENDANCE_SLOT_MAX_GRACE_MINUTES} phút.`,
      };
    }

    const graceBefore = Number(beforeStr);
    const graceAfter = Number(afterStr);
    if (
      !Number.isSafeInteger(graceBefore) ||
      graceBefore < 0 ||
      graceBefore > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
      !Number.isSafeInteger(graceAfter) ||
      graceAfter < 0 ||
      graceAfter > ATTENDANCE_SLOT_MAX_GRACE_MINUTES
    ) {
      return {
        ok: false,
        message: `Dung sai trước/sau của ${slotLabel} phải nằm trong khoảng 0–${ATTENDANCE_SLOT_MAX_GRACE_MINUTES} phút.`,
      };
    }

    normalizedSlots.push({
      slot_code: slotCode,
      slot_index: slotIndex,
      slot_label: slotLabel,
      target_time: targetTime,
      grace_before_minutes: graceBefore,
      grace_after_minutes: graceAfter,
    });
  }

  for (let i = 1; i < normalizedSlots.length; i += 1) {
    if (!(normalizedSlots[i - 1]!.target_time < normalizedSlots[i]!.target_time)) {
      return {
        ok: false,
        message: `Giờ chuẩn của các mốc chấm công phải tăng dần theo thứ tự thời gian trong ngày (${normalizedSlots[i - 1]!.slot_label} (${normalizedSlots[i - 1]!.target_time}) phải sớm hơn ${normalizedSlots[i]!.slot_label} (${normalizedSlots[i]!.target_time})).`,
      };
    }
  }

  const isCreatingNewProfile =
    normalizedProfileId === undefined &&
    (normalizedProfileCode !== undefined || normalizedDisplayName !== undefined);
  const minExpectedVersion = isCreatingNewProfile ? 0 : 1;

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < minExpectedVersion
  ) {
    return {
      ok: false,
      message: "Phiên bản cấu hình khung giờ không hợp lệ. Vui lòng tải lại trước khi lưu.",
    };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      ...(normalizedProfileId !== undefined ? { profile_id: normalizedProfileId } : {}),
      ...(normalizedProfileCode !== undefined ? { profile_code: normalizedProfileCode } : {}),
      ...(normalizedDisplayName !== undefined ? { display_name: normalizedDisplayName } : {}),
      ...(normalizedDescription !== undefined ? { description: normalizedDescription } : {}),
      ...(typeof input.active === "boolean" ? { active: input.active } : {}),
      ...(typeof input.expectedProfileVersion === "number"
        ? { expected_profile_version: input.expectedProfileVersion }
        : {}),
      effective_from_date: effectiveFromDate,
      slots: normalizedSlots,
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function buildUpsertSlotPolicyProfilePayload(input: {
  profileId: string | null;
  profileCode: string;
  displayName: string;
  description?: string;
  active: boolean;
  expectedProfileVersion: number;
  effectiveFromDate: string;
  slots: readonly {
    slotCode?: AttendanceSlotCode;
    slotLabel?: string;
    targetTime: string;
    graceBeforeInput: string | number;
    graceAfterInput: string | number;
  }[];
  expectedVersion: number;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const isCreate = input.profileId === null || input.profileId.trim() === "";
  const profileCode = input.profileCode.trim().toUpperCase();
  if (!SLOT_PROFILE_CODE_PATTERN.test(profileCode)) {
    return {
      ok: false,
      message:
        "Mã cấu hình khung giờ phải bắt đầu bằng chữ in hoa hoặc số, chỉ gồm A-Z, 0-9, ., _, :, - (tối đa 64 ký tự).",
    };
  }
  if (isCreate && profileCode === DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE) {
    return {
      ok: false,
      message: "Mã DEFAULT đã được dành riêng cho cấu hình Mặc định của hệ thống.",
    };
  }

  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 128 || CONTROL_CHAR_PATTERN.test(displayName)) {
    return {
      ok: false,
      message: "Tên cấu hình khung giờ bắt buộc (1–128 ký tự) và không chứa ký tự điều khiển.",
    };
  }
  if (
    isCreate &&
    displayName.toLowerCase() === DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME.toLowerCase()
  ) {
    return {
      ok: false,
      message: "Tên 'Mặc định' đã được dành riêng cho cấu hình mặc định của hệ thống.",
    };
  }

  if (
    typeof input.expectedProfileVersion !== "number" ||
    !Number.isSafeInteger(input.expectedProfileVersion) ||
    (isCreate ? input.expectedProfileVersion !== 0 : input.expectedProfileVersion < 1)
  ) {
    return {
      ok: false,
      message: "Phiên bản cấu hình không hợp lệ. Vui lòng tải lại danh sách cấu hình.",
    };
  }

  return buildCreateSlotPolicyPayload({
    profileId: isCreate ? undefined : input.profileId,
    profileCode,
    displayName,
    description: input.description ?? "",
    active: input.active,
    expectedProfileVersion: input.expectedProfileVersion,
    effectiveFromDate: input.effectiveFromDate,
    slots: input.slots,
    expectedVersion: isCreate ? 0 : input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    todayVn: input.todayVn,
  });
}

export function buildAssignEmployeeToSlotPolicyPayload(input: {
  appUserId: string;
  profile: { profile_id: string; active: boolean; version: number; is_default?: boolean } | null;
  expectedVersion?: number | null;
  validFrom?: string;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const userId = input.appUserId.trim().toLowerCase();
  if (!UUID_PATTERN.test(userId)) {
    return { ok: false, message: "Vui lòng chọn nhân viên hợp lệ để gán cấu hình khung giờ." };
  }
  if (!input.profile || !UUID_PATTERN.test(input.profile.profile_id)) {
    return { ok: false, message: "Vui lòng chọn cấu hình khung giờ hợp lệ." };
  }
  if (
    input.profile.is_default === true ||
    input.profile.profile_id.toLowerCase() === DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID
  ) {
    return {
      ok: false,
      message: "Nhân viên chưa có phân công riêng đã tự động dùng cấu hình Mặc định.",
    };
  }
  if (!input.profile.active) {
    return {
      ok: false,
      message: "Không thể gán nhân viên vào cấu hình khung giờ đang ngừng hoạt động.",
    };
  }
  if (
    typeof input.profile.version !== "number" ||
    !Number.isSafeInteger(input.profile.version) ||
    input.profile.version < 1
  ) {
    return { ok: false, message: "Phiên bản cấu hình khung giờ không hợp lệ. Vui lòng tải lại." };
  }

  const expectedVersion =
    input.expectedVersion === undefined || input.expectedVersion === null
      ? 0
      : input.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return {
      ok: false,
      message: "Phiên bản phân công hiện tại không hợp lệ. Vui lòng tải lại.",
    };
  }

  const trimmedValidFrom = typeof input.validFrom === "string" ? input.validFrom.trim() : "";
  let validFrom: string | null = null;
  if (trimmedValidFrom !== "") {
    if (!isValidIsoCalendarDate(trimmedValidFrom)) {
      return { ok: false, message: "Ngày bắt đầu hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    if (input.todayVn && trimmedValidFrom > input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày hiệu lực gán cấu hình trong tương lai. Phân công có hiệu lực ngay từ hôm nay.",
      };
    }
    if (input.todayVn && trimmedValidFrom < input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày hiệu lực gán cấu hình lùi về quá khứ để tránh sửa ngược lịch sử áp dụng cấu hình.",
      };
    }
    validFrom = trimmedValidFrom;
  } else if (input.todayVn && isValidIsoCalendarDate(input.todayVn)) {
    validFrom = input.todayVn;
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      app_user_id: userId,
      profile_id: input.profile.profile_id.toLowerCase(),
      valid_from: validFrom,
      expected_version: expectedVersion,
      idempotency_key: key,
    },
  };
}

export function buildUnassignEmployeeFromSlotPolicyPayload(input: {
  validTo?: string;
  expectedVersion: number;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const trimmedValidTo = typeof input.validTo === "string" ? input.validTo.trim() : "";
  let validTo: string | null = null;
  if (trimmedValidTo !== "") {
    if (!isValidIsoCalendarDate(trimmedValidTo)) {
      return { ok: false, message: "Ngày kết thúc hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    if (input.todayVn && trimmedValidTo > input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày kết thúc gán cấu hình trong tương lai. Việc hủy gán có hiệu lực ngay từ hôm nay.",
      };
    }
    if (input.todayVn && trimmedValidTo < input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày kết thúc gán cấu hình lùi về quá khứ để tránh sửa ngược lịch sử áp dụng cấu hình.",
      };
    }
    validTo = trimmedValidTo;
  } else if (input.todayVn && isValidIsoCalendarDate(input.todayVn)) {
    validTo = input.todayVn;
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return { ok: false, message: "Phiên bản bản ghi gán cấu hình không hợp lệ. Vui lòng tải lại." };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      valid_to: validTo,
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function describeSlotPolicyAssignmentStatus(
  assignment: Pick<
    AttendanceSlotPolicyAssignmentAdminItemProjection,
    "effective" | "valid_from" | "valid_to" | "superseded_same_day"
  >,
): {
  statusLabel: string;
  rangeLabel: string;
  canUnassign: boolean;
  tone: "emerald" | "amber" | "slate";
} {
  if (assignment.superseded_same_day) {
    return {
      statusLabel: "Đã thay thế trong ngày",
      rangeLabel: `${assignment.valid_from} (đổi trong ngày)`,
      canUnassign: false,
      tone: "slate",
    };
  }
  if (assignment.valid_to !== null) {
    return {
      statusLabel: "Đã kết thúc (Về Mặc định)",
      rangeLabel: `${assignment.valid_from} → ${assignment.valid_to}`,
      canUnassign: false,
      tone: "slate",
    };
  }
  if (assignment.effective) {
    return {
      statusLabel: "Đang áp dụng",
      rangeLabel: `Từ ${assignment.valid_from}`,
      canUnassign: true,
      tone: "emerald",
    };
  }
  return {
    statusLabel: "Sắp hiệu lực",
    rangeLabel: `Từ ${assignment.valid_from}`,
    canUnassign: true,
    tone: "amber",
  };
}

export function mapSlotPolicyMutationError(
  status: number,
  code: string | null,
): { isConflict: boolean; message: string } {
  if (code === "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST") {
    return {
      isConflict: false,
      message:
        "Ngày bắt đầu hiệu lực không được lùi về quá khứ để tránh làm thay đổi hồi tố kết quả báo cáo lịch sử.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_OVERLAP") {
    return {
      isConflict: true,
      message:
        "Ngày bắt đầu hiệu lực phải lớn hơn ngày hiệu lực của phiên bản khung giờ gần nhất (không chồng chéo kỳ hiệu lực).",
    };
  }
  if (
    code === "ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT" ||
    code === "ATTENDANCE_SLOT_POLICY_PROFILE_VERSION_CONFLICT"
  ) {
    return {
      isConflict: true,
      message:
        "Cấu hình khung giờ vừa được cập nhật ở phiên khác. Vui lòng tải lại dữ liệu trước khi lưu.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT") {
    return {
      isConflict: true,
      message: "Mã cấu hình khung giờ đã tồn tại. Vui lòng chọn mã khác.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_CONFLICT") {
    return {
      isConflict: true,
      message: "Tên cấu hình khung giờ đã tồn tại. Vui lòng chọn tên khác.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND") {
    return {
      isConflict: true,
      message: "Không tìm thấy cấu hình khung giờ. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE") {
    return {
      isConflict: false,
      message: "Cấu hình khung giờ đang ngừng hoạt động nên không thể gán nhân viên mới.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_PROFILE_DEFAULT_PROTECTED") {
    return {
      isConflict: false,
      message: "Cấu hình 'Mặc định' là cấu hình chuẩn của hệ thống, không được ngừng hoạt động hoặc xóa.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE") {
    return {
      isConflict: false,
      message:
        "Không được đặt ngày hiệu lực gán/hủy gán cấu hình trong tương lai. Mọi thay đổi có hiệu lực ngay từ hôm nay.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE") {
    return {
      isConflict: false,
      message:
        "Không được đặt ngày hiệu lực gán/hủy gán cấu hình lùi về quá khứ để tránh sửa ngược lịch sử áp dụng cấu hình.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP") {
    return {
      isConflict: true,
      message: "Khoảng thời gian gán cấu hình bị chồng lấn với một bản ghi phân công khác.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED") {
    return {
      isConflict: true,
      message: "Bản ghi gán cấu hình này đã kết thúc trước đó. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message: "Phân công cấu hình khung giờ vừa thay đổi ở phiên khác. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND") {
    return {
      isConflict: true,
      message: "Không tìm thấy bản ghi phân công cấu hình khung giờ. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID") {
    return {
      isConflict: false,
      message: "Khoảng ngày hiệu lực gán cấu hình không hợp lệ (ngày kết thúc phải từ ngày bắt đầu trở đi).",
    };
  }
  if (code === "ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID") {
    return {
      isConflict: false,
      message: "Nhân viên được chọn không hợp lệ hoặc đã ngừng hoạt động.",
    };
  }
  if (
    code === "ATTENDANCE_SLOT_POLICY_INVALID" ||
    code === "ATTENDANCE_SLOT_POLICY_PROFILE_INVALID" ||
    code === "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID"
  ) {
    return {
      isConflict: false,
      message:
        "Thông số cấu hình khung giờ hoặc phân công không hợp lệ. Vui lòng kiểm tra thứ tự giờ chuẩn tăng dần và dung sai 0–240 phút.",
    };
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return {
      isConflict: true,
      message: "Thao tác bị trùng khóa xử lý (Idempotency). Vui lòng tải lại dữ liệu.",
    };
  }
  if (status === 403 || code === "ATTENDANCE_SLOT_POLICY_WRITE_DENIED") {
    return {
      isConflict: false,
      message: "Tài khoản hiện tại chỉ có quyền xem, không có quyền cấu hình khung giờ chấm công.",
    };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      isConflict: false,
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  return {
    isConflict: status === 409,
    message: "Không thể lưu cấu hình khung giờ chấm công lúc này. Vui lòng thử lại.",
  };
}

export function buildUpsertBranchPayload(input: {
  branchCode: string;
  displayName: string;
  address: string;
  latitudeInput: string;
  longitudeInput: string;
  active: boolean;
  expectedVersion: number;
  idempotencyKey: string;
}): BranchMutationPayloadResult {
  const branchCode = input.branchCode.trim().toUpperCase();
  if (!BRANCH_CODE_PATTERN.test(branchCode)) {
    return {
      ok: false,
      message:
        "Mã chi nhánh phải bắt đầu bằng chữ in hoa hoặc số, chỉ gồm A-Z, 0-9, ., _, :, - (tối đa 64 ký tự).",
    };
  }

  const displayName = input.displayName.trim();
  if (
    displayName.length < 1 ||
    displayName.length > 256 ||
    CONTROL_CHAR_PATTERN.test(displayName)
  ) {
    return {
      ok: false,
      message: "Tên chi nhánh bắt buộc (1–256 ký tự) và không chứa ký tự điều khiển.",
    };
  }

  const address = input.address.trim();
  if (address.length > 500 || ADDRESS_CONTROL_CHAR_PATTERN.test(address)) {
    return {
      ok: false,
      message: "Địa chỉ chi nhánh tối đa 500 ký tự và không chứa ký tự điều khiển.",
    };
  }

  const rawLat = input.latitudeInput.trim();
  const rawLon = input.longitudeInput.trim();
  if ((rawLat === "") !== (rawLon === "")) {
    return {
      ok: false,
      message: "Vĩ độ và kinh độ chi nhánh phải cùng nhập hoặc cùng để trống.",
    };
  }

  let latitude: number | null = null;
  let longitude: number | null = null;
  if (rawLat !== "" && rawLon !== "") {
    const parsedLat = Number(rawLat);
    const parsedLon = Number(rawLon);
    if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      return { ok: false, message: "Vĩ độ chi nhánh phải nằm trong khoảng từ -90 đến 90." };
    }
    if (!Number.isFinite(parsedLon) || parsedLon < -180 || parsedLon > 180) {
      return { ok: false, message: "Kinh độ chi nhánh phải nằm trong khoảng từ -180 đến 180." };
    }
    latitude = Object.is(parsedLat, -0) ? 0 : parsedLat;
    longitude = Object.is(parsedLon, -0) ? 0 : parsedLon;
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    return { ok: false, message: "Phiên bản dữ liệu chi nhánh không hợp lệ. Vui lòng tải lại." };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      branch_code: branchCode,
      display_name: displayName,
      address,
      latitude,
      longitude,
      active: Boolean(input.active),
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function buildAssignEmployeeToBranchPayload(input: {
  appUserId: string;
  branch: { branch_id: string; active: boolean; version: number } | null;
  validFrom?: string;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const userId = input.appUserId.trim().toLowerCase();
  if (!UUID_PATTERN.test(userId)) {
    return { ok: false, message: "Vui lòng chọn nhân viên hợp lệ để phân công chi nhánh." };
  }
  if (!input.branch || !UUID_PATTERN.test(input.branch.branch_id)) {
    return { ok: false, message: "Vui lòng chọn chi nhánh HRP hợp lệ." };
  }
  if (!input.branch.active) {
    return {
      ok: false,
      message: "Không thể gán nhân viên mới vào chi nhánh đã ngừng hoạt động.",
    };
  }
  if (
    typeof input.branch.version !== "number" ||
    !Number.isSafeInteger(input.branch.version) ||
    input.branch.version < 1
  ) {
    return { ok: false, message: "Phiên bản chi nhánh không hợp lệ. Vui lòng tải lại." };
  }

  const trimmedValidFrom = typeof input.validFrom === "string" ? input.validFrom.trim() : "";
  let validFrom: string | null = null;
  if (trimmedValidFrom !== "") {
    if (!isValidIsoCalendarDate(trimmedValidFrom)) {
      return { ok: false, message: "Ngày bắt đầu hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    if (input.todayVn && trimmedValidFrom > input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày hiệu lực phân công chi nhánh trong tương lai. Phân công có hiệu lực ngay từ hôm nay.",
      };
    }
    validFrom = trimmedValidFrom;
  } else if (input.todayVn && isValidIsoCalendarDate(input.todayVn)) {
    validFrom = input.todayVn;
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      app_user_id: userId,
      branch_id: input.branch.branch_id.toLowerCase(),
      valid_from: validFrom,
      expected_version: input.branch.version,
      idempotency_key: key,
    },
  };
}

export function buildUnassignEmployeeFromBranchPayload(input: {
  validTo?: string;
  expectedVersion: number;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const trimmedValidTo = typeof input.validTo === "string" ? input.validTo.trim() : "";
  let validTo: string | null = null;
  if (trimmedValidTo !== "") {
    if (!isValidIsoCalendarDate(trimmedValidTo)) {
      return { ok: false, message: "Ngày kết thúc hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    if (input.todayVn && trimmedValidTo > input.todayVn) {
      return {
        ok: false,
        message:
          "Không được đặt ngày kết thúc phân công chi nhánh trong tương lai. Việc kết thúc có hiệu lực ngay từ hôm nay.",
      };
    }
    validTo = trimmedValidTo;
  } else if (input.todayVn && isValidIsoCalendarDate(input.todayVn)) {
    validTo = input.todayVn;
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return { ok: false, message: "Phiên bản phân công không hợp lệ. Vui lòng tải lại." };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      valid_to: validTo,
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function mapBranchAdminMutationError(
  status: number,
  code: string | null,
): { isConflict: boolean; message: string } {
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE") {
    return {
      isConflict: false,
      message:
        "Không được đặt ngày hiệu lực phân công/kết thúc phân công chi nhánh trong tương lai. Mọi thay đổi có hiệu lực ngay từ hôm nay.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_CODE_CONFLICT") {
    return {
      isConflict: true,
      message: "Mã chi nhánh HRP đã tồn tại. Vui lòng dùng mã khác hoặc tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message:
        "Chi nhánh đã được cập nhật ở phiên khác (xung đột phiên bản). Vui lòng tải lại dữ liệu trước khi tiếp tục.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_INACTIVE") {
    return {
      isConflict: false,
      message: "Chi nhánh đang ngừng hoạt động nên không thể gán nhân viên mới.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_TARGET_USER_INVALID") {
    return {
      isConflict: false,
      message: "Nhân viên được chọn không hợp lệ hoặc không thuộc diện chấm công HRP.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP") {
    return {
      isConflict: true,
      message:
        "Khoảng thời gian hiệu lực bị chồng lấn với một phân công chi nhánh khác của nhân viên này.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED") {
    return {
      isConflict: true,
      message: "Phân công chi nhánh này đã kết thúc trước đó. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID") {
    return {
      isConflict: false,
      message: "Khoảng ngày hiệu lực không hợp lệ (ngày kết thúc phải từ ngày bắt đầu trở đi).",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message:
        "Phân công chi nhánh đã được cập nhật ở phiên khác. Vui lòng tải lại dữ liệu trước khi tiếp tục.",
    };
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return {
      isConflict: true,
      message: "Thao tác bị trùng khóa xử lý (Idempotency). Vui lòng tải lại dữ liệu.",
    };
  }
  if (status === 403 || code === "ATTENDANCE_BRANCH_WRITE_DENIED") {
    return {
      isConflict: false,
      message: "Tài khoản hiện tại chỉ có quyền xem, không có quyền quản trị chi nhánh HRP.",
    };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      isConflict: false,
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  if (status === 404 || code === "ATTENDANCE_BRANCH_NOT_FOUND" || code === "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND") {
    return {
      isConflict: true,
      message: "Không tìm thấy chi nhánh hoặc bản ghi phân công. Vui lòng tải lại danh sách.",
    };
  }
  if (status === 409) {
    return {
      isConflict: true,
      message: "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi thao tác tiếp.",
    };
  }
  return {
    isConflict: false,
    message: "Không thể lưu thay đổi chi nhánh HRP lúc này. Vui lòng thử lại.",
  };
}

export function describeBranchAssignmentStatus(
  assignment: Pick<
    AttendanceBranchAssignmentAdminItemProjection,
    "effective" | "valid_from" | "valid_to"
  >,
): {
  statusLabel: string;
  rangeLabel: string;
  canUnassign: boolean;
  tone: "emerald" | "amber" | "slate";
} {
  if (assignment.valid_to !== null) {
    return {
      statusLabel: "Đã kết thúc",
      rangeLabel: `${assignment.valid_from} → ${assignment.valid_to}`,
      canUnassign: false,
      tone: "slate",
    };
  }
  if (assignment.effective) {
    return {
      statusLabel: "Đang hiệu lực",
      rangeLabel: `Từ ${assignment.valid_from}`,
      canUnassign: true,
      tone: "emerald",
    };
  }
  return {
    statusLabel: "Sắp hiệu lực",
    rangeLabel: `Từ ${assignment.valid_from}`,
    canUnassign: true,
    tone: "amber",
  };
}

export function buildSubmitAttendanceExplanationPayload(input: {
  businessDate: string;
  slotCode: string;
  reason: string;
  idempotencyKey: string;
  todayVn?: string;
}): BranchMutationPayloadResult {
  const businessDate = input.businessDate.trim();
  if (!isValidIsoCalendarDate(businessDate)) {
    return {
      ok: false,
      message: "Ngày giải trình chấm công phải đúng định dạng YYYY-MM-DD.",
    };
  }
  if (input.todayVn && businessDate > input.todayVn) {
    return {
      ok: false,
      message: "Không thể gửi giải trình chấm công cho ngày trong tương lai.",
    };
  }

  const slotCode = input.slotCode.trim().toUpperCase();
  if (!(ATTENDANCE_SLOT_CODES as readonly string[]).includes(slotCode)) {
    return {
      ok: false,
      message: "Mốc chấm công cần giải trình không hợp lệ.",
    };
  }

  const reason = input.reason.trim();
  if (
    reason.length < ATTENDANCE_EXPLANATION_MIN_REASON_LENGTH ||
    reason.length > ATTENDANCE_EXPLANATION_MAX_REASON_LENGTH ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(reason)
  ) {
    return {
      ok: false,
      message: `Lý do giải trình phải từ ${ATTENDANCE_EXPLANATION_MIN_REASON_LENGTH} đến ${ATTENDANCE_EXPLANATION_MAX_REASON_LENGTH} ký tự và không chứa ký tự điều khiển.`,
    };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      business_date: businessDate,
      slot_code: slotCode as AttendanceSlotCode,
      reason,
      idempotency_key: key,
    },
  };
}

export function buildDecideAttendanceExplanationPayload(input: {
  decision: string;
  expectedRowVersion: number;
  decisionNote: string;
  idempotencyKey: string;
}): BranchMutationPayloadResult {
  const decision = input.decision.trim().toUpperCase();
  if (!(ATTENDANCE_EXPLANATION_DECISIONS as readonly string[]).includes(decision)) {
    return {
      ok: false,
      message: "Quyết định phê duyệt giải trình không hợp lệ (APPROVE hoặc REJECT).",
    };
  }

  if (
    typeof input.expectedRowVersion !== "number" ||
    !Number.isSafeInteger(input.expectedRowVersion) ||
    input.expectedRowVersion < 1
  ) {
    return {
      ok: false,
      message: "Phiên bản bản ghi giải trình không hợp lệ. Vui lòng tải lại.",
    };
  }

  const trimmedNote = input.decisionNote.trim();
  if (
    trimmedNote.length > ATTENDANCE_EXPLANATION_MAX_DECISION_NOTE_LENGTH ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(trimmedNote)
  ) {
    return {
      ok: false,
      message: `Ghi chú quyết định tối đa ${ATTENDANCE_EXPLANATION_MAX_DECISION_NOTE_LENGTH} ký tự và không chứa ký tự điều khiển.`,
    };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      decision: decision as AttendanceExplanationDecision,
      expected_row_version: input.expectedRowVersion,
      decision_note: trimmedNote.length > 0 ? trimmedNote : null,
      idempotency_key: key,
    },
  };
}

export function mapAttendanceExplanationMutationError(
  status: number,
  code: string | null,
): { isConflict: boolean; message: string } {
  if (code === "ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED") {
    return {
      isConflict: true,
      message:
        "Mốc chấm công này đã được gửi giải trình trước đó. Mỗi mốc trong một ngày chỉ tạo tối đa 1 giải trình.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE") {
    return {
      isConflict: false,
      message:
        "Chỉ được gửi giải trình cho mốc chưa có lượt chấm hoặc có lượt chấm lệch ngoài khoảng dung sai.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_SLOT_INVALID") {
    return {
      isConflict: false,
      message:
        "Mốc chấm công không tồn tại trong phiên bản khung giờ áp dụng cho ngày này.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_DATE_FUTURE") {
    return {
      isConflict: false,
      message: "Không thể gửi giải trình chấm công cho ngày trong tương lai.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_APPROVER_UNCONFIGURED") {
    return {
      isConflict: false,
      message:
        "Tài khoản hiện tại chưa được cấu hình người duyệt phép/giải trình. Vui lòng liên hệ HR/Admin.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_REASON_INVALID") {
    return {
      isConflict: false,
      message: "Lý do giải trình phải từ 3 đến 1000 ký tự hợp lệ.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message:
        "Giải trình vừa được cập nhật ở phiên khác (xung đột phiên bản). Vui lòng tải lại danh sách.",
    };
  }
  if (
    code === "ATTENDANCE_EXPLANATION_STATE_INVALID" ||
    code === "ATTENDANCE_EXPLANATION_ALREADY_DECIDED"
  ) {
    return {
      isConflict: true,
      message: "Giải trình này đã được xử lý trước đó, không còn ở trạng thái chờ duyệt.",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_DECISION_DENIED" || status === 403) {
    return {
      isConflict: false,
      message:
        "Tài khoản hiện tại không có thẩm quyền duyệt giải trình này (hoặc không được tự duyệt giải trình của chính mình).",
    };
  }
  if (code === "ATTENDANCE_EXPLANATION_NOT_FOUND" || status === 404) {
    return {
      isConflict: true,
      message: "Không tìm thấy bản ghi giải trình chấm công. Vui lòng tải lại.",
    };
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return {
      isConflict: true,
      message: "Thao tác bị trùng khóa xử lý (Idempotency). Vui lòng tải lại dữ liệu.",
    };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      isConflict: false,
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  return {
    isConflict: status === 409,
    message: "Không thể xử lý giải trình chấm công lúc này. Vui lòng thử lại.",
  };
}

export type TableScrollMetrics = {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
};

export type TableScrollAvailability = {
  hasHorizontalOverflow: boolean;
  hasVerticalOverflow: boolean;
  hasOverflow: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
  canScrollUp: boolean;
  canScrollDown: boolean;
};

const TABLE_SCROLL_EPSILON_PX = 2;

export const TABLE_HORIZONTAL_SCROLL_STEP_SCALE = 0.7;
export const DEFAULT_TABLE_HORIZONTAL_STEP_PX = 392;
export const DEFAULT_TABLE_VERTICAL_STEP_PX = 360;
export const MIN_TABLE_HORIZONTAL_STEP_PX = 196;
export const MIN_TABLE_VERTICAL_STEP_PX = 240;
export const TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO = 0.525;
export const TABLE_SCROLL_VERTICAL_VIEWPORT_STEP_RATIO = 0.75;
export const TABLE_SCROLL_VIEWPORT_STEP_RATIO =
  TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO;

export type TableScrollDirection = "left" | "right" | "up" | "down";

export type FloatingTableNavPosition = "bottom-right" | "bottom-left";

export function resolveFloatingTableNavPositionClass(
  position: FloatingTableNavPosition = "bottom-right",
): string {
  return position === "bottom-left"
    ? "fixed bottom-4 left-4 z-40"
    : "fixed bottom-4 right-4 z-40";
}

export function computeTableScrollStepPx(
  viewportSize: number | null | undefined,
  options?: {
    minStepPx?: number;
    fallbackStepPx?: number;
    ratio?: number;
  },
): number {
  const minStepPx = options?.minStepPx ?? MIN_TABLE_HORIZONTAL_STEP_PX;
  const fallbackStepPx = options?.fallbackStepPx ?? DEFAULT_TABLE_HORIZONTAL_STEP_PX;
  const ratio = options?.ratio ?? TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO;

  if (typeof viewportSize !== "number" || !Number.isFinite(viewportSize) || viewportSize <= 0) {
    return fallbackStepPx;
  }
  return Math.max(minStepPx, Math.round(viewportSize * ratio));
}

export function computeClampedTableScrollTarget(
  metrics: TableScrollMetrics,
  direction: TableScrollDirection,
  customStepPx?: number,
): {
  left: number;
  top: number;
  deltaLeft: number;
  deltaTop: number;
} {
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const currentLeft = Math.min(maxScrollLeft, Math.max(0, metrics.scrollLeft));
  const currentTop = Math.min(maxScrollTop, Math.max(0, metrics.scrollTop));

  const horizontalStep =
    typeof customStepPx === "number" && Number.isFinite(customStepPx) && customStepPx > 0
      ? Math.round(customStepPx)
      : computeTableScrollStepPx(metrics.clientWidth, {
          minStepPx: MIN_TABLE_HORIZONTAL_STEP_PX,
          fallbackStepPx: DEFAULT_TABLE_HORIZONTAL_STEP_PX,
          ratio: TABLE_SCROLL_HORIZONTAL_VIEWPORT_STEP_RATIO,
        });
  const verticalStep =
    typeof customStepPx === "number" && Number.isFinite(customStepPx) && customStepPx > 0
      ? Math.round(customStepPx)
      : computeTableScrollStepPx(metrics.clientHeight, {
          minStepPx: MIN_TABLE_VERTICAL_STEP_PX,
          fallbackStepPx: DEFAULT_TABLE_VERTICAL_STEP_PX,
          ratio: TABLE_SCROLL_VERTICAL_VIEWPORT_STEP_RATIO,
        });

  let nextLeft = currentLeft;
  let nextTop = currentTop;

  if (direction === "left") {
    nextLeft = Math.max(0, currentLeft - horizontalStep);
  } else if (direction === "right") {
    nextLeft = Math.min(maxScrollLeft, currentLeft + horizontalStep);
  } else if (direction === "up") {
    nextTop = Math.max(0, currentTop - verticalStep);
  } else if (direction === "down") {
    nextTop = Math.min(maxScrollTop, currentTop + verticalStep);
  }

  return {
    left: nextLeft,
    top: nextTop,
    deltaLeft: nextLeft - currentLeft,
    deltaTop: nextTop - currentTop,
  };
}

export function computeTableScrollAvailability(
  metrics: TableScrollMetrics | null | undefined,
): TableScrollAvailability {
  if (!metrics) {
    return {
      hasHorizontalOverflow: false,
      hasVerticalOverflow: false,
      hasOverflow: false,
      canScrollLeft: false,
      canScrollRight: false,
      canScrollUp: false,
      canScrollDown: false,
    };
  }

  const hasHorizontalOverflow =
    metrics.scrollWidth - metrics.clientWidth > TABLE_SCROLL_EPSILON_PX;
  const hasVerticalOverflow =
    metrics.scrollHeight - metrics.clientHeight > TABLE_SCROLL_EPSILON_PX;
  const hasOverflow = hasHorizontalOverflow || hasVerticalOverflow;

  const canScrollLeft =
    hasHorizontalOverflow && metrics.scrollLeft > TABLE_SCROLL_EPSILON_PX;
  const canScrollRight =
    hasHorizontalOverflow &&
    metrics.scrollLeft + metrics.clientWidth <
      metrics.scrollWidth - TABLE_SCROLL_EPSILON_PX;
  const canScrollUp =
    hasVerticalOverflow && metrics.scrollTop > TABLE_SCROLL_EPSILON_PX;
  const canScrollDown =
    hasVerticalOverflow &&
    metrics.scrollTop + metrics.clientHeight <
      metrics.scrollHeight - TABLE_SCROLL_EPSILON_PX;

  return {
    hasHorizontalOverflow,
    hasVerticalOverflow,
    hasOverflow,
    canScrollLeft,
    canScrollRight,
    canScrollUp,
    canScrollDown,
  };
}
