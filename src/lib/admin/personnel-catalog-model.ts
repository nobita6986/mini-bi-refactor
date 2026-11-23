import {
  personnelCatalogCreateResult,
  personnelCatalogItem,
  personnelCatalogList,
  personnelCatalogMutation,
  type AdminPersonnel,
  type AdminPersonnelCreateResult,
  type AdminPersonnelList,
  type AdminPersonnelMutation,
  type PersonnelPosition,
} from "../direct-entry/personnel-catalog-contract.ts";
import { parseIsoDate } from "../direct-entry/direct-entry-date-format.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

export const PERSONNEL_PAGE_SIZE = 25;
const PERSONNEL_CODE_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,64}$/;

export type PersonnelListQuery = {
  search: string;
  teamId?: string | null;
  includeInactive: boolean;
  page: number;
};

export type PersonnelMutationOutcome =
  | { kind: "applied"; personnel: AdminPersonnel | AdminPersonnelCreateResult | AdminPersonnelMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildPersonnelListQuery(input: PersonnelListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > 256 || !Number.isSafeInteger(input.page) || input.page < 1 ||
      input.page > 1000) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(PERSONNEL_PAGE_SIZE),
  });
  if (input.teamId != null) {
    if (validateUuid(input.teamId)) return null;
    query.set("team_id", input.teamId.trim());
  }
  if (search) query.set("search", search);
  return query;
}

export function projectPersonnelList(payload: unknown): AdminPersonnelList | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join(",") !== "list,ok" ||
      payload.ok !== true) {
    return null;
  }
  return personnelCatalogList(payload.list);
}

export function projectPersonnelListForQuery(
  payload: unknown,
  query: PersonnelListQuery,
): AdminPersonnelList | null {
  const list = projectPersonnelList(payload);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  return list.page_size === PERSONNEL_PAGE_SIZE &&
    list.page === query.page &&
    list.include_inactive === query.includeInactive &&
    list.search === expectedSearch
    ? list
    : null;
}

export function projectPersonnelItem(payload: unknown): AdminPersonnel | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join(",") !== "ok,personnel" ||
      payload.ok !== true) {
    return null;
  }
  return personnelCatalogItem(payload.personnel);
}

export function projectPersonnelCreate(payload: unknown): AdminPersonnelCreateResult | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join(",") !== "ok,personnel" ||
      payload.ok !== true) {
    return null;
  }
  return personnelCatalogCreateResult(payload.personnel);
}

export function projectPersonnelMutation(payload: unknown): AdminPersonnelMutation | null {
  if (!isRecord(payload) || Object.keys(payload).sort().join(",") !== "ok,personnel" ||
      payload.ok !== true) {
    return null;
  }
  return personnelCatalogMutation(payload.personnel);
}

export function validatePersonnelCode(value: string): string | null {
  const code = value.trim();
  return PERSONNEL_CODE_PATTERN.test(code)
    ? null
    : "Mã nhân sự bắt buộc, không chứa khoảng trắng hoặc ký tự điều khiển, tối đa 64 ký tự.";
}

function validateName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên nhân sự là bắt buộc.";
  if (name.length > 256) return "Tên nhân sự tối đa 256 ký tự.";
  return null;
}

function validatePosition(value: string): value is PersonnelPosition {
  return value === "STAFF" || value === "TEAM_LEADER";
}

export function buildPersonnelCreateRequest(input: {
  personnelCode: string;
  displayName: string;
  personnelPosition: string;
  validFrom: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validatePersonnelCode(input.personnelCode) ?? validateName(input.displayName)
    ?? (validatePosition(input.personnelPosition) ? null : "Vị trí nhân sự không hợp lệ.")
    ?? (parseIsoDate(input.validFrom) ? null : "Ngày hiệu lực HRP không hợp lệ.")
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      personnel_code: input.personnelCode.trim(),
      display_name: input.displayName.trim(),
      personnel_position: input.personnelPosition,
      valid_from: input.validFrom,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildPersonnelUpdateRequest(input: {
  personnelCode: string;
  displayName: string;
  personnelPosition: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validatePersonnelCode(input.personnelCode) ?? validateName(input.displayName)
    ?? (validatePosition(input.personnelPosition) ? null : "Vị trí nhân sự không hợp lệ.")
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null) ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      personnel_code: input.personnelCode.trim(),
      display_name: input.displayName.trim(),
      personnel_position: input.personnelPosition,
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildPersonnelSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = typeof input.active !== "boolean"
    ? "Trạng thái không hợp lệ."
    : validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null) ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      active: input.active,
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyPersonnelMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): PersonnelMutationOutcome {
  if (status === 200) {
    const personnel = operation === "create"
      ? projectPersonnelCreate(payload)
      : projectPersonnelMutation(payload);
    return personnel
      ? { kind: "applied", personnel }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Hồ sơ nhân sự không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Hồ sơ đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function setPersonnelConflictLock(
  locks: ReadonlySet<string>,
  recruiterId: string,
  locked: boolean,
): Set<string> {
  const next = new Set(locks);
  if (locked) next.add(recruiterId);
  else next.delete(recruiterId);
  return next;
}

export function personnelConflictsForDialog<T>(
  conflicts: ReadonlyMap<string, T>,
  lockId: string | null,
): T[] {
  const conflict = lockId === null ? undefined : conflicts.get(lockId);
  return conflict === undefined ? [] : [conflict];
}

export function newPersonnelIntentKey(): string {
  return newIdempotencyKey();
}
