import { notFound, redirect } from "next/navigation";
import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { decidePersonalWorkReportsPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  resolveActorForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function MyWorkReportsHistoryPage() {
  const enabledFlag = process.env.WORK_REPORTS_API_ENABLED;
  if (enabledFlag !== "true") notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decidePersonalWorkReportsPageAccess({ enabledFlag, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/work-reports/my-reports");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW": {
      const shellActor = await resolveWorkReportShellActorForRequest().catch(() =>
        actor?.ok ? actor.actor : null,
      );
      return (
        <WorkReportsShell
          actor={shellActor}
          active="history"
          title="Lịch sử"
          description="Các báo cáo đã nộp, quá hạn và lịch sử revision của bạn."
        >
          <MyObligations history />
        </WorkReportsShell>
      );
    }
  }
}
