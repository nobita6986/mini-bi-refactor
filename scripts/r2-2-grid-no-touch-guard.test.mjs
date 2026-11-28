/**
 * R2.2 Grid No-Touch & CSS Isolation Guard Suite.
 *
 * Verifies:
 * 1. 100% SHA-256 content match against baseline commit `8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c`
 *    for all 21 locked `/direct-entry` spreadsheet grid, multi-entry form, paste, portrait, and controller files.
 * 2. Exact anchor/subtree slice preservation in `src/components/direct-entry/direct-entry-live.tsx`
 *    for `<div className={styles.inputModeSwitch}` .. `</section>` of `.gridSection`,
 *    and `<section className={styles.mobileSection}` .. EOF.
 * 3. Exact CSS rule block preservation in `src/components/direct-entry/direct-entry-shell.module.css`
 *    for `.page`, `.primaryButton`, `.secondaryButton`, `.gridEditButton`, `.dangerButton`,
 *    `.gridSection`, `.inputModeSwitch`, `.contextualActionBar`, `.gridViewport`, `.grid`, `.mobileSection`.
 * 4. Strict selector scoping in `src/app/globals.css` (`table.r22-card-table` and `table.r22-report-table`),
 *    preventing any bare `table`, `tr`, `td`, `th` rule bleed into `.rdg` or `.grid`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_COMMIT = "8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c";

const LOCKED_FILES = [
  "src/components/direct-entry/direct-entry-ddmm-date-input.tsx",
  "src/components/direct-entry/direct-entry-excel-paste-dialog.tsx",
  "src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx",
  "src/components/direct-entry/direct-entry-initial-worker-uploads.tsx",
  "src/components/direct-entry/worker-portrait-stage-slot.tsx",
  "src/components/direct-entry/use-worker-portrait-stages.ts",
  "src/components/direct-entry/typeahead-picker-smoke.tsx",
  "src/components/direct-entry/text-cell-state.ts",
  "src/lib/direct-entry/direct-entry-grid-clipboard.ts",
  "src/lib/direct-entry/draft-profile-grid.ts",
  "src/lib/direct-entry/worker-profile-paste.ts",
  "src/lib/direct-entry/worker-profile-xlsx.ts",
];

const CTV_EXTENDED_GRID_FILES = [
  "src/lib/direct-entry/spreadsheet-row-model.ts",
  "src/lib/direct-entry/direct-entry-grid-columns.ts",
  "src/lib/direct-entry/direct-entry-grid-validation.ts",
  "src/lib/direct-entry/live-grid-paste.ts",
  "src/lib/direct-entry/live-controller.ts",
];

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function sha256(text) {
  return createHash("sha256").update(normalizeEol(text), "utf8").digest("hex");
}

function readWorkingFile(relPath) {
  return normalizeEol(readFileSync(resolve(ROOT, relPath), "utf8"));
}

function readBaselineFile(relPath) {
  const out = execFileSync("git", ["show", `${BASELINE_COMMIT}:${relPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return normalizeEol(out);
}

/**
 * Extract all top-level and media-nested CSS rule blocks whose selector list
 * mentions a given class selector (e.g. `.gridSection`).
 */
function extractCssRuleBlocksForClass(cssText, classSelector) {
  const normalized = normalizeEol(cssText);
  // Strip block comments for deterministic rule parsing while keeping rule bodies intact
  const stripped = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  const escaped = classSelector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classRegex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escaped}(?=$|[^a-zA-Z0-9_-])`);

  let i = 0;
  while (i < stripped.length) {
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (i >= stripped.length) break;

    const openBrace = stripped.indexOf("{", i);
    if (openBrace === -1) break;

    const header = stripped.slice(i, openBrace).trim();
    let depth = 1;
    let cursor = openBrace + 1;
    while (cursor < stripped.length && depth > 0) {
      if (stripped[cursor] === "{") depth++;
      else if (stripped[cursor] === "}") depth--;
      cursor++;
    }
    const fullBlock = stripped.slice(i, cursor).trim();
    const innerBody = stripped.slice(openBrace + 1, cursor - 1);

    if (header.startsWith("@")) {
      // Recurse into @media / @container blocks
      const nested = extractCssRuleBlocksForClass(innerBody, classSelector);
      for (const n of nested) {
        blocks.push(`${header} { ${n} }`);
      }
    } else if (classRegex.test(header)) {
      blocks.push(fullBlock.replace(/\s+/g, " "));
    }

    i = cursor;
  }

  return blocks;
}

describe("R2.2 — Direct Entry Grid No-Touch & CSS Isolation Guard", () => {
  describe("1. Locked Direct Entry Files — 100% SHA-256 Checksum Match", () => {
    for (const relPath of LOCKED_FILES) {
      it(`preserves ${relPath} untouched vs baseline ${BASELINE_COMMIT.slice(0, 8)}`, () => {
        const current = readWorkingFile(relPath);
        const baseline = readBaselineFile(relPath);
        const currentHash = sha256(current);
        const baselineHash = sha256(baseline);
        assert.equal(
          currentHash,
          baselineHash,
          `Locked file ${relPath} was modified! Expected SHA-256 ${baselineHash}, got ${currentHash}`,
        );
        assert.equal(current, baseline);
      });
    }
    it("preserves direct-entry-spreadsheet-grid.tsx toolbar, viewport and CTV source/collaborator extension invariants", () => {
      const gridPath = "src/components/direct-entry/direct-entry-spreadsheet-grid.tsx";
      const currentGrid = readWorkingFile(gridPath);

      const toolbarMarker = "<div className={styles.toolbar}>";
      const viewportMarker = "<div className={styles.viewport}>";

      const curToolbarIdx = currentGrid.indexOf(toolbarMarker);
      const curViewportIdx = currentGrid.indexOf(viewportMarker, curToolbarIdx);

      assert.ok(curToolbarIdx > 0 && curViewportIdx > curToolbarIdx);
      assert.match(currentGrid, /"hrp" \| "vendor" \| "ctv" \| ""/);
      assert.match(currentGrid, /column\.key === "collaborator_id"/);
      assert.match(currentGrid, /aria-label="Nguồn"/);

      for (const relPath of CTV_EXTENDED_GRID_FILES) {
        const content = readWorkingFile(relPath);
        assert.match(content, /collaborator_id|collaboratorId/, `CTV field expected in ${relPath}`);
      }

      const toolbarSlice = currentGrid.slice(curToolbarIdx, curViewportIdx);
      assert.match(toolbarSlice, /data-testid="spreadsheet-toolbar-right"/);
      assert.match(toolbarSlice, /data-testid="spreadsheet-validation-cluster"/);
      assert.match(toolbarSlice, /data-testid="spreadsheet-error-summary"/);
      assert.match(toolbarSlice, /data-testid="spreadsheet-header-issues"/);
      assert.match(toolbarSlice, /data-testid="spreadsheet-save-message"/);
      assert.match(toolbarSlice, /<div className=\{styles\.toolbarActions\}>\{toolbarActions\}<\/div>/);
    });

    it("preserves direct-entry-spreadsheet-grid.module.css from .viewport to EOF 100% vs baseline", () => {
      const gridCssPath = "src/components/direct-entry/direct-entry-spreadsheet-grid.module.css";
      const currentGridCss = readWorkingFile(gridCssPath);
      const baselineGridCss = readBaselineFile(gridCssPath);

      const viewportMarker = ".viewport {";
      const curIdx = currentGridCss.indexOf(viewportMarker);
      const baseIdx = baselineGridCss.indexOf(viewportMarker);
      assert.ok(curIdx > 0 && baseIdx > 0);
      assert.equal(currentGridCss.slice(curIdx), baselineGridCss.slice(baseIdx));
    });
  });

  describe("2. direct-entry-live.tsx — Subtree Slice Preservation", () => {
    const relPath = "src/components/direct-entry/direct-entry-live.tsx";

    function extractGridSectionSlice(source) {
      const startMarker = "<section className={styles.gridSection}";
      const endMarker = "</section>";
      const startIdx = source.indexOf(startMarker);
      assert.ok(startIdx !== -1, `Missing ${startMarker} in ${relPath}`);
      const closeIdx = source.indexOf(endMarker, startIdx);
      assert.ok(closeIdx !== -1, `Missing closing ${endMarker} for .gridSection in ${relPath}`);
      return source.slice(startIdx, closeIdx + endMarker.length);
    }

    function extractMobileSectionToEofSlice(source) {
      const mobileMarker = "<section className={styles.mobileSection}";
      const startIdx = source.indexOf(mobileMarker);
      assert.ok(startIdx !== -1, `Missing ${mobileMarker} in ${relPath}`);
      return source.slice(startIdx);
    }

    it("locks the two-cluster contextualActionBar and consolidated Grid toolbarActions inside .gridSection", () => {
      const currentSource = readWorkingFile(relPath);
      const gridSlice = extractGridSectionSlice(currentSource);

      assert.match(gridSlice, /data-testid="contextual-action-left"/);
      assert.match(gridSlice, /data-testid="contextual-action-right"/);
      assert.match(gridSlice, /data-testid="input-mode-form"/);
      assert.match(gridSlice, /data-testid="input-mode-grid"/);
      assert.match(gridSlice, /data-testid="spreadsheet-paste-rejected"/);
      assert.match(gridSlice, /data-testid="spreadsheet-labor-types-notice"/);
      assert.match(gridSlice, /data-testid="spreadsheet-first-error"/);
      assert.match(gridSlice, /data-testid="add-rows-batch"/);
      assert.match(gridSlice, /data-testid="spreadsheet-save"/);
    });

    it("preserves mobileSection drawer/dialog structure with Nguồn (HRP/Vendor/CTV) and CTV selector", () => {
      const currentSource = readWorkingFile(relPath);
      const currentMobileSlice = extractMobileSectionToEofSlice(currentSource);

      assert.match(currentMobileSlice, /className=\{styles\.mobileSection\}/);
      assert.match(currentMobileSlice, /<option value="hrp">/);
      assert.match(currentMobileSlice, /<option value="vendor">/);
      assert.match(currentMobileSlice, /<option value="ctv">/);
      assert.match(currentMobileSlice, /Cộng tác viên \(CTV\)/);
      assert.match(currentMobileSlice, /collaborator_id/);
    });
  });

  describe("3. direct-entry-shell.module.css — Locked Rule Blocks Guard", () => {
    const relPath = "src/components/direct-entry/direct-entry-shell.module.css";
    const LOCKED_SELECTORS = [
      ".page",
      ".primaryButton",
      ".secondaryButton",
      ".gridEditButton",
      ".dangerButton",
      ".gridViewport",
      ".grid",
      ".mobileSection",
    ];

    const currentCss = readWorkingFile(relPath);
    const baselineCss = readBaselineFile(relPath);

    for (const selector of LOCKED_SELECTORS) {
      it(`preserves CSS rule blocks for ${selector} 100% vs baseline`, () => {
        const currentBlocks = extractCssRuleBlocksForClass(currentCss, selector);
        const baselineBlocks = extractCssRuleBlocksForClass(baselineCss, selector);
        assert.ok(
          baselineBlocks.length > 0,
          `Expected at least 1 baseline CSS block for ${selector}`,
        );
        assert.deepEqual(
          currentBlocks,
          baselineBlocks,
          `CSS rule blocks for ${selector} in ${relPath} diverged from baseline`,
        );
      });
    }

    it("locks two-column desktop and responsive narrow-screen rules for .contextualActionBar, .contextualActionLeft, .inputModeSwitch, and .gridSection", () => {
      const barBlocks = extractCssRuleBlocksForClass(currentCss, ".contextualActionBar");
      const leftBlocks = extractCssRuleBlocksForClass(currentCss, ".contextualActionLeft");
      const switchBlocks = extractCssRuleBlocksForClass(currentCss, ".inputModeSwitch");
      const gridSectionBlocks = extractCssRuleBlocksForClass(currentCss, ".gridSection");

      assert.ok(barBlocks.some((b) => b.includes("grid-template-columns: minmax(0, 1fr) auto")));
      assert.ok(barBlocks.some((b) => b.includes("@media (max-width: 900px)")));
      assert.ok(leftBlocks.some((b) => b.includes("display: flex") && b.includes("align-items: center")));
      assert.ok(switchBlocks.some((b) => b.includes("justify-content: flex-end")));
      assert.ok(gridSectionBlocks.some((b) => b.includes('.gridSection[data-input-mode="form"] > :not(.contextualActionBar)')));
    });
  });

  describe("4. src/app/globals.css — Scoped Table Rules & Zero Grid Bleed", () => {
    const globalsCss = readWorkingFile("src/app/globals.css");

    it("scopes all responsive card and report table selectors strictly to table.r22-card-table and table.r22-report-table", () => {
      assert.match(globalsCss, /table\.r22-card-table/);
      assert.match(globalsCss, /table\.r22-report-table/);

      // Extract all selector headers in globals.css (excluding @import, @media, @theme)
      const stripped = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");
      const selectorHeaders = [];
      const regex = /([^{}@]+)\{/g;
      let match;
      while ((match = regex.exec(stripped)) !== null) {
        const rawSelector = match[1].trim();
        if (!rawSelector || rawSelector.startsWith("@") || rawSelector.startsWith(":root") || rawSelector === "body") {
          continue;
        }
        for (const part of rawSelector.split(",")) {
          const sel = part.trim();
          if (sel) selectorHeaders.push(sel);
        }
      }

      for (const sel of selectorHeaders) {
        if (/\b(?:table|thead|tbody|tr|td|th)\b/.test(sel)) {
          assert.ok(
            sel.startsWith("table.r22-card-table") || sel.startsWith("table.r22-report-table"),
            `Unscoped table/cell selector "${sel}" found in globals.css! Must start with table.r22-card-table or table.r22-report-table.`,
          );
        }
        assert.ok(
          !sel.includes(".rdg") && !sel.includes(".grid"),
          `Selector "${sel}" in globals.css must never target .rdg or .grid`,
        );
      }
    });
  });
});
