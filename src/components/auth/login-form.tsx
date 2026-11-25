"use client";

/**
 * P3-W03-S01B - Form dang nhap nho (client). Dung native form; khong dependency auth/state.
 */
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";

import { authUiErrorMessage } from "@/lib/auth/auth-ui";

export function LoginForm({ destination, onError }:
  { destination: string; onError?: () => void }) {
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
        router.replace(destination);
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
        <label htmlFor="login-email" className="text-xs font-medium uppercase tracking-wider text-muted">Email hoặc ID</label>
        <input
          id="login-email"
          name="email"
          type="text"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={identifier}
          aria-describedby={error ? "login-error" : undefined}
          onChange={(event) => setIdentifier(event.target.value)}
          className="min-h-11 h-11 rounded-lg border border-border bg-surface-muted px-3.5 text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
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
            required
            value={password}
            aria-describedby={error ? "login-error" : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="min-h-11 h-11 w-full rounded-lg border border-border bg-surface-muted px-3.5 pr-11 text-base sm:text-sm text-foreground outline-none transition-colors focus:border-primary focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
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
    </form>
  );
}
