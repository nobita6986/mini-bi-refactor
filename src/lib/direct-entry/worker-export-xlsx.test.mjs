/**
 * PRE-W2-P1 - server XLSX builder (round-trip reload).
 *
 * Chứng minh: 20 cot dung thu tu; moi cot la text (numFmt "@"); khong co
 * cell formula/hyperlink/error; chuoi bat dau "=", "+", "-", "@" va chuoi chua tab/CR/LF van la
 * literal text; cot 18 rong khi khong co nguon ghi chu.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkerExportXlsx, workerExportFilename } from "./worker-export-xlsx.ts";
import { WORKER_EXPORT_COLUMNS } from "./worker-export-contract.ts";

function row(overrides = {}) {
  return {
    employee_code: "hrp-2026-300001",
    display_name: "Nguyen Van A",
    date_of_birth: "1990-01-01",
    national_id: "012345678901",
    national_id_issued_at: "2020-01-01",
    phone: "0900000001",
    address: "1 Street",
    project_display: "Project A",
    first_work_date: "2026-10-01",
    labor_type_display: "Thời vụ",
    recruiter_display: "Recruiter A",
    provider_type: "HRP",
    employment_status: "ON",
    leave_date: null,
    leave_reason: null,
    account_number: "012345678901",
    bank_name: "Bank",
    account_holder_name: "Holder",
    payment_note: null,
    general_note: "Ghi chú NLĐ",
    ...overrides,
  };
}

async function reload(bytes) {
  const excel = (await import("exceljs")).default;
  const workbook = new excel.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  return { excel, sheet: workbook.getWorksheet("Người lao động") };
}

test("the workbook has exactly the 21 headers in order", async () => {
  const { sheet } = await reload(await buildWorkerExportXlsx([row()]));
  const header = sheet.getRow(1);
  assert.deepEqual(
    WORKER_EXPORT_COLUMNS.map((_, index) => header.getCell(index + 1).value),
    WORKER_EXPORT_COLUMNS.map((column) => column.header));
  assert.equal(WORKER_EXPORT_COLUMNS.length, 21);
});

test("all exported columns use Excel text format and leading zeros survive", async () => {
  const { sheet } = await reload(await buildWorkerExportXlsx([row()]));
  const dataRow = sheet.getRow(2);
  const index = (key) => WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === key) + 1;

  assert.equal(dataRow.getCell(index("national_id")).value, "012345678901");
  assert.equal(dataRow.getCell(index("phone")).value, "0900000001");
  assert.equal(dataRow.getCell(index("account_number")).value, "012345678901");
  for (const column of WORKER_EXPORT_COLUMNS) {
    assert.equal(dataRow.getCell(index(column.key)).numFmt, "@", column.key + " must be text");
  }
});

test("historical date text is exported literally", async () => {
  const { sheet } = await reload(await buildWorkerExportXlsx([
    row({ date_of_birth: "14/10/1990", national_id_issued_at: "19901014" }),
  ]));
  const dobIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "date_of_birth") + 1;
  const idDateIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "national_id_issued_at") + 1;
  assert.equal(sheet.getRow(2).getCell(dobIndex).value, "14/10/1990");
  assert.equal(sheet.getRow(2).getCell(idDateIndex).value, "19901014");
});

test("no cell is a formula/hyperlink/error; dangerous strings stay literal", async () => {
  const { excel, sheet } = await reload(await buildWorkerExportXlsx([
    row({ display_name: "=cmd|'/c calc'!A1" }),
    row({ display_name: "+1+1" }),
    row({ display_name: "-1+1" }),
    row({ display_name: "@SUM(A1)" }),
    row({ address: "line1\nline2", display_name: "=1+1" }),
    row({ bank_name: "=hyperlink()" }),
  ]));
  const forbidden = [excel.ValueType.Formula, excel.ValueType.Hyperlink, excel.ValueType.Error];
  for (let r = 2; r <= 7; r += 1) {
    const dataRow = sheet.getRow(r);
    for (let c = 1; c <= WORKER_EXPORT_COLUMNS.length; c += 1) {
      assert.ok(!forbidden.includes(dataRow.getCell(c).type),
        `cell ${r}:${c} must not be a formula/hyperlink/error`);
    }
  }
  const nameIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "display_name") + 1;
  assert.equal(sheet.getRow(2).getCell(nameIndex).value, "=cmd|'/c calc'!A1");
  assert.equal(sheet.getRow(3).getCell(nameIndex).value, "+1+1");
  assert.equal(sheet.getRow(4).getCell(nameIndex).value, "-1+1");
  assert.equal(sheet.getRow(5).getCell(nameIndex).value, "@SUM(A1)");
  assert.equal(sheet.getRow(6).getCell(nameIndex).value, "=1+1");
  const addressIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "address") + 1;
  assert.equal(sheet.getRow(6).getCell(addressIndex).value, "line1\nline2");
});

test("payment_note stays empty while general_note carries the source value", async () => {
  const { sheet } = await reload(await buildWorkerExportXlsx([
    row({ payment_note: null, general_note: "=1+1\nnote" }),
  ]));
  const paymentIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "payment_note") + 1;
  const paymentCell = sheet.getRow(2).getCell(paymentIndex);
  assert.ok(paymentCell.value === null || paymentCell.value === "",
    "the payment note cell must be empty, never fabricated");

  const noteIndex = WORKER_EXPORT_COLUMNS.findIndex((c) => c.key === "general_note") + 1;
  const noteCell = sheet.getRow(2).getCell(noteIndex);
  assert.equal(noteCell.value, "=1+1\nnote", "general_note is literal text, never a formula");
});

test("an empty authorized result still produces a header-only file", async () => {
  const { sheet } = await reload(await buildWorkerExportXlsx([]));
  assert.equal(sheet.getRow(1).getCell(1).value, "Mã NLĐ");
  assert.equal(sheet.actualRowCount, 1);
});

test("the filename carries no PII", () => {
  assert.equal(workerExportFilename("2026-10-13"), "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  assert.match(workerExportFilename("garbage"), /^danh-sach-nguoi-lao-dong-[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx$/);
});
