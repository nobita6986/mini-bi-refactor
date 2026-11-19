import {
  resolveAttendanceEmployeeDisplayIdentity,
} from "./attendance-report-contract.ts";
import {
  DEFAULT_ATTENDANCE_SLOT_POLICY,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE,
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME,
  type AttendanceMonthlyMatrixCalendarDayProjection,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixReportProjection,
  type AttendanceMonthlyMatrixSlotPolicySummaryProjection,
  type AttendanceSlotPolicyProjection,
} from "./attendance-monthly-matrix-contract.ts";
import {
  describeMatrixDayCell,
  formatEmployeeSlotPolicySummaryLabel,
  getCurrentVnBusinessDate,
  MATRIX_LEAVE_SESSION_LABELS,
  MATRIX_LEAVE_TYPE_LABELS,
  MATRIX_LEGEND_ITEMS,
  MATRIX_WEEKDAY_LABELS,
} from "./attendance-monthly-matrix-ui-model.ts";

function sanitizeSpreadsheetText(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export function formatMatrixLeaveSummary(
  cell: Pick<AttendanceMonthlyMatrixDayCellProjection, "approved_leaves">,
): string {
  if (cell.approved_leaves.length === 0) return "";
  return cell.approved_leaves
    .map((item) => {
      const typeLabel = MATRIX_LEAVE_TYPE_LABELS[item.leave_type] ?? item.leave_type;
      const sessionLabel = MATRIX_LEAVE_SESSION_LABELS[item.session_code] ?? item.session_code;
      return `${typeLabel} (${sessionLabel})`;
    })
    .join("; ");
}

export function formatMatrixExplanationSummary(
  cell: AttendanceMonthlyMatrixDayCellProjection,
): string {
  const presentation = describeMatrixDayCell(cell);
  const parts: string[] = [];
  for (const slot of presentation.slots) {
    if (slot.explanationStatusLabel) {
      const reasonSuffix = slot.explanation?.reason ? ` (${slot.explanation.reason})` : "";
      parts.push(`${slot.slotShortLabel}: ${slot.explanationStatusLabel}${reasonSuffix}`);
    }
  }
  return parts.join("; ");
}

export function formatMatrixDayCellText(
  cell: AttendanceMonthlyMatrixDayCellProjection,
  options?: { todayBusinessDate?: string },
): string {
  const presentation = describeMatrixDayCell(cell, options);
  if (presentation.isOutOfScopeOrExempt) {
    return "— (Ngoài phạm vi)";
  }
  const slotParts = presentation.slots.map(
    (slot) => `${slot.slotTitle}: ${slot.summaryText}`,
  );
  const parts: string[] = [slotParts.join("\n")];

  if (cell.has_checkin) {
    const targetPrefix =
      cell.distance_target_kind === "BRANCH"
        ? cell.branch_code_used
          ? `CN:${cell.branch_code_used}`
          : "CN"
        : "HQ";

    if (cell.distance_status === "COMPUTED" && cell.distance_meters !== null) {
      parts.push(`[${targetPrefix} ${Math.round(cell.distance_meters)}m]`);
    } else if (cell.distance_status === "BRANCH_NOT_CONFIGURED") {
      parts.push(`[${targetPrefix} chưa có tọa độ]`);
    } else if (cell.distance_status === "HQ_NOT_CONFIGURED") {
      parts.push("[HQ chưa có tọa độ]");
    } else if (cell.distance_status === "INVALID_GPS") {
      parts.push("[GPS không hợp lệ]");
    }
  }

  if (cell.has_approved_leave) {
    const leaveText = formatMatrixLeaveSummary(cell);
    parts.push(leaveText ? `Nghỉ: ${leaveText}` : `Nghỉ (${cell.approved_leave_units} ngày)`);
  }

  if (
    presentation.policyProfileCodeUsed !== DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE ||
    presentation.policyProfileNameUsed !== DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME
  ) {
    parts.push(`[Khung giờ: ${presentation.policyProfileNameUsed} v${presentation.policyVersionUsed}]`);
  }

  return parts.join("\n");
}

export function attendanceMonthlyMatrixExportFilename(yearMonth: string): string {
  const safeMonth = /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(yearMonth) ? yearMonth : "report";
  return `attendance-monthly-matrix-${safeMonth}.xlsx`;
}

export async function buildAttendanceMonthlyMatrixXlsx(
  input: {
    year_month: string;
    from_date: string;
    to_date: string;
    calendar_days: AttendanceMonthlyMatrixCalendarDayProjection[];
    items: AttendanceMonthlyMatrixEmployeeRowProjection[];
    slot_policy?: AttendanceMonthlyMatrixSlotPolicySummaryProjection;
  },
  options?: { todayBusinessDate?: string },
): Promise<Uint8Array> {
  const todayBusinessDate = options?.todayBusinessDate ?? getCurrentVnBusinessDate();
  const imported = await import("exceljs");
  const excel = imported.default ?? imported;
  const workbook = new excel.Workbook();
  workbook.creator = "Mini BI Attendance";

  const matrixSheet = workbook.addWorksheet("Ma trận chấm công");
  const baseHeaders = [
    "STT",
    "Họ và tên",
    "Mã nhân sự",
    "Chi nhánh",
    "Mã chi nhánh",
    "Cấu hình khung giờ",
    "Số ngày có check-in",
    "Tổng lượt check-in",
    "Số ngày có phép duyệt",
    "Tổng ngày phép duyệt",
    "Số ngày chưa check-in (ngoài ngày phép)",
  ];

  const dayHeaders = input.calendar_days.map((day) => {
    const dd = String(day.day_of_month).padStart(2, "0");
    const dow = MATRIX_WEEKDAY_LABELS[day.day_of_week] ?? "";
    return `${dd} (${dow})`;
  });

  const allMatrixHeaders = [...baseHeaders, ...dayHeaders];
  matrixSheet.addRow(allMatrixHeaders);
  matrixSheet.views = [{ state: "frozen", xSplit: 6, ySplit: 1 }];

  const headerRow = matrixSheet.getRow(1);
  headerRow.font = { bold: true };
  for (let col = 1; col <= allMatrixHeaders.length; col += 1) {
    matrixSheet.getColumn(col).width = col <= 6 ? 20 : col <= 11 ? 18 : 28;
    if (col >= 2 && col <= 6) {
      matrixSheet.getColumn(col).numFmt = "@";
    }
  }

  input.items.forEach((emp, index) => {
    const dayByDate = new Map<string, AttendanceMonthlyMatrixDayCellProjection>();
    for (const d of emp.days) {
      dayByDate.set(d.business_date, d);
    }

    const resolvedIdentity = resolveAttendanceEmployeeDisplayIdentity({
      displayName: emp.employee_display_name,
      personnelCode: emp.personnel_code,
    });
    const profileSummaryLabel = formatEmployeeSlotPolicySummaryLabel(emp);

    const rowValues: Array<string | number> = [
      index + 1,
      sanitizeSpreadsheetText(resolvedIdentity.displayName),
      sanitizeSpreadsheetText(resolvedIdentity.personnelCode ?? ""),
      sanitizeSpreadsheetText(emp.branch?.display_name ?? "Mặc định (HQ)"),
      sanitizeSpreadsheetText(emp.branch?.branch_code ?? "HQ"),
      sanitizeSpreadsheetText(profileSummaryLabel),
      emp.summary.checkin_day_count,
      emp.summary.total_checkins,
      emp.summary.approved_leave_day_count,
      emp.summary.approved_leave_units,
      emp.summary.no_checkin_without_leave_day_count,
    ];

    for (const calDay of input.calendar_days) {
      const cell = dayByDate.get(calDay.business_date);
      rowValues.push(
        cell
          ? sanitizeSpreadsheetText(formatMatrixDayCellText(cell, { todayBusinessDate }))
          : "",
      );
    }

    const addedRow = matrixSheet.addRow(rowValues);
    addedRow.alignment = { vertical: "top", wrapText: true };

    input.calendar_days.forEach((calDay, dayIdx) => {
      const cellData = dayByDate.get(calDay.business_date);
      if (!cellData) return;
      const presentation = describeMatrixDayCell(cellData, { todayBusinessDate });
      const excelCell = addedRow.getCell(baseHeaders.length + dayIdx + 1);
      if (presentation.isOutOfScopeOrExempt) {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
      } else if (presentation.tone === "emerald") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFECFDF5" },
        };
      } else if (presentation.tone === "amber") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFBEB" },
        };
      } else if (presentation.tone === "sky") {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF0F9FF" },
        };
      } else {
        excelCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEF2F2" },
        };
      }
    });
  });

  const collectedMonthPolicies: AttendanceSlotPolicyProjection[] = [];
  const seenPolicyKeys = new Set<string>();
  const addPolicyCandidate = (pol: AttendanceSlotPolicyProjection | null | undefined) => {
    if (!pol) return;
    const key = `${pol.profile_id ?? "default"}:${pol.version}`;
    if (seenPolicyKeys.has(key)) return;
    seenPolicyKeys.add(key);
    collectedMonthPolicies.push(pol);
  };

  if (input.slot_policy?.profiles) {
    for (const prof of input.slot_policy.profiles) {
      for (const pol of prof.month_policies ?? []) {
        addPolicyCandidate(pol);
      }
      if (!prof.month_policies || prof.month_policies.length === 0) {
        addPolicyCandidate(prof.current_policy);
      }
    }
  }
  if (input.slot_policy?.month_policies) {
    for (const pol of input.slot_policy.month_policies) {
      addPolicyCandidate(pol);
    }
  }
  if (collectedMonthPolicies.length === 0) {
    addPolicyCandidate(input.slot_policy?.current_policy ?? DEFAULT_ATTENDANCE_SLOT_POLICY);
  }

  let maxObservedDaySlots = 0;
  for (const emp of input.items) {
    for (const day of emp.days) {
      const pres = describeMatrixDayCell(day, { todayBusinessDate });
      if (pres.slots.length > maxObservedDaySlots) {
        maxObservedDaySlots = pres.slots.length;
      }
    }
  }

  const detailSlotCount = Math.max(
    1,
    maxObservedDaySlots,
    ...collectedMonthPolicies.map((pol) => pol.slots.length),
  );

  const detailSlotHeaders = Array.from({ length: detailSlotCount }, (_, idx) => {
    const distinctTitles = new Set<string>();
    for (const pol of collectedMonthPolicies) {
      const s = pol.slots[idx];
      if (s) {
        distinctTitles.add(`${s.slot_label || `Time ${idx + 1}`} (${s.target_time})`);
      }
    }
    if (distinctTitles.size === 1) {
      return [...distinctTitles][0]!;
    }
    return `Mốc ${idx + 1}`;
  });

  const detailSheet = workbook.addWorksheet("Chi tiết theo ngày");
  const detailHeaders = [
    "Ngày",
    "Họ và tên",
    "Mã nhân sự",
    "Chi nhánh hiện tại",
    "Trạng thái ngày",
    "Cấu hình khung giờ",
    "Số mốc áp dụng",
    ...detailSlotHeaders,
    "Số mốc chưa có lượt chấm",
    "Số lượt lệch khung giờ",
    "Giờ check-in đầu",
    "Giờ check-in cuối",
    "Số lượt check-in",
    "Mốc tính khoảng cách",
    "Trạng thái khoảng cách",
    "Khoảng cách (m)",
    "Nghỉ phép đã duyệt",
    "Số công phép",
    "Giải trình chấm công",
  ];
  detailSheet.addRow(detailHeaders);
  detailSheet.views = [{ state: "frozen", ySplit: 1 }];
  detailSheet.getRow(1).font = { bold: true };
  for (let col = 1; col <= detailHeaders.length; col += 1) {
    detailSheet.getColumn(col).width =
      col >= 8 && col < 8 + detailSlotCount ? 28 : 20;
  }
  detailSheet.getColumn(2).numFmt = "@";
  detailSheet.getColumn(3).numFmt = "@";
  detailSheet.getColumn(4).numFmt = "@";
  detailSheet.getColumn(6).numFmt = "@";

  for (const emp of input.items) {
    const resolvedIdentity = resolveAttendanceEmployeeDisplayIdentity({
      displayName: emp.employee_display_name,
      personnelCode: emp.personnel_code,
    });
    for (const day of emp.days) {
      const presentation = describeMatrixDayCell(day, { todayBusinessDate });
      const targetLabel =
        day.distance_target_kind === "BRANCH"
          ? day.branch_code_used
            ? `Chi nhánh (${day.branch_code_used})`
            : "Chi nhánh"
          : day.distance_target_kind === "HQ"
            ? "HQ"
            : "";

      const dynamicSlotCells = Array.from({ length: detailSlotCount }, (_, idx) => {
        if (presentation.isOutOfScopeOrExempt) {
          return "—";
        }
        const slotPres = presentation.slots[idx];
        if (!slotPres) {
          return "";
        }
        return sanitizeSpreadsheetText(`${slotPres.slotTitle}: ${slotPres.summaryText}`);
      });

      detailSheet.addRow([
        day.business_date,
        sanitizeSpreadsheetText(resolvedIdentity.displayName),
        sanitizeSpreadsheetText(resolvedIdentity.personnelCode ?? ""),
        sanitizeSpreadsheetText(emp.branch?.display_name ?? "Mặc định (HQ)"),
        presentation.statusLabel,
        sanitizeSpreadsheetText(
          `${presentation.policyProfileNameUsed} (v${presentation.policyVersionUsed})`,
        ),
        presentation.slots.length,
        ...dynamicSlotCells,
        presentation.missingSlotCount,
        presentation.lateOrEarlyCheckinCount,
        day.first_time_local ?? "",
        day.last_time_local ?? "",
        day.checkin_count,
        sanitizeSpreadsheetText(targetLabel),
        day.distance_status ?? "",
        day.distance_meters !== null ? day.distance_meters : "",
        sanitizeSpreadsheetText(formatMatrixLeaveSummary(day)),
        day.approved_leave_units > 0 ? day.approved_leave_units : "",
        sanitizeSpreadsheetText(formatMatrixExplanationSummary(day)),
      ]);
    }
  }

  const legendSheet = workbook.addWorksheet("Chú giải & Khung giờ");
  legendSheet.addRow(["CHÚ GIẢI MÀU SẮC, TRẠNG THÁI & QUY TẮC KHUNG GIỜ CHẤM CÔNG"]);
  legendSheet.getRow(1).font = { bold: true, size: 12 };
  legendSheet.addRow([]);
  legendSheet.addRow(["Nhãn trạng thái", "Ý nghĩa hiển thị", "Quy tắc rà soát cho HR HRP"]);
  legendSheet.getRow(3).font = { bold: true };
  for (const item of MATRIX_LEGEND_ITEMS) {
    legendSheet.addRow([item.badgeText, item.title, item.description]);
  }
  legendSheet.addRow([
    "Quy tắc gán mốc & tie-break",
    "Gán mọi lượt chấm về mốc gần nhất theo khoảng cách phút",
    "Không bỏ lượt chấm dư: nhiều lượt cùng gần 1 mốc sẽ hiển thị đầy đủ theo thứ tự tăng dần. Khi khoảng cách phút bằng nhau giữa 2 mốc liền kề, hệ thống cố định gán về mốc sớm hơn theo thứ tự cấu hình.",
  ]);

  legendSheet.addRow([]);
  legendSheet.addRow(["CẤU HÌNH KHUNG GIỜ ÁP DỤNG TRONG THÁNG BÁO CÁO"]);
  const policyHeaderRowIdx = legendSheet.rowCount;
  legendSheet.getRow(policyHeaderRowIdx).font = { bold: true };

  const policySlotHeaders = Array.from({ length: detailSlotCount }, (_, idx) => `Mốc ${idx + 1}`);

  legendSheet.addRow([
    "Tên cấu hình",
    "Mã cấu hình",
    "Phiên bản",
    "Hiệu lực từ ngày",
    "Hiệu lực đến ngày",
    "Số mốc",
    ...policySlotHeaders,
    "Người cấu hình",
  ]);
  legendSheet.getRow(legendSheet.rowCount).font = { bold: true };

  for (const pol of collectedMonthPolicies) {
    const slotConfigCells = Array.from({ length: detailSlotCount }, (_, idx) => {
      const s = pol.slots[idx];
      if (!s) return "—";
      const labelPrefix = s.slot_label ? `${s.slot_label}: ` : "";
      return `${labelPrefix}${s.target_time} (-${s.grace_before_minutes}p / +${s.grace_after_minutes}p)`;
    });
    legendSheet.addRow([
      sanitizeSpreadsheetText(pol.profile_name || DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_NAME),
      sanitizeSpreadsheetText(pol.profile_code || DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_CODE),
      `v${pol.version}`,
      pol.effective_from_date,
      pol.effective_to_date ?? "Đang mở",
      pol.slots.length,
      ...slotConfigCells,
      sanitizeSpreadsheetText(pol.configured_by_display_name),
    ]);
  }

  const totalLegendCols = 7 + detailSlotCount;
  for (let col = 1; col <= totalLegendCols; col += 1) {
    legendSheet.getColumn(col).width = col === 3 ? 65 : 26;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export type AttendanceMonthlyMatrixExportSummary = Pick<
  AttendanceMonthlyMatrixReportProjection,
  "filters" | "calendar_days" | "items"
>;
