import { redirect } from "next/navigation";

import {
  AccountAccessWorkspace,
  type AccountWorkspaceTab,
} from "@/components/admin/account-access-workspace";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { parseAccountManagementView } from "@/lib/admin/account-access-model";
import { hasPairedFullAdminAuthority } from "@/lib/admin/effective-access-page-guard";
import { decideAccountAccessPageAccess } from "@/lib/auth/direct-entry-page-access";
import { isUuid } from "@/lib/http/direct-entry-api-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function ExistingAccountAccessPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAccountAccessPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/access/accounts");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const params = searchParams ? await searchParams : {};
      const rawTab = Array.isArray(params?.tab) ? params.tab[0] : params?.tab;
      const initialTab: AccountWorkspaceTab =
        rawTab === "global-roles" ? "global-roles" : "accounts";
      const rawAccount = Array.isArray(params?.account) ? params.account[0] : params?.account;
      const initialAccountRef = isUuid(rawAccount) ? rawAccount.toLowerCase() : null;
      const initialView = parseAccountManagementView(params?.view);
      const canManageGlobalRoles = actor?.ok
        ? hasPairedFullAdminAuthority(actor.actor)
        : false;
      return (
        <AccountAccessWorkspace
          key={`${initialTab}:${initialView}:${initialAccountRef ?? ""}`}
          canManageGlobalRoles={canManageGlobalRoles}
          initialTab={initialTab}
          initialAccountRef={initialAccountRef}
          initialView={initialView}
        />
      );
    }
  }
}
