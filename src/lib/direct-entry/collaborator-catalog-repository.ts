/**
 * Repository boundary for collaborator (CTV) master catalog admin RPCs.
 *
 * - Calls ONLY the 5 canonical service_role RPCs; never queries tables directly.
 * - auth_subject / app_user_id come strictly from server session context.
 * - DB guard (direct_entry_assert_catalog_operator) remains final authority.
 * - Strict response projection; malformed => unavailable (fail-closed).
 */
import "server-only";

import {
  collaboratorCatalogItem,
  collaboratorCatalogList,
  collaboratorCatalogMutation,
  type AdminCollaborator,
  type AdminCollaboratorList,
  type AdminCollaboratorMutation,
} from "./collaborator-catalog-contract.ts";
import {
  classifyPartnerCatalogError,
  type PartnerCatalogErrorKind,
} from "./vendor-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type CollaboratorCatalogErrorKind = PartnerCatalogErrorKind;

export type CollaboratorCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: CollaboratorCatalogErrorKind };

export type CollaboratorCatalogRepository = {
  listCollaborators(
    input: AdminActorRef & {
      search: string | null;
      include_inactive: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<CollaboratorCatalogOutcome<AdminCollaboratorList>>;
  getCollaborator(
    input: AdminActorRef & { collaborator_id: string },
  ): Promise<CollaboratorCatalogOutcome<AdminCollaborator>>;
  createCollaborator(
    input: AdminActorRef & {
      expected_version: 0;
      collaborator_id: string;
      display_name: string;
      address?: string | null;
      phone?: string | null;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<CollaboratorCatalogOutcome<AdminCollaboratorMutation>>;
  updateCollaborator(
    input: AdminActorRef & {
      collaborator_id: string;
      expected_version: number;
      display_name: string;
      address?: string | null;
      phone?: string | null;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<CollaboratorCatalogOutcome<AdminCollaboratorMutation>>;
  setCollaboratorActive(
    input: AdminActorRef & {
      collaborator_id: string;
      active: boolean;
      expected_version: number;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<CollaboratorCatalogOutcome<AdminCollaboratorMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * Map PostgreSQL SQLSTATE codes to sanitized error kinds.
 * Unrecognized codes fail closed as `unavailable`.
 */
export function classifyCollaboratorCatalogError(error: {
  code?: string;
  message?: string;
}): CollaboratorCatalogErrorKind {
  return classifyPartnerCatalogError(error);
}

function unavailable(): never {
  console.error("[collaborator-catalog] RPC failed");
  throw new Error("collaborator catalog RPC failed");
}

export function createCollaboratorCatalogRepository(rpc?: Rpc): CollaboratorCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<CollaboratorCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyCollaboratorCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listCollaborators(input) {
      return call(
        "direct_entry_list_collaborators_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        collaboratorCatalogList,
      );
    },
    getCollaborator(input) {
      return call(
        "direct_entry_get_collaborator_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_collaborator_id: input.collaborator_id,
        },
        collaboratorCatalogItem,
      );
    },
    createCollaborator(input) {
      return call(
        "direct_entry_create_collaborator",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_expected_version: input.expected_version,
          p_collaborator_id: input.collaborator_id,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_address: input.address ?? null,
          p_phone: input.phone ?? null,
        },
        collaboratorCatalogMutation,
      );
    },
    updateCollaborator(input) {
      return call(
        "direct_entry_update_collaborator",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_collaborator_id: input.collaborator_id,
          p_expected_version: input.expected_version,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
          p_address: input.address ?? null,
          p_phone: input.phone ?? null,
        },
        collaboratorCatalogMutation,
      );
    },
    setCollaboratorActive(input) {
      return call(
        "direct_entry_set_collaborator_active",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_collaborator_id: input.collaborator_id,
          p_active: input.active,
          p_expected_version: input.expected_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        collaboratorCatalogMutation,
      );
    },
  };
}
