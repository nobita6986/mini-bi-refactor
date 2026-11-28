"use client";

/**
 * P3-W03-S01B - Form dang nhap nho (client). Dung native form; khong dependency auth/state.
 */
import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  authUiErrorMessage,
  resolvePostLoginDestination,
  type PostLoginActorInput,
} from "@/lib/auth/auth-ui";

export function LoginForm({
  destination,
  rawNext,
  onError,
}: {
  destination: string;
  rawNext?: string | null;
  onError?: () => void;
}) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: identifier.trim(), password }),
      });
      if (response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const target = payload
          ? resolvePostLoginDestination(
              payload as PostLoginActorInput,
              rawNext ?? destination,
            )
          : destination;
        router.replace(target);
        router.refresh();
        return;
      }
      let code = "AUTH_UNAVAILABLE";
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && "code" in payload &&
            typeof (payload as { code: unknown }).code === "string") {
          code = (payload as { code: string }).code;
        }
      } catch { /* ignore */ }
      setPassword("");
      setError(authUiErrorMessage(code));
      onError?.();
    } catch {
      setPassword("");
      setError(authUiErrorMessage("AUTH_UNAVAILABLE"));
      onError?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-email" className="text-xs font-medium uppercase tracking-wider text-muted">Mã đăng nhập hoặc Email</label>
        <input
          id="login-email"
          name="email"
          type="text"
          autoComplete="username"
          inputMode="text"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          required
          value={identifier}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? "login-error" : undefined}
          onChange={(event) => setIdentifier(event.target.value)}
          className="min-h-11 h-11 rounded-lg border border-border bg-surface-muted px-3.5 text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-xs font-medium uppercase tracking-wider text-muted">Mật khẩu</label>
        <div className="relative">
          <input
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            enterKeyHint="done"
            required
            value={password}
            aria-invalid={error ? "true" : "false"}
            aria-describedby={error ? "login-error" : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-11 h-11 w-full rounded-lg border border-border bg-surface-muted px-3.5 pr-11 text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40 user-invalid:border-rose-600 user-invalid:bg-rose-50/40"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            className="absolute right-0 top-0 flex min-h-11 min-w-11 h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-[var(--navy)] focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {showPassword ? <EyeOff aria-hidden className="h-5 w-5" /> : <Eye aria-hidden className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {error && (
        <p id="login-error" role="alert" aria-live="polite"
          className="rounded-lg border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="mt-1 min-h-11 h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary shadow-2xs transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {busy ? "Đang đăng nhập…" : "Đăng nhập"}
      </button>
      <div className="border-t border-border pt-3 text-center">
        <Link
          href="/activate"
          className="inline-flex min-h-10 items-center justify-center text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md px-2"
        >
          Kích hoạt tài khoản Vendor/CTV lần đầu
        </Link>
      </div>
    </form>
  );
}
