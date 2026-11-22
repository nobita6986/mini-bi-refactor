import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ProjectTeamScopeManager } from "@/components/admin/project-team-scope-manager";
import { decideAccountAccessPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Phân công Dự án ↔ Tổ đội — Hệ thống báo cáo HRP" };

export default async function ProjectTeamScopesPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAccountAccessPageAccess({ actor })) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/admin/catalog/project-team-scopes");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW": return <ProjectTeamScopeManager />;
  }
}
