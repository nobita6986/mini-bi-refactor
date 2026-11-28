/**
 * Repository boundary for Vendor Referrer Attribution (BoD-only).
 *
 * - Calls only the 7 canonical `direct_entry_vendor_referrer_*` service_role RPCs.
 * - `auth_subject` and `app_user_id` come strictly from the server-side session actor.
 * - Responses are strictly projected (fail-closed -> `unavailable`).
 */
import "server-only";

import {
  classifyVendorReferrerError,
  projectActorAccess,
  projectAssignMutationResult,
  projectCandidateList,
  projectMonthlyReport,
  projectRevokeMutationResult,
  projectVendorHistory,
  projectVendorList,
  type ActorAccess,
  type AssignMutationResult,
  type CandidateListResponse,
  type MonthlyReportResponse,
  type RevokeMutationResult,
  type VendorHistoryResponse,
  type VendorListResponse,
  type VendorReferrerErrorKind,
} from "./vendor-referrer-contract.ts";

export { classifyVendorReferrerError, type VendorReferrerErrorKind };

export type VendorReferrerRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type VendorReferrerActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type VendorReferrerOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: VendorReferrerErrorKind };

export type VendorReferrerRepository = {
  getActorAccess(input: VendorReferrerActorRef): Promise<VendorReferrerOutcome<ActorAccess>>;
  listCandidates(
    input: VendorReferrerActorRef & { search: string | null; limit: number },
  ): Promise<VendorReferrerOutcome<CandidateListResponse>>;
  listVendors(
    input: VendorReferrerActorRef & {
      search: string | null;
      include_inactive: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<VendorReferrerOutcome<VendorListResponse>>;
  getHistory(
    input: VendorReferrerActorRef & { vendor_id: string },
  ): Promise<VendorReferrerOutcome<VendorHistoryResponse>>;
  assignReferrer(
    input: VendorReferrerActorRef & {
      vendor_id: string;
      referrer_person_id: string;
      effective_date: string | null;
      expected_current_link_id: string | null;
      reason: string;
      idempotency_key: string;
    },
  ): Promise<VendorReferrerOutcome<AssignMutationResult>>;
  revokeReferrer(
    input: VendorReferrerActorRef & {
      vendor_id: string;
      effective_date: string | null;
      expected_current_link_id: string | null;
      reason: string;
      idempotency_key: string;
    },
  ): Promise<VendorReferrerOutcome<RevokeMutationResult>>;
  getMonthlyReport(
    input: VendorReferrerActorRef & {
      month: string | null;
      referrer_person_id: string | null;
      vendor_id: string | null;
      project_id: string | null;
    },
  ): Promise<VendorReferrerOutcome<MonthlyReportResponse>>;
};

function serviceRoleRpc(): VendorReferrerRpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createVendorReferrerRepository(
  rpc?: VendorReferrerRpc,
): VendorReferrerRepository {
  let resolvedRpc: VendorReferrerRpc | undefined = rpc;
  const callRpc: VendorReferrerRpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<VendorReferrerOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) {
        return { ok: false, kind: classifyVendorReferrerError(error) };
      }
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      console.error(`[vendor-referrals] RPC failed: ${rpcName}`);
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    getActorAccess(input) {
      return call(
        "direct_entry_vendor_referrer_get_actor_access",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        projectActorAccess,
      );
    },
    listCandidates(input) {
      return call(
        "direct_entry_vendor_referrer_list_candidates",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_limit: input.limit,
        },
        projectCandidateList,
      );
    },
    listVendors(input) {
      return call(
        "direct_entry_vendor_referrer_list_vendors",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectVendorList,
      );
    },
    getHistory(input) {
      return call(
        "direct_entry_vendor_referrer_get_history",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
        },
        projectVendorHistory,
      );
    },
    assignReferrer(input) {
      return call(
        "direct_entry_vendor_referrer_assign",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_referrer_person_id: input.referrer_person_id,
          p_effective_date: input.effective_date,
          p_expected_current_link_id: input.expected_current_link_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAssignMutationResult,
      );
    },
    revokeReferrer(input) {
      return call(
        "direct_entry_vendor_referrer_revoke",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_effective_date: input.effective_date,
          p_expected_current_link_id: input.expected_current_link_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectRevokeMutationResult,
      );
    },
    getMonthlyReport(input) {
      return call(
        "direct_entry_vendor_referrer_monthly_report",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_month: input.month,
          p_referrer_person_id: input.referrer_person_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
        },
        projectMonthlyReport,
      );
    },
  };
}
