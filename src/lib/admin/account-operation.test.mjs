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

test("D3: create account claim loser returns 409 and never calls Auth", async () => {
  let authCalled = false;
  const d = deps({
    repository: repository({
      async claim() { return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", claimed: false } }; },
    }),
    auth: auth({ async createAuthAccount() { authCalled = true; return { kind: "created", auth_subject: CREATED_AUTH }; } }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 409);
  assert.equal(authCalled, false, "no second Auth call on claim loss");
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
