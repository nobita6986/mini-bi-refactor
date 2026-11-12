import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTeamLeaderCandidateQuery,
  buildTeamLeaderDesignation,
  buildTeamLeaderListQuery,
  buildTeamLeaderRevocation,
  classifyTeamLeaderMutation,
  projectTeamLeaderCandidates,
  projectTeamLeaderList,
  projectTeamLeaderSnapshot,
  TEAM_LEADER_CANDIDATE_PAGE_SIZE,
  TEAM_LEADER_PAGE_SIZE,
} from "./team-leader-model.ts";
import { setTeamConflictLock } from "./team-catalog-model.ts";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM_ID = "22222222-2222-4222-8222-222222222222";
const APP_USER_ID = "33333333-3333-4333-8333-333333333333";
const RECRUITER_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNMENT_ID = "55555555-5555-4555-8555-555555555555";
const REVISION_ID = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const TEAM = {
  team_id: TEAM_ID, code: "team-a", display_name: "Nhóm A", active: true,
  version: 3, revision_count: 4,
};

function leader(state, teamId = TEAM_ID, overrides = {}) {
  return {
    assignment_id: ASSIGNMENT_ID,
    team_id: teamId,
    team_display_name: "Nhóm A",
    leader_app_user_id: APP_USER_ID,
    leader_recruiter_id: RECRUITER_ID,
    leader_display_name: "Nguyễn An",
    valid_from: "2026-10-10",
    valid_to: state === "HISTORY" ? "2026-10-09" : null,
    state,
    ...overrides,
  };
}

function list(state, items = [leader(state)], overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-10-10", page: 1, page_size: TEAM_LEADER_PAGE_SIZE,
      total: items.length, leaders: items, ...overrides,
    },
  };
}

function candidateList(candidateRows = [{
  app_user_id: APP_USER_ID, display_name: "Nguyễn An", personnel_code: null,
}], overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-10-10", page: 1,
      page_size: TEAM_LEADER_CANDIDATE_PAGE_SIZE,
      total: candidateRows.length, candidates: candidateRows, ...overrides,
    },
  };
}

test("leader list queries are explicit, bounded, team-scoped and state-specific", () => {
  const query = buildTeamLeaderListQuery(TEAM_ID, "SCHEDULED", 2);
  assert.equal(query.get("state"), "scheduled");
  assert.equal(query.get("team_id"), TEAM_ID);
  assert.equal(query.get("page"), "2");
  assert.equal(query.get("page_size"), "25");
  assert.equal(TEAM_LEADER_PAGE_SIZE, 25);
  assert.equal(buildTeamLeaderListQuery(TEAM_ID, "CURRENT", 0), null);
  assert.equal(buildTeamLeaderListQuery(OTHER_TEAM_ID, "CURRENT", 1001), null);
  assert.equal(buildTeamLeaderListQuery("invalid", "CURRENT", 1), null);
});

test("leader list projection rejects extra keys, mismatched team/state and out-of-query pages", () => {
  const expected = { teamId: TEAM_ID, state: "CURRENT", page: 1 };
  assert.ok(projectTeamLeaderList(list("CURRENT"), expected));
  assert.equal(projectTeamLeaderList({ ...list("CURRENT"), trace: "raw" }, expected), null);
  assert.equal(projectTeamLeaderList(list("CURRENT", [leader("CURRENT", OTHER_TEAM_ID)]), expected), null);
  assert.equal(projectTeamLeaderList(list("SCHEDULED"), expected), null);
  assert.equal(projectTeamLeaderList(list("CURRENT", [], { page: 2 }), expected), null);
  assert.equal(projectTeamLeaderList(list("CURRENT", [leader("CURRENT", TEAM_ID, { email: "private" })]), expected), null);
});

test("candidate query is bounded and projection accepts exactly the three API keys", () => {
  const query = buildTeamLeaderCandidateQuery(TEAM_ID, "  An  ", 3);
  assert.equal(query.get("team_id"), TEAM_ID);
  assert.equal(query.get("search"), "An");
  assert.equal(query.get("page"), "3");
  assert.equal(query.get("page_size"), "25");
  assert.equal(buildTeamLeaderCandidateQuery(TEAM_ID, "x".repeat(257), 1), null);
  assert.equal(buildTeamLeaderCandidateQuery(TEAM_ID, "", 1001), null);
  assert.deepEqual(projectTeamLeaderCandidates(candidateList(), 1)?.candidates, [{
    app_user_id: APP_USER_ID, display_name: "Nguyễn An", personnel_code: null,
  }]);
  assert.equal(projectTeamLeaderCandidates(candidateList([{
    app_user_id: APP_USER_ID, display_name: "Nguyễn An", personnel_code: null,
    recruiter_id: RECRUITER_ID,
  }]), 1), null);
  assert.equal(projectTeamLeaderCandidates(candidateList([{
    app_user_id: APP_USER_ID, display_name: "Nguyễn An",
  }]), 1), null);
  assert.equal(projectTeamLeaderCandidates(candidateList(), 2), null);
});

test("designation, replacement and revoke requests use exact server contract bodies and paths", () => {
  const designate = buildTeamLeaderDesignation({
    teamId: TEAM_ID, leaderAppUserId: APP_USER_ID, effectiveDate: TODAY_VN,
    expectedVersion: 3, reason: "Bổ nhiệm", idempotencyKey: KEY, change: "designate",
  });
  assert.equal(designate.ok, true);
  assert.equal(designate.intent.url, `/api/admin/catalog/teams/${TEAM_ID}/leaders`);
  assert.deepEqual(Object.keys(designate.intent.body).sort(), [
    "effective_date", "expected_version", "idempotency_key", "leader_app_user_id", "reason",
  ]);
  assert.equal(designate.intent.body.expected_version, 3);
  const replacement = buildTeamLeaderDesignation({
    teamId: TEAM_ID, leaderAppUserId: APP_USER_ID, effectiveDate: TODAY_VN,
    expectedVersion: 3, reason: "Thay thế", idempotencyKey: KEY, change: "replace",
  });
  assert.equal(replacement.ok && replacement.intent.change, "replace");
  const revoke = buildTeamLeaderRevocation({
    teamId: TEAM_ID, effectiveDate: TODAY_VN, expectedVersion: 3,
    reason: "Thu hồi", idempotencyKey: KEY,
  });
  assert.equal(revoke.ok, true);
  assert.equal(revoke.intent.url, `/api/admin/catalog/teams/${TEAM_ID}/leaders/revoke`);
  assert.deepEqual(Object.keys(revoke.intent.body).sort(), [
    "effective_date", "expected_version", "idempotency_key", "reason",
  ]);
  const noReason = buildTeamLeaderDesignation({
    teamId: TEAM_ID, leaderAppUserId: APP_USER_ID, effectiveDate: TODAY_VN,
    expectedVersion: 3, idempotencyKey: KEY, change: "designate",
  });
  assert.equal(noReason.ok, true);
  if (noReason.ok) assert.equal(noReason.intent.body.reason, null);
  const blankReason = buildTeamLeaderRevocation({
    teamId: TEAM_ID, effectiveDate: TODAY_VN, expectedVersion: 3,
    reason: "  ", idempotencyKey: KEY,
  });
  assert.equal(blankReason.ok, true);
  if (blankReason.ok) assert.equal(blankReason.intent.body.reason, null);
  assert.equal(buildTeamLeaderDesignation({
    teamId: TEAM_ID, leaderAppUserId: APP_USER_ID, effectiveDate: "2026-10-10",
    expectedVersion: 3, reason: "Reason", idempotencyKey: KEY, change: "designate",
  }).ok, false);
  assert.equal(buildTeamLeaderDesignation({
    teamId: TEAM_ID, leaderAppUserId: APP_USER_ID, effectiveDate: "2026-02-30",
    expectedVersion: 3, reason: "Reason", idempotencyKey: KEY, change: "designate",
  }).ok, false);
  assert.equal(buildTeamLeaderRevocation({
    teamId: TEAM_ID, effectiveDate: TODAY_VN, expectedVersion: 0,
    reason: "Reason", idempotencyKey: KEY,
  }).ok, false);
});

test("mutation classification sanitizes denied, reserved/inactive, OCC and unavailable outcomes", () => {
  const request = buildTeamLeaderRevocation({
    teamId: TEAM_ID, effectiveDate: TODAY_VN, expectedVersion: 3,
    reason: "Reason", idempotencyKey: KEY,
  });
  assert.ok(request.ok);
  assert.equal(classifyTeamLeaderMutation(401, null, request.intent).kind, "unauthenticated");
  assert.equal(classifyTeamLeaderMutation(403, { message: "raw database detail" }, request.intent).kind, "denied");
  assert.equal(classifyTeamLeaderMutation(404, null, request.intent).kind, "not-found");
  assert.equal(classifyTeamLeaderMutation(409, null, request.intent).kind, "conflict");
  const invalid = classifyTeamLeaderMutation(400, null, request.intent);
  assert.equal(invalid.kind, "invalid");
  assert.match(invalid.message, /nhóm hệ thống/);
  const unavailable = classifyTeamLeaderMutation(500, { message: "raw database detail" }, request.intent);
  assert.equal(unavailable.kind, "unavailable");
  assert.doesNotMatch(unavailable.message, /raw database detail/);
  const applied = {
    ok: true,
    leader: {
      team_id: TEAM_ID, assignment_id: ASSIGNMENT_ID, leader_app_user_id: APP_USER_ID,
      leader_recruiter_id: RECRUITER_ID, valid_from: "2026-10-10",
      valid_to: "2026-10-10", version: 4, revision_id: REVISION_ID, change: "revoke",
    },
  };
  assert.equal(classifyTeamLeaderMutation(200, applied, request.intent).kind, "applied");
  assert.equal(classifyTeamLeaderMutation(200, {
    ...applied, leader: { ...applied.leader, team_id: OTHER_TEAM_ID },
  }, request.intent).kind, "unavailable");
  assert.equal(classifyTeamLeaderMutation(200, { ...applied, debug: true }, request.intent).kind, "unavailable");
});

test("authoritative reload requires the matching team and all three strict leader lists", () => {
  const snapshot = projectTeamLeaderSnapshot(TEAM_ID, { ok: true, team: TEAM }, {
    CURRENT: list("CURRENT", []),
    SCHEDULED: list("SCHEDULED", []),
    HISTORY: list("HISTORY", []),
  });
  assert.equal(snapshot?.team.version, 3);
  assert.deepEqual(Object.keys(snapshot?.lists ?? {}).sort(), ["CURRENT", "HISTORY", "SCHEDULED"]);
  assert.equal(projectTeamLeaderSnapshot(TEAM_ID, { ok: true, team: { ...TEAM, team_id: OTHER_TEAM_ID } }, {
    CURRENT: list("CURRENT", []), SCHEDULED: list("SCHEDULED", []), HISTORY: list("HISTORY", []),
  }), null);
  assert.equal(projectTeamLeaderSnapshot(TEAM_ID, { ok: true, team: TEAM }, {
    CURRENT: list("CURRENT", []), SCHEDULED: list("SCHEDULED", []), HISTORY: null,
  }), null);
});

test("entity-scoped lock leaves other teams available until the matching reload completes", () => {
  const locks = setTeamConflictLock(setTeamConflictLock(new Set(), TEAM_ID, true), OTHER_TEAM_ID, true);
  const afterTeamReload = setTeamConflictLock(locks, TEAM_ID, false);
  assert.equal(afterTeamReload.has(TEAM_ID), false);
  assert.equal(afterTeamReload.has(OTHER_TEAM_ID), true);
});
