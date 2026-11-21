import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideEffectiveAccessPageAccess } from "@/lib/admin/effective-access-page-guard";
import { resolveLegacyEffectiveRedirectTarget } from "@/lib/admin/legacy-admin-redirect";
import { isUuid } from "@/lib/http/direct-entry-api-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { createServiceUserDirectoryRepository } from "@/lib/organization/user-directory-repository";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhóm quyền — Hệ thống báo cáo HRP" };

export default async function LegacyEffectiveAccessRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
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
    case "ALLOW": {
      const params = searchParams ? await searchParams : {};
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

      redirect(resolveLegacyEffectiveRedirectTarget({ accountEntry: resolvedEntry }));
    }
  }
}
