import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import type {
  WorkReportDelegatableCapability,
  WorkReportDelegationRepository,
  WorkReportDelegationRpcOutcome,
} from "./delegation-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_CREATE_KEYS = new Set([
  "capability",
  "delegate_app_user_id",
  "template_id",
  "scope_kind",
  "scope_id",
  "scope_team_id",
  "effective_from",
  "effective_to",
  "idempotency_key",
]);
const ALLOWED_REVOKE_KEYS = new Set(["expected_version", "idempotency_key"]);

export type DelegationApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkReportDelegationRepository;
};

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function trustedActor(
  deps: DelegationApiDependencies,
): Promise<WorkReportActorRef | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      const unauthenticated = session.actor.reason === "UNAUTHENTICATED";
      return fail(
        unauthenticated ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
        unauthenticated ? 401 : 403,
      );
    }
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    console.error("[work-reports] delegation session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mapErrorOutcome(
  result: Exclude<WorkReportDelegationRpcOutcome<unknown>, { ok: true }>,
): Response {
  const mapping = {
    "actor-denied": ["ACTOR_NOT_AVAILABLE", 403],
    "scope-denied": ["WORK_REPORT_SCOPE_DENIED", 403],
    denied: ["WORK_REPORT_ACCESS_DENIED", 403],
    invalid: ["WORK_REPORT_DELEGATION_INVALID", 400],
    "not-found": ["WORK_REPORT_NOT_FOUND", 404],
    conflict: ["WORK_REPORT_VERSION_CONFLICT", 409],
    unavailable: ["WORK_REPORT_UNAVAILABLE", 503],
  } as const;
  const [code, status] = mapping[result.kind];
  return fail(code, status);
}

function hasClientSuppliedDelegationWindow(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim().length === 0) return false;
  return true;
}

export async function listWorkReportDelegations(
  request: Request,
  enabled: string | undefined,
  deps: DelegationApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const { searchParams } = new URL(request.url);
  if ([...searchParams.keys()].length > 0) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.list(actor);
    if (!result.ok) return mapErrorOutcome(result);
    return respond({ ok: true, data: result.data, ...result.data }, 200);
  } catch {
    console.error("[work-reports] delegations list unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function createWorkReportDelegation(
  request: Request,
  enabled: string | undefined,
  deps: DelegationApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const csrf = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!csrf.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (!isRecord(body)) return fail("BODY_INVALID", 400);

  // Strip only the target delegation fields `capability` and `scope_kind` before running
  // the generic client authority guard so any caller-supplied actor/role/scopes are still rejected.
  const sanitizedForGuard: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "capability" && key !== "scope_kind") {
      sanitizedForGuard[key] = value;
    }
  }
  try {
    if (!validateClientBusinessPayload(sanitizedForGuard).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_CREATE_KEYS.has(key)) {
      return fail("WORK_REPORT_DELEGATION_INVALID", 400);
    }
  }

  const capability = body.capability;
  if (capability !== "report_assign" && capability !== "report_review") {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  const delegateAppUserId = body.delegate_app_user_id;
  const templateId = body.template_id;
  if (
    typeof delegateAppUserId !== "string" ||
    !UUID.test(delegateAppUserId) ||
    typeof templateId !== "string" ||
    !UUID.test(templateId)
  ) {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  const scopeKind = body.scope_kind;
  if (scopeKind !== "all" && scopeKind !== "team") {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  const rawScopeTeam = body.scope_team_id !== undefined ? body.scope_team_id : body.scope_id;
  let scopeTeamId: string | null = null;
  if (scopeKind === "all") {
    if (
      rawScopeTeam !== undefined &&
      rawScopeTeam !== null &&
      rawScopeTeam !== "" &&
      rawScopeTeam !== "all"
    ) {
      return fail("WORK_REPORT_DELEGATION_INVALID", 400);
    }
    scopeTeamId = null;
  } else {
    if (typeof rawScopeTeam !== "string" || !UUID.test(rawScopeTeam)) {
      return fail("WORK_REPORT_DELEGATION_INVALID", 400);
    }
    scopeTeamId = rawScopeTeam;
  }

  if (
    hasClientSuppliedDelegationWindow(body.effective_from) ||
    hasClientSuppliedDelegationWindow(body.effective_to)
  ) {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  const idempotencyKey = body.idempotency_key;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 1 ||
    idempotencyKey.length > 128
  ) {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== idempotencyKey) {
    return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.create({
      ...actor,
      capability: capability as WorkReportDelegatableCapability,
      delegate_app_user_id: delegateAppUserId,
      template_id: templateId,
      scope_kind: scopeKind,
      scope_team_id: scopeTeamId,
      effective_from: null,
      effective_to: null,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) return mapErrorOutcome(result);
    return respond({ ok: true, data: result.data, ...result.data }, 200);
  } catch {
    console.error("[work-reports] delegation create unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function revokeWorkReportDelegation(
  request: Request,
  delegationId: string,
  enabled: string | undefined,
  deps: DelegationApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const csrf = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!csrf.ok) return fail("CSRF_REJECTED", 403);
  if (!UUID.test(delegationId)) return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (!isRecord(body)) return fail("BODY_INVALID", 400);
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_REVOKE_KEYS.has(key)) {
      return fail("WORK_REPORT_DELEGATION_INVALID", 400);
    }
  }

  const expectedVersion = body.expected_version;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }

  const idempotencyKey = body.idempotency_key;
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 1 ||
    idempotencyKey.length > 128
  ) {
    return fail("WORK_REPORT_DELEGATION_INVALID", 400);
  }
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== idempotencyKey) {
    return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.revoke({
      ...actor,
      delegation_id: delegationId,
      expected_version: Number(expectedVersion),
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) return mapErrorOutcome(result);
    return respond({ ok: true, data: result.data, ...result.data }, 200);
  } catch {
    console.error("[work-reports] delegation revoke unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}
