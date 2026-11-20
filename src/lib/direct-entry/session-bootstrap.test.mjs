import assert from "node:assert/strict";
import test from "node:test";

import { createDirectEntrySessionResponse } from "./session-bootstrap.ts";

const safeActor = {
  auth_subject: "auth-subject-secret",
  app_user_id: "app-user-stable-id",
  enabled: true,
  capabilities: ["entry_create"],
  scopes: [{ kind: "own", reference: "app-user-stable-id", valid_from: "0001-01-01", valid_to: null }],
  self_recruiter_suggestion: "recruiter-stable-id",
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};

function sessionResult(actor) {
  return {
    actor,
    response_headers: { "cache-control": "private", pragma: "no-cache" },
  };
}

test("disabled API gate returns before creating a session or calling the RPC", async () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    let calls = 0;
    const response = await createDirectEntrySessionResponse(flag, async () => {
      calls += 1;
      throw new Error("should not be reached");
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("unauthenticated and all unavailable actor mappings have bounded public errors", async () => {
  const unauthenticated = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({ ok: false, reason: "UNAUTHENTICATED" }));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { ok: false, code: "UNAUTHENTICATED" });

  for (const reason of [
    "ACTOR_MAPPING_MISSING",
    "ACTOR_DISABLED",
    "ACTOR_REPOSITORY_INVALID",
    "AMBIGUOUS_TEAM_MEMBERSHIP",
  ]) {
    const denied = await createDirectEntrySessionResponse("true", async () =>
      sessionResult({ ok: false, reason }));
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });
  }
});

test("success returns only UI projection fields and disables caching", async () => {
  const response = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({ ok: true, actor: safeActor }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  const body = await response.json();
  assert.deepEqual(Object.keys(body.actor).sort(), [
    "app_user_id", "capabilities", "scopes", "self_recruiter_suggestion",
  ]);
  assert.equal(JSON.stringify(body).includes("auth_subject"), false);
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("email"), false);
});

test("session and RPC failures return sanitized errors", async () => {
  const response = await createDirectEntrySessionResponse("true", async () => {
    throw new Error("database_url token=secret");
  });
  assert.equal(response.status, 503);
  const body = JSON.stringify(await response.json());
  assert.equal(body.includes("database_url"), false);
  assert.equal(body.includes("secret"), false);
});

test("WP8C-2: session bootstrap projects paired effective_grants without leaking grant metadata and drops stale legacy mirrors or invalid scope pairings", async () => {
  const teamId = "33333333-3333-4333-8333-333333333333";
  const sourceIdA = "44444444-4444-4444-8444-444444444444";
  const sourceIdB = "55555555-5555-4555-8555-555555555555";
  const sourceIdC = "66666666-6666-4666-8666-666666666666";

  // 1. Mirror-cleared canonical managed actor gets paired capabilities & derived own/team/all scopes,
  // and never exposes effective_grants, source_type, or source_id
  const canonicalRes = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({
      ok: true,
      actor: {
        ...safeActor,
        capabilities: [],
        scopes: [{ kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null }],
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
      },
    }));
  assert.equal(canonicalRes.status, 200);
  const canonicalBody = await canonicalRes.json();
  assert.deepEqual(Object.keys(canonicalBody.actor).sort(), [
    "app_user_id", "capabilities", "scopes", "self_recruiter_suggestion",
  ]);
  assert.deepEqual(canonicalBody.actor.capabilities, [
    "entry_admin",
    "document_upload",
    "team_manager_assign",
  ]);
  assert.deepEqual(canonicalBody.actor.scopes, [
    { kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null },
    { kind: "team", reference: teamId, valid_from: "0001-01-01", valid_to: null },
    { kind: "all", reference: "all", valid_from: "0001-01-01", valid_to: null },
  ]);
  const canonicalText = JSON.stringify(canonicalBody);
  assert.equal(canonicalText.includes("effective_grants"), false);
  assert.equal(canonicalText.includes("source_type"), false);
  assert.equal(canonicalText.includes("source_id"), false);
  assert.equal(canonicalText.includes("ROLE_BUNDLE"), false);
  assert.equal(canonicalText.includes(sourceIdA), false);

  // 2. Stale legacy mirror on managed EMPLOYEE_BASE (effective_grants: []) projects empty capabilities and own-only scope
  const staleRes = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({
      ok: true,
      actor: {
        ...safeActor,
        capabilities: ["entry_admin"],
        scopes: [
          { kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null },
          { kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null },
        ],
        effective_grants: [],
      },
    }));
  assert.equal(staleRes.status, 200);
  const staleBody = await staleRes.json();
  assert.deepEqual(staleBody.actor.capabilities, []);
  assert.deepEqual(staleBody.actor.scopes, [
    { kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null },
  ]);

  // 3. Invalid scope pairings in effective_grants are dropped from both capabilities and scopes
  const invalidPairRes = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({
      ok: true,
      actor: {
        ...safeActor,
        capabilities: ["entry_admin", "team_manager_assign"],
        scopes: [
          { kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null },
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
      },
    }));
  assert.equal(invalidPairRes.status, 200);
  const invalidPairBody = await invalidPairRes.json();
  assert.deepEqual(invalidPairBody.actor.capabilities, []);
  assert.deepEqual(invalidPairBody.actor.scopes, [
    { kind: "own", reference: safeActor.app_user_id, valid_from: "0001-01-01", valid_to: null },
  ]);
});
