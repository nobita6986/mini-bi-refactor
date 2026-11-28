"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ErrorState } from "@/components/reporting/error-state";
import {
  PartnerAccountStateBadge,
  extractPartnerApiErrorCode,
  formatPartnerDateVi,
} from "@/components/partner/partner-ui-shared";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { authUiErrorMessage } from "@/lib/auth/auth-ui";
import {
  normalizeOptionalPartnerAddressValue,
  normalizeOptionalPartnerPhoneValue,
  validatePartnerAddress,
  validatePartnerPhone,
} from "@/lib/direct-entry/vendor-catalog-contract";
import { newIdempotencyKey } from "@/lib/direct-entry/project-operations-model";
import {
  projectPartnerProfile,
  type PartnerProfile,
} from "@/lib/partner/contract";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; profile: PartnerProfile }
  | { kind: "forbidden"; message: string }
  | { kind: "error"; message: string };

export function PartnerProfileView() {
  const router = useRouter();
  const notify = useNotify();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);

  const syncForm = useCallback((profile: PartnerProfile) => {
    setDisplayName(profile.display_name);
    setAddress(profile.address ?? "");
    setPhone(profile.phone ?? "");
    setNameTouched(false);
    setPhoneTouched(false);
  }, []);

  const reloadProfile = useCallback(() => {
    setState({ kind: "loading" });
    setFormError(null);
    setReloadToken((v) => v + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/partner/profile", {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (controller.signal.aborted) return;
        const payload: unknown = await response.json().catch(() => null);
        const code = extractPartnerApiErrorCode(payload);
        if (response.status === 401) {
          router.replace("/login?next=/partner/profile");
          return;
        }
        if (response.status === 403) {
          if (code === "PASSWORD_CHANGE_REQUIRED") {
            router.replace("/partner/change-password");
            return;
          }
          if (code === "ACCOUNT_PENDING_ACTIVATION") {
            router.replace("/activate");
            return;
          }
          setState({ kind: "forbidden", message: authUiErrorMessage(code ?? "PARTNER_FORBIDDEN") });
          return;
        }
        if (
          response.status === 200 &&
          payload &&
          typeof payload === "object" &&
          "ok" in payload &&
          (payload as { ok: unknown }).ok === true &&
          "profile" in payload
        ) {
          const projected = projectPartnerProfile((payload as { profile: unknown }).profile);
          if (projected) {
            syncForm(projected);
            setState({ kind: "loaded", profile: projected });
            return;
          }
        }
        setState({ kind: "error", message: "Không thể tải thông tin hồ sơ đối tác." });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ kind: "error", message: "Không thể kết nối máy chủ để tải hồ sơ." });
      }
    })();
    return () => controller.abort();
  }, [reloadToken, router, syncForm]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || state.kind !== "loaded") return;

    setNameTouched(true);
    setPhoneTouched(true);
    setFormError(null);
    setConflictNotice(null);

    const trimmedName = displayName.trim();
    if (trimmedName.length < 1 || trimmedName.length > 256) {
      setFormError("Tên hiển thị bắt buộc và tối đa 256 ký tự.");
      return;
    }
    const addressError = validatePartnerAddress(address);
    if (addressError) {
      setFormError(addressError);
      return;
    }
    const phoneError = validatePartnerPhone(phone);
    if (phoneError) {
      setFormError(phoneError);
      return;
    }

    const idempotencyKey = newIdempotencyKey();
    setBusy(true);
    try {
      const response = await fetch("/api/partner/profile", {
        method: "PATCH",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          display_name: trimmedName,
          address: normalizeOptionalPartnerAddressValue(address),
          phone: normalizeOptionalPartnerPhoneValue(phone),
          expected_version: state.profile.version,
          idempotency_key: idempotencyKey,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const code = extractPartnerApiErrorCode(payload);

      if (response.status === 401) {
        router.replace("/login?next=/partner/profile");
        return;
      }
      if (response.status === 403) {
        if (code === "PASSWORD_CHANGE_REQUIRED") {
          router.replace("/partner/change-password");
          return;
        }
        setFormError(authUiErrorMessage(code ?? "PARTNER_FORBIDDEN"));
        return;
      }
      if (response.status === 409) {
        const msg = "Hồ sơ vừa được cập nhật ở nơi khác. Hệ thống đã tải lại dữ liệu mới nhất.";
        setConflictNotice(msg);
        notify.warning({ title: msg });
        reloadProfile();
        return;
      }
      if (
        response.status === 200 &&
        payload &&
        typeof payload === "object" &&
        "ok" in payload &&
        (payload as { ok: unknown }).ok === true &&
        "profile" in payload
      ) {
        const updated = projectPartnerProfile((payload as { profile: unknown }).profile);
        if (updated) {
          syncForm(updated);
          setState({ kind: "loaded", profile: updated });
          notify.success({ title: "Đã cập nhật hồ sơ đối tác." });
          router.refresh();
          return;
        }
      }
      setFormError("Thông tin cập nhật chưa hợp lệ. Vui lòng kiểm tra lại.");
    } catch {
      setFormError("Không thể lưu hồ sơ lúc này. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const nameInvalid = nameTouched && (displayName.trim().length < 1 || displayName.trim().length > 256);
  const phoneInvalid = phoneTouched && validatePartnerPhone(phone) !== null;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Cổng đối tác"
        title="Hồ sơ của tôi"
        description="Xem thông tin định danh cố định và cập nhật thông tin liên hệ của đối tác."
        actions={
          <Link
            href="/partner/change-password"
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            Đổi mật khẩu
          </Link>
        }
      />

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải hồ sơ đối tác…
          </p>
        </Card>
      ) : null}

      {state.kind === "forbidden" ? (
        <Card>
          <ErrorState title="Không có quyền truy cập" detail={state.message} />
        </Card>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được hồ sơ" detail={state.message} />
            <Button type="button" onClick={reloadProfile}>
              Thử tải lại
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "loaded" ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card>
            <CardHeader
              title="Thông tin tài khoản"
              description="Mã đối tác là định danh cố định, không thể tự thay đổi."
              action={<PartnerAccountStateBadge state={state.profile.account_state} />}
            />
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                <dt className="text-muted">Loại đối tác</dt>
                <dd className="font-medium text-foreground">
                  {state.profile.partner_kind === "VENDOR"
                    ? "Nhà cung cấp (Vendor)"
                    : "Cộng tác viên (CTV)"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                <dt className="text-muted">Mã đối tác (cố định)</dt>
                <dd className="font-mono font-semibold text-foreground">{state.profile.code}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                <dt className="text-muted">Tên đăng nhập</dt>
                <dd className="font-mono text-foreground">{state.profile.username}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-2.5">
                <dt className="text-muted">Kích hoạt lúc</dt>
                <dd className="text-foreground">{formatPartnerDateVi(state.profile.activated_at)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">Đổi mật khẩu gần nhất</dt>
                <dd className="text-foreground">{formatPartnerDateVi(state.profile.password_changed_at)}</dd>
              </div>
            </dl>
            <div className="mt-5 border-t border-border pt-4">
              <Link
                href="/partner/change-password"
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Đổi mật khẩu tài khoản
              </Link>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Cập nhật thông tin liên hệ"
              description="Thay đổi tên hiển thị, địa chỉ và số điện thoại liên hệ."
            />
            {conflictNotice ? (
              <div className="mb-4">
                <Alert tone="warning" title="Dữ liệu đã được làm mới">
                  <p>{conflictNotice}</p>
                </Alert>
              </div>
            ) : null}

            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="partner-profile-code" className="text-sm font-medium text-foreground">
                  Mã đối tác
                </label>
                <input
                  id="partner-profile-code"
                  type="text"
                  value={state.profile.code}
                  readOnly
                  disabled
                  aria-describedby="partner-profile-code-hint"
                  className="min-h-11 h-11 rounded-md border border-border bg-surface-muted px-3 font-mono text-sm text-muted opacity-80"
                />
                <p id="partner-profile-code-hint" className="text-xs text-muted">
                  Mã định danh cố định, chỉ quản trị viên mới quản lý trong danh mục.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="partner-profile-name" className="text-sm font-medium text-foreground">
                  Tên hiển thị
                </label>
                <input
                  id="partner-profile-name"
                  name="display_name"
                  type="text"
                  autoComplete="organization"
                  maxLength={256}
                  required
                  value={displayName}
                  aria-invalid={nameInvalid ? "true" : "false"}
                  aria-describedby={nameInvalid ? "partner-profile-name-err" : undefined}
                  onBlur={() => setNameTouched(true)}
                  onChange={(event) => {
                    setDisplayName(event.target.value);
                    setFormError(null);
                  }}
                  className="min-h-11 h-11 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
                />
                {nameInvalid ? (
                  <p id="partner-profile-name-err" className="text-xs text-status-danger-text">
                    Tên hiển thị bắt buộc và tối đa 256 ký tự.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="partner-profile-address" className="text-sm font-medium text-foreground">
                  Địa chỉ
                </label>
                <input
                  id="partner-profile-address"
                  name="address"
                  type="text"
                  autoComplete="street-address"
                  maxLength={500}
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setFormError(null);
                  }}
                  className="min-h-11 h-11 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="partner-profile-phone" className="text-sm font-medium text-foreground">
                  Số điện thoại
                </label>
                <input
                  id="partner-profile-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  spellCheck={false}
                  maxLength={32}
                  pattern="[0-9 +().-]+"
                  value={phone}
                  aria-invalid={phoneInvalid ? "true" : "false"}
                  aria-describedby={
                    phoneInvalid ? "partner-profile-phone-err" : "partner-profile-phone-hint"
                  }
                  onBlur={() => setPhoneTouched(true)}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setFormError(null);
                  }}
                  className="min-h-11 h-11 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
                />
                <p id="partner-profile-phone-hint" className="text-xs text-muted">
                  6–32 ký tự, chỉ gồm chữ số, khoảng trắng và + - . ( ). Để trống nếu muốn xóa.
                </p>
                {phoneInvalid ? (
                  <p id="partner-profile-phone-err" className="text-xs text-status-danger-text">
                    {validatePartnerPhone(phone)}
                  </p>
                ) : null}
              </div>

              {formError ? (
                <p
                  role="alert"
                  aria-live="polite"
                  className="rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text"
                >
                  {formError}
                </p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => syncForm(state.profile)}
                >
                  Khôi phục
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  {busy ? "Đang lưu…" : "Lưu thay đổi"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
