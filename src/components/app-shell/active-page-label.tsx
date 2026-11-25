"use client";

/**
 * ActivePageLabel — Client Component & Halvi Motion Engine Orchestrator.
 * - Dùng usePathname() + shared A1/A2 matcher `findActiveNavEntry(pathname, items)`
 *   để chỉ đọc nhãn sr-only "Đang ở trang: X" khi mục sở hữu thực sự hiển thị trong
 *   danh sách menu đã lọc của actor hiện tại (không bao giờ lộ tên mục bị ẩn).
 * - Tái hiện động cơ chuyển động uyển chuyển của Halvi (kit-BgmmIzr_.js):
 *   1. Elastic Sliding Capsule Pill Glider (xo): Viên nang active trượt mượt từ tab cũ sang tab mới
 *      với hiệu ứng co giãn đàn hồi dọc theo trục di chuyển.
 *   2. Directional View Glide (Hc): Khung nội dung <main> lướt nhẹ theo hướng điều hướng (trái/phải)
 *      với đường cong expo.out (cubic-bezier(0.16, 1, 0.3, 1)).
 *   3. Staggered Squircle Card & KPI Cascade (oo): Các khối Header, Filter, KPI Card, Card dữ liệu
 *      xuất hiện nối tiếp nhau (stagger 45ms, y: 20px -> 0, scale: 0.985 -> 1, expo.out).
 *   4. Staggered Table Row Reveal (so): Các dòng dữ liệu trong bảng (.r22-card-table / .r22-report-table)
 *      lướt lên nối tiếp nhau (stagger 26ms, y: 10px -> 0, power3.out).
 *   5. Tuyệt đối không can thiệp vào lưới nhập liệu /direct-entry (.rdg / .grid) và tự tắt khi prefers-reduced-motion.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { findActiveNavEntry, type NavMenuEntry } from "@/lib/navigation/registry";

let lastCommittedPathname: string | null = null;
let pendingRouteNavigation = false;
let pendingNavDirection: 1 | -1 = 1;

type PillSnapshot = {
  trackSelector: string;
  rect: DOMRect;
  timestamp: number;
};

let pendingPillSnapshot: PillSnapshot | null = null;

const PILL_TRACK_SELECTORS = [
  'nav[aria-label="Điều hướng chính"]',
  'nav[aria-label="Điều hướng Quản trị"] > ul',
  'nav[aria-label="Báo cáo công việc"]',
  'nav[aria-label="Chuyển mục con Báo cáo công việc"]',
  '[role="tablist"]',
] as const;

function isReducedMotionPreferred(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function findActivePillInTrack(track: Element): HTMLElement | null {
  return (
    track.querySelector<HTMLElement>('[aria-selected="true"]') ??
    track.querySelector<HTMLElement>('[aria-current="page"]')
  );
}

function animatePillGlide(fromRect: DOMRect, toEl: HTMLElement) {
  if (isReducedMotionPreferred()) return;
  const toRect = toEl.getBoundingClientRect();
  if (toRect.width < 4 || toRect.height < 4) return;
  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

  const scaleX = Math.max(0.55, Math.min(1.65, fromRect.width / toRect.width));
  const midStretchX = Math.abs(dx) > Math.abs(dy) ? 1.07 : 1;

  try {
    toEl.animate(
      [
        {
          transformOrigin: "0 50%",
          transform: `translate3d(${dx}px, ${dy}px, 0) scaleX(${scaleX})`,
        },
        {
          transformOrigin: "50% 50%",
          transform: `translate3d(${dx * 0.22}px, ${dy * 0.22}px, 0) scaleX(${midStretchX})`,
          offset: 0.46,
        },
        {
          transformOrigin: "50% 50%",
          transform: "translate3d(0, 0, 0) scaleX(1)",
        },
      ],
      {
        duration: 430,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    );
  } catch {
    // Ignore WAAPI errors in headless environments
  }
}

function runHalviStaggerChoreography(rootEl: HTMLElement, direction: 1 | -1, isTabSwitch = false) {
  if (isReducedMotionPreferred()) return;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 900;

  try {
    // 1. Directional View Glide (Hc from Halvi kit: x: dir * 22px -> 0, duration: 540ms, expo.out)
    rootEl.animate(
      [
        {
          opacity: isTabSwitch ? 0.35 : 0.08,
          transform: `translate3d(${direction * (isTabSwitch ? 16 : 24)}px, 0, 0)`,
        },
        {
          opacity: 1,
          transform: "translate3d(0, 0, 0)",
        },
      ],
      {
        duration: isTabSwitch ? 440 : 540,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    );

    // 2. Staggered Squircle Cards, Headers, Toolbars & KPI Cards (oo from Halvi kit)
    const candidateNodes = rootEl.querySelectorAll<HTMLElement>(
      "header, section, [data-kpi-final-value], table.r22-card-table, table.r22-report-table",
    );
    const seenBlocks = new Set<HTMLElement>();
    const visibleBlocks: HTMLElement[] = [];

    for (const node of candidateNodes) {
      if (node.closest(".rdg, [class*='gridViewport'], [class*='spreadsheet']")) {
        continue;
      }
      let block: HTMLElement = node;
      if (node.hasAttribute("data-kpi-final-value") && node.parentElement instanceof HTMLElement) {
        block = node.parentElement;
      } else if (
        (node.classList.contains("r22-card-table") || node.classList.contains("r22-report-table")) &&
        node.parentElement?.parentElement instanceof HTMLElement
      ) {
        block = node.parentElement.parentElement;
      }
      if (seenBlocks.has(block)) continue;
      // Skip nested blocks if an ancestor block is already queued (except KPI cards inside a grid)
      let hasQueuedAncestor = false;
      for (const existing of seenBlocks) {
        if (existing !== block && existing.contains(block) && !node.hasAttribute("data-kpi-final-value")) {
          hasQueuedAncestor = true;
          break;
        }
      }
      if (hasQueuedAncestor) continue;

      const rect = block.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top > viewportHeight * 1.15 || rect.bottom < -40) continue;

      seenBlocks.add(block);
      visibleBlocks.push(block);
      if (visibleBlocks.length >= 14) break;
    }

    visibleBlocks.forEach((block, index) => {
      block.animate(
        [
          {
            opacity: 0,
            transform: "translate3d(0, 18px, 0) scale(0.986)",
          },
          {
            opacity: 1,
            transform: "translate3d(0, 0, 0) scale(1)",
          },
        ],
        {
          duration: 580,
          delay: index * 44,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
    });

    // 3. Staggered Table Rows Reveal (so from Halvi kit)
    const tableRows = rootEl.querySelectorAll<HTMLElement>(
      "table.r22-card-table > tbody > tr, table.r22-report-table > tbody > tr",
    );
    let rowIdx = 0;
    for (const row of tableRows) {
      if (rowIdx >= 14) break;
      const rect = row.getBoundingClientRect();
      if (rect.height === 0 || rect.top > viewportHeight * 1.1) continue;
      row.animate(
        [
          {
            opacity: 0,
            transform: "translate3d(0, 10px, 0)",
          },
          {
            opacity: 1,
            transform: "translate3d(0, 0, 0)",
          },
        ],
        {
          duration: 460,
          delay: 65 + rowIdx * 26,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards",
        },
      );
      rowIdx += 1;
    }
  } catch {
    // Ignore WAAPI errors in older or headless environments
  }
}

export function ActivePageLabel({
  items,
}: {
  items: ReadonlyArray<Pick<NavMenuEntry, "id" | "label">>;
}) {
  const pathname = usePathname();
  const active = findActiveNavEntry(pathname, items);
  const [progressState, setProgressState] = useState<"idle" | "loading" | "completing">(() => {
    if (
      pendingRouteNavigation ||
      (typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-route-state") === "loading")
    ) {
      return "loading";
    }
    return "idle";
  });
  const prevPathRef = useRef<string>(pathname);
  const hasInitialChoreographedRef = useRef(false);

  useEffect(() => {
    const onPointerDownCapture = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      // Capture active pill rect inside any capsule track before click changes active state
      for (const selector of PILL_TRACK_SELECTORS) {
        const track = target.closest(selector);
        if (track) {
          const currentActive = findActivePillInTrack(track);
          const clickedItem = target.closest<HTMLElement>('a[href], button[role="tab"], button');
          if (currentActive && clickedItem && currentActive !== clickedItem) {
            const fromRect = currentActive.getBoundingClientRect();
            const toRect = clickedItem.getBoundingClientRect();
            pendingNavDirection = toRect.left >= fromRect.left ? 1 : -1;
            pendingPillSnapshot = {
              trackSelector: selector,
              rect: fromRect,
              timestamp: performance.now(),
            };
          }
          break;
        }
      }
    };

    const onDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;

      // Handle in-page [role="tab"] switching with Halvi Pill Glide + Staggered Panel Cascade
      const clickedTab = target.closest<HTMLElement>('[role="tab"]');
      if (clickedTab) {
        const track = clickedTab.closest('[role="tablist"]');
        const snapshot = pendingPillSnapshot;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (track) {
              const newActive = findActivePillInTrack(track) ?? clickedTab;
              if (snapshot && performance.now() - snapshot.timestamp < 800) {
                animatePillGlide(snapshot.rect, newActive);
                pendingPillSnapshot = null;
              }
            }
            const panelId = clickedTab.getAttribute("aria-controls");
            const panelEl =
              (panelId ? document.getElementById(panelId) : null) ??
              document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])') ??
              document.querySelector<HTMLElement>("main");
            if (panelEl instanceof HTMLElement) {
              runHalviStaggerChoreography(panelEl, pendingNavDirection, true);
            }
          });
        });
      }

      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const rawHref = anchor.getAttribute("href");
      if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:")) {
        return;
      }

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      pendingRouteNavigation = true;
      document.documentElement.setAttribute("data-route-state", "loading");
      setProgressState("loading");
    };

    document.addEventListener("pointerdown", onPointerDownCapture, true);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownCapture, true);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, []);

  useEffect(() => {
    const hadPendingNavigation =
      pendingRouteNavigation ||
      document.documentElement.getAttribute("data-route-state") === "loading";
    const pathChanged =
      (lastCommittedPathname !== null && lastCommittedPathname !== pathname) ||
      prevPathRef.current !== pathname ||
      hadPendingNavigation;
    const isInitialMount = !hasInitialChoreographedRef.current;
    hasInitialChoreographedRef.current = true;

    lastCommittedPathname = pathname;
    prevPathRef.current = pathname;
    pendingRouteNavigation = false;
    document.documentElement.removeAttribute("data-route-state");

    const mainEl = document.querySelector("main");

    // Animate sliding pill across route-driven nav bars (DesktopNav, AdminSubnav, WorkReportsModuleNav)
    if (pathChanged && pendingPillSnapshot && performance.now() - pendingPillSnapshot.timestamp < 2500) {
      const snapshot = pendingPillSnapshot;
      pendingPillSnapshot = null;
      const track = document.querySelector(snapshot.trackSelector);
      if (track) {
        const nextActive = findActivePillInTrack(track);
        if (nextActive) {
          animatePillGlide(snapshot.rect, nextActive);
        }
      }
    }

    if ((pathChanged || isInitialMount) && mainEl instanceof HTMLElement) {
      runHalviStaggerChoreography(mainEl, pendingNavDirection, false);
    }

    if (pathChanged && mainEl instanceof HTMLElement) {
      // Accessibility focus routing when previous focused element was unmounted
      if (!document.activeElement || document.activeElement === document.body) {
        const heading = mainEl.querySelector<HTMLElement>("h1");
        if (heading) {
          if (!heading.hasAttribute("tabindex")) {
            heading.setAttribute("tabindex", "-1");
          }
          heading.focus({ preventScroll: true });
        }
      }
    }

    if (!pathChanged) return;

    const startTimer = window.setTimeout(() => {
      setProgressState("loading");
    }, 0);
    const completeTimer = window.setTimeout(() => {
      setProgressState("completing");
    }, 55);
    const idleTimer = window.setTimeout(() => {
      setProgressState("idle");
    }, 310);

    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(completeTimer);
      window.clearTimeout(idleTimer);
    };
  }, [pathname]);

  return (
    <>
      {progressState !== "idle" ? (
        <div
          aria-hidden="true"
          data-route-progress={progressState}
          className="bi-route-progress"
        />
      ) : null}
      {active ? <p className="sr-only">Đang ở trang: {active.label}</p> : null}
    </>
  );
}
