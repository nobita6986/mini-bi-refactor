/**
 * WP8C-1 — Contextual Team Leader / Project Manager / Entry Access Guards
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks, ZERO `0A000` volatility errors, and ZERO flakes:
 *   Race 1A — Managed TL (legacy mirror cleared!) `direct_entry_assign_project_manager`
 *     vs `direct_entry_move_team_membership`, `direct_entry_disable_app_user` (target & TL),
 *     and canonical intact managed `TL_2` vs `direct_entry_revoke_team_leader`:
 *     - Mirror-cleared managed `TL_1` assigns `REC_MGR_1` to `PRJ_1` cleanly.
 *     - Uncommitted `direct_entry_move_team_membership` (`REC_MGR_2`: `TEAM_1 -> TEAM_2`)
 *       blocks `TL_1`'s `direct_entry_assign_project_manager` cleanly -> post-commit `42501`.
 *     - Uncommitted `direct_entry_disable_app_user` on target (`REC_MGR_3`) and on mirror-cleared
 *       TL (`TL_DIS`) blocks `direct_entry_assign_project_manager` cleanly -> post-commit `42501`.
 *     - Uncommitted `direct_entry_revoke_team_leader` on `TEAM_2` blocks canonical intact `TL_2`'s
 *       `direct_entry_assign_project_manager` cleanly -> post-commit `42501` with zero residue.
 *   Race 2 — Managed TL / PM `direct_entry_privileged_edit` (holds `FOR UPDATE` on
 *     `direct_entries` + `direct_entry_submissions` before calling
 *     `direct_entry_assert_team_leader_current_team` & `direct_entry_resolve_direct_edit_authority`)
 *     racing with `direct_entry_unassign_project_manager` and `direct_entry_disable_app_user`,
 *     followed by D10 `direct_entry_enable_app_user` recovery verification.
 *   Race 3 — Managed mirror-cleared PM `recruitment_post_create` (holds advisory lock +
 *     `direct_entry_projects FOR SHARE` before re-checking `direct_entry_actor_is_assigned_project_manager`)
 *     racing with:
 *     - Uncommitted `direct_entry_set_project_active(PRJ_1, false)` -> fails cleanly with
 *       EXACT `22023` (`RECRUITMENT_POST_CONTENT_INVALID`), NOT `42501` or `40P01`.
 *     - Uncommitted `direct_entry_unassign_project_manager(PM_1, PRJ_1)` -> fails cleanly with
 *       EXACT `42501` (`RECRUITMENT_POST_ACCESS_DENIED`), zero deadlocks.
 *   Race 4 — Concurrent `STABLE` read burst (`direct_entry_resolve_actor_context`,
 *     `direct_entry_worker_directory_audience`, `direct_entry_offboarding_report`,
 *     `work_report_has_active_obligations`) alongside disable/enable transitions
 *     (30+ concurrent reads, `0` `0A000`, `0` `40P01`, `0` `25006`) + live PG18 catalog
 *     verification (exact `337` `service_role` RPCs, `0` `PUBLIC`/`anon`/`authenticated`
 *     `EXECUTE`, and `provolatile = 's'` on all 10 `STABLE` WP8C-1 internal helpers +
 *     `direct_entry_resolve_actor_context` + `work_report_has_active_obligations`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { S0_T1_C_TARGET_ROUTINE_PATTERN } from "./lib/migration-validation.mjs";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8C1_MIGRATION_NAME = "20261120150000_wp8c1_contextual_tl_pm_guards.sql";

const OWNER = {
  auth: "18c30000-0000-4000-8000-000000000001",
  app: "28c30000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Race WP8C1",
};
const LUANPT = {
  auth: "18c30000-0000-4000-8000-000000000002",
  app: "28c30000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c30000-0000-4000-8000-000000000003",
  app: "28c30000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c30000-0000-4000-8000-000000000004",
  app: "28c30000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const TL_1 = {
  auth: "18c30000-0000-4000-8000-000000000005",
  app: "28c30000-0000-4000-8000-000000000005",
  recruiter: "38c30000-0000-4000-8000-000000000005",
  email: "tl1.wp8c1@hrpartner.vn",
  name: "Managed TL 1 Mirror Cleared",
};
const REC_MGR_1 = {
  auth: "18c30000-0000-4000-8000-000000000006",
  app: "28c30000-0000-4000-8000-000000000006",
  recruiter: "38c30000-0000-4000-8000-000000000006",
  email: "recmgr1.wp8c1@hrpartner.vn",
  name: "Recruiter Manager 1",
};
const REC_MGR_2 = {
  auth: "18c30000-0000-4000-8000-000000000007",
  app: "28c30000-0000-4000-8000-000000000007",
  recruiter: "38c30000-0000-4000-8000-000000000007",
  email: "recmgr2.wp8c1@hrpartner.vn",
  name: "Recruiter Manager 2 Move",
};
const REC_MGR_3 = {
  auth: "18c30000-0000-4000-8000-000000000008",
  app: "28c30000-0000-4000-8000-000000000008",
  recruiter: "38c30000-0000-4000-8000-000000000008",
  email: "recmgr3.wp8c1@hrpartner.vn",
  name: "Recruiter Manager 3 Disable",
};
const TL_2 = {
  auth: "18c30000-0000-4000-8000-000000000009",
  app: "28c30000-0000-4000-8000-000000000009",
  recruiter: "38c30000-0000-4000-8000-000000000009",
  email: "tl2.wp8c1@hrpartner.vn",
  name: "Managed TL 2 Canonical Intact",
};
const REC_MGR_T2 = {
  auth: "18c30000-0000-4000-8000-000000000010",
  app: "28c30000-0000-4000-8000-000000000010",
  recruiter: "38c30000-0000-4000-8000-000000000010",
  email: "recmgrt2.wp8c1@hrpartner.vn",
  name: "Recruiter Manager Team 2",
};
const TL_DIS = {
  auth: "18c30000-0000-4000-8000-000000000011",
  app: "28c30000-0000-4000-8000-000000000011",
  recruiter: "38c30000-0000-4000-8000-000000000011",
  email: "tldis.wp8c1@hrpartner.vn",
  name: "Managed TL Disable Race",
};
const REC_MGR_T3 = {
  auth: "18c30000-0000-4000-8000-000000000012",
  app: "28c30000-0000-4000-8000-000000000012",
  recruiter: "38c30000-0000-4000-8000-000000000012",
  email: "recmgrt3.wp8c1@hrpartner.vn",
  name: "Recruiter Manager Team 3",
};
const PM_1 = {
  auth: "18c30000-0000-4000-8000-000000000013",
  app: "28c30000-0000-4000-8000-000000000013",
  recruiter: "38c30000-0000-4000-8000-000000000013",
  email: "pm1.wp8c1@hrpartner.vn",
  name: "Managed PM 1 Mirror Cleared",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  TL_1,
  REC_MGR_1,
  REC_MGR_2,
  REC_MGR_3,
  TL_2,
  REC_MGR_T2,
  TL_DIS,
  REC_MGR_T3,
  PM_1,
];

const TEAM_1 = "48c30000-0000-4000-8000-000000000001";
const TEAM_2 = "48c30000-0000-4000-8000-000000000002";
const TEAM_3 = "48c30000-0000-4000-8000-000000000003";
const PRJ_1 = "wp8c1_race_prj1";
const PRJ_2 = "wp8c1_race_prj2";
const PRJ_3 = "wp8c1_race_prj3";

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

const WP8C1_STABLE_INTERNAL_HELPERS = [
  "public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)",
  "public.direct_entry_offboarding_authority(uuid,uuid)",
  "public.direct_entry_project_assignment_effective(uuid,text)",
  "public.direct_entry_actor_is_assigned_project_manager(uuid,text)",
  "public.direct_entry_assert_project_operation_authority(uuid,uuid)",
  "public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text)",
  "public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)",
  "public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)",
  "public.direct_entry_actor_can_access_project(uuid,text)",
  "public.direct_entry_worker_directory_audience(uuid,uuid,text,text)",
];

const WP8C1_VOLATILE_INTERNAL_HELPERS = [
  "public.direct_entry_lock_project_team_manager_context(uuid,uuid,uuid,uuid)",
];

const WP8C1_SERVICE_RPCS = [
  { sig: "public.direct_entry_resolve_actor_context(uuid)", expectStable: true },
  { sig: "public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)", expectStable: false },
  { sig: "public.direct_entry_read_own_submission(uuid,uuid,uuid)", expectStable: false },
  { sig: "public.work_report_has_active_obligations(uuid,uuid)", expectStable: true },
];

let seq = 1;
function nextUuid() {
  return `98c30000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceRpc(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpcInTx(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("set local role service_role");
  const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
  return rows[0]?.res;
}

async function serviceRpcReadOnly(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin transaction read only");
  try {
    await client.query("set local lock_timeout = '500ms'");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function ownerRpcReadOnly(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin transaction read only");
  try {
    await client.query("set local lock_timeout = '500ms'");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

function asSettled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select wait_event_type, wait_event
         from pg_stat_activity
        where application_name = $1
          and state = 'active'
          and wait_event_type = 'Lock'`,
      [appName],
    );
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${appName} to block on a PostgreSQL lock`);
}

async function seedRecruiterAndTeam(client, user, teamId) {
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
    [user.recruiter, user.name],
  );
  await client.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
    [user.recruiter],
  );
  await client.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
    [user.recruiter, teamId],
  );
  await client.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [user.app, user.recruiter],
  );
}

async function clearLegacyMirror(client, appUserId) {
  await client.query("begin");
  try {
    await client.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
    await client.query(
      `update public.direct_entry_capability_grants
          set is_current = false, valid_to = valid_from
        where app_user_id = $1::uuid
          and is_current`,
      [appUserId],
    );
    await client.query(
      `update public.direct_entry_scope_grants
          set is_current = false, valid_to = valid_from
        where app_user_id = $1::uuid
          and is_current`,
      [appUserId],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function assertMirrorCleared(client, appUserId, { expectedTlTeamId = null } = {}) {
  const { rows: [state] } = await client.query(
    `select
       u.authz_managed,
       (select count(*)::int from public.direct_entry_capability_grants c
         where c.app_user_id = u.app_user_id and c.is_current) as active_legacy_caps,
       (select count(*)::int from public.direct_entry_scope_grants s
         where s.app_user_id = u.app_user_id and s.is_current) as active_legacy_scopes,
       (select count(*)::int from public.direct_entry_team_leader_assignments a
         where a.leader_app_user_id = u.app_user_id
           and ($2::uuid is null or a.team_id = $2::uuid)
           and a.is_current) as active_tl_assignments
     from public.direct_entry_app_users u
    where u.app_user_id = $1::uuid`,
    [appUserId, expectedTlTeamId],
  );
  assert.equal(state.authz_managed, true, `Expected authz_managed=true for ${appUserId}`);
  assert.equal(state.active_legacy_caps, 0, `Legacy capability mirror must be cleared for ${appUserId}`);
  assert.equal(state.active_legacy_scopes, 0, `Legacy scope mirror must be cleared for ${appUserId}`);
  if (expectedTlTeamId) {
    assert.equal(state.active_tl_assignments, 1, `Canonical TL assignment must remain intact for ${appUserId}`);
  }
}

function makeWorkerDetails(displayName, cccd) {
  return {
    display_name: displayName,
    date_of_birth: { state: "omitted" },
    national_id: { state: "provided", value: cccd },
    address: { state: "omitted" },
    phone: { state: "provided", value: "0909888777" },
  };
}

async function seedSubmittedWorker(client, {
  projectId,
  recruiterId,
  teamId,
  codeDigits,
  cccd,
  startDate,
  offDate = null,
}) {
  const entryYear = startDate.slice(0, 4);
  const code = `hrp-${entryYear}-${codeDigits}`;
  const entryId = nextUuid();
  const subId = nextUuid();
  const candId = nextUuid();
  const onId = nextUuid();
  const reasonId = nextUuid();
  await client.query("begin");
  try {
    await client.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'WP8C1 concurrency seed')",
      [reasonId, OWNER.app],
    );
    await client.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [candId]);
    await client.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
      [subId, OWNER.app],
    );
    await client.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7, $8::jsonb, $9::uuid, $10::uuid, 'hrp', 'TEMPORARY')`,
      [
        entryId,
        subId,
        candId,
        OWNER.app,
        projectId,
        startDate,
        code,
        JSON.stringify(makeWorkerDetails(`Worker ${code}`, cccd)),
        recruiterId,
        teamId,
      ],
    );
    await seedLegacyReviewSubmission(
      { exec: (sql) => client.query(sql), query: (...args) => client.query(...args) },
      subId,
    );
    await client.query(
      "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = 3 where submission_id = $1::uuid",
      [subId],
    );
    await client.query(
      `insert into public.direct_entry_employment_status_events (
         event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
         version, actor_user_id, reason_id, supersedes_event_id
       ) values ($1::uuid, $2::uuid, 'ON', $3::date, null, null, 1, $4::uuid, $5::uuid, null)`,
      [onId, entryId, startDate, OWNER.app, reasonId],
    );
    if (offDate) {
      await client.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1::uuid, $2::uuid, 'OFF', $3::date, $3::date, 'Nghỉ việc', 2, $4::uuid, $5::uuid, null)`,
        [nextUuid(), entryId, offDate, OWNER.app, reasonId],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
  return { entryId, subId, code, cccd };
}

function makeBriefContent(customerName, managerName) {
  return {
    general: {
      customer_name: customerName,
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Điện tử",
      job_description: "Lắp ráp linh kiện",
      environment_types: ["CLEAN_ROOM"],
      work_postures: ["SITTING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: managerName,
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục",
      expected_headcount: 50,
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
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 ngày công",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Chuyên cần",
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: null,
      seniority_allowance_conditions: null,
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9000000",
      average_income_max_vnd: "12000000",
      salary_payment_schedule: "Ngày 10 hàng tháng",
      salary_advance_available: false,
      salary_advance_amount_vnd: null,
      salary_advance_schedule: null,
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
      ppe_details: "Miễn phí đồng phục",
      other_benefits: "Hỗ trợ ăn ca",
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
    },
  };
}

test("WP8C-1 Real PostgreSQL 18 Concurrency: Mirror-cleared TL/PM lock races, direct edit + D10 recovery, recruitment_post_create 22023/42501 ordering, STABLE read burst & live ACL/volatility catalog invariants", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required for concurrency verification");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp8c1-pg-race-"));
  const pgData = path.join(tmpDir, "data");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    run(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} -k "" -c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "wp8c1_setup");
    const observer = await connect(port, "wp8c1_observer");
    const w1 = await connect(port, "wp8c1_w1");
    const w2 = await connect(port, "wp8c1_w2");
    const w3 = await connect(port, "wp8c1_w3");
    const w4 = await connect(port, "wp8c1_w4");
    const r1 = await connect(port, "wp8c1_r1");
    const r2 = await connect(port, "wp8c1_r2");
    const r3 = await connect(port, "wp8c1_r3");
    const r4 = await connect(port, "wp8c1_r4");
    clients.push(setup, observer, w1, w2, w3, w4, r1, r2, r3, r4);
    for (const worker of [w1, w2, w3, w4, r1, r2, r3, r4]) {
      await worker.query("set statement_timeout = '15s'");
    }

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(migrationFiles.includes(WP8C1_MIGRATION_NAME), `${WP8C1_MIGRATION_NAME} must exist`);
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      await setup.query(sql);
      if (file === WP8C1_MIGRATION_NAME) break;
    }

    // Seed accounts, teams & projects before WP5 cutover so every account becomes authz_managed = true
    for (const u of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await setup.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LIENVU, NGATTT]) {
      for (const cap of ADMIN_SEED_CAPS) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [adm.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
        [adm.app],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [LUANPT.app],
    );

    await setup.query(
      `insert into public.teams (team_id, code, display_name, active) values
         ($1::uuid, 'WP8C1_T1', 'WP8C1 Race Team 1', true),
         ($2::uuid, 'WP8C1_T2', 'WP8C1 Race Team 2', true),
         ($3::uuid, 'WP8C1_T3', 'WP8C1 Race Team 3', true)`,
      [TEAM_1, TEAM_2, TEAM_3],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active) values
         ($1, 'WP8C1 Race Project 1', true),
         ($2, 'WP8C1 Race Project 2', true),
         ($3, 'WP8C1 Race Project 3', true)`,
      [PRJ_1, PRJ_2, PRJ_3],
    );

    const cutoverPlan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
    const cutoverRes = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: cutoverPlan.manifest_fingerprint,
    });
    assert.equal(cutoverRes.status, "APPLIED");

    // Seed recruiters, HRP memberships, team memberships & verified links
    for (const u of [TL_1, REC_MGR_1, REC_MGR_2, REC_MGR_3, PM_1]) {
      await seedRecruiterAndTeam(setup, u, TEAM_1);
    }
    for (const u of [TL_2, REC_MGR_T2]) {
      await seedRecruiterAndTeam(setup, u, TEAM_2);
    }
    for (const u of [TL_DIS, REC_MGR_T3]) {
      await seedRecruiterAndTeam(setup, u, TEAM_3);
    }

    // Map each team to its project so TL assignment races isolate membership/TL/disable guards
    for (const [teamId, projectId] of [
      [TEAM_1, PRJ_1],
      [TEAM_2, PRJ_2],
      [TEAM_3, PRJ_3],
    ]) {
      await serviceRpc(setup, "direct_entry_grant_project_team_scopes_batch", [
        OWNER.auth,
        OWNER.app,
        teamId,
        [projectId],
        `Seed scope ${projectId}`,
        `wp8c1-pts-${nextUuid()}`,
      ]);
    }

    // Designate TL_1 (TEAM_1), TL_2 (TEAM_2), TL_DIS (TEAM_3) via canonical RPC
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      TL_1.app,
      null,
      1,
      "Designate managed TL_1 on TEAM_1",
      `wp8c1-tl1-${nextUuid()}`,
    ]);
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_2,
      TL_2.app,
      null,
      1,
      "Designate canonical intact TL_2 on TEAM_2",
      `wp8c1-tl2-${nextUuid()}`,
    ]);
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_3,
      TL_DIS.app,
      null,
      1,
      "Designate managed TL_DIS on TEAM_3",
      `wp8c1-tldis-${nextUuid()}`,
    ]);

    // Clear ONLY legacy capability/scope mirror rows on TL_1 and TL_DIS (canonical TLA stays intact!)
    await clearLegacyMirror(setup, TL_1.app);
    await clearLegacyMirror(setup, TL_DIS.app);
    await assertMirrorCleared(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });
    await assertMirrorCleared(setup, TL_DIS.app, { expectedTlTeamId: TEAM_3 });

    const { rows: [dates] } = await setup.query(
      `select
         public.direct_entry_authorization_date()::text as today,
         (public.direct_entry_authorization_date() - 12)::text as start_d,
         (public.direct_entry_authorization_date() - 4)::text as off_d`,
    );

    // =========================================================================
    // RACE 1A: Managed TL (legacy mirror cleared!) assign_project_manager
    //          vs move_team_membership, disable_app_user & revoke_team_leader
    // =========================================================================

    // 1A-0: Verify mirror-cleared managed TL_1 can assign TEAM_1 manager REC_MGR_1 to PRJ_1 normally
    const assignMgr1Res = await serviceRpc(w2, "direct_entry_assign_project_manager", [
      TL_1.auth,
      TL_1.app,
      PRJ_1,
      REC_MGR_1.recruiter,
      null,
      1,
      "Mirror-cleared TL_1 normal assign REC_MGR_1",
      `wp8c1-r1a-ok-${nextUuid()}`,
    ]);
    assert.ok(assignMgr1Res?.assignment_id, "Mirror-cleared managed TL_1 must assign TEAM_1 manager cleanly");
    assert.equal(assignMgr1Res.project_version, 2);

    // 1A-i: Session A holds uncommitted move_team_membership (REC_MGR_2: TEAM_1 -> TEAM_2);
    //       Session B (mirror-cleared TL_1) calls assign_project_manager(REC_MGR_2 -> PRJ_1)
    //       -> blocks cleanly, commit Session A -> Session B fails closed 42501!
    const recMgr2Ver = (
      await setup.query("select version from public.recruiters where recruiter_id = $1::uuid", [REC_MGR_2.recruiter])
    ).rows[0].version;
    const prj1VerBeforeMove = (
      await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_move_team_membership", [
      OWNER.auth,
      OWNER.app,
      REC_MGR_2.recruiter,
      TEAM_2,
      dates.today,
      recMgr2Ver,
      "Race 1A-i move REC_MGR_2 out of TEAM_1",
      `wp8c1-r1a-move-${nextUuid()}`,
    ]);

    const r1aMoveIdem = `wp8c1-r1a-assign-move-${nextUuid()}`;
    const r1aMovePromise = asSettled(
      serviceRpc(w2, "direct_entry_assign_project_manager", [
        TL_1.auth,
        TL_1.app,
        PRJ_1,
        REC_MGR_2.recruiter,
        null,
        prj1VerBeforeMove,
        "Race 1A-i mirror-cleared TL_1 assign during move",
        r1aMoveIdem,
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r1aMoveRes = await r1aMovePromise;
    assert.equal(r1aMoveRes.status, "rejected", "Race 1A-i assign must fail closed after REC_MGR_2 moves team");
    assert.notEqual(r1aMoveRes.reason.code, "40P01", "Race 1A-i must never deadlock");
    assert.notEqual(r1aMoveRes.reason.code, "0A000", "Race 1A-i must never hit STABLE volatility violation");
    assert.equal(r1aMoveRes.reason.code, "42501", `Expected 42501, got ${r1aMoveRes.reason.code}: ${r1aMoveRes.reason.message}`);

    // 1A-ii(a): Session A holds uncommitted disable_app_user on target REC_MGR_3;
    //           Session B (mirror-cleared TL_1) calls assign_project_manager(REC_MGR_3 -> PRJ_1)
    //           -> blocks cleanly, commit Session A -> Session B fails closed 42501!
    const recMgr3AppVer = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [REC_MGR_3.app])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      REC_MGR_3.app,
      recMgr3AppVer,
      "Race 1A-ii(a) disable target REC_MGR_3",
      `wp8c1-r1a-dis-mgr3-${nextUuid()}`,
    ]);

    const r1aDisMgr3Promise = asSettled(
      serviceRpc(w2, "direct_entry_assign_project_manager", [
        TL_1.auth,
        TL_1.app,
        PRJ_1,
        REC_MGR_3.recruiter,
        null,
        prj1VerBeforeMove,
        "Race 1A-ii(a) mirror-cleared TL_1 assign disabled REC_MGR_3",
        `wp8c1-r1a-assign-dis-mgr3-${nextUuid()}`,
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r1aDisMgr3Res = await r1aDisMgr3Promise;
    assert.equal(r1aDisMgr3Res.status, "rejected", "Race 1A-ii(a) assign must fail closed after REC_MGR_3 disabled");
    assert.notEqual(r1aDisMgr3Res.reason.code, "40P01", "Race 1A-ii(a) must never deadlock");
    assert.notEqual(r1aDisMgr3Res.reason.code, "0A000");
    assert.equal(r1aDisMgr3Res.reason.code, "42501", `Expected 42501, got ${r1aDisMgr3Res.reason.code}: ${r1aDisMgr3Res.reason.message}`);

    // 1A-ii(b): Session A holds uncommitted disable_app_user on mirror-cleared TL_DIS;
    //           Session B (mirror-cleared TL_DIS) calls assign_project_manager(REC_MGR_T3 -> PRJ_3)
    //           -> blocks cleanly, commit Session A -> Session B fails closed 42501!
    const tlDisAppVer = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_DIS.app])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      TL_DIS.app,
      tlDisAppVer,
      "Race 1A-ii(b) disable mirror-cleared TL_DIS",
      `wp8c1-r1a-dis-tldis-${nextUuid()}`,
    ]);

    const r1aDisTlPromise = asSettled(
      serviceRpc(w2, "direct_entry_assign_project_manager", [
        TL_DIS.auth,
        TL_DIS.app,
        PRJ_3,
        REC_MGR_T3.recruiter,
        null,
        1,
        "Race 1A-ii(b) mirror-cleared TL_DIS assign during own disable",
        `wp8c1-r1a-assign-tldis-${nextUuid()}`,
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r1aDisTlRes = await r1aDisTlPromise;
    assert.equal(r1aDisTlRes.status, "rejected", "Race 1A-ii(b) assign must fail closed after TL_DIS disabled");
    assert.notEqual(r1aDisTlRes.reason.code, "40P01", "Race 1A-ii(b) must never deadlock");
    assert.notEqual(r1aDisTlRes.reason.code, "0A000");
    assert.equal(r1aDisTlRes.reason.code, "42501", `Expected 42501, got ${r1aDisTlRes.reason.code}: ${r1aDisTlRes.reason.message}`);

    // 1A-iii: Canonical intact managed TL_2 on TEAM_2 calling assign_project_manager
    //         while Session A holds uncommitted direct_entry_revoke_team_leader on TEAM_2
    //         -> blocks cleanly, commit Session A -> Session B fails closed 42501, 0 deadlocks!
    const team2Ver = (
      await setup.query("select version from public.teams where team_id = $1::uuid", [TEAM_2])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_revoke_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_2,
      null,
      team2Ver,
      "Race 1A-iii revoke canonical intact TL_2 on TEAM_2",
      `wp8c1-r1a-rev-tl2-${nextUuid()}`,
    ]);

    const r1aRevokeIdem = `wp8c1-r1a-assign-rev-tl2-${nextUuid()}`;
    const r1aRevokePromise = asSettled(
      serviceRpc(w2, "direct_entry_assign_project_manager", [
        TL_2.auth,
        TL_2.app,
        PRJ_2,
        REC_MGR_T2.recruiter,
        null,
        1,
        "Race 1A-iii canonical intact TL_2 assign during revoke",
        r1aRevokeIdem,
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r1aRevokeRes = await r1aRevokePromise;
    assert.equal(r1aRevokeRes.status, "rejected", "Race 1A-iii assign must fail closed after TL_2 revoked");
    assert.notEqual(r1aRevokeRes.reason.code, "40P01", "Race 1A-iii must never deadlock");
    assert.notEqual(r1aRevokeRes.reason.code, "0A000");
    assert.equal(r1aRevokeRes.reason.code, "42501", `Expected 42501, got ${r1aRevokeRes.reason.code}: ${r1aRevokeRes.reason.message}`);

    // Confirm zero assignment/version/idempotency residue from rejected Race 1A writes
    const { rows: [r1aResidue] } = await observer.query(
      `select
         (select count(*)::int from public.direct_entry_project_manager_assignments
           where project_id = $1 and manager_recruiter_id = any($2::uuid[])) as prj1_rejected_assignments,
         (select version from public.direct_entry_projects where project_id = $1) as prj1_ver,
         (select count(*)::int from public.direct_entry_project_manager_assignments where project_id = $3) as prj2_assignments,
         (select version from public.direct_entry_projects where project_id = $3) as prj2_ver,
         (select count(*)::int from public.direct_entry_project_manager_assignments where project_id = $4) as prj3_assignments,
         (select version from public.direct_entry_projects where project_id = $4) as prj3_ver,
         (select count(*)::int from public.direct_entry_rpc_idempotency
           where idempotency_key = any($5::text[])) as rejected_idempotency`,
      [PRJ_1, [REC_MGR_2.recruiter, REC_MGR_3.recruiter], PRJ_2, PRJ_3, [r1aMoveIdem, r1aRevokeIdem]],
    );
    assert.deepEqual(r1aResidue, {
      prj1_rejected_assignments: 0,
      prj1_ver: 2,
      prj2_assignments: 0,
      prj2_ver: 1,
      prj3_assignments: 0,
      prj3_ver: 1,
      rejected_idempotency: 0,
    });

    // =========================================================================
    // RACE 2: Managed TL / PM `direct_entry_privileged_edit` racing with
    //         `direct_entry_unassign_project_manager` & `direct_entry_disable_app_user`
    //         (+ D10 `direct_entry_enable_app_user` recovery proof)
    // =========================================================================
    const prj1VerForPm = (
      await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;
    const pm1Assigned = await serviceRpc(setup, "direct_entry_assign_project_manager", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      PM_1.recruiter,
      null,
      prj1VerForPm,
      "Assign managed PM_1 to PRJ_1 for Race 2 & 3",
      `wp8c1-pm1-assign-${nextUuid()}`,
    ]);
    await clearLegacyMirror(setup, PM_1.app);
    await assertMirrorCleared(setup, PM_1.app);
    await assertMirrorCleared(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });

    // Seed submitted workers in TEAM_1 / PRJ_1 (+ 1 offboarded worker for Race 4)
    const workerTl = await seedSubmittedWorker(setup, {
      projectId: PRJ_1,
      recruiterId: REC_MGR_1.recruiter,
      teamId: TEAM_1,
      codeDigits: "883001",
      cccd: "001099333001",
      startDate: dates.start_d,
    });
    const workerPm = await seedSubmittedWorker(setup, {
      projectId: PRJ_1,
      recruiterId: REC_MGR_1.recruiter,
      teamId: TEAM_1,
      codeDigits: "883002",
      cccd: "001099333002",
      startDate: dates.start_d,
    });
    const workerShared = await seedSubmittedWorker(setup, {
      projectId: PRJ_1,
      recruiterId: REC_MGR_1.recruiter,
      teamId: TEAM_1,
      codeDigits: "883003",
      cccd: "001099333003",
      startDate: dates.start_d,
    });
    await seedSubmittedWorker(setup, {
      projectId: PRJ_1,
      recruiterId: REC_MGR_1.recruiter,
      teamId: TEAM_1,
      codeDigits: "883004",
      cccd: "001099333004",
      startDate: dates.start_d,
      offDate: dates.off_d,
    });

    // Baseline: mirror-cleared TL_1 & PM_1 both succeed on direct_entry_privileged_edit
    const baseTlEdit = await serviceRpc(w1, "direct_entry_privileged_edit", [
      TL_1.auth,
      TL_1.app,
      workerTl.entryId,
      1,
      JSON.stringify({ worker_details: makeWorkerDetails("TL Baseline Edit", workerTl.cccd) }),
      "Baseline mirror-cleared TL edit",
      `wp8c1-r2-base-tl-${nextUuid()}`,
    ]);
    assert.equal(baseTlEdit.version, 2);

    const basePmEdit = await serviceRpc(w2, "direct_entry_privileged_edit", [
      PM_1.auth,
      PM_1.app,
      workerPm.entryId,
      1,
      JSON.stringify({ worker_details: makeWorkerDetails("PM Baseline Edit", workerPm.cccd) }),
      "Baseline mirror-cleared PM edit",
      `wp8c1-r2-base-pm-${nextUuid()}`,
    ]);
    assert.equal(basePmEdit.version, 2);

    // Race 2A: Concurrent direct_entry_privileged_edit (mirror-cleared TL_1 & PM_1)
    //          alongside direct_entry_unassign_project_manager(PM_1 on PRJ_1)
    const prj1VerR2a = (
      await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;
    const allowedRace2Codes = new Set(["42501", "40001", "PT409"]);

    const [r2aUnassign, r2aPmEdit, r2aTlSharedEdit, r2aPmSharedEdit] = await Promise.allSettled([
      serviceRpc(w1, "direct_entry_unassign_project_manager", [
        OWNER.auth,
        OWNER.app,
        pm1Assigned.assignment_id,
        1,
        prj1VerR2a,
        "Race 2A unassign PM_1 concurrently with privileged_edit",
        `wp8c1-r2a-unassign-${nextUuid()}`,
      ]),
      serviceRpc(w2, "direct_entry_privileged_edit", [
        PM_1.auth,
        PM_1.app,
        workerPm.entryId,
        basePmEdit.version,
        JSON.stringify({ worker_details: makeWorkerDetails("PM Race 2A Edit", workerPm.cccd) }),
        "Race 2A PM edit",
        `wp8c1-r2a-pm-${nextUuid()}`,
      ]),
      serviceRpc(w3, "direct_entry_privileged_edit", [
        TL_1.auth,
        TL_1.app,
        workerShared.entryId,
        1,
        JSON.stringify({ worker_details: makeWorkerDetails("TL Shared Race 2A", workerShared.cccd) }),
        "Race 2A TL shared edit",
        `wp8c1-r2a-tl-shared-${nextUuid()}`,
      ]),
      serviceRpc(w4, "direct_entry_privileged_edit", [
        PM_1.auth,
        PM_1.app,
        workerShared.entryId,
        1,
        JSON.stringify({ worker_details: makeWorkerDetails("PM Shared Race 2A", workerShared.cccd) }),
        "Race 2A PM shared edit",
        `wp8c1-r2a-pm-shared-${nextUuid()}`,
      ]),
    ]);

    assert.equal(r2aUnassign.status, "fulfilled", `Race 2A unassign must succeed: ${r2aUnassign.reason?.message}`);
    for (const [label, outcome] of [
      ["r2aPmEdit", r2aPmEdit],
      ["r2aTlSharedEdit", r2aTlSharedEdit],
      ["r2aPmSharedEdit", r2aPmSharedEdit],
    ]) {
      if (outcome.status === "rejected") {
        assert.notEqual(outcome.reason.code, "40P01", `${label} must never deadlock`);
        assert.notEqual(outcome.reason.code, "0A000", `${label} must never hit STABLE volatility violation`);
        assert.ok(
          allowedRace2Codes.has(outcome.reason.code),
          `${label} unexpected error ${outcome.reason.code}: ${outcome.reason.message}`,
        );
      }
    }

    // Post-unassign: PM_1 editing workerPm with fresh version MUST fail closed 42501
    const workerPmVerAfter2a = (
      await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [workerPm.entryId])
    ).rows[0].version;
    await assert.rejects(
      () =>
        serviceRpc(w2, "direct_entry_privileged_edit", [
          PM_1.auth,
          PM_1.app,
          workerPm.entryId,
          workerPmVerAfter2a,
          JSON.stringify({ worker_details: makeWorkerDetails("PM Post-Unassign Denied", workerPm.cccd) }),
          "Post-unassign denied",
          `wp8c1-r2a-post-denied-${nextUuid()}`,
        ]),
      (err) => err.code === "42501",
    );

    // Re-assign PM_1 to PRJ_1 (keep mirror cleared) before Race 2B disable + D10 enable recovery
    const prj1VerR2bAssign = (
      await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;
    const pm1Reassigned = await serviceRpc(setup, "direct_entry_assign_project_manager", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      PM_1.recruiter,
      null,
      prj1VerR2bAssign,
      "Re-assign PM_1 for Race 2B & Race 3",
      `wp8c1-pm1-reassign-${nextUuid()}`,
    ]);
    await clearLegacyMirror(setup, PM_1.app);
    await assertMirrorCleared(setup, PM_1.app);

    const tl1VerBefore2b = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_1.app])
    ).rows[0].version;
    const pm1VerBefore2b = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [PM_1.app])
    ).rows[0].version;
    const workerTlVerBefore2b = (
      await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [workerTl.entryId])
    ).rows[0].version;
    const workerPmVerBefore2b = (
      await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [workerPm.entryId])
    ).rows[0].version;

    // Race 2B: Concurrent direct_entry_privileged_edit as mirror-cleared TL_1 & PM_1
    //          alongside direct_entry_disable_app_user(TL_1) & direct_entry_disable_app_user(PM_1)
    const [r2bDisTl, r2bTlEdit, r2bDisPm, r2bPmEdit] = await Promise.allSettled([
      serviceRpc(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        TL_1.app,
        tl1VerBefore2b,
        "Race 2B disable mirror-cleared TL_1",
        `wp8c1-r2b-dis-tl-${nextUuid()}`,
      ]),
      serviceRpc(w2, "direct_entry_privileged_edit", [
        TL_1.auth,
        TL_1.app,
        workerTl.entryId,
        workerTlVerBefore2b,
        JSON.stringify({ worker_details: makeWorkerDetails("TL Race 2B Edit", workerTl.cccd) }),
        "Race 2B TL edit",
        `wp8c1-r2b-tl-edit-${nextUuid()}`,
      ]),
      serviceRpc(w3, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        PM_1.app,
        pm1VerBefore2b,
        "Race 2B disable mirror-cleared PM_1",
        `wp8c1-r2b-dis-pm-${nextUuid()}`,
      ]),
      serviceRpc(w4, "direct_entry_privileged_edit", [
        PM_1.auth,
        PM_1.app,
        workerPm.entryId,
        workerPmVerBefore2b,
        JSON.stringify({ worker_details: makeWorkerDetails("PM Race 2B Edit", workerPm.cccd) }),
        "Race 2B PM edit",
        `wp8c1-r2b-pm-edit-${nextUuid()}`,
      ]),
    ]);

    assert.equal(r2bDisTl.status, "fulfilled", `Race 2B disable TL_1 must succeed: ${r2bDisTl.reason?.message}`);
    assert.equal(r2bDisPm.status, "fulfilled", `Race 2B disable PM_1 must succeed: ${r2bDisPm.reason?.message}`);
    for (const [label, outcome] of [
      ["r2bTlEdit", r2bTlEdit],
      ["r2bPmEdit", r2bPmEdit],
    ]) {
      if (outcome.status === "rejected") {
        assert.notEqual(outcome.reason.code, "40P01", `${label} must never deadlock`);
        assert.notEqual(outcome.reason.code, "0A000", `${label} must never hit STABLE volatility violation`);
        assert.ok(
          allowedRace2Codes.has(outcome.reason.code),
          `${label} unexpected error ${outcome.reason.code}: ${outcome.reason.message}`,
        );
      }
    }

    // Post-disable: both TL_1 & PM_1 MUST fail closed with 42501
    const workerTlVerPostDis = (
      await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [workerTl.entryId])
    ).rows[0].version;
    const workerPmVerPostDis = (
      await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [workerPm.entryId])
    ).rows[0].version;
    await assert.rejects(
      () =>
        serviceRpc(w2, "direct_entry_privileged_edit", [
          TL_1.auth,
          TL_1.app,
          workerTl.entryId,
          workerTlVerPostDis,
          JSON.stringify({ worker_details: makeWorkerDetails("TL Post-Disable Denied", workerTl.cccd) }),
          "Post-disable TL denied",
          `wp8c1-r2b-tl-post-dis-${nextUuid()}`,
        ]),
      (err) => err.code === "42501" && /actor mapping denied/.test(err.message),
    );
    await assert.rejects(
      () =>
        serviceRpc(w4, "direct_entry_privileged_edit", [
          PM_1.auth,
          PM_1.app,
          workerPm.entryId,
          workerPmVerPostDis,
          JSON.stringify({ worker_details: makeWorkerDetails("PM Post-Disable Denied", workerPm.cccd) }),
          "Post-disable PM denied",
          `wp8c1-r2b-pm-post-dis-${nextUuid()}`,
        ]),
      (err) => err.code === "42501" && /actor mapping denied/.test(err.message),
    );

    // D10 recovery: re-enable TL_1 & PM_1, verify canonical links & TL assignment restored,
    // re-clear legacy mirror, and prove both resume privileged_edit cleanly!
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      TL_1.app,
      r2bDisTl.value.version,
      "Race 2B D10 enable TL_1",
      `wp8c1-r2b-en-tl-${nextUuid()}`,
    ]);
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      PM_1.app,
      r2bDisPm.value.version,
      "Race 2B D10 enable PM_1",
      `wp8c1-r2b-en-pm-${nextUuid()}`,
    ]);

    await clearLegacyMirror(setup, TL_1.app);
    await clearLegacyMirror(setup, PM_1.app);
    await assertMirrorCleared(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });
    await assertMirrorCleared(setup, PM_1.app);

    const tlRecoveryEdit = await serviceRpc(w2, "direct_entry_privileged_edit", [
      TL_1.auth,
      TL_1.app,
      workerTl.entryId,
      workerTlVerPostDis,
      JSON.stringify({ worker_details: makeWorkerDetails("TL D10 Recovered Edit", workerTl.cccd) }),
      "Post-D10 TL recovery edit",
      `wp8c1-r2b-tl-rec-${nextUuid()}`,
    ]);
    assert.equal(tlRecoveryEdit.version, workerTlVerPostDis + 1);

    const pmRecoveryEdit = await serviceRpc(w4, "direct_entry_privileged_edit", [
      PM_1.auth,
      PM_1.app,
      workerPm.entryId,
      workerPmVerPostDis,
      JSON.stringify({ worker_details: makeWorkerDetails("PM D10 Recovered Edit", workerPm.cccd) }),
      "Post-D10 PM recovery edit",
      `wp8c1-r2b-pm-rec-${nextUuid()}`,
    ]);
    assert.equal(pmRecoveryEdit.version, workerPmVerPostDis + 1);

    // =========================================================================
    // RACE 3: Managed mirror-cleared PM `recruitment_post_create` racing with
    //         `direct_entry_set_project_active(false)` (EXACT 22023) and
    //         `direct_entry_unassign_project_manager` (EXACT 42501)
    // =========================================================================
    await setup.query(
      `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
       values ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true)
       on conflict (labor_type_key) do update set active = true`,
    );
    const parkId = (
      await setup.query(
        "select industrial_park_id from public.industrial_parks where active = true order by industrial_park_code asc limit 1",
      )
    ).rows[0].industrial_park_id;

    // Race 3A: Session A holds uncommitted set_project_active(PRJ_1, false);
    //          Session B (mirror-cleared PM_1) calls recruitment_post_create on PRJ_1;
    //          blocks at Step 5 FOR SHARE -> commit Session A -> Session B MUST raise EXACT 22023!
    const prj1VerR3a = (
      await setup.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
    ).rows[0].version;

    await w1.query("begin");
    const r3aDeactivated = await serviceRpcInTx(w1, "direct_entry_set_project_active", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      false,
      prj1VerR3a,
      "Race 3A deactivate PRJ_1 concurrently with recruitment_post_create",
      `wp8c1-r3a-deact-${nextUuid()}`,
    ]);
    assert.equal(r3aDeactivated.active, false);

    const r3aCreatePromise = asSettled(
      serviceRpc(w2, "recruitment_post_create", [
        PM_1.auth,
        PM_1.app,
        JSON.stringify({
          project_id: PRJ_1,
          industrial_park_id: parkId,
          ...makeBriefContent("Khách hàng Race 3A Inactive", PM_1.name),
        }),
        nextUuid(),
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r3aCreateRes = await r3aCreatePromise;
    assert.equal(r3aCreateRes.status, "rejected", "Race 3A create on deactivated project must fail");
    assert.notEqual(r3aCreateRes.reason.code, "40P01", "Race 3A must never deadlock");
    assert.notEqual(r3aCreateRes.reason.code, "42501", "Inactive project must preserve 22023 ordering, NOT 42501");
    assert.equal(
      r3aCreateRes.reason.code,
      "22023",
      `Expected EXACT 22023 on inactive project, got ${r3aCreateRes.reason.code}: ${r3aCreateRes.reason.message}`,
    );
    assert.match(r3aCreateRes.reason.message, /RECRUITMENT_POST_CONTENT_INVALID/);

    const briefsAfter3a = (
      await observer.query("select count(*)::int as n from public.recruitment_project_briefs where project_id = $1", [PRJ_1])
    ).rows[0].n;
    assert.equal(briefsAfter3a, 0, "Rejected Race 3A post must leave zero briefs");

    // Reactivate PRJ_1 and verify mirror-cleared PM_1 creates a post cleanly on active PRJ_1
    const r3aReactivated = await serviceRpc(setup, "direct_entry_set_project_active", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      true,
      r3aDeactivated.version,
      "Race 3B reactivate PRJ_1",
      `wp8c1-r3b-react-${nextUuid()}`,
    ]);
    assert.equal(r3aReactivated.active, true);

    const okBrief = await serviceRpc(w2, "recruitment_post_create", [
      PM_1.auth,
      PM_1.app,
      JSON.stringify({
        project_id: PRJ_1,
        industrial_park_id: parkId,
        ...makeBriefContent("Khách hàng Race 3B Active Baseline", PM_1.name),
      }),
      nextUuid(),
    ]);
    assert.ok(okBrief?.post?.brief_id, "Mirror-cleared PM_1 must create recruitment post cleanly on active PRJ_1");

    // Race 3B: Session A holds uncommitted unassign_project_manager(PM_1 on PRJ_1);
    //          Session B (mirror-cleared PM_1) calls recruitment_post_create on PRJ_1;
    //          blocks at Step 5 FOR SHARE -> commit Session A -> post-lock TOCTOU re-check raises EXACT 42501!
    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_unassign_project_manager", [
      OWNER.auth,
      OWNER.app,
      pm1Reassigned.assignment_id,
      1,
      r3aReactivated.version,
      "Race 3B unassign PM_1 concurrently with recruitment_post_create",
      `wp8c1-r3b-unassign-${nextUuid()}`,
    ]);

    const r3bCreatePromise = asSettled(
      serviceRpc(w2, "recruitment_post_create", [
        PM_1.auth,
        PM_1.app,
        JSON.stringify({
          project_id: PRJ_1,
          industrial_park_id: parkId,
          ...makeBriefContent("Khách hàng Race 3B Unassigned", PM_1.name),
        }),
        nextUuid(),
      ]),
    );
    await waitUntilBlocked(observer, "wp8c1_w2");
    await w1.query("commit");

    const r3bCreateRes = await r3bCreatePromise;
    assert.equal(r3bCreateRes.status, "rejected", "Race 3B create after PM unassign must fail closed");
    assert.notEqual(r3bCreateRes.reason.code, "40P01", "Race 3B must never deadlock");
    assert.notEqual(r3bCreateRes.reason.code, "0A000");
    assert.equal(
      r3bCreateRes.reason.code,
      "42501",
      `Expected EXACT 42501 after PM unassign, got ${r3bCreateRes.reason.code}: ${r3bCreateRes.reason.message}`,
    );
    assert.match(r3bCreateRes.reason.message, /RECRUITMENT_POST_ACCESS_DENIED/);

    const briefsAfter3b = (
      await observer.query("select count(*)::int as n from public.recruitment_project_briefs where project_id = $1", [PRJ_1])
    ).rows[0].n;
    assert.equal(briefsAfter3b, 1, "Rejected Race 3B post must leave only the baseline brief");

    // =========================================================================
    // RACE 4: Concurrent STABLE read burst alongside disable/enable transitions
    //         + live PG18 catalog ACL & volatility verification
    // =========================================================================
    await assertMirrorCleared(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });

    // 4A: Deterministic MVCC non-blocking barrier — while w1 holds uncommitted disable_app_user(TL_1),
    //     all 4 STABLE reads execute inside READ ONLY + lock_timeout=500ms with 0 blocking and 0 0A000!
    const tl1VerBefore4a = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_1.app])
    ).rows[0].version;
    await w1.query("begin");
    try {
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        TL_1.app,
        tl1VerBefore4a,
        "Race 4A uncommitted disable barrier for STABLE MVCC proof",
        `wp8c1-r4a-mvcc-${nextUuid()}`,
      ]);
      const [ctxDuring, audDuring, offDuring, obDuring] = await Promise.all([
        serviceRpcReadOnly(r1, "direct_entry_resolve_actor_context", [TL_1.auth]),
        ownerRpcReadOnly(r2, "direct_entry_worker_directory_audience", [TL_1.auth, TL_1.app, "team", null]),
        serviceRpcReadOnly(r3, "direct_entry_offboarding_report", [TL_1.auth, TL_1.app, 1, 25]),
        serviceRpcReadOnly(r4, "work_report_has_active_obligations", [TL_1.auth, TL_1.app]),
      ]);
      assert.equal(ctxDuring.enabled, true);
      assert.ok(ctxDuring.allowed_worker_tabs.includes("team"));
      assert.equal(audDuring.scope, "team");
      assert.equal(audDuring.team_id, TEAM_1);
      assert.equal(offDuring.authority, "team_leader");
      assert.ok(offDuring.items.length >= 1);
      assert.equal(typeof obDuring.has_active_obligations, "boolean");
    } finally {
      await w1.query("rollback");
    }

    // 4B: 32+ concurrent STABLE read burst across 4 sessions racing against 2 full disable/enable cycles
    let totalBurstReads = 0;
    const burstErrorCodes = [];
    const checkReadError = (label, err) => {
      assert.notEqual(err.code, "0A000", `${label} must NEVER raise 0A000 STABLE volatility violation`);
      assert.notEqual(err.code, "40P01", `${label} must NEVER deadlock`);
      assert.notEqual(err.code, "25006", `${label} must NEVER attempt write inside READ ONLY tx`);
      assert.notEqual(err.code, "55P03", `${label} must NEVER block on lock_timeout`);
      assert.equal(err.code, "42501", `${label} unexpected SQLSTATE ${err.code}: ${err.message}`);
      burstErrorCodes.push(err.code);
    };

    const burstOutcomes = await Promise.all([
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          const ctx = await serviceRpcReadOnly(r1, "direct_entry_resolve_actor_context", [TL_1.auth]);
          assert.equal(typeof ctx.enabled, "boolean");
          assert.ok(Array.isArray(ctx.allowed_worker_tabs));
          totalBurstReads += 1;
        }
        return "r1-ok";
      })(),
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          let aud = null;
          try {
            aud = await ownerRpcReadOnly(r2, "direct_entry_worker_directory_audience", [
              TL_1.auth,
              TL_1.app,
              "team",
              null,
            ]);
          } catch (err) {
            checkReadError("direct_entry_worker_directory_audience", err);
          }
          if (aud !== null) {
            assert.equal(aud.scope, "team");
            assert.equal(aud.team_id, TEAM_1);
          }
          totalBurstReads += 1;
        }
        return "r2-ok";
      })(),
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          let rep = null;
          try {
            rep = await serviceRpcReadOnly(r3, "direct_entry_offboarding_report", [
              TL_1.auth,
              TL_1.app,
              1,
              25,
            ]);
          } catch (err) {
            checkReadError("direct_entry_offboarding_report", err);
          }
          if (rep !== null) {
            assert.equal(rep.authority, "team_leader");
            assert.equal(rep.scope, "team");
            assert.ok(Array.isArray(rep.items) && rep.items.length >= 1);
          }
          totalBurstReads += 1;
        }
        return "r3-ok";
      })(),
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          let ob = null;
          try {
            ob = await serviceRpcReadOnly(r4, "work_report_has_active_obligations", [TL_1.auth, TL_1.app]);
          } catch (err) {
            checkReadError("work_report_has_active_obligations", err);
          }
          if (ob !== null) {
            assert.equal(typeof ob.has_active_obligations, "boolean");
          }
          totalBurstReads += 1;
        }
        return "r4-ok";
      })(),
      (async () => {
        let ver = tl1VerBefore4a;
        for (let cycle = 1; cycle <= 2; cycle += 1) {
          const dis = await serviceRpc(w1, "direct_entry_disable_app_user", [
            OWNER.auth,
            OWNER.app,
            TL_1.app,
            ver,
            `Race 4B disable cycle ${cycle}`,
            `wp8c1-r4b-dis-${cycle}-${nextUuid()}`,
          ]);
          ver = dis.version;
          const en = await serviceRpc(w1, "direct_entry_enable_app_user", [
            OWNER.auth,
            OWNER.app,
            TL_1.app,
            ver,
            `Race 4B enable cycle ${cycle}`,
            `wp8c1-r4b-en-${cycle}-${nextUuid()}`,
          ]);
          ver = en.version;
        }
        return "mutator-ok";
      })(),
    ]);
    assert.deepEqual(burstOutcomes, ["r1-ok", "r2-ok", "r3-ok", "r4-ok", "mutator-ok"]);
    assert.equal(totalBurstReads, 32, "Expected 32 concurrent STABLE reads during disable/enable transitions");

    // Re-clear legacy mirror on TL_1 after D10 enable cycles and verify all 4 STABLE reads + directory RPC succeed
    await clearLegacyMirror(setup, TL_1.app);
    await assertMirrorCleared(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });
    const [ctxAfter, audAfter, offAfter, obAfter, dirAfter] = await Promise.all([
      serviceRpcReadOnly(r1, "direct_entry_resolve_actor_context", [TL_1.auth]),
      ownerRpcReadOnly(r2, "direct_entry_worker_directory_audience", [TL_1.auth, TL_1.app, "team", null]),
      serviceRpcReadOnly(r3, "direct_entry_offboarding_report", [TL_1.auth, TL_1.app, 1, 25]),
      serviceRpcReadOnly(r4, "work_report_has_active_obligations", [TL_1.auth, TL_1.app]),
      serviceRpc(w2, "direct_entry_list_workers", [
        TL_1.auth,
        TL_1.app,
        "team",
        null,
        null,
        null,
        null,
        25,
        null,
        null,
        null,
        null,
        null,
      ]),
    ]);
    assert.equal(ctxAfter.enabled, true);
    assert.ok(ctxAfter.allowed_worker_tabs.includes("team"));
    assert.equal(audAfter.scope, "team");
    assert.equal(audAfter.team_id, TEAM_1);
    assert.equal(offAfter.authority, "team_leader");
    assert.ok(offAfter.items.length >= 1);
    assert.deepEqual(obAfter, { has_active_obligations: false });
    assert.ok(dirAfter.items.length >= 4);

    // 4C: Live PG18 catalog ACL & volatility verification
    const { rows: [catalogSummary] } = await setup.query(
      `select
         count(*) filter (
           where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
         )::int as service_rpc_count,
         count(*) filter (
           where pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
              or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or exists (
                select 1
                  from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              )
         )::int as exposed_client_or_public_count
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname ~ $1`,
      [S0_T1_C_TARGET_ROUTINE_PATTERN],
    );
    assert.equal(catalogSummary.service_rpc_count, 337, "Live PG18 catalog must have exact 337 service_role RPCs");
    assert.equal(
      catalogSummary.exposed_client_or_public_count,
      0,
      "Live PG18 catalog must expose 0 Mini BI routines to PUBLIC/anon/authenticated",
    );

    const inspectFn = async (sig) => {
      const { rows } = await setup.query(
        `select
           p.provolatile,
           p.prosecdef,
           p.proconfig,
           pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
           exists (
             select 1
               from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              where a.grantee = 0 and a.privilege_type = 'EXECUTE'
           ) as public_exec
         from pg_catalog.pg_proc p
        where p.oid = $1::pg_catalog.regprocedure`,
        [sig],
      );
      assert.equal(rows.length, 1, `Expected routine ${sig} to exist in pg_proc`);
      return rows[0];
    };

    for (const sig of WP8C1_STABLE_INTERNAL_HELPERS) {
      const row = await inspectFn(sig);
      assert.equal(row.provolatile, "s", `${sig} must be STABLE (provolatile='s')`);
      assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(
        Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"),
        `${sig} must lock search_path=pg_catalog, public`,
      );
      assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
      assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
      assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
      assert.equal(row.service_exec, false, `${sig} internal helper must revoke service_role EXECUTE`);
    }

    for (const sig of WP8C1_VOLATILE_INTERNAL_HELPERS) {
      const row = await inspectFn(sig);
      assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(
        Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"),
        `${sig} must lock search_path=pg_catalog, public`,
      );
      assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
      assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
      assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
      assert.equal(row.service_exec, false, `${sig} internal helper must revoke service_role EXECUTE`);
    }

    for (const { sig, expectStable } of WP8C1_SERVICE_RPCS) {
      const row = await inspectFn(sig);
      if (expectStable) {
        assert.equal(row.provolatile, "s", `${sig} must be STABLE (provolatile='s')`);
      }
      assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(
        Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"),
        `${sig} must lock search_path=pg_catalog, public`,
      );
      assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
      assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
      assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
      assert.equal(row.service_exec, true, `${sig} must grant EXECUTE to service_role`);
    }
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        stdio: "ignore",
        windowsHide: true,
      });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
