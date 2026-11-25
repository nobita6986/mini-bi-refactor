"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Building2,
  Download,
  FileSpreadsheet,
  Layers,
  Receipt,
  RefreshCw,
  Scale,
  Search,
  Settings2,
  Wallet,
  X,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CatalogFilterCombobox, type CatalogFilterOption } from "@/components/ui/catalog-filter-combobox";
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
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  VendorFinanceActiveFilter,
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceBalanceFilter,
  VendorFinanceContractTypeFilter,
  VendorFinanceLedgerScopeFilter,
  VendorFinanceListSubLedgerItem,
  VendorFinanceVendorListResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  ACTIVE_FILTER_LABELS_VI,
  BALANCE_FILTER_LABELS_VI,
  buildVendorExportUrl,
  buildVendorFinanceContextUrl,
  buildVendorListUrl,
  classifyVendorFinanceError,
  CONTRACT_TYPE_BADGE_TONES,
  CONTRACT_TYPE_FILTER_LABELS_VI,
  CONTRACT_TYPE_LABELS_VI,
  formatSignedVndDelta,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  isUsableVendorFinanceExportBlob,
  LEDGER_SCOPE_FILTER_LABELS_VI,
  parseVendorFinanceContextEnvelope,
  parseVendorListEnvelope,
  resolveVendorFinanceExportFilename,
  validateUiSearchInput,
  VFIN_UI_ACTIVE_FILTERS,
  VFIN_UI_BALANCE_FILTERS,
  VFIN_UI_CONTRACT_TYPE_FILTERS,
  VFIN_UI_LEDGER_SCOPE_FILTERS,
  VFIN_UI_MAX_SEARCH_LENGTH,
  VFIN_UI_REFERENCE_TOTAL_LABEL_VI,
} from "@/lib/vendor-finance/ui-model";

const PAGE_SIZE = 25;

function buildSubLedgerHref(vendorId: string, sub: VendorFinanceListSubLedgerItem): string {
  const sp = new URLSearchParams();
  sp.set("ledgerScope", sub.ledger_scope);
  if (sub.project_id) {
    sp.set("projectId", sub.project_id);
  }
  if (sub.accountant_ref) {
    sp.set("accountantRef", sub.accountant_ref);
  }
  sp.set("contractType", sub.contract_type);
  return `/finance/vendors/${encodeURIComponent(vendorId)}?${sp.toString()}`;
}

const LIST_TH_CLASS = `${DATA_TABLE_TH_CLASS} !px-2 !py-2.5 text-[11px] leading-tight !text-center align-middle`;
const LIST_TD_CLASS = `${DATA_TABLE_TD_CLASS} !px-2 !py-2.5 align-middle`;

export function VendorFinanceListView({
  initialCanRecord = false,
  initialCanReconcile = false,
  initialCanManageProjectAssignments = false,
}: {
  initialCanRecord?: boolean;
  initialCanReconcile?: boolean;
  initialCanManageProjectAssignments?: boolean;
}) {
  const searchInputId = useId();
  const projectSelectId = useId();
  const accountantSelectId = useId();
  const contractTypeSelectId = useId();
  const scopeSelectId = useId();
  const activeSelectId = useId();
  const balanceSelectId = useId();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [accountantFilter, setAccountantFilter] = useState("");
  const [contractTypeFilter, setContractTypeFilter] =
    useState<VendorFinanceContractTypeFilter>("all");
  const [ledgerScopeFilter, setLedgerScopeFilter] =
    useState<VendorFinanceLedgerScopeFilter>("all");
  const [activeFilter, setActiveFilter] = useState<VendorFinanceActiveFilter>("all");
  const [balanceFilter, setBalanceFilter] = useState<VendorFinanceBalanceFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [contextData, setContextData] =
    useState<VendorFinanceActorContextOptionsResponse | null>(null);
  const [data, setData] = useState<VendorFinanceVendorListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportBanner, setExportBanner] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadContext() {
      await Promise.resolve();
      if (cancelled) return;
      try {
        const res = await fetch(buildVendorFinanceContextUrl(), {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        const parsed = parseVendorFinanceContextEnvelope(json);
        if (parsed) {
          setContextData(parsed);
        }
      } catch {
        // Context filter options are supplementary; primary list fetch handles errors.
      }
    }

    void loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadNonce]);

  useEffect(() => {
    const searchCheck = validateUiSearchInput(debouncedSearch);
    let cancelled = false;
    const controller = new AbortController();

    async function fetchList() {
      await Promise.resolve();
      if (cancelled) return;

      if (!searchCheck.ok) {
        setErrorMsg(searchCheck.message);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMsg(null);

      try {
        const url = buildVendorListUrl({
          search: searchCheck.search,
          project_id: projectFilter || null,
          accountant_ref: accountantFilter || null,
          ledger_scope: ledgerScopeFilter,
          contract_type: contractTypeFilter,
          active: activeFilter,
          balance_filter: balanceFilter,
          page,
          page_size: PAGE_SIZE,
        });
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setErrorMsg(classified.message);
          setLoading(false);
          return;
        }

        const parsed = parseVendorListEnvelope(json);
        if (!parsed) {
          setErrorMsg("Dữ liệu danh sách tài chính Vendor từ máy chủ không đúng chuẩn hợp đồng.");
          setLoading(false);
          return;
        }

        setData(parsed);
        setLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setErrorMsg("Không thể tải danh sách tài chính Vendor do lỗi kết nối mạng.");
        setLoading(false);
      }
    }

    void fetchList();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    debouncedSearch,
    projectFilter,
    accountantFilter,
    contractTypeFilter,
    ledgerScopeFilter,
    activeFilter,
    balanceFilter,
    page,
    reloadNonce,
  ]);

  const canRecord = data ? data.allowed_actions.can_record : initialCanRecord;
  const canReconcile = data ? data.allowed_actions.can_reconcile : initialCanReconcile;
  const canManageProjectAssignments = data
    ? data.allowed_actions.can_manage_project_assignments
    : initialCanManageProjectAssignments;
  const canViewSharedAdvance = data?.allowed_actions.can_view_shared_advance === true;
  const visibilityScope = data?.allowed_actions.visibility_scope ?? "PROJECT_SCOPED";
  const activeAssignedProjectCount = data?.allowed_actions.active_assigned_project_count ?? 0;

  const summary = data?.summary ?? null;
  const projectFilterOptions = useMemo<CatalogFilterOption[]>(
    () =>
      (contextData?.projects ?? []).map((proj) => ({
        id: proj.project_id,
        label: proj.display_name,
        keywords: proj.project_id,
      })),
    [contextData?.projects],
  );
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const hasActiveFilters =
    searchInput.trim().length > 0 ||
    projectFilter !== "" ||
    accountantFilter !== "" ||
    contractTypeFilter !== "all" ||
    ledgerScopeFilter !== "all" ||
    activeFilter !== "all" ||
    balanceFilter !== "all";

  const handleResetFilters = () => {
    setSearchInput("");
    setDebouncedSearch("");
    setProjectFilter("");
    setAccountantFilter("");
    setContractTypeFilter("all");
    setLedgerScopeFilter("all");
    setActiveFilter("all");
    setBalanceFilter("all");
    setPage(1);
  };

  const handleExportExcel = async () => {
    if (exporting) return;
    const searchCheck = validateUiSearchInput(searchInput);
    if (!searchCheck.ok) {
      setExportBanner({ tone: "error", message: searchCheck.message });
      return;
    }

    setExporting(true);
    setExportBanner(null);

    try {
      const exportUrl = buildVendorExportUrl({
        search: searchCheck.search,
        project_id: projectFilter || null,
        accountant_ref: accountantFilter || null,
        ledger_scope: ledgerScopeFilter,
        contract_type: contractTypeFilter,
        active: activeFilter,
        balance_filter: balanceFilter,
      });

      const res = await fetch(exportUrl, {
        method: "GET",
        cache: "no-store",
      });

      if (!res.ok) {
        const json: unknown = await res.json().catch(() => null);
        const classified = classifyVendorFinanceError(json, res.status);
        setExportBanner({ tone: "error", message: classified.message });
        setExporting(false);
        return;
      }

      const contentType = res.headers.get("content-type");
      const blob = await res.blob();
      const usable = await isUsableVendorFinanceExportBlob(blob, contentType);
      if (!usable) {
        setExportBanner({
          tone: "error",
          message:
            "Tệp Excel trả về không hợp lệ hoặc bị hỏng. Không có tệp nào được tải xuống; vui lòng thử lại.",
        });
        setExporting(false);
        return;
      }

      const filename = resolveVendorFinanceExportFilename(
        res.headers.get("content-disposition"),
        data?.authorization_date,
      );
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      setExportBanner({
        tone: "success",
        message: `Đã xuất tệp Excel "${filename}" theo toàn bộ điều kiện lọc hiện hành.`,
      });
    } catch {
      setExportBanner({
        tone: "error",
        message: "Không thể xuất danh sách Excel do lỗi kết nối mạng. Vui lòng thử lại.",
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageShell dataTestId="vfin-vendor-list-page">
      <PageHeader
        title="Công nợ & Tạm ứng Vendor"
        actions={
          <>
            <Button
              variant="secondary"
              disabled={loading}
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Làm mới
            </Button>
            <Button
              variant="secondary"
              data-testid="vfin-export-excel-btn"
              disabled={loading || exporting}
              loading={exporting}
              onClick={() => void handleExportExcel()}
            >
              <Download className="h-4 w-4" aria-hidden />
              {exporting ? "Đang xuất Excel…" : "Xuất Excel"}
            </Button>
            <Link
              href="/finance/reports"
              data-testid="vfin-monthly-report-cta"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <BarChart3 className="h-4 w-4" aria-hidden />
              Báo cáo công nợ tháng
            </Link>
            {canManageProjectAssignments ? (
              <Link
                href="/finance/project-assignments"
                data-testid="vfin-governance-cta"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                <Settings2 className="h-4 w-4" aria-hidden />
                Phân công & vai trò
              </Link>
            ) : null}
            {canRecord ? (
              <Link
                href="/finance/opening-balance"
                data-testid="vfin-opening-balance-cta"
                className={buttonClasses({ variant: "primary", size: "md" })}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Khởi tạo công nợ đầu kỳ
              </Link>
            ) : null}
          </>
        }
      />

      {data && visibilityScope === "PROJECT_SCOPED" && activeAssignedProjectCount === 0 ? (
        <Alert tone="info" title="Bạn chưa được phân công dự án đang hiệu lực">
          <p>
            Kế toán phụ trách dự án chỉ nhìn thấy và ghi nhận trên các dự án được giao (cùng các sổ
            lịch sử của chính bạn nếu từng bàn giao dự án). Vui lòng liên hệ Quản trị viên (Full
            Admin) để phân công kế toán dự án và khai báo liên kết Dự án – Vendor.
          </p>
        </Alert>
      ) : null}

      {/* Non-Netted Sub-Ledger KPI Summary */}
      {exportBanner ? (
        <Alert
          tone={exportBanner.tone === "error" ? "error" : "info"}
          role={exportBanner.tone === "error" ? "alert" : "status"}
          data-testid="vfin-export-feedback-banner"
          title={
            exportBanner.tone === "error"
              ? "Không thể xuất danh sách Excel"
              : "Xuất danh sách Excel thành công"
          }
        >
          <p>{exportBanner.message}</p>
        </Alert>
      ) : null}

      <section
        aria-label="Chỉ số tổng hợp công nợ Vendor (tách riêng phải trả, dư ứng từng sổ và số dư ứng dùng chung)"
        className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${canViewSharedAdvance ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}
        data-testid="vfin-company-kpis"
      >
        <Card className="relative overflow-hidden p-4 border-border/80 transition-transform duration-150 hover:-translate-y-[1px]">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-amber-500/85" aria-hidden />
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-muted">Tổng phải trả Vendor</p>
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-300" aria-hidden>
              <Receipt className="h-3.5 w-3.5" />
            </span>
          </div>
          <p
            data-testid="vfin-kpi-payable"
            className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-[var(--navy)]"
          >
            {summary ? formatVndMinor(summary.total_payable_minor) : "—"}
          </p>
          {summary && summary.total_vendor_count > 0 ? (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-amber-500/15" aria-hidden>
              <div
                className="h-full rounded-full bg-amber-500/80"
                style={{
                  width: `${Math.min(100, Math.round((summary.vendors_with_payable_count / summary.total_vendor_count) * 100))}%`,
                }}
              />
            </div>
          ) : null}
          <p className="mt-1.5 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_payable_count} Vendor có sổ phải trả`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        {canViewSharedAdvance ? (
          <Card className="relative overflow-hidden p-4 border-primary/25 bg-primary/[0.03] transition-transform duration-150 hover:-translate-y-[1px]">
            <div className="absolute inset-x-0 top-0 h-[2px] bg-primary" aria-hidden />
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium text-muted">Số dư ứng dùng chung</p>
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary" aria-hidden>
                <Wallet className="h-3.5 w-3.5" />
              </span>
            </div>
            <p
              data-testid="vfin-kpi-shared-advance"
              className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-primary"
            >
              {summary ? formatVndMinor(summary.total_shared_advance_minor ?? "0") : "—"}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              Quỹ tạm ứng cấp Vendor (khấu trừ khi thanh toán)
            </p>
          </Card>
        ) : null}

        <Card className="relative overflow-hidden p-4 border-border/80 transition-transform duration-150 hover:-translate-y-[1px]">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-sky-500/85" aria-hidden />
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-muted">Tổng dư ứng theo sổ</p>
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-700 dark:text-sky-300" aria-hidden>
              <Layers className="h-3.5 w-3.5" />
            </span>
          </div>
          <p
            data-testid="vfin-kpi-advance"
            className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-[var(--navy)]"
          >
            {summary ? formatVndMinor(summary.total_advance_minor) : "—"}
          </p>
          <p className="mt-1.5 text-xs text-muted">
            {summary
              ? `${summary.vendors_with_advance_count} Vendor có sổ đang dư ứng`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="relative overflow-hidden p-4 border-border/80 transition-transform duration-150 hover:-translate-y-[1px]">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-emerald-500/85" aria-hidden />
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-muted">Vendor & Sổ dự án</p>
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" aria-hidden>
              <Building2 className="h-3.5 w-3.5" />
            </span>
          </div>
          <p
            data-testid="vfin-kpi-nonzero-count"
            className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-[var(--navy)]"
          >
            {summary
              ? `${summary.vendors_with_nonzero_balance_count} / ${summary.total_vendor_count}`
              : "—"}
          </p>
          {summary && summary.total_vendor_count > 0 ? (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-emerald-500/15" aria-hidden>
              <div
                className="h-full rounded-full bg-emerald-500/80"
                style={{
                  width: `${Math.min(100, Math.round((summary.vendors_with_nonzero_balance_count / summary.total_vendor_count) * 100))}%`,
                }}
              />
            </div>
          ) : null}
          <p className="mt-1.5 text-xs text-muted">
            {summary
              ? `${summary.sub_ledger_count} sổ chi tiết · ${summary.uninitialized_vendor_count} chưa mở đầu kỳ`
              : "Đang tải dữ liệu…"}
          </p>
        </Card>

        <Card className="relative overflow-hidden p-4 border-border/80 transition-transform duration-150 hover:-translate-y-[1px]">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-violet-500/85" aria-hidden />
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium text-muted">Tổng tham khảo phạm vi lọc</p>
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-700 dark:text-violet-300" aria-hidden>
              <Scale className="h-3.5 w-3.5" />
            </span>
          </div>
          <p
            data-testid="vfin-kpi-net"
            className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-[var(--navy)]"
          >
            {summary ? formatSignedVndDelta(summary.net_balance_minor) : "—"}
          </p>
          <p className="mt-1.5 text-xs text-muted">
            Tổng tham khảo các sổ trong phạm vi đang lọc
          </p>
        </Card>
      </section>

      {/* Search & Multi-Dimension Filter Toolbar */}
      <FilterToolbar
        dataTestId="vfin-vendor-filter-toolbar"
        summary={
          <div className="flex flex-wrap items-center gap-2">
            <span aria-live="polite" className="font-mono tabular-nums">
              {loading
                ? "Đang tra cứu danh sách Vendor & sổ dự án…"
                : data
                  ? `Hiển thị ${data.vendors.length} / ${data.total} Vendor phù hợp`
                  : "Chưa có dữ liệu"}
            </span>
            {data ? (
              <span>· Ngày nghiệp vụ: {formatVietnamDateLabel(data.authorization_date)}</span>
            ) : null}
            {visibilityScope === "PROJECT_SCOPED" ? (
              <StatusBadge tone="primary" dataTestId="vfin-project-scoped-badge">
                Sổ dự án phụ trách ({activeAssignedProjectCount}) · Không bù trừ chéo sổ
              </StatusBadge>
            ) : (
              <StatusBadge tone="info" dataTestId="vfin-global-scope-badge">
                Không bù trừ chéo sổ
              </StatusBadge>
            )}
            {!canRecord ? (
              <StatusBadge tone="info" dataTestId="vfin-view-only-badge">
                {canReconcile ? "Xem & Đối soát" : "Chỉ xem"}
              </StatusBadge>
            ) : null}
          </div>
        }
        actions={
          hasActiveFilters ? (
            <Button variant="ghost" size="sm" onClick={handleResetFilters}>
              <X className="h-3.5 w-3.5" aria-hidden />
              Xóa bộ lọc
            </Button>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
          <div className="space-y-1">
            <label
              htmlFor={searchInputId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Tìm Vendor gần đúng
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <input
                id={searchInputId}
                type="search"
                maxLength={VFIN_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập tên Vendor cần tra cứu…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          </div>

          <CatalogFilterCombobox
            id={projectSelectId}
            label="Dự án"
            allLabel="Tất cả dự án"
            placeholder="Gõ tên hoặc mã dự án"
            options={projectFilterOptions}
            value={projectFilter}
            containerClassName="relative space-y-1"
            labelClassName="block text-xs sm:text-sm font-semibold text-foreground"
            inputClassName="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onChange={(nextValue) => {
              setProjectFilter(nextValue);
              setPage(1);
            }}
          />

          <div className="space-y-1">
            <label
              htmlFor={accountantSelectId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Kế toán phụ trách sổ
            </label>
            <select
              id={accountantSelectId}
              value={accountantFilter}
              onChange={(e) => {
                setAccountantFilter(e.target.value);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả kế toán trong phạm vi</option>
              {(contextData?.accountants ?? []).map((acc) => (
                <option key={acc.accountant_ref} value={acc.accountant_ref}>
                  {acc.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor={contractTypeSelectId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Loại hợp đồng (Sổ riêng)
            </label>
            <select
              id={contractTypeSelectId}
              data-testid="vfin-contract-type-filter"
              value={contractTypeFilter}
              onChange={(e) => {
                setContractTypeFilter(e.target.value as VendorFinanceContractTypeFilter);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {VFIN_UI_CONTRACT_TYPE_FILTERS.map((opt) => (
                <option key={opt} value={opt}>
                  {CONTRACT_TYPE_FILTER_LABELS_VI[opt]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor={balanceSelectId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Nhóm số dư sổ
            </label>
            <select
              id={balanceSelectId}
              value={balanceFilter}
              onChange={(e) => {
                setBalanceFilter(e.target.value as VendorFinanceBalanceFilter);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {VFIN_UI_BALANCE_FILTERS.map((opt) => (
                <option key={opt} value={opt}>
                  {BALANCE_FILTER_LABELS_VI[opt]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label
              htmlFor={activeSelectId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Trạng thái Vendor
            </label>
            <select
              id={activeSelectId}
              value={activeFilter}
              onChange={(e) => {
                setActiveFilter(e.target.value as VendorFinanceActiveFilter);
                setPage(1);
              }}
              className="min-h-11 sm:min-h-9 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {VFIN_UI_ACTIVE_FILTERS.map((opt) => (
                <option key={opt} value={opt}>
                  {ACTIVE_FILTER_LABELS_VI[opt]}
                </option>
              ))}
            </select>
          </div>

          {contextData?.has_legacy_unallocated || ledgerScopeFilter !== "all" ? (
            <div className="space-y-1.5">
              <label
                htmlFor={scopeSelectId}
                className="block text-xs sm:text-sm font-semibold text-foreground"
              >
                Phạm vi sổ kế toán
              </label>
              <select
                id={scopeSelectId}
                value={ledgerScopeFilter}
                onChange={(e) => {
                  setLedgerScopeFilter(e.target.value as VendorFinanceLedgerScopeFilter);
                  setPage(1);
                }}
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {VFIN_UI_LEDGER_SCOPE_FILTERS.map((scope) => (
                  <option key={scope} value={scope}>
                    {LEDGER_SCOPE_FILTER_LABELS_VI[scope]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </FilterToolbar>

      {/* Error / Loading / Empty / Table States */}
      {errorMsg ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải danh sách tài chính Vendor">
            <p>{errorMsg}</p>
          </Alert>
          <div>
            <Button variant="primary" onClick={() => setReloadNonce((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        </div>
      ) : loading && !data ? (
        <Card className="p-8 text-center">
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Đang tải bảng tổng hợp công nợ Vendor…
          </p>
        </Card>
      ) : data && data.vendors.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <p className="text-sm font-medium text-foreground">
            Không tìm thấy Vendor hoặc sổ dự án nào khớp với điều kiện lọc hiện tại.
          </p>
          <p className="text-xs text-muted">
            Thử điều chỉnh từ khóa tìm kiếm, chọn lại Dự án / Kế toán hoặc đặt bộ lọc về mặc định.
          </p>
          {hasActiveFilters ? (
            <div className="flex justify-center pt-1">
              <Button variant="secondary" onClick={handleResetFilters}>
                Đặt lại bộ lọc
              </Button>
            </div>
          ) : null}
        </Card>
      ) : data ? (
        <DataTableContainer
          dataTestId="vfin-vendor-table"
          footer={
            <OffsetPager
              page={data.page}
              pageCount={pageCount}
              total={data.total}
              ariaLabel="Phân trang danh sách Vendor"
              disabled={loading}
              nextDisabled={loading || (!data.has_more && data.page >= pageCount)}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="mt-0 border-t-0 pt-0"
            />
          }
        >
          <table className={DATA_TABLE_CLASS}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={`${LIST_TH_CLASS} md:w-[10.5rem] md:max-w-[10.5rem] !whitespace-normal`}>
                  Vendor
                </th>
                <th scope="col" className={`${LIST_TH_CLASS} md:min-w-[20rem] md:max-w-[24rem] !whitespace-normal`}>
                  Sổ theo DA x KT x HĐ
                </th>
                <th
                  scope="col"
                  className={`${LIST_TH_CLASS} md:max-w-[10.5rem] whitespace-nowrap`}
                >
                  Số dư theo sổ
                </th>
                {canViewSharedAdvance ? (
                  <th
                    scope="col"
                    data-testid="vfin-th-shared-advance"
                    className={`${LIST_TH_CLASS} whitespace-nowrap`}
                  >
                    Dư ứng
                  </th>
                ) : null}
                <th scope="col" className={`${LIST_TH_CLASS} md:max-w-[9.5rem] !whitespace-normal`}>
                  Công nợ
                </th>
                <th scope="col" className={`${LIST_TH_CLASS} whitespace-nowrap`}>
                  Bút toán
                </th>
                <th scope="col" className={`${LIST_TH_CLASS} whitespace-nowrap`}>
                  GD gần nhất
                </th>
                <th scope="col" className={`${LIST_TH_CLASS} whitespace-nowrap`}>
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody>
              {data.vendors.map((vendor) => {
                const balanceInfo = formatVendorBalancePresentation({
                  current_balance_minor: vendor.current_balance_minor,
                  balance_direction: vendor.balance_direction,
                  entry_count: vendor.entry_count,
                  has_opening_entry: vendor.has_opening_entry,
                  sub_ledger_count: vendor.sub_ledger_count,
                });
                const defaultSub = vendor.sub_ledgers.length === 1 ? vendor.sub_ledgers[0]! : null;
                const detailHref = defaultSub
                  ? buildSubLedgerHref(vendor.vendor_id, defaultSub)
                  : `/finance/vendors/${encodeURIComponent(vendor.vendor_id)}`;

                return (
                  <tr key={vendor.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                    <td
                      data-card-header="true"
                      className={`${LIST_TD_CLASS} md:w-[10.5rem] md:max-w-[10.5rem] md:text-center whitespace-normal break-words`}
                    >
                      <div className="space-y-1 md:flex md:flex-col md:items-center md:text-center">
                        <div className="flex flex-wrap items-center md:justify-center gap-1.5">
                          <Link
                            href={detailHref}
                            className="font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded break-words"
                          >
                            {vendor.display_name}
                          </Link>
                          <StatusBadge
                            tone={vendor.active ? "success" : "neutral"}
                            className="shrink-0 whitespace-nowrap"
                          >
                            {vendor.active ? "Đang hoạt động" : "Ngừng HĐ"}
                          </StatusBadge>
                        </div>
                        <p className="font-mono text-xs text-muted break-all">{vendor.vendor_id}</p>
                      </div>
                    </td>

                    <td
                      data-label="Sổ theo DA x KT x HĐ"
                      className={`${LIST_TD_CLASS} max-md:flex-col max-md:items-stretch max-md:!text-left md:min-w-[20rem] md:max-w-[24rem] text-left whitespace-normal break-words`}
                    >
                      {vendor.sub_ledgers.length === 0 ? (
                        <span className="text-xs text-muted">Chưa liên kết sổ dự án</span>
                      ) : (
                        <div className="w-full space-y-1.5 text-left" data-testid="vfin-vendor-subledger-list">
                          {vendor.sub_ledgers.map((sub, idx) => {
                            const subBal = formatVendorBalancePresentation({
                              current_balance_minor: sub.current_balance_minor,
                              balance_direction: sub.balance_direction,
                              entry_count: sub.entry_count,
                              has_opening_entry: sub.has_opening_entry,
                            });
                            const subKey = `${sub.ledger_scope}:${sub.project_id ?? "legacy"}:${sub.accountant_ref ?? idx}:${sub.contract_type}`;
                            return (
                              <Link
                                key={subKey}
                                href={buildSubLedgerHref(vendor.vendor_id, sub)}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/40 px-2.5 py-1.5 text-left text-xs transition-all duration-150 hover:border-primary/50 hover:bg-surface hover:shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                              >
                                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 leading-snug">
                                  <StatusBadge
                                    tone={CONTRACT_TYPE_BADGE_TONES[sub.contract_type]}
                                    className="shrink-0 whitespace-nowrap"
                                  >
                                    {CONTRACT_TYPE_LABELS_VI[sub.contract_type]}
                                  </StatusBadge>
                                  {sub.ledger_scope === "LEGACY_UNALLOCATED" ? (
                                    <strong className="text-foreground break-words">
                                      Sổ lịch sử VFIN-01 (chưa gắn dự án)
                                    </strong>
                                  ) : (
                                    <span className="min-w-0 whitespace-normal break-words">
                                      <strong className="text-foreground">
                                        {sub.project_display_name ?? sub.project_id}
                                      </strong>
                                      <span className="text-muted"> · KT: </span>
                                      <span className="font-medium text-foreground">
                                        {sub.responsible_accountant_display_name ?? "—"}
                                      </span>
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 whitespace-nowrap font-mono font-semibold tabular-nums text-foreground">
                                  {subBal.signedText}
                                </span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </td>

                    <td
                      data-label="Số dư theo sổ"
                      className={`${LIST_TD_CLASS} md:max-w-[10.5rem] md:text-center font-mono tabular-nums`}
                    >
                      {vendor.balance_direction === "MULTI_LEDGER" ? (
                        <div className="space-y-0.5 text-xs">
                          <p className="font-sans text-[11px] font-medium leading-tight text-amber-700 dark:text-amber-300 whitespace-normal">
                            {VFIN_UI_REFERENCE_TOTAL_LABEL_VI}
                          </p>
                          <p className="whitespace-nowrap font-semibold text-foreground">
                            Phải trả:{" "}
                            <span className="whitespace-nowrap">
                              {formatVndMinor(vendor.payable_total_minor)}
                            </span>
                          </p>
                          <p className="whitespace-nowrap text-muted">
                            Dư ứng:{" "}
                            <span className="whitespace-nowrap">
                              {formatVndMinor(vendor.advance_total_minor)}
                            </span>
                          </p>
                        </div>
                      ) : (
                        <span className="whitespace-nowrap font-semibold">
                          {balanceInfo.signedText}
                        </span>
                      )}
                    </td>

                    {canViewSharedAdvance ? (
                      <td
                        data-label="Dư ứng"
                        data-testid="vfin-vendor-shared-advance"
                        className={`${LIST_TD_CLASS} md:text-center font-mono tabular-nums whitespace-nowrap`}
                      >
                        <span
                          className={`whitespace-nowrap ${
                            BigInt(vendor.shared_advance_balance_minor ?? "0") > BigInt(0)
                              ? "font-semibold text-primary"
                              : "text-muted"
                          }`}
                        >
                          {formatVndMinor(vendor.shared_advance_balance_minor ?? "0")}
                        </span>
                      </td>
                    ) : null}

                    <td data-label="Công nợ" className={`${LIST_TD_CLASS} md:max-w-[9.5rem] md:text-center`}>
                      <StatusBadge
                        tone={balanceInfo.tone}
                        className="!whitespace-normal justify-center text-center leading-tight"
                      >
                        {balanceInfo.statusLabel}
                      </StatusBadge>
                    </td>

                    <td
                      data-label="Bút toán"
                      className={`${LIST_TD_CLASS} md:text-center font-mono tabular-nums whitespace-nowrap`}
                    >
                      {vendor.entry_count}
                    </td>

                    <td data-label="GD gần nhất" className={`${LIST_TD_CLASS} md:text-center`}>
                      <div className="text-xs space-y-0.5 whitespace-nowrap">
                        <p>
                          <span className="text-muted">GD: </span>
                          <span className="font-mono text-foreground">
                            {formatVietnamDateLabel(vendor.last_effective_date)}
                          </span>
                        </p>
                        <p>
                          <span className="text-muted">Đối soát: </span>
                          <span className="font-mono text-foreground">
                            {formatVietnamDateLabel(vendor.last_reconciled_as_of_date)}
                          </span>
                        </p>
                      </div>
                    </td>

                    <td data-card-actions="true" className={`${LIST_TD_CLASS} md:text-center`}>
                      <RowActionCluster className="md:justify-center">
                        <Link
                          href={detailHref}
                          aria-label={`Xem sổ cái của ${vendor.display_name}`}
                          className={`${buttonClasses({ variant: "secondary", size: "sm" })} md:!h-auto md:!min-h-8 md:!px-2.5 md:!py-1.5 md:!text-xs !whitespace-normal text-center leading-tight`}
                        >
                          <span className="inline-block text-center leading-tight">
                            Sổ cái
                            <br />
                            &amp; Đối soát
                          </span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </Link>
                      </RowActionCluster>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}
    </PageShell>
  );
}
