/**
 * P3-W06A — Capability projection cho navigation.
 *
 * Nguyên tắc (P2-P3 R00 §Reuse matrix + P3-C01 §2.1/§2.1a):
 * - Tái sử dụng `CAPABILITIES` từ src/lib/auth/direct-entry-v2.ts.
 * - Tái sử dụng `DirectEntryActor` shape từ cùng module (đã được `actorProjection`
 *   trong auth-session-core.ts sanitize trước khi lộ ra client).
 * - Không tạo role engine mới: mỗi entry khai báo `capability` metadata
 *   (đã có sẵn trong registry), nav chỉ hỏi "actor có ít nhất một token trong
 *   entry's predicate không?".
 * - Direct Entry nav entry có `capability: "entry_admin"` đại diện cho
 *   "một trong entry_own | entry_team | entry_admin" (registry.ts giải thích).
 *   T1A biến metadata tĩnh đó thành pure predicate resolve từ session thật.
 * - Full Admin authority rule (P3-C01 §2.1a) là AND của `entry_admin` ∧
 *   `recruiter_master_manage` ∧ `team_master_manage` cùng effective all scope.
 * - Catalog operator authority yêu cầu `catalog_master_manage` cùng effective all scope.
 *
 * Tách thành file riêng để:
 * - test thuần với `node:test` (registry.ts chỉ phụ thuộc React, file này thuần).
 * - page boundary (server component) import thẳng — không phải build module mới.
 */

import {
  normalizeAllowedWorkerOperationsTabs,
  type AssignedRoleSummary,
  type Capability,
  type PairedEffectiveGrant,
  type WorkerOperationsTabId,
} from "../auth/direct-entry-v2.ts";

/** Subset các field mà nav cần từ actor projection. */
export type NavActorProjection = {
  capabilities: readonly Capability[];
  scopes: readonly { kind: "own" | "team" | "all" }[];
  effective_grants?: readonly PairedEffectiveGrant[];
  effective_report_review_scopes?: readonly { kind: "all" | "team"; team_id?: string | null; label?: string }[];
  hasHistoricalChangeRequests?: boolean;
  hasWorkReportObligations?: boolean;
  hasVendorFinanceAccess?: boolean;
  hasVendorFinanceRecordAccess?: boolean;
  hasVendorFinanceReconcileAccess?: boolean;
  hasLeaveManagementAccess?: boolean;
  hasLeaveAdminAccess?: boolean;
  hasSalaryAdvanceAccess?: boolean;
  hasAttendanceDepartmentHeadAccess?: boolean;
  allowed_worker_tabs?: readonly WorkerOperationsTabId[];
};

/** Predicate phụ thuộc entry — registry.ts có metadata `capability`. */
export type NavCapabilityPredicate = (actor: NavActorProjection) => boolean;

/** Bộ token "một trong" mà registry metadata `entry_admin` đại diện. */
const DIRECT_ENTRY_ENTRY_CAPABILITIES: readonly Capability[] = [
  "entry_own",
  "entry_team",
  "entry_admin",
];

/** Direct Entry: actor phải có ít nhất một trong entry_own | entry_team | entry_admin. */
export const directEntryNavPredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.some((capability) =>
    DIRECT_ENTRY_ENTRY_CAPABILITIES.includes(capability)
  );

/** Admin authority rule (P3-C01 §2.1a): AND của 3 token ở scope `all`. */
export const ADMIN_AUTHORITY_CAPABILITIES: readonly Capability[] = [
  "entry_admin",
  "recruiter_master_manage",
  "team_master_manage",
];

function hasStrictNavPairedAll(actor: NavActorProjection, capability: Capability): boolean {
  if (!Array.isArray(actor.effective_grants)) return false;
  return actor.effective_grants.some(
    (grant) =>
      grant.capability === capability &&
      grant.scope_kind === "ALL" &&
      (grant.scope_id === null || grant.scope_id === undefined),
  );
}

function hasNavAllCapability(actor: NavActorProjection, capability: Capability): boolean {
  if (Array.isArray(actor.effective_grants)) {
    return hasStrictNavPairedAll(actor, capability);
  }
  return (
    actor.scopes.some((scope) => scope.kind === "all") &&
    actor.capabilities.includes(capability)
  );
}

export const adminAuthorityNavPredicate: NavCapabilityPredicate = (actor) =>
  ADMIN_AUTHORITY_CAPABILITIES.every((required) => hasNavAllCapability(actor, required));

/** Narrow catalog authority shared by Admin and Accounting (WP5B-2 paired @ ALL when effective_grants is present). */
export const catalogOperatorNavPredicate: NavCapabilityPredicate = (actor) =>
  hasNavAllCapability(actor, "catalog_master_manage");

/** Security administration remains limited to the canonical Full Admin triple. */
export const adminSecurityNavPredicate = adminAuthorityNavPredicate;

/** Admin area catalog tabs remain available to catalog operators or Full Admin. */
export const adminAreaNavPredicate: NavCapabilityPredicate = (actor) =>
  catalogOperatorNavPredicate(actor) || adminSecurityNavPredicate(actor);

/** The company-wide worker edit history is a separate, explicitly granted Group A paired authority. */
export const workerEditHistoryNavPredicate: NavCapabilityPredicate = (actor) =>
  hasStrictNavPairedAll(actor, "worker_edit_history_view");

/**
 * Canonical Full Admin or BoD executive authority (paired `@ ALL` when `effective_grants` is provided,
 * with legacy `{ capabilities, scopes }` fallback for un-migrated Group B/C/WP6 test actors):
 * - Full Admin triple (`entry_admin` + `recruiter_master_manage` + `team_master_manage` @ `all`), OR
 * - `entry_privileged_edit` (Direct Entry / P3.1 BoD executive capability) @ `all`, OR
 * - BOTH `report_analytics_view` AND `report_view` (Work Reports F0 §2 BoD executive bundle) @ `all`.
 *
 * Used for Provinces & Industrial Parks catalog (`/admin/catalog/provinces`, `/admin/catalog/industrial-parks`)
 * and global attendance admin configuration / branch / slot-policy surfaces.
 */
export const recruitmentLocationCatalogNavPredicate: NavCapabilityPredicate = (actor) => {
  if (adminSecurityNavPredicate(actor)) return true;
  if (hasNavAllCapability(actor, "entry_privileged_edit")) return true;
  return (
    hasNavAllCapability(actor, "report_analytics_view") &&
    hasNavAllCapability(actor, "report_view")
  );
};

export const attendanceFullAdminOrBodNavPredicate = recruitmentLocationCatalogNavPredicate;

const ATTENDANCE_TEAM_LEADER_REQUIRED_CAPABILITIES: readonly Capability[] = [
  "team_manager_assign",
  "report_view",
  "report_analytics_view",
];

/**
 * Pure check for an active contextual `DEPARTMENT_HEAD` assignment on a non-empty department scope.
 */
export function hasActiveDepartmentHeadRole(
  actor: { assigned_roles?: readonly AssignedRoleSummary[] } | null | undefined,
): boolean {
  return (actor?.assigned_roles ?? []).some(
    (role) =>
      role.role_code === "DEPARTMENT_HEAD" &&
      role.scope_kind === "CONTEXT_DEPARTMENT" &&
      typeof role.scope_id === "string" &&
      role.scope_id.trim().length > 0,
  );
}

/**
 * Canonical Team Leader bundle for viewing team-scoped attendance reports:
 * - When `effective_grants` is present: ALL 3 paired grants (`team_manager_assign`, `report_view`,
 *   `report_analytics_view`) on the SAME non-empty `CONTEXT_TEAM` `scope_id`.
 * - Legacy fallback (test actors without `effective_grants`): `team` scope + all 3 capabilities.
 * Database remains the final authority via `direct_entry_assert_team_leader_current_team`.
 */
export const attendanceTeamLeaderReportNavPredicate: NavCapabilityPredicate = (actor) => {
  if (Array.isArray(actor.effective_grants)) {
    const capabilitiesByTeamScope = new Map<string, Set<Capability>>();
    for (const grant of actor.effective_grants) {
      if (
        grant.scope_kind !== "CONTEXT_TEAM" ||
        typeof grant.scope_id !== "string" ||
        grant.scope_id.trim().length === 0
      ) {
        continue;
      }
      if (!ATTENDANCE_TEAM_LEADER_REQUIRED_CAPABILITIES.includes(grant.capability)) {
        continue;
      }
      const scopeId = grant.scope_id.trim();
      let caps = capabilitiesByTeamScope.get(scopeId);
      if (!caps) {
        caps = new Set<Capability>();
        capabilitiesByTeamScope.set(scopeId, caps);
      }
      caps.add(grant.capability);
      if (caps.size === ATTENDANCE_TEAM_LEADER_REQUIRED_CAPABILITIES.length) {
        return true;
      }
    }
    return false;
  }
  return (
    actor.scopes.some((scope) => scope.kind === "team") &&
    actor.capabilities.includes("team_manager_assign") &&
    actor.capabilities.includes("report_view") &&
    actor.capabilities.includes("report_analytics_view")
  );
};

/**
 * Department Head predicate for viewing department-scoped attendance reports:
 * accepts either the minimal server-projected boolean (`hasAttendanceDepartmentHeadAccess`)
 * or a full server actor carrying an active `DEPARTMENT_HEAD @ CONTEXT_DEPARTMENT` assignment.
 */
export const attendanceDepartmentHeadReportNavPredicate = (
  actor: NavActorProjection & { assigned_roles?: readonly AssignedRoleSummary[] },
): boolean =>
  actor.hasAttendanceDepartmentHeadAccess === true ||
  hasActiveDepartmentHeadRole(actor);

/**
 * Attendance report viewer predicate (`/admin/attendance`):
 * - Full Admin or BoD (`recruitmentLocationCatalogNavPredicate`), OR
 * - Canonical Team Leader bundle (`attendanceTeamLeaderReportNavPredicate`), OR
 * - Active Department Head (`attendanceDepartmentHeadReportNavPredicate`).
 */
export const attendanceReportNavPredicate: NavCapabilityPredicate = (actor) =>
  recruitmentLocationCatalogNavPredicate(actor) ||
  attendanceTeamLeaderReportNavPredicate(actor) ||
  attendanceDepartmentHeadReportNavPredicate(actor);

/** Top-level Admin panel shell admits catalog operators, Full Admin, Attendance Report readers (BoD or Team Leader), or Worker Edit History readers. */
export const adminPanelNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAreaNavPredicate(actor) || attendanceReportNavPredicate(actor) || workerEditHistoryNavPredicate(actor);

/**
 * P2.5-W06A-R1 / WP8B-1: Project Operations authority chinh xac theo DB W02
 * (direct_entry_assert_project_admin) = entry_admin paired @ ALL (khi co effective_grants)
 * hoac Team Leader contextual (`team_manager_assign`).
 * KHONG yeu cau recruiter_master_manage/team_master_manage (RPC W02 khong yeu cau).
 * Dung CHUNG cho nav visibility va page decision.
 */
export const projectAdminNavPredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.includes("team_manager_assign") ||
  hasNavAllCapability(actor, "entry_admin");

/**
 * P2.5-W06-R1: Worker Operations audience.
 *
 * Mo surface khi actor la mot trong:
 *  - (entry_admin | change_review) + effective all scope  → admin / BoD-Ke toan reviewer
 *  - change_request_create                                 → nguoi de xuat (PM qua assignment)
 *  - entry_own | entry_team | entry_admin                  → audience uploader hien huu
 * Reporting audience=all ma thieu capability KHONG mo (fail-closed).
 */
export const WORKER_OPERATIONS_ALL_CAPABILITIES: readonly Capability[] = [
  "entry_admin",
  "change_review",
];

/** scope=all tab + review queue: (entry_admin | change_review) + effective all scope. */
export const workerOperationsAllScopePredicate: NavCapabilityPredicate = (actor) =>
  actor.scopes.some((scope) => scope.kind === "all") &&
  actor.capabilities.some((capability) =>
    WORKER_OPERATIONS_ALL_CAPABILITIES.includes(capability));

/** Reviewer queue: change_review + effective all scope (khop W05 #55). */
export const workerOperationsReviewPredicate: NavCapabilityPredicate = (actor) =>
  actor.scopes.some((scope) => scope.kind === "all") &&
  actor.capabilities.includes("change_review");

/** Team tab visibility only; the directory RPC still checks current assignment per request. */
export const workerOperationsTeamScopePredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.includes("team_manager_assign") &&
  actor.scopes.some((scope) => scope.kind === "team");

export const workerOperationsNavPredicate: NavCapabilityPredicate = (actor) => {
  if (resolveAllowedWorkerOperationsTabs(actor).length > 0) return true;
  if (workerOperationsAllScopePredicate(actor)) return true;
  if (actor.capabilities.includes("change_request_create")) return true;
  if (workerOperationsTeamScopePredicate(actor)) return true;
  return actor.capabilities.some((capability) =>
    DIRECT_ENTRY_ENTRY_CAPABILITIES.includes(capability));
};

/**
 * Resolves the canonical ordered list of Worker Operations tabs (`uploader`, `recruited`, `managed`, `team`, `all`)
 * confirmed by `direct_entry_resolve_actor_context.allowed_worker_tabs`.
 * Fail-closed (`[]`) when `allowed_worker_tabs` is absent or empty; never guesses tab authority on the client/app layer.
 */
export function resolveAllowedWorkerOperationsTabs(
  actor: { allowed_worker_tabs?: readonly WorkerOperationsTabId[] | null } | null | undefined,
): readonly WorkerOperationsTabId[] {
  if (!actor || !Array.isArray(actor.allowed_worker_tabs)) return [];
  return normalizeAllowedWorkerOperationsTabs(actor.allowed_worker_tabs);
}

/**
 * Mirrors `direct_entry_input_catalog_unscoped_v42` capability requirement (`entry_create` OR `entry_own`)
 * so `/direct-entry/workers` does not fire an avoidable 403 to `GET /api/direct-entry/catalog` on mount.
 */
export function canReadWorkerDirectoryCatalog(
  actor: { capabilities: readonly string[] } | null | undefined,
): boolean {
  if (!actor) return false;
  return (
    actor.capabilities.includes("entry_create") ||
    actor.capabilities.includes("entry_own")
  );
}

/**
 * R2.2: Reviewer mode predicate cho module /direct-entry/change-requests.
 * Actor co tham quyen duyet khi co (entry_admin | change_review) @ all hoac team_manager_assign @ team.
 */
export const changeRequestsReviewerPredicate: NavCapabilityPredicate = (actor) =>
  workerOperationsAllScopePredicate(actor) ||
  workerOperationsTeamScopePredicate(actor) ||
  (actor.capabilities.includes("change_review") &&
    actor.scopes.some((scope) => scope.kind === "team"));

/**
 * R2.2: Proposer / history mode predicate cho module /direct-entry/change-requests.
 */
export const changeRequestsProposerPredicate: NavCapabilityPredicate = (actor) =>
  actor.capabilities.includes("change_request_create") || directEntryNavPredicate(actor);

/**
 * R2.2: Navigation & default page predicate cho /direct-entry/change-requests.
 */
export const changeRequestsNavPredicate: NavCapabilityPredicate = (actor) =>
  changeRequestsReviewerPredicate(actor) ||
  changeRequestsProposerPredicate(actor) ||
  actor.hasHistoricalChangeRequests === true;

export const workReportTemplateManagePredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || (
    actor.capabilities.includes("report_form_manage") &&
    actor.scopes.some((scope) => scope.kind === "all")
  );

export const workReportAssignmentPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || (
    actor.capabilities.includes("report_assign") &&
    actor.scopes.some((scope) => scope.kind === "team" || scope.kind === "all")
  );

export const workReportViewPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || (
    actor.capabilities.includes("report_view") &&
    actor.scopes.some((scope) => scope.kind === "own" || scope.kind === "team" || scope.kind === "all")
  );

export const workReportAnalyticsPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || (
    actor.capabilities.includes("report_analytics_view") &&
    actor.scopes.some((scope) => scope.kind === "team" || scope.kind === "all")
  );

export const workReportReviewPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  (actor.capabilities.some((capability) => (capability as string) === "report_review") &&
    actor.scopes.some((scope) => scope.kind === "team" || scope.kind === "all")) ||
  (actor.effective_report_review_scopes?.some((scope) => scope.kind === "all" || scope.kind === "team") ?? false);

export const workReportDelegationPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || (
    actor.capabilities.some((capability) => (capability as string) === "report_delegate") &&
    actor.scopes.some((scope) => scope.kind === "team" || scope.kind === "all")
  );

/** Staff access is projected by the server from an active obligation, never inferred from role/title. */
export const workReportsNavPredicate: NavCapabilityPredicate = (actor) =>
  actor.hasWorkReportObligations === true ||
  workReportTemplateManagePredicate(actor) ||
  workReportAssignmentPredicate(actor) ||
  workReportViewPredicate(actor) ||
  workReportAnalyticsPredicate(actor) ||
  workReportReviewPredicate(actor) ||
  workReportDelegationPredicate(actor);

export const workforceOffboardingNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  (actor.capabilities.includes("entry_privileged_edit") &&
    actor.scopes.some((scope) => scope.kind === "all")) ||
  (actor.capabilities.includes("team_manager_assign") &&
    actor.scopes.some((scope) => scope.kind === "team"));

/**
 * VFIN-01 / VFIN-02: Vendor Finance navigation predicate (fail-closed).
 * Accepts:
 *  1. Canonical Full Admin (`entry_admin` + `recruiter_master_manage` + `team_master_manage` @ `all`);
 *  2. Server-probed active membership in immutable `system_key = 'ACCOUNTING'` department or
 *     narrow VFIN global role (`hasVendorFinanceAccess === true` / `hasVendorFinanceRecordAccess === true` /
 *     `hasVendorFinanceReconcileAccess === true`, never synthesized into actor grants);
 *  3. Direct VFIN capability grant (`vendor_finance_view` | `vendor_finance_record`) with effective `all` scope.
 * `catalog_master_manage`, `team_manager_assign`, `entry_admin` alone, Work Reports capabilities,
 * and retired `payment_view` / `payment_edit` never open Vendor Finance.
 */
export const vendorFinanceNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  actor.hasVendorFinanceAccess === true ||
  actor.hasVendorFinanceRecordAccess === true ||
  actor.hasVendorFinanceReconcileAccess === true ||
  hasNavAllCapability(actor, "vendor_finance_view") ||
  hasNavAllCapability(actor, "vendor_finance_record");

/** VFIN-01 / VFIN-02: Record/mutation predicate (excludes BoD view-only & narrow reconcilers). */
export const vendorFinanceRecordNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  actor.hasVendorFinanceRecordAccess === true ||
  hasNavAllCapability(actor, "vendor_finance_record");

/** VFIN-02: Narrow reconcile predicate (includes `GLOBAL_RECONCILER` and `CASH_HOLDER` without requiring `can_record`). */
export const vendorFinanceReconcileNavPredicate: NavCapabilityPredicate = (actor) =>
  vendorFinanceRecordNavPredicate(actor) ||
  actor.hasVendorFinanceReconcileAccess === true;

/** VFIN-02: Full Admin governance predicate for project accountant assignments, Vendor-Project links & global roles. */
export const vendorFinanceAdminNavPredicate: NavCapabilityPredicate = adminAuthorityNavPredicate;

/**
 * WP2 Leave Management navigation predicate:
 * Opens for Canonical Full Admin or server-verified personal employee / leave operator / approver / HR report viewer
 * (`hasLeaveManagementAccess === true`, excluding shared non-employee accounts).
 */
export const leaveManagementNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) || actor.hasLeaveManagementAccess === true;

export const leaveAdminNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  actor.hasLeaveAdminAccess === true;

/**
 * W2S2 WP2 Salary Advance navigation predicate:
 * Opens for Canonical Full Admin, BoD (`entry_privileged_edit` @ `all` or
 * `report_analytics_view` + `report_view` @ `all`), or server-verified
 * Project Manager / Project Accountant / Supervisory Viewer (`hasSalaryAdvanceAccess === true`).
 */
export const salaryAdvanceNavPredicate: NavCapabilityPredicate = (actor) =>
  adminAuthorityNavPredicate(actor) ||
  actor.hasSalaryAdvanceAccess === true ||
  hasNavAllCapability(actor, "entry_privileged_edit") ||
  (hasNavAllCapability(actor, "report_analytics_view") &&
    hasNavAllCapability(actor, "report_view"));

/** Bảng ánh xạ `entry.capability` metadata → predicate tương ứng. */
export const NAV_CAPABILITY_PREDICATES: Readonly<Record<string, NavCapabilityPredicate>> = {
  any: () => true,
  owner: adminAuthorityNavPredicate,
  admin_area: adminAreaNavPredicate,
  attendance_report: attendanceReportNavPredicate,
  finance: vendorFinanceNavPredicate,
  leave: leaveManagementNavPredicate,
  leave_admin: leaveAdminNavPredicate,
  salary_advances: salaryAdvanceNavPredicate,
  hrp: directEntryNavPredicate,
  entry_own: directEntryNavPredicate,
  entry_team: directEntryNavPredicate,
  entry_admin: directEntryNavPredicate,
  project_admin: projectAdminNavPredicate,
  worker_operations: workerOperationsNavPredicate,
  change_requests: changeRequestsNavPredicate,
  work_reports: workReportsNavPredicate,
  work_report_assignments: workReportAssignmentPredicate,
  work_report_reviews: workReportReviewPredicate,
  work_report_analytics: workReportAnalyticsPredicate,
  workforce_offboarding: workforceOffboardingNavPredicate,
};

/** Resolver trung tâm — đảm bảo mỗi entry luôn có predicate. */
export function resolveNavCapabilityPredicate(
  capabilityKey: string,
): NavCapabilityPredicate {
  const predicate = NAV_CAPABILITY_PREDICATES[capabilityKey];
  if (predicate) return predicate;
  // Token không xác định → fail-closed: ẩn entry thay vì render với quyền ngầm định.
  return () => false;
}

/**
 * Quyết định một nav entry có được render cho actor này không.
 * Thuần, không phụ thuộc React, không đọc env.
 */
export function decideNavEntryVisibility(input: {
  capabilityKey: string;
  actor: NavActorProjection | null;
  viewport: "desktop" | "mobile";
  entryVisibleInViewport: boolean;
}): boolean {
  if (!input.entryVisibleInViewport) return false;
  // Actor chưa resolve (page chưa có session) hoặc resolve fail:
  // - `any` vẫn hiện (Dashboard).
  // - capability khác: ẩn cho tới khi actor OK.
  if (input.actor === null) {
    return input.capabilityKey === "any";
  }
  return resolveNavCapabilityPredicate(input.capabilityKey)(input.actor);
}
