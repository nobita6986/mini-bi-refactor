/**
 * P2.5-W06 - Source/structure test cho Worker Operations UI.
 * (tsx khong import duoc bang node:test => kiem tra o muc source + test logic thuan trong
 *  src/lib/direct-entry/worker-operations-model.test.mjs)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const catalogFilterCombobox = readFileSync(new URL("../ui/catalog-filter-combobox.tsx", import.meta.url), "utf8");
const directEntry = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const changeRequestsWorkspace = readFileSync(
  new URL("./change-requests-workspace.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../../app/direct-entry/workers/page.tsx", import.meta.url), "utf8");
const reviewer = readFileSync(
  new URL("./direct-entry-change-request-reviewer.tsx", import.meta.url), "utf8");
const workerDetailDialog = readFileSync(
  new URL("./worker-detail-dialog.tsx", import.meta.url), "utf8");
const registry = readFileSync(
  new URL("../../lib/navigation/registry.ts", import.meta.url), "utf8");

test("W06: la client component, khong import server-only hay ai-*", () => {
  assert.ok(source.includes('"use client"'));
  assert.equal(source.includes("server-only"), false);
  assert.equal(/from\s+["']@\/lib\/ai\//.test(source), false);
});

test("W06: ba tab khong tron quan he + tablist keyboard arrow/Home/End", () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /visibleWorkerTabs\(allowedTabs\)/);
  assert.match(source, /tabs\.map\(/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.ok(source.includes(key), "thieu keyboard " + key);
  }
  assert.match(source, /aria-selected/);
  assert.match(source, /tabIndex=\{tab === value \? 0 : -1\}/);
});

test("W06: CTA de xuat chi render khi server propose_change; khong disable", () => {
  assert.match(source, /proposeCta\(row\)/);
  assert.match(source, /cta\.show \?/);
  // Khong co nut de xuat nao bi disable/aria-disabled.
  assert.equal(/disabled=\{!cta|aria-disabled/.test(source), false);
  // Khong suy quyen tu role/email/created_by/recruiter_id trong CODE (comment khong tinh).
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
  for (const forbidden of ["role ===", "email", "created_by", "is_admin", "auth_subject", "app_user_id"]) {
    assert.equal(code.includes(forbidden), false, "khong duoc suy quyen tu " + forbidden);
  }
});

test("W06-R2: uploader/submission vs recruited|managed|all/directory dung projector that", () => {
  assert.match(source, /tabScope\(tab\)/);
  assert.match(source, /parseSubmissionPageResponse/);
  assert.match(source, /parseWorkerPageResponse/);
  assert.match(source, /workersQuery\(\{[\s\S]{0,80}scope, \.\.\.workerFilters, cursor/);
  assert.match(source, /submissionsQuery\(cursor\)/);
});

test("R1.1: Team tab uses the server-authorized team scope and direct edit uses the row signal", () => {
  assert.match(source, /visibleWorkerTabs\(/);
  assert.match(source, /initialWorkerTab\(actor, canSeeAllWorkers, canSeeTeamWorkers/);
  assert.match(source, /team: emptyTabPage\(\)/);
  assert.match(source, /const canDirectEdit = row\.allowed_actions\.direct_edit/);
  assert.match(source, /!canDirectEdit && cta\.show \?/);
  assert.doesNotMatch(source, /canPrivilegedEditWorkers|canPrivilegedEdit=|canDirectlyCorrectWorkers/);
  assert.match(source, /scope, \.\.\.workerFilters, cursor/);
  assert.match(page, /resolveAllowedWorkerOperationsTabs\(projection\)/);
  assert.match(page, /allowedTabs=\{allowedTabs\}/);
  assert.match(page, /workerOperationsTeamScopePredicate\(projection\)/);
  assert.match(page, /canSeeTeamWorkers=\{canSeeTeamWorkers\}/);
  assert.doesNotMatch(page, /canPrivilegedEditWorkers|canDirectlyCorrectWorkers/);
});

test("W06-R2: phan trang that - cursor, Tai them, append dedupe, reset khi doi tab/filter", () => {
  assert.match(source, /applyPage\(/);
  assert.match(source, /failLoad\(/);
  assert.match(source, /resetTabPage\(\)/);
  assert.match(source, /hasMore=\{/);
  assert.match(source, /Tải thêm/);
  assert.match(source, /loadMore\(/);
  assert.match(source, /workerRowKey|submissionRowKey/);
  // Doi tab/filter reset page cua scope tuong ung.
  assert.match(source, /setWorkerPages\(\(pages\) => \(\{ \.\.\.pages, \[next as WorkerScopeTab\]: resetTabPage\(\) \}\)\)/);
  assert.match(source, /setSubmissionPage\(resetTabPage\(\)\)/);
});

test("worker directory displays server-filtered totals, not only the loaded page", () => {
  assert.match(source, /summary: parsed\.summary/);
  assert.match(source, /data-testid="worker-filter-summary"/);
  assert.match(
    source,
    /data-testid="worker-filter-summary"[\s\S]{0,120}font-bold text-foreground/,
    "filter summary row must be styled bold and prominent",
  );
  for (const field of ["total_workers", "project_count", "recruiter_count"]) {
    assert.match(source, new RegExp("workerSummary\\." + field));
    assert.match(
      source,
      new RegExp(
        `<span className="text-red-600 dark:text-red-400">\\s*\\{workerSummary\\.${field}\\.toLocaleString\\("vi-VN"\\)\\}\\s*<\\/span>`,
      ),
      `summary count ${field} must be highlighted in red`,
    );
  }
  const summaryBlock =
    source.match(/data-testid="worker-filter-summary"[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.equal(
    (summaryBlock.match(/text-red-600 dark:text-red-400/g) ?? []).length,
    3,
    "only the three summary numbers (total_workers, project_count, recruiter_count) are highlighted in red",
  );
  assert.match(source, /filters\.status === "" \? "Tất cả" : workerStatusLabel\(filters\.status\)/);
  assert.match(source, /workerProviderTypeLabel\(filters\.providerType\)/);
  assert.match(source, /data-testid="worker-filter-provider-type"/);
  assert.match(source, /data-testid="worker-filter-labor-type"/);
  assert.match(source, /data-testid="worker-filter-date-from"/);
  assert.match(source, /data-testid="worker-filter-date-to"/);
  assert.match(source, /data-testid="worker-clear-filters"/);
  assert.match(source, /validateWorkerDirectoryDateRange/);
  assert.match(source, /setWorkerSummary\(null\)/,
    "filter/tab changes clear the previous query's summary while the next response loads");
});

test("labor_type filter shares the desktop row with Dự án and Người tuyển, reuses catalog options, and stays separate from provider_type", () => {
  assert.match(source, /sortedActiveLaborTypes\(filterCatalog\?\.labor_types\)/);
  assert.match(source, /label htmlFor=\{laborTypeFilterId\}[\s\S]{0,120}Loại hình lao động/);
  assert.match(
    source,
    /data-testid="worker-filter-labor-type"[\s\S]{0,260}<option value="">Tất cả<\/option>[\s\S]{0,220}laborTypeFilterOptions\.map/,
  );
  assert.match(source, /changeFilter\("laborType", event\.target\.value\)/);
  assert.match(source, /changeFilter\("providerType", event\.target\.value\)/);
  assert.match(
    source,
    /className="lg:col-span-4"[\s\S]{0,1000}label="Dự án"[\s\S]{0,1000}className="lg:col-span-4"[\s\S]{0,1000}label="Người tuyển"[\s\S]{0,1000}sm:col-span-2 lg:col-span-4[\s\S]{0,500}Loại hình lao động/,
  );
});

test("R1.2-B: search is bounded, server-filtered, resets paging and omits the export hint", () => {
  assert.match(source, /<input id=\{searchId\} type="search"/);
  assert.match(source, /maxLength=\{100\}/);
  assert.match(source, /changeFilter\("search", event\.target\.value\)/);
  assert.match(source, /Xóa tìm kiếm/);
  assert.match(source, /Từ khóa/);
  assert.match(source, /Không tìm thấy người lao động phù hợp với từ khóa/);
  assert.match(source, /workerQueryGeneration\.current === workerPageGeneration/);
  assert.doesNotMatch(source, /không áp dụng từ khóa tìm kiếm/i);
});

test("R1.2-HF: Dự án and Người tuyển filters are searchable comboboxes over stable ids", () => {
  assert.match(source, /from "@\/components\/ui\/catalog-filter-combobox"/);
  assert.match(catalogFilterCombobox, /function CatalogFilterCombobox\(/);
  // Reuses the existing pure helpers; no new search library.
  assert.match(catalogFilterCombobox, /filterCatalogSearchOptions\(/);
  assert.match(catalogFilterCombobox, /moveTypeaheadIndex\(/);
  assert.match(catalogFilterCombobox, /typeaheadKeyAction\(/);
  assert.match(catalogFilterCombobox, /from "@\/lib\/direct-entry\/catalog-search"/);
  assert.match(catalogFilterCombobox, /from "@\/lib\/direct-entry\/typeahead"/);
  // Proper combobox/listbox ARIA plus an explicit no-results state.
  assert.match(catalogFilterCombobox, /role="combobox"/);
  assert.match(catalogFilterCombobox, /aria-autocomplete="list"/);
  assert.match(catalogFilterCombobox, /role="listbox"/);
  assert.match(catalogFilterCombobox, /role="option"/);
  assert.match(catalogFilterCombobox, /aria-activedescendant=/);
  assert.match(catalogFilterCombobox, /aria-expanded=\{open\}/);
  assert.match(catalogFilterCombobox, /Không có kết quả phù hợp/);
  // "Tất cả" clears the filter and the committed value is always a stable catalog id.
  assert.match(source, /allLabel="Tất cả dự án"/);
  assert.match(source, /allLabel="Tất cả người tuyển"/);
  assert.match(source, /onChange=\{\(nextValue\) => changeFilter\("projectId", nextValue\)\}/);
  assert.match(source, /onChange=\{\(nextValue\) => changeFilter\("recruiterId", nextValue\)\}/);
  // The typed text is a local query only; it never becomes a filter id.
  assert.doesNotMatch(source, /changeFilter\("projectId", (query|event\.target\.value)\)/);
  assert.doesNotMatch(source, /changeFilter\("recruiterId", (query|event\.target\.value)\)/);
  // Recruiter matching also covers the personnel/login code.
  assert.ok(source.includes("personnel_code"), "recruiter search includes the personnel code");
  // The old free-text-project selects are gone.
  assert.doesNotMatch(source, /<select id=\{projectFilterId\}/);
  assert.doesNotMatch(source, /<select id=\{recruiterFilterId\}/);
});

test("W06-R3 / T1A: 403 phai hien la bi tu choi (khong bien thanh 0); 200 rong moi la 0 NLĐ", () => {
  // Khong con nhanh return <AccessDenied /> trong component (chi con o page boundary).
  assert.equal(/return <AccessDenied \/>/.test(source), false);
  assert.equal(/return <TemporaryUnavailable \/>/.test(source), false);
  assert.doesNotMatch(source, /relationDenialIsEmpty\(scope, response\.status\)/);
  assert.match(source, /if \(response\.status !== 200\) \{\s*return httpFailure\(response\.status\);\s*\}/);
  assert.match(source, /0 người lao động trong quan hệ này\./);
  assert.match(source, /text-red-700/);
  // P2.5-HF-R3: trang thai "khong co du lieu" la THONG TIN (mau rieng), khong dung xanh la
  // (de khong bi doc thanh "thanh cong") va khong dung do (danh rieng cho loi).
  assert.match(source, /const infoClass =/);
  assert.match(source, /text-sky-800/);
  assert.match(source, /<p role="status" className=\{infoClass\}>/);
  assert.equal(/border-emerald-500\/30 bg-emerald-500\/10/.test(source), false,
    "empty state khong con dung nen xanh la");
  // Moi tab giu page state rieng.
  assert.match(source, /workerPages\[scope as WorkerScopeTab\]/);
  assert.match(source, /submissionPage\.state/);
});

test("R1.2-A: worker management removes the request panel and keeps Direct Entry workflow", () => {
  for (const requestOnly of [
    "DirectEntryChangeRequestList", "DirectEntryChangeRequestReviewer", "requestPage",
    "reloadRequestPage", "requestsQuery", "WORKER_REQUEST_PAGE_SIZE",
  ]) assert.doesNotMatch(source, new RegExp(requestOnly), requestOnly);
  assert.doesNotMatch(directEntry, /<DirectEntryChangeRequestList/);
  assert.doesNotMatch(directEntry, /<DirectEntryChangeRequestReviewer/);
  assert.match(changeRequestsWorkspace, /<DirectEntryChangeRequestList/);
  assert.match(changeRequestsWorkspace, /<DirectEntryChangeRequestReviewer/);
  assert.match(source, /buildChangeRequestItem/,
    "the existing proposal action remains available where direct edit is not authorized");
});

test("P2.5-HF-R3: khong con cau hua ve quyen pham vi toan bo", () => {
  const model = readFileSync(
    new URL("../../lib/direct-entry/worker-operations-model.ts", import.meta.url), "utf8");
  assert.equal(model.includes("chỉ admin và BoD/Kế toán có quyền phạm vi toàn bộ"), false);
  assert.equal(/có quyền phạm vi toàn bộ/.test(model), false);
  assert.match(model, /all: "Toàn bộ người lao động đã gửi\."/);
});

test("W06-R2: initial tab tu actor projection server-side", () => {
  assert.match(source, /initialWorkerTab\(actor, canSeeAllWorkers, canSeeTeamWorkers/);
  assert.match(source, /actor\?: WorkerOperationsActor \| null/);
  assert.equal(/app_user_id|auth_subject/.test(source.split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n")), false,
  "khong nhan auth_subject/app_user_id tu client");
});

test("W06: pending/last decision + conflict/reload tu server version", () => {
  assert.match(workerDetailDialog, /pendingRequestLabel\(row\)/);
  assert.match(workerDetailDialog, /lastDecisionLabel\(row\)/);
  assert.match(source, /setConflict\(WORKER_CONFLICT_MESSAGE\)/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /Tải lại dữ liệu/);
});

test("HF WorkerTable: replaces Yêu cầu column with Loại hình displaying labor_type_display", () => {
  const tableStart = source.indexOf("function WorkerTable(");
  const tableEnd = source.indexOf("const DIRECT_EDIT_FILE_KINDS", tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const tableSource = source.slice(tableStart, tableEnd);

  assert.match(tableSource, /<th scope="col" className=\{DATA_TABLE_TH_CLASS\}>Loại hình<\/th>/);
  assert.match(
    tableSource,
    /<td className=\{DATA_TABLE_TD_CLASS\} data-label="Loại hình">\s*\{row\.labor_type_display\}\s*<\/td>/,
  );
  assert.doesNotMatch(tableSource, />Yêu cầu<\/th>|data-label="Yêu cầu"/);
  assert.doesNotMatch(tableSource, /pendingRequestLabel|lastDecisionLabel/);
});

test("W06: khong hien UUID tho trong UI", () => {
  // entry_id chi duoc dung lam React key, khong bao gio render thanh noi dung.
  assert.equal(/>\{row\.entry_id\}</.test(source), false, "khong render entry_id");
  assert.equal(/>\{row\.recruiter_id\}</.test(source), false, "khong render recruiter_id");
  // UUID chi xuat hien trong key={...} (khong phai text) hoac duong dan API.
  const rendered = source.match(/>\{[^}]*\.(entry_id|recruiter_id|request_id|submission_id)[^}]*\}</g) ?? [];
  assert.deepEqual(rendered, [], "khong render UUID tho");
  assert.match(source, /row\.recruiter_display/);
  assert.match(source, /row\.display_name/);
});

test("W06: copy nghiep vu dung 'Thong tin tai khoan ngan hang'", () => {
  assert.match(source, /BANK_ACCOUNT_SECTION_LABEL/);
  assert.equal(/Thông tin thanh toán/.test(source), false, "khong goi la thanh toan");
  assert.equal(/chi tiền|giao dịch/i.test(source), false);
});

test("W06: a11y - filter co label, dialog focus/escape khong mutation", () => {
  assert.match(source, /<label htmlFor=\{filterId\}/);
  assert.match(source, /<Dialog\.Root/);
  assert.match(source, /<Dialog\.Title/);
  assert.match(source, /<Dialog\.Description/);
  assert.match(source, /onSubmit=\{/);
  assert.match(source, /required aria-required="true"/);
  assert.match(source, /if \(!open && !busy\) onOpenChange\(false\)/);
});

test("W06 hotfix: modal opaque, correctly layered, scroll body only, theme tokens are real", () => {
  assert.match(source, /Dialog\.Overlay className="fixed inset-0 z-40 (?:bg-black\/50|bg-\[var\(--backdrop\)\][^"]*)"/);
  assert.match(source, /z-50 flex max-h-\[calc\(100dvh-2rem\)\]/);
  assert.match(source, /overflow-hidden rounded-2xl border border-border bg-surface/);
  assert.match(source, /min-h-0 flex-1 space-y-4 overflow-y-auto/);
  assert.match(source, /<footer className="flex shrink-0/);
  for (const invalidToken of [
    "bg-card", "border-input", "text-primary-foreground", "text-muted-foreground",
    "text-destructive", "bg-destructive",
  ]) {
    assert.equal(source.includes(invalidToken), false, "unsupported theme token: " + invalidToken);
  }
});

test("W06 hotfix: status choices use loaded baseline and a bounded native date input", () => {
  assert.match(source, /allowedWorkStatusTargets\(baseline\?\.status \?\? null\)/);
  assert.match(source, /projectWorkerDetailsForProposal\(row\.worker_details\)/);
  assert.match(source, /expectedVersion: baseline\.version/);
  assert.match(source, /id="worker-effective-date" type="date"/);
  assert.match(source, /min=\{baseline\?\.effectiveDate/);
  assert.match(source, /max=\{today\}/);
  assert.match(source, /setEffectiveDate\(hcmTodayDate\(\)\)/);
});

test("W06: mobile - bang cuon ngang, min-width, khong hover-only action", () => {
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /min-w-\[/);
  assert.equal(/group-hover:|hover:opacity|opacity-0/.test(source), false);
});

test("W06: page boundary cung flag + actor resolver nhu /direct-entry", () => {
  assert.match(page, /isDirectEntryUiEnabled\(process\.env\.DIRECT_ENTRY_UI_ENABLED\)/);
  assert.match(page, /decideWorkerOperationsPageAccess/);
  assert.match(page, /workerOperationsAllScopePredicate/);
  assert.match(page, /workerOperationsTeamScopePredicate/);
  assert.match(page, /canSeeAllWorkers=\{canSeeAllWorkers\}/);
  assert.match(page, /canSeeTeamWorkers=\{canSeeTeamWorkers\}/);
  assert.doesNotMatch(page, /workerOperationsReviewPredicate|canReview/);
  assert.match(page, /case "NOT_FOUND":[\s\S]{0,40}notFound\(\)/);
  assert.match(page, /redirect\("\/login\?next=\/direct-entry\/workers"\)/);
  assert.match(page, /case "ALLOW":[\s\S]{0,1200}<WorkerOperations/);
});

test("W06: nav entry 'worker-operations' duoc dang ky trong registry hien co", () => {
  assert.match(registry, /id: "worker-operations"/);
  assert.match(registry, /path: "\/direct-entry\/workers"/);
  assert.match(registry, /label: "Người lao động"/);
});

test("W06-R1: Worker Operations stays a directory and does not embed the Direct Entry editor", () => {
  assert.doesNotMatch(source, /DirectEntryChangeRequestList|DirectEntryChangeRequestReviewer/);
  assert.doesNotMatch(source, /canViewRequests|requestPage|reloadRequestPage/);
  assert.equal(/DirectEntryLive|DirectEntryShell|DirectEntrySpreadsheetGrid/.test(source), false);
});

test("W06-R2: Direct Entry approve/reject refreshes authoritative workflow state", () => {
  assert.match(changeRequestsWorkspace, /const reloadAfterChangeRequestMutation = useCallback\(async \(/);
  assert.match(changeRequestsWorkspace, /onDecided=\{\(message\) => \{[\s\S]{0,80}reloadAfterChangeRequestMutation\(message/);
  assert.doesNotMatch(
    changeRequestsWorkspace,
    /onDecided=\{[\s\S]*?items:\s*requestPage\.items[\s\S]*?\}\}/,
    "decision callback must not re-apply the stale pre-decision page",
  );
});

test("W06-R2: selecting the active tab does not reset it without triggering a fetch", () => {
  assert.match(source, /function selectTab\([\s\S]*?if \(next === tab\) \{[\s\S]*?return;[\s\S]*?\}/);
});

test("W06-R1: proposal drawer reuses ENTRY_FIELD, PAYMENT and WORK_STATUS builders", () => {
  assert.match(source, /buildEntryFieldProposal/);
  assert.match(source, /buildPaymentProposal/);
  assert.match(source, /buildWorkStatusProposal/);
  assert.match(source, /buildChangeRequestItem/);
  assert.match(source, /WORKER_PROPOSE_TARGETS\.map/);
  // Khong tu viet lai validation song song.
  assert.equal(/validateWorkerDetails\(/.test(source), false, "dung builder, khong lap validator");
  assert.match(source, /workerEntryFormFromBaseline/);
  assert.match(source, /worker-employee-code/);
  assert.match(source, /worker-project/);
  assert.match(source, /worker-first-work-date/);
  assert.match(source, /worker-recruiter/);
  assert.match(source, /worker-labor-type/);
  // Chi kiem tra proposal drawer; export dialog ben duoi duoc phep noi ro cot CCCD.
  const proposalStart = source.indexOf("function ProposeDrawer(");
  const proposalEnd = source.indexOf("/** Tai Blob", proposalStart);
  assert.ok(proposalStart >= 0 && proposalEnd > proposalStart);
  assert.equal(/DOCUMENT|CCCD/.test(source.slice(proposalStart, proposalEnd)), false);
});

test("HF-R4: proposal preloads and exposes each ENTRY_FIELD value", () => {
  assert.match(source, /Dữ liệu hiện tại được nạp sẵn/);
  assert.match(source, /Hồ sơ hiện tại/);
  assert.match(source, /WORKER_FORM_FIELDS\.map/);
  assert.match(source, /field === "gender"/);
  for (const label of [
    "Mã người lao động", "Dự án", "Ngày bắt đầu làm việc", "Người tuyển / Vendor",
    "Loại hình lao động", "Trạng thái làm việc",
  ]) {
    assert.ok(source.includes(label), "missing current-profile label: " + label);
  }
  assert.match(source, /id="worker-display-name"[\s\S]{0,180}value=\{entryForm\.workerDetails\.display_name\}/);
  assert.match(source, /<select id="bank-id"/);
  assert.match(source, /catalog\?\.banks/);
  assert.match(source, /useState<WorkerProposeTarget>\("WORKER"\)/);
});

test("R1.2-C: direct correction and proposal CTAs follow the server-projected row action", () => {
  assert.match(source, /const canDirectEdit = row\.allowed_actions\.direct_edit/);
  assert.match(source, /!canDirectEdit && cta\.show \?/);
  assert.match(source, /canDirectEdit \? \(/);
  assert.doesNotMatch(source, /canPrivilegedEditWorkers|canPrivilegedEdit=|canDirectlyCorrectWorkers/);
  assert.match(source, /\/privileged-edit/);
  assert.match(source, /mode === "correction" \|\| target === "WORK_STATUS"/);
  assert.match(source, /patch\.employment_status = status\.proposal/);
  assert.match(source, /Giữ nguyên trạng thái/);
});

test("quick offboarding reuses direct-edit authorization, OCC, and status proposal validation", () => {
  assert.match(source, /Cho nghỉ nhanh/);
  assert.match(source, /selectedQuickOffboardingIds/);
  assert.match(source, /canSelectQuickOffboardingWorker\(row\)/);
  assert.match(source, /buildWorkStatusProposal\([\s\S]*?status: "OFF"/);
  assert.match(source, /expected_entry_version: row\.entry_version/);
  assert.match(source, /patch: \{ employment_status: status\.proposal \}/);
  assert.match(source, /privileged-edit/);
  assert.match(source, /Lý do nghỉ/);
  assert.match(source, /Đã chọn \{quickOffboardingIds\.size\} NLĐ; lựa chọn được giữ khi tải thêm\./);
  const loadMoreStart = source.indexOf("async function loadMore<T>(");
  const selectTabStart = source.indexOf("function selectTab(", loadMoreStart);
  assert.ok(loadMoreStart >= 0 && selectTabStart > loadMoreStart);
  assert.doesNotMatch(source.slice(loadMoreStart, selectTabStart), /setQuickOffboardingIds/);
});

test("R1.1: B-owned action reasons are optional while OFF leave reason stays required", () => {
  assert.doesNotMatch(source, /<textarea id=\{reasonId\} required/);
  assert.doesNotMatch(source, /Lý do là bắt buộc\./);
  assert.match(source, /const actionReason = trimmed === "" \? null : trimmed/);
  assert.match(source, /reason: actionReason/);
  assert.match(source, /buildWorkerExportRequest\(\{[\s\S]{0,100}reason: reason\.trim\(\) === "" \? null : reason\.trim\(\)/);
  assert.match(source, /exportScopeForTab\(tab\)/);
  assert.doesNotMatch(source, /<textarea id=\{reasonId\} required aria-required="true"/);
  assert.match(source, /id="worker-leave-reason"[\s\S]{0,100}required aria-required="true"/);
});

test("W06: reviewer UI dung authority backend (can_decide), khong suy tu role client", () => {
  assert.match(reviewer, /can_decide/);
  for (const forbidden of ["role ===", "is_reviewer", "email"]) {
    assert.equal(reviewer.includes(forbidden), false, "reviewer khong duoc suy quyen tu " + forbidden);
  }
});

test("HF-R5A: loi tai them phai duoc bao cho nguoi dung, khong duoc im lang", () => {
  // Truoc R5A: httpFailure tra message null cho 5xx/network nen failLoad giu state "ready"
  // voi message null => khong co gi hien ra sau khi bam "Tai them".
  assert.equal(/state: "unavailable", message: null/.test(source), false);
  assert.equal(source.includes("message: null"), false, "khong con nhanh nao bo trong message");
  assert.match(source, /message: WORKER_LOAD_FAILED_MESSAGE/);
  assert.match(source, /activePage.state === "ready" && activePage.message !== null/);
  assert.doesNotMatch(source, /requestPage.state/);
  assert.match(source, /<span>{activePage.message}<\/span>/);
});

test("HF-R5A: catalog bi tu choi (403) la gioi han quyen, khong phai loi he thong", () => {
  assert.match(source, /const CATALOG_DENIED = "CATALOG_DENIED"/);
  assert.match(source, /const CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE"/);
  assert.match(source, /result.status === 403\) throw new Error\(CATALOG_DENIED\)/);
  assert.match(source, /filterCatalogState === "denied" \? \(/);
  assert.match(source, /filterCatalogState === "unavailable" \? \(/);
  // Denied dung mau thong tin (sky) + role=status; unavailable dung loi do (role=alert).
  assert.match(source, /role="status" className=\{infoClass\}>[\s\S]{0,220}không có quyền đọc danh mục/);
  assert.match(source, /role="alert" className=\{errorClass\}>[\s\S]{0,120}Không tải được danh mục/);
  // Drawer nhan cung mot su that: fail-closed tren gia tri hien tai, khong tu suy quyen.
  assert.match(source, /catalogDenied={filterCatalogState === "denied"}/);
  assert.match(source, /catalogDenied: boolean/);
  assert.match(source, /catalog === undefined && catalogDenied/);
  assert.match(source, /disabled=\{loading \|\| catalog === undefined\}/);
});

test("HF-R5A: dong drawer phai tra focus ve dung nut da mo", () => {
  // Radix Dialog chi tu tra focus khi co Dialog.Trigger; drawer nay mo bang state nen
  // phai tu ghi nho nut mo (cung cach reviewer dang dung).
  assert.match(source, /const drawerOpenerRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(source, /onClick=\{\(event\) => onPropose\(row, event\.currentTarget\)\}/);
  assert.match(source, /onClick=\{\(event\) => onCorrect\(row, event\.currentTarget\)\}/);
  assert.match(source, /openerRef: \{ current: HTMLElement \| null \}/);
  assert.match(source, /onCloseAutoFocus=\{\(event\) => \{[\s\S]{0,220}opener\.isConnected[\s\S]{0,120}opener\.focus\(\)/);
  assert.match(source, /openerRef=\{drawerOpenerRef\}/);
});

test("HF-R5A-R1: submission network rejection uses the canonical message", () => {
  assert.equal(/failLoad\([^)]*\bnull\b/.test(source), false, "khong con failLoad voi message null");
  assert.equal(source.includes(String.fromCharCode(34) + "unavailable" + String.fromCharCode(34) + ", null"),
    false, "khong con nhanh nao bo trong message");
  // Initial submission rejection uses the shared canonical message.
  assert.equal((source.match(/failLoad\(page, "unavailable", WORKER_LOAD_FAILED_MESSAGE\)/g) ?? []).length, 1);
  assert.match(source, /setSubmissionPage\(\(page\) => failLoad\(page, "unavailable", WORKER_LOAD_FAILED_MESSAGE\)\)/);
  // Khong tao message/helper thu hai.
  assert.equal(/const [A-Z_]*LOAD_FAILED[A-Z_]* = "/.test(source), false);
  // Giu rows da tai + co retry trong danh sach va submission.
  assert.equal((source.match(/onClick=\{\(\) => void reload\(\)\}/g) ?? []).length >= 2, true);
  assert.equal((source.match(/Thử lại/g) ?? []).length >= 2, true);
});

test("HF Worker Profile: Xem chi tiết chỉ đọc; Sửa trực tiếp đủ cá nhân, công việc, ngân hàng, tài liệu và tách trạng thái lỗi", () => {
  const detailDialogCall = source.match(/<WorkerDetailDialog[\s\S]*?\n      \/>/)?.[0] ?? "";
  assert.ok(detailDialogCall.length > 0);
  assert.doesNotMatch(detailDialogCall, /canUploadDocuments/);

  // Sửa trực tiếp hiển thị phần ngân hàng, trạng thái làm việc và tài liệu hồ sơ
  assert.match(source, /mode === "correction" \|\| \(mode === "proposal" && target === "PAYMENT"\)/);
  assert.match(source, /patch\.payment = paymentBuilt\.proposal/);
  assert.match(source, /mode === "correction" \? \(\s*<DirectEditFilesSection/);
  assert.match(source, /data-testid="direct-edit-profile-status"/);
  assert.match(source, /data-testid="direct-edit-documents-section"/);
  assert.match(source, /data-testid=\{"direct-edit-doc-input-" \+ kind\}/);
  assert.match(source, /data-testid=\{"direct-edit-doc-status-" \+ kind\}/);
  assert.match(source, /data-testid=\{"direct-edit-doc-retry-" \+ kind\}/);
  assert.match(source, /Thử lại tệp này/);
  // Không log và không hiển thị tên file nhạy cảm
  assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(source, /\.name\b/);
});

test("HF Edit Values: Sửa trực tiếp bỏ các bộ chọn trạng thái dữ liệu, dùng ô nhập trực tiếp, type='date' và combobox ngân hàng VietQR", () => {
  // mode === "correction" renders direct value inputs without state dropdowns
  assert.match(source, /mode === "correction" \? \(\s*field === "gender"/);
  assert.match(source, /field === "date_of_birth" \|\| field === "national_id_issued_at"/);
  assert.match(source, /type="date"/);
  assert.match(source, /<DirectEditBankCombobox/);
  assert.match(source, /buildDirectEditEntryFieldProposal\(/);
  assert.match(source, /buildDirectEditPaymentPatch\(/);
  assert.match(source, /directEditWorkerFormFromBaseline\(entryBaseline\)/);
  assert.match(source, /mergeVietQrBankCatalog\(/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /Danh mục ngân hàng VietQR/);
  assert.match(source, /Chưa có trong danh mục — sẽ lưu tên ngân hàng dạng tham chiếu\./);
});

test("HF Catalog Effective Date: ProposeDrawer uses today's catalog (not first_work_date) and keeps current project/recruiter option separately when absent from active catalog", () => {
  const proposalStart = source.indexOf("function ProposeDrawer(");
  const proposalEnd = source.indexOf("/** Tai Blob", proposalStart);
  assert.ok(proposalStart >= 0 && proposalEnd > proposalStart);
  const drawerSource = source.slice(proposalStart, proposalEnd);

  // Uses today's catalog aligned with backend direct_entry_authorization_date()
  assert.match(drawerSource, /const today = hcmTodayDate\(\);/);
  assert.match(drawerSource, /const catalog = catalogFor\(today\);/);
  assert.doesNotMatch(drawerSource, /entryCatalog|entryCatalogDate/);
  assert.doesNotMatch(drawerSource, /catalogFor\([^)]*first_work_date/);

  const ensureCalls = [...drawerSource.matchAll(/ensureCatalog\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(ensureCalls, ["today"]);

  // Current project/recruiter options are built from baseline?.projectId / baseline?.recruiterId
  assert.match(drawerSource, /buildWorkerEditProjectOptions\(\{\s*catalogProjects: catalog\?\.projects,\s*currentProjectId: baseline\?\.projectId \?\? entryForm\.project_id,/);
  assert.match(drawerSource, /buildWorkerEditRecruiterOptions\(\{\s*catalogRecruiters: catalog\?\.recruiters,\s*currentRecruiterId: baseline\?\.recruiterId \?\? entryForm\.recruiter_id,/);
});

test("T1A: WorkerOperations renders 0-usable-tab state without probing RPCs and refreshes permissions via /api/direct-entry/session on 403", () => {
  assert.match(source, /data-testid="worker-no-usable-tabs"/);
  assert.match(source, /\{WORKER_NO_USABLE_TAB_MESSAGE\}/);
  assert.match(source, /if \(tab === null \|\| !tabs\.includes\(tab\)\) return;/);
  assert.match(source, /if \(tab === null \|\| tab === "uploader" \|\| !mayReadCatalog \|\| filterCatalog !== undefined\) return;/);
  assert.match(source, /fetch\(API \+ "\/session"/);
  assert.match(source, /parseSessionWorkerPermissionsResponse\(/);
  assert.match(source, /reconcileWorkerOperationsPermissions\(/);
  assert.match(source, /void syncSessionPermissions\(scope, outcome\.message\)/);
  assert.match(source, /void syncSessionPermissions\("uploader", outcome\.message\)/);
  assert.match(page, /canReadWorkerDirectoryCatalog\(projection\)/);
  assert.match(page, /canReadCatalog=\{canReadCatalog\}/);
});

test("T1A Hotfix Issue #2: WorkerTable RowActionCluster omits read-only explanation text while preserving server-gated action buttons", () => {
  const tableStart = source.indexOf("function WorkerTable(");
  const tableEnd = source.indexOf("const DIRECT_EDIT_FILE_KINDS", tableStart);
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  const tableSource = source.slice(tableStart, tableEnd);

  assert.match(tableSource, /Xem chi tiết/);
  assert.match(tableSource, /\{!canDirectEdit && cta\.show \? \(/);
  assert.match(tableSource, /Đề xuất thay đổi/);
  assert.match(tableSource, /\{canDirectEdit \? \(/);
  assert.match(tableSource, /Sửa (?:trực tiếp|thông tin)/);
  assert.doesNotMatch(
    tableSource,
    /cta\.message/,
    "RowActionCluster in WorkerTable must not render the read-only explanation text",
  );
});
