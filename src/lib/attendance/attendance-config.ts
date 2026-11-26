import "server-only";

import { Buffer } from "node:buffer";

export const ATTENDANCE_ENABLED_VAR = "ATTENDANCE_ENABLED";
export const ATTENDANCE_TIME_TOKEN_SECRET_VAR = "ATTENDANCE_TIME_TOKEN_SECRET";

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

const PLACEHOLDER_SECRETS = new Set([
  "<attendance-time-token-secret>",
  "attendance-time-token-secret",
  "changeme",
  "placeholder",
  "secret",
  "default",
]);

const EXPLICIT_OTHER_SECRET_ENV_KEYS = [
  "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_DB_URL",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCESS_KEY_ID",
  "VPSTTT_STORAGE_SECRET_ACCESS_KEY",
  "VPSTTT_STORAGE_ACCESS_KEY_ID",
  "AI_WORKER_TOKEN",
  "AI_CONFIG_MASTER_KEY",
] as const;

export type AttendanceSigningSecretResult =
  | { ok: true; secret: Buffer }
  | { ok: false; code: "ATTENDANCE_CONFIG_REQUIRED" };

export function isAttendanceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ATTENDANCE_ENABLED_VAR] === "true";
}

function collectDisallowedReuseValues(
  env: Record<string, string | undefined>,
): Set<string> {
  const disallowed = new Set<string>();

  for (const key of EXPLICIT_OTHER_SECRET_ENV_KEYS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    disallowed.add(raw);
    if (key === "SUPABASE_DB_URL") {
      try {
        const parsed = new URL(raw);
        const password = decodeURIComponent(parsed.password);
        if (password) disallowed.add(password);
      } catch {
        // Ignore malformed DB URL here; full string is already added.
      }
    }
  }

  for (const [key, rawValue] of Object.entries(env)) {
    if (key === ATTENDANCE_TIME_TOKEN_SECRET_VAR) continue;
    if (
      key.endsWith("_SECRET") ||
      key.endsWith("_SECRET_KEY") ||
      key.endsWith("_TOKEN") ||
      key.endsWith("_MASTER_KEY")
    ) {
      const cleaned = rawValue?.trim();
      if (cleaned) disallowed.add(cleaned);
    }
  }

  return disallowed;
}

export function loadAttendanceSigningSecret(
  env: Record<string, string | undefined> = process.env,
): AttendanceSigningSecretResult {
  const raw = env[ATTENDANCE_TIME_TOKEN_SECRET_VAR];
  if (typeof raw !== "string") {
    return { ok: false, code: "ATTENDANCE_CONFIG_REQUIRED" };
  }

  const secret = raw.trim();
  if (
    secret.length < MIN_SECRET_LENGTH ||
    secret.length > MAX_SECRET_LENGTH ||
    !PRINTABLE_ASCII.test(secret) ||
    PLACEHOLDER_SECRETS.has(secret.toLowerCase()) ||
    (secret.startsWith("<") && secret.endsWith(">")) ||
    new Set(secret).size < 8
  ) {
    return { ok: false, code: "ATTENDANCE_CONFIG_REQUIRED" };
  }

  const disallowedReuse = collectDisallowedReuseValues(env);
  if (disallowedReuse.has(secret)) {
    return { ok: false, code: "ATTENDANCE_CONFIG_REQUIRED" };
  }

  return { ok: true, secret: Buffer.from(secret, "utf8") };
}
