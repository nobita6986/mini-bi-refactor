import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { parseIsoDate } from "./direct-entry-date-format.ts";
import { readBoundedJson } from "./write-api.ts";
import type {
  TeamLeaderErrorKind,
  TeamLeaderRepository,
} from "./team-leader-repository.ts";
import type { TeamLeaderState } from "./team-leader-contract.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY_KEYS = new Set(["state", "team_id", "search", "page", "page_size"]);
const AUTHORITY_KEYS = new Set([
  "actor", "role", "capability", "capabilities", "scope", "scopes",
  "auth_subject", "app_user_id",
]);
const STATE_MAP: Readonly<Record<string, TeamLeaderState>> = {
  current: "CURRENT", scheduled: "SCHEDULED", history: "HISTORY",
};
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && parseIsoDate(todayVn) !== null
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}

export type TeamLeaderDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: TeamLeaderRepository;
};
type TrustedActor = { auth_subject: string; app_user_id: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" && parseIsoDate(value) !== null ? value : null;
}

function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function pageNumber(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= maximum ? parsed : null;
}

function hasExactQueryKeys(url: URL, keys: ReadonlySet<string>): boolean {
  const found = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!keys.has(key) || found.has(key)) return false;
    found.add(key);
  }
  return true;
}

function readPreflight(flag: string | undefined): Response | null {
  return flag === "true" ? null : fail("NOT_FOUND", 404);
}

function queryAuthorityFailure(url: URL): boolean {
  for (const [key] of url.searchParams) {
    if (AUTHORITY_KEYS.has(key.replace(/[-_]/g, "").toLowerCase())) return true;
  }
  return false;
}

export type TeamLeaderListQuery = {
  state: TeamLeaderState; team_id: string | null; search: string | null;
  page: number; page_size: number;
};

export function teamLeaderListQuery(url: URL): Parsed<TeamLeaderListQuery> {
  if (queryAuthorityFailure(url) || !hasExactQueryKeys(url, QUERY_KEYS)) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  const rawState = url.searchParams.get("state");
  const state = rawState === null ? null : STATE_MAP[rawState];
  const rawTeam = url.searchParams.get("team_id");
  const team_id = rawTeam === null ? null : uuid(rawTeam);
  const rawSearch = url.searchParams.get("search");
  const search = rawSearch === null || rawSearch.trim() === "" ? null : text(rawSearch.trim(), SEARCH_MAX);
  const page = pageNumber(url.searchParams.get("page"), 1, 1000);
  const page_size = pageNumber(url.searchParams.get("page_size"), 25, 100);
  if (!state || (rawTeam !== null && !team_id) ||
      (rawSearch !== null && rawSearch.trim() !== "" && !search) ||
      page === null || page_size === null) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  return { ok: true, value: { state, team_id, search, page, page_size } };
}

export type TeamLeaderCandidateQuery = {
  team_id: string; search: string | null; page: number; page_size: number;
};

export function teamLeaderCandidateQuery(url: URL): Parsed<TeamLeaderCandidateQuery> {
  const keys = new Set(["team_id", "search", "page", "page_size"]);
  if (queryAuthorityFailure(url) || !hasExactQueryKeys(url, keys)) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  const rawTeam = url.searchParams.get("team_id");
  const team_id = uuid(rawTeam);
  const rawSearch = url.searchParams.get("search");
  const search = rawSearch === null || rawSearch.trim() === "" ? null : text(rawSearch.trim(), SEARCH_MAX);
  const page = pageNumber(url.searchParams.get("page"), 1, 1000);
  const page_size = pageNumber(url.searchParams.get("page_size"), 25, 100);
  if (!team_id || (rawSearch !== null && rawSearch.trim() !== "" && !search) ||
      page === null || page_size === null) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  return { ok: true, value: { team_id, search, page, page_size } };
}

type DesignateRequest = {
  leader_app_user_id: string; effective_date: string; expected_version: number;
  reason: string | null; idempotency_key: string;
};
type RevokeRequest = Omit<DesignateRequest, "leader_app_user_id">;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorityFailure(value: unknown): Response | null {
  try {
    const checked = record(value) ? { ...value } : value;
    if (record(checked)) delete checked.leader_app_user_id;
    if (!validateClientBusinessPayload(checked).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("LEADER_INVALID", 400);
  }
  return null;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  return body === null
    ? { ok: false, response: fail("BODY_INVALID", 400) }
    : { ok: true, value: body };
}

export function designateRequest(value: unknown, todayVn?: string): Parsed<DesignateRequest> {
  if (!record(value)) return { ok: false, response: fail("LEADER_INVALID", 400) };
  const normalized = "effective_date" in value ? value : { ...value, effective_date: null };
  if (!hasExactKeysWithOptionalReason(normalized, [
    "effective_date", "expected_version", "idempotency_key", "leader_app_user_id", "reason",
  ])) return { ok: false, response: fail("LEADER_INVALID", 400) };
  const businessToday = resolveBusinessTodayVn(todayVn);
  const leader_app_user_id = uuid(value.leader_app_user_id);
  const effective_date = value.effective_date === undefined || value.effective_date === null
    ? businessToday
    : date(value.effective_date);
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (!leader_app_user_id || !effective_date || effective_date > businessToday ||
      expected_version === null || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  return { ok: true, value: { leader_app_user_id, effective_date, expected_version, reason: reason.value, idempotency_key } };
}

export function revokeRequest(value: unknown, todayVn?: string): Parsed<RevokeRequest> {
  if (!record(value)) return { ok: false, response: fail("LEADER_INVALID", 400) };
  const normalized = "effective_date" in value ? value : { ...value, effective_date: null };
  if (!hasExactKeysWithOptionalReason(normalized, [
    "effective_date", "expected_version", "idempotency_key", "reason",
  ])) return { ok: false, response: fail("LEADER_INVALID", 400) };
  const businessToday = resolveBusinessTodayVn(todayVn);
  const effective_date = value.effective_date === undefined || value.effective_date === null
    ? businessToday
    : date(value.effective_date);
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (!effective_date || effective_date > businessToday || expected_version === null ||
      !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("LEADER_INVALID", 400) };
  }
  return { ok: true, value: { effective_date, expected_version, reason: reason.value, idempotency_key } };
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  return header !== null && header !== key ? fail("IDEMPOTENCY_KEY_MISMATCH", 400) : null;
}

async function trustedActor(
  dependencies: TeamLeaderDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session: DirectEntrySessionResult = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401) : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !uuid(actor.auth_subject) || !uuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[team-leader] session unavailable");
    return { ok: false, response: fail("LEADER_UNAVAILABLE", 500) };
  }
}

export function teamLeaderErrorResponse(kind: TeamLeaderErrorKind | string): Response {
  if (kind === "denied") return fail("LEADER_DENIED", 403);
  if (kind === "not-found") return fail("LEADER_NOT_FOUND", 404);
  if (kind === "conflict") return fail("LEADER_CONFLICT", 409);
  if (kind === "invalid") return fail("LEADER_INVALID", 400);
  console.error("[team-leader] unavailable");
  return fail("LEADER_UNAVAILABLE", 500);
}

export async function listTeamLeader(
  request: Request, flag: string | undefined, dependencies: TeamLeaderDependencies,
): Promise<Response> {
  const gated = readPreflight(flag);
  if (gated) return gated;
  const query = teamLeaderListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await trustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listLeaders({ ...actor.value, ...query.value });
    if (!result.ok) return teamLeaderErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[team-leader] read failed");
    return fail("LEADER_UNAVAILABLE", 500);
  }
}

export async function listTeamLeaderCandidates(
  request: Request, flag: string | undefined, dependencies: TeamLeaderDependencies,
): Promise<Response> {
  const gated = readPreflight(flag);
  if (gated) return gated;
  const query = teamLeaderCandidateQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await trustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listCandidates({ ...actor.value, ...query.value });
    if (!result.ok) return teamLeaderErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[team-leader] candidate read failed");
    return fail("LEADER_UNAVAILABLE", 500);
  }
}

async function runMutation<T>(
  request: Request,
  teamId: string,
  dependencies: TeamLeaderDependencies,
  parsed: Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor, value: never) => Promise<{
    ok: true; data: T;
  } | { ok: false; kind: TeamLeaderErrorKind }>,
): Promise<Response> {
  const team_id = uuid(teamId);
  if (!parsed.ok) return parsed.response;
  if (!team_id) return fail("LEADER_INVALID", 400);
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;
  const actor = await trustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await run(actor.value, parsed.value as never);
    if (!result.ok) return teamLeaderErrorResponse(result.kind);
    return respond({ ok: true, leader: result.data }, 200);
  } catch {
    console.error("[team-leader] mutation failed");
    return fail("LEADER_UNAVAILABLE", 500);
  }
}

async function mutationPipeline<T>(
  request: Request,
  teamId: string,
  flag: string | undefined,
  dependencies: TeamLeaderDependencies,
  parse: (value: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor, team_id: string, value: never) => Promise<{
    ok: true; data: T;
  } | { ok: false; kind: TeamLeaderErrorKind }>,
): Promise<Response> {
  const gated = readPreflight(flag);
  if (gated) return gated;
  if (!uuid(teamId)) return fail("LEADER_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.value);
  if (authority) return authority;
  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;
  return runMutation(request, teamId, dependencies, parsed,
    (actor, value) => {
      const id = uuid(teamId);
      if (!id) return Promise.resolve({ ok: false as const, kind: "invalid" });
      return run(actor, id, value);
    });
}

export function designateTeamLeader(
  request: Request, teamId: string, flag: string | undefined,
  dependencies: TeamLeaderDependencies,
): Promise<Response> {
  return mutationPipeline(request, teamId, flag, dependencies, designateRequest,
    (actor, team_id, value: DesignateRequest) =>
      dependencies.repository.designateLeader({ ...actor, team_id, ...value }));
}

export function revokeTeamLeader(
  request: Request, teamId: string, flag: string | undefined,
  dependencies: TeamLeaderDependencies,
): Promise<Response> {
  return mutationPipeline(request, teamId, flag, dependencies, revokeRequest,
    (actor, team_id, value: RevokeRequest) =>
      dependencies.repository.revokeLeader({ ...actor, team_id, ...value }));
}
