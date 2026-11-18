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
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  DEFAULT_ROLE_ACCESS_PAGE_SIZE,
  ROLE_REASON_MAX_LENGTH,
  ROLE_REASON_MIN_LENGTH,
  accountTypeBadgeMeta,
  buildAccountsSummaryUrlQuery,
  buildAssignGlobalRoleRequest,
  buildRevokeGlobalRoleRequest,
  canAssignNewGlobalRoleToAccount,
  classifyRoleMutationResponse,
  classifyRoleReadFailure,
  describeCannotRevokeReason,
  describeInactiveOrBlockingReason,
  formatAccountDisplayIdentity,
  formatAuthzTimestampVi,
  formatRoleSourceKind,
  isStaleMutationReplay,
  newRoleMutationIdempotencyKey,
  projectAccountAccessForTarget,
  projectAccountsSummaryForQuery,
  projectRolesCatalogEnvelope,
  resolveAssignableGlobalRoles,
  resolveRoleCatalogFilters,
  splitOpenAndEndedGlobalRoles,
  type EnabledFilterOption,
  type RoleFilterOption,
  type RoleGateReason,
} from "@/lib/admin/role-effective-access-model";
import type {
  AccountAccessDetail,
  AccountsSummaryListResponse,
  AssignedGlobalRoleItem,
  AssignGlobalRoleInput,
  GlobalRoleCode,
  RevokeGlobalRoleInput,
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

type RoleDialogState =
  | {
      kind: "assign";
      accountRef: string;
      accountName: string;
      snapshotVersion: number;
      assignedRoleCodes: readonly GlobalRoleCode[];
    }
  | {
      kind: "revoke";
      accountRef: string;
      accountName: string;
      snapshotVersion: number;
      assignment: AssignedGlobalRoleItem;
    };

type PendingRoleMutation = {
  op: "assign" | "revoke";
  url: string;
  method: "POST" | "DELETE";
  idempotencyKey: string;
  body: AssignGlobalRoleInput | RevokeGlobalRoleInput;
  roleCode?: GlobalRoleCode;
  assignmentId?: string;
  snapshotVersion: number;
  successMessage: string;
  uncertain: boolean;
};

type DialogFeedback = {
  tone: "error" | "warning" | "info";
  title: string;
  message: string;
  needsReload: boolean;
} | null;

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
  const notify = useNotify();
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

  const [dialog, setDialog] = useState<RoleDialogState | null>(null);
  const [assignRoleCode, setAssignRoleCode] = useState<GlobalRoleCode | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [gateLockedInDialog, setGateLockedInDialog] = useState(false);
  const [postApplyNeedsReload, setPostApplyNeedsReload] = useState(false);
  const [staleReplayLocked, setStaleReplayLocked] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<PendingRoleMutation | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  const workspaceGuard = useWp4WorkspaceGuard();
  const mountedRef = useRef(true);
  const mutationInFlightRef = useRef(false);
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
      mutationInFlightRef.current = false;
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
      mutationInFlightRef.current = false;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      if (!mountedRef.current) return;
      setCatalogRoles([]);
      setDialog(null);
      setPendingMutation(null);
      setFeedback(null);
      setConflictLocked(false);
      setGateLockedInDialog(false);
      setPostApplyNeedsReload(false);
      setStaleReplayLocked(false);
      setBusy(false);
      setReconciling(false);
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

  const fetchSummaryOnce = useCallback(async (): Promise<
    | { ok: true; list: AccountsSummaryListResponse }
    | { ok: false; sessionLost: boolean }
  > => {
    const built = buildAccountsSummaryUrlQuery({
      search: appliedSearch,
      enabled: enabledFilter,
      roleCode: roleFilter,
      page,
      pageSize: DEFAULT_ROLE_ACCESS_PAGE_SIZE,
    });
    if (!built.ok) return { ok: false, sessionLost: false };
    const reqSeq = ++summarySeqRef.current;
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(`/api/admin/access/accounts-summary?${built.params.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== summarySeqRef.current) {
        return { ok: false, sessionLost: false };
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== summarySeqRef.current) {
        return { ok: false, sessionLost: false };
      }
      if (response.status === 401 || response.status === 403) {
        const failure = classifyRoleReadFailure(response.status, payload);
        handleSessionLost(failure.message, failure.kind === "unauthenticated");
        return { ok: false, sessionLost: true };
      }
      if (response.status !== 200) return { ok: false, sessionLost: false };
      const list = projectAccountsSummaryForQuery(payload, built.query);
      if (!list) return { ok: false, sessionLost: false };
      return { ok: true, list };
    } catch {
      return { ok: false, sessionLost: false };
    } finally {
      tracked.release();
    }
  }, [appliedSearch, enabledFilter, handleSessionLost, page, roleFilter, workspaceGuard]);

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
    ): Promise<
      { ok: true; detail: AccountAccessDetail } | { ok: false; sessionLost: boolean }
    > => {
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
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== detailSeqRef.current) {
          return { ok: false, sessionLost: false };
        }
        const payload: unknown = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== detailSeqRef.current) {
          return { ok: false, sessionLost: false };
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyRoleReadFailure(response.status, payload);
          handleSessionLost(failure.message, failure.kind === "unauthenticated");
          return { ok: false, sessionLost: true };
        }
        if (response.status !== 200) {
          return { ok: false, sessionLost: false };
        }
        const detail = projectAccountAccessForTarget(payload, targetRef);
        if (!detail) return { ok: false, sessionLost: false };
        if (mountedRef.current) {
          setDetailState({ kind: "ready", detail });
        }
        const summaryRes = await fetchSummaryOnce();
        if (!summaryRes.ok && summaryRes.sessionLost) {
          return { ok: false, sessionLost: true };
        }
        if (summaryRes.ok && mountedRef.current) {
          setSummaryState({ kind: "ready", list: summaryRes.list });
        }
        return { ok: true, detail };
      } catch {
        return { ok: false, sessionLost: false };
      } finally {
        tracked.release();
      }
    },
    [fetchSummaryOnce, handleSessionLost, workspaceGuard],
  );

  const assignableGlobalRoles = useMemo(
    () => resolveAssignableGlobalRoles(catalogRoles),
    [catalogRoles],
  );
  const roleFilterGroups = useMemo(
    () => resolveRoleCatalogFilters(catalogRoles),
    [catalogRoles],
  );

  const isUncertainLocked = pendingMutation?.uncertain === true;
  const isDialogCloseDisabled = busy || reconciling || isUncertainLocked;
  const areFieldsLocked =
    busy ||
    reconciling ||
    isUncertainLocked ||
    conflictLocked ||
    gateLockedInDialog ||
    postApplyNeedsReload ||
    staleReplayLocked;

  const resetAndCloseDialog = useCallback(() => {
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setStaleReplayLocked(false);
    setReason("");
    setDialog(null);
  }, []);

  const openAssignDialog = (detail: AccountAccessDetail) => {
    if (busy || reconciling || isUncertainLocked) return;
    const { activeAssigned } = splitOpenAndEndedGlobalRoles(detail.assigned_global_roles);
    const assignedCodes = activeAssigned.map((item) => item.role_code);
    const nextDefault =
      assignableGlobalRoles.find((item) => !assignedCodes.includes(item.role_code as GlobalRoleCode))
        ?.role_code ?? "";
    const identity = formatAccountDisplayIdentity(detail.account);
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setStaleReplayLocked(false);
    setReason("");
    setAssignRoleCode(nextDefault as GlobalRoleCode | "");
    setDialog({
      kind: "assign",
      accountRef: detail.account.account_ref,
      accountName: identity.primary,
      snapshotVersion: detail.account.version,
      assignedRoleCodes: assignedCodes,
    });
  };

  const openRevokeDialog = (detail: AccountAccessDetail, assignment: AssignedGlobalRoleItem) => {
    if (busy || reconciling || isUncertainLocked) return;
    if (assignment.is_protected || !assignment.can_revoke || assignment.ended_at !== null) return;
    const identity = formatAccountDisplayIdentity(detail.account);
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setStaleReplayLocked(false);
    setReason("");
    setDialog({
      kind: "revoke",
      accountRef: detail.account.account_ref,
      accountName: identity.primary,
      snapshotVersion: detail.account.version,
      assignment,
    });
  };

  const handleReconcileReload = async () => {
    if (!dialog || busy || reconciling) return;
    setReconciling(true);
    try {
      const result = await reloadAccountAndSummaryAuthoritative(dialog.accountRef);
      if (!mountedRef.current || (!result.ok && result.sessionLost)) return;
      if (!result.ok) {
        setFeedback((prev) => ({
          tone: "warning",
          title: isUncertainLocked
            ? "Chưa thể đối chiếu trạng thái yêu cầu"
            : "Chưa tải lại được dữ liệu mới nhất",
          message: isUncertainLocked
            ? "Không thể tải dữ liệu đối chiếu lúc này. Nội dung và khóa gửi trùng vẫn được giữ nguyên."
            : prev?.message ??
              "Không thể tải dữ liệu mới nhất lúc này. Biểu mẫu vẫn đang khóa để tránh ghi đè.",
          needsReload: true,
        }));
        return;
      }

      const freshDetail = result.detail;
      const freshIdentity = formatAccountDisplayIdentity(freshDetail.account);
      const { activeAssigned } = splitOpenAndEndedGlobalRoles(freshDetail.assigned_global_roles);

      const alreadyCompletedOnServer =
        dialog.kind === "assign" && pendingMutation?.roleCode
          ? activeAssigned.some((role) => role.role_code === pendingMutation.roleCode)
          : dialog.kind === "revoke"
            ? freshDetail.assigned_global_roles.some(
                (role) =>
                  role.assignment_id === dialog.assignment.assignment_id &&
                  role.ended_at !== null,
              )
            : false;

      if (staleReplayLocked) {
        resetAndCloseDialog();
        notify.info({
          title: "Đã tải lại dữ liệu mới nhất để đối chiếu.",
        });
        return;
      }

      if (postApplyNeedsReload || (isUncertainLocked && alreadyCompletedOnServer)) {
        resetAndCloseDialog();
        notify.success({
          title:
            pendingMutation?.successMessage ??
            "Đã đối chiếu: thay đổi vai trò đã được ghi nhận trên máy chủ.",
        });
        return;
      }

      setPendingMutation(null);
      setConflictLocked(false);
      setPostApplyNeedsReload(false);
      setStaleReplayLocked(false);
      setGateLockedInDialog(false);

      if (dialog.kind === "assign") {
        const assignedCodes = activeAssigned.map((item) => item.role_code);
        setDialog({
          kind: "assign",
          accountRef: freshDetail.account.account_ref,
          accountName: freshIdentity.primary,
          snapshotVersion: freshDetail.account.version,
          assignedRoleCodes: assignedCodes,
        });
        if (!freshDetail.account.enabled || freshDetail.account.account_type !== "NORMAL") {
          setConflictLocked(true);
          setFeedback({
            tone: "warning",
            title: "Tài khoản không đủ điều kiện cấp vai trò",
            message: !freshDetail.account.enabled
              ? "Tài khoản hiện đang bị khóa. Không thể cấp thêm vai trò; vui lòng đóng hộp thoại."
              : "Chỉ tài khoản loại Thường (NORMAL) mới được cấp thêm vai trò toàn cục.",
            needsReload: false,
          });
        } else if (assignRoleCode && assignedCodes.includes(assignRoleCode)) {
          setFeedback({
            tone: "info",
            title: "Đã cập nhật bản mới nhất",
            message: "Vai trò vừa chọn đã tồn tại trên tài khoản sau khi đối chiếu.",
            needsReload: false,
          });
        } else {
          setFeedback({
            tone: "info",
            title: "Đã tải dữ liệu mới nhất",
            message:
              "Phiên bản tài khoản đã được cập nhật. Vui lòng kiểm tra lại nội dung trước khi xác nhận gửi.",
            needsReload: false,
          });
        }
      } else {
        const updatedAssignment = freshDetail.assigned_global_roles.find(
          (role) => role.assignment_id === dialog.assignment.assignment_id,
        );
        if (!updatedAssignment || updatedAssignment.ended_at !== null) {
          resetAndCloseDialog();
          notify.info({
            title: "Đã đối chiếu: phân công vai trò này đã kết thúc trên máy chủ.",
          });
          return;
        }
        setDialog({
          kind: "revoke",
          accountRef: freshDetail.account.account_ref,
          accountName: freshIdentity.primary,
          snapshotVersion: freshDetail.account.version,
          assignment: updatedAssignment,
        });
        if (updatedAssignment.is_protected || !updatedAssignment.can_revoke) {
          setConflictLocked(true);
          setFeedback({
            tone: "warning",
            title: "Phân công này đang được bảo vệ",
            message:
              describeCannotRevokeReason(updatedAssignment.cannot_revoke_reason) ??
              "Máy chủ không cho phép thu hồi phân công vai trò này.",
            needsReload: false,
          });
        } else {
          setFeedback({
            tone: "info",
            title: "Đã tải dữ liệu mới nhất",
            message:
              "Phiên bản tài khoản đã được cập nhật. Vui lòng kiểm tra lại trước khi xác nhận thu hồi.",
            needsReload: false,
          });
        }
      }
    } finally {
      if (mountedRef.current) {
        setReconciling(false);
      }
    }
  };

  const executeMutation = async (intent: PendingRoleMutation) => {
    if (!dialog) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setFeedback(null);

    const targetAccountRef = dialog.accountRef;
    const currentKnownVersion =
      detailState.kind === "ready" && detailState.detail.account.account_ref === targetAccountRef
        ? detailState.detail.account.version
        : intent.snapshotVersion;

    const tracked = workspaceGuard.trackController();
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || !mountedRef.current) {
          return;
        }
        setPendingMutation({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          title: "Mất phản hồi từ máy chủ",
          message:
            "Không nhận được xác nhận sau khi gửi. Nội dung thao tác và khóa gửi trùng được giữ nguyên để thử gửi lại hoặc tải lại đối chiếu.",
          needsReload: true,
        });
        return;
      }

      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || !mountedRef.current) {
        return;
      }

      const rawJson: unknown = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || !mountedRef.current) {
        return;
      }

      const outcome = classifyRoleMutationResponse(response.status, rawJson, targetAccountRef);

      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, outcome.unauthenticated);
        return;
      }

      if (outcome.kind === "csrf-rejected") {
        setPendingMutation(null);
        setGateLockedInDialog(true);
        setFeedback({
          tone: "error",
          title: "Yêu cầu bị từ chối kiểm tra an toàn",
          message: outcome.message,
          needsReload: false,
        });
        return;
      }

      if (outcome.kind === "gate-closed") {
        setPendingMutation(null);
        setGateState({ reason: outcome.gateReason, message: outcome.message });
        setGateLockedInDialog(true);
        setFeedback({
          tone: "warning",
          title: "Chức năng cấp/thu hồi vai trò chưa mở",
          message: outcome.message,
          needsReload: false,
        });
        return;
      }

      if (outcome.kind === "protected-assignment") {
        setPendingMutation(null);
        setGateLockedInDialog(true);
        setFeedback({
          tone: "error",
          title: "Phân công Owner được bảo vệ cố định",
          message: outcome.message,
          needsReload: true,
        });
        return;
      }

      if (outcome.kind === "uncertain") {
        setPendingMutation({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          title: "Kết quả thay đổi chưa được xác nhận",
          message: outcome.message,
          needsReload: true,
        });
        return;
      }

      if (outcome.kind === "version-conflict") {
        setPendingMutation(null);
        setConflictLocked(true);
        setFeedback({
          tone: "warning",
          title: "Xung đột phiên bản dữ liệu (OCC)",
          message: outcome.message,
          needsReload: true,
        });
        return;
      }

      if (outcome.kind === "not-found" || outcome.kind === "business-conflict") {
        setPendingMutation(null);
        if (outcome.mustReloadAccount) {
          setConflictLocked(true);
        }
        setFeedback({
          tone: outcome.mustReloadAccount ? "warning" : "error",
          title: "Không thể hoàn tất thao tác",
          message: outcome.message,
          needsReload: outcome.mustReloadAccount,
        });
        return;
      }

      if (outcome.kind === "validation-error") {
        setPendingMutation(null);
        setFeedback({
          tone: "error",
          title: "Dữ liệu gửi lên chưa hợp lệ",
          message: outcome.message,
          needsReload: false,
        });
        return;
      }

      // Applied (200 / 201): reject stale replays that carry older account_version than current UI state.
      if (isStaleMutationReplay(outcome.result.account_version, currentKnownVersion)) {
        setPendingMutation(null);
        setConflictLocked(true);
        setStaleReplayLocked(true);
        setFeedback({
          tone: "warning",
          title: "Phát hiện phản hồi thuộc phiên bản cũ hơn hiện tại",
          message:
            "Không ghi đè trạng thái mới bằng phản hồi cũ. Vui lòng tải lại đối chiếu dữ liệu mới nhất.",
          needsReload: true,
        });
        return;
      }

      const reloadResult = await reloadAccountAndSummaryAuthoritative(targetAccountRef);
      if (!mountedRef.current || (!reloadResult.ok && reloadResult.sessionLost)) return;

      if (!reloadResult.ok) {
        setPendingMutation(null);
        setConflictLocked(true);
        setPostApplyNeedsReload(true);
        setFeedback({
          tone: "warning",
          title: "Đã ghi nhận thao tác nhưng chưa tải được dữ liệu mới nhất",
          message:
            "Vui lòng bấm Tải lại đối chiếu để đồng bộ danh sách và quyền hiệu lực mới nhất từ máy chủ.",
          needsReload: true,
        });
        return;
      }

      resetAndCloseDialog();
      notify.success({
        title: outcome.replayed
          ? `${intent.successMessage} (Đã đối chiếu yêu cầu trùng khớp an toàn)`
          : intent.successMessage,
      });
    } finally {
      tracked.release();
      mutationInFlightRef.current = false;
      if (workspaceGuard.isActive(tracked.epoch) && mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleDialogSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutationInFlightRef.current || busy || reconciling) return;
    if (
      !dialog ||
      !canManageGlobalRoles ||
      gateState !== null ||
      gateLockedInDialog ||
      postApplyNeedsReload ||
      staleReplayLocked
    ) {
      return;
    }

    if (pendingMutation?.uncertain) {
      void executeMutation(pendingMutation);
      return;
    }

    if (conflictLocked) return;

    const idempotencyKey = pendingMutation?.idempotencyKey ?? newRoleMutationIdempotencyKey();

    if (dialog.kind === "assign") {
      if (dialog.assignedRoleCodes.includes(assignRoleCode as GlobalRoleCode)) {
        setFeedback({
          tone: "error",
          title: "Vai trò đã tồn tại",
          message: "Tài khoản này đã được gán vai trò vừa chọn.",
          needsReload: false,
        });
        return;
      }
      const built = buildAssignGlobalRoleRequest({
        roleCode: assignRoleCode,
        expectedVersion: dialog.snapshotVersion,
        reason,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({
          tone: "error",
          title: "Thông tin chưa hợp lệ",
          message: built.message,
          needsReload: false,
        });
        return;
      }
      const roleMeta = assignableGlobalRoles.find((r) => r.role_code === built.body.role_code);
      const roleLabel = roleMeta?.display_name ?? built.body.role_code;
      const intent: PendingRoleMutation = {
        op: "assign",
        url: `/api/admin/access/accounts/${encodeURIComponent(dialog.accountRef)}/roles`,
        method: "POST",
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        roleCode: built.body.role_code,
        snapshotVersion: dialog.snapshotVersion,
        successMessage: `Đã gán vai trò ${roleLabel} cho tài khoản ${dialog.accountName}.`,
        uncertain: false,
      };
      setPendingMutation(intent);
      void executeMutation(intent);
      return;
    }

    const built = buildRevokeGlobalRoleRequest({
      expectedVersion: dialog.snapshotVersion,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({
        tone: "error",
        title: "Thông tin chưa hợp lệ",
        message: built.message,
        needsReload: false,
      });
      return;
    }
    const intent: PendingRoleMutation = {
      op: "revoke",
      url: `/api/admin/access/accounts/${encodeURIComponent(dialog.accountRef)}/roles/${encodeURIComponent(dialog.assignment.assignment_id)}`,
      method: "DELETE",
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      assignmentId: dialog.assignment.assignment_id,
      snapshotVersion: dialog.snapshotVersion,
      successMessage: `Đã thu hồi vai trò ${dialog.assignment.display_name} khỏi tài khoản ${dialog.accountName}.`,
      uncertain: false,
    };
    setPendingMutation(intent);
    void executeMutation(intent);
  };

  const summaryList = summaryState.kind === "ready" ? summaryState.list : null;
  const pageCount = summaryList
    ? Math.min(1000, Math.max(1, Math.ceil(summaryList.total / Math.max(1, summaryList.page_size))))
    : 1;
  const switchAccountDisabled = busy || reconciling || isUncertainLocked;

  const selectedAssignRoleMeta =
    dialog?.kind === "assign" && assignRoleCode
      ? assignableGlobalRoles.find((r) => r.role_code === assignRoleCode) ?? null
      : null;

  const detail = detailState.kind === "ready" ? detailState.detail : null;
  const { activeAssigned, endedHistory } = detail
    ? splitOpenAndEndedGlobalRoles(detail.assigned_global_roles)
    : { activeAssigned: [], endedHistory: [] };
  const assignEligibility = detail
    ? canAssignNewGlobalRoleToAccount(detail.account, canManageGlobalRoles, gateState !== null)
    : { allowed: false, reason: null };

  const activeAssignedCodes = activeAssigned.map((role) => role.role_code);
  const allFourGlobalRolesAssigned = assignableGlobalRoles.every((role) =>
    activeAssignedCodes.includes(role.role_code as GlobalRoleCode),
  );

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
              {detailState.kind === "idle" ? (
                <Card>
                  <EmptyState
                    title="Chưa chọn tài khoản"
                    description="Chọn một tài khoản ở bảng bên cạnh để xem, cấp hoặc thu hồi vai trò toàn cục."
                  />
                </Card>
              ) : null}

              {detailState.kind === "loading" ? (
                <Card>
                  <p role="status" className="py-10 text-center text-sm text-muted">
                    Đang tải danh sách vai trò toàn cục của tài khoản…
                  </p>
                </Card>
              ) : null}

              {detailState.kind === "error" ? (
                <Card>
                  <div className="space-y-3">
                    <ErrorState
                      title="Không tải được chi tiết vai trò tài khoản"
                      detail={detailState.message}
                    />
                    {detailState.retryable ? (
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={() => setDetailReloadToken((t) => t + 1)}
                      >
                        Thử tải lại
                      </Button>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              {detail ? (
                <Card>
                  <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold text-foreground">
                          {formatAccountDisplayIdentity(detail.account).primary}
                        </h2>
                        <StatusBadge tone={accountTypeBadgeMeta(detail.account.account_type).tone}>
                          {accountTypeBadgeMeta(detail.account.account_type).label}
                        </StatusBadge>
                        <StatusBadge tone={detail.account.enabled ? "success" : "danger"} dot>
                          {detail.account.enabled ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </div>
                      {formatAccountDisplayIdentity(detail.account).secondary ? (
                        <p className="text-xs text-muted">
                          Mã đăng nhập: {formatAccountDisplayIdentity(detail.account).secondary}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted">
                        Chỉ gán được 4 vai trò toàn cục (gồm <strong>BoD/Admin</strong> áp dụng đồng nhất cho mọi thành viên). Vai trò theo ngữ cảnh (TL, Trưởng phòng, PM, Kế toán dự án) chỉ xem ở màn Quyền hiệu lực.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Link
                        href={`/admin/access/effective?account=${encodeURIComponent(detail.account.account_ref)}`}
                        className={buttonClasses({ variant: "secondary", size: "sm" })}
                      >
                        Xem quyền hiệu lực
                      </Link>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!assignEligibility.allowed || allFourGlobalRolesAssigned || switchAccountDisabled}
                        onClick={() => openAssignDialog(detail)}
                      >
                        Cấp vai trò toàn cục
                      </Button>
                    </div>
                  </div>

                  {!detail.account.enabled ? (
                    <div className="mt-3">
                      <Alert
                        tone="warning"
                        role="status"
                        title="Tài khoản đang bị khóa (0 quyền hiệu lực)"
                      >
                        <p>
                          Tài khoản ngừng hoạt động vẫn giữ các vai trò đã gán (không có hiệu lực thực thi) và không thể cấp vai trò mới. Các vai trò không được bảo vệ vẫn thu hồi được bình thường.
                        </p>
                      </Alert>
                    </div>
                  ) : null}

                  {assignEligibility.reason && detail.account.enabled ? (
                    <div className="mt-3">
                      <StatusBanner tone="info">{assignEligibility.reason}</StatusBanner>
                    </div>
                  ) : null}

                  <div className="mt-4">
                    {activeAssigned.length === 0 ? (
                      <EmptyState
                        title="Chưa gán vai trò toàn cục"
                        description="Tài khoản chưa có bản ghi phân công vai trò toàn cục nào đang mở."
                      />
                    ) : (
                      <DataTableContainer>
                        <div
                          role="region"
                          tabIndex={0}
                          aria-labelledby="gr-assigned-roles-caption"
                          className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        >
                          <table className={DATA_TABLE_CLASS}>
                            <caption id="gr-assigned-roles-caption" className="sr-only">
                              Danh sách vai trò toàn cục đang gán cho tài khoản
                            </caption>
                            <thead className={DATA_TABLE_HEAD_CLASS}>
                              <tr>
                                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                                  Vai trò
                                </th>
                                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                                  Hiệu lực & Bảo vệ
                                </th>
                                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                                  Nguồn & Lý do
                                </th>
                                <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                                  Thao tác
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {activeAssigned.map((role) => {
                                const protectedReasonText = describeCannotRevokeReason(
                                  role.cannot_revoke_reason,
                                );
                                return (
                                  <tr key={role.assignment_id} className={DATA_TABLE_ROW_CLASS}>
                                    <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                                      <div className="space-y-1">
                                        <span className="block font-medium text-foreground">
                                          {role.display_name}
                                        </span>
                                        <span className="block text-xs text-muted">
                                          Gán lúc {formatAuthzTimestampVi(role.started_at)}
                                          {role.assigned_by_display
                                            ? ` bởi ${role.assigned_by_display}`
                                            : ""}
                                        </span>
                                      </div>
                                    </td>

                                    <td data-label="Hiệu lực & Bảo vệ" className={DATA_TABLE_TD_CLASS}>
                                      <div className="flex flex-col items-end gap-1 sm:items-start">
                                        <StatusBadge
                                          tone={role.is_effective ? "success" : "warning"}
                                          dot
                                        >
                                          {role.is_effective
                                            ? "Đang có hiệu lực"
                                            : "Được gán · Đang bị chặn"}
                                        </StatusBadge>
                                        {!role.is_effective && role.inactive_reason ? (
                                          <span className="text-xs text-amber-800 dark:text-amber-200">
                                            {describeInactiveOrBlockingReason(role.inactive_reason)}
                                          </span>
                                        ) : null}
                                        {role.is_protected ? (
                                          <StatusBadge tone="primary">Bảo vệ cố định (Owner)</StatusBadge>
                                        ) : null}
                                      </div>
                                    </td>

                                    <td data-label="Nguồn & Lý do" className={DATA_TABLE_TD_CLASS}>
                                      <div className="space-y-0.5 text-xs">
                                        <p className="text-muted">{formatRoleSourceKind(role.source_kind)}</p>
                                        {role.reason ? (
                                          <p className="text-foreground">{role.reason}</p>
                                        ) : null}
                                      </div>
                                    </td>

                                    <td
                                      data-card-actions="true"
                                      className={`${DATA_TABLE_TD_CLASS} text-right`}
                                    >
                                      <div>
                                        {role.is_protected || !role.can_revoke ? (
                                          <span className="inline-block max-w-52 text-left sm:text-right text-xs text-muted">
                                            {protectedReasonText ??
                                              "Phân công được bảo vệ, không thể thu hồi."}
                                          </span>
                                        ) : (
                                          <Button
                                            variant="danger-outline"
                                            size="sm"
                                            disabled={
                                              !canManageGlobalRoles ||
                                              gateState !== null ||
                                              switchAccountDisabled
                                            }
                                            aria-label={`Thu hồi vai trò ${role.display_name}`}
                                            onClick={() => openRevokeDialog(detail, role)}
                                          >
                                            Thu hồi vai trò
                                          </Button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </DataTableContainer>
                    )}

                    {endedHistory.length > 0 ? (
                      <details className="mt-4 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs">
                        <summary className="cursor-pointer font-medium text-muted hover:text-foreground">
                          Lịch sử vai trò toàn cục đã thu hồi ({endedHistory.length})
                        </summary>
                        <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
                          {endedHistory.map((item) => (
                            <li key={item.assignment_id} className="text-muted">
                              <span className="font-medium text-foreground">{item.display_name}</span> · Thu hồi lúc{" "}
                              {formatAuthzTimestampVi(item.ended_at)}
                              {item.ended_reason ? ` · Lý do: ${item.ended_reason}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                </Card>
              ) : null}
            </section>
          </div>
        </>
      )}

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !isDialogCloseDisabled) {
            resetAndCloseDialog();
          }
        }}
        title={
          dialog?.kind === "assign"
            ? "Cấp vai trò toàn cục"
            : dialog?.kind === "revoke"
              ? `Thu hồi vai trò ${dialog.assignment.display_name}`
              : "Quản trị vai trò toàn cục"
        }
        description={
          dialog
            ? `Tài khoản: ${dialog.accountName}. Thay đổi áp dụng ngay sau khi máy chủ xác nhận.`
            : undefined
        }
        descriptionId="role-mutation-dialog-desc"
        closeDisabled={isDialogCloseDisabled}
        dataTestId="global-role-mutation-dialog"
      >
        {dialog ? (
          <form className="space-y-4" onSubmit={handleDialogSubmit}>
            {dialog.kind === "assign" ? (
              <div className="space-y-2.5">
                <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
                  <label htmlFor="assign-global-role-select">Chọn vai trò toàn cục</label>
                  <select
                    id="assign-global-role-select"
                    value={assignRoleCode}
                    disabled={areFieldsLocked}
                    aria-describedby="assign-global-role-hint"
                    onChange={(event) => {
                      if (areFieldsLocked) return;
                      setPendingMutation(null);
                      setFeedback(null);
                      setAssignRoleCode(event.target.value as GlobalRoleCode | "");
                    }}
                    className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                  >
                    <option value="">-- Chọn một vai trò toàn cục --</option>
                    {assignableGlobalRoles.map((role) => {
                      const alreadyAssigned = dialog.assignedRoleCodes.includes(
                        role.role_code as GlobalRoleCode,
                      );
                      return (
                        <option
                          key={role.role_code}
                          value={role.role_code}
                          disabled={alreadyAssigned}
                        >
                          {role.display_name}
                          {alreadyAssigned ? " (Đã gán)" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div
                  id="assign-global-role-hint"
                  className="rounded-lg border border-border bg-surface-muted/40 p-3 text-xs text-muted space-y-1"
                >
                  {selectedAssignRoleMeta ? (
                    <>
                      <p className="font-medium text-foreground">
                        {selectedAssignRoleMeta.display_name}
                      </p>
                      <p>{selectedAssignRoleMeta.description}</p>
                      <p>
                        Gồm {selectedAssignRoleMeta.capabilities.length} quyền tiêu chuẩn theo cấu hình hệ thống. Các vai trò theo ngữ cảnh (TL, Trưởng phòng, PM, Kế toán dự án) không cấp tại đây.
                      </p>
                    </>
                  ) : (
                    <p>
                      Chỉ 4 vai trò toàn cục xuất hiện trong danh sách; vai trò ngữ cảnh được quản lý tại phân hệ tương ứng.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <Alert tone="warning" role="status" title="Xác nhận thu hồi vai trò toàn cục">
                <p>
                  Bạn chuẩn bị thu hồi vai trò <strong>{dialog.assignment.display_name}</strong> của tài khoản{" "}
                  <strong>{dialog.accountName}</strong>.
                </p>
                <p>
                  Thao tác chỉ kết thúc phân công vai trò toàn cục này và không xóa các phân công độc lập khác (như Trưởng nhóm, PM, Kế toán dự án).
                </p>
              </Alert>
            )}

            <div className="flex flex-col gap-1 text-sm font-medium text-foreground">
              <label htmlFor="role-mutation-reason-input">
                Lý do thay đổi vai trò (bắt buộc)
              </label>
              <span id="role-mutation-reason-hint" className="text-xs font-normal text-muted">
                Nhập từ {ROLE_REASON_MIN_LENGTH} đến {ROLE_REASON_MAX_LENGTH} ký tự để lưu vết kiểm toán.
              </span>
              <textarea
                id="role-mutation-reason-input"
                required
                rows={3}
                value={reason}
                minLength={ROLE_REASON_MIN_LENGTH}
                maxLength={ROLE_REASON_MAX_LENGTH}
                disabled={areFieldsLocked}
                aria-invalid={feedback?.tone === "error" ? true : undefined}
                aria-describedby={
                  feedback
                    ? "role-mutation-reason-hint role-mutation-feedback-msg"
                    : "role-mutation-reason-hint"
                }
                placeholder={
                  dialog.kind === "assign"
                    ? "Ví dụ: Phân công nhiệm vụ BoD/Admin quản trị hệ thống…"
                    : "Ví dụ: Bàn giao lại vai trò quản trị sau khi đổi phụ trách…"
                }
                onChange={(event) => {
                  if (areFieldsLocked) return;
                  setPendingMutation(null);
                  setFeedback(null);
                  setReason(event.target.value);
                }}
                className="rounded-md border border-border bg-surface px-3 py-2 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              />
            </div>

            {feedback ? (
              <Alert
                tone={feedback.tone === "info" ? "info" : feedback.tone}
                role={feedback.tone === "error" ? "alert" : "status"}
                title={feedback.title}
              >
                <p id="role-mutation-feedback-msg">{feedback.message}</p>
                {feedback.needsReload ? (
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || reconciling}
                      onClick={() => void handleReconcileReload()}
                    >
                      {reconciling ? "Đang tải đối chiếu…" : "Tải lại đối chiếu"}
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                size="md"
                disabled={isDialogCloseDisabled}
                onClick={() => {
                  if (!isDialogCloseDisabled) resetAndCloseDialog();
                }}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant={dialog.kind === "revoke" && !isUncertainLocked ? "danger" : "primary"}
                size="md"
                loading={busy}
                disabled={
                  busy ||
                  reconciling ||
                  (!isUncertainLocked &&
                    (conflictLocked ||
                      gateLockedInDialog ||
                      postApplyNeedsReload ||
                      staleReplayLocked ||
                      !canManageGlobalRoles ||
                      gateState !== null ||
                      (dialog.kind === "assign" && !assignRoleCode)))
                }
              >
                {busy
                  ? "Đang xử lý…"
                  : isUncertainLocked
                    ? "Thử gửi lại cùng yêu cầu"
                    : dialog.kind === "assign"
                      ? "Xác nhận cấp vai trò"
                      : "Xác nhận thu hồi"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
