import "server-only";

import { createHash } from "node:crypto";

import type { FullProfilePayload } from "./full-profile-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type FullProfileRepositoryResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "unavailable"; code?: string };

const SAFE_INVALID_CODES = new Set([
  "BANK_NOT_ACTIVE",
  "BATCH_INVALID",
  "COLLABORATOR_INVALID",
  "COLLABORATOR_NOT_ACTIVE",
  "CONTRACT_VERSION_UNSUPPORTED",
  "EMPLOYEE_CODE_DUPLICATE",
  "EMPLOYEE_CODE_SEQUENCE_EXHAUSTED",
  "EMPLOYEE_CODE_LEGACY_QUARANTINE",
  "EMPLOYEE_CODE_YEAR",
  "GENERAL_NOTE_TOO_LONG",
  "NATIONAL_ID_DUPLICATE",
  "NATIONAL_ID_INVALID",
  "OFF_REQUIRES_DATE_AND_REASON",
  "PROJECT_NOT_ACTIVE",
  "RECRUITER_NOT_ACTIVE",
  "RECRUITER_MEMBERSHIP_INVALID",
  "PAYMENT_DETAILS_INVALID",
  "PROFILE_DATE_INVALID",
]);

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * P2.5-HF-R1: a raw DB message never reaches the client. The episode guards raise 23505 with a
 * machine message, which is translated here into the public code below; anything unmapped falls
 * back to BATCH_INVALID. No public code and no log line carries the CCCD.
 */
const SAFE_ERROR_ALIASES: Record<string, string> = {
  worker_active_episode_exists: "WORKER_ACTIVE_EPISODE_EXISTS",
  worker_episode_reopen_forbidden: "WORKER_EPISODE_REOPEN_FORBIDDEN",
  "team membership missing or ambiguous": "RECRUITER_MEMBERSHIP_INVALID",
  "provider membership missing, ambiguous, or mismatched": "RECRUITER_MEMBERSHIP_INVALID",
  "team is not active": "RECRUITER_MEMBERSHIP_INVALID",
  "recruiter is not active": "RECRUITER_NOT_ACTIVE",
  "project is not active": "PROJECT_NOT_ACTIVE",
  "collaborator is not active": "COLLABORATOR_NOT_ACTIVE",
  "provider collaborator_id invalid": "COLLABORATOR_INVALID",
};

const SAFE_DENIAL_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  "PROJECT_SCOPE_DENIED": "PROJECT_SCOPE",
  "worker create authority denied": "CREATE_AUTHORITY",
  "entry creation own scope denied": "OWN_SCOPE",
  "actor mapping denied": "ACTOR_MAPPING",
  "capability denied": "CAPABILITY",
});

function logDeniedBatch(error: { message?: string }, payload: FullProfilePayload): void {
  const rows = payload.rows;
  const category = error.message === undefined
    ? "UNKNOWN"
    : SAFE_DENIAL_CATEGORIES[error.message] ?? "UNKNOWN";
  console.warn("[direct-entry] full-profile denied", {
    category,
    message_fingerprint: createHash("sha256").update(error.message ?? "").digest("hex"),
    contract_version: payload.contract_version,
    row_count: rows.length,
    distinct_project_count: new Set(rows.map((row) => row.project_id)).size,
    payment_row_count: rows.filter((row) => row.payment !== null).length,
    employment_row_count: rows.filter((row) => row.employment !== null).length,
  });
}

function safeInvalidCode(message: string | undefined): string {
  if (message === undefined) return "BATCH_INVALID";
  const alias = SAFE_ERROR_ALIASES[message];
  if (alias !== undefined) return alias;
  return SAFE_INVALID_CODES.has(message) ? message : "BATCH_INVALID";
}

function classify(error: { code?: string; message?: string }): FullProfileRepositoryResult {
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "PT409" || error.code === "40001" ||
      (error.code === "22023" && error.message === "idempotency key reused with different input")) {
    return { ok: false, kind: "conflict" };
  }
  if (error.code === "22023" || error.code === "22008" || error.code === "23514") {
    return { ok: false, kind: "invalid", code: safeInvalidCode(error.message) };
  }
  if (error.code === "23505") {
    return { ok: false, kind: "invalid", code: safeInvalidCode(error.message) };
  }
  return { ok: false, kind: "unavailable" };
}

function logUnavailableBatch(
  rpcName: string,
  error: { code?: string; message?: string },
  payload: FullProfilePayload,
): void {
  console.error("[direct-entry] full-profile batch RPC unavailable", {
    rpc: rpcName,
    sqlstate: error.code ?? "UNKNOWN",
    message_fingerprint: createHash("sha256").update(error.message ?? "").digest("hex"),
    contract_version: payload.contract_version,
    row_count: payload.rows.length,
  });
}

function canFallbackV12ToV11(payload: FullProfilePayload): boolean {
  return (
    payload.contract_version === "worker-profile/1.2" &&
    payload.rows.every((row) => typeof row.display_name === "string" && row.display_name.trim() !== "")
  );
}

export function createFullProfileRepository(rpc?: Rpc) {
  let resolvedRpc = rpc;
  return {
    async createFullProfileBatch(input: ActorRef & {
      payload: FullProfilePayload;
      idempotency_key: string;
    }): Promise<FullProfileRepositoryResult> {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const rpcName =
          input.payload.contract_version === "worker-profile/1.1" ||
          input.payload.contract_version === "worker-profile/1.2"
            ? "direct_entry_create_full_profile_batch_v2"
            : "direct_entry_create_full_profile_batch";
        let { data, error } = await resolvedRpc(rpcName, {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_contract_version: input.payload.contract_version,
          p_rows: input.payload.rows,
          p_idempotency_key: input.idempotency_key,
        });
        if (
          error?.code === "22023" &&
          error.message === "CONTRACT_VERSION_UNSUPPORTED" &&
          canFallbackV12ToV11(input.payload)
        ) {
          ({ data, error } = await resolvedRpc(rpcName, {
            p_auth_subject: input.auth_subject,
            p_app_user_id: input.app_user_id,
            p_contract_version: "worker-profile/1.1",
            p_rows: input.payload.rows,
            p_idempotency_key: input.idempotency_key,
          }));
        }
        if (error?.code === "42501") logDeniedBatch(error, input.payload);
        if (!error) return { ok: true, data };
        const classified = classify(error);
        if (!classified.ok && classified.kind === "unavailable") {
          logUnavailableBatch(rpcName, error, input.payload);
        }
        return classified;
      } catch {
        console.error("[direct-entry] full-profile batch RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async createFullProfileBatchWithPortraitStages(input: ActorRef & {
      payload: FullProfilePayload;
      idempotency_key: string;
      portrait_stage_ids: string[];
    }): Promise<FullProfileRepositoryResult> {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const rpcName = "direct_entry_create_full_profile_batch_with_portrait_stages";
        let { data, error } = await resolvedRpc(
          rpcName,
          {
            p_auth_subject: input.auth_subject,
            p_app_user_id: input.app_user_id,
            p_contract_version: input.payload.contract_version,
            p_rows: input.payload.rows,
            p_idempotency_key: input.idempotency_key,
            p_stage_ids: input.portrait_stage_ids,
          },
        );
        if (
          error?.code === "22023" &&
          error.message === "CONTRACT_VERSION_UNSUPPORTED" &&
          canFallbackV12ToV11(input.payload)
        ) {
          ({ data, error } = await resolvedRpc(
            rpcName,
            {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_contract_version: "worker-profile/1.1",
              p_rows: input.payload.rows,
              p_idempotency_key: input.idempotency_key,
              p_stage_ids: input.portrait_stage_ids,
            },
          ));
        }
        if (error?.code === "42501") logDeniedBatch(error, input.payload);
        if (!error) return { ok: true, data };
        const classified = classify(error);
        if (!classified.ok && classified.kind === "unavailable") {
          logUnavailableBatch(rpcName, error, input.payload);
        }
        return classified;
      } catch {
        console.error("[direct-entry] portrait full-profile batch RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
