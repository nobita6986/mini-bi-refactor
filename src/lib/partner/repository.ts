import "server-only";

import type { PartnerKind } from "../auth/direct-entry-v2.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import {
  isRecord,
  projectActivateResult,
  projectConflictsReport,
  projectPartnerAccountSummary,
  projectPartnerProfile,
  projectProvisionBegin,
  projectProvisionFinalize,
  projectVendorRecruitmentSummary,
  projectVendorWorkerList,
  type PartnerAccountSummary,
  type PartnerActivateResult,
  type PartnerConflictsReport,
  type PartnerErrorCode,
  type PartnerGroupBy,
  type PartnerProfile,
  type PartnerProvisionBeginData,
  type PartnerProvisionFinalizeData,
  type PartnerVendorRecruitmentSummary,
  type PartnerVendorWorkerList,
} from "./contract.ts";

export type PartnerRpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type PartnerRepoOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: PartnerErrorCode };

export type PartnerRepository = {
  preflightConflicts(input: {
    auth_subject: string;
    app_user_id: string;
  }): Promise<PartnerRepoOutcome<PartnerConflictsReport>>;
  getPartnerAccountRef(input: {
    auth_subject: string;
    app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
  }): Promise<PartnerRepoOutcome<{ app_user_id: string | null }>>;
  provisionBegin(input: {
    auth_subject: string;
    actor_app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
    reason: string | null;
    idempotency_key: string;
  }): Promise<PartnerRepoOutcome<PartnerProvisionBeginData>>;
  provisionFinalize(input: {
    auth_subject: string;
    actor_app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
    intent_id: string;
    intent_token: string;
    created_auth_subject: string;
    activation_code_hash: string;
    activation_expires_at: string;
    idempotency_key: string;
  }): Promise<PartnerRepoOutcome<PartnerProvisionFinalizeData>>;
  rotateActivation(input: {
    auth_subject: string;
    actor_app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
    activation_code_hash: string;
    activation_expires_at: string;
    reason: string | null;
    idempotency_key: string;
  }): Promise<PartnerRepoOutcome<PartnerAccountSummary>>;
  activateAccount(input: {
    username: string;
    activation_code_hash: string;
  }): Promise<PartnerRepoOutcome<PartnerActivateResult>>;
  markPasswordChanged(input: {
    auth_subject: string;
    app_user_id: string;
  }): Promise<PartnerRepoOutcome<{ ok: true }>>;
  getProfile(input: {
    auth_subject: string;
    app_user_id: string;
  }): Promise<PartnerRepoOutcome<PartnerProfile>>;
  updateProfile(input: {
    auth_subject: string;
    app_user_id: string;
    display_name: string;
    address: string | null;
    phone: string | null;
    expected_version: number;
    idempotency_key: string;
  }): Promise<PartnerRepoOutcome<PartnerProfile>>;
  getVendorRecruitmentSummary(input: {
    auth_subject: string;
    app_user_id: string;
    date_from: string | null;
    date_to: string | null;
    project_id: string | null;
    group_by: PartnerGroupBy;
  }): Promise<PartnerRepoOutcome<PartnerVendorRecruitmentSummary>>;
  listVendorWorkers(input: {
    auth_subject: string;
    app_user_id: string;
    search: string | null;
    project_id: string | null;
    date_from: string | null;
    date_to: string | null;
    page: number;
    page_size: number;
  }): Promise<PartnerRepoOutcome<PartnerVendorWorkerList>>;
};

function createServiceRoleRpc(): PartnerRpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifyPartnerRpcError(error: {
  code?: string;
  message?: string;
}): PartnerErrorCode {
  const msg = typeof error.message === "string" ? error.message : "";
  if (error.code === "42501") {
    if (msg.includes("PARTNER_PASSWORD_CHANGE_REQUIRED")) {
      return "PASSWORD_CHANGE_REQUIRED";
    }
    return "PARTNER_FORBIDDEN";
  }
  if (error.code === "P0002") {
    return "PARTNER_NOT_FOUND";
  }
  if (error.code === "PT409") {
    if (msg.includes("PARTNER_CODE_CONFLICT")) return "PARTNER_CODE_CONFLICT";
    if (msg.includes("PARTNER_PARENT_INACTIVE")) return "PARTNER_PARENT_INACTIVE";
    if (msg.includes("PARTNER_ACCOUNT_ALREADY_PROVISIONED")) {
      return "PARTNER_ALREADY_PROVISIONED";
    }
    if (msg.includes("PARTNER_ACCOUNT_ALREADY_ACTIVATED")) {
      return "PARTNER_ALREADY_ACTIVATED";
    }
    if (msg.includes("PARTNER_ACCOUNT_NOT_PROVISIONED")) {
      return "PARTNER_NOT_PROVISIONED";
    }
    if (msg.includes("version conflict")) return "VERSION_CONFLICT";
    return "PARTNER_CONFLICT";
  }
  if (error.code === "40001" || error.code === "23505") {
    return "PARTNER_CONFLICT";
  }
  if (error.code === "22023" || error.code === "23514") {
    if (msg.includes("idempotency key reused with different input")) {
      return "PARTNER_CONFLICT";
    }
    return "PARTNER_INVALID";
  }
  return "PARTNER_UNAVAILABLE";
}

export function createPartnerRepository(rpc?: PartnerRpc): PartnerRepository {
  let resolvedRpc = rpc;
  const callRpc: PartnerRpc = async (name, args) => {
    resolvedRpc ??= createServiceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<PartnerRepoOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) {
        return { ok: false, code: classifyPartnerRpcError(error) };
      }
      const projected = project(data);
      if (projected === null) {
        return { ok: false, code: "PARTNER_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      console.error(`[partner] RPC ${rpcName} failed`);
      return { ok: false, code: "PARTNER_UNAVAILABLE" };
    }
  }

  return {
    preflightConflicts(input) {
      return call(
        "partner_account_preflight_conflicts_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        projectConflictsReport,
      );
    },
    getPartnerAccountRef(input) {
      const rpcName =
        input.partner_kind === "VENDOR"
          ? "direct_entry_get_vendor_admin"
          : "direct_entry_get_collaborator_admin";
      const args =
        input.partner_kind === "VENDOR"
          ? {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_vendor_id: input.partner_id,
            }
          : {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_collaborator_id: input.partner_id,
            };
      return call(rpcName, args, (data) => {
        if (!isRecord(data)) return null;
        if (data.partner_account === null || data.partner_account === undefined) {
          return { app_user_id: null };
        }
        const summary = projectPartnerAccountSummary(data.partner_account);
        if (!summary) return null;
        return { app_user_id: summary.app_user_id && isUuid(summary.app_user_id) ? summary.app_user_id : null };
      });
    },
    provisionBegin(input) {
      return call(
        "partner_account_provision_begin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_partner_kind: input.partner_kind,
          p_partner_id: input.partner_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectProvisionBegin,
      );
    },
    provisionFinalize(input) {
      return call(
        "partner_account_provision_finalize",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_partner_kind: input.partner_kind,
          p_partner_id: input.partner_id,
          p_intent_id: input.intent_id,
          p_intent_token: input.intent_token,
          p_created_auth_subject: input.created_auth_subject,
          p_activation_code_hash: input.activation_code_hash,
          p_activation_expires_at: input.activation_expires_at,
          p_idempotency_key: input.idempotency_key,
        },
        projectProvisionFinalize,
      );
    },
    rotateActivation(input) {
      return call(
        "partner_account_rotate_activation_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_partner_kind: input.partner_kind,
          p_partner_id: input.partner_id,
          p_activation_code_hash: input.activation_code_hash,
          p_activation_expires_at: input.activation_expires_at,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectPartnerAccountSummary,
      );
    },
    activateAccount(input) {
      return call(
        "partner_account_activate",
        {
          p_username: input.username,
          p_activation_code_hash: input.activation_code_hash,
        },
        projectActivateResult,
      );
    },
    markPasswordChanged(input) {
      return call(
        "partner_account_mark_password_changed",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        (data) => (isRecord(data) && data.ok === true ? { ok: true as const } : null),
      );
    },
    getProfile(input) {
      return call(
        "partner_portal_get_profile",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        projectPartnerProfile,
      );
    },
    updateProfile(input) {
      return call(
        "partner_portal_update_profile",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_display_name: input.display_name,
          p_address: input.address,
          p_phone: input.phone,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        },
        projectPartnerProfile,
      );
    },
    getVendorRecruitmentSummary(input) {
      return call(
        "partner_vendor_recruitment_summary",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_date_from: input.date_from,
          p_date_to: input.date_to,
          p_project_id: input.project_id,
          p_group_by: input.group_by,
        },
        projectVendorRecruitmentSummary,
      );
    },
    listVendorWorkers(input) {
      return call(
        "partner_vendor_list_workers",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_project_id: input.project_id,
          p_date_from: input.date_from,
          p_date_to: input.date_to,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectVendorWorkerList,
      );
    },
  };
}
