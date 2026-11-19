import "server-only";

/**
 * P1.5-W04A — Wiring server cho settings cấu hình provider.
 *
 * Fail-closed theo thứ tự: feature flag (404 trước DB) → master key (AI_CONFIG_REQUIRED) → store/RPC.
 * KHÔNG đọc NEXT_PUBLIC_*, KHÔNG log secret, KHÔNG trả envelope/ciphertext ra ngoài server.
 */

import { isAiSettingsEnabled } from "../settings-flag.ts";
import {
  activateProviderConfig,
  disableProviderConfig,
  readSettingsStatus,
  rotateProviderKey,
  saveProviderConfig,
  testProviderConnection,
  PILOT_CONFIG_ID,
} from "../settings-service.ts";
import { tryKeyringFromEnvironment } from "../crypto-envelope.ts";
import { DEFAULT_PROVIDER_PROFILE_ID } from "../provider-profiles.ts";

import { createSupabaseProviderConfigStore } from "./store.mjs";

const ACTOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Môi trường triển khai: Vercel env trước, sau đó NODE_ENV (preview/production KHÔNG nhận dev override). */
export function environmentOf(env = process.env) {
  const vercel = env.VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return env.NODE_ENV === "production" ? "production" : "development";
}

export function allowedHostsFromEnv(env = process.env) {
  return String(env.AI_PROVIDER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

export function urlPolicyFromEnv(env = process.env) {
  return {
    environment: environmentOf(env),
    nodeEnv: env.NODE_ENV,
    allowDevLocalHttp: env.AI_CONFIG_ALLOW_LOCAL_HTTP === "true",
    allowedHosts: allowedHostsFromEnv(env),
  };
}

/**
 * Tạo service settings. Trả fail-closed khi flag tắt hoặc thiếu master key — TRƯỚC mọi truy cập DB.
 * @returns {{ok:true, service:object, actor_ref:string, config_id:string} | {ok:false, code:string, message:string}}
 */
export function createServerAiSettingsService(options = {}) {
  const env = options.env ?? process.env;
  if (!isAiSettingsEnabled(env)) {
    return { ok: false, code: "AI_SETTINGS_DISABLED", message: "Bảng cấu hình AI đang tắt" };
  }
  const keyring = tryKeyringFromEnvironment(env, options.previous_keys ?? new Map());
  if (!keyring.ok) {
    return { ok: false, code: keyring.code, message: keyring.message };
  }
  const actorRef = typeof options.actor_ref === "string" ? options.actor_ref.trim() : "";
  if (!ACTOR_UUID_RE.test(actorRef)) {
    return {
      ok: false,
      code: "AI_FORBIDDEN",
      message: "Bạn không có quyền quản trị cấu hình AI",
    };
  }
  const store = options.store ?? createSupabaseProviderConfigStore({ env });
  const urlPolicy = options.url_policy ?? urlPolicyFromEnv(env);
  const configId = options.config_id ?? PILOT_CONFIG_ID;
  const outbound = options.outbound;

  return {
    ok: true,
    actor_ref: actorRef,
    config_id: configId,
    default_provider_profile: DEFAULT_PROVIDER_PROFILE_ID,
    service: {
      status: () => readSettingsStatus({ store, config_id: configId }),
      save: (body) => saveProviderConfig({ store, keyring: keyring.keyring, url_policy: urlPolicy, actor: actorRef, body }),
      rotate: (body) => rotateProviderKey({ store, keyring: keyring.keyring, actor: actorRef, body }),
      test: (body) => testProviderConnection({
        store,
        keyring: keyring.keyring,
        url_policy: urlPolicy,
        actor: actorRef,
        body,
        outbound,
      }),
      activate: (body) => activateProviderConfig({ store, actor: actorRef, body }),
      disable: (body) => disableProviderConfig({ store, actor: actorRef, body }),
    },
  };
}

export { PILOT_CONFIG_ID };
