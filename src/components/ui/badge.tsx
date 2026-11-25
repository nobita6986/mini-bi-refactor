import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type BadgeTone =
  | "success"
  | "warning"
  | "danger"
  | "error"
  | "info"
  | "neutral"
  | "primary";

const BADGE_TONE_CLASSES: Readonly<Record<BadgeTone, string>> = {
  success:
    "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-200",
  warning:
    "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-200",
  danger:
    "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-200",
  error:
    "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/15 dark:text-rose-200",
  info:
    "border-sky-500/30 bg-sky-500/12 text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-200",
  neutral:
    "border-border bg-muted/12 text-muted dark:border-border dark:bg-muted/20 dark:text-foreground/80",
  primary:
    "border-primary/25 bg-primary/10 text-primary",
};

export function StatusBadge({
  tone = "neutral",
  children,
  className,
  dot = false,
  dataTestId,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  dataTestId?: string;
}) {
  return (
    <span
      data-testid={dataTestId}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-full border px-2.5 py-0.5 text-center text-xs font-medium whitespace-nowrap shrink-0 transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
        BADGE_TONE_CLASSES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-current opacity-80"
        />
      ) : null}
      {children}
    </span>
  );
}

export const Badge = StatusBadge;

export function submissionStateBadgeProps(state: string): {
  label: string;
  tone: BadgeTone;
} {
  switch (state) {
    case "SUBMITTED":
      return { label: "Đã gửi chính thức", tone: "success" };
    case "REVIEW":
      return { label: "Đang trình duyệt", tone: "info" };
    case "DRAFT":
      return { label: "Bản nháp", tone: "warning" };
    default:
      return { label: state, tone: "neutral" };
  }
}

export function changeRequestStateBadgeProps(state: string): {
  label: string;
  tone: BadgeTone;
} {
  switch (state) {
    case "PENDING":
      return { label: "Chờ duyệt", tone: "warning" };
    case "APPROVED":
      return { label: "Đã duyệt", tone: "success" };
    case "REJECTED":
      return { label: "Từ chối", tone: "danger" };
    case "WITHDRAWN":
      return { label: "Đã rút", tone: "neutral" };
    default:
      return { label: state, tone: "neutral" };
  }
}

export function scopeMappingStateBadgeProps(state: string): {
  label: string;
  tone: BadgeTone;
} {
  switch (state) {
    case "CURRENT":
      return { label: "Đang hiệu lực", tone: "success" };
    case "SCHEDULED":
      return { label: "Sắp hiệu lực", tone: "warning" };
    case "HISTORY":
      return { label: "Lịch sử", tone: "neutral" };
    case "REVOKED":
      return { label: "Đã thu hồi", tone: "danger" };
    default:
      return { label: state, tone: "neutral" };
  }
}
