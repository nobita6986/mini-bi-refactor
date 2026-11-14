import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_SECTIONS, visibleAdminSections } from "../admin/admin-navigation.ts";
import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideAttendanceReportPageAccess,
  decidePersonnelCatalogPageAccess,
  decideRecruitmentLocationCatalogPageAccess,
} from "../auth/direct-entry-page-access.ts";
import {
  adminPanelNavPredicate,
  attendanceReportNavPredicate,
} from "../navigation/registry-capability.ts";
import {
  computeHqLocationRequestFingerprint,
  getAttendanceCheckInPhoto,
  getAttendanceAdminReport,
  getAttendanceSelfCheckInPhoto,
  getAttendanceSelfHistory,
  putAttendanceHqLocation,
} from "./attendance-report-api.ts";
import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_REPORT_ERROR_CODES,
  attendanceReportHttpStatusForError,
  firstDayOfIsoMonth,
  formatCoordinatePair,
  formatDistanceMeters,
  getVietnamTodayIsoDate,
  isValidIsoCalendarDate,
  parseAttendanceReportQuery,
  parseAttendanceSelfHistoryQuery,
  parseSetHqLocationBody,
  projectAttendanceAdminReport,
  projectSetHqLocationResult,
  shiftIsoDateDays,
} from "./attendance-report-contract.ts";
import { createServiceAttendanceAdminReportRepository } from "./attendance-report-repository.ts";
import { createServiceAttendanceSelfHistoryRepository } from "./attendance-self-history-repository.ts";

const AUTH_SUBJECT = "19000000-0000-4000-8000-0000000000a1";
const APP_USER_ID = "29000000-0000-4000-8000-0000000000a1";
const CHECKIN_ID = "39000000-0000-4000-8000-0000000000c1";
const IDEMPOTENCY_KEY = "49000000-0000-4000-8000-0000000000d1";
const OTHER_IDEMPOTENCY_KEY = "49000000-0000-4000-8000-0000000000d2";
const TEAM_ID = "59000000-0000-4000-8000-0000000000e1";

const ALL_SCOPE = [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }];
const TEAM_SCOPE = [{ kind: "team", reference: TEAM_ID, valid_from: "2026-01-01", valid_to: null }];
const OWN_SCOPE = [{ kind: "own", reference: APP_USER_ID, valid_from: "2026-01-01", valid_to: null }];

const FULL_ADMIN_CAPS = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
const BOD_PRIVILEGED_CAPS = ["entry_privileged_edit"];
const BOD_WORK_REPORTS_CAPS = ["report_analytics_view", "report_view"];
const ACCOUNTING_CAPS = ["catalog_master_manage", "change_review", "entry_admin"];
const TEAM_LEADER_CAPS = [
  "team_manager_assign",
  "report_view",
  "report_analytics_view",
  "report_assign",
  "report_review",
];

function makeSessionOk(capabilities, scopes = ALL_SCOPE, overrides = {}) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_SUBJECT,
        app_user_id: APP_USER_ID,
        display_name: "Test Actor",
        enabled: true,
        capabilities,
        scopes,
        self_recruiter_suggestion: null,
        session: {
          provider: "supabase",
          verification: "getUser",
          authenticated_at: "2026-10-23T01:00:00.000Z",
        },
        ...overrides,
      },
    },
  };
}

function makeSessionDenied(reason) {
  return { actor: { ok: false, reason } };
}

function buildValidReportRpcPayload(overrides = {}) {
  return {
    viewer: { can_configure_hq: true },
    filters: {
      from_date: "2026-10-17",
      to_date: "2026-10-23",
      search: null,
      employee_id: null,
      timezone: ATTENDANCE_BUSINESS_TIMEZONE,
    },
    employee_options: [
      {
        app_user_id: APP_USER_ID,
        display_name: "Nguyễn Văn A",
        personnel_code: "NV001",
      },
    ],
    current_hq: {
      version: 2,
      latitude: 21.028511,
      longitude: 105.804817,
      effective_from: "2026-10-23T01:00:00.000Z",
      effective_from_local: "2026-10-23 08:00:00",
      configured_by_display_name: "Quản trị viên",
    },
    overview: {
      total_checkins: 2,
      unique_employees: 1,
      verified_time_count: 1,
      unverified_time_count: 1,
      distance_computed_count: 1,
      distance_unavailable_count: 1,
      avg_distance_meters: 124.5,
      max_distance_meters: 124.5,
    },
    pagination: {
      page: 1,
      page_size: 25,
      total_rows: 2,
      total_pages: 1,
      has_more: false,
    },
    items: [
      {
        checkin_id: CHECKIN_ID,
        employee_display_name: "Nguyễn Văn A",
        personnel_code: "NV001",
        business_date: "2026-10-23",
        sequence_in_day: 1,
        captured_at: "2026-10-23T01:15:00.000Z",
        captured_at_local: "2026-10-23 08:15:00",
        received_at: "2026-10-23T01:15:03.000Z",
        time_source: "SERVER_ANCHORED",
        time_verified: true,
        sync_delay_seconds: 3,
        latitude: 21.029511,
        longitude: 105.805817,
        accuracy_meters: 12.4,
        address_hint: "Cầu Giấy, Hà Nội",
        note: "Đi làm đúng giờ",
        distance_meters: 124.5,
        distance_status: "COMPUTED",
        hq_version_used: 2,
      },
    ],
    ...overrides,
  };
}

function buildValidSetHqRpcPayload(overrides = {}) {
  return {
    replayed: false,
    hq: {
      version: 1,
      latitude: 21.028511,
      longitude: 105.804817,
      effective_from: "2026-10-23T02:00:00.000Z",
      effective_from_local: "2026-10-23 09:00:00",
      configured_by_display_name: "Quản trị viên",
    },
    ...overrides,
  };
}

function makePutRequest(
  body,
  {
    url = "https://bi.example.com/api/admin/attendance/hq-location",
    origin = "https://bi.example.com",
    contentType = "application/json",
    extraHeaders = {},
  } = {},
) {
  const headers = new Headers({
    host: "bi.example.com",
    ...(origin === null ? {} : { origin }),
    ...(contentType === null ? {} : { "content-type": contentType }),
    ...extraHeaders,
  });
  return new Request(url, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("Attendance Report navigation, Admin shell, and page-gate matrix enforces Admin & canonical BoD only", () => {
  const allSections = ADMIN_SECTIONS.map(({ id, label, href }) => ({ id, label, href }));
  const workerEditHistorySection = allSections.filter(({ id }) => id === "worker-edit-history");
  const allSectionsWithoutWorkerHistory = allSections.filter(({ id }) => id !== "worker-edit-history");
  const catalogSections = allSectionsWithoutWorkerHistory.filter(
    ({ id }) =>
      ![
        "organization-persons",
        "departments",
        "accounts",
        "project-team-scopes",
        "provinces",
        "industrial-parks",
        "attendance",
      ].includes(id),
  );
  const bodSections = allSections.filter(({ id }) =>
    ["provinces", "industrial-parks", "attendance"].includes(id),
  );

  const matrix = [
    {
      name: "Full Admin (@ all)",
      caps: FULL_ADMIN_CAPS,
      scopes: ALL_SCOPE,
      reportAllowed: true,
      adminShellAllowed: true,
      personnelAllowed: true,
      accountsAllowed: true,
      expectedSections: allSectionsWithoutWorkerHistory,
    },
    {
      name: "Allowlisted Full Admin with worker_edit_history_view (@ all)",
      caps: [...FULL_ADMIN_CAPS, "worker_edit_history_view"],
      scopes: ALL_SCOPE,
      reportAllowed: true,
      adminShellAllowed: true,
      personnelAllowed: true,
      accountsAllowed: true,
      expectedSections: allSections,
    },
    {
      name: "BoD via entry_privileged_edit (@ all)",
      caps: BOD_PRIVILEGED_CAPS,
      scopes: ALL_SCOPE,
      reportAllowed: true,
      adminShellAllowed: true,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: bodSections,
    },
    {
      name: "BoD via report_analytics_view + report_view (@ all)",
      caps: BOD_WORK_REPORTS_CAPS,
      scopes: ALL_SCOPE,
      reportAllowed: true,
      adminShellAllowed: true,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: bodSections,
    },
    {
      name: "Aggregate-only viewer (report_analytics_view @ all without report_view)",
      caps: ["report_analytics_view"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Submission-only viewer (report_view @ all without report_analytics_view)",
      caps: ["report_view"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Accounting / Catalog operator (catalog_master_manage @ all)",
      caps: ACCOUNTING_CAPS,
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: true,
      personnelAllowed: true,
      accountsAllowed: false,
      expectedSections: catalogSections,
    },
    {
      name: "Worker history reader without catalog/Full Admin authority (@ all)",
      caps: ["worker_edit_history_view"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: true,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: workerEditHistorySection,
    },
    {
      name: "Team Leader (team_manager_assign + report_* @ team)",
      caps: TEAM_LEADER_CAPS,
      scopes: TEAM_SCOPE,
      reportAllowed: true,
      adminShellAllowed: true,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [{ id: "attendance", label: "Báo cáo chấm công", href: "/admin/attendance" }],
    },
    {
      name: "Team Leader without report bundle (team_manager_assign @ team)",
      caps: ["team_manager_assign"],
      scopes: TEAM_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Team report viewer without team_manager_assign (report_view + report_analytics_view @ team)",
      caps: ["report_view", "report_analytics_view"],
      scopes: TEAM_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Team Leader caps at @ own only (missing team scope)",
      caps: TEAM_LEADER_CAPS,
      scopes: OWN_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Project Admin (entry_admin @ all without Full Admin triple)",
      caps: ["entry_admin"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Form Admin (report_form_manage @ all)",
      caps: ["report_form_manage"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Reviewer (change_review @ all)",
      caps: ["change_review"],
      scopes: ALL_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Staff (entry_own @ own)",
      caps: ["entry_create", "entry_own", "submission_create"],
      scopes: OWN_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "Full Admin triple at @ team only (missing all scope)",
      caps: FULL_ADMIN_CAPS,
      scopes: TEAM_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
    {
      name: "BoD entry_privileged_edit at @ team only (missing all scope)",
      caps: BOD_PRIVILEGED_CAPS,
      scopes: TEAM_SCOPE,
      reportAllowed: false,
      adminShellAllowed: false,
      personnelAllowed: false,
      accountsAllowed: false,
      expectedSections: [],
    },
  ];

  for (const row of matrix) {
    const resolved = makeSessionOk(row.caps, row.scopes).actor;
    assert.equal(attendanceReportNavPredicate(resolved.actor), row.reportAllowed, row.name);
    assert.equal(adminPanelNavPredicate(resolved.actor), row.adminShellAllowed, row.name);
    assert.equal(
      decideAttendanceReportPageAccess({ actor: resolved }),
      row.reportAllowed ? "ALLOW" : "ACCESS_DENIED",
      `${row.name}: /admin/attendance`,
    );
    assert.equal(
      decideAdminAreaAccess({ actor: resolved }),
      row.adminShellAllowed ? "ALLOW" : "ACCESS_DENIED",
      `${row.name}: /admin`,
    );
    assert.equal(
      decidePersonnelCatalogPageAccess({ actor: resolved }),
      row.personnelAllowed ? "ALLOW" : "ACCESS_DENIED",
      `${row.name}: /admin/catalog/personnel`,
    );
    assert.equal(
      decideAccountAccessPageAccess({ actor: resolved }),
      row.accountsAllowed ? "ALLOW" : "ACCESS_DENIED",
      `${row.name}: /admin/access/accounts`,
    );
    const expectedRecruitmentCatalogAllowed = row.expectedSections.some(
      (s) => s.id === "provinces" || s.id === "industrial-parks",
    );
    assert.equal(
      decideRecruitmentLocationCatalogPageAccess({ actor: resolved }),
      expectedRecruitmentCatalogAllowed ? "ALLOW" : "ACCESS_DENIED",
      `${row.name}: /admin/catalog/provinces`,
    );
    assert.deepEqual(visibleAdminSections(resolved.actor), row.expectedSections, row.name);
  }

  assert.equal(
    decideAttendanceReportPageAccess({ actor: makeSessionDenied("UNAUTHENTICATED").actor }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideAttendanceReportPageAccess({ actor: makeSessionDenied("ACTOR_DISABLED").actor }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideAttendanceReportPageAccess({ actor: makeSessionDenied("ACTOR_MAPPING_MISSING").actor }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideAttendanceReportPageAccess({ actor: null }),
    "TEMPORARY_UNAVAILABLE",
  );

  const attendancePageSource = readFileSync(
    new URL("../../app/admin/attendance/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(attendancePageSource, /resolveActorForRequest\(\)/);
  assert.match(attendancePageSource, /decideAttendanceReportPageAccess\(\{ actor \}\)/);
  assert.match(
    attendancePageSource,
    /case "ACCESS_DENIED":\s*(?:case "NOT_FOUND":\s*)?return <AccessDenied \/>;/,
  );

  const adminRootSource = readFileSync(
    new URL("../../app/admin/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(adminRootSource, /!adminAreaNavPredicate\(actor\.actor\)/);
  assert.match(adminRootSource, /redirect\("\/admin\/attendance"\)/);
});

test("GET /api/admin/attendance/report allows Full Admin, canonical BoD & canonical Team Leader and denies unauthorized roles before RPC", async () => {
  for (const [label, caps, scopes, canConfigureHq] of [
    ["Full Admin", FULL_ADMIN_CAPS, ALL_SCOPE, true],
    ["BoD privileged", BOD_PRIVILEGED_CAPS, ALL_SCOPE, false],
    ["BoD executive reports", BOD_WORK_REPORTS_CAPS, ALL_SCOPE, false],
    ["Team Leader", TEAM_LEADER_CAPS, TEAM_SCOPE, false],
  ]) {
    const rpcCalls = [];
    const isTeamLeader = label === "Team Leader";
    const repository = createServiceAttendanceAdminReportRepository(async (name, args) => {
      rpcCalls.push({ name, args });
      return {
        data: buildValidReportRpcPayload({
          viewer: { can_configure_hq: canConfigureHq },
          ...(isTeamLeader ? { current_hq: null } : {}),
        }),
        error: null,
      };
    });

    const response = await getAttendanceAdminReport(
      new Request(
        "https://bi.example.com/api/admin/attendance/report?from_date=2026-10-17&to_date=2026-10-23&page=1&page_size=25&search=%20NV001%20",
      ),
      {
        resolveSession: async () => makeSessionOk(caps, scopes),
        repository,
      },
    );

    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get("cache-control"), "private, no-store", label);
    const body = await response.json();
    assert.equal(body.ok, true, label);
    assert.equal(body.report.viewer.can_configure_hq, canConfigureHq, label);
    if (isTeamLeader) {
      assert.equal(body.report.current_hq, null, label);
    } else {
      assert.notEqual(body.report.current_hq, null, label);
    }
    assert.equal(rpcCalls.length, 1, label);
    assert.deepEqual(rpcCalls[0], {
      name: "attendance_admin_report",
      args: {
        p_auth_subject: AUTH_SUBJECT,
        p_app_user_id: APP_USER_ID,
        p_from_date: "2026-10-17",
        p_to_date: "2026-10-23",
        p_page: 1,
        p_page_size: 25,
        p_search: "NV001",
        p_employee_id: null,
      },
    });
  }

  for (const [label, caps, scopes] of [
    ["Team Leader missing report bundle", ["team_manager_assign"], TEAM_SCOPE],
    ["Team report viewer missing team_manager_assign", ["report_view", "report_analytics_view"], TEAM_SCOPE],
    ["Team Leader caps @ own", TEAM_LEADER_CAPS, OWN_SCOPE],
    ["Accounting", ACCOUNTING_CAPS, ALL_SCOPE],
    ["Project Admin", ["entry_admin"], ALL_SCOPE],
    ["Form Admin", ["report_form_manage"], ALL_SCOPE],
    ["Aggregate-only reader", ["report_analytics_view"], ALL_SCOPE],
    ["Submission-only reader", ["report_view"], ALL_SCOPE],
    ["Reviewer", ["change_review"], ALL_SCOPE],
    ["Staff", ["entry_own"], OWN_SCOPE],
    ["Full Admin @ team", FULL_ADMIN_CAPS, TEAM_SCOPE],
    ["BoD @ team", BOD_PRIVILEGED_CAPS, TEAM_SCOPE],
  ]) {
    let rpcCalled = false;
    const repository = createServiceAttendanceAdminReportRepository(async () => {
      rpcCalled = true;
      throw new Error("must not call RPC for unauthorized actor");
    });

    const response = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report"),
      {
        resolveSession: async () => makeSessionOk(caps, scopes),
        repository,
      },
    );

    assert.equal(response.status, 403, label);
    assert.equal(response.headers.get("cache-control"), "private, no-store", label);
    const body = await response.json();
    assert.deepEqual(body, { ok: false, code: "ATTENDANCE_REPORT_ACCESS_DENIED" }, label);
    assert.equal(rpcCalled, false, label);
  }
});

test("GET /api/admin/attendance/report validates session failures, client authority headers, and bounded query parameters", async () => {
  const unusedRepo = createServiceAttendanceAdminReportRepository(async () => {
    throw new Error("RPC must not be invoked");
  });

  // Unauthenticated, disabled, unmapped, thrown session, malformed actor UUID
  {
    const r401 = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report"),
      { resolveSession: async () => makeSessionDenied("UNAUTHENTICATED"), repository: unusedRepo },
    );
    assert.equal(r401.status, 401);
    assert.deepEqual(await r401.json(), { ok: false, code: "UNAUTHENTICATED" });

    const rDisabled = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report"),
      { resolveSession: async () => makeSessionDenied("ACTOR_DISABLED"), repository: unusedRepo },
    );
    assert.equal(rDisabled.status, 403);
    assert.deepEqual(await rDisabled.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

    const rBadUuid = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report"),
      {
        resolveSession: async () =>
          makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE, { app_user_id: "not-a-uuid" }),
        repository: unusedRepo,
      },
    );
    assert.equal(rBadUuid.status, 403);
    assert.deepEqual(await rBadUuid.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

    const rThrown = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report"),
      {
        resolveSession: async () => {
          throw new Error("cookie adapter down");
        },
        repository: unusedRepo,
      },
    );
    assert.equal(rThrown.status, 503);
    assert.deepEqual(await rThrown.json(), { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" });
  }

  // Disallowed client authority headers rejected before session resolution
  for (const headerName of [
    "x-app-user-id",
    "x-actor-id",
    "x-auth-subject",
    "x-user-id",
    "x-capabilities",
    "x-scope",
  ]) {
    let sessionResolved = false;
    const response = await getAttendanceAdminReport(
      new Request("https://bi.example.com/api/admin/attendance/report", {
        headers: { [headerName]: "forged" },
      }),
      {
        resolveSession: async () => {
          sessionResolved = true;
          return makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE);
        },
        repository: unusedRepo,
      },
    );
    assert.equal(response.status, 400, headerName);
    assert.deepEqual(
      await response.json(),
      { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" },
      headerName,
    );
    assert.equal(sessionResolved, false, headerName);
  }

  // Query validation cases
  const queryErrorCases = [
    ["?team_id=abc", "ATTENDANCE_REPORT_QUERY_INVALID"],
    ["?page=1&page=2", "ATTENDANCE_REPORT_QUERY_INVALID"],
    ["?from_date=2026-02-29&to_date=2026-03-01", "ATTENDANCE_REPORT_RANGE_INVALID"],
    ["?from_date=2026-10-24&to_date=2026-10-23", "ATTENDANCE_REPORT_RANGE_INVALID"],
    ["?from_date=2025-01-01&to_date=2026-01-04", "ATTENDANCE_REPORT_RANGE_INVALID"], // 368 days > 366
    ["?page=0", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    ["?page=1001", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    ["?page_size=0", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    ["?page_size=101", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    ["?page=1e2", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    [`?search=${"a".repeat(121)}`, "ATTENDANCE_REPORT_SEARCH_INVALID"],
    ["?search=abc%00def", "ATTENDANCE_REPORT_SEARCH_INVALID"],
    ["?employee_id=not-a-uuid", "ATTENDANCE_REPORT_EMPLOYEE_INVALID"],
    [`?employee_id=${APP_USER_ID}&employee_id=${APP_USER_ID}`, "ATTENDANCE_REPORT_QUERY_INVALID"],
    [`?employee_id=${APP_USER_ID}&search=NV001`, "ATTENDANCE_REPORT_FILTER_CONFLICT"],
  ];

  for (const [qs, expectedCode] of queryErrorCases) {
    const response = await getAttendanceAdminReport(
      new Request(`https://bi.example.com/api/admin/attendance/report${qs}`),
      {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: unusedRepo,
      },
    );
    assert.equal(response.status, 400, qs);
    assert.deepEqual(await response.json(), { ok: false, code: expectedCode }, qs);
  }

  // Exact employee_id filter with blank/omitted search normalizes UUID lowercase and forwards p_employee_id
  {
    const rpcCalls = [];
    const repoWithEmployee = createServiceAttendanceAdminReportRepository(async (name, args) => {
      rpcCalls.push({ name, args });
      return {
        data: buildValidReportRpcPayload({
          filters: {
            from_date: "2026-10-17",
            to_date: "2026-10-23",
            search: null,
            employee_id: APP_USER_ID,
            timezone: ATTENDANCE_BUSINESS_TIMEZONE,
          },
        }),
        error: null,
      };
    });

    const filteredRes = await getAttendanceAdminReport(
      new Request(
        `https://bi.example.com/api/admin/attendance/report?from_date=2026-10-17&to_date=2026-10-23&employee_id=%20${APP_USER_ID.toUpperCase()}%20&search=%20%20`,
      ),
      {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: repoWithEmployee,
      },
    );
    assert.equal(filteredRes.status, 200);
    const filteredBody = await filteredRes.json();
    assert.equal(filteredBody.ok, true);
    assert.equal(filteredBody.report.filters.employee_id, APP_USER_ID);
    assert.deepEqual(filteredBody.report.employee_options, [
      {
        app_user_id: APP_USER_ID,
        display_name: "Nguyễn Văn A",
        personnel_code: "NV001",
      },
    ]);
    assert.deepEqual(rpcCalls[0], {
      name: "attendance_admin_report",
      args: {
        p_auth_subject: AUTH_SUBJECT,
        p_app_user_id: APP_USER_ID,
        p_from_date: "2026-10-17",
        p_to_date: "2026-10-23",
        p_page: 1,
        p_page_size: 25,
        p_search: null,
        p_employee_id: APP_USER_ID,
      },
    });
  }

  // Exact 366-day range passes query parsing
  const boundary366 = parseAttendanceReportQuery(
    new URL("https://bi.example.com/api/admin/attendance/report?from_date=2025-01-01&to_date=2026-01-02"),
  );
  assert.equal(boundary366.ok, true);
});

test("PUT /api/admin/attendance/hq-location enforces CSRF, Full Admin-only authority, coordinate bounds, OCC, and idempotency", async () => {
  const unusedRepo = createServiceAttendanceAdminReportRepository(async () => {
    throw new Error("RPC must not be called");
  });

  // 1. Cross-origin & missing-Origin requests are rejected with 403 CSRF_REJECTED before session/RPC
  for (const badOrigin of [null, "https://evil.example.org"]) {
    let sessionCalled = false;
    const response = await putAttendanceHqLocation(
      makePutRequest(
        {
          latitude: 21.028511,
          longitude: 105.804817,
          expected_version: 0,
          idempotency_key: IDEMPOTENCY_KEY,
        },
        { origin: badOrigin },
      ),
      {
        resolveSession: async () => {
          sessionCalled = true;
          return makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE);
        },
        repository: unusedRepo,
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, code: "CSRF_REJECTED" });
    assert.equal(sessionCalled, false);
  }

  // 2. Non-JSON Content-Type -> 400 CONTENT_TYPE_INVALID; query string -> 400; authority header -> 400
  {
    const badCt = await putAttendanceHqLocation(
      makePutRequest("lat=1", { contentType: "text/plain" }),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(badCt.status, 400);
    assert.deepEqual(await badCt.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

    const withQuery = await putAttendanceHqLocation(
      makePutRequest(
        { latitude: 21, longitude: 105, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
        { url: "https://bi.example.com/api/admin/attendance/hq-location?override=1" },
      ),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(withQuery.status, 400);
    assert.deepEqual(await withQuery.json(), { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" });

    const withAuthHeader = await putAttendanceHqLocation(
      makePutRequest(
        { latitude: 21, longitude: 105, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
        { extraHeaders: { "x-app-user-id": APP_USER_ID } },
      ),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(withAuthHeader.status, 400);
    assert.deepEqual(await withAuthHeader.json(), { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" });
  }

  // 3. BoD (both forms), Accounting, Team Leader, Project Admin, and Staff are denied on PUT (403 ATTENDANCE_HQ_MANAGE_DENIED)
  for (const [label, caps, scopes] of [
    ["BoD privileged", BOD_PRIVILEGED_CAPS, ALL_SCOPE],
    ["BoD executive reports", BOD_WORK_REPORTS_CAPS, ALL_SCOPE],
    ["Accounting", ACCOUNTING_CAPS, ALL_SCOPE],
    ["Team Leader", TEAM_LEADER_CAPS, TEAM_SCOPE],
    ["Project Admin", ["entry_admin"], ALL_SCOPE],
    ["Staff", ["entry_own"], OWN_SCOPE],
  ]) {
    const response = await putAttendanceHqLocation(
      makePutRequest({
        latitude: 21.028511,
        longitude: 105.804817,
        expected_version: 0,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      {
        resolveSession: async () => makeSessionOk(caps, scopes),
        repository: unusedRepo,
      },
    );
    assert.equal(response.status, 403, label);
    assert.deepEqual(
      await response.json(),
      { ok: false, code: "ATTENDANCE_HQ_MANAGE_DENIED" },
      label,
    );
  }

  // 4. Body size limits (both declared Content-Length > 8192 and streamed > 8192 without Content-Length) -> 413 BODY_TOO_LARGE
  {
    const declaredTooLarge = await putAttendanceHqLocation(
      makePutRequest("{}", { extraHeaders: { "content-length": "9000" } }),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(declaredTooLarge.status, 413);
    assert.deepEqual(await declaredTooLarge.json(), { ok: false, code: "BODY_TOO_LARGE" });

    const hugeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"pad":"${"x".repeat(8300)}"}`));
        controller.close();
      },
    });
    const streamedRequest = new Request("https://bi.example.com/api/admin/attendance/hq-location", {
      method: "PUT",
      headers: {
        host: "bi.example.com",
        origin: "https://bi.example.com",
        "content-type": "application/json",
      },
      body: hugeStream,
      duplex: "half",
    });
    const streamedTooLarge = await putAttendanceHqLocation(streamedRequest, {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: unusedRepo,
    });
    assert.equal(streamedTooLarge.status, 413);
    assert.deepEqual(await streamedTooLarge.json(), { ok: false, code: "BODY_TOO_LARGE" });
  }

  // 5. Coordinate & idempotency validation
  {
    for (const invalidBody of [
      { latitude: 90.0001, longitude: 105.8, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: -90.0001, longitude: 105.8, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: 21.0, longitude: 180.0001, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: 21.0, longitude: -180.0001, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: "21.0", longitude: 105.8, expected_version: 0, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: 21.0, longitude: 105.8, expected_version: -1, idempotency_key: IDEMPOTENCY_KEY },
      { latitude: 21.0, longitude: 105.8, expected_version: 1.5, idempotency_key: IDEMPOTENCY_KEY },
      {
        latitude: 21.0,
        longitude: 105.8,
        expected_version: 0,
        idempotency_key: IDEMPOTENCY_KEY,
        app_user_id: APP_USER_ID,
      },
    ]) {
      const res = await putAttendanceHqLocation(makePutRequest(invalidBody), {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: unusedRepo,
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" });
    }

    const mismatchKey = await putAttendanceHqLocation(
      makePutRequest(
        {
          latitude: 21.028511,
          longitude: 105.804817,
          expected_version: 0,
          idempotency_key: IDEMPOTENCY_KEY,
        },
        { extraHeaders: { "idempotency-key": OTHER_IDEMPOTENCY_KEY } },
      ),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(mismatchKey.status, 400);
    assert.deepEqual(await mismatchKey.json(), { ok: false, code: "IDEMPOTENCY_KEY_INVALID" });

    const missingKey = await putAttendanceHqLocation(
      makePutRequest({ latitude: 21.028511, longitude: 105.804817, expected_version: 0 }),
      { resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE), repository: unusedRepo },
    );
    assert.equal(missingKey.status, 400);
    assert.deepEqual(await missingKey.json(), { ok: false, code: "IDEMPOTENCY_KEY_INVALID" });
  }

  // 6. Full Admin happy path (201 fresh, 200 replay, 409 OCC conflict, 409 idempotency conflict)
  {
    const rpcCalls = [];
    const createRepo = (handler) => createServiceAttendanceAdminReportRepository(handler);

    const createdRes = await putAttendanceHqLocation(
      makePutRequest(
        { latitude: -0, longitude: 105.804817, expected_version: 0 },
        { extraHeaders: { "Idempotency-Key": IDEMPOTENCY_KEY.toUpperCase() } },
      ),
      {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: createRepo(async (name, args) => {
          rpcCalls.push({ name, args });
          return {
            data: buildValidSetHqRpcPayload({
              replayed: false,
              hq: {
                ...buildValidSetHqRpcPayload().hq,
                latitude: 0,
              },
            }),
            error: null,
          };
        }),
      },
    );
    assert.equal(createdRes.status, 201);
    assert.equal(createdRes.headers.get("cache-control"), "private, no-store");
    const createdBody = await createdRes.json();
    assert.equal(createdBody.ok, true);
    assert.equal(createdBody.replayed, false);
    assert.equal(Object.is(createdBody.hq.latitude, 0), true);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0], {
      name: "attendance_set_hq_location",
      args: {
        p_auth_subject: AUTH_SUBJECT,
        p_app_user_id: APP_USER_ID,
        p_latitude: 0,
        p_longitude: 105.804817,
        p_expected_version: 0,
        p_idempotency_key: IDEMPOTENCY_KEY,
        p_request_fingerprint: computeHqLocationRequestFingerprint({
          app_user_id: APP_USER_ID,
          expected_version: 0,
          latitude: 0,
          longitude: 105.804817,
        }),
      },
    });

    const replayedRes = await putAttendanceHqLocation(
      makePutRequest({
        latitude: 21.028511,
        longitude: 105.804817,
        expected_version: 0,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: createRepo(async () => ({
          data: buildValidSetHqRpcPayload({ replayed: true }),
          error: null,
        })),
      },
    );
    assert.equal(replayedRes.status, 200);
    assert.equal((await replayedRes.json()).replayed, true);

    for (const sqlstate of ["40001", "PT409"]) {
      const occConflictRes = await putAttendanceHqLocation(
        makePutRequest({
          latitude: 21.028511,
          longitude: 105.804817,
          expected_version: 0,
          idempotency_key: IDEMPOTENCY_KEY,
        }),
        {
          resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
          repository: createRepo(async () => ({
            data: null,
            error: { code: sqlstate, message: "ATTENDANCE_HQ_VERSION_CONFLICT" },
          })),
        },
      );
      assert.equal(occConflictRes.status, 409);
      assert.deepEqual(await occConflictRes.json(), {
        ok: false,
        code: "ATTENDANCE_HQ_VERSION_CONFLICT",
      });
    }

    const idemConflictRes = await putAttendanceHqLocation(
      makePutRequest({
        latitude: 21.028511,
        longitude: 105.804817,
        expected_version: 0,
        idempotency_key: IDEMPOTENCY_KEY,
      }),
      {
        resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
        repository: createRepo(async () => ({
          data: null,
          error: { code: "23505", message: "IDEMPOTENCY_CONFLICT" },
        })),
      },
    );
    assert.equal(idemConflictRes.status, 409);
    assert.deepEqual(await idemConflictRes.json(), {
      ok: false,
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
});

test("Strict projection & repository error mapping fail closed on leaked fields or inconsistent distance envelopes", async () => {
  for (const code of ATTENDANCE_REPORT_ERROR_CODES) {
    assert.ok(Number.isSafeInteger(attendanceReportHttpStatusForError(code)), code);
  }

  // Extra internal key on report root or item must be rejected
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      internal_debug: true,
    }),
    null,
  );
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      items: [
        {
          ...buildValidReportRpcPayload().items[0],
          photo_storage_key: "preview/attendance/2026-10-23/secret.jpg",
        },
      ],
    }),
    null,
  );

  // HQ_NOT_CONFIGURED / INVALID_GPS with non-null distance_meters or hq_version_used must fail closed
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      items: [
        {
          ...buildValidReportRpcPayload().items[0],
          distance_status: "HQ_NOT_CONFIGURED",
          distance_meters: 10,
          hq_version_used: null,
        },
      ],
    }),
    null,
  );
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      items: [
        {
          ...buildValidReportRpcPayload().items[0],
          distance_status: "COMPUTED",
          distance_meters: null,
          hq_version_used: 1,
        },
      ],
    }),
    null,
  );
  assert.equal(
    projectSetHqLocationResult({
      ...buildValidSetHqRpcPayload(),
      configured_by_user_id: APP_USER_ID,
    }),
    null,
  );

  // Employee options & filter conflict projector guards
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      employee_options: [
        {
          app_user_id: APP_USER_ID,
          display_name: "Nguyễn Văn A",
          personnel_code: "NV001",
          auth_subject: AUTH_SUBJECT,
        },
      ],
    }),
    null,
  );
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      employee_options: [
        { app_user_id: APP_USER_ID, display_name: "Nguyễn Văn A", personnel_code: "NV001" },
        { app_user_id: APP_USER_ID.toUpperCase(), display_name: "Nguyễn Văn A", personnel_code: null },
      ],
    }),
    null,
  );
  assert.equal(
    projectAttendanceAdminReport({
      ...buildValidReportRpcPayload(),
      filters: {
        ...buildValidReportRpcPayload().filters,
        search: "NV001",
        employee_id: APP_USER_ID,
      },
    }),
    null,
  );

  const conflictRepo = createServiceAttendanceAdminReportRepository(async () => ({
    data: null,
    error: { code: "22023", message: "ATTENDANCE_REPORT_FILTER_CONFLICT" },
  }));
  assert.deepEqual(
    await conflictRepo.getAdminReport({
      auth_subject: AUTH_SUBJECT,
      app_user_id: APP_USER_ID,
      from_date: "2026-10-23",
      to_date: "2026-10-23",
      page: 1,
      page_size: 25,
      search: "NV001",
      employee_id: APP_USER_ID,
    }),
    { ok: false, code: "ATTENDANCE_REPORT_FILTER_CONFLICT" },
  );

  // Repository never leaks raw Postgres error text
  const repo = createServiceAttendanceAdminReportRepository(async () => ({
    data: null,
    error: { code: "XX000", message: "internal relation attendance_hq_location_revisions detail" },
  }));
  const failed = await repo.getAdminReport({
    auth_subject: AUTH_SUBJECT,
    app_user_id: APP_USER_ID,
    from_date: "2026-10-23",
    to_date: "2026-10-23",
    page: 1,
    page_size: 25,
    search: null,
  });
  assert.deepEqual(failed, { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" });
});

test("Attendance photo endpoint resolves a private R2 key only for Admin/BoD and never exposes it", async () => {
  const storageKey = `preview/attendance-checkins/${APP_USER_ID}/${IDEMPOTENCY_KEY}/${CHECKIN_ID}.jpg`;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const rpcCalls = [];
  const reads = [];
  const repository = createServiceAttendanceAdminReportRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: { found: true, photo_storage_key: storageKey }, error: null };
  });
  const storage = {
    available: () => true,
    async readCheckInPhoto(key) {
      reads.push(key);
      return bytes;
    },
  };

  const response = await getAttendanceCheckInPhoto(
    new Request(`https://bi.example.com/api/admin/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID.toUpperCase(),
    {
      resolveSession: async () => makeSessionOk(BOD_WORK_REPORTS_CAPS, ALL_SCOPE),
      repository,
      storage,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(reads, [storageKey]);
  assert.deepEqual(rpcCalls, [{
    name: "attendance_admin_checkin_photo",
    args: {
      p_auth_subject: AUTH_SUBJECT,
      p_app_user_id: APP_USER_ID,
      p_checkin_id: CHECKIN_ID,
    },
  }]);
  assert.equal(response.headers.get("photo-storage-key"), null);

  // Team Leader can fetch photo for own team's check-in, and receives 403 when DB denies cross-team check-in
  const tlResponse = await getAttendanceCheckInPhoto(
    new Request(`https://bi.example.com/api/admin/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE),
      repository,
      storage,
    },
  );
  assert.equal(tlResponse.status, 200);

  const tlCrossTeamDenied = await getAttendanceCheckInPhoto(
    new Request(`https://bi.example.com/api/admin/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE),
      repository: createServiceAttendanceAdminReportRepository(async () => ({
        data: null,
        error: { code: "42501", message: "ATTENDANCE_REPORT_ACCESS_DENIED" },
      })),
      storage,
    },
  );
  assert.equal(tlCrossTeamDenied.status, 403);
  assert.deepEqual(await tlCrossTeamDenied.json(), {
    ok: false,
    code: "ATTENDANCE_REPORT_ACCESS_DENIED",
  });

  let deniedRepoCalled = false;
  const denied = await getAttendanceCheckInPhoto(
    new Request(`https://bi.example.com/api/admin/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(["team_manager_assign"], TEAM_SCOPE),
      repository: {
        async getCheckInPhotoStorageKey() {
          deniedRepoCalled = true;
          return { ok: true, storage_key: storageKey };
        },
      },
      storage,
    },
  );
  assert.equal(denied.status, 403);
  assert.equal(deniedRepoCalled, false);

  const notFound = await getAttendanceCheckInPhoto(
    new Request(`https://bi.example.com/api/admin/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: { async getCheckInPhotoStorageKey() { return { ok: true, storage_key: null }; } },
      storage,
    },
  );
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { ok: false, code: "ATTENDANCE_PHOTO_NOT_FOUND" });

  const malformed = await createServiceAttendanceAdminReportRepository(async () => ({
    data: { found: true, photo_storage_key: "../not-an-r2-key" },
    error: null,
  })).getCheckInPhotoStorageKey({
    auth_subject: AUTH_SUBJECT,
    app_user_id: APP_USER_ID,
    checkin_id: CHECKIN_ID,
  });
  assert.deepEqual(malformed, { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" });
});

test("Employee attendance history uses only the verified actor and rejects caller-selected employees", async () => {
  const rpcCalls = [];
  const repository = createServiceAttendanceSelfHistoryRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    return {
      data: {
        items: [{
          checkin_id: CHECKIN_ID,
          employee_display_name: "Test Actor",
          business_date: "2026-10-23",
          sequence_in_day: 1,
          captured_at: "2026-10-23T01:05:00.000Z",
          received_at: "2026-10-23T01:05:02.000Z",
          time_source: "SERVER_ANCHORED",
          latitude: 21.02851,
          longitude: 105.85417,
          accuracy_meters: 8.5,
          address_hint: "Hoàn Kiếm, Hà Nội",
          note: "Ca sáng",
        }],
        pagination: { page: 1, page_size: 100, total_rows: 1, total_pages: 1, has_more: false },
      },
      error: null,
    };
  });
  const response = await getAttendanceSelfHistory(
    new Request("https://bi.example.com/api/attendance/history?from_date=2026-10-01&to_date=2026-10-23&page=1&page_size=100"),
    { resolveSession: async () => makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE), repository },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.report.items.length, 1);
  assert.equal(body.report.items[0].checkin_id, CHECKIN_ID);
  assert.deepEqual(rpcCalls, [{
    name: "attendance_self_history",
    args: {
      p_auth_subject: AUTH_SUBJECT,
      p_app_user_id: APP_USER_ID,
      p_from_date: "2026-10-01",
      p_to_date: "2026-10-23",
      p_page: 1,
      p_page_size: 100,
    },
  }]);

  let sessionCalls = 0;
  const tampered = await getAttendanceSelfHistory(
    new Request(`https://bi.example.com/api/attendance/history?employee_id=${OTHER_IDEMPOTENCY_KEY}`),
    {
      resolveSession: async () => { sessionCalls += 1; return makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE); },
      repository,
    },
  );
  assert.equal(tampered.status, 400);
  assert.equal(sessionCalls, 0);
  assert.equal(rpcCalls.length, 1);

  assert.deepEqual(
    parseAttendanceSelfHistoryQuery(new URLSearchParams("employee_id=someone-else")),
    { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" },
  );
});

test("Employee attendance photo endpoint resolves only the signed-in actor's private key", async () => {
  const storageKey = `preview/attendance-checkins/${APP_USER_ID}/${IDEMPOTENCY_KEY}/${CHECKIN_ID}.jpg`;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const rpcCalls = [];
  const reads = [];
  const repository = createServiceAttendanceSelfHistoryRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: { found: true, photo_storage_key: storageKey }, error: null };
  });
  const storage = {
    available: () => true,
    async readCheckInPhoto(key) { reads.push(key); return bytes; },
  };

  const response = await getAttendanceSelfCheckInPhoto(
    new Request(`https://bi.example.com/api/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE),
      repository,
      storage,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(reads, [storageKey]);
  assert.deepEqual(rpcCalls, [{
    name: "attendance_self_checkin_photo",
    args: { p_auth_subject: AUTH_SUBJECT, p_app_user_id: APP_USER_ID, p_checkin_id: CHECKIN_ID },
  }]);

  const hiddenOtherCheckin = await getAttendanceSelfCheckInPhoto(
    new Request(`https://bi.example.com/api/attendance/checkins/${CHECKIN_ID}/photo`),
    CHECKIN_ID,
    {
      resolveSession: async () => makeSessionOk(TEAM_LEADER_CAPS, TEAM_SCOPE),
      repository: createServiceAttendanceSelfHistoryRepository(async () => ({ data: { found: false }, error: null })),
      storage,
    },
  );
  assert.equal(hiddenOtherCheckin.status, 404);
  assert.deepEqual(await hiddenOtherCheckin.json(), { ok: false, code: "ATTENDANCE_PHOTO_NOT_FOUND" });
});

test("Contract date, coordinate, and distance formatting helpers respect Asia/Ho_Chi_Minh business calendar", () => {
  assert.equal(isValidIsoCalendarDate("2026-10-23"), true);
  assert.equal(isValidIsoCalendarDate("2026-02-29"), false);
  assert.equal(isValidIsoCalendarDate("2024-02-29"), true);
  assert.equal(getVietnamTodayIsoDate(new Date("2026-10-22T17:30:00.000Z")), "2026-10-23");
  assert.equal(getVietnamTodayIsoDate(new Date("2026-10-22T16:59:59.000Z")), "2026-10-22");
  assert.equal(shiftIsoDateDays("2026-10-23", -6), "2026-10-17");
  assert.equal(firstDayOfIsoMonth("2026-10-23"), "2026-10-01");
  assert.equal(formatDistanceMeters(0), "0 m");
  assert.equal(formatDistanceMeters(null), "Không tính được");
  assert.match(formatDistanceMeters(1500), /km/);
  assert.equal(formatCoordinatePair(21.028511, 105.804817), "21.028511, 105.804817");
  assert.equal(formatCoordinatePair(null, 105.8), "Tọa độ GPS thiếu hoặc không hợp lệ");
  assert.deepEqual(
    parseSetHqLocationBody({
      latitude: -0,
      longitude: 105.804817,
      expected_version: 0,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    {
      ok: true,
      value: {
        latitude: 0,
        longitude: 105.804817,
        expected_version: 0,
        idempotency_key: IDEMPOTENCY_KEY,
      },
    },
  );
});
