/**
 * WP8C-1 — Shared Contextual Team Leader / Project Manager / Entry Access Guards
 * PGlite End-to-End Database, Before/After Diff, Real Actor RPC -> Repository -> TS Guard
 * Parity, Inactive-Project 22023 & C4 Invariant, D10 Lifecycle & Pre-Cutover Suite.
 *
 * Covers:
 *   1. Migration #229 hygiene (0 '@', 0 SAVEPOINT, 0 ALTER DEFAULT PRIVILEGES, single outer
 *      BEGIN/COMMIT, LF/CRLF-identical SHA-256), atomic rollback safety, exact 337 service_role
 *      RPC allowlist (+0 new RPCs), STABLE volatility & strict internal ACLs, and WP8D read-only
 *      nav probe preservation (work_report_has_active_obligations STABLE, no listMine in nav).
 *   2. Canonical Managed Team Leader (authz_managed=true) with legacy mirror cleared:
 *      - Explicit BEFORE (#228) vs AFTER (#229) diff across shared TL guard, Project Operations,
 *        Worker Directory ('team'), Attendance TL scope, Offboarding (deduplicated), and
 *        direct_entry_resolve_actor_context -> resolveActor -> real TS nav/page/repository callers.
 *      - Quarantine operational account (NORMAL, 0 person links) retains canonical TL authority.
 *      - Fail-closed checks: wrong p_team_id, non-TL standalone direct grant, team_manager_assign
 *        at ALL, multi-team ambiguity, latent team_master_manage at ALL Project Operations bypass,
 *        stale legacy rows on managed non-TL, mismatched recruiter_team_memberships, SERVICE account.
 *   3. Canonical Managed Project Manager (authz_managed=true) with legacy mirror cleared +
 *      Recruitment Posts C4 & Inactive-Project 22023 ordering:
 *      - Quarantine operational PM (0 person links, 0 legacy grants) passes assignment guard,
 *        actor_can_access_project, allowed_worker_tabs ('uploader'/'recruited'/'managed'),
 *        worker directory ('managed'), own-submission reads, privileged edit, and recruitment posts.
 *      - Inactive project preserves PM history & raises exact 22023 RECRUITMENT_POST_CONTENT_INVALID
 *        on recruitment_post_create (NEVER 42501); non-PM Admin still gets 42501 (C4 preserved);
 *        public feed /feeds/jobs.v1.json and include_facets stay intact.
 *      - Drift/invalid PM checks: future valid_from, expired valid_to, suspended link, SERVICE
 *        account, inactive recruiter, cross-account ambiguous links -> all fail closed & never
 *        leak into worker_directory_audience('managed').
 *   4. Paired Entry Access (direct_entry_assert_entry_access / direct_entry_has_entry_access /
 *      direct_entry_resolve_direct_edit_authority / worker_directory_audience('all') /
 *      direct_entry_list_own_submissions / direct_entry_read_own_submission):
 *      - Canonical dual-role HR_OPERATOR (@ ALL) + RECRUITER (@ OWN): BEFORE #228 escalated
 *        document_upload to 'all'; AFTER #229 denies cross-owner ('resource scope denied'),
 *        allows 'own' on own entry, allows 'all' on document_view/audit_view.
 *      - Mirror-cleared ADMIN & RECRUITER retain full paired entry/directory/submission/TS parity;
 *        stale legacy on managed EMPLOYEE_BASE (empty effective_grants) has zero fallback.
 *   5. Revoke, Disable & Re-Enable (D10 Contract + Independent Personal Roles Preserved):
 *      - Managed account holding independent RECRUITER + TEAM_LEADER + PROJECT_MANAGER:
 *        disable blocks runtime without deleting rows; re-enable restores intact roles (and
 *        never resurrects a TL replaced while disabled); unassign PM / revoke TL preserve
 *        independent personal roles.
 *   6. Pre-cutover (authz_managed=false) R1 compatibility & real TS repository/error classifiers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  canManageProjectMasterFromActor,
  canViewOffboardingReport,
  decideChangeRequestsPageAccess,
  decideDirectEntryPageAccess,
  decideProjectOperationsPageAccess,
  decideWorkerOperationsPageAccess,
  decideWorkforceOffboardingPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import {
  classifyProjectAdminError,
  createProjectAdminRepository,
} from "../src/lib/direct-entry/project-admin-repository.ts";
import {
  classifyWorkerDirectoryError,
  createWorkerDirectoryRepository,
} from "../src/lib/direct-entry/worker-directory-repository.ts";
import { canExportAllWorkers } from "../src/lib/direct-entry/worker-export-ui-model.ts";
import {
  canReviewChangeRequests,
  canViewGlobalChangeRequestHistory,
} from "../src/lib/direct-entry/worker-operations-model.ts";
import {
  canReadWorkerDirectoryCatalog,
  changeRequestsProposerPredicate,
  changeRequestsReviewerPredicate,
  directEntryNavPredicate,
  projectAdminNavPredicate,
  resolveAllowedWorkerOperationsTabs,
  workerOperationsAllScopePredicate,
  workerOperationsNavPredicate,
  workerOperationsReviewPredicate,
  workerOperationsTeamScopePredicate,
  workforceOffboardingNavPredicate,
} from "../src/lib/navigation/registry-capability.ts";
import {
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostPublicFeedV1,
} from "../src/lib/recruitment-posts/contract.ts";
import { classifyRecruitmentPostError } from "../src/lib/recruitment-posts/repository.ts";
import { parseOffboardingReportList } from "../src/lib/workforce/offboarding-report-contract.ts";
import { migrationChecksum } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8D_MIGRATION_NAME = "20261120140000_wp8d_nav_readonly.sql";
const WP8C1_MIGRATION_NAME = "20261120150000_wp8c1_contextual_tl_pm_guards.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18c10000-0000-4000-8000-000000000001",
  app: "28c10000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical WP8C1",
};
const LUANPT = {
  auth: "18c10000-0000-4000-8000-000000000002",
  app: "28c10000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c10000-0000-4000-8000-000000000003",
  app: "28c10000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c10000-0000-4000-8000-000000000004",
  app: "28c10000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const TL_MANAGED = {
  auth: "18c10000-0000-4000-8000-000000000010",
  app: "28c10000-0000-4000-8000-000000000010",
  recruiter: "38c10000-0000-4000-8000-000000000010",
  email: "tl.managed.wp8c1@hrpartner.vn",
  name: "Managed TL Quarantine T1",
};
const TL_REPLACE = {
  auth: "18c10000-0000-4000-8000-000000000011",
  app: "28c10000-0000-4000-8000-000000000011",
  recruiter: "38c10000-0000-4000-8000-000000000011",
  email: "tl.replace.wp8c1@hrpartner.vn",
  name: "Managed TL Replacement T1",
};
const PM_MANAGED = {
  auth: "18c10000-0000-4000-8000-000000000012",
  app: "28c10000-0000-4000-8000-000000000012",
  recruiter: "38c10000-0000-4000-8000-000000000012",
  email: "pm.managed.wp8c1@hrpartner.vn",
  name: "Managed PM Quarantine P1",
};
const REC_T1 = {
  auth: "18c10000-0000-4000-8000-000000000013",
  app: "28c10000-0000-4000-8000-000000000013",
  recruiter: "38c10000-0000-4000-8000-000000000013",
  email: "rec1.wp8c1@hrpartner.vn",
  name: "Recruiter Team One WP8C1",
};
const REC_T2 = {
  auth: "18c10000-0000-4000-8000-000000000014",
  app: "28c10000-0000-4000-8000-000000000014",
  recruiter: "38c10000-0000-4000-8000-000000000014",
  email: "rec2.wp8c1@hrpartner.vn",
  name: "Recruiter Team Two WP8C1",
};
const HR_REC_DUAL = {
  auth: "18c10000-0000-4000-8000-000000000015",
  app: "28c10000-0000-4000-8000-000000000015",
  recruiter: "38c10000-0000-4000-8000-000000000015",
  email: "hrrec.wp8c1@hrpartner.vn",
  name: "HR Operator Plus Recruiter WP8C1",
};
const TEAM_MASTER_ONLY = {
  auth: "18c10000-0000-4000-8000-000000000016",
  app: "28c10000-0000-4000-8000-000000000016",
  email: "teammaster.wp8c1@hrpartner.vn",
  name: "Team Master Only Direct Grant WP8C1",
};
const BASE_USER = {
  auth: "18c10000-0000-4000-8000-000000000017",
  app: "28c10000-0000-4000-8000-000000000017",
  recruiter: "38c10000-0000-4000-8000-000000000017",
  email: "base.wp8c1@hrpartner.vn",
  name: "Employee Base WP8C1",
};
const COMBO_USER = {
  auth: "18c10000-0000-4000-8000-000000000018",
  app: "28c10000-0000-4000-8000-000000000018",
  recruiter: "38c10000-0000-4000-8000-000000000018",
  email: "combo.wp8c1@hrpartner.vn",
  name: "Recruiter Plus TL Plus PM WP8C1",
};
const ADMIN_MANAGED = {
  auth: "18c10000-0000-4000-8000-000000000019",
  app: "28c10000-0000-4000-8000-000000000019",
  email: "admin.wp8c1@hrpartner.vn",
  name: "Managed Admin Mirror Cleared WP8C1",
};

const TEAM_1 = "48c10000-0000-4000-8000-000000000001";
const TEAM_2 = "48c10000-0000-4000-8000-000000000002";
const TEAM_3 = "48c10000-0000-4000-8000-000000000003";
const PRJ_1 = "wp8c1-prj-1";
const PRJ_2 = "wp8c1-prj-2";
const PRJ_3 = "wp8c1-prj-3";

let seq = 1;
function nextUuid() {
  return `98c10000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql") && f < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql").sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDbUpTo(migrations, stopAtName) {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  for (const m of migrations) {
    await db.exec(m.sql);
    if (m.name === stopAtName) break;
  }
  return db;
}

function stripOuterTransaction(sql) {
  const trimmed = sql.trim();
  const withoutBegin = trimmed.replace(/^(?:\s*--[^\r\n]*\r?\n)*\s*begin\s*;\s*/i, "");
  return withoutBegin.replace(/\s*commit\s*;\s*$/i, "\n");
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const res = await db.query(`select public.${fnName}(${placeholders}) as res`, args);
    await db.exec("commit");
    return res.rows[0]?.res;
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }
}

async function expectServiceRpcError(db, fnName, args, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await serviceRpc(db, fnName, args);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected ${fnName} to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode} on ${fnName}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message on ${fnName}: ${caught.message}`);
  }
  return caught;
}

async function expectInternalError(db, querySql, params, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await db.query(querySql, params);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected query to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message: ${caught.message}`);
  }
  return caught;
}

/** Named-argument service_role RPC adapter matching Supabase `.rpc(name, args)` for real TS repositories. */
function makeNamedServiceRpcAdapter(db) {
  return async (name, argsObj = {}) => {
    const entries = Object.entries(argsObj);
    const placeholders = entries.map(([k], i) => `${k} => $${i + 1}`).join(", ");
    const values = entries.map(([, v]) => v);
    await db.exec("begin");
    try {
      await db.exec("set local role service_role");
      const res = await db.query(`select public.${name}(${placeholders}) as data`, values);
      await db.exec("commit");
      return { data: res.rows[0]?.data ?? null, error: null };
    } catch (err) {
      await db.exec("rollback");
      return {
        data: null,
        error: { code: err.code, message: err.message },
      };
    }
  };
}

async function resolveViaRealRpc(db, authSubject) {
  const raw = await serviceRpc(db, "direct_entry_resolve_actor_context", [authSubject]);
  const at = new Date().toISOString();
  const resolution = await resolveActor({
    session: { provider: "supabase", auth_subject: authSubject, authenticated_at: at },
    at,
    repository: {
      loadByAuthSubject: async (sub) => {
        assert.equal(sub, authSubject);
        return raw;
      },
    },
  });
  return { raw, resolution };
}

async function seedAccount(db, user, { enabled = true } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, $4)",
    [user.app, user.auth, user.name, enabled],
  );
}

async function seedRecruiterAndTeam(db, user, teamId) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
    [user.recruiter, user.name],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
    [user.recruiter],
  );
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
    [user.recruiter, teamId],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [user.app, user.recruiter],
  );
}

async function assignGlobalRole(db, actor, target, roleCode, reason) {
  const ver = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(db, "direct_entry_authz_assign_global_role_admin", [
    actor.auth,
    actor.app,
    target.app,
    roleCode,
    ver,
    reason,
    key,
    sha256(`assign:${target.app}:${roleCode}:${key}`),
  ]);
}

async function clearLegacyMirrors(db, appUserIds) {
  await db.query("select set_config('direct_entry.team_leader_marker', 'on', false)");
  for (const appId of appUserIds) {
    await db.query(
      "update public.direct_entry_capability_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and is_current",
      [appId],
    );
    await db.query(
      "update public.direct_entry_scope_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and is_current",
      [appId],
    );
  }
  await db.query("select set_config('direct_entry.team_leader_marker', 'off', false)");
}

function makeBriefContent(overrides = {}) {
  return {
    general: {
      customer_name: "Công ty TNHH Sản Xuất WP8C1",
      investment_origin: "Nhật Bản",
      manufacturing_industry: "Linh kiện điện tử",
      job_description: "Vận hành dây chuyền sản xuất",
      environment_types: ["CLEAN_ROOM"],
      work_postures: ["SITTING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Managed PM Quarantine P1",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục",
      expected_headcount: 50,
      ...(overrides.general ?? {}),
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: "Phỏng vấn trực tiếp",
      other_requirements_text: null,
      ...(overrides.candidate ?? {}),
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 ngày công tiêu chuẩn",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Không đi muộn về sớm",
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: "300000",
      seniority_allowance_conditions: "Từ tháng thứ 2",
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9500000",
      average_income_max_vnd: "13000000",
      salary_payment_schedule: "Ngày 10 hàng tháng qua ngân hàng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ngày 25 hàng tháng",
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: "240000",
      day_shift_11h_vnd: "350000",
      night_shift_8h_vnd: "290000",
      night_shift_11h_vnd: "420000",
      sunday_day_11h_vnd: "520000",
      sunday_night_11h_vnd: "600000",
      holiday_day_11h_vnd: "780000",
      holiday_night_11h_vnd: "880000",
      ppe_provided: true,
      ppe_details: "Phát miễn phí đồng phục",
      other_benefits: "Hỗ trợ 2 bữa ăn ca",
      ...(overrides.compensation ?? {}),
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
      ...(overrides.documents ?? {}),
    },
  };
}

async function seedWorkerEntry(
  db,
  {
    createdByUserId,
    projectId,
    recruiterId,
    teamId,
    employeeCode,
    workerName,
    cccd,
    phone,
    offboard = false,
  },
) {
  const dates = (
    await db.query(
      "select (public.direct_entry_authorization_date() - 10)::text as start_d, (public.direct_entry_authorization_date() - 3)::text as off_d",
    )
  ).rows[0];
  const entryYear = dates.start_d.slice(0, 4);
  const fullEmployeeCode = `hrp-${entryYear}-${employeeCode}`;
  const entryId = nextUuid();
  const submissionId = nextUuid();
  const candidateId = nextUuid();
  const onEventId = nextUuid();
  const offEventId = nextUuid();
  const reasonId = nextUuid();

  await db.exec("begin");
  try {
    await db.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'WP8C1 worker seed')",
      [reasonId, createdByUserId],
    );
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [candidateId]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
      [submissionId, createdByUserId],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6::date, $7, $8::jsonb, $9::uuid, $10::uuid,
         'hrp', 'TEMPORARY'
       )`,
      [
        entryId,
        submissionId,
        candidateId,
        createdByUserId,
        projectId,
        dates.start_d,
        fullEmployeeCode,
        JSON.stringify({
          display_name: workerName,
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: cccd },
          address: { state: "omitted" },
          phone: { state: "provided", value: phone },
        }),
        recruiterId,
        teamId,
      ],
    );
    await db.query(
      "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = version + 1 where submission_id = $1::uuid",
      [submissionId],
    );
    await db.query(
      `insert into public.direct_entry_employment_status_events (
         event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
         version, actor_user_id, reason_id, supersedes_event_id
       ) values ($1::uuid, $2::uuid, 'ON', $3::date, null, null, 1, $4::uuid, $5::uuid, null)`,
      [onEventId, entryId, dates.start_d, createdByUserId, reasonId],
    );
    if (offboard) {
      await db.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1::uuid, $2::uuid, 'OFF', $3::date, $3::date, 'Nghỉ việc cá nhân', 2, $4::uuid, $5::uuid, null)`,
        [offEventId, entryId, dates.off_d, createdByUserId, reasonId],
      );
    }
    await db.exec("commit");
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }

  return { entryId, submissionId, employeeCode: fullEmployeeCode, offEventId };
}

async function seedCanonicalPostCutoverWorld(db) {
  for (const u of [
    OWNER,
    LUANPT,
    LIENVU,
    NGATTT,
    TL_MANAGED,
    TL_REPLACE,
    PM_MANAGED,
    REC_T1,
    REC_T2,
    HR_REC_DUAL,
    TEAM_MASTER_ONLY,
    BASE_USER,
    COMBO_USER,
    ADMIN_MANAGED,
  ]) {
    await seedAccount(db, u);
  }

  // Bootstrap canonical Owner/BoD legacy grants before WP5 cutover (matches WP5 manifest exact 0 unexpected diffs)
  const adminSeedCaps = [
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
  ];
  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of adminSeedCaps) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [adm.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true), ($1::uuid, 'own', null, '2026-01-01', true)",
      [adm.app],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true)",
    [LUANPT.app],
  );

  // Run real WP5 cutover so cutover_ready = true and all seeded users become authz_managed = true
  const cutoverPlan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
  const cutoverResult = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: cutoverPlan.manifest_fingerprint,
  });
  assert.equal(cutoverResult.status, "APPLIED", "WP5 cutover must succeed");

  // Seed 3 teams & 3 projects + team scopes (TEAM_1 -> PRJ_1, TEAM_2 -> PRJ_2, TEAM_3 -> PRJ_3)
  await db.query(
    `insert into public.teams (team_id, code, display_name, active) values
      ($1::uuid, 'WP8C1_T1', 'Team WP8C1 One', true),
      ($2::uuid, 'WP8C1_T2', 'Team WP8C1 Two', true),
      ($3::uuid, 'WP8C1_T3', 'Team WP8C1 Three', true)`,
    [TEAM_1, TEAM_2, TEAM_3],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active) values
      ($1, 'Project WP8C1 One', true),
      ($2, 'Project WP8C1 Two', true),
      ($3, 'Project WP8C1 Three', true)`,
    [PRJ_1, PRJ_2, PRJ_3],
  );
  for (const [prj, team] of [
    [PRJ_1, TEAM_1],
    [PRJ_2, TEAM_2],
    [PRJ_3, TEAM_3],
  ]) {
    await serviceRpc(db, "direct_entry_grant_project_team_scopes_batch", [
      OWNER.auth,
      OWNER.app,
      team,
      [prj],
      `Bind ${prj} to ${team}`,
      `wp8c1-pts-${nextUuid()}`,
    ]);
  }

  // Seed recruiters & team memberships (deliberately ZERO organization_account_person_links
  // for TL_MANAGED & PM_MANAGED to prove quarantine operational accounts keep contextual authority!)
  await seedRecruiterAndTeam(db, TL_MANAGED, TEAM_1);
  await seedRecruiterAndTeam(db, TL_REPLACE, TEAM_1);
  await seedRecruiterAndTeam(db, PM_MANAGED, TEAM_1);
  await seedRecruiterAndTeam(db, REC_T1, TEAM_1);
  await seedRecruiterAndTeam(db, REC_T2, TEAM_2);
  await seedRecruiterAndTeam(db, HR_REC_DUAL, TEAM_1);
  await seedRecruiterAndTeam(db, BASE_USER, TEAM_2);
  await seedRecruiterAndTeam(db, COMBO_USER, TEAM_3);

  // Assign canonical WP5 global roles
  await assignGlobalRole(db, OWNER, ADMIN_MANAGED, "ADMIN", "WP8C1 canonical ADMIN");
  await assignGlobalRole(db, OWNER, REC_T1, "RECRUITER", "WP8C1 canonical RECRUITER");
  await assignGlobalRole(db, OWNER, HR_REC_DUAL, "HR_OPERATOR", "WP8C1 dual HR_OPERATOR");
  await assignGlobalRole(db, OWNER, HR_REC_DUAL, "RECRUITER", "WP8C1 dual RECRUITER");
  await assignGlobalRole(db, OWNER, COMBO_USER, "RECRUITER", "WP8C1 independent RECRUITER on combo actor");

  // Direct grant team_master_manage @ ALL ONLY (no catalog_master_manage, no entry_admin)
  await db.query(
    `insert into public.authz_direct_capability_grants
       (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values ($1::uuid, 'team_master_manage', 'ALL', null, 'EXCEPTION_GRANT', 'WP8C1 test narrow team_master_manage @ ALL', $2::uuid)`,
    [TEAM_MASTER_ONLY.app, OWNER.app],
  );

  // Canonical TL designations (TEAM_1 -> TL_MANAGED, TEAM_3 -> COMBO_USER)
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_1,
    TL_MANAGED.app,
    null,
    1,
    "Canonical TL on TEAM_1",
    `wp8c1-tl1-${nextUuid()}`,
  ]);
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_3,
    COMBO_USER.app,
    null,
    1,
    "Canonical TL on TEAM_3",
    `wp8c1-tl3-${nextUuid()}`,
  ]);

  // Canonical PM assignments (PRJ_1 -> PM_MANAGED, PRJ_3 -> COMBO_USER)
  const pm1Assign = await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_1,
    PM_MANAGED.recruiter,
    null,
    1,
    "Canonical PM on PRJ_1",
    `wp8c1-pm1-${nextUuid()}`,
  ]);
  const pm3Assign = await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_3,
    COMBO_USER.recruiter,
    null,
    1,
    "Canonical PM on PRJ_3",
    `wp8c1-pm3-${nextUuid()}`,
  ]);

  // Seed submitted & offboarded workers across TEAM_1/PRJ_1, TEAM_2/PRJ_2, TEAM_3/PRJ_3
  const workerT1P1 = await seedWorkerEntry(db, {
    createdByUserId: REC_T1.app,
    projectId: PRJ_1,
    recruiterId: REC_T1.recruiter,
    teamId: TEAM_1,
    employeeCode: "831001",
    workerName: "Công nhân Team 1 PRJ 1",
    cccd: "001098111222",
    phone: "0901112223",
    offboard: true,
  });
  const workerT2P2 = await seedWorkerEntry(db, {
    createdByUserId: REC_T2.app,
    projectId: PRJ_2,
    recruiterId: REC_T2.recruiter,
    teamId: TEAM_2,
    employeeCode: "831002",
    workerName: "Công nhân Team 2 PRJ 2",
    cccd: "001098222333",
    phone: "0902223334",
    offboard: true,
  });
  const workerDualOwn = await seedWorkerEntry(db, {
    createdByUserId: HR_REC_DUAL.app,
    projectId: PRJ_1,
    recruiterId: HR_REC_DUAL.recruiter,
    teamId: TEAM_1,
    employeeCode: "831003",
    workerName: "Công nhân của HR_REC_DUAL",
    cccd: "001098333444",
    phone: "0903334445",
    offboard: false,
  });
  const workerT3P3 = await seedWorkerEntry(db, {
    createdByUserId: COMBO_USER.app,
    projectId: PRJ_3,
    recruiterId: COMBO_USER.recruiter,
    teamId: TEAM_3,
    employeeCode: "831004",
    workerName: "Công nhân Combo Team 3 PRJ 3",
    cccd: "001098444555",
    phone: "0904445556",
    offboard: true,
  });

  await db.query(
    `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
     values
       ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true),
       ('THOI_VU', 'Thời vụ', 'thoi_vu', 20, true)
     on conflict (labor_type_key) do update set active = true`,
  );

  const parkRow = (
    await db.query(
      "select industrial_park_id from public.industrial_parks where active = true order by industrial_park_id limit 1",
    )
  ).rows[0];

  return {
    pm1Assign,
    pm3Assign,
    workerT1P1,
    workerT2P2,
    workerDualOwn,
    workerT3P3,
    parkId: parkRow.industrial_park_id,
  };
}

// =============================================================================
// TEST 1: Migration #229 Hygiene, Atomic Rollback, Exact 337 RPCs & WP8D Safety
// =============================================================================
test("WP8C-1 [1/6]: Migration #229 hygiene, atomic rollback, exact 337 service_role RPCs, STABLE ACLs & WP8D probe intact", async () => {
  const migrations = await loadMigrations();
  const wp8c1 = migrations.find((m) => m.name === WP8C1_MIGRATION_NAME);
  assert.ok(wp8c1, `Missing migration ${WP8C1_MIGRATION_NAME}`);

  // Static SQL hygiene
  assert.equal(wp8c1.sql.includes("@"), false, "Migration #229 must contain zero '@' characters");
  assert.equal(/\bsavepoint\b/i.test(wp8c1.sql), false, "Migration #229 must not use SAVEPOINT");
  assert.equal(
    /\balter\s+default\s+privileges\b/i.test(wp8c1.sql),
    false,
    "Migration #229 must not run ALTER DEFAULT PRIVILEGES",
  );
  assert.match(wp8c1.sql, /^[\s\S]*?\bbegin\s*;/i);
  assert.match(wp8c1.sql, /\bcommit\s*;\s*$/i);

  const lfSql = wp8c1.sql.replace(/\r\n/g, "\n");
  const crlfSql = lfSql.replace(/\n/g, "\r\n");
  assert.equal(migrationChecksum(lfSql), migrationChecksum(crlfSql), "LF and CRLF checksums must match");

  // WP8D read-only navbar probe hygiene: resolve-nav-actor.ts must NEVER call listMine
  const resolveNavSrc = await readFile(path.resolve("src/lib/navigation/resolve-nav-actor.ts"), "utf8");
  assert.equal(/\blistMine\b/.test(resolveNavSrc), false, "WP8D invariant: resolve-nav-actor.ts must not call listMine");
  assert.match(resolveNavSrc, /\bhasActiveObligations\b/, "WP8D invariant: resolve-nav-actor.ts must use hasActiveObligations");

  const db = await createDbUpTo(migrations, WP8D_MIGRATION_NAME);
  try {
    const beforeRpcCount = (
      await db.query(
        `select count(*)::int as cnt
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(beforeRpcCount, 337, "Baseline #228 must have exact 337 service_role RPCs");

    const beforeTlBody = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)'::regprocedure) as src",
      )
    ).rows[0].src;

    // Atomic rollback rehearsal
    await db.exec(`begin;\n${stripOuterTransaction(wp8c1.sql)}\nrollback;`);
    const afterRollbackTlBody = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)'::regprocedure) as src",
      )
    ).rows[0].src;
    assert.equal(afterRollbackTlBody, beforeTlBody, "Rollback must leave DB byte-for-byte unchanged");

    // Apply #229 for real
    await db.exec(wp8c1.sql);

    // Exact 337 service_role RPCs (+0 new) and 0 client/PUBLIC EXECUTE on all WP8C-1 & WP8D targets
    const afterRpcCount = (
      await db.query(
        `select count(*)::int as cnt
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(afterRpcCount, 337, "WP8C-1 must add +0 service_role RPCs (exact 337)");

    // Verify WP8D probe RPC remains STABLE and service_role-only
    const wp8dProbe = (
      await db.query(
        `select p.provolatile,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as an,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
           from pg_catalog.pg_proc p
          where p.oid = 'public.work_report_has_active_obligations(uuid,uuid)'::regprocedure`,
      )
    ).rows[0];
    assert.deepEqual(wp8dProbe, { provolatile: "s", svc: true, pub: false, an: false, auth: false });

    // R2.1 invariant: direct_entry_resolve_direct_edit_authority must stay exception-free (per-row hot path)
    const directEditSrc = (
      await db.query(
        `select p.prosrc, p.provolatile,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub
           from pg_catalog.pg_proc p
          where p.oid = 'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure`,
      )
    ).rows[0];
    assert.equal(directEditSrc.provolatile, "s");
    assert.equal(directEditSrc.svc, false);
    assert.equal(directEditSrc.pub, false);
    assert.equal(
      directEditSrc.prosrc.toLowerCase().includes("exception when"),
      false,
      "direct_entry_resolve_direct_edit_authority must not use EXCEPTION WHEN subtransactions",
    );

    // Verify direct_entry_authz__internal_resolve_effective_grants stays STABLE & internal-only
    const effGrantsAcl = (
      await db.query(
        `select p.provolatile,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as an,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
           from pg_catalog.pg_proc p
          where p.oid = 'public.direct_entry_authz__internal_resolve_effective_grants(uuid)'::regprocedure`,
      )
    ).rows[0];
    assert.deepEqual(effGrantsAcl, { provolatile: "s", svc: false, pub: false, an: false, auth: false });
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 2: Canonical Managed TL Without Legacy Mirror (BEFORE #228 vs AFTER #229)
//         + Quarantine Account (0 Person Links) + Fail-Closed Ambiguity/Bypass Checks
// =============================================================================
test("WP8C-1 [2/6]: Managed TL without legacy mirror passes SQL -> Actor RPC -> TS -> Repositories; wrong team, ambiguity, non-TL grant & team_master_manage bypass fail closed", async () => {
  const migrations = await loadMigrations();
  const dbBefore = await createDbUpTo(migrations, WP8D_MIGRATION_NAME);
  const dbAfter = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    await seedCanonicalPostCutoverWorld(dbBefore);
    const world = await seedCanonicalPostCutoverWorld(dbAfter);

    // Clear ONLY legacy mirror rows for TL_MANAGED (canonical TLA + WP5 effective_grants stay intact!)
    await clearLegacyMirrors(dbBefore, [TL_MANAGED.app]);
    await clearLegacyMirrors(dbAfter, [TL_MANAGED.app]);

    // Confirm TL_MANAGED is a quarantine operational account (NORMAL, 0 person links, 0 legacy mirrors)
    const tlState = (
      await dbAfter.query(
        `select u.authz_managed, u.account_type,
                (select count(*)::int from public.organization_account_person_links l
                  where l.app_user_id = u.app_user_id and l.ended_at is null) as person_links,
                (select count(*)::int from public.direct_entry_capability_grants c
                  where c.app_user_id = u.app_user_id and c.is_current) as legacy_caps,
                (select count(*)::int from public.direct_entry_scope_grants s
                  where s.app_user_id = u.app_user_id and s.is_current) as legacy_scopes,
                (select count(*)::int from public.direct_entry_team_leader_assignments a
                  where a.leader_app_user_id = u.app_user_id and a.team_id = $2::uuid and a.is_current) as canonical_tla
           from public.direct_entry_app_users u where u.app_user_id = $1::uuid`,
        [TL_MANAGED.app, TEAM_1],
      )
    ).rows[0];
    assert.deepEqual(tlState, {
      authz_managed: true,
      account_type: "NORMAL",
      person_links: 0,
      legacy_caps: 0,
      legacy_scopes: 0,
      canonical_tla: 1,
    });

    // --- BEFORE (#228): mirror-cleared managed TL FAILED across shared TL guard, Project Ops, Worker Directory, Attendance, and actor context ---
    await expectInternalError(
      dbBefore,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [TL_MANAGED.auth, TL_MANAGED.app],
      "42501",
      /team leader authority denied/,
    );
    await expectServiceRpcError(
      dbBefore,
      "direct_entry_list_projects_admin",
      [TL_MANAGED.auth, TL_MANAGED.app, false],
      "42501",
      /team leader authority denied/,
    );
    await expectServiceRpcError(
      dbBefore,
      "direct_entry_list_workers",
      [TL_MANAGED.auth, TL_MANAGED.app, "team", null, null, null, null, 25],
      "42501",
      /team leader authority denied/,
    );
    const beforeActorCtx = await serviceRpc(dbBefore, "direct_entry_resolve_actor_context", [TL_MANAGED.auth]);
    assert.equal(
      beforeActorCtx.allowed_worker_tabs.includes("team"),
      false,
      "BEFORE #228: mirror-cleared managed TL lost 'team' in allowed_worker_tabs",
    );
    // Latent bug BEFORE #228: TEAM_MASTER_ONLY (team_master_manage @ ALL only) bypassed assert_project_operation_authority with NULL team_id!
    const beforeBypass = (
      await dbBefore.query(
        "select authority, team_id from public.direct_entry_assert_project_operation_authority($1::uuid, $2::uuid)",
        [TEAM_MASTER_ONLY.auth, TEAM_MASTER_ONLY.app],
      )
    ).rows[0];
    assert.deepEqual(beforeBypass, { authority: "team_manager_assign", team_id: null });

    // --- AFTER (#229): mirror-cleared managed TL SUCCEEDS cleanly across ALL SQL & TS layers! ---
    const resolvedTeamNull = (
      await dbAfter.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null) as tid",
        [TL_MANAGED.auth, TL_MANAGED.app],
      )
    ).rows[0].tid;
    assert.equal(resolvedTeamNull, TEAM_1);
    const resolvedTeamMatch = (
      await dbAfter.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid) as tid",
        [TL_MANAGED.auth, TL_MANAGED.app, TEAM_1],
      )
    ).rows[0].tid;
    assert.equal(resolvedTeamMatch, TEAM_1);

    // Wrong p_team_id -> 42501
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)",
      [TL_MANAGED.auth, TL_MANAGED.app, TEAM_2],
      "42501",
      /team leader authority denied/,
    );

    // Project Operations authority & real TS ProjectAdminRepository
    const projAuth = (
      await dbAfter.query(
        "select authority, team_id from public.direct_entry_assert_project_operation_authority($1::uuid, $2::uuid)",
        [TL_MANAGED.auth, TL_MANAGED.app],
      )
    ).rows[0];
    assert.deepEqual(projAuth, { authority: "team_manager_assign", team_id: TEAM_1 });

    const projectRepo = createProjectAdminRepository(makeNamedServiceRpcAdapter(dbAfter));
    const listedProjects = await projectRepo.listProjects({
      auth_subject: TL_MANAGED.auth,
      app_user_id: TL_MANAGED.app,
      include_inactive: false,
    });
    assert.equal(listedProjects.ok, true);
    assert.deepEqual(
      listedProjects.data.projects.map((p) => p.project_id),
      [PRJ_1],
      "TL sees ONLY projects scoped to TEAM_1 (never PRJ_2/PRJ_3)",
    );

    // TL can assign TEAM_1 recruiter (REC_T1) to PRJ_1, and is DENIED assigning TEAM_2 recruiter (REC_T2)
    const assignedOwnTeam = await serviceRpc(dbAfter, "direct_entry_assign_project_manager", [
      TL_MANAGED.auth,
      TL_MANAGED.app,
      PRJ_1,
      REC_T1.recruiter,
      null,
      2,
      "Mirror-cleared TL assigns own-team PM",
      `wp8c1-tl-pm-${nextUuid()}`,
    ]);
    assert.equal(assignedOwnTeam.project_id, PRJ_1);
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_assign_project_manager",
      [TL_MANAGED.auth, TL_MANAGED.app, PRJ_1, REC_T2.recruiter, null, 3, "Cross-team PM must fail", `wp8c1-tl-pmx-${nextUuid()}`],
      "42501",
    );

    // Real TS WorkerDirectoryRepository ('team' -> ALLOW exact TEAM_1; 'all' -> DENIED)
    const workerRepo = createWorkerDirectoryRepository(makeNamedServiceRpcAdapter(dbAfter));
    const teamDirRes = await workerRepo.listWorkers({
      auth_subject: TL_MANAGED.auth,
      app_user_id: TL_MANAGED.app,
      scope: "team",
      page_size: 25,
    });
    assert.equal(teamDirRes.ok, true);
    assert.ok(teamDirRes.data.items.some((r) => r.entry_id === world.workerT1P1.entryId));
    assert.equal(teamDirRes.data.items.some((r) => r.entry_id === world.workerT2P2.entryId), false);
    const allDirRes = await workerRepo.listWorkers({
      auth_subject: TL_MANAGED.auth,
      app_user_id: TL_MANAGED.app,
      scope: "all",
      page_size: 25,
    });
    assert.equal(allDirRes.ok, false);
    assert.equal(allDirRes.kind, "denied");

    // Deduplicated Offboarding report (exact TEAM_1, no phone, no export/hide) & Attendance TL scope
    const offRes = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      TL_MANAGED.auth,
      TL_MANAGED.app,
      1,
      25,
    ]);
    assert.ok(parseOffboardingReportList(offRes));
    assert.equal(offRes.authority, "team_leader");
    assert.equal(offRes.scope, "team");
    assert.equal(offRes.can_export, false);
    assert.equal(offRes.can_hide, false);
    assert.deepEqual(
      offRes.items.map((x) => x.employee_code),
      [world.workerT1P1.employeeCode],
    );
    assert.equal("phone" in offRes.items[0], false);

    const attScope = (
      await dbAfter.query(
        "select scope_kind, team_ids, department_ids, can_configure_hq from public.attendance__internal_resolve_report_scope_v2($1::uuid, $2::uuid)",
        [TL_MANAGED.auth, TL_MANAGED.app],
      )
    ).rows[0];
    assert.equal(attScope.scope_kind, "team");
    assert.deepEqual(attScope.team_ids, [TEAM_1]);
    assert.equal(attScope.can_configure_hq, false);

    // Real SQL -> direct_entry_resolve_actor_context -> resolveActor -> ALL TS nav/page predicates
    const { raw: tlRaw, resolution: tlTs } = await resolveViaRealRpc(dbAfter, TL_MANAGED.auth);
    assert.deepEqual(Object.keys(tlRaw).sort(), [
      "all_scope_grants",
      "allowed_worker_tabs",
      "app_user_id",
      "assigned_roles",
      "auth_subject",
      "capabilities",
      "display_name",
      "effective_grants",
      "enabled",
      "recruiter_links",
      "team_scope_grants",
      "teams",
    ]);
    assert.deepEqual(tlRaw.capabilities, [], "Legacy capabilities array is empty after mirror purge");
    assert.deepEqual(tlRaw.team_scope_grants, [], "Legacy team_scope_grants array is empty after mirror purge");
    assert.deepEqual(tlRaw.allowed_worker_tabs, ["recruited", "team"]);
    assert.equal(tlTs.ok, true);
    assert.equal(projectAdminNavPredicate(tlTs.actor), true);
    assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true, actor: tlTs }), "ALLOW");
    assert.equal(canManageProjectMasterFromActor(tlTs), false);
    assert.equal(directEntryNavPredicate(tlTs.actor), true);
    assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: tlTs }), "ALLOW");
    assert.equal(workerOperationsTeamScopePredicate(tlTs.actor), true);
    assert.equal(workerOperationsNavPredicate(tlTs.actor), true);
    assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: tlTs }), "ALLOW");
    assert.equal(workerOperationsAllScopePredicate(tlTs.actor), false);
    assert.equal(workerOperationsReviewPredicate(tlTs.actor), false);
    assert.equal(canExportAllWorkers(tlTs.actor), false);
    assert.equal(canReadWorkerDirectoryCatalog(tlTs.actor), false);
    assert.equal(changeRequestsReviewerPredicate(tlTs.actor), true);
    assert.equal(decideChangeRequestsPageAccess({ uiEnabled: true, actor: tlTs, hasHistoricalRequests: false }), "ALLOW");
    assert.equal(workforceOffboardingNavPredicate(tlTs.actor), true);
    assert.equal(canViewOffboardingReport(tlTs.actor), true);
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: tlTs }), "ALLOW");

    // --- AFTER (#229) Fail-Closed Security & Drift Checks ---
    // 1. Latent team_master_manage @ ALL bypass is CLOSED!
    await expectInternalError(
      dbAfter,
      "select authority, team_id from public.direct_entry_assert_project_operation_authority($1::uuid, $2::uuid)",
      [TEAM_MASTER_ONLY.auth, TEAM_MASTER_ONLY.app],
      "42501",
      /team leader authority denied/,
    );
    const tmListRes = await projectRepo.listProjects({
      auth_subject: TEAM_MASTER_ONLY.auth,
      app_user_id: TEAM_MASTER_ONLY.app,
      include_inactive: false,
    });
    assert.equal(tmListRes.ok, false);
    assert.equal(tmListRes.kind, "denied");

    // 2. Deliberate DB drift: standalone direct grant team_manager_assign @ CONTEXT_TEAM (no TL assignment) -> DENIED
    await dbAfter.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, 'team_manager_assign', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Non-TL fake grant', $3::uuid)`,
      [BASE_USER.app, TEAM_2, OWNER.app],
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [BASE_USER.auth, BASE_USER.app],
      "42501",
      /team leader authority denied/,
    );
    const baseCtx = await serviceRpc(dbAfter, "direct_entry_resolve_actor_context", [BASE_USER.auth]);
    assert.equal(baseCtx.allowed_worker_tabs.includes("team"), false);

    // 3. Deliberate DB drift: multi-team ambiguity (adding extra CONTEXT_TEAM team_manager_assign for TEAM_2 on TL_MANAGED) -> DENIED
    const ambigGrantId = (
      await dbAfter.query(
        `insert into public.authz_direct_capability_grants
           (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, 'team_manager_assign', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Ambiguous second team', $3::uuid)
         returning direct_grant_id`,
        [TL_MANAGED.app, TEAM_2, OWNER.app],
      )
    ).rows[0].direct_grant_id;
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)",
      [TL_MANAGED.auth, TL_MANAGED.app, TEAM_1],
      "42501",
      /team leader authority denied/,
    );
    const ambigCtx = await serviceRpc(dbAfter, "direct_entry_resolve_actor_context", [TL_MANAGED.auth]);
    assert.equal(ambigCtx.allowed_worker_tabs.includes("team"), false);
    await dbAfter.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Clear ambiguity' where direct_grant_id = $1::uuid",
      [ambigGrantId, OWNER.app],
    );

    // 4. Deliberate DB drift: mismatched recruiter_team_memberships (TEAM_2 while TLA is TEAM_1) -> DENIED, restore -> ALLOW
    await dbAfter.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_MANAGED.recruiter, TEAM_2],
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [TL_MANAGED.auth, TL_MANAGED.app],
      "42501",
      /team leader authority denied/,
    );
    await dbAfter.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_MANAGED.recruiter, TEAM_1],
    );

    // 5. Deliberate DB drift: flipping account_type to 'SERVICE' fails closed; restoring 'NORMAL' resumes
    await dbAfter.query("update public.direct_entry_app_users set account_type = 'SERVICE' where app_user_id = $1::uuid", [
      TL_MANAGED.app,
    ]);
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [TL_MANAGED.auth, TL_MANAGED.app],
      "42501",
      /team leader authority denied/,
    );
    await dbAfter.query("update public.direct_entry_app_users set account_type = 'NORMAL' where app_user_id = $1::uuid", [
      TL_MANAGED.app,
    ]);

    // 6. Additional deliberate managed-TL drift matrix (each isolated in BEGIN ... ROLLBACK so
    //    R1 parent-deactivation cascade triggers never leak across cases):
    async function expectTlDriftDenied(mutateFn) {
      await dbAfter.exec("begin");
      try {
        await mutateFn();
        await expectInternalError(
          dbAfter,
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
          [TL_MANAGED.auth, TL_MANAGED.app],
          "42501",
          /team leader authority denied/,
        );
      } finally {
        await dbAfter.exec("rollback");
      }
    }

    // 6a. Inactive team (teams.active = false) -> DENIED
    await expectTlDriftDenied(async () => {
      await dbAfter.query("update public.teams set active = false where team_id = $1::uuid", [TEAM_1]);
    });

    // 6b. Non-HRP (vendor) & missing recruiter_provider_memberships -> DENIED
    await expectTlDriftDenied(async () => {
      await dbAfter.query(
        "update public.recruiter_provider_memberships set provider_type = 'vendor' where recruiter_id = $1::uuid and is_current",
        [TL_MANAGED.recruiter],
      );
    });
    await expectTlDriftDenied(async () => {
      await dbAfter.query(
        "update public.recruiter_provider_memberships set is_current = false, valid_to = current_date - 1 where recruiter_id = $1::uuid and is_current",
        [TL_MANAGED.recruiter],
      );
    });

    // 6c. Inactive recruiter (recruiters.active = false) -> DENIED
    await expectTlDriftDenied(async () => {
      await dbAfter.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [TL_MANAGED.recruiter]);
    });

    // 6d. Suspended, future, and expired recruiter link -> DENIED
    await expectTlDriftDenied(async () => {
      await dbAfter.query(
        "update public.direct_entry_app_user_recruiter_links set suspended_by_account_disable = true where app_user_id = $1::uuid and is_current",
        [TL_MANAGED.app],
      );
    });
    await expectTlDriftDenied(async () => {
      await dbAfter.query(
        "update public.direct_entry_app_user_recruiter_links set valid_from = public.direct_entry_authorization_date() + 2 where app_user_id = $1::uuid and is_current",
        [TL_MANAGED.app],
      );
    });
    await expectTlDriftDenied(async () => {
      await dbAfter.query(
        "update public.direct_entry_app_user_recruiter_links set valid_from = '2026-01-01', valid_to = public.direct_entry_authorization_date() where app_user_id = $1::uuid and is_current",
        [TL_MANAGED.app],
      );
    });

    // 6e. Future and expired direct_entry_team_leader_assignments -> DENIED
    await expectTlDriftDenied(async () => {
      const upd = await dbAfter.query(
        "update public.direct_entry_team_leader_assignments set valid_from = public.direct_entry_authorization_date() + 2, valid_to = null where leader_app_user_id = $1::uuid and is_current",
        [TL_MANAGED.app],
      );
      assert.equal(upd.affectedRows, 1, "Expected 1 TLA row updated for future drift");
    });
    await expectTlDriftDenied(async () => {
      const upd = await dbAfter.query(
        "update public.direct_entry_team_leader_assignments set valid_from = public.direct_entry_authorization_date() - 5, valid_to = public.direct_entry_authorization_date() where leader_app_user_id = $1::uuid and is_current",
        [TL_MANAGED.app],
      );
      assert.equal(upd.affectedRows, 1, "Expected 1 TLA row updated for expired drift");
    });

    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null) as tid",
          [TL_MANAGED.auth, TL_MANAGED.app],
        )
      ).rows[0].tid,
      TEAM_1,
    );
  } finally {
    await dbBefore.close();
    await dbAfter.close();
  }
});

// =============================================================================
// TEST 3: Canonical Managed PM Without Legacy Mirror + Quarantine Account +
//         Recruitment Posts C4 & Inactive Project Exact 22023 Ordering + Drift
// =============================================================================
test("WP8C-1 [3/6]: Managed PM without legacy mirror keeps project access & Recruitment Posts C4 + inactive-project 22023 invariant; drifted/future/expired/ambiguous PM fails closed", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    const world = await seedCanonicalPostCutoverWorld(db);
    await clearLegacyMirrors(db, [PM_MANAGED.app, ADMIN_MANAGED.app]);

    // Confirm PM_MANAGED has 0 person links & 0 legacy grants
    const pmState = (
      await db.query(
        `select u.authz_managed, u.account_type,
                (select count(*)::int from public.organization_account_person_links l
                  where l.app_user_id = u.app_user_id and l.ended_at is null) as person_links,
                (select count(*)::int from public.direct_entry_capability_grants c
                  where c.app_user_id = u.app_user_id and c.is_current) as legacy_caps
           from public.direct_entry_app_users u where u.app_user_id = $1::uuid`,
        [PM_MANAGED.app],
      )
    ).rows[0];
    assert.deepEqual(pmState, { authz_managed: true, account_type: "NORMAL", person_links: 0, legacy_caps: 0 });

    // Assigned PRJ_1 = true, unassigned PRJ_2 = false
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_is_assigned_project_manager($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      true,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_is_assigned_project_manager($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_2,
        ])
      ).rows[0].ok,
      false,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_can_access_project($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      true,
    );
    // Mirror-cleared ADMIN also passes direct_entry_actor_can_access_project via paired entry_admin @ ALL
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_can_access_project($1::uuid, $2::text) as ok", [
          ADMIN_MANAGED.app,
          PRJ_2,
        ])
      ).rows[0].ok,
      true,
    );

    // Actor context -> TS parity for PM_MANAGED
    const { raw: pmRaw, resolution: pmTs } = await resolveViaRealRpc(db, PM_MANAGED.auth);
    assert.deepEqual(pmRaw.allowed_worker_tabs, ["uploader", "recruited", "managed"]);
    assert.ok(
      pmRaw.assigned_roles.some((r) => r.role_code === "PROJECT_MANAGER" && r.scope_id === PRJ_1),
      "assigned_roles must expose PROJECT_MANAGER for PRJ_1",
    );
    assert.equal(pmTs.ok, true);
    assert.deepEqual(resolveAllowedWorkerOperationsTabs(pmTs.actor), ["uploader", "recruited", "managed"]);
    assert.equal(workerOperationsNavPredicate(pmTs.actor), true);
    assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: pmTs }), "ALLOW");
    assert.equal(projectAdminNavPredicate(pmTs.actor), false);

    // Managed worker directory & own-submission reads
    const workerRepo = createWorkerDirectoryRepository(makeNamedServiceRpcAdapter(db));
    const managedDir = await workerRepo.listWorkers({
      auth_subject: PM_MANAGED.auth,
      app_user_id: PM_MANAGED.app,
      scope: "managed",
      project_id: PRJ_1,
      page_size: 25,
    });
    assert.equal(managedDir.ok, true);
    assert.ok(managedDir.data.items.some((i) => i.entry_id === world.workerT1P1.entryId));
    const outOfScopeDir = await workerRepo.listWorkers({
      auth_subject: PM_MANAGED.auth,
      app_user_id: PM_MANAGED.app,
      scope: "managed",
      project_id: PRJ_2,
      page_size: 25,
    });
    assert.equal(outOfScopeDir.ok, false);
    assert.equal(outOfScopeDir.kind, "denied");

    const pmSubmissions = await serviceRpc(db, "direct_entry_list_own_submissions", [
      PM_MANAGED.auth,
      PM_MANAGED.app,
      25,
      null,
      "SUBMITTED",
    ]);
    assert.ok(pmSubmissions.items.some((s) => s.submission_id === world.workerT1P1.submissionId));
    const pmSubDetail = await serviceRpc(db, "direct_entry_read_own_submission", [
      PM_MANAGED.auth,
      PM_MANAGED.app,
      world.workerT1P1.submissionId,
    ]);
    assert.equal(pmSubDetail.project_scoped, true);

    // Recruitment Posts C4: active PM creates post on PRJ_1; non-PM ADMIN denied 42501
    const pmCtx = await serviceRpc(db, "recruitment_post_get_context", [PM_MANAGED.auth, PM_MANAGED.app]);
    assert.equal(pmCtx.can_create, true);
    const adminPostCtx = await serviceRpc(db, "recruitment_post_get_context", [ADMIN_MANAGED.auth, ADMIN_MANAGED.app]);
    assert.equal(adminPostCtx.can_create, false, "C4: non-PM ADMIN must NOT have can_create");

    const createdPost = await serviceRpc(db, "recruitment_post_create", [
      PM_MANAGED.auth,
      PM_MANAGED.app,
      JSON.stringify({
        project_id: PRJ_1,
        industrial_park_id: world.parkId,
        ...makeBriefContent(),
      }),
      nextUuid(),
    ]);
    assert.equal(createdPost.post.status, "PUBLISHED");

    await expectServiceRpcError(
      db,
      "recruitment_post_create",
      [
        ADMIN_MANAGED.auth,
        ADMIN_MANAGED.app,
        JSON.stringify({ project_id: PRJ_1, industrial_park_id: world.parkId, ...makeBriefContent() }),
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );

    // Verify public feed /feeds/jobs.v1.json and include_facets stay intact
    const feedRes = await serviceRpc(db, "recruitment_post_public_feed_v1", []);
    const projectedFeed = projectRecruitmentPostPublicFeedV1(feedRes);
    assert.ok(projectedFeed, "Public feed v1 must pass strict allowlist projection");
    assert.ok(projectedFeed.jobs.length >= 1);
    const facetsRes = await serviceRpc(db, "recruitment_post_list_with_facets", [
      PM_MANAGED.auth,
      PM_MANAGED.app,
      null,
      null,
      null,
      null,
      null,
      10,
      null,
      null,
    ]);
    assert.ok(projectRecruitmentPostListWithFacets(facetsRes).total_count >= 1);

    // CRITICAL INVARIANT: Deactivate PRJ_1 ->
    //   1) direct_entry_project_assignment_effective remains TRUE (historical access preserved)
    //   2) recruitment_post_get_context drops can_create to false
    //   3) recruitment_post_create raises EXACT 22023 RECRUITMENT_POST_CONTENT_INVALID (NEVER 42501!)
    //   4) non-PM ADMIN still raises 42501 RECRUITMENT_POST_ACCESS_DENIED!
    const prj1Ver = (
      await db.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_set_project_active", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      false,
      prj1Ver,
      "Deactivate PRJ_1 to verify 22023 ordering",
      `wp8c1-deact-${nextUuid()}`,
    ]);
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      true,
      "Project deactivation must NOT revoke historical PM assignment effectiveness",
    );
    const pmCtxInactive = await serviceRpc(db, "recruitment_post_get_context", [PM_MANAGED.auth, PM_MANAGED.app]);
    assert.equal(pmCtxInactive.can_create, false);
    const err22023 = await expectServiceRpcError(
      db,
      "recruitment_post_create",
      [
        PM_MANAGED.auth,
        PM_MANAGED.app,
        JSON.stringify({ project_id: PRJ_1, industrial_park_id: world.parkId, ...makeBriefContent() }),
        nextUuid(),
      ],
      "22023",
      /RECRUITMENT_POST_CONTENT_INVALID/,
    );
    assert.equal(classifyRecruitmentPostError(err22023), "RECRUITMENT_POST_CONTENT_INVALID");
    const err42501 = await expectServiceRpcError(
      db,
      "recruitment_post_create",
      [
        ADMIN_MANAGED.auth,
        ADMIN_MANAGED.app,
        JSON.stringify({ project_id: PRJ_1, industrial_park_id: world.parkId, ...makeBriefContent() }),
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );
    assert.equal(classifyRecruitmentPostError(err42501), "RECRUITMENT_POST_ACCESS_DENIED");

    // Reactivate PRJ_1 for drift tests
    await serviceRpc(db, "direct_entry_set_project_active", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      true,
      prj1Ver + 1,
      "Reactivate PRJ_1",
      `wp8c1-react-${nextUuid()}`,
    ]);

    // --- Deliberate DB Drift Checks on Managed PM ---
    // 1. Future valid_from > today on PRJ_2 -> FALSE & never leaked into worker_directory_audience('managed')
    const futureAssignId = (
      await db.query(
        `insert into public.direct_entry_project_manager_assignments
           (project_id, manager_recruiter_id, valid_from, is_current)
         values ($1, $2::uuid, public.direct_entry_authorization_date() + 7, true)
         returning assignment_id`,
        [PRJ_2, PM_MANAGED.recruiter],
      )
    ).rows[0].assignment_id;
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_2,
        ])
      ).rows[0].ok,
      false,
      "Future-dated PM assignment must NOT be effective for managed account",
    );
    const audAfterFuture = (
      await db.query(
        "select public.direct_entry_worker_directory_audience($1::uuid, $2::uuid, 'managed', null) as aud",
        [PM_MANAGED.auth, PM_MANAGED.app],
      )
    ).rows[0].aud;
    assert.deepEqual(audAfterFuture.project_ids, [PRJ_1], "Future drifted PRJ_2 must never leak into managed audience");
    await db.query("delete from public.direct_entry_project_manager_assignments where assignment_id = $1::uuid", [
      futureAssignId,
    ]);

    // 2. Expired link valid_to <= today -> FALSE; suspended_by_account_disable = true -> FALSE; SERVICE -> FALSE
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set valid_to = public.direct_entry_authorization_date() where app_user_id = $1::uuid and is_current",
      [PM_MANAGED.app],
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      false,
    );
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set valid_to = null, suspended_by_account_disable = true where app_user_id = $1::uuid and is_current",
      [PM_MANAGED.app],
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      false,
    );
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set suspended_by_account_disable = false where app_user_id = $1::uuid and is_current",
      [PM_MANAGED.app],
    );
    await db.query("update public.direct_entry_app_users set account_type = 'SERVICE' where app_user_id = $1::uuid", [
      PM_MANAGED.app,
    ]);
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      false,
    );
    await db.query("update public.direct_entry_app_users set account_type = 'NORMAL' where app_user_id = $1::uuid", [
      PM_MANAGED.app,
    ]);
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          PM_MANAGED.app,
          PRJ_1,
        ])
      ).rows[0].ok,
      true,
    );
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 4: Paired Entry Access, Dual-Role HR_OPERATOR+RECRUITER Anti-Escalation,
//         Mirror-Cleared ADMIN/RECRUITER Parity & Zero Legacy Fallback on Stale Drift
// =============================================================================
test("WP8C-1 [4/6]: Paired entry access blocks HR_OPERATOR+RECRUITER cross-scope escalation, keeps mirror-cleared ADMIN/RECRUITER parity & blocks stale legacy fallback", async () => {
  const migrations = await loadMigrations();
  const dbBefore = await createDbUpTo(migrations, WP8D_MIGRATION_NAME);
  const dbAfter = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    const beforeWorld = await seedCanonicalPostCutoverWorld(dbBefore);
    const afterWorld = await seedCanonicalPostCutoverWorld(dbAfter);

    // BEFORE (#228): canonical dual-role HR_OPERATOR (@ ALL) + RECRUITER (@ OWN) escalated document_upload to 'all' on another user's entry!
    const beforeEscalatedScope = (
      await dbBefore.query(
        "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'document_upload', $3::uuid, $4::uuid, null, null) as s",
        [HR_REC_DUAL.auth, HR_REC_DUAL.app, REC_T2.app, TEAM_2],
      )
    ).rows[0].s;
    assert.equal(beforeEscalatedScope, "all", "BEFORE #228 reproduced cross-scope document_upload escalation");

    // AFTER (#229): strictly DENIED 'resource scope denied' on other user's entry; ALLOWS 'own' on own entry; ALLOWS 'all' on document_view & audit_view!
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'document_upload', $3::uuid, $4::uuid, null, null)",
      [HR_REC_DUAL.auth, HR_REC_DUAL.app, REC_T2.app, TEAM_2],
      "42501",
      /resource scope denied/,
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_has_entry_access($1::uuid, 'document_upload', $2::uuid, $3::uuid, null) as ok",
          [HR_REC_DUAL.app, REC_T2.app, TEAM_2],
        )
      ).rows[0].ok,
      false,
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'document_upload', $3::uuid, $4::uuid, null, null) as s",
          [HR_REC_DUAL.auth, HR_REC_DUAL.app, HR_REC_DUAL.app, TEAM_1],
        )
      ).rows[0].s,
      "own",
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'document_view', $3::uuid, $4::uuid, null, null) as s",
          [HR_REC_DUAL.auth, HR_REC_DUAL.app, REC_T2.app, TEAM_2],
        )
      ).rows[0].s,
      "all",
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'entry_privileged_edit', $3::uuid, $4::uuid, null, null)",
      [HR_REC_DUAL.auth, HR_REC_DUAL.app, HR_REC_DUAL.app, TEAM_1],
      "42501",
      /capability denied/,
    );

    // Clear legacy mirrors on ADMIN_MANAGED & REC_T1 -> full parity across SQL & TS!
    await clearLegacyMirrors(dbAfter, [ADMIN_MANAGED.app, REC_T1.app]);

    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'entry_privileged_edit', $3::uuid, $4::uuid, null, null) as s",
          [ADMIN_MANAGED.auth, ADMIN_MANAGED.app, REC_T1.app, TEAM_1],
        )
      ).rows[0].s,
      "all",
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'change_review', $3::uuid, $4::uuid, null, 'all') as s",
          [ADMIN_MANAGED.auth, ADMIN_MANAGED.app, REC_T1.app, TEAM_1],
        )
      ).rows[0].s,
      "all",
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'change_review', $3::uuid, $4::uuid, null, 'team')",
      [ADMIN_MANAGED.auth, ADMIN_MANAGED.app, REC_T1.app, TEAM_1],
      "42501",
      /resource scope denied/,
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.direct_entry_resolve_direct_edit_authority($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, false, null) as auth",
          [ADMIN_MANAGED.auth, ADMIN_MANAGED.app, REC_T1.app, TEAM_1, PRJ_1],
        )
      ).rows[0].auth,
      "privileged_all",
    );

    // Mirror-cleared ADMIN & REC_T1 allowed_worker_tabs, worker_directory_audience('all'), own submissions & TS guards
    const { raw: adminRaw, resolution: adminTs } = await resolveViaRealRpc(dbAfter, ADMIN_MANAGED.auth);
    assert.deepEqual(adminRaw.capabilities, []);
    assert.deepEqual(adminRaw.all_scope_grants, []);
    assert.deepEqual(adminRaw.allowed_worker_tabs, ["uploader", "all"]);
    assert.equal(adminTs.ok, true);
    assert.equal(workerOperationsAllScopePredicate(adminTs.actor), true);
    assert.equal(workerOperationsReviewPredicate(adminTs.actor), true);
    assert.equal(canExportAllWorkers(adminTs.actor), true);
    assert.equal(canReviewChangeRequests(adminTs.actor), true);
    assert.equal(
      canViewGlobalChangeRequestHistory(adminTs.actor.capabilities, adminTs.actor.scopes, adminTs.actor.effective_grants),
      true,
    );
    assert.equal(canReadWorkerDirectoryCatalog(adminTs.actor), true);
    assert.equal(changeRequestsProposerPredicate(adminTs.actor), true);
    const adminAllAud = (
      await dbAfter.query(
        "select public.direct_entry_worker_directory_audience($1::uuid, $2::uuid, 'all', null) as aud",
        [ADMIN_MANAGED.auth, ADMIN_MANAGED.app],
      )
    ).rows[0].aud;
    assert.equal(adminAllAud.scope, "all");

    const { raw: recRaw, resolution: recTs } = await resolveViaRealRpc(dbAfter, REC_T1.auth);
    assert.deepEqual(recRaw.capabilities, []);
    assert.deepEqual(recRaw.allowed_worker_tabs, ["uploader", "recruited"]);
    assert.equal(recTs.ok, true);
    assert.equal(directEntryNavPredicate(recTs.actor), true);
    assert.equal(canReadWorkerDirectoryCatalog(recTs.actor), true);
    assert.equal(changeRequestsProposerPredicate(recTs.actor), true);
    assert.equal(workerOperationsAllScopePredicate(recTs.actor), false);
    const recOwnSubs = await serviceRpc(dbAfter, "direct_entry_list_own_submissions", [
      REC_T1.auth,
      REC_T1.app,
      25,
      null,
      null,
    ]);
    assert.ok(recOwnSubs.items.some((s) => s.submission_id === afterWorld.workerT1P1.submissionId));
    const recSubDetail = await serviceRpc(dbAfter, "direct_entry_read_own_submission", [
      REC_T1.auth,
      REC_T1.app,
      afterWorld.workerT1P1.submissionId,
    ]);
    assert.equal(recSubDetail.project_scoped, false);

    // Deliberate DB drift: stale legacy capability & scope grants on managed BASE_USER (empty effective_grants) -> ZERO fallback!
    for (const cap of ["entry_admin", "change_review", "submission_create", "entry_privileged_edit", "document_upload"]) {
      await dbAfter.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [BASE_USER.app, cap],
      );
    }
    await dbAfter.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true), ($1::uuid, 'own', null, '2026-01-01', true)",
      [BASE_USER.app],
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'entry_privileged_edit', $3::uuid, $4::uuid, null, null)",
      [BASE_USER.auth, BASE_USER.app, BASE_USER.app, TEAM_2],
      "42501",
      /capability denied/,
    );
    await expectInternalError(
      dbAfter,
      "select public.direct_entry_worker_directory_audience($1::uuid, $2::uuid, 'all', null)",
      [BASE_USER.auth, BASE_USER.app],
      "42501",
      /worker directory requires all scope/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_list_own_submissions",
      [BASE_USER.auth, BASE_USER.app, 25, null, null],
      "42501",
      /submission scope denied/,
    );
    const { raw: staleRaw, resolution: staleTs } = await resolveViaRealRpc(dbAfter, BASE_USER.auth);
    assert.deepEqual(staleRaw.effective_grants, [], "Managed BASE_USER has empty effective_grants");
    assert.deepEqual(staleRaw.allowed_worker_tabs, ["recruited"], "Stale legacy must NOT open uploader or all tabs");
    assert.equal(staleTs.ok, true);
    assert.equal(workerOperationsAllScopePredicate(staleTs.actor), false);
    assert.equal(directEntryNavPredicate(staleTs.actor), false);
    assert.equal(canExportAllWorkers(staleTs.actor), false);
    assert.equal(
      canViewGlobalChangeRequestHistory(staleTs.actor.capabilities, staleTs.actor.scopes, staleTs.actor.effective_grants),
      false,
    );

    assert.ok(beforeWorld.workerT1P1.entryId);
  } finally {
    await dbBefore.close();
    await dbAfter.close();
  }
});

// =============================================================================
// TEST 5: Revoke, Disable & Re-Enable Lifecycle (D10 + Independent Personal Roles)
// =============================================================================
test("WP8C-1 [5/6]: Disable blocks runtime without deleting history; D10 re-enable restores intact roles & never resurrects replaced TL; unassign PM / revoke TL preserve independent roles", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    const world = await seedCanonicalPostCutoverWorld(db);

    // Baseline: COMBO_USER holds RECRUITER + TEAM_LEADER (TEAM_3) + PROJECT_MANAGER (PRJ_3)
    const beforeCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [COMBO_USER.auth]);
    assert.deepEqual(beforeCtx.allowed_worker_tabs, ["uploader", "recruited", "managed", "team"]);
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid) as tid",
          [COMBO_USER.auth, COMBO_USER.app, TEAM_3],
        )
      ).rows[0].tid,
      TEAM_3,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_is_assigned_project_manager($1::uuid, $2::text) as ok", [
          COMBO_USER.app,
          PRJ_3,
        ])
      ).rows[0].ok,
      true,
    );

    // 1. Disable COMBO_USER -> blocks runtime immediately, does NOT delete role/TL/PM assignment rows!
    const ver1 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [COMBO_USER.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      COMBO_USER.app,
      ver1,
      "WP8C1 D10 disable check",
      `wp8c1-dis1-${nextUuid()}`,
    ]);
    await expectInternalError(
      db,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [COMBO_USER.auth, COMBO_USER.app],
      "42501",
      /actor mapping denied/,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_project_assignment_effective($1::uuid, $2::text) as ok", [
          COMBO_USER.app,
          PRJ_3,
        ])
      ).rows[0].ok,
      false,
    );
    await expectInternalError(
      db,
      "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'document_upload', $3::uuid, $4::uuid, null, null)",
      [COMBO_USER.auth, COMBO_USER.app, COMBO_USER.app, TEAM_3],
      "42501",
      /actor mapping denied/,
    );
    const { resolution: disRes } = await resolveViaRealRpc(db, COMBO_USER.auth);
    assert.equal(disRes.ok, false);
    assert.equal(disRes.reason, "ACTOR_DISABLED");
    assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true, actor: disRes }), "ACCOUNT_UNAVAILABLE");

    // Verify historical rows were NOT deleted
    const preservedCounts = (
      await db.query(
        `select
           (select count(*)::int from public.authz_account_role_assignments
             where app_user_id = $1::uuid and role_code = 'RECRUITER' and ended_at is null) as rec_roles,
           (select count(*)::int from public.direct_entry_team_leader_assignments
             where leader_app_user_id = $1::uuid and team_id = $2::uuid and suspended_by_account_disable) as susp_tla,
           (select count(*)::int from public.direct_entry_project_manager_assignments
             where manager_recruiter_id = $3::uuid and project_id = $4 and is_current and revoked_at is null) as pm_rows`,
        [COMBO_USER.app, TEAM_3, COMBO_USER.recruiter, PRJ_3],
      )
    ).rows[0];
    assert.deepEqual(preservedCounts, { rec_roles: 1, susp_tla: 1, pm_rows: 1 });

    // 2. Re-enable COMBO_USER (D10) -> all 3 independent authorities (RECRUITER + TL + PM) cleanly restored!
    const ver2 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [COMBO_USER.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      COMBO_USER.app,
      ver2,
      "WP8C1 D10 enable check",
      `wp8c1-en1-${nextUuid()}`,
    ]);
    const afterReenableCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [COMBO_USER.auth]);
    assert.deepEqual(afterReenableCtx.allowed_worker_tabs, ["uploader", "recruited", "managed", "team"]);
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid) as tid",
          [COMBO_USER.auth, COMBO_USER.app, TEAM_3],
        )
      ).rows[0].tid,
      TEAM_3,
    );
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_is_assigned_project_manager($1::uuid, $2::text) as ok", [
          COMBO_USER.app,
          PRJ_3,
        ])
      ).rows[0].ok,
      true,
    );

    // 3. Unassign PM (PRJ_3) -> loses 'managed' & PM authority, KEEPS independent RECRUITER ('uploader','recruited') & TEAM_LEADER ('team')!
    const prj3Ver = (
      await db.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_3])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_unassign_project_manager", [
      OWNER.auth,
      OWNER.app,
      world.pm3Assign.assignment_id,
      world.pm3Assign.version,
      prj3Ver,
      "Unassign PM on PRJ_3",
      `wp8c1-unpm3-${nextUuid()}`,
    ]);
    assert.equal(
      (
        await db.query("select public.direct_entry_actor_is_assigned_project_manager($1::uuid, $2::text) as ok", [
          COMBO_USER.app,
          PRJ_3,
        ])
      ).rows[0].ok,
      false,
    );
    const afterUnpmCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [COMBO_USER.auth]);
    assert.deepEqual(afterUnpmCtx.allowed_worker_tabs, ["uploader", "recruited", "team"]);

    // 4. Revoke TL (TEAM_3) -> loses 'team', KEEPS independent RECRUITER ('uploader','recruited')!
    const team3Ver = (
      await db.query("select version from public.teams where team_id = $1::uuid", [TEAM_3])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_revoke_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_3,
      null,
      team3Ver,
      "Revoke TL on TEAM_3",
      `wp8c1-revtl3-${nextUuid()}`,
    ]);
    await expectInternalError(
      db,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [COMBO_USER.auth, COMBO_USER.app],
      "42501",
      /team leader authority denied/,
    );
    const afterRevTlCtx = await serviceRpc(db, "direct_entry_resolve_actor_context", [COMBO_USER.auth]);
    assert.deepEqual(afterRevTlCtx.allowed_worker_tabs, ["uploader", "recruited"]);

    // 5. D10 Replaced-While-Disabled: disable TL_MANAGED (TEAM_1), designate TL_REPLACE on TEAM_1, re-enable TL_MANAGED ->
    //    TL_MANAGED MUST NOT resurrect as TEAM_1 leader!
    const tlVer1 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_MANAGED.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      TL_MANAGED.app,
      tlVer1,
      "Disable TL_MANAGED before replacement",
      `wp8c1-dis-tl1-${nextUuid()}`,
    ]);
    const t1Ver = (await db.query("select version from public.teams where team_id = $1::uuid", [TEAM_1])).rows[0]
      .version;
    await serviceRpc(db, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      TL_REPLACE.app,
      null,
      t1Ver,
      "Replace disabled TL_MANAGED with TL_REPLACE",
      `wp8c1-rep-tl1-${nextUuid()}`,
    ]);
    const tlVer2 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_MANAGED.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      TL_MANAGED.app,
      tlVer2,
      "Re-enable replaced TL_MANAGED",
      `wp8c1-en-tl1-${nextUuid()}`,
    ]);
    await expectInternalError(
      db,
      "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, null)",
      [TL_MANAGED.auth, TL_MANAGED.app],
      "42501",
      /team leader authority denied/,
    );
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid) as tid",
          [TL_REPLACE.auth, TL_REPLACE.app, TEAM_1],
        )
      ).rows[0].tid,
      TEAM_1,
    );
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 6: Pre-Cutover (authz_managed=false) Compatibility & Error Classifiers
// =============================================================================
test("WP8C-1 [6/6]: Pre-cutover (authz_managed=false) R1 TL/PM/entry guards & real TS error classifiers remain 100% compatible", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    const PRE_ADMIN = {
      auth: "18c10000-0000-4000-8000-000000000091",
      app: "28c10000-0000-4000-8000-000000000091",
      recruiter: "38c10000-0000-4000-8000-000000000091",
      email: "preadmin.wp8c1@hrpartner.vn",
      name: "Pre-Cutover R1 Admin",
    };
    const PRE_TL = {
      auth: "18c10000-0000-4000-8000-000000000092",
      app: "28c10000-0000-4000-8000-000000000092",
      recruiter: "38c10000-0000-4000-8000-000000000092",
      email: "pretl.wp8c1@hrpartner.vn",
      name: "Pre-Cutover TL",
    };
    const PRE_TEAM = "48c10000-0000-4000-8000-000000000091";
    const PRE_PRJ = "wp8c1-pre-prj";

    await seedAccount(db, PRE_ADMIN);
    await seedAccount(db, PRE_TL);
    await db.query("insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'PRE_T1', 'Pre Team', true)", [
      PRE_TEAM,
    ]);
    await db.query("insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Pre Project', true)", [
      PRE_PRJ,
    ]);

    // R1 pre-cutover admin with historical valid_to='2021-01-01', is_current=true
    for (const cap of [
      "entry_admin",
      "recruiter_master_manage",
      "team_master_manage",
      "entry_privileged_edit",
      "submission_create",
      "change_review",
    ]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, $2, '2020-01-01', '2021-01-01', true)",
        [PRE_ADMIN.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current) values ($1::uuid, 'all', null, '2020-01-01', '2021-01-01', true), ($1::uuid, 'own', null, '2020-01-01', '2021-01-01', true)",
      [PRE_ADMIN.app],
    );
    await db.query("insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, 'Pre Admin Rec', true)", [
      PRE_ADMIN.recruiter,
    ]);
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current) values ($1::uuid, $2::uuid, true, '2020-01-01', '2021-01-01', true)",
      [PRE_ADMIN.app, PRE_ADMIN.recruiter],
    );

    // Pre-cutover TL
    await seedRecruiterAndTeam(db, PRE_TL, PRE_TEAM);
    await serviceRpc(db, "direct_entry_designate_team_leader", [
      PRE_ADMIN.auth,
      PRE_ADMIN.app,
      PRE_TEAM,
      PRE_TL.app,
      null,
      1,
      "Pre-cutover TL designation",
      `wp8c1-pretl-${nextUuid()}`,
    ]);

    // Pre-cutover checks
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid) as tid",
          [PRE_TL.auth, PRE_TL.app, PRE_TEAM],
        )
      ).rows[0].tid,
      PRE_TEAM,
    );
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'entry_privileged_edit', $3::uuid, $4::uuid, null, null) as s",
          [PRE_ADMIN.auth, PRE_ADMIN.app, PRE_TL.app, PRE_TEAM],
        )
      ).rows[0].s,
      "all",
    );
    const { raw: preAdminRaw, resolution: preAdminTs } = await resolveViaRealRpc(db, PRE_ADMIN.auth);
    assert.deepEqual(preAdminRaw.allowed_worker_tabs, ["uploader", "recruited", "all"]);
    assert.equal(preAdminTs.ok, true);
    assert.equal(projectAdminNavPredicate(preAdminTs.actor), true);
    assert.equal(workerOperationsAllScopePredicate(preAdminTs.actor), true);

    const { raw: preTlRaw, resolution: preTlTs } = await resolveViaRealRpc(db, PRE_TL.auth);
    assert.deepEqual(preTlRaw.allowed_worker_tabs, ["recruited", "team"]);
    assert.equal(preTlTs.ok, true);
    assert.equal(projectAdminNavPredicate(preTlTs.actor), true);
    assert.equal(workerOperationsTeamScopePredicate(preTlTs.actor), true);

    // Pre-cutover R1 Recruiter with historical own valid_to='2021-01-01', is_current=true:
    // SQL direct_entry_has_scope('own') = true AND direct_entry_resolve_actor_context -> TS guards must ALLOW!
    const PRE_REC = {
      auth: "18c10000-0000-4000-8000-000000000093",
      app: "28c10000-0000-4000-8000-000000000093",
      recruiter: "38c10000-0000-4000-8000-000000000093",
      email: "prerec.wp8c1@hrpartner.vn",
      name: "Pre-Cutover R1 Recruiter",
    };
    await seedAccount(db, PRE_REC);
    for (const cap of ["entry_own", "entry_create", "submission_create", "change_request_create"]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, $2, '2020-01-01', '2021-01-01', true)",
        [PRE_REC.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current) values ($1::uuid, 'own', null, '2020-01-01', '2021-01-01', true)",
      [PRE_REC.app],
    );
    assert.equal(
      (
        await db.query(
          "select public.direct_entry_assert_entry_access($1::uuid, $2::uuid, 'entry_own', $2::uuid, null, null, null) as s",
          [PRE_REC.auth, PRE_REC.app],
        )
      ).rows[0].s,
      "own",
    );
    const { raw: preRecRaw, resolution: preRecTs } = await resolveViaRealRpc(db, PRE_REC.auth);
    assert.deepEqual(preRecRaw.allowed_worker_tabs, ["uploader"]);
    assert.equal(preRecTs.ok, true);
    assert.equal(directEntryNavPredicate(preRecTs.actor), true, "Pre-cutover R1 Recruiter must pass directEntryNavPredicate");
    assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: preRecTs }), "ALLOW");
    assert.equal(canReadWorkerDirectoryCatalog(preRecTs.actor), true);
    assert.equal(changeRequestsProposerPredicate(preRecTs.actor), true);
    assert.equal(workerOperationsNavPredicate(preRecTs.actor), true);
    assert.equal(changeRequestsReviewerPredicate(preRecTs.actor), false);

    // Pre-cutover Team Reviewer (change_review + active team scope, without team_manager_assign):
    // Must retain changeRequestsReviewerPredicate = true through effective_grants LEGACY_BRIDGE.
    const PRE_TEAM_REV = {
      auth: "18c10000-0000-4000-8000-000000000094",
      app: "28c10000-0000-4000-8000-000000000094",
      recruiter: "38c10000-0000-4000-8000-000000000094",
      email: "preteamrev.wp8c1@hrpartner.vn",
      name: "Pre-Cutover Team Reviewer",
    };
    await seedAccount(db, PRE_TEAM_REV);
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, 'change_review', '2020-01-01', null, true)",
      [PRE_TEAM_REV.app],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current) values ($1::uuid, 'team', $2::uuid, '2020-01-01', null, true)",
      [PRE_TEAM_REV.app, PRE_TEAM],
    );
    const { resolution: preTeamRevTs } = await resolveViaRealRpc(db, PRE_TEAM_REV.auth);
    assert.equal(preTeamRevTs.ok, true);
    assert.equal(
      changeRequestsReviewerPredicate(preTeamRevTs.actor),
      true,
      "Pre-cutover team reviewer (change_review + team scope) must pass changeRequestsReviewerPredicate",
    );
    assert.equal(workerOperationsReviewPredicate(preTeamRevTs.actor), false);

    // Verify real TS error classifiers preserve exact SQLSTATE -> kind mappings
    assert.equal(classifyProjectAdminError({ code: "42501", message: "team leader authority denied" }), "denied");
    assert.equal(classifyWorkerDirectoryError({ code: "42501", message: "worker directory requires all scope" }), "denied");
    assert.equal(classifyWorkerDirectoryError({ code: "42501", message: "resource scope denied" }), "denied");
    assert.equal(
      classifyRecruitmentPostError({ code: "22023", message: "RECRUITMENT_POST_CONTENT_INVALID" }),
      "RECRUITMENT_POST_CONTENT_INVALID",
    );
    assert.equal(
      classifyRecruitmentPostError({ code: "42501", message: "RECRUITMENT_POST_ACCESS_DENIED" }),
      "RECRUITMENT_POST_ACCESS_DENIED",
    );
  } finally {
    await db.close();
  }
});
