/**
 * P3-W03-S02B-R3A - Pure route decision cho /direct-entry.
 *
 * Nhan du lieu DA RESOLVE (khong doc env/cookies/DB); output la discriminated union gioi han.
 * Khong nhan actor/capability/scope tu client; API/DB van la authority.
 */
import {
  hasPairedAllReportingAccess,
  hasPairedCapability,
  type ActorResolution,
} from "./direct-entry-v2.ts";
import { decideSessionPageAccess } from "./session-page-access.ts";
import type { NavActorProjection, NavCapabilityPredicate } from "../navigation/registry-capability.ts";
import {
  adminAreaNavPredicate,
  adminPanelNavPredicate,
  adminSecurityNavPredicate,
  attendanceReportNavPredicate,
  changeRequestsNavPredicate,
  directEntryNavPredicate,
  projectAdminNavPredicate,
  recruitmentLocationCatalogNavPredicate,
  vendorReferrerNavPredicate,
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportTemplateManagePredicate,
  workReportViewPredicate,
  workReportsNavPredicate,
  workforceOffboardingNavPredicate,
  workerOperationsNavPredicate,
  workerEditHistoryNavPredicate,
} from "../navigation/registry-capability.ts";

export type DirectEntryPageDecision =
  | "NOT_FOUND"
  | "REDIRECT_LOGIN"
  | "ACCOUNT_UNAVAILABLE"
  | "TEMPORARY_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "ALLOW";

function decideCapabilityPageAccess(input: {
  actor: ActorResolution | null;
  allowed: NavCapabilityPredicate;
}): DirectEntryPageDecision {
  const actor = input.actor;
  if (!actor) return "TEMPORARY_UNAVAILABLE";
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") return "REDIRECT_LOGIN";
    if (actor.reason === "ACTOR_MAPPING_MISSING" || actor.reason === "ACTOR_DISABLED") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "TEMPORARY_UNAVAILABLE";
  }
  return input.allowed(actor.actor) ? "ALLOW" : "ACCESS_DENIED";
}

/** Server page gate for /admin; not coupled to the Direct Entry UI flag. */
export function decideAdminAreaAccess(input: {
  actor: ActorResolution | null;
  hasVendorReferrerAccess?: boolean;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) =>
      adminPanelNavPredicate({
        ...actor,
        ...(input.hasVendorReferrerAccess !== undefined
          ? { hasVendorReferrerAccess: input.hasVendorReferrerAccess }
          : {}),
      }),
  });
}

export type AdminLandingPath =
  | "/admin/organization/persons"
  | "/admin/catalog/personnel"
  | "/admin/attendance"
  | "/admin/worker-edit-history"
  | "/admin/catalog/vendors";

/**
 * WP13 M2: Resolves the canonical default landing page for `/admin` strictly from
 * real server-resolved capabilities/guards (zero email/role-label hardcoding, zero
 * redirect loops — every target URL's page gate matches the predicate that chose it):
 * 1) Full Admin -> `/admin/organization/persons`
 * 2) Catalog / HR Operator -> `/admin/catalog/personnel`
 * 3) Attendance Report viewer (BoD / Team Leader / Department Head) -> `/admin/attendance`
 * 4) `worker_edit_history_view`-only -> `/admin/worker-edit-history`
 * 5) BoD Vendor Referrer manager -> `/admin/catalog/vendors`
 */
export function resolveAdminLandingPath(
  actor: ActorResolution | null,
  options?: { hasVendorReferrerAccess?: boolean },
): AdminLandingPath | null {
  if (!actor?.ok) return null;
  if (adminSecurityNavPredicate(actor.actor)) return "/admin/organization/persons";
  if (adminAreaNavPredicate(actor.actor)) return "/admin/catalog/personnel";
  if (attendanceReportNavPredicate(actor.actor)) return "/admin/attendance";
  if (workerEditHistoryNavPredicate(actor.actor)) return "/admin/worker-edit-history";
  if (
    vendorReferrerNavPredicate({
      ...actor.actor,
      ...(options?.hasVendorReferrerAccess !== undefined
        ? { hasVendorReferrerAccess: options.hasVendorReferrerAccess }
        : {}),
    })
  ) {
    return "/admin/catalog/vendors";
  }
  return null;
}

/** Separate direct-URL gate for the implemented Personnel catalog page. */
export function decidePersonnelCatalogPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: adminAreaNavPredicate,
  });
}

/** Separate direct-URL gate for the implemented Team catalog page. */
export function decideTeamCatalogPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: adminAreaNavPredicate,
  });
}

/** Separate direct-URL gate for the implemented Vendor catalog page (admits catalog operators, Full Admin, and BoD with vendor referrer access). */
export function decideVendorCatalogPageAccess(input: {
  actor: ActorResolution | null;
  hasVendorReferrerAccess?: boolean;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) =>
      adminAreaNavPredicate(actor) ||
      vendorReferrerNavPredicate({
        ...actor,
        ...(input.hasVendorReferrerAccess !== undefined
          ? { hasVendorReferrerAccess: input.hasVendorReferrerAccess }
          : {}),
      }),
  });
}

/**
 * Page gate for the Vendor recruitment report (BoD with `vendor_referrer_manage` only).
 * Non-BoD Admin, HR, Accounting, Team Leader, and Employee receive `ACCESS_DENIED`.
 */
export function decideVendorReferrerReportPageAccess(input: {
  actor: ActorResolution | null;
  hasVendorReferrerAccess?: boolean;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) =>
      vendorReferrerNavPredicate({
        ...actor,
        ...(input.hasVendorReferrerAccess !== undefined
          ? { hasVendorReferrerAccess: input.hasVendorReferrerAccess }
          : {}),
      }),
  });
}

/** Separate direct-URL gate for the implemented Labor Type catalog page. */
export function decideLaborTypeCatalogPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: adminAreaNavPredicate,
  });
}

/**
 * Separate direct-URL gate for `/admin/attendance` (Full Admin, BoD, and canonical Team Leader).
 * Catalog-only operators (`catalog_master_manage`) and incomplete team/report roles are denied.
 */
export function decideAttendanceReportPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: attendanceReportNavPredicate,
  });
}

/**
 * Separate direct-URL gate for `/admin/catalog/provinces` and
 * `/admin/catalog/industrial-parks` (Full Admin and BoD only).
 * Catalog-only operators (`catalog_master_manage`) and Team Leaders are denied.
 */
export function decideRecruitmentLocationCatalogPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: recruitmentLocationCatalogNavPredicate,
  });
}

export function decideWorkerEditHistoryPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({ actor: input.actor, allowed: workerEditHistoryNavPredicate });
}

/**
 * Separate direct-URL gate for the existing-account access page (P3.1-W05-A).
 * Security administration is limited to the canonical Full Admin triple at
 * effective `all` scope; the broader Admin-area predicate (which also admits a
 * catalog operator) must NOT be reused here.
 */
export function decideAccountAccessPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: adminSecurityNavPredicate,
  });
}

/**
 * Separate direct-URL gate for `/admin/organization/persons` and
 * `/admin/organization/persons/[personId]`. Mirrors Account/Department admin authority
 * (canonical Full Admin triple at effective `all` scope); never widens to BoD or catalog operators.
 */
export function decideOrganizationPersonsPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideAccountAccessPageAccess(input);
}

function decideUiCapabilityPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
  allowed: NavCapabilityPredicate;
}): DirectEntryPageDecision {
  if (!input.uiEnabled) return "NOT_FOUND";
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: input.allowed,
  });
}

export function decideDirectEntryPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideUiCapabilityPageAccess({
    uiEnabled: input.uiEnabled,
    actor: input.actor,
    allowed: directEntryNavPredicate,
  });
}

/**
 * P2.5-W06A-R1: quyet dinh truy cap cho /direct-entry/projects.
 * Dung CHUNG predicate voi nav (projectAdminNavPredicate) — khong suy dien
 * quyen tu role/email/owner label. entry_own/entry_team KHONG duoc render
 * page roi moi cho API 403: phai ACCESS_DENIED ngay tu server decision.
 */
export function decideProjectOperationsPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideUiCapabilityPageAccess({
    uiEnabled: input.uiEnabled,
    actor: input.actor,
    allowed: projectAdminNavPredicate,
  });
}

/** Server-side fallback for an empty project list; mirrors #72's catalog-operator/admin authority order (WP8B-1 paired @ ALL when effective_grants is present). */
export function canManageProjectMasterFromActor(actor: ActorResolution | null): boolean {
  if (actor?.ok !== true) return false;
  if (actor.actor.effective_grants !== undefined) {
    return (
      hasPairedCapability(actor.actor, "catalog_master_manage", { kind: "all" }) ||
      hasPairedCapability(actor.actor, "entry_admin", { kind: "all" })
    );
  }
  const all = actor.actor.scopes.some((scope) => scope.kind === "all");
  return all && (actor.actor.capabilities.includes("catalog_master_manage") ||
    actor.actor.capabilities.includes("entry_admin"));
}

/**
 * P2.5-W06-R1: quyet dinh truy cap cho /direct-entry/workers.
 * Dung CHUNG predicate voi nav (workerOperationsNavPredicate) — khong hai logic lech nhau.
 * Reviewer (change_review + all) duoc vao; reporting audience=all thieu capability bi tu choi.
 */
export function decideWorkerOperationsPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideUiCapabilityPageAccess({
    uiEnabled: input.uiEnabled,
    actor: input.actor,
    allowed: workerOperationsNavPredicate,
  });
}

export type WorkReportAssignmentAccessStatus = "allowed" | "denied" | "unavailable";

/**
 * WP13 M3: Session gate for personal Work Reports pages (`/work-reports` and
 * `/work-reports/my-reports`). Enforces feature flag and valid authenticated
 * session (redirecting anonymous to login and fail-closing disabled/unmapped/
 * unavailable actors) without requiring active obligations so authenticated
 * users can still view their own History even after active obligations end.
 */
export function decidePersonalWorkReportsPageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
}): Exclude<DirectEntryPageDecision, "ACCESS_DENIED"> {
  if (input.enabledFlag !== "true") return "NOT_FOUND";
  return decideSessionPageAccess(input.actor);
}

export function decideWorkReportsPageAccess(input: {
  actor: ActorResolution | null;
  hasWorkReportObligations?: boolean;
  hasWorkReportAssignmentAccess?: boolean;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) => workReportsNavPredicate({
      ...actor,
      hasWorkReportObligations: input.hasWorkReportObligations === true,
      hasWorkReportAssignmentAccess: input.hasWorkReportAssignmentAccess === true,
    }),
  });
}

export function decideWorkReportTemplatesPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({ actor: input.actor, allowed: workReportTemplateManagePredicate });
}

export function decideWorkReportAssignmentsPageAccess(input: {
  actor: ActorResolution | null;
  hasWorkReportAssignmentAccess?: boolean;
  assignmentAccessStatus?: WorkReportAssignmentAccessStatus;
}): DirectEntryPageDecision {
  const decision = decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) =>
      workReportAssignmentPredicate({
        ...actor,
        hasWorkReportAssignmentAccess:
          input.hasWorkReportAssignmentAccess === true ||
          input.assignmentAccessStatus === "allowed",
      }),
  });
  if (decision === "ACCESS_DENIED" && input.assignmentAccessStatus === "unavailable") {
    return "TEMPORARY_UNAVAILABLE";
  }
  return decision;
}

export function decideWorkReportAnalyticsPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({
    actor: input.actor,
    allowed: (actor) =>
      workReportAnalyticsPredicate(actor) || workReportViewPredicate(actor),
  });
}

/**
 * Offboarding / unemployed worker report visibility hint (WP8B-2 paired via
 * `workforceOffboardingNavPredicate`). The RPC (`direct_entry_offboarding_authority`)
 * still enforces exact authority (Full Admin triple at ALL, BoD entry_privileged_edit
 * at ALL, or current Team Leader paired on CONTEXT_TEAM).
 */
export function canViewOffboardingReport(
  actor: (NavActorProjection & { enabled?: boolean }) | null,
): boolean {
  if (!actor || actor.enabled === false) return false;
  return workforceOffboardingNavPredicate(actor);
}

export function decideWorkforceOffboardingPageAccess(input: {
  actor: ActorResolution | null;
}): DirectEntryPageDecision {
  return decideCapabilityPageAccess({ actor: input.actor, allowed: canViewOffboardingReport });
}

export const HISTORICAL_CHANGE_REQUEST_QUEUES = [
  "PROPOSER_PENDING",
  "PROPOSER_RESOLVED",
  "REVIEWER_RESOLVED",
] as const;

export type HistoricalChangeRequestQueue =
  (typeof HISTORICAL_CHANGE_REQUEST_QUEUES)[number];

export type ChangeRequestHistoricalAccessProbe = {
  hasProposerPending: boolean;
  hasProposerResolved: boolean;
  hasReviewerResolved: boolean;
  hasHistoricalRequests: boolean;
};

export const EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE: ChangeRequestHistoricalAccessProbe =
  Object.freeze({
    hasProposerPending: false,
    hasProposerResolved: false,
    hasReviewerResolved: false,
    hasHistoricalRequests: false,
  });

/**
 * R2.2 Post-merge P0: probe cac queue lich su tuong minh theo R2.1 contract (#129)
 * thay vi state=null (vi state=null chi tra cac request co audience <> 'NONE').
 * - PROPOSER_PENDING: yeu cau dang cho do chinh actor gui (ke ca khi da mat assignment hien tai).
 * - PROPOSER_RESOLVED: lich su yeu cau da xu ly do chinh actor gui.
 * - REVIEWER_RESOLVED: lich su yeu cau do chinh actor da quyet dinh (decided_by_user_id).
 */
export async function probeHistoricalChangeRequestAccess(input: {
  auth_subject: string;
  app_user_id: string;
  listChangeRequests: (query: {
    auth_subject: string;
    app_user_id: string;
    page_size: number;
    cursor: null;
    state: HistoricalChangeRequestQueue;
    days: null;
  }) => Promise<
    | { ok: true; data: { requests: readonly unknown[] } }
    | { ok: false; reason?: string }
    | null
  >;
}): Promise<ChangeRequestHistoricalAccessProbe> {
  const probeQueue = async (state: HistoricalChangeRequestQueue): Promise<boolean> => {
    try {
      const result = await input.listChangeRequests({
        auth_subject: input.auth_subject,
        app_user_id: input.app_user_id,
        page_size: 1,
        cursor: null,
        state,
        days: null,
      });
      return result !== null && result.ok === true && result.data.requests.length > 0;
    } catch {
      return false;
    }
  };
  const [hasProposerPending, hasProposerResolved, hasReviewerResolved] =
    await Promise.all([
      probeQueue("PROPOSER_PENDING"),
      probeQueue("PROPOSER_RESOLVED"),
      probeQueue("REVIEWER_RESOLVED"),
    ]);
  return {
    hasProposerPending,
    hasProposerResolved,
    hasReviewerResolved,
    hasHistoricalRequests:
      hasProposerPending || hasProposerResolved || hasReviewerResolved,
  };
}

/**
 * R2.2: quyet dinh truy cap cho /direct-entry/change-requests.
 * - Cung boundary voi nav (changeRequestsNavPredicate).
 * - Ngoai ra, actor con active (actor.ok === true) nhung da doi phan cong/thu hoi quyen
 *   hien tai van duoc vao xem lich su yeu cau do chinh minh da gui hoac da duyet
 *   khi hasHistoricalRequests === true (hoac historicalProbe.hasHistoricalRequests === true).
 */
export function decideChangeRequestsPageAccess(input: {
  uiEnabled: boolean;
  actor: ActorResolution | null;
  hasHistoricalRequests?: boolean;
  historicalProbe?: ChangeRequestHistoricalAccessProbe;
}): DirectEntryPageDecision {
  const hasHistory =
    input.hasHistoricalRequests === true ||
    input.historicalProbe?.hasHistoricalRequests === true;
  return decideUiCapabilityPageAccess({
    uiEnabled: input.uiEnabled,
    actor: input.actor,
    allowed: (actor) =>
      changeRequestsNavPredicate(actor) || hasHistory,
  });
}

/**
 * PRE-W2-HF-C: quyet dinh actor co duoc THAY tab "Bao cao CCCD trung" tren Dashboard khong.
 *
 * MOI authenticated account nghiep vu hop le (actor resolve `ok` = da dang nhap, app_user
 * enabled, actor mapping duy nhat) deu duoc xem. Anonymous / disabled / revoked / mapping loi
 * => false (fail-closed). Day chi la metadata hien thi (server-derived); quyen that van do
 * API/RPC (#87) quyet dinh lai.
 */
export function canViewDuplicateCccdReport(actor: ActorResolution | null): boolean {
  return actor !== null && actor.ok;
}

/**
 * PRE-WAVE-2: Quyết định actor có được thấy tab "Review thông tin NLĐ" trên Dashboard không.
 * Mọi tài khoản nghiệp vụ đã xác thực hợp lệ đều thấy tab để xử lý hồ sơ trong scope của mình
 * (bao gồm cả hồ sơ do chính mình tạo); quyền dòng thực tế do API và RPC PostgreSQL kiểm tra độc lập.
 */
export function canViewCccdReviewReport(actor: ActorResolution | null): boolean {
  return actor !== null && actor.ok;
}

/**
 * WF-04 Post-Merge Hotfix: Quyết định actor có được thấy tab "Báo cáo chuyên sâu"
 * và khu vực "Hiện trạng & biến động trạng thái lao động" trên Dashboard hay không.
 *
 * Chỉ actor đã xác thực hợp lệ có `scope = "all"` (Admin / BoD) mới được xem.
 * Team Leader (`scope = "team"`) và Recruiter (`scope = "own"`) bị ẩn tab và không gọi API/RPC.
 * Quyền thực tế vẫn được kiểm tra lại tại API `/api/reporting/workforce-deep` và RPC PostgreSQL.
 */
export function canManageTeamLeadersFromActor(actor: ActorResolution | null): boolean {
  if (actor?.ok !== true) return false;
  return hasPairedCapability(actor.actor, "team_master_manage", { kind: "all" });
}

export function canViewDeepWorkforceReport(actor: ActorResolution | null): boolean {
  if (actor === null || !actor.ok) return false;
  return hasPairedAllReportingAccess(actor.actor);
}
