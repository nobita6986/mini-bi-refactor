import type { Metadata } from "next";

import { PartnerActivateForm } from "@/components/auth/partner-activate-form";

export const metadata: Metadata = {
  title: "Kích hoạt tài khoản đối tác — HR Partner",
};

export default function ActivatePartnerPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div className="w-full max-w-md rounded-[12px] border border-border border-t-2 border-t-primary bg-surface p-7 shadow-[var(--shadow-card-hover)]">
        <span className="inline-flex items-center rounded-md bg-[var(--selected-bg)] px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-primary">
          HR Partner · Cổng đối tác
        </span>
        <h1 className="mt-2.5 mb-1 text-2xl font-semibold tracking-tight text-[var(--navy)]">
          Kích hoạt tài khoản
        </h1>
        <p className="mb-6 text-sm text-muted">
          Nhập mã Vendor/CTV và mã kích hoạt một lần để mở quyền đăng nhập lần đầu.
        </p>
        <PartnerActivateForm />
      </div>
    </main>
  );
}
