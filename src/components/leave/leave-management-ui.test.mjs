import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workspaceSource = readFileSync(
  new URL("./leave-management-workspace.tsx", import.meta.url),
  "utf8",
);
const adminProfilesTableCss = readFileSync(
  new URL("./leave-admin-profiles-table.module.css", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../../app/leave/page.tsx", import.meta.url),
  "utf8",
);
const layoutSource = readFileSync(
  new URL("../../app/leave/layout.tsx", import.meta.url),
  "utf8",
);

test("WP2 /leave route layout and page integrate with AppShell and server actor resolution", () => {
  assert.ok(layoutSource.includes("AppShell"));
  assert.ok(layoutSource.includes("resolveNavActorForAppShell"));

  assert.ok(pageSource.includes("DIRECT_ENTRY_API_ENABLED"));
  assert.ok(pageSource.includes("resolveActorForRequest"));
  assert.ok(pageSource.includes("LeaveManagementWorkspace"));
  assert.ok(pageSource.includes("/login?next=%2Fleave"));
});

test("WP2 LeaveManagementWorkspace uses shared BI UI primitives and enforces motion/storage hygiene", () => {
  for (const requiredImport of [
    "PageShell",
    "PageHeader",
    "Card",
    "CardHeader",
    "DataTableContainer",
    "FilterToolbar",
    "FormDialog",
    "OffsetPager",
    "StatusBadge",
    "StatusBanner",
    "EmptyState",
    "ErrorState",
    "useNotify",
  ]) {
    assert.ok(
      workspaceSource.includes(requiredImport),
      `LeaveManagementWorkspace must use ${requiredImport}`,
    );
  }

  for (const forbiddenToken of [
    "localStorage",
    "sessionStorage",
    "window.confirm",
    "transition-all",
    "animate-spin",
    "animate-bounce",
    "animate-ping",
  ]) {
    assert.equal(
      workspaceSource.includes(forbiddenToken),
      false,
      `LeaveManagementWorkspace must not contain forbidden token: ${forbiddenToken}`,
    );
  }
});

test("WP2 Personal Leave surface supports FULL/AM/PM request creation, FIFO lots, history, ledger, and self-withdraw", () => {
  assert.ok(workspaceSource.includes('data-testid="leave-tab-personal"'));
  assert.ok(workspaceSource.includes('data-testid="leave-create-request-form"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-lots-table"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-my-requests-table"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-ledger-table"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-withdraw-dialog"'));
  // PR #28 D5: shared non-employee account banner and checkbox are completely removed from UI
  assert.equal(workspaceSource.includes('dataTestId="leave-shared-account-banner"'), false);
  assert.equal(workspaceSource.includes('data-testid="leave-profile-shared-checkbox"'), false);
  assert.ok(workspaceSource.includes("/api/leave/me"));
  assert.ok(workspaceSource.includes("/api/leave/requests"));
  assert.ok(workspaceSource.includes("/withdraw"));
});

test("WP2 Approver Inbox surface supports status filters and APPROVE / REJECT / CANCEL_APPROVED decisions", () => {
  assert.ok(workspaceSource.includes('data-testid="leave-tab-approvals"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-approvals-table"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-decision-dialog"'));
  assert.ok(workspaceSource.includes("/api/leave/approvals"));
  assert.ok(workspaceSource.includes("/decision"));
  assert.ok(workspaceSource.includes('"APPROVE"'));
  assert.ok(workspaceSource.includes('"REJECT"'));
  assert.ok(workspaceSource.includes('"CANCEL_APPROVED"'));
});

test("WP2 Admin & HR Config surface covers employee profiles, seniority milestone, department approvers, policy, and mandatory preview-before-apply opening balances", () => {
  assert.ok(workspaceSource.includes('data-testid="leave-tab-admin"'));
  assert.ok(workspaceSource.includes('data-testid="leave-admin-profiles-section"'));
  assert.ok(workspaceSource.includes('data-testid="leave-admin-account-status-filter"'));
  assert.ok(workspaceSource.includes('account_status: accountStatus'));
  assert.ok(workspaceSource.includes('data-testid="leave-admin-policy-section"'));
  assert.ok(workspaceSource.includes('data-testid="leave-admin-opening-section"'));
  assert.ok(workspaceSource.includes("UPSERT_EMPLOYEE_PROFILE"));
  assert.ok(workspaceSource.includes("UPDATE_POLICY"));
  // WP10-4: SET_DEPARTMENT_APPROVER is retired in favor of read-only Org Department Heads (/admin/departments)
  assert.equal(workspaceSource.includes("SET_DEPARTMENT_APPROVER"), false);
  assert.equal(workspaceSource.includes('data-testid="leave-dept-unit-select"'), false);
  assert.equal(workspaceSource.includes('data-testid="leave-dept-approver-select"'), false);
  assert.equal(workspaceSource.includes('data-testid="leave-save-dept-approver-btn"'), false);
  assert.ok(workspaceSource.includes('data-testid="leave-org-department-heads-card"'));
  assert.ok(workspaceSource.includes('href="/admin/departments"'));
  assert.ok(workspaceSource.includes("Quản lý tại Phòng ban"));
  assert.ok(
    workspaceSource.includes(
      "Khi phòng ban chưa có Trưởng phòng đủ điều kiện duyệt, đơn chuyển về Ban Giám đốc/Admin.",
    ),
  );
  assert.equal(workspaceSource.includes("IT/Kế toán hoặc"), false);
  assert.ok(workspaceSource.includes("da.department_name ?? leaveUnitKindLabel(da.unit_kind)"));
  assert.ok(workspaceSource.includes("formatLeaveOrgDepartmentDisplay"));
  assert.ok(workspaceSource.includes('data-testid="leave-summary-org-department"'));
  assert.ok(workspaceSource.includes('data-testid="leave-profile-org-department-readonly"'));
  assert.equal(workspaceSource.includes('data-testid="leave-profile-unit-select"'), false);
  assert.equal(workspaceSource.includes("profileUnitKind"), false);
  const upsertPayloadBlock = workspaceSource.slice(
    workspaceSource.indexOf('operation: "UPSERT_EMPLOYEE_PROFILE"'),
    workspaceSource.indexOf('operation: "UPSERT_EMPLOYEE_PROFILE"') + 600,
  );
  assert.equal(
    upsertPayloadBlock.includes("unit_kind"),
    false,
    "UPSERT_EMPLOYEE_PROFILE client payload must not send unit_kind",
  );
  // PR #28 D4 / T0-R2 / UX-03: per-account MANAGE_MODULE_GRANT is retired in favor of Permission Groups (/admin/access/groups)
  assert.equal(workspaceSource.includes("MANAGE_MODULE_GRANT"), false);
  assert.ok(workspaceSource.includes('data-testid="leave-group-managed-roles-card"'));
  assert.ok(workspaceSource.includes('href="/admin/access/groups"'));
  assert.ok(workspaceSource.includes("/api/leave/admin/opening-balances/preview"));
  assert.ok(workspaceSource.includes("/api/leave/admin/opening-balances/apply"));
  assert.ok(workspaceSource.includes('data-testid="leave-opening-preview-btn"'));
  assert.ok(workspaceSource.includes('data-testid="leave-opening-apply-btn"'));
  assert.ok(workspaceSource.includes("canApplyOpeningBatch"));
  assert.ok(workspaceSource.includes("fetchAllLeaveAdminEmployeeOptions"));
  assert.ok(workspaceSource.includes("resolveAdminSelectorEmployeeOptions"));
  assert.ok(workspaceSource.includes("resolveLeaveOpeningBalanceEmployees"));
  assert.ok(workspaceSource.includes("openingOfficialEmployees"));
  assert.ok(workspaceSource.includes("resolveOpeningRowSelectOptions"));
  assert.ok(workspaceSource.includes("buildOpeningBatchApplyRows"));
  assert.ok(workspaceSource.includes("resolveAppliedOpeningRowCount"));
  assert.ok(workspaceSource.includes("Số dư mục tiêu sau đối soát"));
  assert.ok(workspaceSource.includes("Ngày chốt đối soát số dư:"));
  assert.equal(
    workspaceSource.includes("parsed.data.applied_row_count"),
    false,
    "Toast must use resolveAppliedOpeningRowCount instead of raw parsed.data.applied_row_count",
  );
});

test("WP2 Monthly Attendance & Leave Closing Report surface supports server filters, attendance dates, explicit leave types, and Excel (.xlsx) export without pay_treatment inference", () => {
  assert.ok(workspaceSource.includes('data-testid="leave-tab-report"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-report-filter-toolbar"'));
  assert.ok(workspaceSource.includes('dataTestId="leave-monthly-report-table"'));
  assert.ok(workspaceSource.includes('data-testid="leave-report-export-btn"'));
  assert.ok(workspaceSource.includes("/api/leave/reports/monthly"));
  assert.ok(workspaceSource.includes("buildMonthlyLeaveReportExportUrl"));
  assert.ok(workspaceSource.includes("Chấm công trong tháng"));
  assert.ok(workspaceSource.includes("Chi tiết ngày nghỉ, loại nghỉ & buổi nghỉ"));
  assert.ok(workspaceSource.includes("LEAVE_TYPES"));
  assert.ok(workspaceSource.includes("autoAllocateDraftDaysByBalance"));
  assert.equal(workspaceSource.includes("leavePayTreatmentBadge"), false);
});

test("T1A UI Polish Task 1: leave-admin-profiles-table adds +1px top and top-right rounded header border strictly scoped to desktop", () => {
  assert.match(
    workspaceSource,
    /import styles from "\.\/leave-admin-profiles-table\.module\.css";/,
  );

  // Applied ONLY to leave-admin-profiles-table
  const classMatches = workspaceSource.match(/styles\.leaveAdminProfilesTable/g) ?? [];
  assert.equal(classMatches.length, 1);
  assert.match(
    workspaceSource,
    /<DataTableContainer\s+dataTestId="leave-admin-profiles-table"\s+className=\{styles\.leaveAdminProfilesTable\}/,
  );

  // Scoped desktop-only (@media (min-width: 768px)) so mobile (<768px where r22-card-table hides thead) stays clean
  assert.match(adminProfilesTableCss, /@media\s*\(\s*min-width:\s*768px\s*\)/);
  assert.match(adminProfilesTableCss, /\.leaveAdminProfilesTable::after\s*\{/);
  assert.match(adminProfilesTableCss, /border-top-width:\s*1px/);
  assert.match(adminProfilesTableCss, /border-right-width:\s*1px/);
  assert.match(adminProfilesTableCss, /border-top-right-radius:\s*11px/);
  assert.match(adminProfilesTableCss, /border-top-left-radius:\s*11px/);
  assert.match(adminProfilesTableCss, /border-top-color:\s*inherit/);
  assert.match(adminProfilesTableCss, /border-right-color:\s*inherit/);
  assert.match(adminProfilesTableCss, /pointer-events:\s*none/);
});
