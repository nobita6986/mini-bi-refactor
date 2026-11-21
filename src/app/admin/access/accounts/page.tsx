import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { resolveLegacyAccountsRedirectTarget } from "@/lib/admin/legacy-admin-redirect";
import { decideAccountAccessPageAccess } from "@/lib/auth/direct-entry-page-access";
import { isUuid } from "@/lib/http/direct-entry-api-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { createServiceUserDirectoryRepository } from "@/lib/organization/user-directory-repository";

export const dynamic = "force-dynamic";

export default async function LegacyAccountsRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAccountAccessPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/organization/persons");
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
      const rawView = Array.isArray(params?.view) ? params.view[0] : params?.view;
      const rawAccount = Array.isArray(params?.account) ? params.account[0] : params?.account;
      const accountRef = isUuid(rawAccount) ? rawAccount.toLowerCase() : null;

      let resolvedEntry = null;
      if (accountRef && actor?.ok) {
        const repo = createServiceUserDirectoryRepository();
        const entryResult = await repo.getUserDirectoryEntry({
          auth_subject: actor.actor.auth_subject,
          app_user_id: actor.actor.app_user_id,
          person_id: null,
          account_ref: accountRef,
          as_of: null,
        });
        if (entryResult.ok) {
          resolvedEntry = entryResult.data.entry;
        }
      }

      redirect(
        resolveLegacyAccountsRedirectTarget({
          tab: rawTab ?? null,
          view: rawView ?? null,
          accountEntry: resolvedEntry,
        }),
      );
    }
  }
}
