/**
 * P3.1-W02-B + Partner Portal - Strict projections va shared partner catalog primitives.
 *
 * Payload dung chinh xac theo migration 20261128190000_partner_accounts_and_vendor_portal.sql:
 * - list/get vendor tra 9 key: vendor_id, display_name, address, phone, active, version,
 *   revision_count, recruiter_id, partner_account;
 * - update/set-active vendor tra 9 key (revision_id thay cho revision_count);
 * - create vendor tra them created: true (10 key);
 * - partner_account summary la null hoac object dung 15 key.
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu hoac
 * gia tri khong hop le => null. KHONG bao gio chua capability/scope grant,
 * auth_subject, email, activation_code_hash hay raw reason.
 */

export const PARTNER_ADDRESS_MAX = 500;
export const PARTNER_PHONE_MIN = 6;
export const PARTNER_PHONE_MAX = 32;
export const PARTNER_PHONE_PATTERN = /^[0-9 +().-]+$/;
// Control chars matching PostgreSQL regex `[\x00-\x1f\x7f]`
export const PARTNER_ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export const PARTNER_ACCOUNT_STATES = [
  "UNPROVISIONED",
  "PENDING_ACTIVATION",
  "ACTIVE_MUST_CHANGE_PASSWORD",
  "ACTIVE",
  "SUSPENDED",
] as const;

export type PartnerKind = "VENDOR" | "COLLABORATOR";
export type PartnerAccountState = (typeof PARTNER_ACCOUNT_STATES)[number];

export type PartnerAccountSummary = {
  partner_account_id: string;
  partner_kind: PartnerKind;
  vendor_id: string | null;
  collaborator_id: string | null;
  partner_id: string;
  canonical_code: string;
  account_state: PartnerAccountState;
  app_user_id: string | null;
  username: string | null;
  activated_at: string | null;
  must_change_password: boolean;
  password_changed_at: string | null;
  activation_expires_at: string | null;
  activation_attempts: number;
  version: number;
};

export type AdminVendor = {
  vendor_id: string;
  display_name: string;
  address: string | null;
  phone: string | null;
  active: boolean;
  version: number;
  revision_count: number;
  recruiter_id: string | null;
  partner_account: PartnerAccountSummary | null;
};

export type AdminVendorList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  vendors: readonly AdminVendor[];
};

/** update + set_active (9 key). */
export type AdminVendorMutation = {
  vendor_id: string;
  display_name: string;
  address: string | null;
  phone: string | null;
  active: boolean;
  version: number;
  revision_id: string;
  recruiter_id: string | null;
  partner_account: PartnerAccountSummary | null;
};

/** create tra them created: true (10 key). */
export type AdminVendorCreateResult = AdminVendorMutation & { created: true };

export type OptionalPartnerField = { ok: true; value: string | null } | { ok: false };

export type PartnerCatalogErrorKind =
  | "conflict"
  | "code-conflict"
  | "denied"
  | "invalid"
  | "not-found"
  | "unavailable";

export const PARTNER_CODE_CONFLICT_MESSAGE =
  "Mã đối tác đã tồn tại trong danh mục Nhà cung cấp hoặc Cộng tác viên (không phân biệt chữ hoa/thường). Vui lòng dùng mã khác.";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (str(value) ?? undefined);
}

export function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isValidAddressText(trimmed: string): boolean {
  return (
    trimmed.length >= 1 &&
    trimmed.length <= PARTNER_ADDRESS_MAX &&
    !PARTNER_ADDRESS_CONTROL_CHAR_PATTERN.test(trimmed)
  );
}

function isValidPhoneText(trimmed: string): boolean {
  return (
    trimmed.length >= PARTNER_PHONE_MIN &&
    trimmed.length <= PARTNER_PHONE_MAX &&
    PARTNER_PHONE_PATTERN.test(trimmed)
  );
}

export function projectOptionalPartnerAddress(value: unknown): OptionalPartnerField {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  return isValidAddressText(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

export function projectOptionalPartnerPhone(value: unknown): OptionalPartnerField {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  return isValidPhoneText(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

export function validatePartnerAddress(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "Địa chỉ không hợp lệ.";
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > PARTNER_ADDRESS_MAX) return "Địa chỉ tối đa 500 ký tự.";
  if (PARTNER_ADDRESS_CONTROL_CHAR_PATTERN.test(trimmed)) {
    return "Địa chỉ không được chứa ký tự điều khiển.";
  }
  return null;
}

export function validatePartnerPhone(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "Số điện thoại không hợp lệ.";
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length < PARTNER_PHONE_MIN || trimmed.length > PARTNER_PHONE_MAX) {
    return "Số điện thoại phải từ 6 đến 32 ký tự.";
  }
  if (!PARTNER_PHONE_PATTERN.test(trimmed)) {
    return "Số điện thoại chỉ được gồm chữ số, khoảng trắng và ký tự + - . ( ).";
  }
  return null;
}

export function normalizeOptionalPartnerAddressValue(value: string | null | undefined): string | null {
  const projected = projectOptionalPartnerAddress(value);
  return projected.ok ? projected.value : null;
}

export function normalizeOptionalPartnerPhoneValue(value: string | null | undefined): string | null {
  const projected = projectOptionalPartnerPhone(value);
  return projected.ok ? projected.value : null;
}

export function projectedNullableAddress(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim() || !isValidAddressText(value)) {
    return undefined;
  }
  return value;
}

export function projectedNullablePhone(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim() || !isValidPhoneText(value)) {
    return undefined;
  }
  return value;
}

const PARTNER_ACCOUNT_SUMMARY_KEYS = [
  "partner_account_id",
  "partner_kind",
  "vendor_id",
  "collaborator_id",
  "partner_id",
  "canonical_code",
  "account_state",
  "app_user_id",
  "username",
  "activated_at",
  "must_change_password",
  "password_changed_at",
  "activation_expires_at",
  "activation_attempts",
  "version",
] as const;

const PARTNER_ACCOUNT_STATE_SET = new Set<string>(PARTNER_ACCOUNT_STATES);

/** Fail-closed projection of `partner__internal_account_summary_by_partner` (15 keys). */
export function partnerAccountSummary(
  value: unknown,
  expectedKind?: PartnerKind,
  expectedPartnerId?: string,
): PartnerAccountSummary | null {
  if (!isRecord(value) || !exactKeys(value, PARTNER_ACCOUNT_SUMMARY_KEYS)) return null;
  const partner_account_id = str(value.partner_account_id);
  const partner_kind =
    value.partner_kind === "VENDOR" || value.partner_kind === "COLLABORATOR"
      ? value.partner_kind
      : null;
  const vendor_id = nullableStr(value.vendor_id);
  const collaborator_id = nullableStr(value.collaborator_id);
  const partner_id = str(value.partner_id);
  const canonical_code = str(value.canonical_code);
  const account_state =
    typeof value.account_state === "string" && PARTNER_ACCOUNT_STATE_SET.has(value.account_state)
      ? (value.account_state as PartnerAccountState)
      : null;
  const app_user_id = nullableStr(value.app_user_id);
  const username = nullableStr(value.username);
  const activated_at = nullableStr(value.activated_at);
  const must_change_password = bool(value.must_change_password);
  const password_changed_at = nullableStr(value.password_changed_at);
  const activation_expires_at = nullableStr(value.activation_expires_at);
  const activation_attempts = int(value.activation_attempts);
  const version = int(value.version);

  if (
    partner_account_id === null ||
    partner_kind === null ||
    vendor_id === undefined ||
    collaborator_id === undefined ||
    partner_id === null ||
    canonical_code === null ||
    account_state === null ||
    app_user_id === undefined ||
    username === undefined ||
    activated_at === undefined ||
    must_change_password === null ||
    password_changed_at === undefined ||
    activation_expires_at === undefined ||
    activation_attempts === null ||
    version === null ||
    version < 1
  ) {
    return null;
  }

  if (partner_kind === "VENDOR") {
    if (vendor_id === null || collaborator_id !== null || partner_id !== vendor_id) return null;
  } else if (collaborator_id === null || vendor_id !== null || partner_id !== collaborator_id) {
    return null;
  }

  if (expectedKind !== undefined && partner_kind !== expectedKind) return null;
  if (expectedPartnerId !== undefined && partner_id !== expectedPartnerId) return null;

  return {
    partner_account_id,
    partner_kind,
    vendor_id,
    collaborator_id,
    partner_id,
    canonical_code,
    account_state,
    app_user_id,
    username,
    activated_at,
    must_change_password,
    password_changed_at,
    activation_expires_at,
    activation_attempts,
    version,
  };
}

export function nullablePartnerAccountSummary(
  value: unknown,
  expectedKind?: PartnerKind,
  expectedPartnerId?: string,
): PartnerAccountSummary | null | undefined {
  if (value === null) return null;
  const parsed = partnerAccountSummary(value, expectedKind, expectedPartnerId);
  return parsed ?? undefined;
}

/**
 * Map PostgreSQL SQLSTATE codes to sanitized partner catalog error kinds.
 * Distinguishes PARTNER_CODE_CONFLICT (PT409 PARTNER_CODE_CONFLICT or 23505) from
 * OCC version / idempotency conflicts. Unrecognized codes fail closed as `unavailable`.
 */
export function classifyPartnerCatalogError(error: {
  code?: string;
  message?: string;
}): PartnerCatalogErrorKind {
  if (error.code === "23505") return "code-conflict";
  if (error.code === "PT409") {
    return error.message?.includes("PARTNER_CODE_CONFLICT") ? "code-conflict" : "conflict";
  }
  if (error.code === "40001") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

export function isPartnerCodeConflictPayload(
  payload: unknown,
  extraCodes: readonly string[] = [],
): boolean {
  if (!isRecord(payload) || typeof payload.code !== "string") return false;
  return payload.code === "PARTNER_CODE_CONFLICT" || extraCodes.includes(payload.code);
}

const ITEM_KEYS = [
  "vendor_id",
  "display_name",
  "address",
  "phone",
  "active",
  "version",
  "revision_count",
  "recruiter_id",
  "partner_account",
] as const;
const LIST_KEYS = [
  "authorization_date",
  "include_inactive",
  "search",
  "page",
  "page_size",
  "total",
  "vendors",
] as const;
const MUTATION_KEYS = [
  "vendor_id",
  "display_name",
  "address",
  "phone",
  "active",
  "version",
  "revision_id",
  "recruiter_id",
  "partner_account",
] as const;
const CREATE_KEYS = [...MUTATION_KEYS, "created"] as const;

/** Vendor row 9 key (list item + get). */
export function vendorCatalogItem(value: unknown): AdminVendor | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const vendor_id = str(value.vendor_id);
  const display_name = str(value.display_name);
  const address = projectedNullableAddress(value.address);
  const phone = projectedNullablePhone(value.phone);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_count = int(value.revision_count);
  const recruiter_id = nullableStr(value.recruiter_id);
  const partner_account =
    vendor_id === null
      ? undefined
      : nullablePartnerAccountSummary(value.partner_account, "VENDOR", vendor_id);
  if (
    vendor_id === null ||
    display_name === null ||
    address === undefined ||
    phone === undefined ||
    active === null ||
    version === null ||
    revision_count === null ||
    recruiter_id === undefined ||
    partner_account === undefined
  ) {
    return null;
  }
  return {
    vendor_id,
    display_name,
    address,
    phone,
    active,
    version,
    revision_count,
    recruiter_id,
    partner_account,
  };
}

export function vendorCatalogList(value: unknown): AdminVendorList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  const search = nullableStr(value.search);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (
    authorization_date === null ||
    include_inactive === null ||
    search === undefined ||
    page === null ||
    page_size === null ||
    total === null ||
    !Array.isArray(value.vendors)
  ) {
    return null;
  }
  const vendors: AdminVendor[] = [];
  for (const item of value.vendors) {
    const row = vendorCatalogItem(item);
    if (!row) return null;
    vendors.push(row);
  }
  if (total < vendors.length) return null;
  return { authorization_date, include_inactive, search, page, page_size, total, vendors };
}

function mutationFields(value: Record<string, unknown>): AdminVendorMutation | null {
  const vendor_id = str(value.vendor_id);
  const display_name = str(value.display_name);
  const address = projectedNullableAddress(value.address);
  const phone = projectedNullablePhone(value.phone);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  const recruiter_id = nullableStr(value.recruiter_id);
  const partner_account =
    vendor_id === null
      ? undefined
      : nullablePartnerAccountSummary(value.partner_account, "VENDOR", vendor_id);
  if (
    vendor_id === null ||
    display_name === null ||
    address === undefined ||
    phone === undefined ||
    active === null ||
    version === null ||
    revision_id === null ||
    recruiter_id === undefined ||
    partner_account === undefined
  ) {
    return null;
  }
  return {
    vendor_id,
    display_name,
    address,
    phone,
    active,
    version,
    revision_id,
    recruiter_id,
    partner_account,
  };
}

/** update/set_active (9 key). */
export function vendorCatalogMutation(value: unknown): AdminVendorMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  return mutationFields(value);
}

/** create (10 key, created phai dung bang true). */
export function vendorCatalogCreateResult(value: unknown): AdminVendorCreateResult | null {
  if (!isRecord(value) || !exactKeys(value, CREATE_KEYS)) return null;
  const base = mutationFields(value);
  if (!base || value.created !== true) return null;
  return { ...base, created: true };
}
