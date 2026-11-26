/**
 * WP8D (Nav Slice) — Read-Only Work Reports Navbar Probe Real PostgreSQL Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`).
 *
 * Verifies under real PostgreSQL + `SET LOCAL ROLE service_role`:
 *   1. Deterministic advisory-lock non-blocking proof: while Connection 1 holds
 *      `pg_advisory_xact_lock(hashtext('work_report_materialize_actor'), hashtext(actor))`,
 *      Connection 2 executes `work_report_has_active_obligations` inside
 *      `BEGIN TRANSACTION READ ONLY; SET LOCAL lock_timeout = '500ms';` without
 *      blocking, deadlocking, or failing with `25006` — proving zero advisory locks
 *      and zero writes.
 *   2. Concurrent READ ONLY nav probes across multiple sessions racing against
 *      `work_report_list_my_obligations` (advisory lock + INSERT materialization)
 *      on the same actor: zero `40P01`, zero `25006`, zero errors.
 *   3. Concurrent READ ONLY nav probes racing against assignment revoke + replacement
 *      assignment creation on the same actor: zero `40P01`, zero `25006`, valid boolean
 *      payloads throughout.
 *   4. Live PG catalog verification of `STABLE` volatility and strict ACLs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { WP8D_NAV_READONLY_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN = {
  auth: "18900000-0000-4000-8000-000000000001",
  app: "28900000-0000-4000-8000-000000000001",
  email: "wp8d.admin@hrpartner.vn",
  name: "WP8D Race Admin",
};
const STAFF_LOCK = {
  auth: "18900000-0000-4000-8000-000000000002",
  app: "28900000-0000-4000-8000-000000000002",
  email: "wp8d.lock@hrpartner.vn",
  name: "WP8D Lock Probe Staff",
};
const STAFF_RACE = {
  auth: "18900000-0000-4000-8000-000000000003",
  app: "28900000-0000-4000-8000-000000000003",
  email: "wp8d.race@hrpartner.vn",
  name: "WP8D Race Staff",
};

const SIMPLE_SCHEMA = {
  version: "work-report-schema/1.0",
  sections: [
    {
      section_key: "daily_kpi",
      label: "Kết quả ngày",
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
            aggregations: ["SUM", "AVG"],
            null_policy: "EXCLUDE_FROM_AVG",
            zero_policy: "INCLUDE_AS_ZERO",
            compatible_group: "wp8d_race_calls_v1",
          },
          is_dimension: false,
        },
      ],
    },
  ],
};

const SIMPLE_METRIC_CONTRACT = {
  version: "work-report-metrics/1.0",
  metrics: [
    {
      field_key: "calls_made",
      field_type: "integer",
      metric_key: "calls_made",
      unit: "cuộc",
      aggregations: ["SUM", "AVG"],
      null_policy: "EXCLUDE_FROM_AVG",
      zero_policy: "INCLUDE_AS_ZERO",
      compatible_group: "wp8d_race_calls_v1",
    },
  ],
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `a8900000-0000-4000-8000-${hex}`;
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
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "wp8d-race") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function runReadOnlyProbe(client, actor) {
  await client.query("begin transaction read only");
  try {
    await client.query("set local lock_timeout = '500ms'");
    await client.query("set local role service_role");
    const { rows } = await client.query(
      "select public.work_report_has_active_obligations($1::uuid, $2::uuid) as res",
      [actor.auth, actor.app],
    );
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

test("WP8D real PostgreSQL concurrency: READ ONLY Work Reports nav probe acquires zero advisory locks and races cleanly against materializer and assignment lifecycle", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL binaries not available in PATH");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "wp8d-pg-race-"));
  const pgData = path.join(tmpRoot, "pgdata");
  const pgLog = path.join(tmpRoot, "pg.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"]);
    run(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-o",
        `-h 127.0.0.1 -p ${port} -k "" -c deadlock_timeout=100ms`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "postgres", "wp8d-setup");
    const w1 = await connect(port, "postgres", "wp8d-w1");
    const w2 = await connect(port, "postgres", "wp8d-w2");
    const w3 = await connect(port, "postgres", "wp8d-w3");
    const w4 = await connect(port, "postgres", "wp8d-w4");
    clients.push(setup, w1, w2, w3, w4);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );
    const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql") && f <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
    assert.ok(names.includes(WP8D_NAV_READONLY_MIGRATION_NAME));
    for (const name of names) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    // Seed team & recruiter links so work_report_set_assignment_state / create_assignment can resolve assignee teams
    const raceTeamId = nextUuid();
    await setup.query(
      "insert into public.teams (team_id, code, display_name) values ($1::uuid, 'WP8D_RACE_TEAM', 'WP8D Race Team')",
      [raceTeamId],
    );

    // Seed users
    for (const u of [ADMIN, STAFF_LOCK, STAFF_RACE]) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await setup.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1::uuid, $2::uuid, true, $3)",
        [u.app, u.auth, u.name],
      );
    }
    for (const staff of [STAFF_LOCK, STAFF_RACE]) {
      const recId = nextUuid();
      await setup.query(
        "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
        [recId, staff.name],
      );
      await setup.query(
        `insert into public.direct_entry_app_user_recruiter_links (
           app_user_id, recruiter_id, verified, is_current, valid_from
         ) values ($1::uuid, $2::uuid, true, true, '2026-01-01')`,
        [staff.app, recId],
      );
      await setup.query(
        `insert into public.recruiter_team_memberships (
           recruiter_id, team_id, valid_from, is_current
         ) values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [recId, raceTeamId],
      );
    }
    for (const cap of ["entry_admin", "report_form_manage", "report_assign", "report_view"]) {
      await setup.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [ADMIN.app, cap],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [ADMIN.app],
    );

    const { rows: [{ vn_today: today }] } = await setup.query(
      "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as vn_today",
    );

    // Create published template via real RPC
    await setup.query("set role service_role");
    const { rows: [{ res: tplCreated }] } = await setup.query(
      `select public.work_report_create_template(
         $1::uuid, $2::uuid, 'WP8D_RACE_TPL', 'WP8D Race Template', 'Concurrency test', 'DAILY',
         $3::jsonb, $4::jsonb, $5
       ) as res`,
      [ADMIN.auth, ADMIN.app, JSON.stringify(SIMPLE_SCHEMA), JSON.stringify(SIMPLE_METRIC_CONTRACT), `tpl-${nextUuid()}`],
    );
    await setup.query(
      "select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)",
      [ADMIN.auth, ADMIN.app, tplCreated.template_id, tplCreated.draft_version_id, `pub-${nextUuid()}`],
    );
    await setup.query("reset role");

    // Insert unmaterialized USER assignments directly for STAFF_LOCK and STAFF_RACE
    await setup.query(
      `insert into public.work_report_assignments (
         assignment_id, template_id, template_version_id, target_kind, target_user_id,
         frequency, is_mandatory, timezone, due_day_offset, due_time_local, exclude_sundays,
         effective_from, state, is_current, assigned_by_user_id
       ) values
       ($1::uuid, $3::uuid, $4::uuid, 'USER', $5::uuid, 'DAILY', true, 'Asia/Ho_Chi_Minh', 0, '23:59:59', false, $7::date, 'ACTIVE', true, $8::uuid),
       ($2::uuid, $3::uuid, $4::uuid, 'USER', $6::uuid, 'DAILY', true, 'Asia/Ho_Chi_Minh', 0, '23:59:59', false, $7::date, 'ACTIVE', true, $8::uuid)`,
      [
        nextUuid(),
        nextUuid(),
        tplCreated.template_id,
        tplCreated.draft_version_id,
        STAFF_LOCK.app,
        STAFF_RACE.app,
        today,
        ADMIN.app,
      ],
    );

    // -------------------------------------------------------------------------
    // 1. Deterministic barrier: hold materializer advisory lock on w1 while w2
    //    runs READ ONLY nav probe with lock_timeout = 500ms.
    // -------------------------------------------------------------------------
    await w1.query("begin");
    try {
      await w1.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('work_report_materialize_actor'), pg_catalog.hashtext($1))",
        [STAFF_LOCK.app],
      );
      const probeRes = await runReadOnlyProbe(w2, STAFF_LOCK);
      assert.deepEqual(probeRes, { has_active_obligations: true });
    } finally {
      await w1.query("rollback");
    }

    const { rows: [{ cnt: lockStaffObligations }] } = await setup.query(
      "select count(*)::integer as cnt from public.work_report_obligations where assignee_app_user_id = $1::uuid",
      [STAFF_LOCK.app],
    );
    assert.equal(lockStaffObligations, 0, "READ ONLY probe wrote zero obligations");

    // -------------------------------------------------------------------------
    // 2. Concurrent READ ONLY nav probes racing against materializer on STAFF_RACE
    // -------------------------------------------------------------------------
    const race1Results = await Promise.all([
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          const r = await runReadOnlyProbe(w1, STAFF_RACE);
          assert.deepEqual(r, { has_active_obligations: true });
        }
        return "probe-w1-ok";
      })(),
      (async () => {
        for (let i = 0; i < 8; i += 1) {
          const r = await runReadOnlyProbe(w2, STAFF_RACE);
          assert.deepEqual(r, { has_active_obligations: true });
        }
        return "probe-w2-ok";
      })(),
      (async () => {
        for (let i = 0; i < 5; i += 1) {
          await w3.query("begin");
          try {
            await w3.query("set local role service_role");
            const { rows } = await w3.query(
              "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as res",
              [STAFF_RACE.auth, STAFF_RACE.app],
            );
            await w3.query("commit");
            assert.equal(rows[0].res.items.length, 1);
          } catch (err) {
            await w3.query("rollback").catch(() => {});
            throw err;
          }
        }
        return "materializer-w3-ok";
      })(),
    ]);
    assert.deepEqual(race1Results, ["probe-w1-ok", "probe-w2-ok", "materializer-w3-ok"]);

    // -------------------------------------------------------------------------
    // 3. Concurrent READ ONLY probes racing against assignment revoke + recreate
    // -------------------------------------------------------------------------
    const { rows: [{ assignment_id: lockAssignId }] } = await setup.query(
      "select assignment_id from public.work_report_assignments where target_user_id = $1::uuid and is_current",
      [STAFF_LOCK.app],
    );
    const race2 = await Promise.all([
      (async () => {
        const seen = [];
        for (let i = 0; i < 10; i += 1) {
          const r = await runReadOnlyProbe(w1, STAFF_LOCK);
          assert.deepEqual(Object.keys(r), ["has_active_obligations"]);
          assert.equal(typeof r.has_active_obligations, "boolean");
          seen.push(r.has_active_obligations);
        }
        return seen;
      })(),
      (async () => {
        await w4.query("begin");
        try {
          await w4.query("set local role service_role");
          await w4.query(
            "select public.work_report_set_assignment_state($1::uuid, $2::uuid, $3::uuid, 1, 'REVOKED', $4)",
            [ADMIN.auth, ADMIN.app, lockAssignId, `rev-${nextUuid()}`],
          );
          await w4.query("commit");
        } catch (err) {
          await w4.query("rollback").catch(() => {});
          throw err;
        }
        await w4.query("begin");
        try {
          await w4.query("set local role service_role");
          await w4.query(
            `select public.work_report_create_assignment(
               $1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null::uuid, null::uuid[],
               'DAILY', true, 0, '23:59:59'::time, false, $5::date, null::date, $6
             )`,
            [ADMIN.auth, ADMIN.app, tplCreated.template_id, STAFF_LOCK.app, today, `recreate-${nextUuid()}`],
          );
          await w4.query("commit");
        } catch (err) {
          await w4.query("rollback").catch(() => {});
          throw err;
        }
        return "mutator-ok";
      })(),
    ]);
    assert.equal(race2[1], "mutator-ok");
    const finalProbe = await runReadOnlyProbe(w2, STAFF_LOCK);
    assert.deepEqual(finalProbe, { has_active_obligations: true });

    // -------------------------------------------------------------------------
    // 4. Live PG catalog volatility & ACL check
    // -------------------------------------------------------------------------
    const { rows: [catalogRow] } = await setup.query(
      `select p.provolatile,
              p.prosecdef,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'work_report_has_active_obligations'`,
    );
    assert.equal(catalogRow.provolatile, "s");
    assert.equal(catalogRow.prosecdef, true);
    assert.equal(catalogRow.pub_exec, false);
    assert.equal(catalogRow.anon_exec, false);
    assert.equal(catalogRow.auth_exec, false);
    assert.equal(catalogRow.svc_exec, true);
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
