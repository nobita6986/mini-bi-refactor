export const LEAVE_EXPORT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const LEAVE_EXPORT_COLUMNS = [
  { key: "personnel_code", header: "Mã nhân sự", width: 16 },
  { key: "display_name", header: "Họ và tên", width: 26 },
  { key: "login_id", header: "Tài khoản", width: 18 },
  { key: "unit_kind", header: "Khối / Bộ phận", width: 18 },
  { key: "team_name", header: "Nhóm (Team)", width: 22 },
  { key: "employment_status", header: "Trạng thái nhân sự", width: 20 },
  { key: "work_start_date", header: "Ngày vào làm", width: 16 },
  { key: "official_effective_date", header: "Ngày lên chính thức", width: 18 },
  { key: "attendance_day_count", header: "Số ngày chấm công", width: 18 },
  { key: "attendance_dates", header: "Ngày chấm công trong tháng", width: 34 },
  {
    key: "leave_days_detail",
    header: "Chi tiết ngày nghỉ, loại nghỉ & buổi nghỉ",
    width: 44,
  },
  {
    key: "month_annual_leave_days",
    header: "Phép năm trong tháng (ngày)",
    width: 24,
  },
  {
    key: "month_bereavement_leave_days",
    header: "Nghỉ tang trong tháng (ngày)",
    width: 24,
  },
  {
    key: "month_marriage_leave_days",
    header: "Nghỉ cưới trong tháng (ngày)",
    width: 24,
  },
  {
    key: "month_sick_leave_days",
    header: "Nghỉ ốm trong tháng (ngày)",
    width: 22,
  },
  {
    key: "month_unpaid_leave_days",
    header: "Nghỉ không lương trong tháng (ngày)",
    width: 28,
  },
  {
    key: "month_pending_days",
    header: "Đang chờ duyệt trong tháng (ngày)",
    width: 26,
  },
  {
    key: "carry_over_granted_days",
    header: "Phép năm trước chuyển sang (ngày)",
    width: 28,
  },
  {
    key: "monthly_accrued_days",
    header: "Phép tích lũy trong năm (ngày)",
    width: 26,
  },
  {
    key: "seniority_granted_days",
    header: "Phép thâm niên (ngày)",
    width: 22,
  },
  {
    key: "consumed_days",
    header: "Phép năm đã dùng trong năm (ngày)",
    width: 26,
  },
  {
    key: "reserved_days",
    header: "Phép năm giữ chỗ (ngày)",
    width: 24,
  },
  {
    key: "expired_days",
    header: "Phép chuyển năm hết hạn (ngày)",
    width: 28,
  },
  {
    key: "available_days",
    header: "Số dư phép năm khả dụng (ngày)",
    width: 26,
  },
] as const;

export const LEAVE_EXPORT_DETAIL_COLUMNS = [
  { key: "personnel_code", header: "Mã nhân sự", width: 16 },
  { key: "display_name", header: "Họ và tên", width: 26 },
  { key: "login_id", header: "Tài khoản", width: 18 },
  { key: "unit_kind", header: "Khối / Bộ phận", width: 18 },
  { key: "team_name", header: "Nhóm (Team)", width: 22 },
  { key: "date", header: "Ngày", width: 16 },
  { key: "has_attendance", header: "Chấm công", width: 16 },
  { key: "checkin_count", header: "Số lần check-in", width: 16 },
  { key: "leave_type", header: "Loại nghỉ", width: 22 },
  { key: "session_label", header: "Buổi nghỉ", width: 18 },
  { key: "leave_days", header: "Số ngày nghỉ", width: 16 },
  { key: "leave_status", header: "Trạng thái đơn nghỉ", width: 20 },
] as const;

function formatHalfDayUnitsAsDays(units: unknown): string {
  const n = Number(units ?? 0);
  if (!Number.isFinite(n)) return "0";
  const days = n / 2;
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

function safeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function formatExportLeaveTypeLabel(value: unknown): string {
  const code = safeText(value).trim().toUpperCase();
  switch (code) {
    case "ANNUAL":
      return "Phép năm";
    case "BEREAVEMENT":
      return "Nghỉ tang";
    case "MARRIAGE":
      return "Nghỉ cưới";
    case "SICK":
      return "Nghỉ ốm";
    case "UNPAID":
      return "Nghỉ không lương";
    default:
      return code;
  }
}

export function formatExportSessionLabel(value: unknown): string {
  const code = safeText(value).trim().toUpperCase();
  switch (code) {
    case "FULL":
      return "Cả ngày";
    case "AM":
      return "Buổi sáng";
    case "PM":
      return "Buổi chiều";
    default:
      return code;
  }
}

function extractAttendanceDates(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.attendance_dates)) {
    return row.attendance_dates
      .map((item) => safeText(item).trim())
      .filter((item) => item.length > 0);
  }
  if (Array.isArray(row.attendance_days)) {
    return row.attendance_days
      .map((item) =>
        item && typeof item === "object"
          ? safeText((item as Record<string, unknown>).business_date).trim()
          : "",
      )
      .filter((item) => item.length > 0);
  }
  return [];
}

type NormalizedLeaveDayEntry = {
  leave_date: string;
  session_code: string;
  leave_type: string;
  half_day_units: number;
};

function extractLeaveDayEntries(rawList: unknown): NormalizedLeaveDayEntry[] {
  if (!Array.isArray(rawList)) return [];
  const entries: NormalizedLeaveDayEntry[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const leaveDate = safeText(rec.leave_date).trim();
    const sessionCode = safeText(rec.session_code).trim().toUpperCase();
    const leaveType = safeText(rec.leave_type || "ANNUAL")
      .trim()
      .toUpperCase();
    const units = Number(
      rec.half_day_units ?? (sessionCode === "FULL" ? 2 : 1),
    );
    if (!leaveDate) continue;
    entries.push({
      leave_date: leaveDate,
      session_code: sessionCode || "FULL",
      leave_type: leaveType || "ANNUAL",
      half_day_units: Number.isFinite(units) && units > 0 ? units : 1,
    });
  }
  return entries;
}

export function formatLeaveDaysSummaryText(
  entries: readonly NormalizedLeaveDayEntry[],
): string {
  if (entries.length === 0) return "";
  return entries
    .map(
      (entry) =>
        `${entry.leave_date}: ${formatExportLeaveTypeLabel(entry.leave_type)} (${formatExportSessionLabel(entry.session_code)})`,
    )
    .join("; ");
}

export function leaveMonthlyReportFilename(yearMonth: string): string {
  const safe = /^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)
    ? yearMonth
    : new Date().toISOString().slice(0, 7);
  return `bao-cao-nghi-phep-thang-${safe}.xlsx`;
}

export async function buildLeaveMonthlyReportXlsx(
  reportPayload: Record<string, unknown>,
): Promise<Uint8Array> {
  const imported = await import("exceljs");
  const excel = imported.default;
  const workbook = new excel.Workbook();
  workbook.creator = "Mini BI - Leave Management";

  const yearMonth = safeText(reportPayload.year_month || "");
  const sheet = workbook.addWorksheet(`Nghỉ phép ${yearMonth || "Tháng"}`);
  sheet.addRow(LEAVE_EXPORT_COLUMNS.map((c) => c.header));
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 1; i <= LEAVE_EXPORT_COLUMNS.length; i += 1) {
    sheet.getColumn(i).width = LEAVE_EXPORT_COLUMNS[i - 1].width;
    sheet.getRow(1).getCell(i).font = { bold: true };
  }

  const detailSheet = workbook.addWorksheet("Chi tiết ngày công & nghỉ");
  detailSheet.addRow(LEAVE_EXPORT_DETAIL_COLUMNS.map((c) => c.header));
  detailSheet.views = [{ state: "frozen", ySplit: 1 }];

  for (let i = 1; i <= LEAVE_EXPORT_DETAIL_COLUMNS.length; i += 1) {
    detailSheet.getColumn(i).width = LEAVE_EXPORT_DETAIL_COLUMNS[i - 1].width;
    detailSheet.getRow(1).getCell(i).font = { bold: true };
  }

  const rawRows = Array.isArray(reportPayload.rows) ? reportPayload.rows : [];
  for (const rawRow of rawRows) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const row = rawRow as Record<string, unknown>;
    const account =
      row.account && typeof row.account === "object"
        ? (row.account as Record<string, unknown>)
        : {};
    const routing =
      row.routing && typeof row.routing === "object"
        ? (row.routing as Record<string, unknown>)
        : {};
    const balance =
      row.balance && typeof row.balance === "object"
        ? (row.balance as Record<string, unknown>)
        : {};

    const attendanceDates = extractAttendanceDates(row);
    const attendanceCount =
      row.attendance_day_count !== undefined &&
      row.attendance_day_count !== null
        ? Number(row.attendance_day_count)
        : attendanceDates.length;
    const approvedLeaveDays = extractLeaveDayEntries(row.leave_days);
    const pendingLeaveDays = extractLeaveDayEntries(row.pending_leave_days);

    const orgDept =
      row.org_department && typeof row.org_department === "object"
        ? (row.org_department as Record<string, unknown>)
        : null;
    const personnelCode = safeText(account.personnel_code);
    const displayName = safeText(account.display_name);
    const loginId = safeText(account.login_id);
    const unitKind =
      safeText(orgDept?.department_name).trim() ||
      safeText(orgDept?.department_code).trim() ||
      safeText(row.unit_kind);
    const teamName = safeText(routing.team_name ?? routing.team_code);

    const values = [
      personnelCode,
      displayName,
      loginId,
      unitKind,
      teamName,
      safeText(row.employment_status),
      safeText(row.work_start_date),
      safeText(row.official_effective_date),
      String(Number.isFinite(attendanceCount) ? attendanceCount : 0),
      attendanceDates.join(", "),
      formatLeaveDaysSummaryText(approvedLeaveDays),
      formatHalfDayUnitsAsDays(row.month_annual_leave_units),
      formatHalfDayUnitsAsDays(row.month_bereavement_leave_units),
      formatHalfDayUnitsAsDays(row.month_marriage_leave_units),
      formatHalfDayUnitsAsDays(row.month_sick_leave_units),
      formatHalfDayUnitsAsDays(row.month_unpaid_leave_units),
      formatHalfDayUnitsAsDays(row.month_pending_units),
      formatHalfDayUnitsAsDays(balance.carry_over_granted_units),
      formatHalfDayUnitsAsDays(balance.monthly_accrued_units),
      formatHalfDayUnitsAsDays(balance.seniority_granted_units),
      formatHalfDayUnitsAsDays(balance.consumed_units),
      formatHalfDayUnitsAsDays(balance.reserved_units),
      formatHalfDayUnitsAsDays(balance.expired_units),
      formatHalfDayUnitsAsDays(balance.available_units),
    ];

    const added = sheet.addRow(values);
    for (let i = 1; i <= values.length; i += 1) {
      added.getCell(i).numFmt = "@";
    }

    const checkinCountByDate = new Map<string, number>();
    if (Array.isArray(row.attendance_days)) {
      for (const attItem of row.attendance_days) {
        if (!attItem || typeof attItem !== "object") continue;
        const attRec = attItem as Record<string, unknown>;
        const d = safeText(attRec.business_date).trim();
        const c = Number(attRec.checkin_count ?? 1);
        if (d) {
          checkinCountByDate.set(d, Number.isFinite(c) && c > 0 ? c : 1);
        }
      }
    }
    for (const d of attendanceDates) {
      if (!checkinCountByDate.has(d)) {
        checkinCountByDate.set(d, 1);
      }
    }

    const leaveDatesSet = new Set<string>();
    for (const leaveEntry of approvedLeaveDays) {
      leaveDatesSet.add(leaveEntry.leave_date);
      const hasAtt = checkinCountByDate.has(leaveEntry.leave_date);
      const detailValues = [
        personnelCode,
        displayName,
        loginId,
        unitKind,
        teamName,
        leaveEntry.leave_date,
        hasAtt ? "Có chấm công" : "",
        hasAtt ? String(checkinCountByDate.get(leaveEntry.leave_date) ?? 1) : "0",
        formatExportLeaveTypeLabel(leaveEntry.leave_type),
        formatExportSessionLabel(leaveEntry.session_code),
        formatHalfDayUnitsAsDays(leaveEntry.half_day_units),
        "Đã duyệt",
      ];
      const detailAdded = detailSheet.addRow(detailValues);
      for (let i = 1; i <= detailValues.length; i += 1) {
        detailAdded.getCell(i).numFmt = "@";
      }
    }

    for (const pendingEntry of pendingLeaveDays) {
      leaveDatesSet.add(pendingEntry.leave_date);
      const hasAtt = checkinCountByDate.has(pendingEntry.leave_date);
      const detailValues = [
        personnelCode,
        displayName,
        loginId,
        unitKind,
        teamName,
        pendingEntry.leave_date,
        hasAtt ? "Có chấm công" : "",
        hasAtt ? String(checkinCountByDate.get(pendingEntry.leave_date) ?? 1) : "0",
        formatExportLeaveTypeLabel(pendingEntry.leave_type),
        formatExportSessionLabel(pendingEntry.session_code),
        formatHalfDayUnitsAsDays(pendingEntry.half_day_units),
        "Chờ duyệt",
      ];
      const detailAdded = detailSheet.addRow(detailValues);
      for (let i = 1; i <= detailValues.length; i += 1) {
        detailAdded.getCell(i).numFmt = "@";
      }
    }

    for (const attDate of attendanceDates) {
      if (leaveDatesSet.has(attDate)) continue;
      const detailValues = [
        personnelCode,
        displayName,
        loginId,
        unitKind,
        teamName,
        attDate,
        "Có chấm công",
        String(checkinCountByDate.get(attDate) ?? 1),
        "",
        "",
        "0",
        "",
      ];
      const detailAdded = detailSheet.addRow(detailValues);
      for (let i = 1; i <= detailValues.length; i += 1) {
        detailAdded.getCell(i).numFmt = "@";
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
