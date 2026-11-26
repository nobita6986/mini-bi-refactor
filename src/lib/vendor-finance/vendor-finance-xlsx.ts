import "server-only";

import type ExcelJS from "exceljs";
import type {
  VendorFinanceBalanceDirection,
  VendorFinanceContractType,
  VendorFinanceExportVendorItem,
  VendorFinanceMonthlyReportResponse,
} from "./vendor-finance-contract.ts";

export const VENDOR_FINANCE_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const VENDOR_FINANCE_EXPORT_WORKSHEET_NAME = "Danh sách Vendor";

export const VENDOR_FINANCE_MONTHLY_SUMMARY_SHEET_NAME = "Tổng hợp KT × Dự án";
export const VENDOR_FINANCE_MONTHLY_DETAIL_SHEET_NAME = "Chi tiết Dự án × KT × Vendor";

export const VENDOR_FINANCE_EXPORT_COLUMNS = [
  { key: "stt", header: "STT", width: 8 },
  { key: "vendor_id", header: "Mã Vendor", width: 20 },
  { key: "display_name", header: "Tên Vendor", width: 34 },
  { key: "status_label", header: "Trạng thái", width: 18 },
  { key: "sub_ledger_count", header: "Số sổ dự án", width: 14 },
  { key: "payable_total_minor", header: "Công nợ phải trả (VND)", width: 24 },
  { key: "shared_advance_balance_minor", header: "Số dư ứng dùng chung (VND)", width: 26 },
  { key: "last_effective_date", header: "Ngày giao dịch gần nhất", width: 22 },
] as const;

export const VENDOR_FINANCE_MONTHLY_SUMMARY_EXPORT_COLUMNS = [
  { key: "stt", header: "STT", width: 8 },
  { key: "project_id", header: "Mã dự án", width: 18 },
  { key: "project_display_name", header: "Dự án", width: 32 },
  { key: "contract_type_label", header: "Loại hợp đồng", width: 16 },
  { key: "responsible_accountant_display_name", header: "Kế toán phụ trách", width: 26 },
  { key: "assignment_status_label", header: "Trạng thái phụ trách", width: 20 },
  { key: "vendor_count", header: "Số Vendor", width: 12 },
  { key: "obligations_in_month_minor", header: "Phát sinh tháng (VND)", width: 22 },
  { key: "paid_and_advanced_in_month_minor", header: "Đã TT & tạm ứng (VND)", width: 22 },
  { key: "paid_in_month_minor", header: "Đã thanh toán (VND)", width: 22 },
  { key: "advanced_in_month_minor", header: "Tạm ứng tháng (VND)", width: 22 },
  { key: "advance_offset_in_month_minor", header: "Khấu trừ ứng (VND)", width: 22 },
  { key: "closing_payable_minor", header: "Phải trả cuối tháng (VND)", width: 24 },
  { key: "closing_advance_minor", header: "Dư ứng cuối tháng (VND)", width: 24 },
  { key: "in_month_entry_count", header: "Số GD trong tháng", width: 18 },
] as const;

export const VENDOR_FINANCE_MONTHLY_DETAIL_EXPORT_COLUMNS = [
  { key: "stt", header: "STT", width: 8 },
  { key: "project_id", header: "Mã dự án", width: 18 },
  { key: "project_display_name", header: "Dự án", width: 32 },
  { key: "responsible_accountant_display_name", header: "Kế toán phụ trách", width: 26 },
  { key: "assignment_status_label", header: "Trạng thái phụ trách", width: 20 },
  { key: "vendor_id", header: "Mã Vendor", width: 18 },
  { key: "vendor_display_name", header: "Tên Vendor", width: 32 },
  { key: "contract_type_label", header: "Loại hợp đồng", width: 16 },
  { key: "balance_before_month_minor", header: "Số dư đầu tháng (VND)", width: 24 },
  { key: "obligations_in_month_minor", header: "Phát sinh tháng (+) (VND)", width: 24 },
  { key: "paid_and_advanced_in_month_minor", header: "TT & Tạm ứng (-) (VND)", width: 24 },
  { key: "paid_in_month_minor", header: "Đã thanh toán (VND)", width: 22 },
  { key: "advanced_in_month_minor", header: "Tạm ứng tháng (VND)", width: 22 },
  { key: "advance_offset_in_month_minor", header: "Khấu trừ ứng (-) (VND)", width: 24 },
  { key: "closing_balance_minor", header: "Số dư cuối tháng (VND)", width: 24 },
  { key: "closing_direction_label", header: "Trạng thái cuối tháng", width: 22 },
  { key: "closing_payable_minor", header: "Phải trả cuối tháng (VND)", width: 24 },
  { key: "closing_advance_minor", header: "Dư ứng cuối tháng (VND)", width: 24 },
  { key: "in_month_entry_count", header: "Số GD trong tháng", width: 18 },
] as const;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMULA_TRIGGER_RE = /^[\s]*[=+\-@]/;
const CANONICAL_SIGNED_MINOR_RE = /^(?:0|-?[1-9][0-9]{0,18})$/;
const CANONICAL_EXACT_INTEGER_RE = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_EXCEL_EXACT_INT_NUMBER = 999_999_999_999_999;
const MIN_EXCEL_EXACT_INT_NUMBER = -999_999_999_999_999;
const MAX_EXCEL_EXACT_INT_BIGINT = BigInt(MAX_EXCEL_EXACT_INT_NUMBER);
const MIN_EXCEL_EXACT_INT_BIGINT = BigInt(MIN_EXCEL_EXACT_INT_NUMBER);

const CONTRACT_TYPE_EXPORT_LABELS: Readonly<Record<VendorFinanceContractType, string>> = {
  SEASONAL: "Thời vụ",
  OFFICIAL: "Chính thức",
  UNCLASSIFIED: "Chưa phân loại",
};

const CLOSING_DIRECTION_EXPORT_LABELS: Readonly<Record<VendorFinanceBalanceDirection, string>> = {
  PAYABLE: "Còn phải trả",
  ADVANCE: "Đang dư ứng",
  BALANCED: "Cân bằng (0 ₫)",
};

function assignmentStatusLabel(isCurrentlyAssigned: boolean): string {
  return isCurrentlyAssigned ? "Đang phụ trách" : "Sổ kỳ trước";
}

function sanitizeExportText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const cleaned = value.replace(CONTROL_CHARS_RE, "");
  return FORMULA_TRIGGER_RE.test(cleaned) ? `'${cleaned}` : cleaned;
}

function sanitizeCanonicalMinorString(value: string): string {
  const cleaned = sanitizeExportText(value).trim();
  if (!CANONICAL_SIGNED_MINOR_RE.test(cleaned)) {
    return "0";
  }
  return BigInt(cleaned).toString();
}

type ExportCellSpec =
  | { kind: "number"; value: number }
  | { kind: "exact_integer_text"; value: string }
  | { kind: "text"; value: string | null | undefined };

function textCell(value: string | null | undefined): ExportCellSpec {
  return { kind: "text", value };
}

function numericCell(value: string | number): ExportCellSpec {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      const normalized = value === 0 ? 0 : value;
      return normalized >= MIN_EXCEL_EXACT_INT_NUMBER && normalized <= MAX_EXCEL_EXACT_INT_NUMBER
        ? { kind: "number", value: normalized }
        : { kind: "exact_integer_text", value: String(normalized) };
    }
    return { kind: "text", value: String(value) };
  }
  // Keep integers up to Excel's 15-significant-digit precision as numeric cells for SUM();
  // preserve longer exact integers (including negatives) verbatim without leading apostrophe.
  const trimmed = value.trim();
  if (CANONICAL_EXACT_INTEGER_RE.test(trimmed)) {
    const parsed = BigInt(trimmed);
    if (parsed >= MIN_EXCEL_EXACT_INT_BIGINT && parsed <= MAX_EXCEL_EXACT_INT_BIGINT) {
      return { kind: "number", value: Number(parsed) };
    }
    return { kind: "exact_integer_text", value: parsed.toString() };
  }
  return { kind: "text", value };
}

function configureFrozenHeader(
  sheet: ExcelJS.Worksheet,
  columns: readonly { header: string; width: number }[],
): void {
  sheet.addRow(columns.map((col) => col.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (let index = 1; index <= columns.length; index += 1) {
    sheet.getColumn(index).width = columns[index - 1].width;
    sheet.getRow(1).getCell(index).font = { bold: true };
  }
}

function appendMonthlyExportRows(
  sheet: ExcelJS.Worksheet,
  rows: readonly (readonly ExportCellSpec[])[],
): void {
  for (const specs of rows) {
    const resolved = specs.map((spec) => {
      if (spec.kind === "number") return spec.value;
      if (spec.kind === "exact_integer_text") return spec.value;
      return sanitizeExportText(spec.value);
    });
    const added = sheet.addRow(resolved);
    for (let colIdx = 1; colIdx <= specs.length; colIdx += 1) {
      const cell = added.getCell(colIdx);
      cell.value = resolved[colIdx - 1];
      cell.numFmt = specs[colIdx - 1].kind === "number" ? "#,##0" : "@";
    }
  }
}

export async function buildVendorFinanceExportXlsx(
  vendors: readonly VendorFinanceExportVendorItem[],
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Vendor Finance";
  const sheet = workbook.addWorksheet(VENDOR_FINANCE_EXPORT_WORKSHEET_NAME);

  configureFrozenHeader(sheet, VENDOR_FINANCE_EXPORT_COLUMNS);

  vendors.forEach((vendor, rowIndex) => {
    const rowValues: string[] = [
      String(rowIndex + 1),
      sanitizeExportText(vendor.vendor_id),
      sanitizeExportText(vendor.display_name),
      vendor.active ? "Đang hoạt động" : "Ngừng hoạt động",
      String(vendor.sub_ledger_count),
      sanitizeCanonicalMinorString(vendor.payable_total_minor),
      sanitizeCanonicalMinorString(vendor.shared_advance_balance_minor),
      sanitizeExportText(vendor.last_effective_date),
    ];
    const added = sheet.addRow(rowValues);
    for (let colIdx = 1; colIdx <= VENDOR_FINANCE_EXPORT_COLUMNS.length; colIdx += 1) {
      const cell = added.getCell(colIdx);
      cell.value = rowValues[colIdx - 1];
      cell.numFmt = "@";
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/**
 * Builds the 2-sheet monthly vendor-finance XLSX workbook (Summary by Project x Accountant,
 * then Detail by Project x Accountant x Vendor) without any project-revenue column.
 */
export async function buildVendorFinanceMonthlyReportExportXlsx(
  report: VendorFinanceMonthlyReportResponse,
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Vendor Finance";

  const summarySheet = workbook.addWorksheet(VENDOR_FINANCE_MONTHLY_SUMMARY_SHEET_NAME);
  configureFrozenHeader(summarySheet, VENDOR_FINANCE_MONTHLY_SUMMARY_EXPORT_COLUMNS);
  appendMonthlyExportRows(
    summarySheet,
    report.project_accountant_summaries.map((item, idx) => [
      numericCell(idx + 1),
      textCell(item.project_id),
      textCell(item.project_display_name),
      textCell(CONTRACT_TYPE_EXPORT_LABELS[item.contract_type]),
      textCell(item.responsible_accountant_display_name),
      textCell(assignmentStatusLabel(item.is_currently_assigned)),
      numericCell(item.vendor_count),
      numericCell(item.obligations_in_month_minor),
      numericCell(item.paid_and_advanced_in_month_minor),
      numericCell(item.paid_in_month_minor),
      numericCell(item.advanced_in_month_minor),
      numericCell(item.advance_offset_in_month_minor),
      numericCell(item.closing_payable_minor),
      numericCell(item.closing_advance_minor),
      numericCell(item.in_month_entry_count),
    ]),
  );

  const detailSheet = workbook.addWorksheet(VENDOR_FINANCE_MONTHLY_DETAIL_SHEET_NAME);
  configureFrozenHeader(detailSheet, VENDOR_FINANCE_MONTHLY_DETAIL_EXPORT_COLUMNS);
  appendMonthlyExportRows(
    detailSheet,
    report.rows.map((row, idx) => [
      numericCell(idx + 1),
      textCell(row.project_id),
      textCell(row.project_display_name),
      textCell(row.responsible_accountant_display_name),
      textCell(assignmentStatusLabel(row.is_currently_assigned)),
      textCell(row.vendor_id),
      textCell(row.vendor_display_name),
      textCell(CONTRACT_TYPE_EXPORT_LABELS[row.contract_type]),
      numericCell(row.balance_before_month_minor),
      numericCell(row.obligations_in_month_minor),
      numericCell(row.paid_and_advanced_in_month_minor),
      numericCell(row.paid_in_month_minor),
      numericCell(row.advanced_in_month_minor),
      numericCell(row.advance_offset_in_month_minor),
      numericCell(row.closing_balance_minor),
      textCell(CLOSING_DIRECTION_EXPORT_LABELS[row.closing_direction]),
      numericCell(row.closing_payable_minor),
      numericCell(row.closing_advance_minor),
      numericCell(row.in_month_entry_count),
    ]),
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/** Safe filename without PII or vendor names. */
export function vendorFinanceExportFilename(authorizationDate?: string | null): string {
  const safe =
    typeof authorizationDate === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(authorizationDate)
      ? authorizationDate
      : new Date().toISOString().slice(0, 10);
  return `danh-sach-vendor-cong-no-${safe}.xlsx`;
}

/** Safe monthly report filename (`bao-cao-cong-no-vendor-YYYY-MM.xlsx`). */
export function vendorFinanceMonthlyReportExportFilename(month?: string | null): string {
  const safeMonth =
    typeof month === "string" && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)
      ? month
      : new Date().toISOString().slice(0, 7);
  return `bao-cao-cong-no-vendor-${safeMonth}.xlsx`;
}
