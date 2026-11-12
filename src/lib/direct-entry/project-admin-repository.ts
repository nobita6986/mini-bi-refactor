/**
 * P2.5-W06A-R1 - Repository boundary cho Project Operations (W02 admin RPC).
 *
 * - Chi goi 8 RPC canonical; KHONG doc/ghi table truc tiep, KHONG raw upsert.
 * - Deactivate dung direct_entry_set_project_active(..., false) nhu canonical.
 * - Detail du an = get_project_admin (master) + list_project_manager_assignments
 *   (assignments + history) — khong tu join/read table.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  projectAdminAssignMutation,
  projectAdminAssignments,
  projectAdminCreateMutation,
  projectAdminCandidates,
  projectAdminList,
  projectAdminLocationMutation,
  projectAdminMutation,
  projectAdminProject,
  projectAdminUnassignMutation,
} from "./project-admin-contract.ts";
import type {
  AdminAssignmentMutation,
  AdminManagerCandidates,
  AdminProject,
  AdminProjectAssignments,
  AdminProjectCreateMutation,
  AdminProjectDetail,
  AdminProjectList,
  AdminProjectLocationMutation,
  AdminProjectMutation,
} from "./project-admin-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type ProjectAdminOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ProjectAdminErrorKind };

export type ProjectAdminErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type ProjectAdminRepository = {
  listProjects(input: AdminActorRef & { include_inactive: boolean }):
    Promise<ProjectAdminOutcome<AdminProjectList>>;
  getProject(input: AdminActorRef & { project_id: string }):
    Promise<ProjectAdminOutcome<AdminProject>>;
  listAssignments(input: AdminActorRef & { project_id: string }):
    Promise<ProjectAdminOutcome<AdminProjectAssignments>>;
  listManagerCandidates(input: AdminActorRef & { search: string | null }):
    Promise<ProjectAdminOutcome<AdminManagerCandidates>>;
  getProjectDetail(input: AdminActorRef & { project_id: string }):
    Promise<ProjectAdminOutcome<AdminProjectDetail>>;
  createProject(input: AdminActorRef & {
    project_id: string; display_name: string; reason: string | null; idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminProjectCreateMutation>>;
  updateProject(input: AdminActorRef & {
    project_id: string; expected_version: number; display_name: string;
    reason: string | null; idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminProjectMutation>>;
  /** active=false la deactivate canonical; khong co RPC deactivate rieng. */
  setProjectActive(input: AdminActorRef & {
    project_id: string; active: boolean; expected_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminProjectMutation>>;
  assignManager(input: AdminActorRef & {
    project_id: string; manager_recruiter_id: string; valid_from: string | null;
    expected_project_version: number; reason: string | null; idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminAssignmentMutation>>;
  unassignManager(input: AdminActorRef & {
    assignment_id: string; expected_version: number; expected_project_version: number;
    reason: string | null; idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminAssignmentMutation>>;
  updateProjectLocation?(input: AdminActorRef & {
    project_id: string;
    expected_version: number;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    radius_meters: number;
    clear: boolean;
    reason: string | null;
    idempotency_key: string;
  }): Promise<ProjectAdminOutcome<AdminProjectLocationMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC thuc su dung:
 *   PT409/40001 OCC stale (project_version hoac assignment version)
 *   23505 idempotency key unique / already assigned
 *   42501 capability/scope denied (thieu entry_admin hoac khong @all)
 *   P0002 project/assignment not found
 *   22023 input sai; rieng message reuse-khac-payload la conflict
 *   23514 rang buoc du lieu (vd interval/valid_from khong hop le)
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyProjectAdminError(
  error: { code?: string; message?: string },
): ProjectAdminErrorKind {
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
  console.error("[direct-entry] project admin RPC failed");
  throw new Error("project admin RPC failed");
}

export function createProjectAdminRepository(rpc?: Rpc): ProjectAdminRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function read<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<ProjectAdminOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyProjectAdminError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  async function mutation<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<ProjectAdminOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyProjectAdminError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listProjects(input) {
      return read("direct_entry_list_projects_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_include_inactive: input.include_inactive,
      }, projectAdminList);
    },
    getProject(input) {
      return read("direct_entry_get_project_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
      }, projectAdminProject);
    },
    listAssignments(input) {
      return read("direct_entry_list_project_manager_assignments", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_include_history: true,
      }, projectAdminAssignments);
    },
    listManagerCandidates(input) {
      return read("direct_entry_list_project_manager_candidates", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
      }, projectAdminCandidates);
    },
    async getProjectDetail(input) {
      const master = await read("direct_entry_get_project_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
      }, projectAdminProject);
      if (!master.ok) return master;
      const assignments = await read("direct_entry_list_project_manager_assignments", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_include_history: true,
      }, projectAdminAssignments);
      if (!assignments.ok) return assignments;
      return { ok: true, data: { master: master.data, assignments: assignments.data } };
    },
    createProject(input) {
      return mutation("direct_entry_create_project", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminCreateMutation);
    },
    updateProject(input) {
      return mutation("direct_entry_update_project", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminMutation);
    },
    setProjectActive(input) {
      return mutation("direct_entry_set_project_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminMutation);
    },
    assignManager(input) {
      return mutation("direct_entry_assign_project_manager", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_manager_recruiter_id: input.manager_recruiter_id,
        p_valid_from: input.valid_from,
        p_expected_project_version: input.expected_project_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminAssignMutation);
    },
    unassignManager(input) {
      return mutation("direct_entry_unassign_project_manager", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_assignment_id: input.assignment_id,
        p_expected_version: input.expected_version,
        p_expected_project_version: input.expected_project_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminUnassignMutation);
    },
    updateProjectLocation(input) {
      return mutation("direct_entry_update_project_location", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_project_id: input.project_id,
        p_expected_version: input.expected_version,
        p_address: input.address,
        p_latitude: input.latitude,
        p_longitude: input.longitude,
        p_radius_meters: input.radius_meters,
        p_clear: input.clear,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectAdminLocationMutation);
    },
  };
}
