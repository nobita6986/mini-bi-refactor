import type { ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";

/**
 * Operational DataTable wrapper (`Modern Soft Enterprise` Concept A).
 * - Desktop (>=768px): Clean bordered surface card with `--surface-muted` header & single-line row actions.
 * - Mobile (<768px): When `table.r22-card-table` is applied on the child `<table>`, rows automatically
 *   render as Mobile Stacked Cards with `data-label` fields and `44x44px` touch action bars.
 */
export function DataTableContainer({
  children,
  footer,
  className,
  scrollClassName,
  scrollRef,
  dataTestId,
}: {
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  scrollClassName?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
  dataTestId?: string;
}) {
  return (
    <div
      data-testid={dataTestId}
      className={cn(
        "relative overflow-hidden rounded-xl [border-radius:22px] border border-border/80 bg-surface shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <div
        ref={scrollRef}
        className={cn(
          "relative overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          scrollClassName,
        )}
      >
        {children}
      </div>
      {footer ? (
        <div className="border-t border-border bg-surface px-4 py-3">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export const DATA_TABLE_CLASS =
  "r22-card-table w-full border-collapse text-left text-sm";

export const DATA_TABLE_HEAD_CLASS =
  "border-b border-border bg-surface-muted text-xs font-bold uppercase tracking-wider text-[var(--navy)]";

export const DATA_TABLE_TH_CLASS =
  "px-3 py-2.5 text-left font-bold whitespace-nowrap";

export const DATA_TABLE_ROW_CLASS =
  "border-b border-border/65 last:border-b-0 transition-colors hover:bg-[var(--selected-bg)] align-middle";

export const DATA_TABLE_TD_CLASS = "px-3 py-2.5 align-middle text-foreground";

export function RowActionCluster({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      {children}
    </div>
  );
}
