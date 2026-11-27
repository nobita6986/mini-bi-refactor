import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { VendorCatalogManager } from "@/components/admin/vendor-catalog-manager";
import { decideVendorCatalogPageAccess } from "@/lib/auth/direct-entry-page-access";
import { adminAreaNavPredicate } from "@/lib/navigation/registry-capability";
import {
  resolveActorForRequest,
  resolveVendorReferrerAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function VendorCatalogPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  const access = actor?.ok
    ? await resolveVendorReferrerAccessForRequest().catch(() => ({
        canManage: false,
        canViewReport: false,
      }))
    : { canManage: false, canViewReport: false };

  switch (
    decideVendorCatalogPageAccess({
      actor,
      hasVendorReferrerAccess: access.canManage,
    })
  ) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/catalog/vendors");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const canManageVendorCatalog = actor?.ok ? adminAreaNavPredicate(actor.actor) : false;
      return (
        <VendorCatalogManager
          canManageVendorCatalog={canManageVendorCatalog}
          canManageReferrers={access.canManage}
        />
      );
    }
  }
}
