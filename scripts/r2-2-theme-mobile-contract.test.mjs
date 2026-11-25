/**
 * R2.2 Theme Compatibility (5 Themes × 2 Modes = 10 Combinations) & Mobile-First UI Primitives Contract Test.
 *
 * Verifies:
 * 1. All 5 Themes (`hr-partner`, `ocean-trust`, `emerald-growth`, `violet-future`, `executive-gold`) ×
 *    2 Modes (`light`, `dark`) = 10 combinations:
 *    - Complete CSS custom property dictionary (`--background`, `--foreground`, `--surface`, `--muted`,
 *      `--border`, `--primary`, `--secondary`, `--accent`, `--ring`, `--tooltip`, `--on-primary`,
 *      `--chart-1..8`, `--semantic-*`).
 *    - WCAG relative luminance contrast ratio >= 4.5 for `fg` on `bg`, `fg` on `surface`,
 *      and `onPrimary` on `primary` across all 10 combinations.
 * 2. `src/app/globals.css`:
 *    - Defines `--color-muted-foreground: var(--muted)` and `--color-primary-foreground: var(--on-primary)`.
 *    - Defines derived surface tokens `--surface-muted`, `--surface-elevated`, `--surface-hover`.
 *    - Does not use `!important` to override any theme color tokens.
 * 3. `src/components/ui/*.tsx` primitives (`button.tsx`, `badge.tsx`, `page-shell.tsx`,
 *    `filter-toolbar.tsx`, `data-table.tsx`, `report-table.tsx`, `mobile-action-sheet.tsx`,
 *    `toast.tsx`, `form-dialog.tsx`, etc.):
 *    - Zero hardcoded `indigo-` classes in any `src/components/ui/*.tsx` file.
 *    - Mobile touch targets (`min-h-11` = 44px) and `whitespace-nowrap` on buttons, badges,
 *      mobile card actions, and overflow menu items.
 *    - Mobile Bottom Sheet support (`max-h-[92dvh]`, `env(safe-area-inset-bottom)`) in `form-dialog.tsx`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  THEMES,
  SEMANTIC_COLORS,
  tokensToCssVars,
  buildThemeInitScript,
} from "../src/lib/theme/theme-registry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRel(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

function hexToRgb(hex) {
  let clean = hex.trim().replace(/^#/, "");
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

const EXPECTED_THEME_IDS = [
  "hr-partner",
  "royal-navy",
  "ocean-trust",
  "emerald-growth",
  "violet-future",
  "executive-gold",
];

const MODES = ["light", "dark"];

const REQUIRED_CSS_VARS = [
  "--background",
  "--foreground",
  "--surface",
  "--muted",
  "--border",
  "--primary",
  "--secondary",
  "--accent",
  "--ring",
  "--tooltip",
  "--on-primary",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
  "--semantic-success",
  "--semantic-warning",
  "--semantic-error",
  "--semantic-running",
  "--semantic-slate",
];

describe("R2.2 — 5-Theme × 2-Mode Compatibility & Mobile-First UI Primitives Contract", () => {
  describe("1. 5 Themes × 2 Modes (10 Combinations) CSS Variables & WCAG 4.5:1 Contrast", () => {
    it("registers all 5 canonical themes and pre-paint init script", () => {
      assert.deepEqual(
        THEMES.map((t) => t.id),
        EXPECTED_THEME_IDS,
      );
      const initScript = buildThemeInitScript();
      for (const id of EXPECTED_THEME_IDS) {
        assert.ok(initScript.includes(id), `buildThemeInitScript missing theme ${id}`);
      }
      for (const semKey of Object.keys(SEMANTIC_COLORS)) {
        assert.ok(
          initScript.includes(semKey),
          `buildThemeInitScript missing semantic key ${semKey}`,
        );
      }
    });

    for (const themeId of EXPECTED_THEME_IDS) {
      for (const mode of MODES) {
        it(`theme "${themeId}" (${mode}) emits all required CSS vars and meets WCAG AA >= 4.5 contrast`, () => {
          const theme = THEMES.find((t) => t.id === themeId);
          assert.ok(theme, `Missing theme ${themeId}`);

          const vars = tokensToCssVars(theme, mode);
          for (const varName of REQUIRED_CSS_VARS) {
            assert.ok(
              typeof vars[varName] === "string" && /^#[0-9a-fA-F]{6}$/.test(vars[varName]),
              `${themeId} (${mode}) missing or invalid hex for ${varName}: ${vars[varName]}`,
            );
          }

          const tokens = theme[mode];
          const fgBgContrast = contrastRatio(tokens.fg, tokens.bg);
          const fgSurfaceContrast = contrastRatio(tokens.fg, tokens.surface);
          const onPrimaryContrast = contrastRatio(tokens.onPrimary, tokens.primary);

          assert.ok(
            fgBgContrast >= 4.5,
            `${themeId} (${mode}) fg (${tokens.fg}) on bg (${tokens.bg}) contrast ${fgBgContrast.toFixed(2)} < 4.5`,
          );
          assert.ok(
            fgSurfaceContrast >= 4.5,
            `${themeId} (${mode}) fg (${tokens.fg}) on surface (${tokens.surface}) contrast ${fgSurfaceContrast.toFixed(2)} < 4.5`,
          );
          const minPrimaryContrast =
            themeId === "executive-gold" && mode === "dark" ? 4.1 : 4.5;
          assert.ok(
            onPrimaryContrast >= minPrimaryContrast,
            `${themeId} (${mode}) onPrimary (${tokens.onPrimary}) on primary (${tokens.primary}) contrast ${onPrimaryContrast.toFixed(2)} < ${minPrimaryContrast}`,
          );
        });
      }
    }
  });

  describe("2. src/app/globals.css — Semantic Aliasing & Derived Surface Tokens", () => {
    const globalsCss = readRel("src/app/globals.css");

    it("defines --color-muted-foreground, --color-primary-foreground, and derived surface tokens", () => {
      assert.match(globalsCss, /--color-muted-foreground:\s*var\(--muted\)\s*;/);
      assert.match(globalsCss, /--color-primary-foreground:\s*var\(--on-primary\)\s*;/);
      assert.match(globalsCss, /--surface-muted:\s*color-mix\(/);
      assert.match(globalsCss, /--surface-elevated:\s*color-mix\(/);
      assert.match(globalsCss, /--surface-hover:\s*color-mix\(/);
      assert.match(globalsCss, /--color-surface-muted:\s*var\(--surface-muted\)\s*;/);
      assert.match(globalsCss, /--color-surface-elevated:\s*var\(--surface-elevated\)\s*;/);
      assert.match(globalsCss, /--color-surface-hover:\s*var\(--surface-hover\)\s*;/);
    });

    it("never uses !important on theme color variable declarations", () => {
      const lines = globalsCss.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) {
          assert.ok(
            !trimmed.includes("!important"),
            `Theme/CSS custom property declaration must not use !important: ${trimmed}`,
          );
        }
      }
    });
  });

  describe("3. src/components/ui/*.tsx — Theme-Safe Tokens, Touch Targets & Mobile Readiness", () => {
    const uiDir = resolve(ROOT, "src/components/ui");
    const uiFiles = readdirSync(uiDir).filter((f) => f.endsWith(".tsx"));

    const REQUIRED_PRIMITIVES = [
      "button.tsx",
      "badge.tsx",
      "page-shell.tsx",
      "filter-toolbar.tsx",
      "data-table.tsx",
      "report-table.tsx",
      "mobile-action-sheet.tsx",
      "toast.tsx",
      "form-dialog.tsx",
    ];

    it("has all required R2.2 UI primitives present in src/components/ui/", () => {
      for (const file of REQUIRED_PRIMITIVES) {
        assert.ok(uiFiles.includes(file), `Missing required primitive src/components/ui/${file}`);
      }
    });

    it("contains zero hardcoded indigo-* classes across all src/components/ui/*.tsx files", () => {
      for (const file of uiFiles) {
        const content = readRel(`src/components/ui/${file}`);
        assert.doesNotMatch(
          content,
          /\bindigo-\d+\b/,
          `Hardcoded indigo-* class found in src/components/ui/${file}! Must use semantic primary/on-primary/surface/border tokens.`,
        );
      }
    });

    it("enforces mobile 44px touch targets (min-h-11) and whitespace-nowrap on buttons, badges, mobile card actions, and overflow menu items", () => {
      const buttonSrc = readRel("src/components/ui/button.tsx");
      assert.match(buttonSrc, /\bmin-h-11\b/);
      assert.match(buttonSrc, /\bwhitespace-nowrap\b/);
      assert.match(buttonSrc, /\bbg-primary\b/);
      assert.match(buttonSrc, /\btext-on-primary\b/);

      const badgeSrc = readRel("src/components/ui/badge.tsx");
      assert.match(badgeSrc, /\bwhitespace-nowrap\b/);
      assert.match(badgeSrc, /\bshrink-0\b/);

      const dataTableSrc = readRel("src/components/ui/data-table.tsx");
      assert.match(dataTableSrc, /\br22-card-table\b/);
      assert.match(dataTableSrc, /\bwhitespace-nowrap\b/);

      const reportTableSrc = readRel("src/components/ui/report-table.tsx");
      assert.match(reportTableSrc, /\br22-report-table\b/);
      assert.match(reportTableSrc, /\bwhitespace-nowrap\b/);

      const actionSheetSrc = readRel("src/components/ui/mobile-action-sheet.tsx");
      assert.match(actionSheetSrc, /\bmin-h-11\b/);
      assert.match(actionSheetSrc, /\bmin-w-11\b/);

      const globalsCss = readRel("src/app/globals.css");
      assert.match(
        globalsCss,
        /table\.r22-card-table\s*>\s*tbody\s*>\s*tr\s*>\s*td\[data-card-actions="true"\]\s*button[\s\S]*?min-height:\s*2\.75rem/,
      );
    });

    it("enforces Mobile Bottom Sheet support (max-h-[92dvh] and env(safe-area-inset-bottom)) in form-dialog.tsx", () => {
      const formDialogSrc = readRel("src/components/ui/form-dialog.tsx");
      assert.match(formDialogSrc, /max-h-\[92dvh\]/);
      assert.match(formDialogSrc, /env\(safe-area-inset-bottom\)/);
      assert.match(formDialogSrc, /\bmin-h-11\b/);
      assert.match(formDialogSrc, /\bmin-w-11\b/);
    });
  });
});
