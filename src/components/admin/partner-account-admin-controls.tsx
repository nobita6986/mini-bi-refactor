"use client";

import { useState, type FormEvent } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, RefreshCw, ShieldAlert, UserPlus } from "lucide-react";

import {
  PartnerAccountStateBadge,
  extractPartnerApiErrorCode,
  formatPartnerDateVi,
} from "@/components/partner/partner-ui-shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { newAccountOperationKey } from "@/lib/admin/account-operation-ui-model";
import type { PartnerKind } from "@/lib/auth/direct-entry-v2";
import { newIdempotencyKey, normalizeOptionalActionReason, validateReason } from "@/lib/direct-entry/project-operations-model";
import type { PartnerAccountSummary } from "@/lib/direct-entry/vendor-catalog-contract";
import {
  projectConflictsReport,
  type PartnerConflictsReport,
} from "@/lib/partner/contract";

type IssuedActivationResult = {
  title: string;
  canonicalCode: string;
  activationCode: string;
  expiresAt: string;
  resumed?: boolean;
};

type DialogMode =
  | { kind: "provision" }
  | { kind: "rotate" }
  | { kind: "reset-password" }
  | { kind: "issued"; result: IssuedActivationResult };

const PARTNER_ADMIN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  UNAUTHENTICATED: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  ACTOR_NOT_AVAILABLE: "Chỉ Full Admin mới có quyền thực hiện thao tác tài khoản đối tác.",
  PARTNER_FORBIDDEN: "Chỉ Full Admin mới có quyền thực hiện thao tác tài khoản đối tác.",
  PARTNER_CODE_CONFLICT: "Mã đối tác đang bị xung đột giữa danh mục Vendor và CTV. Cần xử lý xung đột trước khi cấp tài khoản.",
  PARTNER_CONFLICT: "Tài khoản đối tác đang xung đột hoặc có thao tác khác đang xử lý.",
  PARTNER_PARENT_INACTIVE: "Đối tác đang ngừng hoạt động. Vui lòng kích hoạt lại đối tác trước.",
  PARTNER_ALREADY_PROVISIONED: "Đối tác này đã được cấp tài khoản.",
  PARTNER_ALREADY_ACTIVATED: "Tài khoản đối tác đã kích hoạt, không thể cấp lại mã kích hoạt.",
  PARTNER_NOT_PROVISIONED: "Đối tác chưa có tài khoản đăng nhập để đặt lại mật khẩu.",
  PARTNER_PROVISION_INDETERMINATE: "Chưa xác định được kết quả cấp tài khoản trên hệ thống xác thực. Vui lòng thử bấm cấp lại để đối chiếu an toàn.",
  PARTNER_INVALID: "Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
  CSRF_REJECTED: "Phiên làm việc không hợp lệ. Vui lòng tải lại trang.",
});

function mapPartnerAdminError(status: number, code: string | null): string {
  if (status === 401) return PARTNER_ADMIN_ERROR_MESSAGES.UNAUTHENTICATED;
  if (status === 403) {
    return (code && PARTNER_ADMIN_ERROR_MESSAGES[code]) || PARTNER_ADMIN_ERROR_MESSAGES.PARTNER_FORBIDDEN;
  }
  if (code && PARTNER_ADMIN_ERROR_MESSAGES[code]) {
    return PARTNER_ADMIN_ERROR_MESSAGES[code];
  }
  if (status === 400 || status === 422) return PARTNER_ADMIN_ERROR_MESSAGES.PARTNER_INVALID;
  return "Dịch vụ quản trị tài khoản đối tác hiện không khả dụng. Vui lòng thử lại.";
}

export function isPartnerRowConflicted(
  report: PartnerConflictsReport | null,
  partnerKind: PartnerKind,
  partnerId: string,
): boolean {
  if (!report || !report.has_conflicts) return false;
  if (
    report.intra_catalog_duplicates.some(
      (g) => g.partner_kind === partnerKind && g.rows.some((r) => r.partner_id === partnerId),
    )
  ) {
    return true;
  }
  if (
    report.cross_catalog_duplicates.some((g) =>
      g.rows.some((r) => r.partner_kind === partnerKind && r.partner_id === partnerId),
    )
  ) {
    return true;
  }
  return report.unregistered_catalog_rows.some(
    (r) => r.partner_kind === partnerKind && r.partner_id === partnerId,
  );
}

export function PartnerCatalogConflictsPanel({
  report,
  onReportLoaded,
}: {
  report: PartnerConflictsReport | null;
  onReportLoaded: (report: PartnerConflictsReport | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkConflicts() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/partners/conflicts", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => null);
      const code = extractPartnerApiErrorCode(payload);
      if (response.status !== 200) {
        setError(mapPartnerAdminError(response.status, code));
        return;
      }
      if (
        payload &&
        typeof payload === "object" &&
        "ok" in payload &&
        (payload as { ok: unknown }).ok === true &&
        "report" in payload
      ) {
        const projected = projectConflictsReport((payload as { report: unknown }).report);
        if (projected) {
          onReportLoaded(projected);
          return;
        }
      }
      setError("Phản hồi kiểm tra xung đột mã đối tác không hợp lệ.");
    } catch {
      setError("Không thể kết nối máy chủ để kiểm tra xung đột mã đối tác.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-muted/50 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <ShieldAlert aria-hidden className="h-4 w-4 text-primary shrink-0" />
          <span className="font-medium text-foreground">
            Kiểm tra xung đột mã đăng nhập đối tác (Vendor &amp; CTV)
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => void checkConflicts()}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          {busy ? "Đang kiểm tra…" : "Kiểm tra xung đột mã"}
        </Button>
      </div>

      {error ? (
        <Alert tone="error" role="alert" title="Không kiểm tra được xung đột mã">
          <p>{error}</p>
        </Alert>
      ) : null}

      {report ? (
        report.has_conflicts ? (
          <Alert
            tone="warning"
            role="alert"
            title={`Phát hiện ${report.conflict_count} xung đột mã đối tác (kiểm tra lúc ${formatPartnerDateVi(report.checked_at)})`}
          >
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
              {report.cross_catalog_duplicates.length > 0 ? (
                <li>
                  Trùng mã giữa Vendor và CTV ({report.cross_catalog_duplicates.length}):{" "}
                  <span className="font-mono">
                    {report.cross_catalog_duplicates.map((item) => item.canonical_code).join(", ")}
                  </span>
                </li>
              ) : null}
              {report.intra_catalog_duplicates.length > 0 ? (
                <li>
                  Trùng mã trong cùng danh mục ({report.intra_catalog_duplicates.length}):{" "}
                  <span className="font-mono">
                    {report.intra_catalog_duplicates
                      .map((item) => `${item.partner_kind}:${item.canonical_code}`)
                      .join(", ")}
                  </span>
                </li>
              ) : null}
              {report.unregistered_catalog_rows.length > 0 ? (
                <li>
                  Bản ghi chưa đăng ký registry ({report.unregistered_catalog_rows.length}):{" "}
                  <span className="font-mono">
                    {report.unregistered_catalog_rows
                      .map((item) => `${item.partner_kind}:${item.partner_id}`)
                      .join(", ")}
                  </span>
                </li>
              ) : null}
              {report.auth_email_collisions.length > 0 ? (
                <li>
                  Trùng tài khoản đăng nhập Auth ({report.auth_email_collisions.length}):{" "}
                  <span className="font-mono">
                    {report.auth_email_collisions.map((item) => item.canonical_code).join(", ")}
                  </span>
                </li>
              ) : null}
            </ul>
          </Alert>
        ) : (
          <p className="text-xs text-status-success-text">
            Không phát hiện xung đột mã đối tác (0 vấn đề · kiểm tra lúc {formatPartnerDateVi(report.checked_at)}).
          </p>
        )
      ) : null}
    </div>
  );
}

export function PartnerAccountCatalogCell({
  partnerKind,
  partnerCode,
  displayName,
  partnerActive,
  partnerAccount,
  hasConflict = false,
  disabled = false,
  onMutated,
}: {
  partnerKind: PartnerKind;
  partnerCode: string;
  displayName: string;
  partnerActive: boolean;
  partnerAccount: PartnerAccountSummary | null | undefined;
  hasConflict?: boolean;
  disabled?: boolean;
  onMutated: () => void;
}) {
  const notify = useNotify();
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [reason, setReason] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const accountState = partnerAccount?.account_state ?? "UNPROVISIONED";
  const isUnprovisioned = !partnerAccount || accountState === "UNPROVISIONED";
  const isPendingActivation = accountState === "PENDING_ACTIVATION";
  const isProvisioned = Boolean(
    partnerAccount && partnerAccount.account_state !== "UNPROVISIONED" && partnerAccount.app_user_id,
  );

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setReason("");
    setNewPassword("");
    setConfirmPassword("");
    setShowNew(false);
    setShowConfirm(false);
    setError(null);
    setCopied(false);
  }

  async function submitProvisionOrRotate(mode: "provision" | "rotate", event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const reasonError = validateReason(reason);
    if (reasonError) {
      setError(reasonError);
      return;
    }

    const idempotencyKey = newIdempotencyKey();
    const endpoint =
      mode === "provision"
        ? `/api/admin/partners/${partnerKind}/${encodeURIComponent(partnerCode)}/provision`
        : `/api/admin/partners/${partnerKind}/${encodeURIComponent(partnerCode)}/activation-code`;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          reason: normalizeOptionalActionReason(reason),
          idempotency_key: idempotencyKey,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const code = extractPartnerApiErrorCode(payload);
      if (response.status !== 200) {
        const msg = mapPartnerAdminError(response.status, code);
        setError(msg);
        notify.error({ title: msg });
        return;
      }

      const data =
        payload && typeof payload === "object"
          ? mode === "provision"
            ? (payload as { provision?: unknown }).provision
            : (payload as { activation?: unknown }).activation
          : null;

      if (
        data &&
        typeof data === "object" &&
        typeof (data as { activation_code?: unknown }).activation_code === "string" &&
        typeof (data as { activation_expires_at?: unknown }).activation_expires_at === "string"
      ) {
        const rec = data as {
          canonical_code?: string;
          activation_code: string;
          activation_expires_at: string;
          resumed?: boolean;
        };
        setReason("");
        setDialog({
          kind: "issued",
          result: {
            title: mode === "provision" ? "Đã cấp tài khoản đối tác" : "Đã cấp lại mã kích hoạt",
            canonicalCode: rec.canonical_code ?? partnerCode,
            activationCode: rec.activation_code,
            expiresAt: rec.activation_expires_at,
            resumed: rec.resumed,
          },
        });
        notify.success({
          title: mode === "provision" ? "Đã cấp tài khoản đối tác" : "Đã cấp lại mã kích hoạt",
        });
        onMutated();
        return;
      }

      setError("Phản hồi từ máy chủ không đầy đủ. Vui lòng tải lại danh sách.");
    } catch {
      setError("Không thể kết nối máy chủ. Có thể thử lại an toàn.");
    } finally {
      setBusy(false);
    }
  }

  async function submitResetPassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (newPassword.length < 8) {
      setError("Mật khẩu mới phải có ít nhất 8 ký tự.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }
    const reasonError = validateReason(reason);
    if (reasonError) {
      setError(reasonError);
      return;
    }

    const idempotencyKey = newAccountOperationKey();
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/partners/${partnerKind}/${encodeURIComponent(partnerCode)}/reset-password`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            new_password: newPassword,
            new_password_confirm: confirmPassword,
            reason: normalizeOptionalActionReason(reason),
            idempotency_key: idempotencyKey,
          }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const code = extractPartnerApiErrorCode(payload);
      setNewPassword("");
      setConfirmPassword("");

      if (
        response.status === 200 &&
        payload &&
        typeof payload === "object" &&
        "ok" in payload &&
        (payload as { ok: unknown }).ok === true
      ) {
        setReason("");
        setDialog(null);
        notify.success({ title: "Đã đặt lại mật khẩu cho đối tác." });
        onMutated();
        return;
      }

      const msg = mapPartnerAdminError(response.status, code);
      setError(msg);
      notify.error({ title: msg });
    } catch {
      setNewPassword("");
      setConfirmPassword("");
      const msg = "Mất kết nối trong lúc đặt lại mật khẩu. Vui lòng kiểm tra trước khi thử lại.";
      setError(msg);
      notify.error({ title: msg });
    } finally {
      setBusy(false);
    }
  }

  async function copyActivationCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      notify.success({ title: "Đã sao chép mã kích hoạt." });
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <PartnerAccountStateBadge state={accountState} hasConflict={hasConflict} />
        {partnerAccount?.username ? (
          <span className="font-mono text-xs text-muted">@{partnerAccount.username}</span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {isUnprovisioned && !hasConflict ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !partnerActive}
            title={!partnerActive ? "Cần kích hoạt đối tác trước khi cấp tài khoản" : undefined}
            onClick={() => {
              setError(null);
              setReason("");
              setDialog({ kind: "provision" });
            }}
          >
            <UserPlus aria-hidden className="h-3.5 w-3.5" />
            Cấp tài khoản
          </Button>
        ) : null}

        {isPendingActivation ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !partnerActive}
            onClick={() => {
              setError(null);
              setReason("");
              setDialog({ kind: "rotate" });
            }}
          >
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            Cấp lại mã kích hoạt
          </Button>
        ) : null}

        {isProvisioned ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setError(null);
              setReason("");
              setNewPassword("");
              setConfirmPassword("");
              setDialog({ kind: "reset-password" });
            }}
          >
            <KeyRound aria-hidden className="h-3.5 w-3.5" />
            Đặt lại mật khẩu
          </Button>
        ) : null}
      </div>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        closeDisabled={busy}
        title={
          dialog?.kind === "provision"
            ? "Cấp tài khoản đối tác"
            : dialog?.kind === "rotate"
              ? "Cấp lại mã kích hoạt"
              : dialog?.kind === "reset-password"
                ? "Đặt lại mật khẩu đối tác"
                : dialog?.result.title ?? ""
        }
        description={`${displayName} (${partnerCode})`}
      >
        {dialog?.kind === "issued" ? (
          <div className="space-y-4">
            <Alert tone="info" title="Mã kích hoạt chỉ hiển thị một lần">
              <p>
                Gửi mã kích hoạt dưới đây cho đối tác để kích hoạt tại trang{" "}
                <span className="font-mono">/activate</span>.
              </p>
            </Alert>

            <div className="space-y-2 rounded-lg border border-border bg-surface-muted p-3.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Mã đăng nhập</span>
                <span className="font-mono font-semibold text-foreground">
                  {dialog.result.canonicalCode}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Mã kích hoạt một lần</span>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-surface px-2 py-1 font-mono text-sm font-bold text-primary border border-border">
                    {dialog.result.activationCode}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyActivationCode(dialog.result.activationCode)}
                  >
                    {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
                    {copied ? "Đã chép" : "Sao chép"}
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Hiệu lực đến</span>
                <span className="text-foreground">{formatPartnerDateVi(dialog.result.expiresAt)}</span>
              </div>
            </div>

            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
              Lưu ý mật khẩu khởi tạo mặc định cho lần đăng nhập đầu tiên là{" "}
              <code className="font-mono font-semibold">hrp@123</code> (hệ thống sẽ bắt buộc đổi mật khẩu ngay sau khi đăng nhập).
            </p>

            <div className="flex justify-end border-t border-border pt-3">
              <Button type="button" variant="primary" onClick={closeDialog}>
                Đóng
              </Button>
            </div>
          </div>
        ) : dialog?.kind === "provision" || dialog?.kind === "rotate" ? (
          <form
            onSubmit={(event) => void submitProvisionOrRotate(dialog.kind, event)}
            className="space-y-4"
          >
            <p className="text-sm text-muted">
              {dialog.kind === "provision"
                ? "Hệ thống sẽ tạo tài khoản đăng nhập cho đối tác ở trạng thái chờ kích hoạt và sinh mã kích hoạt một lần (hiệu lực 7 ngày)."
                : "Mã kích hoạt cũ sẽ bị thu hồi ngay lập tức và thay thế bằng mã kích hoạt một lần mới."}
            </p>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Lý do thao tác (không bắt buộc)
              <textarea
                value={reason}
                maxLength={4000}
                rows={2}
                onChange={(event) => setReason(event.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-status-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Hủy
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {busy
                  ? "Đang xử lý…"
                  : dialog.kind === "provision"
                    ? "Xác nhận cấp tài khoản"
                    : "Xác nhận cấp lại mã"}
              </Button>
            </div>
          </form>
        ) : dialog?.kind === "reset-password" ? (
          <form onSubmit={(event) => void submitResetPassword(event)} className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`partner-reset-pw-${partnerCode}`} className="text-sm font-medium">
                Mật khẩu mới
              </label>
              <div className="relative">
                <input
                  id={`partner-reset-pw-${partnerCode}`}
                  type={showNew ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  minLength={8}
                  required
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  className="min-h-11 h-11 w-full rounded-md border border-border bg-surface px-3 pr-11 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  aria-label={showNew ? "Ẩn mật khẩu mới" : "Hiện mật khẩu mới"}
                  className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted hover:text-foreground"
                >
                  {showNew ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`partner-reset-pw-confirm-${partnerCode}`} className="text-sm font-medium">
                Xác nhận mật khẩu mới
              </label>
              <div className="relative">
                <input
                  id={`partner-reset-pw-confirm-${partnerCode}`}
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  minLength={8}
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="min-h-11 h-11 w-full rounded-md border border-border bg-surface px-3 pr-11 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? "Ẩn xác nhận mật khẩu" : "Hiện xác nhận mật khẩu"}
                  className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted hover:text-foreground"
                >
                  {showConfirm ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Lý do đặt lại mật khẩu (không bắt buộc)
              <textarea
                value={reason}
                maxLength={4000}
                rows={2}
                onChange={(event) => setReason(event.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-status-danger-text">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeDialog}>
                Hủy
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? "Đang cập nhật…" : "Xác nhận đặt lại"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
