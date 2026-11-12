/**
 * PRE-W2-HF Project↔Team authority (T1A) - Pure UI model for mapping admin.
 */
import {
  parseGrant,
  parseRevoke,
  projectBatchGrantResult,
  projectRevokeResult,
} from "./project-team-scope-contract.ts";
import {
  newIdempotencyKey,
} from "../direct-entry/project-operations-model.ts";

export const MAPPING_PAGE_SIZE = 25;
export const PROJECT_PICKER_PAGE_SIZE = 25;
export const MAX_BATCH_PROJECTS = 100;

export const MAPPING_SEARCH_MAX_LENGTH = 256;

export type MappingFilter = { search: string; includeHistory: boolean; page: number };

export function buildMappingListQuery(input: MappingFilter): URLSearchParams | null {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000) return null;
  const params = new URLSearchParams({ page: String(input.page), page_size: String(MAPPING_PAGE_SIZE) });
  const search = input.search.trim();
  if (search) params.set("search", search.slice(0, MAPPING_SEARCH_MAX_LENGTH));
  if (input.includeHistory) params.set("include_history", "true");
  return params;
}

export function buildGrantRequest(input: {
  projectIds: readonly string[]; teamId: string; reason?: string | null; idempotencyKey: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const raw = {
    team_id: input.teamId,
    project_ids: [...input.projectIds],
    reason: input.reason,
    idempotency_key: input.idempotencyKey,
  };
  const parsed = parseGrant(raw);
  if (!parsed.ok) return { ok: false, message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { ok: true, body: parsed.value };
}

export function buildRevokeRequest(input: {
  mappingId: string; effectiveTo?: string | null; todayVn?: string; reason?: string | null; idempotencyKey: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const raw = {
    mapping_id: input.mappingId,
    effective_to: input.effectiveTo ? input.effectiveTo : null,
    reason: input.reason, idempotency_key: input.idempotencyKey,
  };
  const parsed = parseRevoke(raw, input.todayVn);
  if (!parsed.ok) return { ok: false, message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { ok: true, body: parsed.value };
}

export type MappingUiOutcome =
  | { kind: "applied"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export function toggleProjectSelection(
  selected: readonly string[],
  projectId: string,
  checked: boolean,
): string[] {
  if (checked) {
    if (selected.includes(projectId) || selected.length >= MAX_BATCH_PROJECTS) return [...selected];
    return [...selected, projectId];
  }
  return selected.filter((id) => id !== projectId);
}

export function filterActiveProjects<T extends {
  project_id: string;
  display_name: string;
  active: boolean;
}>(projects: readonly T[], search: string): T[] {
  const query = search.trim().toLocaleLowerCase();
  return projects.filter((project) => project.active && (
    !query || project.project_id.toLocaleLowerCase().includes(query) ||
      project.display_name.toLocaleLowerCase().includes(query)
  ));
}

export function paginateProjects<T>(projects: readonly T[], page: number): T[] {
  if (!Number.isSafeInteger(page) || page < 1) return [];
  const start = (page - 1) * PROJECT_PICKER_PAGE_SIZE;
  return projects.slice(start, start + PROJECT_PICKER_PAGE_SIZE);
}

function classifyMappingStatus(status: number): MappingUiOutcome | null {
  if (status === 401) return { kind: "denied", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 409) return { kind: "conflict", message: "Dữ liệu đã thay đổi ở nơi khác. Tải lại trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  if (status !== 200) return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng." };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function classifyGrantResponse(
  status: number,
  payload: unknown,
  teamId: string,
  projectIds: readonly string[],
  projectNames: ReadonlyMap<string, string>,
): MappingUiOutcome {
  const statusOutcome = classifyMappingStatus(status);
  if (statusOutcome) return statusOutcome;
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "batch"]) || payload.ok !== true) {
    return { kind: "unavailable", message: "Phản hồi cấp mapping không hợp lệ. Hãy tải lại danh sách." };
  }
  const batch = projectBatchGrantResult(payload.batch);
  if (!batch || batch.team_id !== teamId) {
    return { kind: "unavailable", message: "Phản hồi cấp mapping không hợp lệ. Hãy tải lại danh sách." };
  }
  const requested = new Set(projectIds);
  const created = batch.created.map((row) => row.project_id);
  const skipped = batch.skipped.map((row) => row.project_id);
  const returned = [...created, ...skipped];
  if (requested.size !== projectIds.length || returned.length !== requested.size ||
      new Set(returned).size !== returned.length ||
      returned.some((id) => !requested.has(id)) ||
      returned.some((id) => !projectNames.has(id))) {
    return { kind: "unavailable", message: "Phản hồi cấp mapping không khớp với lựa chọn. Hãy tải lại danh sách." };
  }
  const names = (ids: readonly string[]) => ids.map((id) => projectNames.get(id)!).join(", ");
  const createdMessage = created.length
    ? `Đã tạo ${created.length} mapping: ${names(created)}.`
    : "Không tạo mapping mới.";
  const skippedMessage = skipped.length
    ? ` Đã bỏ qua ${skipped.length} dự án đã có mapping hiệu lực: ${names(skipped)}.`
    : " Không có dự án nào bị bỏ qua.";
  return {
    kind: "applied",
    message: `${createdMessage}${skippedMessage} Hiệu lực từ ${batch.effective_from}.`,
  };
}

export function classifyRevokeResponse(
  status: number,
  payload: unknown,
  mappingId: string,
): MappingUiOutcome {
  const statusOutcome = classifyMappingStatus(status);
  if (statusOutcome) return statusOutcome;
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "scope"]) || payload.ok !== true) {
    return { kind: "unavailable", message: "Phản hồi thu hồi mapping không hợp lệ. Hãy tải lại danh sách." };
  }
  const scope = projectRevokeResult(payload.scope);
  if (!scope || scope.mapping_id !== mappingId) {
    return { kind: "unavailable", message: "Phản hồi thu hồi mapping không khớp. Hãy tải lại danh sách." };
  }
  return { kind: "applied", message: "Đã thu hồi mapping. Danh sách đang được cập nhật." };
}

export function newMappingKey(): string {
  return newIdempotencyKey();
}
