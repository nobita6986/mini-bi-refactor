import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { FormBuilder } from "@/components/work-reports/form-builder/form-builder";
import { WorkReportsModuleNav } from "@/components/work-reports/work-reports-nav";
import { buildWorkReportsNavLinks } from "@/components/work-reports/work-reports-shell";
import {
  resolveActorForRequest,
  resolveWorkReportShellActorForRequest,
} from "@/lib/navigation/resolve-nav-actor";
import { canManageWorkReportTemplates } from "@/lib/work-reports/form-builder-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quản lý mẫu báo cáo — Mini BI" };

export default async function WorkReportTemplatesPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  if (!resolution) return <TemporaryUnavailable />;
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") redirect("/login?next=/work-reports/templates");
    if (resolution.reason === "ACTOR_MAPPING_MISSING" || resolution.reason === "ACTOR_DISABLED") {
      return <AccountUnavailable />;
    }
    return <TemporaryUnavailable />;
  }
  const allowed = canManageWorkReportTemplates(resolution.actor);
  if (!allowed) return <AccessDenied />;
  const shellActor = await resolveWorkReportShellActorForRequest().catch(() => resolution.actor);
  return <FormBuilder moduleNav={<WorkReportsModuleNav links={buildWorkReportsNavLinks(shellActor)} />} />;
}
