"use client";

import {
  Fragment,
  useEffect,
  useId,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  FileBarChart2,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
  UserMinus,
  X,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import type {
  VendorFinanceAccountSummary,
  VendorFinanceListProjectAccountantsAdminResponse,
  VendorFinanceProjectAccountantsAdminProject,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  ADMIN_GRANT_STATE_LABELS_VI,
  buildAdminEndProjectAccountantUrl,
  buildAdminProjectAccountantsUrl,
  buildAssignProjectAccountantRequest,
  buildEndProjectAccountantRequest,
  classifyVendorFinanceError,
  createClientIdempotencyKey,
  formatVietnamDateLabel,
  parseAdminProjectAccountantsEnvelope,
  parseAssignProjectAccountantEnvelope,
  parseEndProjectAccountantEnvelope,
  validateUiSearchInput,
  VFIN_UI_MAX_REASON_LENGTH,
  VFIN_UI_MAX_SEARCH_LENGTH,
} from "@/lib/vendor-finance/ui-model";

const PAGE_SIZE = 20;

function formatAccountIdentity(account: VendorFinanceAccountSummary): string {
  const parts: string[] = [account.display_name];
  if (account.personnel_code) {
    parts.push(account.personnel_code);
  } else if (account.login_id) {
    parts.push(account.login_id);
  }
  return parts.join(" · ");
}

async function readSafeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function VendorFinanceGovernanceView() {
  const notify = useNotify();
  const tabBaseId = useId();

  // --- Project Accountant Assignments state ---
  const [paSearchInput, setPaSearchInput] = useState("");
  const [paDebouncedSearch, setPaDebouncedSearch] = useState("");
  const [paIncludeHistory, setPaIncludeHistory] = useState(false);
  const [paPage, setPaPage] = useState(1);
  const [paReloadTick, setPaReloadTick] = useState(0);
  const [paData, setPaData] =
    useState<VendorFinanceListProjectAccountantsAdminResponse | null>(null);
  const [paLoading, setPaLoading] = useState(true);
  const [paError, setPaError] = useState<string | null>(null);

  // Assign / End Project Accountant dialog state
  const [assignTargetProject, setAssignTargetProject] =
    useState<VendorFinanceProjectAccountantsAdminProject | null>(null);
  const [endTargetProject, setEndTargetProject] =
    useState<VendorFinanceProjectAccountantsAdminProject | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPaDebouncedSearch(paSearchInput);
      setPaPage(1);
    }, 280);
    return () => window.clearTimeout(timer);
  }, [paSearchInput]);

  // Fetch Project Accountant Assignments
  useEffect(() => {
    const searchCheck = validateUiSearchInput(paDebouncedSearch);
    const controller = new AbortController();

    const run = async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;

      if (!searchCheck.ok) {
        setPaError(searchCheck.message);
        setPaLoading(false);
        return;
      }

      setPaLoading(true);
      setPaError(null);

      try {
        const url = buildAdminProjectAccountantsUrl({
          search: searchCheck.search,
          include_history: paIncludeHistory,
          page: paPage,
          page_size: PAGE_SIZE,
        });
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await readSafeJson(response);
        if (controller.signal.aborted) return;

        if (!response.ok) {
          const classified = classifyVendorFinanceError(payload, response.status);
          setPaError(classified.message);
          setPaLoading(false);
          return;
        }
        const parsed = parseAdminProjectAccountantsEnvelope(payload);
        if (!parsed) {
          setPaError("Dữ liệu phân công kế toán dự án trả về không đúng định dạng quy định.");
          setPaLoading(false);
          return;
        }
        setPaData(parsed);
        setPaLoading(false);
      } catch {
        if (controller.signal.aborted) return;
        setPaError("Không thể kết nối tới máy chủ để tải phân công kế toán dự án.");
        setPaLoading(false);
      }
    };

    void run();
    return () => controller.abort();
  }, [paDebouncedSearch, paIncludeHistory, paPage, paReloadTick]);

  const paPageCount = paData ? Math.max(1, Math.ceil(paData.total / paData.page_size)) : 1;

  const refreshAllGovernanceData = () => {
    setPaReloadTick((t) => t + 1);
  };

  return (
    <PageShell>
      {/* Breadcrumb */}
      <nav aria-label="Đường dẫn điều hướng" className="text-xs sm:text-sm text-muted">
        <Link
          href="/finance/vendors"
          className="inline-flex items-center gap-1.5 font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Quay lại Công nợ &amp; Tài chính Vendor
        </Link>
      </nav>

      <PageHeader
        title="Phân công Kế toán Dự án"
        description="Quản trị nguyên tắc 1 dự án = 1 kế toán phụ trách sổ đang hiệu lực. Các vai trò xem, đối soát hoặc cầm tiền toàn công ty được quản lý tập trung tại Nhóm quyền."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/access/groups"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Quản lý nhóm quyền tài chính
            </Link>
            <Link
              href="/finance/reports"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <FileBarChart2 className="h-4 w-4" aria-hidden="true" />
              Báo cáo công nợ tháng
            </Link>
            <Link
              href="/admin/departments"
              className={buttonClasses({ variant: "secondary", size: "md" })}
            >
              <Building2 className="h-4 w-4" aria-hidden="true" />
              Phòng ban
            </Link>
            <Button
              type="button"
              variant="secondary"
              onClick={refreshAllGovernanceData}
              aria-label="Làm mới dữ liệu phân công kế toán dự án"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Làm mới
            </Button>
          </div>
        }
      />

      <Alert tone="info" title="Nguyên tắc tách biệt sổ dự án và quyền tài chính toàn công ty">
        Mỗi dự án chỉ có <strong>một kế toán phụ trách chính</strong> đang hiệu lực tại một thời điểm
        theo chuỗi <strong>Công ty → Kế toán phụ trách → Dự án → Vendor</strong>. Khi bàn giao dự án,
        các giao dịch lịch sử vẫn giữ nguyên sổ kế toán cũ. Các vai trò toàn công ty (Xem công nợ, Đối
        soát, Kế toán cầm tiền, Ghi nhận hộ) được cấp/thu hồi tại{" "}
        <Link href="/admin/access/groups" className="font-medium underline">
          Quản trị → Nhóm quyền
        </Link>
        .
      </Alert>

      {/* PROJECT ACCOUNTANT ASSIGNMENTS */}
      <section
        id={`${tabBaseId}-panel-assignments`}
        data-ui-panel-motion="true"
        data-testid="vfin-governance-panel-assignments"
        className="space-y-4"
      >
        <FilterToolbar
          actions={
            <div
              role="group"
              aria-label="Chế độ hiển thị lịch sử bàn giao"
              className="inline-flex rounded-xl border border-border bg-surface p-1 gap-1"
            >
              <button
                type="button"
                aria-pressed={!paIncludeHistory}
                onClick={() => {
                  setPaIncludeHistory(false);
                  setPaPage(1);
                }}
                className={`min-h-9 rounded-lg px-3 text-xs sm:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  !paIncludeHistory
                    ? "bg-primary text-white"
                    : "text-foreground hover:bg-muted/10"
                }`}
              >
                Chỉ hiện hành
              </button>
              <button
                type="button"
                aria-pressed={paIncludeHistory}
                onClick={() => {
                  setPaIncludeHistory(true);
                  setPaPage(1);
                }}
                className={`min-h-9 rounded-lg px-3 text-xs sm:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  paIncludeHistory
                    ? "bg-primary text-white"
                    : "text-foreground hover:bg-muted/10"
                }`}
              >
                Kèm lịch sử bàn giao
              </button>
            </div>
          }
        >
          <div className="relative flex-1 min-w-[220px]">
            <label htmlFor={`${tabBaseId}-pa-search`} className="sr-only">
              Tìm dự án hoặc kế toán phụ trách
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id={`${tabBaseId}-pa-search`}
              type="search"
              maxLength={VFIN_UI_MAX_SEARCH_LENGTH}
              value={paSearchInput}
              onChange={(e) => setPaSearchInput(e.target.value)}
              placeholder="Tìm theo tên dự án, mã dự án hoặc tên kế toán..."
              className="min-h-11 sm:min-h-10 w-full rounded-xl border border-border bg-surface pl-9 pr-9 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {paSearchInput ? (
              <button
                type="button"
                aria-label="Xóa từ khóa tìm dự án"
                onClick={() => setPaSearchInput("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </FilterToolbar>

        {paError ? (
          <Alert tone="error" role="alert" title="Không thể tải phân công kế toán dự án">
            <p>{paError}</p>
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPaReloadTick((t) => t + 1)}
              >
                Thử lại
              </Button>
            </div>
          </Alert>
        ) : null}

        {paData && paData.eligible_accountants.length === 0 ? (
          <Alert tone="warning" title="Chưa có thành viên đang hiệu lực trong Phòng Kế toán">
            Để phân công kế toán phụ trách dự án, vui lòng thêm thành viên vào Phòng Kế toán tại{" "}
            <Link href="/admin/departments" className="font-semibold underline">
              Phòng ban
            </Link>{" "}
            trước.
          </Alert>
        ) : null}

        {paLoading && !paData ? (
          <Card className="p-6 text-sm text-muted" aria-busy="true">
            Đang tải danh sách dự án và kế toán phụ trách...
          </Card>
        ) : null}

        {paData ? (
          <Card className="p-4 sm:p-5">
            {paData.projects.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">
                Không tìm thấy dự án nào phù hợp với điều kiện lọc hiện tại.
              </p>
            ) : (
              <DataTableContainer>
                <table
                  className={DATA_TABLE_CLASS}
                  aria-label="Bảng phân công kế toán phụ trách theo dự án"
                >
                  <thead className={DATA_TABLE_HEAD_CLASS}>
                    <tr>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Dự án
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Kế toán phụ trách hiện hành
                      </th>
                      <th scope="col" className={DATA_TABLE_TH_CLASS}>
                        Thời gian hiệu lực
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Vendor đã phát sinh giao dịch
                      </th>
                      <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                        Thao tác
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {paData.projects.map((project) => {
                      const current = project.current_assignment;
                      const currentStateMeta = current
                        ? ADMIN_GRANT_STATE_LABELS_VI[current.state]
                        : null;
                      return (
                        <Fragment key={project.project_id}>
                          <tr className={DATA_TABLE_ROW_CLASS}>
                            <td className={DATA_TABLE_TD_CLASS}>
                              <div className="font-semibold text-foreground">
                                {project.display_name}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                                <span className="font-mono">{project.project_id}</span>
                                <StatusBadge tone={project.active ? "success" : "neutral"}>
                                  {project.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                                </StatusBadge>
                              </div>
                            </td>
                            <td className={DATA_TABLE_TD_CLASS}>
                              {current ? (
                                <div>
                                  <div className="font-medium text-foreground">
                                    {formatAccountIdentity(current.accountant)}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {currentStateMeta ? (
                                      <StatusBadge tone={currentStateMeta.tone}>
                                        {currentStateMeta.label}
                                      </StatusBadge>
                                    ) : null}
                                    {!current.accountant_in_accounting_department ? (
                                      <StatusBadge tone="warning">
                                        Đã rời Phòng Kế toán
                                      </StatusBadge>
                                    ) : null}
                                  </div>
                                </div>
                              ) : (
                                <StatusBadge tone="warning">Chưa phân công kế toán</StatusBadge>
                              )}
                            </td>
                            <td className={DATA_TABLE_TD_CLASS}>
                              {current ? (
                                <div className="text-xs sm:text-sm font-mono tabular-nums text-foreground">
                                  Từ {formatVietnamDateLabel(current.valid_from)}
                                  {current.valid_to
                                    ? ` → ${formatVietnamDateLabel(current.valid_to)}`
                                    : " · Đang mở"}
                                </div>
                              ) : (
                                <span className="text-xs text-muted">—</span>
                              )}
                            </td>
                            <td className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}>
                              {project.transacted_vendor_count}
                            </td>
                            <td className={`${DATA_TABLE_TD_CLASS} text-right`}>
                              <RowActionCluster className="justify-end">
                                {current ? (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setEndTargetProject(project)}
                                  >
                                    <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                                    Kết thúc / Bàn giao
                                  </Button>
                                ) : project.active ? (
                                  <Button
                                    type="button"
                                    variant="primary"
                                    size="sm"
                                    disabled={paData.eligible_accountants.length === 0}
                                    onClick={() => setAssignTargetProject(project)}
                                  >
                                    <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                                    Phân công kế toán
                                  </Button>
                                ) : null}
                              </RowActionCluster>
                            </td>
                          </tr>

                          {paIncludeHistory && project.assignments.length > 0 ? (
                            <tr className="bg-muted/5">
                              <td colSpan={5} className="px-4 py-3 text-xs">
                                <div className="font-semibold text-foreground mb-1.5">
                                  Lịch sử phân công dự án {project.display_name} (
                                  {project.assignments.length} bản ghi):
                                </div>
                                <ul className="space-y-1.5">
                                  {project.assignments.map((item) => {
                                    const st = ADMIN_GRANT_STATE_LABELS_VI[item.state];
                                    return (
                                      <li
                                        key={item.assignment_id}
                                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2"
                                      >
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="font-mono text-muted">
                                            v{item.version}
                                          </span>
                                          <span className="font-medium text-foreground">
                                            {formatAccountIdentity(item.accountant)}
                                          </span>
                                          <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                                        </div>
                                        <div className="text-muted font-mono tabular-nums">
                                          {formatVietnamDateLabel(item.valid_from)} →{" "}
                                          {item.valid_to
                                            ? formatVietnamDateLabel(item.valid_to)
                                            : "Hiện tại"}
                                        </div>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </DataTableContainer>
            )}

            <OffsetPager
              page={paData.page}
              pageCount={paPageCount}
              total={paData.total}
              ariaLabel="Phân trang danh sách dự án"
              disabled={paLoading}
              onPageChange={(next) => setPaPage(next)}
            />
          </Card>
        ) : null}
      </section>

      {/* DIALOG 1A: ASSIGN PROJECT ACCOUNTANT */}
      {assignTargetProject && paData ? (
        <AssignProjectAccountantDialog
          open={Boolean(assignTargetProject)}
          onOpenChange={(open) => {
            if (!open) setAssignTargetProject(null);
          }}
          project={assignTargetProject}
          eligibleAccountants={paData.eligible_accountants}
          defaultDate={paData.authorization_date}
          onCompleted={() => {
            setAssignTargetProject(null);
            refreshAllGovernanceData();
            notify.success({
              title: "Đã phân công kế toán phụ trách dự án",
              description: `Dự án ${assignTargetProject.display_name} đã cập nhật kế toán phụ trách.`,
            });
          }}
        />
      ) : null}

      {/* DIALOG 1B: END PROJECT ACCOUNTANT */}
      {endTargetProject && endTargetProject.current_assignment && paData ? (
        <EndProjectAccountantDialog
          open={Boolean(endTargetProject)}
          onOpenChange={(open) => {
            if (!open) setEndTargetProject(null);
          }}
          project={endTargetProject}
          defaultDate={paData.authorization_date}
          onCompleted={() => {
            const name = endTargetProject.display_name;
            setEndTargetProject(null);
            refreshAllGovernanceData();
            notify.success({
              title: "Đã kết thúc phân công kế toán dự án",
              description: `Bạn có thể phân công kế toán tiếp nhận mới cho dự án ${name}.`,
            });
          }}
        />
      ) : null}
    </PageShell>
  );
}

// =============================================================================
// Sub-Dialogs (FormDialog + Idempotency + OCC Expected Version)
// =============================================================================
function AssignProjectAccountantDialog({
  open,
  onOpenChange,
  project,
  eligibleAccountants,
  defaultDate,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: VendorFinanceProjectAccountantsAdminProject;
  eligibleAccountants: readonly VendorFinanceAccountSummary[];
  defaultDate: string;
  onCompleted: () => void;
}) {
  const formId = useId();
  const [accountantRef, setAccountantRef] = useState(
    () => eligibleAccountants[0]?.account_ref ?? "",
  );
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expectedVersion = Math.max(0, project.next_version - 1);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const built = buildAssignProjectAccountantRequest({
      project_id: project.project_id,
      accountant_ref: accountantRef,
      valid_from: null,
      expected_version: expectedVersion,
      reason,
      idempotency_key: idempotencyKey,
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(buildAdminProjectAccountantsUrl(), {
        method: "POST",
        headers: built.request.headers,
        body: JSON.stringify(built.request.body),
      });
      const payload = await readSafeJson(response);
      if (!response.ok) {
        const classified = classifyVendorFinanceError(payload, response.status);
        if (classified.shouldRotateIdempotencyKey) {
          setIdempotencyKey(createClientIdempotencyKey());
        }
        setError(classified.message);
        setSubmitting(false);
        return;
      }
      const parsed = parseAssignProjectAccountantEnvelope(payload);
      if (!parsed) {
        setError("Phản hồi phân công kế toán dự án không hợp lệ.");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCompleted();
    } catch {
      setError("Mất kết nối mạng khi gửi phân công kế toán dự án. Bạn có thể bấm gửi lại an toàn.");
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      closeDisabled={submitting}
      dataTestId="vfin-assign-project-accountant-dialog"
      title={`Phân công kế toán dự án — ${project.display_name}`}
      description="Chỉ thành viên đang hiệu lực của Phòng Kế toán mới được phân công làm chủ sở hữu sổ dự án."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error ? (
          <Alert tone="error" role="alert" title="Không thể lưu phân công">
            {error}
          </Alert>
        ) : null}

        <div>
          <label
            htmlFor={`${formId}-accountant`}
            className="block text-sm font-medium text-foreground mb-1"
          >
            Kế toán phụ trách sổ dự án <span className="text-danger">*</span>
          </label>
          <select
            id={`${formId}-accountant`}
            required
            value={accountantRef}
            onChange={(e) => setAccountantRef(e.target.value)}
            disabled={submitting}
            className="min-h-11 sm:min-h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <option value="">— Chọn thành viên Phòng Kế toán —</option>
            {eligibleAccountants.map((acc) => (
              <option key={acc.account_ref} value={acc.account_ref}>
                {formatAccountIdentity(acc)}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
          Ngày bắt đầu hiệu lực:{" "}
          <strong className="font-mono text-foreground">{defaultDate}</strong> (áp dụng ngay theo
          ngày nghiệp vụ hệ thống).
        </div>

        <div>
          <label
            htmlFor={`${formId}-reason`}
            className="block text-sm font-medium text-foreground mb-1"
          >
            Lý do phân công <span className="text-danger">*</span>
          </label>
          <textarea
            id={`${formId}-reason`}
            required
            rows={3}
            maxLength={VFIN_UI_MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            placeholder="Nhập quyết định hoặc lý do phân công kế toán phụ trách dự án..."
            className="w-full rounded-xl border border-border bg-surface p-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Hủy
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Đang lưu..." : "Xác nhận phân công"}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

function EndProjectAccountantDialog({
  open,
  onOpenChange,
  project,
  defaultDate,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: VendorFinanceProjectAccountantsAdminProject;
  defaultDate: string;
  onCompleted: () => void;
}) {
  const formId = useId();
  const current = project.current_assignment!;
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expectedVersion = Math.max(1, project.next_version - 1);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const built = buildEndProjectAccountantRequest({
      expected_version: expectedVersion,
      valid_to: null,
      reason,
      idempotency_key: idempotencyKey,
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(buildAdminEndProjectAccountantUrl(current.assignment_id), {
        method: "POST",
        headers: built.request.headers,
        body: JSON.stringify(built.request.body),
      });
      const payload = await readSafeJson(response);
      if (!response.ok) {
        const classified = classifyVendorFinanceError(payload, response.status);
        if (classified.shouldRotateIdempotencyKey) {
          setIdempotencyKey(createClientIdempotencyKey());
        }
        setError(classified.message);
        setSubmitting(false);
        return;
      }
      const parsed = parseEndProjectAccountantEnvelope(payload);
      if (!parsed) {
        setError("Phản hồi kết thúc phân công không hợp lệ.");
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCompleted();
    } catch {
      setError("Mất kết nối mạng khi kết thúc phân công. Bạn có thể bấm gửi lại an toàn.");
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      closeDisabled={submitting}
      dataTestId="vfin-end-project-accountant-dialog"
      title={`Kết thúc / Bàn giao kế toán dự án — ${project.display_name}`}
      description={`Kế toán hiện tại: ${formatAccountIdentity(current.accountant)}. Các bút toán đã ghi trong sổ cũ vẫn giữ nguyên chủ sở hữu lịch sử.`}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error ? (
          <Alert tone="error" role="alert" title="Không thể kết thúc phân công">
            {error}
          </Alert>
        ) : null}

        <div className="rounded-xl border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
          Ngày kết thúc hiệu lực (mốc bàn giao <code className="font-mono">[valid_from, valid_to)</code>):{" "}
          <strong className="font-mono text-foreground">{defaultDate}</strong> (áp dụng ngay theo ngày
          nghiệp vụ hệ thống).
        </div>

        <div>
          <label
            htmlFor={`${formId}-reason`}
            className="block text-sm font-medium text-foreground mb-1"
          >
            Lý do kết thúc / bàn giao <span className="text-danger">*</span>
          </label>
          <textarea
            id={`${formId}-reason`}
            required
            rows={3}
            maxLength={VFIN_UI_MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            placeholder="Nhập biên bản hoặc lý do bàn giao sổ dự án..."
            className="w-full rounded-xl border border-border bg-surface p-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Hủy
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Đang xử lý..." : "Xác nhận kết thúc phân công"}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
