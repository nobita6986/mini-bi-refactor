/**
 * PRE-W2-HF-D3-B/C - focused API + contract tests (no DB, no Supabase Auth).
 *
 * Full Admin success path (fake repo/auth), claim-loser, provenance mismatch,
 * reset applied/unknown, denied taxonomy, authority-field forbidding, no
 * password/hash leak in any response, personnel-from-account, and the strict
 * request validators.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateAccount,
  parseCreatePersonnelFromAccount,
  parseEditDisplayName,
  parseLinkRecruiterToAccount,
  parseResetPassword,
  projectClaimEnvelope,
  projectLinkRecruiterEnvelope,
  projectRecruiterLinkCandidatesEnvelope,
  projectRecruiterLinkStatusEnvelope,
} from "./account-operation-contract.ts";
import {
  createAccount,
  editDisplayName,
  reconcileIntent,
  resetPassword,
  createPersonnelFromAccount,
  getRecruiterLinkCandidates,
  getRecruiterLinkStatus,
  linkRecruiterToAccount,
  reclassifyAccountOperations,
} from "./account-operation-api.ts";

const AUTH_SUBJECT = "91000000-0000-4000-8000-000000000001";
const APP_USER = "92000000-0000-4000-8000-000000000001";
const LOGIN_ID = "staff01";
const INTENT = "93000000-0000-4000-8000-000000000001";
const TOKEN = "94000000-0000-4000-8000-000000000001";
const CREATED_AUTH = "95000000-0000-4000-8000-000000000001";
const REV = "96000000-0000-4000-8000-000000000001";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

test("D3: claim RPC projection accepts its exact envelope including claimed", () => {
  assert.deepEqual(projectClaimEnvelope({
    intent_id: INTENT,
    intent_token: TOKEN,
    kind: "RESET_PASSWORD",
    state: "IN_FLIGHT",
    claimed: true,
  }), {
    intent_id: INTENT,
    intent_token: TOKEN,
    kind: "RESET_PASSWORD",
    state: "IN_FLIGHT",
    claimed: true,
  });
  assert.equal(projectClaimEnvelope({
    intent_id: INTENT,
    intent_token: TOKEN,
    kind: "RESET_PASSWORD",
    state: "IN_FLIGHT",
    claimed: true,
    extra: "unexpected",
  }), null);
});

function session(actor = { auth_subject: AUTH_SUBJECT, app_user_id: APP_USER }) {
  return async () => ({ actor: { ok: true, actor } });
}

function fakeRequest(body, overrides = {}) {
  const headers = {
    origin: "https://example.test",
    host: "example.test",
    "content-type": "application/json",
    ...overrides,
  };
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v ?? null;
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  return { headers: { get: (n) => lower[n.toLowerCase()] ?? null }, body: stream };
}

function repository(overrides = {}) {
  const calls = [];
  return {
    calls,
    async begin() { calls.push("begin"); return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "PENDING" } }; },
    async claim() { calls.push("claim"); return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", claimed: true } }; },
    async readIntent() { return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "IN_FLIGHT", login_id: null, display_name: null, account_ref: APP_USER, auth_subject: CREATED_AUTH, created_at: "x", claimed_at: null, resolved_at: null } }; },
    async finish() { calls.push("finish"); return { ok: true, data: null }; },
    async finalizeCreate() { return { ok: true, data: { app_user_id: APP_USER, auth_subject: CREATED_AUTH, display_name: "Nguyen Van A", version: 1, revision_id: REV, intent_id: INTENT, intent_state: "APPLIED" } }; },
    async updateDisplayName() { return { ok: true, data: { app_user_id: APP_USER, version: 2, revision_id: REV, recruiter_id: null, recruiter_version: null, recruiter_revision_id: null } }; },
    async createPersonnelFromAccount() { return { ok: true, data: { recruiter_id: CREATED_AUTH, display_name: "Nguyen Van A", personnel_code: "NV001", personnel_position: "STAFF", version: 1, link_id: REV, membership_id: INTENT, app_user_version: 2, app_user_revision_id: REV, personnel_revision_id: REV } }; },
    async listEligibleAccounts() { return { ok: true, data: { page: 1, page_size: 25, total: 0, has_more: false, accounts: [] } }; },
    async readRecruiterLinkStatus() { return { ok: true, data: { linked_recruiter_ids: [CREATED_AUTH] } }; },
    async readRecruiterLinkCandidates() { return { ok: true, data: { recruiter_id: CREATED_AUTH, display_name: "Marketing Vĩnh Phúc", personnel_code: "mkt.vp", personnel_position: "TEAM_LEADER", active: true, version: 1, already_linked: false, candidates: [{ app_user_id: APP_USER, display_name: "Marketing Vĩnh Phúc", login_id: "mkt.vp", version: 1 }] } }; },
    async linkRecruiterToAccount() { return { ok: true, data: { link_id: INTENT, app_user_id: APP_USER, app_user_version: 2, app_user_revision_id: REV, recruiter_id: CREATED_AUTH, recruiter_version: 1, personnel_code: "mkt.vp", valid_from: "2026-10-26" } }; },
    async reclassify() { return { ok: true, data: { reclassified: 0, purged: 0, deleted: 0 } }; },
    ...overrides,
  };
}

function auth(overrides = {}) {
  return {
    async createAuthAccount() { return { kind: "created", auth_subject: CREATED_AUTH }; },
    async readAuthUserProvenance() { return { kind: "match", auth_subject: CREATED_AUTH }; },
    async resetAuthPassword() { return { kind: "applied" }; },
    async findAuthUserByLoginId() { return { kind: "missing" }; },
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    resolveSession: session(),
    repository: repository(),
    auth: auth(),
    ...overrides,
  };
}

const VALID_CREATE = {
  login_id: "nv-a", display_name: "Nguyen Van A", password: "strong-pass-123",
  password_confirm: "strong-pass-123", reason: "create", idempotency_key: AUTH_SUBJECT,
};

/* ---------- validators ---------- */
test("D3: create/reset/edit/personnel request validators are strict", () => {
  assert.equal(parseCreateAccount(VALID_CREATE).ok, true);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, password_confirm: "different" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, password: "short" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, login_id: "Bad Login" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, extra: 1 }).ok, false);

  assert.equal(parseResetPassword({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseResetPassword({ password: "new-pass-123", password_confirm: "x", reason: "r", idempotency_key: AUTH_SUBJECT }).ok, false);

  assert.equal(parseEditDisplayName({
    display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseEditDisplayName({ display_name: "New Name", expected_version: 0, reason: "rename", idempotency_key: AUTH_SUBJECT }).ok, false);

  assert.equal(parseCreatePersonnelFromAccount({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: LOGIN_ID,
    personnel_position: "STAFF", valid_from: TODAY_VN, reason: "create", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseCreatePersonnelFromAccount({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: LOGIN_ID,
    personnel_position: "STAFF", valid_from: TODAY_VN, reason: "create", idempotency_key: AUTH_SUBJECT,
  }).value.personnel_code, LOGIN_ID);
  assert.equal(parseCreatePersonnelFromAccount({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: "Bad Login",
    personnel_position: "STAFF", valid_from: TODAY_VN, reason: "create", idempotency_key: AUTH_SUBJECT,
  }).ok, false, "client cannot choose a personnel code");
});

test("action reasons normalize absent, null and blank to NULL across account operations", () => {
  const parseCases = [
    [parseCreateAccount, VALID_CREATE],
    [parseResetPassword, { password: "new-pass-123", password_confirm: "new-pass-123",
      reason: "reset", idempotency_key: AUTH_SUBJECT }],
    [parseEditDisplayName, { display_name: "New Name", expected_version: 2,
      reason: "rename", idempotency_key: AUTH_SUBJECT }],
    [parseCreatePersonnelFromAccount, { account_ref: APP_USER, expected_account_version: 1,
      personnel_code: LOGIN_ID, personnel_position: "STAFF", valid_from: TODAY_VN,
      reason: "create", idempotency_key: AUTH_SUBJECT }],
  ];
  for (const [parse, valid] of parseCases) {
    for (const reason of [undefined, null, "", "  "]) {
      const body = { ...valid };
      if (reason === undefined) delete body.reason;
      else body.reason = reason;
      const parsed = parse(body);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.value.reason, null);
    }
    assert.equal(parse({ ...valid, reason: 123 }).ok, false);
    assert.equal(parse({ ...valid, reason: "x".repeat(4001) }).ok, false);
    const maximum = parse({ ...valid, reason: "x".repeat(4000) });
    assert.equal(maximum.ok, true);
    if (maximum.ok) assert.equal(maximum.value.reason.length, 4000);
  }
});

/* ---------- create account saga ---------- */
test("D3: create account success returns the finalized account without leaking password", async () => {
  const d = deps();
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.account.app_user_id, APP_USER);
  assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, "no password in response");
  assert.deepEqual(d.repository.calls, ["begin", "claim"]);
});

test("D3: create account claim loser replays IN_FLIGHT intent without calling Auth", async () => {
  let authCalled = false;
  let findCalled = false;
  const d = deps({
    repository: repository({
      async claim() { return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", claimed: false } }; },
      async readIntent() {
        return {
          ok: true,
          data: {
            intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT",
            login_id: VALID_CREATE.login_id, display_name: VALID_CREATE.display_name,
            account_ref: null, auth_subject: null, created_at: "x", claimed_at: "x", resolved_at: null,
          },
        };
      },
    }),
    auth: auth({
      async createAuthAccount() { authCalled = true; return { kind: "created", auth_subject: CREATED_AUTH }; },
      async findAuthUserByLoginId() { findCalled = true; return { kind: "missing" }; },
    }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    replayed: true,
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "IN_FLIGHT",
      account_ref: null,
    },
  });
  assert.equal(authCalled, false, "no second Auth call on claim loss");
  assert.equal(findCalled, false, "no Auth login lookup on claim loss");
  assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, "no password in replay response");
});

test("D3: create account provenance mismatch is finalized as BLOCKED, not APPLIED", async () => {
  const d = deps({
    repository: repository({
      async finalizeCreate(input) {
        return { ok: true, data: input.intent_token === TOKEN
          ? { app_user_id: APP_USER, auth_subject: CREATED_AUTH, display_name: "x", version: 1, revision_id: REV, intent_id: INTENT, intent_state: "APPLIED" }
          : { intent_id: INTENT, intent_state: "BLOCKED", account_ref: null } };
      },
    }),
    auth: auth({ async readAuthUserProvenance() { return { kind: "mismatch", auth_subject: CREATED_AUTH }; } }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.intent.state, "BLOCKED");
});

/* ---------- reset saga ---------- */
test("D3: reset password applied calls updateUserById once and marks APPLIED", async () => {
  let resets = 0;
  const d = deps({
    auth: auth({ async resetAuthPassword() { resets += 1; return { kind: "applied" }; } }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 200);
  assert.equal(resets, 1);
});

test("D3: reset password unknown marks INDETERMINATE (no replay)", async () => {
  const d = deps({
    auth: auth({ async resetAuthPassword() { return { kind: "unknown" }; } }),
    repository: repository({ async finish(input) { return { ok: true, data: null, outcome: input.outcome }; } }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_OPERATION_INDETERMINATE" });
});

/* ---------- authority / leak taxonomy ---------- */
test("D3: client authority fields are refused before any repository call", async () => {
  const d = deps();
  const response = await createAccount(fakeRequest({ ...VALID_CREATE, scope: "all" }), "true", d);
  assert.equal(response.status, 400);
  assert.equal(d.repository.calls.length, 0, "no repository call on authority rejection");
});

test("D3: missing session actor returns 403", async () => {
  const d = deps({ resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }) });
  const response = await editDisplayName(fakeRequest({
    display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 403);
});

/* ---------- personnel from account ---------- */
test("D3: personnel from account returns the created personnel, display_name server-side", async () => {
  let createInput;
  const d = deps({ repository: repository({
    async createPersonnelFromAccount(input) {
      createInput = input;
      return { ok: true, data: { recruiter_id: CREATED_AUTH, display_name: "Nguyen Van A",
        personnel_code: input.personnel_code, personnel_position: "STAFF", version: 1, link_id: REV,
        membership_id: INTENT, app_user_version: 2, app_user_revision_id: REV, personnel_revision_id: REV } };
    },
  }) });
  const response = await createPersonnelFromAccount(fakeRequest({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: LOGIN_ID,
    personnel_position: "STAFF", valid_from: TODAY_VN, reason: "create", idempotency_key: AUTH_SUBJECT,
  }), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.personnel.display_name, "Nguyen Van A");
  assert.equal(body.personnel.personnel_code, LOGIN_ID);
  assert.equal(createInput.personnel_code, LOGIN_ID, "API forwards the selected login ID for DB revalidation");
});

/* ---------- personnel-from-account taxonomy ---------- */
test("D3-C: personnel-from-account maps denied/conflict/invalid to the sanitized taxonomy", async () => {
  for (const [kind, status] of [["denied", 403], ["conflict", 409], ["invalid", 400]]) {
    const d = deps({
      repository: repository({ async createPersonnelFromAccount() { return { ok: false, kind }; } }),
    });
    const response = await createPersonnelFromAccount(fakeRequest({
      account_ref: APP_USER, expected_account_version: 1, personnel_code: LOGIN_ID,
      personnel_position: "STAFF", valid_from: TODAY_VN, reason: "create", idempotency_key: AUTH_SUBJECT,
    }), "true", d);
    assert.equal(response.status, status, kind);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.doesNotMatch(JSON.stringify(body), /auth_subject|email|password|app_user_id/);
  }
});

/* ---------- finish result is authoritative ---------- */
test("D3: create unknown with a failed finish does NOT return terminal success", async () => {
  let authCalls = 0;
  const d = deps({
    auth: auth({ async createAuthAccount() { authCalls += 1; return { kind: "unknown" }; } }),
    repository: repository({ async finish() { return { ok: false, kind: "unavailable" }; } }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(authCalls, 1, "no second Auth call when finish write fails");
});

test("D3: reset applied with a failed finish is not reported as success and no second Auth call", async () => {
  let resets = 0;
  const d = deps({
    auth: auth({ async resetAuthPassword() { resets += 1; return { kind: "applied" }; } }),
    repository: repository({ async finish() { return { ok: false, kind: "unavailable" }; } }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 500);
  assert.equal(resets, 1, "no second Auth call when finish write fails");
  assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED" });
});

test("D3: reset diagnostics log only fixed stages/outcomes and distinguish an unrecorded unknown result", async () => {
  const messages = [];
  const originalInfo = console.info;
  console.info = (...values) => messages.push(values.join(" "));
  try {
    const d = deps({
      auth: auth({ async resetAuthPassword() { return { kind: "unknown" }; } }),
      repository: repository({ async finish() { return { ok: false, kind: "unavailable" }; } }),
    });
    const secretPassword = "must-never-appear-logged";
    const response = await resetPassword(fakeRequest({
      password: secretPassword, password_confirm: secretPassword, reason: "reset", idempotency_key: AUTH_SUBJECT,
    }), APP_USER, "true", d);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_OPERATION_RESULT_UNRECORDED" });
    assert.deepEqual(messages, [
      "[account-operation] reset-password stage=begin outcome=ok",
      "[account-operation] reset-password stage=claim outcome=ok",
      "[account-operation] reset-password stage=read outcome=ok",
      "[account-operation] reset-password stage=auth outcome=unknown",
      "[account-operation] reset-password stage=finish outcome=unavailable",
    ]);
    assert.doesNotMatch(messages.join(" "), new RegExp(secretPassword));
    assert.doesNotMatch(messages.join(" "), new RegExp(APP_USER));
    assert.doesNotMatch(messages.join(" "), new RegExp(AUTH_SUBJECT));
  } finally {
    console.info = originalInfo;
  }
});

/* ---------- reclassify ---------- */
test("D3: reclassify route calls the repository RPC and returns sanitized counts", async () => {
  let called = false;
  const d = deps({
    repository: repository({
      async reclassify() { called = true; return { ok: true, data: { reclassified: 2, purged: 1, deleted: 0 } }; },
    }),
  });
  const response = await reclassifyAccountOperations(fakeRequest({}), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.reclassified, { reclassified: 2, purged: 1, deleted: 0 });
  assert.equal(called, true);
});

test("D3: reclassify is denied for a non-Full-Admin (session actor unavailable)", async () => {
  const d = deps({ resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }) });
  const response = await reclassifyAccountOperations(fakeRequest({}), "true", d);
  assert.equal(response.status, 403);
});

/* ---------- link existing personnel to existing account ---------- */
test("linkRecruiterToAccount: strict contract & API boundary for status, candidates and link", async () => {
  assert.equal(parseLinkRecruiterToAccount({
    account_ref: APP_USER,
    expected_account_version: 1,
    expected_recruiter_version: 2,
    reason: "liên kết mkt.vp",
    idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseLinkRecruiterToAccount({
    account_ref: APP_USER,
    expected_account_version: 0,
    expected_recruiter_version: 2,
    reason: null,
    idempotency_key: AUTH_SUBJECT,
  }).ok, false);
  assert.equal(parseLinkRecruiterToAccount({
    account_ref: APP_USER,
    expected_account_version: 1,
    expected_recruiter_version: 2,
    idempotency_key: AUTH_SUBJECT,
    extra: true,
  }).ok, false);

  assert.deepEqual(projectRecruiterLinkStatusEnvelope({ linked_recruiter_ids: [CREATED_AUTH] }), {
    linked_recruiter_ids: [CREATED_AUTH],
  });
  assert.equal(projectRecruiterLinkStatusEnvelope({ linked_recruiter_ids: ["not-a-uuid"] }), null);

  assert.ok(projectRecruiterLinkCandidatesEnvelope({
    recruiter_id: CREATED_AUTH,
    display_name: "Marketing Vĩnh Phúc",
    personnel_code: "mkt.vp",
    personnel_position: null,
    active: true,
    version: 1,
    already_linked: false,
    candidates: [{ app_user_id: APP_USER, display_name: "Marketing Vĩnh Phúc", login_id: "mkt.vp", version: 1 }],
  }));
  assert.equal(projectRecruiterLinkCandidatesEnvelope({
    recruiter_id: CREATED_AUTH,
    display_name: "Marketing Vĩnh Phúc",
    personnel_code: "mkt.vp",
    personnel_position: "STAFF",
    active: true,
    version: 1,
    already_linked: false,
    candidates: [{ app_user_id: APP_USER, display_name: "X", login_id: "mkt.vp", version: 1, email: "mkt.vp@hrpartner.vn" }],
  }), null);

  assert.ok(projectLinkRecruiterEnvelope({
    link_id: INTENT,
    app_user_id: APP_USER,
    app_user_version: 2,
    app_user_revision_id: REV,
    recruiter_id: CREATED_AUTH,
    recruiter_version: 1,
    personnel_code: "mkt.vp",
    valid_from: "2026-10-26",
  }));

  const statusReq = new Request(`https://example.test/api/admin/catalog/personnel/link-status?recruiter_ids=${CREATED_AUTH}`);
  const statusRes = await getRecruiterLinkStatus(statusReq, "true", deps());
  assert.equal(statusRes.status, 200);
  assert.deepEqual(await statusRes.json(), {
    ok: true,
    status: { linked_recruiter_ids: [CREATED_AUTH] },
  });

  const candsReq = new Request(`https://example.test/api/admin/catalog/personnel/${CREATED_AUTH}/link-account`);
  const candsRes = await getRecruiterLinkCandidates(candsReq, CREATED_AUTH, "true", deps());
  assert.equal(candsRes.status, 200);
  const candsBody = await candsRes.json();
  assert.equal(candsBody.ok, true);
  assert.equal(candsBody.candidates.personnel_code, "mkt.vp");

  let forwardedLink;
  const linkRes = await linkRecruiterToAccount(fakeRequest({
    account_ref: APP_USER,
    expected_account_version: 1,
    expected_recruiter_version: 1,
    reason: "Liên kết mkt.vp",
    idempotency_key: AUTH_SUBJECT,
  }), CREATED_AUTH, "true", deps({
    repository: repository({
      async linkRecruiterToAccount(input) {
        forwardedLink = input;
        return {
          ok: true,
          data: {
            link_id: INTENT,
            app_user_id: APP_USER,
            app_user_version: 2,
            app_user_revision_id: REV,
            recruiter_id: CREATED_AUTH,
            recruiter_version: 1,
            personnel_code: "mkt.vp",
            valid_from: "2026-10-26",
          },
        };
      },
    }),
  }));
  assert.equal(linkRes.status, 200);
  assert.equal(forwardedLink.recruiter_id, CREATED_AUTH);
  assert.equal(forwardedLink.account_ref, APP_USER);

  for (const [kind, status] of [["denied", 403], ["conflict", 409], ["invalid", 400], ["not-found", 404]]) {
    const errRes = await linkRecruiterToAccount(fakeRequest({
      account_ref: APP_USER,
      expected_account_version: 1,
      expected_recruiter_version: 1,
      idempotency_key: AUTH_SUBJECT,
    }), CREATED_AUTH, "true", deps({
      repository: repository({ async linkRecruiterToAccount() { return { ok: false, kind }; } }),
    }));
    assert.equal(errRes.status, status);
  }
});

/* ---------- Việc C: create account replay / recovery & reconcile ---------- */
const RECONCILE_KEY = "97000000-0000-4000-8000-000000000001";
const OTHER_INTENT = "98000000-0000-4000-8000-000000000001";
const OTHER_TOKEN = "99000000-0000-4000-8000-000000000001";

function createIntentRead(overrides = {}) {
  return {
    intent_id: INTENT,
    intent_token: TOKEN,
    kind: "CREATE_ACCOUNT",
    state: "APPLIED",
    login_id: VALID_CREATE.login_id,
    display_name: VALID_CREATE.display_name,
    account_ref: APP_USER,
    auth_subject: CREATED_AUTH,
    created_at: "2026-11-19T00:00:00Z",
    claimed_at: "2026-11-19T00:00:01Z",
    resolved_at: "2026-11-19T00:00:02Z",
    ...overrides,
  };
}

function noAuthCalls() {
  return auth({
    async createAuthAccount() { throw new Error("createAuthAccount must not be called"); },
    async readAuthUserProvenance() { throw new Error("readAuthUserProvenance must not be called"); },
    async findAuthUserByLoginId() { throw new Error("findAuthUserByLoginId must not be called"); },
    async resetAuthPassword() { throw new Error("resetAuthPassword must not be called"); },
  });
}

test("HF-Replay: lost HTTP response after commit replays APPLIED via finalizeCreate cache without calling Auth", async () => {
  let accountAccessCalled = false;
  let finalizeInput;
  const cachedAccount = {
    app_user_id: APP_USER,
    auth_subject: CREATED_AUTH,
    display_name: "Nguyen Van A",
    version: 1,
    revision_id: REV,
    intent_id: INTENT,
    intent_state: "APPLIED",
  };
  const d = deps({
    repository: repository({
      async claim() {
        return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", claimed: false } };
      },
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "APPLIED" }) };
      },
      async finalizeCreate(input) {
        finalizeInput = input;
        return { ok: true, data: cachedAccount };
      },
    }),
    accountAccess: {
      async getAccount() {
        accountAccessCalled = true;
        return { ok: false, kind: "unavailable" };
      },
    },
    auth: noAuthCalls(),
  });

  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    replayed: true,
    account: cachedAccount,
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: APP_USER,
    },
  });
  assert.equal(finalizeInput.intent_id, INTENT);
  assert.equal(finalizeInput.intent_token, TOKEN);
  assert.equal(finalizeInput.created_auth_subject, CREATED_AUTH);
  assert.equal(finalizeInput.idempotency_key, VALID_CREATE.idempotency_key);
  assert.equal(accountAccessCalled, false, "cached finalizeCreate avoids redundant getAccount");
  assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, "no password leaked");
});

test("HF-Replay: reconcile-finalized APPLIED replays via accountAccess.getAccount strictly by account_ref (never login_id)", async () => {
  let getAccountInput;
  const d = deps({
    repository: repository({
      async claim() {
        return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", claimed: false } };
      },
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "APPLIED" }) };
      },
      async finalizeCreate() {
        // Different idempotency key from original /reconcile -> DB returns terminal 3-key shape.
        return { ok: true, data: { intent_id: INTENT, intent_state: "APPLIED", account_ref: APP_USER } };
      },
    }),
    accountAccess: {
      async getAccount(input) {
        getAccountInput = input;
        return {
          ok: true,
          data: {
            account_ref: APP_USER,
            display_name: "Nguyen Van A",
            login_id: VALID_CREATE.login_id,
            enabled: true,
            version: 2,
            account_type: "NORMAL",
            active_person_link: null,
          },
        };
      },
    },
    auth: noAuthCalls(),
  });

  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(getAccountInput, {
    auth_subject: AUTH_SUBJECT,
    app_user_id: APP_USER,
    target_app_user_id: APP_USER,
  });
  assert.equal("login_id" in getAccountInput, false, "must query strictly by account_ref, never login_id");
  assert.deepEqual(body, {
    ok: true,
    replayed: true,
    account: {
      app_user_id: APP_USER,
      auth_subject: CREATED_AUTH,
      display_name: "Nguyen Van A",
      version: 2,
      revision_id: null,
      intent_id: INTENT,
      intent_state: "APPLIED",
    },
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: APP_USER,
    },
  });
  assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, "no password leaked");
});

test("HF-Replay: APPLIED replay falls back to intent-only when accountAccess omitted or unavailable, and 500 if account_ref null", async () => {
  for (const accountAccess of [undefined, { async getAccount() { return { ok: false, kind: "unavailable" }; } }]) {
    const d = deps({
      repository: repository({
        async claim() {
          return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", claimed: false } };
        },
        async readIntent() {
          return { ok: true, data: createIntentRead({ state: "APPLIED" }) };
        },
        async finalizeCreate() {
          return { ok: true, data: { intent_id: INTENT, intent_state: "APPLIED", account_ref: APP_USER } };
        },
      }),
      accountAccess,
      auth: noAuthCalls(),
    });
    const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      replayed: true,
      intent: {
        intent_id: INTENT,
        intent_token: TOKEN,
        kind: "CREATE_ACCOUNT",
        state: "APPLIED",
        account_ref: APP_USER,
      },
    });
  }

  const missingRef = deps({
    repository: repository({
      async claim() {
        return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", claimed: false } };
      },
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "APPLIED", account_ref: null }) };
      },
    }),
    auth: noAuthCalls(),
  });
  const errRes = await createAccount(fakeRequest(VALID_CREATE), "true", missingRef);
  assert.equal(errRes.status, 500);
  assert.deepEqual(await errRes.json(), { ok: false, code: "ACCOUNT_OPERATION_UNAVAILABLE" });
});

test("HF-Replay: create account claim loser replays IN_FLIGHT/INDETERMINATE/BLOCKED/CONFLICT/FAILED/EXPIRED without calling Auth", async () => {
  for (const state of ["IN_FLIGHT", "INDETERMINATE", "BLOCKED", "CONFLICT", "FAILED", "EXPIRED"]) {
    const d = deps({
      repository: repository({
        async claim() {
          return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state, claimed: false } };
        },
        async readIntent() {
          return { ok: true, data: createIntentRead({ state, account_ref: null, auth_subject: null }) };
        },
      }),
      auth: noAuthCalls(),
    });
    const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
    assert.equal(response.status, 200, state);
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      replayed: true,
      intent: {
        intent_id: INTENT,
        intent_token: TOKEN,
        kind: "CREATE_ACCOUNT",
        state,
        account_ref: null,
      },
    }, state);
    assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, state);
  }
});

test("HF-Replay: create account claim loser fails closed 409 on PENDING or mismatched intent metadata", async () => {
  const cases = [
    ["PENDING", createIntentRead({ state: "PENDING", account_ref: null, auth_subject: null })],
    ["kind-mismatch", createIntentRead({ kind: "RESET_PASSWORD", state: "APPLIED" })],
    ["token-mismatch", createIntentRead({ intent_token: OTHER_TOKEN, state: "APPLIED" })],
    ["id-mismatch", createIntentRead({ intent_id: OTHER_INTENT, state: "APPLIED" })],
  ];
  for (const [label, readData] of cases) {
    const d = deps({
      repository: repository({
        async claim() {
          return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "PENDING", claimed: false } };
        },
        async readIntent() {
          return { ok: true, data: readData };
        },
      }),
      auth: noAuthCalls(),
    });
    const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
    assert.equal(response.status, 409, label);
    assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_OPERATION_CONFLICT" }, label);
  }
});

test("HF-Replay: provenance unknown finishes as INDETERMINATE (not BLOCKED) while mismatch stays BLOCKED", async () => {
  let finishInput;
  let finalizeCalled = false;
  const dUnknown = deps({
    repository: repository({
      async finish(input) {
        finishInput = input;
        return { ok: true, data: null };
      },
      async finalizeCreate() {
        finalizeCalled = true;
        return { ok: true, data: { intent_id: INTENT, intent_state: "BLOCKED", account_ref: null } };
      },
    }),
    auth: auth({
      async readAuthUserProvenance() { return { kind: "unknown" }; },
    }),
  });
  const resUnknown = await createAccount(fakeRequest(VALID_CREATE), "true", dUnknown);
  assert.equal(resUnknown.status, 200);
  const bodyUnknown = await resUnknown.json();
  assert.deepEqual(bodyUnknown, {
    ok: true,
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "INDETERMINATE",
      account_ref: null,
    },
  });
  assert.equal(finalizeCalled, false, "transient provenance error must not finalize/BLOCK");
  assert.equal(finishInput.outcome, "INDETERMINATE");
  assert.equal(finishInput.failure_code, "provenance_unknown");

  const dFinishFail = deps({
    repository: repository({
      async finish() { return { ok: false, kind: "unavailable" }; },
    }),
    auth: auth({
      async readAuthUserProvenance() { return { kind: "unknown" }; },
    }),
  });
  const resFail = await createAccount(fakeRequest(VALID_CREATE), "true", dFinishFail);
  assert.equal(resFail.status, 500);
  assert.deepEqual(await resFail.json(), { ok: false, code: "ACCOUNT_OPERATION_UNAVAILABLE" });
});

test("HF-Replay: reconcileIntent resolves APPLIED (even with login_id: null after PII purge) without calling Auth", async () => {
  const cachedAccount = {
    app_user_id: APP_USER,
    auth_subject: CREATED_AUTH,
    display_name: "Nguyen Van A",
    version: 1,
    revision_id: REV,
    intent_id: INTENT,
    intent_state: "APPLIED",
  };
  const dCached = deps({
    repository: repository({
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "APPLIED", login_id: null, display_name: null }) };
      },
      async finalizeCreate() {
        return { ok: true, data: cachedAccount };
      },
    }),
    auth: noAuthCalls(),
  });
  const resCached = await reconcileIntent(
    fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dCached,
  );
  assert.equal(resCached.status, 200);
  assert.deepEqual(await resCached.json(), {
    ok: true,
    replayed: true,
    account: cachedAccount,
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: APP_USER,
    },
  });

  let queriedTarget;
  const dHydrated = deps({
    repository: repository({
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "APPLIED", login_id: null, display_name: null }) };
      },
      async finalizeCreate() {
        return { ok: true, data: { intent_id: INTENT, intent_state: "APPLIED", account_ref: APP_USER } };
      },
    }),
    accountAccess: {
      async getAccount(input) {
        queriedTarget = input.target_app_user_id;
        return {
          ok: true,
          data: {
            account_ref: APP_USER,
            display_name: "Nguyen Van A",
            login_id: "nv-a",
            enabled: true,
            version: 3,
            account_type: "NORMAL",
            active_person_link: null,
          },
        };
      },
    },
    auth: noAuthCalls(),
  });
  const resHydrated = await reconcileIntent(
    fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dHydrated,
  );
  assert.equal(resHydrated.status, 200);
  assert.equal(queriedTarget, APP_USER);
  assert.deepEqual(await resHydrated.json(), {
    ok: true,
    replayed: true,
    account: {
      app_user_id: APP_USER,
      auth_subject: CREATED_AUTH,
      display_name: "Nguyen Van A",
      version: 3,
      revision_id: null,
      intent_id: INTENT,
      intent_state: "APPLIED",
    },
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: APP_USER,
    },
  });
});

test("HF-Replay: reconcileIntent handles terminal states, PENDING, and IN_FLIGHT/INDETERMINATE match & mismatch", async () => {
  for (const state of ["BLOCKED", "CONFLICT", "FAILED", "EXPIRED"]) {
    const d = deps({
      repository: repository({
        async readIntent() {
          return { ok: true, data: createIntentRead({ state, account_ref: null, auth_subject: null }) };
        },
      }),
      auth: noAuthCalls(),
    });
    const res = await reconcileIntent(fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", d);
    assert.equal(res.status, 200, state);
    assert.deepEqual(await res.json(), {
      ok: true,
      replayed: true,
      intent: {
        intent_id: INTENT,
        intent_token: TOKEN,
        kind: "CREATE_ACCOUNT",
        state,
        account_ref: null,
      },
    }, state);
  }

  const dPending = deps({
    repository: repository({
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "PENDING", account_ref: null, auth_subject: null }) };
      },
    }),
    auth: noAuthCalls(),
  });
  const resPending = await reconcileIntent(fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dPending);
  assert.equal(resPending.status, 409);
  assert.deepEqual(await resPending.json(), { ok: false, code: "ACCOUNT_OPERATION_CONFLICT" });

  // IN_FLIGHT / INDETERMINATE match -> finalized account
  for (const state of ["IN_FLIGHT", "INDETERMINATE"]) {
    const dMatch = deps({
      repository: repository({
        async readIntent() {
          return { ok: true, data: createIntentRead({ state, account_ref: null, auth_subject: null }) };
        },
      }),
      auth: auth({
        async findAuthUserByLoginId() { return { kind: "match", auth_subject: CREATED_AUTH }; },
      }),
    });
    const resMatch = await reconcileIntent(fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dMatch);
    assert.equal(resMatch.status, 200, state);
    const bodyMatch = await resMatch.json();
    assert.equal(bodyMatch.ok, true, state);
    assert.equal(bodyMatch.account.app_user_id, APP_USER, state);
    assert.equal("replayed" in bodyMatch, false, state);
  }

  // INDETERMINATE mismatch -> BLOCKED with account_ref: null
  const dMismatch = deps({
    repository: repository({
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "INDETERMINATE", account_ref: null, auth_subject: null }) };
      },
      async finalizeCreate(input) {
        assert.notEqual(input.intent_token, TOKEN, "mismatch must forward MISMATCH_TOKEN");
        return { ok: true, data: { intent_id: INTENT, intent_state: "BLOCKED", account_ref: null } };
      },
    }),
    auth: auth({
      async findAuthUserByLoginId() { return { kind: "mismatch", auth_subject: CREATED_AUTH }; },
    }),
  });
  const resMismatch = await reconcileIntent(fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dMismatch);
  assert.equal(resMismatch.status, 200);
  assert.deepEqual(await resMismatch.json(), {
    ok: true,
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "BLOCKED",
      account_ref: null,
    },
  });

  // INDETERMINATE race: finalizeCreate observes concurrent APPLIED -> resolves via accountAccess
  const dRace = deps({
    repository: repository({
      async readIntent() {
        return { ok: true, data: createIntentRead({ state: "INDETERMINATE", account_ref: null, auth_subject: null }) };
      },
      async finalizeCreate() {
        return { ok: true, data: { intent_id: INTENT, intent_state: "APPLIED", account_ref: APP_USER } };
      },
    }),
    accountAccess: {
      async getAccount() {
        return {
          ok: true,
          data: {
            account_ref: APP_USER,
            display_name: "Nguyen Van A",
            login_id: "nv-a",
            enabled: true,
            version: 1,
            account_type: "NORMAL",
            active_person_link: null,
          },
        };
      },
    },
    auth: auth({
      async findAuthUserByLoginId() { return { kind: "match", auth_subject: CREATED_AUTH }; },
    }),
  });
  const resRace = await reconcileIntent(fakeRequest({ idempotency_key: RECONCILE_KEY }), INTENT, "true", dRace);
  assert.equal(resRace.status, 200);
  assert.deepEqual(await resRace.json(), {
    ok: true,
    replayed: true,
    account: {
      app_user_id: APP_USER,
      auth_subject: CREATED_AUTH,
      display_name: "Nguyen Van A",
      version: 1,
      revision_id: null,
      intent_id: INTENT,
      intent_state: "APPLIED",
    },
    intent: {
      intent_id: INTENT,
      intent_token: TOKEN,
      kind: "CREATE_ACCOUNT",
      state: "APPLIED",
      account_ref: APP_USER,
    },
  });
});

test("HF-Replay: resetPassword claim loser stays strictly 409 (no replay) and never calls Auth", async () => {
  let resetCalled = false;
  const d = deps({
    repository: repository({
      async begin() {
        return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "PENDING" } };
      },
      async claim() {
        return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "APPLIED", claimed: false } };
      },
    }),
    auth: auth({
      async resetAuthPassword() { resetCalled = true; return { kind: "applied" }; },
    }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123",
    password_confirm: "new-pass-123",
    reason: "reset",
    idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_OPERATION_CONFLICT" });
  assert.equal(resetCalled, false, "resetPassword must never replay Auth on claim loss");
});
