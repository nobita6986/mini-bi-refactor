import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { AccountOperationAuth } from "../admin/account-operation-auth.ts";
import type { PartnerAccountState, PartnerKind } from "../auth/direct-entry-v2.ts";
import type { PartnerErrorCode } from "./contract.ts";
import type { PartnerRepository } from "./repository.ts";

/**
 * Initial password for newly provisioned Vendor and CTV partner accounts.
 * Server-only: NEVER log, audit, persist in DB, or return in any HTTP response.
 */
export const PARTNER_INITIAL_PASSWORD = "hrp@123";

export const PARTNER_ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generatePartnerActivationCode(): string {
  return randomBytes(15).toString("base64url");
}

export function hashPartnerActivationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export type PartnerProvisionAuth = Pick<
  AccountOperationAuth,
  "createAuthAccount" | "findAuthUserByLoginId" | "readAuthUserProvenance"
>;

export type PartnerProvisioningDeps = {
  repository: PartnerRepository;
  auth: PartnerProvisionAuth;
  generateActivationCode?: () => string;
  nowMs?: () => number;
  activationTtlMs?: number;
};

export type ProvisionPartnerSuccess = {
  ok: true;
  provision: {
    partner_kind: PartnerKind;
    partner_id: string;
    canonical_code: string;
    account_ref: string;
    account_state: PartnerAccountState;
    must_change_password: true;
    activation_code: string;
    activation_expires_at: string;
    resumed: boolean;
  };
};

export type ProvisionPartnerOutcome =
  | ProvisionPartnerSuccess
  | { ok: false; code: PartnerErrorCode };

export async function provisionPartnerAccount(
  input: {
    auth_subject: string;
    actor_app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
    reason: string | null;
    idempotency_key: string;
  },
  deps: PartnerProvisioningDeps,
): Promise<ProvisionPartnerOutcome> {
  const began = await deps.repository.provisionBegin(input);
  if (!began.ok) {
    return { ok: false, code: began.code };
  }
  const beginData = began.data;

  let createdAuthSubject: string | null = null;
  if (beginData.resumed) {
    const existing = await deps.auth.findAuthUserByLoginId({
      login_id: beginData.canonical_code,
      intent_token: beginData.intent_token,
    });
    if (existing.kind === "match") {
      createdAuthSubject = existing.auth_subject;
    } else if (existing.kind === "mismatch") {
      return { ok: false, code: "PARTNER_CONFLICT" };
    } else if (existing.kind === "unknown") {
      return { ok: false, code: "PARTNER_PROVISION_INDETERMINATE" };
    }
  }

  if (createdAuthSubject === null) {
    const created = await deps.auth.createAuthAccount({
      login_id: beginData.canonical_code,
      password: PARTNER_INITIAL_PASSWORD,
      intent_token: beginData.intent_token,
    });

    if (created.kind === "created") {
      const provenance = await deps.auth.readAuthUserProvenance({
        auth_subject: created.auth_subject,
        intent_token: beginData.intent_token,
      });
      if (provenance.kind === "match") {
        createdAuthSubject = created.auth_subject;
      } else if (provenance.kind === "mismatch") {
        return { ok: false, code: "PARTNER_CONFLICT" };
      } else {
        return { ok: false, code: "PARTNER_PROVISION_INDETERMINATE" };
      }
    } else {
      const reconciled = await deps.auth.findAuthUserByLoginId({
        login_id: beginData.canonical_code,
        intent_token: beginData.intent_token,
      });
      if (reconciled.kind === "match") {
        createdAuthSubject = reconciled.auth_subject;
      } else if (reconciled.kind === "mismatch") {
        return { ok: false, code: "PARTNER_CONFLICT" };
      } else if (created.kind === "failure") {
        return { ok: false, code: "PARTNER_CONFLICT" };
      } else {
        return { ok: false, code: "PARTNER_PROVISION_INDETERMINATE" };
      }
    }
  }

  const activationCode = (deps.generateActivationCode ?? generatePartnerActivationCode)();
  const activationHash = hashPartnerActivationCode(activationCode);
  const ttlMs = deps.activationTtlMs ?? PARTNER_ACTIVATION_TTL_MS;
  const expiresAt = new Date((deps.nowMs ?? Date.now)() + ttlMs).toISOString();

  const finalized = await deps.repository.provisionFinalize({
    auth_subject: input.auth_subject,
    actor_app_user_id: input.actor_app_user_id,
    partner_kind: beginData.partner_kind,
    partner_id: beginData.partner_id,
    intent_id: beginData.intent_id,
    intent_token: beginData.intent_token,
    created_auth_subject: createdAuthSubject,
    activation_code_hash: activationHash,
    activation_expires_at: expiresAt,
    idempotency_key: input.idempotency_key,
  });

  if (!finalized.ok) {
    return { ok: false, code: finalized.code };
  }

  return {
    ok: true,
    provision: {
      partner_kind: finalized.data.partner_kind,
      partner_id: finalized.data.partner_id,
      canonical_code: finalized.data.canonical_code,
      account_ref: finalized.data.app_user_id,
      account_state: finalized.data.account_state,
      must_change_password: true,
      activation_code: activationCode,
      activation_expires_at: finalized.data.activation_expires_at,
      resumed: beginData.resumed,
    },
  };
}

export type RotateActivationOutcome =
  | {
      ok: true;
      activation: {
        partner_kind: PartnerKind;
        partner_id: string;
        canonical_code: string;
        account_ref: string;
        account_state: PartnerAccountState;
        activation_code: string;
        activation_expires_at: string;
      };
    }
  | { ok: false; code: PartnerErrorCode };

export async function rotatePartnerActivationCode(
  input: {
    auth_subject: string;
    actor_app_user_id: string;
    partner_kind: PartnerKind;
    partner_id: string;
    reason: string | null;
    idempotency_key: string;
  },
  deps: Pick<
    PartnerProvisioningDeps,
    "repository" | "generateActivationCode" | "nowMs" | "activationTtlMs"
  >,
): Promise<RotateActivationOutcome> {
  const activationCode = (deps.generateActivationCode ?? generatePartnerActivationCode)();
  const activationHash = hashPartnerActivationCode(activationCode);
  const ttlMs = deps.activationTtlMs ?? PARTNER_ACTIVATION_TTL_MS;
  const expiresAt = new Date((deps.nowMs ?? Date.now)() + ttlMs).toISOString();

  const rotated = await deps.repository.rotateActivation({
    auth_subject: input.auth_subject,
    actor_app_user_id: input.actor_app_user_id,
    partner_kind: input.partner_kind,
    partner_id: input.partner_id,
    activation_code_hash: activationHash,
    activation_expires_at: expiresAt,
    reason: input.reason,
    idempotency_key: input.idempotency_key,
  });

  if (!rotated.ok) {
    return { ok: false, code: rotated.code };
  }
  if (!rotated.data.app_user_id || !rotated.data.activation_expires_at) {
    return { ok: false, code: "PARTNER_UNAVAILABLE" };
  }

  return {
    ok: true,
    activation: {
      partner_kind: rotated.data.partner_kind,
      partner_id: rotated.data.partner_id,
      canonical_code: rotated.data.canonical_code,
      account_ref: rotated.data.app_user_id,
      account_state: rotated.data.account_state,
      activation_code: activationCode,
      activation_expires_at: rotated.data.activation_expires_at,
    },
  };
}

export type ActivatePartnerOutcome =
  | {
      ok: true;
      partner_kind: PartnerKind;
      partner_code: string;
      account_state: "ACTIVE_MUST_CHANGE_PASSWORD";
      must_change_password: true;
    }
  | { ok: false; code: "PARTNER_ACTIVATION_INVALID" };

export async function activatePartnerAccount(
  input: { code: string; activation_code: string },
  deps: Pick<PartnerProvisioningDeps, "repository">,
): Promise<ActivatePartnerOutcome> {
  const activationHash = hashPartnerActivationCode(input.activation_code.trim());
  const outcome = await deps.repository.activateAccount({
    username: input.code.trim().toLowerCase(),
    activation_code_hash: activationHash,
  });

  if (!outcome.ok || !outcome.data.ok) {
    return { ok: false, code: "PARTNER_ACTIVATION_INVALID" };
  }

  return {
    ok: true,
    partner_kind: outcome.data.partner_kind,
    partner_code: outcome.data.partner_id,
    account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
    must_change_password: true,
  };
}
