import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS,
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GENDER_OPTIONS,
  recruitersForProvider,
} from "../../lib/direct-entry/direct-entry-grid-columns.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const live = readFileSync(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const grid = readFileSync(new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
const changeRequestsWorkspace = readFileSync(new URL("./change-requests-workspace.tsx", import.meta.url), "utf8");

test("header keeps quick-add; Excel CTAs are hidden while import/template handlers remain", () => {
  const headerStart = live.indexOf("<header className={styles.header}>");
  const headerEnd = live.indexOf("</header>", headerStart);
  const header = live.slice(headerStart, headerEnd);
  assert.ok(headerStart > 0 && headerEnd > headerStart);
  assert.equal((header.match(/<button\b/g) ?? []).length, 3);
  assert.match(header, /Tải file Excel mẫu[\s\S]*?<\/button>/);
  assert.match(header, /Nhập file Excel[\s\S]*?<\/button>/);
  assert.equal((header.match(/\shidden>/g) ?? []).length, 2);
  assert.match(header, /data-testid="quick-add-row"/);
  assert.match(live, /const downloadXlsxTemplate = useCallback/);
  assert.match(live, /const onXlsxFile = useCallback/);
  assert.match(live, /workerProfileXlsxToTsv\(file\)/);
  assert.match(live, /createWorkerProfileTemplate\(\)/);
  for (const hidden of [
    "P1.6 · Direct Entry · S03CD",
    "Dán từ Excel",
    "Dán hồ sơ từ Excel",
    "Ctrl+V",
    "dán một vùng từ Excel",
  ]) assert.equal(live.includes(hidden), false, hidden);
  assert.equal(live.includes("DirectEntryExcelPasteDialog"), false);
  assert.equal(live.includes("DirectEntryWorkerProfilePasteDialog"), false);
});

test("compact submission panel renders immediately before the grid while change-request list lives in its own module", () => {
  const submissionList = live.indexOf("<DirectEntrySubmissionList");
  const gridSection = live.indexOf("<section className={styles.gridSection", submissionList);
  const gridComponent = live.indexOf("<DirectEntrySpreadsheetGrid", gridSection);
  assert.ok(submissionList > 0 && gridSection > submissionList && gridComponent > gridSection);
  assert.equal(live.includes("<DirectEntryChangeRequestList"), false);
  assert.match(changeRequestsWorkspace, /<DirectEntryChangeRequestList/);
  assert.match(live.slice(submissionList, live.indexOf("/>", submissionList)), /\bcompact\b/);
  assert.doesNotMatch(live, /<details className=\{styles\.secondaryPanel\}/);
});

test("only the approved 19 data columns render; action rail is outside that set", () => {
  // Canonical order theo DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS: provider/recruiter/collaborator/labor
  // nam ngay sau Du an, va national_id_issued_place da bi loai khoi UI/grid (DB tu ghi
  // "Bộ Công An" cho ho so moi).
  assert.deepEqual(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS, [
    "row_index", "project_id", "provider_type", "recruiter_id", "collaborator_id", "labor_type",
    "first_work_date", "initial_status", "display_name", "phone", "national_id", "gender", "date_of_birth",
    "national_id_issued_at", "address", "account_number", "bank_name",
    "account_holder_name", "general_note",
  ]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.length, 19);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.includes("national_id_issued_place"), false,
    "national_id_issued_place khong con la cot UI");
  // R1: DataGrid chi nhan 18 default columns. ACTION_RAIL chi con la tap
  // metadata ngoai DataGrid (cho action rail ben ngoai).
  assert.deepEqual(DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS, ["save_status", "row_actions"]);
  assert.equal(DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.some((key) =>
    DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS.includes(key)), false);
  assert.match(grid, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  assert.doesNotMatch(grid, /return DIRECT_ENTRY_GRID_COLUMNS\.map\(build\)/);
  assert.deepEqual(DIRECT_ENTRY_GENDER_OPTIONS, ["Nam", "Nữ"]);
  assert.match(grid, /columnKey === "gender"\) return \["", \.\.\.DIRECT_ENTRY_GENDER_OPTIONS\]/);
  assert.doesNotMatch(grid, /STATUS_OPTIONS/);
  // CCCD column key da duoc loai khoi action rail va khong con xuat hien trong grid.
  assert.equal(grid.includes('key: "cccd_documents"'), false,
    "cccd_documents khong con la cot trong grid");
});

test("provider filtering, recruiter reset, and CCCD/action rail outside grid are wired", () => {
  const recruiters = [
    { id: "hrp-id", label: "HRP person", provider_type: "hrp" },
    { id: "vendor-id", label: "Vendor person", provider_type: "vendor" },
  ];
  assert.deepEqual(recruitersForProvider(recruiters, ""), []);
  assert.deepEqual(recruitersForProvider(recruiters, "hrp"), [recruiters[0]]);
  assert.deepEqual(recruitersForProvider(recruiters, "vendor"), [recruiters[1]]);

  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, rowId, "hrp");
  model = updateSpreadsheetRowCells(model, rowId, { recruiter_id: "hrp-id" });
  model = updateSpreadsheetRowProviderType(model, rowId, "vendor");
  assert.equal(model.rows[0].providerType, "vendor");
  assert.equal(model.rows[0].cells.recruiter_id, "");
  assert.equal(Object.hasOwn(model.rows[0].cells, "provider_type"), false);
  // P1.7-H05: recruiter field bi disable khi provider_type chua duoc chon.
  assert.match(grid, /disabled=\{props\.row\.providerType === ""\}/);
  assert.match(grid, /value=\{option\.id\}/);
  // P1.7-H05: employee_code khong hien thi tren grid (server tu sinh theo migration #39).
  assert.equal(grid.includes('employee_code'), false,
    "employee_code khong con xuat hien tren grid");
  assert.equal(grid.includes("Tự sinh khi lưu"), false,
    "employee_code placeholder khong con tren grid");
});

test("contextual action bar thay the rail; chi hai nut (Hồ sơ NLĐ + Xóa dòng)", () => {
  // P1.7-H06: action rail bi loai bo; contextual action bar (desktop) nam
  // phia tren DataGrid voi hinh thu mot theo clientRowId.
  // DataGrid chi nhan 18 cot default; khong con cot 'save_status', 'row_actions'
  // hay cccd_documents. Khong con cot frozen hay callback onManageDocuments trong grid.
  assert.equal(grid.includes("frozen"), false,
    "khong con cot frozen trong grid H05");
  assert.equal(grid.includes("Quản lý CCCD"), false,
    "Quan ly CCCD phai dat ngoai grid");
  assert.equal(grid.includes("Lưu dòng trước"), false);
  assert.equal(/onManageDocuments=\{[^}]*\(clientRowId\)/.test(live), false,
    "onManageDocuments da chuyen khoi grid");
  assert.equal(grid.includes("aria-label=\"Xóa dòng\""), false,
    "nut × cua staged row khong con trong DataGrid");
  assert.equal(grid.includes("data-testid=\"row-delete-"), false,
    "row-delete da chuyen dc contextual bar (live)");
  // P1.7-H06: live su dung setDocumentsRowId thay cho setCccdRowId cu.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  // Contextual action bar co hai nut, kiem tra theo data-testid.
  assert.match(live, /data-testid="contextual-action-bar"/);
  assert.match(live, /data-testid="contextual-documents"/);
  assert.match(live, /data-testid="contextual-delete"/);
  assert.match(live, /Hồ sơ NLĐ/);
  assert.match(live, /Xóa dòng/);
  // Khong con data-rail-state="persisted|staged" hay aria-label cu.
  assert.doesNotMatch(live, /data-rail-state="persisted"/);
  assert.doesNotMatch(live, /data-rail-state="staged"/);
  assert.doesNotMatch(live, /data-row-index=\{row\.clientRowId\}/);
  assert.doesNotMatch(live, /<table\b[\s\S]{0,200}actionRail/);
  assert.doesNotMatch(grid, /Nhân bản|Làm trống/);
  assert.match(live, /persisted: row\.entryId !== null/);
  assert.match(live, /onDeleteRow=\{onStagedDelete\}/);
  // DirectEntrySpreadsheetGrid nhan selectedClientRowId + onSelectedClientRowChange.
  assert.match(grid, /selectedClientRowId\?: string \| null/);
  assert.match(grid, /onSelectedClientRowChange\(clientRowId: string \| null\)/);
  assert.match(grid, /selectedRows=\{selectedClientRowId === null \|\| selectedClientRowId === undefined/);
  assert.match(grid, /onSelectedRowsChange=\{/);
  // Live side forwarding props:
  assert.match(live, /selectedClientRowId=\{selectedClientRowId\}/);
  assert.match(live, /onSelectedClientRowChange=\{setSelectedClientRowId\}/);
});
