import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import type { SubmissionRepository, WorkReportSubmissionRpcOutcome } from "./submission-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[\w-]{1,128}$/;

export type SubmissionApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: SubmissionRepository;
};

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response { return respond({ ok: false, code }, status); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function trustedActor(deps: SubmissionApiDependencies): Promise<WorkReportActorRef | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      const unauthenticated = session.actor.reason === "UNAUTHENTICATED";
      return fail(unauthenticated ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE", unauthenticated ? 401 : 403);
    }
    const actor = session.actor.actor;
    if (!actor || actor.partner_account !== undefined || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) return fail("ACTOR_NOT_AVAILABLE", 403);
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    console.error("[work-reports] submission session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mutationGuard(request: Request): Response | null {
  const origin = checkSameOriginRequest({ origin: request.headers.get("origin"), host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site") });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  return null;
}

function mapOutcome<T>(result: WorkReportSubmissionRpcOutcome<T>): Response {
  if (!result.ok) {
    const mapping = {
      conflict: ["WORK_REPORT_VERSION_CONFLICT", 409],
      "deadline-passed": ["WORK_REPORT_DEADLINE_PASSED", 409],
      denied: ["WORK_REPORT_ACCESS_DENIED", 403],
      invalid: ["WORK_REPORT_PAYLOAD_INVALID", 400],
      "not-found": ["WORK_REPORT_NOT_FOUND", 404],
      unavailable: ["WORK_REPORT_UNAVAILABLE", 503],
    } as const;
    const [code, status] = mapping[result.kind];
    return fail(code, status);
  }
  return respond({ ok: true, data: result.data }, 200);
}

export async function listMyWorkReportObligations(request: Request, enabled: string | undefined,
  deps: SubmissionApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "status") || url.searchParams.size > 1) return fail("WORK_REPORT_QUERY_INVALID", 400);
  const status = url.searchParams.get("status");
  if (status !== null && !["ACTIVE", "EXEMPTED", "CANCELLED"].includes(status)) return fail("WORK_REPORT_QUERY_INVALID", 400);
  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.listMine({ ...actor, status })); }
  catch { console.error("[work-reports] obligations list unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function getWorkReportSubmission(request: Request, obligationId: string, enabled: string | undefined,
  deps: SubmissionApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(obligationId) || new URL(request.url).searchParams.size > 0) return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.get({ ...actor, obligation_id: obligationId })); }
  catch { console.error("[work-reports] submission detail unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function writeWorkReportSubmission(request: Request, obligationId: string, action: "draft" | "submit",
  enabled: string | undefined, deps: SubmissionApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(obligationId)) return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok ||
      Object.keys(body).some((key) => !["payload_json", "expected_version", "idempotency_key"].includes(key)) ||
      !isRecord(body.payload_json) || !(body.expected_version === null ||
        (Number.isInteger(body.expected_version) && Number(body.expected_version) >= 1)) ||
      typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) return fail("WORK_REPORT_PAYLOAD_INVALID", 400);
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== body.idempotency_key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;
  const input = { ...actor, obligation_id: obligationId, payload_json: body.payload_json,
    expected_version: body.expected_version as number | null, idempotency_key: body.idempotency_key };
  try {
    return mapOutcome(action === "draft" ? await deps.repository.saveDraft(input) : await deps.repository.submit(input));
  } catch { console.error(`[work-reports] ${action} unavailable`); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}
