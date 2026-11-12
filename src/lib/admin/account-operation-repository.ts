/**
 * PRE-W2-HF-D3-B/C - Repository boundary for account operations.
 *
 * - Calls only the D3-A RPCs (service_role entry points). No direct table access.
 * - auth_subject/app_user_id come from the server session, never the client.
 * - Full Admin authority is enforced inside each RPC via
 *   direct_entry_assert_actor_app_user_admin; the repository only classifies the
 *   sanitized SQLSTATE.
 * - Strict projection; malformed -> unavailable.
 */
import "server-only";

import {
  projectClaimEnvelope,
  projectEditNameEnvelope,
  projectEligibleAccountsEnvelope,
  projectFinalizeCreateEnvelope,
  projectIntentEnvelope,
  projectLinkRecruiterEnvelope,
  projectPersonnelFromAccountEnvelope,
  projectReadIntentEnvelope,
  projectRecruiterLinkCandidatesEnvelope,
  projectRecruiterLinkStatusEnvelope,
} from "./account-operation-contract.ts";
import type {
  ClaimEnvelope,
  EditNameEnvelope,
  EligibleAccountsEnvelope,
  FinalizeCreateEnvelope,
  IntentEnvelope,
  LinkRecruiterEnvelope,
  PersonnelFromAccountEnvelope,
  ReadIntentEnvelope,
  RecruiterLinkCandidatesEnvelope,
  RecruiterLinkStatusEnvelope,
} from "./account-operation-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AccountOperationActor = { auth_subject: string; app_user_id: string };
export type AccountOperationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: AccountOperationErrorKind };
export type AccountOperationErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "blocked" | "unavailable";

export type AccountOperationRepository = {
  begin(input: AccountOperationActor & {
    kind: "CREATE_ACCOUNT" | "RESET_PASSWORD"; login_id: string | null; display_name: string | null;
    account_ref: string | null; reason: string | null; idempotency_key: string;
  }): Promise<AccountOperationOutcome<IntentEnvelope>>;
  claim(input: AccountOperationActor & { intent_id: string; intent_token: string }):
    Promise<AccountOperationOutcome<ClaimEnvelope>>;
  readIntent(input: AccountOperationActor & { intent_id: string }):
    Promise<AccountOperationOutcome<ReadIntentEnvelope>>;
  finish(input: AccountOperationActor & { intent_id: string; outcome: string; failure_code: string | null }):
    Promise<AccountOperationOutcome<null>>;
  finalizeCreate(input: AccountOperationActor & {
    intent_id: string; intent_token: string; created_auth_subject: string; idempotency_key: string;
  }): Promise<AccountOperationOutcome<FinalizeCreateEnvelope | { intent_id: string; intent_state: string; account_ref: string | null }>>;
  updateDisplayName(input: AccountOperationActor & {
    target_app_user_id: string; display_name: string; expected_app_user_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<AccountOperationOutcome<EditNameEnvelope>>;
  createPersonnelFromAccount(input: AccountOperationActor & {
    account_ref: string; expected_account_version: number; personnel_code: string;
    personnel_position: "STAFF" | "TEAM_LEADER"; valid_from: string | null; reason: string | null; idempotency_key: string;
  }): Promise<AccountOperationOutcome<PersonnelFromAccountEnvelope>>;
  listEligibleAccounts(input: AccountOperationActor & { page: number; page_size: number }):
    Promise<AccountOperationOutcome<EligibleAccountsEnvelope>>;
  readRecruiterLinkStatus(input: AccountOperationActor & { recruiter_ids: string[] }):
    Promise<AccountOperationOutcome<RecruiterLinkStatusEnvelope>>;
  readRecruiterLinkCandidates(input: AccountOperationActor & { recruiter_id: string }):
    Promise<AccountOperationOutcome<RecruiterLinkCandidatesEnvelope>>;
  linkRecruiterToAccount(input: AccountOperationActor & {
    recruiter_id: string; expected_recruiter_version: number;
    account_ref: string; expected_account_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<AccountOperationOutcome<LinkRecruiterEnvelope>>;
  reclassify(input: AccountOperationActor): Promise<AccountOperationOutcome<{ reclassified: number; purged: number; deleted: number }>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifyAccountOperationError(
  error: { code?: string; message?: string },
): AccountOperationErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505" || error.code === "23P01") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023" || error.code === "23514") {
    // provenance_mismatch surfaces as a 22023 on finish/finalize in a few paths;
    // treat as invalid unless the message is explicitly the blocked provenance.
    return error.message === "account operation provenance mismatch" ? "blocked" : "invalid";
  }
  return "unavailable";
}

export function createAccountOperationRepository(rpc?: Rpc): AccountOperationRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    name: string, args: Record<string, unknown>, project: (data: unknown) => T | null,
  ): Promise<AccountOperationOutcome<T>> {
    try {
      const { data, error } = await callRpc(name, args);
      if (error) return { ok: false, kind: classifyAccountOperationError(error) };
      const projected = project(data);
      return projected === null ? { ok: false, kind: "unavailable" } : { ok: true, data: projected };
    } catch {
      console.error("[account-operation] RPC failed");
      return { ok: false, kind: "unavailable" };
    }
  }

  async function mutate(name: string, args: Record<string, unknown>): Promise<AccountOperationOutcome<null>> {
    try {
      const { error } = await callRpc(name, args);
      return error ? { ok: false, kind: classifyAccountOperationError(error) } : { ok: true, data: null };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    begin(input) {
      return call("direct_entry_account_operation_begin", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_kind: input.kind, p_login_id: input.login_id, p_display_name: input.display_name,
        p_account_ref: input.account_ref, p_reason: input.reason, p_idempotency_key: input.idempotency_key,
      }, projectIntentEnvelope);
    },
    claim(input) {
      return call("direct_entry_account_operation_claim", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_intent_id: input.intent_id, p_intent_token: input.intent_token,
      }, projectClaimEnvelope);
    },
    readIntent(input) {
      return call("direct_entry_account_operation_read", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_intent_id: input.intent_id,
      }, projectReadIntentEnvelope);
    },
    finish(input) {
      return mutate("direct_entry_account_operation_finish", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_intent_id: input.intent_id, p_outcome: input.outcome, p_failure_code: input.failure_code,
      });
    },
    finalizeCreate(input) {
      return call("direct_entry_account_operation_finalize_create", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_intent_id: input.intent_id, p_intent_token: input.intent_token,
        p_created_auth_subject: input.created_auth_subject, p_idempotency_key: input.idempotency_key,
      }, (data) => {
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          const r = data as Record<string, unknown>;
          if (Object.keys(r).sort().join(",") === "account_ref,intent_id,intent_state" &&
              typeof r.intent_id === "string" && typeof r.intent_state === "string") {
            return { intent_id: r.intent_id, intent_state: r.intent_state,
              account_ref: (r.account_ref as string | null) ?? null };
          }
        }
        return projectFinalizeCreateEnvelope(data);
      });
    },
    updateDisplayName(input) {
      return call("direct_entry_account_operation_update_display_name", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_target_app_user_id: input.target_app_user_id, p_display_name: input.display_name,
        p_expected_app_user_version: input.expected_app_user_version, p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectEditNameEnvelope);
    },
    createPersonnelFromAccount(input) {
      return call("direct_entry_account_operation_create_personnel", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_account_ref: input.account_ref, p_expected_account_version: input.expected_account_version,
        p_personnel_code: input.personnel_code, p_personnel_position: input.personnel_position,
        p_valid_from: input.valid_from, p_reason: input.reason, p_idempotency_key: input.idempotency_key,
      }, projectPersonnelFromAccountEnvelope);
    },
    listEligibleAccounts(input) {
      return call("direct_entry_account_operation_list_eligible_accounts", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
        p_page: input.page, p_page_size: input.page_size,
      }, projectEligibleAccountsEnvelope);
    },
    readRecruiterLinkStatus(input) {
      return call("direct_entry_account_operation_recruiter_link_status", {
        p_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_recruiter_ids: input.recruiter_ids,
      }, projectRecruiterLinkStatusEnvelope);
    },
    readRecruiterLinkCandidates(input) {
      return call("direct_entry_account_operation_recruiter_link_candidates", {
        p_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
      }, projectRecruiterLinkCandidatesEnvelope);
    },
    linkRecruiterToAccount(input) {
      return call("direct_entry_account_operation_link_recruiter", {
        p_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_expected_recruiter_version: input.expected_recruiter_version,
        p_account_ref: input.account_ref,
        p_expected_account_version: input.expected_account_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectLinkRecruiterEnvelope);
    },
    reclassify(input) {
      return call("direct_entry_account_operation_reclassify", {
        p_auth_subject: input.auth_subject, p_actor_app_user_id: input.app_user_id,
      }, (data) => {
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          const r = data as Record<string, unknown>;
          if (Object.keys(r).sort().join(",") === "deleted,purged,reclassified" &&
              typeof r.reclassified === "number" && typeof r.purged === "number" && typeof r.deleted === "number") {
            return { reclassified: r.reclassified, purged: r.purged, deleted: r.deleted };
          }
        }
        return null;
      });
    },
  };
}
