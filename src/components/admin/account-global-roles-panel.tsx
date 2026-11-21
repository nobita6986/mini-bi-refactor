"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useAccountRolesController } from "@/components/admin/account-roles-embedded-section";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
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
import { StatusBanner } from "@/components/ui/status-banner";
import {
  DEFAULT_ROLE_ACCESS_PAGE_SIZE,
  accountTypeBadgeMeta,
  buildAccountsSummaryUrlQuery,
  classifyRoleReadFailure,
  formatAccountDisplayIdentity,
  projectAccountAccessForTarget,
  projectAccountsSummaryForQuery,
  projectRolesCatalogEnvelope,
  resolveRoleCatalogFilters,
  type EnabledFilterOption,
  type RoleFilterOption,
  type RoleGateReason,
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

export type AccountGlobalRolesFixtureSnapshot = {
  catalog: RolesCatalogEnvelope;
  list: AccountsSummaryListResponse;
  detail: AccountAccessDetail | null;
  gateReason?: RoleGateReason | null;
};

export function AccountGlobalRolesPanel({
  canManageGlobalRoles,
  selectedAccountRef,
  onSelectedAccountRefChange,
  initialFixtureSnapshot,
}: {
  canManageGlobalRoles: boolean;
  selectedAccountRef: string | null;
  onSelectedAccountRefChange: (nextRef: string | null) => void;
  initialFixtureSnapshot?: AccountGlobalRolesFixtureSnapshot;
}) {
  const isFixturePreview = Boolean(initialFixtureSnapshot);
  const normalizedSelectedRef =
    selectedAccountRef && isUuid(selectedAccountRef)
      ? selectedAccountRef.toLowerCase()
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
  const [detailState, setDetailState] = useState<DetailLoadState>(() => {
    if (initialFixtureSnapshot?.detail) {
      return { kind: "ready", detail: initialFixtureSnapshot.detail };
    }
    if (initialFixtureSnapshot) return { kind: "idle" };
    return normalizedSelectedRef
      ? { kind: "loading", accountRef: normalizedSelectedRef }
      : { kind: "idle" };
  });

  const [gateState, setGateState] = useState<{
    reason: RoleGateReason;
    message: string;
  } | null>(() => {
    if (!initialFixtureSnapshot?.gateReason) return null;
    return {
      reason: initialFixtureSnapshot.gateReason,
      message:
        initialFixtureSnapshot.gateReason === "CUTOVER_NOT_READY"
          ? "Hệ thống phân quyền mới chưa mở cổng cutover trên cơ sở dữ liệu (AUTHZ_CUTOVER_NOT_READY). Chức năng cấp/thu hồi vai trò toàn cục đang tạm khóa."
          : "Cổng môi trường thay đổi vai trò toàn cục chưa kích hoạt (AUTHZ_ROLE_MUTATIONS_ENABLED=false).",
    };
  });

  const workspaceGuard = useWp4WorkspaceGuard();
  const mountedRef = useRef(true);
  const catalogSeqRef = useRef(0);
  const summarySeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);

  const onSelectedRefChangeRef = useRef(onSelectedAccountRefChange);
  const normalizedSelectedRefRef = useRef(normalizedSelectedRef);
  useEffect(() => {
    onSelectedRefChangeRef.current = onSelectedAccountRefChange;
  }, [onSelectedAccountRefChange]);
  useEffect(() => {
    normalizedSelectedRefRef.current = normalizedSelectedRef;
  }, [normalizedSelectedRef]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
    };
  }, []);

  const rolesControllerResetRef = useRef<() => void>(() => {});

  const handleSessionLost = useCallback(
    (message: string, unauthenticated: boolean) => {
      workspaceGuard.invalidateSession();
      catalogSeqRef.current += 1;
      summarySeqRef.current += 1;
      detailSeqRef.current += 1;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      rolesControllerResetRef.current();
      if (!mountedRef.current) return;
      setCatalogRoles([]);
      onSelectedRefChangeRef.current(null);
      setDetailState({ kind: "idle" });
      setSummaryState({ kind: "denied", message, unauthenticated });
    },
    [workspaceGuard],
  );

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
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== catalogSeqRef.current
        ) {
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== catalogSeqRef.current
        ) {
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
        // Fallback to contract catalog if optional metadata request fails.
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

  const fetchSummaryOnce = useCallback(
    async (
      expectedEpoch?: number,
    ): Promise<
      | { ok: true; list: AccountsSummaryListResponse }
      | { ok: false; sessionLost: boolean; stale: boolean }
    > => {
      const built = buildAccountsSummaryUrlQuery({
        search: appliedSearch,
        enabled: enabledFilter,
        roleCode: roleFilter,
        page,
        pageSize: DEFAULT_ROLE_ACCESS_PAGE_SIZE,
      });
      if (!built.ok) return { ok: false, sessionLost: false, stale: false };
      const activeEpoch = expectedEpoch ?? workspaceGuard.getEpoch();
      if (!mountedRef.current || !workspaceGuard.isActive(activeEpoch)) {
        return {
          ok: false,
          sessionLost: !workspaceGuard.isActive(activeEpoch),
          stale: true,
        };
      }
      const reqSeq = ++summarySeqRef.current;
      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch(`/api/admin/access/accounts-summary?${built.params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        });
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(activeEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== summarySeqRef.current
        ) {
          return {
            ok: false,
            sessionLost: !workspaceGuard.isActive(activeEpoch),
            stale: true,
          };
        }
        const payload: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(activeEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== summarySeqRef.current
        ) {
          return {
            ok: false,
            sessionLost: !workspaceGuard.isActive(activeEpoch),
            stale: true,
          };
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyRoleReadFailure(response.status, payload);
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return { ok: false, sessionLost: true, stale: true };
        }
        if (response.status !== 200) return { ok: false, sessionLost: false, stale: false };
        const list = projectAccountsSummaryForQuery(payload, built.query);
        if (!list) return { ok: false, sessionLost: false, stale: false };
        return { ok: true, list };
      } catch {
        const sessionInvalidated = !workspaceGuard.isActive(activeEpoch);
        const stale =
          !mountedRef.current ||
          !workspaceGuard.isActive(activeEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== summarySeqRef.current;
        return { ok: false, sessionLost: sessionInvalidated, stale };
      } finally {
        tracked.release();
      }
    },
    [appliedSearch, enabledFilter, handleSessionLost, page, roleFilter, workspaceGuard],
  );

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
        if (
          workspaceGuard.isActive(tracked.epoch, tracked.controller) &&
          reqSeq === summarySeqRef.current
        ) {
          setSummaryState({ kind: "error", message: built.message, retryable: false });
        }
        tracked.release();
        return;
      }

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== summarySeqRef.current
      ) {
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
          message: "Không thể kết nối tới máy chủ để tải danh sách tài khoản.",
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
          message: "Dữ liệu danh sách tài khoản trả về không đúng định dạng chuẩn.",
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
      if (!normalizedSelectedRefRef.current && list.accounts[0]) {
        onSelectedRefChangeRef.current(list.accounts[0].account_ref);
      }
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
    page,
    roleFilter,
    workspaceGuard,
  ]);

  const isSummaryDenied = summaryState.kind === "denied";

  useEffect(() => {
    if (isFixturePreview) return;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;

    const reqSeq = ++detailSeqRef.current;
    const tracked = workspaceGuard.trackController();
    detailAbortRef.current = tracked.controller;

    void (async () => {
      if (!normalizedSelectedRef || isSummaryDenied) {
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

      const targetRef = normalizedSelectedRef;
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
          message: "Không thể kết nối tới máy chủ để tải thông tin vai trò của tài khoản.",
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
          message: "Chi tiết tài khoản trả về không khớp định dạng chuẩn.",
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
    normalizedSelectedRef,
    workspaceGuard,
  ]);

  const reloadAccountAndSummaryAuthoritative = useCallback(
    async (
      targetRef: string,
      callerEpoch?: number,
    ): Promise<
      | { ok: true; detail: AccountAccessDetail }
      | { ok: false; sessionLost: boolean; stale: boolean }
    > => {
      const startEpoch = callerEpoch ?? workspaceGuard.getEpoch();
      if (!mountedRef.current || !workspaceGuard.isActive(startEpoch)) {
        return { ok: false, sessionLost: !workspaceGuard.isActive(startEpoch), stale: true };
      }
      const reqSeq = ++detailSeqRef.current;
      const tracked = workspaceGuard.trackController();
      try {
        const response = await fetch(
          `/api/admin/access/accounts/${encodeURIComponent(targetRef)}/access`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(startEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current
        ) {
          return { ok: false, sessionLost: !workspaceGuard.isActive(startEpoch), stale: true };
        }
        const payload: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(startEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current
        ) {
          return { ok: false, sessionLost: !workspaceGuard.isActive(startEpoch), stale: true };
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyRoleReadFailure(response.status, payload);
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return { ok: false, sessionLost: true, stale: true };
        }
        if (response.status !== 200) {
          return { ok: false, sessionLost: false, stale: false };
        }
        const detail = projectAccountAccessForTarget(payload, targetRef);
        if (!detail) return { ok: false, sessionLost: false, stale: false };

        const summaryRes = await fetchSummaryOnce(startEpoch);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(startEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current
        ) {
          return { ok: false, sessionLost: !workspaceGuard.isActive(startEpoch), stale: true };
        }
        if (!summaryRes.ok) {
          if (summaryRes.sessionLost || summaryRes.stale) {
            return {
              ok: false,
              sessionLost: summaryRes.sessionLost || !workspaceGuard.isActive(startEpoch),
              stale: true,
            };
          }
          setDetailState({ kind: "ready", detail });
          return { ok: false, sessionLost: false, stale: false };
        }
        setDetailState({ kind: "ready", detail });
        setSummaryState({ kind: "ready", list: summaryRes.list });
        return { ok: true, detail };
      } catch {
        const sessionInvalidated = !workspaceGuard.isActive(startEpoch);
        const stale =
          !mountedRef.current ||
          !workspaceGuard.isActive(startEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current;
        return { ok: false, sessionLost: sessionInvalidated, stale };
      } finally {
        tracked.release();
      }
    },
    [fetchSummaryOnce, handleSessionLost, workspaceGuard],
  );

  const rolesController = useAccountRolesController({
    accountRef: normalizedSelectedRef,
    canManageGlobalRoles,
    workspaceGuard,
    catalogRoles,
    controlledDetail: {
      kind: detailState.kind,
      detail: detailState.kind === "ready" ? detailState.detail : null,
      errorMessage: detailState.kind === "error" ? detailState.message : undefined,
      retryable: detailState.kind === "error" ? detailState.retryable : undefined,
      onRetry: () => setDetailReloadToken((t) => t + 1),
    },
    onReloadAuthoritative: reloadAccountAndSummaryAuthoritative,
    gateState,
    onGateStateChange: setGateState,
    onSessionLost: handleSessionLost,
  });
  useEffect(() => {
    rolesControllerResetRef.current = rolesController.resetOnSessionLoss;
  }, [rolesController.resetOnSessionLoss]);
  const switchAccountDisabled = rolesController.isDialogLocked;

  const roleFilterGroups = useMemo(
    () => resolveRoleCatalogFilters(catalogRoles),
    [catalogRoles],
  );

  const summaryList = summaryState.kind === "ready" ? summaryState.list : null;
  const pageCount = summaryList
    ? Math.min(1000, Math.max(1, Math.ceil(summaryList.total / Math.max(1, summaryList.page_size))))
    : 1;

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

  return (
    <div data-testid="account-global-roles-panel" className="space-y-4">
      {!canManageGlobalRoles ? (
        <StatusBanner
          tone="warning"
          title="Phiên hiện tại không có thẩm quyền thay đổi vai trò toàn cục"
          dataTestId="global-roles-authority-warning"
        >
          <p>
            Quyền gán và thu hồi vai trò toàn cục yêu cầu đầy đủ bộ quyền Full Admin (BoD/Admin) do phiên máy chủ xác nhận. Các nút thao tác ghi đã được khóa.
          </p>
        </StatusBanner>
      ) : null}

      {gateState ? (
        <StatusBanner
          tone="warning"
          title="Tính năng thay đổi vai trò toàn cục chưa mở trong chặng triển khai này"
          dataTestId="global-roles-rollout-gate-banner"
        >
          <p>{gateState.message}</p>
        </StatusBanner>
      ) : null}

      {summaryState.kind === "denied" ? (
        <div className="space-y-3">
          <ErrorState
            title={
              summaryState.unauthenticated
                ? "Phiên đăng nhập đã hết hiệu lực"
                : "Không có quyền truy cập quản trị vai trò toàn cục"
            }
            detail={summaryState.message}
          />
          {summaryState.unauthenticated ? (
            <Link
              href="/login?next=/admin/access/accounts"
              className={buttonClasses({ variant: "primary", size: "md" })}
            >
              Đăng nhập lại
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <FilterToolbar
            summary={
              summaryList ? (
                <span>
                  {summaryList.total} tài khoản · Chọn tài khoản để xem và quản trị 4 vai trò toàn cục (gồm <strong>BoD/Admin</strong>).
                </span>
              ) : (
                <span>Đang chuẩn bị danh sách tài khoản…</span>
              )
            }
          >
            <form
              className="grid grid-cols-1 min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto]"
              onSubmit={handleFilterSubmit}
            >
              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="gr-search-input">Tìm tài khoản</label>
                <input
                  id="gr-search-input"
                  type="search"
                  value={searchInput}
                  maxLength={256}
                  placeholder="Tên hiển thị hoặc mã đăng nhập…"
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="gr-enabled-select">Trạng thái hoạt động</label>
                <select
                  id="gr-enabled-select"
                  value={enabledFilter}
                  onChange={(event) => {
                    setEnabledFilter(event.target.value as EnabledFilterOption);
                    setPage(1);
                  }}
                  className="min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value="all">Tất cả trạng thái</option>
                  <option value="true">Đang hoạt động</option>
                  <option value="false">Ngừng hoạt động</option>
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm font-medium text-foreground">
                <label htmlFor="gr-role-select">Vai trò đang giữ</label>
                <select
                  id="gr-role-select"
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
                  <optgroup label="Vai trò ngữ cảnh (chỉ lọc xem)">
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
                  Tìm tài khoản
                </Button>
              </div>
            </form>
          </FilterToolbar>

          <div className="grid grid-cols-1 min-w-0 gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.3fr)] xl:items-start">
            <Card className="min-w-0">
              <CardHeader
                title="Chọn tài khoản"
                description="Chọn tài khoản từ danh sách; không cần nhập UUID thủ công."
              />

              {summaryState.kind === "loading" ? (
                <p role="status" className="py-8 text-center text-sm text-muted">
                  Đang tải danh sách tài khoản…
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
                      onClick={() => setListReloadToken((t) => t + 1)}
                    >
                      Thử tải lại
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {summaryList ? (
                summaryList.accounts.length === 0 ? (
                  <EmptyState
                    title="Chưa có tài khoản phù hợp"
                    description="Thay đổi bộ lọc tìm kiếm để tìm tài khoản cần phân quyền."
                  />
                ) : (
                  <DataTableContainer
                    footer={
                      <OffsetPager
                        page={page}
                        pageCount={pageCount}
                        total={summaryList.total}
                        disabled={switchAccountDisabled}
                        ariaLabel="Phân trang danh sách chọn tài khoản"
                        onPageChange={(nextPage) => setPage(nextPage)}
                      />
                    }
                  >
                    <div
                      role="region"
                      tabIndex={0}
                      aria-labelledby="gr-account-picker-caption"
                      className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <table className={DATA_TABLE_CLASS}>
                        <caption id="gr-account-picker-caption" className="sr-only">
                          Danh sách tài khoản để quản lý vai trò toàn cục
                        </caption>
                        <thead className={DATA_TABLE_HEAD_CLASS}>
                          <tr>
                            <th scope="col" className={DATA_TABLE_TH_CLASS}>
                              Tài khoản
                            </th>
                            <th scope="col" className={DATA_TABLE_TH_CLASS}>
                              Vai trò toàn cục
                            </th>
                            <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                              Chọn
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {summaryList.accounts.map((account) => {
                            const identity = formatAccountDisplayIdentity(account);
                            const isSelected = normalizedSelectedRef === account.account_ref;
                            return (
                              <tr
                                key={account.account_ref}
                                className={`${DATA_TABLE_ROW_CLASS} ${
                                  isSelected ? "bg-primary/5" : ""
                                }`}
                              >
                                <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                                  <div className="space-y-0.5">
                                    <span className="block font-medium text-foreground">
                                      {identity.primary}
                                    </span>
                                    {identity.secondary ? (
                                      <span className="block text-xs text-muted">
                                        {identity.secondary}
                                      </span>
                                    ) : null}
                                    <div className="pt-0.5 flex flex-wrap gap-1">
                                      <StatusBadge tone={account.enabled ? "success" : "danger"} dot>
                                        {account.enabled ? "Hoạt động" : "Đang khóa"}
                                      </StatusBadge>
                                      <StatusBadge tone={accountTypeBadgeMeta(account.account_type).tone}>
                                        {accountTypeBadgeMeta(account.account_type).label}
                                      </StatusBadge>
                                    </div>
                                  </div>
                                </td>

                                <td data-label="Vai trò toàn cục" className={DATA_TABLE_TD_CLASS}>
                                  <div className="flex flex-wrap gap-1">
                                    {account.global_roles.length === 0 ? (
                                      <span className="text-xs text-muted">Chưa gán</span>
                                    ) : (
                                      account.global_roles.map((role) => (
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
                                      ))
                                    )}
                                  </div>
                                </td>

                                <td data-card-actions="true" className={`${DATA_TABLE_TD_CLASS} text-right`}>
                                  <div>
                                    <Button
                                      variant={isSelected ? "primary" : "secondary"}
                                      size="sm"
                                      disabled={switchAccountDisabled}
                                      aria-pressed={isSelected}
                                      aria-label={`Chọn tài khoản ${identity.primary} để quản lý vai trò toàn cục`}
                                      onClick={() => onSelectedAccountRefChange(account.account_ref)}
                                    >
                                      {isSelected ? "Đang chọn" : "Quản lý vai trò"}
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

            <section className="min-w-0" aria-label="Vai trò toàn cục của tài khoản đang chọn">
              {rolesController.renderDetailCard()}
            </section>
          </div>
        </>
      )}

      {rolesController.renderMutationDialog()}
    </div>
  );
}
