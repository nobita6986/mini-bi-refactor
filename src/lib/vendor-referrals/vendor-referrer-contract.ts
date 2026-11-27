/**
 * Vendor Referrer Attribution (BoD-only) — Pure, Zod-free domain contract & fail-closed
 * RPC projection validators.
 *
 * Strictly excludes any money/commission/fee/amount fields on both request inputs and
 * RPC response projections. Matches `20261128090000_vendor_referrer_attribution.sql` 1:1.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDOR_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CALENDAR_MONTH_REGEX = /^([0-9]{4})-(0[1-9]|1[0-2])$/;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const FORBIDDEN_TEXT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export const RESERVED_VENDOR_ID = "__system_vendor__";
export const VENDOR_REFERRER_REASON_MAX = 4000;
export const VENDOR_REFERRER_SEARCH_MAX = 120;
export const VENDOR_REFERRER_DEFAULT_PAGE_SIZE = 25;
export const VENDOR_REFERRER_DEFAULT_CANDIDATE_LIMIT = 200;

const FORBIDDEN_COMPENSATION_TOKENS = new Set([
  "money",
  "commission",
  "fee",
  "fees",
  "payout",
  "amount",
  "salary",
  "bonus",
  "rate",
  "currency",
  "price",
  "vnd",
  "hoa_hong",
  "tien",
  "phi",
]);

function isForbiddenCompensationKey(key: string): boolean {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  if (FORBIDDEN_COMPENSATION_TOKENS.has(snake)) return true;
  const parts = snake.split("_");
  if (parts.some((part) => FORBIDDEN_COMPENSATION_TOKENS.has(part))) return true;
  return snake.includes("hoa_hong");
}

export type VendorReferrerAction = "ASSIGN" | "REPLACE" | "REVOKE";

export type VendorReferrerErrorKind =
  | "conflict"
  | "denied"
  | "invalid"
  | "not-found"
  | "unavailable";

/**
 * Maps PostgreSQL SQLSTATE codes from `direct_entry_vendor_referrer_*` RPCs to
 * sanitized domain error kinds. Unknown codes fail closed as `"unavailable"`.
 */
export function classifyVendorReferrerError(error: {
  code?: string;
  message?: string;
}): VendorReferrerErrorKind {
  if (
    error.code === "PT409" ||
    error.code === "40001" ||
    error.code === "23505" ||
    error.code === "23P01"
  ) {
    return "conflict";
  }
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input"
      ? "conflict"
      : "invalid";
  }
  return "unavailable";
}

export type ActorAccess = {
  can_manage: boolean;
  can_view_report: boolean;
  has_capability: boolean;
  is_active_bod: boolean;
};

export type EligibleCandidate = {
  person_id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  department_name: string;
  department_system_key: string | null;
  recruiter_id: string;
  recruiter_display_name: string;
  personnel_code: string | null;
};

export type CandidateListResponse = {
  items: readonly EligibleCandidate[];
  total: number;
  authorization_date: string;
};

export type CurrentReferrerLink = {
  link_id: string;
  referrer_person_id: string;
  referrer_employee_code: string;
  referrer_full_name: string;
  referrer_department_name: string | null;
  effective_from: string;
  reason: string;
  created_at: string;
};

export type AssignedCurrentReferrerLink = CurrentReferrerLink & {
  vendor_id: string;
  is_current: true;
};

export type VendorWithReferrer = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  version: number;
  current_link: CurrentReferrerLink | null;
  history_count: number;
};

export type VendorListResponse = {
  items: readonly VendorWithReferrer[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  authorization_date: string;
};

export type ReferrerLinkHistory = {
  link_id: string;
  vendor_id: string;
  referrer_person_id: string;
  referrer_employee_code: string;
  referrer_full_name: string;
  referrer_department_name: string | null;
  effective_from: string;
  effective_to: string | null;
  is_current: boolean;
  reason: string;
  created_by_display_name: string;
  created_at: string;
  ended_by_display_name: string | null;
  ended_at: string | null;
  ended_reason: string | null;
};

export type AuditEvent = {
  event_id: string;
  action: VendorReferrerAction;
  link_id: string | null;
  previous_link_id: string | null;
  referrer_person_id: string | null;
  previous_referrer_person_id: string | null;
  effective_date: string;
  actor_display_name: string;
  referrer_full_name: string | null;
  previous_referrer_full_name: string | null;
  reason: string;
  created_at: string;
};

export type VendorHistoryVendorSummary = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  version: number;
  current_link: CurrentReferrerLink | null;
};

export type VendorHistoryResponse = {
  vendor: VendorHistoryVendorSummary;
  links: readonly ReferrerLinkHistory[];
  audit_events: readonly AuditEvent[];
  authorization_date: string;
};

export type AssignMutationResult = {
  vendor_id: string;
  action: "ASSIGN" | "REPLACE";
  current_link: AssignedCurrentReferrerLink;
  replaced_link_id: string | null;
  replayed: boolean;
};

export type RevokeMutationResult = {
  vendor_id: string;
  action: "REVOKE";
  revoked_link_id: string;
  effective_date: string;
  current_link: null;
  replayed: boolean;
};

export type MutationResult = AssignMutationResult | RevokeMutationResult;

export type MonthlyReportReconciliation = {
  total_vendor_turns: number;
  matched_vendor_turns: number;
  attributed_turns: number;
  unassigned_vendor_turns: number;
  unresolved_vendor_turns: number;
};

export type MonthlyReportFilteredSummary = {
  attributed_turns: number;
  referrer_count: number;
  vendor_count: number;
  project_count: number;
};

export type MonthlyReportByReferrerItem = {
  referrer_person_id: string;
  referrer_employee_code: string;
  referrer_full_name: string;
  referrer_department_name: string | null;
  turns: number;
  vendor_count: number;
  project_count: number;
};

export type MonthlyReportRow = {
  referrer_person_id: string;
  referrer_employee_code: string;
  referrer_full_name: string;
  referrer_department_name: string | null;
  vendor_id: string;
  vendor_display_name: string;
  project_id: string;
  project_display_name: string;
  turns: number;
};

export type MonthlyReportUnassignedVendor = {
  vendor_id: string;
  vendor_display_name: string;
  turns: number;
  project_count: number;
};

export type MonthlyReportUnresolvedBreakdown = {
  recruiter_id: string;
  recruiter_display_name: string;
  project_id: string;
  project_display_name: string;
  turns: number;
};

export type MonthlyReportFilterOptions = {
  referrers: readonly {
    person_id: string;
    employee_code: string;
    full_name: string;
    department_name: string | null;
  }[];
  vendors: readonly {
    vendor_id: string;
    display_name: string;
  }[];
  projects: readonly {
    project_id: string;
    display_name: string;
  }[];
};

export type MonthlyReportResponse = {
  month: string;
  period_from: string | null;
  period_to: string | null;
  authorization_date: string;
  reconciliation: MonthlyReportReconciliation;
  filtered_summary: MonthlyReportFilteredSummary;
  by_referrer: readonly MonthlyReportByReferrerItem[];
  rows: readonly MonthlyReportRow[];
  unassigned_vendors: readonly MonthlyReportUnassignedVendor[];
  unresolved_vendor_breakdown: readonly MonthlyReportUnresolvedBreakdown[];
  filter_options: MonthlyReportFilterOptions;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (nonEmptyStr(value) ?? undefined);
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function uuidStr(value: unknown): string | null {
  return typeof value === "string" && UUID_REGEX.test(value) ? value.toLowerCase() : null;
}

function nullableUuidStr(value: unknown): string | null | undefined {
  return value === null ? null : (uuidStr(value) ?? undefined);
}

function isoDateStr(value: unknown): string | null {
  return typeof value === "string" && isRealCalendarDate(value) ? value : null;
}

function nullableIsoDateStr(value: unknown): string | null | undefined {
  return value === null ? null : (isoDateStr(value) ?? undefined);
}

export function containsForbiddenCompensationField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenCompensationField(item, depth + 1));
  }
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenCompensationKey(key)) {
      return true;
    }
    if (containsForbiddenCompensationField(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function isValidVendorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== RESERVED_VENDOR_ID &&
    VENDOR_ID_REGEX.test(value)
  );
}

export function isValidProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_REGEX.test(value);
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function isValidCalendarMonthOrAll(value: unknown): value is string {
  if (value === "ALL") return true;
  if (typeof value !== "string" || !CALENDAR_MONTH_REGEX.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) && year >= 1970 && year <= 2999;
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_REGEX.test(value);
}

export function hasSingleLineControlChars(value: string): boolean {
  return FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(value);
}

export function parseRequiredReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > VENDOR_REFERRER_REASON_MAX ||
    FORBIDDEN_TEXT_CONTROL_CHARS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function projectActorAccess(value: unknown): ActorAccess | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["can_manage", "can_view_report", "has_capability", "is_active_bod"])
  ) {
    return null;
  }
  const can_manage = bool(value.can_manage);
  const can_view_report = bool(value.can_view_report);
  const has_capability = bool(value.has_capability);
  const is_active_bod = bool(value.is_active_bod);
  if (
    can_manage === null ||
    can_view_report === null ||
    has_capability === null ||
    is_active_bod === null
  ) {
    return null;
  }
  return {
    can_manage,
    can_view_report,
    has_capability,
    is_active_bod,
  };
}

function projectEligibleCandidate(value: unknown): EligibleCandidate | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "person_id",
      "employee_code",
      "full_name",
      "department_id",
      "department_name",
      "department_system_key",
      "recruiter_id",
      "recruiter_display_name",
      "personnel_code",
    ])
  ) {
    return null;
  }
  const person_id = uuidStr(value.person_id);
  const employee_code = nonEmptyStr(value.employee_code);
  const full_name = nonEmptyStr(value.full_name);
  const department_id = uuidStr(value.department_id);
  const department_name = nonEmptyStr(value.department_name);
  const department_system_key = nullableStr(value.department_system_key);
  const recruiter_id = uuidStr(value.recruiter_id);
  const recruiter_display_name = nonEmptyStr(value.recruiter_display_name);
  const personnel_code = nullableStr(value.personnel_code);
  if (
    person_id === null ||
    employee_code === null ||
    full_name === null ||
    department_id === null ||
    department_name === null ||
    department_system_key === undefined ||
    recruiter_id === null ||
    recruiter_display_name === null ||
    personnel_code === undefined
  ) {
    return null;
  }
  return {
    person_id,
    employee_code,
    full_name,
    department_id,
    department_name,
    department_system_key,
    recruiter_id,
    recruiter_display_name,
    personnel_code,
  };
}

export function projectCandidateList(value: unknown): CandidateListResponse | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (!isRecord(value) || !exactKeys(value, ["items", "total", "authorization_date"])) {
    return null;
  }
  const total = nonNegInt(value.total);
  const authorization_date = isoDateStr(value.authorization_date);
  if (total === null || authorization_date === null || !Array.isArray(value.items)) {
    return null;
  }
  const items: EligibleCandidate[] = [];
  for (const rawItem of value.items) {
    const projected = projectEligibleCandidate(rawItem);
    if (!projected) return null;
    items.push(projected);
  }
  if (total < items.length) return null;
  return { items, total, authorization_date };
}

function projectCurrentReferrerLink(value: unknown): CurrentReferrerLink | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "link_id",
      "referrer_person_id",
      "referrer_employee_code",
      "referrer_full_name",
      "referrer_department_name",
      "effective_from",
      "reason",
      "created_at",
    ])
  ) {
    return null;
  }
  const link_id = uuidStr(value.link_id);
  const referrer_person_id = uuidStr(value.referrer_person_id);
  const referrer_employee_code = nonEmptyStr(value.referrer_employee_code);
  const referrer_full_name = nonEmptyStr(value.referrer_full_name);
  const referrer_department_name = nullableStr(value.referrer_department_name);
  const effective_from = isoDateStr(value.effective_from);
  const reason = nonEmptyStr(value.reason);
  const created_at = nonEmptyStr(value.created_at);
  if (
    link_id === null ||
    referrer_person_id === null ||
    referrer_employee_code === null ||
    referrer_full_name === null ||
    referrer_department_name === undefined ||
    effective_from === null ||
    reason === null ||
    created_at === null
  ) {
    return null;
  }
  return {
    link_id,
    referrer_person_id,
    referrer_employee_code,
    referrer_full_name,
    referrer_department_name,
    effective_from,
    reason,
    created_at,
  };
}

function projectAssignedCurrentReferrerLink(value: unknown): AssignedCurrentReferrerLink | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "link_id",
      "vendor_id",
      "referrer_person_id",
      "referrer_employee_code",
      "referrer_full_name",
      "referrer_department_name",
      "effective_from",
      "is_current",
      "reason",
      "created_at",
    ])
  ) {
    return null;
  }
  const vendor_id = isValidVendorId(value.vendor_id) ? value.vendor_id : null;
  if (vendor_id === null || value.is_current !== true) return null;
  const link_id = uuidStr(value.link_id);
  const referrer_person_id = uuidStr(value.referrer_person_id);
  const referrer_employee_code = nonEmptyStr(value.referrer_employee_code);
  const referrer_full_name = nonEmptyStr(value.referrer_full_name);
  const referrer_department_name = nullableStr(value.referrer_department_name);
  const effective_from = isoDateStr(value.effective_from);
  const reason = nonEmptyStr(value.reason);
  const created_at = nonEmptyStr(value.created_at);
  if (
    link_id === null ||
    referrer_person_id === null ||
    referrer_employee_code === null ||
    referrer_full_name === null ||
    referrer_department_name === undefined ||
    effective_from === null ||
    reason === null ||
    created_at === null
  ) {
    return null;
  }
  return {
    link_id,
    vendor_id,
    referrer_person_id,
    referrer_employee_code,
    referrer_full_name,
    referrer_department_name,
    effective_from,
    is_current: true,
    reason,
    created_at,
  };
}

function projectVendorWithReferrer(value: unknown): VendorWithReferrer | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "vendor_id",
      "display_name",
      "active",
      "version",
      "current_link",
      "history_count",
    ])
  ) {
    return null;
  }
  const vendor_id = isValidVendorId(value.vendor_id) ? value.vendor_id : null;
  const display_name = nonEmptyStr(value.display_name);
  const active = bool(value.active);
  const version = nonNegInt(value.version);
  const history_count = nonNegInt(value.history_count);
  const current_link =
    value.current_link === null ? null : projectCurrentReferrerLink(value.current_link);
  if (
    vendor_id === null ||
    display_name === null ||
    active === null ||
    version === null ||
    history_count === null ||
    (value.current_link !== null && current_link === null)
  ) {
    return null;
  }
  return {
    vendor_id,
    display_name,
    active,
    version,
    current_link,
    history_count,
  };
}

export function projectVendorList(value: unknown): VendorListResponse | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "items",
      "total",
      "page",
      "page_size",
      "has_more",
      "authorization_date",
    ])
  ) {
    return null;
  }
  const total = nonNegInt(value.total);
  const page = nonNegInt(value.page);
  const page_size = nonNegInt(value.page_size);
  const has_more = bool(value.has_more);
  const authorization_date = isoDateStr(value.authorization_date);
  if (
    total === null ||
    page === null ||
    page < 1 ||
    page_size === null ||
    page_size < 1 ||
    has_more === null ||
    authorization_date === null ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items: VendorWithReferrer[] = [];
  for (const rawItem of value.items) {
    const projected = projectVendorWithReferrer(rawItem);
    if (!projected) return null;
    items.push(projected);
  }
  if (total < items.length) return null;
  return {
    items,
    total,
    page,
    page_size,
    has_more,
    authorization_date,
  };
}

function projectReferrerLinkHistory(value: unknown): ReferrerLinkHistory | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "link_id",
      "vendor_id",
      "referrer_person_id",
      "referrer_employee_code",
      "referrer_full_name",
      "referrer_department_name",
      "effective_from",
      "effective_to",
      "is_current",
      "reason",
      "created_by_app_user_id",
      "created_by_display_name",
      "created_at",
      "ended_by_app_user_id",
      "ended_by_display_name",
      "ended_at",
      "ended_reason",
    ])
  ) {
    return null;
  }
  const link_id = uuidStr(value.link_id);
  const vendor_id = isValidVendorId(value.vendor_id) ? value.vendor_id : null;
  const referrer_person_id = uuidStr(value.referrer_person_id);
  const referrer_employee_code = nonEmptyStr(value.referrer_employee_code);
  const referrer_full_name = nonEmptyStr(value.referrer_full_name);
  const referrer_department_name = nullableStr(value.referrer_department_name);
  const effective_from = isoDateStr(value.effective_from);
  const effective_to = nullableIsoDateStr(value.effective_to);
  const is_current = bool(value.is_current);
  const reason = nonEmptyStr(value.reason);
  const created_by_app_user_id = uuidStr(value.created_by_app_user_id);
  const created_by_display_name = nonEmptyStr(value.created_by_display_name);
  const created_at = nonEmptyStr(value.created_at);
  const ended_by_app_user_id = nullableUuidStr(value.ended_by_app_user_id);
  const ended_by_display_name = nullableStr(value.ended_by_display_name);
  const ended_at = nullableStr(value.ended_at);
  const ended_reason = nullableStr(value.ended_reason);
  if (
    link_id === null ||
    vendor_id === null ||
    referrer_person_id === null ||
    referrer_employee_code === null ||
    referrer_full_name === null ||
    referrer_department_name === undefined ||
    effective_from === null ||
    effective_to === undefined ||
    is_current === null ||
    reason === null ||
    created_by_app_user_id === null ||
    created_by_display_name === null ||
    created_at === null ||
    ended_by_app_user_id === undefined ||
    ended_by_display_name === undefined ||
    ended_at === undefined ||
    ended_reason === undefined
  ) {
    return null;
  }
  return {
    link_id,
    vendor_id,
    referrer_person_id,
    referrer_employee_code,
    referrer_full_name,
    referrer_department_name,
    effective_from,
    effective_to,
    is_current,
    reason,
    created_by_display_name,
    created_at,
    ended_by_display_name,
    ended_at,
    ended_reason,
  };
}

function projectAuditEvent(value: unknown): AuditEvent | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "event_id",
      "action",
      "link_id",
      "previous_link_id",
      "referrer_person_id",
      "previous_referrer_person_id",
      "effective_date",
      "actor_app_user_id",
      "actor_display_name",
      "referrer_full_name",
      "previous_referrer_full_name",
      "reason",
      "created_at",
    ])
  ) {
    return null;
  }
  const event_id = uuidStr(value.event_id);
  const action =
    value.action === "ASSIGN" || value.action === "REPLACE" || value.action === "REVOKE"
      ? value.action
      : null;
  const link_id = nullableUuidStr(value.link_id);
  const previous_link_id = nullableUuidStr(value.previous_link_id);
  const referrer_person_id = nullableUuidStr(value.referrer_person_id);
  const previous_referrer_person_id = nullableUuidStr(value.previous_referrer_person_id);
  const effective_date = isoDateStr(value.effective_date);
  const actor_app_user_id = uuidStr(value.actor_app_user_id);
  const actor_display_name = nonEmptyStr(value.actor_display_name);
  const referrer_full_name = nullableStr(value.referrer_full_name);
  const previous_referrer_full_name = nullableStr(value.previous_referrer_full_name);
  const reason = nonEmptyStr(value.reason);
  const created_at = nonEmptyStr(value.created_at);
  if (
    event_id === null ||
    action === null ||
    link_id === undefined ||
    previous_link_id === undefined ||
    referrer_person_id === undefined ||
    previous_referrer_person_id === undefined ||
    effective_date === null ||
    actor_app_user_id === null ||
    actor_display_name === null ||
    referrer_full_name === undefined ||
    previous_referrer_full_name === undefined ||
    reason === null ||
    created_at === null
  ) {
    return null;
  }
  return {
    event_id,
    action,
    link_id,
    previous_link_id,
    referrer_person_id,
    previous_referrer_person_id,
    effective_date,
    actor_display_name,
    referrer_full_name,
    previous_referrer_full_name,
    reason,
    created_at,
  };
}

export function projectVendorHistory(value: unknown): VendorHistoryResponse | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["vendor", "links", "audit_events", "authorization_date"])
  ) {
    return null;
  }
  const authorization_date = isoDateStr(value.authorization_date);
  if (
    authorization_date === null ||
    !isRecord(value.vendor) ||
    !exactKeys(value.vendor, [
      "vendor_id",
      "display_name",
      "active",
      "version",
      "current_link",
    ]) ||
    !Array.isArray(value.links) ||
    !Array.isArray(value.audit_events)
  ) {
    return null;
  }
  const vendor_id = isValidVendorId(value.vendor.vendor_id) ? value.vendor.vendor_id : null;
  const display_name = nonEmptyStr(value.vendor.display_name);
  const active = bool(value.vendor.active);
  const version = nonNegInt(value.vendor.version);
  const current_link =
    value.vendor.current_link === null
      ? null
      : projectCurrentReferrerLink(value.vendor.current_link);
  if (
    vendor_id === null ||
    display_name === null ||
    active === null ||
    version === null ||
    (value.vendor.current_link !== null && current_link === null)
  ) {
    return null;
  }

  const links: ReferrerLinkHistory[] = [];
  for (const rawLink of value.links) {
    const projected = projectReferrerLinkHistory(rawLink);
    if (!projected) return null;
    links.push(projected);
  }
  const audit_events: AuditEvent[] = [];
  for (const rawEvent of value.audit_events) {
    const projected = projectAuditEvent(rawEvent);
    if (!projected) return null;
    audit_events.push(projected);
  }

  return {
    vendor: {
      vendor_id,
      display_name,
      active,
      version,
      current_link,
    },
    links,
    audit_events,
    authorization_date,
  };
}

export function projectAssignMutationResult(value: unknown): AssignMutationResult | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "vendor_id",
      "action",
      "current_link",
      "replaced_link_id",
      "replayed",
    ])
  ) {
    return null;
  }
  const vendor_id = isValidVendorId(value.vendor_id) ? value.vendor_id : null;
  const action = value.action === "ASSIGN" || value.action === "REPLACE" ? value.action : null;
  const current_link = projectAssignedCurrentReferrerLink(value.current_link);
  const replaced_link_id = nullableUuidStr(value.replaced_link_id);
  const replayed = bool(value.replayed);
  if (
    vendor_id === null ||
    action === null ||
    current_link === null ||
    replaced_link_id === undefined ||
    replayed === null
  ) {
    return null;
  }
  if (action === "ASSIGN" && replaced_link_id !== null) return null;
  if (action === "REPLACE" && replaced_link_id === null) return null;

  return {
    vendor_id,
    action,
    current_link,
    replaced_link_id,
    replayed,
  };
}

export function projectRevokeMutationResult(value: unknown): RevokeMutationResult | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "vendor_id",
      "action",
      "revoked_link_id",
      "effective_date",
      "current_link",
      "replayed",
    ])
  ) {
    return null;
  }
  const vendor_id = isValidVendorId(value.vendor_id) ? value.vendor_id : null;
  const revoked_link_id = uuidStr(value.revoked_link_id);
  const effective_date = isoDateStr(value.effective_date);
  const replayed = bool(value.replayed);
  if (
    vendor_id === null ||
    value.action !== "REVOKE" ||
    revoked_link_id === null ||
    effective_date === null ||
    value.current_link !== null ||
    replayed === null
  ) {
    return null;
  }

  return {
    vendor_id,
    action: "REVOKE",
    revoked_link_id,
    effective_date,
    current_link: null,
    replayed,
  };
}

export function projectMutationResult(value: unknown): MutationResult | null {
  return projectAssignMutationResult(value) ?? projectRevokeMutationResult(value);
}

export function projectMonthlyReport(value: unknown): MonthlyReportResponse | null {
  if (containsForbiddenCompensationField(value)) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "month",
      "period_from",
      "period_to",
      "authorization_date",
      "reconciliation",
      "filtered_summary",
      "by_referrer",
      "rows",
      "unassigned_vendors",
      "unresolved_vendor_breakdown",
      "filter_options",
    ])
  ) {
    return null;
  }
  const month = isValidCalendarMonthOrAll(value.month) ? value.month : null;
  const period_from = nullableIsoDateStr(value.period_from);
  const period_to = nullableIsoDateStr(value.period_to);
  const authorization_date = isoDateStr(value.authorization_date);
  if (
    month === null ||
    period_from === undefined ||
    period_to === undefined ||
    authorization_date === null
  ) {
    return null;
  }

  const rec = value.reconciliation;
  if (
    !isRecord(rec) ||
    !exactKeys(rec, [
      "total_vendor_turns",
      "matched_vendor_turns",
      "attributed_turns",
      "unassigned_vendor_turns",
      "unresolved_vendor_turns",
    ])
  ) {
    return null;
  }
  const total_vendor_turns = nonNegInt(rec.total_vendor_turns);
  const matched_vendor_turns = nonNegInt(rec.matched_vendor_turns);
  const attributed_turns = nonNegInt(rec.attributed_turns);
  const unassigned_vendor_turns = nonNegInt(rec.unassigned_vendor_turns);
  const unresolved_vendor_turns = nonNegInt(rec.unresolved_vendor_turns);
  if (
    total_vendor_turns === null ||
    matched_vendor_turns === null ||
    attributed_turns === null ||
    unassigned_vendor_turns === null ||
    unresolved_vendor_turns === null
  ) {
    return null;
  }
  if (
    matched_vendor_turns + unresolved_vendor_turns !== total_vendor_turns ||
    attributed_turns + unassigned_vendor_turns !== matched_vendor_turns
  ) {
    return null;
  }

  const fs = value.filtered_summary;
  if (
    !isRecord(fs) ||
    !exactKeys(fs, [
      "attributed_turns",
      "referrer_count",
      "vendor_count",
      "project_count",
    ])
  ) {
    return null;
  }
  const fsAttributed = nonNegInt(fs.attributed_turns);
  const referrer_count = nonNegInt(fs.referrer_count);
  const vendor_count = nonNegInt(fs.vendor_count);
  const project_count = nonNegInt(fs.project_count);
  if (
    fsAttributed === null ||
    referrer_count === null ||
    vendor_count === null ||
    project_count === null
  ) {
    return null;
  }

  if (
    !Array.isArray(value.by_referrer) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.unassigned_vendors) ||
    !Array.isArray(value.unresolved_vendor_breakdown)
  ) {
    return null;
  }

  const by_referrer: MonthlyReportByReferrerItem[] = [];
  for (const item of value.by_referrer) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "referrer_person_id",
        "referrer_employee_code",
        "referrer_full_name",
        "referrer_department_name",
        "turns",
        "vendor_count",
        "project_count",
      ])
    ) {
      return null;
    }
    const referrer_person_id = uuidStr(item.referrer_person_id);
    const referrer_employee_code = nonEmptyStr(item.referrer_employee_code);
    const referrer_full_name = nonEmptyStr(item.referrer_full_name);
    const referrer_department_name = nullableStr(item.referrer_department_name);
    const itemTurns = nonNegInt(item.turns);
    const itemVendorCount = nonNegInt(item.vendor_count);
    const itemProjectCount = nonNegInt(item.project_count);
    if (
      referrer_person_id === null ||
      referrer_employee_code === null ||
      referrer_full_name === null ||
      referrer_department_name === undefined ||
      itemTurns === null ||
      itemVendorCount === null ||
      itemProjectCount === null
    ) {
      return null;
    }
    by_referrer.push({
      referrer_person_id,
      referrer_employee_code,
      referrer_full_name,
      referrer_department_name,
      turns: itemTurns,
      vendor_count: itemVendorCount,
      project_count: itemProjectCount,
    });
  }

  const rows: MonthlyReportRow[] = [];
  for (const item of value.rows) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "referrer_person_id",
        "referrer_employee_code",
        "referrer_full_name",
        "referrer_department_name",
        "vendor_id",
        "vendor_display_name",
        "project_id",
        "project_display_name",
        "turns",
      ])
    ) {
      return null;
    }
    const referrer_person_id = uuidStr(item.referrer_person_id);
    const referrer_employee_code = nonEmptyStr(item.referrer_employee_code);
    const referrer_full_name = nonEmptyStr(item.referrer_full_name);
    const referrer_department_name = nullableStr(item.referrer_department_name);
    const vendor_id = isValidVendorId(item.vendor_id) ? item.vendor_id : null;
    const vendor_display_name = nonEmptyStr(item.vendor_display_name);
    const project_id = isValidProjectId(item.project_id) ? item.project_id : null;
    const project_display_name = nonEmptyStr(item.project_display_name);
    const rowTurns = nonNegInt(item.turns);
    if (
      referrer_person_id === null ||
      referrer_employee_code === null ||
      referrer_full_name === null ||
      referrer_department_name === undefined ||
      vendor_id === null ||
      vendor_display_name === null ||
      project_id === null ||
      project_display_name === null ||
      rowTurns === null
    ) {
      return null;
    }
    rows.push({
      referrer_person_id,
      referrer_employee_code,
      referrer_full_name,
      referrer_department_name,
      vendor_id,
      vendor_display_name,
      project_id,
      project_display_name,
      turns: rowTurns,
    });
  }

  const unassigned_vendors: MonthlyReportUnassignedVendor[] = [];
  for (const item of value.unassigned_vendors) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["vendor_id", "vendor_display_name", "turns", "project_count"])
    ) {
      return null;
    }
    const vendor_id = isValidVendorId(item.vendor_id) ? item.vendor_id : null;
    const vendor_display_name = nonEmptyStr(item.vendor_display_name);
    const turns = nonNegInt(item.turns);
    const vProjectCount = nonNegInt(item.project_count);
    if (
      vendor_id === null ||
      vendor_display_name === null ||
      turns === null ||
      vProjectCount === null
    ) {
      return null;
    }
    unassigned_vendors.push({
      vendor_id,
      vendor_display_name,
      turns,
      project_count: vProjectCount,
    });
  }

  const unresolved_vendor_breakdown: MonthlyReportUnresolvedBreakdown[] = [];
  for (const item of value.unresolved_vendor_breakdown) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "recruiter_id",
        "recruiter_display_name",
        "project_id",
        "project_display_name",
        "turns",
      ])
    ) {
      return null;
    }
    const recruiter_id = uuidStr(item.recruiter_id);
    const recruiter_display_name = nonEmptyStr(item.recruiter_display_name);
    const project_id = isValidProjectId(item.project_id) ? item.project_id : null;
    const project_display_name = nonEmptyStr(item.project_display_name);
    const turns = nonNegInt(item.turns);
    if (
      recruiter_id === null ||
      recruiter_display_name === null ||
      project_id === null ||
      project_display_name === null ||
      turns === null
    ) {
      return null;
    }
    unresolved_vendor_breakdown.push({
      recruiter_id,
      recruiter_display_name,
      project_id,
      project_display_name,
      turns,
    });
  }

  const fo = value.filter_options;
  if (!isRecord(fo) || !exactKeys(fo, ["referrers", "vendors", "projects"])) {
    return null;
  }
  if (
    !Array.isArray(fo.referrers) ||
    !Array.isArray(fo.vendors) ||
    !Array.isArray(fo.projects)
  ) {
    return null;
  }

  const referrers: MonthlyReportFilterOptions["referrers"][number][] = [];
  for (const item of fo.referrers) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["person_id", "employee_code", "full_name", "department_name"])
    ) {
      return null;
    }
    const person_id = uuidStr(item.person_id);
    const employee_code = nonEmptyStr(item.employee_code);
    const full_name = nonEmptyStr(item.full_name);
    const department_name = nullableStr(item.department_name);
    if (
      person_id === null ||
      employee_code === null ||
      full_name === null ||
      department_name === undefined
    ) {
      return null;
    }
    referrers.push({ person_id, employee_code, full_name, department_name });
  }

  const vendors: MonthlyReportFilterOptions["vendors"][number][] = [];
  for (const item of fo.vendors) {
    if (!isRecord(item) || !exactKeys(item, ["vendor_id", "display_name"])) {
      return null;
    }
    const vendor_id = isValidVendorId(item.vendor_id) ? item.vendor_id : null;
    const display_name = nonEmptyStr(item.display_name);
    if (vendor_id === null || display_name === null) return null;
    vendors.push({ vendor_id, display_name });
  }

  const projects: MonthlyReportFilterOptions["projects"][number][] = [];
  for (const item of fo.projects) {
    if (!isRecord(item) || !exactKeys(item, ["project_id", "display_name"])) {
      return null;
    }
    const project_id = isValidProjectId(item.project_id) ? item.project_id : null;
    const display_name = nonEmptyStr(item.display_name);
    if (project_id === null || display_name === null) return null;
    projects.push({ project_id, display_name });
  }

  return {
    month,
    period_from,
    period_to,
    authorization_date,
    reconciliation: {
      total_vendor_turns,
      matched_vendor_turns,
      attributed_turns,
      unassigned_vendor_turns,
      unresolved_vendor_turns,
    },
    filtered_summary: {
      attributed_turns: fsAttributed,
      referrer_count,
      vendor_count,
      project_count,
    },
    by_referrer,
    rows,
    unassigned_vendors,
    unresolved_vendor_breakdown,
    filter_options: {
      referrers,
      vendors,
      projects,
    },
  };
}
