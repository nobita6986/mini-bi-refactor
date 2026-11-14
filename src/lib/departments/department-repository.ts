import "server-only";

import {
  projectAccountingCandidateListResponse,
  projectAccountingMembershipListResponse,
  projectAccountingMembershipMutationResponse,
  projectDepartmentDetailResponse,
  projectDepartmentHeadsListResponse,
  projectDepartmentListResponse,
  projectDepartmentMutationResponse,
  projectDepartmentPersonMemberMutationResponse,
  projectDepartmentPersonMembershipsListResponse,
  projectDesignateDepartmentHeadResponse,
  projectEndDepartmentHeadResponse,
  projectRecruitmentTeamsResponse,
  type AccountingCandidateListProjection,
  type AccountingMembershipListProjection,
  type AccountingMembershipMutationProjection,
  type DepartmentDetailProjection,
  type DepartmentErrorCode,
  type DepartmentHeadsListProjection,
  type DepartmentListProjection,
  type DepartmentMutationProjection,
  type DepartmentPersonMemberMutationProjection,
  type DepartmentPersonMembershipsListProjection,
  type DepartmentPersonMembershipStatusFilter,
  type DesignateDepartmentHeadProjection,
  type EndDepartmentHeadProjection,
  type RecruitmentTeamListProjection,
} from "./department-contract.ts";

export type DepartmentRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type DepartmentActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type ListDepartmentsResult =
  | { ok: true; data: DepartmentListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type GetDepartmentDetailResult =
  | { ok: true; data: DepartmentDetailProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListAccountingMembershipsInput = DepartmentActorRef & {
  search: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export type ListAccountingMembershipsResult =
  | { ok: true; data: AccountingMembershipListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListAccountingCandidatesInput = DepartmentActorRef & {
  search: string | null;
  page: number;
  page_size: number;
};

export type ListAccountingCandidatesResult =
  | { ok: true; data: AccountingCandidateListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type AssignAccountingMemberInput = DepartmentActorRef & {
  account_ref: string;
  expected_pair_version: number;
  effective_from: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type EndAccountingMemberInput = DepartmentActorRef & {
  membership_id: string;
  expected_pair_version: number;
  effective_to: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type AccountingMembershipMutationResult =
  | { ok: true; data: AccountingMembershipMutationProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListRecruitmentTeamsInput = DepartmentActorRef & {
  search: string | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
};

export type ListRecruitmentTeamsResult =
  | { ok: true; data: RecruitmentTeamListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type CreateDepartmentInput = DepartmentActorRef & {
  code: string;
  name: string;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UpdateDepartmentInput = DepartmentActorRef & {
  department_id: string;
  expected_department_version: number;
  name: string;
  is_active: boolean;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DepartmentMutationResult =
  | { ok: true; data: DepartmentMutationProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListDepartmentPersonMembershipsInput = DepartmentActorRef & {
  department_id: string;
  status: DepartmentPersonMembershipStatusFilter;
  search: string | null;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type ListDepartmentPersonMembershipsResult =
  | { ok: true; data: DepartmentPersonMembershipsListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type AssignDepartmentPersonMemberInput = DepartmentActorRef & {
  department_id: string;
  person_id: string;
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type EndDepartmentPersonMemberInput = DepartmentActorRef & {
  department_id: string;
  membership_id: string;
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DepartmentPersonMemberMutationResult =
  | { ok: true; data: DepartmentPersonMemberMutationProjection }
  | { ok: false; code: DepartmentErrorCode };

export type ListDepartmentHeadsInput = DepartmentActorRef & {
  department_id: string;
  include_history: boolean;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type ListDepartmentHeadsResult =
  | { ok: true; data: DepartmentHeadsListProjection }
  | { ok: false; code: DepartmentErrorCode };

export type DesignateDepartmentHeadInput = DepartmentActorRef & {
  department_id: string;
  person_id: string;
  expected_department_version: number;
  expected_current_head_assignment_id: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type DesignateDepartmentHeadResult =
  | { ok: true; data: DesignateDepartmentHeadProjection }
  | { ok: false; code: DepartmentErrorCode };

export type EndDepartmentHeadInput = DepartmentActorRef & {
  department_id: string;
  expected_department_version: number;
  expected_current_head_assignment_id: string;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type EndDepartmentHeadResult =
  | { ok: true; data: EndDepartmentHeadProjection }
  | { ok: false; code: DepartmentErrorCode };

export type DepartmentRepository = {
  listDepartments(
    actor: DepartmentActorRef & { include_inactive?: boolean; as_of?: string | null },
  ): Promise<ListDepartmentsResult>;
  getDepartment(
    input: DepartmentActorRef & { department_id: string; as_of?: string | null },
  ): Promise<GetDepartmentDetailResult>;
  createDepartment(input: CreateDepartmentInput): Promise<DepartmentMutationResult>;
  updateDepartment(input: UpdateDepartmentInput): Promise<DepartmentMutationResult>;
  listPersonMemberships(
    input: ListDepartmentPersonMembershipsInput,
  ): Promise<ListDepartmentPersonMembershipsResult>;
  assignPersonMember(
    input: AssignDepartmentPersonMemberInput,
  ): Promise<DepartmentPersonMemberMutationResult>;
  endPersonMember(
    input: EndDepartmentPersonMemberInput,
  ): Promise<DepartmentPersonMemberMutationResult>;
  listDepartmentHeads(input: ListDepartmentHeadsInput): Promise<ListDepartmentHeadsResult>;
  designateHead(input: DesignateDepartmentHeadInput): Promise<DesignateDepartmentHeadResult>;
  endHead(input: EndDepartmentHeadInput): Promise<EndDepartmentHeadResult>;
  listAccountingMemberships(
    input: ListAccountingMembershipsInput,
  ): Promise<ListAccountingMembershipsResult>;
  listAccountingCandidates(
    input: ListAccountingCandidatesInput,
  ): Promise<ListAccountingCandidatesResult>;
  assignAccountingMember(
    input: AssignAccountingMemberInput,
  ): Promise<AccountingMembershipMutationResult>;
  endAccountingMember(
    input: EndAccountingMemberInput,
  ): Promise<AccountingMembershipMutationResult>;
  listRecruitmentTeams(
    input: ListRecruitmentTeamsInput,
  ): Promise<ListRecruitmentTeamsResult>;
};

const KNOWN_RPC_TOKENS: ReadonlyMap<string, DepartmentErrorCode> = new Map([
  ["DEPARTMENT_QUERY_INVALID", "DEPARTMENT_QUERY_INVALID"],
  ["DEPARTMENT_SEARCH_INVALID", "DEPARTMENT_SEARCH_INVALID"],
  ["DEPARTMENT_NOT_FOUND", "DEPARTMENT_NOT_FOUND"],
  ["DEPARTMENT_INACTIVE", "DEPARTMENT_INACTIVE"],
  ["DEPARTMENT_MEMBERSHIP_UNSUPPORTED", "DEPARTMENT_MEMBERSHIP_UNSUPPORTED"],
  ["DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID", "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID"],
  ["DEPARTMENT_MEMBERSHIP_REASON_INVALID", "DEPARTMENT_MEMBERSHIP_REASON_INVALID"],
  [
    "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID",
    "DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID",
  ],
  ["DEPARTMENT_MEMBERSHIP_NOT_FOUND", "DEPARTMENT_MEMBERSHIP_NOT_FOUND"],
  ["TARGET_ACCOUNT_NOT_FOUND", "TARGET_ACCOUNT_NOT_FOUND"],
  ["TARGET_ACCOUNT_DISABLED", "TARGET_ACCOUNT_DISABLED"],
  ["DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT", "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT"],
  ["DEPARTMENT_MEMBERSHIP_OVERLAP", "DEPARTMENT_MEMBERSHIP_OVERLAP"],
  ["DEPARTMENT_MEMBERSHIP_ALREADY_ENDED", "DEPARTMENT_MEMBERSHIP_ALREADY_ENDED"],
  ["DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS", "DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS"],
  ["DUPLICATE_CODE", "DUPLICATE_CODE"],
  ["VERSION_CONFLICT", "VERSION_CONFLICT"],
  ["PERSON_NOT_FOUND", "PERSON_NOT_FOUND"],
  ["PERSON_INACTIVE", "PERSON_INACTIVE"],
  ["PERSON_ALREADY_IN_DEPARTMENT", "PERSON_ALREADY_IN_DEPARTMENT"],
  ["PERSON_ALREADY_IN_OTHER_DEPARTMENT", "PERSON_ALREADY_IN_OTHER_DEPARTMENT"],
  ["PERSON_IS_ACTIVE_DEPARTMENT_HEAD", "PERSON_IS_ACTIVE_DEPARTMENT_HEAD"],
  ["PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT", "PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT"],
  ["HEAD_ALREADY_ENDED", "HEAD_ALREADY_ENDED"],
  ["CLIENT_SCHEDULE_FIELD_FORBIDDEN", "CLIENT_SCHEDULE_FIELD_FORBIDDEN"],
  ["CLIENT_AUTHORITY_FIELD_FORBIDDEN", "CLIENT_AUTHORITY_FIELD_FORBIDDEN"],
  ["ORG_VALIDATION_ERROR", "ORG_VALIDATION_ERROR"],
  ["IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["IDEMPOTENCY_KEY_MISMATCH", "IDEMPOTENCY_KEY_MISMATCH"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
]);

function serviceRoleRpc(): DepartmentRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyDepartmentRpcError(
  error: { code?: string; message?: string },
  mode: "read" | "mutation",
  wp3 = false,
): DepartmentErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }

  if (error.code === "42501") {
    return "DEPARTMENT_ACCESS_DENIED";
  }
  if (error.code === "P0002") {
    return mode === "mutation"
      ? wp3
        ? "DEPARTMENT_NOT_FOUND"
        : "DEPARTMENT_MEMBERSHIP_NOT_FOUND"
      : "DEPARTMENT_NOT_FOUND";
  }
  if (error.code === "PT409" || error.code === "40001") {
    return wp3 ? "VERSION_CONFLICT" : "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT";
  }
  if (error.code === "23505") {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "23P01") {
    return "DEPARTMENT_MEMBERSHIP_OVERLAP";
  }
  if (error.code === "22023" || error.code === "23514") {
    return wp3
      ? "ORG_VALIDATION_ERROR"
      : mode === "mutation"
        ? "DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID"
        : "DEPARTMENT_QUERY_INVALID";
  }

  return "DEPARTMENT_UNAVAILABLE";
}

export function createServiceDepartmentRepository(
  rpc?: DepartmentRpcCaller,
): DepartmentRepository {
  let resolvedRpc = rpc;

  return {
    async listDepartments(actor) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const rpcArgs: Record<string, unknown> = {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        };
        if (actor.include_inactive !== undefined) {
          rpcArgs.p_include_inactive = actor.include_inactive;
        }
        if (actor.as_of !== undefined && actor.as_of !== null) {
          rpcArgs.p_as_of = actor.as_of;
        }
        const result = await resolvedRpc("org_department_list_departments_admin", rpcArgs);
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectDepartmentListResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] list departments returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list departments RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async getDepartment(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const rpcArgs: Record<string, unknown> = {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
        };
        if (input.as_of !== undefined && input.as_of !== null) {
          rpcArgs.p_as_of = input.as_of;
        }
        const result = await resolvedRpc("org_department_get_department_admin", rpcArgs);
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectDepartmentDetailResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] get department returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] get department RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async createDepartment(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_create_department_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_code: input.code,
          p_name: input.name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectDepartmentMutationResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] create department returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] create department RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async updateDepartment(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_update_department_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_expected_department_version: input.expected_department_version,
          p_name: input.name,
          p_is_active: input.is_active,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectDepartmentMutationResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] update department returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] update department RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listPersonMemberships(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_person_memberships_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_status: input.status,
          p_search: input.search,
          p_as_of: input.as_of,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read", true) };
        }
        const projected = projectDepartmentPersonMembershipsListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list person memberships returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list person memberships RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async assignPersonMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_assign_person_member_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_person_id: input.person_id,
          p_expected_person_version: input.expected_person_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectDepartmentPersonMemberMutationResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] assign person member returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] assign person member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async endPersonMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_end_person_member_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_membership_id: input.membership_id,
          p_expected_person_version: input.expected_person_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectDepartmentPersonMemberMutationResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] end person member returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] end person member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listDepartmentHeads(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_department_heads_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_include_history: input.include_history,
          p_as_of: input.as_of,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read", true) };
        }
        const projected = projectDepartmentHeadsListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list department heads returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list department heads RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async designateHead(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_designate_head_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_person_id: input.person_id,
          p_expected_department_version: input.expected_department_version,
          p_expected_current_head_assignment_id: input.expected_current_head_assignment_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectDesignateDepartmentHeadResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] designate head returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] designate head RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async endHead(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_end_head_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_department_id: input.department_id,
          p_expected_department_version: input.expected_department_version,
          p_expected_current_head_assignment_id: input.expected_current_head_assignment_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation", true) };
        }
        const projected = projectEndDepartmentHeadResponse(result.data);
        if (!projected) {
          console.error("[departments-admin] end head returned non-canonical projection");
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] end head RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listAccountingMemberships(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_accounting_memberships_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_history: input.include_history,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectAccountingMembershipListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list accounting memberships returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list accounting memberships RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listAccountingCandidates(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_accounting_candidates_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectAccountingCandidateListResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list accounting candidates returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list accounting candidates RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async assignAccountingMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_assign_accounting_member", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.account_ref,
          p_expected_pair_version: input.expected_pair_version,
          p_effective_from: input.effective_from,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation") };
        }
        const projected = projectAccountingMembershipMutationResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] assign accounting member returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] assign accounting member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async endAccountingMember(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_end_accounting_member", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_membership_id: input.membership_id,
          p_expected_pair_version: input.expected_pair_version,
          p_effective_to: input.effective_to,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "mutation") };
        }
        const projected = projectAccountingMembershipMutationResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] end accounting member returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] end accounting member RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },

    async listRecruitmentTeams(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_recruitment_teams_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyDepartmentRpcError(result.error, "read") };
        }
        const projected = projectRecruitmentTeamsResponse(result.data);
        if (!projected) {
          console.error(
            "[departments-admin] list recruitment teams returned non-canonical projection",
          );
          return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[departments-admin] list recruitment teams RPC failed");
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      }
    },
  };
}
