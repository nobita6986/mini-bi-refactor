import { createHash } from "node:crypto";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";

export const DEPARTMENT_DEFAULT_PAGE_SIZE = 25;
export const DEPARTMENT_MAX_PAGE_SIZE = 100;
export const DEPARTMENT_MAX_PAGE = 1000;
export const DEPARTMENT_MAX_SEARCH_LENGTH = 120;
export const DEPARTMENT_MAX_REASON_LENGTH = 4000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i;
const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const SEARCH_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const REASON_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const WP3_MAX_REASON_LENGTH = 500;

export const DEPARTMENT_SYSTEM_KEYS = [
  "RECRUITMENT",
  "ACCOUNTING",
  "MARKETING",
  "IT",
  "MANAGEMENT_BOD",
] as const;
export type DepartmentSystemKey = (typeof DEPARTMENT_SYSTEM_KEYS)[number];

export const DEPARTMENT_MEMBERSHIP_MODES = [
  "MANAGED_MEMBERSHIP_AND_TEAMS",
  "MANAGED_MEMBERSHIP",
] as const;
export type DepartmentMembershipMode = (typeof DEPARTMENT_MEMBERSHIP_MODES)[number];

export const DEPARTMENT_DEFAULT_POLICY_CODES = [
  "EXISTING_TEAM_AUTHORITY_READ_ONLY",
  "VENDOR_FINANCE_VIEW_AND_RECORD",
  "ORGANIZATIONAL_MEMBERSHIP_ONLY",
] as const;
export type DepartmentDefaultPolicyCode = (typeof DEPARTMENT_DEFAULT_POLICY_CODES)[number];

export const DEPARTMENT_MEMBERSHIP_STATES = [
  "CURRENT",
  "SCHEDULED",
  "HISTORY",
] as const;
export type DepartmentMembershipState = (typeof DEPARTMENT_MEMBERSHIP_STATES)[number];

export const DEPARTMENT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "DEPARTMENT_ACCESS_DENIED",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "BODY_TOO_LARGE",
  "DEPARTMENT_QUERY_INVALID",
  "DEPARTMENT_SEARCH_INVALID",
  "DEPARTMENT_NOT_FOUND",
  "DEPARTMENT_INACTIVE",
  "DEPARTMENT_MEMBERSHIP_UNSUPPORTED",
  "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID",
  "DEPARTMENT_MEMBERSHIP_REASON_INVALID",
  "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID",
  "DEPARTMENT_MEMBERSHIP_NOT_FOUND",
  "TARGET_ACCOUNT_NOT_FOUND",
  "TARGET_ACCOUNT_DISABLED",
  "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT",
  "DEPARTMENT_MEMBERSHIP_OVERLAP",
  "DEPARTMENT_MEMBERSHIP_ALREADY_ENDED",
  "DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS",
  "DUPLICATE_CODE",
  "VERSION_CONFLICT",
  "PERSON_NOT_FOUND",
  "PERSON_INACTIVE",
  "PERSON_ALREADY_IN_DEPARTMENT",
  "PERSON_ALREADY_IN_OTHER_DEPARTMENT",
  "PERSON_IS_ACTIVE_DEPARTMENT_HEAD",
  "PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT",
  "HEAD_ALREADY_ENDED",
  "CLIENT_SCHEDULE_FIELD_FORBIDDEN",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "ORG_VALIDATION_ERROR",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
  "DEPARTMENT_UNAVAILABLE",
] as const;

export type DepartmentErrorCode = (typeof DEPARTMENT_ERROR_CODES)[number];

const ERROR_HTTP_STATUS: Readonly<Record<DepartmentErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  ACTOR_NOT_AVAILABLE: 403,
  DEPARTMENT_ACCESS_DENIED: 403,
  CSRF_REJECTED: 403,
  CONTENT_TYPE_INVALID: 400,
  BODY_TOO_LARGE: 413,
  DEPARTMENT_QUERY_INVALID: 400,
  DEPARTMENT_SEARCH_INVALID: 400,
  DEPARTMENT_NOT_FOUND: 404,
  DEPARTMENT_INACTIVE: 409,
  DEPARTMENT_MEMBERSHIP_UNSUPPORTED: 400,
  DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID: 400,
  DEPARTMENT_MEMBERSHIP_REASON_INVALID: 400,
  DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID: 400,
  DEPARTMENT_MEMBERSHIP_NOT_FOUND: 404,
  TARGET_ACCOUNT_NOT_FOUND: 404,
  TARGET_ACCOUNT_DISABLED: 409,
  DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT: 409,
  DEPARTMENT_MEMBERSHIP_OVERLAP: 409,
  DEPARTMENT_MEMBERSHIP_ALREADY_ENDED: 409,
  DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS: 409,
  DUPLICATE_CODE: 409,
  VERSION_CONFLICT: 409,
  PERSON_NOT_FOUND: 404,
  PERSON_INACTIVE: 409,
  PERSON_ALREADY_IN_DEPARTMENT: 409,
  PERSON_ALREADY_IN_OTHER_DEPARTMENT: 409,
  PERSON_IS_ACTIVE_DEPARTMENT_HEAD: 409,
  PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT: 409,
  HEAD_ALREADY_ENDED: 409,
  CLIENT_SCHEDULE_FIELD_FORBIDDEN: 400,
  CLIENT_AUTHORITY_FIELD_FORBIDDEN: 400,
  ORG_VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_MISMATCH: 400,
  IDEMPOTENCY_CONFLICT: 409,
  DEPARTMENT_UNAVAILABLE: 503,
};

export function departmentHttpStatusForError(code: DepartmentErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export type DepartmentActiveHeadProjection = {
  head_assignment_id: string;
  person_id: string;
  employee_code: string;
  full_name: string;
  started_at: string;
  version: number;
};

export type DepartmentProjection = {
  department_id: string;
  system_key: DepartmentSystemKey | null;
  code: string;
  name: string;
  is_active: boolean;
  version: number;
  membership_mode: DepartmentMembershipMode;
  default_policy_code: DepartmentDefaultPolicyCode;
  active_member_count: number;
  team_count: number | null;
  active_team_count: number | null;
  active_head: DepartmentActiveHeadProjection | null;
  created_at: string;
  updated_at: string;
};

export type DepartmentListProjection = {
  authorization_date: string;
  as_of: string;
  departments: readonly DepartmentProjection[];
};

export type DepartmentDetailProjection = {
  authorization_date: string;
  as_of: string;
  department: DepartmentProjection;
};

export type AccountingMembershipProjection = {
  membership_id: string;
  department_id: string;
  account_ref: string;
  display_name: string;
  login_id: string | null;
  personnel_code: string | null;
  account_enabled: boolean;
  valid_from: string;
  valid_to: string | null;
  state: DepartmentMembershipState;
  effective: boolean;
  version: number;
  pair_version: number;
  granted_by_display_name: string;
  revoked_by_display_name: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountingMembershipListProjection = {
  authorization_date: string;
  department_id: string;
  include_history: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  memberships: readonly AccountingMembershipProjection[];
};

export type AccountingCandidateProjection = {
  account_ref: string;
  display_name: string;
  login_id: string | null;
  personnel_code: string | null;
  account_enabled: boolean;
  has_active_membership: boolean;
  open_membership_id: string | null;
  pair_version: number;
};

export type AccountingCandidateListProjection = {
  authorization_date: string;
  department_id: string;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  candidates: readonly AccountingCandidateProjection[];
};

export type AccountingMembershipMutationProjection = {
  replayed: boolean;
  membership: AccountingMembershipProjection;
};

export type RecruitmentTeamProjection = {
  team_id: string;
  code: string;
  display_name: string;
  active: boolean;
  version: number;
};

export type RecruitmentTeamListProjection = {
  authorization_date: string;
  department_id: string;
  system_key: "RECRUITMENT";
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  teams: readonly RecruitmentTeamProjection[];
};

export type ParsedAccountingMembershipsQuery = {
  search: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export type ParsedAccountingCandidatesQuery = {
  search: string | null;
  page: number;
  page_size: number;
};

export type ParsedRecruitmentTeamsQuery = {
  search: string | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
};

export type ParsedAssignAccountingMemberBody = {
  account_ref: string;
  expected_pair_version: number;
  effective_from: string | null;
  reason: string;
  idempotency_key: string;
};

export type ParsedEndAccountingMemberBody = {
  membership_id: string;
  expected_pair_version: number;
  effective_to: string | null;
  reason: string;
  idempotency_key: string;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: DepartmentErrorCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((key) => expectedSet.has(key));
}

function hasAllowedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  if (!actual.every((key) => allowed.has(key))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function isValidIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function isIsoUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_UTC_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyDisplayString(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !SEARCH_CONTROL_CHAR_PATTERN.test(value)
  );
}

function isNullableShortToken(value: unknown, maxLength = 128): value is string | null {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !SEARCH_CONTROL_CHAR_PATTERN.test(value) &&
    !value.includes("@")
  );
}

function collectSingleQueryParams(
  url: URL,
  allowedKeys: ReadonlySet<string>,
): Map<string, string> | null {
  const seen = new Map<string, string>();
  for (const [key, val] of url.searchParams.entries()) {
    if (!allowedKeys.has(key) || seen.has(key)) {
      return null;
    }
    seen.set(key, val);
  }
  return seen;
}

function parsePaginationParams(
  params: Map<string, string>,
): { ok: true; page: number; page_size: number } | { ok: false; code: DepartmentErrorCode } {
  const rawPage = params.get("page");
  const rawPageSize = params.get("page_size");

  let page = 1;
  if (rawPage !== undefined) {
    if (!/^\d+$/.test(rawPage)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    page = Number(rawPage);
    if (!Number.isSafeInteger(page) || page < 1 || page > DEPARTMENT_MAX_PAGE) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }

  let pageSize = DEPARTMENT_DEFAULT_PAGE_SIZE;
  if (rawPageSize !== undefined) {
    if (!/^\d+$/.test(rawPageSize)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    pageSize = Number(rawPageSize);
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > DEPARTMENT_MAX_PAGE_SIZE
    ) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }

  return { ok: true, page, page_size: pageSize };
}

function parseOptionalSearchParam(
  rawSearch: string | undefined,
): { ok: true; search: string | null } | { ok: false; code: DepartmentErrorCode } {
  if (rawSearch === undefined) {
    return { ok: true, search: null };
  }
  const trimmed = rawSearch.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > DEPARTMENT_MAX_SEARCH_LENGTH ||
    SEARCH_CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return { ok: false, code: "DEPARTMENT_SEARCH_INVALID" };
  }
  return { ok: true, search: trimmed };
}

export function parseListDepartmentsQuery(url: URL): ParseResult<{
  include_inactive: boolean;
  as_of: string | null;
}> {
  const params = collectSingleQueryParams(url, new Set(["include_inactive", "as_of"]));
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  let includeInactive = true;
  const rawIncludeInactive = params.get("include_inactive");
  if (rawIncludeInactive !== undefined) {
    if (rawIncludeInactive === "true") {
      includeInactive = true;
    } else if (rawIncludeInactive === "false") {
      includeInactive = false;
    } else {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }
  const rawAsOf = params.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== undefined && rawAsOf !== "") {
    if (!isIsoUtcTimestamp(rawAsOf)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    asOf = new Date(rawAsOf).toISOString();
  }
  return { ok: true, value: { include_inactive: includeInactive, as_of: asOf } };
}

export function parseDepartmentIdParam(rawId: unknown, url: URL): ParseResult<string> {
  if (url.search.length > 0) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const id = normalizeUuid(rawId);
  if (!id) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  return { ok: true, value: id };
}

export function parseGetDepartmentParams(
  rawId: unknown,
  url: URL,
): ParseResult<{ department_id: string; as_of: string | null }> {
  const params = collectSingleQueryParams(url, new Set(["as_of"]));
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const id = normalizeUuid(rawId);
  if (!id) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const rawAsOf = params.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== undefined && rawAsOf !== "") {
    if (!isIsoUtcTimestamp(rawAsOf)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    asOf = new Date(rawAsOf).toISOString();
  }
  return { ok: true, value: { department_id: id, as_of: asOf } };
}

export function parseListAccountingMembershipsQuery(
  url: URL,
): ParseResult<ParsedAccountingMembershipsQuery> {
  const params = collectSingleQueryParams(
    url,
    new Set(["search", "include_history", "page", "page_size"]),
  );
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }

  let includeHistory = false;
  const rawHistory = params.get("include_history");
  if (rawHistory !== undefined) {
    if (rawHistory === "true") {
      includeHistory = true;
    } else if (rawHistory === "false") {
      includeHistory = false;
    } else {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }

  const searchResult = parseOptionalSearchParam(params.get("search"));
  if (!searchResult.ok) return searchResult;

  const pagination = parsePaginationParams(params);
  if (!pagination.ok) return pagination;

  return {
    ok: true,
    value: {
      search: searchResult.search,
      include_history: includeHistory,
      page: pagination.page,
      page_size: pagination.page_size,
    },
  };
}

export function parseListAccountingCandidatesQuery(
  url: URL,
): ParseResult<ParsedAccountingCandidatesQuery> {
  const params = collectSingleQueryParams(url, new Set(["search", "page", "page_size"]));
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }

  const searchResult = parseOptionalSearchParam(params.get("search"));
  if (!searchResult.ok) return searchResult;

  const pagination = parsePaginationParams(params);
  if (!pagination.ok) return pagination;

  return {
    ok: true,
    value: {
      search: searchResult.search,
      page: pagination.page,
      page_size: pagination.page_size,
    },
  };
}

export function parseListRecruitmentTeamsQuery(
  url: URL,
): ParseResult<ParsedRecruitmentTeamsQuery> {
  const params = collectSingleQueryParams(
    url,
    new Set(["search", "include_inactive", "page", "page_size"]),
  );
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }

  let includeInactive = true;
  const rawIncludeInactive = params.get("include_inactive");
  if (rawIncludeInactive !== undefined) {
    if (rawIncludeInactive === "true") {
      includeInactive = true;
    } else if (rawIncludeInactive === "false") {
      includeInactive = false;
    } else {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }

  const searchResult = parseOptionalSearchParam(params.get("search"));
  if (!searchResult.ok) return searchResult;

  const pagination = parsePaginationParams(params);
  if (!pagination.ok) return pagination;

  return {
    ok: true,
    value: {
      search: searchResult.search,
      include_inactive: includeInactive,
      page: pagination.page,
      page_size: pagination.page_size,
    },
  };
}

function parseReasonField(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > DEPARTMENT_MAX_REASON_LENGTH ||
    REASON_CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function parseWp3ReasonField(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > WP3_MAX_REASON_LENGTH ||
    REASON_CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function parseMatchedIdempotencyKey(
  headerValue: string | null,
  bodyValue: unknown,
): string | null {
  if (typeof headerValue !== "string") return null;
  const headerUuid = normalizeUuid(headerValue.trim());
  const bodyUuid = normalizeUuid(bodyValue);
  if (!headerUuid || !bodyUuid || headerUuid !== bodyUuid) {
    return null;
  }
  return bodyUuid;
}

function parseWp3MatchedIdempotencyKey(
  headerValue: string | null,
  bodyValue: unknown,
):
  | { ok: true; value: string }
  | { ok: false; code: "IDEMPOTENCY_KEY_INVALID" | "IDEMPOTENCY_KEY_MISMATCH" } {
  if (typeof headerValue !== "string") {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  const headerUuid = normalizeUuid(headerValue.trim());
  const bodyUuid = normalizeUuid(bodyValue);
  if (!headerUuid || !bodyUuid) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  if (headerUuid !== bodyUuid) {
    return { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" };
  }
  return { ok: true, value: bodyUuid };
}

function resolveDepartmentBusinessTodayVn(todayVn?: string | null): string {
  if (typeof todayVn === "string" && isValidIsoCalendarDate(todayVn)) {
    return todayVn;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function parseAssignAccountingMemberBody(
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
): ParseResult<ParsedAssignAccountingMemberBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const clientCheck = validateClientBusinessPayload(body);
  if (!clientCheck.ok) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  if (
    !hasAllowedKeys(
      body,
      ["account_ref", "expected_pair_version", "reason", "idempotency_key"],
      ["effective_from"],
    )
  ) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const idempotencyKey = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  const accountRef = normalizeUuid(body.account_ref);
  if (!accountRef) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  if (!isSafeNonNegativeInt(body.expected_pair_version)) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const businessToday = resolveDepartmentBusinessTodayVn(todayVn);
  let effectiveFrom: string | null = null;
  if (
    Object.prototype.hasOwnProperty.call(body, "effective_from") &&
    body.effective_from !== null
  ) {
    if (!isValidIsoCalendarDate(body.effective_from) || body.effective_from !== businessToday) {
      return { ok: false, code: "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID" };
    }
    effectiveFrom = body.effective_from;
  }

  const reason = parseReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_REASON_INVALID" };
  }

  return {
    ok: true,
    value: {
      account_ref: accountRef,
      expected_pair_version: body.expected_pair_version,
      effective_from: effectiveFrom,
      reason,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseEndAccountingMemberBody(
  membershipIdParam: unknown,
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
): ParseResult<ParsedEndAccountingMemberBody> {
  const membershipId = normalizeUuid(membershipIdParam);
  if (!membershipId) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  if (!isRecord(body)) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const clientCheck = validateClientBusinessPayload(body);
  if (!clientCheck.ok) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  if (
    !hasAllowedKeys(
      body,
      ["expected_pair_version", "reason", "idempotency_key"],
      ["effective_to"],
    )
  ) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const idempotencyKey = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  if (!isSafePositiveInt(body.expected_pair_version)) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID" };
  }

  const businessToday = resolveDepartmentBusinessTodayVn(todayVn);
  let effectiveTo: string | null = null;
  if (
    Object.prototype.hasOwnProperty.call(body, "effective_to") &&
    body.effective_to !== null
  ) {
    if (!isValidIsoCalendarDate(body.effective_to) || body.effective_to !== businessToday) {
      return { ok: false, code: "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID" };
    }
    effectiveTo = body.effective_to;
  }

  const reason = parseReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "DEPARTMENT_MEMBERSHIP_REASON_INVALID" };
  }

  return {
    ok: true,
    value: {
      membership_id: membershipId,
      expected_pair_version: body.expected_pair_version,
      effective_to: effectiveTo,
      reason,
      idempotency_key: idempotencyKey,
    },
  };
}

export function computeAssignAccountingMemberFingerprint(input: {
  actor_app_user_id: string;
  account_ref: string;
  expected_pair_version: number;
  effective_from: string | null;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "ACCOUNTING_MEMBER_ASSIGNED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    account_ref: input.account_ref.toLowerCase(),
    expected_pair_version: input.expected_pair_version,
    effective_from: input.effective_from,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeEndAccountingMemberFingerprint(input: {
  actor_app_user_id: string;
  membership_id: string;
  expected_pair_version: number;
  effective_to: string | null;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "ACCOUNTING_MEMBER_ENDED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    membership_id: input.membership_id.toLowerCase(),
    expected_pair_version: input.expected_pair_version,
    effective_to: input.effective_to,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

const DEPARTMENT_PROJECTION_KEYS = [
  "department_id",
  "system_key",
  "code",
  "name",
  "is_active",
  "version",
  "membership_mode",
  "default_policy_code",
  "active_member_count",
  "team_count",
  "active_team_count",
  "active_head",
  "created_at",
  "updated_at",
] as const;

export function projectDepartmentActiveHead(
  value: unknown,
): DepartmentActiveHeadProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "head_assignment_id",
      "person_id",
      "employee_code",
      "full_name",
      "started_at",
      "version",
    ])
  ) {
    return null;
  }
  const headAssignmentId = normalizeUuid(value.head_assignment_id);
  const personId = normalizeUuid(value.person_id);
  if (
    !headAssignmentId ||
    !personId ||
    !isNonEmptyDisplayString(value.employee_code, 64) ||
    !isNonEmptyDisplayString(value.full_name, 160) ||
    !isIsoUtcTimestamp(value.started_at) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    head_assignment_id: headAssignmentId,
    person_id: personId,
    employee_code: value.employee_code,
    full_name: value.full_name,
    started_at: value.started_at,
    version: value.version,
  };
}

export function projectDepartmentItem(value: unknown): DepartmentProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, DEPARTMENT_PROJECTION_KEYS)) {
    return null;
  }

  const departmentId = normalizeUuid(value.department_id);
  const systemKey = value.system_key;
  const code = value.code;
  const name = value.name;
  const isActive = value.is_active;
  const version = value.version;
  const membershipMode = value.membership_mode;
  const defaultPolicyCode = value.default_policy_code;
  const activeMemberCount = value.active_member_count;
  const teamCount = value.team_count;
  const activeTeamCount = value.active_team_count;
  const rawActiveHead = value.active_head;
  const createdAt = value.created_at;
  const updatedAt = value.updated_at;

  const isValidSystemKey =
    systemKey === null ||
    (typeof systemKey === "string" &&
      (DEPARTMENT_SYSTEM_KEYS as readonly string[]).includes(systemKey));

  if (
    !departmentId ||
    !isValidSystemKey ||
    typeof code !== "string" ||
    !DEPARTMENT_CODE_PATTERN.test(code) ||
    !isNonEmptyDisplayString(name, 256) ||
    typeof isActive !== "boolean" ||
    !isSafePositiveInt(version) ||
    !isSafeNonNegativeInt(activeMemberCount) ||
    !isIsoUtcTimestamp(createdAt) ||
    !isIsoUtcTimestamp(updatedAt)
  ) {
    return null;
  }

  const activeHead =
    rawActiveHead === null ? null : projectDepartmentActiveHead(rawActiveHead);
  if (rawActiveHead !== null && !activeHead) {
    return null;
  }

  if (systemKey === "RECRUITMENT") {
    if (
      membershipMode !== "MANAGED_MEMBERSHIP_AND_TEAMS" ||
      defaultPolicyCode !== "EXISTING_TEAM_AUTHORITY_READ_ONLY" ||
      !isSafeNonNegativeInt(teamCount) ||
      !isSafeNonNegativeInt(activeTeamCount) ||
      activeTeamCount > teamCount
    ) {
      return null;
    }
  } else if (systemKey === "ACCOUNTING") {
    if (
      membershipMode !== "MANAGED_MEMBERSHIP" ||
      defaultPolicyCode !== "VENDOR_FINANCE_VIEW_AND_RECORD" ||
      teamCount !== null ||
      activeTeamCount !== null
    ) {
      return null;
    }
  } else {
    if (
      membershipMode !== "MANAGED_MEMBERSHIP" ||
      defaultPolicyCode !== "ORGANIZATIONAL_MEMBERSHIP_ONLY" ||
      teamCount !== null ||
      activeTeamCount !== null
    ) {
      return null;
    }
  }

  return {
    department_id: departmentId,
    system_key: systemKey as DepartmentSystemKey | null,
    code,
    name,
    is_active: isActive,
    version,
    membership_mode: membershipMode,
    default_policy_code: defaultPolicyCode,
    active_member_count: activeMemberCount,
    team_count: teamCount,
    active_team_count: activeTeamCount,
    active_head: activeHead,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function projectDepartmentListResponse(value: unknown): DepartmentListProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["authorization_date", "as_of", "departments"])) {
    return null;
  }
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !isIsoUtcTimestamp(value.as_of) ||
    !Array.isArray(value.departments)
  ) {
    return null;
  }

  const departments: DepartmentProjection[] = [];
  for (const item of value.departments) {
    const projected = projectDepartmentItem(item);
    if (!projected) return null;
    departments.push(projected);
  }

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    departments,
  };
}

export function projectDepartmentDetailResponse(value: unknown): DepartmentDetailProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["authorization_date", "as_of", "department"])) {
    return null;
  }
  if (!isValidIsoCalendarDate(value.authorization_date) || !isIsoUtcTimestamp(value.as_of)) {
    return null;
  }
  const department = projectDepartmentItem(value.department);
  if (!department) return null;

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    department,
  };
}

const MEMBERSHIP_PROJECTION_KEYS = [
  "membership_id",
  "department_id",
  "account_ref",
  "display_name",
  "login_id",
  "personnel_code",
  "account_enabled",
  "valid_from",
  "valid_to",
  "state",
  "effective",
  "version",
  "pair_version",
  "granted_by_display_name",
  "revoked_by_display_name",
  "revoked_at",
  "created_at",
  "updated_at",
] as const;

export function projectAccountingMembershipItem(
  value: unknown,
): AccountingMembershipProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, MEMBERSHIP_PROJECTION_KEYS)) {
    return null;
  }

  const membershipId = normalizeUuid(value.membership_id);
  const departmentId = normalizeUuid(value.department_id);
  const accountRef = normalizeUuid(value.account_ref);
  const displayName = value.display_name;
  const loginId = value.login_id;
  const personnelCode = value.personnel_code;
  const accountEnabled = value.account_enabled;
  const validFrom = value.valid_from;
  const validTo = value.valid_to;
  const state = value.state;
  const effective = value.effective;
  const version = value.version;
  const pairVersion = value.pair_version;
  const grantedByDisplayName = value.granted_by_display_name;
  const revokedByDisplayName = value.revoked_by_display_name;
  const revokedAt = value.revoked_at;
  const createdAt = value.created_at;
  const updatedAt = value.updated_at;

  if (
    !membershipId ||
    !departmentId ||
    !accountRef ||
    !isNonEmptyDisplayString(displayName, 256) ||
    !isNullableShortToken(loginId, 128) ||
    !isNullableShortToken(personnelCode, 128) ||
    typeof accountEnabled !== "boolean" ||
    !isValidIsoCalendarDate(validFrom) ||
    (validTo !== null && !isValidIsoCalendarDate(validTo)) ||
    (state !== "CURRENT" && state !== "SCHEDULED" && state !== "HISTORY") ||
    typeof effective !== "boolean" ||
    !isSafePositiveInt(version) ||
    !isSafePositiveInt(pairVersion) ||
    pairVersion < version ||
    !isNonEmptyDisplayString(grantedByDisplayName, 256) ||
    (revokedByDisplayName !== null && !isNonEmptyDisplayString(revokedByDisplayName, 256)) ||
    (revokedAt !== null && !isIsoUtcTimestamp(revokedAt)) ||
    !isIsoUtcTimestamp(createdAt) ||
    !isIsoUtcTimestamp(updatedAt)
  ) {
    return null;
  }

  if (validTo === null) {
    if (revokedAt !== null || revokedByDisplayName !== null || state === "HISTORY") {
      return null;
    }
  } else {
    if (validTo < validFrom || revokedAt === null || revokedByDisplayName === null) {
      return null;
    }
  }

  if (effective && state !== "CURRENT") {
    return null;
  }

  return {
    membership_id: membershipId,
    department_id: departmentId,
    account_ref: accountRef,
    display_name: displayName,
    login_id: loginId,
    personnel_code: personnelCode,
    account_enabled: accountEnabled,
    valid_from: validFrom,
    valid_to: validTo,
    state,
    effective,
    version,
    pair_version: pairVersion,
    granted_by_display_name: grantedByDisplayName,
    revoked_by_display_name: revokedByDisplayName,
    revoked_at: revokedAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function projectAccountingMembershipListResponse(
  value: unknown,
): AccountingMembershipListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "department_id",
      "include_history",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "memberships",
    ])
  ) {
    return null;
  }

  const departmentId = normalizeUuid(value.department_id);
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !departmentId ||
    typeof value.include_history !== "boolean" ||
    (value.search !== null &&
      !isNonEmptyDisplayString(value.search, DEPARTMENT_MAX_SEARCH_LENGTH)) ||
    !isSafePositiveInt(value.page) ||
    value.page > DEPARTMENT_MAX_PAGE ||
    !isSafePositiveInt(value.page_size) ||
    value.page_size > DEPARTMENT_MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.memberships) ||
    value.memberships.length > value.page_size
  ) {
    return null;
  }

  const memberships: AccountingMembershipProjection[] = [];
  for (const raw of value.memberships) {
    const item = projectAccountingMembershipItem(raw);
    if (!item || item.department_id !== departmentId) return null;
    memberships.push(item);
  }

  return {
    authorization_date: value.authorization_date,
    department_id: departmentId,
    include_history: value.include_history,
    search: value.search,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    memberships,
  };
}

export function projectAccountingCandidateItem(
  value: unknown,
): AccountingCandidateProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "account_ref",
      "display_name",
      "login_id",
      "personnel_code",
      "account_enabled",
      "has_active_membership",
      "open_membership_id",
      "pair_version",
    ])
  ) {
    return null;
  }

  const accountRef = normalizeUuid(value.account_ref);
  const openMembershipId =
    value.open_membership_id === null ? null : normalizeUuid(value.open_membership_id);

  if (
    !accountRef ||
    !isNonEmptyDisplayString(value.display_name, 256) ||
    !isNullableShortToken(value.login_id, 128) ||
    !isNullableShortToken(value.personnel_code, 128) ||
    typeof value.account_enabled !== "boolean" ||
    typeof value.has_active_membership !== "boolean" ||
    (value.open_membership_id !== null && !openMembershipId) ||
    !isSafeNonNegativeInt(value.pair_version)
  ) {
    return null;
  }

  if (value.has_active_membership && openMembershipId === null) {
    return null;
  }

  return {
    account_ref: accountRef,
    display_name: value.display_name,
    login_id: value.login_id,
    personnel_code: value.personnel_code,
    account_enabled: value.account_enabled,
    has_active_membership: value.has_active_membership,
    open_membership_id: openMembershipId,
    pair_version: value.pair_version,
  };
}

export function projectAccountingCandidateListResponse(
  value: unknown,
): AccountingCandidateListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "department_id",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "candidates",
    ])
  ) {
    return null;
  }

  const departmentId = normalizeUuid(value.department_id);
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !departmentId ||
    (value.search !== null &&
      !isNonEmptyDisplayString(value.search, DEPARTMENT_MAX_SEARCH_LENGTH)) ||
    !isSafePositiveInt(value.page) ||
    value.page > DEPARTMENT_MAX_PAGE ||
    !isSafePositiveInt(value.page_size) ||
    value.page_size > DEPARTMENT_MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > value.page_size
  ) {
    return null;
  }

  const candidates: AccountingCandidateProjection[] = [];
  for (const raw of value.candidates) {
    const item = projectAccountingCandidateItem(raw);
    if (!item) return null;
    candidates.push(item);
  }

  return {
    authorization_date: value.authorization_date,
    department_id: departmentId,
    search: value.search,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    candidates,
  };
}

export function projectAccountingMembershipMutationResponse(
  value: unknown,
): AccountingMembershipMutationProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "membership"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean") {
    return null;
  }
  const membership = projectAccountingMembershipItem(value.membership);
  if (!membership) {
    return null;
  }
  return {
    replayed: value.replayed,
    membership,
  };
}

export function projectRecruitmentTeamsResponse(
  value: unknown,
): RecruitmentTeamListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "department_id",
      "system_key",
      "include_inactive",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "teams",
    ])
  ) {
    return null;
  }

  const departmentId = normalizeUuid(value.department_id);
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !departmentId ||
    value.system_key !== "RECRUITMENT" ||
    typeof value.include_inactive !== "boolean" ||
    (value.search !== null &&
      !isNonEmptyDisplayString(value.search, DEPARTMENT_MAX_SEARCH_LENGTH)) ||
    !isSafePositiveInt(value.page) ||
    value.page > DEPARTMENT_MAX_PAGE ||
    !isSafePositiveInt(value.page_size) ||
    value.page_size > DEPARTMENT_MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.teams) ||
    value.teams.length > value.page_size
  ) {
    return null;
  }

  const teams: RecruitmentTeamProjection[] = [];
  for (const raw of value.teams) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["team_id", "code", "display_name", "active", "version"])
    ) {
      return null;
    }
    const teamId = normalizeUuid(raw.team_id);
    if (
      !teamId ||
      typeof raw.code !== "string" ||
      raw.code.trim().length === 0 ||
      raw.code === "__system_vendor__" ||
      SEARCH_CONTROL_CHAR_PATTERN.test(raw.code) ||
      !isNonEmptyDisplayString(raw.display_name, 256) ||
      typeof raw.active !== "boolean" ||
      !isSafePositiveInt(raw.version)
    ) {
      return null;
    }
    teams.push({
      team_id: teamId,
      code: raw.code,
      display_name: raw.display_name,
      active: raw.active,
      version: raw.version,
    });
  }

  return {
    authorization_date: value.authorization_date,
    department_id: departmentId,
    system_key: "RECRUITMENT",
    include_inactive: value.include_inactive,
    search: value.search,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    teams,
  };
}


export const DEPARTMENT_PERSON_MEMBERSHIP_STATUS_FILTERS = [
  "active",
  "ended",
  "all",
] as const;
export type DepartmentPersonMembershipStatusFilter =
  (typeof DEPARTMENT_PERSON_MEMBERSHIP_STATUS_FILTERS)[number];

export type PersonDeptMembershipProjection = {
  membership_id: string;
  department_id: string;
  person_id: string;
  employee_code: string;
  full_name: string;
  person_status: "ACTIVE" | "INACTIVE";
  person_version: number;
  active_account_ref: string | null;
  is_department_head: boolean;
  started_at: string;
  ended_at: string | null;
  source_kind: "ADMIN_MUTATION" | "BACKFILL_DATE_EVIDENCE" | "BACKFILL_CURRENT_STATE_ONLY";
  evidence_date: string | null;
  version: number;
};

export type DepartmentPersonMembershipsListProjection = {
  authorization_date: string;
  as_of: string;
  department_id: string;
  status: DepartmentPersonMembershipStatusFilter;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  memberships: PersonDeptMembershipProjection[];
};

export type DepartmentHeadProjection = {
  head_assignment_id: string;
  department_id: string;
  person_id: string;
  employee_code: string;
  full_name: string;
  started_at: string;
  ended_at: string | null;
  source_kind: "ADMIN_MUTATION" | "BACKFILL_DATE_EVIDENCE" | "BACKFILL_CURRENT_STATE_ONLY";
  evidence_date: string | null;
  version: number;
};

export type DepartmentHeadsListProjection = {
  authorization_date: string;
  as_of: string;
  department_id: string;
  include_history: boolean;
  active_head: DepartmentActiveHeadProjection | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  history: DepartmentHeadProjection[];
};

export type ParsedCreateDepartmentBody = {
  code: string;
  name: string;
  reason: string;
  idempotency_key: string;
};

export type ParsedUpdateDepartmentBody = {
  expected_department_version: number;
  name: string;
  is_active: boolean;
  reason: string;
  idempotency_key: string;
};

export type ParsedListDepartmentPersonMembershipsQuery = {
  department_id: string;
  status: DepartmentPersonMembershipStatusFilter;
  search: string | null;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type ParsedAssignPersonMemberBody = {
  person_id: string;
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
};

export type ParsedEndPersonMemberBody = {
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
};

export type ParsedListDepartmentHeadsQuery = {
  department_id: string;
  include_history: boolean;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type ParsedDesignateHeadBody = {
  person_id: string;
  expected_department_version: number;
  expected_current_head_assignment_id: string | null;
  reason: string;
  idempotency_key: string;
};

export type ParsedEndHeadBody = {
  expected_department_version: number;
  expected_current_head_assignment_id: string;
  reason: string;
  idempotency_key: string;
};

const WP3_DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const WP3_SCHEDULE_FORBIDDEN_FIELDS = new Set([
  "started_at",
  "ended_at",
  "valid_from",
  "valid_to",
  "effective_from",
  "effective_to",
]);
const WP3_AUTHORITY_FORBIDDEN_TOKENS = new Set([
  "authsubject",
  "appuser",
  "appuserid",
  "actorid",
  "createdby",
  "createdbyuserid",
  "owner",
  "owneruserid",
  "actor",
  "role",
  "roles",
  "capability",
  "capabilities",
  "scope",
  "scopes",
  "scopekind",
  "team",
  "teamid",
  "provider",
  "providertype",
]);

function checkNoWp3ForbiddenObjectFields(
  obj: Record<string, unknown>,
): { ok: true } | { ok: false; code: DepartmentErrorCode } {
  for (const key of Object.keys(obj)) {
    if (WP3_SCHEDULE_FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      return { ok: false, code: "CLIENT_SCHEDULE_FIELD_FORBIDDEN" };
    }
    if (WP3_AUTHORITY_FORBIDDEN_TOKENS.has(key.replace(/[-_]/g, "").toLowerCase())) {
      return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
    }
  }
  return { ok: true };
}

export function parseCreateDepartmentBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedCreateDepartmentBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (!hasExactKeys(body, ["code", "name", "reason", "idempotency_key"])) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  if (typeof body.code !== "string") {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const trimmedCode = body.code.trim();
  if (!WP3_DEPARTMENT_CODE_PATTERN.test(trimmedCode)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  if (!isNonEmptyDisplayString(body.name, 256)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      code: trimmedCode,
      name: body.name.trim(),
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function parseUpdateDepartmentBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedUpdateDepartmentBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !hasExactKeys(body, [
      "expected_department_version",
      "name",
      "is_active",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  if (
    !isSafePositiveInt(body.expected_department_version) ||
    !isNonEmptyDisplayString(body.name, 256) ||
    typeof body.is_active !== "boolean"
  ) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      expected_department_version: body.expected_department_version,
      name: body.name.trim(),
      is_active: body.is_active,
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function parseListDepartmentPersonMembershipsQuery(
  rawDepartmentId: unknown,
  url: URL,
): ParseResult<ParsedListDepartmentPersonMembershipsQuery> {
  const departmentId = normalizeUuid(rawDepartmentId);
  if (!departmentId) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const params = collectSingleQueryParams(
    url,
    new Set(["status", "search", "as_of", "page", "page_size"]),
  );
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const rawStatus = params.get("status") ?? "active";
  if (!(DEPARTMENT_PERSON_MEMBERSHIP_STATUS_FILTERS as readonly string[]).includes(rawStatus)) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const searchResult = parseOptionalSearchParam(params.get("search"));
  if (!searchResult.ok) return searchResult;
  const pagination = parsePaginationParams(params);
  if (!pagination.ok) return pagination;
  const rawAsOf = params.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== undefined && rawAsOf !== "") {
    if (!isIsoUtcTimestamp(rawAsOf)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    asOf = new Date(rawAsOf).toISOString();
  }
  return {
    ok: true,
    value: {
      department_id: departmentId,
      status: rawStatus as DepartmentPersonMembershipStatusFilter,
      search: searchResult.search,
      as_of: asOf,
      page: pagination.page,
      page_size: pagination.page_size,
    },
  };
}

export function parseAssignPersonMemberBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedAssignPersonMemberBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (!hasExactKeys(body, ["person_id", "expected_person_version", "reason", "idempotency_key"])) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  const personId = normalizeUuid(body.person_id);
  if (!personId || !isSafePositiveInt(body.expected_person_version)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      person_id: personId,
      expected_person_version: body.expected_person_version,
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function parseEndPersonMemberBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedEndPersonMemberBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (!hasExactKeys(body, ["expected_person_version", "reason", "idempotency_key"])) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  if (!isSafePositiveInt(body.expected_person_version)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      expected_person_version: body.expected_person_version,
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function parseListDepartmentHeadsQuery(
  rawDepartmentId: unknown,
  url: URL,
): ParseResult<ParsedListDepartmentHeadsQuery> {
  const departmentId = normalizeUuid(rawDepartmentId);
  if (!departmentId) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const params = collectSingleQueryParams(
    url,
    new Set(["include_history", "as_of", "page", "page_size"]),
  );
  if (!params) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  let includeHistory = false;
  const rawHistory = params.get("include_history");
  if (rawHistory !== undefined) {
    if (rawHistory === "true") {
      includeHistory = true;
    } else if (rawHistory === "false") {
      includeHistory = false;
    } else {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
  }
  const pagination = parsePaginationParams(params);
  if (!pagination.ok) return pagination;
  const rawAsOf = params.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== undefined && rawAsOf !== "") {
    if (!isIsoUtcTimestamp(rawAsOf)) {
      return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
    }
    asOf = new Date(rawAsOf).toISOString();
  }
  return {
    ok: true,
    value: {
      department_id: departmentId,
      include_history: includeHistory,
      as_of: asOf,
      page: pagination.page,
      page_size: pagination.page_size,
    },
  };
}

export function parseDesignateHeadBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedDesignateHeadBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !hasExactKeys(body, [
      "person_id",
      "expected_department_version",
      "expected_current_head_assignment_id",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  const personId = normalizeUuid(body.person_id);
  if (!personId || !isSafePositiveInt(body.expected_department_version)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  let expectedHeadId: string | null = null;
  if (body.expected_current_head_assignment_id !== null) {
    const normalized = normalizeUuid(body.expected_current_head_assignment_id);
    if (!normalized) {
      return { ok: false, code: "ORG_VALIDATION_ERROR" };
    }
    expectedHeadId = normalized;
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      person_id: personId,
      expected_department_version: body.expected_department_version,
      expected_current_head_assignment_id: expectedHeadId,
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function parseEndHeadBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<ParsedEndHeadBody> {
  if (!isRecord(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const forbidden = checkNoWp3ForbiddenObjectFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !hasExactKeys(body, [
      "expected_department_version",
      "expected_current_head_assignment_id",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const idem = parseWp3MatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) {
    return { ok: false, code: idem.code };
  }
  const expectedHeadId = normalizeUuid(body.expected_current_head_assignment_id);
  if (!isSafePositiveInt(body.expected_department_version) || !expectedHeadId) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  const reason = parseWp3ReasonField(body.reason);
  if (!reason) {
    return { ok: false, code: "ORG_VALIDATION_ERROR" };
  }
  return {
    ok: true,
    value: {
      expected_department_version: body.expected_department_version,
      expected_current_head_assignment_id: expectedHeadId,
      reason,
      idempotency_key: idem.value,
    },
  };
}

export function computeCreateDepartmentFingerprint(input: {
  actor_app_user_id: string;
  code: string;
  name: string;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "DEPT_CREATED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    code: input.code,
    name: input.name,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeUpdateDepartmentFingerprint(input: {
  actor_app_user_id: string;
  department_id: string;
  expected_department_version: number;
  name: string;
  is_active: boolean;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "DEPT_UPDATED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    department_id: input.department_id.toLowerCase(),
    expected_department_version: input.expected_department_version,
    name: input.name,
    is_active: input.is_active,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeAssignPersonMemberFingerprint(input: {
  actor_app_user_id: string;
  department_id: string;
  person_id: string;
  expected_person_version: number;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "PERSON_DEPT_ASSIGNED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    department_id: input.department_id.toLowerCase(),
    person_id: input.person_id.toLowerCase(),
    expected_person_version: input.expected_person_version,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeEndPersonMemberFingerprint(input: {
  actor_app_user_id: string;
  department_id: string;
  membership_id: string;
  expected_person_version: number;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "PERSON_DEPT_ENDED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    department_id: input.department_id.toLowerCase(),
    membership_id: input.membership_id.toLowerCase(),
    expected_person_version: input.expected_person_version,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeDesignateHeadFingerprint(input: {
  actor_app_user_id: string;
  department_id: string;
  person_id: string;
  expected_department_version: number;
  expected_current_head_assignment_id: string | null;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "DEPT_HEAD_DESIGNATED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    department_id: input.department_id.toLowerCase(),
    person_id: input.person_id.toLowerCase(),
    expected_department_version: input.expected_department_version,
    expected_current_head_assignment_id:
      input.expected_current_head_assignment_id?.toLowerCase() ?? null,
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function computeEndHeadFingerprint(input: {
  actor_app_user_id: string;
  department_id: string;
  expected_department_version: number;
  expected_current_head_assignment_id: string;
  reason: string;
}): string {
  const canonical = JSON.stringify({
    v: 1,
    op: "DEPT_HEAD_ENDED",
    actor_app_user_id: input.actor_app_user_id.toLowerCase(),
    department_id: input.department_id.toLowerCase(),
    expected_department_version: input.expected_department_version,
    expected_current_head_assignment_id:
      input.expected_current_head_assignment_id.toLowerCase(),
    reason: input.reason,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function parseDepartmentPersonMembershipParams(
  rawDepartmentId: unknown,
  rawMembershipId: unknown,
  url: URL,
): ParseResult<{ department_id: string; membership_id: string }> {
  if (url.search.length > 0) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  const departmentId = normalizeUuid(rawDepartmentId);
  const membershipId = normalizeUuid(rawMembershipId);
  if (!departmentId || !membershipId) {
    return { ok: false, code: "DEPARTMENT_QUERY_INVALID" };
  }
  return {
    ok: true,
    value: {
      department_id: departmentId,
      membership_id: membershipId,
    },
  };
}

export type DepartmentMutationProjection = {
  replayed: boolean;
  department: DepartmentProjection;
};

export type DepartmentPersonMemberMutationProjection = {
  replayed: boolean;
  person_version: number;
  membership: PersonDeptMembershipProjection;
};

export type DesignateDepartmentHeadProjection = {
  replayed: boolean;
  department_version: number;
  replaced_head: {
    head_assignment_id: string;
    person_id: string;
    ended_at: string;
    version: number;
  } | null;
  active_head: DepartmentHeadProjection;
};

export type EndDepartmentHeadProjection = {
  replayed: boolean;
  department_version: number;
  ended_head: DepartmentHeadProjection;
};

const PERSON_SOURCE_KINDS_SET = new Set([
  "ADMIN_MUTATION",
  "BACKFILL_DATE_EVIDENCE",
  "BACKFILL_CURRENT_STATE_ONLY",
]);

function isValidPersonSourceKind(
  value: unknown,
): value is PersonDeptMembershipProjection["source_kind"] {
  return typeof value === "string" && PERSON_SOURCE_KINDS_SET.has(value);
}

export function projectDepartmentMutationResponse(
  value: unknown,
): DepartmentMutationProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "department"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean") {
    return null;
  }
  const department = projectDepartmentItem(value.department);
  if (!department) {
    return null;
  }
  return {
    replayed: value.replayed,
    department,
  };
}

export function projectPersonDeptMembershipItem(
  value: unknown,
): PersonDeptMembershipProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "membership_id",
      "department_id",
      "person_id",
      "employee_code",
      "full_name",
      "person_status",
      "person_version",
      "active_account_ref",
      "is_department_head",
      "started_at",
      "ended_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  const membershipId = normalizeUuid(value.membership_id);
  const departmentId = normalizeUuid(value.department_id);
  const personId = normalizeUuid(value.person_id);
  const activeAccountRef =
    value.active_account_ref === null ? null : normalizeUuid(value.active_account_ref);

  if (
    !membershipId ||
    !departmentId ||
    !personId ||
    !isNonEmptyDisplayString(value.employee_code, 64) ||
    !isNonEmptyDisplayString(value.full_name, 160) ||
    (value.person_status !== "ACTIVE" && value.person_status !== "INACTIVE") ||
    !isSafePositiveInt(value.person_version) ||
    (value.active_account_ref !== null && !activeAccountRef) ||
    typeof value.is_department_head !== "boolean" ||
    !isIsoUtcTimestamp(value.started_at) ||
    (value.ended_at !== null && !isIsoUtcTimestamp(value.ended_at)) ||
    !isValidPersonSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoCalendarDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }

  return {
    membership_id: membershipId,
    department_id: departmentId,
    person_id: personId,
    employee_code: value.employee_code,
    full_name: value.full_name,
    person_status: value.person_status,
    person_version: value.person_version,
    active_account_ref: activeAccountRef,
    is_department_head: value.is_department_head,
    started_at: value.started_at,
    ended_at: value.ended_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

export function projectDepartmentPersonMembershipsListResponse(
  value: unknown,
): DepartmentPersonMembershipsListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "as_of",
      "department_id",
      "status",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "memberships",
    ])
  ) {
    return null;
  }
  const departmentId = normalizeUuid(value.department_id);
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !isIsoUtcTimestamp(value.as_of) ||
    !departmentId ||
    typeof value.status !== "string" ||
    !(DEPARTMENT_PERSON_MEMBERSHIP_STATUS_FILTERS as readonly string[]).includes(value.status) ||
    (value.search !== null &&
      !isNonEmptyDisplayString(value.search, DEPARTMENT_MAX_SEARCH_LENGTH)) ||
    !isSafePositiveInt(value.page) ||
    value.page > DEPARTMENT_MAX_PAGE ||
    !isSafePositiveInt(value.page_size) ||
    value.page_size > DEPARTMENT_MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.memberships) ||
    value.memberships.length > value.page_size
  ) {
    return null;
  }

  const memberships: PersonDeptMembershipProjection[] = [];
  for (const raw of value.memberships) {
    const item = projectPersonDeptMembershipItem(raw);
    if (!item || item.department_id !== departmentId) return null;
    memberships.push(item);
  }

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    department_id: departmentId,
    status: value.status as DepartmentPersonMembershipStatusFilter,
    search: value.search,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    memberships,
  };
}

export function projectDepartmentPersonMemberMutationResponse(
  value: unknown,
): DepartmentPersonMemberMutationProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "person_version", "membership"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isSafePositiveInt(value.person_version)) {
    return null;
  }
  const membership = projectPersonDeptMembershipItem(value.membership);
  if (!membership) return null;
  return {
    replayed: value.replayed,
    person_version: value.person_version,
    membership,
  };
}

export function projectDepartmentHeadItem(value: unknown): DepartmentHeadProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "head_assignment_id",
      "department_id",
      "person_id",
      "employee_code",
      "full_name",
      "started_at",
      "ended_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  const headAssignmentId = normalizeUuid(value.head_assignment_id);
  const departmentId = normalizeUuid(value.department_id);
  const personId = normalizeUuid(value.person_id);
  if (
    !headAssignmentId ||
    !departmentId ||
    !personId ||
    !isNonEmptyDisplayString(value.employee_code, 64) ||
    !isNonEmptyDisplayString(value.full_name, 160) ||
    !isIsoUtcTimestamp(value.started_at) ||
    (value.ended_at !== null && !isIsoUtcTimestamp(value.ended_at)) ||
    !isValidPersonSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoCalendarDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }

  return {
    head_assignment_id: headAssignmentId,
    department_id: departmentId,
    person_id: personId,
    employee_code: value.employee_code,
    full_name: value.full_name,
    started_at: value.started_at,
    ended_at: value.ended_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

export function projectDepartmentHeadsListResponse(
  value: unknown,
): DepartmentHeadsListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "as_of",
      "department_id",
      "include_history",
      "active_head",
      "page",
      "page_size",
      "total",
      "has_more",
      "history",
    ])
  ) {
    return null;
  }
  const departmentId = normalizeUuid(value.department_id);
  if (
    !isValidIsoCalendarDate(value.authorization_date) ||
    !isIsoUtcTimestamp(value.as_of) ||
    !departmentId ||
    typeof value.include_history !== "boolean" ||
    !isSafePositiveInt(value.page) ||
    value.page > DEPARTMENT_MAX_PAGE ||
    !isSafePositiveInt(value.page_size) ||
    value.page_size > DEPARTMENT_MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.history) ||
    value.history.length > value.page_size
  ) {
    return null;
  }

  let activeHead: DepartmentActiveHeadProjection | null = null;
  if (value.active_head !== null) {
    activeHead = projectDepartmentActiveHead(value.active_head);
    if (!activeHead) return null;
  }

  const history: DepartmentHeadProjection[] = [];
  for (const raw of value.history) {
    const item = projectDepartmentHeadItem(raw);
    if (!item || item.department_id !== departmentId) return null;
    history.push(item);
  }

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    department_id: departmentId,
    include_history: value.include_history,
    active_head: activeHead,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    history,
  };
}

export function projectDesignateDepartmentHeadResponse(
  value: unknown,
): DesignateDepartmentHeadProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["replayed", "department_version", "replaced_head", "active_head"])
  ) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isSafePositiveInt(value.department_version)) {
    return null;
  }

  let replacedHead: DesignateDepartmentHeadProjection["replaced_head"] = null;
  if (value.replaced_head !== null) {
    if (
      !isRecord(value.replaced_head) ||
      !hasExactKeys(value.replaced_head, [
        "head_assignment_id",
        "person_id",
        "ended_at",
        "version",
      ])
    ) {
      return null;
    }
    const headAssignmentId = normalizeUuid(value.replaced_head.head_assignment_id);
    const personId = normalizeUuid(value.replaced_head.person_id);
    if (
      !headAssignmentId ||
      !personId ||
      !isIsoUtcTimestamp(value.replaced_head.ended_at) ||
      !isSafePositiveInt(value.replaced_head.version)
    ) {
      return null;
    }
    replacedHead = {
      head_assignment_id: headAssignmentId,
      person_id: personId,
      ended_at: value.replaced_head.ended_at,
      version: value.replaced_head.version,
    };
  }

  const activeHead = projectDepartmentHeadItem(value.active_head);
  if (!activeHead) return null;

  return {
    replayed: value.replayed,
    department_version: value.department_version,
    replaced_head: replacedHead,
    active_head: activeHead,
  };
}

export function projectEndDepartmentHeadResponse(
  value: unknown,
): EndDepartmentHeadProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "department_version", "ended_head"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isSafePositiveInt(value.department_version)) {
    return null;
  }
  const endedHead = projectDepartmentHeadItem(value.ended_head);
  if (!endedHead || endedHead.ended_at === null) {
    return null;
  }
  return {
    replayed: value.replayed,
    department_version: value.department_version,
    ended_head: endedHead,
  };
}
