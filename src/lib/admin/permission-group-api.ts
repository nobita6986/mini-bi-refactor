import "server-only";

import { createHash } from "node:crypto";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  parseAssignGroupMemberBody,
  parseCreateGroupBody,
  parseListGroupsQuery,
  parseRemoveGroupMemberBody,
  parseUpdateGroupBody,
  permissionGroupErrorStatus,
  type PermissionGroupErrorCode,
} from "./permission-group-contract.ts";
import type { PermissionGroupRepository } from "./permission-group-repository.ts";

const MAX_JSON_BODY_BYTES = 8192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type PermissionGroupApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: PermissionGroupRepository;
};

function groupError(code: PermissionGroupErrorCode, currentVersion?: number): Response {
  const status = permissionGroupErrorStatus(code);
  if (currentVersion !== undefined) {
    return noStoreJson({ ok: false, code, current_version: currentVersion }, status);
  }
  return failJson(code, status);
}

function featureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : failJson("NOT_FOUND", 404);
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const h of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(h) !== null) return true;
  }
  return false;
}

function checkSameOriginMutation(request: Request): Response | null {
  return isSameOriginAuthRequest(request) ? null : groupError("CSRF_REJECTED");
}

async function readBoundedJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (contentType !== "application/json") {
    return { ok: false, response: groupError("CONTENT_TYPE_INVALID") };
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JSON_BODY_BYTES)
  ) {
    return { ok: false, response: groupError("BODY_TOO_LARGE") };
  }
  if (!request.body) {
    return { ok: false, response: groupError("INVALID_JSON") };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, response: groupError("BODY_TOO_LARGE") };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, response: groupError("INVALID_JSON") };
  }
}

function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return isUuid(trimmed) ? trimmed : null;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

async function resolveVerifiedFullAdminActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | { ok: true; auth_subject: string; app_user_id: string }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    return { ok: false, response: groupError("AUTHZ_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? groupError("UNAUTHENTICATED")
          : groupError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (!actor || actor.enabled !== true || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: groupError("ACTOR_NOT_AVAILABLE") };
  }

  const navActor: NavActorProjection = {
    capabilities: actor.capabilities,
    scopes: actor.scopes.map((s) => ({ kind: s.kind })),
    ...(actor.effective_grants !== undefined ? { effective_grants: actor.effective_grants } : {}),
  };

  if (!adminAuthorityNavPredicate(navActor)) {
    return { ok: false, response: groupError("FORBIDDEN") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
  };
}

export async function listPermissionGroupsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return groupError("AUTHZ_VALIDATION_ERROR");
  }
  const query = parseListGroupsQuery(parsedUrl.searchParams);
  if (!query.ok) return groupError(query.code);

  const res = await dependencies.repository.listGroups(actor, query.value);
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, ...res.data }, 200);
}

export async function createPermissionGroupAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  const csrf = checkSameOriginMutation(request);
  if (csrf) return csrf;

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return groupError("IDEMPOTENCY_KEY_REQUIRED");

  const rawBody = await readBoundedJsonBody(request);
  if (!rawBody.ok) return rawBody.response;
  const body = parseCreateGroupBody(rawBody.value);
  if (!body.ok) return groupError(body.code);

  const requestHash = hashPayload({ op: "CREATE_GROUP", ...body.value });
  const res = await dependencies.repository.createGroup(actor, body.value, idempotencyKey, requestHash);
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, group: res.data }, res.data.replayed ? 200 : 201);
}

export async function updatePermissionGroupAdmin(
  request: Request,
  groupId: string,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  const csrf = checkSameOriginMutation(request);
  if (csrf) return csrf;

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  if (!isUuid(groupId)) return groupError("AUTHZ_VALIDATION_ERROR");
  const normalizedGroupId = groupId.trim().toLowerCase();

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return groupError("IDEMPOTENCY_KEY_REQUIRED");

  const rawBody = await readBoundedJsonBody(request);
  if (!rawBody.ok) return rawBody.response;
  const body = parseUpdateGroupBody(rawBody.value);
  if (!body.ok) return groupError(body.code);

  const requestHash = hashPayload({ op: "UPDATE_GROUP", group_id: normalizedGroupId, ...body.value });
  const res = await dependencies.repository.updateGroup(actor, normalizedGroupId, body.value, idempotencyKey, requestHash);
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, group: res.data }, 200);
}

export async function getAccountGroupsAdmin(
  request: Request,
  accountRef: string,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  if (!isUuid(accountRef)) return groupError("AUTHZ_VALIDATION_ERROR");
  const normalizedAccountRef = accountRef.trim().toLowerCase();

  const res = await dependencies.repository.getAccountGroups(actor, normalizedAccountRef);
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, ...res.data }, 200);
}

export async function assignAccountGroupAdmin(
  request: Request,
  accountRef: string,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  const csrf = checkSameOriginMutation(request);
  if (csrf) return csrf;

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  if (!isUuid(accountRef)) return groupError("AUTHZ_VALIDATION_ERROR");
  const normalizedAccountRef = accountRef.trim().toLowerCase();

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return groupError("IDEMPOTENCY_KEY_REQUIRED");

  const rawBody = await readBoundedJsonBody(request);
  if (!rawBody.ok) return rawBody.response;
  const body = parseAssignGroupMemberBody(rawBody.value);
  if (!body.ok) return groupError(body.code);

  const requestHash = hashPayload({ op: "ASSIGN_GROUP_MEMBER", account_ref: normalizedAccountRef, ...body.value });
  const res = await dependencies.repository.assignGroupMember(
    actor,
    normalizedAccountRef,
    body.value,
    idempotencyKey,
    requestHash,
  );
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, membership: res.data }, res.data.replayed ? 200 : 201);
}

export async function removeAccountGroupAdmin(
  request: Request,
  accountRef: string,
  membershipId: string,
  enabledFlag: string | undefined,
  dependencies: PermissionGroupApiDependencies,
): Promise<Response> {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (hasDisallowedAuthorityHeaders(request)) return groupError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  const csrf = checkSameOriginMutation(request);
  if (csrf) return csrf;

  const actor = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actor.ok) return actor.response;

  if (!isUuid(accountRef) || !isUuid(membershipId)) return groupError("AUTHZ_VALIDATION_ERROR");
  const normalizedAccountRef = accountRef.trim().toLowerCase();
  const normalizedMembershipId = membershipId.trim().toLowerCase();

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return groupError("IDEMPOTENCY_KEY_REQUIRED");

  const rawBody = await readBoundedJsonBody(request);
  if (!rawBody.ok) return rawBody.response;
  const body = parseRemoveGroupMemberBody(rawBody.value);
  if (!body.ok) return groupError(body.code);

  const requestHash = hashPayload({
    op: "REMOVE_GROUP_MEMBER",
    account_ref: normalizedAccountRef,
    membership_id: normalizedMembershipId,
    ...body.value,
  });
  const res = await dependencies.repository.removeGroupMember(
    actor,
    normalizedAccountRef,
    normalizedMembershipId,
    body.value,
    idempotencyKey,
    requestHash,
  );
  if (!res.ok) return groupError(res.code, res.current_version);
  return noStoreJson({ ok: true, membership: res.data }, 200);
}
