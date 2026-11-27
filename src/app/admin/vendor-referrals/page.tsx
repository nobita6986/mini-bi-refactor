import { redirect } from "next/navigation";

import { VendorReferralReportView } from "@/components/admin/vendor-referral-report-view";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideVendorReferrerReportPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  resolveActorForRequest,
  resolveVendorReferrerAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function VendorReferralsReportPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  const access = actor?.ok
    ? await resolveVendorReferrerAccessForRequest().catch(() => ({
        canManage: false,
        canViewReport: false,
      }))
    : { canManage: false, canViewReport: false };

  switch (
    decideVendorReferrerReportPageAccess({
      actor,
      hasVendorReferrerAccess: access.canViewReport,
    })
  ) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/vendor-referrals");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <VendorReferralReportView />;
  }
}
