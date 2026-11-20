/**
 * WP8D-2 — Work Reports Subsystem Authorization Migration to WP5 Paired Access
 * Real PostgreSQL 18 Concurrency, MVCC READ ONLY Burst, Live Catalog & NOBYPASSRLS Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks, ZERO `25006` READ ONLY write violations,
 * ZERO `0A000` volatility violations, and ZERO `55P03` lock_timeout flakes:
 *   Race 1 — Delegation Revoke & Grantor Disable vs Delegated Review / Assignment:
 *     - 1A: Uncommitted `work_report_revoke_delegation` (report_review) vs `work_report_decide_review` -> post-commit 42501.
 *     - 1B: Uncommitted `work_report_revoke_delegation` (report_assign) vs `work_report_create_assignment` -> post-commit 42501.
 *     - 1C: Uncommitted `direct_entry_disable_app_user` on GRANTOR vs delegate `decide_review` & `create_assignment` -> post-commit 42501.
 *   Race 2 — Recruiter Team Move & TL Revoke vs Mirror-Cleared Managed TL Operations:
 *     - 2A: Uncommitted `direct_entry_move_team_membership` (STAFF_A1: TEAM_A -> TEAM_B) vs mirror-cleared TL_A `work_report_create_group_assignment` -> post-commit 42501.
 *     - 2B: Uncommitted `direct_entry_revoke_team_leader` (TEAM_B) vs mirror-cleared TL_B `work_report_decide_review` -> post-commit 42501.
 *   Race 3 — Actor Disable + D10 Recovery on Mirror-Cleared Managed ADMIN:
 *     - 3A: Uncommitted `direct_entry_disable_app_user(LIENVU)` vs `work_report_create_delegation` -> post-commit 42501.
 *     - 3B: D10 `direct_entry_enable_app_user(LIENVU)` + mirror re-clear restores full delegated/template access.
 *   Race 4 — Concurrent READ ONLY Burst + Navbar Probe Zero-Write + Live PG18 Catalog Invariants:
 *     - 4A: MVCC non-blocking barrier during uncommitted `disable_app_user(TL_A)` with `lock_timeout = '500ms'` and 0 materialized obligations.
 *     - 4B: 40 concurrent `READ ONLY` RPCs across 4 sessions racing 2 disable/enable cycles -> 0 `40P01`/`25006`/`0A000`/`55P03`.
 *     - 4C: Live PG18 catalog: exact `337` `service_role` RPCs, `0` client/PUBLIC EXECUTE, `provolatile = 's'` & `prosecdef = true` on all 12 internal helpers + 7 STABLE RPCs + probe chain, `ADMIN=21`/`TEAM_LEADER=5`.
 *   Guard 5 — Fail-closed `55000` check when applying #231 against a `NOBYPASSRLS` table owner.
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
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8D2_MIGRATION_NAME = "20261120170000_wp8d2_work_report_access.sql";

const TEAM_A = "58d21000-0000-4000-8000-00000000000a";
const TEAM_B = "58d21000-0000-4000-8000-00000000000b";

const OWNER = { auth: "18d21000-0000-4000-8000-000000000001", app: "28d21000-0000-4000-8000-000000000001", email: "nobita6986@gmail.com", name: "Owner WP8D2 Race" };
const LUANPT = { auth: "18d21000-0000-4000-8000-000000000002", app: "28d21000-0000-4000-8000-000000000002", email: "luanpt@hrpartner.vn", name: "Luan PT" };
const LIENVU = { auth: "18d21000-0000-4000-8000-000000000003", app: "28d21000-0000-4000-8000-000000000003", email: "lienvu@hrpartner.vn", name: "Lien Vu" };
const NGATTT = { auth: "18d21000-0000-4000-8000-000000000004", app: "28d21000-0000-4000-8000-000000000004", email: "ngattt@hrpartner.vn", name: "Nga TTT" };

const TL_A = { auth: "18d21000-0000-4000-8000-000000000005", app: "28d21000-0000-4000-8000-000000000005", recruiter: "38d21000-0000-4000-8000-000000000005", email: "tla.race@hrpartner.vn", name: "TL A Mirror Cleared" };
const TL_B = { auth: "18d21000-0000-4000-8000-000000000006", app: "28d21000-0000-4000-8000-000000000006", recruiter: "38d21000-0000-4000-8000-000000000006", email: "tlb.race@hrpartner.vn", name: "TL B Mirror Cleared" };
const DELEG_GRANTOR = { auth: "18d21000-0000-4000-8000-000000000007", app: "28d21000-0000-4000-8000-000000000007", email: "grantor.race@hrpartner.vn", name: "Delegation Grantor" };
const DELEG_GRANTOR_DIS = { auth: "18d21000-0000-4000-8000-000000000008", app: "28d21000-0000-4000-8000-000000000008", email: "grantordis.race@hrpartner.vn", name: "Delegation Grantor Disable" };
const STAFF_A1 = { auth: "18d21000-0000-4000-8000-000000000009", app: "28d21000-0000-4000-8000-000000000009", recruiter: "38d21000-0000-4000-8000-000000000009", email: "staffa1.race@hrpartner.vn", name: "Staff A1 Move" };
const STAFF_A2 = { auth: "18d21000-0000-4000-8000-000000000010", app: "28d21000-0000-4000-8000-000000000010", recruiter: "38d21000-0000-4000-8000-000000000010", email: "staffa2.race@hrpartner.vn", name: "Staff A2 Delegate" };
const STAFF_A3 = { auth: "18d21000-0000-4000-8000-000000000011", app: "28d21000-0000-4000-8000-000000000011", recruiter: "38d21000-0000-4000-8000-000000000011", email: "staffa3.race@hrpartner.vn", name: "Staff A3 Delegate" };
const STAFF_B1 = { auth: "18d21000-0000-4000-8000-000000000012", app: "28d21000-0000-4000-8000-000000000012", recruiter: "38d21000-0000-4000-8000-000000000012", email: "staffb1.race@hrpartner.vn", name: "Staff B1" };

const ALL_USERS = [
  OWNER, LUANPT, LIENVU, NGATTT,
  TL_A, TL_B, DELEG_GRANTOR, DELEG_GRANTOR_DIS,
  STAFF_A1, STAFF_A2, STAFF_A3, STAFF_B1,
];

const ADMIN_SEED_CAPS = [
  "entry_admin", "entry_team", "entry_own", "entry_create", "submission_create",
  "entry_privileged_edit", "entry_restore", "recruiter_master_manage", "team_master_manage",
  "audit_view", "worker_edit_history_view", "document_upload", "document_view",
  "employment_status.review", "employment_status.apply", "change_request_create",
  "change_review", "employment_status.request", "duplicate_cccd_withdraw",
];
const RECRUITER_SEED_CAPS = [
  "entry_create", "entry_own", "submission_create", "document_upload",
  "document_view", "change_request_create", "employment_status.request",
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

const WP8D2_STABLE_INTERNAL_HELPERS = [
  "public.direct_entry_authz__internal_resolve_effective_grants(uuid)",
  "public.work_report__internal_is_full_admin(uuid)",
  "public.work_report__internal_direct_team_ids(uuid,text)",
  "public.work_report__internal_has_direct_capability(uuid,text)",
  "public.work_report__internal_has_direct_scope(uuid,text,text,uuid)",
  "public.work_report_assert_actor(uuid,uuid,text)",
  "public.work_report_assert_scope(uuid,text,uuid,boolean)",
  "public.work_report__internal_is_delegation_effective(uuid,timestamp with time zone)",
  "public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamp with time zone)",
  "public.work_report__internal_has_any_capability_authority(uuid,text,timestamp with time zone)",
  "public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)",
  "public.work_report__internal_resolve_analytics_scope(uuid,uuid,boolean,uuid,uuid,uuid)",
];

const WP8D2_SERVICE_RPCS = [
  { sig: "public.direct_entry_resolve_actor_context(uuid)", expectStable: true },
  { sig: "public.work_report_has_active_obligations(uuid,uuid)", expectStable: true },
  { sig: "public.work_report_get_submission(uuid,uuid,uuid)", expectStable: true },
  { sig: "public.work_report_list_readable_submissions(uuid,uuid,uuid,uuid,date,date,uuid,uuid,text,text,integer)", expectStable: true },
  { sig: "public.work_report_list_groups(uuid,uuid)", expectStable: true },
  { sig: "public.work_report_list_assignment_options(uuid,uuid,uuid)", expectStable: true },
  { sig: "public.work_report_list_assignments(uuid,uuid,uuid)", expectStable: true },
  { sig: "public.work_report_list_delegations(uuid,uuid)", expectStable: true },
  { sig: "public.work_report_list_pending_reviews(uuid,uuid,uuid,text,integer)", expectStable: true },
  { sig: "public.work_report_get_review_submission(uuid,uuid,uuid)", expectStable: true },
  { sig: "public.work_report_create_group(uuid,uuid,text,text,uuid[],text)", expectStable: false },
  { sig: "public.work_report_update_group(uuid,uuid,uuid,integer,text,text,uuid[],text)", expectStable: false },
  { sig: "public.work_report_set_group_active(uuid,uuid,uuid,integer,boolean,text)", expectStable: false },
  { sig: "public.work_report_ensure_obligations_for_window(uuid,uuid,date)", expectStable: false },
  { sig: "public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text)", expectStable: false },
  { sig: "public.work_report_revoke_delegation(uuid,uuid,uuid,integer,text)", expectStable: false },
  { sig: "public.work_report_decide_review(uuid,uuid,uuid,text,text,integer,text)", expectStable: false },
  { sig: "public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)", expectStable: false },
  { sig: "public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)", expectStable: false },
  { sig: "public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)", expectStable: false },
  { sig: "public.work_report_change_obligation_status(uuid,uuid,uuid,integer,text,text,timestamp with time zone,text)", expectStable: false },
  { sig: "public.work_report_create_template(uuid,uuid,text,text,text,text,jsonb,jsonb,text)", expectStable: false },
  { sig: "public.work_report_update_template_draft(uuid,uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb,text)", expectStable: false },
  { sig: "public.work_report_publish_template(uuid,uuid,uuid,uuid,integer,text)", expectStable: false },
  { sig: "public.work_report_archive_template(uuid,uuid,uuid,integer,text)", expectStable: false },
  { sig: "public.work_report_clone_template_draft(uuid,uuid,uuid,integer,text)", expectStable: false },
];

let seq = 1;
function nextKey(prefix) {
  return `wp8d2_race_${prefix}_${seq++}`;
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
  const code = user.email.split("@")[0].replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 16);
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, 'STAFF', true)",
    [user.recruiter, user.name, code],
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

async function clearLegacyMirrors(client, appUserIds) {
  await client.query("begin");
  try {
    await client.query(
      `delete from public.work_report_team_leader_capability_grants x
        where exists (
          select 1 from public.direct_entry_capability_grants g
           where g.grant_id = x.capability_grant_id
             and g.app_user_id = any($1::uuid[])
        )`,
      [appUserIds],
    );
    await client.query("select pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true)");
    await client.query("delete from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])", [appUserIds]);
    await client.query("delete from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])", [appUserIds]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function createPublishedTemplate(client, actor, code) {
  const created = await serviceRpc(client, "work_report_create_template", [
    actor.auth,
    actor.app,
    code,
    code,
    "WP8D2 Race Template",
    "DAILY",
    JSON.stringify(MINIMAL_TEMPLATE_SCHEMA),
    JSON.stringify(MINIMAL_METRIC_CONTRACT),
    nextKey("tpl"),
  ]);
  await client.query(
    "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
    [created.draft_version_id],
  );
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

test("WP8D-2 Real PostgreSQL 18 Concurrency: Delegation/Grantor/Move/TL-Revoke/Disable lock races, READ ONLY MVCC burst, live ACL/volatility catalog & NOBYPASSRLS guard", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required for concurrency verification");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp8d2-pg-race-"));
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

    const setup = await connect(port, "wp8d2_setup");
    const observer = await connect(port, "wp8d2_observer");
    const w1 = await connect(port, "wp8d2_w1");
    const w2 = await connect(port, "wp8d2_w2");
    const w3 = await connect(port, "wp8d2_w3");
    const r1 = await connect(port, "wp8d2_r1");
    const r2 = await connect(port, "wp8d2_r2");
    const r3 = await connect(port, "wp8d2_r3");
    const r4 = await connect(port, "wp8d2_r4");
    clients.push(setup, observer, w1, w2, w3, r1, r2, r3, r4);
    for (const worker of [w1, w2, w3, r1, r2, r3, r4]) {
      await worker.query("set statement_timeout = '15s'");
    }

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(migrationFiles.length >= 231, "Expected at least 231 migrations through WP8D-2 after WP8C-2");
    assert.equal(
      migrationFiles.indexOf("20261120160000_wp8c2_entry_worker_access.sql"),
      229,
      "WP8C-2 migration must be #230 immediately before WP8D-2",
    );
    assert.equal(
      migrationFiles.indexOf(WP8D2_MIGRATION_NAME),
      230,
      `${WP8D2_MIGRATION_NAME} must be #231 right after WP8C-2`,
    );
    let appliedCount = 0;
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      await setup.query(sql);
      appliedCount += 1;
      if (file === WP8D2_MIGRATION_NAME) break;
    }
    assert.equal(appliedCount, 231, "All 231 migrations through WP8D-2 applied in Real PG18");

    // Seed accounts & teams before WP5 cutover
    await setup.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP8D2_A', 'Race Team A', true), ($2::uuid, 'WP8D2_B', 'Race Team B', true)",
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
    for (const u of [TL_A, STAFF_A1, STAFF_A2, STAFF_A3]) {
      await seedRecruiterAndTeam(setup, u, TEAM_A);
      for (const cap of RECRUITER_SEED_CAPS) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [u.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'own', '2026-01-01', true)",
        [u.app],
      );
    }
    for (const u of [TL_B, STAFF_B1]) {
      await seedRecruiterAndTeam(setup, u, TEAM_B);
      for (const cap of RECRUITER_SEED_CAPS) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [u.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'own', '2026-01-01', true)",
        [u.app],
      );
    }

    // Apply WP5 cutover so every account becomes authz_managed = true
    const plan = await runWp5Cutover(setup, { mode: "dry-run" });
    const cutover = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(cutover.status, "APPLIED");

    // Designate TL_A on TEAM_A and TL_B on TEAM_B
    const { rows: [dates] } = await setup.query(
      "select public.direct_entry_authorization_date()::text as today, (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as vn_today",
    );
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_A, TL_A.app, dates.today, 1, "Designate TL A", nextKey("des_tla"),
    ]);
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_B, TL_B.app, dates.today, 1, "Designate TL B", nextKey("des_tlb"),
    ]);

    // Grant direct WP5 delegation authority to DELEG_GRANTOR & DELEG_GRANTOR_DIS
    for (const grantor of [DELEG_GRANTOR, DELEG_GRANTOR_DIS]) {
      for (const cap of ["report_delegate", "report_review", "report_assign"]) {
        await setup.query(
          `insert into public.authz_direct_capability_grants
             (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
           values ($1::uuid, $2, 'ALL', null, 'EXCEPTION_GRANT', 'Race grantor authority', $3::uuid)`,
          [grantor.app, cap, OWNER.app],
        );
      }
    }

    // CLEAR ALL LEGACY MIRRORS FOR EVERY MANAGED ACCOUNT (except TL_B which stays canonical-intact
    // for Race 2B `direct_entry_revoke_team_leader` lifecycle parity, matching WP8C-1's TL_2 pattern).
    await clearLegacyMirrors(
      setup,
      ALL_USERS.filter((u) => u.app !== TL_B.app).map((u) => u.app),
    );

    // Create 2 published review-required templates & seed submitted PENDING_REVIEW reports
    const t1 = await createPublishedTemplate(setup, OWNER, "RACE_T1");
    const t2 = await createPublishedTemplate(setup, OWNER, "RACE_T2");

    await serviceRpc(setup, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, t1.template_id, "TEAM", null, TEAM_A, null,
      "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_t1_a"),
    ]);
    await serviceRpc(setup, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, t1.template_id, "TEAM", null, TEAM_B, null,
      "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_t1_b"),
    ]);
    await serviceRpc(setup, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, t2.template_id, "USER", STAFF_A1.app, null, null,
      "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_t2_a1"),
    ]);

    const { rows: [obA1T1] } = await setup.query(
      "select obligation_id from public.work_report_obligations where assignee_app_user_id = $1::uuid and template_id = $2::uuid",
      [STAFF_A1.app, t1.template_id],
    );
    const { rows: [obA1T2] } = await setup.query(
      "select obligation_id from public.work_report_obligations where assignee_app_user_id = $1::uuid and template_id = $2::uuid",
      [STAFF_A1.app, t2.template_id],
    );
    const { rows: [obB1T1] } = await setup.query(
      "select obligation_id from public.work_report_obligations where assignee_app_user_id = $1::uuid and template_id = $2::uuid",
      [STAFF_B1.app, t1.template_id],
    );

    const subA1T1 = await serviceRpc(setup, "work_report_submit", [
      STAFF_A1.auth, STAFF_A1.app, obA1T1.obligation_id, JSON.stringify({ calls_made: 10 }), null, nextKey("sub_a1t1"),
    ]);
    const subA1T2 = await serviceRpc(setup, "work_report_submit", [
      STAFF_A1.auth, STAFF_A1.app, obA1T2.obligation_id, JSON.stringify({ calls_made: 15 }), null, nextKey("sub_a1t2"),
    ]);
    const subB1T1 = await serviceRpc(setup, "work_report_submit", [
      STAFF_B1.auth, STAFF_B1.app, obB1T1.obligation_id, JSON.stringify({ calls_made: 20 }), null, nextKey("sub_b1t1"),
    ]);

    // =========================================================================
    // RACE 1A: Uncommitted work_report_revoke_delegation (report_review)
    //          racing STAFF_A2 work_report_decide_review -> post-commit 42501
    // =========================================================================
    const delRevA2 = await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, "report_review", STAFF_A2.app,
      t1.template_id, "team", TEAM_A, null, null, nextKey("del_rev_a2"),
    ]);
    await w1.query("begin");
    await serviceRpcInTx(w1, "work_report_revoke_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, delRevA2.delegation_id, delRevA2.version, nextKey("rev_del_1a"),
    ]);
    const r1aPromise = asSettled(
      serviceRpc(w2, "work_report_decide_review", [
        STAFF_A2.auth, STAFF_A2.app, obA1T1.obligation_id, "APPROVED", null, subA1T1.version, nextKey("decide_1a"),
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r1aRes = await r1aPromise;
    assert.equal(r1aRes.status, "rejected", "Race 1A review must fail closed after delegation revoke");
    assert.notEqual(r1aRes.reason.code, "40P01", "Race 1A must never deadlock");
    assert.equal(r1aRes.reason.code, "42501", `Race 1A expected 42501, got ${r1aRes.reason.code}: ${r1aRes.reason.message}`);

    const { rows: [subA1T1After1a] } = await observer.query(
      "select state, version from public.work_report_submissions where obligation_id = $1::uuid",
      [obA1T1.obligation_id],
    );
    assert.equal(subA1T1After1a.state, "PENDING_REVIEW", "Race 1A rejected review must leave submission PENDING_REVIEW");

    // =========================================================================
    // RACE 1B: Uncommitted work_report_revoke_delegation (report_assign)
    //          racing STAFF_A2 work_report_create_assignment -> post-commit 42501
    // =========================================================================
    const delAsgA2 = await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, "report_assign", STAFF_A2.app,
      t2.template_id, "team", TEAM_A, null, null, nextKey("del_asg_a2"),
    ]);
    const asgCountBefore1b = (
      await observer.query("select count(*)::int as n from public.work_report_assignments where template_id = $1::uuid", [t2.template_id])
    ).rows[0].n;
    await w1.query("begin");
    await serviceRpcInTx(w1, "work_report_revoke_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, delAsgA2.delegation_id, delAsgA2.version, nextKey("rev_del_1b"),
    ]);
    const r1bPromise = asSettled(
      serviceRpc(w2, "work_report_create_assignment", [
        STAFF_A2.auth, STAFF_A2.app, t2.template_id, "USER", STAFF_A3.app, null, null,
        "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_1b"),
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r1bRes = await r1bPromise;
    assert.equal(r1bRes.status, "rejected", "Race 1B assign must fail closed after delegation revoke");
    assert.notEqual(r1bRes.reason.code, "40P01", "Race 1B must never deadlock");
    assert.equal(r1bRes.reason.code, "42501", `Race 1B expected 42501, got ${r1bRes.reason.code}: ${r1bRes.reason.message}`);
    const asgCountAfter1b = (
      await observer.query("select count(*)::int as n from public.work_report_assignments where template_id = $1::uuid", [t2.template_id])
    ).rows[0].n;
    assert.equal(asgCountAfter1b, asgCountBefore1b, "Race 1B must create 0 assignments");

    // =========================================================================
    // RACE 1C: Uncommitted direct_entry_disable_app_user on GRANTOR (DELEG_GRANTOR_DIS)
    //          racing STAFF_A3 delegated decide_review AND create_assignment
    // =========================================================================
    await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR_DIS.auth, DELEG_GRANTOR_DIS.app, "report_review", STAFF_A3.app,
      t2.template_id, "team", TEAM_A, null, null, nextKey("del_rev_a3"),
    ]);
    await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR_DIS.auth, DELEG_GRANTOR_DIS.app, "report_assign", STAFF_A3.app,
      t2.template_id, "team", TEAM_A, null, null, nextKey("del_asg_a3"),
    ]);
    const grantorDisVer = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [DELEG_GRANTOR_DIS.app])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
      OWNER.auth, OWNER.app, DELEG_GRANTOR_DIS.app, grantorDisVer, "Race 1C disable grantor", nextKey("dis_grantor_1c"),
    ]);
    const r1cReviewPromise = asSettled(
      serviceRpc(w2, "work_report_decide_review", [
        STAFF_A3.auth, STAFF_A3.app, obA1T2.obligation_id, "APPROVED", null, subA1T2.version, nextKey("decide_1c"),
      ]),
    );
    const r1cAssignPromise = asSettled(
      serviceRpc(w3, "work_report_create_assignment", [
        STAFF_A3.auth, STAFF_A3.app, t2.template_id, "USER", STAFF_A2.app, null, null,
        "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_1c"),
      ]),
    );
    await Promise.all([
      waitUntilBlocked(observer, "wp8d2_w2"),
      waitUntilBlocked(observer, "wp8d2_w3"),
    ]);
    await w1.query("commit");
    const [r1cReviewRes, r1cAssignRes] = await Promise.all([r1cReviewPromise, r1cAssignPromise]);
    for (const [label, res] of [["Race 1C review", r1cReviewRes], ["Race 1C assign", r1cAssignRes]]) {
      assert.equal(res.status, "rejected", `${label} must fail closed after grantor disable`);
      assert.notEqual(res.reason.code, "40P01", `${label} must never deadlock`);
      assert.equal(res.reason.code, "42501", `${label} expected 42501, got ${res.reason.code}: ${res.reason.message}`);
    }

    // =========================================================================
    // RACE 2A: Uncommitted direct_entry_move_team_membership (STAFF_A1: TEAM_A -> TEAM_B)
    //          racing mirror-cleared TL_A work_report_create_group_assignment -> post-commit 42501
    // =========================================================================
    const grpA = await serviceRpc(setup, "work_report_create_group", [
      TL_A.auth, TL_A.app, "Nhóm Race A", null, [STAFF_A1.app], nextKey("grp_a"),
    ]);
    const staffA1RecVer = (
      await setup.query("select version from public.recruiters where recruiter_id = $1::uuid", [STAFF_A1.recruiter])
    ).rows[0].version;
    const grpAsgCountBefore = (
      await observer.query("select count(*)::int as n from public.work_report_assignments where target_group_id = $1::uuid", [grpA.group_id])
    ).rows[0].n;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_move_team_membership", [
      OWNER.auth, OWNER.app, STAFF_A1.recruiter, TEAM_B, dates.today, staffA1RecVer, "Race 2A move STAFF_A1 to TEAM_B", nextKey("move_a1"),
    ]);
    const r2aPromise = asSettled(
      serviceRpc(w2, "work_report_create_group_assignment", [
        TL_A.auth, TL_A.app, t1.template_id, grpA.group_id, "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("grp_asg_2a"),
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r2aRes = await r2aPromise;
    assert.equal(r2aRes.status, "rejected", "Race 2A group assignment must fail closed after member moves to TEAM_B");
    assert.notEqual(r2aRes.reason.code, "40P01", "Race 2A must never deadlock");
    assert.equal(r2aRes.reason.code, "42501", `Race 2A expected 42501, got ${r2aRes.reason.code}: ${r2aRes.reason.message}`);
    const grpAsgCountAfter = (
      await observer.query("select count(*)::int as n from public.work_report_assignments where target_group_id = $1::uuid", [grpA.group_id])
    ).rows[0].n;
    assert.equal(grpAsgCountAfter, grpAsgCountBefore, "Race 2A must create 0 group assignments");

    // =========================================================================
    // RACE 2B: Uncommitted direct_entry_revoke_team_leader (TEAM_B)
    //          racing mirror-cleared TL_B work_report_decide_review -> post-commit 42501
    // =========================================================================
    const teamBVer = (
      await setup.query("select version from public.teams where team_id = $1::uuid", [TEAM_B])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_revoke_team_leader", [
      OWNER.auth, OWNER.app, TEAM_B, null, teamBVer, "Race 2B revoke TL_B", nextKey("rev_tlb"),
    ]);
    const r2bPromise = asSettled(
      serviceRpc(w2, "work_report_decide_review", [
        TL_B.auth, TL_B.app, obB1T1.obligation_id, "APPROVED", null, subB1T1.version, nextKey("decide_2b"),
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r2bRes = await r2bPromise;
    assert.equal(r2bRes.status, "rejected", "Race 2B review must fail closed after TL_B revoked");
    assert.notEqual(r2bRes.reason.code, "40P01", "Race 2B must never deadlock");
    assert.equal(r2bRes.reason.code, "42501", `Race 2B expected 42501, got ${r2bRes.reason.code}: ${r2bRes.reason.message}`);
    const { rows: [subB1After2b] } = await observer.query(
      "select state from public.work_report_submissions where obligation_id = $1::uuid",
      [obB1T1.obligation_id],
    );
    assert.equal(subB1After2b.state, "PENDING_REVIEW", "Race 2B rejected review must leave submission PENDING_REVIEW");

    // =========================================================================
    // RACE 1D: Uncommitted work_report_revoke_delegation (report_assign) racing
    //          work_report_set_assignment_state, work_report_change_obligation_status
    //          AND work_report_ensure_obligations_for_window -> post-commit 42501
    // =========================================================================
    const delAsg1d = await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, "report_assign", STAFF_A2.app,
      t1.template_id, "team", TEAM_A, null, null, nextKey("del_asg_1d"),
    ]);
    const asg1d = await serviceRpc(setup, "work_report_create_assignment", [
      STAFF_A2.auth, STAFF_A2.app, t1.template_id, "USER", STAFF_A3.app, null, null,
      "DAILY", true, 0, "23:59:59", false, dates.vn_today, null, nextKey("asg_1d_seed"),
    ]);
    const { rows: [obA3T1] } = await setup.query(
      "select obligation_id, version from public.work_report_obligations where assignee_app_user_id = $1::uuid and template_id = $2::uuid",
      [STAFF_A3.app, t1.template_id],
    );
    await w1.query("begin");
    await serviceRpcInTx(w1, "work_report_revoke_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, delAsg1d.delegation_id, delAsg1d.version, nextKey("rev_del_1d"),
    ]);
    const r1dStatePromise = asSettled(
      serviceRpc(w2, "work_report_set_assignment_state", [
        STAFF_A2.auth, STAFF_A2.app, asg1d.assignment_id, asg1d.version, "PAUSED", nextKey("state_1d"),
      ]),
    );
    const r1dObPromise = asSettled(
      serviceRpc(w3, "work_report_change_obligation_status", [
        STAFF_A2.auth, STAFF_A2.app, obA3T1.obligation_id, obA3T1.version, "EXEMPT", "Race 1D exempt", null, nextKey("ob_1d"),
      ]),
    );
    await Promise.all([
      waitUntilBlocked(observer, "wp8d2_w2"),
      waitUntilBlocked(observer, "wp8d2_w3"),
    ]);
    await w1.query("commit");
    const [r1dStateRes, r1dObRes] = await Promise.all([r1dStatePromise, r1dObPromise]);
    for (const [label, res] of [["Race 1D set_assignment_state", r1dStateRes], ["Race 1D change_obligation_status", r1dObRes]]) {
      assert.equal(res.status, "rejected", `${label} must fail closed after delegation revoke`);
      assert.notEqual(res.reason.code, "40P01", `${label} must never deadlock`);
      assert.equal(res.reason.code, "42501", `${label} expected 42501, got ${res.reason.code}: ${res.reason.message}`);
    }

    // 1E: Uncommitted work_report_revoke_delegation (report_assign) racing work_report_ensure_obligations_for_window
    const delAsg1e = await serviceRpc(setup, "work_report_create_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, "report_assign", STAFF_A2.app,
      t1.template_id, "team", TEAM_A, null, null, nextKey("del_asg_1e"),
    ]);
    await w1.query("begin");
    await serviceRpcInTx(w1, "work_report_revoke_delegation", [
      DELEG_GRANTOR.auth, DELEG_GRANTOR.app, delAsg1e.delegation_id, delAsg1e.version, nextKey("rev_del_1e"),
    ]);
    const r1ePromise = asSettled(
      serviceRpc(w2, "work_report_ensure_obligations_for_window", [
        STAFF_A2.auth, STAFF_A2.app, dates.vn_today,
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r1eRes = await r1ePromise;
    assert.equal(r1eRes.status, "rejected", "Race 1E ensure_obligations must fail closed after delegation revoke");
    assert.notEqual(r1eRes.reason.code, "40P01");
    assert.equal(r1eRes.reason.code, "42501", `Race 1E expected 42501, got ${r1eRes.reason.code}: ${r1eRes.reason.message}`);

    // =========================================================================
    // RACE 3: Uncommitted disable_app_user(LIENVU mirror-cleared ADMIN)
    //         racing work_report_create_delegation AND work_report_archive_template
    //         -> post-commit 42501, then D10 enable + mirror clear restores full authority!
    // =========================================================================
    const t3 = await createPublishedTemplate(setup, OWNER, "RACE_T3");
    const { rows: [t3Row] } = await setup.query(
      "select version from public.work_report_templates where template_id = $1::uuid",
      [t3.template_id],
    );
    const lienVer = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [LIENVU.app])
    ).rows[0].version;

    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
      OWNER.auth, OWNER.app, LIENVU.app, lienVer, "Race 3A disable LIENVU", nextKey("dis_lien"),
    ]);
    const r3aPromise = asSettled(
      serviceRpc(w2, "work_report_create_delegation", [
        LIENVU.auth, LIENVU.app, "report_review", STAFF_A2.app, t1.template_id, "team", TEAM_A, null, null, nextKey("lien_del_3a"),
      ]),
    );
    const r3cPromise = asSettled(
      serviceRpc(w3, "work_report_archive_template", [
        LIENVU.auth, LIENVU.app, t3.template_id, t3Row.version, nextKey("lien_arch_3c"),
      ]),
    );
    await Promise.all([
      waitUntilBlocked(observer, "wp8d2_w2"),
      waitUntilBlocked(observer, "wp8d2_w3"),
    ]);
    await w1.query("commit");
    const [r3aRes, r3cRes] = await Promise.all([r3aPromise, r3cPromise]);
    for (const [label, res] of [["Race 3A create_delegation", r3aRes], ["Race 3C archive_template", r3cRes]]) {
      assert.equal(res.status, "rejected", `${label} must fail closed after ADMIN disable`);
      assert.notEqual(res.reason.code, "40P01");
      assert.equal(res.reason.code, "42501", `${label} expected 42501, got ${res.reason.code}: ${res.reason.message}`);
    }

    // 3B: D10 enable + mirror re-clear restores LIENVU immediately
    const lienVerDisabled = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [LIENVU.app])
    ).rows[0].version;
    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth, OWNER.app, LIENVU.app, lienVerDisabled, "Race 3B D10 re-enable LIENVU", nextKey("en_lien"),
    ]);
    await clearLegacyMirrors(setup, [LIENVU.app]);
    const lienDelAfter3b = await serviceRpc(setup, "work_report_create_delegation", [
      LIENVU.auth, LIENVU.app, "report_review", STAFF_A2.app, t1.template_id, "team", TEAM_A, null, null, nextKey("lien_del_3b"),
    ]);
    assert.equal(lienDelAfter3b.status, "ACTIVE", "Mirror-cleared ADMIN regains full Work Reports authority after D10 enable");

    // 2C: Uncommitted move_team_membership on team-scoped review delegate (STAFF_A2: TEAM_A -> TEAM_B)
    //     racing STAFF_A2 work_report_decide_review(obA1T1) -> blocks on Tier 3 recruiters, post-commit 42501!
    const staffA2RecVer = (
      await setup.query("select version from public.recruiters where recruiter_id = $1::uuid", [STAFF_A2.recruiter])
    ).rows[0].version;
    await w1.query("begin");
    await serviceRpcInTx(w1, "direct_entry_move_team_membership", [
      OWNER.auth, OWNER.app, STAFF_A2.recruiter, TEAM_B, dates.today, staffA2RecVer, "Race 2C move review delegate STAFF_A2 out of TEAM_A", nextKey("move_a2_2c"),
    ]);
    const r2cPromise = asSettled(
      serviceRpc(w2, "work_report_decide_review", [
        STAFF_A2.auth, STAFF_A2.app, obA1T1.obligation_id, "APPROVED", null, subA1T1.version, nextKey("decide_2c"),
      ]),
    );
    await waitUntilBlocked(observer, "wp8d2_w2");
    await w1.query("commit");
    const r2cRes = await r2cPromise;
    assert.equal(r2cRes.status, "rejected", "Race 2C decide_review must fail closed after review delegate moves out of TEAM_A");
    assert.notEqual(r2cRes.reason.code, "40P01");
    assert.equal(r2cRes.reason.code, "42501", `Race 2C expected 42501, got ${r2cRes.reason.code}: ${r2cRes.reason.message}`);

    // =========================================================================
    // RACE 4: Concurrent STABLE READ ONLY burst + Navbar Probe 0-write guarantee
    //         + Live PG18 Catalog ACL, Volatility & Role Bundle Invariants
    // =========================================================================
    const obCountBefore4a = (await observer.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
    const tlAVerBefore4a = (
      await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_A.app])
    ).rows[0].version;

    // 4A: Deterministic MVCC non-blocking barrier during uncommitted disable(TL_A)
    await w1.query("begin");
    try {
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth, OWNER.app, TL_A.app, tlAVerBefore4a, "Race 4A MVCC READ ONLY barrier", nextKey("dis_tla_4a"),
      ]);
      const [probeDuring, ctxDuring, subsDuring, pendDuring, overDuring] = await Promise.all([
        serviceRpcReadOnly(r1, "work_report_has_active_obligations", [TL_A.auth, TL_A.app]),
        serviceRpcReadOnly(r2, "direct_entry_resolve_actor_context", [TL_A.auth]),
        serviceRpcReadOnly(r3, "work_report_list_readable_submissions", [TL_A.auth, TL_A.app]),
        serviceRpcReadOnly(r4, "work_report_list_pending_reviews", [TL_A.auth, TL_A.app, null, null, 50]),
        serviceRpcReadOnly(r1, "work_report_analytics_overview", [TL_A.auth, TL_A.app, t1.template_id, null, null, null, null, null, "provisional_included"]),
      ]);
      assert.equal(typeof probeDuring.has_active_obligations, "boolean");
      assert.equal(ctxDuring.enabled, true);
      assert.equal(subsDuring.effective_scope.kind, "team");
      assert.ok(Array.isArray(pendDuring.items));
      assert.equal(overDuring.effective_scope.kind, "team");
    } finally {
      await w1.query("rollback");
    }
    const obCountAfter4a = (await observer.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
    assert.equal(obCountAfter4a, obCountBefore4a, "READ ONLY barrier & probe must materialize 0 obligations");

    // 4B: 40 concurrent READ ONLY RPCs across 4 sessions racing 2 full disable/enable cycles on TL_A
    let totalBurstReads = 0;
    const assertCleanReadError = (label, err) => {
      assert.notEqual(err.code, "0A000", `${label} must NEVER raise 0A000`);
      assert.notEqual(err.code, "40P01", `${label} must NEVER deadlock`);
      assert.notEqual(err.code, "25006", `${label} must NEVER write in READ ONLY tx`);
      assert.notEqual(err.code, "55P03", `${label} must NEVER block on lock_timeout`);
      assert.equal(err.code, "42501", `${label} unexpected SQLSTATE ${err.code}: ${err.message}`);
    };

    const burstOutcomes = await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i += 1) {
          try {
            const p = await serviceRpcReadOnly(r1, "work_report_has_active_obligations", [TL_A.auth, TL_A.app]);
            assert.equal(typeof p.has_active_obligations, "boolean");
          } catch (err) {
            assertCleanReadError("work_report_has_active_obligations", err);
          }
          totalBurstReads += 1;
        }
        return "r1-ok";
      })(),
      (async () => {
        for (let i = 0; i < 10; i += 1) {
          const ctx = await serviceRpcReadOnly(r2, "direct_entry_resolve_actor_context", [TL_A.auth]);
          assert.equal(typeof ctx.enabled, "boolean");
          totalBurstReads += 1;
        }
        return "r2-ok";
      })(),
      (async () => {
        for (let i = 0; i < 10; i += 1) {
          try {
            const subs = await serviceRpcReadOnly(r3, "work_report_list_readable_submissions", [TL_A.auth, TL_A.app]);
            assert.equal(subs.effective_scope.kind, "team");
          } catch (err) {
            assertCleanReadError("work_report_list_readable_submissions", err);
          }
          totalBurstReads += 1;
        }
        return "r3-ok";
      })(),
      (async () => {
        for (let i = 0; i < 10; i += 1) {
          try {
            const ov = await serviceRpcReadOnly(r4, "work_report_analytics_overview", [
              TL_A.auth, TL_A.app, t1.template_id, null, null, null, null, null, "provisional_included",
            ]);
            assert.equal(ov.effective_scope.kind, "team");
          } catch (err) {
            assertCleanReadError("work_report_analytics_overview", err);
          }
          totalBurstReads += 1;
        }
        return "r4-ok";
      })(),
      (async () => {
        let ver = tlAVerBefore4a;
        for (let cycle = 1; cycle <= 2; cycle += 1) {
          const dis = await serviceRpc(w1, "direct_entry_disable_app_user", [
            OWNER.auth, OWNER.app, TL_A.app, ver, `Race 4B disable ${cycle}`, nextKey(`r4b_dis_${cycle}`),
          ]);
          ver = dis.version;
          const en = await serviceRpc(w1, "direct_entry_enable_app_user", [
            OWNER.auth, OWNER.app, TL_A.app, ver, `Race 4B enable ${cycle}`, nextKey(`r4b_en_${cycle}`),
          ]);
          ver = en.version;
        }
        return "mutator-ok";
      })(),
    ]);
    assert.deepEqual(burstOutcomes, ["r1-ok", "r2-ok", "r3-ok", "r4-ok", "mutator-ok"]);
    assert.equal(totalBurstReads, 40);
    const obCountAfter4b = (await observer.query("select count(*)::int as n from public.work_report_obligations")).rows[0].n;
    assert.equal(obCountAfter4b, obCountBefore4a, "40 READ ONLY burst calls must materialize 0 obligations");

    // 4C: Live PG18 catalog ACL, volatility & role bundle invariants
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
    assert.equal(catalogSummary.service_rpc_count, 337, "Live PG18 catalog must have exact 337 service_role RPCs (+0 new)");
    assert.equal(catalogSummary.exposed_client_or_public_count, 0, "Live PG18 catalog must expose 0 Mini BI routines to PUBLIC/anon/authenticated");

    const { rows: [roleCounts] } = await setup.query(
      `select
         count(*) filter (where role_code = 'ADMIN')::int as admin_caps,
         count(*) filter (where role_code = 'TEAM_LEADER')::int as tl_caps
       from public.authz_role_capabilities`,
    );
    assert.equal(roleCounts.admin_caps, 21, "ADMIN bundle must remain exact 21 capabilities");
    assert.equal(roleCounts.tl_caps, 5, "TEAM_LEADER bundle must remain exact 5 capabilities");

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

    for (const sig of WP8D2_STABLE_INTERNAL_HELPERS) {
      const row = await inspectFn(sig);
      assert.equal(row.provolatile, "s", `${sig} must be STABLE`);
      assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"), `${sig} search_path`);
      assert.equal(row.public_exec, false, `${sig} PUBLIC EXECUTE revoked`);
      assert.equal(row.anon_exec, false, `${sig} anon EXECUTE revoked`);
      assert.equal(row.auth_exec, false, `${sig} authenticated EXECUTE revoked`);
      assert.equal(row.service_exec, false, `${sig} internal helper service_role EXECUTE revoked`);
    }

    for (const { sig, expectStable } of WP8D2_SERVICE_RPCS) {
      const row = await inspectFn(sig);
      if (expectStable) {
        assert.equal(row.provolatile, "s", `${sig} must be STABLE`);
      }
      assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.ok(Array.isArray(row.proconfig) && row.proconfig.includes("search_path=pg_catalog, public"), `${sig} search_path`);
      assert.equal(row.public_exec, false, `${sig} PUBLIC EXECUTE revoked`);
      assert.equal(row.anon_exec, false, `${sig} anon EXECUTE revoked`);
      assert.equal(row.auth_exec, false, `${sig} authenticated EXECUTE revoked`);
      assert.equal(row.service_exec, true, `${sig} must grant EXECUTE to service_role`);
    }

    // =========================================================================
    // GUARD 5: NOBYPASSRLS table owner causes migration #231 self-check to FAIL CLOSED (55000)
    // =========================================================================
    await setup.query("create role wp8d2_nobypass_owner nologin nosuperuser nobypassrls");
    await setup.query("create database wp8d2_nobypass_db");
    const guardClient = await connect(port, "wp8d2_guard", "wp8d2_nobypass_db");
    clients.push(guardClient);
    await guardClient.query("create schema auth; create table auth.users (id uuid primary key, email text);");
    for (const file of migrationFiles) {
      if (file === WP8D2_MIGRATION_NAME) break;
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      await guardClient.query(sql);
    }
    // Reassign public.direct_entry_app_users to a NOBYPASSRLS role so $align_wp8d2$ aligns
    // routine owners to it and $check_wp8d2$ must abort the migration with SQLSTATE 55000!
    await guardClient.query("grant usage, create on schema public to wp8d2_nobypass_owner");
    await guardClient.query("alter table public.direct_entry_app_users owner to wp8d2_nobypass_owner");
    const wp8d2Sql = await readFile(path.join(MIGRATION_DIR, WP8D2_MIGRATION_NAME), "utf8");
    await assert.rejects(
      guardClient.query(wp8d2Sql),
      (err) => err.code === "55000" && err.message.includes("WP8D2"),
      "Migration #231 MUST fail closed with 55000 when routine owner lacks SUPERUSER/BYPASSRLS",
    );
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
