/**
 * P2.5-W06A - Model thuan cho Project Operations UI (khong phu thuoc React).
 *
 * Vai tro:
 * - Validate input client TRUOC khi goi API (optional reason, OCC version, id shape).
 * - Build request body DUNG cac key ma API boundary chap nhan.
 *   Client TUYET DOI khong gui actor/auth_subject/app_user_id/capability/scope/role.
 * - Phan loai response thanh outcome sanitized.
 *
 * Quyen KHONG duoc suy dien o day: server response/RPC la nguon duy nhat.
 */

import { projectOptionalActionReason } from "./action-reason.ts";

export const REASON_MAX = 4000;
export const PROJECT_LOCATION_ADDRESS_MAX = 500;
export const PROJECT_LOCATION_DEFAULT_RADIUS_METERS = 200;
export const PROJECT_LOCATION_MIN_RADIUS_METERS = 50;
export const PROJECT_LOCATION_MAX_RADIUS_METERS = 2000;
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCATION_ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && DATE_PATTERN.test(todayVn)
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}

export type ProjectLocationView = {
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  confirmed_at: string | null;
};

export type ProjectView = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
  can_manage_project_master: boolean;
  can_assign_managers: boolean;
  location?: ProjectLocationView | null;
};

export type AssignmentView = {
  assignment_id: string;
  project_id: string;
  project_version: number;
  manager_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  revoked_at: string | null;
  created_at: string;
};

export type ProjectDetailView = {
  project_id: string;
  display_name: string;
  /** master.version (project OCC). */
  version: number;
  /** assignments.project_version (project OCC) — dong nhat voi version. */
  project_version: number;
  project_active: boolean;
  active_assignment_count: number;
  assignments: AssignmentView[];
  can_manage_project_master: boolean;
  can_assign_managers: boolean;
  location?: ProjectLocationView | null;
};

export type RequestResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

export type Outcome =
  | { kind: "applied" }
  | { kind: "reload-required"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

const RELOAD_MESSAGE =
  "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi tiếp tục.";

/* ---------- parse response (server la nguon duy nhat) ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseProjectLocation(value: unknown): ProjectLocationView | null {
  const row = asRecord(value);
  if (!row) return null;
  const keys = Object.keys(row);
  const expectedKeys = ["address", "latitude", "longitude", "radius_meters", "confirmed_at"];
  if (keys.length !== expectedKeys.length || !expectedKeys.every((k) => k in row)) {
    return null;
  }
  let address: string | null = null;
  if (row.address !== null) {
    if (typeof row.address !== "string") return null;
    const trimmed = row.address.trim();
    if (
      trimmed === "" ||
      trimmed.length > PROJECT_LOCATION_ADDRESS_MAX ||
      LOCATION_ADDRESS_CONTROL_CHAR_PATTERN.test(trimmed)
    ) {
      return null;
    }
    address = trimmed;
  }
  if (
    typeof row.latitude !== "number" ||
    !Number.isFinite(row.latitude) ||
    row.latitude < -90 ||
    row.latitude > 90 ||
    typeof row.longitude !== "number" ||
    !Number.isFinite(row.longitude) ||
    row.longitude < -180 ||
    row.longitude > 180
  ) {
    return null;
  }
  const radius_meters = asCount(row.radius_meters);
  if (
    radius_meters === null ||
    radius_meters < PROJECT_LOCATION_MIN_RADIUS_METERS ||
    radius_meters > PROJECT_LOCATION_MAX_RADIUS_METERS
  ) {
    return null;
  }
  const confirmed_at = row.confirmed_at === null ? null : asText(row.confirmed_at);
  if (row.confirmed_at !== null && confirmed_at === null) {
    return null;
  }
  return {
    address,
    latitude: Object.is(row.latitude, -0) ? 0 : row.latitude,
    longitude: Object.is(row.longitude, -0) ? 0 : row.longitude,
    radius_meters,
    confirmed_at,
  };
}

export function parseProject(value: unknown): ProjectView | null {
  const row = asRecord(value);
  if (!row) return null;
  const project_id = asText(row.project_id);
  const display_name = asText(row.display_name);
  const active = asBool(row.active);
  const version = asCount(row.version);
  const can_manage_project_master = asBool(row.can_manage_project_master);
  const can_assign_managers = asBool(row.can_assign_managers);
  if (project_id === null || display_name === null || active === null || version === null ||
      can_manage_project_master === null || can_assign_managers === null) {
    return null;
  }
  const base: ProjectView = {
    project_id,
    display_name,
    active,
    version,
    can_manage_project_master,
    can_assign_managers,
  };
  if (!("location" in row)) return base;
  if (row.location === null) return { ...base, location: null };
  const location = parseProjectLocation(row.location);
  if (!location) return null;
  return { ...base, location };
}

export function parseAssignment(value: unknown): AssignmentView | null {
  const row = asRecord(value);
  if (!row) return null;
  const assignment_id = asText(row.assignment_id);
  const project_id = asText(row.project_id);
  const project_version = asCount(row.project_version);
  const manager_recruiter_id = asText(row.manager_recruiter_id);
  const valid_from = asText(row.valid_from);
  const effective = asBool(row.effective);
  const version = asCount(row.version);
  const created_at = asText(row.created_at);
  if (assignment_id === null || project_id === null || project_version === null ||
      manager_recruiter_id === null || valid_from === null || effective === null ||
      version === null || created_at === null) {
    return null;
  }
  return {
    assignment_id, project_id, project_version, manager_recruiter_id, valid_from,
    valid_to: asText(row.valid_to), effective, version,
    revoked_at: asText(row.revoked_at), created_at,
  };
}

/** Doc danh sach tu response list; tra null khi shape khong dung (fail-closed). */
export function parseListResponse(payload: unknown): ProjectView[] | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true) return null;
  const list = asRecord(root.list);
  if (!list || !Array.isArray(list.projects)) return null;
  const projects: ProjectView[] = [];
  for (const item of list.projects) {
    const project = parseProject(item);
    if (project === null) return null;
    projects.push(project);
  }
  return projects;
}

/** Doc detail tu response { master, assignments }; tra null khi shape khong dung. */
export function parseDetailResponse(payload: unknown): ProjectDetailView | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true) return null;
  const detail = asRecord(root.detail);
  if (!detail) return null;
  const master = asRecord(detail.master);
  const block = asRecord(detail.assignments);
  if (!master || !block || !Array.isArray(block.assignments)) return null;
  const project_id = asText(master.project_id);
  const display_name = asText(master.display_name);
  const masterVersion = asCount(master.version);
  const can_manage_project_master = asBool(master.can_manage_project_master);
  const can_assign_managers = asBool(master.can_assign_managers);
  const project_version = asCount(block.project_version);
  const project_active = asBool(block.project_active);
  const active_assignment_count = asCount(block.active_assignment_count);
  if (project_id === null || display_name === null || masterVersion === null ||
      can_manage_project_master === null || can_assign_managers === null ||
      project_version === null || project_active === null || active_assignment_count === null) {
    return null;
  }
  const assignments: AssignmentView[] = [];
  for (const item of block.assignments) {
    const assignment = parseAssignment(item);
    if (assignment === null) return null;
    assignments.push(assignment);
  }
  const base: ProjectDetailView = {
    project_id, display_name, version: masterVersion, project_version,
    project_active, active_assignment_count, assignments,
    can_manage_project_master, can_assign_managers,
  };
  if (!("location" in master)) return base;
  if (master.location === null) return { ...base, location: null };
  const location = parseProjectLocation(master.location);
  if (!location) return null;
  return { ...base, location };
}

/** Doc project_version tu assign/unassign response (NOT version = assignment version). */
export function mutationProjectVersion(payload: unknown): number | null {
  const root = asRecord(payload);
  const project = root ? asRecord(root.project) : null;
  if (!project) return null;
  return asCount(project.project_version);
}

/* ---------- validate input ---------- */

export function validateProjectId(value: string): string | null {
  return PROJECT_ID_PATTERN.test(value.trim())
    ? null
    : "Mã dự án chỉ gồm chữ, số và các ký tự . _ : - (tối đa 128 ký tự).";
}
export function validateDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Tên dự án là bắt buộc.";
  if (trimmed.length > 200) return "Tên dự án tối đa 200 ký tự.";
  return null;
}
/** Optional action reason; the API boundary repeats type and length validation. */
export function validateReason(value: unknown): string | null {
  return projectOptionalActionReason(value, REASON_MAX).ok
    ? null
    : "Lý do tối đa " + String(REASON_MAX) + " ký tự.";
}
export function normalizeOptionalActionReason(value: string | null | undefined): string | null {
  const projected = projectOptionalActionReason(value, REASON_MAX);
  return projected.ok ? projected.value : null;
}
export function validateUuid(value: string): string | null {
  return UUID_PATTERN.test(value.trim()) ? null : "Giá trị không phải định danh hợp lệ.";
}
export function validateDate(value: string): string | null {
  if (!DATE_PATTERN.test(value.trim())) return "Ngày phải theo định dạng YYYY-MM-DD.";
  const parsed = new Date(value.trim() + "T00:00:00Z");
  return Number.isNaN(parsed.getTime()) ? "Ngày không hợp lệ." : null;
}
export function validateVersion(value: number): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? null
    : "Dữ liệu chưa hợp lệ. Vui lòng tải lại.";
}

/* ---------- build request ---------- */

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function buildCreateRequest(input: {
  projectId: string; displayName: string; reason?: string | null; idempotencyKey: string;
}): RequestResult {
  const failure = validateProjectId(input.projectId) ?? validateDisplayName(input.displayName)
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    project_id: input.projectId.trim(), display_name: input.displayName.trim(),
    reason: normalizeOptionalActionReason(input.reason), idempotency_key: input.idempotencyKey,
  } };
}

export function buildRenameRequest(input: {
  displayName: string; reason?: string | null; expectedVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateDisplayName(input.displayName) ?? validateReason(input.reason)
    ?? validateVersion(input.expectedVersion) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    display_name: input.displayName.trim(), reason: normalizeOptionalActionReason(input.reason),
    expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey,
  } };
}

/** Bat/tat du an: CHI doi co active. Tat du an = active false (khong co RPC rieng). */
export function buildSetActiveRequest(input: {
  active: boolean; reason?: string | null; expectedVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateReason(input.reason) ?? validateVersion(input.expectedVersion)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    active: input.active, reason: normalizeOptionalActionReason(input.reason),
    expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey,
  } };
}

export type PendingAssignment = { managerRecruiterId: string; validFrom?: string | null };

function validateImmediateAssignDate(
  rawDate: string | null | undefined,
  todayVn?: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const businessToday = resolveBusinessTodayVn(todayVn);
  const normalized = typeof rawDate === "string" && rawDate.trim() !== ""
    ? rawDate.trim()
    : businessToday;
  const dateErr = validateDate(normalized);
  if (dateErr) return { ok: false, message: dateErr };
  if (normalized > businessToday) {
    return { ok: false, message: "Ngày hiệu lực không được ở tương lai." };
  }
  return { ok: true, value: normalized };
}

export function validatePendingAssignments(
  rows: readonly PendingAssignment[],
  todayVn?: string,
): string | null {
  if (rows.length === 0) return "Cần ít nhất một quản lý dự án.";
  const seen = new Set<string>();
  for (const row of rows) {
    const dateCheck = validateImmediateAssignDate(row.validFrom, todayVn);
    const failure = validateUuid(row.managerRecruiterId) ?? (dateCheck.ok ? null : dateCheck.message);
    if (failure) return failure;
    const key = row.managerRecruiterId.trim().toLowerCase();
    if (seen.has(key)) return "Một quản lý không được gán hai lần trong cùng một lần gửi.";
    seen.add(key);
  }
  return null;
}

export function buildAssignRequest(input: {
  managerRecruiterId: string; validFrom?: string | null; todayVn?: string; reason?: string | null;
  expectedProjectVersion: number; idempotencyKey: string;
}): RequestResult {
  const dateCheck = validateImmediateAssignDate(input.validFrom, input.todayVn);
  const failure = validateUuid(input.managerRecruiterId)
    ?? (dateCheck.ok ? null : dateCheck.message)
    ?? validateReason(input.reason) ?? validateVersion(input.expectedProjectVersion)
    ?? validateUuid(input.idempotencyKey);
  if (failure || !dateCheck.ok) return { ok: false, message: failure ?? "Ngày không hợp lệ." };
  return { ok: true, body: {
    manager_recruiter_id: input.managerRecruiterId.trim(),
    valid_from: dateCheck.value, reason: normalizeOptionalActionReason(input.reason),
    expected_project_version: input.expectedProjectVersion,
    idempotency_key: input.idempotencyKey,
  } };
}

export function buildUnassignRequest(input: {
  reason?: string | null; expectedVersion: number; expectedProjectVersion: number; idempotencyKey: string;
}): RequestResult {
  const failure = validateReason(input.reason) ?? validateVersion(input.expectedVersion)
    ?? validateVersion(input.expectedProjectVersion) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return { ok: true, body: {
    reason: normalizeOptionalActionReason(input.reason), expected_version: input.expectedVersion,
    expected_project_version: input.expectedProjectVersion,
    idempotency_key: input.idempotencyKey,
  } };
}

export function buildUpdateProjectLocationRequest(input: {
  address?: string | null;
  latitudeInput?: string | number | null;
  longitudeInput?: string | number | null;
  radiusInput?: string | number | null;
  clear?: boolean;
  reason?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
}): RequestResult {
  const metaFailure =
    validateReason(input.reason) ??
    validateVersion(input.expectedVersion) ??
    validateUuid(input.idempotencyKey);
  if (metaFailure) return { ok: false, message: metaFailure };

  const normalizedReason = normalizeOptionalActionReason(input.reason);
  if (input.clear === true) {
    return {
      ok: true,
      body: {
        expected_version: input.expectedVersion,
        address: null,
        latitude: null,
        longitude: null,
        radius_meters: PROJECT_LOCATION_DEFAULT_RADIUS_METERS,
        clear: true,
        reason: normalizedReason,
        idempotency_key: input.idempotencyKey,
      },
    };
  }

  const rawLat =
    input.latitudeInput === undefined || input.latitudeInput === null
      ? ""
      : String(input.latitudeInput).trim();
  const rawLon =
    input.longitudeInput === undefined || input.longitudeInput === null
      ? ""
      : String(input.longitudeInput).trim();
  const rawAddress = typeof input.address === "string" ? input.address.trim() : "";

  if ((rawLat === "") !== (rawLon === "")) {
    return { ok: false, message: "Vĩ độ và kinh độ phải cùng có hoặc cùng để trống." };
  }

  if (rawLat === "" && rawLon === "") {
    if (rawAddress !== "") {
      return { ok: false, message: "Vĩ độ và kinh độ phải cùng có hoặc cùng để trống." };
    }
    return {
      ok: true,
      body: {
        expected_version: input.expectedVersion,
        address: null,
        latitude: null,
        longitude: null,
        radius_meters: PROJECT_LOCATION_DEFAULT_RADIUS_METERS,
        clear: true,
        reason: normalizedReason,
        idempotency_key: input.idempotencyKey,
      },
    };
  }

  if (
    rawAddress.length > PROJECT_LOCATION_ADDRESS_MAX ||
    LOCATION_ADDRESS_CONTROL_CHAR_PATTERN.test(rawAddress)
  ) {
    return { ok: false, message: "Địa chỉ dự án tối đa 500 ký tự và không chứa ký tự điều khiển." };
  }

  const latitude = Number(rawLat);
  const longitude = Number(rawLon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, message: "Vĩ độ phải nằm trong khoảng từ -90 đến 90." };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, message: "Kinh độ phải nằm trong khoảng từ -180 đến 180." };
  }

  const rawRadius =
    input.radiusInput === undefined ||
    input.radiusInput === null ||
    String(input.radiusInput).trim() === ""
      ? String(PROJECT_LOCATION_DEFAULT_RADIUS_METERS)
      : String(input.radiusInput).trim();
  if (!/^\d+$/.test(rawRadius)) {
    return { ok: false, message: "Bán kính chấm công phải là số nguyên từ 50 đến 2000 mét." };
  }
  const radiusMeters = Number(rawRadius);
  if (
    !Number.isSafeInteger(radiusMeters) ||
    radiusMeters < PROJECT_LOCATION_MIN_RADIUS_METERS ||
    radiusMeters > PROJECT_LOCATION_MAX_RADIUS_METERS
  ) {
    return { ok: false, message: "Bán kính chấm công phải là số nguyên từ 50 đến 2000 mét." };
  }

  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      address: rawAddress === "" ? null : rawAddress,
      latitude: Number((Object.is(latitude, -0) ? 0 : latitude).toFixed(7)),
      longitude: Number((Object.is(longitude, -0) ? 0 : longitude).toFixed(7)),
      radius_meters: radiusMeters,
      clear: false,
      reason: normalizedReason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

/* ---------- outcome ---------- */

export function classifyResponse(status: number, payload: unknown): Outcome {
  if (status === 200) return { kind: "applied" };
  const root = asRecord(payload);
  const code = root ? asText(root.code) : null;
  if (status === 401) {
    return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  }
  if (status === 403) {
    return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  }
  if (status === 404) {
    return { kind: "not-found", message: "Dự án hoặc phân công không còn tồn tại." };
  }
  if (status === 409 || code === "PROJECT_CONFLICT") {
    return { kind: "reload-required", message: RELOAD_MESSAGE };
  }
  if (status === 400) {
    return { kind: "invalid", message: "Dữ liệu gửi lên không hợp lệ." };
  }
  return { kind: "unavailable", message: "Hệ thống tạm thời không khả dụng. Vui lòng thử lại." };
}

export async function executeProjectRequest(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  request: RequestResult,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<{ outcome: Outcome; payload: unknown }> {
  if (!request.ok) {
    return { outcome: { kind: "invalid", message: request.message }, payload: null };
  }
  try {
    const response = await fetcher(url, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(request.body),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { outcome: classifyResponse(response.status, payload), payload };
  } catch {
    return {
      outcome: {
        kind: "unavailable",
        message: "Không kết nối được tới hệ thống. Vui lòng thử lại.",
      },
      payload: null,
    };
  }
}

/* ---------- view ---------- */

/**
 * W06A-R2: 3-way assignment view.
 * - current: effective at authorization date (valid_to null, valid_from <= auth).
 * - future:  OPEN with a future valid_from (valid_to null, effective false).
 * - history: closed/revoked (valid_to is not null).
 * Labels derive from the authoritative effective flag + valid_from/valid_to.
 */
export function splitAssignments(assignments: readonly AssignmentView[]): {
  current: AssignmentView[];
  future: AssignmentView[];
  history: AssignmentView[];
} {
  const current: AssignmentView[] = [];
  const future: AssignmentView[] = [];
  const history: AssignmentView[] = [];
  for (const assignment of assignments) {
    if (assignment.valid_to !== null) history.push(assignment);
    else if (assignment.effective) current.push(assignment);
    else future.push(assignment);
  }
  const byStart = (a: AssignmentView, b: AssignmentView) => (a.valid_from < b.valid_from ? 1 : -1);
  current.sort(byStart);
  future.sort(byStart);
  history.sort(byStart);
  return { current, future, history };
}

export type ManagerCandidate = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string | null;
  personnel_position: string | null;
};

/** Doc candidate list tu response; tra null khi shape khong dung (fail-closed). */
export function parseCandidatesResponse(payload: unknown): ManagerCandidate[] | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true || !Array.isArray(root.candidates)) return null;
  const candidates: ManagerCandidate[] = [];
  for (const item of root.candidates) {
    const row = asRecord(item);
    if (!row) return null;
    const recruiter_id = asText(row.recruiter_id);
    const display_name = asText(row.display_name);
    if (recruiter_id === null || display_name === null) return null;
    candidates.push({
      recruiter_id,
      display_name,
      personnel_code: asText(row.personnel_code),
      personnel_position: asText(row.personnel_position),
    });
  }
  return candidates;
}

export function candidateLabel(candidate: ManagerCandidate): string {
  return candidate.personnel_code
    ? candidate.display_name + " · " + candidate.personnel_code
    : candidate.display_name;
}

export function projectStatusLabel(active: boolean): string {
  return active ? "Đang hoạt động" : "Đã ngừng";
}

export type ProjectStatusFilter = "all" | "active" | "inactive";

/**
 * Bộ lọc chỉ phục vụ trình bày. Danh sách và quyền vẫn do RPC quản trị dự án
 * quyết định; client không dùng bộ lọc này để suy diễn quyền.
 */
export function filterProjects(
  projects: readonly ProjectView[],
  query: string,
  status: ProjectStatusFilter,
): ProjectView[] {
  const needle = query.trim().toLocaleLowerCase("vi");
  return projects.filter((project) => {
    if (status === "active" && !project.active) return false;
    if (status === "inactive" && project.active) return false;
    if (needle === "") return true;
    return project.project_id.toLocaleLowerCase("vi").includes(needle) ||
      project.display_name.toLocaleLowerCase("vi").includes(needle);
  });
}

export function paginateProjects<T>(
  projects: readonly T[],
  requestedPage: number,
  pageSize = 12,
): { items: T[]; page: number; pageCount: number; from: number; to: number; total: number } {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 12;
  const pageCount = Math.max(1, Math.ceil(projects.length / safePageSize));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.min(Math.max(1, requestedPage), pageCount)
    : 1;
  const start = (page - 1) * safePageSize;
  const items = projects.slice(start, start + safePageSize);
  return {
    items,
    page,
    pageCount,
    from: projects.length === 0 ? 0 : start + 1,
    to: Math.min(start + items.length, projects.length),
    total: projects.length,
  };
}
