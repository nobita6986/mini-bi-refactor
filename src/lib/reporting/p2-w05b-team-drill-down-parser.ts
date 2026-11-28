import { INVALID_FILTER_CODE, parseReportingFilters } from "./p1-filter.ts";
import type { ReportingFilters } from "./p1-filter.ts";

export type RequestParams = Record<string, string | string[] | undefined>;

const ALLOWED_KEYS = new Set([
  "bucket_key", "from", "to", "project", "recruiter", "provider", "collaborator", "employment", "status", "cursor", "limit",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_BUCKET_KEY = "unknown";
const TEAM_BUCKET_RE = /^team\.([A-Za-z0-9_-]+)$/;

type ParserResult =
  | { ok: true; value: TeamDrillDownFilters }
  | { ok: false; code: typeof INVALID_FILTER_CODE };

export type TeamDrillDownFilters = {
  bucket_key: string;
  cursor: string | null;
  limit: number;
  filters: ReportingFilters;
};

function parserInvalid(): { ok: false; code: typeof INVALID_FILTER_CODE } {
  return { ok: false, code: INVALID_FILTER_CODE };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isCanonicalTeamCode(value: string): boolean {
  return Array.from(value).length >= 1 && Array.from(value).length <= 128
    && value === value.trim()
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validBucketKey(value: string): boolean {
  if (value === UNKNOWN_BUCKET_KEY) return true;
  if (value === "__unknown__") return false;
  const match = TEAM_BUCKET_RE.exec(value);
  if (!match || value.length < 7 || value.length > 688) return false;
  const decoded = decodeBase64Url(match[1]);
  if (!decoded) return false;
  const code = decoded.toString("utf8");
  return Buffer.from(code, "utf8").equals(decoded) && isCanonicalTeamCode(code);
}

function validCursor(value: string): boolean {
  const decoded = decodeBase64Url(value);
  if (!decoded) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "business_date,entry_id,recruiter_display") return false;
  return typeof record.business_date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(record.business_date)
    && typeof record.entry_id === "string"
    && UUID_RE.test(record.entry_id)
    && typeof record.recruiter_display === "string"
    && record.recruiter_display.length > 0;
}

/**
 * P3-W06D-R2: decode a canonical team bucket key into its team code (or the
 * `unknown` sentinel). Returns null when the key fails the canonical wire
 * checks. Used by the server-side team-report read to resolve the requested
 * bucket inside the actor's authorized fact set; the code never reaches the
 * client.
 */
export function decodeTeamBucketKey(
  value: string,
): { kind: "unknown" } | { kind: "team"; code: string } | null {
  if (value === UNKNOWN_BUCKET_KEY) return { kind: "unknown" };
  if (!validBucketKey(value)) return null;
  const match = TEAM_BUCKET_RE.exec(value);
  if (!match) return null;
  const decoded = decodeBase64Url(match[1]);
  if (!decoded) return null;
  return { kind: "team", code: decoded.toString("utf8") };
}

export function parseTeamDrillDownRequest(params: RequestParams): ParserResult {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_KEYS.has(key)) return parserInvalid();
  }
  const bucketKey = firstValue(params.bucket_key);
  if (!bucketKey || !validBucketKey(bucketKey)) return parserInvalid();

  const cursorValue = firstValue(params.cursor);
  if (params.cursor !== undefined && (!cursorValue || !validCursor(cursorValue))) return parserInvalid();

  const rawLimit = params.limit;
  let limit = 25;
  if (rawLimit !== undefined) {
    if (Array.isArray(rawLimit) || rawLimit === "" || !/^\d+$/.test(rawLimit)) return parserInvalid();
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return parserInvalid();
  }

  const filterParams: RequestParams = {};
  for (const key of ["from", "to", "project", "recruiter", "provider", "collaborator", "employment", "status"] as const) {
    if (params[key] !== undefined) filterParams[key] = params[key];
  }
  const parsed = parseReportingFilters(filterParams, undefined);
  if (!parsed.ok) return parserInvalid();

  return {
    ok: true,
    value: {
      bucket_key: bucketKey,
      cursor: cursorValue ?? null,
      limit,
      filters: parsed.filters,
    },
  };
}
