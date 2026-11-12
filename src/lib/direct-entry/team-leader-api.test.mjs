import assert from "node:assert/strict";
import test from "node:test";

import {
  designateTeamLeader,
  listTeamLeader,
  listTeamLeaderCandidates,
  revokeTeamLeader,
  teamLeaderCandidateQuery,
  teamLeaderErrorResponse,
  teamLeaderListQuery,
} from "./team-leader-api.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const TEAM = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const RECRUITER = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT = "66666666-6666-4666-8666-666666666666";
const REVISION = "77777777-7777-4777-8777-777777777777";
const KEY = "88888888-8888-4888-8888-888888888888";
const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const ITEM = {
  assignment_id: ASSIGNMENT, team_id: TEAM, team_display_name: "Team",
  leader_app_user_id: TARGET, leader_recruiter_id: RECRUITER,
  leader_display_name: "Recruiter", valid_from: DAY, valid_to: null, state: "CURRENT",
};
const LIST = { authorization_date: DAY, page: 1, page_size: 25, total: 1, leaders: [ITEM] };
const CANDIDATES = { authorization_date: DAY, page: 1, page_size: 25, total: 0, candidates: [] };
const MUTATION = {
  team_id: TEAM, assignment_id: ASSIGNMENT, leader_app_user_id: TARGET,
  leader_recruiter_id: RECRUITER, valid_from: DAY, valid_to: null,
  version: 2, revision_id: REVISION, change: "designate",
};
const DESIGNATE_BODY = {
  leader_app_user_id: TARGET, effective_date: DAY, expected_version: 1,
  reason: "Synthetic reason", idempotency_key: KEY,
};
const REVOKE_BODY = {
  effective_date: DAY, expected_version: 1, reason: "Synthetic reason", idempotency_key: KEY,
};

function dependencies({
  session = { actor: { ok: true, actor: ACTOR } },
  result = { ok: true, data: LIST },
} = {}) {
  const calls = { session: 0, repository: [] };
  const run = (name) => async (input) => {
    calls.repository.push([name, input]);
    return result;
  };
  return {
    calls,
    value: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listLeaders: run("listLeaders"), listCandidates: run("listCandidates"),
        designateLeader: run("designateLeader"), revokeLeader: run("revokeLeader"),
      },
    },
  };
}

function post(body, path = `/api/admin/catalog/teams/${TEAM}/leaders`, headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: "https://app.test", host: "app.test",
      "sec-fetch-site": "same-origin", ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("query parsers enforce exact keys, duplicate rejection, bounds and ISO calendar dates", () => {
  assert.equal(teamLeaderListQuery(new URL("https://x.test/?state=current")).ok, true);
  assert.equal(teamLeaderListQuery(new URL(`https://x.test/?state=history&team_id=${TEAM}&page=2`)).ok, true);
  for (const query of [
    "", `state=current&team_id=${TEAM}&team_id=${TEAM}`, "state=other", "state=current&role=admin",
    "state=current&page=0", "state=current&page_size=101",
  ]) assert.equal(teamLeaderListQuery(new URL(`https://x.test/?${query}`)).ok, false, query);
  assert.equal(teamLeaderCandidateQuery(new URL(`https://x.test/?team_id=${TEAM}`)).ok, true);
  for (const query of ["", `team_id=${TEAM}&team_id=${TEAM}`, `team_id=${TEAM}&app_user_id=x`,
    "team_id=nope", `team_id=${TEAM}&search=${"x".repeat(257)}`]) {
    assert.equal(teamLeaderCandidateQuery(new URL(`https://x.test/?${query}`)).ok, false, query);
  }
  assert.equal(teamLeaderListQuery(new URL("https://x.test/?state=current&search=x&page=1000&page_size=100")).ok, true);
});

test("gate precedes session and query parsing on reads", async () => {
  const d = dependencies();
  const response = await listTeamLeader(new Request("https://app.test/?bad"), "false", d.value);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "NOT_FOUND");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(d.calls.session, 0);
  const invalid = await listTeamLeader(new Request("https://app.test/?state=no"), "true", d.value);
  assert.equal(invalid.status, 400);
  assert.equal(d.calls.session, 0);
});

test("read routes use only session actor and issue one RPC per request", async () => {
  const d = dependencies();
  const read = await listTeamLeader(new Request("https://app.test/?state=current"), "true", d.value);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.equal((await read.json()).list.leaders[0].leader_recruiter_id, RECRUITER);
  const candidates = dependencies({ result: { ok: true, data: CANDIDATES } });
  assert.equal((await listTeamLeaderCandidates(new Request(
    `https://app.test/?team_id=${TEAM}`), "true", candidates.value)).status, 200);
  assert.equal(candidates.calls.repository.length, 1);
  assert.deepEqual(candidates.calls.repository[0], ["listCandidates", {
    ...ACTOR, team_id: TEAM, search: null, page: 1, page_size: 25,
  }]);
  assert.equal(d.calls.repository.length, 1);
  assert.equal(d.calls.repository[0][1].auth_subject, ACTOR.auth_subject);
});

test("same-origin and body shape/authority/idempotency fail before session", async () => {
  const d = dependencies();
  const csrf = await designateTeamLeader(
    post(DESIGNATE_BODY, undefined, { "sec-fetch-site": "cross-site" }),
    TEAM, "true", d.value);
  assert.equal((await csrf.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);

  const wrongType = new Request("https://app.test/path", { method: "POST",
    headers: { origin: "https://app.test", host: "app.test", "sec-fetch-site": "same-origin" },
    body: "{}" });
  const wrongTypeResponse = await designateTeamLeader(wrongType, TEAM, "true", d.value);
  assert.equal(wrongTypeResponse.status, 400);
  assert.equal((await wrongTypeResponse.json()).code, "CONTENT_TYPE_INVALID");
  const malformedJson = new Request("https://app.test/path", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin" }, body: "{not-json" });
  const malformedResponse = await designateTeamLeader(malformedJson, TEAM, "true", d.value);
  assert.equal((await malformedResponse.json()).code, "BODY_INVALID");
  assert.equal((await designateTeamLeader(post({ ...DESIGNATE_BODY, auth_subject: ACTOR.auth_subject }),
    TEAM, "true", d.value)).status, 400);
  const nestedAuthority = post({ ...DESIGNATE_BODY, extra: [{ role: "admin" }] });
  const nested = await designateTeamLeader(nestedAuthority, TEAM, "true", d.value);
  assert.equal((await nested.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal((await designateTeamLeader(post({ ...DESIGNATE_BODY, expected_version: 0 }),
    TEAM, "true", d.value)).status, 400);
  assert.equal((await designateTeamLeader(post({ ...DESIGNATE_BODY, effective_date: "2026-02-30" }),
    TEAM, "true", d.value)).status, 400);
  assert.equal((await designateTeamLeader(post({ ...DESIGNATE_BODY, team_id: TEAM }),
    TEAM, "true", d.value)).status, 400);
  for (const reason of [123, "x".repeat(4001)]) {
    const invalid = await designateTeamLeader(post({ ...DESIGNATE_BODY, reason }), TEAM, "true", d.value);
    assert.equal(invalid.status, 400);
  }
  const mismatch = await designateTeamLeader(
    post(DESIGNATE_BODY, undefined, { "idempotency-key": TARGET }),
    TEAM, "true", d.value);
  assert.equal((await mismatch.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal((await designateTeamLeader(post(DESIGNATE_BODY), "not-a-uuid", "true", d.value)).status, 400);
  assert.equal((await revokeTeamLeader(post({ ...REVOKE_BODY, leader_app_user_id: TARGET },
    `/api/admin/catalog/teams/${TEAM}/leaders/revoke`), TEAM, "true", d.value)).status, 400);
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.repository.length, 0);
});

test("oversized JSON and session failures are sanitized", async () => {
  const d = dependencies();
  const large = await designateTeamLeader(post({ ...DESIGNATE_BODY, reason: "x".repeat(70_000) }),
    TEAM, "true", d.value);
  assert.equal((await large.json()).code, "BODY_INVALID");
  assert.equal(d.calls.session, 0);

  const anonymous = dependencies({ session: { actor: { ok: false, reason: "UNAUTHENTICATED" } } });
  assert.equal((await listTeamLeader(new Request("https://app.test/?state=current"),
    "true", anonymous.value)).status, 401);
  const actorMissing = dependencies({ session: { actor: { ok: false, reason: "ACTOR_UNAVAILABLE" } } });
  assert.equal((await listTeamLeader(new Request("https://app.test/?state=current"),
    "true", actorMissing.value)).status, 403);
});

test("mutation submits only trusted actor and path team, and revocation has no target", async () => {
  const d = dependencies({ result: { ok: true, data: MUTATION } });
  assert.equal((await designateTeamLeader(post(DESIGNATE_BODY), TEAM, "true", d.value)).status, 200);
  assert.deepEqual(d.calls.repository[0], ["designateLeader", {
    ...ACTOR, team_id: TEAM, ...DESIGNATE_BODY,
  }]);
  assert.equal((await revokeTeamLeader(post(REVOKE_BODY,
    `/api/admin/catalog/teams/${TEAM}/leaders/revoke`), TEAM, "true", d.value)).status, 200);
  assert.equal(d.calls.repository.length, 2);
  assert.equal(Object.hasOwn(d.calls.repository[1][1], "leader_app_user_id"), false);

  for (const reason of [undefined, null, "", "  "]) {
    const optional = dependencies({ result: { ok: true, data: MUTATION } });
    const body = { ...DESIGNATE_BODY };
    if (reason === undefined) delete body.reason;
    else body.reason = reason;
    const response = await designateTeamLeader(post(body), TEAM, "true", optional.value);
    assert.equal(response.status, 200);
    assert.equal(optional.calls.repository[0][1].reason, null);
  }
});

test("denials, not-found and raw RPC failures have stable sanitized responses", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "LEADER_DENIED"], ["not-found", 404, "LEADER_NOT_FOUND"],
    ["conflict", 409, "LEADER_CONFLICT"], ["invalid", 400, "LEADER_INVALID"],
    ["unavailable", 500, "LEADER_UNAVAILABLE"],
  ]) {
    const response = teamLeaderErrorResponse(kind);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
  const raw = dependencies({ result: { ok: false, kind: "unavailable" } });
  const response = await listTeamLeader(new Request("https://app.test/?state=current"), "true", raw.value);
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes("database"), false);
});
