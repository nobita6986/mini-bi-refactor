import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./admin-subnav.tsx", import.meta.url), "utf8");
const desktopNav = readFileSync(new URL("../app-shell/desktop-nav.tsx", import.meta.url), "utf8");
const mobileNav = readFileSync(new URL("../app-shell/mobile-nav.tsx", import.meta.url), "utf8");
const registry = readFileSync(new URL("../../lib/navigation/registry.ts", import.meta.url), "utf8");
const adminLayout = readFileSync(new URL("../../app/admin/layout.tsx", import.meta.url), "utf8");

test("Admin subnav renders canonical active state and exactly one current tab from pathname", () => {
  assert.match(component, /const pathname = usePathname\(\)/);
  assert.match(component, /isAdminSectionActive\(pathname, section\.href\)/);
  assert.match(component, /aria-current=\{current \? "page" : undefined\}/);
  assert.match(component, /border-primary/);
  assert.match(component, /bg-primary\/10/);
  assert.match(component, /font-semibold/);
  assert.match(component, /focus-visible:ring-2/);
  assert.match(component, /flex flex-nowrap sm:flex-wrap gap-1 sm:gap-2/);
  assert.match(adminLayout, /<AdminSubnav sections=\{visibleAdminSections\(navActor\)\} \/>/);
  assert.match(adminLayout, /mx-auto w-full max-w-7xl px-4 py-6 sm:px-6/);
  assert.doesNotMatch(adminLayout, /max-w-6xl/);
});

test("Admin top-level entry remains /admin in both navigation renderers", () => {
  assert.match(registry, /id: "admin",\s*label: "Quản trị hệ thống",\s*path: "\/admin"/);
  assert.match(desktopNav, /href=\{entry\.path\}/);
  assert.match(mobileNav, /href=\{entry\.path\}/);
  assert.match(desktopNav, /const isActive = active\?\.id === entry\.id/);
  assert.match(mobileNav, /const isActive = active\?\.id === entry\.id/);
});
