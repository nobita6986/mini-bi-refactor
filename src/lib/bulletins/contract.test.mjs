import assert from "node:assert/strict";
import test from "node:test";

import {
  BULLETIN_ALLOWED_MIME_TYPES,
  BULLETIN_CATEGORIES,
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_CMS_MAX_BODY_BYTES,
  BULLETIN_DEFAULT_AUTHOR_DISPLAY,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_READ_MAX_BODY_BYTES,
  BULLETIN_STATUSES,
  BulletinValidationError,
  bulletinHttpStatusForError,
  containsForbiddenClientAuthorityKey,
  decodeBulletinCursor,
  encodeBulletinCursor,
  parseBulletinArchiveQuery,
  parseBulletinFeedQuery,
  readBoundedJsonBody,
  validateCreateBulletinBody,
  validateIdempotencyKeyHeader,
  validateLifecycleActionBody,
  validatePinBulletinBody,
  validateUpdateBulletinBody,
} from "./contract.ts";

const BULLETIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function assertBulletinValidationError(fnOrPromise, expectedCode, expectedStatus = 400) {
  if (typeof fnOrPromise === "function") {
    assert.throws(fnOrPromise, (err) => {
      assert.ok(err instanceof BulletinValidationError);
      assert.equal(err.code, expectedCode);
      assert.equal(err.status, expectedStatus);
      return true;
    });
    return;
  }
  return assert.rejects(fnOrPromise, (err) => {
    assert.ok(err instanceof BulletinValidationError);
    assert.equal(err.code, expectedCode);
    assert.equal(err.status, expectedStatus);
    return true;
  });
}

test("categories, labels, constants, and HTTP error status map", () => {
  assert.deepEqual(BULLETIN_CATEGORIES, [
    "HR_NEWS",
    "HOLIDAY_SCHEDULE",
    "INTERNAL_POLICY",
    "GENERAL",
  ]);
  assert.deepEqual(BULLETIN_CATEGORY_LABELS, {
    HR_NEWS: "Tin nhân sự",
    HOLIDAY_SCHEDULE: "Lịch nghỉ lễ",
    INTERNAL_POLICY: "Vận hành",
    GENERAL: "Thông báo chung",
  });
  assert.deepEqual(BULLETIN_STATUSES, ["DRAFT", "PUBLISHED", "ARCHIVED"]);
  assert.deepEqual(BULLETIN_ALLOWED_MIME_TYPES, [
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);
  assert.equal(BULLETIN_MAX_ATTACHMENT_BYTES, 15_728_640);
  assert.equal(BULLETIN_READ_MAX_BODY_BYTES, 1024);
  assert.equal(BULLETIN_CMS_MAX_BODY_BYTES, 262_144);

  assert.equal(bulletinHttpStatusForError("UNAUTHENTICATED"), 401);
  assert.equal(bulletinHttpStatusForError("CSRF_REJECTED"), 403);
  assert.equal(bulletinHttpStatusForError("ACTOR_NOT_AVAILABLE"), 403);
  assert.equal(bulletinHttpStatusForError("BULLETIN_FORBIDDEN"), 403);
  assert.equal(bulletinHttpStatusForError("NOT_FOUND"), 404);
  assert.equal(bulletinHttpStatusForError("BULLETIN_NOT_FOUND"), 404);
  assert.equal(bulletinHttpStatusForError("BULLETIN_ATTACHMENT_NOT_FOUND"), 404);
  assert.equal(bulletinHttpStatusForError("VERSION_CONFLICT"), 409);
  assert.equal(bulletinHttpStatusForError("IDEMPOTENCY_CONFLICT"), 409);
  assert.equal(bulletinHttpStatusForError("REQUEST_BODY_TOO_LARGE"), 413);
  assert.equal(bulletinHttpStatusForError("BULLETIN_ATTACHMENT_TOO_LARGE"), 413);
  assert.equal(bulletinHttpStatusForError("BULLETIN_QUERY_INVALID"), 400);
  assert.equal(bulletinHttpStatusForError("BULLETIN_STORAGE_UNAVAILABLE"), 503);
  assert.equal(bulletinHttpStatusForError("BULLETIN_UNAVAILABLE"), 503);
});

test("encodeBulletinCursor / decodeBulletinCursor round-trip and tamper rejection", () => {
  const tuple = {
    is_pinned: true,
    published_at: "2026-11-27T08:15:30.123Z",
    bulletin_id: BULLETIN_ID.toUpperCase(),
    offset_count: 10,
  };
  const encoded = encodeBulletinCursor(tuple);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);

  const decoded = decodeBulletinCursor(encoded);
  assert.deepEqual(decoded, {
    is_pinned: true,
    published_at: "2026-11-27T08:15:30.123Z",
    bulletin_id: BULLETIN_ID,
    offset_count: 10,
  });

  // Tamper / malformed cursors all reject with BULLETIN_QUERY_INVALID
  const nonJsonCursor = Buffer.from("[1,2,3]", "utf8").toString("base64url");
  const extraKeyCursor = Buffer.from(
    JSON.stringify({ ...decoded, extra: 1 }),
    "utf8",
  ).toString("base64url");
  const missingKeyCursor = Buffer.from(
    JSON.stringify({ is_pinned: false, published_at: decoded.published_at, bulletin_id: BULLETIN_ID }),
    "utf8",
  ).toString("base64url");
  const outOfRangeOffset = Buffer.from(
    JSON.stringify({ ...decoded, offset_count: 101 }),
    "utf8",
  ).toString("base64url");
  const nonIsoDate = Buffer.from(
    JSON.stringify({ ...decoded, published_at: "2026-11-27 08:15:30" }),
    "utf8",
  ).toString("base64url");
  const badUuid = Buffer.from(
    JSON.stringify({ ...decoded, bulletin_id: "not-a-uuid" }),
    "utf8",
  ).toString("base64url");
  const flipped = `${encoded.slice(0, -2)}AA`;

  for (const bad of [
    "",
    "abc+def=",
    "not_valid_json",
    nonJsonCursor,
    extraKeyCursor,
    missingKeyCursor,
    outOfRangeOffset,
    nonIsoDate,
    badUuid,
    flipped,
    "a".repeat(513),
  ]) {
    assertBulletinValidationError(() => decodeBulletinCursor(bad), "BULLETIN_QUERY_INVALID");
  }

  assertBulletinValidationError(
    () => encodeBulletinCursor({ ...decoded, published_at: "invalid-date" }),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => encodeBulletinCursor({ ...decoded, offset_count: -1 }),
    "BULLETIN_QUERY_INVALID",
  );
});

test("parseBulletinFeedQuery enforces strict params, limit alias, conflicting page_size+limit, and cursor", () => {
  assert.deepEqual(parseBulletinFeedQuery(new URLSearchParams()), {
    category: null,
    page_size: 10,
    cursor: null,
  });

  assert.deepEqual(parseBulletinFeedQuery(new URLSearchParams("category=ALL&limit=15")), {
    category: null,
    page_size: 15,
    cursor: null,
  });

  const cursor = encodeBulletinCursor({
    is_pinned: false,
    published_at: "2026-11-20T00:00:00.000Z",
    bulletin_id: BULLETIN_ID,
    offset_count: 5,
  });
  const withCursor = parseBulletinFeedQuery(
    new URLSearchParams(`category=hr_news&page_size=20&limit=20&cursor=${cursor}`),
  );
  assert.equal(withCursor.category, "HR_NEWS");
  assert.equal(withCursor.page_size, 20);
  assert.equal(withCursor.cursor?.bulletin_id, BULLETIN_ID);

  // Unknown param
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("unknown=1")),
    "BULLETIN_QUERY_INVALID",
  );
  // Duplicate param
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("category=HR_NEWS&category=GENERAL")),
    "BULLETIN_QUERY_INVALID",
  );
  // Conflicting page_size + limit
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("page_size=10&limit=5")),
    "BULLETIN_QUERY_INVALID",
  );
  // Out of range page_size / limit
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("page_size=0")),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("limit=51")),
    "BULLETIN_QUERY_INVALID",
  );
  // Invalid category
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("category=UNKNOWN_CAT")),
    "BULLETIN_QUERY_INVALID",
  );
  // Invalid cursor
  assertBulletinValidationError(
    () => parseBulletinFeedQuery(new URLSearchParams("cursor=bad-cursor")),
    "BULLETIN_QUERY_INVALID",
  );
});

test("parseBulletinArchiveQuery validates YYYY-MM-DD dates, from_date <= to_date, filters, and pagination", () => {
  assert.deepEqual(parseBulletinArchiveQuery(new URLSearchParams()), {
    from_date: null,
    to_date: null,
    category: null,
    status: null,
    author: null,
    created_by: null,
    q: null,
    page: 1,
    page_size: 20,
  });

  const valid = parseBulletinArchiveQuery(
    new URLSearchParams(
      `from_date=2026-11-01&to_date=2026-11-27&category=holiday_schedule&status=published&author=HRPartner&created_by=${USER_ID.toUpperCase()}&q=Tết&page=2&page_size=50`,
    ),
  );
  assert.deepEqual(valid, {
    from_date: "2026-11-01",
    to_date: "2026-11-27",
    category: "HOLIDAY_SCHEDULE",
    status: "PUBLISHED",
    author: "HRPartner",
    created_by: USER_ID,
    q: "Tết",
    page: 2,
    page_size: 50,
  });

  // from_date > to_date rejected
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("from_date=2026-11-28&to_date=2026-11-01")),
    "BULLETIN_QUERY_INVALID",
  );
  // Unreal calendar date rejected
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("from_date=2026-02-30")),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("to_date=2026/11/27")),
    "BULLETIN_QUERY_INVALID",
  );
  // Unknown param, bad status, bad UUID, page_size > 50
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("extra=1")),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("status=DELETED")),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("created_by=not-uuid")),
    "BULLETIN_QUERY_INVALID",
  );
  assertBulletinValidationError(
    () => parseBulletinArchiveQuery(new URLSearchParams("page_size=51")),
    "BULLETIN_QUERY_INVALID",
  );
});

test("Admin validators, idempotency header, forbidden authority keys, and bounded JSON reader", async () => {
  const created = validateCreateBulletinBody({
    title: "  Thông báo nghỉ lễ Quốc Khánh  ",
    category: "holiday_schedule",
    badge_text: "  Quan trọng ",
    summary: " Dòng 1\nDòng 2 ",
    content_sections: [" Đoạn 1\nChi tiết ", " Đoạn 2 "],
  });
  assert.deepEqual(created, {
    title: "Thông báo nghỉ lễ Quốc Khánh",
    category: "HOLIDAY_SCHEDULE",
    badge_text: "Quan trọng",
    summary: "Dòng 1\nDòng 2",
    content_sections: ["Đoạn 1\nChi tiết", "Đoạn 2"],
    author_display: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
    is_pinned: false,
  });

  assertBulletinValidationError(
    () => validateCreateBulletinBody({ title: "A\x00B", category: "GENERAL" }),
    "BULLETIN_TITLE_INVALID",
  );
  assertBulletinValidationError(
    () => validateCreateBulletinBody({ title: "OK", category: "INVALID" }),
    "BULLETIN_CATEGORY_INVALID",
  );
  assertBulletinValidationError(
    () => validateCreateBulletinBody({ title: "OK", category: "GENERAL", extra: 1 }),
    "BULLETIN_VALIDATION_ERROR",
  );

  const updated = validateUpdateBulletinBody({
    expected_row_version: 3,
    title: "Bản tin cập nhật",
    category: "INTERNAL_POLICY",
    content_sections: ["Mục 1"],
  });
  assert.equal(updated.expected_row_version, 3);
  assert.equal(updated.is_pinned, null);
  assert.equal(updated.author_display, BULLETIN_DEFAULT_AUTHOR_DISPLAY);

  assert.deepEqual(validatePinBulletinBody({ is_pinned: true, expected_row_version: 2 }), {
    is_pinned: true,
    expected_row_version: 2,
  });
  assert.deepEqual(validateLifecycleActionBody({ expected_row_version: 4 }), {
    expected_row_version: 4,
  });
  assertBulletinValidationError(
    () => validateLifecycleActionBody({ expected_row_version: 0 }),
    "BULLETIN_VALIDATION_ERROR",
  );

  assert.equal(validateIdempotencyKeyHeader("  req-123  "), "req-123");
  assertBulletinValidationError(() => validateIdempotencyKeyHeader(null), "BULLETIN_IDEMPOTENCY_INVALID");
  assertBulletinValidationError(() => validateIdempotencyKeyHeader("   "), "BULLETIN_IDEMPOTENCY_INVALID");
  assertBulletinValidationError(() => validateIdempotencyKeyHeader("a".repeat(129)), "BULLETIN_IDEMPOTENCY_INVALID");

  // Forbidden client authority keys
  assert.equal(containsForbiddenClientAuthorityKey({ title: "OK", nested: [{ app_user_id: USER_ID }] }), true);
  assert.equal(containsForbiddenClientAuthorityKey({ created_by: USER_ID }), true);
  assert.equal(containsForbiddenClientAuthorityKey({ capabilities: ["bulletin_manage"] }), true);
  assert.equal(containsForbiddenClientAuthorityKey({ title: "OK", content_sections: ["A"] }), false);

  // Bounded JSON reader
  const emptyReq = new Request("https://bi2.hrpartner.vn/api/bulletins/read-all", { method: "POST" });
  assert.deepEqual(await readBoundedJsonBody(emptyReq, BULLETIN_READ_MAX_BODY_BYTES, { allowEmpty: true }), {});

  const exactOk = new Request("https://bi2.hrpartner.vn/api/bulletins/read-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.deepEqual(await readBoundedJsonBody(exactOk, BULLETIN_READ_MAX_BODY_BYTES, { allowEmpty: true }), {});

  const overLimit = new Request("https://bi2.hrpartner.vn/api/bulletins/read-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(1025) }),
  });
  await assertBulletinValidationError(
    readBoundedJsonBody(overLimit, BULLETIN_READ_MAX_BODY_BYTES, { allowEmpty: true }),
    "REQUEST_BODY_TOO_LARGE",
    413,
  );
});
