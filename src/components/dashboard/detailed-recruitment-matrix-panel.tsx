"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import {
  computeTableScrollStepPx,
  FloatingTableNav,
} from "@/components/ui/floating-table-nav";
import { useNotify } from "@/components/ui/notify-provider";
import { formatTimestamp } from "@/lib/format";
import {
  ALL_RECRUITERS_TEAM_FILTER,
  buildDetailedMatrixTeamDropdownOptions,
  canShowDetailedMatrixCtvBreakdown,
  clampDetailedMatrixZoom,
  computeDetailedMatrixZoomMetrics,
  DETAILED_MATRIX_FIXED_CELL_PAD_X_PX,
  DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX,
  DETAILED_MATRIX_FIXED_FONT_SIZE_PX,
  DETAILED_MATRIX_FIXED_NAME_PAD_X_PX,
  DETAILED_MATRIX_NAME_COL_WIDTH_PX,
  DETAILED_MATRIX_STT_COL_WIDTH_PX,
  DETAILED_MATRIX_ZOOM_DEFAULT,
  DETAILED_MATRIX_ZOOM_MAX,
  DETAILED_MATRIX_ZOOM_MIN,
  DETAILED_MATRIX_ZOOM_STEP,
  formatDetailedMatrixMetricCell,
  formatWorkMonthsCell,
  isMarketingHrpTeamOption,
  sortDetailedMatrixTeamOptions,
  type DetailedMatrixTeamDropdownOption,
  type DetailedMatrixTeamOption,
  type DetailedMatrixZoomMetrics,
  type DetailedRecruitmentMatrixReport,
} from "@/lib/reporting/detailed-recruitment-matrix";
import {
  TREND_RESOLUTION_OPTIONS,
  type TrendResolution,
} from "@/lib/reporting/p1-dashboard-period";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { FiltersOrError } from "./dashboard-shared";

export {
  buildDetailedMatrixTeamDropdownOptions,
  canShowDetailedMatrixCtvBreakdown,
  clampDetailedMatrixZoom,
  computeDetailedMatrixZoomMetrics,
  DETAILED_MATRIX_FIXED_CELL_PAD_X_PX,
  DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX,
  DETAILED_MATRIX_FIXED_FONT_SIZE_PX,
  DETAILED_MATRIX_FIXED_NAME_PAD_X_PX,
  DETAILED_MATRIX_NAME_COL_WIDTH_PX,
  DETAILED_MATRIX_STT_COL_WIDTH_PX,
  DETAILED_MATRIX_ZOOM_DEFAULT,
  DETAILED_MATRIX_ZOOM_MAX,
  DETAILED_MATRIX_ZOOM_MIN,
  DETAILED_MATRIX_ZOOM_STEP,
  formatDetailedMatrixMetricCell,
  isMarketingHrpTeamOption,
  sortDetailedMatrixTeamOptions,
  type DetailedMatrixTeamDropdownOption,
  type DetailedMatrixZoomMetrics,
};

export type DetailedMatrixProvider = "hrp" | "hrp_direct" | "hrp_ctv" | "vendor";

export const DETAILED_MATRIX_PROVIDER_OPTIONS: readonly {
  key: DetailedMatrixProvider;
  label: string;
}[] = [
  { key: "hrp", label: "Tổng tuyển của NVTD" },
  { key: "hrp_direct", label: "HRP trực tiếp" },
  { key: "hrp_ctv", label: "Qua CTV" },
  { key: "vendor", label: "Vendor" },
] as const;

export function normalizeDetailedMatrixProvider(
  value: string | null | undefined,
): DetailedMatrixProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "hrp_direct") return "hrp_direct";
  if (normalized === "hrp_ctv") return "hrp_ctv";
  if (normalized === "vendor") return "vendor";
  return "hrp";
}

/**
 * Hiển thị tên người tuyển kèm số tháng làm việc trong ngoặc đơn, ví dụ:
 * `"Nguyễn Thế Vinh (80)"`. Nếu không có số tháng hợp lệ thì chỉ hiển thị tên.
 */
export function formatRecruiterNameWithWorkMonths(
  displayName: string,
  workMonths: number | null | undefined,
): string {
  const monthsText = formatWorkMonthsCell(workMonths);
  return monthsText !== "-" ? `${displayName} (${monthsText})` : displayName;
}

/**
 * Bỏ phần năm khỏi mốc ngày để rút gọn nhãn cột trên bảng:
 * - `YYYY-MM-DD` -> `DD/MM` (ví dụ `2026-10-25` -> `25/10`)
 * - `YYYY-MM` -> `TMM` (ví dụ `2026-10` -> `T10`)
 */
export function stripYearFromDateToken(token: string): string {
  const trimmed = token.trim();
  const ymdMatch = /^\d{4}-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymdMatch) {
    return `${ymdMatch[2]}/${ymdMatch[1]}`;
  }
  const ymMatch = /^\d{4}-(\d{2})$/.exec(trimmed);
  if (ymMatch) {
    return `T${ymMatch[1]}`;
  }
  return trimmed.replace(/^\d{4}[-/]/, "");
}

export function formatShortBucketLabel(bucket: {
  date: string;
  startDate: string;
  endDate: string;
}): string {
  if (/^\d{4}-\d{2}$/.test(bucket.date.trim())) {
    return stripYearFromDateToken(bucket.date);
  }
  if (bucket.startDate && bucket.endDate) {
    if (bucket.startDate === bucket.endDate) {
      return stripYearFromDateToken(bucket.startDate);
    }
    return `${stripYearFromDateToken(bucket.startDate)}–${stripYearFromDateToken(bucket.endDate)}`;
  }
  return bucket.date
    .split(/\s*→\s*/)
    .map(stripYearFromDateToken)
    .join("–");
}

export function formatFullBucketTooltip(bucket: {
  date: string;
  startDate: string;
  endDate: string;
}): string {
  return bucket.startDate === bucket.endDate
    ? bucket.startDate
    : `${bucket.startDate} → ${bucket.endDate}`;
}

export function buildDetailedMatrixFilterSignature(data: ReportingData): string {
  const a = data.applied;
  return [
    a.from ?? "",
    a.to ?? "",
    a.project ?? "",
    a.recruiter ?? "",
    a.collaborator ?? "",
    a.employment ?? "",
    a.status ?? "",
    a.source ?? "",
  ].join("|");
}

export function buildDetailedMatrixUrl(
  data: ReportingData,
  options?: {
    resolution?: TrendResolution;
    teamId?: string;
    provider?: DetailedMatrixProvider;
    collaborator?: string;
  },
): string {
  const query = new URLSearchParams();
  const a = data.applied;
  if (a.from) query.set("from", a.from);
  else if (!a.to) query.set("range", "all");
  if (a.to) query.set("to", a.to);
  if (a.project) query.set("project", a.project);
  if (a.recruiter) query.set("recruiter", a.recruiter);

  const provider = normalizeDetailedMatrixProvider(options?.provider ?? "hrp");
  query.set("provider", provider);

  const collaborator =
    options?.collaborator !== undefined ? options.collaborator : a.collaborator;
  if (collaborator) query.set("collaborator", collaborator);

  if (a.employment) query.set("employment", a.employment);
  if (a.status) query.set("status", a.status);
  if (a.source) query.set("source", a.source);

  const resolution = options?.resolution ?? "day";
  query.set("resolution", resolution);

  const teamId =
    options?.teamId && options.teamId.trim().length > 0
      ? options.teamId.trim()
      : ALL_RECRUITERS_TEAM_FILTER;
  if (teamId !== ALL_RECRUITERS_TEAM_FILTER) {
    query.set("team", teamId);
  }

  return "/api/reporting/detailed-matrix?" + query.toString();
}

function isReadyDetailedMatrixEnvelope(value: unknown): value is {
  ok: true;
  matrix: DetailedRecruitmentMatrixReport;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true) return false;
  const matrix = record.matrix as Record<string, unknown> | null | undefined;
  return Boolean(
    matrix &&
      typeof matrix === "object" &&
      Array.isArray(matrix.rows) &&
      Array.isArray(matrix.buckets) &&
      Array.isArray(matrix.columnTotals) &&
      typeof matrix.grandTotal === "number",
  );
}

/**
 * Panel cho tab `Báo cáo chi tiết` trên Dashboard toàn cục (`scope = "all"`).
 *
 * Hiển thị bảng ma trận 2 chiều:
 * - Cột cố định bên trái: `STT`, `Họ tên` (kèm số tháng làm việc trong ngoặc đơn nếu có)
 * - Bộ lọc nguồn `HRP` / `Vendor` riêng cho bảng (mặc định `HRP`)
 * - Cột thời gian động theo bộ chuyển `Ngày` / `Tuần` / `Tháng` với nhãn rút gọn (bỏ năm, giữ tooltip ngày đầy đủ)
 * - Thu phóng dữ liệu (`70%` – `130%`) và thanh cuộn ngang sticky phía trên đồng bộ hai chiều với bảng
 * - Tổng theo dòng (`Tổng`) và tổng theo cột (`Tổng cộng`), đối soát khớp với Dashboard.
 */
export function DetailedRecruitmentMatrixPanel({
  data,
  generatedAt,
  optionsResult,
}: {
  data: ReportingData;
  generatedAt?: string;
  optionsResult: ReportingOptionsResult;
}) {
  const filterSignature = buildDetailedMatrixFilterSignature(data);
  const [selectedProvider, setSelectedProvider] =
    useState<DetailedMatrixProvider>("hrp");
  const [resolution, setResolution] = useState<TrendResolution>("day");
  const [selectedTeamId, setSelectedTeamId] = useState<string>(
    ALL_RECRUITERS_TEAM_FILTER,
  );
  const [showCtvCounts, setShowCtvCounts] = useState<boolean>(false);
  const [knownTeams, setKnownTeams] = useState<DetailedMatrixTeamOption[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [zoomPercent, setZoomPercent] = useState<number>(
    DETAILED_MATRIX_ZOOM_DEFAULT,
  );
  const [scrollContentWidth, setScrollContentWidth] = useState<number>(0);

  const cacheRef = useRef<Map<string, DetailedRecruitmentMatrixReport>>(
    new Map(),
  );
  const requestSeqRef = useRef(0);
  const userRetryRef = useRef(false);
  const resolutionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const syncingScrollSourceRef = useRef<"top" | "table" | null>(null);
  const syncingScrollTimerRef = useRef<number | null>(null);
  const notify = useNotify();

  const requestKey = `${filterSignature}|${selectedProvider}|${resolution}|${selectedTeamId}`;

  const [state, setState] = useState<{
    requestKey: string;
    status: "loading" | "ready" | "error";
    matrix: DetailedRecruitmentMatrixReport | null;
  }>({
    requestKey,
    status: "loading",
    matrix: null,
  });

  useEffect(() => {
    const cached =
      reloadToken === 0 ? cacheRef.current.get(requestKey) : undefined;
    if (cached) {
      userRetryRef.current = false;
      setKnownTeams(sortDetailedMatrixTeamOptions(cached.teams));
      setState({
        requestKey,
        status: "ready",
        matrix: cached,
      });
      return;
    }

    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    const isUserRetry = userRetryRef.current;
    setState((prev) => ({
      requestKey,
      status: "loading",
      matrix: prev.requestKey === requestKey ? prev.matrix : null,
    }));

    fetch(
      buildDetailedMatrixUrl(data, {
        resolution,
        teamId: selectedTeamId,
        provider: selectedProvider,
      }),
      {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const json: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted || seq !== requestSeqRef.current) return;
        if (!response.ok || !isReadyDetailedMatrixEnvelope(json)) {
          userRetryRef.current = false;
          setState({ requestKey, status: "error", matrix: null });
          if (isUserRetry) {
            notify.error({
              title:
                "Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
          return;
        }

        const matrix = json.matrix;
        userRetryRef.current = false;
        cacheRef.current.set(requestKey, matrix);
        setKnownTeams(sortDetailedMatrixTeamOptions(matrix.teams));

        if (
          selectedTeamId !== ALL_RECRUITERS_TEAM_FILTER &&
          matrix.teams.length > 0 &&
          !matrix.teams.some((t) => t.teamId === selectedTeamId)
        ) {
          setSelectedTeamId(ALL_RECRUITERS_TEAM_FILTER);
          return;
        }

        setState({
          requestKey,
          status: "ready",
          matrix,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted && seq === requestSeqRef.current) {
          userRetryRef.current = false;
          setState({ requestKey, status: "error", matrix: null });
          if (isUserRetry) {
            notify.error({
              title:
                "Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.",
            });
          }
        }
      });

    return () => controller.abort();
  }, [
    data,
    notify,
    reloadToken,
    requestKey,
    resolution,
    selectedProvider,
    selectedTeamId,
  ]);

  const isCurrentRequest = state.requestKey === requestKey;
  const effectiveStatus = isCurrentRequest ? state.status : "loading";
  const effectiveMatrix = isCurrentRequest ? state.matrix : null;

  const syncScrollMetrics = useCallback(() => {
    const tableEl = tableRef.current;
    const scrollEl = tableScrollRef.current;
    const topEl = topScrollRef.current;
    const nextWidth = tableEl?.scrollWidth ?? scrollEl?.scrollWidth ?? 0;
    setScrollContentWidth((prev) => (prev !== nextWidth ? nextWidth : prev));
    if (topEl && scrollEl && Math.abs(topEl.scrollLeft - scrollEl.scrollLeft) > 0.5) {
      topEl.scrollLeft = scrollEl.scrollLeft;
    }
  }, []);

  useEffect(() => {
    if (effectiveStatus !== "ready" || !effectiveMatrix) return;
    syncScrollMetrics();

    const tableEl = tableRef.current;
    const scrollEl = tableScrollRef.current;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        syncScrollMetrics();
      });
      if (tableEl) observer.observe(tableEl);
      if (scrollEl) observer.observe(scrollEl);
    }
    window.addEventListener("resize", syncScrollMetrics);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncScrollMetrics);
    };
  }, [effectiveMatrix, effectiveStatus, resolution, syncScrollMetrics, zoomPercent]);

  useEffect(() => {
    return () => {
      if (syncingScrollTimerRef.current !== null) {
        window.clearTimeout(syncingScrollTimerRef.current);
      }
    };
  }, []);

  function scheduleReleaseScrollSync(source: "top" | "table"): void {
    if (syncingScrollTimerRef.current !== null) {
      window.clearTimeout(syncingScrollTimerRef.current);
    }
    syncingScrollTimerRef.current = window.setTimeout(() => {
      if (syncingScrollSourceRef.current === source) {
        syncingScrollSourceRef.current = null;
      }
      syncingScrollTimerRef.current = null;
    }, 180);
  }

  function handleTopScroll(): void {
    const topEl = topScrollRef.current;
    const tableEl = tableScrollRef.current;
    if (!topEl || !tableEl) return;
    if (syncingScrollSourceRef.current === "table") return;
    syncingScrollSourceRef.current = "top";
    if (Math.abs(tableEl.scrollLeft - topEl.scrollLeft) > 0.5) {
      tableEl.scrollLeft = topEl.scrollLeft;
    }
    scheduleReleaseScrollSync("top");
  }

  function handleTableScroll(): void {
    const topEl = topScrollRef.current;
    const tableEl = tableScrollRef.current;
    if (!topEl || !tableEl) return;
    if (syncingScrollSourceRef.current === "top") return;
    syncingScrollSourceRef.current = "table";
    if (Math.abs(topEl.scrollLeft - tableEl.scrollLeft) > 0.5) {
      topEl.scrollLeft = tableEl.scrollLeft;
    }
    scheduleReleaseScrollSync("table");
  }

  function handleHorizontalScrollKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
  ): void {
    const tableEl = tableScrollRef.current;
    const topEl = topScrollRef.current;
    if (!tableEl) return;

    const maxScrollLeft = Math.max(0, tableEl.scrollWidth - tableEl.clientWidth);
    if (maxScrollLeft <= 0) return;

    const stepPx = computeTableScrollStepPx(tableEl.clientWidth);
    const pagePx = Math.max(200, Math.round(tableEl.clientWidth * 0.8));
    let nextScrollLeft: number | null = null;

    if (event.key === "ArrowRight") {
      nextScrollLeft = Math.min(maxScrollLeft, tableEl.scrollLeft + stepPx);
    } else if (event.key === "ArrowLeft") {
      nextScrollLeft = Math.max(0, tableEl.scrollLeft - stepPx);
    } else if (event.key === "PageDown") {
      nextScrollLeft = Math.min(maxScrollLeft, tableEl.scrollLeft + pagePx);
    } else if (event.key === "PageUp") {
      nextScrollLeft = Math.max(0, tableEl.scrollLeft - pagePx);
    } else if (event.key === "Home") {
      nextScrollLeft = 0;
    } else if (event.key === "End") {
      nextScrollLeft = maxScrollLeft;
    }

    if (nextScrollLeft === null) return;
    event.preventDefault();
    tableEl.scrollLeft = nextScrollLeft;
    if (topEl) topEl.scrollLeft = nextScrollLeft;
  }

  function handleRetry(): void {
    userRetryRef.current = true;
    cacheRef.current.delete(requestKey);
    setReloadToken((n) => n + 1);
  }

  function handleResolutionKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let nextIndex = -1;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (index + TREND_RESOLUTION_OPTIONS.length - 1) %
        TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TREND_RESOLUTION_OPTIONS.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    setResolution(TREND_RESOLUTION_OPTIONS[nextIndex].key);
    requestAnimationFrame(() => resolutionButtonRefs.current[nextIndex]?.focus());
  }

  const activeResolutionOption =
    TREND_RESOLUTION_OPTIONS.find((opt) => opt.key === resolution) ??
    TREND_RESOLUTION_OPTIONS[0];
  const activeProviderLabel =
    DETAILED_MATRIX_PROVIDER_OPTIONS.find((opt) => opt.key === selectedProvider)
      ?.label ?? "Tổng tuyển của NVTD";
  const ctvToggleAvailable = canShowDetailedMatrixCtvBreakdown(selectedProvider);
  const showCtvInCells = ctvToggleAvailable && showCtvCounts;
  const teamOptions = useMemo(
    () => sortDetailedMatrixTeamOptions(effectiveMatrix?.teams ?? knownTeams),
    [effectiveMatrix?.teams, knownTeams],
  );
  const selectedTeamLabel =
    selectedTeamId === ALL_RECRUITERS_TEAM_FILTER
      ? "Tất cả người tuyển"
      : (teamOptions.find((t) => t.teamId === selectedTeamId)?.displayName ??
        "Nhóm đã chọn");

  const zoomMetrics = computeDetailedMatrixZoomMetrics(zoomPercent, resolution);

  const matrixZoomStyles: CSSProperties = {
    ["--matrix-fixed-font-size" as string]: `${zoomMetrics.fixedFontSizePx}px`,
    ["--matrix-fixed-cell-px" as string]: `${zoomMetrics.fixedCellPadXPx}px`,
    ["--matrix-fixed-cell-py" as string]: `${zoomMetrics.fixedCellPadYPx}px`,
    ["--matrix-fixed-name-px" as string]: `${zoomMetrics.fixedNamePadXPx}px`,
    ["--matrix-stt-w" as string]: `${zoomMetrics.sttColWidthPx}px`,
    ["--matrix-name-w" as string]: `${zoomMetrics.nameColWidthPx}px`,
    ["--matrix-name-min-w" as string]: `${zoomMetrics.nameMinWidthPx}px`,
    ["--matrix-name-max-w" as string]: `${zoomMetrics.nameMaxWidthPx}px`,
    ["--matrix-font-size" as string]: `${zoomMetrics.metricFontSizePx}px`,
    ["--matrix-cell-px" as string]: `${zoomMetrics.cellPadXPx}px`,
    ["--matrix-cell-py" as string]: `${zoomMetrics.cellPadYPx}px`,
    ["--matrix-total-cell-px" as string]: `${zoomMetrics.totalCellPadXPx}px`,
    ["--matrix-bucket-min-w" as string]: `${zoomMetrics.bucketMinWidthPx}px`,
    ["--matrix-total-min-w" as string]: `${zoomMetrics.totalColMinWidthPx}px`,
  };

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-primary">
            BoD · Báo cáo chi tiết
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">
            Báo cáo chi tiết tuyển dụng
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            Bảng chi tiết số lượng tuyển dụng theo từng nhân viên tuyển dụng và mốc thời gian (Ngày / Tuần / Tháng), đối soát khớp với tổng số liệu trên Dashboard.
          </p>
          {generatedAt ? (
            <p className="mt-1 text-xs text-muted">
              Báo cáo tạo lúc: <time>{formatTimestamp(generatedAt)}</time>
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <FiltersOrError optionsResult={optionsResult} />

        <Card className="p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <CardHeader title="Bảng chi tiết tuyển dụng theo nhân viên" />
              <p className="text-xs text-muted" aria-live="polite">
                Nguồn:{" "}
                <span className="font-medium text-foreground">
                  {activeProviderLabel}
                </span>
                {" · "}
                Phạm vi hiển thị:{" "}
                <span className="font-medium text-foreground">
                  {selectedTeamLabel}
                </span>
                {" · "}
                Độ phân giải:{" "}
                <span className="font-medium text-foreground">
                  {activeResolutionOption.label}
                </span>
                {effectiveMatrix ? (
                  <>
                    {" · "}
                    <span className="font-mono tabular-nums">
                      {effectiveMatrix.rows.length}
                    </span>{" "}
                    nhân viên
                    {" · "}
                    <span className="font-mono tabular-nums">
                      {effectiveMatrix.buckets.length}
                    </span>{" "}
                    mốc
                    {" · "}
                    Tổng tuyển:{" "}
                    <strong className="font-mono tabular-nums text-foreground">
                      {formatDetailedMatrixMetricCell(
                        effectiveMatrix.grandTotal,
                        effectiveMatrix.grandCtvTotal,
                        { showCtv: showCtvCounts, provider: selectedProvider },
                      )}
                    </strong>
                  </>
                ) : null}
              </p>
              {showCtvInCells ? (
                <p
                  data-testid="detailed-matrix-ctv-helper-note"
                  className="text-xs text-muted"
                >
                  Số trong ngoặc là số lượt qua CTV, đã tính trong tổng.
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {effectiveMatrix?.asOfDate ? (
                <StatusBadge tone="neutral" dot>
                  Thâm niên tính đến {effectiveMatrix.asOfDate}
                </StatusBadge>
              ) : null}

              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="detailed-matrix-provider-select"
                  className="text-xs font-medium whitespace-nowrap text-muted"
                >
                  Kênh tuyển
                </label>
                <select
                  id="detailed-matrix-provider-select"
                  data-testid="detailed-matrix-provider-select"
                  aria-label="Kênh tuyển"
                  value={selectedProvider}
                  onChange={(event) =>
                    setSelectedProvider(
                      normalizeDetailedMatrixProvider(event.target.value),
                    )
                  }
                  className="min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {DETAILED_MATRIX_PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label
                  htmlFor="detailed-matrix-team-select"
                  className="text-xs font-medium whitespace-nowrap text-muted"
                >
                  Người tuyển / Nhóm
                </label>
                <select
                  id="detailed-matrix-team-select"
                  aria-label="Người tuyển / Nhóm"
                  value={selectedTeamId}
                  onChange={(event) => setSelectedTeamId(event.target.value)}
                  className="min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value={ALL_RECRUITERS_TEAM_FILTER}>
                    Tất cả người tuyển
                  </option>
                  {teamOptions.map((team) => (
                    <option key={team.teamId} value={team.teamId}>
                      {team.displayName} ({team.memberCount})
                    </option>
                  ))}
                </select>
              </div>

              <div
                role="group"
                aria-label="Độ phân giải thời gian báo cáo chi tiết"
                className="inline-flex flex-wrap items-center rounded-lg border border-border bg-surface-muted p-0.5"
              >
                {TREND_RESOLUTION_OPTIONS.map((opt, idx) => {
                  const active = resolution === opt.key;
                  return (
                    <button
                      key={opt.key}
                      ref={(el) => {
                        resolutionButtonRefs.current[idx] = el;
                      }}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setResolution(opt.key)}
                      onKeyDown={(event) => handleResolutionKeyDown(event, idx)}
                      className={`min-h-9 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                        active
                          ? "bg-primary text-on-primary shadow-sm"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <label
                htmlFor="detailed-matrix-show-ctv-checkbox"
                className={`inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  ctvToggleAvailable
                    ? "cursor-pointer text-foreground hover:bg-surface-muted"
                    : "cursor-not-allowed text-muted opacity-55"
                }`}
                title={
                  ctvToggleAvailable
                    ? "Số trong ngoặc là số lượt qua CTV, đã tính trong tổng."
                    : "Chỉ áp dụng khi xem Tổng tuyển của NVTD"
                }
              >
                <input
                  id="detailed-matrix-show-ctv-checkbox"
                  data-testid="detailed-matrix-show-ctv-checkbox"
                  type="checkbox"
                  checked={showCtvInCells}
                  disabled={!ctvToggleAvailable}
                  onChange={(event) => setShowCtvCounts(event.target.checked)}
                  className="h-4 w-4 rounded border-border accent-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed"
                />
                <span>Hiện số tuyển qua CTV</span>
              </label>

              <div
                role="group"
                aria-label="Thu nhỏ phóng to bảng báo cáo"
                className="inline-flex items-center rounded-lg border border-border bg-surface-muted p-0.5"
              >
                <button
                  type="button"
                  data-testid="detailed-matrix-zoom-out"
                  aria-label="Thu nhỏ dữ liệu bảng báo cáo"
                  disabled={zoomPercent <= DETAILED_MATRIX_ZOOM_MIN}
                  onClick={() =>
                    setZoomPercent((prev) =>
                      clampDetailedMatrixZoom(prev - DETAILED_MATRIX_ZOOM_STEP),
                    )
                  }
                  className="min-h-8 min-w-8 rounded-md px-2 text-xs font-semibold text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  −
                </button>
                <button
                  type="button"
                  data-testid="detailed-matrix-zoom-level"
                  aria-label={`Mức thu phóng hiện tại ${zoomPercent}%, nhấn để đặt lại 100%`}
                  title="Nhấn để đặt lại tỷ lệ 100%"
                  onClick={() => setZoomPercent(DETAILED_MATRIX_ZOOM_DEFAULT)}
                  className="min-h-8 min-w-[46px] px-1.5 text-center font-mono text-xs font-semibold tabular-nums text-foreground hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {zoomPercent}%
                </button>
                <button
                  type="button"
                  data-testid="detailed-matrix-zoom-in"
                  aria-label="Phóng to dữ liệu bảng báo cáo"
                  disabled={zoomPercent >= DETAILED_MATRIX_ZOOM_MAX}
                  onClick={() =>
                    setZoomPercent((prev) =>
                      clampDetailedMatrixZoom(prev + DETAILED_MATRIX_ZOOM_STEP),
                    )
                  }
                  className="min-h-8 min-w-8 rounded-md px-2 text-xs font-semibold text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {effectiveStatus === "loading" ? (
            <div
              role="status"
              className="mt-4 rounded-2xl border border-border bg-surface px-6 py-10 text-center text-sm text-muted"
            >
              Đang tải báo cáo chi tiết…
            </div>
          ) : effectiveStatus === "error" || !effectiveMatrix ? (
            <div className="mt-4">
              <Alert
                tone="error"
                role="alert"
                title="Không tải được báo cáo chi tiết"
              >
                <p>
                  Không tải được dữ liệu báo cáo chi tiết cho bộ lọc hiện tại. Vui lòng thử lại.
                </p>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-2 min-h-10 rounded-md border border-current px-3 text-xs font-medium transition-[background-color,transform] duration-[var(--ui-motion-hover,160ms)] hover:bg-black/5 dark:hover:bg-white/10 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Thử tải lại
                </button>
              </Alert>
            </div>
          ) : (
            <div className="mt-4">
              <div
                ref={topScrollRef}
                role="region"
                aria-label="Thanh cuộn ngang phía trên bảng báo cáo chi tiết"
                tabIndex={0}
                data-testid="detailed-matrix-top-scrollbar"
                onScroll={handleTopScroll}
                onKeyDown={handleHorizontalScrollKeyDown}
                className="sticky top-0 z-30 overflow-x-auto overflow-y-hidden rounded-t-xl border border-b-0 border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <div
                  aria-hidden="true"
                  style={{
                    width:
                      scrollContentWidth > 0
                        ? `${scrollContentWidth}px`
                        : "100%",
                    height: "12px",
                  }}
                />
              </div>

              <div
                ref={tableScrollRef}
                role="region"
                aria-label="Vùng cuộn ngang bảng báo cáo chi tiết tuyển dụng"
                tabIndex={0}
                data-testid="detailed-matrix-table-scroll"
                onScroll={handleTableScroll}
                onKeyDown={handleHorizontalScrollKeyDown}
                style={matrixZoomStyles}
                className="max-h-[75vh] overflow-auto rounded-b-xl border border-border bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <table
                  ref={tableRef}
                  data-zoom-percent={zoomPercent}
                  style={{ fontSize: "var(--matrix-fixed-font-size, 12px)" }}
                  className="r22-report-table min-w-full border-collapse text-left"
                  aria-label="Bảng báo cáo chi tiết tuyển dụng theo nhân viên"
                >
                  <caption className="sr-only">
                    Bảng báo cáo chi tiết tuyển dụng theo nhân viên ({activeProviderLabel}, {selectedTeamLabel}, độ phân giải {activeResolutionOption.label})
                  </caption>
                  <thead className="sticky top-0 z-30 bg-surface-muted uppercase tracking-wide text-muted">
                    <tr className="border-b border-border">
                      <th
                        scope="col"
                        style={{
                          width: "var(--matrix-stt-w)",
                          minWidth: "var(--matrix-stt-w)",
                          maxWidth: "var(--matrix-stt-w)",
                          fontSize: "var(--matrix-fixed-font-size)",
                          padding:
                            "var(--matrix-fixed-cell-py) var(--matrix-fixed-cell-px)",
                        }}
                        className="sticky left-0 z-20 bg-surface-muted text-center align-middle font-medium whitespace-nowrap"
                      >
                        STT
                      </th>
                      <th
                        scope="col"
                        style={{
                          left: "var(--matrix-stt-w)",
                          width: "var(--matrix-name-w)",
                          minWidth: "var(--matrix-name-min-w)",
                          maxWidth: "var(--matrix-name-max-w)",
                          fontSize: "var(--matrix-fixed-font-size)",
                          padding:
                            "var(--matrix-fixed-cell-py) var(--matrix-fixed-name-px)",
                        }}
                        className="sticky z-20 border-r border-border bg-surface-muted align-middle font-medium whitespace-nowrap"
                      >
                        Họ tên
                      </th>
                      {effectiveMatrix.buckets.map((bucket) => {
                        const fullTooltip = formatFullBucketTooltip(bucket);
                        const shortLabel = formatShortBucketLabel(bucket);
                        return (
                          <th
                            key={bucket.key}
                            scope="col"
                            title={fullTooltip}
                            aria-label={fullTooltip}
                            style={{
                              width: "var(--matrix-bucket-min-w)",
                              minWidth: "var(--matrix-bucket-min-w)",
                              fontSize: "var(--matrix-font-size)",
                              padding:
                                "var(--matrix-cell-py) var(--matrix-cell-px)",
                            }}
                            className="bg-surface-muted text-right align-middle font-medium tabular-nums whitespace-nowrap"
                          >
                            {shortLabel}
                          </th>
                        );
                      })}
                      <th
                        scope="col"
                        style={{
                          width: "var(--matrix-total-min-w)",
                          minWidth: "var(--matrix-total-min-w)",
                          fontSize: "var(--matrix-font-size)",
                          padding:
                            "var(--matrix-cell-py) var(--matrix-total-cell-px)",
                        }}
                        className="border-l border-border bg-surface-muted text-right align-middle font-semibold text-foreground whitespace-nowrap md:sticky md:right-0 md:z-20"
                      >
                        Tổng
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {effectiveMatrix.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={3 + effectiveMatrix.buckets.length}
                          className="px-4 py-8 text-center text-sm text-muted"
                        >
                          Không có nhân viên tuyển dụng nào khớp bộ lọc đang chọn.
                        </td>
                      </tr>
                    ) : (
                      effectiveMatrix.rows.map((row) => {
                        const formattedName = formatRecruiterNameWithWorkMonths(
                          row.displayName,
                          row.workMonths,
                        );
                        return (
                          <tr
                            key={row.recruiterId}
                            className="group text-foreground hover:bg-surface-hover"
                          >
                            <td
                              style={{
                                width: "var(--matrix-stt-w)",
                                minWidth: "var(--matrix-stt-w)",
                                maxWidth: "var(--matrix-stt-w)",
                                fontSize: "var(--matrix-fixed-font-size)",
                                padding:
                                  "var(--matrix-fixed-cell-py) var(--matrix-fixed-cell-px)",
                              }}
                              className="sticky left-0 z-10 bg-surface text-center align-middle tabular-nums text-muted group-hover:bg-surface-hover"
                            >
                              {row.stt}
                            </td>
                            <th
                              scope="row"
                              title={formattedName}
                              style={{
                                left: "var(--matrix-stt-w)",
                                width: "var(--matrix-name-w)",
                                minWidth: "var(--matrix-name-min-w)",
                                maxWidth: "var(--matrix-name-max-w)",
                                fontSize: "var(--matrix-fixed-font-size)",
                                padding:
                                  "var(--matrix-fixed-cell-py) var(--matrix-fixed-name-px)",
                              }}
                              className="sticky z-10 truncate border-r border-border bg-surface align-middle font-medium text-foreground group-hover:bg-surface-hover"
                            >
                              {formattedName}
                            </th>
                            {effectiveMatrix.buckets.map((bucket, bucketIdx) => {
                              const count = row.counts[bucketIdx] ?? 0;
                              const ctvCount = row.ctvCounts?.[bucketIdx] ?? 0;
                              return (
                                <td
                                  key={bucket.key}
                                  style={{
                                    width: "var(--matrix-bucket-min-w)",
                                    minWidth: "var(--matrix-bucket-min-w)",
                                    fontSize: "var(--matrix-font-size)",
                                    padding:
                                      "var(--matrix-cell-py) var(--matrix-cell-px)",
                                  }}
                                  className={`text-right align-middle tabular-nums whitespace-nowrap ${
                                    count > 0
                                      ? "font-medium text-foreground"
                                      : "text-muted"
                                  }`}
                                >
                                  {formatDetailedMatrixMetricCell(count, ctvCount, {
                                    showCtv: showCtvCounts,
                                    provider: selectedProvider,
                                  })}
                                </td>
                              );
                            })}
                            <td
                              style={{
                                width: "var(--matrix-total-min-w)",
                                minWidth: "var(--matrix-total-min-w)",
                                fontSize: "var(--matrix-font-size)",
                                padding:
                                  "var(--matrix-cell-py) var(--matrix-total-cell-px)",
                              }}
                              className="border-l border-border bg-surface text-right align-middle font-semibold tabular-nums text-foreground whitespace-nowrap group-hover:bg-surface-hover md:sticky md:right-0 md:z-10"
                            >
                              {formatDetailedMatrixMetricCell(
                                row.total,
                                row.ctvTotal,
                                {
                                  showCtv: showCtvCounts,
                                  provider: selectedProvider,
                                },
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  <tfoot className="border-t-2 border-border bg-surface-muted font-semibold text-foreground">
                    <tr>
                      <th
                        scope="row"
                        colSpan={2}
                        style={{
                          width: "calc(var(--matrix-stt-w) + var(--matrix-name-w))",
                          minWidth:
                            "calc(var(--matrix-stt-w) + var(--matrix-name-min-w))",
                          maxWidth:
                            "calc(var(--matrix-stt-w) + var(--matrix-name-max-w))",
                          fontSize: "var(--matrix-fixed-font-size)",
                          padding:
                            "var(--matrix-fixed-cell-py) var(--matrix-fixed-name-px)",
                        }}
                        className="sticky left-0 z-10 border-r border-border bg-surface-muted text-left align-middle whitespace-nowrap"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span>Tổng cộng</span>
                          <span className="font-normal text-muted">
                            {effectiveMatrix.rows.length} nhân viên
                          </span>
                        </div>
                      </th>
                      {effectiveMatrix.buckets.map((bucket, bucketIdx) => (
                        <td
                          key={bucket.key}
                          style={{
                            width: "var(--matrix-bucket-min-w)",
                            minWidth: "var(--matrix-bucket-min-w)",
                            fontSize: "var(--matrix-font-size)",
                            padding:
                              "var(--matrix-cell-py) var(--matrix-cell-px)",
                          }}
                          className="bg-surface-muted text-right align-middle tabular-nums whitespace-nowrap"
                        >
                          {formatDetailedMatrixMetricCell(
                            effectiveMatrix.columnTotals[bucketIdx] ?? 0,
                            effectiveMatrix.columnCtvTotals?.[bucketIdx] ?? 0,
                            {
                              showCtv: showCtvCounts,
                              provider: selectedProvider,
                            },
                          )}
                        </td>
                      ))}
                      <td
                        style={{
                          width: "var(--matrix-total-min-w)",
                          minWidth: "var(--matrix-total-min-w)",
                          fontSize: "var(--matrix-font-size)",
                          padding:
                            "var(--matrix-cell-py) var(--matrix-total-cell-px)",
                        }}
                        className="border-l border-border bg-surface-muted text-right align-middle font-bold tabular-nums text-primary whitespace-nowrap md:sticky md:right-0 md:z-10"
                      >
                        {formatDetailedMatrixMetricCell(
                          effectiveMatrix.grandTotal,
                          effectiveMatrix.grandCtvTotal,
                          {
                            showCtv: showCtvCounts,
                            provider: selectedProvider,
                          },
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <FloatingTableNav
                containerRef={tableScrollRef}
                tableLabel="Báo cáo chi tiết"
              />
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
