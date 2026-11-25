import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  DEFAULT_THEME_ID,
  THEMES,
  SEMANTIC_COLORS,
  THEME_STORAGE_KEY,
  getTheme,
  isValidThemeId,
  resolveColor,
  resolveThemeId,
  slotToCssVar,
  tokensToCssVars,
  buildThemeInitScript,
} from "./theme-registry.ts";

import {
  buildCategorySegments,
  buildProjectDonutData,
  stableColorForKey,
  STATUS_COLORS,
} from "../reporting/p1-chart-data.ts";

const TOKEN_KEYS = ["bg", "fg", "surface", "muted", "border", "primary", "secondary", "accent", "ring", "tooltip", "onPrimary"];

test("F1. registry có đúng 6 theme và ID không trùng", () => {
  assert.equal(THEMES.length, 6);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, 6);
  const ids = THEMES.map((t) => t.id);
  assert.deepEqual(ids, ["hr-partner", "royal-navy", "ocean-trust", "emerald-growth", "violet-future", "executive-gold"]);
});

test("F1b. mỗi theme có đủ light+dark token và 8 chart seed", () => {
  for (const t of THEMES) {
    for (const k of TOKEN_KEYS) {
      assert.ok(t.light[k], t.id + " light thiếu " + k);
      assert.ok(t.dark[k], t.id + " dark thiếu " + k);
    }
    assert.equal(t.light.chart.length, 8);
    assert.equal(t.dark.chart.length, 8);
    assert.notEqual(t.light.bg, t.dark.bg, t.id + " dark bg phải khác light");
    assert.notEqual(t.light.primary, t.dark.primary, t.id + " dark primary phải khác light");
  }
});

test("F2. hr-partner là default", () => {
  assert.equal(DEFAULT_THEME_ID, "hr-partner");
  assert.equal(getTheme("hr-partner").id, "hr-partner");
  assert.equal(getTheme("hr-partner").name, "HR Partner");
});

test("F3. giá trị persist sai fallback về hr-partner", () => {
  assert.equal(resolveThemeId(null), "hr-partner");
  assert.equal(resolveThemeId(undefined), "hr-partner");
  assert.equal(resolveThemeId(""), "hr-partner");
  assert.equal(resolveThemeId("bogus"), "hr-partner");
  assert.equal(resolveThemeId("hr-partner "), "hr-partner"); // whitespace không hợp lệ
  assert.equal(isValidThemeId("bogus"), false);
  assert.equal(isValidThemeId("ocean-trust"), true);
});

test("F4. persist dùng storage key ổn định + validate qua resolveThemeId", () => {
  assert.equal(THEME_STORAGE_KEY, "mini-bi-theme");
  // mô phỏng localStorage: giá trị hợp lệ giữ nguyên, giá trị rác fallback
  assert.equal(resolveThemeId("violet-future"), "violet-future");
  assert.equal(resolveThemeId("EXECUTIVE-GOLD"), "hr-partner");
});

test("F5. chart-data không giữ hex category cố định ngoài registry", () => {
  const src = readFileSync(new URL("../reporting/p1-chart-data.ts", import.meta.url), "utf8");
  const oldPalette = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#14b8a6", "#f97316", "#ec4899", "#84cc16", "#22d3ee"];
  for (const hex of oldPalette) {
    assert.ok(!src.includes(hex), "p1-chart-data vẫn hardcode category hex " + hex);
  }
});

test("F6. stable key map deterministic vào cùng chart slot", () => {
  const slot = stableColorForKey("dự án alpha");
  assert.match(slot, /^chart-[1-8]$/);
  assert.equal(stableColorForKey("dự án alpha"), slot);
  assert.equal(stableColorForKey("dự án alpha"), stableColorForKey("dự án alpha"));
});

test("F7. unknown/invalid/other/status giữ semantic color đúng", () => {
  assert.equal(stableColorForKey("__unknown__"), "warning");
  assert.equal(stableColorForKey("__invalid__"), "error");
  assert.equal(STATUS_COLORS.succeeded, "success");
  assert.equal(STATUS_COLORS.partial, "warning");
  assert.equal(STATUS_COLORS.failed, "error");
  assert.equal(STATUS_COLORS.running, "running");
  assert.equal(STATUS_COLORS.noRun, "slate");
  // semantic độc lập theme
  assert.equal(resolveColor("error", getTheme("hr-partner"), "light"), resolveColor("error", getTheme("violet-future"), "light"));
  assert.equal(resolveColor("success", getTheme("hr-partner"), "light"), SEMANTIC_COLORS.success.light);
  assert.equal(resolveColor("warning", getTheme("ocean-trust"), "dark"), SEMANTIC_COLORS.warning.dark);
});

test("F8. đổi theme chỉ đổi màu, không đổi value/chart data", () => {
  const buckets = { "dự án a": { key: "dự án a", display: "Dự án A", recruitedCount: 7 } };
  const seg = buildCategorySegments(buckets)[0];
  assert.equal(seg.value, 7);
  const slot = seg.color;
  const hexA = resolveColor(slot, getTheme("hr-partner"), "light");
  const hexB = resolveColor(slot, getTheme("violet-future"), "light");
  assert.notEqual(hexA, hexB);
  // dữ liệu (key/display/value/percent) không đổi theo theme
  const again = buildCategorySegments(buckets)[0];
  assert.equal(again.value, seg.value);
  assert.equal(again.key, seg.key);
  assert.equal(again.percent, seg.percent);
  assert.equal(again.color, seg.color);
});

test("resolveColor: chart slot -> seed đúng, semantic -> cố định", () => {
  assert.equal(resolveColor("chart-1", getTheme("hr-partner"), "light"), "#C2410C");
  assert.equal(resolveColor("chart-1", getTheme("royal-navy"), "light"), "#3745A5");
  assert.equal(resolveColor("chart-1", getTheme("hr-partner"), "dark"), getTheme("hr-partner").dark.chart[0]);
  assert.equal(resolveColor("chart-8", getTheme("executive-gold"), "light"), "#64748B");
});

test("slotToCssVar + tokensToCssVars + buildThemeInitScript", () => {
  assert.equal(slotToCssVar("chart-1"), "var(--chart-1)");
  assert.equal(slotToCssVar("success"), "var(--semantic-success)");
  assert.equal(slotToCssVar("slate"), "var(--semantic-slate)");
  const vars = tokensToCssVars(getTheme("hr-partner"), "light");
  for (const n of ["--background", "--foreground", "--surface", "--muted", "--border", "--primary", "--secondary", "--accent", "--ring", "--tooltip", "--on-primary", "--chart-1", "--chart-8", "--semantic-success", "--semantic-error", "--semantic-slate"]) {
    assert.ok(vars[n], "thiếu " + n);
  }
  const script = buildThemeInitScript();
  assert.ok(script.includes("mini-bi-theme"));
  assert.ok(script.includes("hr-partner"));
  assert.ok(script.includes("data-theme"));
  assert.ok(!script.includes("password") && !script.includes("secret") && !script.includes("token"));
});

test("buildProjectDonutData vẫn gộp 'Khác' với slot slate, không đổi tổng", () => {
  const list = [];
  for (let i = 0; i < 12; i++) list.push(["k" + i, "D" + i, i + 1]);
  const buckets = {};
  for (const [k, d, c] of list) buckets[k] = { key: k, display: d, recruitedCount: c };
  const slices = buildProjectDonutData(buckets);
  assert.equal(slices.reduce((x, s) => x + s.value, 0), 78);
  assert.equal(slices.find((s) => s.key === "__other__").color, "slate");
});
