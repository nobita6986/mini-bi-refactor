/**
 * P2.5-W06A - API boundary cho Project Operations (W02 admin RPC).
 *
 * Pipeline thong nhat (giong change-request-api):
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF
 *   3. content-type + JSON bounded
 *   4. quet authority de quy (client khong duoc gui actor/capability/scope/role)
 *   5. strict request projection (optional action reason, OCC, idempotency)
 *   6. resolve session server-side -> actor CHI tu session
 *   7. repository/RPC
 *   8. response sanitized (khong forward raw DB message)
 *
 * Module nay KHONG danh gia quyen va KHONG doc truoc DB: capability/scope do RPC enforce.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import type { ProjectAdminRepository } from "./project-admin-repository.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASON_MAX = 4000;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && DATE.test(todayVn)
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}
/** Gioi han do dai search cho bo chon candidate (display_name/personnel_code toi da 256). */
const SEARCH_MAX = 256;
/** Giong dung check constraint cua public.direct_entry_projects.project_id (defense in depth). */
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type ProjectAdminDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: ProjectAdminRepository;
};

export type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

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
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** Id duong dan chi duoc dung khi khop chinh xac shape DB chap nhan; neu khong -> 400 truoc khi goi RPC. */
function resourceId(value: string | null): string | null {
  return value !== null && PROJECT_ID.test(value) ? value : null;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("BODY_INVALID", 400) };
  return { ok: true, value: body };
}

/** Client khong duoc gui actor/capability/scope/role o bat ky do sau nao. */
function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("PROJECT_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: ProjectAdminDependencies,
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
    console.error("[direct-entry] project admin session unavailable");
    return { ok: false, response: fail("PROJECT_UNAVAILABLE", 500) };
  }
}

/** Taxonomy sanitized: khong bao gio forward raw DB message. */
export function projectAdminErrorResponse(kind: string, notFoundCode = "PROJECT_NOT_FOUND"): Response {
  if (kind === "denied") return fail("PROJECT_DENIED", 403);
  if (kind === "not-found") return fail(notFoundCode, 404);
  if (kind === "conflict") return fail("PROJECT_CONFLICT", 409);
  if (kind === "invalid") return fail("PROJECT_INVALID", 400);
  console.error("[direct-entry] project admin unavailable");
  return fail("PROJECT_UNAVAILABLE", 500);
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

function mutationRequestKeys(keys: readonly string[]) {
  return ["reason", "idempotency_key", ...keys] as const;
}

export type CreateProjectRequest = {
  project_id: string; display_name: string; reason: string | null; idempotency_key: string;
};
export function projectAdminCreateRequest(body: unknown): Parsed<CreateProjectRequest> {
  const value = record(body);
  if (!value || !exact(value, mutationRequestKeys(["project_id", "display_name"]))) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const project_id = resourceId(text(value.project_id, 256));
  const display_name = text(value.display_name, 256);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (!project_id || !display_name || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  return { ok: true, value: { project_id, display_name, reason: reason.value, idempotency_key } };
}

export type UpdateProjectRequest = {
  expected_version: number; display_name: string; reason: string | null; idempotency_key: string;
};
export function projectAdminUpdateRequest(body: unknown): Parsed<UpdateProjectRequest> {
  const value = record(body);
  if (!value || !exact(value, mutationRequestKeys(["expected_version", "display_name"]))) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const display_name = text(value.display_name, 256);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || !display_name || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  return { ok: true, value: { expected_version, display_name, reason: reason.value, idempotency_key } };
}

export type SetActiveRequest = {
  active: boolean; expected_version: number; reason: string | null; idempotency_key: string;
};
export function projectAdminSetActiveRequest(body: unknown): Parsed<SetActiveRequest> {
  const value = record(body);
  if (!value || !exact(value, mutationRequestKeys(["active", "expected_version"])) ||
      typeof value.active !== "boolean") {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  return { ok: true, value: { active: value.active, expected_version, reason: reason.value, idempotency_key } };
}

export type AssignRequest = {
  manager_recruiter_id: string; valid_from: string | null;
  expected_project_version: number; reason: string | null; idempotency_key: string;
};
export function projectAdminAssignRequest(body: unknown, todayVn?: string): Parsed<AssignRequest> {
  const value = record(body);
  if (!value) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const normalized = "valid_from" in value ? value : { ...value, valid_from: null };
  if (!exact(normalized, mutationRequestKeys(
    ["manager_recruiter_id", "valid_from", "expected_project_version"]))) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const businessToday = resolveBusinessTodayVn(todayVn);
  const manager_recruiter_id = uuid(value.manager_recruiter_id);
  const omittedOrNull = value.valid_from === undefined || value.valid_from === null;
  const valid_from = omittedOrNull
    ? null
    : (typeof value.valid_from === "string" && DATE.test(value.valid_from) ? value.valid_from : null);
  const expected_project_version = version(value.expected_project_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (!manager_recruiter_id || (!omittedOrNull && (!valid_from || valid_from !== businessToday)) ||
      expected_project_version === null || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  return { ok: true, value: { manager_recruiter_id, valid_from,
    expected_project_version, reason: reason.value, idempotency_key } };
}

export type UnassignRequest = {
  expected_version: number; expected_project_version: number;
  reason: string | null; idempotency_key: string;
};
export function projectAdminUnassignRequest(body: unknown): Parsed<UnassignRequest> {
  const value = record(body);
  if (!value || !exact(value, mutationRequestKeys(
    ["expected_version", "expected_project_version"]))) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const expected_project_version = version(value.expected_project_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_project_version === null ||
      !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  return { ok: true, value: { expected_version, expected_project_version, reason: reason.value, idempotency_key } };
}

export type UpdateProjectLocationRequest = {
  expected_version: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  radius_meters: number;
  clear: boolean;
  reason: string | null;
  idempotency_key: string;
};

const LOCATION_FLAT_ALLOWED_KEYS = new Set([
  "expected_version",
  "address",
  "latitude",
  "longitude",
  "radius_meters",
  "clear",
  "reason",
  "idempotency_key",
]);

const LOCATION_NESTED_OUTER_ALLOWED_KEYS = new Set([
  "expected_version",
  "location",
  "reason",
  "idempotency_key",
]);

const LOCATION_NESTED_INNER_ALLOWED_KEYS = new Set([
  "address",
  "latitude",
  "longitude",
  "radius_meters",
]);

export function projectAdminUpdateLocationRequest(
  body: unknown,
): Parsed<UpdateProjectLocationRequest> {
  const value = record(body);
  if (!value) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }

  let rawLocationSource: Record<string, unknown>;
  let clearFlag = false;

  if ("location" in value) {
    if (Object.keys(value).some((k) => !LOCATION_NESTED_OUTER_ALLOWED_KEYS.has(k))) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    if (value.location === null) {
      return {
        ok: true,
        value: {
          expected_version,
          address: null,
          latitude: null,
          longitude: null,
          radius_meters: 200,
          clear: true,
          reason: reason.value,
          idempotency_key,
        },
      };
    }
    const inner = record(value.location);
    if (
      !inner ||
      Object.keys(inner).some((k) => !LOCATION_NESTED_INNER_ALLOWED_KEYS.has(k))
    ) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    rawLocationSource = inner;
  } else {
    if (Object.keys(value).some((k) => !LOCATION_FLAT_ALLOWED_KEYS.has(k))) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    if ("clear" in value && typeof value.clear !== "boolean") {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    clearFlag = value.clear === true;
    rawLocationSource = value;
  }

  if (clearFlag) {
    if (
      (rawLocationSource.latitude !== undefined && rawLocationSource.latitude !== null) ||
      (rawLocationSource.longitude !== undefined && rawLocationSource.longitude !== null) ||
      (rawLocationSource.address !== undefined &&
        rawLocationSource.address !== null &&
        String(rawLocationSource.address).trim() !== "")
    ) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    return {
      ok: true,
      value: {
        expected_version,
        address: null,
        latitude: null,
        longitude: null,
        radius_meters: 200,
        clear: true,
        reason: reason.value,
        idempotency_key,
      },
    };
  }

  const rawLat = rawLocationSource.latitude;
  const rawLon = rawLocationSource.longitude;
  if (
    typeof rawLat !== "number" ||
    !Number.isFinite(rawLat) ||
    rawLat < -90 ||
    rawLat > 90 ||
    typeof rawLon !== "number" ||
    !Number.isFinite(rawLon) ||
    rawLon < -180 ||
    rawLon > 180
  ) {
    return { ok: false, response: fail("PROJECT_INVALID", 400) };
  }

  let address: string | null = null;
  if (rawLocationSource.address !== undefined && rawLocationSource.address !== null) {
    if (typeof rawLocationSource.address !== "string") {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    const trimmed = rawLocationSource.address.trim();
    if (trimmed.length > 500 || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed)) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    address = trimmed.length > 0 ? trimmed : null;
  }

  let radius_meters = 200;
  if (
    rawLocationSource.radius_meters !== undefined &&
    rawLocationSource.radius_meters !== null
  ) {
    if (
      typeof rawLocationSource.radius_meters !== "number" ||
      !Number.isSafeInteger(rawLocationSource.radius_meters) ||
      rawLocationSource.radius_meters < 50 ||
      rawLocationSource.radius_meters > 2000
    ) {
      return { ok: false, response: fail("PROJECT_INVALID", 400) };
    }
    radius_meters = rawLocationSource.radius_meters;
  }

  const latitude = Number((Object.is(rawLat, -0) ? 0 : rawLat).toFixed(7));
  const longitude = Number((Object.is(rawLon, -0) ? 0 : rawLon).toFixed(7));

  return {
    ok: true,
    value: {
      expected_version,
      address,
      latitude,
      longitude,
      radius_meters,
      clear: false,
      reason: reason.value,
      idempotency_key,
    },
  };
}

/** Chay mot mutation da qua preflight + parse. */
async function runMutation<T>(
  request: Request,
  dependencies: ProjectAdminDependencies,
  parsed: Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor) => Promise<{ ok: true; data: T } | { ok: false; kind: string }>,
  logMessage: string,
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
    console.error(logMessage);
    return fail("PROJECT_UNAVAILABLE", 500);
  }
  if (!result.ok) return projectAdminErrorResponse(result.kind);
  return respond({ ok: true, project: result.data }, 200);
}

export async function listProjectsAdmin(
  request: Request, flag: string | undefined, dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  const includeInactive = new URL(request.url).searchParams.get("include_inactive") !== "false";
  try {
    const result = await dependencies.repository.listProjects({
      ...actor.value, include_inactive: includeInactive,
    });
    if (!result.ok) return projectAdminErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[direct-entry] project admin list failed");
    return fail("PROJECT_UNAVAILABLE", 500);
  }
}

export async function listManagerCandidatesAdmin(
  request: Request, flag: string | undefined, dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  const raw = new URL(request.url).searchParams.get("search");
  if (raw !== null && raw.length > SEARCH_MAX) return fail("PROJECT_INVALID", 400);
  const search = raw !== null && raw.trim() !== "" ? raw.trim() : null;
  try {
    const result = await dependencies.repository.listManagerCandidates({
      ...actor.value, search,
    });
    if (!result.ok) return projectAdminErrorResponse(result.kind);
    return respond({ ok: true, candidates: result.data.candidates }, 200);
  } catch {
    console.error("[direct-entry] project admin candidates failed");
    return fail("PROJECT_UNAVAILABLE", 500);
  }
}

export async function getProjectAdmin(
  request: Request, projectId: string, flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const id = resourceId(projectId);
  if (!id) return fail("PROJECT_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getProjectDetail({ ...actor.value, project_id: id });
    if (!result.ok) return projectAdminErrorResponse(result.kind);
    return respond({ ok: true, detail: result.data }, 200);
  } catch {
    console.error("[direct-entry] project admin detail failed");
    return fail("PROJECT_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request, flag: string | undefined, dependencies: ProjectAdminDependencies,
  parse: (body: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor, value: never) => Promise<{ ok: true; data: unknown } | { ok: false; kind: string }>,
  logMessage: string,
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
    (actor) => run(actor, parsed.value as never), logMessage);
}

export function createProjectAdmin(
  request: Request, flag: string | undefined, dependencies: ProjectAdminDependencies,
): Promise<Response> {
  return mutationPipeline(request, flag, dependencies, projectAdminCreateRequest,
    (actor, value: CreateProjectRequest) => dependencies.repository.createProject({ ...actor, ...value }),
    "[direct-entry] project admin create failed");
}

export function updateProjectAdmin(
  request: Request, projectId: string, flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const id = resourceId(projectId);
  return mutationPipeline(request, flag, dependencies, projectAdminUpdateRequest,
    (actor, value: UpdateProjectRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.updateProject({ ...actor, project_id: id, ...value }),
    "[direct-entry] project admin update failed");
}

export function setProjectActiveAdmin(
  request: Request, projectId: string, flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const id = resourceId(projectId);
  return mutationPipeline(request, flag, dependencies, projectAdminSetActiveRequest,
    (actor, value: SetActiveRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.setProjectActive({ ...actor, project_id: id, ...value }),
    "[direct-entry] project admin set-active failed");
}

export function assignProjectManagerAdmin(
  request: Request, projectId: string, flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const id = resourceId(projectId);
  return mutationPipeline(request, flag, dependencies, projectAdminAssignRequest,
    (actor, value: AssignRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.assignManager({ ...actor, project_id: id, ...value }),
    "[direct-entry] project admin assign failed");
}

export function unassignProjectManagerAdmin(
  request: Request, projectId: string, assignmentId: string, flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const id = resourceId(projectId);
  const assignment = uuid(assignmentId);
  return mutationPipeline(request, flag, dependencies, projectAdminUnassignRequest,
    (actor, value: UnassignRequest) => id === null || assignment === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.unassignManager({ ...actor, assignment_id: assignment, ...value }),
    "[direct-entry] project admin unassign failed");
}

export function updateProjectLocationAdmin(
  request: Request,
  projectId: string,
  flag: string | undefined,
  dependencies: ProjectAdminDependencies,
): Promise<Response> {
  const id = resourceId(projectId);
  return mutationPipeline(
    request,
    flag,
    dependencies,
    projectAdminUpdateLocationRequest,
    (actor, value: UpdateProjectLocationRequest) => {
      if (id === null) {
        return Promise.resolve({ ok: false as const, kind: "invalid" });
      }
      if (!dependencies.repository.updateProjectLocation) {
        return Promise.resolve({ ok: false as const, kind: "unavailable" });
      }
      return dependencies.repository.updateProjectLocation({
        ...actor,
        project_id: id,
        ...value,
      });
    },
    "[direct-entry] project admin location update failed",
  );
}
