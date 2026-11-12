/**
 * ORG-SHELL-01 — Pure, browser-safe UI model for Department Administration.
 *
 * Reuses T1A's canonical type projections without importing `node:*` or
 * `server-only` modules into the client bundle. All query builders, response
 * envelope projectors, mutation request builders, and error classifiers fail
 * closed and never derive or send client-side authority fields.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import type {
  AccountingCandidateListProjection,
  AccountingCandidateProjection,
  AccountingMembershipListProjection,
  AccountingMembershipMutationProjection,
  AccountingMembershipProjection,
  DepartmentDefaultPolicyCode,
  DepartmentDetailProjection,
  DepartmentErrorCode,
  DepartmentListProjection,
  DepartmentMembershipState,
  DepartmentProjection,
  RecruitmentTeamListProjection,
  RecruitmentTeamProjection,
} from "../departments/department-contract.ts";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";

export const DEPARTMENT_UI_PAGE_SIZE = 25;
export const DEPARTMENT_UI_MAX_PAGE = 1000;
export const DEPARTMENT_UI_MAX_SEARCH_LENGTH = 120;
export const DEPARTMENT_UI_MAX_REASON_LENGTH = 4000;
export const RESERVED_VENDOR_TEAM_CODE = "__system_vendor__";

export const ACCOUNTING_DEFAULT_POLICY_DESCRIPTION = "Xem và ghi nhận tài chính Vendor";
export const RECRUITMENT_DEFAULT_POLICY_DESCRIPTION =
  "Chiếu danh sách Nhóm (Team) hiện có ở chế độ chỉ đọc; toàn bộ quản trị Nhóm, Team Leader và phạm vi Dự án ↔ Nhóm giữ nguyên tại màn hình hiện hành.";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const SEARCH_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const SEARCH_CONTROL_CHAR_GLOBAL = /[\x00-\x1f\x7f]/g;
const REASON_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export type RecruitmentTeamsQuery = {
  search: string;
  includeInactive: boolean;
  page: number;
};

export type AccountingMembershipsQuery = {
  search: string;
  includeHistory: boolean;
  page: number;
};

export type AccountingCandidatesQuery = {
  search: string;
  page: number;
};

export type AssignAccountingMemberRequestResult =
  | {
      ok: true;
      idempotencyKey: string;
      body: {
        account_ref: string;
        expected_pair_version: number;
        effective_from: string | null;
        reason: string;
        idempotency_key: string;
      };
    }
  | { ok: false; message: string };

export type EndAccountingMemberRequestResult =
  | {
      ok: true;
      membershipId: string;
      idempotencyKey: string;
      body: {
        expected_pair_version: number;
        effective_to: string | null;
        reason: string;
        idempotency_key: string;
      };
    }
  | { ok: false; message: string };

export type DepartmentReadFailure = {
  kind: "unauthenticated" | "denied" | "not-found" | "invalid" | "unavailable";
  message: string;
  retryable: boolean;
};

export type DepartmentMutationOutcome =
  | {
      kind: "applied";
      replayed: boolean;
      membership: AccountingMembershipProjection;
      message: string;
    }
  | {
      kind: "conflict" | "unauthenticated" | "denied" | "not-found" | "invalid" | "unavailable";
      message: string;
      resetIdempotencyKey: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((key) => expectedSet.has(key));
}

export function normalizeDepartmentUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

export function isValidIsoCalendarDate(value: unknown): value is string {
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
  return typeof value === "string" && ISO_UTC_TIMESTAMP_PATTERN.test(value);
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

export function sanitizeDepartmentSearchInput(raw: string): string {
  return raw.replace(SEARCH_CONTROL_CHAR_GLOBAL, "").slice(0, DEPARTMENT_UI_MAX_SEARCH_LENGTH);
}

function normalizeQuerySearch(raw: string): { ok: true; value: string | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (
    trimmed.length > DEPARTMENT_UI_MAX_SEARCH_LENGTH ||
    SEARCH_CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

function isValidPageNumber(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= DEPARTMENT_UI_MAX_PAGE;
}

export function buildRecruitmentTeamsQuery(input: RecruitmentTeamsQuery): URLSearchParams | null {
  if (!isValidPageNumber(input.page) || typeof input.includeInactive !== "boolean") {
    return null;
  }
  const search = normalizeQuerySearch(input.search);
  if (!search.ok) return null;

  const params = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(DEPARTMENT_UI_PAGE_SIZE),
  });
  if (search.value !== null) {
    params.set("search", search.value);
  }
  return params;
}

export function buildAccountingMembershipsQuery(
  input: AccountingMembershipsQuery,
): URLSearchParams | null {
  if (!isValidPageNumber(input.page) || typeof input.includeHistory !== "boolean") {
    return null;
  }
  const search = normalizeQuerySearch(input.search);
  if (!search.ok) return null;

  const params = new URLSearchParams({
    include_history: String(input.includeHistory),
    page: String(input.page),
    page_size: String(DEPARTMENT_UI_PAGE_SIZE),
  });
  if (search.value !== null) {
    params.set("search", search.value);
  }
  return params;
}

export function buildAccountingCandidatesQuery(
  input: AccountingCandidatesQuery,
): URLSearchParams | null {
  if (!isValidPageNumber(input.page)) {
    return null;
  }
  const search = normalizeQuerySearch(input.search);
  if (!search.ok) return null;

  const params = new URLSearchParams({
    page: String(input.page),
    page_size: String(DEPARTMENT_UI_PAGE_SIZE),
  });
  if (search.value !== null) {
    params.set("search", search.value);
  }
  return params;
}

const DEPARTMENT_PROJECTION_KEYS = [
  "department_id",
  "system_key",
  "code",
  "name",
  "is_active",
  "membership_mode",
  "default_policy_code",
  "active_member_count",
  "team_count",
  "active_team_count",
  "created_at",
  "updated_at",
] as const;

export function projectDepartmentProjectionItem(value: unknown): DepartmentProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, DEPARTMENT_PROJECTION_KEYS)) {
    return null;
  }

  const departmentId = normalizeDepartmentUuid(value.department_id);
  const systemKey = value.system_key;
  const code = value.code;
  const name = value.name;
  const isActive = value.is_active;
  const membershipMode = value.membership_mode;
  const defaultPolicyCode = value.default_policy_code;
  const activeMemberCount = value.active_member_count;
  const teamCount = value.team_count;
  const activeTeamCount = value.active_team_count;
  const createdAt = value.created_at;
  const updatedAt = value.updated_at;

  if (
    !departmentId ||
    (systemKey !== "RECRUITMENT" && systemKey !== "ACCOUNTING") ||
    typeof code !== "string" ||
    !DEPARTMENT_CODE_PATTERN.test(code) ||
    !isNonEmptyDisplayString(name, 256) ||
    typeof isActive !== "boolean" ||
    !isIsoUtcTimestamp(createdAt) ||
    !isIsoUtcTimestamp(updatedAt)
  ) {
    return null;
  }

  if (systemKey === "ACCOUNTING") {
    if (
      membershipMode !== "MANAGED_MEMBERSHIP" ||
      defaultPolicyCode !== "VENDOR_FINANCE_VIEW_AND_RECORD" ||
      !isSafeNonNegativeInt(activeMemberCount) ||
      teamCount !== null ||
      activeTeamCount !== null
    ) {
      return null;
    }
  } else {
    if (
      membershipMode !== "READ_ONLY_TEAMS_PROJECTION" ||
      defaultPolicyCode !== "EXISTING_TEAM_AUTHORITY_READ_ONLY" ||
      activeMemberCount !== null ||
      !isSafeNonNegativeInt(teamCount) ||
      !isSafeNonNegativeInt(activeTeamCount) ||
      activeTeamCount > teamCount
    ) {
      return null;
    }
  }

  return {
    department_id: departmentId,
    system_key: systemKey,
    code,
    name,
    is_active: isActive,
    membership_mode: membershipMode,
    default_policy_code: defaultPolicyCode,
    active_member_count: activeMemberCount,
    team_count: teamCount,
    active_team_count: activeTeamCount,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function projectDepartmentListEnvelope(payload: unknown): DepartmentListProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ["ok", "authorization_date", "departments"]) ||
    payload.ok !== true ||
    !isValidIsoCalendarDate(payload.authorization_date) ||
    !Array.isArray(payload.departments)
  ) {
    return null;
  }

  const departments: DepartmentProjection[] = [];
  for (const raw of payload.departments) {
    const item = projectDepartmentProjectionItem(raw);
    if (!item) return null;
    departments.push(item);
  }

  return {
    authorization_date: payload.authorization_date,
    departments,
  };
}

export function projectDepartmentDetailEnvelope(
  payload: unknown,
  expectedDepartmentId?: string,
): DepartmentDetailProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ["ok", "authorization_date", "department"]) ||
    payload.ok !== true ||
    !isValidIsoCalendarDate(payload.authorization_date)
  ) {
    return null;
  }

  const department = projectDepartmentProjectionItem(payload.department);
  if (!department) return null;

  if (expectedDepartmentId !== undefined) {
    const normalizedExpected = normalizeDepartmentUuid(expectedDepartmentId);
    if (!normalizedExpected || department.department_id !== normalizedExpected) {
      return null;
    }
  }

  return {
    authorization_date: payload.authorization_date,
    department,
  };
}

export function isReservedVendorTeam(team: { code: string }): boolean {
  return team.code === RESERVED_VENDOR_TEAM_CODE;
}

export function visibleRecruitmentTeams(
  teams: readonly RecruitmentTeamProjection[],
): RecruitmentTeamProjection[] {
  return teams.filter((team) => !isReservedVendorTeam(team));
}

export function projectRecruitmentTeamsEnvelope(
  payload: unknown,
  query: RecruitmentTeamsQuery,
  expectedDepartmentId?: string,
): RecruitmentTeamListProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "ok",
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
    ]) ||
    payload.ok !== true
  ) {
    return null;
  }

  const departmentId = normalizeDepartmentUuid(payload.department_id);
  const expectedSearch = normalizeQuerySearch(query.search);
  if (
    !expectedSearch.ok ||
    !isValidIsoCalendarDate(payload.authorization_date) ||
    !departmentId ||
    payload.system_key !== "RECRUITMENT" ||
    typeof payload.include_inactive !== "boolean" ||
    payload.include_inactive !== query.includeInactive ||
    (payload.search !== null &&
      !isNonEmptyDisplayString(payload.search, DEPARTMENT_UI_MAX_SEARCH_LENGTH)) ||
    payload.search !== expectedSearch.value ||
    !isSafePositiveInt(payload.page) ||
    payload.page !== query.page ||
    !isSafePositiveInt(payload.page_size) ||
    payload.page_size !== DEPARTMENT_UI_PAGE_SIZE ||
    !isSafeNonNegativeInt(payload.total) ||
    typeof payload.has_more !== "boolean" ||
    !Array.isArray(payload.teams) ||
    payload.teams.length > payload.page_size
  ) {
    return null;
  }

  if (expectedDepartmentId !== undefined) {
    const normalizedExpected = normalizeDepartmentUuid(expectedDepartmentId);
    if (!normalizedExpected || departmentId !== normalizedExpected) {
      return null;
    }
  }

  const teams: RecruitmentTeamProjection[] = [];
  for (const raw of payload.teams) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["team_id", "code", "display_name", "active", "version"])
    ) {
      return null;
    }
    const teamId = normalizeDepartmentUuid(raw.team_id);
    if (
      !teamId ||
      typeof raw.code !== "string" ||
      raw.code.trim().length === 0 ||
      raw.code === RESERVED_VENDOR_TEAM_CODE ||
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
    authorization_date: payload.authorization_date,
    department_id: departmentId,
    system_key: "RECRUITMENT",
    include_inactive: payload.include_inactive,
    search: payload.search,
    page: payload.page,
    page_size: payload.page_size,
    total: payload.total,
    has_more: payload.has_more,
    teams,
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

export function projectAccountingMembershipProjectionItem(
  value: unknown,
): AccountingMembershipProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, MEMBERSHIP_PROJECTION_KEYS)) {
    return null;
  }

  const membershipId = normalizeDepartmentUuid(value.membership_id);
  const departmentId = normalizeDepartmentUuid(value.department_id);
  const accountRef = normalizeDepartmentUuid(value.account_ref);
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

export function projectAccountingMembershipsEnvelope(
  payload: unknown,
  query: AccountingMembershipsQuery,
  expectedDepartmentId?: string,
): AccountingMembershipListProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "ok",
      "authorization_date",
      "department_id",
      "include_history",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "memberships",
    ]) ||
    payload.ok !== true
  ) {
    return null;
  }

  const departmentId = normalizeDepartmentUuid(payload.department_id);
  const expectedSearch = normalizeQuerySearch(query.search);
  if (
    !expectedSearch.ok ||
    !isValidIsoCalendarDate(payload.authorization_date) ||
    !departmentId ||
    typeof payload.include_history !== "boolean" ||
    payload.include_history !== query.includeHistory ||
    (payload.search !== null &&
      !isNonEmptyDisplayString(payload.search, DEPARTMENT_UI_MAX_SEARCH_LENGTH)) ||
    payload.search !== expectedSearch.value ||
    !isSafePositiveInt(payload.page) ||
    payload.page !== query.page ||
    !isSafePositiveInt(payload.page_size) ||
    payload.page_size !== DEPARTMENT_UI_PAGE_SIZE ||
    !isSafeNonNegativeInt(payload.total) ||
    typeof payload.has_more !== "boolean" ||
    !Array.isArray(payload.memberships) ||
    payload.memberships.length > payload.page_size
  ) {
    return null;
  }

  if (expectedDepartmentId !== undefined) {
    const normalizedExpected = normalizeDepartmentUuid(expectedDepartmentId);
    if (!normalizedExpected || departmentId !== normalizedExpected) {
      return null;
    }
  }

  const memberships: AccountingMembershipProjection[] = [];
  for (const raw of payload.memberships) {
    const item = projectAccountingMembershipProjectionItem(raw);
    if (!item || item.department_id !== departmentId) return null;
    memberships.push(item);
  }

  return {
    authorization_date: payload.authorization_date,
    department_id: departmentId,
    include_history: payload.include_history,
    search: payload.search,
    page: payload.page,
    page_size: payload.page_size,
    total: payload.total,
    has_more: payload.has_more,
    memberships,
  };
}

export function projectAccountingCandidateProjectionItem(
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

  const accountRef = normalizeDepartmentUuid(value.account_ref);
  const openMembershipId =
    value.open_membership_id === null
      ? null
      : normalizeDepartmentUuid(value.open_membership_id);

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

export function projectAccountingCandidatesEnvelope(
  payload: unknown,
  query: AccountingCandidatesQuery,
  expectedDepartmentId?: string,
): AccountingCandidateListProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "ok",
      "authorization_date",
      "department_id",
      "search",
      "page",
      "page_size",
      "total",
      "has_more",
      "candidates",
    ]) ||
    payload.ok !== true
  ) {
    return null;
  }

  const departmentId = normalizeDepartmentUuid(payload.department_id);
  const expectedSearch = normalizeQuerySearch(query.search);
  if (
    !expectedSearch.ok ||
    !isValidIsoCalendarDate(payload.authorization_date) ||
    !departmentId ||
    (payload.search !== null &&
      !isNonEmptyDisplayString(payload.search, DEPARTMENT_UI_MAX_SEARCH_LENGTH)) ||
    payload.search !== expectedSearch.value ||
    !isSafePositiveInt(payload.page) ||
    payload.page !== query.page ||
    !isSafePositiveInt(payload.page_size) ||
    payload.page_size !== DEPARTMENT_UI_PAGE_SIZE ||
    !isSafeNonNegativeInt(payload.total) ||
    typeof payload.has_more !== "boolean" ||
    !Array.isArray(payload.candidates) ||
    payload.candidates.length > payload.page_size
  ) {
    return null;
  }

  if (expectedDepartmentId !== undefined) {
    const normalizedExpected = normalizeDepartmentUuid(expectedDepartmentId);
    if (!normalizedExpected || departmentId !== normalizedExpected) {
      return null;
    }
  }

  const candidates: AccountingCandidateProjection[] = [];
  for (const raw of payload.candidates) {
    const item = projectAccountingCandidateProjectionItem(raw);
    if (!item) return null;
    candidates.push(item);
  }

  return {
    authorization_date: payload.authorization_date,
    department_id: departmentId,
    search: payload.search,
    page: payload.page,
    page_size: payload.page_size,
    total: payload.total,
    has_more: payload.has_more,
    candidates,
  };
}

export function projectAccountingMembershipMutationEnvelope(
  payload: unknown,
): AccountingMembershipMutationProjection | null {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ["ok", "replayed", "membership"]) ||
    payload.ok !== true ||
    typeof payload.replayed !== "boolean"
  ) {
    return null;
  }

  const membership = projectAccountingMembershipProjectionItem(payload.membership);
  if (!membership) return null;

  return {
    replayed: payload.replayed,
    membership,
  };
}

function validateRequiredDepartmentReason(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Vui lòng nhập lý do thao tác." };
  }
  if (trimmed.length > DEPARTMENT_UI_MAX_REASON_LENGTH) {
    return { ok: false, message: "Lý do thao tác không được vượt quá 4.000 ký tự." };
  }
  if (REASON_CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, message: "Lý do thao tác không được chứa ký tự điều khiển." };
  }
  return { ok: true, value: trimmed };
}

export function newDepartmentIdempotencyKey(): string {
  return newIdempotencyKey();
}

function resolveDepartmentUiBusinessToday(authorizationDate?: string | null): string {
  if (typeof authorizationDate === "string" && isValidIsoCalendarDate(authorizationDate)) {
    return authorizationDate;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildAssignAccountingMemberRequest(input: {
  accountRef: string;
  expectedPairVersion: number;
  authorizationDate?: string | null;
  effectiveFrom?: string | null;
  reason: string;
  idempotencyKey: string;
}): AssignAccountingMemberRequestResult {
  const accountRef = normalizeDepartmentUuid(input.accountRef);
  if (!accountRef) {
    return { ok: false, message: "Vui lòng chọn một tài khoản hợp lệ từ danh sách ứng viên." };
  }

  if (!isSafeNonNegativeInt(input.expectedPairVersion)) {
    return { ok: false, message: "Phiên bản đồng bộ tài khoản không hợp lệ. Vui lòng tải lại danh sách ứng viên." };
  }

  const businessToday = resolveDepartmentUiBusinessToday(input.authorizationDate);
  const rawEffectiveFrom = typeof input.effectiveFrom === "string" ? input.effectiveFrom.trim() : "";
  let effectiveFrom: string | null = null;
  if (rawEffectiveFrom.length > 0) {
    if (!isValidIsoCalendarDate(rawEffectiveFrom)) {
      return { ok: false, message: "Ngày bắt đầu hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
    }
    if (rawEffectiveFrom !== businessToday) {
      return {
        ok: false,
        message: `Ngày bắt đầu hiệu lực phải trùng với ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    effectiveFrom = rawEffectiveFrom;
  }

  const reasonCheck = validateRequiredDepartmentReason(input.reason);
  if (!reasonCheck.ok) {
    return reasonCheck;
  }

  const idempotencyKey = normalizeDepartmentUuid(input.idempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, message: "Khóa chống gửi trùng không hợp lệ. Vui lòng thử lại." };
  }

  return {
    ok: true,
    idempotencyKey,
    body: {
      account_ref: accountRef,
      expected_pair_version: input.expectedPairVersion,
      effective_from: effectiveFrom,
      reason: reasonCheck.value,
      idempotency_key: idempotencyKey,
    },
  };
}

export function buildEndAccountingMemberRequest(input: {
  membershipId: string;
  expectedPairVersion: number;
  membershipState: DepartmentMembershipState;
  validFrom: string;
  authorizationDate?: string | null;
  effectiveTo?: string | null;
  reason: string;
  idempotencyKey: string;
}): EndAccountingMemberRequestResult {
  const membershipId = normalizeDepartmentUuid(input.membershipId);
  if (!membershipId) {
    return { ok: false, message: "Bản ghi thành viên không hợp lệ. Vui lòng tải lại danh sách." };
  }

  if (input.membershipState === "HISTORY") {
    return { ok: false, message: "Tư cách thành viên này đã kết thúc trước đó." };
  }

  if (!isSafePositiveInt(input.expectedPairVersion)) {
    return { ok: false, message: "Phiên bản đồng bộ thành viên không hợp lệ. Vui lòng tải lại danh sách." };
  }

  if (!isValidIsoCalendarDate(input.validFrom)) {
    return { ok: false, message: "Dữ liệu ngày bắt đầu không hợp lệ. Vui lòng tải lại danh sách." };
  }

  const businessToday = resolveDepartmentUiBusinessToday(input.authorizationDate);
  const rawEffectiveTo = typeof input.effectiveTo === "string" ? input.effectiveTo.trim() : "";
  let effectiveTo: string | null = null;
  if (rawEffectiveTo.length > 0) {
    if (input.membershipState === "SCHEDULED") {
      return {
        ok: false,
        message: "Bản ghi sắp hiệu lực sẽ được hủy ngay khi xác nhận, không chọn ngày kết thúc riêng.",
      };
    }
    if (!isValidIsoCalendarDate(rawEffectiveTo)) {
      return { ok: false, message: "Ngày kết thúc hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
    }
    if (rawEffectiveTo < input.validFrom) {
      return {
        ok: false,
        message: `Ngày kết thúc không được nhỏ hơn ngày bắt đầu hiệu lực (${input.validFrom}).`,
      };
    }
    if (rawEffectiveTo !== businessToday) {
      return {
        ok: false,
        message: `Ngày kết thúc hiệu lực phải trùng với ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    effectiveTo = rawEffectiveTo;
  }

  const reasonCheck = validateRequiredDepartmentReason(input.reason);
  if (!reasonCheck.ok) {
    return reasonCheck;
  }

  const idempotencyKey = normalizeDepartmentUuid(input.idempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, message: "Khóa chống gửi trùng không hợp lệ. Vui lòng thử lại." };
  }

  return {
    ok: true,
    membershipId,
    idempotencyKey,
    body: {
      expected_pair_version: input.expectedPairVersion,
      effective_to: effectiveTo,
      reason: reasonCheck.value,
      idempotency_key: idempotencyKey,
    },
  };
}

function extractDepartmentErrorCode(payload: unknown): DepartmentErrorCode | "NOT_FOUND" | null {
  if (!isRecord(payload) || payload.ok !== false || typeof payload.code !== "string") {
    return null;
  }
  return payload.code as DepartmentErrorCode | "NOT_FOUND";
}

export function classifyDepartmentReadError(
  status: number,
  payload: unknown,
): DepartmentReadFailure {
  const code = extractDepartmentErrorCode(payload);

  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      message: "Phiên đăng nhập không còn hiệu lực. Vui lòng đăng nhập lại.",
      retryable: false,
    };
  }

  if (
    status === 403 ||
    code === "DEPARTMENT_ACCESS_DENIED" ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "CSRF_REJECTED"
  ) {
    return {
      kind: "denied",
      message: "Chỉ Full Admin được phép xem và quản trị Phòng ban.",
      retryable: false,
    };
  }

  if (status === 404) {
    if (code === "NOT_FOUND") {
      return {
        kind: "unavailable",
        message: "Dịch vụ quản trị Phòng ban hiện chưa được kích hoạt trên môi trường này.",
        retryable: true,
      };
    }
    return {
      kind: "not-found",
      message: "Không tìm thấy phòng ban theo đường dẫn yêu cầu.",
      retryable: false,
    };
  }

  if (status === 400 || status === 422) {
    if (code === "DEPARTMENT_SEARCH_INVALID") {
      return {
        kind: "invalid",
        message: "Từ khóa tìm kiếm không hợp lệ (tối đa 120 ký tự, không chứa ký tự điều khiển).",
        retryable: true,
      };
    }
    return {
      kind: "invalid",
      message: "Tham số truy vấn Phòng ban không hợp lệ.",
      retryable: true,
    };
  }

  return {
    kind: "unavailable",
    message: "Không thể tải dữ liệu Phòng ban lúc này. Vui lòng thử lại.",
    retryable: true,
  };
}

export function classifyDepartmentMutationResponse(
  status: number,
  payload: unknown,
  operation: "assign" | "end",
): DepartmentMutationOutcome {
  if (status === 200 || (operation === "assign" && status === 201)) {
    const projected = projectAccountingMembershipMutationEnvelope(payload);
    if (!projected) {
      return {
        kind: "unavailable",
        message: "Phản hồi máy chủ không đúng định dạng chuẩn. Vui lòng tải lại danh sách để kiểm tra.",
        resetIdempotencyKey: true,
      };
    }
    const actionLabel =
      operation === "assign"
        ? projected.replayed
          ? `Thao tác gán ${projected.membership.display_name} đã được ghi nhận trước đó.`
          : `Đã gán ${projected.membership.display_name} vào Phòng Kế toán.`
        : projected.replayed
          ? `Thao tác kết thúc tư cách thành viên của ${projected.membership.display_name} đã được ghi nhận trước đó.`
          : `Đã kết thúc tư cách thành viên của ${projected.membership.display_name} tại Phòng Kế toán.`;
    return {
      kind: "applied",
      replayed: projected.replayed,
      membership: projected.membership,
      message: actionLabel,
    };
  }

  const code = extractDepartmentErrorCode(payload);

  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      message: "Phiên đăng nhập không còn hiệu lực. Vui lòng đăng nhập lại.",
      resetIdempotencyKey: false,
    };
  }

  if (
    status === 403 ||
    code === "DEPARTMENT_ACCESS_DENIED" ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "CSRF_REJECTED"
  ) {
    return {
      kind: "denied",
      message: "Bạn không có quyền thực hiện thao tác quản trị Phòng ban này.",
      resetIdempotencyKey: true,
    };
  }

  if (status === 404) {
    if (code === "TARGET_ACCOUNT_NOT_FOUND") {
      return {
        kind: "not-found",
        message: "Không tìm thấy tài khoản được chọn. Vui lòng tải lại danh sách ứng viên.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_MEMBERSHIP_NOT_FOUND") {
      return {
        kind: "not-found",
        message: "Không tìm thấy bản ghi thành viên Phòng Kế toán. Vui lòng tải lại danh sách.",
        resetIdempotencyKey: true,
      };
    }
    return {
      kind: "not-found",
      message: "Không tìm thấy dữ liệu Phòng ban hoặc tính năng chưa được bật.",
      resetIdempotencyKey: true,
    };
  }

  if (status === 409) {
    if (code === "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT") {
      return {
        kind: "conflict",
        message: "Dữ liệu thành viên đã thay đổi ở phiên làm việc khác. Vui lòng tải lại dữ liệu mới nhất trước khi tiếp tục.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_MEMBERSHIP_OVERLAP") {
      return {
        kind: "conflict",
        message: "Tài khoản này đã là thành viên hoặc có khoảng thời gian hiệu lực trùng lặp tại Phòng Kế toán.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_MEMBERSHIP_ALREADY_ENDED") {
      return {
        kind: "conflict",
        message: "Tư cách thành viên này đã được kết thúc trước đó. Vui lòng tải lại danh sách.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "TARGET_ACCOUNT_DISABLED") {
      return {
        kind: "conflict",
        message: "Tài khoản được chọn đang ngừng hoạt động nên không thể gán vào Phòng Kế toán.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "IDEMPOTENCY_CONFLICT") {
      return {
        kind: "conflict",
        message: "Khóa chống gửi trùng đã gắn với yêu cầu khác. Hệ thống đã làm mới khóa, vui lòng gửi lại.",
        resetIdempotencyKey: true,
      };
    }
    return {
      kind: "conflict",
      message: "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi thực hiện tiếp.",
      resetIdempotencyKey: true,
    };
  }

  if (status === 400 || status === 413 || status === 422) {
    if (code === "DEPARTMENT_MEMBERSHIP_REASON_INVALID") {
      return {
        kind: "invalid",
        message: "Lý do thao tác là bắt buộc (1–4.000 ký tự, không chứa ký tự điều khiển).",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID") {
      return {
        kind: "invalid",
        message: "Ngày hiệu lực không hợp lệ so với khoảng thời gian cho phép.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_MEMBERSHIP_UNSUPPORTED") {
      return {
        kind: "invalid",
        message: "Phòng ban này không hỗ trợ gán thành viên trực tiếp.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "DEPARTMENT_INACTIVE") {
      return {
        kind: "invalid",
        message: "Phòng Kế toán hiện đang ngừng hoạt động nên không thể gán thêm thành viên.",
        resetIdempotencyKey: true,
      };
    }
    if (code === "BODY_TOO_LARGE") {
      return {
        kind: "invalid",
        message: "Nội dung yêu cầu vượt giới hạn kích thước cho phép.",
        resetIdempotencyKey: true,
      };
    }
    return {
      kind: "invalid",
      message: "Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra lại các trường.",
      resetIdempotencyKey: true,
    };
  }

  return {
    kind: "unavailable",
    message: "Dịch vụ tạm thời không khả dụng. Có thể thử lại cùng thao tác một cách an toàn.",
    resetIdempotencyKey: false,
  };
}

export function departmentDefaultPolicyDescription(
  department: Pick<DepartmentProjection, "system_key" | "default_policy_code">,
): string {
  const policyCode: DepartmentDefaultPolicyCode = department.default_policy_code;
  if (
    department.system_key === "ACCOUNTING" ||
    policyCode === "VENDOR_FINANCE_VIEW_AND_RECORD"
  ) {
    return ACCOUNTING_DEFAULT_POLICY_DESCRIPTION;
  }
  return RECRUITMENT_DEFAULT_POLICY_DESCRIPTION;
}

export function canManageDepartmentMemberships(
  department: Pick<DepartmentProjection, "system_key" | "membership_mode" | "is_active">,
): boolean {
  return (
    department.system_key === "ACCOUNTING" &&
    department.membership_mode === "MANAGED_MEMBERSHIP" &&
    department.is_active === true
  );
}

export function departmentScaleSummary(department: DepartmentProjection): string {
  if (department.system_key === "RECRUITMENT") {
    const active = department.active_team_count ?? 0;
    const total = department.team_count ?? 0;
    return `${active} / ${total} nhóm hoạt động`;
  }
  return `${department.active_member_count ?? 0} thành viên đang hiệu lực`;
}

export function departmentMembershipModeLabel(department: DepartmentProjection): string {
  return department.system_key === "ACCOUNTING"
    ? "Quản lý thành viên"
    : "Chỉ đọc danh sách Nhóm";
}

export function membershipStateBadge(state: DepartmentMembershipState): {
  label: string;
  tone: BadgeTone;
} {
  switch (state) {
    case "CURRENT":
      return { label: "Đang hiệu lực", tone: "success" };
    case "SCHEDULED":
      return { label: "Sắp hiệu lực", tone: "warning" };
    case "HISTORY":
      return { label: "Lịch sử", tone: "neutral" };
  }
}

export function isCandidateAssignable(candidate: AccountingCandidateProjection): boolean {
  return (
    candidate.account_enabled === true &&
    candidate.has_active_membership === false &&
    candidate.open_membership_id === null
  );
}

export function candidateAvailabilityBadge(candidate: AccountingCandidateProjection): {
  label: string;
  tone: BadgeTone;
} {
  if (!candidate.account_enabled) {
    return { label: "Tài khoản ngừng hoạt động", tone: "neutral" };
  }
  if (candidate.has_active_membership) {
    return { label: "Đang là thành viên", tone: "info" };
  }
  if (candidate.open_membership_id !== null) {
    return { label: "Đã có lịch tham gia", tone: "warning" };
  }
  return { label: "Có thể gán", tone: "success" };
}

export function formatAccountSecondaryMeta(account: {
  login_id: string | null;
  personnel_code: string | null;
}): string | null {
  const parts: string[] = [];
  if (account.login_id) {
    parts.push(`Tài khoản: ${account.login_id}`);
  }
  if (account.personnel_code && account.personnel_code !== account.login_id) {
    parts.push(`Mã NS: ${account.personnel_code}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
