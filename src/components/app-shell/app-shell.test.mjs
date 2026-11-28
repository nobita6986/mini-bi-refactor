/**
 * Source-string / structure tests cho App Shell.
 * Đảm bảo App Shell:
 * - Là Server Component an toàn (mobile trigger là client boundary rõ ràng).
 * - Không import module server-only hoặc @/lib/ai-* (server boundary).
 * - Không fetch dữ liệu trong shell (chỉ render children + currentPath).
 * - Có thuộc tính a11y cần thiết cho header / navigation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CURRENT_NAV_ENTRIES } from "../../lib/navigation/registry.ts";

const appShellSource = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
const mobileNavSource = readFileSync(new URL("./mobile-nav.tsx", import.meta.url), "utf8");
const desktopNavSource = readFileSync(new URL("./desktop-nav.tsx", import.meta.url), "utf8");

test("app-shell.tsx: là Server Component (KHÔNG có 'use client')", () => {
  assert.ok(!appShellSource.includes('"use client"'), "app-shell.tsx phải là Server Component");
  assert.ok(!appShellSource.includes("'use client'"), "app-shell.tsx phải là Server Component");
});

test("app-shell.tsx: không import @/lib/ai-* (server boundary)", () => {
  assert.ok(
    !/from\s+["']@\/lib\/ai\//.test(appShellSource),
    "app-shell.tsx không được import @/lib/ai/*"
  );
  assert.ok(
    !/from\s+["']@\/lib\/ai-config\//.test(appShellSource),
    "app-shell.tsx không được import @/lib/ai-config/*"
  );
  assert.ok(
    !appShellSource.includes("server-only"),
    "app-shell.tsx không được pull server-only"
  );
});

test("app-shell.tsx: có header cấu trúc đúng và re-export ThemeSelector", () => {
  assert.ok(appShellSource.includes("HR Partner"), "phải có logo 'HR Partner'");
  assert.ok(appShellSource.includes("<header"), "phải dùng <header> cho top bar");
  // aria-label 'Điều hướng chính' nằm ở DesktopNav/MobileNav (đã test riêng bên dưới).
});

test("app-shell lọc nav theo feature flag + capability predicate tại request-time", () => {
  // P3-W06A: AppShell nhận `actor` prop từ page boundary, filter qua
  // `filterEntriesForActor` + `decideNavEntryVisibility`. Page boundary tự
  // resolve session; AppShell KHÔNG tự query env/cookie.
  // P3-W06A R1: 2 lan goi filterEntriesForActor voi viewport RIENG (gap 2 fix).
  assert.match(appShellSource, /await connection\(\)/);
  assert.match(appShellSource, /isDirectEntryUiEnabled\(process\.env\.DIRECT_ENTRY_UI_ENABLED\)/);
  // Desktop viewport trong filterEntriesForActor.
  assert.match(appShellSource, /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"desktop"[\s\S]{0,400}\}/);
  // Mobile viewport trong filterEntriesForActor.
  assert.match(appShellSource, /filterEntriesForActor\(\{[\s\S]{0,200}viewport:\s*"mobile"[\s\S]{0,400}\}/);
  assert.match(appShellSource, /decideNavEntryVisibility\(/);
  assert.match(appShellSource, /WORK_REPORTS_NAV_ENTRY_IDS\.has\(entry\.id\)/);
  assert.match(appShellSource, /\(entry\.id !== "bulletins" \|\| bulletinsEnabled\)/);
  assert.match(
    appShellSource,
    /new Set\(\[\s*"work-reports",\s*"work-report-management",?\s*\]\)/,
  );
  assert.match(appShellSource, /projectNavMenuEntries\(desktopItems,\s*actor\)/);
  assert.match(appShellSource, /projectNavMenuEntries\(mobileItems,\s*actor\)/);
  assert.match(appShellSource, /<DesktopNav items=\{desktopMenuItems\} \/>/);
  assert.match(appShellSource, /<MobileNav items=\{mobileMenuItems\} \/>/);
  // F6 + A2: active label duoc tinh client-side tu danh sach da loc, khong con currentPath server.
  assert.match(appShellSource, /<ActivePageLabel items=\{activeLabelItems\} \/>/);
  assert.ok(!/currentPath/.test(appShellSource), "AppShell khong con nhan currentPath");
});

test("app-shell.tsx: actor prop là NavActorProjection tối thiểu, không nhận auth_subject/email", () => {
  // Đảm bảo AppShell chỉ yêu cầu { app_user_id, capabilities, scopes }.
  // KHÔNG nhận `actor` object gốc từ v2 (tránh rò PII/auth_subject).
  assert.match(appShellSource, /actor:\s*NavActorProjection\s*\|\s*null/);
  assert.ok(!/actor:\s*DirectEntryActor/.test(appShellSource),
    "AppShell KHÔNG nhận DirectEntryActor đầy đủ (tránh rò auth_subject/email/PII)");
  // auth_subject/email chỉ được phép xuất hiện trong comment (PII hygiene).
  const codeLines = appShellSource.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line));
  const codeOnly = codeLines.join("\n");
  assert.ok(!/auth_subject/.test(codeOnly),
    "AppShell code (khong tinh comment) KHÔNG reference auth_subject");
  assert.ok(!/\bemail\b/.test(codeOnly),
    "AppShell code (khong tinh comment) KHÔNG reference email");
});

test("app-shell.tsx: AI deferred (P3-W06A Scope B) — KHÔNG render 'Tạo báo cáo AI' / 'Cấu hình AI'", () => {
  // P3-W06A Scope B: AI actions deferred to P3.1. AppShell chỉ render
  // `headerActions` do page truyền vào; dashboard layout truyền undefined.
  // Ở cấp component, đảm bảo KHÔNG có button/anchor mang nhãn AI cố định.
  for (const forbidden of ["Tạo báo cáo AI", "Cấu hình AI", "AiReportPanel", "AiSettingsPanel"]) {
    assert.ok(!appShellSource.includes(forbidden),
      `app-shell.tsx không được chứa '${forbidden}' (AI deferred to P3.1)`);
  }
  // Đồng thời không tham chiếu AI feature flag / settings panel.
  assert.ok(!/isAiSettingsEnabled/.test(appShellSource));
  assert.ok(!/isAiReportsEnabled/.test(appShellSource));
});

test("app-shell.tsx: re-export ThemeSelector hiện có (không phá W05 R1)", () => {
  assert.ok(
    appShellSource.includes("ThemeSelector"),
    "phải giữ ThemeSelector từ @/components/dashboard/theme-selector"
  );
});

test("theme selector chỉ nằm ở desktop header trong breakpoint md trở lên", () => {
  assert.match(appShellSource, /<div className="hidden md:block">\s*<ThemeSelector \/>\s*<\/div>/);
  assert.equal((appShellSource.match(/<ThemeSelector/g) ?? []).length, 1);
  assert.match(appShellSource, /<UserSessionControl \/>/);
});

test("mobile theme selector là mục cuối drawer sau toàn bộ nav links", () => {
  const navEnd = mobileNavSource.indexOf("</nav>");
  const selector = mobileNavSource.indexOf("<ThemeSelector\n              compact");
  const footer = mobileNavSource.lastIndexOf('className="mt-auto flex justify-end border-t border-border pt-3"');
  const contentEnd = mobileNavSource.indexOf("</Dialog.Content>");
  assert.ok(navEnd > -1 && selector > navEnd && footer > navEnd && selector < contentEnd);
  assert.match(mobileNavSource, /<nav[^>]*className="flex min-h-0 flex-1[^"]*overflow-y-auto"/);
  assert.match(mobileNavSource, /w-72 max-w-\[85vw\]/);
  assert.match(mobileNavSource, /h-10 shrink-0/);
  assert.match(mobileNavSource, /onEscapeKeyDown=\{\(event\) => \{\s*if \(themePickerOpen\) event\.preventDefault\(\)/);
  assert.match(mobileNavSource, /onOpenChange=\{setThemePickerOpen\}/);
});

test("mobile-nav.tsx: là Client Component với 'use client' ở đầu file", () => {
  assert.ok(
    /^\s*"use client"/.test(mobileNavSource),
    "mobile-nav.tsx phải là Client Component (cần state cho Sheet open)"
  );
});

test("mobile-nav.tsx: dùng radix-ui Dialog với Trigger, Content, Overlay", () => {
  assert.ok(mobileNavSource.includes('Dialog.Root'), "phải có Dialog.Root");
  assert.ok(mobileNavSource.includes('Dialog.Trigger'), "phải có Dialog.Trigger");
  assert.ok(mobileNavSource.includes('Dialog.Portal'), "phải có Dialog.Portal");
  assert.ok(mobileNavSource.includes('Dialog.Overlay'), "phải có Dialog.Overlay (backdrop)");
  assert.ok(mobileNavSource.includes('Dialog.Content'), "phải có Dialog.Content (panel)");
  assert.ok(mobileNavSource.includes('Dialog.Close'), "phải có Dialog.Close (nút đóng)");
});

test("mobile-nav.tsx: trigger có aria-label và aria-controls", () => {
  assert.ok(mobileNavSource.includes("aria-label=\"Mở menu điều hướng\""));
  assert.ok(mobileNavSource.includes("aria-controls=\"mobile-nav-sheet\""));
});

test("mobile-nav.tsx: trigger chỉ hiện trên mobile (md:hidden)", () => {
  assert.ok(
    mobileNavSource.includes("md:hidden"),
    "trigger phải ẩn từ md trở lên (mobile-only)"
  );
});

test("mobile-nav.tsx: KHÔNG import @/lib/ai-* (server boundary)", () => {
  assert.ok(
    !/from\s+["']@\/lib\/ai\//.test(mobileNavSource),
    "mobile-nav.tsx không được import @/lib/ai/*"
  );
  assert.ok(
    !/from\s+["']@\/lib\/ai-config\//.test(mobileNavSource),
    "mobile-nav.tsx không được import @/lib/ai-config/*"
  );
});

test("mobile-nav.tsx: không dùng localStorage / console.log / API key", () => {
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "console.log", "api_key", "API key", "Authorization", "Bearer"]) {
    assert.ok(!mobileNavSource.includes(forbidden), `mobile-nav.tsx không được dùng '${forbidden}'`);
  }
});

test("desktop-nav.tsx: là Client Component dùng usePathname + shared findActiveNavEntry (A1)", () => {
  assert.ok(desktopNavSource.includes('"use client"'), "desktop-nav.tsx phải là Client Component");
  assert.ok(desktopNavSource.includes("usePathname"), "dùng usePathname de tinh active");
  assert.ok(desktopNavSource.includes("findActiveNavEntry"), "dùng shared findActiveNavEntry (A1)");
});

test("desktop-nav.tsx: dùng next/link và có nav landmark", () => {
  assert.ok(desktopNavSource.includes('from "next/link"'), "phải dùng next/link");
  assert.ok(desktopNavSource.includes("<nav"), "phải có <nav>");
  assert.ok(desktopNavSource.includes("aria-label"), "phải có aria-label cho nav");
});

test("desktop-nav.tsx: ẩn trên mobile (md:flex)", () => {
  assert.ok(
    desktopNavSource.includes("md:flex"),
    "desktop-nav phải ẩn dưới md breakpoint"
  );
});

test("desktop-nav.tsx: link active có aria-current='page'", () => {
  assert.ok(desktopNavSource.includes('aria-current'), "phải set aria-current cho active link");
});

test("desktop-nav nhận các entry đã filter từ AppShell, không tự quyết định visibility", () => {
  assert.ok(desktopNavSource.includes("items: ReadonlyArray<DesktopNavItem>"));
  assert.ok(!desktopNavSource.includes("entriesForViewport"));
  assert.ok(desktopNavSource.includes('from "@/lib/navigation/registry"'));
  // Không hard-code label cũ (Pipeline Check) hay mới trong component.
  assert.ok(!desktopNavSource.includes("Pipeline check"));
  assert.ok(!desktopNavSource.includes("Nhập liệu trực tiếp"));
});

test("desktop nav client boundary only receives serializable fields; icons stay local", () => {
  assert.match(appShellSource, /const desktopMenuItems = projectNavMenuEntries\(desktopItems,\s*actor\)/);
  assert.match(appShellSource, /<DesktopNav items=\{desktopMenuItems\} \/>/);
  assert.doesNotMatch(desktopNavSource, /\bNavEntry\b/, "client nav must not accept registry entries with component icons");
  assert.ok(desktopNavSource.includes('"project-operations": Building2'));
  assert.ok(desktopNavSource.includes('"direct-entry": ClipboardList'));
  assert.ok(desktopNavSource.includes('"finance": Landmark'), "desktop group icon for Tài chính");
});

test("desktop/mobile nav have a local icon for every current registry entry", () => {
  for (const entry of CURRENT_NAV_ENTRIES) {
    const escapedId = entry.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mapping = new RegExp(`["']?${escapedId}["']?\\s*:`);
    assert.match(desktopNavSource, mapping, `desktop icon missing for ${entry.id}`);
    assert.match(mobileNavSource, mapping, `mobile icon missing for ${entry.id}`);
  }
});

test("mobile-nav nhận danh sách server-filtered, dùng usePathname + shared findActiveNavEntry, không đọc env", () => {
  assert.ok(mobileNavSource.includes("items: ReadonlyArray<MobileNavItem>"));
  assert.ok(!mobileNavSource.includes("entriesForViewport"));
  assert.ok(!mobileNavSource.includes("process.env"));
  // A1: mobile dùng chung findActiveNavEntry với DesktopNav và ActivePageLabel.
  assert.ok(mobileNavSource.includes("findActiveNavEntry"));
  assert.ok(mobileNavSource.includes("usePathname"));
  assert.ok(mobileNavSource.includes('"project-operations": Building2'), "mobile co icon cho Dự án");
  assert.ok(!mobileNavSource.includes("Pipeline check"));
  assert.ok(!mobileNavSource.includes("Nhập liệu trực tiếp"));
});

test("desktop-nav.tsx & mobile-nav.tsx: KHÔNG có chuỗi 'Google Sheets' hay 'n8n'", () => {
  assert.ok(!/Google Sheets/i.test(desktopNavSource), "desktop-nav không nhắc Google Sheets");
  assert.ok(!/\bn8n\b/i.test(desktopNavSource), "desktop-nav không nhắc n8n");
  assert.ok(!/Google Sheets/i.test(mobileNavSource), "mobile-nav không nhắc Google Sheets");
  assert.ok(!/\bn8n\b/i.test(mobileNavSource), "mobile-nav không nhắc n8n");
});

test("app-shell.tsx: gates partner nav entries by DIRECT_ENTRY_API_ENABLED and links partner logo safely", () => {
  assert.match(appShellSource, /partnerPortalEnabled = process\.env\.DIRECT_ENTRY_API_ENABLED === "true"/);
  assert.match(appShellSource, /"partner-recruitment"/);
  assert.match(appShellSource, /"partner-workers"/);
  assert.match(appShellSource, /"partner-profile"/);
  assert.match(appShellSource, /actor\?\.partner_account/);
});

test("desktop-nav.tsx & mobile-nav.tsx: KHÔNG có client-side role/filter giả (Admin/Kế toán/Leader)", () => {
  // Bảo đảm App Shell không hard-code UI role (đó là việc của P3 RBAC thật).
  for (const src of [desktopNavSource, mobileNavSource]) {
    assert.ok(!/role\s*===?\s*["']admin["']/i.test(src), "không hard-code role admin");
    assert.ok(!/Admin|Kế toáni|Leader/i.test(src.replace(/\badmin\b/gi, "")),
      "không hard-code UI role label (entry id 'admin' được phép)");
  }
});
