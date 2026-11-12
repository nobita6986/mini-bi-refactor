/**
 * VFIN-01 — Canonical Backend/API Contract for Vendor Finance & Debt Management.
 *
 * Principles (docs/plans/vendor-finance-agent-ready-masterplan.md):
 *  - Whole VND stored as `bigint`; API boundary transports money ONLY as canonical
 *    decimal strings (`"0"`, `"1500000"`, `"-500000"`) to avoid `Number.MAX_SAFE_INTEGER` loss.
 *  - Server derives sign (`balance_delta_minor`), `balance_before_minor`, `balance_after_minor`,
 *    `vendor_sequence`, `document_no`, `vendor_display_name_snapshot`, `system_balance_minor`,
 *    `difference_minor`, and actor identity. Client-supplied authority or computed balance/doc
 *    fields are strictly rejected (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`).
 *  - Every response projection is FAIL-CLOSED (`null` on missing/extra/malformed fields) and
 *    never exposes `app_user_id`, `auth_subject`, email, `storage_key`, or raw SQL details.
 */

import { createHash } from "node:crypto";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";

export const VENDOR_FINANCE_CONTRACT_VERSION = "vendor-finance/1.0" as const;

export const VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI =
  "Chứng từ ghi nhận nội bộ trên hệ thống BI, không phải xác nhận giao dịch ngân hàng hoặc chứng minh tiền đã được chuyển." as const;

export const VENDOR_FINANCE_MAX_REASON_LENGTH = 4000;
export const VENDOR_FINANCE_MAX_SEARCH_LENGTH = 120;
export const VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS = 200;
export const VENDOR_FINANCE_EXPORT_ROW_CAP = 10_000;
export const VENDOR_FINANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB = 10_485_760
export const VENDOR_FINANCE_EVIDENCE_UPLOAD_URL_TTL_SECONDS = 300;
export const VENDOR_FINANCE_EVIDENCE_DOWNLOAD_URL_TTL_SECONDS = 120;

export const PG_BIGINT_MAX = BigInt("9223372036854775807");
export const PG_BIGINT_MIN = BigInt("-9223372036854775808");
const ZERO_BIGINT = BigInt(0);
const ONE_BIGINT = BigInt(1);

export const VENDOR_FINANCE_ENTRY_TYPES = [
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
] as const;

export type VendorFinanceEntryType = (typeof VENDOR_FINANCE_ENTRY_TYPES)[number];

export const VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPES = [
  "ADVANCE_FUNDED",
  "VENDOR_REFUND_RECORDED",
  "PROJECT_OFFSET_APPLIED",
  "REVERSAL",
] as const;

export type VendorFinanceSharedAdvanceMovementType =
  (typeof VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPES)[number];

export const NORMAL_SHARED_ADVANCE_MOVEMENT_TYPES = [
  "ADVANCE_FUNDED",
  "VENDOR_REFUND_RECORDED",
  "PROJECT_OFFSET_APPLIED",
] as const;

export type NormalSharedAdvanceMovementType =
  (typeof NORMAL_SHARED_ADVANCE_MOVEMENT_TYPES)[number];

export const NORMAL_VENDOR_FINANCE_ENTRY_TYPES = [
  "DEBT_RECORDED",
  "PAYROLL_RECORDED",
  "PAYMENT_RECORDED",
  "ADVANCE_RECORDED",
  "ADJUSTMENT_INCREASE",
  "ADJUSTMENT_DECREASE",
] as const;

export type NormalVendorFinanceEntryType = (typeof NORMAL_VENDOR_FINANCE_ENTRY_TYPES)[number];

export const OPENING_VENDOR_FINANCE_ENTRY_TYPES = [
  "OPENING_PAYABLE",
  "OPENING_ADVANCE",
] as const;

export type OpeningVendorFinanceEntryType = (typeof OPENING_VENDOR_FINANCE_ENTRY_TYPES)[number];

export const VENDOR_FINANCE_DOCUMENT_KINDS = [
  "PAYROLL_VOUCHER",
  "PAYMENT_VOUCHER",
  "ADVANCE_VOUCHER",
  "VENDOR_REFUND_VOUCHER",
  "ADVANCE_OFFSET_VOUCHER",
  "DEBT_ADJUSTMENT_VOUCHER",
  "OPENING_BALANCE_VOUCHER",
] as const;

export type VendorFinanceDocumentKind = (typeof VENDOR_FINANCE_DOCUMENT_KINDS)[number];

export const VENDOR_FINANCE_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const;

export type VendorFinanceEvidenceMimeType = (typeof VENDOR_FINANCE_EVIDENCE_MIME_TYPES)[number];

export const VENDOR_FINANCE_EVIDENCE_TARGET_KINDS = [
  "ENTRY",
  "RECONCILIATION",
] as const;

export type VendorFinanceEvidenceTargetKind = (typeof VENDOR_FINANCE_EVIDENCE_TARGET_KINDS)[number];

export type VendorFinanceBalanceDirection = "PAYABLE" | "BALANCED" | "ADVANCE";
export type VendorFinanceListBalanceDirection =
  | VendorFinanceBalanceDirection
  | "MULTI_LEDGER";
export type VendorFinanceActiveFilter = "all" | "active" | "inactive";
export type VendorFinanceBalanceFilter =
  | "all"
  | "payable"
  | "advance"
  | "nonzero"
  | "uninitialized";

export const VENDOR_FINANCE_LEDGER_SCOPES = [
  "PROJECT_ACCOUNTANT",
  "LEGACY_UNALLOCATED",
] as const;
export type VendorFinanceLedgerScope = (typeof VENDOR_FINANCE_LEDGER_SCOPES)[number];
export type VendorFinanceLedgerScopeFilter = "all" | VendorFinanceLedgerScope;

export const VENDOR_FINANCE_CONTRACT_TYPES = [
  "SEASONAL",
  "OFFICIAL",
  "UNCLASSIFIED",
] as const;
export type VendorFinanceContractType = (typeof VENDOR_FINANCE_CONTRACT_TYPES)[number];

export const CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES = [
  "SEASONAL",
  "OFFICIAL",
] as const;
export type ClassifiedVendorFinanceContractType =
  (typeof CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES)[number];
export type VendorFinanceClassifiedContractType = ClassifiedVendorFinanceContractType;

export const VENDOR_FINANCE_CONTRACT_TYPE_FILTERS = [
  "all",
  "SEASONAL",
  "OFFICIAL",
  "UNCLASSIFIED",
] as const;
export type VendorFinanceContractTypeFilter =
  (typeof VENDOR_FINANCE_CONTRACT_TYPE_FILTERS)[number];

export const VENDOR_FINANCE_VISIBILITY_SCOPES = [
  "ALL",
  "PROJECT_SCOPED",
  "NONE",
] as const;
export type VendorFinanceVisibilityScope = (typeof VENDOR_FINANCE_VISIBILITY_SCOPES)[number];

export const VENDOR_FINANCE_WRITE_SCOPES = [
  "ALL",
  "ASSIGNED_PROJECTS",
  "NONE",
] as const;
export type VendorFinanceWriteScope = (typeof VENDOR_FINANCE_WRITE_SCOPES)[number];

export const VENDOR_FINANCE_GLOBAL_ROLE_CODES = [
  "GLOBAL_VIEWER",
  "GLOBAL_RECONCILER",
  "CASH_HOLDER",
  "CASH_HOLDER_RECORD_BEHALF",
] as const;
export type VendorFinanceGlobalRoleCode = (typeof VENDOR_FINANCE_GLOBAL_ROLE_CODES)[number];

export const VENDOR_FINANCE_ADMIN_GRANT_STATES = [
  "ACTIVE",
  "SCHEDULED",
  "ENDED",
  "CANCELLED",
] as const;
export type VendorFinanceAdminGrantState = (typeof VENDOR_FINANCE_ADMIN_GRANT_STATES)[number];

export type VendorFinanceProjectRevenueStatus = "MISSING_CANONICAL_SOURCE";

export type VendorFinanceAuthoritySource =
  | "full_admin"
  | "accounting_department"
  | "direct_grant_record"
  | "direct_grant_view"
  | "cash_holder"
  | "cash_holder_record_behalf"
  | "global_reconciler"
  | "none";

export type VendorFinanceErrorCode =
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "CSRF_ORIGIN_DENIED"
  | "CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "REQUEST_BODY_TOO_LARGE"
  | "INVALID_JSON"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "VENDOR_FINANCE_ACCESS_DENIED"
  | "VENDOR_FINANCE_RECORD_DENIED"
  | "VENDOR_FINANCE_RECONCILE_DENIED"
  | "VENDOR_FINANCE_ADMIN_DENIED"
  | "VENDOR_FINANCE_PROJECT_ACCESS_DENIED"
  | "VENDOR_FINANCE_QUERY_INVALID"
  | "VENDOR_FINANCE_SEARCH_INVALID"
  | "VENDOR_FINANCE_CURSOR_INVALID"
  | "VENDOR_FINANCE_PAYLOAD_INVALID"
  | "VENDOR_FINANCE_PROJECT_INVALID"
  | "VENDOR_FINANCE_PROJECT_NOT_FOUND"
  | "VENDOR_FINANCE_PROJECT_INACTIVE"
  | "VENDOR_FINANCE_PROJECT_UNASSIGNED"
  | "VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE"
  | "VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED"
  | "VENDOR_FINANCE_PROJECT_ASSIGNMENT_OVERLAP"
  | "VENDOR_FINANCE_SUBLEDGER_NOT_FOUND"
  | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID"
  | "VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED"
  | "VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY"
  | "VENDOR_FINANCE_ASSIGNMENT_INVALID"
  | "VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND"
  | "VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT"
  | "VENDOR_FINANCE_GLOBAL_ROLE_INVALID"
  | "VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND"
  | "VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED"
  | "VENDOR_FINANCE_GLOBAL_ROLE_OVERLAP"
  | "VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT"
  | "VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE"
  | "VENDOR_FINANCE_VENDOR_INVALID"
  | "VENDOR_FINANCE_VENDOR_NOT_FOUND"
  | "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN"
  | "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED"
  | "VENDOR_FINANCE_ENTRY_INVALID"
  | "VENDOR_FINANCE_ENTRY_NOT_FOUND"
  | "VENDOR_FINANCE_ENTRY_TYPE_INVALID"
  | "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED"
  | "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID"
  | "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND"
  | "VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED"
  | "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE"
  | "VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE"
  | "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED"
  | "VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED"
  | "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL"
  | "VENDOR_FINANCE_AMOUNT_INVALID"
  | "VENDOR_FINANCE_AMOUNT_OVERFLOW"
  | "VENDOR_FINANCE_DATE_INVALID"
  | "VENDOR_FINANCE_REASON_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID"
  | "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR"
  | "VENDOR_FINANCE_OPENING_BATCH_EMPTY"
  | "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND"
  | "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT"
  | "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_NOT_FOUND"
  | "VENDOR_FINANCE_EVIDENCE_MIME_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID"
  | "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING"
  | "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"
  | "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED"
  | "VENDOR_FINANCE_STORAGE_UNAVAILABLE"
  | "VENDOR_FINANCE_UNAVAILABLE";

export function vendorFinanceHttpStatusForError(code: VendorFinanceErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_DENIED":
    case "VENDOR_FINANCE_ACCESS_DENIED":
    case "VENDOR_FINANCE_RECORD_DENIED":
    case "VENDOR_FINANCE_RECONCILE_DENIED":
    case "VENDOR_FINANCE_ADMIN_DENIED":
    case "VENDOR_FINANCE_PROJECT_ACCESS_DENIED":
      return 403;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "VENDOR_FINANCE_QUERY_INVALID":
    case "VENDOR_FINANCE_SEARCH_INVALID":
    case "VENDOR_FINANCE_CURSOR_INVALID":
    case "VENDOR_FINANCE_PROJECT_INVALID":
    case "VENDOR_FINANCE_VENDOR_INVALID":
    case "VENDOR_FINANCE_ENTRY_INVALID":
    case "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID":
      return 400;
    case "VENDOR_FINANCE_PROJECT_NOT_FOUND":
    case "VENDOR_FINANCE_SUBLEDGER_NOT_FOUND":
    case "VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND":
    case "VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND":
    case "VENDOR_FINANCE_VENDOR_NOT_FOUND":
    case "VENDOR_FINANCE_ENTRY_NOT_FOUND":
    case "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND":
    case "VENDOR_FINANCE_RECONCILIATION_NOT_FOUND":
    case "VENDOR_FINANCE_EVIDENCE_NOT_FOUND":
      return 404;
    case "VENDOR_FINANCE_PROJECT_UNASSIGNED":
    case "VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE":
    case "VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED":
    case "VENDOR_FINANCE_PROJECT_ASSIGNMENT_OVERLAP":
    case "VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT":
    case "VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED":
    case "VENDOR_FINANCE_GLOBAL_ROLE_OVERLAP":
    case "VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT":
    case "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN":
    case "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED":
    case "VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED":
    case "VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY":
    case "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED":
    case "VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED":
    case "VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED":
    case "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL":
    case "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT":
    case "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED":
    case "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED":
      return 409;
    case "REQUEST_BODY_TOO_LARGE":
      return 413;
    case "VENDOR_FINANCE_PAYLOAD_INVALID":
    case "VENDOR_FINANCE_PROJECT_INACTIVE":
    case "VENDOR_FINANCE_CONTRACT_TYPE_INVALID":
    case "VENDOR_FINANCE_ASSIGNMENT_INVALID":
    case "VENDOR_FINANCE_GLOBAL_ROLE_INVALID":
    case "VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE":
    case "VENDOR_FINANCE_ENTRY_TYPE_INVALID":
    case "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE":
    case "VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE":
    case "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED":
    case "VENDOR_FINANCE_AMOUNT_INVALID":
    case "VENDOR_FINANCE_AMOUNT_OVERFLOW":
    case "VENDOR_FINANCE_DATE_INVALID":
    case "VENDOR_FINANCE_REASON_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID":
    case "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR":
    case "VENDOR_FINANCE_OPENING_BATCH_EMPTY":
    case "VENDOR_FINANCE_EVIDENCE_MIME_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID":
    case "VENDOR_FINANCE_EVIDENCE_UPLOAD_MISSING":
      return 422;
    case "VENDOR_FINANCE_STORAGE_UNAVAILABLE":
    case "VENDOR_FINANCE_UNAVAILABLE":
      return 503;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VENDOR_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CALENDAR_MONTH_REGEX = /^([0-9]{4})-(0[1-9]|1[0-2])$/;
const DOCUMENT_NO_REGEX = /^VFIN-[0-9]{4}-[0-9]{6,}$/;
const POSITIVE_DECIMAL_REGEX = /^[1-9][0-9]{0,18}$/;
const SIGNED_DECIMAL_REGEX = /^-?(?:0|[1-9][0-9]{0,18})$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const FORBIDDEN_TEXT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

const FORBIDDEN_COMPUTED_FINANCE_FIELDS = new Set([
  "balancedelta",
  "balancedeltaminor",
  "balancebefore",
  "balancebeforeminor",
  "balanceafter",
  "balanceafterminor",
  "currentbalance",
  "currentbalanceminor",
  "documentno",
  "vendorsequence",
  "cursorsequence",
  "ledgercursorseq",
  "ledgerscope",
  "vendordisplaynamesnapshot",
  "projectdisplaynamesnapshot",
  "responsibleaccountantuserid",
  "responsibleaccountantdisplayname",
  "responsibleaccountantdisplaynamesnapshot",
  "systembalance",
  "systembalanceminor",
  "differenceminor",
  "ledgersequenceatreconciliation",
  "createdbydisplayname",
  "createdbydisplaynamesnapshot",
  "authoritysource",
  "storagekey",
  "openingbatchid",
  "reversesentryid",
  "classificationid",
  "sourcecontracttype",
  "classifiedentrycount",
  "classifiedreconciliationcount",
  "classifiedbydisplayname",
  "classifiedat",
  "sharedadvancebalanceminor",
  "sharedadvancebalance",
  "vendoradvancesequence",
  "movementcursorseq",
  "projectentryid",
  "reversesmovementid",
  "reversedbymovementid",
  "reversedbydocumentno",
  "canviewsharedadvance",
  "canfundvendoradvance",
  "canrecordvendorrefund",
  "canapplyvendoradvance",
  "canapplysharedadvance",
]);

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
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((k) => k in value) &&
    Object.keys(value).every((k) => allowed.has(k))
  );
}

function allowedKeysOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsForbiddenFinanceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenFinanceField(item, depth + 1));
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_COMPUTED_FINANCE_FIELDS.has(normalizeFieldKey(key))) {
      return true;
    }
    if (containsForbiddenFinanceField(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function checkForbiddenVendorFinanceClientFields(
  payload: unknown,
): { ok: true } | { ok: false; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" } {
  const baseCheck = validateClientBusinessPayload(payload);
  if (!baseCheck.ok) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (containsForbiddenFinanceField(payload)) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  return { ok: true };
}

export function isCanonicalVendorId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "__system_vendor__" &&
    VENDOR_ID_REGEX.test(value)
  );
}

export function isCanonicalProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_REGEX.test(value);
}

export function parseVendorIdParam(
  raw: unknown,
): { ok: true; vendor_id: string } | { ok: false; code: "VENDOR_FINANCE_VENDOR_INVALID" } {
  if (!isCanonicalVendorId(raw)) {
    return { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" };
  }
  return { ok: true, vendor_id: raw };
}

export function parseProjectIdParam(
  raw: unknown,
): { ok: true; project_id: string } | { ok: false; code: "VENDOR_FINANCE_PROJECT_INVALID" } {
  if (!isCanonicalProjectId(raw)) {
    return { ok: false, code: "VENDOR_FINANCE_PROJECT_INVALID" };
  }
  return { ok: true, project_id: raw };
}

export function parseCalendarMonthParam(
  raw: unknown,
): { ok: true; month: string } | { ok: false; code: "VENDOR_FINANCE_DATE_INVALID" } {
  if (typeof raw !== "string" || !CALENDAR_MONTH_REGEX.test(raw)) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  const year = Number(raw.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  return { ok: true, month: raw };
}

export function parseUuidParam<TCode extends VendorFinanceErrorCode>(
  raw: unknown,
  errorCode: TCode,
): { ok: true; id: string } | { ok: false; code: TCode } {
  if (typeof raw !== "string" || !UUID_REGEX.test(raw)) {
    return { ok: false, code: errorCode };
  }
  return { ok: true, id: raw.toLowerCase() };
}

/**
 * Parses a positive whole-VND decimal string (`"1"` .. `"9223372036854775807"`).
 * Rejects numbers/floats, `"0"`, negatives, leading `+` or `0`, scientific notation, and `bigint` overflow.
 */
export function parsePositiveMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_REGEX.test(value)) {
    // Distinguish pure positive integer strings with >= 19 digits that overflow int8.
    if (typeof value === "string" && /^[1-9][0-9]{19,}$/.test(value)) {
      return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
    }
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  const parsed = BigInt(value);
  if (parsed < ONE_BIGINT || parsed > PG_BIGINT_MAX) {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
  }
  return { ok: true, canonical: parsed.toString(), value: parsed };
}

/**
 * Parses a non-negative whole-VND decimal string (`"0"` .. `"9223372036854775807"`)
 * used ONLY by opening balance batch rows where `"0"` is skipped per §4.2.
 */
export function parseNonNegativeMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (value === "0") {
    return { ok: true, canonical: "0", value: ZERO_BIGINT };
  }
  return parsePositiveMinorAmount(value);
}

/**
 * Parses a signed whole-VND decimal string (`"-9223372036854775808"` .. `"9223372036854775807"`)
 * used for reconciliation `confirmed_balance_minor` and response projections.
 */
export function parseSignedMinorAmount(
  value: unknown,
):
  | { ok: true; canonical: string; value: bigint }
  | { ok: false; code: "VENDOR_FINANCE_AMOUNT_INVALID" | "VENDOR_FINANCE_AMOUNT_OVERFLOW" } {
  if (typeof value !== "string" || value === "-0") {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  if (!SIGNED_DECIMAL_REGEX.test(value)) {
    if (/^-?[1-9][0-9]{19,}$/.test(value)) {
      return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
    }
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_INVALID" };
  }
  const parsed = BigInt(value);
  if (parsed < PG_BIGINT_MIN || parsed > PG_BIGINT_MAX) {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
  }
  return { ok: true, canonical: parsed.toString(), value: parsed };
}

export function parseReasonText(
  value: unknown,
): { ok: true; reason: string } | { ok: false; code: "VENDOR_FINANCE_REASON_INVALID" } {
  if (typeof value !== "string") {
    return { ok: false, code: "VENDOR_FINANCE_REASON_INVALID" };
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > VENDOR_FINANCE_MAX_REASON_LENGTH ||
    FORBIDDEN_TEXT_CONTROL_CHARS.test(trimmed)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_REASON_INVALID" };
  }
  return { ok: true, reason: trimmed };
}

export function parseBusinessCalendarDate(
  value: unknown,
): { ok: true; date: string } | { ok: false; code: "VENDOR_FINANCE_DATE_INVALID" } {
  if (typeof value !== "string" || !isRealCalendarDate(value)) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  return { ok: true, date: value };
}

export function resolveIdempotencyKey(
  headerValue: string | null,
  bodyValue: unknown,
):
  | { ok: true; idempotency_key: string }
  | { ok: false; code: "IDEMPOTENCY_KEY_INVALID" | "IDEMPOTENCY_KEY_MISMATCH" } {
  if (typeof bodyValue !== "string" || !UUID_REGEX.test(bodyValue)) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  const normalizedBody = bodyValue.toLowerCase();
  if (headerValue !== null) {
    const trimmedHeader = headerValue.trim();
    if (!UUID_REGEX.test(trimmedHeader)) {
      return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
    }
    if (trimmedHeader.toLowerCase() !== normalizedBody) {
      return { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" };
    }
  }
  return { ok: true, idempotency_key: normalizedBody };
}

// -----------------------------------------------------------------------------
// Keyset cursor codec (`GET /api/vendor-finance/vendors/[vendorId]/entries`)
// -----------------------------------------------------------------------------
export type VendorEntriesCursorScope = {
  project_id?: string | null;
  accountant_ref?: string | null;
  ledger_scope?: VendorFinanceLedgerScope | null;
  contract_type?: VendorFinanceContractType | null;
  month?: string | null;
};

export function encodeVendorEntriesCursor(input: {
  vendor_id: string;
  before_sequence: number;
  project_id?: string | null;
  accountant_ref?: string | null;
  ledger_scope?: VendorFinanceLedgerScope | null;
  contract_type?: VendorFinanceContractType | null;
  month?: string | null;
}): string {
  const payload = JSON.stringify({
    v: 2,
    vendor_id: input.vendor_id,
    before_sequence: input.before_sequence,
    project_id: input.project_id ?? null,
    accountant_ref: input.accountant_ref ? input.accountant_ref.toLowerCase() : null,
    ledger_scope: input.ledger_scope ?? null,
    contract_type: input.contract_type ?? null,
    month: input.month ?? null,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeVendorEntriesCursor(
  rawCursor: string,
  expectedVendorId: string,
  expectedScope?: VendorEntriesCursorScope,
):
  | { ok: true; before_sequence: number }
  | { ok: false; code: "VENDOR_FINANCE_CURSOR_INVALID" } {
  if (
    typeof rawCursor !== "string" ||
    rawCursor.length < 4 ||
    rawCursor.length > 768 ||
    !/^[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
  try {
    const decodedText = Buffer.from(rawCursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decodedText);
    const expProjectId = expectedScope?.project_id ?? null;
    const expAccountantRef = expectedScope?.accountant_ref
      ? expectedScope.accountant_ref.toLowerCase()
      : null;
    const expLedgerScope = expectedScope?.ledger_scope ?? null;
    const expContractType = expectedScope?.contract_type ?? null;
    const expMonth = expectedScope?.month ?? null;

    if (
      !isRecord(parsed) ||
      !exactKeys(parsed, [
        "v",
        "vendor_id",
        "before_sequence",
        "project_id",
        "accountant_ref",
        "ledger_scope",
        "contract_type",
        "month",
      ]) ||
      parsed.v !== 2 ||
      parsed.vendor_id !== expectedVendorId ||
      parsed.project_id !== expProjectId ||
      parsed.accountant_ref !== expAccountantRef ||
      parsed.ledger_scope !== expLedgerScope ||
      parsed.contract_type !== expContractType ||
      parsed.month !== expMonth ||
      typeof parsed.before_sequence !== "number" ||
      !Number.isSafeInteger(parsed.before_sequence) ||
      parsed.before_sequence < 1
    ) {
      return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
    }
    return { ok: true, before_sequence: parsed.before_sequence };
  } catch {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
}

export function encodeSharedAdvanceMovementsCursor(input: {
  vendor_id: string;
  before_sequence: number;
  movement_type?: VendorFinanceSharedAdvanceMovementType | null;
}): string {
  const payload = JSON.stringify({
    v: 1,
    kind: "shared_advance",
    vendor_id: input.vendor_id,
    before_sequence: input.before_sequence,
    movement_type: input.movement_type ?? null,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeSharedAdvanceMovementsCursor(
  rawCursor: string,
  expectedVendorId: string,
  expectedMovementType?: VendorFinanceSharedAdvanceMovementType | null,
):
  | { ok: true; before_sequence: number }
  | { ok: false; code: "VENDOR_FINANCE_CURSOR_INVALID" } {
  if (
    typeof rawCursor !== "string" ||
    rawCursor.length < 4 ||
    rawCursor.length > 768 ||
    !/^[A-Za-z0-9_-]+$/.test(rawCursor)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
  try {
    const decodedText = Buffer.from(rawCursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decodedText);
    const expMovType = expectedMovementType ?? null;
    if (
      !isRecord(parsed) ||
      !exactKeys(parsed, [
        "v",
        "kind",
        "vendor_id",
        "before_sequence",
        "movement_type",
      ]) ||
      parsed.v !== 1 ||
      parsed.kind !== "shared_advance" ||
      parsed.vendor_id !== expectedVendorId ||
      parsed.movement_type !== expMovType ||
      typeof parsed.before_sequence !== "number" ||
      !Number.isSafeInteger(parsed.before_sequence) ||
      parsed.before_sequence < 1
    ) {
      return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
    }
    return { ok: true, before_sequence: parsed.before_sequence };
  } catch {
    return { ok: false, code: "VENDOR_FINANCE_CURSOR_INVALID" };
  }
}

// -----------------------------------------------------------------------------
// Query & Mutation Request Parsers
// -----------------------------------------------------------------------------
function parseUniqueAllowedQueryKeys(
  url: URL,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set<string>(allowedKeys);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
    if (url.searchParams.getAll(key).length > 1) {
      return false;
    }
  }
  return true;
}

function parseOptionalSearchQuery(
  url: URL,
): { ok: true; search: string | null } | { ok: false; code: "VENDOR_FINANCE_SEARCH_INVALID" } {
  const rawSearch = url.searchParams.get("search");
  if (rawSearch === null) return { ok: true, search: null };
  const trimmed = rawSearch.trim();
  if (trimmed.length === 0) return { ok: true, search: null };
  if (
    trimmed.length > VENDOR_FINANCE_MAX_SEARCH_LENGTH ||
    FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(trimmed)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_SEARCH_INVALID" };
  }
  return { ok: true, search: trimmed };
}

function parseOptionalProjectQuery(
  url: URL,
): { ok: true; project_id: string | null } | { ok: false; code: "VENDOR_FINANCE_PROJECT_INVALID" } {
  const raw = url.searchParams.get("project_id");
  if (raw === null || raw === "") return { ok: true, project_id: null };
  const parsed = parseProjectIdParam(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, project_id: parsed.project_id };
}

function parseOptionalAccountantRefQuery(
  url: URL,
): { ok: true; accountant_ref: string | null } | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" } {
  const raw = url.searchParams.get("accountant_ref");
  if (raw === null || raw === "") return { ok: true, accountant_ref: null };
  if (!UUID_REGEX.test(raw)) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return { ok: true, accountant_ref: raw.toLowerCase() };
}

function parseOptionalLedgerScopeQuery(
  url: URL,
  allowAll: boolean,
):
  | { ok: true; ledger_scope: VendorFinanceLedgerScope | null; filter: VendorFinanceLedgerScopeFilter }
  | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" } {
  const raw = url.searchParams.get("ledger_scope");
  if (raw === null || raw === "") {
    return { ok: true, ledger_scope: null, filter: "all" };
  }
  if (allowAll && raw === "all") {
    return { ok: true, ledger_scope: null, filter: "all" };
  }
  if ((VENDOR_FINANCE_LEDGER_SCOPES as readonly string[]).includes(raw)) {
    const scope = raw as VendorFinanceLedgerScope;
    return { ok: true, ledger_scope: scope, filter: scope };
  }
  return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
}

function parseOptionalContractTypeFilterQuery(
  url: URL,
):
  | { ok: true; contract_type: VendorFinanceContractTypeFilter }
  | { ok: false; code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" } {
  const raw = url.searchParams.get("contract_type");
  if (raw === null || raw === "") {
    return { ok: true, contract_type: "all" };
  }
  if ((VENDOR_FINANCE_CONTRACT_TYPE_FILTERS as readonly string[]).includes(raw)) {
    return { ok: true, contract_type: raw as VendorFinanceContractTypeFilter };
  }
  return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
}

function parseOptionalSubLedgerContractTypeQuery(
  url: URL,
):
  | { ok: true; contract_type: VendorFinanceContractType | null }
  | { ok: false; code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" } {
  const raw = url.searchParams.get("contract_type");
  if (raw === null || raw === "") {
    return { ok: true, contract_type: null };
  }
  if ((VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(raw)) {
    return { ok: true, contract_type: raw as VendorFinanceContractType };
  }
  return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
}

export type ListVendorFinanceVendorsQuery = {
  search: string | null;
  active: VendorFinanceActiveFilter;
  balance_filter: VendorFinanceBalanceFilter;
  project_id: string | null;
  accountant_ref: string | null;
  ledger_scope: VendorFinanceLedgerScope | null;
  contract_type: VendorFinanceContractTypeFilter;
  page: number;
  page_size: number;
};

const LIST_VENDORS_QUERY_KEYS = [
  "search",
  "active",
  "balance_filter",
  "project_id",
  "accountant_ref",
  "ledger_scope",
  "contract_type",
  "page",
  "page_size",
] as const;

function parseBoundedIntParam(
  raw: string | null,
  defaultValue: number,
  min: number,
  max: number,
): number | null {
  if (raw === null) return defaultValue;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function parseListVendorFinanceVendorsQuery(
  url: URL,
):
  | { ok: true; value: ListVendorFinanceVendorsQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_SEARCH_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  if (!parseUniqueAllowedQueryKeys(url, LIST_VENDORS_QUERY_KEYS)) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const searchRes = parseOptionalSearchQuery(url);
  if (!searchRes.ok) return searchRes;

  const rawActive = url.searchParams.get("active") ?? "all";
  if (rawActive !== "all" && rawActive !== "active" && rawActive !== "inactive") {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const rawBalance = url.searchParams.get("balance_filter") ?? "all";
  if (
    rawBalance !== "all" &&
    rawBalance !== "payable" &&
    rawBalance !== "advance" &&
    rawBalance !== "nonzero" &&
    rawBalance !== "uninitialized"
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;

  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;

  const scopeRes = parseOptionalLedgerScopeQuery(url, true);
  if (!scopeRes.ok) return scopeRes;

  const contractTypeRes = parseOptionalContractTypeFilterQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;

  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      search: searchRes.search,
      active: rawActive,
      balance_filter: rawBalance,
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
      page,
      page_size: pageSize,
    },
  };
}

export type ExportVendorFinanceVendorsQuery = {
  search: string | null;
  active: VendorFinanceActiveFilter;
  balance_filter: VendorFinanceBalanceFilter;
  project_id: string | null;
  accountant_ref: string | null;
  ledger_scope: VendorFinanceLedgerScope | null;
  contract_type: VendorFinanceContractTypeFilter;
};

const EXPORT_VENDORS_QUERY_KEYS = [
  "search",
  "active",
  "balance_filter",
  "project_id",
  "accountant_ref",
  "ledger_scope",
  "contract_type",
] as const;

export function parseExportVendorFinanceVendorsQuery(
  url: URL,
):
  | { ok: true; value: ExportVendorFinanceVendorsQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_SEARCH_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  if (!parseUniqueAllowedQueryKeys(url, EXPORT_VENDORS_QUERY_KEYS)) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const searchRes = parseOptionalSearchQuery(url);
  if (!searchRes.ok) return searchRes;

  const rawActive = url.searchParams.get("active") ?? "all";
  if (rawActive !== "all" && rawActive !== "active" && rawActive !== "inactive") {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const rawBalance = url.searchParams.get("balance_filter") ?? "all";
  if (
    rawBalance !== "all" &&
    rawBalance !== "payable" &&
    rawBalance !== "advance" &&
    rawBalance !== "nonzero" &&
    rawBalance !== "uninitialized"
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;

  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;

  const scopeRes = parseOptionalLedgerScopeQuery(url, true);
  if (!scopeRes.ok) return scopeRes;

  const contractTypeRes = parseOptionalContractTypeFilterQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;

  return {
    ok: true,
    value: {
      search: searchRes.search,
      active: rawActive,
      balance_filter: rawBalance,
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
    },
  };
}

export function parseExportVendorFinanceVendorsBody(
  body: unknown,
):
  | { ok: true; value: ExportVendorFinanceVendorsQuery }
  | {
      ok: false;
      code:
        | "CLIENT_AUTHORITY_FIELD_FORBIDDEN"
        | "VENDOR_FINANCE_PAYLOAD_INVALID"
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_SEARCH_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (!isRecord(body) || !allowedKeysOnly(body, EXPORT_VENDORS_QUERY_KEYS)) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  let search: string | null = null;
  if (body.search !== undefined && body.search !== null) {
    if (typeof body.search !== "string") {
      return { ok: false, code: "VENDOR_FINANCE_SEARCH_INVALID" };
    }
    const trimmed = body.search.trim();
    if (trimmed.length > 0) {
      if (
        trimmed.length > VENDOR_FINANCE_MAX_SEARCH_LENGTH ||
        FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(trimmed)
      ) {
        return { ok: false, code: "VENDOR_FINANCE_SEARCH_INVALID" };
      }
      search = trimmed;
    }
  }

  const rawActive = body.active ?? "all";
  if (rawActive !== "all" && rawActive !== "active" && rawActive !== "inactive") {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const rawBalance = body.balance_filter ?? "all";
  if (
    rawBalance !== "all" &&
    rawBalance !== "payable" &&
    rawBalance !== "advance" &&
    rawBalance !== "nonzero" &&
    rawBalance !== "uninitialized"
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  let projectId: string | null = null;
  if (body.project_id !== undefined && body.project_id !== null && body.project_id !== "") {
    const parsedProject = parseProjectIdParam(body.project_id);
    if (!parsedProject.ok) return parsedProject;
    projectId = parsedProject.project_id;
  }

  let accountantRef: string | null = null;
  if (
    body.accountant_ref !== undefined &&
    body.accountant_ref !== null &&
    body.accountant_ref !== ""
  ) {
    if (typeof body.accountant_ref !== "string" || !UUID_REGEX.test(body.accountant_ref)) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
    accountantRef = body.accountant_ref.toLowerCase();
  }

  let ledgerScope: VendorFinanceLedgerScope | null = null;
  if (
    body.ledger_scope !== undefined &&
    body.ledger_scope !== null &&
    body.ledger_scope !== "" &&
    body.ledger_scope !== "all"
  ) {
    if (
      typeof body.ledger_scope !== "string" ||
      !(VENDOR_FINANCE_LEDGER_SCOPES as readonly string[]).includes(body.ledger_scope)
    ) {
      return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
    }
    ledgerScope = body.ledger_scope as VendorFinanceLedgerScope;
  }

  let contractType: VendorFinanceContractTypeFilter = "all";
  if (
    body.contract_type !== undefined &&
    body.contract_type !== null &&
    body.contract_type !== ""
  ) {
    if (
      typeof body.contract_type !== "string" ||
      !(VENDOR_FINANCE_CONTRACT_TYPE_FILTERS as readonly string[]).includes(
        body.contract_type,
      )
    ) {
      return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
    }
    contractType = body.contract_type as VendorFinanceContractTypeFilter;
  }

  return {
    ok: true,
    value: {
      search,
      active: rawActive,
      balance_filter: rawBalance,
      project_id: projectId,
      accountant_ref: accountantRef,
      ledger_scope: ledgerScope,
      contract_type: contractType,
    },
  };
}

export function parseNoQueryParams(
  url: URL,
): { ok: true } | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" } {
  for (const _key of url.searchParams.keys()) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return { ok: true };
}

export type GetVendorFinanceVendorDetailQuery = {
  project_id: string | null;
  accountant_ref: string | null;
  ledger_scope: VendorFinanceLedgerScope | null;
  contract_type: VendorFinanceContractType | null;
};

export function parseGetVendorFinanceVendorDetailQuery(
  url: URL,
):
  | { ok: true; value: GetVendorFinanceVendorDetailQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  if (
    !parseUniqueAllowedQueryKeys(url, [
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;
  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;
  const scopeRes = parseOptionalLedgerScopeQuery(url, false);
  if (!scopeRes.ok) return scopeRes;
  const contractTypeRes = parseOptionalSubLedgerContractTypeQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;
  if (
    scopeRes.ledger_scope === "LEGACY_UNALLOCATED" &&
    (projectRes.project_id !== null ||
      accountantRes.accountant_ref !== null ||
      (contractTypeRes.contract_type !== null &&
        contractTypeRes.contract_type !== "UNCLASSIFIED"))
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return {
    ok: true,
    value: {
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
    },
  };
}

export type ListVendorFinanceEntriesQuery = {
  before_sequence: number | null;
  entry_type: VendorFinanceEntryType | null;
  page_size: number;
  project_id: string | null;
  accountant_ref: string | null;
  ledger_scope: VendorFinanceLedgerScope | null;
  contract_type: VendorFinanceContractType | null;
  month: string | null;
};

export function parseListVendorFinanceEntriesQuery(
  url: URL,
  vendorId: string,
):
  | { ok: true; value: ListVendorFinanceEntriesQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_CURSOR_INVALID"
        | "VENDOR_FINANCE_ENTRY_TYPE_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID"
        | "VENDOR_FINANCE_DATE_INVALID";
    } {
  if (
    !parseUniqueAllowedQueryKeys(url, [
      "cursor",
      "entry_type",
      "page_size",
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
      "month",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;
  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;
  const scopeRes = parseOptionalLedgerScopeQuery(url, false);
  if (!scopeRes.ok) return scopeRes;
  const contractTypeRes = parseOptionalSubLedgerContractTypeQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;
  if (
    scopeRes.ledger_scope === "LEGACY_UNALLOCATED" &&
    (projectRes.project_id !== null ||
      accountantRes.accountant_ref !== null ||
      (contractTypeRes.contract_type !== null &&
        contractTypeRes.contract_type !== "UNCLASSIFIED"))
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  let month: string | null = null;
  const rawMonth = url.searchParams.get("month");
  if (rawMonth !== null && rawMonth !== "") {
    const parsedMonth = parseCalendarMonthParam(rawMonth);
    if (!parsedMonth.ok) return parsedMonth;
    month = parsedMonth.month;
  }

  let beforeSequence: number | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    const decoded = decodeVendorEntriesCursor(rawCursor, vendorId, {
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
      month,
    });
    if (!decoded.ok) return decoded;
    beforeSequence = decoded.before_sequence;
  }

  let entryType: VendorFinanceEntryType | null = null;
  const rawEntryType = url.searchParams.get("entry_type");
  if (rawEntryType !== null && rawEntryType !== "") {
    if (!(VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawEntryType)) {
      return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
    }
    entryType = rawEntryType as VendorFinanceEntryType;
  }

  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      before_sequence: beforeSequence,
      entry_type: entryType,
      page_size: pageSize,
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
      month,
    },
  };
}

export type ListSharedAdvanceMovementsQuery = {
  before_sequence: number | null;
  movement_type: VendorFinanceSharedAdvanceMovementType | null;
  page_size: number;
};

export function parseListSharedAdvanceMovementsQuery(
  url: URL,
  vendorId: string,
):
  | { ok: true; value: ListSharedAdvanceMovementsQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_CURSOR_INVALID"
        | "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID";
    } {
  if (!parseUniqueAllowedQueryKeys(url, ["cursor", "movement_type", "page_size"])) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  let movementType: VendorFinanceSharedAdvanceMovementType | null = null;
  const rawMovementType = url.searchParams.get("movement_type");
  if (rawMovementType !== null && rawMovementType !== "") {
    if (
      !(VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPES as readonly string[]).includes(
        rawMovementType,
      )
    ) {
      return { ok: false, code: "VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID" };
    }
    movementType = rawMovementType as VendorFinanceSharedAdvanceMovementType;
  }

  let beforeSequence: number | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor !== "") {
    const decoded = decodeSharedAdvanceMovementsCursor(
      rawCursor,
      vendorId,
      movementType,
    );
    if (!decoded.ok) return decoded;
    beforeSequence = decoded.before_sequence;
  }

  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      before_sequence: beforeSequence,
      movement_type: movementType,
      page_size: pageSize,
    },
  };
}

export type ListVendorReconciliationsQuery = {
  page: number;
  page_size: number;
  project_id: string | null;
  accountant_ref: string | null;
  ledger_scope: VendorFinanceLedgerScope | null;
  contract_type: VendorFinanceContractType | null;
};

export function parseListVendorReconciliationsQuery(
  url: URL,
):
  | { ok: true; value: ListVendorReconciliationsQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  if (
    !parseUniqueAllowedQueryKeys(url, [
      "page",
      "page_size",
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;
  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;
  const scopeRes = parseOptionalLedgerScopeQuery(url, false);
  if (!scopeRes.ok) return scopeRes;
  const contractTypeRes = parseOptionalSubLedgerContractTypeQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;
  if (
    scopeRes.ledger_scope === "LEGACY_UNALLOCATED" &&
    (projectRes.project_id !== null ||
      accountantRes.accountant_ref !== null ||
      (contractTypeRes.contract_type !== null &&
        contractTypeRes.contract_type !== "UNCLASSIFIED"))
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return {
    ok: true,
    value: {
      page,
      page_size: pageSize,
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      ledger_scope: scopeRes.ledger_scope,
      contract_type: contractTypeRes.contract_type,
    },
  };
}

export type MonthlyVendorFinanceReportQuery = {
  month: string;
  project_id: string | null;
  accountant_ref: string | null;
  vendor_id: string | null;
  contract_type: VendorFinanceContractTypeFilter;
};

export function parseMonthlyReportQuery(
  url: URL,
):
  | { ok: true; value: MonthlyVendorFinanceReportQuery }
  | {
      ok: false;
      code:
        | "VENDOR_FINANCE_QUERY_INVALID"
        | "VENDOR_FINANCE_DATE_INVALID"
        | "VENDOR_FINANCE_PROJECT_INVALID"
        | "VENDOR_FINANCE_VENDOR_INVALID"
        | "VENDOR_FINANCE_CONTRACT_TYPE_INVALID";
    } {
  if (
    !parseUniqueAllowedQueryKeys(url, [
      "month",
      "project_id",
      "accountant_ref",
      "vendor_id",
      "contract_type",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const rawMonth = url.searchParams.get("month");
  if (rawMonth === null || rawMonth === "") {
    return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
  }
  const monthRes = parseCalendarMonthParam(rawMonth);
  if (!monthRes.ok) return monthRes;

  const projectRes = parseOptionalProjectQuery(url);
  if (!projectRes.ok) return projectRes;

  const accountantRes = parseOptionalAccountantRefQuery(url);
  if (!accountantRes.ok) return accountantRes;

  let vendorId: string | null = null;
  const rawVendor = url.searchParams.get("vendor_id");
  if (rawVendor !== null && rawVendor !== "") {
    const parsedVendor = parseVendorIdParam(rawVendor);
    if (!parsedVendor.ok) return parsedVendor;
    vendorId = parsedVendor.vendor_id;
  }

  const contractTypeRes = parseOptionalContractTypeFilterQuery(url);
  if (!contractTypeRes.ok) return contractTypeRes;

  return {
    ok: true,
    value: {
      month: monthRes.month,
      project_id: projectRes.project_id,
      accountant_ref: accountantRes.accountant_ref,
      vendor_id: vendorId,
      contract_type: contractTypeRes.contract_type,
    },
  };
}

function parseOptionalBoolQuery(raw: string | null, defaultValue: boolean): boolean | null {
  if (raw === null || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export type ListProjectAccountantsAdminQuery = {
  search: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export function parseListProjectAccountantsAdminQuery(
  url: URL,
):
  | { ok: true; value: ListProjectAccountantsAdminQuery }
  | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" | "VENDOR_FINANCE_SEARCH_INVALID" } {
  if (!parseUniqueAllowedQueryKeys(url, ["search", "include_history", "page", "page_size"])) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const searchRes = parseOptionalSearchQuery(url);
  if (!searchRes.ok) return searchRes;
  const includeHistory = parseOptionalBoolQuery(url.searchParams.get("include_history"), true);
  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (includeHistory === null || page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return {
    ok: true,
    value: {
      search: searchRes.search,
      include_history: includeHistory,
      page,
      page_size: pageSize,
    },
  };
}

export type ListGlobalRolesAdminQuery = {
  search: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export function parseListGlobalRolesAdminQuery(
  url: URL,
):
  | { ok: true; value: ListGlobalRolesAdminQuery }
  | { ok: false; code: "VENDOR_FINANCE_QUERY_INVALID" | "VENDOR_FINANCE_SEARCH_INVALID" } {
  if (!parseUniqueAllowedQueryKeys(url, ["search", "include_history", "page", "page_size"])) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  const searchRes = parseOptionalSearchQuery(url);
  if (!searchRes.ok) return searchRes;
  const includeHistory = parseOptionalBoolQuery(url.searchParams.get("include_history"), true);
  const page = parseBoundedIntParam(url.searchParams.get("page"), 1, 1, 1000);
  const pageSize = parseBoundedIntParam(url.searchParams.get("page_size"), 25, 1, 100);
  if (includeHistory === null || page === null || pageSize === null) {
    return { ok: false, code: "VENDOR_FINANCE_QUERY_INVALID" };
  }
  return {
    ok: true,
    value: {
      search: searchRes.search,
      include_history: includeHistory,
      page,
      page_size: pageSize,
    },
  };
}

// 1. Record Normal Entry (`POST /api/vendor-finance/vendors/[vendorId]/entries`)
export type RecordVendorFinanceEntryBody = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  entry_type: NormalVendorFinanceEntryType;
  amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseRecordVendorFinanceEntryBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: RecordVendorFinanceEntryBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "project_id",
      "contract_type",
      "entry_type",
      "amount_minor",
      "effective_date",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (
    typeof body.contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  if (
    typeof body.entry_type !== "string" ||
    !(NORMAL_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(body.entry_type)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
  }

  const amount = parsePositiveMinorAmount(body.amount_minor);
  if (!amount.ok) return amount;

  const effectiveDate = parseBusinessCalendarDate(body.effective_date);
  if (!effectiveDate.ok) return effectiveDate;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      contract_type: body.contract_type as ClassifiedVendorFinanceContractType,
      entry_type: body.entry_type as NormalVendorFinanceEntryType,
      amount_minor: amount.canonical,
      effective_date: effectiveDate.date,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 2. Reverse Entry (`POST /api/vendor-finance/entries/[entryId]/reverse`)
export type ReverseVendorFinanceEntryBody = {
  effective_date: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseReverseVendorFinanceEntryBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ReverseVendorFinanceEntryBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, ["effective_date", "reason", "idempotency_key"]) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  let effectiveDate: string | null = null;
  if (body.effective_date !== undefined && body.effective_date !== null) {
    const parsedDate = parseBusinessCalendarDate(body.effective_date);
    if (!parsedDate.ok) return parsedDate;
    effectiveDate = parsedDate.date;
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      effective_date: effectiveDate,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 3. Opening Balance Preview & Apply (`POST /api/vendor-finance/opening-batches/preview` & `/apply`)
export type OpeningBatchItemInput = {
  vendor_id: string;
  entry_type: OpeningVendorFinanceEntryType;
  amount_minor: string;
};

export type PreviewOpeningBatchBody = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
};

export type ApplyOpeningBatchBody = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
  reason: string;
  idempotency_key: string;
};

function parseOpeningBatchItems(
  rawItems: unknown,
):
  | { ok: true; items: OpeningBatchItemInput[] }
  | { ok: false; code: VendorFinanceErrorCode } {
  if (!Array.isArray(rawItems)) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_INVALID" };
  }
  if (rawItems.length < 1 || rawItems.length > VENDOR_FINANCE_MAX_OPENING_BATCH_ITEMS) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID" };
  }

  const seenVendors = new Set<string>();
  const items: OpeningBatchItemInput[] = [];
  let nonZeroCount = 0;

  for (const rawItem of rawItems) {
    if (!isRecord(rawItem) || !exactKeys(rawItem, ["vendor_id", "entry_type", "amount_minor"])) {
      return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_INVALID" };
    }
    if (!isCanonicalVendorId(rawItem.vendor_id)) {
      return { ok: false, code: "VENDOR_FINANCE_VENDOR_INVALID" };
    }
    if (seenVendors.has(rawItem.vendor_id)) {
      return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR" };
    }
    seenVendors.add(rawItem.vendor_id);

    if (
      typeof rawItem.entry_type !== "string" ||
      !(OPENING_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawItem.entry_type)
    ) {
      return { ok: false, code: "VENDOR_FINANCE_ENTRY_TYPE_INVALID" };
    }

    const amount = parseNonNegativeMinorAmount(rawItem.amount_minor);
    if (!amount.ok) return amount;
    if (amount.value > ZERO_BIGINT) {
      nonZeroCount += 1;
    }

    items.push({
      vendor_id: rawItem.vendor_id,
      entry_type: rawItem.entry_type as OpeningVendorFinanceEntryType,
      amount_minor: amount.canonical,
    });
  }

  if (nonZeroCount === 0) {
    return { ok: false, code: "VENDOR_FINANCE_OPENING_BATCH_EMPTY" };
  }

  return { ok: true, items };
}

export function parsePreviewOpeningBatchBody(
  body: unknown,
):
  | { ok: true; value: PreviewOpeningBatchBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, ["project_id", "contract_type", "cutoff_date", "items"])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (
    typeof body.contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const cutoffDate = parseBusinessCalendarDate(body.cutoff_date);
  if (!cutoffDate.ok) return cutoffDate;

  const items = parseOpeningBatchItems(body.items);
  if (!items.ok) return items;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      contract_type: body.contract_type as ClassifiedVendorFinanceContractType,
      cutoff_date: cutoffDate.date,
      items: items.items,
    },
  };
}

export function parseApplyOpeningBatchBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ApplyOpeningBatchBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "project_id",
      "contract_type",
      "cutoff_date",
      "items",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (
    typeof body.contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const cutoffDate = parseBusinessCalendarDate(body.cutoff_date);
  if (!cutoffDate.ok) return cutoffDate;

  const items = parseOpeningBatchItems(body.items);
  if (!items.ok) return items;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      contract_type: body.contract_type as ClassifiedVendorFinanceContractType,
      cutoff_date: cutoffDate.date,
      items: items.items,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 4. Create Reconciliation (`POST /api/vendor-finance/vendors/[vendorId]/reconciliations`)
export type CreateVendorReconciliationBody = {
  project_id: string;
  accountant_ref: string | null;
  contract_type: VendorFinanceContractType;
  as_of_date: string;
  confirmed_balance_minor: string;
  reason: string;
  idempotency_key: string;
};

export function parseCreateVendorReconciliationBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: CreateVendorReconciliationBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, [
      "project_id",
      "accountant_ref",
      "contract_type",
      "as_of_date",
      "confirmed_balance_minor",
      "reason",
      "idempotency_key",
    ]) ||
    !("project_id" in body) ||
    !("contract_type" in body) ||
    !("as_of_date" in body) ||
    !("confirmed_balance_minor" in body) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  let accountantRef: string | null = null;
  if (body.accountant_ref !== undefined && body.accountant_ref !== null) {
    if (typeof body.accountant_ref !== "string" || !UUID_REGEX.test(body.accountant_ref)) {
      return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
    }
    accountantRef = body.accountant_ref.toLowerCase();
  }

  if (
    typeof body.contract_type !== "string" ||
    !(VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(body.contract_type)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const asOfDate = parseBusinessCalendarDate(body.as_of_date);
  if (!asOfDate.ok) return asOfDate;

  const confirmed = parseSignedMinorAmount(body.confirmed_balance_minor);
  if (!confirmed.ok) return confirmed;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      accountant_ref: accountantRef,
      contract_type: body.contract_type as VendorFinanceContractType,
      as_of_date: asOfDate.date,
      confirmed_balance_minor: confirmed.canonical,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 4b. Classify Unclassified Sub-Ledger (`POST /api/vendor-finance/vendors/[vendorId]/classify-contract-type`)
export type ClassifyVendorSubLedgerBody = {
  project_id: string;
  accountant_ref: string | null;
  target_contract_type: ClassifiedVendorFinanceContractType;
  reason: string;
  idempotency_key: string;
};

export function parseClassifyVendorSubLedgerBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ClassifyVendorSubLedgerBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, [
      "project_id",
      "accountant_ref",
      "target_contract_type",
      "reason",
      "idempotency_key",
    ]) ||
    !("project_id" in body) ||
    !("target_contract_type" in body) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  let accountantRef: string | null = null;
  if (body.accountant_ref !== undefined && body.accountant_ref !== null) {
    if (typeof body.accountant_ref !== "string" || !UUID_REGEX.test(body.accountant_ref)) {
      return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
    }
    accountantRef = body.accountant_ref.toLowerCase();
  }

  if (
    typeof body.target_contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.target_contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      accountant_ref: accountantRef,
      target_contract_type: body.target_contract_type as ClassifiedVendorFinanceContractType,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// 5. Evidence Reserve & Finalize (`POST /api/vendor-finance/evidence/reserve` & `/finalize`)
export type ReserveVendorFinanceEvidenceBody = {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  idempotency_key: string;
};

export function parseReserveVendorFinanceEvidenceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ReserveVendorFinanceEvidenceBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "target_kind",
      "target_id",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  if (
    typeof body.target_kind !== "string" ||
    !(VENDOR_FINANCE_EVIDENCE_TARGET_KINDS as readonly string[]).includes(body.target_kind) ||
    typeof body.target_id !== "string" ||
    !UUID_REGEX.test(body.target_id)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_TARGET_INVALID" };
  }

  if (
    typeof body.mime_type !== "string" ||
    !(VENDOR_FINANCE_EVIDENCE_MIME_TYPES as readonly string[]).includes(body.mime_type)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_MIME_INVALID" };
  }

  if (
    typeof body.size_bytes !== "number" ||
    !Number.isSafeInteger(body.size_bytes) ||
    body.size_bytes < 1 ||
    body.size_bytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES
  ) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_SIZE_INVALID" };
  }

  if (typeof body.checksum_sha256 !== "string" || !SHA256_HEX_REGEX.test(body.checksum_sha256)) {
    return { ok: false, code: "VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID" };
  }

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      target_kind: body.target_kind as VendorFinanceEvidenceTargetKind,
      target_id: body.target_id.toLowerCase(),
      mime_type: body.mime_type as VendorFinanceEvidenceMimeType,
      size_bytes: body.size_bytes,
      checksum_sha256: body.checksum_sha256.toLowerCase(),
      idempotency_key: idem.idempotency_key,
    },
  };
}

export function parseFinalizeVendorFinanceEvidenceBody(
  body: unknown,
): { ok: true } | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (!isRecord(body) || !exactKeys(body, [])) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }
  return { ok: true };
}

function resolveVendorFinanceBusinessTodayVn(todayVn?: string | null): string {
  if (typeof todayVn === "string" && isRealCalendarDate(todayVn)) {
    return todayVn;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// 6. Full-Admin Project Accountant Assignment & End
export type AssignProjectAccountantBody = {
  project_id: string;
  accountant_ref: string;
  valid_from: string | null;
  expected_version: number;
  reason: string;
  idempotency_key: string;
};

export function parseAssignProjectAccountantBody(
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
):
  | { ok: true; value: AssignProjectAccountantBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, [
      "project_id",
      "accountant_ref",
      "valid_from",
      "expected_version",
      "reason",
      "idempotency_key",
    ]) ||
    !("project_id" in body) ||
    !("accountant_ref" in body) ||
    !("expected_version" in body) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (typeof body.accountant_ref !== "string" || !UUID_REGEX.test(body.accountant_ref)) {
    return { ok: false, code: "VENDOR_FINANCE_ASSIGNMENT_INVALID" };
  }

  const businessToday = resolveVendorFinanceBusinessTodayVn(todayVn);
  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    const parsedDate = parseBusinessCalendarDate(body.valid_from);
    if (!parsedDate.ok) return parsedDate;
    if (parsedDate.date > businessToday) {
      return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
    }
    validFrom = parsedDate.date;
  }

  if (
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 0
  ) {
    return { ok: false, code: "VENDOR_FINANCE_ASSIGNMENT_INVALID" };
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      accountant_ref: body.accountant_ref.toLowerCase(),
      valid_from: validFrom,
      expected_version: body.expected_version,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

export type EndProjectAccountantBody = {
  expected_version: number;
  valid_to: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseEndProjectAccountantBody(
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
):
  | { ok: true; value: EndProjectAccountantBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, ["expected_version", "valid_to", "reason", "idempotency_key"]) ||
    !("expected_version" in body) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  if (
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 1
  ) {
    return { ok: false, code: "VENDOR_FINANCE_ASSIGNMENT_INVALID" };
  }

  const businessToday = resolveVendorFinanceBusinessTodayVn(todayVn);
  let validTo: string | null = null;
  if (body.valid_to !== undefined && body.valid_to !== null) {
    const parsedDate = parseBusinessCalendarDate(body.valid_to);
    if (!parsedDate.ok) return parsedDate;
    if (parsedDate.date > businessToday) {
      return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
    }
    validTo = parsedDate.date;
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      expected_version: body.expected_version,
      valid_to: validTo,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

export type AssignGlobalRoleBody = {
  account_ref: string;
  role_code: VendorFinanceGlobalRoleCode;
  valid_from: string | null;
  expected_version: number;
  reason: string;
  idempotency_key: string;
};

export function parseAssignGlobalRoleBody(
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
):
  | { ok: true; value: AssignGlobalRoleBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !allowedKeysOnly(body, [
      "account_ref",
      "role_code",
      "valid_from",
      "expected_version",
      "reason",
      "idempotency_key",
    ]) ||
    !("account_ref" in body) ||
    !("role_code" in body) ||
    !("expected_version" in body) ||
    !("reason" in body) ||
    !("idempotency_key" in body)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  if (typeof body.account_ref !== "string" || !UUID_REGEX.test(body.account_ref)) {
    return { ok: false, code: "VENDOR_FINANCE_GLOBAL_ROLE_INVALID" };
  }

  if (
    typeof body.role_code !== "string" ||
    !(VENDOR_FINANCE_GLOBAL_ROLE_CODES as readonly string[]).includes(body.role_code)
  ) {
    return { ok: false, code: "VENDOR_FINANCE_GLOBAL_ROLE_INVALID" };
  }

  const businessToday = resolveVendorFinanceBusinessTodayVn(todayVn);
  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    const parsedDate = parseBusinessCalendarDate(body.valid_from);
    if (!parsedDate.ok) return parsedDate;
    if (parsedDate.date > businessToday) {
      return { ok: false, code: "VENDOR_FINANCE_DATE_INVALID" };
    }
    validFrom = parsedDate.date;
  }

  if (
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 0
  ) {
    return { ok: false, code: "VENDOR_FINANCE_GLOBAL_ROLE_INVALID" };
  }

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      account_ref: body.account_ref.toLowerCase(),
      role_code: body.role_code as VendorFinanceGlobalRoleCode,
      valid_from: validFrom,
      expected_version: body.expected_version,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

export type EndGlobalRoleBody = {
  expected_version: number;
  valid_to: string | null;
  reason: string;
  idempotency_key: string;
};

export function parseEndGlobalRoleBody(
  body: unknown,
  idempotencyHeader: string | null,
  todayVn?: string | null,
):
  | { ok: true; value: EndGlobalRoleBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const parsed = parseEndProjectAccountantBody(body, idempotencyHeader, todayVn);
  if (!parsed.ok && parsed.code === "VENDOR_FINANCE_ASSIGNMENT_INVALID") {
    return { ok: false, code: "VENDOR_FINANCE_GLOBAL_ROLE_INVALID" };
  }
  return parsed;
}

// 7. VFIN-04 Shared Vendor Advance & Offset Mutation Bodies
export type FundSharedAdvanceBody = {
  amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseFundSharedAdvanceBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: FundSharedAdvanceBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    isRecord(body) &&
    ("project_id" in body || "accountant_ref" in body || "contract_type" in body)
  ) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (
    !isRecord(body) ||
    !exactKeys(body, ["amount_minor", "effective_date", "reason", "idempotency_key"])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const amount = parsePositiveMinorAmount(body.amount_minor);
  if (!amount.ok) return amount;

  const effectiveDate = parseBusinessCalendarDate(body.effective_date);
  if (!effectiveDate.ok) return effectiveDate;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      amount_minor: amount.canonical,
      effective_date: effectiveDate.date,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

export type RecordVendorRefundBody = {
  amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseRecordVendorRefundBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: RecordVendorRefundBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  return parseFundSharedAdvanceBody(body, idempotencyHeader);
}

export type ApplySharedAdvanceOffsetBody = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseApplySharedAdvanceOffsetBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ApplySharedAdvanceOffsetBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "project_id",
      "contract_type",
      "amount_minor",
      "effective_date",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (
    typeof body.contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const amount = parsePositiveMinorAmount(body.amount_minor);
  if (!amount.ok) return amount;

  const effectiveDate = parseBusinessCalendarDate(body.effective_date);
  if (!effectiveDate.ok) return effectiveDate;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      contract_type: body.contract_type as ClassifiedVendorFinanceContractType,
      amount_minor: amount.canonical,
      effective_date: effectiveDate.date,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

export type ReverseSharedAdvanceMovementBody = ReverseVendorFinanceEntryBody;

export function parseReverseSharedAdvanceMovementBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: ReverseSharedAdvanceMovementBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  return parseReverseVendorFinanceEntryBody(body, idempotencyHeader);
}

export type RecordPaymentWithOffsetBody = {
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  payment_amount_minor: string;
  offset_amount_minor: string;
  effective_date: string;
  reason: string;
  idempotency_key: string;
};

export function parseRecordPaymentWithOffsetBody(
  body: unknown,
  idempotencyHeader: string | null,
):
  | { ok: true; value: RecordPaymentWithOffsetBody }
  | { ok: false; code: VendorFinanceErrorCode } {
  const forbidden = checkForbiddenVendorFinanceClientFields(body);
  if (!forbidden.ok) return forbidden;
  if (
    !isRecord(body) ||
    !exactKeys(body, [
      "project_id",
      "contract_type",
      "payment_amount_minor",
      "offset_amount_minor",
      "effective_date",
      "reason",
      "idempotency_key",
    ])
  ) {
    return { ok: false, code: "VENDOR_FINANCE_PAYLOAD_INVALID" };
  }

  const projectId = parseProjectIdParam(body.project_id);
  if (!projectId.ok) return projectId;

  if (
    typeof body.contract_type !== "string" ||
    !(CLASSIFIED_VENDOR_FINANCE_CONTRACT_TYPES as readonly string[]).includes(
      body.contract_type,
    )
  ) {
    return { ok: false, code: "VENDOR_FINANCE_CONTRACT_TYPE_INVALID" };
  }

  const paymentAmount = parsePositiveMinorAmount(body.payment_amount_minor);
  if (!paymentAmount.ok) return paymentAmount;

  const offsetAmount = parsePositiveMinorAmount(body.offset_amount_minor);
  if (!offsetAmount.ok) return offsetAmount;

  if (paymentAmount.value + offsetAmount.value > PG_BIGINT_MAX) {
    return { ok: false, code: "VENDOR_FINANCE_AMOUNT_OVERFLOW" };
  }

  const effectiveDate = parseBusinessCalendarDate(body.effective_date);
  if (!effectiveDate.ok) return effectiveDate;

  const reason = parseReasonText(body.reason);
  if (!reason.ok) return reason;

  const idem = resolveIdempotencyKey(idempotencyHeader, body.idempotency_key);
  if (!idem.ok) return idem;

  return {
    ok: true,
    value: {
      project_id: projectId.project_id,
      contract_type: body.contract_type as ClassifiedVendorFinanceContractType,
      payment_amount_minor: paymentAmount.canonical,
      offset_amount_minor: offsetAmount.canonical,
      effective_date: effectiveDate.date,
      reason: reason.reason,
      idempotency_key: idem.idempotency_key,
    },
  };
}

// -----------------------------------------------------------------------------
// Deterministic SHA-256 Request Fingerprints
// -----------------------------------------------------------------------------
function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function computeRecordEntryFingerprint(input: {
  project_id?: string;
  contract_type?: ClassifiedVendorFinanceContractType;
  vendor_id: string;
  entry_type: NormalVendorFinanceEntryType;
  amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "RECORD_ENTRY",
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    ...(input.contract_type !== undefined ? { contract_type: input.contract_type } : {}),
    vendor_id: input.vendor_id,
    entry_type: input.entry_type,
    amount_minor: input.amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeReverseEntryFingerprint(input: {
  entry_id: string;
  effective_date: string | null;
  reason: string;
}): string {
  return sha256Json({
    op: "REVERSE_ENTRY",
    entry_id: input.entry_id,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeApplyOpeningBatchFingerprint(input: {
  project_id?: string;
  contract_type?: ClassifiedVendorFinanceContractType;
  cutoff_date: string;
  items: readonly OpeningBatchItemInput[];
  reason: string;
}): string {
  const normalizedItems = [...input.items]
    .filter((item) => item.amount_minor !== "0")
    .sort((a, b) => a.vendor_id.localeCompare(b.vendor_id))
    .map((item) => ({
      vendor_id: item.vendor_id,
      entry_type: item.entry_type,
      amount_minor: item.amount_minor,
    }));
  return sha256Json({
    op: "APPLY_OPENING_BATCH",
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    ...(input.contract_type !== undefined ? { contract_type: input.contract_type } : {}),
    cutoff_date: input.cutoff_date,
    items: normalizedItems,
    reason: input.reason,
  });
}

export function computeCreateReconciliationFingerprint(input: {
  project_id?: string;
  accountant_ref?: string | null;
  contract_type?: VendorFinanceContractType;
  vendor_id: string;
  as_of_date: string;
  confirmed_balance_minor: string;
  reason: string;
}): string {
  return sha256Json({
    op: "CREATE_RECONCILIATION",
    ...(input.project_id !== undefined
      ? {
          project_id: input.project_id,
          accountant_ref: input.accountant_ref ?? null,
        }
      : {}),
    ...(input.contract_type !== undefined ? { contract_type: input.contract_type } : {}),
    vendor_id: input.vendor_id,
    as_of_date: input.as_of_date,
    confirmed_balance_minor: input.confirmed_balance_minor,
    reason: input.reason,
  });
}

export function computeClassifySubLedgerFingerprint(input: {
  project_id: string;
  accountant_ref: string | null;
  vendor_id: string;
  target_contract_type: ClassifiedVendorFinanceContractType;
  reason: string;
}): string {
  return sha256Json({
    op: "CLASSIFY_SUBLEDGER_CONTRACT_TYPE",
    project_id: input.project_id,
    accountant_ref: input.accountant_ref ?? null,
    vendor_id: input.vendor_id,
    target_contract_type: input.target_contract_type,
    reason: input.reason,
  });
}

export function computeReserveEvidenceFingerprint(input: {
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
}): string {
  return sha256Json({
    op: "RESERVE_EVIDENCE",
    target_kind: input.target_kind,
    target_id: input.target_id,
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    checksum_sha256: input.checksum_sha256,
  });
}

export function computeAssignProjectAccountantFingerprint(input: {
  project_id: string;
  accountant_ref: string;
  valid_from: string | null;
  expected_version: number;
  reason: string;
}): string {
  return sha256Json({
    op: "ASSIGN_PROJECT_ACCOUNTANT",
    project_id: input.project_id,
    accountant_ref: input.accountant_ref,
    valid_from: input.valid_from,
    expected_version: input.expected_version,
    reason: input.reason,
  });
}

export function computeEndProjectAccountantFingerprint(input: {
  assignment_id: string;
  expected_version: number;
  valid_to: string | null;
  reason: string;
}): string {
  return sha256Json({
    op: "END_PROJECT_ACCOUNTANT",
    assignment_id: input.assignment_id,
    expected_version: input.expected_version,
    valid_to: input.valid_to,
    reason: input.reason,
  });
}

export function computeAssignGlobalRoleFingerprint(input: {
  account_ref: string;
  role_code: VendorFinanceGlobalRoleCode;
  valid_from: string | null;
  expected_version: number;
  reason: string;
}): string {
  return sha256Json({
    op: "ASSIGN_GLOBAL_ROLE",
    account_ref: input.account_ref,
    role_code: input.role_code,
    valid_from: input.valid_from,
    expected_version: input.expected_version,
    reason: input.reason,
  });
}

export function computeEndGlobalRoleFingerprint(input: {
  role_grant_id: string;
  expected_version: number;
  valid_to: string | null;
  reason: string;
}): string {
  return sha256Json({
    op: "END_GLOBAL_ROLE",
    role_grant_id: input.role_grant_id,
    expected_version: input.expected_version,
    valid_to: input.valid_to,
    reason: input.reason,
  });
}

export function computeFundSharedAdvanceFingerprint(input: {
  vendor_id: string;
  amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "FUND_SHARED_ADVANCE",
    vendor_id: input.vendor_id,
    amount_minor: input.amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeRecordVendorRefundFingerprint(input: {
  vendor_id: string;
  amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "RECORD_VENDOR_REFUND",
    vendor_id: input.vendor_id,
    amount_minor: input.amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeApplySharedAdvanceOffsetFingerprint(input: {
  vendor_id: string;
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "APPLY_SHARED_ADVANCE_OFFSET",
    vendor_id: input.vendor_id,
    project_id: input.project_id,
    contract_type: input.contract_type,
    amount_minor: input.amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeRecordPaymentWithOffsetFingerprint(input: {
  vendor_id: string;
  project_id: string;
  contract_type: ClassifiedVendorFinanceContractType;
  payment_amount_minor: string;
  offset_amount_minor: string;
  effective_date: string;
  reason: string;
}): string {
  return sha256Json({
    op: "RECORD_PAYMENT_WITH_OFFSET",
    vendor_id: input.vendor_id,
    project_id: input.project_id,
    contract_type: input.contract_type,
    payment_amount_minor: input.payment_amount_minor,
    offset_amount_minor: input.offset_amount_minor,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

export function computeReverseSharedAdvanceMovementFingerprint(input: {
  movement_id: string;
  effective_date: string | null;
  reason: string;
}): string {
  return sha256Json({
    op: "REVERSE_SHARED_ADVANCE",
    movement_id: input.movement_id,
    effective_date: input.effective_date,
    reason: input.reason,
  });
}

// -----------------------------------------------------------------------------
// Fail-Closed Response Projections (Server -> Client Contract)
// -----------------------------------------------------------------------------
export type VendorFinanceActorAccessProjection = {
  authorization_date: string;
  allowed: boolean;
  can_view: boolean;
  can_record: boolean;
  can_reconcile: boolean;
  can_manage_project_assignments: boolean;
  can_view_shared_advance: boolean;
  can_fund_vendor_advance: boolean;
  can_record_vendor_refund: boolean;
  can_apply_vendor_advance: boolean;
  visibility_scope: VendorFinanceVisibilityScope;
  record_scope: VendorFinanceWriteScope;
  reconcile_scope: VendorFinanceWriteScope;
  global_role_code: VendorFinanceGlobalRoleCode | null;
  active_assigned_project_count: number;
  authority_source: VendorFinanceAuthoritySource;
};

export type VendorFinanceAccountSummary = {
  account_ref: string;
  display_name: string;
  login_id: string | null;
  personnel_code: string | null;
  account_enabled: boolean;
};

export type VendorFinanceContextVendorOption = {
  vendor_id: string;
  display_name: string;
  active: boolean;
};

export type VendorFinanceContextProjectOption = {
  project_id: string;
  display_name: string;
  active: boolean;
  active_accountant_ref: string | null;
  active_accountant_display_name: string | null;
  has_active_accountant: boolean;
  can_record_for_project: boolean;
  can_reconcile_for_project: boolean;
};

export type VendorFinanceContextAccountantOption = {
  accountant_ref: string;
  display_name: string;
};

export type VendorFinanceActorContextOptionsResponse = {
  authorization_date: string;
  allowed_actions: {
    visibility_scope: VendorFinanceVisibilityScope;
    record_scope: VendorFinanceWriteScope;
    reconcile_scope: VendorFinanceWriteScope;
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    can_manage_project_assignments: boolean;
    can_view_shared_advance: boolean;
    can_fund_vendor_advance: boolean;
    can_record_vendor_refund: boolean;
    can_apply_vendor_advance: boolean;
  };
  has_legacy_unallocated: boolean;
  projects: readonly VendorFinanceContextProjectOption[];
  vendors: readonly VendorFinanceContextVendorOption[];
  accountants: readonly VendorFinanceContextAccountantOption[];
};

export type VendorFinanceEvidenceSummary = {
  evidence_id: string;
  status: "READY";
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  finalized_at: string;
};

export type VendorFinanceEntryProjection = {
  entry_id: string;
  vendor_id: string;
  vendor_display_name_snapshot: string;
  vendor_active: boolean;
  ledger_scope: VendorFinanceLedgerScope;
  project_id: string | null;
  project_display_name_snapshot: string | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: VendorFinanceContractType;
  vendor_sequence: number;
  cursor_sequence: number;
  document_no: string;
  document_kind: VendorFinanceDocumentKind;
  document_title_vi: string;
  entry_type: VendorFinanceEntryType;
  amount_minor: string;
  balance_before_minor: string;
  balance_delta_minor: string;
  balance_after_minor: string;
  effective_date: string;
  reason: string;
  opening_batch_id: string | null;
  reverses_entry_id: string | null;
  reverses_document_no: string | null;
  reversed_by_entry_id: string | null;
  reversed_by_document_no: string | null;
  can_reverse: boolean;
  can_attach_evidence: boolean;
  evidence: VendorFinanceEvidenceSummary | null;
  created_by_display_name: string;
  created_at: string;
  internal_disclaimer: string;
};

export type VendorFinanceSharedAdvanceMovementProjection = {
  movement_id: string;
  vendor_id: string;
  vendor_display_name_snapshot: string;
  vendor_active: boolean;
  vendor_advance_sequence: number;
  cursor_sequence: number;
  document_no: string;
  document_kind: VendorFinanceDocumentKind;
  document_title_vi: string;
  movement_type: VendorFinanceSharedAdvanceMovementType;
  amount_minor: string;
  balance_before_minor: string;
  balance_delta_minor: string;
  balance_after_minor: string;
  effective_date: string;
  reason: string | null;
  project_entry_id: string | null;
  project_id: string | null;
  project_display_name_snapshot: string | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: ClassifiedVendorFinanceContractType | null;
  reverses_movement_id: string | null;
  reverses_document_no: string | null;
  reversed_by_movement_id: string | null;
  reversed_by_document_no: string | null;
  can_reverse: boolean;
  can_attach_evidence: boolean;
  evidence: VendorFinanceEvidenceSummary | null;
  created_by_display_name: string | null;
  created_at: string;
  internal_disclaimer: string;
};

export type VendorFinanceReconciliationProjection = {
  reconciliation_id: string;
  vendor_id: string;
  ledger_scope: VendorFinanceLedgerScope;
  project_id: string | null;
  project_display_name_snapshot: string | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: VendorFinanceContractType;
  as_of_date: string;
  system_balance_minor: string;
  confirmed_balance_minor: string;
  difference_minor: string;
  ledger_sequence_at_reconciliation: number;
  reason: string;
  can_attach_evidence: boolean;
  evidence: VendorFinanceEvidenceSummary | null;
  created_by_display_name: string;
  created_at: string;
};

export type VendorFinanceSubLedgerClassificationProjection = {
  classification_id: string;
  vendor_id: string;
  project_id: string;
  project_display_name_snapshot: string;
  accountant_ref: string;
  responsible_accountant_display_name: string;
  source_contract_type: "UNCLASSIFIED";
  target_contract_type: ClassifiedVendorFinanceContractType;
  classified_entry_count: number;
  classified_reconciliation_count: number;
  closing_balance_minor: string;
  reason: string;
  classified_by_display_name: string;
  classified_at: string;
};

export type VendorFinanceCompanySummary = {
  total_payable_minor: string;
  total_advance_minor: string;
  total_shared_advance_minor: string;
  net_balance_minor: string;
  vendors_with_payable_count: number;
  vendors_with_advance_count: number;
  vendors_with_nonzero_balance_count: number;
  total_vendor_count: number;
  uninitialized_vendor_count: number;
  sub_ledger_count: number;
};

export type VendorFinanceListSubLedgerItem = {
  ledger_scope: VendorFinanceLedgerScope;
  project_id: string | null;
  project_display_name: string | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: VendorFinanceContractType;
  current_balance_minor: string;
  balance_direction: VendorFinanceBalanceDirection;
  entry_count: number;
  has_opening_entry: boolean;
  eligible_for_opening: boolean;
  last_reconciled_as_of_date: string | null;
};

export type VendorFinanceListItem = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  sub_ledger_count: number;
  payable_total_minor: string;
  advance_total_minor: string;
  shared_advance_balance_minor: string;
  current_balance_minor: string;
  balance_direction: VendorFinanceListBalanceDirection;
  entry_count: number;
  has_opening_entry: boolean;
  eligible_for_opening: boolean;
  last_effective_date: string | null;
  last_entry_at: string | null;
  last_reconciled_as_of_date: string | null;
  sub_ledgers: readonly VendorFinanceListSubLedgerItem[];
};

export type VendorFinanceVendorListResponse = {
  authorization_date: string;
  allowed_actions: {
    visibility_scope: VendorFinanceVisibilityScope;
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    can_manage_project_assignments: boolean;
    can_view_shared_advance: boolean;
    can_fund_vendor_advance: boolean;
    can_record_vendor_refund: boolean;
    can_apply_vendor_advance: boolean;
    active_assigned_project_count: number;
  };
  summary: VendorFinanceCompanySummary;
  filters: {
    search: string | null;
    active: VendorFinanceActiveFilter;
    balance_filter: VendorFinanceBalanceFilter;
    project_id: string | null;
    accountant_ref: string | null;
    ledger_scope: VendorFinanceLedgerScopeFilter;
    contract_type: VendorFinanceContractTypeFilter;
  };
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  vendors: readonly VendorFinanceListItem[];
};

export type VendorFinanceExportVendorItem = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  sub_ledger_count: number;
  payable_total_minor: string;
  shared_advance_balance_minor: string;
  last_effective_date: string | null;
};

export type VendorFinanceVendorExportResponse = {
  authorization_date: string;
  filters: {
    search: string | null;
    active: VendorFinanceActiveFilter;
    balance_filter: VendorFinanceBalanceFilter;
    project_id: string | null;
    accountant_ref: string | null;
    ledger_scope: VendorFinanceLedgerScopeFilter;
    contract_type: VendorFinanceContractTypeFilter;
  };
  row_cap: number;
  total: number;
  vendors: readonly VendorFinanceExportVendorItem[];
};

export type VendorFinanceCategoryTotals = {
  opening_payable_minor: string;
  opening_advance_minor: string;
  debt_recorded_minor: string;
  payroll_recorded_minor: string;
  payment_recorded_minor: string;
  advance_recorded_minor: string;
  advance_offset_recorded_minor: string;
  adjustment_increase_minor: string;
  adjustment_decrease_minor: string;
  reversed_entry_count: number;
};

export type VendorFinanceDetailSubLedger = {
  ledger_scope: VendorFinanceLedgerScope;
  project_id: string | null;
  project_display_name: string | null;
  project_active: boolean | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: VendorFinanceContractType;
  is_active_assignment: boolean;
  current_balance_minor: string;
  balance_direction: VendorFinanceBalanceDirection;
  latest_sequence: number;
  entry_count: number;
  has_opening_entry: boolean;
  eligible_for_opening: boolean;
  can_record_entry: boolean;
  can_apply_vendor_advance: boolean;
  can_reconcile: boolean;
  can_classify_contract_type: boolean;
  classification: VendorFinanceSubLedgerClassificationProjection | null;
};

export type VendorFinanceVendorDetailResponse = {
  authorization_date: string;
  allowed_actions: {
    visibility_scope: VendorFinanceVisibilityScope;
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    can_manage_project_assignments: boolean;
    can_view_shared_advance: boolean;
    can_fund_vendor_advance: boolean;
    can_record_vendor_refund: boolean;
    can_apply_vendor_advance: boolean;
    allowed_entry_types: readonly NormalVendorFinanceEntryType[];
  };
  selected_sub_ledger: VendorFinanceDetailSubLedger | null;
  sub_ledgers: readonly VendorFinanceDetailSubLedger[];
  vendor: {
    vendor_id: string;
    display_name: string;
    active: boolean;
    shared_advance_balance_minor: string;
    shared_advance_latest_sequence: number;
    shared_advance_movement_count: number;
    current_balance_minor: string;
    balance_direction: VendorFinanceListBalanceDirection;
    latest_sequence: number;
    entry_count: number;
    has_opening_entry: boolean;
    eligible_for_opening: boolean;
    totals: VendorFinanceCategoryTotals;
    latest_reconciliation: VendorFinanceReconciliationProjection | null;
    recent_reconciliations: readonly VendorFinanceReconciliationProjection[];
  };
};

export type VendorFinanceEntriesPageResponse = {
  authorization_date: string;
  vendor_id: string;
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  entries: readonly VendorFinanceEntryProjection[];
};

export type VendorFinanceSharedAdvanceMovementsPageResponse = {
  authorization_date: string;
  vendor_id: string;
  shared_advance_balance_minor: string;
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  movements: readonly VendorFinanceSharedAdvanceMovementProjection[];
};

export type VendorFinanceFundSharedAdvanceResponse = {
  movement: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor: string;
  replayed: boolean;
};

export type VendorFinanceRecordVendorRefundResponse = {
  movement: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor: string;
  replayed: boolean;
};

export type VendorFinanceApplySharedAdvanceOffsetResponse = {
  movement: VendorFinanceSharedAdvanceMovementProjection;
  entry: VendorFinanceEntryProjection;
  shared_advance_balance_minor: string;
  replayed: boolean;
};

export type VendorFinanceRecordPaymentWithOffsetResponse = {
  payment_entry: VendorFinanceEntryProjection;
  offset_entry: VendorFinanceEntryProjection;
  movement: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor: string;
  replayed: boolean;
};

export type VendorFinanceReverseSharedAdvanceMovementResponse = {
  reversal_movement: VendorFinanceSharedAdvanceMovementProjection;
  reversed_movement: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor: string;
  reversal_entry?: VendorFinanceEntryProjection;
  reversed_entry?: VendorFinanceEntryProjection;
  replayed: boolean;
};

export type VendorFinanceSingleEntryResponse = {
  authorization_date: string;
  allowed_actions: {
    visibility_scope: VendorFinanceVisibilityScope;
    can_view: boolean;
    can_record: boolean;
  };
  entry: VendorFinanceEntryProjection;
};

export type VendorFinanceReconciliationsPageResponse = {
  authorization_date: string;
  vendor_id: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  reconciliations: readonly VendorFinanceReconciliationProjection[];
};

export type VendorFinanceOpeningPreviewItem = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  entry_type: OpeningVendorFinanceEntryType;
  amount_minor: string;
  balance_delta_minor: string;
};

export type VendorFinanceOpeningPreviewResponse = {
  authorization_date: string;
  project_id: string;
  project_display_name: string;
  accountant_ref: string;
  responsible_accountant_display_name: string;
  contract_type: ClassifiedVendorFinanceContractType;
  cutoff_date: string;
  vendor_count: number;
  skipped_zero_count: number;
  total_payable_minor: string;
  total_advance_minor: string;
  net_balance_minor: string;
  items: readonly VendorFinanceOpeningPreviewItem[];
};

export type VendorFinanceOpeningBatchHeader = {
  batch_id: string;
  ledger_scope: VendorFinanceLedgerScope;
  project_id: string | null;
  project_display_name_snapshot: string | null;
  accountant_ref: string | null;
  responsible_accountant_display_name: string | null;
  contract_type: VendorFinanceContractType;
  cutoff_date: string;
  vendor_count: number;
  skipped_zero_count: number;
  total_payable_minor: string;
  total_advance_minor: string;
  net_balance_minor: string;
  reason: string;
  created_by_display_name: string;
  created_at: string;
};

export type VendorFinanceOpeningApplyResponse = {
  batch: VendorFinanceOpeningBatchHeader;
  entries: readonly VendorFinanceEntryProjection[];
  replayed: boolean;
};

export type VendorFinanceClassifySubLedgerResponse = {
  classification: VendorFinanceSubLedgerClassificationProjection;
  replayed: boolean;
};

export type VendorFinanceMonthlyReportAccountantSummary = {
  project_id: string;
  project_display_name: string;
  project_active: boolean;
  accountant_ref: string;
  responsible_accountant_display_name: string;
  contract_type: VendorFinanceContractType;
  is_currently_assigned: boolean;
  project_revenue_status: VendorFinanceProjectRevenueStatus;
  project_revenue_minor: null;
  vendor_count: number;
  obligations_in_month_minor: string;
  paid_in_month_minor: string;
  advanced_in_month_minor: string;
  advance_offset_in_month_minor: string;
  paid_and_advanced_in_month_minor: string;
  closing_payable_minor: string;
  closing_advance_minor: string;
  in_month_entry_count: number;
};

export type VendorFinanceMonthlyReportRow = {
  project_id: string;
  project_display_name: string;
  project_active: boolean;
  accountant_ref: string;
  responsible_accountant_display_name: string;
  contract_type: VendorFinanceContractType;
  is_currently_assigned: boolean;
  vendor_id: string;
  vendor_display_name: string;
  vendor_active: boolean;
  project_revenue_status: VendorFinanceProjectRevenueStatus;
  project_revenue_minor: null;
  balance_before_month_minor: string;
  opening_payable_in_month_minor: string;
  opening_advance_in_month_minor: string;
  obligations_in_month_minor: string;
  paid_in_month_minor: string;
  advanced_in_month_minor: string;
  advance_offset_in_month_minor: string;
  paid_and_advanced_in_month_minor: string;
  net_change_in_month_minor: string;
  closing_balance_minor: string;
  closing_direction: VendorFinanceBalanceDirection;
  closing_payable_minor: string;
  closing_advance_minor: string;
  current_balance_minor: string;
  in_month_entry_count: number;
  total_entry_count: number;
};

export type VendorFinanceMonthlyLegacyRow = {
  vendor_id: string;
  vendor_display_name: string;
  vendor_active: boolean;
  balance_before_month_minor: string;
  obligations_in_month_minor: string;
  paid_and_advanced_in_month_minor: string;
  closing_balance_minor: string;
  closing_direction: VendorFinanceBalanceDirection;
  in_month_entry_count: number;
};

export type VendorFinanceMonthlyReportResponse = {
  authorization_date: string;
  allowed_actions: {
    visibility_scope: VendorFinanceVisibilityScope;
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    can_manage_project_assignments: boolean;
    can_view_shared_advance: boolean;
    can_fund_vendor_advance: boolean;
    can_record_vendor_refund: boolean;
    can_apply_vendor_advance: boolean;
    active_assigned_project_count?: number;
  };
  filters: {
    month: string;
    project_id: string | null;
    accountant_ref: string | null;
    vendor_id: string | null;
    contract_type: VendorFinanceContractTypeFilter;
  };
  totals: {
    project_revenue_status: VendorFinanceProjectRevenueStatus;
    project_revenue_minor: null;
    project_accountant_book_count: number;
    sub_ledger_count: number;
    obligations_in_month_minor: string;
    paid_in_month_minor: string;
    advanced_in_month_minor: string;
    advance_offset_in_month_minor: string;
    paid_and_advanced_in_month_minor: string;
    closing_payable_minor: string;
    closing_advance_minor: string;
  };
  project_accountant_summaries: readonly VendorFinanceMonthlyReportAccountantSummary[];
  rows: readonly VendorFinanceMonthlyReportRow[];
  legacy_unallocated_rows: readonly VendorFinanceMonthlyLegacyRow[];
};

export type VendorFinanceProjectAccountantAssignmentItem = {
  assignment_id: string;
  project_id: string;
  version: number;
  accountant: VendorFinanceAccountSummary;
  accountant_in_accounting_department: boolean;
  valid_from: string;
  valid_to: string | null;
  state: VendorFinanceAdminGrantState;
  assign_reason: string;
  end_reason: string | null;
  created_at: string;
};

export type VendorFinanceProjectAccountantsAdminProject = {
  project_id: string;
  display_name: string;
  active: boolean;
  next_version: number;
  transacted_vendor_count: number;
  current_assignment: VendorFinanceProjectAccountantAssignmentItem | null;
  assignments: readonly VendorFinanceProjectAccountantAssignmentItem[];
};

export type VendorFinanceListProjectAccountantsAdminResponse = {
  authorization_date: string;
  eligible_accountants: readonly VendorFinanceAccountSummary[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  projects: readonly VendorFinanceProjectAccountantsAdminProject[];
};

export type VendorFinanceAssignProjectAccountantResponse = {
  assignment_id: string;
  project_id: string;
  version: number;
  replayed: boolean;
};

export type VendorFinanceEndProjectAccountantResponse = {
  assignment_id: string;
  project_id: string;
  valid_to: string;
  replayed: boolean;
};

export type VendorFinanceGlobalRoleGrantItem = {
  role_grant_id: string;
  account: VendorFinanceAccountSummary;
  role_code: VendorFinanceGlobalRoleCode;
  version: number;
  valid_from: string;
  valid_to: string | null;
  state: VendorFinanceAdminGrantState;
  grant_reason: string;
  end_reason: string | null;
  created_at: string;
};

export type VendorFinanceGlobalRoleCandidateItem = {
  account: VendorFinanceAccountSummary;
  next_version: number;
  has_open_role: boolean;
};

export type VendorFinanceListGlobalRolesAdminResponse = {
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  roles: readonly VendorFinanceGlobalRoleGrantItem[];
  candidates: readonly VendorFinanceGlobalRoleCandidateItem[];
};

export type VendorFinanceAssignGlobalRoleResponse = {
  role_grant_id: string;
  account_ref: string;
  role_code: VendorFinanceGlobalRoleCode;
  version: number;
  replayed: boolean;
};

export type VendorFinanceEndGlobalRoleResponse = {
  role_grant_id: string;
  account_ref: string;
  valid_to: string;
  replayed: boolean;
};

export type VendorFinanceEvidenceReserveResponse = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  upload: {
    method: "PUT";
    url: string;
    expires_at: string;
    headers: Readonly<Record<string, string>>;
  };
  replayed: boolean;
};

export type VendorFinanceEvidenceFinalizeResponse = {
  evidence: VendorFinanceEvidenceSummary & {
    target_kind: VendorFinanceEvidenceTargetKind;
    target_id: string;
  };
  replayed: boolean;
};

export type VendorFinanceEvidenceDownloadResponse = {
  evidence_id: string;
  target_kind: VendorFinanceEvidenceTargetKind;
  target_id: string;
  mime_type: VendorFinanceEvidenceMimeType;
  size_bytes: number;
  checksum_sha256: string;
  download: {
    url: string;
    expires_at: string;
  };
};

// Internal projection helpers
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

function signedMoneyStr(value: unknown): string | null {
  const parsed = parseSignedMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function nonNegativeMoneyStr(value: unknown): string | null {
  const parsed = parseNonNegativeMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function positiveMoneyStr(value: unknown): string | null {
  const parsed = parsePositiveMinorAmount(value);
  return parsed.ok ? parsed.canonical : null;
}

function uuidStr(value: unknown): string | null {
  return typeof value === "string" && UUID_REGEX.test(value) ? value.toLowerCase() : null;
}

function nullableUuidStr(value: unknown): string | null | undefined {
  return value === null ? null : (uuidStr(value) ?? undefined);
}

function dateStr(value: unknown): string | null {
  const parsed = parseBusinessCalendarDate(value);
  return parsed.ok ? parsed.date : null;
}

function nullableDateStr(value: unknown): string | null | undefined {
  return value === null ? null : (dateStr(value) ?? undefined);
}

function ledgerScopeVal(value: unknown): VendorFinanceLedgerScope | null {
  return value === "PROJECT_ACCOUNTANT" || value === "LEGACY_UNALLOCATED" ? value : null;
}

function contractTypeVal(value: unknown): VendorFinanceContractType | null {
  return value === "SEASONAL" || value === "OFFICIAL" || value === "UNCLASSIFIED"
    ? value
    : null;
}

function classifiedContractTypeVal(
  value: unknown,
): ClassifiedVendorFinanceContractType | null {
  return value === "SEASONAL" || value === "OFFICIAL" ? value : null;
}

function contractTypeFilterVal(value: unknown): VendorFinanceContractTypeFilter | null {
  return value === "all" ||
    value === "SEASONAL" ||
    value === "OFFICIAL" ||
    value === "UNCLASSIFIED"
    ? value
    : null;
}

function visibilityScopeVal(value: unknown): VendorFinanceVisibilityScope | null {
  return value === "ALL" || value === "PROJECT_SCOPED" || value === "NONE" ? value : null;
}

function writeScopeVal(value: unknown): VendorFinanceWriteScope | null {
  return value === "ALL" || value === "ASSIGNED_PROJECTS" || value === "NONE" ? value : null;
}

function authoritySourceVal(value: unknown): VendorFinanceAuthoritySource | null {
  return value === "full_admin" ||
    value === "accounting_department" ||
    value === "direct_grant_record" ||
    value === "direct_grant_view" ||
    value === "cash_holder" ||
    value === "cash_holder_record_behalf" ||
    value === "global_reconciler" ||
    value === "none"
    ? value
    : null;
}

function globalRoleVal(value: unknown): VendorFinanceGlobalRoleCode | null {
  return typeof value === "string" &&
    (VENDOR_FINANCE_GLOBAL_ROLE_CODES as readonly string[]).includes(value)
    ? (value as VendorFinanceGlobalRoleCode)
    : null;
}

function adminGrantStateVal(value: unknown): VendorFinanceAdminGrantState | null {
  return typeof value === "string" &&
    (VENDOR_FINANCE_ADMIN_GRANT_STATES as readonly string[]).includes(value)
    ? (value as VendorFinanceAdminGrantState)
    : null;
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

function projectAccountSummary(value: unknown): VendorFinanceAccountSummary | null {
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

export function projectActorAccess(value: unknown): VendorFinanceActorAccessProjection | null {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeysOnly(
      value,
      [
        "allowed",
        "authority_source",
        "visibility_scope",
        "record_scope",
        "reconcile_scope",
        "global_role_code",
        "can_view",
        "can_record",
        "can_reconcile",
        "can_manage_project_assignments",
        "active_assigned_project_count",
        "authorization_date",
      ],
      [
        "can_view_shared_advance",
        "can_fund_vendor_advance",
        "can_record_vendor_refund",
        "can_apply_vendor_advance",
      ],
    )
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const allowed = boolVal(value.allowed);
  const canView = boolVal(value.can_view);
  const canRecord = boolVal(value.can_record);
  const canReconcile = boolVal(value.can_reconcile);
  const canManage = boolVal(value.can_manage_project_assignments);
  const visScope = visibilityScopeVal(value.visibility_scope);
  const recScope = writeScopeVal(value.record_scope);
  const reconScope = writeScopeVal(value.reconcile_scope);
  const roleCode =
    value.global_role_code === null ? null : globalRoleVal(value.global_role_code);
  const assignedCount = nonNegInt(value.active_assigned_project_count);
  const source = authoritySourceVal(value.authority_source);
  if (
    authorizationDate === null ||
    allowed === null ||
    canView === null ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    visScope === null ||
    recScope === null ||
    reconScope === null ||
    (value.global_role_code !== null && roleCode === null) ||
    assignedCount === null ||
    source === null
  ) {
    return null;
  }
  const defaultFund =
    source === "full_admin" ||
    source === "direct_grant_record" ||
    source === "cash_holder" ||
    source === "cash_holder_record_behalf";
  const canViewShared =
    "can_view_shared_advance" in value
      ? boolVal(value.can_view_shared_advance)
      : canView;
  const canFund =
    "can_fund_vendor_advance" in value
      ? boolVal(value.can_fund_vendor_advance)
      : defaultFund;
  const canRefund =
    "can_record_vendor_refund" in value
      ? boolVal(value.can_record_vendor_refund)
      : defaultFund;
  const canApply =
    "can_apply_vendor_advance" in value
      ? boolVal(value.can_apply_vendor_advance)
      : canRecord;
  if (
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null
  ) {
    return null;
  }
  if ((canRecord || canReconcile || canManage || canFund || canRefund || canApply) && !canView) {
    return null;
  }
  if (allowed !== canView) return null;
  return {
    authorization_date: authorizationDate,
    allowed,
    can_view: canView,
    can_record: canRecord,
    can_reconcile: canReconcile,
    can_manage_project_assignments: canManage,
    can_view_shared_advance: canViewShared,
    can_fund_vendor_advance: canFund,
    can_record_vendor_refund: canRefund,
    can_apply_vendor_advance: canApply,
    visibility_scope: visScope,
    record_scope: recScope,
    reconcile_scope: reconScope,
    global_role_code: roleCode,
    active_assigned_project_count: assignedCount,
    authority_source: source,
  };
}

export function projectActorContextOptions(
  value: unknown,
): VendorFinanceActorContextOptionsResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "allowed_actions",
      "has_legacy_unallocated",
      "projects",
      "vendors",
      "accountants",
    ]) ||
    !isRecord(value.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      value.allowed_actions,
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
    !Array.isArray(value.projects) ||
    !Array.isArray(value.vendors) ||
    !Array.isArray(value.accountants)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const visScope = visibilityScopeVal(value.allowed_actions.visibility_scope);
  const recScope = writeScopeVal(value.allowed_actions.record_scope);
  const reconScope = writeScopeVal(value.allowed_actions.reconcile_scope);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const canReconcile = boolVal(value.allowed_actions.can_reconcile);
  const canManage = boolVal(value.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_fund_vendor_advance)
      : recScope === "ALL";
  const canRefund =
    "can_record_vendor_refund" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_record_vendor_refund)
      : recScope === "ALL";
  const canApply =
    "can_apply_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const hasLegacy = boolVal(value.has_legacy_unallocated);
  if (
    authorizationDate === null ||
    visScope === null ||
    recScope === null ||
    reconScope === null ||
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
  for (const rawProj of value.projects) {
    if (
      !isRecord(rawProj) ||
      !exactKeys(rawProj, [
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
    const projectId = isCanonicalProjectId(rawProj.project_id) ? rawProj.project_id : null;
    const displayName = nonEmptyStr(rawProj.display_name);
    const active = boolVal(rawProj.active);
    const activeAccountantRef = nullableUuidStr(rawProj.active_accountant_ref);
    const activeAccountantName = nullableStr(rawProj.active_accountant_display_name);
    const hasActiveAccountant = boolVal(rawProj.has_active_accountant);
    const canRecordProject = boolVal(rawProj.can_record_for_project);
    const canReconcileProject = boolVal(rawProj.can_reconcile_for_project);
    if (
      projectId === null ||
      displayName === null ||
      active === null ||
      activeAccountantRef === undefined ||
      activeAccountantName === undefined ||
      hasActiveAccountant === null ||
      canRecordProject === null ||
      canReconcileProject === null
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
      can_record_for_project: canRecordProject,
      can_reconcile_for_project: canReconcileProject,
    });
  }

  const vendors: VendorFinanceContextVendorOption[] = [];
  for (const rawVendor of value.vendors) {
    if (!isRecord(rawVendor) || !exactKeys(rawVendor, ["vendor_id", "display_name", "active"])) return null;
    const vendorId = isCanonicalVendorId(rawVendor.vendor_id) ? rawVendor.vendor_id : null;
    const displayName = nonEmptyStr(rawVendor.display_name);
    const active = boolVal(rawVendor.active);
    if (vendorId === null || displayName === null || active === null) return null;
    vendors.push({ vendor_id: vendorId, display_name: displayName, active });
  }

  const accountants: VendorFinanceContextAccountantOption[] = [];
  for (const rawAcc of value.accountants) {
    if (!isRecord(rawAcc) || !exactKeys(rawAcc, ["accountant_ref", "display_name"])) {
      return null;
    }
    const accountantRef = uuidStr(rawAcc.accountant_ref);
    const displayName = nonEmptyStr(rawAcc.display_name);
    if (accountantRef === null || displayName === null) return null;
    accountants.push({ accountant_ref: accountantRef, display_name: displayName });
  }

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visScope,
      record_scope: recScope,
      reconcile_scope: reconScope,
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

export function projectEvidenceSummary(value: unknown): VendorFinanceEvidenceSummary | null {
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
    sizeBytes > VENDOR_FINANCE_EVIDENCE_MAX_BYTES ||
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

export function projectVendorFinanceEntry(value: unknown): VendorFinanceEntryProjection | null {
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const vendorDisplayNameSnapshot = nonEmptyStr(value.vendor_display_name_snapshot);
  const vendorActive = boolVal(value.vendor_active);
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId =
    value.project_id === null
      ? null
      : isCanonicalProjectId(value.project_id)
        ? value.project_id
        : undefined;
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const vendorSequence = posInt(value.vendor_sequence);
  const cursorSequence = posInt(value.cursor_sequence);
  const documentNo =
    typeof value.document_no === "string" && DOCUMENT_NO_REGEX.test(value.document_no)
      ? value.document_no
      : null;
  const documentKind =
    typeof value.document_kind === "string" &&
    (VENDOR_FINANCE_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const entryType =
    typeof value.entry_type === "string" &&
    (VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(value.entry_type)
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
  const evidence = value.evidence === null ? null : projectEvidenceSummary(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);
  const disclaimer =
    value.internal_disclaimer === VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
      ? VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
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
    responsibleAccountantName === undefined ||
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
      responsibleAccountantName === null)
  ) {
    return null;
  }
  if (
    ledgerScope === "LEGACY_UNALLOCATED" &&
    (projectId !== null ||
      projectDisplayNameSnapshot !== null ||
      accountantRef !== null ||
      responsibleAccountantName !== null ||
      contractType !== "UNCLASSIFIED")
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
    responsible_accountant_display_name: responsibleAccountantName,
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

export function projectSharedAdvanceMovement(
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
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
    (VENDOR_FINANCE_DOCUMENT_KINDS as readonly string[]).includes(value.document_kind)
      ? (value.document_kind as VendorFinanceDocumentKind)
      : null;
  const documentTitleVi = nonEmptyStr(value.document_title_vi);
  const movementType =
    typeof value.movement_type === "string" &&
    (VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_TYPES as readonly string[]).includes(
      value.movement_type,
    )
      ? (value.movement_type as VendorFinanceSharedAdvanceMovementType)
      : null;
  const amountMinor = positiveMoneyStr(value.amount_minor);
  const balanceBeforeMinor = nonNegativeMoneyStr(value.balance_before_minor);
  const balanceDeltaMinor = signedMoneyStr(value.balance_delta_minor);
  const balanceAfterMinor = nonNegativeMoneyStr(value.balance_after_minor);
  const effectiveDate = dateStr(value.effective_date);
  const reason = nullableStr(value.reason);
  const projectEntryId = nullableUuidStr(value.project_entry_id);
  const projectId =
    value.project_id === null
      ? null
      : isCanonicalProjectId(value.project_id)
        ? value.project_id
        : undefined;
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantName = nullableStr(value.responsible_accountant_display_name);
  const contractType =
    value.contract_type === null
      ? null
      : classifiedContractTypeVal(value.contract_type) ?? undefined;
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
    value.internal_disclaimer === VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
      ? VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI
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

export function projectVendorReconciliation(
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const ledgerScope = ledgerScopeVal(value.ledger_scope);
  const projectId =
    value.project_id === null
      ? null
      : isCanonicalProjectId(value.project_id)
        ? value.project_id
        : undefined;
  const projectDisplayNameSnapshot = nullableStr(value.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const responsibleAccountantName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const asOfDate = dateStr(value.as_of_date);
  const systemBalanceMinor = signedMoneyStr(value.system_balance_minor);
  const confirmedBalanceMinor = signedMoneyStr(value.confirmed_balance_minor);
  const differenceMinor = signedMoneyStr(value.difference_minor);
  const ledgerSeq = nonNegInt(value.ledger_sequence_at_reconciliation);
  const reason = nonEmptyStr(value.reason);
  const canAttachEvidence = boolVal(value.can_attach_evidence);
  const evidence = value.evidence === null ? null : projectEvidenceSummary(value.evidence);
  const createdByDisplayName = nonEmptyStr(value.created_by_display_name);
  const createdAt = nonEmptyStr(value.created_at);

  if (
    reconciliationId === null ||
    vendorId === null ||
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayNameSnapshot === undefined ||
    accountantRef === undefined ||
    responsibleAccountantName === undefined ||
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
      responsibleAccountantName === null)
  ) {
    return null;
  }
  if (
    ledgerScope === "LEGACY_UNALLOCATED" &&
    (projectId !== null ||
      projectDisplayNameSnapshot !== null ||
      accountantRef !== null ||
      responsibleAccountantName !== null ||
      contractType !== "UNCLASSIFIED")
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
    responsible_accountant_display_name: responsibleAccountantName,
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

export function projectSubLedgerClassification(
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
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const projectId = isCanonicalProjectId(value.project_id) ? value.project_id : null;
  const projectDisplayNameSnapshot = nonEmptyStr(value.project_display_name_snapshot);
  const accountantRef = uuidStr(value.accountant_ref);
  const responsibleAccountantName = nonEmptyStr(value.responsible_accountant_display_name);
  const sourceContractType = value.source_contract_type === "UNCLASSIFIED" ? "UNCLASSIFIED" : null;
  const targetContractType = classifiedContractTypeVal(value.target_contract_type);
  const classifiedEntryCount = posInt(value.classified_entry_count);
  const classifiedReconciliationCount = nonNegInt(value.classified_reconciliation_count);
  const closingBalanceMinor = signedMoneyStr(value.closing_balance_minor);
  const reason = nonEmptyStr(value.reason);
  const classifiedByDisplayName = nonEmptyStr(value.classified_by_display_name);
  const classifiedAt = nonEmptyStr(value.classified_at);

  if (
    classificationId === null ||
    vendorId === null ||
    projectId === null ||
    projectDisplayNameSnapshot === null ||
    accountantRef === null ||
    responsibleAccountantName === null ||
    sourceContractType === null ||
    targetContractType === null ||
    classifiedEntryCount === null ||
    classifiedReconciliationCount === null ||
    closingBalanceMinor === null ||
    reason === null ||
    classifiedByDisplayName === null ||
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
    responsible_accountant_display_name: responsibleAccountantName,
    source_contract_type: sourceContractType,
    target_contract_type: targetContractType,
    classified_entry_count: classifiedEntryCount,
    classified_reconciliation_count: classifiedReconciliationCount,
    closing_balance_minor: closingBalanceMinor,
    reason,
    classified_by_display_name: classifiedByDisplayName,
    classified_at: classifiedAt,
  };
}

export function projectVendorFinanceVendorList(
  value: unknown,
): VendorFinanceVendorListResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "allowed_actions",
      "summary",
      "filters",
      "page",
      "page_size",
      "total",
      "has_more",
      "vendors",
    ])
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  if (
    !isRecord(value.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      value.allowed_actions,
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
    !isRecord(value.summary) ||
    !requiredAndOptionalKeysOnly(
      value.summary,
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
    !isRecord(value.filters) ||
    !exactKeys(value.filters, [
      "search",
      "active",
      "balance_filter",
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
    ]) ||
    !Array.isArray(value.vendors)
  ) {
    return null;
  }

  const visScope = visibilityScopeVal(value.allowed_actions.visibility_scope);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const canReconcile = boolVal(value.allowed_actions.can_reconcile);
  const canManage = boolVal(value.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_fund_vendor_advance)
      : false;
  const canRefund =
    "can_record_vendor_refund" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_record_vendor_refund)
      : false;
  const canApply =
    "can_apply_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const assignedCount = nonNegInt(value.allowed_actions.active_assigned_project_count);

  const totalPayable = nonNegativeMoneyStr(value.summary.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(value.summary.total_advance_minor);
  const totalSharedAdvance =
    "total_shared_advance_minor" in value.summary
      ? nonNegativeMoneyStr(value.summary.total_shared_advance_minor)
      : "0";
  const netBalance = signedMoneyStr(value.summary.net_balance_minor);
  const payableCount = nonNegInt(value.summary.vendors_with_payable_count);
  const advanceCount = nonNegInt(value.summary.vendors_with_advance_count);
  const nonzeroCount = nonNegInt(value.summary.vendors_with_nonzero_balance_count);
  const totalVendorCount = nonNegInt(value.summary.total_vendor_count);
  const uninitializedCount = nonNegInt(value.summary.uninitialized_vendor_count);
  const subLedgerCount = nonNegInt(value.summary.sub_ledger_count);

  const search = nullableStr(value.filters.search);
  const active = value.filters.active;
  const balanceFilter = value.filters.balance_filter;
  const filterProjectId =
    value.filters.project_id === null
      ? null
      : isCanonicalProjectId(value.filters.project_id)
        ? value.filters.project_id
        : undefined;
  const filterAccountantRef = nullableUuidStr(value.filters.accountant_ref);
  const filterLedgerScope = value.filters.ledger_scope;
  const filterContractType = contractTypeFilterVal(value.filters.contract_type);
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);

  if (
    authorizationDate === null ||
    visScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    assignedCount === null ||
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
    filterContractType === null ||
    page === null ||
    pageSize === null ||
    total === null ||
    hasMore === null
  ) {
    return null;
  }

  const vendors: VendorFinanceListItem[] = [];
  for (const item of value.vendors) {
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
    const vendorId = isCanonicalVendorId(item.vendor_id) ? item.vendor_id : null;
    const displayName = nonEmptyStr(item.display_name);
    const itemActive = boolVal(item.active);
    const itemSubLedgerCount = nonNegInt(item.sub_ledger_count);
    const itemPayableTotal = nonNegativeMoneyStr(item.payable_total_minor);
    const itemAdvanceTotal = nonNegativeMoneyStr(item.advance_total_minor);
    const itemSharedAdvance =
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
      itemPayableTotal === null ||
      itemAdvanceTotal === null ||
      itemSharedAdvance === null ||
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
    for (const rawSl of item.sub_ledgers) {
      if (
        !isRecord(rawSl) ||
        !exactKeys(rawSl, [
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
      const slScope = ledgerScopeVal(rawSl.ledger_scope);
      const slProjectId =
        rawSl.project_id === null
          ? null
          : isCanonicalProjectId(rawSl.project_id)
            ? rawSl.project_id
            : undefined;
      const slProjectName = nullableStr(rawSl.project_display_name);
      const slAccountantRef = nullableUuidStr(rawSl.accountant_ref);
      const slAccountantName = nullableStr(rawSl.responsible_accountant_display_name);
      const slContractType = contractTypeVal(rawSl.contract_type);
      const slBalance = signedMoneyStr(rawSl.current_balance_minor);
      const slDirection = balanceDirectionVal(rawSl.balance_direction);
      const slEntries = nonNegInt(rawSl.entry_count);
      const slHasOpening = boolVal(rawSl.has_opening_entry);
      const slEligible = boolVal(rawSl.eligible_for_opening);
      const slLastRec = nullableDateStr(rawSl.last_reconciled_as_of_date);
      if (
        slScope === null ||
        slProjectId === undefined ||
        slProjectName === undefined ||
        slAccountantRef === undefined ||
        slAccountantName === undefined ||
        slContractType === null ||
        slBalance === null ||
        slDirection === null ||
        slEntries === null ||
        slHasOpening === null ||
        slEligible === null ||
        slLastRec === undefined
      ) {
        return null;
      }
      subLedgers.push({
        ledger_scope: slScope,
        project_id: slProjectId,
        project_display_name: slProjectName,
        accountant_ref: slAccountantRef,
        responsible_accountant_display_name: slAccountantName,
        contract_type: slContractType,
        current_balance_minor: slBalance,
        balance_direction: slDirection,
        entry_count: slEntries,
        has_opening_entry: slHasOpening,
        eligible_for_opening: slEligible,
        last_reconciled_as_of_date: slLastRec,
      });
    }

    vendors.push({
      vendor_id: vendorId,
      display_name: displayName,
      active: itemActive,
      sub_ledger_count: itemSubLedgerCount,
      payable_total_minor: itemPayableTotal,
      advance_total_minor: itemAdvanceTotal,
      shared_advance_balance_minor: itemSharedAdvance,
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

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visScope,
      can_view: true,
      can_record: canRecord,
      can_reconcile: canReconcile,
      can_manage_project_assignments: canManage,
      can_view_shared_advance: canViewShared,
      can_fund_vendor_advance: canFund,
      can_record_vendor_refund: canRefund,
      can_apply_vendor_advance: canApply,
      active_assigned_project_count: assignedCount,
    },
    summary: {
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
    },
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

export function projectVendorFinanceVendorExport(
  value: unknown,
): VendorFinanceVendorExportResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["authorization_date", "filters", "row_cap", "total", "vendors"]) ||
    !isRecord(value.filters) ||
    !exactKeys(value.filters, [
      "search",
      "active",
      "balance_filter",
      "project_id",
      "accountant_ref",
      "ledger_scope",
      "contract_type",
    ]) ||
    !Array.isArray(value.vendors)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const search = nullableStr(value.filters.search);
  const active = value.filters.active;
  const balanceFilter = value.filters.balance_filter;
  const filterProjectId =
    value.filters.project_id === null
      ? null
      : isCanonicalProjectId(value.filters.project_id)
        ? value.filters.project_id
        : undefined;
  const filterAccountantRef = nullableUuidStr(value.filters.accountant_ref);
  const filterLedgerScope = value.filters.ledger_scope;
  const filterContractType = contractTypeFilterVal(value.filters.contract_type);
  const rowCap = posInt(value.row_cap);
  const total = nonNegInt(value.total);

  if (
    authorizationDate === null ||
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
    filterContractType === null ||
    rowCap !== VENDOR_FINANCE_EXPORT_ROW_CAP ||
    total === null ||
    total > VENDOR_FINANCE_EXPORT_ROW_CAP ||
    value.vendors.length !== total
  ) {
    return null;
  }

  const vendors: VendorFinanceExportVendorItem[] = [];
  for (const item of value.vendors) {
    if (
      !isRecord(item) ||
      !exactKeys(item, [
        "vendor_id",
        "display_name",
        "active",
        "sub_ledger_count",
        "payable_total_minor",
        "shared_advance_balance_minor",
        "last_effective_date",
      ])
    ) {
      return null;
    }
    const vendorId = isCanonicalVendorId(item.vendor_id) ? item.vendor_id : null;
    const displayName = nonEmptyStr(item.display_name);
    const itemActive = boolVal(item.active);
    const subLedgerCount = nonNegInt(item.sub_ledger_count);
    const payableTotal = nonNegativeMoneyStr(item.payable_total_minor);
    const sharedAdvance = nonNegativeMoneyStr(item.shared_advance_balance_minor);
    const lastEffectiveDate = nullableDateStr(item.last_effective_date);
    if (
      vendorId === null ||
      displayName === null ||
      itemActive === null ||
      subLedgerCount === null ||
      payableTotal === null ||
      sharedAdvance === null ||
      lastEffectiveDate === undefined
    ) {
      return null;
    }
    vendors.push({
      vendor_id: vendorId,
      display_name: displayName,
      active: itemActive,
      sub_ledger_count: subLedgerCount,
      payable_total_minor: payableTotal,
      shared_advance_balance_minor: sharedAdvance,
      last_effective_date: lastEffectiveDate,
    });
  }

  return {
    authorization_date: authorizationDate,
    filters: {
      search,
      active,
      balance_filter: balanceFilter,
      project_id: filterProjectId,
      accountant_ref: filterAccountantRef,
      ledger_scope: filterLedgerScope,
      contract_type: filterContractType,
    },
    row_cap: rowCap,
    total,
    vendors,
  };
}

function projectDetailSubLedger(value: unknown): VendorFinanceDetailSubLedger | null {
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
  const projectId =
    value.project_id === null
      ? null
      : isCanonicalProjectId(value.project_id)
        ? value.project_id
        : undefined;
  const projectName = nullableStr(value.project_display_name);
  const projectActive =
    value.project_active === null ? null : (boolVal(value.project_active) ?? undefined);
  const accountantRef = nullableUuidStr(value.accountant_ref);
  const accountantName = nullableStr(value.responsible_accountant_display_name);
  const contractType = contractTypeVal(value.contract_type);
  const isActiveAssignment = boolVal(value.is_active_assignment);
  const currentBalance = signedMoneyStr(value.current_balance_minor);
  const direction = balanceDirectionVal(value.balance_direction);
  const latestSeq = nonNegInt(value.latest_sequence);
  const entryCount = nonNegInt(value.entry_count);
  const hasOpening = boolVal(value.has_opening_entry);
  const eligible = boolVal(value.eligible_for_opening);
  const canRecordEntry = boolVal(value.can_record_entry);
  const canApplyVendorAdvance =
    "can_apply_vendor_advance" in value
      ? boolVal(value.can_apply_vendor_advance)
      : Boolean(canRecordEntry && direction === "PAYABLE" && contractType !== "UNCLASSIFIED");
  const canReconcile = boolVal(value.can_reconcile);
  const canClassify = boolVal(value.can_classify_contract_type);
  const classification =
    value.classification === null
      ? null
      : projectSubLedgerClassification(value.classification);
  if (
    ledgerScope === null ||
    projectId === undefined ||
    projectName === undefined ||
    projectActive === undefined ||
    accountantRef === undefined ||
    accountantName === undefined ||
    contractType === null ||
    isActiveAssignment === null ||
    currentBalance === null ||
    direction === null ||
    latestSeq === null ||
    entryCount === null ||
    hasOpening === null ||
    eligible === null ||
    canRecordEntry === null ||
    canApplyVendorAdvance === null ||
    canReconcile === null ||
    canClassify === null ||
    (value.classification !== null && classification === null)
  ) {
    return null;
  }
  return {
    ledger_scope: ledgerScope,
    project_id: projectId,
    project_display_name: projectName,
    project_active: projectActive,
    accountant_ref: accountantRef,
    responsible_accountant_display_name: accountantName,
    contract_type: contractType,
    is_active_assignment: isActiveAssignment,
    current_balance_minor: currentBalance,
    balance_direction: direction,
    latest_sequence: latestSeq,
    entry_count: entryCount,
    has_opening_entry: hasOpening,
    eligible_for_opening: eligible,
    can_record_entry: canRecordEntry,
    can_apply_vendor_advance: canApplyVendorAdvance,
    can_reconcile: canReconcile,
    can_classify_contract_type: canClassify,
    classification,
  };
}

export function projectVendorFinanceVendorDetail(
  value: unknown,
): VendorFinanceVendorDetailResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "allowed_actions",
      "selected_sub_ledger",
      "sub_ledgers",
      "vendor",
    ]) ||
    !isRecord(value.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      value.allowed_actions,
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
    !Array.isArray(value.allowed_actions.allowed_entry_types) ||
    !Array.isArray(value.sub_ledgers) ||
    !isRecord(value.vendor) ||
    !requiredAndOptionalKeysOnly(
      value.vendor,
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
    !isRecord(value.vendor.totals) ||
    !requiredAndOptionalKeysOnly(
      value.vendor.totals,
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
    !Array.isArray(value.vendor.recent_reconciliations)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const visScope = visibilityScopeVal(value.allowed_actions.visibility_scope);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const canReconcile = boolVal(value.allowed_actions.can_reconcile);
  const canManage = boolVal(value.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_fund_vendor_advance)
      : false;
  const canRefund =
    "can_record_vendor_refund" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_record_vendor_refund)
      : false;
  const canApply =
    "can_apply_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const allowedEntryTypes: NormalVendorFinanceEntryType[] = [];
  for (const rawType of value.allowed_actions.allowed_entry_types) {
    if (
      typeof rawType !== "string" ||
      !(NORMAL_VENDOR_FINANCE_ENTRY_TYPES as readonly string[]).includes(rawType)
    ) {
      return null;
    }
    allowedEntryTypes.push(rawType as NormalVendorFinanceEntryType);
  }

  const selectedSubLedger =
    value.selected_sub_ledger === null
      ? null
      : projectDetailSubLedger(value.selected_sub_ledger);
  if (value.selected_sub_ledger !== null && selectedSubLedger === null) return null;

  const subLedgers: VendorFinanceDetailSubLedger[] = [];
  for (const rawSl of value.sub_ledgers) {
    const projected = projectDetailSubLedger(rawSl);
    if (!projected) return null;
    subLedgers.push(projected);
  }

  const v = value.vendor;
  if (!isRecord(v.totals) || !Array.isArray(v.recent_reconciliations)) {
    return null;
  }
  const vendorId = isCanonicalVendorId(v.vendor_id) ? v.vendor_id : null;
  const displayName = nonEmptyStr(v.display_name);
  const active = boolVal(v.active);
  const sharedAdvanceBalance =
    "shared_advance_balance_minor" in v
      ? nonNegativeMoneyStr(v.shared_advance_balance_minor)
      : "0";
  const sharedAdvanceLatestSeq =
    "shared_advance_latest_sequence" in v
      ? nonNegInt(v.shared_advance_latest_sequence)
      : 0;
  const sharedAdvanceMovCount =
    "shared_advance_movement_count" in v
      ? nonNegInt(v.shared_advance_movement_count)
      : 0;
  const currentBalance = signedMoneyStr(v.current_balance_minor);
  const direction = listBalanceDirectionVal(v.balance_direction);
  const latestSeq = nonNegInt(v.latest_sequence);
  const entryCount = nonNegInt(v.entry_count);
  const hasOpening = boolVal(v.has_opening_entry);
  const eligible = boolVal(v.eligible_for_opening);

  const t = v.totals;
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
      : projectVendorReconciliation(v.latest_reconciliation);

  const recentRecs: VendorFinanceReconciliationProjection[] = [];
  for (const item of v.recent_reconciliations) {
    const projected = projectVendorReconciliation(item);
    if (!projected) return null;
    recentRecs.push(projected);
  }

  if (
    authorizationDate === null ||
    visScope === null ||
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
    sharedAdvanceBalance === null ||
    sharedAdvanceLatestSeq === null ||
    sharedAdvanceMovCount === null ||
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

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visScope,
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
      shared_advance_balance_minor: sharedAdvanceBalance,
      shared_advance_latest_sequence: sharedAdvanceLatestSeq,
      shared_advance_movement_count: sharedAdvanceMovCount,
      current_balance_minor: currentBalance,
      balance_direction: direction,
      latest_sequence: latestSeq,
      entry_count: entryCount,
      has_opening_entry: hasOpening,
      eligible_for_opening: eligible,
      totals: {
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
      },
      latest_reconciliation: latestRec,
      recent_reconciliations: recentRecs,
    },
  };
}

export function projectVendorFinanceEntriesPage(
  value: unknown,
  cursorScope?: VendorEntriesCursorScope,
): VendorFinanceEntriesPageResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "vendor_id",
      "page_size",
      "has_more",
      "next_before_sequence",
      "entries",
    ]) ||
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const pageSize = posInt(value.page_size);
  const hasMore = boolVal(value.has_more);
  const nextBeforeSeq =
    value.next_before_sequence === null ? null : posInt(value.next_before_sequence);

  if (
    authorizationDate === null ||
    vendorId === null ||
    pageSize === null ||
    hasMore === null ||
    (value.next_before_sequence !== null && nextBeforeSeq === null) ||
    (hasMore && nextBeforeSeq === null) ||
    (!hasMore && nextBeforeSeq !== null)
  ) {
    return null;
  }

  const entries: VendorFinanceEntryProjection[] = [];
  for (const item of value.entries) {
    const projected = projectVendorFinanceEntry(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    entries.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor:
      hasMore && nextBeforeSeq !== null
        ? encodeVendorEntriesCursor({
            vendor_id: vendorId,
            before_sequence: nextBeforeSeq,
            project_id: cursorScope?.project_id ?? null,
            accountant_ref: cursorScope?.accountant_ref ?? null,
            ledger_scope: cursorScope?.ledger_scope ?? null,
            contract_type: cursorScope?.contract_type ?? null,
            month: cursorScope?.month ?? null,
          })
        : null,
    entries,
  };
}

export function projectVendorFinanceSingleEntry(
  value: unknown,
): VendorFinanceSingleEntryResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["authorization_date", "allowed_actions", "entry"]) ||
    !isRecord(value.allowed_actions) ||
    !exactKeys(value.allowed_actions, ["visibility_scope", "can_view", "can_record"])
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const visScope = visibilityScopeVal(value.allowed_actions.visibility_scope);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const entry = projectVendorFinanceEntry(value.entry);
  if (
    authorizationDate === null ||
    visScope === null ||
    canView !== true ||
    canRecord === null ||
    entry === null
  ) {
    return null;
  }
  return {
    authorization_date: authorizationDate,
    allowed_actions: { visibility_scope: visScope, can_view: true, can_record: canRecord },
    entry,
  };
}

export function projectVendorReconciliationsPage(
  value: unknown,
): VendorFinanceReconciliationsPageResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "vendor_id",
      "page",
      "page_size",
      "total",
      "has_more",
      "reconciliations",
    ]) ||
    !Array.isArray(value.reconciliations)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);
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
  for (const item of value.reconciliations) {
    const projected = projectVendorReconciliation(item);
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

export function projectRecordEntryMutation(
  value: unknown,
): { entry: VendorFinanceEntryProjection; replayed: boolean } | null {
  if (!isRecord(value) || !exactKeys(value, ["entry", "replayed"])) return null;
  const entry = projectVendorFinanceEntry(value.entry);
  const replayed = boolVal(value.replayed);
  if (!entry || replayed === null) return null;
  return { entry, replayed };
}

export function projectSharedAdvanceMovementsPage(
  value: unknown,
  movementType?: VendorFinanceSharedAdvanceMovementType | null,
): VendorFinanceSharedAdvanceMovementsPageResponse | null {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeysOnly(
      value,
      [
        "authorization_date",
        "vendor_id",
        "shared_advance_balance_minor",
        "page_size",
        "has_more",
        "next_before_sequence",
        "movements",
      ],
      ["shared_advance_latest_sequence"],
    ) ||
    !Array.isArray(value.movements)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const vendorId = isCanonicalVendorId(value.vendor_id) ? value.vendor_id : null;
  const sharedAdvanceBalance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
  const pageSize = posInt(value.page_size);
  const hasMore = boolVal(value.has_more);
  const nextBeforeSeq =
    value.next_before_sequence === null ? null : posInt(value.next_before_sequence);

  if (
    authorizationDate === null ||
    vendorId === null ||
    sharedAdvanceBalance === null ||
    pageSize === null ||
    hasMore === null ||
    (value.next_before_sequence !== null && nextBeforeSeq === null) ||
    (hasMore && nextBeforeSeq === null) ||
    (!hasMore && nextBeforeSeq !== null)
  ) {
    return null;
  }

  const movements: VendorFinanceSharedAdvanceMovementProjection[] = [];
  for (const item of value.movements) {
    const projected = projectSharedAdvanceMovement(item);
    if (!projected || projected.vendor_id !== vendorId) return null;
    movements.push(projected);
  }

  return {
    authorization_date: authorizationDate,
    vendor_id: vendorId,
    shared_advance_balance_minor: sharedAdvanceBalance,
    page_size: pageSize,
    has_more: hasMore,
    next_cursor:
      hasMore && nextBeforeSeq !== null
        ? encodeSharedAdvanceMovementsCursor({
            vendor_id: vendorId,
            before_sequence: nextBeforeSeq,
            movement_type: movementType ?? null,
          })
        : null,
    movements,
  };
}

export function projectFundSharedAdvanceMutation(
  value: unknown,
): VendorFinanceFundSharedAdvanceResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["movement", "shared_advance_balance_minor", "replayed"])
  ) {
    return null;
  }
  const movement = projectSharedAdvanceMovement(value.movement);
  const balance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
  const replayed = boolVal(value.replayed);
  if (!movement || balance === null || replayed === null) return null;
  return { movement, shared_advance_balance_minor: balance, replayed };
}

export function projectRecordVendorRefundMutation(
  value: unknown,
): VendorFinanceRecordVendorRefundResponse | null {
  return projectFundSharedAdvanceMutation(value);
}

export function projectApplySharedAdvanceOffsetMutation(
  value: unknown,
): VendorFinanceApplySharedAdvanceOffsetResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "movement",
      "entry",
      "shared_advance_balance_minor",
      "replayed",
    ])
  ) {
    return null;
  }
  const movement = projectSharedAdvanceMovement(value.movement);
  const entry = projectVendorFinanceEntry(value.entry);
  const balance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
  const replayed = boolVal(value.replayed);
  if (!movement || !entry || balance === null || replayed === null) return null;
  return { movement, entry, shared_advance_balance_minor: balance, replayed };
}

export function projectRecordPaymentWithOffsetMutation(
  value: unknown,
): VendorFinanceRecordPaymentWithOffsetResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "payment_entry",
      "offset_entry",
      "movement",
      "shared_advance_balance_minor",
      "replayed",
    ])
  ) {
    return null;
  }
  const paymentEntry = projectVendorFinanceEntry(value.payment_entry);
  const offsetEntry = projectVendorFinanceEntry(value.offset_entry);
  const movement = projectSharedAdvanceMovement(value.movement);
  const balance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
  const replayed = boolVal(value.replayed);
  if (
    !paymentEntry ||
    !offsetEntry ||
    !movement ||
    balance === null ||
    replayed === null ||
    paymentEntry.entry_type !== "PAYMENT_RECORDED" ||
    offsetEntry.entry_type !== "ADVANCE_OFFSET_RECORDED" ||
    movement.movement_type !== "PROJECT_OFFSET_APPLIED" ||
    movement.project_entry_id !== offsetEntry.entry_id ||
    paymentEntry.entry_id === offsetEntry.entry_id
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

export function projectReverseEntryMutation(
  value: unknown,
): {
  reversal_entry: VendorFinanceEntryProjection;
  reversed_entry: VendorFinanceEntryProjection;
  reversal_movement?: VendorFinanceSharedAdvanceMovementProjection;
  reversed_movement?: VendorFinanceSharedAdvanceMovementProjection;
  shared_advance_balance_minor?: string;
  replayed: boolean;
} | null {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeysOnly(
      value,
      ["reversal_entry", "reversed_entry", "replayed"],
      ["reversal_movement", "reversed_movement", "shared_advance_balance_minor"],
    )
  ) {
    return null;
  }
  const reversal = projectVendorFinanceEntry(value.reversal_entry);
  const reversed = projectVendorFinanceEntry(value.reversed_entry);
  const replayed = boolVal(value.replayed);
  if (!reversal || !reversed || replayed === null) return null;

  const hasMovFields =
    "reversal_movement" in value ||
    "reversed_movement" in value ||
    "shared_advance_balance_minor" in value;
  if (hasMovFields) {
    const revMov = projectSharedAdvanceMovement(value.reversal_movement);
    const origMov = projectSharedAdvanceMovement(value.reversed_movement);
    const sharedBalance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
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

export function projectReverseSharedAdvanceMovementMutation(
  value: unknown,
): VendorFinanceReverseSharedAdvanceMovementResponse | null {
  if (
    !isRecord(value) ||
    !requiredAndOptionalKeysOnly(
      value,
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
  const revMov = projectSharedAdvanceMovement(value.reversal_movement);
  const origMov = projectSharedAdvanceMovement(value.reversed_movement);
  const sharedBalance = nonNegativeMoneyStr(value.shared_advance_balance_minor);
  const replayed = boolVal(value.replayed);
  if (!revMov || !origMov || sharedBalance === null || replayed === null) return null;

  const hasEntryFields = "reversal_entry" in value || "reversed_entry" in value;
  if (hasEntryFields) {
    const revEntry = projectVendorFinanceEntry(value.reversal_entry);
    const origEntry = projectVendorFinanceEntry(value.reversed_entry);
    if (!revEntry || !origEntry) return null;
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

export function projectOpeningPreview(
  value: unknown,
): VendorFinanceOpeningPreviewResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
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
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const projectId = isCanonicalProjectId(value.project_id) ? value.project_id : null;
  const projectDisplayName = nonEmptyStr(value.project_display_name);
  const accountantRef = uuidStr(value.accountant_ref);
  const accountantName = nonEmptyStr(value.responsible_accountant_display_name);
  const contractType = classifiedContractTypeVal(value.contract_type);
  const cutoffDate = dateStr(value.cutoff_date);
  const vendorCount = posInt(value.vendor_count);
  const skippedZero = nonNegInt(value.skipped_zero_count);
  const totalPayable = nonNegativeMoneyStr(value.total_payable_minor);
  const totalAdvance = nonNegativeMoneyStr(value.total_advance_minor);
  const netBalance = signedMoneyStr(value.net_balance_minor);
  if (
    authorizationDate === null ||
    projectId === null ||
    projectDisplayName === null ||
    accountantRef === null ||
    accountantName === null ||
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
  for (const rawItem of value.items) {
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
    const vendorId = isCanonicalVendorId(rawItem.vendor_id) ? rawItem.vendor_id : null;
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
    responsible_accountant_display_name: accountantName,
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

export function projectOpeningApplyMutation(
  value: unknown,
): VendorFinanceOpeningApplyResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["batch", "entries", "replayed"]) ||
    !isRecord(value.batch) ||
    !exactKeys(value.batch, [
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
    !Array.isArray(value.entries)
  ) {
    return null;
  }

  const b = value.batch;
  const batchId = uuidStr(b.batch_id);
  const ledgerScope = ledgerScopeVal(b.ledger_scope);
  const projectId =
    b.project_id === null
      ? null
      : isCanonicalProjectId(b.project_id)
        ? b.project_id
        : undefined;
  const projectDisplayName = nullableStr(b.project_display_name_snapshot);
  const accountantRef = nullableUuidStr(b.accountant_ref);
  const accountantName = nullableStr(b.responsible_accountant_display_name);
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
  const replayed = boolVal(value.replayed);

  if (
    batchId === null ||
    ledgerScope === null ||
    projectId === undefined ||
    projectDisplayName === undefined ||
    accountantRef === undefined ||
    accountantName === undefined ||
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
  for (const item of value.entries) {
    const projected = projectVendorFinanceEntry(item);
    if (!projected) return null;
    entries.push(projected);
  }
  if (entries.length !== vendorCount) return null;

  return {
    batch: {
      batch_id: batchId,
      ledger_scope: ledgerScope,
      project_id: projectId,
      project_display_name_snapshot: projectDisplayName,
      accountant_ref: accountantRef,
      responsible_accountant_display_name: accountantName,
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

export function projectCreateReconciliationMutation(
  value: unknown,
): { reconciliation: VendorFinanceReconciliationProjection; replayed: boolean } | null {
  if (!isRecord(value) || !exactKeys(value, ["reconciliation", "replayed"])) return null;
  const reconciliation = projectVendorReconciliation(value.reconciliation);
  const replayed = boolVal(value.replayed);
  if (!reconciliation || replayed === null) return null;
  return { reconciliation, replayed };
}

export function projectClassifySubLedgerMutation(
  value: unknown,
): VendorFinanceClassifySubLedgerResponse | null {
  if (!isRecord(value) || !exactKeys(value, ["classification", "replayed"])) return null;
  const classification = projectSubLedgerClassification(value.classification);
  const replayed = boolVal(value.replayed);
  if (!classification || replayed === null) return null;
  return { classification, replayed };
}

export function projectMonthlyReport(value: unknown): VendorFinanceMonthlyReportResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "allowed_actions",
      "filters",
      "totals",
      "project_accountant_summaries",
      "rows",
      "legacy_unallocated_rows",
    ]) ||
    !isRecord(value.allowed_actions) ||
    !requiredAndOptionalKeysOnly(
      value.allowed_actions,
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
    !isRecord(value.filters) ||
    !exactKeys(value.filters, [
      "month",
      "project_id",
      "accountant_ref",
      "vendor_id",
      "contract_type",
    ]) ||
    !isRecord(value.totals) ||
    !requiredAndOptionalKeysOnly(
      value.totals,
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
    !Array.isArray(value.project_accountant_summaries) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.legacy_unallocated_rows)
  ) {
    return null;
  }

  const authorizationDate = dateStr(value.authorization_date);
  const visScope = visibilityScopeVal(value.allowed_actions.visibility_scope);
  const canView = boolVal(value.allowed_actions.can_view);
  const canRecord = boolVal(value.allowed_actions.can_record);
  const canReconcile = boolVal(value.allowed_actions.can_reconcile);
  const canManage = boolVal(value.allowed_actions.can_manage_project_assignments);
  const canViewShared =
    "can_view_shared_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_view_shared_advance)
      : true;
  const canFund =
    "can_fund_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_fund_vendor_advance)
      : false;
  const canRefund =
    "can_record_vendor_refund" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_record_vendor_refund)
      : false;
  const canApply =
    "can_apply_vendor_advance" in value.allowed_actions
      ? boolVal(value.allowed_actions.can_apply_vendor_advance)
      : canRecord;
  const assignedCount =
    "active_assigned_project_count" in value.allowed_actions
      ? nonNegInt(value.allowed_actions.active_assigned_project_count)
      : undefined;

  const monthParsed = parseCalendarMonthParam(value.filters.month);
  const filterProjectId =
    value.filters.project_id === null
      ? null
      : isCanonicalProjectId(value.filters.project_id)
        ? value.filters.project_id
        : undefined;
  const filterAccountantRef = nullableUuidStr(value.filters.accountant_ref);
  const filterVendorId =
    value.filters.vendor_id === null
      ? null
      : isCanonicalVendorId(value.filters.vendor_id)
        ? value.filters.vendor_id
        : undefined;
  const filterContractType = contractTypeFilterVal(value.filters.contract_type);

  const t = value.totals;
  const bookCount = nonNegInt(t.project_accountant_book_count);
  const subLedgerCount = nonNegInt(t.sub_ledger_count);
  const obligationsMinor = nonNegativeMoneyStr(t.obligations_in_month_minor);
  const paidMinor = nonNegativeMoneyStr(t.paid_in_month_minor);
  const advancedMinor = nonNegativeMoneyStr(t.advanced_in_month_minor);
  const advanceOffsetMinor =
    "advance_offset_in_month_minor" in t
      ? nonNegativeMoneyStr(t.advance_offset_in_month_minor)
      : "0";
  const paidAndAdvMinor = nonNegativeMoneyStr(t.paid_and_advanced_in_month_minor);
  const closingPayableMinor = nonNegativeMoneyStr(t.closing_payable_minor);
  const closingAdvanceMinor = nonNegativeMoneyStr(t.closing_advance_minor);

  if (
    authorizationDate === null ||
    visScope === null ||
    canView !== true ||
    canRecord === null ||
    canReconcile === null ||
    canManage === null ||
    canViewShared === null ||
    canFund === null ||
    canRefund === null ||
    canApply === null ||
    assignedCount === null ||
    !monthParsed.ok ||
    filterProjectId === undefined ||
    filterAccountantRef === undefined ||
    filterVendorId === undefined ||
    filterContractType === null ||
    t.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
    t.project_revenue_minor !== null ||
    bookCount === null ||
    subLedgerCount === null ||
    obligationsMinor === null ||
    paidMinor === null ||
    advancedMinor === null ||
    advanceOffsetMinor === null ||
    paidAndAdvMinor === null ||
    closingPayableMinor === null ||
    closingAdvanceMinor === null
  ) {
    return null;
  }

  const summaries: VendorFinanceMonthlyReportAccountantSummary[] = [];
  for (const rawSum of value.project_accountant_summaries) {
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
    const projectId = isCanonicalProjectId(rawSum.project_id) ? rawSum.project_id : null;
    const projectName = nonEmptyStr(rawSum.project_display_name);
    const projectActive = boolVal(rawSum.project_active);
    const accountantRef = uuidStr(rawSum.accountant_ref);
    const accountantName = nonEmptyStr(rawSum.responsible_accountant_display_name);
    const contractType = contractTypeVal(rawSum.contract_type);
    const isCurrentlyAssigned = boolVal(rawSum.is_currently_assigned);
    const vendorCount = nonNegInt(rawSum.vendor_count);
    const sObligations = nonNegativeMoneyStr(rawSum.obligations_in_month_minor);
    const sPaid = nonNegativeMoneyStr(rawSum.paid_in_month_minor);
    const sAdv = nonNegativeMoneyStr(rawSum.advanced_in_month_minor);
    const sAdvOffset =
      "advance_offset_in_month_minor" in rawSum
        ? nonNegativeMoneyStr(rawSum.advance_offset_in_month_minor)
        : "0";
    const sPaidAdv = nonNegativeMoneyStr(rawSum.paid_and_advanced_in_month_minor);
    const sClosingPayable = nonNegativeMoneyStr(rawSum.closing_payable_minor);
    const sClosingAdvance = nonNegativeMoneyStr(rawSum.closing_advance_minor);
    const sEntryCount = nonNegInt(rawSum.in_month_entry_count);
    if (
      projectId === null ||
      projectName === null ||
      projectActive === null ||
      accountantRef === null ||
      accountantName === null ||
      contractType === null ||
      isCurrentlyAssigned === null ||
      rawSum.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
      rawSum.project_revenue_minor !== null ||
      vendorCount === null ||
      sObligations === null ||
      sPaid === null ||
      sAdv === null ||
      sAdvOffset === null ||
      sPaidAdv === null ||
      sClosingPayable === null ||
      sClosingAdvance === null ||
      sEntryCount === null
    ) {
      return null;
    }
    summaries.push({
      project_id: projectId,
      project_display_name: projectName,
      project_active: projectActive,
      accountant_ref: accountantRef,
      responsible_accountant_display_name: accountantName,
      contract_type: contractType,
      is_currently_assigned: isCurrentlyAssigned,
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      vendor_count: vendorCount,
      obligations_in_month_minor: sObligations,
      paid_in_month_minor: sPaid,
      advanced_in_month_minor: sAdv,
      advance_offset_in_month_minor: sAdvOffset,
      paid_and_advanced_in_month_minor: sPaidAdv,
      closing_payable_minor: sClosingPayable,
      closing_advance_minor: sClosingAdvance,
      in_month_entry_count: sEntryCount,
    });
  }

  const rows: VendorFinanceMonthlyReportRow[] = [];
  for (const rawRow of value.rows) {
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
          "contract_type",
          "is_currently_assigned",
          "vendor_id",
          "vendor_display_name",
          "vendor_active",
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
    const projectId = isCanonicalProjectId(rawRow.project_id) ? rawRow.project_id : null;
    const projectName = nonEmptyStr(rawRow.project_display_name);
    const projectActive = boolVal(rawRow.project_active);
    const accountantRef = uuidStr(rawRow.accountant_ref);
    const accountantName = nonEmptyStr(rawRow.responsible_accountant_display_name);
    const contractType = contractTypeVal(rawRow.contract_type);
    const isCurrentlyAssigned = boolVal(rawRow.is_currently_assigned);
    const vendorId = isCanonicalVendorId(rawRow.vendor_id) ? rawRow.vendor_id : null;
    const vendorName = nonEmptyStr(rawRow.vendor_display_name);
    const vendorActive = boolVal(rawRow.vendor_active);
    const balBefore = signedMoneyStr(rawRow.balance_before_month_minor);
    const openPay = nonNegativeMoneyStr(rawRow.opening_payable_in_month_minor);
    const openAdv = nonNegativeMoneyStr(rawRow.opening_advance_in_month_minor);
    const rObligations = nonNegativeMoneyStr(rawRow.obligations_in_month_minor);
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
    const rClosingPay = nonNegativeMoneyStr(rawRow.closing_payable_minor);
    const rClosingAdv = nonNegativeMoneyStr(rawRow.closing_advance_minor);
    const currentBal = signedMoneyStr(rawRow.current_balance_minor);
    const inMonthEntries = nonNegInt(rawRow.in_month_entry_count);
    const totalEntries = nonNegInt(rawRow.total_entry_count);

    if (
      projectId === null ||
      projectName === null ||
      projectActive === null ||
      accountantRef === null ||
      accountantName === null ||
      contractType === null ||
      isCurrentlyAssigned === null ||
      vendorId === null ||
      vendorName === null ||
      vendorActive === null ||
      rawRow.project_revenue_status !== "MISSING_CANONICAL_SOURCE" ||
      rawRow.project_revenue_minor !== null ||
      balBefore === null ||
      openPay === null ||
      openAdv === null ||
      rObligations === null ||
      rPaid === null ||
      rAdv === null ||
      rAdvOffset === null ||
      rPaidAdv === null ||
      netChange === null ||
      closingBal === null ||
      closingDir === null ||
      rClosingPay === null ||
      rClosingAdv === null ||
      currentBal === null ||
      inMonthEntries === null ||
      totalEntries === null
    ) {
      return null;
    }

    rows.push({
      project_id: projectId,
      project_display_name: projectName,
      project_active: projectActive,
      accountant_ref: accountantRef,
      responsible_accountant_display_name: accountantName,
      contract_type: contractType,
      is_currently_assigned: isCurrentlyAssigned,
      vendor_id: vendorId,
      vendor_display_name: vendorName,
      vendor_active: vendorActive,
      project_revenue_status: "MISSING_CANONICAL_SOURCE",
      project_revenue_minor: null,
      balance_before_month_minor: balBefore,
      opening_payable_in_month_minor: openPay,
      opening_advance_in_month_minor: openAdv,
      obligations_in_month_minor: rObligations,
      paid_in_month_minor: rPaid,
      advanced_in_month_minor: rAdv,
      advance_offset_in_month_minor: rAdvOffset,
      paid_and_advanced_in_month_minor: rPaidAdv,
      net_change_in_month_minor: netChange,
      closing_balance_minor: closingBal,
      closing_direction: closingDir,
      closing_payable_minor: rClosingPay,
      closing_advance_minor: rClosingAdv,
      current_balance_minor: currentBal,
      in_month_entry_count: inMonthEntries,
      total_entry_count: totalEntries,
    });
  }

  const legacyRows: VendorFinanceMonthlyLegacyRow[] = [];
  for (const rawLeg of value.legacy_unallocated_rows) {
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
    const vendorId = isCanonicalVendorId(rawLeg.vendor_id) ? rawLeg.vendor_id : null;
    const vendorName = nonEmptyStr(rawLeg.vendor_display_name);
    const vendorActive = boolVal(rawLeg.vendor_active);
    const balBefore = signedMoneyStr(rawLeg.balance_before_month_minor);
    const obligations = nonNegativeMoneyStr(rawLeg.obligations_in_month_minor);
    const paidAdv = nonNegativeMoneyStr(rawLeg.paid_and_advanced_in_month_minor);
    const closingBal = signedMoneyStr(rawLeg.closing_balance_minor);
    const closingDir = balanceDirectionVal(rawLeg.closing_direction);
    const entryCount = nonNegInt(rawLeg.in_month_entry_count);
    if (
      vendorId === null ||
      vendorName === null ||
      vendorActive === null ||
      balBefore === null ||
      obligations === null ||
      paidAdv === null ||
      closingBal === null ||
      closingDir === null ||
      entryCount === null
    ) {
      return null;
    }
    legacyRows.push({
      vendor_id: vendorId,
      vendor_display_name: vendorName,
      vendor_active: vendorActive,
      balance_before_month_minor: balBefore,
      obligations_in_month_minor: obligations,
      paid_and_advanced_in_month_minor: paidAdv,
      closing_balance_minor: closingBal,
      closing_direction: closingDir,
      in_month_entry_count: entryCount,
    });
  }

  return {
    authorization_date: authorizationDate,
    allowed_actions: {
      visibility_scope: visScope,
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
      month: monthParsed.month,
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
      obligations_in_month_minor: obligationsMinor,
      paid_in_month_minor: paidMinor,
      advanced_in_month_minor: advancedMinor,
      advance_offset_in_month_minor: advanceOffsetMinor,
      paid_and_advanced_in_month_minor: paidAndAdvMinor,
      closing_payable_minor: closingPayableMinor,
      closing_advance_minor: closingAdvanceMinor,
    },
    project_accountant_summaries: summaries,
    rows,
    legacy_unallocated_rows: legacyRows,
  };
}

function projectAssignmentItem(
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
  const projectId = isCanonicalProjectId(value.project_id) ? value.project_id : null;
  const version = posInt(value.version);
  const accountant = projectAccountSummary(value.accountant);
  const inAccountingDept = boolVal(value.accountant_in_accounting_department);
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
    inAccountingDept === null ||
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
    accountant_in_accounting_department: inAccountingDept,
    valid_from: validFrom,
    valid_to: validTo,
    state,
    assign_reason: assignReason,
    end_reason: endReason,
    created_at: createdAt,
  };
}

export function projectListProjectAccountantsAdmin(
  value: unknown,
): VendorFinanceListProjectAccountantsAdminResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "eligible_accountants",
      "page",
      "page_size",
      "total",
      "has_more",
      "projects",
    ]) ||
    !Array.isArray(value.eligible_accountants) ||
    !Array.isArray(value.projects)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);
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
  for (const item of value.eligible_accountants) {
    const projected = projectAccountSummary(item);
    if (!projected) return null;
    eligibleAccountants.push(projected);
  }

  const projects: VendorFinanceProjectAccountantsAdminProject[] = [];
  for (const rawProj of value.projects) {
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
    const projectId = isCanonicalProjectId(rawProj.project_id) ? rawProj.project_id : null;
    const displayName = nonEmptyStr(rawProj.display_name);
    const active = boolVal(rawProj.active);
    const nextVersion = posInt(rawProj.next_version);
    const transactedCount = nonNegInt(rawProj.transacted_vendor_count);
    const currentAssignment =
      rawProj.current_assignment === null
        ? null
        : projectAssignmentItem(rawProj.current_assignment);
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
    for (const rawAss of rawProj.assignments) {
      const projected = projectAssignmentItem(rawAss);
      if (!projected || projected.project_id !== projectId) return null;
      assignments.push(projected);
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

export function projectAssignProjectAccountantMutation(
  value: unknown,
): VendorFinanceAssignProjectAccountantResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["assignment_id", "project_id", "version", "replayed"])
  ) {
    return null;
  }
  const assignmentId = uuidStr(value.assignment_id);
  const projectId = isCanonicalProjectId(value.project_id) ? value.project_id : null;
  const version = posInt(value.version);
  const replayed = boolVal(value.replayed);
  if (assignmentId === null || projectId === null || version === null || replayed === null) {
    return null;
  }
  return { assignment_id: assignmentId, project_id: projectId, version, replayed };
}

export function projectEndProjectAccountantMutation(
  value: unknown,
): VendorFinanceEndProjectAccountantResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["assignment_id", "project_id", "valid_to", "replayed"])
  ) {
    return null;
  }
  const assignmentId = uuidStr(value.assignment_id);
  const projectId = isCanonicalProjectId(value.project_id) ? value.project_id : null;
  const validTo = dateStr(value.valid_to);
  const replayed = boolVal(value.replayed);
  if (assignmentId === null || projectId === null || validTo === null || replayed === null) {
    return null;
  }
  return { assignment_id: assignmentId, project_id: projectId, valid_to: validTo, replayed };
}

export function projectListGlobalRolesAdmin(
  value: unknown,
): VendorFinanceListGlobalRolesAdminResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authorization_date",
      "page",
      "page_size",
      "total",
      "has_more",
      "roles",
      "candidates",
    ]) ||
    !Array.isArray(value.roles) ||
    !Array.isArray(value.candidates)
  ) {
    return null;
  }
  const authorizationDate = dateStr(value.authorization_date);
  const page = posInt(value.page);
  const pageSize = posInt(value.page_size);
  const total = nonNegInt(value.total);
  const hasMore = boolVal(value.has_more);
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
  for (const rawRole of value.roles) {
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
    const account = projectAccountSummary(rawRole.account);
    const roleCode = globalRoleVal(rawRole.role_code);
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
  for (const rawCand of value.candidates) {
    if (
      !isRecord(rawCand) ||
      !exactKeys(rawCand, ["account", "next_version", "has_open_role"])
    ) {
      return null;
    }
    const account = projectAccountSummary(rawCand.account);
    const nextVersion = posInt(rawCand.next_version);
    const hasOpenRole = boolVal(rawCand.has_open_role);
    if (account === null || nextVersion === null || hasOpenRole === null) {
      return null;
    }
    candidates.push({ account, next_version: nextVersion, has_open_role: hasOpenRole });
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

export function projectAssignGlobalRoleMutation(
  value: unknown,
): VendorFinanceAssignGlobalRoleResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["role_grant_id", "account_ref", "role_code", "version", "replayed"])
  ) {
    return null;
  }
  const roleGrantId = uuidStr(value.role_grant_id);
  const accountRef = uuidStr(value.account_ref);
  const roleCode = globalRoleVal(value.role_code);
  const version = posInt(value.version);
  const replayed = boolVal(value.replayed);
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

export function projectEndGlobalRoleMutation(
  value: unknown,
): VendorFinanceEndGlobalRoleResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["role_grant_id", "account_ref", "valid_to", "replayed"])
  ) {
    return null;
  }
  const roleGrantId = uuidStr(value.role_grant_id);
  const accountRef = uuidStr(value.account_ref);
  const validTo = dateStr(value.valid_to);
  const replayed = boolVal(value.replayed);
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
