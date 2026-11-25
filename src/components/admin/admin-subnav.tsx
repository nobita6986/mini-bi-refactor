"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { cn } from "@/lib/utils";
import {
  groupAdminSections,
  isAdminSectionActive,
  type AdminSection,
} from "@/lib/admin/admin-navigation";

export function AdminSubnav({
  sections,
}: {
  sections: readonly AdminSection[];
}) {
  const pathname = usePathname();
  const items = groupAdminSections(sections);
  return (
    <nav aria-label="Điều hướng Quản trị" data-admin-subnav="true" className="mb-4 sm:mb-6 overflow-x-auto">
      <ul className="flex flex-nowrap sm:flex-wrap gap-1 sm:gap-2 w-max sm:w-fit sm:max-w-full items-center whitespace-nowrap rounded-full border border-border/80 bg-surface p-1.5 shadow-[var(--shadow-card)]">
        {items.map((item) => {
          if (item.type === "group") {
            const current = item.sections.some((section) =>
              isAdminSectionActive(pathname, section.href),
            );
            return (
              <li key={item.id} className="shrink-0">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    aria-label={item.label}
                    className={cn(
                      "inline-flex min-h-11 sm:min-h-9 items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-3.5 text-sm font-medium transition-[color,background-color,border-color,transform] duration-[var(--ui-motion-tab,200ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none motion-reduce:transform-none hover:bg-surface-muted active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      current
                        ? "border-primary bg-primary/10 font-semibold text-primary shadow-2xs"
                        : "text-muted hover:text-[var(--navy)]",
                    )}
                  >
                    {item.label}
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={8}
                      data-ui-popover-motion="true"
                      className="z-50 min-w-56 rounded-[18px] border border-border/80 bg-surface p-1.5 shadow-[var(--shadow-card-hover)]"
                    >
                      {item.sections.map((section) => {
                        const sectionCurrent = isAdminSectionActive(pathname, section.href);
                        return (
                          <DropdownMenu.Item key={section.id} asChild>
                            <Link
                              href={section.href}
                              aria-current={sectionCurrent ? "page" : undefined}
                              className={cn(
                                "flex min-h-10 items-center rounded-xl px-3 text-sm font-medium outline-none transition-colors hover:bg-surface-hover hover:text-[var(--navy)] focus-visible:bg-surface-hover",
                                sectionCurrent
                                  ? "bg-primary/10 font-semibold text-primary"
                                  : "text-muted",
                              )}
                            >
                              {section.label}
                            </Link>
                          </DropdownMenu.Item>
                        );
                      })}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </li>
            );
          }

          const section = item.section;
          const current = isAdminSectionActive(pathname, section.href);
          return (
            <li key={section.id} className="shrink-0">
              <Link
                href={section.href}
                aria-current={current ? "page" : undefined}
                className="inline-flex min-h-11 sm:min-h-9 items-center whitespace-nowrap rounded-full border border-transparent px-3.5 text-sm font-medium text-muted transition-[color,background-color,border-color,transform] duration-[var(--ui-motion-tab,200ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none motion-reduce:transform-none hover:bg-surface-muted hover:text-[var(--navy)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-[current=page]:border-primary aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold aria-[current=page]:text-primary"
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
