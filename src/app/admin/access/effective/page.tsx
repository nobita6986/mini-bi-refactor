import { redirect } from "next/navigation";

import { EffectiveAccessWorkspace } from "@/components/admin/effective-access-workspace";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideEffectiveAccessPageAccess } from "@/lib/admin/effective-access-page-guard";
import { isUuid } from "@/lib/http/direct-entry-api-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Quyền hiệu lực — Hệ thống báo cáo HRP" };

export default async function EffectiveAccessPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideEffectiveAccessPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/access/effective");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW": {
      const params = searchParams ? await searchParams : {};
      const rawAccount = params?.account;
      const candidate = Array.isArray(rawAccount) ? rawAccount[0] : rawAccount;
      const initialAccountRef = isUuid(candidate) ? candidate.toLowerCase() : null;
      return <EffectiveAccessWorkspace initialAccountRef={initialAccountRef} />;
    }
  }
}
