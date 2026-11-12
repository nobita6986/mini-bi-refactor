import "server-only";

import {
  projectAssignBranchResult,
  projectAssignSlotPolicyResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceExplanationApprovalInbox,
  projectAttendanceMonthlyMatrixReport,
  projectAttendanceMyExplanationsOverview,
  projectAttendanceSlotPoliciesAdminList,
  projectCreateSlotPolicyResult,
  projectDecideAttendanceExplanationResult,
  projectSubmitAttendanceExplanationResult,
  projectUnassignBranchResult,
  projectUnassignSlotPolicyResult,
  projectUpsertBranchResult,
  projectUpsertSlotPolicyProfileResult,
  type AssignAttendanceBranchResultProjection,
  type AssignAttendanceSlotPolicyResultProjection,
  type AttendanceBranchesAdminListProjection,
  type AttendanceExplanationApprovalInboxProjection,
  type AttendanceExplanationDecision,
  type AttendanceExplanationStatus,
  type AttendanceMonthlyMatrixErrorCode,
  type AttendanceMonthlyMatrixReportProjection,
  type AttendanceMyExplanationsOverviewProjection,
  type AttendanceSlotCode,
  type AttendanceSlotConfigItemProjection,
  type AttendanceSlotPoliciesAdminListProjection,
  type CreateAttendanceSlotPolicyResultProjection,
  type DecideAttendanceExplanationResultProjection,
  type SubmitAttendanceExplanationResultProjection,
  type UnassignAttendanceBranchResultProjection,
  type UnassignAttendanceSlotPolicyResultProjection,
  type UpsertAttendanceBranchResultProjection,
  type UpsertAttendanceSlotPolicyProfileResultProjection,
} from "./attendance-monthly-matrix-contract.ts";
import type { AttendanceRpcCaller } from "./attendance-repository.ts";

export type GetAttendanceMonthlyMatrixReportInput = {
  auth_subject: string;
  app_user_id: string;
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
  page: number;
  page_size: number;
  phase?: string | null;
};

export type GetAttendanceMonthlyMatrixReportResult =
  | { ok: true; report: AttendanceMonthlyMatrixReportProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type ListAttendanceBranchesAdminInput = {
  auth_subject: string;
  app_user_id: string;
  include_inactive: boolean;
};

export type ListAttendanceBranchesAdminResult =
  | { ok: true; data: AttendanceBranchesAdminListProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UpsertAttendanceBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  branch_id: string | null;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UpsertAttendanceBranchAdminResult =
  | { ok: true; result: UpsertAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type AssignEmployeeBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  target_app_user_id: string;
  branch_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type AssignEmployeeBranchAdminResult =
  | { ok: true; result: AssignAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UnassignEmployeeBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  assignment_id: string;
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UnassignEmployeeBranchAdminResult =
  | { ok: true; result: UnassignAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type GetAttendanceSlotPoliciesAdminInput = {
  auth_subject: string;
  app_user_id: string;
};

export type GetAttendanceSlotPoliciesAdminResult =
  | { ok: true; data: AttendanceSlotPoliciesAdminListProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type CreateAttendanceSlotPolicyAdminInput = {
  auth_subject: string;
  app_user_id: string;
  profile_id?: string | null;
  profile_code?: string | null;
  display_name?: string | null;
  description?: string | null;
  active?: boolean;
  expected_profile_version?: number;
  effective_from_date: string;
  slots: readonly AttendanceSlotConfigItemProjection[];
  slot_1_time?: string;
  slot_1_grace_before_minutes?: number;
  slot_1_grace_after_minutes?: number;
  slot_2_time?: string;
  slot_2_grace_before_minutes?: number;
  slot_2_grace_after_minutes?: number;
  slot_3_time?: string;
  slot_3_grace_before_minutes?: number;
  slot_3_grace_after_minutes?: number;
  slot_4_time?: string;
  slot_4_grace_before_minutes?: number;
  slot_4_grace_after_minutes?: number;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type CreateAttendanceSlotPolicyAdminResult =
  | { ok: true; result: CreateAttendanceSlotPolicyResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UpsertAttendanceSlotPolicyProfileAdminInput = {
  auth_subject: string;
  app_user_id: string;
  profile_id: string | null;
  profile_code: string | null;
  display_name: string | null;
  description: string | null;
  active: boolean;
  effective_from_date: string | null;
  slots: readonly AttendanceSlotConfigItemProjection[] | null;
  expected_version: number | null;
  expected_profile_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UpsertAttendanceSlotPolicyProfileAdminResult =
  | { ok: true; result: UpsertAttendanceSlotPolicyProfileResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type AssignEmployeeSlotPolicyAdminInput = {
  auth_subject: string;
  app_user_id: string;
  target_app_user_id: string;
  profile_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type AssignEmployeeSlotPolicyAdminResult =
  | { ok: true; result: AssignAttendanceSlotPolicyResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UnassignEmployeeSlotPolicyAdminInput = {
  auth_subject: string;
  app_user_id: string;
  assignment_id: string;
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UnassignEmployeeSlotPolicyAdminResult =
  | { ok: true; result: UnassignAttendanceSlotPolicyResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type GetMyAttendanceExplanationsOverviewInput = {
  auth_subject: string;
  app_user_id: string;
  business_date: string | null;
};

export type GetMyAttendanceExplanationsOverviewResult =
  | { ok: true; data: AttendanceMyExplanationsOverviewProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type SubmitAttendanceExplanationInput = {
  auth_subject: string;
  app_user_id: string;
  business_date: string;
  slot_code: AttendanceSlotCode;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type SubmitAttendanceExplanationResult =
  | { ok: true; result: SubmitAttendanceExplanationResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type ListAttendanceExplanationApprovalInboxInput = {
  auth_subject: string;
  app_user_id: string;
  status_filter: AttendanceExplanationStatus | "ALL";
};

export type ListAttendanceExplanationApprovalInboxResult =
  | { ok: true; data: AttendanceExplanationApprovalInboxProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type DecideAttendanceExplanationInput = {
  auth_subject: string;
  app_user_id: string;
  explanation_id: string;
  decision: AttendanceExplanationDecision;
  expected_row_version: number;
  decision_note: string | null;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DecideAttendanceExplanationResult =
  | { ok: true; result: DecideAttendanceExplanationResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type AttendanceMonthlyMatrixRepository = {
  getMonthlyMatrixReport(
    input: GetAttendanceMonthlyMatrixReportInput,
  ): Promise<GetAttendanceMonthlyMatrixReportResult>;
  listBranchesAdmin(
    input: ListAttendanceBranchesAdminInput,
  ): Promise<ListAttendanceBranchesAdminResult>;
  upsertBranchAdmin(
    input: UpsertAttendanceBranchAdminInput,
  ): Promise<UpsertAttendanceBranchAdminResult>;
  assignEmployeeBranchAdmin(
    input: AssignEmployeeBranchAdminInput,
  ): Promise<AssignEmployeeBranchAdminResult>;
  unassignEmployeeBranchAdmin(
    input: UnassignEmployeeBranchAdminInput,
  ): Promise<UnassignEmployeeBranchAdminResult>;
  getSlotPoliciesAdmin?(
    input: GetAttendanceSlotPoliciesAdminInput,
  ): Promise<GetAttendanceSlotPoliciesAdminResult>;
  createSlotPolicyAdmin?(
    input: CreateAttendanceSlotPolicyAdminInput,
  ): Promise<CreateAttendanceSlotPolicyAdminResult>;
  upsertSlotPolicyProfileAdmin?(
    input: UpsertAttendanceSlotPolicyProfileAdminInput,
  ): Promise<UpsertAttendanceSlotPolicyProfileAdminResult>;
  assignEmployeeSlotPolicyAdmin?(
    input: AssignEmployeeSlotPolicyAdminInput,
  ): Promise<AssignEmployeeSlotPolicyAdminResult>;
  unassignEmployeeSlotPolicyAdmin?(
    input: UnassignEmployeeSlotPolicyAdminInput,
  ): Promise<UnassignEmployeeSlotPolicyAdminResult>;
  getMyExplanationsOverview?(
    input: GetMyAttendanceExplanationsOverviewInput,
  ): Promise<GetMyAttendanceExplanationsOverviewResult>;
  submitExplanation?(
    input: SubmitAttendanceExplanationInput,
  ): Promise<SubmitAttendanceExplanationResult>;
  listExplanationApprovalInbox?(
    input: ListAttendanceExplanationApprovalInboxInput,
  ): Promise<ListAttendanceExplanationApprovalInboxResult>;
  decideExplanation?(
    input: DecideAttendanceExplanationInput,
  ): Promise<DecideAttendanceExplanationResult>;
};

const KNOWN_MATRIX_RPC_TOKENS: ReadonlyMap<string, AttendanceMonthlyMatrixErrorCode> = new Map([
  ["ATTENDANCE_ACTOR_DENIED", "ACTOR_NOT_AVAILABLE"],
  ["LEAVE_ACTOR_DENIED", "ACTOR_NOT_AVAILABLE"],
  ["ATTENDANCE_REPORT_ACCESS_DENIED", "ATTENDANCE_REPORT_ACCESS_DENIED"],
  ["ATTENDANCE_BRANCH_WRITE_DENIED", "ATTENDANCE_BRANCH_WRITE_DENIED"],
  ["ATTENDANCE_SLOT_POLICY_WRITE_DENIED", "ATTENDANCE_SLOT_POLICY_WRITE_DENIED"],
  ["ATTENDANCE_MATRIX_MONTH_INVALID", "ATTENDANCE_MATRIX_MONTH_INVALID"],
  ["ATTENDANCE_REPORT_PAGINATION_INVALID", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
  ["ATTENDANCE_REPORT_SEARCH_INVALID", "ATTENDANCE_REPORT_SEARCH_INVALID"],
  ["ATTENDANCE_REPORT_FILTER_CONFLICT", "ATTENDANCE_REPORT_FILTER_CONFLICT"],
  ["ATTENDANCE_BRANCH_INVALID", "ATTENDANCE_BRANCH_INVALID"],
  ["ATTENDANCE_BRANCH_NOT_FOUND", "ATTENDANCE_BRANCH_NOT_FOUND"],
  ["ATTENDANCE_BRANCH_CODE_CONFLICT", "ATTENDANCE_BRANCH_CODE_CONFLICT"],
  ["ATTENDANCE_BRANCH_VERSION_CONFLICT", "ATTENDANCE_BRANCH_VERSION_CONFLICT"],
  ["ATTENDANCE_BRANCH_INACTIVE", "ATTENDANCE_BRANCH_INACTIVE"],
  ["ATTENDANCE_BRANCH_TARGET_USER_INVALID", "ATTENDANCE_BRANCH_TARGET_USER_INVALID"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_INVALID", "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE", "ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE", "ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND", "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP", "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED", "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID", "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID"],
  [
    "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
    "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
  ],
  ["ATTENDANCE_SLOT_POLICY_INVALID", "ATTENDANCE_SLOT_POLICY_INVALID"],
  [
    "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST",
    "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST",
  ],
  ["ATTENDANCE_SLOT_POLICY_OVERLAP", "ATTENDANCE_SLOT_POLICY_OVERLAP"],
  ["ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT", "ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT"],
  [
    "ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND",
    "ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID",
    "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID",
    "ATTENDANCE_SLOT_POLICY_PROFILE_NAME_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT",
    "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE",
    "ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN",
    "ATTENDANCE_SLOT_POLICY_DEFAULT_DEACTIVATE_FORBIDDEN",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT",
    "ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID",
    "ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID",
  ],
  [
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT",
    "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT",
  ],
  ["ATTENDANCE_EXPLANATION_ACCESS_DENIED", "ATTENDANCE_EXPLANATION_ACCESS_DENIED"],
  ["ATTENDANCE_EXPLANATION_SUBMIT_DENIED", "ATTENDANCE_EXPLANATION_SUBMIT_DENIED"],
  ["ATTENDANCE_EXPLANATION_APPROVAL_ACCESS_DENIED", "ATTENDANCE_EXPLANATION_APPROVAL_ACCESS_DENIED"],
  ["ATTENDANCE_EXPLANATION_DECIDE_DENIED", "ATTENDANCE_EXPLANATION_DECIDE_DENIED"],
  ["ATTENDANCE_EXPLANATION_DECISION_DENIED", "ATTENDANCE_EXPLANATION_DECISION_DENIED"],
  ["ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN", "ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN"],
  ["ATTENDANCE_EXPLANATION_INVALID", "ATTENDANCE_EXPLANATION_INVALID"],
  ["ATTENDANCE_EXPLANATION_DATE_INVALID", "ATTENDANCE_EXPLANATION_DATE_INVALID"],
  ["ATTENDANCE_EXPLANATION_DECISION_INVALID", "ATTENDANCE_EXPLANATION_DECISION_INVALID"],
  ["ATTENDANCE_EXPLANATION_NOTE_INVALID", "ATTENDANCE_EXPLANATION_NOTE_INVALID"],
  ["ATTENDANCE_EXPLANATION_FILTER_INVALID", "ATTENDANCE_EXPLANATION_FILTER_INVALID"],
  ["ATTENDANCE_EXPLANATION_PAGINATION_INVALID", "ATTENDANCE_EXPLANATION_PAGINATION_INVALID"],
  ["ATTENDANCE_EXPLANATION_REASON_INVALID", "ATTENDANCE_EXPLANATION_REASON_INVALID"],
  ["ATTENDANCE_EXPLANATION_SLOT_INVALID", "ATTENDANCE_EXPLANATION_SLOT_INVALID"],
  ["ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE", "ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE"],
  ["ATTENDANCE_EXPLANATION_DATE_FUTURE", "ATTENDANCE_EXPLANATION_DATE_FUTURE"],
  [
    "ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED",
    "ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED",
  ],
  [
    "ATTENDANCE_EXPLANATION_APPROVER_UNCONFIGURED",
    "ATTENDANCE_EXPLANATION_APPROVER_UNCONFIGURED",
  ],
  ["ATTENDANCE_EXPLANATION_ALREADY_EXISTS", "ATTENDANCE_EXPLANATION_ALREADY_EXISTS"],
  ["ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED", "ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED"],
  ["ATTENDANCE_EXPLANATION_ALREADY_DECIDED", "ATTENDANCE_EXPLANATION_ALREADY_DECIDED"],
  ["ATTENDANCE_EXPLANATION_NOT_FOUND", "ATTENDANCE_EXPLANATION_NOT_FOUND"],
  ["ATTENDANCE_EXPLANATION_VERSION_CONFLICT", "ATTENDANCE_EXPLANATION_VERSION_CONFLICT"],
  ["ATTENDANCE_EXPLANATION_STATE_INVALID", "ATTENDANCE_EXPLANATION_STATE_INVALID"],
  ["ATTENDANCE_IDEMPOTENCY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
]);

function serviceRoleRpc(): AttendanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyMatrixRpcError(
  error: { code?: string; message?: string },
  mode:
    | "report"
    | "branch_write"
    | "assignment_write"
    | "slot_policy_write"
    | "slot_policy_assignment_write"
    | "explanation_read"
    | "explanation_write"
    | "explanation_decide",
): AttendanceMonthlyMatrixErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_MATRIX_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_MATRIX_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (error.code === "42501") {
    if (mode === "report") return "ATTENDANCE_REPORT_ACCESS_DENIED";
    if (mode === "slot_policy_write" || mode === "slot_policy_assignment_write") {
      return "ATTENDANCE_SLOT_POLICY_WRITE_DENIED";
    }
    if (mode === "explanation_decide") return "ATTENDANCE_EXPLANATION_DECISION_DENIED";
    if (mode === "explanation_read" || mode === "explanation_write") {
      return "ATTENDANCE_EXPLANATION_ACCESS_DENIED";
    }
    return "ATTENDANCE_BRANCH_WRITE_DENIED";
  }
  if (error.code === "P0002") {
    if (mode === "explanation_read" || mode === "explanation_write" || mode === "explanation_decide") {
      return "ATTENDANCE_EXPLANATION_NOT_FOUND";
    }
    if (mode === "slot_policy_write") {
      return "ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND";
    }
    if (mode === "slot_policy_assignment_write") {
      return "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND";
    }
    return mode === "assignment_write"
      ? "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND"
      : "ATTENDANCE_BRANCH_NOT_FOUND";
  }
  if (error.code === "PT409" || error.code === "40001") {
    if (mode === "assignment_write") return "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT";
    if (mode === "slot_policy_assignment_write") {
      return "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT";
    }
    if (mode === "slot_policy_write") return "ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT";
    if (mode === "explanation_write" || mode === "explanation_decide") {
      return "ATTENDANCE_EXPLANATION_VERSION_CONFLICT";
    }
    return "ATTENDANCE_BRANCH_VERSION_CONFLICT";
  }
  if (error.code === "23505") {
    if (trimmed.includes("attendance_branch_assignments_one_open_idx")) {
      return "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP";
    }
    if (trimmed.includes("attendance_slot_policy_assignments_one_open_idx")) {
      return "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP";
    }
    if (trimmed.includes("attendance_branches_code_uq")) {
      return "ATTENDANCE_BRANCH_CODE_CONFLICT";
    }
    if (trimmed.includes("attendance_slot_policy_profiles_code_uq")) {
      return "ATTENDANCE_SLOT_POLICY_PROFILE_CODE_CONFLICT";
    }
    if (
      trimmed.includes("attendance_slot_policy_versions_effective_from_date_key") ||
      trimmed.includes("attendance_slot_policy_versions_profile_effective_from_uq")
    ) {
      return "ATTENDANCE_SLOT_POLICY_OVERLAP";
    }
    if (trimmed.includes("attendance_explanations_employee_date_slot_uq")) {
      return "ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED";
    }
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "22023" || error.code === "23514") {
    if (mode === "branch_write") return "ATTENDANCE_BRANCH_INVALID";
    if (mode === "assignment_write") return "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID";
    if (mode === "slot_policy_assignment_write") {
      return "ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID";
    }
    if (mode === "slot_policy_write") return "ATTENDANCE_SLOT_POLICY_INVALID";
    if (
      mode === "explanation_read" ||
      mode === "explanation_write" ||
      mode === "explanation_decide"
    ) {
      return "ATTENDANCE_EXPLANATION_INVALID";
    }
    return "ATTENDANCE_REPORT_QUERY_INVALID";
  }

  return "ATTENDANCE_REPORT_UNAVAILABLE";
}

const DIAGNOSTIC_SQLSTATE_PATTERN = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/;
const DIAGNOSTIC_PHASE_PATTERN = /^[a-z0-9_:-]{1,64}$/;

export function sanitizeAttendanceDiagnosticSqlstate(rawCode: unknown): string | null {
  if (typeof rawCode !== "string") {
    return null;
  }
  const trimmed = rawCode.trim();
  return DIAGNOSTIC_SQLSTATE_PATTERN.test(trimmed) ? trimmed : null;
}

function sanitizeDiagnosticPhase(rawPhase: unknown, fallbackPhase: string): string {
  if (typeof rawPhase !== "string") {
    return fallbackPhase;
  }
  const trimmed = rawPhase.trim();
  return DIAGNOSTIC_PHASE_PATTERN.test(trimmed) ? trimmed : fallbackPhase;
}

export function logAttendanceMatrixDiagnostic(input: {
  phase: string | null | undefined;
  fallback_phase: string;
  code: AttendanceMonthlyMatrixErrorCode;
  sqlstate?: unknown;
}): void {
  console.error("[attendance-monthly-matrix] diagnostic", {
    phase: sanitizeDiagnosticPhase(input.phase, input.fallback_phase),
    code: input.code,
    sqlstate: sanitizeAttendanceDiagnosticSqlstate(input.sqlstate),
  });
}

export function createServiceAttendanceMonthlyMatrixRepository(
  rpc?: AttendanceRpcCaller,
): AttendanceMonthlyMatrixRepository {
  let resolvedRpc = rpc;

  return {
    async getMonthlyMatrixReport(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_monthly_matrix_report", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_year_month: input.year_month,
          p_branch_id: input.branch_id,
          p_employee_id: input.employee_id,
          p_search: input.search,
          p_page: input.page,
          p_page_size: input.page_size,
        });

        if (result.error) {
          const code = classifyMatrixRpcError(result.error, "report");
          logAttendanceMatrixDiagnostic({
            phase: input.phase,
            fallback_phase: "rpc_call",
            code,
            sqlstate: result.error.code,
          });
          return { ok: false, code };
        }

        const projected = projectAttendanceMonthlyMatrixReport(result.data);
        if (!projected) {
          logAttendanceMatrixDiagnostic({
            phase: input.phase ? `${input.phase}:projection` : null,
            fallback_phase: "projection",
            code: "ATTENDANCE_REPORT_UNAVAILABLE",
            sqlstate: null,
          });
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, report: projected };
      } catch {
        logAttendanceMatrixDiagnostic({
          phase: input.phase ? `${input.phase}:exception` : null,
          fallback_phase: "rpc_exception",
          code: "ATTENDANCE_REPORT_UNAVAILABLE",
          sqlstate: null,
        });
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async listBranchesAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_list_branches_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_include_inactive: input.include_inactive,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "report") };
        }

        const projected = projectAttendanceBranchesAdminList(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] list branches RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, data: projected };
      } catch {
        console.error("[attendance-monthly-matrix] list branches RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async upsertBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_upsert_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_branch_id: input.branch_id,
          p_branch_code: input.branch_code,
          p_display_name: input.display_name,
          p_address: input.address,
          p_latitude: input.latitude,
          p_longitude: input.longitude,
          p_active: input.active,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "branch_write") };
        }

        const projected = projectUpsertBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] upsert branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] upsert branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async assignEmployeeBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_assign_employee_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.target_app_user_id,
          p_branch_id: input.branch_id,
          p_valid_from: input.valid_from,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "assignment_write") };
        }

        const projected = projectAssignBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] assign branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] assign branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async unassignEmployeeBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_unassign_employee_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id,
          p_valid_to: input.valid_to,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "assignment_write") };
        }

        const projected = projectUnassignBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] unassign branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] unassign branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async getSlotPoliciesAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_get_slot_policies_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "report") };
        }

        const projected = projectAttendanceSlotPoliciesAdminList(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] get slot policies RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, data: projected };
      } catch {
        console.error("[attendance-monthly-matrix] get slot policies RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async createSlotPolicyAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const hasProfileFields =
          input.profile_id !== undefined ||
          input.profile_code !== undefined ||
          input.display_name !== undefined ||
          input.description !== undefined ||
          input.active !== undefined ||
          input.expected_profile_version !== undefined;
        const result = hasProfileFields
          ? await resolvedRpc("attendance_upsert_slot_policy_profile_admin", {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_profile_id: input.profile_id ?? null,
              p_profile_code: input.profile_code ?? null,
              p_display_name: input.display_name ?? null,
              p_description: input.description ?? null,
              p_active: input.active ?? true,
              p_effective_from_date: input.effective_from_date,
              p_slots: input.slots,
              p_expected_version: input.expected_version,
              p_expected_profile_version:
                input.expected_profile_version ?? (input.profile_id ? null : 0),
              p_idempotency_key: input.idempotency_key,
              p_request_fingerprint: input.request_fingerprint,
            })
          : await resolvedRpc("attendance_create_slot_policy_admin", {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_effective_from_date: input.effective_from_date,
              p_slots: input.slots,
              p_expected_version: input.expected_version,
              p_idempotency_key: input.idempotency_key,
              p_request_fingerprint: input.request_fingerprint,
            });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "slot_policy_write") };
        }

        const projected = projectCreateSlotPolicyResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] create slot policy RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] create slot policy RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async upsertSlotPolicyProfileAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_upsert_slot_policy_profile_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_profile_id: input.profile_id,
          p_profile_code: input.profile_code,
          p_display_name: input.display_name,
          p_description: input.description,
          p_active: input.active,
          p_effective_from_date: input.effective_from_date,
          p_slots: input.slots,
          p_expected_version: input.expected_version,
          p_expected_profile_version: input.expected_profile_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "slot_policy_write") };
        }

        const projected = projectUpsertSlotPolicyProfileResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] upsert slot policy profile RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] upsert slot policy profile RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async assignEmployeeSlotPolicyAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_assign_employee_slot_policy_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.target_app_user_id,
          p_profile_id: input.profile_id,
          p_effective_date: input.valid_from,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return {
            ok: false,
            code: classifyMatrixRpcError(result.error, "slot_policy_assignment_write"),
          };
        }

        const projected = projectAssignSlotPolicyResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] assign employee slot policy RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] assign employee slot policy RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async unassignEmployeeSlotPolicyAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_unassign_employee_slot_policy_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id,
          p_effective_date: input.valid_to,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return {
            ok: false,
            code: classifyMatrixRpcError(result.error, "slot_policy_assignment_write"),
          };
        }

        const projected = projectUnassignSlotPolicyResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] unassign employee slot policy RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] unassign employee slot policy RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async getMyExplanationsOverview(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_get_my_explanations_overview", {
          p_actor_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.app_user_id,
          p_business_date: input.business_date,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "explanation_read") };
        }

        const projected = projectAttendanceMyExplanationsOverview(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] get my explanations overview RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, data: projected };
      } catch {
        console.error("[attendance-monthly-matrix] get my explanations overview RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async submitExplanation(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_submit_explanation", {
          p_actor_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.app_user_id,
          p_business_date: input.business_date,
          p_slot_code: input.slot_code,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "explanation_write") };
        }

        const projected = projectSubmitAttendanceExplanationResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] submit explanation RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] submit explanation RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async listExplanationApprovalInbox(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_list_explanation_approval_inbox", {
          p_actor_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.app_user_id,
          p_status_filter: input.status_filter,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "explanation_read") };
        }

        const projected = projectAttendanceExplanationApprovalInbox(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] list explanation approval inbox RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, data: projected };
      } catch {
        console.error(
          "[attendance-monthly-matrix] list explanation approval inbox RPC call failed",
        );
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async decideExplanation(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_decide_explanation", {
          p_actor_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.app_user_id,
          p_explanation_id: input.explanation_id,
          p_decision: input.decision,
          p_expected_row_version: input.expected_row_version,
          p_decision_note: input.decision_note,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "explanation_decide") };
        }

        const projected = projectDecideAttendanceExplanationResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] decide explanation RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] decide explanation RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },
  };
}
