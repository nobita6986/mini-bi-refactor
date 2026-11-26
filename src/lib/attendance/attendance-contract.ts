import { createHash } from "node:crypto";
import { isUuid } from "../http/direct-entry-api-guard.ts";

export const ATTENDANCE_TIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const ATTENDANCE_MAX_SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const ATTENDANCE_TIME_SOURCES = [
  "SERVER_ANCHORED",
  "DEVICE_CLOCK_UNVERIFIED",
] as const;

export type AttendanceTimeSource = (typeof ATTENDANCE_TIME_SOURCES)[number];

export const ATTENDANCE_ERROR_CODES = [
  "NOT_FOUND",
  "ATTENDANCE_CONFIG_REQUIRED",
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "BODY_TOO_LARGE",
  "ATTENDANCE_REQUEST_INVALID",
  "GPS_COORDINATES_INVALID",
  "GPS_ACCURACY_INVALID",
  "CAPTURED_AT_INVALID",
  "CAPTURED_AT_FUTURE",
  "ATTENDANCE_TIME_TOKEN_INVALID",
  "ATTENDANCE_TIME_TOKEN_EXPIRED",
  "ATTENDANCE_SYNC_WINDOW_EXPIRED",
  "ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH",
  "ATTENDANCE_TIME_ELAPSED_INVALID",
  "ATTENDANCE_TIME_MISMATCH",
  "PHOTO_INVALID",
  "PHOTO_HASH_MISMATCH",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "ATTENDANCE_UNAVAILABLE",
] as const;

export type AttendanceErrorCode = (typeof ATTENDANCE_ERROR_CODES)[number];

const ERROR_HTTP_STATUS: Readonly<Record<AttendanceErrorCode, number>> = {
  NOT_FOUND: 404,
  ATTENDANCE_CONFIG_REQUIRED: 503,
  UNAUTHENTICATED: 401,
  ACTOR_NOT_AVAILABLE: 403,
  CSRF_REJECTED: 403,
  CONTENT_TYPE_INVALID: 400,
  BODY_TOO_LARGE: 413,
  ATTENDANCE_REQUEST_INVALID: 400,
  GPS_COORDINATES_INVALID: 400,
  GPS_ACCURACY_INVALID: 400,
  CAPTURED_AT_INVALID: 400,
  CAPTURED_AT_FUTURE: 422,
  ATTENDANCE_TIME_TOKEN_INVALID: 422,
  ATTENDANCE_TIME_TOKEN_EXPIRED: 422,
  ATTENDANCE_SYNC_WINDOW_EXPIRED: 422,
  ATTENDANCE_TIME_TOKEN_ACTOR_MISMATCH: 403,
  ATTENDANCE_TIME_ELAPSED_INVALID: 400,
  ATTENDANCE_TIME_MISMATCH: 422,
  PHOTO_INVALID: 422,
  PHOTO_HASH_MISMATCH: 422,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ATTENDANCE_UNAVAILABLE: 503,
};

export function attendanceHttpStatusForError(code: AttendanceErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export const ATTENDANCE_METADATA_KEYS = [
  "accuracy_meters",
  "address_hint",
  "client_captured_at",
  "elapsed_since_anchor_ms",
  "idempotency_key",
  "latitude",
  "longitude",
  "note",
  "photo_sha256",
  "time_source",
  "time_token",
] as const;

const ATTENDANCE_METADATA_KEY_SET: ReadonlySet<string> = new Set(ATTENDANCE_METADATA_KEYS);

const ATTENDANCE_METADATA_CORE_KEYS = [
  "accuracy_meters",
  "address_hint",
  "client_captured_at",
  "idempotency_key",
  "latitude",
  "longitude",
  "note",
  "photo_sha256",
  "time_source",
] as const;

export const ATTENDANCE_CLIENT_TIME_SKEW_TOLERANCE_MS = 5_000;
export const ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS = 30_000;
export const ATTENDANCE_ADDRESS_HINT_MAX_LENGTH = 500;
export const ATTENDANCE_NOTE_MAX_LENGTH = 2_000;
export const ATTENDANCE_PHOTO_MIME_TYPE = "image/jpeg" as const;

const SHA256_LOWER_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STRICT_ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/;

export type ParsedIsoInstant =
  | { ok: true; epoch_ms: number; canonical_utc_iso: string }
  | { ok: false; code: "CAPTURED_AT_INVALID" };

export function parseStrictIsoInstant(raw: unknown): ParsedIsoInstant {
  if (typeof raw !== "string") {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }
  const match = STRICT_ISO_INSTANT.exec(raw);
  if (!match) {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const tzFull = match[8];
  const tzSign = match[9];
  const tzHour = match[10] ? Number(match[10]) : 0;
  const tzMinute = match[11] ? Number(match[11]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    tzHour > 23 ||
    tzMinute > 59
  ) {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }

  const millis = fraction.length === 0 ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  const utcCalendarMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (!Number.isFinite(utcCalendarMs)) {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }

  const verifyDate = new Date(utcCalendarMs);
  if (
    verifyDate.getUTCFullYear() !== year ||
    verifyDate.getUTCMonth() !== month - 1 ||
    verifyDate.getUTCDate() !== day ||
    verifyDate.getUTCHours() !== hour ||
    verifyDate.getUTCMinutes() !== minute ||
    verifyDate.getUTCSeconds() !== second
  ) {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }

  let offsetMs = 0;
  if (tzFull !== "Z") {
    const sign = tzSign === "-" ? -1 : 1;
    offsetMs = sign * (tzHour * 3_600_000 + tzMinute * 60_000);
  }

  const epochMs = utcCalendarMs - offsetMs;
  if (!Number.isSafeInteger(epochMs)) {
    return { ok: false, code: "CAPTURED_AT_INVALID" };
  }

  return {
    ok: true,
    epoch_ms: epochMs,
    canonical_utc_iso: new Date(epochMs).toISOString(),
  };
}

export type ParsedAttendanceCheckInMetadata =
  | {
      ok: true;
      data: {
        latitude: number;
        longitude: number;
        accuracy_meters: number;
        address_hint: string;
        note: string;
        idempotency_key: string;
        photo_sha256: string;
        device_claimed_at_ms: number;
        device_claimed_at_iso: string;
      } & (
        | {
            time_source: "SERVER_ANCHORED";
            time_token: string;
            elapsed_since_anchor_ms: number;
          }
        | {
            time_source: "DEVICE_CLOCK_UNVERIFIED";
            time_token: null;
            elapsed_since_anchor_ms: null;
          }
      );
    }
  | {
      ok: false;
      code:
        | "IDEMPOTENCY_KEY_INVALID"
        | "ATTENDANCE_REQUEST_INVALID"
        | "GPS_COORDINATES_INVALID"
        | "GPS_ACCURACY_INVALID"
        | "CAPTURED_AT_INVALID"
        | "ATTENDANCE_TIME_TOKEN_INVALID"
        | "ATTENDANCE_TIME_ELAPSED_INVALID";
    };

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function parseAttendanceCheckInMetadata(input: {
  raw_metadata_json: string;
  header_idempotency_key: string;
}): ParsedAttendanceCheckInMetadata {
  const headerKey = input.header_idempotency_key;
  if (!isUuid(headerKey)) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw_metadata_json);
  } catch {
    return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!ATTENDANCE_METADATA_KEY_SET.has(key)) {
      return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
    }
  }
  for (const key of ATTENDANCE_METADATA_CORE_KEYS) {
    if (!Object.hasOwn(record, key)) {
      return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
    }
  }

  if (
    typeof record.idempotency_key !== "string" ||
    !isUuid(record.idempotency_key) ||
    record.idempotency_key !== headerKey
  ) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  if (
    typeof record.latitude !== "number" ||
    !Number.isFinite(record.latitude) ||
    record.latitude < -90 ||
    record.latitude > 90 ||
    typeof record.longitude !== "number" ||
    !Number.isFinite(record.longitude) ||
    record.longitude < -180 ||
    record.longitude > 180
  ) {
    return { ok: false, code: "GPS_COORDINATES_INVALID" };
  }

  if (
    typeof record.accuracy_meters !== "number" ||
    !Number.isFinite(record.accuracy_meters) ||
    record.accuracy_meters < 0
  ) {
    return { ok: false, code: "GPS_ACCURACY_INVALID" };
  }

  if (
    typeof record.address_hint !== "string" ||
    record.address_hint.includes("\u0000") ||
    typeof record.note !== "string" ||
    record.note.includes("\u0000")
  ) {
    return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
  }
  const addressHint = record.address_hint.trim();
  const note = record.note.trim();
  if (
    addressHint.length > ATTENDANCE_ADDRESS_HINT_MAX_LENGTH ||
    note.length > ATTENDANCE_NOTE_MAX_LENGTH
  ) {
    return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
  }

  const claimedInstant = parseStrictIsoInstant(record.client_captured_at);
  if (!claimedInstant.ok) {
    return claimedInstant;
  }

  if (
    typeof record.photo_sha256 !== "string" ||
    !SHA256_LOWER_HEX.test(record.photo_sha256)
  ) {
    return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
  }

  const baseData = {
    latitude: normalizeZero(record.latitude),
    longitude: normalizeZero(record.longitude),
    accuracy_meters: normalizeZero(record.accuracy_meters),
    address_hint: addressHint,
    note,
    idempotency_key: record.idempotency_key.toLowerCase(),
    photo_sha256: record.photo_sha256,
    device_claimed_at_ms: claimedInstant.epoch_ms,
    device_claimed_at_iso: claimedInstant.canonical_utc_iso,
  };

  if (record.time_source === "SERVER_ANCHORED") {
    if (
      !Object.hasOwn(record, "time_token") ||
      !Object.hasOwn(record, "elapsed_since_anchor_ms") ||
      record.time_token === null ||
      record.elapsed_since_anchor_ms === null
    ) {
      return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
    }
    if (typeof record.time_token !== "string" || record.time_token.trim().length === 0) {
      return { ok: false, code: "ATTENDANCE_TIME_TOKEN_INVALID" };
    }
    if (
      typeof record.elapsed_since_anchor_ms !== "number" ||
      !Number.isSafeInteger(record.elapsed_since_anchor_ms) ||
      record.elapsed_since_anchor_ms < 0 ||
      record.elapsed_since_anchor_ms > ATTENDANCE_TIME_TOKEN_TTL_MS
    ) {
      return { ok: false, code: "ATTENDANCE_TIME_ELAPSED_INVALID" };
    }
    return {
      ok: true,
      data: {
        ...baseData,
        time_source: "SERVER_ANCHORED",
        time_token: record.time_token,
        elapsed_since_anchor_ms: record.elapsed_since_anchor_ms,
      },
    };
  }

  if (record.time_source === "DEVICE_CLOCK_UNVERIFIED") {
    if (
      (Object.hasOwn(record, "time_token") && record.time_token !== null) ||
      (Object.hasOwn(record, "elapsed_since_anchor_ms") &&
        record.elapsed_since_anchor_ms !== null)
    ) {
      return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
    }
    return {
      ok: true,
      data: {
        ...baseData,
        time_source: "DEVICE_CLOCK_UNVERIFIED",
        time_token: null,
        elapsed_since_anchor_ms: null,
      },
    };
  }

  return { ok: false, code: "ATTENDANCE_REQUEST_INVALID" };
}

export function computeAttendanceRequestFingerprint(input: {
  app_user_id: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  address_hint: string;
  note: string;
  device_claimed_at_ms: number;
  time_source: AttendanceTimeSource;
  time_token_digest: string | null;
  elapsed_since_anchor_ms: number | null;
  photo_sha256: string;
  photo_size_bytes: number;
  photo_mime_type: typeof ATTENDANCE_PHOTO_MIME_TYPE;
}): string {
  const canonicalPayload = JSON.stringify({
    v: "attendance-checkin-fp/1",
    app_user_id: input.app_user_id.trim().toLowerCase(),
    latitude: normalizeZero(input.latitude),
    longitude: normalizeZero(input.longitude),
    accuracy_meters: normalizeZero(input.accuracy_meters),
    address_hint: input.address_hint,
    note: input.note,
    device_claimed_at_ms: input.device_claimed_at_ms,
    time_source: input.time_source,
    time_token_digest: input.time_token_digest,
    elapsed_since_anchor_ms: input.elapsed_since_anchor_ms,
    photo_sha256: input.photo_sha256,
    photo_size_bytes: input.photo_size_bytes,
    photo_mime_type: input.photo_mime_type,
  });

  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export type AttendanceCheckInProjection = {
  checkin_id: string;
  business_date: string;
  sequence_in_day: number;
  daily_count: number;
  captured_at: string;
  received_at: string;
  time_source: AttendanceTimeSource;
  replayed: boolean;
};

const EXACT_CHECKIN_RESPONSE_KEYS = [
  "business_date",
  "captured_at",
  "checkin_id",
  "daily_count",
  "received_at",
  "replayed",
  "sequence_in_day",
  "time_source",
] as const;

export function projectCheckInRecord(raw: unknown): AttendanceCheckInProjection | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const ownKeys = Object.getOwnPropertyNames(raw).sort();
  if (
    ownKeys.length !== EXACT_CHECKIN_RESPONSE_KEYS.length ||
    ownKeys.some((key, index) => key !== EXACT_CHECKIN_RESPONSE_KEYS[index])
  ) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.checkin_id !== "string" ||
    !isUuid(row.checkin_id) ||
    typeof row.business_date !== "string" ||
    !ISO_DATE.test(row.business_date) ||
    typeof row.sequence_in_day !== "number" ||
    !Number.isSafeInteger(row.sequence_in_day) ||
    row.sequence_in_day < 1 ||
    typeof row.daily_count !== "number" ||
    !Number.isSafeInteger(row.daily_count) ||
    row.daily_count < 1 ||
    typeof row.captured_at !== "string" ||
    !parseStrictIsoInstant(row.captured_at).ok ||
    typeof row.received_at !== "string" ||
    !parseStrictIsoInstant(row.received_at).ok ||
    (row.time_source !== "SERVER_ANCHORED" &&
      row.time_source !== "DEVICE_CLOCK_UNVERIFIED") ||
    typeof row.replayed !== "boolean"
  ) {
    return null;
  }

  return {
    checkin_id: row.checkin_id.toLowerCase(),
    business_date: row.business_date,
    sequence_in_day: row.sequence_in_day,
    daily_count: row.daily_count,
    captured_at: row.captured_at,
    received_at: row.received_at,
    time_source: row.time_source,
    replayed: row.replayed,
  };
}
