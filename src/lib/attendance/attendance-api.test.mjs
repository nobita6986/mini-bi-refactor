import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

import { sha256Hex } from "../direct-entry/document-r2-contract.ts";
import { getAttendanceTime, postAttendanceCheckIn } from "./attendance-api.ts";
import {
  ATTENDANCE_ERROR_CODES,
  ATTENDANCE_MAX_SYNC_WINDOW_MS,
  attendanceHttpStatusForError,
} from "./attendance-contract.ts";
import {
  attendancePhotoObjectKey,
  createR2AttendanceStorage,
  isAttendancePhotoObjectKey,
} from "./r2-attendance-storage.ts";
import {
  ATTENDANCE_TIME_TOKEN_TTL_MS,
  issueAttendanceTimeToken,
  verifyAttendanceTimeToken,
} from "./time-token.ts";

const DEDICATED_SECRET = "att-wp1-signing-secret-2026-unique-9f8e7d6c5b4a3210";
const ACTOR_A = {
  auth_subject: "91000000-0000-4000-8000-0000000000a1",
  app_user_id: "92000000-0000-4000-8000-0000000000a1",
};
const ACTOR_B = {
  auth_subject: "91000000-0000-4000-8000-0000000000b2",
  app_user_id: "92000000-0000-4000-8000-0000000000b2",
};

const KEY_1 = "c1000000-0000-4000-8000-000000000001";
const KEY_2 = "c1000000-0000-4000-8000-000000000002";

const VALID_ENV = {
  ATTENDANCE_ENABLED: "true",
  ATTENDANCE_TIME_TOKEN_SECRET: DEDICATED_SECRET,
  SUPABASE_SECRET_KEY: "sb-secret-service-role-key-do-not-reuse-123456",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "hrp-bi-preview",
  R2_ACCESS_KEY_ID: "R2ACCESSKEYID0123456789",
  R2_SECRET_ACCESS_KEY: "R2SECRETACCESSKEY0123456789abcdef",
  DOCUMENT_STORAGE_ENVIRONMENT: "preview",
  AI_WORKER_TOKEN: "ai-worker-token-distinct-value-1234567890",
};

const FIXED_NOW_MS = Date.parse("2026-10-23T01:25:00.000Z");
const ANCHOR_ISSUED_MS = Date.parse("2026-10-23T01:15:00.000Z");
const ELAPSED_MS = 312_000; // +5m12s => 2026-10-23T01:20:12.000Z (08:20:12.000+07:00)

let cachedJpegA = null;
let cachedJpegB = null;

async function realJpegA() {
  if (!cachedJpegA) {
    cachedJpegA = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#1f5f8b" },
      })
        .jpeg({ quality: 90 })
        .withMetadata({
          exif: { IFD0: { Software: "mini-bi-android-camera" } },
        })
        .toBuffer(),
    );
  }
  return cachedJpegA;
}

async function realJpegB() {
  if (!cachedJpegB) {
    cachedJpegB = new Uint8Array(
      await sharp({
        create: { width: 10, height: 6, channels: 3, background: "#8b2f1f" },
      })
        .jpeg({ quality: 88 })
        .toBuffer(),
    );
  }
  return cachedJpegB;
}

function createFakeR2Harness(env = VALID_ENV, { onBeforePut, createObjectId } = {}) {
  const objects = new Map();
  const commands = [];

  const client = {
    async send(command) {
      if (command instanceof HeadObjectCommand) {
        commands.push({ op: "head", key: command.input.Key });
        const found = objects.get(command.input.Key);
        if (!found) {
          const err = new Error("NotFound");
          err.name = "NotFound";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {
          ContentLength: found.bytes.byteLength,
          ContentType: found.contentType,
          Metadata: found.metadata,
        };
      }
      if (command instanceof PutObjectCommand) {
        if (onBeforePut) {
          await onBeforePut(command);
        }
        const bytes = new Uint8Array(command.input.Body);
        commands.push({
          op: "put",
          key: command.input.Key,
          size: bytes.byteLength,
          ifNoneMatch: command.input.IfNoneMatch ?? null,
        });
        if (command.input.IfNoneMatch === "*" && objects.has(command.input.Key)) {
          const err = new Error("PreconditionFailed");
          err.name = "PreconditionFailed";
          err.Code = "PreconditionFailed";
          err.$metadata = { httpStatusCode: 412 };
          throw err;
        }
        objects.set(command.input.Key, {
          bytes,
          contentType: command.input.ContentType,
          metadata: { ...(command.input.Metadata ?? {}) },
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        commands.push({ op: "get", key: command.input.Key });
        const found = objects.get(command.input.Key);
        if (!found) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {
          ContentLength: found.bytes.byteLength,
          ContentType: found.contentType,
          Body: {
            async transformToByteArray() {
              return new Uint8Array(found.bytes);
            },
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        commands.push({ op: "delete", key: command.input.Key });
        objects.delete(command.input.Key);
        return {};
      }
      throw new Error(`Unexpected S3 command: ${command?.constructor?.name}`);
    },
  };

  return {
    objects,
    commands,
    storage: createR2AttendanceStorage(env, { client, createObjectId }),
  };
}

function createInMemoryCheckInRepo({ onAfterLookup, onBeforeRecord } = {}) {
  const byActorKey = new Map();
  const byActorDay = new Map();
  const lookups = [];
  const calls = [];
  let seqCounter = 0;

  return {
    lookups,
    calls,
    byActorKey,
    repository: {
      async lookupCheckInIdempotency(input) {
        lookups.push(input);
        const compositeKey = `${input.app_user_id}:${input.idempotency_key}`;
        const existing = byActorKey.get(compositeKey);
        const result = !existing
          ? { ok: true, found: false }
          : existing.request_fingerprint !== input.request_fingerprint
            ? { ok: false, code: "IDEMPOTENCY_CONFLICT" }
            : {
                ok: true,
                found: true,
                photo_storage_key: existing.photo_storage_key,
                checkin: {
                  ...existing.projection,
                  daily_count: (
                    byActorDay.get(`${input.app_user_id}:${existing.business_date}`) ?? []
                  ).length,
                  replayed: true,
                },
              };
        if (onAfterLookup) {
          await onAfterLookup(input, result);
        }
        return result;
      },
      async recordCheckIn(input) {
        if (onBeforeRecord) {
          await onBeforeRecord(input);
        }
        calls.push(input);
        const compositeKey = `${input.app_user_id}:${input.idempotency_key}`;
        const existing = byActorKey.get(compositeKey);
        if (existing) {
          if (existing.request_fingerprint !== input.request_fingerprint) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          const dayRows = byActorDay.get(`${input.app_user_id}:${existing.business_date}`) ?? [];
          return {
            ok: true,
            checkin: {
              ...existing.projection,
              daily_count: dayRows.length,
              replayed: true,
            },
          };
        }

        const receivedAtMs = Date.parse(input.received_at);
        const capturedAtMs =
          input.time_source === "SERVER_ANCHORED"
            ? Date.parse(input.time_anchor_issued_at) + input.elapsed_since_anchor_ms
            : Date.parse(input.device_claimed_at);

        if (
          input.time_source === "SERVER_ANCHORED" &&
          receivedAtMs - capturedAtMs > ATTENDANCE_MAX_SYNC_WINDOW_MS
        ) {
          return { ok: false, code: "ATTENDANCE_SYNC_WINDOW_EXPIRED" };
        }

        const hcmDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Ho_Chi_Minh",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(capturedAtMs));

        const dayKey = `${input.app_user_id}:${hcmDate}`;
        const dayRows = byActorDay.get(dayKey) ?? [];
        const sequenceInDay = dayRows.length + 1;
        seqCounter += 1;
        const checkinId = `d2000000-0000-4000-8000-${String(seqCounter).padStart(12, "0")}`;

        const projection = {
          checkin_id: checkinId,
          business_date: hcmDate,
          sequence_in_day: sequenceInDay,
          daily_count: sequenceInDay,
          captured_at: new Date(capturedAtMs).toISOString(),
          received_at: new Date(receivedAtMs).toISOString(),
          time_source: input.time_source,
          replayed: false,
        };

        dayRows.push(projection);
        byActorDay.set(dayKey, dayRows);
        byActorKey.set(compositeKey, {
          request_fingerprint: input.request_fingerprint,
          photo_storage_key: input.photo_storage_key,
          photo_sha256: input.photo_sha256,
          photo_size_bytes: input.photo_size_bytes,
          business_date: hcmDate,
          projection,
        });

        return { ok: true, checkin: projection };
      },
    },
  };
}

function activeSession(actor = ACTOR_A) {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        ...actor,
        capabilities: [],
      },
    },
    response_headers: {},
  });
}

function buildMetadata(overrides = {}) {
  const issued = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS,
    nonce_hex: "00112233445566778899aabbccddeeff",
  });

  return {
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 12.5,
    address_hint: "Hà Nội",
    client_captured_at: "2026-10-23T08:20:12.000+07:00",
    note: "Ca sáng",
    idempotency_key: KEY_1,
    photo_sha256: "0".repeat(64),
    time_source: "SERVER_ANCHORED",
    time_token: issued.time_token,
    elapsed_since_anchor_ms: ELAPSED_MS,
    ...overrides,
  };
}

function buildMultipartCheckInRequest({
  url = "https://bi.example.test/api/attendance/check-in",
  headers = {},
  metadataObj,
  rawMetadataString,
  photoBytes,
  photoMimeType = "image/jpeg",
  photoFileName = "checkin.jpg",
  idempotencyHeader = KEY_1,
  extraParts = [],
} = {}) {
  const form = new FormData();
  const metaText =
    rawMetadataString !== undefined ? rawMetadataString : JSON.stringify(metadataObj);
  if (metaText !== null) {
    form.append("metadata", metaText);
  }
  if (photoBytes !== null) {
    form.append(
      "photo",
      new Blob([photoBytes], { type: photoMimeType }),
      photoFileName,
    );
  }
  for (const [k, v] of extraParts) {
    form.append(k, v);
  }

  const mergedHeaders = {
    origin: "https://bi.example.test",
    host: "bi.example.test",
    ...(idempotencyHeader !== null ? { "idempotency-key": idempotencyHeader } : {}),
    ...headers,
  };

  return new Request(url, {
    method: "POST",
    headers: mergedHeaders,
    body: form,
  });
}

test("all 23 Attendance WP1 stable error codes map to deterministic HTTP statuses", () => {
  assert.equal(ATTENDANCE_ERROR_CODES.length, 23);
  assert.equal(attendanceHttpStatusForError("ATTENDANCE_SYNC_WINDOW_EXPIRED"), 422);
  for (const code of ATTENDANCE_ERROR_CODES) {
    const status = attendanceHttpStatusForError(code);
    assert.equal(typeof status, "number");
    assert.ok(status >= 400 && status <= 599);
  }
});

test("feature flag disabled returns 404 NOT_FOUND on both attendance endpoints before session/DB/R2", async () => {
  let sessionCalled = 0;
  const resolveSession = async () => {
    sessionCalled += 1;
    throw new Error("should not resolve session when flag is off");
  };

  for (const flagVal of [undefined, "false", "0", "TRUE", "yes"]) {
    const env = { ...VALID_ENV, ATTENDANCE_ENABLED: flagVal };
    const timeRes = await getAttendanceTime(
      new Request("https://bi.example.test/api/attendance/time"),
      env,
      { resolveSession },
    );
    assert.equal(timeRes.status, 404);
    assert.equal(timeRes.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await timeRes.json(), { ok: false, code: "NOT_FOUND" });

    const r2 = createFakeR2Harness(env);
    const repo = createInMemoryCheckInRepo();
    const checkInRes = await postAttendanceCheckIn(
      new Request("https://bi.example.test/api/attendance/check-in", { method: "POST" }),
      env,
      { resolveSession, repository: repo.repository, storage: r2.storage },
    );
    assert.equal(checkInRes.status, 404);
    assert.deepEqual(await checkInRes.json(), { ok: false, code: "NOT_FOUND" });
  }
  assert.equal(sessionCalled, 0);
});

test("enabled flag with missing, weak, placeholder, or reused ATTENDANCE_TIME_TOKEN_SECRET fails closed with 503 ATTENDANCE_CONFIG_REQUIRED", async () => {
  const invalidSecrets = [
    undefined,
    "",
    "short-secret-123",
    "<attendance-time-token-secret>",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    VALID_ENV.SUPABASE_SECRET_KEY,
    VALID_ENV.R2_SECRET_ACCESS_KEY,
    VALID_ENV.AI_WORKER_TOKEN,
    "reused-db-password-super-long-value-12345",
  ];

  for (const candidate of invalidSecrets) {
    const env = {
      ...VALID_ENV,
      SUPABASE_DB_URL:
        "postgresql://postgres:reused-db-password-super-long-value-12345@db.example.supabase.co:5432/postgres",
      ATTENDANCE_TIME_TOKEN_SECRET: candidate,
    };

    const timeRes = await getAttendanceTime(
      new Request("https://bi.example.test/api/attendance/time"),
      env,
      { resolveSession: activeSession() },
    );
    assert.equal(timeRes.status, 503);
    assert.deepEqual(await timeRes.json(), {
      ok: false,
      code: "ATTENDANCE_CONFIG_REQUIRED",
    });

    const r2 = createFakeR2Harness(env);
    const repo = createInMemoryCheckInRepo();
    const checkInRes = await postAttendanceCheckIn(
      new Request("https://bi.example.test/api/attendance/check-in", { method: "POST" }),
      env,
      {
        resolveSession: activeSession(),
        repository: repo.repository,
        storage: r2.storage,
      },
    );
    assert.equal(checkInRes.status, 503);
    assert.deepEqual(await checkInRes.json(), {
      ok: false,
      code: "ATTENDANCE_CONFIG_REQUIRED",
    });
  }
});

test("GET /api/attendance/time enforces active session, blocks actor/time spoofing, and issues actor-bound 24h HMAC token", async () => {
  const unauthRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    {
      resolveSession: async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });

  const disabledRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    {
      resolveSession: async () => ({
        actor: { ok: false, reason: "ACTOR_DISABLED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(disabledRes.status, 403);
  assert.deepEqual(await disabledRes.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

  const querySpoofRes = await getAttendanceTime(
    new Request(`https://bi.example.test/api/attendance/time?app_user_id=${ACTOR_B.app_user_id}`),
    VALID_ENV,
    { resolveSession: activeSession() },
  );
  assert.equal(querySpoofRes.status, 400);
  assert.deepEqual(await querySpoofRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  const headerSpoofRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time", {
      headers: { "x-app-user-id": ACTOR_B.app_user_id },
    }),
    VALID_ENV,
    { resolveSession: activeSession() },
  );
  assert.equal(headerSpoofRes.status, 400);

  const okRes = await getAttendanceTime(
    new Request("https://bi.example.test/api/attendance/time"),
    VALID_ENV,
    { resolveSession: activeSession(ACTOR_A), now: () => ANCHOR_ISSUED_MS },
  );
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "private, no-store");
  const body = await okRes.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "expires_at",
    "ok",
    "server_time",
    "time_token",
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.server_time, "2026-10-23T01:15:00.000Z");
  assert.equal(body.expires_at, "2026-10-24T01:15:00.000Z");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(DEDICATED_SECRET));

  const verifiedSameActor = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 60_000,
  });
  assert.equal(verifiedSameActor.ok, true);

  const verifiedOtherActor = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_B.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 60_000,
  });
  assert.deepEqual(verifiedOtherActor, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  const verifiedExpired = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + ATTENDANCE_TIME_TOKEN_TTL_MS + 1,
  });
  assert.deepEqual(verifiedExpired, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_EXPIRED",
  });

  const verifiedExpiredForSync = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: body.time_token,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + ATTENDANCE_TIME_TOKEN_TTL_MS + 1,
    allow_expired_anchor: true,
  });
  assert.equal(verifiedExpiredForSync.ok, true);
  assert.equal(verifiedExpiredForSync.anchor_expired, true);

  const tamperedToken = `${body.time_token.slice(0, -2)}ab`;
  const verifiedTampered = verifyAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    token: tamperedToken,
    expected_app_user_id: ACTOR_A.app_user_id,
    now_ms: ANCHOR_ISSUED_MS + 1_000,
  });
  assert.deepEqual(verifiedTampered, {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_INVALID",
  });
});

test("POST /api/attendance/check-in enforces same-origin CSRF without X-Client-Platform bypass and validates session", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const meta = buildMetadata({ photo_sha256: sha });
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // Missing Origin + X-Client-Platform: android => still 403 CSRF_REJECTED!
  const missingOriginForm = new FormData();
  missingOriginForm.append("metadata", JSON.stringify(meta));
  missingOriginForm.append("photo", new Blob([jpeg], { type: "image/jpeg" }), "c.jpg");
  const noOriginReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      host: "bi.example.test",
      "x-client-platform": "android",
      "idempotency-key": KEY_1,
    },
    body: missingOriginForm,
  });
  const noOriginRes = await postAttendanceCheckIn(noOriginReq, VALID_ENV, deps);
  assert.equal(noOriginRes.status, 403);
  assert.deepEqual(await noOriginRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Wrong Origin host
  const wrongOriginRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      headers: { origin: "https://evil.example.test" },
      metadataObj: meta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(wrongOriginRes.status, 403);
  assert.deepEqual(await wrongOriginRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Scheme downgrade (http Origin against https endpoint)
  const downgradeOriginRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      headers: { origin: "http://bi.example.test" },
      metadataObj: meta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(downgradeOriginRes.status, 403);

  // Unauthenticated session
  const unauthRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({ metadataObj: meta, photoBytes: jpeg }),
    VALID_ENV,
    {
      ...deps,
      resolveSession: async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
        response_headers: {},
      }),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("POST /api/attendance/check-in validates multipart parts, 11-key metadata, actor spoofing, and SERVER_ANCHORED vs DEVICE_CLOCK_UNVERIFIED rules", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // Non-multipart Content-Type
  const jsonReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      origin: "https://bi.example.test",
      host: "bi.example.test",
      "content-type": "application/json",
      "idempotency-key": KEY_1,
    },
    body: JSON.stringify({}),
  });
  const jsonRes = await postAttendanceCheckIn(jsonReq, VALID_ENV, deps);
  assert.equal(jsonRes.status, 400);
  assert.deepEqual(await jsonRes.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

  // Mismatched Idempotency-Key header vs metadata.idempotency_key
  const mismatchKeyRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({ idempotency_key: KEY_1, photo_sha256: sha }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mismatchKeyRes.status, 400);
  assert.deepEqual(await mismatchKeyRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_KEY_INVALID",
  });

  // Extra multipart part rejected
  const extraPartRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha }),
      photoBytes: jpeg,
      extraParts: [["unexpected", "value"]],
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(extraPartRes.status, 400);
  assert.deepEqual(await extraPartRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  // Spoofed actor / sequence fields in metadata rejected (violates exact 11-key contract)
  for (const forbiddenField of [
    "app_user_id",
    "auth_subject",
    "role",
    "scope",
    "team_id",
    "sequence_in_day",
    "daily_count",
    "business_date",
  ]) {
    const spoofRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        metadataObj: buildMetadata({
          photo_sha256: sha,
          [forbiddenField]: "spoofed",
        }),
        photoBytes: jpeg,
      }),
      VALID_ENV,
      deps,
    );
    assert.equal(spoofRes.status, 400);
    assert.deepEqual(await spoofRes.json(), {
      ok: false,
      code: "ATTENDANCE_REQUEST_INVALID",
    });
  }

  // Mixed time shapes rejected
  const mixedAnchoredRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "SERVER_ANCHORED",
        time_token: null,
        elapsed_since_anchor_ms: 1000,
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mixedAnchoredRes.status, 400);
  assert.deepEqual(await mixedAnchoredRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  const mixedDeviceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        elapsed_since_anchor_ms: null,
      }), // time_token left non-null -> mixed shape!
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(mixedDeviceRes.status, 400);
  assert.deepEqual(await mixedDeviceRes.json(), {
    ok: false,
    code: "ATTENDANCE_REQUEST_INVALID",
  });

  // Invalid elapsed_since_anchor_ms
  const badElapsedRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        elapsed_since_anchor_ms: -5,
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badElapsedRes.status, 400);
  assert.deepEqual(await badElapsedRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_ELAPSED_INVALID",
  });

  // Token belonging to Actor B rejected under Actor A's session
  const actorBToken = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_B.app_user_id,
    now_ms: ANCHOR_ISSUED_MS,
  }).time_token;
  const actorMismatchRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, time_token: actorBToken }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(actorMismatchRes.status, 403);
  assert.deepEqual(await actorMismatchRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  // Sync outside 7-day window rejected with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED
  const capturedAtEpochMs = ANCHOR_ISSUED_MS + ELAPSED_MS;
  const expiredSyncWindowRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      ...deps,
      now: () => capturedAtEpochMs + ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    },
  );
  assert.equal(expiredSyncWindowRes.status, 422);
  assert.deepEqual(await expiredSyncWindowRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  // Client skew > 5 seconds rejected with 422 ATTENDANCE_TIME_MISMATCH
  const skewRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        client_captured_at: "2026-10-23T08:20:17.001+07:00", // +5.001s skew vs 08:20:12.000+07:00
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(skewRes.status, 422);
  assert.deepEqual(await skewRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_MISMATCH",
  });

  // Invalid GPS / accuracy / timestamp / future timestamp
  const badGpsRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, latitude: 95 }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badGpsRes.status, 400);
  assert.deepEqual(await badGpsRes.json(), {
    ok: false,
    code: "GPS_COORDINATES_INVALID",
  });

  const badAccRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha, accuracy_meters: -1 }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badAccRes.status, 400);
  assert.deepEqual(await badAccRes.json(), {
    ok: false,
    code: "GPS_ACCURACY_INVALID",
  });

  const badCalendarRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        client_captured_at: "2026-02-30T08:20:12.000+07:00",
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(badCalendarRes.status, 400);
  assert.deepEqual(await badCalendarRes.json(), {
    ok: false,
    code: "CAPTURED_AT_INVALID",
  });

  const futureUnverifiedRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({
        photo_sha256: sha,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-23T08:30:00.000+07:00", // +5m in the future vs FIXED_NOW_MS (08:25+07:00)
      }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(futureUnverifiedRes.status, 422);
  assert.deepEqual(await futureUnverifiedRes.json(), {
    ok: false,
    code: "CAPTURED_AT_FUTURE",
  });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("photo inspection blocks empty, wrong MIME, fake JPEG, polyglot JPEG, oversized body, and SHA-256 mismatch before R2 write", async () => {
  const jpeg = await realJpegA();
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // 1. Empty file
  const emptyBytes = new Uint8Array(0);
  const emptyRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(emptyBytes) }),
      photoBytes: emptyBytes,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(emptyRes.status, 422);
  assert.deepEqual(await emptyRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 2. Wrong MIME (PNG declared as image/png)
  const pngBytes = new Uint8Array(
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer(),
  );
  const pngMimeRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(pngBytes) }),
      photoBytes: pngBytes,
      photoMimeType: "image/png",
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(pngMimeRes.status, 422);
  assert.deepEqual(await pngMimeRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 3. PNG bytes disguised with Content-Type: image/jpeg and .jpg filename
  const disguisedPngRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(pngBytes) }),
      photoBytes: pngBytes,
      photoMimeType: "image/jpeg",
      photoFileName: "disguised.jpg",
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(disguisedPngRes.status, 422);
  assert.deepEqual(await disguisedPngRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 4. Minimal fake JPEG magic stub (FF D8 FF E0 FF D9 — passes magic/trailer, fails real JPEG decode)
  const fakeJpegStub = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
  const stubRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(fakeJpegStub) }),
      photoBytes: fakeJpegStub,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(stubRes.status, 422);
  assert.deepEqual(await stubRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 5. Polyglot JPEG containing embedded <script> markup
  const polyglotBytes = new Uint8Array([
    ...jpeg.subarray(0, jpeg.length - 2),
    ...new TextEncoder().encode("<script>alert(1)</script>"),
    0xff,
    0xd9,
  ]);
  const polyglotRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(polyglotBytes) }),
      photoBytes: polyglotBytes,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(polyglotRes.status, 422);
  assert.deepEqual(await polyglotRes.json(), { ok: false, code: "PHOTO_INVALID" });

  // 6. Oversized body (> 10 MiB + 64 KiB) via Content-Length
  const tooLargeReq = new Request("https://bi.example.test/api/attendance/check-in", {
    method: "POST",
    headers: {
      origin: "https://bi.example.test",
      host: "bi.example.test",
      "content-type": "multipart/form-data; boundary=---test",
      "content-length": String(11 * 1024 * 1024),
      "idempotency-key": KEY_1,
    },
    body: "x",
  });
  const tooLargeRes = await postAttendanceCheckIn(tooLargeReq, VALID_ENV, deps);
  assert.equal(tooLargeRes.status, 413);
  assert.deepEqual(await tooLargeRes.json(), { ok: false, code: "BODY_TOO_LARGE" });

  // 7. SHA-256 mismatch
  const wrongShaRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: "f".repeat(64) }),
      photoBytes: jpeg,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(wrongShaRes.status, 422);
  assert.deepEqual(await wrongShaRes.json(), {
    ok: false,
    code: "PHOTO_HASH_MISMATCH",
  });

  assert.equal(r2.objects.size, 0);
  assert.equal(repo.calls.length, 0);
});

test("SERVER_ANCHORED and DEVICE_CLOCK_UNVERIFIED succeed with deterministic R2 replay, conflict protection, and orphan-free cleanup", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const jpegB = await realJpegB();
  const shaB = sha256Hex(jpegB);

  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  // 1. Create SERVER_ANCHORED check-in (client skew +2s within 5s tolerance; backend uses token + elapsed!)
  const createMeta = buildMetadata({
    idempotency_key: KEY_1,
    photo_sha256: shaA,
    client_captured_at: "2026-10-23T08:20:14.000+07:00", // +2s skew vs 08:20:12.000+07:00
  });
  const firstRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: createMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(firstRes.status, 201);
  assert.equal(firstRes.headers.get("cache-control"), "private, no-store");
  const firstBody = await firstRes.json();
  assert.equal(firstBody.ok, true);
  assert.deepEqual(Object.keys(firstBody.checkin).sort(), [
    "business_date",
    "captured_at",
    "checkin_id",
    "daily_count",
    "received_at",
    "replayed",
    "sequence_in_day",
    "time_source",
  ]);
  assert.equal(firstBody.checkin.captured_at, "2026-10-23T01:20:12.000Z");
  assert.equal(firstBody.checkin.business_date, "2026-10-23");
  assert.equal(firstBody.checkin.sequence_in_day, 1);
  assert.equal(firstBody.checkin.daily_count, 1);
  assert.equal(firstBody.checkin.time_source, "SERVER_ANCHORED");
  assert.equal(firstBody.checkin.replayed, false);
  assert.doesNotMatch(
    JSON.stringify(firstBody),
    /storage_key|hrp-bi-preview|attendance-checkins|time_token|92000000/,
  );

  // Stored R2 bytes are byte-for-byte identical to uploaded JPEG (no re-encoding altering SHA-256)
  const committedKey1 = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${KEY_1}`);
  const expectedStorageKey = committedKey1.photo_storage_key;
  assert.equal(isAttendancePhotoObjectKey(expectedStorageKey), true);
  assert.equal(r2.objects.size, 1);
  assert.deepEqual(r2.objects.get(expectedStorageKey).bytes, jpegA);
  const initialPutCommands = r2.commands.filter((c) => c.op === "put");
  assert.equal(initialPutCommands.length, 1, "initial check-in uploads photo once");
  assert.equal(initialPutCommands[0].ifNoneMatch, "*", "R2 PutObject uses conditional If-None-Match: *");

  // 2. Idempotent retry with exact same key & payload returns 200, same checkin_id, NO second PutObject!
  const replayRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: createMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(replayRes.status, 200);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.checkin.checkin_id, firstBody.checkin.checkin_id);
  assert.equal(replayBody.checkin.replayed, true);
  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    1,
    "retry reuses committed record without re-uploading",
  );
  assert.equal(r2.objects.size, 1);

  // 3. Same key with DIFFERENT photo SHA/bytes conflicts without overwriting or deleting original photo!
  const photoConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: { ...createMeta, photo_sha256: shaB },
      photoBytes: jpegB,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(photoConflictRes.status, 409);
  assert.deepEqual(await photoConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(
    r2.objects.get(expectedStorageKey).bytes,
    jpegA,
    "conflicting retry must never overwrite or delete the original object",
  );

  // 4. Same key + same photo + different metadata (`note`) conflicts at DB and MUST NOT delete pre-existing R2 object!
  const metaConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_1,
      metadataObj: { ...createMeta, note: "Sửa ghi chú trái phép" },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(metaConflictRes.status, 409);
  assert.deepEqual(await metaConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.equal(
    r2.objects.has(expectedStorageKey),
    true,
    "pre-existing object from earlier successful attempt must never be deleted on conflict",
  );

  // 5. DB failure AFTER uploading a NEW object (`KEY_2`, `created_now = true`) deletes the newly created object so zero orphan remains!
  const putsBeforeFail = r2.commands.filter((c) => c.op === "put").length;
  const deletesBeforeFail = r2.commands.filter((c) => c.op === "delete").length;
  const failingRepo = {
    async lookupCheckInIdempotency() {
      return { ok: true, found: false };
    },
    async recordCheckIn() {
      return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
    },
  };
  const dbFailRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({
        idempotency_key: KEY_2,
        photo_sha256: shaB,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-21T07:45:00.000+07:00",
      }),
      photoBytes: jpegB,
    }),
    VALID_ENV,
    { ...deps, repository: failingRepo },
  );
  assert.equal(dbFailRes.status, 503);
  assert.deepEqual(await dbFailRes.json(), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });
  assert.equal(r2.commands.filter((c) => c.op === "put").length, putsBeforeFail + 1);
  assert.equal(r2.commands.filter((c) => c.op === "delete").length, deletesBeforeFail + 1);
  assert.equal(
    r2.objects.size,
    1,
    "newly uploaded object must be deleted when DB write fails so zero orphan remains",
  );

  // 6. Subsequent retry of `KEY_2` (`DEVICE_CLOCK_UNVERIFIED` offline outbox item from 2 days ago) succeeds cleanly!
  const offlineSuccessRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: KEY_2,
      metadataObj: buildMetadata({
        idempotency_key: KEY_2,
        photo_sha256: shaB,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
        client_captured_at: "2026-10-21T07:45:00.000+07:00",
      }),
      photoBytes: jpegB,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(offlineSuccessRes.status, 201);
  const offlineBody = await offlineSuccessRes.json();
  assert.equal(offlineBody.checkin.business_date, "2026-10-21");
  assert.equal(offlineBody.checkin.sequence_in_day, 1);
  assert.equal(offlineBody.checkin.time_source, "DEVICE_CLOCK_UNVERIFIED");
  assert.equal(offlineBody.checkin.replayed, false);
  const committedKey2 = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${KEY_2}`);
  assert.equal(r2.objects.has(committedKey2.photo_storage_key), true);
  assert.equal(r2.objects.size, 2);
});

test("SERVER_ANCHORED offline sync grace enforces 24h capture ceiling, deterministic 7-day sync window, original captured_at preservation, and idempotent multi-retry", async () => {
  const jpeg = await realJpegA();
  const sha = sha256Hex(jpeg);
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();

  const anchorMs = Date.parse("2026-10-15T01:00:00.000Z"); // 08:00:00.000+07:00
  const issued = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "aa11bb22cc33dd44ee55ff6677889900",
  });

  // 1. Token past 24h TTL (synced 78h after anchor), elapsed = 2h (<= 24h):
  //    captured_at = 2026-10-15T03:00:00.000Z (10:00+07:00), sync delay = 76h (<= 7d)
  const keyDelayed = "c1000000-0000-4000-8000-0000000000a1";
  const twoHoursMs = 2 * 3_600_000;
  const originalCapturedMs = anchorMs + twoHoursMs; // 2026-10-15T03:00:00.000Z
  const syncAt78hMs = anchorMs + 78 * 3_600_000; // 2026-10-18T07:00:00.000Z
  const delayedMeta = {
    latitude: 10.7769,
    longitude: 106.7009,
    accuracy_meters: 6.5,
    address_hint: "Nhà máy Bình Dương",
    client_captured_at: "2026-10-15T10:00:01.500+07:00", // +1.5s skew within 5s tolerance
    note: "Mất sóng công trường",
    idempotency_key: keyDelayed,
    photo_sha256: sha,
    time_source: "SERVER_ANCHORED",
    time_token: issued.time_token,
    elapsed_since_anchor_ms: twoHoursMs,
  };

  const delayedCreateRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyDelayed,
      metadataObj: delayedMeta,
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(delayedCreateRes.status, 201);
  const delayedCreateBody = await delayedCreateRes.json();
  assert.equal(delayedCreateBody.ok, true);
  assert.equal(
    delayedCreateBody.checkin.captured_at,
    new Date(originalCapturedMs).toISOString(),
    "delayed sync must preserve exact original server-derived captured_at without re-anchoring",
  );
  assert.equal(delayedCreateBody.checkin.business_date, "2026-10-15");
  assert.equal(
    delayedCreateBody.checkin.received_at,
    new Date(syncAt78hMs).toISOString(),
  );
  assert.equal(delayedCreateBody.checkin.time_source, "SERVER_ANCHORED");
  assert.equal(delayedCreateBody.checkin.replayed, false);
  assert.equal(r2.objects.size, 1);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, 1);

  // 2. Multiple retries of the same idempotency_key later inside the 7-day window (+96h and +150h)
  //    never create duplicate check-in rows or duplicate R2 uploads, and never mutate captured_at!
  for (const retryHours of [96, 150]) {
    const retryRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyDelayed,
        metadataObj: delayedMeta,
        photoBytes: jpeg,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => anchorMs + retryHours * 3_600_000,
      },
    );
    assert.equal(retryRes.status, 200);
    const retryBody = await retryRes.json();
    assert.equal(retryBody.checkin.checkin_id, delayedCreateBody.checkin.checkin_id);
    assert.equal(
      retryBody.checkin.captured_at,
      new Date(originalCapturedMs).toISOString(),
    );
    assert.equal(
      retryBody.checkin.received_at,
      new Date(syncAt78hMs).toISOString(),
    );
    assert.equal(retryBody.checkin.sequence_in_day, 1);
    assert.equal(retryBody.checkin.daily_count, 1);
    assert.equal(retryBody.checkin.replayed, true);
  }
  assert.equal(repo.byActorKey.size, 1);
  assert.equal(r2.objects.size, 1);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, 1);

  // 3. Exact 24h elapsed_since_anchor_ms boundary (86,400,000 ms) + exact 7-day sync window boundary
  //    (server_now - captured_at === 604,800,000 ms): ACCEPTED!
  const keyBoundaryExact = "c1000000-0000-4000-8000-0000000000a2";
  const maxElapsedCapturedMs = anchorMs + ATTENDANCE_TIME_TOKEN_TTL_MS; // 2026-10-16T01:00:00.000Z
  const exact7dSyncNowMs = maxElapsedCapturedMs + ATTENDANCE_MAX_SYNC_WINDOW_MS; // 2026-10-23T01:00:00.000Z
  const exactBoundaryRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyBoundaryExact,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyBoundaryExact,
        elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS,
        client_captured_at: new Date(maxElapsedCapturedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => exact7dSyncNowMs,
    },
  );
  assert.equal(exactBoundaryRes.status, 201);
  const exactBoundaryBody = await exactBoundaryRes.json();
  assert.equal(
    exactBoundaryBody.checkin.captured_at,
    new Date(maxElapsedCapturedMs).toISOString(),
  );
  assert.equal(exactBoundaryBody.checkin.business_date, "2026-10-16");

  // 4. 1 millisecond past the 7-day sync window (server_now - captured_at === 604,800,001 ms):
  //    REJECTED with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED before touching R2 or DB!
  const keyPast7d = "c1000000-0000-4000-8000-0000000000a3";
  const putCountBeforeRejects = r2.commands.filter((c) => c.op === "put").length;
  const repoCallsBeforeRejects = repo.calls.length;

  const past7dBy1msRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyPast7d,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyPast7d,
        elapsed_since_anchor_ms: twoHoursMs,
        client_captured_at: new Date(originalCapturedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => originalCapturedMs + ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    },
  );
  assert.equal(past7dBy1msRes.status, 422);
  assert.deepEqual(await past7dBy1msRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  // 5. elapsed_since_anchor_ms exceeding 24h (86,400,001 ms) is STILL rejected even when
  //    server_now - captured_at is well within 7 days (e.g. synced 2 days after anchor)!
  const keyElapsedOver24h = "c1000000-0000-4000-8000-0000000000a4";
  const over24hElapsedMs = ATTENDANCE_TIME_TOKEN_TTL_MS + 1;
  const over24hRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyElapsedOver24h,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyElapsedOver24h,
        elapsed_since_anchor_ms: over24hElapsedMs,
        client_captured_at: new Date(anchorMs + over24hElapsedMs).toISOString(),
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => anchorMs + 2 * 86_400_000, // only ~24h after capture (<= 7d), yet elapsed > 24h!
    },
  );
  assert.equal(over24hRes.status, 400);
  assert.deepEqual(await over24hRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_ELAPSED_INVALID",
  });

  // 6. Invalid signature, wrong actor, and future timestamp during grace window remain fail-closed!
  const keyGraceFailClosed = "c1000000-0000-4000-8000-0000000000a5";
  const tamperedGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
        time_token: `${issued.time_token.slice(0, -2)}zz`,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(tamperedGraceRes.status, 422);
  assert.deepEqual(await tamperedGraceRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_INVALID",
  });

  const wrongActorGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_B),
      repository: repo.repository,
      storage: r2.storage,
      now: () => syncAt78hMs,
    },
  );
  assert.equal(wrongActorGraceRes.status, 403);
  assert.deepEqual(await wrongActorGraceRes.json(), {
    ok: false,
    code: "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  });

  const futureGraceRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyGraceFailClosed,
      metadataObj: {
        ...delayedMeta,
        idempotency_key: keyGraceFailClosed,
      },
      photoBytes: jpeg,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => originalCapturedMs - 60_000, // server_now is 60s before captured_at (> 30s tolerance)
    },
  );
  assert.equal(futureGraceRes.status, 422);
  assert.deepEqual(await futureGraceRes.json(), {
    ok: false,
    code: "CAPTURED_AT_FUTURE",
  });

  assert.equal(
    r2.commands.filter((c) => c.op === "put").length,
    putCountBeforeRejects,
    "all rejected grace-window requests must never upload objects to R2",
  );
  assert.equal(repo.calls.length, repoCallsBeforeRejects);
});

test("post-168h idempotency precedes sync-window rejection: replays saved SERVER_ANCHORED check-in after >7 days, returns 409 on fingerprint mismatch, and rejects unsaved stale keys without R2/DB writes", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const jpegB = await realJpegB();
  const shaB = sha256Hex(jpegB);

  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();

  const anchorMs = Date.parse("2026-10-01T01:00:00.000Z"); // 08:00:00.000+07:00
  const issuedA = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_A.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "11223344556677889900aabbccddeeff",
  });
  const issuedB = issueAttendanceTimeToken({
    secret: Buffer.from(DEDICATED_SECRET, "utf8"),
    app_user_id: ACTOR_B.app_user_id,
    now_ms: anchorMs,
    nonce_hex: "ffeeddccbbaa00998877665544332211",
  });

  const keySaved = "d3000000-0000-4000-8000-000000000001";
  const elapsedMs = 3_600_000; // +1h => captured_at = 2026-10-01T02:00:00.000Z (09:00+07:00)
  const capturedAtMs = anchorMs + elapsedMs;
  const initialReceivedAtMs = capturedAtMs + 48 * 3_600_000; // synced +48h later (within 7d; HTTP response lost on client)

  const savedMeta = {
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 9.0,
    address_hint: "KCN Bắc Thăng Long",
    client_captured_at: new Date(capturedAtMs + 1_000).toISOString(), // +1s skew
    note: "Chấm công đầu ca (mất response mạng)",
    idempotency_key: keySaved,
    photo_sha256: shaA,
    time_source: "SERVER_ANCHORED",
    time_token: issuedA.time_token,
    elapsed_since_anchor_ms: elapsedMs,
  };

  // Initial write succeeds within 168h (simulating lost HTTP response before client marks SYNCED)
  const initialRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: savedMeta,
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => initialReceivedAtMs,
    },
  );
  assert.equal(initialRes.status, 201);
  const initialBody = await initialRes.json();
  assert.equal(initialBody.checkin.replayed, false);
  assert.equal(initialBody.checkin.captured_at, new Date(capturedAtMs).toISOString());
  assert.equal(initialBody.checkin.received_at, new Date(initialReceivedAtMs).toISOString());
  assert.equal(initialBody.checkin.business_date, "2026-10-01");

  const r2CommandsAfterInitial = r2.commands.length;
  const repoWriteCallsAfterInitial = repo.calls.length;

  // 1. Retry of the ALREADY-SAVED check-in past 168h (+168h + 1ms, +10 days, and +30 days):
  //    MUST return 200 with exact saved projection (`replayed: true`), zero R2 commands, zero DB writes!
  for (const postWindowDelayMs of [
    ATTENDANCE_MAX_SYNC_WINDOW_MS + 1,
    10 * 86_400_000,
    30 * 86_400_000,
  ]) {
    const replayPast7dRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keySaved,
        metadataObj: savedMeta,
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => capturedAtMs + postWindowDelayMs,
      },
    );
    assert.equal(
      replayPast7dRes.status,
      200,
      `saved check-in retried at +${postWindowDelayMs}ms must replay 200 instead of 422`,
    );
    const replayPast7dBody = await replayPast7dRes.json();
    assert.deepEqual(replayPast7dBody, {
      ok: true,
      checkin: {
        ...initialBody.checkin,
        replayed: true,
      },
    });
  }
  assert.equal(
    r2.commands.length,
    r2CommandsAfterInitial,
    "post-168h replay must not issue HeadObject, PutObject, or DeleteObject to R2",
  );
  assert.equal(
    repo.calls.length,
    repoWriteCallsAfterInitial,
    "post-168h replay must resolve via idempotency lookup without calling recordCheckIn",
  );

  // 2. Same actor + saved idempotency_key after >7 days with DIFFERENT fingerprint (metadata OR photo):
  //    MUST return 409 IDEMPOTENCY_CONFLICT (not 422), with zero R2 writes/deletes and zero DB mutations!
  const tenDaysAfterCaptureMs = capturedAtMs + 10 * 86_400_000;

  const noteConflictPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: { ...savedMeta, note: "Sửa ghi chú sau 10 ngày" },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(noteConflictPast7dRes.status, 409);
  assert.deepEqual(await noteConflictPast7dRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  const photoConflictPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: { ...savedMeta, photo_sha256: shaB },
      photoBytes: jpegB,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(photoConflictPast7dRes.status, 409);
  assert.deepEqual(await photoConflictPast7dRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  // Spoofing original metadata.photo_sha256 while sending different JPEG bytes after >7 days
  // is still caught by byte hash verification before replay (422 PHOTO_HASH_MISMATCH)
  const spoofedPhotoBytesPast7dRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: savedMeta,
      photoBytes: jpegB,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(spoofedPhotoBytesPast7dRes.status, 422);
  assert.deepEqual(await spoofedPhotoBytesPast7dRes.json(), {
    ok: false,
    code: "PHOTO_HASH_MISMATCH",
  });

  const savedStorageKey = repo.byActorKey.get(
    `${ACTOR_A.app_user_id}:${keySaved}`,
  ).photo_storage_key;
  assert.deepEqual(r2.objects.get(savedStorageKey).bytes, jpegA);
  assert.equal(r2.commands.length, r2CommandsAfterInitial);
  assert.equal(repo.calls.length, repoWriteCallsAfterInitial);

  // 3. Unsaved/new idempotency_key arriving past 168h (+168h + 1ms and +10 days):
  //    MUST still be rejected with 422 ATTENDANCE_SYNC_WINDOW_EXPIRED, zero R2 upload, zero DB insert!
  const keyUnsavedStale = "d3000000-0000-4000-8000-000000000002";
  for (const staleDelayMs of [ATTENDANCE_MAX_SYNC_WINDOW_MS + 1, 10 * 86_400_000]) {
    const staleUnsavedRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyUnsavedStale,
        metadataObj: {
          ...savedMeta,
          idempotency_key: keyUnsavedStale,
          photo_sha256: shaB,
        },
        photoBytes: jpegB,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => capturedAtMs + staleDelayMs,
      },
    );
    assert.equal(staleUnsavedRes.status, 422);
    assert.deepEqual(await staleUnsavedRes.json(), {
      ok: false,
      code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
    });
  }

  // Different actor (ACTOR_B) reusing ACTOR_A's saved UUID with ACTOR_B's own token past 168h
  // has no saved row for ACTOR_B and is rejected with 422 (isolated per actor, zero cross-actor leak)
  const otherActorSameUuidStaleRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keySaved,
      metadataObj: {
        ...savedMeta,
        time_token: issuedB.time_token,
      },
      photoBytes: jpegA,
    }),
    VALID_ENV,
    {
      resolveSession: activeSession(ACTOR_B),
      repository: repo.repository,
      storage: r2.storage,
      now: () => tenDaysAfterCaptureMs,
    },
  );
  assert.equal(otherActorSameUuidStaleRes.status, 422);
  assert.deepEqual(await otherActorSameUuidStaleRes.json(), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  assert.equal(
    r2.objects.size,
    1,
    "unsaved stale requests must never create objects in R2",
  );
  assert.equal(
    r2.commands.length,
    r2CommandsAfterInitial,
    "unsaved stale requests must not issue HeadObject or PutObject to R2",
  );
  assert.equal(
    repo.calls.length,
    repoWriteCallsAfterInitial,
    "unsaved stale requests must never invoke recordCheckIn",
  );
  assert.equal(repo.byActorKey.size, 1);

  // 4. Direct R2 conditional write (`If-None-Match: *`) protection on identical `object_id`:
  //    Even if two storage calls target the exact same `object_id`, `If-None-Match: *` prevents
  //    overwriting: mismatched SHA returns `{ ok: false, kind: "conflict" }` without mutating
  //    stored bytes, while matching SHA returns `{ ok: true, created_now: false }`.
  const keyInterrupted = "d3000000-0000-4000-8000-000000000003";
  const explicitObjectId = "d4000000-0000-4000-8000-000000000001";
  const preStaged = await r2.storage.ensureCheckInPhoto({
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: keyInterrupted,
    object_id: explicitObjectId,
    photo_sha256: shaA,
    bytes: jpegA,
  });
  assert.equal(preStaged.ok, true);
  assert.equal(preStaged.created_now, true);
  assert.equal(
    preStaged.storage_key,
    attendancePhotoObjectKey("preview", ACTOR_A.app_user_id, keyInterrupted, explicitObjectId),
  );
  assert.deepEqual(
    await r2.storage.readCheckInPhoto(preStaged.storage_key),
    jpegA,
    "private attendance-photo reads return the exact immutable JPEG bytes",
  );
  await assert.rejects(
    () => r2.storage.readCheckInPhoto(`production/${preStaged.storage_key.slice("preview/".length)}`),
    /ATTENDANCE_STORAGE_KEY_INVALID/,
  );

  const sameObjectConflict = await r2.storage.ensureCheckInPhoto({
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: keyInterrupted,
    object_id: explicitObjectId,
    photo_sha256: shaB,
    bytes: jpegB,
  });
  assert.deepEqual(sameObjectConflict, { ok: false, kind: "conflict" });
  assert.deepEqual(
    r2.objects.get(preStaged.storage_key).bytes,
    jpegA,
    "If-None-Match: * must block overwriting an existing R2 object on conflicting SHA",
  );

  const sameObjectReuse = await r2.storage.ensureCheckInPhoto({
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: keyInterrupted,
    object_id: explicitObjectId,
    photo_sha256: shaA,
    bytes: jpegA,
  });
  assert.deepEqual(sameObjectReuse, {
    ok: true,
    storage_key: preStaged.storage_key,
    created_now: false,
  });
});

test("concurrent check-in race with same actor + idempotency_key and different photos preserves winning photo bytes/hash, returns 409 IDEMPOTENCY_CONFLICT to loser, and leaves zero R2 orphans", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const jpegB = await realJpegB();
  const shaB = sha256Hex(jpegB);
  assert.notEqual(shaA, shaB);

  function createCountBarrier(partyCount) {
    let arrived = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= partyCount) {
        release();
      }
      await gate;
    };
  }

  // ---------------------------------------------------------------------------
  // Race 1 (Adversarial overwrite window):
  //   - Req A (`jpegA`) and Req B (`jpegB`) both pass `lookupCheckInIdempotency`
  //     seeing `{ found: false }`.
  //   - Req A uploads `jpegA` to R2 FIRST, then Req B uploads `jpegB` to R2 SECOND
  //     (in the old shared-key design, Req B would overwrite Req A's R2 bytes!).
  //   - Req A enters `recordCheckIn` FIRST and wins DB commit (`201`, `shaA`).
  //   - Req B enters `recordCheckIn` SECOND, loses with `409 IDEMPOTENCY_CONFLICT`,
  //     and cleans up ONLY its own unreferenced R2 object.
  // ---------------------------------------------------------------------------
  {
    const keyRace = "e9000000-0000-4000-8000-000000000001";
    const bothLookedUp = createCountBarrier(2);
    const bothUploadedToR2 = createCountBarrier(2);
    let r2PutOrder = [];
    let releasePutB;
    const putADone = new Promise((resolve) => {
      releasePutB = resolve;
    });
    let releaseRecordB;
    const recordADone = new Promise((resolve) => {
      releaseRecordB = resolve;
    });

    const r2 = createFakeR2Harness(VALID_ENV, {
      async onBeforePut(command) {
        const metaSha = command.input.Metadata?.sha256;
        if (metaSha === shaB) {
          // Force losing request B to write to R2 AFTER winning request A!
          await putADone;
        }
        r2PutOrder.push(metaSha);
        if (metaSha === shaA) {
          releasePutB();
        }
      },
    });

    const repo = createInMemoryCheckInRepo({
      async onAfterLookup() {
        await bothLookedUp();
      },
      async onBeforeRecord(input) {
        // Ensure BOTH R2 uploads completed before either request enters DB!
        await bothUploadedToR2();
        if (input.photo_sha256 === shaB) {
          await recordADone;
        }
      },
    });

    const originalRecordCheckIn = repo.repository.recordCheckIn;
    repo.repository.recordCheckIn = async (input) => {
      try {
        return await originalRecordCheckIn(input);
      } finally {
        if (input.photo_sha256 === shaA) {
          releaseRecordB();
        }
      }
    };

    // Coordinate the post-Put barrier via storage wrapper so both PutObjects finish before DB
    const rawEnsure = r2.storage.ensureCheckInPhoto.bind(r2.storage);
    r2.storage.ensureCheckInPhoto = async (input) => {
      const res = await rawEnsure(input);
      await bothUploadedToR2();
      return res;
    };

    const deps = {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => FIXED_NOW_MS,
    };

    const [resA, resB] = await Promise.all([
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyRace,
          metadataObj: buildMetadata({ idempotency_key: keyRace, photo_sha256: shaA }),
          photoBytes: jpegA,
        }),
        VALID_ENV,
        deps,
      ),
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyRace,
          metadataObj: buildMetadata({ idempotency_key: keyRace, photo_sha256: shaB }),
          photoBytes: jpegB,
        }),
        VALID_ENV,
        deps,
      ),
    ]);

    assert.deepEqual(r2PutOrder, [shaA, shaB], "loser B uploaded after winner A");
    assert.equal(resA.status, 201);
    const bodyA = await resA.json();
    assert.equal(bodyA.ok, true);
    assert.equal(bodyA.checkin.replayed, false);

    assert.equal(resB.status, 409);
    assert.deepEqual(await resB.json(), {
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyRace}`);
    assert.ok(committed, "winner record must be committed in DB");
    assert.equal(committed.photo_sha256, shaA);
    assert.equal(isAttendancePhotoObjectKey(committed.photo_storage_key), true);

    assert.equal(
      r2.objects.size,
      1,
      "losing concurrent upload must be cleaned up leaving zero orphan objects in R2",
    );
    assert.equal(
      r2.objects.has(committed.photo_storage_key),
      true,
      "winning check-in's R2 object must never be deleted",
    );
    const winnerStoredBytes = r2.objects.get(committed.photo_storage_key).bytes;
    assert.equal(
      sha256Hex(winnerStoredBytes),
      committed.photo_sha256,
      "stored R2 photo SHA-256 must match committed DB photo_sha256",
    );
    assert.deepEqual(winnerStoredBytes, jpegA);

    const putCmds = r2.commands.filter((c) => c.op === "put");
    const delCmds = r2.commands.filter((c) => c.op === "delete");
    assert.equal(putCmds.length, 2);
    assert.ok(putCmds.every((c) => c.ifNoneMatch === "*"));
    assert.notEqual(putCmds[0].key, putCmds[1].key);
    assert.equal(delCmds.length, 1);
    assert.notEqual(delCmds[0].key, committed.photo_storage_key);
  }

  // ---------------------------------------------------------------------------
  // Race 2 (Reverse DB winner):
  //   - Req A uploads `jpegA` to R2 FIRST, Req B uploads `jpegB` to R2 SECOND,
  //     then Req B wins DB FIRST (`201`, `shaB`) and Req A loses DB SECOND (`409`).
  //   - Winner B's `jpegB` stays intact in R2 matching DB `shaB`, while Req A's
  //     unreferenced `jpegA` object is deleted with zero orphans!
  // ---------------------------------------------------------------------------
  {
    const keyRaceReverse = "e9000000-0000-4000-8000-000000000002";
    const bothLookedUp = createCountBarrier(2);
    const bothUploadedToR2 = createCountBarrier(2);
    let releasePutB;
    const putADone = new Promise((resolve) => {
      releasePutB = resolve;
    });
    let releaseRecordA;
    const recordBDone = new Promise((resolve) => {
      releaseRecordA = resolve;
    });

    const r2 = createFakeR2Harness(VALID_ENV, {
      async onBeforePut(command) {
        if (command.input.Metadata?.sha256 === shaB) {
          await putADone;
        }
        if (command.input.Metadata?.sha256 === shaA) {
          releasePutB();
        }
      },
    });

    const repo = createInMemoryCheckInRepo({
      async onAfterLookup() {
        await bothLookedUp();
      },
      async onBeforeRecord(input) {
        await bothUploadedToR2();
        if (input.photo_sha256 === shaA) {
          await recordBDone;
        }
      },
    });

    const originalRecordCheckIn = repo.repository.recordCheckIn;
    repo.repository.recordCheckIn = async (input) => {
      try {
        return await originalRecordCheckIn(input);
      } finally {
        if (input.photo_sha256 === shaB) {
          releaseRecordA();
        }
      }
    };

    const rawEnsure = r2.storage.ensureCheckInPhoto.bind(r2.storage);
    r2.storage.ensureCheckInPhoto = async (input) => {
      const res = await rawEnsure(input);
      await bothUploadedToR2();
      return res;
    };

    const deps = {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => FIXED_NOW_MS,
    };

    const [resA, resB] = await Promise.all([
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyRaceReverse,
          metadataObj: buildMetadata({ idempotency_key: keyRaceReverse, photo_sha256: shaA }),
          photoBytes: jpegA,
        }),
        VALID_ENV,
        deps,
      ),
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyRaceReverse,
          metadataObj: buildMetadata({ idempotency_key: keyRaceReverse, photo_sha256: shaB }),
          photoBytes: jpegB,
        }),
        VALID_ENV,
        deps,
      ),
    ]);

    assert.equal(resA.status, 409);
    assert.deepEqual(await resA.json(), {
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });
    assert.equal(resB.status, 201);

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyRaceReverse}`);
    assert.equal(committed.photo_sha256, shaB);
    assert.equal(r2.objects.size, 1);
    assert.equal(r2.objects.has(committed.photo_storage_key), true);
    assert.equal(sha256Hex(r2.objects.get(committed.photo_storage_key).bytes), shaB);
    assert.deepEqual(r2.objects.get(committed.photo_storage_key).bytes, jpegB);
  }

  // ---------------------------------------------------------------------------
  // Race 3 (Concurrent identical retries):
  //   - Two identical requests (`same actor + idempotency_key + photo + metadata`)
  //     both pass `lookupCheckInIdempotency` and upload before DB commit.
  //   - Winner returns `201` (`replayed: false`), follower returns `200` (`replayed: true`)
  //     and cleans up its duplicate unreferenced R2 object so only 1 object remains.
  // ---------------------------------------------------------------------------
  {
    const keySameRace = "e9000000-0000-4000-8000-000000000003";
    const bothLookedUp = createCountBarrier(2);
    const bothUploadedToR2 = createCountBarrier(2);

    const r2 = createFakeR2Harness();
    const repo = createInMemoryCheckInRepo({
      async onAfterLookup() {
        await bothLookedUp();
      },
      async onBeforeRecord() {
        await bothUploadedToR2();
      },
    });

    const rawEnsure = r2.storage.ensureCheckInPhoto.bind(r2.storage);
    r2.storage.ensureCheckInPhoto = async (input) => {
      const res = await rawEnsure(input);
      await bothUploadedToR2();
      return res;
    };

    const deps = {
      resolveSession: activeSession(ACTOR_A),
      repository: repo.repository,
      storage: r2.storage,
      now: () => FIXED_NOW_MS,
    };

    const sameMeta = buildMetadata({ idempotency_key: keySameRace, photo_sha256: shaA });
    const [res1, res2] = await Promise.all([
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keySameRace,
          metadataObj: sameMeta,
          photoBytes: jpegA,
        }),
        VALID_ENV,
        deps,
      ),
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keySameRace,
          metadataObj: sameMeta,
          photoBytes: jpegA,
        }),
        VALID_ENV,
        deps,
      ),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.equal(body1.checkin.checkin_id, body2.checkin.checkin_id);

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keySameRace}`);
    assert.equal(r2.objects.size, 1, "follower duplicate R2 object must be cleaned up");
    assert.equal(r2.objects.has(committed.photo_storage_key), true);
    assert.equal(sha256Hex(r2.objects.get(committed.photo_storage_key).bytes), shaA);
  }

  // ---------------------------------------------------------------------------
  // Race 4 (Post-write ambiguous outcome recovery & R2 safety matrix):
  //   4a. DB commits, write fails (network throw OR ATTENDANCE_UNAVAILABLE),
  //       AND post-failure lookup ALSO fails (network throw OR ATTENDANCE_UNAVAILABLE)
  //       -> R2 photo MUST NOT be deleted, returns retryable 503, and later retry
  //          replays 200 with the committed photo intact.
  //   4b. Write fails BEFORE DB commit, AND post-failure lookup confirms `found: false`
  //       -> temporary R2 photo IS deleted, returns retryable 503.
  //   4c. DB commits, write fails over transport, post-failure lookup finds the
  //       matching-fingerprint record referencing THIS request's `photo_storage_key`
  //       -> photo IS preserved, returns 200 (`replayed: true`), no internal
  //          `photo_storage_key` leaked in client JSON.
  //   4d. Concurrent identical request won DB with a different `photo_storage_key`
  //       while follower's `recordCheckIn` failed ambiguously over transport
  //       -> ONLY follower's surplus R2 object is deleted, winner's R2 object is
  //          preserved, returns 200 (`replayed: true`), no `photo_storage_key` leaked.
  //   4e. Competing different-fingerprint request won DB while loser's `recordCheckIn`
  //       failed ambiguously over transport, and post-failure lookup confirms
  //       `IDEMPOTENCY_CONFLICT` -> loser's temp R2 object is deleted, winner's
  //       photo is preserved, returns 409 `IDEMPOTENCY_CONFLICT`.
  // ---------------------------------------------------------------------------
  {
    // 4a-1: DB commits, `recordCheckIn` throws, post-failure lookup ALSO throws network error
    const keyDoubleNetworkDrop = "e9000000-0000-4000-8000-000000000004";
    const r2 = createFakeR2Harness();
    const repo = createInMemoryCheckInRepo();
    const rawLookup = repo.repository.lookupCheckInIdempotency;
    const rawRecord = repo.repository.recordCheckIn;
    let failPostWrite = true;

    repo.repository.lookupCheckInIdempotency = async (input) => {
      if (failPostWrite && repo.calls.length === 1) {
        throw new Error("socket reset during post-failure idempotency lookup");
      }
      return rawLookup(input);
    };
    repo.repository.recordCheckIn = async (input) => {
      if (failPostWrite) {
        await rawRecord(input);
        throw new Error("socket hang up after PostgreSQL COMMIT");
      }
      return rawRecord(input);
    };

    const firstRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyDoubleNetworkDrop,
        metadataObj: buildMetadata({ idempotency_key: keyDoubleNetworkDrop, photo_sha256: shaA }),
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => FIXED_NOW_MS,
      },
    );
    assert.equal(firstRes.status, 503);
    assert.deepEqual(await firstRes.json(), { ok: false, code: "ATTENDANCE_UNAVAILABLE" });

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyDoubleNetworkDrop}`);
    assert.ok(committed, "DB row was committed before connection dropped");
    assert.equal(r2.objects.size, 1);
    assert.equal(
      r2.objects.has(committed.photo_storage_key),
      true,
      "R2 photo must be preserved when post-failure lookup also throws",
    );
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 0);

    // Network recovers -> retry replays 200 and committed R2 photo is still intact
    failPostWrite = false;
    const retryRes = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyDoubleNetworkDrop,
        metadataObj: buildMetadata({ idempotency_key: keyDoubleNetworkDrop, photo_sha256: shaA }),
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => FIXED_NOW_MS + 5_000,
      },
    );
    assert.equal(retryRes.status, 200);
    const retryText = await retryRes.text();
    assert.equal(retryText.includes("photo_storage_key"), false);
    assert.equal(retryText.includes("attendance-checkins"), false);
    const retryBody = JSON.parse(retryText);
    assert.equal(retryBody.ok, true);
    assert.equal(retryBody.checkin.replayed, true);
    assert.equal(r2.objects.has(committed.photo_storage_key), true);
    assert.equal(sha256Hex(r2.objects.get(committed.photo_storage_key).bytes), shaA);
  }

  {
    // 4a-2: DB commits, `recordCheckIn` returns ATTENDANCE_UNAVAILABLE, post-failure lookup
    //       ALSO returns `{ ok: false, code: "ATTENDANCE_UNAVAILABLE" }` -> photo preserved!
    const keyDoubleUnavailable = "e9000000-0000-4000-8000-000000000005";
    const r2 = createFakeR2Harness();
    const repo = createInMemoryCheckInRepo();
    const rawLookup = repo.repository.lookupCheckInIdempotency;
    const rawRecord = repo.repository.recordCheckIn;

    repo.repository.lookupCheckInIdempotency = async (input) => {
      if (repo.calls.length === 1) {
        return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
      }
      return rawLookup(input);
    };
    repo.repository.recordCheckIn = async (input) => {
      await rawRecord(input);
      return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
    };

    const res = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyDoubleUnavailable,
        metadataObj: buildMetadata({ idempotency_key: keyDoubleUnavailable, photo_sha256: shaA }),
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => FIXED_NOW_MS,
      },
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, code: "ATTENDANCE_UNAVAILABLE" });

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyDoubleUnavailable}`);
    assert.equal(r2.objects.size, 1);
    assert.equal(
      r2.objects.has(committed.photo_storage_key),
      true,
      "R2 photo must be preserved when post-failure lookup returns ATTENDANCE_UNAVAILABLE",
    );
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 0);
  }

  {
    // 4b: Write fails WITHOUT committing, post-failure lookup confirms `found: false`
    //     -> temporary R2 object IS cleaned up.
    const keyConfirmedAbsent = "e9000000-0000-4000-8000-000000000006";
    const r2 = createFakeR2Harness();
    const repo = createInMemoryCheckInRepo();
    repo.repository.recordCheckIn = async () => ({
      ok: false,
      code: "ATTENDANCE_UNAVAILABLE",
    });

    const res = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyConfirmedAbsent,
        metadataObj: buildMetadata({ idempotency_key: keyConfirmedAbsent, photo_sha256: shaA }),
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => FIXED_NOW_MS,
      },
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, code: "ATTENDANCE_UNAVAILABLE" });
    assert.equal(
      r2.objects.size,
      0,
      "temporary R2 object must be deleted once post-failure lookup confirms no DB row exists",
    );
    assert.equal(r2.commands.filter((c) => c.op === "put").length, 1);
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 1);
  }

  {
    // 4c: DB commits, write throws transport error, post-failure lookup finds the record
    //     referencing THIS request's `photo_storage_key` -> photo preserved, 200 returned,
    //     no `photo_storage_key` leaked in client JSON.
    const keyTransportDrop = "e9000000-0000-4000-8000-000000000007";
    const r2 = createFakeR2Harness();
    const repo = createInMemoryCheckInRepo();
    const rawRecord = repo.repository.recordCheckIn;
    repo.repository.recordCheckIn = async (input) => {
      await rawRecord(input);
      throw new Error("socket hang up after PostgreSQL COMMIT");
    };

    const res = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyTransportDrop,
        metadataObj: buildMetadata({ idempotency_key: keyTransportDrop, photo_sha256: shaA }),
        photoBytes: jpegA,
      }),
      VALID_ENV,
      {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: r2.storage,
        now: () => FIXED_NOW_MS,
      },
    );
    assert.equal(res.status, 200);
    const rawText = await res.text();
    assert.equal(rawText.includes("photo_storage_key"), false);
    assert.equal(rawText.includes("attendance-checkins"), false);
    const body = JSON.parse(rawText);
    assert.equal(body.ok, true);
    assert.equal(body.checkin.replayed, true);
    assert.deepEqual(Object.keys(body).sort(), ["checkin", "ok"]);

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyTransportDrop}`);
    assert.equal(r2.objects.size, 1);
    assert.equal(
      r2.objects.has(committed.photo_storage_key),
      true,
      "committed R2 object must never be deleted when PostgREST socket drops after COMMIT",
    );
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 0);
  }

  {
    // 4d: Concurrent identical request won DB with its own `photo_storage_key`, while
    //     follower's `recordCheckIn` failed ambiguously -> post-failure lookup detects
    //     `postFailureLookup.photo_storage_key !== ensuredPhoto.storage_key` and deletes
    //     ONLY follower's surplus duplicate object while preserving winner's object.
    const keySurplusDup = "e9000000-0000-4000-8000-000000000008";
    const r2 = createFakeR2Harness();
    let putCount = 0;
    let bothUploadedResolve;
    const bothUploaded = new Promise((resolve) => {
      bothUploadedResolve = resolve;
    });

    const rawStorage = r2.storage;
    const barrierStorage = {
      available: () => true,
      async ensureCheckInPhoto(input) {
        const result = await rawStorage.ensureCheckInPhoto(input);
        putCount += 1;
        if (putCount === 2) {
          bothUploadedResolve();
        }
        await bothUploaded;
        return result;
      },
      async deleteNewlyCreatedCheckInPhoto(storageKey) {
        return rawStorage.deleteNewlyCreatedCheckInPhoto(storageKey);
      },
    };

    const repo = createInMemoryCheckInRepo();
    const rawRecord = repo.repository.recordCheckIn;
    let recordInvocation = 0;
    let leaderCommittedResolve;
    const leaderCommitted = new Promise((resolve) => {
      leaderCommittedResolve = resolve;
    });
    repo.repository.recordCheckIn = async (input) => {
      recordInvocation += 1;
      if (recordInvocation === 1) {
        const out = await rawRecord(input);
        leaderCommittedResolve();
        return out;
      }
      await leaderCommitted;
      throw new Error("follower connection dropped while leader already committed");
    };

    const makeReq = () =>
      buildMultipartCheckInRequest({
        idempotencyHeader: keySurplusDup,
        metadataObj: buildMetadata({ idempotency_key: keySurplusDup, photo_sha256: shaA }),
        photoBytes: jpegA,
      });

    const [res1, res2] = await Promise.all([
      postAttendanceCheckIn(makeReq(), VALID_ENV, {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: barrierStorage,
        now: () => FIXED_NOW_MS,
      }),
      postAttendanceCheckIn(makeReq(), VALID_ENV, {
        resolveSession: activeSession(ACTOR_A),
        repository: repo.repository,
        storage: barrierStorage,
        now: () => FIXED_NOW_MS,
      }),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 201]);
    const text1 = await res1.text();
    const text2 = await res2.text();
    assert.equal(text1.includes("photo_storage_key"), false);
    assert.equal(text2.includes("photo_storage_key"), false);

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keySurplusDup}`);
    assert.equal(r2.objects.size, 1, "only winner's R2 object must remain; surplus must be deleted");
    assert.equal(r2.objects.has(committed.photo_storage_key), true);
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 1);
  }

  {
    // 4e: Competing different-fingerprint request won DB while loser's `recordCheckIn`
    //     failed ambiguously -> post-failure lookup confirms `IDEMPOTENCY_CONFLICT`,
    //     deletes ONLY loser's temp object, preserves winner's photo, returns 409.
    const keyConflictAfterDrop = "e9000000-0000-4000-8000-000000000009";
    const r2 = createFakeR2Harness();
    let putCount = 0;
    let bothUploadedResolve;
    const bothUploaded = new Promise((resolve) => {
      bothUploadedResolve = resolve;
    });

    const rawStorage = r2.storage;
    const barrierStorage = {
      available: () => true,
      async ensureCheckInPhoto(input) {
        const result = await rawStorage.ensureCheckInPhoto(input);
        putCount += 1;
        if (putCount === 2) {
          bothUploadedResolve();
        }
        await bothUploaded;
        return result;
      },
      async deleteNewlyCreatedCheckInPhoto(storageKey) {
        return rawStorage.deleteNewlyCreatedCheckInPhoto(storageKey);
      },
    };

    const repo = createInMemoryCheckInRepo();
    const rawRecord = repo.repository.recordCheckIn;
    let winnerCommittedResolve;
    const winnerCommitted = new Promise((resolve) => {
      winnerCommittedResolve = resolve;
    });
    repo.repository.recordCheckIn = async (input) => {
      if (input.photo_sha256 === shaA) {
        const out = await rawRecord(input);
        winnerCommittedResolve();
        return out;
      }
      await winnerCommitted;
      return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
    };

    const [resWinner, resLoser] = await Promise.all([
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyConflictAfterDrop,
          metadataObj: buildMetadata({ idempotency_key: keyConflictAfterDrop, photo_sha256: shaA }),
          photoBytes: jpegA,
        }),
        VALID_ENV,
        {
          resolveSession: activeSession(ACTOR_A),
          repository: repo.repository,
          storage: barrierStorage,
          now: () => FIXED_NOW_MS,
        },
      ),
      postAttendanceCheckIn(
        buildMultipartCheckInRequest({
          idempotencyHeader: keyConflictAfterDrop,
          metadataObj: buildMetadata({ idempotency_key: keyConflictAfterDrop, photo_sha256: shaB }),
          photoBytes: jpegB,
        }),
        VALID_ENV,
        {
          resolveSession: activeSession(ACTOR_A),
          repository: repo.repository,
          storage: barrierStorage,
          now: () => FIXED_NOW_MS,
        },
      ),
    ]);

    assert.equal(resWinner.status, 201);
    assert.equal(resLoser.status, 409);
    assert.deepEqual(await resLoser.json(), { ok: false, code: "IDEMPOTENCY_CONFLICT" });

    const committed = repo.byActorKey.get(`${ACTOR_A.app_user_id}:${keyConflictAfterDrop}`);
    assert.equal(r2.objects.size, 1);
    assert.equal(r2.objects.has(committed.photo_storage_key), true);
    assert.equal(sha256Hex(r2.objects.get(committed.photo_storage_key).bytes), shaA);
    assert.equal(r2.commands.filter((c) => c.op === "delete").length, 1);
  }
});

test("createServiceAttendanceRepository maps SQL errors without leaking details and route handlers enforce nodejs/force-dynamic/RPC-only boundary", async () => {
  const { readFileSync } = await import("node:fs");
  const { createServiceAttendanceRepository } = await import("./attendance-repository.ts");
  const timeRouteSrc = readFileSync(
    new URL("../../app/api/attendance/time/route.ts", import.meta.url),
    "utf8",
  );
  const checkInRouteSrc = readFileSync(
    new URL("../../app/api/attendance/check-in/route.ts", import.meta.url),
    "utf8",
  );
  const repoSrc = readFileSync(
    new URL("./attendance-repository.ts", import.meta.url),
    "utf8",
  );

  assert.match(timeRouteSrc, /export const runtime = "nodejs"/);
  assert.match(timeRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(timeRouteSrc, /export async function GET\(/);
  assert.doesNotMatch(timeRouteSrc, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(timeRouteSrc, /\.from\s*\(/);

  assert.match(checkInRouteSrc, /export const runtime = "nodejs"/);
  assert.match(checkInRouteSrc, /export const dynamic = "force-dynamic"/);
  assert.match(checkInRouteSrc, /export async function POST\(/);
  assert.doesNotMatch(checkInRouteSrc, /export async function (GET|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(checkInRouteSrc, /\.from\s*\(/);
  assert.doesNotMatch(repoSrc, /\.from\s*\(/);

  const baseInput = {
    auth_subject: ACTOR_A.auth_subject,
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: KEY_1,
    request_fingerprint: "a".repeat(64),
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 10,
    address_hint: "Hà Nội",
    note: "",
    device_claimed_at: "2026-10-23T01:20:12.000Z",
    time_source: "DEVICE_CLOCK_UNVERIFIED",
    time_anchor_issued_at: null,
    elapsed_since_anchor_ms: null,
    time_token_digest: null,
    photo_storage_key: `preview/attendance-checkins/${ACTOR_A.app_user_id}/${KEY_1}.jpg`,
    photo_sha256: "b".repeat(64),
    photo_size_bytes: 1024,
    photo_mime_type: "image/jpeg",
    received_at: "2026-10-23T01:25:00.000Z",
  };

  const syncExpiredRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "22023", message: "ATTENDANCE_SYNC_WINDOW_EXPIRED" },
  }));
  assert.deepEqual(await syncExpiredRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  });

  const deniedRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "42501", message: "actor mapping denied" },
  }));
  assert.deepEqual(await deniedRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });

  const conflictRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "40001", message: "IDEMPOTENCY_CONFLICT" },
  }));
  assert.deepEqual(await conflictRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  const pt409ConflictRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: { code: "PT409", message: "IDEMPOTENCY_CONFLICT" },
  }));
  assert.deepEqual(await pt409ConflictRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  const unexpectedSqlRepo = createServiceAttendanceRepository(async () => ({
    data: null,
    error: {
      code: "XX000",
      message: "internal relation attendance_checkins detail secret",
    },
  }));
  assert.deepEqual(await unexpectedSqlRepo.recordCheckIn(baseInput), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });

  const lookupBaseInput = {
    auth_subject: ACTOR_A.auth_subject,
    app_user_id: ACTOR_A.app_user_id,
    idempotency_key: KEY_1,
    request_fingerprint: "a".repeat(64),
  };

  const notFoundLookupRepo = createServiceAttendanceRepository(async () => ({
    data: { found: false },
    error: null,
  }));
  assert.deepEqual(await notFoundLookupRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: true,
    found: false,
  });

  const expectedLookupPhotoKey = `preview/attendance-checkins/${ACTOR_A.app_user_id}/${KEY_1}/f9000000-0000-4000-8000-000000000001.jpg`;
  const foundLookupRepo = createServiceAttendanceRepository(async () => ({
    data: {
      found: true,
      photo_storage_key: expectedLookupPhotoKey,
      checkin: {
        checkin_id: "d2000000-0000-4000-8000-000000000099",
        business_date: "2026-10-01",
        sequence_in_day: 1,
        daily_count: 2,
        captured_at: "2026-10-01T02:00:00.000Z",
        received_at: "2026-10-03T02:00:00.000Z",
        time_source: "SERVER_ANCHORED",
        replayed: true,
      },
    },
    error: null,
  }));
  const foundLookup = await foundLookupRepo.lookupCheckInIdempotency(lookupBaseInput);
  assert.equal(foundLookup.ok, true);
  assert.equal(foundLookup.found, true);
  assert.equal(foundLookup.photo_storage_key, expectedLookupPhotoKey);
  assert.equal(foundLookup.checkin.replayed, true);

  assert.deepEqual(await conflictRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(await deniedRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "ACTOR_NOT_AVAILABLE",
  });

  const missingStorageKeyLookupRepo = createServiceAttendanceRepository(async () => ({
    data: {
      found: true,
      checkin: {
        checkin_id: "d2000000-0000-4000-8000-000000000099",
        business_date: "2026-10-01",
        sequence_in_day: 1,
        daily_count: 1,
        captured_at: "2026-10-01T02:00:00.000Z",
        received_at: "2026-10-03T02:00:00.000Z",
        time_source: "SERVER_ANCHORED",
        replayed: true,
      },
    },
    error: null,
  }));
  assert.deepEqual(await missingStorageKeyLookupRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });

  const nonReplayedLookupRepo = createServiceAttendanceRepository(async () => ({
    data: {
      found: true,
      photo_storage_key: expectedLookupPhotoKey,
      checkin: {
        checkin_id: "d2000000-0000-4000-8000-000000000099",
        business_date: "2026-10-01",
        sequence_in_day: 1,
        daily_count: 1,
        captured_at: "2026-10-01T02:00:00.000Z",
        received_at: "2026-10-03T02:00:00.000Z",
        time_source: "SERVER_ANCHORED",
        replayed: false,
      },
    },
    error: null,
  }));
  assert.deepEqual(await nonReplayedLookupRepo.lookupCheckInIdempotency(lookupBaseInput), {
    ok: false,
    code: "ATTENDANCE_UNAVAILABLE",
  });
});

test("POST /api/attendance/check-in accepts iOS 9-key and partial 10-key DEVICE_CLOCK_UNVERIFIED payloads, rejects invalid combinations, and enforces cross-format idempotency", async () => {
  const jpegA = await realJpegA();
  const shaA = sha256Hex(jpegA);
  const r2 = createFakeR2Harness();
  const repo = createInMemoryCheckInRepo();
  const deps = {
    resolveSession: activeSession(ACTOR_A),
    repository: repo.repository,
    storage: r2.storage,
    now: () => FIXED_NOW_MS,
  };

  const buildOfflineCore = (idempotencyKey, overrides = {}) => ({
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 12.5,
    address_hint: "Hà Nội",
    client_captured_at: "2026-10-21T07:45:00.000+07:00",
    note: "iOS offline check-in",
    idempotency_key: idempotencyKey,
    photo_sha256: shaA,
    time_source: "DEVICE_CLOCK_UNVERIFIED",
    ...overrides,
  });

  const omitKey = (obj, keyToOmit) => {
    const copy = { ...obj };
    delete copy[keyToOmit];
    return copy;
  };

  // 1. Accepted offline shapes: iOS 9-key, Android 11-key, and partial 10-key payloads
  const keyIos9 = "f1000000-0000-4000-8000-000000000001";
  const keyAndroid11 = "f1000000-0000-4000-8000-000000000002";
  const keyPartialTokenOnly = "f1000000-0000-4000-8000-000000000003";
  const keyPartialElapsedOnly = "f1000000-0000-4000-8000-000000000004";

  const acceptedPayloads = [
    {
      label: "iOS 9-key offline payload",
      key: keyIos9,
      meta: buildOfflineCore(keyIos9),
    },
    {
      label: "Android 11-key offline payload",
      key: keyAndroid11,
      meta: buildOfflineCore(keyAndroid11, {
        time_token: null,
        elapsed_since_anchor_ms: null,
      }),
    },
    {
      label: "Partial 10-key offline payload (time_token: null, elapsed omitted)",
      key: keyPartialTokenOnly,
      meta: buildOfflineCore(keyPartialTokenOnly, { time_token: null }),
    },
    {
      label: "Partial 10-key offline payload (elapsed_since_anchor_ms: null, token omitted)",
      key: keyPartialElapsedOnly,
      meta: buildOfflineCore(keyPartialElapsedOnly, { elapsed_since_anchor_ms: null }),
    },
  ];

  const createdByKey = new Map();
  for (const [idx, entry] of acceptedPayloads.entries()) {
    const res = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: entry.key,
        metadataObj: entry.meta,
        photoBytes: jpegA,
      }),
      VALID_ENV,
      deps,
    );
    assert.equal(res.status, 201, entry.label);
    const body = await res.json();
    assert.equal(body.ok, true, entry.label);
    assert.equal(body.checkin.time_source, "DEVICE_CLOCK_UNVERIFIED", entry.label);
    assert.equal(body.checkin.replayed, false, entry.label);
    assert.equal(repo.calls[idx].time_source, "DEVICE_CLOCK_UNVERIFIED", entry.label);
    assert.equal(repo.calls[idx].time_token_digest, null, entry.label);
    assert.equal(repo.calls[idx].elapsed_since_anchor_ms, null, entry.label);
    createdByKey.set(entry.key, body.checkin.checkin_id);
  }

  const putsAfterCreates = r2.commands.filter((c) => c.op === "put").length;
  const callsAfterCreates = repo.calls.length;
  const objectsAfterCreates = r2.objects.size;

  // 2. Negative cases: 400 ATTENDANCE_REQUEST_INVALID without touching R2 or DB
  const keyInvalid = "f1000000-0000-4000-8000-000000000099";
  const serverMeta = buildMetadata({ idempotency_key: keyInvalid, photo_sha256: shaA });
  const invalidCases = [
    {
      label: "DEVICE_CLOCK_UNVERIFIED with non-empty time_token",
      meta: buildOfflineCore(keyInvalid, { time_token: "tok" }),
    },
    {
      label: "DEVICE_CLOCK_UNVERIFIED with empty-string time_token",
      meta: buildOfflineCore(keyInvalid, { time_token: "" }),
    },
    {
      label: "DEVICE_CLOCK_UNVERIFIED with zero elapsed_since_anchor_ms",
      meta: buildOfflineCore(keyInvalid, { elapsed_since_anchor_ms: 0 }),
    },
    {
      label: "DEVICE_CLOCK_UNVERIFIED with positive elapsed_since_anchor_ms",
      meta: buildOfflineCore(keyInvalid, { elapsed_since_anchor_ms: 120 }),
    },
    {
      label: "missing core key (note)",
      meta: omitKey(buildOfflineCore(keyInvalid), "note"),
    },
    {
      label: "extra unknown key (platform)",
      meta: buildOfflineCore(keyInvalid, { platform: "ios" }),
    },
    {
      label: "SERVER_ANCHORED omitting time_token",
      meta: omitKey(serverMeta, "time_token"),
    },
    {
      label: "SERVER_ANCHORED omitting elapsed_since_anchor_ms",
      meta: omitKey(serverMeta, "elapsed_since_anchor_ms"),
    },
  ];

  for (const invalidCase of invalidCases) {
    const res = await postAttendanceCheckIn(
      buildMultipartCheckInRequest({
        idempotencyHeader: keyInvalid,
        metadataObj: invalidCase.meta,
        photoBytes: jpegA,
      }),
      VALID_ENV,
      deps,
    );
    assert.equal(res.status, 400, invalidCase.label);
    assert.deepEqual(
      await res.json(),
      { ok: false, code: "ATTENDANCE_REQUEST_INVALID" },
      invalidCase.label,
    );
  }
  assert.equal(r2.objects.size, objectsAfterCreates);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, putsAfterCreates);
  assert.equal(repo.calls.length, callsAfterCreates);

  // 3. Cross-format idempotency:
  //    - 9-key iOS -> 11-key Android with same key & fields => 200 replayed: true, same checkin_id
  const replayAndroidRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyIos9,
      metadataObj: buildOfflineCore(keyIos9, {
        time_token: null,
        elapsed_since_anchor_ms: null,
      }),
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(replayAndroidRes.status, 200);
  const replayAndroidBody = await replayAndroidRes.json();
  assert.equal(replayAndroidBody.ok, true);
  assert.equal(replayAndroidBody.checkin.replayed, true);
  assert.equal(replayAndroidBody.checkin.checkin_id, createdByKey.get(keyIos9));

  //    - Reverse: 11-key Android -> 9-key iOS with same key & fields => 200 replayed: true, same checkin_id
  const replayIosRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyAndroid11,
      metadataObj: buildOfflineCore(keyAndroid11),
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(replayIosRes.status, 200);
  const replayIosBody = await replayIosRes.json();
  assert.equal(replayIosBody.ok, true);
  assert.equal(replayIosBody.checkin.replayed, true);
  assert.equal(replayIosBody.checkin.checkin_id, createdByKey.get(keyAndroid11));

  //    - 9-key iOS -> 11-key Android with same key & different note => 409 IDEMPOTENCY_CONFLICT
  const crossConflictRes = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      idempotencyHeader: keyIos9,
      metadataObj: buildOfflineCore(keyIos9, {
        note: "Changed note on retry",
        time_token: null,
        elapsed_since_anchor_ms: null,
      }),
      photoBytes: jpegA,
    }),
    VALID_ENV,
    deps,
  );
  assert.equal(crossConflictRes.status, 409);
  assert.deepEqual(await crossConflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  assert.equal(r2.objects.size, objectsAfterCreates);
  assert.equal(r2.commands.filter((c) => c.op === "put").length, putsAfterCreates);
  assert.equal(repo.calls.length, callsAfterCreates);
});

test("VPSTTT secret reuse is rejected (503 ATTENDANCE_CONFIG_REQUIRED) and missing VPSTTT endpoint fails closed (503 ATTENDANCE_UNAVAILABLE) without R2 fallback", async () => {
  const vpstttSecret = "vpsttt-secret-key-synthetic-0123456789";
  const vpstttAccessKey = "VPSTTTSYNTHETICACCESSKEY0123456789";
  for (const reused of [vpstttSecret, vpstttAccessKey]) {
    const reuseEnv = {
      ...VALID_ENV,
      DOCUMENT_STORAGE_PROVIDER: "vpsttt",
      VPSTTT_STORAGE_ENDPOINT: "https://s3.synthetic.test:9000",
      VPSTTT_STORAGE_REGION: "ap-southeast-1",
      VPSTTT_STORAGE_BUCKET: "vpsttt-preview-bucket",
      VPSTTT_STORAGE_ACCESS_KEY_ID: vpstttAccessKey,
      VPSTTT_STORAGE_SECRET_ACCESS_KEY: vpstttSecret,
      ATTENDANCE_TIME_TOKEN_SECRET: reused,
    };
    const timeRes = await getAttendanceTime(
      new Request("https://bi.example.test/api/attendance/time"),
      reuseEnv,
      { resolveSession: activeSession() },
    );
    assert.equal(timeRes.status, 503);
    assert.deepEqual(await timeRes.json(), { ok: false, code: "ATTENDANCE_CONFIG_REQUIRED" });

    const r2 = createFakeR2Harness(VALID_ENV);
    const repo = createInMemoryCheckInRepo();
    const checkInRes = await postAttendanceCheckIn(
      new Request("https://bi.example.test/api/attendance/check-in", { method: "POST" }),
      reuseEnv,
      { resolveSession: activeSession(), repository: repo.repository, storage: r2.storage },
    );
    assert.equal(checkInRes.status, 503);
    assert.deepEqual(await checkInRes.json(), { ok: false, code: "ATTENDANCE_CONFIG_REQUIRED" });
  }

  // Valid R2_* vars must not be used when DOCUMENT_STORAGE_PROVIDER=vpsttt is missing endpoint.
  const missingEndpointEnv = {
    ...VALID_ENV,
    DOCUMENT_STORAGE_PROVIDER: "vpsttt",
    VPSTTT_STORAGE_REGION: "ap-southeast-1",
    VPSTTT_STORAGE_BUCKET: "vpsttt-preview-bucket",
    VPSTTT_STORAGE_ACCESS_KEY_ID: vpstttAccessKey,
    VPSTTT_STORAGE_SECRET_ACCESS_KEY: vpstttSecret,
  };
  const vpstttStorage = createR2AttendanceStorage(missingEndpointEnv);
  assert.equal(vpstttStorage.available(), false);
  const jpeg = await realJpegA();
  const repo = createInMemoryCheckInRepo();
  const res = await postAttendanceCheckIn(
    buildMultipartCheckInRequest({
      metadataObj: buildMetadata({ photo_sha256: sha256Hex(jpeg) }),
      photoBytes: jpeg,
    }),
    missingEndpointEnv,
    { resolveSession: activeSession(), repository: repo.repository, storage: vpstttStorage },
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, code: "ATTENDANCE_UNAVAILABLE" });
});
