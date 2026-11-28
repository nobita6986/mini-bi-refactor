"use client";

import type { ReactNode } from "react";
import { StatusBadge, type BadgeTone } from "@/components/ui/badge";
import type { PartnerAccountState } from "@/lib/auth/direct-entry-v2";

export type PartnerAccountBadgeKey = PartnerAccountState | "CODE_CONFLICT";

export const PARTNER_ACCOUNT_STATE_META: Readonly<
  Record<PartnerAccountBadgeKey, { readonly label: string; readonly tone: BadgeTone }>
> = Object.freeze({
  UNPROVISIONED: { label: "Chưa cấp tài khoản", tone: "neutral" },
  PENDING_ACTIVATION: { label: "Chờ kích hoạt", tone: "warning" },
  ACTIVE_MUST_CHANGE_PASSWORD: { label: "Chờ đổi mật khẩu", tone: "info" },
  ACTIVE: { label: "Đang hoạt động", tone: "success" },
  SUSPENDED: { label: "Tạm khóa", tone: "danger" },
  CODE_CONFLICT: { label: "Xung đột mã", tone: "danger" },
});

export function PartnerAccountStateBadge({
  state,
  hasConflict = false,
}: {
  state: PartnerAccountState | null | undefined;
  hasConflict?: boolean;
}) {
  const key: PartnerAccountBadgeKey = hasConflict
    ? "CODE_CONFLICT"
    : state ?? "UNPROVISIONED";
  const meta = PARTNER_ACCOUNT_STATE_META[key];
  return (
    <StatusBadge tone={meta.tone} dot>
      {meta.label}
    </StatusBadge>
  );
}

export const EMPLOYMENT_STATUS_META: Readonly<
  Record<"ON" | "OFF" | "UNCONFIRMED", { readonly label: string; readonly tone: BadgeTone }>
> = Object.freeze({
  ON: { label: "Đang làm việc", tone: "success" },
  OFF: { label: "Đã nghỉ", tone: "neutral" },
  UNCONFIRMED: { label: "Chưa xác nhận", tone: "warning" },
});

export function EmploymentStatusBadge({
  status,
}: {
  status: "ON" | "OFF" | "UNCONFIRMED";
}) {
  const meta = EMPLOYMENT_STATUS_META[status];
  return (
    <StatusBadge tone={meta.tone} dot>
      {meta.label}
    </StatusBadge>
  );
}

export function extractPartnerApiErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("code" in payload)) {
    return null;
  }
  const code = (payload as { code: unknown }).code;
  return typeof code === "string" && code.trim() !== "" ? code.trim() : null;
}

const DATE_TIME_VI = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatPartnerDateVi(value: string | null | undefined): string {
  if (!value) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return DATE_TIME_VI.format(parsed);
}

export function ResponsiveTableRegion({
  captionId,
  caption,
  children,
}: {
  captionId: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-labelledby={captionId}
      className="max-h-[min(560px,78vh)] max-w-full overflow-auto rounded-xl border border-border bg-surface shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <table className="r22-card-table w-full border-collapse text-left text-sm">
        <caption id={captionId} className="sr-only">
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function PartnerKpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-[20px] border border-border/80 bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1.5 font-mono text-2xl font-bold tabular-nums text-[var(--navy)]">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
