/**
 * WP8B-2 — Location Catalog, Recruitment Posts & Offboarding on WP5 Paired Effective Access
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks and ZERO `0A000` volatility errors under `SET LOCAL ROLE service_role`:
 *   Race 1 (Location Catalog write + STABLE read vs role revoke & disable):
 *     - While `w1` holds an uncommitted `direct_entry_authz_revoke_global_role_admin` on `ADMIN_LOC`,
 *       `w2` executes `STABLE` `administrative_province_list_admin` + `industrial_park_list_admin`
 *       (zero `0A000`, zero blocking); after `w1` commits, list & write RPCs immediately fail closed
 *       with `42501` (`location catalog admin or bod authority denied`).
 *     - Bidirectional disable race: `direct_entry_disable_app_user` on `ADMIN_LOC_2` racing with
 *       `administrative_province_create_admin` -> zero `40P01`, deterministic fail-closed `42501`.
 *   Race 2A (Recruitment Posts acyclic 3-way lock chain — update -> withdraw -> revoke_global_role_admin):
 *     - `w1` (PM_RP) holds `recruitment_post_update` (`pg_advisory_xact_lock('recruitment_post:write')`
 *       + `FOR UPDATE` on brief, uncommitted).
 *     - `w2` (`ADMIN_RP`) invokes `recruitment_post_withdraw` (Step 2 takes FK `FOR KEY SHARE` on
 *       `direct_entry_app_users` via idempotency insert, passes Step 3 pre-lock check, then blocks
 *       behind `w1` on the advisory lock — verified via `pg_stat_activity`).
 *     - `w3` (`OWNER`) concurrently invokes `direct_entry_authz_revoke_global_role_admin` on `ADMIN_RP`
 *       (blocks behind `w2`'s FK `KEY SHARE` — strictly acyclic `w1 -> w2 -> w3`, verified via
 *       `pg_stat_activity`).
 *     - `w1` commits -> `w2` wakes up with stale version (`PT409`) and rolls back -> `w3` commits
 *       with zero `40P01` deadlocks; subsequent `ADMIN_RP` retry fails closed with `42501` and
 *       `STABLE` `recruitment_post_list_with_facets` flips `can_edit`/`can_withdraw` to `false`.
 *   Race 2B (Recruitment Posts Step 5 post-lock TOCTOU re-check under live advisory lock):
 *     - `w1` (PM_RP) holds `recruitment_post_update` (uncommitted); `w2` (`BOD_RP`, holding paired
 *       `entry_privileged_edit` at `ALL`) passes Step 3 and blocks behind `w1` (verified via
 *       `pg_stat_activity`).
 *     - `w3` ends `BOD_RP`'s paired direct grant (`authz_direct_capability_grants.ended_at = now()`,
 *       leaving the legacy mirror row untouched) and commits; `w1` rolls back so version is unchanged.
 *     - `w2` wakes up and executes Step 5 post-lock re-check via paired `recruitment_location_is_admin_or_bod`,
 *       immediately failing closed with `42501 RECRUITMENT_POST_ACCESS_DENIED` despite stale legacy rows.
 *   Race 3 (Offboarding STABLE report/export & VOLATILE hide_snapshot vs role revoke, disable & TL revoke):
 *     - While `w1` holds an uncommitted `direct_entry_authz_revoke_global_role_admin` on `ADMIN_OFF`,
 *       `w2` runs `STABLE` `direct_entry_offboarding_report` & `direct_entry_offboarding_report_export`
 *       (zero `0A000`, zero blocking); after commit, report, export, and `hide_snapshot` all fail
 *       closed with `42501` (`offboarding report denied`).
 *     - Concurrent `direct_entry_offboarding_hide_snapshot` (2x `pg_advisory_xact_lock`) racing with
 *       `direct_entry_disable_app_user` on `ADMIN_OFF_2` -> zero `40P01`, fail-closed `42501`.
 *     - Concurrent `direct_entry_revoke_team_leader` on `TL_OFF` racing with `STABLE`
 *       `direct_entry_offboarding_report` -> zero `40P01`, zero `0A000`, immediate `42501` post-commit.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8B2_MIGRATION_NAME = "20261120130000_wp8b2_location_posts_offboarding.sql";

const OWNER = {
  auth: "18c20000-0000-4000-8000-000000000001",
  app: "28c20000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Race WP8B2",
};
const LUANPT = {
  auth: "18c20000-0000-4000-8000-000000000002",
  app: "28c20000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c20000-0000-4000-8000-000000000003",
  app: "28c20000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c20000-0000-4000-8000-000000000004",
  app: "28c20000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const ADMIN_LOC = {
  auth: "18c20000-0000-4000-8000-000000000005",
  app: "28c20000-0000-4000-8000-000000000005",
  email: "admin.loc.wp8b2@hrpartner.vn",
  name: "Admin Location Race 1",
};
const ADMIN_LOC_2 = {
  auth: "18c20000-0000-4000-8000-000000000006",
  app: "28c20000-0000-4000-8000-000000000006",
  email: "admin.loc2.wp8b2@hrpartner.vn",
  name: "Admin Location Race 2",
};
const ADMIN_RP = {
  auth: "18c20000-0000-4000-8000-000000000007",
  app: "28c20000-0000-4000-8000-000000000007",
  email: "admin.rp.wp8b2@hrpartner.vn",
  name: "Admin Posts Race",
};
const PM_RP = {
  auth: "18c20000-0000-4000-8000-000000000008",
  app: "28c20000-0000-4000-8000-000000000008",
  recruiter: "38c20000-0000-4000-8000-000000000008",
  email: "pm.rp.wp8b2@hrpartner.vn",
  name: "PM Posts Race",
};
const ADMIN_OFF = {
  auth: "18c20000-0000-4000-8000-000000000009",
  app: "28c20000-0000-4000-8000-000000000009",
  email: "admin.off.wp8b2@hrpartner.vn",
  name: "Admin Offboarding Race 1",
};
const ADMIN_OFF_2 = {
  auth: "18c20000-0000-4000-8000-000000000010",
  app: "28c20000-0000-4000-8000-000000000010",
  email: "admin.off2.wp8b2@hrpartner.vn",
  name: "Admin Offboarding Race 2",
};
const TL_OFF = {
  auth: "18c20000-0000-4000-8000-000000000011",
  app: "28c20000-0000-4000-8000-000000000011",
  recruiter: "38c20000-0000-4000-8000-000000000011",
  email: "tl.off.wp8b2@hrpartner.vn",
  name: "TL Offboarding Race",
};
const REC_OFF = {
  auth: "18c20000-0000-4000-8000-000000000012",
  app: "28c20000-0000-4000-8000-000000000012",
  recruiter: "38c20000-0000-4000-8000-000000000012",
  email: "rec.off.wp8b2@hrpartner.vn",
  name: "Recruiter Offboarding Race",
};
const BOD_RP = {
  auth: "18c20000-0000-4000-8000-000000000013",
  app: "28c20000-0000-4000-8000-000000000013",
  email: "bod.rp.wp8b2@hrpartner.vn",
  name: "BoD Posts Step5 Race",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  ADMIN_LOC,
  ADMIN_LOC_2,
  ADMIN_RP,
  PM_RP,
  ADMIN_OFF,
  ADMIN_OFF_2,
  TL_OFF,
  REC_OFF,
  BOD_RP,
];

const TEAM_RACE = "48c20000-0000-4000-8000-000000000001";
const PRJ_RACE = "wp8b2_race_prj";

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
  return `98c20000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
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
  await new Promise((resolve) => server.close(() => resolve()));
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
  const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
  return rows[0]?.res;
}

async function waitForBlocked(observer, appName, timeoutMs = 4000) {
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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${appName} to block on lock`);
}

function makeBriefContent(customerName) {
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
      manager_name: PM_RP.name,
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

async function assignGlobalRole(client, actor, target, roleCode, reason) {
  const ver = (
    await client.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(client, "direct_entry_authz_assign_global_role_admin", [
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

test("WP8B-2 Real PostgreSQL 18 Concurrency: Location Catalog, Recruitment Posts post-lock re-check & Offboarding STABLE/hide vs revoke/disable (0 deadlocks, 0 0A000)", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required for concurrency verification");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp8b2-pg-race-"));
  const pgData = path.join(tmpDir, "data");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"]);
    run(pgCtl, [
      "-D",
      pgData,
      "-l",
      pgLog,
      "-o",
      `-p ${port} -h 127.0.0.1 -k "" -c log_min_messages=warning`,
      "start",
    ], { ignoreOutput: true });
    started = true;

    const admin = await connect(port, "wp8b2_setup");
    clients.push(admin);
    const w1 = await connect(port, "wp8b2_w1");
    const w2 = await connect(port, "wp8b2_w2");
    const w3 = await connect(port, "wp8b2_w3");
    clients.push(w1, w2, w3);
    for (const worker of [w1, w2, w3]) {
      await worker.query("set statement_timeout = '15s'");
    }

    await admin.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(migrationFiles.includes(WP8B2_MIGRATION_NAME), `${WP8B2_MIGRATION_NAME} must exist`);
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      await admin.query(sql);
      if (file === WP8B2_MIGRATION_NAME) break;
    }

    // Seed accounts & cutover
    for (const u of ALL_USERS) {
      await admin.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await admin.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LIENVU, NGATTT]) {
      for (const cap of ADMIN_SEED_CAPS) {
        await admin.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [adm.app, cap],
        );
      }
      await admin.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
        [adm.app],
      );
    }
    await admin.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [LUANPT.app],
    );
    await admin.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP8B2_RACE_T', 'Race Team', true)",
      [TEAM_RACE],
    );
    await admin.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Race Project', true)",
      [PRJ_RACE],
    );

    const plan = await runWp5Cutover(admin, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const cutoverRes = await runWp5Cutover(admin, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutoverRes.status, "APPLIED");

    // Assign secondary ADMIN roles for independent races
    for (const secondary of [ADMIN_LOC, ADMIN_LOC_2, ADMIN_RP, ADMIN_OFF, ADMIN_OFF_2]) {
      await assignGlobalRole(admin, OWNER, secondary, "ADMIN", `Seed ${secondary.name}`);
    }
    // Grant BOD_RP direct entry_privileged_edit @ ALL for Race 2B post-lock re-check proof
    await admin.query(
      `insert into public.authz_direct_capability_grants
        (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, 'entry_privileged_edit', 'ALL', null, 'EXCEPTION_GRANT', 'Race 2B BoD grant', $2::uuid)`,
      [BOD_RP.app, OWNER.app],
    );
    await admin.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [BOD_RP.app]);
    await seedRecruiterAndTeam(admin, PM_RP, TEAM_RACE);
    await seedRecruiterAndTeam(admin, TL_OFF, TEAM_RACE);
    await seedRecruiterAndTeam(admin, REC_OFF, TEAM_RACE);
    await serviceRpc(admin, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_RACE,
      TL_OFF.app,
      null,
      1,
      "Designate TL_OFF",
      `wp8b2-race-tl-${nextUuid()}`,
    ]);
    await serviceRpc(admin, "direct_entry_assign_project_manager", [
      OWNER.auth,
      OWNER.app,
      PRJ_RACE,
      PM_RP.recruiter,
      null,
      1,
      "Assign PM_RP",
      `wp8b2-race-pm-${nextUuid()}`,
    ]);

    await admin.query(
      `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
       values ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true)
       on conflict (labor_type_key) do update set active = true`,
    );

    const parkId = (
      await admin.query("select industrial_park_id from public.industrial_parks where active = true order by industrial_park_code asc limit 1")
    ).rows[0].industrial_park_id;

    // Seed 1 PUBLISHED recruitment post by PM_RP
    const brief = await serviceRpc(admin, "recruitment_post_create", [
      PM_RP.auth,
      PM_RP.app,
      JSON.stringify({
        project_id: PRJ_RACE,
        industrial_park_id: parkId,
        ...makeBriefContent("Khách hàng Race Post"),
      }),
      nextUuid(),
    ]);

    // Seed 2 offboarded workers in TEAM_RACE for Race 3
    const dates = (
      await admin.query(
        "select (public.direct_entry_authorization_date() - 12)::text as start_d, (public.direct_entry_authorization_date() - 5)::text as off_d",
      )
    ).rows[0];
    const entryYear = dates.start_d.slice(0, 4);
    const seedWorker = async (codeDigits, cccd) => {
      const code = `hrp-${entryYear}-${codeDigits}`;
      const entryId = nextUuid();
      const subId = nextUuid();
      const candId = nextUuid();
      const onId = nextUuid();
      const offId = nextUuid();
      const reasonId = nextUuid();
      await admin.query("begin");
      await admin.query(
        "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'WP8B2 concurrency seed')",
        [reasonId, OWNER.app],
      );
      await admin.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [candId]);
      await admin.query(
        "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
        [subId, OWNER.app],
      );
      await admin.query(
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
          PRJ_RACE,
          dates.start_d,
          code,
          JSON.stringify({
            display_name: `Worker ${code}`,
            date_of_birth: { state: "omitted" },
            national_id: { state: "provided", value: cccd },
            address: { state: "omitted" },
            phone: { state: "provided", value: "0909888777" },
          }),
          REC_OFF.recruiter,
          TEAM_RACE,
        ],
      );
      await seedLegacyReviewSubmission(
        { exec: (sql) => admin.query(sql), query: (...args) => admin.query(...args) },
        subId,
      );
      await admin.query(
        "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = 3 where submission_id = $1::uuid",
        [subId],
      );
      await admin.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1::uuid, $2::uuid, 'ON', $3::date, null, null, 1, $4::uuid, $5::uuid, null)`,
        [onId, entryId, dates.start_d, OWNER.app, reasonId],
      );
      await admin.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1::uuid, $2::uuid, 'OFF', $3::date, $3::date, 'Nghỉ việc', 2, $4::uuid, $5::uuid, null)`,
        [offId, entryId, dates.off_d, OWNER.app, reasonId],
      );
      await admin.query("commit");
      return { entryId, offEventId: offId };
    };
    const worker1 = await seedWorker("882901", "001099111001");
    const worker2 = await seedWorker("882902", "001099111002");

    // =========================================================================
    // RACE 1: Location Catalog STABLE read & write vs role revoke & disable
    // =========================================================================
    const locAssignId = (
      await admin.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
        [ADMIN_LOC.app],
      )
    ).rows[0].assignment_id;
    const locVer = (
      await admin.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_LOC.app])
    ).rows[0].version;

    await w1.query("begin; set local role service_role;");
    const r1Key = nextUuid();
    await serviceRpcInTx(w1, "direct_entry_authz_revoke_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      ADMIN_LOC.app,
      locAssignId,
      locVer,
      "Race 1 revoke ADMIN_LOC",
      r1Key,
      sha256(`r1:${r1Key}`),
    ]);
    // While revoke is uncommitted, STABLE Location Catalog reads run with 0 0A000 and 0 blocking
    const locListDuring = await serviceRpc(w2, "administrative_province_list_admin", [
      ADMIN_LOC.auth,
      ADMIN_LOC.app,
      null,
      false,
      1,
      10,
    ]);
    assert.ok(locListDuring.provinces.length >= 4);
    const parkListDuring = await serviceRpc(w2, "industrial_park_list_admin", [
      ADMIN_LOC.auth,
      ADMIN_LOC.app,
      null,
      null,
      false,
      1,
      10,
    ]);
    assert.ok(parkListDuring.total >= 13 && parkListDuring.industrial_parks.length === 10);

    await w1.query("commit");

    // Immediately after commit -> fail closed 42501 on both STABLE read and VOLATILE create
    await assert.rejects(
      () => serviceRpc(w2, "administrative_province_list_admin", [ADMIN_LOC.auth, ADMIN_LOC.app, null, false, 1, 10]),
      (err) => err.code === "42501" && /location catalog admin or bod authority denied/.test(err.message),
    );
    await assert.rejects(
      () =>
        serviceRpc(w2, "administrative_province_create_admin", [
          ADMIN_LOC.auth,
          ADMIN_LOC.app,
          0,
          "WP8B2_R1_DENIED",
          "Tinh Denied After Revoke",
          "Race 1 post-revoke",
          nextUuid(),
        ]),
      (err) => err.code === "42501" && /location catalog admin or bod authority denied/.test(err.message),
    );

    // Bidirectional disable vs Location Catalog write (zero 40P01)
    const loc2Ver = (
      await admin.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_LOC_2.app])
    ).rows[0].version;
    const [disableOutcome, createOutcome] = await Promise.allSettled([
      serviceRpc(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        ADMIN_LOC_2.app,
        loc2Ver,
        "Race 1B disable ADMIN_LOC_2",
        `wp8b2-r1b-dis-${nextUuid()}`,
      ]),
      serviceRpc(w2, "administrative_province_create_admin", [
        ADMIN_LOC_2.auth,
        ADMIN_LOC_2.app,
        0,
        "WP8B2_R1B_PROV",
        "Tinh Race 1B",
        "Race 1B concurrent create",
        nextUuid(),
      ]),
    ]);
    assert.equal(disableOutcome.status, "fulfilled", `Disable must succeed without deadlock: ${disableOutcome.reason}`);
    if (createOutcome.status === "rejected") {
      assert.notEqual(createOutcome.reason.code, "40P01", "Must never deadlock");
      assert.notEqual(createOutcome.reason.code, "0A000", "Must never hit STABLE volatility violation");
      assert.equal(createOutcome.reason.code, "42501");
    }
    await assert.rejects(
      () => serviceRpc(w2, "administrative_province_list_admin", [ADMIN_LOC_2.auth, ADMIN_LOC_2.app, null, false, 1, 10]),
      (err) => err.code === "42501" && /actor mapping denied/.test(err.message),
    );

    // =========================================================================
    // RACE 2A: Acyclic 3-way chain (update -> withdraw -> revoke_global_role_admin)
    //          Proves zero 40P01 deadlock across recruitment_post:write + idempotency FK + role revoke!
    // =========================================================================
    await w1.query("begin; set local role service_role;");
    const r2aUpdated = await serviceRpcInTx(w1, "recruitment_post_update", [
      PM_RP.auth,
      PM_RP.app,
      brief.post.brief_id,
      brief.post.version,
      JSON.stringify(makeBriefContent("Khách hàng Race 2A Committed Update")),
      nextUuid(),
    ]);

    const w2Race2aPromise = (async () => {
      await w2.query("begin; set local role service_role;");
      try {
        const res = await serviceRpcInTx(w2, "recruitment_post_withdraw", [
          ADMIN_RP.auth,
          ADMIN_RP.app,
          brief.post.brief_id,
          brief.post.version,
          nextUuid(),
        ]);
        await w2.query("commit");
        return { ok: true, res };
      } catch (err) {
        await w2.query("rollback").catch(() => {});
        return { ok: false, code: err.code, message: err.message };
      }
    })();

    await waitForBlocked(admin, "wp8b2_w2");

    // Start w3 revoke concurrently (blocks behind w2's FK KEY SHARE on direct_entry_app_users;
    // w1 -> w2 -> w3 is strictly acyclic -> zero 40P01!)
    const rpAssignId = (
      await admin.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
        [ADMIN_RP.app],
      )
    ).rows[0].assignment_id;
    const rpVer = (
      await admin.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_RP.app])
    ).rows[0].version;
    const r2Key = nextUuid();
    const w3RevokePromise = serviceRpc(w3, "direct_entry_authz_revoke_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      ADMIN_RP.app,
      rpAssignId,
      rpVer,
      "Race 2A revoke ADMIN_RP concurrently with withdraw",
      r2Key,
      sha256(`r2a:${r2Key}`),
    ]);

    await waitForBlocked(admin, "wp8b2_w3");

    // Commit w1 -> w2 wakes up, sees stale version (PT409), rolls back -> w3 unblocks & commits!
    await w1.query("commit");
    const [w2Race2a, w3RevokeRes] = await Promise.all([w2Race2aPromise, w3RevokePromise]);
    assert.equal(w2Race2a.ok, false);
    assert.notEqual(w2Race2a.code, "40P01", "Must never deadlock");
    assert.equal(w2Race2a.code, "PT409", `Expected stale PT409 on w2, got ${w2Race2a.code}: ${w2Race2a.message}`);
    assert.ok(w3RevokeRes, "Revoke must commit cleanly with zero deadlock");

    // Retry withdraw with fresh version -> immediately fails closed 42501 RECRUITMENT_POST_ACCESS_DENIED
    await assert.rejects(
      () =>
        serviceRpc(w2, "recruitment_post_withdraw", [
          ADMIN_RP.auth,
          ADMIN_RP.app,
          brief.post.brief_id,
          r2aUpdated.post.version,
          nextUuid(),
        ]),
      (err) => err.code === "42501" && /RECRUITMENT_POST_ACCESS_DENIED/.test(err.message),
    );

    // Verify STABLE recruitment_post_list_with_facets reflects revoked authority (can_edit=false, can_withdraw=false)
    const rpFacetsAfter = await serviceRpc(w2, "recruitment_post_list_with_facets", [
      ADMIN_RP.auth,
      ADMIN_RP.app,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      10,
    ]);
    assert.equal(rpFacetsAfter.total_count, 1);
    assert.equal(rpFacetsAfter.items[0].allowed_actions.can_edit, false);
    assert.equal(rpFacetsAfter.items[0].allowed_actions.can_withdraw, false);

    // =========================================================================
    // RACE 2B: Deterministic Step 5 post-lock TOCTOU re-check under live advisory lock!
    // =========================================================================
    await w1.query("begin; set local role service_role;");
    await serviceRpcInTx(w1, "recruitment_post_update", [
      PM_RP.auth,
      PM_RP.app,
      brief.post.brief_id,
      r2aUpdated.post.version,
      JSON.stringify(makeBriefContent("Khách hàng Race 2B Holding Lock")),
      nextUuid(),
    ]);

    // w2 (BOD_RP) passes Step 3 pre-lock check while BoD grant is active, then blocks on advisory lock!
    const w2Race2bPromise = (async () => {
      await w2.query("begin; set local role service_role;");
      try {
        const res = await serviceRpcInTx(w2, "recruitment_post_withdraw", [
          BOD_RP.auth,
          BOD_RP.app,
          brief.post.brief_id,
          r2aUpdated.post.version,
          nextUuid(),
        ]);
        await w2.query("commit");
        return { ok: true, res };
      } catch (err) {
        await w2.query("rollback").catch(() => {});
        return { ok: false, code: err.code, message: err.message };
      }
    })();

    await waitForBlocked(admin, "wp8b2_w2");

    // While w2 is blocked AFTER Step 3 and BEFORE Step 5 post-lock re-check,
    // end BOD_RP's paired direct grant (stale legacy row deliberately NOT touched!) and commit!
    await w3.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Race 2B revoke BoD grant' where app_user_id = $1::uuid and ended_at is null",
      [BOD_RP.app, OWNER.app],
    );

    // Release w1 via rollback (brief version unchanged & PUBLISHED) -> w2 runs Step 5 post-lock re-check
    // via paired recruitment_location_is_admin_or_bod and MUST fail closed 42501 despite stale legacy row!
    await w1.query("rollback");
    const w2Race2b = await w2Race2bPromise;
    assert.equal(w2Race2b.ok, false, "w2 MUST fail closed at Step 5 post-lock re-check after BoD grant ended");
    assert.equal(w2Race2b.code, "42501", `Expected 42501 at Step 5 re-check, got ${w2Race2b.code}: ${w2Race2b.message}`);
    assert.match(w2Race2b.message, /RECRUITMENT_POST_ACCESS_DENIED/);

    // =========================================================================
    // RACE 3: Offboarding STABLE report/export & hide_snapshot vs revoke / disable / TL revoke
    // =========================================================================
    const offAssignId = (
      await admin.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null",
        [ADMIN_OFF.app],
      )
    ).rows[0].assignment_id;
    const offVer = (
      await admin.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_OFF.app])
    ).rows[0].version;

    await w1.query("begin; set local role service_role;");
    const r3Key = nextUuid();
    await serviceRpcInTx(w1, "direct_entry_authz_revoke_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      ADMIN_OFF.app,
      offAssignId,
      offVer,
      "Race 3A revoke ADMIN_OFF",
      r3Key,
      sha256(`r3a:${r3Key}`),
    ]);
    // Uncommitted revoke -> STABLE report & export succeed without 0A000 or blocking
    const offReportDuring = await serviceRpc(w2, "direct_entry_offboarding_report", [ADMIN_OFF.auth, ADMIN_OFF.app, 1, 25]);
    assert.equal(offReportDuring.authority, "admin");
    assert.equal(offReportDuring.items.length, 2);
    const offExportDuring = await serviceRpc(w2, "direct_entry_offboarding_report_export", [ADMIN_OFF.auth, ADMIN_OFF.app]);
    assert.equal(offExportDuring.items.length, 2);

    await w1.query("commit");

    // Post-commit -> report, export, and hide_snapshot all fail closed with 42501
    await assert.rejects(
      () => serviceRpc(w2, "direct_entry_offboarding_report", [ADMIN_OFF.auth, ADMIN_OFF.app, 1, 25]),
      (err) => err.code === "42501" && /offboarding report denied/.test(err.message),
    );
    await assert.rejects(
      () => serviceRpc(w2, "direct_entry_offboarding_report_export", [ADMIN_OFF.auth, ADMIN_OFF.app]),
      (err) => err.code === "42501" && /offboarding report denied/.test(err.message),
    );
    await assert.rejects(
      () =>
        serviceRpc(w2, "direct_entry_offboarding_hide_snapshot", [
          ADMIN_OFF.auth,
          ADMIN_OFF.app,
          worker1.entryId,
          worker1.offEventId,
          "Post-revoke hide attempt",
          nextUuid(),
        ]),
      (err) => err.code === "42501" && /offboarding report denied/.test(err.message),
    );

    // Race 3B: Concurrent hide_snapshot (2x advisory lock) vs disable_app_user on ADMIN_OFF_2 (zero 40P01)
    const off2Ver = (
      await admin.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [ADMIN_OFF_2.app])
    ).rows[0].version;
    const [disOff2, hideOff2] = await Promise.allSettled([
      serviceRpc(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        ADMIN_OFF_2.app,
        off2Ver,
        "Race 3B disable ADMIN_OFF_2",
        `wp8b2-r3b-dis-${nextUuid()}`,
      ]),
      serviceRpc(w2, "direct_entry_offboarding_hide_snapshot", [
        ADMIN_OFF_2.auth,
        ADMIN_OFF_2.app,
        worker2.entryId,
        worker2.offEventId,
        "Race 3B concurrent hide",
        nextUuid(),
      ]),
    ]);
    assert.equal(disOff2.status, "fulfilled", `Disable ADMIN_OFF_2 must succeed: ${disOff2.reason}`);
    if (hideOff2.status === "rejected") {
      assert.notEqual(hideOff2.reason.code, "40P01", "Must never deadlock");
      assert.notEqual(hideOff2.reason.code, "0A000", "Must never hit STABLE volatility error");
      assert.equal(hideOff2.reason.code, "42501");
    }
    await assert.rejects(
      () => serviceRpc(w2, "direct_entry_offboarding_report", [ADMIN_OFF_2.auth, ADMIN_OFF_2.app, 1, 25]),
      (err) => err.code === "42501" && /actor mapping denied/.test(err.message),
    );

    // Race 3C: Concurrent direct_entry_revoke_team_leader on TL_OFF vs STABLE direct_entry_offboarding_report
    const teamVer = (
      await admin.query("select version from public.teams where team_id = $1::uuid", [TEAM_RACE])
    ).rows[0].version;
    const [revokeTlRes, tlReadRes] = await Promise.allSettled([
      serviceRpc(w1, "direct_entry_revoke_team_leader", [
        OWNER.auth,
        OWNER.app,
        TEAM_RACE,
        null,
        teamVer,
        "Race 3C revoke TL_OFF",
        `wp8b2-r3c-tl-${nextUuid()}`,
      ]),
      serviceRpc(w2, "direct_entry_offboarding_report", [TL_OFF.auth, TL_OFF.app, 1, 25]),
    ]);
    assert.equal(revokeTlRes.status, "fulfilled", `TL revoke must succeed without deadlock: ${revokeTlRes.reason}`);
    if (tlReadRes.status === "rejected") {
      assert.notEqual(tlReadRes.reason.code, "40P01");
      assert.notEqual(tlReadRes.reason.code, "0A000");
      assert.equal(tlReadRes.reason.code, "42501");
    }
    await assert.rejects(
      () => serviceRpc(w2, "direct_entry_offboarding_report", [TL_OFF.auth, TL_OFF.app, 1, 25]),
      (err) => err.code === "42501" && /offboarding report denied/.test(err.message),
    );
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
