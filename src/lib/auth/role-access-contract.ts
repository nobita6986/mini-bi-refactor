import { ACCOUNT_TYPES, type AccountType } from "../direct-entry/app-user-access-contract.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import {
  CAPABILITIES,
  validateClientBusinessPayload,
  type AuthzScopeKind,
  type Capability,
  type EffectiveGrantSourceType,
  type PairedEffectiveGrant,
} from "./direct-entry-v2.ts";

export {
  ACCOUNT_TYPES,
  CAPABILITIES,
  type AccountType,
  type AuthzScopeKind,
  type Capability,
  type EffectiveGrantSourceType,
  type PairedEffectiveGrant,
};

export const AUTHZ_GLOBAL_ROLE_CODES = [
  "EMPLOYEE_BASE",
  "RECRUITER",
  "HR_OPERATOR",
  "ADMIN",
] as const;

export const AUTHZ_CONTEXTUAL_ROLE_CODES = [
  "TEAM_LEADER",
  "DEPARTMENT_HEAD",
  "PROJECT_MANAGER",
  "PROJECT_ACCOUNTANT",
] as const;

export const AUTHZ_ROLE_CODES = [
  ...AUTHZ_GLOBAL_ROLE_CODES,
  ...AUTHZ_CONTEXTUAL_ROLE_CODES,
] as const;

export type GlobalRoleCode = (typeof AUTHZ_GLOBAL_ROLE_CODES)[number];
export type ContextualRoleCode = (typeof AUTHZ_CONTEXTUAL_ROLE_CODES)[number];
export type AuthzRoleCode = GlobalRoleCode | ContextualRoleCode;

export const AUTHZ_ASSIGNMENT_MODES = ["GLOBAL", "CONTEXTUAL"] as const;
export type AuthzAssignmentMode = (typeof AUTHZ_ASSIGNMENT_MODES)[number];

export const AUTHZ_FIXED_SCOPE_KINDS = [
  "none",
  "own",
  "all",
  "team",
  "department",
  "project",
] as const;
export type AuthzFixedScopeKind = (typeof AUTHZ_FIXED_SCOPE_KINDS)[number];

export const AUTHZ_SCOPE_KINDS = [
  "OWN",
  "ALL",
  "CONTEXT_TEAM",
  "CONTEXT_DEPARTMENT",
  "CONTEXT_PROJECT",
] as const satisfies readonly AuthzScopeKind[];

export const AUTHZ_ROLE_SOURCE_KINDS = [
  "ADMIN_ASSIGNMENT",
  "PERSONNEL_LINK_AUTO",
  "BACKFILL_SNAPSHOT",
] as const;
export type AuthzRoleSourceKind = (typeof AUTHZ_ROLE_SOURCE_KINDS)[number];

export const AUTHZ_DIRECT_EXCEPTION_SOURCE_KINDS = [
  "EXCEPTION_GRANT",
  "BACKFILL_EXCEPTION",
] as const;
export type AuthzDirectExceptionSourceKind =
  (typeof AUTHZ_DIRECT_EXCEPTION_SOURCE_KINDS)[number];

export const CONTEXTUAL_TARGET_KINDS = ["TEAM", "DEPARTMENT", "PROJECT"] as const;
export type ContextualTargetKind = (typeof CONTEXTUAL_TARGET_KINDS)[number];

export type CannotRevokeReason = "PROTECTED_OWNER_ADMIN";

export const ASSIGNMENT_INACTIVE_REASONS = [
  "ACCOUNT_DISABLED",
  "PERSON_INACTIVE",
  "TEAM_INACTIVE",
  "DEPARTMENT_INACTIVE",
  "PROJECT_INACTIVE",
  "RECRUITER_INACTIVE",
  "REVOKED",
] as const;
export type AssignmentInactiveReason = (typeof ASSIGNMENT_INACTIVE_REASONS)[number];

export type AccountBlockingReason =
  | "ACCOUNT_DISABLED"
  | "PERSON_INACTIVE"
  | "TEAM_INACTIVE"
  | "DEPARTMENT_INACTIVE"
  | (string & {});

export const ADMIN_NON_AUTO_GRANT_TOKENS = [
  "catalog_master_manage",
  "team_manager_assign",
  "report_form_manage",
  "report_assign",
  "report_review",
  "report_delegate",
  "vendor_finance_view",
  "vendor_finance_record",
] as const satisfies readonly Capability[];

export type RoleCapabilityTemplate = {
  capability: Capability;
  scope_template: AuthzScopeKind;
  retired_compat: boolean;
};

export type RoleCatalogItem = {
  role_code: AuthzRoleCode;
  display_name: string;
  description: string;
  assignment_mode: AuthzAssignmentMode;
  fixed_scope_kind: AuthzFixedScopeKind;
  requires_active_person: boolean;
  is_assignable_global: boolean;
  sort_order: number;
  capabilities: RoleCapabilityTemplate[];
};

export type RolesCatalogEnvelope = {
  as_of: string;
  roles: RoleCatalogItem[];
};

export type AccountPersonSummary = {
  person_id: string;
  employee_code: string;
  full_name: string;
  status?: "ACTIVE" | "INACTIVE";
  department_id?: string | null;
  department_name?: string | null;
};

export type AccountSummaryGlobalRole = {
  assignment_id: string;
  role_code: GlobalRoleCode;
  display_name: string;
  is_effective: boolean;
  is_protected: boolean;
  can_revoke: boolean;
  cannot_revoke_reason: CannotRevokeReason | null;
};

export type AccountSummaryContextualRole = {
  role_code: ContextualRoleCode;
  display_name: string;
  target_kind: ContextualTargetKind;
  target_ref: string;
  target_label: string;
  is_effective: boolean;
};

export type AccountsSummaryItem = {
  account_ref: string;
  login_id: string | null;
  display_name: string | null;
  enabled: boolean;
  account_type: AccountType;
  authz_managed: boolean;
  version: number;
  person: AccountPersonSummary | null;
  global_roles: AccountSummaryGlobalRole[];
  contextual_roles: AccountSummaryContextualRole[];
  direct_exception_count: number;
  effective_grant_count: number;
  blocking_reasons: AccountBlockingReason[];
};

export type AccountsSummaryListResponse = {
  as_of: string;
  search: string | null;
  enabled: "all" | "true" | "false";
  role_code: AuthzRoleCode | null;
  page: number;
  page_size: number;
  total: number;
  accounts: AccountsSummaryItem[];
};

export type AccountAccessHeader = {
  account_ref: string;
  login_id: string | null;
  display_name: string | null;
  enabled: boolean;
  account_type: AccountType;
  authz_managed: boolean;
  version: number;
  person: AccountPersonSummary | null;
};

export type AssignedGlobalRoleItem = {
  assignment_id: string;
  role_code: GlobalRoleCode;
  display_name: string;
  source_kind: AuthzRoleSourceKind;
  reason: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  assigned_by_display: string | null;
  is_effective: boolean;
  inactive_reason: AssignmentInactiveReason | null;
  is_protected: boolean;
  can_revoke: boolean;
  cannot_revoke_reason: CannotRevokeReason | null;
};

export type DirectExceptionItem = {
  direct_grant_id: string;
  capability: Capability;
  scope_kind: AuthzScopeKind;
  scope_id: string | null;
  scope_label?: string | null;
  source_kind: AuthzDirectExceptionSourceKind;
  reason: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  granted_by_display: string | null;
  is_effective: boolean;
  inactive_reason: AssignmentInactiveReason | null;
};

export type ContextualAssignmentItem = {
  role_code: ContextualRoleCode;
  display_name: string;
  target_kind: ContextualTargetKind;
  target_ref: string;
  target_label: string;
  scope_kind?: "CONTEXT_TEAM" | "CONTEXT_DEPARTMENT" | "CONTEXT_PROJECT";
  scope_id?: string;
  assignment_id?: string | null;
  started_at?: string | null;
  is_effective: boolean;
  inactive_reason: AssignmentInactiveReason | null;
  derived_capabilities: Capability[];
  can_revoke?: false;
  cannot_revoke_reason?: string | null;
};

export type ModuleAuthorityItem = {
  module: string;
  authority_code: string;
  display_name: string;
  scope_kind: string;
  scope_ref: string | null;
  scope_label: string | null;
  is_effective: boolean;
  inactive_reason: AssignmentInactiveReason | null;
};

export type PairedEffectiveGrantItem = PairedEffectiveGrant & {
  scope_label?: string | null;
};

export type AccountAccessDetail = {
  as_of: string;
  account: AccountAccessHeader;
  blocking_reasons: AccountBlockingReason[];
  assigned_global_roles: AssignedGlobalRoleItem[];
  direct_exceptions: DirectExceptionItem[];
  contextual_assignments: ContextualAssignmentItem[];
  module_authorities: ModuleAuthorityItem[];
  effective_grants: PairedEffectiveGrantItem[];
};

export type RoleMutationResult = {
  replayed: boolean;
  account_ref: string;
  account_version: number;
  assignment: AssignedGlobalRoleItem;
};

export type AccountsSummaryQuery = {
  search: string | null;
  enabled: "all" | "true" | "false";
  role_code: AuthzRoleCode | null;
  page: number;
  page_size: number;
};

export type AssignGlobalRoleInput = {
  role_code: GlobalRoleCode;
  expected_version: number;
  reason: string;
  idempotency_key: string;
};

export type RevokeGlobalRoleInput = {
  expected_version: number;
  reason: string;
  idempotency_key: string;
};

export const ROLE_ACCESS_VALIDATION_ERROR_CODES = [
  "AUTHZ_VALIDATION_ERROR",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_MISMATCH",
  "AUTHORITY_FIELD_FORBIDDEN",
] as const;

export type RoleAccessValidationErrorCode =
  (typeof ROLE_ACCESS_VALIDATION_ERROR_CODES)[number];

export const ROLE_ACCESS_ERROR_CODES = [
  ...ROLE_ACCESS_VALIDATION_ERROR_CODES,
  "UNAUTHENTICATED",
  "AUTHZ_FORBIDDEN",
  "CSRF_REJECTED",
  "ACTOR_NOT_AVAILABLE",
  "NOT_FOUND",
  "ACCOUNT_NOT_FOUND",
  "ROLE_ASSIGNMENT_NOT_FOUND",
  "AUTHZ_CUTOVER_NOT_READY",
  "AUTHZ_PROTECTED_ASSIGNMENT",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "ACCOUNT_DISABLED",
  "ROLE_ALREADY_ASSIGNED",
  "ROLE_ASSIGNMENT_ALREADY_ENDED",
  "ACCOUNT_TYPE_ROLE_FORBIDDEN",
  "PAYLOAD_TOO_LARGE",
  "AUTHZ_UNAVAILABLE",
] as const;

export type RoleAccessErrorCode = (typeof ROLE_ACCESS_ERROR_CODES)[number];

export class RoleAccessValidationError extends Error {
  readonly code: RoleAccessValidationErrorCode;
  readonly status = 400;

  constructor(code: RoleAccessValidationErrorCode, message: string) {
    super(message);
    this.name = "RoleAccessValidationError";
    this.code = code;
  }
}

export type RoleMutationRetryDirective = {
  preserveIdempotencyKey: boolean;
  lockForm: boolean;
  mustReloadAccount: boolean;
  cannotRevokeReason: CannotRevokeReason | null;
};

/** Classifies HTTP/network mutation failures for WP6 client retry/replay state machines. */
export function classifyRoleMutationFailure(
  status: number,
  code: string | null | undefined,
): RoleMutationRetryDirective {
  if (status === 0 || status >= 500 || code === "AUTHZ_UNAVAILABLE") {
    return {
      preserveIdempotencyKey: true,
      lockForm: true,
      mustReloadAccount: false,
      cannotRevokeReason: null,
    };
  }
  if (code === "AUTHZ_PROTECTED_ASSIGNMENT") {
    return {
      preserveIdempotencyKey: false,
      lockForm: true,
      mustReloadAccount: false,
      cannotRevokeReason: "PROTECTED_OWNER_ADMIN",
    };
  }
  if (code === "VERSION_CONFLICT") {
    return {
      preserveIdempotencyKey: false,
      lockForm: false,
      mustReloadAccount: true,
      cannotRevokeReason: null,
    };
  }
  return {
    preserveIdempotencyKey: false,
    lockForm: status === 403 || status === 404 || code === "AUTHZ_CUTOVER_NOT_READY",
    mustReloadAccount: status === 404 || status === 409,
    cannotRevokeReason: null,
  };
}

function capTemplate(
  capability: Capability,
  scope_template: AuthzScopeKind,
  retired_compat = false,
): RoleCapabilityTemplate {
  return Object.freeze({ capability, scope_template, retired_compat });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export const AUTHZ_CANONICAL_ROLE_CATALOG: readonly RoleCatalogItem[] = deepFreeze([
  {
    role_code: "EMPLOYEE_BASE",
    display_name: "Nhân viên cơ sở",
    description: "Vai trò nền toàn cục cho tài khoản nhân sự/kế toán, không tự cấp quyền Direct Entry.",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "none",
    requires_active_person: false,
    is_assignable_global: true,
    sort_order: 1,
    capabilities: [],
  },
  {
    role_code: "RECRUITER",
    display_name: "Tuyển dụng (Recruiter)",
    description: "Quyền nhập liệu, nộp hồ sơ và tải/xem tài liệu trong phạm vi dữ liệu tự tạo (OWN).",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "own",
    requires_active_person: false,
    is_assignable_global: true,
    sort_order: 2,
    capabilities: [
      capTemplate("entry_create", "OWN"),
      capTemplate("entry_own", "OWN"),
      capTemplate("submission_create", "OWN"),
      capTemplate("document_upload", "OWN"),
      capTemplate("document_view", "OWN"),
      capTemplate("change_request_create", "OWN", true),
      capTemplate("employment_status.request", "OWN", true),
    ],
  },
  {
    role_code: "HR_OPERATOR",
    display_name: "Vận hành nhân sự (HR Operator)",
    description: "Quản trị danh mục tuyển dụng, đội ngũ, nhân sự tuyển dụng, nhật ký kiểm toán và xem tài liệu.",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "all",
    requires_active_person: false,
    is_assignable_global: true,
    sort_order: 3,
    capabilities: [
      capTemplate("recruiter_master_manage", "ALL"),
      capTemplate("team_master_manage", "ALL"),
      capTemplate("catalog_master_manage", "ALL"),
      capTemplate("audit_view", "ALL"),
      capTemplate("document_view", "ALL"),
    ],
  },
  {
    role_code: "ADMIN",
    display_name: "BoD/Admin",
    description: "Vai trò điều hành/quản trị hợp nhất với bộ 21 quyền chuẩn (tách riêng 8 quyền chuyên trách ngoài gói tự cấp).",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "all",
    requires_active_person: false,
    is_assignable_global: true,
    sort_order: 4,
    capabilities: [
      capTemplate("entry_own", "OWN"),
      capTemplate("entry_admin", "ALL"),
      capTemplate("entry_team", "ALL"),
      capTemplate("entry_create", "ALL"),
      capTemplate("submission_create", "ALL"),
      capTemplate("entry_privileged_edit", "ALL"),
      capTemplate("entry_restore", "ALL"),
      capTemplate("recruiter_master_manage", "ALL"),
      capTemplate("team_master_manage", "ALL"),
      capTemplate("audit_view", "ALL"),
      capTemplate("worker_edit_history_view", "ALL"),
      capTemplate("document_upload", "ALL"),
      capTemplate("document_view", "ALL"),
      capTemplate("employment_status.review", "ALL"),
      capTemplate("employment_status.apply", "ALL"),
      capTemplate("change_request_create", "ALL", true),
      capTemplate("change_review", "ALL", true),
      capTemplate("employment_status.request", "ALL", true),
      capTemplate("duplicate_cccd_withdraw", "ALL"),
      capTemplate("report_view", "ALL"),
      capTemplate("report_analytics_view", "ALL"),
    ],
  },
  {
    role_code: "TEAM_LEADER",
    display_name: "Trưởng nhóm (Team Leader)",
    description: "Vai trò ngữ cảnh gắn với phân công Trưởng nhóm của đội đang hoạt động.",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "team",
    requires_active_person: false,
    is_assignable_global: false,
    sort_order: 5,
    capabilities: [
      capTemplate("entry_team", "CONTEXT_TEAM"),
      capTemplate("team_manager_assign", "CONTEXT_TEAM"),
      capTemplate("report_view", "CONTEXT_TEAM"),
      capTemplate("report_analytics_view", "CONTEXT_TEAM"),
      capTemplate("report_assign", "CONTEXT_TEAM"),
    ],
  },
  {
    role_code: "DEPARTMENT_HEAD",
    display_name: "Trưởng phòng ban",
    description: "Vai trò ngữ cảnh chỉ đọc từ bổ nhiệm Trưởng phòng ban (yêu cầu nhân sự ACTIVE).",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "department",
    requires_active_person: true,
    is_assignable_global: false,
    sort_order: 6,
    capabilities: [],
  },
  {
    role_code: "PROJECT_MANAGER",
    display_name: "Quản lý dự án (PM)",
    description: "Vai trò ngữ cảnh quản lý dự án đang mở (quyết định quyền tạo tin tuyển dụng theo dự án).",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "project",
    requires_active_person: false,
    is_assignable_global: false,
    sort_order: 7,
    capabilities: [],
  },
  {
    role_code: "PROJECT_ACCOUNTANT",
    display_name: "Kế toán dự án",
    description: "Vai trò ngữ cảnh kế toán theo từng dự án được phân công.",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "project",
    requires_active_person: false,
    is_assignable_global: false,
    sort_order: 8,
    capabilities: [capTemplate("vendor_finance_view", "CONTEXT_PROJECT")],
  },
]);

export const AUTHZ_CANONICAL_ROLE_MAP: Readonly<Record<AuthzRoleCode, RoleCatalogItem>> =
  Object.freeze(
    Object.fromEntries(
      AUTHZ_CANONICAL_ROLE_CATALOG.map((entry) => [entry.role_code, entry]),
    ) as Record<AuthzRoleCode, RoleCatalogItem>,
  );

function assertCanonicalRoleCatalogInvariants(): void {
  if (AUTHZ_CANONICAL_ROLE_CATALOG.length !== 8) {
    throw new Error("AUTHZ_CANONICAL_ROLE_CATALOG must define exactly 8 roles.");
  }
  const activeSet = new Set<string>(CAPABILITIES);
  const adminCaps = AUTHZ_CANONICAL_ROLE_MAP.ADMIN.capabilities.map((c) => c.capability);
  const adminSet = new Set<string>(adminCaps);
  const excludedSet = new Set<string>(ADMIN_NON_AUTO_GRANT_TOKENS);

  if (adminCaps.length !== 21 || adminSet.size !== 21) {
    throw new Error("ADMIN canonical bundle must define exactly 21 unique capabilities.");
  }
  if (ADMIN_NON_AUTO_GRANT_TOKENS.length !== 8 || excludedSet.size !== 8) {
    throw new Error("ADMIN_NON_AUTO_GRANT_TOKENS must define exactly 8 unique tokens.");
  }
  for (const excluded of excludedSet) {
    if (!activeSet.has(excluded) || adminSet.has(excluded)) {
      throw new Error(`Invalid ADMIN non-auto-grant partition at ${excluded}.`);
    }
  }
  for (const token of adminSet) {
    if (!activeSet.has(token)) {
      throw new Error(`Unknown ADMIN capability token: ${token}.`);
    }
  }
  if (adminSet.size + excludedSet.size !== activeSet.size) {
    throw new Error("ADMIN bundle + ADMIN_NON_AUTO_GRANT_TOKENS must partition CAPABILITIES.");
  }
}

assertCanonicalRoleCatalogInvariants();

const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;
const EMAIL_KEY_PATTERN = /email/i;
const LOGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_CODE_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const SEARCH_MAX_LENGTH = 256;
const REASON_MIN_LENGTH = 3;
const REASON_MAX_LENGTH = 500;
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_INSPECT_DEPTH = 16;

const GLOBAL_ROLE_SET = new Set<string>(AUTHZ_GLOBAL_ROLE_CODES);
const CONTEXTUAL_ROLE_SET = new Set<string>(AUTHZ_CONTEXTUAL_ROLE_CODES);
const ALL_ROLE_SET = new Set<string>(AUTHZ_ROLE_CODES);
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const SCOPE_KIND_SET = new Set<string>(AUTHZ_SCOPE_KINDS);
const ASSIGNMENT_MODE_SET = new Set<string>(AUTHZ_ASSIGNMENT_MODES);
const FIXED_SCOPE_KIND_SET = new Set<string>(AUTHZ_FIXED_SCOPE_KINDS);
const ROLE_SOURCE_KIND_SET = new Set<string>(AUTHZ_ROLE_SOURCE_KINDS);
const DIRECT_EXCEPTION_SOURCE_KIND_SET = new Set<string>(AUTHZ_DIRECT_EXCEPTION_SOURCE_KINDS);
const CONTEXTUAL_TARGET_KIND_SET = new Set<string>(CONTEXTUAL_TARGET_KINDS);
const INACTIVE_REASON_SET = new Set<string>(ASSIGNMENT_INACTIVE_REASONS);
const ACCOUNT_TYPE_SET = new Set<string>(ACCOUNT_TYPES);

const FORBIDDEN_AUTHORITY_EXACT_NORMALIZED = new Set<string>([
  "isprotected",
  "protectedreason",
  "canrevoke",
  "cannotrevokereason",
  "startedat",
  "endedat",
  "endedreason",
  "validfrom",
  "validto",
  "sourcekind",
  "authzmanaged",
  "cutoverready",
  "appuserid",
  "accountref",
  "effectivegrants",
  "assignedroles",
  "assignedglobalroles",
  "directexceptions",
  "contextualassignments",
  "moduleauthorities",
  "iseffective",
  "inactivereason",
  "permission",
  "permissions",
  "authority",
  "authorities",
]);

const FORBIDDEN_AUTHORITY_PREFIXES = [
  "actor",
  "assigned_by",
  "ended_by",
  "granted_by",
  "revoked_by",
] as const;

function toSnakeLower(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function isForbiddenAuthorityKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (FORBIDDEN_AUTHORITY_EXACT_NORMALIZED.has(normalized)) {
    return true;
  }
  const snake = toSnakeLower(key);
  for (const prefix of FORBIDDEN_AUTHORITY_PREFIXES) {
    if (snake === prefix || snake.startsWith(`${prefix}_`)) {
      return true;
    }
  }
  return !validateClientBusinessPayload(Object.fromEntries([[key, null]])).ok;
}

/**
 * Recursively walks arrays and plain objects up to bounded depth and returns the first
 * client-supplied authority/lifecycle key name if present, or `null` when clean.
 */
export function findForbiddenAuthorityField(value: unknown): string | null {
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): string | null {
    if (depth > MAX_INSPECT_DEPTH || node === null || typeof node !== "object") {
      return null;
    }
    if (seen.has(node)) {
      return null;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }

    for (const key of Object.keys(node)) {
      if (isForbiddenAuthorityKey(key)) {
        return key;
      }
      const hit = walk((node as Record<string, unknown>)[key], depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }

  return walk(value, 0);
}

/** Throws `RoleAccessValidationError("AUTHORITY_FIELD_FORBIDDEN")` on any forbidden authority field. */
export function assertNoForbiddenAuthorityFields(value: unknown): void {
  const forbidden = findForbiddenAuthorityField(value);
  if (forbidden !== null) {
    throw new RoleAccessValidationError(
      "AUTHORITY_FIELD_FORBIDDEN",
      `Trường thẩm quyền từ client bị từ chối: ${forbidden}.`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(obj: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(obj);
  if (actual.length !== expectedKeys.length) {
    return false;
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      return false;
    }
  }
  return true;
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowedKeys.has(key));
}

function containsEmailKeyDeep(value: unknown): boolean {
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): boolean {
    if (depth > MAX_INSPECT_DEPTH || node === null || typeof node !== "object") {
      return false;
    }
    if (seen.has(node)) return false;
    seen.add(node);

    if (Array.isArray(node)) {
      return node.some((item) => walk(item, depth + 1));
    }
    for (const key of Object.keys(node)) {
      if (EMAIL_KEY_PATTERN.test(key)) return true;
      if (walk((node as Record<string, unknown>)[key], depth + 1)) return true;
    }
    return false;
  }

  return walk(value, 0);
}

function toSearchParams(input: URLSearchParams | URL): URLSearchParams {
  return input instanceof URL ? input.searchParams : input;
}

export function parseEmptyRoleAccessQuery(searchParams: URLSearchParams | URL): void {
  const params = toSearchParams(searchParams);
  for (const key of params.keys()) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `Endpoint này không hỗ trợ tham số truy vấn: ${key}.`,
    );
  }
}

export function parseAccountsSummaryQuery(
  searchParams: URLSearchParams | URL,
): AccountsSummaryQuery {
  const params = toSearchParams(searchParams);
  const allowed = new Set(["search", "enabled", "role_code", "page", "page_size"]);

  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        `Tham số truy vấn không được hỗ trợ: ${key}.`,
      );
    }
  }
  for (const key of allowed) {
    if (params.getAll(key).length > 1) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        `Tham số truy vấn bị lặp: ${key}.`,
      );
    }
  }

  const rawSearch = params.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    if (CONTROL_CHAR_PATTERN.test(rawSearch) || rawSearch.length > SEARCH_MAX_LENGTH) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        `Từ khóa tìm kiếm không hợp lệ (tối đa ${SEARCH_MAX_LENGTH} ký tự).`,
      );
    }
    const trimmed = rawSearch.trim();
    if (trimmed.length === 0) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        "Từ khóa tìm kiếm không được rỗng.",
      );
    }
    search = trimmed;
  }

  const enabled = params.get("enabled") ?? "all";
  if (enabled !== "all" && enabled !== "true" && enabled !== "false") {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      "Tham số enabled phải là all, true hoặc false.",
    );
  }

  const rawRoleCode = params.get("role_code");
  let role_code: AuthzRoleCode | null = null;
  if (rawRoleCode !== null) {
    if (!ALL_ROLE_SET.has(rawRoleCode)) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        "role_code lọc danh sách không thuộc 8 role canonical.",
      );
    }
    role_code = rawRoleCode as AuthzRoleCode;
  }

  const rawPage = params.get("page") ?? String(DEFAULT_PAGE);
  const rawPageSize = params.get("page_size") ?? String(DEFAULT_PAGE_SIZE);
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      "page và page_size phải là số nguyên dương.",
    );
  }
  const page = Number(rawPage);
  const page_size = Number(rawPageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MAX_PAGE ||
    !Number.isSafeInteger(page_size) ||
    page_size < 1 ||
    page_size > MAX_PAGE_SIZE
  ) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `page phải trong 1..${MAX_PAGE} và page_size phải trong 1..${MAX_PAGE_SIZE}.`,
    );
  }

  return { search, enabled, role_code, page, page_size };
}

export function parseAccountRefParam(raw: unknown): string {
  if (!isUuid(raw)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      "accountRef phải là UUID hợp lệ.",
    );
  }
  return raw.toLowerCase();
}

export function parseAssignmentIdParam(raw: unknown): string {
  if (!isUuid(raw)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      "assignmentId phải là UUID hợp lệ.",
    );
  }
  return raw.toLowerCase();
}

function parseStrictIdempotencyKeyPair(
  idempotencyHeader: string | null,
  bodyKey: unknown,
): string {
  if (!isUuid(idempotencyHeader)) {
    throw new RoleAccessValidationError(
      "IDEMPOTENCY_KEY_INVALID",
      "Header Idempotency-Key phải là UUID hợp lệ.",
    );
  }
  if (!isUuid(bodyKey)) {
    throw new RoleAccessValidationError(
      "IDEMPOTENCY_KEY_INVALID",
      "idempotency_key trong payload phải là UUID hợp lệ.",
    );
  }
  if (idempotencyHeader.toLowerCase() !== bodyKey.toLowerCase()) {
    throw new RoleAccessValidationError(
      "IDEMPOTENCY_KEY_MISMATCH",
      "Header Idempotency-Key và idempotency_key trong payload không khớp.",
    );
  }
  return bodyKey.toLowerCase();
}

function parseExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      "expected_version phải là số nguyên >= 1.",
    );
  }
  return value;
}

function parseMutationReason(value: unknown): string {
  if (typeof value !== "string" || CONTROL_CHAR_PATTERN.test(value)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `reason phải là chuỗi hợp lệ (${REASON_MIN_LENGTH}..${REASON_MAX_LENGTH} ký tự).`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `reason phải có độ dài sau trim từ ${REASON_MIN_LENGTH} đến ${REASON_MAX_LENGTH} ký tự.`,
    );
  }
  return trimmed;
}

function validateAllowedBodyKeys(
  body: Record<string, unknown>,
  requiredKeys: readonly string[],
): void {
  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        `Payload chứa trường không hợp lệ: ${key}.`,
      );
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      throw new RoleAccessValidationError(
        "AUTHZ_VALIDATION_ERROR",
        `Payload thiếu trường bắt buộc: ${key}.`,
      );
    }
  }
}

export function parseAssignGlobalRoleBody(
  raw: unknown,
  idempotencyHeader: string | null,
): AssignGlobalRoleInput {
  assertNoForbiddenAuthorityFields(raw);

  if (!isPlainObject(raw)) {
    throw new RoleAccessValidationError("AUTHZ_VALIDATION_ERROR", "Payload phải là JSON object.");
  }

  validateAllowedBodyKeys(raw, [
    "role_code",
    "expected_version",
    "reason",
    "idempotency_key",
  ]);

  const idempotency_key = parseStrictIdempotencyKeyPair(
    idempotencyHeader,
    raw.idempotency_key,
  );

  if (typeof raw.role_code !== "string") {
    throw new RoleAccessValidationError("AUTHZ_VALIDATION_ERROR", "role_code không hợp lệ.");
  }
  if (CONTEXTUAL_ROLE_SET.has(raw.role_code)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `Vai trò ngữ cảnh (${raw.role_code}) không được gán trực tiếp ở bảng Global role.`,
    );
  }
  if (!GLOBAL_ROLE_SET.has(raw.role_code)) {
    throw new RoleAccessValidationError(
      "AUTHZ_VALIDATION_ERROR",
      `role_code không hợp lệ: ${raw.role_code}.`,
    );
  }

  const expected_version = parseExpectedVersion(raw.expected_version);
  const reason = parseMutationReason(raw.reason);

  return {
    role_code: raw.role_code as GlobalRoleCode,
    expected_version,
    reason,
    idempotency_key,
  };
}

export function parseRevokeGlobalRoleBody(
  raw: unknown,
  idempotencyHeader: string | null,
): RevokeGlobalRoleInput {
  assertNoForbiddenAuthorityFields(raw);

  if (!isPlainObject(raw)) {
    throw new RoleAccessValidationError("AUTHZ_VALIDATION_ERROR", "Payload phải là JSON object.");
  }

  validateAllowedBodyKeys(raw, ["expected_version", "reason", "idempotency_key"]);

  const idempotency_key = parseStrictIdempotencyKeyPair(
    idempotencyHeader,
    raw.idempotency_key,
  );
  const expected_version = parseExpectedVersion(raw.expected_version);
  const reason = parseMutationReason(raw.reason);

  return {
    expected_version,
    reason,
    idempotency_key,
  };
}

/* ==================== Canonical RPC Payload Projectors (Fail-Closed) ==================== */

function isValidIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !CONTROL_CHAR_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSafeDisplayText(value: unknown, maxLen: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLen &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isOptionalReasonText(value: unknown, maxLen = 500): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLen &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isNullableLoginId(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === "string" && LOGIN_ID_PATTERN.test(value);
}

function isNullableDisplayName(value: unknown): value is string | null {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 256 &&
    !CONTROL_CHAR_PATTERN.test(value)
  );
}

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function projectRoleCapabilityTemplate(value: unknown): RoleCapabilityTemplate | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["capability", "scope_template", "retired_compat"])
  ) {
    return null;
  }
  if (typeof value.capability !== "string" || !CAPABILITY_SET.has(value.capability)) {
    return null;
  }
  if (
    typeof value.scope_template !== "string" ||
    !SCOPE_KIND_SET.has(value.scope_template)
  ) {
    return null;
  }
  if (typeof value.retired_compat !== "boolean") {
    return null;
  }
  return {
    capability: value.capability as Capability,
    scope_template: value.scope_template as AuthzScopeKind,
    retired_compat: value.retired_compat,
  };
}

function projectRoleCatalogItem(value: unknown): RoleCatalogItem | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "role_code",
      "display_name",
      "description",
      "assignment_mode",
      "fixed_scope_kind",
      "requires_active_person",
      "is_assignable_global",
      "sort_order",
      "capabilities",
    ])
  ) {
    return null;
  }
  if (typeof value.role_code !== "string" || !ALL_ROLE_SET.has(value.role_code)) {
    return null;
  }
  if (
    !isSafeDisplayText(value.display_name, 128) ||
    typeof value.description !== "string" ||
    CONTROL_CHAR_PATTERN.test(value.description) ||
    value.description.length > 500
  ) {
    return null;
  }
  if (
    typeof value.assignment_mode !== "string" ||
    !ASSIGNMENT_MODE_SET.has(value.assignment_mode)
  ) {
    return null;
  }
  if (
    typeof value.fixed_scope_kind !== "string" ||
    !FIXED_SCOPE_KIND_SET.has(value.fixed_scope_kind)
  ) {
    return null;
  }
  if (
    typeof value.requires_active_person !== "boolean" ||
    typeof value.is_assignable_global !== "boolean" ||
    !isSafePositiveInt(value.sort_order)
  ) {
    return null;
  }
  if (
    (value.assignment_mode === "GLOBAL" && !value.is_assignable_global) ||
    (value.assignment_mode === "CONTEXTUAL" && value.is_assignable_global)
  ) {
    return null;
  }
  if (!Array.isArray(value.capabilities)) {
    return null;
  }
  const capabilities: RoleCapabilityTemplate[] = [];
  for (const capRaw of value.capabilities) {
    const cap = projectRoleCapabilityTemplate(capRaw);
    if (!cap) return null;
    capabilities.push(cap);
  }
  return {
    role_code: value.role_code as AuthzRoleCode,
    display_name: value.display_name,
    description: value.description,
    assignment_mode: value.assignment_mode as AuthzAssignmentMode,
    fixed_scope_kind: value.fixed_scope_kind as AuthzFixedScopeKind,
    requires_active_person: value.requires_active_person,
    is_assignable_global: value.is_assignable_global,
    sort_order: value.sort_order,
    capabilities,
  };
}

export function projectRolesCatalogResponse(value: unknown): RolesCatalogEnvelope | null {
  if (
    containsEmailKeyDeep(value) ||
    !isPlainObject(value) ||
    !hasExactKeys(value, ["as_of", "roles"]) ||
    !isValidIsoTimestamp(value.as_of) ||
    !Array.isArray(value.roles)
  ) {
    return null;
  }
  const roles: RoleCatalogItem[] = [];
  const seenCodes = new Set<string>();
  for (const item of value.roles) {
    const role = projectRoleCatalogItem(item);
    if (!role || seenCodes.has(role.role_code)) {
      return null;
    }
    seenCodes.add(role.role_code);
    roles.push(role);
  }
  if (roles.length !== AUTHZ_ROLE_CODES.length) {
    return null;
  }
  for (const code of AUTHZ_ROLE_CODES) {
    if (!seenCodes.has(code)) {
      return null;
    }
  }
  return { as_of: value.as_of, roles };
}

const PERSON_SUMMARY_ALLOWED_KEYS = new Set([
  "person_id",
  "employee_code",
  "full_name",
  "status",
  "department_id",
  "department_name",
]);

function projectAccountPersonSummary(value: unknown): AccountPersonSummary | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, PERSON_SUMMARY_ALLOWED_KEYS)) {
    return undefined;
  }
  if (
    !isUuid(value.person_id) ||
    !isSafeDisplayText(value.employee_code, 64) ||
    !isSafeDisplayText(value.full_name, 160)
  ) {
    return undefined;
  }
  if (
    value.status !== undefined &&
    value.status !== "ACTIVE" &&
    value.status !== "INACTIVE"
  ) {
    return undefined;
  }
  if (
    value.department_id !== undefined &&
    value.department_id !== null &&
    !isUuid(value.department_id)
  ) {
    return undefined;
  }
  if (
    value.department_name !== undefined &&
    value.department_name !== null &&
    !isSafeDisplayText(value.department_name, 160)
  ) {
    return undefined;
  }
  return {
    person_id: value.person_id.toLowerCase(),
    employee_code: value.employee_code,
    full_name: value.full_name,
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.department_id !== undefined
      ? {
          department_id:
            value.department_id === null ? null : value.department_id.toLowerCase(),
        }
      : {}),
    ...(value.department_name !== undefined
      ? { department_name: value.department_name as string | null }
      : {}),
  };
}

function isValidCannotRevokeReason(value: unknown): value is CannotRevokeReason | null {
  return value === null || value === "PROTECTED_OWNER_ADMIN";
}

function isValidInactiveReason(value: unknown): value is AssignmentInactiveReason | null {
  return (
    value === null ||
    (typeof value === "string" && INACTIVE_REASON_SET.has(value))
  );
}

function projectAccountSummaryGlobalRole(value: unknown): AccountSummaryGlobalRole | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "assignment_id",
      "role_code",
      "display_name",
      "is_effective",
      "is_protected",
      "can_revoke",
      "cannot_revoke_reason",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(value.assignment_id) ||
    typeof value.role_code !== "string" ||
    !GLOBAL_ROLE_SET.has(value.role_code) ||
    !isSafeDisplayText(value.display_name, 128) ||
    typeof value.is_effective !== "boolean" ||
    typeof value.is_protected !== "boolean" ||
    typeof value.can_revoke !== "boolean" ||
    !isValidCannotRevokeReason(value.cannot_revoke_reason)
  ) {
    return null;
  }
  if (
    value.is_protected &&
    (value.can_revoke || value.cannot_revoke_reason !== "PROTECTED_OWNER_ADMIN")
  ) {
    return null;
  }
  if (!value.is_protected && value.cannot_revoke_reason !== null) {
    return null;
  }
  return {
    assignment_id: value.assignment_id.toLowerCase(),
    role_code: value.role_code as GlobalRoleCode,
    display_name: value.display_name,
    is_effective: value.is_effective,
    is_protected: value.is_protected,
    can_revoke: value.can_revoke,
    cannot_revoke_reason: value.cannot_revoke_reason,
  };
}

function projectAccountSummaryContextualRole(
  value: unknown,
): AccountSummaryContextualRole | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "role_code",
      "display_name",
      "target_kind",
      "target_ref",
      "target_label",
      "is_effective",
    ])
  ) {
    return null;
  }
  if (
    typeof value.role_code !== "string" ||
    !CONTEXTUAL_ROLE_SET.has(value.role_code) ||
    !isSafeDisplayText(value.display_name, 128) ||
    typeof value.target_kind !== "string" ||
    !CONTEXTUAL_TARGET_KIND_SET.has(value.target_kind) ||
    !isSafeDisplayText(value.target_ref, 128) ||
    !isSafeDisplayText(value.target_label, 256) ||
    typeof value.is_effective !== "boolean"
  ) {
    return null;
  }
  return {
    role_code: value.role_code as ContextualRoleCode,
    display_name: value.display_name,
    target_kind: value.target_kind as ContextualTargetKind,
    target_ref: value.target_ref,
    target_label: value.target_label,
    is_effective: value.is_effective,
  };
}

function projectBlockingReasons(value: unknown): AccountBlockingReason[] | null {
  if (!Array.isArray(value)) return null;
  const result: AccountBlockingReason[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SAFE_CODE_TOKEN_PATTERN.test(item)) {
      return null;
    }
    result.push(item as AccountBlockingReason);
  }
  return result;
}

function projectAccountsSummaryItem(value: unknown): AccountsSummaryItem | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "account_ref",
      "login_id",
      "display_name",
      "enabled",
      "account_type",
      "authz_managed",
      "version",
      "person",
      "global_roles",
      "contextual_roles",
      "direct_exception_count",
      "effective_grant_count",
      "blocking_reasons",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(value.account_ref) ||
    !isNullableLoginId(value.login_id) ||
    !isNullableDisplayName(value.display_name) ||
    typeof value.enabled !== "boolean" ||
    typeof value.account_type !== "string" ||
    !ACCOUNT_TYPE_SET.has(value.account_type) ||
    typeof value.authz_managed !== "boolean" ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  const person = projectAccountPersonSummary(value.person);
  if (person === undefined) return null;

  if (!Array.isArray(value.global_roles) || !Array.isArray(value.contextual_roles)) {
    return null;
  }
  const global_roles: AccountSummaryGlobalRole[] = [];
  for (const rawRole of value.global_roles) {
    const projected = projectAccountSummaryGlobalRole(rawRole);
    if (!projected) return null;
    global_roles.push(projected);
  }
  const contextual_roles: AccountSummaryContextualRole[] = [];
  for (const rawCtx of value.contextual_roles) {
    const projected = projectAccountSummaryContextualRole(rawCtx);
    if (!projected) return null;
    contextual_roles.push(projected);
  }

  if (
    !isSafeNonNegativeInt(value.direct_exception_count) ||
    !isSafeNonNegativeInt(value.effective_grant_count)
  ) {
    return null;
  }
  if (!value.enabled && value.effective_grant_count !== 0) {
    return null;
  }

  const blocking_reasons = projectBlockingReasons(value.blocking_reasons);
  if (!blocking_reasons) return null;

  return {
    account_ref: value.account_ref.toLowerCase(),
    login_id: value.login_id,
    display_name: value.display_name,
    enabled: value.enabled,
    account_type: value.account_type as AccountType,
    authz_managed: value.authz_managed,
    version: value.version,
    person,
    global_roles,
    contextual_roles,
    direct_exception_count: value.direct_exception_count,
    effective_grant_count: value.effective_grant_count,
    blocking_reasons,
  };
}

export function projectAccountsSummaryResponse(
  value: unknown,
): AccountsSummaryListResponse | null {
  if (
    containsEmailKeyDeep(value) ||
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "as_of",
      "search",
      "enabled",
      "role_code",
      "page",
      "page_size",
      "total",
      "accounts",
    ])
  ) {
    return null;
  }
  if (!isValidIsoTimestamp(value.as_of)) return null;
  if (
    value.search !== null &&
    (typeof value.search !== "string" ||
      value.search !== value.search.trim() ||
      value.search.length === 0 ||
      value.search.length > SEARCH_MAX_LENGTH ||
      CONTROL_CHAR_PATTERN.test(value.search))
  ) {
    return null;
  }
  if (value.enabled !== "all" && value.enabled !== "true" && value.enabled !== "false") {
    return null;
  }
  if (
    value.role_code !== null &&
    (typeof value.role_code !== "string" || !ALL_ROLE_SET.has(value.role_code))
  ) {
    return null;
  }
  if (
    !isSafePositiveInt(value.page) ||
    !isSafePositiveInt(value.page_size) ||
    value.page > MAX_PAGE ||
    value.page_size > MAX_PAGE_SIZE ||
    !isSafeNonNegativeInt(value.total) ||
    !Array.isArray(value.accounts)
  ) {
    return null;
  }

  const accounts: AccountsSummaryItem[] = [];
  for (const item of value.accounts) {
    const projected = projectAccountsSummaryItem(item);
    if (!projected) return null;
    accounts.push(projected);
  }

  return {
    as_of: value.as_of,
    search: value.search,
    enabled: value.enabled,
    role_code: value.role_code as AuthzRoleCode | null,
    page: value.page,
    page_size: value.page_size,
    total: value.total,
    accounts,
  };
}

export function projectAssignedGlobalRoleItem(
  value: unknown,
): AssignedGlobalRoleItem | null {
  if (
    containsEmailKeyDeep(value) ||
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "assignment_id",
      "role_code",
      "display_name",
      "source_kind",
      "reason",
      "started_at",
      "ended_at",
      "ended_reason",
      "assigned_by_display",
      "is_effective",
      "inactive_reason",
      "is_protected",
      "can_revoke",
      "cannot_revoke_reason",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(value.assignment_id) ||
    typeof value.role_code !== "string" ||
    !GLOBAL_ROLE_SET.has(value.role_code) ||
    !isSafeDisplayText(value.display_name, 128) ||
    typeof value.source_kind !== "string" ||
    !ROLE_SOURCE_KIND_SET.has(value.source_kind) ||
    !isOptionalReasonText(value.reason, REASON_MAX_LENGTH) ||
    !isValidIsoTimestamp(value.started_at)
  ) {
    return null;
  }
  if (value.ended_at !== null && !isValidIsoTimestamp(value.ended_at)) {
    return null;
  }
  if (value.ended_reason !== null && !isOptionalReasonText(value.ended_reason, REASON_MAX_LENGTH)) {
    return null;
  }
  if (!isNullableDisplayName(value.assigned_by_display)) {
    return null;
  }
  if (
    typeof value.is_effective !== "boolean" ||
    !isValidInactiveReason(value.inactive_reason) ||
    typeof value.is_protected !== "boolean" ||
    typeof value.can_revoke !== "boolean" ||
    !isValidCannotRevokeReason(value.cannot_revoke_reason)
  ) {
    return null;
  }

  if (value.ended_at !== null && (value.is_effective || value.can_revoke)) {
    return null;
  }
  if (value.is_protected) {
    if (value.can_revoke) return null;
    if (value.ended_at === null && value.cannot_revoke_reason !== "PROTECTED_OWNER_ADMIN") {
      return null;
    }
  } else if (value.cannot_revoke_reason !== null) {
    return null;
  }

  return {
    assignment_id: value.assignment_id.toLowerCase(),
    role_code: value.role_code as GlobalRoleCode,
    display_name: value.display_name,
    source_kind: value.source_kind as AuthzRoleSourceKind,
    reason: value.reason,
    started_at: value.started_at,
    ended_at: value.ended_at,
    ended_reason: value.ended_reason,
    assigned_by_display: value.assigned_by_display,
    is_effective: value.is_effective,
    inactive_reason: value.inactive_reason,
    is_protected: value.is_protected,
    can_revoke: value.can_revoke,
    cannot_revoke_reason: value.cannot_revoke_reason,
  };
}

const DIRECT_EXCEPTION_ALLOWED_KEYS = new Set([
  "direct_grant_id",
  "capability",
  "scope_kind",
  "scope_id",
  "scope_label",
  "source_kind",
  "reason",
  "started_at",
  "ended_at",
  "ended_reason",
  "granted_by_display",
  "is_effective",
  "inactive_reason",
]);

function projectDirectExceptionItem(value: unknown): DirectExceptionItem | null {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, DIRECT_EXCEPTION_ALLOWED_KEYS)) {
    return null;
  }
  if (
    !isUuid(value.direct_grant_id) ||
    typeof value.capability !== "string" ||
    !CAPABILITY_SET.has(value.capability) ||
    typeof value.scope_kind !== "string" ||
    !SCOPE_KIND_SET.has(value.scope_kind)
  ) {
    return null;
  }
  const scopeKind = value.scope_kind as AuthzScopeKind;
  if (scopeKind === "OWN" || scopeKind === "ALL") {
    if (value.scope_id !== null) return null;
  } else if (!isSafeDisplayText(value.scope_id, 128)) {
    return null;
  }
  if (
    value.scope_label !== undefined &&
    value.scope_label !== null &&
    !isSafeDisplayText(value.scope_label, 256)
  ) {
    return null;
  }
  if (
    typeof value.source_kind !== "string" ||
    !DIRECT_EXCEPTION_SOURCE_KIND_SET.has(value.source_kind) ||
    !isOptionalReasonText(value.reason, REASON_MAX_LENGTH) ||
    !isValidIsoTimestamp(value.started_at)
  ) {
    return null;
  }
  if (value.ended_at !== null && !isValidIsoTimestamp(value.ended_at)) {
    return null;
  }
  if (value.ended_reason !== null && !isOptionalReasonText(value.ended_reason, REASON_MAX_LENGTH)) {
    return null;
  }
  if (!isNullableDisplayName(value.granted_by_display)) {
    return null;
  }
  if (
    typeof value.is_effective !== "boolean" ||
    !isValidInactiveReason(value.inactive_reason)
  ) {
    return null;
  }
  if (value.ended_at !== null && value.is_effective) {
    return null;
  }
  return {
    direct_grant_id: value.direct_grant_id.toLowerCase(),
    capability: value.capability as Capability,
    scope_kind: scopeKind,
    scope_id: value.scope_id as string | null,
    ...(value.scope_label !== undefined
      ? { scope_label: value.scope_label as string | null }
      : {}),
    source_kind: value.source_kind as AuthzDirectExceptionSourceKind,
    reason: value.reason,
    started_at: value.started_at,
    ended_at: value.ended_at,
    ended_reason: value.ended_reason,
    granted_by_display: value.granted_by_display,
    is_effective: value.is_effective,
    inactive_reason: value.inactive_reason,
  };
}

const CONTEXTUAL_ASSIGNMENT_ALLOWED_KEYS = new Set([
  "role_code",
  "display_name",
  "target_kind",
  "target_ref",
  "target_label",
  "scope_kind",
  "scope_id",
  "assignment_id",
  "started_at",
  "is_effective",
  "inactive_reason",
  "derived_capabilities",
  "can_revoke",
  "cannot_revoke_reason",
]);

function projectContextualAssignmentItem(value: unknown): ContextualAssignmentItem | null {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, CONTEXTUAL_ASSIGNMENT_ALLOWED_KEYS)) {
    return null;
  }
  if (
    typeof value.role_code !== "string" ||
    !CONTEXTUAL_ROLE_SET.has(value.role_code) ||
    !isSafeDisplayText(value.display_name, 128) ||
    typeof value.target_kind !== "string" ||
    !CONTEXTUAL_TARGET_KIND_SET.has(value.target_kind) ||
    !isSafeDisplayText(value.target_ref, 128) ||
    !isSafeDisplayText(value.target_label, 256) ||
    typeof value.is_effective !== "boolean" ||
    !isValidInactiveReason(value.inactive_reason ?? null) ||
    !Array.isArray(value.derived_capabilities)
  ) {
    return null;
  }
  const derived_capabilities: Capability[] = [];
  for (const cap of value.derived_capabilities) {
    if (typeof cap !== "string" || !CAPABILITY_SET.has(cap)) {
      return null;
    }
    derived_capabilities.push(cap as Capability);
  }
  if (
    (value.role_code === "DEPARTMENT_HEAD" || value.role_code === "PROJECT_MANAGER") &&
    derived_capabilities.length !== 0
  ) {
    return null;
  }
  if (
    value.scope_kind !== undefined &&
    value.scope_kind !== "CONTEXT_TEAM" &&
    value.scope_kind !== "CONTEXT_DEPARTMENT" &&
    value.scope_kind !== "CONTEXT_PROJECT"
  ) {
    return null;
  }
  if (value.scope_id !== undefined && !isSafeDisplayText(value.scope_id, 128)) {
    return null;
  }
  if (
    value.assignment_id !== undefined &&
    value.assignment_id !== null &&
    !isSafeDisplayText(value.assignment_id, 128)
  ) {
    return null;
  }
  if (
    value.started_at !== undefined &&
    value.started_at !== null &&
    !isValidIsoTimestamp(value.started_at)
  ) {
    return null;
  }
  if (value.can_revoke !== undefined && value.can_revoke !== false) {
    return null;
  }
  if (
    value.cannot_revoke_reason !== undefined &&
    value.cannot_revoke_reason !== null &&
    !isSafeDisplayText(value.cannot_revoke_reason, 128)
  ) {
    return null;
  }

  return {
    role_code: value.role_code as ContextualRoleCode,
    display_name: value.display_name,
    target_kind: value.target_kind as ContextualTargetKind,
    target_ref: value.target_ref,
    target_label: value.target_label,
    ...(value.scope_kind !== undefined ? { scope_kind: value.scope_kind } : {}),
    ...(value.scope_id !== undefined ? { scope_id: value.scope_id } : {}),
    ...(value.assignment_id !== undefined
      ? { assignment_id: value.assignment_id as string | null }
      : {}),
    ...(value.started_at !== undefined
      ? { started_at: value.started_at as string | null }
      : {}),
    is_effective: value.is_effective,
    inactive_reason: (value.inactive_reason ?? null) as AssignmentInactiveReason | null,
    derived_capabilities,
    ...(value.can_revoke !== undefined ? { can_revoke: false as const } : {}),
    ...(value.cannot_revoke_reason !== undefined
      ? { cannot_revoke_reason: value.cannot_revoke_reason as string | null }
      : {}),
  };
}

const MODULE_AUTHORITY_ALLOWED_KEYS = new Set([
  "module",
  "authority_code",
  "display_name",
  "scope_kind",
  "scope_ref",
  "scope_label",
  "is_effective",
  "inactive_reason",
]);

function projectModuleAuthorityItem(value: unknown): ModuleAuthorityItem | null {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, MODULE_AUTHORITY_ALLOWED_KEYS)) {
    return null;
  }
  if (
    !isSafeDisplayText(value.module, 64) ||
    !isSafeDisplayText(value.authority_code, 128) ||
    !isSafeDisplayText(value.display_name, 160) ||
    !isSafeDisplayText(value.scope_kind, 64) ||
    (value.scope_ref !== null && !isSafeDisplayText(value.scope_ref, 128)) ||
    (value.scope_label !== null && !isSafeDisplayText(value.scope_label, 256)) ||
    typeof value.is_effective !== "boolean" ||
    !isValidInactiveReason(value.inactive_reason ?? null)
  ) {
    return null;
  }
  return {
    module: value.module,
    authority_code: value.authority_code,
    display_name: value.display_name,
    scope_kind: value.scope_kind,
    scope_ref: value.scope_ref as string | null,
    scope_label: value.scope_label as string | null,
    is_effective: value.is_effective,
    inactive_reason: (value.inactive_reason ?? null) as AssignmentInactiveReason | null,
  };
}

const PAIRED_GRANT_ALLOWED_KEYS = new Set([
  "capability",
  "scope_kind",
  "scope_id",
  "source_type",
  "source_id",
  "scope_label",
]);

const EFFECTIVE_GRANT_SOURCE_TYPE_SET = new Set<string>([
  "ROLE_BUNDLE",
  "CONTEXTUAL_ASSIGNMENT",
  "DIRECT_GRANT",
  "LEGACY_BRIDGE",
]);

function projectPairedEffectiveGrantItem(value: unknown): PairedEffectiveGrantItem | null {
  if (!isPlainObject(value) || !hasOnlyAllowedKeys(value, PAIRED_GRANT_ALLOWED_KEYS)) {
    return null;
  }
  if (
    typeof value.capability !== "string" ||
    !CAPABILITY_SET.has(value.capability) ||
    typeof value.scope_kind !== "string" ||
    !SCOPE_KIND_SET.has(value.scope_kind)
  ) {
    return null;
  }
  const scopeKind = value.scope_kind as AuthzScopeKind;
  if (scopeKind === "OWN" || scopeKind === "ALL") {
    if (value.scope_id !== null) return null;
  } else if (!isSafeDisplayText(value.scope_id, 128)) {
    return null;
  }
  if (
    typeof value.source_type !== "string" ||
    !EFFECTIVE_GRANT_SOURCE_TYPE_SET.has(value.source_type)
  ) {
    return null;
  }
  if (value.source_id !== null && !isSafeDisplayText(value.source_id, 128)) {
    return null;
  }
  if (
    value.scope_label !== undefined &&
    value.scope_label !== null &&
    !isSafeDisplayText(value.scope_label, 256)
  ) {
    return null;
  }
  return {
    capability: value.capability as Capability,
    scope_kind: scopeKind,
    scope_id: value.scope_id as string | null,
    source_type: value.source_type as EffectiveGrantSourceType,
    source_id: value.source_id as string | null,
    ...(value.scope_label !== undefined
      ? { scope_label: value.scope_label as string | null }
      : {}),
  };
}

function projectAccountAccessHeader(value: unknown): AccountAccessHeader | null {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "account_ref",
      "login_id",
      "display_name",
      "enabled",
      "account_type",
      "authz_managed",
      "version",
      "person",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(value.account_ref) ||
    !isNullableLoginId(value.login_id) ||
    !isNullableDisplayName(value.display_name) ||
    typeof value.enabled !== "boolean" ||
    typeof value.account_type !== "string" ||
    !ACCOUNT_TYPE_SET.has(value.account_type) ||
    typeof value.authz_managed !== "boolean" ||
    !isSafePositiveInt(value.version)
  ) {
    return null;
  }
  const person = projectAccountPersonSummary(value.person);
  if (person === undefined) return null;

  return {
    account_ref: value.account_ref.toLowerCase(),
    login_id: value.login_id,
    display_name: value.display_name,
    enabled: value.enabled,
    account_type: value.account_type as AccountType,
    authz_managed: value.authz_managed,
    version: value.version,
    person,
  };
}

export function projectAccountAccessDetail(value: unknown): AccountAccessDetail | null {
  if (
    containsEmailKeyDeep(value) ||
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "as_of",
      "account",
      "blocking_reasons",
      "assigned_global_roles",
      "direct_exceptions",
      "contextual_assignments",
      "module_authorities",
      "effective_grants",
    ])
  ) {
    return null;
  }
  if (!isValidIsoTimestamp(value.as_of)) return null;
  const account = projectAccountAccessHeader(value.account);
  if (!account) return null;

  const blocking_reasons = projectBlockingReasons(value.blocking_reasons);
  if (!blocking_reasons) return null;

  if (
    !Array.isArray(value.assigned_global_roles) ||
    !Array.isArray(value.direct_exceptions) ||
    !Array.isArray(value.contextual_assignments) ||
    !Array.isArray(value.module_authorities) ||
    !Array.isArray(value.effective_grants)
  ) {
    return null;
  }

  const assigned_global_roles: AssignedGlobalRoleItem[] = [];
  for (const item of value.assigned_global_roles) {
    const projected = projectAssignedGlobalRoleItem(item);
    if (!projected) return null;
    assigned_global_roles.push(projected);
  }

  const direct_exceptions: DirectExceptionItem[] = [];
  for (const item of value.direct_exceptions) {
    const projected = projectDirectExceptionItem(item);
    if (!projected) return null;
    direct_exceptions.push(projected);
  }

  const contextual_assignments: ContextualAssignmentItem[] = [];
  for (const item of value.contextual_assignments) {
    const projected = projectContextualAssignmentItem(item);
    if (!projected) return null;
    contextual_assignments.push(projected);
  }

  const module_authorities: ModuleAuthorityItem[] = [];
  for (const item of value.module_authorities) {
    const projected = projectModuleAuthorityItem(item);
    if (!projected) return null;
    module_authorities.push(projected);
  }

  const effective_grants: PairedEffectiveGrantItem[] = [];
  for (const item of value.effective_grants) {
    const projected = projectPairedEffectiveGrantItem(item);
    if (!projected) return null;
    effective_grants.push(projected);
  }

  // Disabled accounts must always resolve to zero effective runtime grants (D10 invariant).
  if (!account.enabled && effective_grants.length !== 0) {
    return null;
  }

  return {
    as_of: value.as_of,
    account,
    blocking_reasons,
    assigned_global_roles,
    direct_exceptions,
    contextual_assignments,
    module_authorities,
    effective_grants,
  };
}

export function projectRoleMutationResult(value: unknown): RoleMutationResult | null {
  if (
    containsEmailKeyDeep(value) ||
    !isPlainObject(value) ||
    !hasExactKeys(value, ["replayed", "account_ref", "account_version", "assignment"])
  ) {
    return null;
  }
  if (
    typeof value.replayed !== "boolean" ||
    !isUuid(value.account_ref) ||
    !isSafePositiveInt(value.account_version)
  ) {
    return null;
  }
  const assignment = projectAssignedGlobalRoleItem(value.assignment);
  if (!assignment) return null;

  return {
    replayed: value.replayed,
    account_ref: value.account_ref.toLowerCase(),
    account_version: value.account_version,
    assignment,
  };
}
