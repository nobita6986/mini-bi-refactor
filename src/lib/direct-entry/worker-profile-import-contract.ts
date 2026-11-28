/**
 * P1.6-I04C3-R3A - Contract import ho so NLĐ day du: `worker-profile/1.0`.
 *
 * Day la CONTRACT PHIA CLIENT (header/alias/field group/validate reference), KHONG phai server DTO.
 * T1B chua phat hanh contract server day du, nen module nay:
 *   - khong dinh nghia payload gui len server;
 *   - khong dinh nghia response;
 *   - khong tham chieu capability/scope/actor.
 *
 * Nguon khoa: docs/security/p1.6-full-worker-profile-capability-projection-matrix.md @ 13bed05
 * (§1.2 D11-D22, §1.3 A1-A3, §3, §8) va task brief T0-LOCKED CONTRACT.
 */
import { normalizePasteHeader } from "./paste-primitives.ts";

/** A1: contract version rieng, KHONG dung lai "direct-entry/1.1". */
export const WORKER_PROFILE_CONTRACT_VERSION = "worker-profile/1.0" as const;

export type WorkerProfileGroup = "entry" | "worker" | "employment" | "payment" | "note" | "derived";

export type WorkerProfileSensitivity =
  | "none"
  | "direct_pii"
  | "financial"
  | "sensitive_free_text"
  | "derived";

export type WorkerProfileRequirement = "required" | "optional" | "conditional" | "derived";

export type WorkerProfileFieldSpec = {
  /** Khoa canonical trong normalized client model. */
  key: string;
  /** Header hien thi tren template/UI moi (A3). */
  canonicalHeader: string;
  /** Alias import (case-insensitive, sau khi normalize). */
  aliases: readonly string[];
  group: WorkerProfileGroup;
  requirement: WorkerProfileRequirement;
  sensitivity: WorkerProfileSensitivity;
  /** false => validation-only: KHONG bao gio vao normalized write model. */
  persisted: boolean;
  /** O giong cong thuc (=, +, -, @) bi tu choi thay vi nhan nhu text tu do. */
  constrained: boolean;
  /** Tham chieu ham validator (ten logic, khong phai DTO). */
  validator: string;
  maxLength?: number;
};

/** A3: "Mã NLĐ" la header hien thi canonical; "Mã số ứng viên" chi la alias import. */
export const WORKER_PROFILE_FIELDS: readonly WorkerProfileFieldSpec[] = Object.freeze([
  // --- B: entry / recruitment (bat buoc) ---
  { key: "employee_code", canonicalHeader: "Mã NLĐ", aliases: ["Mã số ứng viên", "Mã nhân viên"],
    group: "entry", requirement: "required", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "validateEmployeeCode", maxLength: 64 },
  { key: "project_id", canonicalHeader: "Dự án",
    aliases: ["Tên Công ty/Dự án làm việc", "Dự án làm việc", "Công ty/Dự án"],
    group: "entry", requirement: "required", sensitivity: "none", persisted: true,
    constrained: true, validator: "resolveCatalogProject", maxLength: 256 },
  { key: "first_work_date", canonicalHeader: "Ngày bắt đầu làm việc", aliases: ["Ngày vào"],
    group: "entry", requirement: "required", sensitivity: "none", persisted: true,
    constrained: true, validator: "isRealCalendarDate" },
  { key: "display_name", canonicalHeader: "Họ và tên",
    aliases: ["Họ tên NLĐ", "Họ tên", "Tên NLĐ"],
    group: "worker", requirement: "required", sensitivity: "direct_pii", persisted: true,
    constrained: false, validator: "validateDisplayName", maxLength: 256 },
  { key: "recruiter_id", canonicalHeader: "Tên NV Tuyển dụng",
    aliases: ["Người tuyển", "Người tuyển dụng", "Tên nhân viên tuyển dụng",
      "Người tuyển / Vendor"],
    group: "entry", requirement: "required", sensitivity: "none", persisted: true,
    constrained: true, validator: "resolveCatalogRecruiter", maxLength: 256 },
  { key: "labor_type", canonicalHeader: "Loại hình LĐ",
    aliases: ["Loại hình lao động", "Loại hình", "Chính thức"],
    group: "entry", requirement: "required", sensitivity: "none", persisted: true,
    constrained: true, validator: "normalizeLaborType" },

  // --- C: worker identity/profile (tuy chon) ---
  { key: "gender", canonicalHeader: "Giới tính", aliases: [],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "normalizeGender", maxLength: 32 },
  { key: "date_of_birth", canonicalHeader: "DOB", aliases: ["Ngày sinh"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "preserveRawText", maxLength: 10 },
  { key: "national_id", canonicalHeader: "CMT/CCCD", aliases: ["CCCD", "CMT", "Số CCCD"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "isDigitStringOfLength", maxLength: 64 },
  { key: "national_id_issued_at", canonicalHeader: "Ngày cấp", aliases: ["Ngày cấp CCCD"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "preserveRawText", maxLength: 10 },
  { key: "national_id_issued_place", canonicalHeader: "Nơi cấp", aliases: ["Nơi cấp CCCD"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: false, validator: "validateIssuedPlace", maxLength: 256 },
  { key: "address", canonicalHeader: "Địa chỉ hiện tại", aliases: ["Địa chỉ"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: false, validator: "validateAddress", maxLength: 1024 },
  { key: "phone", canonicalHeader: "Số điện thoại", aliases: ["SĐT", "Điện thoại"],
    group: "worker", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: false, validator: "validatePhone", maxLength: 64 },

  // --- B8: entry-level note (D13) ---
  { key: "general_note", canonicalHeader: "Ghi chú", aliases: ["Ghi chú chung"],
    group: "note", requirement: "optional", sensitivity: "sensitive_free_text", persisted: true,
    constrained: false, validator: "validateGeneralNote", maxLength: 4000 },

  // --- E: employment lifecycle (D16: chi cho ho so lich su) ---
  { key: "initial_status", canonicalHeader: "Tình trạng làm việc hiện tại",
    aliases: ["Tình trạng làm việc", "Trạng thái làm việc"],
    group: "employment", requirement: "optional", sensitivity: "none", persisted: true,
    constrained: true, validator: "normalizeEmploymentStatus" },
  { key: "leave_date", canonicalHeader: "Ngày nghỉ thực tế", aliases: ["Ngày nghỉ"],
    group: "employment", requirement: "conditional", sensitivity: "direct_pii", persisted: true,
    constrained: true, validator: "normalizePasteDate" },
  { key: "leave_reason_text", canonicalHeader: "Ghi chú về nghỉ việc",
    aliases: ["Lý do nghỉ", "Ghi chú nghỉ việc"],
    group: "employment", requirement: "conditional", sensitivity: "sensitive_free_text",
    persisted: true, constrained: false, validator: "validateLeaveReason", maxLength: 4000 },

  // --- F: payment ---
  { key: "account_number", canonicalHeader: "STK", aliases: ["Số tài khoản"],
    group: "payment", requirement: "optional", sensitivity: "financial", persisted: true,
    constrained: true, validator: "validateAccountNumber", maxLength: 64 },
  // R4-S02: "Tên ngân hàng" la TEXT metadata de doi chieu, KHONG resolve qua catalog va khong
  // phu thuoc direct_entry_banks. Server luu nguyen van ban (da trim).
  { key: "bank_name", canonicalHeader: "Tên ngân hàng", aliases: ["Ngân hàng"],
    group: "payment", requirement: "optional", sensitivity: "none", persisted: true,
    constrained: true, validator: "validateBankName", maxLength: 256 },
  { key: "account_holder_name", canonicalHeader: "Tên chủ tài khoản", aliases: ["Chủ tài khoản"],
    group: "payment", requirement: "optional", sensitivity: "direct_pii", persisted: true,
    constrained: false, validator: "validateAccountHolder", maxLength: 256 },

  // --- A: derived / validation-only (D5). persisted:false => khong vao write model ---
  { key: "row_index", canonicalHeader: "STT", aliases: [],
    group: "derived", requirement: "derived", sensitivity: "derived", persisted: false,
    constrained: true, validator: "validateDerivedIndex" },
  { key: "effective_month", canonicalHeader: "Tháng", aliases: [],
    group: "derived", requirement: "derived", sensitivity: "derived", persisted: false,
    constrained: true, validator: "validateDerivedMonth" },
  { key: "age_years", canonicalHeader: "Tuổi", aliases: [],
    group: "derived", requirement: "derived", sensitivity: "derived", persisted: false,
    constrained: true, validator: "validateDerivedAge" },
  { key: "team_hint", canonicalHeader: "Chi nhánh/Team", aliases: ["Chi nhánh", "Team"],
    group: "derived", requirement: "derived", sensitivity: "derived", persisted: false,
    constrained: false, validator: "validationHintOnly", maxLength: 256 },
  { key: "provider_hint", canonicalHeader: "Người tuyển dụng (HRP/Vendor)",
    aliases: ["HRP/Vendor"],
    group: "derived", requirement: "derived", sensitivity: "derived", persisted: false,
    constrained: false, validator: "validationHintOnly", maxLength: 32 },
]);

export const WORKER_PROFILE_REQUIRED_HEADERS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.filter((field) => field.requirement === "required")
    .map((field) => field.canonicalHeader),
);

/** Header hien thi tren template UI moi (canonical, khong gom alias import). */
export const WORKER_PROFILE_TEMPLATE_HEADERS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.map((field) => field.canonicalHeader),
);

export const WORKER_PROFILE_DERIVED_KEYS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.filter((field) => !field.persisted).map((field) => field.key),
);

const FIELD_BY_KEY = new Map(WORKER_PROFILE_FIELDS.map((field) => [field.key, field]));

const HEADER_TO_KEY = new Map<string, string>();
for (const field of WORKER_PROFILE_FIELDS) {
  for (const header of [field.canonicalHeader, ...field.aliases]) {
    HEADER_TO_KEY.set(normalizePasteHeader(header), field.key);
  }
}

export function workerProfileField(key: string): WorkerProfileFieldSpec | undefined {
  return FIELD_BY_KEY.get(key);
}

/** true khi header (sau normalize) thuoc vocabulary cua contract. */
export function isKnownWorkerProfileHeader(header: string): boolean {
  return HEADER_TO_KEY.has(normalizePasteHeader(header));
}

/* ------------------------------------------------------------------ issues */

export type WorkerProfileIssue = {
  code: string;
  severity: "error" | "warning";
  /** So dong nguon (1-based). 0 = muc bang/header. */
  row: number;
  /** Khoa canonical cua cot lien quan; null khi loi o muc dong/bang. */
  field: string | null;
};

/**
 * Thong bao tinh, KHONG chua PII: chi noi ve cot/dong/quy tac. Gia tri nguoi dung dan
 * khong bao gio duoc chen vao message.
 */
export const WORKER_PROFILE_ISSUE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PASTE_EMPTY: "Chưa có dữ liệu để dán.",
  PASTE_NO_DATA_ROWS: "Chỉ có dòng header, chưa có dòng dữ liệu nào.",
  PASTE_ROW_LIMIT: "Mỗi lần dán tối đa 100 dòng dữ liệu.",
  PASTE_HEADER_EMPTY: "Dòng header có ô trống; mỗi cột phải có tên cột.",
  PASTE_HEADER_UNKNOWN: "Có tên cột không thuộc danh sách hỗ trợ.",
  PASTE_HEADER_DUPLICATE: "Có hai cột cùng trỏ về một trường dữ liệu.",
  PASTE_HEADER_REQUIRED: "Thiếu cột bắt buộc trong dòng header.",
  PASTE_ROW_CELL_COUNT: "Dòng có nhiều ô hơn số cột của header.",
  PASTE_VALUE_REQUIRED: "Thiếu giá trị bắt buộc.",
  PASTE_FORMULA_CELL: "Ô giống công thức Excel không được chấp nhận ở cột này.",
  PASTE_DATE_INVALID: "Ngày không hợp lệ; dùng YYYY-MM-DD hoặc DD/MM/YYYY.",
  PASTE_DOB_FUTURE: "Ngày sinh không được ở tương lai.",
  PASTE_ISSUED_FUTURE: "Ngày cấp không được ở tương lai.",
  PASTE_ISSUED_BEFORE_DOB: "Ngày cấp không được trước ngày sinh.",
  PASTE_LEAVE_BEFORE_START: "Ngày nghỉ không được trước ngày bắt đầu làm việc.",
  PASTE_LEAVE_REQUIRES_OFF: "Chỉ khai báo ngày nghỉ khi tình trạng làm việc là đã nghỉ.",
  PASTE_LEAVE_MISSING: "Tình trạng đã nghỉ phải có ngày nghỉ thực tế.",
  PASTE_LEAVE_REASON_MISSING: "Tình trạng đã nghỉ phải có ghi chú về nghỉ việc.",
  PASTE_EMPLOYEE_CODE_FORMAT: "Mã NLĐ phải theo dạng hrp-YYYY-NNNNNN.",
  PASTE_EMPLOYEE_CODE_YEAR: "Năm trong mã NLĐ phải khớp năm của ngày bắt đầu làm việc.",
  PASTE_LABOR_TYPE_INVALID: "Loại hình LĐ phải khớp danh mục đang hoạt động cho ngày bắt đầu làm việc.",
  PASTE_GENDER_INVALID: "Giới tính chỉ nhận Nam/Male, Nữ/Female hoặc Khác/Other.",
  PASTE_NATIONAL_ID_INVALID: "CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số.",
  PASTE_STATUS_INVALID: "Tình trạng làm việc chỉ nhận Đang chờ việc/Đang làm/Đã nghỉ.",
  PASTE_ACCOUNT_NUMBER_INVALID: "STK phải có 1-64 ký tự và không chứa ký tự điều khiển.",
  PAYMENT_METADATA_INVALID:
    "Thông tin tài khoản không hợp lệ (độ dài hoặc ký tự điều khiển).",
  PASTE_TEXT_TOO_LONG: "Giá trị vượt quá độ dài cho phép của cột.",
  PASTE_DERIVED_INVALID: "Cột dẫn xuất có giá trị không đọc được nên bị bỏ qua.",
  PASTE_DERIVED_IGNORED: "Cột dẫn xuất không được lưu; hệ thống tự tính lại.",
  PASTE_MONTH_MISMATCH: "Tháng đã dán không khớp tháng của ngày bắt đầu làm việc.",
  PASTE_AGE_MISMATCH: "Tuổi đã dán khác tuổi tính từ ngày sinh.",
  PASTE_ACCOUNT_METADATA_INFO:
    "STK, tên ngân hàng và tên chủ tài khoản là thông tin để đối chiếu, không phải lệnh thanh toán.",
  PASTE_TEAM_CONFIRM: "Hệ thống sẽ xác nhận chi nhánh/team từ danh mục.",
  PASTE_PROVIDER_CONFIRM: "Hệ thống sẽ xác nhận HRP/Vendor từ danh mục.",
  CTV_REQUIRED: "Vui lòng chọn CTV khi nguồn là CTV.",
  PASTE_CATALOG_UNAVAILABLE: "Chưa tải được danh mục cho ngày hiệu lực này.",
  PASTE_CATALOG_MISSING: "Không có trong danh mục của ngày hiệu lực.",
  PASTE_CATALOG_AMBIGUOUS: "Khớp nhiều mục trong danh mục; hãy dùng đúng mã hoặc tên đầy đủ.",
  PASTE_DUPLICATE_EMPLOYEE_CODE: "Mã NLĐ trùng với một dòng khác trong cùng lần dán.",
  PASTE_DUPLICATE_NATIONAL_ID: "CMT/CCCD trùng với một dòng khác trong cùng lần dán.",
  PASTE_DUPLICATE_PHONE: "Số điện thoại trùng với một dòng khác trong cùng lần dán.",
  PASTE_EXISTING_EMPLOYEE_CODE: "Mã NLĐ đã có trong danh sách chưa lưu trên trang.",
  PASTE_EXISTING_NATIONAL_ID: "CMT/CCCD đã có trong danh sách chưa lưu trên trang.",
  PASTE_EXISTING_PHONE: "Số điện thoại đã có trong danh sách chưa lưu trên trang.",
});

export function workerProfileIssueMessage(code: string): string {
  return WORKER_PROFILE_ISSUE_MESSAGES[code] ?? "Dòng dữ liệu không hợp lệ.";
}

export function issue(
  code: string,
  severity: "error" | "warning",
  row: number,
  field: string | null,
): WorkerProfileIssue {
  return { code, severity, row, field };
}

/* ---------------------------------------------------------- header resolve */

export type ResolvedColumn = { index: number; key: string; persisted: boolean };

export type HeaderResolution =
  | { ok: true; columns: ResolvedColumn[]; issues: WorkerProfileIssue[] }
  | { ok: false; columns: ResolvedColumn[]; issues: WorkerProfileIssue[] };

/**
 * Doi chieu dong header: NFC + trim + gop khoang trang + ha case. Khong fuzzy.
 * Thu tu cot tuy y; so cot khong co dinh; cot tuy chon co the vang mat.
 */
export function resolveWorkerProfileHeader(
  cells: readonly string[],
  options: { omittedRequiredKeys?: readonly string[] } = {},
): HeaderResolution {
  const issues: WorkerProfileIssue[] = [];
  const columns: ResolvedColumn[] = [];
  const seen = new Map<string, number>();
  const omittedRequiredKeys = new Set(options.omittedRequiredKeys ?? []);
  for (let index = 0; index < cells.length; index += 1) {
    const raw = cells[index];
    if (raw.trim() === "") {
      issues.push(issue("PASTE_HEADER_EMPTY", "error", 0, null));
      continue;
    }
    const key = HEADER_TO_KEY.get(normalizePasteHeader(raw));
    if (key === undefined) {
      issues.push(issue("PASTE_HEADER_UNKNOWN", "error", 0, null));
      continue;
    }
    if (seen.has(key)) {
      issues.push(issue("PASTE_HEADER_DUPLICATE", "error", 0, key));
      continue;
    }
    seen.set(key, index);
    const spec = FIELD_BY_KEY.get(key);
    columns.push({ index, key, persisted: spec ? spec.persisted : false });
  }
  for (const field of WORKER_PROFILE_FIELDS) {
    if (field.requirement !== "required") continue;
    if (omittedRequiredKeys.has(field.key)) continue;
    if (!seen.has(field.key)) {
      issues.push(issue("PASTE_HEADER_REQUIRED", "error", 0, field.key));
    }
  }
  const ok = issues.length === 0;
  return { ok, columns, issues };
}
