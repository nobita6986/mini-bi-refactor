"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  AccountProvisionAndLinkStepper,
  type ProvisionStepperMode,
} from "@/components/admin/account-provision-and-link-stepper";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
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
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  buildPersonListQuery,
  classifyPersonOrgReadError,
  DEFAULT_ORG_PAGE_SIZE,
  formatOrgDate,
  personStatusBadge,
  projectPersonListEnvelope,
  sanitizeOrgSearchInput,
  type ListPersonsRpcProjection,
  type PersonFilterStatus,
  type PersonLinkState,
} from "@/lib/admin/person-org-ui-model";
import {
  getBrowserOrigin,
  getBrowserSessionStorage,
  readVerifiedCheckpoint,
  type CheckpointStorageLike,
  type ProvisionCheckpointV2,
} from "@/lib/admin/provision-checkpoint-v2";
import {
  projectDepartmentListResponse,
  type DepartmentProjection,
} from "@/lib/departments/department-contract";

type PersonListLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: ListPersonsRpcProjection }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

function unwrapDepartmentsOk(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  return rest;
}

function summarizeCheckpointStep(cp: ProvisionCheckpointV2): string {
  if (cp.step1_person.status === "UNCERTAIN" || cp.step1_person.status === "IN_FLIGHT") {
    return "Bước 1 (Tạo hồ sơ nhân viên) chưa nhận xác nhận.";
  }
  if (cp.step2_account.status === "NEEDS_RECONCILE") {
    return "Bước 2 (Mở tài khoản đăng nhập) đang chờ đối chiếu kết quả.";
  }
  if (cp.step2_account.status === "UNCERTAIN" || cp.step2_account.status === "IN_FLIGHT") {
    return "Bước 2 (Mở tài khoản đăng nhập) chưa xác nhận; hồ sơ nhân viên đã lưu.";
  }
  if (cp.step3_link.status !== "COMMITTED" && cp.step3_link.status !== "SKIPPED") {
    return "Bước 3 (Gắn tài khoản vào hồ sơ nhân viên) đang chờ hoàn tất.";
  }
  if (cp.step4_roles.some((item) => item.status !== "COMMITTED")) {
    return "Bước 4 (Cấp vai trò khởi tạo) còn vai trò chưa hoàn tất.";
  }
  return "Đang chờ hoàn tất hoặc đối chiếu với máy chủ.";
}

export function PersonListManager({
  checkpointActorScope = "",
  canManageGlobalRoles = true,
  storage,
  originOverride,
}: {
  checkpointActorScope?: string;
  canManageGlobalRoles?: boolean;
  storage?: CheckpointStorageLike | null;
  originOverride?: string;
} = {}) {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PersonFilterStatus>("active");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [linkStateFilter, setLinkStateFilter] = useState<PersonLinkState>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);

  const [listState, setListState] = useState<PersonListLoadState>({ kind: "loading" });
  const [departments, setDepartments] = useState<readonly DepartmentProjection[]>([]);
  const listReqSeqRef = useRef(0);
  const deptReqSeqRef = useRef(0);

  const [stepperMode, setStepperMode] = useState<ProvisionStepperMode | null>(null);
  const [pendingCheckpoint, setPendingCheckpoint] = useState<ProvisionCheckpointV2 | null>(null);
  const [checkpointTick, setCheckpointTick] = useState(0);

  const workspaceGuard = useWp4WorkspaceGuard();

  const resolveStorage = useCallback(
    () => (storage !== undefined ? storage : getBrowserSessionStorage()),
    [storage],
  );
  const resolveOrigin = useCallback(
    () => (originOverride !== undefined ? originOverride : getBrowserOrigin()),
    [originOverride],
  );

  const refreshCheckpointBanner = useCallback(() => {
    setCheckpointTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (!checkpointActorScope) {
        setPendingCheckpoint(null);
        return;
      }
      const result = readVerifiedCheckpoint({
        storage: resolveStorage(),
        expectedOrigin: resolveOrigin(),
        expectedActorScope: checkpointActorScope,
      });
      if (result.kind === "valid") {
        setPendingCheckpoint(result.checkpoint);
      } else {
        // For `foreign_actor_or_origin`, `readVerifiedCheckpoint` leaves storage untouched.
        setPendingCheckpoint(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [checkpointActorScope, checkpointTick, resolveOrigin, resolveStorage]);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      workspaceGuard.invalidateSession();
      deptReqSeqRef.current += 1;
      listReqSeqRef.current += 1;
      setDepartments([]);
      setStepperMode(null);
      setPendingCheckpoint(null);
      setListState({ kind: "denied", message, unauthenticated });
    },
    [workspaceGuard],
  );

  const handleStepperClose = useCallback(() => {
    setStepperMode(null);
    refreshCheckpointBanner();
  }, [refreshCheckpointBanner]);

  const handleStepperCompleted = useCallback(() => {
    setStepperMode(null);
    refreshCheckpointBanner();
    setReloadToken((value) => value + 1);
  }, [refreshCheckpointBanner]);

  useEffect(() => {
    const reqSeq = ++deptReqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    void (async () => {
      try {
        const response = await fetch("/api/admin/departments?include_inactive=true", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== deptReqSeqRef.current) {
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== deptReqSeqRef.current) {
          return;
        }
        if (response.status === 401 || response.status === 403) {
          const err = classifyPersonOrgReadError(response.status, payload);
          handleSessionLost(err.message, err.kind === "unauthenticated");
          return;
        }
        if (response.status !== 200) return;
        const rest = unwrapDepartmentsOk(payload);
        const projected = rest ? projectDepartmentListResponse(rest) : null;
        if (projected) {
          setDepartments(projected.departments);
        }
      } catch {
        // Ignore dropdown fetch error; primary persons list surfaces full error state.
      } finally {
        tracked.release();
      }
    })();
    return () => {
      deptReqSeqRef.current += 1;
      controller.abort();
      tracked.release();
    };
  }, [handleSessionLost, reloadToken, workspaceGuard]);

  useEffect(() => {
    const reqSeq = ++listReqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    void (async () => {
      const filter = {
        search: appliedSearch,
        status: statusFilter,
        departmentId: departmentFilter === "all" ? null : departmentFilter,
        linkState: linkStateFilter,
        page,
        pageSize: DEFAULT_ORG_PAGE_SIZE,
      };
      const query = buildPersonListQuery(filter);
      if (!query) {
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
          return;
        }
        setListState({
          kind: "error",
          message: "Tham số tìm kiếm hoặc bộ lọc phòng ban không hợp lệ.",
          retryable: false,
        });
        tracked.release();
        return;
      }
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
        tracked.release();
        return;
      }
      setListState({ kind: "loading" });
      let response: Response;
      try {
        response = await fetch(`/api/admin/organization/persons?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        tracked.release();
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
          return;
        }
        setListState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách Nhân sự.",
          retryable: true,
        });
        return;
      }

      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
        tracked.release();
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      tracked.release();
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
        return;
      }

      if (response.status !== 200) {
        const failure = classifyPersonOrgReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        setListState({
          kind: "error",
          message: failure.message,
          retryable: failure.retryable,
        });
        return;
      }

      const projected = projectPersonListEnvelope(payload, filter);
      if (!projected) {
        setListState({
          kind: "error",
          message: "Phản hồi danh sách Nhân sự không khớp cấu trúc chuẩn.",
          retryable: true,
        });
        return;
      }

      setListState({ kind: "ready", list: projected });
    })();

    return () => {
      listReqSeqRef.current += 1;
      controller.abort();
      tracked.release();
    };
  }, [
    appliedSearch,
    departmentFilter,
    handleSessionLost,
    linkStateFilter,
    page,
    reloadToken,
    statusFilter,
    workspaceGuard,
  ]);

  const reloadList = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const openCreateStepper = () => {
    if (listState.kind === "denied" || stepperMode !== null) return;
    setStepperMode({ kind: "create-person" });
  };

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setAppliedSearch(sanitizeOrgSearchInput(searchInput).trim());
    setPage(1);
  };

  const resetFilters = () => {
    setSearchInput("");
    setAppliedSearch("");
    setStatusFilter("active");
    setDepartmentFilter("all");
    setLinkStateFilter("all");
    setPage(1);
  };

  const readyList = listState.kind === "ready" ? listState.list : null;
  const pageCount = readyList
    ? Math.min(1000, Math.max(1, Math.ceil(readyList.total / Math.max(1, readyList.page_size))))
    : 1;

  return (
    <PageShell
      dataTestId="organization-persons-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <PageHeader
        eyebrow="Quản trị hệ thống · Nhân sự"
        title="Nhân sự"
        badge={
          readyList ? (
            <StatusBadge tone="primary">{readyList.total} nhân sự</StatusBadge>
          ) : null
        }
        description="Quản lý hồ sơ nhân viên, tài khoản đăng nhập, vai trò và phân công phòng ban trong một luồng thống nhất."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={reloadList}
              disabled={listState.kind === "loading" || listState.kind === "denied" || stepperMode !== null}
            >
              Làm mới
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={openCreateStepper}
              disabled={listState.kind === "denied" || stepperMode !== null}
            >
              + Thêm nhân viên
            </Button>
          </div>
        }
      />

      {listState.kind !== "denied" ? (
        <nav
          aria-label="Công cụ quản trị phụ"
          data-testid="persons-utility-bar"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/35 px-3.5 py-2.5 text-xs"
        >
          <span className="font-medium text-muted">Công cụ quản trị nâng cao:</span>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/access/accounts?view=special"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Tài khoản đặc biệt
            </Link>
            <Link
              href="/admin/access/accounts?view=unlinked"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Đối chiếu dữ liệu cũ
            </Link>
            <Link
              href="/admin/access/effective"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Quyền hiệu lực
            </Link>
          </div>
        </nav>
      ) : null}

      {pendingCheckpoint && listState.kind !== "denied" ? (
        <Alert
          tone="warning"
          role="status"
          title="Có tiến trình thêm nhân viên / mở đăng nhập đang dang dở"
        >
          <div className="space-y-2">
            <p>
              Nhân viên{" "}
              <strong>
                {pendingCheckpoint.step1_person.existing_full_name ??
                  pendingCheckpoint.step1_person.payload_snapshot?.full_name ??
                  "Chưa rõ họ tên"}
              </strong>{" "}
              (
              <span className="font-mono">
                {pendingCheckpoint.step1_person.existing_employee_code ??
                  pendingCheckpoint.step1_person.payload_snapshot?.employee_code ??
                  "—"}
              </span>
              ) —{" "}
              {summarizeCheckpointStep(pendingCheckpoint)}
            </p>
            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={stepperMode !== null}
                onClick={() =>
                  setStepperMode({ kind: "resume-checkpoint", checkpoint: pendingCheckpoint })
                }
              >
                Tiếp tục / Đối chiếu
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <StatusBanner tone="info" title="Tách biệt hồ sơ nhân viên và tài khoản đăng nhập">
        Ngừng hoạt động hồ sơ nhân viên <strong>không tự khóa tài khoản đăng nhập</strong>, và khóa
        đăng nhập không làm thay đổi trạng thái làm việc. Quản lý mật khẩu, khóa/mở đăng nhập và
        vai trò ngay trong hồ sơ chi tiết của từng nhân viên.
      </StatusBanner>

      {listState.kind !== "denied" ? (
        <FilterToolbar
          dataTestId="persons-filter-toolbar"
          summary={
            readyList ? (
              <span>
                Hiển thị {readyList.persons.length} / {readyList.total} nhân sự (ngày hiệu lực tổ
                chức: {formatOrgDate(readyList.authorization_date)})
              </span>
            ) : (
              <span>Bộ lọc máy chủ áp dụng trực tiếp trên toàn bộ danh sách Nhân sự</span>
            )
          }
          actions={
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Đặt lại bộ lọc
            </Button>
          }
        >
          <search>
            <form
              onSubmit={applySearch}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5"
            >
              <div className="sm:col-span-2 xl:col-span-2">
                <label
                  htmlFor="person-search-input"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Tìm kiếm
                </label>
                <div className="flex gap-2">
                  <input
                    id="person-search-input"
                    type="search"
                    value={searchInput}
                    onChange={(event) =>
                      setSearchInput(sanitizeOrgSearchInput(event.target.value))
                    }
                    placeholder="Tìm theo tên, mã nhân viên hoặc tên đăng nhập…"
                    className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                  <Button type="submit" variant="secondary" size="md">
                    Tìm
                  </Button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="person-status-filter"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Trạng thái hồ sơ
                </label>
                <select
                  id="person-status-filter"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value as PersonFilterStatus);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="active">Đang hoạt động</option>
                  <option value="inactive">Ngừng hoạt động</option>
                  <option value="all">Tất cả trạng thái</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="person-department-filter"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Phòng ban hiện hành
                </label>
                <select
                  id="person-department-filter"
                  value={departmentFilter}
                  onChange={(event) => {
                    setDepartmentFilter(event.target.value);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả phòng ban</option>
                  {departments.map((dept) => (
                    <option key={dept.department_id} value={dept.department_id}>
                      {dept.name} ({dept.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="person-link-filter"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Tài khoản đăng nhập
                </label>
                <select
                  id="person-link-filter"
                  value={linkStateFilter}
                  onChange={(event) => {
                    setLinkStateFilter(event.target.value as PersonLinkState);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả</option>
                  <option value="linked">Đã có tài khoản (mở &amp; khóa)</option>
                  <option value="unlinked">Chưa có tài khoản</option>
                </select>
              </div>
            </form>
          </search>
        </FilterToolbar>
      ) : null}

      {listState.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách Nhân sự…
          </p>
        </Card>
      ) : null}

      {listState.kind === "denied" ? (
        <Alert
          tone="error"
          role="alert"
          title={
            listState.unauthenticated ? "Phiên đăng nhập đã hết hạn" : "Không có quyền truy cập"
          }
        >
          <p>{listState.message}</p>
          {listState.unauthenticated ? (
            <div className="mt-2">
              <Link
                href="/login?next=/admin/organization/persons"
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Đăng nhập lại
              </Link>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {listState.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách Nhân sự" detail={listState.message} />
            {listState.retryable ? (
              <div>
                <Button variant="secondary" onClick={reloadList}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {readyList && readyList.persons.length === 0 ? (
        <Card>
          <div className="space-y-4">
            <EmptyState
              title="Chưa có hồ sơ nhân sự phù hợp"
              description="Thử thay đổi bộ lọc tìm kiếm hoặc thêm nhân viên mới."
            />
            <div className="flex justify-center">
              <Button variant="primary" size="md" onClick={openCreateStepper}>
                + Thêm nhân viên
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {readyList && readyList.persons.length > 0 ? (
        <DataTableContainer
          dataTestId="persons-table-container"
          footer={
            <OffsetPager
              page={readyList.page}
              pageCount={pageCount}
              total={readyList.total}
              previousDisabled={readyList.page <= 1}
              nextDisabled={!readyList.has_more && readyList.page >= pageCount}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="mt-0 border-t-0 pt-0"
            />
          }
        >
          <table className={DATA_TABLE_CLASS}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Nhân viên
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Trạng thái
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Phòng ban hiện hành
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Đăng nhập
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Ngày gia nhập
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody>
              {readyList.persons.map((person) => {
                const statusMeta = personStatusBadge(person.status);
                const canQuickOpenLogin =
                  person.status === "ACTIVE" && person.active_account_link === null;
                return (
                  <tr key={person.person_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-label="Nhân viên" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-0.5">
                        <Link
                          href={`/admin/organization/persons/${encodeURIComponent(person.person_id)}`}
                          className="font-semibold text-foreground hover:text-primary hover:underline"
                        >
                          {person.full_name}
                        </Link>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs text-muted">
                            {person.employee_code}
                          </span>
                          {person.recruiter_id ? (
                            <StatusBadge tone="info">Hồ sơ tính công TD</StatusBadge>
                          ) : null}
                        </div>
                      </div>
                    </td>

                    <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={statusMeta.tone} dot>
                        {statusMeta.label}
                      </StatusBadge>
                    </td>

                    <td data-label="Phòng ban hiện hành" className={DATA_TABLE_TD_CLASS}>
                      {person.active_department ? (
                        <Link
                          href={`/admin/departments/${encodeURIComponent(person.active_department.department_id)}`}
                          className="inline-flex flex-col hover:underline"
                        >
                          <span className="font-medium text-foreground">
                            {person.active_department.name}
                          </span>
                          <span className="font-mono text-xs text-muted">
                            {person.active_department.code}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">Chưa gán phòng ban</span>
                      )}
                    </td>

                    <td data-label="Đăng nhập" className={DATA_TABLE_TD_CLASS}>
                      {person.active_account_link ? (
                        <div className="space-y-1">
                          {person.active_account_link.login_id ? (
                            <p className="font-mono text-xs font-medium text-foreground">
                              {person.active_account_link.login_id}
                            </p>
                          ) : null}
                          <StatusBadge
                            tone={person.active_account_link.enabled ? "success" : "warning"}
                            dot
                          >
                            {person.active_account_link.enabled
                              ? "Đang mở đăng nhập"
                              : "Đang khóa đăng nhập"}
                          </StatusBadge>
                        </div>
                      ) : (
                        <StatusBadge tone="neutral">Chưa có tài khoản</StatusBadge>
                      )}
                    </td>

                    <td
                      data-label="Ngày gia nhập"
                      className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}
                    >
                      {formatOrgDate(person.joined_on)}
                    </td>

                    <td data-label="Thao tác" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                      <RowActionCluster>
                        <Link
                          href={`/admin/organization/persons/${encodeURIComponent(person.person_id)}`}
                          className={buttonClasses({ variant: "secondary", size: "sm" })}
                        >
                          Xem hồ sơ
                        </Link>
                        {canQuickOpenLogin ? (
                          <Button
                            variant="soft"
                            size="sm"
                            disabled={stepperMode !== null}
                            onClick={() =>
                              setStepperMode({
                                kind: "open-login-existing",
                                person: {
                                  person_id: person.person_id,
                                  employee_code: person.employee_code,
                                  full_name: person.full_name,
                                  version: person.version,
                                  recruiter_id: person.recruiter_id,
                                },
                              })
                            }
                          >
                            Mở đăng nhập
                          </Button>
                        ) : null}
                      </RowActionCluster>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}

      <AccountProvisionAndLinkStepper
        open={stepperMode !== null}
        mode={stepperMode}
        checkpointActorScope={checkpointActorScope}
        workspaceGuard={workspaceGuard}
        canManageGlobalRoles={canManageGlobalRoles}
        storage={storage}
        originOverride={originOverride}
        onClose={handleStepperClose}
        onCompleted={handleStepperCompleted}
        onCheckpointChanged={refreshCheckpointBanner}
        onSessionLost={handleSessionLost}
      />
    </PageShell>
  );
}
