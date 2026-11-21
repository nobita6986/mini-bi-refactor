import { redirect } from "next/navigation";

import { PersonnelCatalogManager } from "@/components/admin/personnel-catalog-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { normalizeOrgUuid } from "@/lib/admin/person-org-ui-model";
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
  switch (decidePersonnelCatalogPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/catalog/personnel");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const params = searchParams ? await searchParams : {};
      const rawRecruiter = Array.isArray(params?.recruiter)
        ? params.recruiter[0]
        : params?.recruiter;
      const initialRecruiterId = normalizeOrgUuid(rawRecruiter);
      const canManageAccountLinks =
        actor?.ok === true && decideAccountAccessPageAccess({ actor }) === "ALLOW";
      return (
        <PersonnelCatalogManager
          key={initialRecruiterId ?? "all"}
          canManageAccountLinks={canManageAccountLinks}
          initialRecruiterId={initialRecruiterId}
        />
      );
    }
  }
}
