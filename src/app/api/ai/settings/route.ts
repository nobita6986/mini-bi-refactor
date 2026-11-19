import "server-only";

/**
 * P1.5-W04A — GET/POST /api/ai/settings
 *
 * GET  : trạng thái SANITIZED của cấu hình provider (không envelope, không URL đầy đủ, không secret).
 * POST : lưu cấu hình (tạo version mới) với optimistic version.
 *
 * Fail-closed TRƯỚC DB: thiếu AI_SETTINGS_ENABLED=true ⇒ 404; thiếu master key ⇒ 503 AI_CONFIG_REQUIRED.
 * KHÔNG có endpoint nào đọc lại secret.
 */

import { PROVIDER_PROFILES } from "@/lib/ai-config/provider-profiles.ts";
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

export async function GET(request: Request) {
  const guard = guardSettingsRequest(request, { mutation: false });
  if (!guard.ok) return guard.response;

  // P1.7-H04 + OD-WP5-04: xac thuc Supabase session va Full Admin (paired ALL).
  const session = await guardApiSession();
  if (!session.ok) return session.response;

  const adminGuard = guardAiSettingsAdminActor(session.actor, { mutation: false });
  if (!adminGuard.ok) return adminGuard.response;

  const wired = createSettingsWiring({ actor_ref: adminGuard.actor_ref });
  if (!wired.ok) return settingsError(wired.code, wired.message);

  const result = await wired.service.status();
  // R1 (C): lỗi DB/transport/malformed KHÔNG được trả thành config:null giả.
  if (!result.ok) return settingsError(result.code, result.message);
  return settingsJson({
    ok: true,
    config: result.config,
    active: result.active,
    provider_profiles: PROVIDER_PROFILES.map((profile) => ({ id: profile.id, label: profile.label })),
    default_provider_profile: wired.default_provider_profile,
  });
}

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

  const result = await wired.service.save(body.value);
  if (!result.ok) return settingsError(result.code, result.message);
  return settingsJson({ ok: true, config: result.config });
}
