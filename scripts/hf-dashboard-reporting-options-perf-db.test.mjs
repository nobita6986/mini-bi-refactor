/**
 * Hotfix: Dashboard Recruitment options & scoped facts performance + parity regression.
 *
 * Boots an isolated PostgreSQL 18 cluster (`initdb` + `pg_ctl` with
 * `track_functions=all`), applies migrations #1..#256, seeds multi-scope
 * actors, duplicate normalized dimension keys, deactivated catalog labor types,
 * status events, and DRAFT / deleted / voided exclusions, captures BEFORE
 * oracle outputs, applies `20261127180000_hf_dashboard_reporting_options_perf.sql`,
 * and verifies:
 *   1. 100% deep-equal payload/counts/order parity for `scoped_options`,
 *      `de_options_scoped`, and `scoped_facts` across `all`, `multi_team`,
 *      `own` (with data), `own` (empty), and `own` (no verified link),
 *      including duplicate normalized project/recruiter keys and status filters.
 *   2. Fail-closed `42501` denial on disabled accounts and forged
 *      `(auth_subject, app_user_id)` pairs.
 *   3. Exclusion of DRAFT submissions, `deleted_at IS NOT NULL`, and
 *      `voided_at IS NOT NULL` rows.
 *   4. Single-pass invocation via `pg_stat_user_functions`:
 *      `direct_entry_reporting_resolve_audience` is called ONCE per RPC,
 *      `direct_entry_reporting_authorized_entries` is called ZERO times, and
 *      employment key/display helpers are NOT called per row in `scoped_facts`
 *      and only once per distinct labor-type bucket in `scoped_options`.
 *   5. Exact S0-T1-C ACLs (`service_role` ONLY on `scoped_options` and
 *      `scoped_facts`; `de_options_scoped` and all `__internal_*` helpers
 *      revoked from `PUBLIC, anon, authenticated, service_role`) and
 *      P3.1-W02C test 17 invariants on `de_options_scoped`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const PERF_MIGRATION = "20261127180000_hf_dashboard_reporting_options_perf.sql";
const SUBMISSIONS_PERF_MIGRATION = "20261127183100_hf_direct_entry_own_submissions_project_scope_perf.sql";

function uuid(group, n) {
  return `98${String(group).padStart(2, "0")}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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

async function connect(port, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

async function resetUserFunctionStats(client) {
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_reset()");
  await client.query("select pg_stat_clear_snapshot()");
}

async function readUserFunctionCalls(client, funcNames) {
  await client.query("select pg_stat_force_next_flush()");
  await client.query("select pg_stat_clear_snapshot()");
  const { rows } = await client.query(
    `
      select funcname, calls::int as calls
        from pg_stat_user_functions
       where funcname = any($1::text[])
    `,
    [funcNames],
  );
  return Object.fromEntries(rows.map((r) => [r.funcname, r.calls]));
}

function sortOptionRows(rows) {
  return [...rows].sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      a.key.localeCompare(b.key) ||
      a.display.localeCompare(b.display),
  );
}

test(
  "Dashboard reporting options & scoped facts perf hotfix: oracle parity across all scopes, exclusions, single-pass telemetry, and strict ACLs",
  async (t) => {
    const initdb = binary("initdb");
    const pgCtl = binary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL 18 initdb and pg_ctl are required");
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hf-dash-perf-db-"));
    const pgData = path.join(tmpDir, "pgdata");
    const pgLog = path.join(tmpDir, "postgres.log");
    const port = await freePort();
    let started = false;
    let client = null;

    try {
      runBin(
        initdb,
        ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"],
        { ignoreOutput: true },
      );
      runBin(
        pgCtl,
        [
          "-D",
          pgData,
          "-l",
          pgLog,
          "-w",
          "-o",
          `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c track_functions=all -c log_min_messages=warning`,
          "start",
        ],
        { ignoreOutput: true },
      );
      started = true;

      client = await connect(port);
      await client.query(
        "create role anon nologin; create role authenticated nologin;" +
          " create role service_role nologin bypassrls;" +
          " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);" +
          " create table public.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now());",
      );

      const migNames = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
      const perfIdx = migNames.indexOf(PERF_MIGRATION);
      assert.ok(perfIdx > 0, `${PERF_MIGRATION} must exist in supabase/migrations`);

      // Apply all baseline migrations (#1..#256) BEFORE the perf hotfix
      for (const name of migNames.slice(0, perfIdx)) {
        await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
      }

      const ACTORS = {
        all: { app: uuid(1, 1), auth: uuid(2, 1) },
        multiTeam: { app: uuid(1, 2), auth: uuid(2, 2) },
        ownData: { app: uuid(1, 3), auth: uuid(2, 3) },
        ownEmpty: { app: uuid(1, 4), auth: uuid(2, 4) },
        ownNoLink: { app: uuid(1, 5), auth: uuid(2, 5) },
        disabled: { app: uuid(1, 6), auth: uuid(2, 6) },
        forged: { app: uuid(1, 1), auth: uuid(2, 99) },
      };
      const TEAM_A = uuid(4, 1);
      const TEAM_B = uuid(4, 2);
      const TEAM_C = uuid(4, 3);
      const REC_A1 = uuid(3, 1);
      const REC_A2_DUP = uuid(3, 2);
      const REC_B1 = uuid(3, 3);
      const REC_C1 = uuid(3, 4);
      const REC_VENDOR = uuid(3, 5);
      const REC_EMPTY = uuid(3, 6);

      await client.query("begin");
      for (const [key, actor] of [
        ["all", ACTORS.all],
        ["multi_team", ACTORS.multiTeam],
        ["own_data", ACTORS.ownData],
        ["own_empty", ACTORS.ownEmpty],
        ["own_no_link", ACTORS.ownNoLink],
        ["disabled", ACTORS.disabled],
      ]) {
        await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
          actor.auth,
          `${key}@perf.local`,
        ]);
        await client.query(
          `insert into public.direct_entry_app_users
             (app_user_id, auth_subject, enabled, display_name, authz_managed, version)
           values ($1::uuid, $2::uuid, $3, $4, true, 1)`,
          [actor.app, actor.auth, key !== "disabled", `Perf ${key}`],
        );
      }

      await client.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values
           ($1::uuid, 'PERF_TA', 'Team Alpha', true, 1),
           ($2::uuid, 'PERF_TB', 'Team Beta', true, 1),
           ($3::uuid, 'PERF_TC', 'Team Gamma', true, 1)`,
        [TEAM_A, TEAM_B, TEAM_C],
      );

      const { rows: [vendorTeamRow] } = await client.query(
        "select public.direct_entry_system_vendor_team_id() as team_id",
      );
      const VENDOR_TEAM = vendorTeamRow.team_id;

      // Include duplicate recruiter display_name across REC_A1 and REC_A2_DUP
      for (const [rid, teamId, prov, name, code] of [
        [REC_A1, TEAM_A, "hrp", "Chuyên viên Trùng", "PERF_R01"],
        [REC_A2_DUP, TEAM_A, "hrp", "Chuyên viên Trùng", "PERF_R02"],
        [REC_B1, TEAM_B, "hrp", "Chuyên viên Beta", "PERF_R03"],
        [REC_C1, TEAM_C, "hrp", "Chuyên viên Gamma", "PERF_R04"],
        [REC_VENDOR, VENDOR_TEAM, "vendor", "Đối tác Vendor", "PERF_R05"],
        [REC_EMPTY, TEAM_C, "hrp", "Chuyên viên Trống", "PERF_R06"],
      ]) {
        await client.query(
          `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
           values ($1::uuid, $2, $3, 'STAFF', true)`,
          [rid, name, code],
        );
        await client.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
           values ($1::uuid, $2, '2020-01-01', true)`,
          [rid, prov],
        );
        if (prov !== "vendor") {
          await client.query(
            `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
             values ($1::uuid, $2::uuid, '2020-01-01', true)`,
            [rid, teamId],
          );
        }
      }

      // Projects: proj_dup_a + proj_dup_b share identical display_name (must collapse into 1 option),
      // while proj_dup_ws shares dim_key with different casing/spacing (must stay distinct by display).
      await client.query(`
        insert into public.direct_entry_projects (project_id, display_name, active, version)
        values
          ('proj_std', 'Dự án Chuẩn', true, 1),
          ('proj_dup_a', 'Dự án Trùng Tên', true, 1),
          ('proj_dup_b', 'Dự án Trùng Tên', true, 1),
          ('proj_dup_ws', '  dự   án   trùng   tên  ', true, 1)
      `);

      // Custom catalog labor type (later deactivated to verify historical option/fact retention)
      await client.query(`
        insert into public.direct_entry_labor_types
          (labor_type_key, display_name, reporting_key, sort_order, active, version)
        values ('CONTRACT_LEGACY', 'Hợp đồng cũ', 'contract_legacy', 40, true, 1)
      `);

      // Authz groups & memberships
      const { rows: [sysAdminGrp] } = await client.query(
        "select group_id from public.authz_user_groups where code = 'SYSTEM_ADMIN' and active",
      );
      const { rows: [anyDept] } = await client.query(
        "select department_id from public.organization_departments where is_active = true limit 1",
      );
      const grpOwn = uuid(8, 1);
      const grpTeamA = uuid(8, 2);
      const grpTeamB = uuid(8, 3);
      await client.query(
        `insert into public.authz_user_groups
           (group_id, code, name, description, department_id, team_id, is_system_admin, active)
         values
           ($1::uuid, 'PERF_OWN', 'Perf Own', 'Own group', $4::uuid, null, false, true),
           ($2::uuid, 'PERF_TA', 'Perf Team A', 'Team A group', $4::uuid, $5::uuid, false, true),
           ($3::uuid, 'PERF_TB', 'Perf Team B', 'Team B group', $4::uuid, $6::uuid, false, true)`,
        [grpOwn, grpTeamA, grpTeamB, anyDept.department_id, TEAM_A, TEAM_B],
      );
      await client.query(
        `insert into public.authz_user_group_capabilities (group_id, capability, started_at, reason)
         values
           ($1::uuid, 'entry_own', '2020-01-01T00:00:00Z', 'Perf own'),
           ($2::uuid, 'entry_team', '2020-01-01T00:00:00Z', 'Perf team A'),
           ($3::uuid, 'entry_team', '2020-01-01T00:00:00Z', 'Perf team B')`,
        [grpOwn, grpTeamA, grpTeamB],
      );
      await client.query(
        `insert into public.authz_user_group_members (group_id, app_user_id, started_at, reason)
         values
           ($1::uuid, $2::uuid, '2020-01-01T00:00:00Z', 'all'),
           ($1::uuid, $3::uuid, '2020-01-01T00:00:00Z', 'disabled'),
           ($4::uuid, $5::uuid, '2020-01-01T00:00:00Z', 'own data'),
           ($4::uuid, $6::uuid, '2020-01-01T00:00:00Z', 'own empty'),
           ($4::uuid, $7::uuid, '2020-01-01T00:00:00Z', 'own no link'),
           ($8::uuid, $9::uuid, '2020-01-01T00:00:00Z', 'multi team A'),
           ($10::uuid, $9::uuid, '2020-01-01T00:00:00Z', 'multi team B')`,
        [
          sysAdminGrp.group_id,
          ACTORS.all.app,
          ACTORS.disabled.app,
          grpOwn,
          ACTORS.ownData.app,
          ACTORS.ownEmpty.app,
          ACTORS.ownNoLink.app,
          grpTeamA,
          ACTORS.multiTeam.app,
          grpTeamB,
        ],
      );
      await client.query(
        `insert into public.direct_entry_app_user_recruiter_links
           (app_user_id, recruiter_id, verified, valid_from, is_current)
         values
           ($1::uuid, $2::uuid, true, '2020-01-01', true),
           ($3::uuid, $4::uuid, true, '2020-01-01', true)`,
        [ACTORS.ownData.app, REC_A1, ACTORS.ownEmpty.app, REC_EMPTY],
      );

      const reasonId = uuid(9, 1);
      await client.query(
        "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'Perf test reason')",
        [reasonId, ACTORS.all.app],
      );

      // Seed 240 active SUBMITTED entries + 15 DRAFT + 10 deleted + 10 voided
      const rowSpecs = [];
      const projects = ["proj_std", "proj_dup_a", "proj_dup_b", "proj_dup_ws"];
      const labors = ["TEMPORARY", "PERMANENT", "OUTSOURCED", "CONTRACT_LEGACY"];
      const recPool = [
        [REC_A1, TEAM_A, "hrp"],
        [REC_A2_DUP, TEAM_A, "hrp"],
        [REC_B1, TEAM_B, "hrp"],
        [REC_C1, TEAM_C, "hrp"],
        [REC_VENDOR, VENDOR_TEAM, "vendor"],
      ];
      for (let i = 1; i <= 275; i++) {
        const [rid, tid, prov] = recPool[(i - 1) % recPool.length];
        const state = i > 240 && i <= 255 ? "DRAFT" : "SUBMITTED";
        const isDeleted = i > 255 && i <= 265;
        const isVoided = i > 265;
        const day = String(((i - 1) % 27) + 1).padStart(2, "0");
        const month = i % 3 === 0 ? "2026-10" : "2026-11";
        rowSpecs.push({
          idx: i,
          entryId: uuid(7, i),
          subId: isDeleted ? uuid(6, i - 255) : uuid(6, i),
          candId: uuid(5, i),
          projectId: projects[(i - 1) % projects.length],
          firstWorkDate: `${month}-${day}`,
          code: `hrp-2026-${String(i).padStart(6, "0")}`,
          recruiterId: rid,
          teamId: tid,
          provider: prov,
          labor: labors[(i - 1) % labors.length],
          state,
          isDeleted,
          isVoided,
        });
      }

      const uniqueSubs = [...new Set(rowSpecs.map((r) => r.subId))];
      const ownDraft = rowSpecs.find((row) => row.state === "DRAFT").subId;
      await client.query(
        `insert into public.direct_entry_candidates (candidate_id)
         select x::uuid from unnest($1::uuid[]) as x`,
        [rowSpecs.map((r) => r.candId)],
      );
      await client.query(
        `insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)
         select s, case when s = $3::uuid then $4::uuid else $2::uuid end, 'DRAFT'
           from unnest($1::uuid[]) as s`,
        [uniqueSubs, ACTORS.all.app, ownDraft, ACTORS.ownData.app],
      );
      await client.query(
        `insert into public.direct_entries (
           entry_id, submission_id, candidate_id, created_by_user_id,
           project_id, first_work_date, employee_code, worker_details,
           recruiter_id, team_id, provider_type, labor_type,
           deleted_at, voided_at, voided_by_user_id, void_reason_id
         )
         select
           t.entry_id, t.sub_id, t.cand_id, case when t.sub_id = $15::uuid then $16::uuid else $13::uuid end,
           t.project_id, t.first_work_date, t.code,
           jsonb_build_object(
             'display_name', 'Worker ' || t.code,
             'date_of_birth', '{"state":"omitted"}'::jsonb,
             'national_id', '{"state":"omitted"}'::jsonb,
             'address', '{"state":"omitted"}'::jsonb,
             'phone', '{"state":"omitted"}'::jsonb
           ),
           t.recruiter_id, t.team_id, t.provider, t.labor,
           case when t.is_deleted then now() else null end,
           case when t.is_voided then now() else null end,
           case when t.is_voided then $13::uuid else null end,
           case when t.is_voided then $14::uuid else null end
         from unnest(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::date[],
           $6::text[], $7::uuid[], $8::uuid[], $9::text[], $10::text[],
           $11::boolean[], $12::boolean[]
         ) as t(
           entry_id, sub_id, cand_id, project_id, first_work_date,
           code, recruiter_id, team_id, provider, labor,
           is_deleted, is_voided
         )`,
        [
          rowSpecs.map((r) => r.entryId),
          rowSpecs.map((r) => r.subId),
          rowSpecs.map((r) => r.candId),
          rowSpecs.map((r) => r.projectId),
          rowSpecs.map((r) => r.firstWorkDate),
          rowSpecs.map((r) => r.code),
          rowSpecs.map((r) => r.recruiterId),
          rowSpecs.map((r) => r.teamId),
          rowSpecs.map((r) => r.provider),
          rowSpecs.map((r) => r.labor),
          rowSpecs.map((r) => r.isDeleted),
          rowSpecs.map((r) => r.isVoided),
          ACTORS.all.app,
          reasonId,
          ownDraft,
          ACTORS.ownData.app,
        ],
      );

      const submittedSubs = [...new Set(rowSpecs.filter((r) => r.state === "SUBMITTED" && !r.isDeleted).map((r) => r.subId))];
      await client.query(
        `insert into public.direct_entry_submission_revisions
           (submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot)
         select s, 2, $2::uuid, $3::uuid, '{"state":"DRAFT"}'::jsonb, '{"state":"REVIEW"}'::jsonb
           from unnest($1::uuid[]) as s`,
        [submittedSubs, ACTORS.all.app, reasonId],
      );
      await client.query("set constraints all immediate");
      await client.query("alter table public.direct_entry_submissions disable trigger direct_entry_submission_transition");
      await client.query(
        `update public.direct_entry_submissions
            set state = 'REVIEW', version = 2
          where submission_id = any($1::uuid[])`,
        [submittedSubs],
      );
      await client.query("alter table public.direct_entry_submissions enable trigger direct_entry_submission_transition");
      await client.query("set constraints all deferred");
      await client.query(
        `update public.direct_entry_submissions
            set state = 'SUBMITTED', version = 3, submitted_at = now()
          where submission_id = any($1::uuid[])`,
        [submittedSubs],
      );

      // Seed employment status events (ON, OFF, and superseded OFF -> ON) for status filter parity
      const ev1 = uuid(10, 1);
      const ev2 = uuid(10, 2);
      const ev3 = uuid(10, 3);
      const ev4 = uuid(10, 4);
      const ev5 = uuid(10, 5);
      const ev6 = uuid(10, 6);
      await client.query(
        `insert into public.direct_entry_employment_status_events
           (event_id, entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id, supersedes_event_id)
         values
           ($1::uuid, $4::uuid, 'ON', '2026-11-01', null, null, 1, $7::uuid, $8::uuid, null),
           ($2::uuid, $5::uuid, 'ON', '2026-11-02', null, null, 1, $7::uuid, $8::uuid, null),
           ($3::uuid, $6::uuid, 'ON', '2026-10-03', null, null, 1, $7::uuid, $8::uuid, null)`,
        [
          ev1,
          ev2,
          ev5,
          rowSpecs[0].entryId,
          rowSpecs[1].entryId,
          rowSpecs[2].entryId,
          ACTORS.all.app,
          reasonId,
        ],
      );
      await client.query(
        `insert into public.direct_entry_employment_status_events
           (event_id, entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id, supersedes_event_id)
         values
           ($1::uuid, $3::uuid, 'OFF', '2026-11-10', '2026-11-10', 'Nghỉ việc', 2, $5::uuid, $6::uuid, null),
           ($2::uuid, $4::uuid, 'OFF', '2026-11-10', '2026-11-10', 'Nghỉ việc thật', 2, $5::uuid, $6::uuid, null)`,
        [ev3, ev6, rowSpecs[1].entryId, rowSpecs[2].entryId, ACTORS.all.app, reasonId],
      );
      await client.query(
        `insert into public.direct_entry_employment_status_events
           (event_id, entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id, supersedes_event_id)
         values
           ($1::uuid, $2::uuid, 'ON', '2026-11-10', null, null, 3, $3::uuid, $4::uuid, $5::uuid)`,
        [ev4, rowSpecs[1].entryId, ACTORS.all.app, reasonId, ev3],
      );

      // Deactivate CONTRACT_LEGACY after entry insertion
      await client.query(
        "update public.direct_entry_labor_types set active = false where labor_type_key = 'CONTRACT_LEGACY'",
      );
      await client.query("commit");

      const scopeFixtures = [
        ["all", ACTORS.all],
        ["multi_team", ACTORS.multiTeam],
        ["own_data", ACTORS.ownData],
        ["own_empty", ACTORS.ownEmpty],
        ["own_no_link", ACTORS.ownNoLink],
      ];
      const factFilters = [
        ["all_time", {}],
        ["month", { from: "2026-11-01", to: "2026-11-27" }],
        ["project_dup", { project: "dự án trùng tên" }],
        ["recruiter_dup", { recruiter: "chuyên viên trùng" }],
        ["provider_vendor", { provider: "vendor" }],
        ["employment_legacy", { employment: "contract_legacy" }],
        ["status_on", { to: "2026-11-15", status: "ON" }],
        ["status_off", { to: "2026-11-15", status: "OFF" }],
      ];

      async function captureAll() {
        await client.query("begin; set local role service_role;");
        try {
          const out = {};
          for (const [name, actor] of scopeFixtures) {
            const optsRes = await client.query(
              "select public.direct_entry_reporting_scoped_options($1::uuid, $2::uuid) as data",
              [actor.auth, actor.app],
            );
            const factsByFilter = {};
            for (const [fName, filterObj] of factFilters) {
              const fRes = await client.query(
                "select public.direct_entry_reporting_scoped_facts($1::uuid, $2::uuid, $3::jsonb) as data",
                [actor.auth, actor.app, JSON.stringify(filterObj)],
              );
              factsByFilter[fName] = fRes.rows[0].data;
            }
            out[name] = { options: optsRes.rows[0].data, factsByFilter };
          }
          await client.query("commit");
          return out;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      }

      async function captureDeOptionsAsOwner() {
        const out = {};
        for (const [name, actor] of scopeFixtures) {
          const res = await client.query(
            "select dimension, key, display, recruited_count from public.direct_entry_reporting_de_options_scoped($1::uuid, $2::uuid)",
            [actor.auth, actor.app],
          );
          out[name] = sortOptionRows(res.rows);
        }
        return out;
      }

      // 1. Capture BEFORE oracle (migration #256)
      const before = await captureAll();
      const beforeDeOpts = await captureDeOptionsAsOwner();

      // 2. Apply #257 performance hotfix migration on the SAME DB
      await client.query(await readFile(path.join(MIGRATION_DIR, PERF_MIGRATION), "utf8"));

      // 3. Verify 100% deep-equal parity across all scopes & filters
      const after = await captureAll();
      const afterDeOpts = await captureDeOptionsAsOwner();

      for (const [name] of scopeFixtures) {
        assert.deepEqual(
          after[name].options,
          before[name].options,
          `scoped_options parity mismatch for ${name}`,
        );
        assert.deepEqual(
          afterDeOpts[name],
          beforeDeOpts[name],
          `de_options_scoped parity mismatch for ${name}`,
        );
        for (const [fName] of factFilters) {
          assert.deepEqual(
            after[name].factsByFilter[fName],
            before[name].factsByFilter[fName],
            `scoped_facts(${fName}) parity mismatch for ${name}`,
          );
        }
      }

      // 4. Verify business invariants: duplicate normalized keys, exclusions, counts
      const allOpts = after.all.options;
      const projDims = allOpts.dimensions.filter((d) => d.dimension === "project");
      assert.equal(
        projDims.reduce((s, d) => s + d.recruited_count, 0),
        240,
        "only 240 active SUBMITTED non-deleted non-voided entries are counted",
      );
      const dupIdenticalDisplay = projDims.filter(
        (d) => d.key === "dự án trùng tên" && d.display === "Dự án Trùng Tên",
      );
      assert.equal(dupIdenticalDisplay.length, 1, "proj_dup_a + proj_dup_b collapse into 1 bucket");
      assert.equal(dupIdenticalDisplay[0].recruited_count, 120);
      const dupDistinctDisplay = projDims.filter(
        (d) => d.key === "dự án trùng tên" && d.display === "  dự   án   trùng   tên  ",
      );
      assert.equal(dupDistinctDisplay.length, 1, "distinct display keeps its own option row");
      assert.equal(dupDistinctDisplay[0].recruited_count, 60);

      const recDup = allOpts.dimensions.filter(
        (d) => d.dimension === "recruiter" && d.key === "chuyên viên trùng",
      );
      assert.equal(recDup.length, 1, "duplicate recruiter display_name collapses cleanly");
      assert.equal(recDup[0].recruited_count, 96);

      assert.equal(
        allOpts.dimensions.some((d) => d.dimension === "employment" && d.key === "contract_legacy"),
        true,
        "deactivated catalog labor type remains reportable on existing submitted rows",
      );
      assert.deepEqual(after.own_empty.options.dimensions, []);
      assert.deepEqual(after.own_no_link.options.dimensions, []);
      assert.deepEqual(after.own_empty.factsByFilter.all_time.facts, []);
      assert.deepEqual(after.own_no_link.factsByFilter.all_time.facts, []);

      // 5. Verify 42501 denials for disabled account & forged pair
      for (const [label, actor] of [
        ["disabled", ACTORS.disabled],
        ["forged", ACTORS.forged],
      ]) {
        await client.query("begin; set local role service_role;");
        try {
          await assert.rejects(
            () =>
              client.query(
                "select public.direct_entry_reporting_scoped_options($1::uuid, $2::uuid)",
                [actor.auth, actor.app],
              ),
            (err) => err?.code === "42501",
            `scoped_options must reject ${label} with 42501`,
          );
        } finally {
          await client.query("rollback");
        }
        await client.query("begin; set local role service_role;");
        try {
          await assert.rejects(
            () =>
              client.query(
                "select public.direct_entry_reporting_scoped_facts($1::uuid, $2::uuid, '{}'::jsonb)",
                [actor.auth, actor.app],
              ),
            (err) => err?.code === "42501",
            `scoped_facts must reject ${label} with 42501`,
          );
        } finally {
          await client.query("rollback");
        }
      }

      // 6. Verify single-pass call counts via pg_stat_user_functions
      const tracked = [
        "direct_entry_reporting_resolve_audience",
        "direct_entry_reporting_authorized_entries",
        "direct_entry_reporting_de_options_scoped",
        "direct_entry_reporting__internal_de_option_buckets",
        "direct_entry_reporting__internal_de_options_for_audience",
        "direct_entry_reporting__internal_scoped_facts_entries",
        "direct_entry_reporting_employment_key",
        "direct_entry_reporting_employment_display",
        "direct_entry_reporting_source_id",
      ];
      await resetUserFunctionStats(client);
      await client.query("begin; set local role service_role;");
      await client.query(
        "select public.direct_entry_reporting_scoped_options($1::uuid, $2::uuid)",
        [ACTORS.all.auth, ACTORS.all.app],
      );
      await client.query("commit");
      const optStats = await readUserFunctionCalls(client, tracked);
      assert.equal(optStats.direct_entry_reporting_resolve_audience, 1, "scoped_options calls resolve_audience ONCE");
      assert.equal(optStats.direct_entry_reporting_authorized_entries ?? 0, 0, "scoped_options never calls authorized_entries");
      assert.equal(optStats.direct_entry_reporting_de_options_scoped ?? 0, 0);
      assert.equal(optStats.direct_entry_reporting__internal_de_option_buckets, 1);
      assert.equal(optStats.direct_entry_reporting__internal_de_options_for_audience, 1);
      assert.ok(
        (optStats.direct_entry_reporting_employment_key ?? 0) <= 4,
        `employment_key called only per distinct bucket (got ${optStats.direct_entry_reporting_employment_key})`,
      );
      assert.ok(
        (optStats.direct_entry_reporting_employment_display ?? 0) <= 4,
        `employment_display called only per distinct bucket (got ${optStats.direct_entry_reporting_employment_display})`,
      );

      await resetUserFunctionStats(client);
      await client.query("begin; set local role service_role;");
      await client.query(
        "select public.direct_entry_reporting_scoped_facts($1::uuid, $2::uuid, '{}'::jsonb)",
        [ACTORS.all.auth, ACTORS.all.app],
      );
      await client.query("commit");
      const factStats = await readUserFunctionCalls(client, tracked);
      assert.equal(factStats.direct_entry_reporting_resolve_audience, 1, "scoped_facts calls resolve_audience ONCE");
      assert.equal(factStats.direct_entry_reporting_authorized_entries ?? 0, 0, "scoped_facts never calls authorized_entries");
      assert.equal(factStats.direct_entry_reporting__internal_scoped_facts_entries, 1);
      assert.equal(factStats.direct_entry_reporting_employment_key ?? 0, 0, "scoped_facts never calls employment_key per row");
      assert.equal(factStats.direct_entry_reporting_employment_display ?? 0, 0, "scoped_facts never calls employment_display per row");
      assert.ok(
        (factStats.direct_entry_reporting_source_id ?? 0) <= 1,
        `scoped_facts resolves source_id at most once (inlined SQL constant, got ${factStats.direct_entry_reporting_source_id})`,
      );

      // 7. Verify P3.1-W02C test 17 invariants & S0-T1-C ACLs
      const { rows: [deOptDef] } = await client.query(
        "select pg_get_functiondef('public.direct_entry_reporting_de_options_scoped(uuid,uuid)'::regprocedure) as definition",
      );
      assert.equal(deOptDef.definition.includes("employment_type_key"), true);
      assert.equal(deOptDef.definition.includes("employment_type_display"), true);
      for (const literal of ["Thời vụ", "Chính thức", "TEMPORARY", "PERMANENT", "OUTSOURCED"]) {
        assert.equal(deOptDef.definition.includes(literal), false, `prohibited literal ${literal}`);
      }

      const aclChecks = [
        ["public.direct_entry_reporting_scoped_options(uuid,uuid)", true],
        ["public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)", true],
        ["public.direct_entry_reporting_de_options_scoped(uuid,uuid)", false],
        ["public.direct_entry_reporting__internal_de_option_buckets(jsonb)", false],
        ["public.direct_entry_reporting__internal_de_options_for_audience(jsonb)", false],
        ["public.direct_entry_reporting__internal_scoped_facts_entries(jsonb,date,date,text)", false],
      ];
      for (const [sig, serviceAllowed] of aclChecks) {
        const { rows: [acl] } = await client.query(
          `select
             has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc,
             has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
             has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
             has_function_privilege('public', $1::regprocedure, 'EXECUTE') as pub,
             exists (
               select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE'
             ) as pub_acl
           from pg_catalog.pg_proc p
           where p.oid = $1::regprocedure`,
          [sig],
        );
        assert.deepEqual(
          acl,
          { svc: serviceAllowed, anon: false, auth: false, pub: false, pub_acl: false },
          `ACL mismatch for ${sig}`,
        );
      }

      await client.query(
        `insert into public.direct_entry_project_manager_assignments
           (project_id, manager_recruiter_id, valid_from, is_current)
         values
           ('proj_std', $1, '2020-01-01', true),
           ('proj_dup_a', $1, '2020-01-01', true),
           ('proj_dup_b', $1, public.direct_entry_authorization_date() + 7, true),
           ('proj_std', $2, '2020-01-01', true)`,
        [REC_EMPTY, REC_A1],
      );
      await client.query(
        `insert into public.authz_user_group_capabilities (group_id, capability, started_at, reason)
         values ($1, 'submission_create', '2020-01-01', 'Perf own submissions')`,
        [grpOwn],
      );
      await client.query(
        `update public.authz_user_group_members
            set ended_at = now(), ended_by_app_user_id = $3
          where group_id = $1 and app_user_id = $2`,
        [grpOwn, ACTORS.ownEmpty.app, ACTORS.all.app],
      );
      async function listSubmissions(actor, state, cursor = null) {
        await client.query("begin; set local role service_role;");
        try {
          const { rows: [{ data }] } = await client.query(
            "select public.direct_entry_list_own_submissions($1, $2, 20, $3, $4) as data",
            [actor.auth, actor.app, cursor, state],
          );
          return data;
        } finally {
          await client.query("rollback");
        }
      }

      async function captureSubmissions() {
        const first = await listSubmissions(ACTORS.ownEmpty, "HISTORY");
        assert.equal(first.has_more, true);
        const next = await listSubmissions(ACTORS.ownEmpty, "HISTORY", first.next_cursor);
        const managed = new Set(rowSpecs.filter((row) =>
          !row.isDeleted && ["proj_std", "proj_dup_a"].includes(row.projectId)
        ).map((row) => row.subId));
        for (const item of [...first.items, ...next.items]) {
          assert.equal(managed.has(item.submission_id), true);
          assert.equal(item.project_scoped, true);
          assert.equal(item.entry_count, 1);
        }
        const combined = await listSubmissions(ACTORS.ownData, null);
        assert.ok(combined.items.some((item) =>
          item.submission_id === ownDraft && !item.project_scoped && item.state === "DRAFT"
        ));
        assert.ok(combined.items.some((item) => item.project_scoped));
        return { first, next, combined, active: await listSubmissions(ACTORS.ownData, "ACTIVE") };
      }

      const submissionsBefore = await captureSubmissions();
      await client.query(await readFile(path.join(MIGRATION_DIR, SUBMISSIONS_PERF_MIGRATION), "utf8"));
      assert.deepEqual(await captureSubmissions(), submissionsBefore);
      await resetUserFunctionStats(client);
      await listSubmissions(ACTORS.ownEmpty, "HISTORY");
      const pmChecks = "direct_entry_actor_is_assigned_project_manager";
      const pmStats = await readUserFunctionCalls(client, [pmChecks]);
      assert.equal(pmStats[pmChecks], 3, "checks each candidate project once across the entire page");
      await assert.rejects(() => listSubmissions(ACTORS.forged, "HISTORY"), { code: "42501" });
      await assert.rejects(() => listSubmissions(ACTORS.disabled, "HISTORY"), { code: "42501" });
    } finally {
      if (client) await client.end().catch(() => {});
      if (started) {
        spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
      }
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
