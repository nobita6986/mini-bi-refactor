import "server-only";

import { cache, type ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  adminAuthorityNavPredicate,
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  type NavActorProjection,
} from "@/lib/navigation/registry-capability";
import { resolveInternalBiPartnerBlock } from "@/lib/navigation/partner-page-guard";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import {
  decideVendorFinancePageAccess,
  type VendorFinanceServerAccessResult,
} from "@/lib/vendor-finance/ui-model";
import { createVendorFinanceRepository } from "@/lib/vendor-finance/vendor-finance-repository";

const resolveVendorFinanceServerAccess = cache(
  async (authSubject: string, appUserId: string): Promise<VendorFinanceServerAccessResult> => {
    try {
      const result = await createVendorFinanceRepository().getActorAccess({
        auth_subject: authSubject,
        app_user_id: appUserId,
      });
      if (!result.ok) {
        return { ok: false, code: result.code };
      }
      return {
        ok: true,
        can_view: result.data.can_view,
        can_record: result.data.can_record,
        can_reconcile: result.data.can_reconcile,
        can_manage_project_assignments: result.data.can_manage_project_assignments,
      };
    } catch {
      return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
    }
  },
);

export async function renderVendorFinancePageGate(input: {
  requiredMode: "view" | "record" | "admin";
  resolveNextPath: () => string | Promise<string>;
  render: (context: {
    canRecord: boolean;
    canReconcile: boolean;
    canManageProjectAssignments: boolean;
  }) => ReactNode | Promise<ReactNode>;
}): Promise<ReactNode> {
  await connection();
  const enabledFlag = process.env.DIRECT_ENTRY_API_ENABLED;
  if (enabledFlag !== "true") {
    notFound();
  }

  const actor = await resolveActorForRequest().catch(() => null);
  const partnerBlock = resolveInternalBiPartnerBlock(actor);
  if (partnerBlock === "REDIRECT_CHANGE_PASSWORD") {
    redirect("/partner/change-password");
  }
  if (partnerBlock === "ACCESS_DENIED") {
    return <AccessDenied />;
  }

  let serverAccess: VendorFinanceServerAccessResult | null = null;
  let canRecord = false;
  let canReconcile = false;
  let canManageProjectAssignments = false;

  if (actor?.ok) {
    const baseProjection: NavActorProjection = {
      capabilities: actor.actor.capabilities,
      scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
      ...(actor.actor.effective_grants !== undefined
        ? { effective_grants: actor.actor.effective_grants }
        : {}),
    };

    if (adminAuthorityNavPredicate(baseProjection)) {
      canRecord = true;
      canReconcile = true;
      canManageProjectAssignments = true;
      serverAccess = {
        ok: true,
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage_project_assignments: true,
      };
    } else if (vendorFinanceRecordNavPredicate(baseProjection)) {
      canRecord = true;
      canReconcile = true;
      canManageProjectAssignments = false;
      serverAccess = {
        ok: true,
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage_project_assignments: false,
      };
    } else {
      serverAccess = await resolveVendorFinanceServerAccess(
        actor.actor.auth_subject,
        actor.actor.app_user_id,
      );
      if (serverAccess.ok) {
        canRecord = serverAccess.can_view && serverAccess.can_record;
        canReconcile = serverAccess.can_view && Boolean(serverAccess.can_reconcile);
        canManageProjectAssignments =
          serverAccess.can_view && Boolean(serverAccess.can_manage_project_assignments);
      } else if (
        input.requiredMode === "view" &&
        vendorFinanceNavPredicate(baseProjection) &&
        serverAccess.code !== "ACTOR_NOT_AVAILABLE"
      ) {
        serverAccess = {
          ok: true,
          can_view: true,
          can_record: false,
          can_reconcile: false,
          can_manage_project_assignments: false,
        };
        canRecord = false;
        canReconcile = false;
        canManageProjectAssignments = false;
      }
    }
  }

  const decision = decideVendorFinancePageAccess({
    enabledFlag,
    requiredMode: input.requiredMode,
    actor,
    serverAccess,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN": {
      const nextPath = await input.resolveNextPath();
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return input.render({ canRecord, canReconcile, canManageProjectAssignments });
  }
}
