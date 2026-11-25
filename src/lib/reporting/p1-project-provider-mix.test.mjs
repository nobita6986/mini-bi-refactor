import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildProjectProviderMix, computeReporting } from "./p1-reporting.ts";
import {
  buildProjectMixRows,
  mixMajorityLabel,
  PROJECT_MIX_TOP,
  UNKNOWN_SLOT,
  INVALID_SLOT,
} from "./p1-chart-data.ts";
import { paginateAll } from "./p1-reporting-pagination.ts";
import { THEMES, getTheme, resolveColor } from "../theme/theme-registry.ts";

const S = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

const PROVIDER_DISPLAY = {
  hrp: "HRP",
  vendor: "Vendor",
  __unknown__: "Không xác định",
  __invalid__: "Không hợp lệ",
};

function fact({ key, display, provider, count, source = S }) {
  return {
    source_id: source,
    business_date: "2026-10-01",
    project_key: key,
    project_display: display === undefined ? key : display,
    recruiter_key: "__unknown__",
    recruiter_display: "",
    provider_type_key: provider,
    provider_type_display: PROVIDER_DISPLAY[provider],
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: count,
  };
}

function source(id, isTest = false) {
  return {
    id,
    drive_file_id: "d_" + id,
    file_name: "F" + id,
    active: true,
    is_test: isTest,
    latest_run_status: "succeeded",
    last_successful_sync_at: "2026-10-01T00:00:00.000Z",
    last_seen_at: "2026-10-01T00:00:00.000Z",
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

test("1. nhiều dự án với tỷ lệ HRP/Vendor khác nhau", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", display: "Alpha", provider: "vendor", count: 8 }),
    fact({ key: "alpha", display: "Alpha", provider: "hrp", count: 2 }),
    fact({ key: "beta", display: "Beta", provider: "vendor", count: 3 }),
    fact({ key: "beta", display: "Beta", provider: "hrp", count: 7 }),
    fact({ key: "gamma", display: "Gamma", provider: "vendor", count: 5 }),
    fact({ key: "gamma", display: "Gamma", provider: "hrp", count: 5 }),
  ]);
  assert.equal(mix.length, 3);
  const alpha = mix.find((m) => m.projectKey === "alpha");
  assert.equal(alpha.projectTotal, 10);
  assert.equal(alpha.vendorCount, 8);
  assert.equal(alpha.hrpCount, 2);
  assert.equal(alpha.knownTotal, 10);
  assert.equal(alpha.vendorShare, 0.8);
  assert.equal(alpha.hrpShare, 0.2);
  assert.equal(alpha.knownCoverage, 1);
  // sort: vendor_share giảm dần => alpha (0.8) -> gamma (0.5) -> beta (0.3)
  assert.deepEqual(mix.map((m) => m.projectKey), ["alpha", "gamma", "beta"]);
});

test("2. dự án 100% Vendor", () => {
  const mix = buildProjectProviderMix([fact({ key: "alpha", provider: "vendor", count: 9 })]);
  assert.equal(mix[0].vendorShare, 1);
  assert.equal(mix[0].hrpShare, 0);
  assert.equal(mix[0].knownTotal, 9);
  assert.equal(mix[0].knownCoverage, 1);
  assert.equal(mixMajorityLabel(buildProjectMixRows(mix)[0]), "Vendor chiếm đa số");
});

test("3. dự án 100% HRP", () => {
  const mix = buildProjectProviderMix([fact({ key: "alpha", provider: "hrp", count: 4 })]);
  assert.equal(mix[0].hrpShare, 1);
  assert.equal(mix[0].vendorShare, 0);
  assert.equal(mixMajorityLabel(buildProjectMixRows(mix)[0]), "HRP chiếm đa số");
});

test("4. dự án chỉ có unknown/invalid -> share null, không NaN/Infinity", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", provider: "__unknown__", count: 3 }),
    fact({ key: "alpha", provider: "__invalid__", count: 2 }),
  ]);
  assert.equal(mix[0].knownTotal, 0);
  assert.equal(mix[0].vendorShare, null);
  assert.equal(mix[0].hrpShare, null);
  assert.equal(mix[0].projectTotal, 5);
  assert.equal(mix[0].unknownCount, 3);
  assert.equal(mix[0].invalidCount, 2);
  assert.ok(Number.isFinite(mix[0].knownCoverage));
  assert.equal(mix[0].knownCoverage, 0);
  assert.equal(mixMajorityLabel(buildProjectMixRows(mix)[0]), "Không đủ dữ liệu phân loại");
});

test("5. unknown/invalid không nằm trong mẫu số HRP/Vendor", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", provider: "vendor", count: 8 }),
    fact({ key: "alpha", provider: "hrp", count: 2 }),
    fact({ key: "alpha", provider: "__unknown__", count: 10 }),
    fact({ key: "alpha", provider: "__invalid__", count: 5 }),
  ]);
  assert.equal(mix[0].knownTotal, 10);
  assert.equal(mix[0].vendorShare, 0.8);
  assert.equal(mix[0].hrpShare, 0.2);
  assert.equal(mix[0].projectTotal, 25);
  assert.equal(mix[0].knownCoverage, 0.4);
});

test("6. projectTotal invariant theo từng dự án", () => {
  const rows = [
    fact({ key: "a", provider: "vendor", count: 4 }),
    fact({ key: "a", provider: "hrp", count: 3 }),
    fact({ key: "a", provider: "__unknown__", count: 2 }),
    fact({ key: "a", provider: "__invalid__", count: 1 }),
    fact({ key: "b", provider: "__unknown__", count: 7 }),
  ];
  for (const m of buildProjectProviderMix(rows)) {
    assert.equal(m.projectTotal, m.hrpCount + m.vendorCount + m.unknownCount + m.invalidCount, m.projectKey);
  }
});

test("7. tổng projectTotal = recruitedTotal (cùng filter)", () => {
  const facts = [
    fact({ key: "alpha", provider: "vendor", count: 8 }),
    fact({ key: "alpha", provider: "hrp", count: 2 }),
    fact({ key: "beta", provider: "vendor", count: 3 }),
    fact({ key: "beta", provider: "__unknown__", count: 4 }),
  ];
  const data = computeReporting([source(S)], facts, {}, new Set([S]));
  const sum = data.projectProviderMix.reduce((a, m) => a + m.projectTotal, 0);
  assert.equal(sum, data.recruitedTotal);
  assert.equal(sum, 17);
});

test("8. hrpShare + vendorShare = 1 khi knownTotal > 0", () => {
  const facts = [
    fact({ key: "a", provider: "vendor", count: 3 }),
    fact({ key: "a", provider: "hrp", count: 7 }),
    fact({ key: "b", provider: "vendor", count: 9 }),
  ];
  for (const m of buildProjectProviderMix(facts)) {
    if (m.knownTotal > 0) assert.ok(Math.abs(m.hrpShare + m.vendorShare - 1) < 1e-12, m.projectKey);
  }
});

test("9. group theo project_key; khác display/casing/whitespace không tách bucket", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", display: "Alpha", provider: "vendor", count: 3 }),
    fact({ key: "alpha", display: "ALPHA", provider: "vendor", count: 2 }),
    fact({ key: "alpha", display: "alpha ", provider: "vendor", count: 1 }),
  ]);
  assert.equal(mix.length, 1);
  assert.equal(mix[0].projectTotal, 6);
  assert.equal(mix[0].projectDisplay, "Alpha"); // selectDisplay: display nhiều người nhất
});

test("10. sort deterministic khi cùng tỷ lệ", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "beta", display: "Beta", provider: "vendor", count: 1 }),
    fact({ key: "beta", display: "Beta", provider: "hrp", count: 1 }),
    fact({ key: "alpha", display: "Alpha", provider: "vendor", count: 5 }),
    fact({ key: "alpha", display: "Alpha", provider: "hrp", count: 5 }),
    fact({ key: "gamma", display: "Gamma", provider: "vendor", count: 1 }),
    fact({ key: "gamma", display: "Gamma", provider: "hrp", count: 1 }),
  ]);
  assert.deepEqual(mix.map((m) => m.projectKey), ["alpha", "beta", "gamma"]);
  // lặp lại cho deterministic
  assert.deepEqual(buildProjectProviderMix([
    fact({ key: "gamma", display: "Gamma", provider: "hrp", count: 1 }),
    fact({ key: "alpha", display: "Alpha", provider: "hrp", count: 5 }),
    fact({ key: "beta", display: "Beta", provider: "hrp", count: 1 }),
    fact({ key: "alpha", display: "Alpha", provider: "vendor", count: 5 }),
    fact({ key: "beta", display: "Beta", provider: "vendor", count: 1 }),
    fact({ key: "gamma", display: "Gamma", provider: "vendor", count: 1 }),
  ]).map((m) => m.projectKey), ["alpha", "beta", "gamma"]);
});

test("11. project sentinel vẫn xuất hiện và đặt cuối danh sách", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", display: "Alpha", provider: "vendor", count: 5 }),
    fact({ key: "__unknown__", display: "Không xác định", provider: "vendor", count: 50 }),
    fact({ key: "__invalid__", display: "Không hợp lệ", provider: "hrp", count: 40 }),
  ]);
  assert.ok(mix.some((m) => m.projectKey === "__unknown__"));
  assert.ok(mix.some((m) => m.projectKey === "__invalid__"));
  // hai sentinel luôn nằm ở cuối danh sách (thứ tự nội bộ giữa chúng theo vendor_share)
  assert.equal(mix[0].projectKey, "alpha");
  assert.deepEqual(mix.slice(-2).map((m) => m.projectKey).sort(), ["__invalid__", "__unknown__"]);
  const rows = buildProjectMixRows(mix);
  assert.ok(rows.find((r) => r.key === "__unknown__").isSentinel);
  assert.ok(rows.find((r) => r.key === "__invalid__").isSentinel);
});

test("12. provider filter active -> mix phản ánh filter + UI có cảnh báo", () => {
  const facts = [
    fact({ key: "alpha", provider: "vendor", count: 8 }),
    fact({ key: "alpha", provider: "hrp", count: 2 }),
  ];
  const data = computeReporting([source(S)], facts, { provider: "vendor" }, new Set([S]));
  assert.equal(data.applied.provider, "vendor");
  assert.equal(data.projectProviderMix[0].vendorCount, 8);
  assert.equal(data.projectProviderMix[0].hrpCount, 0);
  assert.equal(data.projectProviderMix[0].vendorShare, 1);
  const src = readFileSync(new URL("../../components/dashboard/project-provider-mix.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("đang phản ánh bộ lọc HRP/Vendor hiện tại"), "notice text");
  assert.ok(src.includes("Bỏ bộ lọc HRP/Vendor để so sánh đầy đủ"), "notice action text");
});

test("13. Top 10 không làm mất full list", () => {
  const facts = [];
  for (let i = 0; i < 13; i++) facts.push(fact({ key: "p" + i, display: "D" + i, provider: "vendor", count: i + 1 }));
  const mix = buildProjectProviderMix(facts);
  const rows = buildProjectMixRows(mix);
  assert.equal(rows.length, 13);
  assert.equal(rows.slice(0, PROJECT_MIX_TOP).length, 10);
  assert.equal(rows.slice(PROJECT_MIX_TOP).length, 3);
  assert.equal(rows.reduce((a, r) => a + r.projectTotal, 0), mix.reduce((a, m) => a + m.projectTotal, 0));
});

test("14. 6 theme vẫn dùng semantic/chart tokens (light + dark)", () => {
  const mix = buildProjectProviderMix([
    fact({ key: "alpha", provider: "vendor", count: 6 }),
    fact({ key: "alpha", provider: "hrp", count: 4 }),
    fact({ key: "alpha", provider: "__unknown__", count: 1 }),
    fact({ key: "alpha", provider: "__invalid__", count: 1 }),
  ]);
  const row = buildProjectMixRows(mix)[0];
  assert.equal(row.segments.length, 4);
  assert.equal(row.segments[2].slot, UNKNOWN_SLOT);
  assert.equal(row.segments[3].slot, INVALID_SLOT);
  assert.notEqual(row.segments[0].slot, row.segments[1].slot, "HRP và Vendor phải khác slot");
  assert.equal(THEMES.length, 6);
  for (const mode of ["light", "dark"]) {
    for (const theme of THEMES) {
      for (const seg of row.segments) {
        assert.ok(HEX.test(resolveColor(seg.slot, getTheme(theme.id), mode)), theme.id + "/" + mode + "/" + seg.slot);
      }
    }
  }
  // segment percent cộng lại ~100 (của projectTotal)
  const pctSum = row.segments.reduce((a, s) => a + s.percent, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9, pctSum);
});

test("15. không PII và không regression pagination > 1.000 dòng", async () => {
  const many = [];
  for (let i = 0; i < 1200; i++) {
    many.push(fact({ key: "p" + (i % 13), display: "D" + (i % 13), provider: i % 2 ? "hrp" : "vendor", count: 1 }));
  }
  const paged = await paginateAll(async ([from, to]) => ({ rows: many.slice(from, to + 1), count: many.length, error: null }), { pageSize: 1000 });
  assert.ok(paged.ok, "pagination ok");
  assert.equal(paged.rows.length, 1200);
  const mix = buildProjectProviderMix(paged.rows);
  assert.equal(mix.reduce((a, m) => a + m.projectTotal, 0), 1200);
  assert.equal(mix.length, 13);
  const forbidden = ["ho_ten", "full_name", "candidate", "cccd", "sdt", "phone", "email", "raw", "ngay_sinh", "dia_chi"];
  for (const key of Object.keys(mix[0])) assert.ok(!forbidden.includes(key), key);
  const row = buildProjectMixRows(mix)[0];
  for (const key of Object.keys(row)) assert.ok(!forbidden.includes(key), key);
});

test("16. fixture is_test vẫn bị loại khỏi projectProviderMix", () => {
  const facts = [
    fact({ key: "alpha", provider: "vendor", count: 5, source: S }),
    fact({ key: "fixture", provider: "vendor", count: 99, source: S2 }),
  ];
  const data = computeReporting([source(S), source(S2, true)], facts, {}, new Set([S, S2]));
  assert.ok(!data.projectProviderMix.some((m) => m.projectKey === "fixture"));
  assert.equal(data.recruitedTotal, 5);
  assert.equal(data.projectProviderMix.reduce((a, m) => a + m.projectTotal, 0), 5);
});
