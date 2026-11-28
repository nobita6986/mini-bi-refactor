import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReportingFilters } from "./p1-filter.ts";
import {
  buildDailyTrend,
  buildSourceOptions,
  PROVIDER_OPTIONS,
  sortBuckets,
  sourceStatusLabel,
  topBuckets,
} from "./p1-dashboard.ts";
import { paginateAll } from "./p1-reporting-pagination.ts";
import { buildDimensionOptions, computeReporting, reportingQueryFailed, selectDisplay } from "./p1-reporting.ts";

function fact(source_id, overrides = {}) {
  return {
    source_id,
    business_date: "2026-10-01",
    project_key: "dự án a",
    project_display: "Dự án A",
    recruiter_key: "nguyễn văn a",
    recruiter_display: "Nguyễn Văn A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    ...overrides,
  };
}

const SRC = { id: "11111111-1111-4111-8111-111111111111", drive_file_id: "SYN", file_name: "Syn.xlsx", active: true, is_test: false, latest_run_status: "succeeded", last_successful_sync_at: "2026-10-01T00:00:00Z", last_seen_at: null };

function arrayLoader(allRows, opts = {}) {
  const calls = [];
  const failAt = opts.failAt ?? null;
  const loader = async ([from, to]) => {
    calls.push([from, to]);
    if (calls.length - 1 === failAt) return { rows: [], count: null, error: { code: "X", message: "boom" } };
    return { rows: allRows.slice(from, to + 1), count: allRows.length };
  };
  return { loader, calls };
}

test("1. zero-fill daily trend", () => {
  const t = buildDailyTrend({ "2026-10-01": 1, "2026-10-03": 3 }, "2026-10-01", "2026-10-04");
  assert.deepEqual(t, [
    { date: "2026-10-01", count: 1 },
    { date: "2026-10-02", count: 0 },
    { date: "2026-10-03", count: 3 },
    { date: "2026-10-04", count: 0 },
  ]);
});

test("2. sum trend = recruitedTotal", () => {
  const byDate = { "2026-10-01": 5, "2026-10-03": 7 };
  const t = buildDailyTrend(byDate, "2026-10-01", "2026-10-03");
  assert.equal(t.reduce((a, p) => a + p.count, 0), 12);
  assert.equal(t.find((p) => p.date === "2026-10-02").count, 0);
});

test("3. sort breakdown deterministic (desc, tie localeCompare vi)", () => {
  const buckets = {
    a: { key: "a", display: "B", recruitedCount: 5 },
    b: { key: "b", display: "A", recruitedCount: 5 },
    c: { key: "c", display: "C", recruitedCount: 9 },
  };
  assert.deepEqual(sortBuckets(buckets).map((x) => x.key), ["c", "b", "a"]);
});

test("4. sum mỗi breakdown = recruitedTotal", () => {
  const fs = [
    fact(SRC.id, { project_key: "p1", project_display: "P1", recruiter_key: "r1", recruiter_display: "R1", recruited_count: 3 }),
    fact(SRC.id, { project_key: "p2", project_display: "P2", recruiter_key: "r2", recruiter_display: "R2", recruited_count: 5 }),
    fact(SRC.id, { project_key: "p2", project_display: "P2", recruiter_key: "r1", recruiter_display: "R1", recruited_count: 2 }),
  ];
  const r = computeReporting([SRC], fs, {}, new Set([SRC.id]));
  const sum = (o) => Object.values(o).reduce((a, b) => a + b.recruitedCount, 0);
  assert.equal(r.recruitedTotal, 10);
  assert.equal(sum(r.byProject), 10);
  assert.equal(sum(r.byRecruiter), 10);
  assert.equal(sum(r.byProvider), 10);
  assert.equal(sum(r.byEmployment), 10);
});

test("5. top 10 không làm mất full list", () => {
  const buckets = {};
  for (let i = 0; i < 15; i++) buckets["k" + i] = { key: "k" + i, display: "D" + i, recruitedCount: i + 1 };
  assert.equal(topBuckets(buckets, 10).length, 10);
  assert.equal(sortBuckets(buckets).length, 15);
});

test("6. sentinel label cố định trong options + selectDisplay", () => {
  const o = buildDimensionOptions([
    { dimension: "project", key: "__unknown__", display: "x", recruited_count: 1 },
    { dimension: "project", key: "__invalid__", display: "y", recruited_count: 1 },
  ]);
  assert.equal(o.projects.find((p) => p.key === "__unknown__").display, "Không xác định");
  assert.equal(o.projects.find((p) => p.key === "__invalid__").display, "Không hợp lệ");
  assert.equal(selectDisplay("__unknown__", new Map([["zzz", 5]])), "Không xác định");
});

test("7. dimension options không phụ thuộc result đã filter", () => {
  // Catalog được build từ view scope (không áp filter kết quả); builder giữ mọi key đưa vào.
  const o = buildDimensionOptions([
    { dimension: "project", key: "p1", display: "P1", recruited_count: 10 },
    { dimension: "project", key: "p2", display: "P2", recruited_count: 5 },
  ]);
  assert.deepEqual(o.projects.map((p) => p.key), ["p1", "p2"]);
});

test("8. source option dùng file_name, sort tiếng Việt", () => {
  assert.deepEqual(buildSourceOptions([
    { id: "1", file_name: "Report B.xlsx" },
    { id: "2", file_name: "Report A.xlsx" },
  ]), [
    { id: "2", fileName: "Report A.xlsx" },
    { id: "1", fileName: "Report B.xlsx" },
  ]);
});

test("9. invalid query => error, không fallback All", () => {
  const ids = new Set(["11111111-1111-4111-8111-111111111111"]);
  assert.equal(parseReportingFilters({ from: "2026-02-30" }, ids).ok, false);
  assert.equal(parseReportingFilters({ provider: "nope" }, ids).ok, false);
  assert.equal(parseReportingFilters({ source: "99999999-9999-4999-8999-999999999999" }, ids).ok, false);
});

test("10. empty: no-source vs no-fact khác nhau", () => {
  const noSource = computeReporting([], [], {});
  assert.equal(noSource.empty.noSources, true);
  assert.equal(noSource.empty.noFacts, false);
  const noFact = computeReporting([SRC], [], {}, new Set());
  assert.equal(noFact.empty.noSources, false);
  assert.equal(noFact.empty.noFacts, true);
});

test("11. partial/stale/running/no-run label đúng", () => {
  assert.equal(sourceStatusLabel("covered"), "Đã đồng bộ");
  assert.equal(sourceStatusLabel("incomplete"), "Chưa đầy đủ");
  assert.equal(sourceStatusLabel("stale_snapshot"), "Đang dùng snapshot cũ");
  assert.equal(sourceStatusLabel("never_succeeded"), "Chưa có snapshot thành công");
  assert.equal(sourceStatusLabel("running"), "Đang đồng bộ");
  assert.equal(sourceStatusLabel("no_run"), "Chưa chạy");
});

test("12. fixture is_test không xuất hiện", () => {
  const fixture = { ...SRC, id: "22222222-2222-4222-8222-222222222222", drive_file_id: "P0FIXTURE_DRIVE_FILE_A", file_name: "Fixture.xlsx", is_test: true };
  const fs = [
    fact(SRC.id, { project_key: "dự án a", project_display: "Dự án A", recruited_count: 2 }),
    fact(fixture.id, { project_key: "dự án fixture", project_display: "Dự án Fixture", recruited_count: 200 }),
  ];
  const r = computeReporting([SRC, fixture], fs, {}, new Set([SRC.id]));
  assert.equal(r.recruitedTotal, 2);
  assert.ok(!r.byProject["dự án fixture"]);
  assert.ok(!r.sources.some((s) => s.drive_file_id === "P0FIXTURE_DRIVE_FILE_A"));
});

test("14. option build với >1000 row không truncate (pagination)", async () => {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push({ dimension: "project", key: "k" + i, display: "D" + i, recruited_count: 1 });
  const { loader, calls } = arrayLoader(rows);
  const r = await paginateAll(loader);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1500);
  assert.equal(calls.length, 2);
  assert.equal(buildDimensionOptions(r.rows).projects.length, 1500);
});

test("15. không có candidate PII trong bucket/option (chỉ key/display/count)", () => {
  const bucket = { key: "dự án a", display: "Dự án A", recruitedCount: 7 };
  assert.deepEqual(Object.keys(bucket).sort(), ["display", "key", "recruitedCount"]);
  const opt = { key: "dự án a", display: "Dự án A" };
  assert.deepEqual(Object.keys(opt).sort(), ["display", "key"]);
  const src = { id: "1", fileName: "Report.xlsx" };
  assert.deepEqual(Object.keys(src).sort(), ["fileName", "id"]);
  const forbidden = ["ho_ten", "full_name", "candidate", "cccd", "sdt", "phone", "email", "raw"];
  for (const k of Object.keys({ ...bucket, ...opt, ...src })) assert.ok(!forbidden.includes(k));
});

test("16. empty: scope rỗng => noSources", () => {
  const r = computeReporting([], [], {}, new Set());
  assert.equal(r.empty.noSources, true);
  assert.equal(r.empty.noFacts, false);
  assert.equal(r.empty.noMatches, false);
});

test("17. empty: có source nhưng presence rỗng => noFacts", () => {
  const r = computeReporting([SRC], [], {}, new Set());
  assert.equal(r.empty.noSources, false);
  assert.equal(r.empty.noFacts, true);
  assert.equal(r.empty.noMatches, false);
});

test("18. empty: có facts nhưng dimension filter không khớp => noMatches", () => {
  const facts = [fact(SRC.id, { project_key: "p1", project_display: "P1" })];
  const r = computeReporting([SRC], facts, { project: "nonexistent" }, new Set([SRC.id]));
  assert.equal(r.empty.noSources, false);
  assert.equal(r.empty.noFacts, false);
  assert.equal(r.empty.noMatches, true);
});

test("19. empty: date range không khớp => noMatches", () => {
  const facts = [fact(SRC.id, { business_date: "2026-10-01" })];
  const r = computeReporting([SRC], facts, { from: "2026-11-01", to: "2026-11-30" }, new Set([SRC.id]));
  assert.equal(r.empty.noMatches, true);
  assert.equal(r.empty.noFacts, false);
});

test("20. empty: source được chọn chưa có facts => noFacts", () => {
  const srcB = { ...SRC, id: "22222222-2222-4222-8222-222222222222", file_name: "B.xlsx" };
  const facts = [fact(SRC.id)];
  const r = computeReporting([SRC, srcB], facts, { source: srcB.id }, new Set([SRC.id]));
  assert.equal(r.empty.noFacts, true);
  assert.equal(r.empty.noMatches, false);
});

test("21. empty: source có facts nhưng dimension filter không khớp => noMatches", () => {
  const facts = [fact(SRC.id, { project_key: "p1", project_display: "P1" })];
  const r = computeReporting([SRC], facts, { source: SRC.id, project: "nonexistent" }, new Set([SRC.id]));
  assert.equal(r.empty.noFacts, false);
  assert.equal(r.empty.noMatches, true);
});

test("16b. grain row recruited_count=2 vẫn hợp lệ (SUM count, không phải row count)", () => {
  // Một grain row chứa recruited_count=2 (hai người cùng grain đã được gộp).
  const r = computeReporting([SRC], [fact(SRC.id, { recruited_count: 2 })], {}, new Set([SRC.id]));
  assert.equal(r.recruitedTotal, 2); // = SUM(recruited_count), KHÔNG phải số dòng grain (1)
});

test("22. options query failure không thành empty catalog (ok:false, không có options)", () => {
  const err = reportingQueryFailed();
  assert.equal(err.ok, false);
  assert.ok(!("options" in err));
  assert.ok(!("data" in err));
  const healthyEmpty = { ok: true, options: { dimensions: { projects: [], recruiters: [], providers: [], employments: [], collaborators: [] }, sources: [] } };
  assert.notDeepEqual(err, healthyEmpty);
  assert.equal(healthyEmpty.ok, true);
});

test("23. PROVIDER_OPTIONS and buildDimensionOptions support CTV channel & collaborators", () => {
  assert.deepEqual(
    PROVIDER_OPTIONS.map((o) => [o.key, o.display]),
    [
      ["hrp", "Tổng tuyển của NVTD"],
      ["hrp_direct", "HRP trực tiếp"],
      ["hrp_ctv", "Qua CTV"],
      ["vendor", "Vendor"],
      ["__unknown__", "Không xác định"],
      ["__invalid__", "Không hợp lệ"],
    ],
  );
  const dims = buildDimensionOptions([
    { dimension: "collaborator", key: "ctv-b", display: "CTV B", recruited_count: 2 },
    { dimension: "collaborator", key: "ctv-a", display: "CTV A (Đã ngừng)", recruited_count: 1 },
  ]);
  assert.deepEqual(dims.collaborators, [
    { key: "ctv-a", display: "CTV A (Đã ngừng)" },
    { key: "ctv-b", display: "CTV B" },
  ]);
});
