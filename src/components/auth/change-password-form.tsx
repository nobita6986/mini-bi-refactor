"use client";

/**
 * P3-W09A - Self-service password change form (client).
 *
 *   - The server decides the target account from the live session; the form
 *     only collects the current password (re-auth) plus the new password
 *     and its confirmation.
 *   - All Supabase or RBAC error codes are mapped through
 *     `authUiErrorMessage` so the UI never echoes a raw provider detail.
 *   - Passwords are never persisted, logged, or echoed back; the inputs
 *     are cleared on reset and on error.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Eye, EyeOff } from "lucide-react";

import { useNotify } from "@/components/ui/notify-provider";
import { authUiErrorMessage } from "@/lib/auth/auth-ui";

export function ChangePasswordForm({
  destination,
  successRedirectTo,
  isFirstLogin = false,
}: {
  destination: string;
  successRedirectTo?: string;
  isFirstLogin?: boolean;
}) {
  const router = useRouter();
  const notify = useNotify();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowCurrent(false);
    setShowNew(false);
    setShowConfirm(false);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      if (response.ok) {
        setSuccess(true);
        notify.success({ title: "Đổi mật khẩu thành công." });
        reset();
        // Refresh so the AppShell picks up the rotated session tokens
        // and any user display that depends on `verified_at`.
        if (successRedirectTo) {
          router.replace(successRedirectTo);
        }
        router.refresh();
        return;
      }
      let errorCode = "AUTH_UNAVAILABLE";
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && "code" in payload &&
            typeof (payload as { code: unknown }).code === "string") {
          errorCode = (payload as { code: string }).code;
        }
      } catch { /* ignore */ }
      reset();
      const errMsg = authUiErrorMessage(errorCode);
      setError(errMsg);
      notify.error({ title: errMsg });
      if (errorCode === "AUTH_UNAUTHENTICATED") {
        router.replace(destination);
        router.refresh();
      }
    } catch {
      reset();
      const errMsg = authUiErrorMessage("AUTH_UNAVAILABLE");
      setError(errMsg);
      notify.error({ title: errMsg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {isFirstLogin ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Vui lòng nhập mật khẩu khởi tạo do quản trị viên cung cấp và thiết lập mật khẩu mới trước khi sử dụng cổng đối tác.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="current-password" className="text-sm font-medium text-foreground">
          Mật khẩu hiện tại
        </label>
        <div className="relative">
          <input
            id="current-password"
            name="currentPassword"
            type={showCurrent ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            enterKeyHint="next"
            required
            value={currentPassword}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "change-password-error" : undefined}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="min-h-11 h-11 w-full rounded-md border border-border bg-surface px-3 pr-11 text-base sm:text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600"
          />
          <button
            type="button"
            onClick={() => setShowCurrent((value) => !value)}
            aria-label={showCurrent ? "Ẩn mật khẩu hiện tại" : "Hiện mật khẩu hiện tại"}
            className="absolute right-0 top-0 flex min-h-11 min-w-11 h-11 w-11 items-center justify-center rounded-md text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {showCurrent ? <EyeOff aria-hidden className="h-5 w-5" /> : <Eye aria-hidden className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-password" className="text-sm font-medium text-foreground">
          Mật khẩu mới
        </label>
        <div className="relative">
          <input
            id="new-password"
            name="newPassword"
            type={showNew ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            enterKeyHint="next"
            minLength={8}
            required
            value={newPassword}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "change-password-error" : "change-password-hint"}
            onChange={(event) => setNewPassword(event.target.value)}
            className="min-h-11 h-11 w-full rounded-md border border-border bg-surface px-3 pr-11 text-base sm:text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600"
          />
          <button
            type="button"
            onClick={() => setShowNew((value) => !value)}
            aria-label={showNew ? "Ẩn mật khẩu mới" : "Hiện mật khẩu mới"}
            className="absolute right-0 top-0 flex min-h-11 min-w-11 h-11 w-11 items-center justify-center rounded-md text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {showNew ? <EyeOff aria-hidden className="h-5 w-5" /> : <Eye aria-hidden className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm-password" className="text-sm font-medium text-foreground">
          Xác nhận mật khẩu mới
        </label>
        <div className="relative">
          <input
            id="confirm-password"
            name="confirmPassword"
            type={showConfirm ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            enterKeyHint="done"
            minLength={8}
            required
            value={confirmPassword}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "change-password-error" : undefined}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="min-h-11 h-11 w-full rounded-md border border-border bg-surface px-3 pr-11 text-base sm:text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600"
          />
          <button
            type="button"
            onClick={() => setShowConfirm((value) => !value)}
            aria-label={showConfirm ? "Ẩn xác nhận mật khẩu" : "Hiện xác nhận mật khẩu"}
            className="absolute right-0 top-0 flex min-h-11 min-w-11 h-11 w-11 items-center justify-center rounded-md text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {showConfirm ? <EyeOff aria-hidden className="h-5 w-5" /> : <Eye aria-hidden className="h-5 w-5" />}
          </button>
        </div>
      </div>

      <p id="change-password-hint" className="text-xs text-muted">
        Tối thiểu 8 ký tự và phải khác mật khẩu hiện tại.
      </p>

      {error && (
        <p id="change-password-error" role="alert" aria-live="polite"
          className="rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text">
          {error}
        </p>
      )}

      {success && (
        <p role="status" aria-live="polite"
          className="flex items-center gap-2 rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-sm text-status-success-text">
          <Check aria-hidden className="h-4 w-4" />
          Đổi mật khẩu thành công. Hãy dùng mật khẩu mới cho lần đăng nhập sau.
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="min-h-11 h-11 rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {busy ? "Đang đổi mật khẩu…" : "Đổi mật khẩu"}
      </button>
    </form>
  );
}