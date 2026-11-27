import type { ReactNode } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { AdminSubnav } from "@/components/admin/admin-subnav";
import { AppShell } from "@/components/app-shell/app-shell";
import { decideAdminAreaAccess } from "@/lib/auth/direct-entry-page-access";
import { visibleAdminSections } from "@/lib/admin/admin-navigation";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";
import { hasVendorReferrerManageCapability } from "@/lib/navigation/registry-capability";
import {
  resolveActorForRequest,
  resolveNavActorForAppShell,
  resolveVendorReferrerAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await connection();
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
  const decision = decideAdminAreaAccess({ actor, hasVendorReferrerAccess });
  if (decision === "REDIRECT_LOGIN") {
    redirect("/login?next=/admin");
  }

  // WP13 M1: reuse the full request-scoped `resolveNavActorForAppShell` projection
  // (sharing React.cache with `resolveActorForRequest`) so top-level AppShell items
  // never disappear inside `/admin/*`. Admin area access itself remains decoupled
  // from `DIRECT_ENTRY_UI_ENABLED`.
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const navActor = await resolveNavActorForAppShell({
    directEntryEnabled,
    adminNavigationEnabled: true,
  }).catch(() => null);

  let content: ReactNode;
  switch (decision) {
    case "ACCOUNT_UNAVAILABLE":
      content = <AccountUnavailable />;
      break;
    case "TEMPORARY_UNAVAILABLE":
      content = <TemporaryUnavailable />;
      break;
    case "ACCESS_DENIED":
      content = <AccessDenied />;
      break;
    case "ALLOW":
      content = (
        <>
          <AdminSubnav sections={visibleAdminSections(navActor)} />
          {children}
        </>
      );
      break;
    case "NOT_FOUND":
      content = <AccessDenied />;
      break;
  }

  return (
    <AppShell actor={navActor}>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {content}
      </div>
    </AppShell>
  );
}
