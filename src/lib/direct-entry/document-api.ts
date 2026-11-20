import "server-only";

import {
  hasActiveContextualRole,
  hasAnyValidPairedGrant,
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { DOCUMENT_MIME_TYPES, type DirectEntryDocumentType } from "../contracts/direct-entry-v1.ts";
import { DOCUMENT_MAX_BYTES, isDirectEntryDocumentType } from "./document-upload-contract.ts";
import type { DocumentObjectStorage } from "./r2-document-storage.ts";
import type { DirectEntryRepository, OperationResult } from "./write-repository.ts";
import { projectOptionalActionReason } from "./action-reason.ts";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVE_KEYS = new Set(["document_type", "expected_entry_version", "size_bytes", "mime_type", "reason"]);

export type CccdFinalizeTriggerInput = {
  auth_subject: string;
  app_user_id: string;
  entry_id: string;
  document_id: string;
  document_type: "CCCD_FRONT" | "CCCD_BACK";
  image_bytes: Uint8Array;
};

export type DocumentApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
  storage: DocumentObjectStorage;
  onCccdImageFinalized?: (input: CccdFinalizeTriggerInput) => void | Promise<void>;
};

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });
}

export function fail(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

export function mapFailure(kind: Exclude<OperationResult<unknown>, { ok: true }>["kind"]): Response {
  if (kind === "conflict") return fail("DOCUMENT_VERSION_CONFLICT", 409);
  if (kind === "denied" || kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
  if (kind === "invalid") return fail("DOCUMENT_REQUEST_INVALID", 400);
  console.error("[direct-entry] document operation unavailable");
  return fail("DOCUMENT_UNAVAILABLE", 500);
}

export function validateMutationRequest(request: Request, entryId: string): Response | null {
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) return fail("CONTENT_TYPE_INVALID", 400);
  return null;
}

export function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get("idempotency-key");
  return key === null || key.trim() === "" || key.length > 128 ? null : key;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return null;
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isEntryVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export async function resolveActor(
  dependencies: DocumentApiDependencies,
  capability: "document_upload" | "document_view",
): Promise<{ ok: true; auth_subject: string; app_user_id: string } | { ok: false; response: Response }> {
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
  const hasDocumentCap = hasAnyValidPairedGrant(actor, capability);
  const canUploadDraftAsProjectManager =
    capability === "document_upload" &&
    (hasAnyValidPairedGrant(actor, "change_request_create", ["OWN", "ALL", "CONTEXT_PROJECT"]) ||
      hasActiveContextualRole(actor, "PROJECT_MANAGER"));
  if (!hasDocumentCap && !canUploadDraftAsProjectManager) {
    return { ok: false, response: fail("DOCUMENT_DENIED", 403) };
  }
  return { ok: true, auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
}

type ReserveBody = {
  document_type: DirectEntryDocumentType;
  expected_entry_version: number;
  size_bytes: number;
  mime_type: (typeof DOCUMENT_MIME_TYPES)[number];
  reason: string | null;
};

function parseReserveBody(body: Record<string, unknown>): ReserveBody | { code: string } {
  if (!validateClientBusinessPayload(body).ok) return { code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  if (Object.keys(body).some((key) => !RESERVE_KEYS.has(key))) return { code: "DOCUMENT_REQUEST_INVALID" };
  if (!isDirectEntryDocumentType(body.document_type)) return { code: "DOCUMENT_TYPE_INVALID" };
  if (!isEntryVersion(body.expected_entry_version)) return { code: "DOCUMENT_REQUEST_INVALID" };
  const size = body.size_bytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > DOCUMENT_MAX_BYTES) {
    return { code: "DOCUMENT_SIZE_INVALID" };
  }
  const mime = DOCUMENT_MIME_TYPES.find((candidate) => candidate === body.mime_type);
  if (!mime) return { code: "DOCUMENT_MIME_INVALID" };
  if (body.document_type === "WORKER_PORTRAIT" && mime === "application/pdf") {
    return { code: "DOCUMENT_MIME_INVALID" };
  }
  const reason = projectOptionalActionReason(body.reason);
  if (!reason.ok) return { code: "DOCUMENT_REQUEST_INVALID" };
  return {
    document_type: body.document_type,
    expected_entry_version: body.expected_entry_version,
    size_bytes: size,
    mime_type: mime,
    reason: reason.value,
  };
}

export async function reserveDirectEntryDocument(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: DocumentApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const invalid = validateMutationRequest(request, entryId);
  if (invalid) return invalid;
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return fail("IDEMPOTENCY_KEY_INVALID", 400);
  const body = await readJsonBody(request);
  if (!body) return fail("DOCUMENT_REQUEST_INVALID", 400);
  const parsed = parseReserveBody(body);
  if ("code" in parsed) return fail(parsed.code, 400);

  try {
    const actor = await resolveActor(dependencies, "document_upload");
    if (!actor.ok) return actor.response;
    if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);

    const reservation = await dependencies.repository.reserveDocumentUpload({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      idempotency_key: idempotencyKey,
      ...parsed,
    });
    if (!reservation.ok) return mapFailure(reservation.kind);
    const document = reservation.data;
    if (document.upload_status !== "QUEUED") {
      return json({
        ok: true,
        document_id: document.document_id,
        version: document.version,
        entry_version: document.entry_version,
        upload_status: document.upload_status,
        scan_status: document.scan_status,
        validation_status: document.validation_status,
        reused: document.reused,
        upload: null,
      }, 200);
    }
    const upload = await dependencies.storage.createUploadUrl({
      storage_key: document.storage_key,
      mime_type: parsed.mime_type,
      size_bytes: parsed.size_bytes,
    });
    return json({
      ok: true,
      document_id: document.document_id,
      version: document.version,
      entry_version: document.entry_version,
      upload_status: document.upload_status,
      scan_status: document.scan_status,
      validation_status: document.validation_status,
      reused: document.reused,
      upload: { method: "PUT", url: upload.url, headers: upload.headers, expires_at: upload.expires_at },
    }, document.reused ? 200 : 201);
  } catch {
    console.error("[direct-entry] document reservation failed");
    return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);
  }
}
