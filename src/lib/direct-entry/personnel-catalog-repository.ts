/**
 * P3.1-W01B - Repository boundary cho personnel catalog admin (#68).
 *
 * - Chi goi 5 RPC canonical cua migration #68; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  personnelCatalogCreateResult,
  personnelCatalogItem,
  personnelCatalogList,
  personnelCatalogMutation,
} from "./personnel-catalog-contract.ts";
import type {
  AdminPersonnel,
  AdminPersonnelCreateResult,
  AdminPersonnelList,
  AdminPersonnelMutation,
  PersonnelPosition,
} from "./personnel-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type PersonnelCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: PersonnelCatalogErrorKind };

export type PersonnelCatalogErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type PersonnelCatalogRepository = {
  listPersonnel(input: AdminActorRef & {
    search: string | null;
    include_inactive: boolean;
    page: number;
    page_size: number;
    team_id?: string | null;
  }): Promise<PersonnelCatalogOutcome<AdminPersonnelList>>;
  getPersonnel(input: AdminActorRef & { recruiter_id: string }):
    Promise<PersonnelCatalogOutcome<AdminPersonnel>>;
  createPersonnel(input: AdminActorRef & {
    expected_version: number; personnel_code: string; display_name: string;
    personnel_position: PersonnelPosition; valid_from: string;
    reason: string | null; idempotency_key: string;
  }): Promise<PersonnelCatalogOutcome<AdminPersonnelCreateResult>>;
  updatePersonnel(input: AdminActorRef & {
    recruiter_id: string; expected_version: number; display_name: string;
    personnel_code: string; personnel_position: PersonnelPosition;
    reason: string | null; idempotency_key: string;
  }): Promise<PersonnelCatalogOutcome<AdminPersonnelMutation>>;
  setPersonnelActive(input: AdminActorRef & {
    recruiter_id: string; active: boolean; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<PersonnelCatalogOutcome<AdminPersonnelMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #68 thuc su dung:
 *   PT409/40001 OCC stale (personnel version)
 *   23505 personnel_code trung (unique canonical index) hoac idempotency key
 *   42501 catalog operator / all scope denied
 *   P0002 personnel not found
 *   23514 rang buoc du lieu (vi du provider membership interval)
 *   22023 input sai; rieng message reuse-khac-payload la conflict
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyPersonnelCatalogError(
  error: { code?: string; message?: string },
): PersonnelCatalogErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

function unavailable(): never {
  console.error("[personnel-catalog] RPC failed");
  throw new Error("personnel catalog RPC failed");
}

export function createPersonnelCatalogRepository(rpc?: Rpc): PersonnelCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<PersonnelCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyPersonnelCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listPersonnel(input) {
      if (input.team_id === undefined || input.team_id === null) {
        return call("direct_entry_list_personnel_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        }, personnelCatalogList);
      }
      return call("direct_entry_list_personnel_filtered_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
        p_include_inactive: input.include_inactive,
        p_page: input.page,
        p_page_size: input.page_size,
        p_team_id: input.team_id,
      }, personnelCatalogList);
    },
    getPersonnel(input) {
      return call("direct_entry_get_personnel_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
      }, personnelCatalogItem);
    },
    createPersonnel(input) {
      return call("direct_entry_create_personnel", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_expected_version: input.expected_version,
        p_personnel_code: input.personnel_code,
        p_display_name: input.display_name,
        p_personnel_position: input.personnel_position,
        p_valid_from: input.valid_from,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, personnelCatalogCreateResult);
    },
    updatePersonnel(input) {
      return call("direct_entry_update_personnel", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_personnel_code: input.personnel_code,
        p_personnel_position: input.personnel_position,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, personnelCatalogMutation);
    },
    setPersonnelActive(input) {
      return call("direct_entry_set_personnel_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_recruiter_id: input.recruiter_id,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, personnelCatalogMutation);
    },
  };
}
