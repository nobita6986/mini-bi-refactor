import "server-only";

import {
  projectAccountAccessDetail,
  projectAccountsSummaryResponse,
  projectRoleMutationResult,
  projectRolesCatalogResponse,
  type AccountAccessDetail,
  type AccountsSummaryListResponse,
  type AccountsSummaryQuery,
  type GlobalRoleCode,
  type RoleAccessErrorCode,
  type RoleMutationResult,
  type RolesCatalogEnvelope,
} from "../auth/role-access-contract.ts";

export type RoleAccessPgError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

export type RoleAccessRpcCaller = (
  fnName: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: RoleAccessPgError | null;
}>;

export type RoleAccessActor = {
  auth_subject: string;
  actor_app_user_id: string;
};

export type ClassifiedRoleAccessSqlError = {
  status: 400 | 403 | 404 | 409 | 503;
  code: RoleAccessErrorCode;
  message: string;
  current_version?: number;
};

export type RoleAccessOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: ClassifiedRoleAccessSqlError };

export type RoleAccessRepository = {
  listRoles(input: RoleAccessActor): Promise<RoleAccessOutcome<RolesCatalogEnvelope>>;
  listAccountsSummary(
    input: RoleAccessActor & AccountsSummaryQuery,
  ): Promise<RoleAccessOutcome<AccountsSummaryListResponse>>;
  getAccountAccess(
    input: RoleAccessActor & { target_app_user_id: string },
  ): Promise<RoleAccessOutcome<AccountAccessDetail>>;
  assignGlobalRole(
    input: RoleAccessActor & {
      target_app_user_id: string;
      role_code: GlobalRoleCode;
      expected_account_version: number;
      reason: string;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<RoleAccessOutcome<RoleMutationResult>>;
  revokeGlobalRole(
    input: RoleAccessActor & {
      target_app_user_id: string;
      assignment_id: string;
      expected_account_version: number;
      reason: string;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<RoleAccessOutcome<RoleMutationResult>>;
};

const CONFLICT_TOKEN_MESSAGES: ReadonlyArray<
  readonly [RoleAccessErrorCode, string]
> = [
  [
    "AUTHZ_CUTOVER_NOT_READY",
    "Hệ thống phân quyền mới chưa hoàn tất cutover (cutover_ready = false).",
  ],
  [
    "AUTHZ_PROTECTED_ASSIGNMENT",
    "Phân công ADMIN được bảo vệ của Owner không thể bị thu hồi (PROTECTED_OWNER_ADMIN).",
  ],
  [
    "VERSION_CONFLICT",
    "Phiên bản tài khoản đã thay đổi; vui lòng tải lại dữ liệu trước khi thao tác.",
  ],
  [
    "IDEMPOTENCY_CONFLICT",
    "Idempotency-Key đã được sử dụng với nội dung thao tác khác.",
  ],
  [
    "ACCOUNT_DISABLED",
    "Không thể gán vai trò mới cho tài khoản đang bị vô hiệu hóa.",
  ],
  [
    "ROLE_ALREADY_ASSIGNED",
    "Tài khoản đã đang giữ vai trò toàn cục này.",
  ],
  [
    "ROLE_ASSIGNMENT_ALREADY_ENDED",
    "Phân công vai trò này đã kết thúc trước đó.",
  ],
  [
    "ACCOUNT_TYPE_ROLE_FORBIDDEN",
    "Loại tài khoản này không được phép nhận vai trò được chọn.",
  ],
];

const UNAVAILABLE_ERROR: ClassifiedRoleAccessSqlError = {
  status: 503,
  code: "AUTHZ_UNAVAILABLE",
  message: "Dịch vụ phân quyền tạm thời không khả dụng.",
};

function createServiceRoleRpc(): RoleAccessRpcCaller {
  const clientPromise = import("../supabase/server.ts").then(
    ({ createServiceSupabaseClient }) => createServiceSupabaseClient(),
  );
  return async (fnName, args) => {
    const client = await clientPromise;
    const { data, error } = await client.rpc(fnName, args);
    return {
      data,
      error: (error ?? null) as RoleAccessPgError | null,
    };
  };
}

function parsePositiveSafeVersion(candidate: unknown): number | undefined {
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 1
    ? candidate
    : undefined;
}

/** Extracts `current_version` from PostgreSQL DETAIL JSON (or safe key/value fallback). */
export function parseCurrentVersionFromPgError(
  error: RoleAccessPgError,
): number | undefined {
  if (typeof error.details === "string") {
    const trimmed = error.details.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const version = parsePositiveSafeVersion(
            (parsed as Record<string, unknown>).current_version,
          );
          if (version !== undefined) {
            return version;
          }
        }
      } catch {
        // Fall through to structured regex extraction below.
      }
    }
    const detailsMatch = trimmed.match(/current_version["']?\s*[:=]\s*(\d+)/i);
    if (detailsMatch) {
      const n = Number(detailsMatch[1]);
      const valid = parsePositiveSafeVersion(n);
      if (valid !== undefined) return valid;
    }
  }

  if (typeof error.message === "string") {
    const msgMatch = error.message.match(/current_version["']?\s*[:=]\s*(\d+)/i);
    if (msgMatch) {
      const n = Number(msgMatch[1]);
      const valid = parsePositiveSafeVersion(n);
      if (valid !== undefined) return valid;
    }
  }

  return undefined;
}

function buildErrorHaystack(error: RoleAccessPgError): string {
  return [error.message, error.details, error.hint]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

function matchConflictToken(
  haystack: string,
  error: RoleAccessPgError,
): ClassifiedRoleAccessSqlError | null {
  for (const [code, message] of CONFLICT_TOKEN_MESSAGES) {
    if (haystack.includes(code)) {
      if (code === "VERSION_CONFLICT") {
        const current_version = parseCurrentVersionFromPgError(error);
        return {
          status: 409,
          code,
          message,
          ...(current_version !== undefined ? { current_version } : {}),
        };
      }
      return { status: 409, code, message };
    }
  }
  return null;
}

/** Deterministically maps PostgreSQL RPC error code/message/details to the HTTP contract. */
export function classifyRoleAccessSqlError(
  error: RoleAccessPgError | null | undefined,
): ClassifiedRoleAccessSqlError {
  if (!error) return UNAVAILABLE_ERROR;

  const pgCode = typeof error.code === "string" ? error.code.trim() : "";
  const haystack = buildErrorHaystack(error);

  if (pgCode === "42501") {
    return {
      status: 403,
      code: "AUTHZ_FORBIDDEN",
      message: "Tài khoản không có quyền quản trị phân quyền (Full Admin).",
    };
  }

  if (pgCode === "P0002") {
    if (haystack.includes("ROLE_ASSIGNMENT_NOT_FOUND")) {
      return {
        status: 404,
        code: "ROLE_ASSIGNMENT_NOT_FOUND",
        message: "Không tìm thấy phân công vai trò trên tài khoản này.",
      };
    }
    return {
      status: 404,
      code: "ACCOUNT_NOT_FOUND",
      message: "Không tìm thấy tài khoản mục tiêu.",
    };
  }

  if (pgCode === "22023") {
    if (haystack.includes("CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE")) {
      return {
        status: 400,
        code: "AUTHZ_VALIDATION_ERROR",
        message: "Vai trò ngữ cảnh không được phép gán trực tiếp ở phạm vi toàn cục.",
      };
    }
    if (haystack.includes("ROLE_CODE_INVALID")) {
      return {
        status: 400,
        code: "AUTHZ_VALIDATION_ERROR",
        message: "Mã vai trò phân quyền không hợp lệ hoặc không tồn tại.",
      };
    }
    if (haystack.includes("REASON_TOO_SHORT") || haystack.includes("AUTHZ_REASON_INVALID")) {
      return {
        status: 400,
        code: "AUTHZ_VALIDATION_ERROR",
        message: "Lý do thay đổi phân quyền phải có từ 3 đến 500 ký tự.",
      };
    }
    return {
      status: 400,
      code: "AUTHZ_VALIDATION_ERROR",
      message: "Tham số phân quyền không hợp lệ.",
    };
  }

  if (pgCode === "PT409" || pgCode === "23505" || pgCode === "23514") {
    const matched = matchConflictToken(haystack, error);
    if (matched) return matched;

    if (pgCode === "23505") {
      const lower = haystack.toLowerCase();
      if (lower.includes("idempotency")) {
        return {
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency-Key đã được sử dụng với nội dung thao tác khác.",
        };
      }
      if (lower.includes("protected")) {
        return {
          status: 409,
          code: "AUTHZ_PROTECTED_ASSIGNMENT",
          message:
            "Phân công ADMIN được bảo vệ của Owner không thể bị thu hồi (PROTECTED_OWNER_ADMIN).",
        };
      }
      if (lower.includes("role_assignment") || lower.includes("uq_authz_active_role")) {
        return {
          status: 409,
          code: "ROLE_ALREADY_ASSIGNED",
          message: "Tài khoản đã đang giữ vai trò toàn cục này.",
        };
      }
    }

    if (pgCode === "23514") {
      return {
        status: 400,
        code: "AUTHZ_VALIDATION_ERROR",
        message: "Ràng buộc dữ liệu phân quyền không hợp lệ.",
      };
    }
  }

  return UNAVAILABLE_ERROR;
}

export function createRoleAccessRepository(
  rpc?: RoleAccessRpcCaller,
): RoleAccessRepository {
  let resolvedRpc = rpc;

  async function invoke<T>(
    fnName: string,
    args: Record<string, unknown>,
    project: (payload: unknown) => T | null,
    label: string,
  ): Promise<RoleAccessOutcome<T>> {
    try {
      resolvedRpc ??= createServiceRoleRpc();
      const { data, error } = await resolvedRpc(fnName, args);
      if (error) {
        return { ok: false, error: classifyRoleAccessSqlError(error) };
      }
      const projected = project(data);
      if (!projected) {
        console.error(`[role-access] ${label} returned non-canonical projection`);
        return { ok: false, error: UNAVAILABLE_ERROR };
      }
      return { ok: true, data: projected };
    } catch {
      console.error(`[role-access] ${label} RPC unavailable`);
      return { ok: false, error: UNAVAILABLE_ERROR };
    }
  }

  return {
    listRoles(input) {
      return invoke(
        "direct_entry_authz_list_roles_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
        },
        projectRolesCatalogResponse,
        "list-roles",
      );
    },

    listAccountsSummary(input) {
      return invoke(
        "direct_entry_authz_list_accounts_summary_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_search: input.search,
          p_enabled: input.enabled,
          p_role_code: input.role_code,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectAccountsSummaryResponse,
        "list-accounts-summary",
      );
    },

    getAccountAccess(input) {
      return invoke(
        "direct_entry_authz_get_account_access_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_target_app_user_id: input.target_app_user_id,
        },
        projectAccountAccessDetail,
        "get-account-access",
      );
    },

    assignGlobalRole(input) {
      return invoke(
        "direct_entry_authz_assign_global_role_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_target_app_user_id: input.target_app_user_id,
          p_role_code: input.role_code,
          p_expected_account_version: input.expected_account_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        projectRoleMutationResult,
        "assign-global-role",
      );
    },

    revokeGlobalRole(input) {
      return invoke(
        "direct_entry_authz_revoke_global_role_admin",
        {
          p_auth_subject: input.auth_subject,
          p_actor_app_user_id: input.actor_app_user_id,
          p_target_app_user_id: input.target_app_user_id,
          p_assignment_id: input.assignment_id,
          p_expected_account_version: input.expected_account_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        projectRoleMutationResult,
        "revoke-global-role",
      );
    },
  };
}
