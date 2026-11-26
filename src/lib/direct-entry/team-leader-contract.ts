import { parseIsoDate } from "./direct-entry-date-format.ts";

export type TeamLeaderState = "CURRENT" | "SUSPENDED" | "SCHEDULED" | "HISTORY";
export type TeamLeaderChange = "designate" | "replace" | "revoke";

export type TeamLeaderItem = {
  assignment_id: string;
  team_id: string;
  team_display_name: string;
  leader_app_user_id: string;
  leader_recruiter_id: string;
  leader_display_name: string;
  valid_from: string;
  valid_to: string | null;
  state: TeamLeaderState;
};

export type TeamLeaderList = {
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  leaders: readonly TeamLeaderItem[];
};

export type TeamLeaderMutation = {
  team_id: string;
  assignment_id: string;
  leader_app_user_id: string;
  leader_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  revision_id: string;
  change: TeamLeaderChange;
};

export type TeamLeaderCandidate = {
  app_user_id: string;
  display_name: string;
  personnel_code: string | null;
};

export type TeamLeaderCandidateList = {
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  candidates: readonly TeamLeaderCandidate[];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function uuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function day(value: unknown): string | null {
  return typeof value === "string" && parseIsoDate(value) !== null ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const ITEM_KEYS = [
  "assignment_id", "team_id", "team_display_name", "leader_app_user_id",
  "leader_recruiter_id", "leader_display_name", "valid_from", "valid_to", "state",
] as const;
const LIST_KEYS = ["authorization_date", "page", "page_size", "total", "leaders"] as const;
const MUTATION_KEYS = [
  "team_id", "assignment_id", "leader_app_user_id", "leader_recruiter_id",
  "valid_from", "valid_to", "version", "revision_id", "change",
] as const;
const CANDIDATE_KEYS = ["app_user_id", "display_name", "personnel_code"] as const;
const CANDIDATE_LIST_KEYS = [
  "authorization_date", "page", "page_size", "total", "candidates",
] as const;

export function teamLeaderItem(value: unknown): TeamLeaderItem | null {
  if (!record(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const assignment_id = uuid(value.assignment_id);
  const team_id = uuid(value.team_id);
  const team_display_name = text(value.team_display_name);
  const leader_app_user_id = uuid(value.leader_app_user_id);
  const leader_recruiter_id = uuid(value.leader_recruiter_id);
  const leader_display_name = text(value.leader_display_name);
  const valid_from = day(value.valid_from);
  const valid_to = value.valid_to === null ? null : day(value.valid_to);
  const state = value.state === "CURRENT" || value.state === "SUSPENDED" ||
      value.state === "SCHEDULED" || value.state === "HISTORY" ? value.state : null;
  if (!assignment_id || !team_id || !team_display_name || !leader_app_user_id ||
      !leader_recruiter_id || !leader_display_name || !valid_from ||
      (valid_to === null && value.valid_to !== null) || !state) return null;
  return {
    assignment_id, team_id, team_display_name, leader_app_user_id, leader_recruiter_id,
    leader_display_name, valid_from, valid_to, state,
  };
}

function listEnvelope<T>(
  value: unknown,
  keys: readonly string[],
  rowsKey: "leaders" | "candidates",
  project: (row: unknown) => T | null,
): { authorization_date: string; page: number; page_size: number; total: number; rows: T[] } | null {
  if (!record(value) || !exactKeys(value, keys) || !Array.isArray(value[rowsKey])) return null;
  const authorization_date = day(value.authorization_date);
  const page = count(value.page);
  const page_size = count(value.page_size);
  const total = count(value.total);
  if (!authorization_date || page === null || page < 1 || page > 1000 ||
      page_size === null || page_size < 1 || page_size > 100 || total === null) return null;
  const rows: T[] = [];
  for (const item of value[rowsKey]) {
    const projected = project(item);
    if (projected === null) return null;
    rows.push(projected);
  }
  if (rows.length > page_size) return null;
  return { authorization_date, page, page_size, total, rows };
}

export function teamLeaderList(value: unknown): TeamLeaderList | null {
  const result = listEnvelope(value, LIST_KEYS, "leaders", teamLeaderItem);
  return result ? {
    authorization_date: result.authorization_date, page: result.page, page_size: result.page_size,
    total: result.total, leaders: result.rows,
  } : null;
}

export function teamLeaderMutation(value: unknown): TeamLeaderMutation | null {
  if (!record(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  const team_id = uuid(value.team_id);
  const assignment_id = uuid(value.assignment_id);
  const leader_app_user_id = uuid(value.leader_app_user_id);
  const leader_recruiter_id = uuid(value.leader_recruiter_id);
  const valid_from = day(value.valid_from);
  const valid_to = value.valid_to === null ? null : day(value.valid_to);
  const version = count(value.version);
  const revision_id = uuid(value.revision_id);
  const change = value.change === "designate" || value.change === "replace" ||
      value.change === "revoke" ? value.change : null;
  if (!team_id || !assignment_id || !leader_app_user_id || !leader_recruiter_id ||
      !valid_from || (valid_to === null && value.valid_to !== null) || version === null ||
      !revision_id || !change ||
      (change === "revoke" ? valid_to === null : valid_to !== null)) return null;
  return {
    team_id, assignment_id, leader_app_user_id, leader_recruiter_id,
    valid_from, valid_to, version, revision_id, change,
  };
}

export function teamLeaderCandidate(value: unknown): TeamLeaderCandidate | null {
  if (!record(value) || !exactKeys(value, CANDIDATE_KEYS)) return null;
  const app_user_id = uuid(value.app_user_id);
  const display_name = text(value.display_name);
  const personnel_code = value.personnel_code === null ? null : text(value.personnel_code);
  if (!app_user_id || !display_name || (personnel_code === null && value.personnel_code !== null)) {
    return null;
  }
  return { app_user_id, display_name, personnel_code };
}

export function teamLeaderCandidateList(value: unknown): TeamLeaderCandidateList | null {
  const result = listEnvelope(value, CANDIDATE_LIST_KEYS, "candidates", teamLeaderCandidate);
  return result ? {
    authorization_date: result.authorization_date, page: result.page, page_size: result.page_size,
    total: result.total, candidates: result.rows,
  } : null;
}
