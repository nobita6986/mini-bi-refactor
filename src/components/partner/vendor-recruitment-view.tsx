"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  PartnerKpiCard,
  ResponsiveTableRegion,
  extractPartnerApiErrorCode,
} from "@/components/partner/partner-ui-shared";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { authUiErrorMessage } from "@/lib/auth/auth-ui";
import {
  projectVendorRecruitmentSummary,
  type PartnerGroupBy,
  type PartnerVendorRecruitmentSummary,
} from "@/lib/partner/contract";

type FilterState = {
  fromDate: string;
  toDate: string;
  projectId: string;
  groupBy: PartnerGroupBy;
};

const EMPTY_FILTERS: FilterState = {
  fromDate: "",
  toDate: "",
  projectId: "",
  groupBy: "month",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; summary: PartnerVendorRecruitmentSummary }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export function VendorRecruitmentView() {
  const router = useRouter();
  const [draft, setDraft] = useState<FilterState>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const params = new URLSearchParams();
      if (applied.fromDate) params.set("from_date", applied.fromDate);
      if (applied.toDate) params.set("to_date", applied.toDate);
      if (applied.projectId) params.set("project_id", applied.projectId);
      params.set("group_by", applied.groupBy);

      try {
        const response = await fetch(
          `/api/partner/recruitment/summary?${params.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (controller.signal.aborted) return;
        const payload: unknown = await response.json().catch(() => null);
        const code = extractPartnerApiErrorCode(payload);
        if (response.status === 401) {
          router.replace("/login?next=/partner/recruitment");
          return;
        }
        if (response.status === 403) {
          if (code === "PASSWORD_CHANGE_REQUIRED") {
            router.replace("/partner/change-password");
            return;
          }
          if (code === "ACCOUNT_PENDING_ACTIVATION") {
            router.replace("/activate");
            return;
          }
          setState({
            kind: "forbidden",
            message: authUiErrorMessage(code ?? "PARTNER_FORBIDDEN"),
          });
          return;
        }
        if (
          response.status === 200 &&
          payload &&
          typeof payload === "object" &&
          "ok" in payload &&
          (payload as { ok: unknown }).ok === true &&
          "summary" in payload
        ) {
          const summary = projectVendorRecruitmentSummary(
            (payload as { summary: unknown }).summary,
          );
          if (summary) {
            setState({ kind: "loaded", summary });
            return;
          }
        }
        setState({
          kind: "error",
          message: "Không thể tải thống kê lượt tuyển của Vendor.",
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải thống kê tuyển dụng.",
        });
      }
    })();
    return () => controller.abort();
  }, [applied, reloadToken, router]);

  function reloadSummary() {
    setState({ kind: "loading" });
    setReloadToken((v) => v + 1);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError(null);
    if (draft.fromDate && draft.toDate && draft.fromDate > draft.toDate) {
      setFilterError("Ngày bắt đầu không được lớn hơn ngày kết thúc.");
      return;
    }
    setState({ kind: "loading" });
    setApplied({ ...draft });
  }

  function resetFilters() {
    setFilterError(null);
    setDraft(EMPTY_FILTERS);
    setState({ kind: "loading" });
    setApplied(EMPTY_FILTERS);
  }

  const projects = state.kind === "loaded" ? state.summary.available_projects : [];

  return (
    <PageShell>
      <PageHeader
        eyebrow="Cổng đối tác · Vendor"
        title="Tuyển dụng của tôi"
        description="Thống kê lượt tuyển dụng đã nộp của Vendor theo ngày vào làm, dự án và kỳ."
        actions={
          <Link
            href="/partner/workers"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            Xem danh sách NLĐ
          </Link>
        }
      />

      <Card>
        <CardHeader
          title="Bộ lọc thống kê"
          description="Lọc theo ngày vào làm đầu tiên, dự án và cách nhóm thời gian."
        />
        <form
          onSubmit={applyFilters}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="rec-from-date" className="text-xs font-medium text-muted">
              Từ ngày (vào làm)
            </label>
            <input
              id="rec-from-date"
              type="date"
              value={draft.fromDate}
              onChange={(event) =>
                setDraft((cur) => ({ ...cur, fromDate: event.target.value }))
              }
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rec-to-date" className="text-xs font-medium text-muted">
              Đến ngày (vào làm)
            </label>
            <input
              id="rec-to-date"
              type="date"
              value={draft.toDate}
              onChange={(event) =>
                setDraft((cur) => ({ ...cur, toDate: event.target.value }))
              }
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rec-project" className="text-xs font-medium text-muted">
              Dự án
            </label>
            <select
              id="rec-project"
              value={draft.projectId}
              onChange={(event) =>
                setDraft((cur) => ({ ...cur, projectId: event.target.value }))
              }
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả dự án</option>
              {projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.project_name} ({p.worker_count})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rec-group-by" className="text-xs font-medium text-muted">
              Nhóm theo
            </label>
            <select
              id="rec-group-by"
              value={draft.groupBy}
              onChange={(event) =>
                setDraft((cur) => ({
                  ...cur,
                  groupBy: event.target.value === "day" ? "day" : "month",
                }))
              }
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="month">Theo tháng</option>
              <option value="day">Theo ngày</option>
            </select>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" variant="primary" size="md">
              Áp dụng
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={resetFilters}>
              Đặt lại
            </Button>
          </div>
        </form>
        {filterError ? (
          <p role="alert" className="mt-3 text-sm text-status-danger-text">
            {filterError}
          </p>
        ) : null}
      </Card>

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải thống kê tuyển dụng…
          </p>
        </Card>
      ) : null}

      {state.kind === "forbidden" ? (
        <Card>
          <ErrorState title="Không có quyền xem thống kê Vendor" detail={state.message} />
        </Card>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được thống kê" detail={state.message} />
            <Button type="button" onClick={reloadSummary}>
              Thử tải lại
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "loaded" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <PartnerKpiCard
              label="Tổng lượt tuyển"
              value={state.summary.total_workers}
              hint={state.summary.vendor_name}
            />
            <PartnerKpiCard label="Đang làm việc (ON)" value={state.summary.on_count} />
            <PartnerKpiCard label="Đã nghỉ (OFF)" value={state.summary.off_count} />
            <PartnerKpiCard label="Chưa xác nhận" value={state.summary.unconfirmed_count} />
          </div>

          <Card>
            <CardHeader
              title="Thống kê theo dự án"
              description="Phân bổ lượt tuyển của Vendor theo từng dự án."
            />
            {state.summary.by_project.length === 0 ? (
              <EmptyState
                title="Chưa có dữ liệu dự án"
                description="Không có lượt tuyển nào khớp điều kiện lọc."
              />
            ) : (
              <ResponsiveTableRegion
                captionId="vendor-summary-by-project-caption"
                caption="Thống kê lượt tuyển theo dự án"
              >
                <thead className="sticky top-0 z-10 border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Dự án</th>
                    <th scope="col" className="px-3 py-3 text-right">Tổng NLĐ</th>
                    <th scope="col" className="px-3 py-3 text-right">Đang làm (ON)</th>
                    <th scope="col" className="px-3 py-3 text-right">Đã nghỉ (OFF)</th>
                    <th scope="col" className="px-3 py-3 text-right">Chưa xác nhận</th>
                    <th scope="col" className="px-3 py-3 text-right">Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.by_project.map((row) => (
                    <tr
                      key={row.project_id}
                      className="border-b border-border/70 last:border-0 hover:bg-surface-hover"
                    >
                      <td data-card-header="true" className="px-3 py-3 font-medium">
                        {row.project_name}
                      </td>
                      <td data-label="Tổng NLĐ" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.total_workers}
                      </td>
                      <td data-label="Đang làm (ON)" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.on_count}
                      </td>
                      <td data-label="Đã nghỉ (OFF)" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.off_count}
                      </td>
                      <td data-label="Chưa xác nhận" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.unconfirmed_count}
                      </td>
                      <td data-card-actions="true" className="px-3 py-3 text-right">
                        <Link
                          href={`/partner/workers?project_id=${encodeURIComponent(row.project_id)}`}
                          className={buttonClasses({ variant: "outline", size: "sm" })}
                        >
                          Danh sách NLĐ
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTableRegion>
            )}
          </Card>

          <Card>
            <CardHeader
              title={
                state.summary.group_by === "day"
                  ? "Thống kê theo ngày vào làm"
                  : "Thống kê theo tháng vào làm"
              }
              description="Tổng hợp theo ngày bắt đầu làm việc đầu tiên."
            />
            {state.summary.by_period.length === 0 ? (
              <EmptyState
                title="Chưa có dữ liệu theo kỳ"
                description="Không có lượt tuyển nào khớp điều kiện lọc."
              />
            ) : (
              <ResponsiveTableRegion
                captionId="vendor-summary-by-period-caption"
                caption="Thống kê lượt tuyển theo kỳ"
              >
                <thead className="sticky top-0 z-10 border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Kỳ</th>
                    <th scope="col" className="px-3 py-3 text-right">Tổng NLĐ</th>
                    <th scope="col" className="px-3 py-3 text-right">Đang làm (ON)</th>
                    <th scope="col" className="px-3 py-3 text-right">Đã nghỉ (OFF)</th>
                    <th scope="col" className="px-3 py-3 text-right">Chưa xác nhận</th>
                  </tr>
                </thead>
                <tbody>
                  {state.summary.by_period.map((row) => (
                    <tr
                      key={row.period_key}
                      className="border-b border-border/70 last:border-0 hover:bg-surface-hover"
                    >
                      <td data-card-header="true" className="px-3 py-3 font-mono font-medium">
                        {row.period_key}
                      </td>
                      <td data-label="Tổng NLĐ" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.total_workers}
                      </td>
                      <td data-label="Đang làm (ON)" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.on_count}
                      </td>
                      <td data-label="Đã nghỉ (OFF)" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.off_count}
                      </td>
                      <td data-label="Chưa xác nhận" className="px-3 py-3 text-right font-mono tabular-nums">
                        {row.unconfirmed_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTableRegion>
            )}
          </Card>
        </>
      ) : null}
    </PageShell>
  );
}
