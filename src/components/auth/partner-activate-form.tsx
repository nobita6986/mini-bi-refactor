"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

import { authUiErrorMessage } from "@/lib/auth/auth-ui";

type ActivateSuccess = {
  partner_kind: "VENDOR" | "COLLABORATOR";
  partner_code: string;
};

export function PartnerActivateForm() {
  const [code, setCode] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [tokenTouched, setTokenTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activated, setActivated] = useState<ActivateSuccess | null>(null);

  const trimmedCode = code.trim();
  const trimmedToken = activationCode.trim();
  const codeInvalid = codeTouched && trimmedCode.length === 0;
  const tokenInvalid = tokenTouched && trimmedToken.length < 8;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setCodeTouched(true);
    setTokenTouched(true);
    setError(null);

    if (trimmedCode.length === 0 || trimmedToken.length < 8) {
      setError("Vui lòng nhập đầy đủ mã đối tác và mã kích hoạt hợp lệ (tối thiểu 8 ký tự).");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/activate-partner", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: trimmedCode,
          activation_code: trimmedToken,
        }),
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (
        response.ok &&
        payload &&
        typeof payload === "object" &&
        "ok" in payload &&
        (payload as { ok: unknown }).ok === true
      ) {
        const record = payload as {
          partner_kind?: unknown;
          partner_code?: unknown;
        };
        setActivated({
          partner_kind: record.partner_kind === "VENDOR" ? "VENDOR" : "COLLABORATOR",
          partner_code: typeof record.partner_code === "string" ? record.partner_code : trimmedCode,
        });
        setActivationCode("");
        return;
      }

      let errorCode = "PARTNER_ACTIVATION_INVALID";
      if (
        payload &&
        typeof payload === "object" &&
        "code" in payload &&
        typeof (payload as { code: unknown }).code === "string"
      ) {
        errorCode = (payload as { code: string }).code;
      }
      setError(authUiErrorMessage(errorCode));
    } catch {
      setError(authUiErrorMessage("AUTH_UNAVAILABLE"));
    } finally {
      setBusy(false);
    }
  }

  if (activated) {
    return (
      <div className="space-y-4">
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-status-success-border bg-status-success-bg px-4 py-3 text-sm text-status-success-text"
        >
          <p className="flex items-center gap-2 font-semibold">
            <Check aria-hidden className="h-4 w-4 shrink-0" />
            Kích hoạt tài khoản thành công
          </p>
          <p className="mt-1">
            Tài khoản{" "}
            <strong>
              {activated.partner_kind === "VENDOR" ? "Nhà cung cấp" : "Cộng tác viên"}
            </strong>{" "}
            (<span className="font-mono">{activated.partner_code}</span>) đã sẵn sàng đăng nhập.
          </p>
          <p className="mt-1 text-xs">
            Vui lòng đăng nhập bằng mã đối tác và mật khẩu khởi tạo do quản trị viên cấp, sau đó đổi mật khẩu mới theo yêu cầu.
          </p>
        </div>

        <Link
          href="/login?next=%2Fpartner%2Fchange-password"
          className="inline-flex min-h-11 h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary shadow-2xs transition-colors hover:bg-[var(--primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Đăng nhập để đổi mật khẩu
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="activate-partner-code"
          className="text-xs font-medium uppercase tracking-wider text-muted"
        >
          Mã Vendor/CTV
        </label>
        <input
          id="activate-partner-code"
          name="code"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          required
          value={code}
          aria-invalid={codeInvalid || Boolean(error) ? "true" : "false"}
          aria-describedby={
            codeInvalid
              ? "activate-code-error"
              : error
                ? "activate-error"
                : undefined
          }
          onBlur={() => setCodeTouched(true)}
          onChange={(event) => {
            setCode(event.target.value);
            if (error) setError(null);
          }}
          className="min-h-11 h-11 rounded-lg border border-border bg-surface-muted px-3.5 text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
        />
        {codeInvalid ? (
          <p id="activate-code-error" className="text-xs text-status-danger-text">
            Vui lòng nhập mã Vendor hoặc CTV.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="activate-partner-token"
          className="text-xs font-medium uppercase tracking-wider text-muted"
        >
          Mã kích hoạt một lần
        </label>
        <input
          id="activate-partner-token"
          name="activation_code"
          type="text"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="done"
          minLength={8}
          required
          value={activationCode}
          aria-invalid={tokenInvalid || Boolean(error) ? "true" : "false"}
          aria-describedby={
            tokenInvalid
              ? "activate-token-error"
              : error
                ? "activate-error"
                : "activate-token-hint"
          }
          onBlur={() => setTokenTouched(true)}
          onChange={(event) => {
            setActivationCode(event.target.value);
            if (error) setError(null);
          }}
          className="min-h-11 h-11 rounded-lg border border-border bg-surface-muted px-3.5 font-mono text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
        />
        <p id="activate-token-hint" className="text-xs text-muted">
          Nhập chính xác mã kích hoạt một lần được quản trị viên cung cấp.
        </p>
        {tokenInvalid ? (
          <p id="activate-token-error" className="text-xs text-status-danger-text">
            Mã kích hoạt cần tối thiểu 8 ký tự.
          </p>
        ) : null}
      </div>

      {error ? (
        <p
          id="activate-error"
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="mt-1 min-h-11 h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary shadow-2xs transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {busy ? "Đang kích hoạt…" : "Kích hoạt tài khoản"}
      </button>

      <div className="border-t border-border pt-3 text-center">
        <Link
          href="/login"
          className="inline-flex min-h-10 items-center justify-center text-sm font-medium text-muted hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md px-2"
        >
          Quay lại đăng nhập
        </Link>
      </div>
    </form>
  );
}
