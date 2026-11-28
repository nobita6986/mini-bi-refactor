import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  decideAdminAreaAccess,
  resolveAdminLandingPath,
} from "@/lib/auth/direct-entry-page-access";
import { hasVendorReferrerManageCapability } from "@/lib/navigation/registry-capability";
import {
  resolveActorForRequest,
  resolveVendorReferrerAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  const referrerAccess =
    actor?.ok && hasVendorReferrerManageCapability(actor.actor)
      ? await resolveVendorReferrerAccessForRequest().catch(() => ({
          canManage: false,
          canViewReport: false,
        }))
      : { canManage: false, canViewReport: false };
  const hasVendorReferrerAccess =
    referrerAccess.canManage || referrerAccess.canViewReport;
  const accessDecision = decideAdminAreaAccess({ actor, hasVendorReferrerAccess });
  switch (accessDecision) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const target = resolveAdminLandingPath(actor, { hasVendorReferrerAccess });
      if (!target) {
        return <AccessDenied />;
      }
      redirect(target);
    }
  }
}
