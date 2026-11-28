import "server-only";

import {
  encodeBulletinCursor,
  isPlainRecord,
  type BulletinArchiveData,
  type BulletinArchiveQuery,
  type BulletinAttachFileData,
  type BulletinAttachmentContentMeta,
  type BulletinAttachmentKind,
  type BulletinAttachmentMimeType,
  type BulletinCategory,
  type BulletinCursorTuple,
  type BulletinDeleteAttachmentData,
  type BulletinErrorCode,
  type BulletinFeedQuery,
  type BulletinItem,
  type BulletinMobileFeedData,
  type BulletinMutationData,
  type BulletinStatus,
} from "./contract.ts";

export type BulletinRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string; details?: string } | null;
}>;

export type BulletinActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type BulletinOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: BulletinErrorCode };

export type BulletinRepository = {
  listMobileFeed(
    input: BulletinActorRef & BulletinFeedQuery,
  ): Promise<BulletinOutcome<BulletinMobileFeedData>>;
  getDetail(
    input: BulletinActorRef & {
      bulletin_id: string;
      allow_non_published: boolean;
    },
  ): Promise<BulletinOutcome<{ item: BulletinItem }>>;
  markRead(
    input: BulletinActorRef & { bulletin_id: string },
  ): Promise<
    BulletinOutcome<{ bulletin_id: string; is_read: true; unread_count: number }>
  >;
  markAllRead(
    input: BulletinActorRef,
  ): Promise<BulletinOutcome<{ unread_count: number }>>;
  getAttachmentContentMeta(
    input: BulletinActorRef & {
      bulletin_id: string;
      attachment_id: string;
    },
  ): Promise<BulletinOutcome<BulletinAttachmentContentMeta>>;
  listArchive(
    input: BulletinActorRef & BulletinArchiveQuery,
  ): Promise<BulletinOutcome<BulletinArchiveData>>;
  createAdmin(
    input: BulletinActorRef & {
      title: string;
      category: BulletinCategory;
      badge_text: string | null;
      summary: string;
      content_sections: string[];
      author_display: string;
      is_pinned: boolean;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinMutationData>>;
  updateAdmin(
    input: BulletinActorRef & {
      bulletin_id: string;
      expected_row_version: number;
      title: string;
      category: BulletinCategory;
      badge_text: string | null;
      summary: string;
      content_sections: string[];
      author_display: string;
      is_pinned: boolean | null;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinMutationData>>;
  setStatusAdmin(
    input: BulletinActorRef & {
      bulletin_id: string;
      target_status: BulletinStatus;
      expected_row_version: number;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinMutationData>>;
  setPinnedAdmin(
    input: BulletinActorRef & {
      bulletin_id: string;
      is_pinned: boolean;
      expected_row_version: number;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinMutationData>>;
  attachFileAdmin(
    input: BulletinActorRef & {
      bulletin_id: string;
      expected_row_version: number;
      attachment_id: string;
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
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinAttachFileData>>;
  deleteAttachmentAdmin(
    input: BulletinActorRef & {
      bulletin_id: string;
      attachment_id: string;
      expected_row_version: number;
      idempotency_key: string;
      request_hash: string;
    },
  ): Promise<BulletinOutcome<BulletinDeleteAttachmentData>>;
};

const EXPLICIT_SQL_MESSAGE_TOKENS: ReadonlyArray<
  readonly [string, BulletinErrorCode]
> = [
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
  ["VERSION_CONFLICT", "VERSION_CONFLICT"],
  ["BULLETIN_ATTACHMENT_NOT_FOUND", "BULLETIN_ATTACHMENT_NOT_FOUND"],
  ["BULLETIN_NOT_FOUND", "BULLETIN_NOT_FOUND"],
  ["BULLETIN_FORBIDDEN", "BULLETIN_FORBIDDEN"],
  ["BULLETIN_ACTOR_FORBIDDEN", "BULLETIN_ACTOR_FORBIDDEN"],
  ["BULLETIN_IDEMPOTENCY_INVALID", "BULLETIN_IDEMPOTENCY_INVALID"],
  ["BULLETIN_PUBLISH_CONTENT_REQUIRED", "BULLETIN_PUBLISH_CONTENT_REQUIRED"],
  ["BULLETIN_TITLE_INVALID", "BULLETIN_TITLE_INVALID"],
  ["BULLETIN_CATEGORY_INVALID", "BULLETIN_CATEGORY_INVALID"],
  ["BULLETIN_BADGE_INVALID", "BULLETIN_BADGE_INVALID"],
  ["BULLETIN_SUMMARY_INVALID", "BULLETIN_SUMMARY_INVALID"],
  ["BULLETIN_CONTENT_SECTIONS_INVALID", "BULLETIN_CONTENT_SECTIONS_INVALID"],
  ["BULLETIN_AUTHOR_INVALID", "BULLETIN_AUTHOR_INVALID"],
  ["BULLETIN_STATUS_INVALID", "BULLETIN_STATUS_INVALID"],
  ["BULLETIN_DATE_RANGE_INVALID", "BULLETIN_DATE_RANGE_INVALID"],
  ["BULLETIN_CURSOR_INVALID", "BULLETIN_CURSOR_INVALID"],
  ["BULLETIN_ATTACHMENT_MIME_INVALID", "BULLETIN_ATTACHMENT_MIME_INVALID"],
  ["BULLETIN_ATTACHMENT_SIZE_INVALID", "BULLETIN_ATTACHMENT_SIZE_INVALID"],
  ["BULLETIN_ATTACHMENT_SHA256_INVALID", "BULLETIN_ATTACHMENT_SHA256_INVALID"],
  ["BULLETIN_ATTACHMENT_INVALID", "BULLETIN_ATTACHMENT_INVALID"],
  ["BULLETIN_VALIDATION_ERROR", "BULLETIN_VALIDATION_ERROR"],
];

export function classifyBulletinRpcError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
): BulletinErrorCode {
  if (!error || typeof error !== "object") {
    return "BULLETIN_UNAVAILABLE";
  }

  const rawMessage = typeof error.message === "string" ? error.message.trim() : "";
  if (rawMessage.length > 0) {
    for (const [token, mappedCode] of EXPLICIT_SQL_MESSAGE_TOKENS) {
      if (rawMessage === token || rawMessage.includes(token)) {
        return mappedCode;
      }
    }
  }

  switch (error.code) {
    case "P0002":
      return "BULLETIN_NOT_FOUND";
    case "42501":
      return "BULLETIN_FORBIDDEN";
    case "PT409":
    case "40001":
      return "VERSION_CONFLICT";
    case "22023":
    case "23514":
      return "BULLETIN_VALIDATION_ERROR";
    default:
      return "BULLETIN_UNAVAILABLE";
  }
}

function projectMobileFeedData(raw: unknown): BulletinMobileFeedData | null {
  if (!isPlainRecord(raw)) return null;
  if (
    !Array.isArray(raw.items) ||
    typeof raw.unread_count !== "number" ||
    typeof raw.page_size !== "number" ||
    typeof raw.has_more !== "boolean"
  ) {
    return null;
  }

  let next_cursor: string | null = null;
  if (typeof raw.next_cursor === "string") {
    next_cursor = raw.next_cursor;
  } else if (isPlainRecord(raw.next_cursor_tuple)) {
    try {
      next_cursor = encodeBulletinCursor(
        raw.next_cursor_tuple as unknown as BulletinCursorTuple,
      );
    } catch {
      return null;
    }
  }

  return {
    items: raw.items as BulletinItem[],
    unread_count: raw.unread_count,
    latest_published_at:
      typeof raw.latest_published_at === "string" ? raw.latest_published_at : null,
    page_size: raw.page_size,
    has_more: raw.has_more,
    next_cursor,
  };
}

function projectPlainObject<T>(raw: unknown, requiredKey: string): T | null {
  if (!isPlainRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, requiredKey)) {
    return null;
  }
  return raw as T;
}

function serviceRoleRpc(): BulletinRpc {
  const client = import("../supabase/server.ts").then(
    ({ createServiceSupabaseClient }) => createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createServiceBulletinRepository(
  rpc?: BulletinRpc,
): BulletinRepository {
  let resolvedRpc: BulletinRpc | undefined = rpc;
  const callRpc: BulletinRpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function invoke<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (raw: unknown) => T | null,
  ): Promise<BulletinOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) {
        return { ok: false, code: classifyBulletinRpcError(error) };
      }
      const projected = project(data);
      if (!projected) {
        return { ok: false, code: "BULLETIN_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      console.error(`[bulletins] RPC ${rpcName} execution failed`);
      return { ok: false, code: "BULLETIN_UNAVAILABLE" };
    }
  }

  return {
    listMobileFeed(input) {
      return invoke(
        "hr_bulletin_list_mobile_feed",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_category: input.category,
          p_page_size: input.page_size,
          p_cursor_is_pinned: input.cursor ? input.cursor.is_pinned : null,
          p_cursor_published_at: input.cursor ? input.cursor.published_at : null,
          p_cursor_bulletin_id: input.cursor ? input.cursor.bulletin_id : null,
          p_cursor_offset_count: input.cursor ? input.cursor.offset_count : 0,
        },
        projectMobileFeedData,
      );
    },

    getDetail(input) {
      return invoke(
        "hr_bulletin_get_detail",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_allow_non_published: input.allow_non_published,
        },
        (raw) => projectPlainObject<{ item: BulletinItem }>(raw, "item"),
      );
    },

    markRead(input) {
      return invoke(
        "hr_bulletin_mark_read",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
        },
        (raw) =>
          projectPlainObject<{
            bulletin_id: string;
            is_read: true;
            unread_count: number;
          }>(raw, "bulletin_id"),
      );
    },

    markAllRead(input) {
      return invoke(
        "hr_bulletin_mark_all_read",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        (raw) => projectPlainObject<{ unread_count: number }>(raw, "unread_count"),
      );
    },

    getAttachmentContentMeta(input) {
      return invoke(
        "hr_bulletin_get_attachment_content_meta",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_attachment_id: input.attachment_id,
        },
        (raw) =>
          projectPlainObject<BulletinAttachmentContentMeta>(raw, "storage_key"),
      );
    },

    listArchive(input) {
      return invoke(
        "hr_bulletin_list_archive",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_from_date: input.from_date,
          p_to_date: input.to_date,
          p_category: input.category,
          p_status: input.status,
          p_author: input.author,
          p_created_by: input.created_by,
          p_search: input.q,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        (raw) => projectPlainObject<BulletinArchiveData>(raw, "items"),
      );
    },

    createAdmin(input) {
      return invoke(
        "hr_bulletin_create_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_title: input.title,
          p_category: input.category,
          p_badge_text: input.badge_text,
          p_summary: input.summary,
          p_content_sections: input.content_sections,
          p_author_display: input.author_display,
          p_is_pinned: input.is_pinned,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinMutationData>(raw, "item"),
      );
    },

    updateAdmin(input) {
      return invoke(
        "hr_bulletin_update_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_expected_row_version: input.expected_row_version,
          p_title: input.title,
          p_category: input.category,
          p_badge_text: input.badge_text,
          p_summary: input.summary,
          p_content_sections: input.content_sections,
          p_author_display: input.author_display,
          p_is_pinned: input.is_pinned,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinMutationData>(raw, "item"),
      );
    },

    setStatusAdmin(input) {
      return invoke(
        "hr_bulletin_set_status_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_target_status: input.target_status,
          p_expected_row_version: input.expected_row_version,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinMutationData>(raw, "item"),
      );
    },

    setPinnedAdmin(input) {
      return invoke(
        "hr_bulletin_set_pinned_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_is_pinned: input.is_pinned,
          p_expected_row_version: input.expected_row_version,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinMutationData>(raw, "item"),
      );
    },

    attachFileAdmin(input) {
      return invoke(
        "hr_bulletin_attach_file_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_expected_row_version: input.expected_row_version,
          p_attachment_id: input.attachment_id,
          p_kind: input.kind,
          p_file_name: input.file_name,
          p_title: input.title,
          p_mime_type: input.mime_type,
          p_file_size_bytes: input.file_size_bytes,
          p_storage_key: input.storage_key,
          p_width: input.width,
          p_height: input.height,
          p_page_count: input.page_count,
          p_sha256: input.sha256,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinAttachFileData>(raw, "item"),
      );
    },

    deleteAttachmentAdmin(input) {
      return invoke(
        "hr_bulletin_delete_attachment_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_bulletin_id: input.bulletin_id,
          p_attachment_id: input.attachment_id,
          p_expected_row_version: input.expected_row_version,
          p_idempotency_key: input.idempotency_key,
          p_request_hash: input.request_hash,
        },
        (raw) => projectPlainObject<BulletinDeleteAttachmentData>(raw, "item"),
      );
    },
  };
}
