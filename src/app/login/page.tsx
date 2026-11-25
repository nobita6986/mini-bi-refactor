import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginGate } from "@/components/auth/login-gate";

export const metadata: Metadata = { title: "Đăng nhập — HR Partner" };

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[12px] border border-border border-t-2 border-t-primary bg-surface p-7 shadow-[var(--shadow-card-hover)]">
        <span className="inline-flex items-center rounded-md bg-[var(--selected-bg)] px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-primary">
          HR Partner · Hệ thống điều hành
        </span>
        <h1 className="mt-2.5 mb-1 text-2xl font-semibold tracking-tight text-[var(--navy)]">Đăng nhập</h1>
        <p className="mb-6 text-sm text-muted">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
        <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
          <LoginGate />
        </Suspense>
      </div>
    </main>
  );
}
