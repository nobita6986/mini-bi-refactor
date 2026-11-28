import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  buildSalaryAdvanceEvidenceStorageKey,
  inspectSalaryAdvanceEvidenceContent,
  type SalaryAdvanceEvidenceStorage,
} from "./r2-salary-advance-evidence-storage.ts";
import {
  MAX_SALARY_ADVANCE_EXPORT_ROWS,
  SALARY_ADVANCE_EXPORT_PAGE_SIZE,
  computeCreateRequestFingerprint,
  computeFinalizeEvidenceFingerprint,
  computePostMessageFingerprint,
  computeReserveEvidenceFingerprint,
  computeReviewEvidenceFingerprint,
  computeTransitionRequestFingerprint,
  parseCreateSalaryAdvanceRequestBody,
  parseEvidenceVersionParam,
  parseExportSalaryAdvanceRequestsQuery,
  parseFinalizeSalaryAdvanceEvidenceBody,
  parseListProjectWorkersQuery,
  parseListSalaryAdvanceRequestsQuery,
  parseListWorkerHistoryQuery,
  parseNoQueryParams,
  parsePostSalaryAdvanceMessageBody,
  parseProjectIdParam,
  parseReserveSalaryAdvanceEvidenceBody,
  parseReviewSalaryAdvanceEvidenceBody,
  parseTransitionSalaryAdvanceRequestBody,
  parseUuidParam,
  parseWorkerPortraitQuery,
  salaryAdvanceHttpStatusForError,
  type SalaryAdvanceErrorCode,
  type SalaryAdvanceEvidenceReserveResponse,
  type SalaryAdvanceEvidenceReviewState,
  type SalaryAdvanceQueue,
  type SalaryAdvanceRequestListResponse,
  type SalaryAdvanceRequestState,
  type SalaryAdvanceRequestSummary,
  type SalaryAdvanceWorkerOption,
} from "./salary-advance-contract.ts";
import {
  SALARY_ADVANCE_EXPORT_XLSX_CONTENT_TYPE,
  buildSalaryAdvanceExportFilename,
  buildSalaryAdvanceExportXlsx,
} from "./salary-advance-export.ts";
import type { SalaryAdvanceRepository } from "./salary-advance-repository.ts";
import {
  countActionableRequestsForTab,
  type SalaryAdvanceWorkspaceTabId,
} from "./salary-advance-ui-model.ts";

export const MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
  "x-authority-source",
  "x-department-id",
  "x-department-key",
] as const;

export type SalaryAdvanceApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: SalaryAdvanceRepository;
  storage?: SalaryAdvanceEvidenceStorage;
};

function salAdvError(code: SalaryAdvanceErrorCode): Response {
  return failJson(code, salaryAdvanceHttpStatusForError(code));
}

function salAdvOk<T>(data: T, status = 200): Response {
  return noStoreJson({ ok: true, data }, status);
}

function directEntryFeatureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : failJson("NOT_FOUND", 404);
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

function parseRequestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

async function resolveSalaryAdvanceActor(
  dependencies: SalaryAdvanceApiDependencies,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await dependencies.resolveSession();
  } catch {
    console.error("[salary-advance] session resolution failed");
    return { ok: false, response: salAdvError("SALARY_ADVANCE_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? salAdvError("UNAUTHENTICATED")
          : salAdvError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    actor.partner_account !== undefined ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: salAdvError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
  };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; code: "INVALID_JSON" | "REQUEST_BODY_TOO_LARGE" }
> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, code: "INVALID_JSON" };
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, code: "INVALID_JSON" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, code: "INVALID_JSON" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, code: "REQUEST_BODY_TOO_LARGE" };
    }
  }

  if (!request.body) {
    return { ok: false, code: "INVALID_JSON" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        return { ok: false, code: "REQUEST_BODY_TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, code: "INVALID_JSON" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
}

async function safeDeleteStagedObject(
  storage: SalaryAdvanceEvidenceStorage,
  storageKey: string,
): Promise<boolean> {
  try {
    await storage.deleteStaged(storageKey);
    return true;
  } catch {
    console.error("[salary-advance] staged evidence cleanup failed");
    return false;
  }
}

function inlineBinaryImageResponse(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png",
): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export const SERVER_BADGE_COUNT_PAGE_SIZE = 100;
export const MAX_SERVER_BADGE_SLICE_PAGES = 10;

export type ServerQueueBadgeCountResult = {
  count: number;
  capped: boolean;
};

type BadgeScanSlice = {
  request_state: SalaryAdvanceRequestState | null;
  evidence_review_state: SalaryAdvanceEvidenceReviewState | null;
};

function tabIdForQueue(
  queue: Extract<SalaryAdvanceQueue, "PM" | "ACCOUNTANT" | "SUPERVISORY">,
): SalaryAdvanceWorkspaceTabId {
  if (queue === "PM") return "pm";
  if (queue === "ACCOUNTANT") return "accountant";
  return "supervisory";
}

function resolveBadgeScanSlicesForQueue(
  queue: Extract<SalaryAdvanceQueue, "PM" | "ACCOUNTANT" | "SUPERVISORY">,
): ReadonlyArray<BadgeScanSlice> {
  if (queue === "PM") {
    return [
      { request_state: "OPEN", evidence_review_state: null },
      { request_state: "NEEDS_INFO", evidence_review_state: null },
    ];
  }
  if (queue === "ACCOUNTANT") {
    return [
      { request_state: "OPEN", evidence_review_state: null },
      { request_state: null, evidence_review_state: "PENDING_REVIEW" },
    ];
  }
  return [
    { request_state: "OPEN", evidence_review_state: null },
    { request_state: "NEEDS_INFO", evidence_review_state: null },
    { request_state: null, evidence_review_state: "PENDING_REVIEW" },
  ];
}

export async function computeServerQueueBadgeCount(params: {
  repository: SalaryAdvanceRepository;
  auth_subject: string;
  app_user_id: string;
  queue: Extract<SalaryAdvanceQueue, "PM" | "ACCOUNTANT" | "SUPERVISORY">;
  initialUnfilteredFirstPage?: SalaryAdvanceRequestListResponse | null;
  pageSize?: number;
  maxPagesPerSlice?: number;
}): Promise<ServerQueueBadgeCountResult | null> {
  const tabId = tabIdForQueue(params.queue);
  const effectivePageSize =
    params.pageSize !== undefined &&
    Number.isSafeInteger(params.pageSize) &&
    params.pageSize >= 1 &&
    params.pageSize <= 100
      ? params.pageSize
      : SERVER_BADGE_COUNT_PAGE_SIZE;
  const maxPagesPerSlice =
    params.maxPagesPerSlice !== undefined &&
    Number.isSafeInteger(params.maxPagesPerSlice) &&
    params.maxPagesPerSlice >= 1
      ? params.maxPagesPerSlice
      : MAX_SERVER_BADGE_SLICE_PAGES;

  if (
    params.initialUnfilteredFirstPage &&
    !params.initialUnfilteredFirstPage.has_more
  ) {
    return {
      count: countActionableRequestsForTab(
        params.initialUnfilteredFirstPage.requests,
        tabId,
      ),
      capped: false,
    };
  }

  const slices = resolveBadgeScanSlicesForQueue(params.queue);
  const sliceResults = await Promise.all(
    slices.map(async (slice) => {
      const rows: SalaryAdvanceRequestSummary[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let capped = false;
      let anyPageOk = false;

      for (let pageIdx = 0; pageIdx < maxPagesPerSlice; pageIdx += 1) {
        const pageResult = await params.repository.listRequests({
          auth_subject: params.auth_subject,
          app_user_id: params.app_user_id,
          queue: params.queue,
          project_id: null,
          request_state: slice.request_state,
          evidence_review_state: slice.evidence_review_state,
          search: null,
          cursor,
          page_size: effectivePageSize,
        });
        if (!pageResult.ok) {
          if (anyPageOk) {
            capped = true;
          }
          break;
        }

        anyPageOk = true;
        const page = pageResult.data;
        rows.push(...page.requests);

        if (!page.has_more) {
          return { rows, capped: false, anyPageOk: true };
        }

        if (
          pageIdx + 1 >= maxPagesPerSlice ||
          page.requests.length === 0 ||
          !page.next_cursor ||
          seenCursors.has(page.next_cursor)
        ) {
          capped = true;
          break;
        }

        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }

      return { rows, capped, anyPageOk };
    }),
  );

  const anySliceSucceeded = sliceResults.some((res) => res.anyPageOk);
  if (!anySliceSucceeded && !params.initialUnfilteredFirstPage) {
    return null;
  }

  const allRows: SalaryAdvanceRequestSummary[] = [];
  const seenRequestIds = new Set<string>();

  if (params.initialUnfilteredFirstPage) {
    for (const row of params.initialUnfilteredFirstPage.requests) {
      if (!seenRequestIds.has(row.request_id)) {
        seenRequestIds.add(row.request_id);
        allRows.push(row);
      }
    }
  }

  for (const sliceResult of sliceResults) {
    for (const row of sliceResult.rows) {
      if (!seenRequestIds.has(row.request_id)) {
        seenRequestIds.add(row.request_id);
        allRows.push(row);
      }
    }
  }

  const capped =
    !anySliceSucceeded ||
    sliceResults.some((res) => res.capped || !res.anyPageOk);

  return {
    count: countActionableRequestsForTab(allRows, tabId),
    capped,
  };
}

// -----------------------------------------------------------------------------
// 1. GET /api/salary-advance/context
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceContext(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.getActorContext({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
  });
  if (!result.ok) return salAdvError(result.code);

  const badgeCounts: Partial<Record<SalaryAdvanceWorkspaceTabId, number>> = {};
  const badgeCountsCapped: Partial<
    Record<SalaryAdvanceWorkspaceTabId, boolean>
  > = {};

  const [pmBadge, accountantBadge, supervisoryBadge] = await Promise.all([
    result.data.is_project_manager && result.data.managed_projects.length > 0
      ? computeServerQueueBadgeCount({
          repository: dependencies.repository,
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          queue: "PM",
        })
      : Promise.resolve(null),
    result.data.is_project_accountant &&
    result.data.accountant_projects.length > 0
      ? computeServerQueueBadgeCount({
          repository: dependencies.repository,
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          queue: "ACCOUNTANT",
        })
      : Promise.resolve(null),
    result.data.is_supervisory_viewer
      ? computeServerQueueBadgeCount({
          repository: dependencies.repository,
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          queue: "SUPERVISORY",
        })
      : Promise.resolve(null),
  ]);

  if (pmBadge !== null) {
    badgeCounts.pm = pmBadge.count;
    if (pmBadge.capped) {
      badgeCountsCapped.pm = true;
    }
  }
  if (accountantBadge !== null) {
    badgeCounts.accountant = accountantBadge.count;
    if (accountantBadge.capped) {
      badgeCountsCapped.accountant = true;
    }
  }
  if (supervisoryBadge !== null) {
    badgeCounts.supervisory = supervisoryBadge.count;
    if (supervisoryBadge.capped) {
      badgeCountsCapped.supervisory = true;
    }
  }

  const hasBadgeCounts = Object.keys(badgeCounts).length > 0;
  const hasCappedFlags = Object.keys(badgeCountsCapped).length > 0;

  return salAdvOk(
    {
      ...result.data,
      ...(hasBadgeCounts ? { badge_counts: badgeCounts } : {}),
      ...(hasCappedFlags ? { badge_counts_capped: badgeCountsCapped } : {}),
    },
    200,
  );
}

function isOffProjectWorkerOption(worker: SalaryAdvanceWorkerOption): boolean {
  if (worker.employment_status === "OFF") {
    return true;
  }
  if (worker.provider_type === "vendor") {
    return true;
  }
  if (
    Array.isArray(worker.ineligible_reasons) &&
    (worker.ineligible_reasons.includes("WORKER_STATUS_OFF") ||
      worker.ineligible_reasons.includes("WORKER_VENDOR_RECRUITED"))
  ) {
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// 2. GET /api/salary-advance/projects/[projectId]/workers
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceProjectWorkers(
  request: Request,
  projectId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const parsedProjectId = parseProjectIdParam(projectId);
  if (!parsedProjectId.ok) return salAdvError(parsedProjectId.code);

  const query = parseListProjectWorkersQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const targetPageSize = query.value.page_size;
  const collected: SalaryAdvanceWorkerOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = query.value.cursor;
  let lastHasMore = false;
  let lastNextCursor: string | null = null;
  let iterations = 0;

  while (iterations < 25) {
    iterations += 1;
    const result = await dependencies.repository.listProjectWorkers({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      project_id: parsedProjectId.project_id,
      search: query.value.search,
      cursor,
      page_size: targetPageSize,
    });
    if (!result.ok) return salAdvError(result.code);

    const visibleInPage = result.data.workers.filter(
      (worker) => !isOffProjectWorkerOption(worker),
    );
    collected.push(...visibleInPage);
    lastHasMore = result.data.has_more;
    lastNextCursor = result.data.next_cursor;

    if (
      collected.length >= targetPageSize ||
      !lastHasMore ||
      !lastNextCursor ||
      result.data.workers.length === 0 ||
      seenCursors.has(lastNextCursor)
    ) {
      break;
    }

    seenCursors.add(lastNextCursor);
    cursor = lastNextCursor;
  }

  if (collected.length > targetPageSize) {
    const trimmed = collected.slice(0, targetPageSize);
    const lastIncluded = trimmed[trimmed.length - 1];
    return salAdvOk(
      {
        project_id: parsedProjectId.project_id,
        workers: trimmed,
        has_more: true,
        next_cursor: `${lastIncluded.employee_code}|${lastIncluded.worker_entry_id}`,
      },
      200,
    );
  }

  return salAdvOk(
    {
      project_id: parsedProjectId.project_id,
      workers: collected,
      has_more: lastHasMore,
      next_cursor: lastHasMore ? lastNextCursor : null,
    },
    200,
  );
}

// -----------------------------------------------------------------------------
// 3. GET /api/salary-advance/requests
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceRequests(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const query = parseListSalaryAdvanceRequestsQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.listRequests({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    queue: query.value.queue,
    project_id: query.value.project_id,
    request_state: query.value.request_state,
    evidence_review_state: query.value.evidence_review_state,
    search: query.value.search,
    cursor: query.value.cursor,
    page_size: query.value.page_size,
  });
  if (!result.ok) return salAdvError(result.code);

  const isUnfilteredFirstPage =
    query.value.project_id === null &&
    query.value.request_state === null &&
    query.value.evidence_review_state === null &&
    query.value.search === null &&
    query.value.cursor === null;

  const shouldComputeBadge =
    (query.value.queue === "PM" ||
      query.value.queue === "ACCOUNTANT" ||
      query.value.queue === "SUPERVISORY") &&
    (isUnfilteredFirstPage || query.value.include_badge);

  let badgeResult: ServerQueueBadgeCountResult | null = null;
  if (
    shouldComputeBadge &&
    (query.value.queue === "PM" ||
      query.value.queue === "ACCOUNTANT" ||
      query.value.queue === "SUPERVISORY")
  ) {
    badgeResult = await computeServerQueueBadgeCount({
      repository: dependencies.repository,
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      queue: query.value.queue,
      initialUnfilteredFirstPage: isUnfilteredFirstPage ? result.data : null,
    });
  }

  return salAdvOk(
    badgeResult !== null
      ? {
          ...result.data,
          badge_count: badgeResult.count,
          ...(badgeResult.capped ? { badge_count_capped: true } : {}),
        }
      : result.data,
    200,
  );
}

// -----------------------------------------------------------------------------
// 4. POST /api/salary-advance/requests
// -----------------------------------------------------------------------------
export async function handlePostCreateSalaryAdvanceRequest(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parseCreateSalaryAdvanceRequestBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  const fingerprint = computeCreateRequestFingerprint({
    project_id: parsedBody.value.project_id,
    worker_entry_id: parsedBody.value.worker_entry_id,
    requested_amount_vnd: parsedBody.value.requested_amount_vnd,
    payment_method: parsedBody.value.payment_method,
    initial_content: parsedBody.value.initial_content,
  });

  const created = await dependencies.repository.createRequest({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    worker_entry_id: parsedBody.value.worker_entry_id,
    requested_amount_vnd: parsedBody.value.requested_amount_vnd,
    payment_method: parsedBody.value.payment_method,
    initial_content: parsedBody.value.initial_content,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!created.ok) return salAdvError(created.code);

  return salAdvOk(created.data, created.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 5. GET /api/salary-advance/requests/[requestId]
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceRequestDetail(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.getRequestDetail({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
  });
  if (!result.ok) return salAdvError(result.code);

  return salAdvOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 6. POST /api/salary-advance/requests/[requestId]/messages
// -----------------------------------------------------------------------------
export async function handlePostSalaryAdvanceMessage(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parsePostSalaryAdvanceMessageBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  const fingerprint = computePostMessageFingerprint({
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    message_text: parsedBody.value.message_text,
  });

  const saved = await dependencies.repository.postMessage({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    message_text: parsedBody.value.message_text,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return salAdvError(saved.code);

  return salAdvOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 7. POST /api/salary-advance/requests/[requestId]/actions
// -----------------------------------------------------------------------------
export async function handlePostSalaryAdvanceAction(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parseTransitionSalaryAdvanceRequestBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  const fingerprint = computeTransitionRequestFingerprint({
    request_id: parsedRequestId.id,
    action: parsedBody.value.action,
    expected_version: parsedBody.value.expected_version,
    message_text: parsedBody.value.message_text,
  });

  const transitioned = await dependencies.repository.transitionRequest({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    action: parsedBody.value.action,
    expected_version: parsedBody.value.expected_version,
    message_text: parsedBody.value.message_text,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!transitioned.ok) return salAdvError(transitioned.code);

  return salAdvOk(transitioned.data, 200);
}

// -----------------------------------------------------------------------------
// 8. POST /api/salary-advance/requests/[requestId]/evidence/reserve
// -----------------------------------------------------------------------------
export async function handlePostReserveSalaryAdvanceEvidence(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parseReserveSalaryAdvanceEvidenceBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  if (!dependencies.storage || !dependencies.storage.available()) {
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const fingerprint = computeReserveEvidenceFingerprint({
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    mime_type: parsedBody.value.mime_type,
    size_bytes: parsedBody.value.size_bytes,
    checksum_sha256: parsedBody.value.checksum_sha256,
    caption_note: parsedBody.value.caption_note,
  });

  const reserved = await dependencies.repository.reserveEvidence({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    mime_type: parsedBody.value.mime_type,
    size_bytes: parsedBody.value.size_bytes,
    checksum_sha256: parsedBody.value.checksum_sha256,
    caption_note: parsedBody.value.caption_note,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!reserved.ok) return salAdvError(reserved.code);

  // Best-effort cleanup of any superseded staged reservation object only.
  // Committed final objects are never touched.
  if (
    reserved.data.superseded_storage_key &&
    reserved.data.superseded_storage_key !== reserved.data.storage_key
  ) {
    await safeDeleteStagedObject(
      dependencies.storage,
      reserved.data.superseded_storage_key,
    );
  }

  let signedUpload: {
    url: string;
    expires_at: string;
    headers: Record<string, string>;
  };
  try {
    signedUpload = await dependencies.storage.createUploadUrl({
      storage_key: reserved.data.storage_key,
      mime_type: reserved.data.mime_type,
      size_bytes: reserved.data.size_bytes,
    });
  } catch {
    console.error("[salary-advance] evidence upload presign failed");
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const responsePayload: SalaryAdvanceEvidenceReserveResponse = {
    request_id: reserved.data.request_id,
    upload_id: reserved.data.upload_id,
    expected_version: reserved.data.expected_version,
    mime_type: reserved.data.mime_type,
    size_bytes: reserved.data.size_bytes,
    checksum_sha256: reserved.data.checksum_sha256,
    expires_at: reserved.data.expires_at,
    upload: {
      method: "PUT",
      url: signedUpload.url,
      expires_at: signedUpload.expires_at,
      headers: signedUpload.headers,
    },
    replayed: reserved.data.replayed,
  };

  return salAdvOk(responsePayload, reserved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 9. POST /api/salary-advance/requests/[requestId]/evidence/[uploadId]/finalize
// -----------------------------------------------------------------------------
const STAGED_CONFLICT_CLEANUP_CODES: ReadonlySet<SalaryAdvanceErrorCode> =
  new Set([
    "SALARY_ADVANCE_VERSION_CONFLICT",
    "SALARY_ADVANCE_UPLOAD_SUPERSEDED",
    "SALARY_ADVANCE_UPLOAD_EXPIRED",
    "SALARY_ADVANCE_STATE_CONFLICT",
  ]);

export async function handlePostFinalizeSalaryAdvanceEvidence(
  request: Request,
  requestId: string,
  uploadId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const parsedUploadId = parseUuidParam(
    uploadId,
    "SALARY_ADVANCE_UPLOAD_ID_INVALID",
  );
  if (!parsedUploadId.ok) return salAdvError(parsedUploadId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parseFinalizeSalaryAdvanceEvidenceBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  if (!dependencies.storage || !dependencies.storage.available()) {
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const candidateStorageKey = buildSalaryAdvanceEvidenceStorageKey(
    parsedRequestId.id,
    parsedUploadId.id,
  );

  const fingerprint = computeFinalizeEvidenceFingerprint({
    request_id: parsedRequestId.id,
    upload_id: parsedUploadId.id,
    expected_version: parsedBody.value.expected_version,
  });

  const finalizeCtx =
    await dependencies.repository.getEvidenceFinalizeContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      request_id: parsedRequestId.id,
      upload_id: parsedUploadId.id,
      expected_version: parsedBody.value.expected_version,
      idempotency_key: parsedBody.value.idempotency_key,
      request_fingerprint: fingerprint,
    });

  if (!finalizeCtx.ok) {
    // If this upload attempt lost an OCC race, was superseded by a newer reserve,
    // or expired, clean up ONLY this losing attempt's staged object in R2.
    // Committed final objects in `final/` are never touched.
    if (STAGED_CONFLICT_CLEANUP_CODES.has(finalizeCtx.code)) {
      await safeDeleteStagedObject(dependencies.storage, candidateStorageKey);
    }
    return salAdvError(finalizeCtx.code);
  }

  if (finalizeCtx.data.status === "REPLAYED") {
    await safeDeleteStagedObject(dependencies.storage, candidateStorageKey);
    return salAdvOk(finalizeCtx.data.result_payload, 200);
  }

  const readyInfo = finalizeCtx.data;

  let stagedRead: Awaited<
    ReturnType<SalaryAdvanceEvidenceStorage["readStagedBounded"]>
  >;
  try {
    stagedRead = await dependencies.storage.readStagedBounded(
      readyInfo.storage_key,
    );
  } catch {
    console.error("[salary-advance] staged evidence read failed");
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  if (stagedRead.kind === "missing") {
    return salAdvError("SALARY_ADVANCE_EVIDENCE_UPLOAD_MISSING");
  }

  if (stagedRead.kind === "too-large") {
    await safeDeleteStagedObject(dependencies.storage, readyInfo.storage_key);
    return salAdvError("SALARY_ADVANCE_EVIDENCE_SIZE_INVALID");
  }

  const inspection = inspectSalaryAdvanceEvidenceContent({
    mime_type: readyInfo.mime_type,
    expected_size_bytes: readyInfo.size_bytes,
    expected_checksum_sha256: readyInfo.checksum_sha256,
    bytes: stagedRead.bytes,
  });

  if (!inspection.ok) {
    await safeDeleteStagedObject(dependencies.storage, readyInfo.storage_key);
    return salAdvError(inspection.code);
  }

  try {
    await dependencies.storage.promoteStagedToFinal({
      storage_key: readyInfo.storage_key,
      mime_type: readyInfo.mime_type,
    });
  } catch {
    console.error("[salary-advance] staged evidence promotion failed");
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const finalized = await dependencies.repository.finalizeEvidence({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    upload_id: parsedUploadId.id,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });

  // Always clean up this attempt's staged object (whether finalized or rejected
  // due to a concurrent race between pre-check and commit). Never delete final objects.
  await safeDeleteStagedObject(dependencies.storage, readyInfo.storage_key);

  if (!finalized.ok) {
    return salAdvError(finalized.code);
  }

  return salAdvOk(finalized.data, 200);
}

// -----------------------------------------------------------------------------
// 10. POST /api/salary-advance/requests/[requestId]/evidence/review
// -----------------------------------------------------------------------------
export async function handlePostReviewSalaryAdvanceEvidence(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return salAdvError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_SALARY_ADVANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return salAdvError(boundedBody.code);

  const parsedBody = parseReviewSalaryAdvanceEvidenceBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return salAdvError(parsedBody.code);

  const fingerprint = computeReviewEvidenceFingerprint({
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    evidence_version: parsedBody.value.evidence_version,
    decision: parsedBody.value.decision,
    expected_worker_portrait_document_id:
      parsedBody.value.expected_worker_portrait_document_id,
    expected_worker_portrait_version:
      parsedBody.value.expected_worker_portrait_version,
    note: parsedBody.value.note,
  });

  const reviewed = await dependencies.repository.reviewEvidence({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    expected_version: parsedBody.value.expected_version,
    evidence_version: parsedBody.value.evidence_version,
    decision: parsedBody.value.decision,
    expected_worker_portrait_document_id:
      parsedBody.value.expected_worker_portrait_document_id,
    expected_worker_portrait_version:
      parsedBody.value.expected_worker_portrait_version,
    note: parsedBody.value.note,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!reviewed.ok) return salAdvError(reviewed.code);

  return salAdvOk(reviewed.data, 200);
}

// -----------------------------------------------------------------------------
// 11. GET /api/salary-advance/requests/[requestId]/evidence/[version]/preview
// -----------------------------------------------------------------------------
export async function handleGetPreviewSalaryAdvanceEvidence(
  request: Request,
  requestId: string,
  versionParam: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return salAdvError("SALARY_ADVANCE_QUERY_INVALID");
  }

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const parsedVersion = parseEvidenceVersionParam(versionParam);
  if (!parsedVersion.ok) return salAdvError(parsedVersion.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  if (!dependencies.storage || !dependencies.storage.available()) {
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const contextResult =
    await dependencies.repository.getEvidencePreviewContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      request_id: parsedRequestId.id,
      evidence_version: parsedVersion.version,
    });
  if (!contextResult.ok) return salAdvError(contextResult.code);

  const previewMeta = contextResult.data;

  try {
    const finalRead = await dependencies.storage.readFinalBounded(
      previewMeta.storage_key,
    );
    if (finalRead.kind !== "found") {
      console.error("[salary-advance] evidence object missing or oversized");
      return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }

    const inspection = inspectSalaryAdvanceEvidenceContent({
      mime_type: previewMeta.mime_type,
      expected_size_bytes: previewMeta.size_bytes,
      expected_checksum_sha256: previewMeta.checksum_sha256,
      bytes: finalRead.bytes,
    });
    if (!inspection.ok) {
      console.error("[salary-advance] evidence object integrity check failed");
      return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }

    return inlineBinaryImageResponse(finalRead.bytes, previewMeta.mime_type);
  } catch {
    console.error("[salary-advance] evidence preview failed");
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 12. GET /api/salary-advance/requests/[requestId]/worker-portrait
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceWorkerPortrait(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const query = parseWorkerPortraitQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  if (!dependencies.storage || !dependencies.storage.available()) {
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }

  const portraitCtx = await dependencies.repository.getWorkerPortraitContext({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    expected_document_id: query.value.expected_document_id,
  });
  if (!portraitCtx.ok) return salAdvError(portraitCtx.code);

  const portraitMeta = portraitCtx.data;

  try {
    const finalRead = await dependencies.storage.readWorkerPortraitFinalBounded(
      portraitMeta.storage_key,
    );
    if (finalRead.kind !== "found") {
      console.error("[salary-advance] worker portrait object missing or oversized");
      return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }

    const inspection = inspectSalaryAdvanceEvidenceContent({
      mime_type: portraitMeta.mime_type,
      expected_size_bytes: portraitMeta.size_bytes,
      expected_checksum_sha256: portraitMeta.checksum_sha256,
      bytes: finalRead.bytes,
    });
    if (!inspection.ok) {
      console.error("[salary-advance] worker portrait integrity check failed");
      return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
    }

    return inlineBinaryImageResponse(finalRead.bytes, portraitMeta.mime_type);
  } catch {
    console.error("[salary-advance] worker portrait preview failed");
    return salAdvError("SALARY_ADVANCE_STORAGE_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 13. GET /api/salary-advance/requests/export
// -----------------------------------------------------------------------------
export async function handleGetExportSalaryAdvanceRequests(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
  options?: {
    maxExportRows?: number;
    pageSize?: number;
  },
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const query = parseExportSalaryAdvanceRequestsQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const maxExportRows =
    options?.maxExportRows !== undefined &&
    Number.isSafeInteger(options.maxExportRows) &&
    options.maxExportRows >= 1
      ? options.maxExportRows
      : MAX_SALARY_ADVANCE_EXPORT_ROWS;
  const pageSize =
    options?.pageSize !== undefined &&
    Number.isSafeInteger(options.pageSize) &&
    options.pageSize >= 1 &&
    options.pageSize <= 100
      ? options.pageSize
      : SALARY_ADVANCE_EXPORT_PAGE_SIZE;

  const allRows: SalaryAdvanceRequestSummary[] = [];
  const seenRequestIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const result = await dependencies.repository.listRequests({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      queue: "ACCOUNTANT",
      project_id: query.value.project_id,
      request_state: query.value.request_state,
      evidence_review_state: query.value.evidence_review_state,
      search: query.value.search,
      cursor,
      page_size: pageSize,
    });
    if (!result.ok) return salAdvError(result.code);

    const page = result.data;
    for (const row of page.requests) {
      if (!seenRequestIds.has(row.request_id)) {
        seenRequestIds.add(row.request_id);
        allRows.push(row);
      }
    }

    if (allRows.length > maxExportRows) {
      return salAdvError("SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED");
    }

    if (!page.has_more) {
      break;
    }

    if (
      page.requests.length === 0 ||
      !page.next_cursor ||
      seenCursors.has(page.next_cursor)
    ) {
      console.error("[salary-advance] export pagination terminated incompletely");
      return salAdvError("SALARY_ADVANCE_EXPORT_INCOMPLETE");
    }

    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }

  try {
    const xlsxBytes = await buildSalaryAdvanceExportXlsx(allRows);
    const filename = buildSalaryAdvanceExportFilename();
    return new Response(Buffer.from(xlsxBytes), {
      status: 200,
      headers: {
        "Content-Type": SALARY_ADVANCE_EXPORT_XLSX_CONTENT_TYPE,
        "Content-Length": String(xlsxBytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    console.error("[salary-advance] excel export generation failed");
    return salAdvError("SALARY_ADVANCE_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 14. GET /api/salary-advance/requests/[requestId]/worker-history
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceWorkerHistory(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const parsedRequestId = parseUuidParam(
    requestId,
    "SALARY_ADVANCE_REQUEST_INVALID",
  );
  if (!parsedRequestId.ok) return salAdvError(parsedRequestId.code);

  const query = parseListWorkerHistoryQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.listWorkerHistory({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: parsedRequestId.id,
    period_mode: query.value.period_mode,
    month: query.value.month,
    from_date: query.value.from_date,
    to_date: query.value.to_date,
    cursor: query.value.cursor,
    page_size: query.value.page_size,
  });
  if (!result.ok) return salAdvError(result.code);

  return salAdvOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 15. GET /api/salary-advance/projects/[projectId]/workers/[workerEntryId]/worker-history
// -----------------------------------------------------------------------------
export async function handleGetSalaryAdvanceProjectWorkerHistory(
  request: Request,
  projectId: string,
  workerEntryId: string,
  enabledFlag: string | undefined,
  dependencies: SalaryAdvanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return salAdvError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return salAdvError("SALARY_ADVANCE_QUERY_INVALID");

  const parsedProjectId = parseProjectIdParam(projectId);
  if (!parsedProjectId.ok) return salAdvError(parsedProjectId.code);

  const parsedWorkerEntryId = parseUuidParam(
    workerEntryId,
    "SALARY_ADVANCE_WORKER_INVALID",
  );
  if (!parsedWorkerEntryId.ok) return salAdvError(parsedWorkerEntryId.code);

  const query = parseListWorkerHistoryQuery(url);
  if (!query.ok) return salAdvError(query.code);

  const actor = await resolveSalaryAdvanceActor(dependencies);
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.listProjectWorkerHistory({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedProjectId.project_id,
    worker_entry_id: parsedWorkerEntryId.id,
    period_mode: query.value.period_mode,
    month: query.value.month,
    from_date: query.value.from_date,
    to_date: query.value.to_date,
    cursor: query.value.cursor,
    page_size: query.value.page_size,
  });
  if (!result.ok) return salAdvError(result.code);

  return salAdvOk(result.data, 200);
}
