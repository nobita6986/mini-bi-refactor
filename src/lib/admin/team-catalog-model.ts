/**
 * P3.1-W04-A4 - Team Catalog UI model.
 *
 * Reuses the W01C-A contract projectors (src/lib/direct-entry/team-catalog-contract.ts)
 * and the Personnel/A1-A2 mutation intent helpers. No parallel validation, fetch,
 * OCC or idempotency framework: this module only owns the team-specific bounded
 * query builders, strict envelope projections and exact request bodies.
 *
 * Authority stays server-side. The client never derives permission, and the
 * Reserved Vendor system team is never rendered, never created and never
 * reachable through the generic update path (code is not part of that body).
 */
import {
  teamCatalogCreateResult,
  teamCatalogItem,
  teamCatalogList,
  teamCatalogMutation,
  type AdminTeam,
  type AdminTeamCreateResult,
  type AdminTeamList,
  type AdminTeamMutation,
} from "../direct-entry/team-catalog-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

/** Explicit page size; the API default must never be relied upon. */
export const TEAM_LIST_PAGE_SIZE = 25;

const SEARCH_MAX = 256;
const NAME_MAX = 256;
const CODE_MAX = 128;
/** W01C-A team code: business id, no whitespace and no control character. */
const TEAM_CODE_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f]+$/;
/** Canonical reserved Vendor system team code; never a business team. */
export const RESERVED_VENDOR_TEAM_CODE = "__system_vendor__";

export type TeamListQuery = {
  search: string;
  includeInactive: boolean;
  page: number;
};

export type TeamMutationOutcome =
  | { kind: "applied"; team: AdminTeam | AdminTeamCreateResult | AdminTeamMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function isReservedVendorTeam(team: { code: string }): boolean {
  return team.code === RESERVED_VENDOR_TEAM_CODE;
}

export type ActiveTeamSelectOption = {
  team_id: string;
  code: string;
  display_name: string;
  active: true;
};

/**
 * Projects active business teams from `GET /api/admin/catalog/teams` using the
 * canonical W01C-A contract (`teamCatalogList` / `teamCatalogItem` -> `display_name`).
 * Rejects malformed envelopes fail-closed (`{ ok: false }`) and excludes inactive
 * teams and the reserved `__system_vendor__` system team from new selections.
 */
export function parseActiveTeamCatalogOptions(
  payload: unknown,
): { ok: true; teams: ActiveTeamSelectOption[] } | { ok: false } {
  if (!isRecord(payload) || payload.ok !== true) return { ok: false };
  const list = teamCatalogList(payload.list);
  if (!list) return { ok: false };
  const teams: ActiveTeamSelectOption[] = [];
  for (const row of list.teams) {
    if (!row.active || isReservedVendorTeam(row)) continue;
    teams.push({
      team_id: row.team_id,
      code: row.code,
      display_name: row.display_name,
      active: true,
    });
  }
  return { ok: true, teams };
}

/**
 * Fail-closed list projection. A reserved Vendor row anywhere in the payload is
 * rejected as a whole: the UI never renders it and never silently drops rows.
 */
export function projectTeamListForQuery(
  payload: unknown,
  query: TeamListQuery,
): AdminTeamList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = teamCatalogList(payload.list);
  if (!list) return null;
  if (list.teams.some(isReservedVendorTeam)) return null;
  const expectedSearch = query.search.trim() || null;
  if (list.page !== query.page || list.page_size !== TEAM_LIST_PAGE_SIZE ||
      list.include_inactive !== query.includeInactive ||
      list.search !== expectedSearch) {
    return null;
  }
  return list;
}

/** A create-conflict reload is authoritative only if the exact code is present. */
export function teamListConfirmsCode(list: AdminTeamList, code: string): boolean {
  return list.teams.some((team) => team.code === code);
}

export function projectTeamItem(payload: unknown): AdminTeam | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "team"]) || payload.ok !== true) {
    return null;
  }
  const team = teamCatalogItem(payload.team);
  return team && !isReservedVendorTeam(team) ? team : null;
}

export function projectTeamCreate(payload: unknown): AdminTeamCreateResult | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "team"]) || payload.ok !== true) {
    return null;
  }
  const team = teamCatalogCreateResult(payload.team);
  return team && !isReservedVendorTeam(team) ? team : null;
}

export function projectTeamMutation(payload: unknown): AdminTeamMutation | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "team"]) || payload.ok !== true) {
    return null;
  }
  const team = teamCatalogMutation(payload.team);
  return team && !isReservedVendorTeam(team) ? team : null;
}

export function buildTeamListQuery(input: TeamListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > SEARCH_MAX || !Number.isSafeInteger(input.page) ||
      input.page < 1 || input.page > 1000) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(TEAM_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

export function validateTeamCode(value: string): string | null {
  const code = value.trim();
  if (!code) return "Mã nhóm là bắt buộc.";
  if (Array.from(code).length > CODE_MAX || !TEAM_CODE_PATTERN.test(code)) {
    return "Mã nhóm không được chứa khoảng trắng hoặc ký tự điều khiển, tối đa 128 ký tự.";
  }
  if (code === RESERVED_VENDOR_TEAM_CODE) return "Mã nhóm không hợp lệ.";
  return null;
}

function validateDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên nhóm là bắt buộc.";
  if (name.length > NAME_MAX) return "Tên nhóm tối đa 256 ký tự.";
  return null;
}

export function buildTeamCreateRequest(input: {
  code: string;
  displayName: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateTeamCode(input.code) ?? validateDisplayName(input.displayName)
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      code: input.code.trim(),
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

/** Generic update carries display_name only; team code is immutable after create. */
export function buildTeamUpdateRequest(input: {
  displayName: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateDisplayName(input.displayName)
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
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

export function buildTeamSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = typeof input.active !== "boolean"
    ? "Trạng thái không hợp lệ."
    : validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null) ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
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

export function classifyTeamMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): TeamMutationOutcome {
  if (status === 200) {
    const team = operation === "create" ? projectTeamCreate(payload) : projectTeamMutation(payload);
    return team
      ? { kind: "applied", team }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Nhóm không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Nhóm đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function setTeamConflictLock(
  locks: ReadonlySet<string>,
  teamId: string,
  locked: boolean,
): Set<string> {
  const next = new Set(locks);
  if (locked) next.add(teamId);
  else next.delete(teamId);
  return next;
}

export function teamConflictsForDialog<T>(
  conflicts: ReadonlyMap<string, T>,
  lockId: string | null,
): T[] {
  const conflict = lockId === null ? undefined : conflicts.get(lockId);
  return conflict === undefined ? [] : [conflict];
}

export function newTeamIntentKey(): string {
  return newIdempotencyKey();
}

/**
 * Inactive teams stay readable in the catalog list, but never enter the active
 * choices used by other admin surfaces.
 */
export function activeTeamChoices(list: AdminTeamList): AdminTeam[] {
  return list.teams.filter((team) => team.active && !isReservedVendorTeam(team));
}
