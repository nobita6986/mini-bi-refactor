/**
 * P1.5-W04A — Bề mặt HTTP của panel cấu hình AI: fail-closed theo flag/CSRF/rate limit,
 * mã lỗi → HTTP, body bounded, và KHÔNG có endpoint đọc secret.
 *
 * Route Next không import được bằng Node thuần (alias "@/" + server-only), nên hợp đồng route được
 * kiểm bằng (a) guard/helper thật và (b) assert trên source của route (thứ tự fail-closed, không có
 * đường trả envelope/secret). Đường HTTP thật được kiểm bằng probe server cục bộ ở bước verify.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

import { createRateLimiter } from "./rate-limit.ts";
import { httpStatusFor, toApiCode } from "./settings-codes.ts";
import {
  MAX_SETTINGS_BODY_BYTES,
  guardSettingsRequest,
  readSettingsBody,
  settingsError,
} from "./server/route-helpers.mjs";

const ROUTES_DIR = new URL("../../app/api/ai/settings/", import.meta.url);

function withFlag(value, fn) {
  const previous = process.env.AI_SETTINGS_ENABLED;
  if (value === undefined) delete process.env.AI_SETTINGS_ENABLED;
  else process.env.AI_SETTINGS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.AI_SETTINGS_ENABLED;
    else process.env.AI_SETTINGS_ENABLED = previous;
  }
}

function requestWith(headers = {}) {
  return new Request("https://bi.example.com/api/ai/settings", { method: "POST", headers });
}

function routeFiles(dir = ROUTES_DIR) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...routeFiles(child));
    else if (entry.name.endsWith(".ts")) out.push({ path: child, source: readFileSync(child, "utf8") });
  }
  return out;
}

test("W04A-P1: thiếu AI_SETTINGS_ENABLED=true ⇒ 404 AI_SETTINGS_DISABLED (fail-closed trước DB)", () => {
  withFlag(undefined, () => {
    const guard = guardSettingsRequest(requestWith({ origin: "https://bi.example.com", host: "bi.example.com" }), { mutation: true });
    assert.equal(guard.ok, false);
    assert.equal(guard.response.status, 404);
    assert.equal(guard.response.headers.get("cache-control"), "private, no-store, max-age=0");
  });
  withFlag("false", () => {
    const guard = guardSettingsRequest(requestWith({ origin: "https://bi.example.com", host: "bi.example.com" }), { mutation: true });
    assert.equal(guard.ok, false);
    assert.equal(guard.response.status, 404, "chỉ giá trị 'true' mới bật");
  });
  withFlag("true", () => {
    const guard = guardSettingsRequest(requestWith({ origin: "https://bi.example.com", host: "bi.example.com" }), { mutation: true });
    assert.equal(guard.ok, true);
  });
});

test("W04A-P2: guard trả JSON sanitized và mã lỗi đúng khi flag tắt", async () => {
  await withFlag(undefined, async () => {
    const guard = guardSettingsRequest(requestWith(), { mutation: false });
    const body = await guard.response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "AI_SETTINGS_DISABLED");
    assert.equal(typeof body.message, "string");
  });
});

test("W04A-P3: CSRF/origin — mutation thiếu Origin, sai host, hoặc cross-site đều bị chặn", () => {
  withFlag("true", () => {
    const noOrigin = guardSettingsRequest(requestWith({ host: "bi.example.com" }), { mutation: true });
    assert.equal(noOrigin.ok, false);
    assert.equal(noOrigin.response.status, 403);

    const wrongHost = guardSettingsRequest(requestWith({ origin: "https://evil.example.net", host: "bi.example.com" }), { mutation: true });
    assert.equal(wrongHost.ok, false);
    assert.equal(wrongHost.response.status, 403);

    const crossSite = guardSettingsRequest(
      requestWith({ origin: "https://bi.example.com", host: "bi.example.com", "sec-fetch-site": "cross-site" }),
      { mutation: true }
    );
    assert.equal(crossSite.ok, false);
    assert.equal(crossSite.response.status, 403);

    // GET (không mutation) không cần Origin.
    const read = guardSettingsRequest(requestWith({ host: "bi.example.com" }), { mutation: false });
    assert.equal(read.ok, true);
  });
});

test("W04A-P4: mã lỗi → HTTP ổn định; mã lạ ⇒ AI_INTERNAL (không rò mã nội bộ)", () => {
  const table = [
    ["AI_SETTINGS_DISABLED", 404],
    ["AI_VERSION_CONFLICT", 409],
    ["AI_CONFIG_NOT_VERIFIED", 409],
    ["AI_CONFIG_REQUIRED", 503],
    ["AI_RATE_LIMITED", 429],
    ["AI_CSRF_REJECTED", 403],
    ["AI_INPUT_INVALID", 422],
    ["AI_DECRYPT_FAILED", 500],
    ["AI_CONFIG_NOT_FOUND", 404],
  ];
  for (const [code, status] of table) {
    assert.equal(httpStatusFor(code), status, code);
    assert.equal(settingsError(code, "x").status, status, code);
  }
  assert.equal(toApiCode("VERSION_CONFLICT"), "AI_VERSION_CONFLICT");
  assert.equal(toApiCode("DECRYPT_FAILED"), "AI_DECRYPT_FAILED");
  assert.equal(toApiCode("URL_REJECTED"), "AI_URL_REJECTED");
  assert.equal(toApiCode("REDIRECT_REJECTED"), "AI_REDIRECT_REJECTED");
  assert.equal(toApiCode("khong-ton-tai"), "AI_INTERNAL");
  assert.equal(toApiCode(undefined), "AI_INTERNAL");
  assert.equal(httpStatusFor("khong-ton-tai"), 500);
});

test("W04A-P5: body bounded + JSON object; thông điệp lỗi không chứa nội dung body", async () => {
  const tooLarge = new Request("https://bi.example.com/api/ai/settings", {
    method: "POST",
    headers: { "content-length": String(MAX_SETTINGS_BODY_BYTES + 1) },
    body: "x",
  });
  const large = await readSettingsBody(tooLarge);
  assert.equal(large.ok, false);
  // R1 (B): vượt trần byte ⇒ 413 (AI_RESULT_TOO_LARGE), không phải 422 chung.
  assert.equal(large.code, "RESULT_TOO_LARGE");
  assert.equal(httpStatusFor(toApiCode(large.code)), 413);

  const arrayBody = new Request("https://bi.example.com/api/ai/settings", { method: "POST", body: "[1,2,3]" });
  const arrayResult = await readSettingsBody(arrayBody);
  assert.equal(arrayResult.ok, false);

  const broken = new Request("https://bi.example.com/api/ai/settings", { method: "POST", body: "{not json" });
  const brokenResult = await readSettingsBody(broken);
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.message.includes("not json"), false, "thông điệp không được echo body");

  const empty = await readSettingsBody(new Request("https://bi.example.com/api/ai/settings", { method: "POST" }));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.value, {});
});

test("W04A-P6: rate limit bounded (cửa sổ trượt, deterministic) và guard trả 429 khi vượt trần", () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 3, window_ms: 1_000, now: () => clock });
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  assert.equal(limiter.check("a").ok, true);
  const blocked = limiter.check("a");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "RATE_LIMITED");
  assert.equal(blocked.retry_after_ms > 0, true);
  clock = 1_001;
  assert.equal(limiter.check("a").ok, true, "hết cửa sổ thì cho phép lại");

  // Guard thật: actor riêng, đúng 20 mutation rồi chặn.
  withFlag("true", () => {
    const actor = "rate-test-actor-" + Date.now();
    const headers = { origin: "https://bi.example.com", host: "bi.example.com" };
    for (let index = 0; index < 20; index += 1) {
      assert.equal(guardSettingsRequest(requestWith(headers), { mutation: true, actor_ref: actor }).ok, true, "lần " + (index + 1));
    }
    const blockedGuard = guardSettingsRequest(requestWith(headers), { mutation: true, actor_ref: actor });
    assert.equal(blockedGuard.ok, false);
    assert.equal(blockedGuard.response.status, 429);
  });
});

test("W04A-P7: route settings — fail-closed TRƯỚC mọi truy cập DB và KHÔNG có đường trả secret", () => {
  const files = routeFiles();
  assert.equal(files.length >= 5, true, "phải có đủ 5 route (settings + test + rotate + activate + disable)");

  for (const file of files) {
    const name = file.path.pathname;
    assert.equal(/secret|key\b/i.test(name), false, "không được có route tên secret: " + name);
    // Không có đường đọc/giải mã secret ở tầng HTTP.
    for (const forbidden of ["decryptSecret", "encrypted_secret", "credential_secret", "ciphertext", "authentication_tag", "fingerprintSecret"]) {
      assert.equal(file.source.includes(forbidden), false, name + " không được chạm " + forbidden);
    }
    // Guard phải chạy TRƯỚC khi wiring store/keyring; actor Full Admin check chạy sau guardApiSession().
    const guardIndex = file.source.indexOf("guardSettingsRequest(request");
    const adminGuardIndex = file.source.indexOf("guardAiSettingsAdminActor(");
    const wiringIndex = Math.max(
      file.source.indexOf("createSettingsWiring("),
      file.source.indexOf("createServerAiSettingsService(")
    );
    assert.equal(guardIndex >= 0, true, name + " phải gọi guardSettingsRequest");
    assert.equal(adminGuardIndex > guardIndex, true, name + " phải kiểm tra Full Admin sau guardSettingsRequest");
    assert.equal(wiringIndex > adminGuardIndex, true, name + " phải wiring SAU guardAiSettingsAdminActor");
    assert.equal(file.source.includes("PILOT_ACTOR_REF"), false, name + " không được dùng PILOT_ACTOR_REF (OD-WP5-04)");
    assert.equal(file.source.includes("isAiSettingsEnabled"), false, name + " không tự đọc flag (dùng guard)");
  }

  const mutationRoutes = files.filter((file) => file.source.includes("mutation: true"));
  assert.equal(mutationRoutes.length, 5, "mọi mutation route phải khai báo mutation: true");
  const readRoute = files.find((file) => file.path.pathname.endsWith("settings/route.ts"));
  assert.equal(readRoute.source.includes("mutation: false"), true, "GET phải dùng mutation: false");
  assert.equal(readRoute.source.includes("provider_profiles"), true, "GET trả danh sách profile cho panel");
});

test("W04A-P8: /api/ai/settings nằm sau Supabase session guard (P1.7-H04 đã bỏ Pilot Basic Auth)", () => {
  // P1.7-H04: proxy Pilot Basic Auth bị xóa, nên guard phải nằm trong chính route.
  assert.throws(() => readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8"),
    "proxy Pilot Basic Auth phải bị xóa");
  assert.throws(() => readFileSync(new URL("../auth/pilot-access.ts", import.meta.url), "utf8"),
    "pilot-access phải bị xóa");

  const settings = readFileSync(new URL("../../app/api/ai/settings/route.ts", import.meta.url), "utf8");
  assert.equal(settings.includes("guardApiSession()"), true,
    "route settings phải xác thực session trước khi chạm dữ liệu");

  // P3-W02E: khoa rang GET va POST cung route deu goi guard, khong chi method nao
  // do. Tach thanh hai block function rieng de assert vi tri guard trong tung method.
  const getStart = settings.indexOf("export async function GET");
  const postStart = settings.indexOf("export async function POST");
  assert.ok(getStart >= 0 && postStart > getStart, "phai co GET truoc POST");
  const getBlock = settings.slice(getStart, postStart);
  const postBlock = settings.slice(postStart);
  assert.match(getBlock, /await guardApiSession\(\)/, "GET phai goi guardApiSession()");
  assert.match(postBlock, /await guardApiSession\(\)/, "POST phai goi guardApiSession()");

  const guard = readFileSync(new URL("../auth/api-session-guard.ts", import.meta.url), "utf8");
  assert.equal(guard.includes('"UNAUTHENTICATED"'), true, "guard phải trả 401 sanitized");
  assert.equal(guard.includes("private, no-store"), true, "response lỗi phải private/no-store");
});

test("W04A-P9: dashboard layout không render AI panels trong P3 release (P3-W06A Scope B)", () => {
  // P3-W06A Scope B: AI deferred to P3.1. Dashboard layout KHÔNG import / render
  // AiReportPanel / AiSettingsPanel nữa, kể cả khi server bật cờ.
  // Implementation vẫn giữ nguyên trong source, chỉ layout bỏ leave `headerActions` AI.
  const view = readFileSync(new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../app/dashboard/page.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../../app/dashboard/layout.tsx", import.meta.url), "utf8");
  // Layout KHÔNG import AI panels.
  assert.equal(
    /import\s*\{[^}]*AiReportPanel[^}]*\}\s*from\s*["']@\/components\/ai-report\//.test(layout),
    false,
    "P3-W06A: dashboard layout KHÔNG import AiReportPanel",
  );
  assert.equal(
    /import\s*\{[^}]*AiSettingsPanel[^}]*\}\s*from\s*["']@\/components\/dashboard\/ai-settings-panel/.test(layout),
    false,
    "P3-W06A: dashboard layout KHÔNG import AiSettingsPanel",
  );
  // Layout KHÔNG reference isAiSettingsEnabled / headerActions (loại comment).
  const layoutCode = layout.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
  assert.equal(/isAiSettingsEnabled/.test(layoutCode), false,
    "P3-W06A: dashboard layout KHÔNG goi isAiSettingsEnabled");
  assert.equal(/headerActions/.test(layoutCode), false,
    "P3-W06A: dashboard layout KHÔNG truyền headerActions");
  // Page và view cũng không import AI panels (khong hard-code bat o client).
  assert.equal(/isAiSettingsEnabled\(\)/.test(page), false);
  assert.equal(view.includes("AiSettingsPanel"), false);
  assert.equal(view.includes("NEXT_PUBLIC"), false);
});
