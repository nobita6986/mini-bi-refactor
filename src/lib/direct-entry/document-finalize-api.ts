import "server-only";

import { inspectDocumentContent, sha256Hex } from "./document-r2-contract.ts";
import { sanitizeWorkerPortrait } from "./worker-portrait-sanitizer.ts";
import {
  hasActiveContextualRole,
  hasAnyValidPairedGrant,
} from "../auth/direct-entry-v2.ts";
import {
  fail,
  isEntryVersion,
  json,
  mapFailure,
  readIdempotencyKey,
  readJsonBody,
  resolveActor,
  UUID,
  validateMutationRequest,
  type CccdFinalizeTriggerInput,
  type DocumentApiDependencies,
} from "./document-api.ts";

export type { CccdFinalizeTriggerInput };

function lifecycleBody(value: {
  document_id: string;
  version: number;
  entry_version: number;
  upload_status: string;
  scan_status: string;
  validation_status: string;
}, reused: boolean): Record<string, unknown> {
  return {
    ok: true,
    document_id: value.document_id,
    version: value.version,
    entry_version: value.entry_version,
    upload_status: value.upload_status,
    scan_status: value.scan_status,
    validation_status: value.validation_status,
    reused,
  };
}

export async function finalizeDirectEntryDocument(
  request: Request,
  entryId: string,
  documentId: string,
  flag: string | undefined,
  dependencies: DocumentApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const invalid = validateMutationRequest(request, entryId);
  if (invalid) return invalid;
  if (!UUID.test(documentId)) return fail("DOCUMENT_ID_INVALID", 400);
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return fail("IDEMPOTENCY_KEY_INVALID", 400);
  const body = await readJsonBody(request);
  if (!body || Object.keys(body).length !== 1 || !isEntryVersion(body.expected_entry_version)) {
    return fail("DOCUMENT_REQUEST_INVALID", 400);
  }
  const expectedEntryVersion = body.expected_entry_version;

  try {
    const actor = await resolveActor(dependencies, "document_upload");
    if (!actor.ok) return actor.response;
    if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    const trusted = { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
    const { repository, storage } = dependencies;

    const context = await repository.getDocumentContext({
      ...trusted, entry_id: entryId, document_id: documentId, purpose: "finalize",
    });
    if (!context.ok) return mapFailure(context.kind);
    const document = context.data;
    if (document.upload_status === "READY" && document.validation_status === "VALIDATED") {
      return json(lifecycleBody(document, true), 200);
    }
    if (document.upload_status !== "QUEUED") return fail("DOCUMENT_VERSION_CONFLICT", 409);

    const reject = async (code: string): Promise<Response> => {
      await storage.deleteStaged(document.storage_key).catch(() => undefined);
      const result = await repository.finalizeDocument({
        ...trusted,
        entry_id: entryId,
        document_id: documentId,
        expected_entry_version: expectedEntryVersion,
        idempotency_key: idempotencyKey,
        outcome: "rejected",
        checksum_sha256: null,
        size_bytes: null,
        mime_type: null,
      });
      if (!result.ok && result.kind !== "conflict") console.error("[direct-entry] document rejection not recorded");
      return fail(code, 422);
    };

    const head = await storage.headStaged(document.storage_key);
    if (head.kind === "missing") return fail("DOCUMENT_UPLOAD_MISSING", 409);
    if (head.size_bytes < 1 || head.size_bytes > 10 * 1024 * 1024 || head.size_bytes !== document.size_bytes) {
      return reject("DOCUMENT_SIZE_INVALID");
    }
    if (head.content_type !== document.mime_type) return reject("DOCUMENT_MIME_INVALID");

    const bytes = await storage.readStaged(document.storage_key);
    if (!bytes || bytes.length !== head.size_bytes) return reject("DOCUMENT_CONTENT_INVALID");
    const inspection = inspectDocumentContent({
      document_type: document.document_type,
      mime_type: document.mime_type,
      bytes,
    });
    if (!inspection.ok) return reject(inspection.code);

    let finalBytes = bytes;
    if (document.document_type === "WORKER_PORTRAIT") {
      const sanitized = await sanitizeWorkerPortrait(bytes, document.mime_type);
      if (!sanitized.ok) return reject("DOCUMENT_CONTENT_INVALID");
      finalBytes = sanitized.bytes;
      const sanitizedInspection = inspectDocumentContent({
        document_type: document.document_type,
        mime_type: document.mime_type,
        bytes: finalBytes,
      });
      if (!sanitizedInspection.ok) return reject(sanitizedInspection.code);
    }
    const checksum = sha256Hex(finalBytes);
    await storage.promote({
      storage_key: document.storage_key,
      mime_type: document.mime_type,
      ...(document.document_type === "WORKER_PORTRAIT" ? { sanitized_bytes: finalBytes } : {}),
    });
    const finalized = await repository.finalizeDocument({
      ...trusted,
      entry_id: entryId,
      document_id: documentId,
      expected_entry_version: expectedEntryVersion,
      idempotency_key: idempotencyKey,
      outcome: "validated",
      checksum_sha256: checksum,
      size_bytes: finalBytes.length,
      mime_type: document.mime_type,
    });
    if (!finalized.ok) {
      // Staging and final copies are kept so a retry or reconciliation can finish without a new revision.
      if (finalized.kind === "unavailable") return fail("DOCUMENT_FINALIZE_UNAVAILABLE", 503);
      return mapFailure(finalized.kind);
    }
    await storage.deleteStaged(document.storage_key).catch(() => undefined);
    if (
      (document.document_type === "CCCD_FRONT" || document.document_type === "CCCD_BACK") &&
      (document.mime_type === "image/jpeg" || document.mime_type === "image/png") &&
      typeof dependencies.onCccdImageFinalized === "function"
    ) {
      try {
        Promise.resolve(
          dependencies.onCccdImageFinalized({
            auth_subject: actor.auth_subject,
            app_user_id: actor.app_user_id,
            entry_id: entryId,
            document_id: documentId,
            document_type: document.document_type,
            image_bytes: finalBytes,
          }),
        ).catch(() => {
          console.error("[direct-entry] cccd qr background trigger failed");
        });
      } catch {
        console.error("[direct-entry] cccd qr background trigger failed");
      }
    }
    return json(lifecycleBody(finalized.data, finalized.data.reused), 200);
  } catch {
    console.error("[direct-entry] document finalize failed");
    return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
  }
}

export async function downloadDirectEntryDocument(
  request: Request,
  entryId: string,
  documentId: string,
  flag: string | undefined,
  dependencies: DocumentApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  if (!UUID.test(documentId)) return fail("DOCUMENT_ID_INVALID", 400);
  void request;
  try {
    const actor = await resolveActor(dependencies, "document_view");
    if (!actor.ok) return actor.response;
    if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    const context = await dependencies.repository.getDocumentContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: documentId,
      purpose: "download",
    });
    if (!context.ok) return mapFailure(context.kind);
    const document = context.data;
    if (document.document_type === "WORKER_PORTRAIT" ||
        document.upload_status !== "READY" || document.validation_status !== "VALIDATED" ||
        (document.scan_status !== "NOT_REQUIRED" && document.scan_status !== "CLEAN")) {
      return fail("ENTRY_NOT_FOUND", 404);
    }
    const signed = await dependencies.storage.createDownloadUrl({
      storage_key: document.storage_key,
      mime_type: document.mime_type,
      document_type: document.document_type,
      version: document.version,
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: signed.url,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    console.error("[direct-entry] document download failed");
    return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
  }
}

export async function previewWorkerPortraitDocument(
  request: Request,
  entryId: string,
  documentId: string,
  flag: string | undefined,
  dependencies: DocumentApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  if (!UUID.test(documentId)) return fail("DOCUMENT_ID_INVALID", 400);
  void request;
  try {
    const actor = await resolveActor(dependencies, "document_view");
    if (!actor.ok) return actor.response;
    if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    const context = await dependencies.repository.getDocumentContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: documentId,
      purpose: "preview",
    });
    if (!context.ok) return mapFailure(context.kind);
    const document = context.data;
    if (document.document_type !== "WORKER_PORTRAIT" ||
        (document.mime_type !== "image/jpeg" && document.mime_type !== "image/png") ||
        document.upload_status !== "READY" || document.validation_status !== "VALIDATED" ||
        (document.scan_status !== "NOT_REQUIRED" && document.scan_status !== "CLEAN") ||
        !document.checksum_sha256) {
      return fail("ENTRY_NOT_FOUND", 404);
    }

    const bytes = await dependencies.storage.readFinal(document.storage_key);
    if (!bytes || bytes.byteLength !== document.size_bytes ||
        sha256Hex(bytes) !== document.checksum_sha256 ||
        !inspectDocumentContent({
          document_type: document.document_type,
          mime_type: document.mime_type,
          bytes,
        }).ok) {
      console.error("[direct-entry] portrait object integrity check failed");
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    }
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": document.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    console.error("[direct-entry] portrait preview unavailable");
    return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
  }
}

export async function previewCccdDocument(
  request: Request,
  entryId: string,
  documentId: string,
  flag: string | undefined,
  dependencies: DocumentApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  if (!UUID.test(documentId)) return fail("DOCUMENT_ID_INVALID", 400);
  void request;
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const resolvedActor = session.actor.actor;
    const canPreviewCccd =
      hasAnyValidPairedGrant(resolvedActor, "document_view") ||
      hasAnyValidPairedGrant(resolvedActor, "document_upload") ||
      hasAnyValidPairedGrant(resolvedActor, "change_request_create") ||
      hasAnyValidPairedGrant(resolvedActor, "change_review") ||
      hasAnyValidPairedGrant(resolvedActor, "entry_privileged_edit") ||
      hasAnyValidPairedGrant(resolvedActor, "entry_admin") ||
      hasAnyValidPairedGrant(resolvedActor, "entry_create") ||
      hasActiveContextualRole(resolvedActor, "TEAM_LEADER") ||
      hasActiveContextualRole(resolvedActor, "PROJECT_MANAGER");
    if (!canPreviewCccd) {
      return fail("DOCUMENT_DENIED", 403);
    }
    const actor = {
      auth_subject: resolvedActor.auth_subject,
      app_user_id: resolvedActor.app_user_id,
    };
    if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    const context = await dependencies.repository.getDocumentContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      document_id: documentId,
      purpose: "cccd_preview",
    });
    if (!context.ok) return mapFailure(context.kind);
    const document = context.data;
    if ((document.document_type !== "CCCD_FRONT" && document.document_type !== "CCCD_BACK") ||
        (document.mime_type !== "image/jpeg" && document.mime_type !== "image/png") ||
        document.upload_status !== "READY" || document.validation_status !== "VALIDATED" ||
        (document.scan_status !== "NOT_REQUIRED" && document.scan_status !== "CLEAN") ||
        !document.checksum_sha256) {
      return fail("ENTRY_NOT_FOUND", 404);
    }

    const bytes = await dependencies.storage.readFinal(document.storage_key);
    if (!bytes || bytes.byteLength !== document.size_bytes ||
        sha256Hex(bytes) !== document.checksum_sha256 ||
        !inspectDocumentContent({
          document_type: document.document_type,
          mime_type: document.mime_type,
          bytes,
        }).ok) {
      console.error("[direct-entry] CCCD preview integrity check failed");
      return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
    }
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": document.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    console.error("[direct-entry] CCCD preview unavailable");
    return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
  }
}