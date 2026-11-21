"use client";

/**
 * DesktopNav — Client Component.
 * Hiển thị navigation bar ngang (compact) trong header.
 * Ẩn trên mobile (md breakpoint) — mobile dùng Sheet ở MobileNav.
 *
 * P2.5-W06A-R1: active state duoc tinh tu usePathname() (co che pathname nho
 * nhat cua App Router) + findEntryByPath (longest-prefix), thay vi nhan
 * currentPath tu layout (layout khong biet route con).
 *
 * Nhan danh sach da duoc loc tai AppShell; khong tu filter path, khong tu
 * quyet dinh visibility.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, CalendarDays, ChevronDown, ClipboardList, FileDiff, Landmark, LayoutDashboard, NotebookPen, ShieldCheck, Users } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import {
  findActiveNavEntry,
  groupNavEntries,
  type NavGroupId,
  type NavMenuEntry,
} from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

type DesktopNavItem = NavMenuEntry;

const NAV_ICONS: Record<string, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  "direct-entry": ClipboardList,
  "project-operations": Building2,
  "worker-operations": Users,
  "change-requests": FileDiff,
  "work-reports": NotebookPen,
  "work-report-management": ClipboardList,
  "attendance-report": CalendarDays,
  finance: Landmark,
  leave: CalendarDays,
  "leave-admin": CalendarDays,
  "salary-advances": Landmark,
  "recruitment-posts": ClipboardList,
  admin: ShieldCheck,
} as const;

const GROUP_ICONS: Record<NavGroupId, typeof LayoutDashboard> = {
  "my-work": ClipboardList,
  "finance": Landmark,
  "management": ShieldCheck,
};

export function DesktopNav({
  items,
}: {
  items: ReadonlyArray<DesktopNavItem>;
}) {
  const pathname = usePathname();
  const active = findActiveNavEntry(pathname, items);
  return (
    <nav aria-label="Điều hướng chính" className="ml-2 hidden items-center gap-1 md:flex">
      {groupNavEntries(items).map((item) => {
        if (item.type === "entry") {
          const entry = item.entry;
          const Icon = NAV_ICONS[entry.id];
          if (!Icon) throw new Error(`Missing desktop navigation icon for "${entry.id}"`);
          const isActive = active?.id === entry.id;
          return (
            <Link
              key={entry.id}
              href={entry.path}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                isActive
                  ? "bg-primary/10 text-foreground"
                  : "text-muted hover:bg-muted/10 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{entry.label}</span>
            </Link>
          );
        }

        const Icon = GROUP_ICONS[item.id];
        const isActive = item.entries.some((entry) => active?.id === entry.id);
        return (
          <DropdownMenu.Root key={item.id}>
            <DropdownMenu.Trigger
              aria-label={item.label}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                isActive
                  ? "bg-primary/10 text-foreground"
                  : "text-muted hover:bg-muted/10 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{item.label}</span>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={6}
                className="z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg"
              >
                {item.entries.map((entry) => {
                  const EntryIcon = NAV_ICONS[entry.id];
                  if (!EntryIcon) throw new Error(`Missing desktop navigation icon for "${entry.id}"`);
                  const entryActive = active?.id === entry.id;
                  return (
                    <DropdownMenu.Item key={entry.id} asChild>
                      <Link
                        href={entry.path}
                        aria-current={entryActive ? "page" : undefined}
                        className={cn(
                          "flex h-10 items-center gap-3 rounded px-3 text-sm outline-none transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
                          "data-[highlighted]:bg-primary/10 data-[highlighted]:text-foreground",
                          entryActive
                            ? "bg-primary/10 text-foreground"
                            : "text-muted hover:bg-surface-hover hover:text-foreground"
                        )}
                      >
                        <EntryIcon className="h-4 w-4" aria-hidden />
                        <span>{entry.label}</span>
                      </Link>
                    </DropdownMenu.Item>
                  );
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        );
      })}
    </nav>
  );
}
