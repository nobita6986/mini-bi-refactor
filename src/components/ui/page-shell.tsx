import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function PageShell({
  children,
  className,
  dataTestId,
}: {
  children: ReactNode;
  className?: string;
  dataTestId?: string;
}) {
  const hasCustomPadding = Boolean(className && /\bpx-0\b/.test(className));
  const hasCustomMaxWidth = Boolean(className && /\bmax-w-/.test(className));
  return (
    <div
      data-testid={dataTestId}
      data-ui-page-shell="true"
      data-ui-panel-motion="true"
      className={cn(
        "mx-auto flex w-full flex-col gap-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:gap-5 overflow-x-clip",
        !hasCustomMaxWidth && "max-w-7xl",
        !hasCustomPadding && "px-4 py-4 sm:px-6 sm:py-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  badge,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            {eyebrow}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--navy)] sm:text-2xl">
            {title}
          </h1>
          {badge}
        </div>
        {description ? (
          <div className="text-xs sm:text-sm text-muted max-w-3xl">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
