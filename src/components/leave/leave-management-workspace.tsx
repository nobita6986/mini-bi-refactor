"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { AttendanceExplanationWorkspace } from "@/components/attendance/attendance-explanation-workspace";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import type { LeaveAdminAccountStatusFilter } from "@/lib/leave/leave-contract";
import {
  LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS,
  LEAVE_EMPLOYMENT_STATUSES,
  LEAVE_MODULE_GRANT_ROLES,
  LEAVE_REQUEST_STATUS_FILTERS,
  LEAVE_SESSION_CODES,
  LEAVE_TYPES,
  LEAVE_UNIT_KINDS,
  autoAllocateDraftDaysByBalance,
  buildMonthlyLeaveReportExportUrl,
  buildMonthlyLeaveReportQuery,
  buildOpeningBatchApplyRows,
  canApplyOpeningBatch,
  canWithdrawOwnLeaveRequest,
  computeOpeningBatchDraftSignature,
  currentVietnamLeaveYear,
  currentVietnamMonthIso,
  evaluateLeaveRequestDraft,
  fetchAllLeaveAdminEmployeeOptions,
  formatHalfDayUnits,
  formatIsoDateVi,
  formatLeaveAdminAccountOptionLabel,
  formatSignedHalfDayUnits,
  halfDayUnitsToDays,
  leaveDecisionActionLabel,
  leaveEmploymentStatusBadge,
  leaveErrorMessage,
  leaveFallbackReasonLabel,
  leaveLedgerEntryTypeLabel,
  leaveLotKindLabel,
  leaveModuleGrantRoleLabel,
  leaveOpeningRowErrorLabel,
  leaveRequestStatusBadge,
  leaveRouteKindLabel,
  leaveSessionLabel,
  leaveSessionShortLabel,
  leaveTypeBadge,
  leaveTypeLabel,
  leaveTypeShortLabel,
  leaveUnitKindLabel,
  mergeLeaveAdminKnownAccounts,
  newClientIdempotencyKey,
  isAmbiguousLeaveMutationFailure,
  parseDaysInputToHalfDayUnits,
  parseOpeningBalanceBulkText,
  resolveAdminSelectorEmployeeOptions,
  resolveAppliedOpeningRowCount,
  resolveDepartmentApproverMutationPayload,
  resolveKnownLeaveAccountLabel,
  resolveLeaveOpeningBalanceEmployees,
  resolveOpeningRowSelectOptions,
  resolveRequestTypeBreakdown,
  resolveVisibleLeaveTabs,
  todayVietnamIsoDate,
  validateApproverDecisionInput,
  type DepartmentApproverMutationPayload,
  type LeaveAccountProjection,
  type LeaveAdminEmployeeItemProjection,
  type LeaveAdminOverviewProjection,
  type LeaveApprovalInboxProjection,
  type LeaveDecisionCode,
  type LeaveDepartmentApproverUnitKind,
  type LeaveDraftDayRow,
  type LeaveEmploymentStatus,
  type LeaveMeSummaryProjection,
  type LeaveModuleGrantRole,
  type LeaveMonthlyReportProjection,
  type LeaveOpeningPreviewProjection,
  type LeaveRequestProjection,
  type LeaveRequestStatusFilter,
  type LeaveSessionCode,
  type LeaveType,
  type LeaveUnitKind,
  type LeaveWorkspaceTab,
  type OpeningBatchRowInput,
} from "@/lib/leave/leave-ui-model";

const INBOX_PAGE_SIZE = 20;
const ADMIN_PAGE_SIZE = 25;
const REPORT_PAGE_SIZE = 50;

type OpeningDraftUiRow = {
  id: string;
  app_user_id: string;
  selected_label?: string;
  carry_over_days: string;
  opening_current_year_days: string;
  seniority_days: string;
  note: string;
};

function createEmptyOpeningDraftRow(defaultUserId = "", selectedLabel?: string): OpeningDraftUiRow {
  return {
    id: newClientIdempotencyKey("open-row"),
    app_user_id: defaultUserId,
    ...(selectedLabel ? { selected_label: selectedLabel } : {}),
    carry_over_days: "0",
    opening_current_year_days: "0",
    seniority_days: "0",
    note: "",
  };
}

function buildOpeningContractRowsFromUi(openingUiRows: readonly OpeningDraftUiRow[]): {
  validFormat: boolean;
  formatError: string | null;
  rows: OpeningBatchRowInput[];
} {
  if (openingUiRows.length === 0) {
    return {
      validFormat: false,
      formatError: "Vui lòng thêm ít nhất 1 nhân sự vào danh sách khởi tạo đầu kỳ.",
      rows: [],
    };
  }
  const resultRows: OpeningBatchRowInput[] = [];
  for (let i = 0; i < openingUiRows.length; i += 1) {
    const r = openingUiRows[i]!;
    if (!r.app_user_id.trim()) {
      return {
        validFormat: false,
        formatError: `Dòng ${i + 1}: Chưa chọn hoặc nhập mã tài khoản nhân sự.`,
        rows: [],
      };
    }
    const carryUnits = parseDaysInputToHalfDayUnits(r.carry_over_days, 120);
    const currentUnits = parseDaysInputToHalfDayUnits(r.opening_current_year_days, 120);
    const seniorityUnits = parseDaysInputToHalfDayUnits(r.seniority_days, 60);
    if (carryUnits === null || currentUnits === null || seniorityUnits === null) {
      return {
        validFormat: false,
        formatError: `Dòng ${i + 1}: Số ngày phép phải là bội số của 0,5 ngày (ví dụ: 0, 0.5, 1, 1.5).`,
        rows: [],
      };
    }
    resultRows.push({
      app_user_id: r.app_user_id.trim(),
      carry_over_units: carryUnits,
      opening_current_year_units: currentUnits,
      seniority_units: seniorityUnits,
      note: r.note.trim() || null,
    });
  }
  return {
    validFormat: true,
    formatError: null,
    rows: resultRows,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<{
  ok: boolean;
  status: number;
  data?: T;
  errorCode?: string;
}> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const envelope =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { ok?: unknown; data?: unknown; code?: unknown; error?: unknown })
      : null;

  if (!response.ok) {
    const code =
      typeof envelope?.code === "string"
        ? envelope.code
        : typeof envelope?.error === "string"
          ? envelope.error
          : "LEAVE_INTERNAL_ERROR";
    return {
      ok: false,
      status: response.status,
      errorCode: code,
    };
  }

  if (envelope?.ok !== true || !Object.prototype.hasOwnProperty.call(envelope, "data")) {
    return {
      ok: false,
      status: response.status,
      errorCode: "LEAVE_INTERNAL_ERROR",
    };
  }

  return {
    ok: true,
    status: response.status,
    data: envelope.data as T,
  };
}

export function LeaveManagementWorkspace({
  viewMode = "personal",
  initialAdminTab = "admin",
}: {
  viewMode?: "personal" | "admin";
  initialAdminTab?: "admin" | "reports";
}) {
  const notify = useNotify();
  const yearSelectId = useId();
  const reasonTextareaId = useId();

  const [leaveYear, setLeaveYear] = useState<number>(() => currentVietnamLeaveYear());
  const [activeTab, setActiveTab] = useState<LeaveWorkspaceTab | "explanations">(
    viewMode === "admin" ? initialAdminTab : "personal",
  );

  // 1. Personal Summary State
  const [meLoading, setMeLoading] = useState<boolean>(true);
  const [meErrorCode, setMeErrorCode] = useState<string | null>(null);
  const [summary, setSummary] = useState<LeaveMeSummaryProjection | null>(null);

  // Create Leave Request Draft State
  const [draftDays, setDraftDays] = useState<LeaveDraftDayRow[]>(
    () => [{ leave_date: todayVietnamIsoDate(), session_code: "FULL", leave_type: "ANNUAL" }],
  );
  const [draftReason, setDraftReason] = useState<string>("");
  const [creatingRequest, setCreatingRequest] = useState<boolean>(false);

  // Withdraw Request Dialog State
  const [withdrawTarget, setWithdrawTarget] = useState<LeaveRequestProjection | null>(null);
  const [withdrawReason, setWithdrawReason] = useState<string>("");
  const [withdrawing, setWithdrawing] = useState<boolean>(false);

  // 2. Approver Inbox State
  const [inboxStatusFilter, setInboxStatusFilter] = useState<LeaveRequestStatusFilter>("PENDING");
  const [inboxPage, setInboxPage] = useState<number>(1);
  const [inboxLoading, setInboxLoading] = useState<boolean>(false);
  const [inboxErrorCode, setInboxErrorCode] = useState<string | null>(null);
  const [inboxData, setInboxData] = useState<LeaveApprovalInboxProjection | null>(null);

  // Approver Decision Dialog State
  const [decisionTarget, setDecisionTarget] = useState<LeaveRequestProjection | null>(null);
  const [decisionAction, setDecisionAction] = useState<LeaveDecisionCode>("APPROVE");
  const [decisionReason, setDecisionReason] = useState<string>("");
  const [submittingDecision, setSubmittingDecision] = useState<boolean>(false);

  // 3. Admin Config & Opening Balance State
  const [adminSubTab, setAdminSubTab] = useState<"profiles" | "policy" | "opening">("profiles");
  const [adminSearchInput, setAdminSearchInput] = useState<string>("");
  const [adminAppliedSearch, setAdminAppliedSearch] = useState<string>("");
  const [adminAccountStatus, setAdminAccountStatus] =
    useState<LeaveAdminAccountStatusFilter>("ACTIVE");
  const [adminPage, setAdminPage] = useState<number>(1);
  const [adminLoading, setAdminLoading] = useState<boolean>(false);
  const [adminErrorCode, setAdminErrorCode] = useState<string | null>(null);
  const [adminData, setAdminData] = useState<LeaveAdminOverviewProjection | null>(null);
  const [adminOptionEmployees, setAdminOptionEmployees] = useState<
    LeaveAdminEmployeeItemProjection[]
  >([]);
  const [adminOptionLoaded, setAdminOptionLoaded] = useState<boolean>(false);
  const [knownAccountsById, setKnownAccountsById] = useState<
    ReadonlyMap<string, LeaveAccountProjection>
  >(() => new Map());

  // Admin Policy Form State
  const [policyExpiryMonth, setPolicyExpiryMonth] = useState<string>("3");
  const [policyExpiryDay, setPolicyExpiryDay] = useState<string>("31");
  const [policyReason, setPolicyReason] = useState<string>("");
  const [savingPolicy, setSavingPolicy] = useState<boolean>(false);

  // Admin Department Approver Form State
  const [deptUnitKind, setDeptUnitKind] = useState<LeaveDepartmentApproverUnitKind>("MARKETING");
  const [deptApproverUserId, setDeptApproverUserId] = useState<string>("");
  const [deptReason, setDeptReason] = useState<string>("");
  const [savingDeptApprover, setSavingDeptApprover] = useState<boolean>(false);
  const [pendingDeptApproverPayload, setPendingDeptApproverPayload] =
    useState<DepartmentApproverMutationPayload | null>(null);

  // Admin Module Grant Form State
  const [grantUserId, setGrantUserId] = useState<string>("");
  const [grantRoleCode, setGrantRoleCode] = useState<LeaveModuleGrantRole>("HR_REPORT_VIEWER");
  const [grantReason, setGrantReason] = useState<string>("");
  const [savingGrant, setSavingGrant] = useState<boolean>(false);

  // Admin Employee Profile Dialog State
  const [editingEmployee, setEditingEmployee] =
    useState<LeaveAdminEmployeeItemProjection | null>(null);
  const [profileIsShared, setProfileIsShared] = useState<boolean>(false);
  const [profileStatus, setProfileStatus] = useState<LeaveEmploymentStatus>("OFFICIAL");
  const [profileUnitKind, setProfileUnitKind] = useState<LeaveUnitKind>("RECRUITMENT");
  const [profileWorkStartDate, setProfileWorkStartDate] = useState<string>("");
  const [profileOfficialDate, setProfileOfficialDate] = useState<string>("");
  const [profileSeniorityDate, setProfileSeniorityDate] = useState<string>("");
  const [profileSeniorityDays, setProfileSeniorityDays] = useState<string>("0");
  const [profileReason, setProfileReason] = useState<string>("");
  const [savingProfile, setSavingProfile] = useState<boolean>(false);

  // Admin Opening Balance State (Preview -> Apply)
  const [openingYear, setOpeningYear] = useState<number>(() => currentVietnamLeaveYear());
  const [openingUiRows, setOpeningUiRows] = useState<OpeningDraftUiRow[]>(() => [
    createEmptyOpeningDraftRow(),
  ]);
  const [openingBulkText, setOpeningBulkText] = useState<string>("");
  const [openingShowBulkPaste, setOpeningShowBulkPaste] = useState<boolean>(false);
  const [openingReason, setOpeningReason] = useState<string>("");
  const [openingPreviewLoading, setOpeningPreviewLoading] = useState<boolean>(false);
  const [openingApplyLoading, setOpeningApplyLoading] = useState<boolean>(false);
  const [openingPreviewResult, setOpeningPreviewResult] =
    useState<LeaveOpeningPreviewProjection | null>(null);
  const [openingPreviewSignature, setOpeningPreviewSignature] = useState<string | null>(null);

  // 4. Monthly Report State
  const [reportMonth, setReportMonth] = useState<string>(() => currentVietnamMonthIso());
  const [reportUnitKind, setReportUnitKind] = useState<LeaveUnitKind | "ALL">("ALL");
  const [reportSearchInput, setReportSearchInput] = useState<string>("");
  const [reportAppliedSearch, setReportAppliedSearch] = useState<string>("");
  const [reportPage, setReportPage] = useState<number>(1);
  const [reportLoading, setReportLoading] = useState<boolean>(false);
  const [reportErrorCode, setReportErrorCode] = useState<string | null>(null);
  const [reportData, setReportData] = useState<LeaveMonthlyReportProjection | null>(null);
  const [exportingExcel, setExportingExcel] = useState<boolean>(false);

  // Load Personal Summary
  const loadMySummary = useCallback(async (targetYear: number) => {
    await Promise.resolve();
    setMeLoading(true);
    setMeErrorCode(null);
    try {
      const response = await fetch(`/api/leave/me?year=${encodeURIComponent(String(targetYear))}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const parsed = await parseJsonResponse<LeaveMeSummaryProjection>(response);
      if (!parsed.ok || !parsed.data) {
        setMeErrorCode(parsed.errorCode ?? "LEAVE_INTERNAL_ERROR");
        setSummary(null);
      } else {
        setSummary(parsed.data);
      }
    } catch {
      setMeErrorCode("LEAVE_INTERNAL_ERROR");
      setSummary(null);
    } finally {
      setMeLoading(false);
    }
  }, []);

  // Load Approver Inbox
  const loadInbox = useCallback(
    async (statusFilter: LeaveRequestStatusFilter, page: number) => {
      await Promise.resolve();
      setInboxLoading(true);
      setInboxErrorCode(null);
      const offset = Math.max(0, (page - 1) * INBOX_PAGE_SIZE);
      const qs = new URLSearchParams({
        status: statusFilter,
        limit: String(INBOX_PAGE_SIZE),
        offset: String(offset),
      });
      try {
        const response = await fetch(`/api/leave/approvals?${qs.toString()}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const parsed = await parseJsonResponse<LeaveApprovalInboxProjection>(response);
        if (!parsed.ok || !parsed.data) {
          setInboxErrorCode(parsed.errorCode ?? "LEAVE_INTERNAL_ERROR");
        } else {
          setInboxData(parsed.data);
        }
      } catch {
        setInboxErrorCode("LEAVE_INTERNAL_ERROR");
      } finally {
        setInboxLoading(false);
      }
    },
    [],
  );

  // Load Admin Config
  const loadAdminConfig = useCallback(async (
    search: string,
    page: number,
    accountStatus: LeaveAdminAccountStatusFilter,
  ) => {
    await Promise.resolve();
    setAdminLoading(true);
    setAdminErrorCode(null);
    const offset = Math.max(0, (page - 1) * ADMIN_PAGE_SIZE);
    const qs = new URLSearchParams({
      limit: String(ADMIN_PAGE_SIZE),
      offset: String(offset),
      account_status: accountStatus,
    });
    if (search.trim()) {
      qs.set("search", search.trim());
    }
    try {
      const response = await fetch(`/api/leave/admin/config?${qs.toString()}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const parsed = await parseJsonResponse<LeaveAdminOverviewProjection>(response);
      if (!parsed.ok || !parsed.data) {
        setAdminErrorCode(parsed.errorCode ?? "LEAVE_INTERNAL_ERROR");
      } else {
        const overviewData = parsed.data;
        setAdminData(overviewData);
        setKnownAccountsById((prev) =>
          mergeLeaveAdminKnownAccounts(
            prev,
            overviewData.employees.map((emp) => emp.account),
            overviewData.department_approvers.map((da) => da.approver),
            overviewData.module_grants.map((gr) => gr.account),
          ),
        );
        if (overviewData.policy.carry_over_expiry_month !== null) {
          setPolicyExpiryMonth(String(overviewData.policy.carry_over_expiry_month));
        }
        if (overviewData.policy.carry_over_expiry_day !== null) {
          setPolicyExpiryDay(String(overviewData.policy.carry_over_expiry_day));
        }
      }
    } catch {
      setAdminErrorCode("LEAVE_INTERNAL_ERROR");
    } finally {
      setAdminLoading(false);
    }
  }, []);

  // Load Unpaginated / Unfiltered Active Employee Options for Admin Dropdowns
  const loadAdminEmployeeOptions = useCallback(async () => {
    await Promise.resolve();
    const result = await fetchAllLeaveAdminEmployeeOptions(
      async ({ limit, offset, account_status }) => {
        const qs = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          account_status,
        });
        try {
          const response = await fetch(`/api/leave/admin/config?${qs.toString()}`, {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
          });
          const parsed = await parseJsonResponse<LeaveAdminOverviewProjection>(response);
          if (!parsed.ok || !parsed.data) {
            return {
              ok: false as const,
              errorCode: parsed.errorCode ?? "LEAVE_INTERNAL_ERROR",
            };
          }
          return {
            ok: true as const,
            data: parsed.data,
          };
        } catch {
          return {
            ok: false as const,
            errorCode: "LEAVE_INTERNAL_ERROR",
          };
        }
      },
    );

    if (result.ok) {
      setAdminOptionEmployees(result.employees);
      setAdminOptionLoaded(true);
      const officialIds = new Set(
        resolveLeaveOpeningBalanceEmployees(result.employees).map((emp) =>
          emp.account.app_user_id.trim().toLowerCase(),
        ),
      );
      setOpeningUiRows((prev) =>
        prev.map((row) => {
          const key = row.app_user_id.trim().toLowerCase();
          if (!key || officialIds.has(key)) {
            return row;
          }
          return {
            ...row,
            app_user_id: "",
            selected_label: undefined,
          };
        }),
      );
      setKnownAccountsById((prev) =>
        mergeLeaveAdminKnownAccounts(
          prev,
          result.allEmployees.map((emp) => emp.account),
        ),
      );
    }
  }, []);

  // Load Monthly Report
  const loadMonthlyReport = useCallback(
    async (month: string, unitKind: LeaveUnitKind | "ALL", search: string, page: number) => {
      await Promise.resolve();
      setReportLoading(true);
      setReportErrorCode(null);
      const offset = Math.max(0, (page - 1) * REPORT_PAGE_SIZE);
      const query = buildMonthlyLeaveReportQuery({
        month,
        unit_kind: unitKind,
        search,
        limit: REPORT_PAGE_SIZE,
        offset,
      });
      try {
        const response = await fetch(`/api/leave/reports/monthly${query}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const parsed = await parseJsonResponse<LeaveMonthlyReportProjection>(response);
        if (!parsed.ok || !parsed.data) {
          setReportErrorCode(parsed.errorCode ?? "LEAVE_INTERNAL_ERROR");
        } else {
          setReportData(parsed.data);
        }
      } catch {
        setReportErrorCode("LEAVE_INTERNAL_ERROR");
      } finally {
        setReportLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    queueMicrotask(() => {
      void loadMySummary(leaveYear);
    });
  }, [leaveYear, loadMySummary]);

  const authority = summary?.authority ?? null;

  useEffect(() => {
    if (viewMode === "personal" && authority?.can_approve_requests) {
      queueMicrotask(() => {
        void loadInbox(inboxStatusFilter, inboxPage);
      });
    }
  }, [viewMode, authority?.can_approve_requests, inboxStatusFilter, inboxPage, loadInbox]);

  useEffect(() => {
    if (activeTab === "admin" && authority?.can_manage_config) {
      queueMicrotask(() => {
        void loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
      });
    }
  }, [activeTab, authority?.can_manage_config, adminAppliedSearch, adminAccountStatus, adminPage, loadAdminConfig]);

  useEffect(() => {
    if (activeTab === "admin" && authority?.can_manage_config) {
      queueMicrotask(() => {
        void loadAdminEmployeeOptions();
      });
    }
  }, [activeTab, authority?.can_manage_config, loadAdminEmployeeOptions]);

  useEffect(() => {
    if (activeTab === "reports" && authority?.can_view_monthly_report) {
      queueMicrotask(() => {
        void loadMonthlyReport(reportMonth, reportUnitKind, reportAppliedSearch, reportPage);
      });
    }
  }, [
    activeTab,
    authority?.can_view_monthly_report,
    reportMonth,
    reportUnitKind,
    reportAppliedSearch,
    reportPage,
    loadMonthlyReport,
  ]);

  const visibleTabs = useMemo(() => {
    const tabs: ReadonlyArray<{
      readonly id: LeaveWorkspaceTab | "explanations";
      readonly label: string;
      readonly badgeCount?: number;
    }> = resolveVisibleLeaveTabs(
      authority,
      inboxStatusFilter === "PENDING" ? inboxData?.total : undefined,
    );
    if (viewMode === "admin") {
      return tabs.filter((tab) => tab.id === "admin" || tab.id === "reports");
    }
    const personalTabs: Array<{
      readonly id: LeaveWorkspaceTab | "explanations";
      readonly label: string;
      readonly badgeCount?: number;
    }> = tabs.filter((tab) => tab.id === "personal" || tab.id === "approvals");
    if (!authority?.is_shared_non_employee) {
      personalTabs.push({
        id: "explanations",
        label: "Giải trình chấm công",
      });
    }
    return personalTabs;
  }, [authority, inboxStatusFilter, inboxData?.total, viewMode]);

  const draftEvaluation = useMemo(
    () =>
      evaluateLeaveRequestDraft({
        days: draftDays,
        reason: draftReason,
        leaveYear,
        balance: summary?.balance ?? null,
      }),
    [draftDays, draftReason, leaveYear, summary?.balance],
  );

  // Convert Opening Balance UI rows into contract rows
  const parsedOpeningContractRows = useMemo(
    () => buildOpeningContractRowsFromUi(openingUiRows),
    [openingUiRows],
  );

  const currentOpeningSignature = useMemo(
    () => computeOpeningBatchDraftSignature(openingYear, parsedOpeningContractRows.rows),
    [openingYear, parsedOpeningContractRows.rows],
  );

  const openingApplyGuard = useMemo(
    () =>
      canApplyOpeningBatch({
        leaveYear: openingYear,
        rows: parsedOpeningContractRows.rows,
        preview: openingPreviewResult,
        previewSignature: openingPreviewSignature,
      }),
    [
      openingYear,
      parsedOpeningContractRows.rows,
      openingPreviewResult,
      openingPreviewSignature,
    ],
  );

  const canApplyOpening =
    parsedOpeningContractRows.validFormat &&
    openingApplyGuard.ok &&
    !openingApplyLoading &&
    !openingPreviewLoading;

  // Handlers for Create Leave Request
  const handleAddDraftDay = () => {
    setDraftDays((prev) => [
      ...prev,
      { leave_date: todayVietnamIsoDate(), session_code: "FULL", leave_type: "ANNUAL" },
    ]);
  };

  const handleRemoveDraftDay = (index: number) => {
    setDraftDays((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== index)));
  };

  const handleChangeDraftDayDate = (index: number, nextDate: string) => {
    setDraftDays((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, leave_date: nextDate } : item)),
    );
  };

  const handleChangeDraftDaySession = (index: number, nextSession: LeaveSessionCode) => {
    setDraftDays((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, session_code: nextSession } : item)),
    );
  };

  const handleChangeDraftDayLeaveType = (index: number, nextLeaveType: LeaveType) => {
    setDraftDays((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, leave_type: nextLeaveType } : item)),
    );
  };

  const handleSplitDraftDayToHalfDays = (index: number) => {
    setDraftDays((prev) => {
      const target = prev[index];
      if (!target || target.session_code !== "FULL") return prev;
      const primaryType: LeaveType = target.leave_type ?? "ANNUAL";
      const secondaryType: LeaveType = primaryType === "ANNUAL" ? "UNPAID" : "ANNUAL";
      return [
        ...prev.slice(0, index),
        { leave_date: target.leave_date, session_code: "AM", leave_type: primaryType },
        { leave_date: target.leave_date, session_code: "PM", leave_type: secondaryType },
        ...prev.slice(index + 1),
      ];
    });
  };

  const handleAutoSplitDraftByBalance = () => {
    const availableAnnualUnits = summary?.balance.available_units ?? 0;
    setDraftDays((prev) =>
      autoAllocateDraftDaysByBalance(prev, availableAnnualUnits, "UNPAID"),
    );
  };

  const handleSubmitLeaveRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draftEvaluation.valid || creatingRequest) return;

    setCreatingRequest(true);
    try {
      const response = await fetch("/api/leave/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          days: draftDays.map((d) => ({
            leave_date: d.leave_date,
            session_code: d.session_code,
            leave_type: d.leave_type ?? "ANNUAL",
          })),
          reason: draftReason.trim() || null,
          idempotency_key: newClientIdempotencyKey("leave-create"),
        }),
      });
      const parsed = await parseJsonResponse<{ request_id: string }>(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể gửi đơn xin nghỉ",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã gửi đơn xin nghỉ phép",
        description: `Đơn nghỉ (${formatHalfDayUnits(draftEvaluation.total_units)}) đã được chuyển tới bộ phận duyệt.`,
      });
      setDraftReason("");
      setDraftDays([{ leave_date: todayVietnamIsoDate(), session_code: "FULL", leave_type: "ANNUAL" }]);
      await loadMySummary(leaveYear);
      if (authority?.can_approve_requests) {
        await loadInbox(inboxStatusFilter, inboxPage);
      }
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể gửi đơn nghỉ phép lúc này. Vui lòng thử lại.",
      });
    } finally {
      setCreatingRequest(false);
    }
  };

  // Handler for Self-Withdraw Leave Request
  const handleConfirmWithdraw = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!withdrawTarget || withdrawing) return;

    setWithdrawing(true);
    try {
      const response = await fetch(
        `/api/leave/requests/${encodeURIComponent(withdrawTarget.request_id)}/withdraw`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            expected_row_version: withdrawTarget.row_version,
            reason: withdrawReason.trim() || null,
            idempotency_key: newClientIdempotencyKey("leave-withdraw"),
          }),
        },
      );
      const parsed = await parseJsonResponse<{ status: string }>(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể rút đơn nghỉ phép",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã rút đơn nghỉ phép",
        description: "Đơn xin nghỉ đang chờ duyệt đã được rút thành công.",
      });
      setWithdrawTarget(null);
      setWithdrawReason("");
      await loadMySummary(leaveYear);
      if (authority?.can_approve_requests) {
        await loadInbox(inboxStatusFilter, inboxPage);
      }
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể rút đơn nghỉ phép lúc này.",
      });
    } finally {
      setWithdrawing(false);
    }
  };

  // Handler for Approver Decision
  const openDecisionDialog = (item: LeaveRequestProjection, action: LeaveDecisionCode) => {
    setDecisionTarget(item);
    setDecisionAction(action);
    setDecisionReason("");
  };

  const handleConfirmDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!decisionTarget || submittingDecision) return;

    const validation = validateApproverDecisionInput({
      actorAppUserId: summary?.authority.app_user_id ?? null,
      request: decisionTarget,
      decision: decisionAction,
      reason: decisionReason,
    });
    if (!validation.ok) {
      notify.warning({
        title: "Chưa đủ điều kiện xử lý đơn",
        description: validation.message,
      });
      return;
    }

    setSubmittingDecision(true);
    try {
      const response = await fetch(
        `/api/leave/approvals/${encodeURIComponent(decisionTarget.request_id)}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            decision: decisionAction,
            expected_row_version: decisionTarget.row_version,
            reason: decisionReason.trim() || null,
            idempotency_key: newClientIdempotencyKey("leave-decision"),
          }),
        },
      );
      const parsed = await parseJsonResponse<{ status: string }>(response);
      if (!parsed.ok) {
        notify.error({
          title: "Thao tác duyệt không thành công",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã cập nhật trạng thái đơn nghỉ",
        description: `${leaveDecisionActionLabel(decisionAction)} thành công cho nhân sự ${decisionTarget.requester?.display_name ?? decisionTarget.requester?.login_id ?? ""}.`,
      });
      setDecisionTarget(null);
      setDecisionReason("");
      await loadInbox(inboxStatusFilter, inboxPage);
      await loadMySummary(leaveYear);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể gửi quyết định duyệt lúc này.",
      });
    } finally {
      setSubmittingDecision(false);
    }
  };

  // Handlers for Admin Config Actions
  const handleSavePolicy = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adminData || savingPolicy) return;
    setSavingPolicy(true);
    try {
      const response = await fetch("/api/leave/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation: "UPDATE_POLICY",
          carry_over_expiry_month: Number(policyExpiryMonth),
          carry_over_expiry_day: Number(policyExpiryDay),
          expected_row_version: adminData.policy.row_version,
          reason: policyReason.trim() || null,
          idempotency_key: newClientIdempotencyKey("leave-policy"),
        }),
      });
      const parsed = await parseJsonResponse(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể lưu chính sách nghỉ phép",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã cập nhật chính sách phép",
        description: `Phép chuyển năm được dùng đến hết ngày ${policyExpiryDay}/${policyExpiryMonth} hằng năm.`,
      });
      setPolicyReason("");
      await loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
      await loadMySummary(leaveYear);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể cập nhật chính sách lúc này.",
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleSaveDepartmentApprover = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!adminData || savingDeptApprover) return;
    if (!deptApproverUserId.trim()) {
      notify.warning({
        title: "Thiếu thông tin người duyệt",
        description: "Vui lòng chọn người duyệt bộ phận.",
      });
      return;
    }

    const existingCurrent = adminData.department_approvers.find(
      (item) => item.unit_kind === deptUnitKind && item.is_current,
    );
    const payload = resolveDepartmentApproverMutationPayload({
      unitKind: deptUnitKind,
      approverAppUserId: deptApproverUserId,
      expectedRowVersion:
        pendingDeptApproverPayload &&
        pendingDeptApproverPayload.unit_kind === deptUnitKind &&
        pendingDeptApproverPayload.approver_app_user_id === deptApproverUserId.trim() &&
        pendingDeptApproverPayload.reason === (deptReason.trim() || null)
          ? pendingDeptApproverPayload.expected_row_version
          : (existingCurrent?.row_version ?? 0),
      reason: deptReason,
      pendingPayload: pendingDeptApproverPayload,
    });

    setSavingDeptApprover(true);
    try {
      const response = await fetch("/api/leave/admin/config", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": payload.idempotency_key,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          ...payload,
          operation: "SET_DEPARTMENT_APPROVER",
        }),
      });
      const parsed = await parseJsonResponse(response);
      if (!parsed.ok) {
        if (
          isAmbiguousLeaveMutationFailure({
            ok: false,
            status: parsed.status,
            errorCode: parsed.errorCode ?? null,
          })
        ) {
          setPendingDeptApproverPayload(payload);
        } else {
          setPendingDeptApproverPayload(null);
        }
        notify.error({
          title: "Không thể cập nhật người duyệt bộ phận",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      setPendingDeptApproverPayload(null);
      notify.success({
        title: "Đã lưu người duyệt bộ phận",
        description: `Đã cập nhật người duyệt cho bộ phận ${leaveUnitKindLabel(deptUnitKind)}.`,
      });
      setDeptReason("");
      await loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
    } catch {
      setPendingDeptApproverPayload(payload);
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể cập nhật người duyệt lúc này.",
      });
    } finally {
      setSavingDeptApprover(false);
    }
  };

  const handleGrantModuleRole = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingGrant) return;
    if (!grantUserId.trim()) {
      notify.warning({
        title: "Thiếu thông tin phân quyền",
        description: "Vui lòng chọn tài khoản.",
      });
      return;
    }

    setSavingGrant(true);
    try {
      const response = await fetch("/api/leave/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation: "MANAGE_MODULE_GRANT",
          action: "GRANT",
          target_app_user_id: grantUserId.trim(),
          role_code: grantRoleCode,
          expected_row_version: 0,
          reason: grantReason.trim() || null,
          idempotency_key: newClientIdempotencyKey("leave-grant"),
        }),
      });
      const parsed = await parseJsonResponse(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể cấp quyền module nghỉ phép",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã cấp quyền thành công",
        description: `Đã cấp quyền ${leaveModuleGrantRoleLabel(grantRoleCode)}.`,
      });
      setGrantReason("");
      await loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể cấp quyền lúc này.",
      });
    } finally {
      setSavingGrant(false);
    }
  };

  const handleRevokeModuleRole = async (
    targetUserId: string,
    roleCode: LeaveModuleGrantRole,
    rowVersion: number,
  ) => {
    if (savingGrant) return;
    setSavingGrant(true);
    try {
      const response = await fetch("/api/leave/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation: "MANAGE_MODULE_GRANT",
          action: "REVOKE",
          target_app_user_id: targetUserId,
          role_code: roleCode,
          expected_row_version: rowVersion,
          reason: null,
          idempotency_key: newClientIdempotencyKey("leave-revoke"),
        }),
      });
      const parsed = await parseJsonResponse(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể thu hồi quyền",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã thu hồi quyền",
        description: `Đã thu hồi quyền ${leaveModuleGrantRoleLabel(roleCode)}.`,
      });
      await loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể thu hồi quyền lúc này.",
      });
    } finally {
      setSavingGrant(false);
    }
  };

  const openEditProfileDialog = (emp: LeaveAdminEmployeeItemProjection) => {
    setEditingEmployee(emp);
    setProfileIsShared(emp.profile.is_shared_non_employee);
    setProfileStatus(emp.profile.employment_status);
    setProfileUnitKind(emp.profile.unit_kind);
    setProfileWorkStartDate(emp.profile.work_start_date ?? "");
    setProfileOfficialDate(emp.profile.official_effective_date ?? "");
    setProfileSeniorityDate(emp.profile.next_seniority_effective_date ?? "");
    setProfileSeniorityDays(String(halfDayUnitsToDays(emp.profile.next_seniority_units)));
    setProfileReason("");
  };

  const handleSaveEmployeeProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingEmployee || savingProfile) return;

    const canEditSeniority = Boolean(authority?.is_full_admin || authority?.is_bod);
    const parsedSeniorityUnits = canEditSeniority
      ? parseDaysInputToHalfDayUnits(profileSeniorityDays, 60)
      : editingEmployee.profile.next_seniority_units;

    if (parsedSeniorityUnits === null) {
      notify.warning({
        title: "Số ngày phép thâm niên không hợp lệ",
        description: "Số ngày phép tăng thêm phải là bội số của 0,5 ngày (ví dụ: 0, 1, 1.5).",
      });
      return;
    }

    setSavingProfile(true);
    try {
      const response = await fetch("/api/leave/admin/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation: "UPSERT_EMPLOYEE_PROFILE",
          target_app_user_id: editingEmployee.account.app_user_id,
          is_shared_non_employee: profileIsShared,
          employment_status: profileIsShared ? "UNCONFIGURED" : profileStatus,
          unit_kind: profileIsShared ? "UNCLASSIFIED" : profileUnitKind,
          work_start_date: profileIsShared ? null : profileWorkStartDate.trim() || null,
          official_effective_date:
            profileIsShared || profileStatus !== "OFFICIAL"
              ? null
              : profileOfficialDate.trim() || null,
          next_seniority_effective_date: canEditSeniority
            ? profileSeniorityDate.trim() || null
            : editingEmployee.profile.next_seniority_effective_date,
          next_seniority_units: parsedSeniorityUnits,
          expected_row_version: editingEmployee.profile.row_version,
          reason: profileReason.trim() || null,
          idempotency_key: newClientIdempotencyKey("leave-profile"),
        }),
      });
      const parsed = await parseJsonResponse(response);
      if (!parsed.ok) {
        notify.error({
          title: "Không thể lưu hồ sơ nghỉ phép",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      notify.success({
        title: "Đã lưu hồ sơ nghỉ phép",
        description: `Đã cập nhật cấu hình nghỉ phép cho ${editingEmployee.account.display_name}.`,
      });
      setEditingEmployee(null);
      await Promise.all([
        loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus),
        loadAdminEmployeeOptions(),
      ]);
      await loadMySummary(leaveYear);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể lưu hồ sơ nghỉ phép lúc này.",
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const nonSharedEmployees = useMemo(
    () =>
      resolveAdminSelectorEmployeeOptions({
        optionCatalogEmployees: adminOptionEmployees,
        fallbackPageEmployees: adminData?.employees,
        optionCatalogLoaded: adminOptionLoaded,
      }),
    [adminOptionEmployees, adminData?.employees, adminOptionLoaded],
  );

  const openingOfficialEmployees = useMemo(
    () => resolveLeaveOpeningBalanceEmployees(nonSharedEmployees),
    [nonSharedEmployees],
  );

  const effectiveKnownAccountsById = useMemo(
    () =>
      mergeLeaveAdminKnownAccounts(
        knownAccountsById,
        adminOptionEmployees.map((emp) => emp.account),
        (adminData?.employees ?? []).map((emp) => emp.account),
        (adminData?.department_approvers ?? []).map((da) => da.approver),
        (adminData?.module_grants ?? []).map((gr) => gr.account),
        (openingPreviewResult?.rows ?? []).map((r) => r.account),
      ),
    [
      knownAccountsById,
      adminOptionEmployees,
      adminData?.employees,
      adminData?.department_approvers,
      adminData?.module_grants,
      openingPreviewResult?.rows,
    ],
  );

  // Handlers for Opening Balance Preview & Apply
  const handleParseOpeningBulkText = () => {
    const parsed = parseOpeningBalanceBulkText(
      openingBulkText,
      nonSharedEmployees,
    );
    if (parsed.parseErrors.length > 0) {
      notify.warning({
        title: "Dữ liệu dán nhanh có lỗi định dạng",
        description: parsed.parseErrors[0] ?? "Vui lòng kiểm tra lại định dạng dòng dán.",
      });
      return;
    }
    if (parsed.rows.length === 0) {
      notify.warning({
        title: "Chưa có dòng dữ liệu",
        description: "Vui lòng dán ít nhất 1 dòng dữ liệu số dư đầu kỳ.",
      });
      return;
    }
    setOpeningUiRows(
      parsed.rows.map((row) => ({
        id: newClientIdempotencyKey("open-row"),
        app_user_id: row.app_user_id,
        selected_label: resolveKnownLeaveAccountLabel(
          row.app_user_id,
          effectiveKnownAccountsById,
          openingOfficialEmployees,
        ),
        carry_over_days: String(halfDayUnitsToDays(row.carry_over_units)),
        opening_current_year_days: String(halfDayUnitsToDays(row.opening_current_year_units)),
        seniority_days: String(halfDayUnitsToDays(row.seniority_units)),
        note: row.note ?? "",
      })),
    );
    setOpeningShowBulkPaste(false);
    setOpeningBulkText("");
    notify.info({
      title: "Đã nạp dữ liệu vào bảng dự thảo",
      description: `Đã nạp ${parsed.rows.length} dòng. Vui lòng bấm "1. Xem trước & Kiểm tra" trước khi áp dụng.`,
    });
  };

  const handlePreviewOpeningBalances = async () => {
    if (!parsedOpeningContractRows.validFormat) {
      notify.warning({
        title: "Dữ liệu đầu kỳ chưa hợp lệ",
        description:
          parsedOpeningContractRows.formatError ?? "Vui lòng kiểm tra lại các dòng dữ liệu.",
      });
      return;
    }

    setOpeningPreviewLoading(true);
    try {
      const response = await fetch("/api/leave/admin/opening-balances/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          leave_year: openingYear,
          rows: parsedOpeningContractRows.rows,
        }),
      });
      const parsed = await parseJsonResponse<LeaveOpeningPreviewProjection>(response);
      if (!parsed.ok || !parsed.data) {
        notify.error({
          title: "Không thể xem trước lô số dư đầu kỳ",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      const previewData = parsed.data;
      setOpeningPreviewResult(previewData);
      setOpeningPreviewSignature(currentOpeningSignature);
      setKnownAccountsById((prev) =>
        mergeLeaveAdminKnownAccounts(
          prev,
          previewData.rows.map((r) => r.account),
        ),
      );
      if (parsed.data.valid && parsed.data.error_row_count === 0) {
        notify.success({
          title: "Kiểm tra xem trước hợp lệ",
          description: `Tất cả ${parsed.data.row_count} dòng đều hợp lệ. Bạn có thể bấm Áp dụng chính thức.`,
        });
      } else {
        notify.warning({
          title: "Phát hiện dòng chưa hợp lệ khi xem trước",
          description: `Có ${parsed.data.error_row_count}/${parsed.data.row_count} dòng bị lỗi. Vui lòng điều chỉnh và xem trước lại.`,
        });
      }
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể thực hiện xem trước số dư đầu kỳ lúc này.",
      });
    } finally {
      setOpeningPreviewLoading(false);
    }
  };

  const handleApplyOpeningBalances = async () => {
    if (!canApplyOpening) return;

    setOpeningApplyLoading(true);
    try {
      const applyRows = buildOpeningBatchApplyRows(
        parsedOpeningContractRows.rows,
        openingPreviewResult,
      );
      const response = await fetch("/api/leave/admin/opening-balances/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          leave_year: openingYear,
          rows: applyRows,
          reason: openingReason.trim() || null,
          idempotency_key: newClientIdempotencyKey("leave-opening-apply"),
        }),
      });
      const parsed = await parseJsonResponse<Record<string, unknown>>(
        response,
      );
      if (!parsed.ok || !parsed.data) {
        if (parsed.errorCode === "LEAVE_OPENING_PREVIEW_STALE") {
          setOpeningPreviewResult(null);
          setOpeningPreviewSignature(null);
        }
        notify.error({
          title: "Áp dụng số dư đầu kỳ không thành công",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      const appliedRowCount = resolveAppliedOpeningRowCount(
        parsed.data,
        parsedOpeningContractRows.rows.length,
      );
      notify.success({
        title: "Đã áp dụng số dư đầu kỳ thành công",
        description: `Đã khởi tạo số dư đầu kỳ năm ${openingYear} cho ${appliedRowCount} nhân sự.`,
      });
      setOpeningPreviewResult(null);
      setOpeningPreviewSignature(null);
      setOpeningReason("");
      setOpeningUiRows([createEmptyOpeningDraftRow()]);
      await loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
      await loadMySummary(leaveYear);
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể áp dụng số dư đầu kỳ lúc này.",
      });
    } finally {
      setOpeningApplyLoading(false);
    }
  };

  // Handler for Monthly Report Excel Export
  const handleExportMonthlyReportExcel = async () => {
    if (exportingExcel) return;
    setExportingExcel(true);
    const exportUrl = buildMonthlyLeaveReportExportUrl({
      month: reportMonth,
      unit_kind: reportUnitKind,
      search: reportAppliedSearch,
    });
    try {
      const response = await fetch(exportUrl, {
        method: "GET",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const parsed = await parseJsonResponse(response);
        notify.error({
          title: "Không thể xuất file Excel",
          description: leaveErrorMessage(parsed.errorCode),
        });
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `bao-cao-chot-cong-phep-${reportMonth}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      notify.success({
        title: "Đã xuất báo cáo Excel",
        description: `Đã tải xuống báo cáo chốt công & phép kỳ ${reportMonth}.`,
      });
    } catch {
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể tải báo cáo Excel lúc này.",
      });
    } finally {
      setExportingExcel(false);
    }
  };

  const inboxPageCount = Math.max(
    1,
    Math.ceil((inboxData?.total ?? 0) / (inboxData?.limit ?? INBOX_PAGE_SIZE)),
  );
  const adminPageCount = Math.max(
    1,
    Math.ceil((adminData?.total_employees ?? 0) / (adminData?.limit ?? ADMIN_PAGE_SIZE)),
  );
  const reportPageCount = Math.max(
    1,
    Math.ceil((reportData?.total ?? 0) / (reportData?.limit ?? REPORT_PAGE_SIZE)),
  );

  return (
    <PageShell dataTestId="leave-management-workspace">
      <PageHeader
        eyebrow="Quản trị Nhân sự & Chấm công"
        title={viewMode === "admin" ? "Quản trị nghỉ phép" : "Nghỉ phép của tôi"}
        badge={
          viewMode === "personal" && summary ? (
            <StatusBadge
              tone={leaveEmploymentStatusBadge(summary.balance.employment_status).tone}
              dot
            >
              {leaveEmploymentStatusBadge(summary.balance.employment_status).label}
            </StatusBadge>
          ) : null
        }
        description={
          viewMode === "admin"
            ? "Cấu hình chính sách, hồ sơ, người duyệt và số dư phép; theo dõi báo cáo chốt công & phép theo quyền được cấp."
            : "Theo dõi quỹ phép cá nhân, tạo đơn xin nghỉ sáng/chiều/cả ngày và xử lý các đơn trong hộp thư duyệt được giao."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={yearSelectId} className="text-xs font-medium text-muted">
              Năm phép:
            </label>
            <select
              id={yearSelectId}
              data-testid="leave-year-select"
              value={leaveYear}
              onChange={(e) => setLeaveYear(Number(e.target.value))}
              className="min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {[leaveYear - 1, leaveYear, leaveYear + 1].map((yr) => (
                <option key={yr} value={yr}>
                  Năm {yr}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                void loadMySummary(leaveYear);
                if (authority?.can_approve_requests) {
                  void loadInbox(inboxStatusFilter, inboxPage);
                }
                if (activeTab === "admin" && authority?.can_manage_config) {
                  void loadAdminConfig(adminAppliedSearch, adminPage, adminAccountStatus);
                  void loadAdminEmployeeOptions();
                }
                if (activeTab === "reports" && authority?.can_view_monthly_report) {
                  void loadMonthlyReport(
                    reportMonth,
                    reportUnitKind,
                    reportAppliedSearch,
                    reportPage,
                  );
                }
              }}
            >
              Làm mới
            </Button>
          </div>
        }
      />

      {/* Shared Marketing / Non-Employee Account Banner */}
      {viewMode === "personal" &&
      (meErrorCode === "LEAVE_SHARED_ACCOUNT_FORBIDDEN" ||
        summary?.authority.is_shared_non_employee) ? (
        <StatusBanner
          tone="warning"
          title="Tài khoản dùng chung không thuộc đối tượng quản lý nghỉ phép cá nhân"
          dataTestId="leave-shared-account-banner"
        >
          <p>
            Tài khoản hiện tại được đánh dấu là tài khoản dùng chung (Marketing/hệ thống), không gắn
            với hồ sơ nhân sự cá nhân nên không phát sinh quỹ phép và không tạo đơn xin nghỉ phép.
          </p>
        </StatusBanner>
      ) : null}

      {/* Top-Level Workspace Tabs */}
      <div
        role="tablist"
        aria-label="Phân khu Quản lý nghỉ phép"
        className="flex flex-wrap items-center gap-2 border-b border-border pb-2"
      >
        {visibleTabs.map((tab) => {
          const isCurrent = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isCurrent}
              data-testid={`leave-workspace-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex min-h-11 sm:min-h-10 items-center gap-2 rounded-lg px-3.5 py-2 text-xs sm:text-sm font-medium transition-colors duration-[var(--ui-motion-hover,160ms)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                isCurrent
                  ? "bg-primary text-on-primary shadow-2xs"
                  : "border border-border bg-surface text-foreground hover:bg-muted/10"
              }`}
            >
              <span>{tab.label}</span>
              {typeof tab.badgeCount === "number" && tab.badgeCount > 0 ? (
                <span
                  className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${
                    isCurrent
                      ? "bg-white/20 text-on-primary"
                      : "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                  }`}
                >
                  {tab.badgeCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* =====================================================================
          TAB 1: PERSONAL LEAVE PAGE (CÁ NHÂN & XIN NGHỈ)
         ===================================================================== */}
      {activeTab === "personal" ? (
        <div className="space-y-5" data-testid="leave-tab-personal">
          {meLoading ? (
            <Card className="p-6">
              <p className="text-sm text-muted">Đang tải thông tin quỹ phép cá nhân…</p>
            </Card>
          ) : meErrorCode && meErrorCode !== "LEAVE_SHARED_ACCOUNT_FORBIDDEN" ? (
            <ErrorState
              title="Không tải được hồ sơ nghỉ phép cá nhân"
              detail={leaveErrorMessage(meErrorCode)}
            />
          ) : summary ? (
            <>
              {/* Balance KPI Summary Grid */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
                <Card className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted">
                    Phép năm khả dụng
                  </p>
                  <p
                    className="mt-1.5 text-2xl font-semibold text-primary font-mono tabular-nums"
                    data-testid="leave-kpi-available"
                  >
                    {formatHalfDayUnits(summary.balance.available_units)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Tương đương {summary.balance.available_units} đơn vị nửa ngày
                  </p>
                </Card>

                <Card className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted">
                    Đang giữ chỗ (Đã duyệt tương lai)
                  </p>
                  <p
                    className="mt-1.5 text-2xl font-semibold text-foreground font-mono tabular-nums"
                    data-testid="leave-kpi-reserved"
                  >
                    {formatHalfDayUnits(summary.balance.reserved_units)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Đang chờ duyệt:{" "}
                    {formatHalfDayUnits(
                      (summary.balance.pending_annual_units ?? 0) +
                        (summary.balance.pending_non_annual_units ?? 0),
                    )}
                  </p>
                </Card>

                <Card className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted">
                    Đã sử dụng phép năm ({summary.leave_year})
                  </p>
                  <p
                    className="mt-1.5 text-2xl font-semibold text-foreground font-mono tabular-nums"
                    data-testid="leave-kpi-consumed"
                  >
                    {formatHalfDayUnits(summary.balance.consumed_units)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Nghỉ khác phép năm đã duyệt:{" "}
                    {formatHalfDayUnits(
                      summary.balance.approved_non_annual_units ??
                        summary.balance.approved_unpaid_units ??
                        0,
                    )}
                  </p>
                </Card>

                <Card className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted">
                    Phép chuyển năm còn lại
                  </p>
                  <p
                    className="mt-1.5 text-2xl font-semibold text-foreground font-mono tabular-nums"
                    data-testid="leave-kpi-carry-over"
                  >
                    {formatHalfDayUnits(summary.balance.carry_over_available_units)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {summary.policy.carry_over_expires_after_date
                      ? `Hạn dùng đến hết: ${formatIsoDateVi(summary.policy.carry_over_expires_after_date)}`
                      : "Chưa cấu hình ngày hết hạn phép chuyển năm"}
                  </p>
                </Card>
              </div>

              {/* Profile & Create Leave Request Grid */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
                {/* Left Column: Employee Leave Profile & Routing Info */}
                <Card className="lg:col-span-5 space-y-3">
                  <CardHeader
                    title="Hồ sơ & Định tuyến duyệt phép"
                    description="Thông tin trạng thái nhân sự, mốc tính phép và người duyệt hiện hành."
                  />
                  <dl className="grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-2">
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5">
                      <dt className="text-xs text-muted">Nhân sự</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {summary.account?.display_name ?? summary.account?.login_id ?? "—"}
                        {summary.account?.personnel_code
                          ? ` (${summary.account.personnel_code})`
                          : ""}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5">
                      <dt className="text-xs text-muted">Bộ phận / Team</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {leaveUnitKindLabel(summary.balance.unit_kind)}
                        {summary.routing.team_name ? ` · ${summary.routing.team_name}` : ""}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5">
                      <dt className="text-xs text-muted">Ngày bắt đầu làm việc</dt>
                      <dd className="mt-0.5 font-mono text-foreground">
                        {formatIsoDateVi(summary.balance.work_start_date)}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5">
                      <dt className="text-xs text-muted">Ngày lên chính thức</dt>
                      <dd className="mt-0.5 font-mono text-foreground">
                        {formatIsoDateVi(summary.balance.official_effective_date)}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5 sm:col-span-2">
                      <dt className="text-xs text-muted">Nguồn phép tích lũy năm {leaveYear}</dt>
                      <dd className="mt-1 flex flex-wrap gap-3 text-xs text-foreground">
                        <span>
                          Phép tháng:{" "}
                          <strong>
                            {formatHalfDayUnits(summary.balance.monthly_accrued_units)}
                          </strong>
                        </span>
                        <span>
                          Thâm niên:{" "}
                          <strong>
                            {formatHalfDayUnits(summary.balance.seniority_granted_units)}
                          </strong>
                        </span>
                        <span>
                          Đầu kỳ/Điều chỉnh:{" "}
                          <strong>
                            {formatHalfDayUnits(summary.balance.opening_or_adjustment_units)}
                          </strong>
                        </span>
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5 sm:col-span-2">
                      <dt className="text-xs text-muted">Mốc tăng phép thâm niên tiếp theo</dt>
                      <dd className="mt-0.5 text-foreground">
                        {summary.balance.next_seniority_effective_date
                          ? `${formatIsoDateVi(summary.balance.next_seniority_effective_date)} (+${formatHalfDayUnits(summary.balance.next_seniority_units)})`
                          : "Chưa đặt lịch tăng phép tiếp theo"}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/80 bg-surface-muted/40 p-2.5 sm:col-span-2">
                      <dt className="text-xs text-muted">Định tuyến phê duyệt hiện hành</dt>
                      <dd className="mt-0.5 font-medium text-foreground">
                        {leaveRouteKindLabel(
                          summary.routing.route_kind,
                          summary.routing.team_name,
                          summary.routing.unit_kind,
                        )}
                      </dd>
                      {summary.routing.fallback_reason ? (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                          {leaveFallbackReasonLabel(summary.routing.fallback_reason)}
                        </p>
                      ) : null}
                    </div>
                  </dl>
                </Card>

                {/* Right Column: Create Leave Request Form */}
                <Card className="lg:col-span-7 space-y-4">
                  <CardHeader
                    title="Tạo đơn xin nghỉ phép"
                    description="Chọn từng ngày nghỉ, khung buổi (Cả ngày = 1 ngày, Buổi sáng = 0,5 ngày, Buổi chiều = 0,5 ngày) và loại nghỉ rõ ràng (Phép năm, Nghỉ tang, Nghỉ cưới, Nghỉ ốm, Nghỉ không lương). Chỉ Phép năm mới trừ vào quỹ phép năm (FIFO)."
                  />

                  {draftEvaluation.unpaid_notice ? (
                    <StatusBanner
                      tone="info"
                      title="Thông tin loại nghỉ & trừ quỹ phép năm"
                      dataTestId="leave-unpaid-notice-banner"
                    >
                      <p>{draftEvaluation.unpaid_notice}</p>
                    </StatusBanner>
                  ) : null}

                  {draftEvaluation.can_split_excess_annual_to_unpaid ? (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-900 dark:text-amber-200"
                      data-testid="leave-split-suggestion-banner"
                    >
                      <span>
                        Số ngày Phép năm đang chọn vượt quá số dư khả dụng (
                        {formatHalfDayUnits(summary.balance.available_units)}). Bạn có thể tự động
                        chia phần vượt hạn mức sang <strong>Nghỉ không lương</strong> trong cùng
                        yêu cầu này.
                      </span>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleAutoSplitDraftByBalance}
                        data-testid="leave-auto-split-balance-btn"
                      >
                        Tự động chia Phép năm + Nghỉ không lương
                      </Button>
                    </div>
                  ) : null}

                  <form
                    onSubmit={handleSubmitLeaveRequest}
                    className="space-y-4"
                    data-testid="leave-create-request-form"
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          Danh sách ngày & loại nghỉ <span className="text-rose-600">*</span>
                        </span>
                        <Button
                          type="button"
                          variant="soft"
                          size="sm"
                          onClick={handleAddDraftDay}
                          data-testid="leave-add-day-btn"
                        >
                          + Thêm ngày nghỉ
                        </Button>
                      </div>

                      {draftDays.map((dayRow, idx) => (
                        <div
                          key={idx}
                          className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-surface-muted/30 p-3 sm:grid-cols-12 sm:items-center"
                        >
                          <div className="sm:col-span-3">
                            <label className="block text-xs text-muted mb-1">
                              Ngày nghỉ #{idx + 1}
                            </label>
                            <input
                              type="date"
                              required
                              value={dayRow.leave_date}
                              onChange={(e) => handleChangeDraftDayDate(idx, e.target.value)}
                              data-testid={`leave-day-date-${idx}`}
                              className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            />
                          </div>
                          <div className="sm:col-span-3">
                            <label className="block text-xs text-muted mb-1">
                              Khung buổi nghỉ
                            </label>
                            <select
                              value={dayRow.session_code}
                              onChange={(e) =>
                                handleChangeDraftDaySession(
                                  idx,
                                  e.target.value as LeaveSessionCode,
                                )
                              }
                              data-testid={`leave-day-session-${idx}`}
                              className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                              {LEAVE_SESSION_CODES.map((code) => (
                                <option key={code} value={code}>
                                  {leaveSessionLabel(code)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="sm:col-span-4">
                            <label className="block text-xs text-muted mb-1">Loại nghỉ</label>
                            <select
                              value={dayRow.leave_type ?? "ANNUAL"}
                              onChange={(e) =>
                                handleChangeDraftDayLeaveType(idx, e.target.value as LeaveType)
                              }
                              data-testid={`leave-day-type-${idx}`}
                              className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                            >
                              {LEAVE_TYPES.map((code) => (
                                <option key={code} value={code}>
                                  {leaveTypeLabel(code)}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="sm:col-span-2 flex flex-wrap sm:justify-end gap-1.5 sm:pt-5">
                            {dayRow.session_code === "FULL" ? (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => handleSplitDraftDayToHalfDays(idx)}
                                data-testid={`leave-split-day-btn-${idx}`}
                                title="Tách ngày này thành 2 buổi Sáng/Chiều để chọn 2 loại nghỉ khác nhau"
                              >
                                Tách 2 buổi
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="danger-outline"
                              size="sm"
                              disabled={draftDays.length <= 1}
                              onClick={() => handleRemoveDraftDay(idx)}
                              aria-label={`Xóa ngày nghỉ thứ ${idx + 1}`}
                            >
                              Xóa
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div>
                      <label
                        htmlFor={reasonTextareaId}
                        className="block text-sm font-medium text-foreground mb-1"
                      >
                        Lý do xin nghỉ (không bắt buộc)
                      </label>
                      <textarea
                        id={reasonTextareaId}
                        rows={2}
                        value={draftReason}
                        onChange={(e) => setDraftReason(e.target.value)}
                        placeholder="Nhập lý do xin nghỉ nếu cần..."
                        data-testid="leave-request-reason-input"
                        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                    </div>

                    {/* Live Draft Summary Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted/40 px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted">Tổng thời lượng:</span>
                        <strong
                          className="font-mono text-base text-foreground"
                          data-testid="leave-draft-total-days"
                        >
                          {formatHalfDayUnits(draftEvaluation.total_units)}
                        </strong>
                        <span className="text-xs text-muted">
                          ({draftEvaluation.total_units} đơn vị nửa ngày)
                        </span>
                        {draftEvaluation.type_breakdown.map((tb) => {
                          const badge = leaveTypeBadge(tb.leave_type);
                          return (
                            <StatusBadge key={tb.leave_type} tone={badge.tone}>
                              {badge.label}: {formatHalfDayUnits(tb.half_day_units)}
                            </StatusBadge>
                          );
                        })}
                      </div>

                      <Button
                        type="submit"
                        variant="primary"
                        loading={creatingRequest}
                        disabled={!draftEvaluation.valid || creatingRequest}
                        data-testid="leave-submit-request-btn"
                      >
                        Gửi đơn xin nghỉ
                      </Button>
                    </div>

                    {draftEvaluation.blocking_error ? (
                      <StatusBanner
                        tone="error"
                        title="Đơn xin nghỉ chưa hợp lệ"
                        dataTestId="leave-draft-error-banner"
                      >
                        <p>{draftEvaluation.blocking_error}</p>
                      </StatusBanner>
                    ) : null}
                  </form>
                </Card>
              </div>

              {/* Entitlement Lots FIFO Table */}
              <Card className="space-y-3">
                <CardHeader
                  title="Các lô phép trong năm (Thứ tự ưu tiên trừ FIFO)"
                  description="Khi duyệt đơn nghỉ có lương, hệ thống tự động trừ lô có hạn hết hạn sớm nhất trước (Phép chuyển năm -> Phép tháng -> Phép thâm niên)."
                />
                {summary.balance.lots.length === 0 ? (
                  <EmptyState
                    title="Chưa có lô phép có lương nào trong năm"
                    description="Các lô phép tháng, phép chuyển năm hoặc phép thâm niên sẽ hiển thị tại đây khi hồ sơ nhân sự đủ điều kiện."
                  />
                ) : (
                  <DataTableContainer dataTestId="leave-lots-table">
                    <table className={DATA_TABLE_CLASS}>
                      <thead className={DATA_TABLE_HEAD_CLASS}>
                        <tr>
                          <th className={DATA_TABLE_TH_CLASS}>Nguồn lô phép</th>
                          <th className={DATA_TABLE_TH_CLASS}>Kỳ phát sinh</th>
                          <th className={DATA_TABLE_TH_CLASS}>Được cấp</th>
                          <th className={DATA_TABLE_TH_CLASS}>Giữ chỗ</th>
                          <th className={DATA_TABLE_TH_CLASS}>Đã dùng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Hết hạn</th>
                          <th className={DATA_TABLE_TH_CLASS}>Còn khả dụng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Hiệu lực từ</th>
                          <th className={DATA_TABLE_TH_CLASS}>Hết hạn sau ngày</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.balance.lots.map((lot) => (
                          <tr key={lot.lot_id} className={DATA_TABLE_ROW_CLASS}>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Nguồn lô phép">
                              <span className="font-medium text-foreground">
                                {leaveLotKindLabel(lot.lot_kind, lot.accrual_month)}
                              </span>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Kỳ phát sinh">
                              {lot.accrual_month
                                ? `Tháng ${lot.accrual_month}/${leaveYear}`
                                : `Năm ${leaveYear}`}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Được cấp">
                              {formatHalfDayUnits(lot.granted_units)}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Giữ chỗ">
                              {formatHalfDayUnits(lot.reserved_units)}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Đã dùng">
                              {formatHalfDayUnits(lot.consumed_units)}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Hết hạn">
                              {formatHalfDayUnits(lot.expired_units)}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Còn khả dụng">
                              <strong className="text-primary">
                                {formatHalfDayUnits(lot.available_units)}
                              </strong>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Hiệu lực từ">
                              {formatIsoDateVi(lot.usable_from_date)}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Hết hạn sau ngày">
                              {lot.expires_after_date
                                ? formatIsoDateVi(lot.expires_after_date)
                                : "Cuối năm"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTableContainer>
                )}
              </Card>

              {/* My Leave Requests History Table */}
              <Card className="space-y-3">
                <CardHeader
                  title="Lịch sử đơn nghỉ phép của tôi"
                  description="Theo dõi trạng thái phê duyệt, chi tiết buổi nghỉ và rút lại đơn đang chờ duyệt khi cần."
                />
                {summary.requests.length === 0 ? (
                  <EmptyState
                    title="Chưa có đơn xin nghỉ phép nào trong năm"
                    description="Khi bạn gửi đơn xin nghỉ, lịch sử và trạng thái phê duyệt sẽ xuất hiện tại đây."
                  />
                ) : (
                  <DataTableContainer dataTestId="leave-my-requests-table">
                    <table className={DATA_TABLE_CLASS}>
                      <thead className={DATA_TABLE_HEAD_CLASS}>
                        <tr>
                          <th className={DATA_TABLE_TH_CLASS}>Chi tiết ngày, buổi & loại nghỉ</th>
                          <th className={DATA_TABLE_TH_CLASS}>Tổng cộng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Phân bổ loại nghỉ</th>
                          <th className={DATA_TABLE_TH_CLASS}>Cấp duyệt</th>
                          <th className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
                          <th className={DATA_TABLE_TH_CLASS}>Lý do / Phản hồi</th>
                          <th className={DATA_TABLE_TH_CLASS}>Thao tác</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.requests.map((req) => {
                          const statusBadge = leaveRequestStatusBadge(req.status);
                          const typeBreakdown = resolveRequestTypeBreakdown(req);
                          const allowWithdraw = canWithdrawOwnLeaveRequest({
                            actorAppUserId: summary.authority.app_user_id,
                            request: req,
                          });
                          return (
                            <tr key={req.request_id} className={DATA_TABLE_ROW_CLASS}>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Chi tiết ngày, buổi & loại nghỉ"
                              >
                                <div className="flex flex-wrap gap-1">
                                  {req.days.map((d) => (
                                    <span
                                      key={d.request_day_id}
                                      className="inline-flex items-center rounded border border-border bg-surface-muted px-2 py-0.5 text-xs font-mono"
                                    >
                                      {formatIsoDateVi(d.leave_date)}:{" "}
                                      {leaveSessionShortLabel(d.session_code)} ·{" "}
                                      {leaveTypeShortLabel(d.leave_type)}
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Tổng cộng">
                                <strong>{formatHalfDayUnits(req.requested_units)}</strong>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Phân bổ loại nghỉ">
                                <div className="flex flex-wrap gap-1">
                                  {typeBreakdown.map((tb) => {
                                    const badge = leaveTypeBadge(tb.leave_type);
                                    return (
                                      <StatusBadge key={tb.leave_type} tone={badge.tone}>
                                        {badge.label}: {formatHalfDayUnits(tb.half_day_units)}
                                      </StatusBadge>
                                    );
                                  })}
                                </div>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Cấp duyệt">
                                <span className="text-xs">
                                  {leaveRouteKindLabel(
                                    req.route_kind,
                                    req.routed_team_name,
                                    req.unit_kind_snapshot,
                                  )}
                                </span>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Trạng thái">
                                <StatusBadge tone={statusBadge.tone} dot>
                                  {statusBadge.label}
                                </StatusBadge>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Lý do / Phản hồi">
                                <div className="max-w-xs space-y-0.5 text-xs">
                                  {req.reason ? <p>Xin nghỉ: {req.reason}</p> : null}
                                  {req.decision_reason ? (
                                    <p className="text-muted">Phản hồi: {req.decision_reason}</p>
                                  ) : null}
                                  {req.cancellation_reason ? (
                                    <p className="text-rose-700 dark:text-rose-300">
                                      Lý do hủy/rút: {req.cancellation_reason}
                                    </p>
                                  ) : null}
                                </div>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Thao tác">
                                <RowActionCluster>
                                  {allowWithdraw ? (
                                    <Button
                                      variant="danger-outline"
                                      size="sm"
                                      data-testid={`leave-withdraw-btn-${req.request_id}`}
                                      onClick={() => {
                                        setWithdrawTarget(req);
                                        setWithdrawReason("");
                                      }}
                                    >
                                      Rút đơn
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-muted">—</span>
                                  )}
                                </RowActionCluster>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </DataTableContainer>
                )}
              </Card>

              {/* Personal Ledger Entries Table */}
              <Card className="space-y-3">
                <CardHeader
                  title="Sổ cái biến động phép cá nhân"
                  description="Nhật ký bất biến ghi nhận mọi biến động cấp phép, giữ chỗ, trừ phép, hoàn phép khi hủy đơn hoặc hết hạn."
                />
                {summary.ledger_entries.length === 0 ? (
                  <EmptyState
                    title="Chưa có bút toán biến động phép"
                    description="Các bút toán cấp phép đầu kỳ, tích lũy hằng tháng và trừ phép khi duyệt đơn sẽ hiển thị tại đây."
                  />
                ) : (
                  <DataTableContainer dataTestId="leave-ledger-table">
                    <table className={DATA_TABLE_CLASS}>
                      <thead className={DATA_TABLE_HEAD_CLASS}>
                        <tr>
                          <th className={DATA_TABLE_TH_CLASS}>Ngày hiệu lực</th>
                          <th className={DATA_TABLE_TH_CLASS}>Loại bút toán</th>
                          <th className={DATA_TABLE_TH_CLASS}>Biến động khả dụng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Giữ chỗ / Đã dùng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Diễn giải / Lý do</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.ledger_entries.map((entry) => (
                          <tr key={entry.ledger_entry_id} className={DATA_TABLE_ROW_CLASS}>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Ngày hiệu lực">
                              <span className="font-mono">
                                {formatIsoDateVi(entry.effective_date)}
                              </span>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Loại bút toán">
                              {leaveLedgerEntryTypeLabel(
                                entry.entry_type,
                                entry.delta_available_units,
                              )}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Biến động khả dụng">
                              <span
                                className={`font-mono font-semibold ${
                                  entry.delta_available_units > 0
                                    ? "text-emerald-700 dark:text-emerald-300"
                                    : entry.delta_available_units < 0
                                      ? "text-rose-700 dark:text-rose-300"
                                      : "text-muted"
                                }`}
                              >
                                {formatSignedHalfDayUnits(entry.delta_available_units)}
                              </span>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Giữ chỗ / Đã dùng">
                              <span className="font-mono text-xs text-muted">
                                GC: {formatSignedHalfDayUnits(entry.delta_reserved_units)} · SD:{" "}
                                {formatSignedHalfDayUnits(entry.delta_consumed_units)}
                              </span>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS} data-label="Diễn giải / Lý do">
                              {entry.reason ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTableContainer>
                )}
              </Card>
            </>
          ) : null}
        </div>
      ) : null}

      {/* =====================================================================
          TAB 2: APPROVER INBOX (HỘP THƯ DUYỆT NGHỈ PHÉP)
         ===================================================================== */}
      {activeTab === "approvals" && authority?.can_approve_requests ? (
        <div className="space-y-4" data-testid="leave-tab-approvals">
          <FilterToolbar
            dataTestId="leave-approvals-filter-toolbar"
            actions={
              <Button
                variant="secondary"
                size="md"
                onClick={() => void loadInbox(inboxStatusFilter, inboxPage)}
              >
                Tải lại hộp thư
              </Button>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted mr-1">Trạng thái đơn:</span>
              {LEAVE_REQUEST_STATUS_FILTERS.map((st) => {
                const active = inboxStatusFilter === st;
                const label = st === "ALL" ? "Tất cả" : leaveRequestStatusBadge(st).label;
                return (
                  <button
                    key={st}
                    type="button"
                    data-testid={`leave-inbox-filter-${st}`}
                    onClick={() => {
                      setInboxStatusFilter(st);
                      setInboxPage(1);
                    }}
                    className={`inline-flex min-h-9 items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? "bg-primary text-on-primary"
                        : "border border-border bg-surface text-foreground hover:bg-muted/10"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </FilterToolbar>

          {inboxLoading ? (
            <Card className="p-6">
              <p className="text-sm text-muted">Đang tải danh sách đơn cần duyệt…</p>
            </Card>
          ) : inboxErrorCode ? (
            <ErrorState
              title="Không tải được hộp thư duyệt nghỉ phép"
              detail={leaveErrorMessage(inboxErrorCode)}
            />
          ) : !inboxData || inboxData.items.length === 0 ? (
            <EmptyState
              title="Không có đơn nghỉ phép nào khớp bộ lọc"
              description="Khi nhân sự thuộc phạm vi phụ trách của bạn gửi đơn xin nghỉ, đơn sẽ hiển thị tại đây."
            />
          ) : (
            <DataTableContainer
              dataTestId="leave-approvals-table"
              footer={
                <OffsetPager
                  page={inboxPage}
                  pageCount={inboxPageCount}
                  total={inboxData.total}
                  ariaLabel="Phân trang hộp thư duyệt phép"
                  onPageChange={(next) => setInboxPage(next)}
                />
              }
            >
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th className={DATA_TABLE_TH_CLASS}>Nhân sự</th>
                    <th className={DATA_TABLE_TH_CLASS}>Bộ phận / Team</th>
                    <th className={DATA_TABLE_TH_CLASS}>Ngày, Buổi & Loại nghỉ</th>
                    <th className={DATA_TABLE_TH_CLASS}>Tổng ngày</th>
                    <th className={DATA_TABLE_TH_CLASS}>Phân bổ loại nghỉ</th>
                    <th className={DATA_TABLE_TH_CLASS}>Tuyến duyệt</th>
                    <th className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
                    <th className={DATA_TABLE_TH_CLASS}>Lý do</th>
                    <th className={DATA_TABLE_TH_CLASS}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {inboxData.items.map((item) => {
                    const statusBadge = leaveRequestStatusBadge(item.status);
                    const typeBreakdown = resolveRequestTypeBreakdown(item);
                    const isSelf =
                      item.app_user_id.toLowerCase() ===
                      (summary?.authority.app_user_id ?? "").toLowerCase();
                    return (
                      <tr key={item.request_id} className={DATA_TABLE_ROW_CLASS}>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Nhân sự">
                          <div className="font-medium text-foreground">
                            {item.requester?.display_name ?? item.requester?.login_id ?? "—"}
                          </div>
                          <div className="text-xs text-muted">
                            {item.requester?.personnel_code
                              ? `${item.requester.personnel_code} · `
                              : ""}
                            {leaveEmploymentStatusBadge(item.employment_status_snapshot).label}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Bộ phận / Team">
                          <div>{leaveUnitKindLabel(item.unit_kind_snapshot)}</div>
                          {item.routed_team_name ? (
                            <div className="text-xs text-muted">{item.routed_team_name}</div>
                          ) : null}
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Ngày, Buổi & Loại nghỉ">
                          <div className="flex flex-wrap gap-1">
                            {item.days.map((d) => (
                              <span
                                key={d.request_day_id}
                                className="inline-flex rounded border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] font-mono"
                              >
                                {formatIsoDateVi(d.leave_date)}:{" "}
                                {leaveSessionShortLabel(d.session_code)} ·{" "}
                                {leaveTypeShortLabel(d.leave_type)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Tổng ngày">
                          <strong>{formatHalfDayUnits(item.requested_units)}</strong>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Phân bổ loại nghỉ">
                          <div className="flex flex-wrap gap-1">
                            {typeBreakdown.map((tb) => {
                              const badge = leaveTypeBadge(tb.leave_type);
                              return (
                                <StatusBadge key={tb.leave_type} tone={badge.tone}>
                                  {badge.label}: {formatHalfDayUnits(tb.half_day_units)}
                                </StatusBadge>
                              );
                            })}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Tuyến duyệt">
                          <div className="text-xs">
                            {leaveRouteKindLabel(
                              item.route_kind,
                              item.routed_team_name,
                              item.unit_kind_snapshot,
                            )}
                          </div>
                          {item.fallback_reason ? (
                            <div className="text-[11px] text-amber-700 dark:text-amber-300">
                              {leaveFallbackReasonLabel(item.fallback_reason)}
                            </div>
                          ) : null}
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Trạng thái">
                          <StatusBadge tone={statusBadge.tone} dot>
                            {statusBadge.label}
                          </StatusBadge>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Lý do">
                          <div className="max-w-xs space-y-0.5 text-xs">
                            <p>{item.reason || "—"}</p>
                            {item.decision_reason ? (
                              <p className="text-muted">Phản hồi: {item.decision_reason}</p>
                            ) : null}
                            {item.cancellation_reason ? (
                              <p className="text-rose-700 dark:text-rose-300">
                                Hủy/Rút: {item.cancellation_reason}
                              </p>
                            ) : null}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Thao tác">
                          <RowActionCluster>
                            {isSelf ? (
                              <span className="text-xs text-muted">Đơn của bạn</span>
                            ) : item.status === "PENDING" ? (
                              <>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  data-testid={`leave-approve-btn-${item.request_id}`}
                                  onClick={() => openDecisionDialog(item, "APPROVE")}
                                >
                                  Duyệt đơn
                                </Button>
                                <Button
                                  variant="danger-outline"
                                  size="sm"
                                  data-testid={`leave-reject-btn-${item.request_id}`}
                                  onClick={() => openDecisionDialog(item, "REJECT")}
                                >
                                  Từ chối
                                </Button>
                              </>
                            ) : item.status === "APPROVED" ? (
                              <Button
                                variant="danger-outline"
                                size="sm"
                                data-testid={`leave-cancel-approved-btn-${item.request_id}`}
                                onClick={() => openDecisionDialog(item, "CANCEL_APPROVED")}
                              >
                                Hủy đơn đã duyệt
                              </Button>
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
                          </RowActionCluster>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          )}
        </div>
      ) : null}

      {/* =====================================================================
          TAB 2B: ATTENDANCE EXPLANATION WORKSPACE (GIẢI TRÌNH CHẤM CÔNG)
         ===================================================================== */}
      {activeTab === "explanations" ? (
        <div className="space-y-4" data-testid="leave-tab-explanations">
          <AttendanceExplanationWorkspace loginRedirectPath="/leave" />
        </div>
      ) : null}

      {/* =====================================================================
          TAB 3: ADMIN / HR CONFIG & OPENING BALANCES
         ===================================================================== */}
      {activeTab === "admin" && authority?.can_manage_config ? (
        <div className="space-y-5" data-testid="leave-tab-admin">
          {/* Sub-navigation inside Admin tab */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={adminSubTab === "profiles" ? "primary" : "secondary"}
              size="sm"
              data-testid="leave-admin-subtab-profiles"
              onClick={() => setAdminSubTab("profiles")}
            >
              1. Hồ sơ nghỉ phép nhân sự
            </Button>
            <Button
              variant={adminSubTab === "policy" ? "primary" : "secondary"}
              size="sm"
              data-testid="leave-admin-subtab-policy"
              onClick={() => setAdminSubTab("policy")}
            >
              2. Chính sách, Người duyệt & Phân quyền
            </Button>
            <Button
              variant={adminSubTab === "opening" ? "primary" : "secondary"}
              size="sm"
              data-testid="leave-admin-subtab-opening"
              onClick={() => setAdminSubTab("opening")}
            >
              3. Số dư đầu kỳ (Xem trước & Áp dụng)
            </Button>
          </div>

          {adminLoading && !adminData ? (
            <Card className="p-6">
              <p className="text-sm text-muted">Đang tải dữ liệu cấu hình quản trị…</p>
            </Card>
          ) : adminErrorCode ? (
            <ErrorState
              title="Không tải được cấu hình quản trị nghỉ phép"
              detail={leaveErrorMessage(adminErrorCode)}
            />
          ) : adminData ? (
            <>
              {/* SUBTAB 1: EMPLOYEE PROFILES */}
              {adminSubTab === "profiles" ? (
                <div className="space-y-4" data-testid="leave-admin-profiles-section">
                  <FilterToolbar
                    actions={
                      <Button
                        variant="primary"
                        size="md"
                        onClick={() => {
                          setAdminPage(1);
                          setAdminAppliedSearch(adminSearchInput);
                        }}
                      >
                        Tìm kiếm nhân sự
                      </Button>
                    }
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="max-w-md">
                        <label className="block text-xs font-medium text-muted mb-1">
                          Tìm theo tên, mã nhân sự hoặc login ID
                        </label>
                        <input
                          type="search"
                          value={adminSearchInput}
                          onChange={(e) => setAdminSearchInput(e.target.value)}
                          placeholder="Nhập tên, mã NV, login..."
                          data-testid="leave-admin-profile-search"
                          className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        />
                      </div>
                      <div className="max-w-sm">
                        <label
                          htmlFor="leave-admin-account-status"
                          className="block text-xs font-medium text-muted mb-1"
                        >
                          Trạng thái tài khoản
                        </label>
                        <select
                          id="leave-admin-account-status"
                          value={adminAccountStatus}
                          onChange={(e) => {
                            setAdminAccountStatus(e.target.value as LeaveAdminAccountStatusFilter);
                            setAdminPage(1);
                          }}
                          data-testid="leave-admin-account-status-filter"
                          className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        >
                          <option value="ACTIVE">Đang hoạt động</option>
                          <option value="INACTIVE">Đã ngừng hoạt động</option>
                          <option value="ALL">Tất cả tài khoản</option>
                        </select>
                      </div>
                    </div>
                  </FilterToolbar>

                  <DataTableContainer
                    dataTestId="leave-admin-profiles-table"
                    footer={
                      <OffsetPager
                        page={adminPage}
                        pageCount={adminPageCount}
                        total={adminData.total_employees}
                        ariaLabel="Phân trang danh sách hồ sơ nghỉ phép"
                        onPageChange={(next) => setAdminPage(next)}
                      />
                    }
                  >
                    <table className={DATA_TABLE_CLASS}>
                      <thead className={DATA_TABLE_HEAD_CLASS}>
                        <tr>
                          <th className={DATA_TABLE_TH_CLASS}>Tài khoản / Nhân sự</th>
                          <th className={DATA_TABLE_TH_CLASS}>Trạng thái phép</th>
                          <th className={DATA_TABLE_TH_CLASS}>Bộ phận / Team</th>
                          <th className={DATA_TABLE_TH_CLASS}>Ngày vào / Chính thức</th>
                          <th className={DATA_TABLE_TH_CLASS}>Tăng thâm niên tiếp theo</th>
                          <th className={DATA_TABLE_TH_CLASS}>Tuyến duyệt</th>
                          <th className={DATA_TABLE_TH_CLASS}>Phép khả dụng</th>
                          <th className={DATA_TABLE_TH_CLASS}>Thao tác</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminData.employees.map((emp) => {
                          const empBadge = leaveEmploymentStatusBadge(
                            emp.profile.employment_status,
                          );
                          return (
                            <tr key={emp.account.app_user_id} className={DATA_TABLE_ROW_CLASS}>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Tài khoản / Nhân sự"
                              >
                                <div className="font-medium text-foreground">
                                  {emp.account.display_name}
                                </div>
                                <div className="text-xs text-muted">
                                  {emp.account.login_id ? `@${emp.account.login_id}` : ""}
                                  {emp.account.personnel_code
                                    ? ` · ${emp.account.personnel_code}`
                                    : ""}
                                </div>
                                {!emp.account.account_enabled ? (
                                  <div className="mt-1">
                                    <StatusBadge tone="neutral">Đã ngừng hoạt động</StatusBadge>
                                  </div>
                                ) : null}
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Trạng thái phép">
                                {emp.profile.is_shared_non_employee ? (
                                  <StatusBadge tone="neutral">
                                    Tài khoản dùng chung (Loại trừ)
                                  </StatusBadge>
                                ) : (
                                  <StatusBadge tone={empBadge.tone} dot>
                                    {empBadge.label}
                                  </StatusBadge>
                                )}
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Bộ phận / Team">
                                <div>{leaveUnitKindLabel(emp.profile.unit_kind)}</div>
                                {emp.routing.team_name ? (
                                  <div className="text-xs text-muted">{emp.routing.team_name}</div>
                                ) : null}
                              </td>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Ngày vào / Chính thức"
                              >
                                <div className="text-xs font-mono">
                                  Vào: {formatIsoDateVi(emp.profile.work_start_date)}
                                </div>
                                <div className="text-xs font-mono text-muted">
                                  CT: {formatIsoDateVi(emp.profile.official_effective_date)}
                                </div>
                              </td>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Tăng thâm niên tiếp theo"
                              >
                                {emp.profile.next_seniority_effective_date ? (
                                  <div className="text-xs font-mono">
                                    {formatIsoDateVi(emp.profile.next_seniority_effective_date)} (+
                                    {formatHalfDayUnits(emp.profile.next_seniority_units)})
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted">—</span>
                                )}
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Tuyến duyệt">
                                <div className="text-xs">
                                  {leaveRouteKindLabel(
                                    emp.routing.route_kind,
                                    emp.routing.team_name,
                                    emp.routing.unit_kind,
                                  )}
                                </div>
                                {emp.routing.fallback_reason ? (
                                  <div className="text-[11px] text-amber-700 dark:text-amber-300">
                                    {leaveFallbackReasonLabel(emp.routing.fallback_reason)}
                                  </div>
                                ) : null}
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Phép khả dụng">
                                <strong className="font-mono text-primary">
                                  {formatHalfDayUnits(emp.balance.available_units)}
                                </strong>
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Thao tác">
                                <RowActionCluster>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    data-testid={`leave-edit-profile-${emp.account.app_user_id}`}
                                    onClick={() => openEditProfileDialog(emp)}
                                  >
                                    Cấu hình hồ sơ
                                  </Button>
                                </RowActionCluster>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </DataTableContainer>
                </div>
              ) : null}

              {/* SUBTAB 2: POLICY, DEPARTMENT APPROVERS & MODULE GRANTS */}
              {adminSubTab === "policy" ? (
                <div
                  className="grid grid-cols-1 gap-5 lg:grid-cols-12"
                  data-testid="leave-admin-policy-section"
                >
                  {/* Card 1: Carry-over Expiry Policy */}
                  <Card className="lg:col-span-5 space-y-4">
                    <CardHeader
                      title="Chính sách hạn sử dụng phép chuyển năm"
                      description="Phép năm cũ chuyển sang năm mới được dùng đến hết ngày X theo giờ Việt Nam; từ ngày X+1 sẽ tự động hết hạn."
                    />
                    <form onSubmit={handleSavePolicy} className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-muted mb-1">
                            Ngày hết hạn (1–31)
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={31}
                            required
                            disabled={!authority.is_full_admin && !authority.is_bod}
                            value={policyExpiryDay}
                            onChange={(e) => setPolicyExpiryDay(e.target.value)}
                            data-testid="leave-policy-day-input"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-muted mb-1">
                            Tháng hết hạn (1–12)
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={12}
                            required
                            disabled={!authority.is_full_admin && !authority.is_bod}
                            value={policyExpiryMonth}
                            onChange={(e) => setPolicyExpiryMonth(e.target.value)}
                            data-testid="leave-policy-month-input"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-muted mb-1">
                          Lý do cập nhật chính sách (không bắt buộc)
                        </label>
                        <input
                          type="text"
                          disabled={!authority.is_full_admin && !authority.is_bod}
                          value={policyReason}
                          onChange={(e) => setPolicyReason(e.target.value)}
                          placeholder="Ví dụ: Chốt hạn phép chuyển năm đến hết 31/03..."
                          data-testid="leave-policy-reason-input"
                          className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                        />
                      </div>
                      <Button
                        type="submit"
                        variant="primary"
                        loading={savingPolicy}
                        disabled={
                          savingPolicy || (!authority.is_full_admin && !authority.is_bod)
                        }
                        data-testid="leave-save-policy-btn"
                      >
                        Lưu chính sách phép
                      </Button>
                    </form>
                  </Card>

                  {/* Card 2: Department Approvers (Marketing / IT / Accounting) */}
                  <Card className="lg:col-span-7 space-y-4">
                    <CardHeader
                      title="Cấu hình Trưởng phòng duyệt phép (Marketing / IT / Kế toán)"
                      description="Khối Tuyển dụng tự động định tuyến theo Team Leader hiện có. Các bộ phận Marketing, IT, Kế toán định tuyến theo người duyệt cấu hình tại đây."
                    />
                    <div className="space-y-2">
                      {adminData.department_approvers.length === 0 ? (
                        <p className="text-xs text-muted">
                          Chưa có cấu hình người duyệt bộ phận (đơn sẽ chuyển về hàng đợi Admin/BoD dự phòng).
                        </p>
                      ) : (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          {adminData.department_approvers.map((da) => (
                            <div
                              key={da.approver_assignment_id}
                              className="rounded-lg border border-border bg-surface-muted/40 p-2.5 text-xs"
                            >
                              <div className="font-semibold text-foreground">
                                {leaveUnitKindLabel(da.unit_kind)}
                              </div>
                              <div className="mt-1 text-foreground">
                                Người duyệt:{" "}
                                <strong>
                                  {da.approver?.display_name ?? da.approver?.login_id ?? "—"}
                                </strong>
                              </div>
                              <div className="mt-0.5 text-muted font-mono">
                                Từ: {formatIsoDateVi(da.valid_from)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <form
                      onSubmit={handleSaveDepartmentApprover}
                      className="space-y-3 border-t border-border pt-3"
                    >
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div>
                          <label className="block text-xs font-medium text-muted mb-1">
                            Bộ phận
                          </label>
                          <select
                            value={deptUnitKind}
                            disabled={
                              savingDeptApprover ||
                              pendingDeptApproverPayload !== null ||
                              (!authority.is_full_admin && !authority.is_bod)
                            }
                            onChange={(e) => {
                              setPendingDeptApproverPayload(null);
                              setDeptUnitKind(
                                e.target.value as LeaveDepartmentApproverUnitKind,
                              );
                            }}
                            data-testid="leave-dept-unit-select"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          >
                            {LEAVE_DEPARTMENT_APPROVER_UNIT_KINDS.map((uk) => (
                              <option key={uk} value={uk}>
                                {leaveUnitKindLabel(uk)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-muted mb-1">
                            Người duyệt
                          </label>
                          <select
                            value={deptApproverUserId}
                            disabled={
                              savingDeptApprover ||
                              pendingDeptApproverPayload !== null ||
                              (!authority.is_full_admin && !authority.is_bod)
                            }
                            onChange={(e) => {
                              setPendingDeptApproverPayload(null);
                              setDeptApproverUserId(e.target.value);
                            }}
                            data-testid="leave-dept-approver-select"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          >
                            <option value="">-- Chọn tài khoản duyệt --</option>
                            {nonSharedEmployees.map((emp) => (
                              <option
                                key={emp.account.app_user_id}
                                value={emp.account.app_user_id}
                              >
                                {formatLeaveAdminAccountOptionLabel(emp.account)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <span className="block text-xs font-medium text-muted mb-1">
                            Hiệu lực từ ngày
                          </span>
                          <div className="flex min-h-10 items-center rounded-lg border border-border bg-surface-muted/60 px-3 py-1.5 text-sm font-mono text-foreground">
                            {todayVietnamIsoDate()} (ngay lập tức)
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-muted mb-1">
                            Lý do phân công (không bắt buộc)
                          </label>
                          <input
                            type="text"
                            disabled={
                              savingDeptApprover ||
                              pendingDeptApproverPayload !== null ||
                              (!authority.is_full_admin && !authority.is_bod)
                            }
                            value={deptReason}
                            onChange={(e) => {
                              setPendingDeptApproverPayload(null);
                              setDeptReason(e.target.value);
                            }}
                            placeholder="Nhập lý do cấu hình người duyệt bộ phận..."
                            data-testid="leave-dept-reason-input"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          />
                        </div>
                        <Button
                          type="submit"
                          variant="primary"
                          loading={savingDeptApprover}
                          disabled={
                            savingDeptApprover || (!authority.is_full_admin && !authority.is_bod)
                          }
                          data-testid="leave-save-dept-approver-btn"
                        >
                          {pendingDeptApproverPayload ? "Thử lại lưu người duyệt" : "Lưu người duyệt"}
                        </Button>
                      </div>
                    </form>
                  </Card>

                  {/* Card 3: Module Grants */}
                  <Card className="lg:col-span-12 space-y-4">
                    <CardHeader
                      title="Phân quyền nội bộ phân hệ Nghỉ phép (HR & Ban Giám đốc)"
                      description="Quyền cấp tại đây chỉ có hiệu lực trong phân hệ Quản lý nghỉ phép, giữ nguyên hoàn toàn quyền của các phân hệ khác."
                    />
                    {adminData.module_grants.length > 0 ? (
                      <DataTableContainer>
                        <table className={DATA_TABLE_CLASS}>
                          <thead className={DATA_TABLE_HEAD_CLASS}>
                            <tr>
                              <th className={DATA_TABLE_TH_CLASS}>Nhân sự</th>
                              <th className={DATA_TABLE_TH_CLASS}>Vai trò trong module</th>
                              <th className={DATA_TABLE_TH_CLASS}>Lý do cấp</th>
                              <th className={DATA_TABLE_TH_CLASS}>Thao tác</th>
                            </tr>
                          </thead>
                          <tbody>
                            {adminData.module_grants.map((gr) => (
                              <tr key={gr.grant_id} className={DATA_TABLE_ROW_CLASS}>
                                <td className={DATA_TABLE_TD_CLASS} data-label="Nhân sự">
                                  {gr.account?.display_name ?? gr.app_user_id}
                                  {gr.account?.login_id ? ` (@${gr.account.login_id})` : ""}
                                </td>
                                <td
                                  className={DATA_TABLE_TD_CLASS}
                                  data-label="Vai trò trong module"
                                >
                                  <StatusBadge tone="primary">
                                    {leaveModuleGrantRoleLabel(gr.role_code)}
                                  </StatusBadge>
                                </td>
                                <td className={DATA_TABLE_TD_CLASS} data-label="Lý do cấp">
                                  {gr.reason ?? "—"}
                                </td>
                                <td className={DATA_TABLE_TD_CLASS} data-label="Thao tác">
                                  <RowActionCluster>
                                    {authority.is_full_admin && gr.is_current ? (
                                      <Button
                                        variant="danger-outline"
                                        size="sm"
                                        disabled={savingGrant}
                                        onClick={() =>
                                          void handleRevokeModuleRole(
                                            gr.app_user_id,
                                            gr.role_code,
                                            gr.row_version,
                                          )
                                        }
                                      >
                                        Thu hồi
                                      </Button>
                                    ) : (
                                      <span className="text-xs text-muted">
                                        {gr.is_current ? "Chỉ Admin" : "Đã thu hồi"}
                                      </span>
                                    )}
                                  </RowActionCluster>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </DataTableContainer>
                    ) : (
                      <p className="text-xs text-muted">
                        Chưa có tài khoản nào được cấp quyền bổ sung trong phân hệ Nghỉ phép.
                      </p>
                    )}

                    {authority.is_full_admin ? (
                      <form
                        onSubmit={handleGrantModuleRole}
                        className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-12 sm:items-end"
                      >
                        <div className="sm:col-span-4">
                          <label className="block text-xs font-medium text-muted mb-1">
                            Tài khoản nhận quyền
                          </label>
                          <select
                            value={grantUserId}
                            onChange={(e) => setGrantUserId(e.target.value)}
                            data-testid="leave-grant-user-select"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          >
                            <option value="">-- Chọn tài khoản --</option>
                            {nonSharedEmployees.map((emp) => (
                              <option
                                key={emp.account.app_user_id}
                                value={emp.account.app_user_id}
                              >
                                {formatLeaveAdminAccountOptionLabel(emp.account)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:col-span-3">
                          <label className="block text-xs font-medium text-muted mb-1">
                            Vai trò
                          </label>
                          <select
                            value={grantRoleCode}
                            onChange={(e) =>
                              setGrantRoleCode(e.target.value as LeaveModuleGrantRole)
                            }
                            data-testid="leave-grant-role-select"
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          >
                            {LEAVE_MODULE_GRANT_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {leaveModuleGrantRoleLabel(role)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:col-span-3">
                          <label className="block text-xs font-medium text-muted mb-1">
                            Lý do cấp quyền (không bắt buộc)
                          </label>
                          <input
                            type="text"
                            value={grantReason}
                            onChange={(e) => setGrantReason(e.target.value)}
                            placeholder="Nhập lý do..."
                            className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <Button
                            type="submit"
                            variant="primary"
                            loading={savingGrant}
                            disabled={savingGrant}
                            className="w-full"
                          >
                            Cấp quyền
                          </Button>
                        </div>
                      </form>
                    ) : null}
                  </Card>
                </div>
              ) : null}

              {/* SUBTAB 3: OPENING BALANCES (MANDATORY PREVIEW BEFORE APPLY) */}
              {adminSubTab === "opening" ? (
                <div className="space-y-4" data-testid="leave-admin-opening-section">
                  <Card className="space-y-4">
                    <CardHeader
                      title="Khởi tạo & Đối soát số dư phép đầu kỳ (Bắt buộc Xem trước rồi mới Áp dụng)"
                      description="Cột 'Phép đầu kỳ năm nay' là số dư mục tiêu sau đối soát tại ngày chốt (sau khi đã trừ các ngày phép nghỉ trước khi dùng BI), không phải khoản cộng thêm lên phép định kỳ tự động. Hệ thống bảo toàn phép đang giữ chỗ/đã duyệt theo FIFO và ghi nhận điều chỉnh vào sổ cái kiểm toán."
                    />

                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="w-44">
                        <label className="block text-xs font-medium text-muted mb-1">
                          Năm khởi tạo đầu kỳ
                        </label>
                        <input
                          type="number"
                          min={2020}
                          max={2100}
                          value={openingYear}
                          onChange={(e) => setOpeningYear(Number(e.target.value))}
                          data-testid="leave-opening-year-input"
                          className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-mono text-foreground"
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setOpeningShowBulkPaste((prev) => !prev)}
                          data-testid="leave-opening-toggle-bulk-btn"
                        >
                          {openingShowBulkPaste
                            ? "Đóng khung dán nhanh"
                            : "Dán nhanh nhiều dòng (TSV/CSV)"}
                        </Button>
                        <Button
                          variant="soft"
                          size="sm"
                          onClick={() =>
                            setOpeningUiRows((prev) => [...prev, createEmptyOpeningDraftRow()])
                          }
                          data-testid="leave-opening-add-row-btn"
                        >
                          + Thêm dòng nhân sự
                        </Button>
                      </div>
                    </div>

                    {openingShowBulkPaste ? (
                      <div className="rounded-xl border border-border bg-surface-muted/40 p-3.5 space-y-2.5">
                        <p className="text-xs text-muted">
                          Mỗi dòng theo định dạng:{" "}
                          <code className="font-mono text-foreground">
                            Mã_NV_hoặc_UUID [Tab hoặc dấu phẩy] phép_chuyển_năm [Tab]
                            phép_đầu_kỳ_năm_nay [Tab] phép_thâm_niên [Tab] ghi_chú
                          </code>{" "}
                          (đơn vị tính: ngày, bội số 0,5).
                        </p>
                        <textarea
                          rows={4}
                          value={openingBulkText}
                          onChange={(e) => setOpeningBulkText(e.target.value)}
                          placeholder="11111111-1111-4111-8111-111111111105	2	1.5	1	Số dư chốt đầu năm"
                          data-testid="leave-opening-bulk-textarea"
                          className="w-full rounded-lg border border-border bg-surface p-2.5 font-mono text-xs text-foreground"
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleParseOpeningBulkText}
                          data-testid="leave-opening-parse-bulk-btn"
                        >
                          Nạp dữ liệu vào bảng
                        </Button>
                      </div>
                    ) : null}

                    {/* Interactive Draft Rows Table */}
                    <DataTableContainer dataTestId="leave-opening-draft-table">
                      <table className={DATA_TABLE_CLASS}>
                        <thead className={DATA_TABLE_HEAD_CLASS}>
                          <tr>
                            <th className={DATA_TABLE_TH_CLASS}>Nhân sự (Tài khoản)</th>
                            <th className={DATA_TABLE_TH_CLASS}>Phép chuyển năm (Ngày)</th>
                            <th className={DATA_TABLE_TH_CLASS}>
                              Phép đầu kỳ năm nay — Số dư mục tiêu sau đối soát (Ngày)
                            </th>
                            <th className={DATA_TABLE_TH_CLASS}>Phép thâm niên (Ngày)</th>
                            <th className={DATA_TABLE_TH_CLASS}>Ghi chú</th>
                            <th className={DATA_TABLE_TH_CLASS}>Xóa</th>
                          </tr>
                        </thead>
                        <tbody>
                          {openingUiRows.map((row, idx) => {
                            const rowOptions = resolveOpeningRowSelectOptions({
                              eligibleEmployees: openingOfficialEmployees,
                              selectedAppUserId: row.app_user_id,
                              knownAccountsById: effectiveKnownAccountsById,
                              fallbackLabel: row.selected_label,
                            });
                            const selectedInOptions = rowOptions.some(
                              (opt) =>
                                opt.app_user_id.trim().toLowerCase() ===
                                row.app_user_id.trim().toLowerCase(),
                            );
                            return (
                            <tr key={row.id} className={DATA_TABLE_ROW_CLASS}>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Nhân sự">
                                <select
                                  value={selectedInOptions ? row.app_user_id : ""}
                                  onChange={(e) => {
                                    const nextUserId = e.target.value;
                                    const nextLabel = resolveKnownLeaveAccountLabel(
                                      nextUserId,
                                      effectiveKnownAccountsById,
                                      openingOfficialEmployees,
                                    );
                                    setOpeningUiRows((prev) =>
                                      prev.map((item, i) =>
                                        i === idx
                                          ? {
                                              ...item,
                                              app_user_id: nextUserId,
                                              selected_label: nextLabel,
                                            }
                                          : item,
                                      ),
                                    );
                                  }}
                                  data-testid={`leave-opening-row-user-${idx}`}
                                  className="w-full min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-foreground"
                                >
                                  <option value="">-- Chọn nhân sự --</option>
                                  {rowOptions.map((opt) => (
                                    <option
                                      key={opt.app_user_id}
                                      value={opt.app_user_id}
                                    >
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Phép chuyển năm (Ngày)"
                              >
                                <input
                                  type="number"
                                  step="0.5"
                                  min="0"
                                  max="60"
                                  value={row.carry_over_days}
                                  onChange={(e) =>
                                    setOpeningUiRows((prev) =>
                                      prev.map((item, i) =>
                                        i === idx
                                          ? { ...item, carry_over_days: e.target.value }
                                          : item,
                                      ),
                                    )
                                  }
                                  data-testid={`leave-opening-row-carry-${idx}`}
                                  className="w-28 min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-xs text-foreground"
                                />
                              </td>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Phép đầu kỳ năm nay (Ngày)"
                              >
                                <input
                                  type="number"
                                  step="0.5"
                                  min="0"
                                  max="60"
                                  value={row.opening_current_year_days}
                                  onChange={(e) =>
                                    setOpeningUiRows((prev) =>
                                      prev.map((item, i) =>
                                        i === idx
                                          ? {
                                              ...item,
                                              opening_current_year_days: e.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                  data-testid={`leave-opening-row-current-${idx}`}
                                  className="w-28 min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-xs text-foreground"
                                />
                              </td>
                              <td
                                className={DATA_TABLE_TD_CLASS}
                                data-label="Phép thâm niên (Ngày)"
                              >
                                <input
                                  type="number"
                                  step="0.5"
                                  min="0"
                                  max="30"
                                  value={row.seniority_days}
                                  onChange={(e) =>
                                    setOpeningUiRows((prev) =>
                                      prev.map((item, i) =>
                                        i === idx
                                          ? { ...item, seniority_days: e.target.value }
                                          : item,
                                      ),
                                    )
                                  }
                                  data-testid={`leave-opening-row-seniority-${idx}`}
                                  className="w-28 min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1 font-mono text-xs text-foreground"
                                />
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Ghi chú">
                                <input
                                  type="text"
                                  value={row.note}
                                  onChange={(e) =>
                                    setOpeningUiRows((prev) =>
                                      prev.map((item, i) =>
                                        i === idx ? { ...item, note: e.target.value } : item,
                                      ),
                                    )
                                  }
                                  placeholder="Ghi chú..."
                                  className="w-full min-h-9 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs text-foreground"
                                />
                              </td>
                              <td className={DATA_TABLE_TD_CLASS} data-label="Xóa">
                                <Button
                                  variant="danger-outline"
                                  size="sm"
                                  disabled={openingUiRows.length <= 1}
                                  onClick={() =>
                                    setOpeningUiRows((prev) =>
                                      prev.length <= 1
                                        ? prev
                                        : prev.filter((_, i) => i !== idx),
                                    )
                                  }
                                >
                                  Xóa
                                </Button>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </DataTableContainer>

                    {/* Reason & Step 1 / Step 2 Buttons */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-12 sm:items-end">
                      <div className="sm:col-span-6">
                        <label className="block text-xs font-medium text-muted mb-1">
                          Lý do khởi tạo số dư đầu kỳ (không bắt buộc)
                        </label>
                        <input
                          type="text"
                          value={openingReason}
                          onChange={(e) => setOpeningReason(e.target.value)}
                          placeholder="Ví dụ: Chốt số dư phép đầu kỳ năm 2026 theo biên bản HR..."
                          data-testid="leave-opening-reason-input"
                          className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                        />
                      </div>
                      <div className="sm:col-span-6 flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          loading={openingPreviewLoading}
                          disabled={openingPreviewLoading || openingApplyLoading}
                          onClick={() => void handlePreviewOpeningBalances()}
                          data-testid="leave-opening-preview-btn"
                        >
                          1. Xem trước & Kiểm tra
                        </Button>
                        <Button
                          variant="primary"
                          loading={openingApplyLoading}
                          disabled={!canApplyOpening}
                          onClick={() => void handleApplyOpeningBalances()}
                          data-testid="leave-opening-apply-btn"
                        >
                          2. Áp dụng chính thức số dư đầu kỳ
                        </Button>
                      </div>
                    </div>

                    {openingPreviewSignature &&
                    openingPreviewSignature !== currentOpeningSignature ? (
                      <StatusBanner
                        tone="warning"
                        title="Dữ liệu dự thảo đã thay đổi sau lần xem trước"
                        dataTestId="leave-opening-stale-preview-banner"
                      >
                        <p>
                          Bạn vừa chỉnh sửa bảng dữ liệu hoặc năm phép. Vui lòng bấm lại{" "}
                          <strong>1. Xem trước & Kiểm tra</strong> trước khi áp dụng.
                        </p>
                      </StatusBanner>
                    ) : null}

                    {/* Preview Result Panel */}
                    {openingPreviewResult ? (
                      <div
                        className="space-y-3 rounded-xl border border-border bg-surface-muted/30 p-4"
                        data-testid="leave-opening-preview-result"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-semibold text-foreground">
                              Kết quả kiểm tra xem trước (Năm {openingPreviewResult.leave_year})
                            </h3>
                            <p className="text-xs text-muted">
                              Ngày chốt đối soát số dư:{" "}
                              <strong className="font-mono text-foreground">
                                {formatIsoDateVi(
                                  openingPreviewResult.as_of_date ?? adminData?.as_of_date,
                                )}
                              </strong>
                            </p>
                          </div>
                          <StatusBadge
                            tone={openingPreviewResult.valid ? "success" : "danger"}
                            dot
                          >
                            {openingPreviewResult.valid
                              ? `Hợp lệ toàn bộ (${openingPreviewResult.row_count} dòng)`
                              : `Có ${openingPreviewResult.error_row_count}/${openingPreviewResult.row_count} dòng lỗi`}
                          </StatusBadge>
                        </div>

                        <div className="grid grid-cols-2 gap-2.5 text-xs sm:grid-cols-4">
                          <div className="rounded-lg border border-border bg-surface p-2.5">
                            <span className="text-muted">Tổng phép chuyển năm:</span>
                            <div className="mt-0.5 font-mono font-semibold text-foreground">
                              {formatHalfDayUnits(openingPreviewResult.total_carry_over_units)}
                            </div>
                          </div>
                          <div className="rounded-lg border border-border bg-surface p-2.5">
                            <span className="text-muted">
                              Tổng số dư mục tiêu năm nay (sau đối soát):
                            </span>
                            <div className="mt-0.5 font-mono font-semibold text-foreground">
                              {formatHalfDayUnits(
                                openingPreviewResult.total_opening_current_year_units,
                              )}
                            </div>
                          </div>
                          <div className="rounded-lg border border-border bg-surface p-2.5">
                            <span className="text-muted">Tổng phép thâm niên:</span>
                            <div className="mt-0.5 font-mono font-semibold text-foreground">
                              {formatHalfDayUnits(openingPreviewResult.total_seniority_units)}
                            </div>
                          </div>
                          <div className="rounded-lg border border-border bg-surface p-2.5">
                            <span className="text-muted">Hạn phép chuyển năm:</span>
                            <div className="mt-0.5 font-mono font-semibold text-foreground">
                              {formatIsoDateVi(
                                openingPreviewResult.carry_over_expires_after_date,
                              )}
                            </div>
                          </div>
                        </div>

                        <DataTableContainer>
                          <table className={DATA_TABLE_CLASS}>
                            <thead className={DATA_TABLE_HEAD_CLASS}>
                              <tr>
                                <th className={DATA_TABLE_TH_CLASS}>#</th>
                                <th className={DATA_TABLE_TH_CLASS}>Nhân sự</th>
                                <th className={DATA_TABLE_TH_CLASS}>Chuyển năm</th>
                                <th className={DATA_TABLE_TH_CLASS}>
                                  Số dư mục tiêu năm nay (Đối soát)
                                </th>
                                <th className={DATA_TABLE_TH_CLASS}>Thâm niên</th>
                                <th className={DATA_TABLE_TH_CLASS}>Kết quả kiểm tra</th>
                              </tr>
                            </thead>
                            <tbody>
                              {openingPreviewResult.rows.map((pr) => (
                                <tr key={pr.row_index} className={DATA_TABLE_ROW_CLASS}>
                                  <td className={DATA_TABLE_TD_CLASS} data-label="#">
                                    {pr.row_index}
                                  </td>
                                  <td className={DATA_TABLE_TD_CLASS} data-label="Nhân sự">
                                    <div className="font-medium">
                                      {pr.account?.display_name ??
                                        pr.account?.login_id ??
                                        pr.app_user_id ??
                                        "—"}
                                    </div>
                                    {pr.account?.personnel_code ? (
                                      <div className="text-xs text-muted">
                                        {pr.account.personnel_code}
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className={DATA_TABLE_TD_CLASS} data-label="Chuyển năm">
                                    {formatHalfDayUnits(pr.carry_over_units)}
                                  </td>
                                  <td
                                    className={DATA_TABLE_TD_CLASS}
                                    data-label="Số dư mục tiêu năm nay (Đối soát)"
                                  >
                                    <div className="font-mono font-medium">
                                      {formatHalfDayUnits(pr.opening_current_year_units)}
                                    </div>
                                    {typeof pr.current_year_granted_units === "number" &&
                                    typeof pr.delta_current_year_units === "number" ? (
                                      <div className="text-[11px] text-muted">
                                        Hiện có: {formatHalfDayUnits(pr.current_year_granted_units)}{" "}
                                        ({formatSignedHalfDayUnits(pr.delta_current_year_units)})
                                      </div>
                                    ) : null}
                                  </td>
                                  <td className={DATA_TABLE_TD_CLASS} data-label="Thâm niên">
                                    {formatHalfDayUnits(pr.seniority_units)}
                                  </td>
                                  <td
                                    className={DATA_TABLE_TD_CLASS}
                                    data-label="Kết quả kiểm tra"
                                  >
                                    {pr.valid ? (
                                      <StatusBadge tone="success" dot>
                                        Hợp lệ
                                      </StatusBadge>
                                    ) : (
                                      <div className="flex flex-wrap gap-1">
                                        {pr.errors.map((errCode) => (
                                          <StatusBadge key={errCode} tone="danger">
                                            {leaveOpeningRowErrorLabel(errCode)}
                                          </StatusBadge>
                                        ))}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </DataTableContainer>
                      </div>
                    ) : null}
                  </Card>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* =====================================================================
          TAB 4: MONTHLY ATTENDANCE & LEAVE CLOSING REPORT
         ===================================================================== */}
      {activeTab === "reports" && authority?.can_view_monthly_report ? (
        <div className="space-y-4" data-testid="leave-tab-report">
          <FilterToolbar
            dataTestId="leave-report-filter-toolbar"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  data-testid="leave-report-filter-btn"
                  onClick={() => {
                    setReportPage(1);
                    setReportAppliedSearch(reportSearchInput);
                  }}
                >
                  Lọc báo cáo
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  loading={exportingExcel}
                  disabled={exportingExcel}
                  data-testid="leave-report-export-btn"
                  onClick={() => void handleExportMonthlyReportExcel()}
                >
                  Xuất Excel (.xlsx)
                </Button>
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Kỳ báo cáo tháng (YYYY-MM)
                </label>
                <input
                  type="month"
                  value={reportMonth}
                  onChange={(e) => {
                    setReportMonth(e.target.value);
                    setReportPage(1);
                  }}
                  data-testid="leave-report-month-input"
                  className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Bộ phận / Khối
                </label>
                <select
                  value={reportUnitKind}
                  onChange={(e) => {
                    setReportUnitKind(e.target.value as LeaveUnitKind | "ALL");
                    setReportPage(1);
                  }}
                  data-testid="leave-report-unit-select"
                  className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                >
                  <option value="ALL">Tất cả bộ phận</option>
                  {LEAVE_UNIT_KINDS.map((uk) => (
                    <option key={uk} value={uk}>
                      {leaveUnitKindLabel(uk)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Tìm kiếm nhân sự
                </label>
                <input
                  type="search"
                  value={reportSearchInput}
                  onChange={(e) => setReportSearchInput(e.target.value)}
                  placeholder="Mã nhân viên, họ tên, tài khoản..."
                  data-testid="leave-report-search-input"
                  className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                />
              </div>
            </div>
          </FilterToolbar>

          {reportLoading ? (
            <Card className="p-6">
              <p className="text-sm text-muted">
                Đang tổng hợp báo cáo chốt công & phép kỳ {reportMonth}…
              </p>
            </Card>
          ) : reportErrorCode ? (
            <ErrorState
              title="Không tải được báo cáo chốt công & phép"
              detail={leaveErrorMessage(reportErrorCode)}
            />
          ) : !reportData || reportData.rows.length === 0 ? (
            <EmptyState
              title="Không có dữ liệu nhân sự khớp bộ lọc"
              description="Thử thay đổi bộ phận hoặc từ khóa tìm kiếm để xem dữ liệu chốt công & phép."
            />
          ) : (
            <DataTableContainer
              dataTestId="leave-monthly-report-table"
              footer={
                <OffsetPager
                  page={reportPage}
                  pageCount={reportPageCount}
                  total={reportData.total}
                  ariaLabel="Phân trang báo cáo chốt công và phép"
                  onPageChange={(next) => setReportPage(next)}
                />
              }
            >
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th className={DATA_TABLE_TH_CLASS}>Nhân sự</th>
                    <th className={DATA_TABLE_TH_CLASS}>Bộ phận / Team</th>
                    <th className={DATA_TABLE_TH_CLASS}>Trạng thái & Mốc làm việc</th>
                    <th className={DATA_TABLE_TH_CLASS}>Chấm công trong tháng</th>
                    <th className={DATA_TABLE_TH_CLASS}>Chi tiết ngày nghỉ, loại nghỉ & buổi nghỉ</th>
                    <th className={DATA_TABLE_TH_CLASS}>Tổng hợp loại nghỉ (Tháng)</th>
                    <th className={DATA_TABLE_TH_CLASS}>Chờ duyệt (Tháng)</th>
                    <th className={DATA_TABLE_TH_CLASS}>Nguồn phép năm (CN / Tháng / TN)</th>
                    <th className={DATA_TABLE_TH_CLASS}>Đã dùng / Giữ chỗ / Hết hạn</th>
                    <th className={DATA_TABLE_TH_CLASS}>Phép năm khả dụng cuối kỳ</th>
                  </tr>
                </thead>
                <tbody>
                  {reportData.rows.map((row) => {
                    const empBadge = leaveEmploymentStatusBadge(row.employment_status);
                    const attendanceDates = Array.isArray(row.attendance_dates)
                      ? row.attendance_dates
                      : [];
                    const leaveDays = Array.isArray(row.leave_days) ? row.leave_days : [];
                    return (
                      <tr key={row.app_user_id} className={DATA_TABLE_ROW_CLASS}>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Nhân sự">
                          <div className="font-medium text-foreground">
                            {row.account?.display_name ?? row.account?.login_id ?? row.app_user_id}
                          </div>
                          <div className="text-xs text-muted">
                            {row.account?.personnel_code
                              ? `${row.account.personnel_code} · `
                              : ""}
                            {row.account?.login_id ? `@${row.account.login_id}` : ""}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Bộ phận / Team">
                          <div>{leaveUnitKindLabel(row.unit_kind)}</div>
                          {row.routing?.team_name ? (
                            <div className="text-xs text-muted">{row.routing.team_name}</div>
                          ) : null}
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Trạng thái & Mốc làm việc"
                        >
                          <StatusBadge tone={empBadge.tone}>{empBadge.label}</StatusBadge>
                          <div className="mt-1 text-[11px] font-mono text-muted">
                            Vào: {formatIsoDateVi(row.work_start_date)} · CT:{" "}
                            {formatIsoDateVi(row.official_effective_date)}
                          </div>
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Chấm công trong tháng"
                        >
                          <div className="font-mono font-semibold text-foreground">
                            {row.attendance_day_count ?? attendanceDates.length} ngày
                          </div>
                          {attendanceDates.length > 0 ? (
                            <div className="mt-1 flex max-w-xs flex-wrap gap-1">
                              {attendanceDates.map((isoDate) => (
                                <span
                                  key={isoDate}
                                  className="inline-flex rounded border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] font-mono"
                                >
                                  {formatIsoDateVi(isoDate)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted">Chưa có ngày chấm công</span>
                          )}
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Chi tiết ngày nghỉ, loại nghỉ & buổi nghỉ"
                        >
                          {leaveDays.length > 0 ? (
                            <div className="flex max-w-sm flex-wrap gap-1">
                              {leaveDays.map((ld, idx) => {
                                const badge = leaveTypeBadge(ld.leave_type);
                                return (
                                  <span
                                    key={`${ld.request_id}-${ld.leave_date}-${ld.session_code}-${idx}`}
                                    className="inline-flex items-center gap-1 rounded border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] font-mono"
                                  >
                                    <span>
                                      {formatIsoDateVi(ld.leave_date)} (
                                      {leaveSessionShortLabel(ld.session_code)})
                                    </span>
                                    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span className="text-xs text-muted">Không phát sinh nghỉ</span>
                          )}
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Tổng hợp loại nghỉ (Tháng)"
                        >
                          <div className="space-y-0.5 text-xs font-mono">
                            <div>
                              Phép năm:{" "}
                              <strong>
                                {formatHalfDayUnits(row.month_annual_leave_units ?? 0)}
                              </strong>
                            </div>
                            {(row.month_bereavement_leave_units ?? 0) > 0 ? (
                              <div>
                                Nghỉ tang:{" "}
                                <strong>
                                  {formatHalfDayUnits(row.month_bereavement_leave_units)}
                                </strong>
                              </div>
                            ) : null}
                            {(row.month_marriage_leave_units ?? 0) > 0 ? (
                              <div>
                                Nghỉ cưới:{" "}
                                <strong>
                                  {formatHalfDayUnits(row.month_marriage_leave_units)}
                                </strong>
                              </div>
                            ) : null}
                            {(row.month_sick_leave_units ?? 0) > 0 ? (
                              <div>
                                Nghỉ ốm:{" "}
                                <strong>{formatHalfDayUnits(row.month_sick_leave_units)}</strong>
                              </div>
                            ) : null}
                            {(row.month_unpaid_leave_units ?? 0) > 0 ? (
                              <div>
                                Nghỉ không lương:{" "}
                                <strong>
                                  {formatHalfDayUnits(row.month_unpaid_leave_units)}
                                </strong>
                              </div>
                            ) : null}
                          </div>
                        </td>
                        <td className={DATA_TABLE_TD_CLASS} data-label="Chờ duyệt (Tháng)">
                          <span className="font-mono">
                            {formatHalfDayUnits(row.month_pending_units)}
                          </span>
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Nguồn phép năm (CN / Tháng / TN)"
                        >
                          <span className="font-mono text-xs">
                            {halfDayUnitsToDays(row.balance.carry_over_granted_units)} /{" "}
                            {halfDayUnitsToDays(row.balance.monthly_accrued_units)} /{" "}
                            {halfDayUnitsToDays(row.balance.seniority_granted_units)} ngày
                          </span>
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Đã dùng / Giữ chỗ / Hết hạn"
                        >
                          <span className="font-mono text-xs">
                            {halfDayUnitsToDays(row.balance.consumed_units)} /{" "}
                            {halfDayUnitsToDays(row.balance.reserved_units)} /{" "}
                            {halfDayUnitsToDays(row.balance.expired_units)} ngày
                          </span>
                        </td>
                        <td
                          className={DATA_TABLE_TD_CLASS}
                          data-label="Phép năm khả dụng cuối kỳ"
                        >
                          <strong className="font-mono text-primary">
                            {formatHalfDayUnits(row.balance.available_units)}
                          </strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          )}
        </div>
      ) : null}

      {/* =====================================================================
          DIALOG 1: SELF-WITHDRAW LEAVE REQUEST
         ===================================================================== */}
      <FormDialog
        open={Boolean(withdrawTarget)}
        onOpenChange={(open) => {
          if (!open && !withdrawing) setWithdrawTarget(null);
        }}
        title="Rút đơn xin nghỉ phép đang chờ duyệt"
        description="Đơn nghỉ phép chỉ có thể rút khi đang ở trạng thái Chờ duyệt. Sau khi rút, đơn chuyển sang trạng thái Đã tự rút."
        closeDisabled={withdrawing}
        dataTestId="leave-withdraw-dialog"
      >
        {withdrawTarget ? (
          <form onSubmit={handleConfirmWithdraw} className="space-y-4">
            <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-sm">
              <p>
                Tổng thời lượng:{" "}
                <strong>{formatHalfDayUnits(withdrawTarget.requested_units)}</strong>
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {withdrawTarget.days.map((d) => (
                  <span
                    key={d.request_day_id}
                    className="inline-flex rounded border border-border bg-surface px-2 py-0.5 text-xs font-mono"
                  >
                    {formatIsoDateVi(d.leave_date)}: {leaveSessionShortLabel(d.session_code)} ·{" "}
                    {leaveTypeShortLabel(d.leave_type)}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Lý do rút đơn (không bắt buộc)
              </label>
              <textarea
                rows={2}
                value={withdrawReason}
                onChange={(e) => setWithdrawReason(e.target.value)}
                placeholder="Nhập lý do rút đơn..."
                data-testid="leave-withdraw-reason-input"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={withdrawing}
                onClick={() => setWithdrawTarget(null)}
              >
                Đóng
              </Button>
              <Button
                type="submit"
                variant="danger"
                loading={withdrawing}
                disabled={withdrawing}
                data-testid="leave-confirm-withdraw-btn"
              >
                Xác nhận rút đơn
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      {/* =====================================================================
          DIALOG 2: APPROVER DECISION (APPROVE / REJECT / CANCEL_APPROVED)
         ===================================================================== */}
      <FormDialog
        open={Boolean(decisionTarget)}
        onOpenChange={(open) => {
          if (!open && !submittingDecision) setDecisionTarget(null);
        }}
        title={leaveDecisionActionLabel(decisionAction)}
        description={
          decisionAction === "CANCEL_APPROVED"
            ? "Hủy đơn đã duyệt sẽ hoàn trả số đơn vị Phép năm về đúng lô phép ban đầu và ghi bút toán đảo vào sổ cái."
            : "Xác nhận quyết định xử lý đơn xin nghỉ phép của nhân sự."
        }
        closeDisabled={submittingDecision}
        dataTestId="leave-decision-dialog"
      >
        {decisionTarget ? (
          <form onSubmit={handleConfirmDecision} className="space-y-4">
            <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-sm space-y-1">
              <p>
                Nhân sự:{" "}
                <strong>
                  {decisionTarget.requester?.display_name ??
                    decisionTarget.requester?.login_id ??
                    "—"}
                </strong>
              </p>
              <p>
                Tổng thời lượng:{" "}
                <strong>{formatHalfDayUnits(decisionTarget.requested_units)}</strong>
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span>Loại nghỉ:</span>
                {resolveRequestTypeBreakdown(decisionTarget).map((tb) => {
                  const badge = leaveTypeBadge(tb.leave_type);
                  return (
                    <StatusBadge key={tb.leave_type} tone={badge.tone}>
                      {badge.label}: {formatHalfDayUnits(tb.half_day_units)}
                    </StatusBadge>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Lý do / Ghi chú phản hồi (không bắt buộc)
              </label>
              <textarea
                rows={3}
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
                placeholder="Ghi chú xử lý đơn (nếu có)..."
                data-testid="leave-decision-reason-input"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={submittingDecision}
                onClick={() => setDecisionTarget(null)}
              >
                Đóng
              </Button>
              <Button
                type="submit"
                variant={decisionAction === "APPROVE" ? "primary" : "danger"}
                loading={submittingDecision}
                disabled={submittingDecision}
                data-testid="leave-confirm-decision-btn"
              >
                {leaveDecisionActionLabel(decisionAction)}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      {/* =====================================================================
          DIALOG 3: ADMIN / HR EDIT EMPLOYEE LEAVE PROFILE
         ===================================================================== */}
      <FormDialog
        open={Boolean(editingEmployee)}
        onOpenChange={(open) => {
          if (!open && !savingProfile) setEditingEmployee(null);
        }}
        title="Cấu hình hồ sơ nghỉ phép nhân sự"
        description="Thiết lập phân loại bộ phận nghỉ phép, trạng thái Thử việc / Chính thức, ngày bắt đầu làm việc và mốc tăng phép thâm niên tiếp theo."
        closeDisabled={savingProfile}
        dataTestId="leave-profile-dialog"
      >
        {editingEmployee ? (
          <form onSubmit={handleSaveEmployeeProfile} className="space-y-3.5">
            <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-sm">
              <div className="font-semibold text-foreground">
                {editingEmployee.account.display_name}
              </div>
              <div className="text-xs text-muted">
                {editingEmployee.account.login_id ? `@${editingEmployee.account.login_id}` : ""}
                {editingEmployee.account.personnel_code
                  ? ` · Mã NV: ${editingEmployee.account.personnel_code}`
                  : ""}
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                checked={profileIsShared}
                onChange={(e) => setProfileIsShared(e.target.checked)}
                data-testid="leave-profile-shared-checkbox"
                className="h-4 w-4 rounded border-border"
              />
              <span>
                Đánh dấu là tài khoản dùng chung (Marketing/hệ thống — loại khỏi quản lý phép cá nhân)
              </span>
            </label>

            {!profileIsShared ? (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">
                      Trạng thái làm việc
                    </label>
                    <select
                      value={profileStatus}
                      onChange={(e) =>
                        setProfileStatus(e.target.value as LeaveEmploymentStatus)
                      }
                      data-testid="leave-profile-status-select"
                      className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                    >
                      {LEAVE_EMPLOYMENT_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {leaveEmploymentStatusBadge(st).label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">
                      Bộ phận / Đơn vị duyệt phép
                    </label>
                    <select
                      value={profileUnitKind}
                      onChange={(e) => setProfileUnitKind(e.target.value as LeaveUnitKind)}
                      data-testid="leave-profile-unit-select"
                      className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                    >
                      {LEAVE_UNIT_KINDS.map((uk) => (
                        <option key={uk} value={uk}>
                          {leaveUnitKindLabel(uk)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">
                      Ngày bắt đầu làm việc
                    </label>
                    <input
                      type="date"
                      required={profileStatus !== "UNCONFIGURED"}
                      value={profileWorkStartDate}
                      onChange={(e) => setProfileWorkStartDate(e.target.value)}
                      data-testid="leave-profile-start-date-input"
                      className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">
                      Ngày lên chính thức
                    </label>
                    <input
                      type="date"
                      required={profileStatus === "OFFICIAL"}
                      disabled={profileStatus !== "OFFICIAL"}
                      value={profileOfficialDate}
                      onChange={(e) => setProfileOfficialDate(e.target.value)}
                      data-testid="leave-profile-official-date-input"
                      className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
                    />
                  </div>
                </div>

                {/* Seniority Milestone (Admin/BoD only) */}
                <div className="rounded-xl border border-border bg-surface-muted/30 p-3 space-y-2.5">
                  <div className="text-xs font-semibold text-foreground">
                    Mốc tăng phép thâm niên tiếp theo (Áp dụng 1 lần duy nhất tại ngày hiệu lực)
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs text-muted mb-1">
                        Ngày hiệu lực tăng phép tiếp theo
                      </label>
                      <input
                        type="date"
                        disabled={!authority?.is_full_admin && !authority?.is_bod}
                        value={profileSeniorityDate}
                        onChange={(e) => setProfileSeniorityDate(e.target.value)}
                        data-testid="leave-profile-seniority-date-input"
                        className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">
                        Số ngày phép cộng thêm (Bội số 0,5 ngày)
                      </label>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        max="30"
                        disabled={!authority?.is_full_admin && !authority?.is_bod}
                        value={profileSeniorityDays}
                        onChange={(e) => setProfileSeniorityDays(e.target.value)}
                        data-testid="leave-profile-seniority-days-input"
                        className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-mono text-foreground disabled:opacity-50"
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                Lý do cập nhật hồ sơ (không bắt buộc)
              </label>
              <input
                type="text"
                value={profileReason}
                onChange={(e) => setProfileReason(e.target.value)}
                placeholder="Nhập lý do cấu hình hoặc chuyển trạng thái nhân sự..."
                data-testid="leave-profile-reason-input"
                className="w-full min-h-10 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                disabled={savingProfile}
                onClick={() => setEditingEmployee(null)}
              >
                Đóng
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={savingProfile}
                disabled={savingProfile}
                data-testid="leave-save-profile-btn"
              >
                Lưu cấu hình hồ sơ
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </PageShell>
  );
}
