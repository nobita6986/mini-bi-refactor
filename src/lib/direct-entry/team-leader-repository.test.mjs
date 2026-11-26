import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTeamLeaderError,
  createTeamLeaderRepository,
} from "./team-leader-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const TEAM = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const RECRUITER = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT = "66666666-6666-4666-8666-666666666666";
const REVISION = "77777777-7777-4777-8777-777777777777";
const DAY = "2026-10-10";
const ITEM = {
  assignment_id: ASSIGNMENT, team_id: TEAM, team_display_name: "Team",
  leader_app_user_id: TARGET, leader_recruiter_id: RECRUITER,
  leader_display_name: "Recruiter", valid_from: DAY, valid_to: null, state: "CURRENT",
};
const LIST = {
  authorization_date: DAY, page: 1, page_size: 25, total: 1, leaders: [ITEM],
};
const MUTATION = {
  team_id: TEAM, assignment_id: ASSIGNMENT, leader_app_user_id: TARGET,
  leader_recruiter_id: RECRUITER, valid_from: DAY, valid_to: null,
  version: 2, revision_id: REVISION, change: "designate",
};
const CANDIDATE_LIST = {
  authorization_date: DAY, page: 1, page_size: 25, total: 1,
  candidates: [{ app_user_id: TARGET, display_name: "Recruiter", personnel_code: null }],
};

test("repository makes exactly one canonical RPC call per operation and projects strictly", async () => {
  const calls = [];
  const repo = createTeamLeaderRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: name.endsWith("candidates") ? CANDIDATE_LIST :
      name.includes("designate") ? MUTATION : name.includes("revoke") ? MUTATION : LIST,
    error: null };
  });
  assert.equal((await repo.listLeaders({ ...ACTOR, state: "CURRENT", team_id: TEAM,
    search: null, page: 1, page_size: 25 })).ok, true);
  assert.equal((await repo.listLeaders({ ...ACTOR, state: "SUSPENDED", team_id: TEAM,
    search: null, page: 1, page_size: 25 })).ok, true);
  assert.equal((await repo.listLeaders({ ...ACTOR, state: "SCHEDULED", team_id: null,
    search: null, page: 1, page_size: 25 })).ok, true);
  assert.equal((await repo.listLeaders({ ...ACTOR, state: "HISTORY", team_id: null,
    search: null, page: 1, page_size: 25 })).ok, true);
  assert.equal((await repo.listCandidates({ ...ACTOR, team_id: TEAM,
    search: null, page: 1, page_size: 25 })).ok, true);
  assert.equal((await repo.designateLeader({ ...ACTOR, team_id: TEAM, leader_app_user_id: TARGET,
    effective_date: DAY, expected_version: 1, reason: "reason", idempotency_key: TARGET })).ok, true);
  assert.equal((await repo.revokeLeader({ ...ACTOR, team_id: TEAM,
    effective_date: DAY, expected_version: 1, reason: "reason", idempotency_key: TARGET })).ok, true);
  assert.deepEqual(calls.map(({ name }) => name), [
    "direct_entry_list_team_leaders_current",
    "direct_entry_list_team_leaders_suspended",
    "direct_entry_list_team_leaders_scheduled",
    "direct_entry_list_team_leader_history",
    "direct_entry_list_team_leader_candidates",
    "direct_entry_designate_team_leader",
    "direct_entry_revoke_team_leader",
  ]);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[5].args, {
    p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_team_id: TEAM,
    p_leader_app_user_id: TARGET, p_effective_date: DAY, p_expected_version: 1,
    p_reason: "reason", p_idempotency_key: TARGET,
  });
  assert.equal(Object.hasOwn(calls[6].args, "p_leader_app_user_id"), false);

  const malformed = createTeamLeaderRepository(async () => ({
    data: { ...CANDIDATE_LIST, candidates: [{ ...CANDIDATE_LIST.candidates[0], recruiter_id: RECRUITER }] },
    error: null,
  }));
  assert.deepEqual(await malformed.listCandidates({
    ...ACTOR, team_id: TEAM, search: null, page: 1, page_size: 25,
  }), { ok: false, kind: "unavailable" });
});

test("database codes map to sanitized repository error kinds", () => {
  assert.equal(classifyTeamLeaderError({ code: "42501", message: "PII" }), "denied");
  assert.equal(classifyTeamLeaderError({ code: "P0002" }), "not-found");
  assert.equal(classifyTeamLeaderError({ code: "23514" }), "invalid");
  assert.equal(classifyTeamLeaderError({ code: "40001" }), "conflict");
  assert.equal(classifyTeamLeaderError({ code: "PT409" }), "conflict");
  assert.equal(classifyTeamLeaderError({ code: "23P01" }), "conflict");
  assert.equal(classifyTeamLeaderError({ code: "22023",
    message: "idempotency key reused with different input" }), "invalid");
  assert.equal(classifyTeamLeaderError({ code: "55000", message: "private" }), "unavailable");
  assert.equal(classifyTeamLeaderError({ code: "XX000", message: "raw details" }), "unavailable");
});
