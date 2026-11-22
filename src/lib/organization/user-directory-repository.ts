import "server-only";

import { ORGANIZATION_ERROR_CODES, type OrganizationErrorCode } from "./person-contract.ts";
import type { OrganizationActorRef, OrganizationRpcCaller, OrgRepoResult } from "./person-repository.ts";
import {
  projectGetUserDirectoryEntryResponse,
  projectListUserDirectoryResponse,
  type GetUserDirectoryEntryRpcProjection,
  type ListUserDirectoryRpcProjection,
  type UserDirectoryLoginStateFilter,
  type UserDirectoryPersonStatusFilter,
  type UserDirectoryRecordKindFilter,
} from "./user-directory-contract.ts";

export type ListUserDirectoryInput = OrganizationActorRef & {
  search: string | null;
  record_kind: UserDirectoryRecordKindFilter;
  person_status: UserDirectoryPersonStatusFilter;
  login_state: UserDirectoryLoginStateFilter;
  department_id: string | null;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type GetUserDirectoryEntryInput = OrganizationActorRef & {
  person_id: string | null;
  account_ref: string | null;
  as_of: string | null;
};

export type UserDirectoryRepository = {
  listUserDirectory(
    input: ListUserDirectoryInput,
  ): Promise<OrgRepoResult<ListUserDirectoryRpcProjection>>;
  getUserDirectoryEntry(
    input: GetUserDirectoryEntryInput,
  ): Promise<OrgRepoResult<GetUserDirectoryEntryRpcProjection>>;
};

const KNOWN_DIRECTORY_RPC_TOKENS: ReadonlyMap<string, OrganizationErrorCode> = new Map([
  ...ORGANIZATION_ERROR_CODES.map((code) => [code, code] as const),
  ["USER_DIRECTORY_ENTRY_NOT_FOUND", "NOT_FOUND"],
  ["DEPARTMENT_ACCESS_DENIED", "FORBIDDEN"],
]);

function serviceRoleRpc(): OrganizationRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyUserDirectoryRpcError(error: {
  code?: string;
  message?: string;
}): OrganizationErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_DIRECTORY_RPC_TOKENS.get(trimmed);
  if (exact) return exact;

  for (const [token, mapped] of KNOWN_DIRECTORY_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) return mapped;
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }

  if (error.code === "42501") return "FORBIDDEN";
  if (error.code === "P0002") return "NOT_FOUND";
  if (error.code === "PT409" || error.code === "40001") return "ORG_CONFLICT";
  if (error.code === "22023" || error.code === "23514") return "ORG_VALIDATION_ERROR";

  return "ORG_UNAVAILABLE";
}

export function createServiceUserDirectoryRepository(
  rpc?: OrganizationRpcCaller,
): UserDirectoryRepository {
  let resolvedRpc = rpc;

  return {
    async listUserDirectory(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_user_directory_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_record_kind: input.record_kind,
          p_person_status: input.person_status,
          p_login_state: input.login_state,
          p_department_id: input.department_id,
          p_as_of: input.as_of,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyUserDirectoryRpcError(result.error) };
        }
        const projected = projectListUserDirectoryResponse(result.data);
        if (!projected) {
          console.error("[user-directory-admin] list returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[user-directory-admin] list RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async getUserDirectoryEntry(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_get_user_directory_entry_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_person_id: input.person_id,
          p_account_ref: input.account_ref,
          p_as_of: input.as_of,
        });
        if (result.error) {
          return { ok: false, code: classifyUserDirectoryRpcError(result.error) };
        }
        const projected = projectGetUserDirectoryEntryResponse(result.data);
        if (!projected) {
          console.error("[user-directory-admin] detail returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[user-directory-admin] detail RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },
  };
}
