import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";
import { VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI } from "./vendor-finance-contract.ts";
import {
  VENDOR_FINANCE_EXPORT_COLUMNS,
  VENDOR_FINANCE_EXPORT_WORKSHEET_NAME,
  VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE,
  buildVendorFinanceExportXlsx,
} from "./vendor-finance-xlsx.ts";
import {
  MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES,
  handleGetDownloadVendorFinanceEvidence,
  handleGetExportVendorFinanceVendors,
  handleGetGlobalRolesAdmin,
  handleGetProjectAccountantsAdmin,
  handleGetVendorFinanceContext,
  handleGetVendorFinanceEntries,
  handleGetVendorFinanceMonthlyReport,
  handleGetVendorFinanceSingleEntry,
  handleGetVendorFinanceVendorDetail,
  handleGetVendorFinanceVendors,
  handleGetVendorReconciliations,
  handleGetVendorSharedAdvanceMovements,
  handlePostApplyOpeningBatch,
  handlePostApplyVendorSharedAdvanceOffset,
  handlePostAssignGlobalRoleAdmin,
  handlePostAssignProjectAccountantAdmin,
  handlePostClassifyVendorSubLedger,
  handlePostEndGlobalRoleAdmin,
  handlePostEndProjectAccountantAdmin,
  handlePostFinalizeVendorFinanceEvidence,
  handlePostFundVendorSharedAdvance,
  handlePostPreviewOpeningBatch,
  handlePostRecordVendorPaymentWithOffset,
  handlePostRecordVendorRefund,
  handlePostReserveVendorFinanceEvidence,
  handlePostReverseVendorFinanceEntry,
  handlePostReverseVendorSharedAdvanceMovement,
  handlePostVendorFinanceEntry,
  handlePostVendorReconciliation,
} from "./vendor-finance-api.ts";
import { createVendorFinanceRepository } from "./vendor-finance-repository.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
});

const AUTH_ID = "10000000-0000-4000-8000-000000000001";
const APP_ID = "20000000-0000-4000-8000-000000000001";
const ACC_A_ID = "21000000-0000-4000-8000-000000000001";
const ENTRY_ID = "30000000-0000-4000-8000-000000000001";
const REV_ENTRY_ID = "30000000-0000-4000-8000-000000000002";
const REC_ID = "40000000-0000-4000-8000-000000000001";
const BATCH_ID = "50000000-0000-4000-8000-000000000001";
const EV_ID_1 = "60000000-0000-4000-8000-000000000001";
const EV_ID_2 = "60000000-0000-4000-8000-000000000002";
const IDEM_1 = "70000000-0000-4000-8000-000000000001";
const IDEM_2 = "70000000-0000-4000-8000-000000000002";
const IDEM_3 = "70000000-0000-4000-8000-000000000003";
const ASGN_ID = "80000000-0000-4000-8000-000000000001";
const ROLE_ID = "82000000-0000-4000-8000-000000000001";
const PROJECT_ID = "PRJ_NORTH";

const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const VALID_PNG_SHA = createHash("sha256").update(VALID_PNG).digest("hex");

const EXPECTED_ROUTE_METHODS = Object.freeze({
  "src/app/api/vendor-finance/context/route.ts": {
    GET: "handleGetVendorFinanceContext",
  },
  "src/app/api/vendor-finance/vendors/route.ts": {
    GET: "handleGetVendorFinanceVendors",
  },
  "src/app/api/vendor-finance/vendors/export/route.ts": {
    GET: "handleGetExportVendorFinanceVendors",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/route.ts": {
    GET: "handleGetVendorFinanceVendorDetail",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/entries/route.ts": {
    GET: "handleGetVendorFinanceEntries",
    POST: "handlePostVendorFinanceEntry",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/reconciliations/route.ts": {
    GET: "handleGetVendorReconciliations",
    POST: "handlePostVendorReconciliation",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/classify-contract-type/route.ts": {
    POST: "handlePostClassifyVendorSubLedger",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/shared-advances/route.ts": {
    GET: "handleGetVendorSharedAdvanceMovements",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/shared-advances/fund/route.ts": {
    POST: "handlePostFundVendorSharedAdvance",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/shared-advances/refund/route.ts": {
    POST: "handlePostRecordVendorRefund",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/shared-advances/apply-offset/route.ts": {
    POST: "handlePostApplyVendorSharedAdvanceOffset",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/shared-advances/settle-with-offset/route.ts": {
    POST: "handlePostRecordVendorPaymentWithOffset",
  },
  "src/app/api/vendor-finance/shared-advances/[movementId]/reverse/route.ts": {
    POST: "handlePostReverseVendorSharedAdvanceMovement",
  },
  "src/app/api/vendor-finance/entries/[entryId]/route.ts": {
    GET: "handleGetVendorFinanceSingleEntry",
  },
  "src/app/api/vendor-finance/entries/[entryId]/reverse/route.ts": {
    POST: "handlePostReverseVendorFinanceEntry",
  },
  "src/app/api/vendor-finance/opening-batches/preview/route.ts": {
    POST: "handlePostPreviewOpeningBatch",
  },
  "src/app/api/vendor-finance/opening-batches/apply/route.ts": {
    POST: "handlePostApplyOpeningBatch",
  },
  "src/app/api/vendor-finance/reports/monthly/route.ts": {
    GET: "handleGetVendorFinanceMonthlyReport",
  },
  "src/app/api/vendor-finance/admin/project-accountants/route.ts": {
    GET: "handleGetProjectAccountantsAdmin",
    POST: "handlePostAssignProjectAccountantAdmin",
  },
  "src/app/api/vendor-finance/admin/project-accountants/[assignmentId]/end/route.ts": {
    POST: "handlePostEndProjectAccountantAdmin",
  },
  "src/app/api/vendor-finance/admin/global-roles/route.ts": {
    GET: "handleGetGlobalRolesAdmin",
    POST: "handlePostAssignGlobalRoleAdmin",
  },
  "src/app/api/vendor-finance/admin/global-roles/[roleGrantId]/end/route.ts": {
    POST: "handlePostEndGlobalRoleAdmin",
  },
  "src/app/api/vendor-finance/evidence/reserve/route.ts": {
    POST: "handlePostReserveVendorFinanceEvidence",
  },
  "src/app/api/vendor-finance/evidence/[evidenceId]/finalize/route.ts": {
    POST: "handlePostFinalizeVendorFinanceEvidence",
  },
  "src/app/api/vendor-finance/evidence/[evidenceId]/download/route.ts": {
    GET: "handleGetDownloadVendorFinanceEvidence",
  },
});

const FULL_ADMIN_CAPS = [
  "entry_admin",
  "recruiter_master_manage",
  "team_master_manage",
];

function makeSession({
  unauthenticated = false,
  enabled = true,
  capabilities = FULL_ADMIN_CAPS,
  scopes = [{ kind: "all" }],
} = {}) {
  if (unauthenticated) {
    return {
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    };
  }
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_ID,
        app_user_id: APP_ID,
        enabled,
        capabilities,
        scopes,
      },
    },
  };
}

function sampleEntry(overrides = {}) {
  return {
    entry_id: ENTRY_ID,
    vendor_id: "VND_ALPHA",
    vendor_display_name_snapshot: "Công ty TNHH Alpha",
    vendor_active: true,
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: PROJECT_ID,
    project_display_name_snapshot: "Dự án Miền Bắc",
    accountant_ref: ACC_A_ID,
    responsible_accountant_display_name: "Trần Thị Kế Toán A",
    contract_type: "SEASONAL",
    vendor_sequence: 1,
    cursor_sequence: 1,
    document_no: "VFIN-2026-000001",
    document_kind: "DEBT_ADJUSTMENT_VOUCHER",
    document_title_vi: "Phiếu ghi nhận phát sinh tăng công nợ",
    entry_type: "DEBT_RECORDED",
    amount_minor: "15000000",
    balance_before_minor: "0",
    balance_delta_minor: "15000000",
    balance_after_minor: "15000000",
    effective_date: "2026-10-24",
    reason: "Phí cung ứng tuần 3",
    opening_batch_id: null,
    reverses_entry_id: null,
    reverses_document_no: null,
    reversed_by_entry_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán A",
    created_at: "2026-10-24T02:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

function sampleReconciliation(overrides = {}) {
  return {
    reconciliation_id: REC_ID,
    vendor_id: "VND_ALPHA",
    ledger_scope: "PROJECT_ACCOUNTANT",
    project_id: PROJECT_ID,
    project_display_name_snapshot: "Dự án Miền Bắc",
    accountant_ref: ACC_A_ID,
    responsible_accountant_display_name: "Trần Thị Kế Toán A",
    contract_type: "SEASONAL",
    as_of_date: "2026-10-24",
    system_balance_minor: "15000000",
    confirmed_balance_minor: "14500000",
    difference_minor: "-500000",
    ledger_sequence_at_reconciliation: 1,
    reason: "Đối soát biên bản tháng 10",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán A",
    created_at: "2026-10-24T02:05:00.000Z",
    ...overrides,
  };
}

function makeMockRepository({
  actorAccess = {
    authorization_date: "2026-10-24",
    allowed: true,
    can_view: true,
    can_record: true,
    can_reconcile: true,
    can_manage_project_assignments: false,
    visibility_scope: "PROJECT_SCOPED",
    record_scope: "ASSIGNED_PROJECTS",
    reconcile_scope: "ASSIGNED_PROJECTS",
    global_role_code: null,
    active_assigned_project_count: 1,
    authority_source: "accounting_department",
  },
} = {}) {
  const calls = [];
  const sampleAccount = {
    account_ref: ACC_A_ID,
    display_name: "Trần Thị Kế Toán A",
    login_id: "ketoan.a",
    personnel_code: "KT001",
    account_enabled: true,
  };
  return {
    calls,
    repository: {
      async getActorAccess(input) {
        calls.push(["getActorAccess", input]);
        return { ok: true, data: actorAccess };
      },
      async listContextOptions(input) {
        calls.push(["listContextOptions", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              visibility_scope: actorAccess.visibility_scope ?? "PROJECT_SCOPED",
              record_scope: actorAccess.record_scope ?? "ASSIGNED_PROJECTS",
              reconcile_scope: actorAccess.reconcile_scope ?? "ASSIGNED_PROJECTS",
              can_view: true,
              can_record: actorAccess.can_record,
              can_reconcile: actorAccess.can_reconcile ?? actorAccess.can_record,
              can_manage_project_assignments: Boolean(actorAccess.can_manage_project_assignments),
            },
            has_legacy_unallocated: false,
            projects: [
              {
                project_id: PROJECT_ID,
                display_name: "Dự án Miền Bắc",
                active: true,
                active_accountant_ref: ACC_A_ID,
                active_accountant_display_name: "Trần Thị Kế Toán A",
                has_active_accountant: true,
                can_record_for_project: actorAccess.can_record,
                can_reconcile_for_project: actorAccess.can_reconcile ?? actorAccess.can_record,
              },
            ],
            vendors: [{ vendor_id: "VND_ALPHA", display_name: "Công ty TNHH Alpha", active: true }],
            accountants: [{ accountant_ref: ACC_A_ID, display_name: "Trần Thị Kế Toán A" }],
          },
        };
      },
      async listVendors(input) {
        calls.push(["listVendors", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              visibility_scope: actorAccess.visibility_scope ?? "PROJECT_SCOPED",
              can_view: true,
              can_record: actorAccess.can_record,
              can_reconcile: actorAccess.can_reconcile ?? actorAccess.can_record,
              can_manage_project_assignments: Boolean(actorAccess.can_manage_project_assignments),
              active_assigned_project_count: actorAccess.active_assigned_project_count ?? 1,
            },
            summary: {
              total_payable_minor: "15000000",
              total_advance_minor: "0",
              net_balance_minor: "15000000",
              vendors_with_payable_count: 1,
              vendors_with_advance_count: 0,
              vendors_with_nonzero_balance_count: 1,
              total_vendor_count: 1,
              uninitialized_vendor_count: 0,
              sub_ledger_count: 1,
            },
            filters: {
              search: null,
              active: "all",
              balance_filter: "all",
              project_id: null,
              accountant_ref: null,
              ledger_scope: "all",
              contract_type: "all",
            },
            page: 1,
            page_size: 25,
            total: 1,
            has_more: false,
            vendors: [
              {
                vendor_id: "VND_ALPHA",
                display_name: "Công ty TNHH Alpha",
                active: true,
                sub_ledger_count: 1,
                payable_total_minor: "15000000",
                advance_total_minor: "0",
                current_balance_minor: "15000000",
                balance_direction: "PAYABLE",
                entry_count: 1,
                has_opening_entry: false,
                eligible_for_opening: false,
                last_effective_date: "2026-10-24",
                last_entry_at: "2026-10-24T02:00:00.000Z",
                last_reconciled_as_of_date: null,
                sub_ledgers: [
                  {
                    ledger_scope: "PROJECT_ACCOUNTANT",
                    project_id: PROJECT_ID,
                    project_display_name: "Dự án Miền Bắc",
                    accountant_ref: ACC_A_ID,
                    responsible_accountant_display_name: "Trần Thị Kế Toán A",
                    contract_type: "SEASONAL",
                    current_balance_minor: "15000000",
                    balance_direction: "PAYABLE",
                    entry_count: 1,
                    has_opening_entry: false,
                    eligible_for_opening: false,
                    last_reconciled_as_of_date: null,
                  },
                ],
              },
            ],
          },
        };
      },
      async getVendor(input) {
        calls.push(["getVendor", input]);
        const subLedger = {
          ledger_scope: "PROJECT_ACCOUNTANT",
          project_id: PROJECT_ID,
          project_display_name: "Dự án Miền Bắc",
          project_active: true,
          accountant_ref: ACC_A_ID,
          responsible_accountant_display_name: "Trần Thị Kế Toán A",
          contract_type: "SEASONAL",
          is_active_assignment: true,
          current_balance_minor: "15000000",
          balance_direction: "PAYABLE",
          latest_sequence: 1,
          entry_count: 1,
          has_opening_entry: false,
          eligible_for_opening: false,
          can_record_entry: actorAccess.can_record,
          can_reconcile: actorAccess.can_reconcile ?? actorAccess.can_record,
          can_classify_contract_type: false,
          classification: null,
        };
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              visibility_scope: actorAccess.visibility_scope ?? "PROJECT_SCOPED",
              can_view: true,
              can_record: actorAccess.can_record,
              can_reconcile: actorAccess.can_reconcile ?? actorAccess.can_record,
              can_manage_project_assignments: Boolean(actorAccess.can_manage_project_assignments),
              allowed_entry_types: [
                "DEBT_RECORDED",
                "PAYROLL_RECORDED",
                "PAYMENT_RECORDED",
                "ADVANCE_RECORDED",
                "ADJUSTMENT_INCREASE",
                "ADJUSTMENT_DECREASE",
              ],
            },
            selected_sub_ledger: subLedger,
            sub_ledgers: [subLedger],
            vendor: {
              vendor_id: input.vendor_id,
              display_name: "Công ty TNHH Alpha",
              active: true,
              current_balance_minor: "15000000",
              balance_direction: "PAYABLE",
              latest_sequence: 1,
              entry_count: 1,
              has_opening_entry: false,
              eligible_for_opening: false,
              totals: {
                opening_payable_minor: "0",
                opening_advance_minor: "0",
                debt_recorded_minor: "15000000",
                payroll_recorded_minor: "0",
                payment_recorded_minor: "0",
                advance_recorded_minor: "0",
                adjustment_increase_minor: "0",
                adjustment_decrease_minor: "0",
                reversed_entry_count: 0,
              },
              latest_reconciliation: null,
              recent_reconciliations: [],
            },
          },
        };
      },
      async listVendorEntries(input) {
        calls.push(["listVendorEntries", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            vendor_id: input.vendor_id,
            page_size: 25,
            has_more: false,
            next_cursor: null,
            entries: [sampleEntry({ vendor_id: input.vendor_id })],
          },
        };
      },
      async getEntry(input) {
        calls.push(["getEntry", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              visibility_scope: actorAccess.visibility_scope ?? "PROJECT_SCOPED",
              can_view: true,
              can_record: actorAccess.can_record,
            },
            entry: sampleEntry({ entry_id: input.entry_id }),
          },
        };
      },
      async listVendorReconciliations(input) {
        calls.push(["listVendorReconciliations", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            vendor_id: input.vendor_id,
            page: 1,
            page_size: 25,
            total: 1,
            has_more: false,
            reconciliations: [sampleReconciliation({ vendor_id: input.vendor_id })],
          },
        };
      },
      async recordEntry(input) {
        calls.push(["recordEntry", input]);
        return {
          ok: true,
          data: { entry: sampleEntry({ project_id: input.project_id }), replayed: false },
        };
      },
      async reverseEntry(input) {
        calls.push(["reverseEntry", input]);
        return {
          ok: true,
          data: {
            reversal_entry: sampleEntry({
              entry_id: REV_ENTRY_ID,
              vendor_sequence: 2,
              cursor_sequence: 2,
              document_no: "VFIN-2026-000002",
              entry_type: "REVERSAL",
              balance_before_minor: "15000000",
              balance_delta_minor: "-15000000",
              balance_after_minor: "0",
              reverses_entry_id: ENTRY_ID,
              reverses_document_no: "VFIN-2026-000001",
              can_reverse: false,
            }),
            reversed_entry: sampleEntry({
              reversed_by_entry_id: REV_ENTRY_ID,
              reversed_by_document_no: "VFIN-2026-000002",
              can_reverse: false,
            }),
            replayed: false,
          },
        };
      },
      async previewOpeningBatch(input) {
        calls.push(["previewOpeningBatch", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            project_id: input.project_id,
            project_display_name: "Dự án Miền Bắc",
            accountant_ref: ACC_A_ID,
            responsible_accountant_display_name: "Trần Thị Kế Toán A",
            contract_type: input.contract_type,
            cutoff_date: input.cutoff_date,
            vendor_count: 1,
            skipped_zero_count: 0,
            total_payable_minor: "15000000",
            total_advance_minor: "0",
            net_balance_minor: "15000000",
            items: [
              {
                vendor_id: "VND_ALPHA",
                display_name: "Công ty TNHH Alpha",
                active: true,
                entry_type: "OPENING_PAYABLE",
                amount_minor: "15000000",
                balance_delta_minor: "15000000",
              },
            ],
          },
        };
      },
      async applyOpeningBatch(input) {
        calls.push(["applyOpeningBatch", input]);
        return {
          ok: true,
          data: {
            batch: {
              batch_id: BATCH_ID,
              ledger_scope: "PROJECT_ACCOUNTANT",
              project_id: input.project_id,
              project_display_name_snapshot: "Dự án Miền Bắc",
              accountant_ref: ACC_A_ID,
              responsible_accountant_display_name: "Trần Thị Kế Toán A",
              contract_type: input.contract_type,
              cutoff_date: input.cutoff_date,
              vendor_count: 1,
              skipped_zero_count: 0,
              total_payable_minor: "15000000",
              total_advance_minor: "0",
              net_balance_minor: "15000000",
              reason: input.reason,
              created_by_display_name: "Trần Thị Kế Toán A",
              created_at: "2026-10-24T02:00:00.000Z",
            },
            entries: [
              sampleEntry({
                contract_type: input.contract_type,
                entry_type: "OPENING_PAYABLE",
                document_kind: "OPENING_BALANCE_VOUCHER",
                opening_batch_id: BATCH_ID,
              }),
            ],
            replayed: false,
          },
        };
      },
      async createReconciliation(input) {
        calls.push(["createReconciliation", input]);
        return {
          ok: true,
          data: {
            reconciliation: sampleReconciliation({
              vendor_id: input.vendor_id,
              project_id: input.project_id,
              contract_type: input.contract_type,
            }),
            replayed: false,
          },
        };
      },
      async classifyUnclassifiedSubLedger(input) {
        calls.push(["classifyUnclassifiedSubLedger", input]);
        return {
          ok: true,
          data: {
            classification: {
              classification_id: BATCH_ID,
              vendor_id: input.vendor_id,
              project_id: input.project_id,
              project_display_name_snapshot: "Dự án Miền Bắc",
              accountant_ref: input.accountant_ref ?? ACC_A_ID,
              responsible_accountant_display_name: "Trần Thị Kế Toán A",
              source_contract_type: "UNCLASSIFIED",
              target_contract_type: input.target_contract_type,
              classified_entry_count: 2,
              classified_reconciliation_count: 1,
              closing_balance_minor: "15000000",
              reason: input.reason,
              classified_by_display_name: "Trần Thị Kế Toán A",
              classified_at: "2026-10-24T02:00:00.000Z",
            },
            replayed: false,
          },
        };
      },
      async getMonthlyReport(input) {
        calls.push(["getMonthlyReport", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              visibility_scope: actorAccess.visibility_scope ?? "ALL",
              can_view: true,
              can_record: actorAccess.can_record,
              can_reconcile: actorAccess.can_reconcile ?? actorAccess.can_record,
              can_manage_project_assignments: Boolean(actorAccess.can_manage_project_assignments),
            },
            filters: {
              month: input.month,
              project_id: input.project_id,
              accountant_ref: input.accountant_ref,
              vendor_id: input.vendor_id,
              contract_type: input.contract_type ?? "all",
            },
            totals: {
              project_revenue_status: "MISSING_CANONICAL_SOURCE",
              project_revenue_minor: null,
              project_accountant_book_count: 1,
              sub_ledger_count: 1,
              obligations_in_month_minor: "15000000",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "0",
              paid_and_advanced_in_month_minor: "0",
              closing_payable_minor: "15000000",
              closing_advance_minor: "0",
            },
            project_accountant_summaries: [],
            rows: [],
            legacy_unallocated_rows: [],
          },
        };
      },
      async listProjectAccountantsAdmin(input) {
        calls.push(["listProjectAccountantsAdmin", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            eligible_accountants: [sampleAccount],
            page: 1,
            page_size: 25,
            total: 1,
            has_more: false,
            projects: [],
          },
        };
      },
      async assignProjectAccountantAdmin(input) {
        calls.push(["assignProjectAccountantAdmin", input]);
        return {
          ok: true,
          data: {
            assignment_id: ASGN_ID,
            project_id: input.project_id,
            version: 1,
            replayed: false,
          },
        };
      },
      async endProjectAccountantAdmin(input) {
        calls.push(["endProjectAccountantAdmin", input]);
        return {
          ok: true,
          data: {
            assignment_id: input.assignment_id,
            project_id: PROJECT_ID,
            valid_to: input.valid_to ?? "2026-10-24",
            replayed: false,
          },
        };
      },
      async listGlobalRolesAdmin(input) {
        calls.push(["listGlobalRolesAdmin", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            page: 1,
            page_size: 25,
            total: 0,
            has_more: false,
            roles: [],
            candidates: [],
          },
        };
      },
      async assignGlobalRoleAdmin(input) {
        calls.push(["assignGlobalRoleAdmin", input]);
        return {
          ok: true,
          data: {
            role_grant_id: ROLE_ID,
            account_ref: input.account_ref,
            role_code: input.role_code,
            version: 1,
            replayed: false,
          },
        };
      },
      async endGlobalRoleAdmin(input) {
        calls.push(["endGlobalRoleAdmin", input]);
        return {
          ok: true,
          data: {
            role_grant_id: input.role_grant_id,
            account_ref: ACC_A_ID,
            valid_to: input.valid_to ?? "2026-10-24",
            replayed: false,
          },
        };
      },
      async reserveEvidence(input) {
        calls.push(["reserveEvidence", input]);
        return {
          ok: true,
          data: {
            reservation: {
              evidence_id: EV_ID_1,
              target_kind: input.target_kind,
              target_id: input.target_id,
              status: "RESERVED",
              storage_key: `vfin-01/entry/${input.target_id}/${EV_ID_1}`,
              mime_type: input.mime_type,
              size_bytes: input.size_bytes,
              checksum_sha256: input.checksum_sha256,
              reserved_at: "2026-10-24T02:00:00.000Z",
              expires_at: "2026-10-24T02:05:00.000Z",
            },
            superseded_storage_keys: [],
            replayed: false,
          },
        };
      },
      async getEvidenceReservationInfo(input) {
        calls.push(["getEvidenceReservationInfo", input]);
        return {
          ok: true,
          data: {
            evidence_id: input.evidence_id,
            target_kind: "ENTRY",
            target_id: ENTRY_ID,
            status: "RESERVED",
            storage_key: `vfin-01/entry/${ENTRY_ID}/${input.evidence_id}`,
            mime_type: "image/png",
            size_bytes: VALID_PNG.byteLength,
            checksum_sha256: VALID_PNG_SHA,
            expires_at: "2026-10-24T02:05:00.000Z",
            finalized_at: null,
            is_expired: false,
          },
        };
      },
      async finalizeEvidenceReady(input) {
        calls.push(["finalizeEvidenceReady", input]);
        return {
          ok: true,
          data: {
            evidence: {
              evidence_id: input.evidence_id,
              target_kind: "ENTRY",
              target_id: ENTRY_ID,
              status: "READY",
              mime_type: "image/png",
              size_bytes: VALID_PNG.byteLength,
              checksum_sha256: VALID_PNG_SHA,
              finalized_at: "2026-10-24T02:01:00.000Z",
            },
            replayed: false,
          },
        };
      },
      async failEvidenceReservation(input) {
        calls.push(["failEvidenceReservation", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, status: "FAILED" },
        };
      },
      async expireEvidenceReservation(input) {
        calls.push(["expireEvidenceReservation", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, status: "EXPIRED" },
        };
      },
      async getEvidenceDownload(input) {
        calls.push(["getEvidenceDownload", input]);
        return {
          ok: true,
          data: {
            evidence_id: input.evidence_id,
            target_kind: "ENTRY",
            target_id: ENTRY_ID,
            storage_key: `vfin-01/entry/${ENTRY_ID}/${input.evidence_id}`,
            mime_type: "image/png",
            size_bytes: VALID_PNG.byteLength,
            checksum_sha256: VALID_PNG_SHA,
            finalized_at: "2026-10-24T02:01:00.000Z",
          },
        };
      },
      async markEvidenceCleaned(input) {
        calls.push(["markEvidenceCleaned", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, cleaned: true },
        };
      },
      async exportVendors(input) {
        calls.push(["exportVendors", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            filters: {
              search: input.search ?? null,
              active: input.active ?? "all",
              balance_filter: input.balance_filter ?? "all",
              project_id: input.project_id ?? null,
              accountant_ref: input.accountant_ref ?? null,
              ledger_scope: input.ledger_scope ?? "all",
              contract_type: input.contract_type ?? "all",
            },
            row_cap: 10000,
            total: 1,
            vendors: [
              {
                vendor_id: "VND_ALPHA",
                display_name: "Công ty TNHH Alpha",
                active: true,
                sub_ledger_count: 1,
                payable_total_minor: "15000000",
                shared_advance_balance_minor: "100000000",
                last_effective_date: "2026-10-24",
              },
            ],
          },
        };
      },
      async listSharedAdvanceMovements(input) {
        calls.push(["listSharedAdvanceMovements", input]);
        return {
          ok: true,
          data: {
            vendor_id: input.vendor_id,
            vendor_display_name: "Công ty TNHH Alpha",
            vendor_active: true,
            shared_advance_balance_minor: "100000000",
            last_movement_sequence: 1,
            last_effective_date: "2026-10-24",
            last_recorded_at: "2026-10-24T02:00:00.000Z",
            allowed_actions: {
              can_view_shared_advance: actorAccess.can_view_shared_advance ?? true,
              can_fund_vendor_advance: actorAccess.can_fund_vendor_advance ?? false,
              can_record_vendor_refund: actorAccess.can_record_vendor_refund ?? false,
              can_apply_vendor_advance: actorAccess.can_apply_vendor_advance ?? actorAccess.can_record,
            },
            page_size: input.page_size,
            has_more: false,
            next_cursor: null,
            items: [],
            internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
          },
        };
      },
      async fundSharedAdvance(input) {
        calls.push(["fundSharedAdvance", input]);
        return {
          ok: true,
          data: {
            movement: {
              movement_id: ENTRY_ID,
              vendor_id: input.vendor_id,
              vendor_display_name_snapshot: "Công ty TNHH Alpha",
              vendor_active: true,
              movement_sequence: 1,
              cursor_sequence: 1,
              document_no: "VFIN-2026-000101",
              document_kind: "SHARED_ADVANCE_VOUCHER",
              document_title_vi: "Phiếu ứng tiền dùng chung cho Vendor",
              movement_type: "ADVANCE_FUNDED",
              amount_minor: input.amount_minor,
              balance_before_minor: "0",
              balance_delta_minor: input.amount_minor,
              balance_after_minor: input.amount_minor,
              effective_date: input.effective_date,
              reason: input.reason,
              project_id: null,
              project_display_name_snapshot: null,
              accountant_ref: null,
              responsible_accountant_display_name: null,
              contract_type: null,
              linked_ledger_entry_id: null,
              linked_ledger_document_no: null,
              reverses_movement_id: null,
              reverses_document_no: null,
              reversed_by_movement_id: null,
              reversed_by_document_no: null,
              can_reverse: true,
              can_attach_evidence: false,
              evidence: null,
              created_by_display_name: "Kế toán cầm tiền",
              created_at: "2026-10-24T02:00:00.000Z",
              internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
            },
            shared_advance_balance_minor: input.amount_minor,
            replayed: false,
          },
        };
      },
      async recordVendorRefund(input) {
        calls.push(["recordVendorRefund", input]);
        return {
          ok: true,
          data: {
            movement: {
              movement_id: ENTRY_ID,
              vendor_id: input.vendor_id,
              vendor_display_name_snapshot: "Công ty TNHH Alpha",
              vendor_active: true,
              movement_sequence: 2,
              cursor_sequence: 2,
              document_no: "VFIN-2026-000102",
              document_kind: "VENDOR_REFUND_VOUCHER",
              document_title_vi: "Phiếu thu tiền Vendor hoàn ứng",
              movement_type: "VENDOR_REFUND_RECORDED",
              amount_minor: input.amount_minor,
              balance_before_minor: "100000000",
              balance_delta_minor: `-${input.amount_minor}`,
              balance_after_minor: String(100000000n - BigInt(input.amount_minor)),
              effective_date: input.effective_date,
              reason: input.reason,
              project_id: null,
              project_display_name_snapshot: null,
              accountant_ref: null,
              responsible_accountant_display_name: null,
              contract_type: null,
              linked_ledger_entry_id: null,
              linked_ledger_document_no: null,
              reverses_movement_id: null,
              reverses_document_no: null,
              reversed_by_movement_id: null,
              reversed_by_document_no: null,
              can_reverse: true,
              can_attach_evidence: false,
              evidence: null,
              created_by_display_name: "Kế toán cầm tiền",
              created_at: "2026-10-24T02:00:00.000Z",
              internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
            },
            shared_advance_balance_minor: String(100000000n - BigInt(input.amount_minor)),
            replayed: false,
          },
        };
      },
      async applySharedAdvanceOffset(input) {
        calls.push(["applySharedAdvanceOffset", input]);
        return {
          ok: true,
          data: {
            movement: {
              movement_id: REC_ID,
              vendor_id: input.vendor_id,
              vendor_display_name_snapshot: "Công ty TNHH Alpha",
              vendor_active: true,
              movement_sequence: 3,
              cursor_sequence: 3,
              document_no: "VFIN-2026-000103",
              document_kind: "ADVANCE_OFFSET_VOUCHER",
              document_title_vi: "Phiếu khấu trừ số dư ứng dùng chung vào công nợ dự án",
              movement_type: "PROJECT_OFFSET_APPLIED",
              amount_minor: input.amount_minor,
              balance_before_minor: "100000000",
              balance_delta_minor: `-${input.amount_minor}`,
              balance_after_minor: String(100000000n - BigInt(input.amount_minor)),
              effective_date: input.effective_date,
              reason: input.reason,
              project_id: input.project_id,
              project_display_name_snapshot: "Dự án Miền Bắc",
              accountant_ref: ACC_A_ID,
              responsible_accountant_display_name: "Trần Thị Kế Toán A",
              contract_type: input.contract_type,
              linked_ledger_entry_id: ENTRY_ID,
              linked_ledger_document_no: "VFIN-2026-000104",
              reverses_movement_id: null,
              reverses_document_no: null,
              reversed_by_movement_id: null,
              reversed_by_document_no: null,
              can_reverse: true,
              can_attach_evidence: false,
              evidence: null,
              created_by_display_name: "Trần Thị Kế Toán A",
              created_at: "2026-10-24T02:00:00.000Z",
              internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
            },
            entry: sampleEntry({
              document_no: "VFIN-2026-000104",
              document_kind: "ADVANCE_OFFSET_VOUCHER",
              document_title_vi: "Phiếu khấu trừ ứng dùng chung vào công nợ dự án",
              entry_type: "ADVANCE_OFFSET_RECORDED",
              contract_type: input.contract_type,
              amount_minor: input.amount_minor,
              balance_before_minor: "15000000",
              balance_delta_minor: `-${input.amount_minor}`,
              balance_after_minor: String(15000000n - BigInt(input.amount_minor)),
              shared_advance_movement_id: REC_ID,
            }),
            shared_advance_balance_minor: String(100000000n - BigInt(input.amount_minor)),
            subledger_balance_minor: String(15000000n - BigInt(input.amount_minor)),
            replayed: false,
          },
        };
      },
      async recordPaymentWithOffset(input) {
        calls.push(["recordPaymentWithOffset", input]);
        const afterPayment = 15000000n - BigInt(input.payment_amount_minor);
        const afterOffset = afterPayment - BigInt(input.offset_amount_minor);
        const sharedAfter = 100000000n - BigInt(input.offset_amount_minor);
        return {
          ok: true,
          data: {
            payment_entry: sampleEntry({
              entry_id: ENTRY_ID,
              document_no: "PT-2026-000201",
              document_kind: "PAYMENT_VOUCHER",
              document_title_vi: "Phiếu thanh toán cho Vendor",
              entry_type: "PAYMENT_RECORDED",
              contract_type: input.contract_type,
              amount_minor: input.payment_amount_minor,
              balance_before_minor: "15000000",
              balance_delta_minor: `-${input.payment_amount_minor}`,
              balance_after_minor: String(afterPayment),
            }),
            offset_entry: sampleEntry({
              entry_id: REV_ENTRY_ID,
              vendor_sequence: 2,
              cursor_sequence: 2,
              document_no: "KT-2026-000202",
              document_kind: "ADVANCE_OFFSET_VOUCHER",
              document_title_vi: "Phiếu khấu trừ ứng Vendor vào công nợ dự án",
              entry_type: "ADVANCE_OFFSET_RECORDED",
              contract_type: input.contract_type,
              amount_minor: input.offset_amount_minor,
              balance_before_minor: String(afterPayment),
              balance_delta_minor: `-${input.offset_amount_minor}`,
              balance_after_minor: String(afterOffset),
            }),
            movement: {
              movement_id: REC_ID,
              vendor_id: input.vendor_id,
              vendor_display_name_snapshot: "Công ty TNHH Alpha",
              vendor_active: true,
              vendor_advance_sequence: 3,
              cursor_sequence: 3,
              document_no: "KT-2026-000203",
              document_kind: "ADVANCE_OFFSET_VOUCHER",
              document_title_vi: "Phiếu khấu trừ số dư ứng dùng chung vào công nợ dự án",
              movement_type: "PROJECT_OFFSET_APPLIED",
              amount_minor: input.offset_amount_minor,
              balance_before_minor: "100000000",
              balance_delta_minor: `-${input.offset_amount_minor}`,
              balance_after_minor: String(sharedAfter),
              effective_date: input.effective_date,
              reason: input.reason,
              project_entry_id: REV_ENTRY_ID,
              project_id: input.project_id,
              project_display_name_snapshot: "Dự án Miền Bắc",
              accountant_ref: ACC_A_ID,
              responsible_accountant_display_name: "Trần Thị Kế Toán A",
              contract_type: input.contract_type,
              reverses_movement_id: null,
              reverses_document_no: null,
              reversed_by_movement_id: null,
              reversed_by_document_no: null,
              can_reverse: true,
              can_attach_evidence: false,
              evidence: null,
              created_by_display_name: "Trần Thị Kế Toán A",
              created_at: "2026-10-24T02:00:00.000Z",
              internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
            },
            shared_advance_balance_minor: String(sharedAfter),
            replayed: false,
          },
        };
      },
      async reverseSharedAdvanceMovement(input) {
        calls.push(["reverseSharedAdvanceMovement", input]);
        return {
          ok: true,
          data: {
            reversal_movement: {
              movement_id: REV_ENTRY_ID,
              vendor_id: "VND_ALPHA",
              vendor_display_name_snapshot: "Công ty TNHH Alpha",
              vendor_active: true,
              movement_sequence: 4,
              cursor_sequence: 4,
              document_no: "VFIN-2026-000105",
              document_kind: "SHARED_ADVANCE_REVERSAL_VOUCHER",
              document_title_vi: "Phiếu đảo bút toán số dư ứng dùng chung",
              movement_type: "REVERSAL",
              amount_minor: "10000000",
              balance_before_minor: "90000000",
              balance_delta_minor: "10000000",
              balance_after_minor: "100000000",
              effective_date: input.effective_date ?? "2026-10-24",
              reason: input.reason,
              project_id: null,
              project_display_name_snapshot: null,
              accountant_ref: null,
              responsible_accountant_display_name: null,
              contract_type: null,
              linked_ledger_entry_id: null,
              linked_ledger_document_no: null,
              reverses_movement_id: input.movement_id,
              reverses_document_no: "VFIN-2026-000102",
              reversed_by_movement_id: null,
              reversed_by_document_no: null,
              can_reverse: false,
              can_attach_evidence: false,
              evidence: null,
              created_by_display_name: "Kế toán cầm tiền",
              created_at: "2026-10-24T02:05:00.000Z",
              internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
            },
            reversal_entry: null,
            shared_advance_balance_minor: "100000000",
            subledger_balance_minor: null,
            replayed: false,
          },
        };
      },
    },
  };
}

async function discoverRouteFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await discoverRouteFiles(full)));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results.sort();
}

function extractExportedFunctionBlock(source, verb) {
  const matcher = new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`);
  const match = matcher.exec(source);
  if (!match) return null;
  const openParen = source.indexOf("(", match.index);
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", paramsEnd);
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    else if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(match.index, i + 1);
      }
    }
  }
  return null;
}

test("dynamic route discovery & DIRECT_ENTRY_API_ENABLED hidden 404 gate across all 18 routes (22 handlers) before params, session, repository, storage, or body reads", async () => {
  const rootDir = process.cwd();
  const routeFiles = await discoverRouteFiles(path.join(rootDir, "src/app/api/vendor-finance"));
  const relativeRoutes = routeFiles.map((f) => path.relative(rootDir, f).replaceAll("\\", "/"));

  assert.deepEqual(relativeRoutes.sort(), Object.keys(EXPECTED_ROUTE_METHODS).sort());

  for (const relPath of relativeRoutes) {
    const source = await readFile(path.join(rootDir, relPath), "utf8");
    assert.match(source, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);

    const expectedMap = EXPECTED_ROUTE_METHODS[relPath];
    for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const fnBlock = extractExportedFunctionBlock(source, verb);
      if (!(verb in expectedMap)) {
        assert.equal(fnBlock, null, `${relPath} must not export ${verb}`);
        continue;
      }
      assert.ok(fnBlock, `${relPath} missing exported ${verb}`);
      const gateIdx = fnBlock.indexOf('if (process.env.DIRECT_ENTRY_API_ENABLED !== "true")');
      const handlerIdx = fnBlock.indexOf(expectedMap[verb]);
      assert.ok(gateIdx !== -1, `${relPath} ${verb} must guard DIRECT_ENTRY_API_ENABLED`);
      assert.ok(handlerIdx > gateIdx, `${relPath} ${verb} must guard before calling ${expectedMap[verb]}`);
      if (fnBlock.includes("context.params")) {
        const paramsIdx = fnBlock.indexOf("context.params");
        assert.ok(gateIdx < paramsIdx, `${relPath} ${verb} must guard before awaiting context.params`);
      }
      if (fnBlock.includes("createR2VendorFinanceEvidenceStorage")) {
        const storageIdx = fnBlock.indexOf("createR2VendorFinanceEvidenceStorage");
        assert.ok(gateIdx < storageIdx, `${relPath} ${verb} must guard before creating R2 storage`);
      }
    }
  }

  for (const disabledFlag of [undefined, "", "false", "0", "TRUE", " true "]) {
    let sideEffects = 0;
    const bombDeps = {
      resolveSession: async () => {
        sideEffects += 1;
        throw new Error("resolveSession must not run when gated off");
      },
      repository: new Proxy(
        {},
        {
          get() {
            return async () => {
              sideEffects += 1;
              throw new Error("repository must not run when gated off");
            };
          },
        },
      ),
      storage: {
        available() {
          sideEffects += 1;
          throw new Error("storage must not run when gated off");
        },
      },
    };
    const untouchedBody = () =>
      new ReadableStream(
        {
          pull() {
            sideEffects += 1;
            throw new Error("body must not be read when gated off");
          },
        },
        { highWaterMark: 0 },
      );

    const responses = await Promise.all([
      handleGetVendorFinanceContext(new Request(`${ORIGIN}/api/vendor-finance/context`), disabledFlag, bombDeps),
      handleGetVendorFinanceVendors(new Request(`${ORIGIN}/api/vendor-finance/vendors`), disabledFlag, bombDeps),
      handleGetExportVendorFinanceVendors(new Request(`${ORIGIN}/api/vendor-finance/vendors/export`), disabledFlag, bombDeps),
      handleGetVendorFinanceVendorDetail(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA`), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorFinanceEntries(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostVendorFinanceEntry(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorReconciliations(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostVendorReconciliation(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostClassifyVendorSubLedger(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/classify-contract-type`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorSharedAdvanceMovements(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances`), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostFundVendorSharedAdvance(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/fund`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostRecordVendorRefund(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/refund`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostApplyVendorSharedAdvanceOffset(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/apply-offset`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostRecordVendorPaymentWithOffset(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/settle-with-offset`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostReverseVendorSharedAdvanceMovement(new Request(`${ORIGIN}/api/vendor-finance/shared-advances/${ENTRY_ID}/reverse`, { method: "POST", body: untouchedBody(), duplex: "half" }), ENTRY_ID, disabledFlag, bombDeps),
      handleGetVendorFinanceSingleEntry(new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}`), ENTRY_ID, disabledFlag, bombDeps),
      handlePostReverseVendorFinanceEntry(new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}/reverse`, { method: "POST", body: untouchedBody(), duplex: "half" }), ENTRY_ID, disabledFlag, bombDeps),
      handlePostPreviewOpeningBatch(new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostApplyOpeningBatch(new Request(`${ORIGIN}/api/vendor-finance/opening-batches/apply`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handleGetVendorFinanceMonthlyReport(new Request(`${ORIGIN}/api/vendor-finance/reports/monthly?month=2026-10`), disabledFlag, bombDeps),
      handleGetProjectAccountantsAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants`), disabledFlag, bombDeps),
      handlePostAssignProjectAccountantAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostEndProjectAccountantAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants/${ASGN_ID}/end`, { method: "POST", body: untouchedBody(), duplex: "half" }), ASGN_ID, disabledFlag, bombDeps),
      handleGetGlobalRolesAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/global-roles`), disabledFlag, bombDeps),
      handlePostAssignGlobalRoleAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/global-roles`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostEndGlobalRoleAdmin(new Request(`${ORIGIN}/api/vendor-finance/admin/global-roles/${ROLE_ID}/end`, { method: "POST", body: untouchedBody(), duplex: "half" }), ROLE_ID, disabledFlag, bombDeps),
      handlePostReserveVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostFinalizeVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, { method: "POST", body: untouchedBody(), duplex: "half" }), EV_ID_1, disabledFlag, bombDeps),
      handleGetDownloadVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/download`), EV_ID_1, disabledFlag, bombDeps),
    ]);

    assert.equal(responses.length, 29);
    for (const res of responses) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
    }
    assert.equal(sideEffects, 0);
  }
});

test("CSRF, authority headers, invalid JSON, and oversized body (413) are rejected cleanly", async () => {
  const { repository, calls } = makeMockRepository();
  const deps = {
    resolveSession: async () => makeSession(),
    repository,
  };

  // Cross-origin POST -> 403 CSRF_ORIGIN_DENIED
  const csrfRes = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(csrfRes.status, 403);
  assert.deepEqual(await csrfRes.json(), { ok: false, code: "CSRF_ORIGIN_DENIED" });
  assert.equal(calls.length, 0);

  // Disallowed authority header -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const headerRes = await handleGetVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors`, {
      headers: { "x-authority-source": "full_admin" },
    }),
    "true",
    deps,
  );
  assert.equal(headerRes.status, 400);
  assert.deepEqual(await headerRes.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });

  // Chunked stream exceeding MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES -> 413 REQUEST_BODY_TOO_LARGE
  const chunk = new TextEncoder().encode("x".repeat(4096));
  let pullCount = 0;
  const oversizedStream = new ReadableStream(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(chunk);
        if (pullCount >= 5) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const oversizedRes = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: oversizedStream,
      duplex: "half",
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(oversizedRes.status, 413);
  assert.deepEqual(await oversizedRes.json(), { ok: false, code: "REQUEST_BODY_TOO_LARGE" });
  assert.ok(pullCount * 4096 > MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES);

  // Declared Content-Length exceeding MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES -> 413
  const oversizedBatchRes = await handlePostPreviewOpeningBatch(
    new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-length": String(MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES + 1),
      },
      body: "{}",
    }),
    "true",
    deps,
  );
  assert.equal(oversizedBatchRes.status, 413);
});

test("HTTP VFIN-02 4-role authorization matrix: Full Admin, Project Accountant, Narrow BoD Reconciler (GLOBAL_RECONCILER), BoD View-Only, and denied personas", async () => {
  // 1. Unauthenticated -> 401
  const unauthRes = await handleGetVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors`),
    "true",
    {
      resolveSession: async () => makeSession({ unauthenticated: true }),
      repository: makeMockRepository().repository,
    },
  );
  assert.equal(unauthRes.status, 401);

  // 2. Active ACCOUNTING department member (Project Accountant: zero direct capabilities!) -> 200 GET, 201 POST entry, 403 on /admin/*
  const acctRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      allowed: true,
      can_view: true,
      can_record: true,
      can_reconcile: true,
      can_manage_project_assignments: false,
      visibility_scope: "PROJECT_SCOPED",
      record_scope: "ASSIGNED_PROJECTS",
      reconcile_scope: "ASSIGNED_PROJECTS",
      global_role_code: null,
      active_assigned_project_count: 1,
      authority_source: "accounting_department",
    },
  });
  const acctDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: acctRepo.repository,
  };
  assert.equal(
    (await handleGetVendorFinanceContext(new Request(`${ORIGIN}/api/vendor-finance/context`), "true", acctDeps)).status,
    200,
  );
  assert.equal(
    (await handleGetVendorFinanceVendors(new Request(`${ORIGIN}/api/vendor-finance/vendors`), "true", acctDeps)).status,
    200,
  );
  const acctPost = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        contract_type: "SEASONAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "15000000",
        effective_date: "2026-10-24",
        reason: "Phí dịch vụ",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    acctDeps,
  );
  assert.equal(acctPost.status, 201);

  const acctClassify = await handlePostClassifyVendorSubLedger(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/classify-contract-type`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        accountant_ref: ACC_A_ID,
        target_contract_type: "OFFICIAL",
        reason: "Phân loại sổ cũ sau khi đối chiếu chứng từ",
        idempotency_key: IDEM_2,
      }),
    }),
    "VND_ALPHA",
    "true",
    acctDeps,
  );
  assert.equal(acctClassify.status, 201);

  const acctAdminDenied = await handleGetProjectAccountantsAdmin(
    new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants`),
    "true",
    acctDeps,
  );
  assert.equal(acctAdminDenied.status, 403);
  assert.deepEqual(await acctAdminDenied.json(), { ok: false, code: "VENDOR_FINANCE_ADMIN_DENIED" });

  // 3. Narrow BoD Reconciler (`GLOBAL_RECONCILER` / Cash-Holder view+reconcile without `can_record`):
  //    - 200 on GETs (including monthly report returning MISSING_CANONICAL_SOURCE revenue)
  //    - 201 on POST .../reconciliations and POST .../evidence/reserve
  //    - 403 VENDOR_FINANCE_RECORD_DENIED on POST .../entries, reverse, opening-batches
  //    - 403 VENDOR_FINANCE_ADMIN_DENIED on /admin/*
  const narrowReconcilerRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      allowed: true,
      can_view: true,
      can_record: false,
      can_reconcile: true,
      can_manage_project_assignments: false,
      visibility_scope: "ALL",
      record_scope: "NONE",
      reconcile_scope: "ALL",
      global_role_code: "GLOBAL_RECONCILER",
      active_assigned_project_count: 0,
      authority_source: "global_role",
    },
  });
  const narrowReconcilerDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: narrowReconcilerRepo.repository,
    storage: {
      available: () => true,
      async createUploadUrl(input) {
        return {
          url: `https://r2-presign.internal/upload/${encodeURIComponent(input.storage_key)}`,
          expires_at: "2026-10-24T02:05:00.000Z",
          headers: { "Content-Type": input.mime_type },
        };
      },
      async readStagedBounded() {
        return { kind: "missing" };
      },
      async promoteStagedToFinal() {},
      async deleteStaged() {},
      async createDownloadUrl() {
        return { url: "https://r2-presign.internal/dl", expires_at: "2026-10-24T02:05:00.000Z" };
      },
    },
  };

  const reportRes = await handleGetVendorFinanceMonthlyReport(
    new Request(`${ORIGIN}/api/vendor-finance/reports/monthly?month=2026-10`),
    "true",
    narrowReconcilerDeps,
  );
  assert.equal(reportRes.status, 200);
  const reportBody = await reportRes.json();
  assert.equal(reportBody.data.totals.project_revenue_status, "MISSING_CANONICAL_SOURCE");
  assert.equal(reportBody.data.totals.project_revenue_minor, null);

  const narrowRecPost = await handlePostVendorReconciliation(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        accountant_ref: ACC_A_ID,
        contract_type: "SEASONAL",
        as_of_date: "2026-10-24",
        confirmed_balance_minor: "14500000",
        reason: "BoD xác nhận đối soát tháng 10",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    narrowReconcilerDeps,
  );
  assert.equal(narrowRecPost.status, 201);

  const narrowEvReserve = await handlePostReserveVendorFinanceEvidence(
    new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        target_kind: "RECONCILIATION",
        target_id: REC_ID,
        mime_type: "image/png",
        size_bytes: VALID_PNG.byteLength,
        checksum_sha256: VALID_PNG_SHA,
        idempotency_key: IDEM_2,
      }),
    }),
    "true",
    narrowReconcilerDeps,
  );
  assert.equal(narrowEvReserve.status, 201);

  const narrowEntryDenied = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    narrowReconcilerDeps,
  );
  assert.equal(narrowEntryDenied.status, 403);
  const narrowClassifyDenied = await handlePostClassifyVendorSubLedger(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/classify-contract-type`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    narrowReconcilerDeps,
  );
  assert.equal(narrowClassifyDenied.status, 403);
  assert.deepEqual(await narrowClassifyDenied.json(), { ok: false, code: "VENDOR_FINANCE_RECORD_DENIED" });

  // 4. BoD strictly view-only (`vendor_finance_view @ all` with can_record=false, can_reconcile=false)
  const bodRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      allowed: true,
      can_view: true,
      can_record: false,
      can_reconcile: false,
      can_manage_project_assignments: false,
      visibility_scope: "ALL",
      record_scope: "NONE",
      reconcile_scope: "NONE",
      global_role_code: null,
      active_assigned_project_count: 0,
      authority_source: "direct_grant_view",
    },
  });
  let storageCalledForBod = false;
  const bodDeps = {
    resolveSession: async () =>
      makeSession({
        capabilities: ["vendor_finance_view", "report_analytics_view"],
        scopes: [{ kind: "all" }],
      }),
    repository: bodRepo.repository,
    storage: {
      available() {
        storageCalledForBod = true;
        return true;
      },
    },
  };

  assert.equal(
    (await handleGetVendorFinanceVendorDetail(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA`),
      "VND_ALPHA",
      "true",
      bodDeps,
    )).status,
    200,
  );

  const bodRecDenied = await handlePostVendorReconciliation(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    bodDeps,
  );
  assert.equal(bodRecDenied.status, 403);
  assert.deepEqual(await bodRecDenied.json(), { ok: false, code: "VENDOR_FINANCE_RECONCILE_DENIED" });

  for (const postCall of [
    () =>
      handlePostVendorFinanceEntry(
        new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "VND_ALPHA",
        "true",
        bodDeps,
      ),
    () =>
      handlePostReverseVendorFinanceEntry(
        new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}/reverse`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        ENTRY_ID,
        "true",
        bodDeps,
      ),
    () =>
      handlePostPreviewOpeningBatch(
        new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostApplyOpeningBatch(
        new Request(`${ORIGIN}/api/vendor-finance/opening-batches/apply`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostReserveVendorFinanceEvidence(
        new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostFinalizeVendorFinanceEvidence(
        new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        EV_ID_1,
        "true",
        bodDeps,
      ),
  ]) {
    const res = await postCall();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "VENDOR_FINANCE_RECORD_DENIED" });
  }
  assert.equal(storageCalledForBod, false, "BoD view-only must never touch R2 storage on mutations");

  // 5. Full Admin governance routes succeed (`200`/`201`)
  const adminRepo = makeMockRepository();
  const adminDeps = {
    resolveSession: async () => makeSession(),
    repository: adminRepo.repository,
  };
  assert.equal(
    (await handleGetProjectAccountantsAdmin(
      new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants`),
      "true",
      adminDeps,
    )).status,
    200,
  );
  const todayVn = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date());
  assert.equal(
    (await handlePostAssignProjectAccountantAdmin(
      new Request(`${ORIGIN}/api/vendor-finance/admin/project-accountants`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          project_id: PROJECT_ID,
          accountant_ref: ACC_A_ID,
          valid_from: todayVn,
          expected_version: 0,
          reason: "Phân công kế toán dự án",
          idempotency_key: IDEM_1,
        }),
      }),
      "true",
      adminDeps,
    )).status,
    201,
  );
  assert.equal(
    (await handlePostAssignGlobalRoleAdmin(
      new Request(`${ORIGIN}/api/vendor-finance/admin/global-roles`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          account_ref: ACC_A_ID,
          role_code: "CASH_HOLDER",
          valid_from: todayVn,
          expected_version: 0,
          reason: "Chỉ định kế toán cầm tiền",
          idempotency_key: IDEM_3,
        }),
      }),
      "true",
      adminDeps,
    )).status,
    201,
  );

  // 6. Catalog operator, Team Leader, retired `payment_view`/`payment_edit` -> 403 VENDOR_FINANCE_ACCESS_DENIED
  for (const deniedPersona of [
    { capabilities: ["catalog_master_manage"], scopes: [{ kind: "all" }] },
    { capabilities: ["entry_read", "entry_review"], scopes: [{ kind: "team", id: ENTRY_ID }] },
    { capabilities: ["payment_view", "payment_edit"], scopes: [{ kind: "all" }] },
  ]) {
    const deniedRepo = makeMockRepository({
      actorAccess: {
        authorization_date: "2026-10-24",
        allowed: false,
        can_view: false,
        can_record: false,
        can_reconcile: false,
        can_manage_project_assignments: false,
        visibility_scope: "NONE",
        record_scope: "NONE",
        reconcile_scope: "NONE",
        global_role_code: null,
        active_assigned_project_count: 0,
        authority_source: "none",
      },
    });
    const deniedDeps = {
      resolveSession: async () => makeSession(deniedPersona),
      repository: deniedRepo.repository,
    };
    const getRes = await handleGetVendorFinanceVendors(
      new Request(`${ORIGIN}/api/vendor-finance/vendors`),
      "true",
      deniedDeps,
    );
    assert.equal(getRes.status, 403);
    assert.deepEqual(await getRes.json(), { ok: false, code: "VENDOR_FINANCE_ACCESS_DENIED" });
  }
});

test("evidence lifecycle: invalid upload does NOT roll back money entry, cleans staged object, allows clean retry without new money entry, and never leaks storage_key or signed URLs to logs", async () => {
  const stagedObjects = new Map();
  const finalObjects = new Map();
  const deletedStagedKeys = [];
  const reservations = new Map();
  let ledgerEntriesCount = 0;
  let failNextDbFinalize = false;

  const loggedMessages = [];
  const origError = console.error;
  console.error = (...args) => {
    loggedMessages.push(args.map(String).join(" "));
  };

  try {
    const baseMock = makeMockRepository();
    const repository = {
      ...baseMock.repository,
      async recordEntry(input) {
        ledgerEntriesCount += 1;
        return baseMock.repository.recordEntry(input);
      },
      async reserveEvidence(input) {
        const evId = reservations.size === 0 ? EV_ID_1 : EV_ID_2;
        const storageKey = `vfin-01/entry/${input.target_id}/${evId}`;
        const superseded = [];
        for (const prev of reservations.values()) {
          if (prev.status === "RESERVED") {
            prev.status = "EXPIRED";
            superseded.push(prev.storage_key);
          }
        }
        const record = {
          evidence_id: evId,
          target_kind: input.target_kind,
          target_id: input.target_id,
          status: "RESERVED",
          storage_key: storageKey,
          mime_type: input.mime_type,
          size_bytes: input.size_bytes,
          checksum_sha256: input.checksum_sha256,
          reserved_at: "2026-10-24T02:00:00.000Z",
          expires_at: "2026-10-24T02:05:00.000Z",
          finalized_at: null,
          is_expired: false,
          cleaned: false,
        };
        reservations.set(evId, record);
        return {
          ok: true,
          data: {
            reservation: record,
            superseded_storage_keys: superseded,
            replayed: false,
          },
        };
      },
      async getEvidenceReservationInfo(input) {
        const rec = reservations.get(input.evidence_id);
        return { ok: true, data: { ...rec } };
      },
      async failEvidenceReservation(input) {
        const rec = reservations.get(input.evidence_id);
        rec.status = "FAILED";
        return { ok: true, data: { evidence_id: rec.evidence_id, status: "FAILED" } };
      },
      async expireEvidenceReservation(input) {
        const rec = reservations.get(input.evidence_id);
        rec.status = "EXPIRED";
        return { ok: true, data: { evidence_id: rec.evidence_id, status: "EXPIRED" } };
      },
      async markEvidenceCleaned(input) {
        const rec = reservations.get(input.evidence_id);
        rec.cleaned = true;
        return { ok: true, data: { evidence_id: rec.evidence_id, cleaned: true } };
      },
      async finalizeEvidenceReady(input) {
        if (failNextDbFinalize) {
          failNextDbFinalize = false;
          return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
        }
        const rec = reservations.get(input.evidence_id);
        const replayed = rec.status === "READY";
        rec.status = "READY";
        rec.finalized_at = "2026-10-24T02:02:00.000Z";
        return {
          ok: true,
          data: {
            evidence: {
              evidence_id: rec.evidence_id,
              target_kind: rec.target_kind,
              target_id: rec.target_id,
              status: "READY",
              mime_type: rec.mime_type,
              size_bytes: rec.size_bytes,
              checksum_sha256: rec.checksum_sha256,
              finalized_at: rec.finalized_at,
            },
            replayed,
          },
        };
      },
      async getEvidenceDownload(input) {
        const rec = reservations.get(input.evidence_id);
        return {
          ok: true,
          data: {
            evidence_id: rec.evidence_id,
            target_kind: rec.target_kind,
            target_id: rec.target_id,
            storage_key: rec.storage_key,
            mime_type: rec.mime_type,
            size_bytes: rec.size_bytes,
            checksum_sha256: rec.checksum_sha256,
            finalized_at: rec.finalized_at,
          },
        };
      },
    };

    const storage = {
      available: () => true,
      async createUploadUrl(input) {
        return {
          url: `https://r2-presign.internal/upload/${encodeURIComponent(input.storage_key)}?sig=SECRET_PUT_TOKEN`,
          expires_at: "2026-10-24T02:05:00.000Z",
          headers: { "Content-Type": input.mime_type },
        };
      },
      async readStagedBounded(storageKey) {
        if (!stagedObjects.has(storageKey)) return { kind: "missing" };
        return { kind: "found", bytes: stagedObjects.get(storageKey) };
      },
      async promoteStagedToFinal(input) {
        finalObjects.set(input.storage_key, stagedObjects.get(input.storage_key));
      },
      async deleteStaged(storageKey) {
        stagedObjects.delete(storageKey);
        deletedStagedKeys.push(storageKey);
      },
      async deleteFinal(storageKey) {
        finalObjects.delete(storageKey);
      },
      async createDownloadUrl(input) {
        return {
          url: `https://r2-presign.internal/download/${encodeURIComponent(input.storage_key)}?sig=SECRET_GET_TOKEN`,
          expires_at: "2026-10-24T02:04:00.000Z",
        };
      },
    };

    const deps = {
      resolveSession: async () => makeSession(),
      repository,
      storage,
    };

    // Step 1: Record money entry -> 201
    const entryRes = await handlePostVendorFinanceEntry(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          project_id: PROJECT_ID,
          contract_type: "SEASONAL",
          entry_type: "PAYMENT_RECORDED",
          amount_minor: "5000000",
          effective_date: "2026-10-24",
          reason: "Chi trả đợt 1",
          idempotency_key: IDEM_1,
        }),
      }),
      "VND_ALPHA",
      "true",
      deps,
    );
    assert.equal(entryRes.status, 201);
    assert.equal(ledgerEntriesCount, 1);

    // Step 2: Reserve evidence #1 -> 201, no storage_key leaked
    const res1 = await handlePostReserveVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          target_kind: "ENTRY",
          target_id: ENTRY_ID,
          mime_type: "image/png",
          size_bytes: VALID_PNG.byteLength,
          checksum_sha256: VALID_PNG_SHA,
          idempotency_key: IDEM_2,
        }),
      }),
      "true",
      deps,
    );
    assert.equal(res1.status, 201);
    const res1Body = await res1.json();
    assert.equal("storage_key" in res1Body.data, false);

    // Put corrupted bytes of matching length into staging
    const key1 = reservations.get(EV_ID_1).storage_key;
    stagedObjects.set(key1, new Uint8Array(VALID_PNG.byteLength).fill(0x41));

    // Step 3: Finalize #1 fails with 422, deletes staged object, marks FAILED + cleaned, money entry stays 1!
    const fin1 = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_1,
      "true",
      deps,
    );
    assert.equal(fin1.status, 422);
    assert.deepEqual(await fin1.json(), {
      ok: false,
      code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID",
    });
    assert.equal(stagedObjects.has(key1), false);
    assert.equal(reservations.get(EV_ID_1).status, "FAILED");
    assert.equal(reservations.get(EV_ID_1).cleaned, true);
    assert.equal(ledgerEntriesCount, 1);

    // Step 4: Retry reserve #2 + upload valid PNG + finalize #2 -> 200 READY without creating a 2nd money entry
    const res2 = await handlePostReserveVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          target_kind: "ENTRY",
          target_id: ENTRY_ID,
          mime_type: "image/png",
          size_bytes: VALID_PNG.byteLength,
          checksum_sha256: VALID_PNG_SHA,
          idempotency_key: IDEM_3,
        }),
      }),
      "true",
      deps,
    );
    assert.equal(res2.status, 201);
    const key2 = reservations.get(EV_ID_2).storage_key;
    stagedObjects.set(key2, VALID_PNG);

    failNextDbFinalize = true;
    const fin2TransientErr = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(fin2TransientErr.status, 503);
    assert.equal(reservations.get(EV_ID_2).status, "RESERVED");
    assert.equal(stagedObjects.has(key2), true);

    const fin2 = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(fin2.status, 200);
    assert.equal(stagedObjects.has(key2), false);
    assert.equal(ledgerEntriesCount, 1);

    const dlRes = await handleGetDownloadVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/download`),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(dlRes.status, 200);
    const dlBody = await dlRes.json();
    assert.equal("storage_key" in dlBody.data, false);

    for (const line of loggedMessages) {
      assert.doesNotMatch(line, /SECRET_PUT_TOKEN|SECRET_GET_TOKEN|vfin-01\/entry/);
    }
  } finally {
    console.error = origError;
  }
});

test("evidence expiry lifecycle (Blocker 2 regression): expired reservation transitions to EXPIRED without rollback, cleans staged & final R2 objects, and marks cleaned", async () => {
  const stagedObjects = new Map();
  const finalObjects = new Map();
  const EV_EXP_1 = "60000000-0000-4000-8000-000000000011";
  const EV_EXP_2 = "60000000-0000-4000-8000-000000000012";
  const keyExp1 = `vfin-01/entry/${ENTRY_ID}/${EV_EXP_1}`;
  const keyExp2 = `vfin-01/entry/${ENTRY_ID}/${EV_EXP_2}`;

  const state = new Map([
    [
      EV_EXP_1,
      {
        evidence_id: EV_EXP_1,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        status: "RESERVED",
        storage_key: keyExp1,
        mime_type: "image/png",
        size_bytes: VALID_PNG.byteLength,
        checksum_sha256: VALID_PNG_SHA,
        expires_at: "2026-10-24T01:59:00.000Z",
        finalized_at: null,
        is_expired: true,
        cleaned: false,
      },
    ],
    [
      EV_EXP_2,
      {
        evidence_id: EV_EXP_2,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        status: "RESERVED",
        storage_key: keyExp2,
        mime_type: "image/png",
        size_bytes: VALID_PNG.byteLength,
        checksum_sha256: VALID_PNG_SHA,
        expires_at: "2026-10-24T02:05:00.000Z",
        finalized_at: null,
        is_expired: false,
        cleaned: false,
      },
    ],
  ]);

  stagedObjects.set(keyExp1, VALID_PNG);
  finalObjects.set(keyExp1, VALID_PNG);
  stagedObjects.set(keyExp2, VALID_PNG);

  const rpcRepo = createVendorFinanceRepository(async (fnName, params) => {
    if (fnName === "vendor_finance_get_actor_access") {
      return {
        data: {
          authorization_date: "2026-10-24",
          allowed: true,
          can_view: true,
          can_record: true,
          can_reconcile: true,
          can_manage_project_assignments: false,
          visibility_scope: "PROJECT_SCOPED",
          record_scope: "ASSIGNED_PROJECTS",
          reconcile_scope: "ASSIGNED_PROJECTS",
          global_role_code: null,
          active_assigned_project_count: 1,
          authority_source: "accounting_department",
        },
        error: null,
      };
    }
    const rec = state.get(params.p_evidence_id);
    if (fnName === "vendor_finance_complete_evidence") {
      if (params.p_outcome === "INFO") {
        if (rec.is_expired && rec.status === "RESERVED") {
          rec.status = "EXPIRED";
        }
        return {
          data: {
            evidence_id: rec.evidence_id,
            target_kind: rec.target_kind,
            target_id: rec.target_id,
            status: rec.status,
            storage_key: rec.storage_key,
            mime_type: rec.mime_type,
            size_bytes: rec.size_bytes,
            checksum_sha256: rec.checksum_sha256,
            expires_at: rec.expires_at,
            finalized_at: rec.finalized_at,
            is_expired: rec.status === "EXPIRED",
          },
          error: null,
        };
      }
      if (params.p_outcome === "READY") {
        rec.status = "EXPIRED";
        return {
          data: {
            expired: true,
            evidence_id: rec.evidence_id,
            status: "EXPIRED",
            failure_code: "RESERVATION_TTL_EXPIRED",
          },
          error: null,
        };
      }
      if (params.p_outcome === "EXPIRED") {
        rec.status = "EXPIRED";
        return {
          data: {
            evidence_id: rec.evidence_id,
            status: "EXPIRED",
            failure_code: params.p_failure_code ?? "RESERVATION_TTL_EXPIRED",
          },
          error: null,
        };
      }
    }
    if (fnName === "vendor_finance_mark_evidence_cleaned") {
      assert.equal(rec.status, "EXPIRED");
      rec.cleaned = true;
      return {
        data: { evidence_id: rec.evidence_id, cleaned: true },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${fnName}`);
  });

  const storage = {
    available: () => true,
    async createUploadUrl() {
      throw new Error("unexpected");
    },
    async readStagedBounded(storageKey) {
      if (!stagedObjects.has(storageKey)) return { kind: "missing" };
      return { kind: "found", bytes: stagedObjects.get(storageKey) };
    },
    async promoteStagedToFinal(input) {
      finalObjects.set(input.storage_key, stagedObjects.get(input.storage_key));
    },
    async deleteStaged(storageKey) {
      stagedObjects.delete(storageKey);
    },
    async deleteFinal(storageKey) {
      finalObjects.delete(storageKey);
    },
    async createDownloadUrl() {
      throw new Error("unexpected");
    },
  };

  const deps = {
    resolveSession: async () => makeSession(),
    repository: rpcRepo,
    storage,
  };

  const resExp1 = await handlePostFinalizeVendorFinanceEvidence(
    new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_EXP_1}/finalize`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    EV_EXP_1,
    "true",
    deps,
  );
  assert.equal(resExp1.status, 409);
  assert.equal(state.get(EV_EXP_1).status, "EXPIRED");
  assert.equal(state.get(EV_EXP_1).cleaned, true);
  assert.equal(stagedObjects.has(keyExp1), false);
  assert.equal(finalObjects.has(keyExp1), false);

  const resExp2 = await handlePostFinalizeVendorFinanceEvidence(
    new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_EXP_2}/finalize`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    EV_EXP_2,
    "true",
    deps,
  );
  assert.equal(resExp2.status, 409);
  assert.equal(state.get(EV_EXP_2).status, "EXPIRED");
  assert.equal(state.get(EV_EXP_2).cleaned, true);
  assert.equal(stagedObjects.has(keyExp2), false);
  assert.equal(finalObjects.has(keyExp2), false);
});

test("createVendorFinanceRepository maps known VFIN-01 & VFIN-02 SQL tokens & fails closed on non-canonical RPC projections", async () => {
  const repoConflict = createVendorFinanceRepository(async () => ({
    data: null,
    error: { code: "23514", message: "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN" },
  }));
  const conflictRes = await repoConflict.recordEntry({
    auth_subject: AUTH_ID,
    app_user_id: APP_ID,
    project_id: PROJECT_ID,
    contract_type: "SEASONAL",
    vendor_id: "VND_INACTIVE",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
    idempotency_key: IDEM_1,
    request_fingerprint: "a".repeat(64),
  });
  assert.deepEqual(conflictRes, {
    ok: false,
    code: "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN",
  });

  const origError = console.error;
  console.error = () => {};
  try {
    const repoMalformed = createVendorFinanceRepository(async () => ({
      data: {
        authorization_date: "2026-10-24",
        allowed: true,
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage_project_assignments: true,
        visibility_scope: "ALL",
        record_scope: "ALL",
        reconcile_scope: "ALL",
        global_role_code: null,
        active_assigned_project_count: 0,
        authority_source: "full_admin",
        leaked_app_user_id: APP_ID,
      },
      error: null,
    }));
    const malformedRes = await repoMalformed.getActorAccess({
      auth_subject: AUTH_ID,
      app_user_id: APP_ID,
    });
    assert.deepEqual(malformedRes, {
      ok: false,
      code: "VENDOR_FINANCE_UNAVAILABLE",
    });
  } finally {
    console.error = origError;
  }
});

test("VFIN-04 HTTP authority & shared advance / export routes: CASH_HOLDER vs Project Accountant vs Export Row Cap", async () => {
  // 1. CASH_HOLDER (can_record=false, can_fund_vendor_advance=true, can_record_vendor_refund=true, can_apply_vendor_advance=false)
  const cashHolderRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      allowed: true,
      can_view: true,
      can_record: false,
      can_reconcile: true,
      can_manage_project_assignments: false,
      can_view_shared_advance: true,
      can_fund_vendor_advance: true,
      can_record_vendor_refund: true,
      can_apply_vendor_advance: false,
      visibility_scope: "ALL",
      record_scope: "NONE",
      reconcile_scope: "ALL",
      global_role_code: "CASH_HOLDER",
      active_assigned_project_count: 0,
      authority_source: "global_role",
    },
  });
  const cashHolderDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: cashHolderRepo.repository,
  };

  // CASH_HOLDER can fund shared advance
  const fundRes = await handlePostFundVendorSharedAdvance(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/fund`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        amount_minor: "100000000",
        effective_date: "2026-10-24",
        reason: "Ứng tiền dùng chung cho Vendor Alpha",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    cashHolderDeps,
  );
  assert.equal(fundRes.status, 201);
  const fundJson = await fundRes.json();
  assert.equal(fundJson.data.shared_advance_balance_minor, "100000000");

  // Sending project_id to fund or refund is rejected with 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const fundWithProjectRes = await handlePostFundVendorSharedAdvance(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/fund`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        amount_minor: "100000000",
        effective_date: "2026-10-24",
        reason: "Ứng tiền kèm project_id",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    cashHolderDeps,
  );
  assert.equal(fundWithProjectRes.status, 400);
  assert.deepEqual(await fundWithProjectRes.json(), {
    ok: false,
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });

  // CASH_HOLDER can record vendor refund
  const refundRes = await handlePostRecordVendorRefund(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/refund`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        amount_minor: "10000000",
        effective_date: "2026-10-24",
        reason: "Vendor hoàn ứng tiền mặt",
        idempotency_key: IDEM_2,
      }),
    }),
    "VND_ALPHA",
    "true",
    cashHolderDeps,
  );
  assert.equal(refundRes.status, 201);

  // CASH_HOLDER can reverse shared advance movement
  const revSharedRes = await handlePostReverseVendorSharedAdvanceMovement(
    new Request(`${ORIGIN}/api/vendor-finance/shared-advances/${ENTRY_ID}/reverse`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        effective_date: "2026-10-24",
        reason: "Đảo bút toán hoàn ứng",
        idempotency_key: IDEM_3,
      }),
    }),
    ENTRY_ID,
    "true",
    cashHolderDeps,
  );
  assert.equal(revSharedRes.status, 201);

  // CASH_HOLDER is denied on apply-offset and project sub-ledger entry
  const cashApplyDenied = await handlePostApplyVendorSharedAdvanceOffset(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/apply-offset`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    cashHolderDeps,
  );
  assert.equal(cashApplyDenied.status, 403);
  assert.deepEqual(await cashApplyDenied.json(), {
    ok: false,
    code: "VENDOR_FINANCE_RECORD_DENIED",
  });

  // 2. Project Accountant (can_record=true, can_fund_vendor_advance=false, can_record_vendor_refund=false, can_apply_vendor_advance=true)
  const acctRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      allowed: true,
      can_view: true,
      can_record: true,
      can_reconcile: true,
      can_manage_project_assignments: false,
      can_view_shared_advance: true,
      can_fund_vendor_advance: false,
      can_record_vendor_refund: false,
      can_apply_vendor_advance: true,
      visibility_scope: "PROJECT_SCOPED",
      record_scope: "ASSIGNED_PROJECTS",
      reconcile_scope: "ASSIGNED_PROJECTS",
      global_role_code: null,
      active_assigned_project_count: 1,
      authority_source: "accounting_department",
    },
  });
  const acctDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: acctRepo.repository,
  };

  // Project Accountant is denied on fund and refund
  for (const deniedCall of [
    () =>
      handlePostFundVendorSharedAdvance(
        new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/fund`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "VND_ALPHA",
        "true",
        acctDeps,
      ),
    () =>
      handlePostRecordVendorRefund(
        new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/refund`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "VND_ALPHA",
        "true",
        acctDeps,
      ),
  ]) {
    const res = await deniedCall();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "VENDOR_FINANCE_RECORD_DENIED" });
  }

  // Project Accountant can view shared advances, apply offset, and export vendors (GET & POST)
  const listMovRes = await handleGetVendorSharedAdvanceMovements(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances`),
    "VND_ALPHA",
    "true",
    acctDeps,
  );
  assert.equal(listMovRes.status, 200);

  const applyOffsetRes = await handlePostApplyVendorSharedAdvanceOffset(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/apply-offset`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        project_id: PROJECT_ID,
        contract_type: "SEASONAL",
        amount_minor: "15000000",
        effective_date: "2026-10-24",
        reason: "Khấu trừ ứng vào công nợ thời vụ dự án Miền Bắc",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    acctDeps,
  );
  assert.equal(applyOffsetRes.status, 201);
  const applyOffsetJson = await applyOffsetRes.json();
  assert.equal(applyOffsetJson.data.entry.entry_type, "ADVANCE_OFFSET_RECORDED");
  assert.equal(applyOffsetJson.data.shared_advance_balance_minor, "85000000");
  assert.equal(applyOffsetJson.data.subledger_balance_minor, "0");

  const getExportRes = await handleGetExportVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/export?project_id=${PROJECT_ID}&contract_type=SEASONAL`),
    "true",
    acctDeps,
  );
  assert.equal(getExportRes.status, 200);
  assert.equal(
    getExportRes.headers.get("content-type"),
    VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE,
  );
  assert.match(
    getExportRes.headers.get("content-disposition") ?? "",
    /attachment;\s*filename="danh-sach-vendor-cong-no-2026-10-24\.xlsx"/,
  );
  assert.equal(getExportRes.headers.get("cache-control"), "private, no-store");
  assert.equal(getExportRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(getExportRes.headers.get("referrer-policy"), "no-referrer");
  const exportBytes = new Uint8Array(await getExportRes.arrayBuffer());
  assert.equal(exportBytes[0], 0x50);
  assert.equal(exportBytes[1], 0x4b);
  assert.equal(exportBytes[2], 0x03);
  assert.equal(exportBytes[3], 0x04);

  // 3. Export row cap exceeded returns 422 VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED
  const capExceededDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: {
      ...acctRepo.repository,
      async exportVendors() {
        return { ok: false, code: "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED" };
      },
    },
  };
  const capExceededRes = await handleGetExportVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/export`),
    "true",
    capExceededDeps,
  );
  assert.equal(capExceededRes.status, 422);
  assert.deepEqual(await capExceededRes.json(), {
    ok: false,
    code: "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED",
  });
});

test("VFIN-04 XLSX export builder & route: 8 canonical columns, exact BigInt text strings, formula neutralization, empty list, and sanitized 503 on builder failure", async () => {
  const sampleData = {
    authorization_date: "2026-10-24",
    allowed_actions: {
      can_view: true,
      can_record: true,
      can_reconcile: true,
      can_manage_project_assignments: false,
      can_view_shared_advance: true,
      can_fund_vendor_advance: false,
      can_record_vendor_refund: false,
      can_apply_vendor_advance: true,
      visibility_scope: "ALL",
    },
    filters: {
      search: "",
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: "ALL",
      contract_type: "all",
    },
    summary: {
      total_payable_minor: "9007199254740993",
      total_advance_minor: "0",
      total_shared_advance_minor: "123456789012345678",
      net_balance_minor: "9007199254740993",
      vendors_with_balance_count: 1,
    },
    total: 4,
    vendors: [
      {
        vendor_id: "=VND_FORMULA",
        display_name: "+Công ty TNHH Tiếng Việt Đặc Biệt",
        active: true,
        payable_total_minor: "9007199254740993",
        current_balance_minor: "9007199254740993",
        balance_direction: "PAYABLE",
        shared_advance_balance_minor: "123456789012345678",
        entry_count: 3,
        has_opening_entry: true,
        last_effective_date: "2026-10-24",
        sub_ledger_count: 2,
        sub_ledgers: [],
        latest_reconciliation: null,
      },
      {
        vendor_id: "-VND_MINUS",
        display_name: "@Vendor Inactive",
        active: false,
        payable_total_minor: "0",
        current_balance_minor: "0",
        balance_direction: "BALANCED",
        shared_advance_balance_minor: "0",
        entry_count: 0,
        has_opening_entry: false,
        last_effective_date: null,
        sub_ledger_count: 0,
        sub_ledgers: [],
        latest_reconciliation: null,
      },
      {
        vendor_id: "\t=VND_TAB_FORMULA",
        display_name: "  +Leading Whitespace Formula",
        active: true,
        payable_total_minor: "500000",
        current_balance_minor: "500000",
        balance_direction: "PAYABLE",
        shared_advance_balance_minor: "250000",
        entry_count: 1,
        has_opening_entry: true,
        last_effective_date: "2026-10-20",
        sub_ledger_count: 1,
        sub_ledgers: [],
        latest_reconciliation: null,
      },
    ],
  };

  const bytes = await buildVendorFinanceExportXlsx(sampleData.vendors);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const sheet = workbook.getWorksheet(VENDOR_FINANCE_EXPORT_WORKSHEET_NAME);
  assert.ok(sheet);

  const headerValues = VENDOR_FINANCE_EXPORT_COLUMNS.map((_, idx) =>
    String(sheet.getRow(1).getCell(idx + 1).value ?? ""),
  );
  assert.deepEqual(headerValues, [
    "STT",
    "Mã Vendor",
    "Tên Vendor",
    "Trạng thái",
    "Số sổ dự án",
    "Công nợ phải trả (VND)",
    "Số dư ứng dùng chung (VND)",
    "Ngày giao dịch gần nhất",
  ]);

  // Row 2: Formula neutralized & BigInt preserved as exact string without precision loss
  const row2 = sheet.getRow(2);
  assert.equal(row2.getCell(1).value, "1");
  assert.equal(row2.getCell(2).value, "'=VND_FORMULA");
  assert.equal(row2.getCell(3).value, "'+Công ty TNHH Tiếng Việt Đặc Biệt");
  assert.equal(row2.getCell(4).value, "Đang hoạt động");
  assert.equal(row2.getCell(5).value, "2");
  assert.equal(row2.getCell(6).value, "9007199254740993");
  assert.equal(row2.getCell(7).value, "123456789012345678");
  assert.equal(row2.getCell(8).value, "2026-10-24");

  // Row 3: Zero amounts and inactive vendor
  const row3 = sheet.getRow(3);
  assert.equal(row3.getCell(2).value, "'-VND_MINUS");
  assert.equal(row3.getCell(3).value, "'@Vendor Inactive");
  assert.equal(row3.getCell(4).value, "Ngừng hoạt động");
  assert.equal(row3.getCell(6).value, "0");
  assert.equal(row3.getCell(7).value, "0");
  assert.equal(row3.getCell(8).value, "");

  // Row 4: Leading whitespace + formula trigger neutralized
  const row4 = sheet.getRow(4);
  assert.equal(row4.getCell(2).value, "'\t=VND_TAB_FORMULA");
  assert.equal(row4.getCell(3).value, "'  +Leading Whitespace Formula");

  // Empty vendor list produces valid 1-row (header-only) workbook
  const emptyBytes = await buildVendorFinanceExportXlsx([]);
  const emptyWb = new ExcelJS.Workbook();
  await emptyWb.xlsx.load(Buffer.from(emptyBytes));
  const emptySheet = emptyWb.getWorksheet(VENDOR_FINANCE_EXPORT_WORKSHEET_NAME);
  assert.equal(emptySheet.rowCount, 1);

  // Builder exception returns 503 VENDOR_FINANCE_UNAVAILABLE and never logs vendor names/amounts
  const loggedErrors = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    loggedErrors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const baseMock = makeMockRepository();
    const failBuilderRes = await handleGetExportVendorFinanceVendors(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/export`),
      "true",
      {
        resolveSession: async () => makeSession(),
        repository: baseMock.repository,
        buildExportXlsx: async () => {
          throw new Error("Sensitive failure for Vendor Alpha 9007199254740993");
        },
      },
    );
    assert.equal(failBuilderRes.status, 503);
    assert.deepEqual(await failBuilderRes.json(), {
      ok: false,
      code: "VENDOR_FINANCE_UNAVAILABLE",
    });
    assert.equal(loggedErrors.some((line) => line.includes("Vendor Alpha") || line.includes("9007199254740993")), false);
  } finally {
    console.error = origConsoleError;
  }
});

test("VFIN-05 handlePostRecordVendorPaymentWithOffset: atomic combined payment + advance offset (201, 200 replay, 400 validation, 422 insufficient balance)", async () => {
  const { repository, calls } = makeMockRepository();
  const deps = {
    resolveSession: async () => makeSession(),
    repository,
  };

  const validBody = {
    project_id: PROJECT_ID,
    contract_type: "SEASONAL",
    payment_amount_minor: "6000000",
    offset_amount_minor: "4000000",
    effective_date: "2026-10-25",
    reason: "Thanh toán 6tr TM/CK + khấu trừ ứng 4tr COASIA",
    idempotency_key: IDEM_1,
  };

  const createdRes = await handlePostRecordVendorPaymentWithOffset(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/settle-with-offset`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "Idempotency-Key": IDEM_1,
      },
      body: JSON.stringify(validBody),
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(createdRes.status, 201);
  const createdJson = await createdRes.json();
  assert.equal(createdJson.ok, true);
  assert.equal(createdJson.data.payment_entry.entry_type, "PAYMENT_RECORDED");
  assert.equal(createdJson.data.payment_entry.amount_minor, "6000000");
  assert.equal(createdJson.data.offset_entry.entry_type, "ADVANCE_OFFSET_RECORDED");
  assert.equal(createdJson.data.offset_entry.amount_minor, "4000000");
  assert.equal(createdJson.data.movement.movement_type, "PROJECT_OFFSET_APPLIED");
  assert.equal(createdJson.data.replayed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "recordPaymentWithOffset");

  // Invalid zero payment_amount_minor -> 422 VENDOR_FINANCE_AMOUNT_INVALID
  const badAmountRes = await handlePostRecordVendorPaymentWithOffset(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/shared-advances/settle-with-offset`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({ ...validBody, payment_amount_minor: "0" }),
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(badAmountRes.status, 422);
  assert.deepEqual(await badAmountRes.json(), {
    ok: false,
    code: "VENDOR_FINANCE_AMOUNT_INVALID",
  });
});

