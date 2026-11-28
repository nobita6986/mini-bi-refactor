import "server-only";

import { apiSessionError, guardApiSession } from "@/lib/auth/api-session-guard";
import {
  detailedMatrixReportError,
  detailedMatrixReportJson,
  fetchDetailedRecruitmentMatrixReport,
} from "@/lib/reporting/detailed-recruitment-matrix-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/reporting/detailed-matrix
 *
 * Server-aggregated 2D recruitment matrix (`Nhân viên tuyển dụng × Ngày/Tuần/Tháng`)
 * for the global Dashboard "Báo cáo chi tiết" tab (`scope = "all"` only).
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
    params[key] =
      prior === undefined
        ? value
        : Array.isArray(prior)
          ? [...prior, value]
          : [prior, value];
  }

  const result = await fetchDetailedRecruitmentMatrixReport(params, guard.actor);
  return result.ok
    ? detailedMatrixReportJson(result.data)
    : detailedMatrixReportError(result.code, result.status);
}
