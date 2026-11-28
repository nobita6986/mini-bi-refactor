import assert from "node:assert/strict";
import test from "node:test";

import {
  captureClipboardUndoSnapshot,
  mapClipboardFromAnchor,
  parseClipboardTsv,
  restoreClipboardUndoSnapshot,
  serializeClipboardTsv,
} from "./direct-entry-grid-clipboard.ts";

function parsed(text) {
  const result = parseClipboardTsv(text);
  assert.equal(result.ok, true);
  return result;
}

test("parser giu dung TSV CRLF/LF, o trong, Unicode, so 0 dau va bo mot newline Excel", () => {
  const crlf = parsed("Dự án A\t\t001234\r\nDự án B\tNguyễn Văn B\t000056\r\n");
  const lf = parsed("Dự án A\t\t001234\nDự án B\tNguyễn Văn B\t000056\n");
  assert.deepEqual(crlf, lf);
  assert.deepEqual(crlf.matrix, [
    ["Dự án A", "", "001234"],
    ["Dự án B", "Nguyễn Văn B", "000056"],
  ]);
  assert.equal(crlf.rowCount, 2);
  assert.equal(crlf.columnCount, 3);

  const twoTrailingLines = parsed("A\n\n");
  assert.deepEqual(twoTrailingLines.matrix, [["A"], [""]]);
  assert.deepEqual(parsed("").matrix, [[""]]);
});

test("serializer xuat TSV hinh chu nhat va round-trip cac o trong", () => {
  const matrix = [["A", "", "C"], ["Đ", "0007"]];
  const text = serializeClipboardTsv(matrix);
  assert.equal(text, "A\t\tC\nĐ\t0007\t");
  assert.deepEqual(parsed(text).matrix, [["A", "", "C"], ["Đ", "0007", ""]]);
  assert.equal(serializeClipboardTsv([]), "");
});

test("mapper dat o theo anchor va phan loai write/validate-only/ignore ma khong lech cot", () => {
  const mapping = mapClipboardFromAnchor({
    matrix: [["12", "Dự án A", "01/10/2026"], ["13", "Dự án B", "02/10/2026"]],
    anchor: { rowIndex: 4, columnIndex: 0 },
  });
  assert.equal(mapping.ok, true);
  assert.equal(mapping.cells.length, 6);
  assert.deepEqual(mapping.cells.map((cell) => [cell.rowIndex, cell.columnKey, cell.value]), [
    [4, "row_index", "12"],
    [4, "project_id", "Dự án A"],
    [4, "first_work_date", "01/10/2026"],
    [5, "row_index", "13"],
    [5, "project_id", "Dự án B"],
    [5, "first_work_date", "02/10/2026"],
  ]);
  assert.equal(mapping.validationCells.length, 2);
  assert.equal(mapping.writeCells.length, 4);
  assert.equal(mapping.ignoredCells.length, 0);

  // P1.7-H05 + CTV: 29 cot tong (them provider_type va collaborator_id). Vi tri 24
  // (0-indexed) hien tai la bank_name.
  const crossingUiColumns = mapClipboardFromAnchor({
    matrix: [["Nguyễn Văn A", "front/back", "đã lưu", "xóa"]],
    anchor: { rowIndex: 0, columnIndex: 24 },
  });
  assert.equal(crossingUiColumns.ok, true);
  assert.deepEqual(crossingUiColumns.cells.map((cell) => [cell.columnKey, cell.pasteMode]), [
    ["bank_name", "write"],
    ["account_holder_name", "write"],
    ["cccd_documents", "ignore"],
    ["save_status", "ignore"],
  ]);
});

test("overflow va anchor sai bi reject atomic, khong tra ve partial cells", () => {
  const tooManyRows = Array.from({ length: 101 }, () => ["x"]);
  assert.deepEqual(mapClipboardFromAnchor({
    matrix: tooManyRows,
    anchor: { rowIndex: 0, columnIndex: 0 },
  }), { ok: false, code: "CLIPBOARD_ROW_OVERFLOW" });
  assert.deepEqual(mapClipboardFromAnchor({
    matrix: [["a"], ["b"]],
    anchor: { rowIndex: 99, columnIndex: 0 },
  }), { ok: false, code: "CLIPBOARD_ROW_OVERFLOW" });
  // P1.7-H05 + CTV: 29 cot tong, vi tri COLUMN_OVERFLOW la 28+ (0-indexed).
  assert.deepEqual(mapClipboardFromAnchor({
    matrix: [["a", "b"]],
    anchor: { rowIndex: 0, columnIndex: 28 },
  }), { ok: false, code: "CLIPBOARD_COLUMN_OVERFLOW" });
  assert.deepEqual(mapClipboardFromAnchor({
    matrix: [["a"]],
    anchor: { rowIndex: -1, columnIndex: 0 },
  }), { ok: false, code: "CLIPBOARD_ANCHOR_INVALID" });

  const parsedOverflow = parseClipboardTsv(
    Array.from({ length: 101 }, (_, index) => String(index)).join("\n"),
  );
  assert.equal(parsedOverflow.ok, false);
  assert.equal(parsedOverflow.code, "CLIPBOARD_ROW_OVERFLOW");
});

test("one-level undo khoi phuc cell cu va bo hang placeholder duoc paste them", () => {
  const before = [
    { cells: { project_id: "Dự án cũ", first_work_date: "2026-09-01" } },
    { cells: { project_id: "", first_work_date: "" } },
  ];
  const mapping = mapClipboardFromAnchor({
    matrix: [["Dự án mới", "01/10/2026"], ["Dự án B", "02/10/2026"]],
    anchor: { rowIndex: 1, columnIndex: 1 },
  });
  assert.equal(mapping.ok, true);
  const snapshot = captureClipboardUndoSnapshot({
    mapping,
    currentRowCount: before.length,
    readCell: (rowIndex, key) => before[rowIndex]?.cells[key],
  });

  const after = [
    before[0],
    { cells: { project_id: "Dự án mới", first_work_date: "01/10/2026" } },
    { cells: { project_id: "Dự án B", first_work_date: "02/10/2026" } },
  ];
  const restored = restoreClipboardUndoSnapshot({
    rows: after,
    snapshot,
    writeCell: (rows, rowIndex, key, value) => rows.map((row, index) => index === rowIndex
      ? { ...row, cells: { ...row.cells, [key]: value } }
      : row),
  });
  assert.equal(restored.length, 2);
  assert.deepEqual(restored[0], before[0]);
  assert.deepEqual(restored[1], before[1]);
  assert.equal(Object.isFrozen(snapshot), true);
});
