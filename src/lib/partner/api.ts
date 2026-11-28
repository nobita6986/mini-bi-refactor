import "server-only";

import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  resetPassword,
  type AccountOperationDependencies,
} from "../admin/account-operation-api.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import type { DirectEntryActor } from "../auth/direct-entry-v2.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  PARTNER_DISALLOWED_AUTHORITY_HEADERS,
  PARTNER_MAX_BODY_BYTES,
  containsForbiddenPartnerPayloadKey,
  isRecord,
  parseActivatePartnerBody,
  parseAdminPartnerParams,
  parseAdminReasonIdempotencyBody,
  parsePartnerProfilePatchBody,
  parsePartnerSummaryQuery,
  parsePartnerWorkersQuery,
  partnerHttpStatusForError,
  type PartnerErrorCode,
} from "./contract.ts";
import {
  activatePartnerAccount,
  provisionPartnerAccount,
  rotatePartnerActivationCode,
  type PartnerProvisionAuth,
} from "./provisioning.ts";
import type { PartnerRepository } from "./repository.ts";

export type PartnerApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: PartnerRepository;
  auth?: PartnerProvisionAuth;
  accountOperations?: Omit<AccountOperationDependencies, "resolveSession">;
  generateActivationCode?: () => string;
  nowMs?: () => number;
  activationTtlMs?: number;
};

function partnerFail(code: PartnerErrorCode, status?: number): Response {
  return failJson(code, status ?? partnerHttpStatusForError(code));
}

function partnerOk<T extends Record<string, unknown>>(payload: T, status = 200): Response {
  return noStoreJson({ ok: true, ...payload }, status);
}

function featureGate(enabledFlag: string | undefined): Response | null {
  return enabledFlag === "true" ? null : partnerFail("NOT_FOUND", 404);
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  return PARTNER_DISALLOWED_AUTHORITY_HEADERS.some(
    (name) => request.headers.get(name) !== null,
  );
}

function checkGuards(
  request: Request,
  enabledFlag: string | undefined,
  options: { requireSameOrigin?: boolean } = {},
): Response | null {
  const gate = featureGate(enabledFlag);
  if (gate) return gate;
  if (options.requireSameOrigin) {
    const origin = checkSameOriginRequest({
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    });
    if (!origin.ok) return partnerFail("CSRF_REJECTED", 403);
  }
  if (hasDisallowedAuthorityHeaders(request)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }
  return null;
}

async function readBoundedPartnerJson(
  request: Request,
  invalidCode: PartnerErrorCode = "PARTNER_INVALID",
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, response: partnerFail(invalidCode, 400) };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed) || Number(trimmed) > PARTNER_MAX_BODY_BYTES) {
      return { ok: false, response: partnerFail(invalidCode, 400) };
    }
  }
  if (!request.body) {
    return { ok: false, response: partnerFail(invalidCode, 400) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PARTNER_MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, response: partnerFail(invalidCode, 400) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { ok: false, response: partnerFail(invalidCode, 400) };
  } finally {
    reader.releaseLock();
  }
}

function parseRequestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

async function resolveAuthenticatedSession(
  deps: Pick<PartnerApiDependencies, "resolveSession">,
): Promise<
  | { ok: true; session: DirectEntrySessionResult; actor: DirectEntryActor }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await deps.resolveSession();
  } catch {
    return { ok: false, response: partnerFail("PARTNER_UNAVAILABLE", 503) };
  }
  if (!session.actor.ok) {
    if (session.actor.reason === "UNAUTHENTICATED") {
      return { ok: false, response: partnerFail("UNAUTHENTICATED", 401) };
    }
    if (session.actor.reason === "ACTOR_PENDING_ACTIVATION") {
      return { ok: false, response: partnerFail("ACCOUNT_PENDING_ACTIVATION", 403) };
    }
    return { ok: false, response: partnerFail("ACTOR_NOT_AVAILABLE", 403) };
  }
  const actor = session.actor.actor;
  if (
    !actor ||
    actor.enabled !== true ||
    !isUuid(actor.auth_subject) ||
    !isUuid(actor.app_user_id)
  ) {
    return { ok: false, response: partnerFail("ACTOR_NOT_AVAILABLE", 403) };
  }
  return { ok: true, session, actor };
}

async function resolveAdminPartnerOperator(
  deps: Pick<PartnerApiDependencies, "resolveSession">,
): Promise<
  | { ok: true; session: DirectEntrySessionResult; auth_subject: string; app_user_id: string }
  | { ok: false; response: Response }
> {
  const resolved = await resolveAuthenticatedSession(deps);
  if (!resolved.ok) return resolved;
  if (resolved.actor.partner_account !== undefined) {
    return { ok: false, response: partnerFail("PARTNER_FORBIDDEN", 403) };
  }
  return {
    ok: true,
    session: resolved.session,
    auth_subject: resolved.actor.auth_subject,
    app_user_id: resolved.actor.app_user_id,
  };
}

async function resolvePortalPartnerActor(
  deps: Pick<PartnerApiDependencies, "resolveSession">,
  options: { requirePasswordChanged?: boolean; requireVendor?: boolean } = {},
): Promise<
  | { ok: true; actor: DirectEntryActor }
  | { ok: false; response: Response }
> {
  const resolved = await resolveAuthenticatedSession(deps);
  if (!resolved.ok) return resolved;
  const partner = resolved.actor.partner_account;
  if (!partner) {
    return { ok: false, response: partnerFail("PARTNER_FORBIDDEN", 403) };
  }
  if (
    options.requirePasswordChanged !== false &&
    (partner.must_change_password ||
      partner.account_state === "ACTIVE_MUST_CHANGE_PASSWORD")
  ) {
    return { ok: false, response: partnerFail("PASSWORD_CHANGE_REQUIRED", 403) };
  }
  if (options.requireVendor && partner.partner_kind !== "VENDOR") {
    return { ok: false, response: partnerFail("PARTNER_FORBIDDEN", 403) };
  }
  return { ok: true, actor: resolved.actor };
}

function checkIdempotencyHeaderMismatch(request: Request, bodyKey: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== bodyKey) {
    return partnerFail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }
  return null;
}

/* ---------- 1. Public/Pre-Auth Activation: POST /api/auth/activate-partner ---------- */

export async function handleActivatePartner(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guard) return guard;

  const body = await readBoundedPartnerJson(request, "PARTNER_ACTIVATION_INVALID");
  if (!body.ok) return body.response;
  if (containsForbiddenPartnerPayloadKey(body.value)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = parseActivatePartnerBody(body.value);
  if (!parsed.ok) return partnerFail(parsed.code, parsed.status);

  const outcome = await activatePartnerAccount(parsed.value, deps);
  if (!outcome.ok) {
    return partnerFail("PARTNER_ACTIVATION_INVALID", 403);
  }

  return partnerOk({
    partner_kind: outcome.partner_kind,
    partner_code: outcome.partner_code,
    account_state: outcome.account_state,
    must_change_password: outcome.must_change_password,
  });
}

/* ---------- 2. Admin Conflict Preflight: GET /api/admin/partners/conflicts ---------- */

export async function handleAdminPartnerConflicts(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "resolveSession" | "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag);
  if (guard) return guard;

  const admin = await resolveAdminPartnerOperator(deps);
  if (!admin.ok) return admin.response;

  const outcome = await deps.repository.preflightConflicts({
    auth_subject: admin.auth_subject,
    app_user_id: admin.app_user_id,
  });
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ report: outcome.data });
}

/* ---------- 3. Admin Provisioning: POST /api/admin/partners/[kind]/[code]/provision ---------- */

export async function handleAdminProvisionPartner(
  request: Request,
  kindParam: string,
  codeParam: string,
  enabledFlag: string | undefined,
  deps: PartnerApiDependencies,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guard) return guard;

  const target = parseAdminPartnerParams(kindParam, codeParam);
  if (!target.ok) return partnerFail(target.code, target.status);

  const body = await readBoundedPartnerJson(request, "PARTNER_INVALID");
  if (!body.ok) return body.response;
  if (containsForbiddenPartnerPayloadKey(body.value)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = parseAdminReasonIdempotencyBody(body.value);
  if (!parsed.ok) return partnerFail(parsed.code, parsed.status);
  const mismatch = checkIdempotencyHeaderMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  if (!deps.auth) return partnerFail("PARTNER_UNAVAILABLE", 503);

  const admin = await resolveAdminPartnerOperator(deps);
  if (!admin.ok) return admin.response;

  const outcome = await provisionPartnerAccount(
    {
      auth_subject: admin.auth_subject,
      actor_app_user_id: admin.app_user_id,
      partner_kind: target.value.partner_kind,
      partner_id: target.value.partner_id,
      reason: parsed.value.reason,
      idempotency_key: parsed.value.idempotency_key,
    },
    {
      repository: deps.repository,
      auth: deps.auth,
      generateActivationCode: deps.generateActivationCode,
      nowMs: deps.nowMs,
      activationTtlMs: deps.activationTtlMs,
    },
  );
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ provision: outcome.provision });
}

/* ---------- 4. Admin Rotate Activation Code: POST .../activation-code ---------- */

export async function handleAdminRotatePartnerActivationCode(
  request: Request,
  kindParam: string,
  codeParam: string,
  enabledFlag: string | undefined,
  deps: PartnerApiDependencies,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guard) return guard;

  const target = parseAdminPartnerParams(kindParam, codeParam);
  if (!target.ok) return partnerFail(target.code, target.status);

  const body = await readBoundedPartnerJson(request, "PARTNER_INVALID");
  if (!body.ok) return body.response;
  if (containsForbiddenPartnerPayloadKey(body.value)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = parseAdminReasonIdempotencyBody(body.value);
  if (!parsed.ok) return partnerFail(parsed.code, parsed.status);
  const mismatch = checkIdempotencyHeaderMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const admin = await resolveAdminPartnerOperator(deps);
  if (!admin.ok) return admin.response;

  const outcome = await rotatePartnerActivationCode(
    {
      auth_subject: admin.auth_subject,
      actor_app_user_id: admin.app_user_id,
      partner_kind: target.value.partner_kind,
      partner_id: target.value.partner_id,
      reason: parsed.value.reason,
      idempotency_key: parsed.value.idempotency_key,
    },
    {
      repository: deps.repository,
      generateActivationCode: deps.generateActivationCode,
      nowMs: deps.nowMs,
      activationTtlMs: deps.activationTtlMs,
    },
  );
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ activation: outcome.activation });
}

/* ---------- 5. Admin Reset Partner Password: POST .../reset-password ---------- */

function normalizeAdminResetPasswordBody(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  const hasNewPair =
    Object.hasOwn(raw, "new_password") && Object.hasOwn(raw, "new_password_confirm");
  const hasLegacyPair =
    Object.hasOwn(raw, "password") && Object.hasOwn(raw, "password_confirm");
  if (hasNewPair === hasLegacyPair) return null;

  if (hasNewPair) {
    const allowed = new Set([
      "new_password",
      "new_password_confirm",
      "reason",
      "idempotency_key",
    ]);
    if (keys.some((k) => !allowed.has(k))) return null;
    const mapped: Record<string, unknown> = {
      password: raw.new_password,
      password_confirm: raw.new_password_confirm,
      idempotency_key: raw.idempotency_key,
    };
    if (Object.hasOwn(raw, "reason")) {
      mapped.reason = raw.reason;
    }
    return mapped;
  }

  return raw;
}

export async function handleAdminResetPartnerPassword(
  request: Request,
  kindParam: string,
  codeParam: string,
  enabledFlag: string | undefined,
  deps: PartnerApiDependencies,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guard) return guard;

  const target = parseAdminPartnerParams(kindParam, codeParam);
  if (!target.ok) return partnerFail(target.code, target.status);

  const body = await readBoundedPartnerJson(request, "PARTNER_INVALID");
  if (!body.ok) return body.response;
  if (containsForbiddenPartnerPayloadKey(body.value)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const normalizedBody = normalizeAdminResetPasswordBody(body.value);
  if (!normalizedBody) {
    return partnerFail("PARTNER_INVALID", 400);
  }

  if (!deps.accountOperations) {
    return partnerFail("PARTNER_UNAVAILABLE", 503);
  }

  const admin = await resolveAdminPartnerOperator(deps);
  if (!admin.ok) return admin.response;

  const partnerLookup = await deps.repository.getPartnerAccountRef({
    auth_subject: admin.auth_subject,
    app_user_id: admin.app_user_id,
    partner_kind: target.value.partner_kind,
    partner_id: target.value.partner_id,
  });
  if (!partnerLookup.ok) {
    return partnerFail(partnerLookup.code);
  }
  if (!partnerLookup.data.app_user_id) {
    return partnerFail("PARTNER_NOT_PROVISIONED", 409);
  }

  const forwardedRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(normalizedBody),
  });

  return resetPassword(
    forwardedRequest,
    partnerLookup.data.app_user_id,
    enabledFlag,
    {
      ...deps.accountOperations,
      resolveSession: async () => admin.session,
    },
  );
}

/* ---------- 6. Partner Self-Service Profile: GET/PATCH /api/partner/profile ---------- */

export async function handleGetPartnerProfile(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "resolveSession" | "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag);
  if (guard) return guard;

  const partner = await resolvePortalPartnerActor(deps, {
    requirePasswordChanged: false,
  });
  if (!partner.ok) return partner.response;

  const outcome = await deps.repository.getProfile({
    auth_subject: partner.actor.auth_subject,
    app_user_id: partner.actor.app_user_id,
  });
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ profile: outcome.data });
}

export async function handlePatchPartnerProfile(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "resolveSession" | "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag, { requireSameOrigin: true });
  if (guard) return guard;

  const body = await readBoundedPartnerJson(request, "PARTNER_INVALID");
  if (!body.ok) return body.response;
  if (containsForbiddenPartnerPayloadKey(body.value)) {
    return partnerFail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }

  const parsed = parsePartnerProfilePatchBody(body.value);
  if (!parsed.ok) return partnerFail(parsed.code, parsed.status);
  const mismatch = checkIdempotencyHeaderMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const partner = await resolvePortalPartnerActor(deps, {
    requirePasswordChanged: true,
  });
  if (!partner.ok) return partner.response;

  const outcome = await deps.repository.updateProfile({
    auth_subject: partner.actor.auth_subject,
    app_user_id: partner.actor.app_user_id,
    display_name: parsed.value.display_name,
    address: parsed.value.address,
    phone: parsed.value.phone,
    expected_version: parsed.value.expected_version,
    idempotency_key: parsed.value.idempotency_key,
  });
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ profile: outcome.data });
}

/* ---------- 7. Vendor Recruitment Summary: GET /api/partner/recruitment/summary ---------- */

export async function handleGetPartnerRecruitmentSummary(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "resolveSession" | "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag);
  if (guard) return guard;

  const url = parseRequestUrl(request);
  if (!url) return partnerFail("PARTNER_INVALID", 400);

  const query = parsePartnerSummaryQuery(url);
  if (!query.ok) return partnerFail(query.code, query.status);

  const partner = await resolvePortalPartnerActor(deps, {
    requirePasswordChanged: true,
    requireVendor: true,
  });
  if (!partner.ok) return partner.response;

  const outcome = await deps.repository.getVendorRecruitmentSummary({
    auth_subject: partner.actor.auth_subject,
    app_user_id: partner.actor.app_user_id,
    date_from: query.value.from_date,
    date_to: query.value.to_date,
    project_id: query.value.project_id,
    group_by: query.value.group_by,
  });
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ summary: outcome.data });
}

/* ---------- 8. Vendor Recruited Workers: GET /api/partner/workers ---------- */

export async function handleGetPartnerWorkers(
  request: Request,
  enabledFlag: string | undefined,
  deps: Pick<PartnerApiDependencies, "resolveSession" | "repository">,
): Promise<Response> {
  const guard = checkGuards(request, enabledFlag);
  if (guard) return guard;

  const url = parseRequestUrl(request);
  if (!url) return partnerFail("PARTNER_INVALID", 400);

  const query = parsePartnerWorkersQuery(url);
  if (!query.ok) return partnerFail(query.code, query.status);

  const partner = await resolvePortalPartnerActor(deps, {
    requirePasswordChanged: true,
    requireVendor: true,
  });
  if (!partner.ok) return partner.response;

  const outcome = await deps.repository.listVendorWorkers({
    auth_subject: partner.actor.auth_subject,
    app_user_id: partner.actor.app_user_id,
    search: query.value.search,
    project_id: query.value.project_id,
    date_from: query.value.from_date,
    date_to: query.value.to_date,
    page: query.value.page,
    page_size: query.value.page_size,
  });
  if (!outcome.ok) return partnerFail(outcome.code);
  return partnerOk({ workers: outcome.data });
}
