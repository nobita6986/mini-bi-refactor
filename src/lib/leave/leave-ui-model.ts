import type { BadgeTone } from "../../components/ui/badge";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import {
  decideSessionPageAccess,
  type SessionPageDecision,
} from "../auth/session-page-access.ts";
import {
  LEAVE_TYPES,
  LEAVE_TYPE_MAX_UNITS_PER_REQUEST,
  type LeaveAdminAccountStatusFilter,
  type LeaveDecisionCode,
  type LeaveDepartmentApproverUnitKind,
  type LeaveEmploymentStatus,
  type LeaveModuleGrantRole,
  type LeaveRequestStatusFilter,
  type LeaveSessionCode,
  type LeaveType,
  type LeaveTypeAllocationInput,
  type LeaveUnitKind,
  type OpeningBatchRowInput,
} from "./leave-contract.ts";

export { LEAVE_TYPES, LEAVE_TYPE_MAX_UNITS_PER_REQUEST };
export const LEAVE_SESSION_CODES = ["FULL", "AM", "PM"] as const;
export const LEAVE_UNIT_KINDS = [
  "UNCLASSIFIED",
  "RECRUITMENT",
  "MARKETING",
  "IT",
  "ACCOUNTING",
  "MANAGEMENT_BOD",
] as const;
export const LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS = [
  "MARKETING",
  "IT",
  "ACCOUNTING",
] as const;
export const LEAVE_EMPLOYMENT_STATUSES = [
  "UNCONFIGURED",
  "PROBATION",
  "OFFICIAL",
] as const;
export const LEAVE_REQUEST_STATUS_FILTERS = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "WITHDRAWN",
  "ALL",
] as const;
export const LEAVE_DECISION_CODES = [
  "APPROVE",
  "REJECT",
  "CANCEL_APPROVED",
] as const;
export const LEAVE_MODULE_GRANT_ROLES = [
  "HR_REPORT_VIEWER",
  "HR_LEAVE_OPERATOR",
  "LEAVE_ADMIN_BOD_APPROVER",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value.trim())) {
    return false;
  }
  const parsed = new Date(`${value.trim()}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value.trim()
  );
}

export type {
  LeaveDecisionCode,
  LeaveDepartmentApproverUnitKind,
  LeaveEmploymentStatus,
  LeaveModuleGrantRole,
  LeaveRequestStatusFilter,
  LeaveSessionCode,
  LeaveType,
  LeaveTypeAllocationInput,
  LeaveUnitKind,
  OpeningBatchRowInput,
};

export type LeaveWorkspaceTab = "personal" | "approvals" | "admin" | "reports";

export type LeaveWorkspaceTabDefinition = {
  readonly id: LeaveWorkspaceTab;
  readonly label: string;
  readonly badgeCount?: number;
};

export type LeaveAccountProjection = {
  app_user_id: string;
  display_name: string;
  login_id: string | null;
  personnel_code: string | null;
  recruiter_id: string | null;
  account_enabled: boolean;
};

export type LeaveAuthorityProjection = {
  app_user_id: string;
  is_shared_non_employee: boolean;
  is_full_admin: boolean;
  is_bod: boolean;
  is_hr_operator: boolean;
  is_hr_report_viewer: boolean;
  is_team_leader: boolean;
  is_department_approver: boolean;
  can_submit_request: boolean;
  can_approve_requests: boolean;
  can_view_monthly_report: boolean;
  can_manage_config: boolean;
};

export type LeaveRoutingProjection = {
  route_kind:
    | "TEAM_LEADER"
    | "DEPARTMENT_HEAD"
    | "ADMIN_BOD_DIRECT"
    | "ADMIN_BOD_FALLBACK"
    | string;
  unit_kind: LeaveUnitKind | string;
  primary_approver_app_user_id: string | null;
  team_id: string | null;
  team_code: string | null;
  team_name: string | null;
  fallback_reason: string | null;
  profile_configured: boolean;
};

export type LeavePolicyProjection = {
  annual_base_units: number;
  monthly_accrual_units: number;
  default_seniority_years: number;
  default_seniority_step_units: number;
  carry_over_expiry_month: number | null;
  carry_over_expiry_day: number | null;
  carry_over_expires_after_date: string | null;
  row_version: number;
};

export type LeaveLotProjection = {
  lot_id: string;
  leave_year: number;
  lot_kind: string;
  accrual_month: number | null;
  granted_units: number;
  reserved_units: number;
  consumed_units: number;
  expired_units: number;
  available_units: number;
  usable_from_date: string;
  expires_after_date: string | null;
  source_ref: string | null;
};

export type LeaveBalanceProjection = {
  leave_year: number;
  as_of_date: string;
  has_profile: boolean;
  profile_configured: boolean;
  employment_status: LeaveEmploymentStatus | string;
  unit_kind: LeaveUnitKind | string;
  work_start_date: string | null;
  official_effective_date: string | null;
  next_seniority_effective_date: string | null;
  next_seniority_units: number;
  total_granted_units: number;
  carry_over_granted_units: number;
  carry_over_available_units: number;
  monthly_accrued_units: number;
  seniority_granted_units: number;
  opening_or_adjustment_units: number;
  available_units: number;
  reserved_units: number;
  consumed_units: number;
  expired_units: number;
  pending_annual_units?: number;
  pending_non_annual_units?: number;
  pending_unpaid_units?: number;
  approved_annual_units?: number;
  approved_non_annual_units?: number;
  approved_bereavement_units?: number;
  approved_marriage_units?: number;
  approved_sick_units?: number;
  approved_unpaid_units?: number;
  lots: readonly LeaveLotProjection[];
};

export type LeaveRequestDayProjection = {
  request_day_id: string;
  leave_date: string;
  session_code: LeaveSessionCode;
  leave_type: LeaveType | string;
  half_day_units: number;
  is_active: boolean;
};

export type LeaveRequestTypeBreakdownProjection = {
  leave_type: LeaveType | string;
  half_day_units: number;
};

export type LeaveRequestAllocationProjection = {
  allocation_id: string;
  request_day_id: string;
  lot_id: string;
  lot_kind: string;
  leave_date: string;
  allocated_units: number;
  status: string;
  settled_at: string | null;
  released_at: string | null;
};

export type LeaveRequestProjection = {
  request_id: string;
  app_user_id: string;
  requester: LeaveAccountProjection | null;
  status:
    | "PENDING"
    | "APPROVED"
    | "REJECTED"
    | "CANCELLED"
    | "WITHDRAWN"
    | string;
  leave_types?: readonly (LeaveType | string)[];
  type_breakdown?: readonly LeaveRequestTypeBreakdownProjection[];
  employment_status_snapshot: string;
  unit_kind_snapshot: string;
  profile_configured_at_submit: boolean;
  requested_units: number;
  requested_annual_units?: number;
  requested_non_annual_units?: number;
  reason: string | null;
  route_kind: string;
  primary_approver_app_user_id: string | null;
  primary_approver: LeaveAccountProjection | null;
  routed_team_id: string | null;
  routed_team_code: string | null;
  routed_team_name: string | null;
  fallback_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by_app_user_id: string | null;
  decided_by: LeaveAccountProjection | null;
  decision_reason: string | null;
  cancelled_at: string | null;
  cancelled_by_app_user_id: string | null;
  cancellation_reason: string | null;
  row_version: number;
  days: readonly LeaveRequestDayProjection[];
  allocations: readonly LeaveRequestAllocationProjection[];
};

export type LeaveLedgerEntryProjection = {
  ledger_entry_id: string;
  lot_id: string | null;
  request_id: string | null;
  entry_type: string;
  effective_date: string;
  delta_available_units: number;
  delta_reserved_units: number;
  delta_consumed_units: number;
  delta_expired_units: number;
  reason: string | null;
  created_at: string;
};

export type LeaveMeSummaryProjection = {
  as_of_date: string;
  leave_year: number;
  account: LeaveAccountProjection | null;
  authority: LeaveAuthorityProjection;
  routing: LeaveRoutingProjection;
  policy: LeavePolicyProjection;
  balance: LeaveBalanceProjection;
  requests: readonly LeaveRequestProjection[];
  ledger_entries: readonly LeaveLedgerEntryProjection[];
};

export type LeaveApprovalInboxProjection = {
  as_of_date: string;
  status_filter: LeaveRequestStatusFilter;
  total: number;
  limit: number;
  offset: number;
  items: readonly LeaveRequestProjection[];
};

export type LeaveDepartmentApproverProjection = {
  approver_assignment_id: string;
  unit_kind: LeaveDepartmentApproverUnitKind;
  approver_app_user_id: string;
  approver: LeaveAccountProjection | null;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
  reason: string | null;
  row_version: number;
};

export type LeaveModuleGrantProjection = {
  grant_id: string;
  app_user_id: string;
  account: LeaveAccountProjection | null;
  role_code: LeaveModuleGrantRole;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
  reason: string | null;
  row_version: number;
};

export type LeaveEmployeeProfileProjection = {
  app_user_id: string;
  is_shared_non_employee: boolean;
  employment_status: LeaveEmploymentStatus;
  unit_kind: LeaveUnitKind;
  work_start_date: string | null;
  official_effective_date: string | null;
  next_seniority_effective_date: string | null;
  next_seniority_units: number;
  notes: string | null;
  row_version: number;
};

export type LeaveAdminEmployeeItemProjection = {
  account: LeaveAccountProjection;
  profile: LeaveEmployeeProfileProjection;
  routing: LeaveRoutingProjection;
  balance: LeaveBalanceProjection;
};

export type LeaveAdminOverviewProjection = {
  as_of_date: string;
  leave_year: number;
  authority: LeaveAuthorityProjection;
  policy: LeavePolicyProjection;
  department_approvers: readonly LeaveDepartmentApproverProjection[];
  module_grants: readonly LeaveModuleGrantProjection[];
  total_employees: number;
  account_status: LeaveAdminAccountStatusFilter;
  limit: number;
  offset: number;
  employees: readonly LeaveAdminEmployeeItemProjection[];
};

export type LeaveOpeningPreviewRowProjection = {
  row_index: number;
  app_user_id: string | null;
  account: LeaveAccountProjection | null;
  as_of_date?: string | null;
  carry_over_units: number;
  opening_current_year_units: number;
  target_current_year_units?: number;
  current_year_accrued_units?: number;
  current_year_granted_units?: number;
  current_year_locked_units?: number;
  current_year_available_units?: number;
  delta_current_year_units?: number;
  reconciled_current_year_granted_units?: number;
  reconciled_current_year_available_units?: number;
  profile_row_version?: number;
  seniority_units: number;
  note: string | null;
  valid: boolean;
  errors: readonly string[];
};

export type LeaveOpeningPreviewProjection = {
  leave_year: number;
  as_of_date?: string | null;
  carry_over_expires_after_date: string | null;
  valid: boolean;
  has_carry_over_expiry_error: boolean;
  row_count: number;
  error_row_count: number;
  total_carry_over_units: number;
  total_opening_current_year_units: number;
  total_seniority_units: number;
  rows: readonly LeaveOpeningPreviewRowProjection[];
};

export type LeaveMonthlyReportAttendanceDayProjection = {
  business_date: string;
  checkin_count: number;
  first_captured_at?: string | null;
  last_captured_at?: string | null;
};

export type LeaveMonthlyReportLeaveDayProjection = {
  request_id: string;
  request_day_id: string;
  leave_date: string;
  session_code: LeaveSessionCode | string;
  leave_type: LeaveType | string;
  half_day_units: number;
};

export type LeaveMonthlyReportRowProjection = {
  app_user_id: string;
  account: LeaveAccountProjection | null;
  routing: LeaveRoutingProjection | null;
  employment_status: LeaveEmploymentStatus | string;
  unit_kind: LeaveUnitKind | string;
  work_start_date: string | null;
  official_effective_date: string | null;
  attendance_day_count: number;
  attendance_dates: readonly string[];
  attendance_days?: readonly LeaveMonthlyReportAttendanceDayProjection[];
  leave_days: readonly LeaveMonthlyReportLeaveDayProjection[];
  pending_leave_days?: readonly LeaveMonthlyReportLeaveDayProjection[];
  month_annual_leave_units: number;
  month_bereavement_leave_units: number;
  month_marriage_leave_units: number;
  month_sick_leave_units: number;
  month_unpaid_leave_units: number;
  month_total_approved_leave_units: number;
  month_pending_units: number;
  month_approved_request_count: number;
  balance: LeaveBalanceProjection;
};

export type LeaveMonthlyReportProjection = {
  as_of_date: string;
  year_month: string;
  leave_year: number;
  month: number;
  unit_kind_filter: string;
  search: string | null;
  total: number;
  limit: number;
  offset: number;
  rows: readonly LeaveMonthlyReportRowProjection[];
};

export type LeavePageDecision = "NOT_FOUND" | SessionPageDecision;

export function decideLeavePageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
}): LeavePageDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  return decideSessionPageAccess(input.actor);
}

const VI_DAY_FORMATTER = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function halfDayUnitsToDays(units: number): number {
  if (!Number.isFinite(units)) return 0;
  return Math.trunc(units) / 2;
}

export function formatHalfDayUnits(units: number, includeSuffix = true): string {
  const days = halfDayUnitsToDays(units);
  const formatted = VI_DAY_FORMATTER.format(days);
  return includeSuffix ? `${formatted} ngày` : formatted;
}

/**
 * Converts a user-entered day count (e.g. "1.5" or "1,5" or "2") into integer half-day units.
 * Returns null if the input is not a valid non-negative multiple of 0.5 days.
 */
export function parseDaysInputToHalfDayUnits(
  rawInput: string | number,
  maxUnits = 120,
): number | null {
  const text =
    typeof rawInput === "number"
      ? String(rawInput)
      : typeof rawInput === "string"
        ? rawInput.trim().replace(",", ".")
        : "";
  if (text.length === 0) return 0;
  if (!/^\d+(?:\.(?:0|5))?$/.test(text)) {
    return null;
  }
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) return null;
  const units = Math.round(num * 2);
  if (!Number.isInteger(units) || units < 0 || units > maxUnits) {
    return null;
  }
  return units;
}

export function formatIsoDateVi(isoDate: string | null | undefined): string {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate.trim())) {
    return "Chưa đặt";
  }
  const [year, month, day] = isoDate.trim().split("-");
  return `${day}/${month}/${year}`;
}

export function formatIsoTimestampVi(isoTimestamp: string | null | undefined): string {
  if (typeof isoTimestamp !== "string" || isoTimestamp.trim().length === 0) {
    return "—";
  }
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function leaveSessionLabel(sessionCode: LeaveSessionCode | string): string {
  switch (sessionCode) {
    case "FULL":
      return "Cả ngày (1 ngày)";
    case "AM":
      return "Buổi sáng (0,5 ngày)";
    case "PM":
      return "Buổi chiều (0,5 ngày)";
    default:
      return sessionCode;
  }
}

export function leaveSessionShortLabel(sessionCode: LeaveSessionCode | string): string {
  switch (sessionCode) {
    case "FULL":
      return "Cả ngày";
    case "AM":
      return "Buổi sáng";
    case "PM":
      return "Buổi chiều";
    default:
      return sessionCode;
  }
}

export function leaveSessionHalfDayUnits(sessionCode: LeaveSessionCode | string): number {
  return sessionCode === "FULL" ? 2 : 1;
}

export function leaveTypeShortLabel(leaveType: LeaveType | string): string {
  switch (leaveType) {
    case "ANNUAL":
      return "Phép năm";
    case "BEREAVEMENT":
      return "Nghỉ tang";
    case "MARRIAGE":
      return "Nghỉ cưới";
    case "SICK":
      return "Nghỉ ốm";
    case "UNPAID":
      return "Nghỉ không lương";
    default:
      return leaveType;
  }
}

export function leaveTypeLabel(leaveType: LeaveType | string): string {
  switch (leaveType) {
    case "ANNUAL":
      return "Phép năm";
    case "BEREAVEMENT":
      return "Nghỉ tang (tối đa 3 ngày/đơn)";
    case "MARRIAGE":
      return "Nghỉ cưới (tối đa 3 ngày/đơn)";
    case "SICK":
      return "Nghỉ ốm (tối đa 7 ngày/đơn)";
    case "UNPAID":
      return "Nghỉ không lương (tối đa 7 ngày/đơn)";
    default:
      return leaveType;
  }
}

export function leaveTypeBadge(leaveType: LeaveType | string): {
  label: string;
  tone: BadgeTone;
} {
  switch (leaveType) {
    case "ANNUAL":
      return { label: "Phép năm", tone: "primary" };
    case "BEREAVEMENT":
      return { label: "Nghỉ tang", tone: "neutral" };
    case "MARRIAGE":
      return { label: "Nghỉ cưới", tone: "success" };
    case "SICK":
      return { label: "Nghỉ ốm", tone: "warning" };
    case "UNPAID":
      return { label: "Nghỉ không lương", tone: "neutral" };
    default:
      return { label: leaveType, tone: "neutral" };
  }
}

export function resolveRequestTypeBreakdown(
  request: Pick<LeaveRequestProjection, "days" | "type_breakdown">,
): readonly LeaveRequestTypeBreakdownProjection[] {
  if (Array.isArray(request.type_breakdown) && request.type_breakdown.length > 0) {
    return request.type_breakdown;
  }
  const byType = new Map<string, number>();
  for (const day of request.days ?? []) {
    const t = (day.leave_type || "ANNUAL").toString();
    byType.set(t, (byType.get(t) ?? 0) + Number(day.half_day_units ?? 0));
  }
  return Array.from(byType.entries()).map(([leave_type, half_day_units]) => ({
    leave_type,
    half_day_units,
  }));
}

export function leaveEmploymentStatusBadge(status: string): {
  label: string;
  tone: BadgeTone;
} {
  switch (status) {
    case "OFFICIAL":
      return { label: "Chính thức", tone: "success" };
    case "PROBATION":
      return { label: "Thử việc", tone: "warning" };
    case "UNCONFIGURED":
      return { label: "Chưa cấu hình", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export function leaveUnitKindLabel(unitKind: string): string {
  switch (unitKind) {
    case "RECRUITMENT":
      return "Tuyển dụng";
    case "MARKETING":
      return "Marketing";
    case "IT":
      return "IT";
    case "ACCOUNTING":
      return "Kế toán";
    case "MANAGEMENT_BOD":
      return "Ban Giám đốc / Quản lý";
    case "UNCLASSIFIED":
      return "Chưa phân loại";
    default:
      return unitKind;
  }
}

export function leaveRequestStatusBadge(status: string): {
  label: string;
  tone: BadgeTone;
} {
  switch (status) {
    case "PENDING":
      return { label: "Chờ duyệt", tone: "warning" };
    case "APPROVED":
      return { label: "Đã duyệt", tone: "success" };
    case "REJECTED":
      return { label: "Từ chối", tone: "danger" };
    case "CANCELLED":
      return { label: "Đã hủy sau duyệt", tone: "neutral" };
    case "WITHDRAWN":
      return { label: "Đã tự rút", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export function leaveRouteKindLabel(
  routeKind: string,
  teamName?: string | null,
  unitKind?: string | null,
): string {
  switch (routeKind) {
    case "TEAM_LEADER":
      return teamName ? `Team Leader (${teamName})` : "Team Leader";
    case "DEPARTMENT_HEAD":
      return unitKind
        ? `Trưởng bộ phận (${leaveUnitKindLabel(unitKind)})`
        : "Trưởng bộ phận";
    case "ADMIN_BOD_DIRECT":
      return "Admin / Ban Giám đốc (trực tiếp)";
    case "ADMIN_BOD_FALLBACK":
      return "Admin / Ban Giám đốc (hàng đợi dự phòng)";
    default:
      return routeKind;
  }
}

export function leaveFallbackReasonLabel(
  fallbackReason: string | null | undefined,
): string | null {
  if (!fallbackReason) return null;
  switch (fallbackReason) {
    case "DEPARTMENT_APPROVER_NOT_CONFIGURED":
      return "Bộ phận chưa cấu hình người duyệt hiện hành";
    case "TEAM_WITHOUT_ACTIVE_LEADER":
      return "Team chưa có Team Leader đang hiệu lực";
    case "TEAM_MULTIPLE_LEADERS_OR_SELF":
      return "Team có nhiều Team Leader hoặc trùng người tạo đơn";
    case "RECRUITER_WITHOUT_ACTIVE_TEAM":
      return "Nhân sự chưa thuộc Team đang hoạt động";
    case "RECRUITER_MULTI_ACTIVE_TEAMS":
      return "Nhân sự đang thuộc nhiều Team cùng lúc";
    case "PROFILE_UNCONFIGURED_OR_UNMAPPED":
      return "Hồ sơ nghỉ phép chưa cấu hình đầy đủ hoặc chưa ánh xạ nhân sự";
    case "UNMAPPED_UNIT_OR_RECRUITER":
      return "Chưa ánh xạ đơn vị hoặc hồ sơ nhân sự tuyển dụng";
    default:
      return fallbackReason;
  }
}

export function leaveLotKindLabel(
  lotKind: string,
  accrualMonth?: number | null,
): string {
  switch (lotKind) {
    case "CARRY_OVER":
      return "Phép tồn năm trước";
    case "MONTHLY_ACCRUAL":
      return accrualMonth
        ? `Phép định kỳ tháng ${String(accrualMonth).padStart(2, "0")}`
        : "Phép định kỳ tháng";
    case "PROBATION_CATCHUP":
      return accrualMonth
        ? `Phép tính bù thử việc tháng ${String(accrualMonth).padStart(2, "0")}`
        : "Phép tính bù thử việc";
    case "SENIORITY_GRANT":
      return "Phép thâm niên";
    case "OPENING_CURRENT_YEAR":
      return "Số dư đầu kỳ năm hiện tại";
    case "MANUAL_ADJUSTMENT":
      return "Điều chỉnh thủ công";
    default:
      return lotKind;
  }
}

export function leaveLedgerEntryTypeLabel(
  entryType: string,
  deltaAvailableUnits?: number,
): string {
  switch (entryType) {
    case "GRANT_MONTHLY_ACCRUAL":
      return "Cộng phép định kỳ tháng";
    case "GRANT_PROBATION_CATCHUP":
      return "Cộng bù phép thời gian thử việc";
    case "GRANT_SENIORITY":
      return "Cộng phép thâm niên";
    case "GRANT_OPENING_CARRY_OVER":
      return "Khởi tạo phép tồn năm trước";
    case "ADJUST_OPENING_CURRENT_YEAR_DECREASE":
      return "Điều chỉnh giảm số dư đầu kỳ năm hiện tại (đối soát)";
    case "ADJUST_OPENING_CURRENT_YEAR_INCREASE":
      return "Điều chỉnh tăng số dư đầu kỳ năm hiện tại (đối soát)";
    case "GRANT_OPENING_CURRENT_YEAR":
      if (typeof deltaAvailableUnits === "number" && deltaAvailableUnits < 0) {
        return "Điều chỉnh giảm số dư đầu kỳ năm hiện tại (đối soát)";
      }
      return "Khởi tạo số dư đầu kỳ năm hiện tại";
    case "GRANT_MANUAL_ADJUSTMENT":
      return "Điều chỉnh số dư phép";
    case "RESERVE":
      return "Giữ chỗ phép (đơn ngày tương lai đã duyệt)";
    case "SETTLE_RESERVE_TO_CONSUME":
      return "Chốt phép giữ chỗ sang đã sử dụng";
    case "CONSUME":
      return "Trừ phép trực tiếp (đơn đã duyệt)";
    case "RELEASE_RESERVE":
      return "Hoàn lại phép giữ chỗ (hủy đơn)";
    case "REVERSAL_CONSUME":
      return "Hoàn lại phép đã trừ (hủy đơn đã duyệt)";
    case "EXPIRE_CARRY_OVER":
      return "Hết hạn phép tồn năm trước";
    default:
      return entryType;
  }
}

export function leaveModuleGrantRoleLabel(roleCode: LeaveModuleGrantRole | string): string {
  switch (roleCode) {
    case "HR_REPORT_VIEWER":
      return "HR xem báo cáo & xuất Excel";
    case "HR_LEAVE_OPERATOR":
      return "HR vận hành hồ sơ & số dư đầu kỳ";
    case "LEAVE_ADMIN_BOD_APPROVER":
      return "Người duyệt cấp Admin / Ban Giám đốc";
    default:
      return roleCode;
  }
}

export function leaveOpeningRowErrorLabel(errorCode: string): string {
  switch (errorCode) {
    case "ROW_NOT_OBJECT":
      return "Dữ liệu dòng không hợp lệ";
    case "INVALID_APP_USER_ID":
      return "Mã tài khoản nhân sự không hợp lệ";
    case "DUPLICATE_APP_USER_IN_BATCH":
      return "Nhân sự bị trùng lặp trong cùng danh sách nhập";
    case "APP_USER_NOT_FOUND":
      return "Không tìm thấy tài khoản nhân sự";
    case "SHARED_ACCOUNT_NOT_ELIGIBLE":
      return "Tài khoản dùng chung không thuộc diện cấp phép";
    case "EMPLOYEE_NOT_OFFICIAL":
      return "Chỉ nhân sự Chính thức mới thuộc diện khởi tạo số dư phép đầu kỳ";
    case "UNITS_OUT_OF_RANGE":
      return "Số phép vượt ngoài giới hạn hợp lệ";
    case "ZERO_UNITS_ROW":
      return "Cần nhập ít nhất một khoản phép lớn hơn 0";
    case "LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED":
      return "Chưa cấu hình hạn sử dụng phép tồn năm trước trong Chính sách nghỉ phép";
    case "CARRY_OVER_LOT_ALREADY_EXISTS":
      return "Nhân sự này đã được khởi tạo phép tồn năm trước trong năm hiện tại";
    case "SENIORITY_LOT_ALREADY_EXISTS":
      return "Nhân sự này đã được cấp phép thâm niên trong năm hiện tại (đặt Phép thâm niên = 0 khi đối soát lại phép năm nay)";
    case "OPENING_CURRENT_YEAR_LOT_ALREADY_EXISTS":
      return "Nhân sự này đã được khởi tạo số dư đầu kỳ năm hiện tại";
    case "OPENING_TARGET_BELOW_LOCKED_BALANCE":
      return "Số dư mục tiêu năm nay thấp hơn số phép đang giữ chỗ hoặc đã duyệt sử dụng trên hệ thống";
    default:
      return errorCode;
  }
}

export function leaveErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng hoặc chưa được kích hoạt.";
    case "CSRF_ORIGIN_MISMATCH":
      return "Yêu cầu bị từ chối do không hợp lệ nguồn gốc phiên. Vui lòng tải lại trang.";
    case "LEAVE_SHARED_ACCOUNT_FORBIDDEN":
      return "Tài khoản dùng chung (như tài khoản Marketing chung) không thuộc đối tượng quản lý nghỉ phép cá nhân.";
    case "LEAVE_REASON_INVALID":
    case "LEAVE_REASON_REQUIRED":
      return "Vui lòng nhập lý do hợp lệ (tối đa 2.000 ký tự).";
    case "LEAVE_REQUEST_DAYS_INVALID":
      return "Danh sách ngày xin nghỉ không hợp lệ. Vui lòng chọn các ngày nghỉ hợp lệ.";
    case "LEAVE_TYPE_INVALID":
      return "Loại nghỉ không hợp lệ. Vui lòng chọn Phép năm, Nghỉ tang, Nghỉ cưới, Nghỉ ốm hoặc Nghỉ không lương.";
    case "LEAVE_TYPE_LIMIT_EXCEEDED":
      return "Số ngày nghỉ vượt quá giới hạn tối đa mỗi yêu cầu (Nghỉ tang/Nghỉ cưới tối đa 3 ngày; Nghỉ ốm/Nghỉ không lương tối đa 7 ngày).";
    case "LEAVE_TYPE_ALLOCATION_MISMATCH":
      return "Tổng số ngày/đơn vị phân bổ theo loại nghỉ không khớp với các ngày/buổi đã chọn trong yêu cầu.";
    case "LEAVE_REQUEST_YEAR_OUT_OF_RANGE":
      return "Ngày xin nghỉ phải thuộc năm nghiệp vụ hiện hành.";
    case "LEAVE_REQUEST_DUPLICATE_DATE":
      return "Không được chọn trùng một ngày/buổi với cùng loại nghỉ nhiều lần trong cùng một đơn.";
    case "LEAVE_REQUEST_OVERLAP":
      return "Ngày hoặc buổi xin nghỉ bị trùng với một đơn đang chờ duyệt hoặc đã được duyệt.";
    case "LEAVE_INSUFFICIENT_BALANCE":
      return "Số dư phép năm khả dụng tại thời điểm ngày nghỉ không đủ cho phần Phép năm đã chọn. Bạn có thể chia yêu cầu sang Nghỉ không lương hoặc loại nghỉ phù hợp.";
    case "LEAVE_REQUEST_NOT_FOUND":
      return "Không tìm thấy đơn xin nghỉ phép.";
    case "LEAVE_REQUEST_OWNERSHIP_FORBIDDEN":
      return "Bạn chỉ được phép rút đơn xin nghỉ phép của chính mình.";
    case "LEAVE_ROW_VERSION_CONFLICT":
      return "Dữ liệu vừa được cập nhật bởi thao tác khác. Hệ thống đã làm mới, vui lòng kiểm tra và thử lại.";
    case "LEAVE_INVALID_STATE_TRANSITION":
      return "Trạng thái đơn hiện tại không cho phép thực hiện thao tác này.";
    case "LEAVE_APPROVAL_FORBIDDEN":
      return "Bạn không có thẩm quyền duyệt hoặc xử lý đơn nghỉ phép này.";
    case "LEAVE_SELF_APPROVAL_FORBIDDEN":
      return "Người duyệt không được tự duyệt hoặc tự hủy đơn nghỉ phép của chính mình.";
    case "LEAVE_DECISION_INVALID":
      return "Quyết định xử lý đơn không hợp lệ.";
    case "LEAVE_FILTER_INVALID":
      return "Bộ lọc truy vấn không hợp lệ.";
    case "LEAVE_ADMIN_FORBIDDEN":
      return "Bạn không có quyền truy cập khu vực cấu hình quản trị nghỉ phép.";
    case "LEAVE_POLICY_ADMIN_FORBIDDEN":
      return "Chỉ Admin hoặc Ban Giám đốc mới có quyền cập nhật chính sách nghỉ phép.";
    case "LEAVE_POLICY_EXPIRY_INVALID":
      return "Ngày/tháng hết hạn phép tồn năm trước không hợp lệ (tháng 1–12, ngày 1–31).";
    case "LEAVE_TARGET_USER_NOT_FOUND":
      return "Không tìm thấy tài khoản nhân sự cần cấu hình.";
    case "LEAVE_PROFILE_INVALID":
      return "Thông tin cấu hình hồ sơ nghỉ phép không hợp lệ.";
    case "LEAVE_PROFILE_WORK_START_DATE_REQUIRED":
      return "Nhân sự Thử việc hoặc Chính thức bắt buộc phải có Ngày bắt đầu làm việc.";
    case "LEAVE_PROFILE_OFFICIAL_DATE_INVALID":
      return "Ngày lên chính thức không hợp lệ (phải từ ngày bắt đầu làm việc trở đi).";
    case "LEAVE_SENIORITY_CONFIG_FORBIDDEN":
      return "Chỉ Admin hoặc Ban Giám đốc mới được cấu hình ngày và số phép tăng thâm niên tiếp theo.";
    case "LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN":
      return "Chỉ Admin hoặc Ban Giám đốc mới được cấu hình người duyệt bộ phận Marketing / IT / Kế toán.";
    case "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN":
      return "Ngày bắt đầu hiệu lực của người duyệt bộ phận không được vượt quá ngày nghiệp vụ hiện tại.";
    case "LEAVE_UNIT_KIND_INVALID":
      return "Đơn vị / bộ phận không hợp lệ.";
    case "LEAVE_APPROVER_USER_NOT_FOUND":
      return "Không tìm thấy tài khoản người duyệt hoặc tài khoản đang bị vô hiệu hóa.";
    case "LEAVE_MODULE_GRANT_ADMIN_FORBIDDEN":
      return "Chỉ Full Admin mới có quyền cấp hoặc thu hồi quyền nội bộ phân hệ nghỉ phép.";
    case "LEAVE_MODULE_GRANT_INVALID":
      return "Thông tin cấp quyền nội bộ không hợp lệ.";
    case "LEAVE_MODULE_GRANT_NOT_FOUND":
      return "Không tìm thấy bản ghi quyền nội bộ đang hiệu lực để thu hồi.";
    case "LEAVE_YEAR_INVALID":
      return "Năm nghiệp vụ nghỉ phép không hợp lệ.";
    case "LEAVE_OPENING_ROWS_INVALID":
      return "Danh sách dòng số dư đầu kỳ không hợp lệ (tối đa 300 dòng mỗi lần áp dụng).";
    case "LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED":
      return "Chưa cấu hình ngày hết hạn phép chuyển năm. Vui lòng cấu hình Chính sách nghỉ phép trước khi nhập phép tồn năm trước.";
    case "LEAVE_OPENING_BATCH_VALIDATION_FAILED":
      return "Lô số dư đầu kỳ còn dòng lỗi. Vui lòng xem trước và xử lý hết lỗi trước khi áp dụng.";
    case "LEAVE_OPENING_PREVIEW_STALE":
      return "Dữ liệu số dư hoặc hồ sơ đã thay đổi sau lần xem trước. Vui lòng bấm '1. Xem trước & Kiểm tra' lại trước khi áp dụng.";
    case "LEAVE_REPORT_FORBIDDEN":
      return "Bạn không có quyền xem hoặc xuất Báo cáo chốt công & phép tháng.";
    case "LEAVE_REPORT_YEAR_MONTH_INVALID":
      return "Kỳ báo cáo tháng không hợp lệ (định dạng YYYY-MM).";
    case "LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED":
      return "Số lượng dòng báo cáo vượt quá giới hạn xuất một lần (5.000 nhân sự). Vui lòng lọc theo bộ phận hoặc từ khóa.";
    case "LEAVE_REPORT_EXPORT_INCOMPLETE":
      return "Dữ liệu báo cáo thay đổi trong lúc xuất. Vui lòng thử xuất lại.";
    default:
      return "Không thể hoàn tất thao tác nghỉ phép lúc này. Vui lòng thử lại.";
  }
}

export function resolveVisibleLeaveTabs(
  authority: LeaveAuthorityProjection | null,
  pendingApprovalCount?: number,
): readonly LeaveWorkspaceTabDefinition[] {
  const tabs: LeaveWorkspaceTabDefinition[] = [
    { id: "personal", label: "Cá nhân & Xin nghỉ" },
  ];
  if (!authority || authority.is_shared_non_employee) {
    return tabs;
  }
  if (authority.can_approve_requests) {
    tabs.push({
      id: "approvals",
      label: "Hộp thư duyệt phép",
      ...(typeof pendingApprovalCount === "number" && pendingApprovalCount > 0
        ? { badgeCount: pendingApprovalCount }
        : {}),
    });
  }
  if (authority.can_manage_config) {
    tabs.push({
      id: "admin",
      label: "Cấu hình & Số dư đầu kỳ",
    });
  }
  if (authority.can_view_monthly_report) {
    tabs.push({
      id: "reports",
      label: "Báo cáo chốt công & phép",
    });
  }
  return tabs;
}

export type LeaveDraftDayRow = {
  id?: string;
  leave_date: string;
  session_code: LeaveSessionCode;
  leave_type: LeaveType;
};

export type LeaveDraftTypeBreakdownItem = {
  leave_type: LeaveType;
  half_day_units: number;
  days: number;
};

export type LeaveExceededTypeLimitItem = {
  leave_type: LeaveType;
  requested_units: number;
  max_units: number;
};

export type LeaveRequestDraftEvaluation = {
  valid: boolean;
  total_units: number;
  total_days: number;
  annual_units: number;
  annual_days: number;
  non_annual_units: number;
  non_annual_days: number;
  type_breakdown: readonly LeaveDraftTypeBreakdownItem[];
  exceeded_type_limits: readonly LeaveExceededTypeLimitItem[];
  duplicate_dates: readonly string[];
  invalid_dates: readonly string[];
  out_of_year_dates: readonly string[];
  exceeds_available_balance: boolean;
  can_split_excess_annual_to_unpaid: boolean;
  unpaid_notice: string | null;
  reason_error: string | null;
  blocking_error: string | null;
};

export function evaluateLeaveRequestDraft(input: {
  days: readonly {
    leave_date: string;
    session_code: LeaveSessionCode;
    leave_type?: LeaveType;
  }[];
  reason: string;
  leaveYear: number;
  balance: Pick<
    LeaveBalanceProjection,
    | "has_profile"
    | "profile_configured"
    | "employment_status"
    | "work_start_date"
    | "official_effective_date"
    | "available_units"
  > | null;
}): LeaveRequestDraftEvaluation {
  const seenByDate = new Map<
    string,
    { session_code: LeaveSessionCode; leave_type: LeaveType }[]
  >();
  const duplicateDates: string[] = [];
  const invalidDates: string[] = [];
  const outOfYearDates: string[] = [];
  const unitsByType = new Map<LeaveType, number>();
  let totalUnits = 0;

  for (const row of input.days) {
    const d = (row.leave_date ?? "").trim();
    const session = row.session_code;
    const rawLeaveType = (row.leave_type ?? "ANNUAL") as LeaveType;
    if (
      !isValidIsoDate(d) ||
      !LEAVE_SESSION_CODES.includes(session) ||
      !LEAVE_TYPES.includes(rawLeaveType)
    ) {
      invalidDates.push(d || "(trống)");
      continue;
    }
    const year = Number(d.slice(0, 4));
    if (year !== input.leaveYear) {
      outOfYearDates.push(d);
    }

    const existing = seenByDate.get(d) ?? [];
    const isDuplicate = existing.some(
      (prev) =>
        prev.session_code === "FULL" ||
        session === "FULL" ||
        prev.session_code === session ||
        prev.leave_type === rawLeaveType,
    );
    if (isDuplicate) {
      if (!duplicateDates.includes(d)) {
        duplicateDates.push(d);
      }
    } else {
      existing.push({ session_code: session, leave_type: rawLeaveType });
      seenByDate.set(d, existing);
    }

    const units = leaveSessionHalfDayUnits(session);
    totalUnits += units;
    unitsByType.set(rawLeaveType, (unitsByType.get(rawLeaveType) ?? 0) + units);
  }

  const typeBreakdown: LeaveDraftTypeBreakdownItem[] = [];
  const exceededTypeLimits: LeaveExceededTypeLimitItem[] = [];
  for (const t of LEAVE_TYPES) {
    const u = unitsByType.get(t) ?? 0;
    if (u > 0) {
      typeBreakdown.push({
        leave_type: t,
        half_day_units: u,
        days: halfDayUnitsToDays(u),
      });
      const maxUnits = LEAVE_TYPE_MAX_UNITS_PER_REQUEST[t];
      if (maxUnits !== null && u > maxUnits) {
        exceededTypeLimits.push({
          leave_type: t,
          requested_units: u,
          max_units: maxUnits,
        });
      }
    }
  }

  const annualUnits = unitsByType.get("ANNUAL") ?? 0;
  const nonAnnualUnits = totalUnits - annualUnits;
  const availableUnits = Math.max(0, input.balance?.available_units ?? 0);
  const exceedsAvailableBalance = annualUnits > availableUnits;
  const currentUnpaidUnits = unitsByType.get("UNPAID") ?? 0;
  const excessAnnualUnits = Math.max(0, annualUnits - availableUnits);
  const canSplitExcessAnnualToUnpaid =
    exceedsAvailableBalance &&
    excessAnnualUnits > 0 &&
    currentUnpaidUnits + excessAnnualUnits <=
      (LEAVE_TYPE_MAX_UNITS_PER_REQUEST.UNPAID ?? 14);

  const trimmedReason = (input.reason ?? "").trim();
  const reasonError =
    trimmedReason.length > 2000
      ? "Lý do không được vượt quá 2.000 ký tự."
      : null;

  let blockingError: string | null = null;
  if (input.days.length === 0) {
    blockingError = "Vui lòng thêm ít nhất 1 ngày xin nghỉ.";
  } else if (input.days.length > 120) {
    blockingError = "Mỗi đơn chỉ được đăng ký tối đa 120 dòng ngày/buổi nghỉ.";
  } else if (invalidDates.length > 0) {
    blockingError = "Vui lòng chọn đầy đủ ngày nghỉ hợp lệ (YYYY-MM-DD) và loại nghỉ.";
  } else if (duplicateDates.length > 0) {
    blockingError = `Ngày/buổi nghỉ bị trùng lặp trong cùng đơn: ${duplicateDates.map(formatIsoDateVi).join(", ")}.`;
  } else if (outOfYearDates.length > 0) {
    blockingError = `Ngày nghỉ phải nằm trong năm ${input.leaveYear}: ${outOfYearDates.map(formatIsoDateVi).join(", ")}.`;
  } else if (exceededTypeLimits.length > 0) {
    const first = exceededTypeLimits[0];
    blockingError = `Loại nghỉ '${leaveTypeShortLabel(first.leave_type)}' đang chọn ${formatHalfDayUnits(first.requested_units)}, vượt quá giới hạn tối đa ${formatHalfDayUnits(first.max_units)} mỗi yêu cầu.`;
  } else if (exceedsAvailableBalance) {
    blockingError = `Phần Phép năm đã chọn (${formatHalfDayUnits(annualUnits)}) vượt quá số dư phép năm khả dụng hiện tại (${formatHalfDayUnits(availableUnits)}). Hãy chuyển phần vượt quá sang Nghỉ không lương hoặc loại nghỉ phù hợp.`;
  } else if (reasonError !== null) {
    blockingError = reasonError;
  }

  return {
    valid: blockingError === null,
    total_units: totalUnits,
    total_days: halfDayUnitsToDays(totalUnits),
    annual_units: annualUnits,
    annual_days: halfDayUnitsToDays(annualUnits),
    non_annual_units: nonAnnualUnits,
    non_annual_days: halfDayUnitsToDays(nonAnnualUnits),
    type_breakdown: typeBreakdown,
    exceeded_type_limits: exceededTypeLimits,
    duplicate_dates: duplicateDates,
    invalid_dates: invalidDates,
    out_of_year_dates: outOfYearDates,
    exceeds_available_balance: exceedsAvailableBalance,
    can_split_excess_annual_to_unpaid: canSplitExcessAnnualToUnpaid,
    unpaid_notice:
      nonAnnualUnits > 0
        ? "Các loại nghỉ ngoài Phép năm (Nghỉ tang, Nghỉ cưới, Nghỉ ốm, Nghỉ không lương) không trừ vào số dư phép năm khả dụng."
        : null,
    reason_error: reasonError,
    blocking_error: blockingError,
  };
}

/**
 * Splits/allocates `"ANNUAL"` draft rows so that at most `availableAnnualUnits`
 * remain `"ANNUAL"` and any remaining `"ANNUAL"` units become `fallbackLeaveType`
 * (default `"UNPAID"`), splitting a `"FULL"` day into `"AM"` + `"PM"` if the
 * balance boundary lands on a half-day.
 */
export function autoAllocateDraftDaysByBalance(
  days: readonly LeaveDraftDayRow[],
  availableAnnualUnits: number,
  fallbackLeaveType: LeaveType = "UNPAID",
): LeaveDraftDayRow[] {
  let remainingAnnual = Math.max(0, Math.trunc(availableAnnualUnits));
  const result: LeaveDraftDayRow[] = [];

  for (const row of days) {
    const leaveType = row.leave_type ?? "ANNUAL";
    if (leaveType !== "ANNUAL") {
      result.push({ ...row, leave_type: leaveType });
      continue;
    }

    const rowUnits = leaveSessionHalfDayUnits(row.session_code);
    if (remainingAnnual >= rowUnits) {
      remainingAnnual -= rowUnits;
      result.push({ ...row, leave_type: "ANNUAL" });
    } else if (remainingAnnual === 1 && row.session_code === "FULL") {
      remainingAnnual = 0;
      result.push({
        ...(row.id ? { id: `${row.id}-am` } : {}),
        leave_date: row.leave_date,
        session_code: "AM",
        leave_type: "ANNUAL",
      });
      result.push({
        ...(row.id ? { id: `${row.id}-pm` } : {}),
        leave_date: row.leave_date,
        session_code: "PM",
        leave_type: fallbackLeaveType,
      });
    } else {
      result.push({
        ...row,
        leave_type: fallbackLeaveType,
      });
    }
  }

  return result;
}

export function canWithdrawOwnLeaveRequest(input: {
  actorAppUserId: string | null | undefined;
  request: Pick<LeaveRequestProjection, "app_user_id" | "status">;
}): boolean {
  if (!input.actorAppUserId) return false;
  return (
    input.request.app_user_id.toLowerCase() === input.actorAppUserId.toLowerCase() &&
    input.request.status === "PENDING"
  );
}

export function validateApproverDecisionInput(input: {
  actorAppUserId: string | null | undefined;
  request: Pick<LeaveRequestProjection, "app_user_id" | "status">;
  decision: LeaveDecisionCode;
  reason: string;
}): { ok: true } | { ok: false; message: string } {
  if (!input.actorAppUserId) {
    return { ok: false, message: "Chưa xác định được người duyệt hiện tại." };
  }
  if (input.actorAppUserId.toLowerCase() === input.request.app_user_id.toLowerCase()) {
    return {
      ok: false,
      message: "Người duyệt không được tự duyệt hoặc tự hủy đơn nghỉ phép của chính mình.",
    };
  }
  if (input.decision === "APPROVE") {
    if (input.request.status !== "PENDING") {
      return { ok: false, message: "Chỉ có thể duyệt đơn đang ở trạng thái Chờ duyệt." };
    }
    return { ok: true };
  }
  if (input.decision === "REJECT") {
    if (input.request.status !== "PENDING") {
      return { ok: false, message: "Chỉ có thể từ chối đơn đang ở trạng thái Chờ duyệt." };
    }
    if (input.reason.trim().length > 2000) {
      return { ok: false, message: "Lý do không được vượt quá 2.000 ký tự." };
    }
    return { ok: true };
  }
  if (input.decision === "CANCEL_APPROVED") {
    if (input.request.status !== "APPROVED") {
      return {
        ok: false,
        message: "Chỉ có thể hủy đơn đã ở trạng thái Đã duyệt để hoàn lại phép.",
      };
    }
    if (input.reason.trim().length > 2000) {
      return { ok: false, message: "Lý do không được vượt quá 2.000 ký tự." };
    }
    return { ok: true };
  }
  return { ok: false, message: "Quyết định xử lý đơn không hợp lệ." };
}

export function computeOpeningBatchDraftSignature(
  leaveYear: number,
  rows: readonly OpeningBatchRowInput[],
): string {
  const normalized = rows.map((row) => ({
    app_user_id: (row.app_user_id ?? "").trim().toLowerCase(),
    carry_over_units: Number(row.carry_over_units ?? 0),
    opening_current_year_units: Number(row.opening_current_year_units ?? 0),
    seniority_units: Number(row.seniority_units ?? 0),
    note: row.note && row.note.trim().length > 0 ? row.note.trim() : null,
  }));
  return JSON.stringify({ leave_year: Number(leaveYear), rows: normalized });
}

export function canApplyOpeningBatch(input: {
  leaveYear: number;
  rows: readonly OpeningBatchRowInput[];
  preview: LeaveOpeningPreviewProjection | null;
  previewSignature: string | null;
}): { ok: boolean; blockingReason: string | null } {
  if (input.rows.length === 0) {
    return { ok: false, blockingReason: "Vui lòng thêm ít nhất 1 nhân sự vào danh sách số dư đầu kỳ." };
  }
  if (!input.preview || !input.previewSignature) {
    return {
      ok: false,
      blockingReason: "Bắt buộc bấm 'Xem trước & Kiểm tra' trước khi áp dụng số dư đầu kỳ.",
    };
  }
  const currentSignature = computeOpeningBatchDraftSignature(input.leaveYear, input.rows);
  if (input.previewSignature !== currentSignature) {
    return {
      ok: false,
      blockingReason:
        "Danh sách số dư đầu kỳ đã thay đổi sau lần xem trước. Vui lòng bấm 'Xem trước & Kiểm tra' lại.",
    };
  }
  if (!input.preview.valid || input.preview.error_row_count > 0) {
    return {
      ok: false,
      blockingReason: `Bản xem trước còn ${input.preview.error_row_count} dòng lỗi. Vui lòng sửa lỗi rồi xem trước lại.`,
    };
  }
  return { ok: true, blockingReason: null };
}

export function buildOpeningBatchApplyRows(
  rows: readonly OpeningBatchRowInput[],
  preview: LeaveOpeningPreviewProjection | null,
): OpeningBatchRowInput[] {
  return rows.map((row, idx) => {
    const previewRow = preview?.rows[idx];
    const asOfDate =
      previewRow?.as_of_date ?? preview?.as_of_date ?? undefined;
    return {
      ...row,
      ...(typeof asOfDate === "string" && asOfDate.trim().length > 0
        ? { expected_as_of_date: asOfDate.trim() }
        : {}),
      ...(typeof previewRow?.current_year_granted_units === "number" &&
      Number.isInteger(previewRow.current_year_granted_units)
        ? {
            expected_current_year_granted_units:
              previewRow.current_year_granted_units,
          }
        : {}),
      ...(typeof previewRow?.current_year_locked_units === "number" &&
      Number.isInteger(previewRow.current_year_locked_units)
        ? {
            expected_current_year_locked_units:
              previewRow.current_year_locked_units,
          }
        : {}),
      ...(typeof previewRow?.profile_row_version === "number" &&
      Number.isInteger(previewRow.profile_row_version)
        ? { expected_profile_row_version: previewRow.profile_row_version }
        : {}),
    };
  });
}

export function resolveAppliedOpeningRowCount(
  payload: unknown,
  fallbackRowCount = 0,
): number {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const directCount = Number(record.applied_row_count);
    if (Number.isInteger(directCount) && directCount >= 0) {
      return directCount;
    }
    if (typeof record.batch === "object" && record.batch !== null) {
      const batchCount = Number(
        (record.batch as Record<string, unknown>).row_count,
      );
      if (Number.isInteger(batchCount) && batchCount >= 0) {
        return batchCount;
      }
    }
    if (Array.isArray(record.applied_rows)) {
      return record.applied_rows.length;
    }
  }
  return Number.isInteger(fallbackRowCount) && fallbackRowCount > 0
    ? fallbackRowCount
    : 0;
}

export type LeaveAdminAccountOption = {
  app_user_id: string;
  label: string;
  display_name: string;
  login_id: string | null;
  personnel_code: string | null;
};

export const ADMIN_EMPLOYEE_OPTIONS_PAGE_SIZE = 300;
export const MAX_ADMIN_EMPLOYEE_OPTION_PAGES = 20;

export function isEligibleLeaveAdminDropdownEmployee(
  emp:
    | Pick<LeaveAdminEmployeeItemProjection, "account" | "profile">
    | null
    | undefined,
): boolean {
  if (!emp?.account || typeof emp.account.app_user_id !== "string") {
    return false;
  }
  if (emp.account.app_user_id.trim().length === 0) {
    return false;
  }
  if (emp.account.account_enabled === false) {
    return false;
  }
  if (emp.profile?.is_shared_non_employee === true) {
    return false;
  }
  return true;
}

export function isEligibleLeaveOpeningBalanceEmployee(
  emp:
    | (Pick<LeaveAdminEmployeeItemProjection, "account" | "profile"> &
        Partial<Pick<LeaveAdminEmployeeItemProjection, "balance">>)
    | null
    | undefined,
): boolean {
  if (!isEligibleLeaveAdminDropdownEmployee(emp)) {
    return false;
  }
  const status =
    emp?.profile?.employment_status ?? emp?.balance?.employment_status;
  return status === "OFFICIAL";
}

export function formatLeaveAdminAccountOptionLabel(
  account: Pick<
    LeaveAccountProjection,
    "app_user_id" | "display_name" | "login_id" | "personnel_code"
  >,
): string {
  const displayName = (account.display_name ?? "").trim();
  const loginId = (account.login_id ?? "").trim();
  const personnelCode = (account.personnel_code ?? "").trim();
  const baseName =
    displayName || loginId || personnelCode || account.app_user_id.trim();
  if (displayName && loginId) {
    return `${displayName} (@${loginId})`;
  }
  if (displayName && personnelCode) {
    return `${displayName} (${personnelCode})`;
  }
  return baseName;
}

export function resolveLeaveAdminDropdownEmployees(
  employees: readonly LeaveAdminEmployeeItemProjection[],
): LeaveAdminEmployeeItemProjection[] {
  const seen = new Set<string>();
  const eligible: LeaveAdminEmployeeItemProjection[] = [];
  for (const emp of employees) {
    if (!isEligibleLeaveAdminDropdownEmployee(emp)) {
      continue;
    }
    const key = emp.account.app_user_id.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    eligible.push(emp);
  }
  return eligible;
}

export function resolveLeaveOpeningBalanceEmployees(
  employees: readonly LeaveAdminEmployeeItemProjection[],
): LeaveAdminEmployeeItemProjection[] {
  return resolveLeaveAdminDropdownEmployees(employees).filter((emp) =>
    isEligibleLeaveOpeningBalanceEmployee(emp),
  );
}

export function resolveAdminSelectorEmployeeOptions(input: {
  optionCatalogEmployees: readonly LeaveAdminEmployeeItemProjection[];
  fallbackPageEmployees?: readonly LeaveAdminEmployeeItemProjection[];
  optionCatalogLoaded: boolean;
}): LeaveAdminEmployeeItemProjection[] {
  if (input.optionCatalogLoaded) {
    return resolveLeaveAdminDropdownEmployees(input.optionCatalogEmployees);
  }
  return resolveLeaveAdminDropdownEmployees(
    input.optionCatalogEmployees.length > 0
      ? input.optionCatalogEmployees
      : (input.fallbackPageEmployees ?? []),
  );
}

export function mergeLeaveAdminKnownAccounts(
  existingById: ReadonlyMap<string, LeaveAccountProjection>,
  ...accountCollections: ReadonlyArray<
    ReadonlyArray<LeaveAccountProjection | null | undefined>
  >
): Map<string, LeaveAccountProjection> {
  const next = new Map<string, LeaveAccountProjection>(existingById);
  for (const collection of accountCollections) {
    for (const acc of collection) {
      if (!acc || typeof acc.app_user_id !== "string") {
        continue;
      }
      const key = acc.app_user_id.trim().toLowerCase();
      if (!key) {
        continue;
      }
      next.set(key, acc);
    }
  }
  return next;
}

export function resolveKnownLeaveAccountLabel(
  appUserId: string,
  knownAccountsById?: ReadonlyMap<string, LeaveAccountProjection>,
  eligibleEmployees?: readonly LeaveAdminEmployeeItemProjection[],
  fallbackLabel?: string | null,
): string {
  const trimmed = (appUserId ?? "").trim();
  if (!trimmed) {
    return "";
  }
  const key = trimmed.toLowerCase();
  if (eligibleEmployees) {
    const matched = eligibleEmployees.find(
      (emp) => emp.account.app_user_id.trim().toLowerCase() === key,
    );
    if (matched) {
      const formatted = formatLeaveAdminAccountOptionLabel(matched.account);
      if (formatted.toLowerCase() !== key) {
        return formatted;
      }
    }
  }
  const known = knownAccountsById?.get(key);
  if (known) {
    const formatted = formatLeaveAdminAccountOptionLabel(known);
    if (formatted.toLowerCase() !== key) {
      return formatted;
    }
  }
  if (typeof fallbackLabel === "string" && fallbackLabel.trim().length > 0) {
    return fallbackLabel.trim();
  }
  return trimmed;
}

export function resolveOpeningRowSelectOptions(input: {
  eligibleEmployees: readonly LeaveAdminEmployeeItemProjection[];
  selectedAppUserId: string;
  knownAccountsById?: ReadonlyMap<string, LeaveAccountProjection>;
  fallbackLabel?: string | null;
}): LeaveAdminAccountOption[] {
  const eligible = resolveLeaveOpeningBalanceEmployees(input.eligibleEmployees);
  const selectedKey = (input.selectedAppUserId ?? "").trim().toLowerCase();

  return eligible.map((emp) => {
    const empKey = emp.account.app_user_id.trim().toLowerCase();
    const isSelected = selectedKey.length > 0 && empKey === selectedKey;
    const label = resolveKnownLeaveAccountLabel(
      emp.account.app_user_id,
      input.knownAccountsById,
      [emp],
      isSelected ? input.fallbackLabel : null,
    );
    const known = input.knownAccountsById?.get(empKey);
    return {
      app_user_id: emp.account.app_user_id,
      label,
      display_name:
        emp.account.display_name?.trim() ||
        known?.display_name?.trim() ||
        label,
      login_id: emp.account.login_id ?? known?.login_id ?? null,
      personnel_code: emp.account.personnel_code ?? known?.personnel_code ?? null,
    };
  });
}

export async function fetchAllLeaveAdminEmployeeOptions(
  fetchPage: (query: {
    limit: number;
    offset: number;
    account_status: LeaveAdminAccountStatusFilter;
  }) => Promise<
    | {
        ok: true;
        data: Pick<
          LeaveAdminOverviewProjection,
          "total_employees" | "employees"
        >;
      }
    | {
        ok: false;
        errorCode?: string;
      }
  >,
  pageSize = ADMIN_EMPLOYEE_OPTIONS_PAGE_SIZE,
): Promise<
  | {
      ok: true;
      allEmployees: LeaveAdminEmployeeItemProjection[];
      employees: LeaveAdminEmployeeItemProjection[];
    }
  | {
      ok: false;
      errorCode: string;
    }
> {
  const boundedPageSize = Math.max(
    1,
    Math.min(Math.trunc(pageSize), ADMIN_EMPLOYEE_OPTIONS_PAGE_SIZE),
  );
  const first = await fetchPage({
    limit: boundedPageSize,
    offset: 0,
    account_status: "ACTIVE",
  });
  if (!first.ok) {
    return {
      ok: false,
      errorCode: first.errorCode ?? "LEAVE_INTERNAL_ERROR",
    };
  }

  const firstRows = Array.isArray(first.data.employees)
    ? first.data.employees
    : [];
  const total = Number.isFinite(Number(first.data.total_employees))
    ? Math.max(0, Math.trunc(Number(first.data.total_employees)))
    : firstRows.length;

  const allEmployees: LeaveAdminEmployeeItemProjection[] = [...firstRows];
  let pagesFetched = 1;

  while (
    allEmployees.length < total &&
    pagesFetched < MAX_ADMIN_EMPLOYEE_OPTION_PAGES
  ) {
    const next = await fetchPage({
      limit: boundedPageSize,
      offset: allEmployees.length,
      account_status: "ACTIVE",
    });
    if (!next.ok) {
      return {
        ok: false,
        errorCode: next.errorCode ?? "LEAVE_INTERNAL_ERROR",
      };
    }
    const nextRows = Array.isArray(next.data.employees)
      ? next.data.employees
      : [];
    if (nextRows.length === 0) {
      break;
    }
    allEmployees.push(...nextRows);
    pagesFetched += 1;
  }

  return {
    ok: true,
    allEmployees,
    employees: resolveLeaveAdminDropdownEmployees(allEmployees),
  };
}

export type ParsedBulkOpeningTextResult = {
  rows: OpeningBatchRowInput[];
  parseErrors: string[];
};

/**
 * Parses TSV/CSV/semicolon lines into `OpeningBatchRowInput[]`.
 * Expected columns per line:
 *   `Identifier (personnel_code | login_id | app_user_id) | carry_over_days | opening_current_year_days | seniority_days | note?`
 */
export function parseOpeningBalanceBulkText(
  rawText: string,
  employees: readonly LeaveAdminEmployeeItemProjection[],
): ParsedBulkOpeningTextResult {
  const byIdentifier = new Map<string, string>();
  for (const emp of employees) {
    if (!isEligibleLeaveOpeningBalanceEmployee(emp)) {
      continue;
    }
    const uid = emp.account.app_user_id.trim().toLowerCase();
    if (!uid) {
      continue;
    }
    byIdentifier.set(uid, uid);
    if (emp.account.personnel_code) {
      byIdentifier.set(emp.account.personnel_code.trim().toLowerCase(), uid);
    }
    if (emp.account.login_id) {
      byIdentifier.set(emp.account.login_id.trim().toLowerCase(), uid);
    }
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const rows: OpeningBatchRowInput[] = [];
  const parseErrors: string[] = [];

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    const parts = line.includes("\t")
      ? line.split("\t").map((p) => p.trim())
      : line.split(/[;|]/).length > 1
        ? line.split(/[;|]/).map((p) => p.trim())
        : line.split(",").map((p) => p.trim());

    if (parts.length < 2) {
      parseErrors.push(
        `Dòng ${lineNum}: Không đủ cột dữ liệu (cần ít nhất: Mã NV/Login, Phép tồn ngày, [Đầu kỳ ngày], [Thâm niên ngày], [Ghi chú]).`,
      );
      return;
    }

    const rawId = parts[0].toLowerCase();
    // Skip header row if pasted from Excel
    if (
      lineNum === 1 &&
      (rawId === "ma_nv" ||
        rawId === "mã nv" ||
        rawId === "personnel_code" ||
        rawId === "login_id" ||
        rawId === "app_user_id")
    ) {
      return;
    }

    const resolvedUserId = byIdentifier.get(rawId) ?? null;
    if (!resolvedUserId) {
      parseErrors.push(
        `Dòng ${lineNum}: Không tìm thấy nhân sự chính thức khớp với '${parts[0]}'.`,
      );
      return;
    }

    const carryUnits = parseDaysInputToHalfDayUnits(parts[1] ?? "0", 120);
    const openUnits = parseDaysInputToHalfDayUnits(parts[2] ?? "0", 120);
    const senUnits = parseDaysInputToHalfDayUnits(parts[3] ?? "0", 60);

    if (carryUnits === null || openUnits === null || senUnits === null) {
      parseErrors.push(
        `Dòng ${lineNum} (${parts[0]}): Số ngày phép phải là bội số 0,5 ngày không âm (ví dụ: 0, 0.5, 1, 1.5).`,
      );
      return;
    }

    const note = parts[4] && parts[4].length > 0 ? parts[4].slice(0, 500) : null;
    rows.push({
      app_user_id: resolvedUserId,
      carry_over_units: carryUnits,
      opening_current_year_units: openUnits,
      seniority_units: senUnits,
      note,
    });
  });

  return { rows, parseErrors };
}

export function buildMonthlyLeaveReportQuery(input: {
  month: string;
  unit_kind?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}): string {
  const params = new URLSearchParams();
  params.set("month", input.month.trim());
  const unit = (input.unit_kind ?? "").trim().toUpperCase();
  if (unit.length > 0 && unit !== "ALL") {
    params.set("unit_kind", unit);
  }
  const search = (input.search ?? "").trim();
  if (search.length > 0) {
    params.set("search", search);
  }
  if (typeof input.limit === "number") {
    params.set("limit", String(input.limit));
  }
  if (typeof input.offset === "number" && input.offset > 0) {
    params.set("offset", String(input.offset));
  }
  return `?${params.toString()}`;
}

export function buildMonthlyLeaveReportExportUrl(input: {
  month: string;
  unit_kind?: string | null;
  search?: string | null;
}): string {
  const query = buildMonthlyLeaveReportQuery({
    month: input.month,
    unit_kind: input.unit_kind,
    search: input.search,
  });
  return `/api/leave/reports/monthly/export${query}`;
}

export function newClientIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type DepartmentApproverMutationPayload = {
  operation: "SET_DEPARTMENT_APPROVER";
  unit_kind: LeaveDepartmentApproverUnitKind;
  approver_app_user_id: string;
  valid_from: null;
  expected_row_version: number;
  reason: string | null;
  idempotency_key: string;
};

export function resolveDepartmentApproverMutationPayload(input: {
  unitKind: LeaveDepartmentApproverUnitKind;
  approverAppUserId: string;
  expectedRowVersion: number;
  reason: string | null | undefined;
  pendingPayload?: DepartmentApproverMutationPayload | null;
  createIdempotencyKey?: () => string;
}): DepartmentApproverMutationPayload {
  const normalizedApprover = input.approverAppUserId.trim();
  const normalizedReason = (input.reason ?? "").trim() || null;
  const pending = input.pendingPayload ?? null;

  if (
    pending &&
    pending.operation === "SET_DEPARTMENT_APPROVER" &&
    pending.unit_kind === input.unitKind &&
    pending.approver_app_user_id === normalizedApprover &&
    pending.valid_from === null &&
    pending.expected_row_version === input.expectedRowVersion &&
    pending.reason === normalizedReason &&
    pending.idempotency_key.trim().length > 0
  ) {
    return pending;
  }

  const nextKey = input.createIdempotencyKey
    ? input.createIdempotencyKey()
    : newClientIdempotencyKey("leave-dept-approver");

  return {
    operation: "SET_DEPARTMENT_APPROVER",
    unit_kind: input.unitKind,
    approver_app_user_id: normalizedApprover,
    valid_from: null,
    expected_row_version: input.expectedRowVersion,
    reason: normalizedReason,
    idempotency_key: nextKey,
  };
}

export function isAmbiguousLeaveMutationFailure(
  outcome:
    | "network_error"
    | {
        ok: boolean;
        status: number;
        errorCode?: string | null;
      },
): boolean {
  if (outcome === "network_error") return true;
  if (outcome.ok) return false;
  if (
    outcome.status === 408 ||
    outcome.status === 429 ||
    outcome.status === 431 ||
    outcome.status >= 500
  ) {
    return true;
  }
  return (
    outcome.errorCode === "LEAVE_UNAVAILABLE" ||
    outcome.errorCode === "LEAVE_INTERNAL_ERROR"
  );
}

export function formatSignedHalfDayUnits(unitsDelta: number): string {
  if (!Number.isFinite(unitsDelta) || unitsDelta === 0) return "0 ngày";
  const sign = unitsDelta > 0 ? "+" : "-";
  return `${sign}${formatHalfDayUnits(Math.abs(unitsDelta), true)}`;
}

export function leaveDecisionActionLabel(decision: LeaveDecisionCode | string): string {
  switch (decision) {
    case "APPROVE":
      return "Duyệt đơn nghỉ phép";
    case "REJECT":
      return "Từ chối đơn nghỉ phép";
    case "CANCEL_APPROVED":
      return "Hủy đơn đã duyệt (hoàn phép)";
    default:
      return decision;
  }
}

export function currentVietnamLeaveYear(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
  }).formatToParts(now);
  const yr = Number(parts.find((p) => p.type === "year")?.value ?? now.getFullYear());
  return Number.isInteger(yr) ? yr : 2026;
}

export function currentVietnamMonthIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const yr = parts.find((p) => p.type === "year")?.value ?? "2026";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${yr}-${mo}`;
}

export function todayVietnamIsoDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const yr = parts.find((p) => p.type === "year")?.value ?? "2026";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const da = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${yr}-${mo}-${da}`;
}
