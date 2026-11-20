/**
 * WP8B-2 — Location Catalog, Recruitment Posts & Offboarding on WP5 Paired Effective Access
 * PGlite End-to-End Database, Before/After Behavioral Diff, Full 3-Domain Authority Matrix,
 * C4 + Public Feed + Facets + Mobile Pagination, SQL -> Resolver -> TS Guard Parity &
 * Revoke/Disable/Error-Classifier Verification Suite.
 *
 * Covers:
 *   1. Migration #227 hygiene (0 '@', 0 SAVEPOINT, 0 ALTER DEFAULT PRIVILEGES, single outer
 *      BEGIN/COMMIT, LF/CRLF-identical SHA-256), atomic rollback safety, exact 336 service_role
 *      RPC allowlist (0 new public RPCs), strict internal ACL/owner/STABLE/search_path/overload
 *      checks on all 4 internal authz guards, and exact 19 recruitment_post* routines with 0 '@'.
 *   2. Explicit BEFORE (#226) vs AFTER (#227) behavioral diff proof across all 3 domains:
 *      - Real canonical dual-role HR_OPERATOR (@ ALL) + TEAM_LEADER (@ CONTEXT_TEAM):
 *        BEFORE #226 falsely escalated into Location Catalog & Recruitment Posts Full Admin/BoD;
 *        AFTER #227 strictly DENIED (42501 / P0002) on Location Catalog & Recruitment Posts
 *        while preserving own-team Offboarding authority (no escalation to all/bod).
 *      - Simulated DB-level stale-legacy & cross-scope drift fixtures (D1, D2, D3) clearly
 *        separated from canonical states: BEFORE #226 allowed; AFTER #227 strictly DENIED.
 *   3. Post-cutover canonical 3-domain authority matrix + hard invariants:
 *      - Location Catalog: ADMIN (audit 'entry_admin'), BoD privileged ('entry_privileged_edit'),
 *        BoD reports ('report_analytics_view'), denied roles, disabled/wrong-mapping/Owner protection.
 *      - Recruitment Posts: C4 strictly PM-only create (ADMIN & BoD denied create), active PM
 *        create/edit, Admin/BoD edit/withdraw/withdrawn-get override, public feed /feeds/jobs.v1.json
 *        allowlist & zero PII, include_facets=true exact counts/filters & cursor/snapshot pagination.
 *      - Offboarding: ADMIN & BoD privileged (all scope + phone + export + hide without mutating
 *        historical entries/events), BoD reports-only DENIED (policy preserved), Team Leader &
 *        dual-role HR_OPERATOR+TL scoped to own team only (no phone, export/hide denied 42501).
 *   4. End-to-end SQL -> direct_entry_resolve_actor_context (exact 12 keys) -> real resolveActor
 *      -> real TS nav/page/API guards across pre-cutover R1, pre-cutover normal, post-cutover
 *      canonical, dual-role HR_OPERATOR+TL, and post-cutover stale-legacy/cross-scope drift.
 *   5. Revoke/disable lifecycle fail-closed transitions & live TS error-classifier compatibility.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  canViewOffboardingReport,
  decideRecruitmentLocationCatalogPageAccess,
  decideWorkforceOffboardingPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import {
  recruitmentLocationCatalogNavPredicate,
  workforceOffboardingNavPredicate,
} from "../src/lib/navigation/registry-capability.ts";
import { listProvincesCatalog } from "../src/lib/recruitment-locations/location-catalog-api.ts";
import { canManageRecruitmentLocations } from "../src/lib/recruitment-locations/location-catalog-contract.ts";
import { classifyLocationCatalogError } from "../src/lib/recruitment-locations/location-catalog-repository.ts";
import {
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostPublicFeedV1,
} from "../src/lib/recruitment-posts/contract.ts";
import { classifyRecruitmentPostError } from "../src/lib/recruitment-posts/repository.ts";
import { parseOffboardingReportList } from "../src/lib/workforce/offboarding-report-contract.ts";
import { migrationChecksum } from "./lib/migration-validation.mjs";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8B1_MIGRATION_NAME = "20261120120000_wp8b1_shared_admin_guards.sql";
const WP8B2_MIGRATION_NAME = "20261120130000_wp8b2_location_posts_offboarding.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18b20000-0000-4000-8000-000000000001",
  app: "28b20000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical WP8B2",
};
const LUANPT = {
  auth: "18b20000-0000-4000-8000-000000000002",
  app: "28b20000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18b20000-0000-4000-8000-000000000003",
  app: "28b20000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18b20000-0000-4000-8000-000000000004",
  app: "28b20000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const BOD_PRIV = {
  auth: "18b20000-0000-4000-8000-000000000005",
  app: "28b20000-0000-4000-8000-000000000005",
  email: "bod.priv.wp8b2@hrpartner.vn",
  name: "BoD Privileged Direct Grant",
};
const BOD_REPORTS = {
  auth: "18b20000-0000-4000-8000-000000000006",
  app: "28b20000-0000-4000-8000-000000000006",
  email: "bod.reports.wp8b2@hrpartner.vn",
  name: "BoD Executive Reports Direct Grant",
};
const HR_OP = {
  auth: "18b20000-0000-4000-8000-000000000007",
  app: "28b20000-0000-4000-8000-000000000007",
  email: "hrop.wp8b2@hrpartner.vn",
  name: "HR Operator WP8B2",
};
const TL_USER = {
  auth: "18b20000-0000-4000-8000-000000000008",
  app: "28b20000-0000-4000-8000-000000000008",
  recruiter: "38b20000-0000-4000-8000-000000000008",
  email: "tl.wp8b2@hrpartner.vn",
  name: "Team Leader One WP8B2",
};
const HR_TL_DUAL = {
  auth: "18b20000-0000-4000-8000-000000000009",
  app: "28b20000-0000-4000-8000-000000000009",
  recruiter: "38b20000-0000-4000-8000-000000000009",
  email: "hrtl.wp8b2@hrpartner.vn",
  name: "HR Operator Plus TL WP8B2",
};
const PM_ONE = {
  auth: "18b20000-0000-4000-8000-000000000010",
  app: "28b20000-0000-4000-8000-000000000010",
  recruiter: "38b20000-0000-4000-8000-000000000010",
  email: "pm1.wp8b2@hrpartner.vn",
  name: "Project Manager One WP8B2",
};
const PM_TWO = {
  auth: "18b20000-0000-4000-8000-000000000011",
  app: "28b20000-0000-4000-8000-000000000011",
  recruiter: "38b20000-0000-4000-8000-000000000011",
  email: "pm2.wp8b2@hrpartner.vn",
  name: "Project Manager Two WP8B2",
};
const PA_USER = {
  auth: "18b20000-0000-4000-8000-000000000012",
  app: "28b20000-0000-4000-8000-000000000012",
  email: "pa.wp8b2@hrpartner.vn",
  name: "Project Accountant WP8B2",
};
const REC_T1 = {
  auth: "18b20000-0000-4000-8000-000000000013",
  app: "28b20000-0000-4000-8000-000000000013",
  recruiter: "38b20000-0000-4000-8000-000000000013",
  email: "rec1.wp8b2@hrpartner.vn",
  name: "Recruiter Team One WP8B2",
};
const REC_T2 = {
  auth: "18b20000-0000-4000-8000-000000000014",
  app: "28b20000-0000-4000-8000-000000000014",
  recruiter: "38b20000-0000-4000-8000-000000000014",
  email: "rec2.wp8b2@hrpartner.vn",
  name: "Recruiter Team Two WP8B2",
};
const BASE_USER = {
  auth: "18b20000-0000-4000-8000-000000000015",
  app: "28b20000-0000-4000-8000-000000000015",
  email: "base.wp8b2@hrpartner.vn",
  name: "Employee Base WP8B2",
};
const DISABLED_ADMIN = {
  auth: "18b20000-0000-4000-8000-000000000016",
  app: "28b20000-0000-4000-8000-000000000016",
  email: "disabled.admin.wp8b2@hrpartner.vn",
  name: "Disabled Admin WP8B2",
};
const TEMP_ADMIN = {
  auth: "18b20000-0000-4000-8000-000000000017",
  app: "28b20000-0000-4000-8000-000000000017",
  email: "temp.admin.wp8b2@hrpartner.vn",
  name: "Temporary Revokable Admin WP8B2",
};
// Simulated DB-level drift fixtures (explicitly separated from canonical API states)
const DRIFT_D1_STALE_BOD_PRIV = {
  auth: "18b20000-0000-4000-8000-000000000018",
  app: "28b20000-0000-4000-8000-000000000018",
  email: "drift.d1.wp8b2@hrpartner.vn",
  name: "Drift D1 Stale BoD Priv",
};
const DRIFT_D2_STALE_BOD_REPORTS = {
  auth: "18b20000-0000-4000-8000-000000000019",
  app: "28b20000-0000-4000-8000-000000000019",
  email: "drift.d2.wp8b2@hrpartner.vn",
  name: "Drift D2 Stale BoD Reports",
};
const DRIFT_D3_CROSS_SCOPE_PRIV = {
  auth: "18b20000-0000-4000-8000-000000000020",
  app: "28b20000-0000-4000-8000-000000000020",
  email: "drift.d3.wp8b2@hrpartner.vn",
  name: "Drift D3 Cross Scope Priv",
};

const TEAM_1 = "48b20000-0000-4000-8000-000000000001";
const TEAM_2 = "48b20000-0000-4000-8000-000000000002";
const PRJ_1 = "wp8b2_prj_1";
const PRJ_2 = "wp8b2_prj_2";

const ADMIN_SEED_CAPS = [
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

let seq = 1;
function nextUuid() {
  return `98b20000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stripOuterTransaction(sql) {
  return sql
    .replace(/^\s*(?:--[^\n]*\r?\n|\s)*begin\s*;/i, "")
    .replace(/\bcommit\s*;\s*$/i, "");
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

async function createDbUpTo(migrations, inclusiveLastName) {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  for (const m of migrations) {
    await db.exec(m.sql);
    if (m.name === inclusiveLastName) break;
  }
  return db;
}

async function serviceRpc(db, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("set role service_role;");
  try {
    const { rows } = await db.query(`select public.${fnName}(${placeholders}) as res`, args);
    return rows[0]?.res;
  } finally {
    await db.exec("reset role;");
  }
}

async function expectServiceRpcError(db, fnName, args, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await serviceRpc(db, fnName, args);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected ${fnName} to fail with ${expectedCode}`);
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

async function revokeGlobalRole(db, actor, target, assignmentId, reason) {
  const ver = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(db, "direct_entry_authz_revoke_global_role_admin", [
    actor.auth,
    actor.app,
    target.app,
    assignmentId,
    ver,
    reason,
    key,
    sha256(`revoke:${target.app}:${assignmentId}:${key}`),
  ]);
}

function makeBriefContent(overrides = {}) {
  return {
    general: {
      customer_name: "Công ty TNHH Điện tử WP8B2",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Sản xuất linh kiện điện tử",
      job_description: "Lắp ráp linh kiện phòng sạch",
      environment_types: ["CLEAN_ROOM", "NORMAL_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Project Manager One WP8B2",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục các ngày trong tuần",
      expected_headcount: 80,
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

async function seedOffboardedWorker(
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
  },
) {
  const dates = (
    await db.query(
      "select (public.direct_entry_authorization_date() - 12)::text as start_d, (public.direct_entry_authorization_date() - 5)::text as off_d",
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
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'WP8B2 offboarding seed')",
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
          phone: phone === null ? { state: "omitted" } : { state: "provided", value: phone },
        }),
        recruiterId,
        teamId,
      ],
    );
    await seedLegacyReviewSubmission(db, submissionId);
    await db.query(
      `update public.direct_entry_submissions
          set state = 'SUBMITTED',
              submitted_at = coalesce(submitted_at, now()),
              version = 3
        where submission_id = $1::uuid`,
      [submissionId],
    );
    await db.query(
      `insert into public.direct_entry_employment_status_events (
         event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
         version, actor_user_id, reason_id, supersedes_event_id
       ) values ($1::uuid, $2::uuid, 'ON', $3::date, null, null, 1, $4::uuid, $5::uuid, null)`,
      [onEventId, entryId, dates.start_d, createdByUserId, reasonId],
    );
    await db.query(
      `insert into public.direct_entry_employment_status_events (
         event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
         version, actor_user_id, reason_id, supersedes_event_id
       ) values ($1::uuid, $2::uuid, 'OFF', $3::date, $3::date, 'Nghỉ việc cá nhân', 2, $4::uuid, $5::uuid, null)`,
      [offEventId, entryId, dates.off_d, createdByUserId, reasonId],
    );
    await db.exec("commit");
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }

  return { entryId, offEventId, cccd, employeeCode: fullEmployeeCode };
}

async function seedPostCutoverWorld(db) {
  const users = [
    OWNER,
    LUANPT,
    LIENVU,
    NGATTT,
    BOD_PRIV,
    BOD_REPORTS,
    HR_OP,
    TL_USER,
    HR_TL_DUAL,
    PM_ONE,
    PM_TWO,
    PA_USER,
    REC_T1,
    REC_T2,
    BASE_USER,
    DISABLED_ADMIN,
    TEMP_ADMIN,
    DRIFT_D1_STALE_BOD_PRIV,
    DRIFT_D2_STALE_BOD_REPORTS,
    DRIFT_D3_CROSS_SCOPE_PRIV,
  ];
  for (const u of users) {
    await seedAccount(db, u);
  }

  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of ADMIN_SEED_CAPS) {
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

  await db.query(
    `insert into public.teams (team_id, code, display_name, active) values
      ($1::uuid, 'WP8B2_T1', 'Team WP8B2 One', true),
      ($2::uuid, 'WP8B2_T2', 'Team WP8B2 Two', true)`,
    [TEAM_1, TEAM_2],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active) values
      ($1, 'Project WP8B2 One', true),
      ($2, 'Project WP8B2 Two', true)`,
    [PRJ_1, PRJ_2],
  );

  // Run canonical WP5B-2 cutover (sets authz_managed = true on all accounts, protects OWNER)
  const cutoverPlan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
  const cutoverResult = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: cutoverPlan.manifest_fingerprint,
  });
  assert.equal(cutoverResult.status, "APPLIED", "WP5 cutover must succeed");

  await seedRecruiterAndTeam(db, TL_USER, TEAM_1);
  await seedRecruiterAndTeam(db, HR_TL_DUAL, TEAM_2);
  await seedRecruiterAndTeam(db, PM_ONE, TEAM_1);
  await seedRecruiterAndTeam(db, PM_TWO, TEAM_1);
  await seedRecruiterAndTeam(db, REC_T1, TEAM_1);
  await seedRecruiterAndTeam(db, REC_T2, TEAM_2);

  // Assign canonical global roles
  await assignGlobalRole(db, OWNER, HR_OP, "HR_OPERATOR", "Seed canonical HR_OPERATOR");
  await assignGlobalRole(db, OWNER, HR_TL_DUAL, "HR_OPERATOR", "Seed HR_OPERATOR for canonical HR+TL dual role");
  await assignGlobalRole(db, OWNER, REC_T1, "RECRUITER", "Seed canonical RECRUITER T1");
  await assignGlobalRole(db, OWNER, REC_T2, "RECRUITER", "Seed canonical RECRUITER T2");
  await assignGlobalRole(db, OWNER, DISABLED_ADMIN, "ADMIN", "Seed ADMIN before disabling");
  await assignGlobalRole(db, OWNER, TEMP_ADMIN, "ADMIN", "Seed revokable ADMIN");

  // Disable DISABLED_ADMIN through canonical lifecycle RPC
  const disabledAdminVer = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [DISABLED_ADMIN.app])
  ).rows[0].version;
  await serviceRpc(db, "direct_entry_disable_app_user", [
    OWNER.auth,
    OWNER.app,
    DISABLED_ADMIN.app,
    disabledAdminVer,
    "Disable admin for WP8B-2 negative matrix",
    `wp8b2-disable-admin-${nextUuid()}`,
  ]);

  // Designate canonical contextual TEAM_LEADERs through canonical RPC
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_1,
    TL_USER.app,
    null,
    1,
    "Designate canonical TL on TEAM_1",
    `wp8b2-tl1-${nextUuid()}`,
  ]);
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_2,
    HR_TL_DUAL.app,
    null,
    1,
    "Designate TL on TEAM_2 for canonical HR_OPERATOR+TL dual role",
    `wp8b2-tl2-${nextUuid()}`,
  ]);

  // Assign contextual PMs on PRJ_1 (both PM_ONE and PM_TWO assigned to PRJ_1; neither on PRJ_2)
  await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_1,
    PM_ONE.recruiter,
    null,
    1,
    "Assign PM_ONE on PRJ_1",
    `wp8b2-pm1-${nextUuid()}`,
  ]);
  await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_1,
    PM_TWO.recruiter,
    null,
    2,
    "Assign PM_TWO on PRJ_1",
    `wp8b2-pm2-${nextUuid()}`,
  ]);

  // Assign contextual PA on PRJ_1
  await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
  await db.query(
    `insert into public.vendor_finance_project_accountants
      (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
     values ($1, $2::uuid, 1, '2026-01-01', $3::uuid, 'Seed PA')`,
    [PRJ_1, PA_USER.app, OWNER.app],
  );
  await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

  // Canonical direct grants for BoD privileged (entry_privileged_edit @ ALL) and
  // BoD executive reports (report_analytics_view + report_view @ ALL)
  await db.query(
    `insert into public.authz_direct_capability_grants
      (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values
      ($1::uuid, 'entry_privileged_edit', 'ALL', null, 'EXCEPTION_GRANT', 'Canonical BoD privileged edit grant', $3::uuid),
      ($2::uuid, 'report_analytics_view', 'ALL', null, 'EXCEPTION_GRANT', 'Canonical BoD reports analytics grant', $3::uuid),
      ($2::uuid, 'report_view', 'ALL', null, 'EXCEPTION_GRANT', 'Canonical BoD reports view grant', $3::uuid)`,
    [BOD_PRIV.app, BOD_REPORTS.app, OWNER.app],
  );
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [BOD_PRIV.app]);
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [BOD_REPORTS.app]);

  // -------------------------------------------------------------------------
  // SIMULATED DB-LEVEL DRIFT / STALE LEGACY FIXTURES (NOT canonical API states;
  // constructed via DB owner writes solely to verify fail-closed behavior)
  // -------------------------------------------------------------------------

  // Drift D1: EMPLOYEE_BASE (authz_managed=true) + stale legacy entry_privileged_edit + stale 'all' scope
  await db.query(
    `insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
     values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true, false)`,
    [DRIFT_D1_STALE_BOD_PRIV.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from, is_current, suspended_by_account_disable)
     values ($1::uuid, 'all', '2026-01-01', true, false)`,
    [DRIFT_D1_STALE_BOD_PRIV.app],
  );

  // Drift D2: EMPLOYEE_BASE (authz_managed=true) + stale legacy report_analytics_view + report_view + stale 'all'
  for (const cap of ["report_analytics_view", "report_view"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
       values ($1::uuid, $2, '2026-01-01', true, false)`,
      [DRIFT_D2_STALE_BOD_REPORTS.app, cap],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from, is_current, suspended_by_account_disable)
     values ($1::uuid, 'all', '2026-01-01', true, false)`,
    [DRIFT_D2_STALE_BOD_REPORTS.app],
  );

  // Drift D3: HR_OPERATOR (@ ALL) + non-ALL direct grant entry_privileged_edit @ CONTEXT_TEAM (TEAM_1) synced to legacy
  await assignGlobalRole(db, OWNER, DRIFT_D3_CROSS_SCOPE_PRIV, "HR_OPERATOR", "Seed HR_OPERATOR for Drift D3");
  await db.query(
    `insert into public.authz_direct_capability_grants
      (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values ($1::uuid, 'entry_privileged_edit', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Simulated non-ALL entry_privileged_edit drift', $3::uuid)`,
    [DRIFT_D3_CROSS_SCOPE_PRIV.app, TEAM_1, OWNER.app],
  );
  await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [
    DRIFT_D3_CROSS_SCOPE_PRIV.app,
  ]);

  // Seed active labor types for recruitment posts
  await db.query(
    `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
     values
       ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true),
       ('THOI_VU', 'Thời vụ', 'thoi_vu', 20, true)
     on conflict (labor_type_key) do update set active = true`,
  );

  // Seed 2 active industrial parks (already seeded by 20261109200000) & read their IDs
  const parks = (
    await db.query(
      "select industrial_park_id, province_id, industrial_park_code from public.industrial_parks where active = true order by industrial_park_code asc limit 2",
    )
  ).rows;
  assert.equal(parks.length, 2, "Expected at least 2 seeded active industrial parks");

  // Seed 2 offboarded workers: one in TEAM_1 (REC_T1), one in TEAM_2 (REC_T2)
  const workerT1 = await seedOffboardedWorker(db, {
    createdByUserId: OWNER.app,
    projectId: PRJ_1,
    recruiterId: REC_T1.recruiter,
    teamId: TEAM_1,
    employeeCode: "882001",
    workerName: "Công nhân Team 1",
    cccd: "001098111222",
    phone: "0901112223",
  });
  const workerT2 = await seedOffboardedWorker(db, {
    createdByUserId: OWNER.app,
    projectId: PRJ_2,
    recruiterId: REC_T2.recruiter,
    teamId: TEAM_2,
    employeeCode: "882002",
    workerName: "Công nhân Team 2",
    cccd: "001098333444",
    phone: "0903334445",
  });

  // Seed 1 PUBLISHED recruitment post and 1 WITHDRAWN recruitment post created by PM_ONE
  const pubPost = await serviceRpc(db, "recruitment_post_create", [
    PM_ONE.auth,
    PM_ONE.app,
    JSON.stringify({
      project_id: PRJ_1,
      industrial_park_id: parks[0].industrial_park_id,
      ...makeBriefContent({ general: { customer_name: "Khách hàng WP8B2 Published" } }),
    }),
    nextUuid(),
  ]);
  const toWithdraw = await serviceRpc(db, "recruitment_post_create", [
    PM_ONE.auth,
    PM_ONE.app,
    JSON.stringify({
      project_id: PRJ_1,
      industrial_park_id: parks[1].industrial_park_id,
      ...makeBriefContent({ general: { customer_name: "Khách hàng WP8B2 Withdrawn", labor_type_keys: ["THOI_VU"] } }),
    }),
    nextUuid(),
  ]);
  await serviceRpc(db, "recruitment_post_withdraw", [
    PM_ONE.auth,
    PM_ONE.app,
    toWithdraw.post.brief_id,
    toWithdraw.post.version,
    nextUuid(),
  ]);

  return {
    parks,
    workerT1,
    workerT2,
    publishedBriefId: pubPost.post.brief_id,
    publishedBriefVersion: pubPost.post.version,
    withdrawnBriefId: toWithdraw.post.brief_id,
  };
}

async function resolveViaRealRpc(db, authSubject) {
  const row = await serviceRpc(db, "direct_entry_resolve_actor_context", [authSubject]);
  const at = new Date().toISOString();
  const resolution = await resolveActor({
    session: { provider: "supabase", auth_subject: authSubject, authenticated_at: at },
    at,
    repository: {
      loadByAuthSubject: async (sub) => {
        assert.equal(sub, authSubject);
        return row;
      },
    },
  });
  return { rawContext: row, resolution };
}

// =============================================================================
// TEST 1: Migration #227 Hygiene, Atomic Rollback, ACL & Function Metadata
// =============================================================================
test("WP8B-2 [1/6]: Migration #227 hygiene, atomic rollback, exact 336 service_role RPCs, strict STABLE internal ACL & 19 recruitment_post* routines", async () => {
  const migrations = await loadMigrations();
  const idx8b1 = migrations.findIndex((m) => m.name === WP8B1_MIGRATION_NAME);
  const idx8b2 = migrations.findIndex((m) => m.name === WP8B2_MIGRATION_NAME);
  assert.ok(idx8b1 >= 0, `${WP8B1_MIGRATION_NAME} must exist`);
  assert.equal(idx8b2, idx8b1 + 1, `${WP8B2_MIGRATION_NAME} must sort immediately after #226 WP8B-1`);

  const wp8b2 = migrations[idx8b2];
  assert.equal(wp8b2.sql.includes("@"), false, "WP8B-2 migration must contain 0 '@' characters");
  assert.equal(/\bSAVEPOINT\b/i.test(wp8b2.sql), false, "WP8B-2 migration must contain 0 SAVEPOINT");
  assert.equal(
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(wp8b2.sql),
    false,
    "WP8B-2 must not use ALTER DEFAULT PRIVILEGES",
  );
  assert.match(wp8b2.sql, /^\s*(?:--[^\n]*\r?\n|\s)*begin\s*;/i, "WP8B-2 must open an outer transaction as first statement");
  assert.match(wp8b2.sql, /\bcommit\s*;\s*$/i, "WP8B-2 must end with commit;");
  assert.equal((wp8b2.sql.match(/^\s*begin\s*;/gim) ?? []).length, 1, "WP8B-2 must have exactly one outer begin;");
  assert.equal((wp8b2.sql.match(/^\s*commit\s*;/gim) ?? []).length, 1, "WP8B-2 must have exactly one outer commit;");

  const lfChecksum = migrationChecksum(wp8b2.sql);
  const crlfChecksum = migrationChecksum(wp8b2.sql.replace(/\n/g, "\r\n"));
  assert.equal(lfChecksum, crlfChecksum, "LF and CRLF checksums must match");
  assert.match(lfChecksum, /^[0-9a-f]{64}$/);

  const db = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);
  try {
    const internalFns = [
      "public.recruitment_location_is_admin_or_bod(uuid)",
      "public.recruitment_location_assert_admin_or_bod(uuid,uuid)",
      "public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)",
      "public.direct_entry_offboarding_authority(uuid,uuid)",
    ];
    const updatedFns = [
      "public.recruitment_location_is_admin_or_bod(uuid)",
      "public.recruitment_location_assert_admin_or_bod(uuid,uuid)",
      "public.direct_entry_offboarding_authority(uuid,uuid)",
    ];
    const beforeDefs = {};
    for (const sig of internalFns) {
      beforeDefs[sig] = (
        await db.query("select pg_get_functiondef($1::regprocedure) as src", [sig])
      ).rows[0].src;
    }

    const serviceCountBefore = (
      await db.query(
        `select count(*)::int as cnt
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(serviceCountBefore, 336, "Baseline #226 must have exact 336 service_role RPCs");

    // Atomic rollback proof: inject division-by-zero before commit
    const bodyWithoutTx = stripOuterTransaction(wp8b2.sql);
    await assert.rejects(
      () => db.exec(`begin;\n${bodyWithoutTx}\nselect 1 / 0;\ncommit;`),
      (err) => err.code === "22012",
    );
    await db.exec("rollback;");
    for (const sig of internalFns) {
      const afterRollback = (
        await db.query("select pg_get_functiondef($1::regprocedure) as src", [sig])
      ).rows[0].src;
      assert.equal(afterRollback, beforeDefs[sig], `Rollback must leave ${sig} untouched`);
    }

    // Apply #227 cleanly
    await db.exec(wp8b2.sql);

    const serviceCountAfter = (
      await db.query(
        `select count(*)::int as cnt
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      )
    ).rows[0].cnt;
    assert.equal(serviceCountAfter, 336, "WP8B-2 must preserve exact 336 service_role RPCs (0 new public RPCs)");

    for (const sig of internalFns) {
      const meta = (
        await db.query(
          `select p.prosecdef,
                  p.provolatile,
                  p.proconfig,
                  has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
                  has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
                  pg_get_functiondef(p.oid) as src
             from pg_proc p
            where p.oid = $1::regprocedure`,
          [sig],
        )
      ).rows[0];
      assert.equal(meta.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.equal(meta.provolatile, "s", `${sig} must remain STABLE (zero locks)`);
      assert.ok(
        Array.isArray(meta.proconfig) && meta.proconfig.includes("search_path=pg_catalog, public"),
        `${sig} must lock search_path=pg_catalog, public`,
      );
      assert.equal(meta.owner_exec, true, `${sig} owner EXECUTE must remain intact`);
      assert.equal(meta.public_exec, false, `${sig} PUBLIC EXECUTE must be revoked`);
      assert.equal(meta.anon_exec, false, `${sig} anon EXECUTE must be revoked`);
      assert.equal(meta.auth_exec, false, `${sig} authenticated EXECUTE must be revoked`);
      assert.equal(meta.service_exec, false, `${sig} service_role EXECUTE must be revoked`);
      if (updatedFns.includes(sig)) {
        assert.match(
          meta.src,
          /direct_entry_authz__internal_has_paired_capability/,
          `${sig} must use WP5 paired helper`,
        );
      }
    }

    // Preserve exact 19 recruitment_post* routines and 0 '@' invariant (recruitment-posts-db.test.mjs:516-535)
    const rpFns = (
      await db.query(
        `select p.proname, pg_get_functiondef(p.oid) as fn_def
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'recruitment_post%'`,
      )
    ).rows;
    assert.equal(rpFns.length, 19, "Must preserve exact 19 recruitment_post* routines");
    for (const r of rpFns) {
      assert.equal(r.fn_def.includes("@"), false, `${r.proname} must contain 0 '@'`);
    }
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 2: Explicit BEFORE (#226) vs AFTER (#227) Behavioral Diff Proof
// =============================================================================
test("WP8B-2 [2/6]: BEFORE (#226) vs AFTER (#227) diff on canonical dual-role HR_OPERATOR+TL escalation & simulated drift fixtures", async () => {
  const migrations = await loadMigrations();
  const dbBefore = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);
  const dbAfter = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);

  try {
    const beforeWorld = await seedPostCutoverWorld(dbBefore);
    const afterWorld = await seedPostCutoverWorld(dbAfter);

    // -------------------------------------------------------------------------
    // A. REAL CANONICAL DUAL-ROLE BUG FIX: HR_OPERATOR (@ ALL) + TEAM_LEADER (@ CONTEXT_TEAM)
    //    Created 100% through canonical WP5 role + TL RPCs (NOT synthetic DB tampering!).
    // -------------------------------------------------------------------------
    // BEFORE (#226): falsely escalated to Location Catalog & Recruitment Posts Admin/BoD!
    assert.equal(
      (await dbBefore.query("select public.recruitment_location_is_admin_or_bod($1::uuid) as ok", [HR_TL_DUAL.app]))
        .rows[0].ok,
      true,
      "BEFORE #226: canonical dual-role HR_OPERATOR+TL falsely escalated on recruitment_location_is_admin_or_bod",
    );
    assert.ok(
      await serviceRpc(dbBefore, "administrative_province_list_admin", [HR_TL_DUAL.auth, HR_TL_DUAL.app, null, false, 1, 10]),
      "BEFORE #226: dual-role HR_OPERATOR+TL falsely accessed province list",
    );
    const beforePostGet = await serviceRpc(dbBefore, "recruitment_post_get", [
      HR_TL_DUAL.auth,
      HR_TL_DUAL.app,
      beforeWorld.publishedBriefId,
    ]);
    assert.equal(
      beforePostGet.post.allowed_actions.can_edit,
      true,
      "BEFORE #226: dual-role HR_OPERATOR+TL falsely gained can_edit on another PM's post",
    );
    const beforeWithdrawn = await serviceRpc(dbBefore, "recruitment_post_get", [
      HR_TL_DUAL.auth,
      HR_TL_DUAL.app,
      beforeWorld.withdrawnBriefId,
    ]);
    assert.equal(
      beforeWithdrawn.post.status,
      "WITHDRAWN",
      "BEFORE #226: dual-role HR_OPERATOR+TL falsely read WITHDRAWN post",
    );

    // AFTER (#227): strictly DENIED on Location Catalog & Recruitment Posts override;
    // preserves own-team Offboarding authority without escalation!
    assert.equal(
      (await dbAfter.query("select public.recruitment_location_is_admin_or_bod($1::uuid) as ok", [HR_TL_DUAL.app]))
        .rows[0].ok,
      false,
      "AFTER #227: dual-role HR_OPERATOR+TL must NOT escalate on recruitment_location_is_admin_or_bod",
    );
    assert.equal(
      (
        await dbAfter.query(
          "select public.recruitment_post__internal_actor_is_full_admin_or_bod($1::uuid) as ok",
          [HR_TL_DUAL.app],
        )
      ).rows[0].ok,
      false,
      "AFTER #227: dual-role HR_OPERATOR+TL must NOT escalate on recruitment_post__internal_actor_is_full_admin_or_bod",
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_list_admin",
      [HR_TL_DUAL.auth, HR_TL_DUAL.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_create_admin",
      [HR_TL_DUAL.auth, HR_TL_DUAL.app, 0, "WP8B2_DENY_DUAL", "Tinh Dual Denied", "Test", nextUuid()],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    const afterPostGet = await serviceRpc(dbAfter, "recruitment_post_get", [
      HR_TL_DUAL.auth,
      HR_TL_DUAL.app,
      afterWorld.publishedBriefId,
    ]);
    assert.equal(afterPostGet.post.allowed_actions.can_edit, false);
    assert.equal(afterPostGet.post.allowed_actions.can_withdraw, false);
    await expectServiceRpcError(
      dbAfter,
      "recruitment_post_get",
      [HR_TL_DUAL.auth, HR_TL_DUAL.app, afterWorld.withdrawnBriefId],
      "P0002",
      /RECRUITMENT_POST_NOT_FOUND/,
    );
    await expectServiceRpcError(
      dbAfter,
      "recruitment_post_withdraw",
      [HR_TL_DUAL.auth, HR_TL_DUAL.app, afterWorld.publishedBriefId, afterWorld.publishedBriefVersion, nextUuid()],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );
    const dualOffboarding = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      HR_TL_DUAL.auth,
      HR_TL_DUAL.app,
      1,
      25,
    ]);
    assert.equal(dualOffboarding.authority, "team_leader");
    assert.equal(dualOffboarding.scope, "team");
    assert.equal(dualOffboarding.can_export, false);
    assert.equal(dualOffboarding.can_hide, false);
    assert.equal(dualOffboarding.items.length, 1);
    assert.equal(dualOffboarding.items[0].employee_code, afterWorld.workerT2.employeeCode);

    // -------------------------------------------------------------------------
    // B. SIMULATED DB-LEVEL DRIFT / STALE LEGACY FIXTURES (D1, D2, D3)
    // -------------------------------------------------------------------------
    // D1: authz_managed=true EMPLOYEE_BASE + stale legacy entry_privileged_edit + stale 'all'
    assert.ok(
      await serviceRpc(dbBefore, "administrative_province_list_admin", [
        DRIFT_D1_STALE_BOD_PRIV.auth,
        DRIFT_D1_STALE_BOD_PRIV.app,
        null,
        false,
        1,
        10,
      ]),
      "BEFORE #226: Drift D1 falsely passed Location Catalog",
    );
    assert.equal(
      (
        await serviceRpc(dbBefore, "direct_entry_offboarding_report", [
          DRIFT_D1_STALE_BOD_PRIV.auth,
          DRIFT_D1_STALE_BOD_PRIV.app,
          1,
          25,
        ])
      ).authority,
      "bod",
      "BEFORE #226: Drift D1 falsely passed Offboarding as bod",
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_list_admin",
      [DRIFT_D1_STALE_BOD_PRIV.auth, DRIFT_D1_STALE_BOD_PRIV.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "recruitment_post_withdraw",
      [
        DRIFT_D1_STALE_BOD_PRIV.auth,
        DRIFT_D1_STALE_BOD_PRIV.app,
        afterWorld.publishedBriefId,
        afterWorld.publishedBriefVersion,
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [DRIFT_D1_STALE_BOD_PRIV.auth, DRIFT_D1_STALE_BOD_PRIV.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report_export",
      [DRIFT_D1_STALE_BOD_PRIV.auth, DRIFT_D1_STALE_BOD_PRIV.app],
      "42501",
      /offboarding report denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_hide_snapshot",
      [
        DRIFT_D1_STALE_BOD_PRIV.auth,
        DRIFT_D1_STALE_BOD_PRIV.app,
        afterWorld.workerT1.entryId,
        afterWorld.workerT1.offEventId,
        "Attempt hide from stale legacy",
        nextUuid(),
      ],
      "42501",
      /offboarding report denied/,
    );

    // D2: authz_managed=true EMPLOYEE_BASE + stale legacy report_analytics_view + report_view + stale 'all'
    assert.ok(
      await serviceRpc(dbBefore, "administrative_province_list_admin", [
        DRIFT_D2_STALE_BOD_REPORTS.auth,
        DRIFT_D2_STALE_BOD_REPORTS.app,
        null,
        false,
        1,
        10,
      ]),
      "BEFORE #226: Drift D2 falsely passed Location Catalog",
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_list_admin",
      [DRIFT_D2_STALE_BOD_REPORTS.auth, DRIFT_D2_STALE_BOD_REPORTS.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "recruitment_post_withdraw",
      [
        DRIFT_D2_STALE_BOD_REPORTS.auth,
        DRIFT_D2_STALE_BOD_REPORTS.app,
        afterWorld.publishedBriefId,
        afterWorld.publishedBriefVersion,
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );

    // D3: HR_OPERATOR (@ ALL) + cross-scope direct grant entry_privileged_edit @ CONTEXT_TEAM
    assert.ok(
      await serviceRpc(dbBefore, "administrative_province_list_admin", [
        DRIFT_D3_CROSS_SCOPE_PRIV.auth,
        DRIFT_D3_CROSS_SCOPE_PRIV.app,
        null,
        false,
        1,
        10,
      ]),
      "BEFORE #226: Drift D3 cross-scope falsely passed Location Catalog",
    );
    assert.equal(
      (
        await serviceRpc(dbBefore, "direct_entry_offboarding_report", [
          DRIFT_D3_CROSS_SCOPE_PRIV.auth,
          DRIFT_D3_CROSS_SCOPE_PRIV.app,
          1,
          25,
        ])
      ).authority,
      "bod",
      "BEFORE #226: Drift D3 cross-scope falsely passed Offboarding as bod",
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_list_admin",
      [DRIFT_D3_CROSS_SCOPE_PRIV.auth, DRIFT_D3_CROSS_SCOPE_PRIV.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "recruitment_post_withdraw",
      [
        DRIFT_D3_CROSS_SCOPE_PRIV.auth,
        DRIFT_D3_CROSS_SCOPE_PRIV.app,
        afterWorld.publishedBriefId,
        afterWorld.publishedBriefVersion,
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [DRIFT_D3_CROSS_SCOPE_PRIV.auth, DRIFT_D3_CROSS_SCOPE_PRIV.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
  } finally {
    await dbBefore.close();
    await dbAfter.close();
  }
});

// =============================================================================
// TEST 3: Full Post-Cutover 3-Domain Authority Matrix, C4, Feed, Facets & Offboarding
// =============================================================================
test("WP8B-2 [3/6]: Post-cutover 3-domain matrix, Location Catalog audit caps, C4 PM-only create, /feeds/jobs.v1.json, include_facets pagination & Offboarding team isolation", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);

  try {
    const world = await seedPostCutoverWorld(db);

    // -------------------------------------------------------------------------
    // 3A. Location Catalog: exact audit capabilities & deny matrix + Owner protection
    // -------------------------------------------------------------------------
    for (const [actor, code, display, expectedAuditCap] of [
      [OWNER, "WP8B2_PROV_ADM", "Tỉnh WP8B2 Admin", "entry_admin"],
      [BOD_PRIV, "WP8B2_PROV_BODP", "Tỉnh WP8B2 BoD Priv", "entry_privileged_edit"],
      [BOD_REPORTS, "WP8B2_PROV_BODR", "Tỉnh WP8B2 BoD Reports", "report_analytics_view"],
    ]) {
      const created = await serviceRpc(db, "administrative_province_create_admin", [
        actor.auth,
        actor.app,
        0,
        code,
        display,
        "Verify paired audit capability",
        nextUuid(),
      ]);
      assert.equal(created.created, true);
      const auditRow = (
        await db.query(
          "select capability from public.direct_entry_audit_events where app_user_id = $1::uuid and resource_ref = $2 order by created_at desc limit 1",
          [actor.app, created.province_id],
        )
      ).rows[0];
      assert.equal(auditRow.capability, expectedAuditCap, `Expected truthful audit capability ${expectedAuditCap}`);
    }

    for (const denied of [HR_OP, TL_USER, HR_TL_DUAL, PM_ONE, PA_USER, REC_T1, BASE_USER]) {
      await expectServiceRpcError(
        db,
        "administrative_province_list_admin",
        [denied.auth, denied.app, null, false, 1, 10],
        "42501",
        /location catalog admin or bod authority denied/,
      );
      await expectServiceRpcError(
        db,
        "industrial_park_list_admin",
        [denied.auth, denied.app, null, null, false, 1, 10],
        "42501",
        /location catalog admin or bod authority denied/,
      );
    }
    await expectServiceRpcError(
      db,
      "administrative_province_list_admin",
      [DISABLED_ADMIN.auth, DISABLED_ADMIN.app, null, false, 1, 10],
      "42501",
      /actor mapping denied/,
    );
    await expectServiceRpcError(
      db,
      "administrative_province_list_admin",
      [OWNER.auth, LIENVU.app, null, false, 1, 10],
      "42501",
      /actor mapping denied/,
    );

    // Owner is_protected = true remains intact
    const ownerAssignmentId = (
      await db.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null and is_protected = true",
        [OWNER.app],
      )
    ).rows[0]?.assignment_id;
    assert.ok(ownerAssignmentId, "Owner ADMIN assignment must remain is_protected = true");
    await expectServiceRpcError(
      db,
      "direct_entry_authz_revoke_global_role_admin",
      [
        LIENVU.auth,
        LIENVU.app,
        OWNER.app,
        ownerAssignmentId,
        (await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [OWNER.app])).rows[0].version,
        "Attempt revoke protected owner",
        nextUuid(),
        sha256("revoke-protected-owner"),
      ],
      "PT409",
      /AUTHZ_PROTECTED_ASSIGNMENT/,
    );

    // -------------------------------------------------------------------------
    // 3B. Recruitment Posts: C4 PM-only create, Admin/BoD override, Public Feed & Facets/Pagination
    // -------------------------------------------------------------------------
    // C4 invariant: ADMIN (OWNER, LUANPT, LIENVU, NGATTT) and BoD without PM assignment CANNOT create!
    for (const nonPm of [OWNER, LUANPT, BOD_PRIV, BOD_REPORTS, HR_OP, TL_USER, HR_TL_DUAL, PA_USER, BASE_USER]) {
      const ctx = await serviceRpc(db, "recruitment_post_get_context", [nonPm.auth, nonPm.app]);
      assert.equal(ctx.can_create, false, `C4: ${nonPm.name} without PM assignment must have can_create=false`);
      assert.deepEqual(ctx.managed_projects, []);
      await expectServiceRpcError(
        db,
        "recruitment_post_create",
        [
          nonPm.auth,
          nonPm.app,
          JSON.stringify({
            project_id: PRJ_1,
            industrial_park_id: world.parks[0].industrial_park_id,
            ...makeBriefContent(),
          }),
          nextUuid(),
        ],
        "42501",
        /RECRUITMENT_POST_ACCESS_DENIED/,
      );
    }

    // Active assigned PM (PM_ONE) CAN create on PRJ_1, CANNOT create on unassigned PRJ_2
    const pmCtx = await serviceRpc(db, "recruitment_post_get_context", [PM_ONE.auth, PM_ONE.app]);
    assert.equal(pmCtx.can_create, true);
    assert.equal(pmCtx.managed_projects.length, 1);
    assert.equal(pmCtx.managed_projects[0].project_id, PRJ_1);

    await expectServiceRpcError(
      db,
      "recruitment_post_create",
      [
        PM_ONE.auth,
        PM_ONE.app,
        JSON.stringify({
          project_id: PRJ_2,
          industrial_park_id: world.parks[0].industrial_park_id,
          ...makeBriefContent(),
        }),
        nextUuid(),
      ],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );

    // Create 2 more PUBLISHED posts for pagination & facets testing (total 3 PUBLISHED + 1 WITHDRAWN)
    const post2 = await serviceRpc(db, "recruitment_post_create", [
      PM_ONE.auth,
      PM_ONE.app,
      JSON.stringify({
        project_id: PRJ_1,
        industrial_park_id: world.parks[0].industrial_park_id,
        ...makeBriefContent({ general: { customer_name: "Khách hàng WP8B2 Post 2", labor_type_keys: ["CHINH_THUC", "THOI_VU"] } }),
      }),
      nextUuid(),
    ]);
    const post3 = await serviceRpc(db, "recruitment_post_create", [
      PM_ONE.auth,
      PM_ONE.app,
      JSON.stringify({
        project_id: PRJ_1,
        industrial_park_id: world.parks[1].industrial_park_id,
        ...makeBriefContent({ general: { customer_name: "Khách hàng WP8B2 Post 3", labor_type_keys: ["THOI_VU"] } }),
      }),
      nextUuid(),
    ]);

    // Another PM on same project (PM_TWO) cannot edit PM_ONE's post
    const pmTwoView = await serviceRpc(db, "recruitment_post_get", [PM_TWO.auth, PM_TWO.app, post2.post.brief_id]);
    assert.equal(pmTwoView.post.allowed_actions.can_edit, false);
    await expectServiceRpcError(
      db,
      "recruitment_post_withdraw",
      [PM_TWO.auth, PM_TWO.app, post2.post.brief_id, post2.post.version, nextUuid()],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );

    // Canonical ADMIN, BoD privileged, and BoD reports CAN override edit/withdraw & view WITHDRAWN
    for (const overrideActor of [OWNER, BOD_PRIV, BOD_REPORTS]) {
      const viewPub = await serviceRpc(db, "recruitment_post_get", [
        overrideActor.auth,
        overrideActor.app,
        post2.post.brief_id,
      ]);
      assert.equal(viewPub.post.allowed_actions.can_edit, true, `${overrideActor.name} must have can_edit=true`);
      assert.equal(viewPub.post.allowed_actions.can_withdraw, true, `${overrideActor.name} must have can_withdraw=true`);
      const viewWithdrawn = await serviceRpc(db, "recruitment_post_get", [
        overrideActor.auth,
        overrideActor.app,
        world.withdrawnBriefId,
      ]);
      assert.equal(viewWithdrawn.post.status, "WITHDRAWN");
    }

    // BoD privileged updates post3 cleanly (proving paired override write path!)
    const updatedPost3 = await serviceRpc(db, "recruitment_post_update", [
      BOD_PRIV.auth,
      BOD_PRIV.app,
      post3.post.brief_id,
      post3.post.version,
      JSON.stringify(
        makeBriefContent({
          general: {
            customer_name: "Khách hàng WP8B2 Post 3 Updated by BoD",
            labor_type_keys: ["THOI_VU"],
          },
        }),
      ),
      nextUuid(),
    ]);
    assert.equal(updatedPost3.post.version, post3.post.version + 1);

    // Public feed /feeds/jobs.v1.json contract check: 3 PUBLISHED, 0 WITHDRAWN, strict allowlist
    const rawPublicFeed = await serviceRpc(db, "recruitment_post_public_feed_v1", []);
    const projectedPublicFeed = projectRecruitmentPostPublicFeedV1(rawPublicFeed);
    assert.ok(projectedPublicFeed, "Public feed v1 must pass strict fail-closed allowlist projection");
    assert.equal(projectedPublicFeed.jobs.length, 3, "Public feed must include only the 3 PUBLISHED posts");

    // Mobile API include_facets=true + exact counts + filter + snapshot/cursor pagination (page_size=2)
    const rawFacetPage1 = await serviceRpc(db, "recruitment_post_list_with_facets", [
      BASE_USER.auth,
      BASE_USER.app,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      2,
    ]);
    const facetPage1 = projectRecruitmentPostListWithFacets(rawFacetPage1);
    assert.ok(facetPage1, "recruitment_post_list_with_facets page 1 must pass strict contract projection");
    assert.equal(facetPage1.total_count, 3);
    assert.equal(facetPage1.items.length, 2);
    assert.equal(facetPage1.has_more, true);
    assert.ok(facetPage1.next_cursor);
    assert.equal(facetPage1.industrial_parks.reduce((acc, p) => acc + p.job_count, 0), 3);
    assert.ok(facetPage1.labor_types.length >= 2);
    for (const item of facetPage1.items) {
      assert.equal(item.allowed_actions.can_edit, false);
      assert.equal(item.allowed_actions.can_withdraw, false);
    }

    const rawFacetPage2 = await serviceRpc(db, "recruitment_post_list_with_facets", [
      BASE_USER.auth,
      BASE_USER.app,
      null,
      null,
      null,
      null,
      null,
      null,
      facetPage1.next_cursor,
      facetPage1.snapshot_token,
      2,
    ]);
    const facetPage2 = projectRecruitmentPostListWithFacets(rawFacetPage2);
    assert.ok(facetPage2);
    assert.equal(facetPage2.items.length, 1);
    assert.equal(facetPage2.has_more, false);
    const seenIds = new Set([...facetPage1.items, ...facetPage2.items].map((i) => i.brief_id));
    assert.equal(seenIds.size, 3, "Cursor+snapshot pagination must return all 3 unique posts without overlap");

    // Filtered list (park 0 -> 2 posts) + legacy 5-key list contract check
    const rawFiltered = await serviceRpc(db, "recruitment_post_list", [
      OWNER.auth,
      OWNER.app,
      null,
      null,
      world.parks[0].industrial_park_id,
      null,
      null,
      null,
      null,
      null,
      10,
    ]);
    const filteredList = projectRecruitmentPostList(rawFiltered);
    assert.ok(filteredList);
    assert.equal(filteredList.items.length, 2);
    for (const item of filteredList.items) {
      assert.equal(item.allowed_actions.can_edit, true);
      assert.equal(item.allowed_actions.can_withdraw, true);
    }

    // -------------------------------------------------------------------------
    // 3C. Offboarding: Read, Export, Hide, Team Isolation & Policy Preservation
    // -------------------------------------------------------------------------
    const adminOff = await serviceRpc(db, "direct_entry_offboarding_report", [OWNER.auth, OWNER.app, 1, 25]);
    assert.ok(parseOffboardingReportList(adminOff), "Admin offboarding payload must satisfy strict contract");
    assert.equal(adminOff.authority, "admin");
    assert.equal(adminOff.scope, "all");
    assert.equal(adminOff.can_export, true);
    assert.equal(adminOff.can_hide, true);
    assert.equal(adminOff.items.length, 2);
    assert.ok(adminOff.items.every((r) => typeof r.phone === "string" && r.phone.length > 0));

    const bodPrivOff = await serviceRpc(db, "direct_entry_offboarding_report", [BOD_PRIV.auth, BOD_PRIV.app, 1, 25]);
    assert.equal(bodPrivOff.authority, "bod");
    assert.equal(bodPrivOff.scope, "all");
    assert.equal(bodPrivOff.can_export, true);
    assert.equal(bodPrivOff.can_hide, true);
    assert.equal(bodPrivOff.items.length, 2);

    // Export succeeds for ADMIN & BoD privileged
    const adminExport = await serviceRpc(db, "direct_entry_offboarding_report_export", [OWNER.auth, OWNER.app]);
    assert.equal(adminExport.items.length, 2);
    const bodExport = await serviceRpc(db, "direct_entry_offboarding_report_export", [BOD_PRIV.auth, BOD_PRIV.app]);
    assert.equal(bodExport.items.length, 2);

    // BoD executive reports ONLY (no entry_privileged_edit) stays DENIED on Offboarding (policy preserved!)
    for (const fn of ["direct_entry_offboarding_report", "direct_entry_offboarding_report_export"]) {
      const args = fn === "direct_entry_offboarding_report"
        ? [BOD_REPORTS.auth, BOD_REPORTS.app, 1, 25]
        : [BOD_REPORTS.auth, BOD_REPORTS.app];
      await expectServiceRpcError(db, fn, args, "42501", /offboarding report denied/);
    }
    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_hide_snapshot",
      [BOD_REPORTS.auth, BOD_REPORTS.app, world.workerT1.entryId, world.workerT1.offEventId, "Denied BoD reports", nextUuid()],
      "42501",
      /offboarding report denied/,
    );

    // Team Leader (TEAM_1) sees ONLY TEAM_1 worker, no phone, export & hide denied
    const tlOff = await serviceRpc(db, "direct_entry_offboarding_report", [TL_USER.auth, TL_USER.app, 1, 25]);
    assert.ok(parseOffboardingReportList(tlOff));
    assert.equal(tlOff.authority, "team_leader");
    assert.equal(tlOff.scope, "team");
    assert.equal(tlOff.can_export, false);
    assert.equal(tlOff.can_hide, false);
    assert.equal(tlOff.items.length, 1);
    assert.equal(tlOff.items[0].employee_code, world.workerT1.employeeCode);
    assert.equal("phone" in tlOff.items[0], false);
    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_report_export",
      [TL_USER.auth, TL_USER.app],
      "42501",
      /offboarding report export denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_hide_snapshot",
      [TL_USER.auth, TL_USER.app, world.workerT1.entryId, world.workerT1.offEventId, "TL cannot hide", nextUuid()],
      "42501",
      /WORKFORCE_OFFBOARDING_HIDE_DENIED/,
    );

    // Non-authorized roles denied on Offboarding
    for (const denied of [HR_OP, PM_ONE, PA_USER, REC_T1, BASE_USER]) {
      await expectServiceRpcError(
        db,
        "direct_entry_offboarding_report",
        [denied.auth, denied.app, 1, 25],
        "42501",
        /offboarding report denied/,
      );
    }
    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_report",
      [DISABLED_ADMIN.auth, DISABLED_ADMIN.app, 1, 25],
      "42501",
      /actor mapping denied/,
    );

    // BoD privileged hides workerT1 snapshot; historical direct_entries & status events remain untouched!
    const preEntryCount = (await db.query("select count(*)::int as cnt from public.direct_entries")).rows[0].cnt;
    const preEventCount = (
      await db.query("select count(*)::int as cnt from public.direct_entry_employment_status_events")
    ).rows[0].cnt;
    const hideRes = await serviceRpc(db, "direct_entry_offboarding_hide_snapshot", [
      BOD_PRIV.auth,
      BOD_PRIV.app,
      world.workerT1.entryId,
      world.workerT1.offEventId,
      "Đã liên hệ xác nhận nghỉ việc",
      nextUuid(),
    ]);
    assert.equal(hideRes.replayed, false);
    assert.equal(
      (await db.query("select count(*)::int as cnt from public.direct_entries")).rows[0].cnt,
      preEntryCount,
      "Hide snapshot must never mutate historical direct_entries",
    );
    assert.equal(
      (await db.query("select count(*)::int as cnt from public.direct_entry_employment_status_events")).rows[0].cnt,
      preEventCount,
      "Hide snapshot must never mutate historical status events",
    );
    const adminOffAfterHide = await serviceRpc(db, "direct_entry_offboarding_report", [OWNER.auth, OWNER.app, 1, 25]);
    assert.equal(adminOffAfterHide.items.length, 1);
    assert.equal(adminOffAfterHide.items[0].employee_code, world.workerT2.employeeCode);
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 4: End-to-End SQL -> direct_entry_resolve_actor_context -> resolveActor -> TS Guards
//         (Pre-cutover R1, Pre-cutover Normal, Post-cutover Canonical, Dual-Role & Drift)
// =============================================================================
test("WP8B-2 [4/6]: End-to-end SQL -> direct_entry_resolve_actor_context -> resolveActor -> real TS nav/page/API guards", async () => {
  const migrations = await loadMigrations();

  // Helper calling the real Location Catalog HTTP API with a real resolved actor
  async function checkLocationApiGuard(resolution) {
    let rpcCalls = 0;
    const res = await listProvincesCatalog(
      new Request("https://app.test/api/admin/catalog/provinces"),
      "true",
      {
        resolveSession: async () => ({ actor: resolution }),
        repository: {
          async listProvinces() {
            rpcCalls += 1;
            return {
              ok: true,
              data: {
                authorization_date: "2026-11-20",
                include_inactive: false,
                search: null,
                page: 1,
                page_size: 25,
                total: 0,
                provinces: [],
              },
            };
          },
        },
      },
    );
    return { status: res.status, rpcCalls };
  }

  // -------------------------------------------------------------------------
  // Part A: Pre-cutover (authz_managed = false) R1 + Normal + Active Team Leader
  // -------------------------------------------------------------------------
  const preDb = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);
  try {
    const PRE_R1_ADMIN = { auth: "18b40000-0000-4000-8000-000000000001", app: "28b40000-0000-4000-8000-000000000001", email: "pre.r1.adm@hrpartner.vn", name: "Pre R1 Admin" };
    const PRE_R1_BOD_PRIV = { auth: "18b40000-0000-4000-8000-000000000002", app: "28b40000-0000-4000-8000-000000000002", email: "pre.r1.bodp@hrpartner.vn", name: "Pre R1 BoD Priv" };
    const PRE_R1_BOD_REP = { auth: "18b40000-0000-4000-8000-000000000003", app: "28b40000-0000-4000-8000-000000000003", email: "pre.r1.bodr@hrpartner.vn", name: "Pre R1 BoD Rep" };
    const PRE_TL = { auth: "18b40000-0000-4000-8000-000000000004", app: "28b40000-0000-4000-8000-000000000004", recruiter: "38b40000-0000-4000-8000-000000000004", email: "pre.tl@hrpartner.vn", name: "Pre TL" };

    for (const u of [PRE_R1_ADMIN, PRE_R1_BOD_PRIV, PRE_R1_BOD_REP, PRE_TL]) {
      await seedAccount(preDb, u);
    }
    await preDb.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'PRE_WP8B2_T1', 'Pre Team', true)",
      [TEAM_1],
    );

    // Pre-cutover R1 (valid_to='2021-01-01', is_current=true)
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await preDb.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, $2, '2020-01-01', '2021-01-01', true)",
        [PRE_R1_ADMIN.app, cap],
      );
    }
    await preDb.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current) values ($1::uuid, 'all', '2020-01-01', '2021-01-01', true)",
      [PRE_R1_ADMIN.app],
    );

    await preDb.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, 'entry_privileged_edit', '2020-01-01', '2021-01-01', true)",
      [PRE_R1_BOD_PRIV.app],
    );
    await preDb.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current) values ($1::uuid, 'all', '2020-01-01', '2021-01-01', true)",
      [PRE_R1_BOD_PRIV.app],
    );

    for (const cap of ["report_analytics_view", "report_view"]) {
      await preDb.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current) values ($1::uuid, $2, '2020-01-01', '2021-01-01', true)",
        [PRE_R1_BOD_REP.app, cap],
      );
    }
    await preDb.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current) values ($1::uuid, 'all', '2020-01-01', '2021-01-01', true)",
      [PRE_R1_BOD_REP.app],
    );

    // Pre-cutover active Team Leader
    await seedRecruiterAndTeam(preDb, PRE_TL, TEAM_1);
    await preDb.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'team_manager_assign', '2026-01-01', true)",
      [PRE_TL.app],
    );
    await preDb.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
      [PRE_TL.app, TEAM_1],
    );
    await preDb.query(
      "insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)",
      [TEAM_1, PRE_TL.app, PRE_TL.recruiter],
    );

    // Verify exact 12 keys of direct_entry_resolve_actor_context remain untouched
    const { rawContext } = await resolveViaRealRpc(preDb, PRE_R1_ADMIN.auth);
    assert.deepEqual(Object.keys(rawContext).sort(), [
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

    for (const [label, user, expectLoc, expectOff] of [
      ["Pre-cutover R1 Admin", PRE_R1_ADMIN, true, true],
      ["Pre-cutover R1 BoD Priv", PRE_R1_BOD_PRIV, true, true],
      ["Pre-cutover R1 BoD Reports", PRE_R1_BOD_REP, true, false],
      ["Pre-cutover Team Leader", PRE_TL, false, true],
    ]) {
      const { resolution } = await resolveViaRealRpc(preDb, user.auth);
      assert.equal(resolution.ok, true, `${label} must resolve ok`);
      assert.equal(recruitmentLocationCatalogNavPredicate(resolution.actor), expectLoc, `${label} loc nav`);
      assert.equal(
        decideRecruitmentLocationCatalogPageAccess({ actor: resolution }),
        expectLoc ? "ALLOW" : "ACCESS_DENIED",
        `${label} loc page`,
      );
      assert.equal(canManageRecruitmentLocations(resolution.actor), expectLoc, `${label} loc contract`);
      const apiRes = await checkLocationApiGuard(resolution);
      assert.equal(apiRes.status, expectLoc ? 200 : 403, `${label} loc API`);
      assert.equal(apiRes.rpcCalls, expectLoc ? 1 : 0);

      assert.equal(workforceOffboardingNavPredicate(resolution.actor), expectOff, `${label} off nav`);
      assert.equal(canViewOffboardingReport(resolution.actor), expectOff, `${label} off helper`);
      assert.equal(
        decideWorkforceOffboardingPageAccess({ actor: resolution }),
        expectOff ? "ALLOW" : "ACCESS_DENIED",
        `${label} off page`,
      );

      // Cross-check SQL authority directly!
      if (expectLoc) {
        assert.ok(await serviceRpc(preDb, "administrative_province_list_admin", [user.auth, user.app, null, false, 1, 10]));
      } else {
        await expectServiceRpcError(preDb, "administrative_province_list_admin", [user.auth, user.app, null, false, 1, 10], "42501");
      }
      if (expectOff) {
        assert.ok(await serviceRpc(preDb, "direct_entry_offboarding_report", [user.auth, user.app, 1, 25]));
      } else {
        await expectServiceRpcError(preDb, "direct_entry_offboarding_report", [user.auth, user.app, 1, 25], "42501");
      }
    }
  } finally {
    await preDb.close();
  }

  // -------------------------------------------------------------------------
  // Part B: Post-cutover (authz_managed = true) — Canonical + Dual-Role + Drift
  // -------------------------------------------------------------------------
  const postDb = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);
  try {
    await seedPostCutoverWorld(postDb);

    const matrix = [
      ["Canonical OWNER (ADMIN)", OWNER, true, true],
      ["Canonical BoD Privileged", BOD_PRIV, true, true],
      ["Canonical BoD Reports Only", BOD_REPORTS, true, false],
      ["Canonical Team Leader", TL_USER, false, true],
      ["Canonical Dual-Role HR_OPERATOR+TL", HR_TL_DUAL, false, true],
      ["Canonical HR_OPERATOR Alone", HR_OP, false, false],
      ["Canonical PM", PM_ONE, false, false],
      ["Canonical PA", PA_USER, false, false],
      ["Canonical EMPLOYEE_BASE", BASE_USER, false, false],
      ["Drift D1 Stale BoD Priv", DRIFT_D1_STALE_BOD_PRIV, false, false],
      ["Drift D2 Stale BoD Reports", DRIFT_D2_STALE_BOD_REPORTS, false, false],
      ["Drift D3 Cross-Scope Priv", DRIFT_D3_CROSS_SCOPE_PRIV, false, false],
    ];

    for (const [label, user, expectLoc, expectOff] of matrix) {
      const { resolution } = await resolveViaRealRpc(postDb, user.auth);
      assert.equal(resolution.ok, true, `${label} must resolve ok`);
      assert.equal(recruitmentLocationCatalogNavPredicate(resolution.actor), expectLoc, `${label} loc nav`);
      assert.equal(
        decideRecruitmentLocationCatalogPageAccess({ actor: resolution }),
        expectLoc ? "ALLOW" : "ACCESS_DENIED",
        `${label} loc page`,
      );
      assert.equal(canManageRecruitmentLocations(resolution.actor), expectLoc, `${label} loc contract`);
      const apiRes = await checkLocationApiGuard(resolution);
      assert.equal(apiRes.status, expectLoc ? 200 : 403, `${label} loc API`);
      assert.equal(apiRes.rpcCalls, expectLoc ? 1 : 0);

      assert.equal(workforceOffboardingNavPredicate(resolution.actor), expectOff, `${label} off nav`);
      assert.equal(canViewOffboardingReport(resolution.actor), expectOff, `${label} off helper`);
      assert.equal(
        decideWorkforceOffboardingPageAccess({ actor: resolution }),
        expectOff ? "ALLOW" : "ACCESS_DENIED",
        `${label} off page`,
      );

      // SQL parity assertion
      if (expectLoc) {
        assert.ok(await serviceRpc(postDb, "administrative_province_list_admin", [user.auth, user.app, null, false, 1, 10]));
      } else {
        await expectServiceRpcError(postDb, "administrative_province_list_admin", [user.auth, user.app, null, false, 1, 10], "42501");
      }
      if (expectOff) {
        assert.ok(await serviceRpc(postDb, "direct_entry_offboarding_report", [user.auth, user.app, 1, 25]));
      } else {
        await expectServiceRpcError(postDb, "direct_entry_offboarding_report", [user.auth, user.app, 1, 25], "42501");
      }
    }

    // Disabled Admin fails closed through real resolveActor -> ACCOUNT_UNAVAILABLE & 403
    const { resolution: disabledRes } = await resolveViaRealRpc(postDb, DISABLED_ADMIN.auth);
    assert.equal(disabledRes.ok, false);
    assert.equal(disabledRes.reason, "ACTOR_DISABLED");
    assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: disabledRes }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: disabledRes }), "ACCOUNT_UNAVAILABLE");
    const disabledApi = await checkLocationApiGuard(disabledRes);
    assert.equal(disabledApi.status, 403);
    assert.equal(disabledApi.rpcCalls, 0);
  } finally {
    await postDb.close();
  }
});

// =============================================================================
// TEST 5: Revoke / Disable Lifecycle Transitions & Live TS Error Classifiers
// =============================================================================
test("WP8B-2 [5/6]: Revoke ADMIN / Revoke TL / Disable transitions immediately fail closed across SQL + TS & preserve error classifiers", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);

  try {
    const world = await seedPostCutoverWorld(db);

    // 1. TEMP_ADMIN initially allowed on all 3 domains
    assert.ok(await serviceRpc(db, "administrative_province_list_admin", [TEMP_ADMIN.auth, TEMP_ADMIN.app, null, false, 1, 10]));
    assert.equal(
      (await serviceRpc(db, "recruitment_post_get", [TEMP_ADMIN.auth, TEMP_ADMIN.app, world.publishedBriefId]))
        .post.allowed_actions.can_edit,
      true,
    );
    assert.equal(
      (await serviceRpc(db, "direct_entry_offboarding_report", [TEMP_ADMIN.auth, TEMP_ADMIN.app, 1, 25])).authority,
      "admin",
    );

    // Revoke TEMP_ADMIN's ADMIN role via canonical RPC
    const tempAssignId = (
      await db.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
        [TEMP_ADMIN.app],
      )
    ).rows[0].assignment_id;
    await revokeGlobalRole(db, OWNER, TEMP_ADMIN, tempAssignId, "Revoke TEMP_ADMIN to verify immediate deny");

    const locErr = await expectServiceRpcError(
      db,
      "administrative_province_list_admin",
      [TEMP_ADMIN.auth, TEMP_ADMIN.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    assert.equal(classifyLocationCatalogError(locErr), "denied");

    const rpErr = await expectServiceRpcError(
      db,
      "recruitment_post_withdraw",
      [TEMP_ADMIN.auth, TEMP_ADMIN.app, world.publishedBriefId, world.publishedBriefVersion, nextUuid()],
      "42501",
      /RECRUITMENT_POST_ACCESS_DENIED/,
    );
    assert.equal(classifyRecruitmentPostError(rpErr), "RECRUITMENT_POST_ACCESS_DENIED");

    const withdrawnErr = await expectServiceRpcError(
      db,
      "recruitment_post_get",
      [TEMP_ADMIN.auth, TEMP_ADMIN.app, world.withdrawnBriefId],
      "P0002",
      /RECRUITMENT_POST_NOT_FOUND/,
    );
    assert.equal(classifyRecruitmentPostError(withdrawnErr), "RECRUITMENT_POST_NOT_FOUND");

    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_report",
      [TEMP_ADMIN.auth, TEMP_ADMIN.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );

    const { resolution: revokedRes } = await resolveViaRealRpc(db, TEMP_ADMIN.auth);
    assert.equal(revokedRes.ok, true);
    assert.equal(canManageRecruitmentLocations(revokedRes.actor), false);
    assert.equal(canViewOffboardingReport(revokedRes.actor), false);

    // 2. Revoke TL_USER via canonical RPC -> immediate fail-closed on Offboarding SQL & TS
    const tlTeamVer = (await db.query("select version from public.teams where team_id = $1::uuid", [TEAM_1])).rows[0].version;
    await serviceRpc(db, "direct_entry_revoke_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      null,
      tlTeamVer,
      "Revoke TL_USER to verify immediate Offboarding deny",
      `wp8b2-revoke-tl-${nextUuid()}`,
    ]);
    await expectServiceRpcError(
      db,
      "direct_entry_offboarding_report",
      [TL_USER.auth, TL_USER.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
    const { resolution: revokedTlRes } = await resolveViaRealRpc(db, TL_USER.auth);
    assert.equal(revokedTlRes.ok, true);
    assert.equal(workforceOffboardingNavPredicate(revokedTlRes.actor), false);
    assert.equal(canViewOffboardingReport(revokedTlRes.actor), false);
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: revokedTlRes }), "ACCESS_DENIED");
  } finally {
    await db.close();
  }
});

// =============================================================================
// TEST 6: T0 R1/P2 (F-05) Regression — Managed TL Without Legacy Mirror Rows
//         Evaluates strictly from canonical WP5 contextual/effective access + HRP/team
//         structural invariants; blocks ambiguity, non-TL direct grants, revoke & disable
//         without modifying WP8C shared direct_entry_assert_team_leader_current_team.
// =============================================================================
test("WP8B-2 [6/6]: R1/P2 (F-05) managed TL with legacy mirror cleared keeps exact team Offboarding access & fails closed on ambiguity/non-TL/revoke/disable", async () => {
  const migrations = await loadMigrations();
  const dbBefore = await createDbUpTo(migrations, WP8B1_MIGRATION_NAME);
  const dbAfter = await createDbUpTo(migrations, WP8B2_MIGRATION_NAME);

  const TEAM_3 = "48b20000-0000-4000-8000-000000000003";
  const TEAM_4 = "48b20000-0000-4000-8000-000000000004";
  const TL_NO_LEGACY = {
    auth: "18b20000-0000-4000-8000-000000000031",
    app: "28b20000-0000-4000-8000-000000000031",
    recruiter: "38b20000-0000-4000-8000-000000000031",
    email: "tl.nolegacy.wp8b2@hrpartner.vn",
    name: "Managed TL NoLegacy T3",
  };
  const TL_NO_LEGACY_DISABLE = {
    auth: "18b20000-0000-4000-8000-000000000032",
    app: "28b20000-0000-4000-8000-000000000032",
    recruiter: "38b20000-0000-4000-8000-000000000032",
    email: "tl.nolegacy.dis.wp8b2@hrpartner.vn",
    name: "Managed TL NoLegacy Disable T4",
  };
  const REC_T3 = {
    auth: "18b20000-0000-4000-8000-000000000033",
    app: "28b20000-0000-4000-8000-000000000033",
    recruiter: "38b20000-0000-4000-8000-000000000033",
    email: "rec3.wp8b2@hrpartner.vn",
    name: "Recruiter Team Three WP8B2",
  };

  async function setupNoLegacyTlWorld(db) {
    const world = await seedPostCutoverWorld(db);
    await db.query(
      `insert into public.teams (team_id, code, display_name, active) values
        ($1::uuid, 'WP8B2_T3', 'Team WP8B2 Three', true),
        ($2::uuid, 'WP8B2_T4', 'Team WP8B2 Four', true)`,
      [TEAM_3, TEAM_4],
    );
    for (const u of [TL_NO_LEGACY, TL_NO_LEGACY_DISABLE, REC_T3]) {
      await seedAccount(db, u);
      await db.query(
        "update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid",
        [u.app],
      );
    }
    await seedRecruiterAndTeam(db, TL_NO_LEGACY, TEAM_3);
    await seedRecruiterAndTeam(db, TL_NO_LEGACY_DISABLE, TEAM_4);
    await seedRecruiterAndTeam(db, REC_T3, TEAM_3);

    // Designate both TLs through canonical RPC
    await serviceRpc(db, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_3,
      TL_NO_LEGACY.app,
      null,
      1,
      "Canonical TL on TEAM_3 before clearing legacy mirror",
      `wp8b2-f05-tl3-${nextUuid()}`,
    ]);
    await serviceRpc(db, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_4,
      TL_NO_LEGACY_DISABLE.app,
      null,
      1,
      "Canonical TL on TEAM_4 before clearing legacy mirror",
      `wp8b2-f05-tl4-${nextUuid()}`,
    ]);

    // Seed an offboarded worker in TEAM_3
    const workerT3 = await seedOffboardedWorker(db, {
      createdByUserId: OWNER.app,
      projectId: PRJ_1,
      recruiterId: REC_T3.recruiter,
      teamId: TEAM_3,
      employeeCode: "882003",
      workerName: "Công nhân Team 3 F05",
      cccd: "001098555666",
      phone: "0905556667",
    });

    // Clear ONLY legacy capability/scope mirror rows for both managed TLs
    // (canonical direct_entry_team_leader_assignments & WP5 grants stay completely intact!)
    await db.query("select set_config('direct_entry.team_leader_marker', 'on', false)");
    for (const tl of [TL_NO_LEGACY, TL_NO_LEGACY_DISABLE]) {
      await db.query(
        "update public.direct_entry_capability_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and is_current",
        [tl.app],
      );
      await db.query(
        "update public.direct_entry_scope_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and scope_kind = 'team' and is_current",
        [tl.app],
      );
    }
    await db.query("select set_config('direct_entry.team_leader_marker', 'off', false)");

    return { world, workerT3 };
  }

  try {
    await setupNoLegacyTlWorld(dbBefore);
    const { world: afterWorld, workerT3 } = await setupNoLegacyTlWorld(dbAfter);

    // 1. Confirm WP8C shared helper direct_entry_assert_team_leader_current_team was NOT altered by #227
    const sharedBefore = (
      await dbBefore.query("select pg_get_functiondef('public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)'::regprocedure) as src")
    ).rows[0].src;
    const sharedAfter = (
      await dbAfter.query("select pg_get_functiondef('public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)'::regprocedure) as src")
    ).rows[0].src;
    assert.equal(sharedAfter, sharedBefore, "WP8B-2 must NOT modify WP8C shared direct_entry_assert_team_leader_current_team");

    // 2. Confirm canonical assignment & WP5 paired grants are intact while legacy mirror rows are gone
    const canonicalState = (
      await dbAfter.query(
        `select
           u.authz_managed,
           (select count(*)::int from public.direct_entry_team_leader_assignments a
             where a.leader_app_user_id = u.app_user_id and a.team_id = $2::uuid and a.is_current) as active_tl_assignments,
           (select count(*)::int from public.direct_entry_capability_grants c
             where c.app_user_id = u.app_user_id and c.is_current) as active_legacy_caps,
           (select count(*)::int from public.direct_entry_scope_grants s
             where s.app_user_id = u.app_user_id and s.scope_kind = 'team' and s.is_current) as active_legacy_team_scopes
         from public.direct_entry_app_users u
        where u.app_user_id = $1::uuid`,
        [TL_NO_LEGACY.app, TEAM_3],
      )
    ).rows[0];
    assert.equal(canonicalState.authz_managed, true);
    assert.equal(canonicalState.active_tl_assignments, 1, "Canonical TL assignment must remain intact");
    assert.equal(canonicalState.active_legacy_caps, 0, "Legacy capability mirror must be cleared");
    assert.equal(canonicalState.active_legacy_team_scopes, 0, "Legacy team scope mirror must be cleared");

    // 3. BEFORE (#226): managed TL without legacy mirror FAILED 42501 on SQL offboarding report
    await expectServiceRpcError(
      dbBefore,
      "direct_entry_offboarding_report",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );

    // 4. AFTER (#227): SQL report ALLOWS strictly TEAM_3 (no phone, no export, no hide),
    //    TS nav/page ALLOW, and Location Catalog / Recruitment Posts override stay DENIED!
    const reportRes = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      TL_NO_LEGACY.auth,
      TL_NO_LEGACY.app,
      1,
      25,
    ]);
    assert.ok(parseOffboardingReportList(reportRes), "No-legacy managed TL payload must pass strict contract");
    assert.equal(reportRes.authority, "team_leader");
    assert.equal(reportRes.scope, "team");
    assert.equal(reportRes.can_export, false);
    assert.equal(reportRes.can_hide, false);
    assert.equal(reportRes.items.length, 1, "Must see ONLY TEAM_3 worker (never TEAM_1 or TEAM_2)");
    assert.equal(reportRes.items[0].employee_code, workerT3.employeeCode);
    assert.equal("phone" in reportRes.items[0], false, "TL offboarding view must never expose phone");

    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report_export",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app],
      "42501",
      /offboarding report export denied/,
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_hide_snapshot",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, workerT3.entryId, workerT3.offEventId, "TL cannot hide", nextUuid()],
      "42501",
      /WORKFORCE_OFFBOARDING_HIDE_DENIED/,
    );
    await expectServiceRpcError(
      dbAfter,
      "administrative_province_list_admin",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, null, false, 1, 10],
      "42501",
      /location catalog admin or bod authority denied/,
    );
    const tlPostGet = await serviceRpc(dbAfter, "recruitment_post_get", [
      TL_NO_LEGACY.auth,
      TL_NO_LEGACY.app,
      afterWorld.publishedBriefId,
    ]);
    assert.equal(tlPostGet.post.allowed_actions.can_edit, false);
    assert.equal(tlPostGet.post.allowed_actions.can_withdraw, false);

    // Real SQL -> resolveActor -> TS nav/page parity
    const { resolution: tlNoLegacyTs } = await resolveViaRealRpc(dbAfter, TL_NO_LEGACY.auth);
    assert.equal(tlNoLegacyTs.ok, true);
    assert.ok(
      tlNoLegacyTs.actor.effective_grants.some(
        (g) => g.capability === "team_manager_assign" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === TEAM_3,
      ),
      "Canonical WP5 effective_grants must still carry team_manager_assign @ CONTEXT_TEAM (TEAM_3)",
    );
    assert.equal(workforceOffboardingNavPredicate(tlNoLegacyTs.actor), true);
    assert.equal(canViewOffboardingReport(tlNoLegacyTs.actor), true);
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: tlNoLegacyTs }), "ALLOW");
    assert.equal(canManageRecruitmentLocations(tlNoLegacyTs.actor), false);
    assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: tlNoLegacyTs }), "ACCESS_DENIED");

    // 5. Non-widening: standalone direct grant team_manager_assign @ CONTEXT_TEAM (no TL assignment) -> DENIED
    await dbAfter.query(
      `insert into public.authz_direct_capability_grants
        (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, 'team_manager_assign', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Non-TL direct grant must not open Offboarding', $3::uuid)`,
      [BASE_USER.app, TEAM_3, OWNER.app],
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [BASE_USER.auth, BASE_USER.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );

    // 6. Ambiguity fail-closed: adding a second CONTEXT_TEAM team_manager_assign grant for TEAM_1
    //    alongside TEAM_3 TL assignment MUST deny Offboarding until ambiguity is removed!
    const ambigGrantId = (
      await dbAfter.query(
        `insert into public.authz_direct_capability_grants
          (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
         values ($1::uuid, 'team_manager_assign', 'CONTEXT_TEAM', $2::text, 'EXCEPTION_GRANT', 'Simulated ambiguous second team grant', $3::uuid)
         returning direct_grant_id`,
        [TL_NO_LEGACY.app, TEAM_1, OWNER.app],
      )
    ).rows[0].direct_grant_id;
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
    // Remove ambiguous extra grant -> exact TEAM_3 access restored
    await dbAfter.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Clear simulated ambiguity' where direct_grant_id = $1::uuid",
      [ambigGrantId, OWNER.app],
    );
    const restoredRes = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      TL_NO_LEGACY.auth,
      TL_NO_LEGACY.app,
      1,
      25,
    ]);
    assert.equal(restoredRes.authority, "team_leader");
    assert.equal(restoredRes.items.length, 1);

    // 6b. Structural invariant check: mismatched recruiter team membership (recruiter in TEAM_4
    //     while canonical TL assignment & WP5 grant still point to TEAM_3) fails closed 42501;
    //     restoring TEAM_3 membership immediately restores exact TEAM_3 access.
    await dbAfter.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_NO_LEGACY.recruiter, TEAM_4],
    );
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
    await dbAfter.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_NO_LEGACY.recruiter, TEAM_3],
    );
    const afterRestoreMembership = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      TL_NO_LEGACY.auth,
      TL_NO_LEGACY.app,
      1,
      25,
    ]);
    assert.equal(afterRestoreMembership.authority, "team_leader");
    assert.equal(afterRestoreMembership.items.length, 1);

    // 7. Disable no-legacy managed TL (TL_NO_LEGACY_DISABLE): confirm ALLOW before disable,
    //    then DENIED 42501 & TS ACCOUNT_UNAVAILABLE immediately after disable
    const preDisReport = await serviceRpc(dbAfter, "direct_entry_offboarding_report", [
      TL_NO_LEGACY_DISABLE.auth,
      TL_NO_LEGACY_DISABLE.app,
      1,
      25,
    ]);
    assert.equal(preDisReport.authority, "team_leader");
    assert.equal(preDisReport.scope, "team");
    const disVer = (
      await dbAfter.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [
        TL_NO_LEGACY_DISABLE.app,
      ])
    ).rows[0].version;
    await serviceRpc(dbAfter, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      TL_NO_LEGACY_DISABLE.app,
      disVer,
      "Disable no-legacy TL to verify fail-closed",
      `wp8b2-f05-dis-${nextUuid()}`,
    ]);
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [TL_NO_LEGACY_DISABLE.auth, TL_NO_LEGACY_DISABLE.app, 1, 25],
      "42501",
      /actor mapping denied/,
    );
    const { resolution: disTlTs } = await resolveViaRealRpc(dbAfter, TL_NO_LEGACY_DISABLE.auth);
    assert.equal(disTlTs.ok, false);
    assert.equal(disTlTs.reason, "ACTOR_DISABLED");
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: disTlTs }), "ACCOUNT_UNAVAILABLE");

    // 8. End TL_NO_LEGACY's canonical TL assignment (on this legacy-mirror-cleared fixture;
    //    canonical RPC direct_entry_revoke_team_leader on intact TL is verified in Test [5/6])
    //    -> DENIED 42501 on SQL report & TS nav/page flip to false / ACCESS_DENIED
    await dbAfter.query("select set_config('direct_entry.team_leader_marker', 'on', false)");
    await dbAfter.query(
      "update public.direct_entry_team_leader_assignments set is_current = false, valid_to = valid_from where team_id = $1::uuid and leader_app_user_id = $2::uuid and is_current",
      [TEAM_3, TL_NO_LEGACY.app],
    );
    await dbAfter.query("select set_config('direct_entry.team_leader_marker', 'off', false)");
    await expectServiceRpcError(
      dbAfter,
      "direct_entry_offboarding_report",
      [TL_NO_LEGACY.auth, TL_NO_LEGACY.app, 1, 25],
      "42501",
      /offboarding report denied/,
    );
    const { resolution: revTlTs } = await resolveViaRealRpc(dbAfter, TL_NO_LEGACY.auth);
    assert.equal(revTlTs.ok, true);
    assert.equal(workforceOffboardingNavPredicate(revTlTs.actor), false);
    assert.equal(canViewOffboardingReport(revTlTs.actor), false);
    assert.equal(decideWorkforceOffboardingPageAccess({ actor: revTlTs }), "ACCESS_DENIED");
  } finally {
    await dbBefore.close();
    await dbAfter.close();
  }
});
