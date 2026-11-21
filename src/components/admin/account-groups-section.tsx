"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import type { Wp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import {
  classifyPermissionGroupMutationResponse,
  classifyPermissionGroupReadError,
  formatResourceAssignmentKindLabel,
  newGroupMutationIdempotencyKey,
  projectAccountGroupsEnvelope,
  projectPermissionGroupsEnvelope,
  summarizeGroupBusinessActions,
  type AccountGroupMembershipItem,
  type AccountGroupsResponse,
  type PermissionGroupSummary,
} from "@/lib/admin/permission-group-ui-model";
import { isUuid } from "@/lib/http/direct-entry-api-guard";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: AccountGroupsResponse }
  | { kind: "error"; message: string; retryable: boolean };

type DialogState =
  | { kind: "assign"; expectedVersion: number }
  | { kind: "remove"; membership: AccountGroupMembershipItem; expectedVersion: number };

type PendingIntent = {
  op: "assign" | "remove";
  groupId: string;
  membershipId?: string;
  expectedVersion: number;
  reason: string | null;
  idempotencyKey: string;
};

export function AccountGroupsSection({
  accountRef,
  canManageGroups,
  workspaceGuard,
  reloadToken = 0,
  onSessionLost,
  onAccountVersionChanged,
}: {
  accountRef: string | null;
  canManageGroups: boolean;
  workspaceGuard: Wp4WorkspaceGuard;
  reloadToken?: number;
  onSessionLost: (message: string, unauthenticated: boolean) => void;
  onAccountVersionChanged?: (version: number) => void;
}) {
  const notify = useNotify();
  const groupSelectId = useId();
  const reasonId = useId();

  const normalizedRef = accountRef && isUuid(accountRef) ? accountRef.toLowerCase() : null;

  const [state, setState] = useState<LoadState>(() =>
    normalizedRef ? { kind: "loading" } : { kind: "idle" },
  );
  const [availableGroups, setAvailableGroups] = useState<readonly PermissionGroupSummary[]>([]);
  const [internalReload, setInternalReload] = useState(0);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "warning" | "info";
    title: string;
    message: string;
  } | null>(null);

  const seqRef = useRef(0);
  const catalogSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const onSessionLostRef = useRef(onSessionLost);
  const onVersionRef = useRef(onAccountVersionChanged);
  useEffect(() => {
    onSessionLostRef.current = onSessionLost;
    onVersionRef.current = onAccountVersionChanged;
  }, [onAccountVersionChanged, onSessionLost]);

  useEffect(() => {
    return () => {
      inFlightRef.current = false;
    };
  }, []);

  // Load account group memberships + resource assignments
  useEffect(() => {
    const reqSeq = ++seqRef.current;
    if (!normalizedRef || !canManageGroups) {
      return;
    }
    const tracked = workspaceGuard.trackController();

    void (async () => {
      await Promise.resolve();
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
        tracked.release();
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(
          `/api/admin/access/accounts/${encodeURIComponent(normalizedRef)}/groups`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        if (response.status !== 200) {
          const failure = classifyPermissionGroupReadError(response.status, payload);
          if (failure.kind === "unauthenticated" || failure.kind === "denied") {
            onSessionLostRef.current(failure.message, failure.kind === "unauthenticated");
            return;
          }
          setState({ kind: "error", message: failure.message, retryable: failure.retryable });
          return;
        }
        const projected = projectAccountGroupsEnvelope(payload);
        if (!projected) {
          setState({
            kind: "error",
            message: "Dữ liệu nhóm quyền trả về chưa đầy đủ.",
            retryable: true,
          });
          return;
        }
        setState({ kind: "ready", data: projected });
        onVersionRef.current?.(projected.account_version);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải nhóm quyền.",
          retryable: true,
        });
      } finally {
        tracked.release();
      }
    })();

    return () => {
      seqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [canManageGroups, internalReload, normalizedRef, reloadToken, workspaceGuard]);

  // Load active groups catalog for assignment picker
  useEffect(() => {
    const reqSeq = ++catalogSeqRef.current;
    if (!normalizedRef || !canManageGroups) {
      return;
    }
    const tracked = workspaceGuard.trackController();

    void (async () => {
      try {
        const response = await fetch("/api/admin/access/groups?include_inactive=false", {
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
        const payload = await response.json().catch(() => null);
        if (
          !workspaceGuard.isActive(tracked.epoch, tracked.controller) ||
          reqSeq !== catalogSeqRef.current
        ) {
          return;
        }
        if (response.status === 401 || response.status === 403) {
          const failure = classifyPermissionGroupReadError(response.status, payload);
          onSessionLostRef.current(failure.message, failure.kind === "unauthenticated");
          return;
        }
        if (response.status !== 200) return;
        const projected = projectPermissionGroupsEnvelope(payload);
        if (projected) {
          setAvailableGroups(projected.groups.filter((g) => g.active));
        }
      } catch {
        // Assignable list will degrade cleanly if optional fetch fails.
      } finally {
        tracked.release();
      }
    })();

    return () => {
      catalogSeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [canManageGroups, internalReload, normalizedRef, reloadToken, workspaceGuard]);

  const readyData = state.kind === "ready" ? state.data : null;

  const assignableGroups = useMemo(() => {
    if (!readyData) return [];
    const currentGroupIds = new Set(readyData.memberships.map((m) => m.group_id));
    return availableGroups.filter((g) => g.active && !currentGroupIds.has(g.group_id));
  }, [availableGroups, readyData]);

  const closeDialog = useCallback(() => {
    if (busy) return;
    setDialog(null);
    setSelectedGroupId("");
    setReason("");
    setPendingIntent(null);
    setConflictLocked(false);
    setFeedback(null);
  }, [busy]);

  const reloadNow = useCallback(() => {
    setInternalReload((v) => v + 1);
  }, []);

  const openAssignDialog = () => {
    if (!readyData || !readyData.enabled || assignableGroups.length === 0) return;
    setSelectedGroupId(assignableGroups[0]?.group_id ?? "");
    setReason("");
    setPendingIntent(null);
    setConflictLocked(false);
    setFeedback(null);
    setDialog({ kind: "assign", expectedVersion: readyData.account_version });
  };

  const openRemoveDialog = (membership: AccountGroupMembershipItem) => {
    if (!readyData || !membership.can_remove) return;
    setReason("");
    setPendingIntent(null);
    setConflictLocked(false);
    setFeedback(null);
    setDialog({ kind: "remove", membership, expectedVersion: readyData.account_version });
  };

  const executeMutation = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || !normalizedRef || inFlightRef.current || busy || conflictLocked) return;

    const trimmedReason = reason.trim();
    if (trimmedReason.length > 0 && trimmedReason.length < 3) {
      setFeedback({
        tone: "error",
        title: "Lý do chưa hợp lệ",
        message: "Nếu nhập lý do, vui lòng ghi tối thiểu 3 ký tự (hoặc để trống).",
      });
      return;
    }

    const intent: PendingIntent =
      pendingIntent ??
      (dialog.kind === "assign"
        ? {
            op: "assign",
            groupId: selectedGroupId,
            expectedVersion: dialog.expectedVersion,
            reason: trimmedReason.length > 0 ? trimmedReason : null,
            idempotencyKey: newGroupMutationIdempotencyKey(),
          }
        : {
            op: "remove",
            groupId: dialog.membership.group_id,
            membershipId: dialog.membership.membership_id,
            expectedVersion: dialog.expectedVersion,
            reason: trimmedReason.length > 0 ? trimmedReason : null,
            idempotencyKey: newGroupMutationIdempotencyKey(),
          });

    if (intent.op === "assign" && !isUuid(intent.groupId)) {
      setFeedback({
        tone: "error",
        title: "Chưa chọn nhóm quyền",
        message: "Vui lòng chọn một nhóm quyền để thêm cho người dùng.",
      });
      return;
    }

    if (intent.op === "remove" && !intent.membershipId) {
      setFeedback({
        tone: "error",
        title: "Thiếu thông tin thành viên nhóm",
        message: "Vui lòng tải lại trang trước khi gỡ nhóm quyền.",
      });
      return;
    }

    setPendingIntent(intent);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const url =
        intent.op === "assign"
          ? `/api/admin/access/accounts/${encodeURIComponent(normalizedRef)}/groups`
          : `/api/admin/access/accounts/${encodeURIComponent(normalizedRef)}/groups/${encodeURIComponent(intent.membershipId ?? "")}`;
      const method = intent.op === "assign" ? "POST" : "DELETE";
      const body =
        intent.op === "assign"
          ? {
              group_id: intent.groupId,
              expected_account_version: intent.expectedVersion,
              reason: intent.reason,
            }
          : {
              expected_account_version: intent.expectedVersion,
              reason: intent.reason,
            };

      const response = await fetch(url, {
        method,
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyPermissionGroupMutationResponse(response.status, payload);
      if (outcome.kind === "session-lost") {
        setDialog(null);
        onSessionLostRef.current(outcome.message, outcome.unauthenticated);
        return;
      }
      if (outcome.kind === "applied") {
        setPendingIntent(null);
        setDialog(null);
        setReason("");
        notify.success(
          intent.op === "assign"
            ? {
                title: "Đã thêm vào nhóm quyền",
                description: "Quyền mới sẽ áp dụng từ yêu cầu tiếp theo của người dùng.",
              }
            : {
                title: "Đã gỡ khỏi nhóm quyền",
                description: "Lịch sử làm việc và dữ liệu đã nộp vẫn được giữ nguyên.",
              },
        );
        reloadNow();
        return;
      }
      if (outcome.kind === "protected") {
        setPendingIntent(null);
        setConflictLocked(true);
        setFeedback({
          tone: "warning",
          title: "Quyền được bảo vệ",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "account-disabled") {
        setPendingIntent(null);
        setConflictLocked(true);
        setFeedback({
          tone: "warning",
          title: "Tài khoản đang khóa đăng nhập",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictLocked(outcome.needsReload);
        setFeedback({
          tone: "warning",
          title: "Dữ liệu đã thay đổi",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "invalid") {
        setPendingIntent(null);
        setFeedback({
          tone: "error",
          title: "Không thể lưu thay đổi",
          message: outcome.message,
        });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: outcome.message,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối khi lưu nhóm quyền",
        message:
          "Chưa rõ máy chủ đã hoàn tất hay chưa. Bấm nút xác nhận lần nữa để đồng bộ an toàn mà không tạo trùng.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  if (!normalizedRef) {
    return (
      <Card>
        <CardHeader
          title="Nhóm quyền & Phân công"
          description="Mở đăng nhập cho nhân viên để xếp vào nhóm quyền phù hợp."
        />
        <p className="text-sm text-muted">
          Nhân viên này chưa có tài khoản đăng nhập nên chưa gắn nhóm quyền.
        </p>
      </Card>
    );
  }

  if (!canManageGroups) {
    return (
      <Card>
        <CardHeader
          title="Nhóm quyền & Phân công"
          description="Chỉ quản trị viên hệ thống (BoD/Admin) mới có quyền xem và điều chỉnh nhóm quyền."
        />
      </Card>
    );
  }

  const selectedAssignGroup =
    dialog?.kind === "assign"
      ? assignableGroups.find((g) => g.group_id === selectedGroupId) ?? null
      : null;

  return (
    <Card data-testid="account-groups-section">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <CardHeader
          title="Nhóm quyền & Phân công"
          description="Quyền thao tác được quản lý theo nhóm gắn với phòng ban. Quyền theo dự án/tổ đội/phòng ban giữ nguyên từ phân công nghiệp vụ."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/access/groups"
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            Quản lý nhóm quyền
          </Link>
          {readyData ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!readyData.enabled || assignableGroups.length === 0}
              onClick={openAssignDialog}
            >
              + Thêm vào nhóm quyền
            </Button>
          ) : null}
        </div>
      </div>

      {state.kind === "loading" ? (
        <p role="status" className="py-6 text-center text-sm text-muted">
          Đang tải nhóm quyền hiện hành…
        </p>
      ) : null}

      {state.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState title="Không tải được nhóm quyền" detail={state.message} />
          {state.retryable ? (
            <Button type="button" variant="secondary" size="sm" onClick={reloadNow}>
              Thử tải lại
            </Button>
          ) : null}
        </div>
      ) : null}

      {readyData ? (
        <div className="space-y-5">
          {!readyData.enabled ? (
            <Alert tone="warning" title="Tài khoản đang bị khóa đăng nhập">
              Tài khoản đang khóa vẫn giữ nguyên lịch sử và danh sách nhóm quyền cũ, nhưng không thể
              thêm vào nhóm quyền mới cho tới khi được mở đăng nhập lại.
            </Alert>
          ) : null}

          <div className="space-y-2.5">
            <h3 className="text-sm font-semibold text-foreground">
              Nhóm quyền đang tham gia ({readyData.memberships.length})
            </h3>
            {readyData.memberships.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted">
                Chưa tham gia nhóm quyền nào (sử dụng các tính năng cơ bản của nhân viên như chấm
                công, nghỉ phép và báo cáo được giao).
              </p>
            ) : (
              <div className="space-y-2.5">
                {readyData.memberships.map((membership) => {
                  const actionLabels = summarizeGroupBusinessActions({
                    is_system_admin: membership.is_system_admin,
                    capabilities: membership.capabilities,
                    module_roles: membership.module_roles,
                  });
                  return (
                    <div
                      key={membership.membership_id}
                      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted/20 p-3.5 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-foreground">
                            {membership.group_name}
                          </span>
                          <StatusBadge tone="info">{membership.department_name}</StatusBadge>
                          {membership.team_name ? (
                            <StatusBadge tone="neutral">Đội: {membership.team_name}</StatusBadge>
                          ) : null}
                          {membership.is_protected ? (
                            <StatusBadge tone="warning">Tài khoản chủ sở hữu được bảo vệ</StatusBadge>
                          ) : null}
                        </div>
                        {membership.group_description ? (
                          <p className="text-xs text-muted">{membership.group_description}</p>
                        ) : null}
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {actionLabels.slice(0, 6).map((label) => (
                            <span
                              key={label}
                              className="inline-flex rounded-md border border-border/80 bg-surface px-2 py-0.5 text-xs text-foreground"
                            >
                              {label}
                            </span>
                          ))}
                          {actionLabels.length > 6 ? (
                            <span className="inline-flex rounded-md bg-surface-muted px-2 py-0.5 text-xs text-muted">
                              +{actionLabels.length - 6} quyền khác
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="shrink-0">
                        {membership.can_remove ? (
                          <Button
                            type="button"
                            variant="danger-outline"
                            size="sm"
                            onClick={() => openRemoveDialog(membership)}
                          >
                            Gỡ khỏi nhóm
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled
                            aria-label={`Không thể gỡ khỏi nhóm ${membership.group_name} vì tài khoản chủ sở hữu được bảo vệ`}
                          >
                            Đang bảo vệ
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground">
              Phân công theo dự án, tổ đội và phòng ban ({readyData.resource_assignments.length})
            </h3>
            {readyData.resource_assignments.length === 0 ? (
              <p className="text-xs text-muted">
                Chưa có phân công riêng theo dự án, tổ đội hoặc trưởng phòng ban.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {readyData.resource_assignments.map((item) => {
                  const meta = formatResourceAssignmentKindLabel(item.assignment_kind);
                  return (
                    <div
                      key={`${item.assignment_kind}:${item.resource_ref}`}
                      className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs"
                    >
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                      <span className="font-medium text-foreground">{item.resource_label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <FormDialog
        open={dialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title={
          dialog?.kind === "assign"
            ? "Thêm vào nhóm quyền"
            : dialog?.kind === "remove"
              ? `Gỡ khỏi nhóm "${dialog.membership.group_name}"`
              : ""
        }
        description={
          dialog?.kind === "assign"
            ? "Chọn nhóm quyền theo phòng ban phù hợp. Quyền sẽ có hiệu lực từ yêu cầu tiếp theo."
            : "Gỡ khỏi nhóm sẽ thu hồi quyền thuộc nhóm đó từ yêu cầu tiếp theo và không xóa lịch sử dữ liệu đã nộp."
        }
        closeDisabled={busy}
      >
        {dialog ? (
          <form onSubmit={executeMutation} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
                {conflictLocked ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        closeDialog();
                        reloadNow();
                      }}
                    >
                      Tải lại dữ liệu mới nhất
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            {dialog.kind === "assign" ? (
              <div className="space-y-2">
                <label htmlFor={groupSelectId} className="block text-sm font-medium text-foreground">
                  Nhóm quyền
                </label>
                <select
                  id={groupSelectId}
                  value={selectedGroupId}
                  disabled={busy || conflictLocked || pendingIntent !== null}
                  onChange={(e) => setSelectedGroupId(e.target.value)}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  {assignableGroups.map((group) => (
                    <option key={group.group_id} value={group.group_id}>
                      {group.name} — {group.department_name}
                      {group.team_name ? ` / ${group.team_name}` : ""}
                    </option>
                  ))}
                </select>
                {selectedAssignGroup ? (
                  <div className="rounded-lg border border-border bg-surface-muted/30 p-3 text-xs space-y-1.5">
                    {selectedAssignGroup.description ? (
                      <p className="text-muted">{selectedAssignGroup.description}</p>
                    ) : null}
                    <p className="font-medium text-foreground">Hành động được phép:</p>
                    <ul className="list-disc pl-4 space-y-0.5 text-muted">
                      {summarizeGroupBusinessActions(selectedAssignGroup).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <Alert tone="info" title="Xác nhận thay đổi nhóm quyền">
                Người dùng sẽ được gỡ khỏi nhóm <strong>{dialog.membership.group_name}</strong>{" "}
                ({dialog.membership.department_name}). Các phân công dự án/tổ đội độc lập không bị
                xóa.
              </Alert>
            )}

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thay đổi (không bắt buộc)
              </label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={500}
                value={reason}
                disabled={busy || conflictLocked || pendingIntent !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ví dụ: Điều chuyển công việc sang nhóm mới…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant={dialog.kind === "remove" ? "danger" : "primary"}
                disabled={busy || conflictLocked}
              >
                {busy
                  ? "Đang lưu…"
                  : pendingIntent
                    ? "Thử đồng bộ lại"
                    : dialog.kind === "assign"
                      ? "Xác nhận thêm nhóm"
                      : "Xác nhận gỡ khỏi nhóm"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </Card>
  );
}
