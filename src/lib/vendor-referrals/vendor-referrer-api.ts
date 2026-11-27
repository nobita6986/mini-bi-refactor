/**
 * API boundary for BoD-only Vendor Referrer Attribution & Monthly Report.
 *
 * Security invariants:
 *  - Feature-gated via `DIRECT_ENTRY_API_ENABLED === "true"` -> `404` otherwise.
 *  - Mutation routes enforce same-origin CSRF (`checkSameOriginRequest`), `application/json`,
 *    and bounded JSON body parsing (`readBoundedJson`).
 *  - Rejects client-supplied authority fields (`validateClientBusinessPayload` + disallowed headers)
 *    and any money/commission/fee fields.
 *  - Actor identity comes strictly from `resolveSession` (never request body/headers).
 *  - Idempotency key supports `Idempotency-Key` and optional `X-Idempotency-Key` with strict
 *    header/body equality validation.
 *  - All responses carry `Cache-Control: private, no-store` and sanitized error codes
 *    (`400`/`401`/`403`/`404`/`409`/`503`).
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import {
  VENDOR_REFERRER_DEFAULT_CANDIDATE_LIMIT,
  VENDOR_REFERRER_DEFAULT_PAGE_SIZE,
  VENDOR_REFERRER_SEARCH_MAX,
  containsForbiddenCompensationField,
  hasSingleLineControlChars,
  isRecord,
  isValidCalendarMonthOrAll,
  isValidIdempotencyKey,
  isValidProjectId,
  isValidUuid,
  isValidVendorId,
  parseRequiredReason,
  type VendorReferrerErrorKind,
} from "./vendor-referrer-contract.ts";
import type { VendorReferrerRepository } from "./vendor-referrer-repository.ts";

export type VendorReferrerDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: VendorReferrerRepository;
};

export type TrustedActor = {
  auth_subject: string;
  app_user_id: string;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
  "x-department-id",
  "x-department-key",
] as const;

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function parseUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

function hasDisallowedHeaders(request: Request): boolean {
  return DISALLOWED_AUTHORITY_HEADERS.some((name) => request.headers.get(name) !== null);
}

function readPreflight(request: Request, flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (hasDisallowedHeaders(request)) return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  return null;
}

function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const blocked = readPreflight(request, flag);
  if (blocked) return blocked;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  return null;
}

function validateQueryKeys(
  url: URL,
  allowedKeys: readonly string[],
): Response | null {
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return fail("VENDOR_REFERRER_INVALID", 400);
    if (url.searchParams.getAll(key).length > 1) return fail("VENDOR_REFERRER_INVALID", 400);
  }
  return null;
}

function parseIntParam(
  raw: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return defaultValue;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

async function resolveTrustedActor(
  dependencies: VendorReferrerDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response:
          session.actor.reason === "UNAUTHENTICATED"
            ? fail("UNAUTHENTICATED", 401)
            : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !isValidUuid(actor.auth_subject) || !isValidUuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return {
      ok: true,
      value: {
        auth_subject: actor.auth_subject.toLowerCase(),
        app_user_id: actor.app_user_id.toLowerCase(),
      },
    };
  } catch {
    console.error("[vendor-referrals] session unavailable");
    return { ok: false, response: fail("VENDOR_REFERRER_UNAVAILABLE", 503) };
  }
}

export function vendorReferrerErrorResponse(kind: VendorReferrerErrorKind): Response {
  switch (kind) {
    case "denied":
      return fail("VENDOR_REFERRER_DENIED", 403);
    case "not-found":
      return fail("VENDOR_REFERRER_NOT_FOUND", 404);
    case "conflict":
      return fail("VENDOR_REFERRER_CONFLICT", 409);
    case "invalid":
      return fail("VENDOR_REFERRER_INVALID", 400);
    case "unavailable":
      console.error("[vendor-referrals] unavailable");
      return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

async function readMutationBody(request: Request): Promise<Parsed<Record<string, unknown>>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (!isRecord(body)) {
    return { ok: false, response: fail("BODY_INVALID", 400) };
  }
  try {
    if (!validateClientBusinessPayload(body).ok || containsForbiddenCompensationField(body)) {
      return { ok: false, response: fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400) };
    }
  } catch {
    return { ok: false, response: fail("VENDOR_REFERRER_INVALID", 400) };
  }
  return { ok: true, value: body };
}

function resolveMutationIdempotencyKey(
  request: Request,
  bodyKey: unknown,
): Parsed<string> {
  const stdHeader = request.headers.get("idempotency-key");
  const xHeader = request.headers.get("x-idempotency-key");

  if (stdHeader !== null && xHeader !== null && stdHeader.trim() !== xHeader.trim()) {
    return { ok: false, response: fail("IDEMPOTENCY_KEY_MISMATCH", 400) };
  }

  const headerRaw = stdHeader ?? xHeader;
  const headerKey = headerRaw !== null ? headerRaw.trim() : null;
  if (headerKey !== null && !isValidIdempotencyKey(headerKey)) {
    return { ok: false, response: fail("IDEMPOTENCY_KEY_INVALID", 400) };
  }

  if (bodyKey !== undefined) {
    if (typeof bodyKey !== "string" || !isValidIdempotencyKey(bodyKey.trim())) {
      return { ok: false, response: fail("IDEMPOTENCY_KEY_INVALID", 400) };
    }
    const normalizedBody = bodyKey.trim();
    if (headerKey !== null && headerKey !== normalizedBody) {
      return { ok: false, response: fail("IDEMPOTENCY_KEY_MISMATCH", 400) };
    }
    return { ok: true, value: normalizedBody };
  }

  if (headerKey !== null) {
    return { ok: true, value: headerKey };
  }

  return { ok: false, response: fail("IDEMPOTENCY_KEY_INVALID", 400) };
}

function parseOptionalEffectiveDate(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !isRealCalendarDate(value)) {
    return { ok: false, response: fail("VENDOR_REFERRER_INVALID", 400) };
  }
  return { ok: true, value };
}

function parseOptionalExpectedLinkId(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isValidUuid(value)) {
    return { ok: false, response: fail("VENDOR_REFERRER_INVALID", 400) };
  }
  return { ok: true, value: value.toLowerCase() };
}

export async function listVendorReferrerVendors(
  request: Request,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = readPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, ["search", "include_inactive", "page", "page_size"]);
  if (badKeys) return badKeys;

  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null) {
    if (
      hasSingleLineControlChars(rawSearch) ||
      rawSearch.trim().length > VENDOR_REFERRER_SEARCH_MAX
    ) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;

  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (
    rawIncludeInactive !== null &&
    rawIncludeInactive !== "true" &&
    rawIncludeInactive !== "false"
  ) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }
  const include_inactive = rawIncludeInactive === "true";

  const page = parseIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const page_size = parseIntParam(
    url.searchParams.get("page_size"),
    VENDOR_REFERRER_DEFAULT_PAGE_SIZE,
    1,
    100,
  );
  if (page === null || page_size === null) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.listVendors({
      ...actor.value,
      search,
      include_inactive,
      page,
      page_size,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] listVendors failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

export async function listVendorReferrerCandidates(
  request: Request,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = readPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, ["search", "limit"]);
  if (badKeys) return badKeys;

  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null) {
    if (
      hasSingleLineControlChars(rawSearch) ||
      rawSearch.trim().length > VENDOR_REFERRER_SEARCH_MAX
    ) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;

  const limit = parseIntParam(
    url.searchParams.get("limit"),
    VENDOR_REFERRER_DEFAULT_CANDIDATE_LIMIT,
    1,
    500,
  );
  if (limit === null) return fail("VENDOR_REFERRER_INVALID", 400);

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.listCandidates({
      ...actor.value,
      search,
      limit,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] listCandidates failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

export async function getVendorReferrerHistory(
  request: Request,
  vendorIdValue: string,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = readPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, []);
  if (badKeys) return badKeys;

  const vendorId = vendorIdValue.trim();
  if (!isValidVendorId(vendorId)) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.getHistory({
      ...actor.value,
      vendor_id: vendorId,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] getHistory failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

export async function assignVendorReferrer(
  request: Request,
  vendorIdValue: string,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, []);
  if (badKeys) return badKeys;

  const vendorId = vendorIdValue.trim();
  if (!isValidVendorId(vendorId)) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;

  const allowedKeys = new Set([
    "referrer_person_id",
    "effective_date",
    "expected_current_link_id",
    "reason",
    "idempotency_key",
  ]);
  if (Object.keys(body.value).some((key) => !allowedKeys.has(key))) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  if (!isValidUuid(body.value.referrer_person_id)) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }
  const referrerPersonId = body.value.referrer_person_id.toLowerCase();

  const effectiveDate = parseOptionalEffectiveDate(body.value.effective_date);
  if (!effectiveDate.ok) return effectiveDate.response;

  const expectedCurrentLinkId = parseOptionalExpectedLinkId(body.value.expected_current_link_id);
  if (!expectedCurrentLinkId.ok) return expectedCurrentLinkId.response;

  const reason = parseRequiredReason(body.value.reason);
  if (reason === null) return fail("VENDOR_REFERRER_INVALID", 400);

  const idempotencyKey = resolveMutationIdempotencyKey(request, body.value.idempotency_key);
  if (!idempotencyKey.ok) return idempotencyKey.response;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.assignReferrer({
      ...actor.value,
      vendor_id: vendorId,
      referrer_person_id: referrerPersonId,
      effective_date: effectiveDate.value,
      expected_current_link_id: expectedCurrentLinkId.value,
      reason,
      idempotency_key: idempotencyKey.value,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] assignReferrer failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

export async function revokeVendorReferrer(
  request: Request,
  vendorIdValue: string,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, []);
  if (badKeys) return badKeys;

  const vendorId = vendorIdValue.trim();
  if (!isValidVendorId(vendorId)) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;

  const allowedKeys = new Set([
    "effective_date",
    "expected_current_link_id",
    "reason",
    "idempotency_key",
  ]);
  if (Object.keys(body.value).some((key) => !allowedKeys.has(key))) {
    return fail("VENDOR_REFERRER_INVALID", 400);
  }

  const effectiveDate = parseOptionalEffectiveDate(body.value.effective_date);
  if (!effectiveDate.ok) return effectiveDate.response;

  const expectedCurrentLinkId = parseOptionalExpectedLinkId(body.value.expected_current_link_id);
  if (!expectedCurrentLinkId.ok) return expectedCurrentLinkId.response;

  const reason = parseRequiredReason(body.value.reason);
  if (reason === null) return fail("VENDOR_REFERRER_INVALID", 400);

  const idempotencyKey = resolveMutationIdempotencyKey(request, body.value.idempotency_key);
  if (!idempotencyKey.ok) return idempotencyKey.response;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.revokeReferrer({
      ...actor.value,
      vendor_id: vendorId,
      effective_date: effectiveDate.value,
      expected_current_link_id: expectedCurrentLinkId.value,
      reason,
      idempotency_key: idempotencyKey.value,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] revokeReferrer failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}

export async function getVendorReferrerMonthlyReport(
  request: Request,
  flag: string | undefined,
  dependencies: VendorReferrerDependencies,
): Promise<Response> {
  const blocked = readPreflight(request, flag);
  if (blocked) return blocked;

  const url = parseUrl(request);
  if (!url) return fail("VENDOR_REFERRER_INVALID", 400);
  const badKeys = validateQueryKeys(url, [
    "month",
    "referrer_person_id",
    "vendor_id",
    "project_id",
  ]);
  if (badKeys) return badKeys;

  const rawMonth = url.searchParams.get("month");
  let month: string | null = null;
  if (rawMonth !== null && rawMonth.trim() !== "") {
    const trimmed = rawMonth.trim();
    if (!isValidCalendarMonthOrAll(trimmed)) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
    month = trimmed;
  }

  const rawReferrer = url.searchParams.get("referrer_person_id");
  let referrer_person_id: string | null = null;
  if (rawReferrer !== null && rawReferrer.trim() !== "") {
    const trimmed = rawReferrer.trim();
    if (!isValidUuid(trimmed)) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
    referrer_person_id = trimmed.toLowerCase();
  }

  const rawVendor = url.searchParams.get("vendor_id");
  let vendor_id: string | null = null;
  if (rawVendor !== null && rawVendor.trim() !== "") {
    const trimmed = rawVendor.trim();
    if (!isValidVendorId(trimmed)) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
    vendor_id = trimmed;
  }

  const rawProject = url.searchParams.get("project_id");
  let project_id: string | null = null;
  if (rawProject !== null && rawProject.trim() !== "") {
    const trimmed = rawProject.trim();
    if (!isValidProjectId(trimmed)) {
      return fail("VENDOR_REFERRER_INVALID", 400);
    }
    project_id = trimmed;
  }

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  try {
    const result = await dependencies.repository.getMonthlyReport({
      ...actor.value,
      month,
      referrer_person_id,
      vendor_id,
      project_id,
    });
    if (!result.ok) return vendorReferrerErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    console.error("[vendor-referrals] getMonthlyReport failed");
    return fail("VENDOR_REFERRER_UNAVAILABLE", 503);
  }
}
