"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
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
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  CAPABILITY_PRESENTATION_MAP,
  DEFAULT_ROLE_ACCESS_PAGE_SIZE,
  accountTypeBadgeMeta,
  buildAccountsSummaryUrlQuery,
  classifyRoleReadFailure,
  describeCannotRevokeReason,
  describeInactiveOrBlockingReason,
  formatAccountDisplayIdentity,
  formatAuthzTimestampVi,
  formatExceptionSourceKind,
  formatGrantScopeLabel,
  formatRoleSourceKind,
  groupEffectiveGrantsByDomain,
  projectAccountAccessForTarget,
  projectAccountsSummaryForQuery,
  projectRolesCatalogEnvelope,
  resolveContextualAssignmentPresentation,
  resolveModuleAuthorityPresentation,
  resolveRoleCatalogFilters,
  splitOpenAndEndedDirectExceptions,
  splitOpenAndEndedGlobalRoles,
  type EnabledFilterOption,
  type RoleFilterOption,
} from "@/lib/admin/role-effective-access-model";
import type {
  AccountAccessDetail,
  AccountsSummaryListResponse,
  RoleCatalogItem,
  RolesCatalogEnvelope,
} from "@/lib/auth/role-access-contract";
import { isUuid } from "@/lib/http/direct-entry-api-guard";

type SummaryLoadState =
  | { kind: "loading" }
  | { kind: "ready"; list: AccountsSummaryListResponse }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

type DetailLoadState =
  | { kind: "idle" }
  | { kind: "loading"; accountRef: string }
  | { kind: "ready"; detail: AccountAccessDetail }
  | { kind: "error"; accountRef: string; message: string; retryable: boolean };

export type EffectiveAccessFixtureSnapshot = {
  catalog: RolesCatalogEnvelope;
  list: AccountsSummaryListResponse;
  detail: AccountAccessDetail | null;
};

export function EffectiveAccessWorkspace({
  initialAccountRef = null,
  initialFixtureSnapshot,
}: {
  initialAccountRef?: string | null;
  initialFixtureSnapshot?: EffectiveAccessFixtureSnapshot;
}) {
  const normalizedInitialRef =
    initialAccountRef && isUuid(initialAccountRef)
      ? initialAccountRef.toLowerCase()
      : null;

  const [catalogRoles, setCatalogRoles] = useState<readonly RoleCatalogItem[]>(
    () => initialFixtureSnapshot?.catalog.roles ?? [],
  );
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilterOption>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilterOption>("all");
  const [page, setPage] = useState(1);
  const [listReloadToken, setListReloadToken] = useState(0);
  const [detailReloadToken, setDetailReloadToken] = useState(0);

  const [summaryState, setSummaryState] = useState<SummaryLoadState>(() =>
    initialFixtureSnapshot
      ? { kind: "ready", list: initialFixtureSnapshot.list }
      : { kind: "loading" },
  );
  const [selectedAccountRef, setSelectedAccountRef] = useState<string | null>(() => {
    if (normalizedInitialRef) return normalizedInitialRef;
    if (initialFixtureSnapshot?.detail) {
      return initialFixtureSnapshot.detail.account.account_ref;
    }
    return initialFixtureSnapshot?.list.accounts[0]?.account_ref ?? null;
  });
  const [detailState, setDetailState] = useState<DetailLoadState>(() => {
    if (initialFixtureSnapshot?.detail) {
      return { kind: "ready", detail: initialFixtureSnapshot.detail };
    }
    if (initialFixtureSnapshot) {
      return { kind: "idle" };
    }
    return normalizedInitialRef
      ? { kind: "loading", accountRef: normalizedInitialRef }
      : { kind: "idle" };
  });

  const workspaceGuard = useWp4WorkspaceGuard();
  const mountedRef = useRef(true);
  const catalogSeqRef = useRef(0);
  const summarySeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const isFixturePreview = Boolean(initialFixtureSnapshot);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
    };
  }, []);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated: boolean) => {
      workspaceGuard.invalidateSession();
      catalogSeqRef.current += 1;
      summarySeqRef.current += 1;
      detailSeqRef.current += 1;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      if (!mountedRef.current) return;
      setCatalogRoles([]);
      setSelectedAccountRef(null);
      setDetailState({ kind: "idle" });
      setSummaryState({ kind: "denied", message, unauthenticated });
    },
    [workspaceGuard],
  );

  // Load role catalog metadata for filter options and display labels.
  useEffect(() => {
    if (isFixturePreview) return;
    const reqSeq = ++catalogSeqRef.current;
    const tracked = workspaceGuard.trackController();
    void (async () => {
      try {
        const response = await fetch("/api/admin/access/roles", {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== catalogSeqRef.current) {
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== catalogSeqRef.current) {
          return;
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyRoleReadFailure(response.status, payload);
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        if (response.status !== 200 || !mountedRef.current) return;
        const envelope = projectRolesCatalogEnvelope(payload);
        if (envelope) {
          setCatalogRoles(envelope.roles);
        }
      } catch {
        // Fallback metadata comes safely from AUTHZ_CANONICAL_ROLE_CATALOG if catalog fails.
      } finally {
        tracked.release();
      }
    })();
    return () => {
      catalogSeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [handleSessionLost, isFixturePreview, listReloadToken, workspaceGuard]);

  // Load paginated accounts summary.
  useEffect(() => {
    if (isFixturePreview) return;
    const reqSeq = ++summarySeqRef.current;
    const tracked = workspaceGuard.trackController();

    void (async () => {
      const built = buildAccountsSummaryUrlQuery({
        search: appliedSearch,
        enabled: enabledFilter,
        roleCode: roleFilter,
        page,
        pageSize: DEFAULT_ROLE_ACCESS_PAGE_SIZE,
      });
      if (!built.ok) {
        if (workspaceGuard.isActive(tracked.epoch, tracked.controller) && reqSeq === summarySeqRef.current) {
          setSummaryState({ kind: "error", message: built.message, retryable: false });
        }
        tracked.release();
        return;
      }

      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== summarySeqRef.current) {
        tracked.release();
        return;
      }
      setSummaryState({ kind: "loading" });

      let response: Response;
      try {
        response = await fetch(`/api/admin/access/accounts-summary?${built.params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        tracked.release();
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== summarySeqRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        setSummaryState({
          kind: "error",
          message: "Không thể kết nối tới máy chủ để tải danh sách quyền tài khoản.",
          retryable: true,
        });
        return;
      }

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== summarySeqRef.current
      ) {
        tracked.release();
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      tracked.release();

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== summarySeqRef.current ||
        !mountedRef.current
      ) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        const failure = classifyRoleReadFailure(response.status, payload);
        handleSessionLost(failure.message, failure.kind === "unauthenticated");
        return;
      }

      if (response.status !== 200) {
        const failure = classifyRoleReadFailure(response.status, payload);
        setSummaryState({
          kind: "error",
          message: failure.message,
          retryable: failure.kind === "unavailable" || failure.kind === "invalid",
        });
        return;
      }

      const list = projectAccountsSummaryForQuery(payload, built.query);
      if (!list) {
        setSummaryState({
          kind: "error",
          message: "Dữ liệu danh sách tài khoản trả về không đúng chuẩn hợp đồng.",
          retryable: true,
        });
        return;
      }

      const maxPage = Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))));
      if (page > maxPage) {
        setPage(maxPage);
        return;
      }

      setSummaryState({ kind: "ready", list });
      setSelectedAccountRef((prev) => {
        if (prev && list.accounts.some((item) => item.account_ref === prev)) {
          return prev;
        }
        if (normalizedInitialRef && prev === normalizedInitialRef && listReloadToken === 0) {
          return prev;
        }
        return list.accounts[0]?.account_ref ?? null;
      });
    })();

    return () => {
      summarySeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [
    appliedSearch,
    enabledFilter,
    handleSessionLost,
    isFixturePreview,
    listReloadToken,
    normalizedInitialRef,
    page,
    roleFilter,
    workspaceGuard,
  ]);

  const isSummaryDenied = summaryState.kind === "denied";

  // Load effective access detail for selected account; abort stale requests on switch.
  useEffect(() => {
    if (isFixturePreview) return;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;

    const reqSeq = ++detailSeqRef.current;
    const tracked = workspaceGuard.trackController();
    detailAbortRef.current = tracked.controller;

    void (async () => {
      if (!selectedAccountRef || isSummaryDenied) {
        if (
          !isSummaryDenied &&
          workspaceGuard.isActive(tracked.epoch, tracked.controller) &&
          reqSeq === detailSeqRef.current &&
          mountedRef.current
        ) {
          setDetailState({ kind: "idle" });
        }
        if (detailAbortRef.current === tracked.controller) {
          detailAbortRef.current = null;
        }
        tracked.release();
        return;
      }

      const targetRef = selectedAccountRef;
      setDetailState({ kind: "loading", accountRef: targetRef });

      let response: Response;
      try {
        response = await fetch(
          `/api/admin/access/accounts/${encodeURIComponent(targetRef)}/access`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        tracked.release();
        if (detailAbortRef.current === tracked.controller) {
          detailAbortRef.current = null;
        }
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        setDetailState({
          kind: "error",
          accountRef: targetRef,
          message: "Không thể kết nối tới máy chủ để tải chi tiết quyền hiệu lực.",
          retryable: true,
        });
        return;
      }

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== detailSeqRef.current
      ) {
        tracked.release();
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      tracked.release();
      if (detailAbortRef.current === tracked.controller) {
        detailAbortRef.current = null;
      }

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== detailSeqRef.current ||
        !mountedRef.current
      ) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        const failure = classifyRoleReadFailure(response.status, payload);
        handleSessionLost(failure.message, failure.kind === "unauthenticated");
        return;
      }

      if (response.status !== 200) {
        const failure = classifyRoleReadFailure(response.status, payload);
        setDetailState({
          kind: "error",
          accountRef: targetRef,
          message: failure.message,
          retryable: failure.kind === "unavailable" || failure.kind === "invalid",
        });
        return;
      }

      const detail = projectAccountAccessForTarget(payload, targetRef);
      if (!detail) {
        setDetailState({
          kind: "error",
          accountRef: targetRef,
          message: "Chi tiết quyền hiệu lực trả về không khớp định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setDetailState({ kind: "ready", detail });
    })();

    return () => {
      detailSeqRef.current += 1;
      tracked.controller.abort();
      if (detailAbortRef.current === tracked.controller) {
        detailAbortRef.current = null;
      }
      tracked.release();
    };
  }, [
    detailReloadToken,
    handleSessionLost,
    isFixturePreview,
    isSummaryDenied,
    selectedAccountRef,
    workspaceGuard,
  ]);

  const roleFilterGroups = useMemo(
    () => resolveRoleCatalogFilters(catalogRoles),
    [catalogRoles],
  );

  const summaryList = summaryState.kind === "ready" ? summaryState.list : null;
  const pageCount = summaryList
    ? Math.min(1000, Math.max(1, Math.ceil(summaryList.total / Math.max(1, summaryList.page_size))))
    : 1;
  const hasActiveFilters =
    appliedSearch.length > 0 || enabledFilter !== "all" || roleFilter !== "all";

  const handleFilterSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const built = buildAccountsSummaryUrlQuery({
      search: searchInput,
      enabled: enabledFilter,
      roleCode: roleFilter,
      page: 1,
      pageSize: DEFAULT_ROLE_ACCESS_PAGE_SIZE,
    });
    if (!built.ok) {
      setSummaryState({ kind: "error", message: built.message, retryable: false });
      return;
    }
    const nextSearch = searchInput.trim();
    const shouldBumpReload = nextSearch === appliedSearch && page === 1;
    setPage(1);
    setAppliedSearch(nextSearch);
    if (shouldBumpReload) {
      setListReloadToken((token) => token + 1);
    }
  };

  const resetFilters = () => {
    setSearchInput("");
    setAppliedSearch("");
    setEnabledFilter("all");
    setRoleFilter("all");
    setPage(1);
  };

  const accountsPageHref = selectedAccountRef
    ? `/admin/access/accounts?tab=global-roles&account=${encodeURIComponent(selectedAccountRef)}`
    : "/admin/access/accounts?tab=global-roles";

  return (
    <PageShell dataTestId="effective-access-workspace">
      <PageHeader
        eyebrow="Quản trị phân quyền"
        title="Quyền hiệu lực tài khoản"
        badge={
          summaryList ? (
            <StatusBadge tone="primary">{summaryList.total} tài khoản</StatusBadge>
          ) : null
        }
        description="Tra cứu tách bạch giữa vai trò/phân công được gắn và quyền thực sự đang có hiệu lực cùng nguyên nhân bị chặn. Phân công theo ngữ cảnh và phân hệ chỉ xem tại đây."
        actions={
          <Link
            href={accountsPageHref}
            className={buttonClasses({ variant: "secondary", size: "md" })}
          >
            Quản trị tài khoản & Vai trò
          </Link>
        }
      />

      {summaryState.kind === "denied" ? (
        <div className="space-y-3">
          <ErrorState
            title={
              summaryState.unauthenticated
                ? "Phiên đăng nhập đã hết hiệu lực"
                : "Không có quyền xem quyền hiệu lực tài khoản"
            }
            detail={summaryState.message}
          />
          {summaryState.unauthenticated ? (
            <Link
              href="/login?next=/admin/access/effective"
              className={buttonClasses({ variant: "primary", size: "md" })}
            >
              Đăng nhập lại
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <FilterToolbar
            dataTestId="effective-access-filter-toolbar"
            summary={
              summaryList ? (
                <>
                  <span>
                    Hiển thị {summaryList.accounts.length} / {summaryList.total} tài khoản
                    {summaryList.as_of
                      ? ` · Đối chiếu lúc ${formatAuthzTimestampVi(summaryList.as_of)}`
                      : ""}
                  </span>
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      Xóa bộ lọc
                    </button>
                  ) : null}
                </>
              ) : (
                <span>Lọc theo tên, mã đăng nhập, trạng thái hoặc vai trò.</span>
              )
            }
          >
            <form
              className="grid grid-cols-1 min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto]"
              onSubmit={handleFilterSubmit}
            >
              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="eff-search-input">Tìm kiếm tài khoản</label>
                <input
                  id="eff-search-input"
                  type="search"
                  value={searchInput}
                  maxLength={256}
                  placeholder="Tên hiển thị hoặc mã đăng nhập…"
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="eff-enabled-select">Trạng thái tài khoản</label>
                <select
                  id="eff-enabled-select"
                  value={enabledFilter}
                  onChange={(event) => {
                    setEnabledFilter(event.target.value as EnabledFilterOption);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value="all">Tất cả trạng thái</option>
                  <option value="true">Đang hoạt động</option>
                  <option value="false">Ngừng hoạt động (đã khóa)</option>
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="eff-role-select">Lọc theo vai trò</label>
                <select
                  id="eff-role-select"
                  value={roleFilter}
                  onChange={(event) => {
                    setRoleFilter(event.target.value as RoleFilterOption);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value="all">Tất cả vai trò</option>
                  <optgroup label="Vai trò toàn cục">
                    {roleFilterGroups.globalRoles.map((role) => (
                      <option key={role.role_code} value={role.role_code}>
                        {role.display_name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Vai trò theo ngữ cảnh">
                    {roleFilterGroups.contextualRoles.map((role) => (
                      <option key={role.role_code} value={role.role_code}>
                        {role.display_name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="flex items-end">
                <Button type="submit" variant="secondary" size="md">
                  Lọc danh sách
                </Button>
              </div>
            </form>
          </FilterToolbar>

          <div className="grid grid-cols-1 min-w-0 gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1.18fr)] xl:items-start">
            <Card className="min-w-0">
              <CardHeader
                title="Danh sách tài khoản"
                description="Chọn một tài khoản để đối chiếu phân công và tập quyền thực sự hiệu lực."
              />

              {summaryState.kind === "loading" ? (
                <p role="status" className="py-8 text-center text-sm text-muted">
                  Đang tải danh sách quyền tài khoản…
                </p>
              ) : null}

              {summaryState.kind === "error" ? (
                <div className="space-y-3">
                  <ErrorState
                    title="Không tải được danh sách tài khoản"
                    detail={summaryState.message}
                  />
                  {summaryState.retryable ? (
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => setListReloadToken((token) => token + 1)}
                    >
                      Thử tải lại
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {summaryList ? (
                summaryList.accounts.length === 0 ? (
                  <EmptyState
                    title="Không có tài khoản phù hợp"
                    description="Thử thay đổi từ khóa tìm kiếm hoặc bộ lọc trạng thái/vai trò."
                  />
                ) : (
                  <DataTableContainer
                    footer={
                      <OffsetPager
                        page={page}
                        pageCount={pageCount}
                        total={summaryList.total}
                        ariaLabel="Phân trang danh sách quyền tài khoản"
                        onPageChange={(nextPage) => setPage(nextPage)}
                      />
                    }
                  >
                    <div
                      role="region"
                      tabIndex={0}
                      aria-labelledby="eff-accounts-table-caption"
                      className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <table className={DATA_TABLE_CLASS}>
                        <caption id="eff-accounts-table-caption" className="sr-only">
                          Bảng tóm tắt vai trò và quyền hiệu lực của tài khoản
                        </caption>
                        <thead className={DATA_TABLE_HEAD_CLASS}>
                          <tr>
                            <th scope="col" className={DATA_TABLE_TH_CLASS}>
                              Tài khoản & Hiệu lực
                            </th>
                            <th scope="col" className={DATA_TABLE_TH_CLASS}>
                              Vai trò đã gắn
                            </th>
                            <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                              Chi tiết
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {summaryList.accounts.map((account) => {
                            const identity = formatAccountDisplayIdentity(account);
                            const typeMeta = accountTypeBadgeMeta(account.account_type);
                            const isSelected = selectedAccountRef === account.account_ref;
                            return (
                              <tr
                                key={account.account_ref}
                                className={`${DATA_TABLE_ROW_CLASS} ${
                                  isSelected ? "bg-primary/5" : ""
                                }`}
                              >
                                <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                                  <div className="space-y-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="font-medium text-foreground">
                                        {identity.primary}
                                      </span>
                                      <StatusBadge tone={typeMeta.tone}>{typeMeta.label}</StatusBadge>
                                    </div>
                                    {identity.secondary ? (
                                      <div className="text-xs text-muted">{identity.secondary}</div>
                                    ) : null}
                                    {account.person ? (
                                      <div className="text-xs text-muted">
                                        Nhân sự: {account.person.full_name} ({account.person.employee_code})
                                      </div>
                                    ) : null}
                                    <div className="flex flex-wrap gap-1 pt-0.5">
                                      <StatusBadge
                                        tone={account.enabled ? "success" : "danger"}
                                        dot
                                      >
                                        {account.enabled ? "Đang hoạt động" : "Ngừng hoạt động"}
                                      </StatusBadge>
                                      <StatusBadge
                                        tone={
                                          account.enabled && account.effective_grant_count > 0
                                            ? "success"
                                            : "neutral"
                                        }
                                      >
                                        {account.effective_grant_count} quyền hiệu lực
                                      </StatusBadge>
                                    </div>
                                  </div>
                                </td>

                                <td data-label="Vai trò đã gắn" className={`${DATA_TABLE_TD_CLASS} min-w-0`}>
                                  <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1 md:justify-start">
                                    {account.global_roles.length === 0 &&
                                    account.contextual_roles.length === 0 ? (
                                      <span className="text-xs text-muted">Chưa gán vai trò</span>
                                    ) : null}
                                    {account.global_roles.map((role) => (
                                      <StatusBadge
                                        key={role.assignment_id}
                                        tone={
                                          role.is_effective
                                            ? role.is_protected
                                              ? "primary"
                                              : "info"
                                            : "warning"
                                        }
                                      >
                                        {role.display_name}
                                        {role.is_protected ? " · Owner" : ""}
                                      </StatusBadge>
                                    ))}
                                    {account.contextual_roles.map((ctx, idx) => (
                                      <span
                                        key={`${ctx.role_code}:${ctx.target_ref}:${idx}`}
                                        className={`inline-block max-w-full rounded-full border px-2.5 py-0.5 text-xs font-medium leading-snug whitespace-normal break-words text-left ${
                                          ctx.is_effective
                                            ? "border-border bg-muted/12 text-muted dark:bg-muted/20 dark:text-foreground/80"
                                            : "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200"
                                        }`}
                                      >
                                        {ctx.display_name}: {ctx.target_label}
                                      </span>
                                    ))}
                                  </div>
                                </td>

                                <td data-card-actions="true" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                                  <div>
                                    <Button
                                      variant={isSelected ? "primary" : "secondary"}
                                      size="sm"
                                      aria-pressed={isSelected}
                                      aria-label={`Xem chi tiết quyền hiệu lực của ${identity.primary}`}
                                      onClick={() => setSelectedAccountRef(account.account_ref)}
                                    >
                                      {isSelected ? "Đang xem" : "Xem chi tiết"}
                                    </Button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </DataTableContainer>
                )
              ) : null}
            </Card>

            <section
              id="effective-access-detail-pane"
              className="min-w-0"
              aria-label="Chi tiết quyền hiệu lực tài khoản"
              aria-busy={detailState.kind === "loading"}
            >
              {detailState.kind === "idle" ? (
                <Card>
                  <EmptyState
                    title="Chưa chọn tài khoản"
                    description="Chọn một tài khoản từ danh sách bên cạnh để xem phân công vai trò và quyền hiệu lực thực tế."
                  />
                </Card>
              ) : null}

              {detailState.kind === "loading" ? (
                <Card>
                  <p role="status" className="py-10 text-center text-sm text-muted">
                    Đang tải chi tiết phân quyền hiệu lực…
                  </p>
                </Card>
              ) : null}

              {detailState.kind === "error" ? (
                <Card>
                  <div className="space-y-3">
                    <ErrorState
                      title="Không tải được chi tiết quyền hiệu lực"
                      detail={detailState.message}
                    />
                    {detailState.retryable ? (
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => setDetailReloadToken((token) => token + 1)}
                      >
                        Thử tải lại chi tiết
                      </Button>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              {detailState.kind === "ready" ? (
                <EffectiveAccessDetailPanel detail={detailState.detail} />
              ) : null}
            </section>
          </div>
        </>
      )}
    </PageShell>
  );
}

function EffectiveAccessDetailPanel({ detail }: { detail: AccountAccessDetail }) {
  const { account } = detail;
  const identity = formatAccountDisplayIdentity(account);
  const typeMeta = accountTypeBadgeMeta(account.account_type);
  const { activeAssigned, endedHistory: endedRoles } = splitOpenAndEndedGlobalRoles(
    detail.assigned_global_roles,
  );
  const { activeExceptions, endedHistory: endedExceptions } = splitOpenAndEndedDirectExceptions(
    detail.direct_exceptions,
  );
  const grantGroups = groupEffectiveGrantsByDomain(detail);

  const effectiveAssignedRolesCount = activeAssigned.filter((role) => role.is_effective).length;
  const totalAssignedObjects =
    activeAssigned.length +
    detail.contextual_assignments.length +
    activeExceptions.length +
    detail.module_authorities.length;

  const isDisabled = !account.enabled || detail.blocking_reasons.includes("ACCOUNT_DISABLED");

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">{identity.primary}</h2>
              <StatusBadge tone={typeMeta.tone}>{typeMeta.label}</StatusBadge>
              <StatusBadge tone={account.enabled ? "success" : "danger"} dot>
                {account.enabled ? "Đang hoạt động" : "Ngừng hoạt động"}
              </StatusBadge>
            </div>
            {identity.secondary ? (
              <p className="text-xs text-muted">Mã đăng nhập: {identity.secondary}</p>
            ) : null}
            {account.person ? (
              <p className="text-sm text-foreground">
                Hồ sơ nhân sự:{" "}
                <Link
                  href={`/admin/organization/persons/${encodeURIComponent(account.person.person_id)}`}
                  className="font-medium text-primary hover:underline"
                >
                  {account.person.full_name} ({account.person.employee_code})
                </Link>
                {account.person.department_name ? ` · ${account.person.department_name}` : ""}
                {account.person.status === "INACTIVE" ? " · Hồ sơ nhân sự đã ngừng hoạt động" : ""}
              </p>
            ) : (
              <p className="text-xs text-muted">Chưa liên kết hồ sơ nhân sự nội bộ.</p>
            )}
            <p className="text-xs text-muted">
              Mốc đối chiếu máy chủ: {formatAuthzTimestampVi(detail.as_of)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {account.person ? (
              <Link
                href={`/admin/organization/persons/${encodeURIComponent(account.person.person_id)}`}
                className={buttonClasses({ variant: "primary", size: "sm" })}
              >
                Mở hồ sơ nhân viên
              </Link>
            ) : null}
            <Link
              href={`/admin/access/accounts?tab=global-roles&account=${encodeURIComponent(account.account_ref)}`}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Quản lý vai trò toàn cục
            </Link>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3">
            <dt className="text-xs text-muted">Phân công đang giữ</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {totalAssignedObjects}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3">
            <dt className="text-xs text-muted">Vai trò toàn cục hiệu lực</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {effectiveAssignedRolesCount} / {activeAssigned.length}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3">
            <dt className="text-xs text-muted">Phân công ngữ cảnh</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {detail.contextual_assignments.filter((item) => item.is_effective).length} /{" "}
              {detail.contextual_assignments.length}
            </dd>
          </div>
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3">
            <dt className="text-xs text-muted">Quyền thực sự hiệu lực</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {detail.effective_grants.length}
            </dd>
          </div>
        </dl>
      </Card>

      {isDisabled || detail.blocking_reasons.length > 0 ? (
        <Alert
          tone="warning"
          role="status"
          title="Tài khoản đang bị chặn hiệu lực phân quyền (0 quyền hiệu lực)"
        >
          {detail.blocking_reasons.length > 0 ? (
            <ul className="list-disc pl-5 space-y-1">
              {detail.blocking_reasons.map((reason) => (
                <li key={reason}>{describeInactiveOrBlockingReason(reason)}</li>
              ))}
            </ul>
          ) : (
            <p>{describeInactiveOrBlockingReason("ACCOUNT_DISABLED")}</p>
          )}
          <p>
            Các vai trò toàn cục và phân công còn mở vẫn được ghi nhận bên dưới ở trạng thái bị chặn và không tạo quyền thực thi cho tới khi hết nguyên nhân chặn.
          </p>
        </Alert>
      ) : null}

      {account.enabled && !account.authz_managed ? (
        <StatusBanner tone="info" title="Tài khoản đang chạy ở chế độ chuyển tiếp trước cutover">
          <p>
            Hồ sơ này chưa chuyển sang quản trị vai trò toàn cục hợp nhất. Quyền đang hiệu lực được phản chiếu từ cấu hình hiện hành qua cầu nối an toàn.
          </p>
        </StatusBanner>
      ) : null}

      {/* Block 1: Global Roles */}
      <Card>
        <h3 className="text-base font-semibold text-foreground">1. Vai trò toàn cục</h3>
        <p className="mt-1 text-xs text-muted">
          Phân biệt giữa vai trò đã gán cho tài khoản và trạng thái đang có hiệu lực thực tế.
        </p>

        {activeAssigned.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Chưa có vai trò toàn cục nào đang mở.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {activeAssigned.map((role) => {
              const protectedText = describeCannotRevokeReason(role.cannot_revoke_reason);
              return (
                <li
                  key={role.assignment_id}
                  className="rounded-xl border border-border bg-surface-muted/30 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{role.display_name}</span>
                      <StatusBadge tone={role.is_effective ? "success" : "warning"} dot>
                        {role.is_effective
                          ? "Đang có hiệu lực"
                          : "Được phân công · Đang bị chặn"}
                      </StatusBadge>
                      {role.is_protected ? (
                        <StatusBadge tone="primary">Bảo vệ Owner</StatusBadge>
                      ) : null}
                    </div>
                    <span className="text-xs text-muted">
                      Bắt đầu: {formatAuthzTimestampVi(role.started_at)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    Nguồn: {formatRoleSourceKind(role.source_kind)}
                    {role.assigned_by_display ? ` · Người gán: ${role.assigned_by_display}` : ""}
                  </p>
                  {role.reason ? (
                    <p className="mt-1 text-xs text-foreground">Lý do: {role.reason}</p>
                  ) : null}
                  {!role.is_effective && role.inactive_reason ? (
                    <p className="mt-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                      Nguyên nhân chặn: {describeInactiveOrBlockingReason(role.inactive_reason)}
                    </p>
                  ) : null}
                  {protectedText ? (
                    <p className="mt-1 text-xs text-primary">{protectedText}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {endedRoles.length > 0 ? (
          <details className="mt-3 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted hover:text-foreground">
              Lịch sử vai trò đã thu hồi ({endedRoles.length})
            </summary>
            <ul className="mt-2 space-y-2 border-t border-border pt-2">
              {endedRoles.map((role) => (
                <li key={role.assignment_id} className="text-muted">
                  <span className="font-medium text-foreground">{role.display_name}</span> · Thu hồi lúc{" "}
                  {formatAuthzTimestampVi(role.ended_at)}
                  {role.ended_reason ? ` · Lý do: ${role.ended_reason}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {/* Block 2: Contextual Roles (Read-Only) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              2. Phân công theo ngữ cảnh (Nhóm, Phòng ban, Dự án)
            </h3>
            <p className="mt-1 text-xs text-muted">
              Bao gồm Trưởng nhóm, Trưởng phòng ban, Quản lý dự án (PM) và Kế toán dự án. Chỉ xem tại đây; thay đổi thực hiện ở màn hình quản lý nguồn.
            </p>
          </div>
          <StatusBadge tone="neutral">Chỉ xem</StatusBadge>
        </div>

        {detail.contextual_assignments.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Không có phân công theo ngữ cảnh nào.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {detail.contextual_assignments.map((item, idx) => {
              const meta = resolveContextualAssignmentPresentation(item);
              return (
                <li
                  key={`${item.role_code}:${item.target_ref}:${item.assignment_id ?? idx}`}
                  className="rounded-xl border border-border bg-surface-muted/30 p-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{item.display_name}</span>
                        <StatusBadge tone={meta.statusTone} dot>
                          {meta.statusLabel}
                        </StatusBadge>
                      </div>
                      <p className="text-xs text-foreground">
                        {meta.targetKindLabel}: <strong>{item.target_label}</strong>
                      </p>
                    </div>
                    <Link
                      href={meta.sourceLink.href}
                      className={buttonClasses({ variant: "outline", size: "sm" })}
                    >
                      {meta.sourceLink.label}
                    </Link>
                  </div>
                  <p className="mt-1.5 text-xs text-muted">{meta.explanation}</p>
                  {meta.capabilityLabels.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {meta.capabilityLabels.map((label) => (
                        <span
                          key={label}
                          className="inline-block max-w-full rounded-full border border-sky-500/30 bg-sky-500/12 px-2.5 py-0.5 text-xs font-medium leading-snug whitespace-normal break-words text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-200"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Block 3: Direct Exceptions (Read-Only) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              3. Quyền riêng & Ngoại lệ hiện có
            </h3>
            <p className="mt-1 text-xs text-muted">
              Các quyền cấp lẻ ngoài gói vai trò mặc định.
            </p>
          </div>
          <StatusBadge tone="neutral">Chỉ xem</StatusBadge>
        </div>

        {activeExceptions.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Không có quyền ngoại lệ nào đang mở.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {activeExceptions.map((item) => {
              const capMeta = CAPABILITY_PRESENTATION_MAP[item.capability];
              return (
                <li
                  key={item.direct_grant_id}
                  className="rounded-xl border border-border bg-surface-muted/30 p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{capMeta.label}</span>
                      <StatusBadge tone={item.is_effective ? "success" : "warning"} dot>
                        {item.is_effective
                          ? "Đang có hiệu lực"
                          : "Được cấp · Đang bị chặn"}
                      </StatusBadge>
                    </div>
                    <StatusBadge tone="neutral">
                      {formatGrantScopeLabel(item.scope_kind, item.scope_label, item.scope_id)}
                    </StatusBadge>
                  </div>
                  <p className="mt-1.5 text-xs text-muted">
                    {formatExceptionSourceKind(item.source_kind)} · Cấp lúc{" "}
                    {formatAuthzTimestampVi(item.started_at)}
                    {item.granted_by_display ? ` · Người cấp: ${item.granted_by_display}` : ""}
                  </p>
                  {item.reason ? (
                    <p className="mt-1 text-xs text-foreground">Lý do: {item.reason}</p>
                  ) : null}
                  {!item.is_effective && item.inactive_reason ? (
                    <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">
                      Nguyên nhân chặn: {describeInactiveOrBlockingReason(item.inactive_reason)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {endedExceptions.length > 0 ? (
          <details className="mt-3 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted hover:text-foreground">
              Lịch sử quyền ngoại lệ đã kết thúc ({endedExceptions.length})
            </summary>
            <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
              {endedExceptions.map((item) => (
                <li key={item.direct_grant_id} className="text-muted">
                  <span className="font-medium text-foreground">
                    {CAPABILITY_PRESENTATION_MAP[item.capability].label}
                  </span>{" "}
                  · Kết thúc lúc {formatAuthzTimestampVi(item.ended_at)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      {/* Block 4: Module Authorities & Delegations (Read-Only) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              4. Quyền theo phân hệ & Ủy quyền nghiệp vụ
            </h3>
            <p className="mt-1 text-xs text-muted">
              Phân quyền riêng của Nghỉ phép, Tài chính Vendor và Ủy quyền theo mẫu trong Báo cáo công việc.
            </p>
          </div>
          <StatusBadge tone="neutral">Chỉ xem</StatusBadge>
        </div>

        {detail.module_authorities.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Không có phân quyền hoặc ủy quyền phân hệ bổ sung.</p>
        ) : (
          <ul className="mt-3 space-y-2.5">
            {detail.module_authorities.map((item, idx) => {
              const meta = resolveModuleAuthorityPresentation(item);
              return (
                <li
                  key={`${item.module}:${item.authority_code}:${item.scope_ref ?? idx}`}
                  className="rounded-xl border border-border bg-surface-muted/30 p-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
                        {meta.moduleLabel}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{meta.authorityTitle}</span>
                        <StatusBadge tone={meta.statusTone} dot>
                          {meta.statusLabel}
                        </StatusBadge>
                      </div>
                      <p className="text-xs text-muted">Phạm vi: {meta.scopeText}</p>
                    </div>
                    {meta.sourceLink ? (
                      <Link
                        href={meta.sourceLink.href}
                        className={buttonClasses({ variant: "outline", size: "sm" })}
                      >
                        {meta.sourceLink.label}
                      </Link>
                    ) : null}
                  </div>
                  {meta.blockingText ? (
                    <p className="mt-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                      Nguyên nhân chặn: {meta.blockingText}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Block 5: Effective Paired Grants Grouped by Business Domain */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              5. Quyền thực sự hiệu lực trên hệ thống
            </h3>
            <p className="mt-1 text-xs text-muted">
              Tổng hợp các cặp quyền và phạm vi đã vượt qua mọi điều kiện hoạt động của tài khoản, nhân sự và đơn vị liên quan.
            </p>
          </div>
          <StatusBadge tone={detail.effective_grants.length > 0 ? "success" : "neutral"}>
            {detail.effective_grants.length} quyền hiệu lực
          </StatusBadge>
        </div>

        {grantGroups.length === 0 ? (
          <EmptyState
            title="Hiện có 0 quyền hiệu lực"
            description={
              isDisabled
                ? "Tài khoản đang bị khóa (ngừng hoạt động) nên toàn bộ quyền thực thi đều tạm đình chỉ."
                : "Tài khoản chưa được cấp quyền nghiệp vụ hiệu lực nào trên Direct Entry / phân hệ liên kết."
            }
          />
        ) : (
          <div className="mt-4 space-y-4">
            {grantGroups.map((group) => (
              <div
                key={group.domain.id}
                className="rounded-xl border border-border bg-surface-muted/20 p-3.5"
              >
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">{group.domain.title}</h4>
                    <p className="text-xs text-muted">{group.domain.description}</p>
                  </div>
                  <StatusBadge tone="info">{group.items.length} quyền</StatusBadge>
                </div>
                <ul className="space-y-2">
                  {group.items.map((item) => (
                    <li
                      key={item.key}
                      className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {item.capabilityLabel}
                          </span>
                          {item.retiredCompat ? (
                            <StatusBadge tone="neutral">Tương thích cũ</StatusBadge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted">{item.sourceLabel}</p>
                      </div>
                      <StatusBadge tone={item.scopeKind === "ALL" ? "primary" : "info"}>
                        {item.scopeText}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
