import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { decidePersonalWorkReportsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import {
  resolveActorForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function WorkReportsPage() {
  const enabledFlag = process.env.WORK_REPORTS_API_ENABLED;
  if (enabledFlag !== "true") notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decidePersonalWorkReportsPageAccess({ enabledFlag, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/work-reports");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW": {
      const partnerBlock = resolveInternalBiPartnerBlock(actor);
      if (partnerBlock === "REDIRECT_CHANGE_PASSWORD") {
        redirect("/partner/change-password");
      }
      if (partnerBlock === "ACCESS_DENIED") {
        return <AccessDenied />;
      }
      const shellActor = await resolveWorkReportShellActorForRequest().catch(() =>
        actor?.ok ? actor.actor : null,
      );
      return (
        <WorkReportsShell
          actor={shellActor}
          active="my"
          title="Cần làm"
          description="Các báo cáo được giao cho bạn trong kỳ hiện hành; lưu nháp hoặc nộp trước hạn."
        >
          <MyObligations />
        </WorkReportsShell>
      );
    }
  }
}
