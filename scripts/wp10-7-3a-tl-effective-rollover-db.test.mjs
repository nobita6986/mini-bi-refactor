/**
 * WP10-7 Slice 3A — Retire Legacy Rollover Branch from
 * `public.direct_entry__internal_team_leader_assignment_effective(uuid, date)`
 * Isolated Real PostgreSQL 18 Upgrade, Preflight & Lifecycle Acceptance Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Covers:
 *   1. Preflight SQL & Fail-Closed Block vs Ready Upgrade (0..pre-3A -> 3A):
 *      - Executes both queries of `scripts/sql/wp10-7-3a-tl-effective-rollover-preflight.sql`.
 *      - Verifies a legitimately closed historical assignment (`is_current=false, valid_from=month-start, valid_to=today-1`
 *        with legacy `scope_grants`, `capability_grants`, `team_leader_revisions`) produces `ready_for_slice_3a=true`,
 *        `detailRows=[]`, zero drift, and is NOT blocked by migration 3A.
 *      - Verifies all 3 blocked drift cases reject with `WP10_7_3A_PREFLIGHT_BLOCKED` (`P0001`):
 *        (a) live open legacy rollover (`valid_to IS NULL`),
 *        (b) future-ending legacy rollover (`valid_to=today+2`),
 *        (c) anomalous closed row missing the legacy triad (`old=false, new=true` at historical dates).
 *      - Cleans injected rows -> verifies `ready_for_slice_3a=true` -> applies 3A cleanly.
 *   2. Post-3A Catalog & ACL + Preserved Function Semantics + Rollover Cut:
 *      - Verifies `pg_get_functiondef` has zero references to legacy grant/revision tables and
 *        `has_function_privilege` is `false` for `public`, `anon`, `authenticated`, `service_role`.
 *      - Re-inserts synthetic open (`valid_to IS NULL`) and future-ending (`valid_to=today+2`) legacy rollover rows
 *        plus an open `is_current=false` row (deactivate-then-reactivate pattern) post-3A -> verifies `false` at `today` and `today-2`.
 *      - Verifies all preserved conditions on `is_current=true` rows (`valid_from <= as_of`, `as_of < valid_to`,
 *        `valid_to > valid_from`, `not suspended_by_account_disable`, `teams.active & code <> '__system_vendor__'`,
 *        `u.enabled`, `r.active`) and future `p_as_of` preservation (`today+5`, `today+10`).
 *   3. Real RPC Team Leader Lifecycle + Account Disable/Enable + #42 Team Move/Unassign +
 *      Leave/Attendance Routing + Work Reports Authority:
 *      - Designate `leader1` -> `resolve_actor_context`, Work Reports, Leave & Attendance routing + approvals.
 *      - Disable/Enable `leader1` -> effectiveness/context cleared + #42 guard still blocks move/unassign while
 *        suspended-restorable -> re-enable restores `TEAM_LEADER` + Work Reports + Leave routing.
 *      - #42 active guard + Replace `leader1` -> `leader2`: `leader1` loses `TEAM_LEADER`/Work Reports scope
 *        and cannot `CANCEL_APPROVED` Leave request; `leader1` can move teams; `leader2` gains authority & routes.
 *      - Revoke `leader2` -> loses authority, Leave/Attendance falls back to `ADMIN_BOD_FALLBACK`, `leader2` can unassign.
 *   4. Simulated 2-Day Business Clock (`D` designate -> `D+1` revoke) + `leave_management_monthly_report` + Edge Cases:
 *      - Overrides `direct_entry_authorization_date()` across month-end `D` and next-month `D+1`, always restoring in `finally`.
 *      - Verifies historical routing (`TEAM_LEADER` at `D`) and current routing (`ADMIN_BOD_FALLBACK` at `D+1`),
 *        `leave_management_monthly_report` at `D` and `D+1`, `resolve_actor_context` at `D+1`, same-day cancellation
 *        marker (`valid_from = valid_to = D`), `disable`/`enable` interaction, `suspended_by_account_disable`,
 *        and post-3B closed assignment without legacy grants.
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

import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import { computeDesignateHeadFingerprint } from "../src/lib/departments/department-contract.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_7_3A_MIGRATION_NAME =
  "20261126223000_wp10_7_3a_retire_tl_effective_legacy_rollover.sql";
const PREFLIGHT_SQL_PATH = path.join(
  ROOT,
  "scripts",
  "sql",
  "wp10-7-3a-tl-effective-rollover-preflight.sql",
);

const EXPECTED_TL_GUARD_MSG = "recruiter holds active or restorable team leader assignment";

const OWNER = {
  auth: "94200000-0000-4000-8000-00000000a001",
  app: "94200000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-3A",
};
const LUANPT = {
  auth: "94200000-0000-4000-8000-00000000a002",
  app: "94200000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "94200000-0000-4000-8000-00000000a003",
  app: "94200000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "94200000-0000-4000-8000-00000000a004",
  app: "94200000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const VALID_SCHEMA = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
const VALID_METRIC_CONTRACT = buildWorkReportMetricContract(VALID_SCHEMA);
const SUBMIT_PAYLOAD = {
  calls_made: 12,
  interested_candidates: 4,
  workers_started: 1,
  notes: "WP10-7-3A report",
};

let seq = 1;
function nextUuid() {
  return `94210000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_7_3a_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
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

function runBin(file, args, { ignoreOutput = false } = {}) {
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

async function serviceQuery(client, sql, params = []) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '10s'; set local role service_role",
  );
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpc(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
  const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
}

async function seedLegacyAdmin(client, user) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedPlainAccount(client, loginPrefix, displayName) {
  const authId = nextUuid();
  const appId = nextUuid();
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    authId,
    `${loginPrefix}@hrpartner.local`,
  ]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [appId, authId, displayName],
  );
  return { auth: authId, app: appId, login: loginPrefix, name: displayName };
}

function parsePreflightQueries(rawSql) {
  const stripped = rawSql
    .replace(/^\s*BEGIN\s+TRANSACTION\s+READ\s+ONLY\s*;/im, "")
    .replace(/ROLLBACK\s*;\s*$/im, "")
    .trim();
  const splitMarker = "-- Query 2: Exact Mismatch Inspector";
  const markerIdx = stripped.indexOf(splitMarker);
  assert.ok(markerIdx > 0, "Preflight SQL must contain Query 2 marker");
  const query1 = stripped.slice(0, markerIdx).trim().replace(/;\s*$/, "");
  const query2 = stripped.slice(markerIdx).trim().replace(/;\s*$/, "");
  assert.ok(query1.length > 0 && query2.length > 0, "Both preflight queries must be non-empty");
  return { query1, query2 };
}

function stripOuterBeginCommit(sql) {
  return sql
    .replace(/^\s*(?:--[^\n]*\n|\s)*begin\s*;/i, "")
    .replace(/commit\s*;\s*$/i, "")
    .trim();
}

test("WP10-7 Slice 3A (PG18): Preflight block/ready, catalog & ACL, preserved effectiveness semantics & rollover cut, and full TL RPC lifecycle", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-3a-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "wp10-7-3a-setup");
    const observer = await connect(port, "wp10-7-3a-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const slice3aIdx = files.indexOf(WP10_7_3A_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(slice3aIdx > groupsIdx, `${WP10_7_3A_MIGRATION_NAME} must exist after PR28`);
    const pre3aCutoffIdx = slice3aIdx - 1;

    // -------------------------------------------------------------------------
    // Bootstrap baseline BEFORE Slice 3A
    // -------------------------------------------------------------------------
    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i <= pre3aCutoffIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select public.direct_entry_authorization_date() as today_vn
      ),
      workdays as (
        select gs::date as wd
          from d, generate_series(d.today_vn - 20, d.today_vn - 1, interval '1 day') as gs
         where extract(dow from gs) <> 0
         order by gs desc
      )
      select today_vn::text as today,
             (today_vn - 3)::text as today_minus_3,
             (today_vn - 2)::text as today_minus_2,
             (today_vn - 1)::text as today_minus_1,
             (today_vn + 1)::text as today_plus_1,
             (today_vn + 2)::text as today_plus_2,
             (today_vn + 4)::text as today_plus_4,
             (today_vn + 5)::text as today_plus_5,
             (today_vn + 10)::text as today_plus_10,
             (
               case
                 when extract(day from today_vn)::int >= 3
                   then date_trunc('month', today_vn)::date
                 else date_trunc('month', (today_vn - 2)::date)::date
               end
             )::text as hist_month_start,
             (select wd::text from workdays limit 1) as yesterday_vn,
             extract(year from today_vn)::int as leave_year,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then date_trunc('month', today_vn)::date
                 else (date_trunc('month', today_vn)::date + 10)
               end
             )::text as d1,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then (date_trunc('month', today_vn)::date + 1)
                 else (date_trunc('month', today_vn)::date + 11)
               end
             )::text as d2,
             (
               case
                 when extract(day from today_vn)::int >= 6
                   then (date_trunc('month', today_vn)::date + 2)
                 else (date_trunc('month', today_vn)::date + 12)
               end
             )::text as d3
        from d
    `);

    const { rows: [recDept] } = await observer.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT' and is_active = true",
    );
    assert.ok(recDept?.department_id, "RECRUITMENT department must exist");
    const recDeptId = recDept.department_id;

    const { rows: [hrGroupRow] } = await observer.query(
      "select group_id from public.authz_user_groups where code = 'HR_CATALOG_OPERATOR'",
    );
    assert.ok(hrGroupRow?.group_id, "HR_CATALOG_OPERATOR group must exist");

    const team1 = nextUuid();
    const team2 = nextUuid();
    const teamClock = nextUuid();
    const teamClockCancel = nextUuid();
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'wp10_7_3a_t1', 'Team 1 WP10-7-3A', true, 1),
              ($2::uuid, 'wp10_7_3a_t2', 'Team 2 WP10-7-3A', true, 1),
              ($3::uuid, 'wp10_7_3a_tclk', 'Team Clock WP10-7-3A', true, 1),
              ($4::uuid, 'wp10_7_3a_tclk_cancel', 'Team Clock Cancel WP10-7-3A', true, 1)`,
      [team1, team2, teamClock, teamClockCancel],
    );

    async function onboardOrgUser(tag, { createPersonnel = false, teamId = null, seedLeave = false } = {}) {
      const acc = await seedPlainAccount(setup, `wp1073a.${tag}`, `User ${tag}`);
      const empCode = `EMP-73A-${tag.toUpperCase()}-${seq++}`;
      const pRes = await serviceRpc(setup, "org_department_create_person_admin", [
        OWNER.auth,
        OWNER.app,
        empCode,
        acc.name,
        "2024-01-01",
        recDeptId,
        acc.app,
        1,
        null,
        `Onboard ${tag}`,
        nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: empCode,
          full_name: acc.name,
          joined_on: "2024-01-01",
          initial_department_ref: recDeptId,
          account_ref: acc.app,
          expected_account_version: 1,
          recruiter_id: null,
          reason: `Onboard ${tag}`,
        }),
      ]);
      const person = pRes.person;
      let recruiterId = null;
      if (createPersonnel) {
        const recRes = await serviceRpc(setup, "direct_entry_account_operation_create_personnel", [
          OWNER.auth,
          OWNER.app,
          acc.app,
          person.active_account_link.account_version,
          acc.login,
          "STAFF",
          null,
          `Create personnel ${tag}`,
          nextKey(`rec_${tag}`),
        ]);
        recruiterId = recRes.recruiter_id;
        if (teamId) {
          await serviceRpc(setup, "direct_entry_assign_team_membership", [
            OWNER.auth,
            OWNER.app,
            recruiterId,
            teamId,
            null,
            1,
            `Assign ${tag} to team`,
            nextKey(`asg_${tag}`),
          ]);
        }
      }
      if (seedLeave) {
        const lpFp = sha256(JSON.stringify({
          op: "UPSERT_EMPLOYEE_PROFILE",
          target_app_user_id: acc.app.toLowerCase(),
          employment_status: "OFFICIAL",
          unit_kind: "UNCLASSIFIED",
          work_start_date: "2024-01-01",
          official_effective_date: "2024-03-01",
          next_seniority_effective_date: null,
          next_seniority_units: 0,
          expected_row_version: 0,
          reason: `Leave profile ${tag}`,
        }));
        await serviceRpc(
          setup,
          "leave_management_upsert_employee_profile_admin",
          [
            OWNER.auth,
            OWNER.app,
            acc.app,
            "OFFICIAL",
            null,
            "2024-01-01",
            "2024-03-01",
            null,
            0,
            0,
            `Leave profile ${tag}`,
            nextKey(`lp_${tag}`),
            lpFp,
          ],
          ["uuid", "uuid", "uuid", "text", "text", "date", "date", "date", "int", "int", "text", "text", "text"],
        );
      }
      return { ...acc, personId: person.person_id, recruiterId };
    }

    const hrOp = await onboardOrgUser("hrop");
    {
      const { rows: [uRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [hrOp.app],
      );
      const key = nextUuid();
      await serviceRpc(setup, "direct_entry_authz_assign_group_member_admin", [
        OWNER.auth,
        OWNER.app,
        hrOp.app,
        hrGroupRow.group_id,
        uRow.version,
        "Bootstrap HR Operator for WP10-7-3A",
        key,
        sha256(key),
      ]);
    }

    const deptHead = await onboardOrgUser("depthead", { seedLeave: true });
    {
      const { rows: [dRow] } = await observer.query(
        "select version from public.organization_departments where department_id = $1::uuid",
        [recDeptId],
      );
      await serviceRpc(setup, "org_department_designate_head_admin", [
        OWNER.auth,
        OWNER.app,
        recDeptId,
        deptHead.personId,
        dRow.version,
        null,
        "Designate RECRUITMENT Dept Head",
        nextUuid(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: recDeptId,
          person_id: deptHead.personId,
          expected_department_version: dRow.version,
          expected_current_head_assignment_id: null,
          reason: "Designate RECRUITMENT Dept Head",
        }),
      ]);
    }

    const leader1 = await onboardOrgUser("leader1", { createPersonnel: true, teamId: team1, seedLeave: true });
    const leader2 = await onboardOrgUser("leader2", { createPersonnel: true, teamId: team1, seedLeave: true });
    const member1 = await onboardOrgUser("member1", { createPersonnel: true, teamId: team1, seedLeave: true });
    const rollLive = await onboardOrgUser("roll_live", { createPersonnel: true, teamId: team2 });
    const rollHist = await onboardOrgUser("roll_hist", { createPersonnel: true, teamId: team2 });
    const leaderClock = await onboardOrgUser("leader_clock", { createPersonnel: true, teamId: teamClock, seedLeave: true });
    const leaderClockCancel = await onboardOrgUser("leader_clock_cancel", { createPersonnel: true, teamId: teamClockCancel });
    const memberClock = await onboardOrgUser("member_clock", { createPersonnel: true, teamId: teamClock, seedLeave: true });

    // Work Report setup: template + TEAM assignment on team1 + member1 submission
    const tpl = await serviceRpc(setup, "work_report_create_template", [
      OWNER.auth,
      OWNER.app,
      "WP1073A_DAILY",
      "WP10-7-3A Daily Report",
      "Template for TL authority test",
      "DAILY",
      JSON.stringify(VALID_SCHEMA),
      JSON.stringify(VALID_METRIC_CONTRACT),
      nextKey("tpl"),
    ]);
    await setup.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [tpl.draft_version_id],
    );
    await serviceRpc(setup, "work_report_publish_template", [
      OWNER.auth,
      OWNER.app,
      tpl.template_id,
      tpl.draft_version_id,
      tpl.version,
      nextKey("pub"),
    ]);
    const wrAssignment = await serviceRpc(
      setup,
      "work_report_create_assignment",
      [
        OWNER.auth,
        OWNER.app,
        tpl.template_id,
        "TEAM",
        null,
        team1,
        null,
        "DAILY",
        true,
        0,
        "23:59:59",
        false,
        null,
        null,
        nextKey("wr_asg"),
      ],
      [
        "uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]",
        "text", "boolean", "integer", "time", "boolean", "date", "date", "text",
      ],
    );
    const { rows: [memberObligation] } = await observer.query(
      `select obligation_id
         from public.work_report_obligations
        where assignment_id = $1::uuid
          and assignee_app_user_id = $2::uuid`,
      [wrAssignment.assignment_id, member1.app],
    );
    assert.ok(memberObligation?.obligation_id, "member1 must have an active Work Report obligation on team1");
    await serviceRpc(setup, "work_report_submit", [
      member1.auth,
      member1.app,
      memberObligation.obligation_id,
      JSON.stringify(SUBMIT_PAYLOAD),
      null,
      nextKey("wr_sub"),
    ]);

    async function insertLegacyRolloverRow(client, {
      assignmentId = nextUuid(),
      teamId,
      leaderUser,
      validFrom,
      validTo,
      revVersion,
      revAction,
    }) {
      await client.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, false, false)`,
        [assignmentId, teamId, leaderUser.app, leaderUser.recruiterId, validFrom, validTo],
      );
      await client.query(
        `insert into public.direct_entry_scope_grants (
           app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, 'team', $2::uuid, $3::date, $4::date, false, false)`,
        [leaderUser.app, teamId, validFrom, validTo],
      );
      await client.query(
        `insert into public.direct_entry_capability_grants (
           app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, 'team_manager_assign', $2::date, $3::date, false, false)`,
        [leaderUser.app, validFrom, validTo],
      );
      await client.query(
        `insert into public.direct_entry_team_leader_revisions (
           team_id, version, actor_user_id, action, before_snapshot, after_snapshot
         ) values ($1::uuid, $2::int, $3::uuid, $4, null, $5::jsonb)`,
        [
          teamId,
          revVersion,
          OWNER.app,
          revAction,
          JSON.stringify({
            team_id: teamId,
            leader_app_user_id: leaderUser.app,
            leader_recruiter_id: leaderUser.recruiterId,
            valid_from: validFrom,
            valid_to: validTo,
            previous_leader_recruiter_id: null,
            version: revVersion,
            change: revAction,
          }),
        ],
      );
      return assignmentId;
    }

    // -------------------------------------------------------------------------
    // Test 1: Preflight SQL & Fail-Closed Block vs Ready Upgrade (0..pre-3A -> 3A)
    // -------------------------------------------------------------------------
    await t.test("Test 1: Preflight SQL & fail-closed block vs ready upgrade (0..pre-3A -> 3A)", async () => {
    const preflightRawSql = await readFile(PREFLIGHT_SQL_PATH, "utf8");
    const { query1: preflightSummarySql, query2: preflightDetailSql } = parsePreflightQueries(preflightRawSql);
    const migration3aRawSql = await readFile(path.join(MIGRATION_DIR, WP10_7_3A_MIGRATION_NAME), "utf8");
    const migration3aInnerSql = stripOuterBeginCommit(migration3aRawSql);

    // 1A: Legitimately closed historical assignment (valid_to <= today, is_current = false + legacy triad)
    // must report zero drift (ready_for_slice_3a = true, detailRows = []) and MUST NOT block migration 3A.
    await setup.query("begin");
    try {
      await insertLegacyRolloverRow(setup, {
        assignmentId: nextUuid(),
        teamId: team2,
        leaderUser: rollHist,
        validFrom: dates.hist_month_start,
        validTo: dates.today_minus_1,
        revVersion: 1,
        revAction: "designate",
      });
      const { rows: [summaryLegit] } = await setup.query(preflightSummarySql);
      assert.equal(summaryLegit.ready_for_slice_3a, true);
      assert.equal(summaryLegit.distinct_changed_assignment_count, 0);
      assert.equal(summaryLegit.changed_at_today_count, 0);
      assert.equal(summaryLegit.changed_at_historical_dates_count, 0);
      assert.equal(summaryLegit.changed_at_future_dates_count, 0);
      const { rows: detailLegit } = await setup.query(preflightDetailSql);
      assert.deepEqual(detailLegit, []);

      await setup.query("savepoint sp_3a_legit_closed");
      await setup.query(migration3aInnerSql);
      await setup.query("rollback to savepoint sp_3a_legit_closed");
    } finally {
      await setup.query("rollback");
    }

    // 1B: Verify all 3 blocked drift scenarios trigger WP10_7_3A_PREFLIGHT_BLOCKED (P0001)
    async function assertBlockedDriftCase({ label, seedFn, expectTodayMin, expectHistMin, assertRows }) {
      await setup.query("begin");
      try {
        const targetId = await seedFn();
        const { rows: [summaryBlocked] } = await setup.query(preflightSummarySql);
        assert.equal(summaryBlocked.ready_for_slice_3a, false, `${label}: ready_for_slice_3a must be false`);
        assert.ok(
          summaryBlocked.changed_at_today_count >= expectTodayMin,
          `${label}: changed_at_today_count mismatch`,
        );
        if (expectTodayMin === 0) {
          assert.equal(summaryBlocked.changed_at_today_count, 0, `${label}: changed_at_today_count must be 0`);
        }
        assert.ok(
          summaryBlocked.changed_at_historical_dates_count >= expectHistMin,
          `${label}: changed_at_historical_dates_count mismatch`,
        );
        assert.equal(
          summaryBlocked.changed_at_future_dates_count,
          0,
          `${label}: changed_at_future_dates_count must be 0`,
        );
        assert.ok(
          summaryBlocked.distinct_changed_assignment_count >= 1,
          `${label}: distinct_changed_assignment_count must be >= 1`,
        );

        const { rows: detailRows } = await setup.query(preflightDetailSql);
        const rows = detailRows.filter((r) => r.assignment_id === targetId);
        assert.equal(
          detailRows.some((r) => r.probe_kind === "future"),
          false,
          `${label}: future dates must show zero drift`,
        );
        assertRows(rows);

        await setup.query("savepoint sp_3a_blocked");
        await assert.rejects(
          () => setup.query(migration3aInnerSql),
          (err) => err?.code === "P0001" && String(err?.message).includes("WP10_7_3A_PREFLIGHT_BLOCKED"),
          `${label}: migration 3A preflight guard must fail closed`,
        );
        await setup.query("rollback to savepoint sp_3a_blocked");
      } finally {
        await setup.query("rollback");
      }
    }

    // (a) Live open legacy rollover (valid_to IS NULL) -> old=true, new=false at today & historical_*
    await assertBlockedDriftCase({
      label: "(a) Live open legacy rollover",
      seedFn: () =>
        insertLegacyRolloverRow(setup, {
          teamId: team2,
          leaderUser: rollLive,
          validFrom: dates.today_minus_3,
          validTo: null,
          revVersion: 1,
          revAction: "designate",
        }),
      expectTodayMin: 1,
      expectHistMin: 1,
      assertRows: (rows) => {
        assert.ok(rows.some((r) => r.probe_kind === "today" && r.old_effective === true && r.new_effective === false));
        assert.ok(
          rows.some(
            (r) => r.probe_kind.startsWith("historical_") && r.old_effective === true && r.new_effective === false,
          ),
        );
      },
    });

    // (b) Future-ending legacy rollover (valid_to = today + 2) -> old=true, new=false at today & historical_*
    await assertBlockedDriftCase({
      label: "(b) Future-ending legacy rollover",
      seedFn: () =>
        insertLegacyRolloverRow(setup, {
          teamId: team2,
          leaderUser: rollHist,
          validFrom: dates.hist_month_start,
          validTo: dates.today_plus_2,
          revVersion: 1,
          revAction: "designate",
        }),
      expectTodayMin: 1,
      expectHistMin: 1,
      assertRows: (rows) => {
        assert.ok(rows.some((r) => r.probe_kind === "today" && r.old_effective === true && r.new_effective === false));
        assert.ok(
          rows.some(
            (r) => r.probe_kind.startsWith("historical_") && r.old_effective === true && r.new_effective === false,
          ),
        );
      },
    });

    // (c) Anomalous closed row missing legacy triad (valid_to = today - 1, no legacy grants/revisions) -> old=false, new=true at historical_*
    await assertBlockedDriftCase({
      label: "(c) Anomalous closed row missing legacy triad",
      seedFn: async () => {
        const anomalousId = nextUuid();
        await setup.query(
          `insert into public.direct_entry_team_leader_assignments (
             assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
             valid_from, valid_to, is_current, suspended_by_account_disable
           ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, false, false)`,
          [anomalousId, team2, rollHist.app, rollHist.recruiterId, dates.hist_month_start, dates.today_minus_1],
        );
        return anomalousId;
      },
      expectTodayMin: 0,
      expectHistMin: 1,
      assertRows: (rows) => {
        assert.equal(rows.some((r) => r.probe_kind === "today"), false);
        assert.ok(
          rows.some(
            (r) => r.probe_kind.startsWith("historical_") && r.old_effective === false && r.new_effective === true,
          ),
        );
      },
    });

    // Re-run standalone preflight SQL on clean DB -> ready_for_slice_3a === true
    await setup.query("begin transaction read only");
    try {
      const { rows: [summaryReady] } = await setup.query(preflightSummarySql);
      assert.equal(summaryReady.ready_for_slice_3a, true);
      assert.equal(summaryReady.distinct_changed_assignment_count, 0);
      assert.equal(summaryReady.changed_at_today_count, 0);
      assert.equal(summaryReady.changed_at_historical_dates_count, 0);
      assert.equal(summaryReady.changed_at_future_dates_count, 0);
      const { rows: detailClean } = await setup.query(preflightDetailSql);
      assert.deepEqual(detailClean, []);
    } finally {
      await setup.query("rollback");
    }

    // Apply Slice 3A migration cleanly
    await setup.query(migration3aRawSql);
    });

    // -------------------------------------------------------------------------
    // Test 2: Post-3A Catalog & ACL + Preserved Function Semantics + Rollover Cut
    // -------------------------------------------------------------------------
    await t.test("Test 2: Post-3A catalog & ACL + preserved effectiveness semantics + rollover cut", async () => {
    const { rows: [fnMeta] } = await observer.query(`
      select pg_catalog.pg_get_functiondef('public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::regprocedure) as fn_def,
             pg_catalog.has_function_privilege('public', 'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::regprocedure, 'EXECUTE') as pub_exec,
             pg_catalog.has_function_privilege('anon', 'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::regprocedure, 'EXECUTE') as anon_exec,
             pg_catalog.has_function_privilege('authenticated', 'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::regprocedure, 'EXECUTE') as auth_exec,
             pg_catalog.has_function_privilege('service_role', 'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)'::regprocedure, 'EXECUTE') as svc_exec
    `);
    assert.equal(/direct_entry_scope_grants/i.test(fnMeta.fn_def), false);
    assert.equal(/direct_entry_capability_grants/i.test(fnMeta.fn_def), false);
    assert.equal(/direct_entry_team_leader_revisions/i.test(fnMeta.fn_def), false);
    assert.equal(fnMeta.pub_exec, false);
    assert.equal(fnMeta.anon_exec, false);
    assert.equal(fnMeta.auth_exec, false);
    assert.equal(fnMeta.svc_exec, false);

    // Post-3A legacy rollover cut + preserved conditions + future p_as_of
    await setup.query("begin");
    try {
      // (a) Re-insert synthetic open legacy rollover row AFTER 3A -> returns false at today AND today - 2
      const post3aRolloverId = await insertLegacyRolloverRow(setup, {
        teamId: team2,
        leaderUser: rollLive,
        validFrom: dates.today_minus_2,
        validTo: null,
        revVersion: 1,
        revAction: "designate",
      });
      const { rows: [rollEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff_today,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as eff_past`,
        [post3aRolloverId, dates.today, dates.today_minus_2],
      );
      assert.equal(rollEval.eff_today, false, "Post-3A open legacy rollover row must return false at today");
      assert.equal(rollEval.eff_past, false, "Post-3A open legacy rollover row must return false at today - 2");

      // (a2) Future-ending legacy rollover (is_current=false, valid_from=today-2, valid_to=today+2 + legacy triad)
      // -> returns false at both today AND today - 2
      await setup.query("savepoint sp_futend_roll");
      const futEndRollTeam = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'wp10_7_3a_futend_roll', 'FutEnd Roll Team', true, 1)",
        [futEndRollTeam],
      );
      const futEndRollId = await insertLegacyRolloverRow(setup, {
        teamId: futEndRollTeam,
        leaderUser: rollHist,
        validFrom: dates.today_minus_2,
        validTo: dates.today_plus_2,
        revVersion: 1,
        revAction: "designate",
      });
      const { rows: [futEndRollEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff_today,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as eff_past`,
        [futEndRollId, dates.today, dates.today_minus_2],
      );
      assert.equal(futEndRollEval.eff_today, false, "Post-3A future-ending legacy rollover must return false at today");
      assert.equal(futEndRollEval.eff_past, false, "Post-3A future-ending legacy rollover must return false at today - 2");
      await setup.query("rollback to savepoint sp_futend_roll");

      // (a3) Open row with is_current=false (team/recruiter deactivate-then-reactivate pattern) -> false at today & today - 2
      await setup.query("savepoint sp_deact_open");
      const deactTeam = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'wp10_7_3a_deact_react', 'Deact React Team', false, 1)",
        [deactTeam],
      );
      const deactOpenAsgId = nextUuid();
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, null, false, false)`,
        [deactOpenAsgId, deactTeam, rollHist.app, rollHist.recruiterId, dates.today_minus_2],
      );
      await setup.query("update public.teams set active = true where team_id = $1::uuid", [deactTeam]);
      const { rows: [deactOpenEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff_today,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as eff_past`,
        [deactOpenAsgId, dates.today, dates.today_minus_2],
      );
      assert.equal(deactOpenEval.eff_today, false, "Open row with is_current=false must return false at today");
      assert.equal(deactOpenEval.eff_past, false, "Open row with is_current=false must return false at today - 2");
      await setup.query("rollback to savepoint sp_deact_open");

      // (b) Preserved conditions on is_current = true row
      const semTeam = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'wp10_7_3a_sem', 'Sem Team', true, 1)",
        [semTeam],
      );
      const semAsgId = nextUuid();
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, null, true, false)`,
        [semAsgId, semTeam, rollHist.app, rollHist.recruiterId, dates.today_minus_1],
      );
      const checkEff = async (asOf) => {
        const { rows: [r] } = await setup.query(
          "select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff",
          [semAsgId, asOf],
        );
        return r.eff;
      };
      // valid_from <= as_of
      assert.equal(await checkEff(dates.today_minus_1), true);
      assert.equal(await checkEff(dates.today), true);
      assert.equal(await checkEff(dates.today_minus_2), false);

      // as_of < valid_to
      await setup.query(
        "update public.direct_entry_team_leader_assignments set valid_to = $2::date where assignment_id = $1::uuid",
        [semAsgId, dates.today_plus_2],
      );
      assert.equal(await checkEff(dates.today_plus_1), true);
      assert.equal(await checkEff(dates.today_plus_2), false);

      // valid_to > valid_from (zero-length marker returns false)
      await setup.query("savepoint sp_marker");
      await setup.query("set local direct_entry.team_leader_marker = 'on'");
      await setup.query(
        "update public.direct_entry_team_leader_assignments set valid_to = valid_from where assignment_id = $1::uuid",
        [semAsgId],
      );
      assert.equal(await checkEff(dates.today_minus_1), false);
      await setup.query("rollback to savepoint sp_marker");

      // Reset valid_to = null for remaining structural checks
      await setup.query(
        "update public.direct_entry_team_leader_assignments set valid_to = null where assignment_id = $1::uuid",
        [semAsgId],
      );

      // not suspended_by_account_disable
      await setup.query("savepoint sp_susp");
      await setup.query(
        "update public.direct_entry_team_leader_assignments set suspended_by_account_disable = true where assignment_id = $1::uuid",
        [semAsgId],
      );
      assert.equal(await checkEff(dates.today), false);
      await setup.query("rollback to savepoint sp_susp");

      // teams.active & code <> '__system_vendor__'
      await setup.query("savepoint sp_team_inactive");
      await setup.query("update public.teams set active = false where team_id = $1::uuid", [semTeam]);
      assert.equal(await checkEff(dates.today), false);
      await setup.query("rollback to savepoint sp_team_inactive");

      await setup.query("savepoint sp_team_vendor");
      const { rows: [existingSysVendor] } = await setup.query(
        "select team_id from public.teams where code = '__system_vendor__'",
      );
      let sysVendorTeamId = existingSysVendor?.team_id;
      if (!sysVendorTeamId) {
        sysVendorTeamId = nextUuid();
        await setup.query(
          "insert into public.teams (team_id, code, display_name, department_id, active, version) values ($1::uuid, '__system_vendor__', 'System Vendor', null, true, 1)",
          [sysVendorTeamId],
        );
      }
      const vendorAsgId = nextUuid();
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, null, true, false)`,
        [vendorAsgId, sysVendorTeamId, rollLive.app, rollLive.recruiterId, dates.today_minus_1],
      );
      const { rows: [vendorEff] } = await setup.query(
        "select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff",
        [vendorAsgId, dates.today],
      );
      assert.equal(vendorEff.eff, false, "System vendor team TL assignment must return false");
      await setup.query("rollback to savepoint sp_team_vendor");

      // u.enabled
      await setup.query("savepoint sp_user_dis");
      await setup.query(
        "update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid",
        [rollHist.app],
      );
      assert.equal(await checkEff(dates.today), false);
      await setup.query("rollback to savepoint sp_user_dis");

      // r.active
      await setup.query("savepoint sp_rec_inact");
      await setup.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [rollHist.recruiterId]);
      assert.equal(await checkEff(dates.today), false);
      await setup.query("rollback to savepoint sp_rec_inact");

      // (c) Future p_as_of preservation (is_current = false, valid_from = today + 5, valid_to IS NULL)
      const futTeam = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'wp10_7_3a_fut', 'Fut Team', true, 1)",
        [futTeam],
      );
      const futAsgId = nextUuid();
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, null, false, false)`,
        [futAsgId, futTeam, rollHist.app, rollHist.recruiterId, dates.today_plus_5],
      );
      const { rows: [futEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as at_today,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as at_plus_4,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $4::date) as at_plus_5,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $5::date) as at_plus_10`,
        [futAsgId, dates.today, dates.today_plus_4, dates.today_plus_5, dates.today_plus_10],
      );
      assert.equal(futEval.at_today, false);
      assert.equal(futEval.at_plus_4, false);
      assert.equal(futEval.at_plus_5, true, "Future scheduled TL must remain effective at valid_from (today + 5)");
      assert.equal(futEval.at_plus_10, true, "Future scheduled TL must remain effective at today + 10");
    } finally {
      await setup.query("rollback");
    }
    });

    async function getActorCtx(user) {
      return serviceRpc(setup, "direct_entry_resolve_actor_context", [user.auth]);
    }
    async function isTlEffective(assignmentId, asOf = dates.today) {
      const { rows: [r] } = await observer.query(
        "select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff",
        [assignmentId, asOf],
      );
      return r.eff;
    }
    async function resolveLeaveRouting(appUserId, asOf) {
      const { rows: [r] } = await observer.query(
        "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as routing",
        [appUserId, asOf],
      );
      return r.routing;
    }
    async function getTeamVersion(teamId) {
      const { rows: [r] } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamId],
      );
      return r.version;
    }
    async function getUserVersion(appUserId) {
      const { rows: [r] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [appUserId],
      );
      return r.version;
    }
    async function getRecruiterVersion(recruiterId) {
      const { rows: [r] } = await observer.query(
        "select version from public.recruiters where recruiter_id = $1::uuid",
        [recruiterId],
      );
      return r.version;
    }
    function assertHasTeamLeaderCtx(ctx, teamId, expectHas) {
      const hasRole = (ctx.assigned_roles ?? []).some(
        (r) => r.role_code === "TEAM_LEADER" && r.scope_kind === "CONTEXT_TEAM" && r.scope_id === teamId,
      );
      const hasReviewGrant = (ctx.effective_grants ?? []).some(
        (g) => g.capability === "report_review" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === teamId,
      );
      const hasReviewScope = (ctx.effective_report_review_scopes ?? []).some(
        (s) => s.kind === "team" && s.team_id === teamId,
      );
      const hasAssignGrant = (ctx.effective_grants ?? []).some(
        (g) => g.capability === "report_assign" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === teamId,
      );
      const hasTlCap = (ctx.effective_grants ?? []).some(
        (g) => g.capability === "team_manager_assign" && g.scope_kind === "CONTEXT_TEAM" && g.scope_id === teamId,
      );
      assert.equal(hasRole, expectHas, `assigned_roles TEAM_LEADER mismatch (expected ${expectHas})`);
      assert.equal(hasReviewGrant, expectHas, `effective_grants report_review mismatch (expected ${expectHas})`);
      assert.equal(hasReviewScope, expectHas, `effective_report_review_scopes mismatch (expected ${expectHas})`);
      assert.equal(hasAssignGrant, expectHas, `effective_grants report_assign mismatch (expected ${expectHas})`);
      assert.equal(hasTlCap, expectHas, `effective_grants team_manager_assign mismatch (expected ${expectHas})`);
    }

    // -------------------------------------------------------------------------
    // Test 3: Real RPC TL Lifecycle + Disable/Enable + #42 Move/Unassign +
    //         Leave/Attendance Routing + Work Reports Authority
    // -------------------------------------------------------------------------
    await t.test("Test 3: Real RPC TL lifecycle + disable/enable + #42 move/unassign + Leave/Attendance routing + Work Reports authority", async () => {

    // 3A: Designate leader1 on team1
    const des1 = await serviceRpc(setup, "direct_entry_designate_team_leader", [
      hrOp.auth,
      hrOp.app,
      team1,
      leader1.app,
      dates.today,
      await getTeamVersion(team1),
      "Designate leader1 via HR Operator",
      nextKey("des_l1"),
    ]);
    const asg1Id = des1.assignment_id;
    assert.equal(await isTlEffective(asg1Id), true);
    assertHasTeamLeaderCtx(await getActorCtx(leader1), team1, true);

    const l1Assignments = await serviceRpc(setup, "work_report_list_assignments", [
      leader1.auth,
      leader1.app,
      team1,
    ]);
    assert.ok(
      (l1Assignments.items ?? l1Assignments.assignments ?? []).some((a) => a.assignment_id === wrAssignment.assignment_id) ||
        l1Assignments !== null,
      "leader1 work_report_list_assignments must succeed",
    );
    const l1Pending = await serviceRpc(setup, "work_report_list_pending_reviews", [
      leader1.auth,
      leader1.app,
      null,
      null,
      50,
    ]);
    assert.ok(
      (l1Pending.items ?? []).some((item) => item.obligation_id === memberObligation.obligation_id),
      "leader1 work_report_list_pending_reviews must include member1 submission",
    );

    const mLeaveSum1 = await serviceRpc(setup, "leave_management_get_my_summary", [
      member1.auth,
      member1.app,
      dates.leave_year,
    ]);
    assert.equal(mLeaveSum1.routing.route_kind, "TEAM_LEADER");
    assert.equal(mLeaveSum1.routing.primary_approver_app_user_id, leader1.app);

    const mExpOv1 = await serviceRpc(setup, "attendance_get_my_explanations_overview", [
      member1.auth,
      member1.app,
      dates.yesterday_vn,
      20,
      0,
    ]);
    assert.equal(mExpOv1.routing.route_kind, "TEAM_LEADER");
    assert.equal(mExpOv1.routing.primary_approver.app_user_id, leader1.app);

    const leave1 = await serviceRpc(setup, "leave_management_create_request", [
      member1.auth,
      member1.app,
      JSON.stringify([{ leave_date: dates.d1, session_code: "AM", leave_type: "ANNUAL" }]),
      "Leave routed to leader1",
      nextKey("lv1"),
      sha256("lv1"),
    ]);
    assert.equal(leave1.request.route_kind, "TEAM_LEADER");
    assert.equal(leave1.request.primary_approver_app_user_id, leader1.app);
    const leave1Dec = await serviceRpc(setup, "leave_management_decide_request", [
      leader1.auth,
      leader1.app,
      leave1.request.request_id,
      "APPROVE",
      leave1.request.row_version,
      "Approve by leader1",
      nextKey("lv1_app"),
      sha256("lv1_app"),
    ]);
    assert.equal(leave1Dec.request.status, "APPROVED");

    const exp1 = await serviceRpc(setup, "attendance_submit_explanation", [
      member1.auth,
      member1.app,
      dates.yesterday_vn,
      "SLOT_1",
      "Explanation routed to leader1",
      nextUuid(),
      sha256("exp1"),
    ]);
    assert.equal(exp1.explanation.route_kind, "TEAM_LEADER");
    assert.equal(exp1.explanation.primary_approver.app_user_id, leader1.app);
    const exp1Dec = await serviceRpc(setup, "attendance_decide_explanation", [
      leader1.auth,
      leader1.app,
      exp1.explanation.explanation_id,
      "APPROVE",
      exp1.explanation.row_version,
      "Approve exp by leader1",
      nextUuid(),
      sha256("exp1_app"),
    ]);
    assert.equal(exp1Dec.explanation.status, "APPROVED");

    // 3B: Disable / Enable account (leader1) + #42 suspended-restorable guard
    await serviceRpc(setup, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      leader1.app,
      await getUserVersion(leader1.app),
      "Disable leader1 temporarily",
      nextKey("dis_l1"),
    ]);
    assert.equal(await isTlEffective(asg1Id), false);
    const l1DisabledCtx = await getActorCtx(leader1);
    assert.deepEqual(l1DisabledCtx.assigned_roles, []);
    assert.deepEqual(l1DisabledCtx.effective_grants, []);
    assert.deepEqual(l1DisabledCtx.effective_report_review_scopes ?? [], []);

    await assert.rejects(
      async () =>
        serviceRpc(setup, "direct_entry_move_team_membership", [
          hrOp.auth,
          hrOp.app,
          leader1.recruiterId,
          team2,
          dates.today,
          await getRecruiterVersion(leader1.recruiterId),
          "Blocked move while TL disabled-restorable",
          nextKey("mv_dis_l1"),
        ]),
      (err) => err?.code === "PT409" && err?.message === EXPECTED_TL_GUARD_MSG,
    );
    await assert.rejects(
      async () =>
        serviceRpc(setup, "direct_entry_unassign_team_membership", [
          hrOp.auth,
          hrOp.app,
          leader1.recruiterId,
          dates.today,
          await getRecruiterVersion(leader1.recruiterId),
          "Blocked unassign while TL disabled-restorable",
          nextKey("un_dis_l1"),
        ]),
      (err) => err?.code === "PT409" && err?.message === EXPECTED_TL_GUARD_MSG,
    );

    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      leader1.app,
      await getUserVersion(leader1.app),
      "Re-enable leader1",
      nextKey("en_l1"),
    ]);
    assert.equal(await isTlEffective(asg1Id), true);
    assertHasTeamLeaderCtx(await getActorCtx(leader1), team1, true);
    const l1RestoredPending = await serviceRpc(setup, "work_report_list_pending_reviews", [
      leader1.auth,
      leader1.app,
      null,
      null,
      50,
    ]);
    assert.ok((l1RestoredPending.items ?? []).some((i) => i.obligation_id === memberObligation.obligation_id));
    const mLeaveRestored = await serviceRpc(setup, "leave_management_get_my_summary", [
      member1.auth,
      member1.app,
      dates.leave_year,
    ]);
    assert.equal(mLeaveRestored.routing.primary_approver_app_user_id, leader1.app);

    // 3C: #42 active guard + Replace leader1 -> leader2
    await assert.rejects(
      async () =>
        serviceRpc(setup, "direct_entry_move_team_membership", [
          hrOp.auth,
          hrOp.app,
          leader1.recruiterId,
          team2,
          dates.today,
          await getRecruiterVersion(leader1.recruiterId),
          "Blocked move while active TL",
          nextKey("mv_act_l1"),
        ]),
      (err) => err?.code === "PT409" && err?.message === EXPECTED_TL_GUARD_MSG,
    );
    await assert.rejects(
      async () =>
        serviceRpc(setup, "direct_entry_unassign_team_membership", [
          hrOp.auth,
          hrOp.app,
          leader1.recruiterId,
          dates.today,
          await getRecruiterVersion(leader1.recruiterId),
          "Blocked unassign while active TL",
          nextKey("un_act_l1"),
        ]),
      (err) => err?.code === "PT409" && err?.message === EXPECTED_TL_GUARD_MSG,
    );

    const des2 = await serviceRpc(setup, "direct_entry_designate_team_leader", [
      hrOp.auth,
      hrOp.app,
      team1,
      leader2.app,
      dates.today,
      await getTeamVersion(team1),
      "Replace leader1 with leader2",
      nextKey("des_l2"),
    ]);
    const asg2Id = des2.assignment_id;

    // leader1 loses authority
    assert.equal(await isTlEffective(asg1Id), false);
    assertHasTeamLeaderCtx(await getActorCtx(leader1), team1, false);
    await assert.rejects(
      () => serviceRpc(setup, "work_report_list_pending_reviews", [leader1.auth, leader1.app, null, null, 50]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(setup, "work_report_list_assignments", [leader1.auth, leader1.app, team1]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "leave_management_decide_request", [
          leader1.auth,
          leader1.app,
          leave1Dec.request.request_id,
          "CANCEL_APPROVED",
          leave1Dec.request.row_version,
          "Former TL cannot cancel approved leave",
          nextKey("lv1_cancel"),
          sha256("lv1_cancel"),
        ]),
      (err) => err?.code === "42501" && String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    );

    // leader1 can now move teams!
    await serviceRpc(setup, "direct_entry_move_team_membership", [
      hrOp.auth,
      hrOp.app,
      leader1.recruiterId,
      team2,
      dates.today,
      await getRecruiterVersion(leader1.recruiterId),
      "Move former TL leader1 to team2",
      nextKey("mv_after_replace"),
    ]);

    // leader2 gains authority & routing
    assert.equal(await isTlEffective(asg2Id), true);
    assertHasTeamLeaderCtx(await getActorCtx(leader2), team1, true);
    const l2Pending = await serviceRpc(setup, "work_report_list_pending_reviews", [
      leader2.auth,
      leader2.app,
      null,
      null,
      50,
    ]);
    assert.ok((l2Pending.items ?? []).some((i) => i.obligation_id === memberObligation.obligation_id));

    const leave2 = await serviceRpc(setup, "leave_management_create_request", [
      member1.auth,
      member1.app,
      JSON.stringify([{ leave_date: dates.d2, session_code: "AM", leave_type: "ANNUAL" }]),
      "Leave routed to leader2",
      nextKey("lv2"),
      sha256("lv2"),
    ]);
    assert.equal(leave2.request.route_kind, "TEAM_LEADER");
    assert.equal(leave2.request.primary_approver_app_user_id, leader2.app);
    const leave2Dec = await serviceRpc(setup, "leave_management_decide_request", [
      leader2.auth,
      leader2.app,
      leave2.request.request_id,
      "APPROVE",
      leave2.request.row_version,
      "Approve by leader2",
      nextKey("lv2_app"),
      sha256("lv2_app"),
    ]);
    assert.equal(leave2Dec.request.status, "APPROVED");

    const exp2 = await serviceRpc(setup, "attendance_submit_explanation", [
      member1.auth,
      member1.app,
      dates.yesterday_vn,
      "SLOT_2",
      "Explanation routed to leader2",
      nextUuid(),
      sha256("exp2"),
    ]);
    assert.equal(exp2.explanation.route_kind, "TEAM_LEADER");
    assert.equal(exp2.explanation.primary_approver.app_user_id, leader2.app);
    const exp2Dec = await serviceRpc(setup, "attendance_decide_explanation", [
      leader2.auth,
      leader2.app,
      exp2.explanation.explanation_id,
      "APPROVE",
      exp2.explanation.row_version,
      "Approve exp by leader2",
      nextUuid(),
      sha256("exp2_app"),
    ]);
    assert.equal(exp2Dec.explanation.status, "APPROVED");

    // 3D: Revoke TL (leader2) -> fallback to ADMIN_BOD_FALLBACK + unassign succeeds
    await serviceRpc(setup, "direct_entry_revoke_team_leader", [
      hrOp.auth,
      hrOp.app,
      team1,
      dates.today,
      await getTeamVersion(team1),
      "Revoke leader2",
      nextKey("rev_l2"),
    ]);
    assert.equal(await isTlEffective(asg2Id), false);
    assertHasTeamLeaderCtx(await getActorCtx(leader2), team1, false);
    await assert.rejects(
      () => serviceRpc(setup, "work_report_list_pending_reviews", [leader2.auth, leader2.app, null, null, 50]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () => serviceRpc(setup, "work_report_list_assignments", [leader2.auth, leader2.app, team1]),
      (err) => err?.code === "42501",
    );

    const mLeaveFallback = await serviceRpc(setup, "leave_management_get_my_summary", [
      member1.auth,
      member1.app,
      dates.leave_year,
    ]);
    assert.equal(mLeaveFallback.routing.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(mLeaveFallback.routing.primary_approver_app_user_id, null);

    const leave3 = await serviceRpc(setup, "leave_management_create_request", [
      member1.auth,
      member1.app,
      JSON.stringify([{ leave_date: dates.d3, session_code: "AM", leave_type: "ANNUAL" }]),
      "Leave fallback to ADMIN_BOD_FALLBACK",
      nextKey("lv3"),
      sha256("lv3"),
    ]);
    assert.equal(leave3.request.route_kind, "ADMIN_BOD_FALLBACK");
    assert.equal(leave3.request.primary_approver_app_user_id, null);

    await serviceRpc(setup, "direct_entry_unassign_team_membership", [
      hrOp.auth,
      hrOp.app,
      leader2.recruiterId,
      dates.today,
      await getRecruiterVersion(leader2.recruiterId),
      "Unassign revoked TL leader2",
      nextKey("un_after_revoke"),
    ]);
    });

    // -------------------------------------------------------------------------
    // Test 4: 2-Day Business Clock Simulation (D designate -> D+1 revoke) +
    //         leave_management_monthly_report + Edge Cases
    // -------------------------------------------------------------------------
    await t.test("Test 4: 2-day simulated clock (D designate -> D+1 revoke) + leave_management_monthly_report + edge cases", async () => {
      const { rows: [origClockFn] } = await observer.query(
        "select pg_catalog.pg_get_functiondef('public.direct_entry_authorization_date()'::regprocedure) as fn_def",
      );
      assert.ok(origClockFn?.fn_def, "Original direct_entry_authorization_date() definition must exist");

      const { rows: [clockDates] } = await observer.query(
        "select (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text as clock_day_d",
        [dates.today],
      );
      const clockDayD = clockDates.clock_day_d;
      const clockDayDPlus1 = addDaysIso(clockDayD, 1);

      async function setAuthDateClock(isoDate) {
        assert.match(isoDate, /^\d{4}-\d{2}-\d{2}$/);
        await setup.query(
          `create or replace function public.direct_entry_authorization_date()
           returns date
           language sql
           stable
           set search_path = pg_catalog
           as $function$
             select '${isoDate}'::date
           $function$`,
        );
      }

      try {
        // 4A (Clock = D, month-end)
        await setAuthDateClock(clockDayD);

        const desClock = await serviceRpc(
          setup,
          "direct_entry_designate_team_leader",
          [
            hrOp.auth,
            hrOp.app,
            teamClock,
            leaderClock.app,
            clockDayD,
            await getTeamVersion(teamClock),
            "Designate leaderClock on month-end D",
            nextKey("des_clk_d"),
          ],
          ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );
        const asgClockId = desClock.assignment_id;
        assert.equal(await isTlEffective(asgClockId, clockDayD), true);

        const routingAtDInitial = await resolveLeaveRouting(memberClock.app, clockDayD);
        assert.equal(routingAtDInitial.route_kind, "TEAM_LEADER");
        assert.equal(routingAtDInitial.primary_approver_app_user_id, leaderClock.app);

        // Same-day designate + revoke on teamClockCancel at clockDayD -> valid_from = valid_to = clockDayD
        const desCancel = await serviceRpc(
          setup,
          "direct_entry_designate_team_leader",
          [
            hrOp.auth,
            hrOp.app,
            teamClockCancel,
            leaderClockCancel.app,
            clockDayD,
            await getTeamVersion(teamClockCancel),
            "Designate leaderClockCancel on D",
            nextKey("des_clk_cancel_d"),
          ],
          ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );
        const asgCancelId = desCancel.assignment_id;
        await serviceRpc(
          setup,
          "direct_entry_revoke_team_leader",
          [
            hrOp.auth,
            hrOp.app,
            teamClockCancel,
            clockDayD,
            await getTeamVersion(teamClockCancel),
            "Same-day revoke leaderClockCancel on D",
            nextKey("rev_clk_cancel_d"),
          ],
          ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );

        // 4B (Clock = D+1, 1st of next month)
        await setAuthDateClock(clockDayDPlus1);

        await serviceRpc(
          setup,
          "direct_entry_revoke_team_leader",
          [
            hrOp.auth,
            hrOp.app,
            teamClock,
            clockDayDPlus1,
            await getTeamVersion(teamClock),
            "Revoke leaderClock on D+1",
            nextKey("rev_clk_d1"),
          ],
          ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );

        const { rows: [asgClockRow] } = await observer.query(
          `select is_current,
                  suspended_by_account_disable,
                  valid_from::text as valid_from,
                  valid_to::text as valid_to
             from public.direct_entry_team_leader_assignments
            where assignment_id = $1::uuid`,
          [asgClockId],
        );
        assert.equal(asgClockRow.is_current, false);
        assert.equal(asgClockRow.suspended_by_account_disable, false);
        assert.equal(asgClockRow.valid_from, clockDayD);
        assert.equal(asgClockRow.valid_to, clockDayDPlus1);

        assert.equal(await isTlEffective(asgClockId, clockDayD), true);
        assert.equal(await isTlEffective(asgClockId, clockDayDPlus1), false);

        const routingAtDHistorical = await resolveLeaveRouting(memberClock.app, clockDayD);
        assert.equal(routingAtDHistorical.route_kind, "TEAM_LEADER");
        assert.equal(routingAtDHistorical.primary_approver_app_user_id, leaderClock.app);

        const routingAtDPlus1 = await resolveLeaveRouting(memberClock.app, clockDayDPlus1);
        assert.equal(routingAtDPlus1.route_kind, "ADMIN_BOD_FALLBACK");
        assert.equal(routingAtDPlus1.primary_approver_app_user_id, null);

        const reportMonthD = await serviceRpc(
          setup,
          "leave_management_monthly_report",
          [OWNER.auth, OWNER.app, clockDayD.slice(0, 7), null, memberClock.name, 50, 0],
          ["uuid", "uuid", "text", "text", "text", "int", "int"],
        );
        assert.equal(reportMonthD.as_of_date, clockDayD);
        const reportRowD = (reportMonthD.rows ?? []).find((r) => r.app_user_id === memberClock.app);
        assert.ok(reportRowD, "memberClock row must appear in month D leave_management_monthly_report");
        assert.equal(reportRowD.routing.route_kind, "TEAM_LEADER");
        assert.equal(reportRowD.routing.primary_approver_app_user_id, leaderClock.app);

        const reportMonthDPlus1 = await serviceRpc(
          setup,
          "leave_management_monthly_report",
          [OWNER.auth, OWNER.app, clockDayDPlus1.slice(0, 7), null, memberClock.name, 50, 0],
          ["uuid", "uuid", "text", "text", "text", "int", "int"],
        );
        assert.equal(reportMonthDPlus1.as_of_date, clockDayDPlus1);
        const reportRowDPlus1 = (reportMonthDPlus1.rows ?? []).find((r) => r.app_user_id === memberClock.app);
        assert.ok(reportRowDPlus1, "memberClock row must appear in month D+1 leave_management_monthly_report");
        assert.equal(reportRowDPlus1.routing.route_kind, "ADMIN_BOD_FALLBACK");
        assert.equal(reportRowDPlus1.routing.primary_approver_app_user_id, null);

        assertHasTeamLeaderCtx(await getActorCtx(leaderClock), teamClock, false);

        // 4C: Same-day cancellation marker, disable/enable, suspended_by_account_disable,
        //     and post-3B closed assignment without legacy grants at clock = D+1
        assert.equal(await isTlEffective(asgCancelId, clockDayD), false);
        assert.equal(await isTlEffective(asgCancelId, clockDayDPlus1), false);

        await serviceRpc(setup, "direct_entry_disable_app_user", [
          OWNER.auth,
          OWNER.app,
          leaderClock.app,
          await getUserVersion(leaderClock.app),
          "Disable leaderClock at D+1",
          nextKey("dis_clk"),
        ]);
        assert.equal(await isTlEffective(asgClockId, clockDayD), false);
        assert.equal(await isTlEffective(asgClockId, clockDayDPlus1), false);
        const routingWhileDisabled = await resolveLeaveRouting(memberClock.app, clockDayD);
        assert.equal(routingWhileDisabled.route_kind, "ADMIN_BOD_FALLBACK");
        assert.equal(routingWhileDisabled.primary_approver_app_user_id, null);

        await serviceRpc(setup, "direct_entry_enable_app_user", [
          OWNER.auth,
          OWNER.app,
          leaderClock.app,
          await getUserVersion(leaderClock.app),
          "Re-enable leaderClock at D+1",
          nextKey("en_clk"),
        ]);
        assert.equal(await isTlEffective(asgClockId, clockDayD), true);
        assert.equal(await isTlEffective(asgClockId, clockDayDPlus1), false);

        await setup.query("begin");
        try {
          await setup.query("savepoint sp_clk_susp");
          await setup.query(
            "update public.direct_entry_team_leader_assignments set suspended_by_account_disable = true where assignment_id = $1::uuid",
            [asgClockId],
          );
          const { rows: [suspEval] } = await setup.query(
            `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as at_d,
                    public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as at_d1`,
            [asgClockId, clockDayD, clockDayDPlus1],
          );
          assert.equal(suspEval.at_d, false);
          assert.equal(suspEval.at_d1, false);
          await setup.query("rollback to savepoint sp_clk_susp");

          // Simulate post-3B closed assignment without legacy scope_grants / capability_grants
          await setup.query(
            "delete from public.direct_entry_scope_grants where app_user_id = $1::uuid and scope_kind = 'team'",
            [leaderClock.app],
          );
          await setup.query(
            "delete from public.direct_entry_capability_grants where app_user_id = $1::uuid and capability = 'team_manager_assign'",
            [leaderClock.app],
          );
          const { rows: [post3bEval] } = await setup.query(
            `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as at_d,
                    public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as at_d1`,
            [asgClockId, clockDayD, clockDayDPlus1],
          );
          assert.equal(post3bEval.at_d, true);
          assert.equal(post3bEval.at_d1, false);
        } finally {
          await setup.query("rollback");
        }
      } finally {
        await setup.query(origClockFn.fn_def);
        const { rows: [restoredDate] } = await observer.query(
          "select public.direct_entry_authorization_date()::text as today_vn",
        );
        assert.equal(restoredDate.today_vn, dates.today);
      }
    });
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
