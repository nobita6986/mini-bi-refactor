/**
 * PRE-W2-HF-D3-B/C - Pure contract cho account operations (create / edit name /
 * reset password / reconcile / personnel-from-account).
 *
 * Fail-closed: exact-key body allowlist, type/bounds, canonical login_id, password
 * byte bounds (8..1024) + confirm equality (server-side, never logged/stored), optional
 * normalized action reason, and required idempotency_key. Strict projection for each RPC envelope; no raw DB
 * message, no password/hash, no email/auth payload ever surfaced.
 */
import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "../direct-entry/action-reason.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && DATE.test(todayVn)
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}

export const MIN_PASSWORD_BYTES = 8;
export const MAX_PASSWORD_BYTES = 1024;
const REASON_MAX = 4000;
const NAME_MAX = 256;

export type PersonnelPosition = "STAFF" | "TEAM_LEADER";
export type AccountOperationKind = "CREATE_ACCOUNT" | "RESET_PASSWORD";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).sort().join(",") === [...keys].sort().join(",");
}
function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}
function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;
}
function version(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export type RequestFail = { ok: false; code: string };
export type Parsed<T> = { ok: true; value: T } | RequestFail;

function passwordBytes(password: unknown): boolean {
  return typeof password === "string" &&
    password.length >= MIN_PASSWORD_BYTES &&
    new TextEncoder().encode(password).length <= MAX_PASSWORD_BYTES;
}

/* ---------- create account ---------- */
export type CreateAccountRequest = {
  login_id: string;
  display_name: string;
  password: string;
  password_confirm: string;
  reason: string | null;
  idempotency_key: string;
};
export function parseCreateAccount(body: unknown): Parsed<CreateAccountRequest> {
  if (!isRecord(body) || !hasExactKeysWithOptionalReason(body,
    ["login_id", "display_name", "password", "password_confirm", "reason", "idempotency_key"])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const login_id = typeof body.login_id === "string" && LOGIN_ID.test(body.login_id) ? body.login_id : null;
  const display_name = text(body.display_name, NAME_MAX);
  if (typeof body.password !== "string" || typeof body.password_confirm !== "string" ||
      body.password !== body.password_confirm || !passwordBytes(body.password)) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = uuid(body.idempotency_key);
  if (!login_id || !display_name || !reason.ok || !idempotency_key) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  return { ok: true, value: { login_id, display_name, password: body.password,
    password_confirm: body.password_confirm, reason: reason.value, idempotency_key } };
}

/* ---------- edit display name ---------- */
export type EditDisplayNameRequest = {
  display_name: string;
  expected_version: number;
  reason: string | null;
  idempotency_key: string;
};
export function parseEditDisplayName(body: unknown): Parsed<EditDisplayNameRequest> {
  if (!isRecord(body) || !hasExactKeysWithOptionalReason(body,
    ["display_name", "expected_version", "reason", "idempotency_key"])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const display_name = text(body.display_name, NAME_MAX);
  const expected_version = version(body.expected_version);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = uuid(body.idempotency_key);
  if (!display_name || expected_version === null || expected_version < 1 || !reason.ok || !idempotency_key) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  return { ok: true, value: { display_name, expected_version, reason: reason.value, idempotency_key } };
}

/* ---------- reset password ---------- */
export type ResetPasswordRequest = {
  password: string;
  password_confirm: string;
  reason: string | null;
  idempotency_key: string;
};
export function parseResetPassword(body: unknown): Parsed<ResetPasswordRequest> {
  if (!isRecord(body) || !hasExactKeysWithOptionalReason(body,
    ["password", "password_confirm", "reason", "idempotency_key"])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  if (typeof body.password !== "string" || typeof body.password_confirm !== "string" ||
      body.password !== body.password_confirm || !passwordBytes(body.password)) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = uuid(body.idempotency_key);
  if (!reason.ok || !idempotency_key) return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  return { ok: true, value: { password: body.password, password_confirm: body.password_confirm,
    reason: reason.value, idempotency_key } };
}

/* ---------- reconcile intent ---------- */
export type ReconcileRequest = { idempotency_key: string };
export function parseReconcile(body: unknown): Parsed<ReconcileRequest> {
  if (!isRecord(body) || !exact(body, ["idempotency_key"])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const idempotency_key = uuid(body.idempotency_key);
  return idempotency_key ? { ok: true, value: { idempotency_key } } : { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
}

/* ---------- personnel from account ---------- */
export type CreatePersonnelFromAccountRequest = {
  account_ref: string;
  expected_account_version: number;
  /** Login ID selected in the eligible-account list; DB revalidates against Auth. */
  personnel_code: string;
  personnel_position: PersonnelPosition;
  valid_from: string | null;
  reason: string | null;
  idempotency_key: string;
};
export function parseCreatePersonnelFromAccount(
  body: unknown,
  todayVn?: string,
): Parsed<CreatePersonnelFromAccountRequest> {
  if (!isRecord(body)) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const normalized = "valid_from" in body ? body : { ...body, valid_from: null };
  if (!hasExactKeysWithOptionalReason(normalized, [
    "account_ref", "expected_account_version", "personnel_code", "personnel_position",
    "valid_from", "reason", "idempotency_key",
  ])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const businessToday = resolveBusinessTodayVn(todayVn);
  const account_ref = uuid(body.account_ref);
  const expected_account_version = version(body.expected_account_version);
  const personnel_code = typeof body.personnel_code === "string" && LOGIN_ID.test(body.personnel_code)
    ? body.personnel_code : null;
  const personnel_position = body.personnel_position === "STAFF" || body.personnel_position === "TEAM_LEADER"
    ? body.personnel_position : null;
  const omittedOrNull = body.valid_from === undefined || body.valid_from === null;
  const valid_from = omittedOrNull
    ? null
    : (typeof body.valid_from === "string" && DATE.test(body.valid_from) ? body.valid_from : null);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = uuid(body.idempotency_key);
  if (!account_ref || expected_account_version === null || expected_account_version < 1 || !personnel_code ||
      !personnel_position || (!omittedOrNull && (!valid_from || valid_from !== businessToday)) ||
      !reason.ok || !idempotency_key) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  return { ok: true, value: { account_ref, expected_account_version, personnel_code,
    personnel_position, valid_from, reason: reason.value, idempotency_key } };
}

/* ---------- envelopes (strict) ---------- */
export type IntentEnvelope = {
  intent_id: string;
  intent_token: string;
  kind: AccountOperationKind;
  state: string;
};
export function projectIntentEnvelope(v: unknown): IntentEnvelope | null {
  if (!isRecord(v) || !exact(v, ["intent_id", "intent_token", "kind", "state"])) return null;
  if (!uuid(v.intent_id) || !uuid(v.intent_token)) return null;
  if (v.kind !== "CREATE_ACCOUNT" && v.kind !== "RESET_PASSWORD") return null;
  if (typeof v.state !== "string") return null;
  return { intent_id: v.intent_id as string, intent_token: v.intent_token as string,
    kind: v.kind as AccountOperationKind, state: v.state as string };
}

export type ClaimEnvelope = IntentEnvelope & { claimed: boolean };
export function projectClaimEnvelope(v: unknown): ClaimEnvelope | null {
  if (!isRecord(v) || !exact(v, ["intent_id", "intent_token", "kind", "state", "claimed"])) return null;
  const base = projectIntentEnvelope({
    intent_id: v.intent_id, intent_token: v.intent_token, kind: v.kind, state: v.state,
  });
  if (!base || typeof v.claimed !== "boolean") return null;
  return { ...base, claimed: v.claimed };
}

export type ReadIntentEnvelope = {
  intent_id: string;
  intent_token: string;
  kind: AccountOperationKind;
  state: string;
  login_id: string | null;
  display_name: string | null;
  account_ref: string | null;
  auth_subject: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
};
export function projectReadIntentEnvelope(v: unknown): ReadIntentEnvelope | null {
  if (!isRecord(v) || !exact(v, ["intent_id", "intent_token", "kind", "state", "login_id",
    "display_name", "account_ref", "auth_subject", "created_at", "claimed_at", "resolved_at"])) return null;
  if (!uuid(v.intent_id) || !uuid(v.intent_token)) return null;
  if (v.kind !== "CREATE_ACCOUNT" && v.kind !== "RESET_PASSWORD") return null;
  if (typeof v.state !== "string") return null;
  if (v.login_id !== null && typeof v.login_id !== "string") return null;
  if (v.display_name !== null && typeof v.display_name !== "string") return null;
  if (v.account_ref !== null && !uuid(v.account_ref)) return null;
  if (v.auth_subject !== null && !uuid(v.auth_subject)) return null;
  if (typeof v.created_at !== "string") return null;
  if (v.claimed_at !== null && typeof v.claimed_at !== "string") return null;
  if (v.resolved_at !== null && typeof v.resolved_at !== "string") return null;
  return {
    intent_id: v.intent_id as string, intent_token: v.intent_token as string,
    kind: v.kind as AccountOperationKind, state: v.state as string,
    login_id: v.login_id as string | null, display_name: v.display_name as string | null,
    account_ref: v.account_ref as string | null, auth_subject: v.auth_subject as string | null,
    created_at: v.created_at as string, claimed_at: v.claimed_at as string | null,
    resolved_at: v.resolved_at as string | null,
  };
}

export type FinalizeCreateEnvelope = {
  app_user_id: string;
  auth_subject: string;
  display_name: string;
  version: number;
  revision_id: string;
  intent_id: string;
  intent_state: string;
};
export function projectFinalizeCreateEnvelope(v: unknown): FinalizeCreateEnvelope | null {
  if (!isRecord(v) || !exact(v, ["app_user_id", "auth_subject", "display_name", "version",
    "revision_id", "intent_id", "intent_state"])) return null;
  if (!uuid(v.app_user_id) || !uuid(v.auth_subject) || !uuid(v.revision_id) || !uuid(v.intent_id)) return null;
  if (typeof v.display_name !== "string") return null;
  if (typeof v.version !== "number" || !Number.isSafeInteger(v.version) || v.version < 1) return null;
  if (typeof v.intent_state !== "string") return null;
  return { app_user_id: v.app_user_id as string, auth_subject: v.auth_subject as string,
    display_name: v.display_name as string, version: v.version as number,
    revision_id: v.revision_id as string, intent_id: v.intent_id as string,
    intent_state: v.intent_state as string };
}

export type EditNameEnvelope = {
  app_user_id: string;
  version: number;
  revision_id: string;
  recruiter_id: string | null;
  recruiter_version: number | null;
  recruiter_revision_id: string | null;
};
export function projectEditNameEnvelope(v: unknown): EditNameEnvelope | null {
  if (!isRecord(v) || !exact(v, ["app_user_id", "version", "revision_id", "recruiter_id",
    "recruiter_version", "recruiter_revision_id"])) return null;
  if (!uuid(v.app_user_id) || !uuid(v.revision_id)) return null;
  if (typeof v.version !== "number" || !Number.isSafeInteger(v.version) || v.version < 1) return null;
  if (v.recruiter_id !== null && !uuid(v.recruiter_id)) return null;
  if (v.recruiter_version !== null && (typeof v.recruiter_version !== "number" || !Number.isSafeInteger(v.recruiter_version))) return null;
  if (v.recruiter_revision_id !== null && !uuid(v.recruiter_revision_id)) return null;
  return { app_user_id: v.app_user_id as string, version: v.version as number,
    revision_id: v.revision_id as string, recruiter_id: v.recruiter_id as string | null,
    recruiter_version: v.recruiter_version as number | null,
    recruiter_revision_id: v.recruiter_revision_id as string | null };
}

export type PersonnelFromAccountEnvelope = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string;
  personnel_position: PersonnelPosition;
  version: number;
  link_id: string;
  membership_id: string;
  app_user_version: number;
  app_user_revision_id: string;
  personnel_revision_id: string;
};
export function projectPersonnelFromAccountEnvelope(v: unknown): PersonnelFromAccountEnvelope | null {
  if (!isRecord(v) || !exact(v, ["recruiter_id", "display_name", "personnel_code", "personnel_position",
    "version", "link_id", "membership_id", "app_user_version", "app_user_revision_id",
    "personnel_revision_id"])) return null;
  if (!uuid(v.recruiter_id) || !uuid(v.link_id) || !uuid(v.membership_id) ||
      !uuid(v.app_user_revision_id) || !uuid(v.personnel_revision_id)) return null;
  if (typeof v.display_name !== "string" || typeof v.personnel_code !== "string") return null;
  if (v.personnel_position !== "STAFF" && v.personnel_position !== "TEAM_LEADER") return null;
  if (typeof v.version !== "number" || !Number.isSafeInteger(v.version) || v.version < 1) return null;
  if (typeof v.app_user_version !== "number" || !Number.isSafeInteger(v.app_user_version)) return null;
  return {
    recruiter_id: v.recruiter_id as string, display_name: v.display_name as string,
    personnel_code: v.personnel_code as string, personnel_position: v.personnel_position as PersonnelPosition,
    version: v.version as number, link_id: v.link_id as string, membership_id: v.membership_id as string,
    app_user_version: v.app_user_version as number, app_user_revision_id: v.app_user_revision_id as string,
    personnel_revision_id: v.personnel_revision_id as string,
  };
}

export type EligibleAccount = { app_user_id: string; display_name: string; login_id: string };
export type EligibleAccountsEnvelope = {
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  accounts: EligibleAccount[];
};
export function projectEligibleAccountsEnvelope(v: unknown): EligibleAccountsEnvelope | null {
  if (!isRecord(v) || !exact(v, ["page", "page_size", "total", "has_more", "accounts"])) return null;
  if (typeof v.page !== "number" || typeof v.page_size !== "number" || typeof v.total !== "number" ||
      !Number.isSafeInteger(v.page) || !Number.isSafeInteger(v.page_size) || !Number.isSafeInteger(v.total)) return null;
  if (typeof v.has_more !== "boolean" || !Array.isArray(v.accounts)) return null;
  const accounts: EligibleAccount[] = [];
  for (const raw of v.accounts) {
    if (!isRecord(raw) || !exact(raw, ["app_user_id", "display_name", "login_id"]) ||
        !uuid(raw.app_user_id) || typeof raw.display_name !== "string" ||
        typeof raw.login_id !== "string" || !LOGIN_ID.test(raw.login_id)) return null;
    accounts.push({ app_user_id: raw.app_user_id as string, display_name: raw.display_name as string,
      login_id: raw.login_id as string });
  }
  return { page: v.page, page_size: v.page_size, total: v.total, has_more: v.has_more, accounts };
}

/* ---------- link existing personnel to existing account ---------- */
export type LinkRecruiterToAccountRequest = {
  account_ref: string;
  expected_account_version: number;
  expected_recruiter_version: number;
  reason: string | null;
  idempotency_key: string;
};
export function parseLinkRecruiterToAccount(body: unknown): Parsed<LinkRecruiterToAccountRequest> {
  if (!isRecord(body) || !hasExactKeysWithOptionalReason(body, [
    "account_ref", "expected_account_version", "expected_recruiter_version",
    "reason", "idempotency_key",
  ])) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  const account_ref = uuid(body.account_ref);
  const expected_account_version = version(body.expected_account_version);
  const expected_recruiter_version = version(body.expected_recruiter_version);
  const reason = projectOptionalActionReason(body.reason, REASON_MAX);
  const idempotency_key = uuid(body.idempotency_key);
  if (!account_ref ||
      expected_account_version === null || expected_account_version < 1 ||
      expected_recruiter_version === null || expected_recruiter_version < 1 ||
      !reason.ok || !idempotency_key) {
    return { ok: false, code: "ACCOUNT_OPERATION_INVALID" };
  }
  return {
    ok: true,
    value: {
      account_ref,
      expected_account_version,
      expected_recruiter_version,
      reason: reason.value,
      idempotency_key,
    },
  };
}

export type RecruiterLinkStatusEnvelope = {
  linked_recruiter_ids: string[];
};
export function projectRecruiterLinkStatusEnvelope(v: unknown): RecruiterLinkStatusEnvelope | null {
  if (!isRecord(v) || !exact(v, ["linked_recruiter_ids"]) || !Array.isArray(v.linked_recruiter_ids)) {
    return null;
  }
  const linked_recruiter_ids: string[] = [];
  for (const raw of v.linked_recruiter_ids) {
    const id = uuid(raw);
    if (!id) return null;
    linked_recruiter_ids.push(id);
  }
  return { linked_recruiter_ids };
}

export type RecruiterLinkCandidate = {
  app_user_id: string;
  display_name: string;
  login_id: string;
  version: number;
};
export type RecruiterLinkCandidatesEnvelope = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string | null;
  personnel_position: PersonnelPosition | null;
  active: boolean;
  version: number;
  already_linked: boolean;
  candidates: RecruiterLinkCandidate[];
};
export function projectRecruiterLinkCandidatesEnvelope(v: unknown): RecruiterLinkCandidatesEnvelope | null {
  if (!isRecord(v) || !exact(v, [
    "recruiter_id", "display_name", "personnel_code", "personnel_position",
    "active", "version", "already_linked", "candidates",
  ])) {
    return null;
  }
  const recruiter_id = uuid(v.recruiter_id);
  if (!recruiter_id || typeof v.display_name !== "string") return null;
  if (v.personnel_code !== null && typeof v.personnel_code !== "string") return null;
  if (v.personnel_position !== null &&
      v.personnel_position !== "STAFF" &&
      v.personnel_position !== "TEAM_LEADER") {
    return null;
  }
  if (typeof v.active !== "boolean" || typeof v.already_linked !== "boolean") return null;
  const recVersion = version(v.version);
  if (recVersion === null || recVersion < 1 || !Array.isArray(v.candidates)) return null;
  const candidates: RecruiterLinkCandidate[] = [];
  for (const raw of v.candidates) {
    if (!isRecord(raw) || !exact(raw, ["app_user_id", "display_name", "login_id", "version"])) {
      return null;
    }
    const app_user_id = uuid(raw.app_user_id);
    const accVersion = version(raw.version);
    if (!app_user_id ||
        typeof raw.display_name !== "string" ||
        typeof raw.login_id !== "string" || !LOGIN_ID.test(raw.login_id) ||
        accVersion === null || accVersion < 1) {
      return null;
    }
    candidates.push({
      app_user_id,
      display_name: raw.display_name,
      login_id: raw.login_id,
      version: accVersion,
    });
  }
  return {
    recruiter_id,
    display_name: v.display_name,
    personnel_code: v.personnel_code as string | null,
    personnel_position: v.personnel_position as PersonnelPosition | null,
    active: v.active,
    version: recVersion,
    already_linked: v.already_linked,
    candidates,
  };
}

export type LinkRecruiterEnvelope = {
  link_id: string;
  app_user_id: string;
  app_user_version: number;
  app_user_revision_id: string;
  recruiter_id: string;
  recruiter_version: number;
  personnel_code: string;
  valid_from: string;
};
export function projectLinkRecruiterEnvelope(v: unknown): LinkRecruiterEnvelope | null {
  if (!isRecord(v) || !exact(v, [
    "link_id", "app_user_id", "app_user_version", "app_user_revision_id",
    "recruiter_id", "recruiter_version", "personnel_code", "valid_from",
  ])) {
    return null;
  }
  const link_id = uuid(v.link_id);
  const app_user_id = uuid(v.app_user_id);
  const app_user_revision_id = uuid(v.app_user_revision_id);
  const recruiter_id = uuid(v.recruiter_id);
  const app_user_version = version(v.app_user_version);
  const recruiter_version = version(v.recruiter_version);
  if (!link_id || !app_user_id || !app_user_revision_id || !recruiter_id ||
      app_user_version === null || app_user_version < 1 ||
      recruiter_version === null || recruiter_version < 1 ||
      typeof v.personnel_code !== "string" || !LOGIN_ID.test(v.personnel_code) ||
      typeof v.valid_from !== "string" || !DATE.test(v.valid_from)) {
    return null;
  }
  return {
    link_id,
    app_user_id,
    app_user_version,
    app_user_revision_id,
    recruiter_id,
    recruiter_version,
    personnel_code: v.personnel_code,
    valid_from: v.valid_from,
  };
}

/** D3-A intent terminal states (finish/finalize). */
export const ACCOUNT_OPERATION_TERMINAL = [
  "APPLIED", "FAILED", "INDETERMINATE", "BLOCKED", "CONFLICT", "EXPIRED",
] as const;
