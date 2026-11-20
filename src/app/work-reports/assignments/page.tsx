import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { AssignmentManager } from "@/components/work-reports/renderer/assignment-manager";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { decideWorkReportAssignmentsPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  resolveActorForRequest,
  resolveWorkReportAssignmentAccessForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function WorkReportAssignmentsPage() {
  const enabled = process.env.WORK_REPORTS_API_ENABLED === "true";
  if (!enabled) notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  const assignmentAccess = actor?.ok
    ? await resolveWorkReportAssignmentAccessForRequest()
    : null;
  switch (
    decideWorkReportAssignmentsPageAccess({
      actor,
      hasWorkReportAssignmentAccess: assignmentAccess?.hasAssignmentAccess,
      assignmentAccessStatus: assignmentAccess?.status,
    })
  ) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/work-reports/assignments");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW": {
      const shellActor = await resolveWorkReportShellActorForRequest().catch(() =>
        actor?.ok
          ? {
              ...actor.actor,
              ...(assignmentAccess?.hasAssignmentAccess
                ? { hasWorkReportAssignmentAccess: true }
                : {}),
            }
          : null,
      );
      return (
        <WorkReportsShell
          actor={shellActor}
          active="assignments"
          title="Đợt giao & Nhóm nhận báo cáo"
          description="Tạo đợt giao báo cáo, quản lý nhóm người nhận và theo dõi tiến độ từng thành viên."
        >
          <AssignmentManager />
        </WorkReportsShell>
      );
    }
  }
}
