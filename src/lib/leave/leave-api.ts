import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  LEAVE_REPORT_EXPORT_PAGE_SIZE,
  MAX_LEAVE_REPORT_EXPORT_ROWS,
  isValidUuid,
  leaveHttpStatusForError,
  parseApplyOpeningBatchBody,
  parseCreateLeaveRequestBody,
  parseDecideLeaveRequestBody,
  parseGetAdminOverviewQuery,
  parseListApprovalInboxQuery,
  parseMonthlyReportQuery,
  parseMyLeaveSummaryQuery,
  parsePatchAdminConfigBody,
  parsePreviewOpeningBatchBody,
  parseWithdrawLeaveRequestBody,
  type LeaveErrorCode,
} from "./leave-contract.ts";
import {
  LEAVE_EXPORT_XLSX_CONTENT_TYPE,
  buildLeaveMonthlyReportXlsx,
  leaveMonthlyReportFilename,
} from "./leave-export.ts";
import type { LeaveRepository } from "./leave-repository.ts";

export const MAX_LEAVE_MUTATION_JSON_BYTES = 8_192;
export const MAX_LEAVE_OPENING_BATCH_JSON_BYTES = 65_536;

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
  "x-approver-id",
] as const;

export type LeaveApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: LeaveRepository;
};

function leaveError(code: LeaveErrorCode): Response {
  return failJson(code, leaveHttpStatusForError(code));
}

function leaveOk<T>(data: T, status = 200): Response {
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

async function resolveLeaveSessionActor(
  dependencies: LeaveApiDependencies,
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
    return { ok: false, response: leaveError("LEAVE_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? leaveError("UNAUTHENTICATED")
          : leaveError("ACTOR_NOT_AVAILABLE"),
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
    return { ok: false, response: leaveError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
  };
}

async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; response: Response }
> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared > maxBytes) {
      return { ok: false, response: leaveError("PAYLOAD_TOO_LARGE") };
    }
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return { ok: false, response: leaveError("INVALID_JSON") };
  }

  if (Buffer.byteLength(rawText, "utf8") > maxBytes) {
    return { ok: false, response: leaveError("PAYLOAD_TOO_LARGE") };
  }

  try {
    return { ok: true, value: JSON.parse(rawText) };
  } catch {
    return { ok: false, response: leaveError("INVALID_JSON") };
  }
}

export async function handleGetMyLeaveSummary(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  const url = parseRequestUrl(request);
  if (!url) return leaveError("INVALID_QUERY");
  const parsed = parseMyLeaveSummaryQuery(url);
  if (!parsed.ok) return leaveError(parsed.code);

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const outcome = await dependencies.repository.getMySummary({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    leave_year: parsed.leave_year,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handlePostCreateLeaveRequest(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_MUTATION_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = parseCreateLeaveRequestBody(bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.createRequest({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data, outcome.data.replayed === true ? 200 : 201);
}

export async function handlePostWithdrawLeaveRequest(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }
  if (!isValidUuid(requestId)) {
    return leaveError("INVALID_REQUEST");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_MUTATION_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const normalizedId = requestId.trim().toLowerCase();
  const parsed = parseWithdrawLeaveRequestBody(normalizedId, bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.withdrawRequest({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: normalizedId,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handleGetApprovalInbox(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  const url = parseRequestUrl(request);
  if (!url) return leaveError("INVALID_QUERY");
  const parsed = parseListApprovalInboxQuery(url);
  if (!parsed.ok) return leaveError(parsed.code);

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const outcome = await dependencies.repository.listApprovalInbox({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    status_filter: parsed.status_filter,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handlePostDecideLeaveRequest(
  request: Request,
  requestId: string,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }
  if (!isValidUuid(requestId)) {
    return leaveError("INVALID_REQUEST");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_MUTATION_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const normalizedId = requestId.trim().toLowerCase();
  const parsed = parseDecideLeaveRequestBody(normalizedId, bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.decideRequest({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    request_id: normalizedId,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handleGetLeaveAdminConfig(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  const url = parseRequestUrl(request);
  if (!url) return leaveError("INVALID_QUERY");
  const parsed = parseGetAdminOverviewQuery(url);
  if (!parsed.ok) return leaveError(parsed.code);

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const outcome = await dependencies.repository.getAdminOverview({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    search: parsed.search,
    limit: parsed.limit,
    offset: parsed.offset,
    account_status: parsed.account_status,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handlePatchLeaveAdminConfig(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_MUTATION_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = parsePatchAdminConfigBody(bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.patchAdminConfig({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handlePostPreviewOpeningBalances(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_OPENING_BATCH_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = parsePreviewOpeningBatchBody(bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.previewOpeningBatch({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handlePostApplyOpeningBalances(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  if (!isSameOriginAuthRequest(request)) {
    return leaveError("CSRF_ORIGIN_MISMATCH");
  }

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const bodyResult = await readBoundedJsonBody(
    request,
    MAX_LEAVE_OPENING_BATCH_JSON_BYTES,
  );
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = parseApplyOpeningBatchBody(bodyResult.value);
  if (!parsed.ok) return leaveError(parsed.code);

  const outcome = await dependencies.repository.applyOpeningBatch({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    ...parsed.data,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data, outcome.data.replayed === true ? 200 : 201);
}

export async function handleGetMonthlyLeaveReport(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  const url = parseRequestUrl(request);
  if (!url) return leaveError("INVALID_QUERY");
  const parsed = parseMonthlyReportQuery(url);
  if (!parsed.ok) return leaveError(parsed.code);

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const outcome = await dependencies.repository.getMonthlyReport({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    year_month: parsed.year_month,
    unit_kind_filter: parsed.unit_kind_filter,
    search: parsed.search,
    limit: parsed.limit,
    offset: parsed.offset,
  });
  if (!outcome.ok) return leaveError(outcome.code);
  return leaveOk(outcome.data);
}

export async function handleExportMonthlyLeaveReport(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: LeaveApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) {
    return leaveError("DISALLOWED_AUTHORITY_HEADER");
  }
  const url = parseRequestUrl(request);
  if (!url) return leaveError("INVALID_QUERY");
  const parsed = parseMonthlyReportQuery(url);
  if (!parsed.ok) return leaveError(parsed.code);

  const actor = await resolveLeaveSessionActor(dependencies);
  if (!actor.ok) return actor.response;

  const firstOutcome = await dependencies.repository.getMonthlyReport({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    year_month: parsed.year_month,
    unit_kind_filter: parsed.unit_kind_filter,
    search: parsed.search,
    limit: LEAVE_REPORT_EXPORT_PAGE_SIZE,
    offset: 0,
  });
  if (!firstOutcome.ok) return leaveError(firstOutcome.code);

  const firstPage = firstOutcome.data;
  const firstRows = Array.isArray(firstPage.rows) ? firstPage.rows : [];
  const total = Number.isFinite(Number(firstPage.total))
    ? Math.max(0, Math.trunc(Number(firstPage.total)))
    : firstRows.length;

  if (total > MAX_LEAVE_REPORT_EXPORT_ROWS) {
    return leaveError("LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED");
  }

  const allRows = [...firstRows];
  while (allRows.length < total) {
    const nextOutcome = await dependencies.repository.getMonthlyReport({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      year_month: parsed.year_month,
      unit_kind_filter: parsed.unit_kind_filter,
      search: parsed.search,
      limit: LEAVE_REPORT_EXPORT_PAGE_SIZE,
      offset: allRows.length,
    });
    if (!nextOutcome.ok) return leaveError(nextOutcome.code);

    const nextRows = Array.isArray(nextOutcome.data.rows)
      ? nextOutcome.data.rows
      : [];
    if (nextRows.length === 0) {
      return leaveError("LEAVE_REPORT_EXPORT_INCOMPLETE");
    }
    allRows.push(...nextRows);
    if (allRows.length > MAX_LEAVE_REPORT_EXPORT_ROWS) {
      return leaveError("LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED");
    }
  }

  const xlsxBytes = await buildLeaveMonthlyReportXlsx({
    ...firstPage,
    total: allRows.length,
    limit: allRows.length,
    offset: 0,
    rows: allRows,
  });
  const filename = leaveMonthlyReportFilename(parsed.year_month);

  return new Response(Buffer.from(xlsxBytes), {
    status: 200,
    headers: {
      "Content-Type": LEAVE_EXPORT_XLSX_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
