/**
 * PRE-W2-P1 - Server-side XLSX builder cho xuat Excel full-PII.
 *
 * Tai su dung `exceljs` da cai dat (dynamic import), cung pattern voi
 * worker-profile-xlsx.ts. Khong dependency moi. Khong document status/signed URL/binary/
 * storage path/internal id/capability.
 *
 * An toan injection: moi cell la literal string. ExcelJS luu chuoi bat dau bang "=", "+", "-",
 * "@" (hoac chua tab/CR/LF) thanh shared string, KHONG phai formula/hyperlink/error. Moi cot
 * dung numFmt "@" de giu nguyen chuoi nguon.
 */
import type { WorkerExportRow } from "./worker-export-contract.ts";
import { WORKER_EXPORT_COLUMNS } from "./worker-export-contract.ts";

export const WORKER_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const WORKER_EXPORT_XLSX_LIMIT = 10000;

function cellText(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

export async function buildWorkerExportXlsx(rows: readonly WorkerExportRow[]): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Direct Entry";
  const sheet = workbook.addWorksheet("Người lao động");
  sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) => column.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let index = 1; index <= WORKER_EXPORT_COLUMNS.length; index += 1) {
    sheet.getColumn(index).width = 22;
    sheet.getRow(1).getCell(index).font = { bold: true };
  }
  for (const row of rows) {
    const added = sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) => cellText(row[column.key])));
    WORKER_EXPORT_COLUMNS.forEach((column, index) => {
      if (!column.text) return;
      // Text format: giu so 0 dau cho Mã NLĐ / CCCD / SĐT / STK.
      added.getCell(index + 1).numFmt = "@";
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/** Ten file khong chua PII. */
export function workerExportFilename(isoDate: string): string {
  const safe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(isoDate)
    ? isoDate
    : new Date().toISOString().slice(0, 10);
  return "danh-sach-nguoi-lao-dong-" + safe + ".xlsx";
}
