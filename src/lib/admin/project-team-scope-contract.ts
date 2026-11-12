import { hasExactKeysWithOptionalReason, projectOptionalActionReason } from "../direct-entry/action-reason.ts";

/**
 * PRE-W2-HF Project↔Team authority (T1A) - Strict contract for the mapping
 * admin API. Mirrors the migration #94 read and #97 mutation envelopes exactly.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && DATE.test(todayVn)
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}

export type ProjectTeamScopeMapping = {
  mapping_id: string;
  project_id: string;
  project_display_name: string;
  team_id: string;
  team_display_name: string;
  team_code: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  state: "CURRENT" | "SCHEDULED" | "HISTORY";
  version: number;
  revoked_at: string | null;
  created_at: string;
};

export type ProjectTeamScopeList = {
  authorization_date: string;
  include_history: boolean;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  mappings: readonly ProjectTeamScopeMapping[];
};

export type ProjectTeamScopeGrantResult = {
  mapping_id: string;
  project_id: string;
  team_id: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created: boolean;
};

export type ProjectTeamScopeBatchGrantResult = {
  team_id: string;
  effective_from: string;
  created: readonly ProjectTeamScopeGrantResult[];
  skipped: readonly {
    project_id: string;
    status: "ALREADY_EFFECTIVE";
    mapping_id: string;
    version: number;
  }[];
};

export type ProjectTeamScopeRevokeResult = {
  mapping_id: string;
  project_id: string;
  team_id: string;
  valid_to: string | null;
  version: number;
  revoked: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).sort().join(",") === [...keys].sort().join(",");
}
function uuid(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v : null;
}
function projectId(v: unknown): string | null {
  return typeof v === "string" && PROJECT_ID.test(v) ? v : null;
}
function int(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : null;
}
function day(v: unknown): string | null {
  if (typeof v !== "string" || !DATE.test(v)) return null;
  const [year, month, date] = v.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && date >= 1 && date <= daysInMonth[month - 1] ? v : null;
}
function nullableDay(v: unknown): string | null | undefined {
  return v === null ? null : (day(v) ?? undefined);
}
function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;
}

function state(v: unknown): ProjectTeamScopeMapping["state"] | null {
  if (v === "CURRENT" || v === "SCHEDULED" || v === "HISTORY") return v;
  return null;
}

function projectMapping(value: unknown): ProjectTeamScopeMapping | null {
  if (!isRecord(value) ||
      !exact(value, ["mapping_id", "project_id", "project_display_name", "team_id",
        "team_display_name", "team_code", "valid_from", "valid_to", "effective",
        "state", "version", "revoked_at", "created_at"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const project_display_name = text(value.project_display_name, 256);
  const team_id = uuid(value.team_id);
  const team_display_name = text(value.team_display_name, 256);
  const team_code = typeof value.team_code === "string" ? value.team_code : null;
  const valid_from = day(value.valid_from);
  const valid_to = nullableDay(value.valid_to);
  const effective = typeof value.effective === "boolean" ? value.effective : null;
  const mappedState = state(value.state);
  const version = int(value.version, 1);
  const revoked_at = nullableDay(value.revoked_at) === undefined ? undefined : (typeof value.revoked_at === "string" ? value.revoked_at : null);
  const created_at = typeof value.created_at === "string" ? value.created_at : null;
  if (mapping_id === null || project_id === null || !project_display_name ||
      team_id === null || !team_display_name || team_code === null ||
      !valid_from || valid_to === undefined || effective === null ||
      mappedState === null || version === null || revoked_at === undefined || created_at === null) return null;
  return {
    mapping_id, project_id, project_display_name, team_id, team_display_name, team_code,
    valid_from, valid_to, effective, state: mappedState, version, revoked_at, created_at,
  };
}

export function projectProjectTeamScopeList(value: unknown): ProjectTeamScopeList | null {
  if (!isRecord(value) ||
      !exact(value, ["authorization_date", "include_history", "page", "page_size",
        "total", "has_more", "mappings"])) return null;
  if (!isRecord(value) || typeof value.authorization_date !== "string" ||
      typeof value.include_history !== "boolean" ||
      typeof value.page !== "number" || typeof value.page_size !== "number" ||
      typeof value.total !== "number" || typeof value.has_more !== "boolean" ||
      !Array.isArray(value.mappings)) return null;
  const mappings: ProjectTeamScopeMapping[] = [];
  for (const raw of value.mappings) {
    const row = projectMapping(raw);
    if (!row) return null;
    mappings.push(row);
  }
  return {
    authorization_date: value.authorization_date,
    include_history: value.include_history,
    page: value.page as number,
    page_size: value.page_size as number,
    total: value.total as number,
    has_more: value.has_more,
    mappings,
  };
}

export function projectGrantResult(value: unknown): ProjectTeamScopeGrantResult | null {
  if (!isRecord(value) || !exact(value, ["mapping_id", "project_id", "team_id",
    "valid_from", "valid_to", "version", "created"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const team_id = uuid(value.team_id);
  const valid_from = day(value.valid_from);
  const valid_to = nullableDay(value.valid_to);
  const version = int(value.version, 1);
  if (mapping_id === null || project_id === null || team_id === null ||
      !valid_from || valid_to === undefined || version === null ||
      value.created !== true) return null;
  return { mapping_id, project_id, team_id, valid_from, valid_to, version, created: true };
}

export function projectBatchGrantResult(value: unknown): ProjectTeamScopeBatchGrantResult | null {
  if (!isRecord(value) ||
      !exact(value, ["team_id", "effective_from", "created", "skipped"]) ||
      !Array.isArray(value.created) || !Array.isArray(value.skipped)) return null;
  const team_id = uuid(value.team_id);
  const effective_from = day(value.effective_from);
  if (!team_id || !effective_from) return null;
  const created: ProjectTeamScopeGrantResult[] = [];
  for (const raw of value.created) {
    const row = projectGrantResult(raw);
    if (!row || row.team_id !== team_id) return null;
    created.push(row);
  }
  const skipped: ProjectTeamScopeBatchGrantResult["skipped"][number][] = [];
  for (const raw of value.skipped) {
    if (!isRecord(raw) ||
        !exact(raw, ["project_id", "status", "mapping_id", "version"])) return null;
    const project_id = projectId(raw.project_id);
    const mapping_id = uuid(raw.mapping_id);
    const version = int(raw.version, 1);
    if (!project_id || raw.status !== "ALREADY_EFFECTIVE" || !mapping_id || version === null) {
      return null;
    }
    skipped.push({ project_id, status: "ALREADY_EFFECTIVE", mapping_id, version });
  }
  return { team_id, effective_from, created, skipped };
}

export function projectRevokeResult(value: unknown): ProjectTeamScopeRevokeResult | null {
  if (!isRecord(value) || !exact(value, ["mapping_id", "project_id", "team_id",
    "valid_to", "version", "revoked"])) return null;
  const mapping_id = uuid(value.mapping_id);
  const project_id = projectId(value.project_id);
  const team_id = uuid(value.team_id);
  const valid_to = nullableDay(value.valid_to);
  const version = int(value.version, 1);
  if (mapping_id === null || project_id === null || team_id === null ||
      valid_to === undefined || version === null || value.revoked !== true) return null;
  return { mapping_id, project_id, team_id, valid_to, version, revoked: true };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string };

function reject(): Parsed<never> {
  return { ok: false, code: "PROJECT_TEAM_SCOPE_INVALID" };
}

export type GrantRequest = {
  team_id: string;
  project_ids: readonly string[];
  reason: string | null;
  idempotency_key: string;
};
const MAX_PROJECTS_PER_BATCH = 100;

export function parseGrant(body: unknown): Parsed<GrantRequest> {
  if (!isRecord(body) || !hasExactKeysWithOptionalReason(body,
    ["team_id", "project_ids", "reason", "idempotency_key"]) ||
      !Array.isArray(body.project_ids) || body.project_ids.length < 1 ||
      body.project_ids.length > MAX_PROJECTS_PER_BATCH) return reject();
  const team_id = uuid(body.team_id);
  const project_ids: string[] = [];
  for (const raw of body.project_ids) {
    const id = projectId(raw);
    if (!id) return reject();
    project_ids.push(id);
  }
  const reason = projectOptionalActionReason(body.reason, 4000);
  const idempotency_key = uuid(body.idempotency_key);
  if (!team_id || new Set(project_ids).size !== project_ids.length || !reason.ok || !idempotency_key) {
    return reject();
  }
  return {
    ok: true, value: { team_id, project_ids, reason: reason.value, idempotency_key },
  };
}

export type RevokeRequest = {
  mapping_id: string;
  effective_to: string | null;
  reason: string | null;
  idempotency_key: string;
};
export function parseRevoke(body: unknown, todayVn?: string): Parsed<RevokeRequest> {
  if (!isRecord(body)) return reject();
  const normalized = "effective_to" in body ? body : { ...body, effective_to: null };
  if (!hasExactKeysWithOptionalReason(normalized, [
    "mapping_id", "effective_to", "reason", "idempotency_key",
  ])) return reject();
  const businessToday = resolveBusinessTodayVn(todayVn);
  const mapping_id = uuid(body.mapping_id);
  const effective_to_raw = body.effective_to;
  const effective_to = effective_to_raw === undefined || effective_to_raw === null
    ? null
    : day(effective_to_raw);
  const reason = projectOptionalActionReason(body.reason, 4000);
  const idempotency_key = uuid(body.idempotency_key);
  if (!mapping_id ||
      (effective_to_raw !== undefined && effective_to_raw !== null && effective_to === null) ||
      (effective_to !== null && effective_to !== businessToday) ||
      !reason.ok || !idempotency_key) {
    return reject();
  }
  return { ok: true, value: { mapping_id, effective_to, reason: reason.value, idempotency_key } };
}
