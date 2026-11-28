/**
 * P3-W06A R1 — Request-scoped actor resolution (Gap 1 regression, source-string).
 *
 * Muc tieu: dam bao moi request chi co 1 lan Supabase getUser + 1 lan
 * actor repository resolution, duoc share giua layout (AppShell) va page
 * (route access decision). React `cache()` (request-scoped, RSC) dam bao
 * resolver duoc memoize theo render pass.
 *
 * Test strategy (source-string):
 *  1. Doc source `resolve-nav-actor.ts` va verify:
 *     - import `cache` tu `react`;
 *     - wrap `resolveActorForRequest` va `resolveNavActorForAppShell` bang cache().
 *     - `resolveNavActorForAppShell` nhan flag `directEntryEnabled` de skip query.
 *     - `NavActorProjection` KHONG chua `app_user_id`.
 *  2. Doc source `dashboard/layout.tsx`, `direct-entry/layout.tsx` va verify:
 *     - ca 2 goi `resolveNavActorForAppShell({directEntryEnabled})` (cung key,
 *       cung React cache → share).
 *  3. Doc source `dashboard/page.tsx`, `direct-entry/page.tsx` va verify:
 *     - ca 2 goi `resolveActorForRequest()` (cung cache, share voi layout).
 *
 * Test runtime voi cache that se duoc Next.js runtime cap nhat khi render.
 * Source-string test du de xac minh contract.
 *
 * Refs:
 *  - node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md
 *  - src/lib/navigation/resolve-nav-actor.ts
 *  - src/lib/navigation/registry-capability.ts (NavActorProjection shape)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HERE = new URL("./", import.meta.url);

const resolveNavActor = readFileSync(new URL("./resolve-nav-actor.ts", HERE), "utf8");
const registryCapability = readFileSync(new URL("./registry-capability.ts", HERE), "utf8");
const dashboardLayout = readFileSync(new URL("../../app/dashboard/layout.tsx", HERE), "utf8");
const directEntryLayout = readFileSync(new URL("../../app/direct-entry/layout.tsx", HERE), "utf8");
const dashboardPage = readFileSync(new URL("../../app/dashboard/page.tsx", HERE), "utf8");
const directEntryPage = readFileSync(new URL("../../app/direct-entry/page.tsx", HERE), "utf8");

// ===== Group 1: resolve-nav-actor.ts wraps cache() =====

test("Gap1-1: resolve-nav-actor.ts imports cache tu react (RSC request-scoped memo)", () => {
  assert.match(resolveNavActor, /import\s*\{[^}]*\bcache\b[^}]*\}\s*from\s*["']react["']/);
});

test("Gap1-2: resolveActorForRequest duoc wrap bang React cache()", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveActorForRequest\s*=\s*cache\(/,
    "resolveActorForRequest phai duoc wrap boi React cache() de RSC memo hoa (request-scoped)",
  );
});

test("Gap1-3: resolveNavActorForAppShell cung duoc wrap bang cache()", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveNavActorForAppShell\s*=\s*cache\(/,
    "resolveNavActorForAppShell phai cung share cache voi resolveActorForRequest",
  );
});

test("Gap1-4: NavActorProjection KHONG chua app_user_id (PII hygiene)", () => {
  // type NavActorProjection khong duoc co field app_user_id (predicate
  // chi dung capabilities + scopes.kind).
  const typeMatch = registryCapability.match(/type\s+NavActorProjection\s*=\s*\{[\s\S]*?\}/);
  assert.ok(typeMatch, "phai dinh nghia NavActorProjection type");
  const typeBody = typeMatch[0];
  assert.ok(
    !/app_user_id/.test(typeBody),
    "NavActorProjection KHONG duoc chua app_user_id (PII hygiene)",
  );
  assert.ok(/capabilities:/.test(typeBody));
  assert.ok(/scopes:/.test(typeBody));
});

test("Gap1-5: nav actor query khi Direct Entry hoặc Admin navigation cần thiết", () => {
  assert.match(
    resolveNavActor,
    /resolveNavActorForAppShell\s*=\s*cache\(\s*async\s*\(\s*input:\s*\{\s*directEntryEnabled:\s*boolean;\s*adminNavigationEnabled\?:\s*boolean;\s*\}\s*\)/,
  );
  assert.match(resolveNavActor, /if\s*\(\s*!input\.directEntryEnabled\s*&&\s*!input\.adminNavigationEnabled\s*\)/);
  assert.match(resolveNavActor, /return\s+null/);
});

// ===== Group 2: layout files share same resolver =====

test("Gap1-6: dashboard/layout.tsx resolves nav actor for Admin even when Direct Entry UI is off", () => {
  assert.match(
    dashboardLayout,
    /await resolveNavActorForAppShell\(\s*\{\s*directEntryEnabled,\s*adminNavigationEnabled:\s*true,?\s*\}\s*\)/,
  );
});

test("Gap1-7: direct-entry/layout.tsx goi resolveNavActorForAppShell({directEntryEnabled})", () => {
  assert.match(
    directEntryLayout,
    /await resolveNavActorForAppShell\(\s*\{\s*directEntryEnabled\s*\}\s*\)/,
  );
});

// ===== Group 3: page files use shared resolveActorForRequest =====

test("Gap1-8: dashboard/page.tsx goi resolveActorForRequest (share cache voi layout)", () => {
  // Layout goi resolveNavActorForAppShell → cung cache. Chi can verify page
  // goi resolveActorForRequest (khong goi truc tiep getDirectEntryActor).
  assert.match(dashboardPage, /resolveActorForRequest\(\)/);
  // Page KHONG goi truc tiep getDirectEntryActor de tranh bypass cache.
  assert.ok(
    !/getDirectEntryActor\(/.test(dashboardPage),
    "dashboard/page KHONG duoc goi getDirectEntryActor truc tiep (phai qua resolveActorForRequest de share cache)",
  );
});

test("Gap1-9: direct-entry/page.tsx goi resolveActorForRequest (share cache voi layout)", () => {
  assert.match(directEntryPage, /resolveActorForRequest\(\)/);
  assert.ok(
    !/getDirectEntryActor\(/.test(directEntryPage),
    "direct-entry/page KHONG duoc goi getDirectEntryActor truc tiep (phai qua resolveActorForRequest)",
  );
});

test("Gap1-10: direct-entry/page.tsx skip resolve khi UI flag off (tranh query thua)", () => {
  // Page phai check uiEnabled truoc khi giao `resolveActorForRequest` (consistency
  // voi layout `resolveNavActorForAppShell` cung skip khi flag off).
  const codeOnly = directEntryPage
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");
  // Ternary check `uiEnabled ? ... : null` la chap nhan (P3-W06A R1).
  assert.match(codeOnly, /uiEnabled\s*\?\s*await\s+resolveActorForRequest/);
});

// ===== Group 4: dashboard/direct-entry resolve thuc su share =====

test("Gap1-11: dashboard va page chi import 'resolveActorForRequest' (cung module)", () => {
  assert.match(dashboardPage, /from\s*["']@\/lib\/navigation\/resolve-nav-actor["']/);
  assert.match(dashboardPage, /resolveActorForRequest/);
});

test("Gap1-12: layout va page deu import tu cung module resolve-nav-actor", () => {
  // Layout import 'resolveNavActorForAppShell'.
  assert.match(dashboardLayout, /resolveNavActorForAppShell/);
  // Page import 'resolveActorForRequest'.
  assert.match(dashboardPage, /resolveActorForRequest/);
  // Cung source file.
  assert.match(dashboardLayout, /from\s*["']@\/lib\/navigation\/resolve-nav-actor["']/);
  assert.match(dashboardPage, /from\s*["']@\/lib\/navigation\/resolve-nav-actor["']/);
});

test("Gap1-13: RSC actor resolver reads cookies without attempting a forbidden write", () => {
  assert.match(
    resolveNavActor,
    /getDirectEntryActor\(createDirectEntryActorRepository\(\),\s*\{\s*cookieWriteMode:\s*["']read-only["'],?\s*\}\)/,
  );
});

test("VFIN-01 & VFIN-02: resolveVendorFinanceAccessForRequest is wrapped by React cache() and probes server-side Accounting/Reconcile access only when DIRECT_ENTRY_API_ENABLED is true", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveVendorFinanceAccessForRequest\s*=\s*cache\(/,
  );
  assert.match(resolveNavActor, /process\.env\.DIRECT_ENTRY_API_ENABLED\s*===\s*["']true["']/);
  assert.match(resolveNavActor, /!vendorFinanceRecordNavPredicate\(projection\)/);
  assert.match(resolveNavActor, /projection\.hasVendorFinanceAccess\s*=\s*true/);
  assert.match(resolveNavActor, /projection\.hasVendorFinanceRecordAccess\s*=\s*true/);
  assert.match(resolveNavActor, /projection\.hasVendorFinanceReconcileAccess\s*=\s*true/);
});

test("W2S2 WP2: resolveSalaryAdvanceAccessForRequest is wrapped by React cache() and probes server-side Salary Advance access via non-throwing getActorAccess when DIRECT_ENTRY_API_ENABLED is true", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveSalaryAdvanceAccessForRequest\s*=\s*cache\(/,
  );
  assert.match(
    resolveNavActor,
    /createSalaryAdvanceRepository\(\)\.getActorAccess\(/,
  );
  assert.doesNotMatch(
    resolveNavActor,
    /createSalaryAdvanceRepository\(\)\.getActorContext\(/,
  );
  assert.match(resolveNavActor, /!salaryAdvanceNavPredicate\(projection\)/);
  assert.match(resolveNavActor, /projection\.hasSalaryAdvanceAccess\s*=\s*true/);
});

test("T1A: resolveNavActorForAppShell forwards server-confirmed allowed_worker_tabs onto NavActorProjection", () => {
  assert.match(
    resolveNavActor,
    /actor\.actor\.allowed_worker_tabs\s*!==\s*undefined/,
  );
  assert.match(
    resolveNavActor,
    /allowed_worker_tabs:\s*actor\.actor\.allowed_worker_tabs/,
  );
});

test("WP7B R7: resolveLeaveManagementAccessForRequest is wrapped by React cache() and probes read-only getActorAccess instead of getMySummary", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveLeaveManagementAccessForRequest\s*=\s*cache\(/,
  );
  assert.match(
    resolveNavActor,
    /createLeaveRepository\(\)\.getActorAccess\(/,
  );
  assert.doesNotMatch(
    resolveNavActor,
    /createLeaveRepository\(\)\.getMySummary\(/,
  );
  assert.match(resolveNavActor, /canAccess:\s*access\.data\.can_access/);
  assert.match(resolveNavActor, /canManageConfig:\s*access\.data\.can_manage_config/);
  assert.match(resolveNavActor, /canViewMonthlyReport:\s*access\.data\.can_view_monthly_report/);
  assert.match(resolveNavActor, /!leaveManagementNavPredicate\(projection\)/);
  assert.match(resolveNavActor, /projection\.hasLeaveManagementAccess\s*=\s*true/);
});

test("WP7B D-WP7B-01: server projection builders project minimal hasAttendanceDepartmentHeadAccess boolean without dumping assigned_roles into NavActorProjection", () => {
  const adminLayout = readFileSync(new URL("../../app/admin/layout.tsx", HERE), "utf8");
  const reportApi = readFileSync(new URL("../attendance/attendance-report-api.ts", HERE), "utf8");
  const matrixApi = readFileSync(
    new URL("../attendance/attendance-monthly-matrix-api.ts", HERE),
    "utf8",
  );

  // NavActorProjection carries ONLY the minimal boolean flag, never assigned_roles
  const navProjectionBlock = registryCapability.match(
    /export\s+type\s+NavActorProjection\s*=\s*\{[\s\S]*?\n\};/,
  )?.[0];
  assert.ok(navProjectionBlock, "NavActorProjection declaration must exist");
  assert.match(navProjectionBlock, /hasAttendanceDepartmentHeadAccess\?:\s*boolean;/);
  assert.doesNotMatch(navProjectionBlock, /assigned_roles/);

  // Server projection builders derive the boolean via hasActiveDepartmentHeadRole(...)
  // and AdminLayout delegates to resolveNavActorForAppShell (WP13 M1).
  assert.match(
    resolveNavActor,
    /hasAttendanceDepartmentHeadAccess:\s*hasActiveDepartmentHeadRole\(actor\.actor\)/,
  );
  assert.match(
    adminLayout,
    /resolveNavActorForAppShell\(\{\s*directEntryEnabled,\s*adminNavigationEnabled:\s*true,?\s*\}\)/,
  );
  assert.match(
    reportApi,
    /hasAttendanceDepartmentHeadAccess:\s*hasActiveDepartmentHeadRole\(actor\)/,
  );
  assert.match(
    matrixApi,
    /hasAttendanceDepartmentHeadAccess:\s*hasActiveDepartmentHeadRole\(actor\)/,
  );
});

test("WP8D nav readonly: resolveWorkReportObligationsAccessForRequest is wrapped by React cache(), uses read-only hasActiveObligations probe instead of listMine, and avoids cross-request cache", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveWorkReportObligationsAccessForRequest\s*=\s*cache\(/,
  );
  assert.match(
    resolveNavActor,
    /createSubmissionRepository\(\)\.hasActiveObligations\(/,
  );
  assert.doesNotMatch(
    resolveNavActor,
    /createSubmissionRepository\(\)\.listMine\(/,
    "AppShell navbar probe must NEVER call listMine (which triggers materializer DB writes)",
  );
  const codeOnly = resolveNavActor
    .split("\n")
    .filter((line) => !/^\s*(\/\*\*|\*|\/\/)/.test(line))
    .join("\n");
  assert.doesNotMatch(
    codeOnly,
    /\bunstable_cache\b/,
    "resolve-nav-actor.ts must never use cross-request unstable_cache",
  );
  assert.match(resolveNavActor, /process\.env\.WORK_REPORTS_API_ENABLED\s*===\s*["']true["']/);
  assert.match(resolveNavActor, /!workReportsNavPredicate\(projection\)/);
  assert.match(resolveNavActor, /resolveWorkReportObligationsAccessForRequest\(\)/);
  assert.match(resolveNavActor, /projection\.hasWorkReportObligations\s*=\s*true/);
});

test("WP8D-2 R1: resolveWorkReportAssignmentAccessForRequest & resolveWorkReportShellActorForRequest are wrapped by React cache(), use read-only assignment access, and avoid cross-request cache", () => {
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveWorkReportAssignmentAccessForRequest\s*=\s*cache\(/,
  );
  assert.match(
    resolveNavActor,
    /export\s+const\s+resolveWorkReportShellActorForRequest\s*=\s*cache\(/,
  );
  assert.match(
    resolveNavActor,
    /createAssignmentRepository\(\)\.hasAssignmentAccess\(/,
  );
  assert.match(resolveNavActor, /!workReportAssignmentPredicate\(projection\)/);
  assert.match(resolveNavActor, /projection\.hasWorkReportAssignmentAccess\s*=\s*true/);
  assert.match(registryCapability, /hasWorkReportAssignmentAccess\?:\s*boolean;/);
});
