import {
  CONTROL_CHAR_PATTERN,
  DEFAULT_ORG_PAGE_SIZE,
  MAX_ORG_PAGE,
  MAX_ORG_PAGE_SIZE,
  PERSON_SOURCE_KINDS,
  PERSON_STATUSES,
  SCHEDULE_FORBIDDEN_FIELDS,
  SEARCH_MAX_LENGTH,
  isPlainObject,
  isValidIsoDate,
  isValidIsoTimestamp,
  isValidUuid,
  organizationErrorStatus,
  type OrganizationErrorCode,
  type ParseResult,
  type PersonActiveDepartmentProjection,
  type PersonDepartmentHistoryProjection,
  type PersonHeadHistoryProjection,
  type PersonSourceKind,
  type PersonStatus,
} from "./person-contract.ts";

export { organizationErrorStatus, type OrganizationErrorCode };

export const USER_DIRECTORY_RECORD_KINDS = [
  "LINKED_PERSON_ACCOUNT",
  "PERSON_ONLY",
  "UNLINKED_ACCOUNT",
  "PERSON_LINK_CONFLICT",
  "ACCOUNT_LINK_CONFLICT",
] as const;
export type UserDirectoryRecordKind = (typeof USER_DIRECTORY_RECORD_KINDS)[number];

export const USER_DIRECTORY_RECORD_KIND_FILTERS = [
  "all",
  "person",
  "unlinked_account",
  "conflict",
] as const;
export type UserDirectoryRecordKindFilter = (typeof USER_DIRECTORY_RECORD_KIND_FILTERS)[number];

export const USER_DIRECTORY_PERSON_STATUS_FILTERS = [
  "all",
  "active",
  "inactive",
  "none",
] as const;
export type UserDirectoryPersonStatusFilter = (typeof USER_DIRECTORY_PERSON_STATUS_FILTERS)[number];

export const USER_DIRECTORY_LOGIN_STATE_FILTERS = [
  "all",
  "enabled",
  "disabled",
  "no_account",
] as const;
export type UserDirectoryLoginStateFilter = (typeof USER_DIRECTORY_LOGIN_STATE_FILTERS)[number];

export const USER_DIRECTORY_LOGIN_STATES = ["ENABLED", "DISABLED", "NO_ACCOUNT"] as const;
export type UserDirectoryLoginState = (typeof USER_DIRECTORY_LOGIN_STATES)[number];

export const USER_DIRECTORY_CONFLICT_REASONS = [
  "MULTIPLE_ACTIVE_LINKS_FOR_PERSON",
  "MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT",
  "ENDPOINT_LINK_CONFLICT",
  "RECRUITER_IDENTITY_CONFLICT",
] as const;
export type UserDirectoryConflictReason = (typeof USER_DIRECTORY_CONFLICT_REASONS)[number];

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

function normalizeAuthorityKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

export type UserDirectoryConflictDetails = {
  reason: UserDirectoryConflictReason;
  link_ids: string[];
  related_person_ids: string[];
  related_account_refs: string[];
};

export type UserDirectoryPersonProjection = {
  person_id: string;
  employee_code: string;
  full_name: string;
  status: PersonStatus;
  joined_on: string | null;
  recruiter_id: string | null;
  version: number;
  active_department: PersonActiveDepartmentProjection | null;
};

export type UserDirectoryAccountProjection = {
  account_ref: string;
  login_id: string | null;
  display_name: string | null;
  enabled: boolean;
  version: number;
  auth_user_present: boolean;
};

export type UserDirectoryActiveLinkProjection = {
  link_id: string;
  started_at: string;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type UserDirectoryLinkHistoryProjection = {
  link_id: string;
  person_id: string;
  account_ref: string;
  started_at: string;
  ended_at: string | null;
  source_kind: PersonSourceKind;
  evidence_date: string | null;
  version: number;
};

export type UserDirectoryEntrySummary = {
  directory_entry_key: string;
  record_kind: UserDirectoryRecordKind;
  display_name: string;
  login_state: UserDirectoryLoginState;
  person_id: string | null;
  account_ref: string | null;
  active_link_id: string | null;
  link_conflict: boolean;
  identity_mutation_blocked: boolean;
  conflict_details: UserDirectoryConflictDetails | null;
  person: UserDirectoryPersonProjection | null;
  account: UserDirectoryAccountProjection | null;
  active_link: UserDirectoryActiveLinkProjection | null;
};

export type UserDirectoryEntryDetail = UserDirectoryEntrySummary & {
  department_history: PersonDepartmentHistoryProjection[];
  head_assignments: PersonHeadHistoryProjection[];
  link_history: UserDirectoryLinkHistoryProjection[];
};

export type UserDirectorySummaryCounts = {
  total_all: number;
  linked_count: number;
  person_only_count: number;
  unlinked_account_count: number;
  conflict_count: number;
};

export type ListUserDirectoryRpcProjection = {
  authorization_date: string;
  as_of: string;
  search: string | null;
  record_kind: UserDirectoryRecordKindFilter;
  person_status: UserDirectoryPersonStatusFilter;
  login_state: UserDirectoryLoginStateFilter;
  department_id: string | null;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  summary: UserDirectorySummaryCounts;
  entries: UserDirectoryEntrySummary[];
};

export type ListUserDirectoryResponse = { ok: true } & ListUserDirectoryRpcProjection;

export type GetUserDirectoryEntryRpcProjection = {
  authorization_date: string;
  as_of: string;
  entry: UserDirectoryEntryDetail;
};

export type GetUserDirectoryEntryResponse = { ok: true } & GetUserDirectoryEntryRpcProjection;

export type ListUserDirectoryQuery = {
  search: string | null;
  record_kind: UserDirectoryRecordKindFilter;
  person_status: UserDirectoryPersonStatusFilter;
  login_state: UserDirectoryLoginStateFilter;
  department_id: string | null;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type GetUserDirectoryEntryQuery = {
  person_id: string | null;
  account_ref: string | null;
  as_of: string | null;
};

export function parseListUserDirectoryQuery(url: URL): ParseResult<ListUserDirectoryQuery> {
  const allowedParams = new Set([
    "search",
    "record_kind",
    "person_status",
    "login_state",
    "department_id",
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
  for (const key of allowedParams) {
    if (url.searchParams.getAll(key).length > 1) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: `Tham số truy vấn bị lặp: ${key}.`,
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

  const rawRecordKind = url.searchParams.get("record_kind") ?? "all";
  if (!(USER_DIRECTORY_RECORD_KIND_FILTERS as readonly string[]).includes(rawRecordKind)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "record_kind phải thuộc all | person | unlinked_account | conflict.",
    };
  }

  const rawPersonStatus = url.searchParams.get("person_status") ?? "all";
  if (!(USER_DIRECTORY_PERSON_STATUS_FILTERS as readonly string[]).includes(rawPersonStatus)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "person_status phải thuộc all | active | inactive | none.",
    };
  }

  const rawLoginState = url.searchParams.get("login_state") ?? "all";
  if (!(USER_DIRECTORY_LOGIN_STATE_FILTERS as readonly string[]).includes(rawLoginState)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "login_state phải thuộc all | enabled | disabled | no_account.",
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
      record_kind: rawRecordKind as UserDirectoryRecordKindFilter,
      person_status: rawPersonStatus as UserDirectoryPersonStatusFilter,
      login_state: rawLoginState as UserDirectoryLoginStateFilter,
      department_id: departmentId,
      as_of: asOf,
      page,
      page_size: pageSize,
    },
  };
}

export function parseGetUserDirectoryEntryQuery(url: URL): ParseResult<GetUserDirectoryEntryQuery> {
  const allowedParams = new Set(["person_id", "account_ref", "as_of"]);
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
  for (const key of allowedParams) {
    if (url.searchParams.getAll(key).length > 1) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: `Tham số truy vấn bị lặp: ${key}.`,
      };
    }
  }

  const rawPersonId = url.searchParams.get("person_id");
  const rawAccountRef = url.searchParams.get("account_ref");
  const hasPerson = rawPersonId !== null && rawPersonId !== "";
  const hasAccount = rawAccountRef !== null && rawAccountRef !== "";

  if ((hasPerson && hasAccount) || (!hasPerson && !hasAccount)) {
    return {
      ok: false,
      code: "ORG_VALIDATION_ERROR",
      message: "Phải cung cấp chính xác một trong hai tham số person_id hoặc account_ref.",
    };
  }

  let personId: string | null = null;
  if (hasPerson) {
    if (!isValidUuid(rawPersonId)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "person_id phải là UUID hợp lệ.",
      };
    }
    personId = rawPersonId.toLowerCase();
  }

  let accountRef: string | null = null;
  if (hasAccount) {
    if (!isValidUuid(rawAccountRef)) {
      return {
        ok: false,
        code: "ORG_VALIDATION_ERROR",
        message: "account_ref phải là UUID hợp lệ.",
      };
    }
    accountRef = rawAccountRef.toLowerCase();
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

  return {
    ok: true,
    value: {
      person_id: personId,
      account_ref: accountRef,
      as_of: asOf,
    },
  };
}

function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(obj);
  if (actualKeys.length !== keys.length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false;
  }
  return true;
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptySafeText(value: unknown, maxLen: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.length <= maxLen &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isValidSourceKind(value: unknown): value is PersonSourceKind {
  return typeof value === "string" && (PERSON_SOURCE_KINDS as readonly string[]).includes(value);
}

function projectUuidList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!isValidUuid(item)) return null;
    out.push(item.toLowerCase());
  }
  return out;
}

function projectActiveDepartment(value: unknown): PersonActiveDepartmentProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "membership_id",
      "department_id",
      "system_key",
      "code",
      "name",
      "started_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.membership_id) ||
    !isValidUuid(value.department_id) ||
    (value.system_key !== null && !isNonEmptySafeText(value.system_key, 64)) ||
    !isNonEmptySafeText(value.code, 64) ||
    !isNonEmptySafeText(value.name, 256) ||
    !isValidIsoTimestamp(value.started_at) ||
    !isValidSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    membership_id: value.membership_id.toLowerCase(),
    department_id: value.department_id.toLowerCase(),
    system_key: value.system_key,
    code: value.code,
    name: value.name,
    started_at: value.started_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

function projectDepartmentHistoryItem(value: unknown): PersonDepartmentHistoryProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "membership_id",
      "department_id",
      "system_key",
      "code",
      "name",
      "started_at",
      "ended_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.membership_id) ||
    !isValidUuid(value.department_id) ||
    (value.system_key !== null && !isNonEmptySafeText(value.system_key, 64)) ||
    !isNonEmptySafeText(value.code, 64) ||
    !isNonEmptySafeText(value.name, 256) ||
    !isValidIsoTimestamp(value.started_at) ||
    (value.ended_at !== null && !isValidIsoTimestamp(value.ended_at)) ||
    !isValidSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    membership_id: value.membership_id.toLowerCase(),
    department_id: value.department_id.toLowerCase(),
    system_key: value.system_key,
    code: value.code,
    name: value.name,
    started_at: value.started_at,
    ended_at: value.ended_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

function projectHeadHistoryItem(value: unknown): PersonHeadHistoryProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "head_assignment_id",
      "department_id",
      "system_key",
      "code",
      "name",
      "started_at",
      "ended_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.head_assignment_id) ||
    !isValidUuid(value.department_id) ||
    (value.system_key !== null && !isNonEmptySafeText(value.system_key, 64)) ||
    !isNonEmptySafeText(value.code, 64) ||
    !isNonEmptySafeText(value.name, 256) ||
    !isValidIsoTimestamp(value.started_at) ||
    (value.ended_at !== null && !isValidIsoTimestamp(value.ended_at)) ||
    !isValidSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    head_assignment_id: value.head_assignment_id.toLowerCase(),
    department_id: value.department_id.toLowerCase(),
    system_key: value.system_key,
    code: value.code,
    name: value.name,
    started_at: value.started_at,
    ended_at: value.ended_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

function projectConflictDetails(value: unknown): UserDirectoryConflictDetails | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["reason", "link_ids", "related_person_ids", "related_account_refs"])
  ) {
    return null;
  }
  if (
    typeof value.reason !== "string" ||
    !(USER_DIRECTORY_CONFLICT_REASONS as readonly string[]).includes(value.reason)
  ) {
    return null;
  }
  const linkIds = projectUuidList(value.link_ids);
  const relatedPersonIds = projectUuidList(value.related_person_ids);
  const relatedAccountRefs = projectUuidList(value.related_account_refs);
  if (!linkIds || linkIds.length === 0 || !relatedPersonIds || !relatedAccountRefs) {
    return null;
  }
  return {
    reason: value.reason as UserDirectoryConflictReason,
    link_ids: linkIds,
    related_person_ids: relatedPersonIds,
    related_account_refs: relatedAccountRefs,
  };
}

function projectDirectoryPerson(value: unknown): UserDirectoryPersonProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "person_id",
      "employee_code",
      "full_name",
      "status",
      "joined_on",
      "recruiter_id",
      "version",
      "active_department",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.person_id) ||
    !isNonEmptySafeText(value.employee_code, 64) ||
    !isNonEmptySafeText(value.full_name, 160) ||
    typeof value.status !== "string" ||
    !(PERSON_STATUSES as readonly string[]).includes(value.status) ||
    (value.joined_on !== null && !isValidIsoDate(value.joined_on)) ||
    (value.recruiter_id !== null && !isValidUuid(value.recruiter_id)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  const activeDepartment =
    value.active_department === null ? null : projectActiveDepartment(value.active_department);
  if (value.active_department !== null && activeDepartment === null) return null;

  return {
    person_id: value.person_id.toLowerCase(),
    employee_code: value.employee_code,
    full_name: value.full_name,
    status: value.status as PersonStatus,
    joined_on: value.joined_on,
    recruiter_id: value.recruiter_id ? value.recruiter_id.toLowerCase() : null,
    version: value.version,
    active_department: activeDepartment,
  };
}

function projectDirectoryAccount(value: unknown): UserDirectoryAccountProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "account_ref",
      "login_id",
      "display_name",
      "enabled",
      "version",
      "auth_user_present",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.account_ref) ||
    (value.login_id !== null &&
      (!isNonEmptySafeText(value.login_id, 128) || value.login_id.includes("@"))) ||
    (value.display_name !== null && !isNonEmptySafeText(value.display_name, 256)) ||
    typeof value.enabled !== "boolean" ||
    !isSafePositiveInt(value.version) ||
    typeof value.auth_user_present !== "boolean"
  ) {
    return null;
  }
  return {
    account_ref: value.account_ref.toLowerCase(),
    login_id: value.login_id,
    display_name: value.display_name,
    enabled: value.enabled,
    version: value.version,
    auth_user_present: value.auth_user_present,
  };
}

function projectDirectoryActiveLink(value: unknown): UserDirectoryActiveLinkProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["link_id", "started_at", "source_kind", "evidence_date", "version"])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.link_id) ||
    !isValidIsoTimestamp(value.started_at) ||
    !isValidSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    link_id: value.link_id.toLowerCase(),
    started_at: value.started_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

function projectLinkHistoryItem(value: unknown): UserDirectoryLinkHistoryProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "link_id",
      "person_id",
      "account_ref",
      "started_at",
      "ended_at",
      "source_kind",
      "evidence_date",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isValidUuid(value.link_id) ||
    !isValidUuid(value.person_id) ||
    !isValidUuid(value.account_ref) ||
    !isValidIsoTimestamp(value.started_at) ||
    (value.ended_at !== null && !isValidIsoTimestamp(value.ended_at)) ||
    !isValidSourceKind(value.source_kind) ||
    (value.evidence_date !== null && !isValidIsoDate(value.evidence_date)) ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  return {
    link_id: value.link_id.toLowerCase(),
    person_id: value.person_id.toLowerCase(),
    account_ref: value.account_ref.toLowerCase(),
    started_at: value.started_at,
    ended_at: value.ended_at,
    source_kind: value.source_kind,
    evidence_date: value.evidence_date,
    version: value.version,
  };
}

const ENTRY_SUMMARY_KEYS = [
  "directory_entry_key",
  "record_kind",
  "display_name",
  "login_state",
  "person_id",
  "account_ref",
  "active_link_id",
  "link_conflict",
  "identity_mutation_blocked",
  "conflict_details",
  "person",
  "account",
  "active_link",
] as const;

function validateEntrySummaryFields(
  value: Record<string, unknown>,
): UserDirectoryEntrySummary | null {
  if (
    !isNonEmptySafeText(value.directory_entry_key, 80) ||
    typeof value.record_kind !== "string" ||
    !(USER_DIRECTORY_RECORD_KINDS as readonly string[]).includes(value.record_kind) ||
    !isNonEmptySafeText(value.display_name, 256) ||
    typeof value.login_state !== "string" ||
    !(USER_DIRECTORY_LOGIN_STATES as readonly string[]).includes(value.login_state) ||
    (value.person_id !== null && !isValidUuid(value.person_id)) ||
    (value.account_ref !== null && !isValidUuid(value.account_ref)) ||
    (value.active_link_id !== null && !isValidUuid(value.active_link_id)) ||
    typeof value.link_conflict !== "boolean" ||
    typeof value.identity_mutation_blocked !== "boolean"
  ) {
    return null;
  }

  const conflictDetails =
    value.conflict_details === null ? null : projectConflictDetails(value.conflict_details);
  if (value.conflict_details !== null && conflictDetails === null) return null;

  const person = value.person === null ? null : projectDirectoryPerson(value.person);
  if (value.person !== null && person === null) return null;

  const account = value.account === null ? null : projectDirectoryAccount(value.account);
  if (value.account !== null && account === null) return null;

  const activeLink =
    value.active_link === null ? null : projectDirectoryActiveLink(value.active_link);
  if (value.active_link !== null && activeLink === null) return null;

  const recordKind = value.record_kind as UserDirectoryRecordKind;
  const loginState = value.login_state as UserDirectoryLoginState;
  const personId = value.person_id ? value.person_id.toLowerCase() : null;
  const accountRef = value.account_ref ? value.account_ref.toLowerCase() : null;
  const activeLinkId = value.active_link_id ? value.active_link_id.toLowerCase() : null;

  // Enforce merge-rule structural invariants fail-closed:
  if (recordKind === "LINKED_PERSON_ACCOUNT") {
    if (
      !person ||
      !account ||
      !activeLink ||
      personId !== person.person_id ||
      accountRef !== account.account_ref ||
      activeLinkId !== activeLink.link_id ||
      value.link_conflict ||
      value.identity_mutation_blocked ||
      conflictDetails !== null ||
      loginState !== (account.enabled ? "ENABLED" : "DISABLED") ||
      value.directory_entry_key !== `person:${person.person_id}`
    ) {
      return null;
    }
  } else if (recordKind === "PERSON_ONLY") {
    if (
      !person ||
      account !== null ||
      activeLink !== null ||
      personId !== person.person_id ||
      accountRef !== null ||
      activeLinkId !== null ||
      value.link_conflict ||
      value.identity_mutation_blocked ||
      conflictDetails !== null ||
      loginState !== "NO_ACCOUNT" ||
      value.directory_entry_key !== `person:${person.person_id}`
    ) {
      return null;
    }
  } else if (recordKind === "UNLINKED_ACCOUNT") {
    if (
      person !== null ||
      !account ||
      activeLink !== null ||
      personId !== null ||
      accountRef !== account.account_ref ||
      activeLinkId !== null ||
      value.link_conflict ||
      value.identity_mutation_blocked ||
      conflictDetails !== null ||
      loginState !== (account.enabled ? "ENABLED" : "DISABLED") ||
      value.directory_entry_key !== `account:${account.account_ref}`
    ) {
      return null;
    }
  } else if (recordKind === "PERSON_LINK_CONFLICT") {
    if (
      !person ||
      account !== null ||
      activeLink !== null ||
      personId !== person.person_id ||
      accountRef !== null ||
      activeLinkId !== null ||
      !value.link_conflict ||
      !value.identity_mutation_blocked ||
      conflictDetails === null ||
      loginState !== "NO_ACCOUNT" ||
      value.directory_entry_key !== `person:${person.person_id}`
    ) {
      return null;
    }
  } else if (recordKind === "ACCOUNT_LINK_CONFLICT") {
    if (
      person !== null ||
      !account ||
      activeLink !== null ||
      personId !== null ||
      accountRef !== account.account_ref ||
      activeLinkId !== null ||
      !value.link_conflict ||
      !value.identity_mutation_blocked ||
      conflictDetails === null ||
      loginState !== (account.enabled ? "ENABLED" : "DISABLED") ||
      value.directory_entry_key !== `account:${account.account_ref}`
    ) {
      return null;
    }
  }

  return {
    directory_entry_key: value.directory_entry_key,
    record_kind: recordKind,
    display_name: value.display_name,
    login_state: loginState,
    person_id: personId,
    account_ref: accountRef,
    active_link_id: activeLinkId,
    link_conflict: value.link_conflict,
    identity_mutation_blocked: value.identity_mutation_blocked,
    conflict_details: conflictDetails,
    person,
    account,
    active_link: activeLink,
  };
}

export function projectUserDirectoryEntrySummary(value: unknown): UserDirectoryEntrySummary | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_SUMMARY_KEYS)) {
    return null;
  }
  return validateEntrySummaryFields(value);
}

export function projectUserDirectoryEntryDetail(value: unknown): UserDirectoryEntryDetail | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      ...ENTRY_SUMMARY_KEYS,
      "department_history",
      "head_assignments",
      "link_history",
    ])
  ) {
    return null;
  }
  const base = validateEntrySummaryFields(value);
  if (!base) return null;
  if (
    !Array.isArray(value.department_history) ||
    !Array.isArray(value.head_assignments) ||
    !Array.isArray(value.link_history)
  ) {
    return null;
  }

  const departmentHistory: PersonDepartmentHistoryProjection[] = [];
  for (const item of value.department_history) {
    const projected = projectDepartmentHistoryItem(item);
    if (!projected) return null;
    departmentHistory.push(projected);
  }
  const headAssignments: PersonHeadHistoryProjection[] = [];
  for (const item of value.head_assignments) {
    const projected = projectHeadHistoryItem(item);
    if (!projected) return null;
    headAssignments.push(projected);
  }
  const linkHistory: UserDirectoryLinkHistoryProjection[] = [];
  for (const item of value.link_history) {
    const projected = projectLinkHistoryItem(item);
    if (!projected) return null;
    linkHistory.push(projected);
  }

  return {
    ...base,
    department_history: departmentHistory,
    head_assignments: headAssignments,
    link_history: linkHistory,
  };
}

function projectSummaryCounts(value: unknown): UserDirectorySummaryCounts | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "total_all",
      "linked_count",
      "person_only_count",
      "unlinked_account_count",
      "conflict_count",
    ])
  ) {
    return null;
  }
  if (
    !isSafeNonNegativeInt(value.total_all) ||
    !isSafeNonNegativeInt(value.linked_count) ||
    !isSafeNonNegativeInt(value.person_only_count) ||
    !isSafeNonNegativeInt(value.unlinked_account_count) ||
    !isSafeNonNegativeInt(value.conflict_count)
  ) {
    return null;
  }
  if (
    value.linked_count +
      value.person_only_count +
      value.unlinked_account_count +
      value.conflict_count !==
    value.total_all
  ) {
    return null;
  }
  return {
    total_all: value.total_all,
    linked_count: value.linked_count,
    person_only_count: value.person_only_count,
    unlinked_account_count: value.unlinked_account_count,
    conflict_count: value.conflict_count,
  };
}

export function projectListUserDirectoryResponse(
  value: unknown,
): ListUserDirectoryRpcProjection | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "authorization_date",
      "as_of",
      "search",
      "record_kind",
      "person_status",
      "login_state",
      "department_id",
      "page",
      "page_size",
      "total",
      "has_more",
      "summary",
      "entries",
    ])
  ) {
    return null;
  }
  if (
    !isValidIsoDate(value.authorization_date) ||
    !isValidIsoTimestamp(value.as_of) ||
    (value.search !== null && !isNonEmptySafeText(value.search, SEARCH_MAX_LENGTH)) ||
    typeof value.record_kind !== "string" ||
    !(USER_DIRECTORY_RECORD_KIND_FILTERS as readonly string[]).includes(value.record_kind) ||
    typeof value.person_status !== "string" ||
    !(USER_DIRECTORY_PERSON_STATUS_FILTERS as readonly string[]).includes(value.person_status) ||
    typeof value.login_state !== "string" ||
    !(USER_DIRECTORY_LOGIN_STATE_FILTERS as readonly string[]).includes(value.login_state) ||
    (value.department_id !== null && !isValidUuid(value.department_id)) ||
    !isSafePositiveInt(value.page) ||
    !isSafePositiveInt(value.page_size) ||
    !isSafeNonNegativeInt(value.total) ||
    typeof value.has_more !== "boolean" ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const summary = projectSummaryCounts(value.summary);
  if (!summary) return null;

  const entries: UserDirectoryEntrySummary[] = [];
  for (const rawEntry of value.entries) {
    const projected = projectUserDirectoryEntrySummary(rawEntry);
    if (!projected) return null;
    entries.push(projected);
  }

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    search: value.search,
    record_kind: value.record_kind as UserDirectoryRecordKindFilter,
    person_status: value.person_status as UserDirectoryPersonStatusFilter,
    login_state: value.login_state as UserDirectoryLoginStateFilter,
    department_id: value.department_id ? value.department_id.toLowerCase() : null,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    has_more: value.has_more,
    summary,
    entries,
  };
}

export function projectGetUserDirectoryEntryResponse(
  value: unknown,
): GetUserDirectoryEntryRpcProjection | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["authorization_date", "as_of", "entry"])) {
    return null;
  }
  if (!isValidIsoDate(value.authorization_date) || !isValidIsoTimestamp(value.as_of)) {
    return null;
  }
  const entry = projectUserDirectoryEntryDetail(value.entry);
  if (!entry) return null;

  return {
    authorization_date: value.authorization_date,
    as_of: value.as_of,
    entry,
  };
}
