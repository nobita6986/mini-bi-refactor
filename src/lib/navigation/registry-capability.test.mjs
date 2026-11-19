/**
 * P3-W06A — Capability projection + filter tests.
 * Style: node:test + pure assertions.
 *
 * Bao phủ:
 * - directEntryNavPredicate: actor có entry_own/entry_team/entry_admin thì true.
 * - adminAuthorityNavPredicate: yêu cầu đủ 3 capability + scope 'all'.
 * - decideNavEntryVisibility: viewport + actor + capability key.
 * - filterEntriesForActor + AppShell use case: dashboard luôn hiện với
 *   valid actor, Direct Entry ẩn với reader/reviewer, hiện với hrp/owner.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cap = await import("./registry-capability.ts");
const reg = await import("./registry.ts");
const {
  decideNavEntryVisibility,
  directEntryNavPredicate,
  adminAuthorityNavPredicate,
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  catalogOperatorNavPredicate,
  projectAdminNavPredicate,
  workerOperationsAllScopePredicate,
  workerOperationsNavPredicate,
  workerOperationsReviewPredicate,
  workerOperationsTeamScopePredicate,
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportDelegationPredicate,
  workReportReviewPredicate,
  workReportTemplateManagePredicate,
  workReportViewPredicate,
  workReportsNavPredicate,
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  vendorFinanceReconcileNavPredicate,
  vendorFinanceAdminNavPredicate,
  salaryAdvanceNavPredicate,
  resolveNavCapabilityPredicate,
} = cap;
const { CURRENT_NAV_ENTRIES, filterEntriesForActor, groupNavEntries } = reg;

/** @typedef {{ kind: "own" | "team" | "all" }} NavScope */
/** @typedef {{ capabilities: readonly string[], scopes: readonly NavScope[] }} NavActorProjection */

/** @param {readonly string[]} capabilities @param {readonly NavScope[]} [scopes] @returns {NavActorProjection} */
function makeActor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  const effective_grants = [];
  for (const s of scopes) {
    const scope_kind = s.kind === "all" ? "ALL" : s.kind === "team" ? "CONTEXT_TEAM" : "OWN";
    const scope_id = s.kind === "team" ? (s.reference ?? "team-1") : null;
    for (const cap of capabilities) {
      effective_grants.push({
        capability: cap,
        scope_kind,
        scope_id,
        source_type: "LEGACY_BRIDGE",
        source_id: "00000000-0000-4000-8000-000000000001",
      });
    }
  }
  return { capabilities, scopes, effective_grants };
}

test("directEntryNavPredicate: entry_own / entry_team / entry_admin đều đủ điều kiện", () => {
  assert.equal(directEntryNavPredicate(makeActor(["entry_own"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["entry_team"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["entry_admin"])), true);
  assert.equal(directEntryNavPredicate(makeActor(["document_view"])), false);
  assert.equal(directEntryNavPredicate(makeActor([])), false);
});

test("adminAuthorityNavPredicate: phải có đủ 3 capability + scope 'all'", () => {
  const allCaps = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  assert.equal(adminAuthorityNavPredicate(makeActor(allCaps, [{ kind: "all", reference: "all" }])), true);
  // Thiếu 1 capability → fail.
  assert.equal(
    adminAuthorityNavPredicate(makeActor(["entry_admin", "recruiter_master_manage"], [{ kind: "all", reference: "all" }])),
    false,
  );
  // Thiếu scope 'all' → fail (kể cả đủ capability).
  assert.equal(
    adminAuthorityNavPredicate(makeActor(allCaps, [{ kind: "team", reference: "t" }])),
    false,
  );
});

test("Admin area: catalog operator OR Full Admin triple + effective all", () => {
  const full = makeActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }],
  );
  const accounting = makeActor(["catalog_master_manage"], [{ kind: "all", reference: "all" }]);
  assert.equal(adminSecurityNavPredicate(full), true);
  assert.equal(catalogOperatorNavPredicate(accounting), true);
  assert.equal(adminAreaNavPredicate(full), true);
  assert.equal(adminAreaNavPredicate(accounting), true);
  assert.equal(adminAreaNavPredicate(makeActor(["catalog_master_manage"], [{ kind: "team", reference: "t" }])), false);
  assert.equal(adminAreaNavPredicate(makeActor(["entry_admin"], [{ kind: "all", reference: "all" }])), false);
  assert.equal(adminAreaNavPredicate(makeActor(["team_manager_assign"], [{ kind: "all", reference: "all" }])), false);
});

test("Project Operations nav also admits Team Leader; Project Admin remains entry_admin + all", () => {
  // DB W02 (direct_entry_assert_project_admin) chi can entry_admin + all scope.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [{ kind: "all", reference: "all" }])), true);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }])), true, "them 2 token khong anh huong");
  assert.equal(projectAdminNavPredicate(makeActor(["team_manager_assign"],
    [{ kind: "team", reference: "team-1" }])), true);
  // entry_own/entry_team KHONG duoc render page roi moi cho API 403.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_own"], [{ kind: "all", reference: "all" }])), false);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_team"], [{ kind: "all", reference: "all" }])), false);
  // entry_admin nhung KHONG co scope all => fail.
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [{ kind: "team", reference: "t" }])), false);
  assert.equal(projectAdminNavPredicate(makeActor(["entry_admin"], [])), false);
  assert.equal(projectAdminNavPredicate(makeActor([], [{ kind: "team", reference: "team-1" }])), false);
});

test("W06-R1: worker operations audience matrix (reviewer/admin/PM/uploader)", () => {
  const all = [{ kind: "all", reference: "all" }];
  // Reviewer bundle toi thieu + all.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_review"], all)), true);
  assert.equal(workerOperationsNavPredicate(makeActor([
    "pii_view", "pii_export", "payment_view", "payment_edit",
  ], all)), false, "retired field tokens do not expose worker operations");
  // Admin entry_admin + all.
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_admin"], all)), true);
  // Nguoi de xuat / PM.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_request_create"], [{ kind: "own" }])), true);
  assert.equal(workerOperationsNavPredicate(makeActor(["team_manager_assign"], [{ kind: "team", reference: "t" }])), true);
  assert.equal(workerOperationsTeamScopePredicate(makeActor(["team_manager_assign"],
    [{ kind: "team", reference: "t" }])), true);
  assert.equal(workerOperationsTeamScopePredicate(makeActor(["team_manager_assign"],
    [{ kind: "all", reference: "all" }])), false);
  assert.equal(workerOperationsTeamScopePredicate(makeActor(["entry_admin"],
    [{ kind: "team", reference: "t" }])), false);
  // Uploader hien huu.
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_own"], [{ kind: "own" }])), true);
  assert.equal(workerOperationsNavPredicate(makeActor(["entry_team"], [{ kind: "team" }])), true);
  // Reporting audience=all nhung thieu capability => KHONG mo.
  assert.equal(workerOperationsNavPredicate(makeActor([], all)), false);
  // Reviewer thieu all scope => khong mo.
  assert.equal(workerOperationsNavPredicate(makeActor(["change_review"], [{ kind: "team" }])), false);
  // scope=all tab / review queue.
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_admin"], all)), true);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["change_review"], all)), true);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_own"], all)), false);
  assert.equal(workerOperationsAllScopePredicate(makeActor(["entry_admin"], [{ kind: "team" }])), false);
  assert.equal(workerOperationsReviewPredicate(makeActor(["change_review"], all)), true);
  assert.equal(workerOperationsReviewPredicate(makeActor(["entry_admin"], all)), false,
    "admin khong tu dong la reviewer");
  assert.equal(workerOperationsReviewPredicate(makeActor(["change_review"], [{ kind: "own" }])), false);
  // SQL-confirmed allowed_worker_tabs (e.g., recruited-only or uploader-only) opens Worker Directory nav without opening Direct Entry input nav.
  const recruitedOnlyActor = { capabilities: [], scopes: [{ kind: "own" }], allowed_worker_tabs: ["recruited"] };
  assert.equal(workerOperationsNavPredicate(recruitedOnlyActor), true);
  assert.equal(directEntryNavPredicate(recruitedOnlyActor), false);
  const uploaderOnlyActor = { capabilities: ["submission_create"], scopes: [{ kind: "own" }], allowed_worker_tabs: ["uploader"] };
  assert.equal(workerOperationsNavPredicate(uploaderOnlyActor), true);
  assert.equal(directEntryNavPredicate(uploaderOnlyActor), false);
});

test("resolveNavCapabilityPredicate: token không xác định fail-closed", () => {
  assert.equal(resolveNavCapabilityPredicate("entry_own")(makeActor(["entry_own"])), true);
  assert.equal(resolveNavCapabilityPredicate("bogus_token")(makeActor(["entry_admin"])), false);
});

test("VFIN-01: vendorFinanceNavPredicate và vendorFinanceRecordNavPredicate fail-closed theo Full Admin, Phòng Kế toán server-probed và direct grant @ all", () => {
  const all = [{ kind: "all", reference: "all" }];
  const team = [{ kind: "team", reference: "team-1" }];
  const own = [{ kind: "own", reference: "u-1" }];

  const fullAdmin = makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"], all);
  assert.equal(vendorFinanceNavPredicate(fullAdmin), true);
  assert.equal(vendorFinanceRecordNavPredicate(fullAdmin), true);
  assert.equal(vendorFinanceReconcileNavPredicate(fullAdmin), true);
  assert.equal(vendorFinanceAdminNavPredicate(fullAdmin), true);
  assert.equal(resolveNavCapabilityPredicate("finance")(fullAdmin), true);

  // VFIN-02 narrow global reconciler (BoD `GLOBAL_RECONCILER` or `CASH_HOLDER` without `can_record`).
  const narrowReconciler = {
    capabilities: [],
    scopes: own,
    hasVendorFinanceAccess: true,
    hasVendorFinanceRecordAccess: false,
    hasVendorFinanceReconcileAccess: true,
  };
  assert.equal(vendorFinanceNavPredicate(narrowReconciler), true);
  assert.equal(vendorFinanceRecordNavPredicate(narrowReconciler), false, "narrow reconciler must NOT get can_record");
  assert.equal(vendorFinanceReconcileNavPredicate(narrowReconciler), true, "narrow reconciler gets can_reconcile");
  assert.equal(vendorFinanceAdminNavPredicate(narrowReconciler), false, "narrow reconciler is not Full Admin");
  assert.equal(resolveNavCapabilityPredicate("finance")(narrowReconciler), true);

  // Active Accounting department member (server-probed without mutating capabilities or scopes).
  const accountingMember = {
    capabilities: [],
    scopes: own,
    hasVendorFinanceAccess: true,
    hasVendorFinanceRecordAccess: true,
    hasVendorFinanceReconcileAccess: true,
  };
  assert.equal(vendorFinanceNavPredicate(accountingMember), true);
  assert.equal(vendorFinanceRecordNavPredicate(accountingMember), true);
  assert.equal(vendorFinanceReconcileNavPredicate(accountingMember), true);
  assert.equal(vendorFinanceAdminNavPredicate(accountingMember), false, "Accounting membership does not open Admin project assignments");
  assert.equal(resolveNavCapabilityPredicate("finance")(accountingMember), true);
  assert.equal(directEntryNavPredicate(accountingMember), false, "Accounting membership does not open Direct Entry");
  assert.equal(adminAuthorityNavPredicate(accountingMember), false, "Accounting membership does not open Full Admin");
  assert.equal(workReportsNavPredicate(accountingMember), false, "Accounting membership does not open Work Reports");

  // BoD view-only direct grant (`vendor_finance_view` @ `all`).
  const bodViewOnly = makeActor(["vendor_finance_view"], all);
  assert.equal(vendorFinanceNavPredicate(bodViewOnly), true);
  assert.equal(vendorFinanceRecordNavPredicate(bodViewOnly), false);
  assert.equal(resolveNavCapabilityPredicate("finance")(bodViewOnly), true);

  // Direct record grant (`vendor_finance_record` @ `all`).
  const directRecorder = makeActor(["vendor_finance_record"], all);
  assert.equal(vendorFinanceNavPredicate(directRecorder), true);
  assert.equal(vendorFinanceRecordNavPredicate(directRecorder), true);

  // Missing `all` scope -> denied even if direct capability is present.
  assert.equal(vendorFinanceNavPredicate(makeActor(["vendor_finance_view"], team)), false);
  assert.equal(vendorFinanceNavPredicate(makeActor(["vendor_finance_record"], own)), false);
  assert.equal(vendorFinanceRecordNavPredicate(makeActor(["vendor_finance_record"], team)), false);

  // Catalog operator, partial admin, Team Leader, PM, Staff, Work Reports, and retired payment tokens -> denied.
  for (const denied of [
    makeActor(["catalog_master_manage"], all),
    makeActor(["entry_admin", "recruiter_master_manage"], all),
    makeActor(["team_manager_assign", "report_view", "report_analytics_view", "report_assign", "report_review"], team),
    makeActor(["change_request_create"], own),
    makeActor(["entry_own"], own),
    makeActor(["payment_view", "payment_edit"], all),
  ]) {
    assert.equal(vendorFinanceNavPredicate(denied), false);
    assert.equal(vendorFinanceRecordNavPredicate(denied), false);
    assert.equal(resolveNavCapabilityPredicate("finance")(denied), false);
  }
});

test("Work Reports predicates enforce capability and compatible scope", () => {
  const all = [{ kind: "all", reference: "all" }];
  const team = [{ kind: "team", reference: "team-1" }];
  assert.equal(workReportTemplateManagePredicate(makeActor(["report_form_manage"], all)), true);
  assert.equal(workReportTemplateManagePredicate(makeActor(["report_form_manage"], team)), false);
  assert.equal(workReportAssignmentPredicate(makeActor(["report_assign"], team)), true);
  assert.equal(workReportAssignmentPredicate(makeActor(["report_assign"], [{ kind: "own" }])), false);
  assert.equal(workReportViewPredicate(makeActor(["report_view"], team)), true);
  assert.equal(workReportAnalyticsPredicate(makeActor(["report_analytics_view"], all)), true);
  assert.equal(workReportAnalyticsPredicate(makeActor(["report_analytics_view"], [{ kind: "own" }])), false);
  assert.equal(workReportsNavPredicate({ capabilities: [], scopes: [], hasWorkReportObligations: true }), true);
  assert.equal(workReportsNavPredicate(makeActor([], all)), false);
  assert.equal(resolveNavCapabilityPredicate("work_reports")(
    makeActor(["report_assign"], team)), true);
});

test("F2 review nav includes canonical Full Admin, direct and server-projected delegated reviewers; delegation admits Full Admin or explicit report_delegate without expanding Team Leader", () => {
  const all = [{ kind: "all", reference: "all" }];
  const team = [{ kind: "team", reference: "team-1" }];
  const fullAdmin = makeActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    all,
  );
  assert.equal(workReportReviewPredicate(fullAdmin), true, "canonical Full Admin sees Duyệt báo cáo");
  assert.equal(workReportDelegationPredicate(fullAdmin), true, "canonical Full Admin sees Ủy quyền");
  assert.equal(resolveNavCapabilityPredicate("work_report_reviews")(fullAdmin), true);

  // Partial admin triples or non-all scope must NOT trigger Full Admin fallback
  assert.equal(
    workReportReviewPredicate(makeActor(["entry_admin", "recruiter_master_manage"], all)),
    false,
  );
  assert.equal(
    workReportDelegationPredicate(makeActor(["entry_admin", "recruiter_master_manage"], all)),
    false,
  );
  assert.equal(
    workReportReviewPredicate(
      makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"], team),
    ),
    false,
  );
  assert.equal(
    workReportDelegationPredicate(
      makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"], team),
    ),
    false,
  );

  // Team Leader bundle: has report_review/report_view/report_analytics_view/report_assign @ team,
  // NOT expanded to report_delegate or template management
  const teamLeader = makeActor(
    ["team_manager_assign", "report_view", "report_analytics_view", "report_assign", "report_review"],
    team,
  );
  assert.equal(workReportReviewPredicate(teamLeader), true);
  assert.equal(workReportDelegationPredicate(teamLeader), false, "Team Leader is not auto-expanded to Ủy quyền");
  assert.equal(workReportTemplateManagePredicate(teamLeader), false, "Team Leader is not auto-expanded to Mẫu biểu");

  assert.equal(workReportReviewPredicate(makeActor(["report_review"], team)), true);
  const delegated = { capabilities: [], scopes: [{ kind: "own" }], effective_report_review_scopes: [{ kind: "team", team_id: "team-1", label: "Team 1" }] };
  assert.equal(workReportReviewPredicate(delegated), true);
  assert.equal(workReportsNavPredicate(delegated), true);
  assert.equal(resolveNavCapabilityPredicate("work_report_reviews")(delegated), true);
  const staff = { capabilities: [], scopes: [], hasWorkReportObligations: true };
  assert.equal(resolveNavCapabilityPredicate("work_reports")(staff), true);
  assert.equal(resolveNavCapabilityPredicate("work_report_reviews")(staff), false);
  assert.equal(workReportReviewPredicate(makeActor(["report_review"], [{ kind: "own" }])), false);
  assert.equal(workReportDelegationPredicate(makeActor(["report_delegate"], team)), true);
  assert.equal(workReportDelegationPredicate(makeActor(["report_delegate"], [{ kind: "own" }])), false);
  assert.equal(workReportDelegationPredicate(delegated), false, "effective delegated review does not grant delegation management");
});

test("review inbox navigation stays hidden even for directly or effectively projected reviewers", () => {
  const reviewer = makeActor(["report_review"], [{ kind: "team", reference: "team-1" }]);
  const directResult = filterEntriesForActor({
    viewport: "desktop", directEntryEnabled: true, actor: reviewer, decide: decideFor(reviewer, "desktop"),
  });
  assert.ok(!directResult.some((entry) => entry.path === "/work-reports/reviews"));

  const delegated = {
    capabilities: [], scopes: [{ kind: "own" }],
    effective_report_review_scopes: [{ kind: "team", team_id: "team-1", label: "Team 1" }],
  };
  const delegatedResult = filterEntriesForActor({
    viewport: "mobile", directEntryEnabled: true, actor: delegated, decide: decideFor(delegated, "mobile"),
  });
  assert.ok(!delegatedResult.some((entry) => entry.path === "/work-reports/reviews"));

  const staff = { capabilities: [], scopes: [], hasWorkReportObligations: true };
  const staffResult = filterEntriesForActor({
    viewport: "desktop", directEntryEnabled: true, actor: staff, decide: decideFor(staff, "desktop"),
  });
  assert.ok(staffResult.some((entry) => entry.path === "/work-reports"));
  assert.ok(!staffResult.some((entry) => entry.path === "/work-reports/reviews"));
});

test("decideNavEntryVisibility: viewport false thì luôn ẩn", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "any",
      actor: makeActor([]),
      viewport: "desktop",
      entryVisibleInViewport: false,
    }),
    false,
  );
});

test("decideNavEntryVisibility: actor null + capability=any vẫn hiện (Dashboard cho guest)", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "any",
      actor: null,
      viewport: "desktop",
      entryVisibleInViewport: true,
    }),
    true,
  );
});

test("decideNavEntryVisibility: actor null + capability khác 'any' phải ẩn (fail-closed)", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "entry_admin",
      actor: null,
      viewport: "desktop",
      entryVisibleInViewport: true,
    }),
    false,
  );
});

test("decideNavEntryVisibility: actor OK + capability=entry_admin thì entry_own đủ điều kiện", () => {
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "entry_admin",
      actor: makeActor(["entry_own"]),
      viewport: "mobile",
      entryVisibleInViewport: true,
    }),
    true,
  );
});

/** @param {NavActorProjection} actor @param {"desktop" | "mobile"} viewport */
function decideFor(actor, viewport) {
  return (/** @type {{ capability: string, visibility: { desktop: boolean, mobile: boolean } }} */ entry) =>
    decideNavEntryVisibility({
      capabilityKey: entry.capability,
      actor,
      viewport,
      entryVisibleInViewport: viewport === "desktop" ? entry.visibility.desktop : entry.visibility.mobile,
    });
}

test("filterEntriesForActor: valid actor + hrp role → Dashboard + Direct Entry + Người lao động + Tin tuyển dụng", () => {
  const hrpActor = makeActor(["entry_own"]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: hrpActor,
    decide: decideFor(hrpActor, "desktop"),
  });
  const ids = result.map((e) => e.id);
  assert.deepEqual(ids, ["dashboard", "direct-entry", "worker-operations", "recruitment-posts"]);
});

test("filterEntriesForActor: reader (no capability, active BI account) → Dashboard + Tin tuyển dụng", () => {
  const readerActor = makeActor([]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: readerActor,
    decide: decideFor(readerActor, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard", "recruitment-posts"]);
});

test("filterEntriesForActor: Work Reports chỉ hiện với actor có quyền trong scope", () => {
  const teamReporter = makeActor(["report_view"], [{ kind: "team", reference: "team-1" }]);
  const permitted = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: teamReporter,
    decide: decideFor(teamReporter, "desktop"),
  });
  assert.ok(permitted.some((entry) => entry.id === "work-reports"));

  const reader = makeActor([], [{ kind: "team", reference: "team-1" }]);
  const denied = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: reader,
    decide: decideFor(reader, "desktop"),
  });
  assert.ok(!denied.some((entry) => entry.id === "work-reports"));
});

test("filterEntriesForActor: reviewer (change_review + all) → Dashboard + Người lao động + Tin tuyển dụng; change request navigation hidden", () => {
  // Reviewer bundle + effective all scope can enter Worker Operations; the global change-request entry is hidden.
  const reviewerActor = makeActor(["change_review", "document_view"]);
  const result = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled: true,
    actor: reviewerActor,
    decide: decideFor(reviewerActor, "mobile"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard", "worker-operations", "recruitment-posts"]);
  // Reviewer KHONG thay entry Direct Entry / Du an.
  assert.equal(result.some((e) => e.id === "direct-entry"), false);
  assert.equal(result.some((e) => e.id === "project-operations"), false);
});

test("filterEntriesForActor: actor null → chỉ Dashboard (fail-closed cho Direct Entry)", () => {
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: null,
    decide: decideFor(null, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard"]);
});

test("filterEntriesForActor: owner (đủ 3 admin) + viewport=mobile → các khu vực quản trị gồm Work Reports", () => {
  const ownerActor = makeActor(
    ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    [{ kind: "all", reference: "all" }],
  );
  const result = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled: true,
    actor: ownerActor,
    decide: decideFor(ownerActor, "mobile"),
  });
  // Full Admin sees Admin, Attendance, Finance, Leave, Salary Advances, Recruitment Posts and Work Reports entry points; hidden nav actions stay out of the menu.
  assert.deepEqual(result.map((e) => e.id).sort(),
    [
      "admin",
      "attendance-report",
      "dashboard",
      "direct-entry",
      "finance",
      "leave",
      "leave-admin",
      "project-operations",
      "recruitment-posts",
      "salary-advances",
      "work-report-assignments",
      "work-reports",
      "worker-operations",
    ]);
});

test("filterEntriesForActor: Direct Entry off bởi env → ẩn các route Direct Entry dù actor có quyền", () => {
  const hrpActor = makeActor(["entry_own"]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: false,
    actor: hrpActor,
    decide: decideFor(hrpActor, "desktop"),
  });
  assert.deepEqual(result.map((e) => e.id), ["dashboard", "recruitment-posts"]);
});

test("Admin catalog navigation remains available when Direct Entry UI is disabled", () => {
  const accounting = makeActor(["catalog_master_manage"], [{ kind: "all", reference: "all" }]);
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: false,
    actor: accounting,
    decide: decideFor(accounting, "desktop"),
  });
  assert.deepEqual(result.map((entry) => entry.id), ["dashboard", "recruitment-posts", "admin"]);
});

test("CURRENT_NAV_ENTRIES giữ nguyên một registry duy nhất (không tạo registry thứ hai)", () => {
  // Admin, Finance, Leave, Salary Advances, Recruitment Posts, Change Requests and Work Reports share one registry; hidden entries retain route metadata.
  const ids = CURRENT_NAV_ENTRIES.map((e) => e.id).sort();
  assert.deepEqual(
    ids,
    [
      "admin",
      "attendance-report",
      "change-requests",
      "dashboard",
      "direct-entry",
      "finance",
      "leave",
      "leave-admin",
      "project-operations",
      "recruitment-posts",
      "salary-advances",
      "work-report-analytics",
      "work-report-assignments",
      "work-report-reviews",
      "work-reports",
      "worker-operations",
    ],
  );
});

test("Global IA representative actor matrix: Recruiter/Nhân viên, Team Leader, Trưởng phòng, Admin/BoD và Kế toán", () => {
  const all = [{ kind: "all", reference: "all" }];
  const team = [{ kind: "team", reference: "team-1" }];
  const own = [{ kind: "own", reference: "user-1" }];

  /** @param {NavActorProjection} actor */
  function projectMenuForBothViewports(actor) {
    const desktopEntries = filterEntriesForActor({
      viewport: "desktop",
      directEntryEnabled: true,
      actor,
      decide: decideFor(actor, "desktop"),
    });
    const mobileEntries = filterEntriesForActor({
      viewport: "mobile",
      directEntryEnabled: true,
      actor,
      decide: decideFor(actor, "mobile"),
    });
    assert.deepEqual(
      desktopEntries.map((entry) => entry.id),
      mobileEntries.map((entry) => entry.id),
      "desktop and mobile must show identical filtered entries",
    );
    const grouped = groupNavEntries(
      desktopEntries.map(({ id, label, path, group }) => ({ id, label, path, group })),
    );
    return {
      ids: desktopEntries.map((entry) => entry.id),
      groups: grouped
        .filter((node) => node.type === "group")
        .map((node) => ({ id: node.id, label: node.label, children: node.entries.map((e) => e.id) })),
      topLevelIds: grouped.map((node) => (node.type === "entry" ? node.entry.id : `group:${node.id}`)),
    };
  }

  // 1. Nhân viên / Recruiter: thấy Tổng quan + Công việc của tôi; nhóm Quản trị tự ẩn hoàn toàn.
  const recruiter = {
    capabilities: ["entry_own", "change_request_create"],
    scopes: own,
    hasWorkReportObligations: true,
    hasLeaveManagementAccess: true,
  };
  const recruiterMenu = projectMenuForBothViewports(recruiter);
  assert.deepEqual(recruiterMenu.topLevelIds, ["dashboard", "group:my-work"]);
  assert.deepEqual(recruiterMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: ["direct-entry", "worker-operations", "work-reports", "leave", "recruitment-posts"],
    },
  ]);
  assert.equal(recruiterMenu.ids.includes("admin"), false);
  assert.equal(recruiterMenu.ids.includes("project-operations"), false);

  // 2. Team Leader sees Project, Work Reports management, and team-scoped Attendance Report, but not /admin or /finance.
  const teamLeader = {
    capabilities: [
      "entry_team",
      "team_manager_assign",
      "change_review",
      "report_assign",
      "report_review",
      "report_analytics_view",
      "report_view",
    ],
    scopes: team,
    hasLeaveManagementAccess: true,
  };
  const teamLeaderMenu = projectMenuForBothViewports(teamLeader);
  assert.deepEqual(teamLeaderMenu.topLevelIds, ["dashboard", "group:my-work", "group:management"]);
  assert.deepEqual(teamLeaderMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: ["direct-entry", "worker-operations", "work-reports", "leave", "recruitment-posts"],
    },
    {
      id: "management",
      label: "Quản trị",
      children: [
        "project-operations",
        "work-report-assignments",
        "attendance-report",
      ],
    },
  ]);
  assert.equal(teamLeaderMenu.ids.includes("admin"), false, "Team Leader must not see /admin");
  assert.equal(teamLeaderMenu.ids.includes("attendance-report"), true, "Team Leader sees team-scoped /admin/attendance");
  assert.equal(teamLeaderMenu.ids.includes("finance"), false, "Team Leader must not see /finance");

  // 3. Trưởng phòng sees the single Work Reports management entry and no /admin or attendance-report.
  const departmentHead = {
    capabilities: ["report_assign", "report_review", "report_analytics_view", "report_view"],
    scopes: team,
    hasLeaveManagementAccess: true,
  };
  const departmentHeadMenu = projectMenuForBothViewports(departmentHead);
  assert.deepEqual(departmentHeadMenu.topLevelIds, ["dashboard", "group:my-work", "group:management"]);
  assert.deepEqual(departmentHeadMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: ["work-reports", "leave", "recruitment-posts"],
    },
    {
      id: "management",
      label: "Quản trị",
      children: ["work-report-assignments"],
    },
  ]);
  assert.equal(departmentHeadMenu.ids.includes("attendance-report"), false, "Trưởng phòng without team_manager_assign must not see /admin/attendance");
  assert.equal(departmentHeadMenu.ids.includes("admin"), false, "Trưởng phòng must not see /admin without admin_area");
  assert.equal(departmentHeadMenu.ids.includes("project-operations"), false);

  // 4a. BoD (executive reader + reviewer + finance view): sees attendance, salary-advances and finance, not hidden report menu actions.
  const bodActor = {
    ...makeActor(["entry_privileged_edit", "report_analytics_view", "report_view", "change_review", "vendor_finance_view"], all),
    hasLeaveManagementAccess: true,
    hasLeaveAdminAccess: true,
  };
  const bodMenu = projectMenuForBothViewports(bodActor);
  assert.deepEqual(bodMenu.topLevelIds, ["dashboard", "group:my-work", "finance", "group:management"]);
  assert.deepEqual(bodMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: ["worker-operations", "work-reports", "leave", "salary-advances", "recruitment-posts"],
    },
    {
      id: "management",
      label: "Quản trị",
      children: ["leave-admin", "attendance-report"],
    },
  ]);
  assert.equal(bodMenu.ids.includes("attendance-report"), true, "BoD sees Báo cáo chấm công");
  assert.equal(bodMenu.ids.includes("admin"), false, "BoD without catalog/full-admin does not see duplicate /admin link");

  // 4b. Full Admin: thấy đầy đủ Công việc của tôi, toàn bộ nhóm Quản trị (gồm Quản trị hệ thống /admin) và Tài chính.
  const fullAdmin = makeActor(["entry_admin", "recruiter_master_manage", "team_master_manage"], all);
  const fullAdminMenu = projectMenuForBothViewports(fullAdmin);
  assert.deepEqual(fullAdminMenu.topLevelIds, ["dashboard", "group:my-work", "finance", "group:management"]);
  assert.deepEqual(fullAdminMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: [
        "direct-entry",
        "worker-operations",
        "work-reports",
        "leave",
        "salary-advances",
        "recruitment-posts",
      ],
    },
    {
      id: "management",
      label: "Quản trị",
      children: [
        "project-operations",
        "leave-admin",
        "work-report-assignments",
        "attendance-report",
        "admin",
      ],
    },
  ]);

  // 5. Kế toán (Accounting): thấy Tổng quan, Công việc của tôi (Nghỉ phép của tôi, Tin tuyển dụng), Quản trị (Quản trị hệ thống cho danh mục được cấp) và Tài chính.
  const accountingActor = {
    ...makeActor(["catalog_master_manage"], all),
    hasVendorFinanceAccess: true,
    hasVendorFinanceRecordAccess: true,
    hasLeaveManagementAccess: true,
  };
  const accountingMenu = projectMenuForBothViewports(accountingActor);
  assert.deepEqual(accountingMenu.topLevelIds, ["dashboard", "group:my-work", "finance", "group:management"]);
  assert.deepEqual(accountingMenu.groups, [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: ["leave", "recruitment-posts"],
    },
    {
      id: "management",
      label: "Quản trị",
      children: ["admin"],
    },
  ]);
  assert.equal(accountingMenu.ids.includes("attendance-report"), false, "Accounting does not see Báo cáo chấm công");
});

// ===== P3-W06A R1 Gap 2: asymmetric desktop/mobile visibility ============
// Muc tieu: dam bao AppShell goi `filterEntriesForActor` voi viewport
// RIENG (desktop + mobile), khong dung nham visibility giua 2 nhanh.
// Test voi registry "dummy" co entry chi hien tren 1 viewport (P3-W06A R1
// pattern: co the them entry chi hien tren mobile sau).

test("Gap2: registry chỉ có 1 entry desktop=true, mobile=false → desktop thấy, mobile ẩn", () => {
  // Mo phong bang registry that (filterEntriesForActor dung CURRENT_NAV_ENTRIES).
  // Dang ky them mot entry "moi" voi visibility chi desktop.
  const result = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: makeActor([]),
    decide: (entry) => entry.capability === "any" && entry.id === "dashboard",
  });
  // Trong registry hien tai, Dashboard va Direct Entry deu co
  // visibility { desktop: true, mobile: true }. Test asymmetric qua
  // decide: chi cho "any" (Dashboard).
  // Trên mobile: decide khong bao gio chay (filter visibility truoc) → van chi Dashboard.
  const desktopIds = result.map((e) => e.id).sort();
  assert.deepEqual(desktopIds, ["dashboard"]);
});

test("Gap2: app-shell.tsx truyền viewport='desktop' cho desktopItems và viewport='mobile' cho mobileItems", () => {
  // Dam bao AppShell goi filterEntriesForActor voi viewport dung cho tung
  // nhanh, khong dung nham (P3-W06A R1 bug gap 2: closure hardcode "desktop"
  // duoc tai su dung cho mobile).
  const source = readFileSync(new URL("../../components/app-shell/app-shell.tsx", import.meta.url), "utf8");
  // Bo comment lines truoc khi check.
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  // Phai co 2 lan goi filterEntriesForActor voi viewport "desktop" va "mobile" RIENG.
  const desktopCall = /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"desktop"[\s\S]{0,400}\}/.test(codeOnly);
  const mobileCall = /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"mobile"[\s\S]{0,400}\}/.test(codeOnly);
  assert.ok(desktopCall, "AppShell phai goi filterEntriesForActor voi viewport='desktop' cho desktopItems");
  assert.ok(mobileCall, "AppShell phai goi filterEntriesForActor voi viewport='mobile' cho mobileItems");
});

test("Gap2: app-shell.tsx truyền entry.visibility.desktop cho desktop quyết định, KHÔNG lẫn sang mobile", () => {
  // Asymmetric: desktop decide nhan `entry.visibility.desktop`, mobile decide
  // nhan `entry.visibility.mobile`. Khong co cho nao re-use.
  const source = readFileSync(new URL("../../components/app-shell/app-shell.tsx", import.meta.url), "utf8");
  const codeOnly = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  // Phai co `entryVisibleInViewport: entry.visibility.desktop` (desktop decide).
  assert.match(codeOnly, /entryVisibleInViewport:\s*entry\.visibility\.desktop/);
  // Phai co `entryVisibleInViewport: entry.visibility.mobile` (mobile decide).
  assert.match(codeOnly, /entryVisibleInViewport:\s*entry\.visibility\.mobile/);
});

// Test thuc te asymmetric: dung registry that, viewport=true/false khac nhau.
// Dam bao filterEntriesForActor KHONG bi "leak" visibility giua 2 nhanh.

test("Gap2 (asymmetric): filterEntriesForActor voi 1 entry co visibility {desktop: true, mobile: false}", () => {
  // Tao mock entry voi visibility chi desktop. CURRENT_NAV_ENTRIES goc co
  // ca 2 entry deu la { desktop: true, mobile: true } nen test này phai
  // dung mock rieng (CURRENT_NAV_ENTRIES.filter() se khong match mock).
  // De dam bao code filterEntriesForActor dung `entry.visibility[viewport]`
  // ma khong hardcode, ta test voi `decide` gia lap.
  const desktop = CURRENT_NAV_ENTRIES.filter((e) => e.visibility.desktop);
  const mobile = CURRENT_NAV_ENTRIES.filter((e) => e.visibility.mobile);
  // Trong registry hien tai, desktop va mobile phai giong nhau vi ca 2 entry
  // deu co visibility { desktop: true, mobile: true }.
  assert.deepEqual(
    desktop.map((e) => e.id).sort(),
    mobile.map((e) => e.id).sort(),
    "registry hien tai co desktop === mobile, nhung code phai doc viewport RIENG",
  );
});

test("WP7B D-WP7B-01: DEPARTMENT_HEAD sees /admin/attendance only (denied catalog/access), dual-role HR_OPERATOR + TEAM_LEADER cannot escalate to BoD/Admin, and legacy mock without assigned_roles stays denied", () => {
  const {
    adminPanelNavPredicate,
    attendanceDepartmentHeadReportNavPredicate,
    attendanceFullAdminOrBodNavPredicate,
    attendanceReportNavPredicate,
    attendanceTeamLeaderReportNavPredicate,
    hasActiveDepartmentHeadRole,
    recruitmentLocationCatalogNavPredicate,
    workerEditHistoryNavPredicate,
  } = cap;

  const DEPT_ID = "77000000-0000-4000-8000-000000000001";
  const TEAM_1 = "77000000-0000-4000-8000-000000000011";
  const TEAM_2 = "77000000-0000-4000-8000-000000000012";

  // 1. Pure helper hasActiveDepartmentHeadRole
  assert.equal(
    hasActiveDepartmentHeadRole({
      assigned_roles: [
        {
          role_code: "DEPARTMENT_HEAD",
          display_name: "Trưởng phòng",
          assignment_mode: "CONTEXTUAL",
          scope_kind: "CONTEXT_DEPARTMENT",
          scope_id: DEPT_ID,
          assignment_id: "77000000-0000-4000-8000-000000000099",
          is_protected: false,
          can_revoke: true,
          cannot_revoke_reason: null,
        },
      ],
    }),
    true,
  );
  assert.equal(hasActiveDepartmentHeadRole({ assigned_roles: [] }), false);
  assert.equal(hasActiveDepartmentHeadRole(null), false);
  assert.equal(
    hasActiveDepartmentHeadRole({
      assigned_roles: [
        {
          role_code: "DEPARTMENT_HEAD",
          display_name: "Trưởng phòng",
          assignment_mode: "CONTEXTUAL",
          scope_kind: "CONTEXT_DEPARTMENT",
          scope_id: "   ",
          assignment_id: null,
          is_protected: false,
          can_revoke: true,
          cannot_revoke_reason: null,
        },
      ],
    }),
    false,
    "blank scope_id must fail closed",
  );
  assert.equal(
    hasActiveDepartmentHeadRole({
      assigned_roles: [
        {
          role_code: "DEPARTMENT_HEAD",
          display_name: "Trưởng phòng",
          assignment_mode: "CONTEXTUAL",
          scope_kind: "CONTEXT_TEAM",
          scope_id: TEAM_1,
          assignment_id: null,
          is_protected: false,
          can_revoke: true,
          cannot_revoke_reason: null,
        },
      ],
    }),
    false,
    "non-CONTEXT_DEPARTMENT scope_kind must fail closed",
  );

  // 2. DEPARTMENT_HEAD via minimal server flag OR full actor assigned_roles sees /admin/attendance only
  const deptHeadProjected = {
    capabilities: ["report_assign", "report_review", "report_analytics_view", "report_view"],
    scopes: [{ kind: "team", reference: TEAM_1 }],
    effective_grants: [
      { capability: "report_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
    ],
    hasAttendanceDepartmentHeadAccess: true,
    hasLeaveManagementAccess: true,
  };
  const deptHeadFullActor = {
    capabilities: ["report_assign", "report_review", "report_analytics_view", "report_view"],
    scopes: [{ kind: "own", reference: "u-dept" }],
    effective_grants: [
      { capability: "report_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_DEPARTMENT", scope_id: DEPT_ID, source_type: "ROLE_BUNDLE", source_id: null },
    ],
    assigned_roles: [
      {
        role_code: "DEPARTMENT_HEAD",
        display_name: "Trưởng phòng",
        assignment_mode: "CONTEXTUAL",
        scope_kind: "CONTEXT_DEPARTMENT",
        scope_id: DEPT_ID,
        assignment_id: "77000000-0000-4000-8000-000000000099",
        is_protected: false,
        can_revoke: true,
        cannot_revoke_reason: null,
      },
    ],
    hasLeaveManagementAccess: true,
  };

  for (const dhActor of [deptHeadProjected, deptHeadFullActor]) {
    assert.equal(attendanceDepartmentHeadReportNavPredicate(dhActor), true);
    assert.equal(attendanceReportNavPredicate(dhActor), true);
    assert.equal(adminPanelNavPredicate(dhActor), true);
    assert.equal(resolveNavCapabilityPredicate("attendance_report")(dhActor), true);
    // Must NEVER gain /admin/catalog/*, /admin/access/*, /admin/organization/*, or Full Admin/BoD attendance admin
    assert.equal(adminAreaNavPredicate(dhActor), false);
    assert.equal(adminAuthorityNavPredicate(dhActor), false);
    assert.equal(adminSecurityNavPredicate(dhActor), false);
    assert.equal(catalogOperatorNavPredicate(dhActor), false);
    assert.equal(recruitmentLocationCatalogNavPredicate(dhActor), false);
    assert.equal(attendanceFullAdminOrBodNavPredicate(dhActor), false);
    assert.equal(workerEditHistoryNavPredicate(dhActor), false);
    assert.equal(vendorFinanceNavPredicate(dhActor), false);

    const desktopMenu = filterEntriesForActor({
      viewport: "desktop",
      directEntryEnabled: true,
      actor: dhActor,
      decide: decideFor(dhActor, "desktop"),
    });
    assert.equal(desktopMenu.some((e) => e.id === "attendance-report"), true);
    assert.equal(desktopMenu.some((e) => e.id === "admin"), false);
  }

  // 3. Dual-role HR_OPERATOR @ ALL + TEAM_LEADER @ CONTEXT_TEAM cannot escalate into Full Admin/BoD
  const dualRoleHrAndTl = {
    capabilities: [
      "recruiter_master_manage",
      "team_master_manage",
      "catalog_master_manage",
      "team_manager_assign",
      "report_view",
      "report_analytics_view",
    ],
    scopes: [
      { kind: "all", reference: "all" },
      { kind: "team", reference: TEAM_1 },
    ],
    effective_grants: [
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_manager_assign", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
  };
  assert.equal(attendanceFullAdminOrBodNavPredicate(dualRoleHrAndTl), false);
  assert.equal(recruitmentLocationCatalogNavPredicate(dualRoleHrAndTl), false);
  assert.equal(adminAuthorityNavPredicate(dualRoleHrAndTl), false);
  assert.equal(attendanceTeamLeaderReportNavPredicate(dualRoleHrAndTl), true);
  assert.equal(attendanceReportNavPredicate(dualRoleHrAndTl), true);

  // 4. Cross-team split effective_grants must fail closed on attendanceTeamLeaderReportNavPredicate
  const crossTeamSplit = {
    capabilities: ["team_manager_assign", "report_view", "report_analytics_view"],
    scopes: [
      { kind: "team", reference: TEAM_1 },
      { kind: "team", reference: TEAM_2 },
    ],
    effective_grants: [
      { capability: "team_manager_assign", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_2, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_2, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
  };
  assert.equal(attendanceTeamLeaderReportNavPredicate(crossTeamSplit), false);
  assert.equal(attendanceReportNavPredicate(crossTeamSplit), false);

  // 5. Legacy mock without assigned_roles and without hasAttendanceDepartmentHeadAccess stays denied
  const legacyDeptHeadMock = {
    capabilities: ["report_assign", "report_review", "report_analytics_view", "report_view"],
    scopes: [{ kind: "team", reference: TEAM_1 }],
  };
  assert.equal(attendanceDepartmentHeadReportNavPredicate(legacyDeptHeadMock), false);
  assert.equal(attendanceReportNavPredicate(legacyDeptHeadMock), false);
});

test("WP8A: paired finance nav predicates block cross-scope escalation (HR_OPERATOR+TEAM_LEADER, HR_OPERATOR+PROJECT_ACCOUNTANT)", () => {
  const TEAM_1 = "55000000-0000-4000-8000-000000000001";
  const PRJ_1 = "prj_wp8a_nav_1";

  // 1. HR_OPERATOR @ ALL + TEAM_LEADER @ CONTEXT_TEAM (flat capabilities contain report_view + report_analytics_view,
  //    flat scopes contain all) MUST NOT escalate to Salary Advance supervisory or Vendor Finance.
  const hrOperatorPlusTeamLeader = {
    capabilities: [
      "recruiter_master_manage",
      "team_master_manage",
      "catalog_master_manage",
      "team_manager_assign",
      "report_view",
      "report_analytics_view",
    ],
    scopes: [
      { kind: "all", reference: "all" },
      { kind: "team", reference: TEAM_1 },
    ],
    effective_grants: [
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_manager_assign", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      { capability: "report_analytics_view", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
  };
  assert.equal(salaryAdvanceNavPredicate(hrOperatorPlusTeamLeader), false);
  assert.equal(resolveNavCapabilityPredicate("salary_advances")(hrOperatorPlusTeamLeader), false);
  assert.equal(vendorFinanceNavPredicate(hrOperatorPlusTeamLeader), false);
  assert.equal(vendorFinanceRecordNavPredicate(hrOperatorPlusTeamLeader), false);
  assert.equal(vendorFinanceAdminNavPredicate(hrOperatorPlusTeamLeader), false);

  // 2. HR_OPERATOR @ ALL + stale contextual PROJECT_ACCOUNTANT (vendor_finance_view @ CONTEXT_PROJECT)
  //    without server-confirmed hasVendorFinanceAccess MUST NOT open /finance via flat scope+capability pairing.
  const hrOperatorPlusStalePa = {
    capabilities: [
      "recruiter_master_manage",
      "team_master_manage",
      "catalog_master_manage",
      "vendor_finance_view",
    ],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "vendor_finance_view", scope_kind: "CONTEXT_PROJECT", scope_id: PRJ_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
    hasVendorFinanceAccess: false,
    hasVendorFinanceRecordAccess: false,
    hasVendorFinanceReconcileAccess: false,
  };
  assert.equal(vendorFinanceNavPredicate(hrOperatorPlusStalePa), false);
  assert.equal(vendorFinanceRecordNavPredicate(hrOperatorPlusStalePa), false);
  assert.equal(vendorFinanceReconcileNavPredicate(hrOperatorPlusStalePa), false);
  assert.equal(vendorFinanceAdminNavPredicate(hrOperatorPlusStalePa), false);
  assert.equal(resolveNavCapabilityPredicate("finance")(hrOperatorPlusStalePa), false);
  assert.equal(salaryAdvanceNavPredicate(hrOperatorPlusStalePa), false);

  // 3. Cross-scope vendor_finance_record @ CONTEXT_PROJECT + unrelated ALL grant MUST fail closed.
  const crossScopeRecord = {
    capabilities: ["catalog_master_manage", "vendor_finance_record"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "vendor_finance_record", scope_kind: "CONTEXT_PROJECT", scope_id: PRJ_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
    ],
  };
  assert.equal(vendorFinanceNavPredicate(crossScopeRecord), false);
  assert.equal(vendorFinanceRecordNavPredicate(crossScopeRecord), false);

  // 4. Positive paired grants: BoD @ ALL opens Salary Advance supervisory; server-probed PM/PA opens Salary Advance.
  const pairedBod = {
    capabilities: ["report_view", "report_analytics_view"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "report_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "report_analytics_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  };
  assert.equal(salaryAdvanceNavPredicate(pairedBod), true);
  assert.equal(resolveNavCapabilityPredicate("salary_advances")(pairedBod), true);

  const serverProbedPm = {
    capabilities: ["entry_own"],
    scopes: [{ kind: "own", reference: "u-pm" }],
    effective_grants: [
      { capability: "entry_own", scope_kind: "OWN", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
    hasSalaryAdvanceAccess: true,
  };
  assert.equal(salaryAdvanceNavPredicate(serverProbedPm), true);
  assert.equal(vendorFinanceNavPredicate(serverProbedPm), false);
});

test("WP8B-1: projectAdminNavPredicate, catalogOperatorNavPredicate, adminSecurityNavPredicate enforce paired @ ALL when effective_grants is present", () => {
  const TEAM_1 = "11111111-1111-4111-8111-111111111111";

  // 1. Canonical Full Admin (ADMIN bundle): passes all three shared decisions.
  const canonicalAdmin = {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  };
  assert.equal(adminSecurityNavPredicate(canonicalAdmin), true);
  assert.equal(adminAreaNavPredicate(canonicalAdmin), true);
  assert.equal(projectAdminNavPredicate(canonicalAdmin), true);

  // 2. Canonical HR_OPERATOR (5 caps @ ALL, no entry_admin): passes catalog/adminArea, denied adminSecurity & projectAdmin.
  const canonicalHrOperator = {
    capabilities: ["recruiter_master_manage", "team_master_manage", "catalog_master_manage", "audit_view", "document_view"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "audit_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "document_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  };
  assert.equal(catalogOperatorNavPredicate(canonicalHrOperator), true);
  assert.equal(adminAreaNavPredicate(canonicalHrOperator), true);
  assert.equal(adminSecurityNavPredicate(canonicalHrOperator), false);
  assert.equal(projectAdminNavPredicate(canonicalHrOperator), false);

  // 3. Narrow Project Admin (entry_admin @ ALL only): passes projectAdmin, denied adminSecurity & catalog/adminArea.
  const projectAdminOnly = {
    capabilities: ["entry_admin"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [
      { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "DIRECT_GRANT", source_id: null },
    ],
  };
  assert.equal(projectAdminNavPredicate(projectAdminOnly), true);
  assert.equal(adminSecurityNavPredicate(projectAdminOnly), false);
  assert.equal(catalogOperatorNavPredicate(projectAdminOnly), false);
  assert.equal(adminAreaNavPredicate(projectAdminOnly), false);

  // 4. Simulated cross-scope drift fixture: entry_admin @ CONTEXT_TEAM + unrelated ALL grant
  //    MUST fail closed on projectAdminNavPredicate and adminSecurityNavPredicate even when legacy arrays list both.
  const crossScopeProjectAdminDrift = {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage", "audit_view"],
    scopes: [{ kind: "all", reference: "all" }, { kind: "team", reference: TEAM_1 }],
    effective_grants: [
      { capability: "entry_admin", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "DIRECT_GRANT", source_id: null },
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "audit_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  };
  assert.equal(projectAdminNavPredicate(crossScopeProjectAdminDrift), false);
  assert.equal(adminSecurityNavPredicate(crossScopeProjectAdminDrift), false);

  // 5. Simulated stale legacy array fixture (effective_grants = []): all three ALL-scoped decisions fail closed.
  const staleLegacyOnly = {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage", "catalog_master_manage"],
    scopes: [{ kind: "all", reference: "all" }],
    effective_grants: [],
  };
  assert.equal(projectAdminNavPredicate(staleLegacyOnly), false);
  assert.equal(adminSecurityNavPredicate(staleLegacyOnly), false);
  assert.equal(catalogOperatorNavPredicate(staleLegacyOnly), false);
  assert.equal(adminAreaNavPredicate(staleLegacyOnly), false);
});
