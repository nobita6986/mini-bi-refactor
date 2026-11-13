import { createHash } from "node:crypto";
import { ACCOUNT_TYPES, type AccountType } from "../direct-entry/app-user-access-contract.ts";

export { ACCOUNT_TYPES, type AccountType };

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/i;
export const EMPLOYEE_CODE_PROJECT_WORKER_PATTERN = /^hrp-\d{4}-\d{6}$/i;
export const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export const PERSON_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const PERSON_FILTER_STATUSES = ["active", "inactive", "all"] as const;
export type PersonFilterStatus = (typeof PERSON_FILTER_STATUSES)[number];

export const PERSON_LINK_STATES = ["all", "linked", "unlinked"] as const;
export type PersonLinkState = (typeof PERSON_LINK_STATES)[number];

export const PERSON_SOURCE_KINDS = [
  "ADMIN_MUTATION",
  "BACKFILL_DATE_EVIDENCE",
  "BACKFILL_CURRENT_STATE_ONLY",
] as const;
export type PersonSourceKind = (typeof PERSON_SOURCE_KINDS)[number];

export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;
export const SEARCH_MAX_LENGTH = 100;
export const MAX_ORG_PAGE = 1000;
export const DEFAULT_ORG_PAGE_SIZE = 25;
export const MAX_ORG_PAGE_SIZE = 100;
export const EMPLOYEE_CODE_MIN_LENGTH = 2;
export const EMPLOYEE_CODE_MAX_LENGTH = 64;
export const FULL_NAME_MIN_LENGTH = 1;
export const FULL_NAME_MAX_LENGTH = 160;

export const SCHEDULE_FORBIDDEN_FIELDS = new Set([
  "started_at",
  "ended_at",
  "valid_from",
  "valid_to",
  "effective_from",
  "effective_to",
]);

const FORBIDDEN_AUTHORITY_TOKENS = new Set([
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
  "effectivescope",
  "effectivescopes",
]);

export const ORGANIZATION_ERROR_CODES = [
  "INVALID_JSON",
  "CONTENT_TYPE_INVALID",
  "CLIENT_SCHEDULE_FIELD_FORBIDDEN",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_MISMATCH",
  "ORG_VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "CSRF_REJECTED",
  "ACTOR_NOT_AVAILABLE",
  "FORBIDDEN",
  "NOT_FOUND",
  "DEPARTMENT_NOT_FOUND",
  "PERSON_NOT_FOUND",
  "TARGET_ACCOUNT_NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "DUPLICATE_CODE",
  "PERSON_ALREADY_IN_DEPARTMENT",
  "PERSON_ALREADY_IN_OTHER_DEPARTMENT",
  "PERSON_IS_ACTIVE_DEPARTMENT_HEAD",
  "PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT",
  "PERSON_INACTIVE",
  "DEPARTMENT_INACTIVE",
  "RECRUITER_IDENTITY_CONFLICT",
  "RECRUITER_LINK_MISMATCH",
  "RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT",
  "ACCOUNT_TYPE_LINK_FORBIDDEN",
  "ACCOUNT_OR_PERSON_ALREADY_LINKED",
  "ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS",
  "DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS",
  "HEAD_ALREADY_ENDED",
  "LINK_ALREADY_ENDED",
  "SAME_TARGET_DEPARTMENT",
  "ORG_CONFLICT",
  "BODY_TOO_LARGE",
  "ORG_UNAVAILABLE",
] as const;

export type OrganizationErrorCode = (typeof ORGANIZATION_ERROR_CODES)[number];

export const ORGANIZATION_ERROR_HTTP_STATUS: Record<OrganizationErrorCode, number> = {
  INVALID_JSON: 400,
  CONTENT_TYPE_INVALID: 400,
  CLIENT_SCHEDULE_FIELD_FORBIDDEN: 400,
  CLIENT_AUTHORITY_FIELD_FORBIDDEN: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_KEY_MISMATCH: 400,
  ORG_VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  CSRF_REJECTED: 403,
  ACTOR_NOT_AVAILABLE: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DEPARTMENT_NOT_FOUND: 404,
  PERSON_NOT_FOUND: 404,
  TARGET_ACCOUNT_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DUPLICATE_CODE: 409,
  PERSON_ALREADY_IN_DEPARTMENT: 409,
  PERSON_ALREADY_IN_OTHER_DEPARTMENT: 409,
  PERSON_IS_ACTIVE_DEPARTMENT_HEAD: 409,
  PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT: 409,
  PERSON_INACTIVE: 409,
  DEPARTMENT_INACTIVE: 409,
  RECRUITER_IDENTITY_CONFLICT: 409,
  RECRUITER_LINK_MISMATCH: 409,
  RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT: 409,
  ACCOUNT_TYPE_LINK_FORBIDDEN: 409,
  ACCOUNT_OR_PERSON_ALREADY_LINKED: 409,
  ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS: 409,
  DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS: 409,
  HEAD_ALREADY_ENDED: 409,
  LINK_ALREADY_ENDED: 409,
  SAME_TARGET_DEPARTMENT: 409,
  ORG_CONFLICT: 409,
  BODY_TOO_LARGE: 413,
  ORG_UNAVAILABLE: 503,
};

export type PersonActiveAccountLinkProjection = {
  link_id: string;
  account_ref: string;
  login_id: string | null;
  display_name: string | null;
  enabled: boolean;
  account_version: number;
  started_at: string;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type PersonActiveDepartmentProjection = {
  membership_id: string;
  department_id: string;
  system_key: string | null;
  code: string;
  name: string;
  started_at: string;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type PersonDepartmentHistoryProjection = {
  membership_id: string;
  department_id: string;
  system_key: string | null;
  code: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type PersonHeadHistoryProjection = {
  head_assignment_id: string;
  department_id: string;
  system_key: string | null;
  code: string;
  name: string;
  started_at: string;
  ended_at: string | null;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type PersonSummaryProjection = {
  person_id: string;
  employee_code: string;
  full_name: string;
  status: PersonStatus;
  joined_on: string | null;
  recruiter_id: string | null;
  version: number;
  active_account_link: PersonActiveAccountLinkProjection | null;
  active_department: PersonActiveDepartmentProjection | null;
};

export type PersonDetailProjection = {
  person_id: string;
  employee_code: string;
  full_name: string;
  status: PersonStatus;
  joined_on: string | null;
  recruiter_id: string | null;
  version: number;
  active_account_link: PersonActiveAccountLinkProjection | null;
  active_department: PersonActiveDepartmentProjection | null;
  department_history: PersonDepartmentHistoryProjection[];
  head_assignments: PersonHeadHistoryProjection[];
};

export type ListPersonsResponse = {
  ok: true;
  authorization_date: string;
  as_of: string;
  search: string | null;
  status: PersonFilterStatus;
  department_id: string | null;
  link_state: PersonLinkState;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  persons: PersonSummaryProjection[];
};

export type GetPersonResponse = {
  ok: true;
  authorization_date: string;
  as_of: string;
  person: PersonDetailProjection;
};

export type MutatePersonResponse = {
  ok: true;
  replayed: boolean;
  person: PersonDetailProjection;
};

export type TransferPersonDepartmentResponse = {
  ok: true;
  replayed: boolean;
  person_version: number;
  closed_membership: {
    membership_id: string;
    department_id: string;
    started_at: string;
    ended_at: string;
    version: number;
  };
  active_membership: PersonDepartmentHistoryProjection;
};

export type SetAccountTypeResponse = {
  ok: true;
  replayed: boolean;
  account: {
    account_ref: string;
    account_type: AccountType;
    version: number;
  };
};

export type LinkAccountPersonResponse = {
  ok: true;
  replayed: boolean;
  account_version: number;
  person_version: number;
  link: {
    link_id: string;
    account_ref: string;
    person_id: string;
    employee_code: string;
    full_name: string;
    started_at: string;
    source_kind: PersonSourceKind;
    evidence_date: string | null;
    version: number;
  };
};

export type UnlinkAccountPersonResponse = {
  ok: true;
  replayed: boolean;
  account_version: number;
  person_version: number;
  ended_link: {
    link_id: string;
    account_ref: string;
    person_id: string;
    started_at: string;
    ended_at: string;
    version: number;
  };
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OrganizationErrorCode; message: string };

export function organizationErrorStatus(code: OrganizationErrorCode): number {
  return ORGANIZATION_ERROR_HTTP_STATUS[code] ?? 500;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function normalizeAuthorityKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

export function checkNoForbiddenClientFields(
  obj: Record<string, unknown>,
): { ok: true } | { ok: false; code: OrganizationErrorCode; message: string } {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SCHEDULE_FORBIDDEN_FIELDS.has(lower)) {
      return {
        ok: false,
        code: "CLIENT_SCHEDULE_FIELD_FORBIDDEN",
        message: "Trường thời điểm hiệu lực do máy chủ kiểm soát.",
      };
    }
    if (FORBIDDEN_AUTHORITY_TOKENS.has(normalizeAuthorityKey(key))) {
      return {
        ok: false,
        code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        message: "Không được truyền trường thẩm quyền từ client.",
      };
    }
  }
  return { ok: true };
}

export function parseSafeReason(
  value: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "Lý do thao tác là bắt buộc." };
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    return { ok: false, message: "Lý do không được chứa ký tự điều khiển." };
  }
  const trimmed = value.trim();
  if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
    return {
      ok: false,
      message: `Lý do phải từ ${REASON_MIN_LENGTH} đến ${REASON_MAX_LENGTH} ký tự.`,
    };
  }
  return { ok: true, value: trimmed };
}

export function parseEmployeeCode(
  value: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "Mã nhân sự nội bộ là bắt buộc." };
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    return { ok: false, message: "Mã nhân sự không được chứa ký tự điều khiển." };
  }
  const trimmed = value.trim();
  if (trimmed.length < EMPLOYEE_CODE_MIN_LENGTH || trimmed.length > EMPLOYEE_CODE_MAX_LENGTH) {
    return {
      ok: false,
      message: `Mã nhân sự phải từ ${EMPLOYEE_CODE_MIN_LENGTH} đến ${EMPLOYEE_CODE_MAX_LENGTH} ký tự.`,
    };
  }
  if (EMPLOYEE_CODE_PROJECT_WORKER_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message: "Mã nhân sự nội bộ không được dùng định dạng mã NLĐ dự án (hrp-YYYY-XXXXXX).",
    };
  }
  return { ok: true, value: trimmed };
}

export function parseFullName(
  value: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "Họ tên nhân sự là bắt buộc." };
  }
  if (CONTROL_CHAR_PATTERN.test(value)) {
    return { ok: false, message: "Họ tên không được chứa ký tự điều khiển." };
  }
  const trimmed = value.trim();
  if (trimmed.length < FULL_NAME_MIN_LENGTH || trimmed.length > FULL_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `Họ tên phải từ ${FULL_NAME_MIN_LENGTH} đến ${FULL_NAME_MAX_LENGTH} ký tự.`,
    };
  }
  return { ok: true, value: trimmed };
}

export function parseMatchedIdempotencyKey(
  headerValue: string | null,
  bodyValue: unknown,
): ParseResult<string> {
  if (!isValidUuid(headerValue)) {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "Header Idempotency-Key phải là UUID hợp lệ.",
    };
  }
  if (!isValidUuid(bodyValue)) {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "idempotency_key trong payload phải là UUID hợp lệ.",
    };
  }
  if (headerValue.toLowerCase() !== bodyValue.toLowerCase()) {
    return {
      ok: false,
      code: "IDEMPOTENCY_KEY_MISMATCH",
      message: "Header Idempotency-Key và idempotency_key trong payload không khớp.",
    };
  }
  return { ok: true, value: bodyValue.toLowerCase() };
}

function parseVersionInt(value: unknown, label: string): ParseResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: `${label} phải là số nguyên >= 1.` };
  }
  return { ok: true, value };
}

function validateAllowedKeys(
  obj: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): { ok: true } | { ok: false; message: string } {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return { ok: false, message: `Trường không hợp lệ: ${key}.` };
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, message: `Thiếu trường bắt buộc: ${key}.` };
    }
  }
  return { ok: true };
}

export type ListPersonsQuery = {
  search: string | null;
  status: PersonFilterStatus;
  department_id: string | null;
  link_state: PersonLinkState;
  as_of: string | null;
  page: number;
  page_size: number;
};

export function parseListPersonsQuery(url: URL): ParseResult<ListPersonsQuery> {
  const allowedParams = new Set([
    "search",
    "status",
    "department_id",
    "link_state",
    "as_of",
    "page",
    "page_size",
  ]);
  for (const key of url.searchParams.keys()) {
    if (SCHEDULE_FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      return {
        ok: false,
        code: "CLIENT_SCHEDULE_FIELD_FORBIDDEN",
        message: "Trường thời điểm hiệu lực không hợp lệ trên query.",
      };
    }
    if (FORBIDDEN_AUTHORITY_TOKENS.has(normalizeAuthorityKey(key))) {
      return {
        ok: false,
        code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        message: "Không được truyền trường thẩm quyền qua query.",
      };
    }
    if (!allowedParams.has(key)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: `Tham số truy vấn không được hỗ trợ: ${key}.`,
      };
    }
  }

  const rawSearch = url.searchParams.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    if (CONTROL_CHAR_PATTERN.test(rawSearch)) {
      return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Từ khóa tìm kiếm không hợp lệ." };
    }
    const trimmed = rawSearch.trim();
    if (trimmed.length > SEARCH_MAX_LENGTH) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: `Từ khóa tìm kiếm tối đa ${SEARCH_MAX_LENGTH} ký tự.`,
      };
    }
    search = trimmed === "" ? null : trimmed;
  }

  const rawStatus = url.searchParams.get("status") ?? "active";
  if (!(PERSON_FILTER_STATUSES as readonly string[]).includes(rawStatus)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "status phải thuộc active | inactive | all.",
    };
  }

  const rawDeptId = url.searchParams.get("department_id");
  let departmentId: string | null = null;
  if (rawDeptId !== null && rawDeptId !== "") {
    if (!isValidUuid(rawDeptId)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "department_id phải là UUID hợp lệ.",
      };
    }
    departmentId = rawDeptId.toLowerCase();
  }

  const rawLinkState = url.searchParams.get("link_state") ?? "all";
  if (!(PERSON_LINK_STATES as readonly string[]).includes(rawLinkState)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "link_state phải thuộc all | linked | unlinked.",
    };
  }

  const rawAsOf = url.searchParams.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== null && rawAsOf !== "") {
    if (!isValidIsoTimestamp(rawAsOf)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "as_of phải là chuỗi ISO-8601 có múi giờ hợp lệ.",
      };
    }
    asOf = new Date(rawAsOf).toISOString();
  }

  const rawPage = url.searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (!/^\d+$/.test(rawPage) || !Number.isSafeInteger(page) || page < 1 || page > MAX_ORG_PAGE) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: `page phải là số nguyên từ 1 đến ${MAX_ORG_PAGE}.`,
    };
  }

  const rawPageSize = url.searchParams.get("page_size") ?? String(DEFAULT_ORG_PAGE_SIZE);
  const pageSize = Number(rawPageSize);
  if (
    !/^\d+$/.test(rawPageSize) ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_ORG_PAGE_SIZE
  ) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: `page_size phải là số nguyên từ 1 đến ${MAX_ORG_PAGE_SIZE}.`,
    };
  }

  return {
    ok: true,
    value: {
      search,
      status: rawStatus as PersonFilterStatus,
      department_id: departmentId,
      link_state: rawLinkState as PersonLinkState,
      as_of: asOf,
      page,
      page_size: pageSize,
    },
  };
}

export function parseGetPersonParams(
  rawPersonId: string,
  url: URL,
): ParseResult<{ person_id: string; as_of: string | null }> {
  if (!isValidUuid(rawPersonId)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "personId phải là UUID hợp lệ." };
  }
  for (const key of url.searchParams.keys()) {
    if (SCHEDULE_FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      return {
        ok: false,
        code: "CLIENT_SCHEDULE_FIELD_FORBIDDEN",
        message: "Trường thời điểm hiệu lực không hợp lệ trên query.",
      };
    }
    if (key !== "as_of") {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: `Tham số truy vấn không được hỗ trợ: ${key}.`,
      };
    }
  }
  const rawAsOf = url.searchParams.get("as_of");
  let asOf: string | null = null;
  if (rawAsOf !== null && rawAsOf !== "") {
    if (!isValidIsoTimestamp(rawAsOf)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "as_of phải là chuỗi ISO-8601 có múi giờ hợp lệ.",
      };
    }
    asOf = new Date(rawAsOf).toISOString();
  }
  return { ok: true, value: { person_id: rawPersonId.toLowerCase(), as_of: asOf } };
}

export function parseUuidPathWithEmptyQuery(
  rawId: string,
  url: URL,
  paramLabel: string,
): ParseResult<string> {
  if (url.search.length > 0) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "Endpoint mutation không chấp nhận query string.",
    };
  }
  if (!isValidUuid(rawId)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: `${paramLabel} phải là UUID hợp lệ.`,
    };
  }
  return { ok: true, value: rawId.toLowerCase() };
}

export type CreatePersonBody = {
  employee_code: string;
  full_name: string;
  joined_on: string | null;
  initial_department_ref: string | null;
  account_ref: string | null;
  expected_account_version: number | null;
  recruiter_id: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseCreatePersonBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<CreatePersonBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(
    body,
    ["employee_code", "full_name", "reason", "idempotency_key"],
    ["joined_on", "initial_department_ref", "account_ref", "expected_account_version", "recruiter_id"],
  );
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  const code = parseEmployeeCode(body.employee_code);
  if (!code.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: code.message };
  const name = parseFullName(body.full_name);
  if (!name.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: name.message };
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  let joinedOn: string | null = null;
  if (body.joined_on !== undefined && body.joined_on !== null) {
    if (!isValidIsoDate(body.joined_on)) {
      return { ok: false, code: "ORG_VALIDATION_ERROR", message: "joined_on phải có dạng YYYY-MM-DD." };
    }
    joinedOn = body.joined_on;
  }

  let initialDepartmentRef: string | null = null;
  if (body.initial_department_ref !== undefined && body.initial_department_ref !== null) {
    if (!isValidUuid(body.initial_department_ref)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "initial_department_ref phải là UUID hợp lệ.",
      };
    }
    initialDepartmentRef = body.initial_department_ref.toLowerCase();
  }

  let accountRef: string | null = null;
  let expectedAccountVersion: number | null = null;
  if (body.account_ref !== undefined && body.account_ref !== null) {
    if (!isValidUuid(body.account_ref)) {
      return { ok: false, code: "ORG_VALIDATION_ERROR", message: "account_ref phải là UUID hợp lệ." };
    }
    accountRef = body.account_ref.toLowerCase();
    const ver = parseVersionInt(body.expected_account_version, "expected_account_version");
    if (!ver.ok) return ver;
    expectedAccountVersion = ver.value;
  } else if (
    body.expected_account_version !== undefined &&
    body.expected_account_version !== null
  ) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "expected_account_version chỉ được gửi kèm account_ref.",
    };
  }

  let recruiterId: string | null = null;
  if (body.recruiter_id !== undefined && body.recruiter_id !== null) {
    if (!isValidUuid(body.recruiter_id)) {
      return { ok: false, code: "ORG_VALIDATION_ERROR", message: "recruiter_id phải là UUID hợp lệ." };
    }
    recruiterId = body.recruiter_id.toLowerCase();
  }

  return {
    ok: true,
    value: {
      employee_code: code.value,
      full_name: name.value,
      joined_on: joinedOn,
      initial_department_ref: initialDepartmentRef,
      account_ref: accountRef,
      expected_account_version: expectedAccountVersion,
      recruiter_id: recruiterId,
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

export type UpdatePersonBody = {
  expected_person_version: number;
  employee_code: string;
  full_name: string;
  joined_on: string | null;
  status: PersonStatus;
  reason: string;
  idempotency_key: string;
};

export function parseUpdatePersonBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<UpdatePersonBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(body, [
    "expected_person_version",
    "employee_code",
    "full_name",
    "joined_on",
    "status",
    "reason",
    "idempotency_key",
  ]);
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  const ver = parseVersionInt(body.expected_person_version, "expected_person_version");
  if (!ver.ok) return ver;
  const code = parseEmployeeCode(body.employee_code);
  if (!code.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: code.message };
  const name = parseFullName(body.full_name);
  if (!name.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: name.message };
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  let joinedOn: string | null = null;
  if (body.joined_on !== null) {
    if (!isValidIsoDate(body.joined_on)) {
      return { ok: false, code: "ORG_VALIDATION_ERROR", message: "joined_on phải có dạng YYYY-MM-DD." };
    }
    joinedOn = body.joined_on;
  }

  if (
    typeof body.status !== "string" ||
    !(PERSON_STATUSES as readonly string[]).includes(body.status)
  ) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "status phải là ACTIVE hoặc INACTIVE." };
  }

  return {
    ok: true,
    value: {
      expected_person_version: ver.value,
      employee_code: code.value,
      full_name: name.value,
      joined_on: joinedOn,
      status: body.status as PersonStatus,
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

export type TransferPersonDepartmentBody = {
  target_department_ref: string;
  expected_person_version: number;
  expected_current_membership_id: string;
  reason: string;
  idempotency_key: string;
};

export function parseTransferPersonDepartmentBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<TransferPersonDepartmentBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(body, [
    "target_department_ref",
    "expected_person_version",
    "expected_current_membership_id",
    "reason",
    "idempotency_key",
  ]);
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  if (!isValidUuid(body.target_department_ref)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "target_department_ref phải là UUID hợp lệ.",
    };
  }
  const ver = parseVersionInt(body.expected_person_version, "expected_person_version");
  if (!ver.ok) return ver;
  if (!isValidUuid(body.expected_current_membership_id)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "expected_current_membership_id phải là UUID hợp lệ.",
    };
  }
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  return {
    ok: true,
    value: {
      target_department_ref: body.target_department_ref.toLowerCase(),
      expected_person_version: ver.value,
      expected_current_membership_id: body.expected_current_membership_id.toLowerCase(),
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

export type SetAccountTypeBody = {
  account_type: AccountType;
  expected_account_version: number;
  reason: string;
  idempotency_key: string;
};

export function parseSetAccountTypeBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<SetAccountTypeBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(body, [
    "account_type",
    "expected_account_version",
    "reason",
    "idempotency_key",
  ]);
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  if (
    typeof body.account_type !== "string" ||
    !(ACCOUNT_TYPES as readonly string[]).includes(body.account_type)
  ) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "account_type phải thuộc NORMAL | SHARED | SERVICE.",
    };
  }
  const ver = parseVersionInt(body.expected_account_version, "expected_account_version");
  if (!ver.ok) return ver;
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  return {
    ok: true,
    value: {
      account_type: body.account_type as AccountType,
      expected_account_version: ver.value,
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

export type LinkAccountPersonBody = {
  person_id: string;
  expected_account_version: number;
  expected_person_version: number;
  confirmed_recruiter_id: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseLinkAccountPersonBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<LinkAccountPersonBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(
    body,
    ["person_id", "expected_account_version", "expected_person_version", "reason", "idempotency_key"],
    ["confirmed_recruiter_id"],
  );
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  if (!isValidUuid(body.person_id)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "person_id phải là UUID hợp lệ." };
  }
  const accVer = parseVersionInt(body.expected_account_version, "expected_account_version");
  if (!accVer.ok) return accVer;
  const personVer = parseVersionInt(body.expected_person_version, "expected_person_version");
  if (!personVer.ok) return personVer;
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  let confirmedRecruiterId: string | null = null;
  if (body.confirmed_recruiter_id !== undefined && body.confirmed_recruiter_id !== null) {
    if (!isValidUuid(body.confirmed_recruiter_id)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "confirmed_recruiter_id phải là UUID hợp lệ.",
      };
    }
    confirmedRecruiterId = body.confirmed_recruiter_id.toLowerCase();
  }

  return {
    ok: true,
    value: {
      person_id: body.person_id.toLowerCase(),
      expected_account_version: accVer.value,
      expected_person_version: personVer.value,
      confirmed_recruiter_id: confirmedRecruiterId,
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

export type UnlinkAccountPersonBody = {
  expected_account_version: number;
  expected_person_version: number;
  expected_link_id: string;
  reason: string;
  idempotency_key: string;
};

export function parseUnlinkAccountPersonBody(
  body: unknown,
  idempotencyHeader: string | null,
): ParseResult<UnlinkAccountPersonBody> {
  if (!isPlainObject(body)) {
    return { ok: false, code: "ORG_VALIDATION_ERROR", message: "Payload phải là JSON object." };
  }
  const forbidden = checkNoForbiddenClientFields(body);
  if (!forbidden.ok) return forbidden;
  const keyCheck = validateAllowedKeys(body, [
    "expected_account_version",
    "expected_person_version",
    "expected_link_id",
    "reason",
    "idempotency_key",
  ]);
  if (!keyCheck.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: keyCheck.message };

  const idem = parseMatchedIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;
  const accVer = parseVersionInt(body.expected_account_version, "expected_account_version");
  if (!accVer.ok) return accVer;
  const personVer = parseVersionInt(body.expected_person_version, "expected_person_version");
  if (!personVer.ok) return personVer;
  if (!isValidUuid(body.expected_link_id)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "expected_link_id phải là UUID hợp lệ.",
    };
  }
  const reason = parseSafeReason(body.reason);
  if (!reason.ok) return { ok: false, code: "ORG_VALIDATION_ERROR", message: reason.message };

  return {
    ok: true,
    value: {
      expected_account_version: accVer.value,
      expected_person_version: personVer.value,
      expected_link_id: body.expected_link_id.toLowerCase(),
      reason: reason.value,
      idempotency_key: idem.value,
    },
  };
}

function sha256Canonical(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function computeCreatePersonFingerprint(
  actorAppUserId: string,
  body: CreatePersonBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "PERSON_CREATED",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    employee_code: body.employee_code.trim().toLowerCase(),
    full_name: body.full_name,
    joined_on: body.joined_on,
    initial_department_ref: body.initial_department_ref?.toLowerCase() ?? null,
    account_ref: body.account_ref?.toLowerCase() ?? null,
    expected_account_version: body.expected_account_version,
    recruiter_id: body.recruiter_id?.toLowerCase() ?? null,
    reason: body.reason,
  });
}

export function computeUpdatePersonFingerprint(
  actorAppUserId: string,
  personId: string,
  body: UpdatePersonBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "PERSON_UPDATED",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    person_id: personId.toLowerCase(),
    expected_person_version: body.expected_person_version,
    employee_code: body.employee_code.trim().toLowerCase(),
    full_name: body.full_name,
    joined_on: body.joined_on,
    status: body.status,
    reason: body.reason,
  });
}

export function computeTransferPersonDepartmentFingerprint(
  actorAppUserId: string,
  personId: string,
  body: TransferPersonDepartmentBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "PERSON_DEPT_TRANSFERRED",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    person_id: personId.toLowerCase(),
    target_department_ref: body.target_department_ref.toLowerCase(),
    expected_person_version: body.expected_person_version,
    expected_current_membership_id: body.expected_current_membership_id.toLowerCase(),
    reason: body.reason,
  });
}

export function computeSetAccountTypeFingerprint(
  actorAppUserId: string,
  accountRef: string,
  body: SetAccountTypeBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "ACCOUNT_TYPE_SET",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    account_ref: accountRef.toLowerCase(),
    account_type: body.account_type,
    expected_account_version: body.expected_account_version,
    reason: body.reason,
  });
}

export function computeLinkAccountPersonFingerprint(
  actorAppUserId: string,
  accountRef: string,
  body: LinkAccountPersonBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "ACCOUNT_PERSON_LINKED",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    account_ref: accountRef.toLowerCase(),
    person_id: body.person_id.toLowerCase(),
    expected_account_version: body.expected_account_version,
    expected_person_version: body.expected_person_version,
    confirmed_recruiter_id: body.confirmed_recruiter_id?.toLowerCase() ?? null,
    reason: body.reason,
  });
}

export function computeUnlinkAccountPersonFingerprint(
  actorAppUserId: string,
  accountRef: string,
  body: UnlinkAccountPersonBody,
): string {
  return sha256Canonical({
    v: 1,
    op: "ACCOUNT_PERSON_UNLINKED",
    actor_app_user_id: actorAppUserId.toLowerCase(),
    account_ref: accountRef.toLowerCase(),
    expected_account_version: body.expected_account_version,
    expected_person_version: body.expected_person_version,
    expected_link_id: body.expected_link_id.toLowerCase(),
    reason: body.reason,
  });
}
