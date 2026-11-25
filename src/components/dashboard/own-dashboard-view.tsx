import { buildCategorySegments, buildProjectDonutData } from "@/lib/reporting/p1-chart-data";
import { buildDailyTrend } from "@/lib/reporting/p1-dashboard";
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
import type { ScopedDashboardView } from "@/lib/reporting/p3-w06c-audience-view";
import { formatTimestamp } from "@/lib/format";
import type { ReportingData } from "@/lib/reporting/p1-reporting";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { BiHighlightScope } from "./bi-cross-highlight";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { ProjectDonut } from "./project-donut";
import { ProviderDonut } from "./provider-donut";
import { TrendChart } from "./trend-chart";
import { BucketList, FiltersOrError, NoMatchesBlock, PeriodComparisonBanner, ScopeNote } from "./dashboard-shared";

/**
 * P3-W06C - Own dashboard (audience `own`).
 *
 * Personal view: only what the DB-authoritative W05A read path returned for the
 * signed-in recruiter identity. There is no member roster, no company ranking
 * and no recruiter filter, because the scope is already a single person.
 */

export function OwnDashboardView({
  data,
  generatedAt,
  comparison,
  optionsResult,
  view,
}: {
  data: ReportingData;
  generatedAt: string;
  comparison?: PeriodComparisonResult;
  optionsResult: ReportingOptionsResult;
  view: ScopedDashboardView;
}) {
  const summary = computeDashboardSummary(data);
  const insights = computeCompositionInsights(data);
  const projectSlices = buildProjectDonutData(data.byProject);
  const trend = buildDailyTrend(data.byDate, data.applied.from, data.applied.to);
  const dataDays = trend.filter((p) => p.count > 0);
  const noData = data.empty.noSources || data.empty.noFacts;
  const showData = !noData && !data.empty.noMatches;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
      <header className="rounded-[10px] border border-border border-l-4 border-l-primary bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
          {showData ? (
            <dl aria-label="Chỉ số cá nhân" className="grid w-full grid-cols-2 gap-2.5 sm:w-auto sm:min-w-80 sm:grid-cols-2">
              <KpiCard variant="compact" label="Tuyển mới của tôi" value={summary.recruitedTotal} hint="lượt tuyển ghi nhận" accent="var(--primary)" />
              <KpiCard variant="compact" label="Ngày tôi có tuyển" value={summary.activeHiringDays} hint="trong khoảng hiển thị" accent="var(--secondary)" />
            </dl>
          ) : null}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        <ScopeNote label="Phạm vi báo cáo cá nhân">{view.scopeNote}</ScopeNote>
        <FiltersOrError optionsResult={optionsResult} showRecruiter={view.showRecruiterFilter} />
        {!noData ? <PeriodComparisonBanner comparison={comparison} /> : null}

        {noData ? (
          <EmptyState title={view.emptyTitle} description={view.emptyDescription} />
        ) : data.empty.noMatches ? (
          <NoMatchesBlock detail="Không có ngày/dự án nào trong hồ sơ của bạn khớp bộ lọc đang chọn." />
        ) : (
          <>
            <section aria-label="Tóm tắt cá nhân" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <Card className="lg:col-span-5">
                <CardHeader title="Tóm tắt của tôi" description="Số liệu tổng hợp trong phạm vi hồ sơ tuyển dụng của bạn." />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
                  <KpiCard
                    variant="compact"
                    label="Dự án có tuyển"
                    value={summary.activeProjectBucketCount}
                    hint="dự án có phát sinh"
                    accent="var(--primary)"
                  />
                  <KpiCard
                    variant="compact"
                    label="Trung bình/ngày có tuyển"
                    value={formatAvgPerActiveDay(summary.avgPerActiveDay)}
                    hint="lượt tuyển / ngày có tuyển"
                    accent="var(--secondary)"
                  />
                  <KpiCard
                    variant="compact"
                    label="Đỉnh tuyển/ngày"
                    value={summary.peakDailyCount ?? "—"}
                    hint={formatPeakDayHint(summary)}
                    accent="var(--primary)"
                  />
                </div>
              </Card>
              <Card className="lg:col-span-7">
                <CardHeader title="Theo dự án của tôi" description="Phân bổ tuyển dụng của bạn theo dự án (tỷ trọng trên tập đang lọc)." />
                {insights.leadingProject ? (
                  <p className="mb-3 rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs text-foreground">
                    Dự án dẫn đầu (tập đang lọc): <span className="font-semibold">{insights.leadingProject.display}</span>
                    {" — "}
                    <span className="font-mono tabular-nums">{insights.leadingProject.count}</span> lượt (
                    <span className="font-mono tabular-nums">{formatSharePct(insights.leadingProject.shareOfFilteredPct)}</span>)
                    {insights.leadingProject.tiedOtherCount > 0
                      ? ` · đồng dẫn đầu với ${insights.leadingProject.tiedOtherCount} dự án khác`
                      : ""}
                  </p>
                ) : null}
                <BiHighlightScope
                  validKeys={Object.keys(data.byProject)}
                  topSliceKeys={projectSlices.filter((s) => s.key !== "__other__").map((s) => s.key)}
                >
                  <ProjectDonut slices={projectSlices} title="Biểu đồ theo dự án của tôi" />
                  <BucketList buckets={data.byProject} />
                </BiHighlightScope>
              </Card>
            </section>

            <section aria-label="Xu hướng tuyển dụng của tôi">
              <Card>
                <CardHeader title="Xu hướng tuyển dụng của tôi" description="Số người bạn tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
                <TrendChart data={trend} from={data.applied.from} to={data.applied.to} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-primary">
                    Xem chi tiết {dataDays.length} ngày
                  </summary>
                  <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface">
                    <table className="r22-report-table w-full text-left text-sm">
                      <caption className="sr-only">Bảng số người bạn tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
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

            <section aria-label="Loại hình làm việc của tôi" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <Card className="lg:col-span-6">
                <CardHeader title="Theo HRP/Vendor của tôi" description="Tỷ trọng trên tập đang lọc." />
                <div className="mb-3 space-y-1 rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs">
                  <p className="text-foreground">
                    HRP: <span className="font-mono font-medium">{insights.provider.hrpCount}</span> ({formatSharePct(insights.provider.hrpShareOfTotalPct)})
                    {" · "}
                    Vendor: <span className="font-mono font-medium">{insights.provider.vendorCount}</span> ({formatSharePct(insights.provider.vendorShareOfTotalPct)})
                  </p>
                  {insights.provider.unclassifiedTotal > 0 ? (
                    <p className="text-muted">
                      Không xác định: <span className="font-mono">{insights.provider.unknownCount}</span>
                      {" · "}
                      Không hợp lệ: <span className="font-mono">{insights.provider.invalidCount}</span>
                      {" · "}
                      Độ phủ phân loại: <span className="font-mono">{insights.provider.classifiedTotal}/{insights.provider.total}</span> ({formatSharePct(insights.provider.classifiedCoveragePct)})
                    </p>
                  ) : null}
                  {insights.provider.providerFilterActive ? (
                    <p className="text-muted">
                      Đang lọc theo HRP/Vendor (chỉ phản ánh tập đang lọc, không phải toàn bộ hồ sơ của bạn).
                    </p>
                  ) : null}
                </div>
                <ProviderDonut segments={buildCategorySegments(data.byProvider)} title="Biểu đồ HRP/Vendor của tôi" />
              </Card>
              <Card className="lg:col-span-6">
                <CardHeader title="Theo loại hình làm việc của tôi" description="Tỷ trọng trên tập đang lọc." />
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
                <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc của tôi" />
              </Card>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
