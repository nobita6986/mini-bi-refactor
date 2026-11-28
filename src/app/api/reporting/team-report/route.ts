import "server-only";

import { apiSessionError, guardApiSession } from "@/lib/auth/api-session-guard";

import {
  fetchCutoverTeamReport,
  teamReportError,
  teamReportJson,
} from "@/lib/reporting/p3-w06d-team-report-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * P3-W06D-R2 - GET /api/reporting/team-report
 *
 * The single server-authorized read for a selected team bucket. Owns its own
 * session guard (an API route can be called directly, so the /dashboard page
 * gate does not protect it) and never trusts a client-supplied audience; the
 * server re-resolves the audience and verifies the bucket against the
 * authorized fact set before returning any aggregate or row.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardApiSession();
  if (!guard.ok) return guard.response;
  if (guard.actor.partner_account !== undefined) {
    return apiSessionError("ACTOR_NOT_AVAILABLE", 403);
  }

  const params: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    const prior = params[key];
    params[key] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  const result = await fetchCutoverTeamReport(params, guard.actor);
  return result.ok ? teamReportJson(result.data) : teamReportError(result.code, result.status);
}
