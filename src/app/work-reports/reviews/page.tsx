import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ReviewInbox } from "@/components/work-reports/renderer/review-inbox";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import {
  resolveActorForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";
import { workReportReviewPredicate } from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cần duyệt báo cáo — Mini BI" };

export default async function WorkReportReviewsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  if (!resolution) return <TemporaryUnavailable />;
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") redirect("/login?next=/work-reports/reviews");
    if (resolution.reason === "ACTOR_MAPPING_MISSING" || resolution.reason === "ACTOR_DISABLED") return <AccountUnavailable />;
    return <TemporaryUnavailable />;
  }

  if (!workReportReviewPredicate(resolution.actor)) {
    return <AccessDenied />;
  }
  const shellActor = await resolveWorkReportShellActorForRequest().catch(() => resolution.actor);
  return (
    <WorkReportsShell
      actor={shellActor}
      active="reviews"
      title="Cần duyệt"
      description="Hàng đợi và nội dung báo cáo chờ duyệt do máy chủ giới hạn theo phạm vi duyệt hiện hành."
    >
      <ReviewInbox />
    </WorkReportsShell>
  );
}
