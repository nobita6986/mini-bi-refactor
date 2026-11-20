/**
 * PRE-W2-P1 (T1A) + HF-E - Pure UI model cho "Xuất Excel" (recruited / managed / team / all).
 *
 * Khong React, khong I/O. Client KHONG gui authority: body chi gom `scope` + bo loc + `reason`,
 * dung allowlist cua POST /api/direct-entry/workers/export. Quyen cuoi cung do server session +
 * DB row-audience guard quyet dinh; all-scope export keeps its existing explicit action gate.
 */

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isCanonicalLaborTypeKey, type LaborType } from "../contracts/direct-entry-v1.ts";
import {
  WORKER_DIRECTORY_SEARCH_MAX_LENGTH,
  WORKER_EMPLOYMENT_STATUSES,
  WORKER_PROVIDER_TYPES,
  type WorkerDirectoryScope,
  type WorkerProviderType,
} from "./worker-directory-contract.ts";
import type {
  WorkerDirectoryFilters,
  WorkerOperationsActor,
} from "./worker-operations-model.ts";
import { projectOptionalActionReason } from "./action-reason.ts";

/** Scope xuat duoc server cho phep; `all` chi mo cho Admin/BoD/Kế toán (#90). */
export const WORKER_EXPORT_SCOPES = ["recruited", "managed", "team", "all"] as const;
export type WorkerExportScope = (typeof WORKER_EXPORT_SCOPES)[number];

export const WORKER_EXPORT_REASON_MAX = 4000;

/** Fallback khi 422 khong tra `limit` hop le; khop WORKER_EXPORT_ROW_LIMIT (#86). */
export const WORKER_EXPORT_FALLBACK_LIMIT = 10000;

export const WORKER_EXPORT_LIMIT_MESSAGE_PREFIX = "Danh sách vượt giới hạn";
export const WORKER_EXPORT_EMPTY_FILE_MESSAGE =
  "Tệp xuất trả về không hợp lệ hoặc rỗng. Không có tệp nào được tải xuống; vui lòng thử lại.";

export type WorkerExportEmploymentStatus = (typeof WORKER_EMPLOYMENT_STATUSES)[number];

export type WorkerExportRequestBody = {
  scope: WorkerExportScope;
  project_id: string | null;
  recruiter_id: string | null;
  employment_status: WorkerExportEmploymentStatus | null;
  search: string | null;
  first_work_date_from: string | null;
  first_work_date_to: string | null;
  provider_type: WorkerProviderType | null;
  labor_type: LaborType | null;
  reason: string | null;
};

export function isWorkerExportScope(value: unknown): value is WorkerExportScope {
  return typeof value === "string" &&
    (WORKER_EXPORT_SCOPES as readonly string[]).includes(value);
}

/** Scope tab cua danh sach nao duoc phep xuat; `uploader` hoac `null` => null. */
export function exportScopeForTab(tab: string | null | undefined): WorkerExportScope | null {
  return isWorkerExportScope(tab) ? tab : null;
}

export function isExportableScope(
  scope: WorkerDirectoryScope | "team" | null,
): scope is WorkerExportScope {
  return isWorkerExportScope(scope);
}

/**
 * Offer export beside directory scopes to any resolved business actor. The RPC still verifies
 * the recruiter link / PM assignment; this UI signal does not grant row access.
 */
export function canExportWorkers(actor: WorkerOperationsActor | null): boolean {
  return actor !== null;
}

/**
 * Company-wide export needs current all scope plus an existing admin/reviewer action.
 * The RPC remains authoritative for the scope and row audience.
 */
export function canExportAllWorkers(actor: WorkerOperationsActor | null): boolean {
  if (actor === null) return false;
  if (actor.effective_grants !== undefined) {
    if (!Array.isArray(actor.effective_grants)) return false;
    return actor.effective_grants.some(
      (grant) =>
        grant !== null &&
        typeof grant === "object" &&
        (grant.capability === "entry_admin" || grant.capability === "change_review") &&
        grant.scope_kind === "ALL" &&
        (grant.scope_id === null || grant.scope_id === undefined),
    );
  }
  return actor.scopes.some((scope) => scope.kind === "all") &&
    actor.capabilities.some((capability) =>
      capability === "entry_admin" || capability === "change_review");
}

export type WorkerExportRequestCode =
  | "SCOPE_INVALID"
  | "REASON_INVALID"
  | "REASON_TOO_LONG"
  | "FILTER_INVALID";

export type WorkerExportRequestOutcome =
  | { ok: true; body: WorkerExportRequestBody }
  | { ok: false; code: WorkerExportRequestCode };

function normalizeFilter(value: string): string | null {
  return value === "" ? null : value;
}

export type WorkerExportFilterInput = {
  status: string;
  projectId: string;
  recruiterId: string;
  search?: string;
  firstWorkDateFrom?: string;
  firstWorkDateTo?: string;
  providerType?: string;
  laborType?: string;
};

/**
 * Body theo dung allowlist cua contract: `scope | project_id | recruiter_id | employment_status |
 * search | first_work_date_from | first_work_date_to | provider_type | labor_type | reason`.
 * `scope` la recruited|managed|team|all; action `reason` la tuy chon; filter rong => null.
 * Mot filter la bi tu choi fail-closed, KHONG bao gio bi am tham bo di (se xuat thua du lieu).
 */
export function buildWorkerExportRequest(input: {
  scope: string;
  filters: WorkerExportFilterInput | WorkerDirectoryFilters;
  reason?: string | null;
}): WorkerExportRequestOutcome {
  if (!isWorkerExportScope(input.scope)) return { ok: false, code: "SCOPE_INVALID" };
  if (typeof input.reason === "string" && input.reason.length > WORKER_EXPORT_REASON_MAX) {
    return { ok: false, code: "REASON_TOO_LONG" };
  }
  const reason = projectOptionalActionReason(input.reason, WORKER_EXPORT_REASON_MAX);
  if (!reason.ok) return { ok: false, code: "REASON_INVALID" };

  const status = input.filters.status;
  if (status !== "" &&
      !(WORKER_EMPLOYMENT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  const rawSearch = input.filters.search ?? "";
  if ([...rawSearch].length > WORKER_DIRECTORY_SEARCH_MAX_LENGTH ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(rawSearch)) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  const search = rawSearch.trim() === "" ? null : rawSearch.trim();
  const dateFrom = (input.filters.firstWorkDateFrom ?? "").trim();
  if (dateFrom !== "" && !isRealCalendarDate(dateFrom)) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  const dateTo = (input.filters.firstWorkDateTo ?? "").trim();
  if (dateTo !== "" && !isRealCalendarDate(dateTo)) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  if (dateFrom !== "" && dateTo !== "" && dateFrom > dateTo) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  const providerType = (input.filters.providerType ?? "").trim();
  if (providerType !== "" &&
      !(WORKER_PROVIDER_TYPES as readonly string[]).includes(providerType)) {
    return { ok: false, code: "FILTER_INVALID" };
  }
  const laborType = (input.filters.laborType ?? "").trim();
  if (laborType !== "" && !isCanonicalLaborTypeKey(laborType)) {
    return { ok: false, code: "FILTER_INVALID" };
  }

  return {
    ok: true,
    body: {
      scope: input.scope,
      project_id: normalizeFilter(input.filters.projectId),
      recruiter_id: normalizeFilter(input.filters.recruiterId),
      employment_status: status === "" ? null : (status as WorkerExportEmploymentStatus),
      search,
      first_work_date_from: dateFrom === "" ? null : dateFrom,
      first_work_date_to: dateTo === "" ? null : dateTo,
      provider_type: providerType === "" ? null : (providerType as WorkerProviderType),
      labor_type: laborType === "" ? null : laborType,
      reason: reason.value,
    },
  };
}

/** Copy loi request (khong lo UUID/raw DB/PII). */
export function workerExportRequestMessage(code: WorkerExportRequestCode): string {
  if (code === "SCOPE_INVALID") {
    return "Chỉ xuất được ở \"Người tôi tuyển\", \"Dự án tôi quản lý\", \"Nhóm tôi quản lý\" và \"Toàn bộ NLĐ\".";
  }
  if (code === "REASON_TOO_LONG") {
    return "Lý do xuất tối đa " + String(WORKER_EXPORT_REASON_MAX) + " ký tự.";
  }
  if (code === "FILTER_INVALID") {
    return "Bộ lọc không hợp lệ. Vui lòng chọn lại rồi thử lại.";
  }
  return "Lý do xuất không hợp lệ.";
}

/** Doc `limit` tu envelope 422 cua server; fallback hang so khi thieu/khong hop le. */
export function workerExportRowLimit(payload: unknown): number {
  if (typeof payload === "object" && payload !== null) {
    const value = (payload as Record<string, unknown>).limit;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return WORKER_EXPORT_FALLBACK_LIMIT;
}

/**
 * Copy loi phan hoi (khong lo response body/UUID/raw DB). 422 row-limit phai noi ro gioi han va
 * huong dan thu hep bo loc — khong bao gio tai file thieu dong.
 */
export function workerExportErrorMessage(status: number, payload: unknown): string {
  if (status === 0) return "Không kết nối được tới máy chủ. Vui lòng kiểm tra kết nối mạng rồi thử lại.";
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền xuất danh sách người lao động.";
  if (status === 404) return "Chức năng xuất Excel chưa được bật.";
  if (status === 429) return "Thao tác quá nhanh. Vui lòng chờ giây lát rồi thử lại.";
  if (status === 422) {
    return WORKER_EXPORT_LIMIT_MESSAGE_PREFIX + " " + String(workerExportRowLimit(payload)) +
      " dòng. Vui lòng thu hẹp bộ lọc (dự án, người tuyển, trạng thái làm việc) rồi thử lại.";
  }
  if (status === 400) return "Yêu cầu xuất không hợp lệ. Vui lòng kiểm tra lại bộ lọc và lý do.";
  return "Không xuất được danh sách. Vui lòng thử lại.";
}

const NON_XLSX_MIME_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

const ALLOWED_XLSX_MIME_TYPES = new Set([
  "",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

/** Kich thuoc toi thieu cua mot ZIP Local File Header (`PK\x03\x04` = 30 bytes). */
export const MIN_XLSX_ZIP_BYTES = 30;

/**
 * Kiem tra 4 byte dau cua goi OpenXML/ZIP `.xlsx` (`0x50 0x4B 0x03 0x04` = `"PK\x03\x04"`).
 * Tu choi binary loi, text/JSON ngụy trang `application/octet-stream`, hoac ZIP rong (`PK\x05\x06`).
 */
export function hasXlsxZipSignature(headerBytes: ArrayBuffer | Uint8Array): boolean {
  const bytes = headerBytes instanceof Uint8Array ? headerBytes : new Uint8Array(headerBytes);
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Xac minh Blob xuat Excel thuc su la tep ZIP/XLSX hop le truoc khi kich hoat tai tep va bao thanh cong.
 */
export async function isUsableWorkerExportBlob(
  blob: Pick<Blob, "size" | "type" | "slice"> | null | undefined,
  contentTypeHeader?: string | null,
): Promise<boolean> {
  if (
    !blob ||
    typeof blob.size !== "number" ||
    !Number.isFinite(blob.size) ||
    blob.size < MIN_XLSX_ZIP_BYTES ||
    typeof blob.slice !== "function"
  ) {
    return false;
  }
  const headerMime = (contentTypeHeader ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const blobMime = (blob.type ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (headerMime && (NON_XLSX_MIME_TYPES.has(headerMime) || !ALLOWED_XLSX_MIME_TYPES.has(headerMime))) {
    return false;
  }
  if (blobMime && (NON_XLSX_MIME_TYPES.has(blobMime) || !ALLOWED_XLSX_MIME_TYPES.has(blobMime))) {
    return false;
  }
  try {
    const headerSlice = blob.slice(0, 4);
    if (!headerSlice || typeof headerSlice.arrayBuffer !== "function") {
      return false;
    }
    const headerBuffer = await headerSlice.arrayBuffer();
    return hasXlsxZipSignature(headerBuffer);
  } catch {
    return false;
  }
}

const XLSX_FILENAME = /^[A-Za-z0-9._-]+\.xlsx$/;

/**
 * Filename an toan: uu tien ten server tra qua `content-disposition`, chi nhan basename .xlsx
 * (khong path separator); neu thieu/khong hop le dung fallback co dinh theo ngay.
 */
export function workerExportFilename(
  contentDisposition: string | null,
  fallbackDate: string,
): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/);
  const candidate = match?.[1] ?? "";
  if (XLSX_FILENAME.test(candidate) && !candidate.includes("..")) return candidate;
  const safeDate = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fallbackDate)
    ? fallbackDate
    : new Date().toISOString().slice(0, 10);
  return "danh-sach-nguoi-lao-dong-" + safeDate + ".xlsx";
}
