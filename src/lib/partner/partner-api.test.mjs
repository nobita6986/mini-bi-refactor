/**
 * Partner Accounts & Vendor Portal — API, Auth, Session, Isolation & Provisioning Suite.
 *
 * Pure ESM (`node --conditions=react-server --test src/lib/partner/partner-api.test.mjs`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getAttendanceTime } from "../attendance/attendance-api.ts";
import {
  createAuthLoginResponse,
  createAuthSessionResponse,
} from "../auth/auth-session-core.ts";
import { createChangePasswordResponse } from "../auth/change-password-core.ts";
import { resolveActor } from "../auth/direct-entry-v2.ts";
import {
  handleAdminBulletinList,
  handleBulletinMobileFeed,
} from "../bulletins/api.ts";
import { createDirectEntrySessionResponse } from "../direct-entry/session-bootstrap.ts";
import {
  handleGetApprovalInbox,
  handleGetMyLeaveSummary,
} from "../leave/leave-api.ts";
import {
  handleRecruitmentPostContext,
  handleRecruitmentPostList,
} from "../recruitment-posts/api.ts";
import {
  handleGetSalaryAdvanceContext,
  handleGetSalaryAdvanceRequests,
} from "../salary-advance/salary-advance-api.ts";
import {
  handleGetProjectAccountantsAdmin,
  handleGetVendorFinanceContext,
  handleGetVendorFinanceVendors,
} from "../vendor-finance/vendor-finance-api.ts";
import { listMyWorkReportObligations } from "../work-reports/submission-api.ts";
import {
  handleActivatePartner,
  handleAdminPartnerConflicts,
  handleAdminProvisionPartner,
  handleAdminResetPartnerPassword,
  handleAdminRotatePartnerActivationCode,
  handleGetPartnerProfile,
  handleGetPartnerRecruitmentSummary,
  handleGetPartnerWorkers,
  handlePatchPartnerProfile,
} from "./api.ts";
import { PARTNER_INITIAL_PASSWORD } from "./provisioning.ts";

const UUID_ADMIN_AUTH = "11111111-1111-4111-8111-111111111111";
const UUID_ADMIN_APP = "22222222-2222-4222-8222-222222222222";
const UUID_VENDOR_AUTH = "33333333-3333-4333-8333-333333333333";
const UUID_VENDOR_APP = "44444444-4444-4444-8444-444444444444";
const UUID_VENDOR_PA = "55555555-5555-4555-8555-555555555555";
const UUID_CTV_AUTH = "66666666-6666-4666-8666-666666666666";
const UUID_CTV_APP = "77777777-7777-4777-8777-777777777777";
const UUID_CTV_PA = "88888888-8888-4888-8888-888888888888";
const UUID_BI_AUTH = "99999999-9999-4999-8999-999999999999";
const UUID_BI_APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_INTENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID_REV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UUID_REC = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function jsonReq(path, method = "GET", body = undefined, headers = {}) {
  const init = {
    method,
    headers: {
      Origin: "https://app.example",
      Host: "app.example",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`https://app.example${path}`, init);
}

function makePartnerRawRecord({
  auth_subject,
  app_user_id,
  partner_account_id,
  partner_kind,
  partner_id,
  canonical_code,
  display_name,
  enabled,
  partner_active,
  account_state,
  must_change_password,
  activated_at = null,
  password_changed_at = null,
}) {
  return {
    auth_subject,
    app_user_id,
    display_name,
    enabled,
    capabilities: [],
    recruiter_links: [],
    teams: [],
    team_scope_grants: [],
    all_scope_grants: [],
    effective_grants: [],
    assigned_roles: [],
    allowed_worker_tabs: [],
    partner_account: {
      partner_account_id,
      partner_kind,
      vendor_id: partner_kind === "VENDOR" ? partner_id : null,
      collaborator_id: partner_kind === "COLLABORATOR" ? partner_id : null,
      partner_id,
      partner_display_name: display_name,
      partner_active,
      canonical_code,
      username: canonical_code,
      account_state,
      activated_at,
      must_change_password,
      password_changed_at,
    },
  };
}

function makeAdminActor() {
  return {
    auth_subject: UUID_ADMIN_AUTH,
    app_user_id: UUID_ADMIN_APP,
    display_name: "System Admin",
    enabled: true,
    capabilities: ["entry_admin", "catalog_master_manage"],
    scopes: [{ kind: "all", reference: "all", valid_from: "2025-01-01", valid_to: null }],
    self_recruiter_suggestion: null,
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function makeVendorActor({ mustChangePassword = false } = {}) {
  return {
    auth_subject: UUID_VENDOR_AUTH,
    app_user_id: UUID_VENDOR_APP,
    display_name: "Vendor One",
    enabled: true,
    capabilities: [],
    scopes: [{ kind: "own", reference: UUID_VENDOR_APP, valid_from: "0001-01-01", valid_to: null }],
    self_recruiter_suggestion: null,
    partner_account: {
      partner_account_id: UUID_VENDOR_PA,
      partner_kind: "VENDOR",
      vendor_id: "V1",
      collaborator_id: null,
      partner_id: "V1",
      partner_display_name: "Vendor One",
      partner_active: true,
      canonical_code: "v1",
      username: "v1",
      account_state: mustChangePassword ? "ACTIVE_MUST_CHANGE_PASSWORD" : "ACTIVE",
      activated_at: "2026-11-28T00:00:00Z",
      must_change_password: mustChangePassword,
      password_changed_at: mustChangePassword ? null : "2026-11-28T01:00:00Z",
    },
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function makeCtvActor({ mustChangePassword = false } = {}) {
  return {
    auth_subject: UUID_CTV_AUTH,
    app_user_id: UUID_CTV_APP,
    display_name: "CTV One",
    enabled: true,
    capabilities: [],
    scopes: [{ kind: "own", reference: UUID_CTV_APP, valid_from: "0001-01-01", valid_to: null }],
    self_recruiter_suggestion: null,
    partner_account: {
      partner_account_id: UUID_CTV_PA,
      partner_kind: "COLLABORATOR",
      vendor_id: null,
      collaborator_id: "ctv1",
      partner_id: "ctv1",
      partner_display_name: "CTV One",
      partner_active: true,
      canonical_code: "ctv1",
      username: "ctv1",
      account_state: mustChangePassword ? "ACTIVE_MUST_CHANGE_PASSWORD" : "ACTIVE",
      activated_at: "2026-11-28T00:00:00Z",
      must_change_password: mustChangePassword,
      password_changed_at: mustChangePassword ? null : "2026-11-28T01:00:00Z",
    },
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function makeStubRepo(overrides = {}) {
  return {
    preflightConflicts: async () => ({
      ok: true,
      data: {
        checked_at: "2026-11-28T10:00:00Z",
        has_conflicts: false,
        conflict_count: 0,
        intra_catalog_duplicates: [],
        cross_catalog_duplicates: [],
        unregistered_catalog_rows: [],
        auth_email_collisions: [],
      },
    }),
    getPartnerAccountRef: async () => ({ ok: true, data: { app_user_id: UUID_VENDOR_APP } }),
    provisionBegin: async () => ({
      ok: true,
      data: {
        intent_id: UUID_INTENT,
        intent_token: UUID_TOKEN,
        state: "IN_FLIGHT",
        resumed: false,
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        partner_id: "V1",
        canonical_code: "v1",
        username: "v1",
        auth_email: "v1@hrpartner.vn",
        display_name: "Vendor One",
      },
    }),
    provisionFinalize: async () => ({
      ok: true,
      data: {
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        partner_id: "V1",
        canonical_code: "v1",
        username: "v1",
        app_user_id: UUID_VENDOR_APP,
        auth_subject: UUID_VENDOR_AUTH,
        account_state: "PENDING_ACTIVATION",
        activation_expires_at: "2026-12-05T10:00:00Z",
        must_change_password: true,
        version: 2,
        revision_id: UUID_REV,
        intent_id: UUID_INTENT,
      },
    }),
    rotateActivation: async () => ({
      ok: true,
      data: {
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        vendor_id: "V1",
        collaborator_id: null,
        partner_id: "V1",
        canonical_code: "v1",
        account_state: "PENDING_ACTIVATION",
        app_user_id: UUID_VENDOR_APP,
        username: "v1",
        activated_at: null,
        must_change_password: true,
        password_changed_at: null,
        activation_expires_at: "2026-12-05T10:00:00Z",
        activation_attempts: 0,
        version: 3,
      },
    }),
    activateAccount: async () => ({
      ok: true,
      data: {
        ok: true,
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        vendor_id: "V1",
        collaborator_id: null,
        partner_id: "V1",
        canonical_code: "v1",
        username: "v1",
        app_user_id: UUID_VENDOR_APP,
        auth_subject: UUID_VENDOR_AUTH,
        account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
        must_change_password: true,
        activated_at: "2026-11-28T10:00:00Z",
      },
    }),
    markPasswordChanged: async () => ({ ok: true, data: { ok: true } }),
    getProfile: async () => ({
      ok: true,
      data: {
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        partner_id: "V1",
        code: "V1",
        canonical_code: "v1",
        username: "v1",
        display_name: "Vendor One",
        address: "123 Đường A",
        phone: "0901234567",
        active: true,
        version: 1,
        account_state: "ACTIVE",
        must_change_password: false,
        activated_at: "2026-11-28T00:00:00Z",
        password_changed_at: "2026-11-28T01:00:00Z",
      },
    }),
    updateProfile: async (input) => ({
      ok: true,
      data: {
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        partner_id: "V1",
        code: "V1",
        canonical_code: "v1",
        username: "v1",
        display_name: input.display_name,
        address: input.address,
        phone: input.phone,
        active: true,
        version: input.expected_version + 1,
        account_state: "ACTIVE",
        must_change_password: false,
        activated_at: "2026-11-28T00:00:00Z",
        password_changed_at: "2026-11-28T01:00:00Z",
      },
    }),
    getVendorRecruitmentSummary: async () => ({
      ok: true,
      data: {
        vendor_id: "V1",
        vendor_name: "Vendor One",
        date_from: null,
        date_to: null,
        project_id: null,
        group_by: "month",
        total_workers: 2,
        on_count: 1,
        off_count: 1,
        unconfirmed_count: 0,
        by_project: [
          { project_id: "prj-1", project_name: "Dự án 1", total_workers: 2, on_count: 1, off_count: 1, unconfirmed_count: 0 },
        ],
        by_period: [
          { period_key: "2026-11", total_workers: 2, on_count: 1, off_count: 1, unconfirmed_count: 0 },
        ],
        available_projects: [
          { project_id: "prj-1", project_name: "Dự án 1", worker_count: 2 },
        ],
      },
    }),
    listVendorWorkers: async () => ({
      ok: true,
      data: {
        items: [
          {
            entry_id: UUID_REV,
            full_name: "Nguyễn Văn A",
            employee_code: "hrp-2026-100001",
            project_id: "prj-1",
            project_name: "Dự án 1",
            first_work_date: "2026-11-10",
            employment_status: "ON",
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
        available_projects: [{ project_id: "prj-1", project_name: "Dự án 1", worker_count: 2 }],
      },
    }),
    ...overrides,
  };
}

test("1. Login with partner code only + initial password hrp@123: pending activation -> active -> first password change -> portal unlock", async () => {
  let state = "PENDING_ACTIVATION";
  let mustChange = true;
  let signOutCalls = 0;
  let lastSignInEmail = null;

  const repository = {
    async loadByAuthSubject(authSubject) {
      if (authSubject === UUID_VENDOR_AUTH) {
        return makePartnerRawRecord({
          auth_subject: UUID_VENDOR_AUTH,
          app_user_id: UUID_VENDOR_APP,
          partner_account_id: UUID_VENDOR_PA,
          partner_kind: "VENDOR",
          partner_id: "V1",
          canonical_code: "v1",
          display_name: "Vendor One",
          enabled: state !== "PENDING_ACTIVATION" && state !== "SUSPENDED",
          partner_active: state !== "SUSPENDED",
          account_state: state,
          must_change_password: mustChange,
          activated_at: state === "PENDING_ACTIVATION" ? null : "2026-11-28T00:00:00Z",
          password_changed_at: mustChange ? null : "2026-11-28T01:00:00Z",
        });
      }
      if (authSubject === UUID_CTV_AUTH) {
        return makePartnerRawRecord({
          auth_subject: UUID_CTV_AUTH,
          app_user_id: UUID_CTV_APP,
          partner_account_id: UUID_CTV_PA,
          partner_kind: "COLLABORATOR",
          partner_id: "ctv1",
          canonical_code: "ctv1",
          display_name: "CTV One",
          enabled: true,
          partner_active: true,
          account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
          must_change_password: true,
          activated_at: "2026-11-28T00:00:00Z",
        });
      }
      return null;
    },
  };

  // 1a. Before activation -> 403 ACCOUNT_PENDING_ACTIVATION + local signOut
  const pendingRes = await createAuthLoginResponse(
    jsonReq("/api/auth/login", "POST", { email: "V1", password: PARTNER_INITIAL_PASSWORD }),
    {
      createClient: async () => ({
        auth: {
          signInWithPassword: async (input) => {
            lastSignInEmail = input.email;
            return { data: { user: { id: UUID_VENDOR_AUTH } }, error: null };
          },
          getUser: async () => ({ data: { user: { id: UUID_VENDOR_AUTH } }, error: null }),
          signOut: async (opts) => {
            assert.deepEqual(opts, { scope: "local" });
            signOutCalls += 1;
            return { error: null };
          },
        },
      }),
      repository,
      resolveActor,
      now: () => "2026-11-28T10:00:00.000Z",
    },
  );
  assert.equal(lastSignInEmail, "v1@hrpartner.vn");
  assert.equal(signOutCalls, 1);
  assert.equal(pendingRes.status, 403);
  assert.deepEqual(await pendingRes.json(), { ok: false, code: "ACCOUNT_PENDING_ACTIVATION" });

  // 1b. Activate partner -> state becomes ACTIVE_MUST_CHANGE_PASSWORD
  const actRes = await handleActivatePartner(
    jsonReq("/api/auth/activate-partner", "POST", { code: "V1", activation_code: "SECRET-ACT-1234" }),
    "true",
    { repository: makeStubRepo() },
  );
  assert.equal(actRes.status, 200);
  const actJson = await actRes.json();
  assert.equal(actJson.account_state, "ACTIVE_MUST_CHANGE_PASSWORD");
  assert.equal(actJson.must_change_password, true);

  state = "ACTIVE_MUST_CHANGE_PASSWORD";

  // 1c. Login succeeds for V1 (and CTV code ctv1) with must_change_password: true
  const loginActiveRes = await createAuthLoginResponse(
    jsonReq("/api/auth/login", "POST", { email: "V1", password: PARTNER_INITIAL_PASSWORD }),
    {
      createClient: async () => ({
        auth: {
          signInWithPassword: async () => ({ data: { user: { id: UUID_VENDOR_AUTH } }, error: null }),
          getUser: async () => ({ data: { user: { id: UUID_VENDOR_AUTH } }, error: null }),
          signOut: async () => ({ error: null }),
        },
      }),
      repository,
      resolveActor,
      now: () => "2026-11-28T10:05:00.000Z",
    },
  );
  assert.equal(loginActiveRes.status, 200);
  const loginBody = await loginActiveRes.json();
  assert.deepEqual(loginBody.actor.partner_account, {
    partner_kind: "VENDOR",
    partner_code: "V1",
    account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
    must_change_password: true,
  });

  // CTV login with code only (ctv1) maps to ctv1@hrpartner.vn
  let ctvEmailUsed = null;
  const ctvLoginRes = await createAuthLoginResponse(
    jsonReq("/api/auth/login", "POST", { email: "ctv1", password: PARTNER_INITIAL_PASSWORD }),
    {
      createClient: async () => ({
        auth: {
          signInWithPassword: async (input) => {
            ctvEmailUsed = input.email;
            return { data: { user: { id: UUID_CTV_AUTH } }, error: null };
          },
          getUser: async () => ({ data: { user: { id: UUID_CTV_AUTH } }, error: null }),
          signOut: async () => ({ error: null }),
        },
      }),
      repository,
      resolveActor,
      now: () => "2026-11-28T10:05:00.000Z",
    },
  );
  assert.equal(ctvLoginRes.status, 200);
  assert.equal(ctvEmailUsed, "ctv1@hrpartner.vn");

  // 1d. Before password change: profile PATCH, recruitment summary, and workers return 403 PASSWORD_CHANGE_REQUIRED
  const unchDeps = {
    resolveSession: async () => ({
      actor: { ok: true, actor: makeVendorActor({ mustChangePassword: true }) },
      response_headers: {},
    }),
    repository: makeStubRepo(),
  };
  const blockedPatch = await handlePatchPartnerProfile(
    jsonReq("/api/partner/profile", "PATCH", {
      display_name: "New Name",
      expected_version: 1,
      idempotency_key: "k-pre-1",
    }),
    "true",
    unchDeps,
  );
  assert.equal(blockedPatch.status, 403);
  assert.deepEqual(await blockedPatch.json(), { ok: false, code: "PASSWORD_CHANGE_REQUIRED" });

  const blockedSum = await handleGetPartnerRecruitmentSummary(
    jsonReq("/api/partner/recruitment/summary", "GET"),
    "true",
    unchDeps,
  );
  assert.equal(blockedSum.status, 403);
  assert.deepEqual(await blockedSum.json(), { ok: false, code: "PASSWORD_CHANGE_REQUIRED" });

  const blockedWorkers = await handleGetPartnerWorkers(
    jsonReq("/api/partner/workers", "GET"),
    "true",
    unchDeps,
  );
  assert.equal(blockedWorkers.status, 403);
  assert.deepEqual(await blockedWorkers.json(), { ok: false, code: "PASSWORD_CHANGE_REQUIRED" });

  // 1e. First-time password change with 7-char currentPassword "hrp@123" triggers markPartnerPasswordChanged
  let markCalls = 0;
  const cpRes = await createChangePasswordResponse(
    jsonReq("/api/auth/change-password", "POST", {
      currentPassword: PARTNER_INITIAL_PASSWORD,
      newPassword: "NewStrongPassword!99",
      confirmPassword: "NewStrongPassword!99",
    }),
    {
      createClient: async () => ({
        auth: {
          getUser: async () => ({
            data: { user: { id: UUID_VENDOR_AUTH, email: "v1@hrpartner.vn" } },
            error: null,
          }),
          signInWithPassword: async (input) => {
            assert.equal(input.email, "v1@hrpartner.vn");
            assert.equal(input.password, PARTNER_INITIAL_PASSWORD);
            return { data: { user: { id: UUID_VENDOR_AUTH, email: "v1@hrpartner.vn" } }, error: null };
          },
          updateUser: async () => ({
            data: { user: { id: UUID_VENDOR_AUTH, email: "v1@hrpartner.vn" } },
            error: null,
          }),
        },
      }),
      now: () => "2026-11-28T10:10:00.000Z",
      repository,
      resolveActor,
      markPartnerPasswordChanged: async (arg) => {
        markCalls += 1;
        assert.deepEqual(arg, { auth_subject: UUID_VENDOR_AUTH, app_user_id: UUID_VENDOR_APP });
        state = "ACTIVE";
        mustChange = false;
        return { ok: true };
      },
    },
  );
  assert.equal(cpRes.status, 200);
  assert.equal(markCalls, 1);

  // 1f. After password change, profile, recruitment summary, and workers succeed
  const activeDeps = {
    resolveSession: async () => ({
      actor: { ok: true, actor: makeVendorActor({ mustChangePassword: false }) },
      response_headers: {},
    }),
    repository: makeStubRepo(),
  };
  assert.equal((await handleGetPartnerProfile(jsonReq("/api/partner/profile"), "true", activeDeps)).status, 200);
  assert.equal((await handleGetPartnerRecruitmentSummary(jsonReq("/api/partner/recruitment/summary"), "true", activeDeps)).status, 200);
  assert.equal((await handleGetPartnerWorkers(jsonReq("/api/partner/workers"), "true", activeDeps)).status, 200);
});

test("2. Admin reset partner password delegates safely and NEVER exposes password in response, audit, or logs", async () => {
  const secretNewPw = "UltraSecretResetPw!2026";
  const logs = [];
  const origInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));

  try {
    const repoCalls = [];
    const res = await handleAdminResetPartnerPassword(
      jsonReq("/api/admin/partners/vendor/V1/reset-password", "POST", {
        new_password: secretNewPw,
        new_password_confirm: secretNewPw,
        reason: "Partner lost password",
        idempotency_key: "12121212-1212-4121-8121-121212121212",
      }),
      "vendor",
      "V1",
      "true",
      {
        resolveSession: async () => ({
          actor: { ok: true, actor: makeAdminActor() },
          response_headers: {},
        }),
        repository: makeStubRepo(),
        accountOperations: {
          repository: {
            begin: async (input) => {
              repoCalls.push(["begin", input]);
              return { ok: true, data: { intent_id: UUID_INTENT, intent_token: UUID_TOKEN } };
            },
            claim: async (input) => {
              repoCalls.push(["claim", input]);
              return { ok: true, data: { claimed: true } };
            },
            readIntent: async (input) => {
              repoCalls.push(["readIntent", input]);
              return {
                ok: true,
                data: {
                  intent_id: UUID_INTENT,
                  intent_token: UUID_TOKEN,
                  kind: "RESET_PASSWORD",
                  state: "IN_FLIGHT",
                  login_id: null,
                  account_ref: UUID_VENDOR_APP,
                  auth_subject: UUID_VENDOR_AUTH,
                },
              };
            },
            finalizeCreate: async () => ({ ok: true, data: {} }),
            finish: async (input) => {
              repoCalls.push(["finish", input]);
              return { ok: true, data: {} };
            },
            updateDisplayName: async () => ({ ok: true, data: {} }),
            createPersonnelFromAccount: async () => ({ ok: true, data: {} }),
            listEligibleAccounts: async () => ({ ok: true, data: {} }),
            reclassify: async () => ({ ok: true, data: {} }),
            readRecruiterLinkStatus: async () => ({ ok: true, data: {} }),
            readRecruiterLinkCandidates: async () => ({ ok: true, data: {} }),
            linkRecruiterToAccount: async () => ({ ok: true, data: {} }),
          },
          auth: {
            createAuthAccount: async () => ({ kind: "failure", code: "unused" }),
            findAuthUserByLoginId: async () => ({ kind: "missing" }),
            readAuthUserProvenance: async () => ({ kind: "missing" }),
            resetAuthPassword: async (input) => {
              assert.equal(input.auth_subject, UUID_VENDOR_AUTH);
              assert.equal(input.password, secretNewPw);
              return { kind: "applied" };
            },
          },
        },
      },
    );

    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.deepEqual(JSON.parse(bodyText), { ok: true });
    assert.equal(bodyText.includes(secretNewPw), false);
    assert.equal(JSON.stringify(repoCalls).includes(secretNewPw), false);
    assert.equal(logs.join("\n").includes(secretNewPw), false);
  } finally {
    console.info = origInfo;
  }

  // Unprovisioned partner returns 409 PARTNER_NOT_PROVISIONED
  const unprovRes = await handleAdminResetPartnerPassword(
    jsonReq("/api/admin/partners/collaborator/ctv_new/reset-password", "POST", {
      new_password: secretNewPw,
      new_password_confirm: secretNewPw,
      idempotency_key: "13131313-1313-4131-8131-131313131313",
    }),
    "collaborator",
    "ctv_new",
    "true",
    {
      resolveSession: async () => ({
        actor: { ok: true, actor: makeAdminActor() },
        response_headers: {},
      }),
      repository: makeStubRepo({
        getPartnerAccountRef: async () => ({ ok: true, data: { app_user_id: null } }),
      }),
      accountOperations: {
        repository: {},
        auth: {},
      },
    },
  );
  assert.equal(unprovRes.status, 409);
  assert.deepEqual(await unprovRes.json(), { ok: false, code: "PARTNER_NOT_PROVISIONED" });
});

test("3. Self-edit profile succeeds for Vendor & CTV and rejects code/extra keys/authority overrides", async () => {
  for (const [kind, actorFn] of [
    ["VENDOR", () => makeVendorActor()],
    ["COLLABORATOR", () => makeCtvActor()],
  ]) {
    const deps = {
      resolveSession: async () => ({
        actor: { ok: true, actor: actorFn() },
        response_headers: {},
      }),
      repository: makeStubRepo({
        updateProfile: async (input) => ({
          ok: true,
          data: {
            partner_account_id: UUID_VENDOR_PA,
            partner_kind: kind,
            partner_id: kind === "VENDOR" ? "V1" : "ctv1",
            code: kind === "VENDOR" ? "V1" : "ctv1",
            canonical_code: kind === "VENDOR" ? "v1" : "ctv1",
            username: kind === "VENDOR" ? "v1" : "ctv1",
            display_name: input.display_name,
            address: input.address,
            phone: input.phone,
            active: true,
            version: input.expected_version + 1,
            account_state: "ACTIVE",
            must_change_password: false,
            activated_at: "2026-11-28T00:00:00Z",
            password_changed_at: "2026-11-28T01:00:00Z",
          },
        }),
      }),
    };

    const okRes = await handlePatchPartnerProfile(
      jsonReq("/api/partner/profile", "PATCH", {
        display_name: `${kind} Renamed`,
        address: "100 Lê Lợi",
        phone: "0912345678",
        expected_version: 1,
        idempotency_key: `k-prof-${kind}`,
      }),
      "true",
      deps,
    );
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.profile.display_name, `${kind} Renamed`);

    // Reject code change / extra key
    const codeChangeRes = await handlePatchPartnerProfile(
      jsonReq("/api/partner/profile", "PATCH", {
        code: "HACKED",
        display_name: "Name",
        expected_version: 1,
        idempotency_key: "k-bad-code",
      }),
      "true",
      deps,
    );
    assert.equal(codeChangeRes.status, 400);
    assert.deepEqual(await codeChangeRes.json(), { ok: false, code: "PARTNER_INVALID" });

    // Reject client authority override fields & headers
    const authFieldRes = await handlePatchPartnerProfile(
      jsonReq("/api/partner/profile", "PATCH", {
        display_name: "Name",
        vendor_id: "V2",
        expected_version: 1,
        idempotency_key: "k-bad-auth",
      }),
      "true",
      deps,
    );
    assert.equal(authFieldRes.status, 400);
    assert.deepEqual(await authFieldRes.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });

    const authHeaderRes = await handlePatchPartnerProfile(
      jsonReq(
        "/api/partner/profile",
        "PATCH",
        { display_name: "Name", expected_version: 1, idempotency_key: "k-bad-hdr" },
        { "x-vendor-id": "V2" },
      ),
      "true",
      deps,
    );
    assert.equal(authHeaderRes.status, 400);
    assert.deepEqual(await authHeaderRes.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });
  }
});

test("4. Open session is blocked immediately (403) when parent Vendor/CTV is deactivated", async () => {
  const suspendedRepo = {
    loadByAuthSubject: async () =>
      makePartnerRawRecord({
        auth_subject: UUID_VENDOR_AUTH,
        app_user_id: UUID_VENDOR_APP,
        partner_account_id: UUID_VENDOR_PA,
        partner_kind: "VENDOR",
        partner_id: "V1",
        canonical_code: "v1",
        display_name: "Vendor One",
        enabled: false,
        partner_active: false,
        account_state: "SUSPENDED",
        must_change_password: false,
        activated_at: "2026-11-28T00:00:00Z",
        password_changed_at: "2026-11-28T01:00:00Z",
      }),
  };

  const resolution = await resolveActor({
    session: { auth_subject: UUID_VENDOR_AUTH, provider: "supabase", authenticated_at: null },
    repository: suspendedRepo,
    at: "2026-11-28T11:00:00.000Z",
  });
  assert.deepEqual(resolution, { ok: false, reason: "ACTOR_DISABLED" });

  const sessionRes = await createAuthSessionResponse(async () => ({ actor: resolution }));
  assert.equal(sessionRes.status, 403);
  assert.deepEqual(await sessionRes.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });

  const portalDeps = {
    resolveSession: async () => ({ actor: resolution, response_headers: {} }),
    repository: makeStubRepo(),
  };
  assert.equal((await handleGetPartnerProfile(jsonReq("/api/partner/profile"), "true", portalDeps)).status, 403);
  assert.equal((await handleGetPartnerRecruitmentSummary(jsonReq("/api/partner/recruitment/summary"), "true", portalDeps)).status, 403);
  assert.equal((await handleGetPartnerWorkers(jsonReq("/api/partner/workers"), "true", portalDeps)).status, 403);
});

test("5. Cross-access isolation: CTV, BI employees, internal BI routes, and vendor_id spoofing are all denied", async () => {
  const ctvDeps = {
    resolveSession: async () => ({ actor: { ok: true, actor: makeCtvActor() }, response_headers: {} }),
    repository: makeStubRepo(),
  };
  const biDeps = {
    resolveSession: async () => ({ actor: { ok: true, actor: makeAdminActor() }, response_headers: {} }),
    repository: makeStubRepo(),
  };
  const vendorDeps = {
    resolveSession: async () => ({ actor: { ok: true, actor: makeVendorActor() }, response_headers: {} }),
    repository: makeStubRepo(),
  };

  // CTV cannot call vendor recruitment summary or workers
  assert.equal((await handleGetPartnerRecruitmentSummary(jsonReq("/api/partner/recruitment/summary"), "true", ctvDeps)).status, 403);
  assert.equal((await handleGetPartnerWorkers(jsonReq("/api/partner/workers"), "true", ctvDeps)).status, 403);

  // BI employee cannot call partner portal routes
  assert.equal((await handleGetPartnerProfile(jsonReq("/api/partner/profile"), "true", biDeps)).status, 403);
  assert.equal((await handleGetPartnerRecruitmentSummary(jsonReq("/api/partner/recruitment/summary"), "true", biDeps)).status, 403);
  assert.equal((await handleGetPartnerWorkers(jsonReq("/api/partner/workers"), "true", biDeps)).status, 403);

  // Partner cannot call admin partner endpoints
  assert.equal((await handleAdminPartnerConflicts(jsonReq("/api/admin/partners/conflicts"), "true", vendorDeps)).status, 403);
  assert.equal(
    (
      await handleAdminProvisionPartner(
        jsonReq("/api/admin/partners/vendor/V1/provision", "POST", { idempotency_key: "k-p1" }),
        "vendor",
        "V1",
        "true",
        { ...vendorDeps, auth: {} },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAdminRotatePartnerActivationCode(
        jsonReq("/api/admin/partners/vendor/V1/activation-code", "POST", { idempotency_key: "k-r1" }),
        "vendor",
        "V1",
        "true",
        vendorDeps,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAdminResetPartnerPassword(
        jsonReq("/api/admin/partners/vendor/V1/reset-password", "POST", {
          new_password: "Password!234",
          new_password_confirm: "Password!234",
          idempotency_key: "k-rst1",
        }),
        "vendor",
        "V1",
        "true",
        { ...vendorDeps, accountOperations: { repository: {}, auth: {} } },
      )
    ).status,
    403,
  );

  // Partner spoofing vendor_id in query param or header is rejected
  const spoofQuerySum = await handleGetPartnerRecruitmentSummary(
    jsonReq("/api/partner/recruitment/summary?vendor_id=V2"),
    "true",
    vendorDeps,
  );
  assert.equal(spoofQuerySum.status, 400);
  assert.deepEqual(await spoofQuerySum.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });

  const spoofQueryWorkers = await handleGetPartnerWorkers(
    jsonReq("/api/partner/workers?vendor_id=V2"),
    "true",
    vendorDeps,
  );
  assert.equal(spoofQueryWorkers.status, 400);
  assert.deepEqual(await spoofQueryWorkers.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });

  const spoofHeaderWorkers = await handleGetPartnerWorkers(
    jsonReq("/api/partner/workers", "GET", undefined, { "x-vendor-id": "V2" }),
    "true",
    vendorDeps,
  );
  assert.equal(spoofHeaderWorkers.status, 400);

  // Vendor & CTV are denied across ALL internal BI API domains
  for (const partnerActor of [makeVendorActor(), makeCtvActor()]) {
    const resolveSession = async () => ({ actor: { ok: true, actor: partnerActor }, response_headers: {} });
    const dummyRepo = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "getActorAccess") {
            return async () => ({
              ok: true,
              data: {
                can_view: false,
                can_view_shared_advance: false,
                can_record: false,
                can_reconcile: false,
                can_fund_vendor_advance: false,
                can_record_vendor_refund: false,
                can_apply_vendor_advance: false,
              },
            });
          }
          return async () => {
            throw new Error(`Partner must never reach repository.${String(prop)}`);
          };
        },
      },
    );

    const b1 = await handleBulletinMobileFeed(jsonReq("/api/bulletins"), "true", { resolveSession, repository: dummyRepo });
    const b2 = await handleAdminBulletinList(jsonReq("/api/admin/bulletins"), "true", { resolveSession, repository: dummyRepo });
    assert.equal(b1.status, 403);
    assert.equal(b2.status, 403);

    const r1 = await handleRecruitmentPostContext(jsonReq("/api/recruitment-posts/context"), "true", { resolveSession, repository: dummyRepo });
    const r2 = await handleRecruitmentPostList(jsonReq("/api/recruitment-posts"), "true", { resolveSession, repository: dummyRepo });
    assert.equal(r1.status, 403);
    assert.equal(r2.status, 403);

    const l1 = await handleGetMyLeaveSummary(jsonReq("/api/leave/my"), "true", { resolveSession, repository: dummyRepo });
    const l2 = await handleGetApprovalInbox(jsonReq("/api/leave/inbox"), "true", { resolveSession, repository: dummyRepo });
    assert.equal(l1.status, 403);
    assert.equal(l2.status, 403);

    const sa1 = await handleGetSalaryAdvanceContext(jsonReq("/api/salary-advances/context"), "true", { resolveSession, repository: dummyRepo });
    const sa2 = await handleGetSalaryAdvanceRequests(jsonReq("/api/salary-advances"), "true", { resolveSession, repository: dummyRepo });
    assert.equal(sa1.status, 403);
    assert.equal(sa2.status, 403);

    const vf1 = await handleGetVendorFinanceContext(jsonReq("/api/vendor-finance/context"), "true", { resolveSession, repository: dummyRepo });
    const vf2 = await handleGetVendorFinanceVendors(jsonReq("/api/vendor-finance/vendors"), "true", { resolveSession, repository: dummyRepo });
    const vf3 = await handleGetProjectAccountantsAdmin(jsonReq("/api/vendor-finance/accountants"), "true", { resolveSession, repository: dummyRepo });
    assert.equal(vf1.status, 403);
    assert.equal(vf2.status, 403);
    assert.equal(vf3.status, 403);

    const wr1 = await listMyWorkReportObligations(
      jsonReq("/api/work-reports/obligations"),
      "true",
      { resolveSession, repository: dummyRepo },
    );
    assert.equal(wr1.status, 403);
    assert.deepEqual(await wr1.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

    const att1 = await getAttendanceTime(
      jsonReq("/api/attendance/time"),
      {
        ATTENDANCE_ENABLED: "true",
        ATTENDANCE_TIME_TOKEN_SECRET: "att-partner-isolation-test-secret-0123456789abcdef",
        SUPABASE_SECRET_KEY: "sb-secret-distinct-key-for-test",
      },
      { resolveSession },
    );
    assert.equal(att1.status, 403);
    assert.deepEqual(await att1.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });

    const de1 = await createDirectEntrySessionResponse("true", resolveSession);
    assert.equal(de1.status, 403);
    assert.deepEqual(await de1.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });
  }

  // Reporting route handlers explicitly deny partner_account !== undefined with 403 ACTOR_NOT_AVAILABLE
  for (const routeRel of [
    "../../app/api/reporting/detailed-matrix/route.ts",
    "../../app/api/reporting/team-drill-down/route.ts",
    "../../app/api/reporting/team-report/route.ts",
    "../../app/api/reporting/workforce-deep/route.ts",
  ]) {
    const source = readFileSync(new URL(routeRel, import.meta.url), "utf8");
    assert.match(source, /guard\.actor\.partner_account !== undefined/);
    assert.match(source, /apiSessionError\("ACTOR_NOT_AVAILABLE", 403\)/);
  }
});

test("6. Provisioning resume links matching Auth provenance without duplicate create, and rejects mismatched provenance", async () => {
  // 6a. Resume when Auth user already exists with matching account_intent -> no createAuthAccount call
  let createCalls = 0;
  let finalizeArgs = null;
  const resumeRes = await handleAdminProvisionPartner(
    jsonReq("/api/admin/partners/vendor/V1/provision", "POST", {
      reason: "Resume incomplete provision",
      idempotency_key: "k-resume-ok",
    }),
    "vendor",
    "V1",
    "true",
    {
      resolveSession: async () => ({
        actor: { ok: true, actor: makeAdminActor() },
        response_headers: {},
      }),
      repository: makeStubRepo({
        provisionBegin: async () => ({
          ok: true,
          data: {
            intent_id: UUID_INTENT,
            intent_token: UUID_TOKEN,
            state: "IN_FLIGHT",
            resumed: true,
            partner_account_id: UUID_VENDOR_PA,
            partner_kind: "VENDOR",
            partner_id: "V1",
            canonical_code: "v1",
            username: "v1",
            auth_email: "v1@hrpartner.vn",
            display_name: "Vendor One",
          },
        }),
        provisionFinalize: async (args) => {
          finalizeArgs = args;
          return {
            ok: true,
            data: {
              partner_account_id: UUID_VENDOR_PA,
              partner_kind: "VENDOR",
              partner_id: "V1",
              canonical_code: "v1",
              username: "v1",
              app_user_id: UUID_VENDOR_APP,
              auth_subject: UUID_VENDOR_AUTH,
              account_state: "PENDING_ACTIVATION",
              activation_expires_at: "2026-12-05T10:00:00Z",
              must_change_password: true,
              version: 2,
              revision_id: UUID_REV,
              intent_id: UUID_INTENT,
            },
          };
        },
      }),
      auth: {
        createAuthAccount: async () => {
          createCalls += 1;
          return { kind: "created", auth_subject: UUID_VENDOR_AUTH };
        },
        findAuthUserByLoginId: async (q) => {
          assert.deepEqual(q, { login_id: "v1", intent_token: UUID_TOKEN });
          return { kind: "match", auth_subject: UUID_VENDOR_AUTH };
        },
        readAuthUserProvenance: async () => ({ kind: "match" }),
      },
      generateActivationCode: () => "FIXED-ACT-CODE-123",
      nowMs: () => Date.parse("2026-11-28T10:00:00.000Z"),
    },
  );
  assert.equal(resumeRes.status, 200);
  assert.equal(createCalls, 0, "Resumed provision must NOT create a duplicate Auth user");
  assert.equal(finalizeArgs.created_auth_subject, UUID_VENDOR_AUTH);
  assert.equal(
    finalizeArgs.activation_code_hash,
    createHash("sha256").update("FIXED-ACT-CODE-123", "utf8").digest("hex"),
  );
  const resumeBody = await resumeRes.json();
  assert.equal(resumeBody.provision.resumed, true);
  assert.equal(resumeBody.provision.activation_code, "FIXED-ACT-CODE-123");
  assert.equal(JSON.stringify(resumeBody).includes(PARTNER_INITIAL_PASSWORD), false);

  // 6b. Mismatched provenance fails closed (409 PARTNER_CONFLICT)
  const mismatchRes = await handleAdminProvisionPartner(
    jsonReq("/api/admin/partners/vendor/V1/provision", "POST", {
      idempotency_key: "k-resume-mismatch",
    }),
    "vendor",
    "V1",
    "true",
    {
      resolveSession: async () => ({
        actor: { ok: true, actor: makeAdminActor() },
        response_headers: {},
      }),
      repository: makeStubRepo({
        provisionBegin: async () => ({
          ok: true,
          data: {
            intent_id: UUID_INTENT,
            intent_token: UUID_TOKEN,
            state: "IN_FLIGHT",
            resumed: true,
            partner_account_id: UUID_VENDOR_PA,
            partner_kind: "VENDOR",
            partner_id: "V1",
            canonical_code: "v1",
            username: "v1",
            auth_email: "v1@hrpartner.vn",
            display_name: "Vendor One",
          },
        }),
      }),
      auth: {
        createAuthAccount: async () => ({ kind: "failure", code: "already_exists" }),
        findAuthUserByLoginId: async () => ({ kind: "mismatch", auth_subject: UUID_BI_AUTH }),
        readAuthUserProvenance: async () => ({ kind: "mismatch" }),
      },
    },
  );
  assert.equal(mismatchRes.status, 409);
  assert.deepEqual(await mismatchRes.json(), { ok: false, code: "PARTNER_CONFLICT" });
});

test("7. BI employee regression: login with username or email yields exact 5-key actorProjection without partner_account", async () => {
  const biRawRecord = {
    auth_subject: UUID_BI_AUTH,
    app_user_id: UUID_BI_APP,
    display_name: "Nguyễn Văn BI",
    enabled: true,
    capabilities: ["entry_create", "entry_own"],
    recruiter_links: [{ app_user_id: UUID_BI_APP, recruiter_id: UUID_REC, verified: true }],
    teams: [],
    team_scope_grants: [],
    all_scope_grants: [],
  };

  for (const identifier of ["vinhnt.td", "vinhnt.td@hrpartner.vn"]) {
    let seenEmail = null;
    const res = await createAuthLoginResponse(
      jsonReq("/api/auth/login", "POST", { email: identifier, password: "EmployeePassword!1" }),
      {
        createClient: async () => ({
          auth: {
            signInWithPassword: async (input) => {
              seenEmail = input.email;
              return { data: { user: { id: UUID_BI_AUTH } }, error: null };
            },
            getUser: async () => ({ data: { user: { id: UUID_BI_AUTH } }, error: null }),
            signOut: async () => ({ error: null }),
          },
        }),
        repository: { loadByAuthSubject: async () => biRawRecord },
        resolveActor,
        now: () => "2026-11-28T12:00:00.000Z",
      },
    );
    assert.equal(res.status, 200);
    assert.equal(seenEmail, "vinhnt.td@hrpartner.vn");
    const json = await res.json();
    assert.deepEqual(Object.keys(json.actor).sort(), [
      "app_user_id",
      "capabilities",
      "display_name",
      "scopes",
      "self_recruiter_suggestion",
    ]);
    assert.equal("partner_account" in json.actor, false);
  }
});
