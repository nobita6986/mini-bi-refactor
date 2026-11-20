import "server-only";

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { hasAnyValidPairedGrant } from "../auth/direct-entry-v2.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  inspectDocumentContent,
  sha256Hex,
} from "./document-r2-contract.ts";
import { DOCUMENT_MAX_BYTES } from "./document-upload-contract.ts";
import { sanitizeWorkerPortrait } from "./worker-portrait-sanitizer.ts";
import type { DocumentObjectStorage } from "./r2-document-storage.ts";
import type {
  createWorkerPortraitStageRepository,
} from "./worker-portrait-stage-repository.ts";

const MAX_MULTIPART_BYTES = DOCUMENT_MAX_BYTES + 64 * 1024;
const MAX_JSON_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Repository = ReturnType<typeof createWorkerPortraitStageRepository>;

export type WorkerPortraitStageApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: Repository;
  storage: DocumentObjectStorage;
};

function fail(code: string, status: number): Response {
  return Response.json({ ok: false, code }, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function boundedBody(
  request: Request,
  limit: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; kind: "invalid" | "too-large" }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, kind: "invalid" };
    if (length > limit) return { ok: false, kind: "too-large" };
  }
  if (!request.body) return { ok: false, kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function resolveUploadActor(
  dependencies: WorkerPortraitStageApiDependencies,
  requireCapability = true,
) {
  const session = await dependencies.resolveSession();
  if (!session.actor.ok) {
    return {
      ok: false as const,
      response: fail(session.actor.reason === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
        session.actor.reason === "UNAUTHENTICATED" ? 401 : 403),
    };
  }
  if (
    requireCapability &&
    !hasAnyValidPairedGrant(session.actor.actor, "document_upload", ["OWN", "ALL"])
  ) {
    return { ok: false as const, response: fail("DOCUMENT_DENIED", 403) };
  }
  const { auth_subject, app_user_id } = session.actor.actor;
  return { ok: true as const, actor: { auth_subject, app_user_id } };
}

export async function postWorkerPortraitStage(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerPortraitStageApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || !UUID.test(idempotencyKey)) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }

  const actor = await resolveUploadActor(dependencies);
  if (!actor.ok) return actor.response;
  if (!dependencies.storage.available()) return fail("DOCUMENT_STORAGE_UNAVAILABLE", 503);

  const bounded = await boundedBody(request, MAX_MULTIPART_BYTES);
  if (!bounded.ok) {
    return bounded.kind === "too-large"
      ? fail("BODY_TOO_LARGE", 413) : fail("BODY_INVALID", 400);
  }
  let form: FormData;
  try {
    const formRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type")! },
      body: Buffer.from(bounded.bytes),
    });
    form = await formRequest.formData();
  } catch {
    return fail("BODY_INVALID", 400);
  }
  const keys = [...form.keys()];
  const file = form.get("file");
  const requestedType = form.get("document_type");
  const documentType = requestedType === null ? "WORKER_PORTRAIT" : requestedType;
  if ((keys.length !== 1 && keys.length !== 2) || !keys.includes("file") ||
      (keys.length === 2 && !keys.includes("document_type")) || !(file instanceof File) ||
      (documentType !== "WORKER_PORTRAIT" && documentType !== "CCCD_FRONT" &&
        documentType !== "CCCD_BACK" && documentType !== "EMPLOYMENT_CONTRACT") ||
      (file.type !== "image/jpeg" && file.type !== "image/png" &&
        file.type !== "application/pdf") ||
      (documentType === "WORKER_PORTRAIT" && file.type === "application/pdf") ||
      file.size < 1 || file.size > DOCUMENT_MAX_BYTES) {
    return fail("DOCUMENT_REQUEST_INVALID", 400);
  }

  try {
    const original = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectDocumentContent({ document_type: documentType, mime_type: file.type, bytes: original });
    if (!inspected.ok) return fail(inspected.code, 422);
    const sanitized = documentType === "WORKER_PORTRAIT"
      ? await sanitizeWorkerPortrait(original, file.type as "image/jpeg" | "image/png")
      : { ok: true as const, bytes: original };
    if (!sanitized.ok) return fail("DOCUMENT_CONTENT_INVALID", 422);
    const sanitizedInspection = inspectDocumentContent({
      document_type: documentType, mime_type: file.type, bytes: sanitized.bytes,
    });
    if (!sanitizedInspection.ok) return fail(sanitizedInspection.code, 422);

    const checksum = sha256Hex(sanitized.bytes);
    const staged = await dependencies.repository.create({
      ...actor.actor,
      stage_id: randomUUID(),
      document_type: documentType,
      mime_type: file.type as "image/jpeg" | "image/png" | "application/pdf",
      size_bytes: sanitized.bytes.byteLength,
      checksum_sha256: checksum,
      idempotency_key: idempotencyKey.toLowerCase(),
    });
    if (!staged.ok) {
      return fail(
        staged.kind === "denied" ? "DOCUMENT_DENIED" :
          staged.kind === "conflict" ? "IDEMPOTENCY_CONFLICT" :
            staged.kind === "invalid" ? "DOCUMENT_REQUEST_INVALID" : "PORTRAIT_STAGE_UNAVAILABLE",
        staged.kind === "denied" ? 403 :
          staged.kind === "invalid" ? 400 :
            staged.kind === "conflict" ? 409 : 503);
    }
    const { stage, replayed } = staged.data;
    if (stage.status === "STAGED") {
      await dependencies.storage.writeEnrollmentPortraitStage({
        stage_id: stage.stage_id,
        mime_type: stage.mime_type,
        bytes: sanitized.bytes,
      });
    }
    return Response.json({
      ok: true,
      stage_id: stage.stage_id,
      document_type: stage.document_type,
      mime_type: stage.mime_type,
      size_bytes: stage.size_bytes,
      status: stage.status,
    }, { status: replayed ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error("[direct-entry] portrait staging failed");
    return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);
  }
}

export async function deleteWorkerPortraitStage(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerPortraitStageApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const bounded = await boundedBody(request, MAX_JSON_BYTES);
  if (!bounded.ok) return fail("BODY_INVALID", 400);
  let stageId: unknown;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !Object.hasOwn(body, "stage_id")) {
      return fail("DOCUMENT_REQUEST_INVALID", 400);
    }
    stageId = (body as Record<string, unknown>).stage_id;
  } catch {
    return fail("BODY_INVALID", 400);
  }
  if (typeof stageId !== "string" || !UUID.test(stageId)) {
    return fail("DOCUMENT_REQUEST_INVALID", 400);
  }

  const actor = await resolveUploadActor(dependencies, false);
  if (!actor.ok) return actor.response;
  try {
    const cancelled = await dependencies.repository.cancel({
      ...actor.actor,
      stage_id: stageId,
    });
    if (!cancelled.ok) {
      if (cancelled.kind === "denied") return fail("ENTRY_NOT_FOUND", 404);
      if (cancelled.kind === "conflict") return fail("DOCUMENT_VERSION_CONFLICT", 409);
      return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);
    }
    await dependencies.storage.deleteEnrollmentPortraitStage(stageId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error("[direct-entry] portrait stage cleanup failed");
    return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);
  }
}

export async function recoverWorkerPortraitStage(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerPortraitStageApiDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const bounded = await boundedBody(request, MAX_JSON_BYTES);
  if (!bounded.ok) return fail("BODY_INVALID", 400);
  let stageId: unknown;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !Object.hasOwn(body, "stage_id")) {
      return fail("DOCUMENT_REQUEST_INVALID", 400);
    }
    stageId = (body as Record<string, unknown>).stage_id;
  } catch {
    return fail("BODY_INVALID", 400);
  }
  if (typeof stageId !== "string" || !UUID.test(stageId)) {
    return fail("DOCUMENT_REQUEST_INVALID", 400);
  }

  const actor = await resolveUploadActor(dependencies, false);
  if (!actor.ok) return actor.response;
  try {
    const recovered = await dependencies.repository.recover({
      ...actor.actor,
      stage_id: stageId,
    });
    if (!recovered.ok) {
      if (recovered.kind === "denied") return fail("ENTRY_NOT_FOUND", 404);
      if (recovered.kind === "conflict") return fail("DOCUMENT_VERSION_CONFLICT", 409);
      return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);
    }
    const stage = recovered.data;
    if (stage.status === "ATTACHED" || stage.status === "CANCELLED") {
      await dependencies.storage.deleteEnrollmentPortraitStage(stage.stage_id);
    }
    return Response.json({
      ok: true,
      stage_id: stage.stage_id,
      status: stage.status,
      idempotency_key: stage.status === "CLAIMED" ? stage.claim_idempotency_key : null,
    }, { status: 200, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error("[direct-entry] portrait stage recovery failed");
    return fail("PORTRAIT_STAGE_UNAVAILABLE", 503);
  }
}
