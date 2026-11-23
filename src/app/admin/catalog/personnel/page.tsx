import { notFound, redirect } from "next/navigation";

import { PersonnelCatalogManager } from "@/components/admin/personnel-catalog-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { resolveTeamReturnHref } from "@/lib/admin/recruitment-team-routing";
import { createTeamCatalogRepository } from "@/lib/direct-entry/team-catalog-repository";
import { isReservedVendorTeam } from "@/lib/admin/team-catalog-model";
import { normalizeOrgUuid } from "@/lib/admin/person-org-ui-model";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";
import {
  decideAccountAccessPageAccess,
  decidePersonnelCatalogPageAccess,
} from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function PersonnelCatalogPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  const params = (await searchParams) ?? {};
  const rawTeamId = Array.isArray(params.team_id) ? params.team_id[0] : params.team_id;
  const rawRecruiter = Array.isArray(params.recruiter) ? params.recruiter[0] : params.recruiter;
  const teamId = normalizeOrgUuid(rawTeamId);
  const initialRecruiterId = normalizeOrgUuid(rawRecruiter);
  switch (decidePersonnelCatalogPageAccess({ actor })) {
    case "REDIRECT_LOGIN": {
      if (teamId) {
        redirect(`/login?next=${encodeURIComponent(`/admin/catalog/personnel?team_id=${teamId}`)}`);
      }
      if (initialRecruiterId) {
        redirect(`/login?next=${encodeURIComponent(`/admin/catalog/personnel?recruiter=${initialRecruiterId}`)}`);
      }
      redirect("/login?next=/admin/catalog/personnel");
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const canManageAccountLinks =
        actor?.ok === true && decideAccountAccessPageAccess({ actor }) === "ALLOW";
      let team = null;
      if (params.team_id !== undefined) {
        if (!teamId || !actor?.ok) notFound();
        if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return <TemporaryUnavailable />;
        const result = await createTeamCatalogRepository().getTeam({
          auth_subject: actor.actor.auth_subject,
          app_user_id: actor.actor.app_user_id,
          team_id: teamId,
        });
        if (!result.ok) {
          if (result.kind === "denied") return <AccessDenied />;
          if (result.kind === "not-found" || result.kind === "invalid") notFound();
          return <TemporaryUnavailable />;
        }
        if (result.data.team_id !== teamId || isReservedVendorTeam(result.data)) notFound();
        team = result.data;
      }
      const effectiveRecruiterId = team ? null : initialRecruiterId;
      const teamReturnHref = team
        ? await resolveTeamReturnHref({
            actor,
            apiEnabled: process.env.DIRECT_ENTRY_API_ENABLED === "true",
            departmentRepository: createServiceDepartmentRepository(),
          })
        : "/admin/catalog/teams";
      return (
        <PersonnelCatalogManager
          key={`${team?.team_id ?? "all"}:${effectiveRecruiterId ?? "all"}`}
          team={team}
          teamReturnHref={teamReturnHref}
          canManageAccountLinks={canManageAccountLinks}
          initialRecruiterId={effectiveRecruiterId}
        />
      );
    }
  }
}
