import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  hasAnyValidPairedGrant,
  hasPairedCapability,
  type ActorResolution,
  type DirectEntryActor,
} from "../auth/direct-entry-v2.ts";
import {
  decideSessionPageAccess,
  type SessionPageDecision,
} from "../auth/session-page-access.ts";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";
import {
  createLatestRequestTracker,
  type LatestRequestTicket,
  type LatestRequestTracker,
} from "../salary-advance/salary-advance-ui-model.ts";
import { formatFileSizeVi } from "../vendor-finance/ui-model.ts";
import {
  BULLETIN_ALLOWED_MIME_TYPES,
  BULLETIN_CATEGORIES,
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE,
  BULLETIN_DEFAULT_AUTHOR_DISPLAY,
  BULLETIN_MAX_ARCHIVE_PAGE_SIZE,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_STATUSES,
  isPlainRecord,
  type BulletinArchiveData,
  type BulletinArchiveQuery,
  type BulletinArchiveStatusFilter,
  type BulletinAttachFileData,
  type BulletinAttachment,
  type BulletinAttachmentKind,
  type BulletinAttachmentMimeType,
  type BulletinAuthorOption,
  type BulletinCategory,
  type BulletinCreatePayload,
  type BulletinDeleteAttachmentData,
  type BulletinErrorCode,
  type BulletinItem,
  type BulletinLifecycleActionPayload,
  type BulletinMutationData,
  type BulletinPinPayload,
  type BulletinStatus,
  type BulletinUpdatePayload,
} from "./contract.ts";

export {
  BULLETIN_ALLOWED_MIME_TYPES,
  BULLETIN_CATEGORIES,
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE,
  BULLETIN_DEFAULT_AUTHOR_DISPLAY,
  BULLETIN_MAX_ARCHIVE_PAGE_SIZE,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_STATUSES,
  createLatestRequestTracker as createBulletinLatestRequestTracker,
  formatFileSizeVi as formatBulletinFileSize,
  newIdempotencyKey,
};

export type {
  BulletinArchiveData,
  BulletinArchiveQuery,
  BulletinArchiveStatusFilter,
  BulletinAttachFileData,
  BulletinAttachment,
  BulletinAttachmentKind,
  BulletinAttachmentMimeType,
  BulletinAuthorOption,
  BulletinCategory,
  BulletinCreatePayload,
  BulletinDeleteAttachmentData,
  BulletinErrorCode,
  BulletinItem,
  BulletinLifecycleActionPayload,
  BulletinMutationData,
  BulletinPinPayload,
  BulletinStatus,
  BulletinUpdatePayload,
  LatestRequestTicket,
  LatestRequestTracker,
};

export const BULLETIN_STATUS_LABELS: Readonly<Record<BulletinStatus, string>> =
  Object.freeze({
    DRAFT: "Bản nháp",
    PUBLISHED: "Đã xuất bản",
    ARCHIVED: "Lưu trữ",
  });

export const BULLETIN_CATEGORY_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: BulletinCategory | "";
  readonly label: string;
}> = Object.freeze([
  { value: "", label: "Tất cả" },
  ...BULLETIN_CATEGORIES.map((category) => ({
    value: category,
    label: BULLETIN_CATEGORY_LABELS[category],
  })),
]);

export const BULLETIN_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: BulletinArchiveStatusFilter;
  readonly label: string;
}> = Object.freeze([
  { value: "ALL", label: "Tất cả" },
  { value: "PUBLISHED", label: BULLETIN_STATUS_LABELS.PUBLISHED },
  { value: "DRAFT", label: BULLETIN_STATUS_LABELS.DRAFT },
  { value: "ARCHIVED", label: BULLETIN_STATUS_LABELS.ARCHIVED },
]);

const SINGLE_LINE_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const MULTILINE_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const ATTACHMENT_EXT_TO_MIME: Readonly<Record<string, BulletinAttachmentMimeType>> =
  Object.freeze({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  });

export type BulletinsPageAccessDecision = "NOT_FOUND" | SessionPageDecision;

/**
 * Server boundary decision for `/bulletins`.
 * - Checks `DIRECT_ENTRY_API_ENABLED === "true"` first (`"NOT_FOUND"` otherwise).
 * - Delegates session/account state to `decideSessionPageAccess(actor)`.
 */
export function decideBulletinsPageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
}): BulletinsPageAccessDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  return decideSessionPageAccess(input.actor);
}

function hasAllBulletinAuthorityCapability(
  actor: DirectEntryActor,
  capability:
    | "bulletin_manage"
    | "entry_admin"
    | "entry_restore"
    | "recruiter_master_manage",
): boolean {
  if (actor.effective_grants !== undefined) {
    return actor.enabled === true
      ? hasPairedCapability(actor, capability, { kind: "all" })
      : hasAnyValidPairedGrant(actor, capability, ["ALL"]);
  }
  return (
    Array.isArray(actor.capabilities) &&
    hasAnyValidPairedGrant(actor, capability, ["ALL"])
  );
}

/**
 * Mirrors SQL `hr_bulletin__internal_has_manage_authority`:
 * - `enabled !== false` AND
 * - (`bulletin_manage @ ALL` OR (`entry_admin` + `entry_restore` + `recruiter_master_manage` @ `ALL`)).
 */
export function canManageBulletins(
  actor: DirectEntryActor | null | undefined,
): boolean {
  if (!actor || actor.enabled === false) {
    return false;
  }
  return (
    hasAllBulletinAuthorityCapability(actor, "bulletin_manage") ||
    (hasAllBulletinAuthorityCapability(actor, "entry_admin") &&
      hasAllBulletinAuthorityCapability(actor, "entry_restore") &&
      hasAllBulletinAuthorityCapability(actor, "recruiter_master_manage"))
  );
}

export type BulletinArchiveFilterState = {
  readonly fromDate: string;
  readonly toDate: string;
  readonly category: BulletinCategory | "";
  readonly status: BulletinArchiveStatusFilter | "";
  readonly author: string;
  readonly q: string;
  readonly page: number;
  readonly pageSize: number;
};

export const EMPTY_BULLETIN_ARCHIVE_FILTERS: BulletinArchiveFilterState =
  Object.freeze({
    fromDate: "",
    toDate: "",
    category: "",
    status: "",
    author: "",
    q: "",
    page: 1,
    pageSize: BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE,
  });

export function validateBulletinArchiveFilters(
  filters: BulletinArchiveFilterState,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const from = filters.fromDate.trim();
  const to = filters.toDate.trim();
  if (from !== "" && !isRealCalendarDate(from)) {
    return {
      ok: false,
      message: "Ngày bắt đầu phát hành không hợp lệ (YYYY-MM-DD).",
    };
  }
  if (to !== "" && !isRealCalendarDate(to)) {
    return {
      ok: false,
      message: "Ngày kết thúc phát hành không hợp lệ (YYYY-MM-DD).",
    };
  }
  if (from !== "" && to !== "" && from > to) {
    return {
      ok: false,
      message:
        "Khoảng ngày phát hành không hợp lệ: 'Từ ngày' không được lớn hơn 'Đến ngày'.",
    };
  }

  if (
    filters.category !== "" &&
    !(BULLETIN_CATEGORIES as readonly string[]).includes(filters.category)
  ) {
    return {
      ok: false,
      message: "Chuyên mục lọc không hợp lệ.",
    };
  }

  if (
    filters.status !== "" &&
    filters.status !== "ALL" &&
    !(BULLETIN_STATUSES as readonly string[]).includes(filters.status)
  ) {
    return {
      ok: false,
      message: "Trạng thái lọc không hợp lệ.",
    };
  }

  const author = filters.author.trim();
  if (author.length > 160 || SINGLE_LINE_CONTROL_CHAR_PATTERN.test(author)) {
    return {
      ok: false,
      message: "Tên người/bộ phận phát hành không hợp lệ (tối đa 160 ký tự).",
    };
  }

  const q = filters.q.trim();
  if (q.length > 200 || SINGLE_LINE_CONTROL_CHAR_PATTERN.test(q)) {
    return {
      ok: false,
      message: "Từ khóa tìm kiếm không hợp lệ (tối đa 200 ký tự).",
    };
  }

  if (
    !Number.isSafeInteger(filters.page) ||
    filters.page < 1 ||
    filters.page > 100_000
  ) {
    return {
      ok: false,
      message: "Số trang không hợp lệ.",
    };
  }

  if (
    !Number.isSafeInteger(filters.pageSize) ||
    filters.pageSize < 1 ||
    filters.pageSize > BULLETIN_MAX_ARCHIVE_PAGE_SIZE
  ) {
    return {
      ok: false,
      message: `Kích thước trang phải từ 1 đến ${BULLETIN_MAX_ARCHIVE_PAGE_SIZE}.`,
    };
  }

  return { ok: true };
}

export function buildBulletinArchiveUrl(
  filters: BulletinArchiveFilterState,
  options?: { readonly canManage?: boolean },
): string {
  const params = new URLSearchParams();
  const fromDate = filters.fromDate.trim();
  const toDate = filters.toDate.trim();
  const author = filters.author.trim();
  const q = filters.q.trim();

  if (fromDate !== "") params.set("from_date", fromDate);
  if (toDate !== "") params.set("to_date", toDate);
  if (filters.category !== "") params.set("category", filters.category);
  if (filters.status !== "" && options?.canManage !== false) {
    params.set("status", filters.status);
  }
  if (author !== "") params.set("author", author);
  if (q !== "") params.set("q", q);

  const page =
    Number.isSafeInteger(filters.page) && filters.page >= 1
      ? Math.min(filters.page, 100_000)
      : 1;
  const pageSize =
    Number.isSafeInteger(filters.pageSize) &&
    filters.pageSize >= 1 &&
    filters.pageSize <= BULLETIN_MAX_ARCHIVE_PAGE_SIZE
      ? filters.pageSize
      : BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE;

  params.set("page", String(page));
  params.set("page_size", String(pageSize));

  return `/api/bulletins/archive?${params.toString()}`;
}

export type BulletinMarkReadData = {
  readonly bulletin_id: string;
  readonly is_read: true;
  readonly unread_count: number;
};

export type BulletinMarkAllReadData = {
  readonly unread_count: number;
};

function isValidAttachmentRecord(value: unknown): value is BulletinAttachment {
  return (
    isPlainRecord(value) &&
    typeof value.attachment_id === "string" &&
    typeof value.id === "string" &&
    (value.kind === "IMAGE" || value.kind === "PDF") &&
    typeof value.file_name === "string" &&
    typeof value.mime_type === "string" &&
    typeof value.file_size_bytes === "number" &&
    typeof value.url === "string"
  );
}

function isValidBulletinItem(value: unknown): value is BulletinItem {
  return (
    isPlainRecord(value) &&
    typeof value.bulletin_id === "string" &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.category === "string" &&
    (BULLETIN_CATEGORIES as readonly string[]).includes(value.category) &&
    typeof value.is_pinned === "boolean" &&
    typeof value.is_read === "boolean" &&
    typeof value.author_display === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.content_sections) &&
    value.content_sections.every((section) => typeof section === "string") &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isValidAttachmentRecord)
  );
}

function isValidAuthorOption(value: unknown): value is BulletinAuthorOption {
  return (
    isPlainRecord(value) &&
    typeof value.app_user_id === "string" &&
    typeof value.display_name === "string"
  );
}

export function extractBulletinErrorCode(payload: unknown): string | null {
  if (!isPlainRecord(payload) || payload.ok !== false) {
    return null;
  }
  return typeof payload.code === "string" && payload.code.trim().length > 0
    ? payload.code.trim()
    : null;
}

export function parseBulletinArchiveEnvelope(
  payload: unknown,
): BulletinArchiveData | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !isPlainRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  if (
    !Array.isArray(data.items) ||
    !data.items.every(isValidBulletinItem) ||
    typeof data.total_count !== "number" ||
    !Number.isSafeInteger(data.total_count) ||
    data.total_count < 0 ||
    typeof data.page !== "number" ||
    !Number.isSafeInteger(data.page) ||
    data.page < 1 ||
    typeof data.page_size !== "number" ||
    !Number.isSafeInteger(data.page_size) ||
    data.page_size < 1 ||
    typeof data.unread_count !== "number" ||
    !Number.isSafeInteger(data.unread_count) ||
    data.unread_count < 0 ||
    typeof data.can_manage !== "boolean" ||
    !Array.isArray(data.authors) ||
    !data.authors.every(isValidAuthorOption)
  ) {
    return null;
  }
  return data as unknown as BulletinArchiveData;
}

export function parseBulletinDetailEnvelope(
  payload: unknown,
): { readonly item: BulletinItem } | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !isPlainRecord(payload.data)) {
    return null;
  }
  if (!isValidBulletinItem(payload.data.item)) {
    return null;
  }
  return { item: payload.data.item };
}

export function parseBulletinMutationEnvelope(
  payload: unknown,
): (BulletinMutationData & {
  readonly attachment_id?: string;
  readonly deleted_attachment_id?: string;
  readonly deleted_storage_key?: string;
}) | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !isPlainRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  if (!isValidBulletinItem(data.item) || typeof data.replayed !== "boolean") {
    return null;
  }
  return data as unknown as BulletinMutationData & {
    readonly attachment_id?: string;
    readonly deleted_attachment_id?: string;
    readonly deleted_storage_key?: string;
  };
}

export function parseMarkReadEnvelope(
  payload: unknown,
): BulletinMarkReadData | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !isPlainRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  if (
    typeof data.bulletin_id !== "string" ||
    data.bulletin_id.trim().length === 0 ||
    data.is_read !== true ||
    typeof data.unread_count !== "number" ||
    !Number.isSafeInteger(data.unread_count) ||
    data.unread_count < 0
  ) {
    return null;
  }
  return {
    bulletin_id: data.bulletin_id,
    is_read: true,
    unread_count: data.unread_count,
  };
}

export function parseMarkAllReadEnvelope(
  payload: unknown,
): BulletinMarkAllReadData | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !isPlainRecord(payload.data)) {
    return null;
  }
  const data = payload.data;
  if (
    typeof data.unread_count !== "number" ||
    !Number.isSafeInteger(data.unread_count) ||
    data.unread_count < 0
  ) {
    return null;
  }
  return { unread_count: data.unread_count };
}

export function bulletinUiErrorMessage(
  code: BulletinErrorCode | string | null | undefined,
): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng hoặc chưa được kích hoạt.";
    case "CSRF_REJECTED":
      return "Yêu cầu bị từ chối do kiểm tra nguồn gốc phiên làm việc. Vui lòng tải lại trang.";
    case "BULLETIN_FORBIDDEN":
    case "BULLETIN_ACTOR_FORBIDDEN":
      return "Bạn không có quyền quản trị hoặc thực hiện thao tác này trên Bản tin HRPartner.";
    case "NOT_FOUND":
    case "BULLETIN_NOT_FOUND":
      return "Bản tin không tồn tại hoặc chưa được xuất bản.";
    case "BULLETIN_ATTACHMENT_NOT_FOUND":
      return "Tệp đính kèm không tồn tại hoặc đã bị xóa.";
    case "VERSION_CONFLICT":
      return "Bản tin vừa được cập nhật ở nơi khác. Vui lòng tải lại dữ liệu mới nhất trước khi lưu.";
    case "IDEMPOTENCY_CONFLICT":
      return "Mã chống gửi trùng đang xung đột với một thao tác khác. Vui lòng thử lại.";
    case "BULLETIN_PUBLISH_CONTENT_REQUIRED":
      return "Bản tin phải có ít nhất một đoạn nội dung trước khi xuất bản.";
    case "BULLETIN_TITLE_INVALID":
      return "Tiêu đề bản tin phải dài từ 1 đến 300 ký tự và không chứa ký tự điều khiển.";
    case "BULLETIN_CATEGORY_INVALID":
      return "Chuyên mục bản tin không hợp lệ.";
    case "BULLETIN_BADGE_INVALID":
      return "Nhãn nổi bật tối đa 40 ký tự và không chứa ký tự điều khiển.";
    case "BULLETIN_SUMMARY_INVALID":
      return "Tóm tắt bản tin tối đa 600 ký tự.";
    case "BULLETIN_CONTENT_SECTIONS_INVALID":
      return "Nội dung các đoạn bản tin không hợp lệ (tối đa 50 đoạn, mỗi đoạn tối đa 8.000 ký tự).";
    case "BULLETIN_AUTHOR_INVALID":
      return "Tên người/bộ phận phát hành phải từ 1 đến 160 ký tự và không chứa ký tự điều khiển.";
    case "BULLETIN_STATUS_INVALID":
      return "Trạng thái chuyển đổi bản tin không hợp lệ.";
    case "BULLETIN_DATE_RANGE_INVALID":
    case "BULLETIN_QUERY_INVALID":
    case "BULLETIN_CURSOR_INVALID":
      return "Tham số lọc hoặc tra cứu bản tin không hợp lệ.";
    case "BULLETIN_ATTACHMENT_TOO_LARGE":
    case "REQUEST_BODY_TOO_LARGE":
      return "Dung lượng tệp hoặc dữ liệu vượt quá giới hạn tối đa 15 MB.";
    case "BULLETIN_ATTACHMENT_MIME_INVALID":
      return "Định dạng tệp không được hỗ trợ. Chỉ chấp nhận ảnh JPEG, PNG, WEBP hoặc tài liệu PDF.";
    case "BULLETIN_ATTACHMENT_INVALID":
    case "BULLETIN_ATTACHMENT_SIZE_INVALID":
    case "BULLETIN_ATTACHMENT_SHA256_INVALID":
      return "Tệp đính kèm không hợp lệ hoặc bị hỏng. Vui lòng chọn tệp khác.";
    case "BULLETIN_IDEMPOTENCY_INVALID":
    case "BULLETIN_VALIDATION_ERROR":
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
      return "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại.";
    case "BULLETIN_STORAGE_UNAVAILABLE":
      return "Kho lưu trữ tệp đính kèm hiện tạm thời gián đoạn. Vui lòng thử lại sau.";
    case "BULLETIN_UNAVAILABLE":
    default:
      return "Không thể tải hoặc xử lý bản tin HRPartner lúc này. Vui lòng thử lại.";
  }
}

export type BulletinFormValues = {
  readonly title: string;
  readonly category: BulletinCategory;
  readonly badgeText: string;
  readonly summary: string;
  readonly contentSections: readonly string[];
  readonly authorDisplay: string;
  readonly isPinned: boolean;
};

export function createEmptyBulletinFormValues(): BulletinFormValues {
  return {
    title: "",
    category: "HR_NEWS",
    badgeText: "",
    summary: "",
    contentSections: [""],
    authorDisplay: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
    isPinned: false,
  };
}

export function createBulletinFormValuesFromItem(
  item: BulletinItem,
): BulletinFormValues {
  return {
    title: item.title,
    category: item.category,
    badgeText: item.badge_text ?? "",
    summary: item.summary ?? "",
    contentSections:
      item.content_sections.length > 0 ? [...item.content_sections] : [""],
    authorDisplay: item.author_display || BULLETIN_DEFAULT_AUTHOR_DISPLAY,
    isPinned: item.is_pinned,
  };
}

export type BulletinFormValidationIntent = "create" | "draft" | "publish";

export type BulletinFormValidationResult =
  | {
      readonly ok: true;
      readonly payload: BulletinCreatePayload;
    }
  | {
      readonly ok: false;
      readonly code: BulletinErrorCode;
      readonly message: string;
      readonly fieldErrors: Partial<Record<keyof BulletinFormValues, string>>;
    };

export function validateBulletinFormValues(
  values: BulletinFormValues,
  options?: { readonly intent?: BulletinFormValidationIntent },
): BulletinFormValidationResult {
  const intent = options?.intent ?? "publish";
  const fieldErrors: Partial<Record<keyof BulletinFormValues, string>> = {};
  let firstCode: BulletinErrorCode | null = null;

  const recordError = (
    field: keyof BulletinFormValues,
    code: BulletinErrorCode,
    message: string,
  ) => {
    if (!fieldErrors[field]) {
      fieldErrors[field] = message;
    }
    firstCode ??= code;
  };

  const title = typeof values.title === "string" ? values.title.trim() : "";
  if (
    title.length < 1 ||
    title.length > 300 ||
    SINGLE_LINE_CONTROL_CHAR_PATTERN.test(title)
  ) {
    recordError(
      "title",
      "BULLETIN_TITLE_INVALID",
      bulletinUiErrorMessage("BULLETIN_TITLE_INVALID"),
    );
  }

  if (
    typeof values.category !== "string" ||
    !(BULLETIN_CATEGORIES as readonly string[]).includes(values.category)
  ) {
    recordError(
      "category",
      "BULLETIN_CATEGORY_INVALID",
      bulletinUiErrorMessage("BULLETIN_CATEGORY_INVALID"),
    );
  }

  const rawBadge =
    typeof values.badgeText === "string" ? values.badgeText.trim() : "";
  let badge_text: string | null = null;
  if (rawBadge.length > 0) {
    if (
      rawBadge.length > 40 ||
      SINGLE_LINE_CONTROL_CHAR_PATTERN.test(rawBadge)
    ) {
      recordError(
        "badgeText",
        "BULLETIN_BADGE_INVALID",
        bulletinUiErrorMessage("BULLETIN_BADGE_INVALID"),
      );
    } else {
      badge_text = rawBadge;
    }
  }

  const summary =
    typeof values.summary === "string" ? values.summary.trim() : "";
  if (summary.length > 600 || MULTILINE_CONTROL_CHAR_PATTERN.test(summary)) {
    recordError(
      "summary",
      "BULLETIN_SUMMARY_INVALID",
      bulletinUiErrorMessage("BULLETIN_SUMMARY_INVALID"),
    );
  }

  const authorDisplay =
    typeof values.authorDisplay === "string"
      ? values.authorDisplay.trim()
      : "";
  if (
    authorDisplay.length < 1 ||
    authorDisplay.length > 160 ||
    SINGLE_LINE_CONTROL_CHAR_PATTERN.test(authorDisplay)
  ) {
    recordError(
      "authorDisplay",
      "BULLETIN_AUTHOR_INVALID",
      bulletinUiErrorMessage("BULLETIN_AUTHOR_INVALID"),
    );
  }

  const normalizedSections: string[] = [];
  if (!Array.isArray(values.contentSections) || values.contentSections.length > 50) {
    recordError(
      "contentSections",
      "BULLETIN_CONTENT_SECTIONS_INVALID",
      bulletinUiErrorMessage("BULLETIN_CONTENT_SECTIONS_INVALID"),
    );
  } else {
    for (const rawSection of values.contentSections) {
      if (typeof rawSection !== "string") {
        recordError(
          "contentSections",
          "BULLETIN_CONTENT_SECTIONS_INVALID",
          bulletinUiErrorMessage("BULLETIN_CONTENT_SECTIONS_INVALID"),
        );
        break;
      }
      const trimmedSection = rawSection.trim();
      if (trimmedSection.length === 0) {
        continue;
      }
      if (
        trimmedSection.length > 8000 ||
        MULTILINE_CONTROL_CHAR_PATTERN.test(trimmedSection)
      ) {
        recordError(
          "contentSections",
          "BULLETIN_CONTENT_SECTIONS_INVALID",
          bulletinUiErrorMessage("BULLETIN_CONTENT_SECTIONS_INVALID"),
        );
        break;
      }
      normalizedSections.push(trimmedSection);
    }
  }

  const requireSections = intent === "publish" || intent === "create";
  if (
    !fieldErrors.contentSections &&
    requireSections &&
    normalizedSections.length === 0
  ) {
    recordError(
      "contentSections",
      "BULLETIN_PUBLISH_CONTENT_REQUIRED",
      "Vui lòng nhập ít nhất một đoạn nội dung cho bản tin.",
    );
  }

  if (firstCode !== null) {
    const firstMessage =
      Object.values(fieldErrors)[0] ?? bulletinUiErrorMessage(firstCode);
    return {
      ok: false,
      code: firstCode,
      message: firstMessage,
      fieldErrors,
    };
  }

  return {
    ok: true,
    payload: {
      title,
      category: values.category,
      badge_text,
      summary,
      content_sections: normalizedSections,
      author_display: authorDisplay,
      is_pinned: Boolean(values.isPinned),
    },
  };
}

export type ClientAttachmentFileLike = {
  readonly name?: string | null;
  readonly type?: string | null;
  readonly size?: number | null;
};

export type ClientAttachmentValidationResult =
  | {
      readonly ok: true;
      readonly mimeType: BulletinAttachmentMimeType;
      readonly kind: BulletinAttachmentKind;
    }
  | {
      readonly ok: false;
      readonly code: BulletinErrorCode;
      readonly message: string;
    };

function extractFileExtension(fileName: string | null | undefined): string {
  if (typeof fileName !== "string") return "";
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return "";
  return trimmed.slice(dotIndex).toLowerCase();
}

export function validateAttachmentFileClient(
  file: ClientAttachmentFileLike | null | undefined,
): ClientAttachmentValidationResult {
  if (!file || typeof file !== "object") {
    return {
      ok: false,
      code: "BULLETIN_ATTACHMENT_INVALID",
      message: bulletinUiErrorMessage("BULLETIN_ATTACHMENT_INVALID"),
    };
  }

  const size = file.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    return {
      ok: false,
      code: "BULLETIN_ATTACHMENT_INVALID",
      message: "Tệp đính kèm rỗng hoặc không hợp lệ.",
    };
  }
  if (size > BULLETIN_MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: "BULLETIN_ATTACHMENT_TOO_LARGE",
      message: bulletinUiErrorMessage("BULLETIN_ATTACHMENT_TOO_LARGE"),
    };
  }

  const declaredMime =
    typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
  const ext = extractFileExtension(file.name);
  const extMime = ext !== "" ? ATTACHMENT_EXT_TO_MIME[ext] : undefined;

  let resolvedMime: BulletinAttachmentMimeType | null = null;
  if (declaredMime !== "") {
    if (!(BULLETIN_ALLOWED_MIME_TYPES as readonly string[]).includes(declaredMime)) {
      return {
        ok: false,
        code: "BULLETIN_ATTACHMENT_MIME_INVALID",
        message: bulletinUiErrorMessage("BULLETIN_ATTACHMENT_MIME_INVALID"),
      };
    }
    if (ext !== "" && extMime !== declaredMime) {
      return {
        ok: false,
        code: "BULLETIN_ATTACHMENT_INVALID",
        message: "Phần mở rộng tệp không khớp với định dạng nội dung đã chọn.",
      };
    }
    resolvedMime = declaredMime as BulletinAttachmentMimeType;
  } else if (extMime) {
    resolvedMime = extMime;
  }

  if (!resolvedMime) {
    return {
      ok: false,
      code: "BULLETIN_ATTACHMENT_MIME_INVALID",
      message: bulletinUiErrorMessage("BULLETIN_ATTACHMENT_MIME_INVALID"),
    };
  }

  return {
    ok: true,
    mimeType: resolvedMime,
    kind: resolvedMime === "application/pdf" ? "PDF" : "IMAGE",
  };
}

export type BulletinAccessLossKind = "UNAUTHENTICATED" | "ACTOR_NOT_AVAILABLE";

export function classifyBulletinAccessLoss(
  status: number,
  code: string | null,
): BulletinAccessLossKind | null {
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "UNAUTHENTICATED";
  }
  if (code === "ACTOR_NOT_AVAILABLE") {
    return "ACTOR_NOT_AVAILABLE";
  }
  return null;
}
