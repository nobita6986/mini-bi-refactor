import "server-only";

import {
  hasPairedAllReportingAccess,
  type DirectEntryActor,
} from "../auth/direct-entry-v2.ts";
import { createServiceSupabaseClient } from "../supabase/server.ts";

import {
  ALL_RECRUITERS_TEAM_FILTER,
  buildDetailedRecruitmentMatrix,
  parseMatrixResolutionParam,
  type DetailedMatrixCatalog,
  type DetailedMatrixCatalogRecruiter,
  type DetailedRecruitmentMatrixReport,
} from "./detailed-recruitment-matrix.ts";
import {
  applyDashboardDefaultDateParams,
  getThisMonthDateRange,
} from "./p1-date-presets.ts";
import {
  INVALID_FILTER_CODE,
  isRealCalendarDate,
  parseReportingFilters,
  type ReportingFilters,
} from "./p1-filter.ts";
import {
  REPORTING_QUERY_FAILED_CODE,
  type ReportingFact,
} from "./p1-reporting.ts";
import { P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";
import { resolveReportingAudienceProjection } from "./p3-w05a-audience.ts";

export const FORBIDDEN_DETAILED_MATRIX_REPORT_CODE =
  "FORBIDDEN_DETAILED_MATRIX_REPORT";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DetailedMatrixEnvelope = {
  ok: true;
  matrix: DetailedRecruitmentMatrixReport;
};

export type DetailedMatrixFetchResult =
  | { ok: true; data: DetailedMatrixEnvelope }
  | { ok: false; code: string; status: 400 | 403 | 503 };

export type ScopedFactsRpcArgs = {
  p_auth_subject: string;
  p_app_user_id: string;
  p_filters: ReportingFilters;
};

export type ScopedFactsRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

export type DetailedMatrixCatalogRpcArgs = {
  p_auth_subject: string;
  p_app_user_id: string;
};

export type DetailedMatrixCatalogRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

function firstString(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export function parseDetailedMatrixCatalogPayload(
  raw: unknown,
): DetailedMatrixCatalog | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.teams) || !Array.isArray(obj.recruiters)) return null;

  const teams: DetailedMatrixCatalog["teams"] = [];
  for (const item of obj.teams) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const teamId = typeof t.team_id === "string" ? t.team_id.trim() : "";
    const teamCode = typeof t.team_code === "string" ? t.team_code.trim() : "";
    const displayName =
      typeof t.display_name === "string" ? t.display_name.trim() : "";
    if (!teamId || !displayName) continue;
    teams.push({
      teamId,
      teamCode: teamCode || teamId,
      displayName,
    });
  }

  const recruiters: DetailedMatrixCatalogRecruiter[] = [];
  for (const item of obj.recruiters) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const recruiterId =
      typeof r.recruiter_id === "string" ? r.recruiter_id.trim() : "";
    const displayName =
      typeof r.display_name === "string" ? r.display_name.trim() : "";
    if (!recruiterId || !displayName) continue;
    const recruiterKey =
      typeof r.recruiter_key === "string" && r.recruiter_key.trim() !== ""
        ? r.recruiter_key.trim()
        : displayName.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    const personnelCode =
      typeof r.personnel_code === "string" && r.personnel_code.trim() !== ""
        ? r.personnel_code.trim()
        : null;
    const active = r.active === true;
    const isActiveHrp = r.is_active_hrp === true;
    const currentTeamIds = Array.isArray(r.current_team_ids)
      ? r.current_team_ids
          .filter((x): x is string => typeof x === "string" && x.trim() !== "")
          .map((x) => x.trim())
      : [];
    const rawWorkStartDate =
      typeof r.work_start_date === "string" ? r.work_start_date.trim() : "";
    const workStartDate =
      rawWorkStartDate && isRealCalendarDate(rawWorkStartDate)
        ? rawWorkStartDate
        : null;

    recruiters.push({
      recruiterId,
      recruiterKey,
      displayName,
      personnelCode,
      active,
      isActiveHrp,
      currentTeamIds,
      workStartDate,
    });
  }

  return { teams, recruiters };
}

export async function fetchDetailedRecruitmentMatrixReport(
  params: Record<string, string | string[] | undefined>,
  actor: DirectEntryActor,
  options?: {
    callScopedFactsRpc?: (
      args: ScopedFactsRpcArgs,
    ) => PromiseLike<ScopedFactsRpcResult>;
    callCatalogRpc?: (
      args: DetailedMatrixCatalogRpcArgs,
    ) => PromiseLike<DetailedMatrixCatalogRpcResult>;
    referenceDate?: Date;
  },
): Promise<DetailedMatrixFetchResult> {
  // 1. Server-side paired capability+scope guard (WP5B-2 Group A):
  //    only `(entry_admin | report_analytics_view) @ ALL` is allowed.
  if (!hasPairedAllReportingAccess(actor)) {
    return {
      ok: false,
      code: FORBIDDEN_DETAILED_MATRIX_REPORT_CODE,
      status: 403,
    };
  }

  const resolution = parseMatrixResolutionParam(params.resolution);
  if (resolution === null) {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }

  const rawTeamId =
    firstString(params.team ?? params.teamId)?.trim() ||
    ALL_RECRUITERS_TEAM_FILTER;
  if (
    rawTeamId !== ALL_RECRUITERS_TEAM_FILTER &&
    !UUID_RE.test(rawTeamId)
  ) {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }
  const normalizedTeamId =
    rawTeamId === ALL_RECRUITERS_TEAM_FILTER
      ? ALL_RECRUITERS_TEAM_FILTER
      : rawTeamId.toLowerCase();

  const filterInput: Record<string, string | string[] | undefined> = {
    ...params,
  };
  delete filterInput.resolution;
  delete filterInput.team;
  delete filterInput.teamId;
  delete filterInput.tab;

  const refDate = options?.referenceDate ?? new Date();
  const effectiveParams = applyDashboardDefaultDateParams(filterInput, refDate);
  const parsed = parseReportingFilters(effectiveParams, undefined);
  if (!parsed.ok) {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }
  const filters = parsed.filters;
  filters.source = undefined;

  const callScopedFactsRpc =
    options?.callScopedFactsRpc ??
    ((args: ScopedFactsRpcArgs) => {
      const sb = createServiceSupabaseClient();
      return sb.rpc("direct_entry_reporting_scoped_facts", args);
    });

  const callCatalogRpc =
    options?.callCatalogRpc ??
    ((args: DetailedMatrixCatalogRpcArgs) => {
      const sb = createServiceSupabaseClient();
      return sb.rpc("direct_entry_reporting_detailed_matrix_catalog", args);
    });

  try {
    const [factsRes, catalogRes] = await Promise.all([
      callScopedFactsRpc({
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
        p_filters: filters,
      }),
      callCatalogRpc({
        p_auth_subject: actor.auth_subject,
        p_app_user_id: actor.app_user_id,
      }),
    ]);

    if (factsRes.error) {
      if (factsRes.error.code === "42501") {
        return {
          ok: false,
          code: FORBIDDEN_DETAILED_MATRIX_REPORT_CODE,
          status: 403,
        };
      }
      return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    }

    if (catalogRes.error) {
      if (catalogRes.error.code === "42501") {
        return {
          ok: false,
          code: FORBIDDEN_DETAILED_MATRIX_REPORT_CODE,
          status: 403,
        };
      }
      return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    }

    const factsPayload = (factsRes.data ?? {}) as {
      audience?: unknown;
      facts?: unknown[];
    };
    const audience = resolveReportingAudienceProjection(factsPayload.audience);
    if (!audience || audience.kind !== "all") {
      return {
        ok: false,
        code: FORBIDDEN_DETAILED_MATRIX_REPORT_CODE,
        status: 403,
      };
    }

    const catalog = parseDetailedMatrixCatalogPayload(catalogRes.data);
    if (!catalog) {
      return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    }

    if (
      normalizedTeamId !== ALL_RECRUITERS_TEAM_FILTER &&
      !catalog.teams.some(
        (t) => t.teamId.toLowerCase() === normalizedTeamId,
      )
    ) {
      return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
    }

    const rawFacts = Array.isArray(factsPayload.facts)
      ? (factsPayload.facts as ReportingFact[])
      : [];
    const directEntryFacts = rawFacts.filter(
      (f) => f.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID,
    );

    const matrix = buildDetailedRecruitmentMatrix({
      facts: directEntryFacts,
      catalog,
      filters,
      resolution,
      teamId: normalizedTeamId,
      fallbackAsOfDate: getThisMonthDateRange(refDate).to,
    });

    return {
      ok: true,
      data: {
        ok: true,
        matrix,
      },
    };
  } catch {
    return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function detailedMatrixReportJson(
  data: DetailedMatrixEnvelope,
): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

export function detailedMatrixReportError(
  code: string,
  status: 400 | 403 | 503,
): Response {
  return new Response(JSON.stringify({ ok: false, code }), {
    status,
    headers: JSON_HEADERS,
  });
}
