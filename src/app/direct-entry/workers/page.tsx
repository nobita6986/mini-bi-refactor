import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { WorkerOperations } from "@/components/direct-entry/worker-operations";
import { decideWorkerOperationsPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  projectClientCapabilities,
  projectClientScopes,
} from "@/lib/auth/direct-entry-v2";
import { canExportAllWorkers, canExportWorkers } from "@/lib/direct-entry/worker-export-ui-model";
import {
  canReadWorkerDirectoryCatalog,
  resolveAllowedWorkerOperationsTabs,
  workerOperationsAllScopePredicate,
  workerOperationsTeamScopePredicate,
} from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P2.5-W06-R1 - Worker Operations.
 *
 * Cung boundary voi /direct-entry (flag + actor resolver request-scoped) va CUNG predicate
 * voi nav (workerOperationsNavPredicate) — khong hai logic lech nhau.
 *
 * "Toan bo NLD" (scope=all) chi duoc BAT khi server-side actor projection
 * xac nhan (entry_admin | change_review) + effective all scope; RPC W03 van la authority
 * cuoi cung. Workflow yêu cầu thay đổi nằm tại /direct-entry.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Người lao động — Hệ thống báo cáo HRP" };

export default async function WorkerOperationsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  switch (decideWorkerOperationsPageAccess({ uiEnabled, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/workers");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const projection = actor !== null && actor.ok ? actor.actor : null;
      const allowedTabs = resolveAllowedWorkerOperationsTabs(projection);
      const canSeeAllWorkers = projection !== null &&
        workerOperationsAllScopePredicate(projection) &&
        allowedTabs.includes("all");
      const canSeeTeamWorkers = projection !== null &&
        workerOperationsTeamScopePredicate(projection) &&
        allowedTabs.includes("team");
      const canReadCatalog = canReadWorkerDirectoryCatalog(projection);
      // Chi truyen capabilities + scope kind + allowed_worker_tabs: khong lo auth_subject/app_user_id/PII.
      const actorProjection = projection === null ? null : {
        capabilities: [...projectClientCapabilities(projection)],
        scopes: projectClientScopes(projection).map((scope) => ({ kind: scope.kind })),
        allowed_worker_tabs: [...allowedTabs],
      };
      const canExport = canExportWorkers(actorProjection);
      const canExportAll = canExportAllWorkers(projection);
      return (
        <WorkerOperations
          allowedTabs={allowedTabs}
          canReadCatalog={canReadCatalog}
          canSeeAllWorkers={canSeeAllWorkers}
          canSeeTeamWorkers={canSeeTeamWorkers}
          canExport={canExport}
          canExportAll={canExportAll}
          actor={actorProjection}
        />
      );
    }
  }
}
