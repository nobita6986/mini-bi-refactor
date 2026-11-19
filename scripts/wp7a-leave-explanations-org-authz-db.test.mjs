/**
 * WP7A — Leave Management & Attendance Explanations on WP3 Org/Person + WP5 Paired Authz
 * PGlite Database & TypeScript Contract/Projection Regression Suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { leaveHttpStatusForError } from "../src/lib/leave/leave-contract.ts";
import { leaveErrorMessage } from "../src/lib/leave/leave-ui-model.ts";
import {
  projectAttendanceExplanationApprovalInbox,
  projectSubmitAttendanceExplanationResult,
  projectAttendanceMyExplanationsOverview,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { createServiceAttendanceMonthlyMatrixRepository } from "../src/lib/attendance/attendance-monthly-matrix-repository.ts";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP7A_MIGRATION = "20261119120000_wp7a_leave_explanations_org_authz.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "17000000-0000-4000-8000-000000000001",
  app: "27000000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical",
};
const LUANPT = {
  auth: "17000000-0000-4000-8000-000000000002",
  app: "27000000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "17000000-0000-4000-8000-000000000003",
  app: "27000000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "17000000-0000-4000-8000-000000000004",
  app: "27000000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "17000000-0000-4000-8000-000000000005",
  app: "27000000-0000-4000-8000-000000000005",
  email: "hr.op@hrpartner.vn",
  name: "HR Operator Global",
};
const HR_TL_COMBO = {
  auth: "17000000-0000-4000-8000-000000000006",
  app: "27000000-0000-4000-8000-000000000006",
  recruiter: "37000000-0000-4000-8000-000000000006",
  email: "hr.tl.combo@hrpartner.vn",
  name: "HR Plus Team Leader",
};
const TL_REPLACEMENT = {
  auth: "17000000-0000-4000-8000-000000000007",
  app: "27000000-0000-4000-8000-000000000007",
  recruiter: "37000000-0000-4000-8000-000000000007",
  email: "tl.next@hrpartner.vn",
  name: "Team Leader Replacement",
};
const REC_STAFF = {
  auth: "17000000-0000-4000-8000-000000000008",
  app: "27000000-0000-4000-8000-000000000008",
  recruiter: "37000000-0000-4000-8000-000000000008",
  email: "rec.staff@hrpartner.vn",
  name: "Recruiter Staff",
};
const MKT_HEAD_A = {
  auth: "17000000-0000-4000-8000-000000000009",
  app: "27000000-0000-4000-8000-000000000009",
  email: "mkt.head.a@hrpartner.vn",
  name: "MKT Head Alice",
};
const MKT_HEAD_B = {
  auth: "17000000-0000-4000-8000-000000000010",
  app: "27000000-0000-4000-8000-000000000010",
  email: "mkt.head.b@hrpartner.vn",
  name: "MKT Head Bob",
};
const MKT_MEMBER = {
  auth: "17000000-0000-4000-8000-000000000011",
  app: "27000000-0000-4000-8000-000000000011",
  email: "mkt.member@hrpartner.vn",
  name: "MKT Ordinary Member",
};
const MKT_PEER_NON_HEAD = {
  auth: "17000000-0000-4000-8000-000000000012",
  app: "27000000-0000-4000-8000-000000000012",
  email: "mkt.peer@hrpartner.vn",
  name: "MKT Peer Non-Head",
};
const OPS_HEAD = {
  auth: "17000000-0000-4000-8000-000000000013",
  app: "27000000-0000-4000-8000-000000000013",
  email: "ops.head@hrpartner.vn",
  name: "Ops Custom Head Charlie",
};
const PM_ONLY = {
  auth: "17000000-0000-4000-8000-000000000014",
  app: "27000000-0000-4000-8000-000000000014",
  recruiter: "37000000-0000-4000-8000-000000000014",
  email: "pm.only@hrpartner.vn",
  name: "PM Only",
};
const ACCT_ONLY = {
  auth: "17000000-0000-4000-8000-000000000015",
  app: "27000000-0000-4000-8000-000000000015",
  email: "acct.only@hrpartner.vn",
  name: "Project Accountant Only",
};
const UNLINKED_LEGACY_MKT = {
  auth: "17000000-0000-4000-8000-000000000016",
  app: "27000000-0000-4000-8000-000000000016",
  email: "legacy.mkt@hrpartner.vn",
  name: "Unlinked Legacy MKT",
};
const LEGACY_MKT_APPROVER = {
  auth: "17000000-0000-4000-8000-000000000017",
  app: "27000000-0000-4000-8000-000000000017",
  email: "thainh.mkt@hrpartner.vn",
  name: "Legacy MKT Approver",
};
const SHARED_TYPE_ACC = {
  auth: "17000000-0000-4000-8000-000000000018",
  app: "27000000-0000-4000-8000-000000000018",
  email: "shared.type@hrpartner.vn",
  name: "Shared By Account Type",
};
const SERVICE_TYPE_ACC = {
  auth: "17000000-0000-4000-8000-000000000019",
  app: "27000000-0000-4000-8000-000000000019",
  email: "service.bot@hrpartner.vn",
  name: "Service Bot Account",
};
const LEGACY_SHARED_NORMAL_ACC = {
  auth: "17000000-0000-4000-8000-000000000020",
  app: "27000000-0000-4000-8000-000000000020",
  email: "mkt.bg@hrpartner.vn",
  name: "Legacy Shared Normal",
};
const MULTI_SOURCE_USER = {
  auth: "17000000-0000-4000-8000-000000000021",
  app: "27000000-0000-4000-8000-000000000021",
  recruiter: "37000000-0000-4000-8000-000000000021",
  email: "multi.source@hrpartner.vn",
  name: "Multi Source User",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  HR_OP,
  HR_TL_COMBO,
  TL_REPLACEMENT,
  REC_STAFF,
  MKT_HEAD_A,
  MKT_HEAD_B,
  MKT_MEMBER,
  MKT_PEER_NON_HEAD,
  OPS_HEAD,
  PM_ONLY,
  ACCT_ONLY,
  UNLINKED_LEGACY_MKT,
  LEGACY_MKT_APPROVER,
  SHARED_TYPE_ACC,
  SERVICE_TYPE_ACC,
  LEGACY_SHARED_NORMAL_ACC,
  MULTI_SOURCE_USER,
];

const TEAM_1 = "47000000-0000-4000-8000-000000000001";
const TEAM_2 = "47000000-0000-4000-8000-000000000002";

let seq = 1;
function nextUuid() {
  const hex = String(seq++).padStart(12, "0");
  return `77000000-0000-4000-8000-${hex}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val)).digest("hex");
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(`select public.${fnName}(${placeholders}) as data`, args);
    await db.exec("commit;");
    return res.rows[0]?.data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function createCutoverDb() {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  const migrations = await loadMigrations();
  for (const m of migrations) {
    await db.exec(m.sql);
  }

  for (const u of ALL_USERS) {
    await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1::uuid, $2::uuid, true, $3)",
      [u.app, u.auth, u.name],
    );
  }

  // Seed legacy Full Admin caps for OWNER, LIENVU, NGATTT and orphan all-scope for LUANPT -> run WP5B-2 cutover
  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of [
      "entry_admin",
      "entry_team",
      "entry_own",
      "entry_create",
      "submission_create",
      "entry_privileged_edit",
      "entry_restore",
      "recruiter_master_manage",
      "team_master_manage",
      "audit_view",
      "worker_edit_history_view",
      "document_upload",
      "document_view",
      "employment_status.review",
      "employment_status.apply",
      "change_request_create",
      "change_review",
      "employment_status.request",
      "duplicate_cccd_withdraw",
    ]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [adm.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
      [adm.app],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
    [LUANPT.app],
  );

  // Legacy shared-normal profile (like NWC mkt.bg) + unlinked legacy MKT profile
  await db.query(
    `insert into public.leave_employee_profiles (app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, official_effective_date)
     values ($1::uuid, true, 'UNCONFIGURED', 'UNCLASSIFIED', null, null),
            ($2::uuid, false, 'OFFICIAL', 'MARKETING', '2025-01-01', '2025-03-01')`,
    [LEGACY_SHARED_NORMAL_ACC.app, UNLINKED_LEGACY_MKT.app],
  );

  // Run WP5B-2 cutover -> all accounts authz_managed = true, cutover_ready = true, 4 ADMINs
  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  // Teams & Recruiters for TL, Staff, PM, Multi-source (created post-cutover)
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'WP7_T1', 'Team WP7 Một', true),
            ($2::uuid, 'WP7_T2', 'Team WP7 Hai', true)`,
    [TEAM_1, TEAM_2],
  );
  for (const [u, code, pos, teamId] of [
    [HR_TL_COMBO, "NV-HRTL", "TEAM_LEADER", TEAM_1],
    [TL_REPLACEMENT, "NV-TL2", "STAFF", TEAM_1],
    [REC_STAFF, "NV-REC1", "STAFF", TEAM_1],
    [PM_ONLY, "NV-PM1", "STAFF", TEAM_2],
    [MULTI_SOURCE_USER, "NV-MULTI", "TEAM_LEADER", TEAM_2],
  ]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, $4, true)",
      [u.recruiter, u.name, code, pos],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
      [u.recruiter],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
      [u.app, u.recruiter],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
      [u.recruiter, teamId],
    );
  }
  await db.query(
    `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true),
            ($4::uuid, $5::uuid, $6::uuid, '2026-01-01', true)`,
    [TEAM_1, HR_TL_COMBO.app, HR_TL_COMBO.recruiter, TEAM_2, MULTI_SOURCE_USER.app, MULTI_SOURCE_USER.recruiter],
  );

  // Project + PM + Project Accountant
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name, active) values ('proj-wp7', 'Dự án WP7', true)",
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current) values ('proj-wp7', $1::uuid, '2026-01-01', true)",
    [PM_ONLY.recruiter],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
  await db.query(
    `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
     values ('proj-wp7', $1::uuid, 1, '2026-01-01', $2::uuid, 'Seed PA')`,
    [ACCT_ONLY.app, OWNER.app],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

  // Assign global roles via real WP5 RPC
  async function assignRole(target, roleCode) {
    const { rows: [u] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [target.app],
    );
    return serviceRpc(db, "direct_entry_authz_assign_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      target.app,
      roleCode,
      u.version,
      `Assign ${roleCode} for WP7A test`,
      nextUuid(),
      sha256(`assign:${target.app}:${roleCode}:${seq}`),
    ]);
  }
  await assignRole(HR_OP, "HR_OPERATOR");
  await assignRole(HR_TL_COMBO, "HR_OPERATOR");
  const multiAdminAssign = await assignRole(MULTI_SOURCE_USER, "ADMIN");

  // Set SHARED and SERVICE account types directly (and without creating leave_employee_profiles for SERVICE_TYPE_ACC)
  await db.query(
    "update public.direct_entry_app_users set account_type = 'SHARED' where app_user_id = $1::uuid",
    [SHARED_TYPE_ACC.app],
  );
  await db.query(
    "update public.direct_entry_app_users set account_type = 'SERVICE' where app_user_id = $1::uuid",
    [SERVICE_TYPE_ACC.app],
  );

  // Lookup canonical MARKETING department & create custom dynamic OPERATIONS department (system_key IS NULL)
  const { rows: [mktDept] } = await db.query(
    "select department_id, version from public.organization_departments where system_key = 'MARKETING'",
  );
  const opsDeptRes = await serviceRpc(db, "org_department_create_department_admin", [
    OWNER.auth,
    OWNER.app,
    "OPERATIONS",
    "Phòng Vận hành",
    "Tạo phòng ban động kiểm thử WP7A",
    nextUuid(),
    sha256("create-ops-dept"),
  ]);
  const opsDeptId = opsDeptRes.department.department_id;

  // Create WP3 Persons + active account links + department memberships
  async function createLinkedPerson(target, code, fullName, deptId) {
    const { rows: [u] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [target.app],
    );
    const res = await serviceRpc(db, "org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      code,
      fullName,
      "2025-01-01",
      deptId,
      target.app,
      u.version,
      null,
      `Tạo hồ sơ nhân sự ${code}`,
      nextUuid(),
      sha256(`person:${code}`),
    ]);
    return res.person;
  }

  const personHeadA = await createLinkedPerson(MKT_HEAD_A, "EMP-MKTA", "Nguyễn Thị Trưởng A", mktDept.department_id);
  const personHeadB = await createLinkedPerson(MKT_HEAD_B, "EMP-MKTB", "Trần Văn Trưởng B", mktDept.department_id);
  const personMktMember = await createLinkedPerson(MKT_MEMBER, "EMP-MKTM", "Lê Văn Nhân Viên MKT", mktDept.department_id);
  const personMktPeer = await createLinkedPerson(MKT_PEER_NON_HEAD, "EMP-MKTP", "Phạm Thị Đồng Nghiệp", mktDept.department_id);
  const personOpsHead = await createLinkedPerson(OPS_HEAD, "EMP-OPSH", "Hoàng Văn Trưởng Vận Hành", opsDeptId);

  // Designate OPS_HEAD as HEAD of custom dynamic department OPERATIONS
  const { rows: [opsDeptCur] } = await db.query(
    "select version from public.organization_departments where department_id = $1::uuid",
    [opsDeptId],
  );
  await serviceRpc(db, "org_department_designate_head_admin", [
    OWNER.auth,
    OWNER.app,
    opsDeptId,
    personOpsHead.person_id,
    opsDeptCur.version,
    null,
    "Bổ nhiệm Trưởng phòng Vận hành",
    nextUuid(),
    sha256("head-ops"),
  ]);

  // Configure OFFICIAL leave profiles for MKT_MEMBER and REC_STAFF (for leave/accrual & explanations)
  for (const [target, unitKind] of [
    [MKT_MEMBER, "MARKETING"],
    [REC_STAFF, "RECRUITMENT"],
  ]) {
    await serviceRpc(db, "leave_management_upsert_employee_profile_admin", [
      OWNER.auth,
      OWNER.app,
      target.app,
      false,
      "OFFICIAL",
      unitKind,
      "2025-01-01",
      "2025-03-01",
      null,
      0,
      0,
      "Thiết lập hồ sơ phép WP7A",
      `prof-${target.app}`,
      sha256(`prof-${target.app}`),
    ]);
  }

  // Ensure policy allows carry over and set test date to today VN for explanations + leave parity
  const { rows: [{ d: todayVn }] } = await db.query(
    "select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date::text as d",
  );

  return {
    db,
    todayVn,
    mktDeptId: mktDept.department_id,
    opsDeptId,
    personHeadA,
    personHeadB,
    personMktMember,
    personMktPeer,
    personOpsHead,
    multiAdminAssignmentId: multiAdminAssign.assignment.assignment_id,
  };
}

test("1. WP7A migration hygiene: zero at-signs, atomic rollback, internal ACLs & NOBYPASSRLS fail-closed", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP7A_MIGRATION), "utf8");
  assert.equal(sql.includes("@"), false, "WP7A migration must contain zero @ characters");

  const db = new PGlite();
  try {
    await db.exec(PROLOGUE);
    const migrations = await loadMigrations();
    const wp7aIdx = migrations.findIndex((m) => m.name === WP7A_MIGRATION);
    assert.ok(wp7aIdx > 0, "WP7A migration must exist");
    for (const m of migrations.slice(0, wp7aIdx)) {
      await db.exec(m.sql);
    }

    // Rehearsal rollback safety
    const bodyWithoutTx = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await db.exec(`begin;\n${bodyWithoutTx}\nrollback;`);
    const { rows: preCols } = await db.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'leave_requests' and column_name = 'routed_department_id'",
    );
    assert.equal(preCols.length, 0, "Rolled-back WP7A rehearsal must leave zero schema drift");

    // Apply forward
    await db.exec(sql);

    // Internal helpers must reject anon, authenticated, and service_role
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const callSql of [
        "select * from public.leave_management__internal_resolve_person_department(null::uuid)",
        "select public.leave_management__internal_has_open_department_head(null::uuid)",
        "select public.leave_management__internal_resolve_department_head_user(null::uuid)",
        "select * from public.leave_management__internal_resolve_routing_snapshot(null::uuid)",
        "select public.leave_management__internal_resolve_routing(null::uuid)",
        "select public.leave_management__internal_resolve_authority(null::uuid, null::uuid)",
      ]) {
        await assert.rejects(
          async () => {
            await db.exec(`begin; set local role ${role};`);
            try {
              await db.query(callSql);
              await db.exec("commit;");
            } catch (err) {
              await db.exec("rollback;");
              throw err;
            }
          },
          (err) => err.code === "42501",
          `${role} must not execute internal helper: ${callSql}`,
        );
      }
    }

    // TS contract/error/repository fixes verified alongside migration
    assert.equal(leaveHttpStatusForError("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"), 409);
    assert.match(leaveErrorMessage("LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN"), /Quản trị Tổ chức/);
    assert.match(leaveErrorMessage("LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN"), /quá khứ/);
    const mockRepo = createServiceAttendanceMonthlyMatrixRepository(async () => ({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "attendance_explanations_active_slot_uq"',
      },
    }));
    const dupRes = await mockRepo.submitExplanation({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      business_date: "2026-11-18",
      slot_code: "SLOT_1",
      reason: "Test duplicate index",
      idempotency_key: nextUuid(),
      request_fingerprint: sha256("dup-idx"),
    });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.code, "ATTENDANCE_EXPLANATION_ALREADY_SUBMITTED");
  } finally {
    await db.close();
  }
});

test("2. WP7A Persona Matrix & Cross-Scope Escalation Block (ADMIN, HR_OPERATOR+TL, PM, Accountant, Peer Non-Head, Multi-Source Revoke)", async () => {
  const { db } = await createCutoverDb();
  try {
    // 2a. All 4 unified ADMINs (including luanpt) have Full Admin + BoD authority on Leave & Explanations
    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      const summary = await serviceRpc(db, "leave_management_get_my_summary", [adm.auth, adm.app, 2026]);
      assert.equal(summary.authority.is_full_admin, true, `${adm.email} must be Full Admin`);
      assert.equal(summary.authority.is_bod, true, `${adm.email} must be BoD/Admin`);
      assert.equal(summary.authority.can_manage_config, true);
      assert.equal(summary.authority.can_view_monthly_report, true);
      assert.equal(summary.authority.can_approve_requests, true);
    }

    // 2b. HR_OPERATOR alone -> NO Leave Admin, NO BoD, NO Monthly Report, NO Approval
    const hrOpSum = await serviceRpc(db, "leave_management_get_my_summary", [HR_OP.auth, HR_OP.app, 2026]);
    assert.equal(hrOpSum.authority.is_full_admin, false);
    assert.equal(hrOpSum.authority.is_bod, false);
    assert.equal(hrOpSum.authority.can_manage_config, false);
    assert.equal(hrOpSum.authority.can_view_monthly_report, false);
    assert.equal(hrOpSum.authority.can_approve_requests, false);

    // 2c. CRITICAL SECURITY FIX: HR_OPERATOR (ALL scope) + TEAM_LEADER (report_view + report_analytics_view @ CONTEXT_TEAM)
    //     MUST NOT escalate via Cartesian product to is_bod = true / can_manage_config = true / can_view_monthly_report = true!
    const comboSum = await serviceRpc(db, "leave_management_get_my_summary", [HR_TL_COMBO.auth, HR_TL_COMBO.app, 2026]);
    assert.equal(comboSum.authority.is_full_admin, false, "HR_OPERATOR + TL must not escalate to Full Admin");
    assert.equal(comboSum.authority.is_bod, false, "HR_OPERATOR + TL must NOT escalate to BoD via unpaired scope");
    assert.equal(comboSum.authority.can_manage_config, false, "HR_OPERATOR + TL must NOT gain Leave Admin config");
    assert.equal(comboSum.authority.can_view_monthly_report, false, "HR_OPERATOR + TL must NOT gain Leave monthly report");
    assert.equal(comboSum.authority.is_team_leader, true, "HR_OPERATOR + TL retains legitimate Team Leader authority");
    assert.equal(comboSum.authority.can_approve_requests, true);

    await assert.rejects(
      () => serviceRpc(db, "leave_management_get_admin_overview", [HR_TL_COMBO.auth, HR_TL_COMBO.app, null, 20, 0, "ACTIVE"]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_ADMIN_FORBIDDEN"),
    );
    await assert.rejects(
      () => serviceRpc(db, "leave_management_monthly_report", [HR_TL_COMBO.auth, HR_TL_COMBO.app, "2026-11", "ALL", null, 50, 0]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_REPORT_FORBIDDEN"),
    );

    // 2d. PM-only, Project Accountant-only, and Ordinary Department Member (non-HEAD) have ZERO approval/admin rights
    for (const actor of [PM_ONLY, ACCT_ONLY, MKT_PEER_NON_HEAD, MKT_MEMBER]) {
      const s = await serviceRpc(db, "leave_management_get_my_summary", [actor.auth, actor.app, 2026]);
      assert.equal(s.authority.is_department_approver, false, `${actor.email} must not be department approver`);
      assert.equal(s.authority.can_approve_requests, false, `${actor.email} must not approve`);
      assert.equal(s.authority.can_manage_config, false);
      assert.equal(s.authority.can_view_monthly_report, false);
    }

    // 2e. Custom Dynamic Department HEAD (OPS_HEAD): is_department_approver = true, own request -> ADMIN_BOD_DIRECT
    const opsHeadSum = await serviceRpc(db, "leave_management_get_my_summary", [OPS_HEAD.auth, OPS_HEAD.app, 2026]);
    assert.equal(opsHeadSum.authority.is_department_approver, true);
    assert.equal(opsHeadSum.authority.can_approve_requests, true);
    assert.equal(opsHeadSum.authority.can_manage_config, false);
    assert.equal(opsHeadSum.routing.route_kind, "ADMIN_BOD_DIRECT");

    // 2f. Multi-source independent preservation: grant HR_LEAVE_OPERATOR to MULTI_SOURCE_USER (who also has ADMIN + TEAM_LEADER),
    //     then revoke ADMIN -> loses Full Admin/BoD immediately while keeping BOTH TEAM_LEADER AND HR_LEAVE_OPERATOR!
    await serviceRpc(db, "leave_management_manage_module_grant_admin", [
      OWNER.auth,
      OWNER.app,
      "GRANT",
      MULTI_SOURCE_USER.app,
      "HR_LEAVE_OPERATOR",
      0,
      "Cấp quyền HR Leave độc lập",
      `hr-grant-${seq++}`,
      sha256("hr-grant-multi"),
    ]);
    const { rows: [multiU] } = await db.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [MULTI_SOURCE_USER.app],
    );
    const { rows: [multiAdminRow] } = await db.query(
      "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
      [MULTI_SOURCE_USER.app],
    );
    await serviceRpc(db, "direct_entry_authz_revoke_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      MULTI_SOURCE_USER.app,
      multiAdminRow.assignment_id,
      multiU.version,
      "Thu hồi ADMIN nhưng giữ quyền độc lập",
      nextUuid(),
      sha256("revoke-multi-admin"),
    ]);
    const multiAfterRevoke = await serviceRpc(db, "leave_management_get_my_summary", [
      MULTI_SOURCE_USER.auth,
      MULTI_SOURCE_USER.app,
      2026,
    ]);
    assert.equal(multiAfterRevoke.authority.is_full_admin, false);
    assert.equal(multiAfterRevoke.authority.is_bod, false);
    assert.equal(multiAfterRevoke.authority.is_team_leader, true, "Independent TEAM_LEADER must survive ADMIN revoke");
    assert.equal(multiAfterRevoke.authority.is_hr_operator, true, "Independent HR_LEAVE_OPERATOR must survive ADMIN revoke");
    assert.equal(multiAfterRevoke.authority.can_manage_config, true);
    assert.equal(multiAfterRevoke.authority.can_view_monthly_report, true);
  } finally {
    await db.close();
  }
});

test("3. WP7A Special Accounts (SHARED, SERVICE, Legacy-Shared-Normal), Disabled (D10), Unlinked Legacy & Compat-to-HEAD Transition", async () => {
  const { db, mktDeptId, personHeadA, todayVn } = await createCutoverDb();
  try {
    // 3a. All 3 non-employee variants blocked on Leave, Explanations, Dept Approver, Monthly Report, Opening Preview
    for (const acc of [SHARED_TYPE_ACC, SERVICE_TYPE_ACC, LEGACY_SHARED_NORMAL_ACC]) {
      await assert.rejects(
        () => serviceRpc(db, "leave_management_get_my_summary", [acc.auth, acc.app, 2026]),
        (err) => err.code === "42501" && String(err.message).includes("LEAVE_SHARED_ACCOUNT_FORBIDDEN"),
        `${acc.email} must be blocked from Leave`,
      );
      await assert.rejects(
        () =>
          serviceRpc(db, "attendance_submit_explanation", [
            acc.auth,
            acc.app,
            todayVn,
            "SLOT_1",
            "Tài khoản đặc biệt không được gửi giải trình",
            nextUuid(),
            sha256(`exp-deny-${acc.app}`),
          ]),
        (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_EXPLANATION_SUBMIT_DENIED"),
        `${acc.email} must be blocked from Attendance Explanations`,
      );
      await assert.rejects(
        () =>
          serviceRpc(db, "leave_management_set_department_approver_admin", [
            OWNER.auth,
            OWNER.app,
            "IT",
            acc.app,
            null,
            0,
            "Không được gán shared/service làm người duyệt",
            `set-shared-${acc.app}`,
            sha256(`set-shared-${acc.app}`),
          ]),
        (err) => err.code === "42501" && String(err.message).includes("LEAVE_SHARED_ACCOUNT_FORBIDDEN"),
        `${acc.email} must be rejected as department approver`,
      );
    }

    const monthly = await serviceRpc(db, "leave_management_monthly_report", [
      OWNER.auth,
      OWNER.app,
      todayVn.slice(0, 7),
      "ALL",
      null,
      200,
      0,
    ]);
    for (const acc of [SHARED_TYPE_ACC, SERVICE_TYPE_ACC, LEGACY_SHARED_NORMAL_ACC]) {
      assert.equal(
        monthly.rows.some((r) => r.app_user_id === acc.app),
        false,
        `${acc.email} must be excluded from leave monthly report`,
      );
    }

    const openingPreview = await serviceRpc(db, "leave_management_preview_opening_batch", [
      OWNER.auth,
      OWNER.app,
      Number(todayVn.slice(0, 4)),
      JSON.stringify([
        { app_user_id: SHARED_TYPE_ACC.app, carry_over_units: 0, opening_current_year_units: 4, seniority_units: 0 },
        { app_user_id: SERVICE_TYPE_ACC.app, carry_over_units: 0, opening_current_year_units: 4, seniority_units: 0 },
      ]),
    ]);
    assert.equal(openingPreview.valid, false);
    assert.ok(openingPreview.rows[0].errors.includes("SHARED_ACCOUNT_NOT_ELIGIBLE"));
    assert.ok(openingPreview.rows[1].errors.includes("SHARED_ACCOUNT_NOT_ELIGIBLE"));

    // 3b. Unlinked legacy NORMAL account (UNLINKED_LEGACY_MKT) is NOT treated as bot/shared:
    //     When MARKETING has NO canonical HEAD yet, compat leave_department_approvers (LEGACY_MKT_APPROVER) works!
    await serviceRpc(db, "leave_management_set_department_approver_admin", [
      OWNER.auth,
      OWNER.app,
      "MARKETING",
      LEGACY_MKT_APPROVER.app,
      null,
      0,
      "Cấu hình người duyệt Marketing legacy tương thích",
      `compat-mkt-${seq++}`,
      sha256("compat-mkt"),
    ]);
    const unlinkedBeforeHead = await serviceRpc(db, "leave_management_get_my_summary", [
      UNLINKED_LEGACY_MKT.auth,
      UNLINKED_LEGACY_MKT.app,
      2026,
    ]);
    assert.equal(unlinkedBeforeHead.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(unlinkedBeforeHead.routing.primary_approver_app_user_id, LEGACY_MKT_APPROVER.app);

    const legacyApproverBeforeHead = await serviceRpc(db, "leave_management_get_my_summary", [
      LEGACY_MKT_APPROVER.auth,
      LEGACY_MKT_APPROVER.app,
      2026,
    ]);
    assert.equal(legacyApproverBeforeHead.authority.is_department_approver, true);

    // 3c. Once Admin designates canonical WP3 HEAD (MKT_HEAD_A) on MARKETING:
    //     Canonical HEAD supersedes legacy leave_department_approvers for NEW routing!
    const { rows: [mktDeptCur] } = await db.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [mktDeptId],
    );
    await serviceRpc(db, "org_department_designate_head_admin", [
      OWNER.auth,
      OWNER.app,
      mktDeptId,
      personHeadA.person_id,
      mktDeptCur.version,
      null,
      "Bổ nhiệm Trưởng phòng Marketing chuẩn WP3",
      nextUuid(),
      sha256("designate-mkt-head-a"),
    ]);

    const mktMemberAfterHead = await serviceRpc(db, "leave_management_get_my_summary", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      2026,
    ]);
    assert.equal(mktMemberAfterHead.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktMemberAfterHead.routing.primary_approver_app_user_id, MKT_HEAD_A.app);

    const unlinkedAfterHead = await serviceRpc(db, "leave_management_get_my_summary", [
      UNLINKED_LEGACY_MKT.auth,
      UNLINKED_LEGACY_MKT.app,
      2026,
    ]);
    assert.equal(unlinkedAfterHead.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(unlinkedAfterHead.routing.primary_approver_app_user_id, MKT_HEAD_A.app);

    // Legacy compat approver no longer holds live is_department_approver once canonical HEAD exists
    const legacyApproverAfterHead = await serviceRpc(db, "leave_management_get_my_summary", [
      LEGACY_MKT_APPROVER.auth,
      LEGACY_MKT_APPROVER.app,
      2026,
    ]);
    assert.equal(legacyApproverAfterHead.authority.is_department_approver, false);

    // 3d. D10: Disabling canonical HEAD (MKT_HEAD_A) blocks them (42501) AND falls back cleanly to ADMIN_BOD_FALLBACK
    //     (MUST NOT silently fall back to stale legacy leave_department_approvers!), then re-enabling restores HEAD!
    await db.query(
      "update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid",
      [MKT_HEAD_A.app],
    );
    await assert.rejects(
      () => serviceRpc(db, "leave_management_get_my_summary", [MKT_HEAD_A.auth, MKT_HEAD_A.app, 2026]),
      (err) => err.code === "42501",
      "Disabled HEAD must be denied",
    );
    const mktWhileHeadDisabled = await serviceRpc(db, "leave_management_get_my_summary", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      2026,
    ]);
    assert.equal(mktWhileHeadDisabled.routing.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(mktWhileHeadDisabled.routing.fallback_reason, "DEPARTMENT_APPROVER_NOT_CONFIGURED");
    assert.equal(mktWhileHeadDisabled.routing.primary_approver_app_user_id, null);

    await db.query(
      "update public.direct_entry_app_users set enabled = true where app_user_id = $1::uuid",
      [MKT_HEAD_A.app],
    );
    const mktAfterHeadReenabled = await serviceRpc(db, "leave_management_get_my_summary", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      2026,
    ]);
    assert.equal(mktAfterHeadReenabled.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktAfterHeadReenabled.routing.primary_approver_app_user_id, MKT_HEAD_A.app);
  } finally {
    await db.close();
  }
});

test("4. WP7A Pending Snapshot Preservation, Same-Day HEAD Replace, Dept Transfer (Custom Dept), Explanations Parity & Idempotency/OCC", async () => {
  const { db, todayVn, mktDeptId, opsDeptId, personHeadA, personHeadB, personMktMember } = await createCutoverDb();
  try {
    // Designate MKT_HEAD_A on MARKETING
    const { rows: [mktDept1] } = await db.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [mktDeptId],
    );
    const headARes = await serviceRpc(db, "org_department_designate_head_admin", [
      OWNER.auth,
      OWNER.app,
      mktDeptId,
      personHeadA.person_id,
      mktDept1.version,
      null,
      "Bổ nhiệm Trưởng phòng Marketing Alice",
      nextUuid(),
      sha256("s4-head-a"),
    ]);

    // Calculate yesterday VN so explanation slot SLOT_1 is eligible (MISSING)
    const { rows: [{ y: yesterdayVn, t1: leaveDay1, t2: leaveDay2, t3: leaveDay3 }] } = await db.query(
      `select ($1::date - 1)::text as y,
              ($1::date + 2)::text as t1,
              ($1::date + 4)::text as t2,
              ($1::date + 6)::text as t3`,
      [todayVn],
    );

    // 4a. MKT_MEMBER submits Leave #1 & Explanation #1 while Alice is MKT HEAD
    const leave1 = await serviceRpc(db, "leave_management_create_request", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      JSON.stringify([{ leave_date: leaveDay1, session_code: "AM", leave_type: "UNPAID" }]),
      "Nghỉ phép 1 trước khi đổi Trưởng phòng",
      `leave1-${seq++}`,
      sha256("leave1"),
    ]);
    assert.equal(leave1.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(leave1.request.primary_approver_app_user_id, MKT_HEAD_A.app);

    const { rows: [leave1Db] } = await db.query(
      "select routed_department_id, routed_department_code, routed_department_name, primary_approver_app_user_id from public.leave_requests where request_id = $1::uuid",
      [leave1.request.request_id],
    );
    assert.equal(leave1Db.routed_department_id, mktDeptId);
    assert.equal(leave1Db.routed_department_code, "MARKETING");
    assert.equal(leave1Db.primary_approver_app_user_id, MKT_HEAD_A.app);

    const expOverviewRaw = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      yesterdayVn,
      50,
      0,
    ]);
    const expOverview = projectAttendanceMyExplanationsOverview(expOverviewRaw);
    assert.ok(expOverview, "Strict TS projection for attendance_get_my_explanations_overview must pass");
    assert.equal(expOverview.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(expOverview.routing.primary_approver?.app_user_id, MKT_HEAD_A.app);
    assert.equal(expOverview.routing.primary_approver?.display_name, "Nguyễn Thị Trưởng A");
    assert.equal(expOverview.routing.primary_approver?.personnel_code, "EMP-MKTA");

    const exp1Raw = await serviceRpc(db, "attendance_submit_explanation", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      yesterdayVn,
      "SLOT_1",
      "Giải trình 1 trước khi đổi Trưởng phòng",
      nextUuid(),
      sha256("exp1"),
    ]);
    const exp1 = projectSubmitAttendanceExplanationResult(exp1Raw);
    assert.ok(exp1, "Strict TS projection for attendance_submit_explanation must pass");
    assert.equal(exp1.explanation.route_kind, "DEPARTMENT_HEAD");
    assert.equal(exp1.explanation.primary_approver?.app_user_id, MKT_HEAD_A.app);

    const { rows: [exp1Db] } = await db.query(
      "select routed_department_id, routed_department_code, primary_approver_app_user_id from public.attendance_explanations where explanation_id = $1::uuid",
      [exp1.explanation.explanation_id],
    );
    assert.equal(exp1Db.routed_department_id, mktDeptId);
    assert.equal(exp1Db.primary_approver_app_user_id, MKT_HEAD_A.app);

    // 4b. SAME DAY: Replace MKT HEAD Alice -> Bob!
    await serviceRpc(db, "org_department_designate_head_admin", [
      OWNER.auth,
      OWNER.app,
      mktDeptId,
      personHeadB.person_id,
      headARes.department_version,
      headARes.active_head.head_assignment_id,
      "Thay thế Trưởng phòng Marketing cùng ngày sang Bob",
      nextUuid(),
      sha256("s4-head-b"),
    ]);

    // Pending snapshots MUST NOT be mutated!
    const { rows: [leave1AfterSwap] } = await db.query(
      "select primary_approver_app_user_id, routed_department_id, status from public.leave_requests where request_id = $1::uuid",
      [leave1.request.request_id],
    );
    assert.equal(leave1AfterSwap.primary_approver_app_user_id, MKT_HEAD_A.app);
    assert.equal(leave1AfterSwap.routed_department_id, mktDeptId);
    assert.equal(leave1AfterSwap.status, "PENDING");

    // Bob (new HEAD) MUST NOT receive or decide frozen pending Leave #1 or Explanation #1!
    const bobLeaveInboxBeforeNew = await serviceRpc(db, "leave_management_list_approval_inbox", [
      MKT_HEAD_B.auth,
      MKT_HEAD_B.app,
      "PENDING",
      50,
      0,
    ]);
    assert.equal(
      bobLeaveInboxBeforeNew.items.some((i) => i.request_id === leave1.request.request_id),
      false,
      "Replacement HEAD Bob must NOT inherit frozen pending Leave #1",
    );
    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          MKT_HEAD_B.auth,
          MKT_HEAD_B.app,
          leave1.request.request_id,
          "APPROVE",
          1,
          "Bob thử duyệt đơn cũ của Alice",
          `bob-steal-l1-${seq++}`,
          sha256("bob-steal-l1"),
        ]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );
    await assert.rejects(
      () =>
        serviceRpc(db, "attendance_decide_explanation", [
          MKT_HEAD_B.auth,
          MKT_HEAD_B.app,
          exp1.explanation.explanation_id,
          "APPROVE",
          1,
          "Bob thử duyệt giải trình cũ của Alice",
          nextUuid(),
          sha256("bob-steal-e1"),
        ]),
      (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_EXPLANATION_DECIDE_DENIED"),
    );

    // NEW Leave #2 & Explanation #2 submitted same day route immediately to Bob!
    const leave2 = await serviceRpc(db, "leave_management_create_request", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      JSON.stringify([{ leave_date: leaveDay2, session_code: "AM", leave_type: "UNPAID" }]),
      "Nghỉ phép 2 sau khi đổi sang Bob",
      `leave2-${seq++}`,
      sha256("leave2"),
    ]);
    assert.equal(leave2.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(leave2.request.primary_approver_app_user_id, MKT_HEAD_B.app);

    const exp2Raw = await serviceRpc(db, "attendance_submit_explanation", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      yesterdayVn,
      "SLOT_2",
      "Giải trình 2 sau khi đổi sang Bob",
      nextUuid(),
      sha256("exp2"),
    ]);
    const exp2 = projectSubmitAttendanceExplanationResult(exp2Raw);
    assert.ok(exp2);
    assert.equal(exp2.explanation.primary_approver?.app_user_id, MKT_HEAD_B.app);

    // Alice (revoked HEAD) has is_department_approver = false, CANNOT decide Leave #2 or Exp #2,
    // CAN still finish her frozen pending Leave #1 & Exp #1, and replay idempotency works before OCC!
    const aliceSummaryPending = await serviceRpc(db, "leave_management_get_my_summary", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      2026,
    ]);
    assert.equal(aliceSummaryPending.authority.is_department_approver, false);
    assert.equal(aliceSummaryPending.authority.can_approve_requests, true, "Alice can open inbox strictly for pending snapshot");

    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          MKT_HEAD_A.auth,
          MKT_HEAD_A.app,
          leave2.request.request_id,
          "APPROVE",
          1,
          "Alice thử duyệt đơn mới của Bob",
          `alice-steal-l2-${seq++}`,
          sha256("alice-steal-l2"),
        ]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );

    const aliceExpInbox = projectAttendanceExplanationApprovalInbox(
      await serviceRpc(db, "attendance_list_explanation_approval_inbox", [
        MKT_HEAD_A.auth,
        MKT_HEAD_A.app,
        "PENDING",
        50,
        0,
      ]),
    );
    assert.ok(aliceExpInbox);
    assert.deepEqual(
      aliceExpInbox.items.map((i) => i.explanation_id),
      [exp1.explanation.explanation_id],
      "Alice sees ONLY frozen pending Explanation #1",
    );

    const aliceLeave1Key = `alice-approve-l1-${seq++}`;
    const aliceLeave1Fp = sha256("alice-approve-l1");
    const approvedL1 = await serviceRpc(db, "leave_management_decide_request", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      leave1.request.request_id,
      "APPROVE",
      1,
      "Alice duyệt đơn cũ theo snapshot",
      aliceLeave1Key,
      aliceLeave1Fp,
    ]);
    assert.equal(approvedL1.request.status, "APPROVED");
    assert.equal(approvedL1.replayed, false);

    // Idempotency replay before OCC (version is now 2, replay with expected=1 returns replayed=true!)
    const replayedL1 = await serviceRpc(db, "leave_management_decide_request", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      leave1.request.request_id,
      "APPROVE",
      1,
      "Alice duyệt đơn cũ theo snapshot",
      aliceLeave1Key,
      aliceLeave1Fp,
    ]);
    assert.equal(replayedL1.replayed, true);

    // Fingerprint mismatch rejected
    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          MKT_HEAD_A.auth,
          MKT_HEAD_A.app,
          leave1.request.request_id,
          "APPROVE",
          1,
          "Payload khác",
          aliceLeave1Key,
          sha256("alice-approve-l1-diff"),
        ]),
      (err) => String(err.message).includes("LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH"),
    );

    // Revoked Alice CANNOT cancel already-approved Leave #1 (ADMIN can!)
    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          MKT_HEAD_A.auth,
          MKT_HEAD_A.app,
          leave1.request.request_id,
          "CANCEL_APPROVED",
          approvedL1.request.row_version,
          "Alice đã mất quyền thử hủy đơn đã duyệt",
          `alice-cancel-l1-${seq++}`,
          sha256("alice-cancel-l1"),
        ]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );

    // Alice approves Exp #1 -> now Alice has 0 pending snapshot items -> can_approve_requests drops to false immediately!
    const aliceExp1Key = nextUuid();
    const aliceExp1Fp = sha256("alice-approve-e1");
    const approvedE1 = await serviceRpc(db, "attendance_decide_explanation", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      exp1.explanation.explanation_id,
      "APPROVE",
      1,
      "Alice duyệt giải trình cũ",
      aliceExp1Key,
      aliceExp1Fp,
    ]);
    assert.equal(approvedE1.explanation.status, "APPROVED");
    const replayedE1 = await serviceRpc(db, "attendance_decide_explanation", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      exp1.explanation.explanation_id,
      "APPROVE",
      1,
      "Alice duyệt giải trình cũ",
      aliceExp1Key,
      aliceExp1Fp,
    ]);
    assert.equal(replayedE1.replayed, true);

    const aliceAfterCleared = await serviceRpc(db, "leave_management_get_my_summary", [
      MKT_HEAD_A.auth,
      MKT_HEAD_A.app,
      2026,
    ]);
    assert.equal(aliceAfterCleared.authority.can_approve_requests, false, "Alice loses inbox access once pending snapshots clear");

    // 4c. Transfer MKT_MEMBER -> custom dynamic department OPERATIONS (HEAD = Charlie / OPS_HEAD) same day!
    const { rows: [mRow] } = await db.query(
      `select m.membership_id, p.version as person_version
         from public.organization_person_department_memberships m
         join public.organization_persons p on p.person_id = m.person_id
        where m.person_id = $1::uuid and m.ended_at is null`,
      [personMktMember.person_id],
    );
    await serviceRpc(db, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      personMktMember.person_id,
      opsDeptId,
      mRow.person_version,
      mRow.membership_id,
      "Chuyển sang phòng ban động Vận hành",
      nextUuid(),
      sha256("transfer-ops"),
    ]);

    // Pending Leave #2 (submitted before transfer, snapshotted to MARKETING/Bob) MUST NOT move to Charlie!
    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          OPS_HEAD.auth,
          OPS_HEAD.app,
          leave2.request.request_id,
          "APPROVE",
          1,
          "Charlie thử duyệt đơn cũ trước chuyển phòng",
          `charlie-steal-l2-${seq++}`,
          sha256("charlie-steal-l2"),
        ]),
      (err) => err.code === "42501" && String(err.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );

    // New Leave #3 submitted AFTER transfer routes to Charlie on custom dynamic department!
    const leave3 = await serviceRpc(db, "leave_management_create_request", [
      MKT_MEMBER.auth,
      MKT_MEMBER.app,
      JSON.stringify([{ leave_date: leaveDay3, session_code: "AM", leave_type: "UNPAID" }]),
      "Nghỉ phép 3 sau khi chuyển sang Phòng Vận hành",
      `leave3-${seq++}`,
      sha256("leave3"),
    ]);
    assert.equal(leave3.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(leave3.request.primary_approver_app_user_id, OPS_HEAD.app);
    assert.equal(leave3.request.unit_kind_snapshot, "UNCLASSIFIED");
    const { rows: [leave3Db] } = await db.query(
      "select routed_department_id, routed_department_code, routed_department_name from public.leave_requests where request_id = $1::uuid",
      [leave3.request.request_id],
    );
    assert.equal(leave3Db.routed_department_id, opsDeptId);
    assert.equal(leave3Db.routed_department_code, "OPERATIONS");
    assert.equal(leave3Db.routed_department_name, "Phòng Vận hành");

    // Charlie approves Leave #3 cleanly; stale OCC rejected
    await assert.rejects(
      () =>
        serviceRpc(db, "leave_management_decide_request", [
          OPS_HEAD.auth,
          OPS_HEAD.app,
          leave3.request.request_id,
          "APPROVE",
          99,
          "Stale version",
          `charlie-stale-l3-${seq++}`,
          sha256("charlie-stale-l3"),
        ]),
      (err) => String(err.message).includes("LEAVE_ROW_VERSION_CONFLICT"),
    );
    const approvedL3 = await serviceRpc(db, "leave_management_decide_request", [
      OPS_HEAD.auth,
      OPS_HEAD.app,
      leave3.request.request_id,
      "APPROVE",
      1,
      "Trưởng phòng Vận hành duyệt",
      `charlie-approve-l3-${seq++}`,
      sha256("charlie-approve-l3"),
    ]);
    assert.equal(approvedL3.request.status, "APPROVED");

    // 4d. Canonical Person identity search in Admin Overview & Monthly Report + 0 unexpected writes on pure reads
    const { rows: [countsBefore] } = await db.query(
      `select (select count(*)::int from public.leave_audit_events) as leave_audits,
              (select count(*)::int from public.attendance_explanation_audit_events) as exp_audits,
              (select count(*)::int from public.organization_department_audit_events) as org_audits`,
    );
    const adminOverview = await serviceRpc(db, "leave_management_get_admin_overview", [
      OWNER.auth,
      OWNER.app,
      "EMP-OPSH",
      25,
      0,
      "ACTIVE",
    ]);
    assert.equal(adminOverview.total_employees, 1);
    assert.equal(adminOverview.employees[0].account.app_user_id, OPS_HEAD.app);
    assert.equal(adminOverview.employees[0].account.display_name, "Hoàng Văn Trưởng Vận Hành");
    assert.equal(adminOverview.employees[0].account.personnel_code, "EMP-OPSH");

    const { rows: [countsAfter] } = await db.query(
      `select (select count(*)::int from public.leave_audit_events) as leave_audits,
              (select count(*)::int from public.attendance_explanation_audit_events) as exp_audits,
              (select count(*)::int from public.organization_department_audit_events) as org_audits`,
    );
    assert.deepEqual(countsAfter, countsBefore, "Read-only admin overview must produce zero audit writes");
  } finally {
    await db.close();
  }
});
