import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  MAX_RECRUITMENT_POST_BODY_BYTES,
  containsForbiddenClientAuthorityKey,
  parseCreateRecruitmentPostBody,
  parseIdempotencyKeyHeader,
  parseListMyRecruitmentPostsQuery,
  parseListRecruitmentPostsQuery,
  parseNoQueryParams,
  parseUpdateRecruitmentPostBody,
  parseUuidParam,
  parseWithdrawRecruitmentPostBody,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostPublicFeedV1,
  recruitmentPostHttpStatusForError,
  type RecruitmentPostErrorCode,
} from "./contract.ts";
import { GENDER_REQUIREMENT_LABELS } from "./recruitment-post-ui-model.ts";
import type { RecruitmentPostRepository } from "./repository.ts";

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
] as const;

export type RecruitmentPostApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: RecruitmentPostRepository;
};

function recruitmentPostError(code: RecruitmentPostErrorCode): Response {
  return failJson(code, recruitmentPostHttpStatusForError(code));
}

function recruitmentPostOk<T>(data: T, status = 200): Response {
  return noStoreJson({ ok: true, data }, status);
}

function directEntryFeatureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : recruitmentPostError("NOT_FOUND");
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

function parseRequestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

const ACTOR_DISPLAY_NAME_CONTROL_CHAR_PATTERN =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function normalizeActorDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (ACTOR_DISPLAY_NAME_CONTROL_CHAR_PATTERN.test(raw)) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 256) return null;
  return trimmed;
}

async function resolveRecruitmentPostActor(
  dependencies: RecruitmentPostApiDependencies,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
      display_name: string | null;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await dependencies.resolveSession();
  } catch {
    console.error("[recruitment-posts] session resolution failed");
    return {
      ok: false,
      response: recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE"),
    };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? recruitmentPostError("UNAUTHENTICATED")
          : recruitmentPostError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: recruitmentPostError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
    display_name: normalizeActorDisplayName(
      (actor as { display_name?: unknown }).display_name,
    ),
  };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; code: "INVALID_JSON" | "REQUEST_BODY_TOO_LARGE" }
> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, code: "INVALID_JSON" };
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, code: "INVALID_JSON" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, code: "INVALID_JSON" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, code: "REQUEST_BODY_TOO_LARGE" };
    }
  }

  if (!request.body) {
    return { ok: false, code: "INVALID_JSON" };
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
        return { ok: false, code: "REQUEST_BODY_TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, code: "INVALID_JSON" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
}

// -----------------------------------------------------------------------------
// 1. GET /api/recruitment-posts/context
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostContext(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.getContext({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
    });
    if (!result.ok) return recruitmentPostError(result.code);
    return recruitmentPostOk(result.data, 200);
  } catch {
    console.error("[recruitment-posts] getContext failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleGetRecruitmentPostContext = handleRecruitmentPostContext;

// -----------------------------------------------------------------------------
// 2. GET /api/recruitment-posts
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostList(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const parsedQuery = parseListRecruitmentPostsQuery(url);
  if (!parsedQuery.ok) {
    return recruitmentPostError(parsedQuery.code);
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.list({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      ...parsedQuery.value,
    });
    if (!result.ok) return recruitmentPostError(result.code);
    const projected = parsedQuery.value.include_facets
      ? projectRecruitmentPostListWithFacets(result.data)
      : projectRecruitmentPostList(result.data);
    if (!projected) {
      return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
    }
    return recruitmentPostOk(projected, 200);
  } catch {
    console.error("[recruitment-posts] list failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleListRecruitmentPosts = handleRecruitmentPostList;

// -----------------------------------------------------------------------------
// 2b. GET /api/recruitment-posts/mine
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostListMine(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const parsedQuery = parseListMyRecruitmentPostsQuery(url);
  if (!parsedQuery.ok) {
    return recruitmentPostError(parsedQuery.code);
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.listMine({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      ...parsedQuery.value,
    });
    if (!result.ok) return recruitmentPostError(result.code);
    return recruitmentPostOk(result.data, 200);
  } catch {
    console.error("[recruitment-posts] listMine failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleListMyRecruitmentPosts = handleRecruitmentPostListMine;

// -----------------------------------------------------------------------------
// 3. GET /api/recruitment-posts/[briefId]
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostGet(
  request: Request,
  briefId: string,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const parsedBriefId = parseUuidParam(briefId);
  if (!parsedBriefId.ok) {
    return recruitmentPostError(parsedBriefId.code);
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.get({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      brief_id: parsedBriefId.value,
    });
    if (!result.ok) return recruitmentPostError(result.code);
    return recruitmentPostOk(result.data, 200);
  } catch {
    console.error("[recruitment-posts] get failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleGetRecruitmentPost = handleRecruitmentPostGet;

// -----------------------------------------------------------------------------
// 4. POST /api/recruitment-posts
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostCreate(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return recruitmentPostError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;
  if (!actor.display_name) {
    return recruitmentPostError("ACTOR_NOT_AVAILABLE");
  }

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_RECRUITMENT_POST_BODY_BYTES,
  );
  if (!boundedBody.ok) {
    return recruitmentPostError(boundedBody.code);
  }

  if (containsForbiddenClientAuthorityKey(boundedBody.value)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const idempotencyKey = parseIdempotencyKeyHeader(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey.ok) {
    return recruitmentPostError(idempotencyKey.code);
  }

  const parsedBody = parseCreateRecruitmentPostBody(boundedBody.value, {
    actorDisplayName: actor.display_name,
  });
  if (!parsedBody.ok) {
    return recruitmentPostError(parsedBody.code);
  }

  try {
    const created = await dependencies.repository.create({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      payload: parsedBody.value.rpc_payload,
      idempotency_key: idempotencyKey.value,
    });
    if (!created.ok) return recruitmentPostError(created.code);
    return recruitmentPostOk(created.data, created.data.replayed ? 200 : 201);
  } catch {
    console.error("[recruitment-posts] create failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleCreateRecruitmentPost = handleRecruitmentPostCreate;

// -----------------------------------------------------------------------------
// 5. PATCH /api/recruitment-posts/[briefId]
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostUpdate(
  request: Request,
  briefId: string,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return recruitmentPostError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const parsedBriefId = parseUuidParam(briefId);
  if (!parsedBriefId.ok) {
    return recruitmentPostError(parsedBriefId.code);
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_RECRUITMENT_POST_BODY_BYTES,
  );
  if (!boundedBody.ok) {
    return recruitmentPostError(boundedBody.code);
  }

  if (containsForbiddenClientAuthorityKey(boundedBody.value)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const idempotencyKey = parseIdempotencyKeyHeader(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey.ok) {
    return recruitmentPostError(idempotencyKey.code);
  }

  const precheckedBody = parseUpdateRecruitmentPostBody(boundedBody.value, {
    managerNameOverride: "__LOCKED_ORIGINAL_MANAGER_NAME__",
  });
  if (!precheckedBody.ok) {
    return recruitmentPostError(precheckedBody.code);
  }

  try {
    const existing = await dependencies.repository.get({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      brief_id: parsedBriefId.value,
    });
    if (!existing.ok) return recruitmentPostError(existing.code);

    const parsedBody = parseUpdateRecruitmentPostBody(boundedBody.value, {
      managerNameOverride: existing.data.post.general.manager_name,
    });
    if (!parsedBody.ok) {
      return recruitmentPostError(parsedBody.code);
    }

    const updated = await dependencies.repository.update({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      brief_id: parsedBriefId.value,
      expected_version: parsedBody.value.expected_version,
      payload: parsedBody.value.rpc_payload,
      idempotency_key: idempotencyKey.value,
    });
    if (!updated.ok) return recruitmentPostError(updated.code);
    return recruitmentPostOk(updated.data, 200);
  } catch {
    console.error("[recruitment-posts] update failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleUpdateRecruitmentPost = handleRecruitmentPostUpdate;

// -----------------------------------------------------------------------------
// 6. POST /api/recruitment-posts/[briefId]/withdraw
// -----------------------------------------------------------------------------
export async function handleRecruitmentPostWithdraw(
  request: Request,
  briefId: string,
  enabledFlag: string | undefined,
  dependencies: RecruitmentPostApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return recruitmentPostError("CSRF_ORIGIN_DENIED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const url = parseRequestUrl(request);
  if (!url || !parseNoQueryParams(url).ok) {
    return recruitmentPostError("RECRUITMENT_POST_INPUT_INVALID");
  }

  const parsedBriefId = parseUuidParam(briefId);
  if (!parsedBriefId.ok) {
    return recruitmentPostError(parsedBriefId.code);
  }

  const actor = await resolveRecruitmentPostActor(dependencies);
  if (!actor.ok) return actor.response;

  const boundedBody = await readBoundedJsonBody(
    request,
    MAX_RECRUITMENT_POST_BODY_BYTES,
  );
  if (!boundedBody.ok) {
    return recruitmentPostError(boundedBody.code);
  }

  if (containsForbiddenClientAuthorityKey(boundedBody.value)) {
    return recruitmentPostError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  const idempotencyKey = parseIdempotencyKeyHeader(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey.ok) {
    return recruitmentPostError(idempotencyKey.code);
  }

  const parsedBody = parseWithdrawRecruitmentPostBody(boundedBody.value);
  if (!parsedBody.ok) {
    return recruitmentPostError(parsedBody.code);
  }

  try {
    const withdrawn = await dependencies.repository.withdraw({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      brief_id: parsedBriefId.value,
      expected_version: parsedBody.value.expected_version,
      idempotency_key: idempotencyKey.value,
    });
    if (!withdrawn.ok) return recruitmentPostError(withdrawn.code);
    return recruitmentPostOk(withdrawn.data, 200);
  } catch {
    console.error("[recruitment-posts] withdraw failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}

export const handleWithdrawRecruitmentPost = handleRecruitmentPostWithdraw;

// -----------------------------------------------------------------------------
// 7. GET /feeds/jobs.v1.json (Public Read-Only Feed, No Cookie/Token Required)
// -----------------------------------------------------------------------------
export type RecruitmentPostPublicFeedApiDependencies = {
  repository: Pick<RecruitmentPostRepository, "listPublicFeedV1">;
};

export async function handleRecruitmentPostPublicFeedV1(
  _request: Request,
  dependencies: RecruitmentPostPublicFeedApiDependencies,
): Promise<Response> {
  try {
    const result = await dependencies.repository.listPublicFeedV1();
    if (!result.ok) {
      return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
    }
    const projected = projectRecruitmentPostPublicFeedV1(
      result.data,
      GENDER_REQUIREMENT_LABELS,
    );
    if (!projected) {
      return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
    }
    return noStoreJson(projected, 200);
  } catch {
    console.error("[recruitment-posts] public feed v1 failed");
    return recruitmentPostError("RECRUITMENT_POST_UNAVAILABLE");
  }
}
