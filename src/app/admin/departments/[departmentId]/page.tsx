import { notFound, redirect } from "next/navigation";

import { DepartmentDetailManager } from "@/components/admin/department-detail-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { normalizeDepartmentUuid } from "@/lib/admin/department-ui-model";
import { canManageTeamLeadersFromActor, decideAccountAccessPageAccess, decideTeamCatalogPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Chi tiết Phòng ban — Hệ thống báo cáo HRP" };

export default async function AdminDepartmentDetailPage({
  params,
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
  params: Promise<{ departmentId: string }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  const teamsView = (await searchParams)?.view === "teams";
  switch (decideAccountAccessPageAccess({ actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN": {
      const { departmentId } = await params;
      const safeId = normalizeDepartmentUuid(departmentId);
      const nextPath = safeId
        ? `/admin/departments/${encodeURIComponent(safeId)}${teamsView ? "?view=teams" : ""}`
        : "/admin/departments";
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const { departmentId } = await params;
      return (
        <DepartmentDetailManager
          key={departmentId}
          departmentId={departmentId}
          teamsView={teamsView}
          canManageCatalog={decideTeamCatalogPageAccess({ actor }) === "ALLOW"}
          canManageTeamLeaders={canManageTeamLeadersFromActor(actor)}
        />
      );
    }
  }
}
