/**
 * P1.6-W04-S04C-S03B1 - Helper thuan cho change request phia nguoi de xuat (proposer).
 *
 * Pham vi S03B1: CHI `target_kind = ENTRY_FIELD` voi 5 field khong PII:
 *   project_id, first_work_date, employee_code, recruiter_id, labor_type.
 * Khong ho tro cac loai khac: thong tin ca nhan nguoi lao dong, thanh toan, trang thai lam viec,
 * tai lieu (defer, khong gia vo da xong).
 *
 * Khong I/O, khong framework. Validator cua server van la authority cuoi.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { isCanonicalLaborTypeKey, type LaborType } from "../contracts/direct-entry-v1.ts";
import {
  CHANGE_REQUEST_STATES,
  type ChangeRequestState,
} from "./change-request-contract.ts";
import type { ChangeRequestListItem } from "./change-request-read-contract.ts";

export const CHANGE_REQUEST_STATE_LABELS: Readonly<Record<ChangeRequestState, string>> = Object.freeze({
  PENDING: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Đã từ chối",
  WITHDRAWN: "Đã rút",
});

export const PROPOSER_FIELD_ORDER = [
  "employee_code",
  "first_work_date",
  "project_id",
  "recruiter_id",
  "collaborator_id",
  "labor_type",
] as const;

export type ProposerField = (typeof PROPOSER_FIELD_ORDER)[number];

export const PROPOSER_FIELD_LABELS: Readonly<Record<ProposerField, string>> = Object.freeze({
  employee_code: "Mã người lao động",
  first_work_date: "Ngày đầu tiên đi làm",
  project_id: "Dự án",
  recruiter_id: "Người tuyển",
  collaborator_id: "CTV",
  labor_type: "Loại hình lao động",
});

export type ProposerFields = {
  employee_code: string;
  first_work_date: string;
  project_id: string;
  recruiter_id: string;
  collaborator_id?: string | null;
  labor_type: LaborType;
};

/** Mot entry duoc chon de de xuat thay doi: baseline = gia tri server, draft = gia tri nguoi dung. */
export type ProposerEntryDraft = {
  entry_id: string;
  expected_version: number;
  baseline: ProposerFields;
  draft: ProposerFields;
};

export type ProposerItem = {
  entry_id: string;
  target_kind: "ENTRY_FIELD";
  expected_version: number;
  proposal: Record<string, unknown>;
};

export type ProposerErrorCode = "NO_ENTRY" | "DUPLICATE_ENTRY" | "NO_CHANGE" | "ENTRY_VERSION_INVALID";

export type ProposerBuildResult =
  | { ok: true; items: ProposerItem[] }
  | { ok: false; code: ProposerErrorCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Projection toi thieu cho UI de xuat: server da chay projectEntry (strict) tren cung payload;
 * client chi doc lai 5 field khong PII ma no thuc su dung. Cac nhom du lieu nhay cam khac
 * (thong tin ca nhan, thanh toan, tai lieu) KHONG bao gio duoc doc o day.
 */
export type ProposerEntryProjection = ProposerFields & {
  entry_id: string;
  expected_version: number;
  labor_type_display: string;
  provider_type?: "hrp" | "vendor";
  collaborator_id?: string | null;
  collaborator_display_name?: string | null;
};

export function projectProposerEntry(value: unknown): ProposerEntryProjection | null {
  if (!isRecord(value)) return null;
  if (typeof value.entry_id !== "string" || !UUID.test(value.entry_id)) return null;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) ||
      value.version < 1) return null;
  if (typeof value.project_id !== "string" || value.project_id.length < 1 ||
      value.project_id.length > 128) return null;
  if (typeof value.first_work_date !== "string" || !isRealCalendarDate(value.first_work_date)) {
    return null;
  }
  if (typeof value.employee_code !== "string" || value.employee_code.length < 1 ||
      value.employee_code.length > 64) return null;
  if (typeof value.recruiter_id !== "string" || !UUID.test(value.recruiter_id)) return null;
  if (!isCanonicalLaborTypeKey(value.labor_type)) return null;
  if (typeof value.labor_type_display !== "string" || value.labor_type_display.length < 1) return null;
  const collaboratorId = value.collaborator_id === undefined || value.collaborator_id === null
    ? null
    : typeof value.collaborator_id === "string" && value.collaborator_id.trim().length > 0
      ? value.collaborator_id.trim()
      : undefined;
  if (collaboratorId === undefined) return null;
  const collaboratorDisplayName =
    value.collaborator_display_name === undefined || value.collaborator_display_name === null
      ? null
      : typeof value.collaborator_display_name === "string" &&
          value.collaborator_display_name.trim().length > 0
        ? value.collaborator_display_name.trim()
        : undefined;
  if (collaboratorDisplayName === undefined) return null;
  const providerType =
    value.provider_type === "hrp" || value.provider_type === "vendor"
      ? value.provider_type
      : undefined;
  return {
    entry_id: value.entry_id,
    expected_version: value.version,
    project_id: value.project_id,
    first_work_date: value.first_work_date,
    employee_code: value.employee_code,
    recruiter_id: value.recruiter_id,
    collaborator_id: collaboratorId,
    collaborator_display_name: collaboratorDisplayName,
    ...(providerType ? { provider_type: providerType } : {}),
    labor_type: value.labor_type,
    labor_type_display: value.labor_type_display,
  };
}

/** Lay dung cac truong projection tu envelope { ok: true, ... } cua API (fail-closed). */
export function projectionSlice(
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in record)) return null;
    slice[key] = record[key];
  }
  return slice;
}

export function isChangeRequestStateLabel(value: unknown): value is ChangeRequestState {
  return typeof value === "string" && CHANGE_REQUEST_STATES.some((state) => state === value);
}

/** Chi PENDING + can_withdraw (server-derived) moi hien nut rut. can_decide KHONG tao nut o S03B1. */
export function canWithdrawChangeRequest(item: Pick<ChangeRequestListItem, "state" | "can_withdraw">): boolean {
  return item.state === "PENDING" && item.can_withdraw === true;
}

/** Proposal chi gom field thuc su thay doi, thu tu co dinh, khong bao gio chua field ngoai danh sach. */
export function proposalFromDraft(
  baseline: ProposerFields,
  draft: ProposerFields,
): Record<string, unknown> {
  const proposal: Record<string, unknown> = {};
  for (const field of PROPOSER_FIELD_ORDER) {
    if (draft[field] !== baseline[field]) proposal[field] = draft[field];
  }
  return proposal;
}

export function changedProposerFields(
  baseline: ProposerFields,
  draft: ProposerFields,
): ProposerField[] {
  return PROPOSER_FIELD_ORDER.filter((field) => draft[field] !== baseline[field]);
}

export function buildProposerItems(
  drafts: readonly ProposerEntryDraft[],
): ProposerBuildResult {
  if (drafts.length < 1) return { ok: false, code: "NO_ENTRY" };
  const seen = new Set<string>();
  const items: ProposerItem[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.entry_id)) return { ok: false, code: "DUPLICATE_ENTRY" };
    seen.add(draft.entry_id);
    if (!Number.isSafeInteger(draft.expected_version) || draft.expected_version < 1) {
      return { ok: false, code: "ENTRY_VERSION_INVALID" };
    }
    const proposal = proposalFromDraft(draft.baseline, draft.draft);
    if (Object.keys(proposal).length === 0) return { ok: false, code: "NO_CHANGE" };
    items.push({
      entry_id: draft.entry_id,
      target_kind: "ENTRY_FIELD",
      expected_version: draft.expected_version,
      proposal,
    });
  }
  return { ok: true, items };
}

export const PROPOSER_REASON_MAX_LENGTH = 4000;

export function normalizeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 1) return null;
  if (value.length > PROPOSER_REASON_MAX_LENGTH) return value;
  return trimmed;
}

export function proposerErrorMessage(code: ProposerErrorCode): string {
  if (code === "NO_ENTRY") return "Chọn ít nhất một dòng để đề xuất thay đổi.";
  if (code === "DUPLICATE_ENTRY") return "Mỗi dòng chỉ được chọn một lần.";
  if (code === "NO_CHANGE") return "Mỗi dòng được chọn phải có ít nhất một thay đổi.";
  if (code === "ENTRY_VERSION_INVALID") return "Dữ liệu dòng chưa hợp lệ; hãy tải lại trang.";
  return "Yêu cầu thay đổi không hợp lệ.";
}

export function changeRequestErrorMessage(status: number): string {
  if (status === 400) return "Yêu cầu thay đổi không hợp lệ. Vui lòng kiểm tra lại nội dung.";
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không còn quyền thực hiện thao tác này.";
  if (status === 404) return "Không tìm thấy dòng hoặc yêu cầu thay đổi.";
  if (status === 409) return "Dữ liệu đã thay đổi ở nơi khác và vừa được tải lại.";
  return "Không gửi được yêu cầu thay đổi. Vui lòng thử lại.";
}

export function summarizeProposal(proposal: Record<string, unknown>): string {
  const labels: string[] = [];
  for (const field of PROPOSER_FIELD_ORDER) {
    if (field in proposal) labels.push(PROPOSER_FIELD_LABELS[field]);
  }
  return labels.join(", ");
}
