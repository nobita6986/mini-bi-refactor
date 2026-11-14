import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_LIST_PAGE_SIZE,
  buildAccountListQuery,
  buildAccountStateRequest,
  classifyAccountMutation,
  newAccountIntentKey,
  projectAccountItem,
  projectAccountListForQuery,
} from "./account-access-model.ts";

const REF = "10000000-0000-4000-8000-000000000001";
const KEY = "20000000-0000-4000-8000-000000000002";
const account = {
  account_ref: REF,
  display_name: "Nguyễn Văn A",
  login_id: "vana.td",
  enabled: true,
  version: 3,
  account_type: "NORMAL",
  active_person_link: null,
};

function listPayload(overrides = {}) {
  return {
    ok: true,
    list: {
      search: null,
      enabled: "all",
      page: 1,
      page_size: ACCOUNT_LIST_PAGE_SIZE,
      total: 1,
      accounts: [account],
      ...overrides,
    },
  };
}

test("strict list projection retains only contracted account fields and echoes the query", () => {
  const list = projectAccountListForQuery(listPayload(), { search: "", enabled: "all", page: 1 });
  assert.ok(list);
  assert.deepEqual(Object.keys(list.accounts[0]).sort(), [
    "account_ref",
    "account_type",
    "active_person_link",
    "display_name",
    "enabled",
    "login_id",
    "version",
  ]);
  assert.equal(list.accounts[0].display_name, "Nguyễn Văn A");
  assert.equal(list.total, 1);
  // Echo mismatch fails closed.
  assert.equal(projectAccountListForQuery(listPayload({ enabled: "true" }),
    { search: "", enabled: "all", page: 1 }), null);
  assert.equal(projectAccountListForQuery(listPayload({ page: 2 }),
    { search: "", enabled: "all", page: 1 }), null);
  assert.equal(projectAccountListForQuery(listPayload({ page_size: 100 }),
    { search: "", enabled: "all", page: 1 }), null);
  assert.equal(projectAccountListForQuery(listPayload({ search: "abc" }),
    { search: "", enabled: "all", page: 1 }), null);
  // A requested search must be echoed trimmed, or the response is rejected.
  assert.equal(projectAccountListForQuery(listPayload({ search: "Nguyễn" }),
    { search: "  Nguyễn ", enabled: "all", page: 1 })?.accounts.length, 1);
});

test("list and item projections fail closed on any malformed or widened payload", () => {
  // Wrong envelope keys.
  assert.equal(projectAccountListForQuery({ ok: true, accounts: [] },
    { search: "", enabled: "all", page: 1 }), null);
  assert.equal(projectAccountListForQuery({ ok: false, list: {} },
    { search: "", enabled: "all", page: 1 }), null);
  // Extra/missing account key, empty name, non-UUID ref, version < 1.
  assert.equal(projectAccountItem({ ok: true, account: { ...account, email: "a@b.c" } }), null);
  assert.equal(projectAccountItem({ ok: true, account: { ...account, display_name: "" } }), null);
  assert.equal(projectAccountItem({ ok: true, account: { ...account, display_name: " A " } }), null);
  assert.deepEqual(projectAccountItem({ ok: true, account: { ...account, display_name: null } }),
    { ...account, display_name: null });
  assert.equal(projectAccountItem({ ok: true, account: { ...account, account_ref: "not-a-uuid" } }), null);
  assert.equal(projectAccountItem({ ok: true, account: { ...account, version: 0 } }), null);
  assert.equal(projectAccountItem({ ok: true, account: { ...account, enabled: "true" } }), null);
  // A list carrying a widened account is rejected wholesale.
  assert.equal(projectAccountListForQuery(
    { ok: true, list: { ...listPayload().list, accounts: [{ ...account, auth_subject: "x" }] } },
    { search: "", enabled: "all", page: 1 }), null);
  const ok = projectAccountItem({ ok: true, account });
  assert.ok(ok);
  assert.deepEqual(Object.keys(ok).sort(), [
    "account_ref",
    "account_type",
    "active_person_link",
    "display_name",
    "enabled",
    "login_id",
    "version",
  ]);
  assert.equal(projectAccountItem({ ok: true, account: { ...account, login_id: "bad@login" } }), null);
});

test("search, enabled filter and pagination use a bounded explicit API query", () => {
  assert.equal(buildAccountListQuery({ search: "  ABC ", enabled: "true", page: 3 })?.toString(),
    "enabled=true&page=3&page_size=25&search=ABC");
  assert.equal(buildAccountListQuery({ search: "", enabled: "all", page: 1 })?.toString(),
    "enabled=all&page=1&page_size=25");
  assert.equal(buildAccountListQuery({ search: "x", enabled: "false", page: 1001 }), null);
  assert.equal(buildAccountListQuery({ search: "x", enabled: "all", page: 0 }), null);
  assert.equal(buildAccountListQuery({ search: "x".repeat(257), enabled: "all", page: 1 }), null);
  assert.equal(buildAccountListQuery({ search: "x", enabled: "bogus", page: 1 }), null);
});

test("enable/disable body carries exactly expected_version, optional reason and idempotency_key", () => {
  const result = buildAccountStateRequest({ expectedVersion: 3, reason: "Ngừng theo yêu cầu", idempotencyKey: KEY });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.body).sort(),
    ["expected_version", "idempotency_key", "reason"]);
  assert.equal(result.body.expected_version, 3);
  assert.equal(result.body.idempotency_key, KEY);
  // Optional reason is canonicalized; OCC and idempotency validation stay strict.
  for (const input of [{}, { reason: null }, { reason: "" }, { reason: "   " }]) {
    const optional = buildAccountStateRequest({ expectedVersion: 3, ...input, idempotencyKey: KEY });
    assert.equal(optional.ok, true);
    if (optional.ok) assert.equal(optional.body.reason, null);
  }
  assert.equal(buildAccountStateRequest({ expectedVersion: 0, reason: "x", idempotencyKey: KEY }).ok, false);
  assert.equal(buildAccountStateRequest({ expectedVersion: 1.5, reason: "x", idempotencyKey: KEY }).ok, false);
  assert.equal(buildAccountStateRequest({ expectedVersion: 3, reason: "x", idempotencyKey: "not-a-uuid" }).ok, false);
  assert.equal(buildAccountStateRequest({ expectedVersion: 3, reason: "x".repeat(4001), idempotencyKey: KEY }).ok, false);
});

test("mutation success is exactly {ok:true} with no optimistic projection", () => {
  const applied = classifyAccountMutation(200, { ok: true });
  assert.deepEqual(applied, { kind: "applied" });
  // Any projected row on success is malformed: the client must reload, never trust it.
  assert.equal(classifyAccountMutation(200, { ok: true, account }).kind, "unavailable");
  assert.equal(classifyAccountMutation(200, { ok: true, list: listPayload().list }).kind, "unavailable");
  assert.equal(classifyAccountMutation(200, { ok: false }).kind, "unavailable");
  assert.equal(classifyAccountMutation(200, null).kind, "unavailable");
});

test("error statuses map to distinct sanitized outcomes without leaking raw codes", () => {
  const cases = [
    [409, { ok: false, code: "ACCOUNT_CONFLICT" }, "conflict"],
    [403, { ok: false, code: "ACCOUNT_DENIED" }, "denied"],
    [403, { ok: false, code: "ACTOR_NOT_AVAILABLE" }, "actor-not-available"],
    [403, null, "denied"],
    [401, { ok: false, code: "UNAUTHENTICATED" }, "unauthenticated"],
    [404, { ok: false, code: "ACCOUNT_NOT_FOUND" }, "not-found"],
    [400, { ok: false, code: "ACCOUNT_INVALID" }, "invalid"],
    [422, { ok: false, code: "ACCOUNT_INVALID" }, "invalid"],
    [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }, "unavailable"],
    [503, null, "unavailable"],
  ];
  for (const [status, payload, kind] of cases) {
    const outcome = classifyAccountMutation(status, payload);
    assert.equal(outcome.kind, kind, `status ${status}`);
    if (outcome.kind !== "applied") {
      assert.equal(typeof outcome.message, "string");
      assert.ok(outcome.message.length > 0);
      assert.doesNotMatch(outcome.message, /ACCOUNT_|ACTOR_NOT_AVAILABLE|UNAUTHENTICATED/);
    }
  }
});

test("each intent gets a fresh UUID idempotency key", () => {
  const first = newAccountIntentKey();
  const second = newAccountIntentKey();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
