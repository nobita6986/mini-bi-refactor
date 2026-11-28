import type { LaborType } from "../contracts/direct-entry-v1.ts";
import type { DraftProfileProjection, OwnDraft } from "./write-repository";

export type EditableDraftFields = {
  employeeCode: string;
  firstWorkDate: string;
  workerName: string;
  projectId: string;
  recruiterId: string;
  laborType: LaborType;
  providerType: "hrp" | "vendor" | "ctv" | null;
  collaboratorId: string | null;
  profile: DraftProfileProjection;
};

export type DraftSaveState = "clean" | "dirty" | "saving" | "saved" | "conflict" | "error";

export type PendingDraftWrite = {
  key: string;
  fields: EditableDraftFields;
  expectedVersion: number | null;
};

export type ConflictCopy = {
  version: number;
  submissionVersion: number;
  fields: EditableDraftFields;
};

export type CreateDraftResult = {
  entryId: string;
  submissionId: string;
  entryVersion: number;
  submissionVersion: number;
};

export type UpdateDraftResult = {
  entryVersion: number;
  submissionVersion: number;
};

export type LiveDraftRow = EditableDraftFields & {
  rowId: string;
  laborTypeDisplay: string;
  entryId: string | null;
  submissionId: string | null;
  entryVersion: number | null;
  submissionVersion: number | null;
  teamId: string | null;
  teamDisplayName: string;
  projectDisplayName: string;
  recruiterDisplayName: string;
  collaboratorDisplayName: string | null;
  employmentStatus: "UNCONFIRMED" | "ON" | "OFF" | null;
  state: DraftSaveState;
  saved: EditableDraftFields | null;
  pendingWrite: PendingDraftWrite | null;
  conflictCopy: ConflictCopy | null;
  message: string | null;
};

export function draftRowFromProjection(draft: OwnDraft): LiveDraftRow {
  const fields: EditableDraftFields = {
    employeeCode: draft.employee_code,
    firstWorkDate: draft.first_work_date,
    workerName: draft.worker_display_name,
    projectId: draft.project_id,
    recruiterId: draft.recruiter_id,
    laborType: draft.labor_type,
    providerType: draft.provider_type === "vendor"
      ? "vendor"
      : (draft.collaborator_id ? "ctv" : "hrp"),
    collaboratorId: draft.collaborator_id ?? null,
    profile: draft.profile,
  };
  return {
    ...fields,
    rowId: draft.entry_id,
    laborTypeDisplay: draft.labor_type_display,
    entryId: draft.entry_id,
    submissionId: draft.submission_id,
    entryVersion: draft.entry_version,
    submissionVersion: draft.submission_version,
    teamId: draft.team_id,
    teamDisplayName: draft.team_display_name,
    projectDisplayName: draft.project_display_name,
    recruiterDisplayName: draft.recruiter_display_name,
    collaboratorDisplayName: draft.collaborator_display_name ?? null,
    employmentStatus: draft.employment_status,
    state: "clean",
    saved: { ...fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function newDraftRow(rowId: string, firstWorkDate: string): LiveDraftRow {
  return {
    rowId,
    laborTypeDisplay: "",
    entryId: null,
    submissionId: null,
    entryVersion: null,
    submissionVersion: null,
    employeeCode: "",
    firstWorkDate,
    workerName: "",
    projectId: "",
    recruiterId: "",
    laborType: "",
    providerType: null,
    collaboratorId: null,
    teamId: null,
    teamDisplayName: "",
    projectDisplayName: "",
    recruiterDisplayName: "",
    collaboratorDisplayName: null,
    employmentStatus: "ON",
    profile: {
      contract_version: "worker-profile/1.0",
      worker_details: {
        display_name: { state: "omitted" },
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      employment: null,
      payment: null,
    },
    state: "dirty",
    saved: null,
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function editableFields(row: LiveDraftRow): EditableDraftFields {
  return {
    employeeCode: row.employeeCode,
    firstWorkDate: row.firstWorkDate,
    workerName: row.workerName,
    projectId: row.projectId,
    recruiterId: row.recruiterId,
    laborType: row.laborType,
    providerType: row.providerType,
    collaboratorId: row.collaboratorId,
    profile: row.profile,
  };
}

export function buildDraftUpdatePayload(
  fields: EditableDraftFields,
  savedPayment: DraftProfileProjection["payment"] | null,
): Record<string, unknown> | null {
  const payment = fields.profile.payment;
  const paymentChanged = JSON.stringify(payment) !== JSON.stringify(savedPayment);
  if (paymentChanged && (!payment || [
    payment.account_number, payment.bank_name, payment.account_holder_name,
  ].some((field) => field.state === "masked" || field.state === "redacted"))) return null;

  const worker = fields.profile.worker_details;
  const optional = (field: { state: string; value?: string }) => field.state === "provided"
    ? { state: "provided", value: field.value }
    : { state: field.state };
  const text = (field: { state: string; value?: string }) =>
    field.state === "provided" ? field.value : null;
  const paymentText = payment;
  const hasPaymentText = paymentText && [
    paymentText.account_number, paymentText.bank_name, paymentText.account_holder_name,
  ].some((field) => field.state === "provided" && field.value?.trim());
  return {
    project_id: fields.projectId,
    first_work_date: fields.firstWorkDate,
    employee_code: fields.employeeCode,
    worker_details: {
      display_name: fields.workerName,
      gender: optional(worker.gender),
      date_of_birth: optional(worker.date_of_birth),
      national_id: optional(worker.national_id),
      national_id_issued_at: optional(worker.national_id_issued_at),
      national_id_issued_place: optional(worker.national_id_issued_place),
      address: optional(worker.address),
      phone: optional(worker.phone),
    },
    recruiter_id: fields.recruiterId,
    labor_type: fields.laborType,
    collaborator_id: fields.providerType === "vendor" ? null : (fields.collaboratorId ?? null),
    general_note: text(fields.profile.general_note),
    ...(paymentChanged && paymentText ? { payment: {
      state: hasPaymentText ? "provided" : "intentionally_blank",
      account_number: hasPaymentText ? text(paymentText.account_number) : null,
      bank_name: hasPaymentText ? text(paymentText.bank_name) : null,
      account_holder_name: hasPaymentText ? text(paymentText.account_holder_name) : null,
    } } : {}),
  };
}

export function fieldsDiffer(
  left: EditableDraftFields,
  right: EditableDraftFields,
): boolean {
  return left.employeeCode !== right.employeeCode ||
    left.firstWorkDate !== right.firstWorkDate ||
    left.workerName !== right.workerName ||
    left.projectId !== right.projectId ||
    left.recruiterId !== right.recruiterId ||
    left.laborType !== right.laborType ||
    left.providerType !== right.providerType ||
    left.collaboratorId !== right.collaboratorId ||
    JSON.stringify(left.profile) !== JSON.stringify(right.profile);
}

export function updateLiveDraftRow(
  rows: readonly LiveDraftRow[],
  rowId: string,
  patch: Partial<EditableDraftFields>,
): LiveDraftRow[] {
  return rows.map((row) => {
    if (row.rowId !== rowId || row.state === "saving") return row;
    const next = { ...row, ...patch };
    return {
      ...next,
      state: !row.entryId || !row.saved || fieldsDiffer(editableFields(next), row.saved)
        ? "dirty"
        : "clean",
      pendingWrite: row.pendingWrite &&
        !fieldsDiffer(editableFields(next), row.pendingWrite.fields)
        ? row.pendingWrite
        : null,
      conflictCopy: row.state === "conflict" ? row.conflictCopy : null,
      message: null,
    };
  });
}

export function changedDraftFields(
  local: EditableDraftFields,
  server: EditableDraftFields,
): string[] {
  const labels: Array<[keyof EditableDraftFields, string]> = [
    ["employeeCode", "Mã người lao động"],
    ["firstWorkDate", "Ngày đầu tiên đi làm"],
    ["workerName", "Họ tên"],
    ["projectId", "Dự án"],
    ["recruiterId", "Người tuyển"],
    ["laborType", "Loại hình lao động"],
    ["providerType", "Nguồn"],
    ["collaboratorId", "CTV"],
    ["profile", "Thông tin hồ sơ"],
  ];
  return labels.filter(([key]) => local[key] !== server[key]).map(([, label]) => label);
}

export function stableLiveDraftKey(row: LiveDraftRow): string {
  return row.entryId ?? row.rowId;
}

export function acceptDraftCreate(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  result: CreateDraftResult,
): LiveDraftRow {
  const next = {
    ...row,
    rowId: result.entryId,
    entryId: result.entryId,
    submissionId: result.submissionId,
    entryVersion: result.entryVersion,
    submissionVersion: result.submissionVersion,
    saved: { ...pending.fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
  return {
    ...next,
    state: fieldsDiffer(editableFields(next), pending.fields) ? "dirty" : "saved",
  };
}

export function acceptDraftUpdate(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  result: UpdateDraftResult,
): LiveDraftRow {
  const next = {
    ...row,
    entryVersion: result.entryVersion,
    submissionVersion: result.submissionVersion,
    saved: { ...pending.fields },
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
  return {
    ...next,
    state: fieldsDiffer(editableFields(next), pending.fields) ? "dirty" : "saved",
  };
}

export function failDraftWrite(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  message: string,
): LiveDraftRow {
  return { ...row, state: "error", pendingWrite: pending, message };
}

export function markDraftConflict(
  row: LiveDraftRow,
  pending: PendingDraftWrite,
  conflictCopy: ConflictCopy | null,
): LiveDraftRow {
  return {
    ...row,
    state: "conflict",
    pendingWrite: pending,
    conflictCopy,
    message: conflictCopy ? null : "Không tải được bản mới từ máy chủ.",
  };
}

export function applyServerDraft(row: LiveDraftRow): LiveDraftRow {
  if (!row.conflictCopy) return row;
  return {
    ...row,
    ...row.conflictCopy.fields,
    entryVersion: row.conflictCopy.version,
    submissionVersion: row.conflictCopy.submissionVersion,
    saved: { ...row.conflictCopy.fields },
    state: "clean",
    pendingWrite: null,
    conflictCopy: null,
    message: null,
  };
}

export function keepLocalDraft(row: LiveDraftRow): LiveDraftRow {
  if (!row.conflictCopy) return row;
  return {
    ...row,
    entryVersion: row.conflictCopy.version,
    submissionVersion: row.conflictCopy.submissionVersion,
    saved: { ...row.conflictCopy.fields },
    state: "dirty",
    pendingWrite: null,
    conflictCopy: null,
    message: "Nội dung đang nhập được giữ; dữ liệu mới nhất đã được xác nhận. Bấm lưu để gửi lại.",
  };
}
