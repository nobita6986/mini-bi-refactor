import "server-only";

import { apiSessionError, guardApiSession } from "@/lib/auth/api-session-guard";
import {
  fetchWorkforceDeepReport,
  workforceDeepReportError,
  workforceDeepReportJson,
} from "@/lib/reporting/wf04-deep-report-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WF-04 Post-Merge Hotfix — GET /api/reporting/workforce-deep
 *
 * Endpoint đọc dữ liệu chuyên sâu (WF-02 2.3–2.4, WF-03 2.5–2.6, WF-04 2.7–2.8)
 * và phân trang server-side (`mode=project_page&cursor=...`) cho bảng Theo dự án.
 * Chỉ được phép gọi khi người dùng mở tab `Báo cáo chuyên sâu` và có `scope = "all"` (Admin/BoD).
 * Tự bảo vệ bằng `guardApiSession()` + kiểm tra `scope = "all"` ở cả TypeScript và PostgreSQL RPC.
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
      prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }

  const result = await fetchWorkforceDeepReport(params, guard.actor);
  return result.ok
    ? workforceDeepReportJson(result.data)
    : workforceDeepReportError(result.code, result.status);
}
