import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const emptyServerOnly = new URL(
  "../../../node_modules/server-only/empty.js",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: emptyServerOnly };
    }
    return nextResolve(specifier, context);
  },
});

const {
  collaboratorCatalogCreateRequest,
  collaboratorCatalogListQuery,
  collaboratorCatalogSetActiveRequest,
  collaboratorCatalogUpdateRequest,
  createCollaboratorCatalog,
  getCollaboratorCatalog,
  listCollaboratorsCatalog,
  setCollaboratorCatalogActive,
  updateCollaboratorCatalog,
} = await import("./collaborator-catalog-api.ts");

const {
  buildCollaboratorCreateRequest,
  buildCollaboratorUpdateRequest,
  classifyCollaboratorMutation,
  collaboratorCatalogItem,
  collaboratorCatalogList,
  collaboratorCatalogMutation,
} = await import("./collaborator-catalog-contract.ts");

const {
  classifyCollaboratorCatalogError,
  createCollaboratorCatalogRepository,
} = await import("./collaborator-catalog-repository.ts");

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
};
const KEY = "55555555-5555-4555-8555-555555555555";
const OTHER = "77777777-7777-4777-8777-777777777777";
const CTV_ID = "CTV_ONE";
const NOW = "2026-11-28T06:00:00Z";
const PARTNER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const PARTNER_APP_USER_ID = "44444444-4444-4444-8444-444444444444";

const PARTNER_ACCOUNT = {
  partner_account_id: PARTNER_ACCOUNT_ID,
  partner_kind: "COLLABORATOR",
  vendor_id: null,
  collaborator_id: CTV_ID,
  partner_id: CTV_ID,
  canonical_code: "ctv_one",
  account_state: "ACTIVE",
  app_user_id: PARTNER_APP_USER_ID,
  username: "ctv_one",
  activated_at: NOW,
  must_change_password: false,
  password_changed_at: NOW,
  activation_expires_at: null,
  activation_attempts: 0,
  version: 3,
};

const ITEM = {
  collaborator_id: CTV_ID,
  display_name: "Nguyễn Văn CTV",
  address: "25 Tran Hung Dao, Ha Noi",
  phone: "0987 654 321",
  active: true,
  version: 2,
  created_at: NOW,
  updated_at: NOW,
  partner_account: PARTNER_ACCOUNT,
};

const MUTATION = {
  collaborator_id: CTV_ID,
  display_name: "Nguyễn Văn CTV",
  address: "25 Tran Hung Dao, Ha Noi",
  phone: "0987 654 321",
  active: true,
  version: 3,
  created_at: NOW,
  updated_at: NOW,
  partner_account: PARTNER_ACCOUNT,
};

const CREATE_RESULT = {
  collaborator_id: CTV_ID,
  display_name: "Nguyễn Văn CTV",
  address: null,
  phone: null,
  active: true,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  partner_account: null,
};

const LIST = {
  items: [ITEM],
  total: 1,
  page: 1,
  page_size: 25,
};

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => {
        calls.session += 1;
        return session;
      },
      repository: {
        listCollaborators: async (i) => {
          calls.rpc.push(["list", i]);
          return result;
        },
        getCollaborator: async (i) => {
          calls.rpc.push(["get", i]);
          return result;
        },
        createCollaborator: async (i) => {
          calls.rpc.push(["create", i]);
          return result;
        },
        updateCollaborator: async (i) => {
          calls.rpc.push(["update", i]);
          return result;
        },
        setCollaboratorActive: async (i) => {
          calls.rpc.push(["active", i]);
          return result;
        },
      },
    },
  };
}

function jsonRequest(body, path = "/api/admin/catalog/collaborators", headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      host: "app.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const CREATE_BODY = {
  expected_version: 0,
  collaborator_id: CTV_ID,
  display_name: "Nguyễn Văn CTV",
  reason: "Synthetic reason",
  idempotency_key: KEY,
};

const UPDATE_BODY = {
  expected_version: 2,
  display_name: "Nguyễn Văn CTV Mới",
  reason: "Synthetic reason",
  idempotency_key: KEY,
};

const ACTIVE_BODY = {
  active: false,
  expected_version: 2,
  reason: "Synthetic reason",
  idempotency_key: KEY,
};

test("collaborator contract accepts exact projection shapes and fails closed on drift", () => {
  assert.deepEqual(collaboratorCatalogItem(ITEM), ITEM);
  assert.deepEqual(collaboratorCatalogList(LIST), LIST);
  assert.deepEqual(collaboratorCatalogMutation(MUTATION), MUTATION);
  assert.deepEqual(collaboratorCatalogMutation(CREATE_RESULT), CREATE_RESULT);

  // Legacy 6-key item and 4-key mutation remain supported while partial key drift fails closed.
  const legacyItem = {
    collaborator_id: CTV_ID,
    display_name: "Nguyễn Văn CTV",
    active: true,
    version: 2,
    created_at: NOW,
    updated_at: NOW,
  };
  assert.deepEqual(collaboratorCatalogItem(legacyItem), legacyItem);
  assert.equal(collaboratorCatalogItem({ ...legacyItem, address: null }), null);

  assert.equal(collaboratorCatalogItem({ ...ITEM, extra: 1 }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, collaborator_id: "__system_vendor__" }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, active: "true" }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, version: 0 }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, created_at: "" }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, address: "bad\nline" }), null);
  assert.equal(collaboratorCatalogItem({ ...ITEM, phone: "12345" }), null);
  assert.equal(
    collaboratorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, partner_kind: "VENDOR" } }),
    null,
  );
  assert.equal(
    collaboratorCatalogItem({ ...ITEM, partner_account: { ...PARTNER_ACCOUNT, extra: 1 } }),
    null,
  );
  assert.equal(collaboratorCatalogItem(null), null);

  assert.equal(collaboratorCatalogList({ ...LIST, total: 0 }), null);
  assert.equal(collaboratorCatalogList({ ...LIST, page: 0 }), null);
  assert.equal(collaboratorCatalogList({ ...LIST, items: [{ ...ITEM, version: 1.5 }] }), null);
  assert.equal(
    collaboratorCatalogMutation({
      collaborator_id: CTV_ID,
      display_name: "Nguyễn Văn CTV",
      active: true,
      version: 3,
      created_at: NOW,
    }),
    null,
  );
  assert.equal(collaboratorCatalogMutation({ ...MUTATION, version: 0 }), null);

  const conflictOutcome = classifyCollaboratorMutation(409, {
    ok: false,
    code: "PARTNER_CODE_CONFLICT",
  });
  assert.equal(conflictOutcome.kind, "conflict");
  if (conflictOutcome.kind === "conflict") {
    assert.match(conflictOutcome.message, /Nhà cung cấp hoặc Cộng tác viên/);
  }
});

test("feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listCollaboratorsCatalog(
    new Request("https://app.test/x"),
    "false",
    d.dependencies,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: CREATE_RESULT });
  const res = await createCollaboratorCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/collaborators", { origin: "https://evil.test" }),
    "true",
    d.dependencies,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("content-type, body and client authority fields are rejected before session", async () => {
  const d = deps({ ok: true, data: CREATE_RESULT });
  const wrongType = new Request("https://app.test/x", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test" },
    body: "{}",
  });
  assert.equal((await createCollaboratorCatalog(wrongType, "true", d.dependencies)).status, 400);

  const broken = new Request("https://app.test/x", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", host: "app.test" },
    body: "{not json",
  });
  const brokenRes = await createCollaboratorCatalog(broken, "true", d.dependencies);
  assert.equal(brokenRes.status, 400);
  assert.equal((await brokenRes.json()).code, "BODY_INVALID");

  for (const forbidden of [
    { actor: "x" },
    { auth_subject: "x" },
    { capabilities: [] },
    { scope: "all" },
    { role: "admin" },
    { app_user_id: "x" },
    { scopes: [] },
  ]) {
    const res = await createCollaboratorCatalog(
      jsonRequest({ ...CREATE_BODY, ...forbidden }),
      "true",
      d.dependencies,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("request projections are strict; optional address and phone work cleanly", () => {
  const parsedCreate = collaboratorCatalogCreateRequest(CREATE_BODY);
  assert.equal(parsedCreate.ok, true);
  assert.deepEqual(parsedCreate.value, {
    expected_version: 0,
    collaborator_id: CTV_ID,
    display_name: "Nguyễn Văn CTV",
    address: null,
    phone: null,
    reason: "Synthetic reason",
    idempotency_key: KEY,
  });

  const parsedWithContact = collaboratorCatalogCreateRequest({
    ...CREATE_BODY,
    address: "  12 Ly Thuong Kiet  ",
    phone: " +84 912-345-678 ",
  });
  assert.equal(parsedWithContact.ok, true);
  assert.equal(parsedWithContact.ok && parsedWithContact.value.address, "12 Ly Thuong Kiet");
  assert.equal(parsedWithContact.ok && parsedWithContact.value.phone, "+84 912-345-678");

  for (const badAddr of [123, "x".repeat(501), "line1\nline2", "del\x7f"]) {
    assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, address: badAddr }).ok, false);
    assert.equal(collaboratorCatalogUpdateRequest({ ...UPDATE_BODY, address: badAddr }).ok, false);
  }
  for (const badPhone of [123, "12345", "1".repeat(33), "0901abc"]) {
    assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, phone: badPhone }).ok, false);
    assert.equal(collaboratorCatalogUpdateRequest({ ...UPDATE_BODY, phone: badPhone }).ok, false);
  }

  assert.equal(
    collaboratorCatalogCreateRequest({ ...CREATE_BODY, valid_from: "2026-11-28" }).ok,
    false,
  );
  assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, expected_version: 1 }).ok, false);
  assert.equal(
    collaboratorCatalogCreateRequest({ ...CREATE_BODY, collaborator_id: "__system_vendor__" }).ok,
    false,
  );
  assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, collaborator_id: "_CTV" }).ok, false);
  assert.equal(
    collaboratorCatalogCreateRequest({ ...CREATE_BODY, collaborator_id: "has space" }).ok,
    false,
  );
  assert.equal(
    collaboratorCatalogCreateRequest({ ...CREATE_BODY, collaborator_id: "C".repeat(129) }).ok,
    false,
  );
  assert.equal(
    collaboratorCatalogCreateRequest({ ...CREATE_BODY, collaborator_id: "C".repeat(128) }).ok,
    true,
  );
  assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, display_name: "" }).ok, false);
  assert.equal(collaboratorCatalogCreateRequest({ ...CREATE_BODY, idempotency_key: "nope" }).ok, false);

  assert.equal(collaboratorCatalogUpdateRequest(UPDATE_BODY).ok, true);
  const parsedUpdateWithContact = collaboratorCatalogUpdateRequest({
    ...UPDATE_BODY,
    address: "  99 Hai Phong ",
    phone: "0988777666",
  });
  assert.deepEqual(parsedUpdateWithContact.ok && parsedUpdateWithContact.value, {
    expected_version: 2,
    display_name: "Nguyễn Văn CTV Mới",
    address: "99 Hai Phong",
    phone: "0988777666",
    reason: "Synthetic reason",
    idempotency_key: KEY,
  });
  assert.equal(
    collaboratorCatalogUpdateRequest({ ...UPDATE_BODY, collaborator_id: "CTV_TWO" }).ok,
    false,
  );
  assert.equal(collaboratorCatalogUpdateRequest({ ...UPDATE_BODY, active: false }).ok, false);
  assert.equal(collaboratorCatalogUpdateRequest({ ...UPDATE_BODY, expected_version: 0 }).ok, false);

  // UI request builders keep 5/6-key backward compat when address/phone are omitted and validate when provided.
  const uiCreateWithContact = buildCollaboratorCreateRequest({
    collaboratorId: CTV_ID,
    displayName: "Nguyễn Văn CTV",
    address: "  12 Ly Thuong Kiet ",
    phone: "0987654321",
    idempotencyKey: KEY,
  });
  assert.equal(uiCreateWithContact.ok, true);
  if (uiCreateWithContact.ok) {
    assert.equal(uiCreateWithContact.body.address, "12 Ly Thuong Kiet");
    assert.equal(uiCreateWithContact.body.phone, "0987654321");
  }
  assert.equal(
    buildCollaboratorUpdateRequest({
      displayName: "Tên mới",
      expectedVersion: 2,
      phone: "123",
      idempotencyKey: KEY,
    }).ok,
    false,
  );

  assert.equal(collaboratorCatalogSetActiveRequest(ACTIVE_BODY).ok, true);
  assert.equal(
    collaboratorCatalogSetActiveRequest({ ...ACTIVE_BODY, active: "false" }).ok,
    false,
  );
  assert.equal(
    collaboratorCatalogSetActiveRequest({ ...ACTIVE_BODY, expected_version: 0 }).ok,
    false,
  );

  for (const [parse, valid] of [
    [collaboratorCatalogCreateRequest, CREATE_BODY],
    [collaboratorCatalogUpdateRequest, UPDATE_BODY],
    [collaboratorCatalogSetActiveRequest, ACTIVE_BODY],
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

  const defaultQuery = collaboratorCatalogListQuery(new URL("https://app.test/x"));
  assert.deepEqual(defaultQuery.ok && defaultQuery.value, {
    search: null,
    include_inactive: false,
    page: 1,
    page_size: 25,
  });

  const explicitQuery = collaboratorCatalogListQuery(
    new URL("https://app.test/x?search=%20abc%20&page=2&page_size=10&include_inactive=true"),
  );
  assert.deepEqual(explicitQuery.ok && explicitQuery.value, {
    search: "abc",
    include_inactive: true,
    page: 2,
    page_size: 10,
  });

  for (const bad of ["", "1", "TRUE", "yes"]) {
    assert.equal(
      collaboratorCatalogListQuery(
        new URL("https://app.test/x?include_inactive=" + encodeURIComponent(bad)),
      ).ok,
      false,
      bad,
    );
  }
});

test("session actor is the only actor source", async () => {
  const unauth = deps({ ok: true, data: LIST }, { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const denied = await listCollaboratorsCatalog(
    new Request("https://app.test/x"),
    "true",
    unauth.dependencies,
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHENTICATED");

  const disabled = deps(
    { ok: true, data: LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } },
  );
  const resDisabled = await listCollaboratorsCatalog(
    new Request("https://app.test/x"),
    "true",
    disabled.dependencies,
  );
  assert.equal(resDisabled.status, 403);
  assert.equal((await resDisabled.json()).code, "ACTOR_NOT_AVAILABLE");

  const d = deps({ ok: true, data: LIST });
  const ok = await listCollaboratorsCatalog(
    new Request("https://app.test/x?search=CTV&page=1&page_size=5"),
    "true",
    d.dependencies,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await ok.json()).list, LIST);
  assert.deepEqual(d.calls.rpc[0][1], {
    ...ACTOR,
    search: "CTV",
    include_inactive: false,
    page: 1,
    page_size: 5,
  });
});

test("idempotency header mismatch, sanitized errors, and path key validation", async () => {
  const d = deps({ ok: true, data: CREATE_RESULT });
  const mismatch = await createCollaboratorCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/collaborators", { "idempotency-key": OTHER }),
    "true",
    d.dependencies,
  );
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(d.calls.rpc.length, 0);

  const expected = {
    denied: [403, "COLLABORATOR_DENIED"],
    "not-found": [404, "COLLABORATOR_NOT_FOUND"],
    conflict: [409, "COLLABORATOR_CONFLICT"],
    "code-conflict": [409, "PARTNER_CODE_CONFLICT"],
    invalid: [400, "COLLABORATOR_INVALID"],
    unavailable: [500, "COLLABORATOR_UNAVAILABLE"],
  };
  for (const [kind, [status, code]] of Object.entries(expected)) {
    const errDeps = deps({ ok: false, kind });
    const res = await updateCollaboratorCatalog(
      jsonRequest(UPDATE_BODY, "/api/admin/catalog/collaborators/" + CTV_ID),
      CTV_ID,
      "true",
      errDeps.dependencies,
    );
    assert.equal(res.status, status, kind);
    assert.deepEqual(await res.json(), { ok: false, code }, kind);
  }

  const throwing = deps({ ok: true, data: CREATE_RESULT });
  throwing.dependencies.repository.createCollaborator = async () => {
    throw new Error("RAW_DB_MESSAGE_SHOULD_NOT_LEAK");
  };
  const failure = await createCollaboratorCatalog(
    jsonRequest(CREATE_BODY),
    "true",
    throwing.dependencies,
  );
  assert.equal(failure.status, 500);
  const text = JSON.stringify(await failure.json());
  assert.equal(text.includes("RAW_DB_MESSAGE_SHOULD_NOT_LEAK"), false);
  assert.equal(text.includes("COLLABORATOR_UNAVAILABLE"), true);

  for (const bad of ["__system_vendor__", "has space", "_leading", "C".repeat(129), ""]) {
    const invalid = deps({ ok: true, data: ITEM });
    const res = await getCollaboratorCatalog(
      new Request("https://app.test/x"),
      bad,
      "true",
      invalid.dependencies,
    );
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json()).code, "COLLABORATOR_INVALID", bad);
    assert.equal(invalid.calls.session, 0, bad);
  }

  const activeDeps = deps({ ok: true, data: { ...MUTATION, active: false } });
  const activeRes = await setCollaboratorCatalogActive(
    jsonRequest(ACTIVE_BODY, "/api/admin/catalog/collaborators/" + CTV_ID + "/active"),
    CTV_ID,
    "true",
    activeDeps.dependencies,
  );
  assert.equal(activeRes.status, 200);
  assert.deepEqual(await activeRes.json(), {
    ok: true,
    collaborator: { ...MUTATION, active: false },
  });
  assert.deepEqual(activeDeps.calls.rpc[0][1], {
    ...ACTOR,
    collaborator_id: CTV_ID,
    active: false,
    expected_version: 2,
    reason: "Synthetic reason",
    idempotency_key: KEY,
  });

  const reservedPath = deps({ ok: false, kind: "invalid" });
  const reservedRes = await setCollaboratorCatalogActive(
    jsonRequest(ACTIVE_BODY, "/api/admin/catalog/collaborators/__system_vendor__/active"),
    "__system_vendor__",
    "true",
    reservedPath.dependencies,
  );
  assert.equal(reservedRes.status, 400);
  assert.equal(reservedPath.calls.rpc.length, 0);
});

test("repository maps SQLSTATEs and calls the 5 canonical collaborator RPCs", async () => {
  assert.equal(classifyCollaboratorCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyCollaboratorCatalogError({ code: "PT409" }), "conflict");
  assert.equal(
    classifyCollaboratorCatalogError({ code: "PT409", message: "PARTNER_CODE_CONFLICT" }),
    "code-conflict",
  );
  assert.equal(classifyCollaboratorCatalogError({ code: "23505" }), "code-conflict");
  assert.equal(classifyCollaboratorCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyCollaboratorCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyCollaboratorCatalogError({ code: "23514" }), "invalid");
  assert.equal(
    classifyCollaboratorCatalogError({ code: "22023", message: "collaborator required" }),
    "invalid",
  );
  assert.equal(
    classifyCollaboratorCatalogError({
      code: "22023",
      message: "idempotency key reused with different input",
    }),
    "conflict",
  );
  assert.equal(classifyCollaboratorCatalogError({ code: "XX000" }), "unavailable");

  const calls = [];
  const repo = createCollaboratorCatalogRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_collaborators_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_collaborator_admin") return { data: ITEM, error: null };
    if (name === "direct_entry_create_collaborator") return { data: CREATE_RESULT, error: null };
    if (name === "direct_entry_update_collaborator") return { data: MUTATION, error: null };
    if (name === "direct_entry_set_collaborator_active") return { data: MUTATION, error: null };
    return { data: null, error: { code: "XX000" } };
  });

  assert.deepEqual(
    await repo.listCollaborators({
      ...ACTOR,
      search: null,
      include_inactive: false,
      page: 1,
      page_size: 25,
    }),
    { ok: true, data: LIST },
  );
  assert.deepEqual(calls[0], [
    "direct_entry_list_collaborators_admin",
    {
      p_auth_subject: ACTOR.auth_subject,
      p_app_user_id: ACTOR.app_user_id,
      p_search: null,
      p_include_inactive: false,
      p_page: 1,
      p_page_size: 25,
    },
  ]);

  assert.deepEqual(await repo.getCollaborator({ ...ACTOR, collaborator_id: CTV_ID }), {
    ok: true,
    data: ITEM,
  });
  assert.deepEqual(calls[1], [
    "direct_entry_get_collaborator_admin",
    {
      p_auth_subject: ACTOR.auth_subject,
      p_app_user_id: ACTOR.app_user_id,
      p_collaborator_id: CTV_ID,
    },
  ]);

  assert.deepEqual(
    await repo.createCollaborator({
      ...ACTOR,
      expected_version: 0,
      collaborator_id: CTV_ID,
      display_name: "Nguyễn Văn CTV",
      address: "25 Tran Hung Dao",
      phone: "0987654321",
      reason: null,
      idempotency_key: KEY,
    }),
    { ok: true, data: CREATE_RESULT },
  );
  assert.deepEqual(calls[2], [
    "direct_entry_create_collaborator",
    {
      p_auth_subject: ACTOR.auth_subject,
      p_app_user_id: ACTOR.app_user_id,
      p_expected_version: 0,
      p_collaborator_id: CTV_ID,
      p_display_name: "Nguyễn Văn CTV",
      p_reason: null,
      p_idempotency_key: KEY,
      p_address: "25 Tran Hung Dao",
      p_phone: "0987654321",
    },
  ]);

  assert.deepEqual(
    await repo.updateCollaborator({
      ...ACTOR,
      collaborator_id: CTV_ID,
      expected_version: 2,
      display_name: "Nguyễn Văn CTV Mới",
      reason: "Rename",
      idempotency_key: KEY,
    }),
    { ok: true, data: MUTATION },
  );
  assert.deepEqual(calls[3], [
    "direct_entry_update_collaborator",
    {
      p_auth_subject: ACTOR.auth_subject,
      p_app_user_id: ACTOR.app_user_id,
      p_collaborator_id: CTV_ID,
      p_expected_version: 2,
      p_display_name: "Nguyễn Văn CTV Mới",
      p_reason: "Rename",
      p_idempotency_key: KEY,
      p_address: null,
      p_phone: null,
    },
  ]);

  assert.deepEqual(
    await repo.setCollaboratorActive({
      ...ACTOR,
      collaborator_id: CTV_ID,
      active: false,
      expected_version: 2,
      reason: null,
      idempotency_key: KEY,
    }),
    { ok: true, data: MUTATION },
  );
  assert.deepEqual(calls[4], [
    "direct_entry_set_collaborator_active",
    {
      p_auth_subject: ACTOR.auth_subject,
      p_app_user_id: ACTOR.app_user_id,
      p_collaborator_id: CTV_ID,
      p_active: false,
      p_expected_version: 2,
      p_reason: null,
      p_idempotency_key: KEY,
    },
  ]);

  const malformed = createCollaboratorCatalogRepository(async () => ({
    data: { unexpected: true },
    error: null,
  }));
  assert.deepEqual(
    await malformed.listCollaborators({
      ...ACTOR,
      search: null,
      include_inactive: false,
      page: 1,
      page_size: 25,
    }),
    { ok: false, kind: "unavailable" },
  );

  const codeConflict = createCollaboratorCatalogRepository(async () => ({
    data: null,
    error: { code: "PT409", message: "PARTNER_CODE_CONFLICT" },
  }));
  assert.deepEqual(
    await codeConflict.createCollaborator({
      ...ACTOR,
      expected_version: 0,
      collaborator_id: CTV_ID,
      display_name: "Nguyễn Văn CTV",
      reason: null,
      idempotency_key: KEY,
    }),
    { ok: false, kind: "code-conflict" },
  );
});
