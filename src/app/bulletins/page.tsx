import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { BulletinWorkspace } from "@/components/bulletins/bulletin-workspace";
import {
  canManageBulletins,
  decideBulletinsPageAccess,
} from "@/lib/bulletins/bulletin-ui-model";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Bản tin HRPartner — Hệ thống báo cáo HRP",
};

export default async function BulletinsPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideBulletinsPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Fbulletins");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW": {
      const canManage = canManageBulletins(actor && actor.ok ? actor.actor : null);
      return <BulletinWorkspace canManage={canManage} />;
    }
  }
}
