/**
 * PRE-W2-P1 + HF-E + HF-G - Hop dong server cho xuat Excel full-PII (recruited / managed / team / all).
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority do RPC public.direct_entry_export_workers quyet dinh: recruited/managed/team require
 * their DB-verified row audience; `all` additionally requires current all scope and the existing
 * `entry_admin` or `change_review` action.
 * Client khong bao gio tu khai
 * identity/capability/scope.
 *
 * Fail-closed: dung key, dung kieu, khong fallback rong; khong type assertion. Mot envelope
 * sai hinh => null (khong bao gio tao file rong tu du lieu khong ro nguon).
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isCanonicalLaborTypeKey, type LaborType } from "../contracts/direct-entry-v1.ts";
import { projectOptionalActionReason } from "./action-reason.ts";

export const WORKER_EXPORT_SCOPES = ["recruited", "managed", "team", "all"] as const;
export type WorkerExportScope = (typeof WORKER_EXPORT_SCOPES)[number];

export const WORKER_EXPORT_EMPLOYMENT_STATUSES = ["UNCONFIRMED", "ON", "OFF"] as const;
export const WORKER_EXPORT_PROVIDER_TYPES = ["HRP", "Vendor", "CTV"] as const;
export const WORKER_EXPORT_FILTER_PROVIDER_TYPES = ["hrp", "hrp_direct", "hrp_ctv", "vendor"] as const;
export type WorkerExportFilterProviderType = (typeof WORKER_EXPORT_FILTER_PROVIDER_TYPES)[number];
export const WORKER_EXPORT_SEARCH_MAX_LENGTH = 100;

export const WORKER_EXPORT_ROW_LIMIT = 10000;

/** Body allowlist. `scope` required; filters and action reason optional/null. */
export const WORKER_EXPORT_BODY_KEYS = [
  "scope", "project_id", "recruiter_id", "employment_status",
  "search", "first_work_date_from", "first_work_date_to", "provider_type", "labor_type",
  "reason",
] as const;

/** Exact row projection, string/null theo du lieu authoritative (20 truong, P1 + Ghi chú). */
export const WORKER_EXPORT_ROW_KEYS = [
  "employee_code", "display_name", "date_of_birth", "national_id", "national_id_issued_at",
  "phone", "address",
  "project_display", "first_work_date", "labor_type_display", "recruiter_display",
  "provider_type", "employment_status", "leave_date", "leave_reason", "account_number",
  "bank_name", "account_holder_name", "payment_note", "general_note",
] as const;

export const WORKER_EXPORT_OK_KEYS = ["status", "rows"] as const;
export const WORKER_EXPORT_TOO_MANY_KEYS = ["status", "limit"] as const;

/** 20 cot XLSX theo dung thu tu; moi gia tri duoc giu dang text (numFmt "@"). */
export const WORKER_EXPORT_COLUMNS: ReadonlyArray<{
  header: string;
  key: (typeof WORKER_EXPORT_ROW_KEYS)[number] | "collaborator_display_name";
  text: boolean;
}> = Object.freeze([
  { header: "Mã NLĐ", key: "employee_code", text: true },
  { header: "Họ và tên", key: "display_name", text: true },
  { header: "Ngày sinh", key: "date_of_birth", text: true },
  { header: "CCCD", key: "national_id", text: true },
  { header: "Ngày cấp CCCD", key: "national_id_issued_at", text: true },
  { header: "Số điện thoại", key: "phone", text: true },
  { header: "Địa chỉ", key: "address", text: true },
  { header: "Dự án", key: "project_display", text: true },
  { header: "Ngày bắt đầu", key: "first_work_date", text: true },
  { header: "Loại hình lao động", key: "labor_type_display", text: true },
  { header: "Người tuyển", key: "recruiter_display", text: true },
  { header: "Nhà cung cấp", key: "provider_type", text: true },
  { header: "CTV", key: "collaborator_display_name", text: true },
  { header: "Trạng thái làm việc", key: "employment_status", text: true },
  { header: "Ngày nghỉ", key: "leave_date", text: true },
  { header: "Lý do nghỉ", key: "leave_reason", text: true },
  { header: "Số tài khoản", key: "account_number", text: true },
  { header: "Ngân hàng", key: "bank_name", text: true },
  { header: "Chủ tài khoản", key: "account_holder_name", text: true },
  { header: "Ghi chú thanh toán", key: "payment_note", text: true },
  { header: "Ghi chú", key: "general_note", text: true },
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isNullableText(value: unknown, max: number): value is string | null {
  return value === null || isBoundedText(value, max);
}

export type WorkerExportRequest = {
  scope: WorkerExportScope;
  project_id: string | null;
  recruiter_id: string | null;
  employment_status: (typeof WORKER_EXPORT_EMPLOYMENT_STATUSES)[number] | null;
  search: string | null;
  first_work_date_from: string | null;
  first_work_date_to: string | null;
  provider_type: WorkerExportFilterProviderType | null;
  labor_type: LaborType | null;
  reason: string | null;
};

/**
 * Strict request projection. Unknown keys, wrong value types or an invalid enum/filter are refused.
 * `project_id`/`recruiter_id`/`employment_status`/`search`/`first_work_date_from`/
 * `first_work_date_to`/`provider_type`/`labor_type` and action `reason` may be absent or null. No idempotency key.
 */
export function projectWorkerExportRequest(body: unknown): WorkerExportRequest | null {
  if (!isRecord(body)) return null;
  for (const key of Object.keys(body)) {
    if (!(WORKER_EXPORT_BODY_KEYS as readonly string[]).includes(key)) return null;
  }

  const scope = body.scope;
  if (typeof scope !== "string" ||
      !(WORKER_EXPORT_SCOPES as readonly string[]).includes(scope)) {
    return null;
  }
  const reason = projectOptionalActionReason(body.reason);
  if (!reason.ok) return null;
  const projectId = body.project_id ?? null;
  if (projectId !== null && (typeof projectId !== "string" || !PROJECT_ID.test(projectId))) {
    return null;
  }
  const recruiterId = body.recruiter_id ?? null;
  if (recruiterId !== null && (typeof recruiterId !== "string" || !UUID.test(recruiterId))) {
    return null;
  }
  const employmentStatus = body.employment_status ?? null;
  if (employmentStatus !== null &&
      (typeof employmentStatus !== "string" ||
       !(WORKER_EXPORT_EMPLOYMENT_STATUSES as readonly string[]).includes(employmentStatus))) {
    return null;
  }
  const rawSearch = body.search ?? null;
  if (rawSearch !== null &&
      (typeof rawSearch !== "string" ||
       [...rawSearch].length > WORKER_EXPORT_SEARCH_MAX_LENGTH ||
       /[\u0000-\u001f\u007f-\u009f]/u.test(rawSearch))) {
    return null;
  }
  const search = rawSearch === null ? null : rawSearch.trim() || null;
  const firstWorkDateFrom = body.first_work_date_from ?? null;
  if (firstWorkDateFrom !== null &&
      (typeof firstWorkDateFrom !== "string" || !isRealCalendarDate(firstWorkDateFrom))) {
    return null;
  }
  const firstWorkDateTo = body.first_work_date_to ?? null;
  if (firstWorkDateTo !== null &&
      (typeof firstWorkDateTo !== "string" || !isRealCalendarDate(firstWorkDateTo))) {
    return null;
  }
  if (firstWorkDateFrom !== null && firstWorkDateTo !== null &&
      firstWorkDateFrom > firstWorkDateTo) {
    return null;
  }
  const providerType = body.provider_type ?? null;
  if (providerType !== null &&
      (typeof providerType !== "string" ||
       !(WORKER_EXPORT_FILTER_PROVIDER_TYPES as readonly string[]).includes(providerType))) {
    return null;
  }
  const laborType = body.labor_type ?? null;
  if (laborType !== null && !isCanonicalLaborTypeKey(laborType)) {
    return null;
  }

  return {
    scope: scope as WorkerExportScope,
    project_id: projectId,
    recruiter_id: recruiterId,
    employment_status: employmentStatus as WorkerExportRequest["employment_status"],
    search,
    first_work_date_from: firstWorkDateFrom,
    first_work_date_to: firstWorkDateTo,
    provider_type: providerType as WorkerExportFilterProviderType | null,
    labor_type: laborType,
    reason: reason.value,
  };
}

export type WorkerExportRow = {
  employee_code: string | null;
  display_name: string | null;
  date_of_birth: string | null;
  national_id: string | null;
  national_id_issued_at: string | null;
  phone: string | null;
  address: string | null;
  project_display: string;
  first_work_date: string;
  labor_type_display: string | null;
  recruiter_display: string;
  provider_type: (typeof WORKER_EXPORT_PROVIDER_TYPES)[number] | null;
  collaborator_id?: string | null;
  collaborator_display_name?: string | null;
  employment_status: (typeof WORKER_EXPORT_EMPLOYMENT_STATUSES)[number] | null;
  leave_date: string | null;
  leave_reason: string | null;
  account_number: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  payment_note: string | null;
  general_note: string | null;
};

export type WorkerExportEnvelope =
  | { status: "ok"; rows: WorkerExportRow[] }
  | { status: "too_many_rows"; limit: number };

const WORKER_EXPORT_OPTIONAL_ROW_KEYS = ["collaborator_id", "collaborator_display_name"] as const;

export function projectWorkerExportRow(value: unknown): WorkerExportRow | null {
  if (!isRecord(value)) return null;
  const rowKeys = Object.keys(value);
  const allowedKeys = new Set<string>([...WORKER_EXPORT_ROW_KEYS, ...WORKER_EXPORT_OPTIONAL_ROW_KEYS]);
  if (!WORKER_EXPORT_ROW_KEYS.every((key) => Object.hasOwn(value, key)) ||
      rowKeys.some((key) => !allowedKeys.has(key))) return null;
  if (Object.hasOwn(value, "collaborator_id") && !isNullableText(value.collaborator_id, 128)) return null;
  if (Object.hasOwn(value, "collaborator_display_name") &&
      !isNullableText(value.collaborator_display_name, 256)) return null;
  if (!isNullableText(value.employee_code, 64)) return null;
  if (!isNullableText(value.display_name, 256)) return null;
  if (!isNullableText(value.date_of_birth, 64)) return null;
  if (!isNullableText(value.national_id, 64)) return null;
  if (!isNullableText(value.national_id_issued_at, 64)) return null;
  if (!isNullableText(value.phone, 64)) return null;
  if (!isNullableText(value.address, 1000)) return null;
  if (typeof value.project_display !== "string" || value.project_display.length < 1 ||
      value.project_display.length > 256) {
    return null;
  }
  if (!isBoundedText(value.first_work_date, 64)) return null;
  if (!isNullableText(value.labor_type_display, 256)) return null;
  if (typeof value.recruiter_display !== "string" || value.recruiter_display.length < 1 ||
      value.recruiter_display.length > 256) {
    return null;
  }
  if (value.provider_type !== null &&
      !(WORKER_EXPORT_PROVIDER_TYPES as readonly string[]).includes(value.provider_type as string)) {
    return null;
  }
  if (value.employment_status !== null &&
      !(WORKER_EXPORT_EMPLOYMENT_STATUSES as readonly string[])
        .includes(value.employment_status as string)) {
    return null;
  }
  if (!isNullableText(value.leave_date, 64)) return null;
  if (!isNullableText(value.leave_reason, 4000)) return null;
  if (!isNullableText(value.account_number, 64)) return null;
  if (!isNullableText(value.bank_name, 256)) return null;
  if (!isNullableText(value.account_holder_name, 256)) return null;
  // No authoritative payment note today: only null or empty is accepted, never fabricated.
  if (value.payment_note !== null && value.payment_note !== "") return null;
  // PRE-W2-HF-E: Ghi chú lấy từ direct_entries.general_note (1..4000, hoặc null).
  if (!isNullableText(value.general_note, 4000)) return null;

  return {
    employee_code: value.employee_code,
    display_name: value.display_name,
    date_of_birth: value.date_of_birth,
    national_id: value.national_id,
    national_id_issued_at: value.national_id_issued_at,
    phone: value.phone,
    address: value.address,
    project_display: value.project_display,
    first_work_date: value.first_work_date,
    labor_type_display: value.labor_type_display,
    recruiter_display: value.recruiter_display,
    provider_type: value.provider_type as WorkerExportRow["provider_type"],
    ...(Object.hasOwn(value, "collaborator_id")
      ? { collaborator_id: value.collaborator_id as string | null }
      : {}),
    ...(Object.hasOwn(value, "collaborator_display_name")
      ? { collaborator_display_name: value.collaborator_display_name as string | null }
      : {}),
    employment_status: value.employment_status as WorkerExportRow["employment_status"],
    leave_date: value.leave_date,
    leave_reason: value.leave_reason,
    account_number: value.account_number,
    bank_name: value.bank_name,
    account_holder_name: value.account_holder_name,
    payment_note: value.payment_note,
    general_note: value.general_note,
  };
}

/**
 * Strict envelope projection. Either { status:"ok", rows:[...] } or
 * { status:"too_many_rows", limit:10000 }. Anything else fails closed.
 */
export function projectWorkerExportEnvelope(value: unknown): WorkerExportEnvelope | null {
  if (!isRecord(value)) return null;
  if (value.status === "too_many_rows") {
    if (!hasExactKeys(value, WORKER_EXPORT_TOO_MANY_KEYS)) return null;
    if (value.limit !== WORKER_EXPORT_ROW_LIMIT) return null;
    return { status: "too_many_rows", limit: WORKER_EXPORT_ROW_LIMIT };
  }
  if (value.status !== "ok") return null;
  if (!hasExactKeys(value, WORKER_EXPORT_OK_KEYS)) return null;
  if (!Array.isArray(value.rows)) return null;
  if (value.rows.length > WORKER_EXPORT_ROW_LIMIT) return null;
  const rows: WorkerExportRow[] = [];
  for (const raw of value.rows) {
    const row = projectWorkerExportRow(raw);
    if (row === null) return null;
    rows.push(row);
  }
  return { status: "ok", rows };
}
