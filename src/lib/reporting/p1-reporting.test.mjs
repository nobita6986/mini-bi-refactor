import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { normalizeDimensionKey } from "../contracts/daily-recruitment-breakdown.ts";
import { parseReportingFilters, isRealCalendarDate } from "./p1-filter.ts";
import { computeReporting, matchesReportingFilters, reportingQueryFailed, buildReportingFactQuery, REPORTING_QUERY_FAILED_CODE } from "./p1-reporting.ts";

const dir = path.join(process.cwd(), "docs", "contracts", "fixtures", "p1-reporting");
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8"));

const PROVIDER_KEY = { HRP: "hrp", Vendor: "vendor", "Không xác định": "__unknown__", "Không hợp lệ": "__invalid__" };
const EMPLOYMENT_KEY = { "Thời vụ": "thời vụ", "Chính thức": "chính thức", "Không xác định": "__unknown__", "Không hợp lệ": "__invalid__" };
const freeKey = (display) => (display === "Không xác định" ? "__unknown__" : normalizeDimensionKey(display));

const sources = input.sources.map((s) => ({ ...s, last_seen_at: null }));
const facts = input.breakdown.map((b) => ({
  source_id: b.source_id,
  business_date: b.business_date,
  project_key: freeKey(b.project_display),
  project_display: b.project_display,
  recruiter_key: freeKey(b.recruiter_display),
  recruiter_display: b.recruiter_display,
  provider_type_key: PROVIDER_KEY[b.provider_type_display],
  provider_type_display: b.provider_type_display,
  employment_type_key: EMPLOYMENT_KEY[b.employment_type_display],
  employment_type_display: b.employment_type_display,
  recruited_count: b.recruited_count,
}));

const scopeIds = new Set(sources.filter((s) => s.active && !s.is_test).map((s) => s.id));

function run(params) {
  const parsed = parseReportingFilters(params, scopeIds);
  assert.equal(parsed.ok, true, "parse phải thành công: " + (parsed.ok ? "" : parsed.message));
  return computeReporting(sources, facts, parsed.filters);
}

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

const SRC = { id: "11111111-1111-4111-8111-111111111111", drive_file_id: "SYN", active: true, is_test: false, last_seen_at: null };

test("1. no filter = 18", () => {
  assert.equal(run({}).recruitedTotal, expected.cases.no_filter.recruited_total);
});

test("2. date range = 11", () => {
  const r = run({ from: "2026-10-02", to: "2026-10-03" });
  assert.equal(r.recruitedTotal, expected.cases.date_range.recruited_total);
  assert.deepEqual(r.byDate, expected.cases.date_range.by_date);
});

test("3. project + provider = 5", () => {
  assert.equal(run({ project: "Dự án A", provider: "hrp" }).recruitedTotal, expected.cases.project_provider.recruited_total);
});

test("4. recruiter + employment = 3", () => {
  assert.equal(run({ recruiter: "Nguyễn Văn A", employment: "chính thức" }).recruitedTotal, expected.cases.recruiter_employment.recruited_total);
});

test("5. unknown/invalid groups", () => {
  const e = expected.cases.unknown_invalid_groups;
  assert.equal(run({ provider: "__unknown__" }).recruitedTotal, e.provider_unknown);
  assert.equal(run({ provider: "__invalid__" }).recruitedTotal, e.provider_invalid);
  assert.equal(run({ employment: "__unknown__" }).recruitedTotal, e.employment_unknown);
  assert.equal(run({ employment: "__invalid__" }).recruitedTotal, e.employment_invalid);
  assert.equal(run({ project: "__unknown__" }).recruitedTotal, e.project_unknown);
  assert.equal(run({ recruiter: "__unknown__" }).recruitedTotal, e.recruiter_unknown);
});

test("6. fixture 200 người bị loại", () => {
  const r = run({});
  assert.equal(r.recruitedTotal, 18);
  assert.ok(!r.byProject["dự án fixture"]);
  assert.ok(!r.sources.some((s) => s.drive_file_id === "P0FIXTURE_DRIVE_FILE_A"));
  assert.equal(r.recruitedTotal + 200, 218);
});

test("7. coverage counts + ratio 0.75", () => {
  const r = run({});
  const e = expected.cases.coverage;
  assert.equal(r.coverage.expected, e.sources_expected);
  assert.equal(r.coverage.succeeded, e.sources_succeeded);
  assert.equal(r.coverage.partial, e.sources_partial);
  assert.equal(r.coverage.failed, e.sources_failed);
  assert.equal(r.coverage.neverSucceeded, e.sources_never_succeeded);
  assert.equal(r.coverage.coverageRatio, e.coverage_ratio);
});

test("8. breakdown totals khớp recruitedTotal", () => {
  const r = run({});
  const sum = (o) => Object.values(o).reduce((a, v) => a + (typeof v === "number" ? v : v.recruitedCount), 0);
  assert.equal(sum(r.byDate), r.recruitedTotal);
  assert.equal(sum(r.byProject), r.recruitedTotal);
  assert.equal(sum(r.byRecruiter), r.recruitedTotal);
  assert.equal(sum(r.byProvider), r.recruitedTotal);
  assert.equal(sum(r.byEmployment), r.recruitedTotal);
});

test("8b. breakdown buckets khớp expected.json (key + display + count)", () => {
  const r = run({});
  assert.deepEqual(r.byProject, expected.cases.no_filter.by_project);
  assert.deepEqual(r.byRecruiter, expected.cases.no_filter.by_recruiter);
  assert.deepEqual(r.byProvider, expected.cases.no_filter.by_provider);
  assert.deepEqual(r.byEmployment, expected.cases.no_filter.by_employment);
});

test("9. expected=0 => coverageRatio=null", () => {
  const r = computeReporting([], [], {});
  assert.equal(r.coverage.expected, 0);
  assert.equal(r.coverage.coverageRatio, null);
  assert.equal(r.empty.noSources, true);
  assert.equal(r.recruitedTotal, 0);
});

test("10. invalid calendar date", () => {
  assert.equal(parseReportingFilters({ from: "2026-02-30" }, scopeIds).ok, false);
  assert.equal(isRealCalendarDate("2026-02-30"), false);
  assert.equal(isRealCalendarDate("2026-02-28"), true);
});

test("11. from > to", () => {
  assert.equal(parseReportingFilters({ from: "2026-10-03", to: "2026-10-01" }, scopeIds).ok, false);
});

test("12. invalid provider/employment/source UUID", () => {
  assert.equal(parseReportingFilters({ provider: "nope" }, scopeIds).ok, false);
  assert.equal(parseReportingFilters({ employment: "nope" }, scopeIds).ok, false);
  assert.equal(parseReportingFilters({ source: "not-a-uuid" }, scopeIds).ok, false);
});

test("13. source UUID ngoài scope", () => {
  assert.equal(parseReportingFilters({ source: "99999999-9999-4999-8999-999999999999" }, scopeIds).ok, false);
});

test("14. DB error không trở thành dữ liệu 0", () => {
  const err = reportingQueryFailed();
  assert.equal(err.ok, false);
  assert.equal(err.code, REPORTING_QUERY_FAILED_CODE);
  assert.ok(err.message.length > 0);
  assert.ok(!("data" in err));
  const empty = computeReporting([], [], {});
  assert.equal(empty.empty.noSources, true);
});

test("15. casing/whitespace/NFC tương đương => một project bucket (group theo key)", () => {
  const fs = [
    fact(SRC.id, { project_key: "dự án a", project_display: "Dự án A", recruited_count: 2 }),
    fact(SRC.id, { project_key: "dự án a", project_display: "dự án a", recruited_count: 1 }),
    fact(SRC.id, { project_key: "dự án a", project_display: "DỰ ÁN A", recruited_count: 3 }),
  ];
  const r = computeReporting([SRC], fs, {});
  assert.equal(Object.keys(r.byProject).length, 1);
  assert.deepEqual(r.byProject["dự án a"], { key: "dự án a", display: "DỰ ÁN A", recruitedCount: 6 });
  assert.equal(r.byProject["dự án a"].recruitedCount, r.recruitedTotal);
});

test("16. recruiter khác casing nhưng cùng key => một bucket", () => {
  const fs = [
    fact(SRC.id, { recruiter_key: "nguyễn văn a", recruiter_display: "Nguyễn Văn A", recruited_count: 1 }),
    fact(SRC.id, { recruiter_key: "nguyễn văn a", recruiter_display: "NGUYỄN VĂN A", recruited_count: 2 }),
  ];
  const r = computeReporting([SRC], fs, {});
  assert.equal(Object.keys(r.byRecruiter).length, 1);
  assert.deepEqual(r.byRecruiter["nguyễn văn a"], { key: "nguyễn văn a", display: "NGUYỄN VĂN A", recruitedCount: 3 });
});

test("17. display hòa chọn ổn định bằng localeCompare(vi)", () => {
  const fs = [
    fact(SRC.id, { project_key: "x", project_display: "Beta", recruited_count: 2 }),
    fact(SRC.id, { project_key: "x", project_display: "Alpha", recruited_count: 2 }),
  ];
  const r = computeReporting([SRC], fs, {});
  assert.deepEqual(r.byProject["x"], { key: "x", display: "Alpha", recruitedCount: 4 });
});

test("18. sentinel display cố định", () => {
  const fs = [
    fact(SRC.id, { project_key: "__unknown__", project_display: "bất kỳ", recruited_count: 1 }),
    fact(SRC.id, { project_key: "__invalid__", project_display: "sai", recruited_count: 1 }),
  ];
  const r = computeReporting([SRC], fs, {});
  assert.equal(r.byProject["__unknown__"].display, "Không xác định");
  assert.equal(r.byProject["__invalid__"].display, "Không hợp lệ");
});

test("19. partial lần đầu có facts: contributes=true, everSucceeded=false, incomplete", () => {
  const src = { ...SRC, latest_run_status: "partial", last_successful_sync_at: null };
  const fs = [fact(src.id, { recruited_count: 5 })];
  const r = computeReporting([src], fs, {}, new Set([src.id]));
  assert.equal(r.recruitedTotal, 5);
  assert.equal(r.sources.length, 1);
  const s = r.sources[0];
  assert.equal(s.status, "incomplete");
  assert.equal(s.contributes, true);
  assert.equal(s.everSucceeded, false);
  assert.equal(s.hasCurrentFacts, true);
  assert.equal(r.coverage.neverSucceeded, 1);
  assert.equal(r.coverage.coverageRatio, 0);
});

test("20. latest running => status running (không stale/no_run)", () => {
  const src = { ...SRC, latest_run_status: "running", last_successful_sync_at: "2026-10-01T00:00:00Z" };
  const r = computeReporting([src], [], {}, new Set());
  assert.equal(r.sources[0].status, "running");
  assert.equal(r.sources[0].everSucceeded, true);
  assert.equal(r.sources[0].contributes, false);
});

test("21. failed + không facts => never_succeeded; failed + facts => stale_snapshot", () => {
  const noFacts = { ...SRC, latest_run_status: "failed", last_successful_sync_at: null };
  const withFacts = { ...SRC, id: "22222222-2222-4222-8222-222222222222", latest_run_status: "failed", last_successful_sync_at: null };
  const r = computeReporting([noFacts, withFacts], [fact(withFacts.id, { recruited_count: 2 })], {}, new Set([withFacts.id]));
  const byId = Object.fromEntries(r.sources.map((s) => [s.id, s]));
  assert.equal(byId[noFacts.id].status, "never_succeeded");
  assert.equal(byId[noFacts.id].hasCurrentFacts, false);
  assert.equal(byId[withFacts.id].status, "stale_snapshot");
  assert.equal(byId[withFacts.id].hasCurrentFacts, true);
});

test("22. source filter chỉ phản ánh coverage/status của source được chọn", () => {
  const sid = "00000000-0000-4000-8000-000000000002";
  const r = run({ source: sid });
  assert.equal(r.coverage.expected, 1);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].id, sid);
  assert.equal(r.sources[0].status, "incomplete");
  assert.equal(r.coverage.partial, 1);
});

test("23. dateExtent là extent của result sau filter", () => {
  assert.deepEqual(run({}).dateExtent, { min: "2026-10-01", max: "2026-10-03" });
  assert.deepEqual(run({ from: "2026-10-02", to: "2026-10-03" }).dateExtent, { min: "2026-10-02", max: "2026-10-03" });
});

test("24. buildReportingFactQuery: scope rỗng => skip, không query facts", () => {
  const plan = buildReportingFactQuery({}, new Set());
  assert.equal(plan.skip, true);
  assert.deepEqual(plan.query.scopeIds, []);
});

test("25. buildReportingFactQuery: filter được truyền xuống DB", () => {
  const ids = new Set(["a", "b"]);
  const plan = buildReportingFactQuery(
    { from: "2026-10-01", to: "2026-10-31", project: "dự án a", recruiter: "nguyễn văn a", provider: "hrp_ctv", collaborator: "CTV-01", employment: "thời vụ", source: "a" },
    ids
  );
  assert.equal(plan.skip, false);
  assert.deepEqual(plan.query.scopeIds, ["a", "b"]);
  assert.equal(plan.query.source, "a");
  assert.equal(plan.query.from, "2026-10-01");
  assert.equal(plan.query.to, "2026-10-31");
  assert.equal(plan.query.project, "dự án a");
  assert.equal(plan.query.recruiter, "nguyễn văn a");
  assert.equal(plan.query.provider, "hrp_ctv");
  assert.equal(plan.query.collaborator, "CTV-01");
  assert.equal(plan.query.employment, "thời vụ");
});

test("26. CTV channel filtering (hrp, hrp_direct, hrp_ctv, vendor) & collaborator filter", () => {
  for (const p of ["hrp", "hrp_direct", "hrp_ctv", "vendor", "__unknown__", "__invalid__"]) {
    assert.equal(parseReportingFilters({ provider: p }, scopeIds).ok, true, p);
  }
  assert.equal(parseReportingFilters({ collaborator: "CTV_01" }, scopeIds).ok, true);
  assert.equal(parseReportingFilters({ collaborator: "__system_vendor__" }, scopeIds).ok, false);
  assert.equal(parseReportingFilters({ collaborator: "bad space" }, scopeIds).ok, false);

  const fs = [
    fact(SRC.id, {
      recruiter_key: "nvtd a",
      recruiter_display: "NVTD A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      collaborator_id: null,
      collaborator_display: null,
      recruitment_channel: "hrp_direct",
      recruited_count: 6,
    }),
    fact(SRC.id, {
      recruiter_key: "nvtd a",
      recruiter_display: "NVTD A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      collaborator_id: "ctv-active",
      collaborator_display: "CTV Hoạt động",
      recruitment_channel: "hrp_ctv",
      recruited_count: 3,
    }),
    fact(SRC.id, {
      recruiter_key: "nvtd a",
      recruiter_display: "NVTD A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      collaborator_id: "ctv-inactive",
      collaborator_display: "CTV Ngừng hoạt động",
      recruitment_channel: "hrp_ctv",
      recruited_count: 1,
    }),
    fact(SRC.id, {
      recruiter_key: "vendor x",
      recruiter_display: "Vendor X",
      provider_type_key: "vendor",
      provider_type_display: "Vendor",
      collaborator_id: null,
      collaborator_display: null,
      recruitment_channel: "vendor",
      recruited_count: 5,
    }),
  ];

  // hrp includes both direct (6) + CTV (3 + 1) = 10, counted ONCE for NVTD A
  const hrpOnly = computeReporting([SRC], fs, { provider: "hrp" }, new Set([SRC.id]));
  assert.equal(hrpOnly.recruitedTotal, 10);
  assert.equal(hrpOnly.byRecruiter["nvtd a"].recruitedCount, 10);
  assert.equal(hrpOnly.byChannel.hrp_direct.recruitedCount, 6);
  assert.equal(hrpOnly.byChannel.hrp_ctv.recruitedCount, 4);
  assert.equal(hrpOnly.byCollaborator["ctv-active"].recruitedCount, 3);
  assert.equal(hrpOnly.byCollaborator["ctv-inactive"].recruitedCount, 1);

  // hrp_direct = 6
  const directOnly = computeReporting([SRC], fs, { provider: "hrp_direct" }, new Set([SRC.id]));
  assert.equal(directOnly.recruitedTotal, 6);

  // hrp_ctv = 4
  const ctvOnly = computeReporting([SRC], fs, { provider: "hrp_ctv" }, new Set([SRC.id]));
  assert.equal(ctvOnly.recruitedTotal, 4);

  // collaborator filter matches deactivated CTV too and combines with recruiter/project
  const collabOnly = computeReporting(
    [SRC],
    fs,
    { provider: "hrp", recruiter: "nvtd a", collaborator: "ctv-inactive" },
    new Set([SRC.id]),
  );
  assert.equal(collabOnly.recruitedTotal, 1);
  assert.equal(collabOnly.byCollaborator["ctv-inactive"].display, "CTV Ngừng hoạt động");
  assert.equal(matchesReportingFilters(fs[0], { collaborator: "ctv-inactive" }), false);
});
