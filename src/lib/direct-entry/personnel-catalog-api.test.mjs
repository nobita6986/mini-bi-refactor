import assert from "node:assert/strict";
import test from "node:test";

import {
  createPersonnelCatalog,
  getPersonnelCatalog,
  listPersonnelCatalog,
  personnelCatalogCreateRequest,
  personnelCatalogListQuery,
  personnelCatalogSetActiveRequest,
  personnelCatalogUpdateRequest,
  setPersonnelCatalogActive,
  updatePersonnelCatalog,
} from "./personnel-catalog-api.ts";
import {
  personnelCatalogCreateResult,
  personnelCatalogItem,
  personnelCatalogList,
  personnelCatalogMutation,
} from "./personnel-catalog-contract.ts";
import {
  classifyPersonnelCatalogError,
  createPersonnelCatalogRepository,
} from "./personnel-catalog-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const RECRUITER = "66666666-6666-4666-8666-666666666666";
const REV = "99999999-9999-4999-8999-999999999999";
const OTHER = "77777777-7777-4777-8777-777777777777";

const ITEM = { recruiter_id: RECRUITER, display_name: "Synthetic Person",
  personnel_code: "nv.one", personnel_position: "STAFF", active: true, version: 2,
  hrp_valid_from: "2026-01-05", revision_count: 2, team_names: [] };
const MUTATION = { recruiter_id: RECRUITER, display_name: "Synthetic Person",
  personnel_code: "nv.one", personnel_position: "STAFF", active: true, version: 3,
  revision_id: REV };
const CREATE = { ...MUTATION, hrp_valid_from: "2026-01-05", created: true };
const LIST = { authorization_date: "2026-10-09", include_inactive: true, search: null,
  page: 1, page_size: 25, total: 1, personnel: [ITEM] };

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listPersonnel: async (i) => { calls.rpc.push(["list", i]); return result; },
        getPersonnel: async (i) => { calls.rpc.push(["get", i]); return result; },
        createPersonnel: async (i) => { calls.rpc.push(["create", i]); return result; },
        updatePersonnel: async (i) => { calls.rpc.push(["update", i]); return result; },
        setPersonnelActive: async (i) => { calls.rpc.push(["active", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, path = "/api/admin/catalog/personnel", headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const CREATE_BODY = { expected_version: 0, personnel_code: "nv.one",
  display_name: "Synthetic Person", personnel_position: "STAFF", valid_from: "2026-01-05",
  reason: "Synthetic reason", idempotency_key: KEY };
const UPDATE_BODY = { expected_version: 2, personnel_code: "nv.one",
  display_name: "Synthetic Person", personnel_position: "STAFF",
  reason: "Synthetic reason", idempotency_key: KEY };
const ACTIVE_BODY = { active: false, expected_version: 2,
  reason: "Synthetic reason", idempotency_key: KEY };

test("the contract accepts exactly the reviewed projection shapes", () => {
  assert.deepEqual(personnelCatalogItem(ITEM), ITEM);
  assert.deepEqual(personnelCatalogList(LIST), LIST);
  assert.deepEqual(personnelCatalogMutation(MUTATION), MUTATION);
  assert.deepEqual(personnelCatalogCreateResult(CREATE), CREATE);
  assert.equal(personnelCatalogItem({ ...ITEM, extra: 1 }), null);
  const withoutDisplayName = { ...ITEM };
  delete withoutDisplayName.display_name;
  assert.equal(personnelCatalogItem(withoutDisplayName), null);
  assert.equal(personnelCatalogItem({ ...ITEM, personnel_position: "MANAGER" }), null);
  assert.equal(personnelCatalogItem({ ...ITEM, hrp_valid_from: "05/01/2026" }), null);
  assert.equal(personnelCatalogItem({ ...ITEM, version: -1 }), null);
  assert.equal(personnelCatalogItem({ ...ITEM, active: "true" }), null);
  assert.equal(personnelCatalogItem(null), null);
  assert.equal(personnelCatalogList({ ...LIST, personnel: [{ ...ITEM, version: "2" }] }), null);
  assert.equal(personnelCatalogCreateResult({ ...CREATE, created: false }), null);
  assert.equal(personnelCatalogMutation({ ...MUTATION, hrp_valid_from: "2026-01-05" }), null);
});

test("the feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listPersonnelCatalog(new Request("https://app.test/x"), "false", d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createPersonnelCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/personnel", { origin: "https://evil.test" }),
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
  assert.equal((await createPersonnelCatalog(wrongType, "true", d.dependencies)).status, 400);

  const broken = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", host: "app.test" },
    body: "{not json" });
  const brokenRes = await createPersonnelCatalog(broken, "true", d.dependencies);
  assert.equal(brokenRes.status, 400);
  assert.equal((await brokenRes.json()).code, "BODY_INVALID");

  for (const forbidden of [{ actor: "x" }, { auth_subject: "x" }, { capabilities: [] },
    { scope: "all" }, { role: "admin" }, { app_user_id: "x" }, { scopes: [] }]) {
    const res = await createPersonnelCatalog(
      jsonRequest({ ...CREATE_BODY, ...forbidden }), "true", d.dependencies);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("request projections are strict about keys, values and OCC", () => {
  assert.equal(personnelCatalogCreateRequest(CREATE_BODY).ok, true);
  // FIX R1: valid_from is explicit and required - never coalesced to the server date.
  for (const validFrom of [null, undefined, "", "09/10/2026", "2026-1-5"]) {
    assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, valid_from: validFrom }).ok,
      false, JSON.stringify(validFrom));
  }
  const withoutValidFrom = { ...CREATE_BODY };
  delete withoutValidFrom.valid_from;
  assert.equal(personnelCatalogCreateRequest(withoutValidFrom).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, expected_version: 1 }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, personnel_code: "has space" }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, personnel_position: "LEAD" }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, valid_from: "09/10/2026" }).ok, false);
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...CREATE_BODY };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const parsed = personnelCatalogCreateRequest(body);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.reason, null);
  }
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, reason: 123 }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, reason: "x".repeat(4001) }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, idempotency_key: "not-a-uuid" }).ok, false);
  assert.equal(personnelCatalogCreateRequest({ ...CREATE_BODY, extra: 1 }).ok, false);

  assert.equal(personnelCatalogUpdateRequest(UPDATE_BODY).ok, true);
  assert.equal(personnelCatalogUpdateRequest({ ...UPDATE_BODY, expected_version: 0 }).ok, false);
  assert.equal(personnelCatalogUpdateRequest({ ...UPDATE_BODY, personnel_code: "" }).ok, false);

  assert.equal(personnelCatalogSetActiveRequest(ACTIVE_BODY).ok, true);
  assert.equal(personnelCatalogSetActiveRequest({ ...ACTIVE_BODY, active: "false" }).ok, false);
  assert.equal(personnelCatalogSetActiveRequest({ ...ACTIVE_BODY, expected_version: null }).ok, false);

  for (const [parse, valid] of [
    [personnelCatalogCreateRequest, CREATE_BODY],
    [personnelCatalogUpdateRequest, UPDATE_BODY],
    [personnelCatalogSetActiveRequest, ACTIVE_BODY],
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

  const query = personnelCatalogListQuery(new URL("https://app.test/x?search=%20abc%20&page=2&page_size=10&include_inactive=false"));
  assert.deepEqual(query.ok && query.value, { search: "abc", include_inactive: false, page: 2, page_size: 10, team_id: null });
  // FIX R1: only absent, "true" and "false" are accepted; anything else is a 400
  // instead of a silent default to true.
  for (const value of ["", "1", "0", "TRUE", "False", "yes", "null"]) {
    const invalid = personnelCatalogListQuery(
      new URL("https://app.test/x?include_inactive=" + encodeURIComponent(value)));
    assert.equal(invalid.ok, false, JSON.stringify(value));
  }
  assert.equal(personnelCatalogListQuery(new URL("https://app.test/x")).ok &&
    personnelCatalogListQuery(new URL("https://app.test/x")).value.include_inactive, true);
  assert.equal(personnelCatalogListQuery(new URL("https://app.test/x?include_inactive=true")).ok &&
    personnelCatalogListQuery(new URL("https://app.test/x?include_inactive=true")).value.include_inactive, true);
  for (const search of ["?page=0", "?page_size=0", "?page_size=101", "?page=abc", "?search=" + "x".repeat(257)]) {
    assert.equal(personnelCatalogListQuery(new URL("https://app.test/x" + search)).ok, false, search);
  }
});

test("the session actor is the only actor source and unauthenticated callers get 401", async () => {
  const unauthenticated = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const denied = await listPersonnelCatalog(new Request("https://app.test/x"), "true", unauthenticated.dependencies);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHENTICATED");

  const unavailable = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } });
  const actorUnavailable = await listPersonnelCatalog(new Request("https://app.test/x"), "true", unavailable.dependencies);
  assert.equal(actorUnavailable.status, 403);
  assert.equal((await actorUnavailable.json()).code, "ACTOR_NOT_AVAILABLE");

  const strict = deps({ ok: true, data: LIST });
  for (const value of ["yes", "1", "TRUE", ""]) {
    const blocked = await listPersonnelCatalog(
      new Request("https://app.test/x?include_inactive=" + encodeURIComponent(value)), "true",
      strict.dependencies);
    assert.equal(blocked.status, 400, value);
    assert.equal((await blocked.json()).code, "PERSONNEL_INVALID", value);
  }
  assert.equal(strict.calls.rpc.length, 0, "an invalid boolean never reaches the repository");

  const d = deps({ ok: true, data: LIST });
  const res = await listPersonnelCatalog(
    new Request("https://app.test/x?search=nv&page=1&page_size=5"), "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.list, LIST);
  assert.deepEqual(d.calls.rpc[0][1],
    { ...ACTOR, search: "nv", include_inactive: true, page: 1, page_size: 5, team_id: null });
});

test("idempotency header mismatch is rejected before the repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createPersonnelCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/personnel",
      { "idempotency-key": OTHER }), "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(d.calls.rpc.length, 0);
});

test("mutations project strict responses for success and for every sanitized failure kind", async () => {
  const ok = deps({ ok: true, data: CREATE });
  const created = await createPersonnelCatalog(
    jsonRequest(CREATE_BODY), "true", ok.dependencies);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ok: true, personnel: CREATE });

  const expected = { denied: [403, "PERSONNEL_DENIED"], "not-found": [404, "PERSONNEL_NOT_FOUND"],
    conflict: [409, "PERSONNEL_CONFLICT"], invalid: [400, "PERSONNEL_INVALID"],
    unavailable: [500, "PERSONNEL_UNAVAILABLE"] };
  for (const [kind, [status, code]] of Object.entries(expected)) {
    const d = deps({ ok: false, kind });
    const res = await updatePersonnelCatalog(
      jsonRequest(UPDATE_BODY, "/api/admin/catalog/personnel/" + RECRUITER), RECRUITER, "true",
      d.dependencies);
    assert.equal(res.status, status, kind);
    assert.deepEqual(await res.json(), { ok: false, code }, kind);
  }
});

test("a repository exception becomes PERSONNEL_UNAVAILABLE without leaking the raw error", async () => {
  const d = deps({ ok: true, data: CREATE });
  d.dependencies.repository.createPersonnel = async () => {
    throw new Error("RAW_DB_MESSAGE_SHOULD_NOT_LEAK");
  };
  const res = await createPersonnelCatalog(jsonRequest(CREATE_BODY), "true", d.dependencies);
  assert.equal(res.status, 500);
  const text = JSON.stringify(await res.json());
  assert.equal(text.includes("RAW_DB_MESSAGE_SHOULD_NOT_LEAK"), false);
  assert.equal(text.includes("PERSONNEL_UNAVAILABLE"), true);
});

test("detail and set-active validate the path id and project the response", async () => {
  const d = deps({ ok: true, data: ITEM });
  const res = await getPersonnelCatalog(
    new Request("https://app.test/x"), RECRUITER, "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, personnel: ITEM });
  assert.deepEqual(d.calls.rpc[0][1], { ...ACTOR, recruiter_id: RECRUITER });

  const invalid = deps({ ok: true, data: ITEM });
  const res2 = await getPersonnelCatalog(
    new Request("https://app.test/x"), "not-a-uuid", "true", invalid.dependencies);
  assert.equal(res2.status, 400);
  assert.equal(invalid.calls.session, 0);

  const active = deps({ ok: true, data: MUTATION });
  const res3 = await setPersonnelCatalogActive(
    jsonRequest(ACTIVE_BODY, "/api/admin/catalog/personnel/" + RECRUITER + "/active"),
    RECRUITER, "true", active.dependencies);
  assert.equal(res3.status, 200);
  assert.deepEqual(await res3.json(), { ok: true, personnel: MUTATION });
  assert.deepEqual(active.calls.rpc[0][1],
    { ...ACTOR, recruiter_id: RECRUITER, active: false, expected_version: 2,
      reason: "Synthetic reason", idempotency_key: KEY });
});

test("repository maps SQLSTATE to sanitized kinds and calls the canonical RPCs", async () => {
  assert.equal(classifyPersonnelCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyPersonnelCatalogError({ code: "PT409" }), "conflict");
  assert.equal(classifyPersonnelCatalogError({ code: "23505" }), "conflict");
  assert.equal(classifyPersonnelCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyPersonnelCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyPersonnelCatalogError({ code: "23514" }), "invalid");
  assert.equal(classifyPersonnelCatalogError({ code: "22023", message: "reason required" }), "invalid");
  assert.equal(classifyPersonnelCatalogError({ code: "22023",
    message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyPersonnelCatalogError({ code: "XX000" }), "unavailable");

  const calls = [];
  const repository = createPersonnelCatalogRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_personnel_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_personnel_admin") return { data: ITEM, error: null };
    if (name === "direct_entry_create_personnel") return { data: CREATE, error: null };
    if (name === "direct_entry_update_personnel") return { data: MUTATION, error: null };
    if (name === "direct_entry_set_personnel_active") return { data: MUTATION, error: null };
    return { data: null, error: { code: "XX000" } };
  });

  assert.deepEqual(await repository.listPersonnel({ ...ACTOR, search: null,
    include_inactive: true, page: 1, page_size: 25 }), { ok: true, data: LIST });
  assert.deepEqual(calls[0], ["direct_entry_list_personnel_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_search: null,
      p_include_inactive: true, p_page: 1, p_page_size: 25 }]);

  assert.deepEqual(await repository.getPersonnel({ ...ACTOR, recruiter_id: RECRUITER }),
    { ok: true, data: ITEM });
  assert.deepEqual(calls[1], ["direct_entry_get_personnel_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
      p_recruiter_id: RECRUITER }]);

  assert.deepEqual(await repository.createPersonnel({ ...ACTOR, expected_version: 0,
    personnel_code: "nv.one", display_name: "Synthetic Person", personnel_position: "STAFF",
    valid_from: "2026-01-05", reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: CREATE });
  assert.deepEqual(calls[2], ["direct_entry_create_personnel",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_expected_version: 0,
      p_personnel_code: "nv.one", p_display_name: "Synthetic Person",
      p_personnel_position: "STAFF", p_valid_from: "2026-01-05", p_reason: "Synthetic reason",
      p_idempotency_key: KEY }]);

  assert.deepEqual(await repository.updatePersonnel({ ...ACTOR, recruiter_id: RECRUITER,
    expected_version: 2, display_name: "Synthetic Person", personnel_code: "nv.one",
    personnel_position: "STAFF", reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: MUTATION });
  assert.deepEqual(await repository.setPersonnelActive({ ...ACTOR, recruiter_id: RECRUITER,
    active: false, expected_version: 2, reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: MUTATION });

  const malformed = createPersonnelCatalogRepository(async () => ({
    data: { unexpected: true }, error: null,
  }));
  assert.deepEqual(await malformed.listPersonnel({ ...ACTOR, search: null,
    include_inactive: true, page: 1, page_size: 25 }), { ok: false, kind: "unavailable" });

  const denied = createPersonnelCatalogRepository(async () => ({
    data: null, error: { code: "42501", message: "catalog operator denied" },
  }));
  assert.deepEqual(await denied.getPersonnel({ ...ACTOR, recruiter_id: RECRUITER }),
    { ok: false, kind: "denied" });
});

test("WP13 PR-0 GAP-BE-06: team_id query parsing, 400/404 handling and filtered RPC routing", async () => {
  const TEAM_ID = "88888888-8888-4888-8888-888888888888";
  const rpcCalls = [];
  const repository = createPersonnelCatalogRepository(async (name, args) => {
    rpcCalls.push([name, args]);
    if (name === "direct_entry_list_personnel_filtered_admin" && args.p_team_id === OTHER) {
      return { data: null, error: { code: "P0002", message: "team not found" } };
    }
    return { data: LIST, error: null };
  });
  const dependencies = {
    resolveSession: async () => ({ actor: { ok: true, actor: ACTOR } }),
    repository,
  };

  // Without team_id or with empty ?team_id= (§7.1) -> team_id=null, legacy 6-arg RPC
  for (const url of [
    "https://app.test/api/admin/catalog/personnel?page=1&page_size=25",
    "https://app.test/api/admin/catalog/personnel?team_id=&page=1&page_size=25",
  ]) {
    rpcCalls.length = 0;
    const unfiltered = await listPersonnelCatalog(new Request(url), "true", dependencies);
    assert.equal(unfiltered.status, 200, url);
    assert.deepEqual(Object.keys((await unfiltered.json()).list).sort(), [
      "authorization_date", "include_inactive", "page", "page_size", "personnel", "search", "total",
    ]);
    assert.equal(rpcCalls[0][0], "direct_entry_list_personnel_admin");
    assert.equal(Object.keys(rpcCalls[0][1]).length, 6);
  }

  // With valid team_id -> new 7-arg filtered RPC
  rpcCalls.length = 0;
  const filtered = await listPersonnelCatalog(
    new Request(`https://app.test/api/admin/catalog/personnel?team_id=${TEAM_ID}&include_inactive=false&search=an&page=2&page_size=10`),
    "true",
    dependencies,
  );
  assert.equal(filtered.status, 200);
  assert.deepEqual(Object.keys((await filtered.json()).list).sort(), [
    "authorization_date", "include_inactive", "page", "page_size", "personnel", "search", "total",
  ]);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0][0], "direct_entry_list_personnel_filtered_admin");
  assert.deepEqual(rpcCalls[0][1], {
    p_auth_subject: ACTOR.auth_subject,
    p_app_user_id: ACTOR.app_user_id,
    p_search: "an",
    p_include_inactive: false,
    p_page: 2,
    p_page_size: 10,
    p_team_id: TEAM_ID,
  });

  // Unknown / vendor team P0002 -> 404 PERSONNEL_NOT_FOUND
  const missing = await listPersonnelCatalog(
    new Request(`https://app.test/api/admin/catalog/personnel?team_id=${OTHER}`),
    "true",
    dependencies,
  );
  assert.deepEqual([missing.status, await missing.json()], [404, { ok: false, code: "PERSONNEL_NOT_FOUND" }]);

  // Invalid / whitespace / duplicate / unknown query keys -> 400 PERSONNEL_INVALID before RPC
  rpcCalls.length = 0;
  for (const badUrl of [
    "https://app.test/api/admin/catalog/personnel?team_id=not-a-uuid",
    "https://app.test/api/admin/catalog/personnel?team_id=%20",
    `https://app.test/api/admin/catalog/personnel?team_id=${TEAM_ID}&team_id=${OTHER}`,
    `https://app.test/api/admin/catalog/personnel?teamId=${TEAM_ID}`,
    "https://app.test/api/admin/catalog/personnel?unknown=1",
    "https://app.test/api/admin/catalog/personnel?page=1&page=2",
    "https://app.test/api/admin/catalog/personnel?include_inactive=true&include_inactive=false",
  ]) {
    const res = await listPersonnelCatalog(new Request(badUrl), "true", dependencies);
    assert.deepEqual([res.status, await res.json()], [400, { ok: false, code: "PERSONNEL_INVALID" }], badUrl);
  }
  assert.equal(rpcCalls.length, 0);
});
