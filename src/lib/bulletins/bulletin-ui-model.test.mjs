import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BULLETIN_CATEGORY_FILTER_OPTIONS,
  BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE,
  BULLETIN_DEFAULT_AUTHOR_DISPLAY,
  BULLETIN_MAX_ARCHIVE_PAGE_SIZE,
  BULLETIN_MAX_ATTACHMENT_BYTES,
  BULLETIN_STATUS_FILTER_OPTIONS,
  EMPTY_BULLETIN_ARCHIVE_FILTERS,
  buildBulletinArchiveUrl,
  bulletinUiErrorMessage,
  canManageBulletins,
  createBulletinFormValuesFromItem,
  createBulletinLatestRequestTracker,
  createEmptyBulletinFormValues,
  decideBulletinsPageAccess,
  extractBulletinErrorCode,
  formatBulletinFileSize,
  newIdempotencyKey,
  parseBulletinArchiveEnvelope,
  parseBulletinDetailEnvelope,
  parseBulletinMutationEnvelope,
  parseMarkAllReadEnvelope,
  parseMarkReadEnvelope,
  validateAttachmentFileClient,
  validateBulletinArchiveFilters,
  validateBulletinFormValues,
} from "./bulletin-ui-model.ts";

const SAMPLE_BULLETIN_ID = "11111111-1111-4111-8111-111111111111";
const SAMPLE_ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const SAMPLE_USER_ID = "33333333-3333-4333-8333-333333333333";

function makeActor(overrides = {}) {
  return {
    auth_subject: "44444444-4444-4444-8444-444444444444",
    app_user_id: SAMPLE_USER_ID,
    display_name: "Nguyễn Văn Test",
    enabled: true,
    capabilities: [],
    scopes: [],
    effective_grants: [],
    self_recruiter_suggestion: null,
    session: {
      provider: "supabase",
      verification: "getUser",
      authenticated_at: "2026-11-27T08:00:00.000Z",
    },
    ...overrides,
  };
}

function makeGrant(capability, scopeKind = "ALL", scopeId = null) {
  return {
    capability,
    scope_kind: scopeKind,
    scope_id: scopeId,
    source_type: "ROLE_BUNDLE",
    source_id: "55555555-5555-4555-8555-555555555555",
  };
}

function makeAttachment(overrides = {}) {
  return {
    attachment_id: SAMPLE_ATTACHMENT_ID,
    id: SAMPLE_ATTACHMENT_ID,
    kind: "IMAGE",
    file_name: "lich-nghi.png",
    title: "Lịch nghỉ lễ",
    mime_type: "image/png",
    file_size_bytes: 2048,
    url: `/api/bulletins/${SAMPLE_BULLETIN_ID}/attachments/${SAMPLE_ATTACHMENT_ID}/content`,
    thumbnail_url: null,
    width: 800,
    height: 600,
    page_count: null,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function makeBulletinItem(overrides = {}) {
  return {
    bulletin_id: SAMPLE_BULLETIN_ID,
    id: SAMPLE_BULLETIN_ID,
    title: "Thông báo lịch nghỉ Tết Dương Lịch 2027",
    category: "HOLIDAY_SCHEDULE",
    category_display: "Lịch nghỉ lễ",
    badge_text: "Quan trọng",
    is_pinned: true,
    is_read: false,
    published_at: "2026-11-27T08:00:00.000Z",
    published_date_display: "27-11-2026",
    author_display: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
    summary: "Thông báo lịch nghỉ lễ chính thức.",
    content_sections: ["Nghỉ từ 01/01/2027", "Đi làm lại 04/01/2027"],
    image_count: 1,
    pdf_count: 0,
    attachment_summary: { image_count: 1, pdf_count: 0 },
    attachments: [makeAttachment()],
    status: "PUBLISHED",
    row_version: 2,
    archived_at: null,
    created_at: "2026-11-27T07:00:00.000Z",
    updated_at: "2026-11-27T08:00:00.000Z",
    created_by: SAMPLE_USER_ID,
    updated_by: SAMPLE_USER_ID,
    ...overrides,
  };
}

describe("bulletin-ui-model: access and authority", () => {
  it("decideBulletinsPageAccess enforces feature flag and session/account gates fail-closed", () => {
    const validResolution = { ok: true, actor: makeActor() };

    assert.equal(
      decideBulletinsPageAccess({ enabledFlag: undefined, actor: validResolution }),
      "NOT_FOUND",
    );
    assert.equal(
      decideBulletinsPageAccess({ enabledFlag: "false", actor: validResolution }),
      "NOT_FOUND",
    );
    assert.equal(
      decideBulletinsPageAccess({ enabledFlag: "1", actor: validResolution }),
      "NOT_FOUND",
    );

    assert.equal(
      decideBulletinsPageAccess({
        enabledFlag: "true",
        actor: { ok: false, reason: "UNAUTHENTICATED" },
      }),
      "REDIRECT_LOGIN",
    );
    assert.equal(
      decideBulletinsPageAccess({
        enabledFlag: "true",
        actor: { ok: false, reason: "ACTOR_DISABLED" },
      }),
      "ACCOUNT_UNAVAILABLE",
    );
    assert.equal(
      decideBulletinsPageAccess({
        enabledFlag: "true",
        actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
      }),
      "ACCOUNT_UNAVAILABLE",
    );
    assert.equal(
      decideBulletinsPageAccess({ enabledFlag: "true", actor: null }),
      "TEMPORARY_UNAVAILABLE",
    );
    assert.equal(
      decideBulletinsPageAccess({
        enabledFlag: "true",
        actor: { ok: false, reason: "ACTOR_REPOSITORY_MISSING" },
      }),
      "TEMPORARY_UNAVAILABLE",
    );
    assert.equal(
      decideBulletinsPageAccess({
        enabledFlag: "true",
        actor: { ok: false, reason: "ACTOR_REPOSITORY_INVALID" },
      }),
      "TEMPORARY_UNAVAILABLE",
    );
    assert.equal(
      decideBulletinsPageAccess({ enabledFlag: "true", actor: validResolution }),
      "ALLOW",
    );
  });

  it("canManageBulletins grants authority only for bulletin_manage@ALL or Full Admin triple@ALL", () => {
    assert.equal(canManageBulletins(null), false);
    assert.equal(canManageBulletins(undefined), false);

    assert.equal(
      canManageBulletins(
        makeActor({
          effective_grants: [makeGrant("bulletin_manage", "ALL")],
        }),
      ),
      true,
    );

    assert.equal(
      canManageBulletins(
        makeActor({
          effective_grants: [
            makeGrant("entry_admin", "ALL"),
            makeGrant("entry_restore", "ALL"),
            makeGrant("recruiter_master_manage", "ALL"),
          ],
        }),
      ),
      true,
    );

    // Incomplete Full Admin triple must be denied
    assert.equal(
      canManageBulletins(
        makeActor({
          effective_grants: [
            makeGrant("entry_admin", "ALL"),
            makeGrant("entry_restore", "ALL"),
          ],
        }),
      ),
      false,
    );
    assert.equal(
      canManageBulletins(
        makeActor({
          effective_grants: [
            makeGrant("entry_admin", "ALL"),
            makeGrant("entry_restore", "ALL"),
            makeGrant("recruiter_master_manage", "CONTEXT_TEAM", "team_1"),
          ],
        }),
      ),
      false,
    );

    // Non-ALL scopes and stale legacy capabilities arrays must be denied when effective_grants is present
    assert.equal(
      canManageBulletins(
        makeActor({
          capabilities: ["bulletin_manage"],
          effective_grants: [makeGrant("bulletin_manage", "CONTEXT_TEAM", "team_1")],
        }),
      ),
      false,
    );
    assert.equal(
      canManageBulletins(
        makeActor({
          capabilities: ["bulletin_manage", "entry_admin", "entry_restore", "recruiter_master_manage"],
          effective_grants: [],
        }),
      ),
      false,
    );

    // RECRUITER / EMPLOYEE_BASE / disabled actors
    assert.equal(
      canManageBulletins(
        makeActor({
          effective_grants: [
            makeGrant("entry_create", "OWN"),
            makeGrant("submission_create", "OWN"),
          ],
        }),
      ),
      false,
    );
    assert.equal(
      canManageBulletins(
        makeActor({
          enabled: false,
          effective_grants: [makeGrant("bulletin_manage", "ALL")],
        }),
      ),
      false,
    );
  });
});

describe("bulletin-ui-model: archive filters and URL building", () => {
  it("validateBulletinArchiveFilters accepts empty and valid archive filter combinations", () => {
    assert.deepEqual(validateBulletinArchiveFilters(EMPTY_BULLETIN_ARCHIVE_FILTERS), {
      ok: true,
    });
    assert.deepEqual(
      validateBulletinArchiveFilters({
        fromDate: "2026-11-01",
        toDate: "2026-11-30",
        category: "HR_NEWS",
        status: "DRAFT",
        author: "Phòng Hành chính - Nhân sự HRPartner",
        q: "lịch nghỉ tết",
        page: 2,
        pageSize: BULLETIN_MAX_ARCHIVE_PAGE_SIZE,
      }),
      { ok: true },
    );
    assert.equal(BULLETIN_CATEGORY_FILTER_OPTIONS.length, 5);
    assert.equal(BULLETIN_STATUS_FILTER_OPTIONS.length, 4);
  });

  it("validateBulletinArchiveFilters rejects invalid calendar dates, inverted ranges, invalid enums, control chars, and bad paging", () => {
    const invalidFrom = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      fromDate: "2026-02-29",
    });
    assert.equal(invalidFrom.ok, false);

    const invalidTo = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      toDate: "2026/11/30",
    });
    assert.equal(invalidTo.ok, false);

    const invertedRange = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      fromDate: "2026-11-28",
      toDate: "2026-11-01",
    });
    assert.equal(invertedRange.ok, false);
    assert.match(invertedRange.message, /Từ ngày.*Đến ngày/);

    const invalidCategory = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      category: "UNKNOWN_CAT",
    });
    assert.equal(invalidCategory.ok, false);

    const invalidStatus = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      status: "DELETED",
    });
    assert.equal(invalidStatus.ok, false);

    const tooLongAuthor = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      author: "A".repeat(161),
    });
    assert.equal(tooLongAuthor.ok, false);

    const controlCharAuthor = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      author: "HR\nPartner",
    });
    assert.equal(controlCharAuthor.ok, false);

    const tooLongQ = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      q: "Q".repeat(201),
    });
    assert.equal(tooLongQ.ok, false);

    const controlCharQ = validateBulletinArchiveFilters({
      ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
      q: "abc\u0007def",
    });
    assert.equal(controlCharQ.ok, false);

    assert.equal(
      validateBulletinArchiveFilters({ ...EMPTY_BULLETIN_ARCHIVE_FILTERS, page: 0 }).ok,
      false,
    );
    assert.equal(
      validateBulletinArchiveFilters({ ...EMPTY_BULLETIN_ARCHIVE_FILTERS, page: 100_001 }).ok,
      false,
    );
    assert.equal(
      validateBulletinArchiveFilters({ ...EMPTY_BULLETIN_ARCHIVE_FILTERS, pageSize: 0 }).ok,
      false,
    );
    assert.equal(
      validateBulletinArchiveFilters({
        ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
        pageSize: BULLETIN_MAX_ARCHIVE_PAGE_SIZE + 1,
      }).ok,
      false,
    );
  });

  it("buildBulletinArchiveUrl builds encoded query params and strips status when canManage is false", () => {
    assert.equal(
      buildBulletinArchiveUrl(EMPTY_BULLETIN_ARCHIVE_FILTERS),
      `/api/bulletins/archive?page=1&page_size=${BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE}`,
    );

    const adminUrl = buildBulletinArchiveUrl(
      {
        fromDate: " 2026-11-01 ",
        toDate: " 2026-11-30 ",
        category: "INTERNAL_POLICY",
        status: "ARCHIVED",
        author: " Ban Giám đốc ",
        q: " nội quy ",
        page: 3,
        pageSize: 50,
      },
      { canManage: true },
    );
    const adminParsed = new URL(adminUrl, "https://bi2.hrpartner.vn");
    assert.equal(adminParsed.pathname, "/api/bulletins/archive");
    assert.equal(adminParsed.searchParams.get("from_date"), "2026-11-01");
    assert.equal(adminParsed.searchParams.get("to_date"), "2026-11-30");
    assert.equal(adminParsed.searchParams.get("category"), "INTERNAL_POLICY");
    assert.equal(adminParsed.searchParams.get("status"), "ARCHIVED");
    assert.equal(adminParsed.searchParams.get("author"), "Ban Giám đốc");
    assert.equal(adminParsed.searchParams.get("q"), "nội quy");
    assert.equal(adminParsed.searchParams.get("page"), "3");
    assert.equal(adminParsed.searchParams.get("page_size"), "50");

    const employeeUrl = buildBulletinArchiveUrl(
      {
        ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
        status: "DRAFT",
        page: 0,
        pageSize: 999,
      },
      { canManage: false },
    );
    const employeeParsed = new URL(employeeUrl, "https://bi2.hrpartner.vn");
    assert.equal(employeeParsed.searchParams.has("status"), false);
    assert.equal(employeeParsed.searchParams.get("page"), "1");
    assert.equal(
      employeeParsed.searchParams.get("page_size"),
      String(BULLETIN_DEFAULT_ARCHIVE_PAGE_SIZE),
    );
  });
});

describe("bulletin-ui-model: envelope parsers and error messages", () => {
  it("parseBulletinArchiveEnvelope accepts valid payload and rejects malformed shapes", () => {
    const valid = parseBulletinArchiveEnvelope({
      ok: true,
      data: {
        items: [makeBulletinItem()],
        total_count: 1,
        page: 1,
        page_size: 20,
        unread_count: 1,
        can_manage: true,
        authors: [
          { app_user_id: SAMPLE_USER_ID, display_name: "Phòng Nhân sự" },
        ],
      },
    });
    assert.ok(valid);
    assert.equal(valid.items.length, 1);
    assert.equal(valid.can_manage, true);
    assert.equal(valid.authors.length, 1);

    assert.equal(parseBulletinArchiveEnvelope(null), null);
    assert.equal(parseBulletinArchiveEnvelope({ ok: false, code: "UNAUTHENTICATED" }), null);
    assert.equal(
      parseBulletinArchiveEnvelope({
        ok: true,
        data: {
          items: [makeBulletinItem()],
          total_count: -1,
          page: 1,
          page_size: 20,
          unread_count: 0,
          can_manage: false,
          authors: [],
        },
      }),
      null,
    );
    assert.equal(
      parseBulletinArchiveEnvelope({
        ok: true,
        data: {
          items: [{ ...makeBulletinItem(), category: "INVALID" }],
          total_count: 1,
          page: 1,
          page_size: 20,
          unread_count: 0,
          can_manage: false,
          authors: [],
        },
      }),
      null,
    );
    assert.equal(
      parseBulletinArchiveEnvelope({
        ok: true,
        data: {
          items: [],
          total_count: 0,
          page: 0,
          page_size: 20,
          unread_count: 0,
          can_manage: false,
          authors: [{ app_user_id: 123, display_name: "Bad" }],
        },
      }),
      null,
    );
  });

  it("parseBulletinDetailEnvelope and parseBulletinMutationEnvelope validate item and metadata", () => {
    const detail = parseBulletinDetailEnvelope({
      ok: true,
      data: { item: makeBulletinItem() },
    });
    assert.ok(detail);
    assert.equal(detail.item.bulletin_id, SAMPLE_BULLETIN_ID);
    assert.equal(parseBulletinDetailEnvelope({ ok: true, data: { item: {} } }), null);

    const mutated = parseBulletinMutationEnvelope({
      ok: true,
      data: {
        item: makeBulletinItem(),
        replayed: true,
        attachment_id: SAMPLE_ATTACHMENT_ID,
      },
    });
    assert.ok(mutated);
    assert.equal(mutated.replayed, true);
    assert.equal(mutated.attachment_id, SAMPLE_ATTACHMENT_ID);
    assert.equal(
      parseBulletinMutationEnvelope({
        ok: true,
        data: { item: makeBulletinItem(), replayed: "yes" },
      }),
      null,
    );
  });

  it("parseMarkReadEnvelope and parseMarkAllReadEnvelope validate unread_count and flags", () => {
    assert.deepEqual(
      parseMarkReadEnvelope({
        ok: true,
        data: { bulletin_id: SAMPLE_BULLETIN_ID, is_read: true, unread_count: 3 },
      }),
      { bulletin_id: SAMPLE_BULLETIN_ID, is_read: true, unread_count: 3 },
    );
    assert.equal(
      parseMarkReadEnvelope({
        ok: true,
        data: { bulletin_id: SAMPLE_BULLETIN_ID, is_read: false, unread_count: 3 },
      }),
      null,
    );
    assert.equal(
      parseMarkReadEnvelope({
        ok: true,
        data: { bulletin_id: "   ", is_read: true, unread_count: 3 },
      }),
      null,
    );
    assert.equal(
      parseMarkReadEnvelope({
        ok: true,
        data: { bulletin_id: SAMPLE_BULLETIN_ID, is_read: true, unread_count: -1 },
      }),
      null,
    );

    assert.deepEqual(
      parseMarkAllReadEnvelope({ ok: true, data: { unread_count: 0 } }),
      { unread_count: 0 },
    );
    assert.equal(
      parseMarkAllReadEnvelope({ ok: true, data: { unread_count: -1 } }),
      null,
    );
    assert.equal(
      parseMarkAllReadEnvelope({ ok: false, code: "BULLETIN_UNAVAILABLE" }),
      null,
    );
  });

  it("extractBulletinErrorCode and bulletinUiErrorMessage map API codes to Vietnamese messages", () => {
    assert.equal(extractBulletinErrorCode({ ok: false, code: " VERSION_CONFLICT " }), "VERSION_CONFLICT");
    assert.equal(extractBulletinErrorCode({ ok: true, data: {} }), null);
    assert.equal(extractBulletinErrorCode({ ok: false, code: "" }), null);

    const mappedCodes = [
      "UNAUTHENTICATED",
      "ACTOR_NOT_AVAILABLE",
      "CSRF_REJECTED",
      "BULLETIN_FORBIDDEN",
      "BULLETIN_ACTOR_FORBIDDEN",
      "NOT_FOUND",
      "BULLETIN_NOT_FOUND",
      "BULLETIN_ATTACHMENT_NOT_FOUND",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "BULLETIN_PUBLISH_CONTENT_REQUIRED",
      "BULLETIN_TITLE_INVALID",
      "BULLETIN_CATEGORY_INVALID",
      "BULLETIN_BADGE_INVALID",
      "BULLETIN_SUMMARY_INVALID",
      "BULLETIN_CONTENT_SECTIONS_INVALID",
      "BULLETIN_AUTHOR_INVALID",
      "BULLETIN_STATUS_INVALID",
      "BULLETIN_DATE_RANGE_INVALID",
      "BULLETIN_QUERY_INVALID",
      "BULLETIN_CURSOR_INVALID",
      "BULLETIN_ATTACHMENT_TOO_LARGE",
      "REQUEST_BODY_TOO_LARGE",
      "BULLETIN_ATTACHMENT_MIME_INVALID",
      "BULLETIN_ATTACHMENT_INVALID",
      "BULLETIN_STORAGE_UNAVAILABLE",
      "BULLETIN_UNAVAILABLE",
    ];

    for (const code of mappedCodes) {
      const msg = bulletinUiErrorMessage(code);
      assert.equal(typeof msg, "string");
      assert.ok(msg.length > 10, `expected non-empty message for ${code}`);
    }

    assert.match(bulletinUiErrorMessage("VERSION_CONFLICT"), /tải lại dữ liệu mới nhất/i);
    assert.match(bulletinUiErrorMessage("BULLETIN_ATTACHMENT_TOO_LARGE"), /15 MB/);
    assert.match(bulletinUiErrorMessage("BULLETIN_ATTACHMENT_MIME_INVALID"), /JPEG, PNG, WEBP.*PDF/);
    assert.equal(
      bulletinUiErrorMessage("UNKNOWN_CODE"),
      bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"),
    );
  });
});

describe("bulletin-ui-model: form validation, attachments, tracker, and formatting", () => {
  it("createEmptyBulletinFormValues and createBulletinFormValuesFromItem preserve/default fields", () => {
    const empty = createEmptyBulletinFormValues();
    assert.equal(empty.category, "HR_NEWS");
    assert.deepEqual(empty.contentSections, [""]);
    assert.equal(empty.authorDisplay, BULLETIN_DEFAULT_AUTHOR_DISPLAY);
    assert.equal(empty.isPinned, false);

    const fromItem = createBulletinFormValuesFromItem(
      makeBulletinItem({ badge_text: null, content_sections: [] }),
    );
    assert.equal(fromItem.badgeText, "");
    assert.deepEqual(fromItem.contentSections, [""]);
    assert.equal(fromItem.isPinned, true);
  });

  it("validateBulletinFormValues distinguishes draft vs publish/create section requirements and enforces length & control chars", () => {
    const draftWithoutSections = validateBulletinFormValues(
      {
        title: "  Bản nháp lịch họp  ",
        category: "GENERAL",
        badgeText: "   ",
        summary: "  Tóm tắt\ndòng 2  ",
        contentSections: ["", "   "],
        authorDisplay: "  Phòng Nhân sự  ",
        isPinned: true,
      },
      { intent: "draft" },
    );
    assert.equal(draftWithoutSections.ok, true);
    assert.deepEqual(draftWithoutSections.payload, {
      title: "Bản nháp lịch họp",
      category: "GENERAL",
      badge_text: null,
      summary: "Tóm tắt\ndòng 2",
      content_sections: [],
      author_display: "Phòng Nhân sự",
      is_pinned: true,
    });

    const publishWithoutSections = validateBulletinFormValues(
      {
        title: "Bản tin xuất bản",
        category: "HR_NEWS",
        badgeText: "Mới",
        summary: "",
        contentSections: ["   "],
        authorDisplay: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
        isPinned: false,
      },
      { intent: "publish" },
    );
    assert.equal(publishWithoutSections.ok, false);
    assert.equal(publishWithoutSections.code, "BULLETIN_PUBLISH_CONTENT_REQUIRED");
    assert.ok(publishWithoutSections.fieldErrors.contentSections);

    const createWithoutSections = validateBulletinFormValues(
      {
        title: "Bản tin tạo mới",
        category: "HR_NEWS",
        badgeText: "",
        summary: "",
        contentSections: [],
        authorDisplay: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
        isPinned: false,
      },
      { intent: "create" },
    );
    assert.equal(createWithoutSections.ok, false);
    assert.equal(createWithoutSections.code, "BULLETIN_PUBLISH_CONTENT_REQUIRED");

    const badTitleAndControl = validateBulletinFormValues(
      {
        title: "Tiêu đề\nxuống dòng",
        category: "BAD_CATEGORY",
        badgeText: "A".repeat(41),
        summary: "B".repeat(601),
        contentSections: ["Đoạn\u0000lỗi"],
        authorDisplay: "",
        isPinned: false,
      },
      { intent: "publish" },
    );
    assert.equal(badTitleAndControl.ok, false);
    assert.equal(badTitleAndControl.code, "BULLETIN_TITLE_INVALID");
    assert.ok(badTitleAndControl.fieldErrors.title);
    assert.ok(badTitleAndControl.fieldErrors.category);
    assert.ok(badTitleAndControl.fieldErrors.badgeText);
    assert.ok(badTitleAndControl.fieldErrors.summary);
    assert.ok(badTitleAndControl.fieldErrors.authorDisplay);
    assert.ok(badTitleAndControl.fieldErrors.contentSections);

    const over50Sections = validateBulletinFormValues(
      {
        title: "Quá 50 đoạn",
        category: "GENERAL",
        badgeText: "",
        summary: "",
        contentSections: Array.from({ length: 51 }, (_, idx) => `Đoạn ${idx + 1}`),
        authorDisplay: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
        isPinned: false,
      },
      { intent: "publish" },
    );
    assert.equal(over50Sections.ok, false);
    assert.equal(over50Sections.code, "BULLETIN_CONTENT_SECTIONS_INVALID");

    const over8000Section = validateBulletinFormValues(
      {
        title: "Đoạn quá dài",
        category: "GENERAL",
        badgeText: "",
        summary: "",
        contentSections: ["X".repeat(8001)],
        authorDisplay: BULLETIN_DEFAULT_AUTHOR_DISPLAY,
        isPinned: false,
      },
      { intent: "publish" },
    );
    assert.equal(over8000Section.ok, false);
    assert.equal(over8000Section.code, "BULLETIN_CONTENT_SECTIONS_INVALID");
  });

  it("validateAttachmentFileClient accepts <=15MB JPG/PNG/WEBP/PDF and rejects HTML/SVG/oversize/0-byte/mismatch", () => {
    assert.deepEqual(
      validateAttachmentFileClient({
        name: "banner.jpg",
        type: "image/jpeg",
        size: BULLETIN_MAX_ATTACHMENT_BYTES,
      }),
      { ok: true, mimeType: "image/jpeg", kind: "IMAGE" },
    );
    assert.deepEqual(
      validateAttachmentFileClient({
        name: "notice.png",
        type: "image/png",
        size: 1024,
      }),
      { ok: true, mimeType: "image/png", kind: "IMAGE" },
    );
    assert.deepEqual(
      validateAttachmentFileClient({
        name: "poster.webp",
        type: "image/webp",
        size: 2048,
      }),
      { ok: true, mimeType: "image/webp", kind: "IMAGE" },
    );
    assert.deepEqual(
      validateAttachmentFileClient({
        name: "quyet-dinh.pdf",
        type: "application/pdf",
        size: 4096,
      }),
      { ok: true, mimeType: "application/pdf", kind: "PDF" },
    );
    // Extension fallback when browser leaves file.type empty
    assert.deepEqual(
      validateAttachmentFileClient({
        name: "fallback.PDF",
        type: "",
        size: 512,
      }),
      { ok: true, mimeType: "application/pdf", kind: "PDF" },
    );

    const zeroByte = validateAttachmentFileClient({
      name: "empty.png",
      type: "image/png",
      size: 0,
    });
    assert.equal(zeroByte.ok, false);
    assert.equal(zeroByte.code, "BULLETIN_ATTACHMENT_INVALID");

    const oversize = validateAttachmentFileClient({
      name: "huge.pdf",
      type: "application/pdf",
      size: BULLETIN_MAX_ATTACHMENT_BYTES + 1,
    });
    assert.equal(oversize.ok, false);
    assert.equal(oversize.code, "BULLETIN_ATTACHMENT_TOO_LARGE");

    const htmlRejected = validateAttachmentFileClient({
      name: "xss.html",
      type: "text/html",
      size: 100,
    });
    assert.equal(htmlRejected.ok, false);
    assert.equal(htmlRejected.code, "BULLETIN_ATTACHMENT_MIME_INVALID");

    const svgRejected = validateAttachmentFileClient({
      name: "vector.svg",
      type: "image/svg+xml",
      size: 100,
    });
    assert.equal(svgRejected.ok, false);
    assert.equal(svgRejected.code, "BULLETIN_ATTACHMENT_MIME_INVALID");

    const svgExtRejected = validateAttachmentFileClient({
      name: "vector.svg",
      type: "",
      size: 100,
    });
    assert.equal(svgExtRejected.ok, false);
    assert.equal(svgExtRejected.code, "BULLETIN_ATTACHMENT_MIME_INVALID");

    const mismatch = validateAttachmentFileClient({
      name: "fake.png",
      type: "image/jpeg",
      size: 1024,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, "BULLETIN_ATTACHMENT_INVALID");

    assert.equal(validateAttachmentFileClient(null).ok, false);
  });

  it("createBulletinLatestRequestTracker cancels stale requests and formatBulletinFileSize formats bytes", () => {
    const tracker = createBulletinLatestRequestTracker();
    const first = tracker.begin();
    assert.equal(first.isCurrent(), true);
    assert.equal(first.signal.aborted, false);
    assert.equal(tracker.getCurrentSeq(), 1);

    const second = tracker.begin();
    assert.equal(first.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
    assert.equal(tracker.isCurrent(second.seq), true);
    assert.equal(tracker.isCurrent(first.seq), false);

    tracker.cancelAll();
    assert.equal(second.signal.aborted, true);
    assert.equal(second.isCurrent(), false);

    assert.equal(formatBulletinFileSize(512), "512 B");
    assert.equal(formatBulletinFileSize(1536), "1.5 KB");
    assert.equal(formatBulletinFileSize(BULLETIN_MAX_ATTACHMENT_BYTES), "15.0 MB");
    assert.equal(formatBulletinFileSize(-1), "—");
    assert.equal(formatBulletinFileSize(1.5), "—");

    const k1 = newIdempotencyKey();
    const k2 = newIdempotencyKey();
    assert.equal(typeof k1, "string");
    assert.ok(k1.length > 0);
    assert.notEqual(k1, k2);
  });
});
