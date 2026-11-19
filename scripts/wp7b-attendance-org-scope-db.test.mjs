/**
 * WP7B — Attendance on WP3 Org/Person + WP5 Paired Effective Access + Read-Only Leave Nav Probe
 * PGlite End-to-End Database, Contract, Strict Parser & Excel Export Regression Suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import ExcelJS from "exceljs";

import { projectAttendanceAdminReport } from "../src/lib/attendance/attendance-report-contract.ts";
import { projectAttendanceMonthlyMatrixReport } from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  describeMatrixDayCell,
  MATRIX_OUT_OF_SCOPE_LABEL,
} from "../src/lib/attendance/attendance-monthly-matrix-ui-model.ts";
import { buildAttendanceMonthlyMatrixXlsx } from "../src/lib/attendance/attendance-monthly-matrix-xlsx.ts";
import { WP7B_ATTENDANCE_ORG_SCOPE_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "17800000-0000-4000-8000-000000000001",
  app: "27800000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical",
};
const LUANPT = {
  auth: "17800000-0000-4000-8000-000000000002",
  app: "27800000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "17800000-0000-4000-8000-000000000003",
  app: "27800000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "17800000-0000-4000-8000-000000000004",
  app: "27800000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const HR_OP = {
  auth: "17800000-0000-4000-8000-000000000005",
  app: "27800000-0000-4000-8000-000000000005",
  email: "hr.op@hrpartner.vn",
  name: "HR Operator Global",
};
const HR_TL_COMBO = {
  auth: "17800000-0000-4000-8000-000000000006",
  app: "27800000-0000-4000-8000-000000000006",
  recruiter: "37800000-0000-4000-8000-000000000006",
  email: "hr.tl.combo@hrpartner.vn",
  name: "HR Plus Team Leader",
};
const TL_BETA = {
  auth: "17800000-0000-4000-8000-000000000007",
  app: "27800000-0000-4000-8000-000000000007",
  recruiter: "37800000-0000-4000-8000-000000000007",
  email: "tl.beta@hrpartner.vn",
  name: "Team Leader Beta",
};
const REC_TRANSFER = {
  auth: "17800000-0000-4000-8000-000000000008",
  app: "27800000-0000-4000-8000-000000000008",
  recruiter: "37800000-0000-4000-8000-000000000008",
  email: "rec.transfer@hrpartner.vn",
  name: "Recruiter MidMonth Transfer",
};
const MKT_HEAD = {
  auth: "17800000-0000-4000-8000-000000000009",
  app: "27800000-0000-4000-8000-000000000009",
  email: "mkt.head@hrpartner.vn",
  name: "MKT Head Alice",
};
const OPS_HEAD = {
  auth: "17800000-0000-4000-8000-000000000010",
  app: "27800000-0000-4000-8000-000000000010",
  email: "ops.head@hrpartner.vn",
  name: "Ops Head Charlie",
};
const FIN_HEAD = {
  auth: "17800000-0000-4000-8000-000000000011",
  app: "27800000-0000-4000-8000-000000000011",
  email: "fin.head@hrpartner.vn",
  name: "Finance Head Dave",
};
const DEPT_TRANSFER_EMP = {
  auth: "17800000-0000-4000-8000-000000000012",
  app: "27800000-0000-4000-8000-000000000012",
  email: "dept.transfer@hrpartner.vn",
  name: "Employee Dept Transfer",
};
const SAME_DAY_EMP = {
  auth: "17800000-0000-4000-8000-000000000013",
  app: "27800000-0000-4000-8000-000000000013",
  email: "sameday.emp@hrpartner.vn",
  name: "Employee Same Day Transfer",
};
const HIST_GAP_EMP = {
  auth: "17800000-0000-4000-8000-000000000014",
  app: "27800000-0000-4000-8000-000000000014",
  email: "hist.gap@hrpartner.vn",
  name: "Employee Backfill Current Only",
};
const HEAD_AND_TL = {
  auth: "17800000-0000-4000-8000-000000000015",
  app: "27800000-0000-4000-8000-000000000015",
  recruiter: "37800000-0000-4000-8000-000000000015",
  email: "head.and.tl@hrpartner.vn",
  name: "Dual Head Plus TL",
};
const PM_ONLY = {
  auth: "17800000-0000-4000-8000-000000000016",
  app: "27800000-0000-4000-8000-000000000016",
  recruiter: "37800000-0000-4000-8000-000000000016",
  email: "pm.only@hrpartner.vn",
  name: "PM Only",
};
const ACCT_ONLY = {
  auth: "17800000-0000-4000-8000-000000000017",
  app: "27800000-0000-4000-8000-000000000017",
  email: "acct.only@hrpartner.vn",
  name: "Accountant Only",
};
const SHARED_ACC = {
  auth: "17800000-0000-4000-8000-000000000018",
  app: "27800000-0000-4000-8000-000000000018",
  email: "shared.kiosk@hrpartner.vn",
  name: "Shared Kiosk Account",
};
const SERVICE_ACC = {
  auth: "17800000-0000-4000-8000-000000000019",
  app: "27800000-0000-4000-8000-000000000019",
  email: "svc.bot@hrpartner.vn",
  name: "Service Bot Account",
};
const LEGACY_SHARED_NORMAL = {
  auth: "17800000-0000-4000-8000-000000000020",
  app: "27800000-0000-4000-8000-000000000020",
  email: "mkt.legacy.shared@hrpartner.vn",
  name: "Legacy Shared Normal",
};
const UNLINKED_NORMAL = {
  auth: "17800000-0000-4000-8000-000000000021",
  app: "27800000-0000-4000-8000-000000000021",
  email: "unlinked.normal@hrpartner.vn",
  name: "Unlinked Normal Employee",
};
const CONFLICT_PERSON_SHARED = {
  auth: "17800000-0000-4000-8000-000000000022",
  app: "27800000-0000-4000-8000-000000000022",
  email: "conflict.person@hrpartner.vn",
  name: "Active Person Conflicting Legacy Shared",
};
const OFFICIAL_LEAVE_EMP = {
  auth: "17800000-0000-4000-8000-000000000023",
  app: "27800000-0000-4000-8000-000000000023",
  email: "official.leave@hrpartner.vn",
  name: "Official Employee Zero Accrual Probe",
};
const DISABLED_HEAD = {
  auth: "17800000-0000-4000-8000-000000000024",
  app: "27800000-0000-4000-8000-000000000024",
  email: "disabled.head@hrpartner.vn",
  name: "Disabled Department Head",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  HR_OP,
  HR_TL_COMBO,
  TL_BETA,
  REC_TRANSFER,
  MKT_HEAD,
  OPS_HEAD,
  FIN_HEAD,
  DEPT_TRANSFER_EMP,
  SAME_DAY_EMP,
  HIST_GAP_EMP,
  HEAD_AND_TL,
  PM_ONLY,
  ACCT_ONLY,
  SHARED_ACC,
  SERVICE_ACC,
  LEGACY_SHARED_NORMAL,
  UNLINKED_NORMAL,
  CONFLICT_PERSON_SHARED,
  OFFICIAL_LEAVE_EMP,
  DISABLED_HEAD,
];

const TEAM_ALPHA = "47800000-0000-4000-8000-000000000001";
const TEAM_BETA = "47800000-0000-4000-8000-000000000002";
const TEAM_GAMMA = "47800000-0000-4000-8000-000000000003";

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `97800000-0000-4000-8000-${hex}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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

function stripOuterTransaction(sql) {
  return sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("set role service_role;");
  try {
    const { rows } = await db.query(
      `select public.${fnName}(${placeholders}) as res`,
      args,
    );
    return rows[0]?.res;
  } finally {
    await db.exec("reset role;");
  }
}

async function createSeededDb() {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  const migrations = await loadMigrations();
  for (const m of migrations) {
    await db.exec(m.sql);
  }

  for (const u of ALL_USERS) {
    await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
      [u.app, u.auth, u.name],
    );
  }

  // Bootstrap 4 canonical admins for WP5B-2 cutover
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

  // Run WP5B-2 cutover -> all accounts authz_managed = true, cutover_ready = true
  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  // Configure HQ location (needed for check-in distance calculations)
  const hqKey = nextUuid();
  await serviceRpc(db, "attendance_set_hq_location", [
    OWNER.auth,
    OWNER.app,
    21.0285,
    105.8542,
    0,
    hqKey,
    sha256(`hq:${hqKey}`),
  ]);

  // Seed Teams & Recruiters
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'WP7B_ALPHA', 'Team Alpha', true),
            ($2::uuid, 'WP7B_BETA', 'Team Beta', true),
            ($3::uuid, 'WP7B_GAMMA', 'Team Gamma', true)`,
    [TEAM_ALPHA, TEAM_BETA, TEAM_GAMMA],
  );
  for (const [u, code, pos, teamId] of [
    [HR_TL_COMBO, "NV-HRTL", "TEAM_LEADER", TEAM_ALPHA],
    [TL_BETA, "NV-TLB", "TEAM_LEADER", TEAM_BETA],
    [HEAD_AND_TL, "NV-HTL", "TEAM_LEADER", TEAM_GAMMA],
    [REC_TRANSFER, "NV-RECT", "STAFF", TEAM_ALPHA],
    [PM_ONLY, "NV-PM1", "STAFF", TEAM_BETA],
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
            ($4::uuid, $5::uuid, $6::uuid, '2026-01-01', true),
            ($7::uuid, $8::uuid, $9::uuid, '2026-01-01', true)`,
    [
      TEAM_ALPHA, HR_TL_COMBO.app, HR_TL_COMBO.recruiter,
      TEAM_BETA, TL_BETA.app, TL_BETA.recruiter,
      TEAM_GAMMA, HEAD_AND_TL.app, HEAD_AND_TL.recruiter,
    ],
  );
  // Sync legacy team scope & capability projections (matching canonical designate_team_leader RPC)
  for (const [tl, teamId] of [
    [HR_TL_COMBO, TEAM_ALPHA],
    [TL_BETA, TEAM_BETA],
    [HEAD_AND_TL, TEAM_GAMMA],
  ]) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
      [tl.app, teamId],
    );
    await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [tl.app]);
  }

  // Project + PM + Accountant
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name, active) values ('proj-wp7b', 'Dự án WP7B', true)",
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current) values ('proj-wp7b', $1::uuid, '2026-01-01', true)",
    [PM_ONLY.recruiter],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
  await db.query(
    `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
     values ('proj-wp7b', $1::uuid, 1, '2026-01-01', $2::uuid, 'Seed PA')`,
    [ACCT_ONLY.app, OWNER.app],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

  // Global roles via WP5 RPC
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
      `Assign ${roleCode} for WP7B test`,
      nextUuid(),
      sha256(`assign:${target.app}:${roleCode}:${seq}`),
    ]);
  }
  await assignRole(HR_OP, "HR_OPERATOR");
  await assignRole(HR_TL_COMBO, "HR_OPERATOR");

  // Special account types & legacy shared profiles
  await db.query(
    "update public.direct_entry_app_users set account_type = 'SHARED' where app_user_id = $1::uuid",
    [SHARED_ACC.app],
  );
  await db.query(
    "update public.direct_entry_app_users set account_type = 'SERVICE' where app_user_id = $1::uuid",
    [SERVICE_ACC.app],
  );
  await db.query(
    `insert into public.leave_employee_profiles (app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, official_effective_date)
     values ($1::uuid, true, 'UNCONFIGURED', 'UNCLASSIFIED', null, null),
            ($2::uuid, false, 'OFFICIAL', 'MARKETING', '2025-01-01', '2025-03-01'),
            ($3::uuid, true, 'OFFICIAL', 'MARKETING', '2025-01-01', '2025-03-01'),
            ($4::uuid, false, 'OFFICIAL', 'MARKETING', '2025-01-01', '2025-03-01')`,
    [LEGACY_SHARED_NORMAL.app, UNLINKED_NORMAL.app, CONFLICT_PERSON_SHARED.app, OFFICIAL_LEAVE_EMP.app],
  );

  // Departments: canonical MARKETING + custom OPERATIONS + custom FINANCE + custom ARCHIVE
  const { rows: [mktDept] } = await db.query(
    "select department_id from public.organization_departments where system_key = 'MARKETING'",
  );
  const opsDeptRes = await serviceRpc(db, "org_department_create_department_admin", [
    OWNER.auth,
    OWNER.app,
    "OPERATIONS",
    "Phòng Vận hành",
    "Tạo phòng ban động OPS",
    nextUuid(),
    sha256("create-ops"),
  ]);
  const finDeptRes = await serviceRpc(db, "org_department_create_department_admin", [
    OWNER.auth,
    OWNER.app,
    "FINANCE_CUSTOM",
    "Phòng Tài chính",
    "Tạo phòng ban động FIN",
    nextUuid(),
    sha256("create-fin"),
  ]);
  const disDeptRes = await serviceRpc(db, "org_department_create_department_admin", [
    OWNER.auth,
    OWNER.app,
    "DISABLED_DEPT",
    "Phòng Kiểm thử Khóa",
    "Tạo phòng ban động DIS",
    nextUuid(),
    sha256("create-dis"),
  ]);
  const mktDeptId = mktDept.department_id;
  const opsDeptId = opsDeptRes.department.department_id;
  const finDeptId = finDeptRes.department.department_id;
  const disDeptId = disDeptRes.department.department_id;

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
      `Tạo hồ sơ ${code}`,
      nextUuid(),
      sha256(`person:${code}:${seq}`),
    ]);
    return res.person;
  }

  const pMktHead = await createLinkedPerson(MKT_HEAD, "EMP-MKTH", "Nguyễn Thị Trưởng MKT", mktDeptId);
  const pOpsHead = await createLinkedPerson(OPS_HEAD, "EMP-OPSH", "Trần Văn Trưởng OPS", opsDeptId);
  const pFinHead = await createLinkedPerson(FIN_HEAD, "EMP-FINH", "Lê Văn Trưởng FIN", finDeptId);
  const pDeptTransfer = await createLinkedPerson(DEPT_TRANSFER_EMP, "EMP-DTR", "Phạm Văn Chuyển Phòng", mktDeptId);
  const pSameDay = await createLinkedPerson(SAME_DAY_EMP, "EMP-SDT", "Hoàng Thị Cùng Ngày", mktDeptId);
  const pHistGap = await createLinkedPerson(HIST_GAP_EMP, "EMP-HGAP", "Đỗ Văn Thiếu Lịch Sử", mktDeptId);
  const pHeadAndTl = await createLinkedPerson(HEAD_AND_TL, "EMP-HTL", "Vũ Văn Kiêm Nhiệm", mktDeptId);
  const pConflict = await createLinkedPerson(CONFLICT_PERSON_SHARED, "EMP-CONF", "Bùi Văn Xung Đột", mktDeptId);
  const pOfficialLeave = await createLinkedPerson(OFFICIAL_LEAVE_EMP, "EMP-LV", "Ngô Thị Phép Năm", mktDeptId);
  const pDisabledHead = await createLinkedPerson(DISABLED_HEAD, "EMP-DISH", "Trưởng Phòng Bị Khóa", disDeptId);

  // Backdate links & initial memberships to 2026-10-01 00:00:00+07 so October 2026 is fully covered
  // (temporarily suspend WP3 close-only temporal history guard strictly for fixture backdating)
  await db.exec(`
    alter table public.organization_account_person_links disable trigger user;
    alter table public.organization_person_department_memberships disable trigger user;
  `);
  await db.query(
    `update public.organization_account_person_links
        set started_at = '2026-10-01 00:00:00+07'::timestamptz
      where app_user_id <> $1::uuid`,
    [HIST_GAP_EMP.app],
  );
  await db.query(
    `update public.organization_person_department_memberships
        set started_at = '2026-10-01 00:00:00+07'::timestamptz
      where person_id <> $1::uuid`,
    [pHistGap.person_id],
  );
  // HIST_GAP_EMP simulates BACKFILL_CURRENT_STATE_ONLY starting 2026-10-20 00:00+07
  await db.query(
    `update public.organization_account_person_links
        set started_at = '2026-10-20 00:00:00+07'::timestamptz,
            source_kind = 'BACKFILL_CURRENT_STATE_ONLY'
      where app_user_id = $1::uuid`,
    [HIST_GAP_EMP.app],
  );
  await db.query(
    `update public.organization_person_department_memberships
        set started_at = '2026-10-20 00:00:00+07'::timestamptz,
            source_kind = 'BACKFILL_CURRENT_STATE_ONLY'
      where person_id = $1::uuid`,
    [pHistGap.person_id],
  );
  await db.exec(`
    alter table public.organization_account_person_links enable trigger user;
    alter table public.organization_person_department_memberships enable trigger user;
  `);

  // Designate department heads via canonical WP3 RPC
  async function designateHead(deptId, personId) {
    const { rows: [d] } = await db.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [deptId],
    );
    return serviceRpc(db, "org_department_designate_head_admin", [
      OWNER.auth,
      OWNER.app,
      deptId,
      personId,
      d.version,
      null,
      "Bổ nhiệm trưởng phòng WP7B",
      nextUuid(),
      sha256(`head:${deptId}:${personId}:${seq}`),
    ]);
  }
  await designateHead(mktDeptId, pMktHead.person_id);
  await designateHead(opsDeptId, pOpsHead.person_id);
  await designateHead(finDeptId, pFinHead.person_id);
  await designateHead(disDeptId, pDisabledHead.person_id);

  // Disable DISABLED_HEAD account after designation
  await db.query(
    "update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid",
    [DISABLED_HEAD.app],
  );

  return {
    db,
    depts: { mktDeptId, opsDeptId, finDeptId, disDeptId },
    persons: {
      pMktHead,
      pOpsHead,
      pFinHead,
      pDeptTransfer,
      pSameDay,
      pHistGap,
      pHeadAndTl,
      pConflict,
      pOfficialLeave,
      pDisabledHead,
    },
  };
}

async function seedCheckin(db, appUserId, businessDate, hhmm, photoKey) {
  const checkinId = nextUuid();
  const idemKey = nextUuid();
  const capturedAt = `${businessDate} ${hhmm}:00+07`;
  const { rows: [cnt] } = await db.query(
    "select count(*)::int as n from public.attendance_checkins where app_user_id = $1::uuid and business_date = $2::date",
    [appUserId, businessDate],
  );
  const seqInDay = cnt.n + 1;
  await db.query(
    `insert into public.attendance_checkins (
       checkin_id, app_user_id, idempotency_key, request_fingerprint,
       business_date, sequence_in_day, latitude, longitude, accuracy_meters,
       distance_meters,
       photo_storage_key, photo_sha256, photo_size_bytes, photo_mime_type,
       captured_at, received_at, time_source, time_verified, device_claimed_at,
       time_anchor_issued_at, elapsed_since_anchor_ms, sync_delay_seconds,
       time_token_digest, distance_target_kind
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5::date, $6, 21.0285, 105.8542, 10,
       0,
       $7, $8, 12345, 'image/jpeg',
       $9::timestamptz, $9::timestamptz, 'SERVER_ANCHORED', true, $9::timestamptz,
       $9::timestamptz, 0, 0,
       $10, 'HQ'
     )`,
    [
      checkinId,
      appUserId,
      idemKey,
      sha256(`fp:${checkinId}`),
      businessDate,
      seqInDay,
      photoKey ?? `private/attendance/${appUserId}/${checkinId}.jpg`,
      sha256(`photo:${checkinId}`),
      capturedAt,
      sha256(`tok:${checkinId}`),
    ],
  );
  return checkinId;
}

async function seedApprovedLeaveDay(db, appUserId, leaveDate) {
  const requestId = nextUuid();
  const dayId = nextUuid();
  await db.query(
    `insert into public.leave_requests (
       request_id, app_user_id, status, pay_treatment,
       employment_status_snapshot, unit_kind_snapshot, profile_configured_at_submit,
       requested_units, reason, route_kind, primary_approver_app_user_id,
       decided_at, decided_by_app_user_id, row_version
     ) values (
       $1::uuid, $2::uuid, 'APPROVED', 'PAID_LEAVE',
       'OFFICIAL', 'MARKETING', true,
       2, 'Nghỉ phép kiểm thử WP7B', 'ADMIN_BOD_DIRECT', $3::uuid,
       now(), $3::uuid, 2
     )`,
    [requestId, appUserId, OWNER.app],
  );
  await db.query(
    `insert into public.leave_request_days (
       request_day_id, request_id, app_user_id, leave_date, session_code, half_day_units, leave_type, is_active
     ) values ($1::uuid, $2::uuid, $3::uuid, $4::date, 'FULL', 2, 'ANNUAL', true)`,
    [dayId, requestId, appUserId, leaveDate],
  );
}

async function seedApprovedExplanation(db, appUserId, businessDate, slotCode = "SLOT_1") {
  const expId = nextUuid();
  await db.query(
    `insert into public.attendance_explanations (
       explanation_id, app_user_id, business_date, slot_code,
       slot_index, slot_label, session_code, target_time,
       grace_before_minutes, grace_after_minutes, policy_version_used,
       original_slot_status, reason, status, route_kind,
       primary_approver_app_user_id, decided_by_app_user_id, decided_at, decision_note
     ) values (
       $1::uuid, $2::uuid, $3::date, $4,
       1, 'Sáng vào', 'AM', '08:00',
       60, 30, 1,
       'MISSING', 'Giải trình kiểm thử WP7B', 'APPROVED', 'ADMIN_BOD_DIRECT',
       $5::uuid, $5::uuid, now(), 'Đã duyệt'
     )`,
    [expId, appUserId, businessDate, slotCode, OWNER.app],
  );
}

test("1. WP7B migration hygiene: zero at-signs, zero SAVEPOINT, atomic rollback, STABLE nav probe & strict ACLs", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP7B_ATTENDANCE_ORG_SCOPE_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("@"), false, "WP7B migration must contain zero @ characters");
  assert.equal(/\bSAVEPOINT\b/i.test(sql), false, "WP7B migration must contain zero literal SAVEPOINT");

  const db = new PGlite();
  try {
    await db.exec(PROLOGUE);
    const migrations = await loadMigrations();
    const wp7bIdx = migrations.findIndex((m) => m.name === WP7B_ATTENDANCE_ORG_SCOPE_MIGRATION_NAME);
    assert.ok(wp7bIdx > 0, "WP7B migration must exist in supabase/migrations");
    for (const m of migrations.slice(0, wp7bIdx)) {
      await db.exec(m.sql);
    }

    // Atomic rollback rehearsal
    await db.exec(`begin;\n${stripOuterTransaction(migrations[wp7bIdx].sql)}\nrollback;`);
    const { rows: afterRb } = await db.query(
      "select proname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'leave_management_get_actor_access'",
    );
    assert.equal(afterRb.length, 0, "Rolled-back WP7B rehearsal must leave zero drift");

    // Apply cleanly and inspect STABLE + ACL invariants
    await db.exec(migrations[wp7bIdx].sql);
    const { rows: [probe] } = await db.query(
      `select p.provolatile, p.prosecdef, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'leave_management_get_actor_access'`,
    );
    assert.equal(probe.provolatile, "s", "leave_management_get_actor_access must be STABLE");
    assert.equal(probe.prosecdef, true);
    assert.equal(probe.pub_exec, false);
    assert.equal(probe.anon_exec, false);
    assert.equal(probe.auth_exec, false);
    assert.equal(probe.svc_exec, true);

    const { rows: internalLeaks } = await db.query(
      `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'attendance__internal_%'
          and (
            has_function_privilege('public', p.oid, 'EXECUTE')
            or has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('service_role', p.oid, 'EXECUTE')
          )`,
    );
    assert.deepEqual(internalLeaks, [], "Zero attendance__internal_* helpers may be executable by client/service_role");
  } finally {
    await db.close();
  }
});

test("2. D-WP7B-01: DEPARTMENT_HEAD attendance report scope, revoke lifecycle, dual-role TL preservation, HR+TL escalation block & config denial", async () => {
  const { db, depts, persons } = await createSeededDb();
  try {
    // Seed check-ins across MKT, OPS, TEAM_ALPHA, TEAM_GAMMA on 2026-10-10
    const mktPhotoKey = `private/attendance/${DEPT_TRANSFER_EMP.app}/mkt-10.jpg`;
    const opsPhotoKey = `private/attendance/${OPS_HEAD.app}/ops-10.jpg`;
    const alphaPhotoKey = `private/attendance/${REC_TRANSFER.app}/alpha-10.jpg`;
    const gammaPhotoKey = `private/attendance/${HEAD_AND_TL.app}/gamma-10.jpg`;

    const mktCheckinId = await seedCheckin(db, DEPT_TRANSFER_EMP.app, "2026-10-10", "08:05", mktPhotoKey);
    const opsCheckinId = await seedCheckin(db, OPS_HEAD.app, "2026-10-10", "08:10", opsPhotoKey);
    const alphaCheckinId = await seedCheckin(db, REC_TRANSFER.app, "2026-10-10", "08:15", alphaPhotoKey);
    const gammaCheckinId = await seedCheckin(db, HEAD_AND_TL.app, "2026-10-10", "08:20", gammaPhotoKey);

    // 2a. Actor context for MKT_HEAD keeps exact keys and active DEPARTMENT_HEAD role
    const mktActorCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [MKT_HEAD.auth]);
    assert.ok(
      mktActorCtx.assigned_roles.some(
        (r) =>
          r.role_code === "DEPARTMENT_HEAD" &&
          r.scope_kind === "CONTEXT_DEPARTMENT" &&
          r.scope_id === depts.mktDeptId,
      ),
      "MKT_HEAD actor context must expose active DEPARTMENT_HEAD role",
    );
    assert.equal(mktActorCtx.capabilities.length, 0, "Pure DEPARTMENT_HEAD must keep zero global capabilities");

    // 2b. MKT_HEAD reads report, matrix & photo strictly within MKT
    const mktReportRaw = await serviceRpc(db, "attendance_admin_report", [
      MKT_HEAD.auth, MKT_HEAD.app, "2026-10-01", "2026-10-31", 1, 50, null, null,
    ]);
    const mktReport = projectAttendanceAdminReport(mktReportRaw);
    assert.ok(mktReport, "MKT_HEAD attendance_admin_report must pass strict contract parser");
    assert.equal(mktReport.current_hq, null, "Scoped DEPARTMENT_HEAD must not receive HQ config");
    assert.equal(mktReport.viewer.can_configure_hq, false);
    const mktCheckinIds = mktReport.items.map((i) => i.checkin_id);
    assert.ok(mktCheckinIds.includes(mktCheckinId));
    assert.ok(!mktCheckinIds.includes(opsCheckinId), "MKT_HEAD must not see OPS check-ins");
    assert.ok(!mktCheckinIds.includes(alphaCheckinId), "MKT_HEAD must not see TEAM_ALPHA check-ins");
    const mktEmpOptionIds = mktReport.employee_options.map((o) => o.app_user_id);
    assert.ok(mktEmpOptionIds.includes(DEPT_TRANSFER_EMP.app));
    assert.ok(!mktEmpOptionIds.includes(OPS_HEAD.app));
    assert.ok(!mktEmpOptionIds.includes(REC_TRANSFER.app));

    const mktMatrixRaw = await serviceRpc(db, "attendance_monthly_matrix_report", [
      MKT_HEAD.auth, MKT_HEAD.app, "2026-10", null, null, null, 1, 50,
    ]);
    const mktMatrix = projectAttendanceMonthlyMatrixReport(mktMatrixRaw);
    assert.ok(mktMatrix, "MKT_HEAD attendance_monthly_matrix_report must pass strict contract parser");
    assert.equal(mktMatrix.current_hq, null);
    const mktMatrixEmpIds = mktMatrix.items.map((i) => i.app_user_id);
    assert.ok(mktMatrixEmpIds.includes(DEPT_TRANSFER_EMP.app));
    assert.ok(!mktMatrixEmpIds.includes(OPS_HEAD.app));
    assert.ok(!mktMatrixEmpIds.includes(REC_TRANSFER.app));

    // Photo access: allowed for MKT, denied for OPS & TEAM_ALPHA
    const allowedPhoto = await serviceRpc(db, "attendance_admin_checkin_photo", [
      MKT_HEAD.auth, MKT_HEAD.app, mktCheckinId,
    ]);
    assert.equal(allowedPhoto.photo_storage_key, mktPhotoKey);
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, opsCheckinId]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, alphaCheckinId]),
      (err) => err?.code === "42501",
    );

    // 2c. MKT_HEAD denied on ALL attendance config/admin RPCs
    await assert.rejects(
      () => serviceRpc(db, "attendance_set_hq_location", [
        MKT_HEAD.auth, MKT_HEAD.app, 21.0, 105.8, 1, nextUuid(), sha256("deny-hq"),
      ]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_list_branches_admin", [MKT_HEAD.auth, MKT_HEAD.app, true]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_get_slot_policies_admin", [MKT_HEAD.auth, MKT_HEAD.app]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_upsert_branch_admin", [
        MKT_HEAD.auth, MKT_HEAD.app, null, "BR_DENY", "Deny", "Addr", 21.0, 105.8, true, 0, nextUuid(), sha256("deny-br"),
      ]),
      (err) => err?.code === "42501",
    );

    // 2d. HR_OPERATOR @ ALL + TEAM_LEADER @ TEAM_ALPHA must NOT escalate to ALL scope
    const hrTlReportRaw = await serviceRpc(db, "attendance_admin_report", [
      HR_TL_COMBO.auth, HR_TL_COMBO.app, "2026-10-01", "2026-10-31", 1, 50, null, null,
    ]);
    const hrTlReport = projectAttendanceAdminReport(hrTlReportRaw);
    assert.ok(hrTlReport);
    assert.equal(hrTlReport.current_hq, null, "HR_OPERATOR+TL must stay team-scoped, never escalate to ALL");
    assert.deepEqual(
      hrTlReport.items.map((i) => i.checkin_id),
      [alphaCheckinId],
      "HR_OPERATOR+TL sees ONLY TEAM_ALPHA check-ins",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_list_branches_admin", [HR_TL_COMBO.auth, HR_TL_COMBO.app, true]),
      (err) => err?.code === "42501",
      "HR_OPERATOR+TL must be rejected on attendance_list_branches_admin (paired ALL check)",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_get_slot_policies_admin", [HR_TL_COMBO.auth, HR_TL_COMBO.app]),
      (err) => err?.code === "42501",
      "HR_OPERATOR+TL must be rejected on attendance_get_slot_policies_admin (paired ALL check)",
    );

    // 2e. Non-report roles (HR_OPERATOR global, PM, ACCOUNTANT, ordinary employee, disabled HEAD) are rejected
    for (const deniedActor of [HR_OP, PM_ONLY, ACCT_ONLY, DEPT_TRANSFER_EMP, DISABLED_HEAD]) {
      await assert.rejects(
        () => serviceRpc(db, "attendance_admin_report", [
          deniedActor.auth, deniedActor.app, "2026-10-01", "2026-10-31", 1, 20, null, null,
        ]),
        (err) => err?.code === "42501",
        `${deniedActor.email} must be denied attendance_admin_report`,
      );
      await assert.rejects(
        () => serviceRpc(db, "attendance_monthly_matrix_report", [
          deniedActor.auth, deniedActor.app, "2026-10", null, null, null, 1, 20,
        ]),
        (err) => err?.code === "42501",
        `${deniedActor.email} must be denied attendance_monthly_matrix_report`,
      );
    }

    // 2f. Revoke MKT_HEAD -> immediately loses department attendance access
    const { rows: [mktDeptVer] } = await db.query(
      `select d.version, h.head_assignment_id
         from public.organization_departments d
         join public.organization_department_heads h
           on h.department_id = d.department_id and h.ended_at is null
        where d.department_id = $1::uuid`,
      [depts.mktDeptId],
    );
    await serviceRpc(db, "org_department_end_head_admin", [
      OWNER.auth, OWNER.app, depts.mktDeptId, mktDeptVer.version, mktDeptVer.head_assignment_id, "Thu hồi trưởng phòng MKT", nextUuid(), sha256("end-mkt-head"),
    ]);
    const revokedCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [MKT_HEAD.auth]);
    assert.equal(
      revokedCtx.assigned_roles.some((r) => r.role_code === "DEPARTMENT_HEAD"),
      false,
      "Revoked HEAD must immediately lose DEPARTMENT_HEAD from actor context",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_report", [
        MKT_HEAD.auth, MKT_HEAD.app, "2026-10-01", "2026-10-31", 1, 20, null, null,
      ]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, mktCheckinId]),
      (err) => err?.code === "42501",
    );

    // 2g. Dual-role HEAD_AND_TL: assign HEAD of MKT, verify sees MKT + TEAM_GAMMA, then revoke HEAD -> loses MKT, keeps TEAM_GAMMA
    const { rows: [mktV2] } = await db.query(
      "select version from public.organization_departments where department_id = $1::uuid",
      [depts.mktDeptId],
    );
    await serviceRpc(db, "org_department_designate_head_admin", [
      OWNER.auth, OWNER.app, depts.mktDeptId, persons.pHeadAndTl.person_id, mktV2.version, null, "Bổ nhiệm kiêm nhiệm", nextUuid(), sha256("dual-head-on"),
    ]);
    const dualBefore = await serviceRpc(db, "attendance_admin_report", [
      HEAD_AND_TL.auth, HEAD_AND_TL.app, "2026-10-01", "2026-10-31", 1, 50, null, null,
    ]);
    assert.ok(dualBefore.items.some((i) => i.checkin_id === mktCheckinId));
    assert.ok(dualBefore.items.some((i) => i.checkin_id === gammaCheckinId));

    const { rows: [mktV3] } = await db.query(
      `select d.version, h.head_assignment_id
         from public.organization_departments d
         join public.organization_department_heads h
           on h.department_id = d.department_id and h.ended_at is null
        where d.department_id = $1::uuid`,
      [depts.mktDeptId],
    );
    await serviceRpc(db, "org_department_end_head_admin", [
      OWNER.auth, OWNER.app, depts.mktDeptId, mktV3.version, mktV3.head_assignment_id, "Thu hồi HEAD giữ TL", nextUuid(), sha256("dual-head-off"),
    ]);
    const dualAfter = await serviceRpc(db, "attendance_admin_report", [
      HEAD_AND_TL.auth, HEAD_AND_TL.app, "2026-10-01", "2026-10-31", 1, 50, null, null,
    ]);
    assert.equal(dualAfter.items.some((i) => i.checkin_id === mktCheckinId), false, "Revoked HEAD loses MKT");
    assert.equal(dualAfter.items.some((i) => i.checkin_id === gammaCheckinId), true, "Independent TL role survives HEAD revoke");
  } finally {
    await db.close();
  }
});

test("3. D-WP7B-02: Per-day as-of filtering on dept/team transfers, same-day transfer, missing history, additive totals, photo 200/403, strict parser & XLSX export", async () => {
  const { db, depts, persons } = await createSeededDb();
  try {
    // 3a. Mid-month Department Transfer for DEPT_TRANSFER_EMP:
    //     MKT: [2026-10-01 00:00+07, 2026-10-15 00:00+07)  (days 1..14)
    //     OPS: [2026-10-15 00:00+07, infinity)             (days 15..31)
    await db.exec("alter table public.organization_person_department_memberships disable trigger user;");
    await db.query(
      `update public.organization_person_department_memberships
          set ended_at = '2026-10-15 00:00:00+07'::timestamptz
        where person_id = $1::uuid and ended_at is null`,
      [persons.pDeptTransfer.person_id],
    );
    await db.query(
      `insert into public.organization_person_department_memberships (
         person_id, department_id, started_at, ended_at, source_kind, reason
       ) values ($1::uuid, $2::uuid, '2026-10-15 00:00:00+07'::timestamptz, null, 'ADMIN_MUTATION', 'Chuyển phòng giữa tháng')`,
      [persons.pDeptTransfer.person_id, depts.opsDeptId],
    );
    await db.exec("alter table public.organization_person_department_memberships enable trigger user;");

    // Branch BR_OPS assigned ONLY from 2026-10-15 (must NOT leak to MKT_HEAD!)
    const brRes = await serviceRpc(db, "attendance_upsert_branch_admin", [
      OWNER.auth, OWNER.app, null, "BR_OPS_ONLY", "Chi nhánh OPS", "OPS Street", 21.03, 105.85, true, 0, nextUuid(), sha256("br-ops"),
    ]);
    const brOpsId = brRes.branch.branch_id;
    await db.query(
      `insert into public.attendance_branch_assignments (
         app_user_id, branch_id, valid_from, valid_to, assigned_by_user_id,
         idempotency_key, request_fingerprint, version
       ) values ($1::uuid, $2::uuid, '2026-10-15', null, $3::uuid, $4::uuid, $5, 1)`,
      [DEPT_TRANSFER_EMP.app, brOpsId, OWNER.app, nextUuid(), sha256("seed-br-ops")],
    );

    // Check-ins, approved leaves, approved explanations in both halves of October 2026
    const mktHalfCheckin = await seedCheckin(db, DEPT_TRANSFER_EMP.app, "2026-10-10", "08:05", "private/dtr/10.jpg");
    const opsHalfCheckin = await seedCheckin(db, DEPT_TRANSFER_EMP.app, "2026-10-20", "08:05", "private/dtr/20.jpg");
    await seedApprovedExplanation(db, DEPT_TRANSFER_EMP.app, "2026-10-11", "SLOT_1");
    await seedApprovedExplanation(db, DEPT_TRANSFER_EMP.app, "2026-10-21", "SLOT_1");
    await seedApprovedLeaveDay(db, DEPT_TRANSFER_EMP.app, "2026-10-12");
    await seedApprovedLeaveDay(db, DEPT_TRANSFER_EMP.app, "2026-10-22");

    // 3b. Mid-month Team Transfer for REC_TRANSFER:
    //     TEAM_ALPHA: [2026-10-01, 2026-10-15) (days 1..14)
    //     TEAM_BETA:  [2026-10-15, null)       (days 15..31)
    await db.query(
      `update public.recruiter_team_memberships
          set valid_to = '2026-10-15', is_current = false
        where recruiter_id = $1::uuid and is_current = true`,
      [REC_TRANSFER.recruiter],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
       values ($1::uuid, $2::uuid, '2026-10-15', null, true)`,
      [REC_TRANSFER.recruiter, TEAM_BETA],
    );
    const alphaHalfCheckin = await seedCheckin(db, REC_TRANSFER.app, "2026-10-08", "08:05", "private/rec/08.jpg");
    const betaHalfCheckin = await seedCheckin(db, REC_TRANSFER.app, "2026-10-24", "08:05", "private/rec/24.jpg");

    // 3c. Same-day double transfer on 2026-10-18 for SAME_DAY_EMP:
    //     MKT [Oct 01 .. Oct 18 10:00) -> OPS [Oct 18 10:00 .. Oct 18 14:00) -> FIN [Oct 18 14:00 .. inf)
    //     Check-in at 08:10 on Oct 18 -> last effective owner on Oct 18 is FIN!
    await db.exec("alter table public.organization_person_department_memberships disable trigger user;");
    await db.query(
      `update public.organization_person_department_memberships
          set ended_at = '2026-10-18 10:00:00+07'::timestamptz
        where person_id = $1::uuid and ended_at is null`,
      [persons.pSameDay.person_id],
    );
    await db.query(
      `insert into public.organization_person_department_memberships (person_id, department_id, started_at, ended_at, source_kind, reason)
       values ($1::uuid, $2::uuid, '2026-10-18 10:00:00+07'::timestamptz, '2026-10-18 14:00:00+07'::timestamptz, 'ADMIN_MUTATION', 'Chuyển lần 1 trong ngày'),
              ($1::uuid, $3::uuid, '2026-10-18 14:00:00+07'::timestamptz, null, 'ADMIN_MUTATION', 'Chuyển lần 2 trong ngày')`,
      [persons.pSameDay.person_id, depts.opsDeptId, depts.finDeptId],
    );
    await db.exec("alter table public.organization_person_department_memberships enable trigger user;");
    const sameDayCheckin = await seedCheckin(db, SAME_DAY_EMP.app, "2026-10-18", "08:10", "private/sdt/18.jpg");

    // 3d. Missing historical membership before started_at (2026-10-20) for HIST_GAP_EMP:
    //     Check-in on Oct 05 MUST NOT be back-projected into MKT_HEAD; Oct 25 IS in MKT_HEAD!
    const preBackfillCheckin = await seedCheckin(db, HIST_GAP_EMP.app, "2026-10-05", "08:05", "private/hgap/05.jpg");
    const postBackfillCheckin = await seedCheckin(db, HIST_GAP_EMP.app, "2026-10-25", "08:05", "private/hgap/25.jpg");

    // --- Verify MKT_HEAD vs OPS_HEAD vs ADMIN on DEPT_TRANSFER_EMP ---
    const [mktMatrixRaw, opsMatrixRaw, adminMatrixRaw] = await Promise.all([
      serviceRpc(db, "attendance_monthly_matrix_report", [
        MKT_HEAD.auth, MKT_HEAD.app, "2026-10", null, DEPT_TRANSFER_EMP.app, null, 1, 20,
      ]),
      serviceRpc(db, "attendance_monthly_matrix_report", [
        OPS_HEAD.auth, OPS_HEAD.app, "2026-10", null, DEPT_TRANSFER_EMP.app, null, 1, 20,
      ]),
      serviceRpc(db, "attendance_monthly_matrix_report", [
        OWNER.auth, OWNER.app, "2026-10", null, DEPT_TRANSFER_EMP.app, null, 1, 20,
      ]),
    ]);

    const mktMatrix = projectAttendanceMonthlyMatrixReport(mktMatrixRaw);
    const opsMatrix = projectAttendanceMonthlyMatrixReport(opsMatrixRaw);
    const adminMatrix = projectAttendanceMonthlyMatrixReport(adminMatrixRaw);
    assert.ok(mktMatrix && opsMatrix && adminMatrix, "All 3 matrix payloads must pass strict parser");

    const mktRow = mktMatrix.items[0];
    const opsRow = opsMatrix.items[0];
    const adminRow = adminMatrix.items[0];
    assert.equal(mktRow.app_user_id, DEPT_TRANSFER_EMP.app);
    assert.equal(opsRow.app_user_id, DEPT_TRANSFER_EMP.app);

    // Branch isolation: MKT_HEAD must NOT leak BR_OPS_ONLY
    assert.equal(mktRow.branch, null, "MKT_HEAD must not leak branch assigned strictly after transfer");
    assert.equal(
      mktMatrix.branch_options.some((b) => b.branch_id === brOpsId),
      false,
      "MKT_HEAD branch_options must not leak BR_OPS_ONLY",
    );
    assert.equal(opsRow.branch?.branch_id, brOpsId, "OPS_HEAD sees BR_OPS_ONLY");

    // Out-of-scope cells leak ZERO sensitive data & zero missing counts
    const mktDay10 = mktRow.days.find((d) => d.business_date === "2026-10-10");
    const mktDay20 = mktRow.days.find((d) => d.business_date === "2026-10-20");
    const mktDay21 = mktRow.days.find((d) => d.business_date === "2026-10-21");
    const mktDay22 = mktRow.days.find((d) => d.business_date === "2026-10-22");
    assert.equal(mktDay10.has_checkin, true);
    assert.equal(mktDay20.day_status, "UPCOMING");
    assert.equal(mktDay20.has_checkin, false);
    assert.equal(mktDay20.checkin_count, 0);
    assert.equal(mktDay20.missing_slot_count, 0);
    assert.equal(mktDay20.branch_code_used, null);
    assert.equal(mktDay20.policy_profile_code_used, "DEFAULT");
    assert.ok(mktDay20.slots.every((s) => s.slot_status === "UPCOMING" && s.checkins.length === 0 && s.explanation === null));
    assert.equal(mktDay21.slots.every((s) => s.slot_status === "UPCOMING" && s.explanation === null), true);
    assert.deepEqual(mktDay22.approved_leaves, []);
    assert.equal(mktDay22.day_status, "UPCOMING");

    const opsDay10 = opsRow.days.find((d) => d.business_date === "2026-10-10");
    const opsDay11 = opsRow.days.find((d) => d.business_date === "2026-10-11");
    const opsDay12 = opsRow.days.find((d) => d.business_date === "2026-10-12");
    const opsDay20 = opsRow.days.find((d) => d.business_date === "2026-10-20");
    assert.equal(opsDay20.has_checkin, true);
    assert.equal(opsDay10.day_status, "UPCOMING");
    assert.equal(opsDay10.has_checkin, false);
    assert.equal(opsDay10.missing_slot_count, 0);
    assert.equal(opsDay11.slots.every((s) => s.slot_status === "UPCOMING" && s.explanation === null), true);
    assert.deepEqual(opsDay12.approved_leaves, []);

    // Exact additive partition: MKT + OPS == ADMIN
    assert.equal(
      mktRow.summary.checkin_day_count + opsRow.summary.checkin_day_count,
      adminRow.summary.checkin_day_count,
      "checkin_day_count must partition additively without double count",
    );
    assert.equal(
      mktRow.summary.total_checkins + opsRow.summary.total_checkins,
      adminRow.summary.total_checkins,
    );
    assert.equal(
      mktRow.summary.approved_leave_day_count + opsRow.summary.approved_leave_day_count,
      adminRow.summary.approved_leave_day_count,
    );
    assert.equal(
      mktRow.summary.no_checkin_day_count + opsRow.summary.no_checkin_day_count,
      adminRow.summary.no_checkin_day_count,
      "no_checkin_day_count must partition additively with zero fake missing on out-of-scope days",
    );
    assert.equal(
      mktRow.summary.no_checkin_without_leave_day_count + opsRow.summary.no_checkin_without_leave_day_count,
      adminRow.summary.no_checkin_without_leave_day_count,
    );
    assert.equal(
      mktMatrix.overview.total_checkins + opsMatrix.overview.total_checkins,
      adminMatrix.overview.total_checkins,
    );

    // Check-in report & Photo 200 vs 403 consistency
    const mktCheckins = await serviceRpc(db, "attendance_admin_report", [
      MKT_HEAD.auth, MKT_HEAD.app, "2026-10-01", "2026-10-31", 1, 50, null, DEPT_TRANSFER_EMP.app,
    ]);
    const opsCheckins = await serviceRpc(db, "attendance_admin_report", [
      OPS_HEAD.auth, OPS_HEAD.app, "2026-10-01", "2026-10-31", 1, 50, null, DEPT_TRANSFER_EMP.app,
    ]);
    assert.deepEqual(mktCheckins.items.map((i) => i.checkin_id), [mktHalfCheckin]);
    assert.deepEqual(opsCheckins.items.map((i) => i.checkin_id), [opsHalfCheckin]);

    assert.equal(
      (await serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, mktHalfCheckin])).photo_storage_key,
      "private/dtr/10.jpg",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, opsHalfCheckin]),
      (err) => err?.code === "42501",
    );
    assert.equal(
      (await serviceRpc(db, "attendance_admin_checkin_photo", [OPS_HEAD.auth, OPS_HEAD.app, opsHalfCheckin])).photo_storage_key,
      "private/dtr/20.jpg",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [OPS_HEAD.auth, OPS_HEAD.app, mktHalfCheckin]),
      (err) => err?.code === "42501",
    );

    // UI model + real ExcelJS workbook verification for out-of-scope past days
    const presOut = describeMatrixDayCell(mktDay20, { todayBusinessDate: "2026-10-25" });
    assert.equal(presOut.isOutOfScopeOrExempt, true);
    assert.equal(presOut.isRedHighlight, false);
    assert.equal(presOut.statusLabel, MATRIX_OUT_OF_SCOPE_LABEL);

    const xlsxBytes = await buildAttendanceMonthlyMatrixXlsx(mktMatrix, {
      todayBusinessDate: "2026-10-25",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBytes);
    const sheet1 = wb.worksheets[0];
    const sheet2 = wb.worksheets[1];
    const headerRow = sheet1.getRow(1).values;
    const day20ColIdx = headerRow.findIndex((v) => typeof v === "string" && v.startsWith("20 ("));
    assert.ok(day20ColIdx > 0, "Sheet 1 must contain day 20 column");
    const mktEmpSheet1Row = sheet1.getRow(2);
    assert.equal(mktEmpSheet1Row.getCell(day20ColIdx).value, "— (Ngoài phạm vi)");
    assert.equal(mktEmpSheet1Row.getCell(day20ColIdx).fill?.fgColor?.argb, "FFF1F5F9");

    let foundSheet2Day20 = false;
    sheet2.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(1).value === "2026-10-20") {
        foundSheet2Day20 = true;
        assert.equal(row.getCell(5).value, MATRIX_OUT_OF_SCOPE_LABEL);
        assert.equal(row.getCell(8).value, "—");
      }
    });
    assert.equal(foundSheet2Day20, true, "Sheet 2 must render out-of-scope day cleanly");

    // --- Verify Team mid-month transfer (TEAM_ALPHA vs TEAM_BETA) ---
    const alphaRep = await serviceRpc(db, "attendance_admin_report", [
      HR_TL_COMBO.auth, HR_TL_COMBO.app, "2026-10-01", "2026-10-31", 1, 50, null, REC_TRANSFER.app,
    ]);
    const betaRep = await serviceRpc(db, "attendance_admin_report", [
      TL_BETA.auth, TL_BETA.app, "2026-10-01", "2026-10-31", 1, 50, null, REC_TRANSFER.app,
    ]);
    assert.deepEqual(alphaRep.items.map((i) => i.checkin_id), [alphaHalfCheckin]);
    assert.deepEqual(betaRep.items.map((i) => i.checkin_id), [betaHalfCheckin]);
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [HR_TL_COMBO.auth, HR_TL_COMBO.app, betaHalfCheckin]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [TL_BETA.auth, TL_BETA.app, alphaHalfCheckin]),
      (err) => err?.code === "42501",
    );

    // --- Verify Same-day double transfer (2026-10-18 MKT -> OPS -> FIN => ONLY FIN owns Oct 18) ---
    // Unfiltered on Oct 18: MKT and OPS return empty items; FIN returns [sameDayCheckin]
    const [mktSdtAll, opsSdtAll, finSdt] = await Promise.all([
      serviceRpc(db, "attendance_admin_report", [
        MKT_HEAD.auth, MKT_HEAD.app, "2026-10-18", "2026-10-18", 1, 20, null, null,
      ]),
      serviceRpc(db, "attendance_admin_report", [
        OPS_HEAD.auth, OPS_HEAD.app, "2026-10-18", "2026-10-18", 1, 20, null, null,
      ]),
      serviceRpc(db, "attendance_admin_report", [
        FIN_HEAD.auth, FIN_HEAD.app, "2026-10-18", "2026-10-18", 1, 20, null, SAME_DAY_EMP.app,
      ]),
    ]);
    assert.deepEqual(mktSdtAll.items, [], "Same-day transfer: MKT does not own Oct 18");
    assert.deepEqual(opsSdtAll.items, [], "Same-day double transfer: intermediate OPS does not own Oct 18");
    assert.deepEqual(finSdt.items.map((i) => i.checkin_id), [sameDayCheckin], "Same-day double transfer: final FIN owns Oct 18");
    // Explicit p_employee_id probe on Oct 18 fails closed with 42501 for MKT & OPS
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_report", [
        MKT_HEAD.auth, MKT_HEAD.app, "2026-10-18", "2026-10-18", 1, 20, null, SAME_DAY_EMP.app,
      ]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_report", [
        OPS_HEAD.auth, OPS_HEAD.app, "2026-10-18", "2026-10-18", 1, 20, null, SAME_DAY_EMP.app,
      ]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, sameDayCheckin]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [OPS_HEAD.auth, OPS_HEAD.app, sameDayCheckin]),
      (err) => err?.code === "42501",
    );
    assert.equal(
      (await serviceRpc(db, "attendance_admin_checkin_photo", [FIN_HEAD.auth, FIN_HEAD.app, sameDayCheckin])).photo_storage_key,
      "private/sdt/18.jpg",
    );

    // --- Verify Missing Historical Membership (NEVER back-projected before started_at 2026-10-20) ---
    const mktHgapRep = await serviceRpc(db, "attendance_admin_report", [
      MKT_HEAD.auth, MKT_HEAD.app, "2026-10-01", "2026-10-31", 1, 20, null, HIST_GAP_EMP.app,
    ]);
    const adminHgapRep = await serviceRpc(db, "attendance_admin_report", [
      OWNER.auth, OWNER.app, "2026-10-01", "2026-10-31", 1, 20, null, HIST_GAP_EMP.app,
    ]);
    assert.deepEqual(
      mktHgapRep.items.map((i) => i.checkin_id),
      [postBackfillCheckin],
      "MKT_HEAD must NOT see pre-started_at Oct 05 check-in (zero fabricated history)",
    );
    assert.equal(adminHgapRep.items.length, 2, "Full Admin still sees both Oct 05 and Oct 25");
    await assert.rejects(
      () => serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, preBackfillCheckin]),
      (err) => err?.code === "42501",
    );
    assert.equal(
      (await serviceRpc(db, "attendance_admin_checkin_photo", [MKT_HEAD.auth, MKT_HEAD.app, postBackfillCheckin])).photo_storage_key,
      "private/hgap/25.jpg",
    );
  } finally {
    await db.close();
  }
});

test("4. D-WP7B-03: SHARED/SERVICE/legacy-shared blocked on new check-ins & assignments, 0 fake MISSING, historical check-ins preserved, unlinked NORMAL & Person-conflict NOT blocked", async () => {
  const { db } = await createSeededDb();
  try {
    const nowMs = Date.now();
    const anchorIso = new Date(nowMs - 500).toISOString();
    const capturedIso = new Date(nowMs).toISOString();
    async function tryCheckin(actor) {
      const key = nextUuid();
      return serviceRpc(db, "attendance_record_checkin", [
        actor.auth,
        actor.app,
        key,
        sha256(`ci:${actor.app}:${key}`),
        21.0285,
        105.8542,
        10,
        "Hanoi",
        "Checkin test",
        capturedIso,
        "SERVER_ANCHORED",
        anchorIso,
        500,
        sha256(`tok:${key}`),
        `private/attendance/${actor.app}/${key}.jpg`,
        sha256(`ph:${key}`),
        12345,
        "image/jpeg",
        capturedIso,
      ]);
    }

    // 4a. SHARED, SERVICE, and unconflicted LEGACY_SHARED_NORMAL blocked on lookup, check-in, branch & slot-policy assignments
    const br = await serviceRpc(db, "attendance_upsert_branch_admin", [
      OWNER.auth, OWNER.app, null, "BR_TEST", "Chi nhánh Test", "Addr", 21.0285, 105.8542, true, 0, nextUuid(), sha256("br-test"),
    ]);
    const branchId = br.branch.branch_id;
    const defaultProfileId = "00000000-0000-4000-8000-000000000001";

    for (const nonEmp of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL]) {
      await assert.rejects(
        () => serviceRpc(db, "attendance_lookup_checkin_idempotency", [
          nonEmp.auth, nonEmp.app, nextUuid(), sha256(`lk:${nonEmp.app}`),
        ]),
        (err) => err?.code === "42501" && String(err.message).includes("ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN"),
        `${nonEmp.email} must be blocked on attendance_lookup_checkin_idempotency`,
      );
      await assert.rejects(
        () => tryCheckin(nonEmp),
        (err) => err?.code === "42501" && String(err.message).includes("ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN"),
        `${nonEmp.email} must be blocked on attendance_record_checkin`,
      );
      await assert.rejects(
        () => serviceRpc(db, "attendance_assign_employee_branch_admin", [
          OWNER.auth, OWNER.app, nonEmp.app, branchId, null, br.branch.version, nextUuid(), sha256(`ab:${nonEmp.app}`),
        ]),
        (err) => err?.code === "22023" && String(err.message).includes("ATTENDANCE_BRANCH_TARGET_USER_INVALID"),
      );
      await assert.rejects(
        () => serviceRpc(db, "attendance_assign_employee_slot_policy_admin", [
          OWNER.auth, OWNER.app, nonEmp.app, defaultProfileId, null, 0, nextUuid(), sha256(`as:${nonEmp.app}`),
        ]),
        (err) => err?.code === "22023" && String(err.message).includes("ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID"),
      );
    }

    // Admin branch/slot dropdowns exclude SHARED, SERVICE, LEGACY_SHARED_NORMAL but INCLUDE UNLINKED_NORMAL and CONFLICT_PERSON_SHARED
    const branchAdmin = await serviceRpc(db, "attendance_list_branches_admin", [OWNER.auth, OWNER.app, true]);
    const branchEmpIds = branchAdmin.employee_options.map((e) => e.app_user_id);
    assert.equal(branchEmpIds.includes(SHARED_ACC.app), false);
    assert.equal(branchEmpIds.includes(SERVICE_ACC.app), false);
    assert.equal(branchEmpIds.includes(LEGACY_SHARED_NORMAL.app), false);
    assert.equal(branchEmpIds.includes(UNLINKED_NORMAL.app), true, "Unlinked NORMAL stays in branch assignment list");
    assert.equal(branchEmpIds.includes(CONFLICT_PERSON_SHARED.app), true, "Active-Person conflict NOT auto-excluded");

    const slotAdmin = await serviceRpc(db, "attendance_get_slot_policies_admin", [OWNER.auth, OWNER.app]);
    const slotEmpIds = slotAdmin.employee_options.map((e) => e.app_user_id);
    assert.equal(slotEmpIds.includes(SHARED_ACC.app), false);
    assert.equal(slotEmpIds.includes(SERVICE_ACC.app), false);
    assert.equal(slotEmpIds.includes(LEGACY_SHARED_NORMAL.app), false);
    assert.equal(slotEmpIds.includes(UNLINKED_NORMAL.app), true);
    assert.equal(slotEmpIds.includes(CONFLICT_PERSON_SHARED.app), true);

    // 4b. Unlinked NORMAL and Active-Person conflict account CAN check in normally
    const unlinkedRes = await tryCheckin(UNLINKED_NORMAL);
    assert.ok(unlinkedRes.checkin_id, "Unlinked NORMAL employee must check in normally");
    const conflictRes = await tryCheckin(CONFLICT_PERSON_SHARED);
    assert.ok(conflictRes.checkin_id, "Active-Person vs stale is_shared_non_employee conflict must NOT auto-block check-in");

    // 4c. Empty month matrix has ZERO rows for SHARED/SERVICE/LEGACY_SHARED_NORMAL
    const emptyMatrix = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-09", null, null, null, 1, 100,
    ]);
    const emptyIds = emptyMatrix.items.map((i) => i.app_user_id);
    assert.equal(emptyIds.includes(SHARED_ACC.app), false);
    assert.equal(emptyIds.includes(SERVICE_ACC.app), false);
    assert.equal(emptyIds.includes(LEGACY_SHARED_NORMAL.app), false);
    assert.equal(emptyIds.includes(UNLINKED_NORMAL.app), true);
    assert.equal(emptyIds.includes(CONFLICT_PERSON_SHARED.app), true);

    // 4d. Historical check-in of SHARED_ACC is PRESERVED & queryable/exportable with ZERO fake MISSING on empty days
    const histSharedCheckinId = await seedCheckin(db, SHARED_ACC.app, "2026-09-10", "08:05", "private/shared/hist-10.jpg");
    const histMatrixRaw = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-09", null, SHARED_ACC.app, null, 1, 20,
    ]);
    const histMatrix = projectAttendanceMonthlyMatrixReport(histMatrixRaw);
    assert.ok(histMatrix, "Historical SHARED row must pass strict matrix parser");
    assert.equal(histMatrix.items.length, 1);
    const sharedRow = histMatrix.items[0];
    assert.equal(sharedRow.summary.checkin_day_count, 1);
    assert.equal(sharedRow.summary.total_checkins, 1);
    assert.equal(sharedRow.summary.no_checkin_day_count, 0, "Historical SHARED account must generate ZERO fake NO_CHECKIN/MISSING on empty days");
    assert.equal(sharedRow.summary.no_checkin_without_leave_day_count, 0);
    const sharedDay10 = sharedRow.days.find((d) => d.business_date === "2026-09-10");
    const sharedDay11 = sharedRow.days.find((d) => d.business_date === "2026-09-11");
    assert.equal(sharedDay10.has_checkin, true);
    assert.equal(sharedDay11.day_status, "UPCOMING");
    assert.equal(sharedDay11.missing_slot_count, 0);
    assert.equal(
      sharedRow.days.reduce((acc, d) => acc + d.missing_slot_count, 0),
      0,
      "Sum of missing_slot_count across all days of historical SHARED row must be 0",
    );

    // Check-in report & photo also preserve SHARED historical check-in
    const histRep = await serviceRpc(db, "attendance_admin_report", [
      OWNER.auth, OWNER.app, "2026-09-01", "2026-09-30", 1, 20, null, SHARED_ACC.app,
    ]);
    assert.deepEqual(histRep.items.map((i) => i.checkin_id), [histSharedCheckinId]);
    assert.equal(
      (await serviceRpc(db, "attendance_admin_checkin_photo", [OWNER.auth, OWNER.app, histSharedCheckinId])).photo_storage_key,
      "private/shared/hist-10.jpg",
    );
  } finally {
    await db.close();
  }
});

test("5. R7 Leave Nav Probe: leave_management_get_actor_access executes inside READ ONLY transaction with zero DB writes & preserves accrual sync on get_my_summary", async () => {
  const { db } = await createSeededDb();
  try {
    // Verify OFFICIAL_LEAVE_EMP starts with 0 leave_lots and 0 leave_ledger_entries
    const countAccruals = async () => {
      const { rows: [c] } = await db.query(
        `select
           (select count(*)::int from public.leave_lots where app_user_id = $1::uuid) as lots,
           (select count(*)::int from public.leave_ledger_entries where app_user_id = $1::uuid) as ledger`,
        [OFFICIAL_LEAVE_EMP.app],
      );
      return c;
    };
    assert.deepEqual(await countAccruals(), { lots: 0, ledger: 0 });

    // Execute leave_management_get_actor_access strictly inside BEGIN TRANSACTION READ ONLY
    async function probeReadOnly(actor) {
      await db.exec("begin transaction read only; set local role service_role;");
      try {
        const { rows: [r] } = await db.query(
          "select public.leave_management_get_actor_access($1::uuid, $2::uuid) as res",
          [actor.auth, actor.app],
        );
        await db.exec("commit;");
        return r.res;
      } catch (err) {
        await db.exec("rollback;");
        throw err;
      }
    }

    const empAccess = await probeReadOnly(OFFICIAL_LEAVE_EMP);
    assert.deepEqual(empAccess, {
      can_access: true,
      is_shared_non_employee: false,
      can_submit_request: true,
      can_approve_requests: false,
      can_manage_config: false,
      can_view_monthly_report: false,
    });
    // ZERO writes occurred during nav probe!
    assert.deepEqual(await countAccruals(), { lots: 0, ledger: 0 });

    // DEPARTMENT_HEAD probe
    const headAccess = await probeReadOnly(MKT_HEAD);
    assert.deepEqual(headAccess, {
      can_access: true,
      is_shared_non_employee: false,
      can_submit_request: true,
      can_approve_requests: true,
      can_manage_config: false,
      can_view_monthly_report: false,
    });

    // ADMIN / HR_OPERATOR / BOD probes
    const ownerAccess = await probeReadOnly(OWNER);
    assert.equal(ownerAccess.can_access, true);
    assert.equal(ownerAccess.can_manage_config, true);
    assert.equal(ownerAccess.can_view_monthly_report, true);

    const bodAccess = await probeReadOnly(LUANPT);
    assert.equal(bodAccess.can_access, true);
    assert.equal(bodAccess.can_manage_config, true);
    assert.equal(bodAccess.can_view_monthly_report, true);

    const hrAccess = await probeReadOnly(HR_OP);
    assert.equal(hrAccess.can_access, true);
    assert.equal(hrAccess.can_manage_config, false);
    assert.equal(hrAccess.can_view_monthly_report, false);

    // SHARED & SERVICE probes are NON-THROWING and cleanly return can_access = false
    for (const nonEmp of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL]) {
      const access = await probeReadOnly(nonEmp);
      assert.deepEqual(access, {
        can_access: false,
        is_shared_non_employee: true,
        can_submit_request: false,
        can_approve_requests: false,
        can_manage_config: false,
        can_view_monthly_report: false,
      });
    }

    // Disabled actor fails closed with 42501
    await assert.rejects(
      () => probeReadOnly(DISABLED_HEAD),
      (err) => err?.code === "42501",
    );

    // Now invoke real business endpoint leave_management_get_my_summary -> accrual sync STILL runs cleanly!
    const summary = await serviceRpc(db, "leave_management_get_my_summary", [
      OFFICIAL_LEAVE_EMP.auth,
      OFFICIAL_LEAVE_EMP.app,
      2026,
    ]);
    assert.ok(summary.balance, "leave_management_get_my_summary must return balance");
    const afterBusinessCall = await countAccruals();
    assert.ok(afterBusinessCall.lots > 0, "Legitimate Leave endpoint must still sync leave_lots");
    assert.ok(afterBusinessCall.ledger > 0, "Legitimate Leave endpoint must still sync leave_ledger_entries");
  } finally {
    await db.close();
  }
});
