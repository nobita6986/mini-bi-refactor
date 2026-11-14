"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
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
import {
  ACCOUNTING_DEFAULT_POLICY_DESCRIPTION,
  DEPARTMENT_UI_MAX_REASON_LENGTH,
  DEPARTMENT_UI_MAX_SEARCH_LENGTH,
  RECRUITMENT_DEFAULT_POLICY_DESCRIPTION,
  buildAccountingCandidatesQuery,
  buildAccountingMembershipsQuery,
  buildAssignAccountingMemberRequest,
  buildEndAccountingMemberRequest,
  buildRecruitmentTeamsQuery,
  canManageDepartmentMemberships,
  candidateAvailabilityBadge,
  classifyDepartmentMutationResponse,
  classifyDepartmentReadError,
  departmentDefaultPolicyDescription,
  departmentScaleSummary,
  formatAccountSecondaryMeta,
  isCandidateAssignable,
  membershipStateBadge,
  newDepartmentIdempotencyKey,
  normalizeDepartmentUuid,
  projectAccountingCandidatesEnvelope,
  projectAccountingMembershipsEnvelope,
  projectDepartmentDetailEnvelope,
  projectRecruitmentTeamsEnvelope,
  sanitizeDepartmentSearchInput,
  visibleRecruitmentTeams,
} from "@/lib/admin/department-ui-model";
import type {
  AccountingCandidateListProjection,
  AccountingCandidateProjection,
  AccountingMembershipListProjection,
  AccountingMembershipProjection,
  DepartmentDetailProjection,
  RecruitmentTeamListProjection,
} from "@/lib/departments/department-contract";

const INPUT_CLASS =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

type DepartmentDetailLoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: DepartmentDetailProjection }
  | { kind: "denied"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type SubListLoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

type AccountingDialogState =
  | { kind: "assign" }
  | { kind: "end"; membership: AccountingMembershipProjection }
  | null;

type DialogFeedback = {
  tone: "error" | "warning";
  message: string;
  needsReload: boolean;
} | null;

export function DepartmentDetailManager({
  departmentId,
}: {
  departmentId: string;
}) {
  const normalizedDepartmentId = normalizeDepartmentUuid(departmentId);
  const [detailState, setDetailState] = useState<DepartmentDetailLoadState>({
    kind: "loading",
  });
  const [detailReloadToken, setDetailReloadToken] = useState(0);

  useEffect(() => {
    if (!normalizedDepartmentId) return;

    const controller = new AbortController();
    void (async () => {
      setDetailState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/${encodeURIComponent(normalizedDepartmentId)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải thông tin Phòng ban.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setDetailState({ kind: "denied", message: failure.message });
          return;
        }
        if (failure.kind === "not-found") {
          setDetailState({ kind: "not-found", message: failure.message });
          return;
        }
        setDetailState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectDepartmentDetailEnvelope(payload, normalizedDepartmentId);
      if (!projected) {
        setDetailState({
          kind: "error",
          message: "Phản hồi thông tin Phòng ban không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setDetailState({ kind: "ready", detail: projected });
    })();

    return () => controller.abort();
  }, [normalizedDepartmentId, detailReloadToken]);

  const reloadDetail = () => {
    if (!normalizedDepartmentId) return;
    setDetailState({ kind: "loading" });
    setDetailReloadToken((value) => value + 1);
  };

  const effectiveState: DepartmentDetailLoadState = normalizedDepartmentId
    ? detailState
    : {
        kind: "not-found",
        message: "Mã định danh phòng ban trên đường dẫn không hợp lệ.",
      };

  return (
    <PageShell
      dataTestId="department-detail-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <div>
        <Link
          href="/admin/departments"
          className="inline-flex min-h-11 sm:min-h-9 items-center gap-1.5 rounded-md px-1 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          ← Danh sách Phòng ban
        </Link>
      </div>

      {effectiveState.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải thông tin Phòng ban…
          </p>
        </Card>
      ) : null}

      {effectiveState.kind === "denied" ? (
        <Alert tone="error" role="alert" title="Không có quyền truy cập">
          {effectiveState.message}
        </Alert>
      ) : null}

      {effectiveState.kind === "not-found" ? (
        <Card>
          <div className="space-y-4">
            <EmptyState
              title="Không tìm thấy Phòng ban"
              description={effectiveState.message}
            />
            <div className="flex justify-center">
              <Link
                href="/admin/departments"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                Quay lại danh sách Phòng ban
              </Link>
            </div>
          </div>
        </Card>
      ) : null}

      {effectiveState.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState
              title="Không tải được thông tin Phòng ban"
              detail={effectiveState.message}
            />
            {effectiveState.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadDetail}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {effectiveState.kind === "ready" ? (
        effectiveState.detail.department.system_key === "RECRUITMENT" ? (
          <RecruitmentDepartmentReadOnlySection
            detail={effectiveState.detail}
            parentReloadToken={detailReloadToken}
            onReloadDetail={reloadDetail}
          />
        ) : effectiveState.detail.department.system_key === "ACCOUNTING" ? (
          <AccountingDepartmentMembershipsSection
            detail={effectiveState.detail}
            parentReloadToken={detailReloadToken}
            onReloadDetail={reloadDetail}
            onMembershipMutated={() => setDetailReloadToken((value) => value + 1)}
          />
        ) : (
          <StandardDepartmentOverviewSection
            detail={effectiveState.detail}
            onReloadDetail={reloadDetail}
          />
        )
      ) : null}
    </PageShell>
  );
}

function StandardDepartmentOverviewSection({
  detail,
  onReloadDetail,
}: {
  detail: DepartmentDetailProjection;
  onReloadDetail: () => void;
}) {
  const department = detail.department;
  return (
    <Card>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeader
            title={department.name}
            description={`Mã: ${department.code} · Ngày phân quyền: ${detail.authorization_date}`}
          />
          <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
            {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
          </StatusBadge>
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <div className="text-xs text-muted">Quy mô hiện tại</div>
            <div className="mt-1 font-medium text-foreground">
              {departmentScaleSummary(department)}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <div className="text-xs text-muted">Trưởng phòng (HEAD) hiện tại</div>
            <div className="mt-1 font-medium text-foreground">
              {department.active_head
                ? `${department.active_head.full_name} (${department.active_head.employee_code})`
                : "Chưa bổ nhiệm"}
            </div>
          </div>
        </div>
        <Alert tone="info" title="Chính sách phân quyền phòng ban">
          {departmentDefaultPolicyDescription(department)}
        </Alert>
        <div>
          <Button variant="secondary" onClick={onReloadDetail}>
            Tải lại
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RecruitmentDepartmentReadOnlySection({
  detail,
  parentReloadToken,
  onReloadDetail,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onReloadDetail: () => void;
}) {
  const department = detail.department;
  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(true);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [teamsState, setTeamsState] = useState<SubListLoadState<RecruitmentTeamListProjection>>({
    kind: "loading",
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchFilter(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildRecruitmentTeamsQuery({
        search: searchFilter,
        includeInactive,
        page,
      });
      if (!query) {
        setTeamsState({
          kind: "error",
          message: "Bộ lọc tìm kiếm nhóm không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setTeamsState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/recruitment/teams?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setTeamsState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách Nhóm.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setTeamsState({ kind: "denied", message: failure.message });
          return;
        }
        setTeamsState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectRecruitmentTeamsEnvelope(
        payload,
        { search: searchFilter, includeInactive, page },
        department.department_id,
      );
      if (!projected) {
        setTeamsState({
          kind: "error",
          message: "Phản hồi danh sách Nhóm không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setTeamsState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [
    department.department_id,
    includeInactive,
    page,
    parentReloadToken,
    reloadToken,
    searchFilter,
  ]);

  const reloadTeams = () => {
    setTeamsState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const teams =
    teamsState.kind === "ready" ? visibleRecruitmentTeams(teamsState.data.teams) : [];
  const pageCount =
    teamsState.kind === "ready"
      ? Math.max(1, Math.ceil(teamsState.data.total / Math.max(1, teamsState.data.page_size)))
      : 1;

  return (
    <div className="space-y-4" data-testid="recruitment-department-readonly-panel">
      <PageHeader
        eyebrow="Chi tiết Phòng ban"
        title={department.name}
        badge={
          <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
            {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
          </StatusBadge>
        }
        description={`Mã hệ thống: ${department.code} · Ngày hiệu lực: ${detail.authorization_date} · ${departmentScaleSummary(department)}`}
        actions={
          <Button variant="secondary" size="md" onClick={onReloadDetail}>
            Làm mới
          </Button>
        }
      />

      <Alert tone="info" role="status" title="Chế độ chỉ đọc — Vỏ Phòng Tuyển dụng">
        <p>{RECRUITMENT_DEFAULT_POLICY_DESCRIPTION}</p>
        <p>
          Phòng Tuyển dụng không hỗ trợ gán thành viên trực tiếp và không cho phép chỉnh sửa
          Nhóm, Team Leader, thành viên tuyển dụng hoặc phạm vi Dự án ↔ Nhóm tại đây.
        </p>
      </Alert>

      <Card>
        <CardHeader
          title="Danh sách Nhóm trực thuộc (chỉ đọc)"
          description={
            teamsState.kind === "ready"
              ? `${teamsState.data.total} nhóm kinh doanh được chiếu từ danh mục hiện hành`
              : "Tra cứu danh sách Nhóm hiện hữu thuộc nghiệp vụ tuyển dụng."
          }
        />

        <FilterToolbar
          className="mb-4"
          actions={
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Bộ lọc trạng thái nhóm">
              <Button
                variant={includeInactive ? "soft" : "secondary"}
                size="md"
                aria-pressed={includeInactive}
                onClick={() => {
                  setIncludeInactive(true);
                  setPage(1);
                }}
              >
                Tất cả nhóm
              </Button>
              <Button
                variant={!includeInactive ? "soft" : "secondary"}
                size="md"
                aria-pressed={!includeInactive}
                onClick={() => {
                  setIncludeInactive(false);
                  setPage(1);
                }}
              >
                Chỉ nhóm đang hoạt động
              </Button>
            </div>
          }
        >
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchFilter(searchInput);
              setPage(1);
              reloadTeams();
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-foreground">
              Tìm theo mã hoặc tên nhóm
              <input
                type="search"
                value={searchInput}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập mã hoặc tên nhóm…"
                onChange={(event) =>
                  setSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>
            <Button type="submit" variant="secondary" size="md">
              Lọc
            </Button>
          </form>
        </FilterToolbar>

        {teamsState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách Nhóm…
          </p>
        ) : null}

        {teamsState.kind === "denied" ? (
          <Alert tone="error" role="alert" title="Không có quyền truy cập">
            {teamsState.message}
          </Alert>
        ) : null}

        {teamsState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách Nhóm"
              detail={teamsState.message}
            />
            {teamsState.retryable ? (
              <Button variant="secondary" onClick={reloadTeams}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : null}

        {teamsState.kind === "ready" && teams.length === 0 ? (
          <EmptyState
            title="Không có nhóm phù hợp"
            description={
              searchFilter.trim()
                ? "Không tìm thấy nhóm nào khớp với từ khóa hiện tại."
                : "Hiện chưa có nhóm nào để hiển thị."
            }
          />
        ) : null}

        {teamsState.kind === "ready" && teams.length > 0 ? (
          <>
            <DataTableContainer dataTestId="recruitment-teams-readonly-table">
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Tên nhóm
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Mã nhóm
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {teams.map((team) => (
                    <tr key={team.team_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={`${DATA_TABLE_TD_CLASS} font-medium`}>
                        {team.display_name}
                      </td>
                      <td data-label="Mã nhóm" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs sm:text-sm`}>
                        {team.code}
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge tone={team.active ? "success" : "neutral"} dot>
                          {team.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTableContainer>

            <OffsetPager
              page={page}
              pageCount={pageCount}
              total={teamsState.data.total}
              ariaLabel="Phân trang danh sách nhóm thuộc Phòng Tuyển dụng"
              nextDisabled={!teamsState.data.has_more}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          </>
        ) : null}
      </Card>
    </div>
  );
}

function AccountingDepartmentMembershipsSection({
  detail,
  parentReloadToken,
  onReloadDetail,
  onMembershipMutated,
}: {
  detail: DepartmentDetailProjection;
  parentReloadToken: number;
  onReloadDetail: () => void;
  onMembershipMutated: () => void;
}) {
  const notify = useNotify();
  const department = detail.department;
  const canManage = canManageDepartmentMemberships(department);

  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [membershipsState, setMembershipsState] =
    useState<SubListLoadState<AccountingMembershipListProjection>>({
      kind: "loading",
    });

  const [dialog, setDialog] = useState<AccountingDialogState>(null);
  const [busy, setBusy] = useState(false);
  const [dialogFeedback, setDialogFeedback] = useState<DialogFeedback>(null);

  // Assign dialog state
  const [candidateSearchInput, setCandidateSearchInput] = useState("");
  const [candidateSearchFilter, setCandidateSearchFilter] = useState("");
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidateReloadToken, setCandidateReloadToken] = useState(0);
  const [candidatesState, setCandidatesState] =
    useState<SubListLoadState<AccountingCandidateListProjection>>({
      kind: "loading",
    });
  const [selectedCandidate, setSelectedCandidate] =
    useState<AccountingCandidateProjection | null>(null);
  const [assignReason, setAssignReason] = useState("");

  // End dialog state
  const [endReason, setEndReason] = useState("");

  const pendingIntentRef = useRef<{ signature: string; key: string } | null>(null);

  const openAssignDialog = () => {
    if (!canManage) return;
    pendingIntentRef.current = null;
    setDialogFeedback(null);
    setCandidateSearchInput("");
    setCandidateSearchFilter("");
    setCandidatePage(1);
    setSelectedCandidate(null);
    setAssignReason("");
    setDialog({ kind: "assign" });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchFilter(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCandidateSearchFilter(candidateSearchInput);
      setCandidatePage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [candidateSearchInput]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildAccountingMembershipsQuery({
        search: searchFilter,
        includeHistory,
        page,
      });
      if (!query) {
        setMembershipsState({
          kind: "error",
          message: "Bộ lọc thành viên Phòng Kế toán không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setMembershipsState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/accounting/memberships?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMembershipsState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách thành viên.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setMembershipsState({ kind: "denied", message: failure.message });
          return;
        }
        setMembershipsState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectAccountingMembershipsEnvelope(
        payload,
        { search: searchFilter, includeHistory, page },
        department.department_id,
      );
      if (!projected) {
        setMembershipsState({
          kind: "error",
          message: "Phản hồi danh sách thành viên Phòng Kế toán không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setMembershipsState({ kind: "ready", data: projected });
    })();

    return () => controller.abort();
  }, [
    department.department_id,
    includeHistory,
    page,
    parentReloadToken,
    reloadToken,
    searchFilter,
  ]);

  useEffect(() => {
    if (dialog?.kind !== "assign") return;

    const controller = new AbortController();
    void (async () => {
      const query = buildAccountingCandidatesQuery({
        search: candidateSearchFilter,
        page: candidatePage,
      });
      if (!query) {
        setCandidatesState({
          kind: "error",
          message: "Từ khóa tìm kiếm ứng viên không hợp lệ.",
          retryable: true,
        });
        return;
      }

      setCandidatesState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/departments/accounting/candidates?${query.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCandidatesState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách tài khoản ứng viên.",
          retryable: true,
        });
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;

      if (response.status !== 200) {
        const failure = classifyDepartmentReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          setCandidatesState({ kind: "denied", message: failure.message });
          return;
        }
        setCandidatesState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectAccountingCandidatesEnvelope(
        payload,
        { search: candidateSearchFilter, page: candidatePage },
        department.department_id,
      );
      if (!projected) {
        setCandidatesState({
          kind: "error",
          message: "Phản hồi danh sách ứng viên không đúng định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setCandidatesState({ kind: "ready", data: projected });
      setSelectedCandidate((current) => {
        if (!current) return null;
        const refreshed = projected.candidates.find(
          (item) => item.account_ref === current.account_ref,
        );
        if (!refreshed) return current;
        return isCandidateAssignable(refreshed) ? refreshed : null;
      });
    })();

    return () => controller.abort();
  }, [
    candidatePage,
    candidateReloadToken,
    candidateSearchFilter,
    department.department_id,
    dialog?.kind,
  ]);

  const reloadMemberships = () => {
    setMembershipsState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const reloadCandidates = () => {
    setCandidatesState({ kind: "loading" });
    setCandidateReloadToken((value) => value + 1);
  };

  const openEndDialog = (membership: AccountingMembershipProjection) => {
    if (!canManage || membership.valid_to !== null) return;
    pendingIntentRef.current = null;
    setDialogFeedback(null);
    setEndReason("");
    setDialog({ kind: "end", membership });
  };

  async function handleAssignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDialogFeedback(null);

    if (!selectedCandidate) {
      setDialogFeedback({
        tone: "error",
        message: "Vui lòng chọn một tài khoản từ danh sách ứng viên bên trên.",
        needsReload: false,
      });
      return;
    }

    const signature = JSON.stringify({
      op: "assign",
      accountRef: selectedCandidate.account_ref,
      expectedPairVersion: selectedCandidate.pair_version,
      effectiveFrom: null,
      reason: assignReason.trim(),
    });
    const intentKey =
      pendingIntentRef.current?.signature === signature
        ? pendingIntentRef.current.key
        : newDepartmentIdempotencyKey();
    pendingIntentRef.current = { signature, key: intentKey };

    const built = buildAssignAccountingMemberRequest({
      accountRef: selectedCandidate.account_ref,
      expectedPairVersion: selectedCandidate.pair_version,
      authorizationDate: detail.authorization_date,
      effectiveFrom: null,
      reason: assignReason,
      idempotencyKey: intentKey,
    });
    if (!built.ok) {
      setDialogFeedback({
        tone: "error",
        message: built.message,
        needsReload: false,
      });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/departments/accounting/memberships", {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": built.idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      const outcome = classifyDepartmentMutationResponse(response.status, payload, "assign");
      setBusy(false);

      if (outcome.kind === "applied") {
        pendingIntentRef.current = null;
        setDialog(null);
        setSelectedCandidate(null);
        notify.success({ title: outcome.message });
        reloadMemberships();
        onMembershipMutated();
        return;
      }

      if (outcome.resetIdempotencyKey) {
        pendingIntentRef.current = null;
      }

      setDialogFeedback({
        tone: outcome.kind === "conflict" ? "warning" : "error",
        message: outcome.message,
        needsReload: outcome.kind === "conflict" || outcome.kind === "not-found",
      });
    } catch {
      setBusy(false);
      setDialogFeedback({
        tone: "error",
        message: "Không nhận được phản hồi từ máy chủ. Bạn có thể gửi lại an toàn.",
        needsReload: false,
      });
    }
  }

  async function handleEndSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDialogFeedback(null);
    if (dialog?.kind !== "end") return;

    const target = dialog.membership;
    const signature = JSON.stringify({
      op: "end",
      membershipId: target.membership_id,
      expectedPairVersion: target.pair_version,
      effectiveTo: null,
      reason: endReason.trim(),
    });
    const intentKey =
      pendingIntentRef.current?.signature === signature
        ? pendingIntentRef.current.key
        : newDepartmentIdempotencyKey();
    pendingIntentRef.current = { signature, key: intentKey };

    const built = buildEndAccountingMemberRequest({
      membershipId: target.membership_id,
      expectedPairVersion: target.pair_version,
      membershipState: target.state,
      validFrom: target.valid_from,
      authorizationDate: detail.authorization_date,
      effectiveTo: null,
      reason: endReason,
      idempotencyKey: intentKey,
    });
    if (!built.ok) {
      setDialogFeedback({
        tone: "error",
        message: built.message,
        needsReload: false,
      });
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/departments/accounting/memberships/${encodeURIComponent(built.membershipId)}/end`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": built.idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const outcome = classifyDepartmentMutationResponse(response.status, payload, "end");
      setBusy(false);

      if (outcome.kind === "applied") {
        pendingIntentRef.current = null;
        setDialog(null);
        notify.success({ title: outcome.message });
        reloadMemberships();
        onMembershipMutated();
        return;
      }

      if (outcome.resetIdempotencyKey) {
        pendingIntentRef.current = null;
      }

      setDialogFeedback({
        tone: outcome.kind === "conflict" ? "warning" : "error",
        message: outcome.message,
        needsReload: outcome.kind === "conflict" || outcome.kind === "not-found",
      });
    } catch {
      setBusy(false);
      setDialogFeedback({
        tone: "error",
        message: "Không nhận được phản hồi từ máy chủ. Bạn có thể gửi lại an toàn.",
        needsReload: false,
      });
    }
  }

  const memberships =
    membershipsState.kind === "ready" ? membershipsState.data.memberships : [];
  const membershipPageCount =
    membershipsState.kind === "ready"
      ? Math.max(
          1,
          Math.ceil(
            membershipsState.data.total / Math.max(1, membershipsState.data.page_size),
          ),
        )
      : 1;
  const candidatePageCount =
    candidatesState.kind === "ready"
      ? Math.max(
          1,
          Math.ceil(
            candidatesState.data.total / Math.max(1, candidatesState.data.page_size),
          ),
        )
      : 1;

  return (
    <div className="space-y-4" data-testid="accounting-department-memberships-panel">
      <PageHeader
        eyebrow="Chi tiết Phòng ban"
        title={department.name}
        badge={
          <StatusBadge tone={department.is_active ? "success" : "neutral"} dot>
            {department.is_active ? "Đang hoạt động" : "Ngừng hoạt động"}
          </StatusBadge>
        }
        description={`Mã hệ thống: ${department.code} · Ngày hiệu lực: ${detail.authorization_date} · ${departmentScaleSummary(department)}`}
        actions={
          <>
            <Button variant="secondary" size="md" onClick={onReloadDetail}>
              Làm mới
            </Button>
            {canManage ? (
              <Link
                href="/finance/project-assignments"
                className={buttonClasses({ variant: "secondary", size: "md" })}
              >
                Phân công dự án &amp; vai trò toàn cục
              </Link>
            ) : null}
            {canManage ? (
              <Button variant="primary" size="md" onClick={openAssignDialog}>
                Gán thành viên
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <CardHeader
          title="Quyền mặc định Phòng Kế toán (chỉ đọc)"
          description="Chính sách cố định theo phòng ban hệ thống; áp dụng tự động khi tư cách thành viên đang hiệu lực."
        />
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-surface-muted/60 px-4 py-3">
          <StatusBadge tone="primary" dot>
            Chính sách cố định
          </StatusBadge>
          <span className="text-sm font-semibold text-foreground">
            {departmentDefaultPolicyDescription(department)}
          </span>
        </div>
        <p className="mt-2.5 text-xs text-muted">
          Tài khoản đang có tư cách thành viên hiệu lực tại Phòng Kế toán tự động nhận quyền{" "}
          <strong>{ACCOUNTING_DEFAULT_POLICY_DESCRIPTION}</strong>. Khi kết thúc tư cách thành viên,
          quyền mặc định này ngừng hiệu lực mà không ảnh hưởng tới các quyền độc lập khác của tài khoản.
        </p>
      </Card>

      <Card>
        <CardHeader
          title={
            includeHistory
              ? "Thành viên hiện tại & lịch sử Phòng Kế toán"
              : "Thành viên hiện tại & sắp hiệu lực"
          }
          description={
            membershipsState.kind === "ready"
              ? `${membershipsState.data.total} bản ghi · Ngày hiệu lực hệ thống: ${membershipsState.data.authorization_date}`
              : "Tra cứu và quản lý tư cách thành viên Phòng Kế toán."
          }
        />

        <FilterToolbar
          className="mb-4"
          actions={
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Chế độ xem lịch sử thành viên"
            >
              <Button
                variant={!includeHistory ? "soft" : "secondary"}
                size="md"
                aria-pressed={!includeHistory}
                onClick={() => {
                  setIncludeHistory(false);
                  setPage(1);
                }}
              >
                Hiện tại &amp; sắp hiệu lực
              </Button>
              <Button
                variant={includeHistory ? "soft" : "secondary"}
                size="md"
                aria-pressed={includeHistory}
                onClick={() => {
                  setIncludeHistory(true);
                  setPage(1);
                }}
              >
                Bao gồm lịch sử
              </Button>
            </div>
          }
        >
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchFilter(searchInput);
              setPage(1);
              reloadMemberships();
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-foreground">
              Tìm thành viên
              <input
                type="search"
                value={searchInput}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Tìm theo tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự…"
                onChange={(event) =>
                  setSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>
            <Button type="submit" variant="secondary" size="md">
              Lọc
            </Button>
          </form>
        </FilterToolbar>

        {membershipsState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách thành viên Phòng Kế toán…
          </p>
        ) : null}

        {membershipsState.kind === "denied" ? (
          <Alert tone="error" role="alert" title="Không có quyền truy cập">
            {membershipsState.message}
          </Alert>
        ) : null}

        {membershipsState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách thành viên Phòng Kế toán"
              detail={membershipsState.message}
            />
            {membershipsState.retryable ? (
              <Button variant="secondary" onClick={reloadMemberships}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        ) : null}

        {membershipsState.kind === "ready" && memberships.length === 0 ? (
          <EmptyState
            title={
              includeHistory
                ? "Chưa có bản ghi thành viên hoặc lịch sử phù hợp"
                : "Chưa có thành viên đang hiệu lực tại Phòng Kế toán"
            }
            description={
              searchFilter.trim()
                ? "Không tìm thấy thành viên nào khớp với từ khóa hiện tại."
                : includeHistory
                  ? "Phòng Kế toán hiện chưa có lịch sử gán thành viên."
                  : "Nhấn “Gán thành viên” để thêm tài khoản chính tắc vào Phòng Kế toán."
            }
          />
        ) : null}

        {membershipsState.kind === "ready" && memberships.length > 0 ? (
          <>
            <DataTableContainer dataTestId="accounting-memberships-table">
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thành viên
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thời gian hiệu lực
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Ghi nhận &amp; Lịch sử
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {memberships.map((membership) => {
                    const badge = membershipStateBadge(membership.state);
                    const secondaryMeta = formatAccountSecondaryMeta(membership);
                    return (
                      <tr key={membership.membership_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-foreground">
                              {membership.display_name}
                            </span>
                            {!membership.account_enabled ? (
                              <StatusBadge tone="neutral">
                                Tài khoản ngừng hoạt động
                              </StatusBadge>
                            ) : null}
                          </div>
                          {secondaryMeta ? (
                            <div className="mt-0.5 text-xs text-muted">{secondaryMeta}</div>
                          ) : null}
                        </td>
                        <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                          <StatusBadge tone={badge.tone} dot>
                            {badge.label}
                          </StatusBadge>
                        </td>
                        <td
                          data-label="Thời gian hiệu lực"
                          className={`${DATA_TABLE_TD_CLASS} font-mono text-xs sm:text-sm tabular-nums whitespace-nowrap`}
                        >
                          {membership.valid_from} → {membership.valid_to ?? "Hiện tại"}
                        </td>
                        <td data-label="Ghi nhận" className={DATA_TABLE_TD_CLASS}>
                          <div className="text-xs sm:text-sm text-foreground">
                            Gán bởi: {membership.granted_by_display_name}
                          </div>
                          {membership.revoked_by_display_name ? (
                            <div className="mt-0.5 text-xs text-muted">
                              Kết thúc bởi: {membership.revoked_by_display_name}
                            </div>
                          ) : null}
                        </td>
                        <td
                          data-card-actions="true"
                          className={`${DATA_TABLE_TD_CLASS} text-right`}
                        >
                          <RowActionCluster>
                            {membership.valid_to === null && canManage ? (
                              <Button
                                variant="danger-outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => openEndDialog(membership)}
                              >
                                Kết thúc
                              </Button>
                            ) : (
                              <span className="text-xs text-muted">Chỉ xem</span>
                            )}
                          </RowActionCluster>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>

            <OffsetPager
              page={page}
              pageCount={membershipPageCount}
              total={membershipsState.data.total}
              ariaLabel="Phân trang danh sách thành viên Phòng Kế toán"
              nextDisabled={!membershipsState.data.has_more}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          </>
        ) : null}
      </Card>

      <FormDialog
        open={dialog?.kind === "assign"}
        onOpenChange={(open) => {
          if (!open && !busy) {
            pendingIntentRef.current = null;
            setDialogFeedback(null);
            setDialog(null);
          }
        }}
        title="Gán thành viên vào Phòng Kế toán"
        description="Tìm và chọn tài khoản chính tắc từ hệ thống. Lý do thao tác là bắt buộc và được lưu kiểm toán."
        descriptionId="assign-accounting-member-desc"
        closeDisabled={busy}
        dataTestId="assign-accounting-member-dialog"
      >
        <form className="space-y-4" onSubmit={handleAssignSubmit}>
          <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
            Quyền mặc định chỉ đọc sẽ áp dụng khi hiệu lực:{" "}
            <strong className="text-foreground">{ACCOUNTING_DEFAULT_POLICY_DESCRIPTION}</strong>
          </div>

          <section aria-labelledby="accounting-candidate-picker-heading" className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3
                id="accounting-candidate-picker-heading"
                className="text-sm font-semibold text-foreground"
              >
                1. Chọn tài khoản chính tắc
              </h3>
              {selectedCandidate ? (
                <StatusBadge tone="primary" dot>
                  Đã chọn: {selectedCandidate.display_name}
                </StatusBadge>
              ) : null}
            </div>

            <label className="flex flex-col gap-1 text-xs sm:text-sm font-medium text-foreground">
              Tìm ứng viên
              <input
                type="search"
                value={candidateSearchInput}
                disabled={busy}
                maxLength={DEPARTMENT_UI_MAX_SEARCH_LENGTH}
                placeholder="Nhập tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự…"
                onChange={(event) =>
                  setCandidateSearchInput(sanitizeDepartmentSearchInput(event.target.value))
                }
                className={INPUT_CLASS}
              />
            </label>

            {candidatesState.kind === "loading" ? (
              <p role="status" className="py-4 text-center text-sm text-muted">
                Đang tải danh sách tài khoản ứng viên…
              </p>
            ) : null}

            {candidatesState.kind === "denied" ? (
              <Alert tone="error" role="alert" title="Không có quyền truy cập">
                {candidatesState.message}
              </Alert>
            ) : null}

            {candidatesState.kind === "error" ? (
              <div className="space-y-2">
                <ErrorState
                  title="Không tải được danh sách ứng viên"
                  detail={candidatesState.message}
                />
                {candidatesState.retryable ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={reloadCandidates}
                  >
                    Thử tải lại ứng viên
                  </Button>
                ) : null}
              </div>
            ) : null}

            {candidatesState.kind === "ready" &&
            candidatesState.data.candidates.length === 0 ? (
              <EmptyState
                title="Không tìm thấy tài khoản phù hợp"
                description="Thử nhập từ khóa khác theo tên hiển thị, tài khoản đăng nhập hoặc mã nhân sự."
              />
            ) : null}

            {candidatesState.kind === "ready" &&
            candidatesState.data.candidates.length > 0 ? (
              <>
                <div
                  role="radiogroup"
                  aria-labelledby="accounting-candidate-picker-heading"
                  className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface"
                >
                  {candidatesState.data.candidates.map((candidate) => {
                    const assignable = isCandidateAssignable(candidate);
                    const availability = candidateAvailabilityBadge(candidate);
                    const isSelected =
                      selectedCandidate?.account_ref === candidate.account_ref;
                    const meta = formatAccountSecondaryMeta(candidate);
                    return (
                      <label
                        key={candidate.account_ref}
                        className={`flex items-start justify-between gap-3 px-3.5 py-2.5 text-sm transition-colors ${
                          assignable
                            ? "cursor-pointer hover:bg-surface-hover"
                            : "cursor-not-allowed opacity-65"
                        } ${isSelected ? "bg-primary/8" : ""}`}
                      >
                        <div className="flex min-w-0 items-start gap-2.5">
                          <input
                            type="radio"
                            name="accounting-candidate"
                            className="mt-1 size-4 shrink-0 accent-primary"
                            checked={isSelected}
                            disabled={busy || !assignable}
                            onChange={() => {
                              if (!assignable) return;
                              pendingIntentRef.current = null;
                              setDialogFeedback(null);
                              setSelectedCandidate(candidate);
                            }}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">
                              {candidate.display_name}
                            </div>
                            {meta ? (
                              <div className="mt-0.5 text-xs text-muted">{meta}</div>
                            ) : null}
                          </div>
                        </div>
                        <StatusBadge tone={availability.tone}>
                          {availability.label}
                        </StatusBadge>
                      </label>
                    );
                  })}
                </div>

                <OffsetPager
                  page={candidatePage}
                  pageCount={candidatePageCount}
                  total={candidatesState.data.total}
                  ariaLabel="Phân trang danh sách tài khoản ứng viên"
                  disabled={busy}
                  nextDisabled={!candidatesState.data.has_more}
                  onPageChange={(nextPage) => setCandidatePage(nextPage)}
                />
              </>
            ) : null}
          </section>

          <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
            2. Ngày bắt đầu hiệu lực:{" "}
            <strong className="font-mono text-foreground">{detail.authorization_date}</strong> (áp
            dụng ngay theo ngày nghiệp vụ hệ thống).
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            3. Lý do gán thành viên (bắt buộc)
            <textarea
              required
              rows={3}
              value={assignReason}
              disabled={busy}
              maxLength={DEPARTMENT_UI_MAX_REASON_LENGTH}
              placeholder="Nhập lý do bổ nhiệm hoặc phân công phụ trách kế toán Vendor…"
              onChange={(event) => {
                pendingIntentRef.current = null;
                setAssignReason(event.target.value);
              }}
              className={TEXTAREA_CLASS}
            />
          </label>

          {dialogFeedback ? (
            <Alert
              tone={dialogFeedback.tone}
              role="alert"
              title={
                dialogFeedback.tone === "warning"
                  ? "Cần đồng bộ lại dữ liệu"
                  : "Không thể gán thành viên"
              }
            >
              <p>{dialogFeedback.message}</p>
              {dialogFeedback.needsReload ? (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setDialogFeedback(null);
                      reloadCandidates();
                      reloadMemberships();
                      onMembershipMutated();
                    }}
                  >
                    Tải lại danh sách ứng viên
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => {
                pendingIntentRef.current = null;
                setDialogFeedback(null);
                setDialog(null);
              }}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={busy}
              disabled={busy || !selectedCandidate || assignReason.trim().length === 0}
            >
              {busy ? "Đang lưu…" : "Xác nhận gán thành viên"}
            </Button>
          </div>
        </form>
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "end"}
        onOpenChange={(open) => {
          if (!open && !busy) {
            pendingIntentRef.current = null;
            setDialogFeedback(null);
            setDialog(null);
          }
        }}
        title="Kết thúc tư cách thành viên Phòng Kế toán"
        description="Quyền mặc định “Xem và ghi nhận tài chính Vendor” sẽ ngừng hiệu lực từ thời điểm kết thúc."
        descriptionId="end-accounting-member-desc"
        closeDisabled={busy}
        dataTestId="end-accounting-member-dialog"
      >
        {dialog?.kind === "end" ? (
          <form className="space-y-4" onSubmit={handleEndSubmit}>
            <div className="space-y-1 rounded-lg border border-border bg-surface-muted/60 px-3.5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-foreground">
                  {dialog.membership.display_name}
                </span>
                <StatusBadge
                  tone={membershipStateBadge(dialog.membership.state).tone}
                  dot
                >
                  {membershipStateBadge(dialog.membership.state).label}
                </StatusBadge>
              </div>
              {formatAccountSecondaryMeta(dialog.membership) ? (
                <div className="text-xs text-muted">
                  {formatAccountSecondaryMeta(dialog.membership)}
                </div>
              ) : null}
              <div className="font-mono text-xs tabular-nums text-muted">
                Hiệu lực từ: {dialog.membership.valid_from}
              </div>
            </div>

            {dialog.membership.state === "CURRENT" ? (
              <div className="rounded-lg border border-border bg-surface-muted/60 px-3.5 py-2.5 text-xs text-muted">
                Ngày kết thúc hiệu lực:{" "}
                <strong className="font-mono text-foreground">{detail.authorization_date}</strong>{" "}
                (kết thúc ngay trong ngày hiệu lực hệ thống).
              </div>
            ) : (
              <Alert tone="info" role="status" title="Hủy lịch tham gia sắp hiệu lực">
                Bản ghi này chưa tới ngày bắt đầu ({dialog.membership.valid_from}) nên sẽ được
                chuyển sang lịch sử ngay khi xác nhận.
              </Alert>
            )}

            <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
              Lý do kết thúc (bắt buộc)
              <textarea
                required
                rows={3}
                value={endReason}
                disabled={busy}
                maxLength={DEPARTMENT_UI_MAX_REASON_LENGTH}
                placeholder="Nhập lý do điều chuyển hoặc kết thúc phân công tại Phòng Kế toán…"
                onChange={(event) => {
                  pendingIntentRef.current = null;
                  setEndReason(event.target.value);
                }}
                className={TEXTAREA_CLASS}
              />
            </label>

            {dialogFeedback ? (
              <Alert
                tone={dialogFeedback.tone}
                role="alert"
                title={
                  dialogFeedback.tone === "warning"
                    ? "Cần đồng bộ lại dữ liệu"
                    : "Không thể kết thúc tư cách thành viên"
                }
              >
                <p>{dialogFeedback.message}</p>
                {dialogFeedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        pendingIntentRef.current = null;
                        setDialogFeedback(null);
                        setDialog(null);
                        reloadMemberships();
                        onMembershipMutated();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => {
                  pendingIntentRef.current = null;
                  setDialogFeedback(null);
                  setDialog(null);
                }}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant="danger"
                size="md"
                loading={busy}
                disabled={busy || endReason.trim().length === 0}
              >
                {busy ? "Đang lưu…" : "Xác nhận kết thúc"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
