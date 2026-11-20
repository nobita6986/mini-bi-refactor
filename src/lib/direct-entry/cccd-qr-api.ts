import "server-only";

import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import {
  hasActiveContextualRole,
  hasAnyValidPairedGrant,
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import {
  isCccdQrDocumentType,
  parseCccdQrProcessRequest,
  type CccdQrDocumentType,
} from "./cccd-qr-contract.ts";
import {
  decodeCccdQrFromImageBytes,
  type CccdQrDecodeResult,
} from "./cccd-qr-decoder.ts";
import type {
  CccdQrExtractionRecord,
  CccdQrRepository,
} from "./cccd-qr-repository.ts";
import {
  fail,
  json,
  readIdempotencyKey,
  readJsonBody,
  UUID,
} from "./document-api.ts";
import { inspectDocumentContent, sha256Hex } from "./document-r2-contract.ts";
import type { DocumentObjectStorage } from "./r2-document-storage.ts";
import type { OperationResult } from "./write-repository.ts";

export type CccdQrApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  qrRepository: CccdQrRepository;
  storage: Pick<DocumentObjectStorage, "available" | "readFinal">;
  decodeQr?: (bytes: Uint8Array) => Promise<CccdQrDecodeResult>;
};

const inFlightExtractions = new Map<string, Promise<void>>();

function mapQrFailure(
  kind: Exclude<OperationResult<unknown>, { ok: true }>["kind"],
): Response {
  if (kind === "conflict") return fail("ENTRY_VERSION_CONFLICT", 409);
  if (kind === "denied" || kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
  if (kind === "invalid") return fail("CCCD_QR_REQUEST_INVALID", 400);
  console.error("[direct-entry] cccd qr operation unavailable");
  return fail("CCCD_QR_UNAVAILABLE", 500);
}

async function resolveQrActor(
  dependencies: Pick<CccdQrApiDependencies, "resolveSession">,
  mode: "read" | "write",
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
      can_upload: boolean;
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
  const canUpload =
    hasAnyValidPairedGrant(actor, "document_upload") ||
    hasAnyValidPairedGrant(actor, "change_request_create") ||
    hasAnyValidPairedGrant(actor, "change_review") ||
    hasAnyValidPairedGrant(actor, "entry_privileged_edit") ||
    hasAnyValidPairedGrant(actor, "entry_admin") ||
    hasActiveContextualRole(actor, "PROJECT_MANAGER");
  const canView =
    canUpload ||
    hasAnyValidPairedGrant(actor, "document_view");

  if (mode === "write" && !canUpload) {
    return { ok: false, response: fail("DOCUMENT_DENIED", 403) };
  }
  if (mode === "read" && !canView) {
    return { ok: false, response: fail("DOCUMENT_DENIED", 403) };
  }
  return {
    ok: true,
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    can_upload: canUpload,
  };
}

function summarizeStatus(
  latest: CccdQrExtractionRecord | null,
  eligibleCount: number,
): "NO_DOCUMENT" | CccdQrExtractionRecord["status"] {
  if (latest) return latest.status;
  if (eligibleCount > 0) return "PENDING";
  return "NO_DOCUMENT";
}

async function executeDecodeAndComplete(input: {
  auth_subject: string;
  app_user_id: string;
  entry_id: string;
  document_id: string;
  image_bytes: Uint8Array;
  apply_blank_fields: boolean;
  expected_entry_version: number | null;
  idempotency_key: string | null;
  qrRepository: CccdQrRepository;
  decodeQr: (bytes: Uint8Array) => Promise<CccdQrDecodeResult>;
}) {
  let decoded: CccdQrDecodeResult;
  try {
    decoded = await input.decodeQr(input.image_bytes);
  } catch {
    console.error("[direct-entry] cccd qr decoder threw unexpected error");
    decoded = {
      status: "FAILED_RETRYABLE",
      candidate_data: null,
      error_code: "QR_DECODE_FAILED",
      error_field: null,
    };
  }

  return input.qrRepository.completeExtraction({
    auth_subject: input.auth_subject,
    app_user_id: input.app_user_id,
    entry_id: input.entry_id,
    document_id: input.document_id,
    status: decoded.status,
    error_code: decoded.error_code,
    error_field: decoded.error_field,
    candidate_data: decoded.candidate_data,
    apply_blank_fields: input.apply_blank_fields && decoded.status === "SUCCEEDED",
    expected_entry_version: input.expected_entry_version,
    idempotency_key: input.idempotency_key,
  });
}

/**
 * Triggers non-blocking background CCCD QR extraction after a CCCD image is finalized.
 * Never throws and never blocks or rolls back the worker profile or document finalization.
 */
export function triggerBackgroundCccdQrExtraction(input: {
  auth_subject: string;
  app_user_id: string;
  entry_id: string;
  document_id: string;
  document_type: CccdQrDocumentType;
  image_bytes: Uint8Array;
  qrRepository: CccdQrRepository;
  decodeQr?: (bytes: Uint8Array) => Promise<CccdQrDecodeResult>;
}): Promise<void> {
  const existing = inFlightExtractions.get(input.document_id);
  if (existing) return existing;

  const decodeQr = input.decodeQr ?? decodeCccdQrFromImageBytes;
  const task = (async () => {
    try {
      const prepared = await input.qrRepository.prepareExtraction({
        auth_subject: input.auth_subject,
        app_user_id: input.app_user_id,
        entry_id: input.entry_id,
        document_id: input.document_id,
        document_type: input.document_type,
      });
      if (!prepared.ok) return;

      const currentStatus = prepared.data.extraction.status;
      if (
        currentStatus === "SUCCEEDED" ||
        currentStatus === "NO_QR_FOUND" ||
        currentStatus === "INVALID_QR"
      ) {
        return;
      }

      await executeDecodeAndComplete({
        auth_subject: input.auth_subject,
        app_user_id: input.app_user_id,
        entry_id: input.entry_id,
        document_id: input.document_id,
        image_bytes: input.image_bytes,
        apply_blank_fields: true,
        expected_entry_version: null,
        idempotency_key: `bg:${input.document_id}`,
        qrRepository: input.qrRepository,
        decodeQr,
      });
    } catch {
      console.error("[direct-entry] cccd qr background extraction failed");
    } finally {
      inFlightExtractions.delete(input.document_id);
    }
  })();

  inFlightExtractions.set(input.document_id, task);
  return task;
}

export async function getDirectEntryCccdQr(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: CccdQrApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);

  let documentIdFilter: string | null = null;
  let documentTypeFilter: CccdQrDocumentType | null = null;
  let reconcilePending = true;
  try {
    const url = new URL(request.url);
    const rawDocId = url.searchParams.get("document_id");
    if (rawDocId !== null && rawDocId.trim() !== "") {
      if (!UUID.test(rawDocId.trim())) return fail("DOCUMENT_ID_INVALID", 400);
      documentIdFilter = rawDocId.trim();
    }
    const rawDocType = url.searchParams.get("document_type");
    if (rawDocType !== null && rawDocType.trim() !== "") {
      if (!isCccdQrDocumentType(rawDocType.trim())) return fail("DOCUMENT_TYPE_INVALID", 400);
      documentTypeFilter = rawDocType.trim() as CccdQrDocumentType;
    }
    if (url.searchParams.get("reconcile") === "false") {
      reconcilePending = false;
    }
  } catch {
    return fail("CCCD_QR_REQUEST_INVALID", 400);
  }

  try {
    const actor = await resolveQrActor(dependencies, "read");
    if (!actor.ok) return actor.response;

    let readResult = await dependencies.qrRepository.getExtractions({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: documentIdFilter,
    });
    if (!readResult.ok) return mapQrFailure(readResult.kind);

    // Self-healing lazy completion: if an eligible CCCD document is READY in R2
    // and has no completed extraction yet (and isn't currently running in-flight),
    // an uploader actor can reconcile it on demand so polling always converges.
    if (reconcilePending && actor.can_upload && dependencies.storage.available()) {
      const targetDoc = readResult.data.eligible_documents.find((doc) => {
        if (documentIdFilter && doc.document_id !== documentIdFilter) return false;
        if (documentTypeFilter && doc.document_type !== documentTypeFilter) return false;
        if (inFlightExtractions.has(doc.document_id)) return false;
        const existing = readResult.ok
          ? readResult.data.extractions.find((e) => e.document_id === doc.document_id)
          : undefined;
        return !existing || existing.status === "PENDING";
      });

      if (targetDoc) {
        const prepared = await dependencies.qrRepository.prepareExtraction({
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          entry_id: entryId,
          document_id: targetDoc.document_id,
          document_type: targetDoc.document_type,
        });
        if (prepared.ok && prepared.data.extraction.status === "PENDING") {
          const bytes = await dependencies.storage
            .readFinal(prepared.data.storage_key)
            .catch(() => null);
          if (
            bytes &&
            bytes.byteLength === prepared.data.size_bytes &&
            sha256Hex(bytes) === prepared.data.checksum_sha256 &&
            inspectDocumentContent({
              document_type: prepared.data.document_type,
              mime_type: prepared.data.mime_type,
              bytes,
            }).ok
          ) {
            await executeDecodeAndComplete({
              auth_subject: actor.auth_subject,
              app_user_id: actor.app_user_id,
              entry_id: entryId,
              document_id: prepared.data.document_id,
              image_bytes: bytes,
              apply_blank_fields: true,
              expected_entry_version: null,
              idempotency_key: `reconcile:${prepared.data.document_id}`,
              qrRepository: dependencies.qrRepository,
              decodeQr: dependencies.decodeQr ?? decodeCccdQrFromImageBytes,
            });
            const refreshed = await dependencies.qrRepository.getExtractions({
              auth_subject: actor.auth_subject,
              app_user_id: actor.app_user_id,
              entry_id: entryId,
              document_id: documentIdFilter,
            });
            if (refreshed.ok) {
              readResult = refreshed;
            }
          }
        }
      }
    }

    const filteredExtractions = documentTypeFilter
      ? readResult.data.extractions.filter((e) => e.document_type === documentTypeFilter)
      : readResult.data.extractions;
    const filteredEligible = documentTypeFilter
      ? readResult.data.eligible_documents.filter((d) => d.document_type === documentTypeFilter)
      : readResult.data.eligible_documents;
    const latest = documentTypeFilter
      ? (filteredExtractions[0] ?? null)
      : readResult.data.latest;

    return json(
      {
        ok: true,
        entry_id: readResult.data.entry_id,
        entry_version: readResult.data.entry_version,
        status: summarizeStatus(latest, filteredEligible.length),
        ...(readResult.data.reconciliation !== undefined
          ? { reconciliation: readResult.data.reconciliation }
          : {}),
        latest,
        extractions: filteredExtractions,
        eligible_documents: filteredEligible,
      },
      200,
    );
  } catch {
    console.error("[direct-entry] cccd qr read failed");
    return fail("CCCD_QR_UNAVAILABLE", 500);
  }
}

export async function processDirectEntryCccdQr(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: CccdQrApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);

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
  if (!body) return fail("CCCD_QR_REQUEST_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok) {
    return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }
  const parsed = parseCccdQrProcessRequest(body);
  if (!parsed.ok) return fail(parsed.code, 400);

  try {
    const actor = await resolveQrActor(dependencies, "write");
    if (!actor.ok) return actor.response;
    if (!dependencies.storage.available()) {
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    }

    const prepared = await dependencies.qrRepository.prepareExtraction({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: parsed.value.document_id,
      document_type: parsed.value.document_type,
    });
    if (!prepared.ok) return mapQrFailure(prepared.kind);

    const existing = prepared.data.extraction;
    const isTerminal =
      existing.status === "SUCCEEDED" ||
      existing.status === "NO_QR_FOUND" ||
      existing.status === "INVALID_QR";

    if (isTerminal) {
      if (parsed.value.apply_blank_fields && existing.status === "SUCCEEDED") {
        const applied = await dependencies.qrRepository.completeExtraction({
          auth_subject: actor.auth_subject,
          app_user_id: actor.app_user_id,
          entry_id: entryId,
          document_id: prepared.data.document_id,
          status: "SUCCEEDED",
          error_code: null,
          error_field: null,
          candidate_data: existing.candidate_data,
          apply_blank_fields: true,
          expected_entry_version: parsed.value.expected_entry_version,
          idempotency_key: idempotencyKey,
        });
        if (!applied.ok) return mapQrFailure(applied.kind);
        return json(
          {
            ok: true,
            entry_id: applied.data.entry_id,
            entry_version: applied.data.entry_version,
            reused: applied.data.reused,
            ...(applied.data.reconciliation !== undefined
              ? { reconciliation: applied.data.reconciliation }
              : {}),
            extraction: applied.data.extraction,
          },
          200,
        );
      }

      return json(
        {
          ok: true,
          entry_id: prepared.data.entry_id,
          entry_version: prepared.data.entry_version,
          reused: true,
          extraction: existing,
        },
        200,
      );
    }

    let bytes: Uint8Array | null = null;
    try {
      bytes = await dependencies.storage.readFinal(prepared.data.storage_key);
    } catch {
      bytes = null;
    }

    if (
      !bytes ||
      bytes.byteLength !== prepared.data.size_bytes ||
      sha256Hex(bytes) !== prepared.data.checksum_sha256 ||
      !inspectDocumentContent({
        document_type: prepared.data.document_type,
        mime_type: prepared.data.mime_type,
        bytes,
      }).ok
    ) {
      const failedStorage = await dependencies.qrRepository.completeExtraction({
        auth_subject: actor.auth_subject,
        app_user_id: actor.app_user_id,
        entry_id: entryId,
        document_id: prepared.data.document_id,
        status: "FAILED_RETRYABLE",
        error_code: "QR_STORAGE_UNAVAILABLE",
        error_field: null,
        candidate_data: null,
        apply_blank_fields: false,
        expected_entry_version: null,
        idempotency_key: idempotencyKey,
      });
      if (!failedStorage.ok) return mapQrFailure(failedStorage.kind);
      return json(
        {
          ok: true,
          entry_id: failedStorage.data.entry_id,
          entry_version: failedStorage.data.entry_version,
          reused: failedStorage.data.reused,
          ...(failedStorage.data.reconciliation !== undefined
            ? { reconciliation: failedStorage.data.reconciliation }
            : {}),
          extraction: failedStorage.data.extraction,
        },
        200,
      );
    }

    const completed = await executeDecodeAndComplete({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: prepared.data.document_id,
      image_bytes: bytes,
      apply_blank_fields: parsed.value.apply_blank_fields,
      expected_entry_version: parsed.value.expected_entry_version,
      idempotency_key: idempotencyKey,
      qrRepository: dependencies.qrRepository,
      decodeQr: dependencies.decodeQr ?? decodeCccdQrFromImageBytes,
    });
    if (!completed.ok) return mapQrFailure(completed.kind);

    return json(
      {
        ok: true,
        entry_id: completed.data.entry_id,
        entry_version: completed.data.entry_version,
        reused: completed.data.reused,
        ...(completed.data.reconciliation !== undefined
          ? { reconciliation: completed.data.reconciliation }
          : {}),
        extraction: completed.data.extraction,
      },
      200,
    );
  } catch {
    console.error("[direct-entry] cccd qr process failed");
    return fail("CCCD_QR_UNAVAILABLE", 500);
  }
}
