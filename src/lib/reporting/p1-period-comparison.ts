/**
 * MBI-DA-2026-01 — Wave 3 (Items 1.5 & 1.6):
 *   1.5 Equivalent prior-period window derivation & comparison metrics (pure TypeScript).
 *   1.6 Current worker status Go/No-go audit record and frozen status vocabulary.
 */

import { isRealCalendarDate, type ReportingFilters } from "./p1-filter.ts";
import { matchDatePreset, todayInHoChiMinh } from "./p1-date-presets.ts";
import { computeReporting, type ReportingFact } from "./p1-reporting.ts";
import {
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover.ts";
import {
  resolveReportingAudienceProjection,
  type ReportingAudienceKind,
} from "./p3-w05a-audience.ts";

export type PriorPeriodMode = "this-week" | "this-month" | "this-quarter" | "contiguous";

export type PriorPeriodNotApplicableReason = "all_time" | "one_sided" | "invalid_range";

export type PriorPeriodWindowResult =
  | {
      applicable: true;
      mode: PriorPeriodMode;
      currentFrom: string;
      currentTo: string;
      previousFrom: string;
      previousTo: string;
      dayCount: number;
      previousDayCount: number;
      previousFilters: ReportingFilters;
      windowLabel: string;
    }
  | {
      applicable: false;
      reason: PriorPeriodNotApplicableReason;
      currentFrom: string | null;
      currentTo: string | null;
      windowLabel: string;
    };

export interface PeriodComparisonMetrics {
  currentTotal: number;
  previousTotal: number;
  deltaAbs: number;
  /** null khi previousTotal = 0 (không bao giờ trả Infinity/NaN/0%). */
  deltaPct: number | null;
  direction: "up" | "down" | "flat";
}

export type PeriodComparisonResult =
  | ({
      status: "ready";
      window: Extract<PriorPeriodWindowResult, { applicable: true }>;
    } & PeriodComparisonMetrics)
  | {
      status: "not_applicable";
      reason: PriorPeriodNotApplicableReason;
      currentFrom: string | null;
      currentTo: string | null;
      windowLabel: string;
      currentTotal: number;
    }
  | {
      status: "unavailable";
      window: Extract<PriorPeriodWindowResult, { applicable: true }>;
      currentTotal: number;
    };

interface YMD {
  y: number;
  m: number;
  d: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtYmd(d: YMD): string {
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
}

function parseYmd(value: string): YMD {
  const [y, m, d] = value.split("-").map(Number);
  return { y, m, d };
}

function toUtcMs(d: YMD): number {
  return Date.UTC(d.y, d.m - 1, d.d);
}

function fromUtcMs(ms: number): YMD {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const ms = toUtcMs(parseYmd(ymd)) + deltaDays * 86_400_000;
  return fmtYmd(fromUtcMs(ms));
}

function inclusiveDayCount(fromYmd: string, toYmd: string): number {
  const startMs = toUtcMs(parseYmd(fromYmd));
  const endMs = toUtcMs(parseYmd(toYmd));
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

function startOfPrevMonthYmd(d: YMD): string {
  const prev = d.m === 1 ? { y: d.y - 1, m: 12, d: 1 } : { y: d.y, m: d.m - 1, d: 1 };
  return fmtYmd(prev);
}

function startOfPrevQuarterYmd(d: YMD): string {
  const q = Math.floor((d.m - 1) / 3);
  const prev = q === 0 ? { y: d.y - 1, m: 10, d: 1 } : { y: d.y, m: (q - 1) * 3 + 1, d: 1 };
  return fmtYmd(prev);
}

function buildPreviousFilters(
  filters: ReportingFilters,
  previousFrom: string,
  previousTo: string,
): ReportingFilters {
  const next: ReportingFilters = {
    from: previousFrom,
    to: previousTo,
  };
  if (filters.project) next.project = filters.project;
  if (filters.recruiter) next.recruiter = filters.recruiter;
  if (filters.provider) next.provider = filters.provider;
  if (filters.collaborator) next.collaborator = filters.collaborator;
  if (filters.employment) next.employment = filters.employment;
  if (filters.status) next.status = filters.status;
  return next;
}

/**
 * Tính khoảng ngày kỳ trước tương đương theo quy ước lịch nghiệp vụ Asia/Ho_Chi_Minh:
 * - Nếu không giới hạn cả `from` và `to` ("Tất cả thời gian" hoặc chỉ 1 đầu mút) -> `applicable: false`.
 * - Nếu khớp preset đang diễn ra (`this-week`, `this-month`, `this-quarter`) tại `referenceDate`:
 *   so với đúng cùng số ngày đã qua (`dayCount`) tính từ đầu tuần trước / tháng trước / quý trước
 *   (không vượt quá ngày cuối của kỳ dương lịch liền trước).
 * - Các khoảng ngày hữu hạn khác (`[from, to]`): lấy khoảng ngày liền kề ngay trước `from`
 *   có cùng số ngày lịch (`dayCount`).
 */
export function derivePriorPeriodWindow(
  filters: ReportingFilters,
  referenceDate?: Date,
): PriorPeriodWindowResult {
  const rawFrom = filters.from?.trim() || "";
  const rawTo = filters.to?.trim() || "";

  if (!rawFrom && !rawTo) {
    return {
      applicable: false,
      reason: "all_time",
      currentFrom: null,
      currentTo: null,
      windowLabel: "Không áp dụng cho Tất cả thời gian",
    };
  }

  if (!rawFrom || !rawTo) {
    return {
      applicable: false,
      reason: "one_sided",
      currentFrom: rawFrom || null,
      currentTo: rawTo || null,
      windowLabel: "Cần chọn đủ Từ ngày và Đến ngày để so sánh kỳ trước",
    };
  }

  if (!isRealCalendarDate(rawFrom) || !isRealCalendarDate(rawTo) || rawFrom > rawTo) {
    return {
      applicable: false,
      reason: "invalid_range",
      currentFrom: rawFrom,
      currentTo: rawTo,
      windowLabel: "Khoảng ngày không hợp lệ để so sánh kỳ trước",
    };
  }

  const dayCount = inclusiveDayCount(rawFrom, rawTo);
  const matchedPreset = referenceDate ? matchDatePreset(rawFrom, rawTo, referenceDate) : null;
  const fromParts = parseYmd(rawFrom);

  if (matchedPreset === "this-week") {
    const previousFrom = addCalendarDaysYmd(rawFrom, -7);
    const previousTo = addCalendarDaysYmd(previousFrom, dayCount - 1);
    return {
      applicable: true,
      mode: "this-week",
      currentFrom: rawFrom,
      currentTo: rawTo,
      previousFrom,
      previousTo,
      dayCount,
      previousDayCount: dayCount,
      previousFilters: buildPreviousFilters(filters, previousFrom, previousTo),
      windowLabel: `Cùng số ngày tuần trước (${previousFrom} → ${previousTo})`,
    };
  }

  if (matchedPreset === "this-month") {
    const previousFrom = startOfPrevMonthYmd(fromParts);
    const prevMonthEnd = addCalendarDaysYmd(rawFrom, -1);
    const candidateTo = addCalendarDaysYmd(previousFrom, dayCount - 1);
    const previousTo = candidateTo > prevMonthEnd ? prevMonthEnd : candidateTo;
    const previousDayCount = inclusiveDayCount(previousFrom, previousTo);
    return {
      applicable: true,
      mode: "this-month",
      currentFrom: rawFrom,
      currentTo: rawTo,
      previousFrom,
      previousTo,
      dayCount,
      previousDayCount,
      previousFilters: buildPreviousFilters(filters, previousFrom, previousTo),
      windowLabel: `Cùng kỳ tháng trước (${previousFrom} → ${previousTo})`,
    };
  }

  if (matchedPreset === "this-quarter") {
    const previousFrom = startOfPrevQuarterYmd(fromParts);
    const prevQuarterEnd = addCalendarDaysYmd(rawFrom, -1);
    const candidateTo = addCalendarDaysYmd(previousFrom, dayCount - 1);
    const previousTo = candidateTo > prevQuarterEnd ? prevQuarterEnd : candidateTo;
    const previousDayCount = inclusiveDayCount(previousFrom, previousTo);
    return {
      applicable: true,
      mode: "this-quarter",
      currentFrom: rawFrom,
      currentTo: rawTo,
      previousFrom,
      previousTo,
      dayCount,
      previousDayCount,
      previousFilters: buildPreviousFilters(filters, previousFrom, previousTo),
      windowLabel: `Cùng kỳ quý trước (${previousFrom} → ${previousTo})`,
    };
  }

  const previousTo = addCalendarDaysYmd(rawFrom, -1);
  const previousFrom = addCalendarDaysYmd(rawFrom, -dayCount);
  return {
    applicable: true,
    mode: "contiguous",
    currentFrom: rawFrom,
    currentTo: rawTo,
    previousFrom,
    previousTo,
    dayCount,
    previousDayCount: dayCount,
    previousFilters: buildPreviousFilters(filters, previousFrom, previousTo),
    windowLabel: `Kỳ liền trước ${dayCount} ngày (${previousFrom} → ${previousTo})`,
  };
}

/**
 * Tính chênh lệch tuyệt đối và phần trăm giữa kỳ hiện tại và kỳ trước.
 * Khi `previousTotal === 0`, trả `deltaPct: null` (không chia cho 0 hoặc trả 0%).
 */
export function computePeriodComparisonMetrics(
  currentTotal: number,
  previousTotal: number,
): PeriodComparisonMetrics {
  const deltaAbs = currentTotal - previousTotal;
  const deltaPct =
    previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null;
  const direction: "up" | "down" | "flat" =
    deltaAbs > 0 ? "up" : deltaAbs < 0 ? "down" : "flat";
  return {
    currentTotal,
    previousTotal,
    deltaAbs,
    deltaPct,
    direction,
  };
}

export function buildPeriodComparisonResult(input: {
  window: Extract<PriorPeriodWindowResult, { applicable: true }>;
  currentTotal: number;
  previousTotal: number;
}): Extract<PeriodComparisonResult, { status: "ready" }> {
  const metrics = computePeriodComparisonMetrics(input.currentTotal, input.previousTotal);
  return {
    status: "ready",
    window: input.window,
    ...metrics,
  };
}

export function formatPeriodComparisonSummary(comparison: PeriodComparisonResult): {
  badgeLabel: string;
  badgeTone: "success" | "danger" | "neutral" | "warning";
  deltaText: string;
  detailText: string;
} {
  if (comparison.status === "not_applicable") {
    return {
      badgeLabel: "Chưa so sánh kỳ",
      badgeTone: "neutral",
      deltaText: "—",
      detailText: comparison.windowLabel,
    };
  }

  if (comparison.status === "unavailable") {
    return {
      badgeLabel: "Tạm thời chưa có kỳ trước",
      badgeTone: "warning",
      deltaText: "—",
      detailText: `Không tải được dữ liệu so sánh (${comparison.window.windowLabel}).`,
    };
  }

  const sign = comparison.deltaAbs > 0 ? "+" : "";
  const pctPart =
    comparison.deltaPct !== null
      ? ` (${comparison.deltaPct > 0 ? "+" : ""}${(Math.round(comparison.deltaPct * 10) / 10).toFixed(1)}%)`
      : " (kỳ trước: 0 — không tính %)";

  const badgeLabel =
    comparison.direction === "up"
      ? "Tăng so với kỳ trước"
      : comparison.direction === "down"
        ? "Giảm so với kỳ trước"
        : "Bằng kỳ trước";

  const badgeTone =
    comparison.direction === "up"
      ? "success"
      : comparison.direction === "down"
        ? "danger"
        : "neutral";

  return {
    badgeLabel,
    badgeTone,
    deltaText: `${sign}${comparison.deltaAbs} lượt${pctPart}`,
    detailText: `Kỳ trước: ${comparison.previousTotal} lượt · ${comparison.window.windowLabel}`,
  };
}

export interface ScopedFactsRpcArgs {
  p_auth_subject: string;
  p_app_user_id: string;
  p_filters: ReportingFilters;
}

export interface ScopedFactsRpcResult {
  data?: {
    audience?: unknown;
    facts?: unknown[];
  } | null;
  error?: unknown;
}

/**
 * Truy vấn kỳ trước tương đương thông qua đúng RPC `direct_entry_reporting_scoped_facts`
 * với cùng `actor.auth_subject`, `actor.app_user_id` và các bộ lọc phi thời gian.
 * Lỗi truy vấn so sánh được cô lập (`status: "unavailable"`) để không làm gãy dữ liệu kỳ hiện tại.
 */
export async function resolvePriorPeriodComparisonForActor(input: {
  actor: { auth_subject: string; app_user_id: string };
  filters: ReportingFilters;
  currentTotal: number;
  callScopedFactsRpc: (args: ScopedFactsRpcArgs) => PromiseLike<ScopedFactsRpcResult>;
  expectedAudienceKind?: ReportingAudienceKind;
  referenceDate?: Date;
}): Promise<PeriodComparisonResult> {
  const window = derivePriorPeriodWindow(input.filters, input.referenceDate ?? new Date());
  if (!window.applicable) {
    return {
      status: "not_applicable",
      reason: window.reason,
      currentFrom: window.currentFrom,
      currentTo: window.currentTo,
      windowLabel: window.windowLabel,
      currentTotal: input.currentTotal,
    };
  }

  try {
    const res = await input.callScopedFactsRpc({
      p_auth_subject: input.actor.auth_subject,
      p_app_user_id: input.actor.app_user_id,
      p_filters: window.previousFilters,
    });
    if (!res || typeof res !== "object" || res.error) {
      return {
        status: "unavailable",
        window,
        currentTotal: input.currentTotal,
      };
    }
    const payload = res.data ?? {};
    const audience = resolveReportingAudienceProjection(payload.audience);
    if (
      audience === null ||
      (input.expectedAudienceKind !== undefined && audience.kind !== input.expectedAudienceKind)
    ) {
      return {
        status: "unavailable",
        window,
        currentTotal: input.currentTotal,
      };
    }
    const rawFacts = Array.isArray(payload.facts) ? (payload.facts as ReportingFact[]) : [];
    const directEntryFacts = rawFacts.filter(
      (fact) => fact && fact.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID,
    );
    const sourcesWithFacts =
      directEntryFacts.length > 0
        ? new Set([P2_W04A_DIRECT_ENTRY_SOURCE_ID])
        : new Set<string>();
    const previousData = computeReporting(
      [P2_W04A_DIRECT_ENTRY_SOURCE],
      directEntryFacts,
      window.previousFilters,
      sourcesWithFacts,
    );
    return buildPeriodComparisonResult({
      window,
      currentTotal: input.currentTotal,
      previousTotal: previousData.recruitedTotal,
    });
  } catch {
    return {
      status: "unavailable",
      window,
      currentTotal: input.currentTotal,
    };
  }
}

// ---------------------------------------------------------------------------
// Wave 3 — Item 1.6: Frozen Worker Status Vocabulary & Go/No-go Audit Record
// ---------------------------------------------------------------------------

/**
 * Từ điển trạng thái lao động đã khóa (Frozen vocabulary):
 * UNCONFIRMED bắt buộc hiển thị là "Đang chờ việc", tuyệt đối không gọi là "Chưa xác nhận"
 * và không bao giờ cộng gộp vào ON hoặc OFF.
 */
export const WORKER_STATUS_FROZEN_LABELS = Object.freeze({
  ON: "Đang làm",
  UNCONFIRMED: "Đang chờ việc",
  OFF: "Đã nghỉ",
} as const);

export const WORKER_STATUS_CURRENT_SNAPSHOT_NOTE =
  "Trạng thái hồ sơ hiện tại — không áp dụng khoảng ngày tuyển";

/**
 * Biên bản kiểm toán kỹ thuật mục 1.6 (Current Worker Status Go/No-go):
 * Kết luận: NO_GO trong Chặng 1 (chuyển sang Chặng 2 theo đúng quy tắc cổng kiểm tra §5 item 1.6).
 */
export const ITEM_1_6_WORKER_STATUS_AUDIT = Object.freeze({
  decision: "NO_GO_DEFER_PHASE_2" as const,
  evaluatedRpc: "public.direct_entry_list_workers" as const,
  evaluatedGuard: "public.direct_entry_worker_directory_audience" as const,
  reportingAudienceGuard: "public.direct_entry_reporting_resolve_audience" as const,
  reasons: Object.freeze([
    {
      code: "AUDIENCE_ALL_MISMATCH",
      evidence:
        "direct_entry_reporting_resolve_audience grants `all` to any actor with current scope_kind='all', whereas direct_entry_worker_directory_audience (`20261020210000_r1_1_team_leader_direct_edit.sql` L226-230) additionally requires capability `entry_admin` OR `change_review` and raises 42501 otherwise.",
    },
    {
      code: "AUDIENCE_TEAM_MISMATCH",
      evidence:
        "direct_entry_reporting_authorized_entries (`20261015110000_pre_w2_hf_reporting_direct_entry_only.sql` L36-46) authorizes multi-team `direct_entry_scope_grants` (`e.team_id = any(v_team_ids)`), whereas direct_entry_worker_directory_audience (`p_scope = 'team'`, L179-186) calls `direct_entry_assert_team_leader_current_team`, which requires `public.team_leader_assignments` and raises 42501 if the actor leads != 1 team.",
    },
    {
      code: "AUDIENCE_OWN_MISMATCH",
      evidence:
        "direct_entry_reporting_resolve_audience resolves `own` with empty facts when an actor has no current verified recruiter link, whereas direct_entry_worker_directory_audience (`p_scope = 'recruited'`, L188-204) raises 42501 when `v_link_count <> 1`.",
    },
    {
      code: "FILTER_CONTRACT_INCOMPATIBLE",
      evidence:
        "Dashboard `ReportingFilters` filters by normalized display keys (`project_key`, `recruiter_key`) and supports `provider` (`hrp|vendor|__unknown__|__invalid__`) and `employment` (`thời vụ|chính thức|__unknown__|__invalid__`). `direct_entry_list_workers` only accepts raw `p_project_id` code and `p_recruiter_id` UUID and has no provider or labor_type filter parameters.",
    },
    {
      code: "NO_AGGREGATE_ONLY_MODE_AND_PII_PROJECTION",
      evidence:
        "direct_entry_list_workers enforces `v_page_size between 1 and 100` (`20261020200000_r1_current_state_authorization.sql` L1082-1085), always materializes `WorkerDirectoryRow` items containing worker `display_name`, `employee_code`, and `payment`, and requires 4 RPC round-trips (`null`, `ON`, `UNCONFIRMED`, `OFF`) to separate known statuses from null status.",
    },
  ]),
});

export { todayInHoChiMinh };
