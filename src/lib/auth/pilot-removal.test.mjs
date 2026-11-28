import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
function missing(relative) {
  try {
    source(relative);
    return false;
  } catch {
    return true;
  }
}

test("P1.7-H04: Pilot Basic Auth runtime da bi xoa hoan toan", () => {
  const proxySource = source("../../proxy.ts");
  assert.match(proxySource, /resolvePortalProxyDecision/, "src/proxy.ts chi duoc dung cho portal host isolation");
  assert.equal(/pilot-access|PILOT_ACCESS_|WWW-Authenticate|Mini BI Pilot|Authorization|\bBasic\b/.test(proxySource), false, "src/proxy.ts khong duoc chua Pilot Basic Auth");
  assert.equal(missing("../../proxy.test.mjs"), true, "src/proxy.test.mjs phai bi xoa");
  assert.equal(missing("./pilot-access.ts"), true, "pilot-access.ts phai bi xoa");
  assert.equal(missing("./pilot-access.test.mjs"), true, "pilot-access.test.mjs phai bi xoa");
});

test("P1.7-H04: khong con Basic challenge, realm cu hay body pilot trong source", () => {
  const guard = source("./api-session-guard.ts");
  const page = source("../../app/dashboard/page.tsx");
  const proxy = source("../../proxy.ts");
  for (const [name, text] of [["api-session-guard", guard], ["dashboard page", page], ["proxy", proxy]]) {
    assert.equal(/WWW-Authenticate/i.test(text), false, name + " khong duoc tra Basic challenge");
    assert.equal(text.includes("Mini BI Pilot"), false, name + " khong duoc dung realm cu");
    assert.equal(text.includes("Pilot access unavailable"), false, name);
    assert.equal(text.includes("PILOT_ACCESS_"), false, name);
  }
});

test("P1.7-H04: guard tra 401/403 sanitized va luon private/no-store", () => {
  const guard = source("./api-session-guard.ts");
  assert.match(guard, /apiSessionError\("UNAUTHENTICATED", 401\)/);
  assert.match(guard, /apiSessionError\("ACTOR_NOT_AVAILABLE", 403\)/);
  assert.match(guard, /"cache-control": "private, no-store"/);
  // Khong redirect HTML tu API: guard phai tra Response JSON, khong dung redirect().
  assert.equal(/redirect\(/.test(guard), false, "API guard khong duoc redirect HTML");
  // Khong lo UUID/capability/raw error ra response.
  assert.equal(/app_user_id|capabilities|stack/.test(guard), false);
});

test("P1.7-H04 / AI retirement: moi route /api/ai/** da duoc go hoan toan (404 theo router)", () => {
  const routes = [
    "../../app/api/ai/reports/route.ts",
    "../../app/api/ai/reports/capability/route.ts",
    "../../app/api/ai/reports/history/route.ts",
    "../../app/api/ai/reports/[jobId]/route.ts",
    "../../app/api/ai/reports/[jobId]/analysis/route.ts",
    "../../app/api/ai/reports/[jobId]/review/route.ts",
    "../../app/api/ai/settings/route.ts",
    "../../app/api/ai/settings/activate/route.ts",
    "../../app/api/ai/settings/disable/route.ts",
    "../../app/api/ai/settings/rotate/route.ts",
    "../../app/api/ai/settings/test/route.ts",
    "../../app/api/ai/worker/run/route.ts",
  ];
  for (const route of routes) {
    assert.equal(missing(route), true, route + " phai bi xoa");
  }
});

test("P1.7-H04: /dashboard xac thuc TRUOC khi doc du lieu reporting", () => {
  const page = source("../../app/dashboard/page.tsx");
  assert.match(page, /decideSessionPageAccess\(actor\)/);
  assert.match(page, /redirect\("\/login\?next=\/dashboard"\)/);
  // Thu tu bat buoc: guard phai xuat hien truoc fetch (P2-W04A renamed the fetcher).
  const guardAt = page.indexOf("decideSessionPageAccess(actor)");
  const fetchAt = page.indexOf("fetchCutoverReporting(params, actor.actor)");
  assert.ok(guardAt > 0 && fetchAt > guardAt, "guard phai chay truoc fetchCutoverReporting");
});

test("P1.7-H04: env status va .env.example khong con khai bao PILOT_ACCESS", () => {
  assert.equal(source("../../lib/env.ts").includes("PILOT_ACCESS"), false);
  // .env.example chi con nhac ten bien trong ghi chu "da bi xoa"; khong con dong khai bao nao.
  assert.equal(/^PILOT_ACCESS_[A-Z_]*=/m.test(source("../../../.env.example")), false,
    "khong con dong khai bao PILOT_ACCESS_*");
});

test("P1.7-H04: pipeline-check van khong fetch du lieu va chuyen ve dashboard", () => {
  const page = source("../../app/pipeline-check/page.tsx");
  assert.match(page, /redirect\("\/dashboard"\)/);
  assert.equal(/fetch\(|fetchReporting/.test(page), false, "khong fetch du lieu");
});
