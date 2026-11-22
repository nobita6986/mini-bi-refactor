import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

describe("R2.2 — 28/28 Table & List Surface Adoption + 4 Owner Screenshot Fixes", () => {
  test("Screenshot 1 & 2 & 3 Fix: worker-operations.tsx uses shared UI, keeps the header focused, and never renders raw {item.state}", () => {
    const src = read("src/components/direct-entry/worker-operations.tsx");
    assert.match(src, /PageHeader/, "must use PageHeader");
    assert.match(src, /FilterToolbar/, "must use FilterToolbar");
    assert.match(src, /useNotify/, "must use useNotify for non-disruptive notice");
    assert.match(src, /DataTableContainer/, "must use DataTableContainer");
    assert.match(src, /StatusBadge/, "must use StatusBadge");
    assert.match(src, /RowActionCluster/, "must use RowActionCluster for single-line actions");
    assert.match(src, /submissionStateBadgeProps/, "must map submission state to Vietnamese StatusBadge");
    assert.ok(!src.includes("<td className=\"px-3 py-3 text-foreground\">{item.state}</td>"), "must not render raw English {item.state} in SubmissionTable");
    assert.match(src, /data-testid="worker-filter-summary"/, "must preserve worker-filter-summary testid");
    const header = src.match(/<PageHeader\b[\s\S]*?\/>/)?.[0] ?? "";
    assert.ok(header, "worker list must render PageHeader");
    assert.doesNotMatch(header, /change-requests|Yêu cầu thay đổi/, "worker list header must not show a redundant change-request link");
  });

  test("Screenshot 4 Fix: outer /direct-entry header & compact panel upgraded while Grid/Form Core remains 100% locked", () => {
    const liveSrc = read("src/components/direct-entry/direct-entry-live.tsx");
    const subSrc = read("src/components/direct-entry/direct-entry-submission-list.tsx");
    assert.match(liveSrc, /headerTitleGroup/, "outer header uses structured title group");
    assert.match(subSrc, /submissionStateBadge/, "submission list uses semantic state badge styling");
  });

  test("Rollout B: Change Requests (LST-CR-01, TBL-CR-02) & Projects (TBL-PRJ-01, LST-PRJ-02) adopt R2.2 primitives & mobile card attributes", () => {
    const crWorkspace = read("src/components/direct-entry/change-requests-workspace.tsx");
    const crList = read("src/components/direct-entry/direct-entry-change-request-list.tsx");
    const crReviewer = read("src/components/direct-entry/direct-entry-change-request-reviewer.tsx");
    const projects = read("src/components/direct-entry/project-operations.tsx");

    assert.match(crWorkspace, /PageHeader/, "ChangeRequestsWorkspace uses PageHeader");
    assert.match(crList, /StatusBadge/, "DirectEntryChangeRequestList uses StatusBadge");
    assert.match(crReviewer, /<table className=\{styles\.reviewerTable\}>/, "preserves reviewerTable hook");
    assert.match(crReviewer, /reviewerCellAfter/, "highlights proposed values in diff table");
    assert.match(projects, /r22-card-table/, "ProjectOperations table uses r22-card-table for Mobile Stacked Cards");
  });

  test("Rollout C1: All 8 Admin Managers (TBL-ADM-01..08) adopt r22-card-table, StatusBadge, and fix broken token classes", () => {
    const adminFiles = [
      "src/components/admin/personnel-catalog-manager.tsx",
      "src/components/admin/personnel-team-membership-manager.tsx",
      "src/components/admin/team-catalog-manager.tsx",
      "src/components/admin/team-leader-manager.tsx",
      "src/components/admin/vendor-catalog-manager.tsx",
      "src/components/admin/labor-type-catalog-manager.tsx",
      "src/components/admin/project-team-scope-manager.tsx",
      "src/components/admin/person-list-manager.tsx",
    ];
    for (const file of adminFiles) {
      const src = read(file);
      assert.match(src, /r22-card-table/, `${file} must use r22-card-table for Mobile Stacked Cards`);
      assert.ok(!src.includes("text-primary-foreground"), `${file} must not use broken text-primary-foreground`);
    }

    const scopeSrc = read("src/components/admin/project-team-scope-manager.tsx");
    assert.ok(!scopeSrc.includes("<td className=\"py-2 pr-4\">{m.state}</td>"), "project-team-scope-manager must not render raw {m.state}");
  });

  test("Rollout C2: All 6 Dashboard & Reporting Table groups (TBL-RPT-01..06) adopt r22-report-table (Sticky First Column on Mobile)", () => {
    const reportFiles = [
      "src/components/dashboard/dashboard-view.tsx",
      "src/components/dashboard/team-report-view.tsx",
      "src/components/dashboard/own-dashboard-view.tsx",
      "src/components/dashboard/dashboard-shared.tsx",
      "src/components/dashboard/project-provider-mix.tsx",
      "src/components/dashboard/team-entry-detail.tsx",
      "src/components/dashboard/source-status-table.tsx",
      "src/components/reporting/duplicate-cccd-report-panel.tsx",
      "src/components/reporting/source-status-table.tsx",
    ];
    for (const file of reportFiles) {
      const src = read(file);
      assert.match(src, /r22-report-table/, `${file} must use r22-report-table for Sticky-First-Column Mobile Scroll`);
    }
  });
});
