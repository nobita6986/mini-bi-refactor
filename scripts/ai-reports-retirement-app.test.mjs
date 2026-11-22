/**
 * AI Reports Retirement — Application, Route, Shared-Guard, Env & Config Regression Suite.
 *
 * Verifies:
 *  1. All 12 /api/ai/** routes, AI UI panels, AI report/config libs, AI worker,
 *     and standalone AI acceptance scripts are removed (old endpoints 404 by router).
 *  2. Zero surviving production source files reference PILOT_ACTOR_REF, "pilot-admin",
 *     /api/ai/, x-ai-worker-token, process.env.AI_*, or AI DB RPCs/tables.
 *  3. Verified shared code (checkSameOriginRequest in http-guards.mjs, identity-shared.mjs,
 *     analytics/identity/contracts.ts, generic export validators in long-running-feedback.ts)
 *     remains clean, AI-free, and tested.
 *  4. Non-AI modules (BI reporting, Work Reports, Finance, Attendance, Recruitment)
 *     and CI/Dockerfile/.env.example/README stay coherent.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as httpGuards from "../src/lib/ai/gateway/http-guards.mjs";

const ROOT = process.cwd();
const abs = (rel) => path.join(ROOT, rel);
const readRel = (rel) => readFileSync(abs(rel), "utf8");

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

test("1. All /api/ai/** routes, AI UI panels, AI libs, worker, and AI scripts are deleted", () => {
  const mustBeDeleted = [
    "src/app/api/ai",
    "src/app/api/ai/reports/route.ts",
    "src/app/api/ai/reports/capability/route.ts",
    "src/app/api/ai/reports/history/route.ts",
    "src/app/api/ai/reports/[jobId]/route.ts",
    "src/app/api/ai/reports/[jobId]/analysis/route.ts",
    "src/app/api/ai/reports/[jobId]/review/route.ts",
    "src/app/api/ai/settings/route.ts",
    "src/app/api/ai/settings/activate/route.ts",
    "src/app/api/ai/settings/disable/route.ts",
    "src/app/api/ai/settings/rotate/route.ts",
    "src/app/api/ai/settings/test/route.ts",
    "src/app/api/ai/worker/run/route.ts",
    "src/components/ai-report",
    "src/components/dashboard/ai-settings-panel.tsx",
    "src/components/dashboard/ai-settings-panel-logic.ts",
    "src/lib/ai-report",
    "src/lib/ai-config",
    "src/lib/analytics/contracts",
    "src/lib/analytics/identity/projection.ts",
    "src/lib/analytics/identity/index.ts",
    "src/lib/ai/contracts.ts",
    "src/lib/ai/engine-shared.mjs",
    "src/lib/ai/feature-engine.ts",
    "src/lib/ai/packet-builder.mjs",
    "src/lib/ai/gateway/server",
    "src/lib/ai/gateway/testing",
    "src/lib/ai/gateway/live-adapter.mjs",
    "src/lib/ai/gateway/provider-config.mjs",
    "src/lib/ai/gateway/service-core.mjs",
    "scripts/g5-dev01-acceptance.mjs",
  ];
  for (const rel of mustBeDeleted) {
    assert.equal(existsSync(abs(rel)), false, `${rel} must be removed`);
  }

  // Only the verified shared http-guards.mjs remains under src/lib/ai
  const survivingAiFiles = walkFiles(abs("src/lib/ai"))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(survivingAiFiles, ["src/lib/ai/gateway/http-guards.mjs"]);
});

test("2. Zero surviving production files under src/ reference PILOT_ACTOR_REF, /api/ai/, AI env reads, or AI DB RPCs/tables", () => {
  const srcFiles = walkFiles(abs("src")).filter((f) => !f.endsWith(".test.mjs") && !f.endsWith(".test.ts"));
  assert.ok(srcFiles.length > 100, "sanity check: scanned production src/ tree");

  for (const full of srcFiles) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const content = readFileSync(full, "utf8");

    assert.equal(content.includes("PILOT_ACTOR_REF"), false, `${rel} must not mention PILOT_ACTOR_REF`);
    assert.equal(content.includes("pilot-admin"), false, `${rel} must not mention pilot-admin`);
    assert.equal(content.includes("/api/ai/"), false, `${rel} must not call /api/ai/`);
    assert.equal(content.includes("x-ai-worker-token"), false, `${rel} must not mention x-ai-worker-token`);
    assert.equal(/process\.env\.AI_[A-Z0-9_]+/.test(content), false, `${rel} must not read process.env.AI_*`);
    assert.equal(/\.rpc\(\s*["'](?:ai_report_|ai_provider_config_)/.test(content), false, `${rel} must not call AI RPCs`);
    assert.equal(/\.from\(\s*["'](?:ai_report_|ai_provider_config_)/.test(content), false, `${rel} must not query AI tables`);
    assert.equal(/from\s+["'](?:@\/|\.\.?\/).*?(?:ai-report|ai-config)/.test(content), false, `${rel} must not import removed ai-report/ai-config`);

    // Any import touching /ai/ must be strictly the shared checkSameOriginRequest module
    const aiImports = [...content.matchAll(/from\s+["']([^"']*\/ai\/[^"']*)["']/g)].map((m) => m[1]);
    for (const spec of aiImports) {
      assert.ok(
        spec.endsWith("/ai/gateway/http-guards.mjs"),
        `${rel} has unexpected AI import: ${spec}`,
      );
    }
  }
});

test("3. Retained shared http-guards.mjs exports only checkSameOriginRequest and enforces CSRF/same-origin", () => {
  assert.deepEqual(Object.keys(httpGuards).sort(), ["checkSameOriginRequest"]);
  const { checkSameOriginRequest } = httpGuards;

  assert.deepEqual(
    checkSameOriginRequest({ origin: "https://bi.hrpartner.vn", host: "bi.hrpartner.vn", secFetchSite: "same-origin" }),
    { ok: true },
  );
  assert.equal(
    checkSameOriginRequest({ origin: "https://evil.example.vn", host: "bi.hrpartner.vn" }).ok,
    false,
  );
  assert.equal(
    checkSameOriginRequest({ origin: null, host: "bi.hrpartner.vn" }).ok,
    false,
  );
  assert.equal(
    checkSameOriginRequest({ origin: "https://bi.hrpartner.vn", host: "" }).ok,
    false,
  );
  assert.equal(
    checkSameOriginRequest({ origin: "https://bi.hrpartner.vn", host: "bi.hrpartner.vn", secFetchSite: "cross-site" }).ok,
    false,
  );
  assert.equal(
    checkSameOriginRequest({ origin: "not-a-valid-url", host: "bi.hrpartner.vn" }).ok,
    false,
  );
});

test("4. CI workflow, Dockerfile, .env.example, and README no longer wire AI runtime flags or active endpoints", () => {
  assert.equal(readRel(".github/workflows/ci.yml").includes("AI_REPORTS_ENABLED"), false);
  assert.equal(readRel("Dockerfile").includes("AI_REPORTS_ENABLED"), false);
  assert.equal(/^AI_[A-Z0-9_]+=/m.test(readRel(".env.example")), false, ".env.example must not declare AI_* runtime env vars");
  assert.equal(readRel("README.md").includes("checkWorkerToken"), false);
});

test("5. Non-AI core modules and retained shared dependencies remain intact", () => {
  const mustRemain = [
    "src/app/dashboard/page.tsx",
    "src/app/dashboard/layout.tsx",
    "src/lib/reporting/p1-reporting.ts",
    "src/lib/work-reports/submission-api.ts",
    "src/lib/vendor-finance/vendor-finance-contract.ts",
    "src/lib/attendance/attendance-config.ts",
    "src/lib/analytics/identity/identity-shared.mjs",
    "src/lib/analytics/identity/contracts.ts",
    "src/lib/ui/long-running-feedback.ts",
    "src/lib/ai/gateway/http-guards.mjs",
  ];
  for (const rel of mustRemain) {
    assert.equal(existsSync(abs(rel)), true, `${rel} must be preserved`);
  }
});
