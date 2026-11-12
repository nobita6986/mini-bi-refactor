import assert from "node:assert/strict";
import test from "node:test";

import {
  grantProjectTeamScope,
  listProjectTeamScopes,
  parseListScopesQuery,
  revokeProjectTeamScope,
} from "./project-team-scope-api.ts";

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
};
const KEY = "55555555-5555-4555-8555-555555555555";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const TEAM = "66666666-6666-4666-8666-666666666666";
const CREATED = [
  { mapping_id: MAPPING, project_id: "project-1", team_id: TEAM,
    valid_from: "2026-10-15", valid_to: null, version: 1, created: true },
  { mapping_id: "88888888-8888-4888-8888-888888888888", project_id: "project-2", team_id: TEAM,
    valid_from: "2026-10-15", valid_to: null, version: 1, created: true },
];
const BATCH = {
  team_id: TEAM, effective_from: "2026-10-15", created: CREATED,
  skipped: [{
    project_id: "project-3", status: "ALREADY_EFFECTIVE",
    mapping_id: "99999999-9999-4999-8999-999999999999", version: 2,
  }],
};
const LIST = {
  authorization_date: "2026-10-15", include_history: false, page: 1, page_size: 25,
  total: 1, has_more: false,
  mappings: [{
    mapping_id: MAPPING, project_id: "project-1", project_display_name: "Dự án 1",
    team_id: TEAM, team_display_name: "Nhóm A", team_code: "A",
    valid_from: "2026-10-15", valid_to: null, effective: true, state: "CURRENT",
    version: 1, revoked_at: null, created_at: "2026-10-15T00:00:00Z",
  }],
};

function dependencies(result, session = { actor: { ok: true, actor: ACTOR }, response_headers: {} }) {
  const calls = { session: 0, repository: [] };
  return {
    calls,
    value: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listScopes: async (input) => { calls.repository.push(["list", input]); return result; },
        grantScope: async (input) => { calls.repository.push(["grant", input]); return result; },
        revokeScope: async (input) => { calls.repository.push(["revoke", input]); return result; },
      },
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: "https://app.test", host: "app.test",
      "sec-fetch-site": "same-origin", ...headers,
    },
    body: JSON.stringify(body),
  });
}

const grantBody = {
  team_id: TEAM, project_ids: ["project-1", "project-2", "project-3"],
  reason: "UAT grant", idempotency_key: KEY,
};
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date());
const revokeBody = {
  mapping_id: MAPPING, effective_to: TODAY_VN,
  reason: "same-day cancellation", idempotency_key: KEY,
};

test("list requires resolved active actor, forwards bounded filters, and is private no-store", async () => {
  const d = dependencies({ ok: true, data: LIST });
  const response = await listProjectTeamScopes(
    new Request("https://app.test/api?project_id=project-1&include_history=true&page=2&page_size=50"),
    "true", d.value,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(d.calls.repository[0], ["list", {
    ...ACTOR, project_id: "project-1", team_id: null, search: null,
    include_history: true, page: 2, page_size: 50,
  }]);
  assert.deepEqual((await response.json()).list, LIST);
});

test("list forwards the trimmed fuzzy search and still accepts the exact legacy filters", async () => {
  const d = dependencies({ ok: true, data: LIST });
  const response = await listProjectTeamScopes(
    new Request("https://app.test/api?search=%20Compal%20&include_history=false"),
    "true", d.value,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(d.calls.repository[0], ["list", {
    ...ACTOR, project_id: null, team_id: null, search: "Compal",
    include_history: false, page: 1, page_size: 25,
  }]);

  // Whitespace-only search collapses to "no filter" instead of a 400.
  const blank = dependencies({ ok: true, data: LIST });
  assert.equal((await listProjectTeamScopes(
    new Request("https://app.test/api?search=%20%20%20"), "true", blank.value)).status, 200);
  assert.equal(blank.calls.repository[0][1].search, null);

  // Exact project_id/team_id callers keep working alongside the search parameter.
  const exact = dependencies({ ok: true, data: LIST });
  assert.equal((await listProjectTeamScopes(
    new Request(`https://app.test/api?project_id=project-1&team_id=${TEAM}&search=compal`),
    "true", exact.value)).status, 200);
  assert.deepEqual(exact.calls.repository[0][1], {
    ...ACTOR, project_id: "project-1", team_id: TEAM, search: "compal",
    include_history: false, page: 1, page_size: 25,
  });
});

test("search rejects oversized or control-character input before session", async () => {
  for (const query of [
    "?search=" + encodeURIComponent("x".repeat(257)),
    "?search=" + encodeURIComponent("compal\u0007"),
    "?search=a&search=b",
  ]) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await listProjectTeamScopes(new Request(`https://app.test/api${query}`), "true", d.value);
    assert.equal(response.status, 400, query);
    assert.equal(d.calls.session, 0, query);
    assert.equal(d.calls.repository.length, 0, query);
  }
  assert.equal(parseListScopesQuery(new URL("https://app.test/api?search=" + encodeURIComponent("y".repeat(256)))).ok, true);
});

test("query rejects unknown, duplicate, malformed, and out-of-range pagination before session", async () => {
  const invalid = [
    "?actor=admin", "?page=1&page=2", "?page=0", "?page=1001", "?page_size=101",
    "?team_id=not-a-uuid", "?include_history=yes",
  ];
  for (const query of invalid) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await listProjectTeamScopes(new Request(`https://app.test/api${query}`), "true", d.value);
    assert.equal(response.status, 400, query);
    assert.equal(d.calls.session, 0, query);
    assert.equal(d.calls.repository.length, 0, query);
  }
  assert.equal(parseListScopesQuery(new URL("https://app.test/api?page=1000&page_size=100")).ok, true);
});

test("batch grant and revoke derive actor from session and forward no client OCC version", async () => {
  const grant = dependencies({ ok: true, data: BATCH });
  const grantResponse = await grantProjectTeamScope(post("/api", grantBody), "true", grant.value);
  assert.equal(grantResponse.status, 200);
  assert.equal(grantResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(grant.calls.repository[0], ["grant", { ...ACTOR, ...grantBody }]);
  assert.deepEqual((await grantResponse.json()).batch, BATCH);

  const revoke = dependencies({ ok: true, data: { mapping_id: MAPPING, project_id: "project-1",
    team_id: TEAM, valid_to: "2026-10-15", version: 2, revoked: true } });
  const revokeResponse = await revokeProjectTeamScope(post("/api", revokeBody), "true", revoke.value);
  assert.equal(revokeResponse.status, 200);
  assert.deepEqual(revoke.calls.repository[0], ["revoke", { ...ACTOR, ...revokeBody }]);

  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...grantBody };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const optional = dependencies({ ok: true, data: BATCH });
    const response = await grantProjectTeamScope(post("/api", body), "true", optional.value);
    assert.equal(response.status, 200);
    assert.equal(optional.calls.repository[0][1].reason, null);
  }
  for (const reason of [123, "x".repeat(4001)]) {
    const invalid = dependencies({ ok: true, data: BATCH });
    assert.equal((await grantProjectTeamScope(post("/api", { ...grantBody, reason }),
      "true", invalid.value)).status, 400);
    assert.equal(invalid.calls.session, 0);
  }
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...revokeBody };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const optional = dependencies({ ok: true, data: { mapping_id: MAPPING,
      project_id: "project-1", team_id: TEAM, valid_to: "2026-10-15", version: 2, revoked: true } });
    const response = await revokeProjectTeamScope(post("/api", body), "true", optional.value);
    assert.equal(response.status, 200);
    assert.equal(optional.calls.repository[0][1].reason, null);
  }
});

test("flag, CSRF, and content-type reject before session or repository", async () => {
  const disabled = dependencies({ ok: true, data: LIST });
  assert.equal((await grantProjectTeamScope(post("/api", grantBody), "false", disabled.value)).status, 404);
  const csrf = dependencies({ ok: true, data: LIST });
  const csrfResponse = await grantProjectTeamScope(post("/api", grantBody, { origin: "https://evil.test" }), "true", csrf.value);
  assert.equal(csrfResponse.status, 403);
  assert.equal((await csrfResponse.json()).code, "CSRF_REJECTED");
  const contentType = dependencies({ ok: true, data: LIST });
  const wrongType = new Request("https://app.test/api", {
    method: "POST", headers: { origin: "https://app.test", host: "app.test", "content-type": "text/plain" }, body: "{}",
  });
  assert.equal((await grantProjectTeamScope(wrongType, "true", contentType.value)).status, 400);
  for (const d of [disabled, csrf, contentType]) {
    assert.equal(d.calls.session, 0);
    assert.equal(d.calls.repository.length, 0);
  }
});

test("anonymous, disabled, and malformed actor are denied without mapping reads", async () => {
  const cases = [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" }, response_headers: {} }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { ...ACTOR, app_user_id: "bad" } }, response_headers: {} }, 403, "ACTOR_NOT_AVAILABLE"],
  ];
  for (const [session, status, code] of cases) {
    const d = dependencies({ ok: true, data: LIST }, session);
    const response = await listProjectTeamScopes(new Request("https://app.test/api"), "true", d.value);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(d.calls.repository.length, 0);
  }
});

test("authority fields and unknown body keys are rejected before session", async () => {
  for (const extra of [{ actor: "admin" }, { auth_subject: ACTOR.auth_subject },
    { app_user_id: ACTOR.app_user_id }, { capabilities: ["entry_admin"] }, { scope: "all" },
    { role: "admin" }, { actor: { authority: "Full Admin" } }]) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await grantProjectTeamScope(post("/api", { ...grantBody, ...extra }), "true", d.value);
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal((await response.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
    assert.equal(d.calls.session, 0);
    assert.equal(d.calls.repository.length, 0);
  }
  for (const extra of [{ expected_pair_version: 0 }, { expected_version: 1 }]) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await grantProjectTeamScope(post("/api", { ...grantBody, ...extra }), "true", d.value);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "PROJECT_TEAM_SCOPE_INVALID");
    assert.equal(d.calls.session, 0);
  }
  const revokeWithVersion = dependencies({ ok: true, data: LIST });
  const revokeResponse = await revokeProjectTeamScope(
    post("/api", { ...revokeBody, expected_pair_version: 1 }), "true", revokeWithVersion.value,
  );
  assert.equal(revokeResponse.status, 400);
  assert.equal(revokeWithVersion.calls.session, 0);
  assert.equal(revokeWithVersion.calls.repository.length, 0);
  const d = dependencies({ ok: true, data: LIST });
  const response = await grantProjectTeamScope(post("/api", { ...grantBody, extra: true }), "true", d.value);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "PROJECT_TEAM_SCOPE_INVALID");
  assert.equal(d.calls.session, 0);
});

test("bounded JSON and invalid batch values are rejected before session", async () => {
  const invalid = [
    { ...grantBody, project_ids: [] },
    { ...grantBody, project_ids: ["project-1", "project-1"] },
    { ...grantBody, project_ids: Array.from({ length: 101 }, (_, i) => `p-${i}`) },
    { ...grantBody, effective_from: "2020-01-01" },
    { ...grantBody, project_ids: ["bad project"] },
    { ...grantBody, team_id: "66666666-6666-4666-8666-666666666666", effective_date: "2026-02-30" },
  ];
  for (const body of invalid) {
    const d = dependencies({ ok: true, data: BATCH });
    const response = await grantProjectTeamScope(post("/api", body), "true", d.value);
    assert.equal(response.status, 400);
    assert.equal(d.calls.session, 0);
    assert.equal(d.calls.repository.length, 0);
  }
  const d = dependencies({ ok: true, data: BATCH });
  const oversized = new Request("https://app.test/api", {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: "https://app.test", host: "app.test",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ ...grantBody, reason: "x".repeat(70_000) }),
  });
  assert.equal((await grantProjectTeamScope(oversized, "true", d.value)).status, 400);
  assert.equal(d.calls.session, 0);

  const invalidRevoke = dependencies({ ok: true, data: BATCH });
  const badDate = await revokeProjectTeamScope(post("/api", {
    ...revokeBody, effective_to: "2026-02-30",
  }), "true", invalidRevoke.value);
  assert.equal(badDate.status, 400);
  assert.equal(invalidRevoke.calls.session, 0);
});

test("sanitized repository errors retain status taxonomy and never expose DB text", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "PROJECT_TEAM_SCOPE_DENIED"], ["not-found", 404, "PROJECT_TEAM_SCOPE_NOT_FOUND"],
    ["conflict", 409, "PROJECT_TEAM_SCOPE_CONFLICT"], ["invalid", 400, "PROJECT_TEAM_SCOPE_INVALID"],
    ["unavailable", 500, "PROJECT_TEAM_SCOPE_UNAVAILABLE"],
  ]) {
    const d = dependencies({ ok: false, kind });
    const response = await grantProjectTeamScope(post("/api", grantBody), "true", d.value);
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(text.includes(code));
    assert.equal(text.includes("database"), false);
    assert.equal(text.includes("sensitive"), false);
  }
});
