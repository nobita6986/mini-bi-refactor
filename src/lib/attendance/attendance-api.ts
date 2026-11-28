import "server-only";

import { Buffer } from "node:buffer";
import sharp from "sharp";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { inspectDocumentContent, sha256Hex } from "../direct-entry/document-r2-contract.ts";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MULTIPART_OVERHEAD_BYTES,
} from "../direct-entry/document-upload-contract.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import { isAttendanceEnabled, loadAttendanceSigningSecret } from "./attendance-config.ts";
import {
  ATTENDANCE_CLIENT_TIME_SKEW_TOLERANCE_MS,
  ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS,
  ATTENDANCE_MAX_SYNC_WINDOW_MS,
  ATTENDANCE_PHOTO_MIME_TYPE,
  attendanceHttpStatusForError,
  computeAttendanceRequestFingerprint,
  parseAttendanceCheckInMetadata,
  type AttendanceErrorCode,
} from "./attendance-contract.ts";
import type { AttendanceRepository } from "./attendance-repository.ts";
import type { AttendanceObjectStorage } from "./r2-attendance-storage.ts";
import { issueAttendanceTimeToken, verifyAttendanceTimeToken } from "./time-token.ts";

const MAX_MULTIPART_BYTES = DOCUMENT_MAX_BYTES + DOCUMENT_MULTIPART_OVERHEAD_BYTES;
const MAX_DECODED_JPEG_PIXELS = 40_000_000;

const DISALLOWED_CLIENT_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-client-time",
  "x-captured-at",
] as const;

export type AttendanceTimeApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  now?: () => number;
};

export type AttendanceCheckInApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AttendanceRepository;
  storage: AttendanceObjectStorage;
  now?: () => number;
};

function attendanceError(code: AttendanceErrorCode): Response {
  return failJson(code, attendanceHttpStatusForError(code));
}

function hasDisallowedAuthorityQueryOrHeaders(request: Request): boolean {
  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return true;
    }
  } catch {
    return true;
  }

  for (const headerName of DISALLOWED_CLIENT_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveAttendanceActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | { ok: true; actor: { auth_subject: string; app_user_id: string } }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[attendance] session resolution failed");
    return { ok: false, response: attendanceError("ATTENDANCE_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? attendanceError("UNAUTHENTICATED")
          : attendanceError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (!actor || actor.partner_account !== undefined || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: attendanceError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    actor: {
      auth_subject: actor.auth_subject.toLowerCase(),
      app_user_id: actor.app_user_id.toLowerCase(),
    },
  };
}

async function readBoundedMultipartBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmedLength = declaredLength.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmedLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
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
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined };
}

async function verifyRealJpegWithoutReencoding(bytes: Uint8Array): Promise<boolean> {
  const contentInspection = inspectDocumentContent({
    document_type: "WORKER_PORTRAIT",
    mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
    bytes,
  });
  if (!contentInspection.ok) {
    return false;
  }

  try {
    const decoder = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_JPEG_PIXELS,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "jpeg" ||
      (metadata.pages ?? 1) !== 1 ||
      typeof metadata.width !== "number" ||
      metadata.width < 1 ||
      typeof metadata.height !== "number" ||
      metadata.height < 1
    ) {
      return false;
    }

    const decodedPixels = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_JPEG_PIXELS,
    })
      .raw()
      .toBuffer();

    return decodedPixels.byteLength >= 1;
  } catch {
    return false;
  }
}

export async function getAttendanceTime(
  request: Request,
  env: Record<string, string | undefined>,
  dependencies: AttendanceTimeApiDependencies,
): Promise<Response> {
  if (!isAttendanceEnabled(env)) {
    return attendanceError("NOT_FOUND");
  }

  const secretResult = loadAttendanceSigningSecret(env);
  if (!secretResult.ok) {
    return attendanceError("ATTENDANCE_CONFIG_REQUIRED");
  }

  if (hasDisallowedAuthorityQueryOrHeaders(request)) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const actorResult = await resolveAttendanceActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  try {
    const nowMs = Math.trunc(dependencies.now ? dependencies.now() : Date.now());
    const issued = issueAttendanceTimeToken({
      secret: secretResult.secret,
      app_user_id: actorResult.actor.app_user_id,
      now_ms: nowMs,
    });

    return noStoreJson(
      {
        ok: true,
        server_time: issued.server_time,
        expires_at: issued.expires_at,
        time_token: issued.time_token,
      },
      200,
    );
  } catch {
    console.error("[attendance] failed to issue time anchor token");
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }
}

export async function postAttendanceCheckIn(
  request: Request,
  env: Record<string, string | undefined>,
  dependencies: AttendanceCheckInApiDependencies,
): Promise<Response> {
  if (!isAttendanceEnabled(env)) {
    return attendanceError("NOT_FOUND");
  }

  const secretResult = loadAttendanceSigningSecret(env);
  if (!secretResult.ok) {
    return attendanceError("ATTENDANCE_CONFIG_REQUIRED");
  }

  if (!isSameOriginAuthRequest(request)) {
    return attendanceError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityQueryOrHeaders(request)) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const contentType = request.headers.get("content-type");
  if (
    !contentType ||
    !contentType.toLowerCase().startsWith("multipart/form-data;") ||
    !contentType.toLowerCase().includes("boundary=")
  ) {
    return attendanceError("CONTENT_TYPE_INVALID");
  }

  const rawIdempotencyHeader = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!isUuid(rawIdempotencyHeader)) {
    return attendanceError("IDEMPOTENCY_KEY_INVALID");
  }

  const actorResult = await resolveAttendanceActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!dependencies.storage.available()) {
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  const boundedBody = await readBoundedMultipartBody(request, MAX_MULTIPART_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? attendanceError("BODY_TOO_LARGE")
      : attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  let form: FormData;
  try {
    const multipartRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: Buffer.from(boundedBody.bytes),
    });
    form = await multipartRequest.formData();
  } catch {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const entries = [...form.entries()];
  if (entries.length !== 2) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  let rawMetadataValue: string | null = null;
  let photoFile: File | null = null;

  for (const [partName, partValue] of entries) {
    if (partName === "metadata" && rawMetadataValue === null && typeof partValue === "string") {
      rawMetadataValue = partValue;
    } else if (partName === "photo" && photoFile === null && partValue instanceof File) {
      photoFile = partValue;
    } else {
      return attendanceError("ATTENDANCE_REQUEST_INVALID");
    }
  }

  if (rawMetadataValue === null || photoFile === null) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const parsedMetadata = parseAttendanceCheckInMetadata({
    raw_metadata_json: rawMetadataValue,
    header_idempotency_key: rawIdempotencyHeader,
  });
  if (!parsedMetadata.ok) {
    return attendanceError(parsedMetadata.code);
  }

  const meta = parsedMetadata.data;
  const nowMs = Math.trunc(dependencies.now ? dependencies.now() : Date.now());

  let timeAnchorIssuedAtIso: string | null = null;
  let elapsedSinceAnchorMs: number | null = null;
  let timeTokenDigest: string | null = null;
  let isSyncWindowExpired = false;

  if (meta.time_source === "SERVER_ANCHORED") {
    const verifiedToken = verifyAttendanceTimeToken({
      secret: secretResult.secret,
      token: meta.time_token,
      expected_app_user_id: actorResult.actor.app_user_id,
      now_ms: nowMs,
      allow_expired_anchor: true,
    });
    if (!verifiedToken.ok) {
      return attendanceError(verifiedToken.code);
    }

    const serverComputedCapturedAtMs = verifiedToken.issued_at_ms + meta.elapsed_since_anchor_ms;
    if (
      Math.abs(meta.device_claimed_at_ms - serverComputedCapturedAtMs) >
      ATTENDANCE_CLIENT_TIME_SKEW_TOLERANCE_MS
    ) {
      return attendanceError("ATTENDANCE_TIME_MISMATCH");
    }

    if (
      verifiedToken.issued_at_ms > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS ||
      serverComputedCapturedAtMs > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS ||
      meta.device_claimed_at_ms > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS
    ) {
      return attendanceError("CAPTURED_AT_FUTURE");
    }

    isSyncWindowExpired = nowMs - serverComputedCapturedAtMs > ATTENDANCE_MAX_SYNC_WINDOW_MS;

    timeAnchorIssuedAtIso = verifiedToken.issued_at_iso;
    elapsedSinceAnchorMs = meta.elapsed_since_anchor_ms;
    timeTokenDigest = verifiedToken.token_digest;
  } else {
    if (meta.device_claimed_at_ms > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS) {
      return attendanceError("CAPTURED_AT_FUTURE");
    }
  }

  if (photoFile.size > DOCUMENT_MAX_BYTES) {
    return attendanceError("BODY_TOO_LARGE");
  }
  if (photoFile.size < 1) {
    return attendanceError("PHOTO_INVALID");
  }

  const normalizedPartMime = photoFile.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedPartMime !== ATTENDANCE_PHOTO_MIME_TYPE) {
    return attendanceError("PHOTO_INVALID");
  }

  let photoBytes: Uint8Array;
  try {
    photoBytes = new Uint8Array(await photoFile.arrayBuffer());
  } catch {
    return attendanceError("PHOTO_INVALID");
  }

  if (photoBytes.byteLength > DOCUMENT_MAX_BYTES) {
    return attendanceError("BODY_TOO_LARGE");
  }
  if (photoBytes.byteLength < 1) {
    return attendanceError("PHOTO_INVALID");
  }

  const isRealJpeg = await verifyRealJpegWithoutReencoding(photoBytes);
  if (!isRealJpeg) {
    return attendanceError("PHOTO_INVALID");
  }

  const computedPhotoSha256 = sha256Hex(photoBytes);
  if (computedPhotoSha256 !== meta.photo_sha256) {
    return attendanceError("PHOTO_HASH_MISMATCH");
  }

  const requestFingerprint = computeAttendanceRequestFingerprint({
    app_user_id: actorResult.actor.app_user_id,
    latitude: meta.latitude,
    longitude: meta.longitude,
    accuracy_meters: meta.accuracy_meters,
    address_hint: meta.address_hint,
    note: meta.note,
    device_claimed_at_ms: meta.device_claimed_at_ms,
    time_source: meta.time_source,
    time_token_digest: timeTokenDigest,
    elapsed_since_anchor_ms: elapsedSinceAnchorMs,
    photo_sha256: computedPhotoSha256,
    photo_size_bytes: photoBytes.byteLength,
    photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
  });

  // Check committed DB idempotency BEFORE enforcing the 168-hour sync cutoff and BEFORE R2 upload:
  // - Same actor + idempotency_key + matching fingerprint replays the committed record (`200`),
  //   even when retried > 168 hours later after a lost initial HTTP response.
  // - Same actor + idempotency_key + different fingerprint returns `409 IDEMPOTENCY_CONFLICT`.
  // - Uncommitted key past 168 hours returns `422 ATTENDANCE_SYNC_WINDOW_EXPIRED` without
  //   uploading any photo to R2 or inserting any row into DB.
  let existingCheckIn: Awaited<ReturnType<AttendanceRepository["lookupCheckInIdempotency"]>>;
  try {
    existingCheckIn = await dependencies.repository.lookupCheckInIdempotency({
      auth_subject: actorResult.actor.auth_subject,
      app_user_id: actorResult.actor.app_user_id,
      idempotency_key: meta.idempotency_key,
      request_fingerprint: requestFingerprint,
    });
  } catch {
    console.error("[attendance] idempotency lookup failed");
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  if (!existingCheckIn.ok) {
    return attendanceError(existingCheckIn.code);
  }

  if (existingCheckIn.found) {
    return noStoreJson(
      {
        ok: true,
        checkin: existingCheckIn.checkin,
      },
      200,
    );
  }

  if (isSyncWindowExpired) {
    return attendanceError("ATTENDANCE_SYNC_WINDOW_EXPIRED");
  }

  let ensuredPhoto: Awaited<ReturnType<AttendanceObjectStorage["ensureCheckInPhoto"]>>;
  try {
    ensuredPhoto = await dependencies.storage.ensureCheckInPhoto({
      app_user_id: actorResult.actor.app_user_id,
      idempotency_key: meta.idempotency_key,
      photo_sha256: computedPhotoSha256,
      bytes: photoBytes,
    });
  } catch {
    console.error("[attendance] R2 photo write failed");
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  if (!ensuredPhoto.ok) {
    return attendanceError("IDEMPOTENCY_CONFLICT");
  }

  const cleanupUncommittedPhoto = async (reason: string) => {
    if (!ensuredPhoto.ok || !ensuredPhoto.created_now) {
      return;
    }
    try {
      await dependencies.storage.deleteNewlyCreatedCheckInPhoto(ensuredPhoto.storage_key);
    } catch {
      console.error(`[attendance] failed to clean up uncommitted photo (${reason})`);
    }
  };

  const recoverOrCleanupAfterAmbiguousWriteError = async (reason: string): Promise<Response> => {
    let postFailureLookup: Awaited<
      ReturnType<AttendanceRepository["lookupCheckInIdempotency"]>
    >;
    try {
      postFailureLookup = await dependencies.repository.lookupCheckInIdempotency({
        auth_subject: actorResult.actor.auth_subject,
        app_user_id: actorResult.actor.app_user_id,
        idempotency_key: meta.idempotency_key,
        request_fingerprint: requestFingerprint,
      });
    } catch {
      // Commit outcome is unknown because both write and lookup failed over transport:
      // preserve the uploaded R2 photo so a potentially committed row never loses its object,
      // and return retryable 503.
      return attendanceError("ATTENDANCE_UNAVAILABLE");
    }

    if (postFailureLookup.ok) {
      if (!postFailureLookup.found) {
        // Lookup authoritatively confirmed no row exists in DB: safe to clean up temp photo.
        await cleanupUncommittedPhoto(`${reason}-confirmed-absent`);
        return attendanceError("ATTENDANCE_UNAVAILABLE");
      }

      // Lookup found a committed row with matching fingerprint:
      // - Keep the photo if it is the exact object referenced by the committed row.
      // - Clean up ONLY when `photo_storage_key` proves a different concurrent identical
      //   request won the DB insert, making this request's object a surplus duplicate.
      if (postFailureLookup.photo_storage_key !== ensuredPhoto.storage_key) {
        await cleanupUncommittedPhoto(`${reason}-surplus-duplicate`);
      }

      return noStoreJson(
        {
          ok: true,
          checkin: postFailureLookup.checkin,
        },
        200,
      );
    }

    if (postFailureLookup.code === "IDEMPOTENCY_CONFLICT") {
      // Lookup authoritatively confirmed a different fingerprint won DB: safe to clean up
      // this losing attempt's unreferenced object without touching the winner's photo.
      await cleanupUncommittedPhoto(`${reason}-confirmed-conflict`);
      return attendanceError("IDEMPOTENCY_CONFLICT");
    }

    // Lookup returned `ATTENDANCE_UNAVAILABLE` or another non-proving error: keep the uploaded
    // R2 photo rather than risking deletion of an object belonging to a committed DB row,
    // and return a retryable 503 error.
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  };

  let recorded: Awaited<ReturnType<AttendanceRepository["recordCheckIn"]>>;
  try {
    recorded = await dependencies.repository.recordCheckIn({
      auth_subject: actorResult.actor.auth_subject,
      app_user_id: actorResult.actor.app_user_id,
      idempotency_key: meta.idempotency_key,
      request_fingerprint: requestFingerprint,
      latitude: meta.latitude,
      longitude: meta.longitude,
      accuracy_meters: meta.accuracy_meters,
      address_hint: meta.address_hint,
      note: meta.note,
      device_claimed_at: meta.device_claimed_at_iso,
      time_source: meta.time_source,
      time_anchor_issued_at: timeAnchorIssuedAtIso,
      elapsed_since_anchor_ms: elapsedSinceAnchorMs,
      time_token_digest: timeTokenDigest,
      photo_storage_key: ensuredPhoto.storage_key,
      photo_sha256: computedPhotoSha256,
      photo_size_bytes: photoBytes.byteLength,
      photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
      received_at: new Date(nowMs).toISOString(),
    });
  } catch {
    return recoverOrCleanupAfterAmbiguousWriteError("rpc-exception");
  }

  if (!recorded.ok) {
    if (recorded.code === "ATTENDANCE_UNAVAILABLE") {
      return recoverOrCleanupAfterAmbiguousWriteError("db-unavailable");
    }
    // Each upload attempt writes to an isolated per-attempt R2 object key with
    // conditional `If-None-Match: *`, so deleting `ensuredPhoto.storage_key` on DB
    // conflict/rejection removes ONLY this losing attempt's unreferenced object and
    // never deletes or alters the winning check-in's committed photo.
    await cleanupUncommittedPhoto(`db-${recorded.code}`);
    return attendanceError(recorded.code);
  }

  if (recorded.checkin.replayed) {
    // A concurrent identical request won the DB insert first with its own object key;
    // remove this follower's duplicate unreferenced object while preserving the winner's.
    await cleanupUncommittedPhoto("concurrent-replay");
  }

  return noStoreJson(
    {
      ok: true,
      checkin: recorded.checkin,
    },
    recorded.checkin.replayed ? 200 : 201,
  );
}
