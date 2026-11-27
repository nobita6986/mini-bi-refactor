/**
 * Hotfix: Block Move & Unassign on Active or Restorable Team Leader Assignment
 * PGlite Full-Migration-Chain Database Acceptance & Cross-Module Authz Suite.
 *
 * Covers:
 *   (a) Active TL blocks Move & Unassign with PT409 and ZERO DB mutations.
 *   (b) Suspended-restorable TL (via direct_entry_disable_app_user) ALSO blocks
 *       Move & Unassign with PT409 and ZERO DB mutations; re-enable restores TL
 *       and remains blocked.
 *   (c) After revoke OR replace TL, Move & Unassign succeed, preserving membership
 *       history, independent grants, expected_version OCC checks (PT409), and
 *       Idempotency-Key replay (including across version bumps) + mismatch (22023).
 *   (d) personnel_position = 'TEAM_LEADER' label-only (no TL assignment) is NOT blocked.
 *   (e) Deactivated recruiter or deactivated team without active/restorable TL still
 *       allows close-only Unassign (direct_entry_lock_membership_close_target).
 *   (f) Cross-module end-to-end check (Work Reports + Leave + Attendance Explanations +
 *       direct_entry_resolve_actor_context): BEFORE revoke U1 views/approves R_sub in T1
 *       across all 3 modules; AFTER revoke + move(T2) AND separately revoke + unassign,
 *       direct_entry_resolve_actor_context drops T1 scope and U1/U2 has zero T1 approval
 *       access (42501 / empty inbox) across all 3 modules while independent non-TL grants
 *       remain intact.
 *   (g) RPC ACL / owner / SECURITY DEFINER / search_path / single-overload parity.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  projectAttendanceExplanationApprovalInbox,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const HF_MIGRATION_NAME = "20261126130000_hf_block_move_unassign_active_team_leader.sql";
const EXPECTED_TL_GUARD_MSG = "recruiter holds active or restorable team leader assignment";

const ROLE_PREAMBLE = `
  do $$
  begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
`;

const OWNER = {
  auth: "92000000-0000-4000-8000-00000000a001",
  app: "92000000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner HF TL",
};
const LUANPT = {
  auth: "92000000-0000-4000-8000-00000000a002",
  app: "92000000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "92000000-0000-4000-8000-00000000a003",
  app: "92000000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "92000000-0000-4000-8000-00000000a004",
  app: "92000000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `92100000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `hf_tl_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}

async function serviceQuery(db, sql, params = []) {
  await db.exec("begin; set local role service_role");
  try {
    const res = await db.query(sql, params);
    await db.exec("commit");
    return res;
  } catch (err) {
    await db.exec("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpc(db, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
  const res = await serviceQuery(db, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
}

async function serviceRpcError(db, fnName, args = [], casts = []) {
  try {
    await serviceRpc(db, fnName, args, casts);
    assert.fail(`Expected ${fnName} to reject`);
  } catch (err) {
    return err;
  }
}

async function createFullDb() {
  const db = new PGlite();
  await db.exec(ROLE_PREAMBLE);

  // Keep the legacy grant tables for history and unchanged-state assertions.
  const files = (await readdir(MIGRATION_DIR))
    .filter((f) => f.endsWith(".sql") && f <= "20261127020000_wp10_7_3c_retire_legacy_grant_mirror_and_fallback.sql")
    .sort();
  assert.ok(files.includes(HF_MIGRATION_NAME), `Missing migration ${HF_MIGRATION_NAME}`);
  const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");

  for (let i = 0; i < groupsIdx; i += 1) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }

  for (const u of [OWNER, LUANPT, LIENVU, NGATTT]) {
    await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, true, false, 1)`,
      [u.app, u.auth, u.name],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, '2026-01-01', true)`,
      [u.app],
    );
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true)`,
        [u.app, cap],
      );
    }
  }

  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  for (let i = groupsIdx; i < files.length; i += 1) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }

  return db;
}

async function seedTeam(db, code, displayName, active = true) {
  const teamId = nextUuid();
  await db.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, $2, $3, $4, 1)`,
    [teamId, code, displayName, active],
  );
  return teamId;
}

async function seedRecruitmentUser(db, recruitmentDeptId, tag, {
  teamId = null,
  personnelPosition = "STAFF",
  withLeaveProfile = false,
  validFrom = null,
} = {}) {
  const auth = nextUuid();
  const app = nextUuid();
  const email = `${tag}@hrpartner.vn`;
  const name = `User ${tag}`;
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [app, auth, name],
  );

  const empCode = `EMP-${tag.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  const personRes = await serviceRpc(
    db,
    "org_department_create_person_admin",
    [
      OWNER.auth,
      OWNER.app,
      empCode,
      name,
      "2025-01-01",
      recruitmentDeptId,
      app,
      1,
      null,
      `Onboard ${tag}`,
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: empCode,
        full_name: name,
        joined_on: "2025-01-01",
        initial_department_ref: recruitmentDeptId,
        account_ref: app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: `Onboard ${tag}`,
      }),
    ],
    ["uuid", "uuid", "text", "text", "date", "uuid", "uuid", "int", "uuid", "text", "uuid", "text"],
  );

  const accVer = personRes.person.active_account_link.account_version;
  const recruiterRes = await serviceRpc(
    db,
    "direct_entry_account_operation_create_personnel",
    [
      OWNER.auth,
      OWNER.app,
      app,
      accVer,
      tag,
      personnelPosition,
      validFrom,
      `Create recruiter ${tag}`,
      nextKey(`rec_${tag}`),
    ],
    ["uuid", "uuid", "uuid", "int", "text", "text", "date", "text", "text"],
  );
  const recruiterId = recruiterRes.recruiter_id;

  if (teamId) {
    await serviceRpc(
      db,
      "direct_entry_assign_team_membership",
      [OWNER.auth, OWNER.app, recruiterId, teamId, validFrom, 1, `Assign ${tag} to team`, nextKey(`asg_${tag}`)],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
  }

  if (withLeaveProfile) {
    await serviceRpc(
      db,
      "leave_management_upsert_employee_profile_admin",
      [
        OWNER.auth,
        OWNER.app,
        app,
        "OFFICIAL",
        null,
        "2025-01-01",
        "2025-03-01",
        null,
        0,
        0,
        `Leave profile ${tag}`,
        `prof-${tag}-${seq++}`,
        sha256(`prof-${tag}-${seq}`),
      ],
    );
  }

  return { auth, app, recruiterId, personId: personRes.person.person_id, email, name };
}

async function snapshotMutationState(db, recruiterId, appUserId) {
  const { rows: [counts] } = await db.query(
    `select
       (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid) as membership_count,
       (select version from public.recruiters where recruiter_id = $1::uuid) as recruiter_version,
       (select count(*)::int from public.direct_entry_team_membership_revisions where recruiter_id = $1::uuid) as revision_count,
       (select count(*)::int from public.direct_entry_audit_events where resource_ref = $1::text) as audit_count,
       (select count(*)::int from public.direct_entry_restricted_reasons) as reason_count,
       (select count(*)::int from public.direct_entry_rpc_idempotency where action in ('team_membership_move', 'team_membership_unassign')) as idempotency_count,
       (select count(*)::int from public.direct_entry_team_leader_assignments where leader_recruiter_id = $1::uuid) as tl_count,
       (select count(*)::int from public.direct_entry_scope_grants where app_user_id = $2::uuid) as scope_count,
       (select count(*)::int from public.direct_entry_capability_grants where app_user_id = $2::uuid) as cap_count`,
    [recruiterId, appUserId],
  );
  const { rows: memberships } = await db.query(
    `select membership_id, team_id, valid_from::text, valid_to::text, is_current
       from public.recruiter_team_memberships
      where recruiter_id = $1::uuid
      order by valid_from, membership_id`,
    [recruiterId],
  );
  return { counts, memberships };
}

async function grantIndependentNonTlGroup(db, deptId, users, groupCode) {
  const grpRes = await serviceRpc(
    db,
    "direct_entry_authz_create_group_admin",
    [
      OWNER.auth,
      OWNER.app,
      groupCode,
      `Independent ${groupCode}`,
      "Non-TL independent permission group",
      deptId,
      null,
      ["catalog_master_manage"],
      JSON.stringify([]),
      "Create independent non-TL group",
      nextUuid(),
      sha256(`grp-${groupCode}`),
    ],
    ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
  );
  const { rows: [grpRow] } = await db.query(
    "select group_id from public.authz_user_groups where code = $1",
    [groupCode],
  );
  const groupId = grpRes.group?.group_id ?? grpRes.group_id ?? grpRow?.group_id;
  assert.ok(groupId, `Group ${groupCode} must exist`);
  for (const user of users) {
    const { rows: [accRow] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [user.app],
    );
    await serviceRpc(
      db,
      "direct_entry_authz_assign_group_member_admin",
      [
        OWNER.auth,
        OWNER.app,
        user.app,
        groupId,
        accRow.version,
        "Assign independent non-TL group",
        nextUuid(),
        sha256(`grp-mem-${groupCode}-${user.app}`),
      ],
      ["uuid", "uuid", "uuid", "uuid", "int", "text", "uuid", "text"],
    );
  }
  return groupId;
}

test("HF [1/4]: Active & suspended-restorable TL block Move & Unassign with PT409 and ZERO DB mutations; revoke/replace allow Move & Unassign with history, OCC & idempotency", async () => {
  const db = await createFullDb();
  try {
    const { rows: [recDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );
    const { rows: [{ today }] } = await db.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const t1 = await seedTeam(db, "HF_T1", "Hotfix Team 1");
    const t2 = await seedTeam(db, "HF_T2", "Hotfix Team 2");

    const u1 = await seedRecruitmentUser(db, recDept.department_id, "u1", { teamId: t1 });
    const uRep = await seedRecruitmentUser(db, recDept.department_id, "urep", { teamId: t1 });

    // Grant U1 an independent non-TL Permission Group (must survive revoke + move/unassign)
    const indGroupId = await grantIndependentNonTlGroup(db, recDept.department_id, [u1], "HF_INDEP_T1");

    // Designate U1 as TL of T1
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, u1.app, today, 1, "Designate U1 as T1 TL", nextKey("des_u1")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    // (a) Active TL blocks Move & Unassign with PT409 and ZERO DB mutations
    const snapBeforeA = await snapshotMutationState(db, u1.recruiterId, u1.app);
    const moveErrA = await serviceRpcError(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, snapBeforeA.counts.recruiter_version, "Try move active TL", nextKey("mv_blk_a")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(moveErrA.code, "PT409");
    assert.equal(moveErrA.message, EXPECTED_TL_GUARD_MSG);

    const unassignErrA = await serviceRpcError(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, today, snapBeforeA.counts.recruiter_version, "Try unassign active TL", nextKey("un_blk_a")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassignErrA.code, "PT409");
    assert.equal(unassignErrA.message, EXPECTED_TL_GUARD_MSG);

    const snapAfterA = await snapshotMutationState(db, u1.recruiterId, u1.app);
    assert.deepEqual(snapAfterA, snapBeforeA, "(a) Blocked Move & Unassign must leave ZERO DB mutations");

    // (b) Suspended-restorable TL via direct_entry_disable_app_user ALSO blocks Move & Unassign with PT409 and ZERO DB mutations
    const { rows: [u1AccBeforeDis] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [u1.app],
    );
    await serviceRpc(
      db,
      "direct_entry_disable_app_user",
      [OWNER.auth, OWNER.app, u1.app, u1AccBeforeDis.version, "Disable U1 while TL", nextKey("dis_u1")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );
    const { rows: [tlaSuspended] } = await db.query(
      `select is_current, suspended_by_account_disable, valid_to
         from public.direct_entry_team_leader_assignments
        where leader_app_user_id = $1::uuid and team_id = $2::uuid`,
      [u1.app, t1],
    );
    assert.deepEqual(tlaSuspended, {
      is_current: false,
      suspended_by_account_disable: true,
      valid_to: null,
    });

    const snapBeforeB = await snapshotMutationState(db, u1.recruiterId, u1.app);
    const moveErrB = await serviceRpcError(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, snapBeforeB.counts.recruiter_version, "Try move suspended TL", nextKey("mv_blk_b")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(moveErrB.code, "PT409");
    assert.equal(moveErrB.message, EXPECTED_TL_GUARD_MSG);

    const unassignErrB = await serviceRpcError(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, today, snapBeforeB.counts.recruiter_version, "Try unassign suspended TL", nextKey("un_blk_b")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassignErrB.code, "PT409");
    assert.equal(unassignErrB.message, EXPECTED_TL_GUARD_MSG);

    const snapAfterB = await snapshotMutationState(db, u1.recruiterId, u1.app);
    assert.deepEqual(snapAfterB, snapBeforeB, "(b) Blocked Move & Unassign on suspended-restorable TL must leave ZERO DB mutations");

    // Re-enable U1 -> TL restored -> still blocked until revoked/replaced
    const { rows: [u1AccBeforeEn] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [u1.app],
    );
    await serviceRpc(
      db,
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, u1.app, u1AccBeforeEn.version, "Re-enable U1", nextKey("en_u1")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );

    // (c1) After REVOKE TL -> Move succeeds, OCC checks work, Idempotency-Key replay works, history & independent grants preserved
    const { rows: [t1VerRev] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, t1, today, t1VerRev.version, "Revoke U1 before move", nextKey("rev_u1")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    const { rows: [recVerMove] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [u1.recruiterId]);
    // Stale expected_version -> PT409 recruiter version conflict (NOT active-team-leader)
    const staleMoveErr = await serviceRpcError(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, recVerMove.version + 99, "Stale move", nextKey("mv_stale")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(staleMoveErr.code, "PT409");
    assert.notEqual(staleMoveErr.message, EXPECTED_TL_GUARD_MSG);

    const moveKey = nextKey("mv_ok");
    const moved = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, recVerMove.version, "Move U1 after revoke", moveKey],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(moved.change, "MOVE");
    assert.equal(moved.team_id, t2);
    assert.equal(moved.recruiter_version, recVerMove.version + 1);

    // Idempotency replay with old expected_version returns cached result; different payload rejects 22023
    const moveReplay = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, recVerMove.version, "Move U1 after revoke", moveKey],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.deepEqual(moveReplay, moved);

    const moveMismatchErr = await serviceRpcError(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t1, today, recVerMove.version, "Move mismatch", moveKey],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(moveMismatchErr.code, "22023");

    // History preserved + independent grant preserved
    const { rows: memHistory } = await db.query(
      `select team_id, valid_from::text, valid_to::text, is_current
         from public.recruiter_team_memberships
        where recruiter_id = $1::uuid
        order by valid_from, is_current asc, created_at`,
      [u1.recruiterId],
    );
    assert.equal(memHistory.length, 2);
    assert.equal(memHistory[0].team_id, t1);
    assert.equal(memHistory[0].valid_to, today);
    assert.equal(memHistory[0].is_current, false);
    assert.equal(memHistory[1].team_id, t2);
    assert.equal(memHistory[1].valid_to, null);
    assert.equal(memHistory[1].is_current, true);

    const { rows: indGrants } = await db.query(
      `select group_id
         from public.authz_user_group_members
        where app_user_id = $1::uuid and ended_at is null`,
      [u1.app],
    );
    assert.ok(indGrants.some((g) => g.group_id === indGroupId), "Independent non-TL group membership preserved");

    // Unassign U1 after move: stale expected_version -> PT409, valid -> succeeds, replay -> cached
    const staleUnassignErr = await serviceRpcError(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, today, moved.recruiter_version - 1, "Stale unassign", nextKey("un_stale")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(staleUnassignErr.code, "PT409");
    assert.notEqual(staleUnassignErr.message, EXPECTED_TL_GUARD_MSG);

    const unassignKey = nextKey("un_ok");
    const unassigned = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, today, moved.recruiter_version, "Unassign U1 after move", unassignKey],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassigned.recruiter_version, moved.recruiter_version + 1);
    const unassignReplay = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, today, moved.recruiter_version, "Unassign U1 after move", unassignKey],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.deepEqual(unassignReplay, unassigned);

    // (c2) After REPLACE TL -> replaced leader can Move & Unassign cleanly
    const u1b = await seedRecruitmentUser(db, recDept.department_id, "u1b", { teamId: t1 });
    const u1c = await seedRecruitmentUser(db, recDept.department_id, "u1c", { teamId: t1 });
    const { rows: [t1VerRep1] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, u1b.app, today, t1VerRep1.version, "Designate U1b on T1", nextKey("des_u1b")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const { rows: [t1VerRep2] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, uRep.app, today, t1VerRep2.version, "Replace U1b with URep on T1", nextKey("rep_urep")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    // U1b was replaced -> Move succeeds
    const { rows: [u1bVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [u1b.recruiterId]);
    const movedU1b = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1b.recruiterId, t2, today, u1bVer.version, "Move replaced TL U1b", nextKey("mv_u1b")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(movedU1b.change, "MOVE");

    // Replace URep with U1c, then revoke U1c and designate U1c? Better: replace URep with U1c -> URep can Unassign!
    const { rows: [t1VerRep3] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, u1c.app, today, t1VerRep3.version, "Replace URep with U1c on T1", nextKey("rep_u1c")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const { rows: [uRepVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [uRep.recruiterId]);
    const unassignedURep = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, uRep.recruiterId, today, uRepVer.version, "Unassign replaced TL URep", nextKey("un_urep")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassignedURep.team_id, t1);
  } finally {
    await db.close();
  }
});

test("HF [2/4]: Label-only personnel_position='TEAM_LEADER' is NOT blocked; deactivated recruiter or deactivated team still allows close-only Unassign", async () => {
  const db = await createFullDb();
  try {
    const { rows: [recDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );
    const { rows: [{ today }] } = await db.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const t1 = await seedTeam(db, "HF_LBL_T1", "Label Team 1");
    const t2 = await seedTeam(db, "HF_LBL_T2", "Label Team 2");
    const tInact = await seedTeam(db, "HF_INACT_T", "Soon Inactive Team");

    // (d) personnel_position = 'TEAM_LEADER' label-only (no TL assignment) -> Move & Unassign NOT blocked
    const labelMove = await seedRecruitmentUser(db, recDept.department_id, "lbl_mv", {
      teamId: t1,
      personnelPosition: "TEAM_LEADER",
    });
    const labelUnassign = await seedRecruitmentUser(db, recDept.department_id, "lbl_un", {
      teamId: t1,
      personnelPosition: "TEAM_LEADER",
    });

    const { rows: [lblMvVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [labelMove.recruiterId]);
    const mvLabelRes = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, labelMove.recruiterId, t2, today, lblMvVer.version, "Move label-only TL", nextKey("mv_lbl")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(mvLabelRes.change, "MOVE");

    const { rows: [lblUnVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [labelUnassign.recruiterId]);
    const unLabelRes = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, labelUnassign.recruiterId, today, lblUnVer.version, "Unassign label-only TL", nextKey("un_lbl")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.ok(["CANCEL", "UNASSIGN"].includes(unLabelRes.change));
    assert.equal(unLabelRes.valid_to, today);

    // (e1) Deactivated recruiter (no TL assignment) -> close-only Unassign succeeds
    const recInact = await seedRecruitmentUser(db, recDept.department_id, "rec_inact", { teamId: t1 });
    await db.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [recInact.recruiterId]);
    const { rows: [recInactVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [recInact.recruiterId]);
    const unInactRecRes = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, recInact.recruiterId, today, recInactVer.version, "Close membership of inactive recruiter", nextKey("un_inact_rec")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.ok(["CANCEL", "UNASSIGN"].includes(unInactRecRes.change));
    assert.equal(unInactRecRes.valid_to, today);

    // (e2) Deactivated team (no TL assignment) -> close-only Unassign succeeds
    const teamInactRec = await seedRecruitmentUser(db, recDept.department_id, "team_inact_rec", { teamId: tInact });
    await db.query("update public.teams set active = false where team_id = $1::uuid", [tInact]);
    const { rows: [teamInactRecVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [teamInactRec.recruiterId]);
    const unInactTeamRes = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, teamInactRec.recruiterId, today, teamInactRecVer.version, "Close membership in inactive team", nextKey("un_inact_team")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.ok(["CANCEL", "UNASSIGN"].includes(unInactTeamRes.change));
    assert.equal(unInactTeamRes.valid_to, today);
  } finally {
    await db.close();
  }
});

test("HF [3/4]: Cross-module end-to-end (Work Reports + Leave + Attendance Explanations + actor context) BEFORE revoke vs AFTER revoke+move(T2) & revoke+unassign", async () => {
  const db = await createFullDb();
  try {
    const { rows: [recDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );
    const { rows: [{ today, today_vn: todayVn, yesterday_vn: yesterdayVn, d1, d2, d3 }] } = await db.query(
      `select public.direct_entry_authorization_date()::text as today,
              (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1)::text as yesterday_vn,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 2)::text as d1,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 4)::text as d2,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 6)::text as d3`,
    );

    const t1 = await seedTeam(db, "HF_XM_T1", "Cross-Module Team 1");
    const t2 = await seedTeam(db, "HF_XM_T2", "Cross-Module Team 2");

    const u1 = await seedRecruitmentUser(db, recDept.department_id, "xm_u1", { teamId: t1 });
    const u2 = await seedRecruitmentUser(db, recDept.department_id, "xm_u2", { teamId: t1 });
    const rSub = await seedRecruitmentUser(db, recDept.department_id, "xm_sub", {
      teamId: t1,
      withLeaveProfile: true,
    });

    // Give U1 and U2 an independent non-TL Permission Group (catalog_master_manage @ ALL) that MUST survive TL revoke + move/unassign
    await grantIndependentNonTlGroup(db, recDept.department_id, [u1, u2], "HF_INDEP_XM");

    // Designate U1 as T1 Team Leader
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, u1.app, today, 1, "Designate U1 TL of T1", nextKey("xm_des_u1")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    // Seed 3 published Work Report templates assigned to T1 so R_sub has ob1 (before), ob2 (after revoke+move), ob3 (after revoke+unassign)
    const schema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
    const metrics = buildWorkReportMetricContract(schema);
    async function createAssignSubmit(code) {
      const created = await serviceRpc(
        db,
        "work_report_create_template",
        [OWNER.auth, OWNER.app, code, code, `Template ${code}`, "DAILY", JSON.stringify(schema), JSON.stringify(metrics), nextKey(`tpl_${code}`)],
        ["uuid", "uuid", "text", "text", "text", "text", "jsonb", "jsonb", "text"],
      );
      await db.query(
        "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
        [created.draft_version_id],
      );
      await serviceRpc(
        db,
        "work_report_publish_template",
        [OWNER.auth, OWNER.app, created.template_id, created.draft_version_id, created.version, nextKey(`pub_${code}`)],
        ["uuid", "uuid", "uuid", "uuid", "int", "text"],
      );
      await serviceRpc(
        db,
        "work_report_create_assignment",
        [OWNER.auth, OWNER.app, created.template_id, "TEAM", null, t1, null, "DAILY", true, 0, "23:59:59", false, todayVn, null, nextKey(`asg_${code}`)],
        ["uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]", "text", "boolean", "int", "time", "boolean", "date", "date", "text"],
      );
      const { rows: [obRow] } = await db.query(
        "select obligation_id from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid",
        [created.template_id, rSub.app],
      );
      const sub = await serviceRpc(
        db,
        "work_report_submit",
        [rSub.auth, rSub.app, obRow.obligation_id, JSON.stringify({ calls_made: 5, interested_candidates: 2, workers_started: 1, notes: null }), null, nextKey(`sub_${code}`)],
        ["uuid", "uuid", "uuid", "jsonb", "int", "text"],
      );
      return { obligationId: obRow.obligation_id, submissionVersion: sub.version };
    }

    const wr1 = await createAssignSubmit("HF_WR_1");
    const wr2 = await createAssignSubmit("HF_WR_2");
    const wr3 = await createAssignSubmit("HF_WR_3");

    // -------------------------------------------------------------------------
    // BEFORE REVOKE: U1 has T1 scope in actor context & views/approves R_sub in all 3 modules
    // -------------------------------------------------------------------------
    const { rows: [{ ctx: u1CtxBefore }] } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [u1.auth],
    );
    assert.ok(
      u1CtxBefore.team_scope_grants.some((s) => s.team_id === t1),
      "BEFORE revoke: U1 actor context includes T1 team_scope_grants",
    );
    assert.ok(
      u1CtxBefore.effective_grants.some((g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === t1),
      "BEFORE revoke: U1 effective_grants includes report_review @ CONTEXT_TEAM(T1)",
    );

    // Work Reports: U1 sees wr1, gets review detail, approves wr1
    const wrPendingBefore = await serviceRpc(db, "work_report_list_pending_reviews", [u1.auth, u1.app, null, null, 50]);
    assert.ok(wrPendingBefore.items.some((i) => i.obligation_id === wr1.obligationId));
    const wrDetailBefore = await serviceRpc(db, "work_report_get_review_submission", [u1.auth, u1.app, wr1.obligationId]);
    assert.equal(wrDetailBefore.obligation.obligation_id, wr1.obligationId);
    const wrDecidedBefore = await serviceRpc(
      db,
      "work_report_decide_review",
      [u1.auth, u1.app, wr1.obligationId, "APPROVED", null, wr1.submissionVersion, nextKey("wr1_app")],
    );
    assert.equal(wrDecidedBefore.state, "APPROVED");

    // Leave: R_sub creates L1 -> routes to U1 -> U1 sees & approves L1
    const l1 = await serviceRpc(db, "leave_management_create_request", [
      rSub.auth,
      rSub.app,
      JSON.stringify([{ leave_date: d1, session_code: "AM", leave_type: "UNPAID" }]),
      "Leave 1 before revoke",
      `l1-${seq++}`,
      sha256("l1"),
    ]);
    assert.equal(l1.request.route_kind, "TEAM_LEADER");
    assert.equal(l1.request.primary_approver_app_user_id, u1.app);
    const leaveInboxBefore = await serviceRpc(db, "leave_management_list_approval_inbox", [u1.auth, u1.app, "PENDING", 50, 0]);
    assert.ok(leaveInboxBefore.items.some((i) => i.request_id === l1.request.request_id));
    const l1Approved = await serviceRpc(db, "leave_management_decide_request", [
      u1.auth,
      u1.app,
      l1.request.request_id,
      "APPROVE",
      1,
      "U1 approves L1 before revoke",
      `l1-app-${seq++}`,
      sha256("l1-app"),
    ]);
    assert.equal(l1Approved.request.status, "APPROVED");

    // Attendance Explanations: R_sub creates E1 -> routes to U1 -> U1 sees & approves E1
    const e1Raw = await serviceRpc(db, "attendance_submit_explanation", [
      rSub.auth,
      rSub.app,
      yesterdayVn,
      "SLOT_1",
      "Explanation 1 before revoke",
      nextUuid(),
      sha256("e1"),
    ]);
    const e1 = projectSubmitAttendanceExplanationResult(e1Raw);
    assert.equal(e1.explanation.route_kind, "TEAM_LEADER");
    assert.equal(e1.explanation.primary_approver?.app_user_id, u1.app);
    const expInboxBefore = projectAttendanceExplanationApprovalInbox(
      await serviceRpc(db, "attendance_list_explanation_approval_inbox", [u1.auth, u1.app, "PENDING", 50, 0]),
    );
    assert.ok(expInboxBefore.items.some((i) => i.explanation_id === e1.explanation.explanation_id));
    const e1Approved = await serviceRpc(db, "attendance_decide_explanation", [
      u1.auth,
      u1.app,
      e1.explanation.explanation_id,
      "APPROVE",
      1,
      "U1 approves E1 before revoke",
      nextUuid(),
      sha256("e1-app"),
    ]);
    assert.equal(e1Approved.explanation.status, "APPROVED");

    // -------------------------------------------------------------------------
    // AFTER REVOKE + MOVE(T2): U1 drops T1 scope, loses all T1 access in all 3 modules, keeps non-TL grants
    // -------------------------------------------------------------------------
    const { rows: [t1Ver1] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, t1, today, t1Ver1.version, "Revoke U1 before move to T2", nextKey("xm_rev_u1")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const { rows: [u1RecVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [u1.recruiterId]);
    await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, u1.recruiterId, t2, today, u1RecVer.version, "Move U1 to T2", nextKey("xm_mv_u1")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    const { rows: [{ ctx: u1CtxAfter }] } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [u1.auth],
    );
    const u1ResolvedAfter = await resolveActor({
      session: { auth_subject: u1.auth, provider: "supabase", authenticated_at: "2026-11-26T00:00:00.000Z" },
      repository: { loadByAuthSubject: async () => u1CtxAfter },
      at: "2026-11-26T00:00:00.000Z",
    });
    assert.equal(u1ResolvedAfter.ok, true);
    assert.equal(u1CtxAfter.team_scope_grants.some((s) => s.team_id === t1), false, "AFTER revoke+move: T1 dropped from team_scope_grants");
    assert.equal(
      u1CtxAfter.effective_grants.some((g) => g.scope_kind === "CONTEXT_TEAM" && g.scope_id === t1),
      false,
      "AFTER revoke+move: T1 dropped from effective_grants",
    );
    assert.ok(
      u1CtxAfter.effective_grants.some((g) => g.capability === "catalog_master_manage" && g.scope_kind === "ALL"),
      "AFTER revoke+move: independent non-TL grant catalog_master_manage@ALL preserved",
    );

    // Work Reports denied for U1 on wr2
    const wrListErrAfterMove = await serviceRpcError(db, "work_report_list_pending_reviews", [u1.auth, u1.app, null, null, 50]);
    assert.equal(wrListErrAfterMove.code, "42501");
    const wrGetErrAfterMove = await serviceRpcError(db, "work_report_get_review_submission", [u1.auth, u1.app, wr2.obligationId]);
    assert.equal(wrGetErrAfterMove.code, "42501");
    const wrDecErrAfterMove = await serviceRpcError(
      db,
      "work_report_decide_review",
      [u1.auth, u1.app, wr2.obligationId, "APPROVED", null, wr2.submissionVersion, nextKey("wr2_deny")],
    );
    assert.equal(wrDecErrAfterMove.code, "42501");

    // Leave: R_sub creates L2 (routes to fallback) -> U1 has is_team_leader=false, inbox denied (42501) & cannot decide L2
    const u1LeaveSummaryAfterMove = await serviceRpc(db, "leave_management_get_my_summary", [u1.auth, u1.app, 2026]);
    assert.equal(u1LeaveSummaryAfterMove.authority.is_team_leader, false);
    assert.equal(u1LeaveSummaryAfterMove.authority.can_approve_requests, false);
    const l2 = await serviceRpc(db, "leave_management_create_request", [
      rSub.auth,
      rSub.app,
      JSON.stringify([{ leave_date: d2, session_code: "AM", leave_type: "UNPAID" }]),
      "Leave 2 after revoke+move",
      `l2-${seq++}`,
      sha256("l2"),
    ]);
    assert.equal(l2.request.route_kind, "ADMIN_BOD_FALLBACK");
    const leaveInboxErrAfterMove = await serviceRpcError(db, "leave_management_list_approval_inbox", [u1.auth, u1.app, "PENDING", 50, 0]);
    assert.equal(leaveInboxErrAfterMove.code, "42501");
    const l2DenyErr = await serviceRpcError(db, "leave_management_decide_request", [
      u1.auth,
      u1.app,
      l2.request.request_id,
      "APPROVE",
      1,
      "U1 denied after revoke+move",
      `l2-deny-${seq++}`,
      sha256("l2-deny"),
    ]);
    assert.equal(l2DenyErr.code, "42501");

    // Attendance Explanations: R_sub creates E2 -> U1 inbox denied (42501) & cannot decide E2
    const e2Raw = await serviceRpc(db, "attendance_submit_explanation", [
      rSub.auth,
      rSub.app,
      yesterdayVn,
      "SLOT_2",
      "Explanation 2 after revoke+move",
      nextUuid(),
      sha256("e2"),
    ]);
    const e2 = projectSubmitAttendanceExplanationResult(e2Raw);
    assert.equal(e2.explanation.route_kind, "ADMIN_BOD_FALLBACK");
    const expInboxErrAfterMove = await serviceRpcError(db, "attendance_list_explanation_approval_inbox", [u1.auth, u1.app, "PENDING", 50, 0]);
    assert.equal(expInboxErrAfterMove.code, "42501");
    const e2DenyErr = await serviceRpcError(db, "attendance_decide_explanation", [
      u1.auth,
      u1.app,
      e2.explanation.explanation_id,
      "APPROVE",
      1,
      "U1 denied after revoke+move",
      nextUuid(),
      sha256("e2-deny"),
    ]);
    assert.equal(e2DenyErr.code, "42501");

    // -------------------------------------------------------------------------
    // SEPARATE UNASSIGN PATH: Designate U2 on T1 -> verify U2 has access -> revoke + unassign(U2) -> U2 loses all T1 access, keeps non-TL grants
    // -------------------------------------------------------------------------
    const { rows: [t1Ver2] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t1, u2.app, today, t1Ver2.version, "Designate U2 TL of T1", nextKey("xm_des_u2")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const wrPendingU2Before = await serviceRpc(db, "work_report_list_pending_reviews", [u2.auth, u2.app, null, null, 50]);
    assert.ok(wrPendingU2Before.items.some((i) => i.obligation_id === wr3.obligationId));

    const { rows: [t1Ver3] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    await serviceRpc(
      db,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, t1, today, t1Ver3.version, "Revoke U2 before unassign", nextKey("xm_rev_u2")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const { rows: [u2RecVer] } = await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [u2.recruiterId]);
    await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, u2.recruiterId, today, u2RecVer.version, "Unassign U2 from T1", nextKey("xm_un_u2")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    const { rows: [{ ctx: u2CtxAfter }] } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [u2.auth],
    );
    assert.equal(u2CtxAfter.team_scope_grants.some((s) => s.team_id === t1), false, "AFTER revoke+unassign: T1 dropped from team_scope_grants");
    assert.equal(
      u2CtxAfter.effective_grants.some((g) => g.scope_kind === "CONTEXT_TEAM" && g.scope_id === t1),
      false,
      "AFTER revoke+unassign: T1 dropped from effective_grants",
    );
    assert.ok(
      u2CtxAfter.effective_grants.some((g) => g.capability === "catalog_master_manage" && g.scope_kind === "ALL"),
      "AFTER revoke+unassign: independent non-TL grant catalog_master_manage@ALL preserved",
    );

    // Work Reports denied for U2 on wr3
    const wrListErrAfterUnassign = await serviceRpcError(db, "work_report_list_pending_reviews", [u2.auth, u2.app, null, null, 50]);
    assert.equal(wrListErrAfterUnassign.code, "42501");
    const wrGetErrAfterUnassign = await serviceRpcError(db, "work_report_get_review_submission", [u2.auth, u2.app, wr3.obligationId]);
    assert.equal(wrGetErrAfterUnassign.code, "42501");
    const wrDecErrAfterUnassign = await serviceRpcError(
      db,
      "work_report_decide_review",
      [u2.auth, u2.app, wr3.obligationId, "APPROVED", null, wr3.submissionVersion, nextKey("wr3_deny")],
    );
    assert.equal(wrDecErrAfterUnassign.code, "42501");

    // Leave: R_sub creates L3 -> U2 has is_team_leader=false, inbox denied (42501) & cannot decide L3
    const u2LeaveSummaryAfterUnassign = await serviceRpc(db, "leave_management_get_my_summary", [u2.auth, u2.app, 2026]);
    assert.equal(u2LeaveSummaryAfterUnassign.authority.is_team_leader, false);
    assert.equal(u2LeaveSummaryAfterUnassign.authority.can_approve_requests, false);
    const l3 = await serviceRpc(db, "leave_management_create_request", [
      rSub.auth,
      rSub.app,
      JSON.stringify([{ leave_date: d3, session_code: "AM", leave_type: "UNPAID" }]),
      "Leave 3 after revoke+unassign",
      `l3-${seq++}`,
      sha256("l3"),
    ]);
    assert.equal(l3.request.route_kind, "ADMIN_BOD_FALLBACK");
    const leaveInboxErrAfterUnassign = await serviceRpcError(db, "leave_management_list_approval_inbox", [u2.auth, u2.app, "PENDING", 50, 0]);
    assert.equal(leaveInboxErrAfterUnassign.code, "42501");
    const l3DenyErr = await serviceRpcError(db, "leave_management_decide_request", [
      u2.auth,
      u2.app,
      l3.request.request_id,
      "APPROVE",
      1,
      "U2 denied after revoke+unassign",
      `l3-deny-${seq++}`,
      sha256("l3-deny"),
    ]);
    assert.equal(l3DenyErr.code, "42501");

    // Attendance Explanations: R_sub creates E3 -> U2 inbox denied (42501) & cannot decide E3
    const e3Raw = await serviceRpc(db, "attendance_submit_explanation", [
      rSub.auth,
      rSub.app,
      yesterdayVn,
      "SLOT_3",
      "Explanation 3 after revoke+unassign",
      nextUuid(),
      sha256("e3"),
    ]);
    const e3 = projectSubmitAttendanceExplanationResult(e3Raw);
    assert.equal(e3.explanation.route_kind, "ADMIN_BOD_FALLBACK");
    const expInboxErrAfterUnassign = await serviceRpcError(db, "attendance_list_explanation_approval_inbox", [u2.auth, u2.app, "PENDING", 50, 0]);
    assert.equal(expInboxErrAfterUnassign.code, "42501");
    const e3DenyErr = await serviceRpcError(db, "attendance_decide_explanation", [
      u2.auth,
      u2.app,
      e3.explanation.explanation_id,
      "APPROVE",
      1,
      "U2 denied after revoke+unassign",
      nextUuid(),
      sha256("e3-deny"),
    ]);
    assert.equal(e3DenyErr.code, "42501");
  } finally {
    await db.close();
  }
});

test("HF [4/4]: RPC ACL / owner / SECURITY DEFINER / search_path / single-overload parity", async () => {
  const db = await createFullDb();
  try {
    const { rows: [baseOwner] } = await db.query(
      "select relowner from pg_catalog.pg_class where oid = 'public.direct_entry_app_users'::pg_catalog.regclass",
    );
    const expectedSigs = [
      {
        name: "direct_entry_move_team_membership",
        sig: "public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)",
        dummyCall: "select public.direct_entry_move_team_membership(null, null, null, null, null, null, null, null)",
      },
      {
        name: "direct_entry_unassign_team_membership",
        sig: "public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)",
        dummyCall: "select public.direct_entry_unassign_team_membership(null, null, null, null, null, null, null)",
      },
      {
        name: "direct_entry_list_team_leaders_suspended",
        sig: "public.direct_entry_list_team_leaders_suspended(uuid, uuid, uuid, text, integer, integer)",
        dummyCall: "select public.direct_entry_list_team_leaders_suspended(null, null, null, null, 1, 25)",
      },
    ];

    for (const item of expectedSigs) {
      const { rows } = await db.query(
        `select p.oid::regprocedure::text as sig,
                p.proowner,
                p.prosecdef,
                p.proconfig,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
                (select count(*)::int
                   from pg_catalog.pg_proc p2
                   join pg_catalog.pg_namespace n2 on n2.oid = p2.pronamespace
                  where n2.nspname = 'public' and p2.proname = p.proname) as overload_count
           from pg_catalog.pg_proc p
          where p.oid = $1::regprocedure`,
        [item.sig],
      );
      assert.equal(rows.length, 1, `${item.sig} must exist`);
      const row = rows[0];
      assert.equal(row.overload_count, 1, `${item.name} must have single overload`);
      assert.equal(row.proowner, baseOwner.relowner, `${item.name} owner must match direct_entry_app_users`);
      assert.equal(row.prosecdef, true, `${item.name} must be SECURITY DEFINER`);
      assert.ok(
        Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"),
        `${item.name} must pin search_path=pg_catalog, public`,
      );
      assert.equal(row.pub_exec, false, `${item.name} PUBLIC execute denied`);
      assert.equal(row.anon_exec, false, `${item.name} anon execute denied`);
      assert.equal(row.auth_exec, false, `${item.name} authenticated execute denied`);
      assert.equal(row.svc_exec, true, `${item.name} service_role execute granted`);

      for (const role of ["anon", "authenticated"]) {
        await assert.rejects(
          async () => {
            await db.exec(`begin; set local role ${role};`);
            try {
              await db.query(item.dummyCall);
              await db.exec("commit;");
            } catch (err) {
              await db.exec("rollback;");
              throw err;
            }
          },
          (err) => err.code === "42501",
          `${role} must be rejected executing ${item.name}`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

test("HF [5/6]: Suspended TL flow: disable -> Move/Unassign blocked -> list suspended (current unchanged) -> revoke without replacement (account stays disabled) -> Move & Unassign succeed", async () => {
  const db = await createFullDb();
  try {
    const { rows: [recDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );
    const { rows: [{ today }] } = await db.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const t1 = await seedTeam(db, "HF_S1", "Suspended Flow Team 1");
    const t2 = await seedTeam(db, "HF_S2", "Suspended Flow Team 2");
    const uMove = await seedRecruitmentUser(db, recDept.department_id, "sus_move", { teamId: t1 });
    const uUnassign = await seedRecruitmentUser(db, recDept.department_id, "sus_unassign", { teamId: t2 });
    const uUnauthorized = await seedRecruitmentUser(db, recDept.department_id, "sus_unauth", { teamId: t1 });

    // Non-same-day TL designated before today, then disabled -> Move blocked -> revoke without replacement -> Move succeeds, account stays disabled
    await db.exec(`
      update public.recruiter_provider_memberships set valid_from = ('${today}'::date - 14) where recruiter_id = '${uMove.recruiterId}';
      update public.recruiter_team_memberships set valid_from = ('${today}'::date - 14) where recruiter_id = '${uMove.recruiterId}';
      insert into public.direct_entry_team_leader_assignments
        (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current, suspended_by_account_disable)
      values
        ('${t1}', '${uMove.app}', '${uMove.recruiterId}', ('${today}'::date - 7), null, true, false);
    `);

    const { rows: [uMoveAccVer] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uMove.app],
    );
    await serviceRpc(
      db,
      "direct_entry_disable_app_user",
      [OWNER.auth, OWNER.app, uMove.app, uMoveAccVer.version, "Lock leader account uMove", nextKey("dis_umove")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );

    const unauthErr = await serviceRpcError(
      db,
      "direct_entry_list_team_leaders_suspended",
      [uUnauthorized.auth, uUnauthorized.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(unauthErr.code, "42501");

    const curBeforeRevoke = await serviceRpc(
      db,
      "direct_entry_list_team_leaders_current",
      [OWNER.auth, OWNER.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(curBeforeRevoke.total, 0, "CURRENT leaders list remains empty when TL is suspended");

    const susBeforeRevoke = await serviceRpc(
      db,
      "direct_entry_list_team_leaders_suspended",
      [OWNER.auth, OWNER.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(susBeforeRevoke.total, 1);
    assert.equal(susBeforeRevoke.leaders[0].state, "SUSPENDED");
    assert.equal(susBeforeRevoke.leaders[0].leader_app_user_id, uMove.app);
    assert.equal(susBeforeRevoke.leaders[0].valid_to, null);

    const { rows: [recVerMove] } = await db.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [uMove.recruiterId],
    );
    const blockedMove = await serviceRpcError(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, uMove.recruiterId, t2, today, recVerMove.version, "Move blocked by suspended TL", nextKey("mv_sus_blk")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(blockedMove.code, "PT409");
    assert.equal(blockedMove.message, EXPECTED_TL_GUARD_MSG);

    // Revoke suspended TL without replacement using existing direct_entry_revoke_team_leader
    const { rows: [t1Ver] } = await db.query("select version from public.teams where team_id = $1::uuid", [t1]);
    const revoked = await serviceRpc(
      db,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, t1, null, t1Ver.version, "Revoke suspended TL without replacement", nextKey("rev_sus_t1")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(revoked.change, "revoke");
    assert.equal(revoked.valid_to, today);

    const { rows: [uMoveAcc] } = await db.query(
      "select enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uMove.app],
    );
    assert.equal(uMoveAcc.enabled, false, "Disabled account MUST remain disabled after revoking suspended TL");

    const susAfterRevoke = await serviceRpc(
      db,
      "direct_entry_list_team_leaders_suspended",
      [OWNER.auth, OWNER.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(susAfterRevoke.total, 0);

    const curAfterRevoke = await serviceRpc(
      db,
      "direct_entry_list_team_leaders_current",
      [OWNER.auth, OWNER.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(curAfterRevoke.total, 0);

    const histAfterRevoke = await serviceRpc(
      db,
      "direct_entry_list_team_leader_history",
      [OWNER.auth, OWNER.app, t1, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(histAfterRevoke.total, 1);
    assert.equal(histAfterRevoke.leaders[0].valid_to, today);

    // Retry Move -> succeeds cleanly while account stays disabled
    const movedAfterRevoke = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, uMove.recruiterId, t2, today, recVerMove.version, "Move after suspended TL revoke", nextKey("mv_sus_ok")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(movedAfterRevoke.change, "MOVE");
    assert.equal(movedAfterRevoke.team_id, t2);

    // Same-day designate -> disable -> Unassign blocked -> revoke without replacement -> Unassign succeeds, account stays disabled
    const { rows: [t2Ver] } = await db.query("select version from public.teams where team_id = $1::uuid", [t2]);
    await serviceRpc(
      db,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, t2, uUnassign.app, today, t2Ver.version, "Designate same-day TL on T2", nextKey("des_sus_t2")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    const { rows: [uUnassignAccVer] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uUnassign.app],
    );
    await serviceRpc(
      db,
      "direct_entry_disable_app_user",
      [OWNER.auth, OWNER.app, uUnassign.app, uUnassignAccVer.version, "Lock leader account uUnassign", nextKey("dis_uunassign")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );

    const susT2 = await serviceRpc(
      db,
      "direct_entry_list_team_leaders_suspended",
      [OWNER.auth, OWNER.app, t2, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "int", "int"],
    );
    assert.equal(susT2.total, 1);
    assert.equal(susT2.leaders[0].leader_app_user_id, uUnassign.app);

    const { rows: [recVerUn] } = await db.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [uUnassign.recruiterId],
    );
    const blockedUnassign = await serviceRpcError(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, uUnassign.recruiterId, today, recVerUn.version, "Unassign blocked by suspended TL", nextKey("un_sus_blk")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(blockedUnassign.code, "PT409");
    assert.equal(blockedUnassign.message, EXPECTED_TL_GUARD_MSG);

    await serviceRpc(
      db,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, t2, null, t2Ver.version + 1, "Revoke same-day suspended TL on T2", nextKey("rev_sus_t2")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );

    const { rows: [uUnassignAcc] } = await db.query(
      "select enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uUnassign.app],
    );
    assert.equal(uUnassignAcc.enabled, false, "uUnassign MUST stay disabled after revoke");

    const unassignedAfterRevoke = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, uUnassign.recruiterId, today, recVerUn.version, "Unassign after suspended TL revoke", nextKey("un_sus_ok")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassignedAfterRevoke.team_id, t2);
  } finally {
    await db.close();
  }
});

test("HF [6/6]: Drifted suspended TL on Team A while effective membership is on Team B does NOT block Unassign(B)/Move(B->C) and re-enable does NOT restore A", async () => {
  const db = await createFullDb();
  try {
    const { rows: [recDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
    );
    const { rows: [{ today }] } = await db.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const teamA = await seedTeam(db, "HF_DR_A", "Drift Team A");
    const teamA2 = await seedTeam(db, "HF_DR_A2", "Drift Team A2");
    const teamB = await seedTeam(db, "HF_DR_B", "Drift Team B");
    const teamC = await seedTeam(db, "HF_DR_C", "Drift Team C");

    const uDrift = await seedRecruitmentUser(db, recDept.department_id, "drift_un", { teamId: teamA });
    const uDriftMove = await seedRecruitmentUser(db, recDept.department_id, "drift_mv", { teamId: teamA2 });

    await db.exec(`
      update public.recruiter_provider_memberships
         set valid_from = ('${today}'::date - 14)
       where recruiter_id in ('${uDrift.recruiterId}', '${uDriftMove.recruiterId}');
      update public.recruiter_team_memberships
         set valid_from = ('${today}'::date - 14)
       where recruiter_id in ('${uDrift.recruiterId}', '${uDriftMove.recruiterId}');

      insert into public.direct_entry_team_leader_assignments
        (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current, suspended_by_account_disable)
      values
        ('${teamA}', '${uDrift.app}', '${uDrift.recruiterId}', ('${today}'::date - 7), null, true, false),
        ('${teamA2}', '${uDriftMove.app}', '${uDriftMove.recruiterId}', ('${today}'::date - 7), null, true, false);
    `);

    // Disable both accounts (TL assignments on A / A2 become suspended_by_account_disable=true), then simulate historical drift: memberships now in Team B
    for (const u of [uDrift, uDriftMove]) {
      const { rows: [uVer] } = await db.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [u.app],
      );
      await serviceRpc(
        db,
        "direct_entry_disable_app_user",
        [OWNER.auth, OWNER.app, u.app, uVer.version, "Lock drifted TL account", nextKey("dis_drift")],
        ["uuid", "uuid", "uuid", "int", "text", "text"],
      );
      await db.exec(`
        update public.recruiter_team_memberships
           set valid_to = ('${today}'::date - 1), is_current = false
         where recruiter_id = '${u.recruiterId}' and is_current = true;
        insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
        values ('${u.recruiterId}', '${teamB}', ('${today}'::date - 1), null, true);
      `);
    }

    // Drifted suspended TL on Team A MUST NOT block Unassign from Team B
    const { rows: [recDriftVer] } = await db.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [uDrift.recruiterId],
    );
    const unassignDriftRes = await serviceRpc(
      db,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, uDrift.recruiterId, today, recDriftVer.version, "Unassign B despite drifted suspended TL on A", nextKey("un_drift_b")],
      ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(unassignDriftRes.team_id, teamB);
    assert.equal(unassignDriftRes.valid_to, today);

    // Re-enable uDrift -> MUST NOT restore TL assignment / scope / capability on Team A
    const { rows: [uDriftAccVer] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uDrift.app],
    );
    await serviceRpc(
      db,
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, uDrift.app, uDriftAccVer.version, "Re-enable drifted account", nextKey("en_drift")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );

    const { rows: [tlaAfterEnable] } = await db.query(
      `select is_current, suspended_by_account_disable, valid_to::text
         from public.direct_entry_team_leader_assignments
        where leader_app_user_id = $1::uuid and team_id = $2::uuid`,
      [uDrift.app, teamA],
    );
    assert.equal(tlaAfterEnable.is_current, false);
    assert.equal(tlaAfterEnable.suspended_by_account_disable, false);
    assert.equal(tlaAfterEnable.valid_to, today);

    const { rows: [{ ctx: uDriftCtx }] } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [uDrift.auth],
    );
    assert.equal(uDriftCtx.app_user_id, uDrift.app);
    assert.equal(
      uDriftCtx.team_scope_grants.some((s) => s.team_id === teamA),
      false,
      "Re-enable MUST NOT restore Team A scope for drifted account",
    );
    assert.equal(
      uDriftCtx.capabilities.includes("team_manager_assign"),
      false,
      "Re-enable MUST NOT restore team_manager_assign capability for drifted account",
    );

    // Drifted suspended TL on Team A2 MUST NOT block Move(B -> C), and re-enable afterwards still does NOT restore A2
    const { rows: [recDriftMvVer] } = await db.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [uDriftMove.recruiterId],
    );
    const moveDriftRes = await serviceRpc(
      db,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, uDriftMove.recruiterId, teamC, today, recDriftMvVer.version, "Move B->C despite drifted suspended TL on A2", nextKey("mv_drift_bc")],
      ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
    );
    assert.equal(moveDriftRes.change, "MOVE");
    assert.equal(moveDriftRes.team_id, teamC);

    const { rows: [uDriftMvAccVer] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uDriftMove.app],
    );
    await serviceRpc(
      db,
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, uDriftMove.app, uDriftMvAccVer.version, "Re-enable drifted move account", nextKey("en_drift_mv")],
      ["uuid", "uuid", "uuid", "int", "text", "text"],
    );
    const { rows: [tlaMvAfterEnable] } = await db.query(
      `select is_current, suspended_by_account_disable, valid_to::text
         from public.direct_entry_team_leader_assignments
        where leader_app_user_id = $1::uuid and team_id = $2::uuid`,
      [uDriftMove.app, teamA2],
    );
    assert.equal(tlaMvAfterEnable.is_current, false);
    assert.equal(tlaMvAfterEnable.suspended_by_account_disable, false);
    assert.equal(tlaMvAfterEnable.valid_to, today);
  } finally {
    await db.close();
  }
});
