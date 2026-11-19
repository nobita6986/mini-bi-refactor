import "server-only";

import { isOpaqueVfinEvidenceStorageKey } from "./r2-evidence-storage.ts";
import {
  VENDOR_FINANCE_EVIDENCE_MAX_BYTES,
  VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
  projectActorAccess,
  projectActorContextOptions,
  projectApplySharedAdvanceOffsetMutation,
  projectAssignGlobalRoleMutation,
  projectAssignProjectAccountantMutation,
  projectClassifySubLedgerMutation,
  projectCreateReconciliationMutation,
  projectEndGlobalRoleMutation,
  projectEndProjectAccountantMutation,
  projectEvidenceSummary,
  projectFundSharedAdvanceMutation,
  projectListGlobalRolesAdmin,
  projectListProjectAccountantsAdmin,
  projectMonthlyReport,
  projectOpeningApplyMutation,
  projectOpeningPreview,
  projectRecordEntryMutation,
  projectRecordPaymentWithOffsetMutation,
  projectRecordVendorRefundMutation,
  projectReverseEntryMutation,
  projectReverseSharedAdvanceMovementMutation,
  projectSharedAdvanceMovementsPage,
  projectVendorFinanceEntriesPage,
  projectVendorFinanceSingleEntry,
  projectVendorFinanceVendorDetail,
  projectVendorFinanceVendorExport,
  projectVendorFinanceVendorList,
  projectVendorReconciliationsPage,
  type ClassifiedVendorFinanceContractType,
  type NormalVendorFinanceEntryType,
  type OpeningBatchItemInput,
  type VendorFinanceActiveFilter,
  type VendorFinanceActorAccessProjection,
  type VendorFinanceActorContextOptionsResponse,
  type VendorFinanceApplySharedAdvanceOffsetResponse,
  type VendorFinanceAssignGlobalRoleResponse,
  type VendorFinanceAssignProjectAccountantResponse,
  type VendorFinanceBalanceFilter,
  type VendorFinanceClassifySubLedgerResponse,
  type VendorFinanceContractType,
  type VendorFinanceContractTypeFilter,
  type VendorFinanceEndGlobalRoleResponse,
  type VendorFinanceEndProjectAccountantResponse,
  type VendorFinanceEntriesPageResponse,
  type VendorFinanceEntryProjection,
  type VendorFinanceEntryType,
  type VendorFinanceErrorCode,
  type VendorFinanceEvidenceFinalizeResponse,
  type VendorFinanceEvidenceMimeType,
  type VendorFinanceEvidenceTargetKind,
  type VendorFinanceFundSharedAdvanceResponse,
  type VendorFinanceGlobalRoleCode,
  type VendorFinanceLedgerScope,
  type VendorFinanceListGlobalRolesAdminResponse,
  type VendorFinanceListProjectAccountantsAdminResponse,
  type VendorFinanceMonthlyReportResponse,
  type VendorFinanceOpeningApplyResponse,
  type VendorFinanceOpeningPreviewResponse,
  type VendorFinanceRecordPaymentWithOffsetResponse,
  type VendorFinanceRecordVendorRefundResponse,
  type VendorFinanceReconciliationProjection,
  type VendorFinanceReconciliationsPageResponse,
  type VendorFinanceReverseSharedAdvanceMovementResponse,
  type VendorFinanceSharedAdvanceMovementProjection,
  type VendorFinanceSharedAdvanceMovementType,
  type VendorFinanceSharedAdvanceMovementsPageResponse,
  type VendorFinanceSingleEntryResponse,
  type VendorFinanceVendorDetailResponse,
  type VendorFinanceVendorExportResponse,
  type VendorFinanceVendorListResponse,
} from "./vendor-finance-contract.ts";

export type VendorFinanceRpcCaller = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type VendorFinanceActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type VendorFinanceRepoResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: VendorFinanceErrorCode };

export type EvidenceReservationRecord = {
  reservation: {
    evidence_id: string;
    target_kind: VendorFinanceEvidenceTargetKind;
    target_id: string;
    status: "RESERVED";
    storage_key: string;
    mime_type: VendorFinanceEvidenceMimeType;
    size_bytes: number;
    checksum_sha256: string;
    reserved_at: string;
    expires_at: string;
  };
  superseded_storage_keys: readonly string[];
  replayed: boolean;
};

export type EvidenceReservationInfoRecord = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  status: "RESERVED" | "READY" | "FAILED" | "EXPIRED";
  storage_key: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  expires_at: string;
  finalized_at: string | null;
  is_expired: boolean;
};

export type EvidenceDownloadRecord = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  storage_key: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  finalized_at: string;
};

export type VendorFinanceRepository = {
  getActorAccess(
    actor: VendorFinanceActorRef,
  ): Promise<VendorFinanceRepoResult<VendorFinanceActorAccessProjection>>;

  listContextOptions(
    actor: VendorFinanceActorRef,
  ): Promise<VendorFinanceRepoResult<VendorFinanceActorContextOptionsResponse>>;

  listVendors(
    input: VendorFinanceActorRef & {
      search: string | null;
      active: VendorFinanceActiveFilter;
      balance_filter: VendorFinanceBalanceFilter;
      project_id: string | null;
      accountant_ref: string | null;
      ledger_scope: VendorFinanceLedgerScope | null;
      contract_type?: VendorFinanceContractTypeFilter;
      page: number;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceVendorListResponse>>;

  exportVendors(
    input: VendorFinanceActorRef & {
      search: string | null;
      active: VendorFinanceActiveFilter;
      balance_filter: VendorFinanceBalanceFilter;
      project_id: string | null;
      accountant_ref: string | null;
      ledger_scope: VendorFinanceLedgerScope | null;
      contract_type?: VendorFinanceContractTypeFilter;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceVendorExportResponse>>;

  getVendor(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      project_id?: string | null;
      accountant_ref?: string | null;
      ledger_scope?: VendorFinanceLedgerScope | null;
      contract_type?: VendorFinanceContractType | null;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceVendorDetailResponse>>;

  listVendorEntries(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      before_sequence: number | null;
      entry_type: VendorFinanceEntryType | null;
      page_size: number;
      project_id?: string | null;
      accountant_ref?: string | null;
      ledger_scope?: VendorFinanceLedgerScope | null;
      contract_type?: VendorFinanceContractType | null;
      month?: string | null;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEntriesPageResponse>>;

  listSharedAdvanceMovements(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      before_sequence: number | null;
      movement_type: VendorFinanceSharedAdvanceMovementType | null;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceSharedAdvanceMovementsPageResponse>>;

  getEntry(
    input: VendorFinanceActorRef & { entry_id: string },
  ): Promise<VendorFinanceRepoResult<VendorFinanceSingleEntryResponse>>;

  listVendorReconciliations(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      page: number;
      page_size: number;
      project_id?: string | null;
      accountant_ref?: string | null;
      ledger_scope?: VendorFinanceLedgerScope | null;
      contract_type?: VendorFinanceContractType | null;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceReconciliationsPageResponse>>;

  recordEntry(
    input: VendorFinanceActorRef & {
      project_id: string;
      contract_type: ClassifiedVendorFinanceContractType;
      vendor_id: string;
      entry_type: NormalVendorFinanceEntryType;
      amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{ entry: VendorFinanceEntryProjection; replayed: boolean }>
  >;

  fundSharedAdvance(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceFundSharedAdvanceResponse>>;

  recordVendorRefund(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceRecordVendorRefundResponse>>;

  applySharedAdvanceOffset(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      project_id: string;
      contract_type: ClassifiedVendorFinanceContractType;
      amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceApplySharedAdvanceOffsetResponse>>;

  recordPaymentWithOffset(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      project_id: string;
      contract_type: ClassifiedVendorFinanceContractType;
      payment_amount_minor: string;
      offset_amount_minor: string;
      effective_date: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceRecordPaymentWithOffsetResponse>>;

  reverseEntry(
    input: VendorFinanceActorRef & {
      entry_id: string;
      effective_date: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{
      reversal_entry: VendorFinanceEntryProjection;
      reversed_entry: VendorFinanceEntryProjection;
      reversal_movement?: VendorFinanceSharedAdvanceMovementProjection;
      reversed_movement?: VendorFinanceSharedAdvanceMovementProjection;
      shared_advance_balance_minor?: string;
      replayed: boolean;
    }>
  >;

  reverseSharedAdvanceMovement(
    input: VendorFinanceActorRef & {
      movement_id: string;
      effective_date: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceReverseSharedAdvanceMovementResponse>>;

  previewOpeningBatch(
    input: VendorFinanceActorRef & {
      project_id: string;
      contract_type: ClassifiedVendorFinanceContractType;
      cutoff_date: string;
      items: readonly OpeningBatchItemInput[];
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceOpeningPreviewResponse>>;

  applyOpeningBatch(
    input: VendorFinanceActorRef & {
      project_id: string;
      contract_type: ClassifiedVendorFinanceContractType;
      cutoff_date: string;
      items: readonly OpeningBatchItemInput[];
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceOpeningApplyResponse>>;

  createReconciliation(
    input: VendorFinanceActorRef & {
      project_id: string;
      accountant_ref: string | null;
      contract_type: VendorFinanceContractType;
      vendor_id: string;
      as_of_date: string;
      confirmed_balance_minor: string;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<
    VendorFinanceRepoResult<{
      reconciliation: VendorFinanceReconciliationProjection;
      replayed: boolean;
    }>
  >;

  classifyUnclassifiedSubLedger(
    input: VendorFinanceActorRef & {
      vendor_id: string;
      project_id: string;
      accountant_ref: string | null;
      target_contract_type: ClassifiedVendorFinanceContractType;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceClassifySubLedgerResponse>>;

  getMonthlyReport(
    input: VendorFinanceActorRef & {
      month: string;
      project_id: string | null;
      accountant_ref: string | null;
      vendor_id: string | null;
      contract_type?: VendorFinanceContractTypeFilter;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceMonthlyReportResponse>>;

  listProjectAccountantsAdmin(
    input: VendorFinanceActorRef & {
      search: string | null;
      include_history: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceListProjectAccountantsAdminResponse>>;

  assignProjectAccountantAdmin(
    input: VendorFinanceActorRef & {
      project_id: string;
      accountant_ref: string;
      expected_version: number;
      valid_from: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceAssignProjectAccountantResponse>>;

  endProjectAccountantAdmin(
    input: VendorFinanceActorRef & {
      assignment_id: string;
      expected_version: number;
      valid_to: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEndProjectAccountantResponse>>;

  listGlobalRolesAdmin(
    input: VendorFinanceActorRef & {
      search: string | null;
      include_history: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceListGlobalRolesAdminResponse>>;

  assignGlobalRoleAdmin(
    input: VendorFinanceActorRef & {
      account_ref: string;
      role_code: VendorFinanceGlobalRoleCode;
      expected_version: number;
      valid_from: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceAssignGlobalRoleResponse>>;

  endGlobalRoleAdmin(
    input: VendorFinanceActorRef & {
      role_grant_id: string;
      expected_version: number;
      valid_to: string | null;
      reason: string;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEndGlobalRoleResponse>>;

  reserveEvidence(
    input: VendorFinanceActorRef & {
      target_kind: VendorFinanceEvidenceTargetKind;
      target_id: string;
      mime_type: VendorFinanceEvidenceMimeType;
      size_bytes: number;
      checksum_sha256: string;
      ttl_seconds?: number;
      idempotency_key: string;
      request_fingerprint: string;
    },
  ): Promise<VendorFinanceRepoResult<EvidenceReservationRecord>>;

  getEvidenceReservationInfo(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<EvidenceReservationInfoRecord>>;

  finalizeEvidenceReady(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<VendorFinanceEvidenceFinalizeResponse>>;

  failEvidenceReservation(
    input: VendorFinanceActorRef & {
      evidence_id: string;
      failure_code: string;
    },
  ): Promise<VendorFinanceRepoResult<{ evidence_id: string; status: "FAILED" }>>;

  expireEvidenceReservation(
    input: VendorFinanceActorRef & {
      evidence_id: string;
      failure_code?: string;
    },
  ): Promise<VendorFinanceRepoResult<{ evidence_id: string; status: "EXPIRED" | "FAILED" }>>;

  getEvidenceDownload(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<EvidenceDownloadRecord>>;

  markEvidenceCleaned(
    input: VendorFinanceActorRef & { evidence_id: string },
  ): Promise<VendorFinanceRepoResult<{ evidence_id: string; cleaned: true }>>;
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

const KNOWN_RPC_TOKENS: ReadonlyArray<readonly [string, VendorFinanceErrorCode]> = [
  ["VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPE_INVALID", "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID"],
  ["VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED", "VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED"],
  ["VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND", "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND"],
  ["VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID", "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID"],
  ["VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN", "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN"],
  ["VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE", "VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE"],
  ["VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR", "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR"],
  ["VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY", "VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY"],
  ["VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED", "VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED"],
  ["VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT", "VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT"],
  ["VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED", "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED"],
  ["VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE", "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE"],
  ["VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED", "VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED"],
  ["VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE", "VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE"],
  ["VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT", "VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT"],
  ["VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED", "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED"],
  ["VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED", "VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED"],
  ["VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED", "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED"],
  ["VENDOR_FINANCE_PROJECT_ASSIGNMENT_OVERLAP", "VENDOR_FINANCE_PROJECT_ASSIGNMENT_OVERLAP"],
  ["VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID", "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED", "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"],
  ["VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID", "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID"],
  ["VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED", "VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED"],
  ["VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL", "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL"],
  ["VENDOR_FINANCE_RECONCILIATION_NOT_FOUND", "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND"],
  ["VENDOR_FINANCE_ACCOUNTANT_NOT_ELIGIBLE", "VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE"],
  ["VENDOR_FINANCE_ENTRY_ALREADY_REVERSED", "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED"],
  ["VENDOR_FINANCE_EVIDENCE_TARGET_INVALID", "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"],
  ["VENDOR_FINANCE_CONTRACT_TYPE_INVALID", "VENDOR_FINANCE_CONTRACT_TYPE_INVALID"],
  ["VENDOR_FINANCE_PROJECT_ACCESS_DENIED", "VENDOR_FINANCE_PROJECT_ACCESS_DENIED"],
  ["VENDOR_FINANCE_OPENING_BATCH_INVALID", "VENDOR_FINANCE_OPENING_BATCH_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_MIME_INVALID", "VENDOR_FINANCE_EVIDENCE_MIME_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_SIZE_INVALID", "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID"],
  ["VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND", "VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND"],
  ["VENDOR_FINANCE_IDEMPOTENCY_CONFLICT", "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT"],
  ["VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE", "VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE"],
  ["VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND", "VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND"],
  ["VENDOR_FINANCE_GLOBAL_ROLE_OVERLAP", "VENDOR_FINANCE_GLOBAL_ROLE_OVERLAP"],
  ["VENDOR_FINANCE_GLOBAL_ROLE_INVALID", "VENDOR_FINANCE_GLOBAL_ROLE_INVALID"],
  ["VENDOR_FINANCE_SUBLEDGER_NOT_FOUND", "VENDOR_FINANCE_SUBLEDGER_NOT_FOUND"],
  ["VENDOR_FINANCE_OPENING_BATCH_EMPTY", "VENDOR_FINANCE_OPENING_BATCH_EMPTY"],
  ["VENDOR_FINANCE_IDEMPOTENCY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["VENDOR_FINANCE_PROJECT_UNASSIGNED", "VENDOR_FINANCE_PROJECT_UNASSIGNED"],
  ["VENDOR_FINANCE_ASSIGNMENT_INVALID", "VENDOR_FINANCE_ASSIGNMENT_INVALID"],
  ["VENDOR_FINANCE_EVIDENCE_NOT_FOUND", "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"],
  ["VENDOR_FINANCE_ENTRY_TYPE_INVALID", "VENDOR_FINANCE_ENTRY_TYPE_INVALID"],
  ["VENDOR_FINANCE_PROJECT_NOT_FOUND", "VENDOR_FINANCE_PROJECT_NOT_FOUND"],
  ["VENDOR_FINANCE_PROJECT_INACTIVE", "VENDOR_FINANCE_PROJECT_INACTIVE"],
  ["VENDOR_FINANCE_RECONCILE_DENIED", "VENDOR_FINANCE_RECONCILE_DENIED"],
  ["VENDOR_FINANCE_VENDOR_NOT_FOUND", "VENDOR_FINANCE_VENDOR_NOT_FOUND"],
  ["VENDOR_FINANCE_EVIDENCE_INVALID", "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"],
  ["VENDOR_FINANCE_PROJECT_INVALID", "VENDOR_FINANCE_PROJECT_INVALID"],
  ["VENDOR_FINANCE_ENTRY_NOT_FOUND", "VENDOR_FINANCE_ENTRY_NOT_FOUND"],
  ["VENDOR_FINANCE_AMOUNT_OVERFLOW", "VENDOR_FINANCE_AMOUNT_OVERFLOW"],
  ["VENDOR_FINANCE_AMOUNT_INVALID", "VENDOR_FINANCE_AMOUNT_INVALID"],
  ["VENDOR_FINANCE_REASON_INVALID", "VENDOR_FINANCE_REASON_INVALID"],
  ["VENDOR_FINANCE_SEARCH_INVALID", "VENDOR_FINANCE_SEARCH_INVALID"],
  ["VENDOR_FINANCE_VENDOR_INVALID", "VENDOR_FINANCE_VENDOR_INVALID"],
  ["VENDOR_FINANCE_ACCESS_DENIED", "VENDOR_FINANCE_ACCESS_DENIED"],
  ["VENDOR_FINANCE_RECORD_DENIED", "VENDOR_FINANCE_RECORD_DENIED"],
  ["VENDOR_FINANCE_ADMIN_DENIED", "VENDOR_FINANCE_ADMIN_DENIED"],
  ["VENDOR_FINANCE_QUERY_INVALID", "VENDOR_FINANCE_QUERY_INVALID"],
  ["VENDOR_FINANCE_ENTRY_INVALID", "VENDOR_FINANCE_ENTRY_INVALID"],
  ["VENDOR_FINANCE_DATE_INVALID", "VENDOR_FINANCE_DATE_INVALID"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function serviceRoleRpc(): VendorFinanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

export function classifyVendorFinanceRpcError(
  error: { code?: string; message?: string },
  mode: "read" | "mutation",
): VendorFinanceErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";

  for (const [token, mapped] of KNOWN_RPC_TOKENS) {
    if (trimmed === token) {
      return mapped;
    }
  }
  for (const [token, mapped] of KNOWN_RPC_TOKENS) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (trimmed.includes("actor mapping denied")) {
    return "ACTOR_NOT_AVAILABLE";
  }
  if (
    trimmed.includes("admin capability denied") ||
    trimmed.includes("AUTHZ_FORBIDDEN") ||
    trimmed.includes("actor is not a Full Admin")
  ) {
    return "VENDOR_FINANCE_ADMIN_DENIED";
  }

  if (error.code === "42501") {
    return mode === "mutation"
      ? "VENDOR_FINANCE_RECORD_DENIED"
      : "VENDOR_FINANCE_ACCESS_DENIED";
  }
  if (error.code === "P0002") {
    return "VENDOR_FINANCE_VENDOR_NOT_FOUND";
  }
  if (error.code === "22003") {
    return "VENDOR_FINANCE_AMOUNT_OVERFLOW";
  }
  if (error.code === "23505") {
    return "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "40900") {
    return "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED";
  }
  if (error.code === "22023" || error.code === "23514") {
    return mode === "mutation"
      ? "VENDOR_FINANCE_PAYLOAD_INVALID"
      : "VENDOR_FINANCE_QUERY_INVALID";
  }

  return "VENDOR_FINANCE_UNAVAILABLE";
}

function projectEvidenceReservationRecord(value: unknown): EvidenceReservationRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["reservation", "superseded_storage_keys", "replayed"]) ||
    !isRecord(value.reservation) ||
    !exactKeys(value.reservation, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "reserved_at",
      "expires_at",
    ]) ||
    !Array.isArray(value.superseded_storage_keys) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }

  const r = value.reservation;
  if (
    typeof r.evidence_id !== "string" ||
    !UUID_REGEX.test(r.evidence_id) ||
    (r.target_kind !== "ENTRY" && r.target_kind !== "RECONCILIATION") ||
    typeof r.target_id !== "string" ||
    !UUID_REGEX.test(r.target_id) ||
    r.status !== "RESERVED" ||
    !isOpaqueVfinEvidenceStorageKey(r.storage_key) ||
    (r.mime_type !== "image/jpeg" && r.mime_type !== "image/png") ||
    typeof r.size_bytes !== "number" ||
    !Number.isSafeInteger(r.size_bytes) ||
    r.size_bytes < 1 ||
    r.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof r.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(r.checksum_sha256) ||
    typeof r.reserved_at !== "string" ||
    r.reserved_at.length === 0 ||
    typeof r.expires_at !== "string" ||
    r.expires_at.length === 0
  ) {
    return null;
  }

  const superseded: string[] = [];
  for (const item of value.superseded_storage_keys) {
    if (!isOpaqueVfinEvidenceStorageKey(item)) {
      return null;
    }
    superseded.push(item);
  }

  return {
    reservation: {
      evidence_id: r.evidence_id.toLowerCase(),
      target_kind: r.target_kind,
      target_id: r.target_id.toLowerCase(),
      status: "RESERVED",
      storage_key: r.storage_key,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      checksum_sha256: r.checksum_sha256.toLowerCase(),
      reserved_at: r.reserved_at,
      expires_at: r.expires_at,
    },
    superseded_storage_keys: superseded,
    replayed: value.replayed,
  };
}

function projectEvidenceReservationInfoRecord(
  value: unknown,
): EvidenceReservationInfoRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "expires_at",
      "finalized_at",
      "is_expired",
    ])
  ) {
    return null;
  }

  if (
    typeof value.evidence_id !== "string" ||
    !UUID_REGEX.test(value.evidence_id) ||
    (value.target_kind !== "ENTRY" && value.target_kind !== "RECONCILIATION") ||
    typeof value.target_id !== "string" ||
    !UUID_REGEX.test(value.target_id) ||
    (value.status !== "RESERVED" &&
      value.status !== "READY" &&
      value.status !== "FAILED" &&
      value.status !== "EXPIRED") ||
    !isOpaqueVfinEvidenceStorageKey(value.storage_key) ||
    (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    value.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof value.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(value.checksum_sha256) ||
    typeof value.expires_at !== "string" ||
    value.expires_at.length === 0 ||
    (value.finalized_at !== null &&
      (typeof value.finalized_at !== "string" || value.finalized_at.length === 0)) ||
    typeof value.is_expired !== "boolean"
  ) {
    return null;
  }

  return {
    evidence_id: value.evidence_id.toLowerCase(),
    target_kind: value.target_kind,
    target_id: value.target_id.toLowerCase(),
    status: value.status,
    storage_key: value.storage_key,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    checksum_sha256: value.checksum_sha256.toLowerCase(),
    expires_at: value.expires_at,
    finalized_at: value.finalized_at,
    is_expired: value.is_expired,
  };
}

function projectEvidenceFinalizeRecord(
  value: unknown,
): VendorFinanceEvidenceFinalizeResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["evidence", "replayed"]) ||
    !isRecord(value.evidence) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }

  const ev = value.evidence;
  if (
    !exactKeys(ev, [
      "evidence_id",
      "target_kind",
      "target_id",
      "status",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ]) ||
    (ev.target_kind !== "ENTRY" && ev.target_kind !== "RECONCILIATION") ||
    typeof ev.target_id !== "string" ||
    !UUID_REGEX.test(ev.target_id)
  ) {
    return null;
  }

  const summary = projectEvidenceSummary({
    evidence_id: ev.evidence_id,
    status: ev.status,
    mime_type: ev.mime_type,
    size_bytes: ev.size_bytes,
    checksum_sha256: ev.checksum_sha256,
    finalized_at: ev.finalized_at,
  });
  if (!summary) return null;

  return {
    evidence: {
      ...summary,
      target_kind: ev.target_kind,
      target_id: ev.target_id.toLowerCase(),
    },
    replayed: value.replayed,
  };
}

function projectEvidenceDownloadRecord(value: unknown): EvidenceDownloadRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "target_kind",
      "target_id",
      "storage_key",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ])
  ) {
    return null;
  }

  if (
    typeof value.evidence_id !== "string" ||
    !UUID_REGEX.test(value.evidence_id) ||
    (value.target_kind !== "ENTRY" && value.target_kind !== "RECONCILIATION") ||
    typeof value.target_id !== "string" ||
    !UUID_REGEX.test(value.target_id) ||
    !isOpaqueVfinEvidenceStorageKey(value.storage_key) ||
    (value.mime_type !== "image/jpeg" && value.mime_type !== "image/png") ||
    typeof value.size_bytes !== "number" ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    value.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
    typeof value.checksum_sha256 !== "string" ||
    !SHA256_HEX_REGEX.test(value.checksum_sha256) ||
    typeof value.finalized_at !== "string" ||
    value.finalized_at.length === 0
  ) {
    return null;
  }

  return {
    evidence_id: value.evidence_id.toLowerCase(),
    target_kind: value.target_kind,
    target_id: value.target_id.toLowerCase(),
    storage_key: value.storage_key,
    mime_type: value.mime_type,
    size_bytes: value.size_bytes,
    checksum_sha256: value.checksum_sha256.toLowerCase(),
    finalized_at: value.finalized_at,
  };
}

export function createVendorFinanceRepository(
  rpc?: VendorFinanceRpcCaller,
): VendorFinanceRepository {
  let resolvedRpc = rpc;

  async function callProjected<T>(
    operation: string,
    mode: "read" | "mutation",
    fnName: string,
    args: Record<string, unknown>,
    projector: (raw: unknown) => T | null,
  ): Promise<VendorFinanceRepoResult<T>> {
    try {
      resolvedRpc ??= serviceRoleRpc();
      const result = await resolvedRpc(fnName, args);
      if (result.error) {
        return {
          ok: false,
          code: classifyVendorFinanceRpcError(result.error, mode),
        };
      }
      const projected = projector(result.data);
      if (!projected) {
        console.error(`[vendor-finance] ${operation} returned non-canonical projection`);
        return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
      }
      return { ok: true, data: projected };
    } catch {
      console.error(`[vendor-finance] ${operation} RPC failed`);
      return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
    }
  }

  return {
    getActorAccess(actor) {
      return callProjected(
        "getActorAccess",
        "read",
        "vendor_finance_get_actor_access",
        {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        },
        projectActorAccess,
      );
    },

    listContextOptions(actor) {
      return callProjected(
        "listContextOptions",
        "read",
        "vendor_finance_list_actor_context_options",
        {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        },
        projectActorContextOptions,
      );
    },

    listVendors(input) {
      return callProjected(
        "listVendors",
        "read",
        "vendor_finance_list_vendors",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_active_filter: input.active,
          p_balance_filter: input.balance_filter,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_ledger_scope: input.ledger_scope ?? "all",
          p_page: input.page,
          p_page_size: input.page_size,
          p_contract_type: input.contract_type ?? "all",
        },
        projectVendorFinanceVendorList,
      );
    },

    exportVendors(input) {
      return callProjected(
        "exportVendors",
        "read",
        "vendor_finance_export_vendors",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_active_filter: input.active,
          p_balance_filter: input.balance_filter,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_ledger_scope: input.ledger_scope ?? "all",
          p_contract_type: input.contract_type ?? "all",
        },
        projectVendorFinanceVendorExport,
      );
    },

    getVendor(input) {
      return callProjected(
        "getVendor",
        "read",
        "vendor_finance_get_vendor",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id ?? null,
          p_accountant_user_id: input.accountant_ref ?? null,
          p_ledger_scope: input.ledger_scope ?? null,
          p_contract_type: input.contract_type ?? null,
        },
        projectVendorFinanceVendorDetail,
      );
    },

    listVendorEntries(input) {
      return callProjected(
        "listVendorEntries",
        "read",
        "vendor_finance_list_vendor_entries",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_before_sequence: input.before_sequence,
          p_entry_type: input.entry_type,
          p_page_size: input.page_size,
          p_project_id: input.project_id ?? null,
          p_accountant_user_id: input.accountant_ref ?? null,
          p_ledger_scope: input.ledger_scope ?? null,
          p_month: input.month ?? null,
          p_contract_type: input.contract_type ?? null,
        },
        (raw) =>
          projectVendorFinanceEntriesPage(raw, {
            project_id: input.project_id ?? null,
            accountant_ref: input.accountant_ref ?? null,
            ledger_scope: input.ledger_scope ?? null,
            contract_type: input.contract_type ?? null,
            month: input.month ?? null,
          }),
      );
    },

    getEntry(input) {
      return callProjected(
        "getEntry",
        "read",
        "vendor_finance_get_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
        },
        projectVendorFinanceSingleEntry,
      );
    },

    listVendorReconciliations(input) {
      return callProjected(
        "listVendorReconciliations",
        "read",
        "vendor_finance_list_vendor_reconciliations",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_page: input.page,
          p_page_size: input.page_size,
          p_project_id: input.project_id ?? null,
          p_accountant_user_id: input.accountant_ref ?? null,
          p_ledger_scope: input.ledger_scope ?? null,
          p_contract_type: input.contract_type ?? null,
        },
        projectVendorReconciliationsPage,
      );
    },

    listSharedAdvanceMovements(input) {
      return callProjected(
        "listSharedAdvanceMovements",
        "read",
        "vendor_finance_list_shared_advance_movements",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_before_sequence: input.before_sequence,
          p_movement_type: input.movement_type,
          p_page_size: input.page_size,
        },
        (raw) => projectSharedAdvanceMovementsPage(raw, input.movement_type),
      );
    },

    fundSharedAdvance(input) {
      return callProjected(
        "fundSharedAdvance",
        "mutation",
        "vendor_finance_fund_shared_advance",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_amount_minor: input.amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectFundSharedAdvanceMutation,
      );
    },

    recordVendorRefund(input) {
      return callProjected(
        "recordVendorRefund",
        "mutation",
        "vendor_finance_record_vendor_refund",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_amount_minor: input.amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectRecordVendorRefundMutation,
      );
    },

    applySharedAdvanceOffset(input) {
      return callProjected(
        "applySharedAdvanceOffset",
        "mutation",
        "vendor_finance_apply_shared_advance_offset",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
          p_contract_type: input.contract_type,
          p_amount_minor: input.amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectApplySharedAdvanceOffsetMutation,
      );
    },

    recordPaymentWithOffset(input) {
      return callProjected(
        "recordPaymentWithOffset",
        "mutation",
        "vendor_finance_record_payment_with_offset",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
          p_contract_type: input.contract_type,
          p_payment_amount_minor: input.payment_amount_minor,
          p_offset_amount_minor: input.offset_amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectRecordPaymentWithOffsetMutation,
      );
    },

    reverseSharedAdvanceMovement(input) {
      return callProjected(
        "reverseSharedAdvanceMovement",
        "mutation",
        "vendor_finance_reverse_shared_advance_movement",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_movement_id: input.movement_id,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectReverseSharedAdvanceMovementMutation,
      );
    },

    recordEntry(input) {
      return callProjected(
        "recordEntry",
        "mutation",
        "vendor_finance_record_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
          p_entry_type: input.entry_type,
          p_amount_minor: input.amount_minor,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
          p_contract_type: input.contract_type,
        },
        projectRecordEntryMutation,
      );
    },

    reverseEntry(input) {
      return callProjected(
        "reverseEntry",
        "mutation",
        "vendor_finance_reverse_entry",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_effective_date: input.effective_date,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectReverseEntryMutation,
      );
    },

    previewOpeningBatch(input) {
      return callProjected(
        "previewOpeningBatch",
        "mutation",
        "vendor_finance_preview_opening_batch",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_cutoff_date: input.cutoff_date,
          p_items: input.items,
          p_contract_type: input.contract_type,
        },
        projectOpeningPreview,
      );
    },

    applyOpeningBatch(input) {
      return callProjected(
        "applyOpeningBatch",
        "mutation",
        "vendor_finance_apply_opening_batch",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_cutoff_date: input.cutoff_date,
          p_items: input.items,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
          p_contract_type: input.contract_type,
        },
        projectOpeningApplyMutation,
      );
    },

    createReconciliation(input) {
      return callProjected(
        "createReconciliation",
        "mutation",
        "vendor_finance_create_reconciliation",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_as_of_date: input.as_of_date,
          p_confirmed_balance_minor: input.confirmed_balance_minor,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
          p_contract_type: input.contract_type,
        },
        projectCreateReconciliationMutation,
      );
    },

    classifyUnclassifiedSubLedger(input) {
      return callProjected(
        "classifyUnclassifiedSubLedger",
        "mutation",
        "vendor_finance_classify_unclassified_subledger",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_vendor_id: input.vendor_id,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_target_contract_type: input.target_contract_type,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectClassifySubLedgerMutation,
      );
    },

    getMonthlyReport(input) {
      return callProjected(
        "getMonthlyReport",
        "read",
        "vendor_finance_get_monthly_report",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_month: input.month,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_vendor_id: input.vendor_id,
          p_contract_type: input.contract_type ?? "all",
        },
        projectMonthlyReport,
      );
    },

    listProjectAccountantsAdmin(input) {
      return callProjected(
        "listProjectAccountantsAdmin",
        "read",
        "vendor_finance_list_project_accountants_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_history: input.include_history,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectListProjectAccountantsAdmin,
      );
    },

    assignProjectAccountantAdmin(input) {
      return callProjected(
        "assignProjectAccountantAdmin",
        "mutation",
        "vendor_finance_assign_project_accountant_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_project_id: input.project_id,
          p_accountant_user_id: input.accountant_ref,
          p_expected_version: input.expected_version,
          p_valid_from: input.valid_from,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectAssignProjectAccountantMutation,
      );
    },

    endProjectAccountantAdmin(input) {
      return callProjected(
        "endProjectAccountantAdmin",
        "mutation",
        "vendor_finance_end_project_accountant_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id,
          p_expected_version: input.expected_version,
          p_valid_to: input.valid_to,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectEndProjectAccountantMutation,
      );
    },

    listGlobalRolesAdmin(input) {
      return callProjected(
        "listGlobalRolesAdmin",
        "read",
        "vendor_finance_list_global_roles_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_history: input.include_history,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectListGlobalRolesAdmin,
      );
    },

    assignGlobalRoleAdmin(input) {
      return callProjected(
        "assignGlobalRoleAdmin",
        "mutation",
        "vendor_finance_assign_global_role_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_user_id: input.account_ref,
          p_role_code: input.role_code,
          p_expected_version: input.expected_version,
          p_valid_from: input.valid_from,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectAssignGlobalRoleMutation,
      );
    },

    endGlobalRoleAdmin(input) {
      return callProjected(
        "endGlobalRoleAdmin",
        "mutation",
        "vendor_finance_end_global_role_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_role_grant_id: input.role_grant_id,
          p_expected_version: input.expected_version,
          p_valid_to: input.valid_to,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectEndGlobalRoleMutation,
      );
    },

    reserveEvidence(input) {
      return callProjected(
        "reserveEvidence",
        "mutation",
        "vendor_finance_reserve_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_kind: input.target_kind,
          p_target_id: input.target_id,
          p_mime_type: input.mime_type,
          p_size_bytes: input.size_bytes,
          p_checksum_sha256: input.checksum_sha256,
          p_ttl_seconds: input.ttl_seconds ?? VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        },
        projectEvidenceReservationRecord,
      );
    },

    getEvidenceReservationInfo(input) {
      return callProjected(
        "getEvidenceReservationInfo",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "INFO",
          p_failure_code: null,
        },
        projectEvidenceReservationInfoRecord,
      );
    },

    async finalizeEvidenceReady(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("vendor_finance_complete_evidence", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "READY",
          p_failure_code: null,
        });
        if (result.error) {
          return {
            ok: false,
            code: classifyVendorFinanceRpcError(result.error, "mutation"),
          };
        }
        if (
          isRecord(result.data) &&
          result.data.expired === true &&
          result.data.status === "EXPIRED"
        ) {
          return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED" };
        }
        const projected = projectEvidenceFinalizeRecord(result.data);
        if (!projected) {
          console.error("[vendor-finance] finalizeEvidenceReady returned non-canonical projection");
          return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
        }
        return { ok: true, data: projected };
      } catch {
        console.error("[vendor-finance] finalizeEvidenceReady RPC failed");
        return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
      }
    },

    failEvidenceReservation(input) {
      return callProjected(
        "failEvidenceReservation",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "FAILED",
          p_failure_code: input.failure_code,
        },
        (raw) => {
          if (
            !isRecord(raw) ||
            !exactKeys(raw, ["evidence_id", "status", "failure_code"]) ||
            typeof raw.evidence_id !== "string" ||
            !UUID_REGEX.test(raw.evidence_id) ||
            raw.status !== "FAILED"
          ) {
            return null;
          }
          return { evidence_id: raw.evidence_id.toLowerCase(), status: "FAILED" as const };
        },
      );
    },

    expireEvidenceReservation(input) {
      return callProjected(
        "expireEvidenceReservation",
        "mutation",
        "vendor_finance_complete_evidence",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
          p_outcome: "EXPIRED",
          p_failure_code: input.failure_code ?? "RESERVATION_TTL_EXPIRED",
        },
        (raw) => {
          if (
            !isRecord(raw) ||
            !exactKeys(raw, ["evidence_id", "status", "failure_code"]) ||
            typeof raw.evidence_id !== "string" ||
            !UUID_REGEX.test(raw.evidence_id) ||
            (raw.status !== "EXPIRED" && raw.status !== "FAILED")
          ) {
            return null;
          }
          return {
            evidence_id: raw.evidence_id.toLowerCase(),
            status: raw.status,
          };
        },
      );
    },

    getEvidenceDownload(input) {
      return callProjected(
        "getEvidenceDownload",
        "read",
        "vendor_finance_get_evidence_download",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
        },
        projectEvidenceDownloadRecord,
      );
    },

    markEvidenceCleaned(input) {
      return callProjected(
        "markEvidenceCleaned",
        "mutation",
        "vendor_finance_mark_evidence_cleaned",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_evidence_id: input.evidence_id,
        },
        (raw) => {
          if (
            !isRecord(raw) ||
            !exactKeys(raw, ["evidence_id", "cleaned"]) ||
            typeof raw.evidence_id !== "string" ||
            !UUID_REGEX.test(raw.evidence_id) ||
            raw.cleaned !== true
          ) {
            return null;
          }
          return { evidence_id: raw.evidence_id.toLowerCase(), cleaned: true as const };
        },
      );
    },
  };
}
