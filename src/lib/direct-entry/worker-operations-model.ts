/**
 * P2.5-W06 - Worker Operations UI model (thuan, khong React, khong I/O).
 *
 * Ba quan he KHONG tron quyen:
 *   uploader  = lich su nguoi nhap (submission API; created_by chi de liet ke/audit)
 *   recruited = worker directory scope=recruited (recruiter co canonical recruiter_id)
 *   managed   = worker directory scope=managed (PM co assignment hieu luc)
 *   team      = worker directory scope=team (Team Leader current-team audience)
 *
 * Quyen KHONG bao gio suy dien o client: moi CTA doc tu allowed_actions do server tra.
 */

import {
  WORKER_PROVIDER_TYPES,
  projectWorkerDirectoryPage,
  type WorkerDirectoryPage,
  type WorkerDirectoryRow,
  type WorkerDirectoryScope,
  type WorkerProviderType,
} from "./worker-directory-contract.ts";
import {
  projectSubmissionListPage,
  type SubmissionReadItem,
  type SubmissionReadListPage,
} from "./submission-read-contract.ts";
import {
  projectChangeRequestListPage,
  type ChangeRequestListItem,
  type ChangeRequestListPage,
  type ChangeRequestQueueFilter,
} from "./change-request-read-contract.ts";
import { WORK_STATUS_UI_LABELS, workStatusUiLabel } from "./display-labels.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
  validateWorkerDetails,
  type OptionalValue,
  type WorkerDetails,
} from "../contracts/direct-entry-v1.ts";
import { isPaymentText, type PaymentState } from "./payment-contract.ts";
import { workerDetailsChanged } from "./change-request-read-projection.ts";
import {
  workerEntryFormFromBaseline,
  type ProposalBuildResult,
  type WorkerEntryFieldBaseline,
  type WorkerEntryFieldForm,
  type WorkerForm,
} from "./change-request-proposal-builders.ts";
import {
  VIETQR_BANK_CATALOG,
  formatBankReferenceDisplay,
  mergeVietQrBankCatalog,
  resolveBankCatalogOption,
  type BankCatalogEntryInput,
  type MergedBankCatalogOption,
} from "./vietqr-bank-catalog.ts";

export {
  VIETQR_BANK_CATALOG,
  WORKER_PROVIDER_TYPES,
  formatBankReferenceDisplay,
  mergeVietQrBankCatalog,
  resolveBankCatalogOption,
  type BankCatalogEntryInput,
  type MergedBankCatalogOption,
  type WorkerProviderType,
};

export const WORKER_OPERATIONS_TABS = ["uploader", "recruited", "managed", "team", "all"] as const;
export type WorkerOperationsTab = (typeof WORKER_OPERATIONS_TABS)[number];

/**
 * Default initial-tab selection order derived from `HEAD:src/lib/direct-entry/worker-operations-model.ts`
 * (`initialWorkerTab` / `fallbackWorkerTab`: `managed -> all -> team -> uploader`), extended by placing
 * `recruited` immediately before `uploader` now that `recruited` is an explicit server-verified tab in
 * `allowed_worker_tabs` (distinct from the UI tab bar display order `WORKER_OPERATIONS_TABS`).
 */
export const WORKER_OPERATIONS_INITIAL_TAB_PRIORITY: readonly WorkerOperationsTab[] =
  Object.freeze(["managed", "all", "team", "recruited", "uploader"]);

export const WORKER_NO_USABLE_TAB_MESSAGE =
  "Tài khoản của bạn hiện không có phạm vi danh sách người lao động khả dụng.";

export const WORKER_OPERATIONS_TAB_LABELS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Tôi đã nhập",
    recruited: "Người tôi tuyển",
    managed: "Dự án tôi quản lý",
    team: "Team tôi quản lý",
    all: "Toàn bộ NLĐ",
  });

export const WORKER_OPERATIONS_TAB_HINTS: Readonly<Record<WorkerOperationsTab, string>> =
  Object.freeze({
    uploader: "Hồ sơ bạn đã nhập. Chỉ để tra cứu — không tạo quyền đề xuất thay đổi.",
    recruited: "Người lao động có người tuyển là bạn (theo mã người tuyển trên hồ sơ).",
    managed: "Người lao động thuộc dự án bạn đang quản lý (theo phân công còn hiệu lực).",
    team: "Người lao động thuộc team bạn đang quản lý theo phân công hiện tại.",
    all: "Toàn bộ người lao động đã gửi.",
  });

/** Chi recruited/managed dung worker directory; uploader dung submission API. */
export function tabScope(tab: WorkerOperationsTab): WorkerDirectoryScope | null {
  if (tab === "recruited") return "recruited";
  if (tab === "managed") return "managed";
  if (tab === "team") return "team";
  if (tab === "all") return "all";
  return null;
}

export type WorkerTabPermissionsInput = {
  allowedTabs?: readonly WorkerOperationsTab[];
  allowed_worker_tabs?: readonly WorkerOperationsTab[];
  canSeeUploaderWorkers?: boolean;
  canSeeRecruitedWorkers?: boolean;
  canSeeManagedWorkers?: boolean;
  canSeeTeamWorkers?: boolean;
  canSeeAllWorkers?: boolean;
};

/**
 * Resolves the canonical ordered list of Worker Operations tabs that the server has confirmed
 * are usable for the current actor (`allowed_worker_tabs`). Never assumes `managed`, `recruited`,
 * or `uploader` by default.
 */
export function visibleWorkerTabs(
  input:
    | readonly WorkerOperationsTab[]
    | WorkerTabPermissionsInput
    | boolean
    | null
    | undefined = [],
  canSeeTeamWorkers = false,
  canSeeManagedWorkers = false,
  canSeeRecruitedWorkers = false,
  canSeeUploaderWorkers = false,
): readonly WorkerOperationsTab[] {
  if (input === null || input === undefined) return [];
  if (Array.isArray(input)) {
    const allowedSet = new Set(input.filter(isWorkerOperationsTab));
    return WORKER_OPERATIONS_TABS.filter((tab) => allowedSet.has(tab));
  }
  if (typeof input === "boolean") {
    const canSeeAllWorkers = input;
    return WORKER_OPERATIONS_TABS.filter((tab) => {
      if (tab === "uploader") return canSeeUploaderWorkers === true;
      if (tab === "recruited") return canSeeRecruitedWorkers === true;
      if (tab === "managed") return canSeeManagedWorkers === true;
      if (tab === "team") return canSeeTeamWorkers === true;
      if (tab === "all") return canSeeAllWorkers === true;
      return false;
    });
  }
  const obj = input as WorkerTabPermissionsInput;
  if (Array.isArray(obj.allowedTabs)) {
    const allowedSet = new Set(obj.allowedTabs.filter(isWorkerOperationsTab));
    return WORKER_OPERATIONS_TABS.filter((tab) => allowedSet.has(tab));
  }
  if (Array.isArray(obj.allowed_worker_tabs)) {
    const allowedSet = new Set(obj.allowed_worker_tabs.filter(isWorkerOperationsTab));
    return WORKER_OPERATIONS_TABS.filter((tab) => allowedSet.has(tab));
  }
  return WORKER_OPERATIONS_TABS.filter((tab) => {
    if (tab === "uploader") return obj.canSeeUploaderWorkers === true;
    if (tab === "recruited") return obj.canSeeRecruitedWorkers === true;
    if (tab === "managed") return obj.canSeeManagedWorkers === true;
    if (tab === "team") return obj.canSeeTeamWorkers === true;
    if (tab === "all") return obj.canSeeAllWorkers === true;
    return false;
  });
}

export type UploaderScopeGrantCandidate = {
  scope_kind: string;
  team_id: string | null;
  valid_from?: string;
  valid_to?: string | null;
  is_current?: boolean;
};

export type UploaderCapabilityGrantCandidate =
  | string
  | {
      capability: string;
      valid_from?: string;
      valid_to?: string | null;
      is_current?: boolean;
    };

export type UploaderTabAuthorityInput = {
  enabled?: boolean;
  authorizationDate?: string;
  capabilities: readonly UploaderCapabilityGrantCandidate[];
  scopeGrants: readonly UploaderScopeGrantCandidate[];
  hasProjectAssignment?: boolean;
};

/**
 * Contract predicate mirroring `public.direct_entry_list_own_submissions`
 * (`20261020200000_r1_current_state_authorization.sql`):
 * - Actor must be enabled (`enabled !== false`).
 * - `v_can_list_own`: requires current capability `submission_create`
 *   AND **exactly 1** (`count === 1`) current `own` scope grant with `team_id === null`
 *   (`is_current` is authoritative; `valid_from` / `valid_to` are historical metadata and not evaluated).
 * - OR `v_has_project_assignment` (`hasProjectAssignment === true`).
 */
export function canAccessUploaderSubmissionsTab(
  input: UploaderTabAuthorityInput | null | undefined,
): boolean {
  if (!input || input.enabled === false) {
    return false;
  }
  const { capabilities, scopeGrants, hasProjectAssignment } = input;
  const hasSubmissionCreate = capabilities.some((entry) => {
    if (typeof entry === "string") {
      return entry === "submission_create";
    }
    return Boolean(
      entry &&
        entry.capability === "submission_create" &&
        entry.is_current !== false,
    );
  });

  const matchingOwnScopeCount = scopeGrants.filter(
    (grant) =>
      grant !== null &&
      typeof grant === "object" &&
      grant.scope_kind === "own" &&
      grant.team_id === null &&
      grant.is_current !== false,
  ).length;

  const canListOwn = matchingOwnScopeCount === 1 && hasSubmissionCreate;
  return canListOwn || hasProjectAssignment === true;
}

function hasPairedAllGrant(
  effectiveGrants: readonly { capability: string; scope_kind: string; scope_id?: string | null }[] | undefined,
  capabilities: readonly string[],
): boolean {
  if (!Array.isArray(effectiveGrants)) return false;
  return effectiveGrants.some(
    (grant) =>
      grant !== null &&
      typeof grant === "object" &&
      capabilities.includes(grant.capability) &&
      grant.scope_kind === "ALL" &&
      (grant.scope_id === null || grant.scope_id === undefined),
  );
}

/** Reviewer queue chi hien khi change_review + effective all scope (khop W05 #55; WP8C-1 paired @ ALL khi co effective_grants). */
export function canReviewChangeRequests(input: {
  capabilities: readonly string[];
  scopes: readonly { kind: string }[];
  effective_grants?: readonly { capability: string; scope_kind: string; scope_id?: string | null }[];
} | null): boolean {
  if (input === null) return false;
  if (input.effective_grants !== undefined) {
    return hasPairedAllGrant(input.effective_grants, ["change_review"]);
  }
  return input.scopes.some((scope) => scope.kind === "all") &&
    input.capabilities.includes("change_review");
}

export function canViewGlobalChangeRequestHistory(
  capabilities: readonly string[] | null,
  scopes: readonly { kind: string }[] = [],
  effectiveGrants?: readonly { capability: string; scope_kind: string; scope_id?: string | null }[],
): boolean {
  if (effectiveGrants !== undefined) {
    return hasPairedAllGrant(effectiveGrants, ["change_review", "entry_admin"]);
  }
  if (capabilities === null || !scopes.some((scope) => scope.kind === "all")) return false;
  return capabilities.includes("change_review") || capabilities.includes("entry_admin");
}

/** Propose targets duoc policy cho phep (khong co DOCUMENT/CCCD). */
export const WORKER_PROPOSE_TARGETS = ["WORKER", "PAYMENT", "WORK_STATUS"] as const;
export type WorkerProposeTarget = (typeof WORKER_PROPOSE_TARGETS)[number];

export const WORKER_PROPOSE_TARGET_LABELS: Readonly<Record<WorkerProposeTarget, string>> =
  Object.freeze({
    WORKER: "Thông tin người lao động",
    PAYMENT: "Thông tin tài khoản ngân hàng",
    WORK_STATUS: "Trạng thái làm việc",
  });

/** Chi Admin/reviewer co all scope duoc thay review queue. */
export function reviewQueueVisible(canReview: boolean): boolean {
  return canReview === true;
}

export function isWorkerOperationsTab(value: unknown): value is WorkerOperationsTab {
  return typeof value === "string" && (WORKER_OPERATIONS_TABS as readonly string[]).includes(value);
}

/* ---------- CTA: server allowed_actions la authority duy nhat ---------- */

export const WORKER_DENIAL_NOT_PROJECT_MANAGER = "NOT_PROJECT_MANAGER";

export type ProposeCta = {
  /** true chi khi server tra allowed_actions.propose_change === true. */
  show: boolean;
  /** Ma tu choi on dinh do server tra (khong bao gio chua UUID/raw DB message). */
  code: string | null;
  /** Copy sanitized khi khong co quyen (CTA phai VANG MAT, khong chi disable). */
  message: string | null;
};

export function workerDenialMessage(code: string | null): string {
  if (code === WORKER_DENIAL_NOT_PROJECT_MANAGER) {
    return "Bạn chỉ có thể xem: chỉ quản lý dự án đang hiệu lực mới được đề xuất thay đổi.";
  }
  if (code === "NOT_SUBMITTED") {
    return "Hồ sơ chưa ở trạng thái đã gửi nên chưa thể đề xuất thay đổi.";
  }
  return "Bạn không có quyền đề xuất thay đổi cho người lao động này.";
}

export function proposeCta(row: Pick<WorkerDirectoryRow, "allowed_actions">): ProposeCta {
  const actions = row.allowed_actions;
  if (actions.propose_change === true) {
    return { show: true, code: null, message: null };
  }
  const code = actions.propose_change_code;
  return { show: false, code, message: workerDenialMessage(code) };
}

export function canSelectQuickOffboardingWorker(
  row: Pick<WorkerDirectoryRow, "employment_status" | "allowed_actions">,
): boolean {
  return (row.employment_status === "ON" || row.employment_status === "UNCONFIRMED") &&
    row.allowed_actions.direct_edit === true;
}

/* ---------- PRE-W2-P2: sua ho ten NLĐ qua luong duyet (target WORKER) ---------- */

/** Du quyen nhung chua nap duoc baseline canonical day du (khong bia gia tri). */
export const WORKER_NAME_NO_BASELINE_MESSAGE =
  "Chưa đọc được thông tin người lao động để đề xuất sửa họ tên.";

export type WorkerNameAvailability = {
  available: boolean;
  /** Copy giai thich khi KHONG the sua ten; null khi available. */
  message: string | null;
};

/**
 * Quyet dinh affordance sua ho ten (target WORKER) o ca hai entry point.
 *
 * The row has already passed server-side worker view and scope; edits still require the existing action.
 */
export function workerNameAvailability(input: {
  proposeChange: boolean;
  hasBaseline: boolean;
}): WorkerNameAvailability {
  if (!input.proposeChange) {
    return { available: false, message: workerDenialMessage(null) };
  }
  if (!input.hasBaseline) return { available: false, message: WORKER_NAME_NO_BASELINE_MESSAGE };
  return { available: true, message: null };
}

/* ---------- nhan nghiep vu (khong goi "PAYMENT"/thanh toan) ---------- */

export const BANK_ACCOUNT_SECTION_LABEL = "Thông tin tài khoản ngân hàng";
export const BANK_ACCOUNT_SECTION_HINT =
  "Chỉ gồm số tài khoản, ngân hàng và tên chủ tài khoản để lưu và tra cứu.";

/** PRE-W2-HF-UI-LABELS: nhan trang thai lam viec lay tu mot nguon duy nhat (display-labels). */
export const WORKER_STATUS_LABELS: Readonly<Record<string, string>> = WORK_STATUS_UI_LABELS;

export function workerStatusLabel(status: string | null): string {
  return workStatusUiLabel(status);
}

export const WORKER_PROVIDER_TYPE_LABELS: Readonly<Record<WorkerProviderType, string>> =
  Object.freeze({
    hrp: "HRP",
    hrp_direct: "HRP trực tiếp",
    hrp_ctv: "Qua CTV",
    vendor: "Vendor",
  });

export function workerProviderTypeLabel(providerType: string | null | undefined): string {
  if (providerType === "hrp") return WORKER_PROVIDER_TYPE_LABELS.hrp;
  if (providerType === "hrp_direct") return WORKER_PROVIDER_TYPE_LABELS.hrp_direct;
  if (providerType === "hrp_ctv") return WORKER_PROVIDER_TYPE_LABELS.hrp_ctv;
  if (providerType === "vendor") return WORKER_PROVIDER_TYPE_LABELS.vendor;
  return "Tất cả";
}

export type BankAccountSummary = {
  state: string;
  accountNumber: string | null;
  bankId: string | null;
  accountHolder: string | null;
};

/** Tra cuu STK/ngan hang/chu tai khoan; khong mo ta nhu chuc nang thanh toan. */
export function bankAccountSummary(payment: WorkerDirectoryRow["payment"]): BankAccountSummary | null {
  if (payment === null) return null;
  return {
    state: payment.state,
    accountNumber: payment.account_number,
    bankId: payment.bank_id,
    accountHolder: payment.account_holder_name,
  };
}

/* ---------- pending / last decision ---------- */

export function pendingRequestLabel(
  row: Pick<WorkerDirectoryRow, "pending_request">,
): string | null {
  return row.pending_request === null
    ? null
    : "Đang chờ duyệt yêu cầu thay đổi";
}

export function lastDecisionLabel(
  row: Pick<WorkerDirectoryRow, "last_decision">,
): string | null {
  const decision = row.last_decision;
  if (decision === null) return null;
  const day = decision.decided_at.slice(0, 10);
  return (decision.state === "APPROVED" ? "Đã duyệt" : "Đã từ chối") + " ngày " + day;
}

/* ---------- parse response (fail-closed) ---------- */

export function parseWorkerPageResponse(
  payload: unknown,
  expected: { scope: string; page_size: number },
): WorkerDirectoryPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["items", "scope", "page_size", "has_more", "next_cursor", "authorization_date", "summary"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectWorkerDirectoryPage(slice, expected);
}

export function parseSubmissionPageResponse(
  payload: unknown,
  expected: { page_size: number },
): SubmissionReadListPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["items", "page_size", "has_more", "next_cursor"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectSubmissionListPage(slice, expected);
}

/* ---------- conflict / reload ---------- */

export const WORKER_CONFLICT_MESSAGE =
  "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi tiếp tục.";

/* ---------- W06-R2: initial tab tu actor projection (server) ---------- */

export type WorkerOperationsActor = {
  capabilities: readonly string[];
  scopes: readonly { kind: string; reference?: string; valid_from?: string; valid_to?: string | null }[];
  allowed_worker_tabs?: readonly WorkerOperationsTab[];
  effective_grants?: readonly { capability: string; scope_kind: string; scope_id?: string | null }[];
};

/**
 * Selects the default Worker Operations tab strictly from the server-authorized `allowedTabs`
 * using `WORKER_OPERATIONS_INITIAL_TAB_PRIORITY` (`managed` -> `all` -> `team` -> `recruited` -> `uploader`,
 * derived from `HEAD:src/lib/direct-entry/worker-operations-model.ts` `initialWorkerTab`/`fallbackWorkerTab`).
 * Returns `null` when no tab is authorized (`allowedTabs.length === 0`).
 */
export function resolveInitialWorkerTab(
  allowedTabs: readonly WorkerOperationsTab[],
): WorkerOperationsTab | null {
  const validSet = new Set(visibleWorkerTabs(allowedTabs));
  for (const candidate of WORKER_OPERATIONS_INITIAL_TAB_PRIORITY) {
    if (validSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Fallback tab when `managed` is not authorized for the actor.
 * Never defaults `uploader` or `managed` to true and never hops to an unauthorized `all` scope.
 */
export function fallbackWorkerTab(
  actor: WorkerOperationsActor | null,
  canSeeAllWorkers?: boolean,
  canSeeTeamWorkers?: boolean,
  canSeeRecruitedWorkers?: boolean,
  canSeeUploaderWorkers?: boolean,
  allowedTabs?: readonly WorkerOperationsTab[],
): WorkerOperationsTab | null {
  if (Array.isArray(allowedTabs)) {
    return resolveInitialWorkerTab(allowedTabs.filter((tab) => tab !== "managed"));
  }
  if (actor === null) return null;
  if (
    Array.isArray(actor.allowed_worker_tabs) &&
    canSeeAllWorkers === undefined &&
    canSeeTeamWorkers === undefined &&
    canSeeRecruitedWorkers === undefined &&
    canSeeUploaderWorkers === undefined
  ) {
    return resolveInitialWorkerTab(actor.allowed_worker_tabs.filter((tab) => tab !== "managed"));
  }
  const tabs = visibleWorkerTabs({
    ...(canSeeAllWorkers !== undefined ? { canSeeAllWorkers } : {}),
    ...(canSeeTeamWorkers !== undefined ? { canSeeTeamWorkers } : {}),
    ...(canSeeRecruitedWorkers !== undefined ? { canSeeRecruitedWorkers } : {}),
    ...(canSeeUploaderWorkers !== undefined ? { canSeeUploaderWorkers } : {}),
    canSeeManagedWorkers: false,
  });
  return resolveInitialWorkerTab(tabs);
}

/**
 * Resolves the initial tab when opening `/direct-entry/workers`.
 * Strictly selects from server-authorized tabs (`allowedTabs` or `actor.allowed_worker_tabs`) by priority:
 * `managed` -> `all` -> `team` -> `recruited` -> `uploader` (extending `HEAD`'s `initialWorkerTab` /
 * `fallbackWorkerTab` order). Never defaults `managed` or `uploader` to available, and returns `null`
 * when 0 tabs are usable.
 */
export function initialWorkerTab(
  actorOrAllowedTabs: WorkerOperationsActor | readonly WorkerOperationsTab[] | null,
  canSeeAllWorkers?: boolean,
  canSeeTeamWorkers?: boolean,
  canSeeManagedWorkers?: boolean,
  canSeeRecruitedWorkers?: boolean,
  canSeeUploaderWorkers?: boolean,
  allowedTabs?: readonly WorkerOperationsTab[],
): WorkerOperationsTab | null {
  if (Array.isArray(actorOrAllowedTabs)) {
    return resolveInitialWorkerTab(actorOrAllowedTabs);
  }
  if (Array.isArray(allowedTabs)) {
    return resolveInitialWorkerTab(allowedTabs);
  }
  if (actorOrAllowedTabs === null || actorOrAllowedTabs === undefined) {
    return null;
  }
  const actor = actorOrAllowedTabs as WorkerOperationsActor;
  if (
    Array.isArray(actor.allowed_worker_tabs) &&
    canSeeAllWorkers === undefined &&
    canSeeTeamWorkers === undefined &&
    canSeeManagedWorkers === undefined &&
    canSeeRecruitedWorkers === undefined &&
    canSeeUploaderWorkers === undefined
  ) {
    return resolveInitialWorkerTab(actor.allowed_worker_tabs);
  }
  const tabs = visibleWorkerTabs({
    ...(canSeeAllWorkers !== undefined ? { canSeeAllWorkers } : {}),
    ...(canSeeTeamWorkers !== undefined ? { canSeeTeamWorkers } : {}),
    ...(canSeeManagedWorkers !== undefined ? { canSeeManagedWorkers } : {}),
    ...(canSeeRecruitedWorkers !== undefined ? { canSeeRecruitedWorkers } : {}),
    ...(canSeeUploaderWorkers !== undefined ? { canSeeUploaderWorkers } : {}),
  });
  return resolveInitialWorkerTab(tabs);
}

/* ---------- W06-R2: pagination (page state thuan) ---------- */

export const WORKER_PAGE_SIZE = 25;
export const WORKER_REQUEST_PAGE_SIZE = 20;

export type PageState =
  | "idle" | "loading" | "ready" | "empty" | "denied" | "unavailable" | "error";

export type TabPage<T> = {
  items: readonly T[];
  cursor: string | null;
  hasMore: boolean;
  state: PageState;
  /** Thong bao cuc bo cua tab; 403 chi anh huong tab nay, khong thao ca trang. */
  message: string | null;
};

export function emptyTabPage<T>(): TabPage<T> {
  return { items: [], cursor: null, hasMore: false, state: "idle", message: null };
}

/** Doi tab/doi filter: reset items + cursor — khong mang cursor cua scope cu. */
export function resetTabPage<T>(): TabPage<T> {
  return { items: [], cursor: null, hasMore: false, state: "loading", message: null };
}

export type WorkerDirectoryFilters = {
  search: string;
  status: string;
  projectId: string;
  recruiterId: string;
  firstWorkDateFrom?: string;
  firstWorkDateTo?: string;
  providerType?: string;
  laborType?: string;
};

export const EMPTY_WORKER_DIRECTORY_FILTERS: Readonly<WorkerDirectoryFilters> = Object.freeze({
  search: "",
  status: "",
  projectId: "",
  recruiterId: "",
  firstWorkDateFrom: "",
  firstWorkDateTo: "",
  providerType: "",
  laborType: "",
});

export const WORKER_DATE_RANGE_INVALID_MESSAGE =
  "Khoảng ngày vào làm không hợp lệ: Từ ngày không được lớn hơn Đến ngày.";

export function validateWorkerDirectoryDateRange(filters: {
  firstWorkDateFrom?: string;
  firstWorkDateTo?: string;
}): string | null {
  const from = (filters.firstWorkDateFrom ?? "").trim();
  const to = (filters.firstWorkDateTo ?? "").trim();
  if (from !== "" && !isRealCalendarDate(from)) {
    return "Từ ngày không đúng định dạng YYYY-MM-DD.";
  }
  if (to !== "" && !isRealCalendarDate(to)) {
    return "Đến ngày không đúng định dạng YYYY-MM-DD.";
  }
  if (from !== "" && to !== "" && from > to) {
    return WORKER_DATE_RANGE_INVALID_MESSAGE;
  }
  return null;
}

export function hasActiveWorkerDirectoryFilters(filters: WorkerDirectoryFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.status !== "" ||
    filters.projectId !== "" ||
    filters.recruiterId !== "" ||
    (filters.firstWorkDateFrom ?? "").trim() !== "" ||
    (filters.firstWorkDateTo ?? "").trim() !== "" ||
    (filters.providerType ?? "").trim() !== "" ||
    (filters.laborType ?? "").trim() !== ""
  );
}

export function updateWorkerDirectoryFilter<T>(input: {
  page: TabPage<T>;
  filters: WorkerDirectoryFilters;
  field: keyof WorkerDirectoryFilters;
  value: string;
}): { page: TabPage<T>; filters: WorkerDirectoryFilters } {
  return {
    page: resetTabPage<T>(),
    filters: { ...input.filters, [input.field]: input.value },
  };
}

/** Bat dau tai. append=true (tai them) GIU items da co. */
export function beginLoad<T>(page: TabPage<T>, append: boolean): TabPage<T> {
  return append
    ? { ...page, state: "loading", message: null }
    : { items: [], cursor: null, hasMore: false, state: "loading", message: null };
}

/** Append theo stable id, khong trung/khong sot. */
export function appendUnique<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(current.map(keyOf));
  const next = [...current];
  for (const item of incoming) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export function applyPage<T>(
  page: TabPage<T>,
  incoming: { items: readonly T[]; next_cursor: string | null; has_more: boolean },
  keyOf: (item: T) => string,
  append: boolean,
): TabPage<T> {
  const items = append ? appendUnique(page.items, incoming.items, keyOf) : [...incoming.items];
  return {
    items,
    cursor: incoming.next_cursor,
    hasMore: incoming.has_more,
    state: items.length === 0 ? "empty" : "ready",
    message: null,
  };
}

/**
 * Loi khi tai: neu state === "denied" (HTTP 403 / mat quyen), PHAI xoa items + cursor cua tab
 * vua mat quyen, khong giu du lieu cu. Loi tam thoi (5xx/network) khi Tai them van giu items da co.
 */
export function failLoad<T>(
  page: TabPage<T>, state: PageState, message: string | null,
): TabPage<T> {
  if (state === "denied") {
    return { items: [], cursor: null, hasMore: false, state: "denied", message };
  }
  if (page.items.length > 0) return { ...page, state: "ready", message };
  return { ...page, state, message };
}

export function workersQuery(input: {
  scope: WorkerDirectoryScope;
  search?: string;
  status: string;
  projectId?: string;
  recruiterId?: string;
  firstWorkDateFrom?: string;
  firstWorkDateTo?: string;
  providerType?: string;
  laborType?: string;
  cursor: string | null;
}): string {
  let query = "?scope=" + input.scope + "&page_size=" + String(WORKER_PAGE_SIZE);
  if (input.status !== "") query += "&employment_status=" + encodeURIComponent(input.status);
  if (input.search?.trim()) query += "&search=" + encodeURIComponent(input.search.trim());
  if (input.projectId) query += "&project_id=" + encodeURIComponent(input.projectId);
  if (input.recruiterId) query += "&recruiter_id=" + encodeURIComponent(input.recruiterId);
  if (input.firstWorkDateFrom?.trim()) {
    query += "&first_work_date_from=" + encodeURIComponent(input.firstWorkDateFrom.trim());
  }
  if (input.firstWorkDateTo?.trim()) {
    query += "&first_work_date_to=" + encodeURIComponent(input.firstWorkDateTo.trim());
  }
  if (input.providerType?.trim()) {
    query += "&provider_type=" + encodeURIComponent(input.providerType.trim());
  }
  if (input.laborType?.trim()) {
    query += "&labor_type=" + encodeURIComponent(input.laborType.trim());
  }
  if (input.cursor !== null) query += "&cursor=" + encodeURIComponent(input.cursor);
  return query;
}

export function submissionsQuery(cursor: string | null): string {
  let query = "?page_size=" + String(WORKER_PAGE_SIZE);
  if (cursor !== null) query += "&cursor=" + encodeURIComponent(cursor);
  return query;
}

export type ChangeRequestWorkspaceMode = "proposer" | "reviewer";

export const CHANGE_REQUEST_PROPOSER_TABS = [
  { value: "PROPOSER_PENDING", label: "Tôi đã gửi" },
  { value: "PROPOSER_RESOLVED", label: "Lịch sử gửi" },
] as const;

export const CHANGE_REQUEST_REVIEWER_TABS = [
  { value: "REVIEWER_PENDING", label: "Chờ tôi duyệt" },
  { value: "REVIEWER_RESOLVED", label: "Lịch sử duyệt" },
] as const;

export const CHANGE_REQUEST_GLOBAL_AUDIT_TAB = {
  value: "GLOBAL_AUDIT",
  label: "Lịch sử toàn hệ thống",
} as const;

export type ChangeRequestWorkspaceInitialAccess = {
  canReview: boolean;
  canPropose?: boolean;
  hasProposerPending?: boolean;
  hasProposerResolved?: boolean;
  hasReviewerResolved?: boolean;
};

export function initialChangeRequestWorkspaceMode(
  input: boolean | ChangeRequestWorkspaceInitialAccess,
): ChangeRequestWorkspaceMode {
  if (typeof input === "boolean") {
    return input ? "reviewer" : "proposer";
  }
  if (input.canReview) return "reviewer";
  if (
    input.hasReviewerResolved === true &&
    !input.canPropose &&
    !input.hasProposerPending &&
    !input.hasProposerResolved
  ) {
    return "reviewer";
  }
  return "proposer";
}

export function initialChangeRequestQueue(
  input: boolean | ChangeRequestWorkspaceInitialAccess,
): ChangeRequestQueueFilter {
  if (typeof input === "boolean") {
    return input ? "REVIEWER_PENDING" : "PROPOSER_PENDING";
  }
  const mode = initialChangeRequestWorkspaceMode(input);
  if (mode === "reviewer") {
    return input.canReview ? "REVIEWER_PENDING" : "REVIEWER_RESOLVED";
  }
  if (
    !input.canPropose &&
    input.hasProposerPending === false &&
    input.hasProposerResolved === true
  ) {
    return "PROPOSER_RESOLVED";
  }
  return "PROPOSER_PENDING";
}

export function changeRequestWorkspaceTabs(input: {
  mode: ChangeRequestWorkspaceMode;
  canViewGlobalHistory: boolean;
}): readonly { value: ChangeRequestQueueFilter; label: string }[] {
  if (input.mode === "proposer") {
    return CHANGE_REQUEST_PROPOSER_TABS;
  }
  return input.canViewGlobalHistory
    ? [...CHANGE_REQUEST_REVIEWER_TABS, CHANGE_REQUEST_GLOBAL_AUDIT_TAB]
    : CHANGE_REQUEST_REVIEWER_TABS;
}

export function requestsQuery(
  cursor: string | null,
  state: ChangeRequestQueueFilter = "PENDING",
  days: "3" | "7" | "30" | "all" = "3",
): string {
  let query = "?page_size=" + String(WORKER_REQUEST_PAGE_SIZE) + "&state=" + encodeURIComponent(state);
  if (state === "GLOBAL_AUDIT") query += "&days=" + encodeURIComponent(days);
  if (cursor !== null) query += "&cursor=" + encodeURIComponent(cursor);
  return query;
}

export function workerRowKey(row: WorkerDirectoryRow): string {
  return row.entry_id;
}
export function submissionRowKey(item: SubmissionReadItem): string {
  return item.submission_id;
}
export function requestRowKey(item: ChangeRequestListItem): string {
  return item.request_id;
}

export function parseChangeRequestPageResponse(
  payload: unknown,
  expected: { page_size: number; audit?: boolean },
): ChangeRequestListPage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  const slice: Record<string, unknown> = {};
  for (const key of ["requests", "page_size", "has_more", "next_cursor"]) {
    if (!(key in body)) return null;
    slice[key] = body[key];
  }
  return projectChangeRequestListPage(slice, expected);
}

/**
 * P2.5-HF-R5A: moi loi tai du lieu (5xx, mang, envelope sai) PHAI co copy sanitized.
 * Truoc day nhanh 5xx/network tra message null nen "Tai them" that bai khong hien gi.
 */
export const WORKER_LOAD_FAILED_MESSAGE = "Không tải được danh sách. Vui lòng thử lại.";

export function workerListErrorMessage(status: number): string {
  if (status === 401) return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền xem danh sách này.";
  if (status === 400) return "Bộ lọc không hợp lệ. Vui lòng kiểm tra lại.";
  return WORKER_LOAD_FAILED_MESSAGE;
}

/**
 * Ánh xạ mã lỗi sanitized từ POST /api/direct-entry/entries/[entryId]/privileged-edit
 * sang thông báo tiếng Việt rõ ràng mà không bao giờ lộ raw PostgreSQL message.
 */
export function privilegedEditErrorMessage(status: number, code?: string | null): string {
  if (code === "WORKER_ACTIVE_EPISODE_EXISTS") {
    return "Người lao động đang có một đợt làm việc hiệu lực khác (trùng CCCD đang làm).";
  }
  if (code === "WORKER_EPISODE_REOPEN_FORBIDDEN") {
    return "Hồ sơ đã nghỉ việc không thể mở lại; vui lòng tạo hồ sơ mới khi tái tuyển.";
  }
  if (code === "PRIVILEGED_EDIT_CONFLICT") {
    return "Dữ liệu bị trùng (ví dụ mã người lao động đã tồn tại). Vui lòng kiểm tra lại.";
  }
  if (code === "VERSION_CONFLICT") {
    return WORKER_CONFLICT_MESSAGE;
  }
  if (code === "PRIVILEGED_EDIT_STATE_LOCKED") {
    return "Trạng thái hồ sơ hiện tại không cho phép chỉnh sửa trực tiếp.";
  }
  if (code === "PRIVILEGED_EDIT_DENIED" || code === "ACTOR_NOT_AVAILABLE" || status === 403) {
    return "Bạn không còn quyền sửa trực tiếp hồ sơ này.";
  }
  if (code === "UNAUTHENTICATED" || status === 401) {
    return "Phiên làm việc đã hết hiệu lực. Vui lòng đăng nhập lại.";
  }
  if (code === "ENTRY_NOT_FOUND" || status === 404) {
    return "Không tìm thấy hồ sơ cần chỉnh sửa hoặc hồ sơ không còn thuộc phạm vi của bạn.";
  }
  if (
    code === "PRIVILEGED_EDIT_INVALID" ||
    code === "CLIENT_AUTHORITY_FIELD_FORBIDDEN" ||
    code === "BODY_INVALID" ||
    code === "ENTRY_ID_INVALID" ||
    status === 400
  ) {
    return "Dữ liệu chỉnh sửa không hợp lệ (kiểm tra định dạng mã NLĐ, ngày làm việc, CCCD, danh mục đang hoạt động hoặc trạng thái làm việc).";
  }
  return "Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.";
}

/**
 * T1A: HTTP 403 la bi tu choi quyen (state: "denied"), KHONG BAO GIO duoc bien thanh
 * ket qua rong ("0 nguoi lao dong"). Chi HTTP 200 voi danh sach rong moi la "khong co du lieu".
 */
export function relationDenialIsEmpty(
  _scope: WorkerDirectoryScope,
  _status: number,
): boolean {
  void _scope;
  void _status;
  return false;
}

export type WorkerScopeTab = "recruited" | "managed" | "team" | "all";

export type WorkerOperationsPagesState<W = WorkerDirectoryRow, S = SubmissionReadItem> = {
  allowedTabs: readonly WorkerOperationsTab[];
  activeTab: WorkerOperationsTab | null;
  workerPages: Readonly<Record<WorkerScopeTab, TabPage<W>>>;
  submissionPage: TabPage<S>;
  workerSummary: { total_workers: number; project_count: number; recruiter_count: number } | null;
};

export type SessionWorkerPermissions = {
  allowedTabs: readonly WorkerOperationsTab[];
  canReadCatalog: boolean;
};

/**
 * Parses `GET /api/direct-entry/session` response to refresh server-verified worker tab permissions
 * (`actor.allowed_worker_tabs`) and catalog read capability (`entry_create` | `entry_own`) mid-session.
 */
export function parseSessionWorkerPermissionsResponse(
  payload: unknown,
): SessionWorkerPermissions | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  if (body.ok !== true || typeof body.actor !== "object" || body.actor === null || Array.isArray(body.actor)) {
    return null;
  }
  const actor = body.actor as Record<string, unknown>;
  if (!Array.isArray(actor.capabilities) || !actor.capabilities.every((c) => typeof c === "string")) {
    return null;
  }
  if (
    actor.allowed_worker_tabs !== undefined &&
    (!Array.isArray(actor.allowed_worker_tabs) || !actor.allowed_worker_tabs.every(isWorkerOperationsTab))
  ) {
    return null;
  }
  const capabilities = actor.capabilities as readonly string[];
  const allowedTabs = Array.isArray(actor.allowed_worker_tabs)
    ? visibleWorkerTabs(actor.allowed_worker_tabs)
    : [];
  return {
    allowedTabs,
    canReadCatalog:
      capabilities.includes("entry_create") || capabilities.includes("entry_own"),
  };
}

/**
 * T1A: Làm mới danh sách tab an toàn khi quyền thay đổi trong lúc trang đang mở
 * (do server cập nhật `nextAllowedTabs` hoặc do một tab đang mở nhận HTTP 403 `revokedTab`).
 * - Xóa toàn bộ dữ liệu (`items`, `cursor`, `hasMore`, `workerSummary`) của mọi tab vừa mất quyền.
 * - Khi `revokedTab` bị từ chối bởi HTTP 403, đặt state `"denied"` rõ ràng cho tab đó, loại bỏ tab
 *   khỏi `allowedTabs`, KHÔNG tự retry và KHÔNG tự chuyển sang `all` hay scope không được phép.
 * - Khi server cập nhật `nextAllowedTabs`, giữ `activeTab` nếu còn hợp lệ (hoặc đang hiển thị thông báo
 *   `denied` khi `preserveDeniedActiveTab === true`) hoặc chọn từ `nextAllowedTabs` theo thứ tự ưu tiên.
 */
export function reconcileWorkerOperationsPermissions<W = WorkerDirectoryRow, S = SubmissionReadItem>(
  state: WorkerOperationsPagesState<W, S>,
  update: {
    nextAllowedTabs?: readonly WorkerOperationsTab[];
    revokedTab?: WorkerOperationsTab;
    denialMessage?: string;
    preserveDeniedActiveTab?: boolean;
  },
): WorkerOperationsPagesState<W, S> & { shouldFetchNextActiveTab: boolean } {
  const baseAllowed = update.nextAllowedTabs !== undefined
    ? visibleWorkerTabs(update.nextAllowedTabs)
    : state.allowedTabs;
  const nextAllowedTabs = update.revokedTab !== undefined
    ? baseAllowed.filter((tab) => tab !== update.revokedTab)
    : baseAllowed;
  const allowedSet = new Set<WorkerOperationsTab>(nextAllowedTabs);

  const keepDeniedScope = (scope: WorkerScopeTab): TabPage<W> =>
    update.preserveDeniedActiveTab &&
    state.activeTab === scope &&
    state.workerPages[scope].state === "denied"
      ? state.workerPages[scope]
      : emptyTabPage<W>();

  const nextWorkerPages: Record<WorkerScopeTab, TabPage<W>> = {
    recruited: allowedSet.has("recruited") ? state.workerPages.recruited : keepDeniedScope("recruited"),
    managed: allowedSet.has("managed") ? state.workerPages.managed : keepDeniedScope("managed"),
    team: allowedSet.has("team") ? state.workerPages.team : keepDeniedScope("team"),
    all: allowedSet.has("all") ? state.workerPages.all : keepDeniedScope("all"),
  };
  let nextSubmissionPage: TabPage<S> = allowedSet.has("uploader")
    ? state.submissionPage
    : update.preserveDeniedActiveTab &&
        state.activeTab === "uploader" &&
        state.submissionPage.state === "denied"
      ? state.submissionPage
      : emptyTabPage<S>();
  let nextSummary = state.workerSummary;

  if (update.revokedTab !== undefined) {
    const message = update.denialMessage ?? workerListErrorMessage(403);
    if (update.revokedTab === "uploader") {
      nextSubmissionPage = failLoad(state.submissionPage, "denied", message);
    } else {
      const scope = update.revokedTab as WorkerScopeTab;
      nextWorkerPages[scope] = failLoad(state.workerPages[scope], "denied", message);
    }
    if (state.activeTab === update.revokedTab) {
      nextSummary = null;
    }
    return {
      allowedTabs: nextAllowedTabs,
      activeTab: state.activeTab,
      workerPages: nextWorkerPages,
      submissionPage: nextSubmissionPage,
      workerSummary: nextSummary,
      shouldFetchNextActiveTab: false,
    };
  }

  let nextActiveTab: WorkerOperationsTab | null = state.activeTab;
  let shouldFetchNextActiveTab = false;
  if (nextActiveTab === null || !allowedSet.has(nextActiveTab)) {
    nextSummary = null;
    const activeIsDenied =
      nextActiveTab !== null &&
      (nextActiveTab === "uploader"
        ? nextSubmissionPage.state === "denied"
        : nextWorkerPages[nextActiveTab as WorkerScopeTab].state === "denied");
    if (!(update.preserveDeniedActiveTab && activeIsDenied)) {
      nextActiveTab = resolveInitialWorkerTab(nextAllowedTabs);
      shouldFetchNextActiveTab = nextActiveTab !== null;
    }
  }

  return {
    allowedTabs: nextAllowedTabs,
    activeTab: nextActiveTab,
    workerPages: nextWorkerPages,
    submissionPage: nextSubmissionPage,
    workerSummary: nextSummary,
    shouldFetchNextActiveTab,
  };
}

/** Chi hien CTA khi row do server tra propose_change; khong bao gio tu suy quyen. */
export function rowsWithProposeCta(
  rows: readonly WorkerDirectoryRow[],
): readonly WorkerDirectoryRow[] {
  return rows.filter((row) => proposeCta(row).show);
}

/* ---------- HF-Worker-Profile: Direct Edit (Sửa trực tiếp) tài liệu hồ sơ ---------- */

export const DIRECT_EDIT_DOCUMENT_TYPES = [
  "WORKER_PORTRAIT",
  "CCCD_FRONT",
  "CCCD_BACK",
  "EMPLOYMENT_CONTRACT",
] as const;

export type DirectEditDocumentType = (typeof DIRECT_EDIT_DOCUMENT_TYPES)[number];

export const DIRECT_EDIT_DOCUMENT_LABELS: Readonly<Record<DirectEditDocumentType, string>> =
  Object.freeze({
    WORKER_PORTRAIT: "Ảnh NLĐ",
    CCCD_FRONT: "CCCD mặt trước",
    CCCD_BACK: "CCCD mặt sau",
    EMPLOYMENT_CONTRACT: "Hợp đồng lao động",
  });

export const DIRECT_EDIT_DOCUMENT_ACCEPT: Readonly<Record<DirectEditDocumentType, string>> =
  Object.freeze({
    WORKER_PORTRAIT: "image/jpeg,image/png",
    CCCD_FRONT: "image/jpeg,image/png,application/pdf",
    CCCD_BACK: "image/jpeg,image/png,application/pdf",
    EMPLOYMENT_CONTRACT: "image/jpeg,image/png,application/pdf",
  });

export const DIRECT_EDIT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export type DirectEditFileLike = {
  size: number;
  type: string;
};

export type DirectEditDocumentFileCheck =
  | {
      ok: true;
      mimeType: "image/jpeg" | "image/png" | "application/pdf";
      sizeBytes: number;
    }
  | {
      ok: false;
      code: "DOCUMENT_FILE_REQUIRED" | "DOCUMENT_SIZE_INVALID" | "DOCUMENT_MIME_INVALID";
    };

export function checkDirectEditDocumentFile(
  docType: DirectEditDocumentType,
  file: DirectEditFileLike | null | undefined,
): DirectEditDocumentFileCheck {
  if (!file) {
    return { ok: false, code: "DOCUMENT_FILE_REQUIRED" };
  }
  if (
    typeof file.size !== "number" ||
    !Number.isFinite(file.size) ||
    file.size < 1 ||
    file.size > DIRECT_EDIT_DOCUMENT_MAX_BYTES
  ) {
    return { ok: false, code: "DOCUMENT_SIZE_INVALID" };
  }
  const mime = typeof file.type === "string" ? file.type.trim().toLowerCase() : "";
  if (docType === "WORKER_PORTRAIT") {
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return { ok: false, code: "DOCUMENT_MIME_INVALID" };
    }
    return { ok: true, mimeType: mime, sizeBytes: file.size };
  }
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "application/pdf") {
    return { ok: false, code: "DOCUMENT_MIME_INVALID" };
  }
  return { ok: true, mimeType: mime, sizeBytes: file.size };
}

export function directEditDocumentErrorMessage(
  docType: DirectEditDocumentType,
  code?: string | null,
): string {
  const label = DIRECT_EDIT_DOCUMENT_LABELS[docType];
  if (code === "DOCUMENT_FILE_REQUIRED") {
    return `${label}: Hãy chọn tệp trước khi tải lên.`;
  }
  if (code === "DOCUMENT_SIZE_INVALID") {
    return `${label}: Tệp phải lớn hơn 0 và không vượt quá 10 MiB.`;
  }
  if (code === "DOCUMENT_MIME_INVALID") {
    return docType === "WORKER_PORTRAIT"
      ? `${label}: Chỉ chấp nhận ảnh JPEG hoặc PNG.`
      : `${label}: Chỉ chấp nhận tệp JPEG, PNG hoặc PDF.`;
  }
  if (code === "DOCUMENT_CONTENT_INVALID") {
    return `${label}: Nội dung tệp không khớp định dạng đã chọn.`;
  }
  if (code === "DOCUMENT_VERSION_CONFLICT" || code === "VERSION_CONFLICT") {
    return `${label}: Dữ liệu hồ sơ đã thay đổi. Vui lòng bấm Thử lại cho tệp này.`;
  }
  if (code === "DOCUMENT_DENIED" || code === "ACTOR_NOT_AVAILABLE") {
    return `${label}: Bạn không có quyền tải tài liệu này.`;
  }
  if (code === "DOCUMENT_STORAGE_UNAVAILABLE" || code === "DOCUMENT_UPLOAD_MISSING") {
    return `${label}: Kho lưu trữ chưa sẵn sàng. Bạn có thể bấm Thử lại cho tệp này.`;
  }
  if (code === "DOCUMENT_FINALIZE_UNAVAILABLE") {
    return `${label}: Chưa hoàn tất ghi nhận tệp. Bạn có thể bấm Thử lại cho tệp này.`;
  }
  return `${label}: Không tải lên được. Bạn có thể bấm Thử lại cho tệp này.`;
}

export type DirectEditSingleDocumentUploadResult =
  | {
      ok: true;
      docType: DirectEditDocumentType;
      documentId: string;
      documentVersion: number;
      entryVersion: number;
      message: string;
    }
  | {
      ok: false;
      docType: DirectEditDocumentType;
      conflict: boolean;
      code: string;
      entryVersion: number;
      message: string;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSafeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function uploadDirectEditDocument(input: {
  entryId: string;
  expectedEntryVersion: number;
  docType: DirectEditDocumentType;
  file: DirectEditFileLike & BodyInit;
  reason: string | null;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<DirectEditSingleDocumentUploadResult> {
  const {
    entryId,
    expectedEntryVersion,
    docType,
    file,
    reason,
    idempotencyKey = crypto.randomUUID(),
    fetchImpl = fetch,
  } = input;

  const check = checkDirectEditDocumentFile(docType, file);
  if (!check.ok) {
    return {
      ok: false,
      docType,
      conflict: false,
      code: check.code,
      entryVersion: expectedEntryVersion,
      message: directEditDocumentErrorMessage(docType, check.code),
    };
  }

  const baseUrl = `/api/direct-entry/entries/${encodeURIComponent(entryId)}/documents`;
  let currentEntryVersion = expectedEntryVersion;

  try {
    const reserveRes = await fetchImpl(baseUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        document_type: docType,
        expected_entry_version: expectedEntryVersion,
        size_bytes: check.sizeBytes,
        mime_type: check.mimeType,
        reason: reason ?? `Cập nhật ${DIRECT_EDIT_DOCUMENT_LABELS[docType]}`,
      }),
    });
    const reservePayload = await readSafeJson(reserveRes);
    if (reserveRes.status === 409) {
      return {
        ok: false,
        docType,
        conflict: true,
        code: "DOCUMENT_VERSION_CONFLICT",
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, "DOCUMENT_VERSION_CONFLICT"),
      };
    }
    if (
      !reserveRes.ok ||
      !isJsonObject(reservePayload) ||
      reservePayload.ok !== true ||
      typeof reservePayload.document_id !== "string" ||
      typeof reservePayload.entry_version !== "number"
    ) {
      const code =
        isJsonObject(reservePayload) && typeof reservePayload.code === "string"
          ? reservePayload.code
          : reserveRes.status === 403
            ? "DOCUMENT_DENIED"
            : "DOCUMENT_RESPONSE_INVALID";
      return {
        ok: false,
        docType,
        conflict: false,
        code,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, code),
      };
    }

    const documentId = reservePayload.document_id;
    const documentVersion =
      typeof reservePayload.version === "number" ? reservePayload.version : 1;
    currentEntryVersion = reservePayload.entry_version;

    const uploadInfo = reservePayload.upload;
    if (
      isJsonObject(uploadInfo) &&
      uploadInfo.method === "PUT" &&
      typeof uploadInfo.url === "string" &&
      isJsonObject(uploadInfo.headers)
    ) {
      const putHeaders: Record<string, string> = {};
      for (const [headerName, headerValue] of Object.entries(uploadInfo.headers)) {
        if (typeof headerValue === "string") {
          putHeaders[headerName] = headerValue;
        }
      }
      const putRes = await fetchImpl(uploadInfo.url, {
        method: "PUT",
        headers: putHeaders,
        body: file,
      });
      if (!putRes.ok) {
        return {
          ok: false,
          docType,
          conflict: false,
          code: "DOCUMENT_STORAGE_UNAVAILABLE",
          entryVersion: currentEntryVersion,
          message: directEditDocumentErrorMessage(docType, "DOCUMENT_STORAGE_UNAVAILABLE"),
        };
      }
    }

    const finalizeUrl = `${baseUrl}/${encodeURIComponent(documentId)}/finalize`;
    const finalizeRes = await fetchImpl(finalizeUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `${idempotencyKey}:finalize`,
      },
      body: JSON.stringify({
        expected_entry_version: currentEntryVersion,
      }),
    });
    const finalizePayload = await readSafeJson(finalizeRes);
    if (finalizeRes.status === 422) {
      currentEntryVersion += 1;
    }
    if (finalizeRes.status === 409) {
      const conflictCode =
        isJsonObject(finalizePayload) && typeof finalizePayload.code === "string"
          ? finalizePayload.code
          : "DOCUMENT_VERSION_CONFLICT";
      return {
        ok: false,
        docType,
        conflict: conflictCode === "DOCUMENT_VERSION_CONFLICT" || conflictCode === "VERSION_CONFLICT",
        code: conflictCode,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, conflictCode),
      };
    }
    if (
      !finalizeRes.ok ||
      !isJsonObject(finalizePayload) ||
      finalizePayload.ok !== true
    ) {
      const code =
        isJsonObject(finalizePayload) && typeof finalizePayload.code === "string"
          ? finalizePayload.code
          : finalizeRes.status === 403
            ? "DOCUMENT_DENIED"
            : "DOCUMENT_FINALIZE_UNAVAILABLE";
      return {
        ok: false,
        docType,
        conflict: false,
        code,
        entryVersion: currentEntryVersion,
        message: directEditDocumentErrorMessage(docType, code),
      };
    }

    if (typeof finalizePayload.entry_version === "number") {
      currentEntryVersion = finalizePayload.entry_version;
    }
    const finalDocVersion =
      typeof finalizePayload.version === "number" ? finalizePayload.version : documentVersion;

    return {
      ok: true,
      docType,
      documentId,
      documentVersion: finalDocVersion,
      entryVersion: currentEntryVersion,
      message: `${DIRECT_EDIT_DOCUMENT_LABELS[docType]}: Đã tải lên (v${finalDocVersion}).`,
    };
  } catch {
    return {
      ok: false,
      docType,
      conflict: false,
      code: "DOCUMENT_STORAGE_UNAVAILABLE",
      entryVersion: currentEntryVersion,
      message: directEditDocumentErrorMessage(docType, "DOCUMENT_STORAGE_UNAVAILABLE"),
    };
  }
}

export async function runDirectEditDocumentUploads(input: {
  entryId: string;
  initialEntryVersion: number;
  items: readonly {
    docType: DirectEditDocumentType;
    file: DirectEditFileLike & BodyInit;
    idempotencyKey?: string;
  }[];
  reason: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  entryVersion: number;
  results: readonly DirectEditSingleDocumentUploadResult[];
  allSucceeded: boolean;
}> {
  let currentVersion = input.initialEntryVersion;
  const results: DirectEditSingleDocumentUploadResult[] = [];
  for (const item of input.items) {
    const outcome = await uploadDirectEditDocument({
      entryId: input.entryId,
      expectedEntryVersion: currentVersion,
      docType: item.docType,
      file: item.file,
      reason: input.reason,
      idempotencyKey: item.idempotencyKey,
      fetchImpl: input.fetchImpl,
    });
    currentVersion = outcome.entryVersion;
    results.push(outcome);
  }
  return {
    entryVersion: currentVersion,
    results,
    allSucceeded: results.every((item) => item.ok),
  };
}

/* ---------- HF-Worker-Profile-Edit-Values: Direct Edit Values & Bank Reference ---------- */

const ISO_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Normalizes a stored raw date string (e.g. "DD/MM/YYYY", "DD-MM-YYYY", or "YYYY-MM-DD")
 * into "YYYY-MM-DD" for `<input type="date">` in Direct Edit.
 */
export function toDirectEditDateInputValue(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (ISO_DATE_PATTERN.test(trimmed) && isRealCalendarDate(trimmed)) {
    return trimmed;
  }
  const dmyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmyMatch) {
    const isoCandidate = `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
    if (isRealCalendarDate(isoCandidate)) {
      return isoCandidate;
    }
  }
  return trimmed;
}

/**
 * Builds the initial `WorkerEntryFieldForm` for Direct Edit (`mode === "correction"`),
 * normalizing provided date fields (`date_of_birth`, `national_id_issued_at`) for `<input type="date">`.
 */
export function directEditWorkerFormFromBaseline(
  baseline: WorkerEntryFieldBaseline,
): WorkerEntryFieldForm {
  const form = workerEntryFormFromBaseline(baseline);
  return {
    ...form,
    workerDetails: {
      ...form.workerDetails,
      date_of_birth: {
        ...form.workerDetails.date_of_birth,
        text:
          form.workerDetails.date_of_birth.state === "provided"
            ? toDirectEditDateInputValue(form.workerDetails.date_of_birth.text)
            : "",
      },
      national_id_issued_at: {
        ...form.workerDetails.national_id_issued_at,
        text:
          form.workerDetails.national_id_issued_at.state === "provided"
            ? toDirectEditDateInputValue(form.workerDetails.national_id_issued_at.text)
            : "",
      },
    },
  };
}

function resolveDirectEditOptionalField(
  baseField: OptionalValue<string> | undefined,
  rawInput: string,
  isDateField: boolean,
): OptionalValue<string> | undefined {
  const trimmed = rawInput.trim();
  if (trimmed === "") {
    if (baseField?.state === "provided") {
      return { state: "intentionally_blank" };
    }
    if (baseField === undefined) {
      return undefined;
    }
    return { state: baseField.state };
  }

  if (baseField?.state === "provided") {
    if (isDateField && toDirectEditDateInputValue(baseField.value) === trimmed) {
      return { state: "provided", value: baseField.value };
    }
    if (baseField.value.trim() === trimmed) {
      return { state: "provided", value: baseField.value };
    }
  }
  return { state: "provided", value: trimmed };
}

/**
 * Pure builder for `worker_details` in Direct Edit (`mode === "correction"`):
 * - Untouched empty fields (`omitted`, `unknown`, `intentionally_blank`, or `undefined`)
 *   keep their exact baseline state.
 * - Existing `provided` fields cleared to empty transition to `intentionally_blank`.
 */
export function buildDirectEditWorkerDetailsProposal(
  baseline: WorkerDetails,
  form: WorkerForm,
): ProposalBuildResult {
  const genderResolved = resolveDirectEditOptionalField(
    baseline.gender,
    form.gender.text,
    false,
  );
  if (
    genderResolved?.state === "provided" &&
    genderResolved.value !== "MALE" &&
    genderResolved.value !== "FEMALE" &&
    genderResolved.value !== "OTHER"
  ) {
    return { ok: false, code: "WORKER_INVALID" };
  }

  const dobResolved =
    resolveDirectEditOptionalField(
      baseline.date_of_birth,
      form.date_of_birth.text,
      true,
    ) ?? { state: "omitted" as const };
  const nationalIdResolved =
    resolveDirectEditOptionalField(
      baseline.national_id,
      form.national_id.text,
      false,
    ) ?? { state: "omitted" as const };
  const issuedAtResolved = resolveDirectEditOptionalField(
    baseline.national_id_issued_at,
    form.national_id_issued_at.text,
    true,
  );
  const issuedPlaceResolved = resolveDirectEditOptionalField(
    baseline.national_id_issued_place,
    form.national_id_issued_place.text,
    false,
  );
  const addressResolved =
    resolveDirectEditOptionalField(
      baseline.address,
      form.address.text,
      false,
    ) ?? { state: "omitted" as const };
  const phoneResolved =
    resolveDirectEditOptionalField(
      baseline.phone,
      form.phone.text,
      false,
    ) ?? { state: "omitted" as const };

  const candidate: WorkerDetails = {
    display_name: form.display_name.trim(),
    ...(genderResolved !== undefined
      ? { gender: genderResolved as OptionalValue<"MALE" | "FEMALE" | "OTHER"> }
      : {}),
    date_of_birth: dobResolved,
    national_id: nationalIdResolved,
    ...(issuedAtResolved !== undefined
      ? { national_id_issued_at: issuedAtResolved }
      : {}),
    ...(issuedPlaceResolved !== undefined
      ? { national_id_issued_place: issuedPlaceResolved }
      : {}),
    address: addressResolved,
    phone: phoneResolved,
  };

  if (validateWorkerDetails(candidate).length > 0) {
    return { ok: false, code: "WORKER_INVALID" };
  }
  if (!workerDetailsChanged(baseline, candidate)) {
    return { ok: false, code: "WORKER_UNCHANGED" };
  }
  return { ok: true, proposal: { worker_details: candidate } };
}

export function buildDirectEditEntryFieldProposal(input: {
  baseline: WorkerEntryFieldBaseline;
  form: WorkerEntryFieldForm;
}): ProposalBuildResult {
  const details = buildDirectEditWorkerDetailsProposal(
    input.baseline.worker_details,
    input.form.workerDetails,
  );
  if (!details.ok && details.code !== "WORKER_UNCHANGED") {
    return details;
  }
  if (
    !PROJECT_ID_PATTERN.test(input.form.project_id) ||
    !isRealCalendarDate(input.form.first_work_date) ||
    validateEmployeeCode(input.form.employee_code).length > 0 ||
    !UUID_PATTERN.test(input.form.recruiter_id) ||
    !isCanonicalLaborTypeKey(input.form.labor_type)
  ) {
    return { ok: false, code: "WORKER_INVALID" };
  }

  const proposal: Record<string, unknown> = {};
  for (const field of [
    "project_id",
    "first_work_date",
    "employee_code",
    "recruiter_id",
    "labor_type",
  ] as const) {
    if (input.form[field] !== input.baseline[field]) {
      proposal[field] = input.form[field];
    }
  }
  const nextCollab = input.form.collaborator_id ?? null;
  const prevCollab = input.baseline.collaborator_id ?? null;
  if (nextCollab !== prevCollab) {
    proposal.collaborator_id = nextCollab;
  }
  if (details.ok) {
    proposal.worker_details = details.proposal.worker_details;
  }
  if (Object.keys(proposal).length === 0) {
    return { ok: false, code: "WORKER_UNCHANGED" };
  }
  return { ok: true, proposal };
}

export type WorkerEditCatalogSelectOption = {
  value: string;
  label: string;
  isCurrentFallback: boolean;
};

/**
 * Builds `<select>` options for Project in the worker edit/propose drawer using
 * the current catalog (`today`), while keeping the worker's currently saved project
 * as a separate `(hiện tại)` option if it is not present in the active catalog.
 */
export function buildWorkerEditProjectOptions(input: {
  catalogProjects: readonly { project_id: string; display_name: string }[] | undefined;
  currentProjectId: string;
  currentProjectDisplay?: string | null;
}): readonly WorkerEditCatalogSelectOption[] {
  const projects = input.catalogProjects ?? [];
  const options: WorkerEditCatalogSelectOption[] = projects.map((project) => ({
    value: project.project_id,
    label: project.display_name,
    isCurrentFallback: false,
  }));
  const currentId = input.currentProjectId.trim();
  if (currentId !== "" && !projects.some((project) => project.project_id === currentId)) {
    const baseLabel = input.currentProjectDisplay?.trim() || "Dự án hiện tại";
    options.unshift({
      value: currentId,
      label: `${baseLabel} (hiện tại)`,
      isCurrentFallback: true,
    });
  }
  return options;
}

/**
 * Builds `<select>` options for Recruiter in the worker edit/propose drawer using
 * the current catalog (`today`), while keeping the worker's currently saved recruiter
 * as a separate `(hiện tại)` option if that recruiter is no longer in the active catalog.
 */
export function buildWorkerEditRecruiterOptions(input: {
  catalogRecruiters: readonly { recruiter_id: string; label: string }[] | undefined;
  currentRecruiterId: string;
  currentRecruiterDisplay?: string | null;
}): readonly WorkerEditCatalogSelectOption[] {
  const recruiters = input.catalogRecruiters ?? [];
  const options: WorkerEditCatalogSelectOption[] = recruiters.map((recruiter) => ({
    value: recruiter.recruiter_id,
    label: recruiter.label,
    isCurrentFallback: false,
  }));
  const currentId = input.currentRecruiterId.trim();
  if (currentId !== "" && !recruiters.some((recruiter) => recruiter.recruiter_id === currentId)) {
    const baseLabel = input.currentRecruiterDisplay?.trim() || "Người tuyển hiện tại";
    options.unshift({
      value: currentId,
      label: `${baseLabel} (hiện tại)`,
      isCurrentFallback: true,
    });
  }
  return options;
}

export function buildWorkerEditCollaboratorOptions(input: {
  catalogCollaborators: readonly { collaborator_id: string; display_name: string; active: boolean }[] | undefined;
  currentCollaboratorId: string | null | undefined;
  currentCollaboratorDisplay?: string | null;
}): readonly WorkerEditCatalogSelectOption[] {
  const activeCollaborators = (input.catalogCollaborators ?? []).filter((item) => item.active);
  const options: WorkerEditCatalogSelectOption[] = activeCollaborators.map((item) => ({
    value: item.collaborator_id,
    label: `${item.display_name} (${item.collaborator_id})`,
    isCurrentFallback: false,
  }));
  const currentId = input.currentCollaboratorId?.trim() ?? "";
  if (currentId !== "" && !activeCollaborators.some((item) => item.collaborator_id === currentId)) {
    const inactiveMatch = (input.catalogCollaborators ?? []).find((item) => item.collaborator_id === currentId);
    const baseLabel = input.currentCollaboratorDisplay?.trim() || inactiveMatch?.display_name || currentId;
    options.unshift({
      value: currentId,
      label: `${baseLabel} (${currentId}) (hiện tại)`,
      isCurrentFallback: true,
    });
  }
  return options;
}

export type DirectEditBaselinePayment = {
  state: PaymentState;
  account_number: string | null;
  bank_id: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
};

export type DirectEditPaymentPatchPayload = {
  state: PaymentState;
  account_number: string | null;
  bank_id: string | null;
  bank_name?: string | null;
  account_holder_name: string | null;
};

export type DirectEditPaymentPatchResult =
  | { kind: "unchanged" }
  | { kind: "changed"; proposal: DirectEditPaymentPatchPayload }
  | { kind: "invalid"; message: string };

export function initialDirectEditBankQueryText(
  payment: DirectEditBaselinePayment | null | undefined,
  catalogBanks: readonly BankCatalogEntryInput[] = [],
): string {
  if (!payment || payment.state !== "provided") return "";
  const merged = mergeVietQrBankCatalog(catalogBanks);
  if (payment.bank_id) {
    const matched = resolveBankCatalogOption(merged, payment.bank_id);
    if (matched) return matched.short_name;
  }
  if (payment.bank_name && payment.bank_name.trim().length > 0) {
    return payment.bank_name.trim();
  }
  return payment.bank_id?.trim() ?? "";
}

/**
 * Pure builder for `payment` patch in Direct Edit (`mode === "correction"`):
 * - If all inputs are empty and baseline was not `provided` (`null`, `omitted`, `unknown`,
 *   `intentionally_blank`), returns `{ kind: "unchanged" }` to preserve the original state.
 * - If all inputs are cleared to empty and baseline had `state === "provided"`,
 *   transitions to `state: "intentionally_blank"`.
 * - Resolves bank selection against the merged VietQR + DB bank catalog; if the user enters
 *   a bank name not found in the catalog, saves `bank_id: null` and `bank_name: <reference text>`.
 */
export function buildDirectEditPaymentPatch(input: {
  baseline: DirectEditBaselinePayment | null;
  accountNumber: string;
  bankId: string;
  bankQueryText: string;
  accountHolderName: string;
  catalogBanks?: readonly BankCatalogEntryInput[];
}): DirectEditPaymentPatchResult {
  const trimmedAccount = input.accountNumber.trim();
  const trimmedHolder = input.accountHolderName.trim();
  const trimmedBankId = input.bankId.trim();
  const trimmedBankText = input.bankQueryText.trim();

  const allEmpty =
    trimmedAccount === "" &&
    trimmedHolder === "" &&
    trimmedBankId === "" &&
    trimmedBankText === "";

  if (allEmpty) {
    if (input.baseline === null || input.baseline.state !== "provided") {
      return { kind: "unchanged" };
    }
    return {
      kind: "changed",
      proposal: {
        state: "intentionally_blank",
        account_number: null,
        bank_id: null,
        bank_name: null,
        account_holder_name: null,
      },
    };
  }

  if (trimmedAccount !== "" && !/^\d{1,64}$/.test(trimmedAccount)) {
    return {
      kind: "invalid",
      message: "Số tài khoản ngân hàng chỉ gồm chữ số (tối đa 64 ký tự).",
    };
  }

  if (trimmedHolder !== "" && !isPaymentText(trimmedHolder, 256)) {
    return {
      kind: "invalid",
      message: "Tên chủ tài khoản không hợp lệ (tối đa 256 ký tự).",
    };
  }

  const mergedBanks = mergeVietQrBankCatalog(input.catalogBanks ?? []);
  const initialBankText = initialDirectEditBankQueryText(
    input.baseline,
    input.catalogBanks ?? [],
  );

  let resolvedBankId: string | null = null;
  let resolvedBankName: string | null = null;

  if (trimmedBankText !== "" || trimmedBankId !== "") {
    if (
      input.baseline?.state === "provided" &&
      trimmedBankId === (input.baseline.bank_id ?? "") &&
      trimmedBankText === initialBankText
    ) {
      resolvedBankId = input.baseline.bank_id;
      resolvedBankName =
        input.baseline.bank_name ??
        (resolvedBankId
          ? resolveBankCatalogOption(mergedBanks, resolvedBankId)?.short_name ?? null
          : null);
    } else {
      const selectedById =
        trimmedBankId !== ""
          ? resolveBankCatalogOption(mergedBanks, trimmedBankId)
          : null;
      const matchedByText =
        trimmedBankText !== ""
          ? resolveBankCatalogOption(mergedBanks, trimmedBankText)
          : null;

      if (
        selectedById !== null &&
        (trimmedBankText === "" ||
          matchedByText?.bank_id === selectedById.bank_id)
      ) {
        resolvedBankId = selectedById.bank_id;
        resolvedBankName = selectedById.short_name;
      } else if (matchedByText !== null) {
        resolvedBankId = matchedByText.bank_id;
        resolvedBankName = matchedByText.short_name;
      } else if (trimmedBankText !== "") {
        if (!isPaymentText(trimmedBankText, 256)) {
          return {
            kind: "invalid",
            message: "Tên ngân hàng tham chiếu không hợp lệ (tối đa 256 ký tự).",
          };
        }
        resolvedBankId = null;
        resolvedBankName = trimmedBankText;
      } else if (trimmedBankId !== "") {
        resolvedBankId = trimmedBankId;
        resolvedBankName = null;
      }
    }
  }

  const nextAccountNumber = trimmedAccount === "" ? null : trimmedAccount;
  const nextAccountHolder = trimmedHolder === "" ? null : trimmedHolder;

  if (input.baseline !== null && input.baseline.state === "provided") {
    const baseAccount = input.baseline.account_number ?? null;
    const baseBankId = input.baseline.bank_id ?? null;
    const baseBankName = input.baseline.bank_name ?? null;
    const baseHolder = input.baseline.account_holder_name ?? null;
    const bankUnchanged =
      baseBankId === resolvedBankId &&
      (resolvedBankId !== null || baseBankName === resolvedBankName);
    if (
      baseAccount === nextAccountNumber &&
      bankUnchanged &&
      baseHolder === nextAccountHolder
    ) {
      return { kind: "unchanged" };
    }
  }

  return {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: nextAccountNumber,
      bank_id: resolvedBankId,
      ...(resolvedBankName !== null || resolvedBankId === null
        ? { bank_name: resolvedBankName }
        : {}),
      account_holder_name: nextAccountHolder,
    },
  };
}

export type {
  ChangeRequestListItem,
  SubmissionReadItem,
  WorkerDirectoryPage,
  WorkerDirectoryRow,
};
