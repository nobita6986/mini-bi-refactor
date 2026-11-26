import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWorkReportAssignment, createWorkReportGroup, getWorkReportAssignmentDetail, listWorkReportAssignmentOptions, listWorkReportAssignments,
  listWorkReportGroups, patchWorkReportGroup, setWorkReportAssignmentState, changeWorkReportObligation } from "./assignment-api.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const template = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const user = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function request(path, body) {
  return new Request(`https://bi.test${path}`, { method: "POST", headers: { host: "bi.test", origin: "https://bi.test",
    "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) });
}
function getRequest(path) { return new Request(`https://bi.test${path}`); }
function deps(repository = {}) { return { resolveSession: async () => ({ actor: { ok: true, actor } }), repository }; }
function assignment() { return { template_id: template, target_kind: "USER", target_user_id: user, target_team_id: null,
  target_user_ids: [], frequency: "DAILY", is_mandatory: true, due_day_offset: 0, due_time_local: "23:59:59",
  exclude_sundays: false, effective_from: "2026-10-21", effective_to: null, idempotency_key: "request-1" }; }

test("assignment options use the session actor and accept only an optional team filter", async () => {
  let input;
  const data = { templates: [], teams: [], users: [] };
  const response = await listWorkReportAssignmentOptions(
    getRequest(`/api/work-reports/assignments?team_id=${user}`), "true", deps({
      listOptions: async (value) => { input = value; return { ok: true, data }; },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(input, { ...actor, team_id: user });
  assert.deepEqual(await response.json(), { ok: true, ...data });
  assert.equal((await listWorkReportAssignmentOptions(
    getRequest(`/api/work-reports/assignments?app_user_id=${user}`), "true", deps(),
  )).status, 400);
});

test("assignment tracking uses the session actor and accepts only the optional team filter", async () => {
  let input;
  const response = await listWorkReportAssignments(
    getRequest(`/api/work-reports/assignments/tracking?team_id=${user}`), "true", deps({
      listAssignments: async (value) => { input = value; return { ok: true, data: [] }; },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(input, { ...actor, team_id: user });
  assert.deepEqual(await response.json(), { ok: true, items: [] });
  assert.equal((await listWorkReportAssignments(
    getRequest(`/api/work-reports/assignments/tracking?app_user_id=${user}`), "true", deps(),
  )).status, 400);
});

test("assignment detail lazy-loads bounded assignee progress and audit history for the session actor", async () => {
  const assignmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  let detailInput;
  const detailPayload = {
    assignment_id: assignmentId,
    assignee_progress: [],
    audit_history: [],
  };
  const response = await getWorkReportAssignmentDetail(
    getRequest(`/api/work-reports/assignments/${assignmentId}`),
    assignmentId,
    "true",
    deps({
      getAssignmentDetail: async (value) => {
        detailInput = value;
        return { ok: true, data: detailPayload };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(detailInput, { ...actor, assignment_id: assignmentId });
  assert.deepEqual(await response.json(), { ok: true, ...detailPayload });
  assert.equal(
    (await getWorkReportAssignmentDetail(getRequest(`/api/work-reports/assignments/${assignmentId}`), "not-a-uuid", "true", deps())).status,
    400,
  );
  assert.equal(
    (await getWorkReportAssignmentDetail(getRequest(`/api/work-reports/assignments/${assignmentId}?app_user_id=${user}`), assignmentId, "true", deps())).status,
    400,
  );
  assert.equal(
    (await getWorkReportAssignmentDetail(getRequest(`/api/work-reports/assignments/${assignmentId}`), assignmentId, "false", deps())).status,
    404,
  );
});

test("assignment creation resolves actor from session and validates scope through repository result", async () => {
  let input;
  const response = await createWorkReportAssignment(request("/api/work-reports/assignments", assignment()), "true", deps({
    create: async (value) => { input = value; return { ok: true, data: { assignment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1 } }; },
  }));
  assert.equal(response.status, 200);
  assert.equal(input.app_user_id, actor.app_user_id);
  assert.equal(input.target_user_id, user);
});

test("assignment rejects client authority and mismatched target shape", async () => {
  const forged = { ...assignment(), app_user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  assert.equal((await createWorkReportAssignment(request("/api/work-reports/assignments", forged), "true", deps())).status, 400);
  const mismatch = { ...assignment(), target_team_id: user };
  assert.equal((await createWorkReportAssignment(request("/api/work-reports/assignments", mismatch), "true", deps())).status, 400);
});

test("database denies an out-of-scope assignment without returning success", async () => {
  const response = await createWorkReportAssignment(request("/api/work-reports/assignments", assignment()), "true", deps({
    create: async () => ({ ok: false, kind: "denied" }),
  }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "WORK_REPORT_ACCESS_DENIED");
});

test("pause/revoke and exempt/reopen routes pass only the server session actor", async () => {
  let stateInput;
  const patch = request("/api/work-reports/assignments/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
    expected_version: 1, state: "REVOKED", idempotency_key: "state-1",
  });
  const patched = await setWorkReportAssignmentState(patch, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "true", deps({
    setState: async (input) => { stateInput = input; return { ok: true, data: { version: 2 } }; },
  }));
  assert.equal(patched.status, 200);
  assert.equal(stateInput.app_user_id, actor.app_user_id);
  let actionInput;
  const changed = await changeWorkReportObligation(request("/api/work-reports/obligations/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/status", {
    expected_version: 1, action: "EXEMPT", reason: "Đã miễn", reopened_until: null, idempotency_key: "status-1",
  }), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "true", deps({
    changeObligation: async (input) => { actionInput = input; return { ok: true, data: { version: 2 } }; },
  }));
  assert.equal(changed.status, 200);
  assert.equal(actionInput.reason, "Đã miễn");
});

test("custom report group APIs enforce feature gate, CSRF, client-authority bans, idempotency, and GROUP target shape", async () => {
  const groupId = "12121212-1212-4212-8212-121212121212";
  const user2 = "34343434-3434-4434-8434-343434343434";

  // Feature gate disabled -> 404
  assert.equal((await listWorkReportGroups(getRequest("/api/work-reports/groups"), "false", deps())).status, 404);
  assert.equal(
    (await createWorkReportGroup(
      request("/api/work-reports/groups", {
        display_name: "Nhóm QLDA",
        description: null,
        member_user_ids: [user],
        idempotency_key: "g1",
      }),
      "false",
      deps(),
    )).status,
    404,
  );
  assert.equal(
    (await patchWorkReportGroup(
      request(`/api/work-reports/groups/${groupId}`, { expected_version: 1, active: false, idempotency_key: "g2" }),
      groupId,
      "false",
      deps(),
    )).status,
    404,
  );

  // Unexpected query params on GET /api/work-reports/groups -> 400
  assert.equal((await listWorkReportGroups(getRequest(`/api/work-reports/groups?team_id=${user}`), "true", deps())).status, 400);

  // Forged client authority field -> 400
  assert.equal(
    (await createWorkReportGroup(
      request("/api/work-reports/groups", {
        display_name: "Nhóm QLDA",
        description: null,
        member_user_ids: [user],
        app_user_id: user2,
        idempotency_key: "g-forged",
      }),
      "true",
      deps(),
    )).status,
    400,
  );

  // Duplicate or empty member_user_ids -> 400
  assert.equal(
    (await createWorkReportGroup(
      request("/api/work-reports/groups", {
        display_name: "Nhóm QLDA",
        description: null,
        member_user_ids: [user, user],
        idempotency_key: "g-dup",
      }),
      "true",
      deps(),
    )).status,
    400,
  );
  assert.equal(
    (await createWorkReportGroup(
      request("/api/work-reports/groups", {
        display_name: "Nhóm QLDA",
        description: null,
        member_user_ids: [],
        idempotency_key: "g-empty",
      }),
      "true",
      deps(),
    )).status,
    400,
  );

  // Valid create, update, deactivate, and scope denial mapping
  let createdInput;
  const createRes = await createWorkReportGroup(
    request("/api/work-reports/groups", {
      display_name: "  Nhóm Tuyển dụng Liên Team  ",
      description: "  Phối hợp 2 Team  ",
      member_user_ids: [user, user2],
      idempotency_key: "grp-1",
    }),
    "true",
    deps({
      createGroup: async (val) => {
        createdInput = val;
        return { ok: true, data: { group_id: groupId, version: 1 } };
      },
    }),
  );
  assert.equal(createRes.status, 200);
  assert.equal(createdInput.app_user_id, actor.app_user_id);
  assert.equal(createdInput.display_name, "Nhóm Tuyển dụng Liên Team");
  assert.equal(createdInput.description, "Phối hợp 2 Team");
  assert.deepEqual(createdInput.member_user_ids, [user, user2]);

  const scopeDeniedUpdate = await patchWorkReportGroup(
    request(`/api/work-reports/groups/${groupId}`, {
      expected_version: 1,
      display_name: "Nhóm Tuyển dụng",
      description: null,
      member_user_ids: [user, user2],
      idempotency_key: "grp-upd-denied",
    }),
    groupId,
    "true",
    deps({ updateGroup: async () => ({ ok: false, kind: "denied" }) }),
  );
  assert.equal(scopeDeniedUpdate.status, 403);
  assert.equal((await scopeDeniedUpdate.json()).code, "WORK_REPORT_ACCESS_DENIED");

  let activeInput;
  const deactRes = await patchWorkReportGroup(
    request(`/api/work-reports/groups/${groupId}`, {
      expected_version: 2,
      active: false,
      idempotency_key: "grp-deact",
    }),
    groupId,
    "true",
    deps({
      setGroupActive: async (val) => {
        activeInput = val;
        return { ok: true, data: { group_id: groupId, active: false, version: 3 } };
      },
    }),
  );
  assert.equal(deactRes.status, 200);
  assert.equal(activeInput.active, false);
  assert.equal(activeInput.expected_version, 2);

  // GROUP assignment target shape validation
  const invalidGroupAssign = {
    ...assignment(),
    target_kind: "GROUP",
    target_user_id: user,
    target_group_id: groupId,
  };
  assert.equal(
    (await createWorkReportAssignment(request("/api/work-reports/assignments", invalidGroupAssign), "true", deps())).status,
    400,
  );

  let groupAssignInput;
  const validGroupAssign = {
    ...assignment(),
    target_kind: "GROUP",
    target_user_id: null,
    target_team_id: null,
    target_group_id: "851177f1-b9d6-46b2-9802-b45045390dad",
    target_user_ids: [],
    frequency: "DAILY",
    is_mandatory: true,
    due_day_offset: 0,
    due_time_local: "23:59:59",
    exclude_sundays: false,
    effective_from: "2026-11-04",
    effective_to: null,
  };
  const groupAssignRes = await createWorkReportAssignment(
    request("/api/work-reports/assignments", validGroupAssign),
    "true",
    deps({
      create: async (val) => {
        groupAssignInput = val;
        return { ok: true, data: { assignment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", version: 1 } };
      },
    }),
  );
  assert.equal(groupAssignRes.status, 200);
  assert.equal(groupAssignInput.target_kind, "GROUP");
  assert.equal(groupAssignInput.target_group_id, "851177f1-b9d6-46b2-9802-b45045390dad");
  assert.equal(groupAssignInput.effective_from, "2026-11-04");
  assert.equal(groupAssignInput.due_day_offset, 0);

  // Specific 22023 domain codes propagate instead of being swallowed into WORK_REPORT_REQUEST_INVALID
  const ineligibleRes = await createWorkReportAssignment(
    request("/api/work-reports/assignments", validGroupAssign),
    "true",
    deps({
      create: async () => ({
        ok: false,
        kind: "invalid",
        code: "WORK_REPORT_GROUP_MEMBER_INELIGIBLE",
      }),
    }),
  );
  assert.equal(ineligibleRes.status, 400);
  assert.deepEqual(await ineligibleRes.json(), {
    ok: false,
    code: "WORK_REPORT_GROUP_MEMBER_INELIGIBLE",
  });

  const inactiveGroupRes = await createWorkReportAssignment(
    request("/api/work-reports/assignments", validGroupAssign),
    "true",
    deps({
      create: async () => ({
        ok: false,
        kind: "invalid",
        code: "WORK_REPORT_GROUP_INACTIVE",
      }),
    }),
  );
  assert.equal(inactiveGroupRes.status, 400);
  assert.deepEqual(await inactiveGroupRes.json(), {
    ok: false,
    code: "WORK_REPORT_GROUP_INACTIVE",
  });

  const groupsRoute = await readFile(path.resolve("src/app/api/work-reports/groups/route.ts"), "utf8");
  const groupDetailRoute = await readFile(path.resolve("src/app/api/work-reports/groups/[groupId]/route.ts"), "utf8");
  for (const src of [groupsRoute, groupDetailRoute]) {
    assert.match(src, /import "server-only";/);
    assert.match(src, /process\.env\.WORK_REPORTS_API_ENABLED !== "true"/);
  }
});

test("assignment creation allows omitted or null dates, validates legacy date shapes, and propagates WORK_REPORT_ASSIGNMENT_INVALID", async () => {
  const datelessBody = assignment();
  delete datelessBody.effective_from;
  delete datelessBody.effective_to;

  let forwardedDateless;
  const datelessRes = await createWorkReportAssignment(
    request("/api/work-reports/assignments", datelessBody),
    "true",
    deps({
      create: async (val) => {
        forwardedDateless = val;
        return { ok: true, data: { assignment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1 } };
      },
    }),
  );
  assert.equal(datelessRes.status, 200);
  assert.equal(forwardedDateless.effective_from, null);
  assert.equal(forwardedDateless.effective_to, null);

  let forwardedLegacy;
  const legacyWithEndDate = {
    ...assignment(),
    effective_from: "2026-10-20",
    effective_to: "2026-10-31",
  };
  const legacyForwardRes = await createWorkReportAssignment(
    request("/api/work-reports/assignments", legacyWithEndDate),
    "true",
    deps({
      create: async (val) => {
        forwardedLegacy = val;
        return { ok: false, kind: "invalid", code: "WORK_REPORT_ASSIGNMENT_INVALID" };
      },
    }),
  );
  assert.equal(forwardedLegacy.effective_from, "2026-10-20");
  assert.equal(forwardedLegacy.effective_to, "2026-10-31");
  assert.equal(legacyForwardRes.status, 400);
  assert.deepEqual(await legacyForwardRes.json(), {
    ok: false,
    code: "WORK_REPORT_ASSIGNMENT_INVALID",
  });

  // Invalid date combinations fail closed at HTTP validation before hitting repository
  let repoCalled = false;
  const failRepo = deps({
    create: async () => {
      repoCalled = true;
      return { ok: true, data: { assignment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 1 } };
    },
  });
  for (const invalidBody of [
    { ...datelessBody, effective_to: "2026-10-31" },
    { ...datelessBody, effective_from: null, effective_to: "2026-10-31" },
    { ...assignment(), effective_from: "2026-10-21", effective_to: "2026-10-20" },
    { ...assignment(), effective_from: "2026-02-30", effective_to: null },
    { ...assignment(), effective_from: "2026-10-21", effective_to: "2026-02-30" },
  ]) {
    const res = await createWorkReportAssignment(
      request("/api/work-reports/assignments", invalidBody),
      "true",
      failRepo,
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      ok: false,
      code: "WORK_REPORT_ASSIGNMENT_INVALID",
    });
  }
  assert.equal(repoCalled, false);
});
