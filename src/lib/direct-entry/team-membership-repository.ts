/**
 * P3.1-W01C-B - Repository boundary cho team membership lifecycle admin (#70).
 *
 * - Chi goi 6 RPC canonical cua migration #70; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator tu #68) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  teamMembershipList,
  teamMembershipMutation,
} from "./team-membership-contract.ts";
import type {
  AdminTeamMembershipList,
  AdminTeamMembershipMutation,
  MembershipState,
} from "./team-membership-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type TeamMembershipOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: TeamMembershipErrorKind };

export type TeamMembershipErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable"
  | "overlap" | "already-team" | "no-membership" | "date-before" | "attribution";

const READ_RPC: Readonly<Record<MembershipState, string>> = {
  CURRENT: "direct_entry_list_team_membership_current",
  SCHEDULED: "direct_entry_list_team_membership_scheduled",
  HISTORY: "direct_entry_list_team_membership_history",
};

export type TeamMembershipRepository = {
  listMembership(input: AdminActorRef & {
    state: MembershipState; recruiter_id: string | null; team_id: string | null;
    search: string | null; page: number; page_size: number;
  }): Promise<TeamMembershipOutcome<AdminTeamMembershipList>>;
  assignMembership(input: AdminActorRef & {
    recruiter_id: string; team_id: string; valid_from: string | null; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<TeamMembershipOutcome<AdminTeamMembershipMutation>>;
  moveMembership(input: AdminActorRef & {
    recruiter_id: string; team_id: string; valid_from: string | null; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<TeamMembershipOutcome<AdminTeamMembershipMutation>>;
  unassignMembership(input: AdminActorRef & {
    recruiter_id: string; valid_to: string | null; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<TeamMembershipOutcome<AdminTeamMembershipMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #70 thuc su dung:
 *   PT409/40001 OCC stale (recruiter version)
 *   23P01 interval overlap (distinct from stale data)
 *   23505 idempotency key unique
 *   23514 target team inactive, vendor-provider recruiter, reserved team,
 *         cancellation marker ngoai duong mutation, attribution back-date
 *   42501 catalog operator / all scope denied
 *   P0002 subject khong eligible hoac target team khong ton tai
 *   22023 input sai; known lifecycle reasons have bounded public codes;
 *         message reuse-khac-payload remains conflict
 *   23514 attribution guard has a distinct safe reason; other checks stay invalid
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyTeamMembershipError(
  error: { code?: string; message?: string },
): TeamMembershipErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "23P01") return "overlap";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return error.message === "membership change would rewrite worker attribution"
    ? "attribution" : "invalid";
  if (error.code === "22023") {
    if (error.message === "membership already targets this team") return "already-team";
    if (error.message === "no open membership to move" || error.message === "no open membership to unassign") return "no-membership";
    if (error.message === "move date precedes the open membership" || error.message === "unassign date precedes the open membership") return "date-before";
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

function unavailable(): never {
  console.error("[team-membership] RPC failed");
  throw new Error("team membership RPC failed");
}

export function createTeamMembershipRepository(rpc?: Rpc): TeamMembershipRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<TeamMembershipOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyTeamMembershipError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listMembership(input) {
      return call(READ_RPC[input.state], {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_team_id: input.team_id,
        p_search: input.search,
        p_page: input.page,
        p_page_size: input.page_size,
      }, teamMembershipList);
    },
    assignMembership(input) {
      return call("direct_entry_assign_team_membership", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_team_id: input.team_id,
        p_valid_from: input.valid_from,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamMembershipMutation);
    },
    moveMembership(input) {
      return call("direct_entry_move_team_membership", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_team_id: input.team_id,
        p_valid_from: input.valid_from,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamMembershipMutation);
    },
    unassignMembership(input) {
      return call("direct_entry_unassign_team_membership", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_valid_to: input.valid_to,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamMembershipMutation);
    },
  };
}
