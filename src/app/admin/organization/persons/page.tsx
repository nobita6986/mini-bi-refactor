import { notFound, redirect } from "next/navigation";

import { PersonListManager } from "@/components/admin/person-list-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideOrganizationPersonsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhân sự nội bộ — Hệ thống báo cáo HRP" };

export default async function AdminOrganizationPersonsPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideOrganizationPersonsPageAccess({ actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/organization/persons");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return <PersonListManager />;
  }
}
