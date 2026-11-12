import "server-only";

import type { WorkReportActorRef } from "./assignment-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportDelegationRpcOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind:
        | "actor-denied"
        | "scope-denied"
        | "denied"
        | "invalid"
        | "not-found"
        | "conflict"
        | "unavailable";
    };

export type WorkReportDelegatableCapability = "report_assign" | "report_review";

export type WorkReportDelegationItem = {
  delegation_id: string;
  grantor_user_id: string;
  grantor_display_name: string;
  delegate_app_user_id: string;
  delegate_display_name: string;
  capability: WorkReportDelegatableCapability;
  template_id: string;
  template_code: string;
  template_name: string;
  scope_kind: "all" | "team";
  scope_id: string | null;
  scope_team_id: string | null;
  scope_label: string;
  effective_from: string;
  effective_to: string | null;
  state: "ACTIVE" | "REVOKED";
  status?: "ACTIVE" | "REVOKED" | "EXPIRED";
  is_current: boolean;
  is_effective: boolean;
  revoked_at: string | null;
  version: number;
  created_at: string;
};

export type WorkReportDelegationOptions = {
  delegates: ReadonlyArray<{
    app_user_id: string;
    display_name: string;
    team_id: string | null;
  }>;
  templates: ReadonlyArray<{
    template_id: string;
    template_code: string;
    display_name: string;
  }>;
  scopes: ReadonlyArray<{
    kind: "all" | "team";
    id: string;
    label: string;
  }>;
  capabilities: ReadonlyArray<WorkReportDelegatableCapability>;
};

export type WorkReportDelegationListPayload = {
  items: ReadonlyArray<WorkReportDelegationItem>;
  options: WorkReportDelegationOptions;
};

export type WorkReportDelegationMutationResult = {
  delegation_id: string;
  state: "ACTIVE" | "REVOKED";
  version: number;
};

export type WorkReportDelegationRepository = {
  list(
    actor: WorkReportActorRef,
  ): Promise<WorkReportDelegationRpcOutcome<WorkReportDelegationListPayload>>;
  create(
    input: WorkReportActorRef & {
      capability: WorkReportDelegatableCapability;
      delegate_app_user_id: string;
      template_id: string;
      scope_kind: "all" | "team";
      scope_team_id: string | null;
      effective_from?: string | null;
      effective_to?: string | null;
      idempotency_key: string;
    },
  ): Promise<WorkReportDelegationRpcOutcome<WorkReportDelegationMutationResult>>;
  revoke(
    input: WorkReportActorRef & {
      delegation_id: string;
      expected_version: number;
      idempotency_key: string;
    },
  ): Promise<WorkReportDelegationRpcOutcome<WorkReportDelegationMutationResult>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDelegationItem(value: unknown): value is WorkReportDelegationItem {
  return (
    isRecord(value) &&
    typeof value.delegation_id === "string" &&
    UUID.test(value.delegation_id) &&
    typeof value.grantor_user_id === "string" &&
    UUID.test(value.grantor_user_id) &&
    typeof value.grantor_display_name === "string" &&
    typeof value.delegate_app_user_id === "string" &&
    UUID.test(value.delegate_app_user_id) &&
    typeof value.delegate_display_name === "string" &&
    (value.capability === "report_assign" || value.capability === "report_review") &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    typeof value.template_code === "string" &&
    typeof value.template_name === "string" &&
    (value.scope_kind === "all" || value.scope_kind === "team") &&
    (value.scope_id === null || typeof value.scope_id === "string") &&
    (value.scope_team_id === null ||
      (typeof value.scope_team_id === "string" && UUID.test(value.scope_team_id))) &&
    typeof value.scope_label === "string" &&
    typeof value.effective_from === "string" &&
    (value.effective_to === null || typeof value.effective_to === "string") &&
    (value.state === "ACTIVE" || value.state === "REVOKED") &&
    (value.status === undefined ||
      value.status === "ACTIVE" ||
      value.status === "REVOKED" ||
      value.status === "EXPIRED") &&
    typeof value.is_current === "boolean" &&
    typeof value.is_effective === "boolean" &&
    (value.revoked_at === null || typeof value.revoked_at === "string") &&
    Number.isInteger(value.version) &&
    typeof value.created_at === "string"
  );
}

function isListPayload(value: unknown): value is WorkReportDelegationListPayload {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isDelegationItem) &&
    isRecord(value.options) &&
    Array.isArray(value.options.delegates) &&
    Array.isArray(value.options.templates) &&
    Array.isArray(value.options.scopes) &&
    Array.isArray(value.options.capabilities) &&
    value.options.capabilities.every(
      (cap) => cap === "report_assign" || cap === "report_review",
    )
  );
}

function isMutationResult(value: unknown): value is WorkReportDelegationMutationResult {
  return (
    isRecord(value) &&
    typeof value.delegation_id === "string" &&
    UUID.test(value.delegation_id) &&
    (value.state === "ACTIVE" || value.state === "REVOKED") &&
    Number.isInteger(value.version)
  );
}

function classify(error: { code?: string; message?: string }): WorkReportDelegationRpcOutcome<never> {
  const msg = error.message ?? "";
  if (error.code === "42501") {
    if (msg.includes("WORK_REPORT_ACTOR_DENIED")) {
      return { ok: false, kind: "actor-denied" };
    }
    if (msg.includes("WORK_REPORT_SCOPE_DENIED") || msg.includes("WORK_REPORT_DELEGATE_OUT_OF_SCOPE")) {
      return { ok: false, kind: "scope-denied" };
    }
    return { ok: false, kind: "denied" };
  }
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505" || error.code === "23P01") {
    return { ok: false, kind: "conflict" };
  }
  if (error.code === "P0002") {
    return { ok: false, kind: "not-found" };
  }
  if (error.code === "22023" || error.code === "23514") {
    return { ok: false, kind: "invalid" };
  }
  return { ok: false, kind: "unavailable" };
}

export function createDelegationRepository(rpc?: Rpc): WorkReportDelegationRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };
  const run = async <T>(
    name: string,
    args: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<WorkReportDelegationRpcOutcome<T>> => {
    try {
      const { data, error } = await invoke(name, args);
      if (error) return classify(error);
      return valid(data) ? { ok: true, data } : { ok: false, kind: "unavailable" };
    } catch {
      console.error(`[work-reports] ${name} RPC failed`);
      return { ok: false, kind: "unavailable" };
    }
  };

  return {
    list(actor) {
      return run(
        "work_report_list_delegations",
        {
          p_auth_subject: actor.auth_subject,
          p_app_user_id: actor.app_user_id,
        },
        isListPayload,
      );
    },
    create(input) {
      return run(
        "work_report_create_delegation",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_capability: input.capability,
          p_delegate_app_user_id: input.delegate_app_user_id,
          p_template_id: input.template_id,
          p_scope_kind: input.scope_kind,
          p_scope_team_id: input.scope_team_id,
          p_effective_from: input.effective_from ?? null,
          p_effective_to: input.effective_to ?? null,
          p_idempotency_key: input.idempotency_key,
        },
        isMutationResult,
      );
    },
    revoke(input) {
      return run(
        "work_report_revoke_delegation",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_delegation_id: input.delegation_id,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        },
        isMutationResult,
      );
    },
  };
}
