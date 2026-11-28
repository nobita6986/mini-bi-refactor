import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { SalaryAdvanceWorkspace } from "@/components/salary-advances/salary-advance-workspace";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import {
  resolveActorForRequest,
  resolveSalaryAdvanceAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";
import { decideSalaryAdvancePageAccess } from "@/lib/salary-advance/salary-advance-ui-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Ứng lương — Hệ thống báo cáo HRP",
};

export default async function SalaryAdvancesPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  if (process.env.DIRECT_ENTRY_API_ENABLED === "true") {
    const partnerBlock = resolveInternalBiPartnerBlock(actor);
    if (partnerBlock === "REDIRECT_CHANGE_PASSWORD") {
      redirect("/partner/change-password");
    }
    if (partnerBlock === "ACCESS_DENIED") {
      return <AccessDenied />;
    }
  }
  const access =
    actor?.ok && process.env.DIRECT_ENTRY_API_ENABLED === "true"
      ? await resolveSalaryAdvanceAccessForRequest().catch(() => null)
      : null;
  const decision = decideSalaryAdvancePageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
    canAccess: access ? access.canAccess : null,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Fsalary-advances");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return <SalaryAdvanceWorkspace />;
  }
}
