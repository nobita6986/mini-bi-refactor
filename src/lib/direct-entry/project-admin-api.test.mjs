import assert from "node:assert/strict";
import test from "node:test";

import {
  assignProjectManagerAdmin,
  createProjectAdmin,
  projectAdminAssignRequest,
  projectAdminCreateRequest,
  projectAdminSetActiveRequest,
  projectAdminUnassignRequest,
  projectAdminUpdateRequest,
  getProjectAdmin,
  listManagerCandidatesAdmin,
  listProjectsAdmin,
  setProjectActiveAdmin,
  unassignProjectManagerAdmin,
  updateProjectAdmin,
} from "./project-admin-api.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const RECRUITER = "66666666-6666-4666-8666-666666666666";
const ASSIGNMENT = "77777777-7777-4777-8777-777777777777";
const REV = "99999999-9999-4999-8999-999999999999";
const TS = "2026-10-01T00:00:00+00:00";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const PROJECT = { project_id: "p1", display_name: "Công ty ABC", active: true, version: 3,
  created_at: TS, updated_at: TS, revision_count: 2, active_assignment_count: 1,
  can_manage_project_master: true, can_assign_managers: true };
const CREATE = { project_id: "p1", display_name: "Công ty ABC", active: true, version: 1,
  revision_id: REV, created: true };
const MUTATION = { project_id: "p1", display_name: "Công ty ABC", active: true, version: 4,
  revision_id: REV };

function deps(result, session = { actor: { ok: true, actor: ACTOR }, response_headers: {} }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listProjects: async (i) => { calls.rpc.push(["list", i]); return result; },
        getProject: async (i) => { calls.rpc.push(["get", i]); return result; },
        listAssignments: async (i) => { calls.rpc.push(["listAssignments", i]); return result; },
        getProjectDetail: async (i) => { calls.rpc.push(["getDetail", i]); return result; },
        listManagerCandidates: async (i) => { calls.rpc.push(["candidates", i]); return result; },
        createProject: async (i) => { calls.rpc.push(["create", i]); return result; },
        updateProject: async (i) => { calls.rpc.push(["update", i]); return result; },
        setProjectActive: async (i) => { calls.rpc.push(["active", i]); return result; },
        assignManager: async (i) => { calls.rpc.push(["assign", i]); return result; },
        unassignManager: async (i) => { calls.rpc.push(["unassign", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, headers = {}) {
  return new Request("https://app.test/api/direct-entry/projects", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const LIST_OK = { ok: true, data: { authorization_date: "2026-10-07", include_inactive: true,
  projects: [PROJECT] } };

test("GATE chay TRUOC body va repository", async () => {
  const d = deps(LIST_OK);
  const res = await listProjectsAdmin(new Request("https://app.test/x"), "false", d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("CSRF chay TRUOC session va repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createProjectAdmin(
    jsonRequest({ project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY },
      { origin: "https://evil.test" }),
    "true", d.dependencies);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("content-type va body bounded chan truoc session", async () => {
  const d = deps({ ok: true, data: CREATE });
  const wrongType = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test" }, body: "{}" });
  const res = await createProjectAdmin(wrongType, "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "CONTENT_TYPE_INVALID");
  assert.equal(d.calls.session, 0);
});

test("client khong duoc gui actor/capability/scope/role", async () => {
  for (const forbidden of [{ actor: "x" }, { auth_subject: "x" }, { capabilities: [] },
    { scope: "all" }, { role: "admin" }, { app_user_id: "x" }]) {
    const d = deps({ ok: true, data: CREATE });
    const res = await createProjectAdmin(jsonRequest({
      project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY, ...forbidden,
    }), "true", d.dependencies);
    assert.equal(res.status, 400, JSON.stringify(forbidden));
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
    assert.equal(d.calls.session, 0);
  }
});

test("action reason is optional while OCC and strict request shape stay required", async () => {
  for (const reason of [undefined, null, "", "   "]) {
    const d = deps({ ok: true, data: CREATE });
    const body = { project_id: "p1", display_name: "X", idempotency_key: KEY };
    if (reason !== undefined) body.reason = reason;
    const response = await createProjectAdmin(jsonRequest(body), "true", d.dependencies);
    assert.equal(response.status, 200);
    assert.equal(d.calls.rpc[0][1].reason, null);
  }
  for (const reason of [123, "x".repeat(4001)]) {
    const d = deps({ ok: true, data: CREATE });
    const response = await createProjectAdmin(jsonRequest({
      project_id: "p1", display_name: "X", reason, idempotency_key: KEY,
    }), "true", d.dependencies);
    assert.equal(response.status, 400);
    assert.equal(d.calls.rpc.length, 0);
  }

  const d = deps({ ok: true, data: MUTATION });
  const noOcc = await updateProjectAdmin(
    jsonRequest({ display_name: "X", reason: "r", idempotency_key: KEY }), "p1", "true", d.dependencies);
  assert.equal(noOcc.status, 400);

  const extra = await createProjectAdmin(
    jsonRequest({ project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY, extra: 1 }),
    "true", d.dependencies);
  assert.equal(extra.status, 400);
});

test("all project mutation contracts normalize optional reasons and reject malformed values", () => {
  const cases = [
    [projectAdminCreateRequest, { project_id: "p1", display_name: "X", idempotency_key: KEY }],
    [projectAdminUpdateRequest, { expected_version: 1, display_name: "X", idempotency_key: KEY }],
    [projectAdminSetActiveRequest, { active: true, expected_version: 1, idempotency_key: KEY }],
    [projectAdminAssignRequest, { manager_recruiter_id: RECRUITER, valid_from: TODAY_VN,
      expected_project_version: 1, idempotency_key: KEY }],
    [projectAdminUnassignRequest, { expected_version: 1, expected_project_version: 1,
      idempotency_key: KEY }],
  ];
  for (const [parse, required] of cases) {
    for (const reason of [undefined, null, "", "  "]) {
      const body = { ...required };
      if (reason !== undefined) body.reason = reason;
      const parsed = parse(body);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.value.reason, null);
    }
    assert.equal(parse({ ...required, reason: 123 }).ok, false);
    assert.equal(parse({ ...required, reason: "x".repeat(4001) }).ok, false);
  }
});

test("actor CHI den tu session, khong tu body/header", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createProjectAdmin(jsonRequest({
    project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY,
  }, { "x-app-user-id": "99999999-9999-4999-8999-999999999999" }), "true", d.dependencies);
  assert.equal(res.status, 200);
  const [, input] = d.calls.rpc[0];
  assert.equal(input.auth_subject, ACTOR.auth_subject);
  assert.equal(input.app_user_id, ACTOR.app_user_id);
  assert.equal(JSON.stringify(input).includes("99999999"), false);
});

test("unauthenticated/mapped-disabled duoc map sanitized", async () => {
  const anon = deps({ ok: true, data: CREATE }, { actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} });
  const r1 = await createProjectAdmin(jsonRequest({
    project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY }), "true", anon.dependencies);
  assert.equal(r1.status, 401);
  assert.equal((await r1.json()).code, "UNAUTHENTICATED");

  const disabled = deps({ ok: true, data: CREATE }, { actor: { ok: false, reason: "ACTOR_DISABLED" }, response_headers: {} });
  const r2 = await createProjectAdmin(jsonRequest({
    project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY }), "true", disabled.dependencies);
  assert.equal(r2.status, 403);
  assert.equal((await r2.json()).code, "ACTOR_NOT_AVAILABLE");
});

test("taxonomy loi sanitized: denied/conflict/not-found/unavailable", async () => {
  const cases = [[{ ok: false, kind: "denied" }, 403, "PROJECT_DENIED"],
    [{ ok: false, kind: "conflict" }, 409, "PROJECT_CONFLICT"],
    [{ ok: false, kind: "not-found" }, 404, "PROJECT_NOT_FOUND"],
    [{ ok: false, kind: "invalid" }, 400, "PROJECT_INVALID"],
    [{ ok: false, kind: "unavailable" }, 500, "PROJECT_UNAVAILABLE"]];
  for (const [result, status, code] of cases) {
    const d = deps(result);
    const res = await createProjectAdmin(jsonRequest({
      project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY }), "true", d.dependencies);
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).code, code);
  }
});

test("repository throw => 500 sanitized, khong lo chi tiet", async () => {
  const d = deps({ ok: true, data: CREATE });
  d.dependencies.repository.createProject = async () => { throw new Error("raw db secret detail"); };
  const res = await createProjectAdmin(jsonRequest({
    project_id: "p1", display_name: "X", reason: "r", idempotency_key: KEY }), "true", d.dependencies);
  assert.equal(res.status, 500);
  assert.equal((await res.text()).includes("raw db secret detail"), false);
});

test("DEACTIVATE dung set-active(false)", async () => {
  const d = deps({ ok: true, data: { ...MUTATION, active: false } });
  const res = await setProjectActiveAdmin(jsonRequest({
    active: false, expected_version: 3, reason: "ngung su dung", idempotency_key: KEY }),
    "p1", "true", d.dependencies);
  assert.equal(res.status, 200);
  const [kind, input] = d.calls.rpc[0];
  assert.equal(kind, "active");
  assert.equal(input.active, false);
});

test("assign/unassign dung du hai version OCC va reason; assign tra project_version", async () => {
  const assignResult = { ok: true, data: { assignment_id: ASSIGNMENT, project_id: "p1",
    manager_recruiter_id: RECRUITER, valid_from: TODAY_VN, valid_to: null,
    version: 1, project_version: 4, already_assigned: false } };
  const d1 = deps(assignResult);
  await assignProjectManagerAdmin(jsonRequest({ manager_recruiter_id: RECRUITER,
    valid_from: TODAY_VN, expected_project_version: 3, reason: "them ql", idempotency_key: KEY }),
    "p1", "true", d1.dependencies);
  const [, assignInput] = d1.calls.rpc[0];
  assert.equal(assignInput.expected_project_version, 3);
  assert.equal(assignInput.reason, "them ql");

  const unassignResult = { ok: true, data: { assignment_id: ASSIGNMENT, project_id: "p1",
    valid_to: "2026-10-05", version: 2, project_version: 5, already_unassigned: false } };
  const d2 = deps(unassignResult);
  await unassignProjectManagerAdmin(jsonRequest({ expected_version: 1, expected_project_version: 4,
    reason: "thu hoi", idempotency_key: KEY }), "p1", ASSIGNMENT, "true", d2.dependencies);
  const [, unassignInput] = d2.calls.rpc[0];
  assert.equal(unassignInput.assignment_id, ASSIGNMENT);
  assert.equal(unassignInput.expected_version, 1);
  assert.equal(unassignInput.expected_project_version, 4);
});

test("read routes: GET khong can Origin; list/get van resolve session va repository", async () => {
  const d = deps(LIST_OK);
  const listed = await listProjectsAdmin(
    new Request("https://app.test/x?include_inactive=false"), "true", d.dependencies);
  assert.equal(listed.status, 200, "browser GET khong gui Origin van phai doc duoc");
  assert.equal(d.calls.rpc[0][1].include_inactive, false);

  const d2 = deps({ ok: true, data: { master: PROJECT, assignments: { authorization_date: "2026-10-07",
    project_id: "p1", project_version: 3, project_active: true, include_history: true,
    active_assignment_count: 0, assignments: [] } } });
  const detailed = await getProjectAdmin(
    new Request("https://app.test/x"), "p1", "true", d2.dependencies);
  assert.equal(detailed.status, 200);
  assert.equal(d2.calls.rpc[0][0], "getDetail", "detail dung getProjectDetail (get + list assignments)");
  assert.equal(d2.calls.rpc[0][1].project_id, "p1");

  const d3 = deps({ ok: true, data: {} });
  const bad = await getProjectAdmin(new Request("https://app.test/x"), "   ", "true",
    d3.dependencies);
  assert.equal(bad.status, 400);
  assert.equal(d3.calls.rpc.length, 0);
});

test("candidate list: gate truoc, actor tu session, search parsed", async () => {
  const candidates = { ok: true, data: { candidates: [
    { recruiter_id: RECRUITER, display_name: "Nguyen Van A", personnel_code: "vinh.ta", personnel_position: "STAFF" },
  ] } };
  const d = deps(candidates);
  const res = await listManagerCandidatesAdmin(
    new Request("https://app.test/x?search=vinh"), "true", d.dependencies);
  assert.equal(res.status, 200);
  const [kind, input] = d.calls.rpc[0];
  assert.equal(kind, "candidates");
  assert.equal(input.auth_subject, ACTOR.auth_subject);
  assert.equal(input.search, "vinh");
  const body = await res.json();
  assert.equal(body.candidates[0].display_name, "Nguyen Van A");
  assert.equal("auth_subject" in body.candidates[0], false);
  const g = deps(candidates);
  const off = await listManagerCandidatesAdmin(new Request("https://app.test/x"), "false", g.dependencies);
  assert.equal(off.status, 404);
  assert.equal(g.calls.rpc.length, 0);
});
test("candidate list: search vuot gioi han bi tu choi sanitized", async () => {
  const d = deps({ ok: true, data: { candidates: [] } });
  const long = "x".repeat(257);
  const res = await listManagerCandidatesAdmin(
    new Request("https://app.test/x?search=" + encodeURIComponent(long)), "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "PROJECT_INVALID");
  assert.equal(d.calls.rpc.length, 0, "khong goi repository khi search qua dai");
});
