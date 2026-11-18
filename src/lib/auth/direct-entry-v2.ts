import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { TeamIdentity } from "../analytics/identity/contracts.ts";
import type { ExplicitRecruiterLink } from "../contracts/direct-entry-v1.ts";

export const DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.7" as const;

export const CAPABILITIES = [
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
  // P3.1-W01A contract foundation. Both tokens are declared here so the DB/TypeScript vocabulary
  // parity stays exact; neither one grants Direct Entry page access, project-admin authority or
  // the full-Admin triple on its own.
  "catalog_master_manage",
  "team_manager_assign",
  "report_form_manage",
  "report_assign",
  "report_view",
  "report_analytics_view",
  "report_review",
  "report_delegate",
  // VFIN-01: Vendor Finance direct-grant capability tokens (both require effective `all` scope).
  "vendor_finance_view",
  "vendor_finance_record",
  "duplicate_cccd_withdraw",
  "worker_edit_history_view",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type ScopeKind = "own" | "team" | "all";

export type EffectiveScope = {
  kind: ScopeKind;
  reference: string;
  valid_from: string;
  valid_to: string | null;
};

export type EffectiveReportReviewScope = {
  kind: "all" | "team";
  team_id?: string | null;
  label?: string;
};

export const WORKER_OPERATIONS_TAB_IDS = [
  "uploader",
  "recruited",
  "managed",
  "team",
  "all",
] as const;

export type WorkerOperationsTabId = (typeof WORKER_OPERATIONS_TAB_IDS)[number];

export type SessionIdentity = {
  auth_subject: string;
  provider: "supabase";
  authenticated_at: string | null;
};

export type AuthzScopeKind =
  | "OWN"
  | "ALL"
  | "CONTEXT_TEAM"
  | "CONTEXT_DEPARTMENT"
  | "CONTEXT_PROJECT";

export type EffectiveGrantSourceType =
  | "ROLE_BUNDLE"
  | "CONTEXTUAL_ASSIGNMENT"
  | "DIRECT_GRANT"
  | "LEGACY_BRIDGE";

export type PairedEffectiveGrant = {
  capability: Capability;
  scope_kind: AuthzScopeKind;
  scope_id: string | null;
  source_type: EffectiveGrantSourceType;
  source_id: string | null;
};

export type AssignedRoleSummary = {
  role_code:
    | "EMPLOYEE_BASE"
    | "RECRUITER"
    | "HR_OPERATOR"
    | "ADMIN"
    | "TEAM_LEADER"
    | "DEPARTMENT_HEAD"
    | "PROJECT_MANAGER"
    | "PROJECT_ACCOUNTANT";
  display_name: string;
  assignment_mode: "GLOBAL" | "CONTEXTUAL";
  scope_kind: AuthzScopeKind | null;
  scope_id: string | null;
  assignment_id: string | null;
  is_protected: boolean;
  can_revoke: boolean;
  cannot_revoke_reason: "PROTECTED_OWNER_ADMIN" | null;
};

export type PairedScopeTarget =
  | { kind: "all" }
  | { kind: "own" }
  | { kind: "team"; team_id: string }
  | { kind: "department"; department_id: string }
  | { kind: "project"; project_id: string };

export type DirectEntryActor = {
  auth_subject: string;
  app_user_id: string;
  /** P2.5-HF-R5: canonical, server-resolved account display name. */
  display_name: string;
  enabled: boolean;
  capabilities: readonly Capability[];
  scopes: readonly EffectiveScope[];
  effective_grants?: readonly PairedEffectiveGrant[];
  assigned_roles?: readonly AssignedRoleSummary[];
  effective_report_review_scopes?: readonly EffectiveReportReviewScope[];
  self_recruiter_suggestion: string | null;
  allowed_worker_tabs?: readonly WorkerOperationsTabId[];
  session: {
    provider: "supabase";
    verification: "getUser";
    authenticated_at: string | null;
  };
};

export type AllScopeGrant = {
  valid_from: string;
  valid_to: string | null;
};

export type TeamScopeGrant = {
  team_id: string;
  valid_from: string;
  valid_to: string | null;
};

export type ActorAuthorizationRecord = {
  auth_subject: unknown;
  app_user_id: unknown;
  display_name: unknown;
  enabled: unknown;
  capabilities: unknown;
  recruiter_links: unknown;
  teams: unknown;
  team_scope_grants: unknown;
  all_scope_grants: unknown;
  allowed_worker_tabs?: unknown;
  effective_grants?: unknown;
  assigned_roles?: unknown;
};

export type ActorRepository = {
  loadByAuthSubject(authSubject: string, at: string): Promise<unknown>;
};

export type ActorResolution =
  | { ok: true; actor: DirectEntryActor }
  | {
      ok: false;
      reason:
        | "UNAUTHENTICATED"
        | "ACTOR_MAPPING_MISSING"
        | "ACTOR_DISABLED"
        | "ACTOR_REPOSITORY_MISSING"
        | "ACTOR_REPOSITORY_INVALID"
        | "AMBIGUOUS_RECRUITER_LINK"
        | "AMBIGUOUS_TEAM_MEMBERSHIP";
    };

export type RecruiterSuggestion =
  | { kind: "none"; recruiter_id: null }
  | { kind: "suggestion"; recruiter_id: string }
  | { kind: "ambiguous"; recruiter_id: null };

export type ResourceScope = {
  kind: ScopeKind;
  reference: string;
  effective_date: string;
};

export type TrustedResourceContext = {
  reference: string;
  scope: ResourceScope;
  created_by_user_id: string | null;
  current_version: number | null;
};

export type AuthorizationAction = Capability;

export type AuditEnvelope = {
  auth_subject: string | null;
  app_user_id: string | null;
  action: AuthorizationAction;
  capability: Capability;
  resource_ref: string | null;
  scope: ResourceScope | null;
  timestamp: string;
  outcome: "ALLOW" | "DENY";
  denial_code: string | null;
  reason_ref: string | null;
};

export type AuthorizationDecision = {
  allowed: boolean;
  code: string;
  audit: AuditEnvelope;
};

export type AuthorizationInput = {
  actor: DirectEntryActor | null;
  action: AuthorizationAction;
  resource: TrustedResourceContext;
  timestamp: string;
  expected_version?: number;
  reason_ref?: string;
};

export type ClientPayloadResult =
  | { ok: true }
  | { ok: false; field: string; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z][a-z0-9]*_[a-z0-9][a-z0-9._:-]{0,100})$/i;
const SAFE_PROJECT_REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[a-z0-9][a-z0-9._:-]{0,127})$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const LEGACY_CAPABILITIES = new Set([
  "pii_view",
  "pii_export",
  "payment_view",
  "payment_edit",
]);
const REASON_REQUIRED_ACTIONS = new Set<AuthorizationAction>([
  "entry_admin",
  "change_review",
  "entry_privileged_edit",
  "employment_status.review",
  "employment_status.apply",
  "recruiter_master_manage",
  "team_master_manage",
  "entry_restore",
  "catalog_master_manage",
  "team_manager_assign",
  "vendor_finance_record",
]);
const VERSION_REQUIRED_ACTIONS = new Set<AuthorizationAction>([
  "entry_admin",
  "change_review",
  "entry_privileged_edit",
  "employment_status.apply",
  "recruiter_master_manage",
  "team_master_manage",
  "entry_restore",
  "catalog_master_manage",
  "team_manager_assign",
]);
const REQUIRED_SCOPE_KIND: Partial<Record<AuthorizationAction, ScopeKind>> = {
  entry_own: "own",
  entry_team: "team",
  entry_admin: "all",
  // catalog_master_manage is an all-scope catalog-operator authority; team_manager_assign is a
  // team-scope leader authority. An 'all' scope grant never substitutes for the required 'team'
  // scope of team_manager_assign and vice versa.
  catalog_master_manage: "all",
  team_manager_assign: "team",
  report_form_manage: "all",
  vendor_finance_view: "all",
  vendor_finance_record: "all",
};
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "authsubject",
  "appuser",
  "appuserid",
  "actorid",
  "createdby",
  "createdbyuserid",
  "owner",
  "owneruserid",
  "actor",
  "role",
  "roles",
  "capability",
  "capabilities",
  "scope",
  "scopes",
  "scopekind",
  "team",
  "teamid",
  "provider",
  "providertype",
  "effectivescope",
  "effectivescopes",
  "selfrecruitersuggestion",
  "allowedworkertabs",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_REF.test(value);
}

function isSafeProjectRef(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROJECT_REF.test(value);
}

type CurrentRecruiterLink = Pick<ExplicitRecruiterLink,
  "app_user_id" | "recruiter_id" | "verified"> &
  Partial<Pick<ExplicitRecruiterLink, "valid_from" | "valid_to">>;

function isCurrentRecruiterLink(value: unknown): value is CurrentRecruiterLink {
  return isRecord(value) &&
    isSafeRef(value.app_user_id) &&
    isSafeRef(value.recruiter_id) &&
    typeof value.verified === "boolean";
}

function isTeam(value: unknown): value is TeamIdentity {
  return isRecord(value) &&
    isSafeRef(value.team_id) &&
    typeof value.code === "string" &&
    typeof value.display === "string" &&
    typeof value.active === "boolean";
}

function isTeamScopeGrant(value: unknown): value is TeamScopeGrant {
  return isRecord(value) &&
    isSafeRef(value.team_id) &&
    typeof value.valid_from === "string" &&
    (value.valid_to === null || typeof value.valid_to === "string");
}

function isAllScopeGrant(value: unknown): value is AllScopeGrant {
  return isRecord(value) &&
    typeof value.valid_from === "string" &&
    (value.valid_to === null || typeof value.valid_to === "string");
}

function hasDuplicateCurrentTeamScope(grants: readonly TeamScopeGrant[]): boolean {
  return new Set(grants.map((grant) => grant.team_id)).size !== grants.length;
}

function effectiveRecruiterSuggestion(
  appUserId: string,
  links: readonly CurrentRecruiterLink[],
): RecruiterSuggestion {
  const matches = links.filter((link) =>
    link.app_user_id === appUserId &&
    link.verified
  );
  if (matches.length > 1) return { kind: "ambiguous", recruiter_id: null };
  if (matches.length === 0) return { kind: "none", recruiter_id: null };
  return { kind: "suggestion", recruiter_id: matches[0].recruiter_id };
}

export function resolveSelfRecruiterSuggestion(input: {
  app_user_id: string;
  links: readonly CurrentRecruiterLink[];
}): RecruiterSuggestion {
  if (!UUID.test(input.app_user_id)) {
    return { kind: "none", recruiter_id: null };
  }
  if (!input.links.every(isCurrentRecruiterLink)) {
    return { kind: "ambiguous", recruiter_id: null };
  }
  return effectiveRecruiterSuggestion(input.app_user_id, input.links);
}

const WORKER_TAB_ID_SET = new Set<string>(WORKER_OPERATIONS_TAB_IDS);

function isWorkerOperationsTabId(value: unknown): value is WorkerOperationsTabId {
  return typeof value === "string" && WORKER_TAB_ID_SET.has(value);
}

/**
 * Normalizes the server-computed `allowed_worker_tabs` array from `direct_entry_resolve_actor_context`
 * into canonical `WORKER_OPERATIONS_TAB_IDS` order without duplicating SQL authority checks in TypeScript.
 */
export function normalizeAllowedWorkerOperationsTabs(
  tabs: readonly unknown[] | null | undefined,
): readonly WorkerOperationsTabId[] {
  if (!Array.isArray(tabs)) return [];
  const allowedSet = new Set(tabs.filter(isWorkerOperationsTabId));
  return WORKER_OPERATIONS_TAB_IDS.filter((tab) => allowedSet.has(tab));
}

export function resolveActor(
  input: {
    session: SessionIdentity | null;
    repository: ActorRepository | null | undefined;
    at: string;
  },
): Promise<ActorResolution> {
  return resolveActorInternal(input);
}

async function resolveActorInternal(input: {
  session: SessionIdentity | null;
  repository: ActorRepository | null | undefined;
  at: string;
}): Promise<ActorResolution> {
  if (!input.session || !UUID.test(input.session.auth_subject) ||
      input.session.provider !== "supabase" ||
      !isValidTimestamp(input.at) ||
      (input.session.authenticated_at !== null &&
        !isValidTimestamp(input.session.authenticated_at))) {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }
  if (!input.repository ||
      typeof input.repository.loadByAuthSubject !== "function") {
    return { ok: false, reason: "ACTOR_REPOSITORY_MISSING" };
  }

  const record = await input.repository.loadByAuthSubject(
    input.session.auth_subject,
    input.at,
  );
  if (record === null || record === undefined) {
    return { ok: false, reason: "ACTOR_MAPPING_MISSING" };
  }
  if (!isValidAuthorizationRecord(record)) {
    return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
  }
  if (record.auth_subject !== input.session.auth_subject) {
    return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
  }
  if (!record.enabled) return { ok: false, reason: "ACTOR_DISABLED" };
  if (hasDuplicateCurrentTeamScope(record.team_scope_grants as TeamScopeGrant[])) {
    return { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" };
  }
  if ((record.all_scope_grants as AllScopeGrant[]).length > 1) {
    return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
  }

  const appUserId = record.app_user_id as string;
  const recruiterSuggestion = effectiveRecruiterSuggestion(
    appUserId,
    record.recruiter_links as CurrentRecruiterLink[],
  );
  if (recruiterSuggestion.kind === "ambiguous") {
    return { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" };
  }

  const scopes: EffectiveScope[] = [{
    kind: "own",
    reference: appUserId,
    valid_from: "0001-01-01",
    valid_to: null,
  }];
  // The actor RPC returns current rows; retained interval fields are metadata only.
  for (const grant of record.team_scope_grants as TeamScopeGrant[]) {
    const team = (record.teams as TeamIdentity[]).find((item) =>
      item.team_id === grant.team_id
    );
    if (!team || !team.active) {
      return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
    }
    scopes.push({
      kind: "team",
      reference: grant.team_id,
      valid_from: grant.valid_from,
      valid_to: grant.valid_to,
    });
  }
  for (const grant of record.all_scope_grants as AllScopeGrant[]) {
    scopes.push({
      kind: "all",
      reference: "all",
      valid_from: grant.valid_from,
      valid_to: grant.valid_to,
    });
  }

  const rawEffectiveGrants = (record as Record<string, unknown>).effective_grants;
  let effectiveGrants: readonly PairedEffectiveGrant[] | undefined;
  if (rawEffectiveGrants !== undefined) {
    if (!Array.isArray(rawEffectiveGrants) || !rawEffectiveGrants.every(isPairedEffectiveGrant)) {
      return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
    }
    effectiveGrants = rawEffectiveGrants.map((grant) => ({
      capability: grant.capability,
      scope_kind: grant.scope_kind,
      scope_id: grant.scope_kind === "OWN" || grant.scope_kind === "ALL" ? null : grant.scope_id,
      source_type: grant.source_type,
      source_id: grant.source_id,
    }));
  }

  const rawAssignedRoles = (record as Record<string, unknown>).assigned_roles;
  let assignedRoles: readonly AssignedRoleSummary[] | undefined;
  if (rawAssignedRoles !== undefined) {
    if (!Array.isArray(rawAssignedRoles) || !rawAssignedRoles.every(isAssignedRoleSummary)) {
      return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
    }
    assignedRoles = rawAssignedRoles.map((role) => ({
      role_code: role.role_code,
      display_name: role.display_name,
      assignment_mode: role.assignment_mode,
      scope_kind: role.assignment_mode === "GLOBAL" ? null : role.scope_kind,
      scope_id: role.assignment_mode === "GLOBAL" ? null : role.scope_id,
      assignment_id: role.assignment_id,
      is_protected: role.is_protected,
      can_revoke: role.can_revoke,
      cannot_revoke_reason: role.cannot_revoke_reason,
    }));
  }

  const rawReviewScopes = (record as Record<string, unknown>).effective_report_review_scopes;
  let effectiveReportReviewScopes: readonly EffectiveReportReviewScope[] | undefined;
  if (rawReviewScopes !== undefined) {
    if (!Array.isArray(rawReviewScopes) || !rawReviewScopes.every(isEffectiveReportReviewScope)) {
      return { ok: false, reason: "ACTOR_REPOSITORY_INVALID" };
    }
    effectiveReportReviewScopes = rawReviewScopes.map((item) => ({
      kind: item.kind,
      team_id: item.kind === "team" ? (item.team_id ?? null) : null,
      ...(typeof item.label === "string" ? { label: item.label } : {}),
    }));
  }

  const resolvedCapabilities = record.capabilities.filter((capability): capability is Capability =>
    CAPABILITY_SET.has(capability)
  );
  const selfRecruiterId = recruiterSuggestion.kind === "suggestion"
    ? recruiterSuggestion.recruiter_id
    : null;
  const allowedWorkerTabs = Array.isArray(record.allowed_worker_tabs)
    ? normalizeAllowedWorkerOperationsTabs(record.allowed_worker_tabs)
    : undefined;

  return {
    ok: true,
    actor: {
      auth_subject: input.session.auth_subject,
      app_user_id: appUserId,
      display_name: record.display_name as string,
      enabled: true,
      capabilities: resolvedCapabilities,
      scopes,
      ...(effectiveGrants !== undefined
        ? { effective_grants: effectiveGrants }
        : {}),
      ...(assignedRoles !== undefined
        ? { assigned_roles: assignedRoles }
        : {}),
      ...(effectiveReportReviewScopes !== undefined
        ? { effective_report_review_scopes: effectiveReportReviewScopes }
        : {}),
      self_recruiter_suggestion: selfRecruiterId,
      ...(allowedWorkerTabs !== undefined
        ? { allowed_worker_tabs: allowedWorkerTabs }
        : {}),
      session: {
        provider: "supabase",
        verification: "getUser",
        authenticated_at: input.session.authenticated_at,
      },
    },
  };
}

const CANONICAL_ROLE_SET = new Set([
  "EMPLOYEE_BASE",
  "RECRUITER",
  "HR_OPERATOR",
  "ADMIN",
  "TEAM_LEADER",
  "DEPARTMENT_HEAD",
  "PROJECT_MANAGER",
  "PROJECT_ACCOUNTANT",
]);

const AUTHZ_SCOPE_KIND_SET = new Set<string>([
  "OWN",
  "ALL",
  "CONTEXT_TEAM",
  "CONTEXT_DEPARTMENT",
  "CONTEXT_PROJECT",
]);

const EFFECTIVE_GRANT_SOURCE_SET = new Set<string>([
  "ROLE_BUNDLE",
  "CONTEXTUAL_ASSIGNMENT",
  "DIRECT_GRANT",
  "LEGACY_BRIDGE",
]);

function isPairedEffectiveGrant(value: unknown): value is PairedEffectiveGrant {
  if (!isRecord(value)) return false;
  if (typeof value.capability !== "string" || !CAPABILITY_SET.has(value.capability)) return false;
  if (typeof value.scope_kind !== "string" || !AUTHZ_SCOPE_KIND_SET.has(value.scope_kind)) return false;
  if (value.scope_kind === "OWN" || value.scope_kind === "ALL") {
    if (value.scope_id !== null) return false;
  } else if (value.scope_kind === "CONTEXT_PROJECT") {
    if (!isSafeProjectRef(value.scope_id)) return false;
  } else if (!isSafeRef(value.scope_id)) {
    return false;
  }
  if (typeof value.source_type !== "string" || !EFFECTIVE_GRANT_SOURCE_SET.has(value.source_type)) {
    return false;
  }
  if (value.source_id !== null && !isSafeRef(value.source_id)) return false;
  return true;
}

function isAssignedRoleSummary(value: unknown): value is AssignedRoleSummary {
  if (!isRecord(value)) return false;
  if (typeof value.role_code !== "string" || !CANONICAL_ROLE_SET.has(value.role_code)) return false;
  if (
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    value.display_name.length > 128
  ) {
    return false;
  }
  if (value.assignment_mode !== "GLOBAL" && value.assignment_mode !== "CONTEXTUAL") return false;
  if (value.assignment_mode === "GLOBAL") {
    if (value.scope_kind !== null || value.scope_id !== null) return false;
  } else {
    if (
      value.scope_kind !== "CONTEXT_TEAM" &&
      value.scope_kind !== "CONTEXT_DEPARTMENT" &&
      value.scope_kind !== "CONTEXT_PROJECT"
    ) {
      return false;
    }
    if (value.scope_kind === "CONTEXT_PROJECT") {
      if (!isSafeProjectRef(value.scope_id)) return false;
    } else if (!isSafeRef(value.scope_id)) {
      return false;
    }
  }
  if (value.assignment_id !== null && !isSafeRef(value.assignment_id)) return false;
  if (typeof value.is_protected !== "boolean" || typeof value.can_revoke !== "boolean") {
    return false;
  }
  if (value.cannot_revoke_reason !== null && value.cannot_revoke_reason !== "PROTECTED_OWNER_ADMIN") {
    return false;
  }
  return true;
}

function isEffectiveReportReviewScope(value: unknown): value is EffectiveReportReviewScope {
  if (!isRecord(value)) return false;
  if (value.kind !== "all" && value.kind !== "team") return false;
  if (value.kind === "all" && value.team_id !== undefined && value.team_id !== null) return false;
  if (value.kind === "team" && !isSafeRef(value.team_id)) return false;
  if (value.label !== undefined && typeof value.label !== "string") return false;
  return true;
}

function isValidAuthorizationRecord(
  value: unknown,
): value is ActorAuthorizationRecord & {
  auth_subject: string;
  app_user_id: string;
  display_name: string;
  enabled: boolean;
  capabilities: string[];
  recruiter_links: CurrentRecruiterLink[];
  teams: TeamIdentity[];
  team_scope_grants: TeamScopeGrant[];
  all_scope_grants: AllScopeGrant[];
} {
  if (!isRecord(value)) return false;
  const rawRecord = value as Record<string, unknown>;
  if (
    rawRecord.effective_grants !== undefined &&
    (!Array.isArray(rawRecord.effective_grants) || !rawRecord.effective_grants.every(isPairedEffectiveGrant))
  ) {
    return false;
  }
  if (
    rawRecord.assigned_roles !== undefined &&
    (!Array.isArray(rawRecord.assigned_roles) || !rawRecord.assigned_roles.every(isAssignedRoleSummary))
  ) {
    return false;
  }
  if (
    value.allowed_worker_tabs !== undefined &&
    (!Array.isArray(value.allowed_worker_tabs) ||
      !value.allowed_worker_tabs.every(isWorkerOperationsTabId) ||
      new Set(value.allowed_worker_tabs).size !== value.allowed_worker_tabs.length)
  ) {
    return false;
  }
  return UUID.test(String(value.auth_subject)) &&
    UUID.test(String(value.app_user_id)) &&
    isCanonicalDisplayName(value.display_name) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) =>
      typeof capability === "string" &&
      (CAPABILITY_SET.has(capability) || LEGACY_CAPABILITIES.has(capability))
    ) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    Array.isArray(value.recruiter_links) &&
    value.recruiter_links.every(isCurrentRecruiterLink) &&
    Array.isArray(value.teams) &&
    value.teams.every(isTeam) &&
    Array.isArray(value.team_scope_grants) &&
    value.team_scope_grants.every(isTeamScopeGrant) &&
    Array.isArray(value.all_scope_grants) &&
    value.all_scope_grants.every(isAllScopeGrant);
}

/**
 * P2.5-HF-R5 - canonical display name contract: a trimmed string of 1..256
 * characters. Anything else fails closed (no fallback, no UUID, no email).
 */
function isCanonicalDisplayName(value: unknown): value is string {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 256;
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    isRealCalendarDate(value.slice(0, 10));
}

function isAllowedByScope(
  actor: DirectEntryActor,
  resource: TrustedResourceContext,
): boolean {
  const { scope } = resource;
  if (scope.kind !== "own" && scope.kind !== "team" && scope.kind !== "all") {
    return false;
  }
  const validScopeReference = scope.kind === "all"
    ? scope.reference === "all"
    : isSafeRef(scope.reference);
  if (!validScopeReference || !isSafeRef(resource.reference)) {
    return false;
  }
  if (scope.kind === "own" &&
      scope.reference !== resource.created_by_user_id) {
    return false;
  }
  const matchingScopeCount = actor.scopes.filter((effectiveScope) =>
    effectiveScope.kind === scope.kind &&
    effectiveScope.reference === scope.reference
  ).length;
  return matchingScopeCount === 1;
}

/**
 * WP5B-1 fail-closed paired capability-scope evaluator.
 * Strictly evaluates `actor.effective_grants` only and NEVER falls back to
 * unpaired `actor.capabilities` or `actor.scopes`.
 */
export function hasPairedCapability(
  actor: DirectEntryActor | null | undefined,
  capability: Capability,
  targetScope: PairedScopeTarget,
): boolean {
  if (!actor || actor.enabled !== true) return false;
  if (!CAPABILITY_SET.has(capability)) return false;
  if (!Array.isArray(actor.effective_grants)) return false;

  return actor.effective_grants.some((grant) => {
    if (!isPairedEffectiveGrant(grant) || grant.capability !== capability) {
      return false;
    }
    switch (targetScope.kind) {
      case "all":
        return grant.scope_kind === "ALL" && grant.scope_id === null;
      case "own":
        return grant.scope_kind === "OWN" && grant.scope_id === null;
      case "team":
        return (
          isSafeRef(targetScope.team_id) &&
          grant.scope_kind === "CONTEXT_TEAM" &&
          grant.scope_id === targetScope.team_id
        );
      case "department":
        return (
          isSafeRef(targetScope.department_id) &&
          grant.scope_kind === "CONTEXT_DEPARTMENT" &&
          grant.scope_id === targetScope.department_id
        );
      case "project":
        return (
          isSafeProjectRef(targetScope.project_id) &&
          grant.scope_kind === "CONTEXT_PROJECT" &&
          grant.scope_id === targetScope.project_id
        );
      default:
        return false;
    }
  });
}

function isAllowedByPairedGrants(
  actor: DirectEntryActor,
  requiredCapability: Capability,
  resource: TrustedResourceContext,
): boolean {
  const { scope } = resource;
  if (!isSafeRef(resource.reference)) return false;
  if (scope.kind === "own") {
    if (!isSafeRef(scope.reference) || scope.reference !== resource.created_by_user_id) {
      return false;
    }
    if (scope.reference !== actor.app_user_id) {
      return false;
    }
    return hasPairedCapability(actor, requiredCapability, { kind: "own" });
  }
  if (scope.kind === "team") {
    if (!isSafeRef(scope.reference)) return false;
    return hasPairedCapability(actor, requiredCapability, { kind: "team", team_id: scope.reference });
  }
  if (scope.kind === "all") {
    if (scope.reference !== "all") return false;
    return hasPairedCapability(actor, requiredCapability, { kind: "all" });
  }
  return false;
}

/**
 * Pure reference contract evaluator for unit/audit tests (`direct-entry-v2.test.mjs`).
 *
 * NOTE (R2.1): Runtime authorization for all Direct Entry and Admin operations is
 * enforced inside PostgreSQL `SECURITY DEFINER` RPCs (current-state authorization
 * since R1/R1.1/R1.2/R2.1), NOT by calling `authorizeDirectEntry` in route handlers.
 * Keep this function exclusively for contract-shape & audit-record regression tests.
 */
export function authorizeDirectEntry(input: AuthorizationInput): AuthorizationDecision {
  const requiredCapability = input.action;
  let code = "ALLOW";
  const actor = input.actor;
  const usePairedGrants = actor !== null && actor !== undefined && Array.isArray(actor.effective_grants);

  if (!isValidTimestamp(input.timestamp)) code = "INVALID_TIMESTAMP";
  else if (!actor || !actor.enabled) code = "UNAUTHENTICATED";
  else if (!CAPABILITY_SET.has(requiredCapability) ||
      (!usePairedGrants && !actor.capabilities.includes(requiredCapability)) ||
      (usePairedGrants && !actor.effective_grants!.some((grant) =>
        isPairedEffectiveGrant(grant) && grant.capability === requiredCapability
      ))) code = "CAPABILITY_DENIED";
  else if (REQUIRED_SCOPE_KIND[input.action] !== undefined &&
      input.resource.scope.kind !== REQUIRED_SCOPE_KIND[input.action]) {
    code = "ACTION_SCOPE_MISMATCH";
  }
  else if (usePairedGrants
      ? !isAllowedByPairedGrants(actor, requiredCapability, input.resource)
      : !isAllowedByScope(actor, input.resource)) code = "SCOPE_DENIED";
  else if (REASON_REQUIRED_ACTIONS.has(input.action) &&
      !isSafeRef(input.reason_ref)) code = "REASON_REQUIRED";
  else if (VERSION_REQUIRED_ACTIONS.has(input.action)) {
    if (input.expected_version === undefined) {
      code = "EXPECTED_VERSION_REQUIRED";
    } else if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
      code = "EXPECTED_VERSION_INVALID";
    } else if (!Number.isSafeInteger(input.resource.current_version) ||
        input.resource.current_version! < 0) {
      code = "RESOURCE_VERSION_INVALID";
    } else if (input.expected_version !== input.resource.current_version) {
      code = "VERSION_CONFLICT";
    }
  }

  const allowed = code === "ALLOW";
  return {
    allowed,
    code,
    audit: {
      auth_subject: actor?.auth_subject ?? null,
      app_user_id: actor?.app_user_id ?? null,
      action: input.action,
      capability: requiredCapability,
      resource_ref: isSafeRef(input.resource.reference)
        ? input.resource.reference
        : null,
      scope: isValidResourceScope(input.resource.scope)
        ? input.resource.scope
        : null,
      timestamp: isValidTimestamp(input.timestamp) ? input.timestamp : "",
      outcome: allowed ? "ALLOW" : "DENY",
      denial_code: allowed ? null : code,
      reason_ref: isSafeRef(input.reason_ref) ? input.reason_ref : null,
    },
  };
}

function isValidResourceScope(value: ResourceScope): boolean {
  return isRecord(value) &&
    (value.kind === "own" || value.kind === "team" || value.kind === "all") &&
    (value.kind === "all" ? value.reference === "all" : isSafeRef(value.reference)) &&
    isRealCalendarDate(value.effective_date);
}

export function validateClientBusinessPayload(value: unknown): ClientPayloadResult {
  const seen = new Set<object>();
  const visit = (current: unknown, path: string): ClientPayloadResult => {
    if (Array.isArray(current)) {
      if (seen.has(current)) return { ok: true };
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const result = visit(current[index], `${path}[${index}]`);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    if (!isRecord(current)) return { ok: true };
    if (seen.has(current)) return { ok: true };
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      if (FORBIDDEN_CLIENT_FIELDS.has(normalized)) {
        return {
          ok: false,
          field: path ? `${path}.${key}` : key,
          code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        };
      }
      const result = visit(child, path ? `${path}.${key}` : key);
      if (!result.ok) return result;
    }
    return { ok: true };
  };
  return visit(value, "");
}
