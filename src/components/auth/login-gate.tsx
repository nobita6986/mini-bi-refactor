"use client";

/**
 * P3-W03-S01B - Bootstrap session khi mo /login. Goi GET /api/auth/session DUNG MOT lan.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import {
  authUiErrorMessage,
  resolvePostLoginDestination,
  resolveSafeAuthDestination,
  type PostLoginActorInput,
} from "@/lib/auth/auth-ui";
import { LoginForm } from "./login-form";

export function LoginGate() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  const fallbackDestination = resolveSafeAuthDestination(searchParams.get("next"));
  const [state, setState] = useState<"loading" | "form" | "unavailable" | "error">("loading");
  const [unavailableCode, setUnavailableCode] = useState<"ACCOUNT_NOT_AVAILABLE" | "ACCOUNT_PENDING_ACTIVATION">("ACCOUNT_NOT_AVAILABLE");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store", credentials: "same-origin",
        });
        if (res.status === 200) {
          let payload: unknown = null;
          try {
            payload = await res.json();
          } catch {
            payload = null;
          }
          if (cancelled) return;
          const destination = payload
            ? resolvePostLoginDestination(payload as PostLoginActorInput, rawNext)
            : fallbackDestination;
          router.replace(destination);
          return;
        }
        if (cancelled) return;
        if (res.status === 401) { setState("form"); return; }
        if (res.status === 403) {
          let code = "ACCOUNT_NOT_AVAILABLE";
          try {
            const payload: unknown = await res.json();
            if (payload && typeof payload === "object" && "code" in payload &&
                typeof (payload as { code: unknown }).code === "string") {
              code = (payload as { code: string }).code;
            }
          } catch { /* ignore */ }
          if (cancelled) return;
          setUnavailableCode(
            code === "ACCOUNT_PENDING_ACTIVATION"
              ? "ACCOUNT_PENDING_ACTIVATION"
              : "ACCOUNT_NOT_AVAILABLE",
          );
          setState("unavailable");
          return;
        }
        setState("error");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [fallbackDestination, rawNext, router]);

  useEffect(() => { return check(); }, [check, attempt]);

  if (state === "loading") {
    return <p aria-live="polite" className="text-sm text-muted">Đang kiểm tra phiên đăng nhập…</p>;
  }
  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // 204 khong can phan hoi; noi dung session da bi server xoa khi tra ACCOUNT_NOT_AVAILABLE.
    } finally {
      setBusy(false);
      router.replace("/login");
      router.refresh();
    }
  }

  if (state === "unavailable") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text">
        <p>{authUiErrorMessage(unavailableCode)}</p>
        {unavailableCode === "ACCOUNT_PENDING_ACTIVATION" ? (
          <Link
            href="/activate"
            className="inline-flex min-h-11 h-11 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-on-primary hover:bg-[var(--primary-hover)] focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Đi tới kích hoạt
          </Link>
        ) : null}
        <button type="button" onClick={() => void logout()} disabled={busy} aria-busy={busy}
          className="min-h-11 h-11 rounded-md border border-border bg-surface px-3 text-sm text-foreground">Đăng xuất</button>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text">
        <p>{authUiErrorMessage("AUTH_UNAVAILABLE")}</p>
        <button type="button" onClick={() => {
          setState("loading");
          setAttempt((value) => value + 1);
        }}
          className="min-h-11 h-11 rounded-md border border-border bg-surface px-3 text-sm text-foreground">Thử lại</button>
      </div>
    );
  }
  return <LoginForm destination={fallbackDestination} rawNext={rawNext} />;
}
