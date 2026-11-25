"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

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
  classifyPersonOrgReadError,
  DEFAULT_ORG_PAGE_SIZE,
  formatOrgDate,
  sanitizeOrgSearchInput,
} from "@/lib/admin/person-org-ui-model";
import {
  clearVerifiedCheckpoint,
  getBrowserOrigin,
  getBrowserSessionStorage,
  readVerifiedCheckpoint,
  type CheckpointStorageLike,
  type ProvisionCheckpointV2,
} from "@/lib/admin/provision-checkpoint-v2";
import {
  buildUserDirectoryQuery,
  projectUserDirectoryListEnvelope,
  resolveUserDirectoryDetailHref,
  userDirectoryLoginBadge,
  userDirectoryWorkStatusBadge,
  type ListUserDirectoryRpcProjection,
  type UserDirectoryLoginStateFilter,
  type UserDirectoryPersonStatusFilter,
  type UserDirectoryRecordKindFilter,
} from "@/lib/admin/user-directory-ui-model";
import {
  projectDepartmentListResponse,
  type DepartmentProjection,
} from "@/lib/departments/department-contract";

type UserDirectoryLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: ListUserDirectoryRpcProjection }
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

function summarizePendingStep(cp: ProvisionCheckpointV2): string {
  if (cp.step1_person.status === "UNCERTAIN" || cp.step1_person.status === "IN_FLIGHT") {
    return "Bước tạo hồ sơ nhân viên đang chờ xác nhận từ máy chủ.";
  }
  if (cp.step2_account.status === "NEEDS_RECONCILE") {
    return "Bước mở tài khoản đăng nhập đang chờ kiểm tra lại kết quả.";
  }
  if (cp.step2_account.status === "UNCERTAIN" || cp.step2_account.status === "IN_FLIGHT") {
    return "Bước mở tài khoản đăng nhập chưa nhận xác nhận; hồ sơ nhân viên đã lưu.";
  }
  if (cp.step3_link.status !== "COMMITTED" && cp.step3_link.status !== "SKIPPED") {
    return "Bước gắn tài khoản vào hồ sơ nhân viên đang chờ hoàn tất.";
  }
  if (
    (cp.step4_groups ?? []).some((item) => item.status !== "COMMITTED") ||
    cp.step4_roles.some((item) => item.status !== "COMMITTED")
  ) {
    return "Bước xếp nhóm quyền khởi tạo còn mục chưa hoàn tất.";
  }
  if (
    cp.step5_recruiter?.enabled &&
    cp.step5_recruiter.status !== "COMMITTED" &&
    cp.step5_recruiter.status !== "SKIPPED"
  ) {
    return "Bước kích hoạt tuyển dụng / xếp tổ đội còn đang chờ hoàn tất.";
  }
  return "Đang chờ hoàn tất bước cuối cùng với máy chủ.";
}

export function PersonListManager({
  checkpointActorScope = "",
  canManageGlobalRoles = true,
  initialRecordKind = "all",
  storage,
  originOverride,
}: {
  checkpointActorScope?: string;
  canManageGlobalRoles?: boolean;
  initialRecordKind?: UserDirectoryRecordKindFilter;
  storage?: CheckpointStorageLike | null;
  originOverride?: string;
} = {}) {
  const searchInputId = useId();
  const recordKindId = useId();
  const personStatusId = useId();
  const loginStateId = useId();
  const deptFilterId = useId();

  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [recordKindFilter, setRecordKindFilter] =
    useState<UserDirectoryRecordKindFilter>(initialRecordKind);
  const [personStatusFilter, setPersonStatusFilter] =
    useState<UserDirectoryPersonStatusFilter>("all");
  const [loginStateFilter, setLoginStateFilter] = useState<UserDirectoryLoginStateFilter>("all");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);

  const [listState, setListState] = useState<UserDirectoryLoadState>({ kind: "loading" });
  const [departments, setDepartments] = useState<readonly DepartmentProjection[]>([]);
  const listReqSeqRef = useRef(0);
  const deptReqSeqRef = useRef(0);

  const [stepperMode, setStepperMode] = useState<ProvisionStepperMode | null>(null);
  const [pendingCheckpoint, setPendingCheckpoint] = useState<ProvisionCheckpointV2 | null>(null);
  const [corruptCheckpointMessage, setCorruptCheckpointMessage] = useState<string | null>(null);
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

  const syncCheckpointStateNow = useCallback((): boolean => {
    if (!checkpointActorScope) {
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(null);
      return false;
    }
    const result = readVerifiedCheckpoint({
      storage: resolveStorage(),
      expectedOrigin: resolveOrigin(),
      expectedActorScope: checkpointActorScope,
    });
    if (result.kind === "valid") {
      setPendingCheckpoint(result.checkpoint);
      setCorruptCheckpointMessage(null);
      return true;
    }
    if (result.kind === "corrupt") {
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(result.message);
      return true;
    }
    setPendingCheckpoint(null);
    setCorruptCheckpointMessage(null);
    return false;
  }, [checkpointActorScope, resolveOrigin, resolveStorage]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      syncCheckpointStateNow();
    });
    return () => {
      cancelled = true;
    };
  }, [checkpointTick, syncCheckpointStateNow]);

  const handleClearCorruptCheckpoint = useCallback(() => {
    if (!checkpointActorScope) return;
    clearVerifiedCheckpoint({
      storage: resolveStorage(),
      expectedOrigin: resolveOrigin(),
      expectedActorScope: checkpointActorScope,
      forceCorruptCleanup: true,
      corruptOnly: true,
    });
    refreshCheckpointBanner();
  }, [checkpointActorScope, refreshCheckpointBanner, resolveOrigin, resolveStorage]);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      workspaceGuard.invalidateSession();
      deptReqSeqRef.current += 1;
      listReqSeqRef.current += 1;
      setDepartments([]);
      setStepperMode(null);
      setPendingCheckpoint(null);
      setCorruptCheckpointMessage(null);
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
        // Optional dropdown degrades cleanly; main user directory surfaces errors.
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
        recordKind: recordKindFilter,
        personStatus: personStatusFilter,
        loginState: loginStateFilter,
        departmentId: departmentFilter === "all" ? null : departmentFilter,
        page,
        pageSize: DEFAULT_ORG_PAGE_SIZE,
      };
      const query = buildUserDirectoryQuery(filter);
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
        response = await fetch(`/api/admin/organization/user-directory?${query.toString()}`, {
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
          message: "Không thể kết nối tới máy chủ để tải danh sách Người dùng.",
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

      const projected = projectUserDirectoryListEnvelope(payload, filter);
      if (!projected) {
        setListState({
          kind: "error",
          message: "Phản hồi danh sách Người dùng chưa đầy đủ.",
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
    loginStateFilter,
    page,
    personStatusFilter,
    recordKindFilter,
    reloadToken,
    workspaceGuard,
  ]);

  const reloadList = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const hasBlockingCheckpoint = pendingCheckpoint !== null || corruptCheckpointMessage !== null;

  const openCreateStepper = () => {
    if (listState.kind === "denied" || stepperMode !== null || hasBlockingCheckpoint) return;
    if (syncCheckpointStateNow()) return;
    setStepperMode({ kind: "create-person" });
  };

  const openLoginForExistingPerson = (person: {
    person_id: string;
    employee_code: string;
    full_name: string;
    version: number;
    recruiter_id: string | null;
  }) => {
    if (listState.kind === "denied" || stepperMode !== null || hasBlockingCheckpoint) return;
    if (syncCheckpointStateNow()) return;
    setStepperMode({ kind: "open-login-existing", person });
  };

  const applySearch = (event: FormEvent) => {
    event.preventDefault();
    setAppliedSearch(sanitizeOrgSearchInput(searchInput).trim());
    setPage(1);
  };

  const resetFilters = () => {
    setSearchInput("");
    setAppliedSearch("");
    setRecordKindFilter("all");
    setPersonStatusFilter("all");
    setLoginStateFilter("all");
    setDepartmentFilter("all");
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
        eyebrow="Quản trị hệ thống · Người dùng"
        title="Người dùng"
        badge={
          readyList ? (
            <StatusBadge tone="primary">{readyList.total} người dùng</StatusBadge>
          ) : null
        }
        description="Thêm người dùng, xếp phòng ban và nhóm quyền, khóa hoặc mở đăng nhập và đặt lại mật khẩu tại một nơi duy nhất."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={reloadList}
              disabled={listState.kind === "loading" || listState.kind === "denied" || stepperMode !== null}
            >
              Làm mới
            </Button>
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={openCreateStepper}
              disabled={listState.kind === "denied" || stepperMode !== null || hasBlockingCheckpoint}
            >
              + Thêm người dùng
            </Button>
          </div>
        }
      />

      {readyList && listState.kind !== "denied" ? (
        <div
          className="inline-flex flex-wrap items-center gap-1 max-w-full rounded-full border border-border/80 bg-surface p-1 text-xs shadow-[var(--shadow-card)]"
          data-testid="user-directory-summary-strip"
        >
          <button
            type="button"
            onClick={() => {
              setRecordKindFilter("all");
              setPage(1);
            }}
            className={`min-h-10 sm:min-h-8 rounded-full px-3.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              recordKindFilter === "all"
                ? "bg-primary font-semibold text-on-primary shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--primary)_58%,transparent)]"
                : "text-muted hover:bg-surface-muted hover:text-[var(--navy)]"
            }`}
          >
            Tất cả ({readyList.summary.total_all})
          </button>
          <button
            type="button"
            onClick={() => {
              setRecordKindFilter("person");
              setPage(1);
            }}
            className={`min-h-10 sm:min-h-8 rounded-full px-3.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
              recordKindFilter === "person"
                ? "bg-primary font-semibold text-on-primary shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--primary)_58%,transparent)]"
                : "text-muted hover:bg-surface-muted hover:text-[var(--navy)]"
            }`}
          >
            Hồ sơ nhân viên ({readyList.summary.linked_count + readyList.summary.person_only_count})
          </button>
          {readyList.summary.unlinked_account_count > 0 ? (
            <button
              type="button"
              onClick={() => {
                setRecordKindFilter("unlinked_account");
                setPage(1);
              }}
              className={`min-h-10 sm:min-h-8 rounded-full px-3.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                recordKindFilter === "unlinked_account"
                  ? "bg-primary font-semibold text-on-primary shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--primary)_58%,transparent)]"
                  : "text-muted hover:bg-surface-muted hover:text-[var(--navy)]"
              }`}
            >
              Tài khoản chưa gắn hồ sơ ({readyList.summary.unlinked_account_count})
            </button>
          ) : null}
          {readyList.summary.conflict_count > 0 ? (
            <button
              type="button"
              onClick={() => {
                setRecordKindFilter("conflict");
                setPage(1);
              }}
              className={`min-h-10 sm:min-h-8 rounded-full px-3.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                recordKindFilter === "conflict"
                  ? "bg-amber-600 font-semibold text-white shadow-2xs"
                  : "bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:text-amber-300"
              }`}
            >
              Cần kiểm tra xung đột ({readyList.summary.conflict_count})
            </button>
          ) : null}
        </div>
      ) : null}

      {pendingCheckpoint && listState.kind !== "denied" ? (
        <Alert
          tone="warning"
          role="status"
          title="Có tiến trình thêm người dùng / mở đăng nhập đang dang dở"
        >
          <div className="space-y-2">
            <p>
              Người dùng{" "}
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
              ) — {summarizePendingStep(pendingCheckpoint)}
            </p>
            <p className="text-xs">
              Nút <strong>+ Thêm người dùng</strong> và <strong>Mở đăng nhập</strong> tạm khóa để
              tránh tạo trùng dữ liệu. Bấm <strong>Tiếp tục hoàn tất</strong> để đồng bộ lại với
              máy chủ.
            </p>
            <div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={stepperMode !== null}
                onClick={() =>
                  setStepperMode({ kind: "resume-checkpoint", checkpoint: pendingCheckpoint })
                }
              >
                Tiếp tục hoàn tất
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {corruptCheckpointMessage && !pendingCheckpoint && listState.kind !== "denied" ? (
        <Alert
          tone="warning"
          role="alert"
          title="Tiến trình lưu tạm trong trình duyệt không thể đọc được"
        >
          <div className="space-y-2">
            <p>{corruptCheckpointMessage}</p>
            <p className="text-xs">
              Hệ thống không tự ghi đè dữ liệu lưu tạm lỗi. Hãy kiểm tra lại danh sách bên dưới rồi
              bấm xóa bản lưu tạm lỗi để mở lại thao tác thêm mới.
            </p>
            <div>
              <Button
                type="button"
                variant="danger-outline"
                size="sm"
                onClick={handleClearCorruptCheckpoint}
              >
                Đã kiểm tra · Xóa bản lưu tạm lỗi
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <StatusBanner tone="info" title="Quản lý tập trung trạng thái làm việc và đăng nhập">
        Ngừng làm việc <strong>không tự khóa đăng nhập</strong>, và khóa đăng nhập không làm mất
        lịch sử làm việc, chấm công hay báo cáo. Mọi tài khoản cá nhân đang có đều hiển thị và quản
        lý trực tiếp trong danh sách này.
      </StatusBanner>

      {listState.kind !== "denied" ? (
        <FilterToolbar
          dataTestId="persons-filter-toolbar"
          summary={
            readyList ? (
              <span>
                Hiển thị {readyList.entries.length} / {readyList.total} người dùng (ngày hiệu lực:{" "}
                {formatOrgDate(readyList.authorization_date)})
              </span>
            ) : (
              <span>Bộ lọc máy chủ áp dụng trên toàn bộ danh sách Người dùng</span>
            )
          }
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
              Đặt lại bộ lọc
            </Button>
          }
        >
          <search>
            <form
              onSubmit={applySearch}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6"
            >
              <div className="sm:col-span-2 xl:col-span-2">
                <label
                  htmlFor={searchInputId}
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Tìm kiếm
                </label>
                <div className="flex gap-2">
                  <input
                    id={searchInputId}
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
                <label htmlFor={recordKindId} className="mb-1 block text-xs font-medium text-muted">
                  Nhóm hồ sơ
                </label>
                <select
                  id={recordKindId}
                  value={recordKindFilter}
                  onChange={(event) => {
                    setRecordKindFilter(event.target.value as UserDirectoryRecordKindFilter);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả người dùng</option>
                  <option value="person">Hồ sơ nhân viên</option>
                  <option value="unlinked_account">Tài khoản chưa gắn hồ sơ</option>
                  <option value="conflict">Cần kiểm tra xung đột</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor={personStatusId}
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Trạng thái làm việc
                </label>
                <select
                  id={personStatusId}
                  value={personStatusFilter}
                  onChange={(event) => {
                    setPersonStatusFilter(event.target.value as UserDirectoryPersonStatusFilter);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả</option>
                  <option value="active">Đang làm việc</option>
                  <option value="inactive">Ngừng làm việc</option>
                  <option value="none">Chưa gắn hồ sơ</option>
                </select>
              </div>

              <div>
                <label htmlFor={loginStateId} className="mb-1 block text-xs font-medium text-muted">
                  Đăng nhập
                </label>
                <select
                  id={loginStateId}
                  value={loginStateFilter}
                  onChange={(event) => {
                    setLoginStateFilter(event.target.value as UserDirectoryLoginStateFilter);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả</option>
                  <option value="enabled">Đang mở đăng nhập</option>
                  <option value="disabled">Đã khóa đăng nhập</option>
                  <option value="no_account">Chưa mở đăng nhập</option>
                </select>
              </div>

              <div>
                <label htmlFor={deptFilterId} className="mb-1 block text-xs font-medium text-muted">
                  Phòng ban
                </label>
                <select
                  id={deptFilterId}
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
            </form>
          </search>
        </FilterToolbar>
      ) : null}

      {listState.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách Người dùng…
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
            <ErrorState title="Không tải được danh sách Người dùng" detail={listState.message} />
            {listState.retryable ? (
              <div>
                <Button type="button" variant="secondary" onClick={reloadList}>
                  Thử tải lại
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {readyList && readyList.entries.length === 0 ? (
        <Card>
          <div className="space-y-4">
            <EmptyState
              title="Chưa có người dùng phù hợp"
              description="Thử thay đổi bộ lọc tìm kiếm hoặc thêm người dùng mới."
            />
            <div className="flex justify-center">
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={openCreateStepper}
                disabled={listState.kind === "denied" || stepperMode !== null || hasBlockingCheckpoint}
              >
                + Thêm người dùng
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {readyList && readyList.entries.length > 0 ? (
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
                  Người dùng
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Trạng thái làm việc
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Phòng ban
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Đăng nhập
                </th>
                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                  Thao tác
                </th>
              </tr>
            </thead>
            <tbody>
              {readyList.entries.map((entry) => {
                const detailHref = resolveUserDirectoryDetailHref(entry);
                const workBadge = userDirectoryWorkStatusBadge(entry);
                const loginBadge = userDirectoryLoginBadge(entry.login_state);
                const canQuickOpenLogin =
                  entry.record_kind === "PERSON_ONLY" &&
                  entry.person !== null &&
                  entry.person.status === "ACTIVE" &&
                  !entry.identity_mutation_blocked;

                return (
                  <tr key={entry.directory_entry_key} className={DATA_TABLE_ROW_CLASS}>
                    <td data-card-header="true" data-label="Người dùng" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-0.5">
                        <Link
                          href={detailHref}
                          className="font-semibold text-[var(--navy)] hover:text-primary hover:underline"
                        >
                          {entry.display_name}
                        </Link>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {entry.person ? (
                            <span className="font-mono text-xs text-muted">
                              {entry.person.employee_code}
                            </span>
                          ) : null}
                          {entry.person?.recruiter_id ? (
                            <StatusBadge tone="info">Tuyển dụng</StatusBadge>
                          ) : null}
                        </div>
                      </div>
                    </td>

                    <td data-label="Trạng thái làm việc" className={DATA_TABLE_TD_CLASS}>
                      <StatusBadge tone={workBadge.tone} dot>
                        {workBadge.label}
                      </StatusBadge>
                    </td>

                    <td data-label="Phòng ban" className={DATA_TABLE_TD_CLASS}>
                      {entry.person?.active_department ? (
                        <Link
                          href={`/admin/departments/${encodeURIComponent(entry.person.active_department.department_id)}`}
                          className="inline-flex flex-col hover:underline"
                        >
                          <span className="font-medium text-[var(--navy)] hover:text-primary">
                            {entry.person.active_department.name}
                          </span>
                          <span className="font-mono text-xs text-muted">
                            {entry.person.active_department.code}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">Chưa gán phòng ban</span>
                      )}
                    </td>

                    <td data-label="Đăng nhập" className={DATA_TABLE_TD_CLASS}>
                      <div className="space-y-1">
                        {entry.account?.login_id ? (
                          <p className="font-mono text-xs font-medium text-[var(--navy)]">
                            {entry.account.login_id}
                          </p>
                        ) : null}
                        <StatusBadge tone={loginBadge.tone} dot>
                          {loginBadge.label}
                        </StatusBadge>
                      </div>
                    </td>

                    <td data-card-actions="true" data-label="Thao tác" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                      <RowActionCluster>
                        <Link
                          href={detailHref}
                          className={buttonClasses({ variant: "secondary", size: "sm" })}
                        >
                          Xem chi tiết
                        </Link>
                        {canQuickOpenLogin && entry.person ? (
                          <Button
                            type="button"
                            variant="soft"
                            size="sm"
                            disabled={stepperMode !== null || hasBlockingCheckpoint}
                            onClick={() =>
                              openLoginForExistingPerson({
                                person_id: entry.person!.person_id,
                                employee_code: entry.person!.employee_code,
                                full_name: entry.person!.full_name,
                                version: entry.person!.version,
                                recruiter_id: entry.person!.recruiter_id,
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
