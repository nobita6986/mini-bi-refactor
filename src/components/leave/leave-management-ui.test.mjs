import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workspaceSource = readFileSync(
  new URL("./leave-management-workspace.tsx", import.meta.url),
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
  assert.ok(workspaceSource.includes('dataTestId="leave-shared-account-banner"'));
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
  assert.ok(workspaceSource.includes("SET_DEPARTMENT_APPROVER"));
  assert.ok(workspaceSource.includes("resolveDepartmentApproverMutationPayload"));
  assert.ok(workspaceSource.includes("isAmbiguousLeaveMutationFailure"));
  assert.equal(
    workspaceSource.includes("valid_from: adminData.as_of_date || todayVietnamIsoDate()"),
    false,
    "Department approver mutation must not send stale adminData.as_of_date as valid_from",
  );
  assert.ok(workspaceSource.includes("MANAGE_MODULE_GRANT"));
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
