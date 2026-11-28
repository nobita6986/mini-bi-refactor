import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DIRECT_ENTRY_GRID_COLUMNS,
  directEntryGridColumnIndex,
} from "./direct-entry-grid-columns.ts";

const source = readFileSync(
  new URL("../../components/direct-entry/direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");

test("registry co dung 29 cot (27 contract + provider_type + collaborator_id UI) va thu tu vat ly on dinh", () => {
  // P1.7-H05 + CTV: 29 cot tong (27 contract/derived/action + provider_type + collaborator_id).
  // 19 cot mac dinh tren grid; registry day du de drawer/projection/validation
  // va mo rong sau nay.
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.length, 29);
  assert.equal(directEntryGridColumnIndex("project_id"), 1);
  assert.equal(directEntryGridColumnIndex("employee_code"), 3);
  assert.equal(directEntryGridColumnIndex("provider_type"), 14);
  assert.equal(directEntryGridColumnIndex("collaborator_id"), 16);
  assert.equal(directEntryGridColumnIndex("row_actions"), 28);
  assert.equal(directEntryGridColumnIndex("khong_ton_tai"), -1);
  // Moi cot deu co khoa duy nhat.
  assert.equal(new Set(DIRECT_ENTRY_GRID_COLUMNS.map((column) => column.key)).size, 29);
});

test("grid render cot tu registry, khong hard-code danh sach cot", () => {
  // P1.7-H05-R1: DataGrid chi nhan 18 default columns; status/action/document
  // khong con nam trong DataGrid.
  assert.match(source, /DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS/);
  assert.equal(source.includes('name: "Mã NLĐ"'), false, "khong duoc hard-code ten cot");
});

test("paste dung pure parser/mapper cua W01, khong tu tach TSV trong component", () => {
  assert.match(source, /parseClipboardTsv\(/);
  assert.match(source, /mapClipboardFromAnchor\(/);
  assert.match(source, /serializeClipboardTsv\(/);
  assert.equal(/\.split\("\\t"\)/.test(source), false, "khong tu split tab");
  assert.equal(/\.split\(\/\\r\?\\n\//.test(source), false, "khong tu split dong");
});

test("paste chi doi React state: khong fetch, khong localStorage, khong Clipboard permission API", () => {
  assert.equal(/\bfetch\s*\(/.test(source), false, "khong goi mang");
  assert.equal(/\blocalStorage\s*[.[]/.test(source), false, "khong dung localStorage");
  assert.equal(/\bsessionStorage\s*[.[]/.test(source), false, "khong dung sessionStorage");
  assert.equal(/\bnavigator\s*\.\s*clipboard/.test(source), false, "khong dung Clipboard API");
  assert.equal(/\breadText\s*\(/.test(source), false, "khong doc clipboard nen");
  // Chi doc clipboard tu su kien do nguoi dung tao.
  assert.match(source, /event\.clipboardData\.getData\("text\/plain"\)/);
});

test("paste overflow bi tu choi toan bo truoc khi ap dung", () => {
  assert.match(source, /if \(!parsed\.ok\) \{ onPasteRejected\("CLIPBOARD_ROW_OVERFLOW"\); return args\.row; \}/);
  assert.match(source, /if \(!mapping\.ok\) \{ onPasteRejected\(mapping\.code\); return args\.row; \}/);
  // onPasteApplied chi duoc goi sau khi mapping thanh cong.
  const appliedIndex = source.indexOf("onPasteApplied({ mapping");
  const mappingGuard = source.indexOf("if (!mapping.ok)");
  assert.ok(mappingGuard > 0 && appliedIndex > mappingGuard, "chi apply sau khi qua guard");
});

test("banner paste co so hang x cot va nut Hoan tac", () => {
  assert.match(source, /data-testid="spreadsheet-paste-notice"/);
  assert.match(source, /data-testid="spreadsheet-undo"/);
  assert.match(source, /Hoàn tác/);
  assert.match(source, /canUndo/);
});

test("nut luu co busy/disabled va khong tu bao da luu", () => {
  // P1.7-H05: nut save nam trong toolbar header (live), ngoai grid. Grid chi
  // hien thi save message/status (readonly).
  assert.match(source, /data-testid="spreadsheet-save-message"|saveMessage|saveBusy/);
  assert.equal(source.includes("Đã lưu"), false, "khong optimistic da luu trong component grid");
});

test("dong bi khoa khong editable va derived/action khong editable", () => {
  assert.match(source, /!row\.locked && row\.editableFields\.includes\(columnKey\)/);
  assert.match(source, /column\.editor !== "readonly" && column\.editor !== "action"/);
  assert.match(source, /column\.pasteMode === "write"/);
});

test("loi duoc danh dau tren dung o va co tong ket dong loi", () => {
  assert.match(source, /data-cell-state=\{issue \? issue\.severity : "ok"\}/);
  assert.match(source, /data-testid="spreadsheet-error-summary"/);
  assert.match(source, /title=\{issue \? issue\.message : undefined\}/);
});

test("editor select/catalog lay option tu vocabulary hien huu, khong dinh nghia nghiep vu moi", () => {
  // Dropdown vocabulary uses the current active catalog projection.
  assert.match(source, /DIRECT_ENTRY_GENDER_OPTIONS/);
  assert.match(source, /sortedActiveLaborTypes\(catalogs\?\.laborTypes\)/);
  assert.match(source, /option\.labor_type_key/);
  assert.doesNotMatch(source, /DIRECT_ENTRY_LABOR_TYPE_OPTIONS/);
  // provider_type options are defined as a local const to keep the registry
  // contract surface area separate.
  assert.match(source, /PROVIDER_OPTIONS/);
  // Status giữ canonical value, còn nhãn dùng helper tiếng Việt dùng chung.
  assert.equal(source.includes("Toàn thời gian"), false,
    "P1.7-H05: UI khong con hien thi 'Toan thoi gian'");
  assert.match(source, /columnKey === "initial_status"/);
  assert.match(source, /Đang làm việc \(mặc định\)/);
  assert.match(source, /workStatusUiLabel\(option\)/);
  assert.match(source, /workStatusUiLabel\(status\)/);
  assert.match(source, /\["ON", "OFF", "UNCONFIRMED", "PENDING"\]\.includes\(status\)/,
    "giá trị PENDING phải render bằng nhãn tiếng Việt, không lộ mã nội bộ trong ô");
  assert.doesNotMatch(source, /option === "ON" \? "Đang làm việc"/,
    "Đang làm việc không còn là lựa chọn riêng trong dropdown");
  assert.match(source, /status === "ON" \? "Đang làm việc"/);
  assert.match(source, /if \(columnKey === "initial_status"\) return \["", "PENDING"\]/,
    "dropdown chỉ cho chọn mặc định hoặc đang chờ việc; ON và OFF không phải lựa chọn riêng");
  // Option project/recruiter den tu catalog truyen vao, khong hard-code ID.
  assert.match(source, /catalogs\?\.projects \?\? \[\]/);
  assert.match(source, /catalogs\?\.recruiters \?\? \[\]/);
  assert.match(source, /recruitersForProvider\(/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(source), false,
    "khong hard-code UUID catalog");
});

test("thao tac dong: chi Xoa cho staged row o RAIL NGOAI grid, khong goi tu DataGrid", () => {
  // P1.7-H05-R1: nut Xoa cua staged row da chuyen ra ngoai DataGrid vao rail
  // ngoai cung cap. Trong DataGrid khong con goi truc tiep onDeleteRow.
  assert.equal(source.includes("onDeleteRow(row.clientRowId)"), false,
    "DataGrid khong con goi onDeleteRow truc tiep o H05-R1");
  assert.match(source, /onDeleteRow/);
  // Khong con Clear/Duplicate/Nhan ban trong grid.
  assert.equal(source.includes("onClearRow"), false,
    "khong con Clear row trong grid H05");
  assert.equal(source.includes("onDuplicateRow"), false,
    "khong con Duplicate row trong grid H05");
  assert.equal(source.includes("Nhân bản"), false,
    "khong con nut Nhan ban trong grid H05");
  assert.equal(source.includes("Làm trống"), false,
    "khong con nut Lam trong trong grid H05");
  assert.equal(/method:\s*"DELETE"/.test(source), false);
});
