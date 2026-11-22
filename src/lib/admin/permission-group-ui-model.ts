/**
 * PR #28 — Pure, browser-safe UI model for Permission Groups administration
 * and per-account group membership management.
 *
 * Presents every capability and module role strictly in plain Vietnamese
 * business actions while preserving verbatim backend codes on the wire.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import {
  CAPABILITY_BUSINESS_DESCRIPTORS,
  DEPARTMENT_GROUP_ALLOWED_CAPABILITIES,
  MODULE_ROLE_BUSINESS_DESCRIPTORS,
  TEAM_GROUP_ALLOWED_CAPABILITIES,
  type AccountGroupMembershipItem,
  type AccountGroupsResponse,
  type AccountResourceAssignmentItem,
  type Capability,
  type CapabilityBusinessDescriptor,
  type GroupMemberAssignResult,
  type GroupMemberRemoveResult,
  type ListPermissionGroupsResponse,
  type ModuleRoleBusinessDescriptor,
  type PermissionGroupModuleRole,
  type PermissionGroupMutationResult,
  type PermissionGroupSummary,
} from "./permission-group-contract.ts";

export {
  CAPABILITY_BUSINESS_DESCRIPTORS,
  DEPARTMENT_GROUP_ALLOWED_CAPABILITIES,
  MODULE_ROLE_BUSINESS_DESCRIPTORS,
  TEAM_GROUP_ALLOWED_CAPABILITIES,
  type AccountGroupMembershipItem,
  type AccountGroupsResponse,
  type AccountResourceAssignmentItem,
  type Capability,
  type CapabilityBusinessDescriptor,
  type GroupMemberAssignResult,
  type GroupMemberRemoveResult,
  type ListPermissionGroupsResponse,
  type ModuleRoleBusinessDescriptor,
  type PermissionGroupModuleRole,
  type PermissionGroupMutationResult,
  type PermissionGroupSummary,
};

const CAPABILITY_DESCRIPTOR_MAP = new Map<Capability, CapabilityBusinessDescriptor>(
  CAPABILITY_BUSINESS_DESCRIPTORS.map((item) => [item.capability, item]),
);

const MODULE_ROLE_DESCRIPTOR_MAP = new Map<string, ModuleRoleBusinessDescriptor>(
  MODULE_ROLE_BUSINESS_DESCRIPTORS.map((item) => [`${item.module_code}:${item.role_code}`, item]),
);

const RECRUITMENT_TRIGGER_CAPABILITIES = new Set<Capability>([
  "entry_create",
  "entry_own",
  "entry_team",
  "submission_create",
]);

export function newGroupMutationIdempotencyKey(): string {
  return newIdempotencyKey();
}

export function getCapabilityBusinessDescriptor(
  capability: Capability,
): CapabilityBusinessDescriptor {
  return (
    CAPABILITY_DESCRIPTOR_MAP.get(capability) ?? {
      capability,
      category: "Khác",
      label: "Quyền nghiệp vụ",
      description: "Thao tác nghiệp vụ theo cấu hình nhóm quyền.",
    }
  );
}

export function getModuleRoleBusinessDescriptor(
  role: PermissionGroupModuleRole,
): ModuleRoleBusinessDescriptor {
  const key = `${role.module_code}:${role.role_code}`;
  return (
    MODULE_ROLE_DESCRIPTOR_MAP.get(key) ?? {
      module_code: role.module_code,
      role_code: role.role_code,
      category: "Phân hệ nghiệp vụ",
      label: "Quyền phân hệ",
      description: "Quyền thao tác toàn công ty theo phân hệ.",
    }
  );
}

export function isRecruitmentOperationalGroup(group: {
  department_system_key?: string | null;
  team_id: string | null;
  is_system_admin: boolean;
  capabilities: readonly Capability[];
}): boolean {
  if (group.is_system_admin) return false;
  if (group.team_id !== null) return true;
  if (group.department_system_key === "RECRUITMENT") return true;
  return group.capabilities.some((cap) => RECRUITMENT_TRIGGER_CAPABILITIES.has(cap));
}

export function summarizeGroupBusinessActions(group: {
  is_system_admin: boolean;
  capabilities: readonly Capability[];
  module_roles: readonly PermissionGroupModuleRole[];
}): string[] {
  if (group.is_system_admin) {
    return ["Toàn quyền quản trị hệ thống, người dùng, phòng ban và báo cáo"];
  }
  const labels: string[] = [];
  for (const cap of group.capabilities) {
    labels.push(getCapabilityBusinessDescriptor(cap).label);
  }
  for (const modRole of group.module_roles) {
    labels.push(getModuleRoleBusinessDescriptor(modRole).label);
  }
  return labels;
}

export function groupDescriptorsByCategory(
  allowedCapabilities: readonly Capability[],
): Array<{ category: string; items: CapabilityBusinessDescriptor[] }> {
  const allowedSet = new Set<Capability>(allowedCapabilities);
  const grouped = new Map<string, CapabilityBusinessDescriptor[]>();
  for (const descriptor of CAPABILITY_BUSINESS_DESCRIPTORS) {
    if (!allowedSet.has(descriptor.capability)) continue;
    const list = grouped.get(descriptor.category) ?? [];
    list.push(descriptor);
    grouped.set(descriptor.category, list);
  }
  return [...grouped.entries()].map(([category, items]) => ({ category, items }));
}

export function groupModuleRoleDescriptorsByCategory(): Array<{
  category: string;
  items: ModuleRoleBusinessDescriptor[];
}> {
  const grouped = new Map<string, ModuleRoleBusinessDescriptor[]>();
  for (const descriptor of MODULE_ROLE_BUSINESS_DESCRIPTORS) {
    const list = grouped.get(descriptor.category) ?? [];
    list.push(descriptor);
    grouped.set(descriptor.category, list);
  }
  return [...grouped.entries()].map(([category, items]) => ({ category, items }));
}

export function formatResourceAssignmentKindLabel(
  kind: AccountResourceAssignmentItem["assignment_kind"],
): { label: string; tone: BadgeTone } {
  switch (kind) {
    case "TEAM_LEADER":
      return { label: "Trưởng nhóm tuyển dụng", tone: "info" };
    case "PROJECT_MANAGER":
      return { label: "Quản lý dự án (PM)", tone: "primary" };
    case "PROJECT_ACCOUNTANT":
      return { label: "Kế toán dự án", tone: "info" };
    case "DEPARTMENT_HEAD":
      return { label: "Trưởng phòng ban", tone: "primary" };
    case "LEAVE_DEPARTMENT_APPROVER":
      return { label: "Người duyệt phép bộ phận", tone: "info" };
    case "WORK_REPORT_DELEGATE":
      return { label: "Ủy quyền duyệt báo cáo", tone: "neutral" };
  }
}

export function suggestGroupCodeFromName(name: string): string {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (normalized.length < 3) return "";
  return /^[A-Z]/.test(normalized) ? normalized : `GRP_${normalized}`.slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectPermissionGroupsEnvelope(
  payload: unknown,
): ListPermissionGroupsResponse | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  if (typeof payload.as_of !== "string" || !Array.isArray(payload.groups)) return null;
  return {
    as_of: payload.as_of,
    groups: payload.groups as PermissionGroupSummary[],
  };
}

export function projectAccountGroupsEnvelope(payload: unknown): AccountGroupsResponse | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  if (
    typeof payload.as_of !== "string" ||
    typeof payload.account_ref !== "string" ||
    !isUuid(payload.account_ref) ||
    typeof payload.account_version !== "number" ||
    typeof payload.enabled !== "boolean" ||
    !Array.isArray(payload.memberships) ||
    !Array.isArray(payload.resource_assignments)
  ) {
    return null;
  }
  return {
    as_of: payload.as_of,
    account_ref: payload.account_ref,
    account_version: payload.account_version,
    enabled: payload.enabled,
    memberships: payload.memberships as AccountGroupMembershipItem[],
    resource_assignments: payload.resource_assignments as AccountResourceAssignmentItem[],
  };
}

export type PermissionGroupReadFailure = {
  kind: "unauthenticated" | "denied" | "not-found" | "unavailable";
  message: string;
  retryable: boolean;
};

export function classifyPermissionGroupReadError(
  status: number,
  payload: unknown,
): PermissionGroupReadFailure {
  const serverMessage =
    isRecord(payload) && typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : null;
  if (status === 401) {
    return {
      kind: "unauthenticated",
      message: serverMessage ?? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      kind: "denied",
      message: serverMessage ?? "Bạn không có quyền quản trị nhóm quyền.",
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      message: serverMessage ?? "Không tìm thấy thông tin nhóm quyền hoặc tài khoản.",
      retryable: false,
    };
  }
  return {
    kind: "unavailable",
    message: serverMessage ?? "Không thể tải dữ liệu nhóm quyền lúc này. Vui lòng thử lại.",
    retryable: true,
  };
}

export type PermissionGroupMutationOutcome<T = unknown> =
  | { kind: "applied"; replayed: boolean; data: T }
  | { kind: "session-lost"; unauthenticated: boolean; message: string }
  | { kind: "conflict"; code: string; message: string; needsReload: boolean }
  | { kind: "protected"; message: string }
  | { kind: "account-disabled"; message: string }
  | { kind: "invalid"; code: string; message: string }
  | { kind: "uncertain"; message: string };

export function classifyPermissionGroupMutationResponse<T = unknown>(
  status: number,
  payload: unknown,
): PermissionGroupMutationOutcome<T> {
  const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "";
  const message =
    isRecord(payload) && typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : null;

  if (status === 200 || status === 201) {
    if (isRecord(payload) && payload.ok === true) {
      const nestedGroup = isRecord(payload.group) ? payload.group : null;
      const nestedMembership = isRecord(payload.membership) ? payload.membership : null;
      const replayed =
        payload.replayed === true ||
        nestedGroup?.replayed === true ||
        nestedMembership?.replayed === true;
      return {
        kind: "applied",
        replayed,
        data: payload as T,
      };
    }
    return {
      kind: "uncertain",
      message: "Phản hồi từ máy chủ không đầy đủ. Vui lòng kiểm tra lại trước khi thực hiện lại.",
    };
  }
  if (status === 401) {
    return {
      kind: "session-lost",
      unauthenticated: true,
      message: message ?? "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  if (status === 403) {
    return {
      kind: "session-lost",
      unauthenticated: false,
      message: message ?? "Bạn không có quyền thực hiện thao tác này.",
    };
  }
  if (status === 409) {
    if (code === "AUTHZ_PROTECTED_ASSIGNMENT") {
      return {
        kind: "protected",
        message: message ?? "Tài khoản chủ sở hữu được bảo vệ, không thể gỡ khỏi nhóm BoD/Admin.",
      };
    }
    if (code === "ACCOUNT_DISABLED") {
      return {
        kind: "account-disabled",
        message: message ?? "Tài khoản đang bị khóa đăng nhập nên chưa thể thêm vào nhóm quyền mới.",
      };
    }
    if (code === "VERSION_CONFLICT") {
      return {
        kind: "conflict",
        code,
        message:
          message ??
          "Dữ liệu vừa được quản trị viên khác cập nhật. Hãy tải lại dữ liệu mới nhất trước khi thử lại.",
        needsReload: true,
      };
    }
    return {
      kind: "conflict",
      code: code || "CONFLICT",
      message: message ?? "Thao tác không thể thực hiện do trùng lặp hoặc trạng thái đã thay đổi.",
      needsReload: code === "GROUP_MEMBER_ALREADY_ASSIGNED" || code === "GROUP_MEMBERSHIP_ALREADY_ENDED",
    };
  }
  if (status === 400 || status === 404) {
    return {
      kind: "invalid",
      code: code || "VALIDATION_ERROR",
      message: message ?? "Thông tin gửi lên chưa hợp lệ. Vui lòng kiểm tra lại.",
    };
  }
  return {
    kind: "uncertain",
    message:
      message ??
      "Không nhận được xác nhận từ máy chủ. Bạn có thể bấm thử lại để đồng bộ kết quả mà không bị trùng dữ liệu.",
  };
}
