import assert from "node:assert/strict";
import test from "node:test";

import {
  teamLeaderCandidate,
  teamLeaderCandidateList,
  teamLeaderItem,
  teamLeaderList,
  teamLeaderMutation,
} from "./team-leader-contract.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const RECRUITER = "33333333-3333-4333-8333-333333333333";
const REVISION = "44444444-4444-4444-8444-444444444444";
const ITEM = {
  assignment_id: ID, team_id: TEAM, team_display_name: "Team",
  leader_app_user_id: ID, leader_recruiter_id: RECRUITER,
  leader_display_name: "Recruiter", valid_from: "2026-02-28", valid_to: null,
  state: "CURRENT",
};
const LIST = {
  authorization_date: "2026-02-28", page: 1, page_size: 25, total: 1, leaders: [ITEM],
};
const MUTATION = {
  team_id: TEAM, assignment_id: ID, leader_app_user_id: ID, leader_recruiter_id: RECRUITER,
  valid_from: "2026-02-28", valid_to: null, version: 2, revision_id: REVISION, change: "designate",
};
const CANDIDATE = { app_user_id: ID, display_name: "Recruiter", personnel_code: null };
const CANDIDATES = {
  authorization_date: "2026-02-28", page: 1, page_size: 25, total: 1, candidates: [CANDIDATE],
};

test("strictly projects leader read, mutation, and three-key candidate shapes", () => {
  assert.deepEqual(teamLeaderItem(ITEM), ITEM);
  assert.deepEqual(teamLeaderItem({ ...ITEM, state: "SUSPENDED" }), { ...ITEM, state: "SUSPENDED" });
  assert.deepEqual(teamLeaderList(LIST), LIST);
  assert.deepEqual(teamLeaderMutation(MUTATION), MUTATION);
  assert.deepEqual(teamLeaderCandidate(CANDIDATE), CANDIDATE);
  assert.deepEqual(teamLeaderCandidateList(CANDIDATES), CANDIDATES);
  assert.equal(teamLeaderMutation({
    ...MUTATION, valid_from: "2025-01-01", valid_to: "2026-02-28", change: "revoke",
  }).valid_to, "2026-02-28");
  assert.equal(teamLeaderCandidate({ ...CANDIDATE, recruiter_id: RECRUITER }), null);
  assert.equal(teamLeaderCandidate({ app_user_id: ID, display_name: "Recruiter" }), null);
  assert.equal(teamLeaderCandidate({ ...CANDIDATE, personnel_code: 1 }), null);
  assert.equal(teamLeaderItem({ ...ITEM, email: "private@example.test" }), null);
  assert.equal(teamLeaderItem({ ...ITEM, recruiter_id: RECRUITER }), null);
  assert.equal(teamLeaderList({ ...LIST, leaders: [{ ...ITEM, reason: "private" }] }), null);
  assert.equal(teamLeaderMutation({ ...MUTATION, change: "transition" }), null);
  assert.equal(teamLeaderMutation({ ...MUTATION, extra: true }), null);
  assert.equal(teamLeaderMutation({ ...MUTATION, valid_to: "2026-02-27" }), null);
  assert.equal(teamLeaderCandidateList({ ...CANDIDATES, candidates: [{
    ...CANDIDATE, recruiter_id: RECRUITER,
  }] }), null);
});
