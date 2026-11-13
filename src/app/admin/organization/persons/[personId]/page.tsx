import { notFound, redirect } from "next/navigation";

import { PersonDetailManager } from "@/components/admin/person-detail-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { normalizeOrgUuid } from "@/lib/admin/person-org-ui-model";
import { decideOrganizationPersonsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Chi tiết Nhân sự nội bộ — Hệ thống báo cáo HRP" };

export default async function AdminOrganizationPersonDetailPage({
  params,
}: {
  params: Promise<{ personId: string }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideOrganizationPersonsPageAccess({ actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN": {
      const { personId } = await params;
      const safeId = normalizeOrgUuid(personId);
      const nextPath = safeId
        ? `/admin/organization/persons/${encodeURIComponent(safeId)}`
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
      const { personId } = await params;
      const safeId = normalizeOrgUuid(personId);
      if (!safeId) {
        notFound();
      }
      return <PersonDetailManager personId={safeId} />;
    }
  }
}
