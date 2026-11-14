import { createHash } from "node:crypto";

export const LEAVE_SESSION_CODES = ["FULL", "AM", "PM"] as const;
export type LeaveSessionCode = (typeof LEAVE_SESSION_CODES)[number];

export const LEAVE_TYPES = [
  "ANNUAL",
  "BEREAVEMENT",
  "MARRIAGE",
  "SICK",
  "UNPAID",
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const LEAVE_TYPE_MAX_UNITS_PER_REQUEST: Record<LeaveType, number | null> = {
  ANNUAL: null,
  BEREAVEMENT: 6, // max 3 days (6 half-day units)
  MARRIAGE: 6, // max 3 days (6 half-day units)
  SICK: 14, // max 7 days (14 half-day units)
  UNPAID: 14, // max 7 days (14 half-day units)
};

export const LEAVE_UNIT_KINDS = [
  "UNCLASSIFIED",
  "RECRUITMENT",
  "MARKETING",
  "IT",
  "ACCOUNTING",
  "MANAGEMENT_BOD",
] as const;
export type LeaveUnitKind = (typeof LEAVE_UNIT_KINDS)[number];

export const LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS = [
  "MARKETING",
  "IT",
  "ACCOUNTING",
] as const;
export type LeaveDepartmentApproverUnitKind =
  (typeof LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS)[number];

export const LEAVE_EMPLOYMENT_STATUSES = [
  "UNCONFIGURED",
  "PROBATION",
  "OFFICIAL",
] as const;
export type LeaveEmploymentStatus = (typeof LEAVE_EMPLOYMENT_STATUSES)[number];

export const LEAVE_REQUEST_STATUS_FILTERS = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "WITHDRAWN",
  "ALL",
] as const;
export type LeaveRequestStatusFilter =
  (typeof LEAVE_REQUEST_STATUS_FILTERS)[number];
export type LeaveAdminAccountStatusFilter = "ACTIVE" | "INACTIVE" | "ALL";

export const LEAVE_DECISION_CODES = [
  "APPROVE",
  "REJECT",
  "CANCEL_APPROVED",
] as const;
export type LeaveDecisionCode = (typeof LEAVE_DECISION_CODES)[number];

export const LEAVE_MODULE_GRANT_ROLES = [
  "HR_REPORT_VIEWER",
  "HR_LEAVE_OPERATOR",
  "LEAVE_ADMIN_BOD_APPROVER",
] as const;
export type LeaveModuleGrantRole = (typeof LEAVE_MODULE_GRANT_ROLES)[number];

export const LEAVE_MODULE_GRANT_ACTIONS = ["GRANT", "REVOKE"] as const;
export type LeaveModuleGrantAction = (typeof LEAVE_MODULE_GRANT_ACTIONS)[number];

export type LeaveErrorCode =
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "CSRF_ORIGIN_MISMATCH"
  | "DISALLOWED_AUTHORITY_HEADER"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_QUERY"
  | "INVALID_REQUEST"
  | "LEAVE_SHARED_ACCOUNT_FORBIDDEN"
  | "LEAVE_IDEMPOTENCY_KEY_INVALID"
  | "LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH"
  | "LEAVE_REASON_INVALID"
  | "LEAVE_REASON_REQUIRED"
  | "LEAVE_REQUEST_DAYS_INVALID"
  | "LEAVE_TYPE_INVALID"
  | "LEAVE_TYPE_LIMIT_EXCEEDED"
  | "LEAVE_TYPE_ALLOCATION_MISMATCH"
  | "LEAVE_REQUEST_YEAR_OUT_OF_RANGE"
  | "LEAVE_REQUEST_DUPLICATE_DATE"
  | "LEAVE_REQUEST_OVERLAP"
  | "LEAVE_INSUFFICIENT_BALANCE"
  | "LEAVE_REQUEST_NOT_FOUND"
  | "LEAVE_REQUEST_OWNERSHIP_FORBIDDEN"
  | "LEAVE_ROW_VERSION_CONFLICT"
  | "LEAVE_INVALID_STATE_TRANSITION"
  | "LEAVE_APPROVAL_FORBIDDEN"
  | "LEAVE_SELF_APPROVAL_FORBIDDEN"
  | "LEAVE_DECISION_INVALID"
  | "LEAVE_FILTER_INVALID"
  | "LEAVE_ADMIN_FORBIDDEN"
  | "LEAVE_POLICY_ADMIN_FORBIDDEN"
  | "LEAVE_POLICY_EXPIRY_INVALID"
  | "LEAVE_TARGET_USER_NOT_FOUND"
  | "LEAVE_PROFILE_INVALID"
  | "LEAVE_PROFILE_WORK_START_DATE_REQUIRED"
  | "LEAVE_PROFILE_OFFICIAL_DATE_INVALID"
  | "LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"
  | "LEAVE_SENIORITY_CONFIG_FORBIDDEN"
  | "LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN"
  | "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN"
  | "LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN"
  | "LEAVE_UNIT_KIND_INVALID"
  | "LEAVE_APPROVER_USER_NOT_FOUND"
  | "LEAVE_MODULE_GRANT_ADMIN_FORBIDDEN"
  | "LEAVE_MODULE_GRANT_INVALID"
  | "LEAVE_MODULE_GRANT_NOT_FOUND"
  | "LEAVE_YEAR_INVALID"
  | "LEAVE_OPENING_ROWS_INVALID"
  | "LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED"
  | "LEAVE_OPENING_BATCH_VALIDATION_FAILED"
  | "LEAVE_OPENING_PREVIEW_STALE"
  | "LEAVE_REPORT_FORBIDDEN"
  | "LEAVE_REPORT_YEAR_MONTH_INVALID"
  | "LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED"
  | "LEAVE_REPORT_EXPORT_INCOMPLETE"
  | "LEAVE_UNAVAILABLE";

export const LEAVE_REPORT_EXPORT_PAGE_SIZE = 500;
export const MAX_LEAVE_REPORT_EXPORT_ROWS = 5000;

export function leaveHttpStatusForError(code: LeaveErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
    case "LEAVE_REQUEST_NOT_FOUND":
    case "LEAVE_TARGET_USER_NOT_FOUND":
    case "LEAVE_APPROVER_USER_NOT_FOUND":
    case "LEAVE_MODULE_GRANT_NOT_FOUND":
      return 404;
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_MISMATCH":
    case "LEAVE_SHARED_ACCOUNT_FORBIDDEN":
    case "LEAVE_REQUEST_OWNERSHIP_FORBIDDEN":
    case "LEAVE_APPROVAL_FORBIDDEN":
    case "LEAVE_SELF_APPROVAL_FORBIDDEN":
    case "LEAVE_ADMIN_FORBIDDEN":
    case "LEAVE_POLICY_ADMIN_FORBIDDEN":
    case "LEAVE_SENIORITY_CONFIG_FORBIDDEN":
    case "LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN":
    case "LEAVE_MODULE_GRANT_ADMIN_FORBIDDEN":
    case "LEAVE_REPORT_FORBIDDEN":
      return 403;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "LEAVE_REQUEST_OVERLAP":
    case "LEAVE_ROW_VERSION_CONFLICT":
    case "LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH":
    case "LEAVE_INVALID_STATE_TRANSITION":
    case "LEAVE_OPENING_PREVIEW_STALE":
    case "LEAVE_REPORT_EXPORT_INCOMPLETE":
      return 409;
    case "LEAVE_INSUFFICIENT_BALANCE":
    case "LEAVE_TYPE_LIMIT_EXCEEDED":
    case "LEAVE_TYPE_ALLOCATION_MISMATCH":
    case "LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED":
    case "LEAVE_OPENING_BATCH_VALIDATION_FAILED":
    case "LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED":
    case "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN":
    case "LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN":
      return 422;
    case "LEAVE_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function normalizeReason(
  value: unknown,
  required: boolean,
): { ok: true; reason: string | null } | { ok: false; code: LeaveErrorCode } {
  if (value === undefined || value === null) {
    return required
      ? { ok: false, code: "LEAVE_REASON_REQUIRED" }
      : { ok: true, reason: null };
  }
  if (typeof value !== "string") {
    return { ok: false, code: "LEAVE_REASON_INVALID" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return required
      ? { ok: false, code: "LEAVE_REASON_REQUIRED" }
      : { ok: true, reason: null };
  }
  if (trimmed.length > 2000 || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, code: "LEAVE_REASON_INVALID" };
  }
  return { ok: true, reason: trimmed };
}

function normalizeIdempotencyKey(
  value: unknown,
): { ok: true; key: string } | { ok: false; code: LeaveErrorCode } {
  if (typeof value !== "string") {
    return { ok: false, code: "LEAVE_IDEMPOTENCY_KEY_INVALID" };
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 200 ||
    CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return { ok: false, code: "LEAVE_IDEMPOTENCY_KEY_INVALID" };
  }
  return { ok: true, key: trimmed };
}

function sha256Hex(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

export type LeaveDayInput = {
  leave_date: string;
  session_code: LeaveSessionCode;
  leave_type: LeaveType;
};

export type LeaveTypeAllocationInput = {
  leave_type: LeaveType;
  half_day_units: number;
};

export type CreateLeaveRequestInput = {
  days: readonly LeaveDayInput[];
  type_allocations?: readonly LeaveTypeAllocationInput[];
  reason: string | null;
  idempotency_key: string;
  request_fingerprint: string;
};

export type WithdrawLeaveRequestInput = {
  expected_row_version: number;
  reason: string | null;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DecideLeaveRequestInput = {
  decision: LeaveDecisionCode;
  expected_row_version: number;
  reason: string | null;
  idempotency_key: string;
  request_fingerprint: string;
};

export type PatchAdminConfigInput =
  | {
      operation: "UPDATE_POLICY";
      carry_over_expiry_month: number;
      carry_over_expiry_day: number;
      expected_row_version: number;
      reason: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    }
  | {
      operation: "UPSERT_EMPLOYEE_PROFILE";
      target_app_user_id: string;
      is_shared_non_employee: boolean;
      employment_status: LeaveEmploymentStatus;
      unit_kind: LeaveUnitKind;
      work_start_date: string | null;
      official_effective_date: string | null;
      next_seniority_effective_date: string | null;
      next_seniority_units: number;
      expected_row_version: number;
      reason: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    }
  | {
      operation: "SET_DEPARTMENT_APPROVER";
      unit_kind: LeaveDepartmentApproverUnitKind;
      approver_app_user_id: string | null;
      valid_from: string | null;
      expected_row_version: number;
      reason: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    }
  | {
      operation: "MANAGE_MODULE_GRANT";
      action: LeaveModuleGrantAction;
      target_app_user_id: string;
      role_code: LeaveModuleGrantRole;
      expected_row_version: number;
      reason: string | null;
      idempotency_key: string;
      request_fingerprint: string;
    };

export type OpeningBatchRowInput = {
  app_user_id: string;
  carry_over_units: number;
  opening_current_year_units: number;
  seniority_units: number;
  note: string | null;
  expected_as_of_date?: string | null;
  expected_current_year_granted_units?: number | null;
  expected_current_year_locked_units?: number | null;
  expected_profile_row_version?: number | null;
};

export type PreviewOpeningBatchInput = {
  leave_year: number;
  rows: readonly OpeningBatchRowInput[];
};

export type ApplyOpeningBatchInput = {
  leave_year: number;
  rows: readonly OpeningBatchRowInput[];
  reason: string | null;
  idempotency_key: string;
  request_fingerprint: string;
};

export function parseMyLeaveSummaryQuery(
  url: URL,
): { ok: true; leave_year: number | null } | { ok: false; code: LeaveErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (key !== "year") {
      return { ok: false, code: "INVALID_QUERY" };
    }
  }
  const rawYear = url.searchParams.get("year");
  if (rawYear === null || rawYear.trim() === "") {
    return { ok: true, leave_year: null };
  }
  if (!/^\d{4}$/.test(rawYear.trim())) {
    return { ok: false, code: "LEAVE_YEAR_INVALID" };
  }
  const year = Number(rawYear.trim());
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return { ok: false, code: "LEAVE_YEAR_INVALID" };
  }
  return { ok: true, leave_year: year };
}

function sessionOrder(sessionCode: LeaveSessionCode): number {
  if (sessionCode === "FULL") return 1;
  if (sessionCode === "AM") return 2;
  return 3;
}

export function parseCreateLeaveRequestBody(
  body: unknown,
): { ok: true; data: CreateLeaveRequestInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const idem = normalizeIdempotencyKey(body.idempotency_key);
  if (!idem.ok) return idem;

  const reason = normalizeReason(body.reason, false);
  if (!reason.ok) return reason;

  if (
    !Array.isArray(body.days) ||
    body.days.length < 1 ||
    body.days.length > 120
  ) {
    return { ok: false, code: "LEAVE_REQUEST_DAYS_INVALID" };
  }

  type RawParsedDay = {
    leave_date: string;
    session_code: LeaveSessionCode;
    half_day_units: number;
    explicit_leave_type: LeaveType | null;
  };

  const seenByDate = new Map<string, RawParsedDay[]>();
  const rawParsedDays: RawParsedDay[] = [];
  let totalDayUnits = 0;
  let hasExplicitDayTypes = false;
  let allDaysHaveExplicitTypes = true;

  for (const rawDay of body.days) {
    if (!isPlainObject(rawDay)) {
      return { ok: false, code: "LEAVE_REQUEST_DAYS_INVALID" };
    }
    const leaveDate =
      typeof rawDay.leave_date === "string" ? rawDay.leave_date.trim() : "";
    const sessionCode =
      typeof rawDay.session_code === "string"
        ? rawDay.session_code.trim().toUpperCase()
        : "";
    if (
      !isValidIsoDate(leaveDate) ||
      !LEAVE_SESSION_CODES.includes(sessionCode as LeaveSessionCode)
    ) {
      return { ok: false, code: "LEAVE_REQUEST_DAYS_INVALID" };
    }

    const halfDayUnits = sessionCode === "FULL" ? 2 : 1;
    if (rawDay.half_day_units !== undefined && rawDay.half_day_units !== null) {
      if (
        typeof rawDay.half_day_units !== "number" ||
        !Number.isInteger(rawDay.half_day_units) ||
        rawDay.half_day_units !== halfDayUnits
      ) {
        return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
      }
    }

    let explicitLeaveType: LeaveType | null = null;
    if (
      rawDay.leave_type !== undefined &&
      rawDay.leave_type !== null &&
      String(rawDay.leave_type).trim() !== ""
    ) {
      const candidateType =
        typeof rawDay.leave_type === "string"
          ? rawDay.leave_type.trim().toUpperCase()
          : "";
      if (!LEAVE_TYPES.includes(candidateType as LeaveType)) {
        return { ok: false, code: "LEAVE_TYPE_INVALID" };
      }
      explicitLeaveType = candidateType as LeaveType;
      hasExplicitDayTypes = true;
    } else {
      allDaysHaveExplicitTypes = false;
    }

    const existingForDate = seenByDate.get(leaveDate) ?? [];
    for (const prev of existingForDate) {
      if (
        prev.session_code === "FULL" ||
        sessionCode === "FULL" ||
        prev.session_code === sessionCode ||
        (prev.explicit_leave_type ?? "ANNUAL") ===
          (explicitLeaveType ?? "ANNUAL")
      ) {
        return { ok: false, code: "LEAVE_REQUEST_DUPLICATE_DATE" };
      }
    }

    const parsedItem: RawParsedDay = {
      leave_date: leaveDate,
      session_code: sessionCode as LeaveSessionCode,
      half_day_units: halfDayUnits,
      explicit_leave_type: explicitLeaveType,
    };
    existingForDate.push(parsedItem);
    seenByDate.set(leaveDate, existingForDate);
    rawParsedDays.push(parsedItem);
    totalDayUnits += halfDayUnits;
  }

  rawParsedDays.sort((a, b) => {
    const cmp = a.leave_date.localeCompare(b.leave_date);
    if (cmp !== 0) return cmp;
    return sessionOrder(a.session_code) - sessionOrder(b.session_code);
  });

  const rawAllocs =
    body.type_allocations !== undefined
      ? body.type_allocations
      : body.allocations;

  let normalizedAllocations: LeaveTypeAllocationInput[] | undefined;
  const normalizedDays: LeaveDayInput[] = [];

  if (rawAllocs !== undefined && rawAllocs !== null) {
    if (
      !Array.isArray(rawAllocs) ||
      rawAllocs.length < 1 ||
      rawAllocs.length > 20
    ) {
      return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
    }

    normalizedAllocations = [];
    let totalAllocUnits = 0;

    for (const rawAlloc of rawAllocs) {
      if (!isPlainObject(rawAlloc)) {
        return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
      }
      const allocType =
        typeof rawAlloc.leave_type === "string"
          ? rawAlloc.leave_type.trim().toUpperCase()
          : "";
      if (!LEAVE_TYPES.includes(allocType as LeaveType)) {
        return { ok: false, code: "LEAVE_TYPE_INVALID" };
      }

      let allocUnits: number | null = null;
      if (
        rawAlloc.half_day_units !== undefined &&
        rawAlloc.half_day_units !== null
      ) {
        if (
          typeof rawAlloc.half_day_units !== "number" ||
          !Number.isInteger(rawAlloc.half_day_units) ||
          rawAlloc.half_day_units < 1
        ) {
          return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
        }
        allocUnits = rawAlloc.half_day_units;
      }

      if (rawAlloc.days !== undefined && rawAlloc.days !== null) {
        if (
          typeof rawAlloc.days !== "number" ||
          !Number.isFinite(rawAlloc.days) ||
          rawAlloc.days <= 0 ||
          !Number.isInteger(rawAlloc.days * 2)
        ) {
          return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
        }
        const fromDays = Math.round(rawAlloc.days * 2);
        if (allocUnits !== null && allocUnits !== fromDays) {
          return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
        }
        allocUnits = fromDays;
      }

      if (allocUnits === null || allocUnits < 1) {
        return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
      }

      normalizedAllocations.push({
        leave_type: allocType as LeaveType,
        half_day_units: allocUnits,
      });
      totalAllocUnits += allocUnits;
    }

    if (totalAllocUnits !== totalDayUnits) {
      return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
    }

    if (hasExplicitDayTypes) {
      if (!allDaysHaveExplicitTypes) {
        return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
      }
      const dayTypeSums = new Map<LeaveType, number>();
      for (const d of rawParsedDays) {
        const t = d.explicit_leave_type as LeaveType;
        dayTypeSums.set(t, (dayTypeSums.get(t) ?? 0) + d.half_day_units);
      }
      const allocTypeSums = new Map<LeaveType, number>();
      for (const a of normalizedAllocations) {
        allocTypeSums.set(
          a.leave_type,
          (allocTypeSums.get(a.leave_type) ?? 0) + a.half_day_units,
        );
      }
      for (const t of LEAVE_TYPES) {
        if ((dayTypeSums.get(t) ?? 0) !== (allocTypeSums.get(t) ?? 0)) {
          return { ok: false, code: "LEAVE_TYPE_ALLOCATION_MISMATCH" };
        }
      }
      for (const d of rawParsedDays) {
        normalizedDays.push({
          leave_date: d.leave_date,
          session_code: d.session_code,
          leave_type: d.explicit_leave_type as LeaveType,
        });
      }
    } else {
      const slotTypes: LeaveType[] = [];
      for (const alloc of normalizedAllocations) {
        for (let i = 0; i < alloc.half_day_units; i += 1) {
          slotTypes.push(alloc.leave_type);
        }
      }

      let cursor = 0;
      for (const d of rawParsedDays) {
        if (d.session_code === "FULL") {
          const amType = slotTypes[cursor];
          const pmType = slotTypes[cursor + 1];
          cursor += 2;
          if (amType === pmType) {
            normalizedDays.push({
              leave_date: d.leave_date,
              session_code: "FULL",
              leave_type: amType,
            });
          } else {
            normalizedDays.push({
              leave_date: d.leave_date,
              session_code: "AM",
              leave_type: amType,
            });
            normalizedDays.push({
              leave_date: d.leave_date,
              session_code: "PM",
              leave_type: pmType,
            });
          }
        } else {
          const slotType = slotTypes[cursor];
          cursor += 1;
          normalizedDays.push({
            leave_date: d.leave_date,
            session_code: d.session_code,
            leave_type: slotType,
          });
        }
      }
    }
  } else {
    for (const d of rawParsedDays) {
      normalizedDays.push({
        leave_date: d.leave_date,
        session_code: d.session_code,
        leave_type: d.explicit_leave_type ?? "ANNUAL",
      });
    }
  }

  normalizedDays.sort((a, b) => {
    const cmp = a.leave_date.localeCompare(b.leave_date);
    if (cmp !== 0) return cmp;
    return sessionOrder(a.session_code) - sessionOrder(b.session_code);
  });

  const unitsByType = new Map<LeaveType, number>();
  for (const day of normalizedDays) {
    const units = day.session_code === "FULL" ? 2 : 1;
    unitsByType.set(
      day.leave_type,
      (unitsByType.get(day.leave_type) ?? 0) + units,
    );
  }

  for (const [leaveType, totalUnits] of unitsByType.entries()) {
    const maxUnits = LEAVE_TYPE_MAX_UNITS_PER_REQUEST[leaveType];
    if (maxUnits !== null && totalUnits > maxUnits) {
      return { ok: false, code: "LEAVE_TYPE_LIMIT_EXCEEDED" };
    }
  }

  const request_fingerprint = sha256Hex({
    op: "CREATE_REQUEST",
    days: normalizedDays,
    reason: reason.reason,
  });

  return {
    ok: true,
    data: {
      days: normalizedDays,
      ...(normalizedAllocations
        ? { type_allocations: normalizedAllocations }
        : {}),
      reason: reason.reason,
      idempotency_key: idem.key,
      request_fingerprint,
    },
  };
}

export function parseWithdrawLeaveRequestBody(
  requestId: string,
  body: unknown,
): { ok: true; data: WithdrawLeaveRequestInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const idem = normalizeIdempotencyKey(body.idempotency_key);
  if (!idem.ok) return idem;

  const expectedRowVersion = Number(body.expected_row_version);
  if (!Number.isInteger(expectedRowVersion) || expectedRowVersion < 1) {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const reason = normalizeReason(body.reason, false);
  if (!reason.ok) return reason;

  const request_fingerprint = sha256Hex({
    op: "WITHDRAW_REQUEST",
    request_id: requestId.toLowerCase(),
    expected_row_version: expectedRowVersion,
    reason: reason.reason,
  });

  return {
    ok: true,
    data: {
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
      idempotency_key: idem.key,
      request_fingerprint,
    },
  };
}

export function parseListApprovalInboxQuery(
  url: URL,
):
  | {
      ok: true;
      status_filter: LeaveRequestStatusFilter;
      limit: number;
      offset: number;
    }
  | { ok: false; code: LeaveErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (key !== "status" && key !== "limit" && key !== "offset") {
      return { ok: false, code: "INVALID_QUERY" };
    }
  }
  const rawStatus = (url.searchParams.get("status") ?? "PENDING")
    .trim()
    .toUpperCase();
  if (
    !LEAVE_REQUEST_STATUS_FILTERS.includes(rawStatus as LeaveRequestStatusFilter)
  ) {
    return { ok: false, code: "LEAVE_FILTER_INVALID" };
  }
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit ? Number(rawLimit) : 50;
  const offset = rawOffset ? Number(rawOffset) : 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  return {
    ok: true,
    status_filter: rawStatus as LeaveRequestStatusFilter,
    limit,
    offset,
  };
}

export function parseDecideLeaveRequestBody(
  requestId: string,
  body: unknown,
): { ok: true; data: DecideLeaveRequestInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const idem = normalizeIdempotencyKey(body.idempotency_key);
  if (!idem.ok) return idem;

  const rawDecision =
    typeof body.decision === "string" ? body.decision.trim().toUpperCase() : "";
  if (!LEAVE_DECISION_CODES.includes(rawDecision as LeaveDecisionCode)) {
    return { ok: false, code: "LEAVE_DECISION_INVALID" };
  }
  const decision = rawDecision as LeaveDecisionCode;

  const expectedRowVersion = Number(body.expected_row_version);
  if (!Number.isInteger(expectedRowVersion) || expectedRowVersion < 1) {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const reason = normalizeReason(body.reason, false);
  if (!reason.ok) return reason;

  const request_fingerprint = sha256Hex({
    op: "DECIDE_REQUEST",
    request_id: requestId.toLowerCase(),
    decision,
    expected_row_version: expectedRowVersion,
    reason: reason.reason,
  });

  return {
    ok: true,
    data: {
      decision,
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
      idempotency_key: idem.key,
      request_fingerprint,
    },
  };
}

export function parseGetAdminOverviewQuery(
  url: URL,
):
  | {
      ok: true;
      search: string | null;
      limit: number;
      offset: number;
      account_status: LeaveAdminAccountStatusFilter;
    }
  | { ok: false; code: LeaveErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (key !== "search" && key !== "limit" && key !== "offset" && key !== "account_status") {
      return { ok: false, code: "INVALID_QUERY" };
    }
  }
  const rawSearch = url.searchParams.get("search");
  const search =
    rawSearch !== null && rawSearch.trim().length > 0
      ? rawSearch.trim().slice(0, 120)
      : null;
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const accountStatus = url.searchParams.get("account_status") ?? "ACTIVE";
  const limit = rawLimit ? Number(rawLimit) : 100;
  const offset = rawOffset ? Number(rawOffset) : 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 300 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  if (accountStatus !== "ACTIVE" && accountStatus !== "INACTIVE" && accountStatus !== "ALL") {
    return { ok: false, code: "INVALID_QUERY" };
  }
  return { ok: true, search, limit, offset, account_status: accountStatus };
}

export function parsePatchAdminConfigBody(
  body: unknown,
  todayVn?: string | null,
): { ok: true; data: PatchAdminConfigInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const idem = normalizeIdempotencyKey(body.idempotency_key);
  if (!idem.ok) return idem;

  const reason = normalizeReason(body.reason, false);
  if (!reason.ok) return reason;

  const expectedRowVersion = Number(body.expected_row_version ?? 0);
  if (!Number.isInteger(expectedRowVersion) || expectedRowVersion < 0) {
    return { ok: false, code: "INVALID_REQUEST" };
  }

  const operation =
    typeof body.operation === "string"
      ? body.operation.trim().toUpperCase()
      : "";

  if (operation === "UPDATE_POLICY") {
    const month = Number(body.carry_over_expiry_month);
    const day = Number(body.carry_over_expiry_day);
    if (
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > 31
    ) {
      return { ok: false, code: "LEAVE_POLICY_EXPIRY_INVALID" };
    }
    const request_fingerprint = sha256Hex({
      op: "UPDATE_POLICY",
      carry_over_expiry_month: month,
      carry_over_expiry_day: day,
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
    });
    return {
      ok: true,
      data: {
        operation: "UPDATE_POLICY",
        carry_over_expiry_month: month,
        carry_over_expiry_day: day,
        expected_row_version: expectedRowVersion,
        reason: reason.reason,
        idempotency_key: idem.key,
        request_fingerprint,
      },
    };
  }

  if (operation === "UPSERT_EMPLOYEE_PROFILE") {
    if (!isValidUuid(body.target_app_user_id)) {
      return { ok: false, code: "LEAVE_PROFILE_INVALID" };
    }
    const targetAppUserId = body.target_app_user_id.trim().toLowerCase();
    const isShared = Boolean(body.is_shared_non_employee);
    const empStatus =
      typeof body.employment_status === "string"
        ? body.employment_status.trim().toUpperCase()
        : "UNCONFIGURED";
    const unitKind =
      typeof body.unit_kind === "string"
        ? body.unit_kind.trim().toUpperCase()
        : "UNCLASSIFIED";
    if (
      !LEAVE_EMPLOYMENT_STATUSES.includes(empStatus as LeaveEmploymentStatus) ||
      !LEAVE_UNIT_KINDS.includes(unitKind as LeaveUnitKind)
    ) {
      return { ok: false, code: "LEAVE_PROFILE_INVALID" };
    }

    const workStartDate =
      body.work_start_date === null || body.work_start_date === undefined
        ? null
        : isValidIsoDate(body.work_start_date)
          ? body.work_start_date.trim()
          : undefined;
    const officialEffectiveDate =
      body.official_effective_date === null ||
      body.official_effective_date === undefined
        ? null
        : isValidIsoDate(body.official_effective_date)
          ? body.official_effective_date.trim()
          : undefined;
    const nextSeniorityDate =
      body.next_seniority_effective_date === null ||
      body.next_seniority_effective_date === undefined
        ? null
        : isValidIsoDate(body.next_seniority_effective_date)
          ? body.next_seniority_effective_date.trim()
          : undefined;

    if (
      workStartDate === undefined ||
      officialEffectiveDate === undefined ||
      nextSeniorityDate === undefined
    ) {
      return { ok: false, code: "LEAVE_PROFILE_INVALID" };
    }

    const nextSeniorityUnits = Number(body.next_seniority_units ?? 0);
    if (
      !Number.isInteger(nextSeniorityUnits) ||
      nextSeniorityUnits < 0 ||
      nextSeniorityUnits > 60
    ) {
      return { ok: false, code: "LEAVE_PROFILE_INVALID" };
    }

    const request_fingerprint = sha256Hex({
      op: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: targetAppUserId,
      is_shared_non_employee: isShared,
      employment_status: empStatus,
      unit_kind: unitKind,
      work_start_date: workStartDate,
      official_effective_date: officialEffectiveDate,
      next_seniority_effective_date: nextSeniorityDate,
      next_seniority_units: nextSeniorityUnits,
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
    });

    return {
      ok: true,
      data: {
        operation: "UPSERT_EMPLOYEE_PROFILE",
        target_app_user_id: targetAppUserId,
        is_shared_non_employee: isShared,
        employment_status: empStatus as LeaveEmploymentStatus,
        unit_kind: unitKind as LeaveUnitKind,
        work_start_date: workStartDate,
        official_effective_date: officialEffectiveDate,
        next_seniority_effective_date: nextSeniorityDate,
        next_seniority_units: nextSeniorityUnits,
        expected_row_version: expectedRowVersion,
        reason: reason.reason,
        idempotency_key: idem.key,
        request_fingerprint,
      },
    };
  }

  if (operation === "SET_DEPARTMENT_APPROVER") {
    const unitKind =
      typeof body.unit_kind === "string"
        ? body.unit_kind.trim().toUpperCase()
        : "";
    if (
      !LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS.includes(
        unitKind as LeaveDepartmentApproverUnitKind,
      )
    ) {
      return { ok: false, code: "LEAVE_UNIT_KIND_INVALID" };
    }
    const approverAppUserId =
      body.approver_app_user_id === null ||
      body.approver_app_user_id === undefined
        ? null
        : isValidUuid(body.approver_app_user_id)
          ? body.approver_app_user_id.trim().toLowerCase()
          : undefined;
    if (approverAppUserId === undefined) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    const businessToday =
      typeof todayVn === "string" && isValidIsoDate(todayVn)
        ? todayVn.trim()
        : new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Ho_Chi_Minh",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date());
    const validFrom =
      body.valid_from === null || body.valid_from === undefined
        ? null
        : isValidIsoDate(body.valid_from)
          ? body.valid_from.trim()
          : undefined;
    if (validFrom === undefined) {
      return { ok: false, code: "INVALID_REQUEST" };
    }
    if (validFrom !== null && validFrom > businessToday) {
      return { ok: false, code: "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN" };
    }
    if (validFrom !== null && validFrom < businessToday) {
      return { ok: false, code: "LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN" };
    }

    const request_fingerprint = sha256Hex({
      op: "SET_DEPARTMENT_APPROVER",
      unit_kind: unitKind,
      approver_app_user_id: approverAppUserId,
      valid_from: validFrom,
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
    });

    return {
      ok: true,
      data: {
        operation: "SET_DEPARTMENT_APPROVER",
        unit_kind: unitKind as LeaveDepartmentApproverUnitKind,
        approver_app_user_id: approverAppUserId,
        valid_from: validFrom,
        expected_row_version: expectedRowVersion,
        reason: reason.reason,
        idempotency_key: idem.key,
        request_fingerprint,
      },
    };
  }

  if (operation === "MANAGE_MODULE_GRANT") {
    const action =
      typeof body.action === "string" ? body.action.trim().toUpperCase() : "";
    const roleCode =
      typeof body.role_code === "string"
        ? body.role_code.trim().toUpperCase()
        : "";
    if (
      !LEAVE_MODULE_GRANT_ACTIONS.includes(action as LeaveModuleGrantAction) ||
      !LEAVE_MODULE_GRANT_ROLES.includes(roleCode as LeaveModuleGrantRole) ||
      !isValidUuid(body.target_app_user_id)
    ) {
      return { ok: false, code: "LEAVE_MODULE_GRANT_INVALID" };
    }
    const targetAppUserId = body.target_app_user_id.trim().toLowerCase();

    const request_fingerprint = sha256Hex({
      op: "MANAGE_MODULE_GRANT",
      action,
      target_app_user_id: targetAppUserId,
      role_code: roleCode,
      expected_row_version: expectedRowVersion,
      reason: reason.reason,
    });

    return {
      ok: true,
      data: {
        operation: "MANAGE_MODULE_GRANT",
        action: action as LeaveModuleGrantAction,
        target_app_user_id: targetAppUserId,
        role_code: roleCode as LeaveModuleGrantRole,
        expected_row_version: expectedRowVersion,
        reason: reason.reason,
        idempotency_key: idem.key,
        request_fingerprint,
      },
    };
  }

  return { ok: false, code: "INVALID_REQUEST" };
}

function normalizeOpeningRows(
  rawRows: unknown,
): { ok: true; rows: OpeningBatchRowInput[] } | { ok: false; code: LeaveErrorCode } {
  if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > 300) {
    return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
  }
  const rows: OpeningBatchRowInput[] = [];
  for (const item of rawRows) {
    if (!isPlainObject(item)) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    const appUserId =
      typeof item.app_user_id === "string" ? item.app_user_id.trim().toLowerCase() : "";
    const carryUnits = Number(item.carry_over_units ?? 0);
    const openUnits = Number(item.opening_current_year_units ?? 0);
    const senUnits = Number(item.seniority_units ?? 0);
    if (
      !Number.isInteger(carryUnits) ||
      !Number.isInteger(openUnits) ||
      !Number.isInteger(senUnits)
    ) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    const note =
      typeof item.note === "string" && item.note.trim().length > 0
        ? item.note.trim().slice(0, 500)
        : null;
    const expectedAsOfDate =
      item.expected_as_of_date === undefined || item.expected_as_of_date === null
        ? undefined
        : isValidIsoDate(item.expected_as_of_date)
          ? item.expected_as_of_date.trim()
          : null;
    if (expectedAsOfDate === null) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    const expectedCurrentYearGrantedUnits =
      item.expected_current_year_granted_units === undefined ||
      item.expected_current_year_granted_units === null
        ? undefined
        : Number(item.expected_current_year_granted_units);
    if (
      expectedCurrentYearGrantedUnits !== undefined &&
      !Number.isInteger(expectedCurrentYearGrantedUnits)
    ) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    const expectedCurrentYearLockedUnits =
      item.expected_current_year_locked_units === undefined ||
      item.expected_current_year_locked_units === null
        ? undefined
        : Number(item.expected_current_year_locked_units);
    if (
      expectedCurrentYearLockedUnits !== undefined &&
      !Number.isInteger(expectedCurrentYearLockedUnits)
    ) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    const expectedProfileRowVersion =
      item.expected_profile_row_version === undefined ||
      item.expected_profile_row_version === null
        ? undefined
        : Number(item.expected_profile_row_version);
    if (
      expectedProfileRowVersion !== undefined &&
      !Number.isInteger(expectedProfileRowVersion)
    ) {
      return { ok: false, code: "LEAVE_OPENING_ROWS_INVALID" };
    }
    rows.push({
      app_user_id: appUserId,
      carry_over_units: carryUnits,
      opening_current_year_units: openUnits,
      seniority_units: senUnits,
      note,
      ...(expectedAsOfDate !== undefined
        ? { expected_as_of_date: expectedAsOfDate }
        : {}),
      ...(expectedCurrentYearGrantedUnits !== undefined
        ? {
            expected_current_year_granted_units:
              expectedCurrentYearGrantedUnits,
          }
        : {}),
      ...(expectedCurrentYearLockedUnits !== undefined
        ? { expected_current_year_locked_units: expectedCurrentYearLockedUnits }
        : {}),
      ...(expectedProfileRowVersion !== undefined
        ? { expected_profile_row_version: expectedProfileRowVersion }
        : {}),
    });
  }
  return { ok: true, rows };
}

export function parsePreviewOpeningBatchBody(
  body: unknown,
): { ok: true; data: PreviewOpeningBatchInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const leaveYear = Number(body.leave_year);
  if (!Number.isInteger(leaveYear) || leaveYear < 2020 || leaveYear > 2100) {
    return { ok: false, code: "LEAVE_YEAR_INVALID" };
  }
  const parsedRows = normalizeOpeningRows(body.rows);
  if (!parsedRows.ok) return parsedRows;

  return {
    ok: true,
    data: {
      leave_year: leaveYear,
      rows: parsedRows.rows,
    },
  };
}

export function parseApplyOpeningBatchBody(
  body: unknown,
): { ok: true; data: ApplyOpeningBatchInput } | { ok: false; code: LeaveErrorCode } {
  if (!isPlainObject(body)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  const idem = normalizeIdempotencyKey(body.idempotency_key);
  if (!idem.ok) return idem;

  const reason = normalizeReason(body.reason, false);
  if (!reason.ok) return reason;

  const preview = parsePreviewOpeningBatchBody(body);
  if (!preview.ok) return preview;

  const request_fingerprint = sha256Hex({
    op: "APPLY_OPENING_BATCH",
    leave_year: preview.data.leave_year,
    rows: preview.data.rows,
    reason: reason.reason,
  });

  return {
    ok: true,
    data: {
      leave_year: preview.data.leave_year,
      rows: preview.data.rows,
      reason: reason.reason,
      idempotency_key: idem.key,
      request_fingerprint,
    },
  };
}

export function parseMonthlyReportQuery(
  url: URL,
):
  | {
      ok: true;
      year_month: string;
      unit_kind_filter: string | null;
      search: string | null;
      limit: number;
      offset: number;
    }
  | { ok: false; code: LeaveErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (
      key !== "month" &&
      key !== "unit_kind" &&
      key !== "search" &&
      key !== "limit" &&
      key !== "offset"
    ) {
      return { ok: false, code: "INVALID_QUERY" };
    }
  }
  const rawMonth = (url.searchParams.get("month") ?? "").trim();
  if (!YEAR_MONTH_PATTERN.test(rawMonth)) {
    return { ok: false, code: "LEAVE_REPORT_YEAR_MONTH_INVALID" };
  }

  const rawUnit = url.searchParams.get("unit_kind");
  const unitKindFilter =
    rawUnit !== null && rawUnit.trim().length > 0
      ? rawUnit.trim().toUpperCase()
      : null;
  if (
    unitKindFilter !== null &&
    unitKindFilter !== "ALL" &&
    !LEAVE_UNIT_KINDS.includes(unitKindFilter as LeaveUnitKind)
  ) {
    return { ok: false, code: "LEAVE_FILTER_INVALID" };
  }

  const rawSearch = url.searchParams.get("search");
  const search =
    rawSearch !== null && rawSearch.trim().length > 0
      ? rawSearch.trim().slice(0, 120)
      : null;

  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit ? Number(rawLimit) : 200;
  const offset = rawOffset ? Number(rawOffset) : 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return { ok: false, code: "INVALID_QUERY" };
  }

  return {
    ok: true,
    year_month: rawMonth,
    unit_kind_filter: unitKindFilter,
    search,
    limit,
    offset,
  };
}
