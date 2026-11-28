import assert from "node:assert/strict";
import test from "node:test";

import {
  createVendorCatalog,
  getVendorCatalog,
  listVendorsCatalog,
  setVendorCatalogActive,
  updateVendorCatalog,
  vendorCatalogCreateRequest,
  vendorCatalogListQuery,
  vendorCatalogSetActiveRequest,
  vendorCatalogUpdateRequest,
} from "./vendor-catalog-api.ts";
import {
  vendorCatalogCreateResult,
  vendorCatalogItem,
  vendorCatalogList,
  vendorCatalogMutation,
} from "./vendor-catalog-contract.ts";
import { classifyVendorCatalogError, createVendorCatalogRepository } from "./vendor-catalog-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const VENDOR = "VENDOR_ONE";
const REV = "99999999-9999-4999-8999-999999999999";
const RECRUITER = "88888888-8888-4888-8888-888888888888";
const OTHER = "77777777-7777-4777-8777-777777777777";
const PARTNER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PARTNER_APP_USER_ID = "44444444-4444-4444-8444-444444444444";

const PARTNER_ACCOUNT = {
  partner_account_id: PARTNER_ACCOUNT_ID,
  partner_kind: "VENDOR",
  vendor_id: VENDOR,
  collaborator_id: null,
  partner_id: VENDOR,
  canonical_code: "vendor_one",
  account_state: "PENDING_ACTIVATION",
  app_user_id: PARTNER_APP_USER_ID,
  username: "vendor_one",
  activated_at: null,
  must_change_password: true,
  password_changed_at: null,
  activation_expires_at: "2026-12-05T10:00:00Z",
  activation_attempts: 0,
  version: 2,
};

const ITEM = {
  vendor_id: VENDOR,
  display_name: "Synthetic Vendor",
  address: "123 Nguyen Trai, Q.1",
  phone: "+84 901 234 567",
  active: true,
  version: 2,
  revision_count: 2,
  recruiter_id: RECRUITER,
  partner_account: PARTNER_ACCOUNT,
};
const MUTATION = {
  vendor_id: VENDOR,
  display_name: "Synthetic Vendor",
  address: "123 Nguyen Trai, Q.1",
  phone: "+84 901 234 567",
  active: true,
  version: 3,
  revision_id: REV,
  recruiter_id: RECRUITER,
  partner_account: PARTNER_ACCOUNT,
};
const CREATE = { ...MUTATION, created: true };
const LIST = {
  authorization_date: "2026-10-09",
  include_inactive: true,
  search: null,
  page: 1,
  page_size: 25,
  total: 1,
  vendors: [ITEM],
};

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listVendors: async (i) => { calls.rpc.push(["list", i]); return result; },
        getVendor: async (i) => { calls.rpc.push(["get", i]); return result; },
        createVendor: async (i) => { calls.rpc.push(["create", i]); return result; },
        updateVendor: async (i) => { calls.rpc.push(["update", i]); return result; },
        setVendorActive: async (i) => { calls.rpc.push(["active", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, path = "/api/admin/catalog/vendors", headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const CREATE_BODY = { expected_version: 0, vendor_id: VENDOR, display_name: "Synthetic Vendor",
  valid_from: "2024-01-01", reason: "Synthetic reason", idempotency_key: KEY };
const UPDATE_BODY = { expected_version: 2, display_name: "Synthetic Vendor",
  reason: "Synthetic reason", idempotency_key: KEY };
const ACTIVE_BODY = { active: false, expected_version: 2,
  reason: "Synthetic reason", idempotency_key: KEY };

test("the contract accepts exactly the reviewed projection shapes", () => {
  assert.deepEqual(vendorCatalogItem(ITEM), ITEM);
  assert.deepEqual(vendorCatalogList(LIST), LIST);
  assert.deepEqual(vendorCatalogMutation(MUTATION), MUTATION);
  assert.deepEqual(vendorCatalogCreateResult(CREATE), CREATE);

  // Legacy vendor without representation recruiter, address, phone, or partner_account keeps nulls.
  const legacy = { ...ITEM, address: null, phone: null, recruiter_id: null, partner_account: null };
  assert.deepEqual(vendorCatalogItem(legacy), legacy);

  // Fail closed on missing/extra keys or malformed address/phone/partner_account.
  assert.equal(vendorCatalogItem({ ...ITEM, extra: 1 }), null);
  const withoutName = { ...ITEM };
  delete withoutName.display_name;
  assert.equal(vendorCatalogItem(withoutName), null);
  const withoutAddress = { ...ITEM };
  delete withoutAddress.address;
  assert.equal(vendorCatalogItem(withoutAddress), null);
  const withoutPartnerAccount = { ...ITEM };
  delete withoutPartnerAccount.partner_account;
  assert.equal(vendorCatalogItem(withoutPartnerAccount), null);

  assert.equal(vendorCatalogItem({ ...ITEM, active: "true" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, version: -1 }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, revision_count: "2" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, recruiter_id: 42 }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, recruiter_id: "" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, address: "" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, address: "  untrimmed " }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, address: "bad\nline" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, address: "a".repeat(501) }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, phone: "12345" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, phone: "090123abc" }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, phone: "1".repeat(33) }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, extra: 1 } }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, partner_kind: "COLLABORATOR" } }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, account_state: "BOGUS" } }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, version: 0 } }), null);
  assert.equal(vendorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, partner_id: "OTHER" } }), null);
  assert.equal(vendorCatalogItem(null), null);
  assert.equal(vendorCatalogList({ ...LIST, vendors: [{ ...ITEM, version: 1.5 }] }), null);
  assert.equal(vendorCatalogList({ ...LIST, total: 0 }), null,
    "a total below the returned page is malformed");
  assert.equal(vendorCatalogCreateResult({ ...CREATE, created: false }), null);
  assert.equal(vendorCatalogMutation({ ...MUTATION, revision_count: 2 }), null);
});

test("the feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listVendorsCatalog(new Request("https://app.test/x"), "false", d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createVendorCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/vendors", { origin: "https://evil.test" }),
    "true", d.dependencies);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("content-type, body and client authority fields are rejected before session", async () => {
  const d = deps({ ok: true, data: CREATE });
  const wrongType = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test" },
    body: "{}" });
  assert.equal((await createVendorCatalog(wrongType, "true", d.dependencies)).status, 400);

  const broken = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", host: "app.test" },
    body: "{not json" });
  const brokenRes = await createVendorCatalog(broken, "true", d.dependencies);
  assert.equal(brokenRes.status, 400);
  assert.equal((await brokenRes.json()).code, "BODY_INVALID");

  for (const forbidden of [{ actor: "x" }, { auth_subject: "x" }, { capabilities: [] },
    { scope: "all" }, { role: "admin" }, { app_user_id: "x" }, { scopes: [] }]) {
    const res = await createVendorCatalog(
      jsonRequest({ ...CREATE_BODY, ...forbidden }), "true", d.dependencies);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("request projections are strict; optional address and phone normalize cleanly", () => {
  assert.equal(vendorCatalogCreateRequest(CREATE_BODY).ok, true);
  assert.deepEqual(vendorCatalogCreateRequest(CREATE_BODY).value, {
    expected_version: 0,
    vendor_id: VENDOR,
    display_name: "Synthetic Vendor",
    valid_from: "2024-01-01",
    address: null,
    phone: null,
    reason: "Synthetic reason",
    idempotency_key: KEY,
  });

  const createWithContact = vendorCatalogCreateRequest({
    ...CREATE_BODY,
    address: "  123 Le Loi, Da Nang  ",
    phone: "  (028) 3822-1234 ",
  });
  assert.equal(createWithContact.ok, true);
  assert.equal(createWithContact.ok && createWithContact.value.address, "123 Le Loi, Da Nang");
  assert.equal(createWithContact.ok && createWithContact.value.phone, "(028) 3822-1234");

  for (const blank of [null, "", "   "]) {
    const parsed = vendorCatalogCreateRequest({ ...CREATE_BODY, address: blank, phone: blank });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.address, null);
      assert.equal(parsed.value.phone, null);
    }
  }

  for (const badAddr of [123, "x".repeat(501), "line1\nline2", "tab\there", "del\x7f"]) {
    assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, address: badAddr }).ok, false);
    assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, address: badAddr }).ok, false);
  }
  for (const badPhone of [123, "12345", "1".repeat(33), "0901234abc", "0901234#5"]) {
    assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, phone: badPhone }).ok, false);
    assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, phone: badPhone }).ok, false);
  }

  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, expected_version: 1 }).ok, false,
    "create must open the aggregate at version 0");
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "__system_vendor__" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "_VENDOR" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "has space" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "V".repeat(129) }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, vendor_id: "V".repeat(128) }).ok, true);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, display_name: "" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, valid_from: "01-01-2024" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, valid_from: "2024-02-31" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, valid_from: null }).ok, false);
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...CREATE_BODY };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const parsed = vendorCatalogCreateRequest(body);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.reason, null);
  }
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, reason: 123 }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, reason: "x".repeat(4001) }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, idempotency_key: "nope" }).ok, false);
  assert.equal(vendorCatalogCreateRequest({ ...CREATE_BODY, extra: 1 }).ok, false);

  assert.equal(vendorCatalogUpdateRequest(UPDATE_BODY).ok, true);
  const updateWithContact = vendorCatalogUpdateRequest({
    ...UPDATE_BODY,
    address: "  456 Hai Ba Trung ",
    phone: " 0909.888.777 ",
  });
  assert.deepEqual(updateWithContact.ok && updateWithContact.value, {
    expected_version: 2,
    display_name: "Synthetic Vendor",
    address: "456 Hai Ba Trung",
    phone: "0909.888.777",
    reason: "Synthetic reason",
    idempotency_key: KEY,
  });

  // PATCH must not accept the immutable identity or the active flag.
  assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, vendor_id: "VENDOR_TWO" }).ok, false);
  assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, active: false }).ok, false);
  assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, valid_from: "2024-01-01" }).ok, false);
  assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, expected_version: 0 }).ok, false);
  assert.equal(vendorCatalogUpdateRequest({ ...UPDATE_BODY, display_name: "" }).ok, false);

  assert.equal(vendorCatalogSetActiveRequest(ACTIVE_BODY).ok, true);
  assert.equal(vendorCatalogSetActiveRequest({ ...ACTIVE_BODY, active: "false" }).ok, false);
  assert.equal(vendorCatalogSetActiveRequest({ ...ACTIVE_BODY, expected_version: null }).ok, false);

  for (const [parse, valid] of [
    [vendorCatalogCreateRequest, CREATE_BODY],
    [vendorCatalogUpdateRequest, UPDATE_BODY],
    [vendorCatalogSetActiveRequest, ACTIVE_BODY],
  ]) {
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
  }

  const query = vendorCatalogListQuery(
    new URL("https://app.test/x?search=%20abc%20&page=2&page_size=10&include_inactive=false"));
  assert.deepEqual(query.ok && query.value,
    { search: "abc", include_inactive: false, page: 2, page_size: 10 });
  for (const value of ["", "1", "TRUE", "yes"]) {
    assert.equal(vendorCatalogListQuery(
      new URL("https://app.test/x?include_inactive=" + encodeURIComponent(value))).ok, false, value);
  }
  for (const search of ["?page=0", "?page=1001", "?page_size=0", "?page_size=101", "?page=abc",
    "?search=" + "x".repeat(257)]) {
    assert.equal(vendorCatalogListQuery(new URL("https://app.test/x" + search)).ok, false, search);
  }
  assert.equal(vendorCatalogListQuery(new URL("https://app.test/x?page_size=100")).ok, true);
  assert.equal(vendorCatalogListQuery(new URL("https://app.test/x?page=1000")).ok, true);
});

test("the session actor is the only actor source", async () => {
  const unauthenticated = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const denied = await listVendorsCatalog(new Request("https://app.test/x"), "true",
    unauthenticated.dependencies);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHENTICATED");

  const unavailable = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } });
  const actorUnavailable = await listVendorsCatalog(new Request("https://app.test/x"), "true",
    unavailable.dependencies);
  assert.equal(actorUnavailable.status, 403);
  assert.equal((await actorUnavailable.json()).code, "ACTOR_NOT_AVAILABLE");

  const strict = deps({ ok: true, data: LIST });
  const blocked = await listVendorsCatalog(
    new Request("https://app.test/x?include_inactive=yes"), "true", strict.dependencies);
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).code, "VENDOR_INVALID");
  assert.equal(strict.calls.rpc.length, 0);

  const d = deps({ ok: true, data: LIST });
  const res = await listVendorsCatalog(
    new Request("https://app.test/x?search=VENDOR&page=1&page_size=5"), "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = await res.json();
  assert.deepEqual(body.list, LIST);
  assert.deepEqual(d.calls.rpc[0][1],
    { ...ACTOR, search: "VENDOR", include_inactive: true, page: 1, page_size: 5 });
});

test("idempotency header mismatch is rejected before the repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createVendorCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/vendors", { "idempotency-key": OTHER }),
    "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(d.calls.rpc.length, 0);
});

test("mutations project strict responses and sanitized failures including PARTNER_CODE_CONFLICT", async () => {
  const ok = deps({ ok: true, data: CREATE });
  const created = await createVendorCatalog(jsonRequest(CREATE_BODY), "true", ok.dependencies);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ok: true, vendor: CREATE });

  const expected = {
    denied: [403, "VENDOR_DENIED"],
    "not-found": [404, "VENDOR_NOT_FOUND"],
    conflict: [409, "VENDOR_CONFLICT"],
    "code-conflict": [409, "PARTNER_CODE_CONFLICT"],
    invalid: [400, "VENDOR_INVALID"],
    unavailable: [500, "VENDOR_UNAVAILABLE"],
  };
  for (const [kind, [status, code]] of Object.entries(expected)) {
    const d = deps({ ok: false, kind });
    const res = await updateVendorCatalog(
      jsonRequest(UPDATE_BODY, "/api/admin/catalog/vendors/" + VENDOR), VENDOR, "true",
      d.dependencies);
    assert.equal(res.status, status, kind);
    assert.deepEqual(await res.json(), { ok: false, code }, kind);
  }

  const throwing = deps({ ok: true, data: CREATE });
  throwing.dependencies.repository.createVendor = async () => {
    throw new Error("RAW_DB_MESSAGE_SHOULD_NOT_LEAK");
  };
  const failure = await createVendorCatalog(jsonRequest(CREATE_BODY), "true", throwing.dependencies);
  assert.equal(failure.status, 500);
  const text = JSON.stringify(await failure.json());
  assert.equal(text.includes("RAW_DB_MESSAGE_SHOULD_NOT_LEAK"), false);
  assert.equal(text.includes("VENDOR_UNAVAILABLE"), true);
});

test("detail and set-active validate the path business key and project the response", async () => {
  const d = deps({ ok: true, data: ITEM });
  const res = await getVendorCatalog(new Request("https://app.test/x"), VENDOR, "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, vendor: ITEM });
  assert.deepEqual(d.calls.rpc[0][1], { ...ACTOR, vendor_id: VENDOR });

  for (const bad of ["__system_vendor__", "has space", "_leading", "V".repeat(129), ""]) {
    const invalid = deps({ ok: true, data: ITEM });
    const res2 = await getVendorCatalog(new Request("https://app.test/x"), bad, "true",
      invalid.dependencies);
    assert.equal(res2.status, 400, bad);
    assert.equal((await res2.json()).code, "VENDOR_INVALID", bad);
    assert.equal(invalid.calls.session, 0, bad);
  }

  const active = deps({ ok: true, data: MUTATION });
  const res3 = await setVendorCatalogActive(
    jsonRequest(ACTIVE_BODY, "/api/admin/catalog/vendors/" + VENDOR + "/active"), VENDOR, "true",
    active.dependencies);
  assert.equal(res3.status, 200);
  assert.deepEqual(await res3.json(), { ok: true, vendor: MUTATION });
  assert.deepEqual(active.calls.rpc[0][1],
    { ...ACTOR, vendor_id: VENDOR, active: false, expected_version: 2,
      reason: "Synthetic reason", idempotency_key: KEY });

  const badPath = deps({ ok: false, kind: "invalid" });
  const res4 = await updateVendorCatalog(
    jsonRequest(UPDATE_BODY, "/api/admin/catalog/vendors/__system_vendor__"),
    "__system_vendor__", "true", badPath.dependencies);
  assert.equal(res4.status, 400);
  assert.equal(badPath.calls.rpc.length, 0, "the reserved key never reaches the repository");
});

test("repository maps SQLSTATE to sanitized kinds and calls the canonical RPCs", async () => {
  assert.equal(classifyVendorCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyVendorCatalogError({ code: "PT409" }), "conflict");
  assert.equal(classifyVendorCatalogError({ code: "PT409", message: "PARTNER_CODE_CONFLICT" }), "code-conflict");
  assert.equal(classifyVendorCatalogError({ code: "23505" }), "code-conflict");
  assert.equal(classifyVendorCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyVendorCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyVendorCatalogError({ code: "23514" }), "invalid");
  assert.equal(classifyVendorCatalogError({ code: "22023", message: "reason required" }), "invalid");
  assert.equal(classifyVendorCatalogError({ code: "22023",
    message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyVendorCatalogError({ code: "XX000" }), "unavailable");
  assert.equal(classifyVendorCatalogError({}), "unavailable");

  const calls = [];
  const repository = createVendorCatalogRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_vendors_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_vendor_admin") return { data: ITEM, error: null };
    if (name === "direct_entry_create_vendor") return { data: CREATE, error: null };
    if (name === "direct_entry_update_vendor") return { data: MUTATION, error: null };
    if (name === "direct_entry_set_vendor_active") return { data: MUTATION, error: null };
    return { data: null, error: { code: "XX000" } };
  });

  assert.deepEqual(await repository.listVendors({ ...ACTOR, search: null,
    include_inactive: true, page: 1, page_size: 25 }), { ok: true, data: LIST });
  assert.deepEqual(calls[0], ["direct_entry_list_vendors_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_search: null,
      p_include_inactive: true, p_page: 1, p_page_size: 25 }]);

  assert.deepEqual(await repository.getVendor({ ...ACTOR, vendor_id: VENDOR }),
    { ok: true, data: ITEM });
  assert.deepEqual(calls[1], ["direct_entry_get_vendor_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_vendor_id: VENDOR }]);

  assert.deepEqual(await repository.createVendor({ ...ACTOR, expected_version: 0,
    vendor_id: VENDOR, display_name: "Synthetic Vendor", valid_from: "2024-01-01",
    address: "123 Nguyen Trai, Q.1", phone: "+84 901 234 567",
    reason: "Synthetic reason", idempotency_key: KEY }), { ok: true, data: CREATE });
  assert.deepEqual(calls[2], ["direct_entry_create_vendor",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_expected_version: 0,
      p_vendor_id: VENDOR, p_display_name: "Synthetic Vendor", p_valid_from: "2024-01-01",
      p_reason: "Synthetic reason", p_idempotency_key: KEY,
      p_address: "123 Nguyen Trai, Q.1", p_phone: "+84 901 234 567" }]);

  assert.deepEqual(await repository.updateVendor({ ...ACTOR, vendor_id: VENDOR,
    expected_version: 2, display_name: "Synthetic Vendor Renamed", reason: "Synthetic reason",
    idempotency_key: KEY }), { ok: true, data: MUTATION });
  assert.deepEqual(calls[3], ["direct_entry_update_vendor",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_vendor_id: VENDOR,
      p_expected_version: 2, p_display_name: "Synthetic Vendor Renamed",
      p_reason: "Synthetic reason", p_idempotency_key: KEY,
      p_address: null, p_phone: null }]);
  assert.equal(Object.keys(calls[3][1]).some((key) => key.includes("active")), false,
    "the generic update sends no active field");
  assert.equal(Object.keys(calls[3][1]).some((key) => key.includes("valid_from")), false,
    "the generic update sends no membership interval");

  assert.deepEqual(await repository.setVendorActive({ ...ACTOR, vendor_id: VENDOR, active: false,
    expected_version: 2, reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: MUTATION });
  assert.deepEqual(calls[4], ["direct_entry_set_vendor_active",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_vendor_id: VENDOR,
      p_active: false, p_expected_version: 2, p_reason: "Synthetic reason",
      p_idempotency_key: KEY }]);

  const malformed = createVendorCatalogRepository(async () => ({
    data: { unexpected: true }, error: null,
  }));
  assert.deepEqual(await malformed.listVendors({ ...ACTOR, search: null, include_inactive: true,
    page: 1, page_size: 25 }), { ok: false, kind: "unavailable" });
  assert.deepEqual(await malformed.getVendor({ ...ACTOR, vendor_id: VENDOR }),
    { ok: false, kind: "unavailable" });

  const denied = createVendorCatalogRepository(async () => ({
    data: null, error: { code: "P0002", message: "vendor not found" },
  }));
  assert.deepEqual(await denied.getVendor({ ...ACTOR, vendor_id: VENDOR }),
    { ok: false, kind: "not-found" });
  assert.deepEqual(await denied.setVendorActive({ ...ACTOR, vendor_id: VENDOR, active: false,
    expected_version: 2, reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: false, kind: "not-found" });

  const codeConflict = createVendorCatalogRepository(async () => ({
    data: null, error: { code: "PT409", message: "PARTNER_CODE_CONFLICT" },
  }));
  assert.deepEqual(await codeConflict.createVendor({ ...ACTOR, expected_version: 0,
    vendor_id: VENDOR, display_name: "Synthetic Vendor", valid_from: "2024-01-01",
    reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: false, kind: "code-conflict" });
});
