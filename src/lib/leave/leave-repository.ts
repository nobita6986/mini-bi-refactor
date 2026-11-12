import "server-only";

import { createServiceSupabaseClient } from "../supabase/server.ts";
import type {
  ApplyOpeningBatchInput,
  CreateLeaveRequestInput,
  DecideLeaveRequestInput,
  LeaveAdminAccountStatusFilter,
  LeaveErrorCode,
  LeaveRequestStatusFilter,
  PatchAdminConfigInput,
  PreviewOpeningBatchInput,
  WithdrawLeaveRequestInput,
} from "./leave-contract.ts";

export type LeaveActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type LeaveRepoResult<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; code: LeaveErrorCode };

export type LeaveRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

const KNOWN_LEAVE_ERROR_CODES = new Set<LeaveErrorCode>([
  "LEAVE_SHARED_ACCOUNT_FORBIDDEN",
  "LEAVE_IDEMPOTENCY_KEY_INVALID",
  "LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH",
  "LEAVE_REASON_INVALID",
  "LEAVE_REASON_REQUIRED",
  "LEAVE_REQUEST_DAYS_INVALID",
  "LEAVE_TYPE_INVALID",
  "LEAVE_TYPE_LIMIT_EXCEEDED",
  "LEAVE_TYPE_ALLOCATION_MISMATCH",
  "LEAVE_REQUEST_YEAR_OUT_OF_RANGE",
  "LEAVE_REQUEST_DUPLICATE_DATE",
  "LEAVE_REQUEST_OVERLAP",
  "LEAVE_INSUFFICIENT_BALANCE",
  "LEAVE_REQUEST_NOT_FOUND",
  "LEAVE_REQUEST_OWNERSHIP_FORBIDDEN",
  "LEAVE_ROW_VERSION_CONFLICT",
  "LEAVE_INVALID_STATE_TRANSITION",
  "LEAVE_APPROVAL_FORBIDDEN",
  "LEAVE_SELF_APPROVAL_FORBIDDEN",
  "LEAVE_DECISION_INVALID",
  "LEAVE_FILTER_INVALID",
  "LEAVE_ADMIN_FORBIDDEN",
  "LEAVE_POLICY_ADMIN_FORBIDDEN",
  "LEAVE_POLICY_EXPIRY_INVALID",
  "LEAVE_TARGET_USER_NOT_FOUND",
  "LEAVE_PROFILE_INVALID",
  "LEAVE_PROFILE_WORK_START_DATE_REQUIRED",
  "LEAVE_PROFILE_OFFICIAL_DATE_INVALID",
  "LEAVE_SENIORITY_CONFIG_FORBIDDEN",
  "LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN",
  "LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN",
  "LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN",
  "LEAVE_UNIT_KIND_INVALID",
  "LEAVE_APPROVER_USER_NOT_FOUND",
  "LEAVE_MODULE_GRANT_ADMIN_FORBIDDEN",
  "LEAVE_MODULE_GRANT_INVALID",
  "LEAVE_MODULE_GRANT_NOT_FOUND",
  "LEAVE_YEAR_INVALID",
  "LEAVE_OPENING_ROWS_INVALID",
  "LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED",
  "LEAVE_OPENING_BATCH_VALIDATION_FAILED",
  "LEAVE_OPENING_PREVIEW_STALE",
  "LEAVE_REPORT_FORBIDDEN",
  "LEAVE_REPORT_YEAR_MONTH_INVALID",
]);

export function mapLeaveRpcError(error: {
  code?: string;
  message?: string;
}): LeaveErrorCode {
  const message = (error.message ?? "").trim();
  for (const known of KNOWN_LEAVE_ERROR_CODES) {
    if (message.includes(known)) {
      return known;
    }
  }
  if (
    message.includes("OPENING_TARGET_BELOW_LOCKED_BALANCE") ||
    message.includes("SENIORITY_LOT_ALREADY_EXISTS")
  ) {
    return "LEAVE_OPENING_BATCH_VALIDATION_FAILED";
  }
  if (message.includes("LEAVE_IDEMPOTENCY_PAYLOAD_CONFLICT")) {
    return "LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH";
  }
  if (message.includes("Direct entry actor mapping is not active")) {
    return "ACTOR_NOT_AVAILABLE";
  }
  if (error.code === "42501") {
    return "ACTOR_NOT_AVAILABLE";
  }
  if (error.code === "23505") {
    return "LEAVE_REQUEST_OVERLAP";
  }
  if (error.code === "PT409" || error.code === "40001") {
    return "LEAVE_ROW_VERSION_CONFLICT";
  }
  if (error.code === "P0002") {
    return "LEAVE_REQUEST_NOT_FOUND";
  }
  return "LEAVE_UNAVAILABLE";
}

function defaultLeaveRpcCaller(): LeaveRpcCaller {
  return async (fn, args) => {
    const supabase = createServiceSupabaseClient();
    const { data, error } = await supabase.rpc(fn, args);
    return {
      data,
      error: error
        ? { code: error.code, message: error.message }
        : null,
    };
  };
}

export type LeaveRepository = {
  getMySummary(
    input: LeaveActorRef & { leave_year: number | null },
  ): Promise<LeaveRepoResult>;

  createRequest(
    input: LeaveActorRef & CreateLeaveRequestInput,
  ): Promise<LeaveRepoResult>;

  withdrawRequest(
    input: LeaveActorRef & { request_id: string } & WithdrawLeaveRequestInput,
  ): Promise<LeaveRepoResult>;

  listApprovalInbox(
    input: LeaveActorRef & {
      status_filter: LeaveRequestStatusFilter;
      limit: number;
      offset: number;
    },
  ): Promise<LeaveRepoResult>;

  decideRequest(
    input: LeaveActorRef & { request_id: string } & DecideLeaveRequestInput,
  ): Promise<LeaveRepoResult>;

  getAdminOverview(
    input: LeaveActorRef & {
      search: string | null;
      limit: number;
      offset: number;
      account_status: LeaveAdminAccountStatusFilter;
    },
  ): Promise<LeaveRepoResult>;

  patchAdminConfig(
    input: LeaveActorRef & PatchAdminConfigInput,
  ): Promise<LeaveRepoResult>;

  previewOpeningBatch(
    input: LeaveActorRef & PreviewOpeningBatchInput,
  ): Promise<LeaveRepoResult>;

  applyOpeningBatch(
    input: LeaveActorRef & ApplyOpeningBatchInput,
  ): Promise<LeaveRepoResult>;

  getMonthlyReport(
    input: LeaveActorRef & {
      year_month: string;
      unit_kind_filter: string | null;
      search: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<LeaveRepoResult>;
};

export function createLeaveRepository(
  callRpc: LeaveRpcCaller = defaultLeaveRpcCaller(),
): LeaveRepository {
  async function invoke(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<LeaveRepoResult> {
    try {
      const { data, error } = await callRpc(fn, args);
      if (error) {
        return { ok: false, code: mapLeaveRpcError(error) };
      }
      if (!data || typeof data !== "object") {
        return { ok: false, code: "LEAVE_UNAVAILABLE" };
      }
      return { ok: true, data: data as Record<string, unknown> };
    } catch {
      return { ok: false, code: "LEAVE_UNAVAILABLE" };
    }
  }

  return {
    getMySummary(input) {
      return invoke("leave_management_get_my_summary", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_leave_year: input.leave_year,
      });
    },

    createRequest(input) {
      return invoke("leave_management_create_request", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_days: input.days,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_request_fingerprint: input.request_fingerprint,
      });
    },

    withdrawRequest(input) {
      return invoke("leave_management_withdraw_request", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_request_id: input.request_id,
        p_expected_row_version: input.expected_row_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_request_fingerprint: input.request_fingerprint,
      });
    },

    listApprovalInbox(input) {
      return invoke("leave_management_list_approval_inbox", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_status_filter: input.status_filter,
        p_limit: input.limit,
        p_offset: input.offset,
      });
    },

    decideRequest(input) {
      return invoke("leave_management_decide_request", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_request_id: input.request_id,
        p_decision: input.decision,
        p_expected_row_version: input.expected_row_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_request_fingerprint: input.request_fingerprint,
      });
    },

    getAdminOverview(input) {
      return invoke("leave_management_get_admin_overview", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_search: input.search,
        p_limit: input.limit,
        p_offset: input.offset,
        p_account_status: input.account_status,
      });
    },

    patchAdminConfig(input) {
      switch (input.operation) {
        case "UPDATE_POLICY":
          return invoke("leave_management_update_policy_admin", {
            p_actor_auth_subject: input.auth_subject,
            p_actor_app_user_id: input.app_user_id,
            p_carry_over_expiry_month: input.carry_over_expiry_month,
            p_carry_over_expiry_day: input.carry_over_expiry_day,
            p_expected_row_version: input.expected_row_version,
            p_reason: input.reason,
            p_idempotency_key: input.idempotency_key,
            p_request_fingerprint: input.request_fingerprint,
          });
        case "UPSERT_EMPLOYEE_PROFILE":
          return invoke("leave_management_upsert_employee_profile_admin", {
            p_actor_auth_subject: input.auth_subject,
            p_actor_app_user_id: input.app_user_id,
            p_target_app_user_id: input.target_app_user_id,
            p_is_shared_non_employee: input.is_shared_non_employee,
            p_employment_status: input.employment_status,
            p_unit_kind: input.unit_kind,
            p_work_start_date: input.work_start_date,
            p_official_effective_date: input.official_effective_date,
            p_next_seniority_effective_date: input.next_seniority_effective_date,
            p_next_seniority_units: input.next_seniority_units,
            p_expected_row_version: input.expected_row_version,
            p_reason: input.reason,
            p_idempotency_key: input.idempotency_key,
            p_request_fingerprint: input.request_fingerprint,
          });
        case "SET_DEPARTMENT_APPROVER":
          return invoke("leave_management_set_department_approver_admin", {
            p_actor_auth_subject: input.auth_subject,
            p_actor_app_user_id: input.app_user_id,
            p_unit_kind: input.unit_kind,
            p_approver_app_user_id: input.approver_app_user_id,
            p_valid_from: input.valid_from,
            p_expected_row_version: input.expected_row_version,
            p_reason: input.reason,
            p_idempotency_key: input.idempotency_key,
            p_request_fingerprint: input.request_fingerprint,
          });
        case "MANAGE_MODULE_GRANT":
          return invoke("leave_management_manage_module_grant_admin", {
            p_actor_auth_subject: input.auth_subject,
            p_actor_app_user_id: input.app_user_id,
            p_action: input.action,
            p_target_app_user_id: input.target_app_user_id,
            p_role_code: input.role_code,
            p_expected_row_version: input.expected_row_version,
            p_reason: input.reason,
            p_idempotency_key: input.idempotency_key,
            p_request_fingerprint: input.request_fingerprint,
          });
      }
    },

    previewOpeningBatch(input) {
      return invoke("leave_management_preview_opening_batch", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_leave_year: input.leave_year,
        p_rows: input.rows,
      });
    },

    applyOpeningBatch(input) {
      return invoke("leave_management_apply_opening_batch", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_leave_year: input.leave_year,
        p_rows: input.rows,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
        p_request_fingerprint: input.request_fingerprint,
      });
    },

    getMonthlyReport(input) {
      return invoke("leave_management_monthly_report", {
        p_actor_auth_subject: input.auth_subject,
        p_actor_app_user_id: input.app_user_id,
        p_year_month: input.year_month,
        p_unit_kind_filter: input.unit_kind_filter,
        p_search: input.search,
        p_limit: input.limit,
        p_offset: input.offset,
      });
    },
  };
}
