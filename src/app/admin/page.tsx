import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  decideAdminAreaAccess,
  resolveAdminLandingPath,
} from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  const accessDecision = decideAdminAreaAccess({ actor });
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
      const target = resolveAdminLandingPath(actor);
      if (!target) {
        return <AccessDenied />;
      }
      redirect(target);
    }
  }
}
