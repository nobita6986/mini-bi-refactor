import "server-only";

import { createServiceSupabaseClient } from "../supabase/server.ts";
import {
  PERMISSION_GROUP_ERROR_CODES,
  projectAccountGroupsResponse,
  projectGroupMemberAssignResponse,
  projectGroupMemberRemoveResponse,
  projectGroupMutationResponse,
  projectListGroupsResponse,
  type AccountGroupsResponse,
  type GroupMemberAssignResult,
  type GroupMemberRemoveResult,
  type ListPermissionGroupsResponse,
  type ParsedAssignGroupMemberBody,
  type ParsedCreateGroupBody,
  type ParsedListGroupsQuery,
  type ParsedRemoveGroupMemberBody,
  type ParsedUpdateGroupBody,
  type PermissionGroupErrorCode,
  type PermissionGroupMutationResult,
} from "./permission-group-contract.ts";

export type RpcErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  detail?: string | null;
};

export type RpcResult<T> = {
  data: T | null;
  error: RpcErrorLike | null;
};

export type RpcCaller = (
  functionName: string,
  params: Record<string, unknown>,
) => Promise<RpcResult<unknown>>;

export type RepoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PermissionGroupErrorCode; current_version?: number };

export type PermissionGroupRepository = {
  listGroups(
    actor: { auth_subject: string; app_user_id: string },
    query: ParsedListGroupsQuery,
  ): Promise<RepoResult<ListPermissionGroupsResponse>>;
  createGroup(
    actor: { auth_subject: string; app_user_id: string },
    body: ParsedCreateGroupBody,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RepoResult<PermissionGroupMutationResult>>;
  updateGroup(
    actor: { auth_subject: string; app_user_id: string },
    groupId: string,
    body: ParsedUpdateGroupBody,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RepoResult<PermissionGroupMutationResult>>;
  getAccountGroups(
    actor: { auth_subject: string; app_user_id: string },
    accountRef: string,
  ): Promise<RepoResult<AccountGroupsResponse>>;
  assignGroupMember(
    actor: { auth_subject: string; app_user_id: string },
    accountRef: string,
    body: ParsedAssignGroupMemberBody,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RepoResult<GroupMemberAssignResult>>;
  removeGroupMember(
    actor: { auth_subject: string; app_user_id: string },
    accountRef: string,
    membershipId: string,
    body: ParsedRemoveGroupMemberBody,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RepoResult<GroupMemberRemoveResult>>;
};

const KNOWN_ERROR_SET = new Set<string>(PERMISSION_GROUP_ERROR_CODES);

function classifyRpcError(error: RpcErrorLike): { code: PermissionGroupErrorCode; current_version?: number } {
  const rawMessage = typeof error.message === "string" ? error.message.trim() : "";
  const rawCode = typeof error.code === "string" ? error.code.trim() : "";
  const rawDetail =
    typeof error.details === "string"
      ? error.details
      : typeof error.detail === "string"
        ? error.detail
        : "";

  let currentVersion: number | undefined;
  if (rawDetail) {
    try {
      const parsed = JSON.parse(rawDetail) as { current_version?: unknown };
      if (typeof parsed.current_version === "number" && Number.isInteger(parsed.current_version)) {
        currentVersion = parsed.current_version;
      }
    } catch {
      // Ignore non-JSON detail safely
    }
  }

  if (rawMessage === "AUTHZ_FORBIDDEN" || rawCode === "42501") {
    return { code: "FORBIDDEN" };
  }
  if (KNOWN_ERROR_SET.has(rawMessage)) {
    return currentVersion !== undefined
      ? { code: rawMessage as PermissionGroupErrorCode, current_version: currentVersion }
      : { code: rawMessage as PermissionGroupErrorCode };
  }
  if (rawCode === "P0002") {
    return { code: "GROUP_NOT_FOUND" };
  }
  if (rawCode === "22023") {
    return { code: "AUTHZ_VALIDATION_ERROR" };
  }
  return { code: "AUTHZ_UNAVAILABLE" };
}

function defaultServiceRpcCaller(): RpcCaller {
  return async (functionName, params) => {
    const client = createServiceSupabaseClient();
    const { data, error } = await client.rpc(functionName, params);
    return {
      data,
      error: error
        ? {
            code: error.code,
            message: error.message,
            details: error.details,
          }
        : null,
    };
  };
}

export function createServicePermissionGroupRepository(
  callRpc: RpcCaller = defaultServiceRpcCaller(),
): PermissionGroupRepository {
  return {
    async listGroups(actor, query) {
      try {
        const res = await callRpc("direct_entry_authz_list_groups_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_department_id: query.department_id,
          p_include_inactive: query.include_inactive,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectListGroupsResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },

    async createGroup(actor, body, idempotencyKey, requestHash) {
      try {
        const res = await callRpc("direct_entry_authz_create_group_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_code: body.code,
          p_name: body.name,
          p_description: body.description,
          p_department_id: body.department_id,
          p_team_id: body.team_id,
          p_capabilities: body.capabilities,
          p_module_roles: body.module_roles,
          p_reason: body.reason,
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectGroupMutationResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },

    async updateGroup(actor, groupId, body, idempotencyKey, requestHash) {
      try {
        const res = await callRpc("direct_entry_authz_update_group_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_group_id: groupId,
          p_expected_version: body.expected_version,
          p_name: body.name,
          p_description: body.description,
          p_department_id: body.department_id,
          p_team_id: body.team_id,
          p_active: body.active,
          p_capabilities: body.capabilities,
          p_module_roles: body.module_roles,
          p_reason: body.reason,
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectGroupMutationResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },

    async getAccountGroups(actor, accountRef) {
      try {
        const res = await callRpc("direct_entry_authz_get_account_groups_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_target_app_user_id: accountRef,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectAccountGroupsResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },

    async assignGroupMember(actor, accountRef, body, idempotencyKey, requestHash) {
      try {
        const res = await callRpc("direct_entry_authz_assign_group_member_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_target_app_user_id: accountRef,
          p_group_id: body.group_id,
          p_expected_account_version: body.expected_account_version,
          p_reason: body.reason,
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectGroupMemberAssignResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },

    async removeGroupMember(actor, accountRef, membershipId, body, idempotencyKey, requestHash) {
      try {
        const res = await callRpc("direct_entry_authz_remove_group_member_admin", {
          p_auth_subject: actor.auth_subject,
          p_actor_app_user_id: actor.app_user_id,
          p_target_app_user_id: accountRef,
          p_membership_id: membershipId,
          p_expected_account_version: body.expected_account_version,
          p_reason: body.reason,
          p_idempotency_key: idempotencyKey,
          p_request_hash: requestHash,
        });
        if (res.error) return { ok: false, ...classifyRpcError(res.error) };
        const projected = projectGroupMemberRemoveResponse(res.data);
        if (!projected) return { ok: false, code: "AUTHZ_UNAVAILABLE" };
        return { ok: true, data: projected };
      } catch {
        return { ok: false, code: "AUTHZ_UNAVAILABLE" };
      }
    },
  };
}
