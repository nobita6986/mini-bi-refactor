import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAuthLoginResponse,
  createAuthLogoutResponse,
  createAuthSessionResponse,
} from "./auth-session-core.ts";
import { resolveActor } from "./direct-entry-v2.ts";
// P3-W08A regression matrix: re-registered here so the suite runs as
// part of the canonical `pnpm test:server` path. The W08A test file
// imports this module's *production* code (`./auth-session-core.ts`)
// and never references this test module, so the import is one-way and
// introduces no cycle.
import "./p3-w08a-session-revocation-cache.test.mjs";

const actor = {
  auth_subject: "auth-subject-must-not-leak",
  app_user_id: "app-user-1",
  display_name: "Synthetic Account",
  enabled: true,
  capabilities: ["entry_create"],
  scopes: [{ kind: "own", reference: "app-user-1", valid_from: "0001-01-01", valid_to: null }],
  self_recruiter_suggestion: "recruiter-1",
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};
const repository = { loadByAuthSubject: async () => null };
const validResolution = { ok: true, actor };
const baseDependencies = () => ({
  createClient: async () => { throw new Error("unexpected client creation"); },
  repository,
  resolveActor: async () => validResolution,
  now: () => "2026-01-01T00:00:00.000Z",
});
const request = (path, body) => new Request(`https://app.example${path}`, {
  method: "POST",
  headers: {
    Origin: "https://app.example",
    Host: "app.example",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const reverseProxiedRequest = (path, body, headers = {}) => new Request(`http://bi-app:3000${path}`, {
  method: "POST",
  headers: {
    Origin: "https://app.example",
    Host: "app.example",
    "X-Forwarded-Proto": "https",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    ...headers,
  },
  body: JSON.stringify(body),
});
const credentials = { email: " user@example.com ", password: "  keep exact  " };
const successClient = (overrides = {}) => ({
  auth: {
    signInWithPassword: async () => ({ data: { user: { id: "trusted-auth-subject" } }, error: null }),
    getUser: async () => ({ data: { user: { id: "trusted-auth-subject" } }, error: null }),
    signOut: async () => ({ error: null }),
    ...overrides,
  },
});

test("login validates origin and exact bounded credentials before creating a client", async () => {
  const invalidRequests = [
    [new Request("https://app.example/api/auth/login", { method: "POST", headers: { Host: "app.example" }, body: JSON.stringify(credentials) }), 403],
    [request("/api/auth/login", { ...credentials, role: "admin" }), 400],
    [request("/api/auth/login", { ...credentials, authority: { capabilities: ["*"] } }), 400],
    [request("/api/auth/login", { email: { nested: "user@example.com" }, password: "pw" }), 400],
    [request("/api/auth/login", { email: "user@.example.com", password: "pw" }), 400],
    [new Request("https://app.example/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://app.example", Host: "app.example", "Content-Type": "application/json" },
      body: "x".repeat(4097),
    }), 400],
    [new Request("https://app.example/api/auth/login", {
      method: "POST",
      headers: { Origin: "http://app.example", Host: "app.example", "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }), 403],
  ];
  for (const [req, expectedStatus] of invalidRequests) {
    let created = 0;
    const response = await createAuthLoginResponse(req, {
      ...baseDependencies(),
      createClient: async () => { created++; return successClient(); },
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(created, 0);
  }
});

test("login and logout accept same-origin requests when TLS terminates at the reverse proxy", async () => {
  let loginCalls = 0;
  const login = await createAuthLoginResponse(
    reverseProxiedRequest("/api/auth/login", credentials),
    {
      ...baseDependencies(),
      createClient: async () => {
        loginCalls++;
        return successClient();
      },
    },
  );
  assert.equal(login.status, 200);
  assert.equal(loginCalls, 1);

  let logoutCalls = 0;
  const logout = await createAuthLogoutResponse(
    reverseProxiedRequest("/api/auth/logout", {}),
    {
      createClient: async () => {
        logoutCalls++;
        return successClient();
      },
    },
  );
  assert.equal(logout.status, 204);
  assert.equal(logoutCalls, 1);

  for (const headers of [
    { Origin: "https://attacker.example" },
    { "X-Forwarded-Proto": "http" },
    { "X-Forwarded-Proto": "https,http" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    let deniedCalls = 0;
    const denied = await createAuthLoginResponse(
      reverseProxiedRequest("/api/auth/login", credentials, headers),
      {
        ...baseDependencies(),
        createClient: async () => {
          deniedCalls++;
          return successClient();
        },
      },
    );
    assert.equal(denied.status, 403);
    assert.equal(deniedCalls, 0);
  }
});

test("login verifies returned auth id and returns only the minimal actor projection", async () => {
  let input;
  let resolveInput;
  const dependencies = {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async (value) => {
        input = value;
        return { data: { user: { id: "trusted-auth-subject" } }, error: null };
      },
    }),
    resolveActor: async (value) => { resolveInput = value; return validResolution; },
  };
  const response = await createAuthLoginResponse(request("/api/auth/login", credentials), dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(input, { email: "user@example.com", password: credentials.password });
  assert.equal(resolveInput.session.auth_subject, "trusted-auth-subject");
  assert.deepEqual(await response.json(), {
    ok: true,
    actor: {
      app_user_id: actor.app_user_id,
      display_name: "Synthetic Account",
      capabilities: actor.capabilities,
      scopes: actor.scopes,
      self_recruiter_suggestion: actor.self_recruiter_suggestion,
    },
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("login projects the actor repository's current team scopes", async () => {
  const authSubject = "11111111-1111-4111-8111-111111111111";
  const appUserId = "22222222-2222-4222-8222-222222222222";
  const teamId = "33333333-3333-4333-8333-333333333333";
  const response = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({ data: { user: { id: authSubject } }, error: null }),
    }),
    repository: {
      async loadByAuthSubject() {
        return {
          auth_subject: authSubject,
          app_user_id: appUserId,
          display_name: "Synthetic Marker Account",
          enabled: true,
          capabilities: ["entry_team"],
          recruiter_links: [],
          teams: [{ team_id: teamId, code: "T01", display: "Synthetic team", active: true }],
          team_scope_grants: [
            { team_id: teamId, valid_from: "2026-01-01", valid_to: null },
          ],
          all_scope_grants: [],
        };
      },
    },
    resolveActor,
    now: () => "2026-10-19T00:00:00.000Z",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.actor.app_user_id, appUserId);
  assert.deepEqual(body.actor.scopes.filter((scope) => scope.kind === "team"), [{
    kind: "team",
    reference: teamId,
    valid_from: "2026-01-01",
    valid_to: null,
  }]);
});

test("login accepts an HR Partner account ID and maps it to the internal @hrpartner.vn email", async () => {
  let input;
  const response = await createAuthLoginResponse(
    request("/api/auth/login", { email: " VinhNT.TD ", password: "temporary" }),
    {
      ...baseDependencies(),
      createClient: async () => successClient({
        signInWithPassword: async (value) => {
          input = value;
          return { data: { user: { id: "trusted-auth-subject" } }, error: null };
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(input, { email: "vinhnt.td@hrpartner.vn", password: "temporary" });
});

test("login returns generic credentials failure and actor rejection signs out locally", async () => {
  const rejected = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({ data: { user: null }, error: new Error("provider detail") }),
    }),
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { ok: false, code: "AUTH_INVALID_CREDENTIALS" });

  let signOutOptions;
  let resolved = 0;
  const unavailable = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signOut: async (options) => { signOutOptions = options; return { error: null }; },
    }),
    resolveActor: async () => { resolved++; return { ok: false, reason: "ACTOR_DISABLED" }; },
  });
  assert.equal(unavailable.status, 403);
  assert.equal(resolved, 1);
  assert.deepEqual(signOutOptions, { scope: "local" });
  assert.deepEqual(await unavailable.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
});

test("login never exposes credentials, tokens, provider errors, or auth subject", async () => {
  const secrets = ["user@example.com", credentials.password, "access-secret", "refresh-secret", "provider detail"];
  const response = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({
        data: { user: null },
        error: Object.assign(new Error("provider detail access-secret refresh-secret"), { status: 400 }),
      }),
    }),
  });
  const output = await response.text();
  for (const secret of secrets) assert.equal(output.includes(secret), false);
  assert.equal(output.includes("auth-subject"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const unavailable = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({
        data: { user: null },
        error: Object.assign(new Error("provider detail"), { status: 503 }),
      }),
    }),
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, code: "AUTH_UNAVAILABLE" });
});

test("logout is same-origin guarded, local, idempotent and no-store", async () => {
  let calls = 0;
  const dependencies = {
    createClient: async () => {
      calls++;
      return successClient({
        signOut: async (options) => {
          assert.deepEqual(options, { scope: "local" });
          return { error: null };
        },
      });
    },
  };
  const denied = await createAuthLogoutResponse(
    new Request("https://app.example/api/auth/logout", { method: "POST", headers: { Host: "app.example" } }),
    dependencies,
  );
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);
  const response = await createAuthLogoutResponse(request("/api/auth/logout"), dependencies);
  assert.equal(response.status, 204);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const noSession = await createAuthLogoutResponse(request("/api/auth/logout"), {
    createClient: async () => successClient({
      signOut: async () => ({ error: null }),
    }),
  });
  assert.equal(noSession.status, 204);
});

test("session uses the trusted actor result and sanitizes unauthenticated/unavailable states", async () => {
  let getUserCalls = 0;
  const success = await createAuthSessionResponse(async () => {
    getUserCalls++;
    const user = await successClient().auth.getUser();
    assert.equal(user.data.user.id, "trusted-auth-subject");
    return { actor: validResolution };
  });
  assert.equal(getUserCalls, 1);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "private, no-store");

  const unauthenticated = await createAuthSessionResponse(async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
  }));
  assert.equal(unauthenticated.status, 401);
  const unavailable = await createAuthSessionResponse(async () => ({
    actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
  }));
  assert.equal(unavailable.status, 403);
  assert.deepEqual(await unavailable.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
});

test("route handlers are dynamic Node server compositions and session reuses getUser bootstrap", () => {
  for (const routePath of [
    "../../app/api/auth/login/route.ts",
    "../../app/api/auth/logout/route.ts",
    "../../app/api/auth/session/route.ts",
  ]) {
    const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
    assert.match(source, /export const runtime = "nodejs"/);
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /createServiceSupabaseClient/);
  }
  const sessionRoute = readFileSync(new URL("../../app/api/auth/session/route.ts", import.meta.url), "utf8");
  assert.match(sessionRoute, /getDirectEntryActor/);
  const sessionCore = readFileSync(new URL("./direct-entry-session-core.ts", import.meta.url), "utf8");
  assert.match(sessionCore, /client\.auth\.getUser\(\)/);
});

test("WP8C-2: auth session and login responses project paired effective_grants without leaking grant metadata and drop stale legacy mirrors or invalid scope pairings", async () => {
  const teamId = "33333333-3333-4333-8333-333333333333";
  const sourceIdA = "44444444-4444-4444-8444-444444444444";
  const sourceIdB = "55555555-5555-4555-8555-555555555555";
  const sourceIdC = "66666666-6666-4666-8666-666666666666";

  const canonicalActor = {
    ...actor,
    capabilities: [],
    scopes: [{ kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null }],
    effective_grants: [
      {
        capability: "entry_admin",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: sourceIdA,
      },
      {
        capability: "document_upload",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "DIRECT_GRANT",
        source_id: sourceIdB,
      },
      {
        capability: "team_manager_assign",
        scope_kind: "CONTEXT_TEAM",
        scope_id: teamId,
        source_type: "CONTEXTUAL_ASSIGNMENT",
        source_id: sourceIdC,
      },
    ],
  };

  const staleLegacyActor = {
    ...actor,
    capabilities: ["entry_admin"],
    scopes: [
      { kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null },
      { kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null },
    ],
    effective_grants: [],
  };

  const invalidPairingActor = {
    ...actor,
    capabilities: ["entry_admin", "team_manager_assign"],
    scopes: [
      { kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null },
      { kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null },
    ],
    effective_grants: [
      {
        capability: "entry_admin",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "DIRECT_GRANT",
        source_id: null,
      },
      {
        capability: "team_manager_assign",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "DIRECT_GRANT",
        source_id: null,
      },
    ],
  };

  const callBoth = async (targetActor) => {
    const sessionRes = await createAuthSessionResponse(async () => ({
      actor: { ok: true, actor: targetActor },
    }));
    const loginRes = await createAuthLoginResponse(request("/api/auth/login", credentials), {
      ...baseDependencies(),
      createClient: async () => successClient(),
      resolveActor: async () => ({ ok: true, actor: targetActor }),
    });
    return [sessionRes, loginRes];
  };

  // 1. Mirror-cleared canonical managed actor gets paired capabilities & derived scopes with zero grant metadata leak
  for (const res of await callBoth(canonicalActor)) {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body.actor).sort(), [
      "app_user_id",
      "capabilities",
      "display_name",
      "scopes",
      "self_recruiter_suggestion",
    ]);
    assert.deepEqual(body.actor.capabilities, [
      "entry_admin",
      "document_upload",
      "team_manager_assign",
    ]);
    assert.deepEqual(body.actor.scopes, [
      { kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null },
      { kind: "team", reference: teamId, valid_from: "0001-01-01", valid_to: null },
      { kind: "all", reference: "all", valid_from: "0001-01-01", valid_to: null },
    ]);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("effective_grants"), false);
    assert.equal(serialized.includes("source_type"), false);
    assert.equal(serialized.includes("source_id"), false);
    assert.equal(serialized.includes("ROLE_BUNDLE"), false);
    assert.equal(serialized.includes(sourceIdA), false);
    assert.equal(serialized.includes("auth_subject"), false);
  }

  // 2. Stale legacy actor with effective_grants: [] gets empty capabilities and own-only scope
  for (const res of await callBoth(staleLegacyActor)) {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.actor.capabilities, []);
    assert.deepEqual(body.actor.scopes, [
      { kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null },
    ]);
  }

  // 3. Invalid scope pairings in effective_grants are dropped from capabilities and scopes
  for (const res of await callBoth(invalidPairingActor)) {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.actor.capabilities, []);
    assert.deepEqual(body.actor.scopes, [
      { kind: "own", reference: actor.app_user_id, valid_from: "0001-01-01", valid_to: null },
    ]);
  }
});

test("WP10-5: createAuthSessionResponse preserves team/all scope query-date metadata (valid_from/valid_to) and keeps own at 0001-01-01/null", async () => {
  const authSubject = "11111111-1111-4111-8111-111111111111";
  const appUserId = "22222222-2222-4222-8222-222222222222";
  const teamId = "33333333-3333-4333-8333-333333333333";
  const queryDate = "2026-11-25";

  const resolution = await resolveActor({
    session: {
      auth_subject: authSubject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: {
      async loadByAuthSubject() {
        return {
          auth_subject: authSubject,
          app_user_id: appUserId,
          display_name: "WP10-5 Metadata Actor",
          enabled: true,
          capabilities: ["entry_admin", "entry_team"],
          recruiter_links: [],
          teams: [{ team_id: teamId, code: "T01", display: "Team 01", active: true }],
          team_scope_grants: [{ team_id: teamId, valid_from: queryDate, valid_to: null }],
          all_scope_grants: [{ valid_from: queryDate, valid_to: null }],
          effective_grants: [
            {
              capability: "entry_admin",
              scope_kind: "ALL",
              scope_id: null,
              source_type: "ROLE_BUNDLE",
              source_id: "44444444-4444-4444-8444-444444444444",
            },
            {
              capability: "entry_team",
              scope_kind: "CONTEXT_TEAM",
              scope_id: teamId,
              source_type: "ROLE_BUNDLE",
              source_id: "55555555-5555-4555-8555-555555555555",
            },
          ],
        };
      },
    },
    at: "2026-11-25T15:00:00.000Z",
  });

  assert.equal(resolution.ok, true);
  const response = await createAuthSessionResponse(async () => ({ actor: resolution }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.actor.scopes, [
    { kind: "own", reference: appUserId, valid_from: "0001-01-01", valid_to: null },
    { kind: "team", reference: teamId, valid_from: queryDate, valid_to: null },
    { kind: "all", reference: "all", valid_from: queryDate, valid_to: null },
  ]);
});

test("Partner accounts: PENDING_ACTIVATION returns ACCOUNT_PENDING_ACTIVATION & signs out; ACTIVE projects partner_account", async () => {
  const authSubject = "11111111-1111-4111-8111-111111111111";
  const appUserId = "22222222-2222-4222-8222-222222222222";
  const partnerAccountId = "33333333-3333-4333-8333-333333333333";

  const makePartnerRecord = (overrides = {}) => ({
    auth_subject: authSubject,
    app_user_id: appUserId,
    display_name: "Vendor Alpha",
    enabled: false,
    capabilities: [],
    recruiter_links: [],
    teams: [],
    team_scope_grants: [],
    all_scope_grants: [],
    allowed_worker_tabs: [],
    effective_grants: [],
    assigned_roles: [],
    partner_account: {
      partner_account_id: partnerAccountId,
      partner_kind: "VENDOR",
      vendor_id: "VND_ALPHA",
      collaborator_id: null,
      partner_id: "VND_ALPHA",
      partner_display_name: "Vendor Alpha",
      partner_active: true,
      canonical_code: "vnd_alpha",
      username: "vnd_alpha",
      account_state: "PENDING_ACTIVATION",
      activated_at: null,
      must_change_password: true,
      password_changed_at: null,
      ...overrides,
    },
  });

  // 1) PENDING_ACTIVATION with active parent -> signs out locally + 403 ACCOUNT_PENDING_ACTIVATION
  let signOutPending = null;
  const pendingRes = await createAuthLoginResponse(
    request("/api/auth/login", { email: "vnd_alpha", password: "hrp@123" }),
    {
      ...baseDependencies(),
      createClient: async () =>
        successClient({
          signInWithPassword: async () => ({ data: { user: { id: authSubject } }, error: null }),
          signOut: async (opts) => {
            signOutPending = opts;
            return { error: null };
          },
        }),
      repository: { loadByAuthSubject: async () => makePartnerRecord() },
      resolveActor,
      now: () => "2026-11-28T10:00:00.000Z",
    },
  );
  assert.equal(pendingRes.status, 403);
  assert.deepEqual(signOutPending, { scope: "local" });
  assert.deepEqual(await pendingRes.json(), { ok: false, code: "ACCOUNT_PENDING_ACTIVATION" });

  // 2) PENDING_ACTIVATION with inactive parent -> generic 403 ACCOUNT_NOT_AVAILABLE
  let signOutInactive = null;
  const inactiveRes = await createAuthLoginResponse(
    request("/api/auth/login", { email: "vnd_alpha", password: "hrp@123" }),
    {
      ...baseDependencies(),
      createClient: async () =>
        successClient({
          signInWithPassword: async () => ({ data: { user: { id: authSubject } }, error: null }),
          signOut: async (opts) => {
            signOutInactive = opts;
            return { error: null };
          },
        }),
      repository: { loadByAuthSubject: async () => makePartnerRecord({ partner_active: false }) },
      resolveActor,
      now: () => "2026-11-28T10:00:00.000Z",
    },
  );
  assert.equal(inactiveRes.status, 403);
  assert.deepEqual(signOutInactive, { scope: "local" });
  assert.deepEqual(await inactiveRes.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });

  // 3) ACTIVE_MUST_CHANGE_PASSWORD -> 200 with minimal partner_account projection (no auth_subject/email/tokens)
  const activeRecord = {
    ...makePartnerRecord({
      account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
      activated_at: "2026-11-28T09:00:00.000Z",
      must_change_password: true,
    }),
    enabled: true,
  };
  const activeLogin = await createAuthLoginResponse(
    request("/api/auth/login", { email: "vnd_alpha", password: "hrp@123" }),
    {
      ...baseDependencies(),
      createClient: async () =>
        successClient({
          signInWithPassword: async () => ({ data: { user: { id: authSubject } }, error: null }),
        }),
      repository: { loadByAuthSubject: async () => activeRecord },
      resolveActor,
      now: () => "2026-11-28T10:00:00.000Z",
    },
  );
  assert.equal(activeLogin.status, 200);
  const loginBody = await activeLogin.json();
  assert.deepEqual(loginBody, {
    ok: true,
    actor: {
      app_user_id: appUserId,
      display_name: "Vendor Alpha",
      capabilities: [],
      scopes: [{ kind: "own", reference: appUserId, valid_from: "0001-01-01", valid_to: null }],
      self_recruiter_suggestion: null,
      partner_account: {
        partner_kind: "VENDOR",
        partner_code: "VND_ALPHA",
        account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
        must_change_password: true,
      },
    },
  });
  const serialized = JSON.stringify(loginBody);
  assert.equal(serialized.includes(authSubject), false);
  assert.equal(serialized.includes("@hrpartner.vn"), false);

  // 4) Session GET also projects partner_account when present
  const resolved = await resolveActor({
    session: { auth_subject: authSubject, provider: "supabase", authenticated_at: null },
    repository: { loadByAuthSubject: async () => activeRecord },
    at: "2026-11-28T10:00:00.000Z",
  });
  const sessionRes = await createAuthSessionResponse(async () => ({ actor: resolved }));
  assert.equal(sessionRes.status, 200);
  assert.deepEqual(await sessionRes.json(), loginBody);
});
