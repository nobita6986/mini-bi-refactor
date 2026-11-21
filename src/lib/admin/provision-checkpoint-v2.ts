/**
 * WP13 PR-2 — Checkpoint V2 & Multi-Step Recovery Model (Browser-safe, zero secrets).
 *
 * Design invariants (WP12 Rev 2.1 §3.10 + WP13 Readiness Rev 2.3 §4):
 * - Persist-and-read-back-verify BEFORE Step 1 (`POST /api/admin/organization/persons`)
 *   for BOTH create-employee-only and create-employee-with-login flows.
 *   Storage write error or read-back mismatch MUST block dispatch (0 server mutations).
 * - Scoped by `env_origin` (`window.location.origin`) AND server-computed opaque
 *   `actor_scope` (`act_<24 hex>` from `sha256('wp13-cp-v2:' + app_user_id)`).
 *   Role names (e.g. `"full_admin"`) and raw `app_user_id` are rejected.
 * - Strict allowlist serialization: NEVER stores `password`, `password_confirm`,
 *   `intent_token`, `auth_subject`, raw `app_user_id`, `jwt`, `cookie`, or tokens.
 * - Storage is an UNTRUSTED hint: before resuming after reload, callers must verify
 *   origin, actor_scope, schema/refs, and current server state.
 * - Step 2 (`CREATE_ACCOUNT`) response validation ALWAYS runs through
 *   `classifyAccountOperationResponse` plus strict `app_user_id` + `version` checks.
 *   NEVER uses `GET /accounts?search=<login_id>` to claim ownership or auto-link,
 *   and NEVER mixes `RESET_PASSWORD` into `CREATE_ACCOUNT` reconciliation.
 */
import {
  classifyAccountOperationResponse,
  type AccountOperationUiOutcome,
} from "./account-operation-ui-model.ts";
import { isUuid } from "../http/direct-entry-api-guard.ts";
import type { GlobalRoleCode } from "../auth/role-access-contract.ts";

export const PROVISION_CHECKPOINT_STORAGE_KEY = "hrp_bi_wp13_provision_checkpoint_v2";
export const PROVISION_CHECKPOINT_SCHEMA_VERSION = 2 as const;

const OPAQUE_ACTOR_SCOPE_RE = /^act_[a-f0-9]{24}$/;

const FORBIDDEN_PERSISTENCE_KEYS = new Set([
  "password",
  "password_confirm",
  "passwordconfirm",
  "intent_token",
  "intenttoken",
  "auth_subject",
  "authsubject",
  "app_user_id",
  "appuserid",
  "jwt",
  "access_token",
  "refresh_token",
  "cookie",
  "authorization",
  "secret",
]);

export type ProvisionFlowKind =
  | "CREATE_EMPLOYEE_ONLY"
  | "CREATE_EMPLOYEE_WITH_LOGIN"
  | "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE";

export type ProvisionStep1Status =
  | "SKIPPED_EXISTING"
  | "IN_FLIGHT"
  | "UNCERTAIN"
  | "COMMITTED";

export type ProvisionStep2Status =
  | "SKIPPED"
  | "IDLE"
  | "IN_FLIGHT"
  | "UNCERTAIN"
  | "INTENT_RECORDED"
  | "NEEDS_RECONCILE"
  | "COMMITTED";

export type ProvisionStep3Status =
  | "SKIPPED"
  | "IDLE"
  | "IN_FLIGHT"
  | "UNCERTAIN"
  | "COMMITTED";

export type ProvisionStep4Status =
  | "IDLE"
  | "IN_FLIGHT"
  | "UNCERTAIN"
  | "COMMITTED";

export type ProvisionStep1PayloadSnapshot = {
  employee_code: string;
  full_name: string;
  joined_on: string | null;
  initial_department_ref: string | null;
  reason: string;
};

export type ProvisionStep1Person = {
  status: ProvisionStep1Status;
  idempotency_key: string | null;
  payload_snapshot: ProvisionStep1PayloadSnapshot | null;
  committed_person_id: string | null;
  committed_person_version: number | null;
  existing_employee_code: string | null;
  existing_full_name: string | null;
  existing_recruiter_id: string | null;
};

export type ProvisionStep2NonSecretSnapshot = {
  login_id: string;
  display_name: string;
  reason: string | null;
};

export type ProvisionStep2Account = {
  status: ProvisionStep2Status;
  idempotency_key: string | null;
  non_secret_snapshot: ProvisionStep2NonSecretSnapshot | null;
  intent_id: string | null;
  intent_state: string | null;
  reconcile_idempotency_key: string | null;
  committed_account_ref: string | null;
  committed_account_version: number | null;
};

export type ProvisionStep3LinkSnapshot = {
  person_id: string;
  account_ref: string;
  expected_account_version: number;
  expected_person_version: number;
  confirmed_recruiter_id: string | null;
  reason: string;
};

export type ProvisionStep3Link = {
  status: ProvisionStep3Status;
  idempotency_key: string | null;
  payload_snapshot: ProvisionStep3LinkSnapshot | null;
  post_link_account_version: number | null;
  post_link_person_version: number | null;
};

export type ProvisionStep4RoleSnapshot = {
  role_code: GlobalRoleCode;
  expected_version: number;
  reason: string;
};

export type ProvisionStep4Role = {
  role_code: GlobalRoleCode;
  status: ProvisionStep4Status;
  idempotency_key: string;
  payload_snapshot: ProvisionStep4RoleSnapshot | null;
};

export type ProvisionCheckpointV2 = {
  schema_version: 2;
  client_flow_id: string;
  env_origin: string;
  actor_scope: string;
  flow_kind: ProvisionFlowKind;
  updated_at: string;
  step1_person: ProvisionStep1Person;
  step2_account: ProvisionStep2Account;
  step3_link: ProvisionStep3Link;
  step4_roles: ProvisionStep4Role[];
};

export type CheckpointStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type PersistCheckpointResult =
  | { ok: true; checkpoint: ProvisionCheckpointV2 }
  | { ok: false; reason: "INVALID_CHECKPOINT" | "STORAGE_UNAVAILABLE" | "WRITE_ERROR" | "READBACK_MISMATCH"; message: string };

export type ReadCheckpointResult =
  | { kind: "none" }
  | { kind: "foreign_actor_or_origin" }
  | { kind: "corrupt"; message: string }
  | { kind: "valid"; checkpoint: ProvisionCheckpointV2 };

const VALID_FLOW_KINDS = new Set<ProvisionFlowKind>([
  "CREATE_EMPLOYEE_ONLY",
  "CREATE_EMPLOYEE_WITH_LOGIN",
  "OPEN_LOGIN_FOR_EXISTING_EMPLOYEE",
]);

const VALID_STEP1_STATUS = new Set<ProvisionStep1Status>([
  "SKIPPED_EXISTING",
  "IN_FLIGHT",
  "UNCERTAIN",
  "COMMITTED",
]);

const VALID_STEP2_STATUS = new Set<ProvisionStep2Status>([
  "SKIPPED",
  "IDLE",
  "IN_FLIGHT",
  "UNCERTAIN",
  "INTENT_RECORDED",
  "NEEDS_RECONCILE",
  "COMMITTED",
]);

const VALID_STEP3_STATUS = new Set<ProvisionStep3Status>([
  "SKIPPED",
  "IDLE",
  "IN_FLIGHT",
  "UNCERTAIN",
  "COMMITTED",
]);

const VALID_STEP4_STATUS = new Set<ProvisionStep4Status>([
  "IDLE",
  "IN_FLIGHT",
  "UNCERTAIN",
  "COMMITTED",
]);

const VALID_GLOBAL_ROLES = new Set<GlobalRoleCode>([
  "EMPLOYEE_BASE",
  "RECRUITER",
  "HR_OPERATOR",
  "ADMIN",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  return expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && isUuid(value));
}

function isNullablePositiveInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

export function isValidOpaqueActorScope(scope: unknown): scope is string {
  return typeof scope === "string" && OPAQUE_ACTOR_SCOPE_RE.test(scope);
}

export function containsForbiddenCheckpointKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenCheckpointKeys(item));
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_PERSISTENCE_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (containsForbiddenCheckpointKeys(nested)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and rebuilds a checkpoint strictly using the V2 allowlist.
 * Returns `null` if any field is malformed, unexpected, or contains forbidden keys.
 */
export function parseProvisionCheckpointV2(raw: unknown): ProvisionCheckpointV2 | null {
  if (!isRecord(raw)) return null;
  if (containsForbiddenCheckpointKeys(raw)) return null;
  if (
    !hasExactKeys(raw, [
      "schema_version",
      "client_flow_id",
      "env_origin",
      "actor_scope",
      "flow_kind",
      "updated_at",
      "step1_person",
      "step2_account",
      "step3_link",
      "step4_roles",
    ])
  ) {
    return null;
  }

  if (raw.schema_version !== PROVISION_CHECKPOINT_SCHEMA_VERSION) return null;
  if (typeof raw.client_flow_id !== "string" || !isUuid(raw.client_flow_id)) return null;
  if (!isNonEmptyString(raw.env_origin)) return null;
  if (!isValidOpaqueActorScope(raw.actor_scope)) return null;
  if (typeof raw.flow_kind !== "string" || !VALID_FLOW_KINDS.has(raw.flow_kind as ProvisionFlowKind)) {
    return null;
  }
  if (!isNonEmptyString(raw.updated_at)) return null;

  // Step 1
  const s1 = raw.step1_person;
  if (
    !isRecord(s1) ||
    !hasExactKeys(s1, [
      "status",
      "idempotency_key",
      "payload_snapshot",
      "committed_person_id",
      "committed_person_version",
      "existing_employee_code",
      "existing_full_name",
      "existing_recruiter_id",
    ])
  ) {
    return null;
  }
  if (typeof s1.status !== "string" || !VALID_STEP1_STATUS.has(s1.status as ProvisionStep1Status)) {
    return null;
  }
  if (!isNullableUuid(s1.idempotency_key)) return null;
  if (!isNullableUuid(s1.committed_person_id)) return null;
  if (!isNullablePositiveInt(s1.committed_person_version)) return null;
  if (!isNullableString(s1.existing_employee_code)) return null;
  if (!isNullableString(s1.existing_full_name)) return null;
  if (!isNullableUuid(s1.existing_recruiter_id)) return null;

  let step1Payload: ProvisionStep1PayloadSnapshot | null = null;
  if (s1.payload_snapshot !== null) {
    const p1 = s1.payload_snapshot;
    if (
      !isRecord(p1) ||
      !hasExactKeys(p1, [
        "employee_code",
        "full_name",
        "joined_on",
        "initial_department_ref",
        "reason",
      ])
    ) {
      return null;
    }
    if (
      !isNonEmptyString(p1.employee_code) ||
      !isNonEmptyString(p1.full_name) ||
      !isNullableString(p1.joined_on) ||
      !isNullableUuid(p1.initial_department_ref) ||
      !isNonEmptyString(p1.reason)
    ) {
      return null;
    }
    step1Payload = {
      employee_code: p1.employee_code,
      full_name: p1.full_name,
      joined_on: p1.joined_on,
      initial_department_ref: p1.initial_department_ref?.toLowerCase() ?? null,
      reason: p1.reason,
    };
  }

  // Step 2
  const s2 = raw.step2_account;
  if (
    !isRecord(s2) ||
    !hasExactKeys(s2, [
      "status",
      "idempotency_key",
      "non_secret_snapshot",
      "intent_id",
      "intent_state",
      "reconcile_idempotency_key",
      "committed_account_ref",
      "committed_account_version",
    ])
  ) {
    return null;
  }
  if (typeof s2.status !== "string" || !VALID_STEP2_STATUS.has(s2.status as ProvisionStep2Status)) {
    return null;
  }
  if (!isNullableUuid(s2.idempotency_key)) return null;
  if (!isNullableUuid(s2.intent_id)) return null;
  if (!isNullableString(s2.intent_state)) return null;
  if (!isNullableUuid(s2.reconcile_idempotency_key)) return null;
  if (!isNullableUuid(s2.committed_account_ref)) return null;
  if (!isNullablePositiveInt(s2.committed_account_version)) return null;

  let step2Snapshot: ProvisionStep2NonSecretSnapshot | null = null;
  if (s2.non_secret_snapshot !== null) {
    const p2 = s2.non_secret_snapshot;
    if (!isRecord(p2) || !hasExactKeys(p2, ["login_id", "display_name", "reason"])) {
      return null;
    }
    if (
      !isNonEmptyString(p2.login_id) ||
      !isNonEmptyString(p2.display_name) ||
      !isNullableString(p2.reason)
    ) {
      return null;
    }
    step2Snapshot = {
      login_id: p2.login_id,
      display_name: p2.display_name,
      reason: p2.reason,
    };
  }

  // Step 3
  const s3 = raw.step3_link;
  if (
    !isRecord(s3) ||
    !hasExactKeys(s3, [
      "status",
      "idempotency_key",
      "payload_snapshot",
      "post_link_account_version",
      "post_link_person_version",
    ])
  ) {
    return null;
  }
  if (typeof s3.status !== "string" || !VALID_STEP3_STATUS.has(s3.status as ProvisionStep3Status)) {
    return null;
  }
  if (!isNullableUuid(s3.idempotency_key)) return null;
  if (!isNullablePositiveInt(s3.post_link_account_version)) return null;
  if (!isNullablePositiveInt(s3.post_link_person_version)) return null;

  let step3Payload: ProvisionStep3LinkSnapshot | null = null;
  if (s3.payload_snapshot !== null) {
    const p3 = s3.payload_snapshot;
    if (
      !isRecord(p3) ||
      !hasExactKeys(p3, [
        "person_id",
        "account_ref",
        "expected_account_version",
        "expected_person_version",
        "confirmed_recruiter_id",
        "reason",
      ])
    ) {
      return null;
    }
    if (
      typeof p3.person_id !== "string" ||
      !isUuid(p3.person_id) ||
      typeof p3.account_ref !== "string" ||
      !isUuid(p3.account_ref) ||
      typeof p3.expected_account_version !== "number" ||
      !Number.isSafeInteger(p3.expected_account_version) ||
      p3.expected_account_version < 1 ||
      typeof p3.expected_person_version !== "number" ||
      !Number.isSafeInteger(p3.expected_person_version) ||
      p3.expected_person_version < 1 ||
      !isNullableUuid(p3.confirmed_recruiter_id) ||
      !isNonEmptyString(p3.reason)
    ) {
      return null;
    }
    step3Payload = {
      person_id: p3.person_id.toLowerCase(),
      account_ref: p3.account_ref.toLowerCase(),
      expected_account_version: p3.expected_account_version,
      expected_person_version: p3.expected_person_version,
      confirmed_recruiter_id: p3.confirmed_recruiter_id?.toLowerCase() ?? null,
      reason: p3.reason,
    };
  }

  // Step 4
  if (!Array.isArray(raw.step4_roles)) return null;
  const step4Roles: ProvisionStep4Role[] = [];
  for (const item of raw.step4_roles) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["role_code", "status", "idempotency_key", "payload_snapshot"])
    ) {
      return null;
    }
    if (
      typeof item.role_code !== "string" ||
      !VALID_GLOBAL_ROLES.has(item.role_code as GlobalRoleCode)
    ) {
      return null;
    }
    if (
      typeof item.status !== "string" ||
      !VALID_STEP4_STATUS.has(item.status as ProvisionStep4Status)
    ) {
      return null;
    }
    if (typeof item.idempotency_key !== "string" || !isUuid(item.idempotency_key)) {
      return null;
    }
    let rolePayload: ProvisionStep4RoleSnapshot | null = null;
    if (item.payload_snapshot !== null) {
      const p4 = item.payload_snapshot;
      if (!isRecord(p4) || !hasExactKeys(p4, ["role_code", "expected_version", "reason"])) {
        return null;
      }
      if (
        p4.role_code !== item.role_code ||
        typeof p4.expected_version !== "number" ||
        !Number.isSafeInteger(p4.expected_version) ||
        p4.expected_version < 1 ||
        !isNonEmptyString(p4.reason)
      ) {
        return null;
      }
      rolePayload = {
        role_code: p4.role_code as GlobalRoleCode,
        expected_version: p4.expected_version,
        reason: p4.reason,
      };
    }
    step4Roles.push({
      role_code: item.role_code as GlobalRoleCode,
      status: item.status as ProvisionStep4Status,
      idempotency_key: item.idempotency_key.toLowerCase(),
      payload_snapshot: rolePayload,
    });
  }

  return {
    schema_version: 2,
    client_flow_id: raw.client_flow_id.toLowerCase(),
    env_origin: raw.env_origin,
    actor_scope: raw.actor_scope,
    flow_kind: raw.flow_kind as ProvisionFlowKind,
    updated_at: raw.updated_at,
    step1_person: {
      status: s1.status as ProvisionStep1Status,
      idempotency_key: s1.idempotency_key?.toLowerCase() ?? null,
      payload_snapshot: step1Payload,
      committed_person_id: s1.committed_person_id?.toLowerCase() ?? null,
      committed_person_version: s1.committed_person_version,
      existing_employee_code: s1.existing_employee_code,
      existing_full_name: s1.existing_full_name,
      existing_recruiter_id: s1.existing_recruiter_id?.toLowerCase() ?? null,
    },
    step2_account: {
      status: s2.status as ProvisionStep2Status,
      idempotency_key: s2.idempotency_key?.toLowerCase() ?? null,
      non_secret_snapshot: step2Snapshot,
      intent_id: s2.intent_id?.toLowerCase() ?? null,
      intent_state: s2.intent_state,
      reconcile_idempotency_key: s2.reconcile_idempotency_key?.toLowerCase() ?? null,
      committed_account_ref: s2.committed_account_ref?.toLowerCase() ?? null,
      committed_account_version: s2.committed_account_version,
    },
    step3_link: {
      status: s3.status as ProvisionStep3Status,
      idempotency_key: s3.idempotency_key?.toLowerCase() ?? null,
      payload_snapshot: step3Payload,
      post_link_account_version: s3.post_link_account_version,
      post_link_person_version: s3.post_link_person_version,
    },
    step4_roles: step4Roles,
  };
}

export function getBrowserSessionStorage(): CheckpointStorageLike | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getBrowserOrigin(): string {
  try {
    if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin) {
      return window.location.origin;
    }
  } catch {
    // ignore
  }
  return "http://localhost";
}

/**
 * Writes the sanitized Checkpoint V2 to storage AND immediately reads back and
 * verifies key fields before returning `{ ok: true }`.
 *
 * Caller MUST abort before dispatching ANY HTTP mutation if `ok === false`.
 */
export function persistAndVerifyCheckpoint(
  checkpoint: ProvisionCheckpointV2,
  storage: CheckpointStorageLike | null = getBrowserSessionStorage(),
): PersistCheckpointResult {
  const sanitized = parseProvisionCheckpointV2(checkpoint);
  if (!sanitized) {
    return {
      ok: false,
      reason: "INVALID_CHECKPOINT",
      message:
        "Không thể chuẩn bị checkpoint phục hồi hợp lệ cho phiên hiện tại. Hệ thống đã dừng trước khi gửi yêu cầu tạo dữ liệu.",
    };
  }
  if (!storage) {
    return {
      ok: false,
      reason: "STORAGE_UNAVAILABLE",
      message:
        "Trình duyệt không hỗ trợ hoặc đang chặn bộ nhớ phiên (sessionStorage). Hệ thống đã dừng trước khi gửi yêu cầu để tránh mất khả năng phục hồi khi rớt mạng.",
    };
  }
  const serialized = JSON.stringify(sanitized);
  try {
    storage.setItem(PROVISION_CHECKPOINT_STORAGE_KEY, serialized);
  } catch {
    return {
      ok: false,
      reason: "WRITE_ERROR",
      message:
        "Không thể lưu checkpoint phục hồi vào bộ nhớ phiên (có thể hết dung lượng hoặc trình duyệt chặn ghi). Đã chặn gửi yêu cầu lên máy chủ (0 thay đổi được ghi).",
    };
  }

  let readBackRaw: string | null = null;
  try {
    readBackRaw = storage.getItem(PROVISION_CHECKPOINT_STORAGE_KEY);
  } catch {
    return {
      ok: false,
      reason: "READBACK_MISMATCH",
      message:
        "Không đọc lại được checkpoint sau khi lưu vào bộ nhớ phiên. Đã chặn gửi yêu cầu lên máy chủ (0 thay đổi được ghi).",
    };
  }

  if (!readBackRaw) {
    return {
      ok: false,
      reason: "READBACK_MISMATCH",
      message:
        "Xác minh đọc lại checkpoint thất bại (dữ liệu trống). Đã chặn gửi yêu cầu lên máy chủ (0 thay đổi được ghi).",
    };
  }

  let parsedBack: ProvisionCheckpointV2 | null = null;
  try {
    parsedBack = parseProvisionCheckpointV2(JSON.parse(readBackRaw));
  } catch {
    parsedBack = null;
  }

  const matches =
    parsedBack !== null &&
    parsedBack.client_flow_id === sanitized.client_flow_id &&
    parsedBack.env_origin === sanitized.env_origin &&
    parsedBack.actor_scope === sanitized.actor_scope &&
    parsedBack.flow_kind === sanitized.flow_kind &&
    parsedBack.step1_person.status === sanitized.step1_person.status &&
    parsedBack.step1_person.idempotency_key === sanitized.step1_person.idempotency_key &&
    parsedBack.step1_person.committed_person_id === sanitized.step1_person.committed_person_id &&
    parsedBack.step2_account.status === sanitized.step2_account.status &&
    parsedBack.step2_account.idempotency_key === sanitized.step2_account.idempotency_key &&
    parsedBack.step2_account.intent_id === sanitized.step2_account.intent_id &&
    parsedBack.step2_account.committed_account_ref === sanitized.step2_account.committed_account_ref &&
    parsedBack.step3_link.status === sanitized.step3_link.status &&
    parsedBack.step3_link.idempotency_key === sanitized.step3_link.idempotency_key &&
    parsedBack.step4_roles.length === sanitized.step4_roles.length &&
    parsedBack.step4_roles.every(
      (role, index) =>
        role.role_code === sanitized.step4_roles[index]?.role_code &&
        role.status === sanitized.step4_roles[index]?.status &&
        role.idempotency_key === sanitized.step4_roles[index]?.idempotency_key,
    );

  if (!parsedBack || !matches) {
    return {
      ok: false,
      reason: "READBACK_MISMATCH",
      message:
        "Xác minh đọc lại checkpoint không khớp với dữ liệu vừa ghi. Đã chặn gửi yêu cầu lên máy chủ (0 thay đổi được ghi).",
    };
  }

  return { ok: true, checkpoint: parsedBack };
}

/**
 * Reads and verifies a stored Checkpoint V2 against BOTH current origin AND
 * server-computed opaque `actor_scope`.
 *
 * Foreign actor or origin checkpoints return `{ kind: "foreign_actor_or_origin" }`
 * so Admin B NEVER sees, replays, or deletes Admin A's checkpoint.
 */
export function readVerifiedCheckpoint(input: {
  expectedOrigin: string;
  expectedActorScope: string;
  storage?: CheckpointStorageLike | null;
}): ReadCheckpointResult {
  if (!isValidOpaqueActorScope(input.expectedActorScope) || !isNonEmptyString(input.expectedOrigin)) {
    return { kind: "none" };
  }
  const storage = input.storage !== undefined ? input.storage : getBrowserSessionStorage();
  if (!storage) return { kind: "none" };

  let raw: string | null = null;
  try {
    raw = storage.getItem(PROVISION_CHECKPOINT_STORAGE_KEY);
  } catch {
    return {
      kind: "corrupt",
      message: "Không thể đọc bộ nhớ phiên để kiểm tra tiến trình dở dang.",
    };
  }
  if (!raw) return { kind: "none" };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      kind: "corrupt",
      message: "Dữ liệu checkpoint trong bộ nhớ phiên không hợp lệ. Vui lòng đối chiếu thủ công tại danh sách Nhân sự / Đối chiếu dữ liệu cũ.",
    };
  }

  const parsed = parseProvisionCheckpointV2(json);
  if (!parsed) {
    return {
      kind: "corrupt",
      message: "Checkpoint trong bộ nhớ phiên sai cấu trúc hoặc chứa trường không hợp lệ. Hệ thống không tự chạy tiếp; hãy đối chiếu thủ công.",
    };
  }

  if (parsed.env_origin !== input.expectedOrigin || parsed.actor_scope !== input.expectedActorScope) {
    return { kind: "foreign_actor_or_origin" };
  }

  return { kind: "valid", checkpoint: parsed };
}

/**
 * Removes stored checkpoint ONLY if it belongs to the current origin + actor_scope
 * (or if `forceCorruptCleanup` is explicitly passed for a corrupt entry).
 * Never deletes another admin's valid checkpoint.
 */
export function clearVerifiedCheckpoint(input: {
  expectedOrigin: string;
  expectedActorScope: string;
  storage?: CheckpointStorageLike | null;
  forceCorruptCleanup?: boolean;
}): void {
  const storage = input.storage !== undefined ? input.storage : getBrowserSessionStorage();
  if (!storage) return;
  const current = readVerifiedCheckpoint(input);
  if (current.kind === "valid" || (current.kind === "corrupt" && input.forceCorruptCleanup)) {
    try {
      storage.removeItem(PROVISION_CHECKPOINT_STORAGE_KEY);
    } catch {
      // ignore storage cleanup errors
    }
  }
}

export type VerifiedCreateAccountApplied = {
  accountRef: string;
  accountVersion: number;
  intentId: string | null;
  displayName: string | null;
  replayed: boolean;
};

export type VerifiedStep2Classification =
  | { kind: "applied"; account: VerifiedCreateAccountApplied; message: string }
  | { kind: "needs-reconcile"; intentId: string; state: string; message: string }
  | { kind: "denied"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string; preserveIdempotencyKey: boolean; manualCheckRequired?: boolean };

/**
 * Strictly classifies `POST /api/admin/access/accounts` OR
 * `POST /api/admin/access/accounts/intents/[intentRef]/reconcile` responses.
 *
 * Always delegates to `classifyAccountOperationResponse` first, then strictly
 * extracts `app_user_id` (UUID) and `version` (int >= 1) from the validated
 * `account` envelope so malformed HTTP 200 shapes NEVER leak into Step 3 Link.
 */
export function classifyProvisionStep2Response(
  status: number,
  payload: unknown,
  context:
    | { operation: "create_account" }
    | { operation: "reconcile_create_account"; expectedIntentId?: string },
): VerifiedStep2Classification {
  const base: AccountOperationUiOutcome = classifyAccountOperationResponse(
    status,
    payload,
    context,
  );

  if (base.kind === "denied") return base;
  if (base.kind === "conflict") return base;
  if (base.kind === "invalid") return base;
  if (base.kind === "unavailable") return base;
  if (base.kind === "needs-reconcile") return base;

  // base.kind === "applied": strictly extract account_ref + account_version from validated payload.
  if (!isRecord(payload) || !isRecord(payload.account)) {
    return {
      kind: "unavailable",
      preserveIdempotencyKey: true,
      message:
        "Phản hồi tạo tài khoản thiếu thông tin định danh tài khoản đã xác nhận. Giữ nguyên khóa yêu cầu để đối chiếu an toàn.",
    };
  }

  const account = payload.account;
  const rawAccountRef = account.app_user_id;
  const rawVersion = account.version;
  const rawIntentId = account.intent_id;
  const rawIntentState = account.intent_state;

  if (
    typeof rawAccountRef !== "string" ||
    !isUuid(rawAccountRef) ||
    typeof rawVersion !== "number" ||
    !Number.isSafeInteger(rawVersion) ||
    rawVersion < 1 ||
    rawIntentState !== "APPLIED" ||
    (rawIntentId !== null && rawIntentId !== undefined && (typeof rawIntentId !== "string" || !isUuid(rawIntentId)))
  ) {
    return {
      kind: "unavailable",
      preserveIdempotencyKey: true,
      message:
        "Phản hồi tạo tài khoản sai định dạng hoặc thiếu phiên bản tài khoản. Giữ nguyên khóa yêu cầu, không tự chuyển sang bước gắn hồ sơ.",
    };
  }

  return {
    kind: "applied",
    message: base.message,
    account: {
      accountRef: rawAccountRef.toLowerCase(),
      accountVersion: rawVersion,
      intentId: typeof rawIntentId === "string" ? rawIntentId.toLowerCase() : null,
      displayName: typeof account.display_name === "string" ? account.display_name : null,
      replayed: payload.replayed === true,
    },
  };
}
