import assert from "node:assert/strict";
import test from "node:test";

import {
  assignTeamMembership,
  listTeamMembership,
  moveTeamMembership,
  teamMembershipAssignRequest,
  teamMembershipListQuery,
  teamMembershipUnassignRequest,
  teamMembershipErrorResponse,
  unassignTeamMembership,
} from "./team-membership-api.ts";
import {
  teamMembershipItem,
  teamMembershipList,
  teamMembershipMutation,
} from "./team-membership-contract.ts";
import {
  classifyTeamMembershipError,
  createTeamMembershipRepository,
} from "./team-membership-repository.ts";
import { classifyMembershipMutation } from "../admin/team-membership-model.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const RECRUITER = "66666666-6666-4666-8666-666666666666";
const TEAM = "77777777-7777-4777-8777-777777777777";
const TEAM2 = "88888888-8888-4888-8888-888888888888";
const REV = "99999999-9999-4999-8999-999999999999";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBERSHIP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

test("membership failures retain safe, distinct reasons from database through UI", async () => {
  const cases = [
    ["40001", "recruiter version conflict", 409, "MEMBERSHIP_CONFLICT", "Hồ sơ đã thay đổi"],
    ["PT409", "recruiter version conflict", 409, "MEMBERSHIP_CONFLICT", "Hồ sơ đã thay đổi"],
    ["23P01", "effective interval overlaps", 409, "MEMBERSHIP_OVERLAP", "Lịch phân công bị trùng"],
    ["22023", "membership already targets this team", 400, "MEMBERSHIP_SAME_TEAM", "đã được phân công vào nhóm này"],
    ["22023", "no open membership to move", 409, "MEMBERSHIP_NOT_MOVABLE", "Không có phân công"],
    ["22023", "move date precedes the open membership", 400, "MEMBERSHIP_DATE_BEFORE_START", "không được trước ngày bắt đầu"],
    ["23514", "membership change would rewrite worker attribution", 400, "MEMBERSHIP_ATTRIBUTION_CONFLICT", "lịch sử tuyển dụng"],
  ];
  for (const [code, message, status, safeCode, copy] of cases) {
    const response = teamMembershipErrorResponse(classifyTeamMembershipError({ code, message }));
    const body = await response.json();
    assert.equal(response.status, status);
    assert.deepEqual(body, { ok: false, code: safeCode });
    const outcome = classifyMembershipMutation(status, body, RECRUITER, "move");
    assert.ok(outcome.message.includes(copy));
    assert.equal(outcome.message.includes(message), false);
  }
  assert.equal(classifyMembershipMutation(400, { ok: false, code: "RAW_DB_ERROR" }, RECRUITER, "move").message,
    "Thông tin gửi lên không hợp lệ.");
});

const ITEM = { membership_id: MEMBERSHIP, recruiter_id: RECRUITER, team_id: TEAM,
  team_display_name: "Synthetic Team", valid_from: "2026-01-01", valid_to: null,
  recruiter_version: 3, state: "CURRENT" };
const LIST = { authorization_date: "2026-10-09", page: 1, page_size: 25, total: 1,
  memberships: [ITEM] };
const MUTATION = { membership_id: MEMBERSHIP, recruiter_id: RECRUITER, team_id: TEAM,
  valid_from: "2026-01-01", valid_to: null, recruiter_version: 4, revision_id: REV,
  change: "ASSIGN" };

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listMembership: async (i) => { calls.rpc.push(["list", i]); return result; },
        assignMembership: async (i) => { calls.rpc.push(["assign", i]); return result; },
        moveMembership: async (i) => { calls.rpc.push(["move", i]); return result; },
        unassignMembership: async (i) => { calls.rpc.push(["unassign", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, path = "/api/admin/catalog/personnel/" + RECRUITER + "/team-memberships",
  headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const ASSIGN_BODY = { valid_from: DAY, expected_version: 3,
  reason: "Synthetic reason", idempotency_key: KEY };
const UNASSIGN_BODY = { valid_to: DAY, expected_version: 3,
  reason: "Synthetic reason", idempotency_key: KEY };

test("the contract accepts exactly the reviewed projection shapes", () => {
  assert.deepEqual(teamMembershipItem(ITEM), ITEM);
  assert.deepEqual(teamMembershipList(LIST), LIST);
  assert.deepEqual(teamMembershipMutation(MUTATION), MUTATION);
  assert.deepEqual(teamMembershipItem({ ...ITEM, valid_to: null, state: "HISTORY" }),
    { ...ITEM, valid_to: null, state: "HISTORY" });
  assert.equal(teamMembershipItem({ ...ITEM, extra: 1 }), null);
  const withoutTeam = { ...ITEM };
  delete withoutTeam.team_id;
  assert.equal(teamMembershipItem(withoutTeam), null);
  assert.equal(teamMembershipItem({ ...ITEM, state: "OPEN" }), null);
  assert.equal(teamMembershipItem({ ...ITEM, valid_from: "01/01/2026" }), null);
  assert.equal(teamMembershipItem({ ...ITEM, valid_to: "nope" }), null);
  assert.equal(teamMembershipItem({ ...ITEM, recruiter_version: -1 }), null);
  assert.equal(teamMembershipList({ ...LIST, memberships: [{ ...ITEM, state: "x" }] }), null);
  assert.equal(teamMembershipMutation({ ...MUTATION, change: "REASSIGN" }), null);
  assert.equal(teamMembershipMutation({ ...MUTATION, change: "CANCEL" }).change, "CANCEL");
});

test("the feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listTeamMembership(new Request("https://app.test/x?state=current"), "false",
    d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: MUTATION });
  const res = await assignTeamMembership(
    jsonRequest(ASSIGN_BODY, undefined, { origin: "https://evil.test" }), RECRUITER, TEAM, "true",
    d.dependencies);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("content-type, body and client authority fields are rejected before session", async () => {
  const d = deps({ ok: true, data: MUTATION });
  const wrongType = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test" },
    body: "{}" });
  assert.equal((await assignTeamMembership(wrongType, RECRUITER, TEAM, "true", d.dependencies)).status, 400);

  const broken = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", host: "app.test" },
    body: "{not json" });
  const brokenRes = await assignTeamMembership(broken, RECRUITER, TEAM, "true", d.dependencies);
  assert.equal(brokenRes.status, 400);
  assert.equal((await brokenRes.json()).code, "BODY_INVALID");

  for (const forbidden of [{ actor: "x" }, { auth_subject: "x" }, { capabilities: [] },
    { scope: "all" }, { role: "admin" }, { app_user_id: "x" }, { scopes: [] }]) {
    const res = await assignTeamMembership(
      jsonRequest({ ...ASSIGN_BODY, ...forbidden }), RECRUITER, TEAM, "true", d.dependencies);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("request projections are strict about keys, values and OCC", () => {
  assert.equal(teamMembershipAssignRequest(ASSIGN_BODY).ok, true);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, expected_version: 0 }).ok, false);
  // The target team never travels in the body: a client-supplied team field would be
  // rejected by the shared authority validator, and by the exact-key projection here.
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, team_id: TEAM }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, team: TEAM }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "01/02/2026" }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "" }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "2099-01-01" }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: null }).ok, true);
  for (const reason of [undefined, null, "", "  "]) {
    const body = { ...ASSIGN_BODY };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const parsed = teamMembershipAssignRequest(body);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.reason, null);
  }
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, reason: 123 }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, reason: "x".repeat(4001) }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, idempotency_key: "nope" }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, extra: 1 }).ok, false);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_to: DAY }).ok, false,
    "an assign request never carries valid_to");
  for (const [parse, valid] of [
    [teamMembershipAssignRequest, ASSIGN_BODY],
    [teamMembershipUnassignRequest, UNASSIGN_BODY],
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

  // FIX R1: ISO shape is not enough - the date must exist in the calendar.
  for (const invalid of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-11-00"]) {
    assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: invalid }).ok, false,
      "assign " + invalid);
    assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: invalid }).ok, false,
      "unassign " + invalid);
  }
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "2024-02-29" }, "2024-02-29").ok, true,
    "a leap day is valid on that business date");
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: "2024-02-29" }, "2024-02-29").ok, true);
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "2024-02-29" }, "2026-11-12").ok, false,
    "past date is rejected");
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: "2024-02-29" }, "2026-11-12").ok, false,
    "past date is rejected");
  assert.equal(teamMembershipAssignRequest({ ...ASSIGN_BODY, valid_from: "2028-02-29" }).ok, false,
    "future date is rejected");
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: "2028-02-29" }).ok, false);

  assert.equal(teamMembershipUnassignRequest(UNASSIGN_BODY).ok, true);
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: "" }).ok, false);
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, valid_to: null }).ok, true);
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, team_id: TEAM }).ok, false,
    "an unassign request never carries a target team");
  assert.equal(teamMembershipUnassignRequest({ ...UNASSIGN_BODY, expected_version: -1 }).ok, false);
});

test("the list query requires a bounded state selector and bounded paging", async () => {
  const current = teamMembershipListQuery(new URL("https://app.test/x?state=current"));
  assert.deepEqual(current.ok && current.value,
    { state: "CURRENT", recruiter_id: null, team_id: null, search: null, page: 1, page_size: 25 });
  for (const [query, expected] of [["state=scheduled", "SCHEDULED"], ["state=HISTORY", "HISTORY"]]) {
    const parsed = teamMembershipListQuery(new URL("https://app.test/x?" + query));
    assert.equal(parsed.ok && parsed.value.state, expected);
  }
  for (const search of ["", "?state=", "?state=open", "?state=all", "?page=0", "?page_size=0",
    "?page_size=101", "?page=abc", "?search=" + "x".repeat(257), "?recruiter_id=nope",
    "?team_id=nope"]) {
    assert.equal(teamMembershipListQuery(new URL("https://app.test/x" + search)).ok, false, search);
  }
  const filtered = teamMembershipListQuery(new URL(
    "https://app.test/x?state=history&recruiter_id=" + RECRUITER + "&team_id=" + TEAM
    + "&search=%20abc%20&page=2&page_size=10"));
  assert.deepEqual(filtered.ok && filtered.value, { state: "HISTORY", recruiter_id: RECRUITER,
    team_id: TEAM, search: "abc", page: 2, page_size: 10 });
});

test("the session actor is the only actor source", async () => {
  const unauthenticated = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const denied = await listTeamMembership(new Request("https://app.test/x?state=current"), "true",
    unauthenticated.dependencies);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHENTICATED");

  const unavailable = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } });
  const actorUnavailable = await listTeamMembership(new Request("https://app.test/x?state=current"),
    "true", unavailable.dependencies);
  assert.equal(actorUnavailable.status, 403);
  assert.equal((await actorUnavailable.json()).code, "ACTOR_NOT_AVAILABLE");

  const d = deps({ ok: true, data: LIST });
  const res = await listTeamMembership(
    new Request("https://app.test/x?state=scheduled&page=2&page_size=5"), "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await res.json(), { ok: true, list: LIST });
  assert.deepEqual(d.calls.rpc[0][1], { ...ACTOR, state: "SCHEDULED", recruiter_id: null,
    team_id: null, search: null, page: 2, page_size: 5 });
});

test("idempotency header mismatch is rejected before the repository", async () => {
  const d = deps({ ok: true, data: MUTATION });
  const res = await assignTeamMembership(
    jsonRequest(ASSIGN_BODY, undefined, { "idempotency-key": OTHER }), RECRUITER, TEAM, "true",
    d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(d.calls.rpc.length, 0);
});

test("mutations project strict responses and sanitized failures", async () => {
  const ok = deps({ ok: true, data: MUTATION });
  const assigned = await assignTeamMembership(jsonRequest(ASSIGN_BODY), RECRUITER, TEAM, "true",
    ok.dependencies);
  assert.equal(assigned.status, 200);
  assert.deepEqual(await assigned.json(), { ok: true, membership: MUTATION });
  assert.deepEqual(ok.calls.rpc[0][1], { ...ACTOR, recruiter_id: RECRUITER, team_id: TEAM,
    valid_from: DAY, expected_version: 3, reason: "Synthetic reason", idempotency_key: KEY });

  const expected = { denied: [403, "MEMBERSHIP_DENIED"], "not-found": [404, "MEMBERSHIP_NOT_FOUND"],
    conflict: [409, "MEMBERSHIP_CONFLICT"], invalid: [400, "MEMBERSHIP_INVALID"],
    unavailable: [500, "MEMBERSHIP_UNAVAILABLE"] };
  for (const [kind, [status, code]] of Object.entries(expected)) {
    const d = deps({ ok: false, kind });
    const res = await moveTeamMembership(
      jsonRequest(ASSIGN_BODY, "/api/admin/catalog/personnel/" + RECRUITER
        + "/team-memberships/" + TEAM2 + "/move"), RECRUITER, TEAM2, "true", d.dependencies);
    assert.equal(res.status, status, kind);
    assert.deepEqual(await res.json(), { ok: false, code }, kind);
  }

  const throwing = deps({ ok: true, data: MUTATION });
  throwing.dependencies.repository.unassignMembership = async () => {
    throw new Error("RAW_DB_MESSAGE_SHOULD_NOT_LEAK");
  };
  const failure = await unassignTeamMembership(
    jsonRequest(UNASSIGN_BODY, "/api/admin/catalog/personnel/" + RECRUITER
      + "/team-memberships/unassign"), RECRUITER, "true", throwing.dependencies);
  assert.equal(failure.status, 500);
  const text = JSON.stringify(await failure.json());
  assert.equal(text.includes("RAW_DB_MESSAGE_SHOULD_NOT_LEAK"), false);
  assert.equal(text.includes("MEMBERSHIP_UNAVAILABLE"), true);
});

test("calendar-invalid dates are rejected at the boundary before session and repository", async () => {
  for (const invalid of ["2026-02-30", "2026-13-01", "2026-00-10"]) {
    const assign = deps({ ok: true, data: MUTATION });
    const assignResponse = await assignTeamMembership(
      jsonRequest({ ...ASSIGN_BODY, valid_from: invalid }), RECRUITER, TEAM, "true",
      assign.dependencies);
    assert.equal(assignResponse.status, 400, "assign " + invalid);
    assert.equal((await assignResponse.json()).code, "MEMBERSHIP_INVALID", invalid);
    assert.equal(assign.calls.session, 0, "assign " + invalid + " must not touch the session");
    assert.equal(assign.calls.rpc.length, 0, "assign " + invalid + " must not reach the repository");

    const unassign = deps({ ok: true, data: MUTATION });
    const unassignResponse = await unassignTeamMembership(
      jsonRequest({ ...UNASSIGN_BODY, valid_to: invalid },
        "/api/admin/catalog/personnel/" + RECRUITER + "/team-memberships/unassign"),
      RECRUITER, "true", unassign.dependencies);
    assert.equal(unassignResponse.status, 400, "unassign " + invalid);
    assert.equal((await unassignResponse.json()).code, "MEMBERSHIP_INVALID", invalid);
    assert.equal(unassign.calls.session, 0, "unassign " + invalid + " must not touch the session");
    assert.equal(unassign.calls.rpc.length, 0);
  }

  const past = deps({ ok: true, data: MUTATION });
  const pastResponse = await assignTeamMembership(
    jsonRequest({ ...ASSIGN_BODY, valid_from: "2024-02-29" }), RECRUITER, TEAM, "true",
    past.dependencies);
  assert.equal(pastResponse.status, 400);
  assert.equal((await pastResponse.json()).code, "MEMBERSHIP_INVALID");
  assert.equal(past.calls.session, 0);
  assert.equal(past.calls.rpc.length, 0);

  const omittedDate = deps({ ok: true, data: MUTATION });
  const omittedResponse = await unassignTeamMembership(
    jsonRequest({ expected_version: 3, reason: "Synthetic reason", idempotency_key: KEY },
      "/api/admin/catalog/personnel/" + RECRUITER + "/team-memberships/unassign"),
    RECRUITER, "true", omittedDate.dependencies);
  assert.equal(omittedResponse.status, 200);
  assert.equal(omittedDate.calls.rpc.length, 1);
  assert.equal(omittedDate.calls.rpc[0][1].valid_to, null);

  const future = deps({ ok: true, data: MUTATION });
  const futureResponse = await assignTeamMembership(
    jsonRequest({ ...ASSIGN_BODY, valid_from: "2028-02-29" }), RECRUITER, TEAM, "true",
    future.dependencies);
  assert.equal(futureResponse.status, 400);
  assert.equal((await futureResponse.json()).code, "MEMBERSHIP_INVALID");
  assert.equal(future.calls.session, 0);
  assert.equal(future.calls.rpc.length, 0);
});

test("an invalid recruiter path id is rejected before session", async () => {
  for (const [label, run] of [
    ["assign", (d) => assignTeamMembership(jsonRequest(ASSIGN_BODY), "not-a-uuid", TEAM, "true", d.dependencies)],
    ["move", (d) => moveTeamMembership(jsonRequest(ASSIGN_BODY), RECRUITER, "not-a-uuid", "true", d.dependencies)],
    ["unassign", (d) => unassignTeamMembership(jsonRequest(UNASSIGN_BODY), "not-a-uuid", "true", d.dependencies)],
  ]) {
    const d = deps({ ok: true, data: MUTATION });
    const res = await run(d);
    assert.equal(res.status, 400, label);
    assert.equal((await res.json()).code, "MEMBERSHIP_INVALID", label);
    assert.equal(d.calls.session, 0, label);
  }
});

test("repository maps SQLSTATE to sanitized kinds and calls the canonical RPCs", async () => {
  assert.equal(classifyTeamMembershipError({ code: "40001" }), "conflict");
  assert.equal(classifyTeamMembershipError({ code: "PT409" }), "conflict");
  assert.equal(classifyTeamMembershipError({ code: "23P01" }), "overlap");
  assert.equal(classifyTeamMembershipError({ code: "23505" }), "conflict");
  assert.equal(classifyTeamMembershipError({ code: "42501" }), "denied");
  assert.equal(classifyTeamMembershipError({ code: "P0002" }), "not-found");
  assert.equal(classifyTeamMembershipError({ code: "23514" }), "invalid");
  assert.equal(classifyTeamMembershipError({ code: "22023", message: "reason required" }), "invalid");
  assert.equal(classifyTeamMembershipError({ code: "22023",
    message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyTeamMembershipError({ code: "XX000" }), "unavailable");

  const calls = [];
  const repository = createTeamMembershipRepository(async (name, args) => {
    calls.push([name, args]);
    if (name.startsWith("direct_entry_list_team_membership_")) return { data: LIST, error: null };
    return { data: MUTATION, error: null };
  });

  assert.deepEqual(await repository.listMembership({ ...ACTOR, state: "CURRENT",
    recruiter_id: RECRUITER, team_id: null, search: null, page: 1, page_size: 25 }),
  { ok: true, data: LIST });
  assert.deepEqual(calls[0], ["direct_entry_list_team_membership_current",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
      p_recruiter_id: RECRUITER, p_team_id: null, p_search: null, p_page: 1, p_page_size: 25 }]);
  await repository.listMembership({ ...ACTOR, state: "SCHEDULED", recruiter_id: null,
    team_id: TEAM, search: "abc", page: 1, page_size: 10 });
  assert.equal(calls[1][0], "direct_entry_list_team_membership_scheduled");
  await repository.listMembership({ ...ACTOR, state: "HISTORY", recruiter_id: null,
    team_id: null, search: null, page: 1, page_size: 25 });
  assert.equal(calls[2][0], "direct_entry_list_team_membership_history");

  assert.deepEqual(await repository.assignMembership({ ...ACTOR, recruiter_id: RECRUITER,
    team_id: TEAM, valid_from: DAY, expected_version: 3, reason: "Synthetic reason",
    idempotency_key: KEY }), { ok: true, data: MUTATION });
  assert.deepEqual(calls[3], ["direct_entry_assign_team_membership",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
      p_recruiter_id: RECRUITER, p_team_id: TEAM, p_valid_from: DAY, p_expected_version: 3,
      p_reason: "Synthetic reason", p_idempotency_key: KEY }]);

  await repository.moveMembership({ ...ACTOR, recruiter_id: RECRUITER, team_id: TEAM2,
    valid_from: DAY, expected_version: 4, reason: "Synthetic reason", idempotency_key: KEY });
  assert.deepEqual(calls[4], ["direct_entry_move_team_membership",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
      p_recruiter_id: RECRUITER, p_team_id: TEAM2, p_valid_from: DAY, p_expected_version: 4,
      p_reason: "Synthetic reason", p_idempotency_key: KEY }]);

  await repository.unassignMembership({ ...ACTOR, recruiter_id: RECRUITER, valid_to: DAY,
    expected_version: 5, reason: "Synthetic reason", idempotency_key: KEY });
  assert.deepEqual(calls[5], ["direct_entry_unassign_team_membership",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id,
      p_recruiter_id: RECRUITER, p_valid_to: DAY, p_expected_version: 5,
      p_reason: "Synthetic reason", p_idempotency_key: KEY }]);
  assert.equal(Object.keys(calls[5][1]).some((key) => key.includes("team_id")), false,
    "an unassign never sends a target team");

  const malformed = createTeamMembershipRepository(async () => ({
    data: { unexpected: true }, error: null,
  }));
  assert.deepEqual(await malformed.listMembership({ ...ACTOR, state: "CURRENT",
    recruiter_id: null, team_id: null, search: null, page: 1, page_size: 25 }),
  { ok: false, kind: "unavailable" });

  const overlap = createTeamMembershipRepository(async () => ({
    data: null, error: { code: "23P01", message: "effective interval overlaps" },
  }));
  assert.deepEqual(await overlap.assignMembership({ ...ACTOR, recruiter_id: RECRUITER,
    team_id: TEAM, valid_from: DAY, expected_version: 1, reason: "r", idempotency_key: KEY }),
  { ok: false, kind: "overlap" });
});
