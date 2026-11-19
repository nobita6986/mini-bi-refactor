import "server-only";

/**
 * P1.5-W04A — Guard + response cho route settings.
 *
 * Thứ tự fail-closed: feature flag (404 TRƯỚC DB) → CSRF/origin → rate limit → body bounded.
 * Module này KHÔNG import store/Supabase (test được bằng Node, không cần DB).
 */

import { checkSameOriginRequest, sanitizeMessage } from "../../ai/gateway/http-guards.mjs";
import { hasPairedFullAdmin } from "../../auth/direct-entry-v2.ts";
import { httpStatusFor, toApiCode } from "../settings-codes.ts";
import { isAiSettingsEnabled } from "../settings-flag.ts";
import { createRateLimiter } from "../rate-limit.ts";

/**
 * R1 (B) — TRẦN BYTE CỨNG cho body settings (20 KiB, đo UTF-8/byte thật).
 * Không dùng `string.length`; request không có Content-Length (chunked) được đọc theo từng chunk
 * và DỪNG NGAY khi tổng byte vượt trần (không đọc toàn bộ body rồi mới kiểm tra).
 */
export const MAX_SETTINGS_BODY_BYTES = 20 * 1024;
export const SETTINGS_MUTATION_LIMIT = 20;
export const SETTINGS_MUTATION_WINDOW_MS = 60_000;

const mutationLimiter = createRateLimiter({
  limit: SETTINGS_MUTATION_LIMIT,
  window_ms: SETTINGS_MUTATION_WINDOW_MS,
});

/**
 * R1 (E) — Rate limit cho mutation settings.
 *
 * ĐÂY LÀ LIMITER **PROCESS-LOCAL / BEST-EFFORT** cho pilot: cửa sổ trượt nằm trong bộ nhớ MỘT tiến trình
 * serverless, KHÔNG phải hard distributed rate limit (nhiều instance ⇒ trần thực tế có thể cao hơn).
 * P3 PHẢI thay bằng limiter atomic ở DB/KV theo **authenticated actor** (khoá theo user thật + org).
 */
const ACTOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkSettingsRateLimit(actorRef) {
  if (typeof actorRef !== "string" || actorRef.trim().length === 0) {
    return { ok: false, code: "INVALID_INPUT", retry_after_ms: 0 };
  }
  return mutationLimiter.check(actorRef);
}

export function settingsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function settingsError(code, message) {
  const apiCode = toApiCode(code);
  return settingsJson({ ok: false, code: apiCode, message: sanitizeMessage(message) }, httpStatusFor(apiCode));
}

/**
 * Guard chung cho mọi route settings (KHÔNG chạm DB).
 * @returns {{ok:true} | {ok:false, response:Response}}
 */
export function guardSettingsRequest(request, options = {}) {
  const actorRef = typeof options.actor_ref === "string" && options.actor_ref.length > 0
    ? options.actor_ref
    : null;
  if (!isAiSettingsEnabled()) {
    return { ok: false, response: settingsError("SETTINGS_DISABLED", "Bảng cấu hình AI đang tắt") };
  }
  if (options.mutation === true) {
    const originCheck = checkSameOriginRequest({
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    });
    if (!originCheck.ok) {
      return { ok: false, response: settingsError("CSRF_REJECTED", originCheck.message) };
    }
    if (actorRef !== null) {
      const limit = checkSettingsRateLimit(actorRef);
      if (!limit.ok) {
        return { ok: false, response: settingsError("RATE_LIMITED", "quá nhiều yêu cầu cấu hình") };
      }
    }
  }
  return { ok: true };
}

/**
 * OD-WP5-04: Enforces authenticated Full Admin (`entry_admin` + `recruiter_master_manage`
 * + `team_master_manage` @ `ALL`) on every `/api/ai/settings/**` route, and applies per-actor
 * rate limiting using the verified UUID `actor.app_user_id`.
 */
export function guardAiSettingsAdminActor(actor, options = {}) {
  const appUserId = typeof actor?.app_user_id === "string" ? actor.app_user_id.trim() : "";
  if (!hasPairedFullAdmin(actor) || !ACTOR_UUID_RE.test(appUserId)) {
    return {
      ok: false,
      response: settingsError("AI_FORBIDDEN", "Bạn không có quyền quản trị cấu hình AI"),
    };
  }
  if (options.mutation === true) {
    const limit = checkSettingsRateLimit(appUserId);
    if (!limit.ok) {
      return {
        ok: false,
        response: settingsError("RATE_LIMITED", "quá nhiều yêu cầu cấu hình"),
      };
    }
  }
  return { ok: true, actor_ref: appUserId };
}

const TOO_LARGE = { ok: false, code: "RESULT_TOO_LARGE", message: "body quá lớn" };

/**
 * Đọc body với trần BYTE cứng. Trả { ok:true, bytes } | { ok:false, code, message }.
 * Không bao giờ nạp quá trần vào bộ nhớ: vượt trần ⇒ cancel stream ngay.
 */
export async function readBoundedBodyBytes(request, maxBytes = MAX_SETTINGS_BODY_BYTES) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return { ok: false, code: "INVALID_INPUT", message: "content-length không hợp lệ" };
    }
    if (declared > maxBytes) return TOO_LARGE;
  }

  const stream = request.body;
  if (!stream) return { ok: true, bytes: 0, chunks: [] };

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        // Dừng ngay, không đọc tiếp phần còn lại của body.
        try {
          await reader.cancel();
        } catch {
          /* stream đã đóng */
        }
        return TOO_LARGE;
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "không đọc được body" };
  }
  return { ok: true, bytes: total, chunks };
}

/** Đọc + parse JSON body với trần byte cứng; thông điệp lỗi KHÔNG echo nội dung body. */
export async function readSettingsBody(request, maxBytes = MAX_SETTINGS_BODY_BYTES) {
  const bounded = await readBoundedBodyBytes(request, maxBytes);
  if (!bounded.ok) return bounded;

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(
      bounded.bytes === 0 ? new Uint8Array(0) : Buffer.concat(bounded.chunks.map((chunk) => Buffer.from(chunk)), bounded.bytes)
    );
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "không giải mã được body" };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "INVALID_INPUT", message: "body phải là JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "body không phải JSON hợp lệ" };
  }
}
