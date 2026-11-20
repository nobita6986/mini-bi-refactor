import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ChangeRequestsWorkspace } from "@/components/direct-entry/change-requests-workspace";
import {
  decideChangeRequestsPageAccess,
  EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE,
} from "@/lib/auth/direct-entry-page-access";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";
import { canViewGlobalChangeRequestHistory } from "@/lib/direct-entry/worker-operations-model";
import {
  changeRequestsNavPredicate,
  changeRequestsProposerPredicate,
  changeRequestsReviewerPredicate,
  directEntryNavPredicate,
  workerOperationsNavPredicate,
} from "@/lib/navigation/registry-capability";
import {
  resolveActorForRequest,
  resolveChangeRequestHistoricalAccessForRequest,
} from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Yêu cầu thay đổi — Hệ thống báo cáo HRP" };

export default async function ChangeRequestsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  const shouldProbeHistory =
    uiEnabled &&
    actor !== null &&
    actor.ok &&
    (!changeRequestsNavPredicate(actor.actor) ||
      !changeRequestsReviewerPredicate(actor.actor));
  const historicalProbe = shouldProbeHistory
    ? await resolveChangeRequestHistoricalAccessForRequest().catch(
        () => EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE,
      )
    : EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE;
  const hasHistoricalRequests = historicalProbe.hasHistoricalRequests;

  switch (
    decideChangeRequestsPageAccess({
      uiEnabled,
      actor,
      hasHistoricalRequests,
      historicalProbe,
    })
  ) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/change-requests");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const projection = actor !== null && actor.ok ? actor.actor : null;
      const canReview = projection !== null && changeRequestsReviewerPredicate(projection);
      const canPropose = projection !== null && changeRequestsProposerPredicate(projection);
      const canViewGlobalHistory = projection !== null &&
        canViewGlobalChangeRequestHistory(
          projection.capabilities,
          projection.scopes,
          projection.effective_grants,
        );
      const canAccessDirectEntry = projection !== null && directEntryNavPredicate(projection);
      const canAccessWorkerDirectory = projection !== null && workerOperationsNavPredicate(projection);
      return (
        <ChangeRequestsWorkspace
          canReview={canReview}
          canPropose={canPropose}
          canViewGlobalHistory={canViewGlobalHistory}
          canAccessDirectEntry={canAccessDirectEntry}
          canAccessWorkerDirectory={canAccessWorkerDirectory}
          hasProposerPending={historicalProbe.hasProposerPending}
          hasProposerResolved={historicalProbe.hasProposerResolved}
          hasReviewerResolved={historicalProbe.hasReviewerResolved}
        />
      );
    }
  }
}
