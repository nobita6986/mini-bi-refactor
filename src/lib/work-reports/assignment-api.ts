import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { AssignmentCreateInput, AssignmentRepository, WorkReportActorRef, WorkReportRpcOutcome } from "./assignment-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const KEY = /^[\w-]{1,128}$/;

export type AssignmentApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AssignmentRepository;
};

function response(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fail(code: string, status: number): Response { return response({ ok: false, code }, status); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function actorFromSession(deps: AssignmentApiDependencies): Promise<WorkReportActorRef | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) return fail(session.actor.reason === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
      session.actor.reason === "UNAUTHENTICATED" ? 401 : 403);
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) return fail("ACTOR_NOT_AVAILABLE", 403);
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    console.error("[work-reports] assignment session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mutationGuard(request: Request): Response | null {
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"), host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  return null;
}

function idempotencyHeaderMatches(request: Request, key: string): boolean {
  const header = request.headers.get("idempotency-key");
  return header === null || header === key;
}

function projectCreate(value: unknown): Omit<AssignmentCreateInput, keyof WorkReportActorRef> | null {
  if (!isRecord(value) || !validateClientBusinessPayload(value).ok) return null;
  const requiredKeys = ["template_id", "target_kind", "target_user_id", "target_team_id", "target_user_ids", "frequency",
    "is_mandatory", "due_day_offset", "due_time_local", "exclude_sundays", "idempotency_key"];
  const allowedKeys = [...requiredKeys, "target_group_id", "effective_from", "effective_to"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !(key in value))) return null;
  const targetGroup = "target_group_id" in value ? value.target_group_id : null;
  const effectiveFrom = "effective_from" in value ? value.effective_from : null;
  const effectiveTo = "effective_to" in value ? value.effective_to : null;
  if (!(targetGroup === null || (typeof targetGroup === "string" && UUID.test(targetGroup)))) return null;
  if (typeof value.template_id !== "string" || !UUID.test(value.template_id) ||
      !["USER", "TEAM", "USER_SET", "GROUP"].includes(String(value.target_kind)) ||
      !["DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(String(value.frequency)) ||
      typeof value.is_mandatory !== "boolean" || !Number.isInteger(value.due_day_offset) ||
      Number(value.due_day_offset) < 0 || Number(value.due_day_offset) > 31 ||
      typeof value.due_time_local !== "string" || !TIME.test(value.due_time_local) ||
      typeof value.exclude_sundays !== "boolean" ||
      !(effectiveFrom === null || isRealCalendarDate(effectiveFrom)) ||
      !(effectiveTo === null || isRealCalendarDate(effectiveTo)) ||
      (effectiveFrom === null && effectiveTo !== null) ||
      (effectiveTo !== null && String(effectiveTo) < String(effectiveFrom)) ||
      typeof value.idempotency_key !== "string" || !KEY.test(value.idempotency_key) ||
      !Array.isArray(value.target_user_ids) || value.target_user_ids.some((id) => typeof id !== "string" || !UUID.test(id))) return null;
  const kind = value.target_kind;
  const targetUser = value.target_user_id;
  const targetTeam = value.target_team_id;
  if (kind === "USER" && (typeof targetUser !== "string" || !UUID.test(targetUser) || targetTeam !== null || targetGroup !== null || value.target_user_ids.length !== 0)) return null;
  if (kind === "TEAM" && (typeof targetTeam !== "string" || !UUID.test(targetTeam) || targetUser !== null || targetGroup !== null || value.target_user_ids.length !== 0)) return null;
  if (kind === "USER_SET" && (targetUser !== null || targetTeam !== null || targetGroup !== null || value.target_user_ids.length < 1 ||
      new Set(value.target_user_ids).size !== value.target_user_ids.length)) return null;
  if (kind === "GROUP" && (typeof targetGroup !== "string" || !UUID.test(targetGroup) || targetUser !== null || targetTeam !== null || value.target_user_ids.length !== 0)) return null;
  return {
    ...(value as Omit<AssignmentCreateInput, keyof WorkReportActorRef | "target_group_id" | "effective_from" | "effective_to">),
    target_group_id: targetGroup,
    effective_from: effectiveFrom as string | null,
    effective_to: effectiveTo as string | null,
  };
}

function mapOutcome<T>(result: WorkReportRpcOutcome<T>): Response {
  if (!result.ok) {
    const codes = { conflict: ["WORK_REPORT_VERSION_CONFLICT", 409], denied: ["WORK_REPORT_ACCESS_DENIED", 403],
      invalid: ["WORK_REPORT_REQUEST_INVALID", 400], "not-found": ["WORK_REPORT_NOT_FOUND", 404],
      unavailable: ["WORK_REPORT_UNAVAILABLE", 503] } as const;
    const [defaultCode, status] = codes[result.kind];
    return fail(result.code ?? defaultCode, status);
  }
  return response({ ok: true, ...(Array.isArray(result.data) ? { items: result.data } : result.data) }, 200);
}

export async function createWorkReportAssignment(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  const parsed = projectCreate(body);
  if (!parsed) return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  if (!idempotencyHeaderMatches(request, parsed.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.create({ ...actor, ...parsed })); }
  catch { console.error("[work-reports] assignment create unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function listWorkReportAssignmentOptions(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if ([...url.searchParams.keys()].some((key) => key !== "team_id") || url.searchParams.size > 1 ||
      (teamId !== null && !UUID.test(teamId))) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.listOptions({ ...actor, team_id: teamId }));
  } catch {
    console.error("[work-reports] assignment options unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function listWorkReportAssignments(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if ([...url.searchParams.keys()].some((key) => key !== "team_id") || url.searchParams.size > 1 ||
      (teamId !== null && !UUID.test(teamId))) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.listAssignments({ ...actor, team_id: teamId }));
  } catch {
    console.error("[work-reports] assignment list unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function getWorkReportAssignmentDetail(
  request: Request,
  assignmentId: string,
  enabled: string | undefined,
  deps: AssignmentApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(assignmentId)) return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  const url = new URL(request.url);
  if (url.searchParams.size > 0) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    if (!deps.repository.getAssignmentDetail) {
      return fail("WORK_REPORT_UNAVAILABLE", 503);
    }
    return mapOutcome(await deps.repository.getAssignmentDetail({ ...actor, assignment_id: assignmentId }));
  } catch {
    console.error("[work-reports] assignment detail unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function setWorkReportAssignmentState(request: Request, assignmentId: string, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(assignmentId)) return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok ||
      Object.keys(body).some((key) => !["expected_version", "state", "idempotency_key"].includes(key)) ||
      !Number.isInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !["ACTIVE", "PAUSED", "REVOKED"].includes(String(body.state)) ||
      typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) {
    return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  }
  if (!idempotencyHeaderMatches(request, body.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.setState({ ...actor, assignment_id: assignmentId,
      expected_version: Number(body.expected_version), state: body.state as "ACTIVE" | "PAUSED" | "REVOKED",
      idempotency_key: body.idempotency_key }));
  } catch { console.error("[work-reports] assignment update unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function changeWorkReportObligation(request: Request, obligationId: string, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(obligationId)) return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok ||
      Object.keys(body).some((key) => !["expected_version", "action", "reason", "reopened_until", "idempotency_key"].includes(key)) ||
      !Number.isInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !["EXEMPT", "REOPEN"].includes(String(body.action)) || typeof body.reason !== "string" ||
      body.reason.trim().length < 1 || body.reason.length > 4000 ||
      !(body.reopened_until === null || (typeof body.reopened_until === "string" && !Number.isNaN(Date.parse(body.reopened_until)))) ||
      (body.action === "EXEMPT" && body.reopened_until !== null) ||
      (body.action === "REOPEN" && body.reopened_until === null) ||
      typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) {
    return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  }
  if (!idempotencyHeaderMatches(request, body.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.changeObligation({ ...actor, obligation_id: obligationId,
      expected_version: Number(body.expected_version), action: body.action as "EXEMPT" | "REOPEN",
      reason: body.reason.trim(), reopened_until: body.reopened_until as string | null,
      idempotency_key: body.idempotency_key }));
  } catch { console.error("[work-reports] obligation update unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function materializeWorkReportObligations(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isRealCalendarDate(body.business_date)) {
    return fail("WORK_REPORT_REQUEST_INVALID", 400);
  }
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.materialize({ ...actor, business_date: body.business_date as string })); }
  catch { console.error("[work-reports] obligation materialization unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

function parseGroupDefinition(value: Record<string, unknown>): {
  display_name: string;
  description: string | null;
  member_user_ids: string[];
  idempotency_key: string;
} | null {
  if (
    typeof value.display_name !== "string" ||
    value.display_name.trim().length < 1 ||
    value.display_name.trim().length > 160 ||
    !(value.description === null || (typeof value.description === "string" && value.description.trim().length <= 1000)) ||
    !Array.isArray(value.member_user_ids) ||
    value.member_user_ids.length < 1 ||
    value.member_user_ids.length > 500 ||
    value.member_user_ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    new Set(value.member_user_ids).size !== value.member_user_ids.length ||
    typeof value.idempotency_key !== "string" ||
    !KEY.test(value.idempotency_key)
  ) {
    return null;
  }
  const trimmedDesc = value.description === null ? "" : value.description.trim();
  return {
    display_name: value.display_name.trim(),
    description: trimmedDesc.length > 0 ? trimmedDesc : null,
    member_user_ids: value.member_user_ids,
    idempotency_key: value.idempotency_key,
  };
}

export async function listWorkReportGroups(
  request: Request,
  enabled: string | undefined,
  deps: AssignmentApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  if (url.searchParams.size > 0) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.listGroups(actor));
  } catch {
    console.error("[work-reports] group list unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function createWorkReportGroup(
  request: Request,
  enabled: string | undefined,
  deps: AssignmentApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  const requiredKeys = ["display_name", "description", "member_user_ids", "idempotency_key"];
  if (
    !isRecord(body) ||
    !validateClientBusinessPayload(body).ok ||
    Object.keys(body).length !== requiredKeys.length ||
    requiredKeys.some((key) => !(key in body))
  ) {
    return fail("WORK_REPORT_GROUP_INVALID", 400);
  }
  const parsed = parseGroupDefinition(body);
  if (!parsed) return fail("WORK_REPORT_GROUP_INVALID", 400);
  if (!idempotencyHeaderMatches(request, parsed.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.createGroup({ ...actor, ...parsed }));
  } catch {
    console.error("[work-reports] group create unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function patchWorkReportGroup(
  request: Request,
  groupId: string,
  enabled: string | undefined,
  deps: AssignmentApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(groupId)) return fail("WORK_REPORT_GROUP_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok) {
    return fail("WORK_REPORT_GROUP_INVALID", 400);
  }
  const keys = Object.keys(body);
  const activeKeys = ["expected_version", "active", "idempotency_key"];
  const updateKeys = ["expected_version", "display_name", "description", "member_user_ids", "idempotency_key"];
  const isActiveToggle = keys.length === activeKeys.length && activeKeys.every((key) => key in body);
  const isContentUpdate = keys.length === updateKeys.length && updateKeys.every((key) => key in body);
  if ((!isActiveToggle && !isContentUpdate) || !Number.isInteger(body.expected_version) || Number(body.expected_version) < 1) {
    return fail("WORK_REPORT_GROUP_INVALID", 400);
  }
  if (isActiveToggle) {
    if (typeof body.active !== "boolean" || typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) {
      return fail("WORK_REPORT_GROUP_INVALID", 400);
    }
    if (!idempotencyHeaderMatches(request, body.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
    const actor = await actorFromSession(deps);
    if (actor instanceof Response) return actor;
    try {
      return mapOutcome(
        await deps.repository.setGroupActive({
          ...actor,
          group_id: groupId,
          expected_version: Number(body.expected_version),
          active: body.active,
          idempotency_key: body.idempotency_key,
        }),
      );
    } catch {
      console.error("[work-reports] group active update unavailable");
      return fail("WORK_REPORT_UNAVAILABLE", 503);
    }
  }
  const parsed = parseGroupDefinition(body);
  if (!parsed) return fail("WORK_REPORT_GROUP_INVALID", 400);
  if (!idempotencyHeaderMatches(request, parsed.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(
      await deps.repository.updateGroup({
        ...actor,
        group_id: groupId,
        expected_version: Number(body.expected_version),
        ...parsed,
      }),
    );
  } catch {
    console.error("[work-reports] group update unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}
