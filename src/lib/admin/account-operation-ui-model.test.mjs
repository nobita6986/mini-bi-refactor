import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateAccountRequest,
  buildEditDisplayNameRequest,
  buildEligibleAccountsQuery,
  buildLinkRecruiterAccountRequest,
  buildPersonnelFromAccountRequest,
  buildReconcileRequest,
  buildRecruiterLinkStatusQuery,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  projectEligibleAccounts,
  projectRecruiterLinkCandidates,
  projectRecruiterLinkStatus,
} from "./account-operation-ui-model.ts";

const KEY = "91000000-0000-4000-8000-000000000001";
const ACCOUNT = "92000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "92000000-0000-4000-8000-000000000002";
const AUTH_SUB = "93000000-0000-4000-8000-000000000001";
const REV = "94000000-0000-4000-8000-000000000001";
const TOKEN = "95000000-0000-4000-8000-000000000001";
const RECRUITER = "96000000-0000-4000-8000-000000000001";
const LINK = "97000000-0000-4000-8000-000000000001";
const MEMBER = "98000000-0000-4000-8000-000000000001";
const OTHER_INTENT = "99000000-0000-4000-8000-000000000001";

const VALID_FINALIZED_ACCOUNT = {
  app_user_id: ACCOUNT,
  auth_subject: AUTH_SUB,
  display_name: "Nguyen Van A",
  version: 1,
  revision_id: REV,
  intent_id: KEY,
  intent_state: "APPLIED",
};
const VALID_PR13_FALLBACK_ACCOUNT = {
  app_user_id: ACCOUNT,
  auth_subject: null,
  display_name: "Nguyen Van A",
  version: 2,
  revision_id: null,
  intent_id: KEY,
  intent_state: "APPLIED",
};
const VALID_PR13_APPLIED_INTENT = {
  intent_id: KEY,
  intent_token: TOKEN,
  kind: "CREATE_ACCOUNT",
  state: "APPLIED",
  account_ref: ACCOUNT,
};
const VALID_EDIT_NAME_ACCOUNT = {
  app_user_id: ACCOUNT,
  version: 3,
  revision_id: REV,
  recruiter_id: null,
  recruiter_version: null,
  recruiter_revision_id: null,
};
const VALID_PERSONNEL_FROM_ACCOUNT = {
  recruiter_id: RECRUITER,
  display_name: "Nguyen Van A",
  personnel_code: "staff01",
  personnel_position: "STAFF",
  version: 1,
  link_id: LINK,
  membership_id: MEMBER,
  app_user_version: 2,
  app_user_revision_id: REV,
  personnel_revision_id: REV,
};
const VALID_LINK_RECRUITER = {
  link_id: LINK,
  app_user_id: ACCOUNT,
  app_user_version: 2,
  app_user_revision_id: REV,
  recruiter_id: RECRUITER,
  recruiter_version: 3,
  personnel_code: "staff01",
  valid_from: "2026-11-19",
};
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

test("D3-B UI: create requires canonical login and matching password; action reason is optional", () => {
  const ok = buildCreateAccountRequest({
    loginId: "nv-a", displayName: "Nguyen Van A", password: "strong-pass-123",
    passwordConfirm: "strong-pass-123", reason: "create", idempotencyKey: KEY,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.login_id, "nv-a");
  assert.equal("password" in ok.body && "password_confirm" in ok.body, true);
  const withoutReason = buildCreateAccountRequest({ loginId: "nv-a", displayName: "A",
    password: "x1234567", passwordConfirm: "x1234567", idempotencyKey: KEY });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);

  assert.equal(buildCreateAccountRequest({ loginId: "Bad Login", displayName: "A", password: "x1234567", passwordConfirm: "x1234567", reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildCreateAccountRequest({ loginId: "nv-a", displayName: "A", password: "x1234567", passwordConfirm: "different", reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildCreateAccountRequest({ loginId: "nv-a", displayName: "A", password: "short", passwordConfirm: "short", reason: "r", idempotencyKey: KEY }).ok, false);
});

test("D3-B UI: edit display name and reset password build exact bodies", () => {
  const edit = buildEditDisplayNameRequest({ displayName: "New Name", expectedVersion: 2, reason: "rename", idempotencyKey: KEY });
  assert.equal(edit.ok, true);
  assert.deepEqual(edit.body, { display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: KEY });
  const editWithoutReason = buildEditDisplayNameRequest({ displayName: "New Name", expectedVersion: 2,
    idempotencyKey: KEY });
  assert.equal(editWithoutReason.ok, true);
  if (editWithoutReason.ok) assert.equal(editWithoutReason.body.reason, null);

  const reset = buildResetPasswordRequest({ password: "new-pass-123", passwordConfirm: "new-pass-123", reason: "reset", idempotencyKey: KEY });
  assert.equal(reset.ok, true);
  assert.deepEqual(Object.keys(reset.body).sort(), ["idempotency_key", "password", "password_confirm", "reason"]);
  const resetWithoutReason = buildResetPasswordRequest({ password: "new-pass-123",
    passwordConfirm: "new-pass-123", idempotencyKey: KEY });
  assert.equal(resetWithoutReason.ok, true);
  if (resetWithoutReason.ok) assert.equal(resetWithoutReason.body.reason, null);

  assert.equal(buildReconcileRequest(KEY).ok, true);
});

test("D3-B UI: personnel-from-account keeps display_name server-side (not a field)", () => {
  const built = buildPersonnelFromAccountRequest({
    accountRef: ACCOUNT, expectedAccountVersion: 1, loginId: "staff01",
    personnelPosition: "STAFF", validFrom: TODAY_VN, reason: "create", idempotencyKey: KEY,
  });
  assert.equal(built.ok, true);
  assert.equal("display_name" in built.body, false, "display_name must not be sent from the browser");
  assert.equal(built.body.personnel_code, "staff01", "account login ID becomes personnel code");
});

test("D3-C UI: eligible accounts projection exposes real name + login ID without email", () => {
  const query = buildEligibleAccountsQuery(1);
  assert.ok(query);
  assert.equal(query.get("page"), "1");
  assert.equal(query.get("page_size"), "25");

  const list = projectEligibleAccounts({
    ok: true,
    list: { page: 1, page_size: 25, total: 1, has_more: false, accounts: [{ app_user_id: ACCOUNT, display_name: "Nguyen Van A", login_id: "staff01" }] },
  });
  assert.equal(list.accounts.length, 1);
  assert.equal(list.accounts[0].display_name, "Nguyen Van A");
  assert.equal(list.accounts[0].login_id, "staff01");
  // No email/login/auth_subject/internal link ids in the projection.
  assert.equal(projectEligibleAccounts({ ok: true, list: { page: 1, page_size: 25, total: 1, has_more: false, accounts: [{ app_user_id: ACCOUNT, display_name: "X", login_id: "staff01", email: "x@hrpartner.vn" }] } }), null);
});

test("D3-B UI: response classifier surfaces needs-reconcile states without password/ref leak", () => {
  assert.equal(
    classifyAccountOperationResponse(
      200,
      { ok: true, account: VALID_FINALIZED_ACCOUNT },
      { operation: "create_account" },
    ).kind,
    "applied",
  );
  const blocked = classifyAccountOperationResponse(
    200,
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "BLOCKED" } },
    { operation: "create_account" },
  );
  assert.equal(blocked.kind, "needs-reconcile");
  assert.equal(blocked.state, "BLOCKED");
  assert.match(blocked.message, /provenance/i);
  const indeterminate = classifyAccountOperationResponse(
    200,
    {
      ok: true,
      intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "INDETERMINATE", account_ref: null },
    },
    { operation: "create_account" },
  );
  assert.equal(indeterminate.kind, "needs-reconcile");
  assert.match(indeterminate.message, /Không tự thử lại/);
});

test("reset errors distinguish confirmed Auth success from unknown outcome without exposing raw codes", () => {
  const appliedUnrecorded = classifyAccountOperationResponse(500, {
    ok: false, code: "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED",
  });
  assert.equal(appliedUnrecorded.kind, "unavailable");
  assert.match(appliedUnrecorded.message, /Auth đã xác nhận đổi mật khẩu/);
  assert.match(appliedUnrecorded.message, /Không gửi lại/);
  assert.doesNotMatch(appliedUnrecorded.message, /ACCOUNT_OPERATION_/);

  for (const code of ["ACCOUNT_OPERATION_INDETERMINATE", "ACCOUNT_OPERATION_RESULT_UNRECORDED"]) {
    const unknown = classifyAccountOperationResponse(500, { ok: false, code });
    assert.equal(unknown.kind, "unavailable");
    assert.equal(unknown.preserveIdempotencyKey, false);
    assert.equal(unknown.manualCheckRequired, true);
    assert.match(unknown.message, /Chưa xác định được kết quả/);
    assert.match(unknown.message, /Không gửi lại ngay/);
    assert.match(unknown.message, /Admin cần kiểm tra/);
    assert.doesNotMatch(unknown.message, /ACCOUNT_OPERATION_/);
  }
});

test("response classifier strictly validates PR #13 CREATE/reconcile/EDIT/RESET/personnel contracts and rejects malformed 200", () => {
  const expectUncertain = (payload, context) => {
    const out = classifyAccountOperationResponse(200, payload, context);
    assert.equal(out.kind, "unavailable", `expected unavailable for ${JSON.stringify(payload)}`);
    if (out.kind === "unavailable") {
      assert.equal(out.preserveIdempotencyKey, true);
      assert.notEqual(out.manualCheckRequired, true);
    }
  };

  // 1) Valid PR #13 CREATE_ACCOUNT & reconcile responses
  for (const okCreatePayload of [
    { ok: true, account: VALID_FINALIZED_ACCOUNT },
    { ok: true, replayed: true, account: VALID_FINALIZED_ACCOUNT, intent: VALID_PR13_APPLIED_INTENT },
    { ok: true, replayed: true, account: VALID_PR13_FALLBACK_ACCOUNT, intent: VALID_PR13_APPLIED_INTENT },
    { ok: true, replayed: true, intent: VALID_PR13_APPLIED_INTENT },
  ]) {
    assert.equal(
      classifyAccountOperationResponse(200, okCreatePayload, { operation: "create_account" }).kind,
      "applied",
    );
    assert.equal(
      classifyAccountOperationResponse(200, okCreatePayload, {
        operation: "reconcile_create_account",
        expectedIntentId: KEY,
      }).kind,
      "applied",
    );
    // Contextless 2-arg call accepts valid canonical envelopes too
    assert.equal(classifyAccountOperationResponse(200, okCreatePayload).kind, "applied");
  }

  // Non-APPLIED canonical CREATE_ACCOUNT states route to needs-reconcile
  for (const state of ["PENDING", "IN_FLIGHT", "INDETERMINATE", "BLOCKED", "CONFLICT", "FAILED", "EXPIRED"]) {
    const out = classifyAccountOperationResponse(
      200,
      { ok: true, replayed: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state, account_ref: null } },
      { operation: "create_account" },
    );
    assert.equal(out.kind, "needs-reconcile");
    if (out.kind === "needs-reconcile") {
      assert.equal(out.intentId, KEY);
      assert.equal(out.state, state);
    }
  }

  // 2) Malformed / incomplete CREATE_ACCOUNT & reconcile 200 payloads stay uncertain (never applied, never needs-reconcile)
  for (const badCreatePayload of [
    null,
    { ok: false },
    { ok: true },
    { ok: true, account: {} },
    { ok: true, account: { app_user_id: ACCOUNT } },
    { ok: true, account: { ...VALID_FINALIZED_ACCOUNT, intent_state: "BANANA" } },
    { ok: true, intent: "bad" },
    { ok: true, intent: { state: "APPLIED", intent_id: "not-uuid" } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED" } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", account_ref: null } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "APPLIED", account_ref: "not-uuid" } },
    { ok: true, intent: { intent_id: KEY, intent_token: "not-uuid", kind: "CREATE_ACCOUNT", state: "APPLIED", account_ref: ACCOUNT } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "APPLIED", account_ref: ACCOUNT } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "INDETERMINATE", account_ref: ACCOUNT } },
    { ok: true, intent: { intent_id: KEY, state: "BANANA" } },
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "BANANA", account_ref: null } },
    { ok: true, intent: { intent_id: KEY, state: "INDETERMINATE" } },
    { ok: true, intent: { intent_id: "not-a-uuid", intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "INDETERMINATE" } },
    { ok: true, replayed: true, account: VALID_FINALIZED_ACCOUNT, intent: { ...VALID_PR13_APPLIED_INTENT, account_ref: OTHER_ACCOUNT } },
    { ok: true, replayed: true, account: VALID_FINALIZED_ACCOUNT, intent: { ...VALID_PR13_APPLIED_INTENT, intent_id: OTHER_INTENT } },
    { ok: true, account: VALID_FINALIZED_ACCOUNT, intent: { intent_id: KEY, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", account_ref: null } },
  ]) {
    expectUncertain(badCreatePayload, { operation: "create_account" });
    expectUncertain(badCreatePayload, { operation: "reconcile_create_account", expectedIntentId: KEY });
  }

  // Reconcile rejects valid payload belonging to a different intent_id
  expectUncertain(
    { ok: true, replayed: true, intent: { ...VALID_PR13_APPLIED_INTENT, intent_id: OTHER_INTENT } },
    { operation: "reconcile_create_account", expectedIntentId: KEY },
  );
  expectUncertain(
    { ok: true, account: { ...VALID_FINALIZED_ACCOUNT, intent_id: OTHER_INTENT } },
    { operation: "reconcile_create_account", expectedIntentId: KEY },
  );

  // Contextless 2-arg probe cases from T0 round 2 review
  expectUncertain({ ok: true, account: {} });
  expectUncertain({ ok: true, intent: { state: "APPLIED", intent_id: "not-uuid" } });
  expectUncertain({ ok: true, intent: { intent_id: KEY, state: "BANANA" } });

  // 3) EDIT_DISPLAY_NAME requires valid EditNameEnvelope matching expectedAccountRef
  assert.equal(
    classifyAccountOperationResponse(
      200,
      { ok: true, account: VALID_EDIT_NAME_ACCOUNT },
      { operation: "edit_display_name", expectedAccountRef: ACCOUNT },
    ).kind,
    "applied",
  );
  expectUncertain({ ok: true }, { operation: "edit_display_name", expectedAccountRef: ACCOUNT });
  expectUncertain({ ok: true, account: {} }, { operation: "edit_display_name", expectedAccountRef: ACCOUNT });
  expectUncertain(
    { ok: true, account: { ...VALID_EDIT_NAME_ACCOUNT, app_user_id: OTHER_ACCOUNT } },
    { operation: "edit_display_name", expectedAccountRef: ACCOUNT },
  );
  expectUncertain(
    { ok: true, intent: VALID_PR13_APPLIED_INTENT },
    { operation: "edit_display_name", expectedAccountRef: ACCOUNT },
  );

  // 4) RESET_PASSWORD accepts exact { ok: true } without requiring account, and rejects unexpected envelopes
  assert.equal(classifyAccountOperationResponse(200, { ok: true }, { operation: "reset_password" }).kind, "applied");
  assert.equal(classifyAccountOperationResponse(200, { ok: true }).kind, "applied");
  expectUncertain({ ok: true, account: {} }, { operation: "reset_password" });
  expectUncertain(
    { ok: true, intent: { intent_id: KEY, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "INDETERMINATE", account_ref: ACCOUNT } },
    { operation: "reset_password" },
  );
  expectUncertain({ ok: true, extra: true }, { operation: "reset_password" });

  // 5) personnel-catalog-manager callers (personnel_from_account & link_recruiter_account)
  assert.equal(
    classifyAccountOperationResponse(
      200,
      { ok: true, personnel: VALID_PERSONNEL_FROM_ACCOUNT },
      { operation: "personnel_from_account", expectedPersonnelCode: "staff01" },
    ).kind,
    "applied",
  );
  expectUncertain({ ok: true }, { operation: "personnel_from_account", expectedPersonnelCode: "staff01" });
  expectUncertain({ ok: true, personnel: {} }, { operation: "personnel_from_account", expectedPersonnelCode: "staff01" });
  expectUncertain(
    { ok: true, personnel: { ...VALID_PERSONNEL_FROM_ACCOUNT, personnel_code: "other02" } },
    { operation: "personnel_from_account", expectedPersonnelCode: "staff01" },
  );

  assert.equal(
    classifyAccountOperationResponse(
      200,
      { ok: true, link: VALID_LINK_RECRUITER },
      { operation: "link_recruiter_account", expectedRecruiterId: RECRUITER, expectedAccountRef: ACCOUNT },
    ).kind,
    "applied",
  );
  expectUncertain(
    { ok: true },
    { operation: "link_recruiter_account", expectedRecruiterId: RECRUITER, expectedAccountRef: ACCOUNT },
  );
  expectUncertain(
    { ok: true, link: {} },
    { operation: "link_recruiter_account", expectedRecruiterId: RECRUITER, expectedAccountRef: ACCOUNT },
  );
  expectUncertain(
    { ok: true, link: { ...VALID_LINK_RECRUITER, app_user_id: OTHER_ACCOUNT } },
    { operation: "link_recruiter_account", expectedRecruiterId: RECRUITER, expectedAccountRef: ACCOUNT },
  );

  // Generic 503 preserves idempotency key; 400/404 are deterministic invalid
  const s503 = classifyAccountOperationResponse(503, { ok: false, code: "ACCOUNT_OPERATION_UNAVAILABLE" });
  assert.equal(s503.kind, "unavailable");
  if (s503.kind === "unavailable") {
    assert.equal(s503.preserveIdempotencyKey, true);
    assert.notEqual(s503.manualCheckRequired, true);
  }
  assert.equal(classifyAccountOperationResponse(400, { ok: false }).kind, "invalid");
  assert.equal(classifyAccountOperationResponse(404, { ok: false }).kind, "invalid");
});

test("UI model builds and projects link-existing-personnel-account payloads strictly", () => {
  const built = buildLinkRecruiterAccountRequest({
    accountRef: ACCOUNT,
    expectedAccountVersion: 2,
    expectedRecruiterVersion: 3,
    reason: "Liên kết mkt.vp",
    idempotencyKey: KEY,
  });
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.deepEqual(built.body, {
      account_ref: ACCOUNT,
      expected_account_version: 2,
      expected_recruiter_version: 3,
      reason: "Liên kết mkt.vp",
      idempotency_key: KEY,
    });
  }
  const builtNoReason = buildLinkRecruiterAccountRequest({
    accountRef: ACCOUNT,
    expectedAccountVersion: 1,
    expectedRecruiterVersion: 1,
    idempotencyKey: KEY,
  });
  assert.equal(builtNoReason.ok, true);
  if (builtNoReason.ok) assert.equal(builtNoReason.body.reason, null);

  assert.equal(buildLinkRecruiterAccountRequest({
    accountRef: ACCOUNT,
    expectedAccountVersion: 0,
    expectedRecruiterVersion: 1,
    idempotencyKey: KEY,
  }).ok, false);

  const statusQuery = buildRecruiterLinkStatusQuery([ACCOUNT]);
  assert.ok(statusQuery);
  assert.equal(statusQuery.get("recruiter_ids"), ACCOUNT);
  assert.equal(buildRecruiterLinkStatusQuery(["invalid-uuid"]), null);

  assert.deepEqual(
    projectRecruiterLinkStatus({ ok: true, status: { linked_recruiter_ids: [ACCOUNT] } }),
    { linked_recruiter_ids: [ACCOUNT] },
  );
  const candidates = projectRecruiterLinkCandidates({
    ok: true,
    candidates: {
      recruiter_id: KEY,
      display_name: "Marketing Vĩnh Phúc",
      personnel_code: "mkt.vp",
      personnel_position: "TEAM_LEADER",
      active: true,
      version: 3,
      already_linked: false,
      candidates: [{ app_user_id: ACCOUNT, display_name: "Marketing Vĩnh Phúc", login_id: "mkt.vp", version: 2 }],
    },
  });
  assert.ok(candidates);
  assert.equal(candidates.candidates[0].login_id, "mkt.vp");
});
