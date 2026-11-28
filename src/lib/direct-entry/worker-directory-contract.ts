/**
 * P2.5-W03 - Hop dong worker directory (recruiter / project / team / all).
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (mapping actor, recruiter link, current assignment, team scope, or all scope +
 * entry_admin/change_review) do RPC public.direct_entry_list_workers quyet dinh -
 * client khong bao gio tu khai identity/capability/scope.
 *
 * Fail-closed: dung key, dung kieu, khong fallback [], 0, false; khong type assertion.
 * allowed_actions la tin hieu authority duy nhat cua row do server sinh; UI khong tu suy
 * quyen. RPC van kiem tra lai moi mutation.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isCanonicalLaborTypeKey, type LaborType } from "../contracts/direct-entry-v1.ts";
import { isPaymentAccountNumber, isPaymentText } from "./payment-contract.ts";

export const WORKER_DIRECTORY_SCOPES = ["recruited", "managed", "team", "all"] as const;
export type WorkerDirectoryScope = (typeof WORKER_DIRECTORY_SCOPES)[number];

export const WORKER_PROVIDER_TYPES = ["hrp", "hrp_direct", "hrp_ctv", "vendor"] as const;
export type WorkerProviderType = (typeof WORKER_PROVIDER_TYPES)[number];

export const WORKER_DIRECTORY_DEFAULT_PAGE_SIZE = 25;
export const WORKER_DIRECTORY_MAX_PAGE_SIZE = 100;
export const WORKER_DIRECTORY_QUERY_KEYS = [
  "scope", "project_id", "recruiter_id", "employment_status", "search",
  "first_work_date_from", "first_work_date_to", "provider_type", "labor_type",
  "cursor", "page_size",
] as const;

export const WORKER_DIRECTORY_PAGE_KEYS = [
  "items", "scope", "page_size", "has_more", "next_cursor", "authorization_date", "summary",
] as const;
export const WORKER_DIRECTORY_SUMMARY_KEYS = [
  "total_workers", "project_count", "recruiter_count",
] as const;
export const WORKER_DIRECTORY_ROW_KEYS = [
  "entry_id", "entry_version", "submission_state", "employee_code", "display_name",
  "project_id", "project_display", "first_work_date", "labor_type", "labor_type_display",
  "employment_status",
  "recruiter_id", "recruiter_display", "payment", "pending_request", "last_decision",
  "is_project_manager", "allowed_actions",
] as const;
export const WORKER_DIRECTORY_PAYMENT_KEYS = [
  "state", "account_number", "bank_id", "account_holder_name", "version",
] as const;
export const WORKER_DIRECTORY_PENDING_KEYS = ["request_id", "state", "version"] as const;
export const WORKER_DIRECTORY_DECISION_KEYS = ["state", "decided_at"] as const;
export const WORKER_DIRECTORY_ACTION_KEYS = [
  "view", "view_pii", "view_payment", "propose_change", "propose_change_code", "direct_edit",
] as const;

export const WORKER_EMPLOYMENT_STATUSES = ["UNCONFIRMED", "ON", "OFF"] as const;
export const WORKER_DIRECTORY_SEARCH_MAX_LENGTH = 100;
export const WORKER_PAYMENT_STATES = [
  "omitted", "unknown", "intentionally_blank", "provided",
] as const;
export const WORKER_DECISION_STATES = ["APPROVED", "REJECTED"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const EMPLOYEE_CODE = /^hrp-[0-9]{4}-[0-9]{6}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_UTC_MICROS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const CURSOR = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE_SIZE_TEXT = /^[1-9][0-9]{0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

export type WorkerDirectoryQuery = {
  scope: WorkerDirectoryScope;
  project_id: string | null;
  recruiter_id: string | null;
  employment_status: (typeof WORKER_EMPLOYMENT_STATUSES)[number] | null;
  search: string | null;
  first_work_date_from: string | null;
  first_work_date_to: string | null;
  provider_type: WorkerProviderType | null;
  labor_type: LaborType | null;
  cursor: string | null;
  page_size: number;
};

export type WorkerDirectoryProjection<T> =
  | { ok: true; value: T }
  | { ok: false; code: "WORKER_QUERY_INVALID" };

const QUERY_INVALID = { ok: false, code: "WORKER_QUERY_INVALID" } as const;

/**
 * Query directory: chi nhan dung scope | project_id | recruiter_id | employment_status |
 * search | first_work_date_from | first_work_date_to | provider_type | labor_type | cursor | page_size.
 * Tham so khac (order, offset, limit, column, sql...) bi tu choi de client khong dieu khien
 * duoc SQL/sort/paging.
 */
export function projectWorkerDirectoryQuery(
  searchParams: URLSearchParams,
): WorkerDirectoryProjection<WorkerDirectoryQuery> {
  if ([...searchParams.keys()].length !== new Set(searchParams.keys()).size) return QUERY_INVALID;
  for (const key of searchParams.keys()) {
    if (!(WORKER_DIRECTORY_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;
  }

  const rawScope = searchParams.get("scope");
  if (rawScope === null || !(WORKER_DIRECTORY_SCOPES as readonly string[]).includes(rawScope)) {
    return QUERY_INVALID;
  }

  const rawProject = searchParams.get("project_id");
  if (rawProject !== null && !PROJECT_ID.test(rawProject)) return QUERY_INVALID;
  const rawRecruiter = searchParams.get("recruiter_id");
  if (rawRecruiter !== null && !UUID.test(rawRecruiter)) return QUERY_INVALID;
  const rawEmployment = searchParams.get("employment_status");
  if (rawEmployment !== null &&
      !(WORKER_EMPLOYMENT_STATUSES as readonly string[]).includes(rawEmployment)) {
    return QUERY_INVALID;
  }
  const rawDateFrom = searchParams.get("first_work_date_from");
  if (rawDateFrom !== null && !isRealCalendarDate(rawDateFrom)) return QUERY_INVALID;
  const rawDateTo = searchParams.get("first_work_date_to");
  if (rawDateTo !== null && !isRealCalendarDate(rawDateTo)) return QUERY_INVALID;
  if (rawDateFrom !== null && rawDateTo !== null && rawDateFrom > rawDateTo) {
    return QUERY_INVALID;
  }
  const rawProviderType = searchParams.get("provider_type");
  if (rawProviderType !== null &&
      !(WORKER_PROVIDER_TYPES as readonly string[]).includes(rawProviderType)) {
    return QUERY_INVALID;
  }
  const rawLaborType = searchParams.get("labor_type");
  if (rawLaborType !== null && !isCanonicalLaborTypeKey(rawLaborType)) {
    return QUERY_INVALID;
  }
  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null && !CURSOR.test(rawCursor)) return QUERY_INVALID;
  const rawSearch = searchParams.get("search");
  if (rawSearch !== null &&
      ([...rawSearch].length > WORKER_DIRECTORY_SEARCH_MAX_LENGTH ||
       /[\u0000-\u001f\u007f-\u009f]/u.test(rawSearch))) return QUERY_INVALID;
  const search = rawSearch?.trim() || null;
  if (search !== null && [...search].length > WORKER_DIRECTORY_SEARCH_MAX_LENGTH) {
    return QUERY_INVALID;
  }

  const rawPageSize = searchParams.get("page_size");
  let pageSize = WORKER_DIRECTORY_DEFAULT_PAGE_SIZE;
  if (rawPageSize !== null) {
    if (!PAGE_SIZE_TEXT.test(rawPageSize)) return QUERY_INVALID;
    pageSize = Number(rawPageSize);
    if (pageSize < 1 || pageSize > WORKER_DIRECTORY_MAX_PAGE_SIZE) return QUERY_INVALID;
  }

  return {
    ok: true,
    value: {
      scope: rawScope as WorkerDirectoryScope,
      project_id: rawProject,
      recruiter_id: rawRecruiter,
      employment_status: rawEmployment as WorkerDirectoryQuery["employment_status"],
      search,
      first_work_date_from: rawDateFrom,
      first_work_date_to: rawDateTo,
      provider_type: rawProviderType as WorkerProviderType | null,
      labor_type: rawLaborType,
      cursor: rawCursor,
      page_size: pageSize,
    },
  };
}

export type WorkerDirectoryPayment = {
  state: (typeof WORKER_PAYMENT_STATES)[number];
  account_number: string | null;
  bank_id: string | null;
  account_holder_name: string | null;
  version: number;
};

export type WorkerDirectoryPendingRequest = {
  request_id: string;
  state: "PENDING";
  version: number;
};

export type WorkerDirectoryLastDecision = {
  state: (typeof WORKER_DECISION_STATES)[number];
  decided_at: string;
};

export type WorkerDirectorySummary = {
  total_workers: number;
  project_count: number;
  recruiter_count: number;
};

export type WorkerDirectoryAllowedActions = {
  view: true;
  /** Legacy response echoes only; authorization consumers use `view`. */
  view_pii: true;
  view_payment: true;
  propose_change: boolean;
  propose_change_code: string | null;
  direct_edit: boolean;
};

export type WorkerDirectoryRow = {
  entry_id: string;
  entry_version: number;
  submission_state: "SUBMITTED";
  employee_code: string;
  display_name: string;
  project_id: string;
  project_display: string;
  first_work_date: string;
  labor_type: LaborType;
  /** P3.1-W02C-R2: nhan do server resolve tu catalog theo key; KHONG BAO GIO la key tho. */
  labor_type_display: string;
  employment_status: (typeof WORKER_EMPLOYMENT_STATUSES)[number] | null;
  recruiter_id: string;
  recruiter_display: string;
  provider_type?: "hrp" | "vendor";
  collaborator_id?: string | null;
  collaborator_display_name?: string | null;
  payment: WorkerDirectoryPayment | null;
  pending_request: WorkerDirectoryPendingRequest | null;
  last_decision: WorkerDirectoryLastDecision | null;
  is_project_manager: boolean;
  allowed_actions: WorkerDirectoryAllowedActions;
};

export type WorkerDirectoryPage = {
  items: WorkerDirectoryRow[];
  scope: WorkerDirectoryScope;
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  authorization_date: string;
  summary: WorkerDirectorySummary;
};

function projectWorkerDirectorySummary(value: unknown): WorkerDirectorySummary | null {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_SUMMARY_KEYS)) return null;
  const totalWorkers = value.total_workers;
  const projectCount = value.project_count;
  const recruiterCount = value.recruiter_count;
  if (typeof totalWorkers !== "number" || !Number.isSafeInteger(totalWorkers) || totalWorkers < 0 ||
      typeof projectCount !== "number" || !Number.isSafeInteger(projectCount) || projectCount < 0 ||
      typeof recruiterCount !== "number" || !Number.isSafeInteger(recruiterCount) || recruiterCount < 0) {
    return null;
  }
  return {
    total_workers: totalWorkers,
    project_count: projectCount,
    recruiter_count: recruiterCount,
  };
}

function projectPayment(value: unknown): WorkerDirectoryPayment | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_PAYMENT_KEYS)) return undefined;
  if (!(WORKER_PAYMENT_STATES as readonly string[]).includes(value.state as string)) return undefined;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
      value.version < 1) {
    return undefined;
  }
  if (value.state === "provided") {
    if ((value.account_number !== null && !isPaymentAccountNumber(value.account_number)) ||
        (value.bank_id !== null && (typeof value.bank_id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.bank_id))) ||
        (value.account_holder_name !== null && !isPaymentText(value.account_holder_name, 256))) {
      return undefined;
    }
  } else if (value.account_number !== null || value.bank_id !== null ||
      value.account_holder_name !== null) {
    return undefined;
  }
  return {
    state: value.state as WorkerDirectoryPayment["state"],
    account_number: value.account_number,
    bank_id: value.bank_id,
    account_holder_name: value.account_holder_name,
    version: value.version,
  };
}

function projectPending(value: unknown): WorkerDirectoryPendingRequest | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_PENDING_KEYS)) return undefined;
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) return undefined;
  if (value.state !== "PENDING") return undefined;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
      value.version < 1) {
    return undefined;
  }
  return { request_id: value.request_id, state: "PENDING", version: value.version };
}

function projectDecision(value: unknown): WorkerDirectoryLastDecision | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_DECISION_KEYS)) return undefined;
  if (!(WORKER_DECISION_STATES as readonly string[]).includes(value.state as string)) {
    return undefined;
  }
  if (typeof value.decided_at !== "string" || !ISO_UTC_MICROS.test(value.decided_at) ||
      Number.isNaN(Date.parse(value.decided_at))) {
    return undefined;
  }
  return {
    state: value.state as WorkerDirectoryLastDecision["state"],
    decided_at: value.decided_at,
  };
}

function projectActions(value: unknown): WorkerDirectoryAllowedActions | undefined {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_ACTION_KEYS)) return undefined;
  if (value.view !== true) return undefined;
  for (const flag of ["view_pii", "view_payment", "propose_change"]) {
    if (typeof value[flag] !== "boolean") return undefined;
  }
  if (value.propose_change_code !== null && typeof value.propose_change_code !== "string") {
    return undefined;
  }
  if (typeof value.direct_edit !== "boolean") return undefined;
  return {
    view: true,
    view_pii: true,
    view_payment: true,
    propose_change: value.propose_change as boolean,
    propose_change_code: value.propose_change_code as string | null,
    direct_edit: value.direct_edit,
  };
}

const WORKER_DIRECTORY_OPTIONAL_ROW_KEYS = [
  "provider_type", "collaborator_id", "collaborator_display_name",
] as const;

export function projectWorkerDirectoryRow(value: unknown): WorkerDirectoryRow | null {
  if (!isRecord(value)) return null;
  const rowKeys = Object.keys(value);
  const allowedRowKeys = new Set<string>([
    ...WORKER_DIRECTORY_ROW_KEYS,
    ...WORKER_DIRECTORY_OPTIONAL_ROW_KEYS,
  ]);
  if (!WORKER_DIRECTORY_ROW_KEYS.every((key) => Object.hasOwn(value, key)) ||
      rowKeys.some((key) => !allowedRowKeys.has(key))) return null;
  if (Object.hasOwn(value, "provider_type") &&
      value.provider_type !== "hrp" && value.provider_type !== "vendor") return null;
  if (Object.hasOwn(value, "collaborator_id") && value.collaborator_id !== null &&
      (typeof value.collaborator_id !== "string" || !PROJECT_ID.test(value.collaborator_id))) {
    return null;
  }
  if (Object.hasOwn(value, "collaborator_display_name") && value.collaborator_display_name !== null &&
      (typeof value.collaborator_display_name !== "string" || value.collaborator_display_name.trim().length < 1)) {
    return null;
  }
  if (typeof value.entry_id !== "string" || !UUID.test(value.entry_id)) return null;
  if (typeof value.entry_version !== "number" || !Number.isSafeInteger(value.entry_version) ||
      value.entry_version < 1) {
    return null;
  }
  if (value.submission_state !== "SUBMITTED") return null;
  if (typeof value.employee_code !== "string" || !EMPLOYEE_CODE.test(value.employee_code)) {
    return null;
  }
  if (typeof value.display_name !== "string" ||
      value.display_name.length > 256 ||
      (value.display_name.length > 0 && value.display_name.trim().length < 1)) {
    return null;
  }
  if (typeof value.project_id !== "string" || !PROJECT_ID.test(value.project_id)) return null;
  if (typeof value.project_display !== "string" || value.project_display.length < 1) return null;
  if (typeof value.first_work_date !== "string" || !ISO_DATE.test(value.first_work_date)) {
    return null;
  }
  if (!isCanonicalLaborTypeKey(value.labor_type)) return null;
  // P3.1-W02C-R2: mot dong luon phai co nhan that. Thieu/rong => ca trang unavailable,
  // khong bao gio render key tho hay mot nhan fallback.
  if (typeof value.labor_type_display !== "string" || value.labor_type_display.length < 1) return null;
  if (value.employment_status !== null &&
      !(WORKER_EMPLOYMENT_STATUSES as readonly string[]).includes(value.employment_status as string)) {
    return null;
  }
  if (typeof value.recruiter_id !== "string" || !UUID.test(value.recruiter_id)) return null;
  if (typeof value.recruiter_display !== "string" || value.recruiter_display.length < 1) return null;
  if (typeof value.is_project_manager !== "boolean") return null;

  const payment = projectPayment(value.payment);
  const pending = projectPending(value.pending_request);
  const decision = projectDecision(value.last_decision);
  const actions = projectActions(value.allowed_actions);
  if (payment === undefined || pending === undefined || decision === undefined ||
      actions === undefined) {
    return null;
  }

  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    submission_state: "SUBMITTED",
    employee_code: value.employee_code,
    display_name: value.display_name,
    project_id: value.project_id,
    project_display: value.project_display,
    first_work_date: value.first_work_date,
    labor_type: value.labor_type,
    labor_type_display: value.labor_type_display,
    employment_status: value.employment_status as WorkerDirectoryRow["employment_status"],
    recruiter_id: value.recruiter_id,
    recruiter_display: value.recruiter_display,
    ...(Object.hasOwn(value, "provider_type")
      ? { provider_type: value.provider_type as "hrp" | "vendor" }
      : {}),
    ...(Object.hasOwn(value, "collaborator_id")
      ? { collaborator_id: value.collaborator_id as string | null }
      : {}),
    ...(Object.hasOwn(value, "collaborator_display_name")
      ? { collaborator_display_name: value.collaborator_display_name as string | null }
      : {}),
    payment,
    pending_request: pending,
    last_decision: decision,
    is_project_manager: value.is_project_manager,
    allowed_actions: actions,
  };
}

export function projectWorkerDirectoryPage(
  value: unknown,
  expected: { scope: string; page_size: number },
): WorkerDirectoryPage | null {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_DIRECTORY_PAGE_KEYS)) return null;
  if (!Array.isArray(value.items) || value.items.length > expected.page_size) return null;
  if (value.scope !== expected.scope) return null;
  if (typeof value.page_size !== "number" || value.page_size !== expected.page_size) return null;
  if (typeof value.has_more !== "boolean") return null;
  if (value.next_cursor !== null &&
      (typeof value.next_cursor !== "string" || !CURSOR.test(value.next_cursor))) {
    return null;
  }
  if (value.has_more !== (value.next_cursor !== null)) return null;
  if (typeof value.authorization_date !== "string" || !ISO_DATE.test(value.authorization_date)) {
    return null;
  }
  const summary = projectWorkerDirectorySummary(value.summary);
  if (summary === null) return null;

  const items: WorkerDirectoryRow[] = [];
  for (const raw of value.items) {
    const row = projectWorkerDirectoryRow(raw);
    if (row === null) return null;
    items.push(row);
  }

  return {
    items,
    scope: value.scope as WorkerDirectoryScope,
    page_size: value.page_size,
    has_more: value.has_more,
    next_cursor: value.next_cursor,
    authorization_date: value.authorization_date,
    summary,
  };
}
