/**
 * Pure Vietnamese presentation formatters for Worker Edit History.
 * Zero I/O, zero `server-only`, never falls back to raw JSON or English enum codes.
 */

import {
  genderUiLabel,
  WORK_STATUS_UI_FALLBACK,
  workStatusUiLabel,
} from "../direct-entry/display-labels.ts";
import { MISSING_DOCUMENT_TYPE_LABELS } from "../direct-entry/cccd-review-contract.ts";
import { workerDocumentStatusLabel } from "../direct-entry/worker-detail-projection.ts";
import { WORKER_PROVIDER_TYPE_LABELS } from "../direct-entry/worker-operations-model.ts";
import { activeLaborTypeLabel } from "../direct-entry/labor-type-catalog-ui.ts";
import type { DraftCatalogLaborType } from "../direct-entry/write-repository.ts";

const OPTIONAL_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  omitted: "Chưa cung cấp",
  unknown: "Chưa xác định",
  intentionally_blank: "Để trống",
  redacted: "Được ẩn theo quyền hiện hành",
  hidden: "Được ẩn theo quyền hiện hành",
  masked: "Được ẩn theo quyền hiện hành",
  restricted: "Được ẩn theo quyền hiện hành",
});

const REDACTED_RAW_TOKENS = new Set(["[REDACTED]", "[HIDDEN]", "REDACTED", "HIDDEN"]);
const HIDDEN_STATE_LABEL = "Được ẩn theo quyền hiện hành";
const NON_DISPLAYABLE_OBJECT_LABEL = "Không có dữ liệu hiển thị";

const CANONICAL_LABOR_TYPE_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  TEMPORARY: "Thời vụ",
  PERMANENT: "Chính thức",
  OFFICIAL: "Chính thức",
  OUTSOURCED: "Gia công",
});

const PAYMENT_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  provided: "Đã cung cấp",
  omitted: "Chưa cung cấp",
  unknown: "Chưa xác định",
  intentionally_blank: "Để trống",
  redacted: HIDDEN_STATE_LABEL,
  hidden: HIDDEN_STATE_LABEL,
  masked: HIDDEN_STATE_LABEL,
  restricted: HIDDEN_STATE_LABEL,
});

const EXTRA_DOCUMENT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  UPLOADED: "Đã tải lên",
  VERIFIED: "Đã xác minh",
  APPROVED: "Đã duyệt",
  DELETED: "Đã xóa",
  VOIDED: "Đã hủy",
});

export const WORKER_HISTORY_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  display_name: "Họ và tên",
  gender: "Giới tính",
  date_of_birth: "Ngày sinh",
  national_id: "CCCD",
  national_id_issued_at: "Ngày cấp CCCD",
  national_id_issued_place: "Nơi cấp CCCD",
  address: "Địa chỉ",
  phone: "Số điện thoại",
  employee_code: "Mã NLĐ",
  project_id: "Dự án",
  project_name: "Dự án",
  provider_type: "Nguồn tuyển",
  team_id: "Nhóm",
  team_name: "Nhóm",
  recruiter_id: "Người tuyển",
  recruiter_name: "Người tuyển",
  labor_type: "Loại hình lao động",
  first_work_date: "Ngày đầu làm việc",
  employment_status: "Trạng thái làm việc",
  status: "Trạng thái làm việc",
  effective_date: "Ngày hiệu lực",
  leave_date: "Ngày nghỉ việc",
  leave_reason_text: "Lý do nghỉ việc",
  leave_reason: "Lý do nghỉ việc",
  voided_at: "Thời điểm rút hồ sơ trùng",
  payment: "Thông tin tài khoản ngân hàng",
  state: "Trạng thái dữ liệu",
  account_number: "Số tài khoản",
  account_holder_name: "Tên chủ tài khoản",
  bank_id: "Mã ngân hàng",
  bank_name: "Ngân hàng",
  worker_details: "Thông tin cá nhân",
  document_metadata: "Hồ sơ / ảnh",
  document_lifecycle: "Trạng thái hồ sơ / ảnh",
  documents: "Hồ sơ / ảnh",
  document_type: "Loại tài liệu",
  upload_status: "Trạng thái tải lên",
  event_status: "Trạng thái tài liệu",
  scan_status: "Trạng thái quét",
  validation_status: "Trạng thái kiểm tra",
  size_bytes: "Dung lượng tệp",
  mime_type: "Định dạng tệp",
  ENTRY_VOID: "Rút hồ sơ trùng",
  general_note: "Ghi chú chung",
  vendor_id: "Nhà cung cấp",
  deleted_at: "Thời điểm xóa",
  entry_created: "Tạo hồ sơ NLĐ",
  submission_created: "Tạo lượt nộp hồ sơ",
  change_request_created: "Tạo yêu cầu thay đổi",
  cccd_reconciliation_status: "Trạng thái đối chiếu CCCD",
  create: "Tạo mới",
  version: "Phiên bản",
});

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  entry_privileged_edit: "Sửa thông tin hồ sơ",
  entry_create: "Nhập mới hồ sơ NLĐ",
  entry_created: "Nhập mới hồ sơ NLĐ",
  full_profile_batch_create: "Nhập mới hồ sơ theo lô",
  batch_create: "Nhập mới hồ sơ theo lô",
  entry_void: "Rút hồ sơ trùng",
  draft_row_create: "Thêm dòng nháp",
  draft_row_update: "Cập nhật dòng nháp",
  draft_row_delete: "Xóa dòng nháp",
  submission_create: "Tạo lượt nộp hồ sơ",
  submission_created: "Tạo lượt nộp hồ sơ",
  submission_transition: "Chuyển trạng thái lượt nộp",
  employment_status_apply: "Cập nhật trạng thái làm việc",
  "employment_status.apply": "Cập nhật trạng thái làm việc",
  employment_status_correct: "Điều chỉnh trạng thái làm việc",
  payment_update: "Cập nhật tài khoản ngân hàng",
  payment_edit: "Cập nhật tài khoản ngân hàng",
  document_metadata_create: "Khởi tạo thông tin tài liệu",
  document_direct_reserve: "Đăng ký tải lên tài liệu",
  document_direct_finalize: "Hoàn tất tải lên tài liệu",
  document_upload: "Tải lên tài liệu",
  document_worker_callback: "Xử lý kết quả quét tài liệu",
  change_request_create: "Tạo yêu cầu thay đổi",
  change_request_created: "Tạo yêu cầu thay đổi",
  change_request_approve: "Duyệt yêu cầu thay đổi",
  change_request_reject: "Từ chối yêu cầu thay đổi",
  change_request_withdraw: "Rút yêu cầu thay đổi",
  cccd_qr_autofill_blank_fields: "Tự động điền từ mã QR CCCD",
  cccd_review_manual_update_worker_details: "Cập nhật thủ công thông tin CCCD",
  cccd_review_standardize_from_qr: "Chuẩn hóa thông tin từ mã QR CCCD",
  cccd_review_update_entered_cccd: "Cập nhật số CCCD đã nhập",
  worker_export: "Xuất danh sách NLĐ",
});

const AUDIT_OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  APPLIED: "Đã áp dụng",
  SUCCEEDED: "Thành công",
  ALLOW: "Được phép",
  ALLOWED: "Được phép",
  DENY: "Bị từ chối quyền",
  DENIED: "Bị từ chối quyền",
  REJECTED: "Bị từ chối",
  FAILED: "Thất bại",
  CONFLICT: "Xung đột dữ liệu",
  NOOP: "Không thay đổi",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type UnwrappedValue =
  | { resolved: true; label: string }
  | { resolved: false; value: unknown };

function unwrapOptionalWrapper(raw: unknown): UnwrappedValue {
  let current: unknown = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isRecord(current) && typeof current.state === "string") {
      const normalizedState = current.state.trim().toLowerCase();
      if (normalizedState === "provided") {
        current = current.value;
        continue;
      }
      const stateLabel = OPTIONAL_STATE_LABELS[normalizedState];
      if (stateLabel) return { resolved: true, label: stateLabel };
      return { resolved: true, label: NON_DISPLAYABLE_OBJECT_LABEL };
    }
    break;
  }

  if (typeof current === "string") {
    const trimmed = current.trim();
    if (REDACTED_RAW_TOKENS.has(trimmed.toUpperCase())) {
      return { resolved: true, label: HIDDEN_STATE_LABEL };
    }
  }

  return { resolved: false, value: current };
}

/** Format arbitrary primitive/optional/empty values without ever falling back to JSON. */
export function formatPlainValue(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() === "" ? "—" : value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map(formatPlainValue).join(", ");
  }
  return NON_DISPLAYABLE_OBJECT_LABEL;
}

/** Format gender enum (`MALE`/`FEMALE`/`OTHER`) via `genderUiLabel`. */
export function formatGenderValue(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return "Không xác định";
  if (value.trim() === "") return "—";

  const label = genderUiLabel(value);
  if (label === "") return "—";
  if (label === "—") return "Không xác định";
  return label;
}

/** Format labor type key using active catalog first, then canonical fallback. */
export function formatLaborTypeValue(
  raw: unknown,
  laborTypes?: readonly DraftCatalogLaborType[],
): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return "Không xác định";

  const trimmed = value.trim();
  if (trimmed === "") return "—";

  const exactCatalogLabel = activeLaborTypeLabel(laborTypes, trimmed);
  if (exactCatalogLabel) return exactCatalogLabel;

  const upper = trimmed.toUpperCase();
  const ciCatalogLabel = laborTypes?.find(
    (option) => option.labor_type_key.trim().toUpperCase() === upper,
  )?.display_name;
  if (ciCatalogLabel) return ciCatalogLabel;

  return CANONICAL_LABOR_TYPE_FALLBACKS[upper] ?? "Không xác định";
}

/** Format provider type (`hrp`/`vendor`) via `WORKER_PROVIDER_TYPE_LABELS`. */
export function formatProviderTypeValue(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return "Không xác định";

  const key = value.trim().toLowerCase();
  if (key === "") return "—";
  return (WORKER_PROVIDER_TYPE_LABELS as Readonly<Record<string, string>>)[key] ?? "Không xác định";
}

/** Format employment status (`ON`/`OFF`/`UNCONFIRMED`/`PENDING`) via `workStatusUiLabel`. */
export function formatEmploymentStatusValue(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return WORK_STATUS_UI_FALLBACK;
  if (value.trim() === "") return "—";

  return workStatusUiLabel(value);
}

/** Format payment state (`provided`/`omitted`/`unknown`/`intentionally_blank`/redacted). */
export function formatPaymentStateValue(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return "Không xác định";

  const key = value.trim().toLowerCase();
  if (key === "") return "—";
  return PAYMENT_STATE_LABELS[key] ?? "Không xác định";
}

/** Format document type (`WORKER_PORTRAIT`, `CCCD_FRONT`, `CCCD_BACK`, `EMPLOYMENT_CONTRACT`). */
export function formatDocumentTypeLabel(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (typeof value !== "string" || value.trim() === "") return "Tài liệu khác";
  const upper = value.trim().toUpperCase();
  return (MISSING_DOCUMENT_TYPE_LABELS as Readonly<Record<string, string>>)[upper] ?? "Tài liệu khác";
}

/** Format document upload/validation/scan/event status in Vietnamese. */
export function formatDocumentStatusLabel(raw: unknown): string {
  const unwrapped = unwrapOptionalWrapper(raw);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (isRecord(value) || Array.isArray(value)) return NON_DISPLAYABLE_OBJECT_LABEL;
  if (typeof value !== "string") return "Không xác định";

  const upper = value.trim().toUpperCase();
  if (upper === "") return "—";
  return EXTRA_DOCUMENT_STATUS_LABELS[upper] ?? workerDocumentStatusLabel(upper);
}

/** Format a snapshot field value by leaf field semantics while unwrapping `{ state }` objects. */
export function formatSnapshotFieldValue(
  field: string,
  rawValue: unknown,
  options?: {
    laborTypes?: readonly DraftCatalogLaborType[];
    formatDateTime?: (value: string) => string;
  },
): string {
  const unwrapped = unwrapOptionalWrapper(rawValue);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  const leaf = field.split(".").at(-1) ?? field;

  switch (leaf) {
    case "gender":
      return formatGenderValue(value);
    case "labor_type":
      return formatLaborTypeValue(value, options?.laborTypes);
    case "provider_type":
      return formatProviderTypeValue(value);
    case "employment_status":
    case "status":
      return formatEmploymentStatusValue(value);
    case "state":
      return formatPaymentStateValue(value);
    case "document_type":
      return formatDocumentTypeLabel(value);
    case "upload_status":
    case "event_status":
    case "scan_status":
    case "validation_status":
      return formatDocumentStatusLabel(value);
    case "voided_at":
      if (typeof value === "string" && value.trim() !== "") {
        return options?.formatDateTime ? options.formatDateTime(value) : value;
      }
      return formatPlainValue(value);
    default:
      return formatPlainValue(value);
  }
}

/** Translate a snapshot/audit field key into Vietnamese. */
export function formatFieldLabel(field: string): string {
  const trimmed = field.trim();
  if (trimmed === "") return "—";
  const leaf = trimmed.split(".").at(-1) ?? trimmed;
  return WORKER_HISTORY_FIELD_LABELS[trimmed] ?? WORKER_HISTORY_FIELD_LABELS[leaf] ?? "Thông tin khác";
}

/** Summarize changed field keys as deduplicated Vietnamese labels joined with ", ". */
export function formatChangedFieldsSummary(fields: unknown): string {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const field of fields) {
    if (typeof field !== "string" || field.trim() === "") continue;
    const label = formatFieldLabel(field);
    if (label === "—" || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.join(", ");
}

/** Translate an audit action code into Vietnamese. */
export function formatAuditActionLabel(action: unknown): string {
  const unwrapped = unwrapOptionalWrapper(action);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (typeof value !== "string" || value.trim() === "") return "Thao tác hệ thống khác";
  const trimmed = value.trim();
  return AUDIT_ACTION_LABELS[trimmed] ?? AUDIT_ACTION_LABELS[trimmed.toLowerCase()] ?? "Thao tác hệ thống khác";
}

/** Summarize audit action codes as deduplicated Vietnamese labels joined with ", ". */
export function formatAuditActionsSummary(actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const action of actions) {
    if (typeof action !== "string" || action.trim() === "") continue;
    const label = formatAuditActionLabel(action);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.join(", ");
}

/** Translate an audit outcome code into Vietnamese. */
export function formatAuditOutcomeLabel(outcome: unknown): string {
  const unwrapped = unwrapOptionalWrapper(outcome);
  if (unwrapped.resolved) return unwrapped.label;

  const value = unwrapped.value;
  if (value === null || value === undefined) return "—";
  if (typeof value !== "string") return "Không xác định";
  const upper = value.trim().toUpperCase();
  if (upper === "") return "—";
  return AUDIT_OUTCOME_LABELS[upper] ?? "Không xác định";
}
