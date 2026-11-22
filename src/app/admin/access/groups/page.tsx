import { redirect } from "next/navigation";

import { PermissionGroupsManager } from "@/components/admin/permission-groups-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideEffectiveAccessPageAccess } from "@/lib/admin/effective-access-page-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhóm quyền — Hệ thống báo cáo HRP" };

export default async function AdminPermissionGroupsPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideEffectiveAccessPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/access/groups");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <PermissionGroupsManager />;
  }
}
