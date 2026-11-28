import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "../../lib/direct-entry/catalog-response.test.mjs";

import {
  SPREADSHEET_INITIAL_ROW_COUNT,
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_SPARE_ROW_COUNT,
  createSpreadsheetRowModel,
  ensureSpreadsheetRowCount,
  spreadsheetRowIsBlank,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const livePaste = readFileSync(
  new URL("../../lib/direct-entry/live-grid-paste.ts", import.meta.url),
  "utf8",
);

function slice(startMarker, endMarker) {
  const start = live.indexOf(startMarker);
  assert.ok(start > 0, "missing marker: " + startMarker);
  const end = live.indexOf(endMarker, start);
  assert.ok(end > start, "missing end marker for: " + startMarker);
  return live.slice(start, end);
}

const pasteHandler = slice("const onStagedPaste = useCallback", "const onStagedUndo = useCallback");
const deleteHandler = slice("const onPersistedDelete = useCallback", "const addFormRow = useCallback");
const saveHandler = slice("const onStagedSave = useCallback", "const updateDate = useCallback");
const updateRowHandler = slice("const updateRow = useCallback", "const fetchConflictCopy = useCallback");
const spreadsheetEditHandler = slice(
  "const onSpreadsheetCellsChange = useCallback",
  "const onStagedProviderTypeChange = useCallback",
);
const providerEditHandler = slice(
  "const onStagedProviderTypeChange = useCallback",
  "const onStagedPasteRejected = useCallback",
);
const mobileEditHandler = slice(
  "const onMobileStagedChange = useCallback",
  "const handleMobileStagedProjectChange = useCallback",
);
const reloadDraftHandler = slice("const reloadDrafts = useCallback", "const runTransition = useCallback");
const editDraftHandler = slice("const reloadSubmissionDraft = useCallback", "const saveRow = useCallback");

test("draft status action sends no synthetic reason and leaves business leave fields unchanged", () => {
  assert.match(live, /leave_date: null,\s*leave_reason_text: null,\s*reason: null,/);
  assert.doesNotMatch(live, /reason:\s*"Cập nhật trạng thái trong bản nháp"/);
});

test("live render spreadsheet grid va khoi tao 30 staged rows client-only", () => {
  assert.match(live, /<DirectEntrySpreadsheetGrid/);
  assert.match(live, /useState<SpreadsheetRowModel>\(\(\) => createSpreadsheetRowModel\(\)\)/);
  assert.match(live, /const \[inputMode, setInputMode\] = useState<"form" \| "grid">\("grid"\)/);
  assert.equal(SPREADSHEET_INITIAL_ROW_COUNT, 30);
  assert.equal(SPREADSHEET_SPARE_ROW_COUNT, 10);
  assert.equal(SPREADSHEET_MAX_DATA_ROWS, 100);
  // clientRowId khong bao gio duoc ghep voi entry_id.
  assert.equal(/clientRowId:\s*[a-zA-Z]*[Ee]ntryId/.test(live), false);
});

test("zero drafts van co 30 dong trong, va paste gan cuoi bang tu noi rong", () => {
  const model = createSpreadsheetRowModel();
  assert.equal(model.rows.length, 30);
  assert.equal(model.rows.every((row) => spreadsheetRowIsBlank(row)), true);
  const grown = ensureSpreadsheetRowCount(model, 32);
  assert.equal(grown.rows.length, 32);
  assert.equal(grown.nextClientRowSequence, 33);
  // Khong thu nho va khong doi id da cap.
  assert.equal(ensureSpreadsheetRowCount(grown, 10).rows.length, 32);
  assert.deepEqual(ensureSpreadsheetRowCount(model, 5).rows.map((r) => r.clientRowId),
    model.rows.map((r) => r.clientRowId));
});

test("paste cap nhat saved/staged atomic va khong goi mang", () => {
  assert.match(pasteHandler, /applyLiveGridPaste\(/);
  assert.match(pasteHandler, /setRows\(result\.liveRows\)/);
  assert.match(pasteHandler, /setStagedModel\(result\.stagedModel\)/);
  assert.equal(/\bfetch\s*\(/.test(pasteHandler), false, "paste khong fetch");
  assert.equal(/localStorage|sessionStorage|navigator\.clipboard/.test(pasteHandler), false);
  assert.match(pasteHandler, /setStagedNotice\(/);
  assert.match(pasteHandler, /Đã dán /);
});

test("undo dung snapshot W01 va khoi phuc dung truoc paste", () => {
  assert.match(livePaste, /captureClipboardUndoSnapshot\(/);
  assert.match(live, /undoLiveGridPaste\(/);
  assert.match(live, /const onStagedUndo = useCallback/);
  assert.match(live, /setStagedUndo\(null\)/);
  assert.match(live, /canUndo=\{stagedCanUndo\}/);
});

test("paste rồi sửa field khác hủy one-shot undo trước mutation để không mất edit mới", () => {
  assert.match(pasteHandler, /setStagedUndo\(result\.undo\);\s*\n\s*setStagedCanUndo\(true\)/);
  assert.match(live, /const invalidateStagedUndo = useCallback\(\(\) => \{\s*\n\s*setStagedUndo\(null\);\s*\n\s*setStagedCanUndo\(false\)/);
  assert.match(live, /const onStagedUndo = useCallback[\s\S]*if \(snapshot === null\) return;/);
  for (const [label, handler, mutation] of [
    ["persisted drawer", updateRowHandler, "setRows("],
    ["desktop grid", spreadsheetEditHandler, "setRows("],
    ["provider", providerEditHandler, "setRows("],
    ["mobile/form", mobileEditHandler, "setStagedModel("],
  ]) {
    const invalidate = handler.indexOf("invalidateStagedUndo()");
    const mutate = handler.indexOf(mutation);
    assert.ok(invalidate >= 0 && mutate > invalidate, label + " phải hủy undo trước mutation");
  }
});

test("validation chay tren staged rows va map issue ve dung o", () => {
  assert.match(live, /\(isFormModeValidation \? buildFormProfileValidation : buildSpreadsheetValidation\)\(\{/);
  assert.match(live, /rows: stagedModel\.rows,/);
  // P1.7-H07: UI su dung `stagedValidationForDisplay` (loai bo
  // PASTE_VALUE_REQUIRED khi user chua bam "Lưu cac dong hop le").
  assert.match(live, /validation=\{stagedValidationForDisplay\}/);
  // Blank rows khong vao save: chi rowOrder (non-empty) duoc dem.
  assert.match(live, /Lưu các dòng hợp lệ/);
  // P1.7-H07: nut Save luon click duoc (khong bi khoa theo canSave)
  // de kich hoat required validation va nguoi dung thay nguyen nhan.
  assert.match(live, /disabled=\{loadState !== "ready" \|\| stagedBusy \|\|\s*\(editingDraftSubmissionId === null && !hasActiveLaborTypes\)\}/);
  assert.match(live, /\{stagedBusy \? "Đang nhập…" : "Lưu các dòng hợp lệ"\}/);
  assert.match(live, /aria-busy=\{stagedBusy\}/);
});

test("save dung full-profile batch, mot request, co chan double submit", () => {
  assert.match(saveHandler, /buildServerGeneratedFullProfileRequestBody\(/);
  assert.match(saveHandler, /postFullProfileBatch\(\{/);
  assert.equal(/\/api\/direct-entry/.test(saveHandler), false, "khong tu goi URL moi");
  assert.match(saveHandler, /if \(stagedInFlight\.current\) return;/);
  assert.match(saveHandler, /resolveIntentKey\(/);
  assert.match(saveHandler, /clearIntentKey\(/);
});

test("409 khong auto-retry, network/5xx giu intent key", () => {
  // retry: giu nguyen key, KHONG clear intent, va khong bao "da luu"/"chua luu" khi chua ro.
  assert.match(saveHandler,
    /if \(result\.kind === "retry"\) \{\s*\n[\s\S]{0,500}?const documentPending = await reconcileStagedDocuments\(\);\s*\n\s*setStagedMessage\(documentPending \?\? fullProfileErrorMessage\(result\.code\)\);\s*\n\s*return;/);
  assert.equal(/setTimeout/.test(saveHandler), false, "khong auto-retry");
  const retryBranch = saveHandler.indexOf('if (result.kind === "retry")');
  const clearAfterRetry = saveHandler.indexOf('stagedIntent.current = clearIntentKey', retryBranch);
  assert.ok(retryBranch > 0 && clearAfterRetry > retryBranch,
    "sau nhanh retry moi clear key cho conflict/rejected");
});

test("success reload tu server va chi clear staged sau khi server xac nhan", () => {
  assert.match(saveHandler, /if \(result\.kind === "saved"\)/);
  assert.match(saveHandler, /await reloadDrafts\(\);/);
  const savedBranch = saveHandler.indexOf('if (result.kind === "saved")');
  const removeSavedRows = saveHandler.indexOf("deleteSpreadsheetRow(model, clientRowId)", savedBranch);
  assert.ok(removeSavedRows > savedBranch, "chi bo cac dong server da xac nhan trong nhanh saved");
  assert.match(saveHandler, /setStagedModel\(\(current\) => savedClientRowIds\.reduce\(/);
});

test("save draft batch updates dirty persisted rows and preserves mixed staged rows", () => {
  const draftSave = saveHandler.slice(
    saveHandler.indexOf("if (editingDraftSubmissionId !== null)"),
    saveHandler.indexOf("if (editingDraftSubmissionId === null && !hasActiveLaborTypes)"),
  );
  assert.match(draftSave, /row\.submissionId === editingDraftSubmissionId/);
  assert.match(draftSave, /row\.state === "dirty" \|\| row\.state === "error"/);
  assert.match(draftSave, /await saveRow\(row\.rowId\)/);
  assert.ok(draftSave.lastIndexOf("setEditingDraftSubmissionId(null)")
    > draftSave.indexOf("for (const row of changedRows)"));
  assert.match(draftSave, /const hasStagedRows = selectNonEmptySpreadsheetRows\(stagedModel\)/);
  assert.match(draftSave, /if \(!hasStagedRows\) setStagedModel\(createSpreadsheetRowModel\(\)\)/);
  assert.match(live, /rows\s*\.filter\(\(row\) => editingDraftSubmissionId !== null &&\s*row\.submissionId === editingDraftSubmissionId\)/);
  assert.match(live, /const staged: SpreadsheetGridRow\[\] = stagedModel\.rows\.map/);
});

test("persisted rows keep submission lock; only the active own DRAFT unlocks the full edit set", () => {
  assert.match(live, /const editable = row\.state !== "saving" && row\.state !== "conflict" &&/);
  assert.match(live, /isRowEditable\(row, submissions\)/);
  assert.match(live, /row\.submissionId === editingDraftSubmissionId/);
  assert.match(live, /editableFields: editable[\s\S]*draftEditActive \? DRAFT_EDITABLE_GRID_FIELDS/);
  assert.match(livePaste, /"account_number", "bank_name",\s*"account_holder_name", "general_note"/);
  assert.match(live, /method: "PATCH"/);
});

test("draft reload requires exact versioned projection and makes one batch call without detail N+1", () => {
  assert.match(live, /value\.projection_version !== DRAFT_LIST_PROJECTION_VERSION/);
  assert.match(live, /return projectOwnDrafts\(\{/);
  assert.equal((reloadDraftHandler.match(/\/api\/direct-entry\/drafts/g) ?? []).length, 1,
    "draft reload makes one batch request");
  assert.equal(/\/api\/direct-entry\/entries\//.test(reloadDraftHandler), false);
  assert.equal((editDraftHandler.match(/\/api\/direct-entry\/drafts/g) ?? []).length, 1);
  assert.match(editDraftHandler, /selectNonEmptySpreadsheetRows\(stagedModel\)/);
  assert.match(editDraftHandler, /setEditingDraftSubmissionId\(submission\.submission_id\)/);
  assert.match(editDraftHandler, /setStagedModel\(createSpreadsheetRowModel\(\)\)/);
});

test("provider selector is editable whenever a row's edit allowlist includes provider_type", () => {
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /editable: \(row: SpreadsheetGridRow\) => isEditable\(row, column\.key\)/);
  assert.match(livePaste, /"provider_type", \.\.\.SPREADSHEET_WRITABLE_FIELD_KEYS/);
  assert.match(livePaste, /"project_id", "first_work_date", "display_name", "provider_type", "recruiter_id"/);
  assert.match(livePaste, /draftPatch\.providerType = recruiter\.provider_type/);
});

test("masked display values are excluded from spreadsheet copy and write sources", () => {
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /const value = args\.row\.cells\[args\.column\.key\] \?\? ""/);
  assert.equal(/const value = args\.row\.displayValues/.test(grid), false);
  assert.match(live, /DRAFT_EDITABLE_GRID_FIELDS/);
  assert.doesNotMatch(live, /editableFields: editable\s*\n\s*\?\s*\["employee_code"/);
  assert.match(live, /CLIPBOARD_PROTECTED_CELL/);
});

test("spreadsheet is the only live desktop grid and profile hydration is passed to it", () => {
  assert.equal(/<DataGrid(?:<|\s)/.test(live), false);
  assert.equal((live.match(/<DirectEntrySpreadsheetGrid\b/g) ?? []).length, 1);
  assert.equal(live.includes('aria-label="Bảng bản nháp Direct Entry"'), false);
  assert.match(live, /projectDraftProfileGridCells\(row\.profile\)/);
  assert.match(live, /providerType: row\.providerType \?\? ""/);
  assert.match(live, /team_hint: row\.teamDisplayName/);
  // P1.7-H06: documentsRowId thay cho setCccdRowId; selection qua selectedClientRowId.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  assert.match(live, /selectedClientRowId=\{selectedClientRowId\}/);
  assert.match(live, /onSelectedClientRowChange=\{setSelectedClientRowId\}/);
  assert.ok(live.indexOf("<DirectEntrySubmissionList") < live.indexOf("<DirectEntrySpreadsheetGrid"));
  assert.ok(live.indexOf("<DirectEntrySubmissionList") < live.indexOf("<DirectEntrySpreadsheetGrid"));
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  assert.match(grid, /maxRows: liveDraftRows \+ 100/);
  // R1: grid chi nhan 18 default columns, khong them action rail keys.
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  // H06: grid forward selectedClientRowId vao DataGrid qua `selectedRows`.
  assert.match(grid, /selectedRows=\{selectedClientRowId === null \|\| selectedClientRowId === undefined/);
});

test("persisted actions reopen the existing drawer; mobile, CCCD/payment/document paths remain", () => {
  const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  // P1.7-H06: action rail (× va Hồ sơ) da duoc loai bo. DataGrid chi nhan 18 cot
  // va khong render action nut; selection qua selectedRows.
  assert.doesNotMatch(grid, /aria-label="Xóa dòng"/);
  assert.doesNotMatch(grid, /Quản lý CCCD/);
  // CCCD/employee_code khong con la data column.
  assert.equal(grid.includes("Tự sinh khi lưu"), false,
    "employee_code placeholder da chuyen ra ngoai grid");
  assert.equal(grid.includes("Nhân bản"), false);
  assert.equal(grid.includes("Làm trống"), false);
  // P1.7-H06: DataGrid chuyen sang prop selectedRows + onSelectedRowsChange.
  assert.match(grid, /selectedRows=\{selectedClientRowId === null \|\| selectedClientRowId === undefined/);
  assert.match(grid, /onSelectedRowsChange=\{/);
  // Live side: contextual action bar (ben ngoai grid) co nut Xóa dòng cho staged
  // row va Hồ sơ NLĐ cho persisted; KHONG con row-delete-* icon row.
  assert.doesNotMatch(live, /data-testid=\{`row-delete-\$\{row\.clientRowId\}`\}/);
  assert.match(live, /data-testid="contextual-action-bar"/);
  assert.match(live, /data-testid="contextual-documents"/);
  assert.match(live, /data-testid="contextual-delete"/);
  assert.match(live, /selectedRowLocked = selectedRow !== null && !isRowEditable\(selectedRow, submissions\)/);
  assert.match(live, /styles\.mobileSection/);
  assert.match(live, /<Dialog\.Root open=\{selectedRow !== null\}/);
  for (const marker of ["DirectEntryPaymentEditor",
    "DirectEntryDocumentEditor", "DirectEntrySubmittedDocumentManager",
    "DirectEntryWorkerDocuments", "onEntryVersionChange=", "setDocumentsRowId"]) {
    assert.ok(live.includes(marker), "missing " + marker);
  }
});

test("persisted DRAFT delete chỉ bỏ row sau server success; lỗi và final-row giữ nguyên row", () => {
  assert.match(deleteHandler, /submission\.entry_count <= 1/);
  assert.match(deleteHandler, /deleteDraftRow\(\{[\s\S]*expectedVersion: row\.entryVersion,[\s\S]*idempotencyKey: resolved\.key/);
  const deletedBranch = deleteHandler.indexOf('if (result.kind === "deleted")');
  const removeRow = deleteHandler.indexOf("current.filter((candidate) => candidate.rowId !== rowId)");
  const failureBranch = deleteHandler.indexOf('if (result.kind !== "retry")');
  assert.ok(deletedBranch > 0 && removeRow > deletedBranch && failureBranch > removeRow);
  assert.match(deleteHandler, /current\.map\(\(candidate\) => candidate\.rowId === rowId\s*\? \{ \.\.\.candidate, message \}/);
  assert.match(live, /selectedIsStaged[\s\S]*onStagedDelete\(selected\.clientRowId\)[\s\S]*onPersistedDelete\(selected\.clientRowId\)/);
  assert.match(live, /data-testid="drawer-delete-row"/);
});

test("hidden XLSX CTAs retain import/template handlers and mobile staged editor stays available", () => {
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.match(live, /createWorkerProfileTemplate\(\)/);
  assert.match(live, /onClick=\{\(\) => void downloadXlsxTemplate\(\)\} hidden/);
  assert.match(live, /onClick=\{\(\) => xlsxInputRef\.current\?\.click\(\)\} hidden/);
  // P1.7-H05: employeeCode do server tu sinh (migration #39), UI chi hien thi
  // khi row da persisted.
  assert.match(live, /employeeCodeMode: "server-generated"|Máy chủ sẽ cấp mã khi lưu/);
  assert.match(live, /className=\{styles\.mobileStagedList\}/);
  assert.match(live, /Máy chủ sẽ cấp mã khi lưu/);
  // P1.7-H06: quick editor co "Lưu trước để tải hồ sơ" hint.
  assert.match(live, /Lưu trước để tải hồ sơ/);
  // P1.7-H05 / Branch B CTV: Nguon tuyen gom 3 option (HRP, Vendor, CTV)
  assert.match(live, /<option value="hrp">HRP \(trực tiếp\)<\/option>/);
  assert.match(live, /<option value="vendor">Vendor<\/option>/);
  assert.match(live, /<option value="ctv">CTV<\/option>/);
  assert.equal(live.includes('<optgroup label="HRP">'), false,
    "khong dung optgroup; HRP/Vendor chi co 2 option don gian");
  // P1.7-H06: mobile staged card list khong con nut × theo row.
  assert.doesNotMatch(live, /actionRailDeleteButton/);
});

test("khong thao cac duong CCCD/payment/submission/change-request/mobile", () => {
  const changeRequestProposer = readFileSync(
    new URL("./direct-entry-change-request-proposer.tsx", import.meta.url), "utf8",
  );
  for (const marker of ["DirectEntryWorkerDocuments", "DirectEntryPaymentEditor",
    "DirectEntryDocumentEditor", "DirectEntrySubmissionList",
    "DirectEntrySubmittedDocumentManager",
    "styles.mobileSection"]) {
    assert.ok(live.includes(marker), "missing " + marker);
  }
  assert.equal(live.includes("DirectEntryChangeRequestProposer"), false);
  assert.match(changeRequestProposer, /export function DirectEntryChangeRequestProposer/);
  assert.equal(live.includes("DirectEntryChangeRequestList"), false);
  assert.equal(live.includes("DirectEntryChangeRequestReviewer"), false);
  assert.equal(live.includes("DirectEntryWorkerProfilePasteDialog"), false);
  assert.equal(live.includes("DirectEntryExcelPasteDialog"), false);
  // P1.7-H06: DirectEntryCccdManager chi con su dung gian tiep qua DirectEntryWorkerDocuments,
  // khong con render CCCD dialog tren rieng tren live.
  assert.doesNotMatch(live, /<DirectEntryCccdManager/);
});

test("khong co N+1 entry-detail fetch trong duong staged", () => {
  const stagedRegion = live.slice(live.indexOf("P1.7-W02 spreadsheet"), live.indexOf("const columns = useMemo"));
  assert.equal(/fetchEntryDetail|\/entries\/\${?[a-zA-Z]*\}?\/documents/.test(stagedRegion), false);
  assert.equal((stagedRegion.match(/\bfetch\s*\(/g) ?? []).length, 0,
    "duong staged khong tu goi fetch");
});

// ===== P3-W06A R2 — Side-effect registration into full `pnpm test` =====
// Direct Entry text-cell behavioral regression tests chạy targeted nhưng
// chưa được đăng ký vào `pnpm test` đầy đủ. Import side-effect một chiều
// từ `direct-entry-live-spreadsheet.test.mjs` để suite này chạy qua
// `test:p1.6-i04c3-r3a` (và do đó chạy qua `pnpm test`).
//
// Điều kiện an toàn (P3-W06A R2):
// - `direct-entry-text-cell-regression.test.mjs` KHÔNG import ngược
//   `direct-entry-live-spreadsheet.test.mjs` (một chiều).
// - Chỉ phụ thuộc `text-cell-state.ts` (production helper), không tạo
//   circular import.
// - Không thay đổi `package.json` / `pnpm-lock.yaml`.
import "./direct-entry-text-cell-regression.test.mjs";
