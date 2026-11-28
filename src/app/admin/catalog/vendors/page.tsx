import Link from "next/link";
import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { VendorCatalogManager } from "@/components/admin/vendor-catalog-manager";
import { VendorReferrerPanel } from "@/components/admin/vendor-referrer-panel";
import { VendorReferralReportView } from "@/components/admin/vendor-referral-report-view";
import { buttonClasses } from "@/components/ui/button";
import { decideVendorCatalogPageAccess, decideVendorReferrerReportPageAccess } from "@/lib/auth/direct-entry-page-access";
import { adminAreaNavPredicate } from "@/lib/navigation/registry-capability";
import {
  resolveActorForRequest,
  resolveVendorReferrerAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";
import { isValidVendorId } from "@/lib/vendor-referrals/vendor-referrer-contract";
import { createVendorReferrerRepository } from "@/lib/vendor-referrals/vendor-referrer-repository";

export const dynamic = "force-dynamic";

const VENDORS_HREF = "/admin/catalog/vendors";

export default async function VendorCatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[]; vendor_id?: string | string[] }>;
}) {
  const query = await searchParams;
  const actor = await resolveActorForRequest().catch(() => null);
  const access = actor?.ok
    ? await resolveVendorReferrerAccessForRequest().catch(() => ({
        canManage: false,
        canViewReport: false,
      }))
    : { canManage: false, canViewReport: false };
  const reportRequested = query.tab === "referral-report";
  const referrersRequested = query.tab === "referrers";
  const decision = reportRequested
    ? decideVendorReferrerReportPageAccess({ actor, hasVendorReferrerAccess: access.canViewReport })
    : decideVendorCatalogPageAccess({ actor, hasVendorReferrerAccess: access.canManage });

  switch (decision) {
    case "REDIRECT_LOGIN": {
      const next = new URLSearchParams();
      if (reportRequested) next.set("tab", "referral-report");
      if (referrersRequested) next.set("tab", "referrers");
      if (reportRequested && typeof query.vendor_id === "string" && isValidVendorId(query.vendor_id)) {
        next.set("vendor_id", query.vendor_id);
      }
      const suffix = next.size > 0 ? "?" + next.toString() : "";
      redirect("/login?next=" + encodeURIComponent(VENDORS_HREF + suffix));
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
  }

  if (!actor?.ok || (referrersRequested && !access.canManage)) return <AccessDenied />;

  const canManageVendorCatalog = adminAreaNavPredicate(actor.actor);
  const activeTab = reportRequested
    ? "referral-report"
    : referrersRequested || !canManageVendorCatalog
      ? "referrers"
      : "catalog";
  const links = [
    ...(canManageVendorCatalog ? [{ id: "catalog", label: "Danh mục Vendor", href: VENDORS_HREF }] : []),
    ...(access.canManage ? [{ id: "referrers", label: "Gán người giới thiệu", href: VENDORS_HREF + "?tab=referrers" }] : []),
    ...(access.canViewReport ? [{ id: "referral-report", label: "Lượt tuyển qua Vendor", href: VENDORS_HREF + "?tab=referral-report" }] : []),
  ];
  const vendorId = reportRequested && typeof query.vendor_id === "string" && isValidVendorId(query.vendor_id)
    ? query.vendor_id
    : null;
  const history = vendorId ? await createVendorReferrerRepository().getHistory({
    auth_subject: actor.actor.auth_subject,
    app_user_id: actor.actor.app_user_id,
    vendor_id: vendorId,
  }).catch(() => null) : null;
  const selectedVendor = history?.ok ? history.data.vendor : null;

  return (
    <div className="space-y-4">
      {links.length > 1 ? (
        <nav aria-label="Các mục Vendor" className="flex flex-wrap gap-2 rounded-[22px] border border-border/80 bg-surface p-3 shadow-[var(--shadow-card)]">
          {links.map((link) => (
            <Link
              key={link.id}
              href={link.href}
              aria-current={activeTab === link.id ? "page" : undefined}
              className={buttonClasses({ variant: activeTab === link.id ? "soft" : "outline", size: "sm" })}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {activeTab === "referral-report" ? (
        <VendorReferralReportView
          key={selectedVendor?.vendor_id}
          selectedVendor={selectedVendor}
        />
      ) : activeTab === "referrers" ? <VendorReferrerPanel /> : <VendorCatalogManager />}
    </div>
  );
}
