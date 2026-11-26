import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  ALL_RECRUITERS_TEAM_FILTER,
  buildDetailedMatrixTeamDropdownOptions,
  buildDetailedRecruitmentMatrix,
  clampDetailedMatrixZoom,
  computeCompletedWorkMonths,
  computeDetailedMatrixZoomMetrics,
  DETAILED_MATRIX_FIXED_CELL_PAD_X_PX,
  DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX,
  DETAILED_MATRIX_FIXED_FONT_SIZE_PX,
  DETAILED_MATRIX_FIXED_NAME_PAD_X_PX,
  DETAILED_MATRIX_NAME_COL_WIDTH_PX,
  DETAILED_MATRIX_STT_COL_WIDTH_PX,
  formatPersonnelCodeCell,
  formatWorkMonthsCell,
  isMarketingHrpTeamOption,
  parseMatrixResolutionParam,
  sortDetailedMatrixTeamOptions,
} from "./detailed-recruitment-matrix.ts";
import {
  fetchDetailedRecruitmentMatrixReport,
  parseDetailedMatrixCatalogPayload,
} from "./detailed-recruitment-matrix-server.ts";
import { buildTrendByResolution } from "./p1-dashboard-period.ts";
import { computeReporting } from "./p1-reporting.ts";
import { P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

test("Detailed Matrix (1): computeCompletedWorkMonths, formatWorkMonthsCell, and formatPersonnelCodeCell handle month-end, leap years, missing dates, and future dates", () => {
  // Missing or invalid dates -> null -> "-"
  assert.equal(computeCompletedWorkMonths(null, "2026-10-31"), null);
  assert.equal(computeCompletedWorkMonths("", "2026-10-31"), null);
  assert.equal(computeCompletedWorkMonths("2026-01-15", null), null);
  assert.equal(computeCompletedWorkMonths("2026-02-30", "2026-10-31"), null);
  assert.equal(formatWorkMonthsCell(null), "-");
  assert.equal(formatWorkMonthsCell(undefined), "-");

  // work_start_date > asOfDate -> null -> "-" (never 0 or negative)
  assert.equal(computeCompletedWorkMonths("2026-11-01", "2026-10-31"), null);
  assert.equal(
    formatWorkMonthsCell(computeCompletedWorkMonths("2026-11-01", "2026-10-31")),
    "-",
  );

  // Same day or within first incomplete month -> 0 completed months -> "0"
  assert.equal(computeCompletedWorkMonths("2026-10-01", "2026-10-01"), 0);
  assert.equal(computeCompletedWorkMonths("2026-10-15", "2026-10-31"), 0);
  assert.equal(formatWorkMonthsCell(0), "0");

  // Exact anniversary day -> completed months
  assert.equal(computeCompletedWorkMonths("2026-01-15", "2026-02-14"), 0);
  assert.equal(computeCompletedWorkMonths("2026-01-15", "2026-02-15"), 1);
  assert.equal(computeCompletedWorkMonths("2025-04-10", "2026-10-10"), 18);
  assert.equal(computeCompletedWorkMonths("2025-04-10", "2026-10-09"), 17);

  // End-of-month clamping & leap year handling:
  // 2024 is a leap year (Feb has 29 days)
  assert.equal(computeCompletedWorkMonths("2024-01-31", "2024-02-28"), 0);
  assert.equal(computeCompletedWorkMonths("2024-01-31", "2024-02-29"), 1);
  // 2025 is a non-leap year (Feb has 28 days)
  assert.equal(computeCompletedWorkMonths("2025-01-31", "2025-02-27"), 0);
  assert.equal(computeCompletedWorkMonths("2025-01-31", "2025-02-28"), 1);
  // Leap-day start (2024-02-29) to non-leap-year Feb-end (2025-02-28) = 12 completed months
  assert.equal(computeCompletedWorkMonths("2024-02-29", "2025-02-27"), 11);
  assert.equal(computeCompletedWorkMonths("2024-02-29", "2025-02-28"), 12);

  // Personnel code formatting: never infer or fabricate from name
  assert.equal(formatPersonnelCodeCell("NV001"), "NV001");
  assert.equal(formatPersonnelCodeCell("  NV-102 "), "NV-102");
  assert.equal(formatPersonnelCodeCell(null), "-");
  assert.equal(formatPersonnelCodeCell(""), "-");
  assert.equal(formatPersonnelCodeCell("   "), "-");
});

test("Detailed Matrix (2): Day / Week / Month buckets, mid-week & mid-month clipping, leap-year February, and 100% parity with Dashboard totals", () => {
  const catalog = {
    teams: [
      { teamId: "team-a", teamCode: "TEAM_A", displayName: "Nhóm Alpha" },
      { teamId: "team-b", teamCode: "TEAM_B", displayName: "Nhóm Beta" },
    ],
    recruiters: [
      {
        recruiterId: "rec-1",
        recruiterKey: "nguyễn văn a",
        displayName: "Nguyễn Văn A",
        personnelCode: "NV001",
        active: true,
        isActiveHrp: true,
        currentTeamIds: ["team-a"],
        workStartDate: "2023-08-15",
      },
      {
        recruiterId: "rec-2",
        recruiterKey: "trần thị b",
        displayName: "Trần Thị B",
        personnelCode: null,
        active: true,
        isActiveHrp: true,
        currentTeamIds: ["team-a"],
        workStartDate: null,
      },
      {
        recruiterId: "rec-3",
        recruiterKey: "lê văn c",
        displayName: "Lê Văn C",
        personnelCode: "NV003",
        active: true,
        isActiveHrp: true,
        currentTeamIds: ["team-b"],
        workStartDate: "2024-01-31",
      },
    ],
  };

  // Leap year Feb-Mar 2024 range: mid-week & mid-month filter [2024-02-28 .. 2024-03-06]
  // 2024-02-28 is Wednesday, 2024-02-29 is Thursday (leap day), 2024-03-03 is Sunday,
  // 2024-03-04 is Monday, 2024-03-06 is Wednesday.
  const facts = [
    {
      source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
      business_date: "2024-02-28",
      project_key: "prj-1",
      project_display: "Dự án 1",
      recruiter_key: "nguyễn văn a",
      recruiter_display: "Nguyễn Văn A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      employment_type_key: "thời vụ",
      employment_type_display: "Thời vụ",
      recruited_count: 2,
    },
    {
      source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
      business_date: "2024-02-29",
      project_key: "prj-1",
      project_display: "Dự án 1",
      recruiter_key: "nguyễn văn a",
      recruiter_display: "Nguyễn Văn A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      employment_type_key: "thời vụ",
      employment_type_display: "Thời vụ",
      recruited_count: 3,
    },
    {
      source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
      business_date: "2024-03-04",
      project_key: "prj-2",
      project_display: "Dự án 2",
      recruiter_key: "lê văn c",
      recruiter_display: "Lê Văn C",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      employment_type_key: "chính thức",
      employment_type_display: "Chính thức",
      recruited_count: 4,
    },
    // Out-of-range fact (before `from`) must be excluded
    {
      source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
      business_date: "2024-02-27",
      project_key: "prj-1",
      project_display: "Dự án 1",
      recruiter_key: "nguyễn văn a",
      recruiter_display: "Nguyễn Văn A",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      employment_type_key: "thời vụ",
      employment_type_display: "Thời vụ",
      recruited_count: 10,
    },
  ];

  const filters = {
    from: "2024-02-28",
    to: "2024-03-06",
  };

  const dashboardReport = computeReporting(
    [
      {
        id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
        drive_file_id: "direct_entry",
        file_name: "Direct Entry",
        active: true,
        is_test: false,
        latest_run_status: "succeeded",
        last_successful_sync_at: "2024-03-06T00:00:00Z",
        last_seen_at: "2024-03-06T00:00:00Z",
      },
    ],
    facts,
    filters,
  );
  assert.equal(dashboardReport.recruitedTotal, 9);

  for (const resolution of ["day", "week", "month"]) {
    const matrix = buildDetailedRecruitmentMatrix({
      facts,
      catalog,
      filters,
      resolution,
      teamId: ALL_RECRUITERS_TEAM_FILTER,
    });

    const expectedTrend = buildTrendByResolution(
      dashboardReport.byDate,
      resolution,
      filters.from,
      filters.to,
    );

    // Bucket keys, labels, startDate, endDate, and column totals match TrendChart 100%
    assert.equal(matrix.buckets.length, expectedTrend.length);
    for (let j = 0; j < expectedTrend.length; j += 1) {
      assert.equal(matrix.buckets[j].key, expectedTrend[j].key);
      assert.equal(matrix.buckets[j].date, expectedTrend[j].date);
      assert.equal(matrix.buckets[j].startDate, expectedTrend[j].startDate);
      assert.equal(matrix.buckets[j].endDate, expectedTrend[j].endDate);
      assert.equal(matrix.columnTotals[j], expectedTrend[j].count);
    }

    // Grand total matches Dashboard recruitedTotal
    assert.equal(matrix.grandTotal, dashboardReport.recruitedTotal);
    assert.equal(
      matrix.columnTotals.reduce((acc, n) => acc + n, 0),
      matrix.grandTotal,
    );

    // Every catalog recruiter appears, including Trần Thị B with 0 facts
    assert.equal(matrix.rows.length, 3);
    assert.deepEqual(
      matrix.rows.map((r) => r.stt),
      [1, 2, 3],
    );

    const rowA = matrix.rows.find((r) => r.recruiterId === "rec-1");
    const rowB = matrix.rows.find((r) => r.recruiterId === "rec-2");
    const rowC = matrix.rows.find((r) => r.recruiterId === "rec-3");
    assert.ok(rowA && rowB && rowC);

    assert.equal(rowA.total, 5);
    assert.equal(rowA.personnelCode, "NV001");
    // 2023-08-15 to 2024-03-06 = 6 completed months
    assert.equal(rowA.workMonths, 6);

    assert.equal(rowB.total, 0);
    assert.equal(rowB.personnelCode, null);
    assert.equal(rowB.workMonths, null);
    assert.ok(rowB.counts.every((c) => c === 0));

    assert.equal(rowC.total, 4);
    assert.equal(rowC.personnelCode, "NV003");
    // 2024-01-31 to 2024-03-06 = 1 completed month (passed 2024-02-29)
    assert.equal(rowC.workMonths, 1);

    // Sum of each row's bucket counts equals row.total
    for (const r of matrix.rows) {
      assert.equal(
        r.counts.reduce((acc, n) => acc + n, 0),
        r.total,
      );
    }

    if (resolution === "day") {
      // 2024-02-28, 29, 03-01, 02, 03, 04, 05, 06 = 8 days (includes leap day 2024-02-29)
      assert.equal(matrix.buckets.length, 8);
      assert.equal(matrix.buckets[1].date, "2024-02-29");
    } else if (resolution === "week") {
      // Week 1 clipped to 2024-02-28 -> 2024-03-03; Week 2 clipped to 2024-03-04 -> 2024-03-06
      assert.equal(matrix.buckets.length, 2);
      assert.equal(matrix.buckets[0].startDate, "2024-02-28");
      assert.equal(matrix.buckets[0].endDate, "2024-03-03");
      assert.equal(matrix.buckets[1].startDate, "2024-03-04");
      assert.equal(matrix.buckets[1].endDate, "2024-03-06");
    } else if (resolution === "month") {
      // Month 1 (2024-02) clipped to 2024-02-28..2024-02-29; Month 2 (2024-03) clipped to 2024-03-01..2024-03-06
      assert.equal(matrix.buckets.length, 2);
      assert.equal(matrix.buckets[0].key, "2024-02");
      assert.equal(matrix.buckets[0].startDate, "2024-02-28");
      assert.equal(matrix.buckets[0].endDate, "2024-02-29");
      assert.equal(matrix.buckets[1].key, "2024-03");
      assert.equal(matrix.buckets[1].startDate, "2024-03-01");
      assert.equal(matrix.buckets[1].endDate, "2024-03-06");
    }
  }

  // Team filter: selecting "team-a" shows ONLY current members of team-a (Nguyễn Văn A & Trần Thị B)
  const teamAMatrix = buildDetailedRecruitmentMatrix({
    facts,
    catalog,
    filters,
    resolution: "week",
    teamId: "team-a",
  });
  assert.equal(teamAMatrix.rows.length, 2);
  assert.deepEqual(
    teamAMatrix.rows.map((r) => r.displayName),
    ["Nguyễn Văn A", "Trần Thị B"],
  );
  assert.equal(teamAMatrix.grandTotal, 5);
  assert.deepEqual(teamAMatrix.columnTotals, [5, 0]);
});

test("Detailed Matrix (3): Server handler enforces scope=all (403 FORBIDDEN for non-all actors) and validates query params", async () => {
  const teamLeaderActor = {
    auth_subject: uuid(2),
    app_user_id: uuid(12),
    roles: ["TEAM_LEADER"],
    capabilities: ["direct_entry_read"],
    scopes: [
      {
        kind: "team",
        team_id: uuid(21),
        team_code: "T1",
        display_name: "Team 1",
      },
    ],
  };
  const bodActor = {
    auth_subject: uuid(1),
    app_user_id: uuid(11),
    enabled: true,
    roles: ["SYSTEM_ADMIN"],
    capabilities: ["entry_admin"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      {
        capability: "entry_admin",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "LEGACY_BRIDGE",
        source_id: uuid(91),
      },
    ],
  };

  // Orphan all scope without reporting capability @ ALL must be rejected too (WP5B-2 Group A)
  const orphanAllActor = {
    auth_subject: uuid(3),
    app_user_id: uuid(13),
    enabled: true,
    capabilities: ["catalog_master_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      {
        capability: "catalog_master_manage",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "LEGACY_BRIDGE",
        source_id: uuid(92),
      },
    ],
  };
  const deniedOrphan = await fetchDetailedRecruitmentMatrixReport({}, orphanAllActor, {
    callScopedFactsRpc: () => {
      throw new Error("should not call DB for unpaired all actor");
    },
    callCatalogRpc: () => {
      throw new Error("should not call DB for unpaired all actor");
    },
  });
  assert.equal(deniedOrphan.ok, false);
  assert.equal(deniedOrphan.status, 403);
  assert.equal(deniedOrphan.code, "FORBIDDEN_DETAILED_MATRIX_REPORT");

  // Non-all actor is rejected before hitting DB
  const denied = await fetchDetailedRecruitmentMatrixReport({}, teamLeaderActor, {
    callScopedFactsRpc: () => {
      throw new Error("should not call DB for unauthorized actor");
    },
    callCatalogRpc: () => {
      throw new Error("should not call DB for unauthorized actor");
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "FORBIDDEN_DETAILED_MATRIX_REPORT");

  // Invalid resolution parameter returns 400 INVALID_FILTER
  assert.equal(parseMatrixResolutionParam("quarter"), null);
  const badRes = await fetchDetailedRecruitmentMatrixReport(
    { resolution: "quarter" },
    bodActor,
    {
      callScopedFactsRpc: () => {
        throw new Error("should not call DB on invalid resolution");
      },
      callCatalogRpc: () => {
        throw new Error("should not call DB on invalid resolution");
      },
    },
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 400);
  assert.equal(badRes.code, "INVALID_FILTER");

  // Valid all-scope request aggregates facts + catalog from RPCs
  const team1Id = uuid(31);
  const rec1Id = uuid(41);
  const okResult = await fetchDetailedRecruitmentMatrixReport(
    {
      from: "2026-10-01",
      to: "2026-10-03",
      resolution: "day",
      team: team1Id,
    },
    bodActor,
    {
      referenceDate: new Date("2026-10-03T08:00:00Z"),
      callScopedFactsRpc: async () => ({
        data: {
          audience: { audience: "all" },
          facts: [
            {
              source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
              business_date: "2026-10-02",
              project_key: "prj-1",
              project_display: "Dự án 1",
              recruiter_key: "nguyễn văn a",
              recruiter_display: "Nguyễn Văn A",
              provider_type_key: "hrp",
              provider_type_display: "HRP",
              employment_type_key: "thời vụ",
              employment_type_display: "Thời vụ",
              recruited_count: 3,
            },
          ],
        },
        error: null,
      }),
      callCatalogRpc: async () => ({
        data: {
          teams: [
            {
              team_id: team1Id,
              team_code: "T1",
              display_name: "Nhóm 1",
            },
          ],
          recruiters: [
            {
              recruiter_id: rec1Id,
              recruiter_key: "nguyễn văn a",
              display_name: "Nguyễn Văn A",
              personnel_code: "NV01",
              active: true,
              is_active_hrp: true,
              current_team_ids: [team1Id],
              work_start_date: "2026-04-01",
            },
          ],
        },
        error: null,
      }),
    },
  );
  assert.equal(okResult.ok, true);
  assert.equal(okResult.data.matrix.grandTotal, 3);
  assert.equal(okResult.data.matrix.buckets.length, 3);
  assert.deepEqual(okResult.data.matrix.columnTotals, [0, 3, 0]);
  assert.equal(okResult.data.matrix.rows[0].workMonths, 6);
  assert.equal(okResult.data.matrix.rows[0].personnelCode, "NV01");
});

test("Detailed Matrix (4): Dashboard UI places 'Báo cáo chi tiết' at 'Báo cáo chuyên sâu' slot while keeping WorkforceDeepReportPanel intact", () => {
  const tabsSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/bod-dashboard-tabs.tsx"),
    "utf8",
  );
  const panelSrc = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "src/components/dashboard/detailed-recruitment-matrix-panel.tsx",
    ),
    "utf8",
  );
  const sharedSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/dashboard/dashboard-shared.tsx"),
    "utf8",
  );

  // 1. Tab order in BodDashboardTabs: Báo cáo tổng quát -> Báo cáo chi tiết -> Báo cáo theo nhóm
  const idxGeneral = tabsSrc.indexOf('key: "general", label: "Báo cáo tổng quát"');
  const idxDetailed = tabsSrc.indexOf('key: "deep", label: "Báo cáo chi tiết"');
  const idxTeam = tabsSrc.indexOf('key: "team", label: "Báo cáo theo nhóm"');
  assert.ok(idxGeneral >= 0 && idxDetailed > idxGeneral && idxTeam > idxDetailed);
  assert.ok(!tabsSrc.includes('label: "Báo cáo chuyên sâu"'));
  assert.ok(tabsSrc.includes("<DetailedRecruitmentMatrixPanel"));

  // 2. WorkforceDeepReportPanel & WorkforceDeepSection remain intact in dashboard-shared.tsx
  assert.ok(sharedSrc.includes("export function WorkforceDeepReportPanel"));
  assert.ok(sharedSrc.includes("export function WorkforceDeepSection"));

  // 3. DetailedRecruitmentMatrixPanel renders required columns, provider/team selectors, zoom, sticky top scrollbar, and resolution switcher
  assert.ok(panelSrc.includes("STT"));
  assert.ok(panelSrc.includes("Họ tên"));
  assert.ok(!panelSrc.includes("Mã nhân viên"));
  assert.ok(panelSrc.includes("formatRecruiterNameWithWorkMonths"));
  assert.ok(panelSrc.includes("DETAILED_MATRIX_PROVIDER_OPTIONS"));
  assert.ok(panelSrc.includes("detailed-matrix-top-scrollbar"));
  assert.ok(panelSrc.includes("Tổng cộng"));
  assert.ok(panelSrc.includes("Tất cả người tuyển"));
  assert.ok(panelSrc.includes("TREND_RESOLUTION_OPTIONS"));
  assert.ok(panelSrc.includes("/api/reporting/detailed-matrix"));
  assert.match(
    panelSrc,
    /<FloatingTableNav[\s\S]*?containerRef=\{tableScrollRef\}[\s\S]*?tableLabel="Báo cáo chi tiết"/,
  );
  assert.doesNotMatch(panelSrc, /position="bottom-left"/);

  // 4. Zoom +/- affects ONLY time bucket columns and Total column; STT and Họ tên remain fixed size/font/sticky
  const zoomLevels = [70, 80, 90, 100, 110, 120, 130];
  for (const res of ["day", "week", "month"]) {
    const metricsByZoom = zoomLevels.map((z) =>
      computeDetailedMatrixZoomMetrics(z, res),
    );
    for (const m of metricsByZoom) {
      assert.equal(m.sttColWidthPx, DETAILED_MATRIX_STT_COL_WIDTH_PX);
      assert.equal(m.nameColWidthPx, DETAILED_MATRIX_NAME_COL_WIDTH_PX);
      assert.equal(m.nameMinWidthPx, DETAILED_MATRIX_NAME_COL_WIDTH_PX);
      assert.equal(m.nameMaxWidthPx, DETAILED_MATRIX_NAME_COL_WIDTH_PX);
      assert.equal(m.fixedFontSizePx, DETAILED_MATRIX_FIXED_FONT_SIZE_PX);
      assert.equal(m.fixedCellPadXPx, DETAILED_MATRIX_FIXED_CELL_PAD_X_PX);
      assert.equal(m.fixedCellPadYPx, DETAILED_MATRIX_FIXED_CELL_PAD_Y_PX);
      assert.equal(m.fixedNamePadXPx, DETAILED_MATRIX_FIXED_NAME_PAD_X_PX);
    }

    for (let i = 1; i < metricsByZoom.length; i += 1) {
      const prev = metricsByZoom[i - 1];
      const curr = metricsByZoom[i];
      assert.ok(
        curr.bucketMinWidthPx > prev.bucketMinWidthPx,
        `bucketMinWidthPx must grow with zoom (${prev.zoomPercent}% -> ${curr.zoomPercent}% on ${res})`,
      );
      assert.ok(
        curr.totalColMinWidthPx > prev.totalColMinWidthPx,
        `totalColMinWidthPx must grow with zoom (${prev.zoomPercent}% -> ${curr.zoomPercent}% on ${res})`,
      );
      assert.ok(
        curr.metricFontSizePx > prev.metricFontSizePx,
        `metricFontSizePx must grow with zoom (${prev.zoomPercent}% -> ${curr.zoomPercent}% on ${res})`,
      );
      assert.ok(curr.cellPadXPx >= prev.cellPadXPx);
      assert.ok(curr.cellPadYPx >= prev.cellPadYPx);
      assert.ok(curr.totalCellPadXPx >= prev.totalCellPadXPx);
    }
  }
  assert.equal(clampDetailedMatrixZoom(50), 70);
  assert.equal(clampDetailedMatrixZoom(160), 130);
  assert.equal(clampDetailedMatrixZoom(Number.NaN), 100);
  assert.ok(panelSrc.includes("--matrix-fixed-font-size"));
  assert.ok(panelSrc.includes("--matrix-fixed-cell-py"));
  assert.ok(panelSrc.includes("--matrix-fixed-name-px"));
  assert.ok(panelSrc.includes("--matrix-name-w"));
  assert.ok(panelSrc.includes("sortDetailedMatrixTeamOptions"));

  // 5. Team dropdown sorting: "Tất cả người tuyển" first, "Marketing HRP" last, remaining teams preserve relative order & stability
  const rawTeams = [
    {
      teamId: "team-b",
      teamCode: "TEAM_B",
      displayName: "Nhóm Tuyển dụng 2",
      memberCount: 5,
    },
    {
      teamId: "team-mkt",
      teamCode: "MARKETING_HRP",
      displayName: "Marketing HRP",
      memberCount: 2,
    },
    {
      teamId: "team-a",
      teamCode: "TEAM_A",
      displayName: "Nhóm Tuyển dụng 1",
      memberCount: 7,
    },
    {
      teamId: "team-c",
      teamCode: "TEAM_C",
      displayName: "Nhóm Tuyển dụng 3",
      memberCount: 4,
    },
  ];
  assert.equal(isMarketingHrpTeamOption(rawTeams[1]), true);
  assert.equal(isMarketingHrpTeamOption(rawTeams[0]), false);

  const sortedTeams = sortDetailedMatrixTeamOptions(rawTeams);
  assert.deepEqual(
    sortedTeams.map((t) => t.displayName),
    [
      "Nhóm Tuyển dụng 2",
      "Nhóm Tuyển dụng 1",
      "Nhóm Tuyển dụng 3",
      "Marketing HRP",
    ],
  );
  // Idempotent across reloads / filter changes
  assert.deepEqual(sortDetailedMatrixTeamOptions(sortedTeams), sortedTeams);

  const dropdownOptions = buildDetailedMatrixTeamDropdownOptions(rawTeams);
  assert.deepEqual(dropdownOptions, [
    { value: ALL_RECRUITERS_TEAM_FILTER, label: "Tất cả người tuyển" },
    { value: "team-b", label: "Nhóm Tuyển dụng 2 (5)" },
    { value: "team-a", label: "Nhóm Tuyển dụng 1 (7)" },
    { value: "team-c", label: "Nhóm Tuyển dụng 3 (4)" },
    { value: "team-mkt", label: "Marketing HRP (2)" },
  ]);

  // Also verify buildDetailedRecruitmentMatrix places "Marketing HRP" at the end of matrix.teams
  const matrixWithMarketing = buildDetailedRecruitmentMatrix({
    facts: [],
    catalog: {
      teams: [
        { teamId: "t-mkt", teamCode: "MKT_HRP", displayName: "Marketing HRP" },
        { teamId: "t-2", teamCode: "N2", displayName: "Nhóm 2" },
        { teamId: "t-1", teamCode: "N1", displayName: "Nhóm 1" },
      ],
      recruiters: [],
    },
    filters: { from: "2026-10-01", to: "2026-10-05" },
    resolution: "day",
  });
  assert.deepEqual(
    matrixWithMarketing.teams.map((t) => t.displayName),
    ["Nhóm 1", "Nhóm 2", "Marketing HRP"],
  );
});

test("Detailed Matrix (5): Ephemeral PGlite DB integration for direct_entry_reporting_detailed_matrix_catalog RPC", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    const pinIdx = names.indexOf("20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql");
    assert.notEqual(pinIdx, -1, "missing 20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql");
    for (const name of names.slice(0, pinIdx + 1)) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const AUTH_BOD = uuid(101);
    const USER_BOD = uuid(201);
    const AUTH_REC = uuid(102);
    const USER_REC = uuid(202);
    const AUTH_UNCONFIG = uuid(103);
    const USER_UNCONFIG = uuid(203);

    const TEAM_A = uuid(301);
    const TEAM_B = uuid(302);
    const REC_1 = uuid(401);
    const REC_2 = uuid(402);

    for (const u of [AUTH_BOD, AUTH_REC, AUTH_UNCONFIG]) {
      await db.query("insert into auth.users (id) values ($1)", [u]);
    }
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values " +
        "($1,$2,true,'BoD Admin'), ($3,$4,true,'Recruiter 1'), ($5,$6,true,'Recruiter 2')",
      [USER_BOD, AUTH_BOD, USER_REC, AUTH_REC, USER_UNCONFIG, AUTH_UNCONFIG],
    );
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1,'TEAM-M1','Nhóm Tuyển Dụng M1',true), ($2,'TEAM-M2','Nhóm Tuyển Dụng M2',true)",
      [TEAM_A, TEAM_B],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values " +
        "($1,'all',null,'2020-01-01',true), ($2,'own',null,'2020-01-01',true), ($3,'own',null,'2020-01-01',true)",
      [USER_BOD, USER_REC, USER_UNCONFIG],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values " +
        "($1,'entry_admin','2020-01-01',true)",
      [USER_BOD],
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, active) values " +
        "($1,'Phạm Thị Mai','NV888',true), ($2,'Hoàng Văn Nam',null,true)",
      [REC_1, REC_2],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (membership_id, recruiter_id, provider_type, vendor_id, valid_from, is_current) values " +
        "($1,$2,'hrp',null,'2025-01-01T00:00:00Z',true), ($3,$4,'hrp',null,'2025-01-01T00:00:00Z',true)",
      [uuid(501), REC_1, uuid(502), REC_2],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (membership_id, recruiter_id, team_id, valid_from, is_current) values " +
        "($1,$2,$3,'2025-01-01T00:00:00Z',true), ($4,$5,$6,'2025-01-01T00:00:00Z',true)",
      [uuid(601), REC_1, TEAM_A, uuid(602), REC_2, TEAM_B],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (link_id, app_user_id, recruiter_id, verified, valid_from, is_current) values " +
        "($1,$2,$3,true,'2025-01-01T00:00:00Z',true), ($4,$5,$6,true,'2025-01-01T00:00:00Z',true)",
      [uuid(701), USER_REC, REC_1, uuid(702), USER_UNCONFIG, REC_2],
    );

    // Configure leave profile for USER_REC with work_start_date = 2025-02-15
    await db.query(
      "insert into public.leave_employee_profiles (app_user_id, employment_status, work_start_date) values " +
        "($1, 'OFFICIAL', '2025-02-15'), ($2, 'UNCONFIGURED', null)",
      [USER_REC, USER_UNCONFIG],
    );

    // 1. Non-all audience (Recruiter own scope) is rejected with 42501
    await assert.rejects(
      () =>
        db.query(
          "select public.direct_entry_reporting_detailed_matrix_catalog($1, $2)",
          [AUTH_REC, USER_REC],
        ),
      (err) => err && err.code === "42501",
    );

    // 2. All-scope actor succeeds and receives teams + recruiters with personnel_code and work_start_date
    const res = await db.query(
      "select public.direct_entry_reporting_detailed_matrix_catalog($1, $2) as payload",
      [AUTH_BOD, USER_BOD],
    );
    const catalog = parseDetailedMatrixCatalogPayload(res.rows[0].payload);

    const teamM1 = catalog.teams.find((t) => t.teamId === TEAM_A);
    const teamM2 = catalog.teams.find((t) => t.teamId === TEAM_B);
    assert.ok(teamM1 && teamM2);
    assert.ok(!catalog.teams.some((t) => t.teamCode === "__system_vendor__"));

    const recMai = catalog.recruiters.find((r) => r.recruiterId === REC_1);
    const recNam = catalog.recruiters.find((r) => r.recruiterId === REC_2);
    assert.ok(recMai && recNam);
    assert.equal(recMai.personnelCode, "NV888");
    assert.equal(recMai.workStartDate, "2025-02-15");
    assert.deepEqual(recMai.currentTeamIds, [TEAM_A]);

    assert.equal(recNam.personnelCode, null);
    assert.equal(recNam.workStartDate, null);
    assert.deepEqual(recNam.currentTeamIds, [TEAM_B]);
  } finally {
    await db.close();
  }
});
