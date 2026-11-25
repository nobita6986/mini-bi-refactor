import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleExportMonthlyLeaveReport,
  handleGetApprovalInbox,
  handleGetLeaveAdminConfig,
  handleGetMonthlyLeaveReport,
  handleGetMyLeaveSummary,
  handlePatchLeaveAdminConfig,
  handlePostApplyOpeningBalances,
  handlePostCreateLeaveRequest,
  handlePostDecideLeaveRequest,
  handlePostPreviewOpeningBalances,
  handlePostWithdrawLeaveRequest,
} from "./leave-api.ts";
import {
  leaveHttpStatusForError,
  parseApplyOpeningBatchBody,
  parseCreateLeaveRequestBody,
  parseDecideLeaveRequestBody,
  parseGetAdminOverviewQuery,
  parseMonthlyReportQuery,
  parseMyLeaveSummaryQuery,
  parsePatchAdminConfigBody,
} from "./leave-contract.ts";
import { createLeaveRepository, mapLeaveRpcError } from "./leave-repository.ts";

const ACTOR_AUTH = "00000000-0000-4000-8000-000000000101";
const ACTOR_APP = "00000000-0000-4000-8000-000000000201";
const TARGET_APP = "00000000-0000-4000-8000-000000000202";
const REQ_ID = "00000000-0000-4000-8000-000000000301";

function mockActiveSession() {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH,
        app_user_id: ACTOR_APP,
        enabled: true,
        capabilities: [],
        scopes: [],
      },
    },
  });
}

function createNoopRepo(overrides = {}) {
  return {
    async getMySummary() {
      return { ok: true, data: { leave_year: 2026 } };
    },
    async createRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID } } };
    },
    async withdrawRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID, status: "WITHDRAWN" } } };
    },
    async listApprovalInbox() {
      return { ok: true, data: { total: 0, items: [] } };
    },
    async decideRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID, status: "APPROVED" } } };
    },
    async getAdminOverview() {
      return { ok: true, data: { total_employees: 0, employees: [] } };
    },
    async patchAdminConfig() {
      return { ok: true, data: { replayed: false } };
    },
    async previewOpeningBatch() {
      return { ok: true, data: { valid: true, rows: [] } };
    },
    async applyOpeningBatch() {
      return { ok: true, data: { replayed: false, batch: { batch_id: REQ_ID } } };
    },
    async getMonthlyReport() {
      return {
        ok: true,
        data: {
          year_month: "2026-03",
          leave_year: 2026,
          month: 3,
          total: 1,
          rows: [
            {
              app_user_id: ACTOR_APP,
              account: {
                personnel_code: "NV001",
                display_name: "Nguyễn Văn A",
                login_id: "nguyenvana",
              },
              routing: {
                team_name: "Team Alpha",
              },
              employment_status: "OFFICIAL",
              unit_kind: "RECRUITMENT",
              work_start_date: "2025-01-10",
              official_effective_date: "2025-03-10",
              attendance_day_count: 2,
              attendance_dates: ["2026-03-02", "2026-03-03"],
              leave_days: [
                {
                  leave_date: "2026-03-10",
                  session_code: "FULL",
                  leave_type: "ANNUAL",
                  half_day_units: 2,
                },
                {
                  leave_date: "2026-03-11",
                  session_code: "AM",
                  leave_type: "ANNUAL",
                  half_day_units: 1,
                },
                {
                  leave_date: "2026-03-11",
                  session_code: "PM",
                  leave_type: "SICK",
                  half_day_units: 1,
                },
                {
                  leave_date: "2026-03-15",
                  session_code: "FULL",
                  leave_type: "MARRIAGE",
                  half_day_units: 2,
                },
              ],
              month_annual_leave_units: 3,
              month_bereavement_leave_units: 0,
              month_marriage_leave_units: 2,
              month_sick_leave_units: 1,
              month_unpaid_leave_units: 0,
              month_pending_units: 1,
              balance: {
                carry_over_granted_units: 2,
                monthly_accrued_units: 6,
                seniority_granted_units: 0,
                consumed_units: 3,
                reserved_units: 2,
                expired_units: 0,
                available_units: 3,
              },
            },
          ],
        },
      };
    },
    ...overrides,
  };
}

test("leave-contract parsers validate inputs and build deterministic fingerprints", () => {
  const summaryQuery = parseMyLeaveSummaryQuery(
    new URL("https://bi.example.com/api/leave/me?year=2026"),
  );
  assert.deepEqual(summaryQuery, { ok: true, leave_year: 2026 });

  const badSummaryQuery = parseMyLeaveSummaryQuery(
    new URL("https://bi.example.com/api/leave/me?actor=123"),
  );
  assert.deepEqual(badSummaryQuery, { ok: false, code: "INVALID_QUERY" });

  assert.deepEqual(
    parseGetAdminOverviewQuery(new URL("https://bi.example.com/api/leave/admin/config")),
    { ok: true, search: null, limit: 100, offset: 0, account_status: "ACTIVE" },
  );
  assert.deepEqual(
    parseGetAdminOverviewQuery(
      new URL("https://bi.example.com/api/leave/admin/config?account_status=INACTIVE&limit=25"),
    ),
    { ok: true, search: null, limit: 25, offset: 0, account_status: "INACTIVE" },
  );
  assert.deepEqual(
    parseGetAdminOverviewQuery(
      new URL("https://bi.example.com/api/leave/admin/config?account_status=invalid"),
    ),
    { ok: false, code: "INVALID_QUERY" },
  );

  const createParsed1 = parseCreateLeaveRequestBody({
    idempotency_key: "idem-001",
    days: [
      { leave_date: "2026-03-21", session_code: "am" },
      { leave_date: "2026-03-20", session_code: "FULL" },
    ],
  });
  const createParsed2 = parseCreateLeaveRequestBody({
    idempotency_key: "idem-002",
    days: [
      { leave_date: "2026-03-20", session_code: "FULL" },
      { leave_date: "2026-03-21", session_code: "AM" },
    ],
  });
  assert.equal(createParsed1.ok, true);
  assert.equal(createParsed2.ok, true);
  assert.equal(createParsed1.data.reason, null);
  assert.equal(
    createParsed1.data.request_fingerprint,
    createParsed2.data.request_fingerprint,
    "Sorting days produces deterministic fingerprint regardless of input order",
  );

  const dupDate = parseCreateLeaveRequestBody({
    idempotency_key: "idem-dup",
    reason: "Nghỉ phép",
    days: [
      { leave_date: "2026-03-20", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-03-20", session_code: "PM", leave_type: "ANNUAL" },
    ],
  });
  assert.deepEqual(dupDate, {
    ok: false,
    code: "LEAVE_REQUEST_DUPLICATE_DATE",
  });

  // Same date split across AM + PM with DIFFERENT leave types is allowed
  const splitSameDate = parseCreateLeaveRequestBody({
    idempotency_key: "idem-split-date",
    days: [
      { leave_date: "2026-03-20", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-03-20", session_code: "PM", leave_type: "UNPAID" },
    ],
  });
  assert.equal(splitSameDate.ok, true);
  assert.deepEqual(splitSameDate.data.days, [
    { leave_date: "2026-03-20", session_code: "AM", leave_type: "ANNUAL" },
    { leave_date: "2026-03-20", session_code: "PM", leave_type: "UNPAID" },
  ]);

  // Multi-type allocation via type_allocations (e.g. 4 days requested: 3 days ANNUAL + 1 day UNPAID)
  const allocated4Days = parseCreateLeaveRequestBody({
    idempotency_key: "idem-alloc-4d",
    days: [
      { leave_date: "2026-03-23", session_code: "FULL" },
      { leave_date: "2026-03-24", session_code: "FULL" },
      { leave_date: "2026-03-25", session_code: "FULL" },
      { leave_date: "2026-03-26", session_code: "FULL" },
    ],
    type_allocations: [
      { leave_type: "ANNUAL", half_day_units: 6 },
      { leave_type: "UNPAID", half_day_units: 2 },
    ],
  });
  assert.equal(allocated4Days.ok, true);
  assert.deepEqual(
    allocated4Days.data.days.map((d) => d.leave_type),
    ["ANNUAL", "ANNUAL", "ANNUAL", "UNPAID"],
  );

  // Mismatched type_allocations sum is rejected with LEAVE_TYPE_ALLOCATION_MISMATCH
  const badAllocationSum = parseCreateLeaveRequestBody({
    idempotency_key: "idem-alloc-bad",
    days: [
      { leave_date: "2026-03-23", session_code: "FULL" },
      { leave_date: "2026-03-24", session_code: "FULL" },
    ],
    type_allocations: [
      { leave_type: "ANNUAL", half_day_units: 2 },
      { leave_type: "UNPAID", half_day_units: 1 },
    ],
  });
  assert.deepEqual(badAllocationSum, {
    ok: false,
    code: "LEAVE_TYPE_ALLOCATION_MISMATCH",
  });

  // Per-request leave type limits: BEREAVEMENT/MARRIAGE max 3 days (6 units), SICK/UNPAID max 7 days (14 units)
  const overMarriage = parseCreateLeaveRequestBody({
    idempotency_key: "idem-over-marriage",
    days: [
      { leave_date: "2026-03-23", session_code: "FULL", leave_type: "MARRIAGE" },
      { leave_date: "2026-03-24", session_code: "FULL", leave_type: "MARRIAGE" },
      { leave_date: "2026-03-25", session_code: "FULL", leave_type: "MARRIAGE" },
      { leave_date: "2026-03-26", session_code: "AM", leave_type: "MARRIAGE" },
    ],
  });
  assert.deepEqual(overMarriage, {
    ok: false,
    code: "LEAVE_TYPE_LIMIT_EXCEEDED",
  });

  const overSick = parseCreateLeaveRequestBody({
    idempotency_key: "idem-over-sick",
    days: [
      { leave_date: "2026-03-01", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-02", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-03", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-04", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-05", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-06", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-07", session_code: "FULL", leave_type: "SICK" },
      { leave_date: "2026-03-08", session_code: "AM", leave_type: "SICK" },
    ],
  });
  assert.deepEqual(overSick, {
    ok: false,
    code: "LEAVE_TYPE_LIMIT_EXCEEDED",
  });

  const badType = parseCreateLeaveRequestBody({
    idempotency_key: "idem-bad-type",
    days: [{ leave_date: "2026-03-23", session_code: "FULL", leave_type: "MATERNITY" }],
  });
  assert.deepEqual(badType, {
    ok: false,
    code: "LEAVE_TYPE_INVALID",
  });

  const rejectWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-1",
    decision: "REJECT",
    expected_row_version: 1,
    reason: "   ",
  });
  assert.equal(rejectWithoutReason.ok, true);
  assert.equal(rejectWithoutReason.data.reason, null);

  const cancelWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-2",
    decision: "CANCEL_APPROVED",
    expected_row_version: 2,
  });
  assert.equal(cancelWithoutReason.ok, true);
  assert.equal(cancelWithoutReason.data.reason, null);

  const approveWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-3",
    decision: "APPROVE",
    expected_row_version: 1,
  });
  assert.equal(approveWithoutReason.ok, true);

  const patchPolicy = parsePatchAdminConfigBody({
    operation: "UPDATE_POLICY",
    carry_over_expiry_month: 3,
    carry_over_expiry_day: 31,
    expected_row_version: 1,
    idempotency_key: "idem-pol-1",
  });
  assert.equal(patchPolicy.ok, true);
  assert.equal(patchPolicy.data.reason, null);

  // PR #28 D4 / T0-R2 / UX-03: MANAGE_MODULE_GRANT is retired; Leave module roles are managed exclusively via Permission Groups.
  const patchGrant = parsePatchAdminConfigBody({
    operation: "MANAGE_MODULE_GRANT",
    action: "GRANT",
    target_app_user_id: TARGET_APP,
    role_code: "HR_REPORT_VIEWER",
    expected_row_version: 0,
    idempotency_key: "idem-grant-1",
  });
  assert.equal(patchGrant.ok, false);

  // WP10-3: UPSERT_EMPLOYEE_PROFILE omits unit_kind from canonical payload & fingerprint;
  // legacy non-blank unit_kind is validated but cannot override Org department.
  const profileWithoutUnit = parsePatchAdminConfigBody({
    operation: "UPSERT_EMPLOYEE_PROFILE",
    target_app_user_id: TARGET_APP,
    employment_status: "UNCONFIGURED",
    work_start_date: null,
    official_effective_date: null,
    next_seniority_effective_date: null,
    next_seniority_units: 0,
    expected_row_version: 0,
    idempotency_key: "idem-prof-unconf",
  });
  assert.equal(profileWithoutUnit.ok, true);
  assert.equal("unit_kind" in profileWithoutUnit.data, false);
  assert.equal(profileWithoutUnit.data.employment_status, "UNCONFIGURED");

  const profileWithLegacyUnit = parsePatchAdminConfigBody({
    operation: "UPSERT_EMPLOYEE_PROFILE",
    target_app_user_id: TARGET_APP,
    employment_status: "UNCONFIGURED",
    unit_kind: "  marketing ",
    work_start_date: null,
    official_effective_date: null,
    next_seniority_effective_date: null,
    next_seniority_units: 0,
    expected_row_version: 0,
    idempotency_key: "idem-prof-legacy",
  });
  assert.equal(profileWithLegacyUnit.ok, true);
  assert.equal("unit_kind" in profileWithLegacyUnit.data, false);
  assert.equal(
    profileWithLegacyUnit.data.request_fingerprint,
    profileWithoutUnit.data.request_fingerprint,
  );

  const profileWithBlankUnit = parsePatchAdminConfigBody({
    operation: "UPSERT_EMPLOYEE_PROFILE",
    target_app_user_id: TARGET_APP,
    employment_status: "UNCONFIGURED",
    unit_kind: "   ",
    work_start_date: null,
    official_effective_date: null,
    next_seniority_effective_date: null,
    next_seniority_units: 0,
    expected_row_version: 0,
    idempotency_key: "idem-prof-blank",
  });
  assert.equal(profileWithBlankUnit.ok, true);
  assert.equal(
    profileWithBlankUnit.data.request_fingerprint,
    profileWithoutUnit.data.request_fingerprint,
  );

  for (const invalidUnit of ["OPERATIONS", "BOGUS", 123, {}]) {
    const badProfileUnit = parsePatchAdminConfigBody({
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: TARGET_APP,
      employment_status: "OFFICIAL",
      unit_kind: invalidUnit,
      work_start_date: "2026-01-01",
      official_effective_date: "2026-03-01",
      next_seniority_effective_date: null,
      next_seniority_units: 0,
      expected_row_version: 1,
      idempotency_key: "idem-prof-bad",
    });
    assert.deepEqual(badProfileUnit, {
      ok: false,
      code: "LEAVE_PROFILE_INVALID",
    });
  }

  const applyBatch = parseApplyOpeningBatchBody({
    leave_year: 2026,
    idempotency_key: "idem-open-1",
    rows: [
      {
        app_user_id: TARGET_APP,
        carry_over_units: 4,
        opening_current_year_units: 0,
        seniority_units: 2,
        note: "Đầu kỳ",
      },
    ],
  });
  assert.equal(applyBatch.ok, true);
  assert.equal(applyBatch.data.reason, null);

  const reportQuery = parseMonthlyReportQuery(
    new URL("https://bi.example.com/api/leave/reports/monthly?month=2026-03&unit_kind=MARKETING"),
  );
  assert.equal(reportQuery.ok, true);
});

test("leave-api enforces feature gate, rejects disallowed authority headers, and enforces CSRF on mutations", async () => {
  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo(),
  };

  const gated = await handleGetMyLeaveSummary(
    new Request("https://bi.example.com/api/leave/me"),
    "false",
    deps,
  );
  assert.equal(gated.status, 404);

  for (const header of [
    "x-app-user-id",
    "x-actor-id",
    "x-auth-subject",
    "x-capabilities",
    "x-scope",
    "x-approver-id",
  ]) {
    const res = await handleGetMyLeaveSummary(
      new Request("https://bi.example.com/api/leave/me", {
        headers: { [header]: "spoofed" },
      }),
      "true",
      deps,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "DISALLOWED_AUTHORITY_HEADER");
  }

  const crossOriginPost = await handlePostCreateLeaveRequest(
    new Request("https://bi.example.com/api/leave/requests", {
      method: "POST",
      headers: {
        Host: "bi.example.com",
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "idem-1",
        reason: "Nghỉ phép",
        days: [{ leave_date: "2026-03-20", session_code: "FULL" }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(crossOriginPost.status, 403);
  const csrfBody = await crossOriginPost.json();
  assert.equal(csrfBody.code, "CSRF_ORIGIN_MISMATCH");
});

test("leave admin account status filter reaches the overview RPC", async () => {
  let capturedRpc = null;
  const repository = createLeaveRepository(async (fn, args) => {
    capturedRpc = { fn, args };
    return { data: { total_employees: 0, employees: [] }, error: null };
  });

  const result = await repository.getAdminOverview({
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
    search: null,
    limit: 25,
    offset: 0,
    account_status: "INACTIVE",
  });

  assert.equal(result.ok, true);
  assert.equal(capturedRpc.fn, "leave_management_get_admin_overview");
  assert.deepEqual(capturedRpc.args, {
    p_actor_auth_subject: ACTOR_AUTH,
    p_actor_app_user_id: ACTOR_APP,
    p_search: null,
    p_limit: 25,
    p_offset: 0,
    p_account_status: "INACTIVE",
  });
});

test("leave-api passes session-resolved actor to repository and maps status codes accurately", async () => {
  let capturedSummaryInput = null;
  let capturedCreateInput = null;
  const capturedAdminOverviewInputs = [];

  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMySummary(input) {
        capturedSummaryInput = input;
        return { ok: true, data: { leave_year: 2026, available_units: 6 } };
      },
      async createRequest(input) {
        capturedCreateInput = input;
        return {
          ok: true,
          data: { replayed: false, request: { request_id: REQ_ID } },
        };
      },
      async getAdminOverview(input) {
        capturedAdminOverviewInputs.push(input);
        return { ok: true, data: { total_employees: 0, employees: [] } };
      },
    }),
  };

  const summaryRes = await handleGetMyLeaveSummary(
    new Request("https://bi.example.com/api/leave/me?year=2026"),
    "true",
    deps,
  );
  assert.equal(summaryRes.status, 200);
  assert.deepEqual(capturedSummaryInput, {
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
    leave_year: 2026,
  });

  const createRes = await handlePostCreateLeaveRequest(
    new Request("https://bi.example.com/api/leave/requests", {
      method: "POST",
      headers: {
        Host: "bi.example.com",
        Origin: "https://bi.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "idem-create-1",
        reason: "Nghỉ việc riêng",
        days: [{ leave_date: "2026-03-25", session_code: "AM" }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(createRes.status, 201);
  assert.equal(capturedCreateInput.auth_subject, ACTOR_AUTH);
  assert.equal(capturedCreateInput.app_user_id, ACTOR_APP);

  const adminGetRes = await handleGetLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config"),
    "true",
    deps,
  );
  assert.equal(adminGetRes.status, 200);
  const inactiveAdminGetRes = await handleGetLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config?account_status=INACTIVE"),
    "true",
    deps,
  );
  assert.equal(inactiveAdminGetRes.status, 200);
  assert.deepEqual(
    capturedAdminOverviewInputs.map((input) => input.account_status),
    ["ACTIVE", "INACTIVE"],
  );

  assert.equal(
    mapLeaveRpcError({ code: "23505", message: "LEAVE_REQUEST_OVERLAP" }),
    "LEAVE_REQUEST_OVERLAP",
  );
  assert.equal(mapLeaveRpcError({ code: "40001" }), "LEAVE_ROW_VERSION_CONFLICT");
  assert.equal(mapLeaveRpcError({ code: "PT409" }), "LEAVE_ROW_VERSION_CONFLICT");
  assert.equal(leaveHttpStatusForError("LEAVE_REQUEST_OVERLAP"), 409);
  assert.equal(leaveHttpStatusForError("LEAVE_ROW_VERSION_CONFLICT"), 409);
  assert.equal(leaveHttpStatusForError("LEAVE_INSUFFICIENT_BALANCE"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_TYPE_LIMIT_EXCEEDED"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_TYPE_ALLOCATION_MISMATCH"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_TYPE_INVALID"), 400);
  assert.equal(leaveHttpStatusForError("LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_SHARED_ACCOUNT_FORBIDDEN"), 403);
  assert.equal(leaveHttpStatusForError("LEAVE_REPORT_FORBIDDEN"), 403);
});

test("leave-api monthly report and .xlsx export return valid workbook with formatted half-day units", async () => {
  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo(),
  };

  const jsonRes = await handleGetMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly?month=2026-03"),
    "true",
    deps,
  );
  assert.equal(jsonRes.status, 200);
  const jsonPayload = await jsonRes.json();
  assert.equal(jsonPayload.ok, true);
  assert.equal(jsonPayload.data.year_month, "2026-03");

  const exportRes = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    deps,
  );
  assert.equal(exportRes.status, 200);
  assert.equal(
    exportRes.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(
    exportRes.headers.get("content-disposition") ?? "",
    /bao-cao-nghi-phep-thang-2026-03\.xlsx/,
  );

  const arrayBuffer = await exportRes.arrayBuffer();
  assert.ok(arrayBuffer.byteLength > 100);

  const imported = await import("exceljs");
  const workbook = new imported.default.Workbook();
  await workbook.xlsx.load(Buffer.from(arrayBuffer));
  const sheet = workbook.getWorksheet("Nghỉ phép 2026-03");
  assert.ok(sheet, "Worksheet Nghỉ phép 2026-03 exists");
  assert.equal(sheet.getRow(2).getCell(1).value, "NV001");
  assert.equal(sheet.getRow(2).getCell(2).value, "Nguyễn Văn A");
  assert.equal(sheet.getRow(2).getCell(9).value, "2"); // 2 attendance days
  assert.equal(sheet.getRow(2).getCell(10).value, "2026-03-02, 2026-03-03");
  assert.ok(
    String(sheet.getRow(2).getCell(11).value).includes("2026-03-10: Phép năm (Cả ngày)"),
  );
  assert.equal(sheet.getRow(2).getCell(12).value, "1.5"); // 3 half-day units = 1.5 days Phép năm
  assert.equal(sheet.getRow(2).getCell(14).value, "1"); // 2 half-day units = 1 day Nghỉ cưới
  assert.equal(sheet.getRow(2).getCell(15).value, "0.5"); // 1 half-day unit = 0.5 day Nghỉ ốm
  assert.equal(sheet.getRow(2).getCell(17).value, "0.5"); // 1 half-day unit = 0.5 day Đang chờ duyệt

  const detailSheet = workbook.getWorksheet("Chi tiết ngày công & nghỉ");
  assert.ok(detailSheet, "Worksheet Chi tiết ngày công & nghỉ exists");
  assert.equal(detailSheet.getRow(2).getCell(6).value, "2026-03-10");
  assert.equal(detailSheet.getRow(2).getCell(9).value, "Phép năm");
  assert.equal(detailSheet.getRow(2).getCell(10).value, "Cả ngày");

  const sameOriginHeaders = {
    Host: "bi.example.com",
    Origin: "https://bi.example.com",
    "Content-Type": "application/json",
  };

  // Also smoke-check withdraw, approvals inbox, decide, admin overview/patch, opening preview/apply
  const withdrawRes = await handlePostWithdrawLeaveRequest(
    new Request(`https://bi.example.com/api/leave/requests/${REQ_ID}/withdraw`, {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ idempotency_key: "w-1", expected_row_version: 1, reason: "Đổi lịch" }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(withdrawRes.status, 200);

  const inboxRes = await handleGetApprovalInbox(
    new Request("https://bi.example.com/api/leave/approvals?status=PENDING"),
    "true",
    deps,
  );
  assert.equal(inboxRes.status, 200);

  const decideRes = await handlePostDecideLeaveRequest(
    new Request(`https://bi.example.com/api/leave/approvals/${REQ_ID}/decision`, {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ idempotency_key: "d-1", decision: "APPROVE", expected_row_version: 1 }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(decideRes.status, 200);

  const adminGetRes = await handleGetLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config"),
    "true",
    deps,
  );
  assert.equal(adminGetRes.status, 200);

  const adminPatchRes = await handlePatchLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config", {
      method: "PATCH",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        operation: "UPDATE_POLICY",
        carry_over_expiry_month: 3,
        carry_over_expiry_day: 31,
        expected_row_version: 1,
        reason: "Cập nhật hạn phép chuyển năm",
        idempotency_key: "p-1",
      }),
    }),
    "true",
    deps,
  );
  assert.equal(adminPatchRes.status, 200);

  const previewRes = await handlePostPreviewOpeningBalances(
    new Request("https://bi.example.com/api/leave/admin/opening-balances/preview", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        leave_year: 2026,
        rows: [{ app_user_id: TARGET_APP, carry_over_units: 2, opening_current_year_units: 0, seniority_units: 0 }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(previewRes.status, 200);

  const applyRes = await handlePostApplyOpeningBalances(
    new Request("https://bi.example.com/api/leave/admin/opening-balances/apply", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        leave_year: 2026,
        reason: "Áp dụng số dư đầu kỳ",
        idempotency_key: "a-1",
        rows: [{ app_user_id: TARGET_APP, carry_over_units: 2, opening_current_year_units: 0, seniority_units: 0 }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(applyRes.status, 201);
});

test("leave-api monthly report .xlsx export paginates beyond 500 employees and fails closed on incomplete or oversized exports", async () => {
  const makeEmployeeRow = (index) => ({
    app_user_id: `29000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    account: {
      app_user_id: `29000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      display_name: `Nhân sự ${index + 1}`,
      login_id: `nv${index + 1}`,
      personnel_code: `NV${String(index + 1).padStart(4, "0")}`,
    },
    routing: {
      route_kind: "TEAM_LEADER",
      routed_team_code: "TEAM_A",
      routed_team_name: "Team Alpha",
      primary_approver: { display_name: "Trưởng nhóm A" },
    },
    employment_status: "OFFICIAL",
    unit_kind: "RECRUITMENT",
    work_start_date: "2025-01-01",
    official_effective_date: "2025-03-01",
    month_paid_leave_units: 2,
    month_unpaid_probation_units: 0,
    month_unpaid_other_units: 0,
    month_pending_units: 0,
    month_approved_request_count: 1,
    balance: {
      total_granted_units: 6,
      carry_over_granted_units: 0,
      carry_over_available_units: 0,
      monthly_accrued_units: 6,
      seniority_granted_units: 0,
      opening_or_adjustment_units: 0,
      available_units: 4,
      reserved_units: 0,
      consumed_units: 2,
      expired_units: 0,
      pending_paid_units: 0,
      pending_unpaid_units: 0,
      approved_unpaid_units: 0,
    },
  });

  const all620Rows = Array.from({ length: 620 }, (_, idx) => makeEmployeeRow(idx));
  const seenOffsets = [];

  const paginatedDeps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMonthlyReport(input) {
        seenOffsets.push({ limit: input.limit, offset: input.offset });
        const slice = all620Rows.slice(input.offset, input.offset + input.limit);
        return {
          ok: true,
          data: {
            year_month: input.year_month ?? "2026-03",
            leave_year: 2026,
            month: 3,
            as_of_date: "2026-03-31",
            unit_kind_filter: "ALL",
            total: all620Rows.length,
            limit: input.limit,
            offset: input.offset,
            rows: slice,
          },
        };
      },
    }),
  };

  const export620Res = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    paginatedDeps,
  );
  assert.equal(export620Res.status, 200);
  assert.deepEqual(seenOffsets, [
    { limit: 500, offset: 0 },
    { limit: 500, offset: 500 },
  ]);

  const imported = await import("exceljs");
  const workbook = new imported.default.Workbook();
  await workbook.xlsx.load(Buffer.from(await export620Res.arrayBuffer()));
  const sheet = workbook.getWorksheet("Nghỉ phép 2026-03");
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 621, "Header row + 620 employee rows must all be exported");
  assert.equal(sheet.getRow(621).getCell(1).value, "NV0620");

  // Exceeding MAX_LEAVE_REPORT_EXPORT_ROWS (5000) fails closed with 422
  const oversizedDeps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMonthlyReport() {
        return {
          ok: true,
          data: {
            year_month: "2026-03",
            leave_year: 2026,
            month: 3,
            as_of_date: "2026-03-31",
            unit_kind_filter: "ALL",
            total: 5001,
            limit: 500,
            offset: 0,
            rows: [makeEmployeeRow(0)],
          },
        };
      },
    }),
  };
  const oversizedRes = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    oversizedDeps,
  );
  assert.equal(oversizedRes.status, 422);
  const oversizedBody = await oversizedRes.json();
  assert.equal(oversizedBody.code, "LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED");
});

test("Opening balance apply contract preserves expected snapshot metadata, maps LEAVE_OPENING_PREVIEW_STALE to 409, and returns applied_row_count", async () => {
  assert.equal(leaveHttpStatusForError("LEAVE_OPENING_PREVIEW_STALE"), 409);
  assert.equal(
    mapLeaveRpcError({
      code: "40001",
      message: "LEAVE_OPENING_PREVIEW_STALE",
    }),
    "LEAVE_OPENING_PREVIEW_STALE",
  );
  assert.equal(
    mapLeaveRpcError({
      code: "22023",
      message: "OPENING_TARGET_BELOW_LOCKED_BALANCE",
    }),
    "LEAVE_OPENING_BATCH_VALIDATION_FAILED",
  );
  assert.equal(
    mapLeaveRpcError({
      code: "22023",
      message: "SENIORITY_LOT_ALREADY_EXISTS",
    }),
    "LEAVE_OPENING_BATCH_VALIDATION_FAILED",
  );

  const parsedApply = parseApplyOpeningBatchBody({
    leave_year: 2026,
    idempotency_key: "idem-reconcile-1",
    reason: "Đối soát số dư đầu kỳ",
    rows: [
      {
        app_user_id: TARGET_APP,
        carry_over_units: 0,
        opening_current_year_units: 2,
        seniority_units: 0,
        note: "Nghỉ 2 ngày trước khi dùng BI",
        expected_as_of_date: "2026-11-05",
        expected_current_year_granted_units: 6,
        expected_current_year_locked_units: 0,
        expected_profile_row_version: 2,
      },
    ],
  });
  assert.equal(parsedApply.ok, true);
  assert.deepEqual(parsedApply.data.rows[0], {
    app_user_id: TARGET_APP,
    carry_over_units: 0,
    opening_current_year_units: 2,
    seniority_units: 0,
    note: "Nghỉ 2 ngày trước khi dùng BI",
    expected_as_of_date: "2026-11-05",
    expected_current_year_granted_units: 6,
    expected_current_year_locked_units: 0,
    expected_profile_row_version: 2,
  });

  // Invalid expected_as_of_date is rejected by contract parser
  const badExpectedDate = parseApplyOpeningBatchBody({
    leave_year: 2026,
    idempotency_key: "idem-reconcile-bad",
    rows: [
      {
        app_user_id: TARGET_APP,
        carry_over_units: 0,
        opening_current_year_units: 2,
        seniority_units: 0,
        expected_as_of_date: "not-a-date",
      },
    ],
  });
  assert.equal(badExpectedDate.ok, false);
  assert.equal(badExpectedDate.code, "LEAVE_OPENING_ROWS_INVALID");

  // Stale preview error from repository returns 409 LEAVE_OPENING_PREVIEW_STALE
  const staleRes = await handlePostApplyOpeningBalances(
    new Request("https://bi.example.com/api/leave/admin/opening-balances/apply", {
      method: "POST",
      headers: {
        Host: "bi.example.com",
        Origin: "https://bi.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        leave_year: 2026,
        idempotency_key: "idem-stale-1",
        rows: [
          {
            app_user_id: TARGET_APP,
            carry_over_units: 0,
            opening_current_year_units: 2,
            seniority_units: 0,
          },
        ],
      }),
    }),
    "true",
    {
      resolveSession: mockActiveSession(),
      repository: createNoopRepo({
        async applyOpeningBatch() {
          return { ok: false, code: "LEAVE_OPENING_PREVIEW_STALE" };
        },
      }),
    },
  );
  assert.equal(staleRes.status, 409);
  const staleJson = await staleRes.json();
  assert.equal(staleJson.code, "LEAVE_OPENING_PREVIEW_STALE");
});

test("WP7B R7 / PR #28: leave repository getActorAccess calls leave_management_get_actor_access and enforces strict 5-key boolean projection", async () => {
  const capturedCalls = [];
  const validEmployeePayload = {
    can_access: true,
    can_submit_request: true,
    can_approve_requests: false,
    can_manage_config: false,
    can_view_monthly_report: false,
  };
  const restrictedAccountPayload = {
    can_access: false,
    can_submit_request: false,
    can_approve_requests: false,
    can_manage_config: false,
    can_view_monthly_report: false,
  };

  const repoOk = createLeaveRepository(async (fn, args) => {
    capturedCalls.push({ fn, args });
    return { data: validEmployeePayload, error: null };
  });
  const empOutcome = await repoOk.getActorAccess({
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
  });
  assert.deepEqual(empOutcome, { ok: true, data: validEmployeePayload });
  assert.deepEqual(capturedCalls, [
    {
      fn: "leave_management_get_actor_access",
      args: {
        p_actor_auth_subject: ACTOR_AUTH,
        p_actor_app_user_id: ACTOR_APP,
      },
    },
  ]);

  const repoRestricted = createLeaveRepository(async () => ({
    data: restrictedAccountPayload,
    error: null,
  }));
  const restrictedOutcome = await repoRestricted.getActorAccess({
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
  });
  assert.deepEqual(restrictedOutcome, { ok: true, data: restrictedAccountPayload });

  // Strict 5-key boolean projection rejects extra keys, missing keys, non-booleans, arrays, and RPC errors
  for (const malformed of [
    { ...validEmployeePayload, extra_field: true },
    { ...validEmployeePayload, is_shared_non_employee: false },
    { can_access: true },
    { ...validEmployeePayload, can_access: "true" },
    [validEmployeePayload],
    null,
  ]) {
    const repoMalformed = createLeaveRepository(async () => ({
      data: malformed,
      error: null,
    }));
    const outcome = await repoMalformed.getActorAccess({
      auth_subject: ACTOR_AUTH,
      app_user_id: ACTOR_APP,
    });
    assert.deepEqual(outcome, { ok: false, code: "LEAVE_UNAVAILABLE" });
  }

  const repoError = createLeaveRepository(async () => ({
    data: null,
    error: { code: "42501", message: "permission denied" },
  }));
  assert.deepEqual(
    await repoError.getActorAccess({
      auth_subject: ACTOR_AUTH,
      app_user_id: ACTOR_APP,
    }),
    { ok: false, code: "ACTOR_NOT_AVAILABLE" },
  );
});

test("WP10-3: repository patchAdminConfig UPSERT_EMPLOYEE_PROFILE passes p_unit_kind: null in exact 13-arg RPC call and export shows org_department.department_name", async () => {
  let capturedRpc = null;
  const repo = createLeaveRepository(async (fn, args) => {
    capturedRpc = { fn, args };
    return { data: { replayed: false }, error: null };
  });

  const parsed = parsePatchAdminConfigBody({
    operation: "UPSERT_EMPLOYEE_PROFILE",
    target_app_user_id: TARGET_APP,
    employment_status: "PROBATION",
    unit_kind: "IT",
    work_start_date: "2026-10-01",
    official_effective_date: null,
    next_seniority_effective_date: null,
    next_seniority_units: 0,
    expected_row_version: 0,
    reason: "Cập nhật thử việc",
    idempotency_key: "idem-wp10-3-repo",
  });
  assert.equal(parsed.ok, true);

  const outcome = await repo.patchAdminConfig({
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
    ...parsed.data,
  });
  assert.equal(outcome.ok, true);
  assert.equal(capturedRpc.fn, "leave_management_upsert_employee_profile_admin");
  assert.equal(Object.keys(capturedRpc.args).length, 13);
  assert.equal(capturedRpc.args.p_unit_kind, null);

  const { buildLeaveMonthlyReportXlsx } = await import("./leave-export.ts");
  const bytes = await buildLeaveMonthlyReportXlsx({
    year_month: "2026-11",
    rows: [
      {
        account: { personnel_code: "NV10", display_name: "Custom Dept User", login_id: "custom1" },
        org_department: {
          has_active_person_link: true,
          person_status: "ACTIVE",
          department_id: "d-ops",
          department_code: "OPS",
          department_name: "Vận hành",
          department_system_key: null,
        },
        unit_kind: "UNCLASSIFIED",
        employment_status: "OFFICIAL",
        attendance_dates: [],
        leave_days: [],
        balance: {},
      },
      {
        account: { personnel_code: "NV11", display_name: "Legacy Mock User", login_id: "legacy1" },
        unit_kind: "MARKETING",
        employment_status: "OFFICIAL",
        attendance_dates: [],
        leave_days: [],
        balance: {},
      },
    ],
  });
  const imported = await import("exceljs");
  const wb = new imported.default.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  const sheet = wb.getWorksheet("Nghỉ phép 2026-11");
  assert.equal(sheet.getRow(2).getCell(4).value, "Vận hành");
  assert.equal(sheet.getRow(3).getCell(4).value, "MARKETING");
});
