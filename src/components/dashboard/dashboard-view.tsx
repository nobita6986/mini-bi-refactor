import Link from "next/link";

import { buildDailyTrend } from "@/lib/reporting/p1-dashboard";
import {
  computeDashboardSummary,
  formatAvgPerActiveDay,
  formatPeakDayHint,
  type DashboardSummaryMetrics,
} from "@/lib/reporting/p1-dashboard-summary";
import {
  computeCompositionInsights,
  formatSharePct,
} from "@/lib/reporting/p1-dashboard-period";
import type { PeriodComparisonResult } from "@/lib/reporting/p1-period-comparison";
import { buildBarData, buildCategorySegments, buildProjectDonutData } from "@/lib/reporting/p1-chart-data";
import { resolveDashboardMode } from "@/lib/reporting/p3-w06c-audience-view";
import type { ReportingAudience } from "@/lib/reporting/p3-w05a-audience";
import { formatTimestamp } from "@/lib/format";
import type { ReportingData, ReportingBucket } from "@/lib/reporting/p1-reporting";
import type { ReportingFetchResult } from "@/lib/reporting/p1-reporting-server";
import type { ReportingOptionsResult } from "@/lib/reporting/p1-options-server";

import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  BucketList,
  FiltersOrError,
  NoMatchesBlock,
  PeriodComparisonBanner,
  WorkforceStatusSection,
  type WorkforceOverviewResult,
  type WorkforceReportingResult,
} from "./dashboard-shared";
import { BiHighlightScope } from "./bi-cross-highlight";
import { EmploymentComposition } from "./employment-composition";
import { KpiCard } from "./kpi-card";
import { OwnDashboardView } from "./own-dashboard-view";
import { ProjectDonut } from "./project-donut";
import { ProjectProviderMixCard } from "./project-provider-mix";
import { ProviderDonut } from "./provider-donut";
import { RecruiterBarChart } from "./recruiter-bar-chart";
import { TeamDashboardView } from "./team-dashboard-view";
import { TrendChart } from "./trend-chart";
import { BodDashboardTabs } from "./bod-dashboard-tabs";

function FullList({ buckets }: { buckets: Record<string, ReportingBucket> }) {
  return <BucketList buckets={buckets} />;
}

export function DashboardView({
  report,
  optionsResult,
  audience,
  canViewCccdReview,
  canViewDuplicateCccd,
  canViewOffboarding,
}: {
  report: ReportingFetchResult;
  optionsResult: ReportingOptionsResult;
  /** DB-authoritative audience from the scoped payload; null fails closed. */
  audience: ReportingAudience | null;
  /** PRE-WAVE-2: server-derived visibility for the "Review thông tin NLĐ" tab. */
  canViewCccdReview?: boolean;
  /** PRE-W2-HF-C: server-derived visibility for the "Báo cáo CCCD trùng" tab. */
  canViewDuplicateCccd: boolean;
  /** Server-derived visibility for the offboarding report tab. */
  canViewOffboarding: boolean;
}) {
  // P3-W06C: the audience is DB-authoritative (W05A scoped payload); it is never
  // inferred from a UI role. A failed read, or a successful read without a usable
  // audience, is an error mode: no facts are rendered and no scope is claimed.
  const mode = resolveDashboardMode({ ok: report.ok, audience });

  if (!report.ok) {
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
        <ReportError report={report} />
      </main>
    );
  }

  if (mode.kind === "error") {
    // Fail closed: the read succeeded but the DB did not confirm a scope, so no
    // fact row may be rendered under a guessed audience label.
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
        <ErrorState
          title="Không xác định được phạm vi báo cáo"
          detail="Phiên hiện tại chưa có phạm vi báo cáo hợp lệ nên dữ liệu không được hiển thị. Vui lòng tải lại trang; nếu vẫn lỗi, liên hệ quản trị viên."
        />
      </main>
    );
  }

  if (mode.kind === "team") {
    return (
      <BodDashboardTabs
        general={
          <TeamDashboardView
            data={report.data}
            generatedAt={report.generatedAt}
            comparison={report.comparison}
            optionsResult={optionsResult}
            view={mode.view}
          />
        }
        primaryTabLabel="Báo cáo theo nhóm"
        data={report.data}
        generatedAt={report.generatedAt}
        optionsResult={optionsResult}
        canViewCccdReview={canViewCccdReview}
        canViewDuplicateCccd={canViewDuplicateCccd}
        canViewOffboarding={canViewOffboarding}
      />
    );
  }

  if (mode.kind === "own") {
    return (
      <BodDashboardTabs
        general={
          <OwnDashboardView
            data={report.data}
            generatedAt={report.generatedAt}
            comparison={report.comparison}
            optionsResult={optionsResult}
            view={mode.view}
          />
        }
        primaryTabLabel="Tổng quan cá nhân"
        data={report.data}
        generatedAt={report.generatedAt}
        optionsResult={optionsResult}
        canViewCccdReview={canViewCccdReview}
        canViewDuplicateCccd={canViewDuplicateCccd}
        canViewOffboarding={canViewOffboarding}
      />
    );
  }

  const generatedAt = report.ok ? report.generatedAt : undefined;
  const summary = computeDashboardSummary(report.data);
  const trend = report.ok ? buildDailyTrend(report.data.byDate, report.data.applied.from, report.data.applied.to) : [];
  const dataDays = trend.filter((p) => p.count > 0);
  const showKpis = report.ok && !report.data.empty.noSources && !report.data.empty.noFacts && !report.data.empty.noMatches;
  return (
    <BodDashboardTabs
      data={report.data}
      generatedAt={generatedAt}
      optionsResult={optionsResult}
      canViewCccdReview={canViewCccdReview}
      canViewDuplicateCccd={canViewDuplicateCccd}
      canViewOffboarding={canViewOffboarding}
      general={
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 sm:px-6">
          <header className="rounded-[10px] border border-border border-l-4 border-l-primary bg-surface px-5 py-4 shadow-[var(--shadow-card)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="inline-flex items-center rounded-md bg-[var(--selected-bg)] px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider text-primary">BoD · Báo cáo điều hành</p>
                <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-[var(--navy)] sm:text-2xl">Tổng quan tuyển dụng</h1>
                <p className="mt-1 max-w-2xl text-sm text-muted">Lượt tuyển ghi nhận theo ngày, dự án, người tuyển, HRP/Vendor và loại hình.</p>
                {generatedAt ? (
                  <p className="mt-1.5 text-xs text-muted">Báo cáo tạo lúc: <time className="font-mono text-[var(--navy)]">{formatTimestamp(generatedAt)}</time></p>
                ) : null}
              </div>
              {showKpis ? (
                <div aria-label="Chỉ số chính" className="grid w-full grid-cols-2 gap-2.5 sm:w-auto sm:min-w-72 sm:grid-cols-2">
                  <KpiCard variant="compact" label="Tổng tuyển mới" value={summary.recruitedTotal} hint="lượt tuyển ghi nhận" accent="var(--primary)" />
                  <KpiCard variant="compact" label="Số ngày có tuyển" value={summary.activeHiringDays} hint="trong khoảng hiển thị" accent="var(--secondary)" />
                </div>
              ) : null}
            </div>
          </header>

          <div className="mt-4">
            <DashboardBody
              data={report.data}
              summary={summary}
              comparison={report.comparison}
              workforce={report.workforce}
              optionsResult={optionsResult}
              trend={trend}
              dataDays={dataDays}
            />
          </div>
        </main>
      }
    />
  );
}

function ReportError({ report }: { report: Extract<ReportingFetchResult, { ok: false }> }) {
  if (report.code === "INVALID_FILTER") {
    return (
      <div role="alert" className="rounded-2xl border border-status-danger-border bg-status-danger-bg px-6 py-10 text-status-danger-text">
        <p className="mt-2 text-sm font-semibold">Bộ lọc không hợp lệ</p>
        <p className="mt-2 text-sm">{report.message}</p>
        <p className="mt-4">
          <Link href="/dashboard" className="inline-flex min-h-11 h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
            Xóa bộ lọc
          </Link>
        </p>
      </div>
    );
  }
  if (report.code === "REPORTING_CUTOVER_BLOCKER") {
    return (
      <div role="alert" className="rounded-2xl border border-status-warning-border bg-status-warning-bg px-6 py-10 text-status-warning-text">
        <p className="text-sm font-semibold">Cutover đang chặn báo cáo</p>
        <p className="mt-2 text-sm">{report.message}</p>
        <p className="mt-4">
          <Link href="/dashboard" className="inline-flex min-h-11 h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary/90">
            Tải lại không kèm bộ lọc
          </Link>
        </p>
      </div>
    );
  }
  return <ErrorState title="Không tải được báo cáo" detail={report.code + " · " + report.message} />;
}

function DashboardBody({
  data,
  summary,
  comparison,
  workforce,
  optionsResult,
  trend,
  dataDays,
}: {
  data: ReportingData;
  summary: DashboardSummaryMetrics;
  comparison?: PeriodComparisonResult;
  workforce?: WorkforceOverviewResult | WorkforceReportingResult;
  optionsResult: ReportingOptionsResult;
  trend: ReturnType<typeof buildDailyTrend>;
  dataDays: ReturnType<typeof buildDailyTrend>;
}) {

  if (data.empty.noSources || data.empty.noFacts) {
    return (
      <div className="space-y-4">
        <FiltersOrError optionsResult={optionsResult} />
        <EmptyState title="Chưa có dữ liệu tuyển dụng" description="Hiện chưa có dữ liệu để hiển thị. Hãy điều chỉnh bộ lọc hoặc tải lại trang sau." />
        <WorkforceStatusSection workforce={workforce} />
      </div>
    );
  }

  const insights = computeCompositionInsights(data);
  const projectSlices = buildProjectDonutData(data.byProject);
  const recruiterBars = buildBarData(data.byRecruiter, 10);

  return (
    <div className="space-y-4">
      <FiltersOrError optionsResult={optionsResult} />
      <PeriodComparisonBanner comparison={comparison} />

      {data.empty.noMatches ? (
        <NoMatchesBlock />
      ) : (
        <>
          <section aria-label="Chỉ số tổng hợp tuyển dụng" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <KpiCard
              variant="compact"
              label="Recruiter có phát sinh tuyển"
              value={summary.activeRecruiterBucketCount}
              hint="bucket theo khóa báo cáo"
              accent="var(--primary)"
            />
            <KpiCard
              variant="compact"
              label="Dự án có tuyển"
              value={summary.activeProjectBucketCount}
              hint="dự án có phát sinh"
              accent="var(--secondary)"
            />
            <KpiCard
              variant="compact"
              label="Trung bình/ngày có tuyển"
              value={formatAvgPerActiveDay(summary.avgPerActiveDay)}
              hint="lượt tuyển / ngày có tuyển"
              accent="var(--primary)"
            />
            <KpiCard
              variant="compact"
              label="Đỉnh tuyển/ngày"
              value={summary.peakDailyCount ?? "—"}
              hint={formatPeakDayHint(summary)}
              accent="var(--secondary)"
            />
          </section>

          <section aria-label="Xu hướng tuyển dụng">
            <Card className="p-4">
              <CardHeader title="Xu hướng tuyển dụng" description="Số người tuyển theo ngày; những ngày không có record thể hiện là 0 trên biểu đồ." />
              <TrendChart data={trend} from={data.applied.from} to={data.applied.to} />
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-primary">
                  Xem chi tiết {dataDays.length} ngày
                </summary>
                <div className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface">
                  <table className="r22-report-table w-full min-w-[300px] text-left text-sm">
                    <caption className="sr-only">Bảng số người tuyển theo ngày (chỉ các ngày có tuyển dụng)</caption>
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

          <section aria-label="Phân bổ tuyển dụng" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <Card className="p-4 lg:col-span-7">
              <CardHeader title="Theo dự án" description="Phân bổ tuyển dụng theo dự án (tỷ trọng trên tập kết quả đang lọc)." />
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
                <ProjectDonut slices={projectSlices} title="Biểu đồ theo dự án" />
                <FullList buckets={data.byProject} />
              </BiHighlightScope>
            </Card>
            <Card className="p-4 lg:col-span-5">
              <CardHeader title="Theo HRP/Vendor" description="Tỷ trọng trên tập kết quả đang lọc." />
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
                    Đang lọc theo HRP/Vendor (chỉ phản ánh tập đang lọc, không phải cơ cấu toàn công ty).
                  </p>
                ) : null}
              </div>
              <ProviderDonut segments={buildCategorySegments(data.byProvider)} title="Biểu đồ HRP/Vendor" />
            </Card>
            <Card className="p-4 lg:col-span-12">
              <CardHeader
                title="Tỷ lệ HRP/Vendor theo dự án"
                description="Tỷ trọng Vendor/HRP trong phần đã phân loại của từng dự án; “Không xác định” và “Không hợp lệ” không nằm trong mẫu số."
              />
              <ProjectProviderMixCard mix={data.projectProviderMix} providerFilterActive={Boolean(data.applied.provider)} />
            </Card>
            <Card className="p-4 lg:col-span-7">
              <CardHeader title="Theo người tuyển" description="Top 10 người tuyển theo số người tuyển." />
              <BiHighlightScope validKeys={Object.keys(data.byRecruiter)}>
                <RecruiterBarChart data={recruiterBars} title="Biểu đồ theo người tuyển" />
                <FullList buckets={data.byRecruiter} />
              </BiHighlightScope>
            </Card>
            <Card className="p-4 lg:col-span-5">
              <CardHeader title="Theo loại hình làm việc" description="Tỷ trọng trên tập kết quả đang lọc." />
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
              <EmploymentComposition segments={buildCategorySegments(data.byEmployment)} title="Biểu đồ loại hình làm việc" />
            </Card>
          </section>
        </>
      )}

      <WorkforceStatusSection workforce={workforce} />
    </div>
  );
}
