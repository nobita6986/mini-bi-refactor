/**
 * WP10-6 Slice 2 — Work Report Assignment Pause Windows
 * Real PostgreSQL 18 Concurrency, Lock-Ordering & Live Catalog Suite.
 *
 * Pure ESM (runs under plain `node --test`) against an isolated local
 * PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks, ZERO `23505` duplicate violations,
 * ZERO `25006` READ ONLY write errors, ZERO `0A000` volatility violations,
 * and ZERO `55P03` lock_timeout flakes under `SET LOCAL ROLE service_role`:
 *   Race 1 — Deterministic MVCC & FOR NO KEY UPDATE Barrier:
 *     (1A) Uncommitted `work_report_set_assignment_state('PAUSED')` holding
 *          `FOR NO KEY UPDATE` on `work_report_assignments` while concurrent
 *          `work_report_list_my_obligations`, `work_report_ensure_obligations_for_window(todayVn)`,
 *          and strict `READ ONLY` `work_report_has_active_obligations` execute ->
 *          zero deadlocks, zero FK `FOR KEY SHARE` blocking/timeouts!
 *     (1B) Concurrent `work_report_set_assignment_state('ACTIVE')` (reactivating from
 *          paused `[D1, NULL)`) racing `work_report_list_my_obligations`,
 *          `work_report_ensure_obligations_for_window(todayVn)`, and strict `READ ONLY`
 *          `work_report_has_active_obligations` -> zero deadlocks, zero duplicates,
 *          exact obligations `[D0, todayVn]` (D1, D2 skipped), closed window `[D1, todayVn)`.
 *   Race 2 — Multi-Wave Concurrent Storm across 6 sessions:
 *          Interleaved `ACTIVE <-> PAUSED` transitions + stale-version competitors +
 *          concurrent `list_my_obligations` + `ensure_obligations_for_window(D0/D1/D2/todayVn)` +
 *          strict `READ ONLY` `has_active_obligations` burst -> zero `40P01`/`23505`/`25006`/`0A000`/`55P03`,
 *          zero obligations ever created on paused dates `[D1, D2]`, <= 1 open pause window.
 *   Race 3 — Concurrent `work_report_archive_template` vs `work_report_set_assignment_state('ACTIVE')`
 *          + `ONCE` Singleton Pause/Resume Storm:
 *     (3A) `work_report_archive_template` vs concurrent `set_assignment_state` + `ensure` ->
 *          0 `40P01`, deterministic lock order, all open pause windows closed on archive.
 *     (3B) Unmaterialized `ONCE` paused `[D1, NULL)` reactivated concurrently with 3x
 *          `ensure_obligations_for_window(todayVn / todayVn+1)` + `list_my_obligations` ->
 *          exact 1 singleton obligation (`ONCE-${todayVn}`), 0 `40P01`, 0 `23505`.
 *   Guard 4 — Live PG18 catalog & S0-T1-C security postconditions (+0 net public RPCs,
 *          RLS + forced RLS + 0 privileges on `work_report_assignment_pause_windows`,
 *          `STABLE` volatility on candidate helper & nav probe).
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

const OWNER = {
  auth: "91100000-0000-4000-8000-00000000a001",
  app: "91100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner PW PG18",
};
const LUANPT = {
  auth: "91100000-0000-4000-8000-00000000a002",
  app: "91100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "91100000-0000-4000-8000-00000000a003",
  app: "91100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "91100000-0000-4000-8000-00000000a004",
  app: "91100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const TEAM_A = "91100000-0000-4000-8000-00000000d001";

function makeEmp(num, slug, name) {
  const hex = String(num).padStart(3, "0");
  return {
    auth: `91100000-0000-4000-8000-00000000a${hex}`,
    app: `91100000-0000-4000-8000-00000000b${hex}`,
    rec: `91100000-0000-4000-8000-00000000c${hex}`,
    email: `pw.pg18.${slug}@hrpartner.vn`,
    name,
  };
}

const EMP_RACE1 = makeEmp(101, "race1", "NV Race1 Barrier");
const EMP_RACE2 = makeEmp(102, "race2", "NV Race2 Storm");
const EMP_RACE3_ARCH = makeEmp(103, "race3arch", "NV Race3 Archive");
const EMP_RACE3_ONCE = makeEmp(104, "race3once", "NV Race3 Once");

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
  return `91110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp106_pw_pg18_${prefix}_${seq++}`;
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

async function connectPg(port, appName) {
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

async function serviceRpc(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
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

async function serviceRpcInTx(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
  await client.query("set local role service_role");
  const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
  return rows[0]?.res;
}

async function serviceRpcReadOnly(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
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

function assertZeroForbiddenErrors(settledList, context) {
  const forbidden = new Set(["40P01", "23505", "25006", "0A000", "55P03"]);
  for (const item of settledList) {
    if (item.status === "rejected") {
      const code = item.reason?.code;
      assert.equal(
        forbidden.has(code),
        false,
        `${context}: forbidden PG error ${code}: ${item.reason?.message}`,
      );
    }
  }
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

async function seedEmployee(client, user, deptId, teamId) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [user.app, user.auth, user.name],
  );
  await client.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, 'STAFF', true)`,
    [user.rec, user.name, `PWG_${user.rec.slice(-4)}`],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
     values ($1::uuid, 'hrp', '2026-01-01', true)`,
    [user.rec],
  );
  await client.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
    [user.app, user.rec],
  );
  await client.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2026-01-01', true)`,
    [user.rec, teamId],
  );
  await serviceRpc(client, "org_department_create_person_admin", [
    OWNER.auth,
    OWNER.app,
    `PWG-${user.rec.slice(-4)}`,
    user.name,
    "2026-01-01",
    deptId,
    user.app,
    1,
    null,
    "WP10-6 PG18 concurrency seed",
    nextUuid(),
    sha256(`pg18:${user.app}:${seq}`),
  ]);
}

async function createPublishedTemplate(client, code, frequency = "DAILY") {
  const created = await serviceRpc(client, "work_report_create_template", [
    OWNER.auth,
    OWNER.app,
    code,
    code,
    `PG18 Concurrency ${code}`,
    frequency,
    JSON.stringify(MINIMAL_TEMPLATE_SCHEMA),
    JSON.stringify(MINIMAL_METRIC_CONTRACT),
    nextKey("tpl"),
  ]);
  const pub = await serviceRpc(client, "work_report_publish_template", [
    OWNER.auth,
    OWNER.app,
    created.template_id,
    created.draft_version_id,
    created.version,
    nextKey("pub"),
  ]);
  return { ...created, version: pub.version };
}

async function createUserAssignment(client, templateId, targetUserId, frequency = "DAILY") {
  return serviceRpc(
    client,
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
      0,
      "18:00:00",
      false,
      null,
      null,
      nextKey("asgn"),
    ],
    CREATE_ASSIGNMENT_CASTS,
  );
}

test("WP10-6 Pause Windows Real PostgreSQL 18 Concurrency: Reactivation/Pause/Archive vs Materializers & Strict READ ONLY Probe + Live Catalog", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required for PG18 concurrency test");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-6-pw-pg18-"));
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

    const setup = await connectPg(port, "wp106_pw_setup");
    const w1 = await connectPg(port, "wp106_pw_w1");
    const w2 = await connectPg(port, "wp106_pw_w2");
    const w3 = await connectPg(port, "wp106_pw_w3");
    const w4 = await connectPg(port, "wp106_pw_w4");
    const r1 = await connectPg(port, "wp106_pw_r1");
    const r2 = await connectPg(port, "wp106_pw_r2");
    clients.push(setup, w1, w2, w3, w4, r1, r2);
    for (const c of [w1, w2, w3, w4, r1, r2]) {
      await c.query("set statement_timeout = '15s'");
    }

    const { rows: [verRow] } = await setup.query("select version() as v");
    console.log(`[WP10-6 Pause Windows] Running Real PG concurrency suite on: ${verRow.v}`);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const pwIdx = migrationFiles.indexOf(PAUSE_WINDOWS_MIGRATION_NAME);
    assert.ok(pwIdx > 0, `Migration ${PAUSE_WINDOWS_MIGRATION_NAME} must exist`);
    const groupsIdx = migrationFiles.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(groupsIdx > 0 && groupsIdx < pwIdx);

    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, migrationFiles[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i <= pwIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, migrationFiles[i]), "utf8"));
    }

    await setup.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'PW_PG18_A', 'Đội PG18 A', true, 1)",
      [TEAM_A],
    );
    const { rows: [mktDept] } = await setup.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );
    for (const emp of [EMP_RACE1, EMP_RACE2, EMP_RACE3_ARCH, EMP_RACE3_ONCE]) {
      await seedEmployee(setup, emp, mktDept.department_id, TEAM_A);
    }

    const { rows: [{ today_vn: todayVn }] } = await setup.query(
      "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
    );
    const D0 = addDaysIso(todayVn, -3);
    const D1 = addDaysIso(todayVn, -2);
    const D2 = addDaysIso(todayVn, -1);

    // =========================================================================
    // Race 1A — Uncommitted ACTIVE -> PAUSED (FOR NO KEY UPDATE) vs concurrent
    //           list_my_obligations, ensure_obligations_for_window(todayVn), &
    //           strict READ ONLY has_active_obligations (must NOT block/deadlock!)
    // =========================================================================
    {
      const tpl1a = await createPublishedTemplate(setup, "PW_RACE1A", "DAILY");
      const asgn1a = await createUserAssignment(setup, tpl1a.template_id, EMP_RACE1.app, "DAILY");
      await setup.query(
        "delete from public.work_report_obligations where assignment_id = $1::uuid",
        [asgn1a.assignment_id],
      );

      await w1.query("begin");
      const pausedInTx = await serviceRpcInTx(w1, "work_report_set_assignment_state", [
        OWNER.auth, OWNER.app, asgn1a.assignment_id, 1, "PAUSED", nextKey("r1a-pause"),
      ]);
      assert.equal(pausedInTx.state, "PAUSED");

      // While w1 holds FOR NO KEY UPDATE on work_report_assignments (uncommitted):
      // w2 (list_my_obligations) & w3 (ensure) insert into work_report_obligations (FK FOR KEY SHARE),
      // r1 runs READ ONLY probe with lock_timeout = 500ms -> ALL must complete cleanly without blocking!
      const [sList, sEnsure, sProbe] = await Promise.all([
        asSettled(serviceRpc(w2, "work_report_list_my_obligations", [EMP_RACE1.auth, EMP_RACE1.app, null])),
        asSettled(serviceRpc(w3, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn])),
        asSettled(serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_RACE1.auth, EMP_RACE1.app])),
      ]);
      await w1.query("commit");

      assertZeroForbiddenErrors([sList, sEnsure, sProbe], "Race 1A");
      assert.equal(sList.status, "fulfilled", `Race 1A list failed: ${sList.reason?.message}`);
      assert.equal(sEnsure.status, "fulfilled", `Race 1A ensure failed: ${sEnsure.reason?.message}`);
      assert.equal(sProbe.status, "fulfilled", `Race 1A READ ONLY probe failed: ${sProbe.reason?.message}`);
      assert.equal(typeof sProbe.value.has_active_obligations, "boolean");

      // Zero duplicate obligations for asgn1a
      const { rows: dupCheck } = await setup.query(
        `select period_key, count(*)::int as cnt
           from public.work_report_obligations
          where assignment_id = $1::uuid
          group by period_key
         having count(*) > 1`,
        [asgn1a.assignment_id],
      );
      assert.equal(dupCheck.length, 0, "Race 1A must produce 0 duplicate obligations");
    }

    // =========================================================================
    // Race 1B — Concurrent PAUSED -> ACTIVE reactivation vs list_my_obligations +
    //           ensure_obligations_for_window + READ ONLY has_active_obligations
    // =========================================================================
    {
      const tpl1b = await createPublishedTemplate(setup, "PW_RACE1B", "DAILY");
      const asgn1b = await createUserAssignment(setup, tpl1b.template_id, EMP_RACE1.app, "DAILY");
      await setup.query(
        "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
        [asgn1b.assignment_id, D0],
      );
      await setup.query(
        "delete from public.work_report_obligations where assignment_id = $1::uuid",
        [asgn1b.assignment_id],
      );
      await serviceRpc(setup, "work_report_set_assignment_state", [
        OWNER.auth, OWNER.app, asgn1b.assignment_id, 1, "PAUSED", nextKey("r1b-p"),
      ]);
      await setup.query(
        "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
        [asgn1b.assignment_id, D1],
      );

      // Fire reactivation + list + ensure(todayVn) + ensure(D1) + READ ONLY probe simultaneously!
      const settled = await Promise.all([
        asSettled(
          serviceRpc(w1, "work_report_set_assignment_state", [
            OWNER.auth, OWNER.app, asgn1b.assignment_id, 2, "ACTIVE", nextKey("r1b-act"),
          ]),
        ),
        asSettled(serviceRpc(w2, "work_report_list_my_obligations", [EMP_RACE1.auth, EMP_RACE1.app, null])),
        asSettled(serviceRpc(w3, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn])),
        asSettled(serviceRpc(w4, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, D1])),
        asSettled(serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_RACE1.auth, EMP_RACE1.app])),
      ]);
      assertZeroForbiddenErrors(settled, "Race 1B");
      for (const [idx, s] of settled.entries()) {
        assert.equal(s.status, "fulfilled", `Race 1B worker #${idx} failed: ${s.reason?.message}`);
      }

      // Follow-up list ensures D0 backfill completes cleanly if w2 ran before w1 committed
      await serviceRpc(setup, "work_report_list_my_obligations", [EMP_RACE1.auth, EMP_RACE1.app, null]);
      const { rows: obs1b } = await setup.query(
        `select period_start_date::text as d
           from public.work_report_obligations
          where assignment_id = $1::uuid
          order by period_start_date asc`,
        [asgn1b.assignment_id],
      );
      assert.deepEqual(
        obs1b.map((r) => r.d),
        [D0, todayVn],
        "Race 1B must produce exact [D0, todayVn] with D1, D2 skipped and 0 duplicates",
      );

      const { rows: pw1b } = await setup.query(
        `select paused_date::text as p, resumed_date::text as r
           from public.work_report_assignment_pause_windows
          where assignment_id = $1::uuid`,
        [asgn1b.assignment_id],
      );
      assert.deepEqual(pw1b, [{ p: D1, r: todayVn }]);
    }

    // =========================================================================
    // Race 2 — Multi-Wave Concurrent Storm (6 sessions)
    //          ACTIVE <-> PAUSED + stale competitors + list + ensure + READ ONLY
    // =========================================================================
    {
      const tpl2 = await createPublishedTemplate(setup, "PW_RACE2_STORM", "DAILY");
      const asgn2 = await createUserAssignment(setup, tpl2.template_id, EMP_RACE2.app, "DAILY");
      await setup.query(
        "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
        [asgn2.assignment_id, D0],
      );
      await setup.query(
        "delete from public.work_report_obligations where assignment_id = $1::uuid",
        [asgn2.assignment_id],
      );
      // Pre-record closed pause window [D1, todayVn) so D1 & D2 MUST NEVER be materialized during storm!
      await setup.query(
        `insert into public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date)
         values ($1::uuid, $2::date, $3::date)`,
        [asgn2.assignment_id, D1, todayVn],
      );

      let currentVersion = 1;
      for (let wave = 0; wave < 4; wave += 1) {
        const nextState = wave % 2 === 0 ? "PAUSED" : "ACTIVE";
        const expectedVer = currentVersion;
        const settled = await Promise.all([
          // Legit state transition
          asSettled(
            serviceRpc(w1, "work_report_set_assignment_state", [
              OWNER.auth, OWNER.app, asgn2.assignment_id, expectedVer, nextState, nextKey(`w${wave}-main`),
            ]),
          ),
          // Competing transition with same expectedVer (one wins, one gets PT409 — zero 40P01!)
          asSettled(
            serviceRpc(w2, "work_report_set_assignment_state", [
              OWNER.auth, OWNER.app, asgn2.assignment_id, expectedVer, nextState, nextKey(`w${wave}-race`),
            ]),
          ),
          // Employee personal list materialization
          asSettled(serviceRpc(w3, "work_report_list_my_obligations", [EMP_RACE2.auth, EMP_RACE2.app, null])),
          // Window ensure across paused & active dates
          asSettled(
            serviceRpc(w4, "work_report_ensure_obligations_for_window", [
              OWNER.auth, OWNER.app, [D0, D1, D2, todayVn][wave],
            ]),
          ),
          // Strict READ ONLY probes (2 concurrent sessions)
          asSettled(serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_RACE2.auth, EMP_RACE2.app])),
          asSettled(serviceRpcReadOnly(r2, "work_report_has_active_obligations", [EMP_RACE2.auth, EMP_RACE2.app])),
        ]);

        assertZeroForbiddenErrors(settled, `Race 2 wave ${wave}`);
        // Exactly one of w1/w2 won and the other received PT409
        const stateResults = [settled[0], settled[1]];
        const winners = stateResults.filter((s) => s.status === "fulfilled");
        const conflicts = stateResults.filter((s) => s.status === "rejected" && s.reason?.code === "PT409");
        assert.equal(winners.length, 1, `Race 2 wave ${wave}: exactly 1 state transition winner`);
        assert.equal(conflicts.length, 1, `Race 2 wave ${wave}: competing same-version caller must get PT409`);
        currentVersion = winners[0].value.version;

        for (const s of settled.slice(2)) {
          assert.equal(s.status, "fulfilled", `Race 2 wave ${wave} reader/materializer failed: ${s.reason?.message}`);
        }
      }

      // Final wave ended ACTIVE -> verify 0 open pause windows, 0 rows on D1/D2, exact [D0, todayVn]
      const { rows: openWins } = await setup.query(
        "select count(*)::int as cnt from public.work_report_assignment_pause_windows where assignment_id = $1::uuid and resumed_date is null",
        [asgn2.assignment_id],
      );
      assert.equal(openWins[0].cnt, 0, "Race 2 ending ACTIVE must have 0 open pause windows");

      await serviceRpc(setup, "work_report_list_my_obligations", [EMP_RACE2.auth, EMP_RACE2.app, null]);
      const { rows: obs2 } = await setup.query(
        `select period_start_date::text as d
           from public.work_report_obligations
          where assignment_id = $1::uuid
          order by period_start_date asc`,
        [asgn2.assignment_id],
      );
      assert.deepEqual(
        obs2.map((r) => r.d),
        [D0, todayVn],
        "Race 2 storm must NEVER materialize paused dates D1/D2 and must keep [D0, todayVn]",
      );
    }

    // =========================================================================
    // Race 3A — Concurrent work_report_archive_template vs set_assignment_state
    //           + ensure_obligations_for_window (0 deadlocks, all open windows closed)
    // =========================================================================
    {
      const tpl3a = await createPublishedTemplate(setup, "PW_RACE3A_ARCH", "DAILY");
      const asgn3a = await createUserAssignment(setup, tpl3a.template_id, EMP_RACE3_ARCH.app, "DAILY");
      await serviceRpc(setup, "work_report_set_assignment_state", [
        OWNER.auth, OWNER.app, asgn3a.assignment_id, 1, "PAUSED", nextKey("r3a-p"),
      ]);
      await setup.query(
        "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
        [asgn3a.assignment_id, D1],
      );

      const settled3a = await Promise.all([
        asSettled(
          serviceRpc(w1, "work_report_archive_template", [
            OWNER.auth, OWNER.app, tpl3a.template_id, tpl3a.version, nextKey("r3a-arch"),
          ]),
        ),
        asSettled(
          serviceRpc(w2, "work_report_set_assignment_state", [
            OWNER.auth, OWNER.app, asgn3a.assignment_id, 2, "ACTIVE", nextKey("r3a-act"),
          ]),
        ),
        asSettled(serviceRpc(w3, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn])),
        asSettled(serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_RACE3_ARCH.auth, EMP_RACE3_ARCH.app])),
      ]);
      assertZeroForbiddenErrors(settled3a, "Race 3A");
      assert.equal(settled3a[0].status, "fulfilled", `Race 3A archive failed: ${settled3a[0].reason?.message}`);
      // w2 either committed BEFORE archive (fulfilled, then archive revoked it) or ran AFTER archive (PT409)
      assert.ok(
        settled3a[1].status === "fulfilled" || settled3a[1].reason?.code === "PT409",
        `Race 3A set_assignment_state unexpected error: ${settled3a[1].reason?.code} ${settled3a[1].reason?.message}`,
      );
      assert.equal(settled3a[2].status, "fulfilled");
      assert.equal(settled3a[3].status, "fulfilled");

      const { rows: [asgn3aFinal] } = await setup.query(
        "select state, is_current from public.work_report_assignments where assignment_id = $1::uuid",
        [asgn3a.assignment_id],
      );
      assert.equal(asgn3aFinal.state, "REVOKED");
      assert.equal(asgn3aFinal.is_current, false);

      const { rows: open3a } = await setup.query(
        "select count(*)::int as cnt from public.work_report_assignment_pause_windows where assignment_id = $1::uuid and resumed_date is null",
        [asgn3a.assignment_id],
      );
      assert.equal(open3a[0].cnt, 0, "Race 3A archive must leave 0 open pause windows");
    }

    // =========================================================================
    // Race 3B — Concurrent ONCE Reactivation + 3x ensure + list -> Exact 1 Singleton
    // =========================================================================
    {
      const tpl3b = await createPublishedTemplate(setup, "PW_RACE3B_ONCE", "ONCE");
      const asgn3b = await createUserAssignment(setup, tpl3b.template_id, EMP_RACE3_ONCE.app, "ONCE");
      await setup.query(
        "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
        [asgn3b.assignment_id, D1],
      );
      await setup.query(
        "delete from public.work_report_obligations where assignment_id = $1::uuid",
        [asgn3b.assignment_id],
      );
      await serviceRpc(setup, "work_report_set_assignment_state", [
        OWNER.auth, OWNER.app, asgn3b.assignment_id, 1, "PAUSED", nextKey("r3b-p"),
      ]);
      await setup.query(
        "update public.work_report_assignment_pause_windows set paused_date = $2::date where assignment_id = $1::uuid",
        [asgn3b.assignment_id, D1],
      );

      const settled3b = await Promise.all([
        asSettled(
          serviceRpc(w1, "work_report_set_assignment_state", [
            OWNER.auth, OWNER.app, asgn3b.assignment_id, 2, "ACTIVE", nextKey("r3b-act"),
          ]),
        ),
        asSettled(serviceRpc(w2, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn])),
        asSettled(serviceRpc(w3, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, addDaysIso(todayVn, 1)])),
        asSettled(serviceRpc(w4, "work_report_list_my_obligations", [EMP_RACE3_ONCE.auth, EMP_RACE3_ONCE.app, null])),
        asSettled(serviceRpcReadOnly(r1, "work_report_has_active_obligations", [EMP_RACE3_ONCE.auth, EMP_RACE3_ONCE.app])),
      ]);
      assertZeroForbiddenErrors(settled3b, "Race 3B ONCE");
      for (const [idx, s] of settled3b.entries()) {
        assert.equal(s.status, "fulfilled", `Race 3B worker #${idx} failed: ${s.reason?.message}`);
      }

      const { rows: onceRows } = await setup.query(
        "select period_key, period_start_date::text as d from public.work_report_obligations where assignment_id = $1::uuid",
        [asgn3b.assignment_id],
      );
      assert.equal(onceRows.length, 1, "Race 3B ONCE must produce exact 1 singleton obligation");
      assert.equal(onceRows[0].period_key, `ONCE-${todayVn}`);
    }

    // =========================================================================
    // Guard 4 — Live PG18 Catalog & S0-T1-C Security Postconditions
    // =========================================================================
    {
      const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
      const appliedFlags = new Map(migrationFiles.slice(0, pwIdx + 1).map((n) => [n, true]));
      const sec = await verifyS0T1CSecurityPostconditions(setup, s0Sql, appliedFlags);
      assert.equal(sec.ok, true, `Live PG18 S0-T1-C check failed: ${sec.reason}`);
      assert.equal(sec.details.exposedClientOrPublicCount, 0);

      const { rows: [tbl] } = await setup.query(
        `select c.relrowsecurity,
                c.relforcerowsecurity,
                pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
                pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
                pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') as svc_sel
           from pg_catalog.pg_class c
          where c.oid = 'public.work_report_assignment_pause_windows'::regclass`,
      );
      assert.equal(tbl.relrowsecurity, true);
      assert.equal(tbl.relforcerowsecurity, true);
      assert.equal(tbl.anon_sel, false);
      assert.equal(tbl.auth_sel, false);
      assert.equal(tbl.svc_sel, false);

      const { rows: stableFns } = await setup.query(
        `select p.proname, p.provolatile
           from pg_catalog.pg_proc p
          where p.oid = any(array[
            'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)'::regprocedure,
            'public.work_report_has_active_obligations(uuid,uuid)'::regprocedure
          ])`,
      );
      assert.equal(stableFns.length, 2);
      for (const fn of stableFns) {
        assert.equal(fn.provolatile, "s", `${fn.proname} must be STABLE`);
      }
    }
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
