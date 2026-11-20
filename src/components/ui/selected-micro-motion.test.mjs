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
        source:
          "export default new Proxy({}, { get: (_, prop) => String(prop) });",
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

const { StatusBadge } = await import("@/components/ui/badge");
const { Alert } = await import("@/components/ui/alert");
const { StatusBanner } = await import("@/components/ui/status-banner");
const { DirectEntryQueueTabs } = await import(
  "@/components/direct-entry/direct-entry-queue-tabs"
);

describe("UIUX S2-07 — Selected Module Micro-Motion", () => {
  it("renders shared StatusBadge, Alert, and StatusBanner with token transitions and zero fake CTA hover affordances", () => {
    const badgeHtml = renderToStaticMarkup(
      createElement(StatusBadge, { tone: "success", dot: true }, "Đã duyệt"),
    );
    assert.match(badgeHtml, /transition-colors/);
    assert.match(badgeHtml, /motion-reduce:transition-none/);
    assert.doesNotMatch(badgeHtml, /cursor-pointer|hover:scale|hover:-translate/);

    const alertHtml = renderToStaticMarkup(
      createElement(
        Alert,
        { tone: "warning", title: "Cảnh báo xung đột" },
        createElement("p", null, "Cần tải lại dữ liệu mới nhất."),
      ),
    );
    assert.match(alertHtml, /role="status"/);
    assert.match(alertHtml, /data-ui-panel-motion="true"/);
    assert.match(alertHtml, /motion-reduce:transition-none/);

    const bannerHtml = renderToStaticMarkup(
      createElement(
        StatusBanner,
        { tone: "error", title: "Không nộp được" },
        "Vui lòng kiểm tra trường bắt buộc.",
      ),
    );
    assert.match(bannerHtml, /role="alert"/);
    assert.match(bannerHtml, /data-ui-panel-motion="true"/);
    assert.match(bannerHtml, /motion-reduce:transition-none/);
  });

  it("scopes disclosure micro-motion strictly to [data-ui-disclosure=\"true\"] and disables it under prefers-reduced-motion", () => {
    const globalsCss = readRel("src/app/globals.css");
    assert.match(globalsCss, /details\[data-ui-disclosure="true"\]\s*>\s*summary/);
    assert.match(
      globalsCss,
      /details\[data-ui-disclosure="true"\]\[open\]\s*>\s*\[data-ui-disclosure-body="true"\]/,
    );
    assert.match(
      globalsCss,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?details\[data-ui-disclosure="true"\]\s*>\s*summary[\s\S]*?\[data-ui-disclosure-body\][\s\S]*?animation:\s*none\s*!important/,
    );
    assert.doesNotMatch(globalsCss, /(?:^|\n)\s*details\s*\{/);
  });

  it("wires secondary navigation, forms, drawers, queue tabs, and reporting panels without decorative loops or transform collisions", () => {
    const queueHtml = renderToStaticMarkup(
      createElement(
        DirectEntryQueueTabs,
        {
          ariaLabel: "Hàng đợi yêu cầu",
          panelId: "queue-panel",
          value: "PENDING",
          tabs: [
            { value: "PENDING", label: "Chờ duyệt" },
            { value: "RESOLVED", label: "Đã xử lý" },
          ],
          onChange: () => {},
        },
        createElement("p", null, "Nội dung hàng đợi"),
      ),
    );
    assert.match(queueHtml, /role="tablist"/);
    assert.match(queueHtml, /role="tabpanel"/);
    assert.match(queueHtml, /data-ui-panel-motion="true"/);

    const adminSubnavSrc = readRel("src/components/admin/admin-subnav.tsx");
    assert.match(adminSubnavSrc, /active:scale-\[0\.99\]/);
    assert.match(adminSubnavSrc, /motion-reduce:transform-none/);
    assert.match(adminSubnavSrc, /min-h-11/);

    const workReportsNavSrc = readRel("src/components/work-reports/work-reports-nav.tsx");
    assert.match(workReportsNavSrc, /min-h-11/);
    assert.match(workReportsNavSrc, /active:scale-\[0\.99\]/);
    assert.match(workReportsNavSrc, /motion-reduce:transform-none/);

    const formRendererSrc = readRel(
      "src/components/work-reports/renderer/work-report-form-renderer.tsx",
    );
    assert.match(formRendererSrc, /data-ui-disclosure="true"/);
    assert.match(formRendererSrc, /data-ui-disclosure-body="true"/);
    assert.match(formRendererSrc, /focus-visible:ring-2/);

    const reviewerSrc = readRel(
      "src/components/direct-entry/direct-entry-change-request-reviewer.tsx",
    );
    assert.match(reviewerSrc, /data-ui-overlay-motion="true"/);
    assert.match(reviewerSrc, /data-ui-drawer-motion="right"/);
    assert.doesNotMatch(
      reviewerSrc,
      /AlertDialog\.Content[^>]*data-ui-dialog-motion/,
      "confirmDialog uses CSS transform centering and must not receive transform keyframe override",
    );

    const workerOpsSrc = readRel("src/components/direct-entry/worker-operations.tsx");
    assert.match(workerOpsSrc, /data-ui-panel-motion="true"/);
    assert.match(workerOpsSrc, /data-ui-dialog-motion="true"/);

    const cccdPanelSrc = readRel(
      "src/components/reporting/duplicate-cccd-report-panel.tsx",
    );
    assert.match(cccdPanelSrc, /active:enabled:scale-\[0\.99\]/);
    assert.match(cccdPanelSrc, /motion-reduce:transform-none/);
    assert.doesNotMatch(
      cccdPanelSrc,
      /<Card[^>]*cursor-pointer|<Card[^>]*hover:-translate/,
    );

    const sharedSrc = readRel("src/components/dashboard/dashboard-shared.tsx");
    assert.match(sharedSrc, /<details className="mt-3" data-ui-disclosure="true">/);
    assert.match(sharedSrc, /data-ui-disclosure-body="true"/);

    for (const rel of [
      "src/components/ui/badge.tsx",
      "src/components/ui/alert.tsx",
      "src/components/ui/status-banner.tsx",
      "src/components/admin/admin-subnav.tsx",
      "src/app/work-reports/page.tsx",
      "src/components/work-reports/renderer/work-report-form-renderer.tsx",
      "src/components/reporting/duplicate-cccd-report-panel.tsx",
    ]) {
      assert.doesNotMatch(
        readRel(rel),
        /animate-bounce|animate-ping|animate-spin/,
        `${rel} must not introduce continuous decorative animations`,
      );
    }
  });
});
