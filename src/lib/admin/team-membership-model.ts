import {
  teamMembershipList,
  teamMembershipMutation,
  type AdminTeamMembership,
  type AdminTeamMembershipList,
  type AdminTeamMembershipMutation,
  type MembershipState,
} from "../direct-entry/team-membership-contract.ts";
import {
  teamCatalogList,
  type AdminTeam,
  type AdminTeamList,
} from "../direct-entry/team-catalog-contract.ts";
import { parseIsoDate } from "../direct-entry/direct-entry-date-format.ts";
import type { AdminPersonnel } from "../direct-entry/personnel-catalog-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
} from "../direct-entry/project-operations-model.ts";

export const MEMBERSHIP_PAGE_SIZE = 25;
export const TEAM_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATE_VALUE: Readonly<Record<MembershipState, string>> = {
  CURRENT: "current",
  SCHEDULED: "scheduled",
  HISTORY: "history",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function pageIsValid(page: number, max: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= max;
}

export function buildMembershipListQuery(
  recruiterId: string,
  state: MembershipState,
  page: number,
): URLSearchParams | null {
  if (!UUID.test(recruiterId) || !pageIsValid(page, 1000)) return null;
  return new URLSearchParams({
    recruiter_id: recruiterId,
    state: STATE_VALUE[state],
    page: String(page),
    page_size: String(MEMBERSHIP_PAGE_SIZE),
  });
}

export function projectMembershipList(
  payload: unknown,
  query: { recruiterId: string; state: MembershipState; page: number },
): AdminTeamMembershipList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamMembershipList(payload.list);
  if (!list || list.page !== query.page || list.page_size !== MEMBERSHIP_PAGE_SIZE ||
      list.memberships.some((row) => row.recruiter_id !== query.recruiterId ||
        row.state !== query.state)) {
    return null;
  }
  return list;
}

export function buildTeamCatalogListQuery(page: number): URLSearchParams | null {
  if (!pageIsValid(page, 1000)) return null;
  return new URLSearchParams({
    include_inactive: "false",
    page: String(page),
    page_size: String(TEAM_PAGE_SIZE),
  });
}

export function projectActiveTeams(
  payload: unknown,
  page: number,
): AdminTeamList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamCatalogList(payload.list);
  return list && list.page === page && list.page_size === TEAM_PAGE_SIZE &&
    list.include_inactive === false && list.search === null
    ? { ...list, teams: list.teams.filter((team) => team.active) }
    : null;
}

export type MembershipMutationRequest = {
  url: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
};

function mutationPath(recruiterId: string, teamId?: string, move = false): string | null {
  if (!UUID.test(recruiterId) || (teamId !== undefined && !UUID.test(teamId))) return null;
  return `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}/team-memberships${
    teamId ? `/${encodeURIComponent(teamId)}${move ? "/move" : ""}` : "/unassign"
  }`;
}

function resolveTeamMembershipUiToday(todayVn?: string | null): string {
  if (typeof todayVn === "string" && parseIsoDate(todayVn) !== null) {
    return todayVn;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildAssignMembershipRequest(input: {
  recruiterId: string;
  teamId: string;
  validFrom?: string | null;
  todayVn?: string | null;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
  move?: boolean;
}): { ok: true; request: MembershipMutationRequest } | { ok: false; message: string } {
  const url = mutationPath(input.recruiterId, input.teamId, input.move === true);
  if (url === null) return { ok: false, message: "Hồ sơ hoặc nhóm không hợp lệ." };
  const businessToday = resolveTeamMembershipUiToday(input.todayVn);
  const rawValidFrom = typeof input.validFrom === "string" ? input.validFrom.trim() : "";
  const effectiveValidFrom = rawValidFrom.length === 0 ? businessToday : rawValidFrom;
  const dateFailure = !parseIsoDate(effectiveValidFrom)
    ? "Ngày hiệu lực không hợp lệ."
    : effectiveValidFrom > businessToday
      ? "Ngày hiệu lực không được ở tương lai."
      : null;
  const failure = dateFailure
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu hồ sơ chưa hợp lệ. Vui lòng tải lại."
      : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    request: {
      url,
      body: {
        valid_from: effectiveValidFrom,
        expected_version: input.expectedVersion,
        reason: normalizeOptionalActionReason(input.reason),
        idempotency_key: input.idempotencyKey,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export function buildUnassignMembershipRequest(input: {
  recruiterId: string;
  validTo?: string | null;
  todayVn?: string | null;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): { ok: true; request: MembershipMutationRequest } | { ok: false; message: string } {
  const url = mutationPath(input.recruiterId);
  if (url === null) return { ok: false, message: "Hồ sơ không hợp lệ." };
  const businessToday = resolveTeamMembershipUiToday(input.todayVn);
  const rawValidTo = typeof input.validTo === "string" ? input.validTo.trim() : "";
  const effectiveValidTo = rawValidTo.length === 0 ? businessToday : rawValidTo;
  const dateFailure = !parseIsoDate(effectiveValidTo)
    ? "Ngày kết thúc không hợp lệ."
    : effectiveValidTo > businessToday
      ? "Ngày kết thúc không được ở tương lai."
      : null;
  const failure = dateFailure
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu hồ sơ chưa hợp lệ. Vui lòng tải lại."
      : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    request: {
      url,
      body: {
        valid_to: effectiveValidTo,
        expected_version: input.expectedVersion,
        reason: normalizeOptionalActionReason(input.reason),
        idempotency_key: input.idempotencyKey,
      },
      idempotencyKey: input.idempotencyKey,
    },
  };
}

export type MembershipMutationOutcome =
  | { kind: "applied"; membership: AdminTeamMembershipMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export type MembershipIntent = MembershipMutationRequest & {
  operation: "assign" | "move" | "unassign";
  recruiterId: string;
  personnel: AdminPersonnel;
  retry: boolean;
};

export type MembershipWorkflowEntry = {
  personnel: AdminPersonnel;
  pendingIntent: MembershipIntent | null;
  reloadRequired: boolean;
  reloadError: string | null;
  message: string | null;
  formError: string | null;
};

export type MembershipWorkflow = ReadonlyMap<string, MembershipWorkflowEntry>;

export function membershipWorkflowEntry(
  workflow: MembershipWorkflow,
  recruiterId: string,
): MembershipWorkflowEntry | null {
  return workflow.get(recruiterId) ?? null;
}

export function membershipWorkflowLocked(entry: MembershipWorkflowEntry | null): boolean {
  return entry !== null && (entry.pendingIntent !== null || entry.reloadRequired);
}

function updateMembershipWorkflow(
  workflow: MembershipWorkflow,
  recruiterId: string,
  update: (entry: MembershipWorkflowEntry) => MembershipWorkflowEntry,
  personnel: AdminPersonnel,
): Map<string, MembershipWorkflowEntry> {
  const next = new Map(workflow);
  const current = next.get(recruiterId) ?? {
    personnel,
    pendingIntent: null,
    reloadRequired: false,
    reloadError: null,
    message: null,
    formError: null,
  };
  next.set(recruiterId, update(current));
  return next;
}

export function patchMembershipWorkflowEntry(
  workflow: MembershipWorkflow,
  personnel: AdminPersonnel,
  patch: Partial<MembershipWorkflowEntry>,
): Map<string, MembershipWorkflowEntry> {
  return updateMembershipWorkflow(
    workflow,
    personnel.recruiter_id,
    (entry) => ({ ...entry, ...patch, personnel }),
    personnel,
  );
}

export function recordMembershipIntent(
  workflow: MembershipWorkflow,
  intent: MembershipIntent,
): Map<string, MembershipWorkflowEntry> {
  return updateMembershipWorkflow(workflow, intent.recruiterId, (entry) => ({
    ...entry,
    personnel: intent.personnel,
    pendingIntent: intent,
    message: null,
    formError: null,
  }), intent.personnel);
}

export function recordMembershipOutcome(
  workflow: MembershipWorkflow,
  intent: MembershipIntent,
  outcome: MembershipMutationOutcome,
): Map<string, MembershipWorkflowEntry> {
  return updateMembershipWorkflow(workflow, intent.recruiterId, (entry) => {
    if (outcome.kind === "applied") {
      return {
        ...entry,
        pendingIntent: null,
        reloadRequired: true,
        reloadError: null,
        message: "Đã lưu thay đổi. Đang cập nhật danh sách…",
        formError: null,
      };
    }
    if (outcome.kind === "conflict") {
      return {
        ...entry,
        pendingIntent: null,
        reloadRequired: true,
        reloadError: null,
        message: null,
        formError: outcome.message,
      };
    }
    if (outcome.kind === "unavailable") {
      return {
        ...entry,
        pendingIntent: { ...intent, retry: true },
        message: null,
        formError: outcome.message,
      };
    }
    return { ...entry, pendingIntent: null, message: null, formError: outcome.message };
  }, intent.personnel);
}

export function beginMembershipReload(
  workflow: MembershipWorkflow,
  recruiterId: string,
): Map<string, MembershipWorkflowEntry> {
  const current = workflow.get(recruiterId);
  if (!current) return new Map(workflow);
  return updateMembershipWorkflow(workflow, recruiterId, (entry) => ({
    ...entry,
    reloadRequired: true,
    reloadError: null,
  }), current.personnel);
}

export function finishMembershipReload(
  workflow: MembershipWorkflow,
  recruiterId: string,
  result: { detail: "loaded" | "not-found" | "failed"; listsLoaded: boolean },
): { workflow: Map<string, MembershipWorkflowEntry>; missing: boolean; complete: boolean } {
  const current = workflow.get(recruiterId);
  if (result.detail === "not-found") {
    const next = new Map(workflow);
    next.delete(recruiterId);
    return { workflow: next, missing: true, complete: false };
  }
  if (result.detail === "loaded" && result.listsLoaded) {
    const next = new Map(workflow);
    next.delete(recruiterId);
    return { workflow: next, missing: false, complete: true };
  }
  if (!current) {
    return { workflow: new Map(workflow), missing: false, complete: false };
  }
  const next = updateMembershipWorkflow(workflow, recruiterId, (entry) => ({
    ...entry,
    reloadRequired: true,
    reloadError: "Chưa tải đủ hồ sơ và các phân công. Hãy tải lại trước khi tiếp tục.",
    message: null,
  }), current.personnel);
  return { workflow: next, missing: false, complete: false };
}

export function membershipNeedsAttention(entry: MembershipWorkflowEntry): boolean {
  return entry.pendingIntent !== null || entry.reloadRequired;
}

export function canAssignMembership(
  current: { kind: string; list?: { memberships: readonly unknown[] } },
  scheduled: { kind: string; list?: { memberships: readonly unknown[] } },
): boolean {
  return current.kind === "loaded" && current.list?.memberships.length === 0 &&
    scheduled.kind === "loaded" && scheduled.list?.memberships.length === 0;
}

export function classifyMembershipMutation(
  status: number,
  payload: unknown,
  recruiterId: string,
  operation: "assign" | "move" | "unassign",
): MembershipMutationOutcome {
  if (status === 200) {
    if (isRecord(payload) && exactKeys(payload, ["ok", "membership"]) && payload.ok === true) {
      const membership = teamMembershipMutation(payload.membership);
      const expectedChange = operation === "assign" ? "ASSIGN"
        : operation === "move" ? "MOVE" : null;
      if (membership && membership.recruiter_id === recruiterId &&
          (expectedChange === null || membership.change === expectedChange) &&
          (operation !== "unassign" ||
            membership.change === "UNASSIGN" || membership.change === "CANCEL")) {
        return { kind: "applied", membership };
      }
    }
    return { kind: "unavailable", message: "Phản hồi thao tác không hợp lệ." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền quản lý nhóm của hồ sơ này." };
  if (status === 404) return { kind: "not-found", message: "Hồ sơ hoặc nhóm không còn khả dụng." };
  const code = isRecord(payload) && payload.ok === false ? payload.code : null;
  if (status === 409 && code === "MEMBERSHIP_OVERLAP") return { kind: "conflict", message: "Lịch phân công bị trùng. Hãy tải lại và kiểm tra các phân công đã lên lịch." };
  if (status === 409 && code === "MEMBERSHIP_NOT_MOVABLE") return { kind: "conflict", message: "Không có phân công có thể thay đổi vào ngày đã chọn. Hãy tải lại và kiểm tra ngày bắt đầu, kết thúc." };
  if (status === 400 && code === "MEMBERSHIP_SAME_TEAM") return { kind: "invalid", message: "Nhân sự đã được phân công vào nhóm này. Hãy chọn nhóm khác." };
  if (status === 400 && code === "MEMBERSHIP_DATE_BEFORE_START") return { kind: "invalid", message: "Ngày thay đổi không được trước ngày bắt đầu của phân công cần thay đổi." };
  if (status === 400 && code === "MEMBERSHIP_ATTRIBUTION_CONFLICT") return { kind: "invalid", message: "Ngày thay đổi ảnh hưởng đến lịch sử tuyển dụng đã ghi nhận. Hãy chọn ngày khác." };
  if (status === 409) return { kind: "conflict", message: "Hồ sơ đã thay đổi. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  return { kind: "unavailable", message: "Dịch vụ hiện chưa khả dụng." };
}

export function setMembershipConflictLock(
  locks: ReadonlySet<string>,
  recruiterId: string,
  locked: boolean,
): Set<string> {
  const next = new Set(locks);
  if (locked) next.add(recruiterId);
  else next.delete(recruiterId);
  return next;
}

export function newMembershipIntentKey(): string {
  return newIdempotencyKey();
}

export type { AdminTeam, AdminTeamMembership, AdminTeamMembershipList };
