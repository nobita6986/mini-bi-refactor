import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  organizationErrorStatus,
  parseGetUserDirectoryEntryQuery,
  parseListUserDirectoryQuery,
  type OrganizationErrorCode,
} from "./user-directory-contract.ts";
import type { UserDirectoryRepository } from "./user-directory-repository.ts";

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type UserDirectoryAdminApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: UserDirectoryRepository;
};

function orgError(code: OrganizationErrorCode): Response {
  return failJson(code, organizationErrorStatus(code));
}

function directEntryFeatureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : failJson("NOT_FOUND", 404);
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveVerifiedFullAdminActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[user-directory-admin] session resolution failed");
    return { ok: false, response: orgError("ORG_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? orgError("UNAUTHENTICATED")
          : orgError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: orgError("ACTOR_NOT_AVAILABLE") };
  }

  const navActor: NavActorProjection = {
    capabilities: actor.capabilities,
    scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
    ...(actor.effective_grants !== undefined ? { effective_grants: actor.effective_grants } : {}),
  };

  if (!adminAuthorityNavPredicate(navActor)) {
    return { ok: false, response: orgError("FORBIDDEN") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
  };
}

export async function listUserDirectoryAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: UserDirectoryAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return orgError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return orgError("ORG_VALIDATION_ERROR");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListUserDirectoryQuery(parsedUrl);
  if (!parsedQuery.ok) return orgError(parsedQuery.code);

  const result = await dependencies.repository.listUserDirectory({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    record_kind: parsedQuery.value.record_kind,
    person_status: parsedQuery.value.person_status,
    login_state: parsedQuery.value.login_state,
    department_id: parsedQuery.value.department_id,
    as_of: parsedQuery.value.as_of,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return orgError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function getUserDirectoryEntryAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: UserDirectoryAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return orgError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return orgError("ORG_VALIDATION_ERROR");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseGetUserDirectoryEntryQuery(parsedUrl);
  if (!parsedQuery.ok) return orgError(parsedQuery.code);

  const result = await dependencies.repository.getUserDirectoryEntry({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    person_id: parsedQuery.value.person_id,
    account_ref: parsedQuery.value.account_ref,
    as_of: parsedQuery.value.as_of,
  });
  if (!result.ok) return orgError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}
