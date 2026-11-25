/**
 * PRE-W2-HF-D3-B/C - API boundary for account operations.
 *
 * Pipeline (mutation): DIRECT_ENTRY_API_ENABLED -> same-origin/CSRF -> content-type
 * -> exact allowlist -> server session actor -> repository/RPC (Full Admin enforced
 * inside every RPC) -> Auth Admin call (create/reset) -> sanitized response.
 *
 * No password/hash/email/auth payload is ever logged, returned or forwarded.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import type { AccountAccessRepository } from "../direct-entry/app-user-access-repository.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { AccountOperationRepository } from "./account-operation-repository.ts";
import type { AccountOperationAuth } from "./account-operation-auth.ts";
import {
  parseCreateAccount,
  parseCreatePersonnelFromAccount,
  parseEditDisplayName,
  parseLinkRecruiterToAccount,
  parseReconcile,
  parseResetPassword,
  type CreateAccountRequest,
  type CreatePersonnelFromAccountRequest,
  type EditDisplayNameRequest,
  type IntentEnvelope,
  type LinkRecruiterToAccountRequest,
  type ReadIntentEnvelope,
  type ResetPasswordRequest,
} from "./account-operation-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MISMATCH_TOKEN = "00000000-0000-4000-8000-000000000000";
const REPLAYABLE_NON_APPLIED_STATES = new Set([
  "IN_FLIGHT",
  "INDETERMINATE",
  "BLOCKED",
  "CONFLICT",
  "FAILED",
  "EXPIRED",
]);
const TERMINAL_NON_APPLIED_STATES = new Set([
  "BLOCKED",
  "CONFLICT",
  "FAILED",
  "EXPIRED",
]);

export type AccountOperationDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AccountOperationRepository;
  auth: AccountOperationAuth;
  accountAccess?: Pick<AccountAccessRepository, "getAccount">;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("ACCOUNT_OPERATION_INVALID", 400);
  }
  return null;
}

async function readBody(request: Request): Promise<Parsed<unknown>> {
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("ACCOUNT_OPERATION_INVALID", 400) };
  return { ok: true, value: body };
}

function forbidAuthority(body: unknown): Response | null {
  if (!isRecord(body)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok) return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  return null;
}

function idempotencyMismatch(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveActor(deps: AccountOperationDependencies): Promise<Parsed<TrustedActor>> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[account-operation] session unavailable");
    return { ok: false, response: fail("ACCOUNT_OPERATION_UNAVAILABLE", 500) };
  }
}

function errorResponse(kind: string): Response {
  if (kind === "denied") return fail("ACCOUNT_OPERATION_DENIED", 403);
  if (kind === "not-found") return fail("ACCOUNT_OPERATION_NOT_FOUND", 404);
  if (kind === "active-team-assignment") return fail("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT", 409);
  if (kind === "conflict") return fail("ACCOUNT_OPERATION_CONFLICT", 409);
  if (kind === "blocked") return fail("ACCOUNT_OPERATION_BLOCKED", 409);
  if (kind === "invalid") return fail("ACCOUNT_OPERATION_INVALID", 400);
  return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
}

function intentResponse(
  intentId: string,
  intentToken: string,
  kind: string,
  state: string,
  accountRef: string | null = null,
  replayed?: boolean,
): Response {
  const intent = {
    intent_id: intentId,
    intent_token: intentToken,
    kind,
    state,
    account_ref: accountRef,
  };
  return respond(replayed ? { ok: true, replayed: true, intent } : { ok: true, intent }, 200);
}

async function resolveAppliedCreateAccount(
  actor: TrustedActor,
  intent: ReadIntentEnvelope,
  idempotencyKey: string,
  deps: AccountOperationDependencies,
  skipFinalizeCache = false,
): Promise<Response> {
  if (intent.account_ref === null) {
    return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
  }
  const intentSummary = {
    intent_id: intent.intent_id,
    intent_token: intent.intent_token,
    kind: "CREATE_ACCOUNT",
    state: "APPLIED",
    account_ref: intent.account_ref,
  };

  if (!skipFinalizeCache && intent.auth_subject !== null) {
    const finalize = await deps.repository.finalizeCreate({
      ...actor,
      intent_id: intent.intent_id,
      intent_token: intent.intent_token,
      created_auth_subject: intent.auth_subject,
      idempotency_key: idempotencyKey,
    });
    if (!finalize.ok && finalize.kind === "denied") {
      return errorResponse("denied");
    }
    if (
      finalize.ok &&
      "app_user_id" in finalize.data &&
      finalize.data.app_user_id === intent.account_ref &&
      finalize.data.intent_id === intent.intent_id
    ) {
      return respond({
        ok: true,
        replayed: true,
        account: finalize.data,
        intent: intentSummary,
      }, 200);
    }
  }

  if (deps.accountAccess) {
    const acct = await deps.accountAccess.getAccount({
      ...actor,
      target_app_user_id: intent.account_ref,
    });
    if (!acct.ok && acct.kind === "denied") {
      return errorResponse("denied");
    }
    if (acct.ok && acct.data.account_ref === intent.account_ref) {
      return respond({
        ok: true,
        replayed: true,
        account: {
          app_user_id: acct.data.account_ref,
          auth_subject: intent.auth_subject,
          display_name: acct.data.display_name,
          version: acct.data.version,
          revision_id: null,
          intent_id: intent.intent_id,
          intent_state: "APPLIED",
        },
        intent: intentSummary,
      }, 200);
    }
  }

  return intentResponse(
    intent.intent_id,
    intent.intent_token,
    "CREATE_ACCOUNT",
    "APPLIED",
    intent.account_ref,
    true,
  );
}

async function replayCreateAccountIntent(
  actor: TrustedActor,
  intent: IntentEnvelope,
  idempotencyKey: string,
  deps: AccountOperationDependencies,
): Promise<Response> {
  const read = await deps.repository.readIntent({ ...actor, intent_id: intent.intent_id });
  if (!read.ok) return errorResponse(read.kind);
  if (
    read.data.intent_id !== intent.intent_id ||
    read.data.kind !== "CREATE_ACCOUNT" ||
    read.data.intent_token !== intent.intent_token
  ) {
    return fail("ACCOUNT_OPERATION_CONFLICT", 409);
  }
  if (read.data.state === "APPLIED") {
    return resolveAppliedCreateAccount(actor, read.data, idempotencyKey, deps);
  }
  if (REPLAYABLE_NON_APPLIED_STATES.has(read.data.state)) {
    return intentResponse(
      read.data.intent_id,
      read.data.intent_token,
      "CREATE_ACCOUNT",
      read.data.state,
      read.data.account_ref,
      true,
    );
  }
  return fail("ACCOUNT_OPERATION_CONFLICT", 409);
}

function logResetStage(stage: "begin" | "claim" | "read" | "auth" | "finish", outcome: string): void {
  console.info(`[account-operation] reset-password stage=${stage} outcome=${outcome}`);
}

/* ---------------- create account ---------------- */
export async function createAccount(
  request: Request, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseCreateAccount(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  return runCreateAccount(parsed.value, deps);
}

async function runCreateAccount(
  input: CreateAccountRequest, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;

  const began = await deps.repository.begin({
    ...actor.value, kind: "CREATE_ACCOUNT", login_id: input.login_id,
    display_name: input.display_name, account_ref: null, reason: input.reason,
    idempotency_key: input.idempotency_key,
  });
  if (!began.ok) return errorResponse(began.kind);
  const intent = began.data;

  const claimed = await deps.repository.claim({
    ...actor.value, intent_id: intent.intent_id, intent_token: intent.intent_token,
  });
  if (!claimed.ok) return errorResponse(claimed.kind);
  if (!claimed.data.claimed) {
    return replayCreateAccountIntent(actor.value, intent, input.idempotency_key, deps);
  }

  const auth = deps.auth;
  const created = await auth.createAuthAccount({
    login_id: input.login_id, password: input.password, intent_token: intent.intent_token,
  });
  if (created.kind === "unknown") {
    const finished = await deps.repository.finish({
      ...actor.value, intent_id: intent.intent_id, outcome: "INDETERMINATE", failure_code: "auth_unknown",
    });
    if (!finished.ok) return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
    return intentResponse(intent.intent_id, intent.intent_token, "CREATE_ACCOUNT", "INDETERMINATE");
  }
  if (created.kind === "failure") {
    const finished = await deps.repository.finish({
      ...actor.value, intent_id: intent.intent_id, outcome: "CONFLICT", failure_code: created.code,
    });
    if (!finished.ok) return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
    return intentResponse(intent.intent_id, intent.intent_token, "CREATE_ACCOUNT", "CONFLICT");
  }

  const provenance = await auth.readAuthUserProvenance({
    auth_subject: created.auth_subject, intent_token: intent.intent_token,
  });
  if (provenance.kind === "unknown") {
    const finished = await deps.repository.finish({
      ...actor.value, intent_id: intent.intent_id, outcome: "INDETERMINATE", failure_code: "provenance_unknown",
    });
    if (!finished.ok) return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
    return intentResponse(intent.intent_id, intent.intent_token, "CREATE_ACCOUNT", "INDETERMINATE", null);
  }
  const finalize = await deps.repository.finalizeCreate({
    ...actor.value, intent_id: intent.intent_id,
    intent_token: provenance.kind === "match" ? intent.intent_token : MISMATCH_TOKEN,
    created_auth_subject: created.auth_subject, idempotency_key: input.idempotency_key,
  });
  if (!finalize.ok) return errorResponse(finalize.kind);
  if ("app_user_id" in finalize.data) {
    return respond({ ok: true, account: finalize.data }, 200);
  }
  return intentResponse(intent.intent_id, intent.intent_token, "CREATE_ACCOUNT", finalize.data.intent_state);
}

/* ---------------- edit display name ---------------- */
export async function editDisplayName(
  request: Request, accountRef: string, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  if (!UUID.test(accountRef)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseEditDisplayName(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  return runEditDisplayName(accountRef, parsed.value, deps);
}

async function runEditDisplayName(
  accountRef: string, input: EditDisplayNameRequest, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.updateDisplayName({
    ...actor.value, target_app_user_id: accountRef, display_name: input.display_name,
    expected_app_user_version: input.expected_version, reason: input.reason,
    idempotency_key: input.idempotency_key,
  });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, account: result.data }, 200);
}

/* ---------------- reset password ---------------- */
export async function resetPassword(
  request: Request, accountRef: string, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  if (!UUID.test(accountRef)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseResetPassword(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  return runResetPassword(accountRef, parsed.value, deps);
}

async function runResetPassword(
  accountRef: string, input: ResetPasswordRequest, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;

  const began = await deps.repository.begin({
    ...actor.value, kind: "RESET_PASSWORD", login_id: null, display_name: null,
    account_ref: accountRef, reason: input.reason, idempotency_key: input.idempotency_key,
  });
  if (!began.ok) {
    logResetStage("begin", began.kind);
    return errorResponse(began.kind);
  }
  logResetStage("begin", "ok");
  const intent = began.data;

  const claimed = await deps.repository.claim({
    ...actor.value, intent_id: intent.intent_id, intent_token: intent.intent_token,
  });
  if (!claimed.ok) {
    logResetStage("claim", claimed.kind);
    return errorResponse(claimed.kind);
  }
  if (!claimed.data.claimed) {
    logResetStage("claim", "conflict");
    return fail("ACCOUNT_OPERATION_CONFLICT", 409);
  }
  logResetStage("claim", "ok");

  const read = await deps.repository.readIntent({ ...actor.value, intent_id: intent.intent_id });
  if (!read.ok || read.data.auth_subject === null) {
    logResetStage("read", read.ok ? "invalid" : read.kind);
    return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
  }
  logResetStage("read", "ok");

  const auth = deps.auth;
  const reset = await auth.resetAuthPassword({ auth_subject: read.data.auth_subject, password: input.password });
  logResetStage("auth", reset.kind);
  if (reset.kind === "applied") {
    const finished = await deps.repository.finish({ ...actor.value, intent_id: intent.intent_id, outcome: "APPLIED", failure_code: null });
    logResetStage("finish", finished.ok ? "applied" : finished.kind);
    if (!finished.ok) return fail("ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED", 500);
    return respond({ ok: true }, 200);
  }
  if (reset.kind === "failure") {
    const finished = await deps.repository.finish({ ...actor.value, intent_id: intent.intent_id, outcome: "FAILED", failure_code: reset.code });
    logResetStage("finish", finished.ok ? "failed" : finished.kind);
    if (!finished.ok) return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
    return fail("ACCOUNT_OPERATION_FAILED", 400);
  }
  const finished = await deps.repository.finish({ ...actor.value, intent_id: intent.intent_id, outcome: "INDETERMINATE", failure_code: "auth_unknown" });
  logResetStage("finish", finished.ok ? "indeterminate" : finished.kind);
  if (!finished.ok) return fail("ACCOUNT_OPERATION_RESULT_UNRECORDED", 500);
  return fail("ACCOUNT_OPERATION_INDETERMINATE", 500);
}

/* ---------------- reconcile ---------------- */
export async function reconcileIntent(
  request: Request, intentRef: string, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  if (!UUID.test(intentRef)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseReconcile(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  return runReconcileIntent(intentRef, parsed.value.idempotency_key, deps);
}

async function runReconcileIntent(
  intentRef: string, idempotencyKey: string, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const read = await deps.repository.readIntent({ ...actor.value, intent_id: intentRef });
  if (!read.ok) return errorResponse(read.kind);
  if (read.data.kind !== "CREATE_ACCOUNT") return fail("ACCOUNT_OPERATION_INVALID", 400);

  if (read.data.state === "APPLIED") {
    return resolveAppliedCreateAccount(actor.value, read.data, idempotencyKey, deps);
  }
  if (TERMINAL_NON_APPLIED_STATES.has(read.data.state)) {
    return intentResponse(
      read.data.intent_id,
      read.data.intent_token,
      "CREATE_ACCOUNT",
      read.data.state,
      read.data.account_ref,
      true,
    );
  }
  if (read.data.state !== "IN_FLIGHT" && read.data.state !== "INDETERMINATE") {
    return fail("ACCOUNT_OPERATION_CONFLICT", 409);
  }

  const auth = deps.auth;
  const provenance = read.data.login_id === null
    ? { kind: "missing" as const }
    : await auth.findAuthUserByLoginId({ login_id: read.data.login_id, intent_token: read.data.intent_token });

  if (provenance.kind === "missing" || provenance.kind === "unknown") {
    return fail("ACCOUNT_OPERATION_INDETERMINATE", 409);
  }

  const finalize = await deps.repository.finalizeCreate({
    ...actor.value, intent_id: intentRef,
    intent_token: provenance.kind === "match" ? read.data.intent_token : MISMATCH_TOKEN,
    created_auth_subject: provenance.auth_subject, idempotency_key: idempotencyKey,
  });
  if (!finalize.ok) return errorResponse(finalize.kind);
  if ("app_user_id" in finalize.data) {
    return respond({ ok: true, account: finalize.data }, 200);
  }
  if (finalize.data.intent_state === "APPLIED") {
    return resolveAppliedCreateAccount(
      actor.value,
      {
        ...read.data,
        state: "APPLIED",
        account_ref: finalize.data.account_ref,
        auth_subject: read.data.auth_subject ?? (provenance.kind === "match" ? provenance.auth_subject : null),
      },
      idempotencyKey,
      deps,
      true,
    );
  }
  return intentResponse(
    intentRef,
    read.data.intent_token,
    "CREATE_ACCOUNT",
    finalize.data.intent_state,
    finalize.data.account_ref,
  );
}

/* ---------------- personnel from account ---------------- */
export async function createPersonnelFromAccount(
  request: Request, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseCreatePersonnelFromAccount(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;
  return runCreatePersonnelFromAccount(parsed.value, deps);
}

async function runCreatePersonnelFromAccount(
  input: CreatePersonnelFromAccountRequest, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.createPersonnelFromAccount({ ...actor.value, ...input });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, personnel: result.data }, 200);
}

/* ---------------- eligible accounts (read) ---------------- */
export async function listEligibleAccounts(
  request: Request, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const pageRaw = url.searchParams.get("page") ?? "1";
  const sizeRaw = url.searchParams.get("page_size") ?? "25";
  if (!/^\d{1,6}$/.test(pageRaw) || !/^\d{1,6}$/.test(sizeRaw)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const page = Number(pageRaw);
  const pageSize = Number(sizeRaw);
  if (page < 1 || page > 1000 || pageSize < 1 || pageSize > 100) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.listEligibleAccounts({ ...actor.value, page, page_size: pageSize });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, list: result.data }, 200);
}

/* ---------------- reclassify (retention sweep, Full Admin triggered) ---------------- */
export async function reclassifyAccountOperations(
  request: Request, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  try {
    const result = await deps.repository.reclassify(actor.value);
    if (!result.ok) return errorResponse(result.kind);
    return respond({ ok: true, reclassified: result.data }, 200);
  } catch {
    return fail("ACCOUNT_OPERATION_UNAVAILABLE", 500);
  }
}

/* ---------------- recruiter link status & link existing personnel to account ---------------- */
export async function getRecruiterLinkStatus(
  request: Request, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const rawIds = url.searchParams.get("recruiter_ids") ?? "";
  const recruiterIds: string[] = [];
  if (rawIds.trim() !== "") {
    const parts = rawIds.split(",");
    if (parts.length > 100) return fail("ACCOUNT_OPERATION_INVALID", 400);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!UUID.test(trimmed)) return fail("ACCOUNT_OPERATION_INVALID", 400);
      recruiterIds.push(trimmed);
    }
  }
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.readRecruiterLinkStatus({
    ...actor.value,
    recruiter_ids: recruiterIds,
  });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, status: result.data }, 200);
}

export async function getRecruiterLinkCandidates(
  request: Request, recruiterId: string, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  void request;
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(recruiterId)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.readRecruiterLinkCandidates({
    ...actor.value,
    recruiter_id: recruiterId,
  });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, candidates: result.data }, 200);
}

export async function linkRecruiterToAccount(
  request: Request, recruiterId: string, flag: string | undefined, deps: AccountOperationDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  if (!UUID.test(recruiterId)) return fail("ACCOUNT_OPERATION_INVALID", 400);
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const authority = forbidAuthority(body.value);
  if (authority) return authority;
  const parsed = parseLinkRecruiterToAccount(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  const mismatch = idempotencyMismatch(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;
  return runLinkRecruiterToAccount(recruiterId, parsed.value, deps);
}

async function runLinkRecruiterToAccount(
  recruiterId: string, input: LinkRecruiterToAccountRequest, deps: AccountOperationDependencies,
): Promise<Response> {
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.linkRecruiterToAccount({
    ...actor.value,
    recruiter_id: recruiterId,
    expected_recruiter_version: input.expected_recruiter_version,
    account_ref: input.account_ref,
    expected_account_version: input.expected_account_version,
    reason: input.reason,
    idempotency_key: input.idempotency_key,
  });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, link: result.data }, 200);
}
