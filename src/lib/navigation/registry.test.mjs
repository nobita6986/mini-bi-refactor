/**
 * Targeted tests cho navigation registry.
 * Style: node:test + pure assertions trên module exports.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// registry.ts là TypeScript — dùng dynamic import để Node loader xử lý
// (đã được khai báo trong scripts.test:main dưới --conditions=react-server
// hoặc node loader sẽ compile .ts trong monorepos cấu hình TS).
// Để chạy độc lập (không qua scripts.test:main), dùng `node --experimental-strip-types`.
const mod = await import("./registry.ts");
const {
  CURRENT_NAV_ENTRIES, NAV_ENTRIES, entriesForViewport, findEntryByPath, groupNavEntries,
} = mod;
const { isDirectEntryUiEnabled } = await import("../direct-entry/ui-model.ts");

test("CURRENT_NAV_ENTRIES chứa các entry hiện hành trong một registry", () => {
  assert.equal(CURRENT_NAV_ENTRIES.length, 14, "phải có đúng 14 entries current sau WP13 N1");
  const ids = CURRENT_NAV_ENTRIES.map((e) => e.id).sort();
  assert.deepEqual(
    ids,
    [
      "admin",
      "attendance-report",
      "change-requests",
      "dashboard",
      "direct-entry",
      "finance",
      "leave",
      "leave-admin",
      "project-operations",
      "recruitment-posts",
      "salary-advances",
      "work-report-management",
      "work-reports",
      "worker-operations",
    ],
    `got ids: ${ids.join(",")}`
  );
});

test("Global IA nav groups enforce Tổng quan → Công việc của tôi → Tài chính → Quản trị, and omit empty groups", () => {
  const menu = groupNavEntries(entriesForViewport("desktop", true).map(({ id, label, path, group }) => ({
    id, label, path, group,
  })));
  assert.deepEqual(menu.filter((item) => item.type === "group").map((item) => ({
    id: item.id,
    label: item.label,
    children: item.entries.map((entry) => entry.id),
  })), [
    {
      id: "my-work",
      label: "Công việc của tôi",
      children: [
        "direct-entry",
        "worker-operations",
        "work-reports",
        "leave",
        "recruitment-posts",
      ],
    },
    {
      id: "finance",
      label: "Tài chính",
      children: [
        "finance",
        "salary-advances",
      ],
    },
    {
      id: "management",
      label: "Quản trị",
      children: [
        "project-operations",
        "leave-admin",
        "work-report-management",
        "attendance-report",
        "admin",
      ],
    },
  ]);
  assert.deepEqual(
    menu.map((item) => item.type === "entry" ? item.entry.id : `group:${item.id}`),
    ["dashboard", "group:my-work", "group:finance", "group:management"],
  );
  const dashboardOnly = CURRENT_NAV_ENTRIES.filter((entry) => entry.id === "dashboard")
    .map(({ id, label, path, group }) => ({ id, label, path, group }));
  assert.deepEqual(
    groupNavEntries(dashboardOnly).map((item) => item.type === "entry" ? item.entry.id : item.id),
    ["dashboard"],
  );
});

test("Dashboard label là 'Tổng quan' và path '/dashboard'", () => {
  const dashboard = CURRENT_NAV_ENTRIES.find((e) => e.id === "dashboard");
  assert.ok(dashboard);
  assert.equal(dashboard?.label, "Tổng quan");
  assert.equal(dashboard?.path, "/dashboard");
});

test("Direct Entry status current, desktop + mobile visible", () => {
  const direct = CURRENT_NAV_ENTRIES.find((e) => e.id === "direct-entry");
  assert.ok(direct);
  assert.equal(direct?.status, "current");
  assert.equal(direct?.visibility.desktop, true);
  assert.equal(direct?.visibility.mobile, true);
  assert.equal(direct?.path, "/direct-entry");
});

test("Pipeline Check đã bị loại khỏi CURRENT_NAV_ENTRIES và toàn bộ NAV_ENTRIES", () => {
  const all = NAV_ENTRIES.map((e) => e.id);
  assert.ok(!all.includes("pipeline-check"), "NAV_ENTRIES không còn 'pipeline-check'");
  const currentIds = CURRENT_NAV_ENTRIES.map((e) => e.id);
  assert.ok(
    !currentIds.includes("pipeline-check"),
    "CURRENT_NAV_ENTRIES không còn 'pipeline-check'"
  );
});

test("Work Reports hiện trong menu hiện hành sau khi F1 được tích hợp", () => {
  const entry = CURRENT_NAV_ENTRIES.find((item) => item.id === "work-reports");
  assert.ok(entry);
  assert.equal(entry?.status, "current");
  assert.equal(entry?.label, "Báo cáo của tôi");
  assert.equal(entry?.path, "/work-reports");
  assert.equal(entry?.group, "my-work");
});

test("Change Requests giữ route nhưng ẩn khỏi menu desktop và mobile", () => {
  const entry = CURRENT_NAV_ENTRIES.find((item) => item.id === "change-requests");
  assert.ok(entry);
  assert.equal(entry?.path, "/direct-entry/change-requests");
  assert.deepEqual(entry?.visibility, { desktop: false, mobile: false });
  assert.equal(entriesForViewport("desktop", true).some((item) => item.id === "change-requests"), false);
  assert.equal(entriesForViewport("mobile", true).some((item) => item.id === "change-requests"), false);
});

test("Work Report management unifies the 5 management routes under 'Quản lý báo cáo' and Attendance Report points to /admin/attendance in 'management'", () => {
  const management = CURRENT_NAV_ENTRIES.find((item) => item.id === "work-report-management");
  assert.ok(management);
  assert.equal(management?.label, "Quản lý báo cáo");
  assert.equal(management?.path, "/work-reports/assignments");
  assert.equal(management?.group, "management");
  assert.equal(management?.capability, "work_report_management");
  assert.deepEqual(management?.visibility, { desktop: true, mobile: true });
  assert.deepEqual(management?.matchPaths, [
    "/work-reports/assignments",
    "/work-reports/reviews",
    "/work-reports/analytics",
    "/work-reports/templates",
    "/work-reports/delegations",
  ]);

  const attendance = CURRENT_NAV_ENTRIES.find((item) => item.id === "attendance-report");
  assert.ok(attendance);
  assert.equal(attendance?.label, "Báo cáo chấm công");
  assert.equal(attendance?.path, "/admin/attendance");
  assert.equal(attendance?.group, "management");
  assert.equal(attendance?.capability, "attendance_report");
  assert.equal(findEntryByPath("/admin/attendance")?.id, "attendance-report");
});

test("Finance group entries Công nợ Vendor (/finance) and Ứng lương (/salary-advances) belong to 'finance' and highlight child routes", () => {
  const entry = CURRENT_NAV_ENTRIES.find((item) => item.id === "finance");
  assert.ok(entry);
  assert.equal(entry?.label, "Công nợ Vendor");
  assert.equal(entry?.path, "/finance");
  assert.equal(entry?.group, "finance");
  assert.equal(entry?.capability, "finance");
  assert.deepEqual(entry?.visibility, { desktop: true, mobile: true });
  for (const childPath of [
    "/finance",
    "/finance/vendors",
    "/finance/vendors/vendor_1",
    "/finance/opening-balance",
    "/finance/documents/00000000-0000-4000-8000-000000000001",
  ]) {
    assert.equal(findEntryByPath(childPath)?.id, "finance", childPath);
  }
  const salaryAdvances = CURRENT_NAV_ENTRIES.find((item) => item.id === "salary-advances");
  assert.ok(salaryAdvances);
  assert.equal(salaryAdvances?.label, "Ứng lương");
  assert.equal(salaryAdvances?.path, "/salary-advances");
  assert.equal(salaryAdvances?.group, "finance");
  assert.equal(salaryAdvances?.capability, "salary_advances");
});

test("Desktop viewport theo feature flag, luôn giữ Dashboard và không có Pipeline Check", () => {
  const desktop = entriesForViewport("desktop", true);
  assert.ok(!desktop.some((e) => e.id === "pipeline-check"));
  assert.ok(desktop.some((e) => e.id === "dashboard"));
  assert.ok(desktop.some((e) => e.id === "direct-entry"));
  assert.deepEqual(
    entriesForViewport("desktop", false).map((entry) => entry.id),
    [
      "dashboard",
      "work-reports",
      "leave",
      "recruitment-posts",
      "finance",
      "salary-advances",
      "leave-admin",
      "work-report-management",
      "attendance-report",
      "admin",
    ],
  );
});

test("Mobile viewport theo feature flag, luôn giữ Dashboard và không có Pipeline Check", () => {
  const mobile = entriesForViewport("mobile", true);
  assert.ok(!mobile.some((e) => e.id === "pipeline-check"));
  assert.ok(mobile.some((e) => e.id === "dashboard"));
  assert.ok(mobile.some((e) => e.id === "direct-entry"));
  assert.deepEqual(
    entriesForViewport("mobile", false).map((entry) => entry.id),
    [
      "dashboard",
      "work-reports",
      "leave",
      "recruitment-posts",
      "finance",
      "salary-advances",
      "leave-admin",
      "work-report-management",
      "attendance-report",
      "admin",
    ],
  );
});

test("feature flag Direct Entry chỉ mở với giá trị chính xác true", () => {
  assert.equal(isDirectEntryUiEnabled("true"), true);
  const expectedWithoutDirectEntry = [
    "dashboard",
    "work-reports",
    "leave",
    "recruitment-posts",
    "finance",
    "salary-advances",
    "leave-admin",
    "work-report-management",
    "attendance-report",
    "admin",
  ];
  for (const flag of [undefined, "", "false", "TRUE", "1", " true "]) {
    assert.equal(isDirectEntryUiEnabled(flag), false, String(flag));
    assert.deepEqual(entriesForViewport("desktop", isDirectEntryUiEnabled(flag)).map((entry) => entry.id), expectedWithoutDirectEntry);
    assert.deepEqual(entriesForViewport("mobile", isDirectEntryUiEnabled(flag)).map((entry) => entry.id), expectedWithoutDirectEntry);
  }
});

test("Direct Entry capability metadata biểu diễn 'một trong entry_own | entry_team | entry_admin'", () => {
  // Capability lưu dưới dạng string union; Direct Entry chọn token rộng nhất
  // (entry_admin) để biểu diễn "một trong ba". App Shell chưa filter;
  // P3 sẽ đối chiếu session thật với cả ba token.
  const direct = CURRENT_NAV_ENTRIES.find((e) => e.id === "direct-entry");
  assert.ok(direct);
  assert.ok(
    ["entry_own", "entry_team", "entry_admin"].includes(direct?.capability ?? ""),
    `capability phải là một trong entry_own | entry_team | entry_admin, got '${direct?.capability}'`
  );
});

test("registry: mỗi entry có id ổn định, label, path, icon, status, capability, visibility", () => {
  for (const entry of NAV_ENTRIES) {
    assert.ok(entry.id.length > 0, `entry phải có id hợp lệ (got '${entry.id}')`);
    assert.ok(entry.label.length > 0, `entry '${entry.id}' phải có label`);
    assert.ok(entry.path.startsWith("/"), `entry '${entry.id}' path phải bắt đầu bằng '/'`);
    assert.ok(
      typeof entry.icon === "function" || typeof entry.icon === "object",
      `entry '${entry.id}' phải có icon component`
    );
    assert.ok(
      entry.status === "current" || entry.status === "planned",
      `entry '${entry.id}' status không hợp lệ: ${entry.status}`
    );
    assert.ok(typeof entry.description === "string" && entry.description.length > 0);
    assert.ok(typeof entry.capability === "string");
    assert.ok(
      [
        "any",
        "owner",
        "finance",
        "hrp",
        "entry_own",
        "entry_team",
        "entry_admin",
        "project_admin",
        "worker_operations",
        "change_requests",
        "admin_area",
        "attendance_report",
        "work_reports",
        "work_report_management",
        "work_report_assignments",
        "work_report_reviews",
        "work_report_analytics",
        "workforce_offboarding",
        "leave",
        "leave_admin",
        "salary_advances",
      ].includes(entry.capability),
      `entry '${entry.id}' capability không hợp lệ: ${entry.capability}`
    );
    assert.ok(typeof entry.visibility.desktop === "boolean");
    assert.ok(typeof entry.visibility.mobile === "boolean");
  }
});

test("id của các entry là duy nhất", () => {
  const ids = NAV_ENTRIES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `id trùng lặp: ${ids.join(", ")}`);
});

test("path của các entry là duy nhất (tránh collision khi active match)", () => {
  const paths = NAV_ENTRIES.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, `path trùng lặp: ${paths.join(", ")}`);
});

test("CURRENT_NAV_ENTRIES chỉ chứa status = 'current'", () => {
  for (const entry of CURRENT_NAV_ENTRIES) {
    assert.equal(entry.status, "current");
  }
});

test("entriesForViewport('desktop') trả về entry có visibility.desktop = true", () => {
  const desktop = entriesForViewport("desktop", true);
  assert.ok(desktop.length > 0, "phải có ít nhất 1 entry cho desktop");
  for (const entry of desktop) {
    assert.equal(entry.visibility.desktop, true);
  }
});

test("entriesForViewport('mobile') trả về entry có visibility.mobile = true", () => {
  const mobile = entriesForViewport("mobile", true);
  assert.ok(mobile.length > 0, "phải có ít nhất 1 entry cho mobile");
  for (const entry of mobile) {
    assert.equal(entry.visibility.mobile, true);
  }
});

test("findEntryByPath('/dashboard') trả về dashboard entry", () => {
  const entry = findEntryByPath("/dashboard");
  assert.ok(entry);
  assert.equal(entry?.id, "dashboard");
});

test("findEntryByPath('/direct-entry') trả về direct-entry entry", () => {
  const entry = findEntryByPath("/direct-entry");
  assert.ok(entry);
  assert.equal(entry?.id, "direct-entry");
});

test("findEntryByPath('/work-reports') tách biệt 2 trang cá nhân với 5 nhánh quản lý báo cáo", () => {
  assert.equal(findEntryByPath("/work-reports")?.id, "work-reports");
  assert.equal(findEntryByPath("/work-reports/my-reports")?.id, "work-reports");
  assert.equal(findEntryByPath("/work-reports/assignments")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/assignments/detail")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/reviews")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/reviews/obligation-1")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/analytics")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/analytics/detail")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/templates")?.id, "work-report-management");
  assert.equal(findEntryByPath("/work-reports/delegations")?.id, "work-report-management");
  assert.equal(findEntryByPath("/leave")?.id, "leave");
  assert.equal(findEntryByPath("/salary-advances")?.id, "salary-advances");
  assert.equal(findEntryByPath("/recruitment-posts")?.id, "recruitment-posts");
  assert.equal(findEntryByPath("/admin/attendance")?.id, "attendance-report");
  assert.equal(findEntryByPath("/admin/catalog/personnel")?.id, "admin");
});

test("findEntryByPath('/pipeline-check') trả về undefined (đã retired khỏi navbar)", () => {
  // Pipeline Check redirect ở page-level, không còn trong registry.
  const entry = findEntryByPath("/pipeline-check");
  assert.equal(entry, undefined);
});

test("findEntryByPath trả về undefined cho path không đăng ký (vd. landing '/')", () => {
  const entry = findEntryByPath("/");
  assert.equal(entry, undefined);
});

test("registry: KHÔNG có chuỗi 'Google Sheets' hay 'n8n' trong description của entry current", () => {
  // Bảo đảm navbar hiện hành không còn nhắc tới Google Sheets → n8n.
  for (const entry of CURRENT_NAV_ENTRIES) {
    assert.ok(
      !/Google Sheets/i.test(entry.description),
      `entry '${entry.id}' description còn chứa 'Google Sheets'`
    );
    assert.ok(
      !/\bn8n\b/i.test(entry.description),
      `entry '${entry.id}' description còn chứa 'n8n'`
    );
  }
});

// ===== P3-W06A R2 — Side-effect registration into full `pnpm test` =====
// Registry capability + request-scoped actor resolver tests chạy targeted
// nhưng chưa được đăng ký vào `pnpm test` đầy đủ. Import side-effect
// một chiều từ `registry.test.mjs` để cả hai suite chạy qua
// `test:app-nav-02a` (và do đó chạy qua `pnpm test`).
//
// Điều kiện an toàn (P3-W06A R2):
// - `registry-capability.test.mjs` và `resolve-nav-actor.test.mjs` KHÔNG
//   import ngược `registry.test.mjs` (một chiều).
// - Cả hai chỉ phụ thuộc module `.ts` độc lập, không tạo circular.
// - Không thay đổi `package.json` / `pnpm-lock.yaml`.
import "./registry-capability.test.mjs";
import "./resolve-nav-actor.test.mjs";
