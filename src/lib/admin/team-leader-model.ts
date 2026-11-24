import {
  teamLeaderCandidateList,
  teamLeaderList,
  teamLeaderMutation,
  type TeamLeaderCandidateList,
  type TeamLeaderList,
  type TeamLeaderState,
  type TeamLeaderMutation,
} from "../direct-entry/team-leader-contract.ts";
import { projectTeamItem } from "./team-catalog-model.ts";
import type { AdminTeam } from "../direct-entry/team-catalog-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
} from "../direct-entry/project-operations-model.ts";

export const TEAM_LEADER_PAGE_SIZE = 25;
export const TEAM_LEADER_CANDIDATE_PAGE_SIZE = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 256;
const STATE_QUERY: Readonly<Record<TeamLeaderState, string>> = {
  CURRENT: "current",
  SCHEDULED: "scheduled",
  HISTORY: "history",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validPage(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 1 && page <= 1000;
}

export function buildTeamLeaderListQuery(
  teamId: string,
  state: TeamLeaderState,
  page: number,
): URLSearchParams | null {
  if (!UUID.test(teamId) || !validPage(page)) return null;
  return new URLSearchParams({
    state: STATE_QUERY[state],
    team_id: teamId,
    page: String(page),
    page_size: String(TEAM_LEADER_PAGE_SIZE),
  });
}

export function projectTeamLeaderList(
  payload: unknown,
  query: { teamId: string; state: TeamLeaderState; page: number },
): TeamLeaderList | null {
  if (!record(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamLeaderList(payload.list);
  return list && list.page === query.page && list.page_size === TEAM_LEADER_PAGE_SIZE &&
    list.leaders.every((leader) =>
      leader.team_id === query.teamId && leader.state === query.state)
    ? list
    : null;
}

export function buildTeamLeaderCandidateQuery(
  teamId: string,
  search: string,
  page: number,
): URLSearchParams | null {
  const normalizedSearch = search.trim();
  if (!UUID.test(teamId) || !validPage(page) || normalizedSearch.length > SEARCH_MAX) return null;
  const query = new URLSearchParams({
    team_id: teamId,
    page: String(page),
    page_size: String(TEAM_LEADER_CANDIDATE_PAGE_SIZE),
  });
  if (normalizedSearch) query.set("search", normalizedSearch);
  return query;
}

export function projectTeamLeaderCandidates(
  payload: unknown,
  page: number,
): TeamLeaderCandidateList | null {
  if (!record(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) return null;
  const list = teamLeaderCandidateList(payload.list);
  return list && list.page === page && list.page_size === TEAM_LEADER_CANDIDATE_PAGE_SIZE
    ? list
    : null;
}

export type TeamLeaderIntent = {
  teamId: string;
  change: "designate" | "replace" | "revoke";
  url: string;
  body: Record<string, unknown>;
};

type MutationInput = {
  teamId: string;
  effectiveDate?: string | null;
  todayVn?: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
};

function validateImmediateEffectiveDate(
  rawDate: string | null | undefined,
): { ok: true; value: null } | { ok: false; message: string } {
  if (rawDate !== undefined && rawDate !== null && rawDate !== "") {
    return {
      ok: false,
      message: "Ngày hiệu lực do máy chủ quyết định khi lưu; không gửi ngày hiệu lực từ trình duyệt.",
    };
  }
  return { ok: true, value: null };
}

export function buildTeamLeaderDesignation(input: MutationInput & {
  leaderAppUserId: string;
  change: "designate" | "replace";
}): { ok: true; intent: TeamLeaderIntent } | { ok: false; message: string } {
  const effectiveDate = validateImmediateEffectiveDate(input.effectiveDate);
  const failure = validateUuid(input.teamId) ?? validateUuid(input.leaderAppUserId) ??
    (effectiveDate.ok ? null : effectiveDate.message) ??
    validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu nhóm chưa hợp lệ. Vui lòng tải lại."
      : null) ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure || !effectiveDate.ok) return { ok: false, message: failure ?? "Ngày hiệu lực không hợp lệ." };
  return {
    ok: true,
    intent: {
      teamId: input.teamId,
      change: input.change,
      url: `/api/admin/catalog/teams/${encodeURIComponent(input.teamId)}/leaders`,
      body: {
        leader_app_user_id: input.leaderAppUserId,
        effective_date: null,
        expected_version: input.expectedVersion,
        reason: normalizeOptionalActionReason(input.reason),
        idempotency_key: input.idempotencyKey,
      },
    },
  };
}

export function buildTeamLeaderRevocation(input: MutationInput): {
  ok: true; intent: TeamLeaderIntent;
} | { ok: false; message: string } {
  const effectiveDate = validateImmediateEffectiveDate(input.effectiveDate);
  const failure = validateUuid(input.teamId) ??
    (effectiveDate.ok ? null : effectiveDate.message) ??
    validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu nhóm chưa hợp lệ. Vui lòng tải lại."
      : null) ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure || !effectiveDate.ok) return { ok: false, message: failure ?? "Ngày hiệu lực không hợp lệ." };
  return {
    ok: true,
    intent: {
      teamId: input.teamId,
      change: "revoke",
      url: `/api/admin/catalog/teams/${encodeURIComponent(input.teamId)}/leaders/revoke`,
      body: {
        effective_date: effectiveDate.value,
        expected_version: input.expectedVersion,
        reason: normalizeOptionalActionReason(input.reason),
        idempotency_key: input.idempotencyKey,
      },
    },
  };
}

export type TeamLeaderMutationOutcome =
  | { kind: "applied"; leader: TeamLeaderMutation }
  | { kind: "conflict" | "denied" | "unauthenticated" | "not-found" | "invalid" | "unavailable";
      message: string };

export function classifyTeamLeaderMutation(
  status: number,
  payload: unknown,
  intent: TeamLeaderIntent,
): TeamLeaderMutationOutcome {
  if (status === 200) {
    const leader = record(payload) && exactKeys(payload, ["ok", "leader"]) && payload.ok === true
      ? teamLeaderMutation(payload.leader)
      : null;
    if (leader && leader.team_id === intent.teamId && leader.change === intent.change) {
      return { kind: "applied", leader };
    }
    return { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại cùng thao tác." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Nhóm hoặc dữ liệu trưởng nhóm không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Nhóm đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) {
    return {
      kind: "invalid",
      message: "Thông tin không hợp lệ hoặc nhóm không thể nhận thay đổi này; hãy kiểm tra trạng thái nhóm (bao gồm nhóm hệ thống) và dữ liệu đã nhập.",
    };
  }
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newTeamLeaderIntentKey(): string {
  return newIdempotencyKey();
}

export type TeamLeaderSnapshot = {
  team: AdminTeam;
  lists: Record<TeamLeaderState, TeamLeaderList>;
};

export function projectTeamLeaderSnapshot(
  teamId: string,
  teamPayload: unknown,
  leaderPayloads: Record<TeamLeaderState, unknown>,
): TeamLeaderSnapshot | null {
  const team = projectTeamItem(teamPayload);
  if (!team || team.team_id !== teamId) return null;
  const lists = {} as Record<TeamLeaderState, TeamLeaderList>;
  for (const state of ["CURRENT", "SCHEDULED", "HISTORY"] as const) {
    const list = projectTeamLeaderList(leaderPayloads[state], { teamId, state, page: 1 });
    if (!list) return null;
    lists[state] = list;
  }
  return { team, lists };
}
