/**
 * PRE-WAVE-2: Adapter validation cho chế độ Biểu mẫu (Form mode - worker-profile/1.2).
 *
 * Tuyệt đối không sửa đổi validation của chế độ Lưới (Grid mode - worker-profile/1.1).
 * Module này tái sử dụng toàn bộ pipeline `buildSpreadsheetValidation`, và chỉ điều chỉnh
 * quy tắc bắt buộc cá nhân cho Biểu mẫu:
 *   1. `national_id` (Số CCCD 12 chữ số hợp lệ) là BẮT BUỘC (`PASTE_VALUE_REQUIRED` nếu để trống).
 *   2. `display_name` (Họ và tên) là KHÔNG BẮT BUỘC (loại bỏ `PASTE_VALUE_REQUIRED` trên `display_name`,
 *      nhưng vẫn giữ nguyên các lỗi định dạng như `PASTE_FORMULA_CELL` hoặc `PASTE_TEXT_TOO_LONG`).
 */
import {
  buildSpreadsheetValidation,
  type SpreadsheetCellIssue,
  type SpreadsheetValidation,
  type SpreadsheetValidationRow,
} from "./direct-entry-grid-validation.ts";
import { CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION } from "./full-profile-contract.ts";
import type { SpreadsheetStagedRow } from "./spreadsheet-row-model.ts";
import {
  issue,
  workerProfileIssueMessage,
  type WorkerProfileIssue,
} from "./worker-profile-import-contract.ts";
import type {
  ExistingProfileIdentity,
  PasteCatalogSource,
  WorkerProfilePreview,
  WorkerProfilePreviewRow,
} from "./worker-profile-preview.ts";

export function buildFormProfileValidation(input: {
  rows: readonly SpreadsheetStagedRow[];
  referenceDate: string;
  catalogFor: (effectiveDate: string) => PasteCatalogSource | null;
  existing?: readonly ExistingProfileIdentity[];
  capabilities?: readonly string[];
}): SpreadsheetValidation {
  const base = buildSpreadsheetValidation(input);
  if (base.preview === null) return base;

  const stagedRowByClientId = new Map(
    input.rows.map((row) => [row.clientRowId, row] as const),
  );

  const clientRowIdForSourceRow = (sourceRow: number): string | null => {
    const index = sourceRow - 2;
    return base.rowOrder[index] ?? null;
  };

  const previewRows: WorkerProfilePreviewRow[] = base.preview.rows.map((previewRow) => {
    const clientRowId = clientRowIdForSourceRow(previewRow.sourceRow);
    const stagedRow = clientRowId !== null ? stagedRowByClientId.get(clientRowId) : undefined;
    const providerType = stagedRow?.providerType ?? "";
    const rawProjectId = (stagedRow?.cells.project_id ?? previewRow.labels.project ?? "").trim();
    const rawRecruiterId = (stagedRow?.cells.recruiter_id ?? previewRow.labels.recruiter ?? "").trim();
    const rawLaborType = (stagedRow?.cells.labor_type ?? previewRow.row.labor_type ?? "").trim();
    const recruiterReadyForCatalogCheck = providerType !== "" && rawRecruiterId !== "";

    const filteredIssues = previewRow.issues.filter((item) => {
      if (item.field === "display_name" && item.code === "PASTE_VALUE_REQUIRED") {
        return false;
      }
      if (
        item.field === "project_id" &&
        (item.code === "PASTE_CATALOG_MISSING" || item.code === "PASTE_CATALOG_UNRESOLVED") &&
        rawProjectId === ""
      ) {
        return false;
      }
      if (
        item.field === "recruiter_id" &&
        (item.code === "PASTE_CATALOG_MISSING" || item.code === "PASTE_CATALOG_UNRESOLVED") &&
        !recruiterReadyForCatalogCheck
      ) {
        return false;
      }
      if (item.field === "labor_type" && item.code === "PASTE_LABOR_TYPE_INVALID" && rawLaborType === "") {
        return false;
      }
      return true;
    });

    const catalog = input.catalogFor(previewRow.row.first_work_date || input.referenceDate);
    const expectedRecruiterProvider = providerType === "ctv" ? "hrp" : providerType;
    const normalizedRecruiterKey = rawRecruiterId.toLocaleLowerCase("vi-VN");
    const recruiterProviderMismatch =
      recruiterReadyForCatalogCheck &&
      ((previewRow.resolved !== null && previewRow.resolved.provider_type !== expectedRecruiterProvider) ||
        (catalog !== null &&
          catalog.recruiters.some(
            (recruiter) =>
              recruiter.id.trim().toLocaleLowerCase("vi-VN") === normalizedRecruiterKey ||
              recruiter.label.trim().toLocaleLowerCase("vi-VN") === normalizedRecruiterKey,
          ) &&
          !catalog.recruiters.some(
            (recruiter) =>
              (recruiter.id.trim().toLocaleLowerCase("vi-VN") === normalizedRecruiterKey ||
                recruiter.label.trim().toLocaleLowerCase("vi-VN") === normalizedRecruiterKey) &&
              recruiter.provider_type === expectedRecruiterProvider,
          )));

    const nextIssues: WorkerProfileIssue[] = [...filteredIssues];
    if (rawProjectId === "" && !nextIssues.some((item) => item.field === "project_id")) {
      nextIssues.push(issue("PASTE_VALUE_REQUIRED", "error", previewRow.sourceRow, "project_id"));
    }
    if (!recruiterReadyForCatalogCheck && !nextIssues.some((item) => item.field === "recruiter_id")) {
      nextIssues.push(issue("PASTE_VALUE_REQUIRED", "error", previewRow.sourceRow, "recruiter_id"));
    }
    if (
      recruiterProviderMismatch &&
      !nextIssues.some((item) => item.field === "recruiter_id" && item.code === "PASTE_CATALOG_MISSING")
    ) {
      nextIssues.push(issue("PASTE_CATALOG_MISSING", "error", previewRow.sourceRow, "recruiter_id"));
    }
    if (rawLaborType === "" && !nextIssues.some((item) => item.field === "labor_type")) {
      nextIssues.push(issue("PASTE_VALUE_REQUIRED", "error", previewRow.sourceRow, "labor_type"));
    }

    const hasNationalIdError = nextIssues.some((item) => item.field === "national_id");
    if (previewRow.row.worker.national_id.state !== "provided" && !hasNationalIdError) {
      nextIssues.push(issue("PASTE_VALUE_REQUIRED", "error", previewRow.sourceRow, "national_id"));
    }

    const resolved =
      !recruiterReadyForCatalogCheck || recruiterProviderMismatch
        ? {
            project_id: previewRow.resolved.project_id,
            recruiter_id: null,
            provider_type: null,
            collaborator_id: previewRow.resolved.collaborator_id ?? null,
          }
        : previewRow.resolved;

    return {
      ...previewRow,
      resolved,
      issues: nextIssues,
      canProceed:
        nextIssues.length === 0 &&
        resolved.project_id !== null &&
        resolved.recruiter_id !== null &&
        resolved.provider_type !== null &&
        (providerType !== "ctv" || typeof resolved.collaborator_id === "string" && resolved.collaborator_id.length > 0),
    };
  });

  const allIssues: WorkerProfileIssue[] = [
    ...base.preview.headerIssues,
    ...previewRows.flatMap((row) => [...row.issues, ...row.warnings]),
  ];
  const errorCount = allIssues.filter((item) => item.severity === "error").length;
  const warningCount = allIssues.filter((item) => item.severity === "warning").length;
  const validRows = previewRows.filter((row) => row.canProceed).length;

  const preview: WorkerProfilePreview = {
    ...base.preview,
    contractVersion: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
    rows: previewRows,
    issues: allIssues,
    validRows,
    errorCount,
    warningCount,
    canProceed: errorCount === 0 && previewRows.length > 0,
  };

  const cellIssues: SpreadsheetCellIssue[] = [];
  const headerIssues: SpreadsheetCellIssue[] = [];
  for (const item of preview.issues) {
    const mapped: SpreadsheetCellIssue = Object.freeze({
      clientRowId: item.row >= 2 ? clientRowIdForSourceRow(item.row) : null,
      columnKey: item.field === null ? null : item.field,
      code: item.code,
      severity: item.severity,
      message: item.code === "CTV_REQUIRED"
        ? "Vui lòng chọn CTV khi nguồn là CTV."
        : item.field === "collaborator_id" && item.code === "PASTE_CATALOG_MISSING"
          ? "CTV không tồn tại hoặc đã ngừng hoạt động."
          : workerProfileIssueMessage(item.code),
    });
    if (item.row >= 2 && mapped.clientRowId !== null) cellIssues.push(mapped);
    else headerIssues.push(mapped);
  }

  const rows: SpreadsheetValidationRow[] = previewRows.map((row) => ({
    clientRowId: clientRowIdForSourceRow(row.sourceRow) ?? "",
    canProceed: row.canProceed,
    errorCount: row.issues.length,
    warningCount: row.warnings.length,
    employeeCode: row.row.employee_code,
    displayName: row.row.display_name,
    projectLabel: row.labels.project,
    recruiterLabel: row.labels.recruiter,
    firstWorkDate: row.row.first_work_date,
  }));

  const firstError = cellIssues.find(
    (item) => item.severity === "error" && item.clientRowId !== null && item.columnKey !== null,
  );

  return {
    preview,
    rowOrder: base.rowOrder,
    rows: Object.freeze(rows),
    cellIssues: Object.freeze(cellIssues),
    headerIssues: Object.freeze(headerIssues),
    validRowCount: validRows,
    errorCount,
    warningCount,
    canSave: validRows > 0,
    catalogDates: base.catalogDates,
    firstError:
      firstError && firstError.clientRowId !== null && firstError.columnKey !== null
        ? { clientRowId: firstError.clientRowId, columnKey: firstError.columnKey }
        : null,
  };
}
