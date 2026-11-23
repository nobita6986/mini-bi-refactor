import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { TeamCatalogManager } from "@/components/admin/team-catalog-manager";
import { resolveRecruitmentTeamsRedirectHref } from "@/lib/admin/recruitment-team-routing";
import {
  canManageTeamLeadersFromActor,
  decideTeamCatalogPageAccess,
} from "@/lib/auth/direct-entry-page-access";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function TeamCatalogPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideTeamCatalogPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/catalog/teams");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const redirectHref = await resolveRecruitmentTeamsRedirectHref({
        actor,
        apiEnabled: process.env.DIRECT_ENTRY_API_ENABLED === "true",
        departmentRepository: createServiceDepartmentRepository(),
      });
      if (redirectHref) {
        redirect(redirectHref);
      }
      return (
        <TeamCatalogManager
          canManageTeamLeaders={canManageTeamLeadersFromActor(actor)}
        />
      );
    }
  }
}
