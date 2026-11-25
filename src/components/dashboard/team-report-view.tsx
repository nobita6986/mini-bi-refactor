"use client";

import { useEffect, useRef, useState } from "react";

import { buildCategorySegments, buildProjectDonutData } from "@/lib/reporting/p1-chart-data";
import { buildDailyTrend, sortBuckets } from "@/lib/reporting/p1-dashboard";
import {
  computeDashboardSummary,
  formatAvgPerActiveDay,
  formatPeakDayHint,
} from "@/lib/reporting/p1-dashboard-summary";
import {
  computeCompositionInsights,
  formatSharePct,
} from "@/lib/reporting/p1-dashboard-period";
import type { PeriodComparisonResult } from "@/lib/reporting/p1-period-comparison";
import { buildMemberContributions } from "@/lib/reporting/p3-w06c-audience-view";
import { formatTimestamp } from "@/lib/format";
import type { ReportingBucket, ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";
import type { TeamReportDetail } from "@/lib/reporting/p3-w06d-team-report-server";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { BiHighlightScope } from "./bi-cross-highlight";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { ProjectProviderMixCard } from "./project-provider-mix";
import { TrendChart } from "./trend-chart";
import { BucketList, FiltersOrError, NoMatchesBlock, PeriodComparisonBanner, ScopeNote } from "./dashboard-shared";
import { TeamBucketChart } from "./team-bucket-chart";
import { TeamEntryDetail } from "./team-entry-detail";
import { teamReportDataSignature, teamReportUrl } from "./team-report-request";

/**
 * P3-W06D-R2 - single shared team-report implementation.
 *
 * Used by BOTH audiences:
 *   - the Team Leader report (`TeamDashboardView`, DB audience `team`), and
 *   - the BoD "Báo cáo chi tiết nhóm" tab (`BodDashboardTabs`, DB audience `all`).
 *
 * The team picker lists the buckets the actor is authorized to see
 * (`data.byTeam`). Selecting one loads THAT team's report from the single
 * server-authorized endpoint `GET /api/reporting/team-report`; the same
 * endpoint serves the trailing entry-level detail. Authority is never inferred
 * here: the server re-resolves the audience and verifies the bucket, and a
 * denied bucket surfaces as an error instead of data.
 *
 * With no team selected the `requireTeamSelection` flag decides what is shown:
 * the Team Leader (audience `team`) still renders its DB-scoped report, while
 * the BoD (audience `all`) renders ONLY the picker until a team is chosen, so
 * company-wide figures can never read as a team report. When a filter change
 * resets the selection the body disappears immediately. The entry-level detail
 * is always the LAST section.
 */

export interface TeamReportViewConfig {
  eyebrow: string;
  title: string;
  description: string;
  scopeNote: string;
  emptyTitle: string;
  emptyDescription: string;
  noMatchesDetail: string;
  showMemberRanking: boolean;
  showProjectProviderMix: boolean;
  showRecruiterFilter: boolean;
  /**
   * P3-W06D-R3: when true (BoD / audience `all`) NO report body is rendered
   * until a team is explicitly selected, so company-wide figures can never be
   * mistaken for a team report. The Team Leader keeps `false`.
   */
  requireTeamSelection: boolean;
  kpiAriaLabel: string;
  kpiPrimaryLabel: string;
  kpiPrimaryHint: string;
  kpiSecondaryLabel: string;
  kpiSecondaryHint: string;
  memberTitle: string;
  memberDescription: string;
  memberAriaLabel: string;
  pickerHeading: string;
  pickerDescription: string;
  pickerTitle: string;
}

function isTeamReportPayload(value: unknown): value is {
  report: ReportingData | null;
  detail: TeamReportDetail;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as Partial<TeamReportDetail>;
  if (!Array.isArray(d.rows)) return false;
  if (!(typeof d.nextCursor === "string" || d.nextCursor === null)) return false;
  if (typeof d.total !== "number") return false;
  const report = record.report;
  if (report === null) return true;
  if (typeof report !== "object" || report === null) return false;
  const r = report as Partial<ReportingData>;
  return typeof r.recruitedTotal === "number"
    && typeof r.byDate === "object" && r.byDate !== null
    && typeof r.byTeam === "object" && r.byTeam !== null
    && typeof r.empty === "object" && r.empty !== null;
}

export function TeamReportView({
  data,
  generatedAt,
  comparison,
  optionsResult,
  view,
}: {
  data: ReportingData;
  generatedAt?: string;
  comparison?: PeriodComparisonResult;
  optionsResult: ReportingOptionsResult;
  view: TeamReportViewConfig;
}) {
  const dataSignature = teamReportDataSignature(data);
  const buckets = sortBuckets(data.byTeam);
  const [selection, setSelection] = useState<{ signature: string; key: string } | null>(null);
  // A selection only survives while the DB-applied filters are unchanged. A
  // single-bucket scope (e.g. one-team leader) resolves to that bucket so its
  // detail is visible without an extra click, but only when the view does NOT
  // require an explicit selection (BoD always picks a team).
  const selectedKey = selection !== null && selection.signature === dataSignature
    ? selection.key
    : !view.requireTeamSelection && buckets.length === 1 ? buckets[0].key : null;
  const selectedBucket = selectedKey === null ? null : buckets.find((bucket) => bucket.key === selectedKey) ?? null;

  return (
    <>
      <header className="rounded-[10px] border border-border border-l-4 border-l-primary bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
        <div className="min-w-0 flex-1">
          <p className="inline-flex items-center rounded-md bg-[var(--selected-bg)] px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider text-primary">{view.eyebrow}</p>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--navy)] sm:text-2xl">{view.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">{view.description}</p>
          {generatedAt ? (
            <p className="mt-1.5 text-xs text-muted">
              Báo cáo tạo lúc: <time className="font-mono text-[var(--navy)]">{formatTimestamp(generatedAt)}</time>
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <ScopeNote label="Phạm vi báo cáo nhóm">{view.scopeNote}</ScopeNote>
        <FiltersOrError optionsResult={optionsResult} showRecruiter={view.showRecruiterFilter} />
        {!view.requireTeamSelection && !data.empty.noSources && !data.empty.noFacts ? (
          <PeriodComparisonBanner comparison={comparison} />
        ) : null}

        {buckets.length > 0 ? (
          <TeamPicker
            buckets={buckets}
            selectedKey={selectedKey}
            view={view}
            onSelect={(key) => setSelection({ signature: dataSignature, key })}
          />
        ) : null}

        {selectedBucket !== null ? (
          <TeamReportSelection
            key={dataSignature + "|" + selectedBucket.key}
            data={data}
            bucket={selectedBucket}
            view={view}
          />
        ) : view.requireTeamSelection ? (
          <p role="status" className="rounded-2xl border border-dashed border-border bg-muted/10 px-4 py-6 text-center text-sm text-muted">
            Chọn một nhóm trong danh sách để xem báo cáo chi tiết của nhóm đó.
          </p>
        ) : (
          <TeamReportBody data={data} view={view} />
        )}
      </div>
    </>
  );
}

/**
 * The selected team's report: fetched from the server-authorized team-report
 * endpoint. Mounted keyed by the selection + filter signature, so a change
 * re-fetches from a clean state; state is only ever set from the async
 * response (never synchronously in the effect body).
 */
function TeamReportSelection({
  data,
  bucket,
  view,
}: {
  data: ReportingData;
  bucket: ReportingBucket;
  view: TeamReportViewConfig;
}) {
  const notify = useNotify();
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  const [report, setReport] = useState<ReportingData | null>(null);
  const [detail, setDetail] = useState<TeamReportDetail | null>(null);
  const [error, setError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(teamReportUrl(data, bucket.key, null), {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!response.ok || !isTeamReportPayload(payload) || payload.report === null) {
          setError(true);
          if (reloadToken > 0) {
            notifyRef.current.error({
              title: "Không tải được báo cáo nhóm",
              description: "Không tải được báo cáo của nhóm đã chọn. Hãy thử lại.",
              dedupeKey: `team-report-retry:${bucket.key}`,
            });
          }
          return;
        }
        setError(false);
        setReport(payload.report);
        setDetail(payload.detail);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(true);
          if (reloadToken > 0) {
            notifyRef.current.error({
              title: "Không tải được báo cáo nhóm",
              description: "Không tải được báo cáo của nhóm đã chọn. Hãy thử lại.",
              dedupeKey: `team-report-retry:${bucket.key}`,
            });
          }
        }
      });
    return () => controller.abort();
  }, [data, bucket, reloadToken]);

  if (error) {
    return (
      <Alert tone="error" role="alert" title="Không tải được báo cáo nhóm">
        <p>Không tải được báo cáo của nhóm đã chọn. Hãy thử lại.</p>
        <button type="button" onClick={() => setReloadToken((n) => n + 1)} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">Thử tải lại</button>
      </Alert>
    );
  }
  if (report === null || detail === null) {
    return <p role="status">Đang tải báo cáo nhóm…</p>;
  }
  return (
    <>
      <TeamReportBody data={report} view={view} />
      <section aria-label="Danh sách chi tiết từng dòng">
        <TeamEntryDetail data={data} bucket={bucket} initialDetail={detail} />
      </section>
    </>
  );
}

function TeamPicker({
  buckets,
  selectedKey,
  view,
  onSelect,
}: {
  buckets: ReportingBucket[];
  selectedKey: string | null;
  view: TeamReportViewConfig;
  onSelect(key: string): void;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const validBucketKeys = new Set(buckets.map((b) => b.key));
  const activeHighlightKey =
    hoveredKey !== null && validBucketKeys.has(hoveredKey)
      ? hoveredKey
      : focusedKey !== null && validBucketKeys.has(focusedKey)
        ? focusedKey
        : selectedKey !== null && validBucketKeys.has(selectedKey)
          ? selectedKey
          : null;

  return (
    <Card>
      <CardHeader title={view.pickerHeading} description={view.pickerDescription} />
      <TeamBucketChart
        buckets={buckets}
        highlightedKey={activeHighlightKey}
        onHoverKey={setHoveredKey}
      />
      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-foreground">{view.pickerTitle}</h3>
        <ul aria-label="Danh sách nhóm báo cáo" className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {buckets.map((bucket) => {
            const isHighlighted = activeHighlightKey === bucket.key && selectedKey !== bucket.key;
            return (
              <li key={bucket.key}>
                <button
                  type="button"
                  aria-pressed={selectedKey === bucket.key}
                  onMouseEnter={() => setHoveredKey(bucket.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                  onFocus={() => setFocusedKey(bucket.key)}
                  onBlur={() => setFocusedKey(null)}
                  onClick={() => onSelect(bucket.key)}
                  className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors duration-[var(--ui-motion-hover,160ms)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 ${selectedKey === bucket.key
                    ? "border-primary bg-primary/10 text-foreground"
                    : isHighlighted
                      ? "border-primary/40 bg-primary/5 text-foreground"
                      : "border-border bg-surface text-foreground hover:bg-muted/10"}`}
                >
                  <span className="min-w-0 break-words">{bucket.display}</span>
                  <span className="shrink-0 font-mono tabular-nums">{bucket.recruitedCount}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

function TeamReportBody({ data, view }: { data: ReportingData; view: TeamReportViewConfig }) {
  const summary = computeDashboardSummary(data);
  const insights = computeCompositionInsights(data);
  const projectSlices = buildProjectDonutData(data.byProject);
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const members = buildMemberContributions(data.byRecruiter);
  const noData = data.empty.noSources || data.empty.noFacts;
  const memberTotal = members.reduce((a, m) => a + m.count, 0);
  const averagePerMember = members.length > 0 ? Math.round((memberTotal / members.length) * 10) / 10 : 0;

  if (noData) {
    return <EmptyState title={view.emptyTitle} description={view.emptyDescription} />;
  }
  if (data.empty.noMatches) {
    return <NoMatchesBlock detail={view.noMatchesDetail} />;
  }

  return (
    <>
      <dl aria-label={view.kpiAriaLabel} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard variant="compact" label={view.kpiPrimaryLabel} value={summary.recruitedTotal} hint={view.kpiPrimaryHint} accent="var(--primary)" />
        <KpiCard variant="compact" label={view.kpiSecondaryLabel} value={summary.activeRecruiterBucketCount} hint={view.kpiSecondaryHint} accent="var(--secondary)" />
        <KpiCard variant="compact" label="Dự án có tuyển" value={summary.activeProjectBucketCount} hint="dự án có phát sinh" accent="var(--primary)" />
        <KpiCard variant="compact" label="Số ngày có tuyển" value={summary.activeHiringDays} hint="trong khoảng hiển thị" accent="var(--secondary)" />
        <KpiCard variant="compact" label="Trung bình/ngày có tuyển" value={formatAvgPerActiveDay(summary.avgPerActiveDay)} hint="lượt tuyển / ngày có tuyển" accent="var(--primary)" />
        <KpiCard variant="compact" label="Đỉnh tuyển/ngày" value={summary.peakDailyCount ?? "—"} hint={formatPeakDayHint(summary)} accent="var(--secondary)" />
      </dl>

      {view.showMemberRanking ? (
        <section aria-label={view.memberAriaLabel}>
          <Card>
            <CardHeader title={view.memberTitle} description={view.memberDescription} />
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted">Tổng nhóm</p>
                <p className="mt-0.5 font-semibold text-foreground">{memberTotal}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted">Thành viên có tuyển</p>
                <p className="mt-0.5 font-semibold text-foreground">{members.length}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/10 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted">Trung bình/người</p>
                <p className="mt-0.5 font-semibold text-foreground">{averagePerMember}</p>
              </div>
            </div>
            {members.length === 0 ? (
              <p className="text-sm text-muted">Chưa có thành viên nào có dữ liệu trong bộ lọc hiện tại.</p>
            ) : (
              <ul className="space-y-2">
                {members.map((m) => (
                  <li key={m.key} className="grid grid-cols-1 gap-1 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,7rem)] md:items-center md:gap-3">
                    <span className="min-w-0 truncate text-sm text-foreground" title={m.display}>{m.display}</span>
                    <span
                      role="img"
                      aria-label={m.display + ": " + m.count + " người"}
                      className="flex h-3 w-full overflow-hidden rounded-full border border-border bg-muted/15"
                    >
                      <span className="h-full bg-primary" style={{ width: (m.share === null ? 0 : Math.round(m.share * 100)) + "%" }} />
                    </span>
                    <span className="text-xs md:text-right">
                      <span className="font-medium text-foreground">{m.count} người</span>
                      <span className="block text-muted">{m.share === null ? "—" : Math.round(m.share * 100) + "%"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      ) : null}

      <section aria-label="Xu hướng tuyển dụng của nhóm">
        <Card>
          <CardHeader title="Xu hướng tuyển dụng của nhóm" description="Số người tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
          <TrendChart data={trend} from={data.applied.from} to={data.applied.to} />
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-primary">
              Xem chi tiết {dataDays.length} ngày
            </summary>
            <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface">
              <table className="r22-report-table w-full text-left text-sm">
                <caption className="sr-only">Bảng số người tuyển theo ngày trong nhóm (chỉ các ngày có tuyển dụng)</caption>
                <thead className="sticky top-0 bg-surface-muted text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-border">
                    <th className="px-3 py-1.5 font-medium">Ngày</th>
                    <th className="px-3 py-1.5 text-right font-medium">Số người</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {dataDays.map((p) => (
                    <tr key={p.date} className="text-foreground hover:bg-surface-hover">
                      <td className="px-3 py-1.5 font-mono tabular-nums whitespace-nowrap text-xs">{p.date}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Card>
      </section>

      <section aria-label="Phân bổ tuyển dụng của nhóm" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader title="Theo dự án trong nhóm" description="Phân bổ tuyển dụng của nhóm theo dự án (tỷ trọng trên tập đang lọc)." />
          {insights.leadingProject ? (
            <p className="mb-3 rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-foreground">
              Dự án dẫn đầu (tập đang lọc): <span className="font-semibold">{insights.leadingProject.display}</span>
              {" — "}
              <span className="font-mono tabular-nums">{insights.leadingProject.count}</span> lượt (
              <span className="font-mono tabular-nums">{formatSharePct(insights.leadingProject.shareOfFilteredPct)}</span>)
            </p>
          ) : null}
          <BiHighlightScope
            validKeys={Object.keys(data.byProject)}
            topSliceKeys={projectSlices.filter((s) => s.key !== "__other__").map((s) => s.key)}
          >
            <ProjectDonut slices={projectSlices} title="Biểu đồ theo dự án của nhóm" />
            <BucketList buckets={data.byProject} />
          </BiHighlightScope>
        </Card>
        <Card className="lg:col-span-5">
          <CardHeader title="Theo loại hình làm việc của nhóm" description="Tỷ trọng trên tập đang lọc." />
          <div className="mb-3 space-y-1 rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs">
            <p className="text-foreground">
              Thời vụ: <span className="font-mono font-medium">{insights.employment.seasonalCount}</span> ({formatSharePct(insights.employment.seasonalSharePct)})
              {" · "}
              Chính thức: <span className="font-mono font-medium">{insights.employment.permanentCount}</span> ({formatSharePct(insights.employment.permanentSharePct)})
            </p>
            {insights.employment.unclassifiedTotal > 0 ? (
              <p className="text-muted">
                Không xác định: <span className="font-mono">{insights.employment.unknownCount}</span>
                {" · "}
                Không hợp lệ: <span className="font-mono">{insights.employment.invalidCount}</span>
              </p>
            ) : null}
          </div>
          <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc của nhóm" />
        </Card>
        {view.showProjectProviderMix ? (
          <Card className="lg:col-span-12">
            <CardHeader
              title="Tỷ lệ HRP/Vendor theo dự án của nhóm"
              description="Tỷ trọng Vendor/HRP trong phần đã phân loại của từng dự án trong nhóm; “Không xác định” và “Không hợp lệ” không nằm trong mẫu số."
            />
            <ProjectProviderMixCard mix={data.projectProviderMix} providerFilterActive={Boolean(data.applied.provider)} />
          </Card>
        ) : null}
      </section>
    </>
  );
}
