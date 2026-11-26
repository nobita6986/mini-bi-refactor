/**
 * WP10-6 Slice 2 — Work Report Assignment Pause Windows
 * PGlite End-to-End Regression, Security, & Edge-Case Suite.
 *
 * Pure ESM (runs under `node --test` or `node --conditions=react-server --test`)
 * against isolated in-memory PGlite instances.
 *
 * Covers:
 *   1) Migration hygiene (LF-only, 0 `@`, 0 `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`),
 *      atomic rollback zero drift, table RLS + forced RLS + 0 privileges + constraints/indexes,
 *      dynamic S0-T1-C allowlist postconditions (+0 net service_role RPCs, 0 client/PUBLIC grants),
 *      STABLE volatility on probe & candidate helper, and Pre-Upgrade PAUSED backfill (authoritative
 *      audit event with VN timezone boundary + prior-pause history vs missing-evidence graceful
 *      reactivation without fabricated pause_date).
 *   2) PW-01 (Single pause window + valid backfill) & PW-02 (Preserve existing NOT_STARTED / DRAFT /
 *      SUBMITTED / APPROVED / REJECTED obligations, due_at, snapshots, submissions, revisions & audit).
 *   3) PW-03 (Same-day pause + resume [D, D) vs cross-midnight VN boundary 23:59+07 -> 00:01+07 [D, D+1))
 *      & PW-04 (Multiple pause windows within 7-day lookback: ACTIVE D0 -> PAUSED D1 -> ACTIVE D2 ->
 *      PAUSED D3 -> ACTIVE D4 -> exact [D0, D2, D4]).
 *   4) PW-06 & PW-07 (All 4 frequencies: DAILY, WEEKLY full-week & partial-week pause, MONTHLY
 *      full-month & partial-month pause, ONCE unmaterialized first_eligible_date skip & already-materialized
 *      singleton preservation; plus TEAM/GROUP pause exclusion).
 *   5) PW-05 (Idempotency replay on PAUSED & ACTIVE, payload mismatch rejection, PAUSED -> PAUSED
 *      no duplicate open window, stale expected_version PT409 conflict, PAUSED -> REVOKED,
 *      work_report_archive_template closing open pause windows + clock-skew greatest() guard,
 *      and #37 immediate-on-create behavior intact).
 *   6) PW-08 (Strict BEGIN TRANSACTION READ ONLY parity of work_report_has_active_obligations vs
 *      work_report_list_my_obligations across PAUSED empty, PAUSED with existing active obligation,
 *      same-day pause/resume, post-resume, and fully-paused lookback with 0 DB writes).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const PAUSE_WINDOWS_MIGRATION_NAME =
  "20261126153000_wp10_6_work_report_assignment_pause_windows.sql";

const CREATE_ASSIGNMENT_CASTS = [
  "uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]",
  "text", "boolean", "integer", "time", "boolean", "date", "date", "text",
];
const CREATE_GROUP_ASSIGNMENT_CASTS = [
  "uuid", "uuid", "uuid", "uuid", "text", "boolean", "integer", "time", "boolean", "date", "date", "text",
];

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const OWNER = {
  auth: "90100000-0000-4000-8000-00000000a001",
  app: "90100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner Pause Windows",
};
const LUANPT = {
  auth: "90100000-0000-4000-8000-00000000a002",
  app: "90100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "90100000-0000-4000-8000-00000000a003",
  app: "90100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "90100000-0000-4000-8000-00000000a004",
  app: "90100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const TEAM_A = "90100000-0000-4000-8000-00000000d001";
const TEAM_B = "90100000-0000-4000-8000-00000000d002";

function makeEmp(num, slug, name) {
  const hex = String(num).padStart(3, "0");
  return {
    auth: `90100000-0000-4000-8000-00000000a${hex}`,
    app: `90100000-0000-4000-8000-00000000b${hex}`,
    rec: `90100000-0000-4000-8000-00000000c${hex}`,
    email: `pw.${slug}@hrpartner.vn`,
    name,
  };
}

const EMP_PRE_AUDIT = makeEmp(101, "pre.audit", "NV Pre Audit");
const EMP_PRE_NO_AUDIT = makeEmp(102, "pre.noaudit", "NV Pre No Audit");
const EMP_PW01 = makeEmp(103, "pw01", "NV PW01 Backfill");
const EMP_PW02 = makeEmp(104, "pw02", "NV PW02 Preserve");
const EMP_PW03_SAME = makeEmp(105, "pw03same", "NV PW03 Same Day");
const EMP_PW03_MID = makeEmp(106, "pw03mid", "NV PW03 Midnight");
const EMP_PW04 = makeEmp(107, "pw04", "NV PW04 Multi");
const EMP_WEEKLY = makeEmp(108, "weekly", "NV Weekly");
const EMP_MONTHLY = makeEmp(109, "monthly", "NV Monthly");
const EMP_ONCE_UNMAT = makeEmp(110, "once.unmat", "NV Once Unmat");
const EMP_ONCE_MAT = makeEmp(111, "once.mat", "NV Once Mat");
const EMP_TEAM_B = makeEmp(112, "teamb", "NV Team B");
const EMP_GROUP = makeEmp(113, "group", "NV Group");
const EMP_PW05 = makeEmp(114, "pw05", "NV PW05 Idem");
const EMP_PW08_A = makeEmp(115, "pw08a", "NV PW08 Empty");
const EMP_PW08_B = makeEmp(116, "pw08b", "NV PW08 Existing");
const EMP_PW08_C = makeEmp(117, "pw08c", "NV PW08 FullPaused");
const EMP_PRE_ACTIVE_CLOSED = makeEmp(118, "pre.active.closed", "NV Pre Active Closed");
const EMP_PRE_AMBIG_ACTIVE = makeEmp(119, "pre.ambig.active", "NV Pre Ambig Active");
const EMP_PRE_SAME_TS_CHAIN = makeEmp(120, "pre.samets", "NV Pre Same TS");
const EMP_PRE_TRUNC_AMBIG = makeEmp(121, "pre.truncambig", "NV Pre Trunc Ambig");

const MINIMAL_TEMPLATE_SCHEMA = {
  version: "work-report-schema/1.0",
  sections: [
    {
      section_key: "daily_kpi",
      label: "Kết quả trong ngày",
      description: null,
      sort_order: 10,
      fields: [
        {
          field_key: "calls_made",
          section_key: "daily_kpi",
          sort_order: 10,
          label: "Số cuộc gọi",
          description: null,
          field_type: "integer",
          required: true,
          default_value: 0,
          validation: { min_value: 0, max_value: 10000, allow_zero: true },
          options: null,
          is_metric: true,
          metric_spec: {
            metric_key: "calls_made",
            unit: "cuộc",
            aggregations: ["SUM", "AVG", "COUNT_VALID"],
            null_policy: "EXCLUDE_FROM_AVG",
            zero_policy: "INCLUDE_AS_ZERO",
            compatible_group: "recruitment_daily_calls_made_v1",
          },
          is_dimension: false,
        },
      ],
    },
  ],
};

const MINIMAL_METRIC_CONTRACT = {
  version: "work-report-metrics/1.0",
  metrics: [
    {
      metric_key: "calls_made",
      field_key: "calls_made",
      field_type: "integer",
      unit: "cuộc",
      aggregations: ["SUM", "AVG", "COUNT_VALID"],
      null_policy: "EXCLUDE_FROM_AVG",
      zero_policy: "INCLUDE_AS_ZERO",
      compatible_group: "recruitment_daily_calls_made_v1",
    },
  ],
};

const INSPECTED_FNS = [
  "public.work_report__internal_actor_materialization_candidates(uuid,date,integer)",
  "public.work_report__internal_materialize_actor_obligations(uuid,date,integer)",
  "public.work_report__internal_materialize_assignment_for_date(uuid,date)",
  "public.work_report_ensure_obligations_for_window(uuid,uuid,date)",
  "public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)",
  "public.work_report_archive_template(uuid,uuid,uuid,integer,text)",
  "public.work_report_has_active_obligations(uuid,uuid)",
];

let seq = 1;
function nextUuid() {
  return `90110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp106_pw_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}
function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

let cachedMigrationFiles = null;
async function loadMigrationFiles() {
  if (cachedMigrationFiles) return cachedMigrationFiles;
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  cachedMigrationFiles = await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
  return cachedMigrationFiles;
}

async function createEngine() {
  const db = new PGlite();
  return {
    async exec(sql, options) {
      await db.exec(sql, options);
    },
    async query(sql, params = []) {
      return db.query(sql, params);
    },
    async serviceRpc(fnName, args = [], casts = [], { readOnly = false } = {}) {
      const placeholders = args
        .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
        .join(", ");
      await db.exec(
        readOnly
          ? "begin transaction read only; set local role service_role"
          : "begin; set local role service_role",
      );
      try {
        const res = await db.query(`select public.${fnName}(${placeholders}) as data`, args);
        await db.exec("commit");
        return res.rows[0]?.data;
      } catch (err) {
        await db.exec("rollback").catch(() => {});
        throw err;
      }
    },
    async close() {
      await db.close();
    },
  };
}

async function seedLegacyAdmin(engine, user) {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await engine.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await engine.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedEmployee(engine, user, deptId, teamId, joinedOn = "2026-01-01") {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [user.app, user.auth, user.name],
  );
  await engine.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, 'STAFF', true)`,
    [user.rec, user.name, `PW_${user.rec.slice(-4)}`],
  );
  await engine.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
     values ($1::uuid, 'hrp', $2::date, true)`,
    [user.rec, joinedOn],
  );
  await engine.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, $3::date, true)`,
    [user.app, user.rec, joinedOn],
  );
  if (teamId) {
    await engine.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::date, true)`,
      [user.rec, teamId, joinedOn],
    );
  }
  await engine.serviceRpc("org_department_create_person_admin", [
    OWNER.auth,
    OWNER.app,
    `PW-${user.rec.slice(-4)}`,
    user.name,
    joinedOn,
    deptId,
    user.app,
    1,
    null,
    "WP10-6 pause-windows seed",
    nextUuid(),
    sha256(`person:${user.app}:${seq}`),
  ]);
}

async function createPublishedTemplate(engine, code, name, { frequency = "DAILY", requiresReview = false } = {}) {
  const created = await engine.serviceRpc("work_report_create_template", [
    OWNER.auth,
    OWNER.app,
    code,
    name,
    `${name} desc`,
    frequency,
    JSON.stringify(MINIMAL_TEMPLATE_SCHEMA),
    JSON.stringify(MINIMAL_METRIC_CONTRACT),
    nextKey("tpl"),
  ]);
  if (requiresReview) {
    await engine.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [created.draft_version_id],
    );
  }
  const published = await engine.serviceRpc("work_report_publish_template", [
    OWNER.auth,
    OWNER.app,
    created.template_id,
    created.draft_version_id,
    created.version,
    nextKey("pub"),
  ]);
  return { ...created, version: published.version };
}

async function createUserAssignment(
  engine,
  templateId,
  targetUserId,
  { frequency = "DAILY", dueDayOffset = 0, dueTimeLocal = "18:00:00", excludeSundays = false } = {},
) {
  return engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth,
      OWNER.app,
      templateId,
      "USER",
      targetUserId,
      null,
      null,
      frequency,
      true,
      dueDayOffset,
      dueTimeLocal,
      excludeSundays,
      null,
      null,
      nextKey("asgn"),
    ],
    CREATE_ASSIGNMENT_CASTS,
  );
}

async function fetchAssignmentObligations(engine, assignmentId) {
  const { rows } = await engine.query(
    `select o.obligation_id,
            o.assignee_app_user_id::text as assignee_app_user_id,
            o.period_type,
            o.period_key,
            o.period_start_date::text as period_start_date,
            o.period_end_date::text as period_end_date,
            o.due_at::text as due_at,
            o.obligation_status,
            o.version,
            o.snapshot_team_id::text as snapshot_team_id,
            o.snapshot_team_code,
            o.snapshot_team_display_name,
            o.snapshot_group_id::text as snapshot_group_id,
            o.snapshot_group_name,
            s.submission_id::text as submission_id,
            coalesce(s.state, 'NOT_STARTED') as submission_state,
            s.version as submission_version,
            s.first_submitted_at::text as first_submitted_at,
            s.draft_payload_json,
            s.current_revision_id::text as current_revision_id
       from public.work_report_obligations o
       left join public.work_report_submissions s on s.obligation_id = o.obligation_id
      where o.assignment_id = $1::uuid
      order by o.period_start_date asc, o.assignee_app_user_id asc`,
    [assignmentId],
  );
  return rows;
}

async function fetchPauseWindows(engine, assignmentId) {
  const { rows } = await engine.query(
    `select pause_window_id::text as pause_window_id,
            assignment_id::text as assignment_id,
            paused_date::text as paused_date,
            resumed_date::text as resumed_date
       from public.work_report_assignment_pause_windows
      where assignment_id = $1::uuid
      order by paused_date asc, created_at asc, pause_window_id asc`,
    [assignmentId],
  );
  return rows;
}

async function countWrTables(engine) {
  const tables = [
    "work_report_obligations",
    "work_report_submissions",
    "work_report_submission_revisions",
    "work_report_audit_events",
    "work_report_assignments",
    "work_report_assignment_pause_windows",
  ];
  const counts = {};
  for (const t of tables) {
    const { rows: [{ cnt }] } = await engine.query(`select count(*)::int as cnt from public.${t}`);
    counts[t] = cnt;
  }
  return counts;
}

async function assertReadOnlyProbeParity(engine, employee, expectedHasActive, label) {
  const countsBefore = await countWrTables(engine);
  const probe = await engine.serviceRpc(
    "work_report_has_active_obligations",
    [employee.auth, employee.app],
    ["uuid", "uuid"],
    { readOnly: true },
  );
  assert.strictEqual(
    probe.has_active_obligations,
    expectedHasActive,
    `${label}: READ ONLY has_active_obligations expected ${expectedHasActive}`,
  );
  assert.deepEqual(
    await countWrTables(engine),
    countsBefore,
    `${label}: READ ONLY probe must perform 0 DB writes`,
  );

  const list = await engine.serviceRpc(
    "work_report_list_my_obligations",
    [employee.auth, employee.app, "ACTIVE"],
    ["uuid", "uuid", "text"],
  );
  const actualHasActive = Array.isArray(list.items) && list.items.length > 0;
  assert.strictEqual(
    actualHasActive,
    probe.has_active_obligations,
    `${label}: has_active_obligations (${probe.has_active_obligations}) must match list_my_obligations ACTIVE (${actualHasActive})`,
  );
  return list.items;
}

async function bootstrapFullDb(employees = []) {
  const migrations = await loadMigrationFiles();
  const pwIdx = migrations.findIndex((m) => m.name === PAUSE_WINDOWS_MIGRATION_NAME);
  assert.ok(pwIdx > 0, `Migration ${PAUSE_WINDOWS_MIGRATION_NAME} must exist`);
  const groupsIdx = migrations.findIndex(
    (m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  );
  assert.ok(groupsIdx > 0 && groupsIdx < pwIdx);

  const engine = await createEngine();
  await engine.exec(ROLE_PREAMBLE);
  for (let i = 0; i < groupsIdx; i += 1) {
    await engine.exec(migrations[i].sql);
  }
  await seedLegacyAdmin(engine, OWNER);
  await seedLegacyAdmin(engine, LUANPT);
  await seedLegacyAdmin(engine, LIENVU);
  await seedLegacyAdmin(engine, NGATTT);

  const plan = await runWp5Cutover(engine, { mode: "read-only-plan" });
  const applied = await runWp5Cutover(engine, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  for (let i = groupsIdx; i <= pwIdx; i += 1) {
    await engine.exec(migrations[i].sql);
  }

  await engine.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'PW_TEAM_A', 'Đội A PauseWin', true, 1),
            ($2::uuid, 'PW_TEAM_B', 'Đội B PauseWin', true, 1)`,
    [TEAM_A, TEAM_B],
  );
  const { rows: [mktDept] } = await engine.query(
    "select department_id from public.organization_departments where system_key = 'MARKETING'",
  );
  assert.ok(mktDept?.department_id, "MARKETING org department must exist");

  for (const { user, teamId = TEAM_A } of employees) {
    await seedEmployee(engine, user, mktDept.department_id, teamId);
  }

  const { rows: [{ today_vn: todayVn }] } = await engine.query(
    "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
  );
  return { engine, todayVn, mktDeptId: mktDept.department_id };
}

test("WP10-6 PW #1 (PGlite): Migration hygiene, atomic rollback, RLS/ACL/constraints, +0 net RPCs, & Pre-Upgrade PAUSED backfill", async () => {
  const migrations = await loadMigrationFiles();
  const pwIdx = migrations.findIndex((m) => m.name === PAUSE_WINDOWS_MIGRATION_NAME);
  assert.ok(pwIdx > 0, `Migration ${PAUSE_WINDOWS_MIGRATION_NAME} must exist`);
  const groupsIdx = migrations.findIndex(
    (m) => m.name === PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  );
  const pwSql = migrations[pwIdx].sql;

  // Migration hygiene checks
  assert.equal(pwSql.includes("\r\n"), false, "Migration must use LF line endings");
  assert.equal(pwSql.replace(/--[^\n]*/g, "").includes("@"), false, "SQL must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(pwSql), false, "Migration must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(pwSql), false, "Migration must contain zero '40001'");
  assert.equal(/alter default privileges/i.test(pwSql), false, "Migration must contain zero ALTER DEFAULT PRIVILEGES");

  const engine = await createEngine();
  try {
    await engine.exec(ROLE_PREAMBLE);
    for (let i = 0; i < groupsIdx; i += 1) {
      await engine.exec(migrations[i].sql);
    }
    await seedLegacyAdmin(engine, OWNER);
    await seedLegacyAdmin(engine, LUANPT);
    await seedLegacyAdmin(engine, LIENVU);
    await seedLegacyAdmin(engine, NGATTT);

    const plan = await runWp5Cutover(engine, { mode: "read-only-plan" });
    const applied = await runWp5Cutover(engine, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    // Apply all migrations strictly BEFORE pause-windows migration
    for (let i = groupsIdx; i < pwIdx; i += 1) {
      await engine.exec(migrations[i].sql);
    }

    await engine.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'PW_PRE_A', 'Đội Pre A', true, 1)",
      [TEAM_A],
    );
    const { rows: [mktDept] } = await engine.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );
    await seedEmployee(engine, EMP_PRE_AUDIT, mktDept.department_id, TEAM_A);
    await seedEmployee(engine, EMP_PRE_NO_AUDIT, mktDept.department_id, TEAM_A);
    await seedEmployee(engine, EMP_PRE_ACTIVE_CLOSED, mktDept.department_id, TEAM_A);
    await seedEmployee(engine, EMP_PRE_AMBIG_ACTIVE, mktDept.department_id, TEAM_A);
    await seedEmployee(engine, EMP_PRE_SAME_TS_CHAIN, mktDept.department_id, TEAM_A);
    await seedEmployee(engine, EMP_PRE_TRUNC_AMBIG, mktDept.department_id, TEAM_A);

    const { rows: [{ today_vn: todayVn }] } = await engine.query(
      "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
    );
    const D_M6 = addDaysIso(todayVn, -6);
    const D_M5 = addDaysIso(todayVn, -5);
    const D_M4 = addDaysIso(todayVn, -4);
    const D_M3 = addDaysIso(todayVn, -3);
    const D_M2 = addDaysIso(todayVn, -2);
    const D_M1 = addDaysIso(todayVn, -1);

    const insertHistoricalAudit = async (templateId, assignmentId, events) => {
      for (const ev of events) {
        if (ev.id) {
          await engine.query(
            `insert into public.work_report_audit_events (
               audit_event_id, action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json, created_at
             ) values (
               $6::uuid, 'ASSIGNMENT_STATE', $1::uuid, 'report_assign', 'all', $2::uuid, 'APPLIED',
               jsonb_build_object('assignment_id', $3::uuid, 'state', $4::text), $5::timestamptz
             )`,
            [OWNER.app, templateId, assignmentId, ev.st, ev.ts, ev.id],
          );
        } else {
          await engine.query(
            `insert into public.work_report_audit_events (
               action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json, created_at
             ) values (
               'ASSIGNMENT_STATE', $1::uuid, 'report_assign', 'all', $2::uuid, 'APPLIED',
               jsonb_build_object('assignment_id', $3::uuid, 'state', $4::text), $5::timestamptz
             )`,
            [OWNER.app, templateId, assignmentId, ev.st, ev.ts],
          );
        }
      }
    };

    // Pre-upgrade Case A: Assignment paused before migration with BOTH a closed stretch [D_M4, D_M3)
    // AND a currently-open stretch starting at D_M3 17:30Z (= 00:30+07 on D_M2, cross-UTC-day VN boundary!),
    // plus a redundant consecutive PAUSED at D_M1 that must collapse into the D_M2 stretch.
    const tplPreA = await createPublishedTemplate(engine, "PW_PRE_AUD", "Pre-Upgrade Audit");
    const asgnPreAudit = await createUserAssignment(engine, tplPreA.template_id, EMP_PRE_AUDIT.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date, state = 'PAUSED', version = 5 where assignment_id = $1::uuid",
      [asgnPreAudit.assignment_id, D_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnPreAudit.assignment_id],
    );
    await insertHistoricalAudit(tplPreA.template_id, asgnPreAudit.assignment_id, [
      { st: "PAUSED", ts: `${D_M4} 10:00:00+07` },
      { st: "ACTIVE", ts: `${D_M3} 10:00:00+07` },
      // 17:30 UTC on D_M3 === 00:30+07 on D_M2 (cross-UTC-day VN boundary!)
      { st: "PAUSED", ts: `${D_M3} 17:30:00+00` },
      { st: "PAUSED", ts: `${D_M1} 09:00:00+07` },
    ]);

    // Pre-upgrade Case B: Assignment with state = 'PAUSED' and ZERO audit evidence (must NOT fabricate)
    const tplPreB = await createPublishedTemplate(engine, "PW_PRE_NOAUD", "Pre-Upgrade No Audit");
    const asgnPreNoAudit = await createUserAssignment(engine, tplPreB.template_id, EMP_PRE_NO_AUDIT.app);
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnPreNoAudit.assignment_id],
    );
    await engine.query(
      "update public.work_report_assignments set state = 'PAUSED', version = 2 where assignment_id = $1::uuid",
      [asgnPreNoAudit.assignment_id],
    );

    // Pre-upgrade Case C1: Already ACTIVE at upgrade time with closed pause window [D_M4, D_M3)
    // inside 7-day lookback -> D_M4 MUST NOT be backfilled post-upgrade.
    const tplPreC1 = await createPublishedTemplate(engine, "PW_PRE_ACT1", "Pre-Upgrade Active Closed");
    const asgnPreActiveClosed = await createUserAssignment(engine, tplPreC1.template_id, EMP_PRE_ACTIVE_CLOSED.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnPreActiveClosed.assignment_id, D_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnPreActiveClosed.assignment_id],
    );
    await insertHistoricalAudit(tplPreC1.template_id, asgnPreActiveClosed.assignment_id, [
      { st: "PAUSED", ts: `${D_M4} 11:00:00+07` },
      { st: "ACTIVE", ts: `${D_M3} 08:30:00+07` },
    ]);

    // Pre-upgrade Case C2: Already ACTIVE at upgrade time with closed pause window [D_M4, D_M3)
    // AND a pre-existing obligation created on D_M4 BEFORE pausing -> must stay 100% intact!
    const tplPreC2 = await createPublishedTemplate(engine, "PW_PRE_ACT2", "Pre-Upgrade Active Existing Ob");
    const asgnPreActiveExisting = await createUserAssignment(engine, tplPreC2.template_id, EMP_PRE_ACTIVE_CLOSED.app, {
      dueDayOffset: 10,
      dueTimeLocal: "23:59:59",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnPreActiveExisting.assignment_id, D_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnPreActiveExisting.assignment_id],
    );
    await engine.query(
      "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
      [asgnPreActiveExisting.assignment_id, D_M4],
    );
    const [preC2ObD4] = await fetchAssignmentObligations(engine, asgnPreActiveExisting.assignment_id);
    assert.equal(preC2ObD4.period_start_date, D_M4);
    await engine.serviceRpc("work_report_submit", [
      EMP_PRE_ACTIVE_CLOSED.auth, EMP_PRE_ACTIVE_CLOSED.app, preC2ObD4.obligation_id,
      JSON.stringify({ calls_made: 77 }), null, nextKey("pre-c2-sub"),
    ]);
    const [preC2SnapshotD4] = await fetchAssignmentObligations(engine, asgnPreActiveExisting.assignment_id);
    await insertHistoricalAudit(tplPreC2.template_id, asgnPreActiveExisting.assignment_id, [
      { st: "PAUSED", ts: `${D_M4} 15:00:00+07` },
      { st: "ACTIVE", ts: `${D_M3} 09:00:00+07` },
    ]);

    // Pre-upgrade Case D: Ambiguous audit — ACTIVE assignment with an earlier paired [D_M4, D_M3)
    // PLUS an unpaired trailing PAUSED audit event on D_M1 (missing resume audit).
    // Must backfill [D_M4, D_M3) ONLY and NEVER insert an open window that permanently locks out ACTIVE!
    const tplPreD = await createPublishedTemplate(engine, "PW_PRE_AMBIG", "Pre-Upgrade Ambiguous Active");
    const asgnPreAmbigActive = await createUserAssignment(engine, tplPreD.template_id, EMP_PRE_AMBIG_ACTIVE.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnPreAmbigActive.assignment_id, D_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnPreAmbigActive.assignment_id],
    );
    await insertHistoricalAudit(tplPreD.template_id, asgnPreAmbigActive.assignment_id, [
      { st: "PAUSED", ts: `${D_M4} 10:00:00+07` },
      { st: "ACTIVE", ts: `${D_M3} 10:00:00+07` },
      { st: "PAUSED", ts: `${D_M1} 14:00:00+07` },
    ]);

    // Pre-upgrade Case E: Same-created_at PAUSED + ACTIVE on D_M4 where ACTIVE UUID sorts BEFORE PAUSED UUID
    // (00000000-... < ffffffff-...), preceded by deterministic closed [D_M6, D_M5) and followed by clean PAUSED on D_M2
    // (while a.state = 'PAUSED'). Must treat D_M4 as AMBIGUOUS barrier, keep [D_M6, D_M5), start open window at D_M2
    // (NOT D_M4!), and flag CONFLICTING_SAME_TIMESTAMP_BUCKET.
    const tplPreE = await createPublishedTemplate(engine, "PW_PRE_SAMETS", "Pre-Upgrade Same-TS Ambiguous");
    const asgnSameTs = await createUserAssignment(engine, tplPreE.template_id, EMP_PRE_SAME_TS_CHAIN.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date, state = 'PAUSED', version = 6 where assignment_id = $1::uuid",
      [asgnSameTs.assignment_id, D_M6],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnSameTs.assignment_id],
    );
    await insertHistoricalAudit(tplPreE.template_id, asgnSameTs.assignment_id, [
      { st: "PAUSED", ts: `${D_M6} 09:00:00+07` },
      { st: "ACTIVE", ts: `${D_M5} 09:00:00+07` },
      { st: "ACTIVE", ts: `${D_M4} 12:00:00+07`, id: "00000000-0000-4000-8000-000000000001" },
      { st: "PAUSED", ts: `${D_M4} 12:00:00+07`, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      { st: "PAUSED", ts: `${D_M2} 10:00:00+07` },
    ]);

    // Pre-upgrade Case F: Deterministic PAUSED on D_M5 truncated by an AMBIGUOUS same-timestamp D_M4
    // (ACTIVE + PAUSED) followed by D_M2 ACTIVE. Must NOT bridge D_M5 across D_M4 to D_M2 and must flag
    // BOTH CONFLICTING_SAME_TIMESTAMP_BUCKET and PAUSE_TRUNCATED_BY_AMBIGUOUS_BUCKET.
    const tplPreF = await createPublishedTemplate(engine, "PW_PRE_TRUNC", "Pre-Upgrade Truncated Ambiguous");
    const asgnTruncAmbig = await createUserAssignment(engine, tplPreF.template_id, EMP_PRE_TRUNC_AMBIG.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnTruncAmbig.assignment_id, D_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnTruncAmbig.assignment_id],
    );
    await insertHistoricalAudit(tplPreF.template_id, asgnTruncAmbig.assignment_id, [
      { st: "PAUSED", ts: `${D_M5} 10:00:00+07` },
      { st: "ACTIVE", ts: `${D_M4} 12:00:00+07`, id: "00000000-0000-4000-8000-000000000002" },
      { st: "PAUSED", ts: `${D_M4} 12:00:00+07`, id: "ffffffff-ffff-4fff-8fff-fffffffffff2" },
      { st: "ACTIVE", ts: `${D_M2} 10:00:00+07` },
    ]);

    // Execute the exact embedded read-only preflight query from Section 2 comment block BEFORE migration apply
    const preflightMatch = pwSql.match(
      /--   with state_buckets as \([\s\S]*?--   order by diagnostic_kind, assignment_id, event_at nulls first;/,
    );
    assert.ok(preflightMatch, "Migration Section 2 must embed the read-only preflight diagnostic query");
    const preflightSql = preflightMatch[0].replace(/^-- {3}/gm, "");
    await engine.exec("begin transaction read only;");
    const { rows: preflightRows } = await engine.query(preflightSql);
    await engine.exec("commit;");
    const hasPreflightRow = (kind, assignmentId, detailSubstr) =>
      preflightRows.some(
        (r) =>
          r.diagnostic_kind === kind &&
          String(r.assignment_id) === assignmentId &&
          String(r.detail).includes(detailSubstr),
      );
    assert.equal(
      hasPreflightRow("CONFLICTING_SAME_TIMESTAMP_BUCKET", asgnSameTs.assignment_id, "states=ACTIVE,PAUSED"),
      true,
      "Preflight query must detect same-timestamp conflict on Case E",
    );
    assert.equal(
      hasPreflightRow("CONFLICTING_SAME_TIMESTAMP_BUCKET", asgnTruncAmbig.assignment_id, "states=ACTIVE,PAUSED"),
      true,
      "Preflight query must detect same-timestamp conflict on Case F",
    );
    assert.equal(
      hasPreflightRow("PAUSE_TRUNCATED_BY_AMBIGUOUS_BUCKET", asgnTruncAmbig.assignment_id, `paused_date=${D_M5}`),
      true,
      "Preflight query must detect pause truncated by ambiguous bucket on Case F",
    );
    assert.equal(
      hasPreflightRow("PAUSED_WITHOUT_AUTHORITATIVE_OPEN_WINDOW", asgnPreNoAudit.assignment_id, "current_state=PAUSED"),
      true,
      "Preflight query must detect PAUSED without audit evidence on Case B",
    );
    assert.equal(
      hasPreflightRow("ACTIVE_WITH_UNPAIRED_TRAILING_PAUSE", asgnPreAmbigActive.assignment_id, `paused_date=${D_M1}`),
      true,
      "Preflight query must detect ACTIVE with unpaired trailing PAUSED on Case D",
    );

    // Pre-migration S0-T1-C security baseline + function snapshot
    const s0Sql = migrations.find((m) => m.name === S0_T1_C_MIGRATION_NAME).sql;
    const preFlags = new Map(migrations.slice(0, pwIdx).map((m) => [m.name, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);

    const inspectFns = async () => {
      const { rows } = await engine.query(
        `select p.oid::regprocedure::text as sig,
                pg_catalog.pg_get_functiondef(p.oid) as def,
                p.proowner,
                p.prosecdef,
                p.provolatile,
                p.proconfig,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
           from pg_catalog.pg_proc p
          where p.oid = any($1::regprocedure[])
          order by sig asc`,
        [INSPECTED_FNS],
      );
      return rows;
    };
    const preMeta = await inspectFns();

    // Atomic rollback leaves zero drift
    const stripped = pwSql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await engine.exec("begin;");
    await engine.exec(stripped);
    await engine.exec("rollback;");

    const { rows: [tblAfterRollback] } = await engine.query(
      "select to_regclass('public.work_report_assignment_pause_windows') as reg",
    );
    assert.equal(tblAfterRollback.reg, null, "Atomic rollback must drop pause_windows table");
    assert.deepEqual(await inspectFns(), preMeta, "Atomic rollback must leave all RPCs untouched");

    // Apply migration cleanly and capture apply-time diagnostic RAISE NOTICE messages
    const migrationNotices = [];
    await engine.exec(pwSql, { onNotice: (notice) => migrationNotices.push(String(notice?.message ?? "")) });
    const hasNotice = (kind, assignmentId, detailSubstr) =>
      migrationNotices.some(
        (msg) =>
          msg.includes("WP10-6 pause-windows audit diagnostic:") &&
          msg.includes(`kind=${kind}`) &&
          msg.includes(`assignment_id=${assignmentId}`) &&
          msg.includes(detailSubstr),
      );
    assert.equal(
      hasNotice("CONFLICTING_SAME_TIMESTAMP_BUCKET", asgnSameTs.assignment_id, "detail=states=ACTIVE,PAUSED"),
      true,
      `Apply-time NOTICE must report Case E conflicting same-timestamp bucket; got: ${migrationNotices.join(" | ")}`,
    );
    assert.equal(
      hasNotice("CONFLICTING_SAME_TIMESTAMP_BUCKET", asgnTruncAmbig.assignment_id, "detail=states=ACTIVE,PAUSED"),
      true,
      "Apply-time NOTICE must report Case F conflicting same-timestamp bucket",
    );
    assert.equal(
      hasNotice("PAUSE_TRUNCATED_BY_AMBIGUOUS_BUCKET", asgnTruncAmbig.assignment_id, `paused_date=${D_M5}`),
      true,
      "Apply-time NOTICE must report Case F pause truncated by ambiguous bucket",
    );
    assert.equal(
      hasNotice("PAUSED_WITHOUT_AUTHORITATIVE_OPEN_WINDOW", asgnPreNoAudit.assignment_id, "current_state=PAUSED"),
      true,
      "Apply-time NOTICE must report Case B PAUSED without authoritative open window",
    );
    assert.equal(
      hasNotice("ACTIVE_WITH_UNPAIRED_TRAILING_PAUSE", asgnPreAmbigActive.assignment_id, `paused_date=${D_M1}`),
      true,
      "Apply-time NOTICE must report Case D ACTIVE with unpaired trailing pause",
    );

    // Post-migration S0-T1-C allowlist (+0 net public/service_role RPCs)
    const postFlags = new Map([...preFlags, [PAUSE_WINDOWS_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(
      postCheck.details.actualServiceCount,
      preCheck.details.actualServiceCount,
      "Exact +0 net service_role RPCs",
    );
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "Zero client/PUBLIC EXECUTE grants");

    // Verify table RLS, forced RLS, owner alignment, 0 privileges, & constraints
    const { rows: [tblInfo] } = await engine.query(
      `select c.relrowsecurity,
              c.relforcerowsecurity,
              c.relowner = (select relowner from pg_catalog.pg_class where oid = 'public.work_report_assignments'::regclass) as owner_aligned,
              pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
              pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
              pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') as svc_sel,
              pg_catalog.has_table_privilege('public', c.oid, 'SELECT') as pub_sel
         from pg_catalog.pg_class c
        where c.oid = 'public.work_report_assignment_pause_windows'::regclass`,
    );
    assert.equal(tblInfo.relrowsecurity, true);
    assert.equal(tblInfo.relforcerowsecurity, true);
    assert.equal(tblInfo.owner_aligned, true);
    assert.equal(tblInfo.anon_sel, false);
    assert.equal(tblInfo.auth_sel, false);
    assert.equal(tblInfo.svc_sel, false);
    assert.equal(tblInfo.pub_sel, false);

    // Verify STABLE volatility on candidate helper and nav probe
    const postMeta = await inspectFns();
    const bySig = Object.fromEntries(postMeta.map((m) => [m.sig, m]));
    assert.equal(bySig["work_report__internal_actor_materialization_candidates(uuid,date,integer)"].provolatile, "s");
    assert.equal(bySig["work_report_has_active_obligations(uuid,uuid)"].provolatile, "s");
    assert.equal(bySig["work_report__internal_actor_materialization_candidates(uuid,date,integer)"].svc_exec, false);
    assert.equal(bySig["work_report__internal_materialize_actor_obligations(uuid,date,integer)"].svc_exec, false);
    assert.equal(bySig["work_report__internal_materialize_assignment_for_date(uuid,date)"].svc_exec, false);
    assert.equal(bySig["work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)"].svc_exec, true);
    assert.equal(bySig["work_report_ensure_obligations_for_window(uuid,uuid,date)"].svc_exec, true);
    assert.equal(bySig["work_report_archive_template(uuid,uuid,uuid,integer,text)"].svc_exec, true);

    // Verify CHECK constraint (resumed_date >= paused_date) and partial unique index (only 1 open window)
    await assert.rejects(
      () =>
        engine.query(
          `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
           values ($1::uuid, $2::date, $3::date)`,
          [asgnPreAudit.assignment_id, todayVn, D_M1],
        ),
      (err) => err?.code === "23514",
      "CHECK constraint must reject resumed_date < paused_date",
    );
    await assert.rejects(
      () =>
        engine.query(
          `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
           values ($1::uuid, $2::date, null)`,
          [asgnPreAudit.assignment_id, todayVn],
        ),
      (err) => err?.code === "23505",
      "Partial unique index must reject 2nd open pause window on same assignment",
    );

    // Verify Pre-Upgrade Backfill Case A: BOTH closed [D_M4, D_M3) AND open [D_M2, NULL) (17:30Z -> VN D_M2)!
    const preAuditWindows = await fetchPauseWindows(engine, asgnPreAudit.assignment_id);
    assert.deepEqual(
      preAuditWindows.map((w) => [w.paused_date, w.resumed_date]),
      [
        [D_M4, D_M3],
        [D_M2, null],
      ],
      "Backfill must reconstruct closed [D_M4, D_M3) AND open [D_M2, NULL) (17:30Z on D_M3 -> VN D_M2, collapsing consecutive D_M1 PAUSED)",
    );

    // Reactivate Case A on todayVn -> closes [D_M2, todayVn), excludes BOTH D_M4 and D_M2..D_M1 -> exact [D_M5, D_M3, todayVn]!
    const reactA = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnPreAudit.assignment_id, 5, "ACTIVE", nextKey("pre-a-react"),
    ]);
    assert.equal(reactA.state, "ACTIVE");
    const preAuditWindowsAfter = await fetchPauseWindows(engine, asgnPreAudit.assignment_id);
    assert.deepEqual(
      preAuditWindowsAfter.map((w) => [w.paused_date, w.resumed_date]),
      [
        [D_M4, D_M3],
        [D_M2, todayVn],
      ],
    );

    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, D_M4]);
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_PRE_AUDIT.auth, EMP_PRE_AUDIT.app, null]);
    const obsA = await fetchAssignmentObligations(engine, asgnPreAudit.assignment_id);
    assert.deepEqual(
      obsA.map((r) => r.period_start_date),
      [D_M5, D_M3, todayVn],
      "Backfilled closed [D_M4, D_M3) + open [D_M2, todayVn) must yield exact [D_M5, D_M3, todayVn] (D_M4, D_M2, D_M1 excluded)",
    );

    // Verify Pre-Upgrade Backfill Case B (no audit evidence -> 0 fabricated rows, graceful reactivation!)
    const preNoAuditWindows = await fetchPauseWindows(engine, asgnPreNoAudit.assignment_id);
    assert.equal(preNoAuditWindows.length, 0, "Must NEVER fabricate paused_date when audit evidence is absent");

    const reactB = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnPreNoAudit.assignment_id, 2, "ACTIVE", nextKey("pre-b-react"),
    ]);
    assert.equal(reactB.state, "ACTIVE");
    assert.equal(reactB.version, 3);
    assert.equal((await fetchPauseWindows(engine, asgnPreNoAudit.assignment_id)).length, 0);
    const obsB = await fetchAssignmentObligations(engine, asgnPreNoAudit.assignment_id);
    assert.deepEqual(obsB.map((r) => r.period_start_date), [todayVn]);

    // Verify Pre-Upgrade Backfill Case C1 & C2 (already ACTIVE at upgrade time with closed [D_M4, D_M3)):
    // - C1: D_M4 NOT backfilled on list_my_obligations / ensure; [D_M5, D_M3, D_M2, D_M1, todayVn] materialized
    // - C2: Pre-existing obligation created on D_M4 before pausing stays 100% untouched!
    assert.deepEqual(
      (await fetchPauseWindows(engine, asgnPreActiveClosed.assignment_id)).map((w) => [w.paused_date, w.resumed_date]),
      [[D_M4, D_M3]],
      "Pre-upgrade ACTIVE assignment must backfill closed pause window [D_M4, D_M3)",
    );
    assert.deepEqual(
      (await fetchPauseWindows(engine, asgnPreActiveExisting.assignment_id)).map((w) => [w.paused_date, w.resumed_date]),
      [[D_M4, D_M3]],
    );

    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, D_M4]);
    assert.equal(
      (await fetchAssignmentObligations(engine, asgnPreActiveClosed.assignment_id)).length,
      0,
      "ensure_obligations_for_window(D_M4) must NOT backfill closed pre-upgrade pause day D_M4",
    );

    await assertReadOnlyProbeParity(engine, EMP_PRE_ACTIVE_CLOSED, true, "Pre-upgrade ACTIVE closed window");
    const obsC1 = await fetchAssignmentObligations(engine, asgnPreActiveClosed.assignment_id);
    assert.deepEqual(
      obsC1.map((r) => r.period_start_date),
      [D_M5, D_M3, D_M2, D_M1, todayVn],
      "Already-ACTIVE assignment must skip closed pre-upgrade D_M4 while materializing D_M5, D_M3..todayVn",
    );

    const obsC2 = await fetchAssignmentObligations(engine, asgnPreActiveExisting.assignment_id);
    const obsC2D4 = obsC2.find((r) => r.period_start_date === D_M4);
    assert.deepEqual(
      obsC2D4,
      preC2SnapshotD4,
      "Pre-existing obligation created on D_M4 before pausing must remain 100% intact after closed-window backfill",
    );

    // Verify Pre-Upgrade Backfill Case D (ambiguous ACTIVE with unpaired trailing PAUSED event):
    // - Earlier paired [D_M4, D_M3) is backfilled; ZERO open window inserted (no permanent lockout!)
    const ambigWindows = await fetchPauseWindows(engine, asgnPreAmbigActive.assignment_id);
    assert.deepEqual(
      ambigWindows.map((w) => [w.paused_date, w.resumed_date]),
      [[D_M4, D_M3]],
      "ACTIVE assignment with unpaired trailing PAUSED audit must NOT get an open pause window",
    );
    await assertReadOnlyProbeParity(engine, EMP_PRE_AMBIG_ACTIVE, true, "Pre-upgrade ambiguous ACTIVE not locked out");
    const obsD = await fetchAssignmentObligations(engine, asgnPreAmbigActive.assignment_id);
    assert.deepEqual(
      obsD.map((r) => r.period_start_date),
      [D_M5, D_M3, D_M2, D_M1, todayVn],
      "ACTIVE assignment with unpaired trailing PAUSED audit remains active on D_M1 & todayVn while still excluding paired [D_M4, D_M3)",
    );

    // Verify Pre-Upgrade Backfill Case E (same-timestamp D_M4 ACTIVE+PAUSED with ACTIVE UUID < PAUSED UUID,
    // preceded by closed [D_M6, D_M5) and followed by clean PAUSED on D_M2):
    // - Open window MUST start at D_M2 (NOT D_M4!), closed [D_M6, D_M5) preserved!
    const sameTsWindows = await fetchPauseWindows(engine, asgnSameTs.assignment_id);
    assert.deepEqual(
      sameTsWindows.map((w) => [w.paused_date, w.resumed_date]),
      [
        [D_M6, D_M5],
        [D_M2, null],
      ],
      "Same-timestamp D_M4 AMBIGUOUS bucket must NOT corrupt open pause window start (must be D_M2, keeping closed [D_M6, D_M5))",
    );
    const reactE = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnSameTs.assignment_id, 6, "ACTIVE", nextKey("pre-e-react"),
    ]);
    assert.equal(reactE.state, "ACTIVE");
    assert.deepEqual(
      (await fetchPauseWindows(engine, asgnSameTs.assignment_id)).map((w) => [w.paused_date, w.resumed_date]),
      [
        [D_M6, D_M5],
        [D_M2, todayVn],
      ],
    );
    await engine.serviceRpc("work_report_list_my_obligations", [
      EMP_PRE_SAME_TS_CHAIN.auth, EMP_PRE_SAME_TS_CHAIN.app, null,
    ]);
    const obsE = await fetchAssignmentObligations(engine, asgnSameTs.assignment_id);
    assert.deepEqual(
      obsE.map((r) => r.period_start_date),
      [D_M5, D_M4, D_M3, todayVn],
      "Reactivating Case E must materialize D_M5, D_M4, D_M3, todayVn (zero corruption of D_M3 by D_M4; D_M6, D_M2, D_M1 excluded)",
    );

    // Verify Pre-Upgrade Backfill Case F (deterministic PAUSED D_M5 truncated by AMBIGUOUS D_M4, followed by ACTIVE D_M2):
    // - Must NOT bridge D_M5 across D_M4 to D_M2 and must NOT fabricate any pause window!
    const truncWindows = await fetchPauseWindows(engine, asgnTruncAmbig.assignment_id);
    assert.equal(
      truncWindows.length,
      0,
      "Migration must NOT bridge D_M5 PAUSED across ambiguous D_M4 bucket to D_M2 ACTIVE",
    );
    await engine.serviceRpc("work_report_list_my_obligations", [
      EMP_PRE_TRUNC_AMBIG.auth, EMP_PRE_TRUNC_AMBIG.app, null,
    ]);
    const obsF = await fetchAssignmentObligations(engine, asgnTruncAmbig.assignment_id);
    assert.deepEqual(
      obsF.map((r) => r.period_start_date),
      [D_M5, D_M4, D_M3, D_M2, D_M1, todayVn],
      "Case F must not silently drop dates via fabricated bridge across ambiguous D_M4",
    );
  } finally {
    await engine.close();
  }
});

test("WP10-6 PW #2 (PGlite): PW-01 single pause window + valid backfill & PW-02 preserve existing obligations/submissions/snapshots", async () => {
  const { engine, todayVn } = await bootstrapFullDb([
    { user: EMP_PW01 },
    { user: EMP_PW02 },
  ]);
  try {
    // -------------------------------------------------------------------------
    // PW-01: DAILY active at D0 (unmaterialized) -> PAUSED D1..D2 -> ACTIVE D3
    // -------------------------------------------------------------------------
    const D3 = todayVn;
    const D2 = addDaysIso(D3, -1);
    const D1 = addDaysIso(D3, -2);
    const D0 = addDaysIso(D3, -3);

    const tpl01 = await createPublishedTemplate(engine, "PW01_DAILY", "PW-01 Daily");
    const asgn01 = await createUserAssignment(engine, tpl01.template_id, EMP_PW01.app);
    // Simulate assignment active since D0 with D0 still unmaterialized
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgn01.assignment_id, D0],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgn01.assignment_id],
    );

    // Pause and backdate paused_date to D1 (simulating pause taken on D1)
    const paused01 = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn01.assignment_id, 1, "PAUSED", nextKey("pw01-pause"),
    ]);
    assert.equal(paused01.state, "PAUSED");
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
      [asgn01.assignment_id, D1],
    );

    // While PAUSED during D1..D2: ensure & list produce 0 rows; READ ONLY probe = false
    for (const d of [D1, D2]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, d]);
      await engine.query(
        "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
        [asgn01.assignment_id, d],
      );
    }
    await assertReadOnlyProbeParity(engine, EMP_PW01, false, "PW-01 while PAUSED");
    assert.equal((await fetchAssignmentObligations(engine, asgn01.assignment_id)).length, 0);

    // Reactivate at D3 (todayVn): closes window [D1, D3) & immediately materializes D3
    const react01 = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn01.assignment_id, 2, "ACTIVE", nextKey("pw01-resume"),
    ]);
    assert.equal(react01.state, "ACTIVE");
    assert.equal(react01.version, 3);
    const pw01Rows = await fetchPauseWindows(engine, asgn01.assignment_id);
    assert.equal(pw01Rows.length, 1);
    assert.equal(pw01Rows[0].paused_date, D1);
    assert.equal(pw01Rows[0].resumed_date, D3);

    const immediateAfterReact = await fetchAssignmentObligations(engine, asgn01.assignment_id);
    assert.deepEqual(
      immediateAfterReact.map((r) => r.period_start_date),
      [D3],
      "Reactivation immediately materializes D3",
    );

    // Personal list triggers 7-day lookback: validly backfills D0, skips D1 & D2 (zero fake overdue!)
    const list01 = await assertReadOnlyProbeParity(engine, EMP_PW01, true, "PW-01 post-resume");
    const obs01 = await fetchAssignmentObligations(engine, asgn01.assignment_id);
    assert.deepEqual(
      obs01.map((r) => r.period_start_date),
      [D0, D3],
      "PW-01 must backfill D0, skip D1..D2, and keep D3",
    );
    assert.deepEqual(
      list01.map((r) => r.period_start_date).sort(),
      [D0, D3],
    );

    // Even explicit ensure / internal materialize for paused dates D1 & D2 after resume produce 0 rows
    for (const d of [D1, D2]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, d]);
      const { rows: [{ cnt }] } = await engine.query(
        "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date) as cnt",
        [asgn01.assignment_id, d],
      );
      assert.equal(cnt, 0, `Paused date ${d} must remain excluded from direct materialization after resume`);
    }
    assert.deepEqual((await fetchAssignmentObligations(engine, asgn01.assignment_id)).map((r) => r.period_start_date), [D0, D3]);

    // -------------------------------------------------------------------------
    // PW-02: Preserve existing NOT_STARTED, DRAFT, SUBMITTED, APPROVED, REJECTED,
    //        due_at, snapshots, revisions, & prior audit events untouched
    // -------------------------------------------------------------------------
    const tpl02 = await createPublishedTemplate(engine, "PW02_PRESERVE", "PW-02 Preserve", {
      frequency: "DAILY",
      requiresReview: true,
    });
    const P_M5 = addDaysIso(todayVn, -5);
    const P_M4 = addDaysIso(todayVn, -4);
    const P_M3 = addDaysIso(todayVn, -3);
    const P_M2 = addDaysIso(todayVn, -2);
    const P_M1 = addDaysIso(todayVn, -1);

    const asgn02 = await createUserAssignment(engine, tpl02.template_id, EMP_PW02.app, {
      dueDayOffset: 10,
      dueTimeLocal: "23:59:59",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgn02.assignment_id, P_M5],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid and period_start_date = $2::date",
      [asgn02.assignment_id, todayVn],
    );
    for (const d of [P_M5, P_M4, P_M3, P_M2, P_M1]) {
      await engine.query(
        "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
        [asgn02.assignment_id, d],
      );
    }
    const seedObs = await fetchAssignmentObligations(engine, asgn02.assignment_id);
    const byDate = Object.fromEntries(seedObs.map((r) => [r.period_start_date, r.obligation_id]));

    // P_M5 -> APPROVED
    const sApp = await engine.serviceRpc("work_report_submit", [
      EMP_PW02.auth, EMP_PW02.app, byDate[P_M5],
      JSON.stringify({ calls_made: 50 }), null, nextKey("pw02-app"),
    ]);
    await engine.serviceRpc("work_report_decide_review", [
      OWNER.auth, OWNER.app, byDate[P_M5], "APPROVED", null, sApp.version, nextKey("pw02-dec-app"),
    ]);
    // P_M4 -> REJECTED
    const sRej = await engine.serviceRpc("work_report_submit", [
      EMP_PW02.auth, EMP_PW02.app, byDate[P_M4],
      JSON.stringify({ calls_made: 40 }), null, nextKey("pw02-rej"),
    ]);
    await engine.serviceRpc("work_report_decide_review", [
      OWNER.auth, OWNER.app, byDate[P_M4], "REJECTED", "Cần bổ sung", sRej.version, nextKey("pw02-dec-rej"),
    ]);
    // P_M3 -> SUBMITTED (PENDING_REVIEW)
    await engine.serviceRpc("work_report_submit", [
      EMP_PW02.auth, EMP_PW02.app, byDate[P_M3],
      JSON.stringify({ calls_made: 30 }), null, nextKey("pw02-pend"),
    ]);
    // P_M2 -> DRAFT
    await engine.serviceRpc("work_report_save_draft", [
      EMP_PW02.auth, EMP_PW02.app, byDate[P_M2],
      JSON.stringify({ calls_made: 20 }), null, nextKey("pw02-draft"),
    ]);
    // P_M1 stays NOT_STARTED

    const beforeObs = await fetchAssignmentObligations(engine, asgn02.assignment_id);
    assert.deepEqual(
      beforeObs.map((r) => r.submission_state),
      ["APPROVED", "REJECTED", "PENDING_REVIEW", "DRAFT", "NOT_STARTED"],
    );
    const { rows: beforeRevs } = await engine.query(
      `select r.revision_id::text, r.submission_id::text, r.revision_no, r.payload_json
         from public.work_report_submission_revisions r
         join public.work_report_submissions s on s.submission_id = r.submission_id
         join public.work_report_obligations o on o.obligation_id = s.obligation_id
        where o.assignment_id = $1::uuid
        order by r.created_at asc, r.revision_id asc`,
      [asgn02.assignment_id],
    );
    const { rows: beforeAudits } = await engine.query(
      `select audit_event_id::text, action, outcome, metadata_json
         from public.work_report_audit_events
        where template_id = $1::uuid
        order by created_at asc, audit_event_id asc`,
      [tpl02.template_id],
    );

    // Pause -> verify all 5 rows untouched -> Resume -> verify all 5 rows still byte-for-byte untouched
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn02.assignment_id, 1, "PAUSED", nextKey("pw02-pause"),
    ]);
    assert.deepEqual(
      await fetchAssignmentObligations(engine, asgn02.assignment_id),
      beforeObs,
      "Pause must leave all pre-existing obligations/submissions/snapshots untouched",
    );

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn02.assignment_id, 2, "ACTIVE", nextKey("pw02-resume"),
    ]);
    const afterResumeObs = await fetchAssignmentObligations(engine, asgn02.assignment_id);
    const afterPriorFive = afterResumeObs.filter((r) => r.period_start_date !== todayVn);
    assert.deepEqual(
      afterPriorFive,
      beforeObs,
      "Resume must keep all 5 pre-existing obligations, due_at, snapshots & submissions 100% untouched",
    );
    assert.ok(afterResumeObs.some((r) => r.period_start_date === todayVn));

    const { rows: afterRevs } = await engine.query(
      `select r.revision_id::text, r.submission_id::text, r.revision_no, r.payload_json
         from public.work_report_submission_revisions r
         join public.work_report_submissions s on s.submission_id = r.submission_id
         join public.work_report_obligations o on o.obligation_id = s.obligation_id
        where o.assignment_id = $1::uuid
        order by r.created_at asc, r.revision_id asc`,
      [asgn02.assignment_id],
    );
    assert.deepEqual(afterRevs, beforeRevs, "Submission revisions must be 100% untouched");

    const { rows: afterAudits } = await engine.query(
      `select audit_event_id::text, action, outcome, metadata_json
         from public.work_report_audit_events
        where template_id = $1::uuid
        order by created_at asc, audit_event_id asc`,
      [tpl02.template_id],
    );
    assert.deepEqual(
      afterAudits.slice(0, beforeAudits.length),
      beforeAudits,
      "Prior audit history must remain 100% intact (append-only)",
    );
    assert.deepEqual(
      afterAudits.slice(beforeAudits.length).map((e) => e.metadata_json.state),
      ["PAUSED", "ACTIVE"],
    );
  } finally {
    await engine.close();
  }
});

test("WP10-6 PW #3 (PGlite): PW-03 same-day vs cross-midnight VN boundary & PW-04 multiple pause windows in 7-day lookback", async () => {
  const { engine, todayVn } = await bootstrapFullDb([
    { user: EMP_PW03_SAME },
    { user: EMP_PW03_MID },
    { user: EMP_PW04 },
  ]);
  try {
    // -------------------------------------------------------------------------
    // PW-03a: Same-day pause & resume on day D = todayVn -> [D, D) empty -> D active
    // -------------------------------------------------------------------------
    const tplSame = await createPublishedTemplate(engine, "PW03_SAME", "PW-03 Same Day");
    const asgnSame = await createUserAssignment(engine, tplSame.template_id, EMP_PW03_SAME.app);
    // Clear initial obligation to verify paused mid-day does NOT materialize, then resume DOES
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnSame.assignment_id],
    );

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnSame.assignment_id, 1, "PAUSED", nextKey("pw03s-p"),
    ]);
    const midDayWindows = await fetchPauseWindows(engine, asgnSame.assignment_id);
    assert.equal(midDayWindows.length, 1);
    assert.equal(midDayWindows[0].paused_date, todayVn);
    assert.equal(midDayWindows[0].resumed_date, null);

    // While paused mid-day: ensure & READ ONLY probe must not materialize/report active
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn]);
    await assertReadOnlyProbeParity(engine, EMP_PW03_SAME, false, "PW-03a mid-day paused");
    assert.equal((await fetchAssignmentObligations(engine, asgnSame.assignment_id)).length, 0);

    // Resume on same day D = todayVn -> [D, D) empty -> D IS active and materialized
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnSame.assignment_id, 2, "ACTIVE", nextKey("pw03s-r"),
    ]);
    const sameDayWindowsAfter = await fetchPauseWindows(engine, asgnSame.assignment_id);
    assert.equal(sameDayWindowsAfter.length, 1);
    assert.equal(sameDayWindowsAfter[0].paused_date, todayVn);
    assert.equal(sameDayWindowsAfter[0].resumed_date, todayVn);

    const sameDayObs = await fetchAssignmentObligations(engine, asgnSame.assignment_id);
    assert.deepEqual(
      sameDayObs.map((r) => r.period_start_date),
      [todayVn],
      "Same-day resume [D, D) must materialize D immediately",
    );
    await assertReadOnlyProbeParity(engine, EMP_PW03_SAME, true, "PW-03a same-day resumed");

    // -------------------------------------------------------------------------
    // PW-03b: Cross-midnight VN boundary (23:59+07 on D_YEST -> 00:01+07 on todayVn)
    // -------------------------------------------------------------------------
    const D_YEST = addDaysIso(todayVn, -1);
    const D_M2 = addDaysIso(todayVn, -2);
    const { rows: [tzCheck] } = await engine.query(
      `select (($1 || ' 23:59:00+07')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date::text as paused_vn,
              (($2 || ' 00:01:00+07')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date::text as resumed_vn`,
      [D_YEST, todayVn],
    );
    assert.equal(tzCheck.paused_vn, D_YEST);
    assert.equal(tzCheck.resumed_vn, todayVn);

    const tplMid = await createPublishedTemplate(engine, "PW03_MID", "PW-03 Cross Midnight");
    const asgnMid = await createUserAssignment(engine, tplMid.template_id, EMP_PW03_MID.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnMid.assignment_id, D_M2],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMid.assignment_id],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMid.assignment_id, 1, "PAUSED", nextKey("pw03m-p"),
    ]);
    // Stamp pause window as taken at 23:59+07 on D_YEST
    await engine.query(
      `update public.work_report_assignment_pause_windows
          set paused_date = (($2 || ' 23:59:00+07')::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date,
              created_at = ($2 || ' 23:59:00+07')::timestamptz
        where assignment_id = $1::uuid`,
      [asgnMid.assignment_id, D_YEST],
    );
    // Resume on todayVn (simulating 00:01+07 on D+1) -> closes [D_YEST, todayVn)
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMid.assignment_id, 2, "ACTIVE", nextKey("pw03m-r"),
    ]);
    const midWindows = await fetchPauseWindows(engine, asgnMid.assignment_id);
    assert.equal(midWindows[0].paused_date, D_YEST);
    assert.equal(midWindows[0].resumed_date, todayVn);

    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, D_YEST]);
    await assertReadOnlyProbeParity(engine, EMP_PW03_MID, true, "PW-03b cross-midnight resumed");
    const midObs = await fetchAssignmentObligations(engine, asgnMid.assignment_id);
    assert.deepEqual(
      midObs.map((r) => r.period_start_date),
      [D_M2, todayVn],
      "Cross-midnight VN [D_YEST, todayVn) must permanently exclude D_YEST while backfilling D_M2 and keeping todayVn",
    );

    // -------------------------------------------------------------------------
    // PW-04: Multiple pause windows within 7-day lookback
    //        ACTIVE D0 -> PAUSED D1 -> ACTIVE D2 -> PAUSED D3 -> ACTIVE D4
    // -------------------------------------------------------------------------
    const M_D4 = todayVn;
    const M_D3 = addDaysIso(M_D4, -1);
    const M_D2 = addDaysIso(M_D4, -2);
    const M_D1 = addDaysIso(M_D4, -3);
    const M_D0 = addDaysIso(M_D4, -4);

    const tplMulti = await createPublishedTemplate(engine, "PW04_MULTI", "PW-04 Multi Pause");
    const asgnMulti = await createUserAssignment(engine, tplMulti.template_id, EMP_PW04.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnMulti.assignment_id, M_D0],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMulti.assignment_id],
    );

    // Window 1: [M_D1, M_D2) closed
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMulti.assignment_id, 1, "PAUSED", nextKey("pw04-p1"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid and resumed_date is null",
      [asgnMulti.assignment_id, M_D1],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMulti.assignment_id, 2, "ACTIVE", nextKey("pw04-r1"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set resumed_date = $2::date where assignment_id = $1::uuid and paused_date = $3::date",
      [asgnMulti.assignment_id, M_D2, M_D1],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMulti.assignment_id],
    );

    // Window 2: [M_D3, M_D4) opened on M_D3, resumed on M_D4 (todayVn)
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMulti.assignment_id, 3, "PAUSED", nextKey("pw04-p2"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid and resumed_date is null",
      [asgnMulti.assignment_id, M_D3],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnMulti.assignment_id, 4, "ACTIVE", nextKey("pw04-r2"),
    ]);

    const multiWindows = await fetchPauseWindows(engine, asgnMulti.assignment_id);
    assert.deepEqual(
      multiWindows.map((w) => [w.paused_date, w.resumed_date]),
      [
        [M_D1, M_D2],
        [M_D3, M_D4],
      ],
    );

    // Clear M_D4 so READ ONLY probe proves candidate detection before list materialization
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMulti.assignment_id],
    );
    await assertReadOnlyProbeParity(engine, EMP_PW04, true, "PW-04 multi-window active candidates");

    // Ensure on paused dates M_D1 and M_D3 adds 0 rows
    for (const d of [M_D1, M_D3]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, d]);
    }
    const multiObs = await fetchAssignmentObligations(engine, asgnMulti.assignment_id);
    assert.deepEqual(
      multiObs.map((r) => r.period_start_date),
      [M_D0, M_D2, M_D4],
      "PW-04 must materialize ONLY [D0, D2, D4] with 0 rows on paused D1 and D3",
    );
  } finally {
    await engine.close();
  }
});

test("WP10-6 PW #4 (PGlite): PW-06 & PW-07 all 4 frequencies (WEEKLY, MONTHLY, ONCE) + TEAM/GROUP pause exclusion", async () => {
  const { engine, todayVn } = await bootstrapFullDb([
    { user: EMP_WEEKLY },
    { user: EMP_MONTHLY },
    { user: EMP_ONCE_UNMAT },
    { user: EMP_ONCE_MAT },
    { user: EMP_TEAM_B, teamId: TEAM_B },
    { user: EMP_GROUP },
  ]);
  try {
    // -------------------------------------------------------------------------
    // WEEKLY: (a) Full-week pause W1 -> resumed W2 (W1 NOT backfilled)
    //         (b) Mid-week partial pause inside W1 (W1 STILL materializes)
    // -------------------------------------------------------------------------
    const { rows: [w2] } = await engine.query(
      "select period_key, period_start_date::text as start_d, period_end_date::text as end_d from public.work_report_period('WEEKLY', $1::date)",
      [todayVn],
    );
    const { rows: [w1] } = await engine.query(
      "select period_key, period_start_date::text as start_d, period_end_date::text as end_d from public.work_report_period('WEEKLY', $1::date)",
      [addDaysIso(w2.start_d, -1)],
    );

    // (a) Full-week pause W1: [w1.start_d, w2.start_d)
    const tplWFull = await createPublishedTemplate(engine, "PW_W_FULL", "Weekly Full Pause", {
      frequency: "WEEKLY",
    });
    const asgnWFull = await createUserAssignment(engine, tplWFull.template_id, EMP_WEEKLY.app, {
      frequency: "WEEKLY",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnWFull.assignment_id, w1.start_d],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnWFull.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnWFull.assignment_id, w1.start_d, w2.start_d],
    );

    // Check every single day of W1 via ensure_obligations_for_window -> 0 rows!
    for (let offset = 0; offset < 7; offset += 1) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [
        OWNER.auth, OWNER.app, addDaysIso(w1.start_d, offset),
      ]);
    }
    assert.equal((await fetchAssignmentObligations(engine, asgnWFull.assignment_id)).length, 0);

    // 14-day lookback covering ALL of W1 + W2 -> ONLY W2 materialized, W1 NOT backfilled!
    await engine.query(
      "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 14)",
      [EMP_WEEKLY.app, todayVn],
    );
    const wFullObs = await fetchAssignmentObligations(engine, asgnWFull.assignment_id);
    assert.deepEqual(
      wFullObs.map((r) => r.period_key),
      [w2.period_key],
      "Full-week pause W1 must NOT backfill W1 after resuming in W2",
    );

    // (b) Mid-week partial pause inside W1: paused Wed..Fri [w1.start + 2, w1.start + 5)
    const tplWPart = await createPublishedTemplate(engine, "PW_W_PART", "Weekly Partial Pause", {
      frequency: "WEEKLY",
    });
    const asgnWPart = await createUserAssignment(engine, tplWPart.template_id, EMP_WEEKLY.app, {
      frequency: "WEEKLY",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnWPart.assignment_id, w1.start_d],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnWPart.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnWPart.assignment_id, addDaysIso(w1.start_d, 2), addDaysIso(w1.start_d, 5)],
    );

    // Ensure on paused Wednesday creates 0 rows
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [
      OWNER.auth, OWNER.app, addDaysIso(w1.start_d, 3),
    ]);
    assert.equal((await fetchAssignmentObligations(engine, asgnWPart.assignment_id)).length, 0);

    // Actor materializer over W1 (covering active Mon/Tue/Sat/Sun) DOES materialize W1!
    await engine.query(
      "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 7)",
      [EMP_WEEKLY.app, w1.end_d],
    );
    const wPartObs = await fetchAssignmentObligations(engine, asgnWPart.assignment_id);
    assert.deepEqual(
      wPartObs.map((r) => r.period_key),
      [w1.period_key],
      "Mid-week partial pause inside W1 must still materialize W1 because active days exist",
    );

    // -------------------------------------------------------------------------
    // MONTHLY: (a) Full-month pause M1 -> resumed M2 (M1 NOT backfilled)
    //          (b) Mid-month partial pause inside M1 (M1 STILL materializes)
    // -------------------------------------------------------------------------
    const { rows: [m2] } = await engine.query(
      "select period_key, period_start_date::text as start_d, period_end_date::text as end_d from public.work_report_period('MONTHLY', $1::date)",
      [todayVn],
    );
    const { rows: [m1] } = await engine.query(
      "select period_key, period_start_date::text as start_d, period_end_date::text as end_d from public.work_report_period('MONTHLY', $1::date)",
      [addDaysIso(m2.start_d, -1)],
    );

    // (a) Full-month pause M1: [m1.start_d, m2.start_d)
    const tplMFull = await createPublishedTemplate(engine, "PW_M_FULL", "Monthly Full Pause", {
      frequency: "MONTHLY",
    });
    const asgnMFull = await createUserAssignment(engine, tplMFull.template_id, EMP_MONTHLY.app, {
      frequency: "MONTHLY",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnMFull.assignment_id, m1.start_d],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMFull.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnMFull.assignment_id, m1.start_d, m2.start_d],
    );

    for (const d of [m1.start_d, addDaysIso(m1.start_d, 14), m1.end_d]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, d]);
    }
    assert.equal((await fetchAssignmentObligations(engine, asgnMFull.assignment_id)).length, 0);

    // 31-day lookback ending at m2.start_d covers ALL of M1 + start of M2 -> ONLY M2 materialized!
    await engine.query(
      "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 31)",
      [EMP_MONTHLY.app, m2.start_d],
    );
    const mFullObs = await fetchAssignmentObligations(engine, asgnMFull.assignment_id);
    assert.deepEqual(
      mFullObs.map((r) => r.period_key),
      [m2.period_key],
      "Full-month pause M1 must NOT backfill M1 after resuming in M2",
    );

    // (b) Mid-month partial pause inside M1: [m1.start + 5, m1.start + 15)
    const tplMPart = await createPublishedTemplate(engine, "PW_M_PART", "Monthly Partial Pause", {
      frequency: "MONTHLY",
    });
    const asgnMPart = await createUserAssignment(engine, tplMPart.template_id, EMP_MONTHLY.app, {
      frequency: "MONTHLY",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnMPart.assignment_id, m1.start_d],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnMPart.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnMPart.assignment_id, addDaysIso(m1.start_d, 5), addDaysIso(m1.start_d, 15)],
    );

    // Ensure inside pause window creates 0 rows
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [
      OWNER.auth, OWNER.app, addDaysIso(m1.start_d, 10),
    ]);
    assert.equal((await fetchAssignmentObligations(engine, asgnMPart.assignment_id)).length, 0);

    // Actor materializer over M1 DOES materialize M1 because active days exist in M1!
    await engine.query(
      "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 31)",
      [EMP_MONTHLY.app, m1.end_d],
    );
    const mPartObs = await fetchAssignmentObligations(engine, asgnMPart.assignment_id);
    assert.deepEqual(
      mPartObs.map((r) => r.period_key),
      [m1.period_key],
      "Mid-month partial pause inside M1 must still materialize M1",
    );

    // -------------------------------------------------------------------------
    // ONCE: (a) Unmaterialized ONCE paused D1..D2 skips paused days for first_eligible_date
    //       (b) Already-materialized ONCE singleton preserved with 0 duplicates
    // -------------------------------------------------------------------------
    const O_D3 = todayVn;
    const O_D2 = addDaysIso(O_D3, -1);
    const O_D1 = addDaysIso(O_D3, -2);

    const tplOnceUnmat = await createPublishedTemplate(engine, "PW_ONCE_UN", "ONCE Unmaterialized", {
      frequency: "ONCE",
    });
    const asgnOnceUnmat = await createUserAssignment(engine, tplOnceUnmat.template_id, EMP_ONCE_UNMAT.app, {
      frequency: "ONCE",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnOnceUnmat.assignment_id, O_D1],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnOnceUnmat.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnOnceUnmat.assignment_id, O_D1, O_D3],
    );

    for (const d of [O_D1, O_D2]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, d]);
    }
    assert.equal((await fetchAssignmentObligations(engine, asgnOnceUnmat.assignment_id)).length, 0);

    await assertReadOnlyProbeParity(engine, EMP_ONCE_UNMAT, true, "PW-07 ONCE unmaterialized skips paused days");
    const onceUnmatObs = await fetchAssignmentObligations(engine, asgnOnceUnmat.assignment_id);
    assert.equal(onceUnmatObs.length, 1);
    assert.equal(onceUnmatObs[0].period_key, `ONCE-${O_D3}`);
    assert.equal(onceUnmatObs[0].period_start_date, O_D3);

    // Subsequent ensure / list produces 0 duplicate rows
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, O_D3]);
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_ONCE_UNMAT.auth, EMP_ONCE_UNMAT.app, null]);
    assert.equal((await fetchAssignmentObligations(engine, asgnOnceUnmat.assignment_id)).length, 1);

    // (b) Already-materialized ONCE singleton preserved across pause & resume
    const tplOnceMat = await createPublishedTemplate(engine, "PW_ONCE_MAT", "ONCE Materialized", {
      frequency: "ONCE",
    });
    const asgnOnceMat = await createUserAssignment(engine, tplOnceMat.template_id, EMP_ONCE_MAT.app, {
      frequency: "ONCE",
    });
    const [origOnce] = await fetchAssignmentObligations(engine, asgnOnceMat.assignment_id);
    assert.equal(origOnce.period_key, `ONCE-${O_D3}`);

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnOnceMat.assignment_id, 1, "PAUSED", nextKey("once-mat-p"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
      [asgnOnceMat.assignment_id, O_D1],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnOnceMat.assignment_id, 2, "ACTIVE", nextKey("once-mat-r"),
    ]);
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, O_D3]);
    await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, addDaysIso(O_D3, 1)]);
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_ONCE_MAT.auth, EMP_ONCE_MAT.app, null]);

    const afterOnceMat = await fetchAssignmentObligations(engine, asgnOnceMat.assignment_id);
    assert.equal(afterOnceMat.length, 1, "Already-materialized ONCE singleton must never duplicate");
    assert.equal(afterOnceMat[0].obligation_id, origOnce.obligation_id);

    // -------------------------------------------------------------------------
    // TEAM & GROUP assignments also obey pause windows identically
    // -------------------------------------------------------------------------
    const tplTeam = await createPublishedTemplate(engine, "PW_TEAM_B", "Team B Pause");
    const asgnTeam = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplTeam.template_id, "TEAM", null, TEAM_B, null,
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("team-asgn"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnTeam.assignment_id, O_D1],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnTeam.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnTeam.assignment_id, O_D2, O_D3],
    );
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_TEAM_B.auth, EMP_TEAM_B.app, null]);
    assert.deepEqual(
      (await fetchAssignmentObligations(engine, asgnTeam.assignment_id)).map((r) => r.period_start_date),
      [O_D1, O_D3],
      "TEAM assignment skips paused O_D2",
    );

    const grp = await engine.serviceRpc("work_report_create_group", [
      OWNER.auth, OWNER.app, "Nhóm PW", "Group pause test", [EMP_GROUP.app], nextKey("grp"),
    ]);
    const tplGrp = await createPublishedTemplate(engine, "PW_GRP", "Group Pause");
    const asgnGrp = await engine.serviceRpc(
      "work_report_create_group_assignment",
      [
        OWNER.auth, OWNER.app, tplGrp.template_id, grp.group_id,
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("grp-asgn"),
      ],
      CREATE_GROUP_ASSIGNMENT_CASTS,
    );
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnGrp.assignment_id, O_D1],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnGrp.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnGrp.assignment_id, O_D2, O_D3],
    );
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_GROUP.auth, EMP_GROUP.app, null]);
    assert.deepEqual(
      (await fetchAssignmentObligations(engine, asgnGrp.assignment_id)).map((r) => r.period_start_date),
      [O_D1, O_D3],
      "GROUP assignment skips paused O_D2",
    );
  } finally {
    await engine.close();
  }
});

test("WP10-6 PW #5 (PGlite): PW-05 idempotency, PAUSED->PAUSED, OCC PT409, PAUSED->REVOKED, archive_template, & #37 immediate create", async () => {
  const { engine, todayVn } = await bootstrapFullDb([
    { user: EMP_PW05 },
    { user: EMP_GROUP },
  ]);
  try {
    const D_M2 = addDaysIso(todayVn, -2);
    const D_M1 = addDaysIso(todayVn, -1);
    const D_P1 = addDaysIso(todayVn, 1);

    // 1. Idempotency replay on PAUSED & ACTIVE + payload mismatch + PAUSED -> PAUSED + OCC PT409
    const tplIdem = await createPublishedTemplate(engine, "PW05_IDEM", "PW-05 Idem");
    const asgn = await createUserAssignment(engine, tplIdem.template_id, EMP_PW05.app);

    const keyPause1 = nextKey("idem-p1");
    const rPause1 = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn.assignment_id, 1, "PAUSED", keyPause1,
    ]);
    assert.deepEqual(rPause1, { assignment_id: asgn.assignment_id, state: "PAUSED", version: 2 });
    const pwAfterPause1 = await fetchPauseWindows(engine, asgn.assignment_id);
    assert.equal(pwAfterPause1.length, 1);
    assert.equal(pwAfterPause1[0].paused_date, todayVn);
    assert.equal(pwAfterPause1[0].resumed_date, null);

    // Exact replay with same Idempotency-Key -> cached result, 0 duplicate windows, version unchanged
    const rPause1Replay = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn.assignment_id, 1, "PAUSED", keyPause1,
    ]);
    assert.deepEqual(rPause1Replay, rPause1);
    assert.deepEqual(await fetchPauseWindows(engine, asgn.assignment_id), pwAfterPause1);

    // Same Idempotency-Key with different payload rejected (22023)
    await assert.rejects(
      () =>
        engine.serviceRpc("work_report_set_assignment_state", [
          OWNER.auth, OWNER.app, asgn.assignment_id, 1, "REVOKED", keyPause1,
        ]),
      (err) => err?.code === "22023",
      "Idempotency key reuse with different payload must fail closed (22023)",
    );

    // PAUSED -> PAUSED next-version call must NOT create a 2nd open window
    const rPause2 = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn.assignment_id, 2, "PAUSED", nextKey("idem-p2"),
    ]);
    assert.deepEqual(rPause2, { assignment_id: asgn.assignment_id, state: "PAUSED", version: 3 });
    assert.deepEqual(
      await fetchPauseWindows(engine, asgn.assignment_id),
      pwAfterPause1,
      "PAUSED -> PAUSED must not create a 2nd open pause window",
    );

    // Stale expected_version -> PT409 conflict without mutating pause windows
    await assert.rejects(
      () =>
        engine.serviceRpc("work_report_set_assignment_state", [
          OWNER.auth, OWNER.app, asgn.assignment_id, 2, "ACTIVE", nextKey("stale-act"),
        ]),
      (err) => err?.code === "PT409",
      "Stale expected_version on ACTIVE must raise PT409",
    );
    assert.deepEqual(await fetchPauseWindows(engine, asgn.assignment_id), pwAfterPause1);

    // PAUSED -> ACTIVE + replay
    const keyResume = nextKey("idem-act");
    const rResume = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn.assignment_id, 3, "ACTIVE", keyResume,
    ]);
    assert.deepEqual(rResume, { assignment_id: asgn.assignment_id, state: "ACTIVE", version: 4 });
    const pwAfterResume = await fetchPauseWindows(engine, asgn.assignment_id);
    assert.equal(pwAfterResume.length, 1);
    assert.equal(pwAfterResume[0].resumed_date, todayVn);

    const rResumeReplay = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgn.assignment_id, 3, "ACTIVE", keyResume,
    ]);
    assert.deepEqual(rResumeReplay, rResume);
    assert.deepEqual(await fetchPauseWindows(engine, asgn.assignment_id), pwAfterResume);

    // Stale expected_version on PAUSED -> PT409 without creating a new open window
    await assert.rejects(
      () =>
        engine.serviceRpc("work_report_set_assignment_state", [
          OWNER.auth, OWNER.app, asgn.assignment_id, 3, "PAUSED", nextKey("stale-pause"),
        ]),
      (err) => err?.code === "PT409",
      "Stale expected_version on PAUSED must raise PT409",
    );
    assert.deepEqual(await fetchPauseWindows(engine, asgn.assignment_id), pwAfterResume);

    // 2. PAUSED -> REVOKED closes open pause window AND preserves revoke obligation rules
    const tplRev = await createPublishedTemplate(engine, "PW05_REV", "PW-05 Revoke", {
      requiresReview: true,
    });
    const asgnRev = await createUserAssignment(engine, tplRev.template_id, EMP_PW05.app, {
      dueDayOffset: 10,
      dueTimeLocal: "23:59:59",
    });
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnRev.assignment_id, D_M2],
    );
    for (const d of [D_M2, D_M1]) {
      await engine.query(
        "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
        [asgnRev.assignment_id, d],
      );
    }
    const revSeedObs = await fetchAssignmentObligations(engine, asgnRev.assignment_id);
    const revByDate = Object.fromEntries(revSeedObs.map((r) => [r.period_start_date, r.obligation_id]));
    await engine.serviceRpc("work_report_submit", [
      EMP_PW05.auth, EMP_PW05.app, revByDate[D_M2],
      JSON.stringify({ calls_made: 10 }), null, nextKey("rev-sub"),
    ]);
    await engine.serviceRpc("work_report_save_draft", [
      EMP_PW05.auth, EMP_PW05.app, revByDate[D_M1],
      JSON.stringify({ calls_made: 5 }), null, nextKey("rev-draft"),
    ]);

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnRev.assignment_id, 1, "PAUSED", nextKey("rev-p"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
      [asgnRev.assignment_id, D_M1],
    );

    const revoked = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnRev.assignment_id, 2, "REVOKED", nextKey("rev-do"),
    ]);
    assert.deepEqual(revoked, { assignment_id: asgnRev.assignment_id, state: "REVOKED", version: 3 });
    const revPw = await fetchPauseWindows(engine, asgnRev.assignment_id);
    assert.equal(revPw.length, 1);
    assert.equal(revPw[0].paused_date, D_M1);
    assert.equal(revPw[0].resumed_date, todayVn, "PAUSED -> REVOKED must close open pause window with today_vn");

    const revObsAfter = await fetchAssignmentObligations(engine, asgnRev.assignment_id);
    const statusByDate = Object.fromEntries(revObsAfter.map((r) => [r.period_start_date, r.obligation_status]));
    assert.equal(statusByDate[D_M2], "ACTIVE", "Submitted obligation must remain ACTIVE after PAUSED -> REVOKED");
    assert.equal(statusByDate[D_M1], "CANCELLED", "DRAFT obligation must become CANCELLED after PAUSED -> REVOKED");
    assert.equal(statusByDate[todayVn], "CANCELLED", "NOT_STARTED obligation must become CANCELLED after PAUSED -> REVOKED");

    // 3. work_report_archive_template closes open pause windows (including greatest() clock-skew guard)
    const tplArch = await createPublishedTemplate(engine, "PW05_ARCH", "PW-05 Archive");
    const asgnArchPaused = await createUserAssignment(engine, tplArch.template_id, EMP_PW05.app);
    const asgnArchActive = await createUserAssignment(engine, tplArch.template_id, EMP_GROUP.app);
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnArchPaused.assignment_id, 1, "PAUSED", nextKey("arch-p"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
      [asgnArchPaused.assignment_id, D_M2],
    );
    // Also pause asgnArchActive with future paused_date = D_P1 to exercise greatest(paused_date, today_vn)
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnArchActive.assignment_id, 1, "PAUSED", nextKey("arch-p2"),
    ]);
    await engine.query(
      "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
      [asgnArchActive.assignment_id, D_P1],
    );

    const keyArch = nextKey("arch-do");
    const archRes = await engine.serviceRpc("work_report_archive_template", [
      OWNER.auth, OWNER.app, tplArch.template_id, tplArch.version, keyArch,
    ]);
    assert.equal(archRes.status, "ARCHIVED");
    // Replay idempotency
    const archReplay = await engine.serviceRpc("work_report_archive_template", [
      OWNER.auth, OWNER.app, tplArch.template_id, tplArch.version, keyArch,
    ]);
    assert.deepEqual(archReplay, archRes);

    const { rows: archAssignments } = await engine.query(
      `select assignment_id::text, state, is_current
         from public.work_report_assignments
        where template_id = $1::uuid`,
      [tplArch.template_id],
    );
    assert.equal(archAssignments.length, 2);
    for (const a of archAssignments) {
      assert.equal(a.state, "REVOKED");
      assert.equal(a.is_current, false);
    }

    const archPw1 = await fetchPauseWindows(engine, asgnArchPaused.assignment_id);
    assert.equal(archPw1[0].paused_date, D_M2);
    assert.equal(archPw1[0].resumed_date, todayVn);

    const archPw2 = await fetchPauseWindows(engine, asgnArchActive.assignment_id);
    assert.equal(archPw2[0].paused_date, D_P1);
    assert.equal(archPw2[0].resumed_date, D_P1, "greatest(paused_date, today_vn) preserves CHECK constraint");

    // 4. #37 immediate-on-create behavior remains 100% intact across USER, USER_SET, GROUP
    const tpl37 = await createPublishedTemplate(engine, "PW05_37", "PW-05 #37 Intact");
    const asgn37UserSet = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tpl37.template_id, "USER_SET", null, null, [EMP_PW05.app, EMP_GROUP.app],
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("37-uset"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    const { rows: [asgn37Row] } = await engine.query(
      "select effective_from::text, effective_to::text, state from public.work_report_assignments where assignment_id = $1::uuid",
      [asgn37UserSet.assignment_id],
    );
    assert.equal(asgn37Row.effective_from, todayVn);
    assert.equal(asgn37Row.effective_to, null);
    assert.equal(asgn37Row.state, "ACTIVE");
    assert.equal((await fetchPauseWindows(engine, asgn37UserSet.assignment_id)).length, 0);
    const obs37 = await fetchAssignmentObligations(engine, asgn37UserSet.assignment_id);
    assert.equal(obs37.length, 2);
    assert.ok(obs37.every((r) => r.period_start_date === todayVn));
  } finally {
    await engine.close();
  }
});

test("WP10-6 PW #6 (PGlite): PW-08 strict SET TRANSACTION READ ONLY parity of work_report_has_active_obligations", async () => {
  const { engine, todayVn } = await bootstrapFullDb([
    { user: EMP_PW08_A },
    { user: EMP_PW08_B },
    { user: EMP_PW08_C },
  ]);
  try {
    const D_M3 = addDaysIso(todayVn, -3);
    const D_M1 = addDaysIso(todayVn, -1);

    // Case 1: PAUSED with NO existing obligations -> false; same-day resume -> true
    const tplA = await createPublishedTemplate(engine, "PW08_A", "PW-08 Empty Pause");
    const asgnA = await createUserAssignment(engine, tplA.template_id, EMP_PW08_A.app);
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnA.assignment_id],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnA.assignment_id, 1, "PAUSED", nextKey("pw08a-p"),
    ]);
    await assertReadOnlyProbeParity(engine, EMP_PW08_A, false, "PW-08 Case 1 PAUSED empty");

    // Resume on same day -> delete auto-materialized row to prove READ ONLY candidate path returns true BEFORE list writes!
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnA.assignment_id, 2, "ACTIVE", nextKey("pw08a-r"),
    ]);
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnA.assignment_id],
    );
    await assertReadOnlyProbeParity(engine, EMP_PW08_A, true, "PW-08 Case 1 same-day resume candidate");

    // Case 2: PAUSED WITH existing active obligation -> true, and list does NOT create new rows for paused days
    const tplB = await createPublishedTemplate(engine, "PW08_B", "PW-08 Existing Ob");
    const asgnB = await createUserAssignment(engine, tplB.template_id, EMP_PW08_B.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnB.assignment_id, D_M3],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnB.assignment_id],
    );
    await engine.query(
      "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
      [asgnB.assignment_id, D_M3],
    );
    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnB.assignment_id, 1, "PAUSED", nextKey("pw08b-p"),
    ]);
    const itemsB = await assertReadOnlyProbeParity(engine, EMP_PW08_B, true, "PW-08 Case 2 PAUSED with existing active ob");
    assert.deepEqual(
      itemsB.map((i) => i.period_start_date),
      [D_M3],
      "PAUSED with existing active ob must NOT materialize new dates",
    );

    // Case 3: ACTIVE assignment whose entire active window [D_M3..D_M1] is covered by a closed pause window [D_M3, todayVn)
    // -> 0 eligible dates -> READ ONLY probe returns false with 0 writes AND list materializes 0 rows!
    const tplC = await createPublishedTemplate(engine, "PW08_C", "PW-08 Fully Paused Lookback");
    const asgnC = await createUserAssignment(engine, tplC.template_id, EMP_PW08_C.app);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date, effective_to = $3::date where assignment_id = $1::uuid",
      [asgnC.assignment_id, D_M3, D_M1],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid",
      [asgnC.assignment_id],
    );
    await engine.query(
      `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
       values ($1::uuid, $2::date, $3::date)`,
      [asgnC.assignment_id, D_M3, todayVn],
    );
    const itemsC = await assertReadOnlyProbeParity(engine, EMP_PW08_C, false, "PW-08 Case 3 fully-paused lookback");
    assert.equal(itemsC.length, 0);
  } finally {
    await engine.close();
  }
});
