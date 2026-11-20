import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export const N8N_BOD_READONLY_PRINCIPAL = "n8n_bod_readonly" as const;
export const N8N_BOD_READONLY_SCOPE = "all" as const;

export type N8nBodPrincipalContext = {
  principal: typeof N8N_BOD_READONLY_PRINCIPAL;
  scope: typeof N8N_BOD_READONLY_SCOPE;
};

export type N8nInternalActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type N8nAuthFailureCode =
  | "N8N_INTEGRATION_DISABLED"
  | "N8N_INTEGRATION_NOT_CONFIGURED"
  | "CREDENTIAL_IN_QUERY_FORBIDDEN"
  | "CLIENT_AUTHORITY_HEADER_FORBIDDEN"
  | "UNAUTHORIZED";

export type N8nAuthResult =
  | {
      ok: true;
      principal: N8nBodPrincipalContext;
    }
  | {
      ok: false;
      status: 400 | 401 | 503;
      code: N8nAuthFailureCode;
      message: string;
    };

export type N8nAuthEnvInput = {
  apiEnabled?: string | undefined;
  apiKey?: string | undefined;
  authSubject?: string | undefined;
  appUserId?: string | undefined;
};

const MIN_API_KEY_LENGTH = 32;
const MAX_API_KEY_LENGTH = 512;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORBIDDEN_QUERY_CREDENTIAL_PARAMS = new Set([
  "api_key",
  "apikey",
  "token",
  "access_token",
  "secret",
  "bearer",
  "key",
  "authorization",
]);

const FORBIDDEN_AUTHORITY_HEADERS = [
  "x-actor",
  "x-actor-id",
  "x-app-user-id",
  "x-auth-subject",
  "x-role",
  "x-roles",
  "x-scope",
  "x-scopes",
  "x-team-id",
  "x-capabilities",
] as const;

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const expectedDigest = sha256Digest(expected);
  const providedDigest = sha256Digest(provided);
  return timingSafeEqual(expectedDigest, providedDigest);
}

function isValidConfiguredApiKey(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (
    trimmed.length < MIN_API_KEY_LENGTH ||
    trimmed.length > MAX_API_KEY_LENGTH
  ) {
    return false;
  }
  // Reject whitespace or control characters in machine-to-machine secret.
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return false;
  }
  return true;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match) return null;
  const token = match[1];
  if (
    !token ||
    token.length < 1 ||
    token.length > MAX_API_KEY_LENGTH ||
    /[\s\x00-\x1F\x7F]/.test(token)
  ) {
    return null;
  }
  return token;
}

function readDefaultEnv(): N8nAuthEnvInput {
  return {
    apiEnabled: process.env.N8N_BOD_API_ENABLED,
    apiKey: process.env.N8N_BOD_READONLY_API_KEY,
    authSubject: process.env.N8N_BOD_READONLY_AUTH_SUBJECT,
    appUserId: process.env.N8N_BOD_READONLY_APP_USER_ID,
  };
}

/**
 * Authenticates a machine-to-machine request from n8n and binds it to the
 * fixed principal `n8n_bod_readonly` (`all` scope).
 *
 * Security invariants:
 * - Secret is compared in constant time via SHA-256 digests.
 * - Never accepts credentials in URL query parameters.
 * - Never accepts caller-supplied actor/role/scope/team headers.
 * - Never logs the bearer token.
 */
export function authenticateN8nBodRequest(
  request: Request,
  envInput: N8nAuthEnvInput = readDefaultEnv(),
): N8nAuthResult {
  const enabledRaw = envInput.apiEnabled?.trim().toLowerCase();
  if (enabledRaw === "false" || enabledRaw === "0") {
    return {
      ok: false,
      status: 503,
      code: "N8N_INTEGRATION_DISABLED",
      message: "Tích hợp n8n BoD read-only API hiện đang tắt trên server.",
    };
  }

  if (!isValidConfiguredApiKey(envInput.apiKey)) {
    return {
      ok: false,
      status: 503,
      code: "N8N_INTEGRATION_NOT_CONFIGURED",
      message:
        "Server chưa cấu hình N8N_BOD_READONLY_API_KEY hợp lệ (tối thiểu 32 ký tự ASCII).",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "UNAUTHORIZED",
      message: "URL yêu cầu không hợp lệ.",
    };
  }

  for (const key of parsedUrl.searchParams.keys()) {
    const normalizedKey = key.trim().toLowerCase();
    if (FORBIDDEN_QUERY_CREDENTIAL_PARAMS.has(normalizedKey)) {
      return {
        ok: false,
        status: 400,
        code: "CREDENTIAL_IN_QUERY_FORBIDDEN",
        message:
          "Không được truyền credential hoặc token qua URL query string; chỉ dùng header Authorization: Bearer.",
      };
    }
  }

  for (const headerName of FORBIDDEN_AUTHORITY_HEADERS) {
    if (request.headers.has(headerName)) {
      return {
        ok: false,
        status: 400,
        code: "CLIENT_AUTHORITY_HEADER_FORBIDDEN",
        message: `Không được gửi header tự khai quyền hoặc danh tính (${headerName}); principal cố định là n8n_bod_readonly.`,
      };
    }
  }

  const providedToken = extractBearerToken(
    request.headers.get("authorization"),
  );
  if (
    !providedToken ||
    !constantTimeTokenMatch(envInput.apiKey.trim(), providedToken)
  ) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      message: "Bearer credential không hợp lệ hoặc bị thiếu.",
    };
  }

  return {
    ok: true,
    principal: {
      principal: N8N_BOD_READONLY_PRINCIPAL,
      scope: N8N_BOD_READONLY_SCOPE,
    },
  };
}

type ActorContextResolutionPayload = {
  auth_subject?: unknown;
  app_user_id?: unknown;
  enabled?: unknown;
  capabilities?: unknown;
  all_scope_grants?: unknown;
  effective_grants?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const N8N_ALL_REPORTING_CAPABILITIES = new Set([
  "entry_admin",
  "report_analytics_view",
]);

function hasVerifiedPairedAllReportingGrant(effectiveGrants: unknown): boolean {
  if (!Array.isArray(effectiveGrants)) return false;
  return effectiveGrants.some((grant) => {
    if (!isRecord(grant)) return false;
    return (
      typeof grant.capability === "string" &&
      N8N_ALL_REPORTING_CAPABILITIES.has(grant.capability) &&
      grant.scope_kind === "ALL" &&
      (grant.scope_id === null || grant.scope_id === undefined)
    );
  });
}

function extractPairedAllCapabilities(effectiveGrants: unknown): readonly string[] {
  if (!Array.isArray(effectiveGrants)) return [];
  const capabilities = new Set<string>();
  for (const grant of effectiveGrants) {
    if (!isRecord(grant)) continue;
    if (
      typeof grant.capability === "string" &&
      grant.capability.length > 0 &&
      grant.scope_kind === "ALL" &&
      (grant.scope_id === null || grant.scope_id === undefined)
    ) {
      capabilities.add(grant.capability);
    }
  }
  return [...capabilities].sort();
}

function isVerifiedAllScopeActor(
  payload: ActorContextResolutionPayload,
  expectedAuthSubject: string,
  expectedAppUserId?: string,
): payload is {
  auth_subject: string;
  app_user_id: string;
  enabled: true;
  capabilities?: unknown;
  all_scope_grants?: unknown;
  effective_grants: unknown[];
} {
  if (payload.enabled !== true) return false;
  if (
    typeof payload.auth_subject !== "string" ||
    !UUID_REGEX.test(payload.auth_subject) ||
    payload.auth_subject.toLowerCase() !== expectedAuthSubject.toLowerCase()
  ) {
    return false;
  }
  if (
    typeof payload.app_user_id !== "string" ||
    !UUID_REGEX.test(payload.app_user_id)
  ) {
    return false;
  }
  if (
    expectedAppUserId &&
    payload.app_user_id.toLowerCase() !== expectedAppUserId.toLowerCase()
  ) {
    return false;
  }
  if (!hasVerifiedPairedAllReportingGrant(payload.effective_grants)) {
    return false;
  }
  return true;
}

export function clearN8nServiceActorCache(): void {
  // No-op: service actor authority is verified on every request without caching.
}

export type N8nActorResolverDependencies = {
  env?: N8nAuthEnvInput;
  resolveActorContextRpc?: (authSubject: string) => Promise<{
    data: unknown;
    error: unknown;
  }>;
  nowMs?: () => number;
};

/**
 * Resolves and verifies the explicit internal `(auth_subject, app_user_id)`
 * service actor used on the server to invoke `service_role` read RPCs on
 * behalf of the fixed principal `n8n_bod_readonly`.
 *
 * Security invariants:
 * 1. Requires explicit `N8N_BOD_READONLY_AUTH_SUBJECT` UUID configuration (no
 *    account-scanning auto-discovery).
 * 2. Optional `N8N_BOD_READONLY_APP_USER_ID` must be a valid UUID and match the
 *    DB-resolved `app_user_id` if provided.
 * 3. Always verifies on every request via `direct_entry_resolve_actor_context`
 *    (no TTL cache) that the actor is enabled and holds paired `ALL` scope
 *    (`entry_admin` or `report_analytics_view` with `scope_kind = 'ALL'` in
 *    `effective_grants`, including SQL `LEGACY_BRIDGE` entries pre-cutover)
 *    before allowing any query execution.
 */
export async function resolveN8nBodServiceActor(
  deps: N8nActorResolverDependencies = {},
): Promise<
  | { ok: true; actor: N8nInternalActorRef; capabilities: readonly string[] }
  | { ok: false; code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE"; message: string }
> {
  const env = deps.env ?? readDefaultEnv();

  const explicitAuthSubject = env.authSubject?.trim();
  const explicitAppUserId = env.appUserId?.trim();

  if (!explicitAuthSubject || !UUID_REGEX.test(explicitAuthSubject)) {
    return {
      ok: false,
      code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE",
      message:
        "Server chưa cấu hình tường minh N8N_BOD_READONLY_AUTH_SUBJECT (UUID hợp lệ) cho principal n8n_bod_readonly.",
    };
  }

  if (explicitAppUserId && !UUID_REGEX.test(explicitAppUserId)) {
    return {
      ok: false,
      code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE",
      message:
        "Cấu hình N8N_BOD_READONLY_APP_USER_ID không phải UUID hợp lệ.",
    };
  }

  const callActorContextRpc =
    deps.resolveActorContextRpc ??
    (async (authSubject: string) => {
      const { createServiceSupabaseClient } = await import(
        "../../supabase/server.ts"
      );
      const client = createServiceSupabaseClient();
      const { data, error } = await client.rpc(
        "direct_entry_resolve_actor_context",
        { p_auth_subject: authSubject },
      );
      return { data, error };
    });

  try {
    const { data, error } = await callActorContextRpc(explicitAuthSubject);
    if (
      !error &&
      isRecord(data) &&
      isVerifiedAllScopeActor(data, explicitAuthSubject, explicitAppUserId)
    ) {
      const actor: N8nInternalActorRef = {
        auth_subject: data.auth_subject,
        app_user_id: data.app_user_id,
      };
      const capabilities: readonly string[] = extractPairedAllCapabilities(
        data.effective_grants,
      );
      return { ok: true, actor, capabilities };
    }
  } catch {
    // Fall through to fail-closed error below.
  }

  return {
    ok: false,
    code: "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE",
    message:
      "Không thể xác thực tài khoản đại diện N8N_BOD_READONLY_AUTH_SUBJECT đang hoạt động và có quyền đọc toàn miền (all scope).",
  };
}
