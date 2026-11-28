import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { VendorRecruitmentView } from "@/components/partner/vendor-recruitment-view";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decidePartnerPortalPageAccess } from "@/lib/partner/portal-access";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Tuyển dụng của tôi — HR Partner",
};

export default async function PartnerRecruitmentPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decidePartnerPortalPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
    requireVendor: true,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/partner/recruitment");
    case "ACCOUNT_PENDING_ACTIVATION":
      redirect("/activate");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "PASSWORD_CHANGE_REQUIRED":
      redirect("/partner/change-password");
    case "PARTNER_FORBIDDEN":
      return <AccessDenied />;
    case "ALLOW":
      return <VendorRecruitmentView />;
  }
}
