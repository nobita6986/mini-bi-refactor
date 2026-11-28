"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  EmploymentStatusBadge,
  ResponsiveTableRegion,
  extractPartnerApiErrorCode,
  formatPartnerDateVi,
} from "@/components/partner/partner-ui-shared";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { authUiErrorMessage } from "@/lib/auth/auth-ui";
import {
  projectVendorWorkerList,
  type PartnerVendorWorkerList,
} from "@/lib/partner/contract";

const PAGE_SIZE = 25;

type FilterState = {
  search: string;
  projectId: string;
  fromDate: string;
  toDate: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; list: PartnerVendorWorkerList }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export function VendorWorkersView({
  initialProjectId = "",
}: {
  initialProjectId?: string;
}) {
  const router = useRouter();
  const initialFilters: FilterState = {
    search: "",
    projectId: initialProjectId,
    fromDate: "",
    toDate: "",
  };
  const [draft, setDraft] = useState<FilterState>(initialFilters);
  const [applied, setApplied] = useState<FilterState>(initialFilters);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      if (applied.search.trim()) params.set("search", applied.search.trim());
      if (applied.projectId) params.set("project_id", applied.projectId);
      if (applied.fromDate) params.set("from_date", applied.fromDate);
      if (applied.toDate) params.set("to_date", applied.toDate);

      try {
        const response = await fetch(`/api/partner/workers?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted) return;
        const payload: unknown = await response.json().catch(() => null);
        const code = extractPartnerApiErrorCode(payload);
        if (response.status === 401) {
          router.replace("/login?next=/partner/workers");
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
          "workers" in payload
        ) {
          const list = projectVendorWorkerList((payload as { workers: unknown }).workers);
          if (list) {
            setState({ kind: "loaded", list });
            return;
          }
        }
        setState({
          kind: "error",
          message: "Không thể tải danh sách người lao động của Vendor.",
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải danh sách NLĐ.",
        });
      }
    })();
    return () => controller.abort();
  }, [applied, page, reloadToken, router]);

  function reloadWorkers() {
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
    setPage(1);
    setState({ kind: "loading" });
    setApplied({ ...draft });
  }

  function resetFilters() {
    setFilterError(null);
    const reset: FilterState = { search: "", projectId: "", fromDate: "", toDate: "" };
    setDraft(reset);
    setPage(1);
    setState({ kind: "loading" });
    setApplied(reset);
  }

  const list = state.kind === "loaded" ? state.list : null;
  const projects = list?.available_projects ?? [];
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Cổng đối tác · Vendor"
        title="Danh sách người lao động"
        description="Danh sách NLĐ đã nộp hồ sơ do Vendor giới thiệu (chỉ hiển thị thông tin tóm tắt công việc)."
        actions={
          <Link
            href="/partner/recruitment"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            Xem thống kê
          </Link>
        }
      />

      <Card>
        <CardHeader
          title="Tìm kiếm và lọc danh sách NLĐ"
          description={
            list ? `${list.total} người lao động phù hợp` : "Tìm theo họ tên, mã NLĐ, dự án hoặc ngày vào làm."
          }
        />
        <search>
          <form
            onSubmit={applyFilters}
            className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="partner-workers-search" className="text-xs font-medium text-muted">
                Họ tên hoặc Mã NLĐ
              </label>
              <input
                id="partner-workers-search"
                type="search"
                enterKeyHint="search"
                maxLength={256}
                placeholder="Nhập tên hoặc mã NLĐ…"
                value={draft.search}
                onChange={(event) =>
                  setDraft((cur) => ({ ...cur, search: event.target.value }))
                }
                className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="partner-workers-project" className="text-xs font-medium text-muted">
                Dự án
              </label>
              <select
                id="partner-workers-project"
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
              <label htmlFor="partner-workers-from" className="text-xs font-medium text-muted">
                Từ ngày vào làm
              </label>
              <input
                id="partner-workers-from"
                type="date"
                value={draft.fromDate}
                onChange={(event) =>
                  setDraft((cur) => ({ ...cur, fromDate: event.target.value }))
                }
                className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="partner-workers-to" className="text-xs font-medium text-muted">
                Đến ngày vào làm
              </label>
              <input
                id="partner-workers-to"
                type="date"
                value={draft.toDate}
                onChange={(event) =>
                  setDraft((cur) => ({ ...cur, toDate: event.target.value }))
                }
                className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <Button type="submit" variant="primary" size="md">
                Tìm kiếm
              </Button>
              <Button type="button" variant="secondary" size="md" onClick={resetFilters}>
                Đặt lại
              </Button>
            </div>
          </form>
        </search>

        {filterError ? (
          <p role="alert" className="mb-4 text-sm text-status-danger-text">
            {filterError}
          </p>
        ) : null}

        {state.kind === "loading" ? (
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách người lao động…
          </p>
        ) : null}

        {state.kind === "forbidden" ? (
          <ErrorState title="Không có quyền xem danh sách NLĐ" detail={state.message} />
        ) : null}

        {state.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách NLĐ" detail={state.message} />
            <Button type="button" onClick={reloadWorkers}>
              Thử tải lại
            </Button>
          </div>
        ) : null}

        {list ? (
          list.items.length === 0 ? (
            <EmptyState
              title="Chưa có người lao động phù hợp"
              description="Thử thay đổi từ khóa hoặc khoảng thời gian tìm kiếm."
            />
          ) : (
            <>
              <ResponsiveTableRegion
                captionId="vendor-workers-table-caption"
                caption="Danh sách người lao động của Vendor"
              >
                <thead className="sticky top-0 z-10 border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Họ tên</th>
                    <th scope="col" className="px-3 py-3">Mã NLĐ</th>
                    <th scope="col" className="px-3 py-3">Dự án</th>
                    <th scope="col" className="px-3 py-3">Ngày vào làm</th>
                    <th scope="col" className="px-3 py-3">Trạng thái làm việc</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((worker) => (
                    <tr
                      key={worker.entry_id}
                      className="border-b border-border/70 last:border-0 hover:bg-surface-hover"
                    >
                      <td data-card-header="true" className="px-3 py-3 font-medium">
                        {worker.full_name ?? "Chưa cập nhật"}
                      </td>
                      <td data-label="Mã NLĐ" className="px-3 py-3 font-mono text-xs">
                        {worker.employee_code}
                      </td>
                      <td data-label="Dự án" className="px-3 py-3">
                        {worker.project_name}
                      </td>
                      <td data-label="Ngày vào làm" className="px-3 py-3 font-mono text-xs">
                        {formatPartnerDateVi(worker.first_work_date)}
                      </td>
                      <td data-label="Trạng thái làm việc" className="px-3 py-3">
                        <EmploymentStatusBadge status={worker.employment_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTableRegion>

              <OffsetPager
                page={page}
                pageCount={pageCount}
                total={list.total}
                ariaLabel="Phân trang danh sách NLĐ Vendor"
                previousLabel="Trang trước"
                nextLabel="Trang sau"
                onPageChange={(nextPage) => {
                  setPage(nextPage);
                  setState({ kind: "loading" });
                }}
              />
            </>
          )
        ) : null}
      </Card>
    </PageShell>
  );
}
