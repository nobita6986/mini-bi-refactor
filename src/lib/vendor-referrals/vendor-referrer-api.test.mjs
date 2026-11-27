import assert from "node:assert/strict";
import test from "node:test";

import { visibleAdminSections } from "../admin/admin-navigation.ts";
import {
  decideVendorCatalogPageAccess,
  decideVendorReferrerReportPageAccess,
  resolveAdminLandingPath,
} from "../auth/direct-entry-page-access.ts";
import {
  adminPanelNavPredicate,
  decideNavEntryVisibility,
  vendorReferrerNavPredicate,
} from "../navigation/registry-capability.ts";
import {
  assignVendorReferrer,
  getVendorReferrerHistory,
  getVendorReferrerMonthlyReport,
  listVendorReferrerCandidates,
  listVendorReferrerVendors,
  revokeVendorReferrer,
} from "./vendor-referrer-api.ts";
import {
  classifyVendorReferrerError,
  projectActorAccess,
  projectAssignMutationResult,
  projectCandidateList,
  projectMonthlyReport,
  projectRevokeMutationResult,
  projectVendorHistory,
  projectVendorList,
} from "./vendor-referrer-contract.ts";

let createVendorReferrerRepository = null;
try {
  ({ createVendorReferrerRepository } = await import("./vendor-referrer-repository.ts"));
} catch {
  // Running without `--conditions=react-server`: `server-only` blocks importing the repository directly.
}

function makeInlineRepo(rpcHandler) {
  async function call(name, args, project) {
    try {
      const { data, error } = await rpcHandler(name, args);
      if (error) return { ok: false, kind: classifyVendorReferrerError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }
  return {
    getActorAccess: (i) =>
      call("direct_entry_vendor_referrer_get_actor_access", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id }, projectActorAccess),
    listCandidates: (i) =>
      call("direct_entry_vendor_referrer_list_candidates", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_search: i.search, p_limit: i.limit }, projectCandidateList),
    listVendors: (i) =>
      call("direct_entry_vendor_referrer_list_vendors", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_search: i.search, p_include_inactive: i.include_inactive, p_page: i.page, p_page_size: i.page_size }, projectVendorList),
    getHistory: (i) =>
      call("direct_entry_vendor_referrer_get_history", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_vendor_id: i.vendor_id }, projectVendorHistory),
    assignReferrer: (i) =>
      call("direct_entry_vendor_referrer_assign", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_vendor_id: i.vendor_id, p_referrer_person_id: i.referrer_person_id, p_effective_date: i.effective_date, p_expected_current_link_id: i.expected_current_link_id, p_reason: i.reason, p_idempotency_key: i.idempotency_key }, projectAssignMutationResult),
    revokeReferrer: (i) =>
      call("direct_entry_vendor_referrer_revoke", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_vendor_id: i.vendor_id, p_effective_date: i.effective_date, p_expected_current_link_id: i.expected_current_link_id, p_reason: i.reason, p_idempotency_key: i.idempotency_key }, projectRevokeMutationResult),
    getMonthlyReport: (i) =>
      call("direct_entry_vendor_referrer_monthly_report", { p_auth_subject: i.auth_subject, p_app_user_id: i.app_user_id, p_month: i.month, p_referrer_person_id: i.referrer_person_id, p_vendor_id: i.vendor_id, p_project_id: i.project_id }, projectMonthlyReport),
  };
}

const AUTH_SUBJECT = "11111111-1111-4111-8111-111111111111";
const APP_USER_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_ID = "33333333-3333-4333-8333-333333333333";
const DEPT_ID = "44444444-4444-4444-8444-444444444444";
const RECRUITER_ID = "55555555-5555-4555-8555-555555555555";
const LINK_ID = "66666666-6666-4666-8666-666666666666";
const PREV_LINK_ID = "66666666-6666-4666-8666-666666666667";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const IDEM_KEY = "88888888-8888-4888-8888-888888888888";
const OTHER_IDEM_KEY = "99999999-9999-4999-8999-999999999999";
const VENDOR_ID = "VENDOR_ALPHA";

const CURRENT_LINK = {
  link_id: LINK_ID,
  referrer_person_id: PERSON_ID,
  referrer_employee_code: "EMP-001",
  referrer_full_name: "Nguyễn Văn A",
  referrer_department_name: "Phòng Tuyển dụng",
  effective_from: "2026-11-01",
  reason: "Gắn người giới thiệu ban đầu",
  created_at: "2026-11-01T08:00:00Z",
};

const CANDIDATE_LIST_FIXTURE = {
  items: [
    {
      person_id: PERSON_ID,
      employee_code: "EMP-001",
      full_name: "Nguyễn Văn A",
      department_id: DEPT_ID,
      department_name: "Phòng Tuyển dụng",
      department_system_key: "RECRUITMENT",
      recruiter_id: RECRUITER_ID,
      recruiter_display_name: "Nguyễn Văn A (HRP)",
      personnel_code: "HRP-TD-001",
    },
  ],
  total: 1,
  authorization_date: "2026-11-27",
};

const VENDOR_LIST_FIXTURE = {
  items: [
    {
      vendor_id: VENDOR_ID,
      display_name: "Công ty Vendor Alpha",
      active: true,
      version: 2,
      current_link: CURRENT_LINK,
      history_count: 1,
    },
  ],
  total: 1,
  page: 1,
  page_size: 25,
  has_more: false,
  authorization_date: "2026-11-27",
};

const HISTORY_FIXTURE = {
  vendor: {
    vendor_id: VENDOR_ID,
    display_name: "Công ty Vendor Alpha",
    active: true,
    version: 2,
    current_link: CURRENT_LINK,
  },
  links: [
    {
      link_id: LINK_ID,
      vendor_id: VENDOR_ID,
      referrer_person_id: PERSON_ID,
      referrer_employee_code: "EMP-001",
      referrer_full_name: "Nguyễn Văn A",
      referrer_department_name: "Phòng Tuyển dụng",
      effective_from: "2026-11-01",
      effective_to: null,
      is_current: true,
      reason: "Gắn người giới thiệu ban đầu",
      created_by_app_user_id: APP_USER_ID,
      created_by_display_name: "Giám đốc B",
      created_at: "2026-11-01T08:00:00Z",
      ended_by_app_user_id: null,
      ended_by_display_name: null,
      ended_at: null,
      ended_reason: null,
    },
  ],
  audit_events: [
    {
      event_id: EVENT_ID,
      action: "ASSIGN",
      link_id: LINK_ID,
      previous_link_id: null,
      referrer_person_id: PERSON_ID,
      previous_referrer_person_id: null,
      effective_date: "2026-11-01",
      actor_app_user_id: APP_USER_ID,
      actor_display_name: "Giám đốc B",
      referrer_full_name: "Nguyễn Văn A",
      previous_referrer_full_name: null,
      reason: "Gắn người giới thiệu ban đầu",
      created_at: "2026-11-01T08:00:00Z",
    },
  ],
  authorization_date: "2026-11-27",
};

const ASSIGN_RESULT_FIXTURE = {
  vendor_id: VENDOR_ID,
  action: "REPLACE",
  current_link: {
    ...CURRENT_LINK,
    vendor_id: VENDOR_ID,
    is_current: true,
  },
  replaced_link_id: PREV_LINK_ID,
  replayed: false,
};

const REVOKE_RESULT_FIXTURE = {
  vendor_id: VENDOR_ID,
  action: "REVOKE",
  revoked_link_id: LINK_ID,
  effective_date: "2026-11-27",
  current_link: null,
  replayed: false,
};

const REPORT_FIXTURE = {
  month: "2026-11",
  period_from: "2026-11-01",
  period_to: "2026-11-30",
  authorization_date: "2026-11-27",
  reconciliation: {
    total_vendor_turns: 15,
    matched_vendor_turns: 12,
    attributed_turns: 9,
    unassigned_vendor_turns: 3,
    unresolved_vendor_turns: 3,
  },
  filtered_summary: {
    attributed_turns: 9,
    referrer_count: 1,
    vendor_count: 1,
    project_count: 1,
  },
  by_referrer: [
    {
      referrer_person_id: PERSON_ID,
      referrer_employee_code: "EMP-001",
      referrer_full_name: "Nguyễn Văn A",
      referrer_department_name: "Phòng Tuyển dụng",
      turns: 9,
      vendor_count: 1,
      project_count: 1,
    },
  ],
  rows: [
    {
      referrer_person_id: PERSON_ID,
      referrer_employee_code: "EMP-001",
      referrer_full_name: "Nguyễn Văn A",
      referrer_department_name: "Phòng Tuyển dụng",
      vendor_id: VENDOR_ID,
      vendor_display_name: "Công ty Vendor Alpha",
      project_id: "PROJ_1",
      project_display_name: "Dự án 1",
      turns: 9,
    },
  ],
  unassigned_vendors: [
    {
      vendor_id: "VENDOR_BETA",
      vendor_display_name: "Công ty Vendor Beta",
      turns: 3,
      project_count: 1,
    },
  ],
  unresolved_vendor_breakdown: [
    {
      recruiter_id: RECRUITER_ID,
      recruiter_display_name: "Recruiter Chưa Map",
      project_id: "PROJ_1",
      project_display_name: "Dự án 1",
      turns: 3,
    },
  ],
  filter_options: {
    referrers: [
      {
        person_id: PERSON_ID,
        employee_code: "EMP-001",
        full_name: "Nguyễn Văn A",
        department_name: "Phòng Tuyển dụng",
      },
    ],
    vendors: [{ vendor_id: VENDOR_ID, display_name: "Công ty Vendor Alpha" }],
    projects: [{ project_id: "PROJ_1", display_name: "Dự án 1" }],
  },
};

function makeDeps(rpcHandler, sessionOverride) {
  const calls = { session: 0, rpcs: [] };
  const rpc = async (name, args) => {
    calls.rpcs.push({ name, args });
    return rpcHandler(name, args);
  };
  const repository = createVendorReferrerRepository
    ? createVendorReferrerRepository(rpc)
    : makeInlineRepo(rpc);
  return {
    calls,
    dependencies: {
      resolveSession: async () => {
        calls.session += 1;
        return (
          sessionOverride ?? {
            actor: {
              ok: true,
              actor: {
                auth_subject: AUTH_SUBJECT,
                app_user_id: APP_USER_ID,
                display_name: "BoD Test",
                enabled: true,
                capabilities: ["vendor_referrer_manage"],
                scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
              },
            },
          }
        );
      },
      repository,
    },
  };
}

function postReq(path, body, headers = {}) {
  return new Request(`https://bi.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://bi.local",
      host: "bi.local",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("contract projectors match exact SQL RPC projections, reject extra/missing/compensation fields, and strip internal user IDs", () => {
  assert.deepEqual(
    projectActorAccess({
      can_manage: true,
      can_view_report: true,
      has_capability: true,
      is_active_bod: true,
    }),
    {
      can_manage: true,
      can_view_report: true,
      has_capability: true,
      is_active_bod: true,
    },
  );
  assert.equal(projectActorAccess({ can_manage: true }), null);
  assert.equal(projectCandidateList(CANDIDATE_LIST_FIXTURE)?.total, 1);
  assert.equal(projectVendorList(VENDOR_LIST_FIXTURE)?.items[0].vendor_id, VENDOR_ID);

  const history = projectVendorHistory(HISTORY_FIXTURE);
  assert.ok(history);
  assert.equal("created_by_app_user_id" in history.links[0], false);
  assert.equal("actor_app_user_id" in history.audit_events[0], false);
  assert.equal(history.audit_events[0].actor_display_name, "Giám đốc B");

  assert.equal(projectAssignMutationResult(ASSIGN_RESULT_FIXTURE)?.action, "REPLACE");
  assert.equal(projectRevokeMutationResult(REVOKE_RESULT_FIXTURE)?.action, "REVOKE");

  // Report reconciliation invariants
  assert.ok(projectMonthlyReport(REPORT_FIXTURE));
  assert.equal(
    projectMonthlyReport({
      ...REPORT_FIXTURE,
      reconciliation: { ...REPORT_FIXTURE.reconciliation, unresolved_vendor_turns: 99 },
    }),
    null,
    "matched + unresolved !== total must fail closed",
  );
  assert.equal(
    projectMonthlyReport({
      ...REPORT_FIXTURE,
      commission_vnd: 100000,
    }),
    null,
    "money/commission fields must fail closed",
  );
});

test("SQLSTATE classifier maps conflict/denied/not-found/invalid/unavailable fail-closed", () => {
  assert.equal(classifyVendorReferrerError({ code: "PT409" }), "conflict");
  assert.equal(classifyVendorReferrerError({ code: "40001" }), "conflict");
  assert.equal(classifyVendorReferrerError({ code: "23505" }), "conflict");
  assert.equal(classifyVendorReferrerError({ code: "23P01" }), "conflict");
  assert.equal(
    classifyVendorReferrerError({ code: "22023", message: "idempotency key reused with different input" }),
    "conflict",
  );
  assert.equal(classifyVendorReferrerError({ code: "42501" }), "denied");
  assert.equal(classifyVendorReferrerError({ code: "P0002" }), "not-found");
  assert.equal(classifyVendorReferrerError({ code: "23514" }), "invalid");
  assert.equal(classifyVendorReferrerError({ code: "22023", message: "bad input" }), "invalid");
  assert.equal(classifyVendorReferrerError({ code: "XX000" }), "unavailable");
});

test("feature gate OFF returns 404 before session or RPC", async () => {
  const { calls, dependencies } = makeDeps(async () => ({ data: VENDOR_LIST_FIXTURE, error: null }));
  const res = await listVendorReferrerVendors(
    new Request("https://bi.local/api/admin/vendor-referrals/vendors"),
    "false",
    dependencies,
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(calls.session, 0);
  assert.equal(calls.rpcs.length, 0);
});

test("invalid inputs, disallowed authority/money fields, CSRF, and idempotency mismatch return 400/403", async () => {
  const { calls, dependencies } = makeDeps(async () => ({ data: ASSIGN_RESULT_FIXTURE, error: null }));

  // Invalid vendorId (__system_vendor__) on history & assign
  const sysHistory = await getVendorReferrerHistory(
    new Request("https://bi.local/api/admin/vendor-referrals/vendors/__system_vendor__/history"),
    "__system_vendor__",
    "true",
    dependencies,
  );
  assert.equal(sysHistory.status, 400);

  // Invalid report query params
  for (const qs of [
    "month=2026-13",
    "month=invalid",
    "referrer_person_id=not-uuid",
    "vendor_id=__system_vendor__",
    "unknown=1",
    "month=2026-11&month=2026-10",
  ]) {
    const badReport = await getVendorReferrerMonthlyReport(
      new Request(`https://bi.local/api/admin/vendor-referrals/report?${qs}`),
      "true",
      dependencies,
    );
    assert.equal(badReport.status, 400, qs);
  }

  // Control char in search
  const badSearch = await listVendorReferrerCandidates(
    new Request("https://bi.local/api/admin/vendor-referrals/candidates?search=abc%0A"),
    "true",
    dependencies,
  );
  assert.equal(badSearch.status, 400);

  // Cross-origin CSRF -> 403
  const csrfRes = await assignVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`,
      {
        referrer_person_id: PERSON_ID,
        reason: "Gắn đối tác",
        idempotency_key: IDEM_KEY,
      },
      { origin: "https://evil.test" },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(csrfRes.status, 403);
  assert.equal((await csrfRes.json()).code, "CSRF_REJECTED");

  // Authority spoofing & money/commission fields -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  for (const forbiddenBody of [
    {
      referrer_person_id: PERSON_ID,
      reason: "Test",
      idempotency_key: IDEM_KEY,
      actor: { app_user_id: APP_USER_ID },
    },
    {
      referrer_person_id: PERSON_ID,
      reason: "Test",
      idempotency_key: IDEM_KEY,
      commission_rate: 5,
    },
    {
      referrer_person_id: PERSON_ID,
      reason: "Test",
      idempotency_key: IDEM_KEY,
      fee_amount: 100000,
    },
  ]) {
    const res = await assignVendorReferrer(
      postReq(`/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`, forbiddenBody),
      VENDOR_ID,
      "true",
      dependencies,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  // Idempotency-Key header vs body mismatch -> 400 IDEMPOTENCY_KEY_MISMATCH
  const mismatchStd = await assignVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`,
      {
        referrer_person_id: PERSON_ID,
        reason: "Gắn mới",
        idempotency_key: IDEM_KEY,
      },
      { "idempotency-key": OTHER_IDEM_KEY },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(mismatchStd.status, 400);
  assert.equal((await mismatchStd.json()).code, "IDEMPOTENCY_KEY_MISMATCH");

  // X-Idempotency-Key header vs body mismatch -> 400 IDEMPOTENCY_KEY_MISMATCH
  const mismatchX = await revokeVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/revoke`,
      {
        reason: "Thu hồi",
        idempotency_key: IDEM_KEY,
      },
      { "x-idempotency-key": OTHER_IDEM_KEY },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(mismatchX.status, 400);
  assert.equal((await mismatchX.json()).code, "IDEMPOTENCY_KEY_MISMATCH");

  // Missing reason -> 400
  const emptyReason = await revokeVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/revoke`,
      { reason: "   ", idempotency_key: IDEM_KEY },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(emptyReason.status, 400);

  // None of those invalid calls touched session or RPC
  assert.equal(calls.session, 0);
  assert.equal(calls.rpcs.length, 0);
});

test("unauthenticated -> 401, non-BoD / Admin-without-BoD -> 403, OCC conflict -> 409, malformed RPC -> 503", async () => {
  // 401 Unauthenticated
  const unauthDeps = makeDeps(async () => ({ data: null, error: null }), {
    actor: { ok: false, reason: "UNAUTHENTICATED" },
  }).dependencies;
  const unauthRes = await listVendorReferrerVendors(
    new Request("https://bi.local/api/admin/vendor-referrals/vendors"),
    "true",
    unauthDeps,
  );
  assert.equal(unauthRes.status, 401);

  // 403 Non-BoD / Admin-without-BoD (DB raises 42501 VENDOR_REFERRER_BOD_REQUIRED)
  const deniedDeps = makeDeps(async () => ({
    data: null,
    error: { code: "42501", message: "VENDOR_REFERRER_BOD_REQUIRED" },
  })).dependencies;
  for (const res of await Promise.all([
    listVendorReferrerVendors(
      new Request("https://bi.local/api/admin/vendor-referrals/vendors"),
      "true",
      deniedDeps,
    ),
    listVendorReferrerCandidates(
      new Request("https://bi.local/api/admin/vendor-referrals/candidates"),
      "true",
      deniedDeps,
    ),
    getVendorReferrerHistory(
      new Request(`https://bi.local/api/admin/vendor-referrals/vendors/${VENDOR_ID}/history`),
      VENDOR_ID,
      "true",
      deniedDeps,
    ),
    assignVendorReferrer(
      postReq(`/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`, {
        referrer_person_id: PERSON_ID,
        reason: "Non-BoD attempt",
        idempotency_key: IDEM_KEY,
      }),
      VENDOR_ID,
      "true",
      deniedDeps,
    ),
    revokeVendorReferrer(
      postReq(`/api/admin/vendor-referrals/vendors/${VENDOR_ID}/revoke`, {
        reason: "Non-BoD revoke attempt",
        idempotency_key: IDEM_KEY,
      }),
      VENDOR_ID,
      "true",
      deniedDeps,
    ),
    getVendorReferrerMonthlyReport(
      new Request("https://bi.local/api/admin/vendor-referrals/report"),
      "true",
      deniedDeps,
    ),
  ])) {
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal((await res.json()).code, "VENDOR_REFERRER_DENIED");
  }

  // 409 OCC conflict (PT409)
  const conflictDeps = makeDeps(async () => ({
    data: null,
    error: { code: "PT409", message: "VENDOR_REFERRER_CONCURRENT_MODIFICATION" },
  })).dependencies;
  const conflictRes = await assignVendorReferrer(
    postReq(`/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`, {
      referrer_person_id: PERSON_ID,
      expected_current_link_id: PREV_LINK_ID,
      reason: "Thay người giới thiệu",
      idempotency_key: IDEM_KEY,
    }),
    VENDOR_ID,
    "true",
    conflictDeps,
  );
  assert.equal(conflictRes.status, 409);
  assert.equal((await conflictRes.json()).code, "VENDOR_REFERRER_CONFLICT");

  // 503 Malformed RPC projection fail-closed
  const malformedDeps = makeDeps(async () => ({
    data: { ...REPORT_FIXTURE, reconciliation: { ...REPORT_FIXTURE.reconciliation, total_vendor_turns: 999 } },
    error: null,
  })).dependencies;
  const malformedRes = await getVendorReferrerMonthlyReport(
    new Request("https://bi.local/api/admin/vendor-referrals/report?month=2026-11"),
    "true",
    malformedDeps,
  );
  assert.equal(malformedRes.status, 503);
  assert.equal((await malformedRes.json()).code, "VENDOR_REFERRER_UNAVAILABLE");
});

test("happy paths forward server actor only, support X-Idempotency-Key, and parse report reconciliation", async () => {
  const { calls, dependencies } = makeDeps(async (name) => {
    switch (name) {
      case "direct_entry_vendor_referrer_list_vendors":
        return { data: VENDOR_LIST_FIXTURE, error: null };
      case "direct_entry_vendor_referrer_list_candidates":
        return { data: CANDIDATE_LIST_FIXTURE, error: null };
      case "direct_entry_vendor_referrer_get_history":
        return { data: HISTORY_FIXTURE, error: null };
      case "direct_entry_vendor_referrer_assign":
        return { data: ASSIGN_RESULT_FIXTURE, error: null };
      case "direct_entry_vendor_referrer_revoke":
        return { data: REVOKE_RESULT_FIXTURE, error: null };
      case "direct_entry_vendor_referrer_monthly_report":
        return { data: REPORT_FIXTURE, error: null };
      default:
        return { data: null, error: { code: "XX000", message: "unexpected" } };
    }
  });

  const assignRes = await assignVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/assign`,
      {
        referrer_person_id: PERSON_ID,
        effective_date: "2026-11-15",
        expected_current_link_id: PREV_LINK_ID,
        reason: "Chuyển giao từ tháng 11",
      },
      { "x-idempotency-key": IDEM_KEY },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(assignRes.status, 200);
  const assignPayload = await assignRes.json();
  assert.equal(assignPayload.ok, true);
  assert.equal(assignPayload.data.action, "REPLACE");
  assert.equal(assignPayload.data.replaced_link_id, PREV_LINK_ID);

  assert.equal(calls.rpcs[0].name, "direct_entry_vendor_referrer_assign");
  assert.equal(calls.rpcs[0].args.p_auth_subject, AUTH_SUBJECT);
  assert.equal(calls.rpcs[0].args.p_app_user_id, APP_USER_ID);
  assert.equal(calls.rpcs[0].args.p_idempotency_key, IDEM_KEY);

  const reportRes = await getVendorReferrerMonthlyReport(
    new Request(`https://bi.local/api/admin/vendor-referrals/report?month=2026-11&referrer_person_id=${PERSON_ID}`),
    "true",
    dependencies,
  );
  assert.equal(reportRes.status, 200);
  const reportBody = await reportRes.json();
  assert.equal(reportBody.ok, true);
  assert.equal(reportBody.data.reconciliation.total_vendor_turns, 15);
  assert.equal(reportBody.data.reconciliation.attributed_turns, 9);
  assert.equal(reportBody.data.reconciliation.unassigned_vendor_turns, 3);
  assert.equal(reportBody.data.reconciliation.unresolved_vendor_turns, 3);

  const revokeRes = await revokeVendorReferrer(
    postReq(
      `/api/admin/vendor-referrals/vendors/${VENDOR_ID}/revoke`,
      {
        expected_current_link_id: LINK_ID,
        reason: "Ngừng hợp tác",
        idempotency_key: OTHER_IDEM_KEY,
      },
      { "idempotency-key": OTHER_IDEM_KEY },
    ),
    VENDOR_ID,
    "true",
    dependencies,
  );
  assert.equal(revokeRes.status, 200);
  const revokeBody = await revokeRes.json();
  assert.equal(revokeBody.data.action, "REVOKE");
  assert.equal(revokeBody.data.current_link, null);
});

test("navigation & page access gates isolate BoD vendor referrer surfaces from non-BoD Admin, HR, Accounting, TL, Employee", () => {
  const makeActorResolution = (capabilities, kind = "all") => ({
    ok: true,
    actor: {
      auth_subject: AUTH_SUBJECT,
      app_user_id: APP_USER_ID,
      display_name: "Test Actor",
      enabled: true,
      capabilities,
      scopes: [{ kind, reference: kind === "all" ? "all" : "team-1", valid_from: "2026-01-01", valid_to: null }],
      effective_grants: capabilities.map((cap) => ({
        capability: cap,
        scope_kind: kind === "all" ? "ALL" : kind === "team" ? "CONTEXT_TEAM" : "OWN",
        scope_id: kind === "team" ? "team-1" : null,
        source_type: "ROLE_BUNDLE",
        source_id: DEPT_ID,
      })),
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  });

  const bodActor = makeActorResolution(["vendor_referrer_manage"], "all");
  const nonBodSystemAdmin = makeActorResolution(
    ["entry_admin", "recruiter_master_manage", "team_master_manage", "vendor_referrer_manage"],
    "all",
  );
  const hrOperator = makeActorResolution(["recruiter_master_manage", "team_master_manage", "catalog_master_manage"], "all");
  const accounting = makeActorResolution(["catalog_master_manage", "vendor_finance_record"], "all");
  const teamLeader = makeActorResolution(["entry_team", "team_manager_assign"], "team");
  const employee = makeActorResolution(["entry_create", "entry_own"], "own");

  // BoD with server-verified access opens /admin/vendor-referrals and /admin/catalog/vendors
  assert.equal(
    decideVendorReferrerReportPageAccess({ actor: bodActor, hasVendorReferrerAccess: true }),
    "ALLOW",
  );
  assert.equal(
    decideVendorCatalogPageAccess({ actor: bodActor, hasVendorReferrerAccess: true }),
    "ALLOW",
  );
  assert.equal(
    resolveAdminLandingPath(bodActor, { hasVendorReferrerAccess: true }),
    "/admin/vendor-referrals",
  );
  assert.equal(
    vendorReferrerNavPredicate({
      capabilities: ["vendor_referrer_manage"],
      scopes: [{ kind: "all" }],
      hasVendorReferrerAccess: true,
    }),
    true,
  );
  assert.equal(
    adminPanelNavPredicate({
      capabilities: ["vendor_referrer_manage"],
      scopes: [{ kind: "all" }],
      hasVendorReferrerAccess: true,
    }),
    true,
  );
  assert.equal(
    decideNavEntryVisibility({
      capabilityKey: "vendor_referrals",
      actor: { capabilities: ["vendor_referrer_manage"], scopes: [{ kind: "all" }], hasVendorReferrerAccess: true },
      viewport: "desktop",
      entryVisibleInViewport: true,
    }),
    true,
  );
  assert.deepEqual(
    visibleAdminSections({
      capabilities: ["vendor_referrer_manage"],
      scopes: [{ kind: "all" }],
      hasVendorReferrerAccess: true,
    }).map((s) => s.id),
    ["vendors", "vendor-referrals"],
  );

  // Non-BoD Admin (even with vendor_referrer_manage capability from SYSTEM_ADMIN), HR, Accounting, TL, Employee -> DENIED
  for (const deniedActor of [nonBodSystemAdmin, hrOperator, accounting, teamLeader, employee]) {
    assert.equal(
      decideVendorReferrerReportPageAccess({ actor: deniedActor, hasVendorReferrerAccess: false }),
      "ACCESS_DENIED",
    );
    assert.equal(
      decideVendorReferrerReportPageAccess({ actor: deniedActor }),
      "ACCESS_DENIED",
    );
  }

  // Without hasVendorReferrerAccess, non-BoD Admin/Accounting cannot see vendor-referrals section
  assert.equal(
    visibleAdminSections({
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage", "vendor_referrer_manage"],
      scopes: [{ kind: "all" }],
      hasVendorReferrerAccess: false,
    }).some((s) => s.id === "vendor-referrals"),
    false,
  );
});
