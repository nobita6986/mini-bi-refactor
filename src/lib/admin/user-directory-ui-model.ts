/**
 * PR #28 — Pure, browser-safe UI model for the Unified User Directory.
 *
 * Uses `GET /api/admin/organization/user-directory` and
 * `GET /api/admin/organization/user-directory/detail` as the single source of truth
 * for employee records (with/without login), legacy unlinked personal accounts,
 * and unresolved link-conflict rows.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import {
  DEFAULT_ORG_PAGE_SIZE,
  SEARCH_MAX_LENGTH,
  isValidUuid,
} from "../organization/person-contract.ts";
import {
  projectGetUserDirectoryEntryResponse,
  projectListUserDirectoryResponse,
  USER_DIRECTORY_LOGIN_STATE_FILTERS,
  USER_DIRECTORY_PERSON_STATUS_FILTERS,
  USER_DIRECTORY_RECORD_KIND_FILTERS,
  type GetUserDirectoryEntryRpcProjection,
  type ListUserDirectoryRpcProjection,
  type UserDirectoryConflictReason,
  type UserDirectoryEntryDetail,
  type UserDirectoryEntrySummary,
  type UserDirectoryLoginState,
  type UserDirectoryLoginStateFilter,
  type UserDirectoryPersonStatusFilter,
  type UserDirectoryRecordKind,
  type UserDirectoryRecordKindFilter,
} from "../organization/user-directory-contract.ts";

export {
  DEFAULT_ORG_PAGE_SIZE,
  USER_DIRECTORY_LOGIN_STATE_FILTERS,
  USER_DIRECTORY_PERSON_STATUS_FILTERS,
  USER_DIRECTORY_RECORD_KIND_FILTERS,
  type GetUserDirectoryEntryRpcProjection,
  type ListUserDirectoryRpcProjection,
  type UserDirectoryConflictReason,
  type UserDirectoryEntryDetail,
  type UserDirectoryEntrySummary,
  type UserDirectoryLoginState,
  type UserDirectoryLoginStateFilter,
  type UserDirectoryPersonStatusFilter,
  type UserDirectoryRecordKind,
  type UserDirectoryRecordKindFilter,
};

export type UserDirectoryFilterState = {
  search: string;
  recordKind: UserDirectoryRecordKindFilter;
  personStatus: UserDirectoryPersonStatusFilter;
  loginState: UserDirectoryLoginStateFilter;
  departmentId: string | null;
  page: number;
  pageSize?: number;
};

export function parseInitialUserDirectoryRecordKind(
  raw: string | string[] | null | undefined,
): UserDirectoryRecordKindFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    value === "person" ||
    value === "unlinked_account" ||
    value === "conflict" ||
    value === "all"
  ) {
    return value;
  }
  return "all";
}

export function buildUserDirectoryQuery(filter: UserDirectoryFilterState): URLSearchParams | null {
  const trimmedSearch = filter.search.trim();
  if (trimmedSearch.length > SEARCH_MAX_LENGTH) return null;
  if (!Number.isSafeInteger(filter.page) || filter.page < 1 || filter.page > 1000) return null;
  const pageSize = filter.pageSize ?? DEFAULT_ORG_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return null;
  if (!(USER_DIRECTORY_RECORD_KIND_FILTERS as readonly string[]).includes(filter.recordKind)) {
    return null;
  }
  if (!(USER_DIRECTORY_PERSON_STATUS_FILTERS as readonly string[]).includes(filter.personStatus)) {
    return null;
  }
  if (!(USER_DIRECTORY_LOGIN_STATE_FILTERS as readonly string[]).includes(filter.loginState)) {
    return null;
  }
  if (filter.departmentId !== null && !isValidUuid(filter.departmentId)) {
    return null;
  }

  const params = new URLSearchParams({
    record_kind: filter.recordKind,
    person_status: filter.personStatus,
    login_state: filter.loginState,
    page: String(filter.page),
    page_size: String(pageSize),
  });
  if (trimmedSearch.length > 0) params.set("search", trimmedSearch);
  if (filter.departmentId !== null) params.set("department_id", filter.departmentId.toLowerCase());
  return params;
}

export function projectUserDirectoryListEnvelope(
  payload: unknown,
  expectedFilter?: UserDirectoryFilterState,
): ListUserDirectoryRpcProjection | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  const projected = projectListUserDirectoryResponse(rest);
  if (!projected) return null;
  if (expectedFilter) {
    const expectedSearch = expectedFilter.search.trim() || null;
    if (
      projected.search !== expectedSearch ||
      projected.record_kind !== expectedFilter.recordKind ||
      projected.person_status !== expectedFilter.personStatus ||
      projected.login_state !== expectedFilter.loginState ||
      projected.page !== expectedFilter.page
    ) {
      return null;
    }
  }
  return projected;
}

export function projectUserDirectoryEntryEnvelope(
  payload: unknown,
): GetUserDirectoryEntryRpcProjection | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  return projectGetUserDirectoryEntryResponse(rest);
}

export function resolveUserDirectoryDetailHref(entry: {
  person_id: string | null;
  account_ref: string | null;
  link_conflict: boolean;
  record_kind: UserDirectoryRecordKind;
}): string {
  if (
    entry.person_id &&
    !entry.link_conflict &&
    (entry.record_kind === "LINKED_PERSON_ACCOUNT" || entry.record_kind === "PERSON_ONLY")
  ) {
    return `/admin/organization/persons/${encodeURIComponent(entry.person_id)}`;
  }
  if (entry.account_ref) {
    return `/admin/organization/persons/account/${encodeURIComponent(entry.account_ref)}`;
  }
  if (entry.person_id) {
    return `/admin/organization/persons/${encodeURIComponent(entry.person_id)}`;
  }
  return "/admin/organization/persons";
}

export function userDirectoryWorkStatusBadge(entry: UserDirectoryEntrySummary): {
  label: string;
  tone: BadgeTone;
} {
  if (entry.link_conflict) {
    return { label: "Cần kiểm tra xung đột", tone: "warning" };
  }
  if (!entry.person) {
    return { label: "Tài khoản chưa gắn hồ sơ", tone: "info" };
  }
  if (entry.person.status === "ACTIVE") {
    return { label: "Đang làm việc", tone: "success" };
  }
  return { label: "Ngừng làm việc", tone: "neutral" };
}

export function userDirectoryLoginBadge(loginState: UserDirectoryLoginState): {
  label: string;
  tone: BadgeTone;
} {
  switch (loginState) {
    case "ENABLED":
      return { label: "Đang mở đăng nhập", tone: "success" };
    case "DISABLED":
      return { label: "Đã khóa đăng nhập", tone: "warning" };
    case "NO_ACCOUNT":
      return { label: "Chưa mở đăng nhập", tone: "neutral" };
  }
}

export function formatUserDirectoryConflictReason(reason: UserDirectoryConflictReason): string {
  switch (reason) {
    case "MULTIPLE_ACTIVE_LINKS_FOR_PERSON":
      return "Hồ sơ nhân viên này đang gắn với hơn một tài khoản đăng nhập cùng lúc. Hệ thống không tự gộp để tránh nhầm người.";
    case "MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT":
      return "Tài khoản đăng nhập này đang gắn với hơn một hồ sơ nhân viên cùng lúc. Hệ thống không tự chọn hồ sơ để tránh sai quyền.";
    case "ENDPOINT_LINK_CONFLICT":
      return "Thông tin gắn kết giữa hồ sơ và tài khoản đang có xung đột. Cần kiểm tra lại trước khi thay đổi định danh.";
    case "RECRUITER_IDENTITY_CONFLICT":
      return "Thông tin hồ sơ tuyển dụng gắn với tài khoản và nhân viên đang không trùng khớp.";
  }
}
