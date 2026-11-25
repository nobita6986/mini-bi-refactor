import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[22px] border border-border/80 bg-surface p-5 shadow-[var(--shadow-card)]", className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-3">
      <h2 className="text-base font-semibold tracking-tight text-[var(--navy)]">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
    </header>
  );
}
