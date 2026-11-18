import "server-only";

import { createHash } from "node:crypto";

import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { hasPairedCapability } from "../auth/direct-entry-v2.ts";
import {
  RoleAccessValidationError,
  parseAccountRefParam,
  parseAccountsSummaryQuery,
  parseAssignGlobalRoleBody,
  parseAssignmentIdParam,
  parseEmptyRoleAccessQuery,
  parseRevokeGlobalRoleBody,
  type RoleAccessErrorCode,
} from "../auth/role-access-contract.ts";
import { isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import type {
  ClassifiedRoleAccessSqlError,
  RoleAccessRepository,
} from "./role-access-repository.ts";

export const MAX_JSON_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-actor-app-user-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type RoleAccessApiEnv = {
  AUTHZ_ROLE_MUTATIONS_ENABLED?: string | undefined;
  DIRECT_ENTRY_API_ENABLED?: string | undefined;
  [key: string]: string | undefined;
};

export type RoleAccessApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: RoleAccessRepository;
  env?: RoleAccessApiEnv | (() => RoleAccessApiEnv);
};

export type AccountRefInput =
  | string
  | { accountRef: string }
  | { params: Promise<{ accountRef: string }> | { accountRef: string } };

export type AssignmentRouteInput =
  | { accountRef: string; assignmentId: string }
  | {
      params:
        | Promise<{ accountRef: string; assignmentId: string }>
        | { accountRef: string; assignmentId: string };
    };

export type RoleAccessApiHandlers = {
  listRoles(request: Request): Promise<Response>;
  listAccountsSummary(request: Request): Promise<Response>;
  getAccountAccess(request: Request, target: AccountRefInput): Promise<Response>;
  assignGlobalRole(request: Request, target: AccountRefInput): Promise<Response>;
  revokeGlobalRole(
    request: Request,
    target: AssignmentRouteInput | string,
    assignmentIdOpt?: string,
  ): Promise<Response>;
};

type TrustedFullAdminActor = {
  auth_subject: string;
  actor_app_user_id: string;
};

export function roleAccessErrorJson(
  status: number,
  code: RoleAccessErrorCode,
  message: string,
  extra?: { current_version?: number },
): Response {
  return noStoreJson(
    {
      ok: false,
      error: {
        code,
        message,
        ...(extra?.current_version !== undefined
          ? { current_version: extra.current_version }
          : {}),
      },
    },
    status,
  );
}

export function roleAccessNotFoundResponse(): Response {
  return roleAccessErrorJson(
    404,
    "NOT_FOUND",
    "Endpoint phân quyền vai trò chưa được kích hoạt.",
  );
}

function fromValidationError(err: RoleAccessValidationError): Response {
  return roleAccessErrorJson(err.status, err.code, err.message);
}

function fromRepositoryError(err: ClassifiedRoleAccessSqlError): Response {
  return roleAccessErrorJson(
    err.status,
    err.code,
    err.message,
    err.current_version !== undefined ? { current_version: err.current_version } : undefined,
  );
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

function hasPairedFullAdminAuthority(
  actor: Extract<DirectEntrySessionResult["actor"], { ok: true }>["actor"],
): boolean {
  return (
    hasPairedCapability(actor, "entry_admin", { kind: "all" }) &&
    hasPairedCapability(actor, "recruiter_master_manage", { kind: "all" }) &&
    hasPairedCapability(actor, "team_master_manage", { kind: "all" })
  );
}

async function resolveVerifiedFullAdminActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<{ ok: true; actor: TrustedFullAdminActor } | { ok: false; response: Response }> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[role-access] session resolution unavailable");
    return {
      ok: false,
      response: roleAccessErrorJson(
        503,
        "AUTHZ_UNAVAILABLE",
        "Không thể xác thực phiên làm việc lúc này.",
      ),
    };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? roleAccessErrorJson(401, "UNAUTHENTICATED", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.")
          : roleAccessErrorJson(403, "ACTOR_NOT_AVAILABLE", "Tài khoản phiên làm việc không khả dụng."),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return {
      ok: false,
      response: roleAccessErrorJson(
        403,
        "ACTOR_NOT_AVAILABLE",
        "Tài khoản phiên làm việc đã bị khóa hoặc thiếu định danh hợp lệ.",
      ),
    };
  }

  // Enforced paired capability-scope check (no fallback to legacy capabilities/scopes arrays).
  if (!hasPairedFullAdminAuthority(actor)) {
    return {
      ok: false,
      response: roleAccessErrorJson(
        403,
        "AUTHZ_FORBIDDEN",
        "Chỉ Full Admin (ADMIN) mới có quyền truy cập quản trị phân quyền.",
      ),
    };
  }

  return {
    ok: true,
    actor: {
      auth_subject: actor.auth_subject.toLowerCase(),
      actor_app_user_id: actor.app_user_id.toLowerCase(),
    },
  };
}

function parseRequestUrl(request: Request): URL | Response {
  try {
    return new URL(request.url);
  } catch {
    return roleAccessErrorJson(400, "AUTHZ_VALIDATION_ERROR", "URL request không hợp lệ.");
  }
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number = MAX_JSON_BYTES,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, kind: "invalid" };
  }
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeRoleMutationRequestHash(
  payload:
    | {
        op: "AUTHZ_GLOBAL_ROLE_ASSIGNED";
        actor_app_user_id: string;
        target_app_user_id: string;
        role_code: string;
        expected_account_version: number;
        reason: string;
      }
    | {
        op: "AUTHZ_GLOBAL_ROLE_REVOKED";
        actor_app_user_id: string;
        target_app_user_id: string;
        assignment_id: string;
        expected_account_version: number;
        reason: string;
      },
): string {
  const canonicalPayload = canonicalizeJsonValue({
    v: 1,
    ...payload,
    actor_app_user_id: payload.actor_app_user_id.toLowerCase(),
    target_app_user_id: payload.target_app_user_id.toLowerCase(),
    ...("assignment_id" in payload
      ? { assignment_id: payload.assignment_id.toLowerCase() }
      : {}),
  });
  return createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
}

async function resolveAccountRefInput(target: AccountRefInput): Promise<unknown> {
  if (typeof target === "string") return target;
  if ("accountRef" in target) return target.accountRef;
  const resolved = await target.params;
  return resolved.accountRef;
}

async function resolveAssignmentRouteInput(
  target: AssignmentRouteInput | string,
  assignmentIdOpt?: string,
): Promise<{ accountRef: unknown; assignmentId: unknown }> {
  if (typeof target === "string") {
    return { accountRef: target, assignmentId: assignmentIdOpt };
  }
  if ("params" in target) {
    const resolved = await target.params;
    return { accountRef: resolved.accountRef, assignmentId: resolved.assignmentId };
  }
  return { accountRef: target.accountRef, assignmentId: target.assignmentId };
}

function readEnvSnapshot(
  envOption: RoleAccessApiDependencies["env"],
): RoleAccessApiEnv {
  if (typeof envOption === "function") return envOption();
  if (envOption !== undefined) return envOption;
  return process.env;
}

function checkSameOriginMutation(request: Request): Response | null {
  const originResult = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!originResult.ok) {
    return roleAccessErrorJson(
      403,
      "CSRF_REJECTED",
      "Yêu cầu thay đổi quyền không đáp ứng kiểm tra same-origin CSRF.",
    );
  }
  return null;
}

export function createRoleAccessApiHandlers(
  dependencies: RoleAccessApiDependencies,
): RoleAccessApiHandlers {
  async function prepareGet(
    request: Request,
  ): Promise<
    | { ok: true; actor: TrustedFullAdminActor; url: URL }
    | { ok: false; response: Response }
  > {
    if (hasDisallowedAuthorityHeaders(request)) {
      return {
        ok: false,
        response: roleAccessErrorJson(
          400,
          "AUTHORITY_FIELD_FORBIDDEN",
          "Header thẩm quyền từ client bị từ chối.",
        ),
      };
    }

    const urlOrResponse = parseRequestUrl(request);
    if (urlOrResponse instanceof Response) {
      return { ok: false, response: urlOrResponse };
    }

    const actorResult = await resolveVerifiedFullAdminActor(
      dependencies.resolveSession,
    );
    if (!actorResult.ok) {
      return { ok: false, response: actorResult.response };
    }

    return { ok: true, actor: actorResult.actor, url: urlOrResponse };
  }

  async function prepareMutation(
    request: Request,
  ): Promise<
    | { ok: true; actor: TrustedFullAdminActor; url: URL; body: unknown }
    | { ok: false; response: Response }
  > {
    // Env gate MUST execute first on mutating endpoints before CSRF/auth/body reads.
    const env = readEnvSnapshot(dependencies.env);
    if (env.AUTHZ_ROLE_MUTATIONS_ENABLED !== "true") {
      return { ok: false, response: roleAccessNotFoundResponse() };
    }

    const csrfFailure = checkSameOriginMutation(request);
    if (csrfFailure) {
      return { ok: false, response: csrfFailure };
    }

    if (hasDisallowedAuthorityHeaders(request)) {
      return {
        ok: false,
        response: roleAccessErrorJson(
          400,
          "AUTHORITY_FIELD_FORBIDDEN",
          "Header thẩm quyền từ client bị từ chối.",
        ),
      };
    }

    const actorResult = await resolveVerifiedFullAdminActor(
      dependencies.resolveSession,
    );
    if (!actorResult.ok) {
      return { ok: false, response: actorResult.response };
    }

    const urlOrResponse = parseRequestUrl(request);
    if (urlOrResponse instanceof Response) {
      return { ok: false, response: urlOrResponse };
    }

    try {
      parseEmptyRoleAccessQuery(urlOrResponse.searchParams);
    } catch (error) {
      if (error instanceof RoleAccessValidationError) {
        return { ok: false, response: fromValidationError(error) };
      }
      throw error;
    }

    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return {
        ok: false,
        response: roleAccessErrorJson(
          400,
          "AUTHZ_VALIDATION_ERROR",
          "Content-Type phải là application/json.",
        ),
      };
    }

    const bodyResult = await readBoundedJsonBody(request, MAX_JSON_BYTES);
    if (!bodyResult.ok) {
      if (bodyResult.kind === "too-large") {
        return {
          ok: false,
          response: roleAccessErrorJson(
            413,
            "PAYLOAD_TOO_LARGE",
            `Kích thước payload vượt quá giới hạn ${MAX_JSON_BYTES} bytes.`,
          ),
        };
      }
      return {
        ok: false,
        response: roleAccessErrorJson(
          400,
          "AUTHZ_VALIDATION_ERROR",
          "Payload JSON không hợp lệ hoặc bị rỗng.",
        ),
      };
    }

    return {
      ok: true,
      actor: actorResult.actor,
      url: urlOrResponse,
      body: bodyResult.value,
    };
  }

  return {
    async listRoles(request) {
      const prep = await prepareGet(request);
      if (!prep.ok) return prep.response;

      try {
        parseEmptyRoleAccessQuery(prep.url.searchParams);
      } catch (error) {
        if (error instanceof RoleAccessValidationError) {
          return fromValidationError(error);
        }
        return roleAccessErrorJson(503, "AUTHZ_UNAVAILABLE", "Không thể xử lý yêu cầu.");
      }

      const result = await dependencies.repository.listRoles(prep.actor);
      if (!result.ok) return fromRepositoryError(result.error);

      return noStoreJson(
        {
          ok: true,
          as_of: result.data.as_of,
          roles: result.data.roles,
        },
        200,
      );
    },

    async listAccountsSummary(request) {
      const prep = await prepareGet(request);
      if (!prep.ok) return prep.response;

      let query;
      try {
        query = parseAccountsSummaryQuery(prep.url.searchParams);
      } catch (error) {
        if (error instanceof RoleAccessValidationError) {
          return fromValidationError(error);
        }
        return roleAccessErrorJson(503, "AUTHZ_UNAVAILABLE", "Không thể xử lý yêu cầu.");
      }

      const result = await dependencies.repository.listAccountsSummary({
        ...prep.actor,
        ...query,
      });
      if (!result.ok) return fromRepositoryError(result.error);

      return noStoreJson(
        {
          ok: true,
          list: result.data,
        },
        200,
      );
    },

    async getAccountAccess(request, target) {
      const prep = await prepareGet(request);
      if (!prep.ok) return prep.response;

      let targetAccountRef: string;
      try {
        parseEmptyRoleAccessQuery(prep.url.searchParams);
        targetAccountRef = parseAccountRefParam(await resolveAccountRefInput(target));
      } catch (error) {
        if (error instanceof RoleAccessValidationError) {
          return fromValidationError(error);
        }
        return roleAccessErrorJson(503, "AUTHZ_UNAVAILABLE", "Không thể xử lý yêu cầu.");
      }

      const result = await dependencies.repository.getAccountAccess({
        ...prep.actor,
        target_app_user_id: targetAccountRef,
      });
      if (!result.ok) return fromRepositoryError(result.error);

      return noStoreJson(
        {
          ok: true,
          ...result.data,
        },
        200,
      );
    },

    async assignGlobalRole(request, target) {
      const prep = await prepareMutation(request);
      if (!prep.ok) return prep.response;

      let targetAccountRef: string;
      let parsedBody;
      try {
        targetAccountRef = parseAccountRefParam(await resolveAccountRefInput(target));
        parsedBody = parseAssignGlobalRoleBody(
          prep.body,
          request.headers.get("idempotency-key"),
        );
      } catch (error) {
        if (error instanceof RoleAccessValidationError) {
          return fromValidationError(error);
        }
        return roleAccessErrorJson(503, "AUTHZ_UNAVAILABLE", "Không thể xử lý yêu cầu.");
      }

      const request_hash = computeRoleMutationRequestHash({
        op: "AUTHZ_GLOBAL_ROLE_ASSIGNED",
        actor_app_user_id: prep.actor.actor_app_user_id,
        target_app_user_id: targetAccountRef,
        role_code: parsedBody.role_code,
        expected_account_version: parsedBody.expected_version,
        reason: parsedBody.reason,
      });

      const result = await dependencies.repository.assignGlobalRole({
        ...prep.actor,
        target_app_user_id: targetAccountRef,
        role_code: parsedBody.role_code,
        expected_account_version: parsedBody.expected_version,
        reason: parsedBody.reason,
        idempotency_key: parsedBody.idempotency_key,
        request_hash,
      });
      if (!result.ok) return fromRepositoryError(result.error);

      return noStoreJson(
        {
          ok: true,
          replayed: result.data.replayed,
          account_ref: result.data.account_ref,
          account_version: result.data.account_version,
          assignment: result.data.assignment,
        },
        result.data.replayed ? 200 : 201,
      );
    },

    async revokeGlobalRole(request, target, assignmentIdOpt) {
      const prep = await prepareMutation(request);
      if (!prep.ok) return prep.response;

      let targetAccountRef: string;
      let assignmentId: string;
      let parsedBody;
      try {
        const rawParams = await resolveAssignmentRouteInput(target, assignmentIdOpt);
        targetAccountRef = parseAccountRefParam(rawParams.accountRef);
        assignmentId = parseAssignmentIdParam(rawParams.assignmentId);
        parsedBody = parseRevokeGlobalRoleBody(
          prep.body,
          request.headers.get("idempotency-key"),
        );
      } catch (error) {
        if (error instanceof RoleAccessValidationError) {
          return fromValidationError(error);
        }
        return roleAccessErrorJson(503, "AUTHZ_UNAVAILABLE", "Không thể xử lý yêu cầu.");
      }

      const request_hash = computeRoleMutationRequestHash({
        op: "AUTHZ_GLOBAL_ROLE_REVOKED",
        actor_app_user_id: prep.actor.actor_app_user_id,
        target_app_user_id: targetAccountRef,
        assignment_id: assignmentId,
        expected_account_version: parsedBody.expected_version,
        reason: parsedBody.reason,
      });

      const result = await dependencies.repository.revokeGlobalRole({
        ...prep.actor,
        target_app_user_id: targetAccountRef,
        assignment_id: assignmentId,
        expected_account_version: parsedBody.expected_version,
        reason: parsedBody.reason,
        idempotency_key: parsedBody.idempotency_key,
        request_hash,
      });
      if (!result.ok) return fromRepositoryError(result.error);

      return noStoreJson(
        {
          ok: true,
          replayed: result.data.replayed,
          account_ref: result.data.account_ref,
          account_version: result.data.account_version,
          assignment: result.data.assignment,
        },
        200,
      );
    },
  };
}
