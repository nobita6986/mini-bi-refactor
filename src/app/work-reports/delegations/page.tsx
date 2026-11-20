import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DelegationManager } from "@/components/work-reports/renderer/delegation-manager";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import {
  resolveActorForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";
import { workReportDelegationPredicate } from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ủy quyền báo cáo — Mini BI" };

export default async function WorkReportDelegationsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  if (!resolution) return <TemporaryUnavailable />;
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") redirect("/login?next=/work-reports/delegations");
    if (resolution.reason === "ACTOR_MAPPING_MISSING" || resolution.reason === "ACTOR_DISABLED") return <AccountUnavailable />;
    return <TemporaryUnavailable />;
  }
  if (!workReportDelegationPredicate(resolution.actor)) {
    return <AccessDenied />;
  }
  const shellActor = await resolveWorkReportShellActorForRequest().catch(() => resolution.actor);
  return (
    <WorkReportsShell
      actor={shellActor}
      active="delegations"
      title="Ủy quyền"
      description="Giao quyền báo cáo trong phạm vi và thời hạn được máy chủ cấp phép."
    >
      <DelegationManager />
    </WorkReportsShell>
  );
}
