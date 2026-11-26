import "server-only";

import {
  projectWorkerEditHistoryRevision,
  projectWorkerEditHistorySearch,
  type WorkerEditHistoryError,
  type WorkerEditHistoryRevision,
  type WorkerEditHistorySearch,
  type WorkerEditHistorySearchQuery,
} from "./worker-edit-history-contract.ts";

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };
type Rpc = (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
type Actor = { auth_subject: string; app_user_id: string };

export type WorkerEditHistoryRepository = {
  search(input: Actor & WorkerEditHistorySearchQuery): Promise<{ ok: true; value: WorkerEditHistorySearch } | { ok: false; code: WorkerEditHistoryError }>;
  getRevision(input: Actor & { entry_id: string; revision_id: string }): Promise<{ ok: true; value: WorkerEditHistoryRevision } | { ok: false; code: WorkerEditHistoryError }>;
};

function createServiceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

function mapRpcError(error: { code?: string; message?: string }): WorkerEditHistoryError {
  const message = error.message ?? "";
  if (message.includes("WORKER_EDIT_HISTORY_ACCESS_DENIED") || error.code === "42501") return "WORKER_EDIT_HISTORY_ACCESS_DENIED";
  if (message.includes("WORKER_EDIT_HISTORY_NOT_FOUND") || error.code === "P0002") return "WORKER_EDIT_HISTORY_NOT_FOUND";
  if (message.includes("WORKER_EDIT_HISTORY_QUERY_INVALID") || error.code === "22023") return "WORKER_EDIT_HISTORY_QUERY_INVALID";
  return "WORKER_EDIT_HISTORY_UNAVAILABLE";
}

export function createWorkerEditHistoryRepository(rpc?: Rpc): WorkerEditHistoryRepository {
  let call = rpc;
  const invoke = async (name: string, args: Record<string, unknown>): Promise<RpcResult> => {
    call ??= createServiceRoleRpc();
    return call(name, args);
  };
  return {
    async search(input) {
      try {
        const normalizedEmployeeCode =
          typeof input.employee_code === "string" && input.employee_code.trim() !== ""
            ? input.employee_code.trim()
            : null;
        const rpcArgs: Record<string, unknown> = {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_national_id: null,
          p_full_name: null,
          p_from_date: input.from_date,
          p_to_date: input.to_date,
          p_action_group: input.action_group,
          p_project_query: input.project_id,
          p_recruiter_query: input.recruiter_id,
          p_page_size: input.page_size,
          p_cursor: input.cursor,
          ...(normalizedEmployeeCode !== null ? { p_employee_code: normalizedEmployeeCode } : {}),
        };
        const result = await invoke("worker_edit_history_search", rpcArgs);
        if (result.error) return { ok: false, code: mapRpcError(result.error) };
        const value = projectWorkerEditHistorySearch(result.data);
        return value ? { ok: true, value } : { ok: false, code: "WORKER_EDIT_HISTORY_UNAVAILABLE" };
      } catch {
        console.error("[worker-edit-history] search RPC unavailable");
        return { ok: false, code: "WORKER_EDIT_HISTORY_UNAVAILABLE" };
      }
    },
    async getRevision(input) {
      try {
        const result = await invoke("worker_edit_history_get_revision", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_revision_id: input.revision_id,
        });
        if (result.error) return { ok: false, code: mapRpcError(result.error) };
        const value = projectWorkerEditHistoryRevision(result.data);
        return value ? { ok: true, value } : { ok: false, code: "WORKER_EDIT_HISTORY_UNAVAILABLE" };
      } catch {
        console.error("[worker-edit-history] detail RPC unavailable");
        return { ok: false, code: "WORKER_EDIT_HISTORY_UNAVAILABLE" };
      }
    },
  };
}
