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

export const INTENTIONAL_POLICY_CHANGE_REASONS = Object.freeze({
  INITIAL_ADMIN_UNIFIED_BUNDLE: "INITIAL_ADMIN_UNIFIED_BUNDLE",
  LUANPT_ORPHAN_ALL_TO_UNIFIED_ADMIN: "LUANPT_ORPHAN_ALL_TO_UNIFIED_ADMIN",
  TEAM_LEADER_BUNDLE_ENTRY_TEAM_NORMALIZED: "TEAM_LEADER_BUNDLE_ENTRY_TEAM_NORMALIZED",
  CATALOG_ONLY_TEAM_LEADER_MUTATION_TIGHTENED: "CATALOG_ONLY_TEAM_LEADER_MUTATION_TIGHTENED",
  UNPAIRED_ALL_REPORTING_TIGHTENED: "UNPAIRED_ALL_REPORTING_TIGHTENED",
  WORKER_EDIT_HISTORY_ALLOWLIST_TO_CAPABILITY: "WORKER_EDIT_HISTORY_ALLOWLIST_TO_CAPABILITY",
  AI_SETTINGS_LOCKED_TO_FULL_ADMIN: "AI_SETTINGS_LOCKED_TO_FULL_ADMIN",
});

const OWN_ELIGIBLE_CAPABILITIES = new Set(
  WP5_ROLE_CATALOG.RECRUITER.capabilities.map((c) => c.capability),
);
const RECRUITER_REQUIRED_CAPABILITIES = WP5_ROLE_CATALOG.RECRUITER.capabilities.map(
  (c) => c.capability,
);
const HR_OPERATOR_REQUIRED_CAPABILITIES = WP5_ROLE_CATALOG.HR_OPERATOR.capabilities.map(
  (c) => c.capability,
);
const TEAM_SCOPED_LEGACY_CAPABILITIES = new Set([
  "entry_team",
  "team_manager_assign",
  "report_view",
  "report_analytics_view",
  "report_assign",
  "report_review",
]);
const FULL_ADMIN_TRIPLE = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

function grantKey(grant) {
  return `${grant.capability}::${grant.scope_kind}::${grant.scope_id ?? ""}`;
}

function dedupeSortedGrants(grants) {
  const byKey = new Map();
  for (const grant of grants) {
    const key = grantKey(grant);
    if (!byKey.has(key)) {
      byKey.set(key, {
        capability: grant.capability,
        scope_kind: grant.scope_kind,
        scope_id: grant.scope_id ?? null,
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.capability.localeCompare(b.capability) ||
    a.scope_kind.localeCompare(b.scope_kind) ||
    String(a.scope_id ?? "").localeCompare(String(b.scope_id ?? "")),
  );
}

function resolveAccountPreCutoverLegacyPairedGrants(account, inventory) {
  if (!account.enabled) {
    return [];
  }
  const appUserId = account.app_user_id;
  const caps = new Set(
    (inventory.capability_grants ?? [])
      .filter((g) => g.app_user_id === appUserId)
      .map((g) => g.capability),
  );
  const scopes = (inventory.scope_grants ?? []).filter((g) => g.app_user_id === appUserId);
  const hasAll = scopes.some((s) => s.scope_kind === "all");
  const hasOwn = scopes.some((s) => s.scope_kind === "own");
  const teamIds = [...new Set(
    scopes
      .filter((s) => s.scope_kind === "team" && typeof s.team_id === "string")
      .map((s) => s.team_id.toLowerCase()),
  )].sort();

  const paired = [];
  if (hasAll) {
    for (const cap of caps) {
      if (cap !== "entry_own") {
        paired.push({ capability: cap, scope_kind: "ALL", scope_id: null });
      }
    }
  }
  if (hasOwn) {
    for (const cap of caps) {
      if (OWN_ELIGIBLE_CAPABILITIES.has(cap)) {
        paired.push({ capability: cap, scope_kind: "OWN", scope_id: null });
      }
    }
  }
  for (const teamId of teamIds) {
    for (const cap of caps) {
      if (TEAM_SCOPED_LEGACY_CAPABILITIES.has(cap)) {
        paired.push({ capability: cap, scope_kind: "CONTEXT_TEAM", scope_id: teamId });
      }
    }
  }
  for (const tl of inventory.team_leader_assignments ?? []) {
    if (tl.leader_app_user_id === appUserId) {
      for (const entry of WP5_ROLE_CATALOG.TEAM_LEADER.capabilities) {
        if (caps.has(entry.capability)) {
          paired.push({
            capability: entry.capability,
            scope_kind: "CONTEXT_TEAM",
            scope_id: tl.team_id.toLowerCase(),
          });
        }
      }
    }
  }
  for (const wr of inventory.wr_tl_capability_grants ?? []) {
    if (wr.app_user_id === appUserId && wr.capability === "report_review") {
      paired.push({
        capability: "report_review",
        scope_kind: "CONTEXT_TEAM",
        scope_id: wr.team_id.toLowerCase(),
      });
    }
  }
  for (const pa of inventory.project_accountants ?? []) {
    if (pa.accountant_user_id === appUserId) {
      paired.push({
        capability: "vendor_finance_view",
        scope_kind: "CONTEXT_PROJECT",
        scope_id: pa.project_id,
      });
    }
  }
  return dedupeSortedGrants(paired);
}

function sortNormalizedRows(rows) {
  return [...rows].sort((a, b) =>
    JSON.stringify(canonicalSortJson(a)).localeCompare(JSON.stringify(canonicalSortJson(b))),
  );
}

function buildRoleAssignmentsAndExceptions({
  uid,
  loginId,
  rolesForAccount,
  contextualRoles,
  pairedGrants,
  wrTls,
  existingDirectGrants = [],
  canonicalOwnerId,
}) {
  const coveredGrants = [];
  for (const roleCode of rolesForAccount) {
    for (const cap of WP5_ROLE_CATALOG[roleCode].capabilities) {
      coveredGrants.push({
        capability: cap.capability,
        scope_kind: cap.scope_template,
        scope_id: null,
      });
    }
  }
  for (const ctxRole of contextualRoles) {
    for (const cap of WP5_ROLE_CATALOG[ctxRole.role_code].capabilities) {
      coveredGrants.push({
        capability: cap.capability,
        scope_kind: ctxRole.scope_kind,
        scope_id: ctxRole.scope_id,
      });
    }
  }
  for (const wr of wrTls) {
    coveredGrants.push({
      capability: "report_review",
      scope_kind: "CONTEXT_TEAM",
      scope_id: wr.team_id,
    });
  }

  const coveredKeySet = new Set(coveredGrants.map(grantKey));
  const exceptions = [];
  for (const grant of [...pairedGrants, ...existingDirectGrants]) {
    const key = grantKey(grant);
    if (coveredKeySet.has(key)) continue;
    coveredKeySet.add(key);
    exceptions.push({
      app_user_id: uid,
      capability: grant.capability,
      scope_kind: grant.scope_kind,
      scope_id: grant.scope_id ?? null,
      source_kind: "BACKFILL_EXCEPTION",
      reason: `WP5_PR2_CUTOVER_PRESERVE_INDEPENDENT_${grant.capability}`.slice(0, 500),
    });
  }

  const postGrants = dedupeSortedGrants([
    ...coveredGrants,
    ...exceptions.map((e) => ({
      capability: e.capability,
      scope_kind: e.scope_kind,
      scope_id: e.scope_id,
    })),
  ]);

  const roleRows = rolesForAccount.map((roleCode) => {
    const isProtected = roleCode === "ADMIN" && uid === canonicalOwnerId;
    return {
      app_user_id: uid,
      login_id: loginId,
      role_code: roleCode,
      source_kind: "BACKFILL_SNAPSHOT",
      is_protected: isProtected,
      protected_reason: isProtected ? PROTECTED_OWNER_REASON : null,
      reason: isProtected
        ? "WP5_PR2_CUTOVER_CANONICAL_OWNER_PROTECTED_ADMIN"
        : `WP5_PR2_CUTOVER_BACKFILL_${roleCode}`,
    };
  });

  return { roleRows, exceptions, postGrants };
}

/**
 * Builds the full deterministic WP5B-2 cutover manifest from a read-only DB inventory
 * snapshot (without mutating DB or synthesizing missing Person/Recruiter records).
 */
export function buildWp5FullCutoverManifest(inventory) {
  if (!isRecord(inventory) || !Array.isArray(inventory.accounts)) {
    throw new TypeError("buildWp5FullCutoverManifest requires inventory with accounts[]");
  }

  const normalizedAccounts = inventory.accounts.map((row, index) => {
    const appUserId = extractAccountId(row);
    if (!appUserId) {
      throw new Error(`INVENTORY_INVALID_ACCOUNT_ID at index ${index}`);
    }
    const authSubject = normalizeUuid(row.auth_subject);
    if (!authSubject) {
      throw new Error(`INVENTORY_INVALID_AUTH_SUBJECT for account ${appUserId}`);
    }
    const rawEmail = row.email ?? row.auth_email ?? null;
    const normalizedEmail = normalizeCanonicalEmail(rawEmail);
    const loginId = resolveAccountLoginId(row, normalizedEmail);
    return {
      app_user_id: appUserId,
      auth_subject: authSubject,
      login_id: loginId,
      email: normalizedEmail,
      display_name: typeof row.display_name === "string" ? row.display_name.trim() : "",
      enabled: row.enabled === true,
      account_type: typeof row.account_type === "string" ? row.account_type : "NORMAL",
      authz_managed: row.authz_managed === true,
      version: Number.isInteger(row.version) ? row.version : 1,
    };
  });

  const basePlan = buildWp5CutoverPlan(normalizedAccounts);
  const initialAdminIds = new Set(basePlan.admin_assignments.map((a) => a.app_user_id));
  const canonicalOwnerId = basePlan.owner_resolution.app_user_id;
  const canonicalOwnerAuthSubject =
    normalizedAccounts.find((a) => a.app_user_id === canonicalOwnerId)?.auth_subject ?? null;

  const capGrantsByUser = new Map();
  for (const cg of inventory.capability_grants ?? []) {
    const uid = normalizeUuid(cg.app_user_id);
    if (!uid || typeof cg.capability !== "string") continue;
    if (!capGrantsByUser.has(uid)) capGrantsByUser.set(uid, new Set());
    capGrantsByUser.get(uid).add(cg.capability);
  }

  const scopeGrantsByUser = new Map();
  for (const sg of inventory.scope_grants ?? []) {
    const uid = normalizeUuid(sg.app_user_id);
    if (!uid) continue;
    if (!scopeGrantsByUser.has(uid)) scopeGrantsByUser.set(uid, []);
    scopeGrantsByUser.get(uid).push({
      grant_id: normalizeUuid(sg.grant_id),
      scope_kind: sg.scope_kind,
      team_id: normalizeUuid(sg.team_id),
    });
  }

  const recruiterLinksByUser = new Map();
  for (const rl of inventory.recruiter_links ?? []) {
    const uid = normalizeUuid(rl.app_user_id);
    const rid = normalizeUuid(rl.recruiter_id);
    if (!uid || !rid) continue;
    if (!recruiterLinksByUser.has(uid)) recruiterLinksByUser.set(uid, []);
    recruiterLinksByUser.get(uid).push({
      link_id: normalizeUuid(rl.link_id),
      recruiter_id: rid,
      recruiter_active: rl.recruiter_active !== false,
    });
  }

  const tlByUser = new Map();
  for (const tl of inventory.team_leader_assignments ?? []) {
    const uid = normalizeUuid(tl.leader_app_user_id);
    const tid = normalizeUuid(tl.team_id);
    if (!uid || !tid) continue;
    if (!tlByUser.has(uid)) tlByUser.set(uid, []);
    tlByUser.get(uid).push({
      assignment_id: normalizeUuid(tl.assignment_id),
      team_id: tid,
    });
  }

  const wrTlByUser = new Map();
  for (const wr of inventory.wr_tl_capability_grants ?? []) {
    const uid = normalizeUuid(wr.app_user_id);
    const tid = normalizeUuid(wr.team_id);
    if (!uid || !tid || wr.capability !== "report_review") continue;
    if (!wrTlByUser.has(uid)) wrTlByUser.set(uid, []);
    wrTlByUser.get(uid).push({
      leader_assignment_id: normalizeUuid(wr.leader_assignment_id),
      team_id: tid,
      grant_id: normalizeUuid(wr.grant_id),
    });
  }

  const deptHeadByUser = new Map();
  for (const dh of inventory.department_heads ?? []) {
    const uid = normalizeUuid(dh.app_user_id);
    const did = normalizeUuid(dh.department_id);
    if (!uid || !did) continue;
    if (!deptHeadByUser.has(uid)) deptHeadByUser.set(uid, []);
    deptHeadByUser.get(uid).push({
      head_id: normalizeUuid(dh.head_id),
      department_id: did,
      person_active: dh.person_active === true,
    });
  }

  const pmByUser = new Map();
  for (const pm of inventory.project_managers ?? []) {
    const uid = normalizeUuid(pm.app_user_id);
    if (!uid || typeof pm.project_id !== "string") continue;
    if (!pmByUser.has(uid)) pmByUser.set(uid, []);
    pmByUser.get(uid).push({
      assignment_id: normalizeUuid(pm.assignment_id),
      project_id: pm.project_id,
    });
  }

  const paByUser = new Map();
  for (const pa of inventory.project_accountants ?? []) {
    const uid = normalizeUuid(pa.accountant_user_id);
    if (!uid || typeof pa.project_id !== "string") continue;
    if (!paByUser.has(uid)) paByUser.set(uid, []);
    paByUser.get(uid).push({
      assignment_id: normalizeUuid(pa.assignment_id),
      project_id: pa.project_id,
    });
  }

  const personLinksByUser = new Map();
  for (const pl of inventory.open_person_links ?? []) {
    const uid = normalizeUuid(pl.app_user_id);
    const pid = normalizeUuid(pl.person_id);
    if (!uid || !pid) continue;
    if (!personLinksByUser.has(uid)) personLinksByUser.set(uid, []);
    personLinksByUser.get(uid).push({
      person_id: pid,
      person_status: pl.person_status ?? "ACTIVE",
    });
  }

  const suspendedCapsByUser = new Map();
  for (const cg of inventory.suspended_capability_grants ?? []) {
    const uid = normalizeUuid(cg.app_user_id);
    if (!uid || typeof cg.capability !== "string") continue;
    if (!suspendedCapsByUser.has(uid)) suspendedCapsByUser.set(uid, new Set());
    suspendedCapsByUser.get(uid).add(cg.capability);
  }

  const suspendedScopesByUser = new Map();
  for (const sg of inventory.suspended_scope_grants ?? []) {
    const uid = normalizeUuid(sg.app_user_id);
    if (!uid) continue;
    if (!suspendedScopesByUser.has(uid)) suspendedScopesByUser.set(uid, []);
    suspendedScopesByUser.get(uid).push({
      grant_id: normalizeUuid(sg.grant_id),
      scope_kind: sg.scope_kind,
      team_id: normalizeUuid(sg.team_id),
    });
  }

  const suspendedRecruiterLinksByUser = new Map();
  for (const rl of inventory.suspended_recruiter_links ?? []) {
    const uid = normalizeUuid(rl.app_user_id);
    const rid = normalizeUuid(rl.recruiter_id);
    if (!uid || !rid) continue;
    if (!suspendedRecruiterLinksByUser.has(uid)) suspendedRecruiterLinksByUser.set(uid, []);
    suspendedRecruiterLinksByUser.get(uid).push({
      link_id: normalizeUuid(rl.link_id),
      recruiter_id: rid,
      recruiter_active: rl.recruiter_active !== false,
    });
  }

  const suspendedTlByUser = new Map();
  for (const tl of inventory.suspended_team_leader_assignments ?? []) {
    const uid = normalizeUuid(tl.leader_app_user_id);
    const tid = normalizeUuid(tl.team_id);
    if (!uid || !tid) continue;
    if (!suspendedTlByUser.has(uid)) suspendedTlByUser.set(uid, []);
    suspendedTlByUser.get(uid).push({
      assignment_id: normalizeUuid(tl.assignment_id),
      team_id: tid,
    });
  }

  const suspendedWrTlByUser = new Map();
  for (const wr of inventory.suspended_wr_tl_capability_grants ?? []) {
    const uid = normalizeUuid(wr.app_user_id);
    const tid = normalizeUuid(wr.team_id);
    if (!uid || !tid || wr.capability !== "report_review") continue;
    if (!suspendedWrTlByUser.has(uid)) suspendedWrTlByUser.set(uid, []);
    suspendedWrTlByUser.get(uid).push({
      leader_assignment_id: normalizeUuid(wr.leader_assignment_id),
      team_id: tid,
      grant_id: normalizeUuid(wr.grant_id),
    });
  }

  const existingOpenRolesByUser = new Map();
  for (const r of inventory.existing_open_roles ?? []) {
    const uid = normalizeUuid(r.app_user_id);
    if (!uid || typeof r.role_code !== "string") continue;
    if (!existingOpenRolesByUser.has(uid)) existingOpenRolesByUser.set(uid, []);
    existingOpenRolesByUser.get(uid).push({
      role_code: r.role_code,
      is_protected: r.is_protected === true,
    });
  }

  const existingOpenDirectByUser = new Map();
  for (const dg of inventory.existing_open_direct_grants ?? []) {
    const uid = normalizeUuid(dg.app_user_id);
    if (!uid || typeof dg.capability !== "string" || typeof dg.scope_kind !== "string") continue;
    if (!existingOpenDirectByUser.has(uid)) existingOpenDirectByUser.set(uid, []);
    existingOpenDirectByUser.get(uid).push({
      capability: dg.capability,
      scope_kind: dg.scope_kind,
      scope_id: dg.scope_id ?? null,
    });
  }

  // Normalize inventory view keyed by lowercase UUID for helper reuse
  const normalizedInventory = {
    ...inventory,
    capability_grants: (inventory.capability_grants ?? []).map((g) => ({
      ...g,
      app_user_id: normalizeUuid(g.app_user_id),
    })),
    scope_grants: (inventory.scope_grants ?? []).map((g) => ({
      ...g,
      app_user_id: normalizeUuid(g.app_user_id),
      team_id: normalizeUuid(g.team_id),
    })),
    team_leader_assignments: (inventory.team_leader_assignments ?? []).map((t) => ({
      ...t,
      leader_app_user_id: normalizeUuid(t.leader_app_user_id),
      team_id: normalizeUuid(t.team_id),
    })),
    wr_tl_capability_grants: (inventory.wr_tl_capability_grants ?? []).map((w) => ({
      ...w,
      app_user_id: normalizeUuid(w.app_user_id),
      team_id: normalizeUuid(w.team_id),
    })),
    project_accountants: (inventory.project_accountants ?? []).map((p) => ({
      ...p,
      accountant_user_id: normalizeUuid(p.accountant_user_id),
    })),
  };

  const normalizedSuspendedInventory = {
    capability_grants: (inventory.suspended_capability_grants ?? []).map((g) => ({
      ...g,
      app_user_id: normalizeUuid(g.app_user_id),
    })),
    scope_grants: (inventory.suspended_scope_grants ?? []).map((g) => ({
      ...g,
      app_user_id: normalizeUuid(g.app_user_id),
      team_id: normalizeUuid(g.team_id),
    })),
    team_leader_assignments: (inventory.suspended_team_leader_assignments ?? []).map((t) => ({
      ...t,
      leader_app_user_id: normalizeUuid(t.leader_app_user_id),
      team_id: normalizeUuid(t.team_id),
    })),
    wr_tl_capability_grants: (inventory.suspended_wr_tl_capability_grants ?? []).map((w) => ({
      ...w,
      app_user_id: normalizeUuid(w.app_user_id),
      team_id: normalizeUuid(w.team_id),
    })),
    project_accountants: normalizedInventory.project_accountants,
  };

  const accountPlans = [];
  const globalRoleAssignments = [];
  const directGrantExceptions = [];
  const orphanAllScopeRemediations = [];

  for (const account of [...normalizedAccounts].sort((a, b) => a.app_user_id.localeCompare(b.app_user_id))) {
    const uid = account.app_user_id;
    const links = recruiterLinksByUser.get(uid) ?? [];
    const tls = tlByUser.get(uid) ?? [];
    const dhs = deptHeadByUser.get(uid) ?? [];
    const pms = pmByUser.get(uid) ?? [];
    const pas = paByUser.get(uid) ?? [];
    const personLinks = personLinksByUser.get(uid) ?? [];
    const legacyCaps = capGrantsByUser.get(uid) ?? new Set();
    const legacyScopes = scopeGrantsByUser.get(uid) ?? [];
    const suspendedCaps = suspendedCapsByUser.get(uid) ?? new Set();
    const suspendedScopes = suspendedScopesByUser.get(uid) ?? [];
    const suspendedLinks = suspendedRecruiterLinksByUser.get(uid) ?? [];
    const suspendedTls = suspendedTlByUser.get(uid) ?? [];
    const suspendedWrTls = suspendedWrTlByUser.get(uid) ?? [];
    const existingOpenRoles = existingOpenRolesByUser.get(uid) ?? [];
    const existingOpenDirect = existingOpenDirectByUser.get(uid) ?? [];

    if (account.account_type !== "NORMAL") {
      if (
        links.length > 0 ||
        tls.length > 0 ||
        dhs.length > 0 ||
        pms.length > 0 ||
        pas.length > 0 ||
        personLinks.length > 0 ||
        suspendedLinks.length > 0 ||
        suspendedTls.length > 0 ||
        existingOpenRoles.length > 0 ||
        existingOpenDirect.length > 0
      ) {
        throw new Error(
          `NON_NORMAL_ACCOUNT_PERSONAL_ASSIGNMENT_VIOLATION: ${uid} (${account.account_type}) holds personal links or assignments`,
        );
      }
      accountPlans.push({
        app_user_id: uid,
        login_id: account.login_id,
        enabled: account.enabled,
        account_type: account.account_type,
        account_version: account.version,
        d10_suspended: false,
        is_canonical_owner: uid === canonicalOwnerId,
        is_quarantined_no_person: false,
        set_authz_managed: true,
        global_roles: [],
        contextual_roles: [],
        direct_grant_exceptions: [],
        legacy_pre_cutover_grants: resolveAccountPreCutoverLegacyPairedGrants(account, normalizedInventory),
        post_cutover_effective_grants: [],
      });
      continue;
    }

    if (!account.enabled) {
      const hasD10SuspendedState =
        suspendedCaps.size > 0 ||
        suspendedScopes.length > 0 ||
        suspendedLinks.length > 0 ||
        suspendedTls.length > 0 ||
        existingOpenRoles.length > 0 ||
        existingOpenDirect.length > 0;

      if (!hasD10SuspendedState) {
        // Pre-WP5 disabled account: zero roles, zero exceptions, authz_managed = true so legacy never resurrects on future enable.
        accountPlans.push({
          app_user_id: uid,
          login_id: account.login_id,
          enabled: false,
          account_type: account.account_type,
          account_version: account.version,
          d10_suspended: false,
          is_canonical_owner: false,
          is_quarantined_no_person: personLinks.length === 0,
          set_authz_managed: true,
          global_roles: [],
          contextual_roles: [],
          direct_grant_exceptions: [],
          legacy_pre_cutover_grants: [],
          post_cutover_effective_grants: [],
        });
        continue;
      }

      // WP5B-1 D10-suspended account: preserve dormant roles & exceptions (0 effective grants while disabled).
      const dormantPairedGrants = resolveAccountPreCutoverLegacyPairedGrants(
        { ...account, enabled: true },
        normalizedSuspendedInventory,
      );
      const hasSuspendedAllScope = suspendedScopes.some((s) => s.scope_kind === "all");
      const hasSuspendedOwnScope = suspendedScopes.some((s) => s.scope_kind === "own");
      const hasActiveSuspendedRecruiterLink = suspendedLinks.some((l) => l.recruiter_active);
      const holdsFullSuspendedRecruiterBundle =
        hasSuspendedOwnScope &&
        RECRUITER_REQUIRED_CAPABILITIES.every((cap) => suspendedCaps.has(cap));
      const holdsFullSuspendedHrOpBundle =
        hasSuspendedAllScope &&
        HR_OPERATOR_REQUIRED_CAPABILITIES.every((cap) => suspendedCaps.has(cap));

      const dormantRoleSet = new Set(["EMPLOYEE_BASE"]);
      if (existingOpenRoles.some((r) => r.role_code === "ADMIN")) dormantRoleSet.add("ADMIN");
      if (hasActiveSuspendedRecruiterLink || holdsFullSuspendedRecruiterBundle || existingOpenRoles.some((r) => r.role_code === "RECRUITER")) {
        dormantRoleSet.add("RECRUITER");
      }
      if (holdsFullSuspendedHrOpBundle || existingOpenRoles.some((r) => r.role_code === "HR_OPERATOR")) {
        dormantRoleSet.add("HR_OPERATOR");
      }
      const rolesForAccount = [...dormantRoleSet];
      const contextualRoles = [
        ...suspendedTls.map((tl) => ({
          role_code: "TEAM_LEADER",
          scope_kind: "CONTEXT_TEAM",
          scope_id: tl.team_id,
          source_assignment_id: tl.assignment_id,
        })),
        ...dhs
          .filter((dh) => dh.person_active)
          .map((dh) => ({
            role_code: "DEPARTMENT_HEAD",
            scope_kind: "CONTEXT_DEPARTMENT",
            scope_id: dh.department_id,
            source_assignment_id: dh.head_id,
          })),
        ...pms.map((pm) => ({
          role_code: "PROJECT_MANAGER",
          scope_kind: "CONTEXT_PROJECT",
          scope_id: pm.project_id,
          source_assignment_id: pm.assignment_id,
        })),
        ...pas.map((pa) => ({
          role_code: "PROJECT_ACCOUNTANT",
          scope_kind: "CONTEXT_PROJECT",
          scope_id: pa.project_id,
          source_assignment_id: pa.assignment_id,
        })),
      ];

      const { roleRows, exceptions } = buildRoleAssignmentsAndExceptions({
        uid,
        loginId: account.login_id,
        rolesForAccount,
        contextualRoles,
        pairedGrants: dormantPairedGrants,
        wrTls: suspendedWrTls,
        existingDirectGrants: existingOpenDirect,
        canonicalOwnerId,
      });

      globalRoleAssignments.push(...roleRows);
      directGrantExceptions.push(...exceptions);

      accountPlans.push({
        app_user_id: uid,
        login_id: account.login_id,
        enabled: false,
        account_type: account.account_type,
        account_version: account.version,
        d10_suspended: true,
        is_canonical_owner: false,
        is_quarantined_no_person: personLinks.length === 0,
        set_authz_managed: true,
        global_roles: rolesForAccount,
        contextual_roles: contextualRoles,
        direct_grant_exceptions: exceptions,
        legacy_pre_cutover_grants: [],
        post_cutover_effective_grants: [],
      });
      continue;
    }

    const legacyPreGrants = resolveAccountPreCutoverLegacyPairedGrants(account, normalizedInventory);
    const hasAllScope = legacyScopes.some((s) => s.scope_kind === "all");
    const hasOwnScope = legacyScopes.some((s) => s.scope_kind === "own");

    const rolesForAccount = ["EMPLOYEE_BASE"];
    const isInitialAdmin = initialAdminIds.has(uid);
    if (isInitialAdmin || existingOpenRoles.some((r) => r.role_code === "ADMIN")) {
      rolesForAccount.push("ADMIN");
      if (isInitialAdmin && hasAllScope && legacyCaps.size === 0) {
        orphanAllScopeRemediations.push({
          app_user_id: uid,
          login_id: account.login_id,
          action: "CLOSE_UNMAPPED_ALL_SCOPE",
          reason: "WP5_PR2_CUTOVER_REPLACE_UNMAPPED_ALL_SCOPE_WITH_ADMIN",
        });
      }
    }

    const hasActiveRecruiterLink = links.some((l) => l.recruiter_active);
    const holdsFullRecruiterBundle =
      hasOwnScope && RECRUITER_REQUIRED_CAPABILITIES.every((cap) => legacyCaps.has(cap));
    if (
      hasActiveRecruiterLink ||
      (!isInitialAdmin && holdsFullRecruiterBundle) ||
      existingOpenRoles.some((r) => r.role_code === "RECRUITER")
    ) {
      rolesForAccount.push("RECRUITER");
    }

    const holdsFullHrOperatorBundle =
      hasAllScope && HR_OPERATOR_REQUIRED_CAPABILITIES.every((cap) => legacyCaps.has(cap));
    if (
      (!isInitialAdmin && holdsFullHrOperatorBundle) ||
      existingOpenRoles.some((r) => r.role_code === "HR_OPERATOR")
    ) {
      rolesForAccount.push("HR_OPERATOR");
    }

    const contextualRoles = [
      ...tls.map((tl) => ({
        role_code: "TEAM_LEADER",
        scope_kind: "CONTEXT_TEAM",
        scope_id: tl.team_id,
        source_assignment_id: tl.assignment_id,
      })),
      ...dhs
        .filter((dh) => dh.person_active)
        .map((dh) => ({
          role_code: "DEPARTMENT_HEAD",
          scope_kind: "CONTEXT_DEPARTMENT",
          scope_id: dh.department_id,
          source_assignment_id: dh.head_id,
        })),
      ...pms.map((pm) => ({
        role_code: "PROJECT_MANAGER",
        scope_kind: "CONTEXT_PROJECT",
        scope_id: pm.project_id,
        source_assignment_id: pm.assignment_id,
      })),
      ...pas.map((pa) => ({
        role_code: "PROJECT_ACCOUNTANT",
        scope_kind: "CONTEXT_PROJECT",
        scope_id: pa.project_id,
        source_assignment_id: pa.assignment_id,
      })),
    ];

    const { roleRows, exceptions, postGrants } = buildRoleAssignmentsAndExceptions({
      uid,
      loginId: account.login_id,
      rolesForAccount,
      contextualRoles,
      pairedGrants: legacyPreGrants,
      wrTls: wrTlByUser.get(uid) ?? [],
      existingDirectGrants: existingOpenDirect,
      canonicalOwnerId,
    });

    globalRoleAssignments.push(...roleRows);
    directGrantExceptions.push(...exceptions);

    accountPlans.push({
      app_user_id: uid,
      login_id: account.login_id,
      enabled: true,
      account_type: account.account_type,
      account_version: account.version,
      d10_suspended: false,
      is_canonical_owner: uid === canonicalOwnerId,
      is_quarantined_no_person: personLinks.length === 0 && !isInitialAdmin,
      set_authz_managed: true,
      global_roles: rolesForAccount,
      contextual_roles: contextualRoles,
      direct_grant_exceptions: exceptions,
      legacy_pre_cutover_grants: legacyPreGrants,
      post_cutover_effective_grants: postGrants,
    });
  }

  const protectedAssignments = globalRoleAssignments.filter((r) => r.is_protected);
  if (
    protectedAssignments.length !== 1 ||
    protectedAssignments[0].app_user_id !== canonicalOwnerId ||
    protectedAssignments[0].role_code !== "ADMIN"
  ) {
    throw new Error("CUTOVER_PROTECTED_OWNER_INVARIANT_FAILED");
  }

  const sourceSnapshot = {
    recruiter_links: sortNormalizedRows(
      (inventory.recruiter_links ?? []).map((r) => ({
        link_id: normalizeUuid(r.link_id),
        app_user_id: normalizeUuid(r.app_user_id),
        recruiter_id: normalizeUuid(r.recruiter_id),
        recruiter_active: r.recruiter_active !== false,
      })),
    ),
    suspended_recruiter_links: sortNormalizedRows(
      (inventory.suspended_recruiter_links ?? []).map((r) => ({
        link_id: normalizeUuid(r.link_id),
        app_user_id: normalizeUuid(r.app_user_id),
        recruiter_id: normalizeUuid(r.recruiter_id),
        recruiter_active: r.recruiter_active !== false,
      })),
    ),
    team_leader_assignments: sortNormalizedRows(
      (inventory.team_leader_assignments ?? []).map((t) => ({
        assignment_id: normalizeUuid(t.assignment_id),
        leader_app_user_id: normalizeUuid(t.leader_app_user_id),
        team_id: normalizeUuid(t.team_id),
      })),
    ),
    suspended_team_leader_assignments: sortNormalizedRows(
      (inventory.suspended_team_leader_assignments ?? []).map((t) => ({
        assignment_id: normalizeUuid(t.assignment_id),
        leader_app_user_id: normalizeUuid(t.leader_app_user_id),
        team_id: normalizeUuid(t.team_id),
      })),
    ),
    wr_tl_capability_grants: sortNormalizedRows(
      (inventory.wr_tl_capability_grants ?? []).map((w) => ({
        leader_assignment_id: normalizeUuid(w.leader_assignment_id),
        app_user_id: normalizeUuid(w.app_user_id),
        team_id: normalizeUuid(w.team_id),
        capability: w.capability,
        grant_id: normalizeUuid(w.grant_id),
      })),
    ),
    suspended_wr_tl_capability_grants: sortNormalizedRows(
      (inventory.suspended_wr_tl_capability_grants ?? []).map((w) => ({
        leader_assignment_id: normalizeUuid(w.leader_assignment_id),
        app_user_id: normalizeUuid(w.app_user_id),
        team_id: normalizeUuid(w.team_id),
        capability: w.capability,
        grant_id: normalizeUuid(w.grant_id),
      })),
    ),
    department_heads: sortNormalizedRows(
      (inventory.department_heads ?? []).map((d) => ({
        head_id: normalizeUuid(d.head_id),
        app_user_id: normalizeUuid(d.app_user_id),
        department_id: normalizeUuid(d.department_id),
        person_active: d.person_active === true,
      })),
    ),
    project_managers: sortNormalizedRows(
      (inventory.project_managers ?? []).map((p) => ({
        assignment_id: normalizeUuid(p.assignment_id),
        app_user_id: normalizeUuid(p.app_user_id),
        project_id: p.project_id ?? null,
      })),
    ),
    project_accountants: sortNormalizedRows(
      (inventory.project_accountants ?? []).map((p) => ({
        assignment_id: normalizeUuid(p.assignment_id),
        accountant_user_id: normalizeUuid(p.accountant_user_id),
        project_id: p.project_id ?? null,
      })),
    ),
    open_person_links: sortNormalizedRows(
      (inventory.open_person_links ?? []).map((l) => ({
        app_user_id: normalizeUuid(l.app_user_id),
        person_id: normalizeUuid(l.person_id),
        person_status: l.person_status ?? "ACTIVE",
      })),
    ),
    work_report_delegations: sortNormalizedRows(
      (inventory.work_report_delegations ?? []).map((w) => ({
        delegation_id: normalizeUuid(w.delegation_id),
        template_id: normalizeUuid(w.template_id),
        grantee_app_user_id: normalizeUuid(w.grantee_app_user_id),
      })),
    ),
  };

  const manifestBody = {
    schema_version: "wp5b2-full-cutover-manifest-v1",
    authorization_date: inventory.authorization_date ?? null,
    canonical_owner: {
      app_user_id: canonicalOwnerId,
      auth_subject: canonicalOwnerAuthSubject,
      login_id: basePlan.owner_resolution.login_id,
      rejected_local_part_collisions: basePlan.owner_resolution.rejected_local_part_collisions,
    },
    summary: {
      total_accounts: accountPlans.length,
      enabled_accounts: accountPlans.filter((a) => a.enabled).length,
      disabled_accounts: accountPlans.filter((a) => !a.enabled).length,
      d10_suspended_accounts: accountPlans.filter((a) => a.d10_suspended).length,
      admin_count: globalRoleAssignments.filter((r) => r.role_code === "ADMIN").length,
      recruiter_count: globalRoleAssignments.filter((r) => r.role_code === "RECRUITER").length,
      hr_operator_count: globalRoleAssignments.filter((r) => r.role_code === "HR_OPERATOR").length,
      employee_base_count: globalRoleAssignments.filter((r) => r.role_code === "EMPLOYEE_BASE").length,
      team_leader_count: accountPlans.reduce(
        (n, a) => n + a.contextual_roles.filter((c) => c.role_code === "TEAM_LEADER").length,
        0,
      ),
      direct_grant_exception_count: directGrantExceptions.length,
      protected_assignment_count: protectedAssignments.length,
      work_report_delegation_count: (inventory.work_report_delegations ?? []).length,
    },
    source_snapshot: sourceSnapshot,
    account_plans: accountPlans,
    global_role_assignments: globalRoleAssignments,
    direct_grant_exceptions: directGrantExceptions,
    orphan_all_scope_remediations: orphanAllScopeRemediations,
  };

  const manifestFingerprint = createHash("sha256")
    .update(JSON.stringify(canonicalSortJson(manifestBody)))
    .digest("hex");

  return deepFreeze({
    ...manifestBody,
    manifest_fingerprint: manifestFingerprint,
  });
}

function resolveLegacyPreGroupAActions(account, inventory, legacyPreGrants) {
  if (!account.enabled) {
    return {
      reporting_audience: "disabled",
      can_view_deep_workforce: false,
      can_view_worker_edit_history: false,
      can_manage_team_leaders: false,
      can_access_ai_settings: false,
      can_create_recruitment_post_without_pm: false,
    };
  }
  const uid = normalizeUuid(account.app_user_id);
  const scopes = (inventory.scope_grants ?? []).filter((s) => normalizeUuid(s.app_user_id) === uid);
  const caps = new Set(
    (inventory.capability_grants ?? [])
      .filter((c) => normalizeUuid(c.app_user_id) === uid)
      .map((c) => c.capability),
  );
  const links = (inventory.recruiter_links ?? []).filter(
    (l) => normalizeUuid(l.app_user_id) === uid && l.recruiter_active !== false,
  );
  const teamIds = [...new Set(
    scopes
      .filter((s) => s.scope_kind === "team" && typeof s.team_id === "string")
      .map((s) => normalizeUuid(s.team_id)),
  )].sort();

  const hasAllScope = scopes.some((s) => s.scope_kind === "all");
  const reportingAudience = hasAllScope
    ? "all"
    : teamIds.length > 0
      ? `team:${teamIds.join(",")}`
      : links.length === 1
        ? `own:${normalizeUuid(links[0].recruiter_id)}`
        : "own:none";

  const preAllowlistedEmail =
    account.email === CANONICAL_OWNER_EMAIL ||
    account.email === "lienvu@hrpartner.vn" ||
    account.email === "ngattt@hrpartner.vn";

  return {
    reporting_audience: reportingAudience,
    can_view_deep_workforce: hasAllScope,
    can_view_worker_edit_history: preAllowlistedEmail && hasAllScope && caps.has("worker_edit_history_view"),
    can_manage_team_leaders: hasAllScope && caps.has("catalog_master_manage"),
    can_access_ai_settings: true, // Pre-WP5B-2: any authenticated enabled user could hit /api/ai/settings
    can_create_recruitment_post_without_pm: false,
    paired_grant_count: legacyPreGrants.length,
  };
}

function resolvePostCutoverGroupAActions(accountPlan, inventory) {
  if (!accountPlan.enabled) {
    return {
      reporting_audience: "disabled",
      can_view_deep_workforce: false,
      can_view_worker_edit_history: false,
      can_manage_team_leaders: false,
      can_access_ai_settings: false,
      can_create_recruitment_post_without_pm: false,
    };
  }
  const grants = accountPlan.post_cutover_effective_grants;
  const hasPaired = (cap, scopeKind, scopeId = null) =>
    grants.some(
      (g) => g.capability === cap && g.scope_kind === scopeKind && (g.scope_id ?? null) === scopeId,
    );

  const hasAllReporting =
    hasPaired("entry_admin", "ALL") || hasPaired("report_analytics_view", "ALL");
  const teamIds = [...new Set(
    grants
      .filter(
        (g) =>
          g.scope_kind === "CONTEXT_TEAM" &&
          g.scope_id !== null &&
          (g.capability === "entry_team" || g.capability === "report_analytics_view"),
      )
      .map((g) => g.scope_id),
  )].sort();
  const links = (inventory.recruiter_links ?? []).filter(
    (l) => normalizeUuid(l.app_user_id) === accountPlan.app_user_id && l.recruiter_active !== false,
  );
  const hasOwnReporting = hasPaired("entry_own", "OWN") || hasPaired("report_analytics_view", "OWN");

  const reportingAudience = hasAllReporting
    ? "all"
    : teamIds.length > 0
      ? `team:${teamIds.join(",")}`
      : links.length === 1 && hasOwnReporting
        ? `own:${normalizeUuid(links[0].recruiter_id)}`
        : "own:none";

  const isFullAdmin = FULL_ADMIN_TRIPLE.every((cap) => hasPaired(cap, "ALL"));

  return {
    reporting_audience: reportingAudience,
    can_view_deep_workforce: hasAllReporting,
    can_view_worker_edit_history: hasPaired("worker_edit_history_view", "ALL"),
    can_manage_team_leaders: hasPaired("team_master_manage", "ALL"),
    can_access_ai_settings: isFullAdmin,
    can_create_recruitment_post_without_pm: false,
  };
}

/**
 * Compares pre-cutover behavior vs post-cutover manifest behavior per account and
 * separates documented intentional policy transitions from unexpected drift.
 */
export function computeWp5CutoverActionDiff(inventory, manifest) {
  const accountById = new Map(
    (inventory.accounts ?? []).map((a) => [extractAccountId(a), a]),
  );
  const ownerId = manifest.canonical_owner.app_user_id;
  const rows = [];
  let unexpectedDiffCount = 0;
  let intentionalChangeCount = 0;
  let unchangedCount = 0;

  for (const plan of manifest.account_plans) {
    const rawAccount = accountById.get(plan.app_user_id) ?? {
      app_user_id: plan.app_user_id,
      enabled: plan.enabled,
      email: null,
    };
    const normalizedEmail = normalizeCanonicalEmail(rawAccount.email ?? rawAccount.auth_email ?? null);
    const beforeActions = resolveLegacyPreGroupAActions(
      { ...rawAccount, app_user_id: plan.app_user_id, enabled: plan.enabled, email: normalizedEmail },
      inventory,
      plan.legacy_pre_cutover_grants,
    );
    const afterActions = resolvePostCutoverGroupAActions(plan, inventory);

    const beforeKeys = new Set(plan.legacy_pre_cutover_grants.map(grantKey));
    const afterKeys = new Set(plan.post_cutover_effective_grants.map(grantKey));
    const gainedGrants = plan.post_cutover_effective_grants
      .filter((g) => !beforeKeys.has(grantKey(g)))
      .map(grantKey);
    const lostGrants = plan.legacy_pre_cutover_grants
      .filter((g) => !afterKeys.has(grantKey(g)))
      .map(grantKey);

    const isAdmin = plan.global_roles.includes("ADMIN");
    const hasTeamLeader = plan.contextual_roles.some((c) => c.role_code === "TEAM_LEADER");
    const reasons = [];
    const anomalies = [];

    if (!plan.enabled) {
      if (plan.post_cutover_effective_grants.length > 0) {
        anomalies.push("DISABLED_ACCOUNT_HAS_POST_CUTOVER_GRANTS");
      }
      if (afterActions.reporting_audience !== "disabled") {
        anomalies.push("DISABLED_ACCOUNT_REPORTING_NOT_DISABLED");
      }
    } else {
      // Check post-cutover protected invariant and non-leakage of ADMIN bundle
      if (isAdmin) {
        if (!manifest.global_role_assignments.some(
          (r) => r.app_user_id === plan.app_user_id && r.role_code === "ADMIN" && r.is_protected === (plan.app_user_id === ownerId),
        )) {
          anomalies.push("ADMIN_PROTECTION_MISMATCH");
        }
        for (const forbidden of ADMIN_NON_AUTO_GRANT_TOKENS) {
          if (
            afterKeys.has(`${forbidden}::ALL::`) &&
            !beforeKeys.has(`${forbidden}::ALL::`)
          ) {
            anomalies.push(`ADMIN_AUTO_GRANTED_EXCLUDED_TOKEN:${forbidden}`);
          }
        }
      }

      if (lostGrants.length > 0) {
        anomalies.push(`UNEXPECTED_LOST_GRANTS:${lostGrants.join(",")}`);
      }

      if (gainedGrants.length > 0) {
        if (isAdmin && plan.login_id === "luanpt") {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.LUANPT_ORPHAN_ALL_TO_UNIFIED_ADMIN);
        } else if (isAdmin) {
          const allAdminBundleGains = gainedGrants.every((gk) => {
            const [cap, sk] = gk.split("::");
            return WP5_ROLE_CATALOG.ADMIN.capabilities.some(
              (c) => c.capability === cap && c.scope_template === sk,
            );
          });
          if (allAdminBundleGains) {
            reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.INITIAL_ADMIN_UNIFIED_BUNDLE);
          } else {
            anomalies.push(`UNEXPECTED_ADMIN_GAINS:${gainedGrants.join(",")}`);
          }
        } else if (
          hasTeamLeader &&
          (() => {
            const tlTeamIds = new Set(
              plan.contextual_roles
                .filter((c) => c.role_code === "TEAM_LEADER")
                .map((c) => c.scope_id),
            );
            return gainedGrants.every((gk) => {
              const [cap, sk, sid] = gk.split("::");
              return cap === "entry_team" && sk === "CONTEXT_TEAM" && tlTeamIds.has(sid);
            });
          })()
        ) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.TEAM_LEADER_BUNDLE_ENTRY_TEAM_NORMALIZED);
        } else {
          anomalies.push(`UNEXPECTED_NON_ADMIN_GAINS:${gainedGrants.join(",")}`);
        }
      }

      const hadPairedAllReporting =
        beforeKeys.has("entry_admin::ALL::") || beforeKeys.has("report_analytics_view::ALL::");

      if (beforeActions.reporting_audience !== afterActions.reporting_audience) {
        if (
          beforeActions.reporting_audience === "all" &&
          !hadPairedAllReporting &&
          !afterActions.can_view_deep_workforce
        ) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.UNPAIRED_ALL_REPORTING_TIGHTENED);
        } else {
          anomalies.push(
            `UNEXPECTED_REPORTING_AUDIENCE_CHANGE:${beforeActions.reporting_audience}->${afterActions.reporting_audience}`,
          );
        }
      }
      if (beforeActions.can_view_deep_workforce !== afterActions.can_view_deep_workforce) {
        if (
          beforeActions.can_view_deep_workforce &&
          !afterActions.can_view_deep_workforce &&
          !hadPairedAllReporting
        ) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.UNPAIRED_ALL_REPORTING_TIGHTENED);
        } else {
          anomalies.push("UNEXPECTED_DEEP_WORKFORCE_CHANGE");
        }
      }
      if (beforeActions.can_view_worker_edit_history !== afterActions.can_view_worker_edit_history) {
        if (
          isAdmin &&
          !beforeActions.can_view_worker_edit_history &&
          afterActions.can_view_worker_edit_history
        ) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.WORKER_EDIT_HISTORY_ALLOWLIST_TO_CAPABILITY);
        } else {
          anomalies.push("UNEXPECTED_WORKER_EDIT_HISTORY_CHANGE");
        }
      }
      if (beforeActions.can_manage_team_leaders !== afterActions.can_manage_team_leaders) {
        if (beforeActions.can_manage_team_leaders && !afterActions.can_manage_team_leaders) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.CATALOG_ONLY_TEAM_LEADER_MUTATION_TIGHTENED);
        } else if (isAdmin && !beforeActions.can_manage_team_leaders && afterActions.can_manage_team_leaders) {
          reasons.push(
            plan.login_id === "luanpt"
              ? INTENTIONAL_POLICY_CHANGE_REASONS.LUANPT_ORPHAN_ALL_TO_UNIFIED_ADMIN
              : INTENTIONAL_POLICY_CHANGE_REASONS.INITIAL_ADMIN_UNIFIED_BUNDLE,
          );
        } else {
          anomalies.push("UNEXPECTED_TEAM_LEADER_MANAGEMENT_CHANGE");
        }
      }
      if (beforeActions.can_access_ai_settings !== afterActions.can_access_ai_settings) {
        if (beforeActions.can_access_ai_settings && !afterActions.can_access_ai_settings) {
          reasons.push(INTENTIONAL_POLICY_CHANGE_REASONS.AI_SETTINGS_LOCKED_TO_FULL_ADMIN);
        } else {
          anomalies.push("UNEXPECTED_AI_SETTINGS_CHANGE");
        }
      }
      if (afterActions.can_create_recruitment_post_without_pm !== false) {
        anomalies.push("RECRUITMENT_POST_PM_BYPASS_DETECTED");
      }
    }

    const dedupedReasons = [...new Set(reasons)];
    let classification = "UNCHANGED";
    if (anomalies.length > 0) {
      classification = "UNEXPECTED_DIFF";
      unexpectedDiffCount += 1;
    } else if (dedupedReasons.length > 0) {
      classification = "INTENTIONAL_POLICY_CHANGE";
      intentionalChangeCount += 1;
    } else {
      unchangedCount += 1;
    }

    rows.push({
      app_user_id: plan.app_user_id,
      login_id: plan.login_id,
      enabled: plan.enabled,
      classification,
      reasons: dedupedReasons,
      anomalies,
      global_roles: plan.global_roles,
      contextual_roles: plan.contextual_roles.map((c) => `${c.role_code}:${c.scope_id}`),
      direct_grant_exception_count: plan.direct_grant_exceptions.length,
      gained_grants: gainedGrants,
      lost_grants: lostGrants,
      before_actions: {
        reporting_audience: beforeActions.reporting_audience,
        can_view_deep_workforce: beforeActions.can_view_deep_workforce,
        can_view_worker_edit_history: beforeActions.can_view_worker_edit_history,
        can_manage_team_leaders: beforeActions.can_manage_team_leaders,
        can_access_ai_settings: beforeActions.can_access_ai_settings,
      },
      after_actions: afterActions,
    });
  }

  return deepFreeze({
    total_accounts: rows.length,
    unchanged_count: unchangedCount,
    intentional_change_count: intentionalChangeCount,
    unexpected_diff_count: unexpectedDiffCount,
    rows,
  });
}
