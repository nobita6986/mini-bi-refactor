import assert from "node:assert/strict";
import test from "node:test";
import { createAssignmentRepository } from "./assignment-repository.ts";

const actor = { auth_subject: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const team = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const template = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const version = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("assignment options call the scoped service RPC with the trusted actor and project its result", async () => {
  let called;
  const data = {
    templates: [{ template_id: template, template_code: "DAILY", display_name: "Báo cáo ngày",
      default_frequency: "DAILY", current_published_version_id: version }],
    teams: [{ team_id: team, code: "TEAM_A", display_name: "Team A" }],
    users: [],
  };
  const repository = createAssignmentRepository(async (name, args) => {
    called = { name, args };
    return { data, error: null };
  });
  const result = await repository.listOptions({ ...actor, team_id: team });
  assert.deepEqual(called, { name: "work_report_list_assignment_options", args: {
    p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id, p_team_id: team,
  } });
  assert.deepEqual(result, { ok: true, data });
});

test("assignment options reject malformed RPC data and preserve access denials", async () => {
  const malformed = createAssignmentRepository(async () => ({ data: { users: [] }, error: null }));
  assert.deepEqual(await malformed.listOptions({ ...actor, team_id: null }), { ok: false, kind: "unavailable" });
  const denied = createAssignmentRepository(async () => ({ data: null, error: { code: "42501" } }));
  assert.deepEqual(await denied.listOptions({ ...actor, team_id: team }), { ok: false, kind: "denied" });
});

test("assignment tracking calls the scoped service RPC and validates aggregate progress", async () => {
  let called;
  const item = {
    assignment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", template_id: template,
    template_code: "DAILY", template_name: "Báo cáo ngày", target_kind: "USER_SET",
    target_label: "Staff A1, Staff A2", frequency: "DAILY", is_mandatory: true,
    effective_from: "2026-10-21", effective_to: null, state: "ACTIVE", version: 1,
    created_at: "2026-10-21T00:00:00Z", obligation_total: 2, submitted_count: 1,
    not_started_count: 1, draft_count: 0, exempted_count: 0, cancelled_count: 0,
  };
  const repository = createAssignmentRepository(async (name, args) => {
    called = { name, args };
    return { data: { items: [item] }, error: null };
  });
  assert.deepEqual(await repository.listAssignments({ ...actor, team_id: team }), { ok: true, data: [item] });
  assert.deepEqual(called, { name: "work_report_list_assignments", args: {
    p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id, p_team_id: team,
  } });
  const malformed = createAssignmentRepository(async () => ({ data: { items: [{ ...item, submitted_count: -1 }] }, error: null }));
  assert.deepEqual(await malformed.listAssignments({ ...actor, team_id: team }), { ok: false, kind: "unavailable" });
});

test("custom report group repository methods route to dedicated RPCs and validate group directory + GROUP assignments", async () => {
  const groupId = "12121212-1212-4212-8212-121212121212";
  const memberId = "34343434-3434-4434-8434-343434343434";
  const calls = [];
  const directory = {
    scope_kind: "all",
    groups: [
      {
        group_id: groupId,
        display_name: "Nhóm Tổ trưởng",
        description: "Liên Team",
        active: true,
        version: 1,
        created_at: "2026-10-24T00:00:00Z",
        updated_at: "2026-10-24T00:00:00Z",
        assignment_count: 1,
        members: [
          {
            app_user_id: memberId,
            display_name: "Tổ trưởng A",
            enabled: true,
            team_id: team,
            team_code: "TEAM_A",
            team_display_name: "Team A",
          },
        ],
      },
    ],
    eligible_users: [
      {
        app_user_id: memberId,
        display_name: "Tổ trưởng A",
        team_id: team,
        team_code: "TEAM_A",
        team_display_name: "Team A",
      },
    ],
  };

  const repository = createAssignmentRepository(async (name, args) => {
    calls.push({ name, args });
    if (name === "work_report_list_groups") return { data: directory, error: null };
    if (name === "work_report_create_group") return { data: { group_id: groupId, version: 1 }, error: null };
    if (name === "work_report_update_group") return { data: { group_id: groupId, version: 2 }, error: null };
    if (name === "work_report_set_group_active") return { data: { group_id: groupId, active: false, version: 3 }, error: null };
    if (name === "work_report_create_group_assignment") {
      return { data: { assignment_id: "56565656-5656-4656-8656-565656565656", version: 1 }, error: null };
    }
    return { data: null, error: { code: "P0002" } };
  });

  assert.deepEqual(await repository.listGroups(actor), { ok: true, data: directory });
  assert.deepEqual(
    await repository.createGroup({
      ...actor,
      display_name: "Nhóm Tổ trưởng",
      description: "Liên Team",
      member_user_ids: [memberId],
      idempotency_key: "grp-create-1",
    }),
    { ok: true, data: { group_id: groupId, version: 1 } },
  );
  assert.deepEqual(
    await repository.updateGroup({
      ...actor,
      group_id: groupId,
      expected_version: 1,
      display_name: "Nhóm Tổ trưởng 2",
      description: null,
      member_user_ids: [memberId],
      idempotency_key: "grp-update-1",
    }),
    { ok: true, data: { group_id: groupId, version: 2 } },
  );
  assert.deepEqual(
    await repository.setGroupActive({
      ...actor,
      group_id: groupId,
      expected_version: 2,
      active: false,
      idempotency_key: "grp-deact-1",
    }),
    { ok: true, data: { group_id: groupId, active: false, version: 3 } },
  );
  assert.deepEqual(
    await repository.create({
      ...actor,
      template_id: template,
      target_kind: "GROUP",
      target_user_id: null,
      target_team_id: null,
      target_group_id: groupId,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "23:59:59",
      exclude_sundays: false,
      effective_from: "2026-10-24",
      effective_to: null,
      idempotency_key: "grp-assign-1",
    }),
    { ok: true, data: { assignment_id: "56565656-5656-4656-8656-565656565656", version: 1 } },
  );
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      "work_report_list_groups",
      "work_report_create_group",
      "work_report_update_group",
      "work_report_set_group_active",
      "work_report_create_group_assignment",
    ],
  );
});

test("assignment repository preserves specific 22023 domain error codes when present", async () => {
  const ineligibleRepo = createAssignmentRepository(async () => ({
    data: null,
    error: { code: "22023", message: "WORK_REPORT_GROUP_MEMBER_INELIGIBLE" },
  }));
  assert.deepEqual(
    await ineligibleRepo.create({
      ...actor,
      template_id: "33333333-3333-4333-8333-333333333333",
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
      idempotency_key: "grp-assign-ineligible",
    }),
    { ok: false, kind: "invalid", code: "WORK_REPORT_GROUP_MEMBER_INELIGIBLE" },
  );

  const inactiveRepo = createAssignmentRepository(async () => ({
    data: null,
    error: { code: "22023", message: "WORK_REPORT_GROUP_INACTIVE" },
  }));
  assert.deepEqual(
    await inactiveRepo.setState({
      ...actor,
      assignment_id: "77777777-7777-4777-8777-777777777777",
      expected_version: 2,
      state: "ACTIVE",
      idempotency_key: "asg-state-inactive-group",
    }),
    { ok: false, kind: "invalid", code: "WORK_REPORT_GROUP_INACTIVE" },
  );

  const assignmentInvalidRepo = createAssignmentRepository(async () => ({
    data: null,
    error: { code: "22023", message: "WORK_REPORT_ASSIGNMENT_INVALID" },
  }));
  assert.deepEqual(
    await assignmentInvalidRepo.create({
      ...actor,
      template_id: template,
      target_kind: "USER",
      target_user_id: "11111111-1111-4111-8111-111111111111",
      target_team_id: null,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "23:59:59",
      exclude_sundays: false,
      effective_from: "2026-10-20",
      effective_to: null,
      idempotency_key: "asg-invalid-date",
    }),
    { ok: false, kind: "invalid", code: "WORK_REPORT_ASSIGNMENT_INVALID" },
  );
});

test("assignment repository passes null dates when omitted across both assignment and group create RPCs", async () => {
  const calls = [];
  const repository = createAssignmentRepository(async (name, args) => {
    calls.push({ name, args });
    return {
      data: { assignment_id: "99999999-9999-4999-8999-999999999999", version: 1 },
      error: null,
    };
  });

  await repository.create({
    ...actor,
    template_id: template,
    target_kind: "USER_SET",
    target_user_id: null,
    target_team_id: null,
    target_user_ids: ["11111111-1111-4111-8111-111111111111"],
    frequency: "DAILY",
    is_mandatory: true,
    due_day_offset: 0,
    due_time_local: "23:59:59",
    exclude_sundays: false,
    idempotency_key: "dateless-user-set",
  });

  await repository.create({
    ...actor,
    template_id: template,
    target_kind: "GROUP",
    target_user_id: null,
    target_team_id: null,
    target_group_id: "12121212-1212-4212-8212-121212121212",
    target_user_ids: [],
    frequency: "WEEKLY",
    is_mandatory: true,
    due_day_offset: 1,
    due_time_local: "18:00:00",
    exclude_sundays: false,
    idempotency_key: "dateless-group",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "work_report_create_assignment");
  assert.equal(calls[0].args.p_effective_from, null);
  assert.equal(calls[0].args.p_effective_to, null);
  assert.equal(calls[1].name, "work_report_create_group_assignment");
  assert.equal(calls[1].args.p_effective_from, null);
  assert.equal(calls[1].args.p_effective_to, null);
});
