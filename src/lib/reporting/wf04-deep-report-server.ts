import "server-only";

import {
  hasPairedAllReportingAccess,
  type DirectEntryActor,
} from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { applyDashboardDefaultDateParams } from "./p1-date-presets";
import { INVALID_FILTER_CODE, parseReportingFilters } from "./p1-filter";
import { REPORTING_QUERY_FAILED_CODE } from "./p1-reporting";
import {
  resolveWorkforceDeepReportingForActor,
  resolveWorkforceProjectPageForActor,
  WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
  type WorkforceProjectPageResult,
  type WorkforceReportingResult,
  type WorkforceScopedRpcArgs,
  type WorkforceScopedRpcResult,
} from "./wf01-workforce-snapshot";

export const FORBIDDEN_DEEP_WORKFORCE_REPORT_CODE = "FORBIDDEN_DEEP_WORKFORCE_REPORT";

export type WorkforceDeepReportEnvelope =
  | {
      ok: true;
      mode: "deep";
      workforce: Extract<WorkforceReportingResult, { status: "ready" }>;
    }
  | {
      ok: true;
      mode: "project_page";
      projectPage: Extract<WorkforceProjectPageResult, { status: "ready" }>;
    };

export type WorkforceDeepReportFetchResult =
  | { ok: true; data: WorkforceDeepReportEnvelope }
  | { ok: false; code: string; status: 400 | 403 | 503 };

function firstString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

export async function fetchWorkforceDeepReport(
  params: Record<string, string | string[] | undefined>,
  actor: DirectEntryActor,
  options?: {
    callWorkforceRpc?: (args: WorkforceScopedRpcArgs) => PromiseLike<WorkforceScopedRpcResult>;
  },
): Promise<WorkforceDeepReportFetchResult> {
  // 1. Server-side paired capability+scope guard (WP5B-2 Group A):
  //    chi actor co (entry_admin | report_analytics_view) @ ALL duoc phep truy cap.
  if (!hasPairedAllReportingAccess(actor)) {
    return { ok: false, code: FORBIDDEN_DEEP_WORKFORCE_REPORT_CODE, status: 403 };
  }

  const rawMode = firstString(params.mode)?.trim() || "deep";
  if (rawMode !== "deep" && rawMode !== "project_page") {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }

  const rawCursor = firstString(params.cursor)?.trim() || "";
  if (rawMode === "project_page" && !rawCursor) {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }

  const filterInput: Record<string, string | string[] | undefined> = { ...params };
  delete filterInput.mode;
  delete filterInput.cursor;
  delete filterInput.limit;

  const effectiveParams = applyDashboardDefaultDateParams(filterInput);
  const parsed = parseReportingFilters(effectiveParams, undefined);
  if (!parsed.ok) {
    return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
  }
  const filters = parsed.filters;
  filters.source = undefined;

  const callRpc =
    options?.callWorkforceRpc ??
    ((args: WorkforceScopedRpcArgs) => {
      const sb = createServiceSupabaseClient();
      return sb.rpc("direct_entry_workforce_reporting_scoped", args);
    });

  if (rawMode === "project_page") {
    const pageResult = await resolveWorkforceProjectPageForActor({
      actor,
      filters,
      cursor: rawCursor,
      projectLimit: WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
      callWorkforceRpc: callRpc,
    });
    if (pageResult.status !== "ready") {
      if (pageResult.reason === "audience_mismatch") {
        return { ok: false, code: FORBIDDEN_DEEP_WORKFORCE_REPORT_CODE, status: 403 };
      }
      if (pageResult.reason === "missing_cursor") {
        return { ok: false, code: INVALID_FILTER_CODE, status: 400 };
      }
      return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
    }
    return {
      ok: true,
      data: {
        ok: true,
        mode: "project_page",
        projectPage: pageResult,
      },
    };
  }

  const deepResult = await resolveWorkforceDeepReportingForActor({
    actor,
    filters,
    projectLimit: WORKFORCE_PROJECT_DEFAULT_PAGE_SIZE,
    callWorkforceRpc: callRpc,
  });
  if (deepResult.status !== "ready") {
    if (deepResult.reason === "audience_mismatch") {
      return { ok: false, code: FORBIDDEN_DEEP_WORKFORCE_REPORT_CODE, status: 403 };
    }
    return { ok: false, code: REPORTING_QUERY_FAILED_CODE, status: 503 };
  }

  return {
    ok: true,
    data: {
      ok: true,
      mode: "deep",
      workforce: deepResult,
    },
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function workforceDeepReportJson(data: WorkforceDeepReportEnvelope): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}

export function workforceDeepReportError(code: string, status: 400 | 403 | 503): Response {
  return new Response(JSON.stringify({ ok: false, code }), { status, headers: JSON_HEADERS });
}
