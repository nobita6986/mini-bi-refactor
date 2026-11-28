import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";

import {
  handleAdminBulletinArchive,
  handleAdminBulletinAttachmentDelete,
  handleAdminBulletinAttachmentUpload,
  handleAdminBulletinCreate,
  handleAdminBulletinDetail,
  handleAdminBulletinList,
  handleAdminBulletinPin,
  handleAdminBulletinPublish,
  handleAdminBulletinUpdate,
  handleBulletinArchiveList,
  handleBulletinAttachmentContent,
  handleBulletinDetail,
  handleBulletinMarkAllRead,
  handleBulletinMarkRead,
  handleBulletinMobileFeed,
} from "./api.ts";
import { createServiceBulletinRepository } from "./repository.ts";
import { createBulletinStorage, unavailableBulletinStorage } from "./storage.ts";

const ORIGIN = "https://bi2.hrpartner.vn";
const FOREIGN_ORIGIN = "https://evil.example";
const BULLETIN_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_AUTH_SUBJECT = "33333333-3333-4333-8333-333333333333";
const ADMIN_APP_USER_ID = "44444444-4444-4444-8444-444444444444";

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
];

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeRequest(pathname, options = {}) {
  const {
    method = "GET",
    origin = ORIGIN,
    host = "bi2.hrpartner.vn",
    headers = {},
    body,
    json,
  } = options;

  const h = new Headers(headers);
  if (host && !h.has("host")) h.set("host", host);
  if (origin !== null && method !== "GET" && !h.has("origin")) {
    h.set("origin", origin);
  }
  let finalBody = body;
  if (json !== undefined) {
    finalBody = JSON.stringify(json);
    if (!h.has("content-type")) h.set("content-type", "application/json");
  }

  return new Request(`${ORIGIN}${pathname}`, {
    method,
    headers: h,
    body: finalBody,
  });
}

function activeSession(authSubject = ADMIN_AUTH_SUBJECT, appUserId = ADMIN_APP_USER_ID) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: authSubject,
        app_user_id: appUserId,
        display_name: "Test Actor",
        enabled: true,
        authz_managed: true,
      },
    },
    response_headers: {},
  };
}

function makeInMemoryStorage() {
  const store = new Map();
  const client = {
    async send(cmd) {
      const name = cmd?.constructor?.name;
      if (name === "PutObjectCommand") {
        const bytes = Buffer.from(cmd.input.Body);
        store.set(cmd.input.Key, {
          bytes,
          contentType: cmd.input.ContentType,
          contentLength: cmd.input.ContentLength,
        });
        return {};
      }
      if (name === "GetObjectCommand") {
        const entry = store.get(cmd.input.Key);
        if (!entry) {
          const err = new Error("NoSuchKey");
          err.name = "NoSuchKey";
          throw err;
        }
        return {
          ContentType: entry.contentType,
          ContentLength: entry.contentLength,
          Body: {
            async transformToByteArray() {
              return Uint8Array.from(entry.bytes);
            },
          },
        };
      }
      if (name === "DeleteObjectCommand") {
        store.delete(cmd.input.Key);
        return {};
      }
      throw new Error(`Unexpected command ${name}`);
    },
  };
  const storage = createBulletinStorage(
    {
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_BUCKET_NAME: "hrp-bi-preview",
      R2_ACCESS_KEY_ID: "SYNTHETICACCESSKEY01",
      R2_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
    },
    { client },
  );
  return { store, storage };
}

function sampleBulletinItem(overrides = {}) {
  return {
    bulletin_id: BULLETIN_ID,
    id: BULLETIN_ID,
    title: "Thông báo lịch nghỉ Tết Dương Lịch 2027",
    category: "HOLIDAY_SCHEDULE",
    category_display: "Lịch nghỉ lễ",
    badge_text: "Quan trọng",
    is_pinned: true,
    is_read: false,
    published_at: "2026-11-27T08:00:00.000Z",
    published_date_display: "27-11-2026",
    author_display: "Phòng Hành chính - Nhân sự HRPartner",
    summary: "Lịch nghỉ lễ chính thức toàn công ty.",
    content_sections: ["Thời gian nghỉ: 01/01/2027", "Làm việc lại: 04/01/2027"],
    image_count: 1,
    pdf_count: 0,
    attachment_summary: { image_count: 1, pdf_count: 0 },
    attachments: [
      {
        attachment_id: ATTACHMENT_ID,
        id: ATTACHMENT_ID,
        kind: "IMAGE",
        file_name: "lich-nghi.png",
        title: "Lịch nghỉ lễ",
        mime_type: "image/png",
        file_size_bytes: 1234,
        url: `/api/bulletins/${BULLETIN_ID}/attachments/${ATTACHMENT_ID}/content`,
        thumbnail_url: null,
        width: 120,
        height: 80,
        page_count: null,
        sha256: "a".repeat(64),
      },
    ],
    status: "PUBLISHED",
    row_version: 2,
    archived_at: null,
    created_at: "2026-11-27T07:50:00.000Z",
    updated_at: "2026-11-27T08:00:00.000Z",
    created_by: ADMIN_APP_USER_ID,
    updated_by: ADMIN_APP_USER_ID,
    ...overrides,
  };
}

function makeMockDeps(overrides = {}) {
  const calls = [];
  const item = sampleBulletinItem();
  const repository = {
    async listMobileFeed(input) {
      calls.push(["listMobileFeed", input]);
      return {
        ok: true,
        data: {
          items: [item],
          unread_count: 1,
          latest_published_at: item.published_at,
          page_size: input.page_size,
          has_more: false,
          next_cursor: null,
        },
      };
    },
    async getDetail(input) {
      calls.push(["getDetail", input]);
      return { ok: true, data: { item } };
    },
    async markRead(input) {
      calls.push(["markRead", input]);
      return { ok: true, data: { bulletin_id: input.bulletin_id, is_read: true, unread_count: 0 } };
    },
    async markAllRead(input) {
      calls.push(["markAllRead", input]);
      return { ok: true, data: { unread_count: 0 } };
    },
    async getAttachmentContentMeta(input) {
      calls.push(["getAttachmentContentMeta", input]);
      return {
        ok: true,
        data: {
          attachment_id: ATTACHMENT_ID,
          id: ATTACHMENT_ID,
          bulletin_id: BULLETIN_ID,
          kind: "IMAGE",
          file_name: "lich-nghi.png",
          title: "Lịch nghỉ lễ",
          mime_type: "image/png",
          file_size_bytes: 1234,
          storage_key: `preview/hr-bulletins/${BULLETIN_ID}/${ATTACHMENT_ID}.png`,
          width: 120,
          height: 80,
          page_count: null,
          sha256: "a".repeat(64),
        },
      };
    },
    async listArchive(input) {
      calls.push(["listArchive", input]);
      return {
        ok: true,
        data: {
          items: [item],
          total_count: 1,
          page: input.page,
          page_size: input.page_size,
          unread_count: 1,
          can_manage: true,
          authors: [{ app_user_id: ADMIN_APP_USER_ID, display_name: "HR Admin" }],
        },
      };
    },
    async createAdmin(input) {
      calls.push(["createAdmin", input]);
      return { ok: true, data: { item: sampleBulletinItem({ status: "DRAFT", row_version: 1, published_at: null }), replayed: false } };
    },
    async updateAdmin(input) {
      calls.push(["updateAdmin", input]);
      return { ok: true, data: { item: sampleBulletinItem({ row_version: input.expected_row_version + 1 }), replayed: false } };
    },
    async setStatusAdmin(input) {
      calls.push(["setStatusAdmin", input]);
      return { ok: true, data: { item: sampleBulletinItem({ status: input.target_status, row_version: input.expected_row_version + 1 }), replayed: false } };
    },
    async setPinnedAdmin(input) {
      calls.push(["setPinnedAdmin", input]);
      return { ok: true, data: { item: sampleBulletinItem({ is_pinned: input.is_pinned, row_version: input.expected_row_version + 1 }), replayed: false } };
    },
    async attachFileAdmin(input) {
      calls.push(["attachFileAdmin", input]);
      return { ok: true, data: { item, attachment_id: input.attachment_id, replayed: false } };
    },
    async deleteAttachmentAdmin(input) {
      calls.push(["deleteAttachmentAdmin", input]);
      return {
        ok: true,
        data: {
          item: sampleBulletinItem({ attachments: [], image_count: 0, attachment_summary: { image_count: 0, pdf_count: 0 } }),
          deleted_attachment_id: input.attachment_id,
          deleted_storage_key: `preview/hr-bulletins/${BULLETIN_ID}/${ATTACHMENT_ID}.png`,
          replayed: false,
        },
      };
    },
    ...(overrides.repository ?? {}),
  };

  return {
    calls,
    deps: {
      resolveSession: overrides.resolveSession ?? (async () => activeSession()),
      repository,
      storage: overrides.storage ?? unavailableBulletinStorage,
    },
  };
}

test("Guards: feature gate off -> 404, DISALLOWED_AUTHORITY_HEADERS -> 400, forbidden JSON keys -> 400, CSRF -> 403", async () => {
  const { deps } = makeMockDeps();

  // Feature gate off across GET & POST handlers
  const offRes = await handleBulletinMobileFeed(makeRequest("/api/bulletins"), "false", deps);
  assert.equal(offRes.status, 404);
  assert.deepEqual(await offRes.json(), { ok: false, code: "NOT_FOUND" });

  const offAdmin = await handleAdminBulletinCreate(
    makeRequest("/api/admin/bulletins", { method: "POST", json: { title: "x", category: "GENERAL" } }),
    undefined,
    deps,
  );
  assert.equal(offAdmin.status, 404);

  // Every DISALLOWED_AUTHORITY_HEADERS rejected with 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    const res = await handleBulletinMobileFeed(
      makeRequest("/api/bulletins", { headers: { [headerName]: "spoof" } }),
      "true",
      deps,
    );
    assert.equal(res.status, 400, `${headerName} should return 400`);
    assert.deepEqual(await res.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });
  }

  // Forbidden JSON authority keys in POST/PATCH bodies
  const forbiddenJsonRes = await handleAdminBulletinCreate(
    makeRequest("/api/admin/bulletins", {
      method: "POST",
      headers: { "idempotency-key": "k-1" },
      json: { title: "Test", category: "GENERAL", app_user_id: ADMIN_APP_USER_ID },
    }),
    "true",
    deps,
  );
  assert.equal(forbiddenJsonRes.status, 400);
  assert.deepEqual(await forbiddenJsonRes.json(), {
    ok: false,
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });

  // CSRF: missing Origin or Origin !== Host on POST/PATCH/DELETE -> 403 CSRF_REJECTED
  for (const [label, fn] of [
    ["POST /read missing Origin", () => handleBulletinMarkRead(makeRequest(`/api/bulletins/${BULLETIN_ID}/read`, { method: "POST", origin: null }), BULLETIN_ID, "true", deps)],
    ["POST /read-all foreign Origin", () => handleBulletinMarkAllRead(makeRequest("/api/bulletins/read-all", { method: "POST", origin: FOREIGN_ORIGIN }), "true", deps)],
    ["POST /admin/bulletins foreign Origin", () => handleAdminBulletinCreate(makeRequest("/api/admin/bulletins", { method: "POST", origin: FOREIGN_ORIGIN }), "true", deps)],
    ["PATCH /admin/bulletins/[id] foreign Origin", () => handleAdminBulletinUpdate(makeRequest(`/api/admin/bulletins/${BULLETIN_ID}`, { method: "PATCH", origin: FOREIGN_ORIGIN }), BULLETIN_ID, "true", deps)],
    ["DELETE attachment missing Origin", () => handleAdminBulletinAttachmentDelete(makeRequest(`/api/admin/bulletins/${BULLETIN_ID}/attachments/${ATTACHMENT_ID}`, { method: "DELETE", origin: null }), BULLETIN_ID, ATTACHMENT_ID, "true", deps)],
  ]) {
    const res = await fn();
    assert.equal(res.status, 403, label);
    assert.deepEqual(await res.json(), { ok: false, code: "CSRF_REJECTED" });
  }
});

test("Cookie session auth only (no Bearer tokens): 401 UNAUTHENTICATED, 403 ACTOR_NOT_AVAILABLE, 503 BULLETIN_UNAVAILABLE", async () => {
  // Even with Authorization: Bearer token, unauthenticated cookie session returns 401
  const { deps: unauthDeps } = makeMockDeps({
    resolveSession: async () => ({
      actor: { ok: false, reason: "UNAUTHENTICATED" },
      response_headers: {},
    }),
  });
  const bearerRes = await handleBulletinMobileFeed(
    makeRequest("/api/bulletins", { headers: { authorization: "Bearer fake-jwt-token" } }),
    "true",
    unauthDeps,
  );
  assert.equal(bearerRes.status, 401);
  assert.deepEqual(await bearerRes.json(), { ok: false, code: "UNAUTHENTICATED" });

  // ACTOR_DISABLED & ACTOR_MAPPING_MISSING -> 403 ACTOR_NOT_AVAILABLE
  for (const reason of ["ACTOR_DISABLED", "ACTOR_MAPPING_MISSING"]) {
    const { deps: badActorDeps } = makeMockDeps({
      resolveSession: async () => ({
        actor: { ok: false, reason },
        response_headers: {},
      }),
    });
    const res = await handleBulletinMobileFeed(makeRequest("/api/bulletins"), "true", badActorDeps);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });
  }

  // Disabled actor flag fails closed
  const { deps: disabledFlagDeps } = makeMockDeps({
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: ADMIN_AUTH_SUBJECT,
          app_user_id: ADMIN_APP_USER_ID,
          display_name: "Disabled",
          enabled: false,
          authz_managed: true,
        },
      },
      response_headers: {},
    }),
  });
  const disabledRes = await handleBulletinMobileFeed(makeRequest("/api/bulletins"), "true", disabledFlagDeps);
  assert.equal(disabledRes.status, 403);
  assert.deepEqual(await disabledRes.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

  // resolveSession throws or repository fails -> 503 BULLETIN_UNAVAILABLE
  const { deps: sessionThrowDeps } = makeMockDeps({
    resolveSession: async () => {
      throw new Error("boom");
    },
  });
  const throwRes = await handleBulletinMobileFeed(makeRequest("/api/bulletins"), "true", sessionThrowDeps);
  assert.equal(throwRes.status, 503);
  assert.deepEqual(await throwRes.json(), { ok: false, code: "BULLETIN_UNAVAILABLE" });

  const { deps: repoFailDeps } = makeMockDeps({
    repository: {
      async listMobileFeed() {
        return { ok: false, code: "BULLETIN_UNAVAILABLE" };
      },
    },
  });
  const repoRes = await handleBulletinMobileFeed(makeRequest("/api/bulletins"), "true", repoFailDeps);
  assert.equal(repoRes.status, 503);
  assert.deepEqual(await repoRes.json(), { ok: false, code: "BULLETIN_UNAVAILABLE" });
});

test("POST /read and /read-all accept empty body and {}, reject >1024B with 413 REQUEST_BODY_TOO_LARGE", async () => {
  const { deps } = makeMockDeps();

  for (const fn of [
    (req) => handleBulletinMarkRead(req, BULLETIN_ID, "true", deps),
    (req) => handleBulletinMarkAllRead(req, "true", deps),
  ]) {
    const emptyRes = await fn(makeRequest("/api/bulletins/read-all", { method: "POST" }));
    assert.equal(emptyRes.status, 200);

    const objRes = await fn(makeRequest("/api/bulletins/read-all", { method: "POST", json: {} }));
    assert.equal(objRes.status, 200);

    const nonEmptyRes = await fn(
      makeRequest("/api/bulletins/read-all", { method: "POST", json: { extra: 1 } }),
    );
    assert.equal(nonEmptyRes.status, 400);
    assert.deepEqual(await nonEmptyRes.json(), { ok: false, code: "BULLETIN_VALIDATION_ERROR" });

    const tooLargeRes = await fn(
      makeRequest("/api/bulletins/read-all", {
        method: "POST",
        json: { pad: "x".repeat(1025) },
      }),
    );
    assert.equal(tooLargeRes.status, 413);
    assert.deepEqual(await tooLargeRes.json(), { ok: false, code: "REQUEST_BODY_TOO_LARGE" });
  }
});

test("Admin upload/delete attachment unit guards: multipart validation, forbidden form key, cleanup on RPC error, DELETE body & query", async () => {
  const pngBuf = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 20, g: 140, b: 80 } },
  })
    .png()
    .toBuffer();

  // Unconfigured storage -> 503 BULLETIN_STORAGE_UNAVAILABLE
  const { deps: noStorageDeps } = makeMockDeps({ storage: unavailableBulletinStorage });
  const noStorageUpload = await handleAdminBulletinAttachmentUpload(
    makeRequest(`/api/admin/bulletins/${BULLETIN_ID}/attachments`, {
      method: "POST",
      headers: { "idempotency-key": "up-0" },
    }),
    BULLETIN_ID,
    "true",
    noStorageDeps,
  );
  assert.equal(noStorageUpload.status, 503);
  assert.deepEqual(await noStorageUpload.json(), { ok: false, code: "BULLETIN_STORAGE_UNAVAILABLE" });

  // Forbidden form field key -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const { store, storage } = makeInMemoryStorage();
  const { deps } = makeMockDeps({ storage });
  const forbiddenFd = new FormData();
  forbiddenFd.append("expected_row_version", "1");
  forbiddenFd.append("app_user_id", ADMIN_APP_USER_ID);
  forbiddenFd.append("file", new File([pngBuf], "pic.png", { type: "image/png" }));
  const forbiddenUpload = await handleAdminBulletinAttachmentUpload(
    makeRequest(`/api/admin/bulletins/${BULLETIN_ID}/attachments`, {
      method: "POST",
      headers: { "idempotency-key": "up-1" },
      body: forbiddenFd,
    }),
    BULLETIN_ID,
    "true",
    deps,
  );
  assert.equal(forbiddenUpload.status, 400);
  assert.deepEqual(await forbiddenUpload.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });
  assert.equal(store.size, 0);

  // RPC failure after putAttachment cleans up orphaned S3 object
  const { deps: failAttachDeps } = makeMockDeps({
    storage,
    repository: {
      async attachFileAdmin() {
        return { ok: false, code: "VERSION_CONFLICT" };
      },
    },
  });
  const fd = new FormData();
  fd.append("expected_row_version", "1");
  fd.append("title", "Ảnh minh họa");
  fd.append("file", new File([pngBuf], "pic.png", { type: "image/png" }));
  const conflictUpload = await handleAdminBulletinAttachmentUpload(
    makeRequest(`/api/admin/bulletins/${BULLETIN_ID}/attachments`, {
      method: "POST",
      headers: { "idempotency-key": "up-2" },
      body: fd,
    }),
    BULLETIN_ID,
    "true",
    failAttachDeps,
  );
  assert.equal(conflictUpload.status, 409);
  assert.deepEqual(await conflictUpload.json(), { ok: false, code: "VERSION_CONFLICT" });
  assert.equal(store.size, 0, "orphaned S3 object must be cleaned up on RPC failure");

  // Non-manager blocked on GET /api/admin/bulletins even if repository returns can_manage=false
  const { deps: nonManageListDeps } = makeMockDeps({
    repository: {
      async listArchive(input) {
        return {
          ok: true,
          data: {
            items: [],
            total_count: 0,
            page: input.page,
            page_size: input.page_size,
            unread_count: 0,
            can_manage: false,
            authors: [],
          },
        };
      },
    },
  });
  const adminListDenied = await handleAdminBulletinList(
    makeRequest("/api/admin/bulletins"),
    "true",
    nonManageListDeps,
  );
  assert.equal(adminListDenied.status, 403);
  assert.deepEqual(await adminListDenied.json(), { ok: false, code: "BULLETIN_FORBIDDEN" });

  // DELETE supports query param ?expected_row_version=2 as well as JSON body
  const delQueryRes = await handleAdminBulletinAttachmentDelete(
    makeRequest(`/api/admin/bulletins/${BULLETIN_ID}/attachments/${ATTACHMENT_ID}?expected_row_version=2`, {
      method: "DELETE",
      headers: { "idempotency-key": "del-q-1" },
    }),
    BULLETIN_ID,
    ATTACHMENT_ID,
    "true",
    deps,
  );
  assert.equal(delQueryRes.status, 200);
});

// =============================================================================
// Integrated End-to-End Test: PGlite + createServiceBulletinRepository + Storage
// =============================================================================

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
`;

const RPC_PARAM_TYPES = {
  hr_bulletin_list_mobile_feed: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_category: "text",
    p_page_size: "integer",
    p_cursor_is_pinned: "boolean",
    p_cursor_published_at: "timestamptz",
    p_cursor_bulletin_id: "uuid",
    p_cursor_offset_count: "integer",
  },
  hr_bulletin_get_detail: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_allow_non_published: "boolean",
  },
  hr_bulletin_mark_read: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
  },
  hr_bulletin_mark_all_read: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
  },
  hr_bulletin_get_attachment_content_meta: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_attachment_id: "uuid",
  },
  hr_bulletin_list_archive: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_from_date: "date",
    p_to_date: "date",
    p_category: "text",
    p_status: "text",
    p_author: "text",
    p_created_by: "uuid",
    p_search: "text",
    p_page: "integer",
    p_page_size: "integer",
  },
  hr_bulletin_create_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_title: "text",
    p_category: "text",
    p_badge_text: "text",
    p_summary: "text",
    p_content_sections: "jsonb",
    p_author_display: "text",
    p_is_pinned: "boolean",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
  hr_bulletin_update_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_expected_row_version: "integer",
    p_title: "text",
    p_category: "text",
    p_badge_text: "text",
    p_summary: "text",
    p_content_sections: "jsonb",
    p_author_display: "text",
    p_is_pinned: "boolean",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
  hr_bulletin_set_status_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_target_status: "text",
    p_expected_row_version: "integer",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
  hr_bulletin_set_pinned_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_is_pinned: "boolean",
    p_expected_row_version: "integer",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
  hr_bulletin_attach_file_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_expected_row_version: "integer",
    p_attachment_id: "uuid",
    p_kind: "text",
    p_file_name: "text",
    p_title: "text",
    p_mime_type: "text",
    p_file_size_bytes: "bigint",
    p_storage_key: "text",
    p_width: "integer",
    p_height: "integer",
    p_page_count: "integer",
    p_sha256: "text",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
  hr_bulletin_delete_attachment_admin: {
    p_auth_subject: "uuid",
    p_app_user_id: "uuid",
    p_bulletin_id: "uuid",
    p_attachment_id: "uuid",
    p_expected_row_version: "integer",
    p_idempotency_key: "text",
    p_request_hash: "text",
  },
};

function createPgliteBulletinRpc(db) {
  return async (name, args) => {
    const paramTypes = RPC_PARAM_TYPES[name];
    if (!paramTypes) {
      return { data: null, error: { code: "42883", message: `Unknown RPC: ${name}` } };
    }
    const entries = Object.entries(args);
    const namedArgsSql = entries
      .map(([key], idx) => {
        const sqlType = paramTypes[key];
        if (!sqlType) throw new Error(`Unknown param ${key} for ${name}`);
        return `${key} := $${idx + 1}::${sqlType}`;
      })
      .join(", ");
    const values = entries.map(([key, val]) =>
      paramTypes[key] === "jsonb" && val !== null && typeof val !== "string"
        ? JSON.stringify(val)
        : val ?? null,
    );
    try {
      const { rows } = await db.query(
        `select public.${name}(${namedArgsSql}) as res`,
        values,
      );
      return { data: rows[0]?.res ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: err?.code,
          message: err?.message,
          details: err?.detail,
        },
      };
    }
  };
}

function assertMobileBulletinItemShape(item) {
  const expectedKeys = [
    "bulletin_id",
    "id",
    "title",
    "category",
    "category_display",
    "badge_text",
    "is_pinned",
    "is_read",
    "published_at",
    "published_date_display",
    "author_display",
    "summary",
    "content_sections",
    "image_count",
    "pdf_count",
    "attachment_summary",
    "attachments",
  ].sort();
  assert.deepEqual(Object.keys(item).sort(), expectedKeys);
  assert.equal(item.id, item.bulletin_id);
  assert.equal(typeof item.title, "string");
  assert.equal(typeof item.category, "string");
  assert.equal(typeof item.category_display, "string");
  assert.ok(item.badge_text === null || typeof item.badge_text === "string");
  assert.equal(typeof item.is_pinned, "boolean");
  assert.equal(typeof item.is_read, "boolean");
  assert.match(item.published_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(item.published_date_display, /^\d{2}-\d{2}-\d{4}$/);
  assert.equal(typeof item.author_display, "string");
  assert.equal(typeof item.summary, "string");
  assert.ok(Array.isArray(item.content_sections));
  assert.equal(typeof item.image_count, "number");
  assert.equal(typeof item.pdf_count, "number");
  assert.deepEqual(Object.keys(item.attachment_summary).sort(), ["image_count", "pdf_count"]);
  assert.ok(Array.isArray(item.attachments));
  for (const att of item.attachments) {
    assert.deepEqual(
      Object.keys(att).sort(),
      [
        "attachment_id",
        "file_name",
        "file_size_bytes",
        "height",
        "id",
        "kind",
        "mime_type",
        "page_count",
        "sha256",
        "thumbnail_url",
        "title",
        "url",
        "width",
      ],
    );
    assert.equal(att.id, att.attachment_id);
    assert.equal(att.url, `/api/bulletins/${item.bulletin_id}/attachments/${att.attachment_id}/content`);
  }
}

test("E2E PGlite + createServiceBulletinRepository: ALL 15 handlers, RBAC, /content raw-byte sha256 & headers, OCC, Idempotency, iOS/Android contract", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const name of names) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const manager = {
      auth_subject: "91000000-0000-4000-8000-000000000001",
      app_user_id: "92000000-0000-4000-8000-000000000001",
      display_name: "HR Operator",
      email: "hr.op@hrpartner.local",
    };
    const employee = {
      auth_subject: "91000000-0000-4000-8000-000000000002",
      app_user_id: "92000000-0000-4000-8000-000000000002",
      display_name: "Nhân viên Thường",
      email: "emp@hrpartner.local",
    };

    for (const u of [manager, employee]) {
      await db.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [u.auth_subject, u.email]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, created_at)
         values ($1::uuid, $2::uuid, $3, true, true, now() - interval '30 days')`,
        [u.app_user_id, u.auth_subject, u.display_name],
      );
    }

    const { rows: groupRows } = await db.query(
      `select group_id from public.authz_user_groups where code = 'HR_CATALOG_OPERATOR'`,
    );
    assert.equal(groupRows.length, 1);
    await db.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, reason) values ($1::uuid, $2::uuid, 'e2e test')`,
      [groupRows[0].group_id, manager.app_user_id],
    );

    const repository = createServiceBulletinRepository(createPgliteBulletinRpc(db));
    const { store, storage } = makeInMemoryStorage();
    const managerDeps = {
      resolveSession: async () => activeSession(manager.auth_subject, manager.app_user_id),
      repository,
      storage,
    };
    const employeeDeps = {
      resolveSession: async () => activeSession(employee.auth_subject, employee.app_user_id),
      repository,
      storage,
    };

    // 1. Employee denied on Admin Create (403 BULLETIN_FORBIDDEN)
    const empCreateDenied = await handleAdminBulletinCreate(
      makeRequest("/api/admin/bulletins", {
        method: "POST",
        headers: { "idempotency-key": "e2e-emp-deny" },
        json: { title: "Blocked", category: "GENERAL" },
      }),
      "true",
      employeeDeps,
    );
    assert.equal(empCreateDenied.status, 403);
    assert.deepEqual(await empCreateDenied.json(), { ok: false, code: "BULLETIN_FORBIDDEN" });

    // 2. Manager creates DRAFT bulletin (201) + Idempotency replay (200) + conflict (409)
    const createPayload = {
      title: "Thông báo Lịch nghỉ Tết Nguyên Đán 2027",
      category: "HOLIDAY_SCHEDULE",
      badge_text: "Quan trọng",
      summary: "Lịch nghỉ lễ và trực vận hành toàn hệ thống HRPartner.",
      content_sections: [
        "1. Thời gian nghỉ chính thức: Từ 06/02/2027 đến hết 14/02/2027.",
        "2. Bộ phận trực lễ đăng ký danh sách trước ngày 25/01/2027.",
      ],
      is_pinned: false,
    };
    const createRes = await handleAdminBulletinCreate(
      makeRequest("/api/admin/bulletins", {
        method: "POST",
        headers: { "idempotency-key": "e2e-create-1" },
        json: createPayload,
      }),
      "true",
      managerDeps,
    );
    assert.equal(createRes.status, 201);
    const createJson = await createRes.json();
    assert.equal(createJson.ok, true);
    assert.equal(createJson.data.replayed, false);
    assert.equal(createJson.data.item.status, "DRAFT");
    assert.equal(createJson.data.item.row_version, 1);
    const createdId = createJson.data.item.bulletin_id;

    // Replay same Idempotency-Key + same payload -> 200 replayed=true
    const createReplay = await handleAdminBulletinCreate(
      makeRequest("/api/admin/bulletins", {
        method: "POST",
        headers: { "idempotency-key": "e2e-create-1" },
        json: createPayload,
      }),
      "true",
      managerDeps,
    );
    assert.equal(createReplay.status, 200);
    assert.equal((await createReplay.json()).data.replayed, true);

    // Same Idempotency-Key + different payload -> 409 IDEMPOTENCY_CONFLICT
    const createConflict = await handleAdminBulletinCreate(
      makeRequest("/api/admin/bulletins", {
        method: "POST",
        headers: { "idempotency-key": "e2e-create-1" },
        json: { ...createPayload, title: "Khác tiêu đề" },
      }),
      "true",
      managerDeps,
    );
    assert.equal(createConflict.status, 409);
    assert.deepEqual(await createConflict.json(), { ok: false, code: "IDEMPOTENCY_CONFLICT" });

    // 3. Manager uploads real sharp PNG + real PDF to DRAFT bulletin
    const rawPng = await sharp({
      create: { width: 160, height: 90, channels: 3, background: { r: 18, g: 98, b: 204 } },
    })
      .png()
      .toBuffer();
    const rawPngSha = sha256Hex(rawPng);

    const pngFd = new FormData();
    pngFd.append("expected_row_version", "1");
    pngFd.append("title", "Banner Lịch nghỉ Tết");
    pngFd.append("file", new File([rawPng], "lich-nghi-tet.png", { type: "image/png" }));
    const upPngRes = await handleAdminBulletinAttachmentUpload(
      makeRequest(`/api/admin/bulletins/${createdId}/attachments`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-up-png" },
        body: pngFd,
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(upPngRes.status, 201);
    const upPngJson = await upPngRes.json();
    const pngAttId = upPngJson.data.attachment_id;
    assert.equal(upPngJson.data.item.row_version, 2);
    assert.equal(upPngJson.data.item.attachments[0].sha256, rawPngSha);
    assert.equal(upPngJson.data.item.attachments[0].width, 160);
    assert.equal(upPngJson.data.item.attachments[0].height, 90);

    const rawPdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 /Kids [2 0 R 3 0 R] >> endobj\n" +
        "2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n" +
        "3 0 obj << /Type /Page /Parent 1 0 R >> endobj\n%%EOF\n",
      "latin1",
    );
    const rawPdfSha = sha256Hex(rawPdf);
    const pdfFd = new FormData();
    pdfFd.append("expected_row_version", "2");
    pdfFd.append("title", "Quyết định nghỉ lễ chính thức");
    pdfFd.append("file", new File([rawPdf], "quyet-dinh.pdf", { type: "application/pdf" }));
    const upPdfRes = await handleAdminBulletinAttachmentUpload(
      makeRequest(`/api/admin/bulletins/${createdId}/attachments`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-up-pdf" },
        body: pdfFd,
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(upPdfRes.status, 201);
    const upPdfJson = await upPdfRes.json();
    const pdfAttId = upPdfJson.data.attachment_id;
    assert.equal(upPdfJson.data.item.row_version, 3);
    assert.equal(upPdfJson.data.item.attachments[1].page_count, 2);
    assert.equal(upPdfJson.data.item.attachments[1].sha256, rawPdfSha);

    // 4. RBAC on DRAFT: employee gets 404 on /content & /detail; manager gets 200 on both
    const empDraftDetail = await handleBulletinDetail(
      makeRequest(`/api/bulletins/${createdId}`),
      createdId,
      "true",
      employeeDeps,
    );
    assert.equal(empDraftDetail.status, 404);
    assert.deepEqual(await empDraftDetail.json(), { ok: false, code: "BULLETIN_NOT_FOUND" });

    const empDraftContent = await handleBulletinAttachmentContent(
      makeRequest(`/api/bulletins/${createdId}/attachments/${pngAttId}/content`),
      createdId,
      pngAttId,
      "true",
      employeeDeps,
    );
    assert.equal(empDraftContent.status, 404);
    assert.deepEqual(await empDraftContent.json(), { ok: false, code: "BULLETIN_NOT_FOUND" });

    const mgrDraftContent = await handleBulletinAttachmentContent(
      makeRequest(`/api/bulletins/${createdId}/attachments/${pngAttId}/content`),
      createdId,
      pngAttId,
      "true",
      managerDeps,
    );
    assert.equal(mgrDraftContent.status, 200);
    assert.equal(sha256Hex(Buffer.from(await mgrDraftContent.arrayBuffer())), rawPngSha);

    const mgrDraftDetail = await handleAdminBulletinDetail(
      makeRequest(`/api/admin/bulletins/${createdId}`),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(mgrDraftDetail.status, 200);

    // 5. Manager updates, checks OCC VERSION_CONFLICT, publishes, and pins
    const staleUpdate = await handleAdminBulletinUpdate(
      makeRequest(`/api/admin/bulletins/${createdId}`, {
        method: "PATCH",
        headers: { "idempotency-key": "e2e-stale-upd" },
        json: {
          expected_row_version: 1,
          title: "Stale",
          category: "HOLIDAY_SCHEDULE",
          content_sections: ["Stale"],
        },
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(staleUpdate.status, 409);
    assert.deepEqual(await staleUpdate.json(), { ok: false, code: "VERSION_CONFLICT" });

    const updateRes = await handleAdminBulletinUpdate(
      makeRequest(`/api/admin/bulletins/${createdId}`, {
        method: "PATCH",
        headers: { "idempotency-key": "e2e-upd-1" },
        json: {
          expected_row_version: 3,
          title: "Thông báo Lịch nghỉ Tết Nguyên Đán 2027 (Chính thức)",
          category: "HOLIDAY_SCHEDULE",
          badge_text: "Quan trọng",
          summary: createPayload.summary,
          content_sections: createPayload.content_sections,
        },
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(updateRes.status, 200);
    assert.equal((await updateRes.json()).data.item.row_version, 4);

    const publishRes = await handleAdminBulletinPublish(
      makeRequest(`/api/admin/bulletins/${createdId}/publish`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-pub-1" },
        json: { expected_row_version: 4 },
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(publishRes.status, 200);
    assert.equal((await publishRes.json()).data.item.status, "PUBLISHED");

    const pinRes = await handleAdminBulletinPin(
      makeRequest(`/api/admin/bulletins/${createdId}/pin`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-pin-1" },
        json: { is_pinned: true, expected_row_version: 5 },
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(pinRes.status, 200);
    assert.equal((await pinRes.json()).data.item.is_pinned, true);

    // Seed a second published bulletin for pagination testing
    const create2Res = await handleAdminBulletinCreate(
      makeRequest("/api/admin/bulletins", {
        method: "POST",
        headers: { "idempotency-key": "e2e-create-2" },
        json: {
          title: "Cập nhật quy trình chấm công",
          category: "INTERNAL_POLICY",
          summary: "Áp dụng từ tháng 12/2026.",
          content_sections: ["Nhân viên check-in đúng vị trí dự án."],
        },
      }),
      "true",
      managerDeps,
    );
    const id2 = (await create2Res.json()).data.item.bulletin_id;
    await handleAdminBulletinPublish(
      makeRequest(`/api/admin/bulletins/${id2}/publish`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-pub-2" },
        json: { expected_row_version: 1 },
      }),
      id2,
      "true",
      managerDeps,
    );

    // 6. Mobile Feed (page_size=1 -> cursor -> page 2) + exact iOS/Android contract check
    const feed1Res = await handleBulletinMobileFeed(
      makeRequest("/api/bulletins?page_size=1"),
      "true",
      employeeDeps,
    );
    assert.equal(feed1Res.status, 200);
    const feed1Json = await feed1Res.json();
    assert.equal(feed1Json.ok, true);
    assert.deepEqual(
      Object.keys(feed1Json.data).sort(),
      ["has_more", "items", "latest_published_at", "next_cursor", "page_size", "unread_count"],
    );
    assert.equal(feed1Json.data.unread_count, 2);
    assert.equal(feed1Json.data.page_size, 1);
    assert.equal(feed1Json.data.has_more, true);
    assert.equal(typeof feed1Json.data.next_cursor, "string");
    assert.equal(feed1Json.data.items.length, 1);
    assertMobileBulletinItemShape(feed1Json.data.items[0]);
    assert.equal(feed1Json.data.items[0].bulletin_id, createdId);
    assert.equal(feed1Json.data.items[0].image_count, 1);
    assert.equal(feed1Json.data.items[0].pdf_count, 1);

    const feed2Res = await handleBulletinMobileFeed(
      makeRequest(`/api/bulletins?limit=1&cursor=${encodeURIComponent(feed1Json.data.next_cursor)}`),
      "true",
      employeeDeps,
    );
    assert.equal(feed2Res.status, 200);
    const feed2Json = await feed2Res.json();
    assert.equal(feed2Json.data.items.length, 1);
    assert.equal(feed2Json.data.items[0].bulletin_id, id2);
    assert.equal(feed2Json.data.has_more, false);
    assert.equal(feed2Json.data.next_cursor, null);

    // 7. Employee Detail + /content 200 + 304 ETag + raw-byte sha256 verification
    const empDetailRes = await handleBulletinDetail(
      makeRequest(`/api/bulletins/${createdId}`),
      createdId,
      "true",
      employeeDeps,
    );
    assert.equal(empDetailRes.status, 200);
    const empDetailJson = await empDetailRes.json();
    assertMobileBulletinItemShape(empDetailJson.data.item);

    const content200 = await handleBulletinAttachmentContent(
      makeRequest(`/api/bulletins/${createdId}/attachments/${pngAttId}/content`),
      createdId,
      pngAttId,
      "true",
      employeeDeps,
    );
    assert.equal(content200.status, 200);
    assert.equal(content200.headers.get("content-type"), "image/png");
    assert.equal(content200.headers.get("content-length"), String(rawPng.byteLength));
    assert.equal(content200.headers.get("etag"), `"${rawPngSha}"`);
    assert.equal(content200.headers.get("cache-control"), "private, max-age=86400");
    assert.equal(content200.headers.get("x-content-type-options"), "nosniff");
    assert.equal(content200.headers.get("vary"), "Cookie");
    assert.match(content200.headers.get("content-disposition") ?? "", /^inline; filename="lich-nghi-tet\.png"/);
    const downloadedPng = Buffer.from(await content200.arrayBuffer());
    assert.equal(sha256Hex(downloadedPng), rawPngSha);
    assert.equal(Buffer.compare(downloadedPng, rawPng), 0);

    const content304 = await handleBulletinAttachmentContent(
      makeRequest(`/api/bulletins/${createdId}/attachments/${pngAttId}/content`, {
        headers: { "if-none-match": `"${rawPngSha}"` },
      }),
      createdId,
      pngAttId,
      "true",
      employeeDeps,
    );
    assert.equal(content304.status, 304);
    assert.equal(content304.headers.get("etag"), `"${rawPngSha}"`);
    assert.equal(content304.headers.get("cache-control"), "private, max-age=86400");
    assert.equal(content304.headers.get("x-content-type-options"), "nosniff");

    // 8. Mark read + Mark all read
    const read1Res = await handleBulletinMarkRead(
      makeRequest(`/api/bulletins/${createdId}/read`, { method: "POST" }),
      createdId,
      "true",
      employeeDeps,
    );
    assert.equal(read1Res.status, 200);
    assert.deepEqual(await read1Res.json(), {
      ok: true,
      data: { bulletin_id: createdId, is_read: true, unread_count: 1 },
    });

    const readAllRes = await handleBulletinMarkAllRead(
      makeRequest("/api/bulletins/read-all", { method: "POST", json: {} }),
      "true",
      employeeDeps,
    );
    assert.equal(readAllRes.status, 200);
    assert.deepEqual(await readAllRes.json(), { ok: true, data: { unread_count: 0 } });

    // 9. Archive & Admin list + Delete attachment + Archive status transition
    const archiveRes = await handleBulletinArchiveList(
      makeRequest("/api/bulletins/archive?category=HOLIDAY_SCHEDULE&q=Nguyên+Đán"),
      "true",
      employeeDeps,
    );
    assert.equal(archiveRes.status, 200);
    const archiveJson = await archiveRes.json();
    assert.equal(archiveJson.data.total_count, 1);
    assert.equal(archiveJson.data.can_manage, false);

    // Non-manager requesting DRAFT in archive -> 403 BULLETIN_FORBIDDEN
    const empDraftArchive = await handleBulletinArchiveList(
      makeRequest("/api/bulletins/archive?status=DRAFT"),
      "true",
      employeeDeps,
    );
    assert.equal(empDraftArchive.status, 403);

    const adminListRes = await handleAdminBulletinList(
      makeRequest("/api/admin/bulletins"),
      "true",
      managerDeps,
    );
    assert.equal(adminListRes.status, 200);
    assert.equal((await adminListRes.json()).data.can_manage, true);

    // Delete PDF attachment removes from S3 store too
    const delAttRes = await handleAdminBulletinAttachmentDelete(
      makeRequest(`/api/admin/bulletins/${createdId}/attachments/${pdfAttId}`, {
        method: "DELETE",
        headers: { "idempotency-key": "e2e-del-pdf" },
        json: { expected_row_version: 6 },
      }),
      createdId,
      pdfAttId,
      "true",
      managerDeps,
    );
    assert.equal(delAttRes.status, 200);
    const delAttJson = await delAttRes.json();
    assert.equal(delAttJson.data.deleted_attachment_id, pdfAttId);
    assert.equal(store.has(delAttJson.data.deleted_storage_key), false);

    // Archive bulletin -> employee gets 404 on detail & /content, manager can still preview
    const archiveActionRes = await handleAdminBulletinArchive(
      makeRequest(`/api/admin/bulletins/${createdId}/archive`, {
        method: "POST",
        headers: { "idempotency-key": "e2e-arch-1" },
        json: { expected_row_version: 7 },
      }),
      createdId,
      "true",
      managerDeps,
    );
    assert.equal(archiveActionRes.status, 200);
    assert.equal((await archiveActionRes.json()).data.item.status, "ARCHIVED");

    const empArchivedContent = await handleBulletinAttachmentContent(
      makeRequest(`/api/bulletins/${createdId}/attachments/${pngAttId}/content`),
      createdId,
      pngAttId,
      "true",
      employeeDeps,
    );
    assert.equal(empArchivedContent.status, 404);
    assert.deepEqual(await empArchivedContent.json(), { ok: false, code: "BULLETIN_NOT_FOUND" });

    // 10. Optional diagnostic sample dump for verification reports when requested
    if (process.env.PRINT_BULLETIN_E2E_SAMPLE === "1") {
      console.log("SAMPLE_MOBILE_FEED_JSON=" + JSON.stringify(feed1Json));
      console.log("SAMPLE_DETAIL_JSON=" + JSON.stringify(empDetailJson));
      console.log(
        "SAMPLE_CONTENT_200_HEADERS=" +
          JSON.stringify(Object.fromEntries(content200.headers.entries())),
      );
      console.log(
        "SAMPLE_CONTENT_304_HEADERS=" +
          JSON.stringify(Object.fromEntries(content304.headers.entries())),
      );
    }
  } finally {
    await db.close();
  }
});
