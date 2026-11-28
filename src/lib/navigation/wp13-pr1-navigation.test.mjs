/**
 * WP13 PR-1 Navigation — Behavioral & Contract Regression Suite (Web-only).
 *
 * Covers:
 * - F1/F2: 4-group top-level IA (Tổng quan → Công việc của tôi → Tài chính → Quản trị),
 *   independent Vendor Finance / Salary Advance predicates & flags, and F2 Accounting links.
 * - W1: Single "Quản lý báo cáo" entry with exact 5-step priority order, including
 *   `analytics || view` at priority #3 with strictly independent internal Analytics vs
 *   Submissions tabs/guards (view-only NEVER mounts Analytics) + delegated assign/review.
 * - A1/A2: Shared `findActiveNavEntry(pathname, visibleItems)` matcher across DesktopNav,
 *   MobileNav, and ActivePageLabel — prevents shorter-prefix false highlights and prevents
 *   leaking hidden entry names.
 * - Q1/Q2: Query-driven tab synchronization for `/work-reports/assignments` and
 *   `/recruitment-posts` (deep link, top-menu reset, Back/Forward, race cancellation,
 *   zero duplicate fetch).
 * - M1/M2: AdminLayout full request-scoped projection via `resolveNavActorForAppShell` and
 *   `/admin` smart landing across all 4 capability tiers with zero redirect loops.
 * - M3 & AdminSubnav label: Session gates on `/work-reports` & `/work-reports/my-reports`
 *   (allowing valid authenticated history-only users), "Danh mục tuyển dụng" dropdown label,
 *   no AI / Change Requests restoration, and read-only nav probe preservation.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import {
  CURRENT_NAV_ENTRIES,
  filterEntriesForActor,
  findActiveNavEntry,
  findEntryByPath,
  groupNavEntries,
  projectNavMenuEntries,
} from "./registry.ts";
import {
  decideNavEntryVisibility,
  resolveWorkReportManagementPath,
  workReportManagementNavPredicate,
} from "./registry-capability.ts";
import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideAttendanceReportPageAccess,
  decideOrganizationPersonsPageAccess,
  decidePersonalWorkReportsPageAccess,
  decidePersonnelCatalogPageAccess,
  decideWorkReportAnalyticsPageAccess,
  decideWorkerEditHistoryPageAccess,
  resolveAdminLandingPath,
} from "../auth/direct-entry-page-access.ts";
import {
  ADMIN_SECTIONS,
  groupAdminSections,
  visibleAdminSections,
} from "../admin/admin-navigation.ts";
import {
  buildWorkReportAssignmentTabHref,
  parseWorkReportAssignmentTab,
} from "../work-reports/assignment-tab-model.ts";
import * as recruitmentPostUiModel from "../recruitment-posts/recruitment-post-ui-model.ts";
const {
  buildRecruitmentPostFeedTabHref,
  createLatestRequestTracker,
  parseRecruitmentPostFeedTab,
} = recruitmentPostUiModel;

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readRepo(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function loadTsxModule(relPath, overrides = {}) {
  const fullPath = path.join(repoRoot, relPath);
  const source = readFileSync(fullPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: fullPath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} };
  const localRequire = Module.createRequire(fullPath);
  const customRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(overrides, specifier)) {
      return overrides[specifier];
    }
    return localRequire(specifier);
  };
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", outputText);
  fn(mod.exports, customRequire, mod, fullPath, path.dirname(fullPath));
  return mod.exports;
}

function makeGrant(capability, scopeKind = "ALL", scopeId = null) {
  return {
    capability,
    scope_kind: scopeKind,
    scope_id: scopeId,
    source_type: "ROLE_BUNDLE",
    source_id: "00000000-0000-4000-8000-000000000001",
  };
}

function makeNavActor({
  capabilities = [],
  scopes = [],
  effective_grants = [],
  effective_report_review_scopes = [],
  hasWorkReportObligations = false,
  hasWorkReportAssignmentAccess = false,
  hasVendorFinanceAccess = false,
  hasVendorFinanceRecordAccess = false,
  hasVendorFinanceReconcileAccess = false,
  hasLeaveManagementAccess = false,
  hasLeaveAdminAccess = false,
  hasSalaryAdvanceAccess = false,
  hasAttendanceDepartmentHeadAccess = false,
  allowed_worker_tabs,
} = {}) {
  return {
    capabilities,
    scopes,
    effective_grants,
    effective_report_review_scopes,
    hasWorkReportObligations,
    hasWorkReportAssignmentAccess,
    hasVendorFinanceAccess,
    hasVendorFinanceRecordAccess,
    hasVendorFinanceReconcileAccess,
    hasLeaveManagementAccess,
    hasLeaveAdminAccess,
    hasSalaryAdvanceAccess,
    hasAttendanceDepartmentHeadAccess,
    ...(allowed_worker_tabs !== undefined ? { allowed_worker_tabs } : {}),
  };
}

function makeFullActorResolution({
  capabilities = [],
  scopes = [],
  effective_grants = [],
  assigned_roles = [],
} = {}) {
  return {
    ok: true,
    actor: {
      auth_subject: "10000000-0000-4000-8000-000000000001",
      app_user_id: "20000000-0000-4000-8000-000000000001",
      display_name: "Fixture Actor",
      enabled: true,
      capabilities,
      scopes,
      effective_grants,
      assigned_roles,
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

const WORK_REPORTS_NAV_ENTRY_IDS = new Set(["work-reports", "work-report-management"]);

function simulateAppShellMenu({
  actor,
  viewport = "desktop",
  directEntryEnabled = true,
  workReportsEnabled = true,
  directEntryApiEnabled = true,
}) {
  const isFeatureEnabled = (entry) =>
    (!WORK_REPORTS_NAV_ENTRY_IDS.has(entry.id) || workReportsEnabled) &&
    (entry.id !== "finance" || directEntryApiEnabled) &&
    ((entry.id !== "leave" && entry.id !== "leave-admin") || directEntryApiEnabled) &&
    (entry.id !== "salary-advances" || directEntryApiEnabled) &&
    (entry.id !== "recruitment-posts" || directEntryApiEnabled) &&
    (entry.id !== "bulletins" || directEntryApiEnabled);

  const filtered = filterEntriesForActor({
    viewport,
    directEntryEnabled,
    actor,
    decide: (entry) =>
      isFeatureEnabled(entry) &&
      decideNavEntryVisibility({
        capabilityKey: entry.capability,
        actor,
        viewport,
        entryVisibleInViewport: entry.visibility[viewport],
      }),
  });
  return projectNavMenuEntries(filtered, actor);
}

// =========================================================================
// 1. F1 & F2 — Nhóm Tài chính + Sửa 2 link phòng kế toán hardcode
// =========================================================================

test("F1: 4 top-level groups order Tổng quan → Công việc của tôi → Tài chính → Quản trị; PM salary-only vs Accountant vendor-only vs neither", () => {
  const fullAdmin = makeNavActor({
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("entry_admin", "ALL"),
      makeGrant("recruiter_master_manage", "ALL"),
      makeGrant("team_master_manage", "ALL"),
    ],
  });

  for (const viewport of ["desktop", "mobile"]) {
    const items = simulateAppShellMenu({ actor: fullAdmin, viewport });
    const grouped = groupNavEntries(items);
    assert.deepEqual(
      grouped.map((n) => (n.type === "entry" ? n.entry.label : `group:${n.label}`)),
      ["Tổng quan", "group:Công việc của tôi", "group:Tài chính", "group:Quản trị"],
      viewport,
    );
    const myWorkGroup = grouped.find((n) => n.type === "group" && n.id === "my-work");
    assert.ok(myWorkGroup && myWorkGroup.type === "group");
    assert.equal(
      myWorkGroup.entries.some((e) => e.id === "bulletins" && e.path === "/bulletins"),
      true,
      viewport,
    );
    const financeGroup = grouped.find((n) => n.type === "group" && n.id === "finance");
    assert.ok(financeGroup && financeGroup.type === "group");
    assert.deepEqual(
      financeGroup.entries.map((e) => ({ id: e.id, label: e.label, path: e.path })),
      [
        { id: "finance", label: "Công nợ Vendor", path: "/finance" },
        { id: "salary-advances", label: "Ứng lương", path: "/salary-advances" },
      ],
    );
    // Ensure NO grants/source IDs/PII leak onto client NavMenuEntry objects
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["group", "id", "label", "path"]);
    }
  }

  // PM with ONLY Salary Advance access sees Tài chính group with ONLY Ứng lương
  const pmSalaryOnly = makeNavActor({ hasSalaryAdvanceAccess: true });
  const pmGrouped = groupNavEntries(simulateAppShellMenu({ actor: pmSalaryOnly }));
  const pmFinance = pmGrouped.find((n) => n.type === "group" && n.id === "finance");
  assert.ok(pmFinance && pmFinance.type === "group");
  assert.deepEqual(pmFinance.entries.map((e) => e.id), ["salary-advances"]);

  // Accountant with ONLY Vendor Finance access sees Tài chính group with ONLY Công nợ Vendor
  const accountantVendorOnly = makeNavActor({ hasVendorFinanceAccess: true });
  const accGrouped = groupNavEntries(simulateAppShellMenu({ actor: accountantVendorOnly }));
  const accFinance = accGrouped.find((n) => n.type === "group" && n.id === "finance");
  assert.ok(accFinance && accFinance.type === "group");
  assert.deepEqual(accFinance.entries.map((e) => e.id), ["finance"]);

  // Staff with NEITHER hides Tài chính group completely
  const plainStaff = makeNavActor({ hasLeaveManagementAccess: true });
  const plainGrouped = groupNavEntries(simulateAppShellMenu({ actor: plainStaff }));
  assert.equal(
    plainGrouped.some((n) => n.type === "group" && n.id === "finance"),
    false,
    "Empty Tài chính group must be omitted",
  );

  // Feature flags off hide corresponding entries independently
  const flagsOffItems = simulateAppShellMenu({
    actor: fullAdmin,
    directEntryEnabled: false,
    workReportsEnabled: false,
    directEntryApiEnabled: false,
  });
  assert.deepEqual(
    flagsOffItems.map((e) => e.id),
    ["dashboard", "attendance-report", "admin"],
  );
});

test("F2: vendor-finance-governance-view replaces both /admin/departments/accounting links with /admin/departments and label 'Phòng ban'", () => {
  const governanceSrc = readRepo("src/components/vendor-finance/vendor-finance-governance-view.tsx");
  assert.doesNotMatch(
    governanceSrc,
    /\/admin\/departments\/accounting/,
    "Hardcoded /admin/departments/accounting link must be completely removed",
  );
  const departmentLinks = governanceSrc.match(/href="\/admin\/departments"/g) ?? [];
  assert.equal(departmentLinks.length, 2, "Both governance links must point to /admin/departments");
  assert.match(
    governanceSrc,
    /href="\/admin\/departments"[\s\S]{0,160}Phòng ban\s*<\/Link>/,
  );
});

// =========================================================================
// 2. W1 — Một mục Quản lý báo cáo với thứ tự ưu tiên & quyền độc lập
// =========================================================================

test("W1: resolveWorkReportManagementPath follows exact 5-step priority order including delegated assign/review & view-only", () => {
  const teamId = "30000000-0000-4000-8000-000000000001";

  // 1a. Direct report_assign -> /work-reports/assignments
  const directAssign = makeNavActor({
    capabilities: ["report_assign"],
    scopes: [{ kind: "team" }],
    effective_grants: [makeGrant("report_assign", "CONTEXT_TEAM", teamId)],
  });
  assert.equal(resolveWorkReportManagementPath(directAssign), "/work-reports/assignments");

  // 1b. Pure delegated report_assign (no direct capability) -> /work-reports/assignments
  const delegatedAssignOnly = makeNavActor({ hasWorkReportAssignmentAccess: true });
  assert.equal(resolveWorkReportManagementPath(delegatedAssignOnly), "/work-reports/assignments");
  assert.equal(
    simulateAppShellMenu({ actor: delegatedAssignOnly }).find((e) => e.id === "work-report-management")?.path,
    "/work-reports/assignments",
  );

  // 2a. Direct report_review only -> /work-reports/reviews
  const directReviewOnly = makeNavActor({
    capabilities: ["report_review"],
    scopes: [{ kind: "team" }],
    effective_grants: [makeGrant("report_review", "CONTEXT_TEAM", teamId)],
  });
  assert.equal(resolveWorkReportManagementPath(directReviewOnly), "/work-reports/reviews");

  // 2b. Delegated report_review only (via effective_report_review_scopes) -> /work-reports/reviews
  const delegatedReviewOnly = makeNavActor({
    effective_report_review_scopes: [{ kind: "team", team_id: teamId, label: "Team A" }],
  });
  assert.equal(resolveWorkReportManagementPath(delegatedReviewOnly), "/work-reports/reviews");
  assert.equal(
    simulateAppShellMenu({ actor: delegatedReviewOnly }).find((e) => e.id === "work-report-management")?.path,
    "/work-reports/reviews",
  );

  // 3a. Analytics-only -> /work-reports/analytics
  const analyticsOnly = makeNavActor({
    capabilities: ["report_analytics_view"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("report_analytics_view", "ALL")],
  });
  assert.equal(resolveWorkReportManagementPath(analyticsOnly), "/work-reports/analytics");

  // 3b. View-only (T0 locked: analytics || view for entry, independent internal tabs) -> /work-reports/analytics
  const viewOnly = makeNavActor({
    capabilities: ["report_view"],
    scopes: [{ kind: "team" }],
    effective_grants: [makeGrant("report_view", "CONTEXT_TEAM", teamId)],
  });
  assert.equal(resolveWorkReportManagementPath(viewOnly), "/work-reports/analytics");
  assert.equal(
    simulateAppShellMenu({ actor: viewOnly }).find((e) => e.id === "work-report-management")?.path,
    "/work-reports/analytics",
  );
  // Own-only report_view must remain denied (matching SQL guard)
  const ownViewOnly = makeNavActor({
    capabilities: ["report_view"],
    scopes: [{ kind: "own" }],
    effective_grants: [makeGrant("report_view", "OWN")],
  });
  assert.equal(resolveWorkReportManagementPath(ownViewOnly), null);

  // 4. Templates-only -> /work-reports/templates
  const templateOnly = makeNavActor({
    capabilities: ["report_form_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("report_form_manage", "ALL")],
  });
  assert.equal(resolveWorkReportManagementPath(templateOnly), "/work-reports/templates");

  // 5. Delegations-only -> /work-reports/delegations
  const delegationOnly = makeNavActor({
    capabilities: ["report_delegate"],
    scopes: [{ kind: "team" }],
    effective_grants: [makeGrant("report_delegate", "CONTEXT_TEAM", teamId)],
  });
  assert.equal(resolveWorkReportManagementPath(delegationOnly), "/work-reports/delegations");

  // Multi-permission priority checks
  const reviewAndTemplates = makeNavActor({
    capabilities: ["report_review", "report_form_manage", "report_delegate"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("report_review", "ALL"),
      makeGrant("report_form_manage", "ALL"),
      makeGrant("report_delegate", "ALL"),
    ],
  });
  assert.equal(resolveWorkReportManagementPath(reviewAndTemplates), "/work-reports/reviews");

  const templatesAndDelegations = makeNavActor({
    capabilities: ["report_form_manage", "report_delegate"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("report_form_manage", "ALL"),
      makeGrant("report_delegate", "ALL"),
    ],
  });
  assert.equal(resolveWorkReportManagementPath(templatesAndDelegations), "/work-reports/templates");

  // Personal-only staff with active obligations does NOT get Quản lý báo cáo
  const obligationStaffOnly = makeNavActor({ hasWorkReportObligations: true });
  assert.equal(resolveWorkReportManagementPath(obligationStaffOnly), null);
  assert.equal(workReportManagementNavPredicate(obligationStaffOnly), false);
  const staffMenu = simulateAppShellMenu({ actor: obligationStaffOnly });
  assert.equal(staffMenu.some((e) => e.id === "work-reports"), true);
  assert.equal(staffMenu.some((e) => e.id === "work-report-management"), false);

  // Unauthenticated actor gets ONLY Tổng quan
  assert.equal(resolveWorkReportManagementPath(null), null);
  assert.deepEqual(
    simulateAppShellMenu({ actor: null }).map((e) => e.id),
    ["dashboard"],
  );
});

test("W1 runtime isolation: view-only on /work-reports/analytics mounts ONLY ReadableSubmissions (never WorkReportAnalytics), and analytics-only mounts ONLY WorkReportAnalytics", () => {
  let analyticsMountCount = 0;
  let submissionsMountCount = 0;

  const { WorkReportAnalyticsTabs } = loadTsxModule(
    "src/components/work-reports/analytics/work-report-analytics-tabs.tsx",
    {
      "./work-report-analytics": {
        WorkReportAnalytics: ({ canViewSubmissions }) => {
          analyticsMountCount += 1;
          return React.createElement(
            "div",
            { "data-mock": "analytics", "data-can-view-submissions": String(canViewSubmissions) },
            "ANALYTICS_PANEL",
          );
        },
      },
      "../reader/readable-submissions": {
        ReadableSubmissions: () => {
          submissionsMountCount += 1;
          return React.createElement("div", { "data-mock": "submissions" }, "SUBMISSIONS_PANEL");
        },
      },
    },
  );

  // View-only actor: page decision ALLOW, tabs mount ONLY Bài nộp, ZERO Analytics mount
  const viewOnlyResolution = makeFullActorResolution({
    capabilities: ["report_view"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("report_view", "ALL")],
  });
  assert.equal(decideWorkReportAnalyticsPageAccess({ actor: viewOnlyResolution }), "ALLOW");

  const viewOnlyHtml = renderToStaticMarkup(
    React.createElement(WorkReportAnalyticsTabs, {
      canViewAnalytics: false,
      canViewSubmissions: true,
    }),
  );
  assert.equal(analyticsMountCount, 0, "view-only must NEVER mount WorkReportAnalytics");
  assert.equal(submissionsMountCount, 1, "view-only must mount ReadableSubmissions");
  assert.match(viewOnlyHtml, /SUBMISSIONS_PANEL/);
  assert.doesNotMatch(viewOnlyHtml, /ANALYTICS_PANEL/);
  assert.doesNotMatch(viewOnlyHtml, /analytics-tab-summary/);

  // Analytics-only actor: tabs mount ONLY Tổng quan, ZERO ReadableSubmissions mount
  analyticsMountCount = 0;
  submissionsMountCount = 0;
  const analyticsOnlyHtml = renderToStaticMarkup(
    React.createElement(WorkReportAnalyticsTabs, {
      canViewAnalytics: true,
      canViewSubmissions: false,
    }),
  );
  assert.equal(analyticsMountCount, 1, "analytics-only must mount WorkReportAnalytics");
  assert.equal(submissionsMountCount, 0, "analytics-only must NEVER mount ReadableSubmissions");
  assert.match(analyticsOnlyHtml, /ANALYTICS_PANEL/);
  assert.doesNotMatch(analyticsOnlyHtml, /SUBMISSIONS_PANEL/);
  assert.doesNotMatch(analyticsOnlyHtml, /analytics-tab-submissions/);
});

// =========================================================================
// 3. A1 & A2 — Shared active matcher across DesktopNav, MobileNav & ActivePageLabel
// =========================================================================

test("A1/A2: findActiveNavEntry prevents shorter-prefix false highlights & hidden label leaks across all branches", () => {
  const recruiterItems = simulateAppShellMenu({
    actor: makeNavActor({
      capabilities: ["entry_own"],
      scopes: [{ kind: "own" }],
      effective_grants: [makeGrant("entry_own", "OWN")],
      hasWorkReportObligations: true,
    }),
  });

  // Recruiter has direct-entry & work-reports, NOT project-operations, change-requests, or work-report-management
  assert.equal(findActiveNavEntry("/direct-entry", recruiterItems)?.id, "direct-entry");
  assert.equal(
    findActiveNavEntry("/direct-entry/projects", recruiterItems),
    undefined,
    "Shorter prefix /direct-entry must NOT highlight when project-operations is hidden",
  );
  assert.equal(
    findActiveNavEntry("/direct-entry/change-requests", recruiterItems),
    undefined,
    "Hidden change-requests must NOT highlight /direct-entry",
  );
  assert.equal(findActiveNavEntry("/work-reports", recruiterItems)?.id, "work-reports");
  assert.equal(findActiveNavEntry("/work-reports/my-reports", recruiterItems)?.id, "work-reports");
  for (const mgmtPath of [
    "/work-reports/assignments",
    "/work-reports/assignments?tab=groups",
    "/work-reports/reviews",
    "/work-reports/reviews/obl-123",
    "/work-reports/analytics",
    "/work-reports/templates",
    "/work-reports/delegations",
  ]) {
    assert.equal(
      findActiveNavEntry(mgmtPath, recruiterItems),
      undefined,
      `${mgmtPath} must NOT falsely highlight Báo cáo của tôi when Quản lý báo cáo is hidden`,
    );
  }

  // Catalog-only admin has /admin, NOT /admin/attendance
  const catalogItems = simulateAppShellMenu({
    actor: makeNavActor({
      capabilities: ["catalog_master_manage"],
      scopes: [{ kind: "all" }],
      effective_grants: [makeGrant("catalog_master_manage", "ALL")],
    }),
  });
  assert.equal(findActiveNavEntry("/admin/catalog/personnel", catalogItems)?.id, "admin");
  assert.equal(
    findActiveNavEntry("/admin/attendance", catalogItems),
    undefined,
    "Shorter prefix /admin must NOT highlight when attendance-report is hidden",
  );

  // Review-only actor (default path = /work-reports/reviews) highlights Quản lý báo cáo on ALL 5 management branches
  const reviewOnlyItems = simulateAppShellMenu({
    actor: makeNavActor({
      capabilities: ["report_review"],
      scopes: [{ kind: "all" }],
      effective_grants: [makeGrant("report_review", "ALL")],
    }),
  });
  for (const mgmtPath of [
    "/work-reports/assignments",
    "/work-reports/reviews",
    "/work-reports/analytics",
    "/work-reports/templates",
    "/work-reports/delegations",
  ]) {
    const matched = findActiveNavEntry(mgmtPath, reviewOnlyItems);
    assert.equal(matched?.id, "work-report-management", mgmtPath);
    assert.equal(matched?.label, "Quản lý báo cáo", mgmtPath);
  }

  // Unauthenticated (dashboard-only) NEVER leaks hidden labels
  const anonItems = simulateAppShellMenu({ actor: null });
  for (const hiddenPath of ["/admin", "/finance", "/work-reports", "/direct-entry/projects"]) {
    assert.equal(findActiveNavEntry(hiddenPath, anonItems), undefined, hiddenPath);
  }
  assert.equal(findActiveNavEntry("/dashboard", anonItems)?.id, "dashboard");
});

test("A2 runtime: ActivePageLabel renders sr-only label ONLY when canonical owner is in filtered visible items", () => {
  let mockedPathname = "/work-reports/templates";
  const { ActivePageLabel } = loadTsxModule("src/components/app-shell/active-page-label.tsx", {
    "next/navigation": { usePathname: () => mockedPathname },
    "@/lib/navigation/registry": { findActiveNavEntry },
  });

  const staffOnlyItems = [{ id: "dashboard", label: "Tổng quan" }, { id: "work-reports", label: "Báo cáo của tôi" }];
  const mgmtItems = [...staffOnlyItems, { id: "work-report-management", label: "Quản lý báo cáo" }];

  // Hidden owner -> renders empty string (does NOT leak "Quản lý báo cáo" or misread "Báo cáo của tôi")
  assert.equal(
    renderToStaticMarkup(React.createElement(ActivePageLabel, { items: staffOnlyItems })),
    "",
  );

  // Visible owner -> renders exact sr-only label
  assert.equal(
    renderToStaticMarkup(React.createElement(ActivePageLabel, { items: mgmtItems })),
    '<p class="sr-only">Đang ở trang: Quản lý báo cáo</p>',
  );

  // Hidden change-requests on Recruiter with direct-entry -> renders empty string
  mockedPathname = "/direct-entry/change-requests";
  assert.equal(
    renderToStaticMarkup(
      React.createElement(ActivePageLabel, {
        items: [{ id: "dashboard", label: "Tổng quan" }, { id: "direct-entry", label: "Nhập liệu" }],
      }),
    ),
    "",
  );
});

// =========================================================================
// 4. Q1 & Q2 — Query/Tab Synchronization, Back/Forward & Anti-Race
// =========================================================================

test("Q1: assignment-tab-model + WorkReportsModuleNav + AssignmentManager stay synced with URL searchParams (deep link, menu reset & Back/Forward)", () => {
  assert.equal(parseWorkReportAssignmentTab("groups"), "groups");
  assert.equal(parseWorkReportAssignmentTab(["groups", "other"]), "groups");
  assert.equal(parseWorkReportAssignmentTab(null), "assignments");
  assert.equal(parseWorkReportAssignmentTab(undefined), "assignments");
  assert.equal(parseWorkReportAssignmentTab(""), "assignments");
  assert.equal(parseWorkReportAssignmentTab("invalid"), "assignments");
  assert.equal(buildWorkReportAssignmentTabHref("groups"), "/work-reports/assignments?tab=groups");
  assert.equal(buildWorkReportAssignmentTabHref("assignments"), "/work-reports/assignments");

  // Runtime render of WorkReportsModuleNav with reactive searchParams simulation:
  // ?tab=groups -> Nhóm nhận báo cáo has aria-current="page"
  // reset to no query -> Đợt giao has aria-current="page"
  let currentTabQuery = "groups";
  const { WorkReportsModuleNav } = loadTsxModule("src/components/work-reports/work-reports-nav.tsx", {
    "next/navigation": {
      usePathname: () => "/work-reports/assignments",
      useSearchParams: () => new URLSearchParams(currentTabQuery ? `tab=${currentTabQuery}` : ""),
    },
    "next/link": {
      __esModule: true,
      default: ({ href, children, scroll: _scroll, ...props }) => React.createElement("a", { href, ...props }, children),
    },
    "@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
    "@/lib/work-reports/assignment-tab-model": { parseWorkReportAssignmentTab },
  });

  const links = [
    {
      href: "/work-reports/assignments",
      label: "Quản lý báo cáo",
      activeKey: "management",
      matchKeys: ["assignments", "groups", "analytics"],
      subLinks: [
        { href: "/work-reports/assignments", label: "Đợt giao", activeKey: "assignments" },
        { href: "/work-reports/assignments?tab=groups", label: "Nhóm nhận báo cáo", activeKey: "groups" },
      ],
    },
  ];

  const groupsHtml = renderToStaticMarkup(
    React.createElement(WorkReportsModuleNav, { active: "assignments", links }),
  );
  assert.match(groupsHtml, /<a href="\/work-reports\/assignments\?tab=groups"[^>]*aria-current="page"[^>]*>Nhóm nhận báo cáo<\/a>/);
  assert.doesNotMatch(groupsHtml, /<a href="\/work-reports\/assignments"[^>]*aria-current="page"[^>]*>Đợt giao<\/a>/);

  // Simulate clicking menu /work-reports/assignments or Back button -> query clears
  currentTabQuery = "";
  const resetHtml = renderToStaticMarkup(
    React.createElement(WorkReportsModuleNav, { active: "groups", links }),
  );
  assert.match(resetHtml, /<a href="\/work-reports\/assignments"[^>]*aria-current="page"[^>]*>Đợt giao<\/a>/);
  assert.doesNotMatch(resetHtml, /<a href="\/work-reports\/assignments\?tab=groups"[^>]*aria-current="page"[^>]*>Nhóm nhận báo cáo<\/a>/);

  // Verify AssignmentManager & page wire useSearchParams (for Back/Forward) without duplicate nav buttons or stale replaceState
  const managerSrc = readRepo("src/components/work-reports/renderer/assignment-manager.tsx");
  const navSrc = readRepo("src/components/work-reports/work-reports-nav.tsx");
  const shellSrc = readRepo("src/components/work-reports/work-reports-shell.tsx");
  const assignPageSrc = readRepo("src/app/work-reports/assignments/page.tsx");
  assert.match(managerSrc, /useSearchParams\(\)/);
  assert.match(managerSrc, /parseWorkReportAssignmentTab\(searchParams\.get\("tab"\)\)/);
  assert.doesNotMatch(managerSrc, /Đợt giao \(\{assignments\.length\}\)/);
  assert.doesNotMatch(managerSrc, /Nhóm nhận báo cáo \(\{groups\.length\}\)/);
  assert.match(managerSrc, /open=\{revokeConfirmAssignment !== null && \(activeSubView === "assignments" \|\| trackingBusy\)\}/);
  assert.match(managerSrc, /open=\{groupEditor !== null && \(activeSubView === "groups" \|\| groupBusy\)\}/);
  assert.doesNotMatch(managerSrc, /window\.history\.replaceState/);
  assert.doesNotMatch(navSrc, /window\.history\.replaceState/);
  assert.match(shellSrc, /<Suspense fallback=\{null\}>[\s\S]*<WorkReportsModuleNav/);
  assert.match(assignPageSrc, /parseWorkReportAssignmentTab\(resolvedSearchParams\?\.tab\)/);
  assert.match(assignPageSrc, /<AssignmentManager initialSubView=\{initialSubView\} \/>/);
});

test("Q2: RecruitmentPostFeedWorkspace derives live tab from useSearchParams, avoids empty/stale cross-tab flash on transition & menu reset, and cancels stale fetches", () => {
  assert.equal(parseRecruitmentPostFeedTab("mine"), "mine");
  assert.equal(parseRecruitmentPostFeedTab(null), "published");
  assert.equal(parseRecruitmentPostFeedTab("invalid"), "published");
  assert.equal(buildRecruitmentPostFeedTabHref("mine"), "/recruitment-posts?tab=mine");
  assert.equal(buildRecruitmentPostFeedTabHref("published"), "/recruitment-posts?tab=published");
  assert.equal(parseRecruitmentPostFeedTab(new URLSearchParams("").get("tab")), "published");

  const workspaceSrc = readRepo("src/components/recruitment-posts/recruitment-post-feed-workspace.tsx");
  assert.match(workspaceSrc, /const hasLiveSearchParams =\s*searchParams !== null && initialStateForTest\?\.activeTab === undefined;/);
  assert.match(workspaceSrc, /const activeTab: RecruitmentPostFeedTab = hasLiveSearchParams\s*\?\s*parseRecruitmentPostFeedTab\(searchTabParam\)\s*:\s*localTab;/);
  assert.match(workspaceSrc, /const \[isTabTransitionPending,\s*startTabTransition\] = useTransition\(\);/);
  assert.match(workspaceSrc, /const isTabMismatch = loadedTab !== activeTab;/);
  assert.match(workspaceSrc, /const showFeedLoading =\s*initialLoading \|\| isTabMismatch \|\| isTabTransitionPending;/);
  assert.match(workspaceSrc, /startTabTransition\(\(\) => \{[\s\S]*router\.push\(href,\s*\{\s*scroll:\s*false\s*\}\)/);
  assert.doesNotMatch(workspaceSrc, /router\.replace\(href/);

  // Runtime render check (P1-1 + P2-1): when URL searchParams resets from ?tab=mine to "" (published)
  // while loadedTab is still "mine" with a WITHDRAWN item in state and initialLoading === false,
  // workspace MUST render loading (NEVER flash the stale WITHDRAWN item under Tin đang tuyển and NEVER flash empty state).
  let simulatedQuery = "";
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  const { RecruitmentPostFeedWorkspace } = loadTsxModule(
    "src/components/recruitment-posts/recruitment-post-feed-workspace.tsx",
    {
      "next/link": {
        __esModule: true,
        default: ({ href, children, scroll: _scroll, ...props }) => React.createElement("a", { href, ...props }, children),
      },
      "next/navigation": {
        useRouter: () => ({ push: () => {}, replace: () => {} }),
        useSearchParams: () => new URLSearchParams(simulatedQuery),
      },
      "@/components/auth/access-denied": { AccessDenied: passthrough, AccountUnavailable: passthrough },
      "@/components/ui/button": { Button: ({ children, ...p }) => React.createElement("button", p, children) },
      "@/components/ui/cursor-load-more": { CursorLoadMore: () => null },
      "@/components/ui/filter-toolbar": { FilterToolbar: passthrough },
      "@/components/ui/page-shell": { PageHeader: passthrough, PageShell: passthrough },
      "@/components/ui/status-banner": { StatusBanner: ({ children, title, dataTestId }) => React.createElement("div", { "data-testid": dataTestId }, title, children) },
      "./recruitment-post-card": {
        RecruitmentPostCard: ({ card }) => React.createElement("article", { "data-testid": `card-${card.briefId}` }, card.title),
      },
      "./recruitment-post-detail-dialog": { RecruitmentPostDetailDialog: () => null },
      "./recruitment-post-withdraw-dialog": { RecruitmentPostWithdrawDialog: () => null },
      "@/lib/recruitment-posts/recruitment-post-ui-model": {
        ...recruitmentPostUiModel,
        toRecruitmentPostCardViewModel: (item) => ({
          briefId: item.brief_id,
          projectId: item.project_id,
          title: item.title,
          status: item.status,
          projectName: "Dự án A",
          locationSummary: "Bắc Ninh",
          laborTypeLabel: "Chính thức",
          salaryHeadline: "10M",
          headcountLabel: "10 người",
          shiftLabel: "Ngày",
          genderLabel: "Nam/Nữ",
          updatedLabel: "Hôm nay",
          canWithdraw: false,
          canEdit: false,
        }),
      },
      "@/lib/utils": { cn: (...c) => c.filter(Boolean).join(" ") },
    },
  );

  const staleWithdrawnMineData = {
    context: { can_create: true, managed_projects: [], provinces: [], industrial_parks: [], labor_types: [] },
    items: [
      {
        brief_id: "brief-withdrawn-1",
        project_id: "proj-1",
        title: "STALE_WITHDRAWN_MINE_POST",
        status: "WITHDRAWN",
      },
    ],
    hasMore: false,
    nextCursor: null,
    snapshotToken: "tok",
    totalCount: 1,
    detail: null,
  };

  // Menu click reset to /recruitment-posts ("" -> published) while loadedTab is still "mine":
  simulatedQuery = "";
  const transitionHtml = renderToStaticMarkup(
    React.createElement(RecruitmentPostFeedWorkspace, {
      initialStateForTest: {
        loadedTab: "mine",
        initialLoading: false,
        contextLoading: false,
        dataState: staleWithdrawnMineData,
      },
    }),
  );
  assert.match(transitionHtml, /data-testid="recruitment-posts-loading"/, "Mismatch between activeTab and loadedTab MUST render loading immediately");
  assert.doesNotMatch(transitionHtml, /STALE_WITHDRAWN_MINE_POST/, "Stale WITHDRAWN item from mine MUST NOT flash under Tin đang tuyển");
  assert.doesNotMatch(transitionHtml, /data-testid="recruitment-posts-empty"/, "MUST NOT flash false empty state during tab switch");
  assert.doesNotMatch(transitionHtml, /data-testid="recruitment-posts-list"/, "MUST NOT render stale list during tab mismatch");

  // Once loadedTab matches activeTab ("mine"), WITHDRAWN item renders normally under Tin của tôi:
  simulatedQuery = "tab=mine";
  const settledMineHtml = renderToStaticMarkup(
    React.createElement(RecruitmentPostFeedWorkspace, {
      initialStateForTest: {
        loadedTab: "mine",
        initialLoading: false,
        contextLoading: false,
        dataState: staleWithdrawnMineData,
      },
    }),
  );
  assert.match(settledMineHtml, /data-testid="recruitment-posts-list"/);
  assert.match(settledMineHtml, /STALE_WITHDRAWN_MINE_POST/);
  assert.doesNotMatch(settledMineHtml, /data-testid="recruitment-posts-loading"/);

  // Anti-race behavioral check: slow tab=mine response resolving after menu click back to published is ignored
  const tracker = createLatestRequestTracker();
  const mineTicket = tracker.begin();
  assert.equal(mineTicket.isCurrent(), true);
  assert.equal(mineTicket.signal.aborted, false);

  const publishedTicket = tracker.begin();
  assert.equal(mineTicket.signal.aborted, true, "Switching tabs must abort prior tab's in-flight request");
  assert.equal(mineTicket.isCurrent(), false, "Late stale response from tab=mine must be discarded");
  assert.equal(publishedTicket.isCurrent(), true);
});

// =========================================================================
// 5. M1 & M2 — Admin Layout Full Projection & /admin Smart Landing
// =========================================================================

test("M1: AdminLayout delegates to resolveNavActorForAppShell({ directEntryEnabled, adminNavigationEnabled: true }) while keeping /admin gate independent", () => {
  const adminLayoutSrc = readRepo("src/app/admin/layout.tsx");
  assert.match(adminLayoutSrc, /resolveActorForRequest\(\)/);
  assert.match(adminLayoutSrc, /decideAdminAreaAccess\(\{ actor \}\)/);
  assert.match(
    adminLayoutSrc,
    /resolveNavActorForAppShell\(\{\s*directEntryEnabled,\s*adminNavigationEnabled:\s*true,?\s*\}\)/,
  );
  assert.match(adminLayoutSrc, /if \(decision === "REDIRECT_LOGIN"\)\s*\{\s*redirect\("\/login\?next=\/admin"\);/);
  assert.match(adminLayoutSrc, /<AppShell actor=\{navActor\}>/);
  assert.match(adminLayoutSrc, /<AdminSubnav sections=\{visibleAdminSections\(navActor\)\} \/>/);
});

test("M2: resolveAdminLandingPath covers all 4 authorized personas in exact priority order with zero redirect loops", () => {
  const fullAdmin = makeFullActorResolution({
    capabilities: [
      "entry_admin",
      "recruiter_master_manage",
      "team_master_manage",
      "catalog_master_manage",
      "worker_edit_history_view",
    ],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("entry_admin", "ALL"),
      makeGrant("recruiter_master_manage", "ALL"),
      makeGrant("team_master_manage", "ALL"),
      makeGrant("catalog_master_manage", "ALL"),
      makeGrant("worker_edit_history_view", "ALL"),
    ],
  });
  assert.equal(decideAdminAreaAccess({ actor: fullAdmin }), "ALLOW");
  assert.equal(resolveAdminLandingPath(fullAdmin), "/admin/organization/persons");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: fullAdmin }), "ALLOW");

  // HR Operator (has catalog_master_manage + team_master_manage + recruiter_master_manage, lacks entry_admin)
  const hrOperator = makeFullActorResolution({
    capabilities: ["catalog_master_manage", "team_master_manage", "recruiter_master_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("catalog_master_manage", "ALL"),
      makeGrant("team_master_manage", "ALL"),
      makeGrant("recruiter_master_manage", "ALL"),
    ],
  });
  assert.equal(decideAdminAreaAccess({ actor: hrOperator }), "ALLOW");
  assert.equal(resolveAdminLandingPath(hrOperator), "/admin/catalog/personnel");
  assert.equal(decidePersonnelCatalogPageAccess({ actor: hrOperator }), "ALLOW");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: hrOperator }), "ACCESS_DENIED");
  assert.equal(decideAccountAccessPageAccess({ actor: hrOperator }), "ACCESS_DENIED");

  // Catalog-only
  const catalogOnly = makeFullActorResolution({
    capabilities: ["catalog_master_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("catalog_master_manage", "ALL")],
  });
  assert.equal(resolveAdminLandingPath(catalogOnly), "/admin/catalog/personnel");
  assert.equal(decidePersonnelCatalogPageAccess({ actor: catalogOnly }), "ALLOW");

  // BoD / Attendance-only
  const bodAttendance = makeFullActorResolution({
    capabilities: ["entry_privileged_edit"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("entry_privileged_edit", "ALL")],
  });
  assert.equal(resolveAdminLandingPath(bodAttendance), "/admin/attendance");
  assert.equal(decideAttendanceReportPageAccess({ actor: bodAttendance }), "ALLOW");

  // Team Leader
  const teamId = "40000000-0000-4000-8000-000000000001";
  const teamLeader = makeFullActorResolution({
    capabilities: ["team_manager_assign", "report_view", "report_analytics_view"],
    scopes: [{ kind: "team", reference: teamId }],
    effective_grants: [
      makeGrant("team_manager_assign", "CONTEXT_TEAM", teamId),
      makeGrant("report_view", "CONTEXT_TEAM", teamId),
      makeGrant("report_analytics_view", "CONTEXT_TEAM", teamId),
    ],
  });
  assert.equal(resolveAdminLandingPath(teamLeader), "/admin/attendance");
  assert.equal(decideAttendanceReportPageAccess({ actor: teamLeader }), "ALLOW");

  // Department Head
  const deptHead = makeFullActorResolution({
    capabilities: [],
    scopes: [],
    effective_grants: [],
    assigned_roles: [
      {
        role_code: "DEPARTMENT_HEAD",
        scope_kind: "CONTEXT_DEPARTMENT",
        scope_id: "50000000-0000-4000-8000-000000000001",
      },
    ],
  });
  assert.equal(decideAdminAreaAccess({ actor: deptHead }), "ALLOW");
  assert.equal(resolveAdminLandingPath(deptHead), "/admin/attendance");
  assert.equal(decideAttendanceReportPageAccess({ actor: deptHead }), "ALLOW");

  // worker_edit_history_view-only
  const workerHistoryOnly = makeFullActorResolution({
    capabilities: ["worker_edit_history_view"],
    scopes: [{ kind: "all" }],
    effective_grants: [makeGrant("worker_edit_history_view", "ALL")],
  });
  assert.equal(decideAdminAreaAccess({ actor: workerHistoryOnly }), "ALLOW");
  assert.equal(resolveAdminLandingPath(workerHistoryOnly), "/admin/worker-edit-history");
  assert.equal(decideWorkerEditHistoryPageAccess({ actor: workerHistoryOnly }), "ALLOW");

  // Unauthorized / wrong scope / unauthenticated / disabled / null -> null (zero loop)
  const wrongScopeHistory = makeFullActorResolution({
    capabilities: ["worker_edit_history_view"],
    scopes: [{ kind: "team", reference: teamId }],
    effective_grants: [makeGrant("worker_edit_history_view", "CONTEXT_TEAM", teamId)],
  });
  assert.equal(decideAdminAreaAccess({ actor: wrongScopeHistory }), "ACCESS_DENIED");
  assert.equal(resolveAdminLandingPath(wrongScopeHistory), null);
  assert.equal(resolveAdminLandingPath(null), null);
  assert.equal(resolveAdminLandingPath({ ok: false, reason: "UNAUTHENTICATED" }), null);
  assert.equal(resolveAdminLandingPath({ ok: false, reason: "ACTOR_DISABLED" }), null);
});

// =========================================================================
// 6. M3, AdminSubnav Label & Scope Boundaries (No PR-2/PR-3, No AI, Read-only Probes)
// =========================================================================

test("M3: personal Work Reports pages enforce feature flag & session gate while keeping History accessible with zero active obligations", () => {
  const historyOnlyStaff = makeFullActorResolution({
    capabilities: [],
    scopes: [],
    effective_grants: [],
  });

  // Feature flag off -> NOT_FOUND even for valid authenticated user
  assert.equal(
    decidePersonalWorkReportsPageAccess({ enabledFlag: "false", actor: historyOnlyStaff }),
    "NOT_FOUND",
  );
  assert.equal(
    decidePersonalWorkReportsPageAccess({ enabledFlag: undefined, actor: historyOnlyStaff }),
    "NOT_FOUND",
  );

  // Unauthenticated -> REDIRECT_LOGIN
  assert.equal(
    decidePersonalWorkReportsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );

  // Disabled / unmapped -> ACCOUNT_UNAVAILABLE
  for (const reason of ["ACTOR_DISABLED", "ACTOR_MAPPING_MISSING"]) {
    assert.equal(
      decidePersonalWorkReportsPageAccess({ enabledFlag: "true", actor: { ok: false, reason } }),
      "ACCOUNT_UNAVAILABLE",
      reason,
    );
  }

  // Null / transient / ambiguous -> TEMPORARY_UNAVAILABLE
  assert.equal(
    decidePersonalWorkReportsPageAccess({ enabledFlag: "true", actor: null }),
    "TEMPORARY_UNAVAILABLE",
  );
  assert.equal(
    decidePersonalWorkReportsPageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" },
    }),
    "TEMPORARY_UNAVAILABLE",
  );

  // Valid authenticated user with ZERO active obligations / zero management rights -> ALLOW!
  assert.equal(
    decidePersonalWorkReportsPageAccess({ enabledFlag: "true", actor: historyOnlyStaff }),
    "ALLOW",
  );

  // Verify both pages wire the gate & exact next URLs
  const myPage = readRepo("src/app/work-reports/page.tsx");
  const historyPage = readRepo("src/app/work-reports/my-reports/page.tsx");
  assert.match(myPage, /decidePersonalWorkReportsPageAccess\(/);
  assert.match(myPage, /redirect\("\/login\?next=\/work-reports"\)/);
  assert.match(myPage, /<AccountUnavailable \/>/);
  assert.match(myPage, /<TemporaryUnavailable \/>/);

  assert.match(historyPage, /decidePersonalWorkReportsPageAccess\(/);
  assert.match(historyPage, /redirect\("\/login\?next=\/work-reports\/my-reports"\)/);
  assert.match(historyPage, /<AccountUnavailable \/>/);
  assert.match(historyPage, /<TemporaryUnavailable \/>/);
});

test("AdminSubnav dropdown renamed to 'Danh mục tuyển dụng' while preserving all existing PR-1 sections, no AI & no Change Requests restoration", () => {
  const fullAdmin = makeNavActor({
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ kind: "all" }],
    effective_grants: [
      makeGrant("entry_admin", "ALL"),
      makeGrant("recruiter_master_manage", "ALL"),
      makeGrant("team_master_manage", "ALL"),
    ],
  });
  const sections = visibleAdminSections(fullAdmin);
  const grouped = groupAdminSections(sections);
  const recruitmentGroup = grouped.find((item) => item.type === "group" && item.id === "recruitment");
  assert.ok(recruitmentGroup && recruitmentGroup.type === "group");
  assert.equal(recruitmentGroup.label, "Danh mục tuyển dụng");

  // PR #28 consolidates users under `Người dùng` and replaces technical `Quyền hiệu lực` with `Nhóm quyền`!
  assert.equal(sections.some((s) => s.id === "organization-persons" && s.label === "Người dùng"), true);
  assert.equal(sections.some((s) => s.id === "permission-groups" && s.label === "Nhóm quyền"), true);
  assert.equal(sections.some((s) => s.id === "effective-access"), false);
  assert.equal(sections.some((s) => s.id === "accounts"), false);
  assert.equal(sections.some((s) => s.id === "teams"), false);
  assert.equal(ADMIN_SECTIONS.some((s) => s.href.includes("/ai")), false);

  // No AI or Change Requests restored in CURRENT_NAV_ENTRIES
  assert.equal(CURRENT_NAV_ENTRIES.some((e) => e.id.includes("ai") || e.path.includes("/ai")), false);
  const changeRequests = CURRENT_NAV_ENTRIES.find((e) => e.id === "change-requests");
  assert.deepEqual(changeRequests?.visibility, { desktop: false, mobile: false });

  // Read-only nav probes preserved
  const resolveNavSrc = readRepo("src/lib/navigation/resolve-nav-actor.ts");
  assert.match(resolveNavSrc, /createSubmissionRepository\(\)\.hasActiveObligations\(/);
  assert.doesNotMatch(resolveNavSrc, /createSubmissionRepository\(\)\.listMine\(/);
  assert.equal(findEntryByPath("/work-reports/delegations")?.id, "work-report-management");
});
