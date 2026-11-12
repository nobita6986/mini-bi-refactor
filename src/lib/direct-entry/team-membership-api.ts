/**
 * P3.1-W01C-B - API boundary cho team membership lifecycle (RPC #70).
 *
 * Pipeline thong nhat (giong team-catalog-api / personnel-catalog-api):
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF (mutation)
 *   3. content-type + JSON bounded
 *   4. quet authority de quy (client khong duoc gui actor/role/capability/scope)
 *   5. strict request projection (optional action reason, OCC, idempotency)
 *   6. resolve session server-side -> actor CHI tu session
 *   7. repository/RPC
 *   8. response sanitized (khong forward raw DB message), no-store
 *
 * Module nay KHONG danh gia quyen va KHONG doc truoc DB: DB guard
 * (direct_entry_assert_catalog_operator tu #68) la authority cuoi.
 * KHONG co UI trong task nay.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import { parseIsoDate } from "./direct-entry-date-format.ts";
import type { TeamMembershipRepository } from "./team-membership-repository.ts";
import type { MembershipState } from "./team-membership-contract.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const STATE_MAP: Readonly<Record<string, MembershipState>> = {
  current: "CURRENT", scheduled: "SCHEDULED", history: "HISTORY",
};

export type TeamMembershipDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: TeamMembershipRepository;
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
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * ISO date-only field. The regex is only a shape pre-filter: calendar validity is
 * checked by the shared pure parser (Date.UTC over numeric parts, never
 * new Date("YYYY-MM-DD")), so 2026-02-30, 2026-13-01 and 2026-00-10 are rejected at
 * the request boundary before the session or the repository is touched.
 */
function day(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  return parseIsoDate(value) === null ? null : value;
}
/** Absent query value -> the documented default; anything outside 1..max is rejected. */
function pageNumber(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : null;
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
    return fail("MEMBERSHIP_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: TeamMembershipDependencies,
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
    console.error("[team-membership] session unavailable");
    return { ok: false, response: fail("MEMBERSHIP_UNAVAILABLE", 500) };
  }
}

/** Taxonomy sanitized: khong bao gio forward raw DB message. */
export function teamMembershipErrorResponse(kind: string): Response {
  if (kind === "overlap") return fail("MEMBERSHIP_OVERLAP", 409);
  if (kind === "already-team") return fail("MEMBERSHIP_SAME_TEAM", 400);
  if (kind === "no-membership") return fail("MEMBERSHIP_NOT_MOVABLE", 409);
  if (kind === "date-before") return fail("MEMBERSHIP_DATE_BEFORE_START", 400);
  if (kind === "attribution") return fail("MEMBERSHIP_ATTRIBUTION_CONFLICT", 400);
  if (kind === "denied") return fail("MEMBERSHIP_DENIED", 403);
  if (kind === "not-found") return fail("MEMBERSHIP_NOT_FOUND", 404);
  if (kind === "conflict") return fail("MEMBERSHIP_CONFLICT", 409);
  if (kind === "invalid") return fail("MEMBERSHIP_INVALID", 400);
  console.error("[team-membership] unavailable");
  return fail("MEMBERSHIP_UNAVAILABLE", 500);
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

export type ListMembershipQuery = {
  state: MembershipState; recruiter_id: string | null; team_id: string | null;
  search: string | null; page: number; page_size: number;
};
export function teamMembershipListQuery(url: URL): Parsed<ListMembershipQuery> {
  // state bat buoc: ba nhom current/scheduled/history la ba read contract rieng.
  const state = STATE_MAP[(url.searchParams.get("state") ?? "").toLowerCase()];
  if (!state) return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };

  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;

  const rawRecruiter = url.searchParams.get("recruiter_id");
  const recruiter_id = rawRecruiter === null ? null : uuid(rawRecruiter);
  const rawTeam = url.searchParams.get("team_id");
  const team_id = rawTeam === null ? null : uuid(rawTeam);
  if (recruiter_id === null && rawRecruiter !== null) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  if (team_id === null && rawTeam !== null) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }

  const page = pageNumber(url.searchParams.get("page"), 1, 1000);
  const page_size = pageNumber(url.searchParams.get("page_size"), 25, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  return { ok: true, value: { state, recruiter_id, team_id, search, page, page_size } };
}

function resolveTeamMembershipBusinessTodayVn(todayVn?: string | null): string {
  if (typeof todayVn === "string" && day(todayVn) !== null) {
    return todayVn;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The target team is a RESOURCE id taken from the URL path, never from the body:
 * the shared client-authority validator forbids client-supplied team fields, and a
 * server-derived team id keeps that control intact.
 */
export type AssignMembershipRequest = {
  valid_from: string | null; expected_version: number; reason: string | null; idempotency_key: string;
};
export function teamMembershipAssignRequest(
  body: unknown,
  todayVn?: string | null,
): Parsed<AssignMembershipRequest> {
  const value = record(body);
  if (!value) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  const hasValidFrom = Object.prototype.hasOwnProperty.call(value, "valid_from");
  const expectedKeys = hasValidFrom
    ? (["valid_from", "expected_version", "reason", "idempotency_key"] as const)
    : (["expected_version", "reason", "idempotency_key"] as const);
  if (!exact(value, expectedKeys)) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  const businessToday = resolveTeamMembershipBusinessTodayVn(todayVn);
  const omittedOrNull = !hasValidFrom || value.valid_from === null;
  const parsedValidFrom = omittedOrNull ? null : day(value.valid_from);
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if ((!omittedOrNull && (!parsedValidFrom || parsedValidFrom !== businessToday)) ||
      expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  return { ok: true, value: { valid_from: parsedValidFrom, expected_version, reason: reason.value, idempotency_key } };
}

export type UnassignMembershipRequest = {
  valid_to: string | null; expected_version: number; reason: string | null; idempotency_key: string;
};
export function teamMembershipUnassignRequest(
  body: unknown,
  todayVn?: string | null,
): Parsed<UnassignMembershipRequest> {
  const value = record(body);
  if (!value) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  const hasValidTo = Object.prototype.hasOwnProperty.call(value, "valid_to");
  const expectedKeys = hasValidTo
    ? (["valid_to", "expected_version", "reason", "idempotency_key"] as const)
    : (["expected_version", "reason", "idempotency_key"] as const);
  if (!exact(value, expectedKeys)) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  const businessToday = resolveTeamMembershipBusinessTodayVn(todayVn);
  const omittedOrNull = !hasValidTo || value.valid_to === null;
  const parsedValidTo = omittedOrNull ? null : day(value.valid_to);
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if ((!omittedOrNull && (!parsedValidTo || parsedValidTo !== businessToday)) ||
      expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("MEMBERSHIP_INVALID", 400) };
  }
  return { ok: true, value: { valid_to: parsedValidTo, expected_version, reason: reason.value, idempotency_key } };
}

async function runMutation<T>(
  request: Request,
  dependencies: TeamMembershipDependencies,
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
    console.error("[team-membership] mutation failed");
    return fail("MEMBERSHIP_UNAVAILABLE", 500);
  }
  if (!result.ok) return teamMembershipErrorResponse(result.kind);
  return respond({ ok: true, membership: result.data }, 200);
}

export async function listTeamMembership(
  request: Request, flag: string | undefined, dependencies: TeamMembershipDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const query = teamMembershipListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listMembership({ ...actor.value, ...query.value });
    if (!result.ok) return teamMembershipErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[team-membership] list failed");
    return fail("MEMBERSHIP_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request, flag: string | undefined, dependencies: TeamMembershipDependencies,
  parse: (body: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  resourceIdsValid: boolean,
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
  // A malformed resource id in the path is rejected before the session is touched.
  if (!resourceIdsValid) return fail("MEMBERSHIP_INVALID", 400);
  return runMutation(request, dependencies, parsed,
    (actor) => run(actor, parsed.value as never));
}

export function assignTeamMembership(
  request: Request, recruiterId: string, teamId: string, flag: string | undefined,
  dependencies: TeamMembershipDependencies,
): Promise<Response> {
  const id = uuid(recruiterId);
  const target = uuid(teamId);
  return mutationPipeline(request, flag, dependencies, teamMembershipAssignRequest,
    id !== null && target !== null,
    (actor, value: AssignMembershipRequest) => {
      // Unreachable once resourceIdsValid passed; it keeps the ids narrowed here.
      if (id === null || target === null) {
        return Promise.resolve({ ok: false as const, kind: "invalid" });
      }
      return dependencies.repository.assignMembership({ ...actor, recruiter_id: id,
        team_id: target, ...value });
    });
}

export function moveTeamMembership(
  request: Request, recruiterId: string, teamId: string, flag: string | undefined,
  dependencies: TeamMembershipDependencies,
): Promise<Response> {
  const id = uuid(recruiterId);
  const target = uuid(teamId);
  return mutationPipeline(request, flag, dependencies, teamMembershipAssignRequest,
    id !== null && target !== null,
    (actor, value: AssignMembershipRequest) => {
      if (id === null || target === null) {
        return Promise.resolve({ ok: false as const, kind: "invalid" });
      }
      return dependencies.repository.moveMembership({ ...actor, recruiter_id: id,
        team_id: target, ...value });
    });
}

export function unassignTeamMembership(
  request: Request, recruiterId: string, flag: string | undefined,
  dependencies: TeamMembershipDependencies,
): Promise<Response> {
  const id = uuid(recruiterId);
  return mutationPipeline(request, flag, dependencies, teamMembershipUnassignRequest,
    id !== null,
    (actor, value: UnassignMembershipRequest) => {
      if (id === null) {
        return Promise.resolve({ ok: false as const, kind: "invalid" });
      }
      return dependencies.repository.unassignMembership({ ...actor, recruiter_id: id, ...value });
    });
}
