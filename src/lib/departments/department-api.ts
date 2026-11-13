import "server-only";

import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  computeAssignAccountingMemberFingerprint,
  computeAssignPersonMemberFingerprint,
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
  computeEndAccountingMemberFingerprint,
  computeEndHeadFingerprint,
  computeEndPersonMemberFingerprint,
  computeUpdateDepartmentFingerprint,
  departmentHttpStatusForError,
  parseAssignAccountingMemberBody,
  parseAssignPersonMemberBody,
  parseCreateDepartmentBody,
  parseDepartmentIdParam,
  parseDepartmentPersonMembershipParams,
  parseDesignateHeadBody,
  parseEndAccountingMemberBody,
  parseEndHeadBody,
  parseEndPersonMemberBody,
  parseGetDepartmentParams,
  parseListAccountingCandidatesQuery,
  parseListAccountingMembershipsQuery,
  parseListDepartmentHeadsQuery,
  parseListDepartmentPersonMembershipsQuery,
  parseListDepartmentsQuery,
  parseListRecruitmentTeamsQuery,
  parseUpdateDepartmentBody,
  type DepartmentErrorCode,
} from "./department-contract.ts";
import type { DepartmentRepository } from "./department-repository.ts";

const MAX_DEPARTMENT_MUTATION_JSON_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type DepartmentAdminApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DepartmentRepository;
};

function departmentError(code: DepartmentErrorCode): Response {
  return failJson(code, departmentHttpStatusForError(code));
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
    console.error("[departments-admin] session resolution failed");
    return { ok: false, response: departmentError("DEPARTMENT_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? departmentError("UNAUTHENTICATED")
          : departmentError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: departmentError("ACTOR_NOT_AVAILABLE") };
  }

  const navActor: NavActorProjection = {
    capabilities: actor.capabilities,
    scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
  };

  if (!adminAuthorityNavPredicate(navActor)) {
    return { ok: false, response: departmentError("DEPARTMENT_ACCESS_DENIED") };
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

export async function listDepartmentsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const queryCheck = parseListDepartmentsQuery(parsedUrl);
  if (!queryCheck.ok) return departmentError(queryCheck.code);

  const result = await dependencies.repository.listDepartments({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    include_inactive: queryCheck.value.include_inactive,
    as_of: queryCheck.value.as_of,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function getDepartmentAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedId = parseGetDepartmentParams(departmentId, parsedUrl);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const result = await dependencies.repository.getDepartment({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    department_id: parsedId.value.department_id,
    as_of: parsedId.value.as_of,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function listAccountingMembershipsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListAccountingMembershipsQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listAccountingMemberships({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    include_history: parsedQuery.value.include_history,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function listAccountingCandidatesAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListAccountingCandidatesQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listAccountingCandidates({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function assignAccountingMemberAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return departmentError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
    }
  } catch {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return departmentError("CONTENT_TYPE_INVALID");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_DEPARTMENT_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? departmentError("BODY_TOO_LARGE")
      : departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const parsedBody = parseAssignAccountingMemberBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return departmentError(parsedBody.code);
  }

  const fingerprint = computeAssignAccountingMemberFingerprint({
    actor_app_user_id: actorResult.app_user_id,
    account_ref: parsedBody.value.account_ref,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_from: parsedBody.value.effective_from,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.assignAccountingMember({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    account_ref: parsedBody.value.account_ref,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_from: parsedBody.value.effective_from,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      membership: saved.data.membership,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function endAccountingMemberAdmin(
  request: Request,
  membershipId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request)) {
    return departmentError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
    }
  } catch {
    return departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return departmentError("CONTENT_TYPE_INVALID");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_DEPARTMENT_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? departmentError("BODY_TOO_LARGE")
      : departmentError("DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID");
  }

  const parsedBody = parseEndAccountingMemberBody(
    membershipId,
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return departmentError(parsedBody.code);
  }

  const fingerprint = computeEndAccountingMemberFingerprint({
    actor_app_user_id: actorResult.app_user_id,
    membership_id: parsedBody.value.membership_id,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_to: parsedBody.value.effective_to,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.endAccountingMember({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    membership_id: parsedBody.value.membership_id,
    expected_pair_version: parsedBody.value.expected_pair_version,
    effective_to: parsedBody.value.effective_to,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      membership: saved.data.membership,
    },
    200,
  );
}

export async function listRecruitmentTeamsAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListRecruitmentTeamsQuery(parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listRecruitmentTeams({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    search: parsedQuery.value.search,
    include_inactive: parsedQuery.value.include_inactive,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

async function prepareWp3DepartmentMutation(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
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
    return { ok: false, response: departmentError("CSRF_REJECTED") };
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return { ok: false, response: departmentError("CLIENT_AUTHORITY_FIELD_FORBIDDEN") };
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return { ok: false, response: actorResult.response };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return { ok: false, response: departmentError("DEPARTMENT_QUERY_INVALID") };
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, response: departmentError("CONTENT_TYPE_INVALID") };
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_DEPARTMENT_MUTATION_JSON_BYTES);
  if (!boundedBody.ok) {
    return {
      ok: false,
      response:
        boundedBody.kind === "too-large"
          ? departmentError("BODY_TOO_LARGE")
          : departmentError("ORG_VALIDATION_ERROR"),
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

export async function createDepartmentAdmin(
  request: Request,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  if (prep.url.search.length > 0) {
    return departmentError("ORG_VALIDATION_ERROR");
  }

  const parsedBody = parseCreateDepartmentBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeCreateDepartmentFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    code: parsedBody.value.code,
    name: parsedBody.value.name,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.createDepartment({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    code: parsedBody.value.code,
    name: parsedBody.value.name,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      department: saved.data.department,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function updateDepartmentAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseDepartmentIdParam(departmentId, prep.url);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const parsedBody = parseUpdateDepartmentBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeUpdateDepartmentFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    expected_department_version: parsedBody.value.expected_department_version,
    name: parsedBody.value.name,
    is_active: parsedBody.value.is_active,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.updateDepartment({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    expected_department_version: parsedBody.value.expected_department_version,
    name: parsedBody.value.name,
    is_active: parsedBody.value.is_active,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      department: saved.data.department,
    },
    200,
  );
}

export async function listDepartmentPersonMembershipsAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListDepartmentPersonMembershipsQuery(departmentId, parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listPersonMemberships({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    department_id: parsedQuery.value.department_id,
    status: parsedQuery.value.status,
    search: parsedQuery.value.search,
    as_of: parsedQuery.value.as_of,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function assignDepartmentPersonMemberAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseDepartmentIdParam(departmentId, prep.url);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const parsedBody = parseAssignPersonMemberBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeAssignPersonMemberFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    person_id: parsedBody.value.person_id,
    expected_person_version: parsedBody.value.expected_person_version,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.assignPersonMember({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    person_id: parsedBody.value.person_id,
    expected_person_version: parsedBody.value.expected_person_version,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      person_version: saved.data.person_version,
      membership: saved.data.membership,
    },
    saved.data.replayed ? 200 : 201,
  );
}

export async function endDepartmentPersonMemberAdmin(
  request: Request,
  departmentId: string,
  membershipId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedParams = parseDepartmentPersonMembershipParams(departmentId, membershipId, prep.url);
  if (!parsedParams.ok) return departmentError(parsedParams.code);

  const parsedBody = parseEndPersonMemberBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeEndPersonMemberFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    department_id: parsedParams.value.department_id,
    membership_id: parsedParams.value.membership_id,
    expected_person_version: parsedBody.value.expected_person_version,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.endPersonMember({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    department_id: parsedParams.value.department_id,
    membership_id: parsedParams.value.membership_id,
    expected_person_version: parsedBody.value.expected_person_version,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      person_version: saved.data.person_version,
      membership: saved.data.membership,
    },
    200,
  );
}

export async function listDepartmentHeadsAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const gate = directEntryFeatureGate(enabledFlag);
  if (gate) return gate;

  if (hasDisallowedAuthorityHeaders(request)) {
    return departmentError("CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return departmentError("DEPARTMENT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedFullAdminActor(dependencies.resolveSession);
  if (!actorResult.ok) return actorResult.response;

  const parsedQuery = parseListDepartmentHeadsQuery(departmentId, parsedUrl);
  if (!parsedQuery.ok) return departmentError(parsedQuery.code);

  const result = await dependencies.repository.listDepartmentHeads({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    department_id: parsedQuery.value.department_id,
    include_history: parsedQuery.value.include_history,
    as_of: parsedQuery.value.as_of,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
  });
  if (!result.ok) return departmentError(result.code);

  return noStoreJson(
    {
      ok: true,
      ...result.data,
    },
    200,
  );
}

export async function designateDepartmentHeadAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseDepartmentIdParam(departmentId, prep.url);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const parsedBody = parseDesignateHeadBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeDesignateHeadFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    person_id: parsedBody.value.person_id,
    expected_department_version: parsedBody.value.expected_department_version,
    expected_current_head_assignment_id: parsedBody.value.expected_current_head_assignment_id,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.designateHead({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    person_id: parsedBody.value.person_id,
    expected_department_version: parsedBody.value.expected_department_version,
    expected_current_head_assignment_id: parsedBody.value.expected_current_head_assignment_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      department_version: saved.data.department_version,
      replaced_head: saved.data.replaced_head,
      active_head: saved.data.active_head,
    },
    200,
  );
}

export async function endDepartmentHeadAdmin(
  request: Request,
  departmentId: string,
  enabledFlag: string | undefined,
  dependencies: DepartmentAdminApiDependencies,
): Promise<Response> {
  const prep = await prepareWp3DepartmentMutation(request, enabledFlag, dependencies);
  if (!prep.ok) return prep.response;

  const parsedId = parseDepartmentIdParam(departmentId, prep.url);
  if (!parsedId.ok) return departmentError(parsedId.code);

  const parsedBody = parseEndHeadBody(
    prep.body,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) return departmentError(parsedBody.code);

  const fingerprint = computeEndHeadFingerprint({
    actor_app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    expected_department_version: parsedBody.value.expected_department_version,
    expected_current_head_assignment_id: parsedBody.value.expected_current_head_assignment_id,
    reason: parsedBody.value.reason,
  });

  const saved = await dependencies.repository.endHead({
    auth_subject: prep.actor.auth_subject,
    app_user_id: prep.actor.app_user_id,
    department_id: parsedId.value,
    expected_department_version: parsedBody.value.expected_department_version,
    expected_current_head_assignment_id: parsedBody.value.expected_current_head_assignment_id,
    reason: parsedBody.value.reason,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: fingerprint,
  });
  if (!saved.ok) return departmentError(saved.code);

  return noStoreJson(
    {
      ok: true,
      replayed: saved.data.replayed,
      department_version: saved.data.department_version,
      ended_head: saved.data.ended_head,
    },
    200,
  );
}
