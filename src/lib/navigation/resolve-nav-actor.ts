/**
 * P3-W06A R1 — Request-scoped actor resolution cho page + layout.
 *
 * Muc tieu:
 * - Moi request chi thuc hien mot chuoi Supabase getUser + actor repository
 *   resolution, duoc chia se giua layout (AppShell) va page (route access).
 * - React `cache()` (RSC) dam bao request-scoped: moi render pass goi
 *   resolver 1 lan, nhung request tiep theo van resolve lai (khong leak
 *   actor qua user).
 * - Tuyet doi KHONG dung `unstable_cache` (cross-request) cho actor — do
 *   la PII + role decision, phai theo user hien tai.
 *
 * Refs:
 * - node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md
 *   (React cache: request-scoped memoization).
 * - src/lib/auth/direct-entry-session.ts (Supabase client + resolveActor).
 * - src/lib/auth/direct-entry-session-retry.ts (bounded retry H07).
 *
 * Layout goi `resolveNavActorForAppShell()` de lay `NavActorProjection`;
 * page goi `resolveActorForRequest()` de lay `ActorResolution` day du cho
 * route access decision. Ca hai cung share cache key (request-scoped).
 *
 * Dashboard may opt into resolving the minimal nav actor for Admin even if
 * Direct Entry UI is disabled; direct-entry layouts retain the old skip.
 */

import "server-only";

import { cache } from "react";

import {
  EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE,
  probeHistoricalChangeRequestAccess,
  type ChangeRequestHistoricalAccessProbe,
  type WorkReportAssignmentAccessStatus,
} from "@/lib/auth/direct-entry-page-access";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { resolveSessionWithBoundedRetry } from "@/lib/auth/direct-entry-session-retry";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createChangeRequestReadRepository } from "@/lib/direct-entry/change-request-read-repository";
import { createLeaveRepository } from "@/lib/leave/leave-repository";
import { createSalaryAdvanceRepository } from "@/lib/salary-advance/salary-advance-repository";
import { createVendorFinanceRepository } from "@/lib/vendor-finance/vendor-finance-repository";
import { createVendorReferrerRepository } from "@/lib/vendor-referrals/vendor-referrer-repository";
import { createAssignmentRepository } from "@/lib/work-reports/assignment-repository";
import { createSubmissionRepository } from "@/lib/work-reports/submission-repository";
import type { ActorResolution } from "@/lib/auth/direct-entry-v2";
import {
  changeRequestsNavPredicate,
  hasActiveDepartmentHeadRole,
  hasVendorReferrerManageCapability,
  leaveManagementNavPredicate,
  type NavActorProjection,
  salaryAdvanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  workReportAssignmentPredicate,
  workReportsNavPredicate,
} from "@/lib/navigation/registry-capability";

/**
 * Request-scoped resolver: tra ve `ActorResolution` day du (goc tu
 * `resolveDirectEntrySession`).
 *
 * - Request dau tien trong mot render pass goi getDirectEntryActor +
 *   resolveActor + (H07) bounded retry.
 * - Lan goi tiep theo trong cung render pass (layout + page) tra ve
 *   cung ket qua (React cache).
 * - Request moi bat dau render pass moi → resolver chay lai, khong
 *   share actor giua user (React cache khong persist qua request).
 */
export const resolveActorForRequest = cache(
  async (): Promise<ActorResolution> => {
    const result = await resolveSessionWithBoundedRetry(() =>
      getDirectEntryActor(createDirectEntryActorRepository(), {
        cookieWriteMode: "read-only",
      }));
    return result.actor;
  },
);

/**
 * Request-scoped nav projection (chỉ capabilities + scopes.kind).
 *
 * Predicate trong `registry-capability.ts` chi dung `capabilities` + `scopes.kind`
 * (xem `decideNavEntryVisibility`, `directEntryNavPredicate`,
 *  `adminAuthorityNavPredicate`). `app_user_id` chi duoc dung server-side de
 * probe nghia vu dang hieu luc; van bi loai khoi projection tra cho nav.
 *
 * - Tra ve `null` neu actor resolution fail (UNAUTHENTICATED, ...) hoac
 *   ca Direct Entry va Admin nav deu khong duoc yeu cau.
 * - Tra ve projection neu actor OK.
 * - Cung dung React cache nhu `resolveActorForRequest` de tranh duplicate
 *   getUser + repository resolution.
 */
export const resolveChangeRequestHistoricalAccessForRequest = cache(
  async (): Promise<ChangeRequestHistoricalAccessProbe> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE;
    }
    const repository = createChangeRequestReadRepository();
    return probeHistoricalChangeRequestAccess({
      auth_subject: actor.actor.auth_subject,
      app_user_id: actor.actor.app_user_id,
      listChangeRequests: (query) => repository.listChangeRequests(query),
    });
  },
);

export const resolveVendorFinanceAccessForRequest = cache(
  async (): Promise<{
    can_view: boolean;
    can_record: boolean;
    can_reconcile: boolean;
    can_manage_project_assignments: boolean;
  }> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return {
        can_view: false,
        can_record: false,
        can_reconcile: false,
        can_manage_project_assignments: false,
      };
    }
    try {
      const access = await createVendorFinanceRepository().getActorAccess({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (access.ok && access.data.can_view) {
        return {
          can_view: true,
          can_record: access.data.can_record,
          can_reconcile: access.data.can_reconcile,
          can_manage_project_assignments: access.data.can_manage_project_assignments,
        };
      }
    } catch {
      // Fail closed without disrupting AppShell rendering.
    }
    return {
      can_view: false,
      can_record: false,
      can_reconcile: false,
      can_manage_project_assignments: false,
    };
  },
);

export const resolveLeaveManagementAccessForRequest = cache(
  async (): Promise<{
    canAccess: boolean;
    canManageConfig: boolean;
    canViewMonthlyReport: boolean;
  } | null> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return null;
    }
    try {
      const access = await createLeaveRepository().getActorAccess({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (access.ok) {
        return {
          canAccess: access.data.can_access,
          canManageConfig: access.data.can_manage_config,
          canViewMonthlyReport: access.data.can_view_monthly_report,
        };
      }
    } catch {
      // Fail closed without disrupting AppShell rendering.
    }
    return null;
  },
);

export const resolveSalaryAdvanceAccessForRequest = cache(
  async (): Promise<{
    canAccess: boolean;
  } | null> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return null;
    }
    try {
      const access = await createSalaryAdvanceRepository().getActorAccess({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (access.ok) {
        const canAccess = Boolean(
          access.data.can_access &&
            (access.data.is_project_manager ||
              access.data.is_project_accountant ||
              access.data.is_supervisory_viewer)
        );
        return { canAccess };
      }
    } catch {
      // Fail closed without disrupting AppShell rendering.
    }
    return null;
  },
);

export const resolveVendorReferrerAccessForRequest = cache(
  async (): Promise<{
    canManage: boolean;
    canViewReport: boolean;
  }> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return { canManage: false, canViewReport: false };
    }
    try {
      const access = await createVendorReferrerRepository().getActorAccess({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (access.ok) {
        return {
          canManage: access.data.can_manage,
          canViewReport: access.data.can_view_report,
        };
      }
    } catch {
      // Fail closed without disrupting AppShell rendering.
    }
    return { canManage: false, canViewReport: false };
  },
);

export type WorkReportAssignmentAccessProbe = {
  status: WorkReportAssignmentAccessStatus;
  hasAssignmentAccess: boolean;
};

/**
 * WP8D-2 R1: Request-scoped read-only server projection for effective `report_assign`
 * authority (including delegated `report_assign` without expanding `effective_grants`,
 * preserving WP5 R3 and the 12/13-key actor RPC contract).
 *
 * The boolean RPC keeps expected denials out of the data-reading path.
 * Direct authority and Full Admin still short-circuit here.
 */
export const resolveWorkReportAssignmentAccessForRequest = cache(
  async (): Promise<WorkReportAssignmentAccessProbe> => {
    try {
      const actor = await resolveActorForRequest();
      if (!actor.ok) {
        return { status: "denied", hasAssignmentAccess: false };
      }
      if (workReportAssignmentPredicate(actor.actor)) {
        return { status: "allowed", hasAssignmentAccess: true };
      }
      const access = await createAssignmentRepository().hasAssignmentAccess({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (access.ok && typeof access.data === "boolean") {
        return { status: access.data ? "allowed" : "denied", hasAssignmentAccess: access.data };
      }
      if (!access.ok && access.kind === "denied") {
        return { status: "denied", hasAssignmentAccess: false };
      }
      return { status: "unavailable", hasAssignmentAccess: false };
    } catch {
      // Fail closed without disrupting AppShell rendering.
      return { status: "unavailable", hasAssignmentAccess: false };
    }
  },
);

export const resolveWorkReportShellActorForRequest = cache(
  async (): Promise<NavActorProjection | null> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) return null;
    const projection: NavActorProjection = {
      capabilities: actor.actor.capabilities,
      scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
      ...(actor.actor.effective_grants !== undefined
        ? { effective_grants: actor.actor.effective_grants }
        : {}),
      ...(actor.actor.effective_report_review_scopes !== undefined
        ? { effective_report_review_scopes: actor.actor.effective_report_review_scopes }
        : {}),
    };
    if (
      process.env.WORK_REPORTS_API_ENABLED === "true" &&
      !workReportAssignmentPredicate(projection)
    ) {
      const assignmentAccess = await resolveWorkReportAssignmentAccessForRequest();
      if (assignmentAccess.hasAssignmentAccess) {
        projection.hasWorkReportAssignmentAccess = true;
      }
    }
    return projection;
  },
);

export const resolveWorkReportObligationsAccessForRequest = cache(
  async (): Promise<{
    hasActiveObligations: boolean;
  }> => {
    const actor = await resolveActorForRequest();
    if (!actor.ok) {
      return { hasActiveObligations: false };
    }
    try {
      const probe = await createSubmissionRepository().hasActiveObligations({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
      });
      if (probe.ok && probe.data.has_active_obligations) {
        return { hasActiveObligations: true };
      }
    } catch {
      // Fail closed without disrupting AppShell rendering.
    }
    return { hasActiveObligations: false };
  },
);

export const resolveNavActorForAppShell = cache(
  async (input: {
    directEntryEnabled: boolean;
    adminNavigationEnabled?: boolean;
  }): Promise<NavActorProjection | null> => {
    if (!input.directEntryEnabled && !input.adminNavigationEnabled) {
      return null;
    }
    const actor = await resolveActorForRequest();
    if (!actor.ok) return null;
    const projection: NavActorProjection & {
      effective_report_review_scopes?: typeof actor.actor.effective_report_review_scopes;
    } = {
      capabilities: actor.actor.capabilities,
      scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
      ...(actor.actor.effective_grants !== undefined
        ? { effective_grants: actor.actor.effective_grants }
        : {}),
      ...(actor.actor.effective_report_review_scopes !== undefined
        ? { effective_report_review_scopes: actor.actor.effective_report_review_scopes }
        : {}),
      ...(actor.actor.allowed_worker_tabs !== undefined
        ? { allowed_worker_tabs: actor.actor.allowed_worker_tabs }
        : {}),
      hasAttendanceDepartmentHeadAccess: hasActiveDepartmentHeadRole(actor.actor),
    };
    if (process.env.WORK_REPORTS_API_ENABLED === "true") {
      if (!workReportAssignmentPredicate(projection)) {
        const assignmentAccess = await resolveWorkReportAssignmentAccessForRequest();
        if (assignmentAccess.hasAssignmentAccess) {
          projection.hasWorkReportAssignmentAccess = true;
        }
      }
      if (!workReportsNavPredicate(projection)) {
        const obligations = await resolveWorkReportObligationsAccessForRequest();
        if (obligations.hasActiveObligations) {
          projection.hasWorkReportObligations = true;
        }
      }
    }
    if (
      process.env.DIRECT_ENTRY_API_ENABLED === "true" &&
      !vendorFinanceRecordNavPredicate(projection)
    ) {
      const vfinAccess = await resolveVendorFinanceAccessForRequest();
      if (vfinAccess.can_view) {
        projection.hasVendorFinanceAccess = true;
        if (vfinAccess.can_record) {
          projection.hasVendorFinanceRecordAccess = true;
        }
        if (vfinAccess.can_reconcile) {
          projection.hasVendorFinanceReconcileAccess = true;
        }
      }
    }
    if (
      process.env.DIRECT_ENTRY_API_ENABLED === "true" &&
      !leaveManagementNavPredicate(projection)
    ) {
      const leaveAccess = await resolveLeaveManagementAccessForRequest();
      if (leaveAccess?.canAccess) {
        projection.hasLeaveManagementAccess = true;
        projection.hasLeaveAdminAccess =
          leaveAccess.canManageConfig || leaveAccess.canViewMonthlyReport;
      }
    }
    if (
      process.env.DIRECT_ENTRY_API_ENABLED === "true" &&
      !salaryAdvanceNavPredicate(projection)
    ) {
      const salaryAdvanceAccess = await resolveSalaryAdvanceAccessForRequest();
      if (salaryAdvanceAccess?.canAccess) {
        projection.hasSalaryAdvanceAccess = true;
      }
    }
    if (
      process.env.DIRECT_ENTRY_API_ENABLED === "true" &&
      hasVendorReferrerManageCapability(projection)
    ) {
      const vrAccess = await resolveVendorReferrerAccessForRequest();
      if (vrAccess.canManage || vrAccess.canViewReport) {
        projection.hasVendorReferrerAccess = true;
      }
    }
    if (input.directEntryEnabled && !changeRequestsNavPredicate(projection)) {
      const historical = await resolveChangeRequestHistoricalAccessForRequest();
      if (historical.hasHistoricalRequests) {
        return {
          ...projection,
          hasHistoricalChangeRequests: true,
        };
      }
    }
    return projection;
  },
);
