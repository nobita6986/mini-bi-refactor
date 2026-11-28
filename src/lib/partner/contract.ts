import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  validateClientBusinessPayload,
  type PartnerAccountState,
  type PartnerKind,
} from "../auth/direct-entry-v2.ts";
import {
  hasExactKeysWithOptionalReason,
  projectOptionalActionReason,
} from "../direct-entry/action-reason.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";

export const PARTNER_KINDS = ["VENDOR", "COLLABORATOR"] as const;
export const PARTNER_GROUP_BY_VALUES = ["month", "day"] as const;

export const PARTNER_MAX_BODY_BYTES = 16 * 1024;
export const PARTNER_CODE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const PARTNER_LOGIN_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PARTNER_PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const PARTNER_PHONE_PATTERN = /^[0-9 +().-]+$/;
export const PARTNER_RESERVED_CODE = "__system_vendor__";

export const PARTNER_DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
  "x-authority-source",
  "x-department-id",
  "x-department-key",
  "x-vendor-id",
  "x-collaborator-id",
  "x-partner-id",
  "x-partner-kind",
] as const;

const FORBIDDEN_PARTNER_OVERRIDE_KEYS = new Set([
  "vendorid",
  "collaboratorid",
  "partnerid",
  "partneraccountid",
  "partnerkind",
  "accountstate",
  "mustchangepassword",
  "activatedat",
  "enabled",
  "active",
]);

const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export type PartnerGroupBy = (typeof PARTNER_GROUP_BY_VALUES)[number];

export type PartnerErrorCode =
  | "NOT_FOUND"
  | "CSRF_REJECTED"
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "ACCOUNT_PENDING_ACTIVATION"
  | "PARTNER_ACTIVATION_INVALID"
  | "PASSWORD_CHANGE_REQUIRED"
  | "PARTNER_FORBIDDEN"
  | "PARTNER_INVALID"
  | "PARTNER_NOT_FOUND"
  | "PARTNER_CONFLICT"
  | "PARTNER_CODE_CONFLICT"
  | "PARTNER_PARENT_INACTIVE"
  | "PARTNER_ALREADY_PROVISIONED"
  | "PARTNER_ALREADY_ACTIVATED"
  | "PARTNER_NOT_PROVISIONED"
  | "PARTNER_PROVISION_INDETERMINATE"
  | "VERSION_CONFLICT"
  | "PARTNER_UNAVAILABLE";

export function partnerHttpStatusForError(code: PartnerErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
    case "PARTNER_NOT_FOUND":
      return 404;
    case "UNAUTHENTICATED":
      return 401;
    case "CSRF_REJECTED":
    case "ACTOR_NOT_AVAILABLE":
    case "ACCOUNT_PENDING_ACTIVATION":
    case "PARTNER_ACTIVATION_INVALID":
    case "PASSWORD_CHANGE_REQUIRED":
    case "PARTNER_FORBIDDEN":
      return 403;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "PARTNER_INVALID":
      return 400;
    case "PARTNER_CONFLICT":
    case "PARTNER_CODE_CONFLICT":
    case "PARTNER_PARENT_INACTIVE":
    case "PARTNER_ALREADY_PROVISIONED":
    case "PARTNER_ALREADY_ACTIVATED":
    case "PARTNER_NOT_PROVISIONED":
    case "PARTNER_PROVISION_INDETERMINATE":
    case "VERSION_CONFLICT":
      return 409;
    case "PARTNER_UNAVAILABLE":
    default:
      return 503;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function containsForbiddenPartnerPayloadKey(value: unknown): boolean {
  if (!validateClientBusinessPayload(value).ok) {
    return true;
  }
  const seen = new Set<object>();
  const visit = (current: unknown): boolean => {
    if (Array.isArray(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      return current.some((item) => visit(item));
    }
    if (!isRecord(current)) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      if (FORBIDDEN_PARTNER_OVERRIDE_KEYS.has(normalized)) {
        return true;
      }
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PartnerErrorCode; status?: number };

export function parseAdminPartnerParams(
  kindParam: string,
  codeParam: string,
): ParseResult<{ partner_kind: PartnerKind; partner_id: string }> {
  const normalizedKind = kindParam.trim().toUpperCase();
  let partner_kind: PartnerKind | null = null;
  if (normalizedKind === "VENDOR") partner_kind = "VENDOR";
  else if (normalizedKind === "COLLABORATOR") partner_kind = "COLLABORATOR";
  if (!partner_kind) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  const partner_id = codeParam.trim();
  if (
    !PARTNER_CODE_PATTERN.test(partner_id) ||
    partner_id === PARTNER_RESERVED_CODE
  ) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  return { ok: true, value: { partner_kind, partner_id } };
}

function parseIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128 || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export type AdminReasonIdempotencyInput = {
  reason: string | null;
  idempotency_key: string;
};

export function parseAdminReasonIdempotencyBody(
  body: unknown,
): ParseResult<AdminReasonIdempotencyInput> {
  if (
    !isRecord(body) ||
    !hasExactKeysWithOptionalReason(body, ["reason", "idempotency_key"])
  ) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  const reason = projectOptionalActionReason(body.reason, 4000);
  const idempotency_key = parseIdempotencyKey(body.idempotency_key);
  if (!reason.ok || !idempotency_key) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  return { ok: true, value: { reason: reason.value, idempotency_key } };
}

export type ActivatePartnerInput = {
  code: string;
  activation_code: string;
};

export function parseActivatePartnerBody(body: unknown): ParseResult<ActivatePartnerInput> {
  if (!isRecord(body)) {
    return { ok: false, code: "PARTNER_ACTIVATION_INVALID", status: 400 };
  }
  const keys = Object.keys(body);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(body, "code") ||
    !Object.hasOwn(body, "activation_code") ||
    typeof body.code !== "string" ||
    typeof body.activation_code !== "string"
  ) {
    return { ok: false, code: "PARTNER_ACTIVATION_INVALID", status: 400 };
  }
  const code = body.code.trim().toLowerCase();
  const activation_code = body.activation_code.trim();
  if (
    code === PARTNER_RESERVED_CODE ||
    !PARTNER_LOGIN_CODE_PATTERN.test(code) ||
    activation_code.length < 8 ||
    activation_code.length > 128 ||
    CONTROL_CHAR_PATTERN.test(activation_code)
  ) {
    return { ok: false, code: "PARTNER_ACTIVATION_INVALID", status: 400 };
  }
  return { ok: true, value: { code, activation_code } };
}

export type PartnerProfilePatchInput = {
  display_name: string;
  address: string | null;
  phone: string | null;
  expected_version: number;
  idempotency_key: string;
};

const PROFILE_PATCH_ALLOWED_KEYS = new Set([
  "display_name",
  "address",
  "phone",
  "expected_version",
  "idempotency_key",
]);

function normalizeOptionalAddress(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > 500 || CONTROL_CHAR_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

function normalizeOptionalPhone(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length < 6 || trimmed.length > 32 || !PARTNER_PHONE_PATTERN.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function parsePartnerProfilePatchBody(
  body: unknown,
): ParseResult<PartnerProfilePatchInput> {
  if (!isRecord(body)) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  const keys = Object.keys(body);
  if (
    keys.some((k) => !PROFILE_PATCH_ALLOWED_KEYS.has(k)) ||
    !Object.hasOwn(body, "display_name") ||
    !Object.hasOwn(body, "expected_version") ||
    !Object.hasOwn(body, "idempotency_key")
  ) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  if (
    typeof body.display_name !== "string" ||
    CONTROL_CHAR_PATTERN.test(body.display_name)
  ) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  const display_name = body.display_name.trim();
  if (display_name.length < 1 || display_name.length > 256) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  const address = normalizeOptionalAddress(body.address);
  const phone = normalizeOptionalPhone(body.phone);
  const expected_version =
    typeof body.expected_version === "number" &&
    Number.isSafeInteger(body.expected_version) &&
    body.expected_version >= 1
      ? body.expected_version
      : null;
  const idempotency_key = parseIdempotencyKey(body.idempotency_key);
  if (!address.ok || !phone.ok || expected_version === null || !idempotency_key) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  return {
    ok: true,
    value: {
      display_name,
      address: address.value,
      phone: phone.value,
      expected_version,
      idempotency_key,
    },
  };
}

function readSingleQueryParam(
  url: URL,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) return { ok: false };
  if (values.length === 0) return { ok: true, value: null };
  return { ok: true, value: values[0] };
}

function validateQueryKeys(
  url: URL,
  allowedKeys: ReadonlySet<string>,
): ParseResult<true> {
  for (const key of url.searchParams.keys()) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (
      FORBIDDEN_PARTNER_OVERRIDE_KEYS.has(normalized) ||
      normalized === "appuserid" ||
      normalized === "actorid" ||
      normalized === "authsubject"
    ) {
      return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN", status: 400 };
    }
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "PARTNER_INVALID", status: 400 };
    }
  }
  return { ok: true, value: true };
}

function parseOptionalDateFilter(
  raw: string | null,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!isRealCalendarDate(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

function parseOptionalProjectFilter(
  raw: string | null,
): { ok: true; value: string | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!PARTNER_PROJECT_ID_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

const SUMMARY_QUERY_KEYS = new Set(["from_date", "to_date", "project_id", "group_by"]);

export type PartnerSummaryQuery = {
  from_date: string | null;
  to_date: string | null;
  project_id: string | null;
  group_by: PartnerGroupBy;
};

export function parsePartnerSummaryQuery(url: URL): ParseResult<PartnerSummaryQuery> {
  const keyCheck = validateQueryKeys(url, SUMMARY_QUERY_KEYS);
  if (!keyCheck.ok) return keyCheck;

  const rawFrom = readSingleQueryParam(url, "from_date");
  const rawTo = readSingleQueryParam(url, "to_date");
  const rawProject = readSingleQueryParam(url, "project_id");
  const rawGroupBy = readSingleQueryParam(url, "group_by");
  if (!rawFrom.ok || !rawTo.ok || !rawProject.ok || !rawGroupBy.ok) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }

  const fromDate = parseOptionalDateFilter(rawFrom.value);
  const toDate = parseOptionalDateFilter(rawTo.value);
  const projectId = parseOptionalProjectFilter(rawProject.value);
  if (!fromDate.ok || !toDate.ok || !projectId.ok) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }

  const groupRaw = rawGroupBy.value?.trim().toLowerCase() ?? "month";
  const group_by: PartnerGroupBy | null =
    groupRaw === "" || groupRaw === "month"
      ? "month"
      : groupRaw === "day"
        ? "day"
        : null;
  if (!group_by) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }

  return {
    ok: true,
    value: {
      from_date: fromDate.value,
      to_date: toDate.value,
      project_id: projectId.value,
      group_by,
    },
  };
}

const WORKERS_QUERY_KEYS = new Set([
  "search",
  "project_id",
  "from_date",
  "to_date",
  "page",
  "page_size",
]);

export type PartnerWorkersQuery = {
  search: string | null;
  project_id: string | null;
  from_date: string | null;
  to_date: string | null;
  page: number;
  page_size: number;
};

function parsePositiveIntQuery(
  raw: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw.trim() === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const num = Number(trimmed);
  return num >= min && num <= max ? num : null;
}

export function parsePartnerWorkersQuery(url: URL): ParseResult<PartnerWorkersQuery> {
  const keyCheck = validateQueryKeys(url, WORKERS_QUERY_KEYS);
  if (!keyCheck.ok) return keyCheck;

  const rawSearch = readSingleQueryParam(url, "search");
  const rawProject = readSingleQueryParam(url, "project_id");
  const rawFrom = readSingleQueryParam(url, "from_date");
  const rawTo = readSingleQueryParam(url, "to_date");
  const rawPage = readSingleQueryParam(url, "page");
  const rawPageSize = readSingleQueryParam(url, "page_size");
  if (
    !rawSearch.ok ||
    !rawProject.ok ||
    !rawFrom.ok ||
    !rawTo.ok ||
    !rawPage.ok ||
    !rawPageSize.ok
  ) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }

  let search: string | null = null;
  if (rawSearch.value !== null) {
    if (CONTROL_CHAR_PATTERN.test(rawSearch.value)) {
      return { ok: false, code: "PARTNER_INVALID", status: 400 };
    }
    const trimmed = rawSearch.value.trim();
    if (trimmed.length > 256) {
      return { ok: false, code: "PARTNER_INVALID", status: 400 };
    }
    search = trimmed === "" ? null : trimmed;
  }

  const projectId = parseOptionalProjectFilter(rawProject.value);
  const fromDate = parseOptionalDateFilter(rawFrom.value);
  const toDate = parseOptionalDateFilter(rawTo.value);
  const page = parsePositiveIntQuery(rawPage.value, 1, 1, 1000);
  const page_size = parsePositiveIntQuery(rawPageSize.value, 25, 1, 100);
  if (!projectId.ok || !fromDate.ok || !toDate.ok || page === null || page_size === null) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
    return { ok: false, code: "PARTNER_INVALID", status: 400 };
  }

  return {
    ok: true,
    value: {
      search,
      project_id: projectId.value,
      from_date: fromDate.value,
      to_date: toDate.value,
      page,
      page_size,
    },
  };
}

/* ---------- Strict RPC Output Projections ---------- */

export type PartnerConflictsReport = {
  checked_at: string;
  has_conflicts: boolean;
  conflict_count: number;
  intra_catalog_duplicates: Array<{
    partner_kind: PartnerKind;
    canonical_code: string;
    row_count: number;
    rows: Array<{ partner_id: string; display_name: string; active: boolean }>;
  }>;
  cross_catalog_duplicates: Array<{
    canonical_code: string;
    rows: Array<{
      partner_kind: PartnerKind;
      partner_id: string;
      display_name: string;
      active: boolean;
    }>;
  }>;
  unregistered_catalog_rows: Array<{
    partner_kind: PartnerKind;
    partner_id: string;
    canonical_code: string;
    display_name: string;
    active: boolean;
  }>;
  auth_email_collisions: Array<{
    email: string;
    canonical_code: string;
    auth_subject: string;
  }>;
};

export type PartnerProvisionBeginData = {
  intent_id: string;
  intent_token: string;
  state: string;
  resumed: boolean;
  partner_account_id: string;
  partner_kind: PartnerKind;
  partner_id: string;
  canonical_code: string;
  username: string;
  auth_email: string;
  display_name: string;
};

export type PartnerProvisionFinalizeData = {
  partner_account_id: string;
  partner_kind: PartnerKind;
  partner_id: string;
  canonical_code: string;
  username: string;
  app_user_id: string;
  auth_subject: string;
  account_state: PartnerAccountState;
  activation_expires_at: string;
  must_change_password: boolean;
  version: number;
  revision_id: string;
  intent_id: string;
};

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

export type PartnerActivateResult =
  | { ok: false; error_code: "PARTNER_ACTIVATION_INVALID" }
  | {
      ok: true;
      partner_account_id: string;
      partner_kind: PartnerKind;
      vendor_id: string | null;
      collaborator_id: string | null;
      partner_id: string;
      canonical_code: string;
      username: string;
      app_user_id: string;
      auth_subject: string;
      account_state: "ACTIVE_MUST_CHANGE_PASSWORD";
      must_change_password: true;
      activated_at: string;
    };

export type PartnerProfile = {
  partner_account_id: string;
  partner_kind: PartnerKind;
  partner_id: string;
  code: string;
  canonical_code: string;
  username: string;
  display_name: string;
  address: string | null;
  phone: string | null;
  active: boolean;
  version: number;
  account_state: PartnerAccountState;
  must_change_password: boolean;
  activated_at: string | null;
  password_changed_at: string | null;
};

export type PartnerAvailableProject = {
  project_id: string;
  project_name: string;
  worker_count: number;
};

export type PartnerVendorRecruitmentSummary = {
  vendor_id: string;
  vendor_name: string;
  date_from: string | null;
  date_to: string | null;
  project_id: string | null;
  group_by: PartnerGroupBy;
  total_workers: number;
  on_count: number;
  off_count: number;
  unconfirmed_count: number;
  by_project: Array<{
    project_id: string;
    project_name: string;
    total_workers: number;
    on_count: number;
    off_count: number;
    unconfirmed_count: number;
  }>;
  by_period: Array<{
    period_key: string;
    total_workers: number;
    on_count: number;
    off_count: number;
    unconfirmed_count: number;
  }>;
  available_projects: PartnerAvailableProject[];
};

export type PartnerVendorWorkerItem = {
  entry_id: string;
  full_name: string | null;
  employee_code: string;
  project_id: string;
  project_name: string;
  first_work_date: string;
  employment_status: "ON" | "OFF" | "UNCONFIRMED";
};

export type PartnerVendorWorkerList = {
  items: PartnerVendorWorkerItem[];
  total: number;
  page: number;
  page_size: number;
  available_projects: PartnerAvailableProject[];
};

function nonEmptyStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function nullableStr(v: unknown): string | null | undefined {
  return v === null ? null : typeof v === "string" ? v : undefined;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function partnerKindVal(v: unknown): PartnerKind | null {
  return v === "VENDOR" || v === "COLLABORATOR" ? v : null;
}

const ACCOUNT_STATES = new Set<string>([
  "UNPROVISIONED",
  "PENDING_ACTIVATION",
  "ACTIVE_MUST_CHANGE_PASSWORD",
  "ACTIVE",
  "SUSPENDED",
]);

function accountStateVal(v: unknown): PartnerAccountState | null {
  return typeof v === "string" && ACCOUNT_STATES.has(v) ? (v as PartnerAccountState) : null;
}

export function projectConflictsReport(raw: unknown): PartnerConflictsReport | null {
  if (!isRecord(raw)) return null;
  const checked_at = nonEmptyStr(raw.checked_at);
  const conflict_count = nonNegInt(raw.conflict_count);
  if (
    checked_at === null ||
    typeof raw.has_conflicts !== "boolean" ||
    conflict_count === null ||
    !Array.isArray(raw.intra_catalog_duplicates) ||
    !Array.isArray(raw.cross_catalog_duplicates) ||
    !Array.isArray(raw.unregistered_catalog_rows) ||
    !Array.isArray(raw.auth_email_collisions)
  ) {
    return null;
  }

  const intra: PartnerConflictsReport["intra_catalog_duplicates"] = [];
  for (const item of raw.intra_catalog_duplicates) {
    if (!isRecord(item)) return null;
    const partner_kind = partnerKindVal(item.partner_kind);
    const canonical_code = nonEmptyStr(item.canonical_code);
    const row_count = nonNegInt(item.row_count);
    if (!partner_kind || !canonical_code || row_count === null || !Array.isArray(item.rows)) {
      return null;
    }
    const rows: Array<{ partner_id: string; display_name: string; active: boolean }> = [];
    for (const r of item.rows) {
      if (
        !isRecord(r) ||
        !nonEmptyStr(r.partner_id) ||
        typeof r.display_name !== "string" ||
        typeof r.active !== "boolean"
      ) {
        return null;
      }
      rows.push({
        partner_id: r.partner_id as string,
        display_name: r.display_name,
        active: r.active,
      });
    }
    intra.push({ partner_kind, canonical_code, row_count, rows });
  }

  const cross: PartnerConflictsReport["cross_catalog_duplicates"] = [];
  for (const item of raw.cross_catalog_duplicates) {
    if (!isRecord(item)) return null;
    const canonical_code = nonEmptyStr(item.canonical_code);
    if (!canonical_code || !Array.isArray(item.rows)) return null;
    const rows: PartnerConflictsReport["cross_catalog_duplicates"][number]["rows"] = [];
    for (const r of item.rows) {
      if (!isRecord(r)) return null;
      const partner_kind = partnerKindVal(r.partner_kind);
      const partner_id = nonEmptyStr(r.partner_id);
      if (!partner_kind || !partner_id || typeof r.display_name !== "string" || typeof r.active !== "boolean") {
        return null;
      }
      rows.push({ partner_kind, partner_id, display_name: r.display_name, active: r.active });
    }
    cross.push({ canonical_code, rows });
  }

  const unregistered: PartnerConflictsReport["unregistered_catalog_rows"] = [];
  for (const item of raw.unregistered_catalog_rows) {
    if (!isRecord(item)) return null;
    const partner_kind = partnerKindVal(item.partner_kind);
    const partner_id = nonEmptyStr(item.partner_id);
    const canonical_code = nonEmptyStr(item.canonical_code);
    if (
      !partner_kind ||
      !partner_id ||
      !canonical_code ||
      typeof item.display_name !== "string" ||
      typeof item.active !== "boolean"
    ) {
      return null;
    }
    unregistered.push({
      partner_kind,
      partner_id,
      canonical_code,
      display_name: item.display_name,
      active: item.active,
    });
  }

  const emailCollisions: PartnerConflictsReport["auth_email_collisions"] = [];
  for (const item of raw.auth_email_collisions) {
    if (
      !isRecord(item) ||
      !nonEmptyStr(item.email) ||
      !nonEmptyStr(item.canonical_code) ||
      !isUuid(item.auth_subject)
    ) {
      return null;
    }
    emailCollisions.push({
      email: item.email as string,
      canonical_code: item.canonical_code as string,
      auth_subject: item.auth_subject,
    });
  }

  return {
    checked_at,
    has_conflicts: raw.has_conflicts,
    conflict_count,
    intra_catalog_duplicates: intra,
    cross_catalog_duplicates: cross,
    unregistered_catalog_rows: unregistered,
    auth_email_collisions: emailCollisions,
  };
}

export function projectProvisionBegin(raw: unknown): PartnerProvisionBeginData | null {
  if (!isRecord(raw)) return null;
  const partner_kind = partnerKindVal(raw.partner_kind);
  if (
    !isUuid(raw.intent_id) ||
    !isUuid(raw.intent_token) ||
    !nonEmptyStr(raw.state) ||
    typeof raw.resumed !== "boolean" ||
    !isUuid(raw.partner_account_id) ||
    !partner_kind ||
    !nonEmptyStr(raw.partner_id) ||
    !nonEmptyStr(raw.canonical_code) ||
    !nonEmptyStr(raw.username) ||
    !nonEmptyStr(raw.auth_email) ||
    !nonEmptyStr(raw.display_name)
  ) {
    return null;
  }
  return {
    intent_id: raw.intent_id,
    intent_token: raw.intent_token,
    state: raw.state as string,
    resumed: raw.resumed,
    partner_account_id: raw.partner_account_id,
    partner_kind,
    partner_id: raw.partner_id as string,
    canonical_code: raw.canonical_code as string,
    username: raw.username as string,
    auth_email: raw.auth_email as string,
    display_name: raw.display_name as string,
  };
}

export function projectProvisionFinalize(raw: unknown): PartnerProvisionFinalizeData | null {
  if (!isRecord(raw)) return null;
  const partner_kind = partnerKindVal(raw.partner_kind);
  const account_state = accountStateVal(raw.account_state);
  const version = nonNegInt(raw.version);
  if (
    !isUuid(raw.partner_account_id) ||
    !partner_kind ||
    !nonEmptyStr(raw.partner_id) ||
    !nonEmptyStr(raw.canonical_code) ||
    !nonEmptyStr(raw.username) ||
    !isUuid(raw.app_user_id) ||
    !isUuid(raw.auth_subject) ||
    !account_state ||
    !nonEmptyStr(raw.activation_expires_at) ||
    typeof raw.must_change_password !== "boolean" ||
    version === null ||
    !isUuid(raw.revision_id) ||
    !isUuid(raw.intent_id)
  ) {
    return null;
  }
  return {
    partner_account_id: raw.partner_account_id,
    partner_kind,
    partner_id: raw.partner_id as string,
    canonical_code: raw.canonical_code as string,
    username: raw.username as string,
    app_user_id: raw.app_user_id,
    auth_subject: raw.auth_subject,
    account_state,
    activation_expires_at: raw.activation_expires_at as string,
    must_change_password: raw.must_change_password,
    version,
    revision_id: raw.revision_id,
    intent_id: raw.intent_id,
  };
}

export function projectPartnerAccountSummary(raw: unknown): PartnerAccountSummary | null {
  if (!isRecord(raw)) return null;
  const partner_kind = partnerKindVal(raw.partner_kind);
  const account_state = accountStateVal(raw.account_state);
  const activation_attempts = nonNegInt(raw.activation_attempts);
  const version = nonNegInt(raw.version);
  const vendor_id = nullableStr(raw.vendor_id);
  const collaborator_id = nullableStr(raw.collaborator_id);
  const app_user_id = raw.app_user_id === null ? null : isUuid(raw.app_user_id) ? raw.app_user_id : undefined;
  const username = nullableStr(raw.username);
  const activated_at = nullableStr(raw.activated_at);
  const password_changed_at = nullableStr(raw.password_changed_at);
  const activation_expires_at = nullableStr(raw.activation_expires_at);
  if (
    !isUuid(raw.partner_account_id) ||
    !partner_kind ||
    vendor_id === undefined ||
    collaborator_id === undefined ||
    !nonEmptyStr(raw.partner_id) ||
    !nonEmptyStr(raw.canonical_code) ||
    !account_state ||
    app_user_id === undefined ||
    username === undefined ||
    activated_at === undefined ||
    typeof raw.must_change_password !== "boolean" ||
    password_changed_at === undefined ||
    activation_expires_at === undefined ||
    activation_attempts === null ||
    version === null
  ) {
    return null;
  }
  return {
    partner_account_id: raw.partner_account_id,
    partner_kind,
    vendor_id,
    collaborator_id,
    partner_id: raw.partner_id as string,
    canonical_code: raw.canonical_code as string,
    account_state,
    app_user_id,
    username,
    activated_at,
    must_change_password: raw.must_change_password,
    password_changed_at,
    activation_expires_at,
    activation_attempts,
    version,
  };
}

export function projectActivateResult(raw: unknown): PartnerActivateResult | null {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return null;
  if (!raw.ok) {
    return { ok: false, error_code: "PARTNER_ACTIVATION_INVALID" };
  }
  const partner_kind = partnerKindVal(raw.partner_kind);
  const vendor_id = nullableStr(raw.vendor_id);
  const collaborator_id = nullableStr(raw.collaborator_id);
  if (
    !isUuid(raw.partner_account_id) ||
    !partner_kind ||
    vendor_id === undefined ||
    collaborator_id === undefined ||
    !nonEmptyStr(raw.partner_id) ||
    !nonEmptyStr(raw.canonical_code) ||
    !nonEmptyStr(raw.username) ||
    !isUuid(raw.app_user_id) ||
    !isUuid(raw.auth_subject) ||
    raw.account_state !== "ACTIVE_MUST_CHANGE_PASSWORD" ||
    raw.must_change_password !== true ||
    !nonEmptyStr(raw.activated_at)
  ) {
    return null;
  }
  return {
    ok: true,
    partner_account_id: raw.partner_account_id,
    partner_kind,
    vendor_id,
    collaborator_id,
    partner_id: raw.partner_id as string,
    canonical_code: raw.canonical_code as string,
    username: raw.username as string,
    app_user_id: raw.app_user_id,
    auth_subject: raw.auth_subject,
    account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
    must_change_password: true,
    activated_at: raw.activated_at as string,
  };
}

export function projectPartnerProfile(raw: unknown): PartnerProfile | null {
  if (!isRecord(raw)) return null;
  const partner_kind = partnerKindVal(raw.partner_kind);
  const account_state = accountStateVal(raw.account_state);
  const address = nullableStr(raw.address);
  const phone = nullableStr(raw.phone);
  const activated_at = nullableStr(raw.activated_at);
  const password_changed_at = nullableStr(raw.password_changed_at);
  const version = nonNegInt(raw.version);
  if (
    !isUuid(raw.partner_account_id) ||
    !partner_kind ||
    !nonEmptyStr(raw.partner_id) ||
    !nonEmptyStr(raw.code) ||
    !nonEmptyStr(raw.canonical_code) ||
    !nonEmptyStr(raw.username) ||
    !nonEmptyStr(raw.display_name) ||
    address === undefined ||
    phone === undefined ||
    typeof raw.active !== "boolean" ||
    version === null ||
    !account_state ||
    typeof raw.must_change_password !== "boolean" ||
    activated_at === undefined ||
    password_changed_at === undefined
  ) {
    return null;
  }
  return {
    partner_account_id: raw.partner_account_id,
    partner_kind,
    partner_id: raw.partner_id as string,
    code: raw.code as string,
    canonical_code: raw.canonical_code as string,
    username: raw.username as string,
    display_name: raw.display_name as string,
    address,
    phone,
    active: raw.active,
    version,
    account_state,
    must_change_password: raw.must_change_password,
    activated_at,
    password_changed_at,
  };
}

function projectAvailableProjects(raw: unknown): PartnerAvailableProject[] | null {
  if (!Array.isArray(raw)) return null;
  const projects: PartnerAvailableProject[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const project_id = nonEmptyStr(item.project_id);
    const project_name = nonEmptyStr(item.project_name);
    const worker_count = nonNegInt(item.worker_count);
    if (!project_id || !project_name || worker_count === null) return null;
    projects.push({ project_id, project_name, worker_count });
  }
  return projects;
}

export function projectVendorRecruitmentSummary(
  raw: unknown,
): PartnerVendorRecruitmentSummary | null {
  if (!isRecord(raw)) return null;
  const vendor_id = nonEmptyStr(raw.vendor_id);
  const vendor_name = nonEmptyStr(raw.vendor_name);
  const date_from = nullableStr(raw.date_from);
  const date_to = nullableStr(raw.date_to);
  const project_id = nullableStr(raw.project_id);
  const group_by: PartnerGroupBy | null =
    raw.group_by === "month" || raw.group_by === "day" ? raw.group_by : null;
  const total_workers = nonNegInt(raw.total_workers);
  const on_count = nonNegInt(raw.on_count);
  const off_count = nonNegInt(raw.off_count);
  const unconfirmed_count = nonNegInt(raw.unconfirmed_count);
  const available_projects = projectAvailableProjects(raw.available_projects);
  if (
    !vendor_id ||
    !vendor_name ||
    date_from === undefined ||
    date_to === undefined ||
    project_id === undefined ||
    !group_by ||
    total_workers === null ||
    on_count === null ||
    off_count === null ||
    unconfirmed_count === null ||
    !Array.isArray(raw.by_project) ||
    !Array.isArray(raw.by_period) ||
    !available_projects
  ) {
    return null;
  }

  const by_project: PartnerVendorRecruitmentSummary["by_project"] = [];
  for (const p of raw.by_project) {
    if (!isRecord(p)) return null;
    const pid = nonEmptyStr(p.project_id);
    const pname = nonEmptyStr(p.project_name);
    const tw = nonNegInt(p.total_workers);
    const on = nonNegInt(p.on_count);
    const off = nonNegInt(p.off_count);
    const unc = nonNegInt(p.unconfirmed_count);
    if (!pid || !pname || tw === null || on === null || off === null || unc === null) {
      return null;
    }
    by_project.push({
      project_id: pid,
      project_name: pname,
      total_workers: tw,
      on_count: on,
      off_count: off,
      unconfirmed_count: unc,
    });
  }

  const by_period: PartnerVendorRecruitmentSummary["by_period"] = [];
  for (const per of raw.by_period) {
    if (!isRecord(per)) return null;
    const period_key = nonEmptyStr(per.period_key);
    const tw = nonNegInt(per.total_workers);
    const on = nonNegInt(per.on_count);
    const off = nonNegInt(per.off_count);
    const unc = nonNegInt(per.unconfirmed_count);
    if (!period_key || tw === null || on === null || off === null || unc === null) {
      return null;
    }
    by_period.push({
      period_key,
      total_workers: tw,
      on_count: on,
      off_count: off,
      unconfirmed_count: unc,
    });
  }

  return {
    vendor_id,
    vendor_name,
    date_from,
    date_to,
    project_id,
    group_by,
    total_workers,
    on_count,
    off_count,
    unconfirmed_count,
    by_project,
    by_period,
    available_projects,
  };
}

export function projectVendorWorkerList(raw: unknown): PartnerVendorWorkerList | null {
  if (!isRecord(raw)) return null;
  const total = nonNegInt(raw.total);
  const page = nonNegInt(raw.page);
  const page_size = nonNegInt(raw.page_size);
  const available_projects = projectAvailableProjects(raw.available_projects);
  if (
    !Array.isArray(raw.items) ||
    total === null ||
    page === null ||
    page < 1 ||
    page_size === null ||
    page_size < 1 ||
    !available_projects
  ) {
    return null;
  }

  const items: PartnerVendorWorkerItem[] = [];
  for (const item of raw.items) {
    if (!isRecord(item)) return null;
    const full_name = item.full_name === null ? null : typeof item.full_name === "string" ? item.full_name : undefined;
    const employee_code = nonEmptyStr(item.employee_code);
    const project_id = nonEmptyStr(item.project_id);
    const project_name = nonEmptyStr(item.project_name);
    const first_work_date = nonEmptyStr(item.first_work_date);
    const employment_status =
      item.employment_status === "ON" ||
      item.employment_status === "OFF" ||
      item.employment_status === "UNCONFIRMED"
        ? item.employment_status
        : null;
    if (
      !isUuid(item.entry_id) ||
      full_name === undefined ||
      !employee_code ||
      !project_id ||
      !project_name ||
      !first_work_date ||
      !employment_status
    ) {
      return null;
    }
    items.push({
      entry_id: item.entry_id,
      full_name,
      employee_code,
      project_id,
      project_name,
      first_work_date,
      employment_status,
    });
  }

  return {
    items,
    total,
    page,
    page_size,
    available_projects,
  };
}
