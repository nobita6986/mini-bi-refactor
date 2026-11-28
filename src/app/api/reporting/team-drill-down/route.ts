import "server-only";

import { apiSessionError, guardApiSession } from "@/lib/auth/api-session-guard";

import {
  drillDownError,
  drillDownJson,
  fetchCutoverTeamDrillDown,
} from "@/lib/reporting/p2-w05b-team-reporting-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const result = await fetchCutoverTeamDrillDown(params, guard.actor);
  return result.ok ? drillDownJson(result.data) : drillDownError(result.code, result.status);
}
