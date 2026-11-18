import { createHash } from "node:crypto";

export const WP5_CUTOVER_MANIFEST_VERSION = "wp5-cutover-manifest-v1";
export const CANONICAL_OWNER_EMAIL = "nobita6986@gmail.com";
export const INITIAL_ADMIN_LOGIN_IDS = Object.freeze(["luanpt", "lienvu", "ngattt"]);
export const PROTECTED_OWNER_REASON = "PROTECTED_OWNER_ADMIN";

export const ADMIN_NON_AUTO_GRANT_TOKENS = Object.freeze([
  "catalog_master_manage",
  "team_manager_assign",
  "report_form_manage",
  "report_assign",
  "report_review",
  "report_delegate",
  "vendor_finance_view",
  "vendor_finance_record",
]);

const ACTIVE_29_CAPABILITIES = Object.freeze([
  "entry_create",
  "entry_own",
  "entry_team",
  "entry_admin",
  "submission_create",
  "change_request_create",
  "change_review",
  "entry_privileged_edit",
  "employment_status.request",
  "employment_status.review",
  "employment_status.apply",
  "document_upload",
  "document_view",
  "recruiter_master_manage",
  "team_master_manage",
  "audit_view",
  "entry_restore",
  "catalog_master_manage",
  "team_manager_assign",
  "report_form_manage",
  "report_assign",
  "report_view",
  "report_analytics_view",
  "report_review",
  "report_delegate",
  "vendor_finance_view",
  "vendor_finance_record",
  "duplicate_cccd_withdraw",
  "worker_edit_history_view",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const WHITESPACE_PATTERN = /\s/;

function deepFreeze(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function capEntry(capability, scope_template, retired_compat = false) {
  return { capability, scope_template, retired_compat };
}

export const WP5_ROLE_CATALOG = deepFreeze({
  EMPLOYEE_BASE: {
    role_code: "EMPLOYEE_BASE",
    display_name: "Nhân viên cơ sở",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "none",
    requires_active_person: false,
    is_assignable_global: true,
    capabilities: [],
  },
  RECRUITER: {
    role_code: "RECRUITER",
    display_name: "Tuyển dụng (Recruiter)",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "own",
    requires_active_person: false,
    is_assignable_global: true,
    capabilities: [
      capEntry("entry_create", "OWN"),
      capEntry("entry_own", "OWN"),
      capEntry("submission_create", "OWN"),
      capEntry("document_upload", "OWN"),
      capEntry("document_view", "OWN"),
      capEntry("change_request_create", "OWN", true),
      capEntry("employment_status.request", "OWN", true),
    ],
  },
  HR_OPERATOR: {
    role_code: "HR_OPERATOR",
    display_name: "Vận hành nhân sự (HR Operator)",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "all",
    requires_active_person: false,
    is_assignable_global: true,
    capabilities: [
      capEntry("recruiter_master_manage", "ALL"),
      capEntry("team_master_manage", "ALL"),
      capEntry("catalog_master_manage", "ALL"),
      capEntry("audit_view", "ALL"),
      capEntry("document_view", "ALL"),
    ],
  },
  ADMIN: {
    role_code: "ADMIN",
    display_name: "BoD/Admin",
    assignment_mode: "GLOBAL",
    fixed_scope_kind: "all",
    requires_active_person: false,
    is_assignable_global: true,
    capabilities: [
      capEntry("entry_own", "OWN"),
      capEntry("entry_admin", "ALL"),
      capEntry("entry_team", "ALL"),
      capEntry("entry_create", "ALL"),
      capEntry("submission_create", "ALL"),
      capEntry("entry_privileged_edit", "ALL"),
      capEntry("entry_restore", "ALL"),
      capEntry("recruiter_master_manage", "ALL"),
      capEntry("team_master_manage", "ALL"),
      capEntry("audit_view", "ALL"),
      capEntry("worker_edit_history_view", "ALL"),
      capEntry("document_upload", "ALL"),
      capEntry("document_view", "ALL"),
      capEntry("employment_status.review", "ALL"),
      capEntry("employment_status.apply", "ALL"),
      capEntry("change_request_create", "ALL", true),
      capEntry("change_review", "ALL", true),
      capEntry("employment_status.request", "ALL", true),
      capEntry("duplicate_cccd_withdraw", "ALL"),
      capEntry("report_view", "ALL"),
      capEntry("report_analytics_view", "ALL"),
    ],
  },
  TEAM_LEADER: {
    role_code: "TEAM_LEADER",
    display_name: "Trưởng nhóm (Team Leader)",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "team",
    requires_active_person: false,
    is_assignable_global: false,
    capabilities: [
      capEntry("entry_team", "CONTEXT_TEAM"),
      capEntry("team_manager_assign", "CONTEXT_TEAM"),
      capEntry("report_view", "CONTEXT_TEAM"),
      capEntry("report_analytics_view", "CONTEXT_TEAM"),
      capEntry("report_assign", "CONTEXT_TEAM"),
    ],
  },
  DEPARTMENT_HEAD: {
    role_code: "DEPARTMENT_HEAD",
    display_name: "Trưởng phòng ban",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "department",
    requires_active_person: true,
    is_assignable_global: false,
    capabilities: [],
  },
  PROJECT_MANAGER: {
    role_code: "PROJECT_MANAGER",
    display_name: "Quản lý dự án (PM)",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "project",
    requires_active_person: false,
    is_assignable_global: false,
    capabilities: [],
  },
  PROJECT_ACCOUNTANT: {
    role_code: "PROJECT_ACCOUNTANT",
    display_name: "Kế toán dự án",
    assignment_mode: "CONTEXTUAL",
    fixed_scope_kind: "project",
    requires_active_person: false,
    is_assignable_global: false,
    capabilities: [capEntry("vendor_finance_view", "CONTEXT_PROJECT")],
  },
});

function assertCatalogInvariants() {
  const roleCodes = Object.keys(WP5_ROLE_CATALOG);
  if (roleCodes.length !== 8) {
    throw new Error(`WP5_ROLE_CATALOG must define exactly 8 roles, found ${roleCodes.length}`);
  }
  if (roleCodes.includes("BOD") || roleCodes.includes("BOD_ADMIN")) {
    throw new Error("WP5_ROLE_CATALOG must not define BOD or BOD_ADMIN");
  }

  const activeSet = new Set(ACTIVE_29_CAPABILITIES);
  const adminCaps = WP5_ROLE_CATALOG.ADMIN.capabilities.map((c) => c.capability);
  const adminCapSet = new Set(adminCaps);
  const excludedSet = new Set(ADMIN_NON_AUTO_GRANT_TOKENS);

  if (adminCaps.length !== 21 || adminCapSet.size !== 21) {
    throw new Error(`ADMIN must define exactly 21 unique capabilities, found ${adminCaps.length}`);
  }
  if (ADMIN_NON_AUTO_GRANT_TOKENS.length !== 8 || excludedSet.size !== 8) {
    throw new Error("ADMIN_NON_AUTO_GRANT_TOKENS must define exactly 8 unique capabilities");
  }
  for (const token of excludedSet) {
    if (!activeSet.has(token) || adminCapSet.has(token)) {
      throw new Error(`Invalid ADMIN excluded token partition at ${token}`);
    }
  }
  for (const token of adminCapSet) {
    if (!activeSet.has(token)) {
      throw new Error(`Unknown ADMIN capability token: ${token}`);
    }
  }
  if (adminCapSet.size + excludedSet.size !== activeSet.size) {
    throw new Error("ADMIN capabilities + excluded tokens must partition all 29 active capabilities");
  }
}

assertCatalogInvariants();

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUuid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!UUID_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Normalizes an email address using canonical `lower(btrim(email))` semantics.
 * Returns `null` for non-string, malformed, empty, or whitespace-containing values.
 */
export function normalizeCanonicalEmail(email) {
  if (typeof email !== "string") {
    return null;
  }
  if (CONTROL_CHAR_PATTERN.test(email)) {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || WHITESPACE_PATTERN.test(normalized)) {
    return null;
  }
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0 || atIndex !== normalized.lastIndexOf("@")) {
    return null;
  }
  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);
  if (
    localPart.length === 0 ||
    domainPart.length < 3 ||
    domainPart.startsWith(".") ||
    domainPart.endsWith(".") ||
    domainPart.includes("..") ||
    !domainPart.includes(".")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Exact canonical Owner email check (`lower(btrim(email)) === "nobita6986@gmail.com"`).
 * Rejects same local-part on any other domain (e.g. `nobita6986@hrpartner.vn`).
 */
export function isCanonicalOwnerEmail(email) {
  return normalizeCanonicalEmail(email) === CANONICAL_OWNER_EMAIL;
}

function extractEmailLocalPart(normalizedEmail) {
  if (typeof normalizedEmail !== "string") return null;
  const atIndex = normalizedEmail.indexOf("@");
  if (atIndex <= 0) return null;
  return normalizedEmail.slice(0, atIndex);
}

function resolveAccountLoginId(account, normalizedEmail) {
  if (isRecord(account) && typeof account.login_id === "string") {
    const trimmed = account.login_id.trim().toLowerCase();
    if (trimmed.length > 0 && !CONTROL_CHAR_PATTERN.test(trimmed) && !WHITESPACE_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return extractEmailLocalPart(normalizedEmail);
}

function extractAccountId(account) {
  if (!isRecord(account)) return null;
  return normalizeUuid(account.app_user_id ?? account.account_ref);
}

/**
 * Resolves the single canonical Owner account from an account snapshot array.
 * Fails closed on 0 matches or >1 exact matches, and strictly rejects same-local-part
 * collisions on non-canonical domains without synthesizing or auto-creating accounts.
 */
export function resolveCanonicalOwnerAccount(accounts) {
  if (!Array.isArray(accounts)) {
    throw new TypeError("resolveCanonicalOwnerAccount requires an accounts array");
  }

  const ownerLocalPart = extractEmailLocalPart(CANONICAL_OWNER_EMAIL);
  const exactMatches = [];
  const rejectedLocalPartCollisions = [];

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (!isRecord(account)) {
      throw new TypeError(`Account entry at index ${index} must be an object`);
    }

    const rawEmail = account.email ?? account.auth_email ?? null;
    const normalizedEmail = normalizeCanonicalEmail(rawEmail);

    if (normalizedEmail === CANONICAL_OWNER_EMAIL) {
      exactMatches.push({ account, index, normalizedEmail });
      continue;
    }

    const localPart = extractEmailLocalPart(normalizedEmail);
    if (localPart === ownerLocalPart) {
      rejectedLocalPartCollisions.push({
        index,
        app_user_id: extractAccountId(account),
        email: normalizedEmail,
        login_id: resolveAccountLoginId(account, normalizedEmail),
      });
    }
  }

  if (exactMatches.length === 0) {
    const collisionNote =
      rejectedLocalPartCollisions.length > 0
        ? ` (ignored ${rejectedLocalPartCollisions.length} non-canonical local-part collision(s))`
        : "";
    throw new Error(
      `CANONICAL_OWNER_NOT_FOUND: exact canonical email ${CANONICAL_OWNER_EMAIL} matched 0 accounts${collisionNote}`,
    );
  }

  if (exactMatches.length > 1) {
    throw new Error(
      `CANONICAL_OWNER_AMBIGUOUS: exact canonical email ${CANONICAL_OWNER_EMAIL} matched ${exactMatches.length} accounts`,
    );
  }

  const matched = exactMatches[0];
  const appUserId = extractAccountId(matched.account);
  if (!appUserId) {
    throw new Error(
      `CANONICAL_OWNER_INVALID_ACCOUNT_ID: matched ${CANONICAL_OWNER_EMAIL} at index ${matched.index} has missing or invalid UUID`,
    );
  }

  return deepFreeze({
    app_user_id: appUserId,
    account_ref: appUserId,
    email: CANONICAL_OWNER_EMAIL,
    login_id: resolveAccountLoginId(matched.account, matched.normalizedEmail) ?? ownerLocalPart,
    display_name:
      typeof matched.account.display_name === "string" && matched.account.display_name.trim().length > 0
        ? matched.account.display_name.trim()
        : null,
    enabled: typeof matched.account.enabled === "boolean" ? matched.account.enabled : null,
    version: Number.isInteger(matched.account.version) ? matched.account.version : null,
    rejected_local_part_collisions: rejectedLocalPartCollisions,
  });
}

function resolveInitialAdminMember(accounts, loginId) {
  const matches = [];

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    if (!isRecord(account)) {
      throw new TypeError(`Account entry at index ${index} must be an object`);
    }
    const rawEmail = account.email ?? account.auth_email ?? null;
    const normalizedEmail = normalizeCanonicalEmail(rawEmail);
    const resolvedLogin = resolveAccountLoginId(account, normalizedEmail);
    if (resolvedLogin === loginId) {
      matches.push({ account, index, normalizedEmail });
    }
  }

  if (matches.length === 0) {
    throw new Error(`INITIAL_ADMIN_NOT_FOUND: login_id "${loginId}" matched 0 accounts`);
  }
  if (matches.length > 1) {
    throw new Error(
      `INITIAL_ADMIN_AMBIGUOUS: login_id "${loginId}" matched ${matches.length} accounts`,
    );
  }

  const matched = matches[0];
  const appUserId = extractAccountId(matched.account);
  if (!appUserId) {
    throw new Error(
      `INITIAL_ADMIN_INVALID_ACCOUNT_ID: login_id "${loginId}" has missing or invalid UUID`,
    );
  }
  if (matched.account.enabled === false) {
    throw new Error(
      `INITIAL_ADMIN_ACCOUNT_DISABLED: login_id "${loginId}" (${appUserId}) is disabled`,
    );
  }

  return {
    app_user_id: appUserId,
    account_ref: appUserId,
    login_id: loginId,
    email: matched.normalizedEmail,
    display_name:
      typeof matched.account.display_name === "string" && matched.account.display_name.trim().length > 0
        ? matched.account.display_name.trim()
        : null,
    enabled: matched.account.enabled ?? true,
    version: Number.isInteger(matched.account.version) ? matched.account.version : null,
  };
}

function canonicalSortJson(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalSortJson);
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalSortJson(value[key]);
  }
  return sorted;
}

/**
 * Builds a pure, deterministic dry-run PR 2 cutover plan from an input accounts snapshot.
 * Does NOT execute database queries or mutate state.
 */
export function buildWp5CutoverPlan(accounts) {
  const owner = resolveCanonicalOwnerAccount(accounts);
  if (owner.enabled === false) {
    throw new Error(
      `CANONICAL_OWNER_DISABLED: canonical owner ${CANONICAL_OWNER_EMAIL} (${owner.app_user_id}) is disabled`,
    );
  }

  const initialMembers = [];
  const seenAccountIds = new Set([owner.app_user_id]);

  for (const loginId of INITIAL_ADMIN_LOGIN_IDS) {
    const member = resolveInitialAdminMember(accounts, loginId);
    if (member.app_user_id === owner.app_user_id) {
      throw new Error(
        `INITIAL_ADMIN_OWNER_COLLISION: login_id "${loginId}" overlaps canonical owner ${owner.app_user_id}`,
      );
    }
    if (seenAccountIds.has(member.app_user_id)) {
      throw new Error(
        `INITIAL_ADMIN_DUPLICATE_ACCOUNT_ID: login_id "${loginId}" shares app_user_id ${member.app_user_id}`,
      );
    }
    seenAccountIds.add(member.app_user_id);
    initialMembers.push(member);
  }

  const luanptMember = initialMembers.find((m) => m.login_id === "luanpt");
  const ngatttMember = initialMembers.find((m) => m.login_id === "ngattt");

  const adminAssignments = [
    ...initialMembers.map((member) => ({
      app_user_id: member.app_user_id,
      account_ref: member.app_user_id,
      login_id: member.login_id,
      email: member.email,
      display_name: member.display_name,
      role_code: "ADMIN",
      role_display_name: WP5_ROLE_CATALOG.ADMIN.display_name,
      scope_kind: "all",
      scope_ref: null,
      source_kind: "BACKFILL_SNAPSHOT",
      is_canonical_owner: false,
      is_protected: false,
      protected_reason: null,
      can_revoke: true,
      cannot_revoke_reason: null,
      authz_managed: true,
      reason: "WP5_PR2_CUTOVER_UNIFIED_ADMIN_INITIAL_GROUP",
    })),
    {
      app_user_id: owner.app_user_id,
      account_ref: owner.app_user_id,
      login_id: owner.login_id,
      email: owner.email,
      display_name: owner.display_name,
      role_code: "ADMIN",
      role_display_name: WP5_ROLE_CATALOG.ADMIN.display_name,
      scope_kind: "all",
      scope_ref: null,
      source_kind: "BACKFILL_SNAPSHOT",
      is_canonical_owner: true,
      is_protected: true,
      protected_reason: PROTECTED_OWNER_REASON,
      can_revoke: false,
      cannot_revoke_reason: PROTECTED_OWNER_REASON,
      authz_managed: true,
      reason: "WP5_PR2_CUTOVER_CANONICAL_OWNER_PROTECTED_ADMIN",
    },
  ];

  const protectedCount = adminAssignments.filter((entry) => entry.is_protected).length;
  if (protectedCount !== 1) {
    throw new Error(`Protected assignment invariant failed: expected 1, got ${protectedCount}`);
  }

  const enabledManagedIds = [];
  const disabledPreservedIds = [];
  for (const account of accounts) {
    const id = extractAccountId(account);
    if (!id) continue;
    if (account.enabled === false) {
      disabledPreservedIds.push(id);
    } else if (!enabledManagedIds.includes(id)) {
      enabledManagedIds.push(id);
    }
  }
  for (const adminId of seenAccountIds) {
    if (!enabledManagedIds.includes(adminId)) {
      enabledManagedIds.push(adminId);
    }
  }
  enabledManagedIds.sort();
  disabledPreservedIds.sort();

  const planBody = {
    schema_version: WP5_CUTOVER_MANIFEST_VERSION,
    mode: "DRY_RUN_PR2_CUTOVER_PLAN",
    dry_run: true,
    canonical_owner_email: CANONICAL_OWNER_EMAIL,
    owner_resolution: {
      app_user_id: owner.app_user_id,
      login_id: owner.login_id,
      email: owner.email,
      is_protected: true,
      protected_reason: PROTECTED_OWNER_REASON,
      rejected_local_part_collisions: owner.rejected_local_part_collisions,
    },
    role_catalog_summary: {
      role_count: Object.keys(WP5_ROLE_CATALOG).length,
      global_role_codes: Object.values(WP5_ROLE_CATALOG)
        .filter((role) => role.assignment_mode === "GLOBAL")
        .map((role) => role.role_code),
      contextual_role_codes: Object.values(WP5_ROLE_CATALOG)
        .filter((role) => role.assignment_mode === "CONTEXTUAL")
        .map((role) => role.role_code),
      admin_role_code: "ADMIN",
      admin_display_name: WP5_ROLE_CATALOG.ADMIN.display_name,
      admin_capability_count: WP5_ROLE_CATALOG.ADMIN.capabilities.length,
      admin_excluded_tokens: [...ADMIN_NON_AUTO_GRANT_TOKENS],
    },
    admin_assignments: adminAssignments,
    legacy_remediations: [
      {
        action: "CLOSE_UNMAPPED_ALL_SCOPE",
        table: "public.direct_entry_scope_grants",
        app_user_id: luanptMember.app_user_id,
        login_id: "luanpt",
        scope_kind: "all",
        reason: "WP5_PR2_CUTOVER_REPLACE_UNMAPPED_ALL_SCOPE_WITH_ADMIN",
      },
      {
        action: "ABSORB_CCCD_EXCEPTION_INTO_ADMIN_BUNDLE",
        capability: "duplicate_cccd_withdraw",
        app_user_ids: [ngatttMember.app_user_id, owner.app_user_id].sort(),
        reason: "WP5_PR2_CUTOVER_UNIFY_DUPLICATE_CCCD_WITHDRAW_IN_ADMIN",
      },
    ],
    account_state_updates: {
      set_authz_managed_true_app_user_ids: enabledManagedIds,
      disabled_accounts_zero_effective_grants_ids: disabledPreservedIds,
    },
    system_state_transition: {
      table: "public.authz_system_state",
      before: { cutover_ready: false },
      after: { cutover_ready: true },
    },
    invariants: {
      protected_assignment_count: protectedCount,
      protected_only_on_canonical_owner: true,
      no_last_admin_lock: true,
      recruitment_post_create_pm_only: true,
      admin_excluded_tokens_verified: true,
      rejected_local_part_collision_count: owner.rejected_local_part_collisions.length,
    },
  };

  const planFingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalSortJson(planBody)))
    .digest("hex");

  return deepFreeze({
    ...planBody,
    plan_fingerprint: planFingerprint,
  });
}
