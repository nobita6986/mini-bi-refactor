import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccount,
  listAccounts,
  mutateAccount,
} from "./app-user-access-api.ts";
import { createAccountAccessRepository, classifyAccountAccessError } from "./app-user-access-repository.ts";
import {
  projectExistingAccount,
  projectExistingAccountList,
  parseAccountMutation,
} from "./app-user-access-contract.ts";

const ACTOR = {
  auth_subject: "10000000-0000-4000-8000-000000000101",
  app_user_id: "20000000-0000-4000-8000-000000000101",
  display_name: "Synthetic Admin",
  enabled: true,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
  self_recruiter_suggestion: null,
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};
const ACCOUNT = {
  account_ref: "40000000-0000-4000-8000-000000000103",
  display_name: "Target",
  login_id: "target.td",
  enabled: true,
  version: 1,
  account_type: "NORMAL",
  active_person_link: null,
};
const LIST = { search: null, enabled: "all", page: 1, page_size: 25, total: 1, accounts: [ACCOUNT] };
function deps(overrides = {}) {
  return {
    resolveSession: async () => ({ actor: { ok: true, actor: ACTOR } }),
    repository: {
      listAccounts: async () => ({ ok: true, data: LIST }),
      getAccount: async () => ({ ok: true, data: ACCOUNT }),
      enableAccount: async () => ({ ok: true, data: null }),
      disableAccount: async () => ({ ok: true, data: null }),
      ...overrides,
    },
  };
}
function request(url, init = {}) {
  return new Request(`https://app.test${url}`, init);
}
function json(body, headers = {}) {
  return { method: "POST", headers: { origin: "https://app.test", host: "app.test", "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

test("strict projection rejects raw identity and extra fields", () => {
  assert.deepEqual(Object.keys(projectExistingAccount(ACCOUNT)).sort(), [
    "account_ref",
    "account_type",
    "active_person_link",
    "display_name",
    "enabled",
    "login_id",
    "version",
  ]);
  assert.deepEqual(Object.keys(projectExistingAccountList(LIST)).sort(), ["accounts", "enabled", "page", "page_size", "search", "total"]);
  assert.ok(
    projectExistingAccount({
      ...ACCOUNT,
      active_person_link: {
        link_id: "50000000-0000-4000-8000-000000000104",
        person_id: "60000000-0000-4000-8000-000000000105",
        employee_code: "TD-003",
        full_name: "Target",
        started_at: "2026-10-24T00:00:00.000Z",
        person_version: 1,
      },
    }),
  );
  assert.equal(projectExistingAccount({ ...ACCOUNT, account_type: "BOT" }), null);
  assert.equal(projectExistingAccount({ ...ACCOUNT, email: "x@example.test" }), null);
  assert.equal(projectExistingAccount({ ...ACCOUNT, account_label: "TK-abcdef12" }), null);
  assert.equal(projectExistingAccount({ ...ACCOUNT, auth_subject: ACTOR.auth_subject }), null);
  assert.equal(projectExistingAccountList({ ...LIST, raw_uuid: ACCOUNT.account_ref }), null);
});

test("account mutation contract canonicalizes optional reasons and rejects malformed values", () => {
  for (const reason of [undefined, null, "", "   "]) {
    const body = { expected_version: 1, idempotency_key: "40000000-0000-4000-8000-000000000201" };
    if (reason !== undefined) body.reason = reason;
    assert.deepEqual(parseAccountMutation(body), { ok: true, value: {
      expected_version: 1, reason: null, idempotency_key: body.idempotency_key,
    } });
  }
  assert.equal(parseAccountMutation({ expected_version: 1, reason: 123,
    idempotency_key: "40000000-0000-4000-8000-000000000201" }).ok, false);
  assert.equal(parseAccountMutation({ expected_version: 1, reason: "x".repeat(4001),
    idempotency_key: "40000000-0000-4000-8000-000000000201" }).ok, false);
});

test("non-canonical display names and search echoes fail closed through the repository", async () => {
  for (const value of [" Target", "Target ", "\tTarget", "Target\n"]) {
    const account = { ...ACCOUNT, display_name: value };
    const repository = createAccountAccessRepository(async (name) => ({
      data: name === "direct_entry_get_app_user_admin"
        ? account : { ...LIST, accounts: [account] },
      error: null,
    }));
    const dependencies = { ...deps(), repository };
    const detail = await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", dependencies);
    assert.deepEqual([detail.status, await detail.json()], [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }]);
    const list = await listAccounts(request("/api/admin/access/accounts"), "true", dependencies);
    assert.deepEqual([list.status, await list.json()], [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }]);

    const searchRepository = createAccountAccessRepository(async () => ({
      data: { ...LIST, search: value }, error: null,
    }));
    const search = await listAccounts(request("/api/admin/access/accounts?search=Target"), "true", {
      ...deps(), repository: searchRepository,
    });
    assert.deepEqual([search.status, await search.json()], [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }]);
  }
  assert.deepEqual(projectExistingAccount({ ...ACCOUNT, display_name: "T".repeat(256) }), {
    ...ACCOUNT, display_name: "T".repeat(256),
  });
  assert.deepEqual(projectExistingAccountList({ ...LIST, search: "Target" }), { ...LIST, search: "Target" });
});

test("null, missing and invalid session actors are denied before any RPC", async () => {
  let rpcCalls = 0;
  const repository = createAccountAccessRepository(async () => {
    rpcCalls += 1;
    return { data: null, error: null };
  });
  for (const resolution of [
    { ok: true, actor: null },
    { ok: true },
    { ok: true, actor: { ...ACTOR, auth_subject: "not-a-uuid" } },
    { ok: true, actor: { ...ACTOR, app_user_id: "not-a-uuid" } },
    { ok: true, actor: { ...ACTOR, auth_subject: [ACTOR.auth_subject] } },
    { ok: true, actor: { ...ACTOR, app_user_id: [ACTOR.app_user_id] } },
  ]) {
    const dependencies = {
      repository, resolveSession: async () => ({ actor: resolution }),
    };
    const responses = [
      await listAccounts(request("/api/admin/access/accounts"), "true", dependencies),
      await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", dependencies),
    ];
    for (const action of ["enable", "disable"]) {
      responses.push(await mutateAccount(request(`/api/admin/access/accounts/ref/${action}`, json({
        expected_version: 1, reason: "R2-R2 reason",
        idempotency_key: "40000000-0000-4000-8000-000000000201",
      })), ACCOUNT.account_ref, action, "true", dependencies));
    }
    for (const response of responses) {
      assert.deepEqual([response.status, await response.json()], [403, { ok: false, code: "ACTOR_NOT_AVAILABLE" }]);
    }
    assert.equal(rpcCalls, 0);
  }
});

test("R2 API list/detail allow only strict server projections", async () => {
  const list = await listAccounts(request("/api/admin/access/accounts?search=%20TaRgEt%20&enabled=all&page=1&page_size=25"), "true", deps({
    listAccounts: async (input) => ({ ok: true, data: { ...LIST, search: input.search } }),
  }));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { ok: true, list: { ...LIST, search: "TaRgEt" } });
  const detail = await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", deps());
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { ok: true, account: ACCOUNT });
  const malformed = await listAccounts(request("/api/admin/access/accounts?search=%20"), "true", deps());
  assert.deepEqual([malformed.status, await malformed.json()], [400, { ok: false, code: "ACCOUNT_INVALID" }]);
  const malformedRepo = createAccountAccessRepository(async () => ({ data: { ...LIST, accounts: [{ ...ACCOUNT, email: "x@example.test" }] }, error: null }));
  const leaked = await listAccounts(request("/api/admin/access/accounts"), "true", deps({
    listAccounts: (...args) => malformedRepo.listAccounts(args[0]),
  }));
  assert.deepEqual([leaked.status, await leaked.json()], [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }]);
});

test("R2 API mutations enforce gate, same-origin, bounded exact body and return no row", async () => {
  let called = null;
  const repository = {
    ...deps().repository,
    disableAccount: async (input) => { called = input; return { ok: true, data: null }; },
  };
  const response = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({
    expected_version: 1, reason: "R2 reason", idempotency_key: "40000000-0000-4000-8000-000000000201",
  }, { "idempotency-key": "40000000-0000-4000-8000-000000000201" })), ACCOUNT.account_ref, "disable", "true", deps(repository));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(called, { auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref, expected_version: 1, reason: "R2 reason", idempotency_key: "40000000-0000-4000-8000-000000000201" });

  for (const reason of [undefined, null, "", "   "]) {
    let optionalCall = null;
    const body = { expected_version: 1,
      idempotency_key: "40000000-0000-4000-8000-000000000211" };
    if (reason !== undefined) body.reason = reason;
    const optional = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json(body)),
      ACCOUNT.account_ref, "disable", "true", deps({
        disableAccount: async (input) => { optionalCall = input; return { ok: true, data: null }; },
      }));
    assert.equal(optional.status, 200);
    assert.equal(optionalCall.reason, null);
  }
  for (const reason of [123, "x".repeat(4001)]) {
    const invalid = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({
      expected_version: 1, reason,
      idempotency_key: "40000000-0000-4000-8000-000000000212",
    })), ACCOUNT.account_ref, "disable", "true", deps());
    assert.equal(invalid.status, 400);
  }

  const invalidActor = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "x", idempotency_key: "40000000-0000-4000-8000-000000000202" })), ACCOUNT.account_ref, "disable", "true", {
    resolveSession: async () => ({ actor: { ok: true, actor: { ...ACTOR, auth_subject: "not-a-uuid" } } }),
    repository: deps().repository,
  });
  assert.deepEqual([invalidActor.status, await invalidActor.json()], [403, { ok: false, code: "ACTOR_NOT_AVAILABLE" }]);
  const invalidIdempotency = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "x", idempotency_key: "not-a-uuid" })), ACCOUNT.account_ref, "disable", "true", deps());
  assert.deepEqual([invalidIdempotency.status, await invalidIdempotency.json()], [400, { ok: false, code: "ACCOUNT_INVALID" }]);
  const mismatch = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "R2 reason", idempotency_key: "40000000-0000-4000-8000-000000000201" }, { "idempotency-key": "other" })), ACCOUNT.account_ref, "disable", "true", deps());
  assert.equal(mismatch.status, 400);
  const csrf = await mutateAccount(request("/api/admin/access/accounts/ref/disable", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", host: "app.test" }, body: JSON.stringify({ expected_version: 1, reason: "x", idempotency_key: "k" }) }), ACCOUNT.account_ref, "disable", "true", deps());
  assert.equal(csrf.status, 403);
  const off = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "x", idempotency_key: "k" })), ACCOUNT.account_ref, "disable", "false", deps());
  assert.equal(off.status, 404);
});

test("R2 API denies unavailable actors and maps repository taxonomy", async () => {
  const denied = await listAccounts(request("/api/admin/access/accounts"), "true", {
    ...deps(), resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }),
  });
  assert.deepEqual([denied.status, await denied.json()], [403, { ok: false, code: "ACTOR_NOT_AVAILABLE" }]);
  for (const [sqlstate, kind] of [["40001", "conflict"], ["PT409", "conflict"], ["42501", "denied"], ["P0002", "not-found"], ["22023", "invalid"], ["XX000", "unavailable"]]) {
    assert.equal(classifyAccountAccessError({ code: sqlstate }), kind);
  }
  const malformedRepo = createAccountAccessRepository(async () => ({ data: { ...ACCOUNT, extra: true }, error: null }));
  const malformed = await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", deps({
    getAccount: (...args) => malformedRepo.getAccount(args[0]),
  }));
  assert.equal(malformed.status, 500);
});

test("repository exposes only canonical read/lifecycle RPCs", async () => {
  const calls = [];
  const repo = createAccountAccessRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_app_users_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_app_user_admin") return { data: ACCOUNT, error: null };
    return { data: { change: "disable" }, error: null };
  });
  await repo.listAccounts({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, search: null, enabled: "all", page: 1, page_size: 25 });
  await repo.getAccount({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref });
  await repo.disableAccount({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref, expected_version: 1, reason: "x", idempotency_key: "k" });
  assert.deepEqual(calls.map(([name]) => name), ["direct_entry_list_app_users_admin", "direct_entry_get_app_user_admin", "direct_entry_disable_app_user"]);
});
