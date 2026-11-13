"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  AccountSearchPicker,
  DepartmentSelectPicker,
  type SelectedAccountOption,
  type SelectedDepartmentOption,
} from "@/components/admin/org-entity-picker";
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
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  buildCreatePersonRequest,
  buildPersonListQuery,
  classifyPersonOrgMutationResponse,
  classifyPersonOrgReadError,
  DEFAULT_ORG_PAGE_SIZE,
  EMPLOYEE_CODE_MAX_LENGTH,
  FULL_NAME_MAX_LENGTH,
  formatOrgDate,
  newOrgIdempotencyKey,
  personStatusBadge,
  projectPersonListEnvelope,
  REASON_MAX_LENGTH,
  sanitizeOrgSearchInput,
  type ListPersonsRpcProjection,
  type MutatePersonRpcProjection,
  type PersonFilterStatus,
  type PersonLinkState,
} from "@/lib/admin/person-org-ui-model";
import {
  projectDepartmentListResponse,
  type DepartmentProjection,
} from "@/lib/departments/department-contract";

type PersonListLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: ListPersonsRpcProjection }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

type PendingCreateIntent = {
  body: Record<string, unknown>;
  idempotencyKey: string;
  phase: "uncertain";
  message: string;
};

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

export function PersonListManager() {
  const notify = useNotify();

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

  const [createOpen, setCreateOpen] = useState(false);
  const [employeeCode, setEmployeeCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [joinedOn, setJoinedOn] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState<SelectedDepartmentOption | null>(
    null,
  );
  const [selectedAccount, setSelectedAccount] = useState<SelectedAccountOption | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingCreateIntent | null>(null);
  const workspaceGuard = useWp4WorkspaceGuard();

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      workspaceGuard.invalidateSession();
      deptReqSeqRef.current += 1;
      listReqSeqRef.current += 1;
      setBusy(false);
      setDepartments([]);
      setCreateOpen(false);
      setPendingIntent(null);
      setConflictNotice(null);
      setConflictLocked(false);
      setFormError(null);
      setSelectedDepartment(null);
      setSelectedAccount(null);
      setListState({ kind: "denied", message, unauthenticated });
    },
    [workspaceGuard],
  );

  const handlePickerSessionLost = useCallback(
    (message: string) => {
      handleSessionLost(message, false);
    },
    [handleSessionLost],
  );

  const handleSelectDepartment = useCallback((dept: SelectedDepartmentOption | null) => {
    setSelectedDepartment(dept);
  }, []);

  const handleSelectAccount = useCallback((acct: SelectedAccountOption | null) => {
    setSelectedAccount(acct);
  }, []);

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
        // Bỏ qua lỗi mạng khi tải dropdown phòng ban; danh sách chính vẫn báo đầy đủ.
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
          message: "Không thể kết nối tới máy chủ để tải danh sách Nhân sự nội bộ.",
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
          message: "Phản hồi danh sách Nhân sự nội bộ không khớp cấu trúc chuẩn.",
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

  const resetCreateForm = useCallback(() => {
    setEmployeeCode("");
    setFullName("");
    setJoinedOn("");
    setSelectedDepartment(null);
    setSelectedAccount(null);
    setReason("");
    setFormError(null);
    setConflictNotice(null);
    setConflictLocked(false);
    setPendingIntent(null);
  }, []);

  const openCreateDialog = () => {
    if (busy || pendingIntent !== null) return;
    resetCreateForm();
    setCreateOpen(true);
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

  const dispatchCreateIntent = async (body: Record<string, unknown>, idempotencyKey: string) => {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    setConflictNotice(null);
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    try {
      const response = await fetch("/api/admin/organization/persons", {
        method: "POST",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      const outcome = classifyPersonOrgMutationResponse(response.status, payload, "create");

      if (outcome.kind === "applied") {
        const result = outcome.data as MutatePersonRpcProjection;
        notify.success({
          title: outcome.message,
          dedupeKey: `wp4-person-create:${result.person.person_id}`,
          action: {
            label: "Mở chi tiết",
            href: `/admin/organization/persons/${encodeURIComponent(result.person.person_id)}`,
          },
        });
        setPendingIntent(null);
        setConflictLocked(false);
        setCreateOpen(false);
        resetCreateForm();
        reloadList();
        return;
      }

      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, outcome.sessionState === "unauthenticated");
        return;
      }

      if (outcome.kind === "uncertain") {
        setPendingIntent({
          body,
          idempotencyKey,
          phase: "uncertain",
          message: outcome.message,
        });
        return;
      }

      setPendingIntent(null);
      if (outcome.kind === "conflict") {
        setConflictNotice(outcome.message);
        setConflictLocked(true);
        return;
      }
      setFormError(outcome.message);
    } catch {
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      setPendingIntent({
        body,
        idempotencyKey,
        phase: "uncertain",
        message:
          "Mất kết nối trong lúc tạo hồ sơ nhân sự. Đã khóa biểu mẫu để tránh gửi trùng; bạn có thể thử lại đúng yêu cầu hoặc tải lại để đối chiếu.",
      });
    } finally {
      tracked.release();
      if (workspaceGuard.isActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (busy || pendingIntent || conflictLocked) return;
    const idempotencyKey = newOrgIdempotencyKey();
    const request = buildCreatePersonRequest({
      employeeCode,
      fullName,
      joinedOn: joinedOn || null,
      initialDepartmentRef: selectedDepartment?.department_id ?? null,
      accountRef: selectedAccount?.account_ref ?? null,
      expectedAccountVersion: selectedAccount?.version ?? null,
      reason,
      idempotencyKey,
    });
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    void dispatchCreateIntent(request.body, request.idempotencyKey);
  };

  const reconcileFromServer = async () => {
    if (busy) return;
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
      setFormError("Bộ lọc danh sách hiện hành không hợp lệ để đối chiếu.");
      return;
    }
    setBusy(true);
    setFormError(null);
    const reqSeq = ++listReqSeqRef.current;
    const tracked = workspaceGuard.trackController();
    const controller: AbortController = tracked.controller;
    try {
      const response = await fetch(`/api/admin/organization/persons?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
        return;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, controller) || reqSeq !== listReqSeqRef.current) {
        return;
      }
      if (response.status !== 200) {
        const failure = classifyPersonOrgReadError(response.status, payload);
        if (failure.kind === "unauthenticated" || failure.kind === "denied") {
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        setFormError(failure.message);
        return;
      }
      const projected = projectPersonListEnvelope(payload, filter);
      if (!projected) {
        setFormError("Phản hồi danh sách nhân sự không hợp lệ; yêu cầu chờ xác nhận vẫn được giữ nguyên.");
        return;
      }
      setListState({ kind: "ready", list: projected });
      setCreateOpen(false);
      resetCreateForm();
    } catch {
      if (!workspaceGuard.isActive(tracked.epoch, controller)) return;
      setFormError(
        "Không thể kết nối máy chủ để đối chiếu. Yêu cầu chờ xác nhận vẫn được giữ nguyên.",
      );
    } finally {
      tracked.release();
      if (workspaceGuard.isActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const readyList = listState.kind === "ready" ? listState.list : null;
  const pageCount = readyList
    ? Math.min(1000, Math.max(1, Math.ceil(readyList.total / Math.max(1, readyList.page_size))))
    : 1;
  const isFormLocked = busy || pendingIntent !== null;
  const isInputDisabled = isFormLocked || conflictLocked;

  return (
    <PageShell
      dataTestId="organization-persons-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <PageHeader
        eyebrow="Tổ chức & nhân sự"
        title="Nhân sự nội bộ"
        badge={
          readyList ? (
            <StatusBadge tone="primary">{readyList.total} hồ sơ</StatusBadge>
          ) : null
        }
        description="Quản lý hồ sơ nhân sự nội bộ (con người), phòng ban hiện hành và liên kết với tài khoản đăng nhập. Phân biệt với Hồ sơ tính công tuyển dụng và không tự cấp quyền ứng dụng."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              onClick={reloadList}
              disabled={listState.kind === "loading" || listState.kind === "denied" || isFormLocked}
            >
              Làm mới
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={openCreateDialog}
              disabled={listState.kind === "denied" || isFormLocked}
            >
              Tạo hồ sơ nhân sự
            </Button>
          </div>
        }
      />

      <StatusBanner tone="info" title="Phân biệt hồ sơ người và tài khoản đăng nhập">
        Ngừng hoạt động hồ sơ <strong>Nhân sự nội bộ</strong> chỉ phản ánh tình trạng nhân sự trong
        tổ chức và <strong>không tự khóa tài khoản đăng nhập</strong>. Để khóa hoặc mở quyền đăng
        nhập, thực hiện riêng tại trang{" "}
        <Link href="/admin/access/accounts" className="font-medium underline">
          Tài khoản truy cập
        </Link>
        .
      </StatusBanner>

      {listState.kind !== "denied" ? (
      <FilterToolbar
        dataTestId="persons-filter-toolbar"
        summary={
          readyList ? (
            <span>
              Hiển thị {readyList.persons.length} / {readyList.total} nhân sự nội bộ (ngày hiệu lực
              tổ chức: {formatOrgDate(readyList.authorization_date)})
            </span>
          ) : (
            <span>Bộ lọc máy chủ áp dụng trực tiếp trên danh sách Nhân sự nội bộ</span>
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
                  placeholder="Tìm theo mã nhân sự nội bộ hoặc họ tên…"
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
                Liên kết tài khoản
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
                <option value="all">Tất cả tình trạng liên kết</option>
                <option value="linked">Đã liên kết tài khoản</option>
                <option value="unlinked">Chưa liên kết tài khoản</option>
              </select>
            </div>
          </form>
        </search>
      </FilterToolbar>
      ) : null}

      {listState.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách Nhân sự nội bộ…
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
            <ErrorState title="Không tải được danh sách Nhân sự nội bộ" detail={listState.message} />
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
              title="Chưa có hồ sơ nhân sự nội bộ phù hợp"
              description="Thử thay đổi bộ lọc tìm kiếm hoặc tạo hồ sơ nhân sự nội bộ mới."
            />
            <div className="flex justify-center">
              <Button variant="primary" size="md" onClick={openCreateDialog}>
                Tạo hồ sơ nhân sự
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
                  Nhân sự nội bộ
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Trạng thái hồ sơ
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Phòng ban hiện hành
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Tài khoản liên kết
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
                return (
                  <tr key={person.person_id} className={DATA_TABLE_ROW_CLASS}>
                    <td data-label="Nhân sự nội bộ" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-0.5">
                        <Link
                          href={`/admin/organization/persons/${encodeURIComponent(person.person_id)}`}
                          className="font-semibold text-foreground hover:text-primary hover:underline"
                        >
                          {person.full_name}
                        </Link>
                        <p className="font-mono text-xs text-muted">{person.employee_code}</p>
                      </div>
                    </td>

                    <td data-label="Trạng thái hồ sơ" className={DATA_TABLE_TD_CLASS}>
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

                    <td data-label="Tài khoản liên kết" className={DATA_TABLE_TD_CLASS}>
                      {person.active_account_link ? (
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">
                            {person.active_account_link.display_name ??
                              person.active_account_link.login_id ??
                              "Tài khoản đã liên kết"}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            {person.active_account_link.login_id ? (
                              <span className="font-mono">
                                {person.active_account_link.login_id}
                              </span>
                            ) : null}
                            <StatusBadge
                              tone={person.active_account_link.enabled ? "success" : "warning"}
                            >
                              {person.active_account_link.enabled
                                ? "Đang mở đăng nhập"
                                : "Đã khóa đăng nhập"}
                            </StatusBadge>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted">Chưa liên kết tài khoản</span>
                      )}
                    </td>

                    <td data-label="Ngày gia nhập" className={`${DATA_TABLE_TD_CLASS} font-mono text-xs`}>
                      {formatOrgDate(person.joined_on)}
                    </td>

                    <td data-label="Thao tác" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                      <RowActionCluster>
                        <Link
                          href={`/admin/organization/persons/${encodeURIComponent(person.person_id)}`}
                          className={buttonClasses({ variant: "secondary", size: "sm" })}
                        >
                          Chi tiết
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

      <FormDialog
        open={createOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isFormLocked) {
            setCreateOpen(false);
            resetCreateForm();
          }
        }}
        closeDisabled={isFormLocked}
        title="Tạo hồ sơ Nhân sự nội bộ"
        description="Mã nhân sự nội bộ do Admin tự nhập thủ công. Thay đổi phòng ban/liên kết áp dụng ngay khi lưu."
        descriptionId="create-person-dialog-desc"
        contentClassName="sm:w-[min(46rem,calc(100vw-2rem))]"
      >
        {pendingIntent ? (
          <Alert tone="warning" role="alert" title="Yêu cầu tạo hồ sơ chưa nhận được xác nhận">
            <p>{pendingIntent.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void dispatchCreateIntent(pendingIntent.body, pendingIntent.idempotencyKey)
                }
              >
                {busy ? "Đang thử lại…" : "Thử lại đúng yêu cầu"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void reconcileFromServer()}
              >
                Tải lại để đối chiếu
              </Button>
            </div>
          </Alert>
        ) : null}

        {conflictNotice ? (
          <Alert tone="warning" role="alert" title="Dữ liệu vừa thay đổi ở máy chủ">
            <p>{conflictNotice}</p>
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void reconcileFromServer()}
              >
                Tải lại danh sách
              </Button>
            </div>
          </Alert>
        ) : null}

        <form onSubmit={submitCreate} className="mt-3 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="create-person-employee-code"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Mã nhân sự nội bộ <span className="text-red-600">*</span>
              </label>
              <input
                id="create-person-employee-code"
                type="text"
                required
                maxLength={EMPLOYEE_CODE_MAX_LENGTH}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isInputDisabled}
                value={employeeCode}
                onChange={(event) => setEmployeeCode(event.target.value)}
                placeholder="Nhập mã nhân sự nội bộ (2–64 ký tự)"
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground placeholder:font-sans placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
              />
              <p className="mt-1 text-xs text-muted">
                Không dùng định dạng mã NLĐ dự án (<span className="font-mono">hrp-YYYY-XXXXXX</span>).
              </p>
            </div>

            <div>
              <label
                htmlFor="create-person-full-name"
                className="mb-1 block text-sm font-medium text-foreground"
              >
                Họ và tên <span className="text-red-600">*</span>
              </label>
              <input
                id="create-person-full-name"
                type="text"
                required
                maxLength={FULL_NAME_MAX_LENGTH}
                disabled={isInputDisabled}
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="Nhập họ tên đầy đủ"
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="create-person-joined-on"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Ngày gia nhập công ty (tùy chọn)
            </label>
            <input
              id="create-person-joined-on"
              type="date"
              disabled={isInputDisabled}
              value={joinedOn}
              onChange={(event) => setJoinedOn(event.target.value)}
              className="min-h-11 sm:min-h-10 w-full sm:w-56 rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
            />
          </div>

          <DepartmentSelectPicker
            id="create-person-initial-department"
            label="Phòng ban ban đầu (tùy chọn)"
            selectedId={selectedDepartment?.department_id ?? null}
            onSelect={handleSelectDepartment}
            emptyLabel="Chưa gán phòng ban ngay"
            disabled={isInputDisabled}
            onSessionLost={handlePickerSessionLost}
          />

          <AccountSearchPicker
            id="create-person-account-link"
            label="Liên kết tài khoản truy cập (tùy chọn, chỉ tài khoản Cá nhân chưa nối)"
            selectedAccountRef={selectedAccount?.account_ref ?? null}
            onSelect={handleSelectAccount}
            disabled={isInputDisabled}
            onSessionLost={handlePickerSessionLost}
          />

          <div>
            <label
              htmlFor="create-person-reason"
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Lý do thao tác <span className="text-red-600">*</span>
            </label>
            <textarea
              id="create-person-reason"
              required
              rows={2}
              maxLength={REASON_MAX_LENGTH}
              disabled={isInputDisabled}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ghi nhận lý do tạo hồ sơ nhân sự (1–500 ký tự)…"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
            />
          </div>

          {formError ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              disabled={isFormLocked}
              onClick={() => {
                if (isFormLocked) return;
                setCreateOpen(false);
                resetCreateForm();
              }}
            >
              Đóng
            </Button>
            <Button type="submit" variant="primary" disabled={isInputDisabled}>
              {busy ? "Đang lưu…" : "Xác nhận tạo hồ sơ"}
            </Button>
          </div>
        </form>
      </FormDialog>
    </PageShell>
  );
}
