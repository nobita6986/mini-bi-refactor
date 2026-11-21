"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AccountGroupsSection } from "@/components/admin/account-groups-section";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import {
  buildAccountStateRequest,
  classifyAccountMutation,
  newAccountIntentKey,
} from "@/lib/admin/account-access-model";
import {
  buildEditDisplayNameRequest,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
import { classifyPersonOrgReadError } from "@/lib/admin/person-org-ui-model";
import {
  formatUserDirectoryConflictReason,
  projectUserDirectoryEntryEnvelope,
  userDirectoryLoginBadge,
  type UserDirectoryEntryDetail,
} from "@/lib/admin/user-directory-ui-model";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; entry: UserDirectoryEntryDetail }
  | { kind: "not-found"; message: string }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

type DialogKind =
  | { kind: "edit-display-name"; expectedVersion: number }
  | { kind: "toggle-login"; nextEnabled: boolean; expectedVersion: number }
  | { kind: "reset-password"; manualCheckLocked: boolean };

export function AccountDirectoryDetailManager({
  accountRef,
  canManageGroups = true,
}: {
  accountRef: string;
  canManageGroups?: boolean;
}) {
  const notify = useNotify();
  const workspaceGuard = useWp4WorkspaceGuard();
  const reasonId = useId();
  const displayNameId = useId();
  const pwdId = useId();
  const pwdConfirmId = useId();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [latestAccountVersion, setLatestAccountVersion] = useState<number | null>(null);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [reason, setReason] = useState("");
  // RAM-only password state — NEVER stored in local/session storage
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingToggleKey, setPendingToggleKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "warning" | "info";
    title: string;
    message: string;
  } | null>(null);

  const reqSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const clearPasswords = useCallback(() => {
    setNewPassword("");
    setConfirmPassword("");
  }, []);

  useEffect(() => {
    return () => {
      inFlightRef.current = false;
      setNewPassword("");
      setConfirmPassword("");
    };
  }, []);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
      reqSeqRef.current += 1;
      clearPasswords();
      setDialog(null);
      setBusy(false);
      setState({ kind: "denied", message, unauthenticated });
    },
    [clearPasswords, workspaceGuard],
  );

  useEffect(() => {
    const reqSeq = ++reqSeqRef.current;
    const tracked = workspaceGuard.trackController();

    void (async () => {
      await Promise.resolve();
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
        tracked.release();
        return;
      }
      setState({ kind: "loading" });
      try {
        const response = await fetch(
          `/api/admin/organization/user-directory/entry?account_ref=${encodeURIComponent(accountRef)}`,
          {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          },
        );
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        if (response.status !== 200) {
          const err = classifyPersonOrgReadError(response.status, payload);
          if (err.kind === "unauthenticated" || err.kind === "denied") {
            handleSessionLost(err.message, err.kind === "unauthenticated");
            return;
          }
          if (err.kind === "not-found") {
            setState({ kind: "not-found", message: err.message });
            return;
          }
          setState({ kind: "error", message: err.message, retryable: err.retryable });
          return;
        }
        const projected = projectUserDirectoryEntryEnvelope(payload);
        if (!projected || !projected.entry.account) {
          setState({
            kind: "error",
            message: "Phản hồi chi tiết tài khoản chưa đầy đủ.",
            retryable: true,
          });
          return;
        }
        setLatestAccountVersion(projected.entry.account.version);
        setState({ kind: "ready", entry: projected.entry });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== reqSeqRef.current) {
          return;
        }
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải thông tin người dùng.",
          retryable: true,
        });
      } finally {
        tracked.release();
      }
    })();

    return () => {
      reqSeqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [accountRef, handleSessionLost, reloadToken, workspaceGuard]);

  const reloadNow = useCallback(() => {
    setReloadToken((v) => v + 1);
  }, []);

  const closeDialog = useCallback(() => {
    if (busy) return;
    clearPasswords();
    setDialog(null);
    setReason("");
    setPendingToggleKey(null);
    setConflictLocked(false);
    setFeedback(null);
  }, [busy, clearPasswords]);

  const entry = state.kind === "ready" ? state.entry : null;
  const account = entry?.account ?? null;
  const effectiveVersion = latestAccountVersion ?? account?.version ?? 1;

  const submitEditDisplayName = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      dialog.kind !== "edit-display-name" ||
      !account ||
      inFlightRef.current ||
      busy ||
      conflictLocked
    ) {
      return;
    }
    const idempotencyKey = pendingToggleKey ?? newAccountOperationKey();
    const built = buildEditDisplayNameRequest({
      displayName: displayNameInput,
      expectedVersion: dialog.expectedVersion,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Tên hiển thị chưa hợp lệ", message: built.message });
      return;
    }

    setPendingToggleKey(idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/display-name`,
        {
          method: "PATCH",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "edit_display_name",
        expectedAccountRef: accountRef,
      });
      if (outcome.kind === "denied") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "applied") {
        setPendingToggleKey(null);
        setDialog(null);
        setReason("");
        notify.success({ title: "Đã cập nhật tên hiển thị" });
        reloadNow();
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingToggleKey(null);
        setConflictLocked(true);
        setFeedback({ tone: "warning", title: "Dữ liệu đã thay đổi", message: outcome.message });
        return;
      }
      if (outcome.kind === "invalid") {
        setPendingToggleKey(null);
        setFeedback({ tone: "error", title: "Không thể cập nhật tên hiển thị", message: outcome.message });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: "Bấm lưu lần nữa để đồng bộ an toàn mà không bị trùng.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Chưa rõ thay đổi đã lưu hay chưa. Bấm lưu lần nữa để đồng bộ an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitToggleLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== "toggle-login" || !account || inFlightRef.current || busy || conflictLocked) {
      return;
    }

    const idempotencyKey = pendingToggleKey ?? newAccountIntentKey();
    const built = buildAccountStateRequest({
      expectedVersion: dialog.expectedVersion,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Dữ liệu chưa hợp lệ", message: built.message });
      return;
    }

    setPendingToggleKey(idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const action = dialog.nextEnabled ? "enable" : "disable";
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/${action}`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountMutation(response.status, payload);
      if (outcome.kind === "unauthenticated" || outcome.kind === "denied" || outcome.kind === "actor-not-available") {
        handleSessionLost(outcome.message, outcome.kind === "unauthenticated");
        return;
      }
      if (outcome.kind === "applied") {
        setPendingToggleKey(null);
        setDialog(null);
        setReason("");
        notify.success({
          title: dialog.nextEnabled ? "Đã mở lại đăng nhập" : "Đã khóa đăng nhập",
          description: "Lịch sử làm việc và dữ liệu đã nộp vẫn được giữ nguyên.",
        });
        reloadNow();
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingToggleKey(null);
        setConflictLocked(true);
        setFeedback({ tone: "warning", title: "Dữ liệu đã thay đổi", message: outcome.message });
        return;
      }
      if (outcome.kind === "invalid" || outcome.kind === "not-found") {
        setPendingToggleKey(null);
        setFeedback({ tone: "error", title: "Không thể cập nhật", message: outcome.message });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: "Bấm xác nhận lại để đồng bộ trạng thái an toàn mà không bị trùng.",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Chưa rõ thao tác đã lưu hay chưa. Bấm xác nhận lần nữa để đồng bộ an toàn.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const submitResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !dialog ||
      dialog.kind !== "reset-password" ||
      dialog.manualCheckLocked ||
      !account ||
      inFlightRef.current ||
      busy
    ) {
      return;
    }

    const resetKey = newAccountOperationKey();
    const built = buildResetPasswordRequest({
      password: newPassword,
      passwordConfirm: confirmPassword,
      reason,
      idempotencyKey: resetKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", title: "Mật khẩu chưa hợp lệ", message: built.message });
      return;
    }

    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(account.account_ref)}/reset-password`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": resetKey,
          },
          body: JSON.stringify(built.body),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyAccountOperationResponse(response.status, payload, {
        operation: "reset_password",
      });
      if (outcome.kind === "denied") {
        handleSessionLost(outcome.message, response.status === 401);
        return;
      }
      if (outcome.kind === "applied") {
        clearPasswords();
        setDialog(null);
        setReason("");
        notify.success({
          title: "Đã đặt lại mật khẩu",
          description: "Người dùng sẽ dùng mật khẩu mới ở lần đăng nhập tiếp theo.",
        });
        return;
      }
      if (
        outcome.kind === "needs-reconcile" ||
        (outcome.kind === "unavailable" && outcome.manualCheckRequired)
      ) {
        // Never blindly retry Auth password writes on uncertain responses!
        clearPasswords();
        setDialog({ kind: "reset-password", manualCheckLocked: true });
        setFeedback({
          tone: "warning",
          title: "Cần xác minh mật khẩu trước khi thao tác tiếp",
          message: outcome.message,
        });
        return;
      }
      setFeedback({
        tone: outcome.kind === "invalid" ? "error" : "warning",
        title: "Không đặt lại được mật khẩu",
        message: outcome.message,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      clearPasswords();
      setDialog({ kind: "reset-password", manualCheckLocked: true });
      setFeedback({
        tone: "warning",
        title: "Mất kết nối trong lúc đặt lại mật khẩu",
        message:
          "Hệ thống không tự gửi lại yêu cầu đổi mật khẩu để tránh ghi đè ngoài ý muốn. Hãy kiểm tra lại trạng thái đăng nhập của người dùng trước khi thử lại.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  return (
    <PageShell
      dataTestId="account-directory-detail-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <div className="mb-3">
        <Link
          href="/admin/organization/persons"
          className="text-sm font-medium text-primary hover:underline"
        >
          ← Quay lại danh sách Người dùng
        </Link>
      </div>

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải thông tin người dùng…
          </p>
        </Card>
      ) : null}

      {state.kind === "denied" ? (
        <Alert
          tone="error"
          role="alert"
          title={state.unauthenticated ? "Phiên đăng nhập đã hết hạn" : "Không có quyền truy cập"}
        >
          <p>{state.message}</p>
        </Alert>
      ) : null}

      {state.kind === "not-found" ? (
        <Card>
          <ErrorState title="Không tìm thấy người dùng" detail={state.message} />
        </Card>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được thông tin người dùng" detail={state.message} />
            {state.retryable ? (
              <Button type="button" variant="secondary" onClick={reloadNow}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {entry && account ? (
        <div className="space-y-5">
          <PageHeader
            eyebrow="Quản trị hệ thống · Người dùng"
            title={entry.display_name}
            badge={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={userDirectoryLoginBadge(entry.login_state).tone} dot>
                  {userDirectoryLoginBadge(entry.login_state).label}
                </StatusBadge>
                {entry.link_conflict ? (
                  <StatusBadge tone="warning">Cần kiểm tra xung đột</StatusBadge>
                ) : !entry.person ? (
                  <StatusBadge tone="info">Tài khoản chưa gắn hồ sơ nhân viên</StatusBadge>
                ) : null}
              </div>
            }
            description={
              account.login_id
                ? `Tên đăng nhập: ${account.login_id}`
                : "Tài khoản đăng nhập cá nhân hiện hữu trong hệ thống."
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {entry.person_id && !entry.link_conflict ? (
                  <Link
                    href={`/admin/organization/persons/${encodeURIComponent(entry.person_id)}`}
                    className={buttonClasses({ variant: "primary", size: "md" })}
                  >
                    Mở hồ sơ nhân viên đầy đủ
                  </Link>
                ) : null}
                <Button type="button" variant="secondary" size="md" onClick={reloadNow}>
                  Làm mới
                </Button>
              </div>
            }
          />

          {entry.link_conflict && entry.conflict_details ? (
            <Alert tone="warning" role="alert" title="Cần kiểm tra xung đột hồ sơ — tài khoản">
              <p>{formatUserDirectoryConflictReason(entry.conflict_details.reason)}</p>
              {entry.conflict_details.related_person_ids.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {entry.conflict_details.related_person_ids.map((pid) => (
                    <Link
                      key={pid}
                      href={`/admin/organization/persons/${encodeURIComponent(pid)}`}
                      className={buttonClasses({ variant: "secondary", size: "sm" })}
                    >
                      Mở hồ sơ liên quan
                    </Link>
                  ))}
                </div>
              ) : null}
            </Alert>
          ) : null}

          <Card>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <CardHeader
                title="Đăng nhập & Bảo mật"
                description="Khóa hoặc mở đăng nhập chỉ ảnh hưởng khả năng đăng nhập; lịch sử chấm công, nghỉ phép và báo cáo luôn được giữ nguyên."
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDisplayNameInput(account.display_name ?? entry.display_name);
                    setReason("");
                    setFeedback(null);
                    setConflictLocked(false);
                    setPendingToggleKey(null);
                    setDialog({
                      kind: "edit-display-name",
                      expectedVersion: effectiveVersion,
                    });
                  }}
                >
                  Sửa tên hiển thị
                </Button>
                <Button
                  type="button"
                  variant={account.enabled ? "danger-outline" : "primary"}
                  size="sm"
                  onClick={() => {
                    setReason("");
                    setFeedback(null);
                    setConflictLocked(false);
                    setPendingToggleKey(null);
                    setDialog({
                      kind: "toggle-login",
                      nextEnabled: !account.enabled,
                      expectedVersion: effectiveVersion,
                    });
                  }}
                >
                  {account.enabled ? "Khóa đăng nhập" : "Mở đăng nhập"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    clearPasswords();
                    setReason("");
                    setFeedback(null);
                    setDialog({ kind: "reset-password", manualCheckLocked: false });
                  }}
                >
                  Đặt lại mật khẩu
                </Button>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-muted">Tên hiển thị</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {account.display_name ?? entry.display_name}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Tên đăng nhập</dt>
                <dd className="mt-1 font-mono text-xs text-foreground">
                  {account.login_id ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted">Trạng thái đăng nhập</dt>
                <dd className="mt-1">
                  <StatusBadge tone={account.enabled ? "success" : "warning"} dot>
                    {account.enabled ? "Đang mở đăng nhập" : "Đã khóa đăng nhập"}
                  </StatusBadge>
                </dd>
              </div>
            </dl>
          </Card>

          <AccountGroupsSection
            accountRef={account.account_ref}
            canManageGroups={canManageGroups}
            workspaceGuard={workspaceGuard}
            reloadToken={reloadToken}
            onSessionLost={handleSessionLost}
            onAccountVersionChanged={setLatestAccountVersion}
          />
        </div>
      ) : null}

      <FormDialog
        open={dialog?.kind === "edit-display-name"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Sửa tên hiển thị"
        description="Cập nhật tên hiển thị của người dùng trên toàn hệ thống."
        closeDisabled={busy}
      >
        {dialog?.kind === "edit-display-name" ? (
          <form onSubmit={submitEditDisplayName} className="space-y-4">
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

            <div className="space-y-1.5">
              <label htmlFor={displayNameId} className="block text-sm font-medium text-foreground">
                Tên hiển thị <span aria-hidden="true">*</span>
              </label>
              <input
                id={displayNameId}
                type="text"
                required
                maxLength={256}
                value={displayNameInput}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thao tác (không bắt buộc)
              </label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={4000}
                value={reason}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú ngắn gọn nếu cần…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button type="submit" variant="primary" disabled={busy || conflictLocked}>
                {busy ? "Đang lưu…" : pendingToggleKey ? "Thử đồng bộ lại" : "Lưu tên hiển thị"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "toggle-login"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title={
          dialog?.kind === "toggle-login" && dialog.nextEnabled
            ? "Mở lại đăng nhập"
            : "Khóa đăng nhập người dùng"
        }
        description="Thao tác chỉ thay đổi khả năng đăng nhập vào hệ thống và giữ nguyên lịch sử dữ liệu."
        closeDisabled={busy}
      >
        {dialog?.kind === "toggle-login" ? (
          <form onSubmit={submitToggleLogin} className="space-y-4">
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

            <div className="space-y-1.5">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thao tác (không bắt buộc)
              </label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={4000}
                value={reason}
                disabled={busy || conflictLocked || pendingToggleKey !== null}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú ngắn gọn nếu cần…"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant={dialog.nextEnabled ? "primary" : "danger"}
                disabled={busy || conflictLocked}
              >
                {busy
                  ? "Đang lưu…"
                  : pendingToggleKey
                    ? "Thử đồng bộ lại"
                    : dialog.nextEnabled
                      ? "Xác nhận mở đăng nhập"
                      : "Xác nhận khóa đăng nhập"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === "reset-password"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        title="Đặt lại mật khẩu"
        description="Mật khẩu mới có hiệu lực ngay sau khi lưu. Hệ thống không lưu mật khẩu trong trình duyệt."
        closeDisabled={busy}
      >
        {dialog?.kind === "reset-password" ? (
          <form onSubmit={submitResetPassword} className="space-y-4">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor={pwdId} className="block text-sm font-medium text-foreground">
                Mật khẩu mới
              </label>
              <input
                id={pwdId}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                disabled={busy || dialog.manualCheckLocked}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor={pwdConfirmId} className="block text-sm font-medium text-foreground">
                Nhập lại mật khẩu mới
              </label>
              <input
                id={pwdConfirmId}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                disabled={busy || dialog.manualCheckLocked}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Đóng
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || dialog.manualCheckLocked}
              >
                {busy ? "Đang lưu…" : "Xác nhận đặt lại mật khẩu"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </PageShell>
  );
}
