"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  CatalogFilterCombobox,
  type CatalogFilterOption,
} from "@/components/ui/catalog-filter-combobox";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  isValidCalendarMonthOrAll,
  isValidProjectId,
  isValidUuid,
  isValidVendorId,
  projectMonthlyReport,
  type MonthlyReportReconciliation,
  type MonthlyReportResponse,
} from "@/lib/vendor-referrals/vendor-referrer-contract";

type ReportState =
  | { kind: "loading" }
  | { kind: "loaded"; data: MonthlyReportResponse }
  | { kind: "denied"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

const INTEGER_FORMATTER = new Intl.NumberFormat("vi-VN");

export function formatTurnCount(value: number): string {
  return INTEGER_FORMATTER.format(value);
}

export function buildVendorReferralReportQuery(input: {
  month: string;
  allTime: boolean;
  referrerPersonId?: string;
  vendorId?: string;
  projectId?: string;
}): URLSearchParams | null {
  const params = new URLSearchParams();
  if (input.allTime) {
    params.set("month", "ALL");
  } else {
    const trimmedMonth = input.month.trim();
    if (trimmedMonth !== "") {
      if (!isValidCalendarMonthOrAll(trimmedMonth) || trimmedMonth === "ALL") {
        return null;
      }
      params.set("month", trimmedMonth);
    }
  }

  const referrerId = (input.referrerPersonId ?? "").trim();
  if (referrerId !== "") {
    if (!isValidUuid(referrerId)) return null;
    params.set("referrer_person_id", referrerId.toLowerCase());
  }

  const vendorId = (input.vendorId ?? "").trim();
  if (vendorId !== "") {
    if (!isValidVendorId(vendorId)) return null;
    params.set("vendor_id", vendorId);
  }

  const projectId = (input.projectId ?? "").trim();
  if (projectId !== "") {
    if (!isValidProjectId(projectId)) return null;
    params.set("project_id", projectId);
  }

  return params;
}

export function checkReconciliationConservation(rec: MonthlyReportReconciliation): {
  attributed: number;
  unassigned: number;
  unresolved: number;
  sum: number;
  total: number;
  balanced: boolean;
} {
  const sum = rec.attributed_turns + rec.unassigned_vendor_turns + rec.unresolved_vendor_turns;
  return {
    attributed: rec.attributed_turns,
    unassigned: rec.unassigned_vendor_turns,
    unresolved: rec.unresolved_vendor_turns,
    sum,
    total: rec.total_vendor_turns,
    balanced:
      sum === rec.total_vendor_turns &&
      rec.attributed_turns + rec.unassigned_vendor_turns === rec.matched_vendor_turns,
  };
}

export function classifyVendorReferralReportError(
  status: number,
  payload: unknown,
): { kind: "denied" | "unavailable" | "error"; message: string } {
  const code =
    typeof payload === "object" &&
    payload !== null &&
    "code" in payload &&
    typeof (payload as { code?: unknown }).code === "string"
      ? (payload as { code: string }).code
      : null;

  if (
    status === 401 ||
    status === 403 ||
    code === "VENDOR_REFERRER_DENIED" ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "UNAUTHENTICATED"
  ) {
    return {
      kind: "denied",
      message: "Chỉ Ban Giám đốc (BoD) được phân quyền mới có thể xem báo cáo này.",
    };
  }
  if (status === 400 || code === "VENDOR_REFERRER_INVALID") {
    return {
      kind: "error",
      message: "Bộ lọc báo cáo không hợp lệ. Vui lòng kiểm tra lại tháng, NVTD, Vendor hoặc dự án.",
    };
  }
  return {
    kind: "unavailable",
    message: "Dịch vụ báo cáo sản lượng Vendor giới thiệu hiện không khả dụng. Vui lòng thử lại.",
  };
}

export function formatPeriodLabel(report: MonthlyReportResponse): string {
  if (report.month === "ALL") {
    return "Toàn bộ thời gian (Đối soát toàn bộ REQ)";
  }
  if (report.period_from && report.period_to) {
    return `Tháng ${report.month} (${report.period_from} → ${report.period_to})`;
  }
  return `Tháng ${report.month}`;
}

function ReferrerKpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint: string;
  accent: string;
}) {
  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-[20px] border border-border/80 bg-surface p-5 shadow-[var(--shadow-card)] transition-[box-shadow,border-color,transform] duration-[var(--ui-motion-hover,160ms)] hover:-translate-y-[1px] hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-card-hover)]">
      <div
        className="pointer-events-none absolute -right-5 -top-5 h-24 w-24 rounded-full opacity-[0.14] transition-opacity duration-200 group-hover:opacity-25"
        style={{
          backgroundImage: `repeating-linear-gradient(135deg, ${accent} 0px, ${accent} 1.5px, transparent 1.5px, transparent 6px)`,
        }}
        aria-hidden="true"
      />
      <p className="flex items-center gap-2.5 text-xs font-medium tracking-wide text-muted">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-surface-muted/80"
          aria-hidden="true"
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: accent }}
          />
        </span>
        <span>{label}</span>
      </p>
      <div className="mt-2.5 text-3xl font-semibold tracking-tight tabular-nums text-[var(--navy)]">
        {formatTurnCount(value)}
      </div>
      <p className="mt-auto pt-2 text-xs text-muted">{hint}</p>
    </div>
  );
}

export function VendorReferralReportView() {
  const monthInputId = useId();
  const referrerComboId = useId();
  const vendorComboId = useId();
  const projectComboId = useId();

  const [requestedMonth, setRequestedMonth] = useState("");
  const [serverMonth, setServerMonth] = useState("");
  const [allTime, setAllTime] = useState(false);
  const [referrerFilter, setReferrerFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<ReportState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildVendorReferralReportQuery({
        month: requestedMonth,
        allTime,
        referrerPersonId: referrerFilter,
        vendorId: vendorFilter,
        projectId: projectFilter,
      });
      if (!query) {
        setState({
          kind: "error",
          message: "Tham số bộ lọc báo cáo không hợp lệ. Vui lòng kiểm tra lại tháng.",
        });
        return;
      }

      setState({ kind: "loading" });
      let response: Response;
      try {
        const qs = query.toString();
        response = await fetch(
          qs ? `/api/admin/vendor-referrals/report?${qs}` : "/api/admin/vendor-referrals/report",
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "unavailable",
          message: "Không thể tải báo cáo sản lượng Vendor giới thiệu do lỗi kết nối mạng.",
        });
        return;
      }

      const json: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const classified = classifyVendorReferralReportError(response.status, json);
        setState({ kind: classified.kind, message: classified.message });
        return;
      }

      const rawData =
        typeof json === "object" && json !== null && "ok" in json && (json as { ok: unknown }).ok === true
          ? (json as { data?: unknown }).data
          : null;
      const projected = projectMonthlyReport(rawData);
      if (!projected) {
        setState({
          kind: "unavailable",
          message: "Dữ liệu báo cáo từ máy chủ không khớp hợp đồng hoặc lệch đối soát bảo toàn.",
        });
        return;
      }

      if (projected.month !== "ALL") {
        setServerMonth(projected.month);
      }
      setState({ kind: "loaded", data: projected });
    })();

    return () => controller.abort();
  }, [allTime, projectFilter, referrerFilter, reloadToken, requestedMonth, vendorFilter]);

  const report = state.kind === "loaded" ? state.data : null;

  const referrerOptions = useMemo<CatalogFilterOption[]>(() => {
    if (!report) return [];
    return report.filter_options.referrers.map((item) => ({
      id: item.person_id,
      label: `${item.full_name} · ${item.employee_code}${item.department_name ? ` · ${item.department_name}` : ""}`,
      keywords: `${item.full_name} ${item.employee_code} ${item.department_name ?? ""}`,
    }));
  }, [report]);

  const vendorOptions = useMemo<CatalogFilterOption[]>(() => {
    if (!report) return [];
    return report.filter_options.vendors.map((item) => ({
      id: item.vendor_id,
      label: `${item.display_name} (${item.vendor_id})`,
      keywords: `${item.display_name} ${item.vendor_id}`,
    }));
  }, [report]);

  const projectOptions = useMemo<CatalogFilterOption[]>(() => {
    if (!report) return [];
    return report.filter_options.projects.map((item) => ({
      id: item.project_id,
      label: `${item.display_name} (${item.project_id})`,
      keywords: `${item.display_name} ${item.project_id}`,
    }));
  }, [report]);

  const hasDimensionFilter = Boolean(referrerFilter || vendorFilter || projectFilter);
  const conservation = report ? checkReconciliationConservation(report.reconciliation) : null;

  return (
    <PageShell className="px-0 py-0">
      <PageHeader
        eyebrow="Báo cáo điều hành Ban Giám đốc"
        title="Báo cáo sản lượng Vendor giới thiệu"
        badge={
          report ? (
            <StatusBadge tone="primary">{formatPeriodLabel(report)}</StatusBadge>
          ) : null
        }
        description="Theo dõi số lượt tuyển Vendor theo NVTD giới thiệu có hiệu lực tại ngày vào làm (first_work_date) và đối soát bảo toàn 100% tổng lượt tuyển Vendor."
        actions={
          <>
            <Link
              href="/admin/catalog/vendors"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Quản lý người giới thiệu Vendor
            </Link>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={state.kind === "loading"}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Làm mới
            </Button>
          </>
        }
      />

      <FilterToolbar
        summary={
          report ? (
            <>
              <span>
                Ngày hệ thống (GMT+7):{" "}
                <strong className="font-mono text-foreground">{report.authorization_date}</strong>
              </span>
              <span>
                Đang hiển thị:{" "}
                <strong className="text-foreground">
                  {formatTurnCount(report.filtered_summary.attributed_turns)} lượt đã gán NVTD
                </strong>{" "}
                ({report.filtered_summary.referrer_count} NVTD · {report.filtered_summary.vendor_count}{" "}
                Vendor · {report.filtered_summary.project_count} dự án)
              </span>
            </>
          ) : (
            <span>Đang áp dụng bộ lọc kỳ báo cáo theo giờ Việt Nam (Asia/Ho_Chi_Minh).</span>
          )
        }
        actions={
          hasDimensionFilter ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setReferrerFilter("");
                setVendorFilter("");
                setProjectFilter("");
              }}
            >
              Xóa bộ lọc chiều
            </Button>
          ) : null
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor={monthInputId} className="font-medium text-muted">
              Tháng (YYYY-MM)
            </label>
            <input
              id={monthInputId}
              type="month"
              value={requestedMonth || serverMonth}
              disabled={allTime}
              onChange={(event) => {
                setAllTime(false);
                setRequestedMonth(event.target.value);
              }}
              className="h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <label className="flex items-center gap-2 self-end pb-2.5 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={allTime}
              onChange={(event) => {
                const nextAll = event.target.checked;
                setAllTime(nextAll);
                if (!nextAll && requestedMonth === "" && serverMonth !== "") {
                  setRequestedMonth(serverMonth);
                }
              }}
            />
            Tất cả (Đối soát toàn bộ REQ)
          </label>

          <CatalogFilterCombobox
            id={referrerComboId}
            label="NVTD giới thiệu"
            allLabel="Tất cả NVTD giới thiệu"
            placeholder="Tìm NVTD giới thiệu..."
            options={referrerOptions}
            value={referrerFilter}
            disabled={!report}
            onChange={setReferrerFilter}
          />

          <CatalogFilterCombobox
            id={vendorComboId}
            label="Vendor"
            allLabel="Tất cả Vendor"
            placeholder="Tìm Vendor..."
            options={vendorOptions}
            value={vendorFilter}
            disabled={!report}
            onChange={setVendorFilter}
          />

          <CatalogFilterCombobox
            id={projectComboId}
            label="Dự án"
            allLabel="Tất cả dự án"
            placeholder="Tìm dự án..."
            options={projectOptions}
            value={projectFilter}
            disabled={!report}
            onChange={setProjectFilter}
          />
        </div>
      </FilterToolbar>

      {state.kind === "loading" ? (
        <p role="status" className="py-10 text-center text-sm text-muted">
          Đang tải báo cáo sản lượng Vendor giới thiệu…
        </p>
      ) : null}

      {state.kind === "denied" ? (
        <ErrorState title="Không có quyền xem báo cáo" detail={state.message} />
      ) : null}

      {state.kind === "unavailable" ? (
        <div className="space-y-3">
          <ErrorState title="Báo cáo tạm thời không khả dụng" detail={state.message} />
          <Button type="button" variant="secondary" onClick={() => setReloadToken((v) => v + 1)}>
            Thử tải lại
          </Button>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState title="Không tải được báo cáo" detail={state.message} />
          <Button type="button" variant="secondary" onClick={() => setReloadToken((v) => v + 1)}>
            Thử tải lại
          </Button>
        </div>
      ) : null}

      {report && conservation ? (
        <div className="space-y-5">
          <section
            aria-label="Chỉ số tổng hợp sản lượng Vendor giới thiệu"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            <ReferrerKpiCard
              label="Tổng lượt tuyển Vendor"
              value={report.reconciliation.total_vendor_turns}
              hint="Dùng cùng đơn vị lượt tuyển trên first_work_date của hồ sơ đã nộp, chưa xóa, chưa hủy như Dashboard."
              accent="var(--chart-1)"
            />
            <ReferrerKpiCard
              label="Lượt đã gán NVTD giới thiệu"
              value={
                hasDimensionFilter
                  ? report.filtered_summary.attributed_turns
                  : report.reconciliation.attributed_turns
              }
              hint={
                hasDimensionFilter
                  ? `Theo bộ lọc (${report.filtered_summary.referrer_count} NVTD · ${report.filtered_summary.vendor_count} Vendor · ${report.filtered_summary.project_count} dự án); toàn kỳ: ${formatTurnCount(report.reconciliation.attributed_turns)} lượt.`
                  : "Các lượt tuyển từ Vendor có liên kết NVTD giới thiệu hiệu lực tại first_work_date."
              }
              accent="var(--chart-5)"
            />
            <ReferrerKpiCard
              label="Vendor chưa có người giới thiệu"
              value={report.reconciliation.unassigned_vendor_turns}
              hint="Đã xác định được Vendor nhưng chưa có NVTD giới thiệu tại ngày first_work_date."
              accent="var(--chart-3)"
            />
            <ReferrerKpiCard
              label="Chưa xác định được Vendor"
              value={report.reconciliation.unresolved_vendor_turns}
              hint="Hồ sơ trước mốc lịch sử gắn Vendor trên recruiter_provider_memberships."
              accent="var(--chart-6)"
            />
          </section>

          <Alert
            tone={conservation.balanced ? "info" : "warning"}
            title="Đối soát bảo toàn sản lượng (không tính trùng)"
          >
            <p className="font-mono text-xs sm:text-sm tabular-nums">
              {formatTurnCount(conservation.attributed)} (Đã gán NVTD) +{" "}
              {formatTurnCount(conservation.unassigned)} (Vendor chưa có người giới thiệu) +{" "}
              {formatTurnCount(conservation.unresolved)} (Chưa xác định được Vendor) ={" "}
              {formatTurnCount(conservation.sum)} /{" "}
              {formatTurnCount(conservation.total)} (Tổng lượt tuyển Vendor)
            </p>
            <p className="text-xs">
              Mỗi lượt tuyển thuộc duy nhất một trong ba nhóm trên tại ngày vào làm ({" "}
              <span className="font-mono">first_work_date</span>); lịch sử thay thế trong cùng ngày
              được xử lý theo khoảng nửa mở <span className="font-mono">[effective_from, effective_to)</span>.
            </p>
          </Alert>

          <Card>
            <CardHeader
              title="Tổng hợp theo NVTD giới thiệu"
              description={`${report.by_referrer.length} NVTD có lượt tuyển trong phạm vi bộ lọc.`}
            />
            {report.by_referrer.length === 0 ? (
              <EmptyState
                title="Chưa có lượt tuyển nào được gán NVTD giới thiệu trong bộ lọc hiện tại"
                description="Kiểm tra bảng Vendor chưa có người giới thiệu bên dưới hoặc thay đổi bộ lọc kỳ/chiều."
              />
            ) : (
              <DataTableContainer>
                <table className={DATA_TABLE_CLASS}>
                  <caption className="sr-only">
                    Bảng tổng hợp sản lượng theo NVTD giới thiệu
                  </caption>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        NVTD giới thiệu
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Mã NV
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Phòng ban
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Số Vendor
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Số dự án
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Lượt tuyển
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.by_referrer.map((item) => (
                      <tr key={item.referrer_person_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={`${DATA_TABLE_TD_CLASS} font-medium`}>
                          {item.referrer_full_name}
                        </td>
                        <td data-label="Mã NV" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}>
                          {item.referrer_employee_code}
                        </td>
                        <td data-label="Phòng ban" className={DATA_TABLE_TD_CLASS}>
                          {item.referrer_department_name ?? "—"}
                        </td>
                        <td
                          data-label="Số Vendor"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatTurnCount(item.vendor_count)}
                        </td>
                        <td
                          data-label="Số dự án"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          {formatTurnCount(item.project_count)}
                        </td>
                        <td
                          data-label="Lượt tuyển"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums text-[var(--navy)]`}
                        >
                          {formatTurnCount(item.turns)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Chi tiết NVTD × Vendor × Dự án"
              description={`${report.rows.length} dòng chi tiết được ghi nhận theo đúng NVTD giữ liên kết tại first_work_date.`}
            />
            {report.rows.length === 0 ? (
              <EmptyState
                title="Không có dòng chi tiết NVTD × Vendor × Dự án"
                description="Thay đổi bộ lọc hoặc kiểm tra các nhóm đối soát chưa gán bên dưới."
              />
            ) : (
              <DataTableContainer>
                <table className={DATA_TABLE_CLASS}>
                  <caption className="sr-only">
                    Bảng chi tiết sản lượng theo NVTD, Vendor và Dự án
                  </caption>
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        NVTD giới thiệu
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Vendor
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Dự án
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Lượt tuyển
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr
                        key={`${row.referrer_person_id}:${row.vendor_id}:${row.project_id}`}
                        className={DATA_TABLE_ROW_CLASS}
                      >
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="font-medium text-foreground">{row.referrer_full_name}</div>
                          <div className="text-xs text-muted">
                            <span className="font-mono">{row.referrer_employee_code}</span>
                            {row.referrer_department_name
                              ? ` · ${row.referrer_department_name}`
                              : ""}
                          </div>
                        </td>
                        <td data-label="Vendor" className={DATA_TABLE_TD_CLASS}>
                          <div className="font-medium text-foreground">
                            {row.vendor_display_name}
                          </div>
                          <div className="font-mono text-xs text-muted">{row.vendor_id}</div>
                        </td>
                        <td data-label="Dự án" className={DATA_TABLE_TD_CLASS}>
                          <div className="font-medium text-foreground">
                            {row.project_display_name}
                          </div>
                          <div className="font-mono text-xs text-muted">{row.project_id}</div>
                        </td>
                        <td
                          data-label="Lượt tuyển"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums text-[var(--navy)]`}
                        >
                          {formatTurnCount(row.turns)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTableContainer>
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Vendor chưa có người giới thiệu"
                description={`Tổng cộng ${formatTurnCount(report.reconciliation.unassigned_vendor_turns)} lượt trong kỳ chưa có liên kết NVTD hiệu lực tại first_work_date.`}
              />
              {report.unassigned_vendors.length === 0 ? (
                <EmptyState
                  title="Tất cả Vendor phát sinh lượt tuyển đã có người giới thiệu"
                  description="Không có lượt tuyển nào rơi vào nhóm chưa gán người giới thiệu trong kỳ."
                />
              ) : (
                <DataTableContainer>
                  <table className={DATA_TABLE_CLASS}>
                    <caption className="sr-only">
                      Danh sách Vendor chưa có người giới thiệu trong kỳ
                    </caption>
                    <thead className={DATA_TABLE_HEAD_CLASS}>
                      <tr>
                        <th scope="col" className={DATA_TABLE_TH_CLASS}>
                          Vendor
                        </th>
                        <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                          Số dự án
                        </th>
                        <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                          Lượt tuyển
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.unassigned_vendors.map((item) => (
                        <tr key={item.vendor_id} className={DATA_TABLE_ROW_CLASS}>
                          <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                            <div className="font-medium text-foreground">
                              {item.vendor_display_name}
                            </div>
                            <div className="font-mono text-xs text-muted">{item.vendor_id}</div>
                          </td>
                          <td
                            data-label="Số dự án"
                            className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                          >
                            {formatTurnCount(item.project_count)}
                          </td>
                          <td
                            data-label="Lượt tuyển"
                            className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                          >
                            {formatTurnCount(item.turns)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTableContainer>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Chưa xác định được Vendor"
                description={`Tổng cộng ${formatTurnCount(report.reconciliation.unresolved_vendor_turns)} lượt thuộc hồ sơ trước mốc lịch sử gắn Vendor trên recruiter_provider_memberships.`}
              />
              {report.unresolved_vendor_breakdown.length === 0 ? (
                <EmptyState
                  title="Không có lượt tuyển chưa xác định Vendor"
                  description="Mọi lượt tuyển Vendor trong kỳ đều đã ánh xạ được về Vendor cụ thể."
                />
              ) : (
                <DataTableContainer>
                  <table className={DATA_TABLE_CLASS}>
                    <caption className="sr-only">
                      Chi tiết các lượt tuyển chưa xác định được Vendor
                    </caption>
                    <thead className={DATA_TABLE_HEAD_CLASS}>
                      <tr>
                        <th scope="col" className={DATA_TABLE_TH_CLASS}>
                          Tài khoản tuyển dụng Vendor
                        </th>
                        <th scope="col" className={DATA_TABLE_TH_CLASS}>
                          Dự án
                        </th>
                        <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                          Lượt tuyển
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.unresolved_vendor_breakdown.map((item) => (
                        <tr
                          key={`${item.recruiter_id}:${item.project_id}`}
                          className={DATA_TABLE_ROW_CLASS}
                        >
                          <td data-card-header="true" className={`${DATA_TABLE_TD_CLASS} font-medium`}>
                            {item.recruiter_display_name}
                          </td>
                          <td data-label="Dự án" className={DATA_TABLE_TD_CLASS}>
                            <div className="font-medium text-foreground">
                              {item.project_display_name}
                            </div>
                            <div className="font-mono text-xs text-muted">{item.project_id}</div>
                          </td>
                          <td
                            data-label="Lượt tuyển"
                            className={`${DATA_TABLE_TD_CLASS} text-right font-mono font-semibold tabular-nums`}
                          >
                            {formatTurnCount(item.turns)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTableContainer>
              )}
            </Card>
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
