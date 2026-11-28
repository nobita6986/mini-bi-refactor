/**
 * P3.1-W04-C + Partner Portal - Vendor Catalog UI projection and request helpers.
 * The server/API remains the sole authority; this module validates UI payloads only.
 */
import {
  isPartnerCodeConflictPayload,
  normalizeOptionalPartnerAddressValue,
  normalizeOptionalPartnerPhoneValue,
  PARTNER_CODE_CONFLICT_MESSAGE,
  validatePartnerAddress,
  validatePartnerPhone,
  vendorCatalogCreateResult,
  vendorCatalogItem,
  vendorCatalogList,
  vendorCatalogMutation,
  type AdminVendor,
  type AdminVendorCreateResult,
  type AdminVendorList,
  type AdminVendorMutation,
} from "../direct-entry/vendor-catalog-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

export const VENDOR_LIST_PAGE_SIZE = 25;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const VENDOR_ID_MAX = 128;
const VENDOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RESERVED_VENDOR_ID = "__system_vendor__";

export type VendorListQuery = { search: string; includeInactive: boolean; page: number };
export type VendorMutationOutcome =
  | { kind: "applied"; vendor: AdminVendorCreateResult | AdminVendorMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function projectVendorListForQuery(
  payload: unknown,
  query: VendorListQuery,
): AdminVendorList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = vendorCatalogList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  if (list.page !== query.page || list.page_size !== VENDOR_LIST_PAGE_SIZE ||
      list.include_inactive !== query.includeInactive || list.search !== expectedSearch) {
    return null;
  }
  return list;
}

export function projectVendorItem(payload: unknown): AdminVendor | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "vendor"]) || payload.ok !== true) {
    return null;
  }
  return vendorCatalogItem(payload.vendor);
}

export function projectVendorCreate(payload: unknown): AdminVendorCreateResult | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "vendor"]) || payload.ok !== true) {
    return null;
  }
  return vendorCatalogCreateResult(payload.vendor);
}

export function projectVendorMutation(payload: unknown): AdminVendorMutation | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "vendor"]) || payload.ok !== true) {
    return null;
  }
  return vendorCatalogMutation(payload.vendor);
}

export function buildVendorListQuery(input: VendorListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > SEARCH_MAX || !Number.isSafeInteger(input.page) ||
      input.page < 1 || input.page > 1000) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(VENDOR_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

function validateVendorId(value: string): string | null {
  const vendorId = value.trim();
  if (!vendorId) return "Mã nhà cung cấp là bắt buộc.";
  if (vendorId.length > VENDOR_ID_MAX || !VENDOR_ID_PATTERN.test(vendorId) ||
      vendorId === RESERVED_VENDOR_ID) {
    return "Mã nhà cung cấp không hợp lệ.";
  }
  return null;
}

function validateDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên nhà cung cấp là bắt buộc.";
  if (name.length > NAME_MAX) return "Tên nhà cung cấp tối đa 256 ký tự.";
  return null;
}

function validateISODate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "Ngày hiệu lực không hợp lệ.";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) {
    return "Ngày hiệu lực không hợp lệ.";
  }
  return null;
}

export function buildVendorCreateRequest(input: {
  vendorId: string;
  displayName: string;
  effectiveDate: string;
  address?: string | null;
  phone?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateVendorId(input.vendorId) ?? validateDisplayName(input.displayName)
    ?? validateISODate(input.effectiveDate)
    ?? validatePartnerAddress(input.address)
    ?? validatePartnerPhone(input.phone)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  const body: Record<string, unknown> = {
    expected_version: 0,
    vendor_id: input.vendorId.trim(),
    display_name: input.displayName.trim(),
    valid_from: input.effectiveDate,
    reason: normalizeOptionalActionReason(input.reason),
    idempotency_key: input.idempotencyKey,
  };
  if (input.address !== undefined) {
    body.address = normalizeOptionalPartnerAddressValue(input.address);
  }
  if (input.phone !== undefined) {
    body.phone = normalizeOptionalPartnerPhoneValue(input.phone);
  }
  return { ok: true, body };
}

export function buildVendorUpdateRequest(input: {
  displayName: string;
  expectedVersion: number;
  address?: string | null;
  phone?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateDisplayName(input.displayName)
    ?? validateVersion(input.expectedVersion)
    ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validatePartnerAddress(input.address)
    ?? validatePartnerPhone(input.phone)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  const body: Record<string, unknown> = {
    expected_version: input.expectedVersion,
    display_name: input.displayName.trim(),
    reason: normalizeOptionalActionReason(input.reason),
    idempotency_key: input.idempotencyKey,
  };
  if (input.address !== undefined) {
    body.address = normalizeOptionalPartnerAddressValue(input.address);
  }
  if (input.phone !== undefined) {
    body.phone = normalizeOptionalPartnerPhoneValue(input.phone);
  }
  return { ok: true, body };
}

export function buildVendorSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = typeof input.active !== "boolean"
    ? "Trạng thái không hợp lệ."
    : validateVersion(input.expectedVersion)
      ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
      ?? validateReason(input.reason)
      ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      active: input.active,
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyVendorMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): VendorMutationOutcome {
  if (status === 200) {
    const vendor = operation === "create" ? projectVendorCreate(payload) : projectVendorMutation(payload);
    return vendor
      ? { kind: "applied", vendor }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Nhà cung cấp không còn khả dụng." };
  if (status === 409) {
    if (isPartnerCodeConflictPayload(payload, ["VENDOR_CODE_CONFLICT"])) {
      return { kind: "conflict", message: PARTNER_CODE_CONFLICT_MESSAGE };
    }
    return { kind: "conflict", message: "Nhà cung cấp đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  }
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newVendorIntentKey(): string {
  return newIdempotencyKey();
}

export function vendorListConfirmsId(list: AdminVendorList, vendorId: string): boolean {
  return list.vendors.some((vendor) => vendor.vendor_id === vendorId);
}
