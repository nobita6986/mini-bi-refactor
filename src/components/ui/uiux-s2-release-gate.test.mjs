import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function resolveCandidatePath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
    if (specifier.startsWith("@/")) {
      const target = resolveCandidatePath(path.join(repoRoot, "src", specifier.slice(2)));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css")) {
      return {
        format: "module",
        source: "export default new Proxy({}, { get: (_, prop) => String(prop) });",
        shortCircuit: true,
      };
    }
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      const sourceText = readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  CHART_ANIMATION_DURATION_MS,
  CHART_MAX_ANIMATED_TREND_POINTS,
  buildTrendDatasetSignature,
  createChartMotionTracker,
} = await import("@/components/dashboard/chart-motion");

const {
  KPI_RAPID_BURST_MS,
  KPI_TRANSITION_DURATION_MS,
  formatKpiIntegerValue,
  resolveKpiTransitionPlan,
  resolveRenderedKpiNumeric,
  sampleKpiTransitionFrames,
} = await import("@/components/dashboard/kpi-motion");

const { KpiCard } = await import("@/components/dashboard/kpi-card");

const {
  INITIAL_BI_HIGHLIGHT_STATE,
  isBucketRowHighlighted,
  reduceBiHighlightState,
  resolveActiveHighlightKey,
  resolveDonutSliceHighlightKey,
} = await import("@/components/dashboard/bi-cross-highlight");

const {
  bindNotifyTimerScheduler,
  createNotifyStore,
  resolveSafeNotifyAction,
} = await import("@/components/ui/notify-store");

const { ToastViewport, executeToastActionClick } = await import(
  "@/components/ui/toast"
);

const { executeSessionLogout } = await import(
  "@/components/app-shell/user-session-control"
);

const {
  validateDownloadableExportBlob,
  validateHtmlExportDocument,
} = await import("@/lib/ui/long-running-feedback");

const { isUsableWorkerExportBlob } = await import(
  "@/lib/direct-entry/worker-export-ui-model"
);

const {
  WORKER_STATUS_FROZEN_LABELS,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
} = await import("@/lib/reporting/wf01-workforce-snapshot");

function createFakeClock({ reducedMotion = false } = {}) {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    now: () => currentTime,
    setTimeout(cb, delayMs) {
      const id = nextTimerId++;
      timers.set(id, { id, runAt: currentTime + Math.max(0, Number(delayMs) || 0), cb });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    isReducedMotion: () => reducedMotion,
    advanceBy(ms) {
      const target = currentTime + ms;
      while (true) {
        let earliest = null;
        for (const t of timers.values()) {
          if (t.runAt <= target && (!earliest || t.runAt < earliest.runAt || (t.runAt === earliest.runAt && t.id < earliest.id))) {
            earliest = t;
          }
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        currentTime = earliest.runAt;
        earliest.cb();
      }
      currentTime = target;
    },
  };
}

describe("UIUX S2-08 — Chặng 2 Release Gate, Performance & Motion Governance", () => {
  it("1. Motion tokens & reduced-motion policy zero all durations and suppress animations without transition-all bleed", () => {
    const globalsCss = readRel("src/app/globals.css");
    for (const token of [
      "--ui-motion-fast: 120ms;",
      "--ui-motion-hover: 160ms;",
      "--ui-motion-tab: 200ms;",
      "--ui-motion-reveal: 200ms;",
      "--ui-motion-toast-in: 200ms;",
      "--ui-motion-toast-out: 160ms;",
      "--ui-motion-chart: 340ms;",
      "--ui-motion-kpi: 220ms;",
      "--ui-motion-ease: cubic-bezier(0.22, 1, 0.36, 1);",
    ]) {
      assert.ok(globalsCss.includes(token), `Missing token ${token}`);
    }

    assert.match(
      globalsCss,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--ui-motion-chart:\s*0ms;[\s\S]*?--ui-motion-kpi:\s*0ms;[\s\S]*?\.recharts-wrapper\s*\*,[\s\S]*?\[data-ui-toast-viewport\]\s*\*,[\s\S]*?\[data-ui-panel-motion\],[\s\S]*?\[data-ui-overlay-motion\],[\s\S]*?\[data-ui-dialog-motion\],[\s\S]*?\[data-ui-drawer-motion\],[\s\S]*?\[data-ui-popover-motion\],[\s\S]*?details\[data-ui-disclosure="true"\]\s*>\s*summary,[\s\S]*?\[data-ui-disclosure-body\][\s\S]*?animation:\s*none\s*!important;[\s\S]*?transition:\s*none\s*!important;/,
    );

    for (const rel of [
      "src/app/layout.tsx",
      "src/components/app-shell/app-shell.tsx",
      "src/components/dashboard/trend-chart.tsx",
      "src/components/dashboard/recruiter-bar-chart.tsx",
      "src/components/dashboard/project-donut.tsx",
      "src/components/dashboard/provider-donut.tsx",
    ]) {
      assert.doesNotMatch(readRel(rel), /transition-all/);
    }
  });

  it("2. Chart animation distinguishes actual server dataset change from mount, remount, theme/resize re-renders, rapid bursts, large datasets, and reduced-motion", () => {
    let clockMs = 1_000;
    let reduced = false;
    const tracker = createChartMotionTracker({
      now: () => clockMs,
      isReducedMotion: () => reduced,
    });

    const d1 = buildTrendDatasetSignature(
      [
        { date: "2026-10-01", count: 8 },
        { date: "2026-10-02", count: 14 },
      ],
      { from: "2026-10-01", to: "2026-10-02" },
    );
    const d2 = buildTrendDatasetSignature(
      [
        { date: "2026-10-01", count: 11 },
        { date: "2026-10-02", count: 19 },
      ],
      { from: "2026-10-01", to: "2026-10-02" },
    );
    const d3 = buildTrendDatasetSignature(
      [
        { date: "2026-10-01", count: 15 },
        { date: "2026-10-02", count: 22 },
      ],
      { from: "2026-10-01", to: "2026-10-02" },
    );

    // Initial mount: never animate from 0
    const onMount = tracker.evaluate({
      chartId: "trend:1",
      ...d1,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onMount.isAnimationActive, false);
    assert.equal(onMount.reason, "initial-mount");

    // Theme toggle or window resize with identical server dataset: static
    const onResizeOrTheme = tracker.evaluate({
      chartId: "trend:1",
      ...d1,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onResizeOrTheme.isAnimationActive, false);
    assert.equal(onResizeOrTheme.reason, "unchanged-dataset");

    // Valid new server dataset: animates in 340ms
    clockMs += 1_000;
    const onServerChange = tracker.evaluate({
      chartId: "trend:1",
      ...d2,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onServerChange.isAnimationActive, true);
    assert.equal(onServerChange.animationDuration, CHART_ANIMATION_DURATION_MS);
    assert.equal(onServerChange.reason, "dataset-changed");

    // Rapid consecutive filter (< 420ms cooldown): skips animation so new numbers appear immediately
    clockMs += 150;
    const onRapidFilter = tracker.evaluate({
      chartId: "trend:1",
      ...d3,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onRapidFilter.isAnimationActive, false);
    assert.equal(onRapidFilter.reason, "rapid-update");

    // Tab remount (reset): does not replay count-up
    tracker.reset("trend:1");
    const onTabRemount = tracker.evaluate({
      chartId: "trend:1",
      ...d3,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onTabRemount.isAnimationActive, false);
    assert.equal(onTabRemount.reason, "initial-mount");

    // Reduced-motion ON: always static even on valid dataset change
    reduced = true;
    clockMs += 1_000;
    const onReducedMotion = tracker.evaluate({
      chartId: "trend:1",
      ...d1,
      maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
    });
    assert.equal(onReducedMotion.isAnimationActive, false);
    assert.equal(onReducedMotion.reason, "reduced-motion");
  });

  it("3. KPI transition enforces vi-VN integer formatting, skips mount/invalid/ratio values, and renders static under reduced-motion", () => {
    assert.equal(
      resolveKpiTransitionPlan({
        previousValue: null,
        nextValue: 1248,
        hasMounted: false,
      }).shouldAnimate,
      false,
    );
    assert.equal(
      resolveKpiTransitionPlan({
        previousValue: 1000,
        nextValue: "—",
        hasMounted: true,
      }).shouldAnimate,
      false,
    );
    assert.equal(
      resolveKpiTransitionPlan({
        previousValue: 1000,
        nextValue: 1248,
        hasMounted: true,
        reducedMotion: true,
      }).shouldAnimate,
      false,
    );

    const plan = resolveKpiTransitionPlan({
      previousValue: 1000,
      nextValue: 1248,
      hasMounted: true,
      reducedMotion: false,
    });
    assert.equal(plan.shouldAnimate, true);
    assert.equal(plan.durationMs, KPI_TRANSITION_DURATION_MS);
    assert.equal(plan.finalDisplay, "1.248");

    const frames = sampleKpiTransitionFrames(1000, 1248);
    assert.equal(frames[0], 1000);
    assert.equal(frames[frames.length - 1], 1248);
    for (const f of frames) {
      assert.ok(Number.isInteger(f) && f >= 0, `Invalid KPI frame: ${f}`);
    }
    assert.equal(formatKpiIntegerValue(frames[frames.length - 1]), "1.248");

    // Pre-effect render hold: 100 -> 200 holds 100 until RAF starts (no 200 -> 100 -> 200 flash)
    assert.equal(
      resolveRenderedKpiNumeric({
        value: 200,
        displayedNumeric: 100,
        animateNumeric: true,
        reducedMotion: false,
      }),
      100,
    );
    // Mid-flight update resumes from displayed frame (145) and rapid bursts (< 120ms) snap cleanly
    assert.equal(
      resolveKpiTransitionPlan({
        previousValue: 145,
        nextValue: 300,
        hasMounted: true,
        reducedMotion: false,
        elapsedSinceLastUpdateMs: KPI_RAPID_BURST_MS + 40,
      }).fromValue,
      145,
    );
    const rapidBurstPlan = resolveKpiTransitionPlan({
      previousValue: 145,
      nextValue: 300,
      hasMounted: true,
      reducedMotion: false,
      elapsedSinceLastUpdateMs: KPI_RAPID_BURST_MS - 20,
    });
    assert.equal(rapidBurstPlan.shouldAnimate, false);
    assert.equal(rapidBurstPlan.reason, "rapid-burst");
    assert.equal(rapidBurstPlan.finalDisplay, "300");

    const cardHtml = renderToStaticMarkup(
      createElement(KpiCard, {
        label: "Tổng tuyển mới",
        value: formatKpiIntegerValue(1248),
        numericValue: 1248,
      }),
    );
    assert.match(cardHtml, /1\.248/);
    assert.doesNotMatch(cardHtml, /cursor-pointer/);
  });

  it("4. Back/Forward tab sync, unauthorized panel exclusion, hidden advanced filters, centered dialog transform preservation, and Radix focus/Escape contracts remain intact", () => {
    const globalsCss = readRel("src/app/globals.css");
    const dialogKeyframesMatch = globalsCss.match(
      /@keyframes\s+ui-dialog-enter\s*\{[\s\S]*?\n\}/,
    );
    assert.ok(dialogKeyframesMatch, "Missing @keyframes ui-dialog-enter");
    assert.doesNotMatch(
      dialogKeyframesMatch[0],
      /transform|translate|scale/i,
      "ui-dialog-enter must never override centered Dialog.Content (-50%, -50%) transform",
    );

    const bodTabsSrc = readRel("src/components/dashboard/bod-dashboard-tabs.tsx");
    assert.match(bodTabsSrc, /history:\s*"push"/);
    assert.match(bodTabsSrc, /activeTab === "deep" && primaryTabLabel === undefined/);
    assert.match(bodTabsSrc, /activeTab === "team" && primaryTabLabel === undefined/);
    assert.match(bodTabsSrc, /rawTab === "duplicate-cccd" && canViewDuplicateCccd/);

    const filtersSrc = readRel("src/components/dashboard/dashboard-filters.tsx");
    assert.match(filtersSrc, /id="advanced-filters"\s+hidden=\{!advancedOpen\}\s+data-ui-panel-motion="true"/);

    const workerDetailSrc = readRel("src/components/direct-entry/worker-detail-dialog.tsx");
    assert.match(workerDetailSrc, /openerRef\.current\.focus\(\)/);

    const reviewerSrc = readRel(
      "src/components/direct-entry/direct-entry-change-request-reviewer.tsx",
    );
    assert.match(reviewerSrc, /opener\.focus\(\)/);
  });

  it("5. BI cross-highlight supports hover, keyboard focus, touch/click pin, and __other__ bucket mapping without mutating URL filters", () => {
    const validKeys = ["p1", "p2", "p3", "p4", "p5", "p6", "__other__"];
    const topSliceKeys = ["p1", "p2", "p3", "p4", "p5"];
    const slices = [...topSliceKeys.map((key) => ({ key })), { key: "__other__" }];

    let state = reduceBiHighlightState(INITIAL_BI_HIGHLIGHT_STATE, {
      type: "focus",
      key: "p6",
    });
    const activeFromFocus = resolveActiveHighlightKey(state, validKeys);
    assert.equal(activeFromFocus, "p6");
    assert.equal(resolveDonutSliceHighlightKey(activeFromFocus, slices, validKeys), "__other__");

    // Touch / Enter pin on __other__ highlights non-top bucket rows and leaves top rows unhighlighted
    state = reduceBiHighlightState(INITIAL_BI_HIGHLIGHT_STATE, {
      type: "toggle-pin",
      key: "__other__",
    });
    const pinnedActive = resolveActiveHighlightKey(state, validKeys);
    assert.equal(pinnedActive, "__other__");
    assert.equal(isBucketRowHighlighted("p6", pinnedActive, topSliceKeys), true);
    assert.equal(isBucketRowHighlighted("p1", pinnedActive, topSliceKeys), false);

    // Escape / Clear resets state cleanly
    state = reduceBiHighlightState(state, { type: "clear" });
    assert.deepEqual(state, INITIAL_BI_HIGHLIGHT_STATE);

    const crossHighlightSrc = readRel("src/components/dashboard/bi-cross-highlight.tsx");
    assert.doesNotMatch(crossHighlightSrc, /useRouter|useQueryStates|window\.history/);
  });

  it("6. Advanced Toast lifecycle updates in-place, scopes burst grouping to dedupeKey, blocks unsafe/fake Undo actions, avoids web storage, and clears on logout", async () => {
    const clock = createFakeClock();
    const store = createNotifyStore(clock);
    const detach = bindNotifyTimerScheduler(store, clock);

    // Pending -> in-place success update (preserves Chặng 1 4-tone union with pending=true)
    const jobToastId = store.api.pending({
      title: "Đang xuất dữ liệu…",
      dedupeKey: "export-job:1",
    });
    assert.equal(store.getSnapshot().visible[0]?.tone, "info");
    assert.equal(store.getSnapshot().visible[0]?.pending, true);
    assert.equal(store.getSnapshot().visible[0]?.deadlineAt, null);

    store.api.update(jobToastId, {
      tone: "success",
      title: "Tệp xuất dữ liệu đã sẵn sàng.",
    });
    assert.equal(store.getSnapshot().visible.length, 1);
    assert.equal(store.getSnapshot().visible[0]?.tone, "success");
    assert.equal(store.getSnapshot().visible[0]?.pending, false);

    // Business-scoped burst grouping vs distinct operations with identical wording
    store.api.warning({ title: "Dữ liệu đã thay đổi.", dedupeKey: "conflict:entry-1" });
    store.api.warning({ title: "Dữ liệu đã thay đổi.", dedupeKey: "conflict:entry-1" });
    store.api.warning({ title: "Dữ liệu đã thay đổi.", dedupeKey: "conflict:entry-2" });
    const warnings = store.getSnapshot().visible.filter((t) => t.tone === "warning");
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0]?.repeatCount, 2);
    assert.equal(warnings[1]?.repeatCount, 1);

    const viewportHtml = renderToStaticMarkup(
      createElement(ToastViewport, {
        items: store.getSnapshot().visible,
        onDismiss: store.dismiss,
      }),
    );
    assert.match(viewportHtml, /×2/);

    // Fake Undo and unmarked retry callbacks are rejected
    assert.equal(
      resolveSafeNotifyAction({
        label: "Hoàn tác",
        kind: "undo",
        safeToRetry: true,
        onClick: () => {},
      }),
      undefined,
    );
    assert.equal(
      resolveSafeNotifyAction({
        label: "Thử lại",
        kind: "retry",
        onClick: () => {},
      }),
      undefined,
    );

    let retryRuns = 0;
    let retryAllowed = true;
    let busy = false;
    const validRetry = resolveSafeNotifyAction({
      label: "Thử lại",
      kind: "retry",
      safeToRetry: true,
      isValid: () => retryAllowed,
      onClick: () => {
        retryRuns += 1;
      },
    });
    assert.ok(validRetry);
    assert.equal(
      await executeToastActionClick({
        action: validRetry,
        isBusy: () => busy,
        setBusy: (next) => {
          busy = next;
        },
      }),
      true,
    );
    assert.equal(retryRuns, 1);
    retryAllowed = false;
    assert.equal(
      await executeToastActionClick({
        action: validRetry,
        isBusy: () => busy,
        setBusy: (next) => {
          busy = next;
        },
      }),
      false,
    );
    assert.equal(retryRuns, 1);

    // Link actions enforce click-time isValid(), one-flight busy lock, and synchronous preventNavigation()
    let linkPrevented = 0;
    let linkDismissed = 0;
    let linkValid = true;
    const linkAction = resolveSafeNotifyAction({
      label: "Mở chi tiết",
      href: "/direct-entry/workers",
      isValid: () => linkValid,
    });
    assert.ok(linkAction);
    assert.equal(
      await executeToastActionClick({
        action: linkAction,
        isBusy: () => true,
        setBusy: () => {},
        preventNavigation: () => {
          linkPrevented += 1;
        },
      }),
      false,
    );
    assert.equal(linkPrevented, 1);

    linkValid = false;
    assert.equal(
      await executeToastActionClick({
        action: linkAction,
        isBusy: () => false,
        setBusy: () => {},
        preventNavigation: () => {
          linkPrevented += 1;
        },
        onDismiss: () => {
          linkDismissed += 1;
        },
      }),
      false,
    );
    assert.equal(linkPrevented, 2);
    assert.equal(linkDismissed, 1);

    // Logout clears all Toasts and blocks stale update resurrection
    const loggedOut = await executeSessionLogout({
      fetchImpl: async () => new Response(null, { status: 204 }),
      notify: { clear: () => store.clear() },
      router: { replace: () => {}, refresh: () => {} },
    });
    assert.equal(loggedOut, true);
    assert.equal(store.getSnapshot().visible.length, 0);
    assert.equal(
      store.api.update(jobToastId, { tone: "error", title: "Trễ sau logout" }),
      false,
    );
    assert.equal(store.getSnapshot().visible.length, 0);

    for (const rel of [
      "src/components/ui/notify-store.ts",
      "src/components/ui/notify-provider.tsx",
      "src/components/ui/toast.tsx",
    ]) {
      assert.doesNotMatch(
        readRel(rel),
        /localStorage|sessionStorage|indexedDB/,
        `${rel} must never persist notification history or PII in browser storage`,
      );
    }

    detach();
  });

  it("7. Long-running operations verify real XLSX ZIP signature and never render fake percentage progress", async () => {
    assert.equal(
      validateDownloadableExportBlob({
        blob: new Blob([], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      }).ok,
      false,
    );
    assert.equal(
      validateDownloadableExportBlob({
        blob: new Blob(['{"error":"denied"}'], { type: "application/json" }),
      }).ok,
      false,
    );
    assert.equal(validateHtmlExportDocument("<html><body>empty</body></html>"), false);

    // Worker XLSX export verifies real ZIP PK\x03\x04 signature (>= 30 bytes)
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob(["Internal Server Error — upstream proxy failure"], {
          type: "application/octet-stream",
        }),
        "application/octet-stream",
      ),
      false,
    );
    const validXlsxBytes = new Uint8Array(64);
    validXlsxBytes.set([0x50, 0x4b, 0x03, 0x04], 0);
    assert.equal(
      await isUsableWorkerExportBlob(
        new Blob([validXlsxBytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      true,
    );

    for (const rel of [
      "src/components/direct-entry/worker-operations.tsx",
      "src/components/direct-entry/worker-portrait-panel.tsx",
    ]) {
      const src = readRel(rel);
      assert.match(src, /<progress\b/);
      assert.doesNotMatch(src, /<progress[^>]*\bvalue=/);
    }
  });

  it("8. Release governance preserves package hygiene, UNCONFIRMED semantics, Chặng 1 inventory, and Chặng 2 QA documentation", () => {
    const pkg = JSON.parse(readRel("package.json"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of ["framer-motion", "motion", "sonner", "react-hot-toast"]) {
      assert.ok(!(forbidden in allDeps), `Forbidden dependency ${forbidden}`);
    }

    assert.equal(WORKER_STATUS_FROZEN_LABELS.UNCONFIRMED, "Đang chờ việc");
    assert.equal(WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED, "Đang chờ việc");
    const periodComparisonSrc = readRel("src/lib/reporting/p1-period-comparison.ts");
    assert.match(periodComparisonSrc, /UNCONFIRMED:\s*"Đang chờ việc"/);

    const qaDoc = readRel("docs/plans/uiux/chang-2-qa-and-governance.md");
    assert.match(qaDoc, /cc48b11185e3be3649cbf5bad96b06c27f8dfeb5/);
    assert.match(qaDoc, /NOT VERIFIED/);
    assert.match(qaDoc, /N\/A/);
    for (const taskId of [
      "S2-01",
      "S2-02",
      "S2-03",
      "S2-04",
      "S2-05",
      "S2-06",
      "S2-07",
      "S2-08",
    ]) {
      assert.ok(qaDoc.includes(taskId), `QA doc missing ${taskId}`);
    }
  });
});
