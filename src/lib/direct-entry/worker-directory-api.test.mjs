import assert from "node:assert/strict";
import test from "node:test";

import { listWorkers } from "./worker-directory-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "c1000000-0000-4000-8000-000000000001";
const recruiterId = "d1000000-0000-4000-8000-000000000001";
const cursor = "2026-10-08T09:00:00.000000Z|" + entryId;

const row = {
  entry_id: entryId,
  entry_version: 2,
  submission_state: "SUBMITTED",
  employee_code: "hrp-2026-300001",
  display_name: "Worker One",
  project_id: "proj_a",
  project_display: "Project A",
  first_work_date: "2026-10-01",
  labor_type: "TEMPORARY",
  employment_status: "ON",
  recruiter_id: recruiterId,
  recruiter_display: "Recruiter A",
  payment: null,
  pending_request: null,
  last_decision: null,
  is_project_manager: true,
  allowed_actions: {
    view: true, view_pii: true, view_payment: true,
    propose_change: false, propose_change_code: "PROPOSE_PENDING_W04_POLICY",
    direct_edit: false,
  },
};

function request(path, headers = {}) {
  return new Request("https://example.test" + path, { method: "GET", headers });
}

function dependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async listWorkers(input) {
        calls.push({ name: "listWorkers", input });
        return {
          ok: true,
          data: {
            items: [row], scope: input.scope, page_size: input.page_size,
            has_more: false, next_cursor: null, authorization_date: "2026-10-08",
            summary: { total_workers: 1, project_count: 1, recruiter_count: 1 },
          },
        };
      },
      ...overrides,
    },
  };
}

test("gate runs before query, session and repository", async () => {
  const deps = dependencies();
  const response = await listWorkers(request("/api/direct-entry/workers?scope=managed"), undefined, deps);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("query validation fails before session, and never accepts client identity", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/workers",
    "/api/direct-entry/workers?scope=",
    "/api/direct-entry/workers?scope=all&page_size=0",
    "/api/direct-entry/workers?scope=all&page_size=101",
    "/api/direct-entry/workers?scope=all&cursor=nope",
    "/api/direct-entry/workers?scope=all&project_id=bad%20project",
    "/api/direct-entry/workers?scope=all&recruiter_id=nope",
    "/api/direct-entry/workers?scope=all&employment_status=MAYBE",
    "/api/direct-entry/workers?scope=all&search=" + "x".repeat(101),
    "/api/direct-entry/workers?scope=all&search=%0A",
    "/api/direct-entry/workers?scope=all&first_work_date_from=2026-10-10&first_work_date_to=2026-10-01",
    "/api/direct-entry/workers?scope=all&provider_type=other",
    "/api/direct-entry/workers?scope=all&labor_type=bad-key",
    "/api/direct-entry/workers?scope=all&order=first_work_date",
    "/api/direct-entry/workers?scope=all&app_user_id=" + actor.app_user_id,
    "/api/direct-entry/workers?scope=all&auth_subject=" + actor.auth_subject,
    "/api/direct-entry/workers?scope=all&allowed_actions=propose_change",
    "/api/direct-entry/workers?scope=team&scope=recruited",
  ]) {
    const response = await listWorkers(request(path), "true", deps);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).code, "WORKER_QUERY_INVALID", path);
  }
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("session and actor mapping fail closed before the repository", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await listWorkers(
      request("/api/direct-entry/workers?scope=managed"), "true", deps);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("denied, invalid and unavailable outcomes map to stable codes", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "WORKER_DIRECTORY_DENIED"],
    ["not-found", 403, "WORKER_DIRECTORY_DENIED"],
    ["invalid", 400, "WORKER_QUERY_INVALID"],
    ["unavailable", 500, "WORKER_DIRECTORY_UNAVAILABLE"],
  ]) {
    const deps = dependencies({ async listWorkers() { return { ok: false, kind }; } });
    const response = await listWorkers(
      request("/api/direct-entry/workers?scope=managed"), "true", deps);
    assert.equal(response.status, status, kind);
    assert.equal((await response.json()).code, code, kind);
  }
});

test("success returns the exact page projection with no-store", async () => {
  const deps = dependencies();
  const response = await listWorkers(
    request("/api/direct-entry/workers?scope=managed&project_id=proj_a&recruiter_id=" +
      recruiterId + "&employment_status=ON&search=hrp-2026-000021&first_work_date_from=2026-10-01" +
      "&first_work_date_to=2026-10-31&provider_type=hrp&labor_type=TEMPORARY&cursor=" + cursor + "&page_size=50"),
    "true", deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, scope: "managed", items: [row], page_size: 50, has_more: false,
    next_cursor: null, authorization_date: "2026-10-08",
    summary: { total_workers: 1, project_count: 1, recruiter_count: 1 },
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(deps.calls, [{
    name: "listWorkers",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      scope: "managed",
      project_id: "proj_a",
      recruiter_id: recruiterId,
      employment_status: "ON",
      search: "hrp-2026-000021",
      first_work_date_from: "2026-10-01",
      first_work_date_to: "2026-10-31",
      provider_type: "hrp",
      labor_type: "TEMPORARY",
      cursor,
      page_size: 50,
    },
  }]);

  const defaults = dependencies();
  await listWorkers(request("/api/direct-entry/workers?scope=recruited"), "true", defaults);
  assert.deepEqual(defaults.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    scope: "recruited",
    project_id: null,
    recruiter_id: null,
    employment_status: null,
    search: null,
    first_work_date_from: null,
    first_work_date_to: null,
    provider_type: null,
    labor_type: null,
    cursor: null,
    page_size: 25,
  });

  const team = dependencies();
  const teamResponse = await listWorkers(request("/api/direct-entry/workers?scope=team"), "true", team);
  assert.equal(teamResponse.status, 200);
  assert.equal(team.calls[0].input.scope, "team");
});

test("uses allowed worker tabs for early denial while keeping the directory scope check", async () => {
  const deps = dependencies();
  deps.resolveSession = async () => ({
    actor: { ok: true, actor: { ...actor, allowed_worker_tabs: ["recruited"] } },
    response_headers: {},
  });
  for (const scope of ["all", "team", "managed"]) {
    const res = await listWorkers(request("/api/direct-entry/workers?scope=" + scope), "true", deps);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "WORKER_DIRECTORY_DENIED");
  }
  assert.equal(deps.calls.length, 0);
  const res = await listWorkers(request("/api/direct-entry/workers?scope=recruited"), "true", deps);
  assert.equal(res.status, 200);
  assert.equal(deps.calls[0]?.input.scope, "recruited");
});
