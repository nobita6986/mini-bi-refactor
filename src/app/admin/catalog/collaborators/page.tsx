import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { CollaboratorCatalogManager } from "@/components/admin/collaborator-catalog-manager";
import { adminAreaNavPredicate } from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Danh mục Cộng tác viên (CTV) — Hệ thống báo cáo HRP",
};

export default async function CollaboratorCatalogPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  if (!actor) return <TemporaryUnavailable />;
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") {
      redirect("/login?next=/admin/catalog/collaborators");
    }
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return <AccountUnavailable />;
    }
    return <TemporaryUnavailable />;
  }
  if (!adminAreaNavPredicate(actor.actor)) return <AccessDenied />;
  return <CollaboratorCatalogManager />;
}
