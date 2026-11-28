/**
 * Strict projections and pure UI request/response helpers for Collaborator (CTV)
 * master catalog administration.
 *
 * Server remains sole authority: every projection is fail-closed on missing/extra
 * keys or invalid field types. Never exposes actor, capability, scope, or raw DB errors.
 */
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "./project-operations-model.ts";

export const COLLABORATOR_ID_MAX = 128;
export const COLLABORATOR_NAME_MAX = 256;
export const COLLABORATOR_SEARCH_MAX = 256;
export const COLLABORATOR_REASON_MAX = 4000;
export const COLLABORATOR_LIST_PAGE_SIZE = 25;
export const COLLABORATOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const RESERVED_COLLABORATOR_ID = "__system_vendor__";

export type AdminCollaborator = {
  collaborator_id: string;
  display_name: string;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type AdminCollaboratorList = {
  items: readonly AdminCollaborator[];
  total: number;
  page: number;
  page_size: number;
};

export type AdminCollaboratorMutation = {
  collaborator_id: string;
  display_name: string;
  active: boolean;
  version: number;
};

export type CollaboratorListQuery = {
  search: string;
  includeInactive: boolean;
  page: number;
};

export type CollaboratorMutationOutcome =
  | { kind: "applied"; collaborator: AdminCollaboratorMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const ITEM_KEYS = [
  "collaborator_id",
  "display_name",
  "active",
  "version",
  "created_at",
  "updated_at",
] as const;

const LIST_KEYS = ["items", "total", "page", "page_size"] as const;

const MUTATION_KEYS = [
  "collaborator_id",
  "display_name",
  "active",
  "version",
] as const;

/** Collaborator detail/list item projection (6 keys). */
export function collaboratorCatalogItem(value: unknown): AdminCollaborator | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const collaborator_id = str(value.collaborator_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const created_at = str(value.created_at);
  const updated_at = str(value.updated_at);
  if (
    collaborator_id === null ||
    !COLLABORATOR_ID_PATTERN.test(collaborator_id) ||
    collaborator_id === RESERVED_COLLABORATOR_ID ||
    display_name === null ||
    active === null ||
    version === null ||
    version < 1 ||
    created_at === null ||
    updated_at === null
  ) {
    return null;
  }
  return { collaborator_id, display_name, active, version, created_at, updated_at };
}

/** Collaborator list projection (4 keys). */
export function collaboratorCatalogList(value: unknown): AdminCollaboratorList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const total = int(value.total);
  const page = int(value.page);
  const page_size = int(value.page_size);
  if (
    total === null ||
    page === null ||
    page < 1 ||
    page_size === null ||
    page_size < 1 ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items: AdminCollaborator[] = [];
  for (const entry of value.items) {
    const item = collaboratorCatalogItem(entry);
    if (!item) return null;
    items.push(item);
  }
  if (total < items.length) return null;
  return { items, total, page, page_size };
}

/** Collaborator create/update/set_active projection (4 keys). */
export function collaboratorCatalogMutation(value: unknown): AdminCollaboratorMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  const collaborator_id = str(value.collaborator_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  if (
    collaborator_id === null ||
    !COLLABORATOR_ID_PATTERN.test(collaborator_id) ||
    collaborator_id === RESERVED_COLLABORATOR_ID ||
    display_name === null ||
    active === null ||
    version === null ||
    version < 1
  ) {
    return null;
  }
  return { collaborator_id, display_name, active, version };
}

export function projectCollaboratorListForQuery(
  payload: unknown,
  query: CollaboratorListQuery,
): AdminCollaboratorList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = collaboratorCatalogList(payload.list);
  if (!list) return null;
  if (list.page !== query.page || list.page_size !== COLLABORATOR_LIST_PAGE_SIZE) {
    return null;
  }
  return list;
}

export function projectCollaboratorItem(payload: unknown): AdminCollaborator | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "collaborator"]) || payload.ok !== true) {
    return null;
  }
  return collaboratorCatalogItem(payload.collaborator);
}

export function projectCollaboratorMutation(payload: unknown): AdminCollaboratorMutation | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "collaborator"]) || payload.ok !== true) {
    return null;
  }
  return collaboratorCatalogMutation(payload.collaborator);
}

export function buildCollaboratorListQuery(input: CollaboratorListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (
    search.length > COLLABORATOR_SEARCH_MAX ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 1000
  ) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(COLLABORATOR_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

function validateCollaboratorId(value: string): string | null {
  const id = value.trim();
  if (!id) return "Mã cộng tác viên là bắt buộc.";
  if (
    id.length > COLLABORATOR_ID_MAX ||
    !COLLABORATOR_ID_PATTERN.test(id) ||
    id === RESERVED_COLLABORATOR_ID
  ) {
    return "Mã cộng tác viên không hợp lệ.";
  }
  return null;
}

function validateCollaboratorDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên cộng tác viên là bắt buộc.";
  if (name.length > COLLABORATOR_NAME_MAX) return "Tên cộng tác viên tối đa 256 ký tự.";
  return null;
}

export function buildCollaboratorCreateRequest(input: {
  collaboratorId: string;
  displayName: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    validateCollaboratorId(input.collaboratorId) ??
    validateCollaboratorDisplayName(input.displayName) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      collaborator_id: input.collaboratorId.trim(),
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildCollaboratorUpdateRequest(input: {
  displayName: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    validateCollaboratorDisplayName(input.displayName) ??
    validateVersion(input.expectedVersion) ??
    (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildCollaboratorSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    typeof input.active !== "boolean"
      ? "Trạng thái không hợp lệ."
      : validateVersion(input.expectedVersion) ??
        (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null) ??
        validateReason(input.reason) ??
        validateUuid(input.idempotencyKey);
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

export function classifyCollaboratorMutation(
  status: number,
  payload: unknown,
): CollaboratorMutationOutcome {
  if (status === 200) {
    const collaborator = projectCollaboratorMutation(payload);
    return collaborator
      ? { kind: "applied", collaborator }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Cộng tác viên không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Cộng tác viên đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) {
    return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  }
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newCollaboratorIntentKey(): string {
  return newIdempotencyKey();
}

export function collaboratorListConfirmsId(
  list: AdminCollaboratorList,
  collaboratorId: string,
): boolean {
  return list.items.some((item) => item.collaborator_id === collaboratorId);
}
