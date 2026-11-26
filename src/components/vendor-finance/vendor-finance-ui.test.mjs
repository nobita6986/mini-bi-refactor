import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relUrl) => readFileSync(new URL(relUrl, import.meta.url), "utf8");

const pkgJson = JSON.parse(read("../../../package.json"));
const navRegistry = read("../../lib/navigation/registry.ts");
const desktopNav = read("../app-shell/desktop-nav.tsx");
const mobileNav = read("../app-shell/mobile-nav.tsx");
const appShell = read("../app-shell/app-shell.tsx");

const financeGate = read("../../app/finance/_lib/finance-page-gate.tsx");
const financeLayout = read("../../app/finance/layout.tsx");
const financeIndexPage = read("../../app/finance/page.tsx");
const financeVendorsPage = read("../../app/finance/vendors/page.tsx");
const financeOpeningPage = read("../../app/finance/opening-balance/page.tsx");
const financeVendorDetailPage = read("../../app/finance/vendors/[vendorId]/page.tsx");
const financeDocumentPage = read("../../app/finance/documents/[entryId]/page.tsx");
const financeReportsPage = read("../../app/finance/reports/page.tsx");
const financeProjectAssignmentsPage = read("../../app/finance/project-assignments/page.tsx");

const uiModel = read("../../lib/vendor-finance/ui-model.ts");
const listView = read("./vendor-finance-list-view.tsx");
const detailView = read("./vendor-finance-detail-view.tsx");
const openingWizard = read("./opening-balance-wizard.tsx");
const entryDialogs = read("./vendor-finance-entry-dialogs.tsx");
const evidenceDialogs = read("./vendor-finance-evidence-dialog.tsx");
const documentView = read("./vendor-finance-document-view.tsx");
const monthlyReportView = read("./vendor-finance-monthly-report-view.tsx");
const governanceView = read("./vendor-finance-governance-view.tsx");
const documentCss = read("./vendor-finance-document.module.css");

test("Navigation & AppShell register Tài chính group with Công nợ Vendor (/finance), server capability predicate, feature gate, and print-hidden header", () => {
  assert.match(navRegistry, /"finance":\s*"Tài chính"/);
  assert.match(navRegistry, /id:\s*"finance"/);
  assert.match(navRegistry, /label:\s*"Công nợ Vendor"/);
  assert.match(navRegistry, /path:\s*"\/finance"/);
  assert.match(navRegistry, /capability:\s*"finance"/);
  assert.match(navRegistry, /group:\s*"finance"/);
  assert.match(desktopNav, /"finance":\s*Landmark/);
  assert.match(desktopNav, /finance:\s*Receipt/);
  assert.match(mobileNav, /finance:\s*Receipt/);
  assert.match(appShell, /entry\.id !== "finance" \|\| vendorFinanceEnabled/);
  assert.match(appShell, /process\.env\.DIRECT_ENTRY_API_ENABLED === "true"/);
  assert.match(appShell, /print:hidden/);
});

test("/finance/** routes enforce server-side renderVendorFinancePageGate with view vs record modes and Next.js 16 async params", () => {
  assert.match(financeLayout, /export const dynamic = "force-dynamic"/);
  assert.match(financeLayout, /resolveNavActorForAppShell\(/);
  assert.match(financeLayout, /<AppShell actor=\{actor\}>/);

  assert.match(financeGate, /import "server-only"/);
  assert.match(financeGate, /await connection\(\)/);
  assert.match(financeGate, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
  assert.match(financeGate, /resolveActorForRequest\(\)/);
  assert.match(financeGate, /createVendorFinanceRepository\(\)\.getActorAccess\(/);
  assert.match(financeGate, /decideVendorFinancePageAccess\(/);
  assert.match(financeGate, /case "NOT_FOUND":\s*notFound\(\)/);
  assert.match(financeGate, /case "REDIRECT_LOGIN":/);
  assert.match(financeGate, /case "ACCOUNT_UNAVAILABLE":\s*return <AccountUnavailable \/>/);
  assert.match(financeGate, /case "TEMPORARY_UNAVAILABLE":\s*return <TemporaryUnavailable \/>/);
  assert.match(financeGate, /case "ACCESS_DENIED":\s*return <AccessDenied \/>/);

  for (const pageSrc of [
    financeIndexPage,
    financeVendorsPage,
    financeOpeningPage,
    financeVendorDetailPage,
    financeDocumentPage,
    financeReportsPage,
    financeProjectAssignmentsPage,
  ]) {
    assert.match(pageSrc, /export const dynamic = "force-dynamic"/);
    assert.match(pageSrc, /renderVendorFinancePageGate\(/);
  }

  // Opening balance wizard route is strictly gated by `requiredMode: "record"` (blocks BoD / view-only on direct URL)
  assert.match(financeOpeningPage, /requiredMode:\s*"record"/);
  // Project assignments & global roles governance route is strictly gated by `requiredMode: "admin"`
  assert.match(financeProjectAssignmentsPage, /requiredMode:\s*"admin"/);
  for (const viewPageSrc of [
    financeIndexPage,
    financeVendorsPage,
    financeVendorDetailPage,
    financeDocumentPage,
    financeReportsPage,
  ]) {
    assert.match(viewPageSrc, /requiredMode:\s*"view"/);
  }

  // Next.js 16 async params validation
  assert.match(financeVendorDetailPage, /params:\s*Promise<\{\s*vendorId:\s*string\s*\}>/);
  assert.match(financeVendorDetailPage, /await params/);
  assert.match(financeVendorDetailPage, /isCanonicalUiVendorId\(/);
  assert.match(financeDocumentPage, /params:\s*Promise<\{\s*entryId:\s*string\s*\}>/);
  assert.match(financeDocumentPage, /await params/);
  assert.match(financeDocumentPage, /isUuidString\(/);
});

test("Vendor List & Detail views implement KPIs, debounced search, pagination, view-only gating, and non-optimistic server refreshes", () => {
  // Vendor list view
  assert.match(listView, /PageShell/);
  assert.match(listView, /PageHeader/);
  assert.match(listView, /FilterToolbar/);
  assert.match(listView, /DataTableContainer/);
  assert.match(listView, /DATA_TABLE_CLASS/);
  assert.match(listView, /OffsetPager/);
  assert.match(listView, /StatusBadge/);
  assert.match(listView, /vfin-kpi-payable/);
  assert.match(listView, /vfin-kpi-advance/);
  assert.match(listView, /vfin-kpi-nonzero-count/);
  assert.match(listView, /vfin-kpi-net/);
  assert.match(listView, /vfin-view-only-badge/);
  assert.match(listView, /canRecord \? \(\s*<Link\s+href="\/finance\/opening-balance"/);
  assert.doesNotMatch(listView, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

  // Vendor detail view: KPIs, accessible tablist, CursorLoadMore ledger, OffsetPager reconciliations, role-gated write CTAs
  assert.match(detailView, /CursorLoadMore/);
  assert.match(detailView, /OffsetPager/);
  assert.match(detailView, /role="tablist"/);
  assert.match(detailView, /role="tab"/);
  assert.match(detailView, /role="tabpanel"/);
  assert.match(detailView, /ArrowRight/);
  assert.match(detailView, /ArrowLeft/);
  assert.match(detailView, /data-ui-panel-motion="true"/);
  assert.match(detailView, /vendor\.totals\.debt_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.payroll_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.payment_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.advance_recorded_minor/);
  assert.match(detailView, /canRecord && entry\.can_reverse/);
  assert.match(detailView, /canRecord && entry\.can_attach_evidence/);
  assert.match(detailView, /canReconcile && rec\.can_attach_evidence/);
  assert.match(detailView, /vendor && canReconcile/);
  assert.match(detailView, /vendor && canRecord && allowedEntryTypes\.length > 0/);
  assert.match(detailView, /vfin-subledger-switcher/);
});

test("VFIN-02: Monthly project debt report & Full Admin governance views enforce non-netted sub-ledgers, clean 5-card KPIs (opening & in-month opening) without unbacked revenue, monthly Excel export, and OCC/idempotent admin dialogs", () => {
  assert.doesNotMatch(monthlyReportView, /PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI/);
  assert.doesNotMatch(monthlyReportView, /PROJECT_REVENUE_MISSING_SOURCE_NOTE_VI/);
  assert.doesNotMatch(monthlyReportView, /vfin-project-revenue-missing-note/);
  assert.doesNotMatch(monthlyReportView, /vfin-kpi-revenue-missing/);
  assert.doesNotMatch(monthlyReportView, /Doanh thu dự án/);
  assert.doesNotMatch(monthlyReportView, /exceljs/);
  assert.match(monthlyReportView, /summarizeMonthlyReportOpeningTotals\(/);
  assert.match(monthlyReportView, /Đầu kỳ & mở sổ/);
  assert.match(monthlyReportView, /vfin-monthly-kpi-opening-payable/);
  assert.match(monthlyReportView, /vfin-monthly-kpi-opening-advance/);
  assert.match(monthlyReportView, /vfin-monthly-kpi-opening-in-month/);
  assert.match(monthlyReportView, /vfin-monthly-row-opening-in-month/);
  assert.match(monthlyReportView, /parseMonthlyReportEnvelope\(/);
  assert.match(monthlyReportView, /buildMonthlyReportUrl\(/);
  assert.match(monthlyReportView, /buildMonthlyReportExportUrl\(/);
  assert.match(monthlyReportView, /isUsableVendorFinanceExportBlob\(/);
  assert.match(monthlyReportView, /resolveVendorFinanceMonthlyReportExportFilename\(/);
  assert.match(monthlyReportView, /vfin-monthly-export-excel-btn/);
  assert.match(monthlyReportView, /buildVendorEntriesUrl\(/);
  assert.match(monthlyReportView, /CursorLoadMore/);
  assert.doesNotMatch(monthlyReportView, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

  assert.match(governanceView, /vfin-governance-panel-assignments/);
  assert.match(governanceView, /Vendor đã phát sinh giao dịch/);
  assert.match(governanceView, /transacted_vendor_count/);
  assert.match(governanceView, /buildAssignProjectAccountantRequest\(/);
  assert.match(governanceView, /buildEndProjectAccountantRequest\(/);
  assert.match(governanceView, /href="\/admin\/access\/groups"/);
  assert.doesNotMatch(
    governanceView,
    /vfin-governance-panel-global-roles|buildAssignGlobalRoleRequest\(|buildEndGlobalRoleRequest\(/,
  );
  assert.doesNotMatch(governanceView, /vfin-governance-panel-vendors|buildSetProjectVendorLinkRequest|Liên kết Dự án – Vendor/);
  assert.doesNotMatch(governanceView, /type="checkbox"/);
});

test("VFIN-03: Contract-type sub-ledgers (Thời vụ / Chính thức / Chưa phân loại), reference total disclosure, and explicit legacy classification dialog", () => {
  assert.match(listView, /vfin-contract-type-filter/);
  assert.match(listView, /tổng tham khảo/i);
  assert.match(listView, /CONTRACT_TYPE_LABELS_VI\[sub\.contract_type\]/);

  assert.match(detailView, /vfin-reference-total-disclosure/);
  assert.match(detailView, /vfin-open-classify-subledger-btn/);
  assert.match(detailView, /vfin-subledger-classification-audit/);
  assert.match(detailView, /ClassifyVendorSubLedgerDialog/);
  assert.match(detailView, /CONTRACT_TYPE_LABELS_VI\[sub\.contract_type\]/);

  assert.match(entryDialogs, /export function ClassifyVendorSubLedgerDialog/);
  assert.match(entryDialogs, /vfin-classify-subledger-dialog/);
  assert.match(entryDialogs, /buildClassifySubLedgerRequest\(/);
  assert.match(entryDialogs, /parseClassifySubLedgerEnvelope\(/);
  assert.match(entryDialogs, /vfin-record-contract-type-select/);
  assert.match(entryDialogs, /vfin-reconciliation-subledger-select/);
  assert.match(entryDialogs, /không cho phép đổi loại hợp đồng khi hoàn tác/);

  assert.match(openingWizard, /vfin-opening-contract-type-select/);
  assert.match(documentView, /CONTRACT_TYPE_LABELS_VI\[entry\.contract_type\]/);

  assert.match(monthlyReportView, /vfin-monthly-contract-type-filter/);
  assert.match(monthlyReportView, /Lọc theo Loại hợp đồng/);
  assert.doesNotMatch(monthlyReportView, /Lọc theo Loại hợp đồng \(Sổ riêng\)/);
  assert.match(monthlyReportView, /tổng tham khảo/i);
  assert.match(monthlyReportView, /CONTRACT_TYPE_LABELS_VI\[sum\.contract_type\]/);
  assert.match(monthlyReportView, /CONTRACT_TYPE_LABELS_VI\[row\.contract_type\]/);
});

test("Entry, Reversal, Reconciliation, Evidence, and Opening Balance Wizard honor two-phase evidence commit, non-auto-adjustment, and atomic batch rules", () => {
  // Record entry & Reconciliation dialogs lock into post-commit evidence recovery if image upload fails
  assert.match(entryDialogs, /vfin-record-entry-evidence-recovery/);
  assert.match(entryDialogs, /vfin-reconciliation-evidence-recovery/);
  assert.match(entryDialogs, /uploadEvidenceForCommittedTarget\(/);
  assert.match(evidenceDialogs, /uploadEvidenceForCommittedTarget\(/);
  assert.match(evidenceDialogs, /parseEvidenceDownloadEnvelope\(/);

  // Reconciliation explicitly states it never auto-creates an adjustment and never calls /entries
  assert.match(entryDialogs, /Không tự động sinh điều chỉnh \(adjustment\)/);
  const [, recDialogSection] = entryDialogs.split("export function CreateVendorReconciliationDialog");
  assert.ok(recDialogSection);
  assert.doesNotMatch(recDialogSection, /buildVendorEntriesUrl|buildRecordEntryRequest/);

  // Opening balance 3-step wizard (`input` -> `preview` -> `confirm` -> `applied`) + whole-batch rollback alert
  assert.match(openingWizard, /vfin-opening-step-input/);
  assert.match(openingWizard, /vfin-opening-step-preview/);
  assert.match(openingWizard, /vfin-opening-step-confirm/);
  assert.match(openingWizard, /vfin-opening-step-applied/);
  assert.match(openingWizard, /buildOpeningPreviewRequest\(/);
  assert.match(openingWizard, /buildOpeningApplyRequest\(/);
  assert.match(openingWizard, /parseOpeningPreviewEnvelope\(/);
  assert.match(openingWizard, /parseOpeningApplyEnvelope\(/);
  assert.match(openingWizard, /isWholeBatchRollback/);
  assert.match(openingWizard, /Toàn bộ lô đầu kỳ bị từ chối/);
  assert.match(openingWizard, /toàn bộ lô\s+sẽ tự động hủy/);
  assert.match(uiModel, /Toàn bộ lô đầu kỳ đã được hủy nguyên vẹn/);
});

test("Semantic printable voucher uses HTML + @media print CSS, server snapshot fields, mandatory non-bank-proof disclaimer, and zero PDF libraries", () => {
  assert.match(documentView, /<article/);
  assert.match(documentView, /window\.print\(\)/);
  assert.match(documentView, /\/brand\/hrpartner-logo\.png/);
  assert.match(documentView, /entry\.vendor_display_name_snapshot/);
  assert.match(documentView, /entry\.document_no/);
  assert.match(documentView, /entry\.document_title_vi/);
  assert.match(documentView, /vfin-voucher-disclaimer/);
  assert.match(documentView, /VFIN_UI_INTERNAL_DISCLAIMER_VI/);

  assert.match(documentCss, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*12mm;\s*\}/);
  assert.match(documentCss, /@media print/);
  assert.match(documentCss, /\.screenOnly\s*\{\s*display:\s*none !important;\s*\}/);

  const allDeps = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
  };
  for (const forbiddenPdfPkg of [
    "jspdf",
    "pdfmake",
    "html2pdf.js",
    "@react-pdf/renderer",
    "puppeteer-pdf",
    "react-to-print",
  ]) {
    assert.equal(
      forbiddenPdfPkg in allDeps,
      false,
      `Forbidden PDF/print library ${forbiddenPdfPkg} must not be added`,
    );
  }
});

test("Client Vendor Finance modules contain zero browser Supabase calls, zero permission editors, zero floating-point money math, and zero node/server-only runtime imports", () => {
  const clientFiles = [
    ["ui-model.ts", uiModel],
    ["vendor-finance-list-view.tsx", listView],
    ["vendor-finance-detail-view.tsx", detailView],
    ["opening-balance-wizard.tsx", openingWizard],
    ["vendor-finance-entry-dialogs.tsx", entryDialogs],
    ["vendor-finance-evidence-dialog.tsx", evidenceDialogs],
    ["vendor-finance-document-view.tsx", documentView],
    ["vendor-finance-monthly-report-view.tsx", monthlyReportView],
    ["vendor-finance-governance-view.tsx", governanceView],
  ];

  for (const [name, src] of clientFiles) {
    assert.doesNotMatch(src, /from\s+["']node:/, `${name} must not import node:*`);
    assert.doesNotMatch(src, /["']server-only["']/, `${name} must not import server-only`);
    assert.doesNotMatch(
      src,
      /@supabase\/|supabase\.from\(|rest\/v1|service_role/i,
      `${name} must not access Supabase/PostgREST from browser`,
    );
    assert.doesNotMatch(
      src,
      /import\s+(?!type\b)[^;]*vendor-finance-contract/,
      `${name} must only use import type from vendor-finance-contract`,
    );
    assert.doesNotMatch(
      src,
      /parseFloat\s*\(|Number\.parseFloat\s*\(/,
      `${name} must not use parseFloat for monetary values`,
    );
    assert.doesNotMatch(
      src,
      /ma trận quyền|permission.?matrix|capability.?editor/i,
      `${name} must not introduce permission editor or matrix`,
    );
    assert.equal(
      src.includes("text-primary-foreground"),
      false,
      `${name} must not use broken token text-primary-foreground`,
    );
  }
});

test("VFIN-04: Vendor shared advance balance, 4 shared advance dialogs, cross-project redaction copy, monthly report offset column, and Excel (.xlsx) export", () => {
  // Target 1: Vendor list view shared advance KPI + column + Excel export button
  assert.match(listView, /vfin-kpi-shared-advance/);
  assert.match(listView, /vfin-vendor-shared-advance/);
  assert.match(listView, /canViewSharedAdvance/);
  assert.match(listView, /vfin-export-excel-btn/);
  assert.match(listView, /buildVendorExportUrl\(/);
  assert.match(listView, /isUsableVendorFinanceExportBlob\(/);
  assert.match(listView, /resolveVendorFinanceExportFilename\(/);
  assert.match(listView, /URL\.revokeObjectURL\(/);

  // Target 2: Vendor detail view shared advance card, 3rd tab, cross-project redaction copy, no evidence upload on shared advances, no legacy + Tạm ứng button
  assert.match(detailView, /vfin-detail-shared-advance-card/);
  assert.match(detailView, /vfin-detail-shared-advance-balance/);
  assert.match(detailView, /vfin-open-fund-advance-btn/);
  assert.match(detailView, /vfin-open-vendor-refund-btn/);
  assert.match(detailView, /vfin-open-apply-offset-btn/);
  assert.match(detailView, /vfin-tab-shared-advances/);
  assert.match(detailView, /vfin-shared-advances-table/);
  assert.match(detailView, /VFIN_UI_REDACTED_FIELD_LABEL_VI/);
  assert.match(detailView, /vfin-reverse-shared-movement-btn/);
  assert.doesNotMatch(detailView, /\+ Tạm ứng/);

  // Shared-advance effect & stale load-more regression guards
  assert.match(
    detailView,
    /detail !== null &&\s*detail\.vendor\.vendor_id === vendorId &&\s*detail\.allowed_actions\.can_view_shared_advance === true/,
  );
  assert.match(
    detailView,
    /\[vendorId,\s*canViewSharedAdvance,\s*movementTypeFilter,\s*refreshNonce\]/,
  );
  assert.match(
    detailView,
    /resolvedActiveTab:\s*DetailTab\s*=\s*activeTab === "shared_advances" && !canViewSharedAdvance \? "ledger" : activeTab/,
  );
  assert.match(detailView, /sharedMovementsRequestGenRef/);
  assert.match(detailView, /sharedLoadMoreAbortRef/);
  assert.match(detailView, /shouldCommitSharedAdvanceLoadMore\(/);
  assert.match(detailView, /mergeUniqueSharedAdvanceMovements\(/);

  // Target 3: Shared advance mutation dialogs + balance-race reload + no ADVANCE_RECORDED / OPENING_ADVANCE creation paths
  assert.match(entryDialogs, /export function FundVendorSharedAdvanceDialog/);
  assert.match(entryDialogs, /vfin-fund-shared-advance-dialog/);
  assert.match(entryDialogs, /export function RecordVendorRefundDialog/);
  assert.match(entryDialogs, /vfin-record-vendor-refund-dialog/);
  assert.doesNotMatch(entryDialogs, /ApplyVendorSharedAdvanceOffsetDialog/);
  assert.doesNotMatch(entryDialogs, /vfin-apply-shared-advance-offset-dialog/);
  assert.doesNotMatch(detailView, /ApplyVendorSharedAdvanceOffsetDialog/);
  assert.match(entryDialogs, /export function ReverseVendorSharedAdvanceMovementDialog/);
  assert.match(entryDialogs, /vfin-reverse-shared-advance-dialog/);
  assert.match(entryDialogs, /VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE/);
  assert.match(entryDialogs, /VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE/);
  assert.match(entryDialogs, /t !== "ADVANCE_RECORDED"/);
  assert.match(openingWizard, /VFIN_UI_CREATOR_OPENING_ENTRY_TYPES/);

  // Target 4: Monthly report separate advance_offset_in_month_minor KPI, summary column, and detail column
  assert.match(monthlyReportView, /vfin-monthly-kpi-advance-offset/);
  assert.match(monthlyReportView, /vfin-monthly-summary-advance-offset/);
  assert.match(monthlyReportView, /vfin-monthly-row-advance-offset/);
  assert.match(monthlyReportView, /totals\.advance_offset_in_month_minor/);
  assert.match(monthlyReportView, /sum\.advance_offset_in_month_minor/);
  assert.match(monthlyReportView, /row\.advance_offset_in_month_minor/);

  // Target 5 (VFIN-05): Unified Payment + Advance Offset form in RecordVendorEntryDialog + lost-response retry lock + active accountant sub-ledger resolution
  assert.match(entryDialogs, /vfin-record-payment-amount-input/);
  assert.match(entryDialogs, /vfin-record-offset-amount-input/);
  assert.match(entryDialogs, /vfin-record-settlement-summary/);
  assert.match(entryDialogs, /buildRecordPaymentWithOffsetRequest\(/);
  assert.match(entryDialogs, /buildRecordVendorPaymentWithOffsetUrl\(/);
  assert.match(entryDialogs, /parseRecordPaymentWithOffsetEnvelope\(/);
  assert.match(entryDialogs, /resolveActiveProjectSubLedgerForRecord\(/);
  assert.match(entryDialogs, /applyRecordEntryDialogDraftEdit\(/);
  assert.match(entryDialogs, /applyRecordEntryMutationOutcome\(/);
  assert.match(entryDialogs, /canDismissRecordEntryDialog\(/);
  assert.match(entryDialogs, /attemptCloseRecordEntryDialog\(/);
  assert.match(entryDialogs, /reloadLedgerForAmbiguousRetryVerification\(/);
  assert.match(entryDialogs, /unlockRecordEntryDialogAfterLedgerReconciliation\(/);
  assert.match(
    entryDialogs,
    /closeDisabled=\{submitting \|\| retryingEvidence \|\| reloadingLedger \|\| ambiguousRetryLocked\}/,
  );
  assert.match(entryDialogs, /vfin-record-ambiguous-retry-lock/);
  assert.match(entryDialogs, /vfin-record-reload-ledger-btn/);
  assert.match(entryDialogs, /vfin-record-reloaded-ledger-preview/);
  assert.match(entryDialogs, /vfin-record-unlock-after-reconcile-btn/);
  assert.match(detailView, /openUnifiedOffsetDialog/);
});

test("Compact Vendor Finance UI: streamlined PageHeaders, aligned filter grids with bold foreground labels, updated table headers/data-labels, and single-line currency formatting", () => {
  // 1. Vendor list view
  assert.match(listView, /<PageHeader\s+title="Công nợ & Tạm ứng Vendor"\s+actions=\{/);
  assert.doesNotMatch(listView, /eyebrow="Tài chính Vendor theo Dự án & Kế toán phụ trách"/);
  assert.match(listView, /Không bù trừ chéo sổ/);
  assert.match(listView, /grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4/);
  assert.match(listView, /font-semibold text-foreground/);
  assert.match(listView, /<th scope="col"[^>]*>\s*Sổ theo DA x KT x HĐ\s*<\/th>/);
  assert.doesNotMatch(listView, /Sổ theo Dự án × Kế toán phụ trách × Loại HĐ \(Không bù trừ\)/);
  assert.match(listView, /data-label="Sổ theo DA x KT x HĐ"/);
  assert.match(listView, /<th\s+scope="col"\s+data-testid="vfin-th-shared-advance"[^>]*>\s*Dư ứng\s*<\/th>/);
  assert.match(listView, /data-label="Dư ứng"/);
  assert.match(listView, /<th scope="col"[^>]*>\s*Công nợ\s*<\/th>/);
  assert.match(listView, /data-label="Công nợ"/);
  assert.match(listView, /<th scope="col"[^>]*>\s*GD gần nhất\s*<\/th>/);
  assert.match(listView, /data-label="GD gần nhất"/);
  assert.match(listView, /whitespace-nowrap/);
  assert.match(listView, /LIST_TD_CLASS\s*=\s*`\$\{DATA_TABLE_TD_CLASS\}[^`]*align-middle`/);
  assert.doesNotMatch(listView, /align-top/);

  // 2. Monthly report view
  assert.match(monthlyReportView, /<PageHeader\s+title="Báo cáo công nợ Vendor theo Dự án & Tháng"\s+actions=\{/);
  assert.doesNotMatch(monthlyReportView, /eyebrow="Báo cáo quản trị tài chính dự án"/);
  assert.match(monthlyReportView, /grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5/);
  assert.doesNotMatch(monthlyReportView, /grid-cols-1 items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4/);
  assert.match(monthlyReportView, /whitespace-normal break-words/);
  assert.match(monthlyReportView, /whitespace-nowrap/);
  assert.match(monthlyReportView, /REPORT_TD_CLASS\s*=\s*`\$\{DATA_TABLE_TD_CLASS\}[^`]*align-middle`/);
  assert.doesNotMatch(monthlyReportView, /align-top/);

  // 3. Vendor detail view
  assert.match(detailView, /<PageHeader\s+title=\{vendor \? vendor\.display_name : "Chi tiết tài chính Vendor"\}\s+badge=\{/);
  assert.doesNotMatch(detailView, /eyebrow=\{`Mã Vendor: \$\{vendorId\}`\}/);
  assert.match(detailView, /Mã Vendor: \{vendorId\}/);
  assert.match(detailView, /whitespace-nowrap/);
});
