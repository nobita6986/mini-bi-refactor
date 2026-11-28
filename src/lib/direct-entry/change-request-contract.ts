/**
 * P1.6-W04-S04C-S02A - Hop dong change request (create/withdraw/decision).
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (capability change_request_create/change_review, scope tung entry, self-review,
 * OCC, idempotency, atomic multi-entry) do RPC public.direct_entry_*_change_request quyet dinh.
 *
 * Vocabulary item/proposal lay DUNG theo migration 20261002170000
 * (direct_entry_create_change_request va direct_entry_apply_change_item), khong mo rong them.
 */
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  DOCUMENT_MAX_BYTES_HARD_LIMIT,
  DOCUMENT_MIME_TYPES,
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
} from "../contracts/direct-entry-v1.ts";
import { isDocumentType } from "./document-upload-contract.ts";
import { projectPaymentInput } from "./payment-contract.ts";
import { findForbiddenClientField as findCoreForbiddenField } from "./submission-transition-contract.ts";
import { projectOptionalActionReason } from "./action-reason.ts";

export const CHANGE_REQUEST_TARGET_KINDS = [
  "ENTRY_FIELD",
  "PAYMENT",
  "WORK_STATUS",
  "DOCUMENT",
  "ENTRY_VOID",
] as const;

export type ChangeRequestTargetKind = (typeof CHANGE_REQUEST_TARGET_KINDS)[number];

export const CHANGE_REQUEST_STATES = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"] as const;

export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export const CHANGE_REQUEST_DECISIONS = ["approve", "reject"] as const;

export type ChangeRequestDecision = (typeof CHANGE_REQUEST_DECISIONS)[number];

export const CHANGE_REQUEST_DECISION_STATES: Readonly<Record<ChangeRequestDecision, ChangeRequestState>> =
  Object.freeze({ approve: "APPROVED", reject: "REJECTED" });

export const CHANGE_REQUEST_MAX_ITEMS = 100;
export const REASON_MAX_LENGTH = 4000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export const CREATE_REQUEST_KEYS = ["items", "reason", "idempotency_key"] as const;
export const WITHDRAW_REQUEST_KEYS = ["expected_version", "idempotency_key"] as const;
export const DECISION_REQUEST_KEYS = ["decision", "expected_version", "reason", "idempotency_key"] as const;
export const ITEM_KEYS = ["entry_id", "target_kind", "expected_version", "proposal"] as const;

export const PROPOSAL_KEYS: Readonly<Record<ChangeRequestTargetKind, readonly string[]>> = Object.freeze({
  ENTRY_FIELD: [
    "project_id", "first_work_date", "employee_code", "worker_details",
    "recruiter_id", "labor_type", "collaborator_id",
  ],
  PAYMENT: ["state", "account_number", "bank_id", "account_holder_name"],
  WORK_STATUS: ["status", "effective_date", "leave_reason"],
  DOCUMENT: ["document_type", "idempotency_key", "checksum_sha256", "size_bytes", "mime_type"],
  ENTRY_VOID: [],
});

const PROPOSAL_VOCABULARY: readonly string[] = Object.freeze([...new Set(Object.values(PROPOSAL_KEYS).flat())]);

/** Key nghiep vu ben trong worker_details (OptionalValue dung state/value). */
const WORKER_DETAILS_KEYS: readonly string[] = Object.freeze([
  "display_name", "date_of_birth", "national_id", "address", "phone", "state", "value",
]);

// P3.1-W02C-R1: labor type la catalog dong - chi con predicate hinh dang canonical key.
const WORKER_STATUSES = ["UNCONFIRMED", "ON", "OFF"] as const;

/** S03B4A: vocabulary trang thai lam viec dung chung cho read projection (khong doi validator). */
export const WORK_STATUS_VALUES = WORKER_STATUSES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Truong authority/derived rieng cho change request. Danh sach loi (actor, role, capability,
 * scope, owner, created_by, audit, revision, state, version ...) duoc TAI SU DUNG tu S01A
 * qua findCoreForbiddenField de tranh hai danh sach song song bi lech nhau.
 */
const CHANGE_REQUEST_EXTRA_FORBIDDEN = new Set([
  "proposer",
  "proposerid",
  "proposeruserid",
  "reviewer",
  "reviewerid",
  "revieweruserid",
  "decidedby",
  "decidedbyuserid",
  "decidedat",
  "decisionreason",
  "decisionreasonid",
  "decisionat",
  "lifecycle",
  "outcome",
  "result",
  "reused",
  "requeststate",
  "requestversion",
  "itemid",
  "itemsapplied",
  "affected",
  "affectedentries",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH && value.trim() !== "" &&
    !hasControlCharacter(value);
}

function isReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.length <= REASON_MAX_LENGTH;
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && isRealCalendarDate(value);
}

export function isChangeRequestTargetKind(value: unknown): value is ChangeRequestTargetKind {
  return typeof value === "string" && CHANGE_REQUEST_TARGET_KINDS.some((kind) => kind === value);
}

export function isChangeRequestState(value: unknown): value is ChangeRequestState {
  return typeof value === "string" && CHANGE_REQUEST_STATES.some((state) => state === value);
}

export function isChangeRequestDecision(value: unknown): value is ChangeRequestDecision {
  return typeof value === "string" && CHANGE_REQUEST_DECISIONS.some((decision) => decision === value);
}

/**
 * Quet truong authority o moi do sau.
 * - exemptKeys: cac key HOP LE cua chinh object dang xet (da duoc kiem exact-shape rieng),
 *   nen bo qua buoc kiem authority cho chinh key do nhung VAN quet sau vao value cua no.
 * - findCoreForbiddenField duoc goi tren mot wrapper chi chua key (value = null) de chi kiem
 *   TEN truong, khong de no tu quet sau (tranh bao nham `state` hop le cua proposal PAYMENT).
 * - S03B4A: gia tri worker_details dung OptionalValue ({ state, value }) nen khi quet sau vao
 *   worker_details phai mien cac key nghiep vu cua no; hinh dang van duoc validator + DB check
 *   constraint kiem rieng (server la authority).
 */
export function findForbiddenChangeRequestField(
  value: unknown,
  envelopeKeys: readonly string[] = [],
): { field: string } | null {
  const scan = (
    current: unknown,
    path: string,
    exemptKeys: readonly string[],
    insideWorkerDetails: boolean,
  ): { field: string } | null => {
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const nested = scan(current[index], path + "[" + index + "]", [], insideWorkerDetails);
        if (nested) return nested;
      }
      return null;
    }
    if (!isRecord(current)) return null;
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      const childPath = path === "" ? key : path + "." + key;
      // Key nghiep vu cua worker_details (ke ca OptionalValue state/value o moi do sau) khong phai
      // truong authority; hinh dang van duoc validator + DB check constraint kiem rieng.
      const workerKey = insideWorkerDetails && WORKER_DETAILS_KEYS.includes(key);
      if (!exemptKeys.includes(key) && !workerKey) {
        if (CHANGE_REQUEST_EXTRA_FORBIDDEN.has(normalized)) return { field: childPath };
        const core = findCoreForbiddenField({ [key]: null }, path);
        if (core) return core;
      }
      const childExempt = key === "proposal" ? PROPOSAL_VOCABULARY : [];
      const nested = scan(child, childPath, childExempt,
        insideWorkerDetails || key === "worker_details");
      if (nested) return nested;
    }
    return null;
  };
  return scan(value, "", envelopeKeys, false);
}
export type ChangeRequestItem = {
  entry_id: string;
  target_kind: ChangeRequestTargetKind;
  expected_version: number;
  proposal: Record<string, unknown>;
};

export type ChangeRequestCreateInput = {
  items: ChangeRequestItem[];
  reason: string | null;
  idempotency_key: string;
};

export type ChangeRequestWithdrawInput = {
  expected_version: number;
  idempotency_key: string;
};

export type ChangeRequestDecisionInput = {
  decision: ChangeRequestDecision;
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};

export type ChangeRequestProjection<T> =
  | { ok: true; value: T }
  | { ok: false; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN"; field: string }
  | { ok: false; code: "DOCUMENT_CHANGE_REQUEST_UNSUPPORTED" }
  | { ok: false; code: "CHANGE_REQUEST_INVALID" };

const INVALID = { ok: false, code: "CHANGE_REQUEST_INVALID" } as const;

function projectEntryFieldProposal(value: Record<string, unknown>): Record<string, unknown> | null {
  const allowed = PROPOSAL_KEYS.ENTRY_FIELD;
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return null;
  const proposal: Record<string, unknown> = {};
  if ("project_id" in value) {
    if (typeof value.project_id !== "string" || !SAFE_REF.test(value.project_id)) return null;
    proposal.project_id = value.project_id;
  }
  if ("first_work_date" in value) {
    if (!isCalendarDate(value.first_work_date)) return null;
    proposal.first_work_date = value.first_work_date;
  }
  if ("employee_code" in value) {
    if (
      typeof value.employee_code !== "string" ||
      hasControlCharacter(value.employee_code) ||
      validateEmployeeCode(value.employee_code).length > 0
    ) return null;
    proposal.employee_code = value.employee_code;
  }
  if ("worker_details" in value) {
    if (!isRecord(value.worker_details)) return null;
    proposal.worker_details = value.worker_details;
  }
  if ("recruiter_id" in value) {
    if (typeof value.recruiter_id !== "string" || !UUID.test(value.recruiter_id)) return null;
    proposal.recruiter_id = value.recruiter_id;
  }
  if ("labor_type" in value) {
    if (typeof value.labor_type !== "string" ||
        !isCanonicalLaborTypeKey(value.labor_type)) return null;
    proposal.labor_type = value.labor_type;
  }
  if ("collaborator_id" in value) {
    if (value.collaborator_id === null) {
      proposal.collaborator_id = null;
    } else if (typeof value.collaborator_id === "string" &&
               SAFE_REF.test(value.collaborator_id.trim())) {
      proposal.collaborator_id = value.collaborator_id.trim();
    } else {
      return null;
    }
  }
  return proposal;
}

function projectPaymentProposal(value: Record<string, unknown>): Record<string, unknown> | null {
  const payment = projectPaymentInput(value);
  if (!payment) return null;
  return {
    state: payment.state,
    account_number: payment.account_number,
    bank_id: payment.bank_id,
    account_holder_name: payment.account_holder_name,
  };
}

function projectWorkStatusProposal(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!hasOnlyKeys(value, PROPOSAL_KEYS.WORK_STATUS)) return null;
  if (typeof value.status !== "string" ||
      !WORKER_STATUSES.some((status) => status === value.status)) return null;
  if (!isCalendarDate(value.effective_date)) return null;
  if (value.status === "OFF") {
    if (!isReason(value.leave_reason)) return null;
    return { status: value.status, effective_date: value.effective_date, leave_reason: value.leave_reason };
  }
  if (value.leave_reason !== undefined && value.leave_reason !== null) return null;
  return { status: value.status, effective_date: value.effective_date, leave_reason: null };
}

function projectDocumentProposal(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!hasExactKeys(value, PROPOSAL_KEYS.DOCUMENT)) return null;
  if (!isDocumentType(value.document_type)) return null;
  if (!isIdempotencyKey(value.idempotency_key)) return null;
  if (typeof value.checksum_sha256 !== "string" || !SHA256_HEX.test(value.checksum_sha256)) return null;
  if (typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) ||
      value.size_bytes < 1 || value.size_bytes > DOCUMENT_MAX_BYTES_HARD_LIMIT) return null;
  if (typeof value.mime_type !== "string" ||
      !DOCUMENT_MIME_TYPES.some((mimeType) => mimeType === value.mime_type)) return null;
  return {
    document_type: value.document_type,
    idempotency_key: value.idempotency_key,
    checksum_sha256: value.checksum_sha256,
    size_bytes: value.size_bytes,
    mime_type: value.mime_type,
  };
}

export function projectChangeRequestProposal(
  kind: ChangeRequestTargetKind,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (kind === "ENTRY_FIELD") return projectEntryFieldProposal(value);
  if (kind === "PAYMENT") return projectPaymentProposal(value);
  if (kind === "WORK_STATUS") return projectWorkStatusProposal(value);
  if (kind === "ENTRY_VOID") return Object.keys(value).length === 0 ? {} : null;
  return projectDocumentProposal(value);
}

export function projectChangeRequestItem(value: unknown): ChangeRequestItem | null {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) return null;
  if (typeof value.entry_id !== "string" || !UUID.test(value.entry_id)) return null;
  if (!isChangeRequestTargetKind(value.target_kind)) return null;
  if (!isPositiveVersion(value.expected_version)) return null;
  const proposal = projectChangeRequestProposal(value.target_kind, value.proposal);
  if (!proposal) return null;
  return {
    entry_id: value.entry_id,
    target_kind: value.target_kind,
    expected_version: value.expected_version,
    proposal,
  };
}

export function projectChangeRequestCreate(
  value: unknown,
): ChangeRequestProjection<ChangeRequestCreateInput> {
  if (!isRecord(value)) return INVALID;
  const forbidden = findForbiddenChangeRequestField(value, CREATE_REQUEST_KEYS);
  if (forbidden) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN", field: forbidden.field };
  if (!hasOnlyKeys(value, CREATE_REQUEST_KEYS) ||
      !("items" in value) || !("idempotency_key" in value)) return INVALID;
  if (!Array.isArray(value.items) || value.items.length < 1 ||
      value.items.length > CHANGE_REQUEST_MAX_ITEMS) return INVALID;
  if (value.items.some((item) => isRecord(item) && item.target_kind === "DOCUMENT")) {
    return { ok: false, code: "DOCUMENT_CHANGE_REQUEST_UNSUPPORTED" };
  }
  if (value.items.some((item) => isRecord(item) && item.target_kind === "ENTRY_VOID") &&
      (value.items.length !== 1 || !isRecord(value.items[0]) ||
       value.items[0].target_kind !== "ENTRY_VOID")) return INVALID;
  const items: ChangeRequestItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.items) {
    const item = projectChangeRequestItem(raw);
    if (!item) return INVALID;
    if (seen.has(item.entry_id)) return INVALID;
    seen.add(item.entry_id);
    items.push(item);
  }
  const reason = projectOptionalActionReason(value.reason, REASON_MAX_LENGTH);
  if (!reason.ok) return INVALID;
  if (!isIdempotencyKey(value.idempotency_key)) return INVALID;
  return { ok: true, value: { items, reason: reason.value, idempotency_key: value.idempotency_key } };
}

export function projectChangeRequestWithdraw(
  value: unknown,
): ChangeRequestProjection<ChangeRequestWithdrawInput> {
  if (!isRecord(value)) return INVALID;
  const forbidden = findForbiddenChangeRequestField(value, WITHDRAW_REQUEST_KEYS);
  if (forbidden) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN", field: forbidden.field };
  if (!hasExactKeys(value, WITHDRAW_REQUEST_KEYS)) return INVALID;
  if (!isPositiveVersion(value.expected_version)) return INVALID;
  if (!isIdempotencyKey(value.idempotency_key)) return INVALID;
  return {
    ok: true,
    value: { expected_version: value.expected_version, idempotency_key: value.idempotency_key },
  };
}

export function projectChangeRequestDecision(
  value: unknown,
): ChangeRequestProjection<ChangeRequestDecisionInput> {
  if (!isRecord(value)) return INVALID;
  const forbidden = findForbiddenChangeRequestField(value, DECISION_REQUEST_KEYS);
  if (forbidden) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN", field: forbidden.field };
  if (!hasOnlyKeys(value, DECISION_REQUEST_KEYS) ||
      !("decision" in value) || !("expected_version" in value) || !("idempotency_key" in value)) {
    return INVALID;
  }
  if (!isChangeRequestDecision(value.decision)) return INVALID;
  if (!isPositiveVersion(value.expected_version)) return INVALID;
  const reason = projectOptionalActionReason(value.reason, REASON_MAX_LENGTH);
  if (!reason.ok) return INVALID;
  if (!isIdempotencyKey(value.idempotency_key)) return INVALID;
  return {
    ok: true,
    value: {
      decision: value.decision,
      expected_version: value.expected_version,
      reason: reason.value,
      idempotency_key: value.idempotency_key,
    },
  };
}

export const CREATE_RESULT_KEYS = ["request_id", "state", "items"] as const;
export const STATE_RESULT_KEYS = ["request_id", "state", "version"] as const;

export type ChangeRequestCreateResult = {
  request_id: string;
  state: ChangeRequestState;
  items: number;
};

export type ChangeRequestStateResult = {
  request_id: string;
  state: ChangeRequestState;
  version: number;
};

/**
 * RPC create tra { request_id, state: PENDING, items: <so item da ghi> }.
 * Khong tra revision/audit/timestamp/reused nen projection cung khong bia ra.
 */
export function projectChangeRequestCreated(
  value: unknown,
  expectedItems: number,
): ChangeRequestCreateResult | null {
  if (!isRecord(value) || !hasExactKeys(value, CREATE_RESULT_KEYS)) return null;
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) return null;
  if (value.state !== "PENDING") return null;
  if (typeof value.items !== "number" || !Number.isSafeInteger(value.items)) return null;
  if (!Number.isSafeInteger(expectedItems) || value.items !== expectedItems) return null;
  return { request_id: value.request_id, state: "PENDING", items: value.items };
}

/**
 * RPC withdraw/approve/reject tra { request_id, state, version } voi version = expected + 1.
 * state phai dung bang trang thai ma hanh dong yeu cau (APPROVED cho approve, REJECTED cho reject).
 */
export function projectChangeRequestStateResult(
  value: unknown,
  expected: { request_id: string; expected_version: number; state: ChangeRequestState },
): ChangeRequestStateResult | null {
  if (!isRecord(value) || !hasExactKeys(value, STATE_RESULT_KEYS)) return null;
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) return null;
  if (value.request_id !== expected.request_id) return null;
  if (!isChangeRequestState(value.state) || value.state !== expected.state) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (!isPositiveVersion(expected.expected_version)) return null;
  if (value.version !== expected.expected_version + 1) return null;
  return { request_id: value.request_id, state: value.state, version: value.version };
}
