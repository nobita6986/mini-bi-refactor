/**
 * WP9 — Org Obligations (S6): Attendance & Work Reports
 * Real PostgreSQL 18 Concurrency & Deterministic Barrier Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks under `SET LOCAL ROLE service_role`:
 *   Race 1 — Tier 1 -> Tier 2 Lock Serialization:
 *            Uncommitted `org_department_update_person_admin` (`ACTIVE -> INACTIVE`)
 *            vs `attendance_record_checkin` -> blocks on Tier 1 `organization_persons FOR SHARE`,
 *            post-commit fails closed with `42501 ACTOR_NOT_AVAILABLE` and 0 inserted check-ins.
 *   Race 2 — Tier 1 -> Tier 2 Lock Serialization:
 *            Uncommitted `org_department_update_person_admin` (`ACTIVE -> INACTIVE`)
 *            vs `attendance_assign_employee_branch_admin` &
 *            `attendance_assign_employee_slot_policy_admin` -> post-commit fail closed with
 *            `22023 ATTENDANCE_BRANCH_TARGET_USER_INVALID` /
 *            `22023 ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID` and 0 assignments created.
 *   Race 3 — Tier 1 -> Tier 2 Lock Serialization (Work Reports):
 *            (3a) Uncommitted `org_department_update_person_admin` (`ACTIVE -> INACTIVE`)
 *                 vs `work_report_create_assignment` (`USER_SET`), `work_report_create_group`,
 *                 and `work_report_create_delegation` -> post-commit fail closed with
 *                 `22023 WORK_REPORT_ASSIGNMENT_TARGET_INVALID`,
 *                 `22023 WORK_REPORT_GROUP_MEMBER_INELIGIBLE`,
 *                 `42501 WORK_REPORT_DELEGATE_NOT_AVAILABLE`, and 0 rows created.
 *            (3b) Uncommitted `org_department_set_account_type_admin` (`NORMAL -> SHARED`)
 *                 vs `work_report_create_assignment` (`USER_SET`) -> post-commit fails closed
 *                 with `22023 WORK_REPORT_ASSIGNMENT_TARGET_INVALID` and 0 rows created.
 *   Race 4 — WP9-GAP06 `ONCE` Concurrency Singleton Across Distinct Business Dates:
 *            4 concurrent `work_report_ensure_obligations_for_window` calls for
 *            `today + 1 .. today + 4` on a 2-assignee `USER_SET` `ONCE` assignment ->
 *            all 4 succeed with zero `40P01` / `23505` and exactly 1 row per
 *            `(assignment_id, assignee_app_user_id)` (total = 2, NOT 8).
 *   Race 5 — Team Transfer (`direct_entry_move_team_membership`) vs
 *            `work_report_list_my_obligations` & Strict `READ ONLY`
 *            `work_report_has_active_obligations`:
 *            Deterministic MVCC barrier + multi-wave concurrency storm toggling
 *            `Team A <-> Team B` effective `today` against active `Team B` DAILY assignment
 *            (`effective_from = today - 15`) -> zero `40P01`, zero `25006`, zero `0A000`,
 *            zero `55P03`, and zero retroactive `Team B` obligations (`period_start_date < today`).
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

import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8D2_MIGRATION_NAME = "20261120170000_wp8d2_work_report_access.sql";
const WP9_MIGRATION_NAME = "20261121090000_wp9_org_obligations.sql";

const TEAM_A = "59001000-0000-4000-8000-00000000000a";
const TEAM_B = "59001000-0000-4000-8000-00000000000b";

const OWNER = {
  auth: "19001000-0000-4000-8000-000000000001",
  app: "29001000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "19001000-0000-4000-8000-000000000002",
  app: "29001000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "19001000-0000-4000-8000-000000000003",
  app: "29001000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "19001000-0000-4000-8000-000000000004",
  app: "29001000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const EMP_ATT_RACE = {
  auth: "19001000-0000-4000-8000-000000000011",
  app: "29001000-0000-4000-8000-000000000011",
  email: "wp9.att.race@hrpartner.vn",
  name: "Emp Att Race",
};
const EMP_CFG_RACE = {
  auth: "19001000-0000-4000-8000-000000000012",
  app: "29001000-0000-4000-8000-000000000012",
  email: "wp9.cfg.race@hrpartner.vn",
  name: "Emp Cfg Race",
};
const EMP_WR_INACTIVE = {
  auth: "19001000-0000-4000-8000-000000000013",
  app: "29001000-0000-4000-8000-000000000013",
  email: "wp9.wr.inactive@hrpartner.vn",
  name: "Emp WR Inactive",
};
const EMP_WR_SHARED = {
  auth: "19001000-0000-4000-8000-000000000014",
  app: "29001000-0000-4000-8000-000000000014",
  email: "wp9.wr.shared@hrpartner.vn",
  name: "Emp WR Shared",
};
const EMP_ONCE_1 = {
  auth: "19001000-0000-4000-8000-000000000015",
  app: "29001000-0000-4000-8000-000000000015",
  email: "wp9.once1@hrpartner.vn",
  name: "Emp Once One",
};
const EMP_ONCE_2 = {
  auth: "19001000-0000-4000-8000-000000000016",
  app: "29001000-0000-4000-8000-000000000016",
  email: "wp9.once2@hrpartner.vn",
  name: "Emp Once Two",
};
const EMP_TRANSFER = {
  auth: "19001000-0000-4000-8000-000000000017",
  app: "29001000-0000-4000-8000-000000000017",
  recruiter: "39001000-0000-4000-8000-000000000017",
  email: "wp9.transfer@hrpartner.vn",
  name: "Emp Team Transfer",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  EMP_ATT_RACE,
  EMP_CFG_RACE,
  EMP_WR_INACTIVE,
  EMP_WR_SHARED,
  EMP_ONCE_1,
  EMP_ONCE_2,
  EMP_TRANSFER,
];

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

const RECRUITER_SEED_CAPS = [
  "entry_create",
  "entry_own",
  "submission_create",
  "document_upload",
  "document_view",
  "change_request_create",
  "employment_status.request",
];

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

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `a9001000-0000-4000-8000-${hex}`;
}

function nextKey(prefix) {
  return `wp9_race_${prefix}_${seq++}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
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

async function connect(port, appName, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
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

function asSettled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const rows = await waitUntilAllBlocked(observer, [appName], timeoutMs);
  return rows[0];
}

async function waitUntilAllBlocked(observer, appNames, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select application_name, wait_event_type, wait_event, state
         from pg_stat_activity
        where application_name = any($1::text[])
          and state = 'active'
          and wait_event_type = 'Lock'`,
      [appNames],
    );
    const blockedNames = new Set(rows.map((r) => r.application_name));
    if (appNames.every((name) => blockedNames.has(name))) {
      return rows;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for [${appNames.join(", ")}] to block on a PostgreSQL lock`);
}

async function seedRecruiterAndTeam(client, user, teamId, validFrom) {
  const code = user.email.split("@")[0].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 16);
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, 'STAFF', true)",
    [user.recruiter, user.name, code],
  );
  await client.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', $2::date, true)",
    [user.recruiter, validFrom],
  );
  await client.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::date, true)",
    [user.recruiter, teamId, validFrom],
  );
  await client.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, $3::date, true)",
    [user.app, user.recruiter, validFrom],
  );
}

async function createLinkedPerson(client, target, { code, fullName, joinedOn, deptId }) {
  const { rows: [u] } = await client.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [target.app],
  );
  const res = await serviceRpc(client, "org_department_create_person_admin", [
    OWNER.auth,
    OWNER.app,
    code,
    fullName,
    joinedOn,
    deptId,
    target.app,
    u.version,
    null,
    `Seed ${code}`,
    nextUuid(),
    sha256(`person:${code}:${seq}`),
  ]);
  return res.person;
}

async function createPublishedTemplate(client, actor, code, defaultFrequency = "DAILY") {
  const created = await serviceRpc(client, "work_report_create_template", [
    actor.auth,
    actor.app,
    code,
    code,
    `WP9 Race Template ${code}`,
    defaultFrequency,
    JSON.stringify(MINIMAL_TEMPLATE_SCHEMA),
    JSON.stringify(MINIMAL_METRIC_CONTRACT),
    nextKey("tpl"),
  ]);
  await serviceRpc(client, "work_report_publish_template", [
    actor.auth,
    actor.app,
    created.template_id,
    created.draft_version_id,
    created.version,
    nextKey("pub"),
  ]);
  return created;
}

function buildCheckinArgs(actor, idempotencyKey) {
  const nowMs = Date.now();
  const anchorIso = new Date(nowMs - 500).toISOString();
  const capturedIso = new Date(nowMs).toISOString();
  return [
    actor.auth,
    actor.app,
    idempotencyKey,
    sha256(`wp9-race-ci:${actor.app}:${idempotencyKey}`),
    21.0285,
    105.8542,
    10,
    "Hanoi HQ",
    "WP9 race check-in",
    capturedIso,
    "SERVER_ANCHORED",
    anchorIso,
    500,
    sha256(`wp9-race-tok:${idempotencyKey}`),
    `private/wp9-race/${actor.app}/${idempotencyKey}.jpg`,
    sha256(`wp9-race-ph:${idempotencyKey}`),
    12345,
    "image/jpeg",
    capturedIso,
  ];
}

test("WP9 Real PostgreSQL 18 Concurrency: Tier 1->2 Person/Account lock serialization, ONCE singleton across dates, and Team Transfer vs READ ONLY probe", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required for concurrency verification");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp9-pg-race-"));
  const pgData = path.join(tmpDir, "pgdata");
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

    const setup = await connect(port, "wp9_setup");
    const observer = await connect(port, "wp9_observer");
    const w1 = await connect(port, "wp9_w1");
    const w2 = await connect(port, "wp9_w2");
    const w3 = await connect(port, "wp9_w3");
    const w4 = await connect(port, "wp9_w4");
    const r1 = await connect(port, "wp9_r1");
    const r2 = await connect(port, "wp9_r2");
    clients.push(setup, observer, w1, w2, w3, w4, r1, r2);
    for (const worker of [w1, w2, w3, w4, r1, r2]) {
      await worker.query("set statement_timeout = '15s'");
    }

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(migrationFiles.length >= 232, `Expected at least 232 migrations through WP9, found ${migrationFiles.length}`);
    assert.equal(
      migrationFiles.indexOf(WP8D2_MIGRATION_NAME),
      230,
      `${WP8D2_MIGRATION_NAME} must be #231 immediately before WP9`,
    );
    assert.equal(
      migrationFiles.indexOf(WP9_MIGRATION_NAME),
      231,
      `${WP9_MIGRATION_NAME} must be #232 right after WP8D-2`,
    );
    for (const file of migrationFiles) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, file), "utf8"));
    }

    const { rows: [dates] } = await setup.query(
      "select public.direct_entry_authorization_date()::text as today, (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as vn_today",
    );
    assert.equal(dates.today, dates.vn_today, "Authorization date and VN today must align");
    const today = dates.vn_today;
    const todayMinus30 = addDaysIso(today, -30);
    const todayMinus15 = addDaysIso(today, -15);
    const todayPlus1 = addDaysIso(today, 1);
    const todayPlus2 = addDaysIso(today, 2);
    const todayPlus3 = addDaysIso(today, 3);
    const todayPlus4 = addDaysIso(today, 4);
    const todayPlus10 = addDaysIso(today, 10);

    // Seed teams & users prior to WP5 cutover
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'WP9_RACE_A', 'Race Team A', true),
              ($2::uuid, 'WP9_RACE_B', 'Race Team B', true)`,
      [TEAM_A, TEAM_B],
    );
    for (const u of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await setup.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const admin of [OWNER, LUANPT, LIENVU, NGATTT]) {
      for (const cap of ADMIN_SEED_CAPS) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [admin.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
        [admin.app],
      );
    }

    // Seed EMP_TRANSFER recruiter & Team A membership valid_from = today - 30
    await seedRecruiterAndTeam(setup, EMP_TRANSFER, TEAM_A, todayMinus30);
    for (const cap of RECRUITER_SEED_CAPS) {
      await setup.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, $3::date, true)",
        [EMP_TRANSFER.app, cap, todayMinus30],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'own', $2::date, true)",
      [EMP_TRANSFER.app, todayMinus30],
    );

    // Apply WP5 cutover
    const plan = await runWp5Cutover(setup, { mode: "dry-run" });
    const cutover = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");

    // Configure Attendance HQ location
    const hqKey = nextUuid();
    await serviceRpc(setup, "attendance_set_hq_location", [
      OWNER.auth,
      OWNER.app,
      21.0285,
      105.8542,
      0,
      hqKey,
      sha256(`hq:${hqKey}`),
    ]);

    const { rows: [mktDept] } = await setup.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );
    const mktDeptId = mktDept.department_id;

    // Seed linked ACTIVE Persons for Races 1, 2, 3a, 4, and 5 (EMP_WR_SHARED stays unlinked NORMAL)
    const pAttRace = await createLinkedPerson(setup, EMP_ATT_RACE, {
      code: "EMP-ATT-RACE",
      fullName: EMP_ATT_RACE.name,
      joinedOn: "2025-01-01",
      deptId: mktDeptId,
    });
    const pCfgRace = await createLinkedPerson(setup, EMP_CFG_RACE, {
      code: "EMP-CFG-RACE",
      fullName: EMP_CFG_RACE.name,
      joinedOn: "2025-01-01",
      deptId: mktDeptId,
    });
    const pWrInactive = await createLinkedPerson(setup, EMP_WR_INACTIVE, {
      code: "EMP-WR-INACT",
      fullName: EMP_WR_INACTIVE.name,
      joinedOn: "2025-01-01",
      deptId: mktDeptId,
    });
    await createLinkedPerson(setup, EMP_ONCE_1, {
      code: "EMP-ONCE-01",
      fullName: EMP_ONCE_1.name,
      joinedOn: "2025-01-01",
      deptId: mktDeptId,
    });
    await createLinkedPerson(setup, EMP_ONCE_2, {
      code: "EMP-ONCE-02",
      fullName: EMP_ONCE_2.name,
      joinedOn: "2025-01-01",
      deptId: mktDeptId,
    });
    await createLinkedPerson(setup, EMP_TRANSFER, {
      code: "EMP-XFER-01",
      fullName: EMP_TRANSFER.name,
      joinedOn: addDaysIso(today, -60),
      deptId: mktDeptId,
    });

    // Clear any open personal role assignment on EMP_WR_SHARED so NORMAL -> SHARED is permitted
    const { rows: sharedRoles } = await setup.query(
      `select a.assignment_id
         from public.authz_account_role_assignments a
        where a.app_user_id = $1::uuid
          and a.ended_at is null`,
      [EMP_WR_SHARED.app],
    );
    for (const r of sharedRoles) {
      const { rows: [uVer] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [EMP_WR_SHARED.app],
      );
      await serviceRpc(setup, "direct_entry_authz_revoke_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        EMP_WR_SHARED.app,
        r.assignment_id,
        uVer.version,
        "Clear personal role before SHARED reclassification",
        nextUuid(),
        sha256(`revoke-shared:${r.assignment_id}`),
      ]);
    }

    // Seed Attendance Branch & Custom Slot Policy Profile for Race 2
    const branchRes = await serviceRpc(setup, "attendance_upsert_branch_admin", [
      OWNER.auth,
      OWNER.app,
      null,
      "WP9_RACE_BR",
      "Chi nhánh Race WP9",
      "Hanoi",
      21.0285,
      105.8542,
      true,
      0,
      nextUuid(),
      sha256("wp9-race-branch"),
    ]);
    const branchId = branchRes.branch.branch_id;
    const branchVersion = branchRes.branch.version;

    const customProfileRes = await serviceRpc(setup, "attendance_upsert_slot_policy_profile_admin", [
      OWNER.auth,
      OWNER.app,
      null,
      "WP9_RACE_SLOT",
      "Ca Race WP9",
      "Non-default slot policy for WP9 race",
      true,
      today,
      JSON.stringify([
        {
          slot_code: "SLOT_1",
          slot_label: "Vào sáng",
          session_code: "AM",
          target_time: "08:00",
          grace_before_minutes: 15,
          grace_after_minutes: 15,
        },
      ]),
      0,
      0,
      nextUuid(),
      sha256("wp9-race-slot-profile"),
    ]);
    const customProfileId = customProfileRes.profile.profile_id;

    // Seed active published Work Report templates
    const tplRace3 = await createPublishedTemplate(setup, OWNER, "WP9_RACE3_DAILY", "DAILY");
    const tplRace4Once = await createPublishedTemplate(setup, OWNER, "WP9_RACE4_ONCE", "ONCE");
    const tplRace5TeamB = await createPublishedTemplate(setup, OWNER, "WP9_RACE5_TEAMB", "DAILY");

    // =========================================================================
    // RACE 1: Tier 1 -> Tier 2 Lock Serialization
    //         org_department_update_person_admin (ACTIVE -> INACTIVE)
    //         vs attendance_record_checkin
    // =========================================================================
    await t.test("Race 1: org_department_update_person_admin (INACTIVE) vs attendance_record_checkin", async () => {
      const checkinKey = nextUuid();
      let checkinSettled = false;

      await w1.query("begin");
      try {
        await serviceRpcInTx(w1, "org_department_update_person_admin", [
          OWNER.auth,
          OWNER.app,
          pAttRace.person_id,
          pAttRace.version,
          pAttRace.employee_code,
          pAttRace.full_name,
          "2025-01-01",
          "INACTIVE",
          "Resigned",
          nextUuid(),
          sha256("race1-deactivate-att"),
        ]);

        const checkinPromise = asSettled(
          serviceRpc(w2, "attendance_record_checkin", buildCheckinArgs(EMP_ATT_RACE, checkinKey)),
        ).then((res) => {
          checkinSettled = true;
          return res;
        });

        const lockWait = await waitUntilBlocked(observer, "wp9_w2");
        assert.equal(lockWait.wait_event_type, "Lock", "Conn B must block on Tier 1 organization_persons FOR SHARE lock");
        assert.equal(checkinSettled, false, "Conn B check-in must remain blocked while Conn A holds uncommitted Person lock");

        await w1.query("commit");

        const outcome = await checkinPromise;
        assert.equal(outcome.status, "rejected", "Check-in blocked behind ACTIVE->INACTIVE must fail closed after commit");
        assert.notEqual(outcome.reason?.code, "40P01", "Race 1 must never deadlock");
        assert.equal(outcome.reason?.code, "42501", `Expected 42501, got ${outcome.reason?.code}: ${outcome.reason?.message}`);
        assert.match(String(outcome.reason?.message), /ACTOR_NOT_AVAILABLE/);
      } catch (err) {
        await w1.query("rollback").catch(() => {});
        throw err;
      }

      const { rows: [ciByKey] } = await observer.query(
        "select count(*)::int as n from public.attendance_checkins where idempotency_key = $1::uuid",
        [checkinKey],
      );
      assert.equal(ciByKey.n, 0, "0 rows may be inserted into attendance_checkins for rejected idempotency key");
    });

    // =========================================================================
    // RACE 2: Tier 1 -> Tier 2 Lock Serialization
    //         org_department_update_person_admin (ACTIVE -> INACTIVE)
    //         vs attendance_assign_employee_branch_admin &
    //            attendance_assign_employee_slot_policy_admin
    // =========================================================================
    await t.test("Race 2: org_department_update_person_admin (INACTIVE) vs attendance branch & slot policy assignments", async () => {
      await w1.query("begin");
      try {
        await serviceRpcInTx(w1, "org_department_update_person_admin", [
          OWNER.auth,
          OWNER.app,
          pCfgRace.person_id,
          pCfgRace.version,
          pCfgRace.employee_code,
          pCfgRace.full_name,
          "2025-01-01",
          "INACTIVE",
          "Resigned",
          nextUuid(),
          sha256("race2-deactivate-cfg"),
        ]);

        const branchPromise = asSettled(
          serviceRpc(w2, "attendance_assign_employee_branch_admin", [
            OWNER.auth,
            OWNER.app,
            EMP_CFG_RACE.app,
            branchId,
            null,
            branchVersion,
            nextUuid(),
            sha256("race2-assign-branch"),
          ]),
        );
        const slotPromise = asSettled(
          serviceRpc(w3, "attendance_assign_employee_slot_policy_admin", [
            OWNER.auth,
            OWNER.app,
            EMP_CFG_RACE.app,
            customProfileId,
            null,
            0,
            nextUuid(),
            sha256("race2-assign-slot"),
          ]),
        );

        await waitUntilAllBlocked(observer, ["wp9_w2", "wp9_w3"]);

        await w1.query("commit");

        const [branchOutcome, slotOutcome] = await Promise.all([branchPromise, slotPromise]);

        assert.equal(branchOutcome.status, "rejected", "Branch assign must fail closed after Person deactivation");
        assert.notEqual(branchOutcome.reason?.code, "40P01", "Race 2 branch assign must never deadlock");
        assert.equal(
          branchOutcome.reason?.code,
          "22023",
          `Branch assign expected 22023, got ${branchOutcome.reason?.code}: ${branchOutcome.reason?.message}`,
        );
        assert.match(String(branchOutcome.reason?.message), /ATTENDANCE_BRANCH_TARGET_USER_INVALID/);

        assert.equal(slotOutcome.status, "rejected", "Slot policy assign must fail closed after Person deactivation");
        assert.notEqual(slotOutcome.reason?.code, "40P01", "Race 2 slot policy assign must never deadlock");
        assert.equal(
          slotOutcome.reason?.code,
          "22023",
          `Slot policy assign expected 22023, got ${slotOutcome.reason?.code}: ${slotOutcome.reason?.message}`,
        );
        assert.match(String(slotOutcome.reason?.message), /ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID/);
      } catch (err) {
        await w1.query("rollback").catch(() => {});
        throw err;
      }

      const { rows: [brCount] } = await observer.query(
        "select count(*)::int as n from public.attendance_branch_assignments where app_user_id = $1::uuid",
        [EMP_CFG_RACE.app],
      );
      const { rows: [slCount] } = await observer.query(
        "select count(*)::int as n from public.attendance_slot_policy_assignments where app_user_id = $1::uuid",
        [EMP_CFG_RACE.app],
      );
      assert.equal(brCount.n, 0, "0 branch assignments may be created for deactivated Person");
      assert.equal(slCount.n, 0, "0 slot policy assignments may be created for deactivated Person");
    });

    // =========================================================================
    // RACE 3: Tier 1 -> Tier 2 Lock Serialization (Work Reports)
    //         (3a) org_department_update_person_admin (INACTIVE) vs
    //              create_assignment(USER_SET), create_group, create_delegation
    //         (3b) org_department_set_account_type_admin (NORMAL -> SHARED) vs
    //              create_assignment(USER_SET)
    // =========================================================================
    await t.test("Race 3: Person INACTIVE & NORMAL->SHARED vs Work Report assignment, group, and delegation", async () => {
      // 3a. Person ACTIVE -> INACTIVE on EMP_WR_INACTIVE
      const asgBefore3a = (
        await observer.query("select count(*)::int as n from public.work_report_assignments where template_id = $1::uuid", [
          tplRace3.template_id,
        ])
      ).rows[0].n;
      const grpBefore3a = (await observer.query("select count(*)::int as n from public.work_report_groups")).rows[0].n;
      const delBefore3a = (
        await observer.query("select count(*)::int as n from public.work_report_delegations where delegate_app_user_id = $1::uuid", [
          EMP_WR_INACTIVE.app,
        ])
      ).rows[0].n;

      await w1.query("begin");
      try {
        await serviceRpcInTx(w1, "org_department_update_person_admin", [
          OWNER.auth,
          OWNER.app,
          pWrInactive.person_id,
          pWrInactive.version,
          pWrInactive.employee_code,
          pWrInactive.full_name,
          "2025-01-01",
          "INACTIVE",
          "Resigned",
          nextUuid(),
          sha256("race3a-deactivate-wr"),
        ]);

        const asgPromise = asSettled(
          serviceRpc(w2, "work_report_create_assignment", [
            OWNER.auth,
            OWNER.app,
            tplRace3.template_id,
            "USER_SET",
            null,
            null,
            [EMP_WR_INACTIVE.app],
            "DAILY",
            true,
            0,
            "23:59:59",
            false,
            today,
            null,
            nextKey("asg_3a"),
          ]),
        );
        const grpPromise = asSettled(
          serviceRpc(w3, "work_report_create_group", [
            OWNER.auth,
            OWNER.app,
            "Nhóm Race 3A",
            "Blocked inactive member test",
            [EMP_WR_INACTIVE.app],
            nextKey("grp_3a"),
          ]),
        );
        const delPromise = asSettled(
          serviceRpc(w4, "work_report_create_delegation", [
            OWNER.auth,
            OWNER.app,
            "report_review",
            EMP_WR_INACTIVE.app,
            tplRace3.template_id,
            "all",
            null,
            null,
            null,
            nextKey("del_3a"),
          ]),
        );

        await waitUntilAllBlocked(observer, ["wp9_w2", "wp9_w3", "wp9_w4"]);

        await w1.query("commit");

        const [asgOutcome, grpOutcome, delOutcome] = await Promise.all([asgPromise, grpPromise, delPromise]);

        assert.equal(asgOutcome.status, "rejected", "3a USER_SET assignment must fail closed");
        assert.notEqual(asgOutcome.reason?.code, "40P01", "3a assignment must never deadlock");
        assert.equal(asgOutcome.reason?.code, "22023", `3a assignment expected 22023, got ${asgOutcome.reason?.code}: ${asgOutcome.reason?.message}`);
        assert.match(String(asgOutcome.reason?.message), /WORK_REPORT_ASSIGNMENT_TARGET_INVALID/);

        assert.equal(grpOutcome.status, "rejected", "3a create_group must fail closed");
        assert.notEqual(grpOutcome.reason?.code, "40P01", "3a create_group must never deadlock");
        assert.equal(grpOutcome.reason?.code, "22023", `3a create_group expected 22023, got ${grpOutcome.reason?.code}: ${grpOutcome.reason?.message}`);
        assert.match(String(grpOutcome.reason?.message), /WORK_REPORT_GROUP_MEMBER_INELIGIBLE/);

        assert.equal(delOutcome.status, "rejected", "3a create_delegation must fail closed");
        assert.notEqual(delOutcome.reason?.code, "40P01", "3a create_delegation must never deadlock");
        assert.equal(delOutcome.reason?.code, "42501", `3a create_delegation expected 42501, got ${delOutcome.reason?.code}: ${delOutcome.reason?.message}`);
        assert.match(String(delOutcome.reason?.message), /WORK_REPORT_DELEGATE_NOT_AVAILABLE/);
      } catch (err) {
        await w1.query("rollback").catch(() => {});
        throw err;
      }

      const asgAfter3a = (
        await observer.query("select count(*)::int as n from public.work_report_assignments where template_id = $1::uuid", [
          tplRace3.template_id,
        ])
      ).rows[0].n;
      const grpAfter3a = (await observer.query("select count(*)::int as n from public.work_report_groups")).rows[0].n;
      const delAfter3a = (
        await observer.query("select count(*)::int as n from public.work_report_delegations where delegate_app_user_id = $1::uuid", [
          EMP_WR_INACTIVE.app,
        ])
      ).rows[0].n;
      assert.equal(asgAfter3a, asgBefore3a, "3a must create 0 assignments");
      assert.equal(grpAfter3a, grpBefore3a, "3a must create 0 groups");
      assert.equal(delAfter3a, delBefore3a, "3a must create 0 delegations");

      // 3b. Account NORMAL -> SHARED on EMP_WR_SHARED vs work_report_create_assignment(USER_SET)
      const { rows: [sharedUserVer] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [EMP_WR_SHARED.app],
      );

      await w1.query("begin");
      try {
        await serviceRpcInTx(w1, "org_department_set_account_type_admin", [
          OWNER.auth,
          OWNER.app,
          EMP_WR_SHARED.app,
          "SHARED",
          sharedUserVer.version,
          "Reclassify SHARED during WR assignment race",
          nextUuid(),
          sha256("race3b-reclass-shared"),
        ]);

        const asgSharedPromise = asSettled(
          serviceRpc(w2, "work_report_create_assignment", [
            OWNER.auth,
            OWNER.app,
            tplRace3.template_id,
            "USER_SET",
            null,
            null,
            [EMP_WR_SHARED.app],
            "DAILY",
            true,
            0,
            "23:59:59",
            false,
            today,
            null,
            nextKey("asg_3b"),
          ]),
        );

        await waitUntilBlocked(observer, "wp9_w2");
        await w1.query("commit");

        const asgSharedOutcome = await asgSharedPromise;
        assert.equal(asgSharedOutcome.status, "rejected", "3b USER_SET assignment must fail closed after NORMAL->SHARED");
        assert.notEqual(asgSharedOutcome.reason?.code, "40P01", "3b assignment must never deadlock");
        assert.equal(
          asgSharedOutcome.reason?.code,
          "22023",
          `3b assignment expected 22023, got ${asgSharedOutcome.reason?.code}: ${asgSharedOutcome.reason?.message}`,
        );
        assert.match(String(asgSharedOutcome.reason?.message), /WORK_REPORT_ASSIGNMENT_TARGET_INVALID/);
      } catch (err) {
        await w1.query("rollback").catch(() => {});
        throw err;
      }

      const asgAfter3b = (
        await observer.query("select count(*)::int as n from public.work_report_assignments where template_id = $1::uuid", [
          tplRace3.template_id,
        ])
      ).rows[0].n;
      assert.equal(asgAfter3b, asgBefore3a, "3b must create 0 assignments for reclassified SHARED target");
    });

    // =========================================================================
    // RACE 4: WP9-GAP06 ONCE Concurrency Singleton Across Distinct Business Dates
    // =========================================================================
    await t.test("Race 4: WP9-GAP06 ONCE singleton across 4 concurrent business dates (today+1..today+4)", async () => {
      const onceAsg = await serviceRpc(setup, "work_report_create_assignment", [
        OWNER.auth,
        OWNER.app,
        tplRace4Once.template_id,
        "USER_SET",
        null,
        null,
        [EMP_ONCE_1.app, EMP_ONCE_2.app],
        "ONCE",
        true,
        0,
        "23:59:59",
        false,
        todayPlus1,
        todayPlus10,
        nextKey("asg_once_4"),
      ]);

      const { rows: [preCount] } = await observer.query(
        "select count(*)::int as n from public.work_report_obligations where assignment_id = $1::uuid",
        [onceAsg.assignment_id],
      );
      assert.equal(preCount.n, 0, "Future effective_from ONCE assignment must start with 0 materialized rows today");

      const race4Outcomes = await Promise.all([
        asSettled(serviceRpc(w1, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayPlus1])),
        asSettled(serviceRpc(w2, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayPlus2])),
        asSettled(serviceRpc(w3, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayPlus3])),
        asSettled(serviceRpc(w4, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayPlus4])),
      ]);

      for (const [idx, outcome] of race4Outcomes.entries()) {
        if (outcome.status === "rejected") {
          assert.notEqual(outcome.reason?.code, "40P01", `Race 4 worker ${idx + 1} must never deadlock`);
          assert.notEqual(outcome.reason?.code, "23505", `Race 4 worker ${idx + 1} must never raise 23505`);
        }
        assert.equal(
          outcome.status,
          "fulfilled",
          `Race 4 worker ${idx + 1} must succeed: ${outcome.reason?.code} ${outcome.reason?.message}`,
        );
      }

      const { rows: onceRows } = await observer.query(
        `select assignee_app_user_id, count(*)::int as n
           from public.work_report_obligations
          where assignment_id = $1::uuid
          group by assignee_app_user_id
          order by assignee_app_user_id`,
        [onceAsg.assignment_id],
      );
      assert.equal(onceRows.length, 2, "ONCE assignment must materialize rows for both active assignees");
      for (const row of onceRows) {
        assert.equal(
          row.n,
          1,
          `WP9-GAP06: assignee ${row.assignee_app_user_id} must have EXACTLY 1 ONCE obligation (got ${row.n})`,
        );
      }

      const { rows: [totalOnce] } = await observer.query(
        "select count(*)::int as n from public.work_report_obligations where assignment_id = $1::uuid",
        [onceAsg.assignment_id],
      );
      assert.equal(totalOnce.n, 2, "Total ONCE obligations across 4 concurrent dates must be 2 (NOT 8)");
    });

    // =========================================================================
    // RACE 5: Team Transfer (direct_entry_move_team_membership) vs
    //         work_report_list_my_obligations & Strict READ ONLY
    //         work_report_has_active_obligations
    // =========================================================================
    await t.test("Race 5: Team Transfer vs work_report_list_my_obligations + strict READ ONLY work_report_has_active_obligations", async () => {
      const teamBAsg = await serviceRpc(setup, "work_report_create_assignment", [
        OWNER.auth,
        OWNER.app,
        tplRace5TeamB.template_id,
        "TEAM",
        null,
        TEAM_B,
        null,
        "DAILY",
        true,
        0,
        "23:59:59",
        false,
        todayMinus15,
        null,
        nextKey("asg_teamb_5"),
      ]);

      // Pre-transfer READ ONLY probe: EMP_TRANSFER is still in Team A -> false, 0 obligations
      const preProbe = await serviceRpcReadOnly(r1, "work_report_has_active_obligations", [
        EMP_TRANSFER.auth,
        EMP_TRANSFER.app,
      ]);
      assert.equal(preProbe.has_active_obligations, false, "Pre-transfer Team A employee must have no Team B active obligations");

      const { rows: [recStart] } = await setup.query(
        "select version from public.recruiters where recruiter_id = $1::uuid",
        [EMP_TRANSFER.recruiter],
      );
      let recruiterVersion = recStart.version;

      // 5a. Deterministic MVCC READ ONLY barrier during uncommitted Team A -> Team B move
      await w1.query("begin");
      try {
        const move1 = await serviceRpcInTx(w1, "direct_entry_move_team_membership", [
          OWNER.auth,
          OWNER.app,
          EMP_TRANSFER.recruiter,
          TEAM_B,
          today,
          recruiterVersion,
          "Race 5a uncommitted move Team A -> Team B",
          nextKey("move_5a"),
        ]);
        recruiterVersion = move1.recruiter_version;

        const [probeDuring, listDuring] = await Promise.all([
          serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_TRANSFER.auth, EMP_TRANSFER.app]),
          serviceRpc(w2, "work_report_list_my_obligations", [EMP_TRANSFER.auth, EMP_TRANSFER.app, "ACTIVE"]),
        ]);
        assert.equal(probeDuring.has_active_obligations, false, "READ ONLY probe during uncommitted move must not block or see uncommitted Team B");
        assert.equal(
          listDuring.items.filter((i) => i.template_id === tplRace5TeamB.template_id).length,
          0,
          "Pre-commit list_my_obligations must materialize 0 Team B obligations",
        );

        await w1.query("commit");
      } catch (err) {
        await w1.query("rollback").catch(() => {});
        throw err;
      }

      // 5b. Multi-wave parallel concurrency storm: Team B <-> Team A -> Team B effective today
      //     racing concurrent work_report_list_my_obligations and strict READ ONLY probes
      const targetSequence = [TEAM_A, TEAM_B, TEAM_A, TEAM_B];
      const assertCleanError = (label, err) => {
        assert.notEqual(err?.code, "40P01", `${label} must NEVER deadlock`);
        assert.notEqual(err?.code, "25006", `${label} must NEVER violate READ ONLY transaction`);
        assert.notEqual(err?.code, "0A000", `${label} must NEVER raise volatility/feature error`);
        assert.notEqual(err?.code, "55P03", `${label} must NEVER block on lock_timeout`);
        assert.notEqual(err?.code, "23505", `${label} must NEVER raise unique violation`);
      };

      const stormOutcomes = await Promise.all([
        asSettled((async () => {
          for (let i = 0; i < targetSequence.length; i += 1) {
            const targetTeam = targetSequence[i];
            const res = await serviceRpc(w1, "direct_entry_move_team_membership", [
              OWNER.auth,
              OWNER.app,
              EMP_TRANSFER.recruiter,
              targetTeam,
              today,
              recruiterVersion,
              `Race 5b wave ${i + 1}`,
              nextKey(`move_5b_${i}`),
            ]);
            recruiterVersion = res.recruiter_version;
          }
          return "moves-ok";
        })()),
        asSettled((async () => {
          for (let i = 0; i < 10; i += 1) {
            const listRes = await serviceRpc(w2, "work_report_list_my_obligations", [
              EMP_TRANSFER.auth,
              EMP_TRANSFER.app,
              null,
            ]);
            assert.ok(Array.isArray(listRes.items));
          }
          return "list1-ok";
        })()),
        asSettled((async () => {
          for (let i = 0; i < 10; i += 1) {
            const listRes = await serviceRpc(w3, "work_report_list_my_obligations", [
              EMP_TRANSFER.auth,
              EMP_TRANSFER.app,
              "ACTIVE",
            ]);
            assert.ok(Array.isArray(listRes.items));
          }
          return "list2-ok";
        })()),
        asSettled((async () => {
          for (let i = 0; i < 15; i += 1) {
            const p = await serviceRpcReadOnly(r1, "work_report_has_active_obligations", [
              EMP_TRANSFER.auth,
              EMP_TRANSFER.app,
            ]);
            assert.equal(typeof p.has_active_obligations, "boolean");
          }
          return "ro1-ok";
        })()),
        asSettled((async () => {
          for (let i = 0; i < 15; i += 1) {
            const p = await serviceRpcReadOnly(r2, "work_report_has_active_obligations", [
              EMP_TRANSFER.auth,
              EMP_TRANSFER.app,
            ]);
            assert.equal(typeof p.has_active_obligations, "boolean");
          }
          return "ro2-ok";
        })()),
      ]);

      for (const [idx, outcome] of stormOutcomes.entries()) {
        if (outcome.status === "rejected") {
          assertCleanError(`Race 5b stream ${idx + 1}`, outcome.reason);
        }
        assert.equal(
          outcome.status,
          "fulfilled",
          `Race 5b stream ${idx + 1} failed: ${outcome.reason?.code} ${outcome.reason?.message}`,
        );
      }

      // Final settle check: EMP_TRANSFER is now in Team B effective today ->
      // strictly 1 Team B obligation for today, ZERO retroactive obligations (period_start_date < today)
      const finalList = await serviceRpc(w2, "work_report_list_my_obligations", [
        EMP_TRANSFER.auth,
        EMP_TRANSFER.app,
        "ACTIVE",
      ]);
      const finalProbe = await serviceRpcReadOnly(r1, "work_report_has_active_obligations", [
        EMP_TRANSFER.auth,
        EMP_TRANSFER.app,
      ]);
      assert.equal(finalProbe.has_active_obligations, true, "Post-transfer READ ONLY probe must report true");
      assert.ok(
        finalList.items.some((i) => i.template_id === tplRace5TeamB.template_id && i.period_start_date === today),
        "Post-transfer list must include today's Team B obligation",
      );

      const { rows: teamBObs } = await observer.query(
        `select period_start_date::text as period_start_date, snapshot_team_id
           from public.work_report_obligations
          where assignee_app_user_id = $1::uuid
            and assignment_id = $2::uuid
          order by period_start_date asc`,
        [EMP_TRANSFER.app, teamBAsg.assignment_id],
      );
      const retroactiveRows = teamBObs.filter((row) => row.period_start_date < today);
      assert.equal(
        retroactiveRows.length,
        0,
        `ZERO retroactive Team B obligations with period_start_date < ${today} allowed; got ${JSON.stringify(retroactiveRows)}`,
      );
      assert.equal(teamBObs.length, 1, `Expected exactly 1 Team B obligation for ${today}, got ${teamBObs.length}`);
      assert.equal(teamBObs[0].period_start_date, today);
      assert.equal(teamBObs[0].snapshot_team_id, TEAM_B);
    });
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
