import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  vendorFinanceAdminNavPredicate,
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  inspectVfinEvidenceContent,
  type VendorFinanceEvidenceStorage,
} from "./r2-evidence-storage.ts";
import {
  computeApplyOpeningBatchFingerprint,
  computeApplySharedAdvanceOffsetFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeClassifySubLedgerFingerprint,
  computeCreateReconciliationFingerprint,
  computeEndProjectAccountantFingerprint,
  computeFundSharedAdvanceFingerprint,
  computeRecordEntryFingerprint,
  computeRecordPaymentWithOffsetFingerprint,
  computeRecordVendorRefundFingerprint,
  computeReserveEvidenceFingerprint,
  computeReverseEntryFingerprint,
  computeReverseSharedAdvanceMovementFingerprint,
  parseApplyOpeningBatchBody,
  parseApplySharedAdvanceOffsetBody,
  parseAssignProjectAccountantBody,
  parseClassifyVendorSubLedgerBody,
  parseCreateVendorReconciliationBody,
  parseEndProjectAccountantBody,
  parseExportVendorFinanceVendorsQuery,
  parseFinalizeVendorFinanceEvidenceBody,
  parseFundSharedAdvanceBody,
  parseGetVendorFinanceVendorDetailQuery,
  parseListProjectAccountantsAdminQuery,
  parseListSharedAdvanceMovementsQuery,
  parseListVendorFinanceEntriesQuery,
  parseListVendorFinanceVendorsQuery,
  parseListVendorReconciliationsQuery,
  parseMonthlyReportQuery,
  parseNoQueryParams,
  parsePreviewOpeningBatchBody,
  parseRecordPaymentWithOffsetBody,
  parseRecordVendorFinanceEntryBody,
  parseRecordVendorRefundBody,
  parseReserveVendorFinanceEvidenceBody,
  parseReverseSharedAdvanceMovementBody,
  parseReverseVendorFinanceEntryBody,
  parseUuidParam,
  parseVendorIdParam,
  vendorFinanceHttpStatusForError,
  type VendorFinanceErrorCode,
  type VendorFinanceEvidenceDownloadResponse,
  type VendorFinanceEvidenceReserveResponse,
  type VendorFinanceExportVendorItem,
  type VendorFinanceMonthlyReportResponse,
} from "./vendor-finance-contract.ts";
import type { VendorFinanceRepository } from "./vendor-finance-repository.ts";
import {
  buildVendorFinanceExportXlsx,
  buildVendorFinanceMonthlyReportExportXlsx,
  VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE,
  vendorFinanceExportFilename,
  vendorFinanceMonthlyReportExportFilename,
} from "./vendor-finance-xlsx.ts";

export const MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES = 8_192;
export const MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES = 65_536;

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

export type VendorFinanceApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: VendorFinanceRepository;
  storage?: VendorFinanceEvidenceStorage;
  buildExportXlsx?(vendors: readonly VendorFinanceExportVendorItem[]): Promise<Uint8Array>;
  buildMonthlyReportExportXlsx?(report: VendorFinanceMonthlyReportResponse): Promise<Uint8Array>;
};

function vfinError(code: VendorFinanceErrorCode): Response {
  return failJson(code, vendorFinanceHttpStatusForError(code));
}

function vfinOk<T>(data: T, status = 200): Response {
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

async function resolveVendorFinanceAuthority(
  dependencies: VendorFinanceApiDependencies,
  requiredMode:
    | "view"
    | "reconcile"
    | "record"
    | "evidence"
    | "admin"
    | "shared_advance_view"
    | "shared_advance_fund"
    | "shared_advance_refund"
    | "shared_advance_apply"
    | "shared_advance_reverse",
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
    console.error("[vendor-finance] session resolution failed");
    return { ok: false, response: vfinError("VENDOR_FINANCE_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? vfinError("UNAUTHENTICATED")
          : vfinError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: vfinError("ACTOR_NOT_AVAILABLE") };
  }

  const authSubject = actor.auth_subject.toLowerCase();
  const appUserId = actor.app_user_id.toLowerCase();

  const navActor: NavActorProjection = {
    capabilities: actor.capabilities,
    scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
    ...(actor.effective_grants !== undefined
      ? { effective_grants: actor.effective_grants }
      : {}),
  };

  if (requiredMode === "admin") {
    if (!vendorFinanceAdminNavPredicate(navActor)) {
      return { ok: false, response: vfinError("VENDOR_FINANCE_ADMIN_DENIED") };
    }
    return { ok: true, auth_subject: authSubject, app_user_id: appUserId };
  }

  // Fast-path for Canonical Full Admin or direct `vendor_finance_record @ all`.
  if (vendorFinanceRecordNavPredicate(navActor)) {
    return { ok: true, auth_subject: authSubject, app_user_id: appUserId };
  }

  // Fast-path for `view` / `shared_advance_view` requests with direct `vendor_finance_view @ all`.
  if (
    (requiredMode === "view" || requiredMode === "shared_advance_view") &&
    vendorFinanceNavPredicate(navActor)
  ) {
    return { ok: true, auth_subject: authSubject, app_user_id: appUserId };
  }

  // Server-resolved VFIN boundary check (covers active ACCOUNTING department membership,
  // Cash-Holder, Cash-Holder record-on-behalf, and narrow Global Reconciler / Viewer).
  const accessResult = await dependencies.repository.getActorAccess({
    auth_subject: authSubject,
    app_user_id: appUserId,
  });
  if (!accessResult.ok) {
    return { ok: false, response: vfinError(accessResult.code) };
  }

  if (!accessResult.data.can_view) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_ACCESS_DENIED") };
  }
  if (
    requiredMode === "shared_advance_view" &&
    !accessResult.data.can_view_shared_advance
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_ACCESS_DENIED") };
  }
  if (requiredMode === "record" && !accessResult.data.can_record) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }
  if (
    requiredMode === "shared_advance_fund" &&
    !accessResult.data.can_fund_vendor_advance
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }
  if (
    requiredMode === "shared_advance_refund" &&
    !accessResult.data.can_record_vendor_refund
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }
  if (
    requiredMode === "shared_advance_apply" &&
    !accessResult.data.can_apply_vendor_advance
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }
  if (
    requiredMode === "shared_advance_reverse" &&
    !accessResult.data.can_fund_vendor_advance &&
    !accessResult.data.can_apply_vendor_advance &&
    !accessResult.data.can_record
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }
  if (requiredMode === "reconcile" && !accessResult.data.can_reconcile) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECONCILE_DENIED") };
  }
  if (
    requiredMode === "evidence" &&
    !accessResult.data.can_record &&
    !accessResult.data.can_reconcile &&
    !accessResult.data.can_fund_vendor_advance
  ) {
    return { ok: false, response: vfinError("VENDOR_FINANCE_RECORD_DENIED") };
  }

  return { ok: true, auth_subject: authSubject, app_user_id: appUserId };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; code: "INVALID_JSON" | "REQUEST_BODY_TOO_LARGE" }
> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
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
  storage: VendorFinanceEvidenceStorage,
  storageKey: string,
): Promise<boolean> {
  try {
    await storage.deleteStaged(storageKey);
    return true;
  } catch {
    console.error("[vendor-finance] staged evidence cleanup failed");
    return false;
  }
}

async function safeDeleteFinalObject(
  storage: VendorFinanceEvidenceStorage,
  storageKey: string,
): Promise<boolean> {
  if (typeof storage.deleteFinal !== "function") {
    return true;
  }
  try {
    await storage.deleteFinal(storageKey);
    return true;
  } catch {
    console.error("[vendor-finance] final evidence cleanup failed");
    return false;
  }
}

// -----------------------------------------------------------------------------
// 0. GET /api/vendor-finance/context
// -----------------------------------------------------------------------------
export async function handleGetVendorFinanceContext(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const result = await dependencies.repository.listContextOptions({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 1. GET /api/vendor-finance/vendors
// -----------------------------------------------------------------------------
export async function handleGetVendorFinanceVendors(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const query = parseListVendorFinanceVendorsQuery(url);
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.listVendors({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    search: query.value.search,
    active: query.value.active,
    balance_filter: query.value.balance_filter,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    ledger_scope: query.value.ledger_scope,
    contract_type: query.value.contract_type,
    page: query.value.page,
    page_size: query.value.page_size,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 2. GET /api/vendor-finance/vendors/[vendorId]
// -----------------------------------------------------------------------------
export async function handleGetVendorFinanceVendorDetail(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const query = parseGetVendorFinanceVendorDetailQuery(url);
  if (!query.ok) return vfinError(query.code);

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const result = await dependencies.repository.getVendor({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    ledger_scope: query.value.ledger_scope,
    contract_type: query.value.contract_type,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 3. GET /api/vendor-finance/vendors/[vendorId]/entries
// -----------------------------------------------------------------------------
export async function handleGetVendorFinanceEntries(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const query = parseListVendorFinanceEntriesQuery(url, parsedVendorId.vendor_id);
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.listVendorEntries({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    before_sequence: query.value.before_sequence,
    entry_type: query.value.entry_type,
    page_size: query.value.page_size,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    ledger_scope: query.value.ledger_scope,
    contract_type: query.value.contract_type,
    month: query.value.month,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 4. POST /api/vendor-finance/vendors/[vendorId]/entries
// -----------------------------------------------------------------------------
export async function handlePostVendorFinanceEntry(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "record");
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseRecordVendorFinanceEntryBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeRecordEntryFingerprint({
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    vendor_id: parsedVendorId.vendor_id,
    entry_type: parsedBody.value.entry_type,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.recordEntry({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    vendor_id: parsedVendorId.vendor_id,
    entry_type: parsedBody.value.entry_type,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 5. GET /api/vendor-finance/entries/[entryId]
// -----------------------------------------------------------------------------
export async function handleGetVendorFinanceSingleEntry(
  request: Request,
  entryId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const parsedEntryId = parseUuidParam(entryId, "VENDOR_FINANCE_ENTRY_INVALID");
  if (!parsedEntryId.ok) return vfinError(parsedEntryId.code);

  const result = await dependencies.repository.getEntry({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    entry_id: parsedEntryId.id,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 6. POST /api/vendor-finance/entries/[entryId]/reverse
// -----------------------------------------------------------------------------
export async function handlePostReverseVendorFinanceEntry(
  request: Request,
  entryId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "record");
  if (!actor.ok) return actor.response;

  const parsedEntryId = parseUuidParam(entryId, "VENDOR_FINANCE_ENTRY_INVALID");
  if (!parsedEntryId.ok) return vfinError(parsedEntryId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseReverseVendorFinanceEntryBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeReverseEntryFingerprint({
    entry_id: parsedEntryId.id,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.reverseEntry({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    entry_id: parsedEntryId.id,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 7. POST /api/vendor-finance/opening-batches/preview
// -----------------------------------------------------------------------------
export async function handlePostPreviewOpeningBatch(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "record");
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parsePreviewOpeningBatchBody(boundedBody.value);
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const preview = await dependencies.repository.previewOpeningBatch({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    cutoff_date: parsedBody.value.cutoff_date,
    items: parsedBody.value.items,
  });
  if (!preview.ok) return vfinError(preview.code);

  return vfinOk(preview.data, 200);
}

// -----------------------------------------------------------------------------
// 8. POST /api/vendor-finance/opening-batches/apply
// -----------------------------------------------------------------------------
export async function handlePostApplyOpeningBatch(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "record");
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseApplyOpeningBatchBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeApplyOpeningBatchFingerprint({
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    cutoff_date: parsedBody.value.cutoff_date,
    items: parsedBody.value.items,
    reason: parsedBody.value.reason,
  });

  const applied = await dependencies.repository.applyOpeningBatch({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    cutoff_date: parsedBody.value.cutoff_date,
    items: parsedBody.value.items,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!applied.ok) return vfinError(applied.code);

  return vfinOk(applied.data, applied.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 9. GET /api/vendor-finance/vendors/[vendorId]/reconciliations
// -----------------------------------------------------------------------------
export async function handleGetVendorReconciliations(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const query = parseListVendorReconciliationsQuery(url);
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.listVendorReconciliations({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    page: query.value.page,
    page_size: query.value.page_size,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    ledger_scope: query.value.ledger_scope,
    contract_type: query.value.contract_type,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 10. POST /api/vendor-finance/vendors/[vendorId]/reconciliations
// -----------------------------------------------------------------------------
export async function handlePostVendorReconciliation(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "reconcile");
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseCreateVendorReconciliationBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeCreateReconciliationFingerprint({
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    contract_type: parsedBody.value.contract_type,
    vendor_id: parsedVendorId.vendor_id,
    as_of_date: parsedBody.value.as_of_date,
    confirmed_balance_minor: parsedBody.value.confirmed_balance_minor,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.createReconciliation({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    contract_type: parsedBody.value.contract_type,
    vendor_id: parsedVendorId.vendor_id,
    as_of_date: parsedBody.value.as_of_date,
    confirmed_balance_minor: parsedBody.value.confirmed_balance_minor,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 10b. POST /api/vendor-finance/vendors/[vendorId]/classify-contract-type
// -----------------------------------------------------------------------------
export async function handlePostClassifyVendorSubLedger(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "record");
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseClassifyVendorSubLedgerBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeClassifySubLedgerFingerprint({
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    target_contract_type: parsedBody.value.target_contract_type,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.classifyUnclassifiedSubLedger({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    target_contract_type: parsedBody.value.target_contract_type,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 11. GET /api/vendor-finance/reports/monthly (& /export)
// -----------------------------------------------------------------------------
async function fetchVendorFinanceMonthlyReport(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<
  | { ok: true; data: VendorFinanceMonthlyReportResponse; month: string }
  | { ok: false; response: Response }
> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return { ok: false, response: gate };

  if (hasDisallowedAuthorityHeaders(request)) {
    return { ok: false, response: vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN") };
  }

  const url = parseRequestUrl(request);
  if (!url) return { ok: false, response: vfinError("VENDOR_FINANCE_QUERY_INVALID") };

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return { ok: false, response: actor.response };

  const query = parseMonthlyReportQuery(url);
  if (!query.ok) return { ok: false, response: vfinError(query.code) };

  const result = await dependencies.repository.getMonthlyReport({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    month: query.value.month,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    vendor_id: query.value.vendor_id,
    contract_type: query.value.contract_type,
  });
  if (!result.ok) return { ok: false, response: vfinError(result.code) };

  return { ok: true, data: result.data, month: query.value.month };
}

function buildXlsxAttachmentResponse(xlsxBytes: Uint8Array, filename: string): Response {
  const xlsxBody = xlsxBytes.buffer.slice(
    xlsxBytes.byteOffset,
    xlsxBytes.byteOffset + xlsxBytes.byteLength,
  );
  return new Response(xlsxBody as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleGetVendorFinanceMonthlyReport(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const fetched = await fetchVendorFinanceMonthlyReport(request, enabledFlag, dependencies);
  if (!fetched.ok) return fetched.response;
  return vfinOk(fetched.data, 200);
}

export async function handleGetExportVendorFinanceMonthlyReport(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const fetched = await fetchVendorFinanceMonthlyReport(request, enabledFlag, dependencies);
  if (!fetched.ok) return fetched.response;

  const buildXlsx =
    dependencies.buildMonthlyReportExportXlsx ?? buildVendorFinanceMonthlyReportExportXlsx;
  let xlsxBytes: Uint8Array;
  try {
    xlsxBytes = await buildXlsx(fetched.data);
  } catch {
    console.error("[vendor-finance] monthly report export xlsx build failed");
    return vfinError("VENDOR_FINANCE_UNAVAILABLE");
  }

  return buildXlsxAttachmentResponse(
    xlsxBytes,
    vendorFinanceMonthlyReportExportFilename(fetched.month),
  );
}

// -----------------------------------------------------------------------------
// 12. Full-Admin Governance Endpoints (`/api/vendor-finance/admin/*`)
// -----------------------------------------------------------------------------
export async function handleGetProjectAccountantsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "admin");
  if (!actor.ok) return actor.response;

  const query = parseListProjectAccountantsAdminQuery(url);
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.listProjectAccountantsAdmin({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    search: query.value.search,
    include_history: query.value.include_history,
    page: query.value.page,
    page_size: query.value.page_size,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

export async function handlePostAssignProjectAccountantAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "admin");
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseAssignProjectAccountantBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeAssignProjectAccountantFingerprint({
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    valid_from: parsedBody.value.valid_from,
    expected_version: parsedBody.value.expected_version,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.assignProjectAccountantAdmin({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    project_id: parsedBody.value.project_id,
    accountant_ref: parsedBody.value.accountant_ref,
    expected_version: parsedBody.value.expected_version,
    valid_from: parsedBody.value.valid_from,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

export async function handlePostEndProjectAccountantAdmin(
  request: Request,
  assignmentId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "admin");
  if (!actor.ok) return actor.response;

  const parsedAssignmentId = parseUuidParam(
    assignmentId,
    "VENDOR_FINANCE_ASSIGNMENT_INVALID",
  );
  if (!parsedAssignmentId.ok) return vfinError(parsedAssignmentId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseEndProjectAccountantBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeEndProjectAccountantFingerprint({
    assignment_id: parsedAssignmentId.id,
    expected_version: parsedBody.value.expected_version,
    valid_to: parsedBody.value.valid_to,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.endProjectAccountantAdmin({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    assignment_id: parsedAssignmentId.id,
    expected_version: parsedBody.value.expected_version,
    valid_to: parsedBody.value.valid_to,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, 200);
}

// -----------------------------------------------------------------------------
// 13. POST /api/vendor-finance/evidence/reserve
// -----------------------------------------------------------------------------
export async function handlePostReserveVendorFinanceEvidence(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "evidence");
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseReserveVendorFinanceEvidenceBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  if (!dependencies.storage || !dependencies.storage.available()) {
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const fingerprint = computeReserveEvidenceFingerprint({
    target_kind: parsedBody.value.target_kind,
    target_id: parsedBody.value.target_id,
    mime_type: parsedBody.value.mime_type,
    size_bytes: parsedBody.value.size_bytes,
    checksum_sha256: parsedBody.value.checksum_sha256,
  });

  const reserved = await dependencies.repository.reserveEvidence({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    target_kind: parsedBody.value.target_kind,
    target_id: parsedBody.value.target_id,
    mime_type: parsedBody.value.mime_type,
    size_bytes: parsedBody.value.size_bytes,
    checksum_sha256: parsedBody.value.checksum_sha256,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!reserved.ok) return vfinError(reserved.code);

  for (const supersededKey of reserved.data.superseded_storage_keys) {
    const cleanedStaged = await safeDeleteStagedObject(dependencies.storage, supersededKey);
    const cleanedFinal = await safeDeleteFinalObject(dependencies.storage, supersededKey);
    const supersededEvId = supersededKey.split("/").at(-1) ?? "";
    if (cleanedStaged && cleanedFinal && isUuid(supersededEvId)) {
      await dependencies.repository.markEvidenceCleaned({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: supersededEvId,
      });
    }
  }

  let signedUpload: { url: string; expires_at: string; headers: Record<string, string> };
  try {
    signedUpload = await dependencies.storage.createUploadUrl({
      storage_key: reserved.data.reservation.storage_key,
      mime_type: reserved.data.reservation.mime_type,
      size_bytes: reserved.data.reservation.size_bytes,
    });
  } catch {
    console.error("[vendor-finance] upload presign failed");
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const responsePayload: VendorFinanceEvidenceReserveResponse = {
    evidence_id: reserved.data.reservation.evidence_id,
    target_kind: reserved.data.reservation.target_kind,
    target_id: reserved.data.reservation.target_id,
    mime_type: reserved.data.reservation.mime_type,
    size_bytes: reserved.data.reservation.size_bytes,
    checksum_sha256: reserved.data.reservation.checksum_sha256,
    upload: {
      method: "PUT",
      url: signedUpload.url,
      expires_at: signedUpload.expires_at,
      headers: signedUpload.headers,
    },
    replayed: reserved.data.replayed,
  };

  return vfinOk(responsePayload, reserved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 14. POST /api/vendor-finance/evidence/[evidenceId]/finalize
// -----------------------------------------------------------------------------
export async function handlePostFinalizeVendorFinanceEvidence(
  request: Request,
  evidenceId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "evidence");
  if (!actor.ok) return actor.response;

  const parsedEvidenceId = parseUuidParam(
    evidenceId,
    "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID",
  );
  if (!parsedEvidenceId.ok) return vfinError(parsedEvidenceId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseFinalizeVendorFinanceEvidenceBody(boundedBody.value);
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  if (!dependencies.storage || !dependencies.storage.available()) {
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const infoResult = await dependencies.repository.getEvidenceReservationInfo({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    evidence_id: parsedEvidenceId.id,
  });
  if (!infoResult.ok) return vfinError(infoResult.code);

  const info = infoResult.data;

  // Idempotent finalize replay if already promoted to READY.
  if (info.status === "READY") {
    const readyReplay = await dependencies.repository.finalizeEvidenceReady({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      evidence_id: parsedEvidenceId.id,
    });
    if (!readyReplay.ok) return vfinError(readyReplay.code);
    await safeDeleteStagedObject(dependencies.storage, info.storage_key);
    return vfinOk(readyReplay.data, 200);
  }

  if (info.status !== "RESERVED" || info.is_expired) {
    let transitioned = info.status === "EXPIRED" || info.status === "FAILED";
    if (info.status === "RESERVED") {
      const expiredRes = await dependencies.repository.expireEvidenceReservation({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: parsedEvidenceId.id,
        failure_code: "RESERVATION_TTL_EXPIRED",
      });
      transitioned = expiredRes.ok;
    }
    const cleanedStaged = await safeDeleteStagedObject(dependencies.storage, info.storage_key);
    const cleanedFinal = await safeDeleteFinalObject(dependencies.storage, info.storage_key);
    if (transitioned && cleanedStaged && cleanedFinal) {
      await dependencies.repository.markEvidenceCleaned({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: parsedEvidenceId.id,
      });
    }
    return vfinError("VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED");
  }

  let stagedRead: Awaited<ReturnType<VendorFinanceEvidenceStorage["readStagedBounded"]>>;
  try {
    stagedRead = await dependencies.storage.readStagedBounded(info.storage_key);
  } catch {
    console.error("[vendor-finance] staged evidence read failed");
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  if (stagedRead.kind === "missing") {
    return vfinError("VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING");
  }

  if (stagedRead.kind === "too-large") {
    const cleaned = await safeDeleteStagedObject(dependencies.storage, info.storage_key);
    const failedRes = await dependencies.repository.failEvidenceReservation({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      evidence_id: parsedEvidenceId.id,
      failure_code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID",
    });
    if (failedRes.ok && cleaned) {
      await dependencies.repository.markEvidenceCleaned({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: parsedEvidenceId.id,
      });
    }
    return vfinError("VENDOR_FINANCE_EVIDENCE_SIZE_INVALID");
  }

  const inspection = inspectVfinEvidenceContent({
    mime_type: info.mime_type,
    expected_size_bytes: info.size_bytes,
    expected_checksum_sha256: info.checksum_sha256,
    bytes: stagedRead.bytes,
  });

  if (!inspection.ok) {
    const cleaned = await safeDeleteStagedObject(dependencies.storage, info.storage_key);
    const failedRes = await dependencies.repository.failEvidenceReservation({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      evidence_id: parsedEvidenceId.id,
      failure_code: inspection.code,
    });
    if (failedRes.ok && cleaned) {
      await dependencies.repository.markEvidenceCleaned({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: parsedEvidenceId.id,
      });
    }
    return vfinError(inspection.code);
  }

  try {
    await dependencies.storage.promoteStagedToFinal({
      storage_key: info.storage_key,
      mime_type: info.mime_type,
    });
  } catch {
    console.error("[vendor-finance] staged evidence promotion failed");
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const finalized = await dependencies.repository.finalizeEvidenceReady({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    evidence_id: parsedEvidenceId.id,
  });
  if (!finalized.ok) {
    if (
      finalized.code === "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED" ||
      finalized.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"
    ) {
      const cleanedFinal = await safeDeleteFinalObject(dependencies.storage, info.storage_key);
      const cleanedStaged = await safeDeleteStagedObject(dependencies.storage, info.storage_key);
      const expRes = await dependencies.repository.expireEvidenceReservation({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        evidence_id: parsedEvidenceId.id,
        failure_code:
          finalized.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"
            ? "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"
            : "RESERVATION_TTL_EXPIRED",
      });
      if (expRes.ok && cleanedFinal && cleanedStaged) {
        await dependencies.repository.markEvidenceCleaned({
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          evidence_id: parsedEvidenceId.id,
        });
      }
    }
    return vfinError(finalized.code);
  }

  await safeDeleteStagedObject(dependencies.storage, info.storage_key);

  return vfinOk(finalized.data, 200);
}

// -----------------------------------------------------------------------------
// 15. GET /api/vendor-finance/evidence/[evidenceId]/download
// -----------------------------------------------------------------------------
export async function handleGetDownloadVendorFinanceEvidence(
  request: Request,
  evidenceId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const parsedEvidenceId = parseUuidParam(
    evidenceId,
    "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID",
  );
  if (!parsedEvidenceId.ok) return vfinError(parsedEvidenceId.code);

  if (!dependencies.storage || !dependencies.storage.available()) {
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const downloadInfo = await dependencies.repository.getEvidenceDownload({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    evidence_id: parsedEvidenceId.id,
  });
  if (!downloadInfo.ok) return vfinError(downloadInfo.code);

  let signedDownload: { url: string; expires_at: string };
  try {
    signedDownload = await dependencies.storage.createDownloadUrl({
      storage_key: downloadInfo.data.storage_key,
      mime_type: downloadInfo.data.mime_type,
    });
  } catch {
    console.error("[vendor-finance] download presign failed");
    return vfinError("VENDOR_FINANCE_STORAGE_UNAVAILABLE");
  }

  const responsePayload: VendorFinanceEvidenceDownloadResponse = {
    evidence_id: downloadInfo.data.evidence_id,
    target_kind: downloadInfo.data.target_kind,
    target_id: downloadInfo.data.target_id,
    mime_type: downloadInfo.data.mime_type,
    size_bytes: downloadInfo.data.size_bytes,
    checksum_sha256: downloadInfo.data.checksum_sha256,
    download: {
      url: signedDownload.url,
      expires_at: signedDownload.expires_at,
    },
  };

  return vfinOk(responsePayload, 200);
}

// -----------------------------------------------------------------------------
// 16. GET & POST /api/vendor-finance/vendors/export
// -----------------------------------------------------------------------------
export async function handleGetExportVendorFinanceVendors(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(dependencies, "view");
  if (!actor.ok) return actor.response;

  const query = parseExportVendorFinanceVendorsQuery(url);
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.exportVendors({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    search: query.value.search,
    active: query.value.active,
    balance_filter: query.value.balance_filter,
    project_id: query.value.project_id,
    accountant_ref: query.value.accountant_ref,
    ledger_scope: query.value.ledger_scope,
    contract_type: query.value.contract_type,
  });
  if (!result.ok) return vfinError(result.code);

  const buildXlsx = dependencies.buildExportXlsx ?? buildVendorFinanceExportXlsx;
  let xlsxBytes: Uint8Array;
  try {
    xlsxBytes = await buildXlsx(result.data.vendors);
  } catch {
    console.error("[vendor-finance] vendor export xlsx build failed");
    return vfinError("VENDOR_FINANCE_UNAVAILABLE");
  }

  return buildXlsxAttachmentResponse(
    xlsxBytes,
    vendorFinanceExportFilename(result.data.authorization_date),
  );
}

// -----------------------------------------------------------------------------
// 17. GET /api/vendor-finance/vendors/[vendorId]/shared-advances
// -----------------------------------------------------------------------------
export async function handleGetVendorSharedAdvanceMovements(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) return vfinError("VENDOR_FINANCE_QUERY_INVALID");

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_view",
  );
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const query = parseListSharedAdvanceMovementsQuery(
    url,
    parsedVendorId.vendor_id,
  );
  if (!query.ok) return vfinError(query.code);

  const result = await dependencies.repository.listSharedAdvanceMovements({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    before_sequence: query.value.before_sequence,
    movement_type: query.value.movement_type,
    page_size: query.value.page_size,
  });
  if (!result.ok) return vfinError(result.code);

  return vfinOk(result.data, 200);
}

// -----------------------------------------------------------------------------
// 18. POST /api/vendor-finance/vendors/[vendorId]/shared-advances/fund
// -----------------------------------------------------------------------------
export async function handlePostFundVendorSharedAdvance(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_fund",
  );
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseFundSharedAdvanceBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeFundSharedAdvanceFingerprint({
    vendor_id: parsedVendorId.vendor_id,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.fundSharedAdvance({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 19. POST /api/vendor-finance/vendors/[vendorId]/shared-advances/refund
// -----------------------------------------------------------------------------
export async function handlePostRecordVendorRefund(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_refund",
  );
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseRecordVendorRefundBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeRecordVendorRefundFingerprint({
    vendor_id: parsedVendorId.vendor_id,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.recordVendorRefund({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 20. POST /api/vendor-finance/vendors/[vendorId]/shared-advances/apply-offset
// -----------------------------------------------------------------------------
export async function handlePostApplyVendorSharedAdvanceOffset(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_apply",
  );
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseApplySharedAdvanceOffsetBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeApplySharedAdvanceOffsetFingerprint({
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.applySharedAdvanceOffset({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    amount_minor: parsedBody.value.amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 21. POST /api/vendor-finance/shared-advances/[movementId]/reverse
// -----------------------------------------------------------------------------
export async function handlePostReverseVendorSharedAdvanceMovement(
  request: Request,
  movementId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_reverse",
  );
  if (!actor.ok) return actor.response;

  const parsedMovementId = parseUuidParam(
    movementId,
    "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID",
  );
  if (!parsedMovementId.ok) return vfinError(parsedMovementId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseReverseSharedAdvanceMovementBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeReverseSharedAdvanceMovementFingerprint({
    movement_id: parsedMovementId.id,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.reverseSharedAdvanceMovement({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    movement_id: parsedMovementId.id,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

// -----------------------------------------------------------------------------
// 22. POST /api/vendor-finance/vendors/[vendorId]/shared-advances/settle-with-offset
// -----------------------------------------------------------------------------
export async function handlePostRecordVendorPaymentWithOffset(
  request: Request,
  vendorId: string,
  enabledFlag: string | undefined,
  dependencies: VendorFinanceApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return vfinError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return vfinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return vfinError("VENDOR_FINANCE_QUERY_INVALID");
  }

  const actor = await resolveVendorFinanceAuthority(
    dependencies,
    "shared_advance_apply",
  );
  if (!actor.ok) return actor.response;

  const parsedVendorId = parseVendorIdParam(vendorId);
  if (!parsedVendorId.ok) return vfinError(parsedVendorId.code);

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  );
  if (!boundedBody.ok) return vfinError(boundedBody.code);

  const parsedBody = parseRecordPaymentWithOffsetBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return vfinError(parsedBody.code);

  const fingerprint = computeRecordPaymentWithOffsetFingerprint({
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    payment_amount_minor: parsedBody.value.payment_amount_minor,
    offset_amount_minor: parsedBody.value.offset_amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.recordPaymentWithOffset({
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    vendor_id: parsedVendorId.vendor_id,
    project_id: parsedBody.value.project_id,
    contract_type: parsedBody.value.contract_type,
    payment_amount_minor: parsedBody.value.payment_amount_minor,
    offset_amount_minor: parsedBody.value.offset_amount_minor,
    effective_date: parsedBody.value.effective_date,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return vfinError(saved.code);

  return vfinOk(saved.data, saved.data.replayed ? 200 : 201);
}

