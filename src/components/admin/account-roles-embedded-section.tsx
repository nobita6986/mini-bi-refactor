"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { Wp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
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
} from "@/components/ui/data-table";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  ROLE_REASON_MAX_LENGTH,
  ROLE_REASON_MIN_LENGTH,
  accountTypeBadgeMeta,
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
  projectRolesCatalogEnvelope,
  resolveAssignableGlobalRoles,
  resolveContextualAssignmentPresentation,
  resolveModuleAuthorityPresentation,
  splitOpenAndEndedDirectExceptions,
  splitOpenAndEndedGlobalRoles,
  type RoleGateReason,
} from "@/lib/admin/role-effective-access-model";
import type {
  AccountAccessDetail,
  AssignedGlobalRoleItem,
  AssignGlobalRoleInput,
  GlobalRoleCode,
  RevokeGlobalRoleInput,
  RoleCatalogItem,
} from "@/lib/auth/role-access-contract";
import { isUuid } from "@/lib/http/direct-entry-api-guard";

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

type InternalDetailState =
  | { kind: "idle" }
  | { kind: "loading"; accountRef: string }
  | { kind: "ready"; detail: AccountAccessDetail }
  | { kind: "error"; accountRef: string; message: string; retryable: boolean };

export type AccountRolesEmbeddedSectionProps = {
  accountRef: string | null;
  canManageGlobalRoles: boolean;
  workspaceGuard: Wp4WorkspaceGuard;
  catalogRoles?: readonly RoleCatalogItem[];
  controlledDetail?: {
    kind: "idle" | "loading" | "ready" | "error";
    detail?: AccountAccessDetail | null;
    errorMessage?: string;
    retryable?: boolean;
    onRetry?: () => void;
  };
  onReloadAuthoritative?: (
    accountRef: string,
    expectedEpoch: number,
  ) => Promise<
    | { ok: true; detail: AccountAccessDetail }
    | { ok: false; sessionLost: boolean; stale: boolean }
  >;
  gateState?: { reason: RoleGateReason; message: string } | null;
  onGateStateChange?: (next: { reason: RoleGateReason; message: string } | null) => void;
  onSessionLost: (message: string, unauthenticated: boolean) => void;
  embeddedInPerson?: boolean;
  reloadToken?: number;
  onDetailLoaded?: (detail: AccountAccessDetail) => void;
};

export type AccountRolesController = {
  isDialogLocked: boolean;
  resetOnSessionLoss: () => void;
  renderDetailCard: () => ReactNode;
  renderMutationDialog: () => ReactNode;
};

/**
 * Single shared controller + UI renderer for Global Role assignments/revocations
 * (used identically by `AccountGlobalRolesPanel` AND `AccountRolesEmbeddedSection`
 * inside Block 3 of `PersonDetailManager`).
 */
export function useAccountRolesController({
  accountRef,
  canManageGlobalRoles,
  workspaceGuard,
  catalogRoles: externalCatalogRoles,
  controlledDetail,
  onReloadAuthoritative,
  gateState: externalGateState,
  onGateStateChange,
  onSessionLost,
  embeddedInPerson = false,
  reloadToken = 0,
  onDetailLoaded,
}: AccountRolesEmbeddedSectionProps): AccountRolesController {
  const notify = useNotify();
  const isControlled = controlledDetail !== undefined;
  const normalizedRef = accountRef && isUuid(accountRef) ? accountRef.toLowerCase() : null;

  const [internalCatalogRoles, setInternalCatalogRoles] = useState<readonly RoleCatalogItem[]>([]);
  const [internalDetailState, setInternalDetailState] = useState<InternalDetailState>(() =>
    normalizedRef ? { kind: "loading", accountRef: normalizedRef } : { kind: "idle" },
  );
  const [internalReloadToken, setInternalReloadToken] = useState(0);
  const [internalGateState, setInternalGateState] = useState<{
    reason: RoleGateReason;
    message: string;
  } | null>(null);

  const gateState = externalGateState !== undefined ? externalGateState : internalGateState;
  const setGateState = useCallback(
    (next: { reason: RoleGateReason; message: string } | null) => {
      if (onGateStateChange) {
        onGateStateChange(next);
      } else {
        setInternalGateState(next);
      }
    },
    [onGateStateChange],
  );

  const effectiveCatalogRoles = externalCatalogRoles ?? internalCatalogRoles;

  const [dialog, setDialog] = useState<RoleDialogState | null>(null);
  const [assignRoleCode, setAssignRoleCode] = useState<GlobalRoleCode | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [gateLockedInDialog, setGateLockedInDialog] = useState(false);
  const [postApplyNeedsReload, setPostApplyNeedsReload] = useState(false);
  const [postApplySuccessMessage, setPostApplySuccessMessage] = useState<string | null>(null);
  const [staleReplayLocked, setStaleReplayLocked] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<PendingRoleMutation | null>(null);
  const [feedback, setFeedback] = useState<DialogFeedback>(null);

  const mountedRef = useRef(true);
  const mutationInFlightRef = useRef(false);
  const catalogSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);

  const onSessionLostRef = useRef(onSessionLost);
  const onDetailLoadedRef = useRef(onDetailLoaded);
  useEffect(() => {
    onSessionLostRef.current = onSessionLost;
  }, [onSessionLost]);
  useEffect(() => {
    onDetailLoadedRef.current = onDetailLoaded;
  }, [onDetailLoaded]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationInFlightRef.current = false;
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
    };
  }, []);

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
    setPostApplySuccessMessage(null);
    setStaleReplayLocked(false);
    setReason("");
    setDialog(null);
  }, []);

  const resetOnSessionLoss = useCallback(() => {
    mutationInFlightRef.current = false;
    catalogSeqRef.current += 1;
    detailSeqRef.current += 1;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;
    if (!mountedRef.current) return;
    setInternalCatalogRoles([]);
    setInternalDetailState({ kind: "idle" });
    setDialog(null);
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setPostApplySuccessMessage(null);
    setStaleReplayLocked(false);
    setBusy(false);
    setReconciling(false);
  }, []);

  const triggerSessionLost = useCallback(
    (message: string, unauthenticated: boolean) => {
      resetOnSessionLoss();
      onSessionLostRef.current(message, unauthenticated);
    },
    [resetOnSessionLoss],
  );

  // Self-fetch roles catalog when not provided externally
  useEffect(() => {
    if (externalCatalogRoles !== undefined || !normalizedRef) return;
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
          triggerSessionLost(failure.message, failure.kind === "unauthenticated");
          return;
        }
        if (response.status !== 200 || !mountedRef.current) return;
        const envelope = projectRolesCatalogEnvelope(payload);
        if (envelope) {
          setInternalCatalogRoles(envelope.roles);
        }
      } catch {
        // Fallback to contract catalog if optional metadata fails.
      } finally {
        tracked.release();
      }
    })();
    return () => {
      catalogSeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [externalCatalogRoles, normalizedRef, reloadToken, internalReloadToken, triggerSessionLost, workspaceGuard]);

  // Self-fetch account access detail when not controlled by parent
  useEffect(() => {
    if (isControlled) return;
    detailAbortRef.current?.abort();
    detailAbortRef.current = null;

    const reqSeq = ++detailSeqRef.current;
    const tracked = workspaceGuard.trackController();
    detailAbortRef.current = tracked.controller;

    void (async () => {
      if (!normalizedRef) {
        if (
          workspaceGuard.isActive(tracked.epoch, tracked.controller) &&
          reqSeq === detailSeqRef.current &&
          mountedRef.current
        ) {
          setInternalDetailState({ kind: "idle" });
        }
        if (detailAbortRef.current === tracked.controller) detailAbortRef.current = null;
        tracked.release();
        return;
      }

      setInternalDetailState({ kind: "loading", accountRef: normalizedRef });

      let response: Response;
      try {
        response = await fetch(
          `/api/admin/access/accounts/${encodeURIComponent(normalizedRef)}/access`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
      } catch (error) {
        tracked.release();
        if (detailAbortRef.current === tracked.controller) detailAbortRef.current = null;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        setInternalDetailState({
          kind: "error",
          accountRef: normalizedRef,
          message: "Không thể kết nối tới máy chủ để tải thông tin vai trò và phân công.",
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
      if (detailAbortRef.current === tracked.controller) detailAbortRef.current = null;

      if (
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        reqSeq !== detailSeqRef.current ||
        !mountedRef.current
      ) {
        return;
      }

      if (response.status === 401 || response.status === 403) {
        const failure = classifyRoleReadFailure(response.status, payload);
        triggerSessionLost(failure.message, failure.kind === "unauthenticated");
        return;
      }

      if (response.status !== 200) {
        const failure = classifyRoleReadFailure(response.status, payload);
        setInternalDetailState({
          kind: "error",
          accountRef: normalizedRef,
          message: failure.message,
          retryable: failure.kind === "unavailable" || failure.kind === "invalid",
        });
        return;
      }

      const projected = projectAccountAccessForTarget(payload, normalizedRef);
      if (!projected) {
        setInternalDetailState({
          kind: "error",
          accountRef: normalizedRef,
          message: "Chi tiết vai trò trả về không khớp định dạng chuẩn.",
          retryable: true,
        });
        return;
      }

      setInternalDetailState({ kind: "ready", detail: projected });
      onDetailLoadedRef.current?.(projected);
    })();

    return () => {
      detailSeqRef.current += 1;
      tracked.controller.abort();
      if (detailAbortRef.current === tracked.controller) detailAbortRef.current = null;
      tracked.release();
    };
  }, [isControlled, normalizedRef, reloadToken, internalReloadToken, triggerSessionLost, workspaceGuard]);

  const reloadDetailSelf = useCallback(
    async (
      targetRef: string,
      expectedEpoch: number,
    ): Promise<
      | { ok: true; detail: AccountAccessDetail }
      | { ok: false; sessionLost: boolean; stale: boolean }
    > => {
      if (onReloadAuthoritative) {
        const result = await onReloadAuthoritative(targetRef, expectedEpoch);
        if (result.ok && !isControlled && mountedRef.current && workspaceGuard.isActive(expectedEpoch)) {
          setInternalDetailState({ kind: "ready", detail: result.detail });
          onDetailLoadedRef.current?.(result.detail);
        }
        return result;
      }

      if (!mountedRef.current || !workspaceGuard.isActive(expectedEpoch)) {
        return { ok: false, sessionLost: !workspaceGuard.isActive(expectedEpoch), stale: true };
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
          !workspaceGuard.isActive(expectedEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current
        ) {
          return { ok: false, sessionLost: !workspaceGuard.isActive(expectedEpoch), stale: true };
        }
        const payload: unknown = await response.json().catch(() => null);
        if (
          !mountedRef.current ||
          !workspaceGuard.isActive(expectedEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current
        ) {
          return { ok: false, sessionLost: !workspaceGuard.isActive(expectedEpoch), stale: true };
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyRoleReadFailure(response.status, payload);
          triggerSessionLost(failure.message, failure.kind === "unauthenticated");
          return { ok: false, sessionLost: true, stale: true };
        }
        if (response.status !== 200) {
          return { ok: false, sessionLost: false, stale: false };
        }
        const detail = projectAccountAccessForTarget(payload, targetRef);
        if (!detail) return { ok: false, sessionLost: false, stale: false };
        setInternalDetailState({ kind: "ready", detail });
        onDetailLoadedRef.current?.(detail);
        return { ok: true, detail };
      } catch {
        const sessionInvalidated = !workspaceGuard.isActive(expectedEpoch);
        const stale =
          !mountedRef.current ||
          !workspaceGuard.isActive(expectedEpoch, tracked.controller) ||
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== detailSeqRef.current;
        return { ok: false, sessionLost: sessionInvalidated, stale };
      } finally {
        tracked.release();
      }
    },
    [isControlled, onReloadAuthoritative, triggerSessionLost, workspaceGuard],
  );

  const assignableGlobalRoles = useMemo(
    () => resolveAssignableGlobalRoles(effectiveCatalogRoles),
    [effectiveCatalogRoles],
  );

  const effectiveKind = isControlled ? controlledDetail.kind : internalDetailState.kind;
  const detail: AccountAccessDetail | null = isControlled
    ? controlledDetail.kind === "ready"
      ? controlledDetail.detail ?? null
      : null
    : internalDetailState.kind === "ready"
      ? internalDetailState.detail
      : null;
  const detailErrorMessage = isControlled
    ? controlledDetail.errorMessage ?? "Không tải được chi tiết vai trò tài khoản."
    : internalDetailState.kind === "error"
      ? internalDetailState.message
      : "";
  const detailErrorRetryable = isControlled
    ? controlledDetail.retryable ?? true
    : internalDetailState.kind === "error"
      ? internalDetailState.retryable
      : true;

  const openAssignDialog = (targetDetail: AccountAccessDetail) => {
    if (busy || reconciling || isUncertainLocked) return;
    const { activeAssigned } = splitOpenAndEndedGlobalRoles(targetDetail.assigned_global_roles);
    const assignedCodes = activeAssigned.map((item) => item.role_code);
    const nextDefault =
      assignableGlobalRoles.find((item) => !assignedCodes.includes(item.role_code as GlobalRoleCode))
        ?.role_code ?? "";
    const identity = formatAccountDisplayIdentity(targetDetail.account);
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setPostApplySuccessMessage(null);
    setStaleReplayLocked(false);
    setReason("");
    setAssignRoleCode(nextDefault as GlobalRoleCode | "");
    setDialog({
      kind: "assign",
      accountRef: targetDetail.account.account_ref,
      accountName: identity.primary,
      snapshotVersion: targetDetail.account.version,
      assignedRoleCodes: assignedCodes,
    });
  };

  const openRevokeDialog = (
    targetDetail: AccountAccessDetail,
    assignment: AssignedGlobalRoleItem,
  ) => {
    if (busy || reconciling || isUncertainLocked) return;
    if (assignment.is_protected || !assignment.can_revoke || assignment.ended_at !== null) return;
    const identity = formatAccountDisplayIdentity(targetDetail.account);
    setPendingMutation(null);
    setFeedback(null);
    setConflictLocked(false);
    setGateLockedInDialog(false);
    setPostApplyNeedsReload(false);
    setPostApplySuccessMessage(null);
    setStaleReplayLocked(false);
    setReason("");
    setDialog({
      kind: "revoke",
      accountRef: targetDetail.account.account_ref,
      accountName: identity.primary,
      snapshotVersion: targetDetail.account.version,
      assignment,
    });
  };

  const handleReconcileReload = async () => {
    if (!dialog || busy || reconciling) return;
    const reconcileEpoch = workspaceGuard.getEpoch();
    setReconciling(true);
    try {
      const result = await reloadDetailSelf(dialog.accountRef, reconcileEpoch);
      if (
        !mountedRef.current ||
        !workspaceGuard.isActive(reconcileEpoch) ||
        (!result.ok && (result.sessionLost || result.stale))
      ) {
        return;
      }
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

      // R1: When the original mutation outcome is still ambiguous, GET only refreshes read views
      // for operator inspection and MUST NEVER clear pendingMutation/Idempotency-Key or rebase
      // snapshotVersion to the latest version (which would turn a stale retry into a brand-new grant).
      if (isUncertainLocked && pendingMutation) {
        const roleCurrentlyPresent =
          dialog.kind === "assign" && pendingMutation.roleCode
            ? activeAssigned.some((role) => role.role_code === pendingMutation.roleCode)
            : dialog.kind === "revoke"
              ? freshDetail.assigned_global_roles.some(
                  (role) =>
                    role.assignment_id === dialog.assignment.assignment_id &&
                    role.ended_at !== null,
                )
              : false;
        setFeedback({
          tone: "warning",
          title:
            dialog.kind === "assign"
              ? roleCurrentlyPresent
                ? "Vai trò đang có mặt trên máy chủ — cần xác nhận lại yêu cầu gốc"
                : "Chưa thấy vai trò ở bản ghi mới nhất — giữ nguyên yêu cầu gốc"
              : roleCurrentlyPresent
                ? "Phân công đã đóng trên máy chủ — cần xác nhận lại yêu cầu gốc"
                : "Phân công vẫn đang mở ở bản ghi mới nhất — giữ nguyên yêu cầu gốc",
          message:
            dialog.kind === "assign"
              ? roleCurrentlyPresent
                ? `Bản ghi mới nhất (phiên bản ${freshDetail.account.version}) đang có vai trò này, nhưng có thể do thao tác khác tạo. Khóa gửi trùng và phiên bản gốc (${pendingMutation.snapshotVersion}) vẫn được giữ nguyên; hãy bấm "Thử gửi lại cùng yêu cầu" để xác nhận kết quả thực trên máy chủ.`
                : `Bản ghi mới nhất (phiên bản ${freshDetail.account.version}) hiện chưa có vai trò này (yêu cầu cũ có thể chưa chạy, đang xử lý hoặc đã bị thao tác khác rút sau đó). Khóa gửi trùng và phiên bản gốc (${pendingMutation.snapshotVersion}) vẫn được giữ nguyên; hãy bấm "Thử gửi lại cùng yêu cầu" để kiểm tra kết quả cũ mà không tạo lệnh cấp mới ở phiên bản ${freshDetail.account.version}.`
              : roleCurrentlyPresent
                ? `Bản ghi mới nhất (phiên bản ${freshDetail.account.version}) cho thấy phân công này đã đóng, nhưng có thể do thao tác khác thực hiện. Khóa gửi trùng và phiên bản gốc (${pendingMutation.snapshotVersion}) vẫn được giữ nguyên; hãy bấm "Thử gửi lại cùng yêu cầu" để xác nhận trên máy chủ.`
                : `Bản ghi mới nhất (phiên bản ${freshDetail.account.version}) cho thấy phân công vẫn đang mở. Khóa gửi trùng và phiên bản gốc (${pendingMutation.snapshotVersion}) vẫn được giữ nguyên; hãy bấm "Thử gửi lại cùng yêu cầu" để xác nhận trên máy chủ mà không tạo lệnh mới ở phiên bản ${freshDetail.account.version}.`,
          needsReload: true,
        });
        return;
      }

      if (staleReplayLocked) {
        resetAndCloseDialog();
        notify.info({
          title: "Đã tải lại dữ liệu mới nhất để đối chiếu.",
        });
        return;
      }

      if (postApplyNeedsReload) {
        const msg =
          postApplySuccessMessage ??
          "Đã đối chiếu: thay đổi vai trò đã được ghi nhận trên máy chủ.";
        resetAndCloseDialog();
        notify.success({ title: msg });
        return;
      }

      setPendingMutation(null);
      setConflictLocked(false);
      setPostApplyNeedsReload(false);
      setPostApplySuccessMessage(null);
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
              : "Chỉ tài khoản nhân viên đang hoạt động mới được cấp thêm vai trò toàn cục.",
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
      if (mountedRef.current && workspaceGuard.isActive(reconcileEpoch)) {
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
      detail && detail.account.account_ref === targetAccountRef
        ? detail.account.version
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
        triggerSessionLost(outcome.message, outcome.unauthenticated);
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

      const reloadResult = await reloadDetailSelf(targetAccountRef, tracked.epoch);
      if (
        !mountedRef.current ||
        !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
        (!reloadResult.ok && (reloadResult.sessionLost || reloadResult.stale))
      ) {
        return;
      }

      if (!reloadResult.ok) {
        setPendingMutation(null);
        setConflictLocked(true);
        setPostApplyNeedsReload(true);
        setPostApplySuccessMessage(intent.successMessage);
        setFeedback({
          tone: "warning",
          title: "Đã ghi nhận thao tác nhưng chưa tải được dữ liệu mới nhất",
          message:
            "Vui lòng bấm Tải lại đối chiếu để đồng bộ danh sách và quyền hiệu lực mới nhất từ máy chủ.",
          needsReload: true,
        });
        return;
      }

      const staleAfterReload = isStaleMutationReplay(
        outcome.result.account_version,
        reloadResult.detail.account.version,
      );
      resetAndCloseDialog();
      if (staleAfterReload) {
        notify.info({
          title: "Đã đồng bộ dữ liệu mới nhất trên máy chủ sau khi đối chiếu yêu cầu trước đó.",
        });
      } else {
        notify.success({
          title: outcome.replayed
            ? `${intent.successMessage} (Đã đối chiếu yêu cầu trùng khớp an toàn)`
            : intent.successMessage,
        });
      }
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

  const selectedAssignRoleMeta =
    dialog?.kind === "assign" && assignRoleCode
      ? assignableGlobalRoles.find((r) => r.role_code === assignRoleCode) ?? null
      : null;

  const { activeAssigned, endedHistory } = detail
    ? splitOpenAndEndedGlobalRoles(detail.assigned_global_roles)
    : { activeAssigned: [], endedHistory: [] };
  const { activeExceptions, endedHistory: endedExceptions } = detail
    ? splitOpenAndEndedDirectExceptions(detail.direct_exceptions)
    : { activeExceptions: [], endedHistory: [] };

  const assignEligibility = detail
    ? canAssignNewGlobalRoleToAccount(detail.account, canManageGlobalRoles, gateState !== null)
    : { allowed: false, reason: null };

  const activeAssignedCodes = activeAssigned.map((role) => role.role_code);
  const allFourGlobalRolesAssigned = assignableGlobalRoles.every((role) =>
    activeAssignedCodes.includes(role.role_code as GlobalRoleCode),
  );

  const handleRetryDetail = () => {
    if (isControlled) {
      controlledDetail.onRetry?.();
    } else {
      setInternalReloadToken((t) => t + 1);
    }
  };

  const renderDetailCard = (): ReactNode => (
    <div data-testid="account-roles-embedded-section" className="space-y-4">
      {embeddedInPerson && !canManageGlobalRoles ? (
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

      {embeddedInPerson && gateState ? (
        <StatusBanner
          tone="warning"
          title="Tính năng thay đổi vai trò toàn cục chưa mở trong chặng triển khai này"
          dataTestId="global-roles-rollout-gate-banner"
        >
          <p>{gateState.message}</p>
        </StatusBanner>
      ) : null}

      {effectiveKind === "idle" ? (
        <Card>
          <EmptyState
            title="Chưa chọn tài khoản"
            description="Chọn một tài khoản ở bảng bên cạnh để xem, cấp hoặc thu hồi vai trò toàn cục."
          />
        </Card>
      ) : null}

      {effectiveKind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách vai trò toàn cục của tài khoản…
          </p>
        </Card>
      ) : null}

      {effectiveKind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState
              title="Không tải được chi tiết vai trò tài khoản"
              detail={detailErrorMessage}
            />
            {detailErrorRetryable ? (
              <Button variant="secondary" size="md" onClick={handleRetryDetail}>
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
              {embeddedInPerson ? (
                <>
                  <h2 className="text-base font-semibold text-foreground">
                    3. Vai trò &amp; Phân công truy cập
                  </h2>
                  <p className="text-xs text-muted">
                    Cấp hoặc thu hồi 4 vai trò toàn hệ thống (gồm <strong>BoD/Admin</strong>) trực tiếp tại đây. Các phân công theo ngữ cảnh được quản lý tại phân hệ nguồn.
                  </p>
                </>
              ) : (
                <>
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
                  {detail.account.person ? (
                    <p className="text-xs text-muted">
                      Hồ sơ nhân sự:{" "}
                      <Link
                        href={`/admin/organization/persons/${encodeURIComponent(detail.account.person.person_id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {detail.account.person.full_name} ({detail.account.person.employee_code})
                      </Link>
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">
                    Chỉ gán được 4 vai trò toàn cục (gồm <strong>BoD/Admin</strong> áp dụng đồng nhất cho mọi thành viên). Vai trò theo ngữ cảnh (TL, Trưởng phòng, PM, Kế toán dự án) chỉ xem ở màn Quyền hiệu lực.
                  </p>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Link
                href={`/admin/access/effective?account=${encodeURIComponent(detail.account.account_ref)}`}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                {embeddedInPerson ? "Tra cứu quyền hiệu lực" : "Xem quyền hiệu lực"}
              </Link>
              <Button
                variant="primary"
                size="sm"
                disabled={
                  !assignEligibility.allowed ||
                  allFourGlobalRolesAssigned ||
                  isDialogCloseDisabled
                }
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
                          Hiệu lực &amp; Bảo vệ
                        </th>
                        <th scope="col" className={DATA_TABLE_TH_CLASS}>
                          Nguồn &amp; Lý do
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
                                      isDialogCloseDisabled
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

            {embeddedInPerson ? (
              <div className="mt-5 space-y-4 border-t border-border pt-4">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Phân công theo ngữ cảnh &amp; Thẩm quyền phân hệ (chỉ đọc)
                  </h3>
                  {detail.contextual_assignments.length === 0 &&
                  detail.module_authorities.length === 0 ? (
                    <p className="text-xs text-muted">
                      Chưa có phân công Trưởng nhóm, Trưởng phòng, Quản lý dự án, Kế toán dự án hoặc ủy quyền phân hệ nào.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.contextual_assignments.map((item, idx) => {
                        const pres = resolveContextualAssignmentPresentation(item);
                        return (
                          <li
                            key={`${item.role_code}-${item.scope_kind}-${item.scope_id ?? "none"}-${idx}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs"
                          >
                            <div className="space-y-0.5">
                              <span className="font-medium text-foreground">
                                {item.display_name} · {pres.targetKindLabel}
                              </span>
                              <span className="block text-muted">
                                {item.target_label} · {pres.statusLabel}
                              </span>
                            </div>
                            <Link
                              href={pres.sourceLink.href}
                              className={buttonClasses({ variant: "secondary", size: "sm" })}
                            >
                              {pres.sourceLink.label}
                            </Link>
                          </li>
                        );
                      })}
                      {detail.module_authorities.map((item, idx) => {
                        const pres = resolveModuleAuthorityPresentation(item);
                        return (
                          <li
                            key={`${item.module}-${pres.authorityTitle}-${idx}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs"
                          >
                            <div className="space-y-0.5">
                              <span className="font-medium text-foreground">
                                {pres.moduleLabel} — {pres.authorityTitle}
                              </span>
                              <span className="block text-muted">
                                {pres.scopeText} · {pres.statusLabel}
                              </span>
                            </div>
                            {pres.sourceLink ? (
                              <Link
                                href={pres.sourceLink.href}
                                className={buttonClasses({ variant: "secondary", size: "sm" })}
                              >
                                {pres.sourceLink.label}
                              </Link>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div
                  data-testid="wp9-obligations-readonly-note"
                  className="rounded-lg border border-border bg-surface-muted/30 px-3 py-2.5 text-xs text-muted"
                >
                  Nghĩa vụ chấm công áp dụng theo cấu hình chính sách/chi nhánh tại{" "}
                  <Link href="/admin/attendance" className="font-medium text-primary hover:underline">
                    Báo cáo chấm công
                  </Link>
                  ; nghĩa vụ báo cáo công việc áp dụng theo đợt giao tại{" "}
                  <Link
                    href="/work-reports/assignments"
                    className="font-medium text-primary hover:underline"
                  >
                    Quản lý báo cáo
                  </Link>
                  . Hệ thống không suy nghĩa vụ cá nhân từ vai trò truy cập.
                </div>
              </div>
            ) : null}

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

            {embeddedInPerson && (activeExceptions.length > 0 || endedExceptions.length > 0) ? (
              <details className="mt-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium text-muted hover:text-foreground">
                  Quyền ngoại lệ trực tiếp (chỉ đọc: {activeExceptions.length} đang mở · {endedExceptions.length} lịch sử)
                </summary>
                <p className="mt-2 text-muted">
                  Chi tiết từng capability/scope ngoại lệ xem tại{" "}
                  <Link
                    href={`/admin/access/effective?account=${encodeURIComponent(detail.account.account_ref)}`}
                    className="font-medium text-primary hover:underline"
                  >
                    Quyền hiệu lực
                  </Link>
                  .
                </p>
              </details>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );

  const renderMutationDialog = (): ReactNode => (
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
  );

  return {
    isDialogLocked: isDialogCloseDisabled,
    resetOnSessionLoss,
    renderDetailCard,
    renderMutationDialog,
  };
}

export function AccountRolesEmbeddedSection(props: AccountRolesEmbeddedSectionProps) {
  const controller = useAccountRolesController(props);
  return (
    <>
      {controller.renderDetailCard()}
      {controller.renderMutationDialog()}
    </>
  );
}
