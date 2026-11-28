/**
 * API boundary for Collaborator (CTV) master catalog administration.
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin / CSRF guard (mutations)
 *   3. content-type + bounded JSON
 *   4. recursive client authority-field rejection
 *   5. strict request projection (optional reason/address/phone, OCC, idempotency)
 *   6. server-side session resolution -> actor strictly from session
 *   7. repository / RPC
 *   8. sanitized response, private no-store
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";
import {
  COLLABORATOR_ID_MAX,
  COLLABORATOR_ID_PATTERN,
  COLLABORATOR_NAME_MAX,
  COLLABORATOR_REASON_MAX,
  COLLABORATOR_SEARCH_MAX,
  RESERVED_COLLABORATOR_ID,
} from "./collaborator-catalog-contract.ts";
import type { CollaboratorCatalogRepository } from "./collaborator-catalog-repository.ts";
import {
  hasRequiredAndOptionalKeys,
  projectOptionalPartnerAddress,
  projectOptionalPartnerPhone,
} from "./vendor-catalog-contract.ts";
import { readBoundedJson } from "./write-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CollaboratorCatalogDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: CollaboratorCatalogRepository;
};

export type TrustedActor = { auth_subject: string; app_user_id: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.trim().length <= max
    ? value.trim()
    : null;
}

function collaboratorId(value: unknown): string | null {
  const candidate = text(value, COLLABORATOR_ID_MAX);
  if (
    candidate === null ||
    !COLLABORATOR_ID_PATTERN.test(candidate) ||
    candidate === RESERVED_COLLABORATOR_ID
  ) {
    return null;
  }
  return candidate;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function pageNumber(
  value: string | null,
  min: number,
  max: number,
  defaultValue: number,
): number | null {
  if (value === null) return defaultValue;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("BODY_INVALID", 400) };
  return { ok: true, value: body };
}

function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("COLLABORATOR_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: CollaboratorCatalogDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response:
          session.actor.reason === "UNAUTHENTICATED"
            ? fail("UNAUTHENTICATED", 401)
            : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !uuid(actor.auth_subject) || !uuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return {
      ok: true,
      value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id },
    };
  } catch {
    console.error("[collaborator-catalog] session unavailable");
    return { ok: false, response: fail("COLLABORATOR_UNAVAILABLE", 500) };
  }
}

export function collaboratorCatalogErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("COLLABORATOR_DENIED", 403);
  if (kind === "not-found") return fail("COLLABORATOR_NOT_FOUND", 404);
  if (kind === "code-conflict") return fail("PARTNER_CODE_CONFLICT", 409);
  if (kind === "conflict") return fail("COLLABORATOR_CONFLICT", 409);
  if (kind === "invalid") return fail("COLLABORATOR_INVALID", 400);
  console.error("[collaborator-catalog] unavailable");
  return fail("COLLABORATOR_UNAVAILABLE", 500);
}

function readPreflight(flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  return null;
}

function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const gated = readPreflight(flag);
  if (gated) return gated;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  return null;
}

export type ListCollaboratorsQuery = {
  search: string | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
};

export function collaboratorCatalogListQuery(url: URL): Parsed<ListCollaboratorsQuery> {
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > COLLABORATOR_SEARCH_MAX) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;
  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (
    rawIncludeInactive !== null &&
    rawIncludeInactive !== "true" &&
    rawIncludeInactive !== "false"
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive === "true";
  const page = pageNumber(url.searchParams.get("page"), 1, 1000, 1);
  const page_size = pageNumber(url.searchParams.get("page_size"), 1, 100, 25);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  return { ok: true, value: { search, include_inactive, page, page_size } };
}

export type CreateCollaboratorRequest = {
  expected_version: 0;
  collaborator_id: string;
  display_name: string;
  address: string | null;
  phone: string | null;
  reason: string | null;
  idempotency_key: string;
};

export function collaboratorCatalogCreateRequest(
  body: unknown,
): Parsed<CreateCollaboratorRequest> {
  const value = record(body);
  if (
    !value ||
    !hasRequiredAndOptionalKeys(
      value,
      ["expected_version", "collaborator_id", "display_name", "idempotency_key"],
      ["reason", "address", "phone"],
    )
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const collaborator_id = collaboratorId(value.collaborator_id);
  const display_name = text(value.display_name, COLLABORATOR_NAME_MAX);
  const address = projectOptionalPartnerAddress(value.address);
  const phone = projectOptionalPartnerPhone(value.phone);
  const reason = projectOptionalActionReason(value.reason, COLLABORATOR_REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (
    expected_version !== 0 ||
    !collaborator_id ||
    !display_name ||
    !address.ok ||
    !phone.ok ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  return {
    ok: true,
    value: {
      expected_version: 0,
      collaborator_id,
      display_name,
      address: address.value,
      phone: phone.value,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type UpdateCollaboratorRequest = {
  expected_version: number;
  display_name: string;
  address: string | null;
  phone: string | null;
  reason: string | null;
  idempotency_key: string;
};

export function collaboratorCatalogUpdateRequest(
  body: unknown,
): Parsed<UpdateCollaboratorRequest> {
  const value = record(body);
  if (
    !value ||
    !hasRequiredAndOptionalKeys(
      value,
      ["expected_version", "display_name", "idempotency_key"],
      ["reason", "address", "phone"],
    )
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const display_name = text(value.display_name, COLLABORATOR_NAME_MAX);
  const address = projectOptionalPartnerAddress(value.address);
  const phone = projectOptionalPartnerPhone(value.phone);
  const reason = projectOptionalActionReason(value.reason, COLLABORATOR_REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (
    expected_version === null ||
    expected_version < 1 ||
    !display_name ||
    !address.ok ||
    !phone.ok ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  return {
    ok: true,
    value: {
      expected_version,
      display_name,
      address: address.value,
      phone: phone.value,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type SetActiveCollaboratorRequest = {
  active: boolean;
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};

export function collaboratorCatalogSetActiveRequest(
  body: unknown,
): Parsed<SetActiveCollaboratorRequest> {
  const value = record(body);
  if (
    !value ||
    !hasExactKeysWithOptionalReason(value, [
      "active",
      "expected_version",
      "reason",
      "idempotency_key",
    ]) ||
    typeof value.active !== "boolean"
  ) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, COLLABORATOR_REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("COLLABORATOR_INVALID", 400) };
  }
  return {
    ok: true,
    value: {
      active: value.active,
      expected_version,
      reason: reason.value,
      idempotency_key,
    },
  };
}

async function runMutation<T>(
  request: Request,
  dependencies: CollaboratorCatalogDependencies,
  parsed: Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor) => Promise<{ ok: true; data: T } | { ok: false; kind: string }>,
): Promise<Response> {
  if (!parsed.ok) return parsed.response;
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  let result: { ok: true; data: T } | { ok: false; kind: string };
  try {
    result = await run(actor.value);
  } catch {
    console.error("[collaborator-catalog] mutation failed");
    return fail("COLLABORATOR_UNAVAILABLE", 500);
  }
  if (!result.ok) return collaboratorCatalogErrorResponse(result.kind);
  return respond({ ok: true, collaborator: result.data }, 200);
}

export async function listCollaboratorsCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const query = collaboratorCatalogListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listCollaborators({
      ...actor.value,
      ...query.value,
    });
    if (!result.ok) return collaboratorCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[collaborator-catalog] list failed");
    return fail("COLLABORATOR_UNAVAILABLE", 500);
  }
}

export async function getCollaboratorCatalog(
  request: Request,
  collaboratorIdValue: string,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const id = collaboratorId(collaboratorIdValue);
  if (!id) return fail("COLLABORATOR_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getCollaborator({
      ...actor.value,
      collaborator_id: id,
    });
    if (!result.ok) return collaboratorCatalogErrorResponse(result.kind);
    return respond({ ok: true, collaborator: result.data }, 200);
  } catch {
    console.error("[collaborator-catalog] detail failed");
    return fail("COLLABORATOR_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
  parse: (body: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (
    actor: TrustedActor,
    value: never,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; kind: string }>,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.value);
  if (authority) return authority;
  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;
  return runMutation(request, dependencies, parsed, (actor) =>
    run(actor, parsed.value as never),
  );
}

export function createCollaboratorCatalog(
  request: Request,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
): Promise<Response> {
  return mutationPipeline(
    request,
    flag,
    dependencies,
    collaboratorCatalogCreateRequest,
    (actor, value: CreateCollaboratorRequest) =>
      dependencies.repository.createCollaborator({ ...actor, ...value }),
  );
}

export function updateCollaboratorCatalog(
  request: Request,
  collaboratorIdValue: string,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
): Promise<Response> {
  const id = collaboratorId(collaboratorIdValue);
  return mutationPipeline(
    request,
    flag,
    dependencies,
    collaboratorCatalogUpdateRequest,
    (actor, value: UpdateCollaboratorRequest) =>
      id === null
        ? Promise.resolve({ ok: false as const, kind: "invalid" })
        : dependencies.repository.updateCollaborator({ ...actor, collaborator_id: id, ...value }),
  );
}

export function setCollaboratorCatalogActive(
  request: Request,
  collaboratorIdValue: string,
  flag: string | undefined,
  dependencies: CollaboratorCatalogDependencies,
): Promise<Response> {
  const id = collaboratorId(collaboratorIdValue);
  return mutationPipeline(
    request,
    flag,
    dependencies,
    collaboratorCatalogSetActiveRequest,
    (actor, value: SetActiveCollaboratorRequest) =>
      id === null
        ? Promise.resolve({ ok: false as const, kind: "invalid" })
        : dependencies.repository.setCollaboratorActive({
            ...actor,
            collaborator_id: id,
            ...value,
          }),
  );
}
