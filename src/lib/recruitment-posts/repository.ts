import "server-only";

import {
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostMutation,
  projectRecruitmentPostPublicFeedV1,
} from "./contract.ts";
import type {
  ListMyRecruitmentPostsQuery,
  ListRecruitmentPostsQuery,
  RecruitmentPostContext,
  RecruitmentPostErrorCode,
  RecruitmentPostGetResult,
  RecruitmentPostList,
  RecruitmentPostListWithFacets,
  RecruitmentPostMutationResult,
  RecruitmentPostPublicFeedV1,
} from "./contract.ts";
import { GENDER_REQUIREMENT_LABELS } from "./recruitment-post-ui-model.ts";

export type RecruitmentPostRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type RecruitmentPostActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type RecruitmentPostOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: RecruitmentPostErrorCode };

export type RecruitmentPostRepository = {
  getContext(
    input: RecruitmentPostActorRef,
  ): Promise<RecruitmentPostOutcome<RecruitmentPostContext>>;
  list(
    input: RecruitmentPostActorRef & ListRecruitmentPostsQuery,
  ): Promise<
    RecruitmentPostOutcome<RecruitmentPostList | RecruitmentPostListWithFacets>
  >;
  listMine(
    input: RecruitmentPostActorRef & ListMyRecruitmentPostsQuery,
  ): Promise<RecruitmentPostOutcome<RecruitmentPostList>>;
  listPublicFeedV1(): Promise<RecruitmentPostOutcome<RecruitmentPostPublicFeedV1>>;
  get(
    input: RecruitmentPostActorRef & { brief_id: string },
  ): Promise<RecruitmentPostOutcome<RecruitmentPostGetResult>>;
  create(
    input: RecruitmentPostActorRef & {
      payload: Record<string, unknown>;
      idempotency_key: string;
    },
  ): Promise<RecruitmentPostOutcome<RecruitmentPostMutationResult>>;
  update(
    input: RecruitmentPostActorRef & {
      brief_id: string;
      expected_version: number;
      payload: Record<string, unknown>;
      idempotency_key: string;
    },
  ): Promise<RecruitmentPostOutcome<RecruitmentPostMutationResult>>;
  withdraw(
    input: RecruitmentPostActorRef & {
      brief_id: string;
      expected_version: number;
      idempotency_key: string;
    },
  ): Promise<RecruitmentPostOutcome<RecruitmentPostMutationResult>>;
};

const EXPLICIT_SQL_MESSAGE_TOKENS: ReadonlyArray<
  readonly [string, RecruitmentPostErrorCode]
> = [
  ["CLIENT_AUTHORITY_FIELD_FORBIDDEN", "CLIENT_AUTHORITY_FIELD_FORBIDDEN"],
  [
    "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
    "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  ],
  ["RECRUITMENT_POST_INPUT_INVALID", "RECRUITMENT_POST_INPUT_INVALID"],
  ["RECRUITMENT_POST_SNAPSHOT_INVALID", "RECRUITMENT_POST_SNAPSHOT_INVALID"],
  ["RECRUITMENT_POST_CONTENT_INVALID", "RECRUITMENT_POST_CONTENT_INVALID"],
  ["RECRUITMENT_POST_ACCESS_DENIED", "RECRUITMENT_POST_ACCESS_DENIED"],
  ["RECRUITMENT_POST_NOT_FOUND", "RECRUITMENT_POST_NOT_FOUND"],
  ["RECRUITMENT_POST_STALE", "RECRUITMENT_POST_STALE"],
  [
    "RECRUITMENT_POST_ALREADY_WITHDRAWN",
    "RECRUITMENT_POST_ALREADY_WITHDRAWN",
  ],
  [
    "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
    "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
  ],
  [
    "idempotency key reused with different input",
    "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
  ],
];

export function classifyRecruitmentPostError(
  error: { code?: string; message?: string } | null | undefined,
): RecruitmentPostErrorCode {
  if (!error || typeof error !== "object") {
    return "RECRUITMENT_POST_UNAVAILABLE";
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
    case "42501":
      return "RECRUITMENT_POST_ACCESS_DENIED";
    case "P0002":
      return "RECRUITMENT_POST_NOT_FOUND";
    case "PT409":
    case "40001":
      return "RECRUITMENT_POST_STALE";
    case "23514":
      return "RECRUITMENT_POST_CONTENT_INVALID";
    case "22023":
      return "RECRUITMENT_POST_INPUT_INVALID";
    default:
      return "RECRUITMENT_POST_UNAVAILABLE";
  }
}

function serviceRoleRpc(): RecruitmentPostRpc {
  const client = import("../supabase/server").then(
    ({ createServiceSupabaseClient }) => createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createRecruitmentPostRepository(
  rpc?: RecruitmentPostRpc,
): RecruitmentPostRepository {
  let resolvedRpc: RecruitmentPostRpc | undefined = rpc;
  const callRpc: RecruitmentPostRpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function invoke<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (raw: unknown) => T | null,
  ): Promise<RecruitmentPostOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) {
        return { ok: false, code: classifyRecruitmentPostError(error) };
      }
      const projected = project(data);
      if (!projected) {
        return { ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      console.error("[recruitment-posts] RPC execution failed");
      return { ok: false, code: "RECRUITMENT_POST_UNAVAILABLE" };
    }
  }

  return {
    getContext(input) {
      return invoke(
        "recruitment_post_get_context",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        projectRecruitmentPostContext,
      );
    },
    list(input) {
      const rpcArgs = {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_province_id: input.province_id,
        p_industrial_park_id: input.industrial_park_id,
        p_labor_type_key: input.labor_type_key,
        p_updated_from: input.updated_from,
        p_updated_to: input.updated_to,
        p_cursor: input.cursor,
        p_snapshot_token: input.snapshot_token,
        p_page_size: input.page_size,
      };
      if (input.include_facets === true) {
        return invoke(
          "recruitment_post_list_with_facets",
          rpcArgs,
          projectRecruitmentPostListWithFacets,
        );
      }
      return invoke(
        "recruitment_post_list",
        rpcArgs,
        projectRecruitmentPostList,
      );
    },
    listMine(input) {
      return invoke(
        "recruitment_post_list_mine",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_cursor: input.cursor,
          p_snapshot_token: input.snapshot_token,
          p_page_size: input.page_size,
        },
        projectRecruitmentPostList,
      );
    },
    listPublicFeedV1() {
      return invoke(
        "recruitment_post_public_feed_v1",
        {},
        (raw) =>
          projectRecruitmentPostPublicFeedV1(raw, GENDER_REQUIREMENT_LABELS),
      );
    },
    get(input) {
      return invoke(
        "recruitment_post_get",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_brief_id: input.brief_id,
        },
        projectRecruitmentPostGet,
      );
    },
    create(input) {
      return invoke(
        "recruitment_post_create",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_payload: input.payload,
          p_idempotency_key: input.idempotency_key,
        },
        projectRecruitmentPostMutation,
      );
    },
    update(input) {
      return invoke(
        "recruitment_post_update",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_brief_id: input.brief_id,
          p_expected_version: input.expected_version,
          p_payload: input.payload,
          p_idempotency_key: input.idempotency_key,
        },
        projectRecruitmentPostMutation,
      );
    },
    withdraw(input) {
      return invoke(
        "recruitment_post_withdraw",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_brief_id: input.brief_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        },
        projectRecruitmentPostMutation,
      );
    },
  };
}
