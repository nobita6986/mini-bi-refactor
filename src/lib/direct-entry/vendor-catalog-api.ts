/**
 * P3.1-W02-B + Partner Portal - API boundary cho vendor master catalog admin.
 *
 * Pipeline thong nhat (giong team-catalog-api):
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF (mutation)
 *   3. content-type + JSON bounded
 *   4. quet authority de quy (client khong duoc gui actor/role/capability/scope)
 *   5. strict request projection (optional reason/address/phone, OCC, idempotency)
 *   6. resolve session server-side -> actor CHI tu session
 *   7. repository/RPC
 *   8. response sanitized (khong forward raw DB message), no-store
 *
 * Module nay KHONG danh gia quyen va KHONG doc truoc DB: DB guard
 * (direct_entry_assert_catalog_operator tu #68) la authority cuoi.
 * PATCH KHONG bao gio nhan vendor_id hoac active: vendor_id la identity bat bien
 * (nam trong URL) va active co mutation rieng.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "./write-api.ts";
import type { VendorCatalogRepository } from "./vendor-catalog-repository.ts";
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "./action-reason.ts";
import {
  hasRequiredAndOptionalKeys,
  projectOptionalPartnerAddress,
  projectOptionalPartnerPhone,
} from "./vendor-catalog-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_MAX = 4000;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const VENDOR_ID_MAX = 128;
/** Vendor id la business ID: dung chinh xac rang buoc check cua public.vendors (#41). */
const VENDOR_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Reserved Vendor system namespace - khong bao gio la business vendor. */
const RESERVED_VENDOR_ID = "__system_vendor__";

export type VendorCatalogDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: VendorCatalogRepository;
};

export type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasExactKeysWithOptionalReason(value, keys);
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
}
function vendorId(value: unknown): string | null {
  const candidate = text(value, VENDOR_ID_MAX);
  if (candidate === null || !VENDOR_ID.test(candidate) || candidate === RESERVED_VENDOR_ID) {
    return null;
  }
  return candidate;
}
function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}
function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function pageNumber(value: string | null, min: number, max: number): number | null {
  if (value === null) return min === 1 ? 1 : null;
  if (!/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

async function readMutationBody(request: Request): Promise<Parsed<unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("BODY_INVALID", 400) };
  return { ok: true, value: body };
}

/** Client khong duoc gui actor/role/capability/scope o bat ky do sau nao. */
function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("VENDOR_INVALID", 400);
  }
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  dependencies: VendorCatalogDependencies,
): Promise<Parsed<TrustedActor>> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || !uuid(actor.auth_subject) || !uuid(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    // Actor CHI den tu session server-side; khong bao gio lay tu body/header client.
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[vendor-catalog] session unavailable");
    return { ok: false, response: fail("VENDOR_UNAVAILABLE", 500) };
  }
}

/** Taxonomy sanitized: khong bao gio forward raw DB message. */
export function vendorCatalogErrorResponse(kind: string): Response {
  if (kind === "denied") return fail("VENDOR_DENIED", 403);
  if (kind === "not-found") return fail("VENDOR_NOT_FOUND", 404);
  if (kind === "code-conflict") return fail("PARTNER_CODE_CONFLICT", 409);
  if (kind === "conflict") return fail("VENDOR_CONFLICT", 409);
  if (kind === "invalid") return fail("VENDOR_INVALID", 400);
  console.error("[vendor-catalog] unavailable");
  return fail("VENDOR_UNAVAILABLE", 500);
}

/** Read routes chi can feature gate; browser GET khong bat buoc gui Origin. */
function readPreflight(flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  return null;
}

/** Mutation routes bat buoc feature gate + same-origin/CSRF. */
function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const gated = readPreflight(flag);
  if (gated) return gated;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  return null;
}

export type ListVendorsQuery = {
  search: string | null; include_inactive: boolean; page: number; page_size: number;
};
export function vendorCatalogListQuery(url: URL): Parsed<ListVendorsQuery> {
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && rawSearch.length > SEARCH_MAX) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  const search = rawSearch !== null && rawSearch.trim() !== "" ? rawSearch.trim() : null;
  // Chi chap nhan absent | "true" | "false"; gia tri khac la 400.
  const rawIncludeInactive = url.searchParams.get("include_inactive");
  if (rawIncludeInactive !== null && rawIncludeInactive !== "true"
      && rawIncludeInactive !== "false") {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  const include_inactive = rawIncludeInactive !== "false";
  const page = pageNumber(url.searchParams.get("page"), 1, 1000);
  const page_size = pageNumber(url.searchParams.get("page_size"), 1, 100);
  if (page === null || page_size === null) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  return { ok: true, value: { search, include_inactive, page, page_size } };
}

export type CreateVendorRequest = {
  expected_version: 0;
  vendor_id: string;
  display_name: string;
  valid_from: string;
  address: string | null;
  phone: string | null;
  reason: string | null;
  idempotency_key: string;
};
export function vendorCatalogCreateRequest(body: unknown): Parsed<CreateVendorRequest> {
  const value = record(body);
  if (
    !value ||
    !hasRequiredAndOptionalKeys(
      value,
      ["expected_version", "vendor_id", "display_name", "valid_from", "idempotency_key"],
      ["reason", "address", "phone"],
    )
  ) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const vendor_id = vendorId(value.vendor_id);
  const display_name = text(value.display_name, NAME_MAX);
  const valid_from = isoDate(value.valid_from);
  const address = projectOptionalPartnerAddress(value.address);
  const phone = projectOptionalPartnerPhone(value.phone);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  // create mo mot aggregate moi: expected_version phai dung bang 0.
  if (
    expected_version !== 0 ||
    !vendor_id ||
    !display_name ||
    !valid_from ||
    !address.ok ||
    !phone.ok ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  return {
    ok: true,
    value: {
      expected_version: 0,
      vendor_id,
      display_name,
      valid_from,
      address: address.value,
      phone: phone.value,
      reason: reason.value,
      idempotency_key,
    },
  };
}

/** PATCH nhan display_name + optional address/phone: vendor_id la identity bat bien va active co mutation rieng. */
export type UpdateVendorRequest = {
  expected_version: number;
  display_name: string;
  address: string | null;
  phone: string | null;
  reason: string | null;
  idempotency_key: string;
};
export function vendorCatalogUpdateRequest(body: unknown): Parsed<UpdateVendorRequest> {
  const value = record(body);
  if (
    !value ||
    !hasRequiredAndOptionalKeys(
      value,
      ["expected_version", "display_name", "idempotency_key"],
      ["reason", "address", "phone"],
    )
  ) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const display_name = text(value.display_name, NAME_MAX);
  const address = projectOptionalPartnerAddress(value.address);
  const phone = projectOptionalPartnerPhone(value.phone);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (
    expected_version === null ||
    expected_version < 1 ||
    !display_name ||
    !address.ok ||
    !phone.ok ||
    !reason.ok ||
    !idempotency_key
  ) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  return {
    ok: true,
    value: {
      expected_version,
      display_name,
      address: address.value,
      phone: phone.value,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type SetActiveVendorRequest = {
  active: boolean; expected_version: number; reason: string | null; idempotency_key: string;
};
export function vendorCatalogSetActiveRequest(body: unknown): Parsed<SetActiveVendorRequest> {
  const value = record(body);
  if (!value || !exact(value, ["active", "expected_version", "reason", "idempotency_key"]) ||
      typeof value.active !== "boolean") {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  const expected_version = version(value.expected_version);
  const reason = projectOptionalActionReason(value.reason, REASON_MAX);
  const idempotency_key = uuid(value.idempotency_key);
  if (expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, response: fail("VENDOR_INVALID", 400) };
  }
  return { ok: true, value: { active: value.active, expected_version, reason: reason.value, idempotency_key } };
}

async function runMutation<T>(
  request: Request,
  dependencies: VendorCatalogDependencies,
  parsed: Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor) => Promise<{ ok: true; data: T } | { ok: false; kind: string }>,
): Promise<Response> {
  if (!parsed.ok) return parsed.response;
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;

  let result: { ok: true; data: T } | { ok: false; kind: string };
  try {
    result = await run(actor.value);
  } catch {
    console.error("[vendor-catalog] mutation failed");
    return fail("VENDOR_UNAVAILABLE", 500);
  }
  if (!result.ok) return vendorCatalogErrorResponse(result.kind);
  return respond({ ok: true, vendor: result.data }, 200);
}

export async function listVendorsCatalog(
  request: Request, flag: string | undefined, dependencies: VendorCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const query = vendorCatalogListQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.listVendors({ ...actor.value, ...query.value });
    if (!result.ok) return vendorCatalogErrorResponse(result.kind);
    return respond({ ok: true, list: result.data }, 200);
  } catch {
    console.error("[vendor-catalog] list failed");
    return fail("VENDOR_UNAVAILABLE", 500);
  }
}

export async function getVendorCatalog(
  request: Request, vendorIdValue: string, flag: string | undefined,
  dependencies: VendorCatalogDependencies,
): Promise<Response> {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const id = vendorId(vendorIdValue);
  if (!id) return fail("VENDOR_INVALID", 400);
  const actor = await resolveTrustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.getVendor({ ...actor.value, vendor_id: id });
    if (!result.ok) return vendorCatalogErrorResponse(result.kind);
    return respond({ ok: true, vendor: result.data }, 200);
  } catch {
    console.error("[vendor-catalog] detail failed");
    return fail("VENDOR_UNAVAILABLE", 500);
  }
}

async function mutationPipeline(
  request: Request, flag: string | undefined, dependencies: VendorCatalogDependencies,
  parse: (body: unknown) => Parsed<{ reason: string | null; idempotency_key: string }>,
  run: (actor: TrustedActor, value: never) => Promise<{ ok: true; data: unknown } | { ok: false; kind: string }>,
): Promise<Response> {
  const blocked = mutationPreflight(request, flag);
  if (blocked) return blocked;
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.value);
  if (authority) return authority;
  const parsed = parse(body.value);
  if (!parsed.ok) return parsed.response;
  return runMutation(request, dependencies, parsed,
    (actor) => run(actor, parsed.value as never));
}

export function createVendorCatalog(
  request: Request, flag: string | undefined, dependencies: VendorCatalogDependencies,
): Promise<Response> {
  return mutationPipeline(request, flag, dependencies, vendorCatalogCreateRequest,
    (actor, value: CreateVendorRequest) => dependencies.repository.createVendor({ ...actor, ...value }));
}

export function updateVendorCatalog(
  request: Request, vendorIdValue: string, flag: string | undefined,
  dependencies: VendorCatalogDependencies,
): Promise<Response> {
  const id = vendorId(vendorIdValue);
  return mutationPipeline(request, flag, dependencies, vendorCatalogUpdateRequest,
    (actor, value: UpdateVendorRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.updateVendor({ ...actor, vendor_id: id, ...value }));
}

export function setVendorCatalogActive(
  request: Request, vendorIdValue: string, flag: string | undefined,
  dependencies: VendorCatalogDependencies,
): Promise<Response> {
  const id = vendorId(vendorIdValue);
  return mutationPipeline(request, flag, dependencies, vendorCatalogSetActiveRequest,
    (actor, value: SetActiveVendorRequest) => id === null
      ? Promise.resolve({ ok: false as const, kind: "invalid" })
      : dependencies.repository.setVendorActive({ ...actor, vendor_id: id, ...value }));
}
