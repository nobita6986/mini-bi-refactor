import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decidePartnerPortalPageAccess } from "@/lib/partner/portal-access";

export const dynamic = "force-dynamic";

export default async function PartnerPortalHomePage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decidePartnerPortalPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
    allowMustChangePassword: true,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/partner");
    case "ACCOUNT_PENDING_ACTIVATION":
      redirect("/activate");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "PARTNER_FORBIDDEN":
      redirect("/dashboard");
    case "ALLOW": {
      const partner = actor?.ok ? actor.actor.partner_account : undefined;
      if (!partner) {
        redirect("/dashboard");
      }
      if (
        partner.must_change_password ||
        partner.account_state === "ACTIVE_MUST_CHANGE_PASSWORD"
      ) {
        redirect("/partner/change-password");
      }
      if (partner.partner_kind === "VENDOR") {
        redirect("/partner/recruitment");
      }
      redirect("/partner/profile");
    }
  }
}
