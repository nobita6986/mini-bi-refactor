/**
 * P2.5-HF-R3 - API boundary sua truc tiep ho so (POST).
 *
 * Pipeline: gate -> entryId -> CSRF/origin -> content-type -> idempotency key -> body ->
 * strict patch validation -> server session actor -> repository -> sanitized response.
 *
 * Admin, privileged-edit grantees, current Team Leaders and assigned Project Managers are
 * checked again by the RPC. Khong bao gio nhan identity tu client va khong forward raw DB message.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { isCanonicalLaborTypeKey, validateEmployeeCode } from "../contracts/direct-entry-v1.ts";
import { isCanonicalNationalId } from "../contracts/national-id.ts";
import {
  failJson as fail,
  noStoreJson as respond,
  resolveTrustedSessionActor,
  UUID_REGEX as UUID,
} from "../http/direct-entry-api-guard.ts";
import { isPaymentText, PAYMENT_STATES, type PaymentState } from "./payment-contract.ts";
import { readBoundedJson } from "./write-api.ts";
import type { PrivilegedEditRepository } from "./privileged-edit-repository.ts";

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const BANK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const PAYMENT_PATCH_KEYS = [
  "state",
  "account_number",
  "bank_id",
  "bank_name",
  "account_holder_name",
] as const;

export type PrivilegedEditPaymentPatch = {
  state: PaymentState;
  account_number: string | null;
  bank_id: string | null;
  bank_name?: string | null;
  account_holder_name: string | null;
};

function projectPrivilegedEditPaymentPatch(
  value: unknown,
): PrivilegedEditPaymentPatch | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    !keys.includes("state") ||
    !keys.includes("account_number") ||
    !keys.includes("bank_id") ||
    !keys.includes("account_holder_name") ||
    !keys.every((key) => (PAYMENT_PATCH_KEYS as readonly string[]).includes(key))
  ) {
    return null;
  }
  const state = value.state;
  if (
    typeof state !== "string" ||
    !(PAYMENT_STATES as readonly string[]).includes(state)
  ) {
    return null;
  }
  const hasBankNameKey = "bank_name" in value;
  const rawAccountNumber = value.account_number;
  const rawBankId = value.bank_id;
  const rawBankName = hasBankNameKey ? value.bank_name : undefined;
  const rawHolder = value.account_holder_name;

  if (state !== "provided") {
    if (
      rawAccountNumber !== null ||
      rawBankId !== null ||
      (hasBankNameKey && rawBankName !== null) ||
      rawHolder !== null
    ) {
      return null;
    }
    return hasBankNameKey
      ? {
          state: state as PaymentState,
          account_number: null,
          bank_id: null,
          bank_name: null,
          account_holder_name: null,
        }
      : {
          state: state as PaymentState,
          account_number: null,
          bank_id: null,
          account_holder_name: null,
        };
  }

  let accountNumber: string | null = null;
  if (rawAccountNumber !== null) {
    if (typeof rawAccountNumber !== "string") return null;
    const trimmed = rawAccountNumber.trim();
    if (!/^\d{1,64}$/.test(trimmed)) return null;
    accountNumber = trimmed;
  }

  let bankId: string | null = null;
  if (rawBankId !== null) {
    if (typeof rawBankId !== "string") return null;
    const trimmed = rawBankId.trim();
    if (!BANK_ID.test(trimmed)) return null;
    bankId = trimmed;
  }

  let bankName: string | null | undefined = undefined;
  if (hasBankNameKey) {
    if (rawBankName === null) {
      bankName = null;
    } else {
      if (!isPaymentText(rawBankName, 256)) return null;
      bankName = rawBankName.trim();
    }
  }

  let accountHolderName: string | null = null;
  if (rawHolder !== null) {
    if (!isPaymentText(rawHolder, 256)) return null;
    accountHolderName = rawHolder.trim();
  }

  if (
    accountNumber === null &&
    bankId === null &&
    (bankName === null || bankName === undefined) &&
    accountHolderName === null
  ) {
    return null;
  }

  return hasBankNameKey
    ? {
        state: "provided",
        account_number: accountNumber,
        bank_id: bankId,
        bank_name: bankName ?? null,
        account_holder_name: accountHolderName,
      }
    : {
        state: "provided",
        account_number: accountNumber,
        bank_id: bankId,
        account_holder_name: accountHolderName,
      };
}
// P3.1-W02C-R1: khong con closed set o day. Hinh dang canonical key do predicate dung chung
// quyet dinh; ton tai/active do DB active-catalog guard quyet dinh.
const BODY_KEYS = ["expected_entry_version", "patch", "reason"] as const;
export const PRIVILEGED_EDIT_PATCH_KEYS = [
  "collaborator_id", "employee_code", "first_work_date", "labor_type", "project_id", "recruiter_id", "worker_details",
  "employment_status", "payment",
] as const;

export type PrivilegedEditDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: PrivilegedEditRepository;
};

export type PrivilegedEditRequest = {
  expected_entry_version: number;
  patch: Record<string, unknown>;
  reason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict patch projection. Unknown or authority keys, a malformed CMT/CCCD and invalid action
 * reasons are refused before any database work; the DB re-validates everything it receives.
 */
export function projectPrivilegedEditRequest(body: unknown): PrivilegedEditRequest | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (!keys.includes("expected_entry_version") || !keys.includes("patch") ||
      !keys.every((key) => (BODY_KEYS as readonly string[]).includes(key))) return null;
  const version = body.expected_entry_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const rawReason = body.reason;
  if (rawReason !== undefined && rawReason !== null &&
      (typeof rawReason !== "string" || rawReason.length > 1000)) return null;
  const reason = typeof rawReason === "string" ? rawReason.trim() || null : null;
  if (!isRecord(body.patch)) return null;
  const patch = body.patch;
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0 ||
      !patchKeys.every((key) => (PRIVILEGED_EDIT_PATCH_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  if (patch.project_id !== undefined &&
      (typeof patch.project_id !== "string" || !PROJECT_ID.test(patch.project_id))) return null;
  if (patch.first_work_date !== undefined &&
      (typeof patch.first_work_date !== "string" || !ISO_DATE.test(patch.first_work_date) ||
       !isRealCalendarDate(patch.first_work_date))) {
    return null;
  }
  if (patch.employee_code !== undefined &&
      (typeof patch.employee_code !== "string" ||
       validateEmployeeCode(patch.employee_code).length > 0)) {
    return null;
  }
  if (patch.recruiter_id !== undefined &&
      (typeof patch.recruiter_id !== "string" || !UUID.test(patch.recruiter_id))) return null;
  if (patch.labor_type !== undefined &&
      (typeof patch.labor_type !== "string" || !isCanonicalLaborTypeKey(patch.labor_type))) {
    return null;
  }
  let normalizedCollaboratorId: string | null | undefined;
  if (Object.hasOwn(patch, "collaborator_id")) {
    if (patch.collaborator_id === null) {
      normalizedCollaboratorId = null;
    } else if (typeof patch.collaborator_id === "string" &&
               BANK_ID.test(patch.collaborator_id.trim())) {
      normalizedCollaboratorId = patch.collaborator_id.trim();
    } else {
      return null;
    }
  }
  if (patch.worker_details !== undefined) {
    if (!isRecord(patch.worker_details)) return null;
    const nationalId = patch.worker_details.national_id;
    if (isRecord(nationalId) && nationalId.state === "provided" &&
        !isCanonicalNationalId(nationalId.value)) {
      return null;
    }
  }
  if (patch.employment_status !== undefined) {
    if (!isRecord(patch.employment_status)) return null;
    const status = patch.employment_status;
    const statusKeys = Object.keys(status);
    if (statusKeys.length < 2 || statusKeys.length > 3 ||
        !statusKeys.every((key) => ["status", "effective_date", "leave_reason"].includes(key)) ||
        !["UNCONFIRMED", "ON", "OFF"].includes(String(status.status)) ||
        typeof status.effective_date !== "string" || !isRealCalendarDate(status.effective_date)) {
      return null;
    }
    if (status.status === "OFF") {
      if (typeof status.leave_reason !== "string" || status.leave_reason.trim().length === 0 ||
          status.leave_reason.length > 4000) return null;
    } else if (status.leave_reason !== undefined) return null;
  }
  const normalizedPatch: Record<string, unknown> = { ...patch };
  if (normalizedCollaboratorId !== undefined) {
    normalizedPatch.collaborator_id = normalizedCollaboratorId;
  }
  if (patch.payment !== undefined) {
    const payment = projectPrivilegedEditPaymentPatch(patch.payment);
    if (!payment) {
      return null;
    }
    normalizedPatch.payment = payment;
  }
  return { expected_entry_version: version, patch: normalizedPatch, reason };
}

export async function privilegedEditEntry(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: PrivilegedEditDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json") return fail("CONTENT_TYPE_INVALID", 400);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" ||
      idempotencyKey.length > 128) return fail("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok) {
    return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }
  const parsed = projectPrivilegedEditRequest(body);
  if (!parsed) return fail("PRIVILEGED_EDIT_INVALID", 400);

  const session = await resolveTrustedSessionActor(dependencies.resolveSession, {
    unavailableCode: "PRIVILEGED_EDIT_UNAVAILABLE",
    logLabel: "privileged edit",
  });
  if (!session.ok) return session.response;
  const actor = session.actor;

  let result: Awaited<ReturnType<PrivilegedEditRepository["edit"]>>;
  try {
    result = await dependencies.repository.edit({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      expected_version: parsed.expected_entry_version,
      patch: parsed.patch,
      reason: parsed.reason,
      idempotency_key: idempotencyKey,
    });
  } catch {
    console.error("[direct-entry] privileged edit failed");
    return fail("PRIVILEGED_EDIT_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "conflict") return fail(result.code, 409);
    if (result.kind === "denied") return fail(result.code, 403);
    if (result.kind === "invalid") return fail(result.code, 400);
    if (result.kind === "not-found") return fail(result.code, 404);
    console.error("[direct-entry] privileged edit unavailable");
    return fail(result.code, 500);
  }
  return respond({ ok: true, entry_id: result.data.entry_id, version: result.data.version }, 200);
}
