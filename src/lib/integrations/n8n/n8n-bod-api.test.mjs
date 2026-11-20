import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateN8nBodRequest,
  clearN8nServiceActorCache,
  N8N_BOD_READONLY_PRINCIPAL,
  resolveN8nBodServiceActor,
} from "./auth.ts";
import { N8N_BOD_CATALOG_VERSION } from "./catalog.ts";
import { MAX_N8N_RESPONSE_BYTES } from "./dispatcher.ts";
import {
  handleN8nBodCatalogGet,
  handleN8nBodQueryPost,
} from "./http-handlers.ts";
import {
  createAbortAwareFetch,
  runWithSupabaseAbortSignal,
} from "../../supabase/server.ts";

const VALID_API_KEY = "n8n_bod_secret_token_for_unit_test_1234567890";
const TEST_ENV = {
  apiEnabled: "true",
  apiKey: VALID_API_KEY,
  authSubject: "11111111-1111-4111-8111-111111111111",
  appUserId: "22222222-2222-4222-8222-222222222222",
};

const TEST_ACTOR = {
  auth_subject: TEST_ENV.authSubject,
  app_user_id: TEST_ENV.appUserId,
};

function makeCatalogRequest(
  path = "/api/integrations/n8n/v1/catalog",
  headers = { authorization: `Bearer ${VALID_API_KEY}` },
) {
  return new Request(`https://bi.internal${path}`, {
    method: "GET",
    headers,
  });
}

function makeQueryRequest(
  body,
  headers = {
    authorization: `Bearer ${VALID_API_KEY}`,
    "content-type": "application/json",
  },
  path = "/api/integrations/n8n/v1/query",
) {
  return new Request(`https://bi.internal${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("authenticateN8nBodRequest enforces dedicated Bearer secret and rejects forbidden headers/query params", () => {
  // 1. Disabled integration
  const disabledRes = authenticateN8nBodRequest(makeCatalogRequest(), {
    ...TEST_ENV,
    apiEnabled: "false",
  });
  assert.equal(disabledRes.ok, false);
  assert.equal(disabledRes.status, 503);
  assert.equal(disabledRes.code, "N8N_INTEGRATION_DISABLED");

  // 2. Missing or short API key
  const unconfiguredRes = authenticateN8nBodRequest(makeCatalogRequest(), {
    ...TEST_ENV,
    apiKey: "too-short",
  });
  assert.equal(unconfiguredRes.ok, false);
  assert.equal(unconfiguredRes.status, 503);
  assert.equal(unconfiguredRes.code, "N8N_INTEGRATION_NOT_CONFIGURED");

  // 3. Token in query string is forbidden
  const queryCredRes = authenticateN8nBodRequest(
    makeCatalogRequest(`/api/integrations/n8n/v1/catalog?api_key=${VALID_API_KEY}`),
    TEST_ENV,
  );
  assert.equal(queryCredRes.ok, false);
  assert.equal(queryCredRes.status, 400);
  assert.equal(queryCredRes.code, "CREDENTIAL_IN_QUERY_FORBIDDEN");

  // 4. Caller-supplied authority header is forbidden
  const headerAuthRes = authenticateN8nBodRequest(
    makeCatalogRequest("/api/integrations/n8n/v1/catalog", {
      authorization: `Bearer ${VALID_API_KEY}`,
      "x-team-id": "33333333-3333-4333-8333-333333333333",
    }),
    TEST_ENV,
  );
  assert.equal(headerAuthRes.ok, false);
  assert.equal(headerAuthRes.status, 400);
  assert.equal(headerAuthRes.code, "CLIENT_AUTHORITY_HEADER_FORBIDDEN");

  // 5. Wrong bearer token -> 401
  const wrongTokenRes = authenticateN8nBodRequest(
    makeCatalogRequest("/api/integrations/n8n/v1/catalog", {
      authorization: "Bearer wrong_token_value_12345678901234567890",
    }),
    TEST_ENV,
  );
  assert.equal(wrongTokenRes.ok, false);
  assert.equal(wrongTokenRes.status, 401);
  assert.equal(wrongTokenRes.code, "UNAUTHORIZED");

  // 6. Valid bearer token -> fixed principal n8n_bod_readonly at all scope
  const okRes = authenticateN8nBodRequest(makeCatalogRequest(), TEST_ENV);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.principal.principal, N8N_BOD_READONLY_PRINCIPAL);
  assert.equal(okRes.principal.scope, "all");
});

test("resolveN8nBodServiceActor requires explicit N8N_BOD_READONLY_AUTH_SUBJECT and verifies all scope via RPC", async () => {
  clearN8nServiceActorCache();

  // 1. Missing explicit authSubject must fail closed (no 600-account scan)
  const missingSubject = await resolveN8nBodServiceActor({
    env: { apiKey: VALID_API_KEY },
    resolveActorContextRpc: async () => {
      throw new Error("Should not be called when authSubject is missing");
    },
  });
  assert.equal(missingSubject.ok, false);
  assert.equal(missingSubject.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");

  // 2. Explicit authSubject + appUserId WITHOUT all_scope_grants must be rejected
  clearN8nServiceActorCache();
  const nonAllScope = await resolveN8nBodServiceActor({
    env: TEST_ENV,
    resolveActorContextRpc: async (authSubject) => ({
      data: {
        auth_subject: authSubject,
        app_user_id: TEST_ENV.appUserId,
        enabled: true,
        capabilities: ["entry_own"],
        all_scope_grants: [],
      },
      error: null,
    }),
  });
  assert.equal(nonAllScope.ok, false);
  assert.equal(nonAllScope.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");

  // 3. Explicit authSubject + mismatched appUserId must be rejected
  clearN8nServiceActorCache();
  const mismatchedAppUser = await resolveN8nBodServiceActor({
    env: TEST_ENV,
    resolveActorContextRpc: async (authSubject) => ({
      data: {
        auth_subject: authSubject,
        app_user_id: "99999999-9999-4999-8999-999999999999",
        enabled: true,
        capabilities: ["entry_admin"],
        all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
        effective_grants: [{ capability: "entry_admin", scope_kind: "ALL", scope_id: null }],
      },
      error: null,
    }),
  });
  assert.equal(mismatchedAppUser.ok, false);
  assert.equal(mismatchedAppUser.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");

  // 3b. Orphan all_scope_grants without paired reporting capability @ ALL must be rejected (WP5B-2 Group A)
  clearN8nServiceActorCache();
  const unpairedAll = await resolveN8nBodServiceActor({
    env: TEST_ENV,
    resolveActorContextRpc: async (authSubject) => ({
      data: {
        auth_subject: authSubject,
        app_user_id: TEST_ENV.appUserId,
        enabled: true,
        capabilities: ["catalog_master_manage"],
        all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
        effective_grants: [{ capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null }],
      },
      error: null,
    }),
  });
  assert.equal(unpairedAll.ok, false);
  assert.equal(unpairedAll.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");

  // 4. Explicit authSubject verified with enabled=true and active all_scope_grants + paired ALL reporting grant succeeds,
  // and re-verifies on EVERY subsequent request (no 5-minute cache window when all scope is revoked)
  let rpcCallCount = 0;
  let allScopeRevoked = false;
  const resolveRpc = async (authSubject) => {
    rpcCallCount += 1;
    return {
      data: {
        auth_subject: authSubject,
        app_user_id: TEST_ENV.appUserId,
        enabled: true,
        capabilities: ["entry_admin", "report_view"],
        all_scope_grants: allScopeRevoked
          ? []
          : [{ valid_from: "2026-01-01", valid_to: null }],
        effective_grants: allScopeRevoked
          ? []
          : [
              { capability: "entry_admin", scope_kind: "ALL", scope_id: null },
              { capability: "report_view", scope_kind: "ALL", scope_id: null },
            ],
      },
      error: null,
    };
  };

  const verified = await resolveN8nBodServiceActor({
    env: TEST_ENV,
    resolveActorContextRpc: resolveRpc,
  });
  assert.equal(verified.ok, true);
  assert.equal(rpcCallCount, 1);
  assert.deepEqual(verified.actor, TEST_ACTOR);

  // Immediately revoke all scope WITHOUT calling clearN8nServiceActorCache()
  allScopeRevoked = true;
  const afterRevoke = await resolveN8nBodServiceActor({
    env: TEST_ENV,
    resolveActorContextRpc: resolveRpc,
  });
  assert.equal(rpcCallCount, 2, "Must re-verify actor on every call without TTL caching");
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");
});

test("GET /api/integrations/n8n/v1/catalog returns complete versioned catalog including active work_reports domain", async () => {
  const response = await handleN8nBodCatalogGet(makeCatalogRequest(), {
    env: TEST_ENV,
    now: new Date("2026-10-25T10:00:00.000Z"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.catalog_version, N8N_BOD_CATALOG_VERSION);
  assert.equal(body.principal, "n8n_bod_readonly");
  assert.equal(body.scope, "all");
  assert.equal(body.business_timezone, "Asia/Ho_Chi_Minh");
  assert.equal(body.query_contract.arbitrary_sql_allowed, false);
  assert.equal(body.query_contract.client_authority_fields_allowed, false);

  const datasetNames = body.datasets.map((d) => d.dataset);
  const expectedDatasets = [
    "recruitment_cutover_summary",
    "recruitment_legacy_summary",
    "recruitment_cutover_reconciliation",
    "workforce_analytics",
    "workforce_offboarding",
    "workers_directory",
    "workers_profile_detail",
    "workers_episodes_lookup",
    "workers_duplicate_cccd",
    "attendance_checkins",
    "vendor_finance_monthly_report",
    "vendor_finance_subledgers",
    "vendor_finance_entries",
    "vendor_finance_reconciliations",
    "data_quality_pipeline",
    "data_quality_cccd_reconciliation",
    "catalog_projects",
    "catalog_teams",
    "catalog_project_team_scopes",
    "catalog_recruiters",
    "catalog_vendors",
    "catalog_labor_types",
    "work_reports_templates",
    "work_reports_assignments",
    "work_reports_submissions",
    "work_reports_submission_detail",
    "work_reports_analytics",
  ];
  assert.deepEqual(datasetNames, expectedDatasets);

  // Every measure must document formula and business_limits
  for (const ds of body.datasets) {
    for (const m of ds.measures) {
      assert.ok(m.formula && m.formula.length > 0, `Measure ${ds.dataset}.${m.name} missing formula`);
      assert.ok(
        m.business_limits && m.business_limits.length > 0,
        `Measure ${ds.dataset}.${m.name} missing business_limits`,
      );
    }
  }

  // Work reports domain is now ACTIVE and pending_datasets is empty
  const workReportsDomain = body.domains.find((d) => d.domain === "work_reports");
  assert.ok(workReportsDomain);
  assert.equal(workReportsDomain.status, "ACTIVE");
  assert.equal(body.pending_datasets.length, 0);
});

test("POST /api/integrations/n8n/v1/query rejects SQL, client authority fields, and unknown datasets", async () => {
  // 1. Reject arbitrary SQL
  const sqlRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "workers_directory",
      sql: "SELECT * FROM direct_entries",
    }),
    { env: TEST_ENV },
  );
  assert.equal(sqlRes.status, 400);
  const sqlBody = await sqlRes.json();
  assert.equal(sqlBody.error.code, "ARBITRARY_SQL_FORBIDDEN");

  // 2. Reject client authority fields (actor, role, scope, team_id, capabilities)
  for (const forbiddenField of [
    "actor",
    "role",
    "scope",
    "team_id",
    "auth_subject",
    "app_user_id",
    "capabilities",
  ]) {
    const authRes = await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_directory",
        [forbiddenField]: "injected",
      }),
      { env: TEST_ENV },
    );
    assert.equal(authRes.status, 400);
    const authBody = await authRes.json();
    assert.equal(authBody.error.code, "CLIENT_AUTHORITY_FORBIDDEN");
  }

  // 3. Unknown dataset returns 400 DATASET_NOT_SUPPORTED
  const unknownRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "non_existent_dataset",
    }),
    { env: TEST_ENV },
  );
  assert.equal(unknownRes.status, 400);
  const unknownBody = await unknownRes.json();
  assert.equal(unknownBody.error.code, "DATASET_NOT_SUPPORTED");
});

test("Recruitment cutover reconciliation & summary strictly prevent double-counting across cutoff_date", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    fetchDirectEntryCutoverReporting: async () => ({
      ok: true,
      generatedAt: "2026-10-25T10:00:00Z",
      audience: { kind: "all", label: "Toàn công ty", teamLabels: [] },
      data: {
        applied: {
          from: "2026-10-01",
          to: "2026-10-25",
          project: undefined,
          recruiter: undefined,
          team: undefined,
          employment: undefined,
          provider: undefined,
          source: undefined,
        },
        options: {
          projects: [],
          recruiters: [],
          teams: [],
          employments: [],
          providers: [],
          sources: [],
        },
        recruitedTotal: 120,
        byDate: {
          "2026-10-20": 120,
        },
        byProject: {
          "proj-a": {
            key: "proj-a",
            display: "Dự án A",
            recruitedCount: 120,
            validRowCount: 120,
          },
        },
        byRecruiter: {},
        byTeam: {},
        byEmployment: {},
        byProvider: {
          hrp: {
            key: "hrp",
            display: "HRP",
            recruitedCount: 80,
            validRowCount: 80,
          },
          vendor: {
            key: "vendor",
            display: "Vendor",
            recruitedCount: 40,
            validRowCount: 40,
          },
        },
        projectProviderMix: [
          {
            projectKey: "proj-a",
            projectDisplay: "Dự án A",
            recruitedTotal: 120,
            hrpCount: 80,
            vendorCount: 40,
            unknownCount: 0,
            invalidCount: 0,
            knownTotal: 120,
            hrpShare: 80 / 120,
            vendorShare: 40 / 120,
          },
        ],
        sources: [],
        coverage: {
          activeSourcesTotal: 1,
          activeSourcesWithSyncedData: 1,
          activeSourcesMissingData: 0,
          coverageRatio: 1,
          degradedSources: 0,
        },
      },
    }),
    fetchP1Reporting: async () => ({
      ok: true,
      generatedAt: "2026-10-25T10:00:00Z",
      data: {
        applied: {
          from: "2026-10-01",
          to: "2026-10-25",
        },
        options: {
          projects: [],
          recruiters: [],
          teams: [],
          employments: [],
          providers: [],
          sources: [],
        },
        recruitedTotal: 45,
        byDate: {
          "2026-10-15": 45,
        },
        byProject: {},
        byRecruiter: {},
        byTeam: {},
        byEmployment: {},
        byProvider: {
          hrp: {
            key: "hrp",
            display: "HRP",
            recruitedCount: 30,
            validRowCount: 30,
          },
          vendor: {
            key: "vendor",
            display: "Vendor",
            recruitedCount: 15,
            validRowCount: 15,
          },
        },
        projectProviderMix: [],
        sources: [],
        coverage: {
          activeSourcesTotal: 1,
          activeSourcesWithSyncedData: 1,
          activeSourcesMissingData: 0,
          coverageRatio: 1,
          degradedSources: 0,
        },
      },
    }),
  };

  const reconRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "recruitment_cutover_reconciliation",
      date_range: { from: "2026-10-01", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(reconRes.status, 200);
  const reconBody = await reconRes.json();
  assert.equal(reconBody.ok, true);
  assert.equal(reconBody.summary.legacy_before_cutoff_total, 0);
  assert.equal(reconBody.summary.legacy_on_or_after_cutoff_masked_total, 45);
  assert.equal(reconBody.summary.direct_entry_on_or_after_cutoff_total, 120);
  // Strictly 120, NEVER 120 + 45 = 165!
  assert.equal(reconBody.summary.combined_non_overlapping_total, 120);
});

test("Sensitive fields (CCCD, phone, GPS, bank account, free-text notes) are redacted by default and returned only when requested", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    attendanceRepo: {
      getAdminReport: async () => ({
        ok: true,
        report: {
          viewer: { can_configure_hq: false },
          filters: {
            from_date: "2026-10-25",
            to_date: "2026-10-25",
            search: null,
            employee_id: null,
            timezone: "Asia/Ho_Chi_Minh",
          },
          employee_options: [],
          current_hq: {
            version: 1,
            latitude: 21.0285,
            longitude: 105.8542,
            effective_from: "2026-10-01T00:00:00Z",
            effective_from_local: "2026-10-01 07:00:00",
            configured_by_display_name: "Admin",
          },
          overview: {
            total_checkins: 1,
            unique_employees: 1,
            verified_time_count: 1,
            unverified_time_count: 0,
            distance_computed_count: 1,
            distance_unavailable_count: 0,
            avg_distance_meters: 12.4,
            max_distance_meters: 12.4,
          },
          pagination: {
            page: 1,
            page_size: 50,
            total_rows: 1,
            total_pages: 1,
            has_more: false,
          },
          items: [
            {
              checkin_id: "99999999-9999-4999-8999-999999999999",
              employee_display_name: "Nguyễn Văn A",
              personnel_code: "HRP001",
              business_date: "2026-10-25",
              sequence_in_day: 1,
              captured_at: "2026-10-25T01:00:00Z",
              captured_at_local: "2026-10-25 08:00:00",
              received_at: "2026-10-25T01:00:02Z",
              time_source: "SERVER_TOKEN",
              time_verified: true,
              sync_delay_seconds: 2,
              latitude: 21.02851,
              longitude: 105.85421,
              accuracy_meters: 8.5,
              address_hint: "Số 1 Tràng Tiền, Hoàn Kiếm",
              distance_meters: 12.4,
              distance_status: "WITHIN_100M",
              hq_version_used: 1,
              note: "Đi họp khách hàng buổi sáng",
            },
          ],
        },
      }),
    },
    offboardingRepo: {
      list: async () => ({
        ok: true,
        data: {
          scope: "all",
          can_phone: true,
          can_export: true,
          can_hide: true,
          authorization_date: "2026-10-25",
          threshold_days: 3,
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          items: [
            {
              employee_code: "CN001",
              display_name: "Trần Thị B",
              project_id: "proj-1",
              project_display: "Dự án 1",
              recruiter_id: "44444444-4444-4444-8444-444444444444",
              recruiter_display: "Lê Tuyển Dụng",
              off_effective_date: "2026-10-15",
              days_since_off: 10,
              phone: "0912345678",
            },
          ],
        },
      }),
    },
    workerWriteRepo: {
      readEntry: async () => ({
        ok: true,
        data: {
          entry_id: "55555555-5555-4555-8555-555555555555",
          submission_id: "66666666-6666-4666-8666-666666666666",
          version: 1,
          employee_code: "CN101",
          project_id: "proj-1",
          recruiter_id: "44444444-4444-4444-8444-444444444444",
          team_id: "77777777-7777-4777-8777-777777777777",
          provider_type: "hrp",
          labor_type: "chinh_thuc",
          labor_type_display: "Chính thức",
          first_work_date: "2026-10-10",
          general_note: "Ghi chú nội bộ nhạy cảm",
          employment_status: {
            status: "ON",
            effective_date: "2026-10-10",
          },
          worker_details: {
            display_name: "Phạm Văn C",
            gender: { state: "provided", value: "Nam" },
            date_of_birth: { state: "provided", value: "1998-05-12" },
            national_id: { state: "provided", value: "001200012345" },
            national_id_issued_at: { state: "provided", value: "2021-01-01" },
            national_id_issued_place: {
              state: "provided",
              value: "Cục Cảnh sát QLHC",
            },
            phone: { state: "provided", value: "0988777666" },
            address: { state: "provided", value: "Quận Cầu Giấy, Hà Nội" },
          },
          payment: {
            state: "READY",
            bank_id: "VCB",
            bank_name: "Vietcombank",
            account_number: "0011009988776",
            account_holder_name: "PHAM VAN C",
          },
          worker_portrait: {
            status: "UPLOADED",
          },
          documents: [{ document_id: "doc-1" }, { document_id: "doc-2" }],
        },
      }),
    },
    duplicateCccdRepo: {
      report: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          page: 1,
          page_size: 25,
          total_groups: 1,
          total_entries: 2,
          has_more: false,
          groups: [
            {
              cccd_last4: "2345",
              cccd_length: 12,
              profile_count: 2,
              project_count: 1,
              active_profile_count: 2,
              first_work_date: "2026-10-10",
              latest_first_work_date: "2026-10-12",
              episodes: [
                {
                  entry_id: "55555555-5555-4555-8555-555555555555",
                  entry_version: 1,
                  employee_code: "CN101",
                  display_name: "Phạm Văn C",
                  project_display: "Dự án 1",
                  first_work_date: "2026-10-10",
                  latest_status: "ON",
                  active: true,
                },
              ],
            },
          ],
        },
      }),
    },
  };

  // 1. Attendance default query (no explicit fields) MUST redact GPS and note
  const attDefaultRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "attendance_checkins",
      date_range: { from: "2026-10-25", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(attDefaultRes.status, 200);
  const attDefaultBody = await attDefaultRes.json();
  assert.equal(attDefaultBody.rows.length, 1);
  assert.equal("latitude" in attDefaultBody.rows[0], false);
  assert.equal("longitude" in attDefaultBody.rows[0], false);
  assert.equal("address_hint" in attDefaultBody.rows[0], false);
  assert.equal("note" in attDefaultBody.rows[0], false);
  assert.deepEqual(attDefaultBody.sensitivity.requested_sensitive_fields, []);
  assert.ok(attDefaultBody.sensitivity.redacted_sensitive_fields.includes("latitude"));
  assert.ok(attDefaultBody.sensitivity.redacted_sensitive_fields.includes("note"));

  // 2. Attendance query explicitly requesting latitude, longitude, note MUST return them
  const attExplicitRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "attendance_checkins",
      fields: ["employee_code", "distance_meters", "latitude", "longitude", "note"],
      date_range: { from: "2026-10-25", to: "2026-10-25" },
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  const attExplicitBody = await attExplicitRes.json();
  assert.equal(attExplicitBody.rows[0].latitude, 21.02851);
  assert.equal(attExplicitBody.rows[0].longitude, 105.85421);
  assert.equal(attExplicitBody.rows[0].note, "Đi họp khách hàng buổi sáng");
  assert.equal("address_hint" in attExplicitBody.rows[0], false);

  // 3. Offboarding default query redacts phone; explicit fields includes phone
  const offDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({ dataset: "workforce_offboarding" }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal("phone" in offDefaultBody.rows[0], false);

  const offExplicitBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workforce_offboarding",
        fields: ["employee_code", "display_name", "phone"],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(offExplicitBody.rows[0].phone, "0912345678");

  // 4. Worker profile detail default query returns national_id_masked & account_number_masked, redacts national_id/phone/account_number/general_note
  const detailDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_profile_detail",
        filters: [
          {
            field: "entry_id",
            op: "eq",
            value: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(detailDefaultBody.rows[0].national_id_masked, "••••••••2345");
  assert.equal(detailDefaultBody.rows[0].account_number_masked, "••••••••8776");
  assert.equal(detailDefaultBody.rows[0].document_count, 2);
  assert.equal("national_id" in detailDefaultBody.rows[0], false);
  assert.equal("phone" in detailDefaultBody.rows[0], false);
  assert.equal("account_number" in detailDefaultBody.rows[0], false);
  assert.equal("general_note" in detailDefaultBody.rows[0], false);

  const detailExplicitBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_profile_detail",
        fields: ["employee_code", "national_id_masked", "national_id"],
        filters: [
          {
            field: "entry_id",
            op: "eq",
            value: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(detailExplicitBody.rows[0].national_id, "001200012345");

  // 5. Duplicate CCCD returns canonical_cccd_masked (••••••••2345)
  const dupDefaultBody = await (
    await handleN8nBodQueryPost(
      makeQueryRequest({ dataset: "workers_duplicate_cccd" }),
      { env: TEST_ENV, dispatcherDeps },
    )
  ).json();
  assert.equal(dupDefaultBody.rows[0].canonical_cccd_masked, "••••••••2345");
});

test("Vendor finance datasets preserve strict sub-ledger grain (Project + Accountant) and never cross-net accountants", async () => {
  const ACCOUNTANT_A = "aaaa1111-1111-4111-8111-111111111111";
  const ACCOUNTANT_B = "bbbb2222-2222-4222-8222-222222222222";

  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    vendorFinanceRepo: {
      getMonthlyReport: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          allowed_actions: { can_view: true, can_record: false },
          filters: {
            month: "2026-10",
            project_id: null,
            accountant_ref: null,
            vendor_id: null,
          },
          totals: {
            vendor_count: 1,
            sub_ledger_count: 2,
            legacy_unallocated_vendor_count: 0,
            balance_before_month_minor: "0",
            opening_payable_in_month_minor: "0",
            opening_advance_in_month_minor: "0",
            obligations_in_month_minor: "50000000",
            paid_in_month_minor: "0",
            advanced_in_month_minor: "20000000",
            paid_and_advanced_in_month_minor: "20000000",
            net_change_in_month_minor: "30000000",
            closing_balance_minor: "30000000",
            closing_payable_minor: "50000000",
            closing_advance_minor: "20000000",
            current_balance_minor: "30000000",
          },
          // Accountant A has +50M payable on Vendor 1; Accountant B has -20M advance on Vendor 1
          project_accountant_summaries: [
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_A,
              responsible_accountant_display_name: "Kế toán A",
              is_currently_assigned: true,
              vendor_count: 1,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "50000000",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "0",
              paid_and_advanced_in_month_minor: "0",
              net_change_in_month_minor: "50000000",
              closing_balance_minor: "50000000",
              closing_payable_minor: "50000000",
              closing_advance_minor: "0",
              current_balance_minor: "50000000",
            },
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_B,
              responsible_accountant_display_name: "Kế toán B",
              is_currently_assigned: true,
              vendor_count: 1,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "0",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "20000000",
              paid_and_advanced_in_month_minor: "20000000",
              net_change_in_month_minor: "-20000000",
              closing_balance_minor: "-20000000",
              closing_payable_minor: "0",
              closing_advance_minor: "20000000",
              current_balance_minor: "-20000000",
            },
          ],
          legacy_unallocated_rows: [],
          rows: [
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_A,
              responsible_accountant_display_name: "Kế toán A",
              is_currently_assigned: true,
              vendor_id: "vendor-alpha",
              vendor_display_name: "Vendor Alpha",
              vendor_active: true,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "50000000",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "0",
              paid_and_advanced_in_month_minor: "0",
              net_change_in_month_minor: "50000000",
              closing_balance_minor: "50000000",
              closing_direction: "PAYABLE",
              closing_payable_minor: "50000000",
              closing_advance_minor: "0",
              current_balance_minor: "50000000",
              in_month_entry_count: 1,
              total_entry_count: 1,
            },
            {
              project_id: "proj-lux",
              project_display_name: "Dự án Luxshare",
              project_active: true,
              accountant_ref: ACCOUNTANT_B,
              responsible_accountant_display_name: "Kế toán B",
              is_currently_assigned: true,
              vendor_id: "vendor-alpha",
              vendor_display_name: "Vendor Alpha",
              vendor_active: true,
              balance_before_month_minor: "0",
              opening_payable_in_month_minor: "0",
              opening_advance_in_month_minor: "0",
              obligations_in_month_minor: "0",
              paid_in_month_minor: "0",
              advanced_in_month_minor: "20000000",
              paid_and_advanced_in_month_minor: "20000000",
              net_change_in_month_minor: "-20000000",
              closing_balance_minor: "-20000000",
              closing_direction: "ADVANCE",
              closing_payable_minor: "0",
              closing_advance_minor: "20000000",
              current_balance_minor: "-20000000",
              in_month_entry_count: 1,
              total_entry_count: 1,
            },
          ],
        },
      }),
      listVendors: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          allowed_actions: { can_view: true, can_record: false },
          filters: {
            search: null,
            active: "all",
            balance_filter: "all",
            project_id: null,
            accountant_ref: null,
            ledger_scope: null,
          },
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          summary: {
            vendor_count: 1,
            sub_ledger_count: 2,
            payable_vendor_count: 1,
            advance_vendor_count: 1,
            uninitialized_vendor_count: 0,
            legacy_unallocated_vendor_count: 0,
            total_payable_minor: "50000000",
            total_advance_minor: "20000000",
          },
          vendors: [
            {
              vendor_id: "vendor-alpha",
              display_name: "Vendor Alpha",
              active: true,
              current_balance_minor: "30000000",
              balance_direction: "PAYABLE",
              payable_minor: "50000000",
              advance_minor: "20000000",
              entry_count: 2,
              has_opening_entry: true,
              eligible_for_opening: false,
              last_effective_date: "2026-10-20",
              last_entry_at: "2026-10-20T10:00:00Z",
              last_reconciled_as_of_date: null,
              last_reconciled_at: null,
              sub_ledger_count: 2,
              legacy_unallocated_balance_minor: "0",
              legacy_unallocated_entry_count: 0,
              sub_ledgers: [
                {
                  ledger_scope: "PROJECT_ACCOUNTANT",
                  project_id: "proj-lux",
                  project_display_name: "Dự án Luxshare",
                  accountant_ref: ACCOUNTANT_A,
                  responsible_accountant_display_name: "Kế toán A",
                  current_balance_minor: "50000000",
                  balance_direction: "PAYABLE",
                  entry_count: 1,
                  has_opening_entry: true,
                  eligible_for_opening: false,
                  last_reconciled_as_of_date: null,
                },
                {
                  ledger_scope: "PROJECT_ACCOUNTANT",
                  project_id: "proj-lux",
                  project_display_name: "Dự án Luxshare",
                  accountant_ref: ACCOUNTANT_B,
                  responsible_accountant_display_name: "Kế toán B",
                  current_balance_minor: "-20000000",
                  balance_direction: "ADVANCE",
                  entry_count: 1,
                  has_opening_entry: true,
                  eligible_for_opening: false,
                  last_reconciled_as_of_date: null,
                },
              ],
            },
          ],
        },
      }),
    },
  };

  // 1. Monthly report preserves both sub-ledgers separately and does not net Accountant A and B
  const monthlyRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "vendor_finance_monthly_report",
      filters: [{ field: "month", op: "eq", value: "2026-10" }],
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(monthlyRes.status, 200);
  const monthlyBody = await monthlyRes.json();
  assert.equal(monthlyBody.rows.length, 2);
  assert.equal(
    monthlyBody.summary.subledger_policy,
    "STRICT_PROJECT_ACCOUNTANT_SUBLEDGER_NO_CROSS_ACCOUNTANT_NETTING",
  );
  assert.equal(monthlyBody.summary.project_accountant_summaries.length, 2);
  assert.equal(
    monthlyBody.summary.project_accountant_summaries[0].closing_payable_minor,
    "50000000",
  );
  assert.equal(
    monthlyBody.summary.project_accountant_summaries[1].closing_advance_minor,
    "20000000",
  );

  // 2. Subledgers dataset projects each (project, accountant, vendor) sub-ledger without global net_balance_minor
  const subledgersRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "vendor_finance_subledgers",
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(subledgersRes.status, 200);
  const subledgersBody = await subledgersRes.json();
  assert.equal(subledgersBody.rows.length, 2);
  assert.equal(subledgersBody.summary.by_project_accountant.length, 2);
  assert.equal("net_balance_minor" in subledgersBody.summary, false);
});

test("Cursor pagination and multi-query cross-domain workflow work end-to-end", async () => {
  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    projectAdminRepo: {
      listProjects: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          projects: [
            {
              project_id: "proj-1",
              display_name: "Dự án Bắc Ninh 1",
              active: true,
              version: 1,
              active_assignment_count: 1,
              revision_count: 1,
              updated_at: "2026-10-25T00:00:00Z",
              updated_by_user_id: null,
            },
            {
              project_id: "proj-2",
              display_name: "Dự án Bắc Giang 2",
              active: true,
              version: 1,
              active_assignment_count: 0,
              revision_count: 1,
              updated_at: "2026-10-25T00:00:00Z",
              updated_by_user_id: null,
            },
          ],
        },
      }),
    },
  };

  // Page 1 with page_size = 1
  const page1Res = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
      page_size: 1,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(page1Res.status, 200);
  const page1Body = await page1Res.json();
  assert.equal(page1Body.rows.length, 1);
  assert.equal(page1Body.rows[0].project_id, "proj-1");
  assert.equal(page1Body.pagination.has_more, true);
  assert.ok(page1Body.pagination.next_cursor);

  // Page 2 using next_cursor
  const page2Res = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
      page_size: 1,
      cursor: page1Body.pagination.next_cursor,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(page2Res.status, 200);
  const page2Body = await page2Res.json();
  assert.equal(page2Body.rows.length, 1);
  assert.equal(page2Body.rows[0].project_id, "proj-2");
  assert.equal(page2Body.pagination.has_more, false);
  assert.equal(page2Body.pagination.next_cursor, null);

  // Replaying cursor from catalog_projects on catalog_teams must fail with INVALID_CURSOR
  const crossCursorRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_teams",
      cursor: page1Body.pagination.next_cursor,
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(crossCursorRes.status, 400);
  const crossCursorBody = await crossCursorRes.json();
  assert.equal(crossCursorBody.error.code, "INVALID_CURSOR");
});

test("Response byte-limit truncation (1 MiB) preserves lossless cursor continuation across offset, page, and token strategies and bounds single huge rows", async () => {
  // Each row carries ~420 KiB so at most 2 rows (~840 KiB) fit inside 1 MiB (1,048,576 bytes),
  // whereas 3 rows (~1.26 MiB) exceed 1 MiB and trigger truncation.
  const largeBlob = "X".repeat(420 * 1024);

  const allProjects = Array.from({ length: 5 }, (_, idx) => ({
    project_id: `proj-${idx + 1}`,
    display_name: `Project ${idx + 1} ${largeBlob}`,
    active: true,
    version: 1,
    active_assignment_count: 1,
    revision_count: 1,
    updated_at: "2026-10-25T00:00:00Z",
    updated_by_user_id: null,
  }));

  const allTeams = Array.from({ length: 6 }, (_, idx) => ({
    team_id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
    code: `TEAM_${idx + 1}`,
    display_name: `Team ${idx + 1} ${largeBlob}`,
    active: true,
    version: 1,
    revision_count: 1,
  }));

  const allWorkers = Array.from({ length: 5 }, (_, idx) => ({
    entry_id: `10000000-0000-4000-8000-00000000000${idx + 1}`,
    entry_version: 1,
    submission_state: "SUBMITTED",
    employee_code: `EMP_${idx + 1}`,
    display_name: `Worker ${idx + 1} ${largeBlob}`,
    project_id: "proj-1",
    project_display: "Dự án 1",
    first_work_date: "2026-10-20",
    labor_type: "chinh_thuc",
    labor_type_display: "Chính thức",
    employment_status: "ON",
    recruiter_id: "44444444-4444-4444-8444-444444444444",
    recruiter_display: "Recruiter 1",
    payment: null,
  }));

  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    projectAdminRepo: {
      listProjects: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          projects: allProjects,
        },
      }),
    },
    teamCatalogRepo: {
      listTeams: async ({ page, page_size }) => {
        const start = (page - 1) * page_size;
        const slice = allTeams.slice(start, start + page_size);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-25",
            page,
            page_size,
            total: allTeams.length,
            teams: slice,
          },
        };
      },
    },
    workerDirectoryRepo: {
      listWorkers: async ({ cursor, page_size }) => {
        const startIdx = cursor ? Number.parseInt(cursor, 10) : 0;
        const slice = allWorkers.slice(startIdx, startIdx + page_size);
        const nextIdx = startIdx + slice.length;
        const hasMore = nextIdx < allWorkers.length;
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-25",
            scope: "all",
            page_size,
            has_more: hasMore,
            next_cursor: hasMore ? String(nextIdx) : null,
            summary: {
              total_workers: allWorkers.length,
              on_count: allWorkers.length,
              off_count: 0,
              unconfirmed_count: 0,
            },
            items: slice,
          },
        };
      },
    },
  };

  // 1. Offset strategy (catalog_projects): requesting page_size = 5 must truncate each response <= 1 MiB
  // and walk through all 5 projects without losing or duplicating any row.
  const collectedProjectIds = [];
  let cursor = null;
  let guard = 0;
  do {
    guard += 1;
    assert.ok(guard <= 10, "Pagination loop guard exceeded for catalog_projects");
    const res = await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "catalog_projects",
        page_size: 5,
        ...(cursor ? { cursor } : {}),
      }),
      { env: TEST_ENV, dispatcherDeps },
    );
    assert.equal(res.status, 200);
    const rawJson = await res.text();
    assert.ok(
      Buffer.byteLength(rawJson, "utf8") <= MAX_N8N_RESPONSE_BYTES,
      `Response JSON exceeded 1 MiB: ${Buffer.byteLength(rawJson, "utf8")}`,
    );
    const body = JSON.parse(rawJson);
    for (const row of body.rows) {
      collectedProjectIds.push(row.project_id);
    }
    cursor = body.pagination.has_more ? body.pagination.next_cursor : null;
  } while (cursor);

  assert.deepEqual(collectedProjectIds, [
    "proj-1",
    "proj-2",
    "proj-3",
    "proj-4",
    "proj-5",
  ]);

  // 2. Page cursor strategy (catalog_teams): backend page_size = 3 (2 backend pages of 3 rows = 6 rows).
  // Truncation cuts each 3-row backend page into [2 rows] + [1 row], never skipping the 3rd row of page 1!
  const collectedTeamCodes = [];
  cursor = null;
  guard = 0;
  do {
    guard += 1;
    assert.ok(guard <= 10, "Pagination loop guard exceeded for catalog_teams");
    const res = await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "catalog_teams",
        page_size: 3,
        ...(cursor ? { cursor } : {}),
      }),
      { env: TEST_ENV, dispatcherDeps },
    );
    assert.equal(res.status, 200);
    const rawJson = await res.text();
    assert.ok(Buffer.byteLength(rawJson, "utf8") <= MAX_N8N_RESPONSE_BYTES);
    const body = JSON.parse(rawJson);
    for (const row of body.rows) {
      collectedTeamCodes.push(row.code);
    }
    cursor = body.pagination.has_more ? body.pagination.next_cursor : null;
  } while (cursor);

  assert.deepEqual(collectedTeamCodes, [
    "TEAM_1",
    "TEAM_2",
    "TEAM_3",
    "TEAM_4",
    "TEAM_5",
    "TEAM_6",
  ]);

  // 3. Keyset token cursor strategy (workers_directory): backend page_size = 3 across 5 workers.
  // Truncation on initial batch (token = null) and subsequent token batch must never skip cut rows!
  const collectedEmployeeCodes = [];
  cursor = null;
  guard = 0;
  do {
    guard += 1;
    assert.ok(guard <= 10, "Pagination loop guard exceeded for workers_directory");
    const res = await handleN8nBodQueryPost(
      makeQueryRequest({
        dataset: "workers_directory",
        page_size: 3,
        ...(cursor ? { cursor } : {}),
      }),
      { env: TEST_ENV, dispatcherDeps },
    );
    assert.equal(res.status, 200);
    const rawJson = await res.text();
    assert.ok(Buffer.byteLength(rawJson, "utf8") <= MAX_N8N_RESPONSE_BYTES);
    const body = JSON.parse(rawJson);
    for (const row of body.rows) {
      collectedEmployeeCodes.push(row.employee_code);
    }
    cursor = body.pagination.has_more ? body.pagination.next_cursor : null;
  } while (cursor);

  assert.deepEqual(collectedEmployeeCodes, [
    "EMP_1",
    "EMP_2",
    "EMP_3",
    "EMP_4",
    "EMP_5",
  ]);

  // 4. Single huge row (> 1 MiB) must NOT return a > 1 MiB payload; must fail closed with 413 RESPONSE_TOO_LARGE <= 1 MiB.
  const hugeRowDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    projectAdminRepo: {
      listProjects: async () => ({
        ok: true,
        data: {
          authorization_date: "2026-10-25",
          projects: [
            {
              project_id: "proj-huge",
              display_name: "H".repeat(MAX_N8N_RESPONSE_BYTES + 10000),
              active: true,
              version: 1,
              active_assignment_count: 1,
              revision_count: 1,
              updated_at: "2026-10-25T00:00:00Z",
              updated_by_user_id: null,
            },
          ],
        },
      }),
    },
  };

  const hugeRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
      page_size: 1,
    }),
    { env: TEST_ENV, dispatcherDeps: hugeRowDeps },
  );
  assert.equal(hugeRes.status, 413);
  const hugeRawJson = await hugeRes.text();
  assert.ok(Buffer.byteLength(hugeRawJson, "utf8") <= MAX_N8N_RESPONSE_BYTES);
  const hugeBody = JSON.parse(hugeRawJson);
  assert.equal(hugeBody.ok, false);
  assert.equal(hugeBody.error.code, "RESPONSE_TOO_LARGE");
});

test("Query timeout aborts in-flight DB/PostgREST fetch via AbortSignal and returns HTTP 504", async () => {
  let adapterSignalAborted = false;
  let fetchSignalAborted = false;

  const abortAwareFetch = createAbortAwareFetch(undefined, (_input, init) => {
    return new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (sig?.aborted) {
        fetchSignalAborted = true;
        reject(sig.reason ?? new Error("Aborted"));
        return;
      }
      sig?.addEventListener(
        "abort",
        () => {
          fetchSignalAborted = true;
          reject(sig.reason ?? new Error("Aborted"));
        },
        { once: true },
      );
    });
  });

  const dispatcherDeps = {
    timeoutMs: 30,
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    customAdapters: {
      catalog_projects: async (_spec, context) => {
        context.signal?.addEventListener(
          "abort",
          () => {
            adapterSignalAborted = true;
          },
          { once: true },
        );
        // Simulate an in-flight PostgREST fetch using the active Supabase abort signal context
        await abortAwareFetch("https://supabase.internal/rest/v1/rpc/direct_entry_list_projects_admin");
        return {
          ok: true,
          data: {
            as_of_date: "2026-10-25",
            date_range: { from: null, to: null },
            summary: { total_projects: 0 },
            rows: [],
            has_more: false,
            next_cursor: null,
            total_matching: 0,
          },
        };
      },
    },
  };

  const res = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "catalog_projects",
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "QUERY_TIMEOUT");
  assert.equal(adapterSignalAborted, true, "Adapter AbortSignal must be aborted on timeout");
  assert.equal(fetchSignalAborted, true, "In-flight PostgREST fetch must be aborted on timeout");

  // Also verify runWithSupabaseAbortSignal directly propagates abort to createAbortAwareFetch
  const manualController = new AbortController();
  let directFetchAborted = false;
  const directPromise = runWithSupabaseAbortSignal(manualController.signal, () =>
    abortAwareFetch("https://supabase.internal/rest/v1/rpc/test").catch(() => {
      directFetchAborted = manualController.signal.aborted;
    }),
  );
  manualController.abort();
  await directPromise;
  assert.equal(directFetchAborted, true);
});

test("Work Reports domain datasets (templates, assignments, submissions, analytics) work end-to-end", async () => {
  const TEMPLATE_ID = "11111111-2222-4333-8444-555555555555";
  const VERSION_ID = "22222222-3333-4444-8555-666666666666";
  const ASSIGNMENT_ID = "33333333-4444-4555-8666-777777777777";
  const TEAM_ID = "44444444-5555-4666-8777-888888888888";
  const ASSIGNEE_ID = "55555555-6666-4777-8888-999999999999";

  const dispatcherDeps = {
    resolveActor: async () => ({ ok: true, actor: TEST_ACTOR }),
    workReportTemplateRepo: {
      list: async () => ({
        ok: true,
        data: [
          {
            template_id: TEMPLATE_ID,
            template_code: "DAILY_RECRUITMENT",
            display_name: "Báo cáo Tuyển dụng Hàng ngày",
            description: "Mẫu báo cáo tiến độ tuyển dụng ngày",
            default_frequency: "DAILY",
            status: "ACTIVE",
            current_published_version_id: VERSION_ID,
            draft_version_id: null,
            version: 1,
            updated_at: "2026-10-25T08:00:00Z",
          },
        ],
      }),
    },
    workReportAssignmentRepo: {
      listAssignments: async () => ({
        ok: true,
        data: [
          {
            assignment_id: ASSIGNMENT_ID,
            template_id: TEMPLATE_ID,
            template_code: "DAILY_RECRUITMENT",
            template_name: "Báo cáo Tuyển dụng Hàng ngày",
            target_kind: "TEAM",
            target_group_id: null,
            target_label: "Nhóm Tuyển dụng Miền Bắc",
            target_member_count: 5,
            frequency: "DAILY",
            is_mandatory: true,
            due_day_offset: 0,
            due_time_local: "17:30",
            exclude_sundays: true,
            effective_from: "2026-10-01",
            effective_to: null,
            state: "ACTIVE",
            version: 1,
            created_at: "2026-10-01T00:00:00Z",
            obligation_total: 10,
            submitted_count: 8,
            not_started_count: 1,
            draft_count: 0,
            overdue_count: 1,
            rejected_count: 0,
            exempted_count: 0,
            cancelled_count: 0,
          },
        ],
      }),
      getAssignmentDetail: async () => ({
        ok: true,
        data: {
          assignment_id: ASSIGNMENT_ID,
          assignee_progress: [
            {
              obligation_id: "66666666-7777-4888-8999-000000000001",
              assignee_app_user_id: ASSIGNEE_ID,
              assignee_display_name: "Nguyễn Văn Tuyển",
              period_key: "2026-10-25",
              period_start_date: "2026-10-25",
              period_end_date: "2026-10-25",
              due_at: "2026-10-25T10:30:00Z",
              reopened_until: null,
              obligation_status: "ACTIVE",
              submission_state: "COMPLETED",
              is_overdue: false,
              submitted_at: "2026-10-25T09:00:00Z",
              version: 1,
            },
          ],
          audit_history: [],
        },
      }),
    },
    workReportReaderRepo: {
      listReadable: async () => ({
        ok: true,
        data: {
          effective_scope: { kind: "all", label: "Toàn miền" },
          filter_options: { templates: [], teams: [], assignees: [] },
          items: [
            {
              obligation_id: "66666666-7777-4888-8999-000000000001",
              submission_id: "77777777-8888-4999-8000-000000000002",
              template_id: TEMPLATE_ID,
              template_name: "Báo cáo Tuyển dụng Hàng ngày",
              template_version_id: VERSION_ID,
              template_version_no: 1,
              assignee_app_user_id: ASSIGNEE_ID,
              assignee_display_name: "Nguyễn Văn Tuyển",
              team_id: TEAM_ID,
              team_display_name: "Nhóm Tuyển dụng Miền Bắc",
              period_key: "2026-10-25",
              period_start_date: "2026-10-25",
              period_end_date: "2026-10-25",
              state: "COMPLETED",
              latest_submitted_at: "2026-10-25T09:00:00Z",
              is_late: false,
              has_post_deadline_amendment: false,
              current_revision_no: 1,
            },
          ],
          next_cursor: null,
          has_more: false,
        },
      }),
    },
    workReportAnalyticsRepo: {
      overview: async () => ({
        ok: true,
        data: {
          as_of: "2026-10-25T10:00:00Z",
          effective_scope: { kind: "all", label: "Toàn miền" },
          compliance: {
            due_count: 10,
            completed_count: 8,
            on_time_count: 7,
            late_submitted_count: 1,
            pending_due_count: 1,
            overdue_missing_count: 1,
            exempted_count: 0,
            pending_review_count: 0,
            completion_rate: 80,
          },
          metrics: [
            {
              metric_key: "calls_made",
              label: "Số cuộc gọi tư vấn",
              unit: "cuộc gọi",
              compatible_group: "outreach",
              sum_value: 150,
              avg_value: 18.75,
              min_value: 10,
              max_value: 30,
              count_valid: 8,
              missing_value_count: 0,
            },
          ],
          ratios: [],
        },
      }),
      breakdown: async () => ({
        ok: true,
        data: {
          as_of: "2026-10-25T10:00:00Z",
          effective_scope: { kind: "all", label: "Toàn miền" },
          group_by: "team",
          page: 1,
          page_size: 50,
          total_groups: 1,
          items: [
            {
              group_id: TEAM_ID,
              group_label: "Nhóm Tuyển dụng Miền Bắc",
              due_count: 10,
              completed_count: 8,
              on_time_count: 7,
              late_submitted_count: 1,
              pending_due_count: 1,
              overdue_missing_count: 1,
              exempted_count: 0,
              pending_review_count: 0,
              completion_rate: 80,
              metrics: [],
            },
          ],
        },
      }),
    },
  };

  // 1. work_reports_templates
  const tplRes = await handleN8nBodQueryPost(
    makeQueryRequest({ dataset: "work_reports_templates" }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(tplRes.status, 200);
  const tplBody = await tplRes.json();
  assert.equal(tplBody.rows.length, 1);
  assert.equal(tplBody.rows[0].template_code, "DAILY_RECRUITMENT");
  assert.equal(tplBody.summary.active_templates, 1);

  // 2. work_reports_assignments with assignment_id detail drill-down
  const assignRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_assignments",
      filters: [{ field: "assignment_id", op: "eq", value: ASSIGNMENT_ID }],
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(assignRes.status, 200);
  const assignBody = await assignRes.json();
  assert.equal(assignBody.rows.length, 1);
  assert.equal(assignBody.rows[0].obligation_total, 10);
  assert.equal(assignBody.rows[0].assignee_progress.length, 1);

  // 3. work_reports_submissions
  const subRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_submissions",
      date_range: { from: "2026-10-01", to: "2026-10-25" },
      filters: [{ field: "template_id", op: "eq", value: TEMPLATE_ID }],
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(subRes.status, 200);
  const subBody = await subRes.json();
  assert.equal(subBody.rows.length, 1);
  assert.equal(subBody.rows[0].assignee_display_name, "Nguyễn Văn Tuyển");

  // 4. work_reports_assignments fails closed when getAssignmentDetail returns an error
  const failingAssignDeps = {
    ...dispatcherDeps,
    workReportAssignmentRepo: {
      ...dispatcherDeps.workReportAssignmentRepo,
      getAssignmentDetail: async () => ({
        ok: false,
        kind: "unavailable",
      }),
    },
  };
  const assignFailRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_assignments",
      filters: [{ field: "assignment_id", op: "eq", value: ASSIGNMENT_ID }],
    }),
    { env: TEST_ENV, dispatcherDeps: failingAssignDeps },
  );
  assert.equal(assignFailRes.status, 503);
  const assignFailBody = await assignFailRes.json();
  assert.equal(assignFailBody.ok, false);
  assert.equal(
    assignFailBody.error.code,
    "WORK_REPORT_ASSIGNMENT_DETAIL_UNAVAILABLE",
  );

  // 5. work_reports_submission_detail reads single-submission answers (redacting free_text by default, returning when requested, never leaking draft_payload_json)
  const OBLIGATION_ID = "66666666-7777-4888-8999-000000000001";
  const SUBMISSION_ID = "77777777-8888-4999-8000-000000000002";
  const detailDeps = {
    ...dispatcherDeps,
    workReportSubmissionRepo: {
      get: async ({ obligation_id }) => ({
        ok: true,
        data: {
          obligation: {
            obligation_id,
            template_id: TEMPLATE_ID,
            assignee_app_user_id: ASSIGNEE_ID,
            snapshot_team_id: TEAM_ID,
            snapshot_team_code: "TEAM_NORTH",
            snapshot_team_display_name: "Nhóm Tuyển dụng Miền Bắc",
            period_key: "2026-10-25",
            period_start_date: "2026-10-25",
            period_end_date: "2026-10-25",
            due_at: "2026-10-25T10:30:00Z",
            obligation_status: "ACTIVE",
            reopened_until: null,
            is_overdue: false,
            version: 1,
          },
          template: {
            template_code: "DAILY_RECRUITMENT",
            display_name: "Báo cáo Tuyển dụng Hàng ngày",
            schema_json: {
              sections: [
                {
                  key: "outreach",
                  title: "Tiếp cận ứng viên",
                  fields: [
                    { key: "calls_made", label: "Số cuộc gọi", type: "number" },
                    { key: "blockers", label: "Khó khăn trong ngày", type: "textarea" },
                  ],
                },
              ],
            },
          },
          submission: {
            submission_id: SUBMISSION_ID,
            state: "APPROVED",
            draft_payload_json: { calls_made: 999, blockers: "Bản nháp chưa nộp không được lộ" },
            first_submitted_at: "2026-10-25T08:30:00Z",
            latest_submitted_at: "2026-10-25T09:00:00Z",
            is_late: false,
            has_post_deadline_amendment: false,
            current_revision_id: "88888888-9999-4000-8111-000000000003",
            version: 2,
          },
          latest_review_event: {
            decision: "APPROVED",
            reason: "Số liệu khớp CRM",
            reviewed_at: "2026-10-25T09:30:00Z",
          },
          revisions: [
            {
              revision_id: "88888888-9999-4000-8111-000000000002",
              revision_no: 1,
              payload_json: { calls_made: 20, blockers: "Không" },
              created_at: "2026-10-25T08:30:00Z",
            },
            {
              revision_id: "88888888-9999-4000-8111-000000000003",
              revision_no: 2,
              payload_json: { calls_made: 25, blockers: "Thiếu data khu vực Bắc Ninh" },
              created_at: "2026-10-25T09:00:00Z",
            },
          ],
        },
      }),
    },
  };

  // 5a. Missing obligation_id filter is rejected with 400 MISSING_REQUIRED_FILTER,
  // and filtering by submission_id is rejected with 400 UNKNOWN_FILTER_FIELD (only obligation_id is accepted)
  const detailMissingFilterRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_submission_detail",
    }),
    { env: TEST_ENV, dispatcherDeps: detailDeps },
  );
  assert.equal(detailMissingFilterRes.status, 400);
  const detailMissingFilterBody = await detailMissingFilterRes.json();
  assert.equal(detailMissingFilterBody.error.code, "MISSING_REQUIRED_FILTER");

  const detailBySubmissionIdRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_submission_detail",
      filters: [{ field: "submission_id", op: "eq", value: SUBMISSION_ID }],
    }),
    { env: TEST_ENV, dispatcherDeps: detailDeps },
  );
  assert.equal(detailBySubmissionIdRes.status, 400);
  const detailBySubmissionIdBody = await detailBySubmissionIdRes.json();
  assert.equal(detailBySubmissionIdBody.error.code, "UNKNOWN_FILTER_FIELD");

  // 5b. Default fields return metadata + template_schema_json while redacting free_text payload fields
  const detailDefaultRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_submission_detail",
      filters: [{ field: "obligation_id", op: "eq", value: OBLIGATION_ID }],
    }),
    { env: TEST_ENV, dispatcherDeps: detailDeps },
  );
  assert.equal(detailDefaultRes.status, 200);
  const detailDefaultBody = await detailDefaultRes.json();
  assert.equal(detailDefaultBody.rows.length, 1);
  assert.equal(detailDefaultBody.rows[0].obligation_id, OBLIGATION_ID);
  assert.equal(detailDefaultBody.rows[0].submission_state, "APPROVED");
  assert.equal(detailDefaultBody.rows[0].revision_count, 2);
  assert.ok(detailDefaultBody.rows[0].template_schema_json);
  assert.equal("latest_payload_json" in detailDefaultBody.rows[0], false);
  assert.equal("revisions" in detailDefaultBody.rows[0], false);
  assert.equal("latest_review_event" in detailDefaultBody.rows[0], false);
  assert.equal("draft_payload_json" in detailDefaultBody.rows[0], false);

  // 5c. Explicit fields return latest_payload_json, revisions, and latest_review_event
  const detailFullRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_submission_detail",
      filters: [{ field: "obligation_id", op: "eq", value: OBLIGATION_ID }],
      fields: [
        "obligation_id",
        "submission_id",
        "latest_payload_json",
        "revisions",
        "latest_review_event",
      ],
    }),
    { env: TEST_ENV, dispatcherDeps: detailDeps },
  );
  assert.equal(detailFullRes.status, 200);
  const detailFullBody = await detailFullRes.json();
  assert.equal(detailFullBody.rows.length, 1);
  assert.deepEqual(detailFullBody.rows[0].latest_payload_json, {
    calls_made: 25,
    blockers: "Thiếu data khu vực Bắc Ninh",
  });
  assert.equal(detailFullBody.rows[0].revisions.length, 2);
  assert.equal(detailFullBody.rows[0].revisions[0].revision_no, 2);
  assert.equal(detailFullBody.rows[0].latest_review_event.decision, "APPROVED");
  assert.equal("draft_payload_json" in detailFullBody.rows[0], false);

  // 6. work_reports_analytics
  const anaRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "work_reports_analytics",
      date_range: { from: "2026-10-01", to: "2026-10-25" },
      filters: [
        { field: "template_id", op: "eq", value: TEMPLATE_ID },
        { field: "group_by", op: "eq", value: "team" },
      ],
    }),
    { env: TEST_ENV, dispatcherDeps },
  );
  assert.equal(anaRes.status, 200);
  const anaBody = await anaRes.json();
  assert.equal(anaBody.summary.completion_rate, 80);
  assert.equal(anaBody.summary.metrics[0].sum_value, 150);
  assert.equal(anaBody.rows.length, 1);
  assert.equal(anaBody.rows[0].group_label, "Nhóm Tuyển dụng Miền Bắc");
});

test("T1A-9: n8n workers_directory (scope=all) succeeds with entry_admin/change_review and returns HTTP 403 WORKER_DIRECTORY_DENIED when capability or RPC permission is lacking", async () => {
  const WORKER_ID = "11111111-2222-4333-8444-555555555555";
  const RECRUITER_ID = "22222222-3333-4444-8555-666666666666";

  // 1. Principal with all_scope_grants + change_review capability succeeds on workers_directory (scope: "all")
  let listWorkersCalls = [];
  const allowedDeps = {
    resolveActor: async () => ({
      ok: true,
      actor: TEST_ACTOR,
      capabilities: ["change_review", "report_view"],
    }),
    workerDirectoryRepo: {
      listWorkers: async (query) => {
        listWorkersCalls.push(query);
        return {
          ok: true,
          data: {
            items: [
              {
                entry_id: WORKER_ID,
                entry_version: 1,
                submission_state: "SUBMITTED",
                employee_code: "hrp-2026-000101",
                display_name: "Nguyễn Văn A",
                project_id: "proj_1",
                project_display: "Dự án 1",
                first_work_date: "2026-10-01",
                labor_type: "TEMPORARY",
                labor_type_display: "Thời vụ",
                employment_status: "ON",
                recruiter_id: RECRUITER_ID,
                recruiter_display: "Trần Thị B",
                payment: null,
                pending_request: null,
                last_decision: null,
                is_project_manager: false,
                allowed_actions: {
                  view: true,
                  view_pii: false,
                  view_payment: false,
                  propose_change: false,
                  propose_change_code: "NOT_PROJECT_MANAGER",
                  direct_edit: false,
                },
              },
            ],
            page_size: 25,
            has_more: false,
            next_cursor: null,
            authorization_date: "2026-10-25",
            summary: {
              total_workers: 1,
              project_count: 1,
              recruiter_count: 1,
            },
          },
        };
      },
    },
  };

  const okRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "workers_directory",
      page_size: 25,
    }),
    { env: TEST_ENV, dispatcherDeps: allowedDeps },
  );
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.rows.length, 1);
  assert.equal(okBody.rows[0].entry_id, WORKER_ID);
  assert.equal(listWorkersCalls.length, 1);
  assert.equal(listWorkersCalls[0].auth_subject, TEST_ACTOR.auth_subject);
  assert.equal(listWorkersCalls[0].app_user_id, TEST_ACTOR.app_user_id);
  assert.equal(listWorkersCalls[0].scope, "all");

  // 2. Principal with all_scope_grants but ONLY report_view (missing entry_admin and change_review)
  // is rejected with HTTP 403 WORKER_DIRECTORY_DENIED BEFORE calling workerDirectoryRepo.listWorkers
  let forbiddenRepoCalled = false;
  const insufficientCapDeps = {
    resolveActor: async () => ({
      ok: true,
      actor: TEST_ACTOR,
      capabilities: ["report_view"],
    }),
    workerDirectoryRepo: {
      listWorkers: async () => {
        forbiddenRepoCalled = true;
        return { ok: false, kind: "denied" };
      },
    },
  };

  const capDeniedRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "workers_directory",
      page_size: 25,
    }),
    { env: TEST_ENV, dispatcherDeps: insufficientCapDeps },
  );
  assert.equal(capDeniedRes.status, 403);
  const capDeniedBody = await capDeniedRes.json();
  assert.equal(capDeniedBody.ok, false);
  assert.equal(capDeniedBody.error.code, "WORKER_DIRECTORY_DENIED");
  assert.equal(forbiddenRepoCalled, false, "Must not invoke RPC when service actor lacks entry_admin and change_review");

  // 3. When RPC itself returns 42501 (kind: "denied"), dispatcher maps it to HTTP 403 WORKER_DIRECTORY_DENIED (not 503)
  const rpcDeniedDeps = {
    resolveActor: async () => ({
      ok: true,
      actor: TEST_ACTOR,
      capabilities: ["entry_admin"],
    }),
    workerDirectoryRepo: {
      listWorkers: async () => ({ ok: false, kind: "denied" }),
    },
  };

  const rpcDeniedRes = await handleN8nBodQueryPost(
    makeQueryRequest({
      dataset: "workers_directory",
      page_size: 25,
    }),
    { env: TEST_ENV, dispatcherDeps: rpcDeniedDeps },
  );
  assert.equal(rpcDeniedRes.status, 403);
  const rpcDeniedBody = await rpcDeniedRes.json();
  assert.equal(rpcDeniedBody.ok, false);
  assert.equal(rpcDeniedBody.error.code, "WORKER_DIRECTORY_DENIED");
});

test("WP8C-2: resolveN8nBodServiceActor derives capabilities strictly from paired ALL effective_grants without requiring legacy all_scope_grants", async () => {
  const WORKER_ID = "11111111-2222-4333-8444-555555555555";
  const RECRUITER_ID = "22222222-3333-4444-8555-666666666666";
  const TEAM_ID = "33333333-3333-4333-8333-333333333333";

  // 1. Mirror-cleared managed service actor (all_scope_grants: [], capabilities: [],
  // effective_grants: [entry_admin @ ALL]) resolves ok with ["entry_admin"] and succeeds on workers_directory
  clearN8nServiceActorCache();
  const resolveMirrorCleared = () =>
    resolveN8nBodServiceActor({
      env: TEST_ENV,
      resolveActorContextRpc: async (authSubject) => ({
        data: {
          auth_subject: authSubject,
          app_user_id: TEST_ENV.appUserId,
          enabled: true,
          capabilities: [],
          all_scope_grants: [],
          effective_grants: [
            {
              capability: "entry_admin",
              scope_kind: "ALL",
              scope_id: null,
              source_type: "ROLE_BUNDLE",
              source_id: null,
            },
          ],
        },
        error: null,
      }),
    });

  const resolvedMirrorCleared = await resolveMirrorCleared();
  assert.equal(resolvedMirrorCleared.ok, true);
  assert.deepEqual(resolvedMirrorCleared.actor, TEST_ACTOR);
  assert.deepEqual(resolvedMirrorCleared.capabilities, ["entry_admin"]);

  let listWorkersCalls = 0;
  const mirrorClearedDirRes = await handleN8nBodQueryPost(
    makeQueryRequest({ dataset: "workers_directory", page_size: 25 }),
    {
      env: TEST_ENV,
      dispatcherDeps: {
        resolveActor: resolveMirrorCleared,
        workerDirectoryRepo: {
          listWorkers: async (query) => {
            listWorkersCalls += 1;
            assert.equal(query.scope, "all");
            return {
              ok: true,
              data: {
                items: [
                  {
                    entry_id: WORKER_ID,
                    entry_version: 1,
                    submission_state: "SUBMITTED",
                    employee_code: "hrp-2026-000101",
                    display_name: "Nguyễn Văn A",
                    project_id: "proj_1",
                    project_display: "Dự án 1",
                    first_work_date: "2026-10-01",
                    labor_type: "TEMPORARY",
                    labor_type_display: "Thời vụ",
                    employment_status: "ON",
                    recruiter_id: RECRUITER_ID,
                    recruiter_display: "Trần Thị B",
                    payment: null,
                    pending_request: null,
                    last_decision: null,
                    is_project_manager: false,
                    allowed_actions: {
                      view: true,
                      view_pii: false,
                      view_payment: false,
                      propose_change: false,
                      propose_change_code: "NOT_PROJECT_MANAGER",
                      direct_edit: false,
                    },
                  },
                ],
                page_size: 25,
                has_more: false,
                next_cursor: null,
                authorization_date: "2026-10-25",
                summary: {
                  total_workers: 1,
                  project_count: 1,
                  recruiter_count: 1,
                },
              },
            };
          },
        },
      },
    },
  );
  assert.equal(mirrorClearedDirRes.status, 200);
  const mirrorClearedDirBody = await mirrorClearedDirRes.json();
  assert.equal(mirrorClearedDirBody.ok, true);
  assert.equal(mirrorClearedDirBody.rows.length, 1);
  assert.equal(listWorkersCalls, 1);

  // 2. Managed service actor with paired report_analytics_view @ ALL + stale legacy capabilities
  // ["entry_admin", "report_analytics_view"] -> returns ONLY ["report_analytics_view"]
  // and workers_directory returns 403 WORKER_DIRECTORY_DENIED without invoking RPC
  clearN8nServiceActorCache();
  const resolveAnalyticsOnly = () =>
    resolveN8nBodServiceActor({
      env: TEST_ENV,
      resolveActorContextRpc: async (authSubject) => ({
        data: {
          auth_subject: authSubject,
          app_user_id: TEST_ENV.appUserId,
          enabled: true,
          capabilities: ["entry_admin", "report_analytics_view"],
          all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
          effective_grants: [
            {
              capability: "report_analytics_view",
              scope_kind: "ALL",
              scope_id: null,
              source_type: "ROLE_BUNDLE",
              source_id: null,
            },
          ],
        },
        error: null,
      }),
    });

  const resolvedAnalyticsOnly = await resolveAnalyticsOnly();
  assert.equal(resolvedAnalyticsOnly.ok, true);
  assert.deepEqual(resolvedAnalyticsOnly.capabilities, ["report_analytics_view"]);

  let staleDirRepoCalled = false;
  const staleDirRes = await handleN8nBodQueryPost(
    makeQueryRequest({ dataset: "workers_directory", page_size: 25 }),
    {
      env: TEST_ENV,
      dispatcherDeps: {
        resolveActor: resolveAnalyticsOnly,
        workerDirectoryRepo: {
          listWorkers: async () => {
            staleDirRepoCalled = true;
            return { ok: false, kind: "denied" };
          },
        },
      },
    },
  );
  assert.equal(staleDirRes.status, 403);
  const staleDirBody = await staleDirRes.json();
  assert.equal(staleDirBody.ok, false);
  assert.equal(staleDirBody.error.code, "WORKER_DIRECTORY_DENIED");
  assert.equal(staleDirRepoCalled, false);

  // 3. Non-ALL grants (entry_admin @ OWN, report_analytics_view @ CONTEXT_TEAM) are rejected
  // even when legacy all_scope_grants and capabilities are populated
  for (const grant of [
    {
      capability: "entry_admin",
      scope_kind: "OWN",
      scope_id: null,
      source_type: "DIRECT_GRANT",
      source_id: null,
    },
    {
      capability: "report_analytics_view",
      scope_kind: "CONTEXT_TEAM",
      scope_id: TEAM_ID,
      source_type: "CONTEXTUAL_ASSIGNMENT",
      source_id: null,
    },
    {
      capability: "entry_admin",
      scope_kind: "ALL",
      scope_id: TEAM_ID,
      source_type: "DIRECT_GRANT",
      source_id: null,
    },
  ]) {
    clearN8nServiceActorCache();
    const rejected = await resolveN8nBodServiceActor({
      env: TEST_ENV,
      resolveActorContextRpc: async (authSubject) => ({
        data: {
          auth_subject: authSubject,
          app_user_id: TEST_ENV.appUserId,
          enabled: true,
          capabilities: [grant.capability],
          all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
          effective_grants: [grant],
        },
        error: null,
      }),
    });
    assert.equal(rejected.ok, false, `expected rejection for ${grant.capability}@${grant.scope_kind}`);
    assert.equal(rejected.code, "SERVICE_PRINCIPAL_ACTOR_UNAVAILABLE");
  }
});

