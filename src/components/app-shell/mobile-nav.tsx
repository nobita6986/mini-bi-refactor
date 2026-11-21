"use client";

/**
 * MobileNav — Client Component.
 *
 * Hiển thị trigger button (hamburger) trên mobile, mở Sheet drawer bên trái.
 * Sheet được build trực tiếp trên `radix-ui` Dialog (shadcn-style pattern).
 * Sau APP-NAV-01A, có thể refactor thành shadcn `Sheet` snippet — không
 * phải thay đổi hành vi.
 *
 * - Trigger: button với `aria-controls`, `aria-expanded`.
 * - Overlay: Dialog Overlay (backdrop) mờ.
 * - Content: navigation list (radix-ui không cần, chỉ render `<Link>` từ
 *   `next/link`).
 * - ESC đóng: Dialog Root xử lý (đã kiểm thử bằng cách đặt `onOpenChange`).
 * - Focus trap + focus return: Dialog.Root lo.
 *
 * Danh sách nav được lọc tại AppShell Server Component và truyền qua props.
 */

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "radix-ui";
import { Building2, CalendarDays, ClipboardList, FileDiff, Landmark, LayoutDashboard, Menu, NotebookPen, ShieldCheck, Users, X } from "lucide-react";

import {
  findActiveNavEntry,
  groupNavEntries,
  type NavMenuEntry,
} from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";
import { ThemeSelector } from "@/components/dashboard/theme-selector";

type MobileNavItem = NavMenuEntry;

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

export function MobileNav({
  items,
}: {
  items: ReadonlyArray<MobileNavItem>;
}) {
  const [open, setOpen] = useState(false);
  const [dialogContent, setDialogContent] = useState<HTMLDivElement | null>(null);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const pathname = usePathname();
  const active = findActiveNavEntry(pathname, items);
  const renderEntry = (entry: MobileNavItem) => {
    const Icon = NAV_ICONS[entry.id];
    if (!Icon) throw new Error(`Missing mobile navigation icon for "${entry.id}"`);
    const isActive = active?.id === entry.id;
    return (
      <Link
        key={entry.id}
        href={entry.path}
        aria-current={isActive ? "page" : undefined}
        onClick={() => setOpen(false)}
        className={cn(
          "inline-flex min-h-11 h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          isActive
            ? "bg-primary/10 text-foreground"
            : "text-muted hover:bg-surface-hover hover:text-foreground"
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
        <span>{entry.label}</span>
      </Link>
    );
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setThemePickerOpen(false);
      }}
    >
      {/* Trigger chỉ hiện trên mobile (md:hidden) */}
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Mở menu điều hướng"
          aria-controls="mobile-nav-sheet"
          className={cn(
            "inline-flex min-h-11 min-w-11 h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
            "hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            "md:hidden"
          )}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay
          data-ui-overlay-motion="true"
          className={cn(
            "fixed inset-0 z-30 bg-black/40 backdrop-blur-sm motion-reduce:animate-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
          )}
        />
        <Dialog.Content
          ref={setDialogContent}
          onEscapeKeyDown={(event) => {
            if (themePickerOpen) event.preventDefault();
          }}
          id="mobile-nav-sheet"
          data-ui-drawer-motion="left"
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col gap-2 border-r border-border bg-surface p-4 shadow-xl motion-reduce:animate-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
            "duration-200"
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Điều hướng</span>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Đóng menu"
                className={cn(
                  "inline-flex min-h-11 min-w-11 h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none",
                  "hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                )}
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          <nav aria-label="Điều hướng chính (di động)" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {groupNavEntries(items).map((item) => item.type === "entry"
              ? renderEntry(item.entry)
              : (
                <section key={item.id} aria-label={item.label} className="mt-2">
                  <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                    {item.label}
                  </h2>
                  <div className="ml-2 flex flex-col gap-1 border-l border-border pl-2">
                    {item.entries.map(renderEntry)}
                  </div>
                </section>
              )
            )}
          </nav>

          <Dialog.Title className="sr-only">Menu điều hướng chính</Dialog.Title>
          <div className="mt-auto flex justify-end border-t border-border pt-3">
            <ThemeSelector
              compact
              portalContainer={dialogContent}
              onOpenChange={setThemePickerOpen}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
