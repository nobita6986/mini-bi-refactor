import "server-only";

/**
 * P1.5-W04A — POST /api/ai/settings/test — kiểm tra kết nối provider.
 * CHỈ chạy khi Owner bấm (không tự chạy khi render/mở panel). Dùng outbound guard.
 * Thành công mới đánh dấu verified; thất bại ⇒ test_failed và KHÔNG tự active.
 */

import {
  guardAiSettingsAdminActor,
  guardSettingsRequest,
  settingsError,
  settingsJson,
} from "@/lib/ai-config/server/route-helpers.mjs";
import { readSettingsJsonBody } from "@/lib/ai-config/server/route-body";
import { createSettingsWiring } from "@/lib/ai-config/server/settings-wiring";
import { guardApiSession } from "@/lib/auth/api-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const guard = guardSettingsRequest(request, { mutation: true });
  if (!guard.ok) return guard.response;

  const session = await guardApiSession();
  if (!session.ok) return session.response;

  const adminGuard = guardAiSettingsAdminActor(session.actor, { mutation: true });
  if (!adminGuard.ok) return adminGuard.response;

  const wired = createSettingsWiring({ actor_ref: adminGuard.actor_ref });
  if (!wired.ok) return settingsError(wired.code, wired.message);

  const body = await readSettingsJsonBody(request);
  if (!body.ok) return settingsError(body.code, body.message);

  const result = await wired.service.test(body.value);
  if (!result.ok) return settingsError(result.code, result.message);
  return settingsJson({
    ok: true,
    verified: result.verified,
    reason_code: result.reason_code,
    config: result.config,
  });
}
