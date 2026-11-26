import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[22px] border border-border/80 bg-surface p-5 shadow-[var(--shadow-card)]", className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  if (!action) {
    return (
      <header className="mb-3">
        <h2 className="text-base font-semibold tracking-tight text-[var(--navy)]">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </header>
    );
  }
  return (
    <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold tracking-tight text-[var(--navy)]">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      <div className="shrink-0">{action}</div>
    </header>
  );
}
