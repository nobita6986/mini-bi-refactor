import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_DISTANCE_STATUSES,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_PAGE,
  ATTENDANCE_REPORT_MAX_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_SEARCH_LENGTH,
  isValidIsoCalendarDate,
  projectHqLocation,
  type AttendanceDistanceStatus,
  type AttendanceHqLocationProjection,
} from "./attendance-report-contract.ts";

export const ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT = 1_000;
export const ATTENDANCE_MONTHLY_MATRIX_EXPORT_PAGE_SIZE = 100;
export const ATTENDANCE_MONTHLY_MATRIX_EXPORT_FALLBACK_PAGE_SIZE =
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YEAR_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const SLOT_PROFILE_CODE_INPUT_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{1,63}$/;
export const SLOT_PROFILE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES = [
  "CHECKED_IN",
  "APPROVED_LEAVE",
  "CHECKED_IN_AND_LEAVE",
  "NO_CHECKIN",
  "UPCOMING",
] as const;

export type AttendanceMonthlyMatrixDayStatus =
  (typeof ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES)[number];

export const ATTENDANCE_DISTANCE_TARGET_KINDS = ["HQ", "BRANCH"] as const;
export type AttendanceDistanceTargetKind =
  (typeof ATTENDANCE_DISTANCE_TARGET_KINDS)[number];

export const ATTENDANCE_MATRIX_LEAVE_SESSION_CODES = ["FULL", "AM", "PM"] as const;
export type AttendanceMatrixLeaveSessionCode =
  (typeof ATTENDANCE_MATRIX_LEAVE_SESSION_CODES)[number];

export const ATTENDANCE_MATRIX_LEAVE_TYPES = [
  "ANNUAL",
  "BEREAVEMENT",
  "MARRIAGE",
  "SICK",
  "UNPAID",
  "MATERNITY",
] as const;
export type AttendanceMatrixLeaveType = (typeof ATTENDANCE_MATRIX_LEAVE_TYPES)[number];

export const ATTENDANCE_SLOT_MIN_COUNT = 1;
export const ATTENDANCE_SLOT_MAX_COUNT = 12;

export const ATTENDANCE_SLOT_CODES = [
  "SLOT_1",
  "SLOT_2",
  "SLOT_3",
  "SLOT_4",
  "SLOT_5",
  "SLOT_6",
  "SLOT_7",
  "SLOT_8",
  "SLOT_9",
  "SLOT_10",
  "SLOT_11",
  "SLOT_12",
] as const;
export type AttendanceSlotCode = (typeof ATTENDANCE_SLOT_CODES)[number];

export const ATTENDANCE_SLOT_SESSION_CODES = ["AM", "PM"] as const;
export type AttendanceSlotSessionCode = (typeof ATTENDANCE_SLOT_SESSION_CODES)[number];

export const ATTENDANCE_SLOT_STATUSES = [
  "ON_TIME",
  "OUT_OF_GRACE",
  "LEAVE_COVERED",
  "MISSING",
  "EXPLAINED_APPROVED",
  "UPCOMING",
] as const;
export type AttendanceSlotStatus = (typeof ATTENDANCE_SLOT_STATUSES)[number];

export const ATTENDANCE_EXPLANATION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;
export type AttendanceExplanationStatus =
  (typeof ATTENDANCE_EXPLANATION_STATUSES)[number];

export const ATTENDANCE_EXPLANATION_ORIGINAL_SLOT_STATUSES = [
  "MISSING",
  "OUT_OF_GRACE",
] as const;
export type AttendanceExplanationOriginalSlotStatus =
  (typeof ATTENDANCE_EXPLANATION_ORIGINAL_SLOT_STATUSES)[number];

export const ATTENDANCE_EXPLANATION_DECISIONS = ["APPROVE", "REJECT"] as const;
export type AttendanceExplanationDecision =
  (typeof ATTENDANCE_EXPLANATION_DECISIONS)[number];

export const ATTENDANCE_EXPLANATION_MIN_REASON_LENGTH = 3;
export const ATTENDANCE_EXPLANATION_MAX_REASON_LENGTH = 500;
export const ATTENDANCE_EXPLANATION_MAX_DECISION_NOTE_LENGTH = 500;

export const ATTENDANCE_EXPLANATION_ROUTE_KINDS = [
  "TEAM_LEADER",
  "DEPARTMENT_HEAD",
  "ADMIN_BOD_DIRECT",
  "ADMIN_BOD_FALLBACK",
  "RECRUITMENT_TEAM_LEADER",
  "RECRUITMENT_HEAD",
  "ACCOUNTING_HEAD",
  "LEGAL_ADMIN_HEAD",
  "BOD_DIRECT",
] as const;
export type AttendanceExplanationRouteKind =
  (typeof ATTENDANCE_EXPLANATION_ROUTE_KINDS)[number];

export const ATTENDANCE_EXPLANATION_UNIT_KINDS = [
  "UNCLASSIFIED",
  "RECRUITMENT",
  "MARKETING",
  "IT",
  "ACCOUNTING",
  "MANAGEMENT_BOD",
  "LEGAL_ADMIN",
] as const;
export type AttendanceExplanationUnitKind =
  (typeof ATTENDANCE_EXPLANATION_UNIT_KINDS)[number];

export const ATTENDANCE_EXPLANATION_FALLBACK_REASONS = [
  "DEPARTMENT_APPROVER_NOT_CONFIGURED",
  "TEAM_WITHOUT_ACTIVE_LEADER",
  "TEAM_MULTIPLE_LEADERS_OR_SELF",
  "RECRUITER_WITHOUT_ACTIVE_TEAM",
  "RECRUITER_MULTI_ACTIVE_TEAMS",
  "PROFILE_UNCONFIGURED_OR_UNMAPPED",
  "UNMAPPED_UNIT_OR_RECRUITER",
  "UNCONFIGURED_UNIT",
  "MISSING_RECRUITMENT_TEAM",
  "MISSING_TEAM_LEADER",
  "TEAM_LEADER_SELF",
  "MISSING_DEPARTMENT_HEAD",
  "DEPARTMENT_HEAD_SELF",
  "PRIVILEGED_REQUESTER",
] as const;
export type AttendanceExplanationFallbackReason =
  (typeof ATTENDANCE_EXPLANATION_FALLBACK_REASONS)[number];

export const ATTENDANCE_CHECKIN_DEVIATION_STATUSES = [
  "ON_TIME",
  "EARLY",
  "LATE",
] as const;
export type AttendanceCheckinDeviationStatus =
  (typeof ATTENDANCE_CHECKIN_DEVIATION_STATUSES)[number];

export const ATTENDANCE_SLOT_MAX_GRACE_MINUTES = 240;

export const ATTENDANCE_MONTHLY_MATRIX_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "ATTENDANCE_REPORT_ACCESS_DENIED",
  "ATTENDANCE_BRANCH_WRITE_DENIED",
  "ATTENDANCE_SLOT_POLICY_WRITE_DENIED",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "BODY_TOO_LARGE",
  "ATTENDANCE_REPORT_QUERY_INVALID",
  "ATTENDANCE_MATRIX_MONTH_INVALID",
  "ATTENDANCE_REPORT_PAGINATION_INVALID",
  "ATTENDANCE_REPORT_SEARCH_INVALID",
  "ATTENDANCE_REPORT_EMPLOYEE_INVALID",
  "ATTENDANCE_REPORT_BRANCH_INVALID",
  "ATTENDANCE_REPORT_FILTER_CONFLICT",
  "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED",
  "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE",
  "ATTENDANCE_BRANCH_INVALID",
  "ATTENDANCE_BRANCH_NOT_FOUND",
  "ATTENDANCE_BRANCH_CODE_CONFLICT",
  "ATTENDANCE_BRANCH_VERSION_CONFLICT",
  "ATTENDANCE_BRANCH_INACTIVE",
  "ATTENDANCE_BRANCH_TARGET_USER_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE",
  "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND",
  "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP",
  "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED",
  "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
  "ATTENDANCE_SLOT_POLICY_INVALID",
  "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST",
  "ATTENDANCE_SLOT_POLICY_OVERLAP",
  "ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT",
  "ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND",
  "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID",
  "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID",
  "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT",
  "ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE",
  "ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN",
  "ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT",
  "ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID",
  "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT",
  "ATTENDANCE_EXPLANATION_INVALID",
  "ATTENDANCE_EXPLANATION_QUERY_INVALID",
  "ATTENDANCE_EXPLANATION_DATE_INVALID",
  "ATTENDANCE_EXPLANATION_DATE_FUTURE",
  "ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED",
  "ATTENDANCE_EXPLANATION_SLOT_INVALID",
  "ATTENDANCE_EXPLANATION_REASON_INVALID",
  "ATTENDANCE_EXPLANATION_FILTER_INVALID",
  "ATTENDANCE_EXPLANATION_PAGINATION_INVALID",
  "ATTENDANCE_EXPLANATION_DECISION_INVALID",
  "ATTENDANCE_EXPLANATION_NOTE_INVALID",
  "ATTENDANCE_EXPLANATION_APPROVER_UNCONFIGURED",
  "ATTENDANCE_EXPLANATION_ACCESS_DENIED",
  "ATTENDANCE_EXPLANATION_SUBMIT_DENIED",
  "ATTENDANCE_EXPLANATION_APPROVAL_ACCESS_DENIED",
  "ATTENDANCE_EXPLANATION_DECIDE_DENIED",
  "ATTENDANCE_EXPLANATION_DECISION_DENIED",
  "ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN",
  "ATTENDANCE_EXPLANATION_NOT_FOUND",
  "ATTENDANCE_EXPLANATION_ALREADY_EXISTS",
  "ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED",
  "ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE",
  "ATTENDANCE_EXPLANATION_VERSION_CONFLICT",
  "ATTENDANCE_EXPLANATION_ALREADY_DECIDED",
  "ATTENDANCE_EXPLANATION_STATE_INVALID",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "ATTENDANCE_REPORT_UNAVAILABLE",
] as const;

export type AttendanceMonthlyMatrixErrorCode =
  (typeof ATTENDANCE_MONTHLY_MATRIX_ERROR_CODES)[number];

const MATRIX_ERROR_HTTP_STATUS: Readonly<Record<AttendanceMonthlyMatrixErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  ACTOR_NOT_AVAILABLE: 403,
  ATTENDANCE_REPORT_ACCESS_DENIED: 403,
  ATTENDANCE_BRANCH_WRITE_DENIED: 403,
  ATTENDANCE_SLOT_POLICY_WRITE_DENIED: 403,
  CSRF_REJECTED: 403,
  CONTENT_TYPE_INVALID: 400,
  BODY_TOO_LARGE: 413,
  ATTENDANCE_REPORT_QUERY_INVALID: 400,
  ATTENDANCE_MATRIX_MONTH_INVALID: 400,
  ATTENDANCE_REPORT_PAGINATION_INVALID: 400,
  ATTENDANCE_REPORT_SEARCH_INVALID: 400,
  ATTENDANCE_REPORT_EMPLOYEE_INVALID: 400,
  ATTENDANCE_REPORT_BRANCH_INVALID: 400,
  ATTENDANCE_REPORT_FILTER_CONFLICT: 400,
  ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED: 422,
  ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE: 409,
  ATTENDANCE_BRANCH_INVALID: 400,
  ATTENDANCE_BRANCH_NOT_FOUND: 404,
  ATTENDANCE_BRANCH_CODE_CONFLICT: 409,
  ATTENDANCE_BRANCH_VERSION_CONFLICT: 409,
  ATTENDANCE_BRANCH_INACTIVE: 422,
  ATTENDANCE_BRANCH_TARGET_USER_INVALID: 422,
  ATTENDANCE_BRANCH_ASSIGNMENT_INVALID: 400,
  ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE: 422,
  ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND: 404,
  ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP: 409,
  ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED: 409,
  ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID: 400,
  ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT: 409,
  ATTENDANCE_SLOT_POLICY_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST: 422,
  ATTENDANCE_SLOT_POLICY_OVERLAP: 409,
  ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT: 409,
  ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND: 404,
  ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT: 409,
  ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE: 422,
  ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN: 422,
  ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT: 422,
  ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID: 422,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE: 422,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE: 422,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND: 404,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP: 409,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED: 409,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID: 422,
  ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT: 409,
  ATTENDANCE_EXPLANATION_INVALID: 400,
  ATTENDANCE_EXPLANATION_QUERY_INVALID: 400,
  ATTENDANCE_EXPLANATION_DATE_INVALID: 400,
  ATTENDANCE_EXPLANATION_DATE_FUTURE: 400,
  ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED: 400,
  ATTENDANCE_EXPLANATION_SLOT_INVALID: 400,
  ATTENDANCE_EXPLANATION_REASON_INVALID: 400,
  ATTENDANCE_EXPLANATION_FILTER_INVALID: 400,
  ATTENDANCE_EXPLANATION_PAGINATION_INVALID: 400,
  ATTENDANCE_EXPLANATION_DECISION_INVALID: 400,
  ATTENDANCE_EXPLANATION_NOTE_INVALID: 400,
  ATTENDANCE_EXPLANATION_APPROVER_UNCONFIGURED: 422,
  ATTENDANCE_EXPLANATION_ACCESS_DENIED: 403,
  ATTENDANCE_EXPLANATION_SUBMIT_DENIED: 403,
  ATTENDANCE_EXPLANATION_APPROVAL_ACCESS_DENIED: 403,
  ATTENDANCE_EXPLANATION_DECIDE_DENIED: 403,
  ATTENDANCE_EXPLANATION_DECISION_DENIED: 403,
  ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN: 403,
  ATTENDANCE_EXPLANATION_NOT_FOUND: 404,
  ATTENDANCE_EXPLANATION_ALREADY_EXISTS: 409,
  ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED: 409,
  ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE: 409,
  ATTENDANCE_EXPLANATION_VERSION_CONFLICT: 409,
  ATTENDANCE_EXPLANATION_ALREADY_DECIDED: 409,
  ATTENDANCE_EXPLANATION_STATE_INVALID: 409,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ATTENDANCE_REPORT_UNAVAILABLE: 503,
};

export function attendanceMonthlyMatrixHttpStatusForError(
  code: AttendanceMonthlyMatrixErrorCode,
): number {
  return MATRIX_ERROR_HTTP_STATUS[code];
}

export type ParsedAttendanceMonthlyMatrixQuery = {
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
  page: number;
  page_size: number;
};

export type ParsedAttendanceMonthlyMatrixExportQuery = {
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
};

export type AttendanceMonthlyMatrixCalendarDayProjection = {
  business_date: string;
  day_of_month: number;
  day_of_week: number;
};

export type AttendanceBranchOptionProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  active: boolean;
  latitude: number | null;
  longitude: number | null;
  version: number;
};

export const DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID =
  "00000000-0000-4000-8000-000000000001";
export const DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE = "DEFAULT";
export const DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME = "Mặc định";

export type AttendanceMonthlyMatrixEmployeeOptionProjection = {
  app_user_id: string;
  display_name: string;
  personnel_code: string | null;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
  slot_profile_id?: string;
  slot_profile_code?: string;
  slot_profile_name?: string;
};

export type AttendanceMonthlyMatrixOverviewProjection = {
  total_employees: number;
  employees_with_checkins: number;
  employees_with_approved_leave: number;
  total_checkins: number;
  total_checkin_days: number;
  total_approved_leave_days: number;
  total_approved_leave_units: number;
  total_no_checkin_days: number;
  total_no_checkin_without_leave_days: number;
};

export type AttendanceMonthlyMatrixPaginationProjection = {
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
  has_more: boolean;
  snapshot_token: string;
};

export type AttendanceMonthlyMatrixEmployeeBranchProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  valid_from: string;
  valid_to: string | null;
};

export type AttendanceMonthlyMatrixEmployeeSummaryProjection = {
  checkin_day_count: number;
  total_checkins: number;
  approved_leave_day_count: number;
  approved_leave_units: number;
  checkin_and_leave_day_count: number;
  no_checkin_day_count: number;
  no_checkin_without_leave_day_count: number;
  distance_computed_count: number;
  distance_unavailable_count: number;
  min_distance_meters: number | null;
  max_distance_meters: number | null;
};

export type AttendanceMonthlyMatrixApprovedLeaveItemProjection = {
  request_id: string;
  leave_date: string;
  session_code: AttendanceMatrixLeaveSessionCode;
  leave_type: AttendanceMatrixLeaveType;
  half_day_units: number;
};

export type AttendanceSlotConfigItemProjection = {
  slot_code: AttendanceSlotCode;
  slot_index: number;
  slot_label: string;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
};

export type AttendanceSlotPolicyProjection = {
  profile_id?: string;
  profile_code?: string;
  profile_name?: string;
  is_default?: boolean;
  version: number;
  effective_from_date: string;
  effective_to_date: string | null;
  configured_at: string;
  configured_at_local: string;
  configured_by_display_name: string;
  slots: AttendanceSlotConfigItemProjection[];
};

export type AttendanceMonthlyMatrixSlotPolicyProfileSummaryProjection = {
  profile_id: string;
  profile_code: string;
  display_name: string;
  description: string | null;
  is_default: boolean;
  active: boolean;
  version: number;
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  month_policies: AttendanceSlotPolicyProjection[];
};

export type AttendanceMonthlyMatrixSlotPolicySummaryProjection = {
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  month_policies: AttendanceSlotPolicyProjection[];
  profiles?: AttendanceMonthlyMatrixSlotPolicyProfileSummaryProjection[];
};

export type AttendanceMonthlyMatrixEmployeeSlotPolicyProfileProjection = {
  profile_id: string;
  profile_code: string;
  display_name: string;
  is_default: boolean;
  assignment_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  profile_names_in_month: string[];
};

export type AttendanceSlotCheckinItemProjection = {
  checkin_id: string;
  sequence_in_day: number;
  captured_at: string;
  captured_at_local: string;
  time_local: string;
  time_verified: boolean;
  assigned_slot_code: AttendanceSlotCode;
  delta_minutes: number;
  over_grace_minutes: number;
  deviation_status: AttendanceCheckinDeviationStatus;
  distance_target_kind: AttendanceDistanceTargetKind | null;
  distance_status: AttendanceDistanceStatus | null;
  distance_meters: number | null;
};

export type AttendanceDaySlotExplanationSummaryProjection = {
  explanation_id: string;
  status: AttendanceExplanationStatus;
  original_slot_status: AttendanceExplanationOriginalSlotStatus;
  reason: string;
  submitted_at: string;
  submitted_at_local: string;
  decided_at: string | null;
  decided_at_local: string | null;
  decided_by_display_name: string | null;
  decision_note: string;
  row_version: number;
};

export type AttendanceMonthlyMatrixDaySlotProjection = {
  slot_code: AttendanceSlotCode;
  slot_index: number;
  slot_label: string;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
  is_leave_covered: boolean;
  slot_status: AttendanceSlotStatus;
  checkins: AttendanceSlotCheckinItemProjection[];
  explanation?: AttendanceDaySlotExplanationSummaryProjection | null;
};

export type AttendanceExplanationAccountSummaryProjection = {
  app_user_id: string;
  display_name: string | null;
  login_id: string | null;
  personnel_code: string | null;
  recruiter_id: string | null;
  account_enabled: boolean;
};

export type AttendanceExplanationAuditEventProjection = {
  audit_event_id: string;
  action: "SUBMITTED" | "APPROVED" | "REJECTED";
  actor: AttendanceExplanationAccountSummaryProjection;
  before_status: AttendanceExplanationStatus | null;
  after_status: AttendanceExplanationStatus;
  note: string;
  created_at: string;
  created_at_local: string;
};

export type AttendanceExplanationItemProjection = {
  explanation_id: string;
  app_user_id: string;
  requester: AttendanceExplanationAccountSummaryProjection;
  business_date: string;
  slot_code: AttendanceSlotCode;
  slot_index: number;
  slot_label: string;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
  policy_profile_id_used?: string;
  policy_profile_code_used?: string;
  policy_profile_name_used?: string;
  policy_version_used: number;
  original_slot_status: AttendanceExplanationOriginalSlotStatus;
  effective_slot_status: AttendanceSlotStatus;
  related_checkins: AttendanceSlotCheckinItemProjection[];
  reason: string;
  status: AttendanceExplanationStatus;
  unit_kind_snapshot: AttendanceExplanationUnitKind | null;
  route_kind: AttendanceExplanationRouteKind;
  primary_approver: AttendanceExplanationAccountSummaryProjection | null;
  routed_team: {
    team_id: string;
    team_code: string | null;
    team_name: string | null;
  } | null;
  fallback_reason: AttendanceExplanationFallbackReason | null;
  submitted_at: string;
  submitted_at_local: string;
  decided_at: string | null;
  decided_at_local: string | null;
  decided_by: AttendanceExplanationAccountSummaryProjection | null;
  decision_note: string;
  row_version: number;
  updated_at: string;
  audit_events: AttendanceExplanationAuditEventProjection[];
  can_decide?: boolean;
};

export type AttendanceExplanationDaySlotEvaluationProjection = {
  slot_code: AttendanceSlotCode;
  slot_index: number;
  slot_label: string;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
  is_leave_covered: boolean;
  original_slot_status: AttendanceSlotStatus;
  slot_status: AttendanceSlotStatus;
  eligible_for_explanation: boolean;
  checkins: AttendanceSlotCheckinItemProjection[];
  explanation: AttendanceDaySlotExplanationSummaryProjection | null;
};

export type AttendanceMyExplanationsOverviewProjection = {
  viewer: {
    app_user_id: string;
    can_submit_explanation: boolean;
    can_approve_explanations: boolean;
    is_shared_non_employee: boolean;
    is_full_admin: boolean;
    is_bod: boolean;
  };
  routing: {
    route_kind: AttendanceExplanationRouteKind;
    unit_kind: AttendanceExplanationUnitKind | null;
    primary_approver: AttendanceExplanationAccountSummaryProjection | null;
    team_id: string | null;
    team_code: string | null;
    team_name: string | null;
    fallback_reason: AttendanceExplanationFallbackReason | null;
    profile_configured: boolean;
  };
  today_local: string;
  selected_date: string;
  day_evaluation: {
    business_date: string;
    policy_profile_id_used?: string;
    policy_profile_code_used?: string;
    policy_profile_name_used?: string;
    policy_is_default_used?: boolean;
    policy_version_used: number;
    slots: AttendanceExplanationDaySlotEvaluationProjection[];
  };
  pagination: {
    limit: number;
    offset: number;
    total_rows: number;
  };
  items: AttendanceExplanationItemProjection[];
};

export type SubmitAttendanceExplanationResultProjection = {
  replayed: boolean;
  explanation: AttendanceExplanationItemProjection;
};

export type AttendanceExplanationApprovalInboxProjection = {
  viewer: {
    app_user_id: string;
    can_approve_explanations: boolean;
    is_full_admin: boolean;
    is_bod: boolean;
  };
  pagination: {
    limit: number;
    offset: number;
    total_rows: number;
    pending_count: number;
  };
  items: (AttendanceExplanationItemProjection & { can_decide: boolean })[];
};

export type DecideAttendanceExplanationResultProjection = {
  replayed: boolean;
  explanation: AttendanceExplanationItemProjection;
};

export type ParsedMyAttendanceExplanationsQuery = {
  business_date: string | null;
  limit: number;
  offset: number;
};

export type ParsedSubmitAttendanceExplanationRequest = {
  business_date: string;
  slot_code: AttendanceSlotCode;
  reason: string;
  idempotency_key: string;
};

export type AttendanceMonthlyMatrixSlotExplanationProjection =
  AttendanceDaySlotExplanationSummaryProjection;

export type ParsedAttendanceExplanationApprovalInboxQuery = {
  status: "ALL" | AttendanceExplanationStatus | null;
  status_filter: "ALL" | AttendanceExplanationStatus | null;
  limit: number;
  offset: number;
};

export type ParsedDecideAttendanceExplanationRequest = {
  decision: AttendanceExplanationDecision;
  expected_row_version: number;
  decision_note: string;
  idempotency_key: string;
};

export const DEFAULT_ATTENDANCE_SLOT_POLICY: AttendanceSlotPolicyProjection = {
  version: 1,
  effective_from_date: "2000-01-01",
  effective_to_date: null,
  configured_at: "2000-01-01T00:00:00.000Z",
  configured_at_local: "2000-01-01 00:00:00",
  configured_by_display_name: "Mặc định hệ thống",
  slots: [
    {
      slot_code: "SLOT_1",
      slot_index: 1,
      slot_label: "Time 1",
      session_code: "AM",
      target_time: "07:30",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
    {
      slot_code: "SLOT_2",
      slot_index: 2,
      slot_label: "Time 2",
      session_code: "AM",
      target_time: "10:00",
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
      target_time: "15:00",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
    {
      slot_code: "SLOT_5",
      slot_index: 5,
      slot_label: "Time 5",
      session_code: "PM",
      target_time: "16:30",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
  ],
};

export type AttendanceMonthlyMatrixDayCellProjection = {
  business_date: string;
  day_of_month: number;
  policy_profile_id_used?: string;
  policy_profile_code_used?: string;
  policy_profile_name_used?: string;
  policy_is_default_used?: boolean;
  policy_version_used: number;
  has_checkin: boolean;
  checkin_count: number;
  first_checkin_id: string | null;
  last_checkin_id: string | null;
  first_captured_at: string | null;
  first_captured_at_local: string | null;
  first_time_local: string | null;
  last_captured_at: string | null;
  last_captured_at_local: string | null;
  last_time_local: string | null;
  verified_checkin_count: number;
  unverified_checkin_count: number;
  distance_target_kind: AttendanceDistanceTargetKind | null;
  branch_id_used: string | null;
  branch_code_used: string | null;
  branch_name_used: string | null;
  branch_version_used: number | null;
  hq_version_used: number | null;
  distance_status: AttendanceDistanceStatus | null;
  distance_meters: number | null;
  min_distance_meters: number | null;
  max_distance_meters: number | null;
  has_approved_leave: boolean;
  approved_leave_units: number;
  approved_leaves: AttendanceMonthlyMatrixApprovedLeaveItemProjection[];
  day_status: AttendanceMonthlyMatrixDayStatus;
  missing_slot_count: number;
  late_or_early_checkin_count: number;
  slots: AttendanceMonthlyMatrixDaySlotProjection[];
};

export type AttendanceMonthlyMatrixEmployeeRowProjection = {
  app_user_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  enabled: boolean;
  branch: AttendanceMonthlyMatrixEmployeeBranchProjection | null;
  slot_policy_profile?: AttendanceMonthlyMatrixEmployeeSlotPolicyProfileProjection;
  summary: AttendanceMonthlyMatrixEmployeeSummaryProjection;
  days: AttendanceMonthlyMatrixDayCellProjection[];
};

export type AttendanceMonthlyMatrixReportProjection = {
  viewer: {
    can_configure_hq: boolean;
    can_manage_branches: boolean;
    can_manage_slot_policy: boolean;
  };
  filters: {
    year_month: string;
    from_date: string;
    to_date: string;
    branch_id: string | null;
    employee_id: string | null;
    search: string | null;
    timezone: typeof ATTENDANCE_BUSINESS_TIMEZONE;
  };
  days_in_month: number;
  calendar_days: AttendanceMonthlyMatrixCalendarDayProjection[];
  current_hq: AttendanceHqLocationProjection | null;
  slot_policy: AttendanceMonthlyMatrixSlotPolicySummaryProjection;
  branch_options: AttendanceBranchOptionProjection[];
  employee_options: AttendanceMonthlyMatrixEmployeeOptionProjection[];
  overview: AttendanceMonthlyMatrixOverviewProjection;
  pagination: AttendanceMonthlyMatrixPaginationProjection;
  items: AttendanceMonthlyMatrixEmployeeRowProjection[];
};

export type AttendanceSlotPolicyProfileAdminItemProjection = {
  profile_id: string;
  profile_code: string;
  display_name: string;
  description: string | null;
  is_default: boolean;
  active: boolean;
  version: number;
  active_assignment_count: number;
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  versions: AttendanceSlotPolicyProjection[];
};

export type AttendanceSlotPolicyAssignmentAdminItemProjection = {
  assignment_id: string;
  app_user_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  enabled: boolean;
  profile_id: string;
  profile_code: string;
  profile_name: string;
  valid_from: string;
  valid_to: string | null;
  superseded_same_day: boolean;
  effective: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type AttendanceSlotPolicyEmployeeOptionProjection = {
  app_user_id: string;
  display_name: string;
  employee_display_name: string;
  personnel_code: string | null;
  enabled: boolean;
  current_profile_id: string;
  current_profile_code: string;
  current_profile_name: string;
  current_profile_is_default: boolean;
  current_assignment_id: string | null;
  current_assignment_version: number | null;
  current_assignment_valid_from: string | null;
};

export type AttendanceSlotPoliciesAdminListProjection = {
  viewer: {
    can_manage_slot_policy: boolean;
  };
  business_date: string;
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  versions: AttendanceSlotPolicyProjection[];
  profiles?: AttendanceSlotPolicyProfileAdminItemProjection[];
  assignments?: AttendanceSlotPolicyAssignmentAdminItemProjection[];
  employee_options?: AttendanceSlotPolicyEmployeeOptionProjection[];
};

export type AttendanceSlotPolicyProfileSavedProjection = {
  profile_id: string;
  profile_code: string;
  display_name: string;
  description: string | null;
  is_default: boolean;
  active: boolean;
  version: number;
};

export type CreateAttendanceSlotPolicyResultProjection = {
  replayed: boolean;
  policy: AttendanceSlotPolicyProjection;
  profile?: AttendanceSlotPolicyProfileSavedProjection;
};

export type UpsertAttendanceSlotPolicyProfileResultProjection =
  CreateAttendanceSlotPolicyResultProjection;

export type AssignAttendanceSlotPolicyResultProjection = {
  replayed: boolean;
  assignment: {
    assignment_id: string;
    app_user_id: string;
    employee_display_name?: string;
    personnel_code?: string | null;
    enabled?: boolean;
    profile_id: string;
    profile_code: string;
    profile_name: string;
    valid_from: string;
    valid_to: string | null;
    superseded_same_day: boolean;
    effective: boolean;
    version: number;
  };
};

export type UnassignAttendanceSlotPolicyResultProjection =
  AssignAttendanceSlotPolicyResultProjection;

export type ParsedCreateSlotPolicyRequest = {
  profile_id?: string | null;
  profile_code?: string | null;
  display_name?: string | null;
  description?: string | null;
  active?: boolean;
  expected_profile_version?: number;
  effective_from_date: string;
  slots: AttendanceSlotConfigItemProjection[];
  expected_version: number;
  idempotency_key: string;
};

export type ParsedUpsertSlotPolicyProfileRequest = {
  profile_id: string | null;
  profile_code: string | null;
  display_name: string | null;
  description: string | null;
  active: boolean;
  effective_from_date: string | null;
  slots: AttendanceSlotConfigItemProjection[] | null;
  expected_version: number | null;
  expected_profile_version: number;
  idempotency_key: string;
};

export type ParsedAssignSlotPolicyRequest = {
  target_app_user_id: string;
  profile_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
};

export type ParsedUnassignSlotPolicyRequest = {
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
};

export type AttendanceBranchAdminItemProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  active_assignment_count: number;
  created_at: string;
  updated_at: string;
  updated_by_display_name: string;
};

export type AttendanceBranchAssignmentAdminItemProjection = {
  assignment_id: string;
  app_user_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type AttendanceBranchAdminEmployeeOptionProjection = {
  app_user_id: string;
  display_name: string;
  personnel_code: string | null;
  enabled: boolean;
};

export type AttendanceBranchesAdminListProjection = {
  viewer: {
    can_manage_branches: boolean;
  };
  business_date: string;
  include_inactive: boolean;
  branches: AttendanceBranchAdminItemProjection[];
  assignments: AttendanceBranchAssignmentAdminItemProjection[];
  employee_options: AttendanceBranchAdminEmployeeOptionProjection[];
};

export type AttendanceBranchSavedProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  updated_at: string;
  updated_by_display_name: string;
};

export type UpsertAttendanceBranchResultProjection = {
  replayed: boolean;
  branch: AttendanceBranchSavedProjection;
};

export type AssignAttendanceBranchResultProjection = {
  replayed: boolean;
  assignment: {
    assignment_id: string;
    app_user_id: string;
    branch_id: string;
    branch_code: string;
    branch_name: string;
    valid_from: string;
    valid_to: string | null;
    version: number;
  };
};

export type UnassignAttendanceBranchResultProjection = {
  replayed: boolean;
  assignment: {
    assignment_id: string;
    app_user_id: string;
    branch_id: string;
    valid_from: string;
    valid_to: string | null;
    version: number;
  };
};

export type ParsedUpsertBranchRequest = {
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  expected_version: number;
  idempotency_key: string;
};

export type ParsedAssignBranchRequest = {
  target_app_user_id: string;
  branch_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
};

export type ParsedUnassignBranchRequest = {
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((key) => set.has(key));
}

function unwrapOptionalOkEnvelope(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!("ok" in value)) {
    return value;
  }
  if (value.ok !== true) {
    return null;
  }
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "ok") {
      rest[key] = item;
    }
  }
  return rest;
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function parseHhMmToMinutes(value: string): number | null {
  if (!HH_MM_PATTERN.test(value)) return null;
  const [hh, mm] = value.split(":");
  return Number(hh) * 60 + Number(mm);
}

export function isValidYearMonth(value: string): boolean {
  const match = YEAR_MONTH_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100;
}

/**
 * Deterministic 4-slot evaluation helper shared between contract fallbacks and tests.
 * Tie-break rule: when a check-in is equidistant between two adjacent slots,
 * it is deterministically assigned to the earlier slot (`slot_index asc`).
 */
export function evaluateAttendanceDaySlots(input: {
  policy?: Pick<AttendanceSlotPolicyProjection, "version" | "slots">;
  checkins: readonly {
    checkin_id: string;
    sequence_in_day: number;
    captured_at: string;
    captured_at_local: string;
    time_local: string;
    time_verified: boolean;
    distance_target_kind: AttendanceDistanceTargetKind | null;
    distance_status: AttendanceDistanceStatus | null;
    distance_meters: number | null;
  }[];
  approved_leaves: readonly Pick<
    AttendanceMonthlyMatrixApprovedLeaveItemProjection,
    "session_code"
  >[];
  explanations?: readonly (AttendanceDaySlotExplanationSummaryProjection & {
    slot_code: AttendanceSlotCode;
  })[];
}): {
  policy_version_used: number;
  missing_slot_count: number;
  late_or_early_checkin_count: number;
  slots: AttendanceMonthlyMatrixDaySlotProjection[];
} {
  const policy = input.policy ?? DEFAULT_ATTENDANCE_SLOT_POLICY;
  const amCovered = input.approved_leaves.some(
    (item) => item.session_code === "FULL" || item.session_code === "AM",
  );
  const pmCovered = input.approved_leaves.some(
    (item) => item.session_code === "FULL" || item.session_code === "PM",
  );
  const explanationBySlotCode = new Map<
    AttendanceSlotCode,
    AttendanceDaySlotExplanationSummaryProjection
  >();
  for (const exp of input.explanations ?? []) {
    const { slot_code, ...summary } = exp;
    explanationBySlotCode.set(slot_code, summary);
  }

  const slotTargets = policy.slots.map((slot) => ({
    ...slot,
    target_minute: parseHhMmToMinutes(slot.target_time) ?? 0,
  }));

  const sortedCheckins = [...input.checkins].sort((a, b) => {
    if (a.captured_at !== b.captured_at) {
      return a.captured_at.localeCompare(b.captured_at);
    }
    if (a.sequence_in_day !== b.sequence_in_day) {
      return a.sequence_in_day - b.sequence_in_day;
    }
    return a.checkin_id.localeCompare(b.checkin_id);
  });

  const bucketBySlotIndex = new Map<number, AttendanceSlotCheckinItemProjection[]>();
  for (const slot of slotTargets) {
    bucketBySlotIndex.set(slot.slot_index, []);
  }

  for (const checkin of sortedCheckins) {
    const checkinMinute = parseHhMmToMinutes(checkin.time_local) ?? 0;
    let bestSlot = slotTargets[0]!;
    let bestDistance = Math.abs(checkinMinute - bestSlot.target_minute);

    for (let i = 1; i < slotTargets.length; i += 1) {
      const candidate = slotTargets[i]!;
      const distance = Math.abs(checkinMinute - candidate.target_minute);
      // Strictly `<` preserves deterministic tie-break to earlier slot (`slot_index asc`).
      if (distance < bestDistance) {
        bestSlot = candidate;
        bestDistance = distance;
      }
    }

    const deltaMinutes = checkinMinute - bestSlot.target_minute;
    let deviationStatus: AttendanceCheckinDeviationStatus = "ON_TIME";
    let overGraceMinutes = 0;

    if (deltaMinutes < -bestSlot.grace_before_minutes) {
      deviationStatus = "EARLY";
      overGraceMinutes = -deltaMinutes - bestSlot.grace_before_minutes;
    } else if (deltaMinutes > bestSlot.grace_after_minutes) {
      deviationStatus = "LATE";
      overGraceMinutes = deltaMinutes - bestSlot.grace_after_minutes;
    }

    bucketBySlotIndex.get(bestSlot.slot_index)!.push({
      checkin_id: checkin.checkin_id.toLowerCase(),
      sequence_in_day: checkin.sequence_in_day,
      captured_at: checkin.captured_at,
      captured_at_local: checkin.captured_at_local,
      time_local: checkin.time_local,
      time_verified: checkin.time_verified,
      assigned_slot_code: bestSlot.slot_code,
      delta_minutes: deltaMinutes,
      over_grace_minutes: overGraceMinutes,
      deviation_status: deviationStatus,
      distance_target_kind: checkin.distance_target_kind,
      distance_status: checkin.distance_status,
      distance_meters:
        checkin.distance_meters === null ? null : normalizeZero(checkin.distance_meters),
    });
  }

  let missingSlotCount = 0;
  let lateOrEarlyCount = 0;
  const slots: AttendanceMonthlyMatrixDaySlotProjection[] = slotTargets.map((slot) => {
    const slotCheckins = bucketBySlotIndex.get(slot.slot_index) ?? [];
    const isLeaveCovered = slot.session_code === "AM" ? amCovered : pmCovered;
    const outOfGraceCount = slotCheckins.filter((item) => item.deviation_status !== "ON_TIME").length;
    const hasOutOfGrace = outOfGraceCount > 0;
    const explanation = explanationBySlotCode.get(slot.slot_code) ?? null;
    const isApprovedExplanation = explanation?.status === "APPROVED";

    let slotStatus: AttendanceSlotStatus;
    if (
      isApprovedExplanation &&
      ((slotCheckins.length > 0 && hasOutOfGrace) ||
        (slotCheckins.length === 0 && !isLeaveCovered))
    ) {
      slotStatus = "EXPLAINED_APPROVED";
    } else if (slotCheckins.length > 0 && hasOutOfGrace) {
      slotStatus = "OUT_OF_GRACE";
      lateOrEarlyCount += outOfGraceCount;
    } else if (slotCheckins.length > 0) {
      slotStatus = "ON_TIME";
    } else if (isLeaveCovered) {
      slotStatus = "LEAVE_COVERED";
    } else {
      slotStatus = "MISSING";
      missingSlotCount += 1;
    }

    return {
      slot_code: slot.slot_code,
      slot_index: slot.slot_index,
      slot_label: slot.slot_label || `Time ${slot.slot_index}`,
      session_code: slot.session_code,
      target_time: slot.target_time,
      grace_before_minutes: slot.grace_before_minutes,
      grace_after_minutes: slot.grace_after_minutes,
      is_leave_covered: isLeaveCovered,
      slot_status: slotStatus,
      checkins: slotCheckins,
      explanation,
    };
  });

  return {
    policy_version_used: policy.version,
    missing_slot_count: missingSlotCount,
    late_or_early_checkin_count: lateOrEarlyCount,
    slots,
  };
}

function parseSharedMatrixFilters(
  url: URL,
  allowedKeys: ReadonlySet<string>,
):
  | {
      ok: true;
      value: {
        year_month: string | null;
        branch_id: string | null;
        employee_id: string | null;
        search: string | null;
      };
    }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }

  const rawYearMonth = url.searchParams.get("year_month");
  const yearMonth =
    rawYearMonth !== null && rawYearMonth.trim() !== "" ? rawYearMonth.trim() : null;
  if (yearMonth !== null && !isValidYearMonth(yearMonth)) {
    return { ok: false, code: "ATTENDANCE_MATRIX_MONTH_INVALID" };
  }

  const rawBranchId = url.searchParams.get("branch_id");
  let branchId: string | null = null;
  if (rawBranchId !== null) {
    const trimmed = rawBranchId.trim();
    if (trimmed.length > 0) {
      if (!isUuidString(trimmed)) {
        return { ok: false, code: "ATTENDANCE_REPORT_BRANCH_INVALID" };
      }
      branchId = trimmed.toLowerCase();
    }
  }

  const rawEmployeeId = url.searchParams.get("employee_id");
  let employeeId: string | null = null;
  if (rawEmployeeId !== null) {
    const trimmed = rawEmployeeId.trim();
    if (trimmed.length > 0) {
      if (!isUuidString(trimmed)) {
        return { ok: false, code: "ATTENDANCE_REPORT_EMPLOYEE_INVALID" };
      }
      employeeId = trimmed.toLowerCase();
    }
  }

  const rawSearch = url.searchParams.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (
      trimmed.length > 100 ||
      trimmed.length > ATTENDANCE_REPORT_MAX_SEARCH_LENGTH ||
      CONTROL_CHAR_PATTERN.test(trimmed)
    ) {
      return { ok: false, code: "ATTENDANCE_REPORT_SEARCH_INVALID" };
    }
    search = trimmed.length > 0 ? trimmed : null;
  }

  if (search !== null && employeeId !== null) {
    return { ok: false, code: "ATTENDANCE_REPORT_FILTER_CONFLICT" };
  }

  return {
    ok: true,
    value: {
      year_month: yearMonth,
      branch_id: branchId,
      employee_id: employeeId,
      search,
    },
  };
}

export function parseAttendanceMonthlyMatrixQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceMonthlyMatrixQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set([
    "year_month",
    "branch_id",
    "employee_id",
    "search",
    "page",
    "page_size",
  ]);
  const shared = parseSharedMatrixFilters(url, allowedKeys);
  if (!shared.ok) return shared;

  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize =
    url.searchParams.get("page_size") ?? String(ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE);
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > ATTENDANCE_REPORT_MAX_PAGE ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > ATTENDANCE_REPORT_MAX_PAGE_SIZE
  ) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }

  return {
    ok: true,
    value: {
      ...shared.value,
      page,
      page_size: pageSize,
    },
  };
}

export function parseAttendanceMonthlyMatrixExportQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceMonthlyMatrixExportQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["year_month", "branch_id", "employee_id", "search"]);
  return parseSharedMatrixFilters(url, allowedKeys);
}

export function parseAttendanceBranchesAdminQuery(
  url: URL,
):
  | { ok: true; value: { include_inactive: boolean } }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["include_inactive"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }
  const rawInclude = url.searchParams.get("include_inactive");
  if (rawInclude === null || rawInclude.trim() === "") {
    return { ok: true, value: { include_inactive: true } };
  }
  const normalized = rawInclude.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return { ok: true, value: { include_inactive: true } };
  }
  if (normalized === "false" || normalized === "0") {
    return { ok: true, value: { include_inactive: false } };
  }
  return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
}

function resolveIdempotencyKey(
  bodyKeyRaw: unknown,
  headerIdempotencyKey?: string | null,
): string | null {
  const trimmedHeaderKey = headerIdempotencyKey?.trim() ?? "";
  const bodyKey = typeof bodyKeyRaw === "string" ? bodyKeyRaw.trim() : "";
  const resolvedKey = bodyKey || trimmedHeaderKey;
  if (!isUuidString(resolvedKey)) {
    return null;
  }
  if (
    trimmedHeaderKey !== "" &&
    (!isUuidString(trimmedHeaderKey) ||
      (bodyKey !== "" && trimmedHeaderKey.toLowerCase() !== bodyKey.toLowerCase()))
  ) {
    return null;
  }
  return resolvedKey.toLowerCase();
}

function parseSlotConfigList(
  rawSlotsList: readonly unknown[],
): AttendanceSlotConfigItemProjection[] | null {
  if (
    rawSlotsList.length < ATTENDANCE_SLOT_MIN_COUNT ||
    rawSlotsList.length > ATTENDANCE_SLOT_MAX_COUNT
  ) {
    return null;
  }

  const parsedSlots: AttendanceSlotConfigItemProjection[] = [];

  for (let i = 0; i < rawSlotsList.length; i += 1) {
    const rawSlot = rawSlotsList[i];
    const slotIndex = i + 1;
    const expectedCode = ATTENDANCE_SLOT_CODES[i]!;
    if (!isRecord(rawSlot)) {
      return null;
    }
    const slotAllowedKeys = new Set([
      "slot_code",
      "slot_index",
      "slot_label",
      "session_code",
      "target_time",
      "grace_before_minutes",
      "grace_after_minutes",
    ]);
    for (const key of Object.keys(rawSlot)) {
      if (!slotAllowedKeys.has(key)) {
        return null;
      }
    }

    if (rawSlot.slot_code !== undefined && rawSlot.slot_code !== expectedCode) {
      return null;
    }
    if (rawSlot.slot_index !== undefined && rawSlot.slot_index !== slotIndex) {
      return null;
    }

    let slotLabel = `Time ${slotIndex}`;
    if (rawSlot.slot_label !== undefined && rawSlot.slot_label !== null) {
      if (typeof rawSlot.slot_label !== "string") {
        return null;
      }
      const trimmedLabel = rawSlot.slot_label.trim();
      if (trimmedLabel.length > 64 || CONTROL_CHAR_PATTERN.test(trimmedLabel)) {
        return null;
      }
      if (trimmedLabel.length > 0) {
        slotLabel = trimmedLabel;
      }
    }

    const targetTime =
      typeof rawSlot.target_time === "string" ? rawSlot.target_time.trim() : "";
    const graceBefore = rawSlot.grace_before_minutes;
    const graceAfter = rawSlot.grace_after_minutes;

    if (
      !HH_MM_PATTERN.test(targetTime) ||
      typeof graceBefore !== "number" ||
      !Number.isSafeInteger(graceBefore) ||
      graceBefore < 0 ||
      graceBefore > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
      typeof graceAfter !== "number" ||
      !Number.isSafeInteger(graceAfter) ||
      graceAfter < 0 ||
      graceAfter > ATTENDANCE_SLOT_MAX_GRACE_MINUTES
    ) {
      return null;
    }

    const expectedSession: AttendanceSlotSessionCode =
      targetTime < "12:00" ? "AM" : "PM";
    if (
      rawSlot.session_code !== undefined &&
      rawSlot.session_code !== expectedSession
    ) {
      return null;
    }

    if (i > 0 && parsedSlots[i - 1]!.target_time >= targetTime) {
      return null;
    }

    parsedSlots.push({
      slot_code: expectedCode,
      slot_index: slotIndex,
      slot_label: slotLabel,
      session_code: expectedSession,
      target_time: targetTime,
      grace_before_minutes: graceBefore,
      grace_after_minutes: graceAfter,
    });
  }

  return parsedSlots;
}

export function parseCreateSlotPolicyBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedCreateSlotPolicyRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }
  const allowedKeys = new Set([
    "profile_id",
    "profile_code",
    "display_name",
    "description",
    "active",
    "expected_profile_version",
    "effective_from_date",
    "slots",
    "slot_1",
    "slot_2",
    "slot_3",
    "slot_4",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  let profileId: string | null | undefined = undefined;
  if (body.profile_id !== undefined) {
    if (body.profile_id === null) {
      profileId = null;
    } else if (typeof body.profile_id === "string" && isUuidString(body.profile_id.trim())) {
      profileId = body.profile_id.trim().toLowerCase();
    } else {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  let profileCode: string | null | undefined = undefined;
  if (body.profile_code !== undefined && body.profile_code !== null) {
    if (typeof body.profile_code !== "string") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID" };
    }
    const normalizedCode = body.profile_code.trim().toUpperCase();
    if (!SLOT_PROFILE_CODE_INPUT_PATTERN.test(normalizedCode)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID" };
    }
    profileCode = normalizedCode;
  }

  let displayName: string | null | undefined = undefined;
  if (body.display_name !== undefined && body.display_name !== null) {
    if (typeof body.display_name !== "string") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID" };
    }
    const trimmedName = body.display_name.trim();
    if (
      trimmedName.length < 1 ||
      trimmedName.length > 128 ||
      CONTROL_CHAR_PATTERN.test(trimmedName)
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID" };
    }
    displayName = trimmedName;
  }

  let description: string | null | undefined = undefined;
  if (body.description !== undefined) {
    if (body.description === null) {
      description = null;
    } else if (typeof body.description === "string") {
      const trimmedDesc = body.description.trim();
      if (trimmedDesc.length > 500 || ADDRESS_CONTROL_CHAR_PATTERN.test(trimmedDesc)) {
        return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
      }
      description = trimmedDesc.length > 0 ? trimmedDesc : null;
    } else {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  let active: boolean | undefined = undefined;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    active = body.active;
  }

  let expectedProfileVersion: number | undefined = undefined;
  if (body.expected_profile_version !== undefined) {
    if (
      typeof body.expected_profile_version !== "number" ||
      !Number.isSafeInteger(body.expected_profile_version) ||
      body.expected_profile_version < 0
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    expectedProfileVersion = body.expected_profile_version;
  }

  const effectiveFromDate =
    typeof body.effective_from_date === "string" ? body.effective_from_date.trim() : "";
  if (
    !isValidIsoCalendarDate(effectiveFromDate) ||
    effectiveFromDate < "2000-01-01" ||
    effectiveFromDate > "2100-12-31"
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const rawSlotsList = Array.isArray(body.slots)
    ? body.slots
    : body.slot_1 !== undefined ||
        body.slot_2 !== undefined ||
        body.slot_3 !== undefined ||
        body.slot_4 !== undefined
      ? [body.slot_1, body.slot_2, body.slot_3, body.slot_4]
      : null;

  if (!rawSlotsList) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }
  const parsedSlots = parseSlotConfigList(rawSlotsList);
  if (!parsedSlots) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const hasProfileFields =
    profileId !== undefined ||
    profileCode !== undefined ||
    displayName !== undefined ||
    description !== undefined ||
    active !== undefined ||
    body.expected_profile_version !== undefined;
  const isCreatingNewNamedProfile = !profileId && profileCode !== undefined;

  if (isCreatingNewNamedProfile) {
    if (expectedProfileVersion === undefined) {
      expectedProfileVersion = 0;
    } else if (expectedProfileVersion !== 0) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  } else if (hasProfileFields) {
    if (
      typeof profileId !== "string" ||
      typeof expectedProfileVersion !== "number" ||
      expectedProfileVersion < 1
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  const expectedVersion =
    body.expected_version === undefined && isCreatingNewNamedProfile
      ? 0
      : body.expected_version;
  const minExpectedVersion = isCreatingNewNamedProfile ? 0 : 1;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < minExpectedVersion ||
    (isCreatingNewNamedProfile && expectedVersion !== 0)
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      ...(profileId !== undefined ? { profile_id: profileId } : {}),
      ...(profileCode !== undefined ? { profile_code: profileCode } : {}),
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(expectedProfileVersion !== undefined
        ? { expected_profile_version: expectedProfileVersion }
        : {}),
      effective_from_date: effectiveFromDate,
      slots: parsedSlots,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUpsertSlotPolicyProfileBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
  routeProfileId?: string | null,
):
  | { ok: true; value: ParsedUpsertSlotPolicyProfileRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }
  const allowedKeys = new Set([
    "profile_id",
    "profile_code",
    "display_name",
    "description",
    "active",
    "effective_from_date",
    "slots",
    "expected_version",
    "expected_profile_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  let profileId: string | null = null;
  if (routeProfileId !== undefined && routeProfileId !== null) {
    const trimmedRoute = routeProfileId.trim();
    if (!isUuidString(trimmedRoute)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    profileId = trimmedRoute.toLowerCase();
  }
  if (body.profile_id !== undefined && body.profile_id !== null) {
    if (typeof body.profile_id !== "string" || !isUuidString(body.profile_id.trim())) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    const normalizedBodyId = body.profile_id.trim().toLowerCase();
    if (profileId !== null && profileId !== normalizedBodyId) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    profileId = normalizedBodyId;
  }

  let profileCode: string | null = null;
  if (body.profile_code !== undefined && body.profile_code !== null) {
    if (typeof body.profile_code !== "string") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID" };
    }
    const normalizedCode = body.profile_code.trim().toUpperCase();
    if (!SLOT_PROFILE_CODE_INPUT_PATTERN.test(normalizedCode)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID" };
    }
    profileCode = normalizedCode;
  } else if (profileId === null) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID" };
  }

  let displayName: string | null = null;
  if (body.display_name !== undefined && body.display_name !== null) {
    if (typeof body.display_name !== "string") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID" };
    }
    const trimmedName = body.display_name.trim();
    if (
      trimmedName.length < 1 ||
      trimmedName.length > 128 ||
      CONTROL_CHAR_PATTERN.test(trimmedName)
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID" };
    }
    displayName = trimmedName;
  } else if (profileId === null) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID" };
  }

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    const trimmedDesc = body.description.trim();
    if (trimmedDesc.length > 500 || ADDRESS_CONTROL_CHAR_PATTERN.test(trimmedDesc)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    description = trimmedDesc.length > 0 ? trimmedDesc : null;
  }

  const active = body.active === undefined ? true : body.active;
  if (typeof active !== "boolean") {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }
  if (profileId === DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID && !active) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN" };
  }

  let parsedSlots: AttendanceSlotConfigItemProjection[] | null = null;
  let effectiveFromDate: string | null = null;
  if (body.slots !== undefined && body.slots !== null) {
    if (!Array.isArray(body.slots)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    parsedSlots = parseSlotConfigList(body.slots);
    if (!parsedSlots) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    const rawDate =
      typeof body.effective_from_date === "string" ? body.effective_from_date.trim() : "";
    if (
      !isValidIsoCalendarDate(rawDate) ||
      rawDate < "2000-01-01" ||
      rawDate > "2100-12-31"
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    effectiveFromDate = rawDate;
  } else if (profileId === null) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  let parsedExpectedVersion: number | null = null;
  let parsedExpectedProfileVersion: number = 0;

  if (profileId === null) {
    const rawExpectedVersion =
      body.expected_version === undefined || body.expected_version === null
        ? 0
        : body.expected_version;
    const rawExpectedProfileVersion =
      body.expected_profile_version === undefined || body.expected_profile_version === null
        ? 0
        : body.expected_profile_version;
    if (
      typeof rawExpectedVersion !== "number" ||
      !Number.isSafeInteger(rawExpectedVersion) ||
      rawExpectedVersion !== 0 ||
      typeof rawExpectedProfileVersion !== "number" ||
      !Number.isSafeInteger(rawExpectedProfileVersion) ||
      rawExpectedProfileVersion !== 0
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    parsedExpectedVersion = 0;
    parsedExpectedProfileVersion = 0;
  } else {
    if (
      typeof body.expected_profile_version !== "number" ||
      !Number.isSafeInteger(body.expected_profile_version) ||
      body.expected_profile_version < 1
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    parsedExpectedProfileVersion = body.expected_profile_version;

    if (parsedSlots !== null) {
      if (
        typeof body.expected_version !== "number" ||
        !Number.isSafeInteger(body.expected_version) ||
        body.expected_version < 1
      ) {
        return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
      }
      parsedExpectedVersion = body.expected_version;
    } else if (body.expected_version !== undefined && body.expected_version !== null) {
      if (
        typeof body.expected_version !== "number" ||
        !Number.isSafeInteger(body.expected_version) ||
        body.expected_version < 1
      ) {
        return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
      }
      parsedExpectedVersion = body.expected_version;
    } else {
      parsedExpectedVersion = null;
    }
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      profile_id: profileId,
      profile_code: profileCode,
      display_name: displayName,
      description,
      active,
      effective_from_date: effectiveFromDate,
      slots: parsedSlots,
      expected_version: parsedExpectedVersion,
      expected_profile_version: parsedExpectedProfileVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

function resolveBusinessTodayVn(todayVn?: string): string {
  if (typeof todayVn === "string" && isValidIsoCalendarDate(todayVn.trim())) {
    return todayVn.trim();
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function parseAssignSlotPolicyBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
  todayVn?: string,
):
  | { ok: true; value: ParsedAssignSlotPolicyRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set([
    "app_user_id",
    "profile_id",
    "valid_from",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
    }
  }

  const rawUserId = typeof body.app_user_id === "string" ? body.app_user_id.trim() : "";
  const rawProfileId = typeof body.profile_id === "string" ? body.profile_id.trim() : "";
  if (!isUuidString(rawUserId) || !isUuidString(rawProfileId)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
  }
  const normalizedProfileId = rawProfileId.toLowerCase();
  if (normalizedProfileId === DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT" };
  }

  const resolvedTodayVn = resolveBusinessTodayVn(todayVn);
  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    if (
      typeof body.valid_from !== "string" ||
      !isValidIsoCalendarDate(body.valid_from.trim()) ||
      body.valid_from.trim() < "2000-01-01" ||
      body.valid_from.trim() > "2100-12-31"
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
    }
    validFrom = body.valid_from.trim();
    if (validFrom > resolvedTodayVn) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE" };
    }
  }

  const expectedVersion =
    body.expected_version === undefined || body.expected_version === null
      ? 0
      : body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      target_app_user_id: rawUserId.toLowerCase(),
      profile_id: normalizedProfileId,
      valid_from: validFrom,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUnassignSlotPolicyBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
  todayVn?: string,
):
  | { ok: true; value: ParsedUnassignSlotPolicyRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set(["valid_to", "expected_version", "idempotency_key"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
    }
  }

  const resolvedTodayVn = resolveBusinessTodayVn(todayVn);
  let validTo: string | null = null;
  if (body.valid_to !== undefined && body.valid_to !== null) {
    if (
      typeof body.valid_to !== "string" ||
      !isValidIsoCalendarDate(body.valid_to.trim()) ||
      body.valid_to.trim() < "2000-01-01" ||
      body.valid_to.trim() > "2100-12-31"
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
    }
    validTo = body.valid_to.trim();
    if (validTo > resolvedTodayVn) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE" };
    }
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      valid_to: validTo,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUpsertBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedUpsertBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }
  const allowedKeys = new Set([
    "branch_code",
    "display_name",
    "address",
    "latitude",
    "longitude",
    "active",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
    }
  }

  const branchCode =
    typeof body.branch_code === "string" ? body.branch_code.trim().toUpperCase() : "";
  const displayName =
    typeof body.display_name === "string" ? body.display_name.trim() : "";
  const address =
    body.address === undefined || body.address === null
      ? ""
      : typeof body.address === "string"
        ? body.address.trim()
        : null;

  if (
    !BRANCH_CODE_PATTERN.test(branchCode) ||
    displayName.length < 1 ||
    displayName.length > 256 ||
    CONTROL_CHAR_PATTERN.test(displayName) ||
    address === null ||
    address.length > 500 ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(address)
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const rawLat = body.latitude === undefined ? null : body.latitude;
  const rawLon = body.longitude === undefined ? null : body.longitude;
  if ((rawLat === null) !== (rawLon === null)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (rawLat !== null && rawLon !== null) {
    if (
      !isFiniteNumber(rawLat) ||
      rawLat < -90 ||
      rawLat > 90 ||
      !isFiniteNumber(rawLon) ||
      rawLon < -180 ||
      rawLon > 180
    ) {
      return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
    }
    latitude = normalizeZero(rawLat);
    longitude = normalizeZero(rawLon);
  }

  const active = body.active === undefined ? true : body.active;
  if (typeof active !== "boolean") {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      branch_code: branchCode,
      display_name: displayName,
      address,
      latitude,
      longitude,
      active,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseAssignBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
  todayVn?: string,
):
  | { ok: true; value: ParsedAssignBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set([
    "app_user_id",
    "branch_id",
    "valid_from",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
  }

  const rawUserId = typeof body.app_user_id === "string" ? body.app_user_id.trim() : "";
  const rawBranchId = typeof body.branch_id === "string" ? body.branch_id.trim() : "";
  if (!isUuidString(rawUserId) || !isUuidString(rawBranchId)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  const resolvedTodayVn = resolveBusinessTodayVn(todayVn);
  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    if (typeof body.valid_from !== "string" || !isValidIsoCalendarDate(body.valid_from.trim())) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
    validFrom = body.valid_from.trim();
    if (validFrom > resolvedTodayVn) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE" };
    }
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      target_app_user_id: rawUserId.toLowerCase(),
      branch_id: rawBranchId.toLowerCase(),
      valid_from: validFrom,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUnassignBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
  todayVn?: string,
):
  | { ok: true; value: ParsedUnassignBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set(["valid_to", "expected_version", "idempotency_key"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
  }

  const resolvedTodayVn = resolveBusinessTodayVn(todayVn);
  let validTo: string | null = null;
  if (body.valid_to !== undefined && body.valid_to !== null) {
    if (typeof body.valid_to !== "string" || !isValidIsoCalendarDate(body.valid_to.trim())) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
    validTo = body.valid_to.trim();
    if (validTo > resolvedTodayVn) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE" };
    }
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      valid_to: validTo,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

function projectSlotConfigItem(
  value: unknown,
  expectedIndex: number,
): AttendanceSlotConfigItemProjection | null {
  const expectedCode = ATTENDANCE_SLOT_CODES[expectedIndex - 1];
  if (!expectedCode || !isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "slot_code",
    "slot_index",
    "session_code",
    "target_time",
    "grace_before_minutes",
    "grace_after_minutes",
  ] as const;
  const withLabelKeys = [...baseKeys, "slot_label"] as const;
  const hasLabelKey = hasExactKeys(value, withLabelKeys);
  const hasLegacyKeys = !hasLabelKey && hasExactKeys(value, baseKeys);
  if (!hasLabelKey && !hasLegacyKeys) {
    return null;
  }
  if (
    value.slot_code !== expectedCode ||
    value.slot_index !== expectedIndex ||
    !ATTENDANCE_SLOT_SESSION_CODES.includes(
      value.session_code as AttendanceSlotSessionCode,
    ) ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    value.grace_before_minutes < 0 ||
    value.grace_before_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    value.grace_after_minutes < 0 ||
    value.grace_after_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES
  ) {
    return null;
  }

  let slotLabel = `Time ${expectedIndex}`;
  if (hasLabelKey) {
    if (
      typeof value.slot_label !== "string" ||
      value.slot_label.trim().length === 0 ||
      value.slot_label.trim().length > 64 ||
      CONTROL_CHAR_PATTERN.test(value.slot_label.trim())
    ) {
      return null;
    }
    slotLabel = value.slot_label.trim();
  }

  return {
    slot_code: expectedCode,
    slot_index: expectedIndex,
    slot_label: slotLabel,
    session_code: value.session_code as AttendanceSlotSessionCode,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
  };
}

export function projectAttendanceSlotPolicy(
  value: unknown,
): AttendanceSlotPolicyProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "version",
    "effective_from_date",
    "effective_to_date",
    "configured_at",
    "configured_at_local",
    "configured_by_display_name",
    "slots",
  ] as const;
  const profileKeys = [
    ...baseKeys,
    "profile_id",
    "profile_code",
    "profile_name",
    "is_default",
  ] as const;
  const hasProfileKeys = hasExactKeys(value, profileKeys);
  const hasBaseKeys = !hasProfileKeys && hasExactKeys(value, baseKeys);
  if (!hasProfileKeys && !hasBaseKeys) {
    return null;
  }
  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.effective_from_date !== "string" ||
    !isValidIsoCalendarDate(value.effective_from_date) ||
    (value.effective_to_date !== null &&
      (typeof value.effective_to_date !== "string" ||
        !isValidIsoCalendarDate(value.effective_to_date))) ||
    typeof value.configured_at !== "string" ||
    typeof value.configured_at_local !== "string" ||
    typeof value.configured_by_display_name !== "string" ||
    value.configured_by_display_name.trim().length === 0 ||
    !Array.isArray(value.slots) ||
    value.slots.length < ATTENDANCE_SLOT_MIN_COUNT ||
    value.slots.length > ATTENDANCE_SLOT_MAX_COUNT
  ) {
    return null;
  }
  if (hasProfileKeys) {
    if (
      !isUuidString(value.profile_id) ||
      typeof value.profile_code !== "string" ||
      !SLOT_PROFILE_CODE_PATTERN.test(value.profile_code) ||
      typeof value.profile_name !== "string" ||
      value.profile_name.trim().length === 0 ||
      typeof value.is_default !== "boolean"
    ) {
      return null;
    }
  }

  const slots: AttendanceSlotConfigItemProjection[] = [];
  for (let i = 0; i < value.slots.length; i += 1) {
    const projectedSlot = projectSlotConfigItem(value.slots[i], i + 1);
    if (!projectedSlot) return null;
    if (i > 0 && slots[i - 1]!.target_time >= projectedSlot.target_time) {
      return null;
    }
    slots.push(projectedSlot);
  }

  return {
    ...(hasProfileKeys
      ? {
          profile_id: (value.profile_id as string).toLowerCase(),
          profile_code: value.profile_code as string,
          profile_name: (value.profile_name as string).trim(),
          is_default: value.is_default as boolean,
        }
      : {}),
    version: value.version,
    effective_from_date: value.effective_from_date,
    effective_to_date: value.effective_to_date,
    configured_at: value.configured_at,
    configured_at_local: value.configured_at_local,
    configured_by_display_name: value.configured_by_display_name,
    slots,
  };
}

function projectSlotPolicyProfileSummaryItem(
  value: unknown,
): AttendanceMonthlyMatrixSlotPolicyProfileSummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "profile_id",
      "profile_code",
      "display_name",
      "description",
      "is_default",
      "active",
      "version",
      "current_policy",
      "latest_policy",
      "month_policies",
    ]) ||
    !isUuidString(value.profile_id) ||
    typeof value.profile_code !== "string" ||
    !SLOT_PROFILE_CODE_PATTERN.test(value.profile_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    (value.description !== null && typeof value.description !== "string") ||
    typeof value.is_default !== "boolean" ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.month_policies)
  ) {
    return null;
  }

  const currentPolicy = projectAttendanceSlotPolicy(value.current_policy);
  const latestPolicy = projectAttendanceSlotPolicy(value.latest_policy);
  if (!currentPolicy || !latestPolicy) {
    return null;
  }

  const monthPolicies: AttendanceSlotPolicyProjection[] = [];
  for (const raw of value.month_policies) {
    const projected = projectAttendanceSlotPolicy(raw);
    if (!projected) return null;
    monthPolicies.push(projected);
  }

  return {
    profile_id: value.profile_id.toLowerCase(),
    profile_code: value.profile_code,
    display_name: value.display_name.trim(),
    description: value.description,
    is_default: value.is_default,
    active: value.active,
    version: value.version,
    current_policy: currentPolicy,
    latest_policy: latestPolicy,
    month_policies: monthPolicies,
  };
}

function projectSlotPolicySummary(
  value: unknown,
): AttendanceMonthlyMatrixSlotPolicySummaryProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = ["current_policy", "latest_policy", "month_policies"] as const;
  const withProfilesKeys = [...baseKeys, "profiles"] as const;
  const hasProfiles = hasExactKeys(value, withProfilesKeys);
  const hasBase = !hasProfiles && hasExactKeys(value, baseKeys);
  if ((!hasProfiles && !hasBase) || !Array.isArray(value.month_policies)) {
    return null;
  }
  const currentPolicy = projectAttendanceSlotPolicy(value.current_policy);
  const latestPolicy = projectAttendanceSlotPolicy(value.latest_policy);
  if (!currentPolicy || !latestPolicy) {
    return null;
  }
  const monthPolicies: AttendanceSlotPolicyProjection[] = [];
  for (const raw of value.month_policies) {
    const projected = projectAttendanceSlotPolicy(raw);
    if (!projected) return null;
    monthPolicies.push(projected);
  }

  let profiles: AttendanceMonthlyMatrixSlotPolicyProfileSummaryProjection[] | undefined =
    undefined;
  if (hasProfiles) {
    if (!Array.isArray(value.profiles) || value.profiles.length < 1) {
      return null;
    }
    profiles = [];
    for (const rawProfile of value.profiles) {
      const projectedProfile = projectSlotPolicyProfileSummaryItem(rawProfile);
      if (!projectedProfile) return null;
      profiles.push(projectedProfile);
    }
  }

  return {
    current_policy: currentPolicy,
    latest_policy: latestPolicy,
    month_policies: monthPolicies,
    ...(profiles !== undefined ? { profiles } : {}),
  };
}

function projectSlotCheckinItem(
  value: unknown,
  expectedSlotCode: AttendanceSlotCode,
): AttendanceSlotCheckinItemProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkin_id",
      "sequence_in_day",
      "captured_at",
      "captured_at_local",
      "time_local",
      "time_verified",
      "assigned_slot_code",
      "delta_minutes",
      "over_grace_minutes",
      "deviation_status",
      "distance_target_kind",
      "distance_status",
      "distance_meters",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.checkin_id) ||
    typeof value.sequence_in_day !== "number" ||
    !Number.isSafeInteger(value.sequence_in_day) ||
    value.sequence_in_day < 1 ||
    typeof value.captured_at !== "string" ||
    typeof value.captured_at_local !== "string" ||
    typeof value.time_local !== "string" ||
    !HH_MM_PATTERN.test(value.time_local) ||
    typeof value.time_verified !== "boolean" ||
    value.assigned_slot_code !== expectedSlotCode ||
    typeof value.delta_minutes !== "number" ||
    !Number.isSafeInteger(value.delta_minutes) ||
    typeof value.over_grace_minutes !== "number" ||
    !Number.isSafeInteger(value.over_grace_minutes) ||
    value.over_grace_minutes < 0 ||
    !ATTENDANCE_CHECKIN_DEVIATION_STATUSES.includes(
      value.deviation_status as AttendanceCheckinDeviationStatus,
    ) ||
    (value.distance_target_kind !== null &&
      !ATTENDANCE_DISTANCE_TARGET_KINDS.includes(
        value.distance_target_kind as AttendanceDistanceTargetKind,
      )) ||
    (value.distance_status !== null &&
      !ATTENDANCE_DISTANCE_STATUSES.includes(value.distance_status as AttendanceDistanceStatus)) ||
    (value.distance_meters !== null &&
      (!isFiniteNumber(value.distance_meters) || value.distance_meters < 0))
  ) {
    return null;
  }

  return {
    checkin_id: value.checkin_id.toLowerCase(),
    sequence_in_day: value.sequence_in_day,
    captured_at: value.captured_at,
    captured_at_local: value.captured_at_local,
    time_local: value.time_local,
    time_verified: value.time_verified,
    assigned_slot_code: expectedSlotCode,
    delta_minutes: value.delta_minutes,
    over_grace_minutes: value.over_grace_minutes,
    deviation_status: value.deviation_status as AttendanceCheckinDeviationStatus,
    distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
    distance_status: value.distance_status as AttendanceDistanceStatus | null,
    distance_meters:
      value.distance_meters === null ? null : normalizeZero(value.distance_meters),
  };
}

function projectDaySlotExplanationSummary(
  value: unknown,
): AttendanceDaySlotExplanationSummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "explanation_id",
      "status",
      "original_slot_status",
      "reason",
      "submitted_at",
      "submitted_at_local",
      "decided_at",
      "decided_at_local",
      "decided_by_display_name",
      "decision_note",
      "row_version",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.explanation_id) ||
    !ATTENDANCE_EXPLANATION_STATUSES.includes(value.status as AttendanceExplanationStatus) ||
    !ATTENDANCE_EXPLANATION_ORIGINAL_SLOT_STATUSES.includes(
      value.original_slot_status as AttendanceExplanationOriginalSlotStatus,
    ) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.trim().length > 500 ||
    typeof value.submitted_at !== "string" ||
    typeof value.submitted_at_local !== "string" ||
    (value.decided_at !== null && typeof value.decided_at !== "string") ||
    (value.decided_at_local !== null && typeof value.decided_at_local !== "string") ||
    (value.decided_by_display_name !== null &&
      typeof value.decided_by_display_name !== "string") ||
    typeof value.decision_note !== "string" ||
    typeof value.row_version !== "number" ||
    !Number.isSafeInteger(value.row_version) ||
    value.row_version < 1
  ) {
    return null;
  }

  return {
    explanation_id: value.explanation_id.toLowerCase(),
    status: value.status as AttendanceExplanationStatus,
    original_slot_status: value.original_slot_status as AttendanceExplanationOriginalSlotStatus,
    reason: value.reason,
    submitted_at: value.submitted_at,
    submitted_at_local: value.submitted_at_local,
    decided_at: value.decided_at,
    decided_at_local: value.decided_at_local,
    decided_by_display_name: value.decided_by_display_name,
    decision_note: value.decision_note,
    row_version: value.row_version,
  };
}

function projectDaySlot(
  value: unknown,
  expectedIndex: number,
): AttendanceMonthlyMatrixDaySlotProjection | null {
  const expectedCode = ATTENDANCE_SLOT_CODES[expectedIndex - 1];
  if (!expectedCode || !isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "slot_code",
    "slot_index",
    "session_code",
    "target_time",
    "grace_before_minutes",
    "grace_after_minutes",
    "is_leave_covered",
    "slot_status",
    "checkins",
  ] as const;
  const withLabelKeys = [...baseKeys, "slot_label"] as const;
  const withExplanationKeys = [...withLabelKeys, "explanation"] as const;
  const baseWithExplanationKeys = [...baseKeys, "explanation"] as const;
  const hasLabelAndExplanation = hasExactKeys(value, withExplanationKeys);
  const hasLabelKey =
    hasLabelAndExplanation || (!hasLabelAndExplanation && hasExactKeys(value, withLabelKeys));
  const hasBaseWithExplanation =
    !hasLabelKey && hasExactKeys(value, baseWithExplanationKeys);
  const hasLegacyKeys =
    !hasLabelKey && !hasBaseWithExplanation && hasExactKeys(value, baseKeys);
  if (!hasLabelKey && !hasBaseWithExplanation && !hasLegacyKeys) {
    return null;
  }

  if (
    value.slot_code !== expectedCode ||
    value.slot_index !== expectedIndex ||
    !ATTENDANCE_SLOT_SESSION_CODES.includes(
      value.session_code as AttendanceSlotSessionCode,
    ) ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    value.grace_before_minutes < 0 ||
    value.grace_before_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    value.grace_after_minutes < 0 ||
    value.grace_after_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.is_leave_covered !== "boolean" ||
    !ATTENDANCE_SLOT_STATUSES.includes(value.slot_status as AttendanceSlotStatus) ||
    !Array.isArray(value.checkins)
  ) {
    return null;
  }

  let slotLabel = `Time ${expectedIndex}`;
  if (hasLabelKey) {
    if (
      typeof value.slot_label !== "string" ||
      value.slot_label.trim().length === 0 ||
      value.slot_label.trim().length > 64 ||
      CONTROL_CHAR_PATTERN.test(value.slot_label.trim())
    ) {
      return null;
    }
    slotLabel = value.slot_label.trim();
  }

  const checkins: AttendanceSlotCheckinItemProjection[] = [];
  for (const rawCheckin of value.checkins) {
    const projectedCheckin = projectSlotCheckinItem(rawCheckin, expectedCode);
    if (!projectedCheckin) return null;
    checkins.push(projectedCheckin);
  }

  let explanation: AttendanceDaySlotExplanationSummaryProjection | null = null;
  if (hasLabelAndExplanation || hasBaseWithExplanation) {
    if (value.explanation !== null) {
      explanation = projectDaySlotExplanationSummary(value.explanation);
      if (!explanation) return null;
    }
  }

  return {
    slot_code: expectedCode,
    slot_index: expectedIndex,
    slot_label: slotLabel,
    session_code: value.session_code as AttendanceSlotSessionCode,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
    is_leave_covered: value.is_leave_covered,
    slot_status: value.slot_status as AttendanceSlotStatus,
    checkins,
    explanation,
  };
}

function projectCalendarDay(
  value: unknown,
): AttendanceMonthlyMatrixCalendarDayProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["business_date", "day_of_month", "day_of_week"])
  ) {
    return null;
  }
  if (
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.day_of_month !== "number" ||
    !Number.isSafeInteger(value.day_of_month) ||
    value.day_of_month < 1 ||
    value.day_of_month > 31 ||
    typeof value.day_of_week !== "number" ||
    !Number.isSafeInteger(value.day_of_week) ||
    value.day_of_week < 1 ||
    value.day_of_week > 7
  ) {
    return null;
  }
  return {
    business_date: value.business_date,
    day_of_month: value.day_of_month,
    day_of_week: value.day_of_week,
  };
}

function projectBranchOption(value: unknown): AttendanceBranchOptionProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "branch_id",
      "branch_code",
      "display_name",
      "active",
      "latitude",
      "longitude",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.branch_id) ||
    typeof value.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(value.branch_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    (value.latitude === null) !== (value.longitude === null)
  ) {
    return null;
  }
  if (
    value.latitude !== null &&
    (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90)
  ) {
    return null;
  }
  if (
    value.longitude !== null &&
    (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180)
  ) {
    return null;
  }
  return {
    branch_id: value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    display_name: value.display_name,
    active: value.active,
    latitude: value.latitude === null ? null : normalizeZero(value.latitude),
    longitude: value.longitude === null ? null : normalizeZero(value.longitude),
    version: value.version,
  };
}

function projectEmployeeOption(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeOptionProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "app_user_id",
    "display_name",
    "personnel_code",
    "branch_id",
    "branch_code",
    "branch_name",
  ] as const;
  const profileKeys = [
    ...baseKeys,
    "slot_profile_id",
    "slot_profile_code",
    "slot_profile_name",
  ] as const;
  const hasProfileKeys = hasExactKeys(value, profileKeys);
  const hasBaseKeys = !hasProfileKeys && hasExactKeys(value, baseKeys);
  if (!hasProfileKeys && !hasBaseKeys) {
    return null;
  }
  if (
    !isUuidString(value.app_user_id) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    (value.branch_id !== null && !isUuidString(value.branch_id)) ||
    (value.branch_code !== null && typeof value.branch_code !== "string") ||
    (value.branch_name !== null && typeof value.branch_name !== "string")
  ) {
    return null;
  }
  if (hasProfileKeys) {
    if (
      !isUuidString(value.slot_profile_id) ||
      typeof value.slot_profile_code !== "string" ||
      !SLOT_PROFILE_CODE_PATTERN.test(value.slot_profile_code) ||
      typeof value.slot_profile_name !== "string" ||
      value.slot_profile_name.trim().length === 0
    ) {
      return null;
    }
  }
  return {
    app_user_id: value.app_user_id.toLowerCase(),
    display_name: value.display_name,
    personnel_code: value.personnel_code,
    branch_id: value.branch_id === null ? null : value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    branch_name: value.branch_name,
    ...(hasProfileKeys
      ? {
          slot_profile_id: (value.slot_profile_id as string).toLowerCase(),
          slot_profile_code: value.slot_profile_code as string,
          slot_profile_name: (value.slot_profile_name as string).trim(),
        }
      : {}),
  };
}

function projectOverview(value: unknown): AttendanceMonthlyMatrixOverviewProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "total_employees",
      "employees_with_checkins",
      "employees_with_approved_leave",
      "total_checkins",
      "total_checkin_days",
      "total_approved_leave_days",
      "total_approved_leave_units",
      "total_no_checkin_days",
      "total_no_checkin_without_leave_days",
    ])
  ) {
    return null;
  }
  const intKeys = [
    "total_employees",
    "employees_with_checkins",
    "employees_with_approved_leave",
    "total_checkins",
    "total_checkin_days",
    "total_approved_leave_days",
    "total_no_checkin_days",
    "total_no_checkin_without_leave_days",
  ] as const;
  for (const key of intKeys) {
    const num = value[key];
    if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
      return null;
    }
  }
  if (!isFiniteNumber(value.total_approved_leave_units) || value.total_approved_leave_units < 0) {
    return null;
  }
  return {
    total_employees: value.total_employees as number,
    employees_with_checkins: value.employees_with_checkins as number,
    employees_with_approved_leave: value.employees_with_approved_leave as number,
    total_checkins: value.total_checkins as number,
    total_checkin_days: value.total_checkin_days as number,
    total_approved_leave_days: value.total_approved_leave_days as number,
    total_approved_leave_units: normalizeZero(value.total_approved_leave_units),
    total_no_checkin_days: value.total_no_checkin_days as number,
    total_no_checkin_without_leave_days: value.total_no_checkin_without_leave_days as number,
  };
}

function projectPagination(value: unknown): AttendanceMonthlyMatrixPaginationProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "page",
      "page_size",
      "total_rows",
      "total_pages",
      "has_more",
      "snapshot_token",
    ])
  ) {
    return null;
  }
  if (
    typeof value.page !== "number" ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    typeof value.page_size !== "number" ||
    !Number.isSafeInteger(value.page_size) ||
    value.page_size < 1 ||
    typeof value.total_rows !== "number" ||
    !Number.isSafeInteger(value.total_rows) ||
    value.total_rows < 0 ||
    typeof value.total_pages !== "number" ||
    !Number.isSafeInteger(value.total_pages) ||
    value.total_pages < 0 ||
    typeof value.has_more !== "boolean" ||
    typeof value.snapshot_token !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.snapshot_token)
  ) {
    return null;
  }
  return {
    page: value.page,
    page_size: value.page_size,
    total_rows: value.total_rows,
    total_pages: value.total_pages,
    has_more: value.has_more,
    snapshot_token: value.snapshot_token,
  };
}

function projectEmployeeBranch(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeBranchProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "branch_id",
      "branch_code",
      "display_name",
      "address",
      "latitude",
      "longitude",
      "active",
      "version",
      "valid_from",
      "valid_to",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.branch_id) ||
    typeof value.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(value.branch_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.address !== "string" ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.valid_from !== "string" ||
    !isValidIsoCalendarDate(value.valid_from) ||
    (value.valid_to !== null &&
      (typeof value.valid_to !== "string" || !isValidIsoCalendarDate(value.valid_to))) ||
    (value.latitude === null) !== (value.longitude === null)
  ) {
    return null;
  }
  if (
    value.latitude !== null &&
    (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90)
  ) {
    return null;
  }
  if (
    value.longitude !== null &&
    (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180)
  ) {
    return null;
  }
  return {
    branch_id: value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    display_name: value.display_name,
    address: value.address,
    latitude: value.latitude === null ? null : normalizeZero(value.latitude),
    longitude: value.longitude === null ? null : normalizeZero(value.longitude),
    active: value.active,
    version: value.version,
    valid_from: value.valid_from,
    valid_to: value.valid_to,
  };
}

function projectEmployeeSummary(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeSummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkin_day_count",
      "total_checkins",
      "approved_leave_day_count",
      "approved_leave_units",
      "checkin_and_leave_day_count",
      "no_checkin_day_count",
      "no_checkin_without_leave_day_count",
      "distance_computed_count",
      "distance_unavailable_count",
      "min_distance_meters",
      "max_distance_meters",
    ])
  ) {
    return null;
  }
  const intKeys = [
    "checkin_day_count",
    "total_checkins",
    "approved_leave_day_count",
    "checkin_and_leave_day_count",
    "no_checkin_day_count",
    "no_checkin_without_leave_day_count",
    "distance_computed_count",
    "distance_unavailable_count",
  ] as const;
  for (const key of intKeys) {
    const num = value[key];
    if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
      return null;
    }
  }
  if (!isFiniteNumber(value.approved_leave_units) || value.approved_leave_units < 0) {
    return null;
  }
  if (
    value.min_distance_meters !== null &&
    (!isFiniteNumber(value.min_distance_meters) || value.min_distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.max_distance_meters !== null &&
    (!isFiniteNumber(value.max_distance_meters) || value.max_distance_meters < 0)
  ) {
    return null;
  }
  return {
    checkin_day_count: value.checkin_day_count as number,
    total_checkins: value.total_checkins as number,
    approved_leave_day_count: value.approved_leave_day_count as number,
    approved_leave_units: normalizeZero(value.approved_leave_units),
    checkin_and_leave_day_count: value.checkin_and_leave_day_count as number,
    no_checkin_day_count: value.no_checkin_day_count as number,
    no_checkin_without_leave_day_count: value.no_checkin_without_leave_day_count as number,
    distance_computed_count: value.distance_computed_count as number,
    distance_unavailable_count: value.distance_unavailable_count as number,
    min_distance_meters:
      value.min_distance_meters === null ? null : normalizeZero(value.min_distance_meters),
    max_distance_meters:
      value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
  };
}

function projectApprovedLeaveItem(
  value: unknown,
): AttendanceMonthlyMatrixApprovedLeaveItemProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "request_id",
      "leave_date",
      "session_code",
      "leave_type",
      "half_day_units",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.request_id) ||
    typeof value.leave_date !== "string" ||
    !isValidIsoCalendarDate(value.leave_date) ||
    !ATTENDANCE_MATRIX_LEAVE_SESSION_CODES.includes(
      value.session_code as AttendanceMatrixLeaveSessionCode,
    ) ||
    !ATTENDANCE_MATRIX_LEAVE_TYPES.includes(value.leave_type as AttendanceMatrixLeaveType) ||
    (value.half_day_units !== 1 && value.half_day_units !== 2)
  ) {
    return null;
  }
  return {
    request_id: value.request_id.toLowerCase(),
    leave_date: value.leave_date,
    session_code: value.session_code as AttendanceMatrixLeaveSessionCode,
    leave_type: value.leave_type as AttendanceMatrixLeaveType,
    half_day_units: value.half_day_units,
  };
}

function projectDayCell(value: unknown): AttendanceMonthlyMatrixDayCellProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "business_date",
    "day_of_month",
    "has_checkin",
    "checkin_count",
    "first_checkin_id",
    "last_checkin_id",
    "first_captured_at",
    "first_captured_at_local",
    "first_time_local",
    "last_captured_at",
    "last_captured_at_local",
    "last_time_local",
    "verified_checkin_count",
    "unverified_checkin_count",
    "distance_target_kind",
    "branch_id_used",
    "branch_code_used",
    "branch_name_used",
    "branch_version_used",
    "hq_version_used",
    "distance_status",
    "distance_meters",
    "min_distance_meters",
    "max_distance_meters",
    "has_approved_leave",
    "approved_leave_units",
    "approved_leaves",
    "day_status",
  ] as const;

  const fullKeys = [
    ...baseKeys,
    "policy_version_used",
    "missing_slot_count",
    "late_or_early_checkin_count",
    "slots",
  ] as const;

  const multiProfileKeys = [
    ...fullKeys,
    "policy_profile_id_used",
    "policy_profile_code_used",
    "policy_profile_name_used",
    "policy_is_default_used",
  ] as const;

  const hasMultiProfileKeys = hasExactKeys(value, multiProfileKeys);
  const hasFullFourSlotKeys =
    hasMultiProfileKeys || (!hasMultiProfileKeys && hasExactKeys(value, fullKeys));
  const hasLegacyBaseKeys = !hasFullFourSlotKeys && hasExactKeys(value, baseKeys);
  if (!hasFullFourSlotKeys && !hasLegacyBaseKeys) {
    return null;
  }

  if (
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.day_of_month !== "number" ||
    !Number.isSafeInteger(value.day_of_month) ||
    value.day_of_month < 1 ||
    value.day_of_month > 31 ||
    typeof value.has_checkin !== "boolean" ||
    typeof value.checkin_count !== "number" ||
    !Number.isSafeInteger(value.checkin_count) ||
    value.checkin_count < 0 ||
    typeof value.verified_checkin_count !== "number" ||
    !Number.isSafeInteger(value.verified_checkin_count) ||
    value.verified_checkin_count < 0 ||
    typeof value.unverified_checkin_count !== "number" ||
    !Number.isSafeInteger(value.unverified_checkin_count) ||
    value.unverified_checkin_count < 0 ||
    typeof value.has_approved_leave !== "boolean" ||
    !isFiniteNumber(value.approved_leave_units) ||
    value.approved_leave_units < 0 ||
    !Array.isArray(value.approved_leaves) ||
    !ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES.includes(
      value.day_status as AttendanceMonthlyMatrixDayStatus,
    )
  ) {
    return null;
  }

  if (value.first_checkin_id !== null && !isUuidString(value.first_checkin_id)) return null;
  if (value.last_checkin_id !== null && !isUuidString(value.last_checkin_id)) return null;
  if (value.first_captured_at !== null && typeof value.first_captured_at !== "string") return null;
  if (value.first_captured_at_local !== null && typeof value.first_captured_at_local !== "string") {
    return null;
  }
  if (
    value.first_time_local !== null &&
    (typeof value.first_time_local !== "string" || !HH_MM_PATTERN.test(value.first_time_local))
  ) {
    return null;
  }
  if (value.last_captured_at !== null && typeof value.last_captured_at !== "string") return null;
  if (value.last_captured_at_local !== null && typeof value.last_captured_at_local !== "string") {
    return null;
  }
  if (
    value.last_time_local !== null &&
    (typeof value.last_time_local !== "string" || !HH_MM_PATTERN.test(value.last_time_local))
  ) {
    return null;
  }

  if (
    value.distance_target_kind !== null &&
    !ATTENDANCE_DISTANCE_TARGET_KINDS.includes(
      value.distance_target_kind as AttendanceDistanceTargetKind,
    )
  ) {
    return null;
  }
  if (value.branch_id_used !== null && !isUuidString(value.branch_id_used)) return null;
  if (value.branch_code_used !== null && typeof value.branch_code_used !== "string") return null;
  if (value.branch_name_used !== null && typeof value.branch_name_used !== "string") return null;
  if (
    value.branch_version_used !== null &&
    (typeof value.branch_version_used !== "number" ||
      !Number.isSafeInteger(value.branch_version_used) ||
      value.branch_version_used < 1)
  ) {
    return null;
  }
  if (
    value.hq_version_used !== null &&
    (typeof value.hq_version_used !== "number" ||
      !Number.isSafeInteger(value.hq_version_used) ||
      value.hq_version_used < 1)
  ) {
    return null;
  }
  if (
    value.distance_status !== null &&
    !ATTENDANCE_DISTANCE_STATUSES.includes(value.distance_status as AttendanceDistanceStatus)
  ) {
    return null;
  }
  if (
    value.distance_meters !== null &&
    (!isFiniteNumber(value.distance_meters) || value.distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.min_distance_meters !== null &&
    (!isFiniteNumber(value.min_distance_meters) || value.min_distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.max_distance_meters !== null &&
    (!isFiniteNumber(value.max_distance_meters) || value.max_distance_meters < 0)
  ) {
    return null;
  }

  const approvedLeaves: AttendanceMonthlyMatrixApprovedLeaveItemProjection[] = [];
  for (const rawLeave of value.approved_leaves) {
    const projectedLeave = projectApprovedLeaveItem(rawLeave);
    if (!projectedLeave) return null;
    approvedLeaves.push(projectedLeave);
  }

  let policyVersionUsed = 1;
  let missingSlotCount = 0;
  let lateOrEarlyCheckinCount = 0;
  let slots: AttendanceMonthlyMatrixDaySlotProjection[] = [];

  if (hasFullFourSlotKeys) {
    if (
      typeof value.policy_version_used !== "number" ||
      !Number.isSafeInteger(value.policy_version_used) ||
      value.policy_version_used < 1 ||
      typeof value.missing_slot_count !== "number" ||
      !Number.isSafeInteger(value.missing_slot_count) ||
      value.missing_slot_count < 0 ||
      typeof value.late_or_early_checkin_count !== "number" ||
      !Number.isSafeInteger(value.late_or_early_checkin_count) ||
      value.late_or_early_checkin_count < 0 ||
      !Array.isArray(value.slots) ||
      value.slots.length < ATTENDANCE_SLOT_MIN_COUNT ||
      value.slots.length > ATTENDANCE_SLOT_MAX_COUNT ||
      value.missing_slot_count > value.slots.length
    ) {
      return null;
    }
    if (hasMultiProfileKeys) {
      if (
        !isUuidString(value.policy_profile_id_used) ||
        typeof value.policy_profile_code_used !== "string" ||
        !SLOT_PROFILE_CODE_PATTERN.test(value.policy_profile_code_used) ||
        typeof value.policy_profile_name_used !== "string" ||
        value.policy_profile_name_used.trim().length === 0 ||
        typeof value.policy_is_default_used !== "boolean"
      ) {
        return null;
      }
    }

    const projectedSlots: AttendanceMonthlyMatrixDaySlotProjection[] = [];
    for (let i = 0; i < value.slots.length; i += 1) {
      const projectedSlot = projectDaySlot(value.slots[i], i + 1);
      if (!projectedSlot) return null;
      if (i > 0 && projectedSlots[i - 1]!.target_time >= projectedSlot.target_time) {
        return null;
      }
      projectedSlots.push(projectedSlot);
    }

    policyVersionUsed = value.policy_version_used;
    missingSlotCount = value.missing_slot_count;
    lateOrEarlyCheckinCount = value.late_or_early_checkin_count;
    slots = projectedSlots;
  } else {
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
      value.has_checkin &&
      value.first_checkin_id &&
      value.first_captured_at &&
      value.first_captured_at_local &&
      value.first_time_local
    ) {
      synthesizedCheckins.push({
        checkin_id: value.first_checkin_id,
        sequence_in_day: 1,
        captured_at: value.first_captured_at,
        captured_at_local: value.first_captured_at_local,
        time_local: value.first_time_local,
        time_verified: value.unverified_checkin_count === 0,
        distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
        distance_status: value.distance_status as AttendanceDistanceStatus | null,
        distance_meters:
          value.distance_meters === null ? null : normalizeZero(value.distance_meters),
      });

      if (
        value.checkin_count > 1 &&
        value.last_checkin_id &&
        value.last_checkin_id.toLowerCase() !== value.first_checkin_id.toLowerCase() &&
        value.last_captured_at &&
        value.last_captured_at_local &&
        value.last_time_local
      ) {
        synthesizedCheckins.push({
          checkin_id: value.last_checkin_id,
          sequence_in_day: value.checkin_count,
          captured_at: value.last_captured_at,
          captured_at_local: value.last_captured_at_local,
          time_local: value.last_time_local,
          time_verified: value.unverified_checkin_count === 0,
          distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
          distance_status: value.distance_status as AttendanceDistanceStatus | null,
          distance_meters:
            value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
        });
      }
    }

    const evaluated = evaluateAttendanceDaySlots({
      checkins: synthesizedCheckins,
      approved_leaves: approvedLeaves,
    });
    policyVersionUsed = evaluated.policy_version_used;
    missingSlotCount = evaluated.missing_slot_count;
    lateOrEarlyCheckinCount = evaluated.late_or_early_checkin_count;
    slots = evaluated.slots;
  }

  return {
    business_date: value.business_date,
    day_of_month: value.day_of_month,
    ...(hasMultiProfileKeys
      ? {
          policy_profile_id_used: (value.policy_profile_id_used as string).toLowerCase(),
          policy_profile_code_used: value.policy_profile_code_used as string,
          policy_profile_name_used: (value.policy_profile_name_used as string).trim(),
          policy_is_default_used: value.policy_is_default_used as boolean,
        }
      : {}),
    policy_version_used: policyVersionUsed,
    has_checkin: value.has_checkin,
    checkin_count: value.checkin_count,
    first_checkin_id:
      value.first_checkin_id === null ? null : value.first_checkin_id.toLowerCase(),
    last_checkin_id: value.last_checkin_id === null ? null : value.last_checkin_id.toLowerCase(),
    first_captured_at: value.first_captured_at,
    first_captured_at_local: value.first_captured_at_local,
    first_time_local: value.first_time_local,
    last_captured_at: value.last_captured_at,
    last_captured_at_local: value.last_captured_at_local,
    last_time_local: value.last_time_local,
    verified_checkin_count: value.verified_checkin_count,
    unverified_checkin_count: value.unverified_checkin_count,
    distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
    branch_id_used: value.branch_id_used === null ? null : value.branch_id_used.toLowerCase(),
    branch_code_used: value.branch_code_used,
    branch_name_used: value.branch_name_used,
    branch_version_used: value.branch_version_used,
    hq_version_used: value.hq_version_used,
    distance_status: value.distance_status as AttendanceDistanceStatus | null,
    distance_meters:
      value.distance_meters === null ? null : normalizeZero(value.distance_meters),
    min_distance_meters:
      value.min_distance_meters === null ? null : normalizeZero(value.min_distance_meters),
    max_distance_meters:
      value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
    has_approved_leave: value.has_approved_leave,
    approved_leave_units: normalizeZero(value.approved_leave_units),
    approved_leaves: approvedLeaves,
    day_status: value.day_status as AttendanceMonthlyMatrixDayStatus,
    missing_slot_count: missingSlotCount,
    late_or_early_checkin_count: lateOrEarlyCheckinCount,
    slots,
  };
}

function projectEmployeeSlotPolicyProfile(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeSlotPolicyProfileProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "profile_id",
      "profile_code",
      "display_name",
      "is_default",
      "assignment_id",
      "valid_from",
      "valid_to",
      "profile_names_in_month",
    ]) ||
    !isUuidString(value.profile_id) ||
    typeof value.profile_code !== "string" ||
    !SLOT_PROFILE_CODE_PATTERN.test(value.profile_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.is_default !== "boolean" ||
    (value.assignment_id !== null && !isUuidString(value.assignment_id)) ||
    (value.valid_from !== null &&
      (typeof value.valid_from !== "string" || !isValidIsoCalendarDate(value.valid_from))) ||
    (value.valid_to !== null &&
      (typeof value.valid_to !== "string" || !isValidIsoCalendarDate(value.valid_to))) ||
    !Array.isArray(value.profile_names_in_month)
  ) {
    return null;
  }

  const profileNamesInMonth: string[] = [];
  for (const rawName of value.profile_names_in_month) {
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      return null;
    }
    profileNamesInMonth.push(rawName.trim());
  }

  return {
    profile_id: value.profile_id.toLowerCase(),
    profile_code: value.profile_code,
    display_name: value.display_name.trim(),
    is_default: value.is_default,
    assignment_id: value.assignment_id === null ? null : value.assignment_id.toLowerCase(),
    valid_from: value.valid_from,
    valid_to: value.valid_to,
    profile_names_in_month: profileNamesInMonth,
  };
}

function projectEmployeeRow(
  value: unknown,
  expectedDaysInMonth: number,
): AttendanceMonthlyMatrixEmployeeRowProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "app_user_id",
    "employee_display_name",
    "personnel_code",
    "enabled",
    "branch",
    "summary",
    "days",
  ] as const;
  const withSlotProfileKeys = [...baseKeys, "slot_policy_profile"] as const;
  const hasSlotProfileKey = hasExactKeys(value, withSlotProfileKeys);
  const hasBaseKeys = !hasSlotProfileKey && hasExactKeys(value, baseKeys);
  if (!hasSlotProfileKey && !hasBaseKeys) {
    return null;
  }
  if (
    !isUuidString(value.app_user_id) ||
    typeof value.employee_display_name !== "string" ||
    value.employee_display_name.trim().length === 0 ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.days) ||
    value.days.length !== expectedDaysInMonth
  ) {
    return null;
  }

  let branch: AttendanceMonthlyMatrixEmployeeBranchProjection | null = null;
  if (value.branch !== null) {
    branch = projectEmployeeBranch(value.branch);
    if (!branch) return null;
  }

  let slotPolicyProfile:
    | AttendanceMonthlyMatrixEmployeeSlotPolicyProfileProjection
    | undefined = undefined;
  if (hasSlotProfileKey && value.slot_policy_profile !== null) {
    const projectedProfile = projectEmployeeSlotPolicyProfile(value.slot_policy_profile);
    if (!projectedProfile) return null;
    slotPolicyProfile = projectedProfile;
  }

  const summary = projectEmployeeSummary(value.summary);
  if (!summary) return null;

  const days: AttendanceMonthlyMatrixDayCellProjection[] = [];
  for (const rawDay of value.days) {
    const projectedDay = projectDayCell(rawDay);
    if (!projectedDay) return null;
    days.push(projectedDay);
  }

  return {
    app_user_id: value.app_user_id.toLowerCase(),
    employee_display_name: value.employee_display_name,
    personnel_code: value.personnel_code,
    enabled: value.enabled,
    branch,
    ...(slotPolicyProfile !== undefined ? { slot_policy_profile: slotPolicyProfile } : {}),
    summary,
    days,
  };
}

export function projectAttendanceMonthlyMatrixReport(
  rawValue: unknown,
): AttendanceMonthlyMatrixReportProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value) {
    return null;
  }
  const baseRootKeys = [
    "viewer",
    "filters",
    "days_in_month",
    "calendar_days",
    "current_hq",
    "branch_options",
    "employee_options",
    "overview",
    "pagination",
    "items",
  ] as const;
  const fullRootKeys = [...baseRootKeys, "slot_policy"] as const;

  const hasSlotPolicyKey = hasExactKeys(value, fullRootKeys);
  const hasBaseRootKeys = !hasSlotPolicyKey && hasExactKeys(value, baseRootKeys);
  if (!hasSlotPolicyKey && !hasBaseRootKeys) {
    return null;
  }

  if (!isRecord(value.viewer)) {
    return null;
  }
  const viewerHasSlotFlag = hasExactKeys(value.viewer, [
    "can_configure_hq",
    "can_manage_branches",
    "can_manage_slot_policy",
  ]);
  const viewerHasLegacyFlags =
    !viewerHasSlotFlag &&
    hasExactKeys(value.viewer, ["can_configure_hq", "can_manage_branches"]);
  if (
    (!viewerHasSlotFlag && !viewerHasLegacyFlags) ||
    typeof value.viewer.can_configure_hq !== "boolean" ||
    typeof value.viewer.can_manage_branches !== "boolean" ||
    (viewerHasSlotFlag && typeof value.viewer.can_manage_slot_policy !== "boolean")
  ) {
    return null;
  }

  if (
    !isRecord(value.filters) ||
    !hasExactKeys(value.filters, [
      "year_month",
      "from_date",
      "to_date",
      "branch_id",
      "employee_id",
      "search",
      "timezone",
    ])
  ) {
    return null;
  }
  const filters = value.filters;
  if (
    typeof filters.year_month !== "string" ||
    !isValidYearMonth(filters.year_month) ||
    typeof filters.from_date !== "string" ||
    !isValidIsoCalendarDate(filters.from_date) ||
    typeof filters.to_date !== "string" ||
    !isValidIsoCalendarDate(filters.to_date) ||
    (filters.branch_id !== null && !isUuidString(filters.branch_id)) ||
    (filters.employee_id !== null && !isUuidString(filters.employee_id)) ||
    (filters.search !== null && typeof filters.search !== "string") ||
    filters.timezone !== ATTENDANCE_BUSINESS_TIMEZONE
  ) {
    return null;
  }

  if (
    typeof value.days_in_month !== "number" ||
    !Number.isSafeInteger(value.days_in_month) ||
    value.days_in_month < 1 ||
    value.days_in_month > 31 ||
    !Array.isArray(value.calendar_days) ||
    value.calendar_days.length !== value.days_in_month
  ) {
    return null;
  }

  const calendarDays: AttendanceMonthlyMatrixCalendarDayProjection[] = [];
  for (const rawCal of value.calendar_days) {
    const projectedCal = projectCalendarDay(rawCal);
    if (!projectedCal) return null;
    calendarDays.push(projectedCal);
  }

  let currentHq: AttendanceHqLocationProjection | null = null;
  if (value.current_hq !== null) {
    currentHq = projectHqLocation(value.current_hq);
    if (!currentHq) return null;
  }

  let slotPolicy: AttendanceMonthlyMatrixSlotPolicySummaryProjection = {
    current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    latest_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    month_policies: [DEFAULT_ATTENDANCE_SLOT_POLICY],
  };
  if (hasSlotPolicyKey) {
    const projectedPolicySummary = projectSlotPolicySummary(value.slot_policy);
    if (!projectedPolicySummary) return null;
    slotPolicy = projectedPolicySummary;
  }

  if (!Array.isArray(value.branch_options) || !Array.isArray(value.employee_options)) {
    return null;
  }
  const branchOptions: AttendanceBranchOptionProjection[] = [];
  for (const rawOpt of value.branch_options) {
    const projectedOpt = projectBranchOption(rawOpt);
    if (!projectedOpt) return null;
    branchOptions.push(projectedOpt);
  }

  const employeeOptions: AttendanceMonthlyMatrixEmployeeOptionProjection[] = [];
  for (const rawOpt of value.employee_options) {
    const projectedOpt = projectEmployeeOption(rawOpt);
    if (!projectedOpt) return null;
    employeeOptions.push(projectedOpt);
  }

  const overview = projectOverview(value.overview);
  if (!overview) return null;

  const pagination = projectPagination(value.pagination);
  if (!pagination) return null;

  if (!Array.isArray(value.items)) return null;
  const items: AttendanceMonthlyMatrixEmployeeRowProjection[] = [];
  for (const rawItem of value.items) {
    const projectedItem = projectEmployeeRow(rawItem, value.days_in_month);
    if (!projectedItem) return null;
    items.push(projectedItem);
  }

  return {
    viewer: {
      can_configure_hq: value.viewer.can_configure_hq,
      can_manage_branches: value.viewer.can_manage_branches,
      can_manage_slot_policy: viewerHasSlotFlag
        ? (value.viewer.can_manage_slot_policy as boolean)
        : value.viewer.can_configure_hq,
    },
    filters: {
      year_month: filters.year_month,
      from_date: filters.from_date,
      to_date: filters.to_date,
      branch_id: filters.branch_id === null ? null : filters.branch_id.toLowerCase(),
      employee_id: filters.employee_id === null ? null : filters.employee_id.toLowerCase(),
      search: filters.search,
      timezone: ATTENDANCE_BUSINESS_TIMEZONE,
    },
    days_in_month: value.days_in_month,
    calendar_days: calendarDays,
    current_hq: currentHq,
    slot_policy: slotPolicy,
    branch_options: branchOptions,
    employee_options: employeeOptions,
    overview,
    pagination,
    items,
  };
}

export function projectAttendanceSlotPoliciesAdminList(
  rawValue: unknown,
): AttendanceSlotPoliciesAdminListProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value) {
    return null;
  }
  const baseKeys = [
    "viewer",
    "business_date",
    "current_policy",
    "latest_policy",
    "versions",
  ] as const;
  const multiProfileKeys = [
    ...baseKeys,
    "profiles",
    "assignments",
    "employee_options",
  ] as const;
  const hasMultiProfileKeys = hasExactKeys(value, multiProfileKeys);
  const hasBaseKeys = !hasMultiProfileKeys && hasExactKeys(value, baseKeys);
  if (!hasMultiProfileKeys && !hasBaseKeys) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["can_manage_slot_policy"]) ||
    typeof value.viewer.can_manage_slot_policy !== "boolean" ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    !Array.isArray(value.versions) ||
    value.versions.length < 1
  ) {
    return null;
  }

  const currentPolicy = projectAttendanceSlotPolicy(value.current_policy);
  const latestPolicy = projectAttendanceSlotPolicy(value.latest_policy);
  if (!currentPolicy || !latestPolicy) {
    return null;
  }

  const versions: AttendanceSlotPolicyProjection[] = [];
  for (const raw of value.versions) {
    const projected = projectAttendanceSlotPolicy(raw);
    if (!projected) return null;
    versions.push(projected);
  }

  let profiles: AttendanceSlotPolicyProfileAdminItemProjection[] | undefined = undefined;
  let assignments: AttendanceSlotPolicyAssignmentAdminItemProjection[] | undefined =
    undefined;
  let employeeOptions: AttendanceSlotPolicyEmployeeOptionProjection[] | undefined =
    undefined;

  if (hasMultiProfileKeys) {
    if (
      !Array.isArray(value.profiles) ||
      value.profiles.length < 1 ||
      !Array.isArray(value.assignments) ||
      !Array.isArray(value.employee_options)
    ) {
      return null;
    }

    profiles = [];
    for (const rawProfile of value.profiles) {
      if (
        !isRecord(rawProfile) ||
        !hasExactKeys(rawProfile, [
          "profile_id",
          "profile_code",
          "display_name",
          "description",
          "is_default",
          "active",
          "version",
          "active_assignment_count",
          "current_policy",
          "latest_policy",
          "versions",
        ]) ||
        !isUuidString(rawProfile.profile_id) ||
        typeof rawProfile.profile_code !== "string" ||
        !SLOT_PROFILE_CODE_PATTERN.test(rawProfile.profile_code) ||
        typeof rawProfile.display_name !== "string" ||
        rawProfile.display_name.trim().length === 0 ||
        (rawProfile.description !== null && typeof rawProfile.description !== "string") ||
        typeof rawProfile.is_default !== "boolean" ||
        typeof rawProfile.active !== "boolean" ||
        typeof rawProfile.version !== "number" ||
        !Number.isSafeInteger(rawProfile.version) ||
        rawProfile.version < 1 ||
        typeof rawProfile.active_assignment_count !== "number" ||
        !Number.isSafeInteger(rawProfile.active_assignment_count) ||
        rawProfile.active_assignment_count < 0 ||
        !Array.isArray(rawProfile.versions) ||
        rawProfile.versions.length < 1
      ) {
        return null;
      }

      const profileCurrentPolicy = projectAttendanceSlotPolicy(rawProfile.current_policy);
      const profileLatestPolicy = projectAttendanceSlotPolicy(rawProfile.latest_policy);
      if (!profileCurrentPolicy || !profileLatestPolicy) {
        return null;
      }

      const profileVersions: AttendanceSlotPolicyProjection[] = [];
      for (const rawVer of rawProfile.versions) {
        const projectedVer = projectAttendanceSlotPolicy(rawVer);
        if (!projectedVer) return null;
        profileVersions.push(projectedVer);
      }

      profiles.push({
        profile_id: rawProfile.profile_id.toLowerCase(),
        profile_code: rawProfile.profile_code,
        display_name: rawProfile.display_name.trim(),
        description: rawProfile.description,
        is_default: rawProfile.is_default,
        active: rawProfile.active,
        version: rawProfile.version,
        active_assignment_count: rawProfile.active_assignment_count,
        current_policy: profileCurrentPolicy,
        latest_policy: profileLatestPolicy,
        versions: profileVersions,
      });
    }

    assignments = [];
    for (const rawAsg of value.assignments) {
      if (
        !isRecord(rawAsg) ||
        !hasExactKeys(rawAsg, [
          "assignment_id",
          "app_user_id",
          "employee_display_name",
          "personnel_code",
          "enabled",
          "profile_id",
          "profile_code",
          "profile_name",
          "valid_from",
          "valid_to",
          "superseded_same_day",
          "effective",
          "version",
          "created_at",
          "updated_at",
        ]) ||
        !isUuidString(rawAsg.assignment_id) ||
        !isUuidString(rawAsg.app_user_id) ||
        typeof rawAsg.employee_display_name !== "string" ||
        (rawAsg.personnel_code !== null && typeof rawAsg.personnel_code !== "string") ||
        typeof rawAsg.enabled !== "boolean" ||
        !isUuidString(rawAsg.profile_id) ||
        typeof rawAsg.profile_code !== "string" ||
        !SLOT_PROFILE_CODE_PATTERN.test(rawAsg.profile_code) ||
        typeof rawAsg.profile_name !== "string" ||
        rawAsg.profile_name.trim().length === 0 ||
        typeof rawAsg.valid_from !== "string" ||
        !isValidIsoCalendarDate(rawAsg.valid_from) ||
        (rawAsg.valid_to !== null &&
          (typeof rawAsg.valid_to !== "string" ||
            !isValidIsoCalendarDate(rawAsg.valid_to))) ||
        typeof rawAsg.superseded_same_day !== "boolean" ||
        typeof rawAsg.effective !== "boolean" ||
        typeof rawAsg.version !== "number" ||
        !Number.isSafeInteger(rawAsg.version) ||
        rawAsg.version < 1 ||
        typeof rawAsg.created_at !== "string" ||
        typeof rawAsg.updated_at !== "string"
      ) {
        return null;
      }

      assignments.push({
        assignment_id: rawAsg.assignment_id.toLowerCase(),
        app_user_id: rawAsg.app_user_id.toLowerCase(),
        employee_display_name: rawAsg.employee_display_name,
        personnel_code: rawAsg.personnel_code,
        enabled: rawAsg.enabled,
        profile_id: rawAsg.profile_id.toLowerCase(),
        profile_code: rawAsg.profile_code,
        profile_name: rawAsg.profile_name.trim(),
        valid_from: rawAsg.valid_from,
        valid_to: rawAsg.valid_to,
        superseded_same_day: rawAsg.superseded_same_day,
        effective: rawAsg.effective,
        version: rawAsg.version,
        created_at: rawAsg.created_at,
        updated_at: rawAsg.updated_at,
      });
    }

    employeeOptions = [];
    for (const rawEmp of value.employee_options) {
      if (
        !isRecord(rawEmp) ||
        !hasExactKeys(rawEmp, [
          "app_user_id",
          "display_name",
          "employee_display_name",
          "personnel_code",
          "enabled",
          "current_profile_id",
          "current_profile_code",
          "current_profile_name",
          "current_profile_is_default",
          "current_assignment_id",
          "current_assignment_version",
          "current_assignment_valid_from",
        ]) ||
        !isUuidString(rawEmp.app_user_id) ||
        typeof rawEmp.display_name !== "string" ||
        typeof rawEmp.employee_display_name !== "string" ||
        (rawEmp.personnel_code !== null && typeof rawEmp.personnel_code !== "string") ||
        typeof rawEmp.enabled !== "boolean" ||
        !isUuidString(rawEmp.current_profile_id) ||
        typeof rawEmp.current_profile_code !== "string" ||
        !SLOT_PROFILE_CODE_PATTERN.test(rawEmp.current_profile_code) ||
        typeof rawEmp.current_profile_name !== "string" ||
        rawEmp.current_profile_name.trim().length === 0 ||
        typeof rawEmp.current_profile_is_default !== "boolean" ||
        (rawEmp.current_assignment_id !== null &&
          !isUuidString(rawEmp.current_assignment_id)) ||
        (rawEmp.current_assignment_version !== null &&
          (typeof rawEmp.current_assignment_version !== "number" ||
            !Number.isSafeInteger(rawEmp.current_assignment_version) ||
            rawEmp.current_assignment_version < 1)) ||
        (rawEmp.current_assignment_valid_from !== null &&
          (typeof rawEmp.current_assignment_valid_from !== "string" ||
            !isValidIsoCalendarDate(rawEmp.current_assignment_valid_from)))
      ) {
        return null;
      }

      employeeOptions.push({
        app_user_id: rawEmp.app_user_id.toLowerCase(),
        display_name: rawEmp.display_name,
        employee_display_name: rawEmp.employee_display_name,
        personnel_code: rawEmp.personnel_code,
        enabled: rawEmp.enabled,
        current_profile_id: rawEmp.current_profile_id.toLowerCase(),
        current_profile_code: rawEmp.current_profile_code,
        current_profile_name: rawEmp.current_profile_name.trim(),
        current_profile_is_default: rawEmp.current_profile_is_default,
        current_assignment_id:
          rawEmp.current_assignment_id === null
            ? null
            : rawEmp.current_assignment_id.toLowerCase(),
        current_assignment_version: rawEmp.current_assignment_version,
        current_assignment_valid_from: rawEmp.current_assignment_valid_from,
      });
    }
  }

  return {
    viewer: {
      can_manage_slot_policy: value.viewer.can_manage_slot_policy,
    },
    business_date: value.business_date,
    current_policy: currentPolicy,
    latest_policy: latestPolicy,
    versions,
    ...(profiles !== undefined ? { profiles } : {}),
    ...(assignments !== undefined ? { assignments } : {}),
    ...(employeeOptions !== undefined ? { employee_options: employeeOptions } : {}),
  };
}

export function projectCreateSlotPolicyResult(
  rawValue: unknown,
): CreateAttendanceSlotPolicyResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value || typeof value.replayed !== "boolean") {
    return null;
  }
  const hasProfileKey = hasExactKeys(value, ["replayed", "policy", "profile"]);
  const hasBaseKeys = !hasProfileKey && hasExactKeys(value, ["replayed", "policy"]);
  if (!hasProfileKey && !hasBaseKeys) {
    return null;
  }
  const policy = projectAttendanceSlotPolicy(value.policy);
  if (!policy) return null;

  let profile: AttendanceSlotPolicyProfileSavedProjection | undefined = undefined;
  if (hasProfileKey) {
    if (
      !isRecord(value.profile) ||
      !hasExactKeys(value.profile, [
        "profile_id",
        "profile_code",
        "display_name",
        "description",
        "is_default",
        "active",
        "version",
      ]) ||
      !isUuidString(value.profile.profile_id) ||
      typeof value.profile.profile_code !== "string" ||
      !SLOT_PROFILE_CODE_PATTERN.test(value.profile.profile_code) ||
      typeof value.profile.display_name !== "string" ||
      value.profile.display_name.trim().length === 0 ||
      (value.profile.description !== null &&
        typeof value.profile.description !== "string") ||
      typeof value.profile.is_default !== "boolean" ||
      typeof value.profile.active !== "boolean" ||
      typeof value.profile.version !== "number" ||
      !Number.isSafeInteger(value.profile.version) ||
      value.profile.version < 1
    ) {
      return null;
    }
    profile = {
      profile_id: value.profile.profile_id.toLowerCase(),
      profile_code: value.profile.profile_code,
      display_name: value.profile.display_name.trim(),
      description: value.profile.description,
      is_default: value.profile.is_default,
      active: value.profile.active,
      version: value.profile.version,
    };
  }

  return {
    replayed: value.replayed,
    policy,
    ...(profile !== undefined ? { profile } : {}),
  };
}

export const projectUpsertSlotPolicyProfileResult = projectCreateSlotPolicyResult;

export function projectAssignSlotPolicyResult(
  rawValue: unknown,
): AssignAttendanceSlotPolicyResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (
    !value ||
    !hasExactKeys(value, ["replayed", "assignment"]) ||
    typeof value.replayed !== "boolean" ||
    !isRecord(value.assignment)
  ) {
    return null;
  }
  const a = value.assignment;
  const fullKeys = [
    "assignment_id",
    "app_user_id",
    "employee_display_name",
    "personnel_code",
    "enabled",
    "profile_id",
    "profile_code",
    "profile_name",
    "valid_from",
    "valid_to",
    "superseded_same_day",
    "effective",
    "version",
  ] as const;
  const minimalKeys = [
    "assignment_id",
    "app_user_id",
    "profile_id",
    "profile_code",
    "profile_name",
    "valid_from",
    "valid_to",
    "superseded_same_day",
    "effective",
    "version",
  ] as const;
  const hasFullKeys = hasExactKeys(a, fullKeys);
  const hasMinimalKeys = !hasFullKeys && hasExactKeys(a, minimalKeys);
  if (!hasFullKeys && !hasMinimalKeys) {
    return null;
  }
  if (
    !isUuidString(a.assignment_id) ||
    !isUuidString(a.app_user_id) ||
    !isUuidString(a.profile_id) ||
    typeof a.profile_code !== "string" ||
    !SLOT_PROFILE_CODE_PATTERN.test(a.profile_code) ||
    typeof a.profile_name !== "string" ||
    a.profile_name.trim().length === 0 ||
    typeof a.valid_from !== "string" ||
    !isValidIsoCalendarDate(a.valid_from) ||
    (a.valid_to !== null &&
      (typeof a.valid_to !== "string" || !isValidIsoCalendarDate(a.valid_to))) ||
    typeof a.superseded_same_day !== "boolean" ||
    typeof a.effective !== "boolean" ||
    typeof a.version !== "number" ||
    !Number.isSafeInteger(a.version) ||
    a.version < 1
  ) {
    return null;
  }
  if (hasFullKeys) {
    if (
      typeof a.employee_display_name !== "string" ||
      (a.personnel_code !== null && typeof a.personnel_code !== "string") ||
      typeof a.enabled !== "boolean"
    ) {
      return null;
    }
  }
  return {
    replayed: value.replayed,
    assignment: {
      assignment_id: a.assignment_id.toLowerCase(),
      app_user_id: a.app_user_id.toLowerCase(),
      ...(hasFullKeys
        ? {
            employee_display_name: a.employee_display_name as string,
            personnel_code: a.personnel_code as string | null,
            enabled: a.enabled as boolean,
          }
        : {}),
      profile_id: a.profile_id.toLowerCase(),
      profile_code: a.profile_code,
      profile_name: a.profile_name.trim(),
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      superseded_same_day: a.superseded_same_day,
      effective: a.effective,
      version: a.version,
    },
  };
}

export const projectUnassignSlotPolicyResult = projectAssignSlotPolicyResult;

export function projectAttendanceBranchesAdminList(
  rawValue: unknown,
): AttendanceBranchesAdminListProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (
    !value ||
    !hasExactKeys(value, [
      "viewer",
      "business_date",
      "include_inactive",
      "branches",
      "assignments",
      "employee_options",
    ])
  ) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["can_manage_branches"]) ||
    typeof value.viewer.can_manage_branches !== "boolean" ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.include_inactive !== "boolean" ||
    !Array.isArray(value.branches) ||
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.employee_options)
  ) {
    return null;
  }

  const branches: AttendanceBranchAdminItemProjection[] = [];
  for (const raw of value.branches) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "branch_id",
        "branch_code",
        "display_name",
        "address",
        "latitude",
        "longitude",
        "active",
        "version",
        "active_assignment_count",
        "created_at",
        "updated_at",
        "updated_by_display_name",
      ]) ||
      !isUuidString(raw.branch_id) ||
      typeof raw.branch_code !== "string" ||
      !BRANCH_CODE_PATTERN.test(raw.branch_code) ||
      typeof raw.display_name !== "string" ||
      raw.display_name.trim().length === 0 ||
      typeof raw.address !== "string" ||
      typeof raw.active !== "boolean" ||
      typeof raw.version !== "number" ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      typeof raw.active_assignment_count !== "number" ||
      !Number.isSafeInteger(raw.active_assignment_count) ||
      raw.active_assignment_count < 0 ||
      typeof raw.created_at !== "string" ||
      typeof raw.updated_at !== "string" ||
      typeof raw.updated_by_display_name !== "string" ||
      (raw.latitude === null) !== (raw.longitude === null)
    ) {
      return null;
    }
    if (
      raw.latitude !== null &&
      (!isFiniteNumber(raw.latitude) || raw.latitude < -90 || raw.latitude > 90)
    ) {
      return null;
    }
    if (
      raw.longitude !== null &&
      (!isFiniteNumber(raw.longitude) || raw.longitude < -180 || raw.longitude > 180)
    ) {
      return null;
    }
    branches.push({
      branch_id: raw.branch_id.toLowerCase(),
      branch_code: raw.branch_code,
      display_name: raw.display_name,
      address: raw.address,
      latitude: raw.latitude === null ? null : normalizeZero(raw.latitude),
      longitude: raw.longitude === null ? null : normalizeZero(raw.longitude),
      active: raw.active,
      version: raw.version,
      active_assignment_count: raw.active_assignment_count,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      updated_by_display_name: raw.updated_by_display_name,
    });
  }

  const assignments: AttendanceBranchAssignmentAdminItemProjection[] = [];
  for (const raw of value.assignments) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "assignment_id",
        "app_user_id",
        "employee_display_name",
        "personnel_code",
        "branch_id",
        "branch_code",
        "branch_name",
        "valid_from",
        "valid_to",
        "effective",
        "version",
        "created_at",
        "updated_at",
      ]) ||
      !isUuidString(raw.assignment_id) ||
      !isUuidString(raw.app_user_id) ||
      typeof raw.employee_display_name !== "string" ||
      (raw.personnel_code !== null && typeof raw.personnel_code !== "string") ||
      !isUuidString(raw.branch_id) ||
      typeof raw.branch_code !== "string" ||
      typeof raw.branch_name !== "string" ||
      typeof raw.valid_from !== "string" ||
      !isValidIsoCalendarDate(raw.valid_from) ||
      (raw.valid_to !== null &&
        (typeof raw.valid_to !== "string" || !isValidIsoCalendarDate(raw.valid_to))) ||
      typeof raw.effective !== "boolean" ||
      typeof raw.version !== "number" ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      typeof raw.created_at !== "string" ||
      typeof raw.updated_at !== "string"
    ) {
      return null;
    }
    assignments.push({
      assignment_id: raw.assignment_id.toLowerCase(),
      app_user_id: raw.app_user_id.toLowerCase(),
      employee_display_name: raw.employee_display_name,
      personnel_code: raw.personnel_code,
      branch_id: raw.branch_id.toLowerCase(),
      branch_code: raw.branch_code,
      branch_name: raw.branch_name,
      valid_from: raw.valid_from,
      valid_to: raw.valid_to,
      effective: raw.effective,
      version: raw.version,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    });
  }

  const employeeOptions: AttendanceBranchAdminEmployeeOptionProjection[] = [];
  for (const raw of value.employee_options) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["app_user_id", "display_name", "personnel_code", "enabled"]) ||
      !isUuidString(raw.app_user_id) ||
      typeof raw.display_name !== "string" ||
      (raw.personnel_code !== null && typeof raw.personnel_code !== "string") ||
      typeof raw.enabled !== "boolean"
    ) {
      return null;
    }
    employeeOptions.push({
      app_user_id: raw.app_user_id.toLowerCase(),
      display_name: raw.display_name,
      personnel_code: raw.personnel_code,
      enabled: raw.enabled,
    });
  }

  return {
    viewer: {
      can_manage_branches: value.viewer.can_manage_branches,
    },
    business_date: value.business_date,
    include_inactive: value.include_inactive,
    branches,
    assignments,
    employee_options: employeeOptions,
  };
}

export function projectUpsertBranchResult(
  rawValue: unknown,
): UpsertAttendanceBranchResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value || !hasExactKeys(value, ["replayed", "branch"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.branch)) {
    return null;
  }
  const b = value.branch;
  if (
    !hasExactKeys(b, [
      "branch_id",
      "branch_code",
      "display_name",
      "address",
      "latitude",
      "longitude",
      "active",
      "version",
      "updated_at",
      "updated_by_display_name",
    ]) ||
    !isUuidString(b.branch_id) ||
    typeof b.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(b.branch_code) ||
    typeof b.display_name !== "string" ||
    b.display_name.trim().length === 0 ||
    typeof b.address !== "string" ||
    typeof b.active !== "boolean" ||
    typeof b.version !== "number" ||
    !Number.isSafeInteger(b.version) ||
    b.version < 1 ||
    typeof b.updated_at !== "string" ||
    typeof b.updated_by_display_name !== "string" ||
    (b.latitude === null) !== (b.longitude === null)
  ) {
    return null;
  }
  if (
    b.latitude !== null &&
    (!isFiniteNumber(b.latitude) || b.latitude < -90 || b.latitude > 90)
  ) {
    return null;
  }
  if (
    b.longitude !== null &&
    (!isFiniteNumber(b.longitude) || b.longitude < -180 || b.longitude > 180)
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    branch: {
      branch_id: b.branch_id.toLowerCase(),
      branch_code: b.branch_code,
      display_name: b.display_name,
      address: b.address,
      latitude: b.latitude === null ? null : normalizeZero(b.latitude),
      longitude: b.longitude === null ? null : normalizeZero(b.longitude),
      active: b.active,
      version: b.version,
      updated_at: b.updated_at,
      updated_by_display_name: b.updated_by_display_name,
    },
  };
}

export function projectAssignBranchResult(
  rawValue: unknown,
): AssignAttendanceBranchResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value || !hasExactKeys(value, ["replayed", "assignment"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.assignment)) {
    return null;
  }
  const a = value.assignment;
  if (
    !hasExactKeys(a, [
      "assignment_id",
      "app_user_id",
      "branch_id",
      "branch_code",
      "branch_name",
      "valid_from",
      "valid_to",
      "version",
    ]) ||
    !isUuidString(a.assignment_id) ||
    !isUuidString(a.app_user_id) ||
    !isUuidString(a.branch_id) ||
    typeof a.branch_code !== "string" ||
    typeof a.branch_name !== "string" ||
    typeof a.valid_from !== "string" ||
    !isValidIsoCalendarDate(a.valid_from) ||
    (a.valid_to !== null &&
      (typeof a.valid_to !== "string" || !isValidIsoCalendarDate(a.valid_to))) ||
    typeof a.version !== "number" ||
    !Number.isSafeInteger(a.version) ||
    a.version < 1
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    assignment: {
      assignment_id: a.assignment_id.toLowerCase(),
      app_user_id: a.app_user_id.toLowerCase(),
      branch_id: a.branch_id.toLowerCase(),
      branch_code: a.branch_code,
      branch_name: a.branch_name,
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      version: a.version,
    },
  };
}

export function projectUnassignBranchResult(
  rawValue: unknown,
): UnassignAttendanceBranchResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (!value || !hasExactKeys(value, ["replayed", "assignment"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.assignment)) {
    return null;
  }
  const a = value.assignment;
  if (
    !hasExactKeys(a, [
      "assignment_id",
      "app_user_id",
      "branch_id",
      "valid_from",
      "valid_to",
      "version",
    ]) ||
    !isUuidString(a.assignment_id) ||
    !isUuidString(a.app_user_id) ||
    !isUuidString(a.branch_id) ||
    typeof a.valid_from !== "string" ||
    !isValidIsoCalendarDate(a.valid_from) ||
    (a.valid_to !== null &&
      (typeof a.valid_to !== "string" || !isValidIsoCalendarDate(a.valid_to))) ||
    typeof a.version !== "number" ||
    !Number.isSafeInteger(a.version) ||
    a.version < 1
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    assignment: {
      assignment_id: a.assignment_id.toLowerCase(),
      app_user_id: a.app_user_id.toLowerCase(),
      branch_id: a.branch_id.toLowerCase(),
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      version: a.version,
    },
  };
}

export function parseMyAttendanceExplanationsQuery(
  url: URL,
):
  | { ok: true; value: ParsedMyAttendanceExplanationsQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["business_date", "limit", "offset"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_QUERY_INVALID" };
    }
  }

  let businessDate: string | null = null;
  const rawDate = url.searchParams.get("business_date");
  if (rawDate !== null && rawDate.trim() !== "") {
    const trimmed = rawDate.trim();
    if (
      !isValidIsoCalendarDate(trimmed) ||
      trimmed < "2000-01-01" ||
      trimmed > "2100-12-31"
    ) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_DATE_INVALID" };
    }
    businessDate = trimmed;
  }

  const rawLimit = url.searchParams.get("limit") ?? "50";
  const rawOffset = url.searchParams.get("offset") ?? "0";
  if (!/^\d{1,6}$/.test(rawLimit) || !/^\d{1,6}$/.test(rawOffset)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_PAGINATION_INVALID" };
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_PAGINATION_INVALID" };
  }

  return {
    ok: true,
    value: {
      business_date: businessDate,
      limit,
      offset,
    },
  };
}

export const parseAttendanceExplanationsQuery = parseMyAttendanceExplanationsQuery;

export function parseSubmitAttendanceExplanationBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedSubmitAttendanceExplanationRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_QUERY_INVALID" };
  }
  const allowedKeys = new Set(["business_date", "slot_code", "reason", "idempotency_key"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_QUERY_INVALID" };
    }
  }

  const businessDate =
    typeof body.business_date === "string" ? body.business_date.trim() : "";
  if (
    !isValidIsoCalendarDate(businessDate) ||
    businessDate < "2000-01-01" ||
    businessDate > "2100-12-31"
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_DATE_INVALID" };
  }

  const rawSlotCode =
    typeof body.slot_code === "string" ? body.slot_code.trim().toUpperCase() : "";
  if (!ATTENDANCE_SLOT_CODES.includes(rawSlotCode as AttendanceSlotCode)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_SLOT_INVALID" };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (
    reason.length < 3 ||
    reason.length > 500 ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(reason)
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_REASON_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      business_date: businessDate,
      slot_code: rawSlotCode as AttendanceSlotCode,
      reason,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseAttendanceExplanationApprovalInboxQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceExplanationApprovalInboxQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["status", "limit", "offset"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_QUERY_INVALID" };
    }
  }

  let status: "ALL" | AttendanceExplanationStatus | null = null;
  const rawStatus = url.searchParams.get("status");
  if (rawStatus !== null && rawStatus.trim() !== "") {
    const normalized = rawStatus.trim().toUpperCase();
    if (
      normalized !== "ALL" &&
      !ATTENDANCE_EXPLANATION_STATUSES.includes(normalized as AttendanceExplanationStatus)
    ) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_FILTER_INVALID" };
    }
    status = normalized as "ALL" | AttendanceExplanationStatus;
  }

  const rawLimit = url.searchParams.get("limit") ?? "50";
  const rawOffset = url.searchParams.get("offset") ?? "0";
  if (!/^\d{1,6}$/.test(rawLimit) || !/^\d{1,6}$/.test(rawOffset)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_PAGINATION_INVALID" };
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_PAGINATION_INVALID" };
  }

  return {
    ok: true,
    value: {
      status,
      status_filter: status,
      limit,
      offset,
    },
  };
}

export function parseDecideAttendanceExplanationBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedDecideAttendanceExplanationRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_DECISION_INVALID" };
  }
  const allowedKeys = new Set([
    "decision",
    "expected_row_version",
    "decision_note",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_EXPLANATION_DECISION_INVALID" };
    }
  }

  const rawDecision =
    typeof body.decision === "string" ? body.decision.trim().toUpperCase() : "";
  if (!ATTENDANCE_EXPLANATION_DECISIONS.includes(rawDecision as AttendanceExplanationDecision)) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_DECISION_INVALID" };
  }

  const expectedRowVersion = body.expected_row_version;
  if (
    typeof expectedRowVersion !== "number" ||
    !Number.isSafeInteger(expectedRowVersion) ||
    expectedRowVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_DECISION_INVALID" };
  }

  const decisionNote =
    body.decision_note === undefined || body.decision_note === null
      ? ""
      : typeof body.decision_note === "string"
        ? body.decision_note.trim()
        : null;
  if (
    decisionNote === null ||
    decisionNote.length > 500 ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(decisionNote)
  ) {
    return { ok: false, code: "ATTENDANCE_EXPLANATION_NOTE_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      decision: rawDecision as AttendanceExplanationDecision,
      expected_row_version: expectedRowVersion,
      decision_note: decisionNote,
      idempotency_key: idempotencyKey,
    },
  };
}

function projectExplanationAccountSummary(
  value: unknown,
): AttendanceExplanationAccountSummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_user_id",
      "display_name",
      "login_id",
      "personnel_code",
      "recruiter_id",
      "account_enabled",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.app_user_id) ||
    (value.display_name !== null && typeof value.display_name !== "string") ||
    (value.login_id !== null && typeof value.login_id !== "string") ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    (value.recruiter_id !== null && !isUuidString(value.recruiter_id)) ||
    typeof value.account_enabled !== "boolean"
  ) {
    return null;
  }
  return {
    app_user_id: value.app_user_id.toLowerCase(),
    display_name: value.display_name,
    login_id: value.login_id,
    personnel_code: value.personnel_code,
    recruiter_id: value.recruiter_id === null ? null : value.recruiter_id.toLowerCase(),
    account_enabled: value.account_enabled,
  };
}

function projectExplanationAuditEvent(
  value: unknown,
): AttendanceExplanationAuditEventProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "audit_event_id",
      "action",
      "actor",
      "before_status",
      "after_status",
      "note",
      "created_at",
      "created_at_local",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.audit_event_id) ||
    (value.action !== "SUBMITTED" &&
      value.action !== "APPROVED" &&
      value.action !== "REJECTED") ||
    (value.before_status !== null &&
      !ATTENDANCE_EXPLANATION_STATUSES.includes(
        value.before_status as AttendanceExplanationStatus,
      )) ||
    !ATTENDANCE_EXPLANATION_STATUSES.includes(
      value.after_status as AttendanceExplanationStatus,
    ) ||
    typeof value.note !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.created_at_local !== "string"
  ) {
    return null;
  }
  const actor = projectExplanationAccountSummary(value.actor);
  if (!actor) return null;

  return {
    audit_event_id: value.audit_event_id.toLowerCase(),
    action: value.action,
    actor,
    before_status: value.before_status as AttendanceExplanationStatus | null,
    after_status: value.after_status as AttendanceExplanationStatus,
    note: value.note,
    created_at: value.created_at,
    created_at_local: value.created_at_local,
  };
}

export function projectAttendanceExplanationItem(
  value: unknown,
): AttendanceExplanationItemProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "explanation_id",
    "app_user_id",
    "requester",
    "business_date",
    "slot_code",
    "slot_index",
    "slot_label",
    "session_code",
    "target_time",
    "grace_before_minutes",
    "grace_after_minutes",
    "policy_version_used",
    "original_slot_status",
    "effective_slot_status",
    "related_checkins",
    "reason",
    "status",
    "unit_kind_snapshot",
    "route_kind",
    "primary_approver",
    "routed_team",
    "fallback_reason",
    "submitted_at",
    "submitted_at_local",
    "decided_at",
    "decided_at_local",
    "decided_by",
    "decision_note",
    "row_version",
    "updated_at",
    "audit_events",
  ] as const;
  const withCanDecideKeys = [...baseKeys, "can_decide"] as const;
  const profileBaseKeys = [
    ...baseKeys,
    "policy_profile_id_used",
    "policy_profile_code_used",
    "policy_profile_name_used",
  ] as const;
  const profileWithCanDecideKeys = [...profileBaseKeys, "can_decide"] as const;

  const hasProfileCanDecide = hasExactKeys(value, profileWithCanDecideKeys);
  const hasProfileBase =
    !hasProfileCanDecide && hasExactKeys(value, profileBaseKeys);
  const hasLegacyCanDecide =
    !hasProfileCanDecide &&
    !hasProfileBase &&
    hasExactKeys(value, withCanDecideKeys);
  const hasLegacyBase =
    !hasProfileCanDecide &&
    !hasProfileBase &&
    !hasLegacyCanDecide &&
    hasExactKeys(value, baseKeys);
  if (
    !hasProfileCanDecide &&
    !hasProfileBase &&
    !hasLegacyCanDecide &&
    !hasLegacyBase
  ) {
    return null;
  }
  const hasProfileKeys = hasProfileCanDecide || hasProfileBase;
  const hasCanDecide = hasProfileCanDecide || hasLegacyCanDecide;

  const slotCode = value.slot_code as AttendanceSlotCode;
  if (
    !isUuidString(value.explanation_id) ||
    !isUuidString(value.app_user_id) ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    !ATTENDANCE_SLOT_CODES.includes(slotCode) ||
    typeof value.slot_index !== "number" ||
    !Number.isSafeInteger(value.slot_index) ||
    value.slot_index < 1 ||
    value.slot_index > 12 ||
    value.slot_code !== ATTENDANCE_SLOT_CODES[value.slot_index - 1] ||
    typeof value.slot_label !== "string" ||
    value.slot_label.trim().length === 0 ||
    !ATTENDANCE_SLOT_SESSION_CODES.includes(
      value.session_code as AttendanceSlotSessionCode,
    ) ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    typeof value.policy_version_used !== "number" ||
    !Number.isSafeInteger(value.policy_version_used) ||
    value.policy_version_used < 1 ||
    !ATTENDANCE_EXPLANATION_ORIGINAL_SLOT_STATUSES.includes(
      value.original_slot_status as AttendanceExplanationOriginalSlotStatus,
    ) ||
    !ATTENDANCE_SLOT_STATUSES.includes(value.effective_slot_status as AttendanceSlotStatus) ||
    !Array.isArray(value.related_checkins) ||
    typeof value.reason !== "string" ||
    !ATTENDANCE_EXPLANATION_STATUSES.includes(value.status as AttendanceExplanationStatus) ||
    (value.unit_kind_snapshot !== null &&
      !ATTENDANCE_EXPLANATION_UNIT_KINDS.includes(
        value.unit_kind_snapshot as AttendanceExplanationUnitKind,
      )) ||
    !ATTENDANCE_EXPLANATION_ROUTE_KINDS.includes(
      value.route_kind as AttendanceExplanationRouteKind,
    ) ||
    (value.fallback_reason !== null &&
      !ATTENDANCE_EXPLANATION_FALLBACK_REASONS.includes(
        value.fallback_reason as AttendanceExplanationFallbackReason,
      )) ||
    typeof value.submitted_at !== "string" ||
    typeof value.submitted_at_local !== "string" ||
    (value.decided_at !== null && typeof value.decided_at !== "string") ||
    (value.decided_at_local !== null && typeof value.decided_at_local !== "string") ||
    typeof value.decision_note !== "string" ||
    typeof value.row_version !== "number" ||
    !Number.isSafeInteger(value.row_version) ||
    value.row_version < 1 ||
    typeof value.updated_at !== "string" ||
    !Array.isArray(value.audit_events) ||
    (hasCanDecide && typeof value.can_decide !== "boolean")
  ) {
    return null;
  }
  if (hasProfileKeys) {
    if (
      !isUuidString(value.policy_profile_id_used) ||
      typeof value.policy_profile_code_used !== "string" ||
      !SLOT_PROFILE_CODE_PATTERN.test(value.policy_profile_code_used) ||
      typeof value.policy_profile_name_used !== "string" ||
      value.policy_profile_name_used.trim().length === 0
    ) {
      return null;
    }
  }

  const requester = projectExplanationAccountSummary(value.requester);
  if (!requester) return null;

  let primaryApprover: AttendanceExplanationAccountSummaryProjection | null = null;
  if (value.primary_approver !== null) {
    primaryApprover = projectExplanationAccountSummary(value.primary_approver);
    if (!primaryApprover) return null;
  }

  let decidedBy: AttendanceExplanationAccountSummaryProjection | null = null;
  if (value.decided_by !== null) {
    decidedBy = projectExplanationAccountSummary(value.decided_by);
    if (!decidedBy) return null;
  }

  let routedTeam: {
    team_id: string;
    team_code: string | null;
    team_name: string | null;
  } | null = null;
  if (value.routed_team !== null) {
    if (
      !isRecord(value.routed_team) ||
      !hasExactKeys(value.routed_team, ["team_id", "team_code", "team_name"]) ||
      !isUuidString(value.routed_team.team_id) ||
      (value.routed_team.team_code !== null && typeof value.routed_team.team_code !== "string") ||
      (value.routed_team.team_name !== null && typeof value.routed_team.team_name !== "string")
    ) {
      return null;
    }
    routedTeam = {
      team_id: value.routed_team.team_id.toLowerCase(),
      team_code: value.routed_team.team_code,
      team_name: value.routed_team.team_name,
    };
  }

  const relatedCheckins: AttendanceSlotCheckinItemProjection[] = [];
  for (const rawCheckin of value.related_checkins) {
    const projectedCheckin = projectSlotCheckinItem(rawCheckin, slotCode);
    if (!projectedCheckin) return null;
    relatedCheckins.push(projectedCheckin);
  }

  const auditEvents: AttendanceExplanationAuditEventProjection[] = [];
  for (const rawEvent of value.audit_events) {
    const projectedEvent = projectExplanationAuditEvent(rawEvent);
    if (!projectedEvent) return null;
    auditEvents.push(projectedEvent);
  }

  return {
    explanation_id: value.explanation_id.toLowerCase(),
    app_user_id: value.app_user_id.toLowerCase(),
    requester,
    business_date: value.business_date,
    slot_code: slotCode,
    slot_index: value.slot_index,
    slot_label: value.slot_label.trim(),
    session_code: value.session_code as AttendanceSlotSessionCode,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
    ...(hasProfileKeys
      ? {
          policy_profile_id_used: (value.policy_profile_id_used as string).toLowerCase(),
          policy_profile_code_used: value.policy_profile_code_used as string,
          policy_profile_name_used: (value.policy_profile_name_used as string).trim(),
        }
      : {}),
    policy_version_used: value.policy_version_used,
    original_slot_status: value.original_slot_status as AttendanceExplanationOriginalSlotStatus,
    effective_slot_status: value.effective_slot_status as AttendanceSlotStatus,
    related_checkins: relatedCheckins,
    reason: value.reason,
    status: value.status as AttendanceExplanationStatus,
    unit_kind_snapshot: value.unit_kind_snapshot as AttendanceExplanationUnitKind | null,
    route_kind: value.route_kind as AttendanceExplanationRouteKind,
    primary_approver: primaryApprover,
    routed_team: routedTeam,
    fallback_reason: value.fallback_reason as AttendanceExplanationFallbackReason | null,
    submitted_at: value.submitted_at,
    submitted_at_local: value.submitted_at_local,
    decided_at: value.decided_at,
    decided_at_local: value.decided_at_local,
    decided_by: decidedBy,
    decision_note: value.decision_note,
    row_version: value.row_version,
    updated_at: value.updated_at,
    audit_events: auditEvents,
    ...(hasCanDecide ? { can_decide: value.can_decide as boolean } : {}),
  };
}

function projectExplanationDaySlotEvaluation(
  value: unknown,
  expectedIndex: number,
): AttendanceExplanationDaySlotEvaluationProjection | null {
  const expectedCode = ATTENDANCE_SLOT_CODES[expectedIndex - 1];
  if (
    !expectedCode ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "slot_code",
      "slot_index",
      "slot_label",
      "session_code",
      "target_time",
      "grace_before_minutes",
      "grace_after_minutes",
      "is_leave_covered",
      "original_slot_status",
      "slot_status",
      "eligible_for_explanation",
      "checkins",
      "explanation",
    ])
  ) {
    return null;
  }
  if (
    value.slot_code !== expectedCode ||
    value.slot_index !== expectedIndex ||
    typeof value.slot_label !== "string" ||
    value.slot_label.trim().length === 0 ||
    !ATTENDANCE_SLOT_SESSION_CODES.includes(
      value.session_code as AttendanceSlotSessionCode,
    ) ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    typeof value.is_leave_covered !== "boolean" ||
    !ATTENDANCE_SLOT_STATUSES.includes(value.original_slot_status as AttendanceSlotStatus) ||
    !ATTENDANCE_SLOT_STATUSES.includes(value.slot_status as AttendanceSlotStatus) ||
    typeof value.eligible_for_explanation !== "boolean" ||
    !Array.isArray(value.checkins)
  ) {
    return null;
  }

  const checkins: AttendanceSlotCheckinItemProjection[] = [];
  for (const rawCheckin of value.checkins) {
    const projectedCheckin = projectSlotCheckinItem(rawCheckin, expectedCode);
    if (!projectedCheckin) return null;
    checkins.push(projectedCheckin);
  }

  let explanation: AttendanceDaySlotExplanationSummaryProjection | null = null;
  if (value.explanation !== null) {
    explanation = projectDaySlotExplanationSummary(value.explanation);
    if (!explanation) return null;
  }

  return {
    slot_code: expectedCode,
    slot_index: expectedIndex,
    slot_label: value.slot_label.trim(),
    session_code: value.session_code as AttendanceSlotSessionCode,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
    is_leave_covered: value.is_leave_covered,
    original_slot_status: value.original_slot_status as AttendanceSlotStatus,
    slot_status: value.slot_status as AttendanceSlotStatus,
    eligible_for_explanation: value.eligible_for_explanation,
    checkins,
    explanation,
  };
}

export function projectAttendanceMyExplanationsOverview(
  rawValue: unknown,
): AttendanceMyExplanationsOverviewProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (
    !value ||
    !hasExactKeys(value, [
      "viewer",
      "routing",
      "today_local",
      "selected_date",
      "day_evaluation",
      "pagination",
      "items",
    ])
  ) {
    return null;
  }

  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, [
      "app_user_id",
      "can_submit_explanation",
      "can_approve_explanations",
      "is_shared_non_employee",
      "is_full_admin",
      "is_bod",
    ]) ||
    !isUuidString(value.viewer.app_user_id) ||
    typeof value.viewer.can_submit_explanation !== "boolean" ||
    typeof value.viewer.can_approve_explanations !== "boolean" ||
    typeof value.viewer.is_shared_non_employee !== "boolean" ||
    typeof value.viewer.is_full_admin !== "boolean" ||
    typeof value.viewer.is_bod !== "boolean"
  ) {
    return null;
  }

  if (
    !isRecord(value.routing) ||
    !hasExactKeys(value.routing, [
      "route_kind",
      "unit_kind",
      "primary_approver",
      "team_id",
      "team_code",
      "team_name",
      "fallback_reason",
      "profile_configured",
    ]) ||
    !ATTENDANCE_EXPLANATION_ROUTE_KINDS.includes(
      value.routing.route_kind as AttendanceExplanationRouteKind,
    ) ||
    (value.routing.unit_kind !== null &&
      !ATTENDANCE_EXPLANATION_UNIT_KINDS.includes(
        value.routing.unit_kind as AttendanceExplanationUnitKind,
      )) ||
    (value.routing.team_id !== null && !isUuidString(value.routing.team_id)) ||
    (value.routing.team_code !== null && typeof value.routing.team_code !== "string") ||
    (value.routing.team_name !== null && typeof value.routing.team_name !== "string") ||
    (value.routing.fallback_reason !== null &&
      !ATTENDANCE_EXPLANATION_FALLBACK_REASONS.includes(
        value.routing.fallback_reason as AttendanceExplanationFallbackReason,
      )) ||
    typeof value.routing.profile_configured !== "boolean"
  ) {
    return null;
  }

  let primaryApprover: AttendanceExplanationAccountSummaryProjection | null = null;
  if (value.routing.primary_approver !== null) {
    primaryApprover = projectExplanationAccountSummary(value.routing.primary_approver);
    if (!primaryApprover) return null;
  }

  if (
    typeof value.today_local !== "string" ||
    !isValidIsoCalendarDate(value.today_local) ||
    typeof value.selected_date !== "string" ||
    !isValidIsoCalendarDate(value.selected_date) ||
    !isRecord(value.day_evaluation)
  ) {
    return null;
  }
  const baseEvalKeys = ["business_date", "policy_version_used", "slots"] as const;
  const profileEvalKeys = [
    ...baseEvalKeys,
    "policy_profile_id_used",
    "policy_profile_code_used",
    "policy_profile_name_used",
    "policy_is_default_used",
  ] as const;
  const evalHasProfileKeys = hasExactKeys(value.day_evaluation, profileEvalKeys);
  const evalHasBaseKeys =
    !evalHasProfileKeys && hasExactKeys(value.day_evaluation, baseEvalKeys);
  if (
    (!evalHasProfileKeys && !evalHasBaseKeys) ||
    typeof value.day_evaluation.business_date !== "string" ||
    !isValidIsoCalendarDate(value.day_evaluation.business_date) ||
    typeof value.day_evaluation.policy_version_used !== "number" ||
    !Number.isSafeInteger(value.day_evaluation.policy_version_used) ||
    value.day_evaluation.policy_version_used < 1 ||
    !Array.isArray(value.day_evaluation.slots) ||
    value.day_evaluation.slots.length < ATTENDANCE_SLOT_MIN_COUNT ||
    value.day_evaluation.slots.length > ATTENDANCE_SLOT_MAX_COUNT
  ) {
    return null;
  }
  if (evalHasProfileKeys) {
    if (
      !isUuidString(value.day_evaluation.policy_profile_id_used) ||
      typeof value.day_evaluation.policy_profile_code_used !== "string" ||
      !SLOT_PROFILE_CODE_PATTERN.test(value.day_evaluation.policy_profile_code_used) ||
      typeof value.day_evaluation.policy_profile_name_used !== "string" ||
      value.day_evaluation.policy_profile_name_used.trim().length === 0 ||
      typeof value.day_evaluation.policy_is_default_used !== "boolean"
    ) {
      return null;
    }
  }

  const evalSlots: AttendanceExplanationDaySlotEvaluationProjection[] = [];
  for (let i = 0; i < value.day_evaluation.slots.length; i += 1) {
    const projectedSlot = projectExplanationDaySlotEvaluation(
      value.day_evaluation.slots[i],
      i + 1,
    );
    if (!projectedSlot) return null;
    evalSlots.push(projectedSlot);
  }

  if (
    !isRecord(value.pagination) ||
    !hasExactKeys(value.pagination, ["limit", "offset", "total_rows"]) ||
    typeof value.pagination.limit !== "number" ||
    !Number.isSafeInteger(value.pagination.limit) ||
    typeof value.pagination.offset !== "number" ||
    !Number.isSafeInteger(value.pagination.offset) ||
    typeof value.pagination.total_rows !== "number" ||
    !Number.isSafeInteger(value.pagination.total_rows) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }

  const items: AttendanceExplanationItemProjection[] = [];
  for (const rawItem of value.items) {
    const projectedItem = projectAttendanceExplanationItem(rawItem);
    if (!projectedItem) return null;
    items.push(projectedItem);
  }

  return {
    viewer: {
      app_user_id: value.viewer.app_user_id.toLowerCase(),
      can_submit_explanation: value.viewer.can_submit_explanation,
      can_approve_explanations: value.viewer.can_approve_explanations,
      is_shared_non_employee: value.viewer.is_shared_non_employee,
      is_full_admin: value.viewer.is_full_admin,
      is_bod: value.viewer.is_bod,
    },
    routing: {
      route_kind: value.routing.route_kind as AttendanceExplanationRouteKind,
      unit_kind: value.routing.unit_kind as AttendanceExplanationUnitKind | null,
      primary_approver: primaryApprover,
      team_id:
        value.routing.team_id === null ? null : value.routing.team_id.toLowerCase(),
      team_code: value.routing.team_code,
      team_name: value.routing.team_name,
      fallback_reason:
        value.routing.fallback_reason as AttendanceExplanationFallbackReason | null,
      profile_configured: value.routing.profile_configured,
    },
    today_local: value.today_local,
    selected_date: value.selected_date,
    day_evaluation: {
      business_date: value.day_evaluation.business_date,
      ...(evalHasProfileKeys
        ? {
            policy_profile_id_used: (
              value.day_evaluation.policy_profile_id_used as string
            ).toLowerCase(),
            policy_profile_code_used: value.day_evaluation
              .policy_profile_code_used as string,
            policy_profile_name_used: (
              value.day_evaluation.policy_profile_name_used as string
            ).trim(),
            policy_is_default_used: value.day_evaluation
              .policy_is_default_used as boolean,
          }
        : {}),
      policy_version_used: value.day_evaluation.policy_version_used,
      slots: evalSlots,
    },
    pagination: {
      limit: value.pagination.limit,
      offset: value.pagination.offset,
      total_rows: value.pagination.total_rows,
    },
    items,
  };
}

export function projectSubmitAttendanceExplanationResult(
  rawValue: unknown,
): SubmitAttendanceExplanationResultProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (
    !value ||
    !hasExactKeys(value, ["replayed", "explanation"]) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  const explanation = projectAttendanceExplanationItem(value.explanation);
  if (!explanation) return null;

  return {
    replayed: value.replayed,
    explanation,
  };
}

export function projectAttendanceExplanationApprovalInbox(
  rawValue: unknown,
): AttendanceExplanationApprovalInboxProjection | null {
  const value = unwrapOptionalOkEnvelope(rawValue);
  if (
    !value ||
    !hasExactKeys(value, ["viewer", "pagination", "items"])
  ) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, [
      "app_user_id",
      "can_approve_explanations",
      "is_full_admin",
      "is_bod",
    ]) ||
    !isUuidString(value.viewer.app_user_id) ||
    typeof value.viewer.can_approve_explanations !== "boolean" ||
    typeof value.viewer.is_full_admin !== "boolean" ||
    typeof value.viewer.is_bod !== "boolean" ||
    !isRecord(value.pagination) ||
    !hasExactKeys(value.pagination, ["limit", "offset", "total_rows", "pending_count"]) ||
    typeof value.pagination.limit !== "number" ||
    !Number.isSafeInteger(value.pagination.limit) ||
    typeof value.pagination.offset !== "number" ||
    !Number.isSafeInteger(value.pagination.offset) ||
    typeof value.pagination.total_rows !== "number" ||
    !Number.isSafeInteger(value.pagination.total_rows) ||
    typeof value.pagination.pending_count !== "number" ||
    !Number.isSafeInteger(value.pagination.pending_count) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }

  const items: (AttendanceExplanationItemProjection & { can_decide: boolean })[] = [];
  for (const rawItem of value.items) {
    const projectedItem = projectAttendanceExplanationItem(rawItem);
    if (!projectedItem || typeof projectedItem.can_decide !== "boolean") {
      return null;
    }
    items.push(projectedItem as AttendanceExplanationItemProjection & { can_decide: boolean });
  }

  return {
    viewer: {
      app_user_id: value.viewer.app_user_id.toLowerCase(),
      can_approve_explanations: value.viewer.can_approve_explanations,
      is_full_admin: value.viewer.is_full_admin,
      is_bod: value.viewer.is_bod,
    },
    pagination: {
      limit: value.pagination.limit,
      offset: value.pagination.offset,
      total_rows: value.pagination.total_rows,
      pending_count: value.pagination.pending_count,
    },
    items,
  };
}

export function projectDecideAttendanceExplanationResult(
  value: unknown,
): DecideAttendanceExplanationResultProjection | null {
  return projectSubmitAttendanceExplanationResult(value);
}

export const projectMyAttendanceExplanationsOverview =
  projectAttendanceMyExplanationsOverview;
