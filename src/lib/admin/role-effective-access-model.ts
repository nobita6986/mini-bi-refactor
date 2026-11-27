/**
 * WP6 UI projection, formatting, request builders, and state classifiers for:
 * - `/admin/access/effective` (read-only Effective Access inspector)
 * - `/admin/access/accounts` Global Role tab (ADMIN = "BoD/Admin" + global roles)
 *
 * Strictly reuses canonical projectors, validators, and error classifiers from
 * `src/lib/auth/role-access-contract.ts` — never invents a second client authz matrix.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  AUTHZ_CANONICAL_ROLE_CATALOG,
  AUTHZ_CONTEXTUAL_ROLE_CODES,
  AUTHZ_GLOBAL_ROLE_CODES,
  AUTHZ_ROLE_CODES,
  RoleAccessValidationError,
  classifyRoleMutationFailure,
  findForbiddenAuthorityField,
  parseAccountsSummaryQuery,
  parseAssignGlobalRoleBody,
  parseRevokeGlobalRoleBody,
  projectAccountAccessDetail,
  projectAccountsSummaryResponse,
  projectRoleMutationResult,
  projectRolesCatalogResponse,
  type AccountAccessDetail,
  type AccountsSummaryItem,
  type AccountsSummaryListResponse,
  type AccountsSummaryQuery,
  type AssignedGlobalRoleItem,
  type AssignGlobalRoleInput,
  type AuthzDirectExceptionSourceKind,
  type AuthzRoleCode,
  type AuthzRoleSourceKind,
  type AuthzScopeKind,
  type CannotRevokeReason,
  type Capability,
  type ContextualAssignmentItem,
  type DirectExceptionItem,
  type GlobalRoleCode,
  type ModuleAuthorityItem,
  type PairedEffectiveGrantItem,
  type RevokeGlobalRoleInput,
  type RoleCatalogItem,
  type RoleMutationResult,
  type RolesCatalogEnvelope,
} from "../auth/role-access-contract.ts";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";

export {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  AUTHZ_CANONICAL_ROLE_CATALOG,
  AUTHZ_CONTEXTUAL_ROLE_CODES,
  AUTHZ_GLOBAL_ROLE_CODES,
  AUTHZ_ROLE_CODES,
  findForbiddenAuthorityField,
};

export const DEFAULT_ROLE_ACCESS_PAGE_SIZE = 25;
export const ROLE_REASON_MIN_LENGTH = 3;
export const ROLE_REASON_MAX_LENGTH = 500;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export type EnabledFilterOption = "all" | "true" | "false";
export type RoleFilterOption = "all" | AuthzRoleCode;

export type CapabilityDomainId =
  | "direct_entry"
  | "worker_compliance"
  | "organization_catalog"
  | "work_reports"
  | "vendor_finance";

export type CapabilityDomainMeta = {
  id: CapabilityDomainId;
  title: string;
  description: string;
};

export const CAPABILITY_DOMAINS: readonly CapabilityDomainMeta[] = [
  {
    id: "direct_entry",
    title: "Nhập liệu & Điều hành tuyển dụng",
    description: "Quyền tạo mới, xem theo phạm vi, nộp hồ sơ và chỉnh sửa đặc quyền.",
  },
  {
    id: "worker_compliance",
    title: "Hồ sơ NLĐ, Tài liệu & Trạng thái",
    description: "Quyền xử lý tài liệu, lịch sử chỉnh sửa, CCCD trùng và trạng thái làm việc.",
  },
  {
    id: "organization_catalog",
    title: "Tổ chức, Danh mục & Kiểm toán",
    description: "Quyền quản trị đội ngũ, danh mục, người tuyển dụng và nhật ký hệ thống.",
  },
  {
    id: "work_reports",
    title: "Báo cáo công việc & Phân tích",
    description: "Quyền giao báo cáo, xem thống kê, duyệt và quản lý mẫu báo cáo.",
  },
  {
    id: "vendor_finance",
    title: "Tài chính & Công nợ Vendor",
    description: "Quyền theo dõi công nợ, chứng từ và ghi nhận giao dịch Vendor.",
  },
];

export type CapabilityPresentation = {
  label: string;
  domain: CapabilityDomainId;
  retiredCompat?: boolean;
};

export const CAPABILITY_PRESENTATION_MAP: Readonly<Record<Capability, CapabilityPresentation>> = {
  entry_create: { label: "Tạo mới hồ sơ nhập liệu", domain: "direct_entry" },
  entry_own: { label: "Xem và xử lý hồ sơ do mình tạo", domain: "direct_entry" },
  entry_team: { label: "Xem hồ sơ trong phạm vi đội nhóm", domain: "direct_entry" },
  entry_admin: { label: "Quản trị nhập liệu và điều hành chung", domain: "direct_entry" },
  submission_create: { label: "Nộp hồ sơ người lao động", domain: "direct_entry" },
  change_request_create: {
    label: "Gửi đề xuất thay đổi hồ sơ (tương thích cũ)",
    domain: "direct_entry",
    retiredCompat: true,
  },
  change_review: {
    label: "Duyệt đề xuất thay đổi hồ sơ (tương thích cũ)",
    domain: "direct_entry",
    retiredCompat: true,
  },
  entry_privileged_edit: { label: "Chỉnh sửa đặc quyền hồ sơ NLĐ", domain: "direct_entry" },
  "employment_status.request": {
    label: "Đề xuất đổi trạng thái làm việc (tương thích cũ)",
    domain: "worker_compliance",
    retiredCompat: true,
  },
  "employment_status.review": {
    label: "Thẩm định thay đổi trạng thái làm việc",
    domain: "worker_compliance",
  },
  "employment_status.apply": {
    label: "Áp dụng thay đổi trạng thái làm việc",
    domain: "worker_compliance",
  },
  document_upload: { label: "Tải lên tài liệu & ảnh hồ sơ", domain: "worker_compliance" },
  document_view: { label: "Xem tài liệu & chứng từ hồ sơ", domain: "worker_compliance" },
  duplicate_cccd_withdraw: { label: "Rút hồ sơ trùng CCCD", domain: "worker_compliance" },
  worker_edit_history_view: {
    label: "Xem lịch sử chỉnh sửa người lao động",
    domain: "worker_compliance",
  },
  recruiter_master_manage: {
    label: "Quản trị hồ sơ tính công tuyển dụng",
    domain: "organization_catalog",
  },
  team_master_manage: {
    label: "Quản trị đội ngũ & bổ nhiệm Trưởng nhóm",
    domain: "organization_catalog",
  },
  audit_view: { label: "Xem nhật ký kiểm toán hệ thống", domain: "organization_catalog" },
  entry_restore: { label: "Khôi phục hồ sơ đã ẩn / xóa mềm", domain: "organization_catalog" },
  catalog_master_manage: {
    label: "Quản trị danh mục (Vendor, Nhóm, Loại hình)",
    domain: "organization_catalog",
  },
  team_manager_assign: {
    label: "Điều phối thành viên trong nhóm quản lý",
    domain: "organization_catalog",
  },
  report_form_manage: { label: "Quản lý mẫu báo cáo công việc", domain: "work_reports" },
  report_assign: { label: "Giao việc & đợt nộp báo cáo", domain: "work_reports" },
  report_view: { label: "Xem báo cáo công việc", domain: "work_reports" },
  report_analytics_view: { label: "Xem thống kê & phân tích báo cáo", domain: "work_reports" },
  report_review: { label: "Duyệt bài nộp báo cáo công việc", domain: "work_reports" },
  report_delegate: { label: "Ủy quyền duyệt / giao báo cáo", domain: "work_reports" },
  vendor_finance_view: { label: "Xem công nợ & sổ cái Vendor", domain: "vendor_finance" },
  vendor_finance_record: { label: "Ghi nhận thanh toán & tạm ứng Vendor", domain: "vendor_finance" },
  vendor_referrer_manage: { label: "Quản lý người giới thiệu Vendor (BoD)", domain: "organization_catalog" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapOkData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k !== "ok") copy[k] = v;
  }
  return copy;
}

export function extractRoleAccessError(payload: unknown): {
  code: string | null;
  message: string | null;
  currentVersion: number | undefined;
} {
  if (!isRecord(payload) || payload.ok !== false || !isRecord(payload.error)) {
    return { code: null, message: null, currentVersion: undefined };
  }
  const code = typeof payload.error.code === "string" ? payload.error.code : null;
  const message =
    typeof payload.error.message === "string" && payload.error.message.trim().length > 0
      ? payload.error.message
      : null;
  const rawVersion = payload.error.current_version;
  const currentVersion =
    typeof rawVersion === "number" && Number.isSafeInteger(rawVersion) && rawVersion >= 1
      ? rawVersion
      : undefined;
  return { code, message, currentVersion };
}

/* ==================== Query & Response Projectors ==================== */

export function buildAccountsSummaryUrlQuery(input: {
  search: string;
  enabled: EnabledFilterOption;
  roleCode: RoleFilterOption;
  page: number;
  pageSize?: number;
}):
  | { ok: true; params: URLSearchParams; query: AccountsSummaryQuery }
  | { ok: false; message: string } {
  const params = new URLSearchParams();
  const trimmedSearch = input.search.trim();
  if (CONTROL_CHAR_PATTERN.test(trimmedSearch) || trimmedSearch.length > 256) {
    return { ok: false, message: "Từ khóa tìm kiếm tối đa 256 ký tự và không chứa ký tự điều khiển." };
  }
  if (trimmedSearch.length > 0) {
    params.set("search", trimmedSearch);
  }
  params.set("enabled", input.enabled);
  if (input.roleCode !== "all") {
    params.set("role_code", input.roleCode);
  }
  params.set("page", String(input.page));
  params.set("page_size", String(input.pageSize ?? DEFAULT_ROLE_ACCESS_PAGE_SIZE));

  try {
    const query = parseAccountsSummaryQuery(params);
    return { ok: true, params, query };
  } catch (error) {
    if (error instanceof RoleAccessValidationError) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "Tham số tìm kiếm và lọc danh sách không hợp lệ." };
  }
}

export function projectRolesCatalogEnvelope(payload: unknown): RolesCatalogEnvelope | null {
  const unwrapped = unwrapOkData(payload);
  return unwrapped ? projectRolesCatalogResponse(unwrapped) : null;
}

export function projectAccountsSummaryForQuery(
  payload: unknown,
  expected: AccountsSummaryQuery,
): AccountsSummaryListResponse | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(payload, "list")) {
    return null;
  }
  const projected = projectAccountsSummaryResponse(payload.list);
  if (!projected) return null;
  if (
    projected.search !== expected.search ||
    projected.enabled !== expected.enabled ||
    projected.role_code !== expected.role_code ||
    projected.page !== expected.page ||
    projected.page_size !== expected.page_size
  ) {
    return null;
  }
  return projected;
}

export function projectAccountAccessForTarget(
  payload: unknown,
  expectedAccountRef: string,
): AccountAccessDetail | null {
  if (!isUuid(expectedAccountRef)) return null;
  const unwrapped = unwrapOkData(payload);
  if (!unwrapped) return null;
  const detail = projectAccountAccessDetail(unwrapped);
  if (!detail) return null;
  if (detail.account.account_ref !== expectedAccountRef.toLowerCase()) {
    return null;
  }
  return detail;
}

export function projectRoleMutationEnvelope(
  payload: unknown,
  expectedAccountRef: string,
): RoleMutationResult | null {
  if (!isUuid(expectedAccountRef)) return null;
  const unwrapped = unwrapOkData(payload);
  if (!unwrapped) return null;
  const result = projectRoleMutationResult(unwrapped);
  if (!result) return null;
  if (result.account_ref !== expectedAccountRef.toLowerCase()) {
    return null;
  }
  return result;
}

/* ==================== Role Catalog & Protection Helpers ==================== */

export function resolveAssignableGlobalRoles(
  catalog: readonly RoleCatalogItem[] | null | undefined,
): RoleCatalogItem[] {
  const source = catalog && catalog.length > 0 ? catalog : AUTHZ_CANONICAL_ROLE_CATALOG;
  return source
    .filter((item) => item.assignment_mode === "GLOBAL" && item.is_assignable_global)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

export function resolveRoleCatalogFilters(
  catalog: readonly RoleCatalogItem[] | null | undefined,
): { globalRoles: RoleCatalogItem[]; contextualRoles: RoleCatalogItem[] } {
  const source = catalog && catalog.length > 0 ? catalog : AUTHZ_CANONICAL_ROLE_CATALOG;
  const sorted = source.slice().sort((a, b) => a.sort_order - b.sort_order);
  return {
    globalRoles: sorted.filter((item) => item.assignment_mode === "GLOBAL"),
    contextualRoles: sorted.filter((item) => item.assignment_mode === "CONTEXTUAL"),
  };
}

export function splitOpenAndEndedGlobalRoles(items: readonly AssignedGlobalRoleItem[]): {
  activeAssigned: AssignedGlobalRoleItem[];
  endedHistory: AssignedGlobalRoleItem[];
} {
  const activeAssigned: AssignedGlobalRoleItem[] = [];
  const endedHistory: AssignedGlobalRoleItem[] = [];
  for (const item of items) {
    if (item.ended_at === null) activeAssigned.push(item);
    else endedHistory.push(item);
  }
  return { activeAssigned, endedHistory };
}

export function splitOpenAndEndedDirectExceptions(items: readonly DirectExceptionItem[]): {
  activeExceptions: DirectExceptionItem[];
  endedHistory: DirectExceptionItem[];
} {
  const activeExceptions: DirectExceptionItem[] = [];
  const endedHistory: DirectExceptionItem[] = [];
  for (const item of items) {
    if (item.ended_at === null) activeExceptions.push(item);
    else endedHistory.push(item);
  }
  return { activeExceptions, endedHistory };
}

export function describeCannotRevokeReason(reason: CannotRevokeReason | null): string | null {
  if (reason === "PROTECTED_OWNER_ADMIN") {
    return "Vai trò BoD/Admin gốc của Chủ sở hữu hệ thống (Owner) được bảo vệ cố định, không thể thu hồi.";
  }
  return null;
}

export function canAssignNewGlobalRoleToAccount(
  account: Pick<AccountAccessDetail["account"], "enabled">,
  canManageGlobalRoles: boolean,
  gateBlocked: boolean,
): { allowed: boolean; reason: string | null } {
  if (!canManageGlobalRoles) {
    return {
      allowed: false,
      reason: "Phiên hiện tại không có đủ quyền Full Admin để cấp hoặc thu hồi vai trò toàn cục.",
    };
  }
  if (gateBlocked) {
    return {
      allowed: false,
      reason: "Cổng thay đổi vai trò toàn cục chưa mở trong chặng triển khai hiện tại.",
    };
  }
  if (!account.enabled) {
    return {
      allowed: false,
      reason:
        "Tài khoản đang ngừng hoạt động nên không thể cấp vai trò toàn cục mới (các vai trò chưa bảo vệ vẫn có thể thu hồi).",
    };
  }
  return { allowed: true, reason: null };
}

/* ==================== Vietnamese Business Presentations ==================== */

const ACCOUNT_TIME_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatAuthzTimestampVi(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return `${ACCOUNT_TIME_FORMATTER.format(new Date(parsed))} (+07)`;
}

export function describeInactiveOrBlockingReason(reason: string | null | undefined): string {
  switch (reason) {
    case "ACCOUNT_DISABLED":
      return "Tài khoản đang bị khóa (ngừng hoạt động), mọi quyền thực tế bị tạm đình chỉ (0 quyền hiệu lực).";
    case "PERSON_INACTIVE":
      return "Hồ sơ nhân sự nội bộ liên kết chưa hoạt động hoặc đã ngừng hoạt động.";
    case "TEAM_INACTIVE":
      return "Nhóm tuyển dụng liên quan đã ngừng hoạt động.";
    case "DEPARTMENT_INACTIVE":
      return "Phòng ban liên quan hiện đã ngừng hoạt động.";
    case "PROJECT_INACTIVE":
      return "Dự án liên quan hiện đã đóng hoặc ngừng hoạt động.";
    case "RECRUITER_INACTIVE":
      return "Hồ sơ tính công tuyển dụng liên kết đang ngừng hoạt động.";
    case "REVOKED":
      return "Phân công đã được kết thúc / thu hồi.";
    default:
      return reason ? `Bị chặn hiệu lực (${reason}).` : "Đang bị chặn hiệu lực.";
  }
}

export function formatRoleSourceKind(sourceKind: AuthzRoleSourceKind): string {
  switch (sourceKind) {
    case "ADMIN_ASSIGNMENT":
      return "Quản trị viên gán trực tiếp";
    case "PERSONNEL_LINK_AUTO":
      return "Đồng bộ khi liên kết hồ sơ nhân sự";
    case "BACKFILL_SNAPSHOT":
      return "Khởi tạo từ đợt chuyển đổi nền";
  }
}

export function formatExceptionSourceKind(sourceKind: AuthzDirectExceptionSourceKind): string {
  switch (sourceKind) {
    case "EXCEPTION_GRANT":
      return "Cấp ngoại lệ trực tiếp";
    case "BACKFILL_EXCEPTION":
      return "Ngoại lệ giữ nguyên từ nền cũ";
  }
}

export function formatGrantScopeLabel(
  scopeKind: AuthzScopeKind,
  scopeLabel?: string | null,
  scopeId?: string | null,
): string {
  switch (scopeKind) {
    case "ALL":
      return "Toàn công ty";
    case "OWN":
      return "Hồ sơ tự tạo / phạm vi cá nhân";
    case "CONTEXT_TEAM":
      return `Nhóm: ${scopeLabel ?? scopeId ?? "Theo nhóm"}`;
    case "CONTEXT_DEPARTMENT":
      return `Phòng ban: ${scopeLabel ?? scopeId ?? "Theo phòng ban"}`;
    case "CONTEXT_PROJECT":
      return `Dự án: ${scopeLabel ?? scopeId ?? "Theo dự án"}`;
  }
}

export function resolveGrantSourceLabel(
  grant: PairedEffectiveGrantItem,
  detail: Pick<AccountAccessDetail, "assigned_global_roles" | "contextual_assignments">,
): string {
  if (grant.source_type === "ROLE_BUNDLE") {
    const matchedRole = grant.source_id
      ? detail.assigned_global_roles.find(
          (role) => role.assignment_id === grant.source_id,
        )
      : undefined;
    return matchedRole
      ? `Từ vai trò ${matchedRole.display_name}`
      : "Từ vai trò toàn cục";
  }
  if (grant.source_type === "CONTEXTUAL_ASSIGNMENT") {
    const matchedCtx = grant.source_id
      ? detail.contextual_assignments.find(
          (ctx) => ctx.assignment_id === grant.source_id,
        )
      : undefined;
    return matchedCtx
      ? `Từ phân công ${matchedCtx.display_name} · ${matchedCtx.target_label}`
      : "Từ phân công theo ngữ cảnh";
  }
  if (grant.source_type === "DIRECT_GRANT") {
    return "Từ quyền ngoại lệ trực tiếp";
  }
  return "Từ cầu nối phân quyền hiện hành";
}

export type EffectiveGrantRowView = {
  key: string;
  capability: Capability;
  capabilityLabel: string;
  retiredCompat: boolean;
  scopeKind: AuthzScopeKind;
  scopeText: string;
  sourceLabel: string;
};

export type EffectiveGrantDomainGroup = {
  domain: CapabilityDomainMeta;
  items: EffectiveGrantRowView[];
};

export function groupEffectiveGrantsByDomain(
  detail: AccountAccessDetail,
): EffectiveGrantDomainGroup[] {
  const byDomain = new Map<CapabilityDomainId, EffectiveGrantRowView[]>();
  for (const grant of detail.effective_grants) {
    const meta = CAPABILITY_PRESENTATION_MAP[grant.capability];
    const row: EffectiveGrantRowView = {
      key: `${grant.capability}:${grant.scope_kind}:${grant.scope_id ?? "none"}:${grant.source_type}:${grant.source_id ?? "none"}`,
      capability: grant.capability,
      capabilityLabel: meta.label,
      retiredCompat: Boolean(meta.retiredCompat),
      scopeKind: grant.scope_kind,
      scopeText: formatGrantScopeLabel(grant.scope_kind, grant.scope_label, grant.scope_id),
      sourceLabel: resolveGrantSourceLabel(grant, detail),
    };
    const bucket = byDomain.get(meta.domain);
    if (bucket) bucket.push(row);
    else byDomain.set(meta.domain, [row]);
  }
  const groups: EffectiveGrantDomainGroup[] = [];
  for (const domain of CAPABILITY_DOMAINS) {
    const items = byDomain.get(domain.id);
    if (items && items.length > 0) {
      groups.push({ domain, items });
    }
  }
  return groups;
}

export function resolveContextualAssignmentPresentation(item: ContextualAssignmentItem): {
  targetKindLabel: string;
  statusLabel: string;
  statusTone: BadgeTone;
  explanation: string;
  capabilityLabels: string[];
  sourceLink: { label: string; href: string };
} {
  const capabilityLabels = item.derived_capabilities.map(
    (cap) => CAPABILITY_PRESENTATION_MAP[cap].label,
  );
  let targetKindLabel = "Đối tượng";
  let note = "";
  let sourceLink: { label: string; href: string };

  switch (item.role_code) {
    case "TEAM_LEADER":
      targetKindLabel = "Nhóm tuyển dụng";
      note =
        capabilityLabels.length > 0
          ? "Quyền quản lý nhóm và xem báo cáo phạm vi đội ngũ."
          : "Phân công trưởng nhóm tuyển dụng.";
      sourceLink = { label: "Mở quản lý Nhóm", href: "/admin/catalog/teams" };
      break;
    case "DEPARTMENT_HEAD":
      targetKindLabel = "Phòng ban";
      note =
        "Chức danh trưởng phòng ban (chỉ hiệu lực khi hồ sơ nhân sự nội bộ và phòng ban đều đang hoạt động).";
      sourceLink = {
        label: "Mở chi tiết Phòng ban",
        href: isUuid(item.target_ref)
          ? `/admin/departments/${encodeURIComponent(item.target_ref)}`
          : "/admin/departments",
      };
      break;
    case "PROJECT_MANAGER":
      targetKindLabel = "Dự án";
      note =
        "Quyết định quyền quản lý dự án và đăng tin tuyển dụng cho đúng dự án này (kể cả với BoD/Admin).";
      sourceLink = { label: "Mở quản lý Dự án", href: "/direct-entry/projects" };
      break;
    case "PROJECT_ACCOUNTANT":
      targetKindLabel = "Dự án";
      note = "Kế toán phụ trách theo dõi công nợ và chứng từ tài chính trong phạm vi dự án.";
      sourceLink = {
        label: "Mở phân công Kế toán dự án",
        href: "/finance/project-assignments",
      };
      break;
  }

  const statusLabel = item.is_effective
    ? "Đang có hiệu lực"
    : "Được phân công · Đang bị chặn";
  const statusTone: BadgeTone = item.is_effective ? "success" : "warning";
  const explanation = item.is_effective
    ? note
    : `${describeInactiveOrBlockingReason(item.inactive_reason)} (${note})`;

  return {
    targetKindLabel,
    statusLabel,
    statusTone,
    explanation,
    capabilityLabels,
    sourceLink,
  };
}

export function resolveModuleAuthorityPresentation(item: ModuleAuthorityItem): {
  moduleLabel: string;
  authorityTitle: string;
  scopeText: string;
  statusLabel: string;
  statusTone: BadgeTone;
  blockingText: string | null;
  sourceLink: { label: string; href: string } | null;
} {
  let moduleLabel = "Phân hệ nghiệp vụ";
  let authorityTitle = item.display_name;
  let sourceLink: { label: string; href: string } | null = null;

  if (item.module === "work_reports") {
    moduleLabel = "Báo cáo công việc · Ủy quyền";
    authorityTitle =
      item.authority_code === "REPORT_REVIEWER"
        ? "Được ủy quyền duyệt báo cáo (theo mẫu & phạm vi)"
        : item.authority_code === "REPORT_ASSIGN_DELEGATE"
          ? "Được ủy quyền giao báo cáo (theo mẫu & phạm vi)"
          : item.display_name;
    sourceLink = { label: "Mở màn hình Ủy quyền báo cáo", href: "/work-reports/delegations" };
  } else if (item.module === "vendor_finance") {
    moduleLabel = "Tài chính Vendor";
    authorityTitle =
      item.authority_code === "CASH_HOLDER_RECORD_BEHALF"
        ? "Thủ quỹ / Ghi nhận thu chi thay mặt"
        : item.display_name;
    sourceLink = {
      label: "Mở quản trị phân công Tài chính",
      href: "/finance/project-assignments",
    };
  } else if (item.module === "leave") {
    moduleLabel = "Nghỉ phép & Chấm công";
    authorityTitle =
      item.authority_code === "LEAVE_DEPT_APPROVER"
        ? `Người duyệt đơn nghỉ phép theo khối${item.scope_label ? ` (${item.scope_label})` : ""}`
        : item.display_name;
    sourceLink = { label: "Mở Quản trị nghỉ phép", href: "/leave/admin" };
  }

  const scopeText =
    item.scope_kind === "ALL"
      ? "Toàn công ty"
      : item.scope_kind === "CONTEXT_TEAM"
        ? `Nhóm: ${item.scope_label ?? item.scope_ref ?? "Theo nhóm"}`
        : item.scope_kind === "CONTEXT_DEPARTMENT"
          ? `Khối / Phòng ban: ${item.scope_label ?? item.scope_ref ?? "Theo đơn vị"}`
          : item.scope_label ?? item.scope_kind;

  return {
    moduleLabel,
    authorityTitle,
    scopeText,
    statusLabel: item.is_effective ? "Đang có hiệu lực" : "Được gán · Đang bị chặn",
    statusTone: item.is_effective ? "success" : "warning",
    blockingText: item.is_effective
      ? null
      : describeInactiveOrBlockingReason(item.inactive_reason),
    sourceLink,
  };
}

export function formatAccountDisplayIdentity(
  account: Pick<AccountsSummaryItem, "display_name" | "login_id">,
): { primary: string; secondary: string | null } {
  const primary = account.display_name ?? account.login_id ?? "Tài khoản chưa đặt tên";
  const secondary =
    account.login_id && account.login_id !== primary ? account.login_id : null;
  return { primary, secondary };
}

/* ==================== Mutation Builders & Error/State Classifiers ==================== */

export function newRoleMutationIdempotencyKey(): string {
  return newIdempotencyKey().toLowerCase();
}

export function buildAssignGlobalRoleRequest(input: {
  roleCode: GlobalRoleCode | "";
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}):
  | { ok: true; idempotencyKey: string; body: AssignGlobalRoleInput }
  | { ok: false; message: string } {
  if (!input.roleCode) {
    return { ok: false, message: "Vui lòng chọn một vai trò toàn cục cần cấp." };
  }
  const candidate = {
    role_code: input.roleCode,
    expected_version: input.expectedVersion,
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  };
  try {
    const body = parseAssignGlobalRoleBody(candidate, input.idempotencyKey);
    return { ok: true, idempotencyKey: body.idempotency_key, body };
  } catch (error) {
    if (error instanceof RoleAccessValidationError) {
      if (error.code === "AUTHZ_VALIDATION_ERROR" && input.reason.trim().length < ROLE_REASON_MIN_LENGTH) {
        return {
          ok: false,
          message: `Lý do cấp vai trò phải có từ ${ROLE_REASON_MIN_LENGTH} đến ${ROLE_REASON_MAX_LENGTH} ký tự.`,
        };
      }
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "Thông tin cấp vai trò không hợp lệ." };
  }
}

export function buildRevokeGlobalRoleRequest(input: {
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}):
  | { ok: true; idempotencyKey: string; body: RevokeGlobalRoleInput }
  | { ok: false; message: string } {
  const candidate = {
    expected_version: input.expectedVersion,
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  };
  try {
    const body = parseRevokeGlobalRoleBody(candidate, input.idempotencyKey);
    return { ok: true, idempotencyKey: body.idempotency_key, body };
  } catch (error) {
    if (error instanceof RoleAccessValidationError) {
      if (error.code === "AUTHZ_VALIDATION_ERROR" && input.reason.trim().length < ROLE_REASON_MIN_LENGTH) {
        return {
          ok: false,
          message: `Lý do thu hồi vai trò phải có từ ${ROLE_REASON_MIN_LENGTH} đến ${ROLE_REASON_MAX_LENGTH} ký tự.`,
        };
      }
      return { ok: false, message: error.message };
    }
    return { ok: false, message: "Thông tin thu hồi vai trò không hợp lệ." };
  }
}

export type RoleReadFailureKind =
  | { kind: "unauthenticated"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "unavailable"; message: string; retryable: true }
  | { kind: "invalid"; message: string; retryable: boolean };

export function classifyRoleReadFailure(
  status: number,
  payload: unknown,
): RoleReadFailureKind {
  const parsed = extractRoleAccessError(payload);
  if (status === 401 || parsed.code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  if (status === 403) {
    return {
      kind: "denied",
      message:
        parsed.code === "ACTOR_NOT_AVAILABLE"
          ? "Không xác định được tài khoản quản trị đang hoạt động."
          : "Bạn không có quyền Full Admin (BoD/Admin) để truy cập dữ liệu phân quyền.",
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      message:
        parsed.code === "ACCOUNT_NOT_FOUND"
          ? "Không tìm thấy tài khoản trên máy chủ."
          : "Endpoint xem phân quyền hiện chưa được kích hoạt.",
    };
  }
  if (status === 0 || status >= 500 || parsed.code === "AUTHZ_UNAVAILABLE") {
    return {
      kind: "unavailable",
      message: "Dịch vụ tra cứu quyền hiệu lực tạm thời không khả dụng. Hãy thử tải lại.",
      retryable: true,
    };
  }
  return {
    kind: "invalid",
    message: parsed.message ?? "Phản hồi từ máy chủ không đúng định dạng chuẩn.",
    retryable: true,
  };
}

export type RoleGateReason = "MUTATIONS_ENV_DISABLED" | "CUTOVER_NOT_READY";

export type RoleMutationOutcome =
  | {
      kind: "applied";
      result: RoleMutationResult;
      replayed: boolean;
    }
  | {
      kind: "uncertain";
      preserveIdempotencyKey: true;
      lockForm: true;
      message: string;
    }
  | {
      kind: "session-lost";
      unauthenticated: boolean;
      preserveIdempotencyKey: false;
      message: string;
    }
  | {
      kind: "csrf-rejected";
      preserveIdempotencyKey: false;
      lockForm: true;
      message: string;
    }
  | {
      kind: "gate-closed";
      gateReason: RoleGateReason;
      preserveIdempotencyKey: false;
      lockForm: true;
      message: string;
    }
  | {
      kind: "protected-assignment";
      cannotRevokeReason: "PROTECTED_OWNER_ADMIN";
      preserveIdempotencyKey: false;
      lockForm: true;
      message: string;
    }
  | {
      kind: "version-conflict";
      currentVersion: number | undefined;
      preserveIdempotencyKey: false;
      mustReloadAccount: true;
      message: string;
    }
  | {
      kind: "not-found";
      code: "ACCOUNT_NOT_FOUND" | "ROLE_ASSIGNMENT_NOT_FOUND";
      preserveIdempotencyKey: false;
      mustReloadAccount: true;
      message: string;
    }
  | {
      kind: "business-conflict";
      code: string | null;
      preserveIdempotencyKey: false;
      mustReloadAccount: boolean;
      message: string;
    }
  | {
      kind: "validation-error";
      code: string | null;
      preserveIdempotencyKey: false;
      lockForm: false;
      message: string;
    };

export function classifyRoleMutationResponse(
  status: number,
  payload: unknown,
  expectedAccountRef: string,
): RoleMutationOutcome {
  if (status === 200 || status === 201) {
    const result = projectRoleMutationEnvelope(payload, expectedAccountRef);
    if (result) {
      return { kind: "applied", result, replayed: result.replayed };
    }
    return {
      kind: "uncertain",
      preserveIdempotencyKey: true,
      lockForm: true,
      message:
        "Phản hồi thay đổi vai trò không đúng định dạng chuẩn. Yêu cầu và khóa gửi trùng được giữ nguyên để đối chiếu.",
    };
  }

  const parsed = extractRoleAccessError(payload);
  const directive = classifyRoleMutationFailure(status, parsed.code);

  if (status === 401 || parsed.code === "UNAUTHENTICATED") {
    return {
      kind: "session-lost",
      unauthenticated: true,
      preserveIdempotencyKey: false,
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }

  if (parsed.code === "CSRF_REJECTED") {
    return {
      kind: "csrf-rejected",
      preserveIdempotencyKey: false,
      lockForm: true,
      message: "Phiên trang không đáp ứng kiểm tra an toàn same-origin. Vui lòng tải lại trang rồi thao tác lại.",
    };
  }

  if (status === 403) {
    return {
      kind: "session-lost",
      unauthenticated: false,
      preserveIdempotencyKey: false,
      message:
        parsed.code === "ACTOR_NOT_AVAILABLE"
          ? "Tài khoản quản trị hiện tại không còn hiệu lực."
          : "Bạn không còn quyền Full Admin (BoD/Admin) để thay đổi vai trò.",
    };
  }

  if (
    parsed.code === "AUTHZ_CUTOVER_NOT_READY" ||
    (status === 404 && (parsed.code === "NOT_FOUND" || parsed.code === null))
  ) {
    const gateReason: RoleGateReason =
      parsed.code === "AUTHZ_CUTOVER_NOT_READY"
        ? "CUTOVER_NOT_READY"
        : "MUTATIONS_ENV_DISABLED";
    return {
      kind: "gate-closed",
      gateReason,
      preserveIdempotencyKey: false,
      lockForm: true,
      message:
        gateReason === "CUTOVER_NOT_READY"
          ? "Hệ thống phân quyền mới chưa mở cổng cutover trên cơ sở dữ liệu (AUTHZ_CUTOVER_NOT_READY). Chưa có thay đổi nào được ghi."
          : "Tính năng thay đổi vai trò toàn cục đang tắt theo cổng môi trường (AUTHZ_ROLE_MUTATIONS_ENABLED). Chưa có thay đổi nào được ghi.",
    };
  }

  if (directive.cannotRevokeReason === "PROTECTED_OWNER_ADMIN") {
    return {
      kind: "protected-assignment",
      cannotRevokeReason: "PROTECTED_OWNER_ADMIN",
      preserveIdempotencyKey: false,
      lockForm: true,
      message:
        "Phân công BoD/Admin gốc của Chủ sở hữu hệ thống (Owner) được bảo vệ cố định và không thể thu hồi.",
    };
  }

  if (directive.preserveIdempotencyKey) {
    return {
      kind: "uncertain",
      preserveIdempotencyKey: true,
      lockForm: true,
      message:
        "Chưa nhận được kết quả xác nhận từ máy chủ. Nội dung thao tác và khóa gửi trùng được giữ nguyên để thử gửi lại hoặc tải lại đối chiếu.",
    };
  }

  if (parsed.code === "VERSION_CONFLICT") {
    return {
      kind: "version-conflict",
      currentVersion: parsed.currentVersion,
      preserveIdempotencyKey: false,
      mustReloadAccount: true,
      message:
        "Dữ liệu tài khoản vừa thay đổi ở nơi khác trước khi lưu. Vui lòng tải lại bản mới nhất từ máy chủ để đối chiếu.",
    };
  }

  if (
    status === 404 &&
    (parsed.code === "ACCOUNT_NOT_FOUND" || parsed.code === "ROLE_ASSIGNMENT_NOT_FOUND")
  ) {
    return {
      kind: "not-found",
      code: parsed.code,
      preserveIdempotencyKey: false,
      mustReloadAccount: true,
      message:
        parsed.code === "ROLE_ASSIGNMENT_NOT_FOUND"
          ? "Phân công vai trò không còn tồn tại hoặc không thuộc tài khoản này. Vui lòng tải lại dữ liệu."
          : "Không tìm thấy tài khoản mục tiêu trên máy chủ.",
    };
  }

  if (status === 409) {
    const businessMessages: Record<string, string> = {
      ACCOUNT_DISABLED: "Tài khoản đang bị vô hiệu hóa nên không thể cấp thêm vai trò toàn cục mới.",
      ROLE_ALREADY_ASSIGNED: "Tài khoản đã đang được phân công vai trò toàn cục này.",
      ROLE_ASSIGNMENT_ALREADY_ENDED: "Phân công vai trò này đã được thu hồi trước đó.",
      IDEMPOTENCY_CONFLICT:
        "Khóa chống gửi trùng đã dùng cho một thao tác khác. Vui lòng tải lại dữ liệu và thực hiện lại.",
    };
    return {
      kind: "business-conflict",
      code: parsed.code,
      preserveIdempotencyKey: false,
      mustReloadAccount:
        parsed.code === "ROLE_ALREADY_ASSIGNED" ||
        parsed.code === "ROLE_ASSIGNMENT_ALREADY_ENDED" ||
        parsed.code === "IDEMPOTENCY_CONFLICT",
      message:
        (parsed.code && businessMessages[parsed.code]) ??
        parsed.message ??
        "Thao tác không thể thực hiện do xung đột trạng thái dữ liệu.",
    };
  }

  return {
    kind: "validation-error",
    code: parsed.code,
    preserveIdempotencyKey: false,
    lockForm: false,
    message:
      parsed.code === "AUTHORITY_FIELD_FORBIDDEN"
        ? "Payload chứa trường thẩm quyền không được phép gửi từ trình duyệt."
        : status === 413 || parsed.code === "PAYLOAD_TOO_LARGE"
          ? "Nội dung gửi lên vượt quá giới hạn kích thước cho phép."
          : parsed.message ?? "Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
  };
}

export function isStaleMutationReplay(
  mutationAccountVersion: number,
  currentKnownVersion: number,
): boolean {
  return mutationAccountVersion < currentKnownVersion;
}
