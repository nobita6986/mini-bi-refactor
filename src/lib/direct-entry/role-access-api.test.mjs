import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_JSON_BYTES,
  computeRoleMutationRequestHash,
  createRoleAccessApiHandlers,
  roleAccessNotFoundResponse,
} from "./role-access-api.ts";
import {
  classifyRoleAccessSqlError,
  createRoleAccessRepository,
} from "./role-access-repository.ts";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../docs/contracts/fixtures/wp5b1-role-access/role-access-fixtures.json", import.meta.url),
    "utf8",
  ),
);

const ACTOR_AUTH_SUBJECT = "10000000-0000-4000-8000-000000000101";
const ACTOR_APP_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_ACCOUNT_REF = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const ASSIGNMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";

const PAIRED_FULL_ADMIN_ACTOR = {
  auth_subject: ACTOR_AUTH_SUBJECT,
  app_user_id: ACTOR_APP_USER_ID,
  display_name: "Canonical Owner",
  enabled: true,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: [{ kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null }],
  effective_grants: [
    { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
  ],
  assigned_roles: [],
  self_recruiter_suggestion: null,
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};

function makeRequest(urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://app.test${urlPath}`, {
    method,
    headers: {
      host: "app.test",
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
}

function makeJsonPost(urlPath, payload, headers = {}) {
  return makeRequest(urlPath, {
    method: "POST",
    headers: {
      origin: "https://app.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function makeJsonDelete(urlPath, payload, headers = {}) {
  return makeRequest(urlPath, {
    method: "DELETE",
    headers: {
      origin: "https://app.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("Next.js WP5B-1 admin access routes enforce nodejs/force-dynamic and env gates", () => {
  const routes = [
    { rel: "../../app/api/admin/access/roles/route.ts", requireMutationsGate: false, fn: "listRoles" },
    { rel: "../../app/api/admin/access/accounts-summary/route.ts", requireMutationsGate: false, fn: "listAccountsSummary" },
    { rel: "../../app/api/admin/access/accounts/[accountRef]/access/route.ts", requireMutationsGate: false, fn: "getAccountAccess" },
    { rel: "../../app/api/admin/access/accounts/[accountRef]/roles/route.ts", requireMutationsGate: true, fn: "assignGlobalRole" },
    { rel: "../../app/api/admin/access/accounts/[accountRef]/roles/[assignmentId]/route.ts", requireMutationsGate: true, fn: "revokeGlobalRole" },
  ];

  for (const route of routes) {
    const source = readFileSync(new URL(route.rel, import.meta.url), "utf8");
    assert.match(source, /import\s+"server-only"/, `${route.rel} requires server-only`);
    assert.match(source, /export const runtime = "nodejs"/, `${route.rel} requires nodejs runtime`);
    assert.match(source, /export const dynamic = "force-dynamic"/, `${route.rel} requires force-dynamic`);
    assert.match(source, /process\.env\.DIRECT_ENTRY_API_ENABLED !== "true"/, `${route.rel} gates DIRECT_ENTRY_API_ENABLED`);
    assert.ok(source.includes(`handlers.${route.fn}(`), `${route.rel} delegates to handlers.${route.fn}`);
    if (route.requireMutationsGate) {
      assert.match(source, /process\.env\.AUTHZ_ROLE_MUTATIONS_ENABLED !== "true"/, `${route.rel} gates AUTHZ_ROLE_MUTATIONS_ENABLED`);
    }
  }
});

test("role-access-repository classifies all SQLSTATE and token errors deterministically", () => {
  assert.deepEqual(
    classifyRoleAccessSqlError({ code: "42501", message: "forbidden" }),
    { status: 403, code: "AUTHZ_FORBIDDEN", message: "Tài khoản không có quyền quản trị phân quyền (Full Admin)." },
  );
  assert.deepEqual(
    classifyRoleAccessSqlError({ code: "P0002", message: "ROLE_ASSIGNMENT_NOT_FOUND" }).code,
    "ROLE_ASSIGNMENT_NOT_FOUND",
  );
  assert.equal(classifyRoleAccessSqlError({ code: "P0002", message: "ROLE_ASSIGNMENT_NOT_FOUND" }).status, 404);
  assert.equal(classifyRoleAccessSqlError({ code: "P0002", message: "ACCOUNT_NOT_FOUND" }).code, "ACCOUNT_NOT_FOUND");
  assert.equal(classifyRoleAccessSqlError({ code: "P0002", message: "ACCOUNT_NOT_FOUND" }).status, 404);
  assert.equal(classifyRoleAccessSqlError({ code: "22023", message: "CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE" }).status, 400);
  assert.equal(classifyRoleAccessSqlError({ code: "22023", message: "CONTEXTUAL_ROLE_NOT_GLOBALLY_ASSIGNABLE" }).code, "AUTHZ_VALIDATION_ERROR");

  for (const token of [
    "AUTHZ_CUTOVER_NOT_READY",
    "AUTHZ_PROTECTED_ASSIGNMENT",
    "IDEMPOTENCY_CONFLICT",
    "ACCOUNT_DISABLED",
    "ROLE_ALREADY_ASSIGNED",
    "ROLE_ASSIGNMENT_ALREADY_ENDED",
    "ACCOUNT_TYPE_ROLE_FORBIDDEN",
  ]) {
    const mapped = classifyRoleAccessSqlError({ code: "PT409", message: token });
    assert.equal(mapped.status, 409, token);
    assert.equal(mapped.code, token);
  }

  const versionConflict = classifyRoleAccessSqlError({
    code: "PT409",
    message: "VERSION_CONFLICT",
    details: JSON.stringify({ current_version: 7 }),
  });
  assert.equal(versionConflict.status, 409);
  assert.equal(versionConflict.code, "VERSION_CONFLICT");
  assert.equal(versionConflict.current_version, 7);

  const uniqueProtected = classifyRoleAccessSqlError({
    code: "23505",
    message: "duplicate key value violates unique constraint authz_account_role_assignments_single_protected_uidx",
  });
  assert.equal(uniqueProtected.status, 409);
  assert.equal(uniqueProtected.code, "AUTHZ_PROTECTED_ASSIGNMENT");

  const unavailable = classifyRoleAccessSqlError({ code: "08006", message: "connection failure" });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, "AUTHZ_UNAVAILABLE");
});

test("createRoleAccessRepository invokes exact WP5B-1 RPC names and parameter bags", async () => {
  const calls = [];
  const repo = createRoleAccessRepository(async (name, args) => {
    calls.push({ name, args });
    if (name === "direct_entry_authz_list_roles_admin") {
      return { data: structuredClone(fixtures.responses.roles_catalog), error: null };
    }
    if (name === "direct_entry_authz_list_accounts_summary_admin") {
      return { data: structuredClone(fixtures.responses.accounts_summary), error: null };
    }
    if (name === "direct_entry_authz_get_account_access_admin") {
      return {
        data: structuredClone(fixtures.responses.account_access_detail.canonical_owner_protected),
        error: null,
      };
    }
    if (name === "direct_entry_authz_assign_global_role_admin") {
      return { data: structuredClone(fixtures.responses.mutations.assign_global_role_created), error: null };
    }
    if (name === "direct_entry_authz_revoke_global_role_admin") {
      return { data: structuredClone(fixtures.responses.mutations.revoke_global_role_ok), error: null };
    }
    return { data: null, error: { code: "08006", message: "unknown" } };
  });

  const actor = { auth_subject: ACTOR_AUTH_SUBJECT, actor_app_user_id: ACTOR_APP_USER_ID };
  assert.equal((await repo.listRoles(actor)).ok, true);
  assert.equal(
    (await repo.listAccountsSummary({ ...actor, search: null, enabled: "all", role_code: null, page: 1, page_size: 25 })).ok,
    true,
  );
  assert.equal((await repo.getAccountAccess({ ...actor, target_app_user_id: TARGET_ACCOUNT_REF })).ok, true);
  assert.equal(
    (
      await repo.assignGlobalRole({
        ...actor,
        target_app_user_id: TARGET_ACCOUNT_REF,
        role_code: "ADMIN",
        expected_account_version: 3,
        reason: "Grant admin",
        idempotency_key: fixtures.requests.assign_global_role.idempotency_key,
        request_hash: "a".repeat(64),
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await repo.revokeGlobalRole({
        ...actor,
        target_app_user_id: TARGET_ACCOUNT_REF,
        assignment_id: ASSIGNMENT_ID,
        expected_account_version: 4,
        reason: "Revoke admin",
        idempotency_key: fixtures.requests.revoke_global_role.idempotency_key,
        request_hash: "b".repeat(64),
      })
    ).ok,
    true,
  );

  assert.deepEqual(
    calls.map((c) => c.name),
    [
      "direct_entry_authz_list_roles_admin",
      "direct_entry_authz_list_accounts_summary_admin",
      "direct_entry_authz_get_account_access_admin",
      "direct_entry_authz_assign_global_role_admin",
      "direct_entry_authz_revoke_global_role_admin",
    ],
  );
  assert.equal(calls[3].args.p_role_code, "ADMIN");
  assert.equal(calls[4].args.p_assignment_id, ASSIGNMENT_ID);
});

test("createRoleAccessApiHandlers enforces mutation env gate before CSRF/session/body, CSRF 403, headers 400, size 413, and paired Full Admin 403", async () => {
  let sessionCalled = 0;
  const repoStub = {
    listRoles: async () => ({ ok: true, data: structuredClone(fixtures.responses.roles_catalog) }),
    listAccountsSummary: async () => ({ ok: true, data: structuredClone(fixtures.responses.accounts_summary) }),
    getAccountAccess: async () => ({
      ok: true,
      data: structuredClone(fixtures.responses.account_access_detail.canonical_owner_protected),
    }),
    assignGlobalRole: async () => ({
      ok: true,
      data: structuredClone(fixtures.responses.mutations.assign_global_role_created),
    }),
    revokeGlobalRole: async () => ({
      ok: true,
      data: structuredClone(fixtures.responses.mutations.revoke_global_role_ok),
    }),
  };

  // 1. AUTHZ_ROLE_MUTATIONS_ENABLED !== "true" fails closed with 404 BEFORE CSRF/session/body
  const disabledMutations = createRoleAccessApiHandlers({
    resolveSession: async () => {
      sessionCalled += 1;
      return { session: null, actor: { ok: false, reason: "UNAUTHENTICATED" } };
    },
    repository: repoStub,
    env: { AUTHZ_ROLE_MUTATIONS_ENABLED: "false" },
  });

  const postGateRes = await disabledMutations.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, "{bad json", {
      origin: "https://evil.example",
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(postGateRes.status, 404);
  assert.equal(postGateRes.headers.get("cache-control"), "private, no-store");
  assert.equal((await postGateRes.json()).error.code, "NOT_FOUND");

  const delGateRes = await disabledMutations.revokeGlobalRole(
    makeJsonDelete(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles/${ASSIGNMENT_ID}`, "{bad"),
    { accountRef: TARGET_ACCOUNT_REF, assignmentId: ASSIGNMENT_ID },
  );
  assert.equal(delGateRes.status, 404);
  assert.equal(sessionCalled, 0, "AUTHZ_ROLE_MUTATIONS_ENABLED gate must short-circuit before session lookup");

  // 2. Active mutation handlers: CSRF 403, authority header 400, >8192B 413
  let currentActor = PAIRED_FULL_ADMIN_ACTOR;
  const handlers = createRoleAccessApiHandlers({
    resolveSession: async () => ({
      session: { auth_subject: currentActor.auth_subject, provider: "supabase", authenticated_at: null },
      actor: { ok: true, actor: currentActor },
    }),
    repository: repoStub,
    env: { AUTHZ_ROLE_MUTATIONS_ENABLED: "true" },
  });

  const csrfRes = await handlers.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, fixtures.requests.assign_global_role, {
      origin: "https://attacker.example",
      "idempotency-key": fixtures.requests.assign_global_role.idempotency_key,
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(csrfRes.status, 403);

  const spoofingGet = await handlers.listRoles(
    makeRequest("/api/admin/access/roles", { headers: { "x-app-user-id": ACTOR_APP_USER_ID } }),
  );
  assert.equal(spoofingGet.status, 400);
  assert.equal((await spoofingGet.json()).error.code, "AUTHORITY_FIELD_FORBIDDEN");

  const spoofingPost = await handlers.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, fixtures.requests.assign_global_role, {
      "x-auth-subject": ACTOR_AUTH_SUBJECT,
      "idempotency-key": fixtures.requests.assign_global_role.idempotency_key,
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(spoofingPost.status, 400);
  assert.equal((await spoofingPost.json()).error.code, "AUTHORITY_FIELD_FORBIDDEN");

  const oversized = "x".repeat(MAX_JSON_BYTES + 10);
  const tooLargeRes = await handlers.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, `{"reason":"${oversized}"}`, {
      "idempotency-key": fixtures.requests.assign_global_role.idempotency_key,
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(tooLargeRes.status, 413);
  assert.equal((await tooLargeRes.json()).error.code, "PAYLOAD_TOO_LARGE");

  // 3. Paired Full Admin check strictly denies missing cap or non-ALL scope despite legacy arrays
  currentActor = {
    ...PAIRED_FULL_ADMIN_ACTOR,
    effective_grants: [
      { capability: "entry_admin", scope_kind: "CONTEXT_TEAM", scope_id: "00000000-0000-4000-8000-000000000701", source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
    ],
  };
  assert.equal((await handlers.listRoles(makeRequest("/api/admin/access/roles"))).status, 403);

  currentActor = {
    ...PAIRED_FULL_ADMIN_ACTOR,
    effective_grants: undefined,
  };
  assert.equal(
    (await handlers.listRoles(makeRequest("/api/admin/access/roles"))).status,
    403,
    "role-access-api must never fall back to legacy arrays when effective_grants is absent",
  );
});

test("createRoleAccessApiHandlers status codes (200/201/200-replay), no-store headers, deterministic hash, and zero @/email leaks", async () => {
  let replayNext = false;
  const recordedHashes = [];
  const handlers = createRoleAccessApiHandlers({
    resolveSession: async () => ({
      session: { auth_subject: ACTOR_AUTH_SUBJECT, provider: "supabase", authenticated_at: null },
      actor: { ok: true, actor: PAIRED_FULL_ADMIN_ACTOR },
    }),
    repository: {
      listRoles: async () => ({ ok: true, data: structuredClone(fixtures.responses.roles_catalog) }),
      listAccountsSummary: async () => ({ ok: true, data: structuredClone(fixtures.responses.accounts_summary) }),
      getAccountAccess: async () => ({
        ok: true,
        data: structuredClone(fixtures.responses.account_access_detail.canonical_owner_protected),
      }),
      assignGlobalRole: async (input) => {
        recordedHashes.push(input.request_hash);
        return {
          ok: true,
          data: replayNext
            ? structuredClone(fixtures.responses.mutations.assign_global_role_replayed)
            : structuredClone(fixtures.responses.mutations.assign_global_role_created),
        };
      },
      revokeGlobalRole: async (input) => {
        recordedHashes.push(input.request_hash);
        return {
          ok: true,
          data: structuredClone(fixtures.responses.mutations.revoke_global_role_ok),
        };
      },
    },
    env: { AUTHZ_ROLE_MUTATIONS_ENABLED: "true" },
  });

  const getRolesRes = await handlers.listRoles(makeRequest("/api/admin/access/roles"));
  assert.equal(getRolesRes.status, 200);
  assert.equal(getRolesRes.headers.get("cache-control"), "private, no-store");
  const rolesBody = await getRolesRes.text();
  assert.equal(rolesBody.includes("@"), false);
  assert.equal(JSON.parse(rolesBody).roles.length, 8);

  const getSummaryRes = await handlers.listAccountsSummary(
    makeRequest("/api/admin/access/accounts-summary?page=1&page_size=20"),
  );
  assert.equal(getSummaryRes.status, 200);
  assert.equal(getSummaryRes.headers.get("cache-control"), "private, no-store");
  assert.equal((await getSummaryRes.json()).list.total, 3);

  const getDetailRes = await handlers.getAccountAccess(
    makeRequest(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/access`),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(getDetailRes.status, 200);
  assert.equal(getDetailRes.headers.get("cache-control"), "private, no-store");
  const detailText = await getDetailRes.text();
  assert.equal(detailText.includes("@"), false);

  const assignCreateRes = await handlers.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, fixtures.requests.assign_global_role, {
      "idempotency-key": fixtures.requests.assign_global_role.idempotency_key,
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(assignCreateRes.status, 201);
  assert.equal(assignCreateRes.headers.get("cache-control"), "private, no-store");
  assert.equal((await assignCreateRes.json()).replayed, false);

  replayNext = true;
  const assignReplayRes = await handlers.assignGlobalRole(
    makeJsonPost(`/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles`, fixtures.requests.assign_global_role, {
      "idempotency-key": fixtures.requests.assign_global_role.idempotency_key,
    }),
    { accountRef: TARGET_ACCOUNT_REF },
  );
  assert.equal(assignReplayRes.status, 200);
  assert.equal((await assignReplayRes.json()).replayed, true);
  assert.equal(recordedHashes[0], recordedHashes[1]);

  const expectedHash = computeRoleMutationRequestHash({
    op: "AUTHZ_GLOBAL_ROLE_ASSIGNED",
    actor_app_user_id: ACTOR_APP_USER_ID.toUpperCase(),
    target_app_user_id: TARGET_ACCOUNT_REF.toUpperCase(),
    role_code: "ADMIN",
    expected_account_version: 3,
    reason: "Grant BoD/Admin workspace governance role",
  });
  assert.equal(recordedHashes[0], expectedHash);

  const revokeRes = await handlers.revokeGlobalRole(
    makeJsonDelete(
      `/api/admin/access/accounts/${TARGET_ACCOUNT_REF}/roles/${ASSIGNMENT_ID}`,
      fixtures.requests.revoke_global_role,
      { "idempotency-key": fixtures.requests.revoke_global_role.idempotency_key },
    ),
    { accountRef: TARGET_ACCOUNT_REF, assignmentId: ASSIGNMENT_ID },
  );
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.headers.get("cache-control"), "private, no-store");
  assert.equal((await revokeRes.text()).includes("@"), false);
  assert.equal(roleAccessNotFoundResponse().status, 404);
});
