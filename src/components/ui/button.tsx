import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "soft"
  | "danger"
  | "danger-outline"
  | "ghost";

export type ButtonSize = "md" | "sm" | "icon-sm";

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "border border-transparent bg-primary text-on-primary shadow-[0_8px_18px_-10px_var(--primary)] hover:bg-[var(--primary-hover)] hover:shadow-[0_10px_22px_-8px_var(--primary)]",
  secondary:
    "border border-border bg-surface text-[var(--navy)] shadow-2xs hover:border-primary/45 hover:bg-surface-muted hover:shadow-xs",
  outline:
    "border border-border bg-surface text-[var(--navy)] shadow-2xs hover:border-primary hover:bg-surface-muted hover:shadow-xs",
  soft:
    "border border-primary/35 bg-[var(--selected-bg)] text-primary hover:bg-primary hover:text-on-primary hover:shadow-xs",
  danger:
    "border border-transparent bg-rose-600 text-white shadow-2xs hover:bg-rose-700 hover:shadow-xs",
  "danger-outline":
    "border border-rose-500/35 bg-rose-500/10 text-rose-700 hover:bg-rose-500/15 dark:text-rose-200",
  ghost:
    "border border-transparent bg-transparent text-muted hover:bg-surface-muted hover:text-[var(--navy)]",
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  // Mobile touch target >= 44px (min-h-11), Desktop standard >= 40px (sm:min-h-10) — Halvi capsule pill
  md: "min-h-11 sm:min-h-10 px-4 py-2 text-sm rounded-full gap-2",
  // Table row action button: 44px on mobile (<768px), compact 32px (md:h-8) on desktop table — Halvi capsule pill
  sm: "min-h-11 md:min-h-8 md:h-8 px-3 py-1.5 md:py-1 text-xs rounded-full gap-1.5",
  "icon-sm":
    "min-h-11 min-w-11 md:min-h-8 md:min-w-8 md:h-8 md:w-8 p-0 rounded-full",
};

export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center font-medium whitespace-nowrap shrink-0 transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-[var(--ui-motion-hover,160ms)] active:duration-[var(--ui-motion-fast,120ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] active:scale-[0.99] disabled:active:scale-100 aria-busy:active:scale-100 motion-reduce:transition-none motion-reduce:transform-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  loading,
  disabled,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || props["aria-busy"] || undefined}
      className={buttonClasses({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  );
}
