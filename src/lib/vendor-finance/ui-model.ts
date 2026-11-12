/**
 * VFIN-01 — Browser-safe Client UI Model, VND BigInt Formatters, Fail-Closed Envelope Parsers,
 * Request Builders, Sanitized Error Classifier, and Two-Phase Evidence Upload Runner.
 *
 * Strict invariants:
 * - Zero runtime Node, server-only, or direct database client imports.
 * - Zero floating-point arithmetic (`Number` / `parseFloat`) on monetary amounts; all money
 *   values stay canonical integer strings at the API boundary and use `BigInt` only for
 *   exact validation, ledger/reconciliation invariant verification, and thousand-grouped display.
 * - Client never computes or sends authority/computed fields (`balance_*`, `document_no`,
 *   `system_balance_minor`, `difference_minor`, `app_user_id`, `storage_key`, etc.).
 */

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import type { DirectEntryPageDecision } from "../auth/direct-entry-page-access.ts";
import {
  vendorFinanceAdminNavPredicate,
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import type {
  ApplyOpeningBatchBody,
  ApplySharedAdvanceOffsetBody,
  AssignGlobalRoleBody,
  AssignProjectAccountantBody,
  ClassifiedVendorFinanceContractType,
  ClassifyVendorSubLedgerBody,
  CreateVendorReconciliationBody,
  EndGlobalRoleBody,
  EndProjectAccountantBody,
  FundSharedAdvanceBody,
  NormalSharedAdvanceMovementType,
  NormalVendorFinanceEntryType,
  OpeningBatchItemInput,
  OpeningVendorFinanceEntryType,
  PreviewOpeningBatchBody,
  RecordPaymentWithOffsetBody,
  RecordVendorFinanceEntryBody,
  RecordVendorRefundBody,
  ReserveVendorFinanceEvidenceBody,
  ReverseSharedAdvanceMovementBody,
  ReverseVendorFinanceEntryBody,
  VendorFinanceAccountSummary,
  VendorFinanceActiveFilter,
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceAdminGrantState,
  VendorFinanceApplySharedAdvanceOffsetResponse,
  VendorFinanceAssignGlobalRoleResponse,
  VendorFinanceAssignProjectAccountantResponse,
  VendorFinanceBalanceDirection,
  VendorFinanceBalanceFilter,
  VendorFinanceCategoryTotals,
  VendorFinanceClassifySubLedgerResponse,
  VendorFinanceCompanySummary,
  VendorFinanceContextAccountantOption,
  VendorFinanceContextVendorOption,
  VendorFinanceContextProjectOption,
  VendorFinanceContractType,
  VendorFinanceContractTypeFilter,
  VendorFinanceDetailSubLedger,
  VendorFinanceDocumentKind,
  VendorFinanceEndGlobalRoleResponse,
  VendorFinanceEndProjectAccountantResponse,
  VendorFinanceEntriesPageResponse,
  VendorFinanceEntryProjection,
  VendorFinanceEntryType,
  VendorFinanceErrorCode,
  VendorFinanceEvidenceDownloadResponse,
  VendorFinanceEvidenceFinalizeResponse,
  VendorFinanceEvidenceMimeType,
  VendorFinanceEvidenceReserveResponse,
  VendorFinanceEvidenceSummary,
  VendorFinanceEvidenceTargetKind,
  VendorFinanceFundSharedAdvanceResponse,
  VendorFinanceGlobalRoleCandidateItem,
  VendorFinanceGlobalRoleCode,
  VendorFinanceGlobalRoleGrantItem,
  VendorFinanceLedgerScope,
  VendorFinanceLedgerScopeFilter,
  VendorFinanceListBalanceDirection,
  VendorFinanceListGlobalRolesAdminResponse,
  VendorFinanceListItem,
  VendorFinanceListProjectAccountantsAdminResponse,
  VendorFinanceListSubLedgerItem,
  VendorFinanceMonthlyLegacyRow,
  VendorFinanceMonthlyReportAccountantSummary,
  VendorFinanceMonthlyReportResponse,
  VendorFinanceMonthlyReportRow,
  VendorFinanceOpeningApplyResponse,
  VendorFinanceOpeningPreviewItem,
  VendorFinanceOpeningPreviewResponse,
  VendorFinanceProjectAccountantAssignmentItem,
  VendorFinanceProjectAccountantsAdminProject,
  VendorFinanceReconciliationProjection,
  VendorFinanceReconciliationsPageResponse,
  VendorFinanceRecordPaymentWithOffsetResponse,
  VendorFinanceRecordVendorRefundResponse,
  VendorFinanceReverseSharedAdvanceMovementResponse,
  VendorFinanceSharedAdvanceMovementProjection,
  VendorFinanceSharedAdvanceMovementsPageResponse,
  VendorFinanceSharedAdvanceMovementType,
  VendorFinanceSingleEntryResponse,
  VendorFinanceSubLedgerClassificationProjection,
  VendorFinanceVendorDetailResponse,
  VendorFinanceVendorListResponse,
  VendorFinanceVisibilityScope,
  VendorFinanceWriteScope,
} from "./vendor-finance-contract.ts";

// -----------------------------------------------------------------------------
// 1. Canonical Browser-Safe Constants & Display Metadata
// -----------------------------------------------------------------------------
export const VFIN_UI_CONTRACT_VERSION = "vendor-finance/1.0" as const;

export const VFIN_UI_INTERNAL_DISCLAIMER_VI =
  "Chứng từ ghi nhận nội bộ trên hệ thống BI, không phải xác nhận giao dịch ngân hàng hoặc chứng minh tiền đã được chuyển." as const;

export const VFIN_UI_MAX_REASON_LENGTH = 4000;
export const VFIN_UI_MAX_SEARCH_LENGTH = 120;
export const VFIN_UI_MAX_OPENING_BATCH_ITEMS = 200;
export const VFIN_UI_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB = 10_485_760

export const VFIN_UI_PG_BIGINT_MAX = BigInt("9223372036854775807");
export const VFIN_UI_PG_BIGINT_MIN = BigInt("-9223372036854775808");
const ZERO_BIGINT = BigInt(0);
const ONE_BIGINT = BigInt(1);

export const VFIN_UI_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADVANCE_OFFSET_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
  "REVERSAL",
] as const satisfies readonly VendorFinanceEntryType[];

export const VFIN_UI_NORMAL_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const satisfies readonly NormalVendorFinanceEntryType[];

export const VFIN_UI_CREATOR_NORMAL_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const satisfies readonly NormalVendorFinanceEntryType[];

export type DialogRecordVendorFinanceEntryType =
  | NormalVendorFinanceEntryType
  | "ADVANCE_OFFSET_RECORDED";

export const VFIN_UI_DIALOG_RECORD_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_OFFSET_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const satisfies readonly DialogRecordVendorFinanceEntryType[];

export const VFIN_UI_OPENING_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
] as const satisfies readonly OpeningVendorFinanceEntryType[];

export const VFIN_UI_CREATOR_OPENING_ENTRY_TYPES = [
  "OPENING_PAYABLE",
] as const satisfies readonly OpeningVendorFinanceEntryType[];

export const VFIN_UI_SHARED_ADVANCE_MOVEMENT_TYPES = [
  "ADVANCE_FUNDED",
  "VENDOR_REFUND_RECORDED",
  "PROJECT_OFFSET_APPLIED",
  "REVERSAL",
] as const satisfies readonly VendorFinanceSharedAdvanceMovementType[];

export const VFIN_UI_NORMAL_SHARED_ADVANCE_MOVEMENT_TYPES = [
  "ADVANCE_FUNDED",
  "VENDOR_REFUND_RECORDED",
  "PROJECT_OFFSET_APPLIED",
] as const satisfies readonly NormalSharedAdvanceMovementType[];

export const VFIN_UI_REDACTED_FIELD_LABEL_VI = "Không hiển thị theo phạm vi quyền" as const;

export const VENDOR_FINANCE_EXPORT_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;

export const SHARED_ADVANCE_MOVEMENT_TYPE_LABELS_VI: Readonly<
  Record<VendorFinanceSharedAdvanceMovementType, string>
> = {
  ADVANCE_FUNDED: "Ứng tiền cho Vendor",
  VENDOR_REFUND_RECORDED: "Vendor hoàn ứng",
  PROJECT_OFFSET_APPLIED: "Khấu trừ vào công nợ dự án",
  REVERSAL: "Hoàn tác bút toán ứng",
};

export const VFIN_UI_DOCUMENT_KINDS = [
  "PAYROLL_VOUCHER",
  "PAYMENT_VOUCHER",
  "ADVANCE_VOUCHER",
  "VENDOR_REFUND_VOUCHER",
  "ADVANCE_OFFSET_VOUCHER",
  "DEBT_ADJUSTMENT_VOUCHER",
  "OPENING_BALANCE_VOUCHER",
] as const satisfies readonly VendorFinanceDocumentKind[];

export const VFIN_UI_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const satisfies readonly VendorFinanceEvidenceMimeType[];

export const VFIN_UI_EVIDENCE_TARGET_KINDS = [
  "ENTRY",
  "RECONCILIATION",
] as const satisfies readonly VendorFinanceEvidenceTargetKind[];

export const VFIN_UI_ACTIVE_FILTERS = [
  "all",
  "active",
  "inactive",
] as const satisfies readonly VendorFinanceActiveFilter[];

export const VFIN_UI_BALANCE_FILTERS = [
  "all",
  "payable",
  "advance",
  "nonzero",
  "uninitialized",
] as const satisfies readonly VendorFinanceBalanceFilter[];

export const ENTRY_TYPE_LABELS_VI: Readonly<Record<VendorFinanceEntryType, string>> = {
  OPENING_PAYABLE: "Số dư đầu kỳ phải trả",
  OPENING_ADVANCE: "Số dư đầu kỳ dư ứng",
  DEBT_RECORDED: "Ghi nhận phát sinh công nợ",
  PAYROLL_RECORDED: "Ghi nhận lương phải trả",
  PAYMENT_RECORDED: "Thanh toán cho Vendor",
  ADVANCE_RECORDED: "Tạm ứng cho Vendor",
  ADVANCE_OFFSET_RECORDED: "Khấu trừ ứng Vendor",
  ADJUSTMENT_INCREASE: "Điều chỉnh tăng phải trả",
  ADJUSTMENT_DECREASE: "Điều chỉnh giảm phải trả",
  REVERSAL: "Hoàn tác bút toán",
};

export const ENTRY_TYPE_DIRECTION_HINTS_VI: Readonly<
  Record<NormalVendorFinanceEntryType, { deltaSign: "+" | "-"; description: string }>
> = {
  DEBT_RECORDED: {
    deltaSign: "+",
    description: "Tăng số dư phải trả cho Vendor (+).",
  },
  PAYROLL_RECORDED: {
    deltaSign: "+",
    description: "Ghi nhận bảng lương phải trả cho Vendor (+).",
  },
  PAYMENT_RECORDED: {
    deltaSign: "-",
    description: "Thanh toán tiền cho Vendor — giảm phải trả (-).",
  },
  ADVANCE_RECORDED: {
    deltaSign: "-",
    description: "Chi tạm ứng cho Vendor — giảm phải trả hoặc tạo dư ứng (-).",
  },
  ADJUSTMENT_INCREASE: {
    deltaSign: "+",
    description: "Điều chỉnh tăng công nợ phải trả cho Vendor (+).",
  },
  ADJUSTMENT_DECREASE: {
    deltaSign: "-",
    description: "Điều chỉnh giảm công nợ phải trả cho Vendor (-).",
  },
};

export const ACTIVE_FILTER_LABELS_VI: Readonly<Record<VendorFinanceActiveFilter, string>> = {
  all: "Tất cả trạng thái",
  active: "Đang hoạt động",
  inactive: "Ngừng hoạt động",
};

export const BALANCE_FILTER_LABELS_VI: Readonly<Record<VendorFinanceBalanceFilter, string>> = {
  all: "Tất cả số dư",
  payable: "Còn phải trả (> 0)",
  advance: "Đang dư ứng (< 0)",
  nonzero: "Còn công nợ / dư ứng (≠ 0)",
  uninitialized: "Chưa khởi tạo đầu kỳ",
};

export const VFIN_UI_LEDGER_SCOPE_FILTERS = [
  "all",
  "PROJECT_ACCOUNTANT",
  "LEGACY_UNALLOCATED",
] as const satisfies readonly VendorFinanceLedgerScopeFilter[];

export const LEDGER_SCOPE_FILTER_LABELS_VI: Readonly<
  Record<VendorFinanceLedgerScopeFilter, string>
> = {
  all: "Tất cả phạm vi sổ",
  PROJECT_ACCOUNTANT: "Sổ dự án theo kế toán phụ trách",
  LEGACY_UNALLOCATED: "Sổ lịch sử VFIN-01 (chưa gắn dự án)",
};

export const VFIN_UI_CONTRACT_TYPES = [
  "UNCLASSIFIED",
  "SEASONAL",
  "OFFICIAL",
] as const satisfies readonly VendorFinanceContractType[];

export const VFIN_UI_CLASSIFIED_CONTRACT_TYPES = [
  "SEASONAL",
  "OFFICIAL",
] as const satisfies readonly ClassifiedVendorFinanceContractType[];

export const VFIN_UI_CONTRACT_TYPE_FILTERS = [
  "all",
  "SEASONAL",
  "OFFICIAL",
  "UNCLASSIFIED",
] as const satisfies readonly VendorFinanceContractTypeFilter[];

export const CONTRACT_TYPE_LABELS_VI: Readonly<Record<VendorFinanceContractType, string>> = {
  SEASONAL: "Thời vụ",
  OFFICIAL: "Chính thức",
  UNCLASSIFIED: "Chưa phân loại",
};

export const CONTRACT_TYPE_BADGE_TONES: Readonly<
  Record<VendorFinanceContractType, UiBadgeTone>
> = {
  SEASONAL: "info",
  OFFICIAL: "primary",
  UNCLASSIFIED: "warning",
};

export const CONTRACT_TYPE_FILTER_LABELS_VI: Readonly<
  Record<VendorFinanceContractTypeFilter, string>
> = {
  all: "Tất cả loại hợp đồng",
  SEASONAL: "Hợp đồng Thời vụ",
  OFFICIAL: "Hợp đồng Chính thức",
  UNCLASSIFIED: "Chưa phân loại (sổ hiện hữu)",
};

export const VFIN_UI_REFERENCE_TOTAL_LABEL_VI =
  "Tổng tham khảo (không bù trừ giữa các sổ Thời vụ / Chính thức / Dự án)" as const;

export const VFIN_UI_GLOBAL_ROLE_CODES = [
  "CASH_HOLDER",
  "CASH_HOLDER_RECORD_BEHALF",
  "GLOBAL_RECONCILER",
  "GLOBAL_VIEWER",
] as const satisfies readonly VendorFinanceGlobalRoleCode[];

export const GLOBAL_ROLE_LABELS_VI: Readonly<Record<VendorFinanceGlobalRoleCode, string>> = {
  CASH_HOLDER: "Kế toán cầm tiền (Xem & đối soát toàn cục)",
  CASH_HOLDER_RECORD_BEHALF:
    "Kế toán cầm tiền — Được ghi nhận hộ vào sổ kế toán dự án",
  GLOBAL_RECONCILER: "BoD / Kiểm soát đối soát toàn cục (Không ghi sổ)",
  GLOBAL_VIEWER: "Xem báo cáo toàn cục (Chỉ xem)",
};

export const ADMIN_GRANT_STATE_LABELS_VI: Readonly<
  Record<VendorFinanceAdminGrantState, { label: string; tone: UiBadgeTone }>
> = {
  ACTIVE: { label: "Đang hiệu lực", tone: "success" },
  SCHEDULED: { label: "Sắp hiệu lực", tone: "info" },
  ENDED: { label: "Đã kết thúc", tone: "neutral" },
  CANCELLED: { label: "Đã hủy trước hiệu lực", tone: "warning" },
};

export const PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI =
  "Chưa có nguồn chuẩn" as const;

export const PROJECT_REVENUE_MISSING_SOURCE_NOTE_VI =
  "Hệ thống hiện chưa có bảng doanh thu dự án chuẩn. Cột doanh thu dự án được giữ ở trạng thái Chưa có nguồn chuẩn thay vì suy diễn hoặc ghi 0 ₫ giả." as const;

export type UiBadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "primary";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDOR_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CALENDAR_MONTH_REGEX = /^([0-9]{4})-(0[1-9]|1[0-2])$/;
const DOCUMENT_NO_REGEX = /^VFIN-[0-9]{4}-[0-9]{6,}$/;
const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]{0,18}$/;
const SIGNED_DECIMAL_REGEX = /^-?(?:0|[1-9][0-9]{0,18})$/;
const GROUPED_THOUSANDS_INTEGER_REGEX = /^-?[1-9][0-9]{0,2}(?:([.,\s])[0-9]{3})+$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const CURSOR_TOKEN_REGEX = /^[A-Za-z0-9_-]{4,768}$/;
const FORBIDDEN_TEXT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

// -----------------------------------------------------------------------------
// 2. Server Page Gate Pure Decision (`decideVendorFinancePageAccess`)
// -----------------------------------------------------------------------------
export type VendorFinanceServerAccessResult =
  | {
      ok: true;
      can_view: boolean;
      can_record: boolean;
      can_reconcile?: boolean;
      can_manage_project_assignments?: boolean;
    }
  | { ok: false; code: string };

export function decideVendorFinancePageAccess(input: {
  enabledFlag: string | undefined;
  requiredMode: "view" | "record" | "admin";
  actor: ActorResolution | null;
  serverAccess?: VendorFinanceServerAccessResult | null;
}): DirectEntryPageDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  const actor = input.actor;
  if (!actor) {
    return "TEMPORARY_UNAVAILABLE";
  }
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") {
      return "REDIRECT_LOGIN";
    }
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }

  const baseProjection: NavActorProjection = {
    capabilities: actor.actor.capabilities,
    scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
  };

  if (input.requiredMode === "admin") {
    if (vendorFinanceAdminNavPredicate(baseProjection)) {
      return "ALLOW";
    }
    const serverAccess = input.serverAccess;
    if (serverAccess && !serverAccess.ok && serverAccess.code === "ACTOR_NOT_AVAILABLE") {
      return "ACCOUNT_UNAVAILABLE";
    }
    if (serverAccess && serverAccess.ok && serverAccess.can_manage_project_assignments) {
      return "ALLOW";
    }
    return "ACCESS_DENIED";
  }

  if (vendorFinanceRecordNavPredicate(baseProjection)) {
    return "ALLOW";
  }
  if (input.requiredMode === "view" && vendorFinanceNavPredicate(baseProjection)) {
    return "ALLOW";
  }

  const serverAccess = input.serverAccess;
  if (!serverAccess) {
    return "TEMPORARY_UNAVAILABLE";
  }
  if (!serverAccess.ok) {
    if (serverAccess.code === "ACTOR_NOT_AVAILABLE") {
      return "ACCOUNT_UNAVAILABLE";
    }
    if (
      serverAccess.code === "VENDOR_FINANCE_ACCESS_DENIED" ||
      serverAccess.code === "VENDOR_FINANCE_RECORD_DENIED" ||
      serverAccess.code === "VENDOR_FINANCE_RECONCILE_DENIED" ||
      serverAccess.code === "VENDOR_FINANCE_ADMIN_DENIED"
    ) {
      return "ACCESS_DENIED";
    }
    return "TEMPORARY_UNAVAILABLE";
  }

  const enrichedProjection: NavActorProjection = {
    ...baseProjection,
    hasVendorFinanceAccess: serverAccess.can_view,
    hasVendorFinanceRecordAccess: serverAccess.can_view && serverAccess.can_record,
    hasVendorFinanceReconcileAccess:
      serverAccess.can_view && Boolean(serverAccess.can_reconcile),
  };

  const allowed =
    input.requiredMode === "record"
      ? vendorFinanceRecordNavPredicate(enrichedProjection)
      : vendorFinanceNavPredicate(enrichedProjection);
  return allowed ? "ALLOW" : "ACCESS_DENIED";
}

// -----------------------------------------------------------------------------
// 3. BigInt-Only Whole-VND Parsing & Display Formatting (Zero Float Math)
// -----------------------------------------------------------------------------
function groupDigitsThousands(unsignedDigits: string): string {
  return unsignedDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function parseCanonicalSignedMoneyBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || value === "-0" || !SIGNED_DECIMAL_REGEX.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed < VFIN_UI_PG_BIGINT_MIN || parsed > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return parsed;
}

export function parseCanonicalNonNegativeMoneyBigInt(value: unknown): bigint | null {
  const parsed = parseCanonicalSignedMoneyBigInt(value);
  if (parsed === null || parsed < ZERO_BIGINT) return null;
  return parsed;
}

export function parseCanonicalPositiveMoneyBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_REGEX.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed < ONE_BIGINT || parsed > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return parsed;
}

/**
 * Formats a canonical signed integer VND string (`"1500000"`, `"-250000"`, `"0"`)
 * into Vietnamese display format (`"1.500.000 ₫"`, `"-250.000 ₫"`, `"0 ₫"`),
 * preserving exact digits up to `int8` limits without `Number` conversion.
 */
export function formatVndMinor(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  const normalized = parsed.toString();
  if (normalized.startsWith("-")) {
    return `-${groupDigitsThousands(normalized.slice(1))} ₫`;
  }
  return `${groupDigitsThousands(normalized)} ₫`;
}

/**
 * Formats a signed ledger delta or difference with explicit `+` for positive amounts.
 */
export function formatSignedVndDelta(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  if (parsed === ZERO_BIGINT) {
    return "0 ₫";
  }
  if (parsed > ZERO_BIGINT) {
    return `+${groupDigitsThousands(parsed.toString())} ₫`;
  }
  return `-${groupDigitsThousands(parsed.toString().slice(1))} ₫`;
}

/**
 * Formats the absolute value of a canonical money string (`"-250000"` -> `"250.000 ₫"`).
 */
export function formatAbsoluteVndMinor(canonical: string): string {
  const parsed = parseCanonicalSignedMoneyBigInt(canonical);
  if (parsed === null) {
    return "—";
  }
  const absDigits = parsed < ZERO_BIGINT ? parsed.toString().slice(1) : parsed.toString();
  return `${groupDigitsThousands(absDigits)} ₫`;
}

export function formatVendorBalancePresentation(input: {
  current_balance_minor: string;
  balance_direction: VendorFinanceListBalanceDirection;
  entry_count: number;
  has_opening_entry: boolean;
  sub_ledger_count?: number;
}): {
  amountText: string;
  signedText: string;
  statusLabel: string;
  tone: UiBadgeTone;
} {
  if (input.balance_direction === "MULTI_LEDGER") {
    const countLabel =
      typeof input.sub_ledger_count === "number" && input.sub_ledger_count > 1
        ? `${input.sub_ledger_count} sổ dự án riêng`
        : "Nhiều sổ dự án riêng";
    return {
      amountText: countLabel,
      signedText: countLabel,
      statusLabel: "Nhiều sổ dự án (không bù trừ)",
      tone: "primary",
    };
  }
  if (!input.has_opening_entry && input.entry_count === 0) {
    return {
      amountText: "0 ₫",
      signedText: "0 ₫",
      statusLabel: "Chưa khởi tạo đầu kỳ",
      tone: "neutral",
    };
  }
  switch (input.balance_direction) {
    case "PAYABLE":
      return {
        amountText: formatVndMinor(input.current_balance_minor),
        signedText: formatSignedVndDelta(input.current_balance_minor),
        statusLabel: "Phải trả Vendor",
        tone: "warning",
      };
    case "ADVANCE":
      return {
        amountText: formatAbsoluteVndMinor(input.current_balance_minor),
        signedText: formatVndMinor(input.current_balance_minor),
        statusLabel: "Vendor dư ứng",
        tone: "info",
      };
    case "BALANCED":
      return {
        amountText: "0 ₫",
        signedText: "0 ₫",
        statusLabel: "Cân bằng",
        tone: "success",
      };
  }
}

export type NormalizedVndInputResult =
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW"; message: string };

function extractRawVndIntegerDigits(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("+") || trimmed === "-0") {
    return null;
  }
  if (/^-?(?:0|[1-9][0-9]*)$/.test(trimmed)) {
    return trimmed;
  }
  // Accept consistent 3-digit thousand grouping (`1.500.000`, `1,500,000`, `1 500 000`)
  // while rejecting fractional inputs like `100.5` or `100,50` or mixed separators `1.500,000`.
  if (GROUPED_THOUSANDS_INTEGER_REGEX.test(trimmed)) {
    const separators = trimmed.match(/[.,\s]/g) ?? [];
    const uniqueSeparators = new Set(separators);
    if (uniqueSeparators.size === 1) {
      return trimmed.replace(/[.,\s]/g, "");
    }
  }
  return null;
}

export function normalizePositiveVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null || digits === "0" || digits.startsWith("-")) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message: "Vui lòng nhập số tiền VND nguyên dương hợp lệ (không có số lẻ thập phân).",
    };
  }
  if (digits.length > 19) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số tiền vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  const value = BigInt(digits);
  if (value < ONE_BIGINT || value > VFIN_UI_PG_BIGINT_MAX) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số tiền vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  return { ok: true, canonical: value.toString(), value };
}

export function normalizeNonNegativeVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null || digits.startsWith("-")) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message: "Số tiền đầu kỳ phải là số nguyên VND không âm (nhập 0 nếu bỏ qua Vendor này).",
    };
  }
  if (digits === "0") {
    return { ok: true, canonical: "0", value: ZERO_BIGINT };
  }
  return normalizePositiveVndInput(digits);
}

export function normalizeSignedVndInput(raw: string): NormalizedVndInputResult {
  const digits = extractRawVndIntegerDigits(raw);
  if (digits === null) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_INVALID",
      message:
        "Số dư xác nhận phải là số nguyên VND hợp lệ (dương nếu còn phải trả, âm nếu Vendor đang dư ứng, hoặc 0).",
    };
  }
  const unsigned = digits.startsWith("-") ? digits.slice(1) : digits;
  if (unsigned.length > 19) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số dư vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  const value = BigInt(digits);
  if (value < VFIN_UI_PG_BIGINT_MIN || value > VFIN_UI_PG_BIGINT_MAX) {
    return {
      ok: false,
      code: "VENDOR_FINANCE_AMOUNT_OVERFLOW",
      message: "Số dư vượt giới hạn tối đa cho phép của hệ thống.",
    };
  }
  return { ok: true, canonical: value.toString(), value };
}

/**
 * Pure client-side preview calculation for the Reconciliation dialog ONLY
 * (`difference = confirmed - system`), using `BigInt` with zero float math.
 * Server remains the sole authority when saving.
 */
export function computeReconciliationDifferencePreview(
  systemBalanceMinor: string,
  confirmedBalanceMinor: string,
): string | null {
  const sys = parseCanonicalSignedMoneyBigInt(systemBalanceMinor);
  const conf = parseCanonicalSignedMoneyBigInt(confirmedBalanceMinor);
  if (sys === null || conf === null) return null;
  const diff = conf - sys;
  if (diff < VFIN_UI_PG_BIGINT_MIN || diff > VFIN_UI_PG_BIGINT_MAX) {
    return null;
  }
  return diff.toString();
}

export function formatVietnamDateLabel(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return "—";
  }
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

export function formatTimestampVi(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return "—";
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return isoTimestamp;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed));
}

export function formatFileSizeVi(sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) {
    const kbTenths = Math.round((sizeBytes * 10) / 1024);
    return `${(kbTenths / 10).toFixed(1)} KB`;
  }
  const mbTenths = Math.round((sizeBytes * 10) / (1024 * 1024));
  return `${(mbTenths / 10).toFixed(1)} MB`;
}

// -----------------------------------------------------------------------------
// 4. Route & API URL Builders
// -----------------------------------------------------------------------------
export function isCanonicalUiVendorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "__system_vendor__" &&
    VENDOR_ID_REGEX.test(value)
  );
}

export function isCanonicalUiProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_REGEX.test(value);
}

export function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

export function buildVendorFinanceContextUrl(): string {
  return "/api/vendor-finance/context";
}

export function buildVendorListUrl(params?: {
  search?: string | null;
  active?: VendorFinanceActiveFilter;
  balance_filter?: VendorFinanceBalanceFilter;
  project_id?: string | null;
  accountant_ref?: string | null;
  ledger_scope?: VendorFinanceLedgerScopeFilter;
  contract_type?: VendorFinanceContractTypeFilter;
  page?: number;
  page_size?: number;
}): string {
  const sp = new URLSearchParams();
  if (params?.search !== undefined && params.search !== null) {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      sp.set("search", trimmed.slice(0, VFIN_UI_MAX_SEARCH_LENGTH));
    }
  }
  if (params?.active && params.active !== "all") {
    sp.set("active", params.active);
  }
  if (params?.balance_filter && params.balance_filter !== "all") {
    sp.set("balance_filter", params.balance_filter);
  }
  if (params?.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params?.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params?.ledger_scope && params.ledger_scope !== "all") {
    sp.set("ledger_scope", params.ledger_scope);
  }
  if (params?.contract_type && params.contract_type !== "all") {
    sp.set("contract_type", params.contract_type);
  }
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  return qs ? `/api/vendor-finance/vendors?${qs}` : "/api/vendor-finance/vendors";
}

export function buildVendorDetailUrl(
  vendorId: string,
  params?: {
    project_id?: string | null;
    accountant_ref?: string | null;
    ledger_scope?: VendorFinanceLedgerScope | null;
    contract_type?: VendorFinanceContractType | null;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.ledger_scope) {
    sp.set("ledger_scope", params.ledger_scope);
  }
  if (params?.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params?.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params?.contract_type) {
    sp.set("contract_type", params.contract_type);
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}`;
  return qs ? `${base}?${qs}` : base;
}

export function buildVendorEntriesUrl(
  vendorId: string,
  params?: {
    cursor?: string | null;
    entry_type?: VendorFinanceEntryType | null;
    page_size?: number;
    project_id?: string | null;
    accountant_ref?: string | null;
    ledger_scope?: VendorFinanceLedgerScope | null;
    contract_type?: VendorFinanceContractType | null;
    month?: string | null;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.cursor) {
    sp.set("cursor", params.cursor);
  }
  if (params?.entry_type) {
    sp.set("entry_type", params.entry_type);
  }
  if (params?.ledger_scope) {
    sp.set("ledger_scope", params.ledger_scope);
  }
  if (params?.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params?.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params?.contract_type) {
    sp.set("contract_type", params.contract_type);
  }
  if (params?.month && CALENDAR_MONTH_REGEX.test(params.month)) {
    sp.set("month", params.month);
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/entries`;
  return qs ? `${base}?${qs}` : base;
}

export function buildSingleEntryUrl(entryId: string): string {
  return `/api/vendor-finance/entries/${encodeURIComponent(entryId)}`;
}

export function buildReverseEntryUrl(entryId: string): string {
  return `/api/vendor-finance/entries/${encodeURIComponent(entryId)}/reverse`;
}

export function buildOpeningPreviewUrl(): string {
  return "/api/vendor-finance/opening-batches/preview";
}

export function buildOpeningApplyUrl(): string {
  return "/api/vendor-finance/opening-batches/apply";
}

export function buildVendorReconciliationsUrl(
  vendorId: string,
  params?: {
    page?: number;
    page_size?: number;
    project_id?: string | null;
    accountant_ref?: string | null;
    ledger_scope?: VendorFinanceLedgerScope | null;
    contract_type?: VendorFinanceContractType | null;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.ledger_scope) {
    sp.set("ledger_scope", params.ledger_scope);
  }
  if (params?.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params?.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params?.contract_type) {
    sp.set("contract_type", params.contract_type);
  }
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/reconciliations`;
  return qs ? `${base}?${qs}` : base;
}

export function buildClassifySubLedgerUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/classify-contract-type`;
}

export function buildMonthlyReportUrl(params: {
  month: string;
  project_id?: string | null;
  accountant_ref?: string | null;
  vendor_id?: string | null;
  contract_type?: VendorFinanceContractTypeFilter;
}): string {
  const sp = new URLSearchParams();
  sp.set("month", params.month.trim());
  if (params.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params.vendor_id && isCanonicalUiVendorId(params.vendor_id)) {
    sp.set("vendor_id", params.vendor_id);
  }
  if (params.contract_type && params.contract_type !== "all") {
    sp.set("contract_type", params.contract_type);
  }
  return `/api/vendor-finance/reports/monthly?${sp.toString()}`;
}

export function buildAdminProjectAccountantsUrl(params?: {
  search?: string | null;
  include_history?: boolean;
  page?: number;
  page_size?: number;
}): string {
  const sp = new URLSearchParams();
  if (params?.search !== undefined && params.search !== null) {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      sp.set("search", trimmed.slice(0, VFIN_UI_MAX_SEARCH_LENGTH));
    }
  }
  if (params?.include_history) {
    sp.set("include_history", "true");
  }
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  return qs
    ? `/api/vendor-finance/admin/project-accountants?${qs}`
    : "/api/vendor-finance/admin/project-accountants";
}

export function buildAdminEndProjectAccountantUrl(assignmentId: string): string {
  return `/api/vendor-finance/admin/project-accountants/${encodeURIComponent(assignmentId)}/end`;
}

export function buildAdminGlobalRolesUrl(params?: {
  search?: string | null;
  include_history?: boolean;
  page?: number;
  page_size?: number;
}): string {
  const sp = new URLSearchParams();
  if (params?.search !== undefined && params.search !== null) {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      sp.set("search", trimmed.slice(0, VFIN_UI_MAX_SEARCH_LENGTH));
    }
  }
  if (params?.include_history) {
    sp.set("include_history", "true");
  }
  if (params?.page && Number.isSafeInteger(params.page) && params.page > 1) {
    sp.set("page", String(params.page));
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  return qs
    ? `/api/vendor-finance/admin/global-roles?${qs}`
    : "/api/vendor-finance/admin/global-roles";
}

export function buildAdminEndGlobalRoleUrl(roleGrantId: string): string {
  return `/api/vendor-finance/admin/global-roles/${encodeURIComponent(roleGrantId)}/end`;
}

export function buildReserveEvidenceUrl(): string {
  return "/api/vendor-finance/evidence/reserve";
}

export function buildFinalizeEvidenceUrl(evidenceId: string): string {
  return `/api/vendor-finance/evidence/${encodeURIComponent(evidenceId)}/finalize`;
}

export function buildDownloadEvidenceUrl(evidenceId: string): string {
  return `/api/vendor-finance/evidence/${encodeURIComponent(evidenceId)}/download`;
}

export function buildVendorExportUrl(params?: {
  search?: string | null;
  active?: VendorFinanceActiveFilter;
  balance_filter?: VendorFinanceBalanceFilter;
  project_id?: string | null;
  accountant_ref?: string | null;
  ledger_scope?: VendorFinanceLedgerScopeFilter;
  contract_type?: VendorFinanceContractTypeFilter;
}): string {
  const sp = new URLSearchParams();
  if (params?.search !== undefined && params.search !== null) {
    const trimmed = params.search.trim();
    if (trimmed.length > 0) {
      sp.set("search", trimmed.slice(0, VFIN_UI_MAX_SEARCH_LENGTH));
    }
  }
  if (params?.active && params.active !== "all") {
    sp.set("active", params.active);
  }
  if (params?.balance_filter && params.balance_filter !== "all") {
    sp.set("balance_filter", params.balance_filter);
  }
  if (params?.project_id && isCanonicalUiProjectId(params.project_id)) {
    sp.set("project_id", params.project_id);
  }
  if (params?.accountant_ref && isUuidString(params.accountant_ref)) {
    sp.set("accountant_ref", params.accountant_ref.toLowerCase());
  }
  if (params?.ledger_scope && params.ledger_scope !== "all") {
    sp.set("ledger_scope", params.ledger_scope);
  }
  if (params?.contract_type && params.contract_type !== "all") {
    sp.set("contract_type", params.contract_type);
  }
  const qs = sp.toString();
  return qs ? `/api/vendor-finance/vendors/export?${qs}` : "/api/vendor-finance/vendors/export";
}

export function buildVendorSharedAdvancesUrl(
  vendorId: string,
  params?: {
    cursor?: string | null;
    movement_type?: VendorFinanceSharedAdvanceMovementType | null;
    page_size?: number;
  },
): string {
  const sp = new URLSearchParams();
  if (params?.cursor) {
    sp.set("cursor", params.cursor);
  }
  if (params?.movement_type) {
    sp.set("movement_type", params.movement_type);
  }
  if (params?.page_size && Number.isSafeInteger(params.page_size)) {
    sp.set("page_size", String(params.page_size));
  }
  const qs = sp.toString();
  const base = `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/shared-advances`;
  return qs ? `${base}?${qs}` : base;
}

export function buildFundVendorSharedAdvanceUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/shared-advances/fund`;
}

export function buildRecordVendorRefundUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/shared-advances/refund`;
}

export function buildApplyVendorSharedAdvanceOffsetUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/shared-advances/apply-offset`;
}

export function buildRecordVendorPaymentWithOffsetUrl(vendorId: string): string {
  return `/api/vendor-finance/vendors/${encodeURIComponent(vendorId)}/shared-advances/settle-with-offset`;
}

export function buildReverseVendorSharedAdvanceMovementUrl(movementId: string): string {
  return `/api/vendor-finance/shared-advances/${encodeURIComponent(movementId)}/reverse`;
}

// -----------------------------------------------------------------------------
// 5. Client Request Builders (Strict Contract Parity, Zero Authority Fields)
// -----------------------------------------------------------------------------
export function createClientIdempotencyKey(): string {
  return globalThis.crypto.randomUUID().toLowerCase();
}

export function validateUiCalendarDate(
  raw: string,
): { ok: true; date: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!isRealCalendarDate(trimmed)) {
    return { ok: false, message: "Ngày hiệu lực không hợp lệ (định dạng YYYY-MM-DD)." };
  }
  const year = Number(trimmed.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, message: "Năm của ngày hiệu lực phải nằm trong khoảng 1970–2999." };
  }
  return { ok: true, date: trimmed };
}

export function validateUiCalendarMonth(
  raw: string,
): { ok: true; month: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!CALENDAR_MONTH_REGEX.test(trimmed)) {
    return { ok: false, message: "Kỳ báo cáo tháng không hợp lệ (định dạng YYYY-MM)." };
  }
  const year = Number(trimmed.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, message: "Năm của kỳ báo cáo tháng phải nằm trong khoảng 1970–2999." };
  }
  return { ok: true, month: trimmed };
}

export function validateUiReasonText(
  raw: string,
): { ok: true; reason: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length < 1) {
    return { ok: false, message: "Vui lòng nhập lý do ghi nhận." };
  }
  if (trimmed.length > VFIN_UI_MAX_REASON_LENGTH) {
    return {
      ok: false,
      message: `Lý do không được vượt quá ${VFIN_UI_MAX_REASON_LENGTH} ký tự.`,
    };
  }
  if (FORBIDDEN_TEXT_CONTROL_CHARS.test(trimmed)) {
    return { ok: false, message: "Lý do chứa ký tự điều khiển không hợp lệ." };
  }
  return { ok: true, reason: trimmed };
}

export function validateUiSearchInput(
  raw: string,
): { ok: true; search: string | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, search: null };
  if (trimmed.length > VFIN_UI_MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      message: `Từ khóa tìm kiếm không được vượt quá ${VFIN_UI_MAX_SEARCH_LENGTH} ký tự.`,
    };
  }
  if (FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(trimmed)) {
    return { ok: false, message: "Từ khóa tìm kiếm chứa ký tự không hợp lệ." };
  }
  return { ok: true, search: trimmed };
}

export type BuiltJsonRequest<TBody> = {
  headers: Readonly<Record<string, string>>;
  body: TBody;
};

export function buildRecordEntryRequest(input: {
  project_id: string;
  contract_type: string;
  entry_type: string;
  amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  allowed_entry_types?: readonly NormalVendorFinanceEntryType[];
  current_subledger_payable_minor?: string | null;
}):
  | { ok: true; request: BuiltJsonRequest<RecordVendorFinanceEntryBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để ghi nhận bút toán." };
  }
  if (!(VFIN_UI_CLASSIFIED_CONTRACT_TYPES as readonly string[]).includes(input.contract_type)) {
    return {
      ok: false,
      message: "Vui lòng chọn loại hợp đồng (Thời vụ hoặc Chính thức) cho bút toán.",
    };
  }
  const contractType = input.contract_type as ClassifiedVendorFinanceContractType;
  if (!(VFIN_UI_NORMAL_ENTRY_TYPES as readonly string[]).includes(input.entry_type)) {
    return { ok: false, message: "Loại bút toán không hợp lệ." };
  }
  const entryType = input.entry_type as NormalVendorFinanceEntryType;
  if (input.allowed_entry_types && !input.allowed_entry_types.includes(entryType)) {
    return {
      ok: false,
      message: "Loại bút toán này không được phép áp dụng cho trạng thái Vendor hiện tại.",
    };
  }
  const amount = normalizePositiveVndInput(input.amount_input);
  if (!amount.ok) {
    return { ok: false, message: amount.message };
  }
  if (
    entryType === "PAYMENT_RECORDED" &&
    typeof input.current_subledger_payable_minor === "string" &&
    /^(?:0|-?[1-9][0-9]{0,18})$/.test(input.current_subledger_payable_minor)
  ) {
    const payable = BigInt(input.current_subledger_payable_minor);
    if (payable <= ZERO_BIGINT || amount.value > payable) {
      return {
        ok: false,
        message:
          "Số tiền thanh toán vượt quá công nợ phải trả hiện tại của sổ dự án và loại hợp đồng đã chọn.",
      };
    }
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        contract_type: contractType,
        entry_type: entryType,
        amount_minor: amount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildReverseEntryRequest(input: {
  effective_date: string | null | undefined;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ReverseVendorFinanceEntryBody> }
  | { ok: false; message: string } {
  let effectiveDate: string | null = null;
  if (typeof input.effective_date === "string" && input.effective_date.trim().length > 0) {
    const parsedDate = validateUiCalendarDate(input.effective_date);
    if (!parsedDate.ok) {
      return { ok: false, message: parsedDate.message };
    }
    effectiveDate = parsedDate.date;
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        effective_date: effectiveDate,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export type OpeningDraftRowInput = {
  vendor_id: string;
  entry_type: string;
  amount_input: string;
};

function normalizeOpeningDraftItems(
  rows: readonly OpeningDraftRowInput[],
):
  | {
      ok: true;
      items: OpeningBatchItemInput[];
      non_zero_count: number;
      zero_count: number;
    }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  if (rows.length < 1) {
    return {
      ok: false,
      message: "Vui lòng chọn ít nhất một Vendor chưa khởi tạo để lập lô số dư đầu kỳ.",
    };
  }
  if (rows.length > VFIN_UI_MAX_OPENING_BATCH_ITEMS) {
    return {
      ok: false,
      message: `Mỗi lô khởi tạo tối đa ${VFIN_UI_MAX_OPENING_BATCH_ITEMS} Vendor.`,
    };
  }

  const seenVendors = new Set<string>();
  const items: OpeningBatchItemInput[] = [];
  let nonZeroCount = 0;
  let zeroCount = 0;

  for (const row of rows) {
    if (!isCanonicalUiVendorId(row.vendor_id)) {
      return {
        ok: false,
        message: "Mã Vendor trong danh sách đầu kỳ không hợp lệ.",
      };
    }
    if (seenVendors.has(row.vendor_id)) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: `Vendor "${row.vendor_id}" bị trùng lặp trong cùng một lô đầu kỳ.`,
      };
    }
    seenVendors.add(row.vendor_id);

    if (!(VFIN_UI_OPENING_ENTRY_TYPES as readonly string[]).includes(row.entry_type)) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: "Loại số dư đầu kỳ không hợp lệ (chỉ chấp nhận Phải trả hoặc Dư ứng).",
      };
    }
    const amount = normalizeNonNegativeVndInput(row.amount_input);
    if (!amount.ok) {
      return {
        ok: false,
        invalid_vendor_id: row.vendor_id,
        message: `${amount.message} (Vendor: ${row.vendor_id}).`,
      };
    }
    if (amount.value > ZERO_BIGINT) {
      nonZeroCount += 1;
    } else {
      zeroCount += 1;
    }
    items.push({
      vendor_id: row.vendor_id,
      entry_type: row.entry_type as OpeningVendorFinanceEntryType,
      amount_minor: amount.canonical,
    });
  }

  if (nonZeroCount === 0) {
    return {
      ok: false,
      message:
        "Lô khởi tạo phải có ít nhất một Vendor có số dư lớn hơn 0 ₫ (các dòng 0 ₫ sẽ được hệ thống bỏ qua).",
    };
  }

  return {
    ok: true,
    items,
    non_zero_count: nonZeroCount,
    zero_count: zeroCount,
  };
}

export function buildOpeningPreviewRequest(input: {
  project_id: string;
  contract_type: string;
  cutoff_date: string;
  rows: readonly OpeningDraftRowInput[];
}):
  | {
      ok: true;
      request: BuiltJsonRequest<PreviewOpeningBatchBody>;
      non_zero_count: number;
      zero_count: number;
    }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để khởi tạo công nợ đầu kỳ." };
  }
  if (!(VFIN_UI_CLASSIFIED_CONTRACT_TYPES as readonly string[]).includes(input.contract_type)) {
    return {
      ok: false,
      message: "Vui lòng chọn loại hợp đồng (Thời vụ hoặc Chính thức) cho lô số dư đầu kỳ.",
    };
  }
  const contractType = input.contract_type as ClassifiedVendorFinanceContractType;
  const cutoffDate = validateUiCalendarDate(input.cutoff_date);
  if (!cutoffDate.ok) {
    return { ok: false, message: "Ngày chốt số dư đầu kỳ (cutoff date) không hợp lệ." };
  }
  const normalized = normalizeOpeningDraftItems(input.rows);
  if (!normalized.ok) {
    return normalized;
  }
  return {
    ok: true,
    non_zero_count: normalized.non_zero_count,
    zero_count: normalized.zero_count,
    request: {
      headers: { "Content-Type": "application/json" },
      body: {
        project_id: trimmedProject,
        contract_type: contractType,
        cutoff_date: cutoffDate.date,
        items: normalized.items,
      },
    },
  };
}

export function buildOpeningApplyRequest(input: {
  project_id: string;
  contract_type: string;
  cutoff_date: string;
  rows: readonly OpeningDraftRowInput[];
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ApplyOpeningBatchBody> }
  | { ok: false; message: string; invalid_vendor_id?: string } {
  const previewBuilt = buildOpeningPreviewRequest({
    project_id: input.project_id,
    contract_type: input.contract_type,
    cutoff_date: input.cutoff_date,
    rows: input.rows,
  });
  if (!previewBuilt.ok) {
    return previewBuilt;
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: previewBuilt.request.body.project_id,
        contract_type: previewBuilt.request.body.contract_type,
        cutoff_date: previewBuilt.request.body.cutoff_date,
        items: previewBuilt.request.body.items,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildCreateReconciliationRequest(input: {
  project_id: string;
  accountant_ref?: string | null;
  contract_type: string;
  as_of_date: string;
  confirmed_balance_input: string;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<CreateVendorReconciliationBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để đối soát số dư." };
  }
  let accountantRef: string | null = null;
  if (typeof input.accountant_ref === "string" && input.accountant_ref.trim().length > 0) {
    if (!isUuidString(input.accountant_ref.trim())) {
      return { ok: false, message: "Kế toán phụ trách sổ được chọn không hợp lệ." };
    }
    accountantRef = input.accountant_ref.trim().toLowerCase();
  }
  if (!(VFIN_UI_CONTRACT_TYPES as readonly string[]).includes(input.contract_type)) {
    return { ok: false, message: "Loại hợp đồng của sổ đối soát không hợp lệ." };
  }
  const contractType = input.contract_type as VendorFinanceContractType;
  const asOfDate = validateUiCalendarDate(input.as_of_date);
  if (!asOfDate.ok) {
    return { ok: false, message: asOfDate.message };
  }
  const confirmed = normalizeSignedVndInput(input.confirmed_balance_input);
  if (!confirmed.ok) {
    return { ok: false, message: confirmed.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        accountant_ref: accountantRef,
        contract_type: contractType,
        as_of_date: asOfDate.date,
        confirmed_balance_minor: confirmed.canonical,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildClassifySubLedgerRequest(input: {
  project_id: string;
  accountant_ref?: string | null;
  target_contract_type: string;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ClassifyVendorSubLedgerBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để phân loại sổ." };
  }
  let accountantRef: string | null = null;
  if (typeof input.accountant_ref === "string" && input.accountant_ref.trim().length > 0) {
    if (!isUuidString(input.accountant_ref.trim())) {
      return { ok: false, message: "Kế toán phụ trách sổ được chọn không hợp lệ." };
    }
    accountantRef = input.accountant_ref.trim().toLowerCase();
  }
  if (!(VFIN_UI_CLASSIFIED_CONTRACT_TYPES as readonly string[]).includes(input.target_contract_type)) {
    return {
      ok: false,
      message: "Vui lòng chọn loại hợp đồng đích hợp lệ (Thời vụ hoặc Chính thức).",
    };
  }
  const targetContractType = input.target_contract_type as ClassifiedVendorFinanceContractType;
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        accountant_ref: accountantRef,
        target_contract_type: targetContractType,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

function resolveVendorFinanceUiToday(authorizationDate?: string | null): string {
  if (typeof authorizationDate === "string") {
    const parsed = validateUiCalendarDate(authorizationDate);
    if (parsed.ok) return parsed.date;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function buildAssignProjectAccountantRequest(input: {
  project_id: string;
  accountant_ref: string;
  valid_from?: string | null;
  authorization_date?: string | null;
  expected_version: number;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<AssignProjectAccountantBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Mã dự án không hợp lệ." };
  }
  if (!isUuidString(input.accountant_ref)) {
    return { ok: false, message: "Vui lòng chọn kế toán phụ trách thuộc Phòng Kế toán." };
  }
  const businessToday = resolveVendorFinanceUiToday(input.authorization_date);
  let validFrom: string | null = null;
  if (typeof input.valid_from === "string" && input.valid_from.trim().length > 0) {
    const parsedDate = validateUiCalendarDate(input.valid_from);
    if (!parsedDate.ok) return { ok: false, message: parsedDate.message };
    if (parsedDate.date > businessToday) {
      return {
        ok: false,
        message: `Ngày bắt đầu hiệu lực không được vượt quá ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    if (parsedDate.date < businessToday) {
      return {
        ok: false,
        message: `Ngày bắt đầu hiệu lực không được ở quá khứ so với ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    validFrom = parsedDate.date;
  }
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
    return { ok: false, message: "Phiên bản phân công (OCC) không hợp lệ." };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) return { ok: false, message: reason.message };
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        accountant_ref: input.accountant_ref.toLowerCase(),
        valid_from: validFrom,
        expected_version: input.expected_version,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildEndProjectAccountantRequest(input: {
  expected_version: number;
  valid_to?: string | null;
  authorization_date?: string | null;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<EndProjectAccountantBody> }
  | { ok: false; message: string } {
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
    return { ok: false, message: "Phiên bản phân công (OCC) không hợp lệ." };
  }
  const businessToday = resolveVendorFinanceUiToday(input.authorization_date);
  let validTo: string | null = null;
  if (typeof input.valid_to === "string" && input.valid_to.trim().length > 0) {
    const parsedDate = validateUiCalendarDate(input.valid_to);
    if (!parsedDate.ok) return { ok: false, message: parsedDate.message };
    if (parsedDate.date > businessToday) {
      return {
        ok: false,
        message: `Ngày kết thúc hiệu lực không được vượt quá ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    if (parsedDate.date < businessToday) {
      return {
        ok: false,
        message: `Ngày kết thúc hiệu lực không được ở quá khứ so với ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    validTo = parsedDate.date;
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) return { ok: false, message: reason.message };
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        expected_version: input.expected_version,
        valid_to: validTo,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildAssignGlobalRoleRequest(input: {
  account_ref: string;
  role_code: string;
  valid_from?: string | null;
  authorization_date?: string | null;
  expected_version: number;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<AssignGlobalRoleBody> }
  | { ok: false; message: string } {
  if (!isUuidString(input.account_ref)) {
    return { ok: false, message: "Vui lòng chọn tài khoản hợp lệ để cấp vai trò." };
  }
  if (!(VFIN_UI_GLOBAL_ROLE_CODES as readonly string[]).includes(input.role_code)) {
    return { ok: false, message: "Mã vai trò tài chính toàn cục không hợp lệ." };
  }
  const businessToday = resolveVendorFinanceUiToday(input.authorization_date);
  let validFrom: string | null = null;
  if (typeof input.valid_from === "string" && input.valid_from.trim().length > 0) {
    const parsedDate = validateUiCalendarDate(input.valid_from);
    if (!parsedDate.ok) return { ok: false, message: parsedDate.message };
    if (parsedDate.date > businessToday) {
      return {
        ok: false,
        message: `Ngày bắt đầu hiệu lực không được vượt quá ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    if (parsedDate.date < businessToday) {
      return {
        ok: false,
        message: `Ngày bắt đầu hiệu lực không được ở quá khứ so với ngày nghiệp vụ hiện tại (${businessToday}).`,
      };
    }
    validFrom = parsedDate.date;
  }
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
    return { ok: false, message: "Phiên bản cấp vai trò (OCC) không hợp lệ." };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) return { ok: false, message: reason.message };
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        account_ref: input.account_ref.toLowerCase(),
        role_code: input.role_code as VendorFinanceGlobalRoleCode,
        valid_from: validFrom,
        expected_version: input.expected_version,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildEndGlobalRoleRequest(input: {
  expected_version: number;
  valid_to?: string | null;
  authorization_date?: string | null;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<EndGlobalRoleBody> }
  | { ok: false; message: string } {
  return buildEndProjectAccountantRequest(input);
}

export function buildReserveEvidenceRequest(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ReserveVendorFinanceEvidenceBody> }
  | { ok: false; message: string } {
  if (!(VFIN_UI_EVIDENCE_TARGET_KINDS as readonly string[]).includes(input.target_kind)) {
    return { ok: false, message: "Đối tượng đính kèm bằng chứng không hợp lệ." };
  }
  if (!isUuidString(input.target_id)) {
    return { ok: false, message: "Mã bút toán/đối soát để đính kèm ảnh không hợp lệ." };
  }
  if (!(VFIN_UI_EVIDENCE_MIME_TYPES as readonly string[]).includes(input.mime_type)) {
    return { ok: false, message: "Ảnh bằng chứng chỉ hỗ trợ định dạng JPEG hoặc PNG." };
  }
  if (
    !Number.isSafeInteger(input.size_bytes) ||
    input.size_bytes < 1 ||
    input.size_bytes > VFIN_UI_EVIDENCE_MAX_BYTES
  ) {
    return { ok: false, message: "Dung lượng ảnh bằng chứng phải từ 1 byte đến tối đa 10 MB." };
  }
  if (!SHA256_HEX_REGEX.test(input.checksum_sha256)) {
    return { ok: false, message: "Mã băm kiểm tra toàn vẹn ảnh (SHA-256) không hợp lệ." };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        target_kind: input.target_kind,
        target_id: input.target_id.toLowerCase(),
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        checksum_sha256: input.checksum_sha256.toLowerCase(),
        idempotency_key: idem,
      },
    },
  };
}

export function buildFinalizeEvidenceRequest(): BuiltJsonRequest<Record<string, never>> {
  return {
    headers: { "Content-Type": "application/json" },
    body: {},
  };
}

export function buildFundSharedAdvanceRequest(input: {
  amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<FundSharedAdvanceBody> }
  | { ok: false; message: string } {
  const amount = normalizePositiveVndInput(input.amount_input);
  if (!amount.ok) {
    return { ok: false, message: amount.message };
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        amount_minor: amount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildRecordVendorRefundRequest(input: {
  amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  available_shared_advance_minor?: string | null;
}):
  | { ok: true; request: BuiltJsonRequest<RecordVendorRefundBody> }
  | { ok: false; message: string } {
  const amount = normalizePositiveVndInput(input.amount_input);
  if (!amount.ok) {
    return { ok: false, message: amount.message };
  }
  if (
    typeof input.available_shared_advance_minor === "string" &&
    /^(?:0|[1-9][0-9]{0,18})$/.test(input.available_shared_advance_minor)
  ) {
    const avail = BigInt(input.available_shared_advance_minor);
    if (amount.value > avail) {
      return {
        ok: false,
        message: "Số tiền hoàn ứng vượt quá số dư ứng dùng chung hiện tại của Vendor.",
      };
    }
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        amount_minor: amount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildApplySharedAdvanceOffsetRequest(input: {
  project_id: string;
  contract_type: string;
  amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  available_shared_advance_minor?: string | null;
  current_subledger_payable_minor?: string | null;
}):
  | { ok: true; request: BuiltJsonRequest<ApplySharedAdvanceOffsetBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để khấu trừ ứng." };
  }
  if (!(VFIN_UI_CLASSIFIED_CONTRACT_TYPES as readonly string[]).includes(input.contract_type)) {
    return {
      ok: false,
      message: "Chỉ sổ đã phân loại hợp đồng (Thời vụ hoặc Chính thức) mới được khấu trừ ứng.",
    };
  }
  const contractType = input.contract_type as ClassifiedVendorFinanceContractType;
  const amount = normalizePositiveVndInput(input.amount_input);
  if (!amount.ok) {
    return { ok: false, message: amount.message };
  }
  if (
    typeof input.available_shared_advance_minor === "string" &&
    /^(?:0|[1-9][0-9]{0,18})$/.test(input.available_shared_advance_minor)
  ) {
    const avail = BigInt(input.available_shared_advance_minor);
    if (amount.value > avail) {
      return {
        ok: false,
        message: "Số tiền khấu trừ vượt quá số dư ứng dùng chung hiện tại của Vendor.",
      };
    }
  }
  if (
    typeof input.current_subledger_payable_minor === "string" &&
    /^(?:0|-?[1-9][0-9]{0,18})$/.test(input.current_subledger_payable_minor)
  ) {
    const payable = BigInt(input.current_subledger_payable_minor);
    if (payable <= ZERO_BIGINT || amount.value > payable) {
      return {
        ok: false,
        message:
          "Số tiền khấu trừ vượt quá công nợ phải trả hiện tại của sổ dự án và loại hợp đồng đã chọn.",
      };
    }
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        contract_type: contractType,
        amount_minor: amount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildRecordPaymentWithOffsetRequest(input: {
  project_id: string;
  contract_type: string;
  payment_amount_input: string;
  offset_amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  available_shared_advance_minor?: string | null;
  current_subledger_payable_minor?: string | null;
}):
  | { ok: true; request: BuiltJsonRequest<RecordPaymentWithOffsetBody> }
  | { ok: false; message: string } {
  const trimmedProject = input.project_id.trim();
  if (!isCanonicalUiProjectId(trimmedProject)) {
    return { ok: false, message: "Vui lòng chọn dự án hợp lệ để thanh toán và khấu trừ ứng." };
  }
  if (!(VFIN_UI_CLASSIFIED_CONTRACT_TYPES as readonly string[]).includes(input.contract_type)) {
    return {
      ok: false,
      message: "Chỉ sổ đã phân loại hợp đồng (Thời vụ hoặc Chính thức) mới được thanh toán và khấu trừ ứng.",
    };
  }
  const contractType = input.contract_type as ClassifiedVendorFinanceContractType;
  const paymentAmount = normalizePositiveVndInput(input.payment_amount_input);
  if (!paymentAmount.ok) {
    return { ok: false, message: `Số tiền trả TM/CK: ${paymentAmount.message}` };
  }
  const offsetAmount = normalizePositiveVndInput(input.offset_amount_input);
  if (!offsetAmount.ok) {
    return { ok: false, message: `Số tiền khấu trừ ứng: ${offsetAmount.message}` };
  }
  const totalAmount = paymentAmount.value + offsetAmount.value;
  if (totalAmount > VFIN_UI_PG_BIGINT_MAX) {
    return {
      ok: false,
      message: "Tổng số tiền thanh toán và khấu trừ vượt quá giới hạn hệ thống.",
    };
  }
  if (
    typeof input.available_shared_advance_minor === "string" &&
    /^(?:0|[1-9][0-9]{0,18})$/.test(input.available_shared_advance_minor)
  ) {
    const avail = BigInt(input.available_shared_advance_minor);
    if (offsetAmount.value > avail) {
      return {
        ok: false,
        message: "Số tiền khấu trừ vượt quá số dư ứng dùng chung hiện tại của Vendor.",
      };
    }
  }
  if (
    typeof input.current_subledger_payable_minor === "string" &&
    /^(?:0|-?[1-9][0-9]{0,18})$/.test(input.current_subledger_payable_minor)
  ) {
    const payable = BigInt(input.current_subledger_payable_minor);
    if (payable <= ZERO_BIGINT || totalAmount > payable) {
      return {
        ok: false,
        message:
          "Tổng tiền trả TM/CK và khấu trừ ứng vượt quá công nợ phải trả hiện tại của sổ dự án và loại hợp đồng đã chọn.",
      };
    }
  }
  const effectiveDate = validateUiCalendarDate(input.effective_date);
  if (!effectiveDate.ok) {
    return { ok: false, message: effectiveDate.message };
  }
  const reason = validateUiReasonText(input.reason);
  if (!reason.ok) {
    return { ok: false, message: reason.message };
  }
  if (!isUuidString(input.idempotency_key)) {
    return { ok: false, message: "Mã chống gửi trùng (Idempotency-Key) không hợp lệ." };
  }
  const idem = input.idempotency_key.toLowerCase();
  return {
    ok: true,
    request: {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idem,
      },
      body: {
        project_id: trimmedProject,
        contract_type: contractType,
        payment_amount_minor: paymentAmount.canonical,
        offset_amount_minor: offsetAmount.canonical,
        effective_date: effectiveDate.date,
        reason: reason.reason,
        idempotency_key: idem,
      },
    },
  };
}

export function buildReverseSharedAdvanceMovementRequest(input: {
  effective_date: string | null | undefined;
  reason: string;
  idempotency_key: string;
}):
  | { ok: true; request: BuiltJsonRequest<ReverseSharedAdvanceMovementBody> }
  | { ok: false; message: string } {
  return buildReverseEntryRequest(input);
}

// -----------------------------------------------------------------------------
// 6. Fail-Closed HTTP Envelope Parsers (`{ ok: true, data }`)
// -----------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function requiredAndOptionalKeysOnly(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) {
      return false;
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return false;
    }
  }
  return true;
}

function nonEmptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (nonEmptyStr(value) ?? undefined);
}

function nonNegInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function posInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function boolVal(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function uuidStr(value: unknown): string | null {
  return isUuidString(value) ? value.toLowerCase() : null;
}

function nullableUuidStr(value: unknown): string | null | undefined {
  return value === null ? null : (uuidStr(value) ?? undefined);
}

function dateStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const check = validateUiCalendarDate(value);
  return check.ok ? check.date : null;
}

function nullableDateStr(value: unknown): string | null | undefined {
  return value === null ? null : (dateStr(value) ?? undefined);
}

function signedMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalSignedMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function nonNegativeMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalNonNegativeMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function positiveMoneyStr(value: unknown): string | null {
  const parsed = parseCanonicalPositiveMoneyBigInt(value);
  return parsed === null ? null : parsed.toString();
}

function isHttpsPresignedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function unwrapOkDataEnvelope(envelope: unknown): unknown | null {
  if (!isRecord(envelope) || !exactKeys(envelope, ["ok", "data"]) || envelope.ok !== true) {
    return null;
  }
  return envelope.data;
}

export function parseEvidenceSummaryProjection(value: unknown): VendorFinanceEvidenceSummary | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "evidence_id",
      "status",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "finalized_at",
    ])
  ) {
    return null;
  }
  const evidenceId = uuidStr(value.evidence_id);
  const mimeType =
    value.mime_type === "image/jpeg" || value.mime_type === "image/png" ? value.mime_type : null;
  const sizeBytes = posInt(value.size_bytes);
  const checksum =
    typeof value.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(value.checksum_sha256)
      ? value.checksum_sha256.toLowerCase()
      : null;
  const finalizedAt = nonEmptyStr(value.finalized_at);
  if (
    value.status !== "READY" ||
    evidenceId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    finalizedAt === null
  ) {
    return null;
  }
  return {
    evidence_id: evidenceId,
    status: "READY",
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    finalized_at: finalizedAt,
  };
}

function nullableBoolVal(value: unknown): boolean | null | undefined {
  return value === null ? null : (boolVal(value) ?? undefined);
}

function projectIdStr(value: unknown): string | null {
  return isCanonicalUiProjectId(value) ? value : null;
}

function nullableProjectIdStr(value: unknown): string | null | undefined {
  return value === null ? null : (projectIdStr(value) ?? undefined);
}

function ledgerScopeVal(value: unknown): VendorFinanceLedgerScope | null {
  return value === "PROJECT_ACCOUNTANT" || value === "LEGACY_UNALLOCATED" ? value : null;
}

function contractTypeVal(value: unknown): VendorFinanceContractType | null {
  return value === "UNCLASSIFIED" || value === "SEASONAL" || value === "OFFICIAL" ? value : null;
}

function classifiedContractTypeVal(value: unknown): ClassifiedVendorFinanceContractType | null {
  return value === "SEASONAL" || value === "OFFICIAL" ? value : null;
}

export function parseSubLedgerClassificationProjection(
  value: unknown,
): VendorFinanceSubLedgerClassificationProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "classification_id",
      "vendor_id",
      "project_id",
      "project_display_name_snapshot",
      "accountant_ref",
      "responsible_accountant_display_name",
      "source_contract_type",
      "target_contract_type",
      "classified_entry_count",
      "classified_reconciliation_count",
      "closing_balance_minor",
      "reason",
      "classified_by_display_name",
      "classified_at",
    ])
  ) {
    return null;
  }
  const classificationId = uuidStr(value.classification_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const projectId = projectIdStr(value.project_id);
  const projectDisplayNameSnapshot = nonEmptyStr(value.project_display_name_snapshot);
  const accountantRef = uuidStr(value.accountant_ref);
  const responsibleName = nonEmptyStr(value.responsible_accountant_display_name);
  const targetContractType = classifiedContractTypeVal(value.target_contract_type);
  const entryCount = posInt(value.classified_entry_count);
  const recCount = nonNegInt(value.classified_reconciliation_count);
  const closingBalanceMinor = signedMoneyStr(value.closing_balance_minor);
  const reason = nonEmptyStr(value.reason);
  const classifiedBy = nonEmptyStr(value.classified_by_display_name);
  const classifiedAt = nonEmptyStr(value.classified_at);

  if (
    classificationId === null ||
    vendorId === null ||
    projectId === null ||
    projectDisplayNameSnapshot === null ||
    accountantRef === null ||
    responsibleName === null ||
    value.source_contract_type !== "UNCLASSIFIED" ||
    targetContractType === null ||
    entryCount === null ||
    recCount === null ||
    closingBalanceMinor === null ||
    reason === null ||
    classifiedBy === null ||
    classifiedAt === null
  ) {
    return null;
  }

  return {
    classification_id: classificationId,
    vendor_id: vendorId,
    project_id: projectId,
    project_display_name_snapshot: projectDisplayNameSnapshot,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleName,
    source_contract_type: "UNCLASSIFIED",
    target_contract_type: targetContractType,
    classified_entry_count: entryCount,
    classified_reconciliation_count: recCount,
    closing_balance_minor: closingBalanceMinor,
    reason,
    classified_by_display_name: classifiedBy,
    classified_at: classifiedAt,
  };
}

function visibilityScopeVal(value: unknown): VendorFinanceVisibilityScope | null {
  return value === "ALL" || value === "PROJECT_SCOPED" || value === "NONE" ? value : null;
}

function writeScopeVal(value: unknown): VendorFinanceWriteScope | null {
  return value === "ALL" || value === "ASSIGNED_PROJECTS" || value === "NONE" ? value : null;
}

function balanceDirectionVal(value: unknown): VendorFinanceBalanceDirection | null {
  return value === "PAYABLE" || value === "BALANCED" || value === "ADVANCE" ? value : null;
}

function listBalanceDirectionVal(value: unknown): VendorFinanceListBalanceDirection | null {
  return value === "PAYABLE" ||
    value === "BALANCED" ||
    value === "ADVANCE" ||
    value === "MULTI_LEDGER"
    ? value
    : null;
}

function parseAccountSummaryProjection(value: unknown): VendorFinanceAccountSummary | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "account_ref",
      "display_name",
      "login_id",
      "personnel_code",
      "account_enabled",
    ])
  ) {
    return null;
  }
  const accountRef = uuidStr(value.account_ref);
  const displayName = nonEmptyStr(value.display_name);
  const loginId = nullableStr(value.login_id);
  const personnelCode = nullableStr(value.personnel_code);
  const accountEnabled = boolVal(value.account_enabled);
  if (
    accountRef === null ||
    displayName === null ||
    loginId === undefined ||
    personnelCode === undefined ||
    accountEnabled === null
  ) {
    return null;
  }
  return {
    account_ref: accountRef,
    display_name: displayName,
    login_id: loginId,
    personnel_code: personnelCode,
    account_enabled: accountEnabled,
  };
}

export function parseVendorFinanceContextEnvelope(
  envelope: unknown,
): VendorFinanceActorContextOptionsResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "allowed_actions",
      "has_legacy_unallocated",
      "projects",
      "vendors",
      "accountants",
    ]) ||
    !isRecord(data.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      data.allowed_actions,
      [
        "visibility_scope",
        "record_scope",
        "reconcile_scope",
        "can_view",
        "can_record",
        "can_reconcile",
        "can_manage_project_assignments",
      ],
      [
        "can_view_shared_advance",
        "can_fund_vendor_advance",
        "can_record_vendor_refund",
        "can_apply_vendor_advance",
      ],
    ) ||
    !Array.isArray(data.projects) ||
    !Array.isArray(data.vendors) ||
    !Array.isArray(data.accountants)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const visibilityScope = visibilityScopeVal(data.allowed_actions.visibility_scope);
  const recordScope = writeScopeVal(data.allowed_actions.record_scope);
  const reconcileScope = writeScopeVal(data.allowed_actions.reconcile_scope);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const canReconcile = boolVal(data.allowed_actions.can_reconcile);
  const canManage = boolVal(data.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_fund_vendor_advance)
      : recordScope === "ALL";
  const canRefund =
    "can_record_vendor_refund" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_record_vendor_refund)
      : recordScope === "ALL";
  const canApply =
    "can_apply_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const hasLegacy = boolVal(data.has_legacy_unallocated);

  if (
    authorizationDate === null ||
    visibilityScope === null ||
    recordScope === null ||
    reconcileScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    hasLegacy === null
  ) {
    return null;
  }

  const projects: VendorFinanceContextProjectOption[] = [];
  for (const rawProject of data.projects) {
    if (
      !isRecord(rawProject) ||
      !exactKeys(rawProject, [
        "project_id",
        "display_name",
        "active",
        "active_accountant_ref",
        "active_accountant_display_name",
        "has_active_accountant",
        "can_record_for_project",
        "can_reconcile_for_project",
      ])
    ) {
      return null;
    }
    const projectId = projectIdStr(rawProject.project_id);
    const displayName = nonEmptyStr(rawProject.display_name);
    const active = boolVal(rawProject.active);
    const activeAccountantRef = nullableUuidStr(rawProject.active_accountant_ref);
    const activeAccountantName = nullableStr(rawProject.active_accountant_display_name);
    const hasActiveAccountant = boolVal(rawProject.has_active_accountant);
    const canRecordForProject = boolVal(rawProject.can_record_for_project);
    const canReconcileForProject = boolVal(rawProject.can_reconcile_for_project);

    if (
      projectId === null ||
      displayName === null ||
      active === null ||
      activeAccountantRef === undefined ||
      activeAccountantName === undefined ||
      hasActiveAccountant === null ||
      canRecordForProject === null ||
      canReconcileForProject === null
    ) {
      return null;
    }

    projects.push({
      project_id: projectId,
      display_name: displayName,
      active,
      active_accountant_ref: activeAccountantRef,
      active_accountant_display_name: activeAccountantName,
      has_active_accountant: hasActiveAccountant,
      can_record_for_project: canRecordForProject,
      can_reconcile_for_project: canReconcileForProject,
    });
  }

  const vendors: VendorFinanceContextVendorOption[] = [];
  for (const rawVendor of data.vendors) {
    if (!isRecord(rawVendor) || !exactKeys(rawVendor, ["vendor_id", "display_name", "active"])) return null;
    const vendorId = isCanonicalUiVendorId(rawVendor.vendor_id) ? rawVendor.vendor_id : null;
    const displayName = nonEmptyStr(rawVendor.display_name);
    const active = boolVal(rawVendor.active);
    if (vendorId === null || displayName === null || active === null) return null;
    vendors.push({ vendor_id: vendorId, display_name: displayName, active });
  }

  const accountants: VendorFinanceContextAccountantOption[] = [];
  for (const rawAccountant of data.accountants) {
    if (!isRecord(rawAccountant) || !exactKeys(rawAccountant, ["accountant_ref", "display_name"])) {
      return null;
    }
    const accountantRef = uuidStr(rawAccountant.accountant_ref);
    const displayName = nonEmptyStr(rawAccountant.display_name);
    if (accountantRef === null || displayName === null) {
      return null;
    }
    accountants.push({
      accountant_ref: accountantRef,
      display_name: displayName,
    });
  }

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visibilityScope,
      record_scope: recordScope,
      reconcile_scope: reconcileScope,
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      can_manage_project_assignments: canManage,
      can_view_shared_advance: canViewShared,
      can_fund_vendor_advance: canFund,
      can_record_vendor_refund: canRefund,
      can_apply_vendor_advance: canApply,
    },
    has_legacy_unallocated: hasLegacy,
    projects,
    vendors,
    accountants,
  };
}

export function parseEntryProjection(value: unknown): VendorFinanceEntryProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "entry_id",
      "vendor_id",
      "vendor_display_name_snapshot",
      "vendor_active",
      "ledger_scope",
      "project_id",
      "project_display_name_snapshot",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "vendor_sequence",
      "cursor_sequence",
      "document_no",
      "document_kind",
      "document_title_vi",
      "entry_type",
      "amount_minor",
      "balance_before_minor",
      "balance_delta_minor",
      "balance_after_minor",
      "effective_date",
      "reason",
      "opening_batch_id",
      "reverses_entry_id",
      "reverses_document_no",
      "reversed_by_entry_id",
      "reversed_by_document_no",
      "can_reverse",
      "can_attach_evidence",
      "evidence",
      "created_by_display_name",
      "created_at",
      "internal_disclaimer",
    ])
  ) {
    return null;
  }
  const entryId = uuidStr(value.entry_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const vendorDisplayNameSnapshot = nonEmptyStr(value.vendor_display_name_snapshot);
  const vendorActive = boolVal(value.vendor_active);
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId = nullableProjectIdStr(value.project_id);
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantDisplayName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const vendorSequence = posInt(value.vendor_sequence);
  const cursorSequence = posInt(value.cursor_sequence);
  const documentNo =
    typeof value.document_no === "string" && DOCUMENT_NO_REGEX.test(value.document_no)
      ? value.document_no
      : null;
  const documentKind =
    typeof value.document_kind === "string" &&
    (VFIN_UI_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const entryType =
    typeof value.entry_type === "string" &&
    (VFIN_UI_ENTRY_TYPES as readonly string[]).includes(value.entry_type)
      ? (value.entry_type as VendorFinanceEntryType)
      : null;
  const amountMinor = positiveMoneyStr(value.amount_minor);
  const balanceBeforeMinor = signedMoneyStr(value.balance_before_minor);
  const balanceDeltaMinor = signedMoneyStr(value.balance_delta_minor);
  const balanceAfterMinor = signedMoneyStr(value.balance_after_minor);
  const effectiveDate = dateStr(value.effective_date);
  const reason = nonEmptyStr(value.reason);
  const openingBatchId = nullableUuidStr(value.opening_batch_id);
  const reversesEntryId = nullableUuidStr(value.reverses_entry_id);
  const reversesDocNo = nullableStr(value.reverses_document_no);
  const reversedByEntryId = nullableUuidStr(value.reversed_by_entry_id);
  const reversedByDocNo = nullableStr(value.reversed_by_document_no);
  const canReverse = boolVal(value.can_reverse);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : parseEvidenceSummaryProjection(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);
  const disclaimer =
    value.internal_disclaimer === VFIN_UI_INTERNAL_DISCLAIMER_VI
      ? VFIN_UI_INTERNAL_DISCLAIMER_VI
      : null;

  if (
    entryId === null ||
    vendorId === null ||
    vendorDisplayNameSnapshot === null ||
    vendorActive === null ||
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayNameSnapshot === undefined ||
    accountantRef === undefined ||
    responsibleAccountantDisplayName === undefined ||
    contractType === null ||
    vendorSequence === null ||
    cursorSequence === null ||
    documentNo === null ||
    documentKind === null ||
    documentTitleVi === null ||
    entryType === null ||
    amountMinor === null ||
    balanceBeforeMinor === null ||
    balanceDeltaMinor === null ||
    balanceAfterMinor === null ||
    effectiveDate === null ||
    reason === null ||
    openingBatchId === undefined ||
    reversesEntryId === undefined ||
    reversesDocNo === undefined ||
    reversedByEntryId === undefined ||
    reversedByDocNo === undefined ||
    canReverse === null ||
    canAttachEvidence === null ||
    (value.evidence !== null && evidence === null) ||
    createdByDisplayName === null ||
    createdAt === null ||
    disclaimer === null
  ) {
    return null;
  }

  if (
    ledgerScope === "PROJECT_ACCOUNTANT" &&
    (projectId === null ||
      projectDisplayNameSnapshot === null ||
      accountantRef === null ||
      responsibleAccountantDisplayName === null)
  ) {
    return null;
  }
  if (
    ledgerScope === "LEGACY_UNALLOCATED" &&
    (projectId !== null || accountantRef !== null || contractType !== "UNCLASSIFIED")
  ) {
    return null;
  }

  if (BigInt(balanceBeforeMinor) + BigInt(balanceDeltaMinor) !== BigInt(balanceAfterMinor)) {
    return null;
  }

  return {
    entry_id: entryId,
    vendor_id: vendorId,
    vendor_display_name_snapshot: vendorDisplayNameSnapshot,
    vendor_active: vendorActive,
    ledger_scope: ledgerScope,
    project_id: projectId,
    project_display_name_snapshot: projectDisplayNameSnapshot,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleAccountantDisplayName,
    contract_type: contractType,
    vendor_sequence: vendorSequence,
    cursor_sequence: cursorSequence,
    document_no: documentNo,
    document_kind: documentKind,
    document_title_vi: documentTitleVi,
    entry_type: entryType,
    amount_minor: amountMinor,
    balance_before_minor: balanceBeforeMinor,
    balance_delta_minor: balanceDeltaMinor,
    balance_after_minor: balanceAfterMinor,
    effective_date: effectiveDate,
    reason,
    opening_batch_id: openingBatchId,
    reverses_entry_id: reversesEntryId,
    reverses_document_no: reversesDocNo,
    reversed_by_entry_id: reversedByEntryId,
    reversed_by_document_no: reversedByDocNo,
    can_reverse: canReverse,
    can_attach_evidence: canAttachEvidence,
    evidence,
    created_by_display_name: createdByDisplayName,
    created_at: createdAt,
    internal_disclaimer: disclaimer,
  };
}

export function parseReconciliationProjection(
  value: unknown,
): VendorFinanceReconciliationProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "reconciliation_id",
      "vendor_id",
      "ledger_scope",
      "project_id",
      "project_display_name_snapshot",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "as_of_date",
      "system_balance_minor",
      "confirmed_balance_minor",
      "difference_minor",
      "ledger_sequence_at_reconciliation",
      "reason",
      "can_attach_evidence",
      "evidence",
      "created_by_display_name",
      "created_at",
    ])
  ) {
    return null;
  }
  const reconciliationId = uuidStr(value.reconciliation_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId = nullableProjectIdStr(value.project_id);
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantDisplayName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const asOfDate = dateStr(value.as_of_date);
  const systemBalanceMinor = signedMoneyStr(value.system_balance_minor);
  const confirmedBalanceMinor = signedMoneyStr(value.confirmed_balance_minor);
  const differenceMinor = signedMoneyStr(value.difference_minor);
  const ledgerSeq = nonNegInt(value.ledger_sequence_at_reconciliation);
  const reason = nonEmptyStr(value.reason);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : parseEvidenceSummaryProjection(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);

  if (
    reconciliationId === null ||
    vendorId === null ||
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayNameSnapshot === undefined ||
    accountantRef === undefined ||
    responsibleAccountantDisplayName === undefined ||
    contractType === null ||
    asOfDate === null ||
    systemBalanceMinor === null ||
    confirmedBalanceMinor === null ||
    differenceMinor === null ||
    ledgerSeq === null ||
    reason === null ||
    canAttachEvidence === null ||
    (value.evidence !== null && evidence === null) ||
    createdByDisplayName === null ||
    createdAt === null
  ) {
    return null;
  }

  if (
    ledgerScope === "PROJECT_ACCOUNTANT" &&
    (projectId === null ||
      projectDisplayNameSnapshot === null ||
      accountantRef === null ||
      responsibleAccountantDisplayName === null)
  ) {
    return null;
  }
  if (
    ledgerScope === "LEGACY_UNALLOCATED" &&
    (projectId !== null || accountantRef !== null || contractType !== "UNCLASSIFIED")
  ) {
    return null;
  }

  if (BigInt(confirmedBalanceMinor) - BigInt(systemBalanceMinor) !== BigInt(differenceMinor)) {
    return null;
  }

  return {
    reconciliation_id: reconciliationId,
    vendor_id: vendorId,
    ledger_scope: ledgerScope,
    project_id: projectId,
    project_display_name_snapshot: projectDisplayNameSnapshot,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleAccountantDisplayName,
    contract_type: contractType,
    as_of_date: asOfDate,
    system_balance_minor: systemBalanceMinor,
    confirmed_balance_minor: confirmedBalanceMinor,
    difference_minor: differenceMinor,
    ledger_sequence_at_reconciliation: ledgerSeq,
    reason,
    can_attach_evidence: canAttachEvidence,
    evidence,
    created_by_display_name: createdByDisplayName,
    created_at: createdAt,
  };
}

function parseListSubLedgerItem(value: unknown): VendorFinanceListSubLedgerItem | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "ledger_scope",
      "project_id",
      "project_display_name",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "current_balance_minor",
      "balance_direction",
      "entry_count",
      "has_opening_entry",
      "eligible_for_opening",
      "last_reconciled_as_of_date",
    ])
  ) {
    return null;
  }
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId = nullableProjectIdStr(value.project_id);
  const projectDisplayName = nullableStr(value.project_display_name);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const currentBalance = signedMoneyStr(value.current_balance_minor);
  const direction = balanceDirectionVal(value.balance_direction);
  const entryCount = nonNegInt(value.entry_count);
  const hasOpening = boolVal(value.has_opening_entry);
  const eligible = boolVal(value.eligible_for_opening);
  const lastReconciled = nullableDateStr(value.last_reconciled_as_of_date);

  if (
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayName === undefined ||
    accountantRef === undefined ||
    responsibleName === undefined ||
    contractType === null ||
    currentBalance === null ||
    direction === null ||
    entryCount === null ||
    hasOpening === null ||
    eligible === null ||
    lastReconciled === undefined
  ) {
    return null;
  }

  return {
    ledger_scope: ledgerScope,
    project_id: projectId,
    project_display_name: projectDisplayName,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleName,
    contract_type: contractType,
    current_balance_minor: currentBalance,
    balance_direction: direction,
    entry_count: entryCount,
    has_opening_entry: hasOpening,
    eligible_for_opening: eligible,
    last_reconciled_as_of_date: lastReconciled,
  };
}

export function parseVendorListEnvelope(envelope: unknown): VendorFinanceVendorListResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "allowed_actions",
      "summary",
      "filters",
      "page",
      "page_size",
      "total",
      "has_more",
      "vendors",
    ]) ||
    !isRecord(data.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      data.allowed_actions,
      [
        "visibility_scope",
        "can_view",
        "can_record",
        "can_reconcile",
        "can_manage_project_assignments",
        "active_assigned_project_count",
      ],
      [
        "can_view_shared_advance",
        "can_fund_vendor_advance",
        "can_record_vendor_refund",
        "can_apply_vendor_advance",
      ],
    ) ||
    !isRecord(data.summary) ||
    !requiredAndOptionalKeysOnly(
      data.summary,
      [
        "total_payable_minor",
        "total_advance_minor",
        "net_balance_minor",
        "vendors_with_payable_count",
        "vendors_with_advance_count",
        "vendors_with_nonzero_balance_count",
        "total_vendor_count",
        "uninitialized_vendor_count",
        "sub_ledger_count",
      ],
      ["total_shared_advance_minor"],
    ) ||
    !isRecord(data.filters) ||
    !exactKeys(data.filters, [
      "search",
      "active",
      "balance_filter",
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
    ]) ||
    !Array.isArray(data.vendors)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const visibilityScope = visibilityScopeVal(data.allowed_actions.visibility_scope);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const canReconcile = boolVal(data.allowed_actions.can_reconcile);
  const canManage = boolVal(data.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_fund_vendor_advance)
      : visibilityScope === "ALL" && Boolean(canRecord);
  const canRefund =
    "can_record_vendor_refund" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_record_vendor_refund)
      : visibilityScope === "ALL" && Boolean(canRecord);
  const canApply =
    "can_apply_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const activeAssignedCount = nonNegInt(data.allowed_actions.active_assigned_project_count);

  const totalPayable = nonNegativeMoneyStr(data.summary.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(data.summary.total_advance_minor);
  const totalSharedAdvance =
    "total_shared_advance_minor" in data.summary
      ? nonNegativeMoneyStr(data.summary.total_shared_advance_minor)
      : "0";
  const netBalance = signedMoneyStr(data.summary.net_balance_minor);
  const payableCount = nonNegInt(data.summary.vendors_with_payable_count);
  const advanceCount = nonNegInt(data.summary.vendors_with_advance_count);
  const nonzeroCount = nonNegInt(data.summary.vendors_with_nonzero_balance_count);
  const totalVendorCount = nonNegInt(data.summary.total_vendor_count);
  const uninitializedCount = nonNegInt(data.summary.uninitialized_vendor_count);
  const subLedgerCount = nonNegInt(data.summary.sub_ledger_count);

  const search = nullableStr(data.filters.search);
  const active = data.filters.active;
  const balanceFilter = data.filters.balance_filter;
  const filterProjectId = nullableProjectIdStr(data.filters.project_id);
  const filterAccountantRef = nullableUuidStr(data.filters.accountant_ref);
  const filterLedgerScope = data.filters.ledger_scope;
  const filterContractType = data.filters.contract_type;
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);

  if (
    authorizationDate === null ||
    visibilityScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    activeAssignedCount === null ||
    totalPayable === null ||
    totalAdvance === null ||
    totalSharedAdvance === null ||
    netBalance === null ||
    payableCount === null ||
    advanceCount === null ||
    nonzeroCount === null ||
    totalVendorCount === null ||
    uninitializedCount === null ||
    subLedgerCount === null ||
    search === undefined ||
    (active !== "all" && active !== "active" && active !== "inactive") ||
    (balanceFilter !== "all" &&
      balanceFilter !== "payable" &&
      balanceFilter !== "advance" &&
      balanceFilter !== "nonzero" &&
      balanceFilter !== "uninitialized") ||
    filterProjectId === undefined ||
    filterAccountantRef === undefined ||
    (filterLedgerScope !== "all" &&
      filterLedgerScope !== "PROJECT_ACCOUNTANT" &&
      filterLedgerScope !== "LEGACY_UNALLOCATED") ||
    (filterContractType !== "all" &&
      filterContractType !== "SEASONAL" &&
      filterContractType !== "OFFICIAL" &&
      filterContractType !== "UNCLASSIFIED") ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }

  const vendors: VendorFinanceListItem[] = [];
  for (const item of data.vendors) {
    if (
      !isRecord(item) ||
      !requiredAndOptionalKeysOnly(
        item,
        [
          "vendor_id",
          "display_name",
          "active",
          "sub_ledger_count",
          "payable_total_minor",
          "advance_total_minor",
          "current_balance_minor",
          "balance_direction",
          "entry_count",
          "has_opening_entry",
          "eligible_for_opening",
          "last_effective_date",
          "last_entry_at",
          "last_reconciled_as_of_date",
          "sub_ledgers",
        ],
        ["shared_advance_balance_minor"],
      ) ||
      !Array.isArray(item.sub_ledgers)
    ) {
      return null;
    }
    const vendorId = isCanonicalUiVendorId(item.vendor_id) ? item.vendor_id : null;
    const displayName = nonEmptyStr(item.display_name);
    const itemActive = boolVal(item.active);
    const itemSubLedgerCount = nonNegInt(item.sub_ledger_count);
    const payableTotal = nonNegativeMoneyStr(item.payable_total_minor);
    const advanceTotal = nonNegativeMoneyStr(item.advance_total_minor);
    const sharedAdvanceBalance =
      "shared_advance_balance_minor" in item
        ? nonNegativeMoneyStr(item.shared_advance_balance_minor)
        : "0";
    const currentBalance = signedMoneyStr(item.current_balance_minor);
    const direction = listBalanceDirectionVal(item.balance_direction);
    const entryCount = nonNegInt(item.entry_count);
    const hasOpening = boolVal(item.has_opening_entry);
    const eligible = boolVal(item.eligible_for_opening);
    const lastEffectiveDate = nullableDateStr(item.last_effective_date);
    const lastEntryAt = nullableStr(item.last_entry_at);
    const lastReconciled = nullableDateStr(item.last_reconciled_as_of_date);

    if (
      vendorId === null ||
      displayName === null ||
      itemActive === null ||
      itemSubLedgerCount === null ||
      payableTotal === null ||
      advanceTotal === null ||
      sharedAdvanceBalance === null ||
      currentBalance === null ||
      direction === null ||
      entryCount === null ||
      hasOpening === null ||
      eligible === null ||
      lastEffectiveDate === undefined ||
      lastEntryAt === undefined ||
      lastReconciled === undefined
    ) {
      return null;
    }

    const subLedgers: VendorFinanceListSubLedgerItem[] = [];
    for (const rawSub of item.sub_ledgers) {
      const parsedSub = parseListSubLedgerItem(rawSub);
      if (!parsedSub) return null;
      subLedgers.push(parsedSub);
    }

    vendors.push({
      vendor_id: vendorId,
      display_name: displayName,
      active: itemActive,
      sub_ledger_count: itemSubLedgerCount,
      payable_total_minor: payableTotal,
      advance_total_minor: advanceTotal,
      shared_advance_balance_minor: sharedAdvanceBalance,
      current_balance_minor: currentBalance,
      balance_direction: direction,
      entry_count: entryCount,
      has_opening_entry: hasOpening,
      eligible_for_opening: eligible,
      last_effective_date: lastEffectiveDate,
      last_entry_at: lastEntryAt,
      last_reconciled_as_of_date: lastReconciled,
      sub_ledgers: subLedgers,
    });
  }

  const summary: VendorFinanceCompanySummary = {
    total_payable_minor: totalPayable,
    total_advance_minor: totalAdvance,
    total_shared_advance_minor: totalSharedAdvance,
    net_balance_minor: netBalance,
    vendors_with_payable_count: payableCount,
    vendors_with_advance_count: advanceCount,
    vendors_with_nonzero_balance_count: nonzeroCount,
    total_vendor_count: totalVendorCount,
    uninitialized_vendor_count: uninitializedCount,
    sub_ledger_count: subLedgerCount,
  };

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visibilityScope,
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      can_manage_project_assignments: canManage,
      can_view_shared_advance: canViewShared,
      can_fund_vendor_advance: canFund,
      can_record_vendor_refund: canRefund,
      can_apply_vendor_advance: canApply,
      active_assigned_project_count: activeAssignedCount,
    },
    summary,
    filters: {
      search,
      active,
      balance_filter: balanceFilter,
      project_id: filterProjectId,
      accountant_ref: filterAccountantRef,
      ledger_scope: filterLedgerScope,
      contract_type: filterContractType,
    },
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    vendors,
  };
}

function parseDetailSubLedgerProjection(value: unknown): VendorFinanceDetailSubLedger | null {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeysOnly(
      value,
      [
        "ledger_scope",
        "project_id",
        "project_display_name",
        "project_active",
        "accountant_ref",
        "responsible_accountant_display_name",
        "contract_type",
        "is_active_assignment",
        "current_balance_minor",
        "balance_direction",
        "latest_sequence",
        "entry_count",
        "has_opening_entry",
        "eligible_for_opening",
        "can_record_entry",
        "can_reconcile",
        "can_classify_contract_type",
        "classification",
      ],
      ["can_apply_vendor_advance"],
    )
  ) {
    return null;
  }
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId = nullableProjectIdStr(value.project_id);
  const projectDisplayName = nullableStr(value.project_display_name);
  const projectActive = nullableBoolVal(value.project_active);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const isActiveAssignment = boolVal(value.is_active_assignment);
  const currentBalance = signedMoneyStr(value.current_balance_minor);
  const direction = balanceDirectionVal(value.balance_direction);
  const latestSeq = nonNegInt(value.latest_sequence);
  const entryCount = nonNegInt(value.entry_count);
  const hasOpening = boolVal(value.has_opening_entry);
  const eligible = boolVal(value.eligible_for_opening);
  const canRecordEntry = boolVal(value.can_record_entry);
  const canReconcile = boolVal(value.can_reconcile);
  const canClassify = boolVal(value.can_classify_contract_type);
  const canApplyVendorAdvance =
    "can_apply_vendor_advance" in value
      ? boolVal(value.can_apply_vendor_advance)
      : Boolean(canRecordEntry) &&
        ledgerScope === "PROJECT_ACCOUNTANT" &&
        (contractType === "SEASONAL" || contractType === "OFFICIAL") &&
        direction === "PAYABLE";
  const classification =
    value.classification === null
      ? null
      : parseSubLedgerClassificationProjection(value.classification);

  if (
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayName === undefined ||
    projectActive === undefined ||
    accountantRef === undefined ||
    responsibleName === undefined ||
    contractType === null ||
    isActiveAssignment === null ||
    currentBalance === null ||
    direction === null ||
    latestSeq === null ||
    entryCount === null ||
    hasOpening === null ||
    eligible === null ||
    canRecordEntry === null ||
    canReconcile === null ||
    canClassify === null ||
    canApplyVendorAdvance === null ||
    (value.classification !== null && classification === null)
  ) {
    return null;
  }

  return {
    ledger_scope: ledgerScope,
    project_id: projectId,
    project_display_name: projectDisplayName,
    project_active: projectActive,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleName,
    contract_type: contractType,
    is_active_assignment: isActiveAssignment,
    current_balance_minor: currentBalance,
    balance_direction: direction,
    latest_sequence: latestSeq,
    entry_count: entryCount,
    has_opening_entry: hasOpening,
    eligible_for_opening: eligible,
    can_record_entry: canRecordEntry,
    can_reconcile: canReconcile,
    can_classify_contract_type: canClassify,
    can_apply_vendor_advance: canApplyVendorAdvance,
    classification,
  };
}

export function parseVendorDetailEnvelope(
  envelope: unknown,
): VendorFinanceVendorDetailResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "allowed_actions",
      "selected_sub_ledger",
      "sub_ledgers",
      "vendor",
    ]) ||
    !isRecord(data.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      data.allowed_actions,
      [
        "visibility_scope",
        "can_view",
        "can_record",
        "can_reconcile",
        "can_manage_project_assignments",
        "allowed_entry_types",
      ],
      [
        "can_view_shared_advance",
        "can_fund_vendor_advance",
        "can_record_vendor_refund",
        "can_apply_vendor_advance",
      ],
    ) ||
    !Array.isArray(data.allowed_actions.allowed_entry_types) ||
    !Array.isArray(data.sub_ledgers) ||
    !isRecord(data.vendor) ||
    !requiredAndOptionalKeysOnly(
      data.vendor,
      [
        "vendor_id",
        "display_name",
        "active",
        "current_balance_minor",
        "balance_direction",
        "latest_sequence",
        "entry_count",
        "has_opening_entry",
        "eligible_for_opening",
        "totals",
        "latest_reconciliation",
        "recent_reconciliations",
      ],
      [
        "shared_advance_balance_minor",
        "shared_advance_latest_sequence",
        "shared_advance_movement_count",
      ],
    ) ||
    !isRecord(data.vendor.totals) ||
    !requiredAndOptionalKeysOnly(
      data.vendor.totals,
      [
        "opening_payable_minor",
        "opening_advance_minor",
        "debt_recorded_minor",
        "payroll_recorded_minor",
        "payment_recorded_minor",
        "advance_recorded_minor",
        "adjustment_increase_minor",
        "adjustment_decrease_minor",
        "reversed_entry_count",
      ],
      ["advance_offset_recorded_minor"],
    ) ||
    !Array.isArray(data.vendor.recent_reconciliations)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const visibilityScope = visibilityScopeVal(data.allowed_actions.visibility_scope);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const canReconcile = boolVal(data.allowed_actions.can_reconcile);
  const canManage = boolVal(data.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_fund_vendor_advance)
      : visibilityScope === "ALL" && Boolean(canRecord);
  const canRefund =
    "can_record_vendor_refund" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_record_vendor_refund)
      : visibilityScope === "ALL" && Boolean(canRecord);
  const canApply =
    "can_apply_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const allowedEntryTypes: NormalVendorFinanceEntryType[] = [];
  for (const rawType of data.allowed_actions.allowed_entry_types) {
    if (
      typeof rawType !== "string" ||
      !(VFIN_UI_NORMAL_ENTRY_TYPES as readonly string[]).includes(rawType)
    ) {
      return null;
    }
    allowedEntryTypes.push(rawType as NormalVendorFinanceEntryType);
  }

  const selectedSubLedger =
    data.selected_sub_ledger === null
      ? null
      : parseDetailSubLedgerProjection(data.selected_sub_ledger);
  if (data.selected_sub_ledger !== null && selectedSubLedger === null) {
    return null;
  }

  const subLedgers: VendorFinanceDetailSubLedger[] = [];
  for (const rawSub of data.sub_ledgers) {
    const parsedSub = parseDetailSubLedgerProjection(rawSub);
    if (!parsedSub) return null;
    subLedgers.push(parsedSub);
  }

  const v = data.vendor;
  const vendorId = isCanonicalUiVendorId(v.vendor_id) ? v.vendor_id : null;
  const displayName = nonEmptyStr(v.display_name);
  const active = boolVal(v.active);
  const sharedBalance =
    "shared_advance_balance_minor" in v
      ? nonNegativeMoneyStr(v.shared_advance_balance_minor)
      : "0";
  const sharedLatestSeq =
    "shared_advance_latest_sequence" in v
      ? nonNegInt(v.shared_advance_latest_sequence)
      : 0;
  const sharedMovementCount =
    "shared_advance_movement_count" in v
      ? nonNegInt(v.shared_advance_movement_count)
      : 0;
  const currentBalance = signedMoneyStr(v.current_balance_minor);
  const direction = listBalanceDirectionVal(v.balance_direction);
  const latestSeq = nonNegInt(v.latest_sequence);
  const entryCount = nonNegInt(v.entry_count);
  const hasOpening = boolVal(v.has_opening_entry);
  const eligible = boolVal(v.eligible_for_opening);

  const t = v.totals as Record<string, unknown>;
  const openingPayable = nonNegativeMoneyStr(t.opening_payable_minor);
  const openingAdvance = nonNegativeMoneyStr(t.opening_advance_minor);
  const debtRecorded = nonNegativeMoneyStr(t.debt_recorded_minor);
  const payrollRecorded = nonNegativeMoneyStr(t.payroll_recorded_minor);
  const paymentRecorded = nonNegativeMoneyStr(t.payment_recorded_minor);
  const advanceRecorded = nonNegativeMoneyStr(t.advance_recorded_minor);
  const advanceOffsetRecorded =
    "advance_offset_recorded_minor" in t
      ? nonNegativeMoneyStr(t.advance_offset_recorded_minor)
      : "0";
  const adjustmentInc = nonNegativeMoneyStr(t.adjustment_increase_minor);
  const adjustmentDec = nonNegativeMoneyStr(t.adjustment_decrease_minor);
  const reversedCount = nonNegInt(t.reversed_entry_count);

  const latestRec =
    v.latest_reconciliation === null
      ? null
      : parseReconciliationProjection(v.latest_reconciliation);

  const recentRecs: VendorFinanceReconciliationProjection[] = [];
  for (const item of v.recent_reconciliations as unknown[]) {
    const projected = parseReconciliationProjection(item);
    if (!projected) return null;
    recentRecs.push(projected);
  }

  if (
    authorizationDate === null ||
    visibilityScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    vendorId === null ||
    displayName === null ||
    active === null ||
    sharedBalance === null ||
    sharedLatestSeq === null ||
    sharedMovementCount === null ||
    currentBalance === null ||
    direction === null ||
    latestSeq === null ||
    entryCount === null ||
    hasOpening === null ||
    eligible === null ||
    openingPayable === null ||
    openingAdvance === null ||
    debtRecorded === null ||
    payrollRecorded === null ||
    paymentRecorded === null ||
    advanceRecorded === null ||
    advanceOffsetRecorded === null ||
    adjustmentInc === null ||
    adjustmentDec === null ||
    reversedCount === null ||
    (v.latest_reconciliation !== null && latestRec === null)
  ) {
    return null;
  }

  const totals: VendorFinanceCategoryTotals = {
    opening_payable_minor: openingPayable,
    opening_advance_minor: openingAdvance,
    debt_recorded_minor: debtRecorded,
    payroll_recorded_minor: payrollRecorded,
    payment_recorded_minor: paymentRecorded,
    advance_recorded_minor: advanceRecorded,
    advance_offset_recorded_minor: advanceOffsetRecorded,
    adjustment_increase_minor: adjustmentInc,
    adjustment_decrease_minor: adjustmentDec,
    reversed_entry_count: reversedCount,
  };

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visibilityScope,
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      can_manage_project_assignments: canManage,
      can_view_shared_advance: canViewShared,
      can_fund_vendor_advance: canFund,
      can_record_vendor_refund: canRefund,
      can_apply_vendor_advance: canApply,
      allowed_entry_types: allowedEntryTypes,
    },
    selected_sub_ledger: selectedSubLedger,
    sub_ledgers: subLedgers,
    vendor: {
      vendor_id: vendorId,
      display_name: displayName,
      active,
      shared_advance_balance_minor: sharedBalance,
      shared_advance_latest_sequence: sharedLatestSeq,
      shared_advance_movement_count: sharedMovementCount,
      current_balance_minor: currentBalance,
      balance_direction: direction,
      latest_sequence: latestSeq,
      entry_count: entryCount,
      has_opening_entry: hasOpening,
      eligible_for_opening: eligible,
      totals,
      latest_reconciliation: latestRec,
      recent_reconciliations: recentRecs,
    },
  };
}

export function parseVendorEntriesPageEnvelope(
  envelope: unknown,
): VendorFinanceEntriesPageResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "vendor_id",
      "page_size",
      "has_more",
      "next_cursor",
      "entries",
    ]) ||
    !Array.isArray(data.entries)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const vendorId = isCanonicalUiVendorId(data.vendor_id) ? data.vendor_id : null;
  const pageSize = posInt(data.page_size);
  const hasMore = boolVal(data.has_more);
  const nextCursor =
    data.next_cursor === null
      ? null
      : typeof data.next_cursor === "string" && CURSOR_TOKEN_REGEX.test(data.next_cursor)
        ? data.next_cursor
        : undefined;

  if (
    authorizationDate === null ||
    vendorId === null ||
    pageSize === null ||
    hasMore === null ||
    nextCursor === undefined ||
    (hasMore && nextCursor === null) ||
    (!hasMore && nextCursor !== null)
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of data.entries) {
    const projected = parseEntryProjection(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    entries.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor: nextCursor,
    entries,
  };
}

export function parseSingleEntryEnvelope(
  envelope: unknown,
): VendorFinanceSingleEntryResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["authorization_date", "allowed_actions", "entry"]) ||
    !isRecord(data.allowed_actions) ||
    !exactKeys(data.allowed_actions, ["visibility_scope", "can_view", "can_record"])
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const visibilityScope = visibilityScopeVal(data.allowed_actions.visibility_scope);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const entry = parseEntryProjection(data.entry);
  if (
    authorizationDate === null ||
    visibilityScope === null ||
    canView !== true ||
    canRecord === null ||
    entry === null
  ) {
    return null;
  }
  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visibilityScope,
      can_view: true,
      can_record: canRecord,
    },
    entry,
  };
}

export function parseRecordEntryEnvelope(
  envelope: unknown,
): { entry: VendorFinanceEntryProjection; replayed: boolean } | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["entry", "replayed"])) return null;
  const entry = parseEntryProjection(data.entry);
  const replayed = boolVal(data.replayed);
  if (!entry || replayed === null) return null;
  return { entry, replayed };
}

export function parseReverseEntryEnvelope(
  envelope: unknown,
): {
  reversal_entry: VendorFinanceEntryProjection;
  reversed_entry: VendorFinanceEntryProjection;
  reversal_movement?: VendorFinanceSharedAdvanceMovementProjection;
  reversed_movement?: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor?: string;
  replayed: boolean;
} | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !requiredAndOptionalKeysOnly(
      data,
      ["reversal_entry", "reversed_entry", "replayed"],
      ["reversal_movement", "reversed_movement", "shared_advance_balance_minor"],
    )
  ) {
    return null;
  }
  const reversal = parseEntryProjection(data.reversal_entry);
  const reversed = parseEntryProjection(data.reversed_entry);
  const replayed = boolVal(data.replayed);
  if (!reversal || !reversed || replayed === null) return null;

  const hasMovFields =
    "reversal_movement" in data ||
    "reversed_movement" in data ||
    "shared_advance_balance_minor" in data;
  if (hasMovFields) {
    const revMov = parseSharedAdvanceMovementProjection(data.reversal_movement);
    const origMov = parseSharedAdvanceMovementProjection(data.reversed_movement);
    const sharedBalance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
    if (!revMov || !origMov || sharedBalance === null) return null;
    return {
      reversal_entry: reversal,
      reversed_entry: reversed,
      reversal_movement: revMov,
      reversed_movement: origMov,
      shared_advance_balance_minor: sharedBalance,
      replayed,
    };
  }

  return { reversal_entry: reversal, reversed_entry: reversed, replayed };
}

export function parseSharedAdvanceMovementProjection(
  value: unknown,
): VendorFinanceSharedAdvanceMovementProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "movement_id",
      "vendor_id",
      "vendor_display_name_snapshot",
      "vendor_active",
      "vendor_advance_sequence",
      "cursor_sequence",
      "document_no",
      "document_kind",
      "document_title_vi",
      "movement_type",
      "amount_minor",
      "balance_before_minor",
      "balance_delta_minor",
      "balance_after_minor",
      "effective_date",
      "reason",
      "project_entry_id",
      "project_id",
      "project_display_name_snapshot",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "reverses_movement_id",
      "reverses_document_no",
      "reversed_by_movement_id",
      "reversed_by_document_no",
      "can_reverse",
      "can_attach_evidence",
      "evidence",
      "created_by_display_name",
      "created_at",
      "internal_disclaimer",
    ])
  ) {
    return null;
  }

  const movementId = uuidStr(value.movement_id);
  const vendorId = isCanonicalUiVendorId(value.vendor_id) ? value.vendor_id : null;
  const vendorDisplayNameSnapshot = nonEmptyStr(value.vendor_display_name_snapshot);
  const vendorActive = boolVal(value.vendor_active);
  const vendorAdvanceSequence = posInt(value.vendor_advance_sequence);
  const cursorSequence = posInt(value.cursor_sequence);
  const documentNo =
    typeof value.document_no === "string" && DOCUMENT_NO_REGEX.test(value.document_no)
      ? value.document_no
      : null;
  const documentKind =
    typeof value.document_kind === "string" &&
    (VFIN_UI_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const movementType =
    typeof value.movement_type === "string" &&
    (VFIN_UI_SHARED_ADVANCE_MOVEMENT_TYPES as readonly string[]).includes(value.movement_type)
      ? (value.movement_type as VendorFinanceSharedAdvanceMovementType)
      : null;
  const amountMinor = positiveMoneyStr(value.amount_minor);
  const balanceBeforeMinor = nonNegativeMoneyStr(value.balance_before_minor);
  const balanceDeltaMinor = signedMoneyStr(value.balance_delta_minor);
  const balanceAfterMinor = nonNegativeMoneyStr(value.balance_after_minor);
  const effectiveDate = dateStr(value.effective_date);
  const reason = nullableStr(value.reason);
  const projectEntryId = nullableUuidStr(value.project_entry_id);
  const projectId = nullableProjectIdStr(value.project_id);
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantName = nullableStr(value.responsible_accountant_display_name);
  const contractType =
    value.contract_type === null
      ? null
      : (classifiedContractTypeVal(value.contract_type) ?? undefined);
  const reversesMovementId = nullableUuidStr(value.reverses_movement_id);
  const reversesDocNo = nullableStr(value.reverses_document_no);
  const reversedByMovementId = nullableUuidStr(value.reversed_by_movement_id);
  const reversedByDocNo = nullableStr(value.reversed_by_document_no);
  const canReverse = boolVal(value.can_reverse);
  const canAttachEvidence = value.can_attach_evidence === false ? false : null;
  const evidence = value.evidence === null ? null : undefined;
  const createdByDisplayName = nullableStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);
  const disclaimer =
    value.internal_disclaimer === VFIN_UI_INTERNAL_DISCLAIMER_VI
      ? VFIN_UI_INTERNAL_DISCLAIMER_VI
      : null;

  if (
    movementId === null ||
    vendorId === null ||
    vendorDisplayNameSnapshot === null ||
    vendorActive === null ||
    vendorAdvanceSequence === null ||
    cursorSequence === null ||
    documentNo === null ||
    documentKind === null ||
    documentTitleVi === null ||
    movementType === null ||
    amountMinor === null ||
    balanceBeforeMinor === null ||
    balanceDeltaMinor === null ||
    balanceAfterMinor === null ||
    effectiveDate === null ||
    reason === undefined ||
    projectEntryId === undefined ||
    projectId === undefined ||
    projectDisplayNameSnapshot === undefined ||
    accountantRef === undefined ||
    responsibleAccountantName === undefined ||
    contractType === undefined ||
    reversesMovementId === undefined ||
    reversesDocNo === undefined ||
    reversedByMovementId === undefined ||
    reversedByDocNo === undefined ||
    canReverse === null ||
    canAttachEvidence !== false ||
    evidence !== null ||
    createdByDisplayName === undefined ||
    (reason === null) !== (createdByDisplayName === null) ||
    createdAt === null ||
    disclaimer === null
  ) {
    return null;
  }

  if (BigInt(balanceBeforeMinor) + BigInt(balanceDeltaMinor) !== BigInt(balanceAfterMinor)) {
    return null;
  }

  const projectFields = [
    projectEntryId,
    projectId,
    projectDisplayNameSnapshot,
    accountantRef,
    responsibleAccountantName,
    contractType,
  ];
  const allProjectFieldsNonNull = projectFields.every((f) => f !== null);
  const allProjectFieldsNull = projectFields.every((f) => f === null);

  if (allProjectFieldsNonNull && (reason === null || createdByDisplayName === null)) {
    return null;
  }

  if (movementType === "PROJECT_OFFSET_APPLIED") {
    if (!allProjectFieldsNonNull && !allProjectFieldsNull) {
      return null;
    }
  } else if (
    movementType === "ADVANCE_FUNDED" ||
    movementType === "VENDOR_REFUND_RECORDED"
  ) {
    if (!allProjectFieldsNull) {
      return null;
    }
  } else if (!allProjectFieldsNonNull && !allProjectFieldsNull) {
    return null;
  }

  return {
    movement_id: movementId,
    vendor_id: vendorId,
    vendor_display_name_snapshot: vendorDisplayNameSnapshot,
    vendor_active: vendorActive,
    vendor_advance_sequence: vendorAdvanceSequence,
    cursor_sequence: cursorSequence,
    document_no: documentNo,
    document_kind: documentKind,
    document_title_vi: documentTitleVi,
    movement_type: movementType,
    amount_minor: amountMinor,
    balance_before_minor: balanceBeforeMinor,
    balance_delta_minor: balanceDeltaMinor,
    balance_after_minor: balanceAfterMinor,
    effective_date: effectiveDate,
    reason,
    project_entry_id: projectEntryId,
    project_id: projectId,
    project_display_name_snapshot: projectDisplayNameSnapshot,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleAccountantName,
    contract_type: contractType,
    reverses_movement_id: reversesMovementId,
    reverses_document_no: reversesDocNo,
    reversed_by_movement_id: reversedByMovementId,
    reversed_by_document_no: reversedByDocNo,
    can_reverse: canReverse,
    can_attach_evidence: canAttachEvidence,
    evidence,
    created_by_display_name: createdByDisplayName,
    created_at: createdAt,
    internal_disclaimer: disclaimer,
  };
}

export function parseVendorSharedAdvancesPageEnvelope(
  envelope: unknown,
): VendorFinanceSharedAdvanceMovementsPageResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "vendor_id",
      "shared_advance_balance_minor",
      "page_size",
      "has_more",
      "next_cursor",
      "movements",
    ]) ||
    !Array.isArray(data.movements)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const vendorId = isCanonicalUiVendorId(data.vendor_id) ? data.vendor_id : null;
  const sharedAdvanceBalance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
  const pageSize = posInt(data.page_size);
  const hasMore = boolVal(data.has_more);
  const nextCursor =
    data.next_cursor === null
      ? null
      : typeof data.next_cursor === "string" && CURSOR_TOKEN_REGEX.test(data.next_cursor)
        ? data.next_cursor
        : undefined;

  if (
    authorizationDate === null ||
    vendorId === null ||
    sharedAdvanceBalance === null ||
    pageSize === null ||
    hasMore === null ||
    nextCursor === undefined ||
    (hasMore && nextCursor === null) ||
    (!hasMore && nextCursor !== null)
  ) {
    return null;
  }

  const movements: VendorFinanceSharedAdvanceMovementProjection[] = [];
  for (const item of data.movements) {
    const projected = parseSharedAdvanceMovementProjection(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    movements.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    shared_advance_balance_minor: sharedAdvanceBalance,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor: nextCursor,
    movements,
  };
}

export function shouldCommitSharedAdvanceLoadMore(params: {
  requestGeneration: number;
  currentGeneration: number;
  aborted: boolean;
  canViewSharedAdvance: boolean;
  requestVendorId: string;
  currentVendorId: string;
  responseVendorId: string;
}): boolean {
  if (params.aborted) return false;
  if (!params.canViewSharedAdvance) return false;
  if (params.requestGeneration !== params.currentGeneration) return false;
  if (params.requestVendorId !== params.currentVendorId) return false;
  if (params.responseVendorId !== params.requestVendorId) return false;
  return true;
}

export function mergeUniqueSharedAdvanceMovements(
  existing: readonly VendorFinanceSharedAdvanceMovementProjection[],
  incoming: readonly VendorFinanceSharedAdvanceMovementProjection[],
): VendorFinanceSharedAdvanceMovementProjection[] {
  const existingIds = new Set(existing.map((item) => item.movement_id));
  const merged = [...existing];
  for (const item of incoming) {
    if (!existingIds.has(item.movement_id)) {
      existingIds.add(item.movement_id);
      merged.push(item);
    }
  }
  return merged;
}

export function parseFundSharedAdvanceEnvelope(
  envelope: unknown,
): VendorFinanceFundSharedAdvanceResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["movement", "shared_advance_balance_minor", "replayed"])
  ) {
    return null;
  }
  const movement = parseSharedAdvanceMovementProjection(data.movement);
  const balance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
  const replayed = boolVal(data.replayed);
  if (!movement || balance === null || replayed === null) return null;
  return { movement, shared_advance_balance_minor: balance, replayed };
}

export function parseRecordVendorRefundEnvelope(
  envelope: unknown,
): VendorFinanceRecordVendorRefundResponse | null {
  return parseFundSharedAdvanceEnvelope(envelope);
}

export function parseApplySharedAdvanceOffsetEnvelope(
  envelope: unknown,
): VendorFinanceApplySharedAdvanceOffsetResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "movement",
      "entry",
      "shared_advance_balance_minor",
      "replayed",
    ])
  ) {
    return null;
  }
  const movement = parseSharedAdvanceMovementProjection(data.movement);
  const entry = parseEntryProjection(data.entry);
  const balance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
  const replayed = boolVal(data.replayed);
  if (
    !movement ||
    !entry ||
    balance === null ||
    replayed === null ||
    movement.vendor_id !== entry.vendor_id ||
    movement.movement_type !== "PROJECT_OFFSET_APPLIED" ||
    entry.entry_type !== "ADVANCE_OFFSET_RECORDED" ||
    movement.project_entry_id !== entry.entry_id ||
    movement.amount_minor !== entry.amount_minor
  ) {
    return null;
  }
  return { movement, entry, shared_advance_balance_minor: balance, replayed };
}

export function parseRecordPaymentWithOffsetEnvelope(
  envelope: unknown,
): VendorFinanceRecordPaymentWithOffsetResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "payment_entry",
      "offset_entry",
      "movement",
      "shared_advance_balance_minor",
      "replayed",
    ])
  ) {
    return null;
  }
  const paymentEntry = parseEntryProjection(data.payment_entry);
  const offsetEntry = parseEntryProjection(data.offset_entry);
  const movement = parseSharedAdvanceMovementProjection(data.movement);
  const balance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
  const replayed = boolVal(data.replayed);
  if (
    !paymentEntry ||
    !offsetEntry ||
    !movement ||
    balance === null ||
    replayed === null ||
    paymentEntry.vendor_id !== offsetEntry.vendor_id ||
    offsetEntry.vendor_id !== movement.vendor_id ||
    paymentEntry.entry_type !== "PAYMENT_RECORDED" ||
    offsetEntry.entry_type !== "ADVANCE_OFFSET_RECORDED" ||
    movement.movement_type !== "PROJECT_OFFSET_APPLIED" ||
    movement.project_entry_id !== offsetEntry.entry_id ||
    movement.amount_minor !== offsetEntry.amount_minor ||
    paymentEntry.project_id !== offsetEntry.project_id ||
    paymentEntry.contract_type !== offsetEntry.contract_type ||
    offsetEntry.balance_before_minor !== paymentEntry.balance_after_minor
  ) {
    return null;
  }
  return {
    payment_entry: paymentEntry,
    offset_entry: offsetEntry,
    movement,
    shared_advance_balance_minor: balance,
    replayed,
  };
}

export function parseReverseSharedAdvanceMovementEnvelope(
  envelope: unknown,
): VendorFinanceReverseSharedAdvanceMovementResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !requiredAndOptionalKeysOnly(
      data,
      [
        "reversal_movement",
        "reversed_movement",
        "shared_advance_balance_minor",
        "replayed",
      ],
      ["reversal_entry", "reversed_entry"],
    )
  ) {
    return null;
  }
  const revMov = parseSharedAdvanceMovementProjection(data.reversal_movement);
  const origMov = parseSharedAdvanceMovementProjection(data.reversed_movement);
  const sharedBalance = nonNegativeMoneyStr(data.shared_advance_balance_minor);
  const replayed = boolVal(data.replayed);
  if (
    !revMov ||
    !origMov ||
    sharedBalance === null ||
    replayed === null ||
    revMov.vendor_id !== origMov.vendor_id ||
    revMov.movement_type !== "REVERSAL" ||
    revMov.reverses_movement_id !== origMov.movement_id ||
    origMov.reversed_by_movement_id !== revMov.movement_id
  ) {
    return null;
  }

  const hasEntryFields = "reversal_entry" in data || "reversed_entry" in data;
  if (hasEntryFields) {
    const revEntry = parseEntryProjection(data.reversal_entry);
    const origEntry = parseEntryProjection(data.reversed_entry);
    if (
      !revEntry ||
      !origEntry ||
      revEntry.vendor_id !== revMov.vendor_id ||
      origEntry.vendor_id !== origMov.vendor_id ||
      revEntry.entry_type !== "REVERSAL" ||
      revEntry.reverses_entry_id !== origEntry.entry_id ||
      origEntry.reversed_by_entry_id !== revEntry.entry_id
    ) {
      return null;
    }
    return {
      reversal_movement: revMov,
      reversed_movement: origMov,
      shared_advance_balance_minor: sharedBalance,
      reversal_entry: revEntry,
      reversed_entry: origEntry,
      replayed,
    };
  }

  return {
    reversal_movement: revMov,
    reversed_movement: origMov,
    shared_advance_balance_minor: sharedBalance,
    replayed,
  };
}

export function parseOpeningPreviewEnvelope(
  envelope: unknown,
): VendorFinanceOpeningPreviewResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "project_id",
      "project_display_name",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "cutoff_date",
      "vendor_count",
      "skipped_zero_count",
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "items",
    ]) ||
    !Array.isArray(data.items)
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const projectId = projectIdStr(data.project_id);
  const projectDisplayName = nonEmptyStr(data.project_display_name);
  const accountantRef = uuidStr(data.accountant_ref);
  const responsibleAccountantName = nonEmptyStr(data.responsible_accountant_display_name);
  const contractType = classifiedContractTypeVal(data.contract_type);
  const cutoffDate = dateStr(data.cutoff_date);
  const vendorCount = posInt(data.vendor_count);
  const skippedZero = nonNegInt(data.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(data.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(data.total_advance_minor);
  const netBalance = signedMoneyStr(data.net_balance_minor);
  if (
    authorizationDate === null ||
    projectId === null ||
    projectDisplayName === null ||
    accountantRef === null ||
    responsibleAccountantName === null ||
    contractType === null ||
    cutoffDate === null ||
    vendorCount === null ||
    skippedZero === null ||
    totalPayable === null ||
    totalAdvance === null ||
    netBalance === null
  ) {
    return null;
  }

  const items: VendorFinanceOpeningPreviewItem[] = [];
  for (const rawItem of data.items) {
    if (
      !isRecord(rawItem) ||
      !exactKeys(rawItem, [
        "vendor_id",
        "display_name",
        "active",
        "entry_type",
        "amount_minor",
        "balance_delta_minor",
      ])
    ) {
      return null;
    }
    const vendorId = isCanonicalUiVendorId(rawItem.vendor_id) ? rawItem.vendor_id : null;
    const displayName = nonEmptyStr(rawItem.display_name);
    const active = boolVal(rawItem.active);
    const entryType =
      rawItem.entry_type === "OPENING_PAYABLE" || rawItem.entry_type === "OPENING_ADVANCE"
        ? rawItem.entry_type
        : null;
    const amountMinor = positiveMoneyStr(rawItem.amount_minor);
    const deltaMinor = signedMoneyStr(rawItem.balance_delta_minor);
    if (
      vendorId === null ||
      displayName === null ||
      active === null ||
      entryType === null ||
      amountMinor === null ||
      deltaMinor === null
    ) {
      return null;
    }
    items.push({
      vendor_id: vendorId,
      display_name: displayName,
      active,
      entry_type: entryType,
      amount_minor: amountMinor,
      balance_delta_minor: deltaMinor,
    });
  }
  if (items.length !== vendorCount) return null;

  return {
    authorization_date: authorizationDate,
    project_id: projectId,
    project_display_name: projectDisplayName,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: responsibleAccountantName,
    contract_type: contractType,
    cutoff_date: cutoffDate,
    vendor_count: vendorCount,
    skipped_zero_count: skippedZero,
    total_payable_minor: totalPayable,
    total_advance_minor: totalAdvance,
    net_balance_minor: netBalance,
    items,
  };
}

export function parseOpeningApplyEnvelope(
  envelope: unknown,
): VendorFinanceOpeningApplyResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["batch", "entries", "replayed"]) ||
    !isRecord(data.batch) ||
    !exactKeys(data.batch, [
      "batch_id",
      "ledger_scope",
      "project_id",
      "project_display_name_snapshot",
      "accountant_ref",
      "responsible_accountant_display_name",
      "contract_type",
      "cutoff_date",
      "vendor_count",
      "skipped_zero_count",
      "total_payable_minor",
      "total_advance_minor",
      "net_balance_minor",
      "reason",
      "created_by_display_name",
      "created_at",
    ]) ||
    !Array.isArray(data.entries)
  ) {
    return null;
  }

  const b = data.batch;
  const batchId = uuidStr(b.batch_id);
  const ledgerScope = ledgerScopeVal(b.ledger_scope);
  const projectId = nullableProjectIdStr(b.project_id);
  const projectDisplayNameSnapshot = nullableStr(b.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(b.accountant_ref);
  const responsibleAccountantName = nullableStr(b.responsible_accountant_display_name);
  const contractType = contractTypeVal(b.contract_type);
  const cutoffDate = dateStr(b.cutoff_date);
  const vendorCount = posInt(b.vendor_count);
  const skippedZero = nonNegInt(b.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(b.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(b.total_advance_minor);
  const netBalance = signedMoneyStr(b.net_balance_minor);
  const reason = nonEmptyStr(b.reason);
  const createdBy = nonEmptyStr(b.created_by_display_name);
  const createdAt = nonEmptyStr(b.created_at);
  const replayed = boolVal(data.replayed);

  if (
    batchId === null ||
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayNameSnapshot === undefined ||
    accountantRef === undefined ||
    responsibleAccountantName === undefined ||
    contractType === null ||
    cutoffDate === null ||
    vendorCount === null ||
    skippedZero === null ||
    totalPayable === null ||
    totalAdvance === null ||
    netBalance === null ||
    reason === null ||
    createdBy === null ||
    createdAt === null ||
    replayed === null
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of data.entries) {
    const projected = parseEntryProjection(item);
    if (!projected) return null;
    entries.push(projected);
  }
  if (entries.length !== vendorCount) return null;

  return {
    batch: {
      batch_id: batchId,
      ledger_scope: ledgerScope,
      project_id: projectId,
      project_display_name_snapshot: projectDisplayNameSnapshot,
      accountant_ref: accountantRef,
      responsible_accountant_display_name: responsibleAccountantName,
      contract_type: contractType,
      cutoff_date: cutoffDate,
      vendor_count: vendorCount,
      skipped_zero_count: skippedZero,
      total_payable_minor: totalPayable,
      total_advance_minor: totalAdvance,
      net_balance_minor: netBalance,
      reason,
      created_by_display_name: createdBy,
      created_at: createdAt,
    },
    entries,
    replayed,
  };
}

export function parseClassifySubLedgerEnvelope(
  envelope: unknown,
): VendorFinanceClassifySubLedgerResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["classification", "replayed"])) return null;
  const classification = parseSubLedgerClassificationProjection(data.classification);
  const replayed = boolVal(data.replayed);
  if (!classification || replayed === null) return null;
  return { classification, replayed };
}

export function parseVendorReconciliationsPageEnvelope(
  envelope: unknown,
): VendorFinanceReconciliationsPageResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "vendor_id",
      "page",
      "page_size",
      "total",
      "has_more",
      "reconciliations",
    ]) ||
    !Array.isArray(data.reconciliations)
  ) {
    return null;
  }
  const authorizationDate = dateStr(data.authorization_date);
  const vendorId = isCanonicalUiVendorId(data.vendor_id) ? data.vendor_id : null;
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);
  if (
    authorizationDate === null ||
    vendorId === null ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }
  const reconciliations: VendorFinanceReconciliationProjection[] = [];
  for (const item of data.reconciliations) {
    const projected = parseReconciliationProjection(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    reconciliations.push(projected);
  }
  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    reconciliations,
  };
}

export function parseCreateReconciliationEnvelope(
  envelope: unknown,
): { reconciliation: VendorFinanceReconciliationProjection; replayed: boolean } | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (!isRecord(data) || !exactKeys(data, ["reconciliation", "replayed"])) return null;
  const reconciliation = parseReconciliationProjection(data.reconciliation);
  const replayed = boolVal(data.replayed);
  if (!reconciliation || replayed === null) return null;
  return { reconciliation, replayed };
}

export function parseMonthlyReportEnvelope(
  envelope: unknown,
): VendorFinanceMonthlyReportResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "allowed_actions",
      "filters",
      "totals",
      "project_accountant_summaries",
      "rows",
      "legacy_unallocated_rows",
    ]) ||
    !isRecord(data.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      data.allowed_actions,
      [
        "visibility_scope",
        "can_view",
        "can_record",
        "can_reconcile",
        "can_manage_project_assignments",
      ],
      [
        "can_view_shared_advance",
        "can_fund_vendor_advance",
        "can_record_vendor_refund",
        "can_apply_vendor_advance",
        "active_assigned_project_count",
      ],
    ) ||
    !isRecord(data.filters) ||
    !exactKeys(data.filters, [
      "month",
      "project_id",
      "accountant_ref",
      "vendor_id",
      "contract_type",
    ]) ||
    !isRecord(data.totals) ||
    !requiredAndOptionalKeysOnly(
      data.totals,
      [
        "project_revenue_status",
        "project_revenue_minor",
        "project_accountant_book_count",
        "sub_ledger_count",
        "obligations_in_month_minor",
        "paid_in_month_minor",
        "advanced_in_month_minor",
        "paid_and_advanced_in_month_minor",
        "closing_payable_minor",
        "closing_advance_minor",
      ],
      ["advance_offset_in_month_minor"],
    ) ||
    !Array.isArray(data.project_accountant_summaries) ||
    !Array.isArray(data.rows) ||
    !Array.isArray(data.legacy_unallocated_rows)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const visibilityScope = visibilityScopeVal(data.allowed_actions.visibility_scope);
  const canView = boolVal(data.allowed_actions.can_view);
  const canRecord = boolVal(data.allowed_actions.can_record);
  const canReconcile = boolVal(data.allowed_actions.can_reconcile);
  const canManage = boolVal(data.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_fund_vendor_advance)
      : false;
  const canRefund =
    "can_record_vendor_refund" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_record_vendor_refund)
      : false;
  const canApply =
    "can_apply_vendor_advance" in data.allowed_actions
      ? boolVal(data.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const assignedCount =
    "active_assigned_project_count" in data.allowed_actions
      ? nonNegInt(data.allowed_actions.active_assigned_project_count)
      : undefined;

  const monthCheck =
    typeof data.filters.month === "string" ? validateUiCalendarMonth(data.filters.month) : null;
  const filterProjectId = nullableProjectIdStr(data.filters.project_id);
  const filterAccountantRef = nullableUuidStr(data.filters.accountant_ref);
  const filterVendorId =
    data.filters.vendor_id === null
      ? null
      : isCanonicalUiVendorId(data.filters.vendor_id)
        ? data.filters.vendor_id
        : undefined;
  const filterContractType = data.filters.contract_type;

  const t = data.totals;
  const bookCount = nonNegInt(t.project_accountant_book_count);
  const subLedgerCount = nonNegInt(t.sub_ledger_count);
  const obligations = nonNegativeMoneyStr(t.obligations_in_month_minor);
  const paid = nonNegativeMoneyStr(t.paid_in_month_minor);
  const advanced = nonNegativeMoneyStr(t.advanced_in_month_minor);
  const advanceOffset =
    "advance_offset_in_month_minor" in t
      ? nonNegativeMoneyStr(t.advance_offset_in_month_minor)
      : "0";
  const paidAndAdvanced = nonNegativeMoneyStr(t.paid_and_advanced_in_month_minor);
  const closingPayable = nonNegativeMoneyStr(t.closing_payable_minor);
  const closingAdvance = nonNegativeMoneyStr(t.closing_advance_minor);

  if (
    authorizationDate === null ||
    visibilityScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    assignedCount === null ||
    !monthCheck ||
    !monthCheck.ok ||
    filterProjectId === undefined ||
    filterAccountantRef === undefined ||
    filterVendorId === undefined ||
    (filterContractType !== "all" &&
      filterContractType !== "SEASONAL" &&
      filterContractType !== "OFFICIAL" &&
      filterContractType !== "UNCLASSIFIED") ||
    t.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
    t.project_revenue_minor !== null ||
    bookCount === null ||
    subLedgerCount === null ||
    obligations === null ||
    paid === null ||
    advanced === null ||
    advanceOffset === null ||
    paidAndAdvanced === null ||
    closingPayable === null ||
    closingAdvance === null
  ) {
    return null;
  }

  const summaries: VendorFinanceMonthlyReportAccountantSummary[] = [];
  for (const rawSum of data.project_accountant_summaries) {
    if (
      !isRecord(rawSum) ||
      !requiredAndOptionalKeysOnly(
        rawSum,
        [
          "project_id",
          "project_display_name",
          "project_active",
          "accountant_ref",
          "responsible_accountant_display_name",
          "contract_type",
          "is_currently_assigned",
          "project_revenue_status",
          "project_revenue_minor",
          "vendor_count",
          "obligations_in_month_minor",
          "paid_in_month_minor",
          "advanced_in_month_minor",
          "paid_and_advanced_in_month_minor",
          "closing_payable_minor",
          "closing_advance_minor",
          "in_month_entry_count",
        ],
        ["advance_offset_in_month_minor"],
      )
    ) {
      return null;
    }
    const pId = projectIdStr(rawSum.project_id);
    const pName = nonEmptyStr(rawSum.project_display_name);
    const pActive = boolVal(rawSum.project_active);
    const aRef = uuidStr(rawSum.accountant_ref);
    const aName = nonEmptyStr(rawSum.responsible_accountant_display_name);
    const cType = contractTypeVal(rawSum.contract_type);
    const isAssigned = boolVal(rawSum.is_currently_assigned);
    const vCount = nonNegInt(rawSum.vendor_count);
    const sObl = nonNegativeMoneyStr(rawSum.obligations_in_month_minor);
    const sPaid = nonNegativeMoneyStr(rawSum.paid_in_month_minor);
    const sAdv = nonNegativeMoneyStr(rawSum.advanced_in_month_minor);
    const sAdvOffset =
      "advance_offset_in_month_minor" in rawSum
        ? nonNegativeMoneyStr(rawSum.advance_offset_in_month_minor)
        : "0";
    const sPaidAdv = nonNegativeMoneyStr(rawSum.paid_and_advanced_in_month_minor);
    const sClosePay = nonNegativeMoneyStr(rawSum.closing_payable_minor);
    const sCloseAdv = nonNegativeMoneyStr(rawSum.closing_advance_minor);
    const sInMonthCount = nonNegInt(rawSum.in_month_entry_count);

    if (
      pId === null ||
      pName === null ||
      pActive === null ||
      aRef === null ||
      aName === null ||
      cType === null ||
      isAssigned === null ||
      rawSum.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
      rawSum.project_revenue_minor !== null ||
      vCount === null ||
      sObl === null ||
      sPaid === null ||
      sAdv === null ||
      sAdvOffset === null ||
      sPaidAdv === null ||
      sClosePay === null ||
      sCloseAdv === null ||
      sInMonthCount === null
    ) {
      return null;
    }
    summaries.push({
      project_id: pId,
      project_display_name: pName,
      project_active: pActive,
      accountant_ref: aRef,
      responsible_accountant_display_name: aName,
      contract_type: cType,
      is_currently_assigned: isAssigned,
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      vendor_count: vCount,
      obligations_in_month_minor: sObl,
      paid_in_month_minor: sPaid,
      advanced_in_month_minor: sAdv,
      advance_offset_in_month_minor: sAdvOffset,
      paid_and_advanced_in_month_minor: sPaidAdv,
      closing_payable_minor: sClosePay,
      closing_advance_minor: sCloseAdv,
      in_month_entry_count: sInMonthCount,
    });
  }

  const rows: VendorFinanceMonthlyReportRow[] = [];
  for (const rawRow of data.rows) {
    if (
      !isRecord(rawRow) ||
      !requiredAndOptionalKeysOnly(
        rawRow,
        [
          "project_id",
          "project_display_name",
          "project_active",
          "accountant_ref",
          "responsible_accountant_display_name",
          "is_currently_assigned",
          "vendor_id",
          "vendor_display_name",
          "vendor_active",
          "contract_type",
          "project_revenue_status",
          "project_revenue_minor",
          "balance_before_month_minor",
          "opening_payable_in_month_minor",
          "opening_advance_in_month_minor",
          "obligations_in_month_minor",
          "paid_in_month_minor",
          "advanced_in_month_minor",
          "paid_and_advanced_in_month_minor",
          "net_change_in_month_minor",
          "closing_balance_minor",
          "closing_direction",
          "closing_payable_minor",
          "closing_advance_minor",
          "current_balance_minor",
          "in_month_entry_count",
          "total_entry_count",
        ],
        ["advance_offset_in_month_minor"],
      )
    ) {
      return null;
    }
    const pId = projectIdStr(rawRow.project_id);
    const pName = nonEmptyStr(rawRow.project_display_name);
    const pActive = boolVal(rawRow.project_active);
    const aRef = uuidStr(rawRow.accountant_ref);
    const aName = nonEmptyStr(rawRow.responsible_accountant_display_name);
    const isAssigned = boolVal(rawRow.is_currently_assigned);
    const vId = isCanonicalUiVendorId(rawRow.vendor_id) ? rawRow.vendor_id : null;
    const vName = nonEmptyStr(rawRow.vendor_display_name);
    const vActive = boolVal(rawRow.vendor_active);
    const cType = contractTypeVal(rawRow.contract_type);
    const balBefore = signedMoneyStr(rawRow.balance_before_month_minor);
    const openPay = nonNegativeMoneyStr(rawRow.opening_payable_in_month_minor);
    const openAdv = nonNegativeMoneyStr(rawRow.opening_advance_in_month_minor);
    const rObl = nonNegativeMoneyStr(rawRow.obligations_in_month_minor);
    const rPaid = nonNegativeMoneyStr(rawRow.paid_in_month_minor);
    const rAdv = nonNegativeMoneyStr(rawRow.advanced_in_month_minor);
    const rAdvOffset =
      "advance_offset_in_month_minor" in rawRow
        ? nonNegativeMoneyStr(rawRow.advance_offset_in_month_minor)
        : "0";
    const rPaidAdv = nonNegativeMoneyStr(rawRow.paid_and_advanced_in_month_minor);
    const netChange = signedMoneyStr(rawRow.net_change_in_month_minor);
    const closingBal = signedMoneyStr(rawRow.closing_balance_minor);
    const closingDir = balanceDirectionVal(rawRow.closing_direction);
    const closePay = nonNegativeMoneyStr(rawRow.closing_payable_minor);
    const closeAdv = nonNegativeMoneyStr(rawRow.closing_advance_minor);
    const currBal = signedMoneyStr(rawRow.current_balance_minor);
    const inMonthCount = nonNegInt(rawRow.in_month_entry_count);
    const totalCount = nonNegInt(rawRow.total_entry_count);

    if (
      pId === null ||
      pName === null ||
      pActive === null ||
      aRef === null ||
      aName === null ||
      isAssigned === null ||
      vId === null ||
      vName === null ||
      vActive === null ||
      cType === null ||
      rawRow.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
      rawRow.project_revenue_minor !== null ||
      balBefore === null ||
      openPay === null ||
      openAdv === null ||
      rObl === null ||
      rPaid === null ||
      rAdv === null ||
      rAdvOffset === null ||
      rPaidAdv === null ||
      netChange === null ||
      closingBal === null ||
      closingDir === null ||
      closePay === null ||
      closeAdv === null ||
      currBal === null ||
      inMonthCount === null ||
      totalCount === null
    ) {
      return null;
    }

    if (BigInt(balBefore) + BigInt(netChange) !== BigInt(closingBal)) {
      return null;
    }

    rows.push({
      project_id: pId,
      project_display_name: pName,
      project_active: pActive,
      accountant_ref: aRef,
      responsible_accountant_display_name: aName,
      is_currently_assigned: isAssigned,
      vendor_id: vId,
      vendor_display_name: vName,
      vendor_active: vActive,
      contract_type: cType,
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      balance_before_month_minor: balBefore,
      opening_payable_in_month_minor: openPay,
      opening_advance_in_month_minor: openAdv,
      obligations_in_month_minor: rObl,
      paid_in_month_minor: rPaid,
      advanced_in_month_minor: rAdv,
      advance_offset_in_month_minor: rAdvOffset,
      paid_and_advanced_in_month_minor: rPaidAdv,
      net_change_in_month_minor: netChange,
      closing_balance_minor: closingBal,
      closing_direction: closingDir,
      closing_payable_minor: closePay,
      closing_advance_minor: closeAdv,
      current_balance_minor: currBal,
      in_month_entry_count: inMonthCount,
      total_entry_count: totalCount,
    });
  }

  const legacyRows: VendorFinanceMonthlyLegacyRow[] = [];
  for (const rawLeg of data.legacy_unallocated_rows) {
    if (
      !isRecord(rawLeg) ||
      !exactKeys(rawLeg, [
        "vendor_id",
        "vendor_display_name",
        "vendor_active",
        "balance_before_month_minor",
        "obligations_in_month_minor",
        "paid_and_advanced_in_month_minor",
        "closing_balance_minor",
        "closing_direction",
        "in_month_entry_count",
      ])
    ) {
      return null;
    }
    const vId = isCanonicalUiVendorId(rawLeg.vendor_id) ? rawLeg.vendor_id : null;
    const vName = nonEmptyStr(rawLeg.vendor_display_name);
    const vActive = boolVal(rawLeg.vendor_active);
    const balBefore = signedMoneyStr(rawLeg.balance_before_month_minor);
    const lObl = nonNegativeMoneyStr(rawLeg.obligations_in_month_minor);
    const lPaidAdv = nonNegativeMoneyStr(rawLeg.paid_and_advanced_in_month_minor);
    const closeBal = signedMoneyStr(rawLeg.closing_balance_minor);
    const closeDir = balanceDirectionVal(rawLeg.closing_direction);
    const inMonthCount = nonNegInt(rawLeg.in_month_entry_count);

    if (
      vId === null ||
      vName === null ||
      vActive === null ||
      balBefore === null ||
      lObl === null ||
      lPaidAdv === null ||
      closeBal === null ||
      closeDir === null ||
      inMonthCount === null
    ) {
      return null;
    }

    legacyRows.push({
      vendor_id: vId,
      vendor_display_name: vName,
      vendor_active: vActive,
      balance_before_month_minor: balBefore,
      obligations_in_month_minor: lObl,
      paid_and_advanced_in_month_minor: lPaidAdv,
      closing_balance_minor: closeBal,
      closing_direction: closeDir,
      in_month_entry_count: inMonthCount,
    });
  }

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visibilityScope,
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      can_manage_project_assignments: canManage,
      can_view_shared_advance: canViewShared,
      can_fund_vendor_advance: canFund,
      can_record_vendor_refund: canRefund,
      can_apply_vendor_advance: canApply,
      ...(assignedCount !== undefined
        ? { active_assigned_project_count: assignedCount }
        : {}),
    },
    filters: {
      month: monthCheck.month,
      project_id: filterProjectId,
      accountant_ref: filterAccountantRef,
      vendor_id: filterVendorId,
      contract_type: filterContractType,
    },
    totals: {
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      project_accountant_book_count: bookCount,
      sub_ledger_count: subLedgerCount,
      obligations_in_month_minor: obligations,
      paid_in_month_minor: paid,
      advanced_in_month_minor: advanced,
      advance_offset_in_month_minor: advanceOffset,
      paid_and_advanced_in_month_minor: paidAndAdvanced,
      closing_payable_minor: closingPayable,
      closing_advance_minor: closingAdvance,
    },
    project_accountant_summaries: summaries,
    rows,
    legacy_unallocated_rows: legacyRows,
  };
}

function adminGrantStateVal(value: unknown): VendorFinanceAdminGrantState | null {
  return value === "ACTIVE" ||
    value === "SCHEDULED" ||
    value === "ENDED" ||
    value === "CANCELLED"
    ? value
    : null;
}

function parseProjectAccountantAssignmentItem(
  value: unknown,
): VendorFinanceProjectAccountantAssignmentItem | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "assignment_id",
      "project_id",
      "version",
      "accountant",
      "accountant_in_accounting_department",
      "valid_from",
      "valid_to",
      "state",
      "assign_reason",
      "end_reason",
      "created_at",
    ])
  ) {
    return null;
  }
  const assignmentId = uuidStr(value.assignment_id);
  const projectId = projectIdStr(value.project_id);
  const version = posInt(value.version);
  const accountant = parseAccountSummaryProjection(value.accountant);
  const inDept = boolVal(value.accountant_in_accounting_department);
  const validFrom = dateStr(value.valid_from);
  const validTo = nullableDateStr(value.valid_to);
  const state = adminGrantStateVal(value.state);
  const assignReason = nonEmptyStr(value.assign_reason);
  const endReason = nullableStr(value.end_reason);
  const createdAt = nonEmptyStr(value.created_at);

  if (
    assignmentId === null ||
    projectId === null ||
    version === null ||
    accountant === null ||
    inDept === null ||
    validFrom === null ||
    validTo === undefined ||
    state === null ||
    assignReason === null ||
    endReason === undefined ||
    createdAt === null
  ) {
    return null;
  }

  return {
    assignment_id: assignmentId,
    project_id: projectId,
    version,
    accountant,
    accountant_in_accounting_department: inDept,
    valid_from: validFrom,
    valid_to: validTo,
    state,
    assign_reason: assignReason,
    end_reason: endReason,
    created_at: createdAt,
  };
}

export function parseAdminProjectAccountantsEnvelope(
  envelope: unknown,
): VendorFinanceListProjectAccountantsAdminResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "eligible_accountants",
      "page",
      "page_size",
      "total",
      "has_more",
      "projects",
    ]) ||
    !Array.isArray(data.eligible_accountants) ||
    !Array.isArray(data.projects)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);
  if (
    authorizationDate === null ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }

  const eligibleAccountants: VendorFinanceAccountSummary[] = [];
  for (const rawAcc of data.eligible_accountants) {
    const acc = parseAccountSummaryProjection(rawAcc);
    if (!acc) return null;
    eligibleAccountants.push(acc);
  }

  const projects: VendorFinanceProjectAccountantsAdminProject[] = [];
  for (const rawProj of data.projects) {
    if (
      !isRecord(rawProj) ||
      !exactKeys(rawProj, [
        "project_id",
        "display_name",
        "active",
        "next_version",
        "transacted_vendor_count",
        "current_assignment",
        "assignments",
      ]) ||
      !Array.isArray(rawProj.assignments)
    ) {
      return null;
    }
    const projectId = projectIdStr(rawProj.project_id);
    const displayName = nonEmptyStr(rawProj.display_name);
    const active = boolVal(rawProj.active);
    const nextVersion = posInt(rawProj.next_version);
    const transactedCount = nonNegInt(rawProj.transacted_vendor_count);
    const currentAssignment =
      rawProj.current_assignment === null
        ? null
        : parseProjectAccountantAssignmentItem(rawProj.current_assignment);
    if (
      projectId === null ||
      displayName === null ||
      active === null ||
      nextVersion === null ||
      transactedCount === null ||
      (rawProj.current_assignment !== null && currentAssignment === null)
    ) {
      return null;
    }

    const assignments: VendorFinanceProjectAccountantAssignmentItem[] = [];
    for (const rawAsgn of rawProj.assignments) {
      const asgn = parseProjectAccountantAssignmentItem(rawAsgn);
      if (!asgn || asgn.project_id !== projectId) return null;
      assignments.push(asgn);
    }

    projects.push({
      project_id: projectId,
      display_name: displayName,
      active,
      next_version: nextVersion,
      transacted_vendor_count: transactedCount,
      current_assignment: currentAssignment,
      assignments,
    });
  }

  return {
    authorization_date: authorizationDate,
    eligible_accountants: eligibleAccountants,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    projects,
  };
}

export function parseAssignProjectAccountantEnvelope(
  envelope: unknown,
): VendorFinanceAssignProjectAccountantResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["assignment_id", "project_id", "version", "replayed"])
  ) {
    return null;
  }
  const assignmentId = uuidStr(data.assignment_id);
  const projectId = projectIdStr(data.project_id);
  const version = posInt(data.version);
  const replayed = boolVal(data.replayed);
  if (assignmentId === null || projectId === null || version === null || replayed === null) {
    return null;
  }
  return {
    assignment_id: assignmentId,
    project_id: projectId,
    version,
    replayed,
  };
}

export function parseEndProjectAccountantEnvelope(
  envelope: unknown,
): VendorFinanceEndProjectAccountantResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["assignment_id", "project_id", "valid_to", "replayed"])
  ) {
    return null;
  }
  const assignmentId = uuidStr(data.assignment_id);
  const projectId = projectIdStr(data.project_id);
  const validTo = dateStr(data.valid_to);
  const replayed = boolVal(data.replayed);
  if (assignmentId === null || projectId === null || validTo === null || replayed === null) {
    return null;
  }
  return {
    assignment_id: assignmentId,
    project_id: projectId,
    valid_to: validTo,
    replayed,
  };
}

export function parseAdminGlobalRolesEnvelope(
  envelope: unknown,
): VendorFinanceListGlobalRolesAdminResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "authorization_date",
      "page",
      "page_size",
      "total",
      "has_more",
      "roles",
      "candidates",
    ]) ||
    !Array.isArray(data.roles) ||
    !Array.isArray(data.candidates)
  ) {
    return null;
  }

  const authorizationDate = dateStr(data.authorization_date);
  const page = posInt(data.page);
  const pageSize = posInt(data.page_size);
  const total = nonNegInt(data.total);
  const hasMore = boolVal(data.has_more);
  if (
    authorizationDate === null ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }

  const roles: VendorFinanceGlobalRoleGrantItem[] = [];
  for (const rawRole of data.roles) {
    if (
      !isRecord(rawRole) ||
      !exactKeys(rawRole, [
        "role_grant_id",
        "account",
        "role_code",
        "version",
        "valid_from",
        "valid_to",
        "state",
        "grant_reason",
        "end_reason",
        "created_at",
      ])
    ) {
      return null;
    }
    const roleGrantId = uuidStr(rawRole.role_grant_id);
    const account = parseAccountSummaryProjection(rawRole.account);
    const roleCode =
      typeof rawRole.role_code === "string" &&
      (VFIN_UI_GLOBAL_ROLE_CODES as readonly string[]).includes(rawRole.role_code)
        ? (rawRole.role_code as VendorFinanceGlobalRoleCode)
        : null;
    const version = posInt(rawRole.version);
    const validFrom = dateStr(rawRole.valid_from);
    const validTo = nullableDateStr(rawRole.valid_to);
    const state = adminGrantStateVal(rawRole.state);
    const grantReason = nonEmptyStr(rawRole.grant_reason);
    const endReason = nullableStr(rawRole.end_reason);
    const createdAt = nonEmptyStr(rawRole.created_at);

    if (
      roleGrantId === null ||
      account === null ||
      roleCode === null ||
      version === null ||
      validFrom === null ||
      validTo === undefined ||
      state === null ||
      grantReason === null ||
      endReason === undefined ||
      createdAt === null
    ) {
      return null;
    }

    roles.push({
      role_grant_id: roleGrantId,
      account,
      role_code: roleCode,
      version,
      valid_from: validFrom,
      valid_to: validTo,
      state,
      grant_reason: grantReason,
      end_reason: endReason,
      created_at: createdAt,
    });
  }

  const candidates: VendorFinanceGlobalRoleCandidateItem[] = [];
  for (const rawCand of data.candidates) {
    if (
      !isRecord(rawCand) ||
      !exactKeys(rawCand, ["account", "next_version", "has_open_role"])
    ) {
      return null;
    }
    const account = parseAccountSummaryProjection(rawCand.account);
    const nextVersion = posInt(rawCand.next_version);
    const hasOpenRole = boolVal(rawCand.has_open_role);
    if (account === null || nextVersion === null || hasOpenRole === null) {
      return null;
    }
    candidates.push({
      account,
      next_version: nextVersion,
      has_open_role: hasOpenRole,
    });
  }

  return {
    authorization_date: authorizationDate,
    page,
    page_size: pageSize,
    total,
    has_more: hasMore,
    roles,
    candidates,
  };
}

export function parseAssignGlobalRoleEnvelope(
  envelope: unknown,
): VendorFinanceAssignGlobalRoleResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["role_grant_id", "account_ref", "role_code", "version", "replayed"])
  ) {
    return null;
  }
  const roleGrantId = uuidStr(data.role_grant_id);
  const accountRef = uuidStr(data.account_ref);
  const roleCode =
    typeof data.role_code === "string" &&
    (VFIN_UI_GLOBAL_ROLE_CODES as readonly string[]).includes(data.role_code)
      ? (data.role_code as VendorFinanceGlobalRoleCode)
      : null;
  const version = posInt(data.version);
  const replayed = boolVal(data.replayed);
  if (
    roleGrantId === null ||
    accountRef === null ||
    roleCode === null ||
    version === null ||
    replayed === null
  ) {
    return null;
  }
  return {
    role_grant_id: roleGrantId,
    account_ref: accountRef,
    role_code: roleCode,
    version,
    replayed,
  };
}

export function parseEndGlobalRoleEnvelope(
  envelope: unknown,
): VendorFinanceEndGlobalRoleResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["role_grant_id", "account_ref", "valid_to", "replayed"])
  ) {
    return null;
  }
  const roleGrantId = uuidStr(data.role_grant_id);
  const accountRef = uuidStr(data.account_ref);
  const validTo = dateStr(data.valid_to);
  const replayed = boolVal(data.replayed);
  if (roleGrantId === null || accountRef === null || validTo === null || replayed === null) {
    return null;
  }
  return {
    role_grant_id: roleGrantId,
    account_ref: accountRef,
    valid_to: validTo,
    replayed,
  };
}

export function parseEvidenceReserveEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceReserveResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "evidence_id",
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "upload",
      "replayed",
    ]) ||
    !isRecord(data.upload) ||
    !exactKeys(data.upload, ["method", "url", "expires_at", "headers"]) ||
    !isRecord(data.upload.headers)
  ) {
    return null;
  }

  const evidenceId = uuidStr(data.evidence_id);
  const targetKind =
    data.target_kind === "ENTRY" || data.target_kind === "RECONCILIATION"
      ? data.target_kind
      : null;
  const targetId = uuidStr(data.target_id);
  const mimeType =
    data.mime_type === "image/jpeg" || data.mime_type === "image/png" ? data.mime_type : null;
  const sizeBytes = posInt(data.size_bytes);
  const checksum =
    typeof data.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(data.checksum_sha256)
      ? data.checksum_sha256.toLowerCase()
      : null;
  const replayed = boolVal(data.replayed);
  const uploadUrl = isHttpsPresignedUrl(data.upload.url) ? data.upload.url : null;
  const expiresAt = nonEmptyStr(data.upload.expires_at);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.upload.headers)) {
    if (typeof v !== "string" || k.trim().length === 0) {
      return null;
    }
    headers[k] = v;
  }

  if (
    evidenceId === null ||
    targetKind === null ||
    targetId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    replayed === null ||
    data.upload.method !== "PUT" ||
    uploadUrl === null ||
    expiresAt === null
  ) {
    return null;
  }

  return {
    evidence_id: evidenceId,
    target_kind: targetKind,
    target_id: targetId,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    upload: {
      method: "PUT",
      url: uploadUrl,
      expires_at: expiresAt,
      headers,
    },
    replayed,
  };
}

export function parseEvidenceFinalizeEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceFinalizeResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, ["evidence", "replayed"]) ||
    !isRecord(data.evidence)
  ) {
    return null;
  }
  const ev = data.evidence;
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
    !isUuidString(ev.target_id)
  ) {
    return null;
  }
  const summary = parseEvidenceSummaryProjection({
    evidence_id: ev.evidence_id,
    status: ev.status,
    mime_type: ev.mime_type,
    size_bytes: ev.size_bytes,
    checksum_sha256: ev.checksum_sha256,
    finalized_at: ev.finalized_at,
  });
  const replayed = boolVal(data.replayed);
  if (!summary || replayed === null) return null;
  return {
    evidence: {
      ...summary,
      target_kind: ev.target_kind,
      target_id: ev.target_id.toLowerCase(),
    },
    replayed,
  };
}

export function parseEvidenceDownloadEnvelope(
  envelope: unknown,
): VendorFinanceEvidenceDownloadResponse | null {
  const data = unwrapOkDataEnvelope(envelope);
  if (
    !isRecord(data) ||
    !exactKeys(data, [
      "evidence_id",
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "download",
    ]) ||
    !isRecord(data.download) ||
    !exactKeys(data.download, ["url", "expires_at"])
  ) {
    return null;
  }
  const evidenceId = uuidStr(data.evidence_id);
  const targetKind =
    data.target_kind === "ENTRY" || data.target_kind === "RECONCILIATION"
      ? data.target_kind
      : null;
  const targetId = uuidStr(data.target_id);
  const mimeType =
    data.mime_type === "image/jpeg" || data.mime_type === "image/png" ? data.mime_type : null;
  const sizeBytes = posInt(data.size_bytes);
  const checksum =
    typeof data.checksum_sha256 === "string" && SHA256_HEX_REGEX.test(data.checksum_sha256)
      ? data.checksum_sha256.toLowerCase()
      : null;
  const downloadUrl = isHttpsPresignedUrl(data.download.url) ? data.download.url : null;
  const expiresAt = nonEmptyStr(data.download.expires_at);

  if (
    evidenceId === null ||
    targetKind === null ||
    targetId === null ||
    mimeType === null ||
    sizeBytes === null ||
    sizeBytes > VFIN_UI_EVIDENCE_MAX_BYTES ||
    checksum === null ||
    downloadUrl === null ||
    expiresAt === null
  ) {
    return null;
  }

  return {
    evidence_id: evidenceId,
    target_kind: targetKind,
    target_id: targetId,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    checksum_sha256: checksum,
    download: {
      url: downloadUrl,
      expires_at: expiresAt,
    },
  };
}

// -----------------------------------------------------------------------------
// 6B. Browser XLSX Export Blob & Safe Filename Helpers
// -----------------------------------------------------------------------------
export const VENDOR_FINANCE_MIN_XLSX_ZIP_BYTES = 30;

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
  VENDOR_FINANCE_EXPORT_XLSX_MIME,
  "application/octet-stream",
]);

export function hasVendorFinanceXlsxZipSignature(headerBytes: ArrayBuffer | Uint8Array): boolean {
  const bytes = headerBytes instanceof Uint8Array ? headerBytes : new Uint8Array(headerBytes);
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export async function isUsableVendorFinanceExportBlob(
  blob: Pick<Blob, "size" | "type" | "slice"> | null | undefined,
  contentTypeHeader?: string | null,
): Promise<boolean> {
  if (
    !blob ||
    typeof blob.size !== "number" ||
    !Number.isFinite(blob.size) ||
    blob.size < VENDOR_FINANCE_MIN_XLSX_ZIP_BYTES ||
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
    return hasVendorFinanceXlsxZipSignature(headerBuffer);
  } catch {
    return false;
  }
}

const XLSX_SAFE_FILENAME_REGEX = /^[A-Za-z0-9._-]+\.xlsx$/;

export function resolveVendorFinanceExportFilename(
  contentDisposition: string | null | undefined,
  fallbackDate?: string | null,
): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/);
  const candidate = match?.[1] ?? "";
  if (XLSX_SAFE_FILENAME_REGEX.test(candidate) && !candidate.includes("..")) {
    return candidate;
  }
  const safeDate =
    typeof fallbackDate === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(fallbackDate)
      ? fallbackDate
      : new Date().toISOString().slice(0, 10);
  return `danh-sach-vendor-cong-no-${safeDate}.xlsx`;
}

// -----------------------------------------------------------------------------
// 7. Sanitized Vietnamese Error Classifier (Fail-Closed, Zero Raw Leaks)
// -----------------------------------------------------------------------------
export type ClassifiedVendorFinanceError = {
  code: string;
  message: string;
  shouldRotateIdempotencyKey: boolean;
  isWholeBatchRollback: boolean;
};

export function extractVendorFinanceErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || payload.ok !== false) return null;
  if (typeof payload.code === "string" && /^[A-Z0-9_]{3,80}$/.test(payload.code)) {
    return payload.code;
  }
  if (
    isRecord(payload.error) &&
    typeof payload.error.code === "string" &&
    /^[A-Z0-9_]{3,80}$/.test(payload.error.code)
  ) {
    return payload.error.code;
  }
  return null;
}

export function classifyVendorFinanceError(
  payload: unknown,
  httpStatus?: number,
): ClassifiedVendorFinanceError {
  const code = extractVendorFinanceErrorCode(payload) ?? "UNKNOWN_ERROR";

  switch (code as VendorFinanceErrorCode | "NOT_FOUND" | "UNKNOWN_ERROR") {
    case "UNAUTHENTICATED":
      return {
        code,
        message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "ACTOR_NOT_AVAILABLE":
      return {
        code,
        message: "Tài khoản hiện không khả dụng để thực hiện thao tác này.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "CSRF_ORIGIN_DENIED":
      return {
        code,
        message: "Yêu cầu bị từ chối do nguồn gửi không hợp lệ. Vui lòng tải lại trang.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ACCESS_DENIED":
      return {
        code,
        message: "Bạn không có quyền truy cập phân hệ Tài chính Vendor.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_RECORD_DENIED":
      return {
        code,
        message:
          "Tài khoản của bạn không có quyền ghi nhận hoặc hoàn tác bút toán tài chính Vendor cho dự án này.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_RECONCILE_DENIED":
      return {
        code,
        message: "Tài khoản của bạn không có quyền lập kỳ đối soát công nợ trên sổ dự án này.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ADMIN_DENIED":
      return {
        code,
        message: "Chỉ Quản trị viên toàn quyền (Full Admin) mới được quản lý phân công dự án và vai trò toàn cục.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_PROJECT_ACCESS_DENIED":
      return {
        code,
        message:
          "Bạn chỉ được xem hoặc thao tác trên sổ của các dự án do bạn trực tiếp phụ trách.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_PROJECT_INVALID":
    case "VENDOR_FINANCE_PROJECT_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy dự án hợp lệ trong danh mục chuẩn.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_PROJECT_INACTIVE":
      return {
        code,
        message: "Dự án đã ngừng hoạt động, không thể phân công mới hoặc khởi tạo công nợ đầu kỳ.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_PROJECT_UNASSIGNED":
      return {
        code,
        message:
          "Dự án này hiện chưa có kế toán phụ trách đang hiệu lực. Vui lòng liên hệ Full Admin phân công kế toán dự án trước khi ghi nhận.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE":
      return {
        code,
        message:
          "Kế toán phụ trách dự án hiện không còn hiệu lực tại Phòng Kế toán. Vui lòng liên hệ Full Admin bàn giao kế toán dự án.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED":
    case "VENDOR_FINANCE_PROJECT_ASSIGNMENT_OVERLAP":
      return {
        code,
        message:
          "Dự án đã có kế toán phụ trách đang hiệu lực hoặc bị chồng lấn khoảng ngày hiệu lực. Mỗi dự án chỉ có một kế toán chính tại một thời điểm.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_SUBLEDGER_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy sổ chi tiết (Dự án × Kế toán phụ trách × Vendor × Loại hợp đồng) phù hợp.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_CONTRACT_TYPE_INVALID":
      return {
        code,
        message: "Vui lòng chọn loại hợp đồng hợp lệ (Thời vụ hoặc Chính thức).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED":
      return {
        code,
        message:
          "Sổ dự án này đã được phân loại loại hợp đồng trước đó, không thể phân loại lại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY":
      return {
        code,
        message:
          "Sổ đích thuộc loại hợp đồng đã chọn đã phát sinh bút toán hoặc đối soát riêng. Hệ thống chặn gộp tự động để tránh trộn số dư.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ASSIGNMENT_INVALID":
    case "VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND":
      return {
        code,
        message: "Thông tin phân công kế toán dự án không hợp lệ hoặc không tồn tại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT":
      return {
        code,
        message:
          "Phân công kế toán dự án vừa được cập nhật bởi thao tác khác. Vui lòng tải lại danh sách mới nhất trước khi thực hiện lại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_GLOBAL_ROLE_INVALID":
    case "VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND":
      return {
        code,
        message: "Thông tin vai trò toàn cục không hợp lệ hoặc không tồn tại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED":
    case "VENDOR_FINANCE_GLOBAL_ROLE_OVERLAP":
      return {
        code,
        message:
          "Tài khoản này đang có vai trò toàn cục hiệu lực hoặc bị trùng khoảng ngày hiệu lực.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT":
      return {
        code,
        message:
          "Vai trò toàn cục của tài khoản này vừa thay đổi phiên bản. Vui lòng tải lại danh sách trước khi thử lại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE":
      return {
        code,
        message:
          "Tài khoản được chọn không đủ điều kiện (phải đang kích hoạt; đối với kế toán dự án và kế toán cầm tiền phải là thành viên Phòng Kế toán đang hiệu lực).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT":
      return {
        code,
        message:
          "Mã chống gửi trùng đã được dùng cho một nội dung khác. Hệ thống đã tạo mã mới, vui lòng kiểm tra lại và gửi lại.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_VENDOR_NOT_FOUND":
    case "VENDOR_FINANCE_VENDOR_INVALID":
      return {
        code,
        message: "Không tìm thấy Vendor hợp lệ trong hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN":
      return {
        code,
        message:
          "Vendor đã ngừng hoạt động: chỉ được ghi nhận bút toán tất toán hoặc điều chỉnh cho phép theo quy định.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED":
      return {
        code,
        message:
          "Một hoặc nhiều Vendor trong lô đã phát sinh giao dịch hoặc đã khởi tạo đầu kỳ trước đó. Toàn bộ lô đầu kỳ đã được hủy nguyên vẹn (chưa ghi bất kỳ bút toán nào).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_ENTRY_NOT_FOUND":
    case "VENDOR_FINANCE_ENTRY_INVALID":
    case "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND":
    case "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID":
      return {
        code,
        message: "Không tìm thấy bút toán hoặc chứng từ yêu cầu.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ENTRY_TYPE_INVALID":
      return {
        code,
        message: "Loại bút toán không hợp lệ đối với thao tác này.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED":
    case "VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED":
      return {
        code,
        message: "Bút toán này đã được hoàn tác trước đó; mỗi bút toán chỉ được hoàn tác một lần.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE":
      return {
        code,
        message: "Số dư ứng dùng chung hiện tại của Vendor không đủ để thực hiện thao tác này.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE":
      return {
        code,
        message:
          "Số tiền khấu trừ ứng vượt quá công nợ phải trả hiện tại của sổ dự án và loại hợp đồng đã chọn.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED":
      return {
        code,
        message:
          "Số lượng dòng xuất Excel vượt giới hạn an toàn (10.000 dòng). Vui lòng thu hẹp bộ lọc trước khi xuất.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED":
      return {
        code,
        message: "Cần dọn dẹp ảnh bằng chứng trên kho lưu trữ trước khi đặt lại dữ liệu giao dịch.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL":
      return {
        code,
        message: "Không thể hoàn tác một bút toán hoàn tác (REVERSAL).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_AMOUNT_INVALID":
      return {
        code,
        message: "Số tiền không hợp lệ. Vui lòng nhập số nguyên VND đúng quy định.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_AMOUNT_OVERFLOW":
      return {
        code,
        message: "Số tiền hoặc tổng số dư vượt giới hạn an toàn của hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_DATE_INVALID":
      return {
        code,
        message: "Ngày hiệu lực hoặc ngày chốt không hợp lệ.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_REASON_INVALID":
      return {
        code,
        message: "Lý do ghi nhận không hợp lệ hoặc vượt quá giới hạn ký tự.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_INVALID":
      return {
        code,
        message:
          "Dữ liệu lô khởi tạo công nợ đầu kỳ không hợp lệ. Toàn bộ lô đã bị từ chối, chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID":
      return {
        code,
        message: `Số lượng dòng trong lô đầu kỳ phải từ 1 đến ${VFIN_UI_MAX_OPENING_BATCH_ITEMS} Vendor. Toàn bộ lô chưa được ghi.`,
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR":
      return {
        code,
        message:
          "Lô khởi tạo có Vendor bị trùng lặp. Toàn bộ lô đã bị từ chối nguyên vẹn, chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_OPENING_BATCH_EMPTY":
      return {
        code,
        message:
          "Lô khởi tạo phải có ít nhất một Vendor có số dư lớn hơn 0 ₫. Chưa có bút toán nào được ghi.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy bản ghi đối soát yêu cầu.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_NOT_FOUND":
      return {
        code,
        message: "Không tìm thấy thông tin ảnh bằng chứng hoặc đối tượng liên kết.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_MIME_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID":
      return {
        code,
        message: "Tệp tải lên không phải ảnh JPEG hoặc PNG hợp lệ.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID":
      return {
        code,
        message: "Dung lượng ảnh bằng chứng không hợp lệ (tối đa 10 MB).",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID":
      return {
        code,
        message: "Ảnh tải lên không khớp mã kiểm tra toàn vẹn (SHA-256). Vui lòng thử tải lại ảnh.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING":
      return {
        code,
        message: "Ảnh bằng chứng chưa được tải lên kho lưu trữ thành công. Vui lòng bấm Thử tải lại ảnh.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED":
      return {
        code,
        message: "Bút toán hoặc kỳ đối soát này đã có ảnh bằng chứng được xác nhận trước đó.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED":
      return {
        code,
        message: "Phiên tải ảnh bằng chứng đã hết hạn. Vui lòng bấm Thử tải lại ảnh để cấp phiên mới.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_STORAGE_UNAVAILABLE":
      return {
        code,
        message:
          "Kho lưu trữ ảnh bằng chứng tạm thời gián đoạn. Bút toán tiền đã lưu vẫn an toàn; bạn có thể thử tải lại ảnh sau.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_SEARCH_INVALID":
    case "VENDOR_FINANCE_QUERY_INVALID":
    case "VENDOR_FINANCE_CURSOR_INVALID":
      return {
        code,
        message: "Tham số tra cứu hoặc phân trang không hợp lệ.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "VENDOR_FINANCE_PAYLOAD_INVALID":
    case "INVALID_JSON":
    case "REQUEST_BODY_TOO_LARGE":
      return {
        code,
        message: "Dữ liệu gửi lên không đúng định dạng quy định của hệ thống.",
        shouldRotateIdempotencyKey: true,
        isWholeBatchRollback: true,
      };
    case "NOT_FOUND":
      return {
        code,
        message: "Tính năng hoặc tài nguyên hiện không khả dụng.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    case "VENDOR_FINANCE_UNAVAILABLE":
    default: {
      if (httpStatus === 401) {
        return {
          code: "UNAUTHENTICATED",
          message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
          shouldRotateIdempotencyKey: false,
          isWholeBatchRollback: false,
        };
      }
      if (httpStatus === 403) {
        return {
          code: "VENDOR_FINANCE_ACCESS_DENIED",
          message: "Bạn không có quyền thực hiện thao tác này.",
          shouldRotateIdempotencyKey: false,
          isWholeBatchRollback: false,
        };
      }
      return {
        code,
        message: "Hệ thống tạm thời gián đoạn hoặc chưa phản hồi hợp lệ. Vui lòng thử lại.",
        shouldRotateIdempotencyKey: false,
        isWholeBatchRollback: false,
      };
    }
  }
}

// -----------------------------------------------------------------------------
// 8. Browser Evidence File Preflight, SHA-256 & Safe Two-Phase Upload Runner
// -----------------------------------------------------------------------------
export type ClientEvidenceFileLike = {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export function validateEvidenceFilePreflight(file: {
  name?: string;
  type: string;
  size: number;
}):
  | { ok: true; mime_type: VendorFinanceEvidenceMimeType; size_bytes: number }
  | { ok: false; message: string } {
  if (file.type !== "image/jpeg" && file.type !== "image/png") {
    return {
      ok: false,
      message: "Chỉ chấp nhận tệp ảnh bằng chứng định dạng JPEG (.jpg, .jpeg) hoặc PNG (.png).",
    };
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    return {
      ok: false,
      message: "Tệp ảnh bằng chứng đang rỗng (0 byte). Vui lòng chọn tệp hợp lệ.",
    };
  }
  if (file.size > VFIN_UI_EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      message: `Ảnh bằng chứng vượt quá giới hạn 10 MB (hiện tại: ${formatFileSizeVi(file.size)}).`,
    };
  }
  return {
    ok: true,
    mime_type: file.type,
    size_bytes: file.size,
  };
}

export async function computeBrowserSha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WEB_CRYPTO_UNAVAILABLE");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export type EvidenceUploadResumeState = {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  evidence_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  upload_url: string;
  upload_headers: Readonly<Record<string, string>>;
  expires_at: string;
  put_completed: boolean;
};

export type EvidenceUploadStepResult =
  | {
      ok: true;
      evidence: VendorFinanceEvidenceSummary;
      replayed: boolean;
    }
  | {
      ok: false;
      stage: "preflight" | "reserve" | "put" | "finalize";
      code: string;
      message: string;
      alreadyAttached: boolean;
      resumeState: EvidenceUploadResumeState | null;
    };

function isReservationStillUsable(expiresAt: string, nowMs: number): boolean {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed > nowMs + 15_000;
}

async function readSafeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Executes `reserve -> PUT -> finalize` strictly against an ALREADY COMMITTED
 * `entry_id` or `reconciliation_id`.
 *
 * Guarantee:
 * - Never calls `POST .../entries` or `POST .../reconciliations`.
 * - If `PUT` or `finalize` fails on a transient error, returns `resumeState` so
 *   retrying can resume or cleanly create a fresh reservation on the same `target_id`
 *   without duplicating or losing the committed money entry.
 */
export async function uploadEvidenceForCommittedTarget(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  file: ClientEvidenceFileLike;
  resumeState?: EvidenceUploadResumeState | null;
  fetchImpl?: typeof fetch;
  createIdempotencyKey?: () => string;
  nowMs?: () => number;
}): Promise<EvidenceUploadStepResult> {
  const fetchFn = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const makeIdemKey = input.createIdempotencyKey ?? createClientIdempotencyKey;
  const getNowMs = input.nowMs ?? (() => Date.now());

  const preflight = validateEvidenceFilePreflight(input.file);
  if (!preflight.ok) {
    return {
      ok: false,
      stage: "preflight",
      code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID",
      message: preflight.message,
      alreadyAttached: false,
      resumeState: null,
    };
  }

  let buffer: ArrayBuffer;
  let checksumSha256: string;
  try {
    buffer = await input.file.arrayBuffer();
    if (buffer.byteLength !== preflight.size_bytes) {
      return {
        ok: false,
        stage: "preflight",
        code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID",
        message: "Kích thước tệp ảnh đã thay đổi trong lúc đọc. Vui lòng chọn lại tệp ảnh.",
        alreadyAttached: false,
        resumeState: null,
      };
    }
    checksumSha256 = await computeBrowserSha256Hex(buffer);
  } catch {
    return {
      ok: false,
      stage: "preflight",
      code: "WEB_CRYPTO_READ_FAILED",
      message:
        "Trình duyệt không thể đọc hoặc tính mã kiểm tra SHA-256 cho ảnh (yêu cầu kết nối HTTPS an toàn).",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const normalizedTargetId = input.target_id.toLowerCase();

  const tryFinalize = async (
    state: EvidenceUploadResumeState,
  ): Promise<
    | { kind: "done"; evidence: VendorFinanceEvidenceSummary; replayed: boolean }
    | { kind: "need_fresh_reserve" }
    | { kind: "error"; result: Extract<EvidenceUploadStepResult, { ok: false }> }
  > => {
    const finalizeReq = buildFinalizeEvidenceRequest();
    let finalizeRes: Response;
    try {
      finalizeRes = await fetchFn(buildFinalizeEvidenceUrl(state.evidence_id), {
        method: "POST",
        headers: finalizeReq.headers,
        body: JSON.stringify(finalizeReq.body),
      });
    } catch {
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: "NETWORK_ERROR",
          message:
            "Mất kết nối khi xác nhận hoàn tất ảnh bằng chứng. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
          alreadyAttached: false,
          resumeState: state,
        },
      };
    }

    const finalizePayload = await readSafeJson(finalizeRes);
    if (!finalizeRes.ok) {
      const classified = classifyVendorFinanceError(finalizePayload, finalizeRes.status);
      if (
        classified.code === "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED" ||
        classified.code === "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING" ||
        classified.code === "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"
      ) {
        return { kind: "need_fresh_reserve" };
      }
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: classified.code,
          message: classified.message,
          alreadyAttached: classified.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED",
          resumeState:
            classified.code === "VENDOR_FINANCE_STORAGE_UNAVAILABLE" ||
            classified.code === "VENDOR_FINANCE_UNAVAILABLE"
              ? state
              : null,
        },
      };
    }

    const parsedFinalize = parseEvidenceFinalizeEnvelope(finalizePayload);
    if (!parsedFinalize) {
      return {
        kind: "error",
        result: {
          ok: false,
          stage: "finalize",
          code: "INVALID_RESPONSE",
          message:
            "Phản hồi xác nhận ảnh từ máy chủ không hợp lệ. Vui lòng tải lại dữ liệu trước khi thử lại.",
          alreadyAttached: false,
          resumeState: null,
        },
      };
    }

    return {
      kind: "done",
      evidence: {
        evidence_id: parsedFinalize.evidence.evidence_id,
        status: "READY",
        mime_type: parsedFinalize.evidence.mime_type,
        size_bytes: parsedFinalize.evidence.size_bytes,
        checksum_sha256: parsedFinalize.evidence.checksum_sha256,
        finalized_at: parsedFinalize.evidence.finalized_at,
      },
      replayed: parsedFinalize.replayed,
    };
  };

  const tryPutAndFinalize = async (
    state: EvidenceUploadResumeState,
    allowFallbackReserve: boolean,
  ): Promise<
    | { kind: "done"; evidence: VendorFinanceEvidenceSummary; replayed: boolean }
    | { kind: "need_fresh_reserve" }
    | { kind: "error"; result: Extract<EvidenceUploadStepResult, { ok: false }> }
  > => {
    let currentState = state;
    if (!currentState.put_completed) {
      let putRes: Response;
      try {
        putRes = await fetchFn(currentState.upload_url, {
          method: "PUT",
          headers: currentState.upload_headers,
          body: buffer,
        });
      } catch {
        return {
          kind: "error",
          result: {
            ok: false,
            stage: "put",
            code: "STORAGE_PUT_NETWORK_ERROR",
            message:
              "Tải ảnh lên kho lưu trữ không thành công do lỗi kết nối. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
            alreadyAttached: false,
            resumeState: currentState,
          },
        };
      }

      if (!putRes.ok) {
        if (allowFallbackReserve && (putRes.status === 401 || putRes.status === 403)) {
          return { kind: "need_fresh_reserve" };
        }
        return {
          kind: "error",
          result: {
            ok: false,
            stage: "put",
            code: `STORAGE_PUT_${putRes.status}`,
            message:
              "Kho lưu trữ từ chối hoặc tạm thời lỗi khi nhận tệp ảnh. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
            alreadyAttached: false,
            resumeState: putRes.status >= 500 ? currentState : null,
          },
        };
      }

      currentState = { ...currentState, put_completed: true };
    }

    return tryFinalize(currentState);
  };

  // Attempt resume if same target + same file + non-expired reservation
  const existing = input.resumeState ?? null;
  if (
    existing &&
    existing.target_kind === input.target_kind &&
    existing.target_id === normalizedTargetId &&
    existing.mime_type === preflight.mime_type &&
    existing.size_bytes === preflight.size_bytes &&
    existing.checksum_sha256 === checksumSha256 &&
    isReservationStillUsable(existing.expires_at, getNowMs())
  ) {
    const resumed = await tryPutAndFinalize(existing, true);
    if (resumed.kind === "done") {
      return { ok: true, evidence: resumed.evidence, replayed: resumed.replayed };
    }
    if (resumed.kind === "error") {
      return resumed.result;
    }
    // `need_fresh_reserve`: fall through to reserve a fresh upload slot!
  }

  // Step 1: Reserve a fresh upload slot on the committed `target_id`
  const reserveBuilt = buildReserveEvidenceRequest({
    target_kind: input.target_kind,
    target_id: normalizedTargetId,
    mime_type: preflight.mime_type,
    size_bytes: preflight.size_bytes,
    checksum_sha256: checksumSha256,
    idempotency_key: makeIdemKey(),
  });
  if (!reserveBuilt.ok) {
    return {
      ok: false,
      stage: "reserve",
      code: "VENDOR_FINANCE_PAYLOAD_INVALID",
      message: reserveBuilt.message,
      alreadyAttached: false,
      resumeState: null,
    };
  }

  let reserveRes: Response;
  try {
    reserveRes = await fetchFn(buildReserveEvidenceUrl(), {
      method: "POST",
      headers: reserveBuilt.request.headers,
      body: JSON.stringify(reserveBuilt.request.body),
    });
  } catch {
    return {
      ok: false,
      stage: "reserve",
      code: "NETWORK_ERROR",
      message:
        "Mất kết nối khi khởi tạo phiên tải ảnh bằng chứng. Bút toán đã lưu an toàn; hãy bấm Thử tải lại ảnh.",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const reservePayload = await readSafeJson(reserveRes);
  if (!reserveRes.ok) {
    const classified = classifyVendorFinanceError(reservePayload, reserveRes.status);
    return {
      ok: false,
      stage: "reserve",
      code: classified.code,
      message: classified.message,
      alreadyAttached: classified.code === "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED",
      resumeState: null,
    };
  }

  const parsedReserve = parseEvidenceReserveEnvelope(reservePayload);
  if (!parsedReserve) {
    return {
      ok: false,
      stage: "reserve",
      code: "INVALID_RESPONSE",
      message: "Phản hồi cấp phiên tải ảnh từ máy chủ không hợp lệ.",
      alreadyAttached: false,
      resumeState: null,
    };
  }

  const freshState: EvidenceUploadResumeState = {
    target_kind: parsedReserve.target_kind,
    target_id: parsedReserve.target_id,
    evidence_id: parsedReserve.evidence_id,
    mime_type: parsedReserve.mime_type,
    size_bytes: parsedReserve.size_bytes,
    checksum_sha256: parsedReserve.checksum_sha256,
    upload_url: parsedReserve.upload.url,
    upload_headers: parsedReserve.upload.headers,
    expires_at: parsedReserve.upload.expires_at,
    put_completed: false,
  };

  // Step 2 & 3: PUT to presigned R2 URL -> Finalize on server
  const freshAttempt = await tryPutAndFinalize(freshState, false);
  if (freshAttempt.kind === "done") {
    return { ok: true, evidence: freshAttempt.evidence, replayed: freshAttempt.replayed };
  }
  if (freshAttempt.kind === "error") {
    return freshAttempt.result;
  }
  return {
    ok: false,
    stage: "finalize",
    code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED",
    message: "Phiên tải ảnh bằng chứng đã hết hạn. Vui lòng bấm Thử tải lại ảnh.",
    alreadyAttached: false,
    resumeState: null,
  };
}

// -----------------------------------------------------------------------------
// 9. Active Sub-Ledger Resolution & Lost-Response Ambiguous Retry Guard (VFIN-05)
// -----------------------------------------------------------------------------

/**
 * Resolves the active accountant's sub-ledger for `RecordVendorEntryDialog`.
 * Never falls back to a handed-over historical accountant's book on the same
 * `(project_id, contract_type)`, because server RPCs always write to the current
 * active accountant's book. When the active accountant's book has not been
 * initialized yet, `sub_ledger` is `null` and `current_payable_minor` is `"0"`.
 */
export function resolveActiveProjectSubLedgerForRecord(input: {
  sub_ledgers: readonly VendorFinanceDetailSubLedger[];
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  active_accountant_ref: string | null;
}): {
  sub_ledger: VendorFinanceDetailSubLedger | null;
  current_payable_minor: string;
} {
  const matched =
    input.sub_ledgers.find(
      (sub) =>
        sub.ledger_scope === "PROJECT_ACCOUNTANT" &&
        sub.project_id === input.project_id &&
        sub.contract_type === input.contract_type &&
        sub.is_active_assignment &&
        (input.active_accountant_ref
          ? sub.accountant_ref === input.active_accountant_ref
          : true),
    ) ?? null;
  return {
    sub_ledger: matched,
    current_payable_minor: matched?.current_balance_minor ?? "0",
  };
}

export type RecordEntryDialogDraftState = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  entry_type: DialogRecordVendorFinanceEntryType;
  amount_input: string;
  offset_amount_input: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
  ambiguous_retry_locked: boolean;
};

/**
 * Determines whether a mutation response (or network failure) leaves the server
 * commit state unknown, requiring the dialog to freeze its payload and
 * `idempotency_key` until the user either retries the exact same request or
 * reloads the ledger to verify before starting a new request.
 */
export function isAmbiguousMutationOutcome(
  input:
    | { kind: "network_error" }
    | { kind: "invalid_ok_envelope" }
    | {
        kind: "http_error";
        http_status: number;
        classified: ClassifiedVendorFinanceError;
      },
): boolean {
  if (input.kind === "network_error" || input.kind === "invalid_ok_envelope") {
    return true;
  }
  if (input.classified.shouldRotateIdempotencyKey) {
    return false;
  }
  if (
    input.http_status === 401 ||
    input.http_status === 403 ||
    input.classified.code === "UNAUTHENTICATED" ||
    input.classified.code === "ACTOR_NOT_AVAILABLE" ||
    input.classified.code === "CSRF_ORIGIN_DENIED" ||
    input.classified.code === "VENDOR_FINANCE_ACCESS_DENIED" ||
    input.classified.code === "VENDOR_FINANCE_RECORD_DENIED" ||
    input.classified.code === "VENDOR_FINANCE_PROJECT_ACCESS_DENIED"
  ) {
    return false;
  }
  return true;
}

/**
 * Applies a field edit to `RecordVendorEntryDialog` draft state.
 * When `ambiguous_retry_locked` is true (after a lost/corrupted response),
 * edits and idempotency-key rotation are strictly blocked so the user cannot
 * mutate the reason/amount and accidentally submit a second payment batch.
 */
export function applyRecordEntryDialogDraftEdit(
  state: RecordEntryDialogDraftState,
  patch: Partial<
    Pick<
      RecordEntryDialogDraftState,
      | "project_id"
      | "contract_type"
      | "entry_type"
      | "amount_input"
      | "offset_amount_input"
      | "effective_date"
      | "reason"
    >
  >,
  nextIdempotencyKey: () => string = createClientIdempotencyKey,
): RecordEntryDialogDraftState {
  if (state.ambiguous_retry_locked) {
    return state;
  }
  return {
    ...state,
    ...patch,
    idempotency_key: nextIdempotencyKey(),
  };
}

/**
 * Determines whether the `RecordVendorEntryDialog` may be dismissed via
 * `Hủy`, `×`, `Escape`, or clicking the backdrop.
 * When `ambiguous_retry_locked` is true, dismissal is strictly blocked so the
 * in-flight/ambiguous payload and `idempotency_key` are never lost.
 */
export function canDismissRecordEntryDialog(input: {
  submitting: boolean;
  retrying_evidence: boolean;
  reloading_ledger?: boolean;
  ambiguous_retry_locked: boolean;
}): boolean {
  if (
    input.submitting ||
    input.retrying_evidence ||
    Boolean(input.reloading_ledger) ||
    input.ambiguous_retry_locked
  ) {
    return false;
  }
  return true;
}

/**
 * Evaluates a user attempt to close `RecordVendorEntryDialog` (`Hủy` / `×` / `Escape` / backdrop).
 * While `ambiguous_retry_locked` is true (e.g., server committed the payment batch
 * but the response was lost), closing is rejected and the original `state`
 * (including payload and `idempotency_key`) is preserved unchanged.
 */
export function attemptCloseRecordEntryDialog(
  state: RecordEntryDialogDraftState,
  defaults: Pick<
    RecordEntryDialogDraftState,
    "project_id" | "contract_type" | "entry_type" | "effective_date"
  >,
  flags?: {
    submitting?: boolean;
    retrying_evidence?: boolean;
    reloading_ledger?: boolean;
  },
  nextIdempotencyKey: () => string = createClientIdempotencyKey,
): {
  allow_close: boolean;
  next_state: RecordEntryDialogDraftState;
} {
  if (
    !canDismissRecordEntryDialog({
      submitting: Boolean(flags?.submitting),
      retrying_evidence: Boolean(flags?.retrying_evidence),
      reloading_ledger: Boolean(flags?.reloading_ledger),
      ambiguous_retry_locked: state.ambiguous_retry_locked,
    })
  ) {
    return {
      allow_close: false,
      next_state: state,
    };
  }
  return {
    allow_close: true,
    next_state: {
      project_id: defaults.project_id,
      contract_type: defaults.contract_type,
      entry_type: defaults.entry_type,
      amount_input: "",
      offset_amount_input: "",
      effective_date: defaults.effective_date,
      reason: "",
      idempotency_key: nextIdempotencyKey(),
      ambiguous_retry_locked: false,
    },
  };
}

/**
 * Transitions `RecordEntryDialogDraftState` after a submission attempt.
 * - On an ambiguous outcome (`network_error`, `invalid_ok_envelope`, or ambiguous `5xx`),
 *   locks the dialog (`ambiguous_retry_locked: true`) and preserves the exact payload and `idempotency_key`.
 * - Only unlocks after a definitive response (`ok` or non-ambiguous `http_error`) for a retry
 *   sent with the same request and same `idempotency_key`.
 */
export function applyRecordEntryMutationOutcome(
  state: RecordEntryDialogDraftState,
  outcome:
    | { kind: "ok" }
    | { kind: "network_error" }
    | { kind: "invalid_ok_envelope" }
    | {
        kind: "http_error";
        http_status: number;
        classified: ClassifiedVendorFinanceError;
      },
  nextIdempotencyKey: () => string = createClientIdempotencyKey,
): RecordEntryDialogDraftState {
  if (outcome.kind === "ok") {
    return {
      ...state,
      ambiguous_retry_locked: false,
    };
  }
  if (outcome.kind !== "http_error" || isAmbiguousMutationOutcome(outcome)) {
    return {
      ...state,
      ambiguous_retry_locked: true,
    };
  }
  return {
    ...state,
    ambiguous_retry_locked: false,
    idempotency_key: outcome.classified.shouldRotateIdempotencyKey
      ? nextIdempotencyKey()
      : state.idempotency_key,
  };
}

export type ReconciledLedgerSnapshotForAmbiguousRetry = {
  has_active_book: boolean;
  current_payable_minor: string;
  shared_advance_balance_minor: string;
  latest_entries: readonly VendorFinanceEntryProjection[];
};

/**
 * Reloads and validates both the vendor detail summary and the active sub-ledger's
 * latest entries so the user can inspect the authoritative server ledger state
 * inside `RecordVendorEntryDialog` before deciding whether to open a new request.
 */
export async function reloadLedgerForAmbiguousRetryVerification(input: {
  vendor_id: string;
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  active_accountant_ref: string | null;
  fetch_impl?: typeof fetch;
}): Promise<
  | { ok: true; snapshot: ReconciledLedgerSnapshotForAmbiguousRetry }
  | { ok: false; message: string }
> {
  const fetchImpl = input.fetch_impl ?? fetch;
  try {
    const [detailRes, entriesRes] = await Promise.all([
      fetchImpl(buildVendorDetailUrl(input.vendor_id), {
        method: "GET",
        cache: "no-store",
      }),
      fetchImpl(
        buildVendorEntriesUrl(input.vendor_id, {
          ledger_scope: "PROJECT_ACCOUNTANT",
          project_id: input.project_id,
          accountant_ref: input.active_accountant_ref ?? undefined,
          contract_type: input.contract_type,
          page_size: 5,
        }),
        {
          method: "GET",
          cache: "no-store",
        },
      ),
    ]);

    if (!detailRes.ok || !entriesRes.ok) {
      return {
        ok: false,
        message:
          "Không thể tải lại sổ từ máy chủ để đối chiếu. Dữ liệu và Idempotency-Key vẫn được giữ nguyên; vui lòng thử tải lại sổ hoặc bấm Thử gửi lại yêu cầu này.",
      };
    }

    const [detailJson, entriesJson]: [unknown, unknown] = await Promise.all([
      detailRes.json().catch(() => null),
      entriesRes.json().catch(() => null),
    ]);
    const detailParsed = parseVendorDetailEnvelope(detailJson);
    const entriesParsed = parseVendorEntriesPageEnvelope(entriesJson);
    if (
      !detailParsed ||
      !entriesParsed ||
      detailParsed.vendor.vendor_id !== input.vendor_id ||
      entriesParsed.vendor_id !== input.vendor_id
    ) {
      return {
        ok: false,
        message:
          "Dữ liệu sổ tải về không hợp lệ nên chưa thể đối chiếu. Dữ liệu và Idempotency-Key vẫn được giữ nguyên.",
      };
    }

    const resolved = resolveActiveProjectSubLedgerForRecord({
      sub_ledgers: detailParsed.sub_ledgers,
      project_id: input.project_id,
      contract_type: input.contract_type,
      active_accountant_ref: input.active_accountant_ref,
    });

    return {
      ok: true,
      snapshot: {
        has_active_book: resolved.sub_ledger !== null,
        current_payable_minor: resolved.current_payable_minor,
        shared_advance_balance_minor: detailParsed.vendor.shared_advance_balance_minor,
        latest_entries: entriesParsed.entries.slice(0, 3),
      },
    };
  } catch {
    return {
      ok: false,
      message:
        "Mất kết nối mạng khi tải lại sổ để đối chiếu. Dữ liệu và Idempotency-Key vẫn được giữ nguyên; vui lòng thử tải lại sổ hoặc bấm Thử gửi lại yêu cầu này.",
    };
  }
}

/**
 * Unlocks `RecordVendorEntryDialog` to start a new request ONLY AFTER a ledger
 * reload has succeeded (`reconciled_snapshot !== null`) and been presented to
 * the user for reconciliation. If `reconciled_snapshot` is null, refuses to unlock
 * and preserves the locked payload and `idempotency_key`.
 */
export function unlockRecordEntryDialogAfterLedgerReconciliation(
  state: RecordEntryDialogDraftState,
  reconciled_snapshot: ReconciledLedgerSnapshotForAmbiguousRetry | null,
  defaults: Pick<
    RecordEntryDialogDraftState,
    "project_id" | "contract_type" | "entry_type" | "effective_date"
  >,
  nextIdempotencyKey: () => string = createClientIdempotencyKey,
): {
  unlocked: boolean;
  next_state: RecordEntryDialogDraftState;
} {
  if (!reconciled_snapshot) {
    return {
      unlocked: false,
      next_state: state,
    };
  }
  return {
    unlocked: true,
    next_state: {
      project_id: defaults.project_id,
      contract_type: defaults.contract_type,
      entry_type: defaults.entry_type,
      amount_input: "",
      offset_amount_input: "",
      effective_date: defaults.effective_date,
      reason: "",
      idempotency_key: nextIdempotencyKey(),
      ambiguous_retry_locked: false,
    },
  };
}
