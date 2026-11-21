import { CAPABILITIES, type Capability } from "../auth/direct-entry-v2.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";

export { CAPABILITIES, type Capability };

export const PERMISSION_GROUP_MODULE_CODES = ["vendor_finance", "leave"] as const;
export type PermissionGroupModuleCode = (typeof PERMISSION_GROUP_MODULE_CODES)[number];

export const VENDOR_FINANCE_MODULE_ROLES = [
  "GLOBAL_VIEWER",
  "GLOBAL_RECONCILER",
  "CASH_HOLDER",
  "CASH_HOLDER_RECORD_BEHALF",
] as const;
export type VendorFinanceModuleRoleCode = (typeof VENDOR_FINANCE_MODULE_ROLES)[number];

export const LEAVE_MODULE_ROLES = [
  "HR_REPORT_VIEWER",
  "HR_LEAVE_OPERATOR",
  "LEAVE_ADMIN_BOD_APPROVER",
] as const;
export type LeaveModuleRoleCode = (typeof LEAVE_MODULE_ROLES)[number];

export type PermissionGroupModuleRole =
  | { module_code: "vendor_finance"; role_code: VendorFinanceModuleRoleCode }
  | { module_code: "leave"; role_code: LeaveModuleRoleCode };

export const DEPARTMENT_GROUP_ALLOWED_CAPABILITIES = [
  "entry_create",
  "entry_own",
  "submission_create",
  "document_upload",
  "document_view",
  "change_request_create",
  "employment_status.request",
  "recruiter_master_manage",
  "team_master_manage",
  "catalog_master_manage",
  "audit_view",
  "worker_edit_history_view",
  "report_form_manage",
  "report_assign",
  "report_review",
  "report_delegate",
  "vendor_finance_view",
  "duplicate_cccd_withdraw",
] as const satisfies readonly Capability[];

export const TEAM_GROUP_ALLOWED_CAPABILITIES = [
  "entry_team",
  "team_manager_assign",
  "change_review",
  "report_view",
  "report_analytics_view",
  "report_assign",
  "report_review",
  "report_delegate",
  "worker_edit_history_view",
  "entry_create",
  "entry_own",
  "submission_create",
  "document_upload",
  "document_view",
  "change_request_create",
  "employment_status.request",
] as const satisfies readonly Capability[];

export type CapabilityBusinessDescriptor = {
  capability: Capability;
  category: string;
  label: string;
  description: string;
};

export const CAPABILITY_BUSINESS_DESCRIPTORS: readonly CapabilityBusinessDescriptor[] = [
  { capability: "entry_create", category: "Tuyển dụng & Nhập liệu", label: "Tạo hồ sơ tuyển dụng", description: "Nhập mới thông tin ứng viên/NLĐ tuyển dụng." },
  { capability: "entry_own", category: "Tuyển dụng & Nhập liệu", label: "Xem & sửa bản nháp của mình", description: "Quản lý hồ sơ tuyển dụng do chính mình tạo." },
  { capability: "submission_create", category: "Tuyển dụng & Nhập liệu", label: "Nộp đợt nhập liệu", description: "Gửi hoàn tất đợt nhập liệu tuyển dụng." },
  { capability: "document_upload", category: "Chứng từ hồ sơ NLĐ", label: "Tải lên ảnh & CCCD", description: "Tải ảnh chân dung và chứng từ CCCD cho hồ sơ NLĐ." },
  { capability: "document_view", category: "Chứng từ hồ sơ NLĐ", label: "Xem & tải chứng từ hồ sơ", description: "Xem và tải xuống chứng từ hồ sơ NLĐ trong phạm vi được phép." },
  { capability: "change_request_create", category: "Yêu cầu thay đổi", label: "Đề xuất sửa hồ sơ", description: "Gửi yêu cầu điều chỉnh thông tin hồ sơ đã nộp." },
  { capability: "employment_status.request", category: "Trạng thái làm việc NLĐ", label: "Đề xuất cập nhật trạng thái NLĐ", description: "Đề xuất cập nhật trạng thái đi làm/nghỉ việc của NLĐ." },
  { capability: "entry_team", category: "Tổ đội Tuyển dụng", label: "Xem & theo dõi tuyển dụng của tổ", description: "Theo dõi hồ sơ tuyển dụng trong tổ đội được gắn." },
  { capability: "team_manager_assign", category: "Tổ đội Tuyển dụng", label: "Phân công nhân sự trong tổ", description: "Quản lý thành viên và phân công trong tổ đội." },
  { capability: "change_review", category: "Tổ đội Tuyển dụng", label: "Duyệt yêu cầu sửa hồ sơ của tổ", description: "Phê duyệt hoặc từ chối yêu cầu thay đổi hồ sơ trong tổ." },
  { capability: "recruiter_master_manage", category: "Danh mục vận hành", label: "Quản lý danh mục nhân sự tuyển dụng", description: "Tạo và cập nhật hồ sơ tính công nhân sự tuyển dụng." },
  { capability: "team_master_manage", category: "Danh mục vận hành", label: "Quản lý danh mục tổ đội", description: "Tạo và cập nhật danh mục tổ đội tuyển dụng." },
  { capability: "catalog_master_manage", category: "Danh mục vận hành", label: "Quản lý danh mục dự án, NCC & địa bàn", description: "Cập nhật danh mục dự án, nhà cung cấp, loại hình lao động, tỉnh/KCN." },
  { capability: "worker_edit_history_view", category: "Hồ sơ NLĐ", label: "Xem lịch sử chỉnh sửa NLĐ", description: "Tra cứu lịch sử thay đổi thông tin hồ sơ NLĐ." },
  { capability: "duplicate_cccd_withdraw", category: "Kiểm soát CCCD", label: "Rút hồ sơ trùng CCCD", description: "Rút các bản ghi tuyển dụng bị trùng số CCCD." },
  { capability: "audit_view", category: "Kiểm soát", label: "Xem nhật ký hệ thống", description: "Theo dõi nhật ký hoạt động và thay đổi dữ liệu." },
  { capability: "report_form_manage", category: "Báo cáo công việc", label: "Quản lý mẫu báo cáo công việc", description: "Tạo, chỉnh sửa và phát hành biểu mẫu báo cáo công việc." },
  { capability: "report_assign", category: "Báo cáo công việc", label: "Giao đợt báo cáo công việc", description: "Thiết lập và giao kỳ báo cáo công việc cho nhân sự." },
  { capability: "report_review", category: "Báo cáo công việc", label: "Xem & duyệt bài nộp báo cáo", description: "Kiểm tra, nhận xét và duyệt báo cáo công việc đã nộp." },
  { capability: "report_delegate", category: "Báo cáo công việc", label: "Ủy quyền duyệt báo cáo", description: "Ủy quyền xem và duyệt báo cáo công việc khi cần." },
  { capability: "report_view", category: "Báo cáo & Thống kê", label: "Xem báo cáo tổng quan", description: "Xem bảng tổng hợp tiến độ và báo cáo theo phạm vi nhóm." },
  { capability: "report_analytics_view", category: "Báo cáo & Thống kê", label: "Xem phân tích số liệu", description: "Xem biểu đồ và báo cáo phân tích theo phạm vi nhóm." },
  { capability: "vendor_finance_view", category: "Tài chính NCC", label: "Xem công nợ nhà cung cấp", description: "Xem sổ công nợ và báo cáo tài chính nhà cung cấp." },
  { capability: "vendor_finance_record", category: "Tài chính NCC", label: "Ghi nhận thu chi nhà cung cấp", description: "Tạo chứng từ thu chi và đối soát tài chính nhà cung cấp." },
  { capability: "entry_admin", category: "Quản trị hệ thống", label: "Quản trị người dùng & hệ thống", description: "Quản trị người dùng, phòng ban, nhóm quyền (chỉ nhóm BoD/Admin)." },
  { capability: "entry_privileged_edit", category: "Quản trị hệ thống", label: "Sửa trực tiếp hồ sơ đã nộp", description: "Chỉnh sửa trực tiếp hồ sơ tuyển dụng đã nộp (chỉ nhóm BoD/Admin)." },
  { capability: "entry_restore", category: "Quản trị hệ thống", label: "Khôi phục hồ sơ đã ẩn", description: "Khôi phục bản ghi tuyển dụng đã ẩn (chỉ nhóm BoD/Admin)." },
  { capability: "employment_status.review", category: "Quản trị hệ thống", label: "Xem xét trạng thái làm việc NLĐ", description: "Rà soát đề xuất thay đổi trạng thái làm việc (chỉ nhóm BoD/Admin)." },
  { capability: "employment_status.apply", category: "Quản trị hệ thống", label: "Áp dụng trạng thái làm việc NLĐ", description: "Cập nhật trực tiếp trạng thái làm việc NLĐ (chỉ nhóm BoD/Admin)." },
];

export type ModuleRoleBusinessDescriptor = {
  module_code: PermissionGroupModuleCode;
  role_code: VendorFinanceModuleRoleCode | LeaveModuleRoleCode;
  category: string;
  label: string;
  description: string;
};

export const MODULE_ROLE_BUSINESS_DESCRIPTORS: readonly ModuleRoleBusinessDescriptor[] = [
  {
    module_code: "vendor_finance",
    role_code: "GLOBAL_VIEWER",
    category: "Tài chính NCC (Toàn công ty)",
    label: "Xem Tài chính NCC toàn công ty",
    description: "Xem sổ công nợ, tạm ứng và báo cáo nhà cung cấp trên toàn bộ dự án.",
  },
  {
    module_code: "vendor_finance",
    role_code: "GLOBAL_RECONCILER",
    category: "Tài chính NCC (Toàn công ty)",
    label: "Đối soát Tài chính NCC toàn công ty",
    description: "Xem và thực hiện đối soát công nợ nhà cung cấp trên toàn bộ dự án.",
  },
  {
    module_code: "vendor_finance",
    role_code: "CASH_HOLDER",
    category: "Tài chính NCC (Toàn công ty)",
    label: "Thủ quỹ Tài chính NCC",
    description: "Đối soát toàn công ty, cấp vốn và ghi nhận hoàn ứng nhà cung cấp.",
  },
  {
    module_code: "vendor_finance",
    role_code: "CASH_HOLDER_RECORD_BEHALF",
    category: "Tài chính NCC (Toàn công ty)",
    label: "Thủ quỹ & ghi nhận hộ Tài chính NCC",
    description: "Toàn quyền thủ quỹ kèm ghi nhận thu chi hộ trên toàn bộ dự án.",
  },
  {
    module_code: "leave",
    role_code: "HR_REPORT_VIEWER",
    category: "Nghỉ phép (Toàn công ty)",
    label: "Xem báo cáo nghỉ phép toàn công ty",
    description: "Xem báo cáo tổng hợp ngày phép tháng của toàn công ty.",
  },
  {
    module_code: "leave",
    role_code: "HR_LEAVE_OPERATOR",
    category: "Nghỉ phép (Toàn công ty)",
    label: "Vận hành phép năm & hồ sơ nghỉ phép",
    description: "Quản lý số dư phép đầu kỳ, hồ sơ phép và báo cáo nghỉ phép toàn công ty.",
  },
  {
    module_code: "leave",
    role_code: "LEAVE_ADMIN_BOD_APPROVER",
    category: "Nghỉ phép (Toàn công ty)",
    label: "Duyệt đơn nghỉ phép cấp Ban Giám đốc",
    description: "Phê duyệt hoặc từ chối đơn nghỉ phép và giải trình ở cấp Ban Giám đốc.",
  },
];

export const PERMISSION_GROUP_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "FORBIDDEN",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "INVALID_JSON",
  "BODY_TOO_LARGE",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "AUTHZ_VALIDATION_ERROR",
  "AUTHZ_REASON_INVALID",
  "AUTHZ_CUTOVER_NOT_READY",
  "GROUP_CODE_INVALID",
  "GROUP_NAME_INVALID",
  "GROUP_DESCRIPTION_INVALID",
  "GROUP_DEPARTMENT_REQUIRED",
  "GROUP_MODULE_ROLES_INVALID",
  "GROUP_CAPABILITY_FORBIDDEN_FOR_SYSTEM_ADMIN",
  "GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP",
  "GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP",
  "GROUP_MODULE_ROLE_FORBIDDEN_FOR_SYSTEM_ADMIN",
  "GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP",
  "GROUP_TEAM_REQUIRES_RECRUITMENT_DEPARTMENT",
  "DEPARTMENT_NOT_FOUND",
  "TEAM_NOT_FOUND",
  "GROUP_NOT_FOUND",
  "GROUP_MEMBERSHIP_NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "GROUP_CODE_CONFLICT",
  "GROUP_SYSTEM_ADMIN_IMMUTABLE",
  "GROUP_INACTIVE",
  "GROUP_MEMBER_ALREADY_ASSIGNED",
  "GROUP_MEMBERSHIP_ALREADY_ENDED",
  "AUTHZ_PROTECTED_ASSIGNMENT",
  "ACCOUNT_DISABLED",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "AUTHZ_UNAVAILABLE",
] as const;

export type PermissionGroupErrorCode = (typeof PERMISSION_GROUP_ERROR_CODES)[number];

export function permissionGroupErrorStatus(code: PermissionGroupErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "FORBIDDEN":
    case "CSRF_REJECTED":
      return 403;
    case "GROUP_NOT_FOUND":
    case "GROUP_MEMBERSHIP_NOT_FOUND":
    case "ACCOUNT_NOT_FOUND":
      return 404;
    case "AUTHZ_CUTOVER_NOT_READY":
    case "GROUP_CODE_CONFLICT":
    case "GROUP_SYSTEM_ADMIN_IMMUTABLE":
    case "GROUP_INACTIVE":
    case "GROUP_MEMBER_ALREADY_ASSIGNED":
    case "GROUP_MEMBERSHIP_ALREADY_ENDED":
    case "AUTHZ_PROTECTED_ASSIGNMENT":
    case "ACCOUNT_DISABLED":
    case "VERSION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return 409;
    case "BODY_TOO_LARGE":
      return 413;
    case "AUTHZ_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

export type PermissionGroupSummary = {
  group_id: string;
  code: string;
  name: string;
  description: string;
  department_id: string;
  department_code: string;
  department_name: string;
  department_system_key: string | null;
  team_id: string | null;
  team_code: string | null;
  team_name: string | null;
  is_system_admin: boolean;
  active: boolean;
  version: number;
  capabilities: Capability[];
  module_roles: PermissionGroupModuleRole[];
  member_count: number;
  member_account_refs: string[];
  updated_at: string;
};

export type ListPermissionGroupsResponse = {
  as_of: string;
  groups: PermissionGroupSummary[];
};

export type PermissionGroupMutationResult = {
  group_id: string;
  code: string;
  name: string;
  description: string;
  department_id: string;
  team_id: string | null;
  is_system_admin: boolean;
  active: boolean;
  version: number;
  capabilities: Capability[];
  module_roles: PermissionGroupModuleRole[];
  replayed: boolean;
};

export type GroupMemberAssignResult = {
  membership_id: string;
  group_id: string;
  group_code: string;
  group_name: string;
  account_ref: string;
  account_version: number;
  is_protected: boolean;
  started_at: string;
  replayed: boolean;
};

export type GroupMemberRemoveResult = {
  membership_id: string;
  group_id: string;
  group_code: string;
  group_name: string;
  account_ref: string;
  account_version: number;
  ended_at: string;
  replayed: boolean;
};

export type AccountGroupMembershipItem = {
  membership_id: string;
  group_id: string;
  group_code: string;
  group_name: string;
  group_description: string;
  department_id: string;
  department_name: string;
  team_id: string | null;
  team_name: string | null;
  is_system_admin: boolean;
  group_active: boolean;
  is_protected: boolean;
  can_remove: boolean;
  cannot_remove_reason: "PROTECTED_OWNER_ADMIN" | null;
  started_at: string;
  capabilities: Capability[];
  module_roles: PermissionGroupModuleRole[];
};

export type AccountResourceAssignmentItem = {
  assignment_kind: "TEAM_LEADER" | "PROJECT_MANAGER" | "PROJECT_ACCOUNTANT" | "DEPARTMENT_HEAD";
  resource_ref: string;
  resource_label: string;
};

export type AccountGroupsResponse = {
  as_of: string;
  account_ref: string;
  account_version: number;
  enabled: boolean;
  memberships: AccountGroupMembershipItem[];
  resource_assignments: AccountResourceAssignmentItem[];
};

const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const VFIN_ROLE_SET = new Set<string>(VENDOR_FINANCE_MODULE_ROLES);
const LEAVE_ROLE_SET = new Set<string>(LEAVE_MODULE_ROLES);
const FORBIDDEN_CLIENT_KEYS = new Set([
  "actor_id",
  "actor_app_user_id",
  "auth_subject",
  "app_user_id",
  "is_protected",
  "protected_reason",
  "is_system_admin",
  "scope_kind",
  "scope_template",
  "assignment_mode",
  "project_id",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenKey(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_CLIENT_KEYS.has(key)) return true;
  }
  return false;
}

function parseOptionalReason(value: unknown): { ok: true; value: string | null } | { ok: false; code: PermissionGroupErrorCode } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, code: "AUTHZ_REASON_INVALID" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length < 3 || trimmed.length > 500) return { ok: false, code: "AUTHZ_REASON_INVALID" };
  return { ok: true, value: trimmed };
}

function parseCapabilitiesArray(value: unknown): { ok: true; value: Capability[] } | { ok: false; code: PermissionGroupErrorCode } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  const dedup = new Set<Capability>();
  for (const item of value) {
    if (typeof item !== "string" || !CAPABILITY_SET.has(item)) {
      return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
    }
    dedup.add(item as Capability);
  }
  return { ok: true, value: [...dedup].sort() };
}

function parseModuleRolesArray(value: unknown): { ok: true; value: PermissionGroupModuleRole[] } | { ok: false; code: PermissionGroupErrorCode } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, code: "GROUP_MODULE_ROLES_INVALID" };
  const seen = new Set<string>();
  const out: PermissionGroupModuleRole[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { ok: false, code: "GROUP_MODULE_ROLES_INVALID" };
    const keys = Object.keys(item);
    if (keys.length !== 2 || !("module_code" in item) || !("role_code" in item)) {
      return { ok: false, code: "GROUP_MODULE_ROLES_INVALID" };
    }
    const mod = item.module_code;
    const role = item.role_code;
    if (mod === "vendor_finance" && typeof role === "string" && VFIN_ROLE_SET.has(role)) {
      const k = `${mod}:${role}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ module_code: "vendor_finance", role_code: role as VendorFinanceModuleRoleCode });
      }
    } else if (mod === "leave" && typeof role === "string" && LEAVE_ROLE_SET.has(role)) {
      const k = `${mod}:${role}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ module_code: "leave", role_code: role as LeaveModuleRoleCode });
      }
    } else {
      return { ok: false, code: "GROUP_MODULE_ROLES_INVALID" };
    }
  }
  out.sort((a, b) => `${a.module_code}:${a.role_code}`.localeCompare(`${b.module_code}:${b.role_code}`));
  return { ok: true, value: out };
}

export type ParsedListGroupsQuery = {
  department_id: string | null;
  include_inactive: boolean;
};

export function parseListGroupsQuery(
  searchParams: URLSearchParams,
): { ok: true; value: ParsedListGroupsQuery } | { ok: false; code: PermissionGroupErrorCode } {
  const allowed = new Set(["department_id", "include_inactive"]);
  for (const key of searchParams.keys()) {
    if (FORBIDDEN_CLIENT_KEYS.has(key)) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
    if (!allowed.has(key)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
    if (searchParams.getAll(key).length > 1) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  const rawDept = searchParams.get("department_id");
  let department_id: string | null = null;
  if (rawDept !== null && rawDept.trim() !== "") {
    if (!isUuid(rawDept.trim())) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
    department_id = rawDept.trim().toLowerCase();
  }
  const rawInc = searchParams.get("include_inactive");
  let include_inactive = false;
  if (rawInc !== null) {
    if (rawInc === "true") include_inactive = true;
    else if (rawInc === "false") include_inactive = false;
    else return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  return { ok: true, value: { department_id, include_inactive } };
}

export type ParsedCreateGroupBody = {
  code: string;
  name: string;
  description: string;
  department_id: string;
  team_id: string | null;
  capabilities: Capability[];
  module_roles: PermissionGroupModuleRole[];
  reason: string | null;
};

export function parseCreateGroupBody(
  body: unknown,
): { ok: true; value: ParsedCreateGroupBody } | { ok: false; code: PermissionGroupErrorCode } {
  if (!isPlainObject(body)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  if (hasForbiddenKey(body)) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  const allowed = new Set(["code", "name", "description", "department_id", "team_id", "capabilities", "module_roles", "reason"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (typeof body.code !== "string") return { ok: false, code: "GROUP_CODE_INVALID" };
  const code = body.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code) || code === "SYSTEM_ADMIN") {
    return { ok: false, code: "GROUP_CODE_INVALID" };
  }
  if (typeof body.name !== "string") return { ok: false, code: "GROUP_NAME_INVALID" };
  const name = body.name.trim();
  if (name.length < 2 || name.length > 128) return { ok: false, code: "GROUP_NAME_INVALID" };
  const description = typeof body.description === "string" ? body.description.trim() : body.description === undefined || body.description === null ? "" : null;
  if (description === null || description.length > 500) return { ok: false, code: "GROUP_DESCRIPTION_INVALID" };
  if (typeof body.department_id !== "string" || !isUuid(body.department_id.trim())) {
    return { ok: false, code: "GROUP_DEPARTMENT_REQUIRED" };
  }
  const department_id = body.department_id.trim().toLowerCase();
  let team_id: string | null = null;
  if (body.team_id !== undefined && body.team_id !== null && body.team_id !== "") {
    if (typeof body.team_id !== "string" || !isUuid(body.team_id.trim())) {
      return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
    }
    team_id = body.team_id.trim().toLowerCase();
  }
  const caps = parseCapabilitiesArray(body.capabilities);
  if (!caps.ok) return caps;
  const modRoles = parseModuleRolesArray(body.module_roles);
  if (!modRoles.ok) return modRoles;
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: {
      code,
      name,
      description,
      department_id,
      team_id,
      capabilities: caps.value,
      module_roles: modRoles.value,
      reason: reason.value,
    },
  };
}

export type ParsedUpdateGroupBody = {
  expected_version: number;
  name: string;
  description: string;
  department_id: string;
  team_id: string | null;
  active: boolean;
  capabilities: Capability[];
  module_roles: PermissionGroupModuleRole[];
  reason: string | null;
};

export function parseUpdateGroupBody(
  body: unknown,
): { ok: true; value: ParsedUpdateGroupBody } | { ok: false; code: PermissionGroupErrorCode } {
  if (!isPlainObject(body)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  if (hasForbiddenKey(body)) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  const allowed = new Set(["expected_version", "name", "description", "department_id", "team_id", "active", "capabilities", "module_roles", "reason"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (typeof body.expected_version !== "number" || !Number.isInteger(body.expected_version) || body.expected_version < 1) {
    return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (typeof body.name !== "string") return { ok: false, code: "GROUP_NAME_INVALID" };
  const name = body.name.trim();
  if (name.length < 2 || name.length > 128) return { ok: false, code: "GROUP_NAME_INVALID" };
  const description = typeof body.description === "string" ? body.description.trim() : body.description === undefined || body.description === null ? "" : null;
  if (description === null || description.length > 500) return { ok: false, code: "GROUP_DESCRIPTION_INVALID" };
  if (typeof body.department_id !== "string" || !isUuid(body.department_id.trim())) {
    return { ok: false, code: "GROUP_DEPARTMENT_REQUIRED" };
  }
  const department_id = body.department_id.trim().toLowerCase();
  let team_id: string | null = null;
  if (body.team_id !== undefined && body.team_id !== null && body.team_id !== "") {
    if (typeof body.team_id !== "string" || !isUuid(body.team_id.trim())) {
      return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
    }
    team_id = body.team_id.trim().toLowerCase();
  }
  if (typeof body.active !== "boolean") return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  const caps = parseCapabilitiesArray(body.capabilities);
  if (!caps.ok) return caps;
  const modRoles = parseModuleRolesArray(body.module_roles);
  if (!modRoles.ok) return modRoles;
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: {
      expected_version: body.expected_version,
      name,
      description,
      department_id,
      team_id,
      active: body.active,
      capabilities: caps.value,
      module_roles: modRoles.value,
      reason: reason.value,
    },
  };
}

export type ParsedAssignGroupMemberBody = {
  group_id: string;
  expected_account_version: number;
  reason: string | null;
};

export function parseAssignGroupMemberBody(
  body: unknown,
): { ok: true; value: ParsedAssignGroupMemberBody } | { ok: false; code: PermissionGroupErrorCode } {
  if (!isPlainObject(body)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  if (hasForbiddenKey(body)) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  const allowed = new Set(["group_id", "expected_account_version", "reason"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (typeof body.group_id !== "string" || !isUuid(body.group_id.trim())) {
    return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (
    typeof body.expected_account_version !== "number" ||
    !Number.isInteger(body.expected_account_version) ||
    body.expected_account_version < 1
  ) {
    return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: {
      group_id: body.group_id.trim().toLowerCase(),
      expected_account_version: body.expected_account_version,
      reason: reason.value,
    },
  };
}

export type ParsedRemoveGroupMemberBody = {
  expected_account_version: number;
  reason: string | null;
};

export function parseRemoveGroupMemberBody(
  body: unknown,
): { ok: true; value: ParsedRemoveGroupMemberBody } | { ok: false; code: PermissionGroupErrorCode } {
  if (!isPlainObject(body)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  if (hasForbiddenKey(body)) return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  const allowed = new Set(["expected_account_version", "reason"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  if (
    typeof body.expected_account_version !== "number" ||
    !Number.isInteger(body.expected_account_version) ||
    body.expected_account_version < 1
  ) {
    return { ok: false, code: "AUTHZ_VALIDATION_ERROR" };
  }
  const reason = parseOptionalReason(body.reason);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: {
      expected_account_version: body.expected_account_version,
      reason: reason.value,
    },
  };
}

function projectModuleRoles(raw: unknown): PermissionGroupModuleRole[] | null {
  const parsed = parseModuleRolesArray(raw);
  return parsed.ok ? parsed.value : null;
}

function projectCapabilities(raw: unknown): Capability[] | null {
  const parsed = parseCapabilitiesArray(raw);
  return parsed.ok ? parsed.value : null;
}

export function projectListGroupsResponse(raw: unknown): ListPermissionGroupsResponse | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.as_of !== "string" || !Array.isArray(raw.groups)) return null;
  const groups: PermissionGroupSummary[] = [];
  for (const item of raw.groups) {
    if (!isPlainObject(item)) return null;
    if (
      typeof item.group_id !== "string" || !isUuid(item.group_id) ||
      typeof item.code !== "string" ||
      typeof item.name !== "string" ||
      typeof item.description !== "string" ||
      typeof item.department_id !== "string" || !isUuid(item.department_id) ||
      typeof item.department_code !== "string" ||
      typeof item.department_name !== "string" ||
      (item.department_system_key !== null && typeof item.department_system_key !== "string") ||
      (item.team_id !== null && (typeof item.team_id !== "string" || !isUuid(item.team_id))) ||
      (item.team_code !== null && typeof item.team_code !== "string") ||
      (item.team_name !== null && typeof item.team_name !== "string") ||
      typeof item.is_system_admin !== "boolean" ||
      typeof item.active !== "boolean" ||
      typeof item.version !== "number" || !Number.isInteger(item.version) ||
      typeof item.member_count !== "number" || !Number.isInteger(item.member_count) ||
      !Array.isArray(item.member_account_refs) ||
      typeof item.updated_at !== "string"
    ) {
      return null;
    }
    const capabilities = projectCapabilities(item.capabilities);
    const module_roles = projectModuleRoles(item.module_roles);
    if (!capabilities || !module_roles) return null;
    const member_account_refs: string[] = [];
    for (const ref of item.member_account_refs) {
      if (typeof ref !== "string" || !isUuid(ref)) return null;
      member_account_refs.push(ref.toLowerCase());
    }
    groups.push({
      group_id: item.group_id.toLowerCase(),
      code: item.code,
      name: item.name,
      description: item.description,
      department_id: item.department_id.toLowerCase(),
      department_code: item.department_code,
      department_name: item.department_name,
      department_system_key: item.department_system_key,
      team_id: item.team_id ? item.team_id.toLowerCase() : null,
      team_code: item.team_code,
      team_name: item.team_name,
      is_system_admin: item.is_system_admin,
      active: item.active,
      version: item.version,
      capabilities,
      module_roles,
      member_count: item.member_count,
      member_account_refs,
      updated_at: item.updated_at,
    });
  }
  return { as_of: raw.as_of, groups };
}

export function projectGroupMutationResponse(raw: unknown): PermissionGroupMutationResult | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.group_id !== "string" || !isUuid(raw.group_id) ||
    typeof raw.code !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.department_id !== "string" || !isUuid(raw.department_id) ||
    (raw.team_id !== null && (typeof raw.team_id !== "string" || !isUuid(raw.team_id))) ||
    typeof raw.is_system_admin !== "boolean" ||
    typeof raw.active !== "boolean" ||
    typeof raw.version !== "number" || !Number.isInteger(raw.version) ||
    typeof raw.replayed !== "boolean"
  ) {
    return null;
  }
  const capabilities = projectCapabilities(raw.capabilities);
  const module_roles = projectModuleRoles(raw.module_roles);
  if (!capabilities || !module_roles) return null;
  return {
    group_id: raw.group_id.toLowerCase(),
    code: raw.code,
    name: raw.name,
    description: raw.description,
    department_id: raw.department_id.toLowerCase(),
    team_id: raw.team_id ? raw.team_id.toLowerCase() : null,
    is_system_admin: raw.is_system_admin,
    active: raw.active,
    version: raw.version,
    capabilities,
    module_roles,
    replayed: raw.replayed,
  };
}

export function projectGroupMemberAssignResponse(raw: unknown): GroupMemberAssignResult | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.membership_id !== "string" || !isUuid(raw.membership_id) ||
    typeof raw.group_id !== "string" || !isUuid(raw.group_id) ||
    typeof raw.group_code !== "string" ||
    typeof raw.group_name !== "string" ||
    typeof raw.account_ref !== "string" || !isUuid(raw.account_ref) ||
    typeof raw.account_version !== "number" || !Number.isInteger(raw.account_version) ||
    typeof raw.is_protected !== "boolean" ||
    typeof raw.started_at !== "string" ||
    typeof raw.replayed !== "boolean"
  ) {
    return null;
  }
  return {
    membership_id: raw.membership_id.toLowerCase(),
    group_id: raw.group_id.toLowerCase(),
    group_code: raw.group_code,
    group_name: raw.group_name,
    account_ref: raw.account_ref.toLowerCase(),
    account_version: raw.account_version,
    is_protected: raw.is_protected,
    started_at: raw.started_at,
    replayed: raw.replayed,
  };
}

export function projectGroupMemberRemoveResponse(raw: unknown): GroupMemberRemoveResult | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.membership_id !== "string" || !isUuid(raw.membership_id) ||
    typeof raw.group_id !== "string" || !isUuid(raw.group_id) ||
    typeof raw.group_code !== "string" ||
    typeof raw.group_name !== "string" ||
    typeof raw.account_ref !== "string" || !isUuid(raw.account_ref) ||
    typeof raw.account_version !== "number" || !Number.isInteger(raw.account_version) ||
    typeof raw.ended_at !== "string" ||
    typeof raw.replayed !== "boolean"
  ) {
    return null;
  }
  return {
    membership_id: raw.membership_id.toLowerCase(),
    group_id: raw.group_id.toLowerCase(),
    group_code: raw.group_code,
    group_name: raw.group_name,
    account_ref: raw.account_ref.toLowerCase(),
    account_version: raw.account_version,
    ended_at: raw.ended_at,
    replayed: raw.replayed,
  };
}

export function projectAccountGroupsResponse(raw: unknown): AccountGroupsResponse | null {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.as_of !== "string" ||
    typeof raw.account_ref !== "string" || !isUuid(raw.account_ref) ||
    typeof raw.account_version !== "number" || !Number.isInteger(raw.account_version) ||
    typeof raw.enabled !== "boolean" ||
    !Array.isArray(raw.memberships) ||
    !Array.isArray(raw.resource_assignments)
  ) {
    return null;
  }
  const memberships: AccountGroupMembershipItem[] = [];
  for (const m of raw.memberships) {
    if (!isPlainObject(m)) return null;
    if (
      typeof m.membership_id !== "string" || !isUuid(m.membership_id) ||
      typeof m.group_id !== "string" || !isUuid(m.group_id) ||
      typeof m.group_code !== "string" ||
      typeof m.group_name !== "string" ||
      typeof m.group_description !== "string" ||
      typeof m.department_id !== "string" || !isUuid(m.department_id) ||
      typeof m.department_name !== "string" ||
      (m.team_id !== null && (typeof m.team_id !== "string" || !isUuid(m.team_id))) ||
      (m.team_name !== null && typeof m.team_name !== "string") ||
      typeof m.is_system_admin !== "boolean" ||
      typeof m.group_active !== "boolean" ||
      typeof m.is_protected !== "boolean" ||
      typeof m.can_remove !== "boolean" ||
      (m.cannot_remove_reason !== null && m.cannot_remove_reason !== "PROTECTED_OWNER_ADMIN") ||
      typeof m.started_at !== "string"
    ) {
      return null;
    }
    const capabilities = projectCapabilities(m.capabilities);
    const module_roles = projectModuleRoles(m.module_roles);
    if (!capabilities || !module_roles) return null;
    memberships.push({
      membership_id: m.membership_id.toLowerCase(),
      group_id: m.group_id.toLowerCase(),
      group_code: m.group_code,
      group_name: m.group_name,
      group_description: m.group_description,
      department_id: m.department_id.toLowerCase(),
      department_name: m.department_name,
      team_id: m.team_id ? m.team_id.toLowerCase() : null,
      team_name: m.team_name,
      is_system_admin: m.is_system_admin,
      group_active: m.group_active,
      is_protected: m.is_protected,
      can_remove: m.can_remove,
      cannot_remove_reason: m.cannot_remove_reason,
      started_at: m.started_at,
      capabilities,
      module_roles,
    });
  }
  const validKinds = new Set(["TEAM_LEADER", "PROJECT_MANAGER", "PROJECT_ACCOUNTANT", "DEPARTMENT_HEAD"]);
  const resource_assignments: AccountResourceAssignmentItem[] = [];
  for (const r of raw.resource_assignments) {
    if (!isPlainObject(r)) return null;
    if (
      typeof r.assignment_kind !== "string" || !validKinds.has(r.assignment_kind) ||
      typeof r.resource_ref !== "string" ||
      typeof r.resource_label !== "string"
    ) {
      return null;
    }
    resource_assignments.push({
      assignment_kind: r.assignment_kind as AccountResourceAssignmentItem["assignment_kind"],
      resource_ref: r.resource_ref,
      resource_label: r.resource_label,
    });
  }
  return {
    as_of: raw.as_of,
    account_ref: raw.account_ref.toLowerCase(),
    account_version: raw.account_version,
    enabled: raw.enabled,
    memberships,
    resource_assignments,
  };
}
