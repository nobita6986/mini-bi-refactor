import "server-only";

import {
  teamLeaderCandidateList,
  teamLeaderList,
  teamLeaderMutation,
} from "./team-leader-contract.ts";
import type {
  TeamLeaderCandidateList,
  TeamLeaderList,
  TeamLeaderState,
  TeamLeaderMutation,
} from "./team-leader-contract.ts";

export type TeamLeaderRpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type TeamLeaderActorRef = { auth_subject: string; app_user_id: string };
export type TeamLeaderOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: TeamLeaderErrorKind };
export type TeamLeaderErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type TeamLeaderRepository = {
  listLeaders(input: TeamLeaderActorRef & {
    state: TeamLeaderState; team_id: string | null; search: string | null;
    page: number; page_size: number;
  }): Promise<TeamLeaderOutcome<TeamLeaderList>>;
  listCandidates(input: TeamLeaderActorRef & {
    team_id: string; search: string | null; page: number; page_size: number;
  }): Promise<TeamLeaderOutcome<TeamLeaderCandidateList>>;
  designateLeader(input: TeamLeaderActorRef & {
    team_id: string; leader_app_user_id: string; effective_date: string | null;
    expected_version: number; reason: string | null; idempotency_key: string;
  }): Promise<TeamLeaderOutcome<TeamLeaderMutation>>;
  revokeLeader(input: TeamLeaderActorRef & {
    team_id: string; effective_date: string | null; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<TeamLeaderOutcome<TeamLeaderMutation>>;
};

const READ_RPC: Readonly<Record<TeamLeaderState, string>> = {
  CURRENT: "direct_entry_list_team_leaders_current",
  SCHEDULED: "direct_entry_list_team_leaders_scheduled",
  HISTORY: "direct_entry_list_team_leader_history",
};

export function classifyTeamLeaderError(
  error: { code?: string; message?: string },
): TeamLeaderErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23P01" || error.code === "23505") {
    return "conflict";
  }
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023" || error.code === "23514") return "invalid";
  return "unavailable";
}

function serviceRoleRpc(): TeamLeaderRpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createTeamLeaderRepository(rpc?: TeamLeaderRpc): TeamLeaderRepository {
  let resolvedRpc = rpc;
  const callRpc: TeamLeaderRpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    name: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<TeamLeaderOutcome<T>> {
    try {
      const { data, error } = await callRpc(name, args);
      if (error) return { ok: false, kind: classifyTeamLeaderError(error) };
      const result = project(data);
      return result ? { ok: true, data: result } : { ok: false, kind: "unavailable" };
    } catch {
      console.error("[team-leader] RPC unavailable");
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    listLeaders(input) {
      return call(READ_RPC[input.state], {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_team_id: input.team_id, p_search: input.search,
        p_page: input.page, p_page_size: input.page_size,
      }, teamLeaderList);
    },
    listCandidates(input) {
      return call("direct_entry_list_team_leader_candidates", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_team_id: input.team_id, p_search: input.search,
        p_page: input.page, p_page_size: input.page_size,
      }, teamLeaderCandidateList);
    },
    designateLeader(input) {
      return call("direct_entry_designate_team_leader", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_team_id: input.team_id, p_leader_app_user_id: input.leader_app_user_id,
        p_effective_date: input.effective_date, p_expected_version: input.expected_version,
        p_reason: input.reason, p_idempotency_key: input.idempotency_key,
      }, teamLeaderMutation);
    },
    revokeLeader(input) {
      return call("direct_entry_revoke_team_leader", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_team_id: input.team_id, p_effective_date: input.effective_date,
        p_expected_version: input.expected_version, p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamLeaderMutation);
    },
  };
}
