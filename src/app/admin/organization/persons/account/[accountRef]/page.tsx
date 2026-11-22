import { notFound, redirect } from "next/navigation";

import { AccountDirectoryDetailManager } from "@/components/admin/account-directory-detail-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { hasPairedFullAdminAuthority } from "@/lib/admin/effective-access-page-guard";
import { normalizeOrgUuid } from "@/lib/admin/person-org-ui-model";
import { decideOrganizationPersonsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Chi tiết Người dùng — Hệ thống báo cáo HRP" };

export default async function AdminUserAccountDetailPage({
  params,
}: {
  params: Promise<{ accountRef: string }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideOrganizationPersonsPageAccess({ actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN": {
      const { accountRef } = await params;
      const safeRef = normalizeOrgUuid(accountRef);
      const nextPath = safeRef
        ? `/admin/organization/persons/account/${encodeURIComponent(safeRef)}`
        : "/admin/organization/persons";
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const { accountRef } = await params;
      const safeRef = normalizeOrgUuid(accountRef);
      if (!safeRef) {
        notFound();
      }
      const canManageGroups = actor?.ok ? hasPairedFullAdminAuthority(actor.actor) : false;
      return (
        <AccountDirectoryDetailManager
          key={safeRef}
          accountRef={safeRef}
          canManageGroups={canManageGroups}
        />
      );
    }
  }
}
