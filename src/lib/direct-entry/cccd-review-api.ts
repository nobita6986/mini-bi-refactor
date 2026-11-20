import "server-only";

import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import {
  hasActiveContextualRole,
  hasAnyValidPairedGrant,
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import {
  isValidReviewEntryId,
  parseCccdReviewListQuery,
  parseCccdReviewResolveRequest,
  parseMissingDocumentWorkersQuery,
} from "./cccd-review-contract.ts";
import type { CccdReviewRepository } from "./cccd-review-repository.ts";
import {
  fail,
  json,
  readIdempotencyKey,
  readJsonBody,
} from "./document-api.ts";
import type { OperationResult } from "./write-repository.ts";

export type CccdReviewApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  reviewRepository: CccdReviewRepository;
};

function mapReviewFailure(
  kind: Exclude<OperationResult<unknown>, { ok: true }>["kind"],
  errorCode?: string,
): Response {
  if (kind === "conflict") return fail("ENTRY_VERSION_CONFLICT", 409);
  if (kind === "denied" || kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
  if (kind === "invalid") return fail(errorCode ?? "CCCD_REVIEW_REQUEST_INVALID", 400);
  console.error("[direct-entry] cccd review operation unavailable");
  return fail("CCCD_REVIEW_UNAVAILABLE", 500);
}

async function resolveReviewActor(
  dependencies: Pick<CccdReviewApiDependencies, "resolveSession">,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
    }
  | { ok: false; response: Response }
> {
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
  const hasReviewOrCreateCapability =
    hasAnyValidPairedGrant(actor, "worker_edit_history_view") ||
    hasAnyValidPairedGrant(actor, "entry_admin") ||
    hasAnyValidPairedGrant(actor, "entry_privileged_edit") ||
    hasAnyValidPairedGrant(actor, "change_request_create") ||
    hasAnyValidPairedGrant(actor, "change_review") ||
    hasAnyValidPairedGrant(actor, "entry_create") ||
    hasAnyValidPairedGrant(actor, "entry_own") ||
    hasAnyValidPairedGrant(actor, "entry_team") ||
    hasAnyValidPairedGrant(actor, "document_upload") ||
    hasAnyValidPairedGrant(actor, "document_view") ||
    hasActiveContextualRole(actor, "TEAM_LEADER") ||
    hasActiveContextualRole(actor, "PROJECT_MANAGER") ||
    actor.self_recruiter_suggestion !== null ||
    (Array.isArray(actor.allowed_worker_tabs) && actor.allowed_worker_tabs.length > 0);

  if (!hasReviewOrCreateCapability) {
    return { ok: false, response: fail("CCCD_REVIEW_DENIED", 403) };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
  };
}

export async function getDirectEntryCccdReviewQueue(
  request: Request,
  flag: string | undefined,
  dependencies: CccdReviewApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsedQuery: ReturnType<typeof parseCccdReviewListQuery>;
  try {
    const url = new URL(request.url);
    parsedQuery = parseCccdReviewListQuery(url.searchParams);
  } catch {
    return fail("CCCD_REVIEW_REQUEST_INVALID", 400);
  }
  if (!parsedQuery.ok) {
    return fail(parsedQuery.code, 400);
  }

  try {
    const actor = await resolveReviewActor(dependencies);
    if (!actor.ok) return actor.response;

    const result = await dependencies.reviewRepository.listReviewQueue({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      status_filter: parsedQuery.value.status_filter,
      limit: parsedQuery.value.limit,
      offset: parsedQuery.value.offset,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("CCCD_REVIEW_DENIED", 403);
      return mapReviewFailure(result.kind);
    }

    return json(
      {
        ok: true,
        ...result.data,
      },
      200,
    );
  } catch {
    console.error("[direct-entry] cccd review queue read failed");
    return fail("CCCD_REVIEW_UNAVAILABLE", 500);
  }
}

export async function postDirectEntryCccdReviewResolution(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: CccdReviewApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!isValidReviewEntryId(entryId)) return fail("ENTRY_ID_INVALID", 400);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return fail("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readJsonBody(request);
  if (!body) return fail("CCCD_REVIEW_REQUEST_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok) {
    return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = parseCccdReviewResolveRequest(body);
  if (!parsed.ok) return fail(parsed.code, 400);

  try {
    const actor = await resolveReviewActor(dependencies);
    if (!actor.ok) return actor.response;

    const resolved = await dependencies.reviewRepository.resolveReview({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId.trim(),
      request: parsed.value,
      idempotency_key: idempotencyKey,
    });
    if (!resolved.ok) return mapReviewFailure(resolved.kind, resolved.error_code);

    return json(
      {
        ok: true,
        entry_id: resolved.data.entry_id,
        entry_version: resolved.data.entry_version,
        reused: resolved.data.reused,
        action: resolved.data.action,
        changed_fields: resolved.data.changed_fields,
        reconciliation: resolved.data.reconciliation,
      },
      200,
    );
  } catch {
    console.error("[direct-entry] cccd review resolution failed");
    return fail("CCCD_REVIEW_UNAVAILABLE", 500);
  }
}

export async function getDirectEntryMissingDocumentWorkers(
  request: Request,
  flag: string | undefined,
  dependencies: CccdReviewApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsedQuery: ReturnType<typeof parseMissingDocumentWorkersQuery>;
  try {
    const url = new URL(request.url);
    parsedQuery = parseMissingDocumentWorkersQuery(url.searchParams);
  } catch {
    return fail("MISSING_DOCUMENTS_REQUEST_INVALID", 400);
  }
  if (!parsedQuery.ok) {
    return fail(parsedQuery.code, 400);
  }

  try {
    const actor = await resolveReviewActor(dependencies);
    if (!actor.ok) return actor.response;

    if (typeof dependencies.reviewRepository.listMissingDocumentWorkers !== "function") {
      return fail("CCCD_REVIEW_UNAVAILABLE", 500);
    }

    const result = await dependencies.reviewRepository.listMissingDocumentWorkers({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      missing_type: parsedQuery.value.missing_type,
      employment_status: parsedQuery.value.employment_status,
      project_id: parsedQuery.value.project_id,
      search: parsedQuery.value.search,
      page: parsedQuery.value.page,
      page_size: parsedQuery.value.page_size,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("MISSING_DOCUMENTS_DENIED", 403);
      return mapReviewFailure(result.kind, "MISSING_DOCUMENTS_REQUEST_INVALID");
    }

    return json(
      {
        ok: true,
        ...result.data,
      },
      200,
    );
  } catch {
    console.error("[direct-entry] missing document workers read failed");
    return fail("CCCD_REVIEW_UNAVAILABLE", 500);
  }
}
