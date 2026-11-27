import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  BULLETIN_CMS_MAX_BODY_BYTES,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_READ_MAX_BODY_BYTES,
  BulletinValidationError,
  bulletinHttpStatusForError,
  containsForbiddenClientAuthorityKey,
  isPlainRecord,
  parseBulletinArchiveQuery,
  parseBulletinFeedQuery,
  readBoundedJsonBody,
  validateCreateBulletinBody,
  validateIdempotencyKeyHeader,
  validateLifecycleActionBody,
  validatePinBulletinBody,
  validateRowVersion,
  validateUpdateBulletinBody,
  type BulletinErrorCode,
  type BulletinStatus,
} from "./contract.ts";
import type { BulletinRepository } from "./repository.ts";
import {
  inspectBulletinAttachment,
  type BulletinStorage,
} from "./storage.ts";

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

const ATTACHMENT_UPLOAD_ALLOWED_FIELDS = new Set([
  "file",
  "title",
  "expected_row_version",
]);

const SINGLE_LINE_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

export type BulletinApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: BulletinRepository;
  storage?: BulletinStorage;
};

type TrustedActor = {
  auth_subject: string;
  app_user_id: string;
};

function bulletinError(code: BulletinErrorCode, status?: number): Response {
  return failJson(code, status ?? bulletinHttpStatusForError(code));
}

function bulletinOk<T>(data: T, status = 200): Response {
  return noStoreJson({ ok: true, data }, status);
}

function directEntryFeatureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : bulletinError("NOT_FOUND");
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

function assertNoQueryParams(url: URL): void {
  if (!url.searchParams.keys().next().done) {
    throw new BulletinValidationError(
      "BULLETIN_QUERY_INVALID",
      "Query parameters are not allowed on this endpoint",
    );
  }
}

function buildInlineContentDisposition(rawFileName: string): string {
  const cleanUtf8 = rawFileName.replace(/[\x00-\x1f\x7f"\\/;]/g, "_").trim() || "attachment";
  const asciiFallback =
    cleanUtf8
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .trim() || "attachment";
  if (asciiFallback === cleanUtf8) {
    return `inline; filename="${asciiFallback}"`;
  }
  const encoded = encodeURIComponent(cleanUtf8).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function errorResponseFromCaught(error: unknown): Response {
  if (error instanceof BulletinValidationError) {
    return bulletinError(error.code, error.status);
  }
  return bulletinError("BULLETIN_UNAVAILABLE");
}

function hashCanonicalRequest(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function checkGuards(
  request: Request,
  enabledFlag: string | undefined,
  options: { requireSameOrigin?: boolean } = {},
): Response | null {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (options.requireSameOrigin && !isSameOriginAuthRequest(request)) {
    return bulletinError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return bulletinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  return null;
}

async function resolveBulletinActor(
  dependencies: BulletinApiDependencies,
): Promise<{ ok: true; actor: TrustedActor } | { ok: false; response: Response }> {
  let session: DirectEntrySessionResult;
  try {
    session = await dependencies.resolveSession();
  } catch {
    console.error("[bulletins] session resolution failed");
    return { ok: false, response: bulletinError("BULLETIN_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? bulletinError("UNAUTHENTICATED")
          : bulletinError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: bulletinError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    actor: {
      auth_subject: actor.auth_subject.toLowerCase(),
      app_user_id: actor.app_user_id.toLowerCase(),
    },
  };
}

async function readAndGuardJsonBody(
  request: Request,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const parsed = await readBoundedJsonBody(request, maxBytes, options);
  if (containsForbiddenClientAuthorityKey(parsed)) {
    throw new BulletinValidationError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  return parsed;
}

function matchesIfNoneMatch(headerValue: string | null, quotedEtag: string): boolean {
  if (!headerValue) return false;
  const rawSha = quotedEtag.slice(1, -1);
  return headerValue
    .split(",")
    .map((part) => part.trim())
    .some((candidate) => {
      if (candidate === "*") return true;
      const normalized = candidate.startsWith("W/")
        ? candidate.slice(2).trim()
        : candidate;
      return normalized === quotedEtag || normalized === rawSha;
    });
}

// -----------------------------------------------------------------------------
// 1. GET /api/bulletins (Mobile Feed)
// -----------------------------------------------------------------------------
export async function handleBulletinMobileFeed(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag);
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");

  let query;
  try {
    query = parseBulletinFeedQuery(url.searchParams);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const result = await dependencies.repository.listMobileFeed({
      ...actorOutcome.actor,
      ...query,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(
      {
        items: result.data.items,
        unread_count: result.data.unread_count,
        latest_published_at: result.data.latest_published_at,
        page_size: result.data.page_size,
        has_more: result.data.has_more,
        next_cursor: result.data.next_cursor,
      },
      200,
    );
  } catch {
    console.error("[bulletins] listMobileFeed failed");
    return bulletinError("BULLETIN_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 2. GET /api/bulletins/[bulletinId]
// -----------------------------------------------------------------------------
async function handleBulletinDetailInternal(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
  allowNonPublished: boolean,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag);
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const result = await dependencies.repository.getDetail({
      ...actorOutcome.actor,
      bulletin_id: bulletinId.toLowerCase(),
      allow_non_published: allowNonPublished,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk({ item: result.data.item }, 200);
  } catch {
    console.error("[bulletins] getDetail failed");
    return bulletinError("BULLETIN_UNAVAILABLE");
  }
}

export async function handleBulletinDetail(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  return handleBulletinDetailInternal(
    request,
    bulletinId,
    enabledFlag,
    dependencies,
    false,
  );
}

// -----------------------------------------------------------------------------
// 3. POST /api/bulletins/[bulletinId]/read
// -----------------------------------------------------------------------------
export async function handleBulletinMarkRead(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const body = await readAndGuardJsonBody(request, BULLETIN_READ_MAX_BODY_BYTES, {
      allowEmpty: true,
    });
    if (!isPlainRecord(body)) {
      return bulletinError("INVALID_JSON");
    }
    if (Object.keys(body).length > 0) {
      return bulletinError("BULLETIN_VALIDATION_ERROR");
    }

    const result = await dependencies.repository.markRead({
      ...actorOutcome.actor,
      bulletin_id: bulletinId.toLowerCase(),
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(
      {
        bulletin_id: result.data.bulletin_id,
        is_read: true as const,
        unread_count: result.data.unread_count,
      },
      200,
    );
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 4. POST /api/bulletins/read-all
// -----------------------------------------------------------------------------
export async function handleBulletinMarkAllRead(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const body = await readAndGuardJsonBody(request, BULLETIN_READ_MAX_BODY_BYTES, {
      allowEmpty: true,
    });
    if (!isPlainRecord(body)) {
      return bulletinError("INVALID_JSON");
    }
    if (Object.keys(body).length > 0) {
      return bulletinError("BULLETIN_VALIDATION_ERROR");
    }

    const result = await dependencies.repository.markAllRead(actorOutcome.actor);
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk({ unread_count: 0 as const }, 200);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 5. GET /api/bulletins/[bulletinId]/attachments/[attachmentId]/content
// -----------------------------------------------------------------------------
export async function handleBulletinAttachmentContent(
  request: Request,
  bulletinId: string,
  attachmentId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag);
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }
  if (!isUuid(attachmentId)) {
    return bulletinError("BULLETIN_ATTACHMENT_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  if (!dependencies.storage || !dependencies.storage.available()) {
    return bulletinError("BULLETIN_STORAGE_UNAVAILABLE");
  }

  try {
    const metaOutcome = await dependencies.repository.getAttachmentContentMeta({
      ...actorOutcome.actor,
      bulletin_id: bulletinId.toLowerCase(),
      attachment_id: attachmentId.toLowerCase(),
    });
    if (!metaOutcome.ok) return bulletinError(metaOutcome.code);

    const meta = metaOutcome.data;
    const etag = `"${meta.sha256}"`;

    if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          Vary: "Cookie",
        },
      });
    }

    const stored = await dependencies.storage.getAttachment(meta.storage_key);
    if (!stored) {
      return bulletinError("BULLETIN_ATTACHMENT_NOT_FOUND");
    }

    const actualSha256 = createHash("sha256")
      .update(stored.bytes)
      .digest("hex");
    if (
      stored.bytes.byteLength !== meta.file_size_bytes ||
      actualSha256 !== meta.sha256
    ) {
      console.error("[bulletins] attachment object integrity mismatch");
      return bulletinError("BULLETIN_STORAGE_UNAVAILABLE");
    }

    return new Response(Buffer.from(stored.bytes), {
      status: 200,
      headers: {
        "Content-Type": meta.mime_type,
        "Content-Length": String(stored.bytes.byteLength),
        ETag: etag,
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": buildInlineContentDisposition(meta.file_name),
        Vary: "Cookie",
      },
    });
  } catch {
    console.error("[bulletins] attachment content fetch failed");
    return bulletinError("BULLETIN_STORAGE_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 6. GET /api/bulletins/archive
// -----------------------------------------------------------------------------
export async function handleBulletinArchiveList(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag);
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");

  let query;
  try {
    query = parseBulletinArchiveQuery(url.searchParams);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const result = await dependencies.repository.listArchive({
      ...actorOutcome.actor,
      ...query,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(result.data, 200);
  } catch {
    console.error("[bulletins] listArchive failed");
    return bulletinError("BULLETIN_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 7. GET /api/admin/bulletins
// -----------------------------------------------------------------------------
export async function handleAdminBulletinList(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag);
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");

  let query;
  try {
    query = parseBulletinArchiveQuery(url.searchParams);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    // Pass status="ALL" when omitted so PostgreSQL enforces bulletin_manage authority.
    const result = await dependencies.repository.listArchive({
      ...actorOutcome.actor,
      ...query,
      status: query.status ?? "ALL",
    });
    if (!result.ok) return bulletinError(result.code);
    if (!result.data.can_manage) {
      return bulletinError("BULLETIN_FORBIDDEN");
    }
    return bulletinOk(result.data, 200);
  } catch {
    console.error("[bulletins] admin list failed");
    return bulletinError("BULLETIN_UNAVAILABLE");
  }
}

// -----------------------------------------------------------------------------
// 8. POST /api/admin/bulletins
// -----------------------------------------------------------------------------
export async function handleAdminBulletinCreate(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );
    const body = await readAndGuardJsonBody(request, BULLETIN_CMS_MAX_BODY_BYTES);
    const payload = validateCreateBulletinBody(body);
    const requestHash = hashCanonicalRequest(payload);

    const result = await dependencies.repository.createAdmin({
      ...actorOutcome.actor,
      ...payload,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(result.data, result.data.replayed ? 200 : 201);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 9. GET /api/admin/bulletins/[bulletinId]
// -----------------------------------------------------------------------------
export async function handleAdminBulletinDetail(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  return handleBulletinDetailInternal(
    request,
    bulletinId,
    enabledFlag,
    dependencies,
    true,
  );
}

// -----------------------------------------------------------------------------
// 10. PATCH /api/admin/bulletins/[bulletinId]
// -----------------------------------------------------------------------------
export async function handleAdminBulletinUpdate(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );
    const body = await readAndGuardJsonBody(request, BULLETIN_CMS_MAX_BODY_BYTES);
    const payload = validateUpdateBulletinBody(body);
    const normalizedBulletinId = bulletinId.toLowerCase();
    const requestHash = hashCanonicalRequest({
      bulletin_id: normalizedBulletinId,
      ...payload,
    });

    const result = await dependencies.repository.updateAdmin({
      ...actorOutcome.actor,
      bulletin_id: normalizedBulletinId,
      ...payload,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(result.data, 200);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 11 & 12. POST /api/admin/bulletins/[bulletinId]/publish & /archive
// -----------------------------------------------------------------------------
async function handleAdminBulletinStatusTransition(
  request: Request,
  bulletinId: string,
  targetStatus: Extract<BulletinStatus, "PUBLISHED" | "ARCHIVED">,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );
    const body = await readAndGuardJsonBody(request, BULLETIN_CMS_MAX_BODY_BYTES);
    const payload = validateLifecycleActionBody(body);
    const normalizedBulletinId = bulletinId.toLowerCase();
    const requestHash = hashCanonicalRequest({
      bulletin_id: normalizedBulletinId,
      target_status: targetStatus,
      expected_row_version: payload.expected_row_version,
    });

    const result = await dependencies.repository.setStatusAdmin({
      ...actorOutcome.actor,
      bulletin_id: normalizedBulletinId,
      target_status: targetStatus,
      expected_row_version: payload.expected_row_version,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(result.data, 200);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

export async function handleAdminBulletinPublish(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  return handleAdminBulletinStatusTransition(
    request,
    bulletinId,
    "PUBLISHED",
    enabledFlag,
    dependencies,
  );
}

export async function handleAdminBulletinArchive(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  return handleAdminBulletinStatusTransition(
    request,
    bulletinId,
    "ARCHIVED",
    enabledFlag,
    dependencies,
  );
}

// -----------------------------------------------------------------------------
// 13. POST /api/admin/bulletins/[bulletinId]/pin
// -----------------------------------------------------------------------------
export async function handleAdminBulletinPin(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );
    const body = await readAndGuardJsonBody(request, BULLETIN_CMS_MAX_BODY_BYTES);
    const payload = validatePinBulletinBody(body);
    const normalizedBulletinId = bulletinId.toLowerCase();
    const requestHash = hashCanonicalRequest({
      bulletin_id: normalizedBulletinId,
      ...payload,
    });

    const result = await dependencies.repository.setPinnedAdmin({
      ...actorOutcome.actor,
      bulletin_id: normalizedBulletinId,
      is_pinned: payload.is_pinned,
      expected_row_version: payload.expected_row_version,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.ok) return bulletinError(result.code);
    return bulletinOk(result.data, 200);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 14. POST /api/admin/bulletins/[bulletinId]/attachments
// -----------------------------------------------------------------------------
export async function handleAdminBulletinAttachmentUpload(
  request: Request,
  bulletinId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");
  try {
    assertNoQueryParams(url);
  } catch (error) {
    return errorResponseFromCaught(error);
  }

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  if (!dependencies.storage || !dependencies.storage.available()) {
    return bulletinError("BULLETIN_STORAGE_UNAVAILABLE");
  }

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );

    const contentType =
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "multipart/form-data") {
      return bulletinError("BULLETIN_ATTACHMENT_INVALID");
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
      if (
        Number(declaredLength.trim()) >
        BULLETIN_MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES
      ) {
        return bulletinError("BULLETIN_ATTACHMENT_TOO_LARGE");
      }
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return bulletinError("BULLETIN_ATTACHMENT_INVALID");
    }

    const keyProbe: Record<string, true> = {};
    for (const key of formData.keys()) {
      keyProbe[key] = true;
    }
    if (containsForbiddenClientAuthorityKey(keyProbe)) {
      return bulletinError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
    }
    for (const key of Object.keys(keyProbe)) {
      if (!ATTACHMENT_UPLOAD_ALLOWED_FIELDS.has(key)) {
        return bulletinError("BULLETIN_VALIDATION_ERROR");
      }
    }

    const versionValues = formData.getAll("expected_row_version");
    if (versionValues.length !== 1 || typeof versionValues[0] !== "string") {
      return bulletinError("BULLETIN_VALIDATION_ERROR");
    }
    const trimmedVersion = versionValues[0].trim();
    if (!/^[1-9]\d{0,9}$/.test(trimmedVersion)) {
      return bulletinError("BULLETIN_VALIDATION_ERROR");
    }
    const expectedRowVersion = validateRowVersion(Number(trimmedVersion));

    const titleValues = formData.getAll("title");
    if (titleValues.length > 1) {
      return bulletinError("BULLETIN_ATTACHMENT_INVALID");
    }
    let explicitTitle: string | null = null;
    if (titleValues.length === 1) {
      const rawTitle = titleValues[0];
      if (typeof rawTitle !== "string") {
        return bulletinError("BULLETIN_ATTACHMENT_INVALID");
      }
      const trimmedTitle = rawTitle.trim();
      if (trimmedTitle.length > 0) {
        if (
          trimmedTitle.length > 255 ||
          SINGLE_LINE_CONTROL_CHAR_PATTERN.test(trimmedTitle)
        ) {
          return bulletinError("BULLETIN_ATTACHMENT_INVALID");
        }
        explicitTitle = trimmedTitle;
      }
    }

    const fileValues = formData.getAll("file");
    if (fileValues.length !== 1) {
      return bulletinError("BULLETIN_ATTACHMENT_INVALID");
    }
    const fileEntry = fileValues[0];
    if (
      typeof fileEntry === "string" ||
      typeof (fileEntry as Blob).arrayBuffer !== "function"
    ) {
      return bulletinError("BULLETIN_ATTACHMENT_INVALID");
    }

    const fileBlob = fileEntry as File;
    const rawBytes = Buffer.from(await fileBlob.arrayBuffer());
    const inspected = await inspectBulletinAttachment({
      bytes: rawBytes,
      fileName: typeof fileBlob.name === "string" ? fileBlob.name : null,
      declaredMimeType: typeof fileBlob.type === "string" ? fileBlob.type : null,
    });

    const normalizedBulletinId = bulletinId.toLowerCase();
    const title = explicitTitle ?? inspected.file_name;

    // Verify manage authority and bulletin existence before writing bytes to object storage.
    const preflight = await dependencies.repository.getDetail({
      ...actorOutcome.actor,
      bulletin_id: normalizedBulletinId,
      allow_non_published: true,
    });
    if (!preflight.ok) {
      return bulletinError(preflight.code);
    }

    const attachmentId = randomUUID();
    const storageKey = dependencies.storage.buildObjectKey(
      normalizedBulletinId,
      attachmentId,
      inspected.mime_type,
    );

    try {
      await dependencies.storage.putAttachment({
        storage_key: storageKey,
        mime_type: inspected.mime_type,
        bytes: rawBytes,
      });
    } catch {
      console.error("[bulletins] attachment storage upload failed");
      return bulletinError("BULLETIN_STORAGE_UNAVAILABLE");
    }

    const requestHash = hashCanonicalRequest({
      bulletin_id: normalizedBulletinId,
      expected_row_version: expectedRowVersion,
      kind: inspected.kind,
      file_name: inspected.file_name,
      title,
      mime_type: inspected.mime_type,
      file_size_bytes: inspected.file_size_bytes,
      sha256: inspected.sha256,
    });

    let rpcOutcome;
    try {
      rpcOutcome = await dependencies.repository.attachFileAdmin({
        ...actorOutcome.actor,
        bulletin_id: normalizedBulletinId,
        expected_row_version: expectedRowVersion,
        attachment_id: attachmentId,
        kind: inspected.kind,
        file_name: inspected.file_name,
        title,
        mime_type: inspected.mime_type,
        file_size_bytes: inspected.file_size_bytes,
        storage_key: storageKey,
        width: inspected.width,
        height: inspected.height,
        page_count: inspected.page_count,
        sha256: inspected.sha256,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
      });
    } catch {
      await dependencies.storage.deleteAttachment(storageKey).catch(() => undefined);
      return bulletinError("BULLETIN_UNAVAILABLE");
    }

    if (!rpcOutcome.ok) {
      await dependencies.storage.deleteAttachment(storageKey).catch(() => undefined);
      return bulletinError(rpcOutcome.code);
    }

    if (rpcOutcome.data.replayed) {
      await dependencies.storage.deleteAttachment(storageKey).catch(() => undefined);
      return bulletinOk(rpcOutcome.data, 200);
    }

    return bulletinOk(rpcOutcome.data, 201);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}

// -----------------------------------------------------------------------------
// 15. DELETE /api/admin/bulletins/[bulletinId]/attachments/[attachmentId]
// -----------------------------------------------------------------------------
export async function handleAdminBulletinAttachmentDelete(
  request: Request,
  bulletinId: string,
  attachmentId: string,
  enabledFlag: string | undefined,
  dependencies: BulletinApiDependencies,
): Promise<Response> {
  const guardFailure = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guardFailure) return guardFailure;

  const url = parseRequestUrl(request);
  if (!url) return bulletinError("BULLETIN_QUERY_INVALID");

  if (!isUuid(bulletinId)) {
    return bulletinError("BULLETIN_NOT_FOUND");
  }
  if (!isUuid(attachmentId)) {
    return bulletinError("BULLETIN_ATTACHMENT_NOT_FOUND");
  }

  const actorOutcome = await resolveBulletinActor(dependencies);
  if (!actorOutcome.ok) return actorOutcome.response;

  try {
    const idempotencyKey = validateIdempotencyKeyHeader(
      request.headers.get("idempotency-key"),
    );

    let expectedRowVersion: number;
    const rawQueryVersion = url.searchParams.get("expected_row_version");
    const hasAnyQuery = Array.from(url.searchParams.keys()).length > 0;

    const rawBody = await readAndGuardJsonBody(
      request,
      BULLETIN_READ_MAX_BODY_BYTES,
      { allowEmpty: true },
    );

    if (isPlainRecord(rawBody) && Object.keys(rawBody).length > 0) {
      if (hasAnyQuery) {
        return bulletinError("BULLETIN_QUERY_INVALID");
      }
      expectedRowVersion = validateLifecycleActionBody(rawBody).expected_row_version;
    } else if (rawQueryVersion !== null) {
      for (const key of url.searchParams.keys()) {
        if (key !== "expected_row_version") {
          return bulletinError("BULLETIN_QUERY_INVALID");
        }
      }
      if (!/^[1-9]\d{0,9}$/.test(rawQueryVersion.trim())) {
        return bulletinError("BULLETIN_VALIDATION_ERROR");
      }
      expectedRowVersion = validateRowVersion(Number(rawQueryVersion.trim()));
    } else {
      return bulletinError("BULLETIN_VALIDATION_ERROR");
    }

    const normalizedBulletinId = bulletinId.toLowerCase();
    const normalizedAttachmentId = attachmentId.toLowerCase();
    const requestHash = hashCanonicalRequest({
      bulletin_id: normalizedBulletinId,
      attachment_id: normalizedAttachmentId,
      expected_row_version: expectedRowVersion,
    });

    const result = await dependencies.repository.deleteAttachmentAdmin({
      ...actorOutcome.actor,
      bulletin_id: normalizedBulletinId,
      attachment_id: normalizedAttachmentId,
      expected_row_version: expectedRowVersion,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
    });
    if (!result.ok) return bulletinError(result.code);

    if (
      !result.data.replayed &&
      result.data.deleted_storage_key &&
      dependencies.storage?.available()
    ) {
      await dependencies.storage
        .deleteAttachment(result.data.deleted_storage_key)
        .catch(() => undefined);
    }

    return bulletinOk(result.data, 200);
  } catch (error) {
    return errorResponseFromCaught(error);
  }
}
