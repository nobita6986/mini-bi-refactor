import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { WorkReportAnalyticsTabs } from "@/components/work-reports/analytics/work-report-analytics-tabs";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { decideWorkReportAnalyticsPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  workReportAnalyticsPredicate,
  workReportViewPredicate,
} from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Theo dõi báo cáo — Mini BI" };

export default async function WorkReportAnalyticsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideWorkReportAnalyticsPageAccess({ actor })) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/work-reports/analytics");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW": {
      const canViewAnalytics = actor?.ok === true && workReportAnalyticsPredicate(actor.actor);
      const canViewSubmissions = actor?.ok === true && workReportViewPredicate(actor.actor);
      return (
        <WorkReportsShell
          actor={actor?.ok ? actor.actor : null}
          active="analytics"
          title="Theo dõi báo cáo"
          description="Theo dõi tổng quan tiến độ, chỉ tiêu KPI và danh sách bài nộp trong phạm vi được cấp quyền."
        >
          <WorkReportAnalyticsTabs
            canViewAnalytics={canViewAnalytics}
            canViewSubmissions={canViewSubmissions}
          />
        </WorkReportsShell>
      );
    }
  }
}
