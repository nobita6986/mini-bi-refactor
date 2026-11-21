import "server-only";

import type {
  AccountLinkStateFilter,
  AccountTypeFilter,
  ExistingAccount,
  ExistingAccountList,
} from "./app-user-access-contract.ts";
import { projectExistingAccount, projectExistingAccountList } from "./app-user-access-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AccountActorRef = { auth_subject: string; app_user_id: string };
export type AccountListRepositoryInput = AccountActorRef & {
  search: string | null;
  enabled: "all" | "true" | "false";
  page: number;
  page_size: number;
  account_type?: AccountTypeFilter;
  link_state?: AccountLinkStateFilter;
};
export type AccountAccessOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: AccountAccessErrorKind };
export type AccountAccessErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type AccountAccessRepository = {
  listAccounts(input: AccountListRepositoryInput): Promise<AccountAccessOutcome<ExistingAccountList>>;
  getAccount(input: AccountActorRef & { target_app_user_id: string }): Promise<AccountAccessOutcome<ExistingAccount>>;
  enableAccount(input: AccountActorRef & {
    target_app_user_id: string; expected_version: number; reason: string | null; idempotency_key: string;
  }): Promise<AccountAccessOutcome<null>>;
  disableAccount(input: AccountActorRef & {
    target_app_user_id: string; expected_version: number; reason: string | null; idempotency_key: string;
  }): Promise<AccountAccessOutcome<null>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifyAccountAccessError(
  error: { code?: string; message?: string },
): AccountAccessErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023" || error.code === "23514") return "invalid";
  return "unavailable";
}

export function createAccountAccessRepository(rpc?: Rpc): AccountAccessRepository {
  let resolvedRpc = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function read<T>(
    name: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<AccountAccessOutcome<T>> {
    try {
      const { data, error } = await callRpc(name, args);
      if (error) return { ok: false, kind: classifyAccountAccessError(error) };
      const projected = project(data);
      return projected === null ? { ok: false, kind: "unavailable" } : { ok: true, data: projected };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }

  async function mutation(
    name: string,
    args: Record<string, unknown>,
  ): Promise<AccountAccessOutcome<null>> {
    try {
      const { error } = await callRpc(name, args);
      return error ? { ok: false, kind: classifyAccountAccessError(error) } : { ok: true, data: null };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    listAccounts(input) {
      const accountType = input.account_type ?? "all";
      const linkState = input.link_state ?? "all";
      if (accountType === "all" && linkState === "all") {
        return read("direct_entry_list_app_users_admin", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_search: input.search, p_enabled: input.enabled, p_page: input.page, p_page_size: input.page_size,
        }, projectExistingAccountList);
      }
      return read("direct_entry_list_app_users_filtered_admin", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_search: input.search, p_enabled: input.enabled, p_page: input.page, p_page_size: input.page_size,
        p_account_type: accountType, p_link_state: linkState,
      }, projectExistingAccountList);
    },
    getAccount(input) {
      return read("direct_entry_get_app_user_admin", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_target_app_user_id: input.target_app_user_id,
      }, projectExistingAccount);
    },
    enableAccount(input) {
      return mutation("direct_entry_enable_app_user", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_target_app_user_id: input.target_app_user_id,
        p_expected_app_user_version: input.expected_version,
        p_reason: input.reason, p_idempotency_key: input.idempotency_key,
      });
    },
    disableAccount(input) {
      return mutation("direct_entry_disable_app_user", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_target_app_user_id: input.target_app_user_id,
        p_expected_app_user_version: input.expected_version,
        p_reason: input.reason, p_idempotency_key: input.idempotency_key,
      });
    },
  };
}
