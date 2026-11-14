import "server-only";

import {
  ORGANIZATION_ERROR_CODES,
  projectGetPersonResponse,
  projectLinkAccountPersonResponse,
  projectListPersonsResponse,
  projectMutatePersonResponse,
  projectSetAccountTypeResponse,
  projectTransferPersonDepartmentResponse,
  projectUnlinkAccountPersonResponse,
  type AccountType,
  type GetPersonRpcProjection,
  type LinkAccountPersonRpcProjection,
  type ListPersonsRpcProjection,
  type MutatePersonRpcProjection,
  type OrganizationErrorCode,
  type PersonFilterStatus,
  type PersonLinkState,
  type PersonStatus,
  type SetAccountTypeRpcProjection,
  type TransferPersonDepartmentRpcProjection,
  type UnlinkAccountPersonRpcProjection,
} from "./person-contract.ts";

export type OrganizationRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type OrganizationActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type ListPersonsInput = OrganizationActorRef & {
  search: string | null;
  status: PersonFilterStatus;
  department_id: string | null;
  link_state: PersonLinkState;
  as_of: string | null;
  page: number;
  page_size: number;
};

export type GetPersonInput = OrganizationActorRef & {
  person_id: string;
  as_of: string | null;
};

export type CreatePersonInput = OrganizationActorRef & {
  employee_code: string;
  full_name: string;
  joined_on: string | null;
  initial_department_id: string | null;
  account_ref: string | null;
  expected_account_version: number | null;
  recruiter_id: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UpdatePersonInput = OrganizationActorRef & {
  person_id: string;
  expected_person_version: number;
  employee_code: string;
  full_name: string;
  joined_on: string | null;
  status: PersonStatus;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type TransferPersonDepartmentInput = OrganizationActorRef & {
  person_id: string;
  target_department_id: string;
  expected_person_version: number;
  expected_current_membership_id: string;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type SetAccountTypeInput = OrganizationActorRef & {
  account_ref: string;
  account_type: AccountType;
  expected_account_version: number;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type LinkAccountPersonInput = OrganizationActorRef & {
  account_ref: string;
  person_id: string;
  expected_account_version: number;
  expected_person_version: number;
  confirmed_recruiter_id: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UnlinkAccountPersonInput = OrganizationActorRef & {
  account_ref: string;
  expected_account_version: number;
  expected_person_version: number;
  expected_link_id: string;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type OrgRepoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: OrganizationErrorCode };

export type OrganizationRepository = {
  listPersons(input: ListPersonsInput): Promise<OrgRepoResult<ListPersonsRpcProjection>>;
  getPerson(input: GetPersonInput): Promise<OrgRepoResult<GetPersonRpcProjection>>;
  createPerson(input: CreatePersonInput): Promise<OrgRepoResult<MutatePersonRpcProjection>>;
  updatePerson(input: UpdatePersonInput): Promise<OrgRepoResult<MutatePersonRpcProjection>>;
  transferPersonDepartment(
    input: TransferPersonDepartmentInput,
  ): Promise<OrgRepoResult<TransferPersonDepartmentRpcProjection>>;
  setAccountType(input: SetAccountTypeInput): Promise<OrgRepoResult<SetAccountTypeRpcProjection>>;
  linkAccountPerson(
    input: LinkAccountPersonInput,
  ): Promise<OrgRepoResult<LinkAccountPersonRpcProjection>>;
  unlinkAccountPerson(
    input: UnlinkAccountPersonInput,
  ): Promise<OrgRepoResult<UnlinkAccountPersonRpcProjection>>;
};

const KNOWN_ORGANIZATION_RPC_TOKENS: ReadonlyMap<string, OrganizationErrorCode> = new Map([
  ...ORGANIZATION_ERROR_CODES.map((code) => [code, code] as const),
  ["DEPARTMENT_ACCESS_DENIED", "FORBIDDEN"],
  ["DEPARTMENT_MEMBERSHIP_NOT_FOUND", "NOT_FOUND"],
  ["DEPARTMENT_QUERY_INVALID", "ORG_VALIDATION_ERROR"],
]);

function serviceRoleRpc(): OrganizationRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyOrganizationRpcError(error: {
  code?: string;
  message?: string;
}): OrganizationErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_ORGANIZATION_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_ORGANIZATION_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }

  if (error.code === "42501") {
    return "FORBIDDEN";
  }
  if (error.code === "P0002") {
    return "NOT_FOUND";
  }
  if (error.code === "PT409" || error.code === "40001") {
    return "ORG_CONFLICT";
  }
  if (error.code === "23505") {
    return "DUPLICATE_CODE";
  }
  if (error.code === "22023" || error.code === "23514") {
    return "ORG_VALIDATION_ERROR";
  }

  return "ORG_UNAVAILABLE";
}

export function createServiceOrganizationRepository(
  rpc?: OrganizationRpcCaller,
): OrganizationRepository {
  let resolvedRpc = rpc;

  return {
    async listPersons(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_list_persons_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_status: input.status,
          p_department_id: input.department_id,
          p_link_state: input.link_state,
          p_as_of: input.as_of,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectListPersonsResponse(result.data);
        if (!projected) {
          console.error("[organization-admin] list persons returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] list persons RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async getPerson(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_get_person_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_person_id: input.person_id,
          p_as_of: input.as_of,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectGetPersonResponse(result.data);
        if (!projected) {
          console.error("[organization-admin] get person returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] get person RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async createPerson(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_create_person_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_employee_code: input.employee_code,
          p_full_name: input.full_name,
          p_joined_on: input.joined_on,
          p_initial_department_id: input.initial_department_id,
          p_account_ref: input.account_ref,
          p_expected_account_version: input.expected_account_version,
          p_recruiter_id: input.recruiter_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectMutatePersonResponse(result.data);
        if (!projected) {
          console.error("[organization-admin] create person returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] create person RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async updatePerson(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_update_person_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_person_id: input.person_id,
          p_expected_person_version: input.expected_person_version,
          p_employee_code: input.employee_code,
          p_full_name: input.full_name,
          p_joined_on: input.joined_on,
          p_status: input.status,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectMutatePersonResponse(result.data);
        if (!projected) {
          console.error("[organization-admin] update person returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] update person RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async transferPersonDepartment(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_transfer_person_member_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_person_id: input.person_id,
          p_target_department_id: input.target_department_id,
          p_expected_person_version: input.expected_person_version,
          p_expected_current_membership_id: input.expected_current_membership_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectTransferPersonDepartmentResponse(result.data);
        if (!projected) {
          console.error(
            "[organization-admin] transfer person department returned non-canonical projection",
          );
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] transfer person department RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async setAccountType(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_set_account_type_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.account_ref,
          p_account_type: input.account_type,
          p_expected_account_version: input.expected_account_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectSetAccountTypeResponse(result.data);
        if (!projected) {
          console.error("[organization-admin] set account type returned non-canonical projection");
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] set account type RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async linkAccountPerson(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_link_account_person_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.account_ref,
          p_person_id: input.person_id,
          p_expected_account_version: input.expected_account_version,
          p_expected_person_version: input.expected_person_version,
          p_confirmed_recruiter_id: input.confirmed_recruiter_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectLinkAccountPersonResponse(result.data);
        if (!projected) {
          console.error(
            "[organization-admin] link account person returned non-canonical projection",
          );
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] link account person RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },

    async unlinkAccountPerson(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("org_department_unlink_account_person_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.account_ref,
          p_expected_account_version: input.expected_account_version,
          p_expected_person_version: input.expected_person_version,
          p_expected_link_id: input.expected_link_id,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });
        if (result.error) {
          return { ok: false, code: classifyOrganizationRpcError(result.error) };
        }
        const projected = projectUnlinkAccountPersonResponse(result.data);
        if (!projected) {
          console.error(
            "[organization-admin] unlink account person returned non-canonical projection",
          );
          return { ok: false, code: "ORG_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[organization-admin] unlink account person RPC failed");
        return { ok: false, code: "ORG_UNAVAILABLE" };
      }
    },
  };
}
