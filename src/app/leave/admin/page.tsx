import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { LeaveManagementWorkspace } from "@/components/leave/leave-management-workspace";
import { decideLeavePageAccess } from "@/lib/leave/leave-ui-model";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import {
  resolveActorForRequest,
  resolveLeaveManagementAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Quản trị nghỉ phép — Hệ thống báo cáo HRP",
};

export default async function LeaveAdminPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideLeavePageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Fleave%2Fadmin");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      break;
  }

  const partnerBlock = resolveInternalBiPartnerBlock(actor);
  if (partnerBlock === "REDIRECT_CHANGE_PASSWORD") {
    redirect("/partner/change-password");
  }
  if (partnerBlock === "ACCESS_DENIED") {
    return <AccessDenied />;
  }

  const leaveAccess = await resolveLeaveManagementAccessForRequest();
  if (!leaveAccess) return <TemporaryUnavailable />;
  if (!leaveAccess.canManageConfig && !leaveAccess.canViewMonthlyReport) notFound();

  return (
    <LeaveManagementWorkspace
      viewMode="admin"
      initialAdminTab={leaveAccess.canManageConfig ? "admin" : "reports"}
    />
  );
}
