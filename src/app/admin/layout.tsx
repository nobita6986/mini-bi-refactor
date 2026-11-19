import type { ReactNode } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { AdminSubnav } from "@/components/admin/admin-subnav";
import { AppShell } from "@/components/app-shell/app-shell";
import { decideAdminAreaAccess } from "@/lib/auth/direct-entry-page-access";
import { visibleAdminSections } from "@/lib/admin/admin-navigation";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import type { NavActorProjection } from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideAdminAreaAccess({ actor });
  const navActor: NavActorProjection | null = actor?.ok
    ? {
        capabilities: actor.actor.capabilities,
        scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
        ...(actor.actor.effective_grants !== undefined
          ? { effective_grants: actor.actor.effective_grants }
          : {}),
      }
    : null;

  let content: ReactNode;
  switch (decision) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin");
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
