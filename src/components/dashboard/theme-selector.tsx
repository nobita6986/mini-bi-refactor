"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTheme } from "@/lib/theme/theme-provider";
import { THEMES, type ThemeDef } from "@/lib/theme/theme-registry";

function Swatches({ theme }: { theme: ThemeDef }) {
  const colors = [theme.light.primary, theme.light.secondary, theme.light.accent];
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {colors.map((c, i) => (
        <span key={i} className="h-3 w-3 rounded-full border border-black/10" style={{ background: c }} />
      ))}
    </span>
  );
}

// Trigger swatch dùng CSS var (SSR/client giống nhau — không hydration mismatch): 1 ô tròn màu chủ đạo (--primary).
function CurrentSwatches() {
  return (
    <span className="flex items-center justify-center" aria-hidden>
      <span
        className="h-4 w-4 rounded-full border border-black/10 shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)]"
        style={{ background: "var(--primary)" }}
      />
    </span>
  );
}

export function ThemeSelector({
  compact = false,
  portalContainer,
  onOpenChange,
}: {
  compact?: boolean;
  portalContainer?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
}) {
  const { themeId, setTheme } = useTheme();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = btnRef.current?.getBoundingClientRect();
      const menu = listRef.current;
      if (!trigger || !menu) return;
      const gutter = 8;
      const left = Math.max(gutter, Math.min(trigger.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - gutter));
      const below = window.innerHeight - trigger.bottom - gutter;
      const top = below >= menu.offsetHeight
        ? trigger.bottom + gutter
        : Math.max(gutter, trigger.top - menu.offsetHeight - gutter);
      setMenuPosition({ top, left });
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !listRef.current?.contains(target)) changeOpen(false);
    };
    positionMenu();
    listRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [changeOpen, open]);

  function focusIndex(i: number) {
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    if (!nodes || nodes.length === 0) return;
    const idx = ((i % nodes.length) + nodes.length) % nodes.length;
    nodes[idx].focus();
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      changeOpen(false);
      btnRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const nodes = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    if (!nodes || nodes.length === 0) return;
    const idx = Array.from(nodes).indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    focusIndex(next);
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Chọn màu giao diện"
        title={compact ? undefined : "Màu giao diện"}
        onClick={() => {
          if (open) {
            changeOpen(false);
            return;
          }
          const trigger = btnRef.current?.getBoundingClientRect();
          if (trigger) {
            setMenuPosition({
              top: trigger.bottom + 8,
              left: Math.max(8, Math.min(trigger.right - 256, window.innerWidth - 264)),
            });
          }
          changeOpen(true);
        }}
        className={
          compact
            ? "inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/80 bg-surface p-0 text-foreground shadow-[var(--shadow-card)] hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            : "inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/80 bg-surface p-0 text-sm font-medium text-foreground shadow-[var(--shadow-card)] hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        }
      >
        <CurrentSwatches />
      </button>

      {open ? createPortal(
        <div
          id={menuId}
          ref={listRef}
          role="radiogroup"
          aria-label="Màu giao diện"
          onKeyDown={onListKeyDown}
          style={{ top: menuPosition.top, left: menuPosition.left }}
          className={
            "fixed max-h-[calc(100dvh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-[20px] border border-border/80 bg-surface p-1.5 shadow-[var(--shadow-card-hover)] " +
            (compact ? "z-[50]" : "z-[100]")
          }
        >
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={(event) => {
                  const anchorRect =
                    event.currentTarget.getBoundingClientRect() ??
                    btnRef.current?.getBoundingClientRect();
                  const applySelection = () => {
                    setTheme(t.id);
                    changeOpen(false);
                    btnRef.current?.focus();
                  };
                  const docWithVt = document as Document & {
                    startViewTransition?: (cb: () => void) => { ready: Promise<void> };
                  };
                  const reducedMotion =
                    typeof window !== "undefined" &&
                    typeof window.matchMedia === "function" &&
                    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  if (
                    t.id !== themeId &&
                    typeof docWithVt.startViewTransition === "function" &&
                    !reducedMotion &&
                    anchorRect
                  ) {
                    const cx = anchorRect.left + anchorRect.width / 2;
                    const cy = anchorRect.top + anchorRect.height / 2;
                    const maxR = Math.hypot(
                      Math.max(cx, window.innerWidth - cx),
                      Math.max(cy, window.innerHeight - cy),
                    );
                    try {
                      docWithVt
                        .startViewTransition(applySelection)
                        .ready.then(() => {
                          document.documentElement.animate(
                            {
                              clipPath: [
                                `circle(0px at ${cx}px ${cy}px)`,
                                `circle(${maxR}px at ${cx}px ${cy}px)`,
                              ],
                            },
                            {
                              duration: 450,
                              easing: "cubic-bezier(0.65, 0, 0.35, 1)",
                              pseudoElement: "::view-transition-new(root)",
                            },
                          );
                        })
                        .catch(() => {});
                      return;
                    } catch {
                      // Fallback to immediate theme switch
                    }
                  }
                  applySelection();
                }}
                className={
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
                  (selected ? "bg-primary/10" : "hover:bg-muted/10")
                }
              >
                <Swatches theme={t} />
                <span className="flex-1">{t.name}</span>
                {selected ? <span aria-hidden className="text-primary">✓</span> : null}
              </button>
            );
          })}
        </div>,
        portalContainer ?? document.body,
      ) : null}
    </div>
  );
}
