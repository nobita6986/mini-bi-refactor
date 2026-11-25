"use client";

/**
 * P2.5-HF-R5 - account identity control for the AppShell header.
 *
 * The header shows exactly ONE account trigger (display_name + chevron). The
 * password-change and logout actions live inside the Radix DropdownMenu; they
 * are no longer top-level header items.
 *
 * The display name comes only from GET /api/auth/session, which projects the
 * server-resolved canonical account display name. Nothing is read from browser
 * storage, client cookies, client role or browser payload.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";

import { useNotify, type NotifyApi } from "@/components/ui/notify-provider";
import { getDefaultFormSaveUploadJobManager } from "@/lib/direct-entry/form-save-upload-job-manager";

type SessionState = "loading" | "auth" | "anon" | "unavailable";

const linkClass =
  "inline-flex h-11 items-center rounded-full border border-border/80 bg-surface px-4 text-sm font-medium text-foreground shadow-[var(--shadow-card)] hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring/40";

export async function executeSessionLogout({
  fetchImpl = fetch,
  notify,
  router,
}: {
  fetchImpl?: typeof fetch;
  notify: Pick<NotifyApi, "clear">;
  router: { replace: (href: string) => void; refresh: () => void };
}): Promise<boolean> {
  const res = await fetchImpl("/api/auth/logout", {
    method: "POST", credentials: "same-origin",
  });
  if (res.status === 204) {
    getDefaultFormSaveUploadJobManager().resetForSessionChange();
    notify.clear();
    router.replace("/login");
    router.refresh();
    return true;
  }
  return false;
}

/**
 * Strict projection of the session payload. A missing, non-string, untrimmed or
 * out-of-range display_name fails closed (null) so a stale name is never kept.
 */
function readDisplayName(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const actor = (payload as { actor?: unknown }).actor;
  if (typeof actor !== "object" || actor === null) return null;
  const name = (actor as { display_name?: unknown }).display_name;
  if (typeof name !== "string") return null;
  if (name !== name.trim()) return null;
  if (name.length < 1 || name.length > 256) return null;
  return name;
}

export function UserSessionControl() {
  const router = useRouter();
  const notify = useNotify();
  const [state, setState] = useState<SessionState>("loading");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store", credentials: "same-origin",
        });
        if (cancelled) return;
        if (res.status === 200) {
          let payload: unknown = null;
          try {
            payload = await res.json();
          } catch {
            payload = null;
          }
          if (cancelled) return;
          const name = readDisplayName(payload);
          if (name === null) {
            setDisplayName(null);
            setState("unavailable");
            return;
          }
          setDisplayName(name);
          setState("auth");
          return;
        }
        setDisplayName(null);
        setState(res.status === 401 ? "anon" : "unavailable");
      } catch {
        if (cancelled) return;
        setDisplayName(null);
        setState("unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await executeSessionLogout({ notify, router });
      if (ok) return;
      setError("Không thể đăng xuất lúc này. Vui lòng thử lại.");
    } catch {
      setError("Không thể đăng xuất lúc này. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return <span aria-hidden className="inline-block h-11 w-28 animate-pulse motion-reduce:animate-none rounded-full bg-muted/25" />;
  }
  if (state !== "auth" || displayName === null) {
    return <Link href="/login" className={linkClass}>Đăng nhập</Link>;
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={"Tài khoản: " + displayName}
        title={displayName}
        className="inline-flex h-11 min-w-0 max-w-[12rem] items-center gap-1.5 rounded-full border border-border/80 bg-surface px-3.5 text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring/40 sm:max-w-none"
      >
        <span className="min-w-0 truncate">{displayName}</span>
        <span aria-hidden className="shrink-0 text-xs text-muted">▾</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 min-w-48 rounded-[18px] border border-border/80 bg-surface p-1.5 shadow-[var(--shadow-card-hover)]"
        >
          <DropdownMenu.Item asChild>
            <Link
              href="/dashboard/account/password"
              className="flex h-11 cursor-pointer items-center rounded-xl px-3 text-sm text-foreground outline-none data-[highlighted]:bg-[var(--selected-bg)] data-[highlighted]:text-primary"
            >
              Đổi mật khẩu
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.preventDefault();
              void logout();
            }}
            disabled={busy}
            aria-busy={busy}
            className="flex h-11 cursor-pointer items-center rounded-xl px-3 text-sm text-foreground outline-none data-[highlighted]:bg-[var(--selected-bg)] data-[highlighted]:text-primary data-[disabled]:opacity-60"
          >
            {busy ? "Đang đăng xuất…" : "Đăng xuất"}
          </DropdownMenu.Item>
          {error ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
