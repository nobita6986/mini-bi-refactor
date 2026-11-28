/**
 * Detailed Recruitment Matrix ("Báo cáo chi tiết") — Pure domain & aggregation module.
 *
 * Aggregates recruitment facts `(business_date, recruiter_key, recruited_count)` with the
 * personnel/team catalog on the server to produce a 2D recruiter × time-bucket matrix
 * (`Ngày` / `Tuần` / `Tháng`), preserving 100% parity with Dashboard totals and
 * `TrendChart` bucket boundaries.
 */

import { buildDailyTrend } from "./p1-dashboard.ts";
import {
  aggregateDailyTrendPoints,
  TREND_RESOLUTION_OPTIONS,
  type TrendBucketPoint,
  type TrendResolution,
} from "./p1-dashboard-period.ts";
import { isRealCalendarDate, type ReportingFilters } from "./p1-filter.ts";
import {
  matchesReportingFilters,
  resolveFactRecruitmentChannel,
  selectDisplay,
  type ReportingFact,
} from "./p1-reporting.ts";
import { P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";

export const ALL_RECRUITERS_TEAM_FILTER = "all";

export const DETAILED_MATRIX_ZOOM_MIN = 70;
export const DETAILED_MATRIX_ZOOM_MAX = 130;
export const DETAILED_MATRIX_ZOOM_STEP = 10;
export const DETAILED_MATRIX_ZOOM_DEFAULT = 100;

export const DETAILED_MATRIX_STT_COL_WIDTH_PX = 36;
export const DETAILED_MATRIX_NAME_COL_WIDTH_PX = 200;
export const DETAILED_MATRIX_FIXED_FONT_SIZE_PX = 12;
export const DETAILED_MATRIX_FIXED_CELL_PAD_X_PX = 6;
export const DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX = 6;
export const DETAILED_MATRIX_FIXED_NAME_PAD_X_PX = 10;

export type DetailedMatrixTeamOption = {
  teamId: string;
  teamCode: string;
  displayName: string;
  memberCount: number;
};

export type DetailedMatrixTeamDropdownOption = {
  value: string;
  label: string;
};

export type DetailedMatrixZoomMetrics = {
  zoomPercent: number;
  zoomScale: number;
  sttColWidthPx: number;
  nameColWidthPx: number;
  nameMinWidthPx: number;
  nameMaxWidthPx: number;
  fixedFontSizePx: number;
  fixedCellPadXPx: number;
  fixedCellPadYPx: number;
  fixedNamePadXPx: number;
  bucketMinWidthPx: number;
  totalColMinWidthPx: number;
  metricFontSizePx: number;
  cellPadXPx: number;
  cellPadYPx: number;
  totalCellPadXPx: number;
};

export type DetailedMatrixCatalogRecruiter = {
  recruiterId: string;
  recruiterKey: string;
  displayName: string;
  personnelCode: string | null;
  active: boolean;
  isActiveHrp: boolean;
  currentTeamIds: string[];
  workStartDate: string | null;
};

export type DetailedMatrixCatalog = {
  teams: Array<{
    teamId: string;
    teamCode: string;
    displayName: string;
  }>;
  recruiters: DetailedMatrixCatalogRecruiter[];
};

export type DetailedMatrixRecruiterRow = {
  stt: number;
  recruiterId: string;
  recruiterKey: string;
  displayName: string;
  personnelCode: string | null;
  workStartDate: string | null;
  workMonths: number | null;
  counts: number[];
  ctvCounts: number[];
  total: number;
  ctvTotal: number;
};

export type DetailedRecruitmentMatrixReport = {
  resolution: TrendResolution;
  selectedTeamId: string;
  asOfDate: string | null;
  fromDate: string | null;
  toDate: string | null;
  teams: DetailedMatrixTeamOption[];
  buckets: TrendBucketPoint[];
  rows: DetailedMatrixRecruiterRow[];
  columnTotals: number[];
  columnCtvTotals: number[];
  grandTotal: number;
  grandCtvTotal: number;
};

function normalizeKey(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function daysInCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseYmdParts(
  ymd: string | null | undefined,
): { year: number; month: number; day: number; normalized: string } | null {
  if (typeof ymd !== "string") return null;
  const trimmed = ymd.trim();
  if (!isRealCalendarDate(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  return { year: y, month: m, day: d, normalized: trimmed };
}

/**
 * Computes the number of completed calendar months from `workStartDate` (`YYYY-MM-DD`)
 * up to `asOfDate` (`YYYY-MM-DD`, the end date of the active report period).
 *
 * Rules:
 * - Returns `null` when `workStartDate` or `asOfDate` is missing/invalid, or when
 *   `workStartDate > asOfDate` (not yet started as of the report end date).
 * - Uses completed calendar months with end-of-month clamping matching PostgreSQL
 *   date + interval semantics (e.g. `2024-01-31` -> `2024-02-29` = 1 month in leap year;
 *   `2025-01-31` -> `2025-02-28` = 1 month in non-leap year; `2024-02-29` -> `2025-02-28` = 12 months).
 */
export function computeCompletedWorkMonths(
  workStartDate: string | null | undefined,
  asOfDate: string | null | undefined,
): number | null {
  const start = parseYmdParts(workStartDate);
  const end = parseYmdParts(asOfDate);
  if (!start || !end) return null;
  if (start.normalized > end.normalized) return null;

  const rawMonths = (end.year - start.year) * 12 + (end.month - start.month);
  const anniversaryDayInEndMonth = Math.min(
    start.day,
    daysInCalendarMonth(end.year, end.month),
  );
  const completedMonths =
    end.day >= anniversaryDayInEndMonth ? rawMonths : rawMonths - 1;
  return Math.max(0, completedMonths);
}

/**
 * Formats `workMonths` for table display (`"-"` when unconfigured or unavailable).
 */
export function formatWorkMonthsCell(
  workMonths: number | null | undefined,
): string {
  if (
    typeof workMonths === "number" &&
    Number.isFinite(workMonths) &&
    workMonths >= 0
  ) {
    return String(Math.trunc(workMonths));
  }
  return "-";
}

/**
 * Formats canonical `personnelCode` from the personnel catalog (`"-"` when missing).
 * Never fabricates or infers a code from `displayName`.
 */
export function formatPersonnelCodeCell(
  personnelCode: string | null | undefined,
): string {
  if (typeof personnelCode !== "string") return "-";
  const trimmed = personnelCode.trim();
  return trimmed.length > 0 ? trimmed : "-";
}

export function clampDetailedMatrixZoom(value: number): number {
  if (!Number.isFinite(value)) return DETAILED_MATRIX_ZOOM_DEFAULT;
  const stepped =
    Math.round(value / DETAILED_MATRIX_ZOOM_STEP) * DETAILED_MATRIX_ZOOM_STEP;
  return Math.min(
    DETAILED_MATRIX_ZOOM_MAX,
    Math.max(DETAILED_MATRIX_ZOOM_MIN, stepped),
  );
}

/**
 * Computes zoom layout metrics for `DetailedRecruitmentMatrixPanel`:
 * - Fixed columns (`STT`, `Họ tên`): width, padding, font-size, and sticky offsets remain invariant.
 * - Metric columns (time buckets + `Tổng`): width, padding, and font-size scale with `zoomPercent`.
 */
export function computeDetailedMatrixZoomMetrics(
  zoomPercent: number,
  resolution: TrendResolution,
): DetailedMatrixZoomMetrics {
  const clampedZoom = clampDetailedMatrixZoom(zoomPercent);
  const zoomScale = clampedZoom / 100;
  const baseBucketWidth = resolution === "week" ? 68 : 42;
  const minBucketFloor = resolution === "week" ? 44 : 26;

  return {
    zoomPercent: clampedZoom,
    zoomScale,
    sttColWidthPx: DETAILED_MATRIX_STT_COL_WIDTH_PX,
    nameColWidthPx: DETAILED_MATRIX_NAME_COL_WIDTH_PX,
    nameMinWidthPx: DETAILED_MATRIX_NAME_COL_WIDTH_PX,
    nameMaxWidthPx: DETAILED_MATRIX_NAME_COL_WIDTH_PX,
    fixedFontSizePx: DETAILED_MATRIX_FIXED_FONT_SIZE_PX,
    fixedCellPadXPx: DETAILED_MATRIX_FIXED_CELL_PAD_X_PX,
    fixedCellPadYPx: DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX,
    fixedNamePadXPx: DETAILED_MATRIX_FIXED_NAME_PAD_X_PX,
    bucketMinWidthPx: Math.max(
      minBucketFloor,
      Math.round(baseBucketWidth * zoomScale),
    ),
    totalColMinWidthPx: Math.max(42, Math.round(64 * zoomScale)),
    metricFontSizePx: Math.round(12 * zoomScale * 10) / 10,
    cellPadXPx: Math.max(2, Math.round(6 * zoomScale)),
    cellPadYPx: Math.max(2, Math.round(6 * zoomScale)),
    totalCellPadXPx: Math.max(4, Math.round(9 * zoomScale)),
  };
}

function normalizeTeamToken(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFC")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isMarketingHrpTeamOption(
  team: Pick<DetailedMatrixTeamOption, "displayName" | "teamCode">,
): boolean {
  return (
    normalizeTeamToken(team.displayName) === "marketing hrp" ||
    normalizeTeamToken(team.teamCode) === "marketing hrp"
  );
}

/**
 * Sắp xếp danh sách nhóm trong dropdown `Người tuyển / Nhóm`:
 * - `"Marketing HRP"` luôn nằm cuối danh sách các nhóm.
 * - Giữ nguyên thứ tự tương đối của những nhóm còn lại.
 */
export function sortDetailedMatrixTeamOptions<
  T extends Pick<DetailedMatrixTeamOption, "displayName" | "teamCode">,
>(teams: readonly T[]): T[] {
  const regularTeams: T[] = [];
  const marketingHrpTeams: T[] = [];
  for (const team of teams) {
    if (isMarketingHrpTeamOption(team)) {
      marketingHrpTeams.push(team);
    } else {
      regularTeams.push(team);
    }
  }
  return [...regularTeams, ...marketingHrpTeams];
}

/**
 * Tạo danh sách lựa chọn cho dropdown `Người tuyển / Nhóm`:
 * - `"Tất cả người tuyển"` luôn đứng đầu tiên.
 * - Các nhóm tiếp theo giữ nguyên thứ tự tương đối, riêng `"Marketing HRP"` luôn đứng cuối.
 */
export function buildDetailedMatrixTeamDropdownOptions(
  teams: readonly DetailedMatrixTeamOption[],
): DetailedMatrixTeamDropdownOption[] {
  const sortedTeams = sortDetailedMatrixTeamOptions(teams);
  return [
    {
      value: ALL_RECRUITERS_TEAM_FILTER,
      label: "Tất cả người tuyển",
    },
    ...sortedTeams.map((team) => ({
      value: team.teamId,
      label: `${team.displayName} (${team.memberCount})`,
    })),
  ];
}

export function isMatrixResolution(value: string): value is TrendResolution {
  return TREND_RESOLUTION_OPTIONS.some((opt) => opt.key === value);
}

export function parseMatrixResolutionParam(
  raw: string | string[] | undefined,
): TrendResolution | null {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (val === undefined || val.trim() === "") return "day";
  const normalized = val.trim();
  return isMatrixResolution(normalized) ? normalized : null;
}

/**
 * Chỉ hiển thị chú thích trong ngoặc `(ctv)` khi đang xem `Tổng tuyển của NVTD` (`hrp`).
 * Khi xem `Qua CTV` (`hrp_ctv`), `HRP trực tiếp` (`hrp_direct`) hoặc `Vendor`, không hiển thị ngoặc.
 */
export function canShowDetailedMatrixCtvBreakdown(provider: string): boolean {
  return provider === "hrp";
}

/**
 * Format số hiển thị cho ô / cột Tổng / dòng Tổng cộng trên Báo cáo chi tiết.
 * Khi checkbox `Hiện số tuyển qua CTV` bật và đang xem `Tổng tuyển của NVTD` (`hrp`),
 * hiển thị `<total> (<ctv>)` nếu `total > 0 && ctv > 0`, ngược lại chỉ hiển thị `<total>`.
 */
export function formatDetailedMatrixMetricCell(
  total: number,
  ctvCount: number | undefined,
  options: { showCtv: boolean; provider: string },
): string {
  if (!options.showCtv || !canShowDetailedMatrixCtvBreakdown(options.provider)) {
    return String(total);
  }
  const ctv =
    typeof ctvCount === "number" && Number.isFinite(ctvCount) ? ctvCount : 0;
  if (total > 0 && ctv > 0) {
    return `${total} (${ctv})`;
  }
  return String(total);
}

/**
 * Mirrors the exact row-level filter rules of `computeScopedReportingData` + `computeReporting`
 * in `p2-w04a-reporting-server.ts` / `p1-reporting.ts`.
 */
export function matchesDashboardReportingFact(
  fact: ReportingFact,
  filters: ReportingFilters,
): boolean {
  if (
    fact.source_id &&
    fact.source_id !== P2_W04A_DIRECT_ENTRY_SOURCE_ID &&
    filters.source !== fact.source_id
  ) {
    return false;
  }
  return matchesReportingFilters(fact, filters);
}

export function buildDetailedMatrixBuckets(
  fromDate: string | undefined,
  toDate: string | undefined,
  factByDate: Record<string, number>,
  resolution: TrendResolution,
): {
  fromDate: string | null;
  toDate: string | null;
  buckets: TrendBucketPoint[];
  dateToBucketIndex: Map<string, number>;
} {
  const sortedFactDates = Object.keys(factByDate)
    .filter((d) => isRealCalendarDate(d))
    .sort();
  const effectiveFrom = fromDate ?? sortedFactDates[0] ?? null;
  const effectiveTo =
    toDate ?? sortedFactDates[sortedFactDates.length - 1] ?? null;

  if (!effectiveFrom || !effectiveTo || effectiveFrom > effectiveTo) {
    return {
      fromDate: effectiveFrom,
      toDate: effectiveTo,
      buckets: [],
      dateToBucketIndex: new Map(),
    };
  }

  const dailyPoints = buildDailyTrend(factByDate, effectiveFrom, effectiveTo);
  const buckets = aggregateDailyTrendPoints(dailyPoints, resolution, {
    from: effectiveFrom,
    to: effectiveTo,
  }).map((b) => ({
    ...b,
    count: 0,
  }));

  const dateToBucketIndex = new Map<string, number>();
  let bucketCursor = 0;
  for (const pt of dailyPoints) {
    while (
      bucketCursor < buckets.length &&
      pt.date > buckets[bucketCursor].endDate
    ) {
      bucketCursor += 1;
    }
    if (
      bucketCursor < buckets.length &&
      pt.date >= buckets[bucketCursor].startDate &&
      pt.date <= buckets[bucketCursor].endDate
    ) {
      dateToBucketIndex.set(pt.date, bucketCursor);
    }
  }

  return {
    fromDate: effectiveFrom,
    toDate: effectiveTo,
    buckets,
    dateToBucketIndex,
  };
}

export function buildDetailedRecruitmentMatrix(input: {
  facts: readonly ReportingFact[];
  catalog: DetailedMatrixCatalog;
  filters: ReportingFilters;
  resolution: TrendResolution;
  teamId?: string | null;
  fallbackAsOfDate?: string | null;
}): DetailedRecruitmentMatrixReport {
  const { facts, catalog, filters, resolution } = input;
  const rawTeamId =
    typeof input.teamId === "string" && input.teamId.trim().length > 0
      ? input.teamId.trim()
      : ALL_RECRUITERS_TEAM_FILTER;

  // 1. Single-pass filter and accumulation of total & CTV counts by (recruiter_key, business_date).
  const factsByRecruiterAndDate = new Map<
    string,
    Map<string, { total: number; ctv: number }>
  >();
  const displayCountsByRecruiterKey = new Map<string, Map<string, number>>();
  const matchedFactByDate: Record<string, number> = {};

  for (const row of facts) {
    if (!matchesDashboardReportingFact(row, filters)) continue;
    if (!row.business_date || !isRealCalendarDate(row.business_date)) continue;

    matchedFactByDate[row.business_date] =
      (matchedFactByDate[row.business_date] ?? 0) + row.recruited_count;

    const ctvIncrement =
      resolveFactRecruitmentChannel(row) === "hrp_ctv" ? row.recruited_count : 0;

    const rKey = row.recruiter_key;
    let dispMap = displayCountsByRecruiterKey.get(rKey);
    if (!dispMap) {
      dispMap = new Map<string, number>();
      displayCountsByRecruiterKey.set(rKey, dispMap);
    }
    dispMap.set(
      row.recruiter_display,
      (dispMap.get(row.recruiter_display) ?? 0) + row.recruited_count,
    );

    let dateMap = factsByRecruiterAndDate.get(rKey);
    if (!dateMap) {
      dateMap = new Map<string, { total: number; ctv: number }>();
      factsByRecruiterAndDate.set(rKey, dateMap);
    }
    const existing = dateMap.get(row.business_date);
    if (existing) {
      existing.total += row.recruited_count;
      existing.ctv += ctvIncrement;
    } else {
      dateMap.set(row.business_date, {
        total: row.recruited_count,
        ctv: ctvIncrement,
      });
    }
  }

  // 2. Build time buckets (day / week / month) identical to TrendChart.
  const {
    fromDate: effectiveFromDate,
    toDate: effectiveToDate,
    buckets: baseBuckets,
    dateToBucketIndex,
  } = buildDetailedMatrixBuckets(
    filters.from,
    filters.to,
    matchedFactByDate,
    resolution,
  );

  const asOfDate =
    filters.to ??
    effectiveToDate ??
    (typeof input.fallbackAsOfDate === "string" &&
    isRealCalendarDate(input.fallbackAsOfDate)
      ? input.fallbackAsOfDate
      : null);

  // 3. Build team options with current active member counts.
  const activeCatalogRecruiters = catalog.recruiters.filter(
    (r) => r.active && (r.isActiveHrp || r.currentTeamIds.length > 0),
  );
  const memberCountByTeamId = new Map<string, number>();
  for (const rec of activeCatalogRecruiters) {
    for (const tId of rec.currentTeamIds) {
      memberCountByTeamId.set(tId, (memberCountByTeamId.get(tId) ?? 0) + 1);
    }
  }

  const teams: DetailedMatrixTeamOption[] = sortDetailedMatrixTeamOptions(
    [...catalog.teams]
      .map((t) => ({
        teamId: t.teamId,
        teamCode: t.teamCode,
        displayName: t.displayName,
        memberCount: memberCountByTeamId.get(t.teamId) ?? 0,
      }))
      .sort((a, b) => {
        const cmp = a.displayName.localeCompare(b.displayName, "vi");
        return cmp !== 0 ? cmp : a.teamId.localeCompare(b.teamId);
      }),
  );

  // Lookup primary catalog entry per recruiterKey
  const primaryCatalogByRecruiterKey = new Map<
    string,
    DetailedMatrixCatalogRecruiter
  >();
  for (const rec of catalog.recruiters) {
    const key = normalizeKey(rec.recruiterKey || rec.displayName);
    if (key && !primaryCatalogByRecruiterKey.has(key)) {
      primaryCatalogByRecruiterKey.set(key, rec);
    }
  }

  function computeBucketCounts(
    recruiterKey: string,
    consumeFacts: boolean,
  ): { counts: number[]; ctvCounts: number[]; total: number; ctvTotal: number } {
    const counts = new Array<number>(baseBuckets.length).fill(0);
    const ctvCounts = new Array<number>(baseBuckets.length).fill(0);
    let total = 0;
    let ctvTotal = 0;
    if (!consumeFacts) return { counts, ctvCounts, total, ctvTotal };

    const dateMap = factsByRecruiterAndDate.get(recruiterKey);
    if (!dateMap) return { counts, ctvCounts, total, ctvTotal };

    for (const [date, entry] of dateMap.entries()) {
      const bucketIdx = dateToBucketIndex.get(date);
      if (bucketIdx !== undefined) {
        counts[bucketIdx] += entry.total;
        ctvCounts[bucketIdx] += entry.ctv;
        total += entry.total;
        ctvTotal += entry.ctv;
      }
    }
    return { counts, ctvCounts, total, ctvTotal };
  }

  // 4. Build candidate rows depending on `rawTeamId`.
  const consumedFactKeys = new Set<string>();
  const unsortedRows: Array<Omit<DetailedMatrixRecruiterRow, "stt">> = [];

  if (rawTeamId !== ALL_RECRUITERS_TEAM_FILTER) {
    // Specific team selected: include ONLY current members of that team.
    const teamMembers = activeCatalogRecruiters.filter((r) => {
      const rKey = normalizeKey(r.recruiterKey || r.displayName);
      return (
        r.currentTeamIds.includes(rawTeamId) &&
        (!filters.recruiter || rKey === filters.recruiter)
      );
    });

    for (const member of teamMembers) {
      const rKey = normalizeKey(member.recruiterKey || member.displayName);
      const shouldConsume = !consumedFactKeys.has(rKey);
      if (shouldConsume) consumedFactKeys.add(rKey);
      const { counts, ctvCounts, total, ctvTotal } = computeBucketCounts(
        rKey,
        shouldConsume,
      );
      unsortedRows.push({
        recruiterId: member.recruiterId,
        recruiterKey: rKey,
        displayName: member.displayName,
        personnelCode: member.personnelCode,
        workStartDate: member.workStartDate,
        workMonths: computeCompletedWorkMonths(member.workStartDate, asOfDate),
        counts,
        ctvCounts,
        total,
        ctvTotal,
      });
    }
  } else {
    // "Tất cả người tuyển":
    // (a) Include all active HRP / team personnel from the catalog (with 0s when no facts in period).
    for (const rec of activeCatalogRecruiters) {
      const rKey = normalizeKey(rec.recruiterKey || rec.displayName);
      if (filters.recruiter && rKey !== filters.recruiter) continue;

      const shouldConsume = !consumedFactKeys.has(rKey);
      if (shouldConsume) consumedFactKeys.add(rKey);
      const { counts, ctvCounts, total, ctvTotal } = computeBucketCounts(
        rKey,
        shouldConsume,
      );
      unsortedRows.push({
        recruiterId: rec.recruiterId,
        recruiterKey: rKey,
        displayName: rec.displayName,
        personnelCode: rec.personnelCode,
        workStartDate: rec.workStartDate,
        workMonths: computeCompletedWorkMonths(rec.workStartDate, asOfDate),
        counts,
        ctvCounts,
        total,
        ctvTotal,
      });
    }

    // (b) Include any remaining recruiter keys that have matched facts in the period
    // (e.g. inactive recruiters with historical entries or vendor recruiter rows when not filtered out),
    // ensuring 100% row/column/grand total parity with Dashboard on the same filters.
    for (const [rKey] of factsByRecruiterAndDate.entries()) {
      if (consumedFactKeys.has(rKey)) continue;
      consumedFactKeys.add(rKey);

      const { counts, ctvCounts, total, ctvTotal } = computeBucketCounts(
        rKey,
        true,
      );
      if (total <= 0) continue;

      const catalogMatch = primaryCatalogByRecruiterKey.get(rKey);
      const dispMap = displayCountsByRecruiterKey.get(rKey);
      const displayName =
        catalogMatch?.displayName ??
        (dispMap ? selectDisplay(rKey, dispMap) : rKey);
      const personnelCode = catalogMatch?.personnelCode ?? null;
      const workStartDate = catalogMatch?.workStartDate ?? null;

      unsortedRows.push({
        recruiterId: catalogMatch?.recruiterId ?? `fact:${rKey}`,
        recruiterKey: rKey,
        displayName,
        personnelCode,
        workStartDate,
        workMonths: computeCompletedWorkMonths(workStartDate, asOfDate),
        counts,
        ctvCounts,
        total,
        ctvTotal,
      });
    }
  }

  // 5. Sort deterministically: total DESC, displayName ASC (vi), personnelCode ASC, recruiterId ASC.
  unsortedRows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const nameCmp = a.displayName.localeCompare(b.displayName, "vi");
    if (nameCmp !== 0) return nameCmp;
    const codeCmp = (a.personnelCode ?? "").localeCompare(
      b.personnelCode ?? "",
      "vi",
    );
    if (codeCmp !== 0) return codeCmp;
    return a.recruiterId.localeCompare(b.recruiterId);
  });

  const rows: DetailedMatrixRecruiterRow[] = unsortedRows.map((row, idx) => ({
    stt: idx + 1,
    ...row,
  }));

  // 6. Compute columnTotals, columnCtvTotals, grandTotal, grandCtvTotal, and populate bucket totals.
  const columnTotals = new Array<number>(baseBuckets.length).fill(0);
  const columnCtvTotals = new Array<number>(baseBuckets.length).fill(0);
  let grandTotal = 0;
  let grandCtvTotal = 0;
  for (const row of rows) {
    grandTotal += row.total;
    grandCtvTotal += row.ctvTotal;
    for (let j = 0; j < baseBuckets.length; j += 1) {
      columnTotals[j] += row.counts[j] ?? 0;
      columnCtvTotals[j] += row.ctvCounts[j] ?? 0;
    }
  }

  const buckets: TrendBucketPoint[] = baseBuckets.map((b, idx) => ({
    ...b,
    count: columnTotals[idx] ?? 0,
  }));

  return {
    resolution,
    selectedTeamId: rawTeamId,
    asOfDate,
    fromDate: effectiveFromDate,
    toDate: effectiveToDate,
    teams,
    buckets,
    rows,
    columnTotals,
    columnCtvTotals,
    grandTotal,
    grandCtvTotal,
  };
}
