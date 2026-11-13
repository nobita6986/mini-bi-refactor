import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeSetAccountTypeFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUnlinkAccountPersonFingerprint,
  computeUpdatePersonFingerprint,
  organizationErrorStatus,
  parseCreatePersonBody,
  parseGetPersonParams,
  parseLinkAccountPersonBody,
  parseListPersonsQuery,
  parseSetAccountTypeBody,
  parseTransferPersonDepartmentBody,
  parseUnlinkAccountPersonBody,
  parseUpdatePersonBody,
  parseUuidPathWithEmptyQuery,
  type OrganizationErrorCode,
} from "./person-contract.ts";
import type { OrganizationRepository } from "./person-repository.ts";

const MAX_ORGANIZATION_MUTATION_JSON_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type OrganizationAdminApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: OrganizationRepository;
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
    console.error("[organization-admin] session resolution failed");
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

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
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
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
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
    return { ok: false, kind: "invalid" };
  }
}

async function prepareOrganizationMutation(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<
  | {
      ok: true;
      actor: { auth_subject: string; app_user_id: string };
      url: URL;
      body: unknown;
    }
  | { ok: false; response: Response }
> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return { ok: false, response: gate };

  if (!isSameOriginAuthRequest(request)) {
    return { ok: false, response: orgError("CSRF_REJECTED") };
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return { ok: false, response: orgError("CLIENT_AUTHORITY_FIELD_FORBIDDEN") };
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return { ok: false, response: actorResult.response };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return { ok: false, response: orgError("ORG_VALIDATION_ERROR") };
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, response: orgError("CONTENT_TYPE_INVALID") };
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_ORGANIZATION_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return {
      ok: false,
      response:
        boundedBody.kind === "too-large" ? orgError("BODY_TOO_LARGE") : orgError("INVALID_JSON"),
    };
  }

  return {
    ok: true,
    actor: {
      auth_subject: actorResult.auth_subject,
      app_user_id: actorResult.app_user_id,
    },
    url: parsedUrl,
    body: boundedBody.value,
  };
}

export async function listPersonsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
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

  const parsedQuery = parseListPersonsQuery(parsedUrl);
  if (!parsedQuery.ok) return orgError(parsedQuery.code);

  const result = await dependencies.repository.listPersons({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    status: parsedQuery.value.status,
    department_id: parsedQuery.value.department_id,
    link_state: parsedQuery.value.link_state,
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

export async function getPersonAdmin(
  request: Request,
  personId: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
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

  const parsedParams = parseGetPersonParams(personId, parsedUrl);
  if (!parsedParams.ok) return orgError(parsedParams.code);

  const result = await dependencies.repository.getPerson({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    person_id: parsedParams.value.person_id,
    as_of: parsedParams.value.as_of,
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

export async function createPersonAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  if (prep.url.search.length > 0) {
    return orgError("ORG_VALIDATION_ERROR");
  }

  const parsedBody = parseCreatePersonBody(prep.body, request.headers.get("idempotency-key"));
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeCreatePersonFingerprint(prep.actor.app_user_id, parsedBody.value);
  const saved = await dependencies.repository.createPerson({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    employee_code: parsedBody.value.employee_code,
    full_name: parsedBody.value.full_name,
    joined_on: parsedBody.value.joined_on,
    initial_department_id: parsedBody.value.initial_department_ref,
    account_ref: parsedBody.value.account_ref,
    expected_account_version: parsedBody.value.expected_account_version,
    recruiter_id: parsedBody.value.recruiter_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      person: saved.data.person,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function updatePersonAdmin(
  request: Request,
  personId: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseUuidPathWithEmptyQuery(personId, prep.url, "personId");
  if (!parsedId.ok) return orgError(parsedId.code);

  const parsedBody = parseUpdatePersonBody(prep.body, request.headers.get("idempotency-key"));
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeUpdatePersonFingerprint(
    prep.actor.app_user_id,
    parsedId.value,
    parsedBody.value,
  );
  const saved = await dependencies.repository.updatePerson({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    person_id: parsedId.value,
    expected_person_version: parsedBody.value.expected_person_version,
    employee_code: parsedBody.value.employee_code,
    full_name: parsedBody.value.full_name,
    joined_on: parsedBody.value.joined_on,
    status: parsedBody.value.status,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      person: saved.data.person,
    },
    200,
  );
}

export async function transferPersonDepartmentAdmin(
  request: Request,
  personId: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseUuidPathWithEmptyQuery(personId, prep.url, "personId");
  if (!parsedId.ok) return orgError(parsedId.code);

  const parsedBody = parseTransferPersonDepartmentBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeTransferPersonDepartmentFingerprint(
    prep.actor.app_user_id,
    parsedId.value,
    parsedBody.value,
  );
  const saved = await dependencies.repository.transferPersonDepartment({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    person_id: parsedId.value,
    target_department_id: parsedBody.value.target_department_ref,
    expected_person_version: parsedBody.value.expected_person_version,
    expected_current_membership_id: parsedBody.value.expected_current_membership_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      person_version: saved.data.person_version,
      closed_membership: saved.data.closed_membership,
      active_membership: saved.data.active_membership,
    },
    200,
  );
}

export async function setAccountTypeAdmin(
  request: Request,
  accountRef: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedAccountRef = parseUuidPathWithEmptyQuery(accountRef, prep.url, "accountRef");
  if (!parsedAccountRef.ok) return orgError(parsedAccountRef.code);

  const parsedBody = parseSetAccountTypeBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeSetAccountTypeFingerprint(
    prep.actor.app_user_id,
    parsedAccountRef.value,
    parsedBody.value,
  );
  const saved = await dependencies.repository.setAccountType({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    account_ref: parsedAccountRef.value,
    account_type: parsedBody.value.account_type,
    expected_account_version: parsedBody.value.expected_account_version,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      account: saved.data.account,
    },
    200,
  );
}

export async function linkAccountPersonAdmin(
  request: Request,
  accountRef: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedAccountRef = parseUuidPathWithEmptyQuery(accountRef, prep.url, "accountRef");
  if (!parsedAccountRef.ok) return orgError(parsedAccountRef.code);

  const parsedBody = parseLinkAccountPersonBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeLinkAccountPersonFingerprint(
    prep.actor.app_user_id,
    parsedAccountRef.value,
    parsedBody.value,
  );
  const saved = await dependencies.repository.linkAccountPerson({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    account_ref: parsedAccountRef.value,
    person_id: parsedBody.value.person_id,
    expected_account_version: parsedBody.value.expected_account_version,
    expected_person_version: parsedBody.value.expected_person_version,
    confirmed_recruiter_id: parsedBody.value.confirmed_recruiter_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      account_version: saved.data.account_version,
      person_version: saved.data.person_version,
      link: saved.data.link,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function unlinkAccountPersonAdmin(
  request: Request,
  accountRef: string,
  enabledFlag: string | undefined,
  dependencies: OrganizationAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareOrganizationMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedAccountRef = parseUuidPathWithEmptyQuery(accountRef, prep.url, "accountRef");
  if (!parsedAccountRef.ok) return orgError(parsedAccountRef.code);

  const parsedBody = parseUnlinkAccountPersonBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return orgError(parsedBody.code);

  const fingerprint = computeUnlinkAccountPersonFingerprint(
    prep.actor.app_user_id,
    parsedAccountRef.value,
    parsedBody.value,
  );
  const saved = await dependencies.repository.unlinkAccountPerson({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    account_ref: parsedAccountRef.value,
    expected_account_version: parsedBody.value.expected_account_version,
    expected_person_version: parsedBody.value.expected_person_version,
    expected_link_id: parsedBody.value.expected_link_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return orgError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      account_version: saved.data.account_version,
      person_version: saved.data.person_version,
      ended_link: saved.data.ended_link,
    },
    200,
  );
}
