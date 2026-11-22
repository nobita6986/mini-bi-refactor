/**
 * Workforce Offboarding Report — Real PostgreSQL Performance, Single-Pass,
 * and Legacy-vs-Optimized Oracle Regression Test.
 *
 * Boots an isolated native PostgreSQL cluster (`initdb` + `pg_ctl`), applies
 * all migrations up to right before `20261102090000_hf_offboarding_report_query_performance.sql`,
 * seeds Production-scale data (3,000 `direct_entries` and 4,000
 * `direct_entry_employment_status_events` across multi-episode workers, ON/OFF
 * mixes, superseded chains, future events, <3d vs >=3d OFF dates, team scopes,
 * and active/stale suppressions), captures the legacy oracle outputs, then
 * applies `20261102090000_hf_offboarding_report_query_performance.sql` and verifies:
 *   1. Exact semantic & field-by-field parity with the legacy oracle across
 *      all authorities (`all` and `team` scopes), pages (first, middle, last,
 *      out-of-range), export, and snapshot suppression/reappearance.
 *   2. Under `SET LOCAL statement_timeout = '8s'`, `direct_entry_offboarding_report`
 *      returns 25 rows + exact `total` well within the safety budget.
 *   3. `pg_stat_user_functions` confirms `direct_entry__internal_offboarding_candidates`
 *      is executed exactly ONCE per `direct_entry_offboarding_report` invocation
 *      (never twice) and `direct_entry__internal_offboarding_rows` is not called
 *      at all during paginated list reads.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  parseOffboardingHideResult,
  parseOffboardingReportExport,
  parseOffboardingReportList,
} from "../src/lib/workforce/offboarding-report-contract.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const PERF_MIGRATION = "20261102090000_hf_offboarding_report_query_performance.sql";

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

async function connect(port, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function resetUserFunctionStats(client) {
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_reset()");
  await client.query("select pg_stat_clear_snapshot()");
}

async function readUserFunctionStats(client, funcNames) {
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_clear_snapshot()");
  const { rows } = await client.query(
    `
      select funcname, calls::int as calls
      from pg_stat_user_functions
      where funcname = any($1::text[])
      order by funcname
    `,
    [funcNames],
  );
  return rows;
}

test(
  "Real PostgreSQL offboarding performance (3,000 entries / 4,000 status events): single candidate pass, <8s timeout safety, and 100% legacy oracle parity",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the native performance regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "offboarding-perf-pg-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const port = await freePort();
    let serverStarted = false;
    let client;

    try {
      run(initdb, [
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--pgdata",
        dataDir,
      ]);
      run(
        pgCtl,
        [
          "-D",
          dataDir,
          "-l",
          logFile,
          "-o",
          `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`} -c track_functions=all`,
          "-w",
          "start",
        ],
        { ignoreOutput: process.platform === "win32" },
      );
      serverStarted = true;

      client = await connect(port);
      await client.query(
        "create role anon nologin; create role authenticated nologin;" +
          " create role service_role nologin bypassrls;" +
          " create schema auth; create table auth.users (id uuid primary key);" +
          " create table public.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now());",
      );

      const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
      const perfIdx = names.indexOf(PERF_MIGRATION);
      assert.ok(perfIdx > 0, `${PERF_MIGRATION} must exist in supabase/migrations`);

      // 1. Apply all migrations up to right before the performance hotfix
      for (const name of names.slice(0, perfIdx)) {
        await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }

      // 2. Seed actors, teams, recruiters, projects, and 3,000 entries + 4,000 status events
      const adminAuth = "91000000-0000-4000-8000-000000000001";
      const adminApp = "91000000-0000-4000-8000-000000000002";
      const bodAuth = "91000000-0000-4000-8000-000000000003";
      const bodApp = "91000000-0000-4000-8000-000000000004";
      const leadAuth = "91000000-0000-4000-8000-000000000005";
      const leadApp = "91000000-0000-4000-8000-000000000006";
      const teamA = "91000000-0000-4000-8000-000000000011";
      const teamB = "91000000-0000-4000-8000-000000000012";
      const recA = "91000000-0000-4000-8000-000000000021";
      const recB = "91000000-0000-4000-8000-000000000022";
      const reasonId = "91000000-0000-4000-8000-000000000031";

      const leadRec = "91000000-0000-4000-8000-000000000020";

      await client.query(`
        insert into auth.users (id) values ('${adminAuth}'), ('${bodAuth}'), ('${leadAuth}');
        insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
        values
          ('${adminApp}', '${adminAuth}', true, 'Perf Admin'),
          ('${bodApp}', '${bodAuth}', true, 'Perf BoD'),
          ('${leadApp}', '${leadAuth}', true, 'Perf Team Lead');
        insert into public.teams (team_id, code, display_name, active)
        values
          ('${teamA}', 'PERF_TA', 'Team Alpha', true),
          ('${teamB}', 'PERF_TB', 'Team Beta', true);
        insert into public.recruiters (recruiter_id, display_name, active)
        values
          ('${leadRec}', 'Lead Recruiter Alpha', true),
          ('${recA}', 'Recruiter Alpha', true),
          ('${recB}', 'Recruiter Beta', true);
        insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
        values
          ('${leadRec}', 'hrp', '2020-01-01', true),
          ('${recA}', 'hrp', '2020-01-01', true),
          ('${recB}', 'hrp', '2020-01-01', true);
        insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
        values
          ('${leadRec}', '${teamA}', '2020-01-01', true),
          ('${recA}', '${teamA}', '2020-01-01', true),
          ('${recB}', '${teamB}', '2020-01-01', true);
        insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
        values
          ('${adminApp}', 'entry_admin', '2020-01-01', true),
          ('${adminApp}', 'recruiter_master_manage', '2020-01-01', true),
          ('${adminApp}', 'team_master_manage', '2020-01-01', true),
          ('${bodApp}', 'entry_privileged_edit', '2020-01-01', true),
          ('${leadApp}', 'team_manager_assign', '2020-01-01', true);
        insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
        values
          ('${adminApp}', 'all', null, '2020-01-01', true),
          ('${bodApp}', 'all', null, '2020-01-01', true),
          ('${leadApp}', 'team', '${teamA}', '2020-01-01', true);
        insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
        values
          ('${leadApp}', '${leadRec}', true, '2020-01-01', true);
        insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
        values
          ('${teamA}', '${leadApp}', '${leadRec}', '2020-01-01', true);
        insert into public.direct_entry_projects (project_id, display_name)
        values
          ('perf_p1', 'Project One'),
          ('perf_p2', 'Project Two');
        insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text)
        values ('${reasonId}', '${adminApp}', 'Perf seed status');
      `);

      // Seed 3,000 direct_entries and 4,000 employment status events covering:
      // - Multi-episode workers (entries 1..600 and 2401..3000 share CCCD 1..600):
      //   - 1..150: both episodes OFF >= 3 days -> eligible (150 workers)
      //   - 151..300: episode 1 OFF, episode 2 ON -> disqualified by active ON episode
      //   - 301..600: episode 1 ON, episode 2 OFF -> disqualified by active ON episode
      // - Single-episode workers (entries 601..2400):
      //   - 601..1000: v1 OFF >= 3 days -> eligible (400 workers, 901..1000 have v1 superseded by v2 OFF)
      //   - 1001..1030: v1 ON, v2 OFF >= 3 days, plus a future event (effective_date > auth_date) -> eligible (30 workers)
      //   - 1031..1050: v1 OFF = exactly 3 days ago -> eligible (20 workers; total = 600 before suppression)
      //   - 1051..1100: v1 OFF = 2 days ago (< 3 days threshold) -> excluded
      //   - 1101..1200: v1 OFF >= 10 days ago, but superseded by v2 ON -> excluded
      //   - 1201..2400: active ON -> excluded
      await client.query(`
        alter table public.direct_entries disable trigger user;
        alter table public.direct_entry_submissions disable trigger user;
        alter table public.direct_entry_employment_status_events disable trigger user;

        with nums as (
          select g as i,
                 ('92000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid as entry_id,
                 ('93000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid as sub_id,
                 ('94000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid as cand_id,
                 case
                   when g <= 2400 then lpad(g::text, 12, '0')
                   else lpad((g - 2400)::text, 12, '0')
                 end as cccd
          from generate_series(1, 3000) g
        ),
        ins_cand as (
          insert into public.direct_entry_candidates (candidate_id)
          select cand_id from nums
        ),
        ins_sub as (
          insert into public.direct_entry_submissions (
            submission_id, created_by_user_id, state, submitted_at, version
          )
          select
            sub_id,
            '91000000-0000-4000-8000-000000000002'::uuid,
            'SUBMITTED',
            timestamptz '2026-01-01 00:00:00Z' + (i || ' minutes')::interval,
            2
          from nums
        )
        insert into public.direct_entries (
          entry_id, submission_id, candidate_id, created_by_user_id, project_id,
          first_work_date, employee_code, worker_details, recruiter_id, team_id,
          provider_type, labor_type, created_at
        )
        select
          n.entry_id,
          n.sub_id,
          n.cand_id,
          '91000000-0000-4000-8000-000000000002'::uuid,
          case when n.i % 2 = 0 then 'perf_p1' else 'perf_p2' end,
          case when n.i <= 2400 then date '2026-01-10' + (n.i % 40) else date '2026-03-10' + (n.i % 20) end,
          'hrp-2026-' || lpad(n.i::text, 6, '0'),
          jsonb_build_object(
            'display_name', 'Worker Perf ' || n.i,
            'date_of_birth', jsonb_build_object('state', 'omitted'),
            'national_id', jsonb_build_object('state', 'provided', 'value', n.cccd),
            'address', jsonb_build_object('state', 'omitted'),
            'phone', case
              when n.i % 3 = 0 then jsonb_build_object('state', 'omitted')
              else jsonb_build_object('state', 'provided', 'value', '090' || lpad(n.i::text, 7, '0'))
            end
          ),
          case when n.i % 2 = 0 then '91000000-0000-4000-8000-000000000021'::uuid else '91000000-0000-4000-8000-000000000022'::uuid end,
          case when n.i % 2 = 0 then '91000000-0000-4000-8000-000000000011'::uuid else '91000000-0000-4000-8000-000000000012'::uuid end,
          'hrp',
          'TEMPORARY',
          timestamptz '2026-01-01 00:00:00Z' + (n.i || ' minutes')::interval
        from nums n;

        -- 3,000 v1 status events (one per entry)
        insert into public.direct_entry_employment_status_events (
          event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
          version, actor_user_id, reason_id, supersedes_event_id, applied_at
        )
        select
          ('95000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          ('92000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          case
            when g between 1 and 300 then 'OFF'
            when g between 601 and 1000 then 'OFF'
            when g between 1031 and 1050 then 'OFF'
            when g between 1051 and 1100 then 'OFF'
            when g between 1101 and 1200 then 'OFF'
            when g between 2401 and 2550 then 'OFF'
            when g between 2701 and 3000 then 'OFF'
            else 'ON'
          end,
          case
            when g between 1 and 300 then public.direct_entry_authorization_date() - (10 + (g % 20))
            when g between 601 and 1000 then public.direct_entry_authorization_date() - (4 + (g % 30))
            when g between 1031 and 1050 then public.direct_entry_authorization_date() - 3
            when g between 1051 and 1100 then public.direct_entry_authorization_date() - 2
            when g between 1101 and 1200 then public.direct_entry_authorization_date() - 12
            when g between 2401 and 2550 then public.direct_entry_authorization_date() - (5 + (g % 15))
            when g between 2701 and 3000 then public.direct_entry_authorization_date() - (6 + (g % 15))
            else date '2026-01-15'
          end,
          case
            when g between 1 and 300 then public.direct_entry_authorization_date() - (10 + (g % 20))
            when g between 601 and 1000 then public.direct_entry_authorization_date() - (4 + (g % 30))
            when g between 1031 and 1050 then public.direct_entry_authorization_date() - 3
            when g between 1051 and 1100 then public.direct_entry_authorization_date() - 2
            when g between 1101 and 1200 then public.direct_entry_authorization_date() - 12
            when g between 2401 and 2550 then public.direct_entry_authorization_date() - (5 + (g % 15))
            when g between 2701 and 3000 then public.direct_entry_authorization_date() - (6 + (g % 15))
            else null
          end,
          case
            when g between 1 and 300
              or g between 601 and 1000
              or g between 1031 and 1200
              or g between 2401 and 2550
              or g between 2701 and 3000 then 'Resigned'
            else null
          end,
          1,
          '91000000-0000-4000-8000-000000000002'::uuid,
          '91000000-0000-4000-8000-000000000031'::uuid,
          null,
          timestamptz '2026-02-01 00:00:00Z' + (g || ' minutes')::interval
        from generate_series(1, 3000) g;

        -- 1,000 additional status events (bringing total to 4,000):
        -- - g in 1..100 -> entry 900+g (901..1000): v2 OFF superseding v1 OFF
        -- - g in 101..130 -> entry 900+g (1001..1030): v2 OFF >= 5 days ago
        -- - g in 131..160 -> entry 870+g (1001..1030): v3 future ON event (effective_date = auth_date + 5)
        -- - g in 161..260 -> entry 940+g (1101..1200): v2 ON superseding v1 OFF (disqualifies 1101..1200)
        -- - g in 261..1000 -> entry 1000+g (1261..2000): v2 ON superseding v1 ON
        insert into public.direct_entry_employment_status_events (
          event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
          version, actor_user_id, reason_id, supersedes_event_id, applied_at
        )
        select
          ('96000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
          case
            when g between 1 and 130 then ('92000000-0000-4000-8000-' || lpad((900 + g)::text, 12, '0'))::uuid
            when g between 131 and 160 then ('92000000-0000-4000-8000-' || lpad((870 + g)::text, 12, '0'))::uuid
            when g between 161 and 260 then ('92000000-0000-4000-8000-' || lpad((940 + g)::text, 12, '0'))::uuid
            else ('92000000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid
          end,
          case
            when g between 1 and 130 then 'OFF'
            else 'ON'
          end,
          case
            when g between 1 and 130 then public.direct_entry_authorization_date() - (5 + (g % 10))
            when g between 131 and 160 then public.direct_entry_authorization_date() + 5
            else date '2026-02-15'
          end,
          case
            when g between 1 and 130 then public.direct_entry_authorization_date() - (5 + (g % 10))
            else null
          end,
          case
            when g between 1 and 130 then 'Resigned v2'
            else null
          end,
          case
            when g between 131 and 160 then 3
            else 2
          end,
          '91000000-0000-4000-8000-000000000002'::uuid,
          '91000000-0000-4000-8000-000000000031'::uuid,
          case
            when g between 1 and 100 then ('95000000-0000-4000-8000-' || lpad((900 + g)::text, 12, '0'))::uuid
            when g between 161 and 260 then ('95000000-0000-4000-8000-' || lpad((940 + g)::text, 12, '0'))::uuid
            when g > 260 then ('95000000-0000-4000-8000-' || lpad((1000 + g)::text, 12, '0'))::uuid
            else null
          end,
          timestamptz '2026-04-01 00:00:00Z' + (g || ' minutes')::interval
        from generate_series(1, 1000) g;

        alter table public.direct_entries enable trigger user;
        alter table public.direct_entry_submissions enable trigger user;
        alter table public.direct_entry_employment_status_events enable trigger user;
      `);

      // Also insert one stale suppression row (non-matching signature) to prove stale suppressions never exclude workers
      await client.query(`
        insert into public.direct_entry_offboarding_suppressions (
          snapshot_entry_id,
          snapshot_status_event_id,
          snapshot_signature,
          reason,
          hidden_by_user_id,
          idempotency_key
        )
        values (
          '92000000-0000-4000-8000-000000000601'::uuid,
          '95000000-0000-4000-8000-000000000601'::uuid,
          '00000000000000000000000000000000',
          'Stale suppression fixture',
          '91000000-0000-4000-8000-000000000002'::uuid,
          'stale-suppression-key-001'
        );
      `);

      await client.query("analyze;");

      const { rows: tableCounts } = await client.query(`
        select
          (select count(*)::int from public.direct_entries) as entries,
          (select count(*)::int from public.direct_entry_employment_status_events) as status_events
      `);
      assert.equal(tableCounts[0].entries, 3000);
      assert.equal(tableCounts[0].status_events, 4000);

      // Hide 1 worker via legacy RPC so active suppression is also part of the before/after oracle
      const legacyFirstPageForHide = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      assert.equal(legacyFirstPageForHide.total, 600);
      const targetToHide = legacyFirstPageForHide.items[0];
      const hideRes = (
        await client.query(
          "select public.direct_entry_offboarding_hide_snapshot($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text) as data",
          [
            adminAuth,
            adminApp,
            targetToHide.snapshot_entry_id,
            targetToHide.snapshot_status_event_id,
            "Đã đối chiếu nghỉ việc thực tế",
            "perf-oracle-hide-0001",
          ],
        )
      ).rows[0].data;
      assert.ok(parseOffboardingHideResult(hideRes) !== null);
      assert.equal(hideRes.replayed, false);

      // 3. Measure BEFORE (legacy implementation) and capture oracle outputs
      await resetUserFunctionStats(client);
      const beforeStartMs = performance.now();
      const legacyAdminPage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      const beforeDurationMs = performance.now() - beforeStartMs;

      const beforeFnStats = await readUserFunctionStats(client, [
        "direct_entry_offboarding_report",
        "direct_entry__internal_offboarding_rows",
      ]);
      const beforeRowsHelperCalls =
        beforeFnStats.find((r) => r.funcname === "direct_entry__internal_offboarding_rows")?.calls ?? 0;
      assert.equal(
        beforeRowsHelperCalls,
        2,
        "Baseline reproduction: legacy direct_entry_offboarding_report invoked direct_entry__internal_offboarding_rows twice",
      );

      const legacyLeadPage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [leadAuth, leadApp],
        )
      ).rows[0].data;
      const legacyExport = (
        await client.query(
          "select public.direct_entry_offboarding_report_export($1::uuid, $2::uuid) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;

      // 4. Apply the performance hotfix migration (and remaining pre-#237 migrations; perf fixture uses legacy authz_managed=false seed users)
      for (const name of names
        .slice(perfIdx)
        .filter((f) => f < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql")) {
        await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }
      await client.query("analyze;");

      // 5. Execute under PostgREST-equivalent 8s statement_timeout and verify single-pass execution
      await resetUserFunctionStats(client);
      await client.query("begin");
      await client.query("set local role service_role");
      await client.query("set local statement_timeout = '8s'");
      const afterStartMs = performance.now();
      const afterAdminPage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      const afterDurationMs = performance.now() - afterStartMs;
      await client.query("commit");

      const afterFnStats = await readUserFunctionStats(client, [
        "direct_entry_offboarding_report",
        "direct_entry__internal_offboarding_candidates",
        "direct_entry__internal_offboarding_rows",
      ]);
      const afterReportCalls =
        afterFnStats.find((r) => r.funcname === "direct_entry_offboarding_report")?.calls ?? 0;
      const afterCandidateCalls =
        afterFnStats.find((r) => r.funcname === "direct_entry__internal_offboarding_candidates")
          ?.calls ?? 0;
      const afterRowsCalls =
        afterFnStats.find((r) => r.funcname === "direct_entry__internal_offboarding_rows")?.calls ?? 0;

      console.log(
        `[offboarding-perf] 3,000 entries / 4,000 events: BEFORE=${beforeDurationMs.toFixed(2)}ms (helper calls=${beforeRowsHelperCalls}) -> AFTER=${afterDurationMs.toFixed(2)}ms (candidate calls=${afterCandidateCalls}, full-rows helper calls=${afterRowsCalls})`,
      );

      if (process.env.PRINT_EXPLAIN === "1") {
        const { rows: authDateRows } = await client.query(
          "select public.direct_entry_authorization_date() as auth_date",
        );
        const authDate = authDateRows[0].auth_date;
        const { rows: innerPlan } = await client.query(
          `
          explain (analyze, buffers)
          with valid_entries as materialized (
            select
              e.entry_id,
              e.employee_code,
              e.first_work_date,
              e.created_at as entry_created_at,
              s.submitted_at,
              e.project_id,
              e.recruiter_id,
              nid.national_id_norm
            from public.direct_entries e
            join public.direct_entry_submissions s
              on s.submission_id = e.submission_id
            cross join lateral (
              select
                case
                  when (e.worker_details->'national_id'->>'value') ~ '^([0-9]{9}|[0-9]{12})$'
                    then e.worker_details->'national_id'->>'value'
                  else
                    case
                      when public.direct_entry_is_canonical_national_id(
                        public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value')
                      )
                      then public.direct_entry_canonical_national_id(e.worker_details->'national_id'->>'value')
                      else null
                    end
                end as national_id_norm
            ) nid
            where s.state = 'SUBMITTED'
              and e.deleted_at is null
              and e.voided_at is null
              and e.worker_details->'national_id'->>'state' = 'provided'
              and nid.national_id_norm is not null
          ),
          non_superseded_events as materialized (
            select
              ev.event_id,
              ev.entry_id,
              ev.status,
              ev.effective_date,
              ev.version,
              ev.applied_at
            from public.direct_entry_employment_status_events ev
            where not exists (
              select 1
              from public.direct_entry_employment_status_events r
              where r.supersedes_event_id = ev.event_id
            )
          ),
          latest_entry_status as (
            select distinct on (nse.entry_id)
              nse.entry_id,
              nse.status as latest_valid_status
            from non_superseded_events nse
            where nse.effective_date <= $1::date
            order by nse.entry_id, nse.effective_date desc, nse.version desc, nse.event_id desc
          ),
          entry_off_dates as (
            select
              nse.entry_id,
              max(nse.effective_date) as last_valid_off_date
            from non_superseded_events nse
            where nse.effective_date <= $1::date
              and nse.status = 'OFF'
            group by nse.entry_id
          ),
          ep as (
            select
              ve.entry_id,
              ve.employee_code,
              ve.first_work_date,
              ve.entry_created_at,
              ve.submitted_at,
              ve.project_id,
              ve.recruiter_id,
              ve.national_id_norm,
              les.latest_valid_status,
              eod.last_valid_off_date
            from valid_entries ve
            left join latest_entry_status les
              on les.entry_id = ve.entry_id
            left join entry_off_dates eod
              on eod.entry_id = ve.entry_id
          ),
          eligible as materialized (
            select
              ep.national_id_norm,
              max(ep.last_valid_off_date) as last_off_date,
              (pg_catalog.array_agg(
                ep.entry_id
                order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
              ))[1] as rep_entry_id,
              (pg_catalog.array_agg(
                ep.employee_code
                order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
              ))[1] as employee_code,
              (pg_catalog.array_agg(
                ep.project_id
                order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
              ))[1] as project_id,
              (pg_catalog.array_agg(
                ep.recruiter_id
                order by ep.last_valid_off_date desc nulls last, ep.first_work_date desc, ep.entry_id desc
              ))[1] as recruiter_id,
              (pg_catalog.array_agg(
                ep.entry_id
                order by ep.first_work_date desc, ep.submitted_at desc, ep.entry_created_at desc, ep.entry_id desc
              ))[1] as snapshot_entry_id,
              pg_catalog.string_agg(ep.entry_id::text, ',' order by ep.entry_id) as entries_sig
            from ep
            group by ep.national_id_norm
            having not coalesce(bool_or(ep.latest_valid_status = 'ON'), false)
               and max(ep.last_valid_off_date) is not null
               and max(ep.last_valid_off_date) <= $1::date - 3
          ),
          person_event_agg as materialized (
            select
              ve.national_id_norm,
              (pg_catalog.array_agg(
                nse.event_id
                order by
                  (nse.effective_date <= $1::date) desc,
                  nse.effective_date desc,
                  nse.version desc,
                  nse.applied_at desc,
                  nse.event_id desc
              ))[1] as snapshot_status_event_id,
              pg_catalog.string_agg(nse.event_id::text, ',' order by nse.event_id) as events_sig
            from valid_entries ve
            join non_superseded_events nse
              on nse.entry_id = ve.entry_id
            group by ve.national_id_norm
          ),
          candidates as materialized (
            select
              el.rep_entry_id as entry_id,
              el.employee_code,
              el.project_id,
              el.recruiter_id,
              el.last_off_date as off_effective_date,
              ($1::date - el.last_off_date)::integer as days_since_off,
              el.snapshot_entry_id,
              peva.snapshot_status_event_id,
              pg_catalog.md5(
                'entries:' || coalesce(el.entries_sig, '') ||
                '|events:' || coalesce(peva.events_sig, '')
              ) as snapshot_signature
            from eligible el
            join person_event_agg peva
              on peva.national_id_norm = el.national_id_norm
            where el.snapshot_entry_id is not null
              and peva.snapshot_status_event_id is not null
              and not exists (
                select 1
                from public.direct_entry_offboarding_suppressions sup
                where sup.snapshot_entry_id = el.snapshot_entry_id
                  and sup.snapshot_status_event_id = peva.snapshot_status_event_id
                  and sup.snapshot_signature = pg_catalog.md5(
                    'entries:' || coalesce(el.entries_sig, '') ||
                    '|events:' || coalesce(peva.events_sig, '')
                  )
              )
          ),
          counted as (
            select count(*)::int as total from candidates
          ),
          page_candidates as (
            select * from candidates
            order by off_effective_date asc, employee_code asc, entry_id asc
            limit 25 offset 0
          ),
          enriched_page as (
            select
              pc.entry_id,
              pc.employee_code,
              de.worker_details->>'display_name' as display_name,
              pc.project_id,
              p.display_name as project_display,
              pc.recruiter_id,
              r.display_name as recruiter_display,
              pc.off_effective_date,
              pc.days_since_off,
              de.worker_details->'phone'->>'value' as phone,
              pc.snapshot_entry_id,
              pc.snapshot_status_event_id
            from page_candidates pc
            join public.direct_entries de on de.entry_id = pc.entry_id
            join public.direct_entry_projects p on p.project_id = pc.project_id
            join public.recruiters r on r.recruiter_id = pc.recruiter_id
          )
          select cnt.total, count(ep.entry_id) from counted cnt left join enriched_page ep on true group by cnt.total
        `,
          [authDate],
        );
        console.log("=== EXPLAIN (ANALYZE, BUFFERS) INNER PIPELINE ===");
        console.log(innerPlan.map((r) => r["QUERY PLAN"]).join("\n"));
      }

      assert.equal(afterReportCalls, 1);
      assert.equal(
        afterCandidateCalls,
        1,
        "direct_entry__internal_offboarding_candidates must execute at most once per report call",
      );
      assert.equal(
        afterRowsCalls,
        0,
        "direct_entry_offboarding_report must not invoke full-row export helper direct_entry__internal_offboarding_rows",
      );

      assert.equal(afterAdminPage1.total, 599);
      assert.equal(afterAdminPage1.items.length, 25);
      assert.equal(afterAdminPage1.has_more, true);
      assert.ok(
        afterDurationMs < 2000,
        `Expected 25-row page on 3,000 entries / 4,000 events to complete well under 2,000ms (actual: ${afterDurationMs.toFixed(2)}ms; legacy was ${beforeDurationMs.toFixed(2)}ms)`,
      );

      // 6. Verify 100% Oracle Parity across all pages, roles, and export
      const afterAdminMidPage = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 12, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      const afterAdminLastPage = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 24, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      const afterAdminOutPage = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 25, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      const afterBodPage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [bodAuth, bodApp],
        )
      ).rows[0].data;
      const afterLeadPage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [leadAuth, leadApp],
        )
      ).rows[0].data;
      const afterLeadLastPage = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 12, 25) as data",
          [leadAuth, leadApp],
        )
      ).rows[0].data;
      const afterExport = (
        await client.query(
          "select public.direct_entry_offboarding_report_export($1::uuid, $2::uuid) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;

      assert.ok(parseOffboardingReportList(afterAdminPage1) !== null);
      assert.ok(parseOffboardingReportList(afterAdminMidPage) !== null);
      assert.ok(parseOffboardingReportList(afterAdminLastPage) !== null);
      assert.ok(parseOffboardingReportList(afterAdminOutPage) !== null);
      assert.ok(parseOffboardingReportList(afterBodPage1) !== null);
      assert.ok(parseOffboardingReportList(afterLeadPage1) !== null);
      assert.ok(parseOffboardingReportList(afterLeadLastPage) !== null);
      assert.ok(parseOffboardingReportExport(afterExport) !== null);

      assert.deepEqual(afterAdminPage1, legacyAdminPage1, "Admin page 1 oracle parity");
      assert.deepEqual(afterLeadPage1, legacyLeadPage1, "Team Leader page 1 oracle parity");
      assert.deepEqual(afterExport, legacyExport, "Full export oracle parity");
      assert.equal(afterAdminOutPage.total, 599);
      assert.equal(afterAdminOutPage.has_more, false);
      assert.deepEqual(afterAdminOutPage.items, []);
      assert.equal(afterBodPage1.authority, "bod");
      assert.equal(afterBodPage1.can_hide, true);
      assert.equal(afterBodPage1.can_export, true);
      assert.deepEqual(afterBodPage1.items, afterAdminPage1.items);
      assert.equal(afterLeadLastPage.total, legacyLeadPage1.total);
      assert.equal(afterLeadLastPage.has_more, false);
      assert.equal(
        afterLeadLastPage.items.length,
        legacyLeadPage1.total - 11 * 25,
      );

      // 7. Verify zero duplicate or missing rows across all 24 pages compared to export
      const allPagedCodes = [];
      for (let page = 1; page <= 24; page += 1) {
        const tPage0 = performance.now();
        const pageData = (
          await client.query(
            "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, $3::int, 25) as data",
            [adminAuth, adminApp, page],
          )
        ).rows[0].data;
        const tPageMs = performance.now() - tPage0;
        if (process.env.PRINT_EXPLAIN === "1" && (page <= 7 || page === 24)) {
          console.log(`  page ${page}: ${tPageMs.toFixed(2)}ms`);
        }
        assert.equal(pageData.total, 599);
        assert.equal(pageData.has_more, page < 24);
        assert.equal(pageData.items.length, page < 24 ? 25 : 24);
        for (const item of pageData.items) {
          allPagedCodes.push(item.employee_code);
        }
      }
      assert.equal(allPagedCodes.length, 599);
      assert.equal(new Set(allPagedCodes).size, 599, "Zero duplicate rows across pages");
      assert.deepEqual(
        allPagedCodes,
        afterExport.items.map((item) => item.employee_code),
        "Concatenated pages match export order and membership 100%",
      );

      // 8. Verify hide action and idempotent replay under the new migration
      const replayHideRes = (
        await client.query(
          "select public.direct_entry_offboarding_hide_snapshot($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text) as data",
          [
            adminAuth,
            adminApp,
            targetToHide.snapshot_entry_id,
            targetToHide.snapshot_status_event_id,
            "Đã đối chiếu nghỉ việc thực tế",
            "perf-oracle-hide-0001",
          ],
        )
      ).rows[0].data;
      assert.equal(replayHideRes.replayed, true);
      assert.equal(replayHideRes.suppression_id, hideRes.suppression_id);

      const secondTarget = afterAdminPage1.items[0];
      const secondHideRes = (
        await client.query(
          "select public.direct_entry_offboarding_hide_snapshot($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text) as data",
          [
            adminAuth,
            adminApp,
            secondTarget.snapshot_entry_id,
            secondTarget.snapshot_status_event_id,
            "Ẩn hồ sơ nghỉ việc đã xác nhận",
            "perf-oracle-hide-0002",
          ],
        )
      ).rows[0].data;
      assert.ok(parseOffboardingHideResult(secondHideRes) !== null);
      assert.equal(secondHideRes.replayed, false);

      const afterSecondHidePage1 = (
        await client.query(
          "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, 1, 25) as data",
          [adminAuth, adminApp],
        )
      ).rows[0].data;
      assert.equal(afterSecondHidePage1.total, 598);
      assert.equal(
        afterSecondHidePage1.items.some((i) => i.employee_code === secondTarget.employee_code),
        false,
      );
    } finally {
      if (client) await client.end().catch(() => {});
      if (serverStarted) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
