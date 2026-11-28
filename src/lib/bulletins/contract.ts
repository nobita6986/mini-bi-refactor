import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import { containsForbiddenClientAuthorityKey } from "../recruitment-posts/contract.ts";

export { containsForbiddenClientAuthorityKey };

export const BULLETIN_CATEGORIES = [
  "HR_NEWS",
  "HOLIDAY_SCHEDULE",
  "INTERNAL_POLICY",
  "GENERAL",
] as const;

export type BulletinCategory = (typeof BULLETIN_CATEGORIES)[number];

export const BULLETIN_CATEGORY_LABELS: Readonly<Record<BulletinCategory, string>> = {
  HR_NEWS: "Tin nhân sự",
  HOLIDAY_SCHEDULE: "Lịch nghỉ lễ",
  INTERNAL_POLICY: "Vận hành",
  GENERAL: "Thông báo chung",
};

export const BULLETIN_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type BulletinStatus = (typeof BULLETIN_STATUSES)[number];

export const BULLETIN_ATTACHMENT_KINDS = ["IMAGE", "PDF"] as const;
export type BulletinAttachmentKind = (typeof BULLETIN_ATTACHMENT_KINDS)[number];

export const BULLETIN_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
export type BulletinAttachmentMimeType = (typeof BULLETIN_ALLOWED_MIME_TYPES)[number];

export const BULLETIN_MIME_EXTENSIONS: Readonly<Record<BulletinAttachmentMimeType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export const BULLETIN_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15,728,640 bytes
export const BULLETIN_READ_MAX_BODY_BYTES = 1024;
export const BULLETIN_CMS_MAX_BODY_BYTES = 256 * 1024;
export const BULLETIN_DEFAULT_FEED_PAGE_SIZE = 10;
export const BULLETIN_MAX_FEED_PAGE_SIZE = 50;
export const BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE = 20;
export const BULLETIN_MAX_ARCHIVE_PAGE_SIZE = 50;
export const BULLETIN_DEFAULT_AUTHOR_DISPLAY = "Phòng Hành chính - Nhân sự HRPartner";

const SINGLE_LINE_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const MULTILINE_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d{0,6}$/;

export const BULLETIN_ERROR_CODES = [
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "CSRF_REJECTED",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "INVALID_JSON",
  "REQUEST_BODY_TOO_LARGE",
  "BULLETIN_IDEMPOTENCY_INVALID",
  "BULLETIN_QUERY_INVALID",
  "BULLETIN_VALIDATION_ERROR",
  "BULLETIN_TITLE_INVALID",
  "BULLETIN_CATEGORY_INVALID",
  "BULLETIN_BADGE_INVALID",
  "BULLETIN_SUMMARY_INVALID",
  "BULLETIN_CONTENT_SECTIONS_INVALID",
  "BULLETIN_AUTHOR_INVALID",
  "BULLETIN_STATUS_INVALID",
  "BULLETIN_DATE_RANGE_INVALID",
  "BULLETIN_CURSOR_INVALID",
  "BULLETIN_PUBLISH_CONTENT_REQUIRED",
  "BULLETIN_ATTACHMENT_INVALID",
  "BULLETIN_ATTACHMENT_MIME_INVALID",
  "BULLETIN_ATTACHMENT_SIZE_INVALID",
  "BULLETIN_ATTACHMENT_SHA256_INVALID",
  "BULLETIN_ATTACHMENT_TOO_LARGE",
  "BULLETIN_FORBIDDEN",
  "BULLETIN_ACTOR_FORBIDDEN",
  "BULLETIN_NOT_FOUND",
  "BULLETIN_ATTACHMENT_NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "BULLETIN_STORAGE_UNAVAILABLE",
  "BULLETIN_UNAVAILABLE",
] as const;

export type BulletinErrorCode = (typeof BULLETIN_ERROR_CODES)[number];

export function bulletinHttpStatusForError(code: BulletinErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_REJECTED":
    case "BULLETIN_FORBIDDEN":
    case "BULLETIN_ACTOR_FORBIDDEN":
      return 403;
    case "NOT_FOUND":
    case "BULLETIN_NOT_FOUND":
    case "BULLETIN_ATTACHMENT_NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "REQUEST_BODY_TOO_LARGE":
    case "BULLETIN_ATTACHMENT_TOO_LARGE":
      return 413;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
    case "BULLETIN_IDEMPOTENCY_INVALID":
    case "BULLETIN_QUERY_INVALID":
    case "BULLETIN_VALIDATION_ERROR":
    case "BULLETIN_TITLE_INVALID":
    case "BULLETIN_CATEGORY_INVALID":
    case "BULLETIN_BADGE_INVALID":
    case "BULLETIN_SUMMARY_INVALID":
    case "BULLETIN_CONTENT_SECTIONS_INVALID":
    case "BULLETIN_AUTHOR_INVALID":
    case "BULLETIN_STATUS_INVALID":
    case "BULLETIN_DATE_RANGE_INVALID":
    case "BULLETIN_CURSOR_INVALID":
    case "BULLETIN_PUBLISH_CONTENT_REQUIRED":
    case "BULLETIN_ATTACHMENT_INVALID":
    case "BULLETIN_ATTACHMENT_MIME_INVALID":
    case "BULLETIN_ATTACHMENT_SIZE_INVALID":
    case "BULLETIN_ATTACHMENT_SHA256_INVALID":
      return 400;
    case "BULLETIN_STORAGE_UNAVAILABLE":
    case "BULLETIN_UNAVAILABLE":
    default:
      return 503;
  }
}

export class BulletinValidationError extends Error {
  readonly code: BulletinErrorCode;
  readonly status: number;

  constructor(
    code: BulletinErrorCode,
    message: string = code,
    status: number = bulletinHttpStatusForError(code),
  ) {
    super(message);
    this.name = "BulletinValidationError";
    this.code = code;
    this.status = status;
  }
}

export type BulletinAttachment = {
  attachment_id: string;
  id: string;
  kind: BulletinAttachmentKind;
  file_name: string;
  title: string;
  mime_type: BulletinAttachmentMimeType;
  file_size_bytes: number;
  url: string;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  page_count: number | null;
  sha256: string;
};

export type BulletinAttachmentContentMeta = {
  attachment_id: string;
  id: string;
  bulletin_id: string;
  kind: BulletinAttachmentKind;
  file_name: string;
  title: string;
  mime_type: BulletinAttachmentMimeType;
  file_size_bytes: number;
  storage_key: string;
  width: number | null;
  height: number | null;
  page_count: number | null;
  sha256: string;
};

export type BulletinItem = {
  bulletin_id: string;
  id: string;
  title: string;
  category: BulletinCategory;
  category_display: string;
  badge_text: string | null;
  is_pinned: boolean;
  is_read: boolean;
  published_at: string | null;
  published_date_display: string;
  author_display: string;
  summary: string;
  content_sections: string[];
  image_count: number;
  pdf_count: number;
  attachment_summary: {
    image_count: number;
    pdf_count: number;
  };
  attachments: BulletinAttachment[];
  status?: BulletinStatus;
  row_version?: number;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
  updated_by?: string;
};

export type BulletinAuthorOption = {
  app_user_id: string;
  display_name: string;
};

export type BulletinCursorTuple = {
  is_pinned: boolean;
  published_at: string;
  bulletin_id: string;
  offset_count: number;
};

export type BulletinMobileFeedData = {
  items: BulletinItem[];
  unread_count: number;
  latest_published_at: string | null;
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
};

export type BulletinArchiveData = {
  items: BulletinItem[];
  total_count: number;
  page: number;
  page_size: number;
  unread_count: number;
  can_manage: boolean;
  authors: BulletinAuthorOption[];
};

export type BulletinMutationData = {
  item: BulletinItem;
  replayed: boolean;
};

export type BulletinAttachFileData = BulletinMutationData & {
  attachment_id: string;
};

export type BulletinDeleteAttachmentData = BulletinMutationData & {
  deleted_attachment_id: string;
  deleted_storage_key: string;
};

export type BulletinFeedQuery = {
  category: BulletinCategory | null;
  page_size: number;
  cursor: BulletinCursorTuple | null;
};

export type BulletinArchiveStatusFilter = BulletinStatus | "ALL";

export type BulletinArchiveQuery = {
  from_date: string | null;
  to_date: string | null;
  category: BulletinCategory | null;
  status: BulletinArchiveStatusFilter | null;
  author: string | null;
  created_by: string | null;
  q: string | null;
  page: number;
  page_size: number;
};

export type BulletinCreatePayload = {
  title: string;
  category: BulletinCategory;
  badge_text: string | null;
  summary: string;
  content_sections: string[];
  author_display: string;
  is_pinned: boolean;
};

export type BulletinUpdatePayload = {
  expected_row_version: number;
  title: string;
  category: BulletinCategory;
  badge_text: string | null;
  summary: string;
  content_sections: string[];
  author_display: string;
  is_pinned: boolean | null;
};

export type BulletinPinPayload = {
  is_pinned: boolean;
  expected_row_version: number;
};

export type BulletinLifecycleActionPayload = {
  expected_row_version: number;
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  errorCode: BulletinErrorCode = "BULLETIN_VALIDATION_ERROR",
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new BulletinValidationError(errorCode, `Unexpected field: ${key}`);
    }
  }
}

function normalizeTextField(
  raw: unknown,
  options: {
    minLen: number;
    maxLen: number;
    allowMultiline: boolean;
    errorCode: BulletinErrorCode;
  },
): string {
  if (typeof raw !== "string") {
    throw new BulletinValidationError(options.errorCode);
  }
  const trimmed = raw.trim();
  if (trimmed.length < options.minLen || trimmed.length > options.maxLen) {
    throw new BulletinValidationError(options.errorCode);
  }
  const pattern = options.allowMultiline
    ? MULTILINE_CONTROL_CHAR_PATTERN
    : SINGLE_LINE_CONTROL_CHAR_PATTERN;
  if (pattern.test(trimmed)) {
    throw new BulletinValidationError(options.errorCode);
  }
  return trimmed;
}

function parseCategoryValue(
  raw: string,
  errorCode: BulletinErrorCode,
): BulletinCategory | null {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "" || normalized === "ALL") {
    return null;
  }
  if ((BULLETIN_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as BulletinCategory;
  }
  throw new BulletinValidationError(errorCode);
}

function parsePositiveIntInRange(
  raw: string,
  min: number,
  max: number,
  errorCode: BulletinErrorCode,
): number {
  const trimmed = raw.trim();
  if (!POSITIVE_INT_PATTERN.test(trimmed)) {
    throw new BulletinValidationError(errorCode);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BulletinValidationError(errorCode);
  }
  return value;
}

export function validateRowVersion(
  raw: unknown,
  errorCode: BulletinErrorCode = "BULLETIN_VALIDATION_ERROR",
): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new BulletinValidationError(errorCode, "expected_row_version must be a positive integer");
  }
  return raw;
}

export function encodeBulletinCursor(cursor: BulletinCursorTuple): string {
  if (
    typeof cursor.is_pinned !== "boolean" ||
    typeof cursor.published_at !== "string" ||
    !ISO_UTC_PATTERN.test(cursor.published_at) ||
    !Number.isFinite(Date.parse(cursor.published_at)) ||
    !isUuid(cursor.bulletin_id) ||
    !Number.isSafeInteger(cursor.offset_count) ||
    cursor.offset_count < 0
  ) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid cursor tuple");
  }

  const canonical = JSON.stringify({
    is_pinned: cursor.is_pinned,
    published_at: cursor.published_at,
    bulletin_id: cursor.bulletin_id.toLowerCase(),
    offset_count: cursor.offset_count,
  });
  return Buffer.from(canonical, "utf8").toString("base64url");
}

export function decodeBulletinCursor(raw: string): BulletinCursorTuple {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 512 ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid bulletin cursor");
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) {
      throw new Error("Non-canonical base64url");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid bulletin cursor");
  }

  if (!isPlainRecord(parsed)) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid bulletin cursor");
  }

  const keys = Object.keys(parsed);
  if (
    keys.length !== 4 ||
    !Object.prototype.hasOwnProperty.call(parsed, "is_pinned") ||
    !Object.prototype.hasOwnProperty.call(parsed, "published_at") ||
    !Object.prototype.hasOwnProperty.call(parsed, "bulletin_id") ||
    !Object.prototype.hasOwnProperty.call(parsed, "offset_count")
  ) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid bulletin cursor");
  }

  const { is_pinned, published_at, bulletin_id, offset_count } = parsed;
  if (
    typeof is_pinned !== "boolean" ||
    typeof published_at !== "string" ||
    !ISO_UTC_PATTERN.test(published_at) ||
    !Number.isFinite(Date.parse(published_at)) ||
    !isUuid(bulletin_id) ||
    typeof offset_count !== "number" ||
    !Number.isSafeInteger(offset_count) ||
    offset_count < 0 ||
    offset_count > 100
  ) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid bulletin cursor");
  }

  return {
    is_pinned,
    published_at,
    bulletin_id: bulletin_id.toLowerCase(),
    offset_count,
  };
}

const FEED_QUERY_KEYS = new Set(["category", "page_size", "limit", "cursor"]);

export function parseBulletinFeedQuery(urlSearchParams: URLSearchParams): BulletinFeedQuery {
  const seen = new Set<string>();
  for (const [key] of urlSearchParams.entries()) {
    if (!FEED_QUERY_KEYS.has(key) || seen.has(key)) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", `Invalid query parameter: ${key}`);
    }
    seen.add(key);
  }

  let category: BulletinCategory | null = null;
  const rawCategory = urlSearchParams.get("category");
  if (rawCategory !== null) {
    category = parseCategoryValue(rawCategory, "BULLETIN_QUERY_INVALID");
  }

  const rawPageSize = urlSearchParams.get("page_size");
  const rawLimit = urlSearchParams.get("limit");

  let parsedPageSize: number | null = null;
  if (rawPageSize !== null) {
    parsedPageSize = parsePositiveIntInRange(
      rawPageSize,
      1,
      BULLETIN_MAX_FEED_PAGE_SIZE,
      "BULLETIN_QUERY_INVALID",
    );
  }

  let parsedLimit: number | null = null;
  if (rawLimit !== null) {
    parsedLimit = parsePositiveIntInRange(
      rawLimit,
      1,
      BULLETIN_MAX_FEED_PAGE_SIZE,
      "BULLETIN_QUERY_INVALID",
    );
  }

  if (parsedPageSize !== null && parsedLimit !== null && parsedPageSize !== parsedLimit) {
    throw new BulletinValidationError(
      "BULLETIN_QUERY_INVALID",
      "Conflicting page_size and limit parameters",
    );
  }

  const page_size = parsedPageSize ?? parsedLimit ?? BULLETIN_DEFAULT_FEED_PAGE_SIZE;

  let cursor: BulletinCursorTuple | null = null;
  const rawCursor = urlSearchParams.get("cursor");
  if (rawCursor !== null && rawCursor.trim() !== "") {
    cursor = decodeBulletinCursor(rawCursor.trim());
  }

  return { category, page_size, cursor };
}

const ARCHIVE_QUERY_KEYS = new Set([
  "from_date",
  "to_date",
  "category",
  "status",
  "author",
  "created_by",
  "q",
  "page",
  "page_size",
]);

export function parseBulletinArchiveQuery(
  urlSearchParams: URLSearchParams,
): BulletinArchiveQuery {
  const seen = new Set<string>();
  for (const [key] of urlSearchParams.entries()) {
    if (!ARCHIVE_QUERY_KEYS.has(key) || seen.has(key)) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", `Invalid query parameter: ${key}`);
    }
    seen.add(key);
  }

  let from_date: string | null = null;
  const rawFromDate = urlSearchParams.get("from_date");
  if (rawFromDate !== null && rawFromDate.trim() !== "") {
    const trimmed = rawFromDate.trim();
    if (!isRealCalendarDate(trimmed)) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid from_date");
    }
    from_date = trimmed;
  }

  let to_date: string | null = null;
  const rawToDate = urlSearchParams.get("to_date");
  if (rawToDate !== null && rawToDate.trim() !== "") {
    const trimmed = rawToDate.trim();
    if (!isRealCalendarDate(trimmed)) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid to_date");
    }
    to_date = trimmed;
  }

  if (from_date !== null && to_date !== null && from_date > to_date) {
    throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "from_date cannot exceed to_date");
  }

  let category: BulletinCategory | null = null;
  const rawCategory = urlSearchParams.get("category");
  if (rawCategory !== null) {
    category = parseCategoryValue(rawCategory, "BULLETIN_QUERY_INVALID");
  }

  let status: BulletinArchiveStatusFilter | null = null;
  const rawStatus = urlSearchParams.get("status");
  if (rawStatus !== null && rawStatus.trim() !== "") {
    const normalized = rawStatus.trim().toUpperCase();
    if (
      normalized !== "ALL" &&
      !(BULLETIN_STATUSES as readonly string[]).includes(normalized)
    ) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid status");
    }
    status = normalized as BulletinArchiveStatusFilter;
  }

  let author: string | null = null;
  const rawAuthor = urlSearchParams.get("author");
  if (rawAuthor !== null && rawAuthor.trim() !== "") {
    author = normalizeTextField(rawAuthor, {
      minLen: 1,
      maxLen: 160,
      allowMultiline: false,
      errorCode: "BULLETIN_QUERY_INVALID",
    });
  }

  let created_by: string | null = null;
  const rawCreatedBy = urlSearchParams.get("created_by");
  if (rawCreatedBy !== null && rawCreatedBy.trim() !== "") {
    const trimmed = rawCreatedBy.trim();
    if (!isUuid(trimmed)) {
      throw new BulletinValidationError("BULLETIN_QUERY_INVALID", "Invalid created_by");
    }
    created_by = trimmed.toLowerCase();
  }

  let q: string | null = null;
  const rawSearch = urlSearchParams.get("q");
  if (rawSearch !== null && rawSearch.trim() !== "") {
    q = normalizeTextField(rawSearch, {
      minLen: 1,
      maxLen: 200,
      allowMultiline: false,
      errorCode: "BULLETIN_QUERY_INVALID",
    });
  }

  let page = 1;
  const rawPage = urlSearchParams.get("page");
  if (rawPage !== null) {
    page = parsePositiveIntInRange(rawPage, 1, 100_000, "BULLETIN_QUERY_INVALID");
  }

  let page_size = BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE;
  const rawPageSize = urlSearchParams.get("page_size");
  if (rawPageSize !== null) {
    page_size = parsePositiveIntInRange(
      rawPageSize,
      1,
      BULLETIN_MAX_ARCHIVE_PAGE_SIZE,
      "BULLETIN_QUERY_INVALID",
    );
  }

  return {
    from_date,
    to_date,
    category,
    status,
    author,
    created_by,
    q,
    page,
    page_size,
  };
}

export function validateIdempotencyKeyHeader(raw: string | null | undefined): string {
  if (typeof raw !== "string") {
    throw new BulletinValidationError(
      "BULLETIN_IDEMPOTENCY_INVALID",
      "Idempotency-Key header is required",
    );
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 128 ||
    SINGLE_LINE_CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    throw new BulletinValidationError(
      "BULLETIN_IDEMPOTENCY_INVALID",
      "Invalid Idempotency-Key header",
    );
  }
  return trimmed;
}

export async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const allowEmpty = options.allowEmpty === true;
  const rawContentType = request.headers.get("content-type");
  const mediaType = rawContentType?.split(";")[0]?.trim().toLowerCase() ?? null;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new BulletinValidationError("INVALID_JSON", "Invalid Content-Length");
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new BulletinValidationError("INVALID_JSON", "Invalid Content-Length");
    }
    if (parsedLength > limitBytes) {
      throw new BulletinValidationError("REQUEST_BODY_TOO_LARGE", "Request body too large", 413);
    }
  }

  if (!request.body) {
    if (allowEmpty && (mediaType === null || mediaType === "application/json")) {
      return {};
    }
    throw new BulletinValidationError("INVALID_JSON", "Request body is required");
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
        throw new BulletinValidationError("REQUEST_BODY_TOO_LARGE", "Request body too large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BulletinValidationError) throw error;
    throw new BulletinValidationError("INVALID_JSON", "Failed to read request body");
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    if (allowEmpty && (mediaType === null || mediaType === "application/json")) {
      return {};
    }
    throw new BulletinValidationError("INVALID_JSON", "Empty JSON body");
  }

  if (mediaType !== "application/json") {
    throw new BulletinValidationError("INVALID_JSON", "Content-Type must be application/json");
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return JSON.parse(rawText) as unknown;
  } catch {
    throw new BulletinValidationError("INVALID_JSON", "Malformed JSON body");
  }
}

function validateBulletinCommonFields(record: Record<string, unknown>): {
  title: string;
  category: BulletinCategory;
  badge_text: string | null;
  summary: string;
  content_sections: string[];
  author_display: string;
} {
  const title = normalizeTextField(record.title, {
    minLen: 1,
    maxLen: 300,
    allowMultiline: false,
    errorCode: "BULLETIN_TITLE_INVALID",
  });

  if (typeof record.category !== "string") {
    throw new BulletinValidationError("BULLETIN_CATEGORY_INVALID");
  }
  const categoryUpper = record.category.trim().toUpperCase();
  if (!(BULLETIN_CATEGORIES as readonly string[]).includes(categoryUpper)) {
    throw new BulletinValidationError("BULLETIN_CATEGORY_INVALID");
  }
  const category = categoryUpper as BulletinCategory;

  let badge_text: string | null = null;
  if (record.badge_text !== undefined && record.badge_text !== null) {
    if (typeof record.badge_text !== "string") {
      throw new BulletinValidationError("BULLETIN_BADGE_INVALID");
    }
    if (record.badge_text.trim() !== "") {
      badge_text = normalizeTextField(record.badge_text, {
        minLen: 1,
        maxLen: 40,
        allowMultiline: false,
        errorCode: "BULLETIN_BADGE_INVALID",
      });
    }
  }

  let summary = "";
  if (record.summary !== undefined && record.summary !== null) {
    summary = normalizeTextField(record.summary, {
      minLen: 0,
      maxLen: 600,
      allowMultiline: true,
      errorCode: "BULLETIN_SUMMARY_INVALID",
    });
  }

  let content_sections: string[] = [];
  if (record.content_sections !== undefined && record.content_sections !== null) {
    if (!Array.isArray(record.content_sections) || record.content_sections.length > 50) {
      throw new BulletinValidationError("BULLETIN_CONTENT_SECTIONS_INVALID");
    }
    content_sections = record.content_sections.map((section) =>
      normalizeTextField(section, {
        minLen: 1,
        maxLen: 8000,
        allowMultiline: true,
        errorCode: "BULLETIN_CONTENT_SECTIONS_INVALID",
      }),
    );
  }

  let author_display = BULLETIN_DEFAULT_AUTHOR_DISPLAY;
  if (record.author_display !== undefined && record.author_display !== null) {
    if (typeof record.author_display !== "string") {
      throw new BulletinValidationError("BULLETIN_AUTHOR_INVALID");
    }
    if (record.author_display.trim() !== "") {
      author_display = normalizeTextField(record.author_display, {
        minLen: 1,
        maxLen: 160,
        allowMultiline: false,
        errorCode: "BULLETIN_AUTHOR_INVALID",
      });
    }
  }

  return {
    title,
    category,
    badge_text,
    summary,
    content_sections,
    author_display,
  };
}

const CREATE_BODY_KEYS = new Set([
  "title",
  "category",
  "badge_text",
  "summary",
  "content_sections",
  "author_display",
  "is_pinned",
]);

export function validateCreateBulletinBody(raw: unknown): BulletinCreatePayload {
  if (!isPlainRecord(raw)) {
    throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
  }
  assertAllowedKeys(raw, CREATE_BODY_KEYS);

  const common = validateBulletinCommonFields(raw);

  let is_pinned = false;
  if (raw.is_pinned !== undefined) {
    if (typeof raw.is_pinned !== "boolean") {
      throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
    }
    is_pinned = raw.is_pinned;
  }

  return {
    ...common,
    is_pinned,
  };
}

const UPDATE_BODY_KEYS = new Set([
  "expected_row_version",
  "title",
  "category",
  "badge_text",
  "summary",
  "content_sections",
  "author_display",
  "is_pinned",
]);

export function validateUpdateBulletinBody(raw: unknown): BulletinUpdatePayload {
  if (!isPlainRecord(raw)) {
    throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
  }
  assertAllowedKeys(raw, UPDATE_BODY_KEYS);

  const expected_row_version = validateRowVersion(raw.expected_row_version);
  const common = validateBulletinCommonFields(raw);

  let is_pinned: boolean | null = null;
  if (raw.is_pinned !== undefined && raw.is_pinned !== null) {
    if (typeof raw.is_pinned !== "boolean") {
      throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
    }
    is_pinned = raw.is_pinned;
  }

  return {
    expected_row_version,
    ...common,
    is_pinned,
  };
}

const PIN_BODY_KEYS = new Set(["is_pinned", "expected_row_version"]);

export function validatePinBulletinBody(raw: unknown): BulletinPinPayload {
  if (!isPlainRecord(raw)) {
    throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
  }
  assertAllowedKeys(raw, PIN_BODY_KEYS);

  if (typeof raw.is_pinned !== "boolean") {
    throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR", "is_pinned must be a boolean");
  }
  const expected_row_version = validateRowVersion(raw.expected_row_version);

  return {
    is_pinned: raw.is_pinned,
    expected_row_version,
  };
}

const LIFECYCLE_BODY_KEYS = new Set(["expected_row_version"]);

export function validateLifecycleActionBody(raw: unknown): BulletinLifecycleActionPayload {
  if (!isPlainRecord(raw)) {
    throw new BulletinValidationError("BULLETIN_VALIDATION_ERROR");
  }
  assertAllowedKeys(raw, LIFECYCLE_BODY_KEYS);
  return {
    expected_row_version: validateRowVersion(raw.expected_row_version),
  };
}
