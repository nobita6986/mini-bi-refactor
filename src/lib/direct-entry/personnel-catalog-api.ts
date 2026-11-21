/**
 * P3.1-W01B - API boundary cho personnel catalog admin (RPC #68).
 *
 * Pipeline thong nhat (giong project-admin-api):
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF (mutation)
 *   3. content-type + JSON bounded
 *   4. quet authority de quy (client khong duoc gui actor/role/capability/scope)
 *   5. strict request projection (optional action reason, OCC, idempotency)
 *   6. resolve session server-side -> actor CHI tu session
 *   7. repository/RPC
 *   8. response sanitized (khong forward raw DB message)
 *
 * Module nay KHONG danh gia quyen va KHONG doc truoc DB: DB guard
 * (direct_entry_assert_catalog_operator) la authority cuoi. Khong co UI/nav.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import type { PersonnelCatalogRepository } from "./personnel-catalog-repository.ts";
import type { PersonnelPosition } from "./personnel-catalog-contract.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const CODE_MAX = 64;
const NAME_MAX = 256;
/** personnel_code la business ID: khong khoang trang, khong control character. */
const CODE = /^[^\s\u0000-\u001f\u007f]+$/;
const POSITIONS: readonly PersonnelPosition[] = ["STAFF", "TEAM_LEADER"];

export type PersonnelCatalogDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: PersonnelCatalogRepository;
};

export type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasExactKeysWithOptionalReason(value, keys);
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
}
function code(value: unknown): string | null {
  const candidate = text(value, CODE_MAX);
  return candidate !== null && CODE.test(candidate) ? candidate : null;
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function position(value: unknown): PersonnelPosition | null {
  return typeof value === "string" && (POSITIONS as readonly string[]).includes(value)
    ? value as PersonnelPosition : null;
}
function day(value: unknown): string | null {
  return typeof value === "string" && DATE.test(value) ? value : null;
}
function pageNumber(value: string | null, min: number, max: number): number | null {
  if (value === null) return min === 1 ? 1 : null;
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

/** Client khong duoc gui actor/role/capability/scope o bat ky do sau nao. */
function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("PERSONNEL_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: PersonnelCatalogDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !uuid(actor.auth_subject) || !uuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    // Actor CHI den tu session server-side; khong bao gio lay tu body/header client.
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[personnel-catalog] session unavailable");
    return { ok: false, response: fail("PERSONNEL_UNAVAILABLE", 500) };
  }
}

/** Taxonomy sanitized: khong bao gio forward raw DB message. */
export function personnelCatalogErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("PERSONNEL_DENIED", 403);
  if (kind === "not-found") return fail("PERSONNEL_NOT_FOUND", 404);
  if (kind === "conflict") return fail("PERSONNEL_CONFLICT", 409);
  if (kind === "invalid") return fail("PERSONNEL_INVALID", 400);
  console.error("[personnel-catalog] unavailable");
  return fail("PERSONNEL_UNAVAILABLE", 500);
}

/** Read routes chi can feature gate; browser GET khong bat buoc gui Origin. */
function readPreflight(flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  return null;
}

/** Mutation routes bat buoc feature gate + same-origin/CSRF. */
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

export type ListPersonnelQuery = {
  search: string | null;
  include_inactive: boolean;
  page: number;
  page_size: number;
  team_id: string | null;
};
export function personnelCatalogListQuery(url: URL): Parsed<ListPersonnelQuery> {
  const allowed = new Set(["search", "include_inactive", "page", "page_size", "team_id"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
    }
  }
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;
  // Chi chap nhan absent | "true" | "false". Gia tri khac la 400, khong bao gio
  // am tham mac dinh thanh true.
  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (rawIncludeInactive !== null && rawIncludeInactive !== "true"
      && rawIncludeInactive !== "false") {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive !== "false";
  const page = pageNumber(url.searchParams.get("page"), 1, 1000);
  const page_size = pageNumber(url.searchParams.get("page_size"), 1, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const rawTeamId = url.searchParams.get("team_id");
  const team_id = rawTeamId === null || rawTeamId === "" ? null : uuid(rawTeamId);
  if (rawTeamId !== null && rawTeamId !== "" && team_id === null) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  return { ok: true, value: { search, include_inactive, page, page_size, team_id } };
}

export type CreatePersonnelRequest = {
  expected_version: 0; personnel_code: string; display_name: string;
  personnel_position: PersonnelPosition; valid_from: string;
  reason: string | null; idempotency_key: string;
};
export function personnelCatalogCreateRequest(body: unknown): Parsed<CreatePersonnelRequest> {
  const value = record(body);
  if (!value || !exact(value, ["expected_version", "personnel_code", "display_name",
    "personnel_position", "valid_from", "reason", "idempotency_key"])) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const personnel_code = code(value.personnel_code);
  const display_name = text(value.display_name, NAME_MAX);
  const personnel_position = position(value.personnel_position);
  const valid_from = day(value.valid_from);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  // create mo mot aggregate moi: expected_version phai dung bang 0. valid_from la
  // bat buoc va tuong minh - khong bao gio coalesce sang authorization date.
  if (expected_version !== 0 || !personnel_code || !display_name || !personnel_position ||
      !valid_from || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  return { ok: true, value: { expected_version: 0, personnel_code, display_name,
    personnel_position, valid_from, reason: reason.value, idempotency_key } };
}

export type UpdatePersonnelRequest = {
  expected_version: number; personnel_code: string; display_name: string;
  personnel_position: PersonnelPosition; reason: string | null; idempotency_key: string;
};
export function personnelCatalogUpdateRequest(body: unknown): Parsed<UpdatePersonnelRequest> {
  const value = record(body);
  if (!value || !exact(value, ["expected_version", "personnel_code", "display_name",
    "personnel_position", "reason", "idempotency_key"])) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const personnel_code = code(value.personnel_code);
  const display_name = text(value.display_name, NAME_MAX);
  const personnel_position = position(value.personnel_position);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !personnel_code || !display_name ||
      !personnel_position || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  return { ok: true, value: { expected_version, personnel_code, display_name,
    personnel_position, reason: reason.value, idempotency_key } };
}

export type SetActivePersonnelRequest = {
  active: boolean; expected_version: number; reason: string | null; idempotency_key: string;
};
export function personnelCatalogSetActiveRequest(body: unknown): Parsed<SetActivePersonnelRequest> {
  const value = record(body);
  if (!value || !exact(value, ["active", "expected_version", "reason", "idempotency_key"]) ||
      typeof value.active !== "boolean") {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PERSONNEL_INVALID", 400) };
  }
  return { ok: true, value: { active: value.active, expected_version, reason: reason.value, idempotency_key } };
}

async function runMutation<T>(
  request: Request,
  dependencies: PersonnelCatalogDependencies,
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
    console.error("[personnel-catalog] mutation failed");
    return fail("PERSONNEL_UNAVAILABLE", 500);
  }
  if (!result.ok) return personnelCatalogErrorResponse(result.kind);
  return respond({ ok: true, personnel: result.data }, 200);
}

export async function listPersonnelCatalog(
  request: Request, flag: string | undefined, dependencies: PersonnelCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const query = personnelCatalogListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listPersonnel({ ...actor.value, ...query.value });
    if (!result.ok) return personnelCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[personnel-catalog] list failed");
    return fail("PERSONNEL_UNAVAILABLE", 500);
  }
}

export async function getPersonnelCatalog(
  request: Request, recruiterId: string, flag: string | undefined,
  dependencies: PersonnelCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const id = uuid(recruiterId);
  if (!id) return fail("PERSONNEL_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getPersonnel({ ...actor.value, recruiter_id: id });
    if (!result.ok) return personnelCatalogErrorResponse(result.kind);
    return respond({ ok: true, personnel: result.data }, 200);
  } catch {
    console.error("[personnel-catalog] detail failed");
    return fail("PERSONNEL_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request, flag: string | undefined, dependencies: PersonnelCatalogDependencies,
  parse: (body: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor, value: never) => Promise<{ ok: true; data: unknown } | { ok: false; kind: string }>,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.value);
  if (authority) return authority;
  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;
  return runMutation(request, dependencies, parsed,
    (actor) => run(actor, parsed.value as never));
}

export function createPersonnelCatalog(
  request: Request, flag: string | undefined, dependencies: PersonnelCatalogDependencies,
): Promise<Response> {
  return mutationPipeline(request, flag, dependencies, personnelCatalogCreateRequest,
    (actor, value: CreatePersonnelRequest) =>
      dependencies.repository.createPersonnel({ ...actor, ...value }));
}

export function updatePersonnelCatalog(
  request: Request, recruiterId: string, flag: string | undefined,
  dependencies: PersonnelCatalogDependencies,
): Promise<Response> {
  const id = uuid(recruiterId);
  return mutationPipeline(request, flag, dependencies, personnelCatalogUpdateRequest,
    (actor, value: UpdatePersonnelRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.updatePersonnel({ ...actor, recruiter_id: id, ...value }));
}

export function setPersonnelCatalogActive(
  request: Request, recruiterId: string, flag: string | undefined,
  dependencies: PersonnelCatalogDependencies,
): Promise<Response> {
  const id = uuid(recruiterId);
  return mutationPipeline(request, flag, dependencies, personnelCatalogSetActiveRequest,
    (actor, value: SetActivePersonnelRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.setPersonnelActive({ ...actor, recruiter_id: id, ...value }));
}
