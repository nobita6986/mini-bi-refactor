/**
 * P1.5-W04A — Feature flag cho panel cấu hình AI (thuần, testable).
 *
 * Fail-closed: production/preview THIẾU `AI_SETTINGS_ENABLED=true` ⇒ route/panel không tồn tại (404).
 * Development cũng KHÔNG tự bật: phải khai báo tường minh (tránh vô tình mở trên máy dev có dữ liệu thật).
 */

export const AI_SETTINGS_ENABLED_VAR = "AI_SETTINGS_ENABLED";

export function isAiSettingsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[AI_SETTINGS_ENABLED_VAR];
  return typeof value === "string" && value.trim() === "true";
}
