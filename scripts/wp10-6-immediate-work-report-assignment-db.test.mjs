/**
 * WP10-6 Slice 1 — Immediate-Effective Work Report Assignment Creation
 * Dual-Engine (PGlite + Real PostgreSQL 18) Regression & Security Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against BOTH:
 *   1. PGlite (`@electric-sql/pglite`) — migration #244 hygiene, atomic rollback zero drift,
 *      signature/overload/owner/service_role-only ACL (+0 net RPCs), and full functional matrix.
 *   2. Isolated PostgreSQL 18 cluster (`initdb` + `pg_ctl`) — full functional, HTTP API,
 *      pre-migration replay, midnight retry, USER_SET dedup, WP10-6 pause/revoke, and WP9/WP8D suite.
 *
 * Covers:
 *   1) Migration #244 hygiene (LF, 0 `@`, 0 `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`),
 *      atomic rollback zero drift, signature/overload/owner/`service_role`-only ACL (+0 net RPCs).
 *   2) New client date-less creation (`USER`, `TEAM`, `USER_SET`, `GROUP` across `DAILY`, `WEEKLY`,
 *      `MONTHLY`, `ONCE`): server writes `effective_from = today_vn`, `effective_to = null`,
 *      materializes `today_vn`, keeps cycles/deadlines/historical assignments intact.
 *   3) Legacy client new-write rules (both SQL RPC & `createWorkReportAssignment` HTTP API):
 *      - `effective_from = today_vn, effective_to = null` -> `200 ok`.
 *      - `effective_from = yesterday` or `tomorrow` -> `400 WORK_REPORT_ASSIGNMENT_INVALID`.
 *      - `effective_to != null` -> `400 WORK_REPORT_ASSIGNMENT_INVALID`.
 *   4) Pre-migration write (`0..243`) -> apply `#244` -> post-migration replay (including across
 *      midnight `D0 -> D1` and pre-migration `effective_to != null`):
 *      - Same `idempotency_key` + same payload (`USER`, `USER_SET`, `GROUP`) via SQL RPC & HTTP API
 *        returns cached `{ assignment_id, version: 1 }`, 0 duplicate rows.
 *      - Same `idempotency_key` + changed payload (`frequency`, `effective_from`, omitted dates,
 *        `target_user_ids`) rejected (`22023` / HTTP `400`).
 *   5) Post-migration midnight retry (`D0 -> D1`) for BOTH date-less & legacy payloads + `USER_SET` dedup:
 *      - Same `idempotency_key` + same date-less payload across midnight replays `{ assignment_id, version: 1 }`,
 *        keeps `effective_from = D0`, exact 1 `USER_SET` assignment.
 *      - Same `idempotency_key` + different payload on `USER_SET` rejected (`22023` / HTTP `400`).
 *      - Same `idempotency_key` + same legacy `D0` payload across midnight replays `{ assignment_id, version: 1 }`.
 *   6) Reuse WP10-6 pause-reactivate/revoke fixture checks & WP9/WP8D behavior.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

import {
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { createWorkReportAssignment } from "../src/lib/work-reports/assignment-api.ts";
import { createAssignmentRepository } from "../src/lib/work-reports/assignment-repository.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import { resolveAssignmentCreateAttempt } from "../src/lib/work-reports/assignment-create-idempotency.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_6_MIGRATION_NAME = "20261125234500_wp10_6_immediate_work_report_assignment.sql";

const CREATE_ASSIGNMENT_SIG =
  "public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)";
const CREATE_GROUP_ASSIGNMENT_SIG =
  "public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)";

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
  auth: "80100000-0000-4000-8000-00000000a001",
  app: "80100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-6",
};
const LUANPT = {
  auth: "80100000-0000-4000-8000-00000000a002",
  app: "80100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "80100000-0000-4000-8000-00000000a003",
  app: "80100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "80100000-0000-4000-8000-00000000a004",
  app: "80100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const TEAM_A = "80100000-0000-4000-8000-00000000d001";
const TEAM_B = "80100000-0000-4000-8000-00000000d002";

const EMP_1 = {
  auth: "80100000-0000-4000-8000-00000000a011",
  app: "80100000-0000-4000-8000-00000000b011",
  rec: "80100000-0000-4000-8000-00000000c011",
  email: "wp106.emp1@hrpartner.vn",
  name: "NV Mot WP10-6",
};
const EMP_2 = {
  auth: "80100000-0000-4000-8000-00000000a012",
  app: "80100000-0000-4000-8000-00000000b012",
  rec: "80100000-0000-4000-8000-00000000c012",
  email: "wp106.emp2@hrpartner.vn",
  name: "NV Hai WP10-6",
};
const EMP_3 = {
  auth: "80100000-0000-4000-8000-00000000a013",
  app: "80100000-0000-4000-8000-00000000b013",
  rec: "80100000-0000-4000-8000-00000000c013",
  email: "wp106.emp3@hrpartner.vn",
  name: "NV Ba WP10-6",
};
const EMP_PAUSE = {
  auth: "80100000-0000-4000-8000-00000000a014",
  app: "80100000-0000-4000-8000-00000000b014",
  rec: "80100000-0000-4000-8000-00000000c014",
  email: "wp106.pause@hrpartner.vn",
  name: "NV Tam Dung WP10-6",
};
const EMP_REVOKE = {
  auth: "80100000-0000-4000-8000-00000000a015",
  app: "80100000-0000-4000-8000-00000000b015",
  rec: "80100000-0000-4000-8000-00000000c015",
  email: "wp106.revoke@hrpartner.vn",
  name: "NV Thu Hoi WP10-6",
};
const EMP_XFER = {
  auth: "80100000-0000-4000-8000-00000000a016",
  app: "80100000-0000-4000-8000-00000000b016",
  rec: "80100000-0000-4000-8000-00000000c016",
  email: "wp106.xfer@hrpartner.vn",
  name: "NV Chuyen Team WP10-6",
};
const EMP_ONCE = {
  auth: "80100000-0000-4000-8000-00000000a017",
  app: "80100000-0000-4000-8000-00000000b017",
  rec: "80100000-0000-4000-8000-00000000c017",
  email: "wp106.once@hrpartner.vn",
  name: "NV Once WP10-6",
};
const EMP_INACTIVE = {
  auth: "80100000-0000-4000-8000-00000000a019",
  app: "80100000-0000-4000-8000-00000000b019",
  rec: "80100000-0000-4000-8000-00000000c019",
  email: "wp106.inactive@hrpartner.vn",
  name: "NV Nghi Viec WP10-6",
};
const EMP_DISABLED = {
  auth: "80100000-0000-4000-8000-00000000a020",
  app: "80100000-0000-4000-8000-00000000b020",
  rec: "80100000-0000-4000-8000-00000000c020",
  email: "wp106.disabled@hrpartner.vn",
  name: "NV Khoa TK WP10-6",
};

const VALID_SCHEMA = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
const VALID_METRIC_CONTRACT = buildWorkReportMetricContract(VALID_SCHEMA);

let seq = 1;
function nextUuid() {
  return `80110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_6_${prefix}_${seq++}`;
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

async function createPgliteEngine() {
  const db = new PGlite();
  const { rows: [verRow] } = await db.query("select version() as v");
  return {
    name: `PGlite (${verRow.v})`,
    async exec(sql) {
      await db.exec(sql);
    },
    async query(sql, params = []) {
      return db.query(sql, params);
    },
    async serviceQuery(sql, params = []) {
      await db.exec("begin; set local role service_role");
      try {
        const res = await db.query(sql, params);
        await db.exec("commit");
        return res;
      } catch (err) {
        await db.exec("rollback").catch(() => {});
        throw err;
      }
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

async function createPg18Engine() {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL initdb/pg_ctl binaries are required for PG18 test");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-6-assign-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  let client = null;

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
    client = await connectPg(port, "wp10-6-pg18");
    const { rows: [verRow] } = await client.query("select version() as v");
    return {
      name: `PostgreSQL (${verRow.v})`,
      async exec(sql) {
        await client.query(sql);
      },
      async query(sql, params = []) {
        return client.query(sql, params);
      },
      async serviceQuery(sql, params = []) {
        await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
        try {
          const res = await client.query(sql, params);
          await client.query("commit");
          return res;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      },
      async serviceRpc(fnName, args = [], casts = [], { readOnly = false } = {}) {
        const placeholders = args
          .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
          .join(", ");
        await client.query(
          readOnly
            ? "begin transaction read only; set local role service_role"
            : "begin; set local statement_timeout = '15s'; set local role service_role",
        );
        try {
          const res = await client.query(`select public.${fnName}(${placeholders}) as data`, args);
          await client.query("commit");
          return res.rows[0]?.data;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        }
      },
      async close() {
        await client?.end().catch(() => {});
        if (started) {
          spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
        }
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await client?.end().catch(() => {});
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function makeAssignmentRpcAdapter(engine) {
  return async (name, args) => {
    try {
      if (name === "work_report_create_assignment") {
        const data = await engine.serviceRpc(
          "work_report_create_assignment",
          [
            args.p_auth_subject,
            args.p_app_user_id,
            args.p_template_id,
            args.p_target_kind,
            args.p_target_user_id,
            args.p_target_team_id,
            args.p_target_user_ids,
            args.p_frequency,
            args.p_is_mandatory,
            args.p_due_day_offset,
            args.p_due_time_local,
            args.p_exclude_sundays,
            args.p_effective_from ?? null,
            args.p_effective_to ?? null,
            args.p_idempotency_key,
          ],
          CREATE_ASSIGNMENT_CASTS,
        );
        return { data, error: null };
      }
      if (name === "work_report_create_group_assignment") {
        const data = await engine.serviceRpc(
          "work_report_create_group_assignment",
          [
            args.p_auth_subject,
            args.p_app_user_id,
            args.p_template_id,
            args.p_target_group_id,
            args.p_frequency,
            args.p_is_mandatory,
            args.p_due_day_offset,
            args.p_due_time_local,
            args.p_exclude_sundays,
            args.p_effective_from ?? null,
            args.p_effective_to ?? null,
            args.p_idempotency_key,
          ],
          CREATE_GROUP_ASSIGNMENT_CASTS,
        );
        return { data, error: null };
      }
      throw new Error(`Unexpected RPC in assignment adapter: ${name}`);
    } catch (err) {
      return {
        data: null,
        error: {
          code: err?.code,
          message: String(err?.message ?? err),
        },
      };
    }
  };
}

function makePostRequest(body) {
  return new Request("https://bi.test/api/work-reports/assignments", {
    method: "POST",
    headers: {
      host: "bi.test",
      origin: "https://bi.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function callCreateAssignmentHttp(engine, actor, body) {
  const repository = createAssignmentRepository(makeAssignmentRpcAdapter(engine));
  const res = await createWorkReportAssignment(makePostRequest(body), "true", {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: actor.auth,
          app_user_id: actor.app,
        },
      },
    }),
    repository,
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function inspectAssignmentCreateRpcMeta(engine) {
  const { rows } = await engine.query(
    `select p.oid::regprocedure::text as sig,
            p.proname,
            p.pg_get_functiondef_text as def,
            p.proowner,
            r.rolname as proowner_name,
            p.prosecdef,
            p.provolatile,
            p.proconfig,
            pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
            pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
            pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
            (select count(*)::int
               from pg_catalog.pg_proc p2
               join pg_catalog.pg_namespace n2 on n2.oid = p2.pronamespace
              where n2.nspname = 'public' and p2.proname = p.proname) as overload_count
       from (
         select proc.*, pg_catalog.pg_get_functiondef(proc.oid) as pg_get_functiondef_text
           from pg_catalog.pg_proc proc
          where proc.oid = any(array[$1::regprocedure, $2::regprocedure])
       ) p
       join pg_catalog.pg_roles r on r.oid = p.proowner
      order by p.proname asc`,
    [CREATE_ASSIGNMENT_SIG, CREATE_GROUP_ASSIGNMENT_SIG],
  );
  assert.equal(rows.length, 2, "Both assignment create RPCs must exist");
  return rows;
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

async function seedEmployee(
  engine,
  user,
  deptId,
  teamId,
  { joinedOn = "2026-01-01", enabled = true, createPerson = true, createRecruiter = true } = {},
) {
  await engine.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await engine.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, $4, true, 1)`,
    [user.app, user.auth, user.name, enabled],
  );
  if (createRecruiter) {
    await engine.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [user.rec, user.name, `REC_${user.rec.slice(-4)}`],
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
  }
  if (createPerson) {
    const res = await engine.serviceRpc("org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      `WP106-${user.rec.slice(-4)}`,
      user.name,
      joinedOn,
      deptId,
      user.app,
      1,
      null,
      "WP10-6 seed",
      nextUuid(),
      sha256(`person:${user.app}:${seq}`),
    ]);
    return res.person;
  }
  return null;
}

async function createPublishedTemplate(engine, code, name, { frequency = "DAILY", requiresReview = false } = {}) {
  const created = await engine.serviceRpc("work_report_create_template", [
    OWNER.auth,
    OWNER.app,
    code,
    name,
    `${name} desc`,
    frequency,
    JSON.stringify(VALID_SCHEMA),
    JSON.stringify(VALID_METRIC_CONTRACT),
    nextKey("tpl"),
  ]);
  if (requiresReview) {
    await engine.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [created.draft_version_id],
    );
  }
  await engine.serviceRpc("work_report_publish_template", [
    OWNER.auth,
    OWNER.app,
    created.template_id,
    created.draft_version_id,
    created.version,
    nextKey("pub"),
  ]);
  return created;
}

async function countWrTables(engine) {
  const tables = [
    "work_report_obligations",
    "work_report_submissions",
    "work_report_submission_revisions",
    "work_report_audit_events",
    "work_report_assignments",
    "work_report_delegations",
  ];
  const counts = {};
  for (const t of tables) {
    const { rows: [{ cnt }] } = await engine.query(`select count(*)::int as cnt from public.${t}`);
    counts[t] = cnt;
  }
  return counts;
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
            coalesce(s.state, 'NOT_STARTED') as submission_state,
            (
              o.obligation_status = 'ACTIVE'
              and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
              and now() > o.due_at
              and coalesce(o.reopened_until < now(), true)
            ) as is_overdue
       from public.work_report_obligations o
       left join public.work_report_submissions s on s.obligation_id = o.obligation_id
      where o.assignment_id = $1::uuid
      order by o.period_start_date asc, o.assignee_app_user_id asc`,
    [assignmentId],
  );
  return rows;
}

async function runWp106DualEngineMatrix(engine) {
  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const wp106Idx = files.indexOf(WP10_6_MIGRATION_NAME);
  assert.ok(wp106Idx > 0, "WP10-6 migration #244 must exist");

  const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(groupsIdx > 0 && groupsIdx < wp106Idx);

  // =========================================================================
  // Phase A: Bootstrap migrations 0..243 (pre-#244)
  // =========================================================================
  await engine.exec(ROLE_PREAMBLE);
  for (let i = 0; i < groupsIdx; i += 1) {
    await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
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

  for (let i = groupsIdx; i < wp106Idx; i += 1) {
    await engine.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }

  // Seed Teams + Org Department + Employees
  await engine.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'WP106_TEAM_A', 'Đội A WP10-6', true, 1),
            ($2::uuid, 'WP106_TEAM_B', 'Đội B WP10-6', true, 1)`,
    [TEAM_A, TEAM_B],
  );
  const { rows: [mktDept] } = await engine.query(
    "select department_id from public.organization_departments where system_key = 'MARKETING'",
  );
  assert.ok(mktDept?.department_id, "MARKETING org department must exist");

  for (const emp of [EMP_1, EMP_2, EMP_PAUSE, EMP_REVOKE, EMP_XFER, EMP_ONCE]) {
    await seedEmployee(engine, emp, mktDept.department_id, TEAM_A);
  }
  await seedEmployee(engine, EMP_3, mktDept.department_id, TEAM_B);
  const pInactive = await seedEmployee(engine, EMP_INACTIVE, mktDept.department_id, null, {
    createRecruiter: false,
  });
  const { rows: [pInactVer] } = await engine.query(
    "select version from public.organization_persons where person_id = $1::uuid",
    [pInactive.person_id],
  );
  await engine.serviceRpc("org_department_update_person_admin", [
    OWNER.auth,
    OWNER.app,
    pInactive.person_id,
    pInactVer.version,
    `WP106-${EMP_INACTIVE.rec.slice(-4)}`,
    EMP_INACTIVE.name,
    "2026-01-01",
    "INACTIVE",
    "WP10-6 inactive test",
    nextUuid(),
    sha256("wp106-inactive"),
  ]);
  await seedEmployee(engine, EMP_DISABLED, mktDept.department_id, TEAM_A, {
    enabled: false,
    createPerson: false,
  });

  const grp1 = await engine.serviceRpc("work_report_create_group", [
    OWNER.auth,
    OWNER.app,
    "Nhóm WP10-6",
    "Nhóm kiểm thử WP10-6",
    [EMP_1.app, EMP_2.app],
    nextKey("grp1"),
  ]);

  const { rows: [{ today_vn: todayVn }] } = await engine.query(
    "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
  );
  const D0 = addDaysIso(todayVn, -1); // yesterday
  const D1 = todayVn;                 // today
  const D2 = addDaysIso(todayVn, 1);  // tomorrow
  const D_HIST = addDaysIso(todayVn, -5);

  // Pre-migration writes (0..243) including across midnight D0 -> D1 and effective_to != null
  const tplPreUser = await createPublishedTemplate(engine, "WP106_PRE_U", "Pre-244 USER", { frequency: "DAILY" });
  const tplPreUserSet = await createPublishedTemplate(engine, "WP106_PRE_US", "Pre-244 USER_SET", { frequency: "WEEKLY" });
  const tplPreGroup = await createPublishedTemplate(engine, "WP106_PRE_G", "Pre-244 GROUP", { frequency: "MONTHLY" });
  const tplHist = await createPublishedTemplate(engine, "WP106_HIST", "Historical Pre-244", { frequency: "DAILY" });

  const keyPreUser = nextKey("pre-user");
  const preUserRes = await engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth, OWNER.app, tplPreUser.template_id, "USER", EMP_1.app, null, null,
      "DAILY", true, 0, "18:00:00", false, D0, null, keyPreUser,
    ],
    CREATE_ASSIGNMENT_CASTS,
  );

  const keyPreUserSet = nextKey("pre-uset");
  const preUserSetRes = await engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth, OWNER.app, tplPreUserSet.template_id, "USER_SET", null, null, [EMP_1.app, EMP_2.app],
      "WEEKLY", true, 1, "19:00:00", false, D0, D2, keyPreUserSet,
    ],
    CREATE_ASSIGNMENT_CASTS,
  );

  const keyPreGroup = nextKey("pre-grp");
  const preGroupRes = await engine.serviceRpc(
    "work_report_create_group_assignment",
    [
      OWNER.auth, OWNER.app, tplPreGroup.template_id, grp1.group_id,
      "MONTHLY", false, 2, "20:00:00", true, D0, D1, keyPreGroup,
    ],
    CREATE_GROUP_ASSIGNMENT_CASTS,
  );

  // Historical assignment with submitted obligation to confirm #244 & subsequent writes leave it intact
  const histAsgn = await engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth, OWNER.app, tplHist.template_id, "USER", EMP_1.app, null, null,
      "DAILY", true, 10, "23:59:59", false, D_HIST, null, nextKey("hist-asgn"),
    ],
    CREATE_ASSIGNMENT_CASTS,
  );
  await engine.query(
    "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
    [histAsgn.assignment_id, D_HIST],
  );
  const { rows: [histOb] } = await engine.query(
    "select obligation_id from public.work_report_obligations where assignment_id = $1::uuid and period_start_date = $2::date",
    [histAsgn.assignment_id, D_HIST],
  );
  assert.ok(histOb?.obligation_id);
  await engine.serviceRpc("work_report_submit", [
    EMP_1.auth, EMP_1.app, histOb.obligation_id,
    JSON.stringify({ calls_made: 12, interested_candidates: 3, workers_started: 1, notes: "Historical" }),
    null, nextKey("hist-sub"),
  ]);

  // =========================================================================
  // Phase B: Apply migration #244 + verify catalog owner/overload/ACL
  // =========================================================================
  const wp106Sql = await readFile(path.join(MIGRATION_DIR, WP10_6_MIGRATION_NAME), "utf8");
  await engine.exec(wp106Sql);

  const { rows: [baseTblOwner] } = await engine.query(
    "select relowner from pg_catalog.pg_class where oid = 'public.work_report_assignments'::pg_catalog.regclass",
  );
  const postMeta = await inspectAssignmentCreateRpcMeta(engine);
  for (const m of postMeta) {
    assert.equal(m.overload_count, 1, `${m.proname} must have exact 1 overload`);
    assert.equal(m.proowner, baseTblOwner.relowner, `${m.proname} proowner must match work_report_assignments owner`);
    assert.equal(m.prosecdef, true, `${m.proname} must be SECURITY DEFINER`);
    assert.ok(m.proconfig.includes("search_path=pg_catalog, public"), `${m.proname} search_path`);
    assert.equal(m.pub_exec, false, `${m.proname} PUBLIC execute revoked`);
    assert.equal(m.anon_exec, false, `${m.proname} anon execute revoked`);
    assert.equal(m.auth_exec, false, `${m.proname} authenticated execute revoked`);
    assert.equal(m.svc_exec, true, `${m.proname} service_role execute granted`);
  }

  // =========================================================================
  // Phase C: Scenario 4 — Pre-migration (0..243) -> #244 -> Post-migration replay
  //          (across midnight D0 -> D1 and pre-migration effective_to != null)
  // =========================================================================
  // C1. Same idempotency_key + same payload via SQL RPC & HTTP API returns cached { assignment_id, version: 1 }
  const replayPreUserSql = await engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth, OWNER.app, tplPreUser.template_id, "USER", EMP_1.app, null, null,
      "DAILY", true, 0, "18:00:00", false, D0, null, keyPreUser,
    ],
    CREATE_ASSIGNMENT_CASTS,
  );
  assert.deepEqual(replayPreUserSql, preUserRes, "Pre-244 USER replay (SQL) returns cached result");

  const replayPreUserHttp = await callCreateAssignmentHttp(engine, OWNER, {
    template_id: tplPreUser.template_id,
    target_kind: "USER",
    target_user_id: EMP_1.app,
    target_team_id: null,
    target_user_ids: [],
    frequency: "DAILY",
    is_mandatory: true,
    due_day_offset: 0,
    due_time_local: "18:00:00",
    exclude_sundays: false,
    effective_from: D0,
    effective_to: null,
    idempotency_key: keyPreUser,
  });
  assert.equal(replayPreUserHttp.status, 200);
  assert.deepEqual(replayPreUserHttp.body, { ok: true, ...preUserRes });

  const replayPreUserSetSql = await engine.serviceRpc(
    "work_report_create_assignment",
    [
      OWNER.auth, OWNER.app, tplPreUserSet.template_id, "USER_SET", null, null, [EMP_1.app, EMP_2.app],
      "WEEKLY", true, 1, "19:00:00", false, D0, D2, keyPreUserSet,
    ],
    CREATE_ASSIGNMENT_CASTS,
  );
  assert.deepEqual(replayPreUserSetSql, preUserSetRes, "Pre-244 USER_SET (effective_to != null) SQL replay");

  const replayPreUserSetHttp = await callCreateAssignmentHttp(engine, OWNER, {
    template_id: tplPreUserSet.template_id,
    target_kind: "USER_SET",
    target_user_id: null,
    target_team_id: null,
    target_user_ids: [EMP_1.app, EMP_2.app],
    frequency: "WEEKLY",
    is_mandatory: true,
    due_day_offset: 1,
    due_time_local: "19:00:00",
    exclude_sundays: false,
    effective_from: D0,
    effective_to: D2,
    idempotency_key: keyPreUserSet,
  });
  assert.equal(replayPreUserSetHttp.status, 200);
  assert.deepEqual(replayPreUserSetHttp.body, { ok: true, ...preUserSetRes });

  const replayPreGroupSql = await engine.serviceRpc(
    "work_report_create_group_assignment",
    [
      OWNER.auth, OWNER.app, tplPreGroup.template_id, grp1.group_id,
      "MONTHLY", false, 2, "20:00:00", true, D0, D1, keyPreGroup,
    ],
    CREATE_GROUP_ASSIGNMENT_CASTS,
  );
  assert.deepEqual(replayPreGroupSql, preGroupRes, "Pre-244 GROUP (effective_to != null) SQL replay");

  const replayPreGroupHttp = await callCreateAssignmentHttp(engine, OWNER, {
    template_id: tplPreGroup.template_id,
    target_kind: "GROUP",
    target_user_id: null,
    target_team_id: null,
    target_group_id: grp1.group_id,
    target_user_ids: [],
    frequency: "MONTHLY",
    is_mandatory: false,
    due_day_offset: 2,
    due_time_local: "20:00:00",
    exclude_sundays: true,
    effective_from: D0,
    effective_to: D1,
    idempotency_key: keyPreGroup,
  });
  assert.equal(replayPreGroupHttp.status, 200);
  assert.deepEqual(replayPreGroupHttp.body, { ok: true, ...preGroupRes });

  // Verify 0 duplicate rows and preserved pre-migration dates
  for (const [tplId, expFrom, expTo] of [
    [tplPreUser.template_id, D0, null],
    [tplPreUserSet.template_id, D0, D2],
    [tplPreGroup.template_id, D0, D1],
  ]) {
    const { rows } = await engine.query(
      "select effective_from::text, effective_to::text from public.work_report_assignments where template_id = $1::uuid",
      [tplId],
    );
    assert.equal(rows.length, 1, `0 duplicate rows for pre-migration template ${tplId}`);
    assert.equal(rows[0].effective_from, expFrom);
    assert.equal(rows[0].effective_to, expTo);
  }

  // C2. Same idempotency_key + changed payload rejected (22023 / HTTP 400)
  // (a) Changed frequency
  await assert.rejects(
    () =>
      engine.serviceRpc(
        "work_report_create_assignment",
        [
          OWNER.auth, OWNER.app, tplPreUser.template_id, "USER", EMP_1.app, null, null,
          "WEEKLY", true, 0, "18:00:00", false, D0, null, keyPreUser,
        ],
        CREATE_ASSIGNMENT_CASTS,
      ),
    (err) => err?.code === "22023",
    "Pre-244 replay with changed frequency rejected (22023)",
  );
  // (b) Changed effective_from (D0 -> D1)
  await assert.rejects(
    () =>
      engine.serviceRpc(
        "work_report_create_assignment",
        [
          OWNER.auth, OWNER.app, tplPreUser.template_id, "USER", EMP_1.app, null, null,
          "DAILY", true, 0, "18:00:00", false, D1, null, keyPreUser,
        ],
        CREATE_ASSIGNMENT_CASTS,
      ),
    (err) => err?.code === "22023",
    "Pre-244 replay with changed effective_from rejected (22023)",
  );
  // (c) Omitted dates (null/null) for pre-244 key that originally had dates
  await assert.rejects(
    () =>
      engine.serviceRpc(
        "work_report_create_assignment",
        [
          OWNER.auth, OWNER.app, tplPreUser.template_id, "USER", EMP_1.app, null, null,
          "DAILY", true, 0, "18:00:00", false, null, null, keyPreUser,
        ],
        CREATE_ASSIGNMENT_CASTS,
      ),
    (err) => err?.code === "22023",
    "Pre-244 replay with omitted dates rejected (22023)",
  );
  const omitPreGroupHttp = await callCreateAssignmentHttp(engine, OWNER, {
    template_id: tplPreGroup.template_id,
    target_kind: "GROUP",
    target_user_id: null,
    target_team_id: null,
    target_group_id: grp1.group_id,
    target_user_ids: [],
    frequency: "MONTHLY",
    is_mandatory: false,
    due_day_offset: 2,
    due_time_local: "20:00:00",
    exclude_sundays: true,
    idempotency_key: keyPreGroup,
  });
  assert.equal(omitPreGroupHttp.status, 400, "Pre-244 GROUP replay with omitted dates rejected via HTTP API");
  // (d) Changed target_user_ids on USER_SET
  await assert.rejects(
    () =>
      engine.serviceRpc(
        "work_report_create_assignment",
        [
          OWNER.auth, OWNER.app, tplPreUserSet.template_id, "USER_SET", null, null, [EMP_1.app],
          "WEEKLY", true, 1, "19:00:00", false, D0, D2, keyPreUserSet,
        ],
        CREATE_ASSIGNMENT_CASTS,
      ),
    (err) => err?.code === "22023",
    "Pre-244 USER_SET replay with changed target_user_ids rejected (22023)",
  );

  // =========================================================================
  // Phase D: Scenario 2 — New client date-less creation (USER, TEAM, USER_SET, GROUP
  //          across DAILY, WEEKLY, MONTHLY, ONCE)
  // =========================================================================
  const datelessCases = [
    { kind: "USER", freq: "DAILY", via: "SQL", offset: 0, time: "18:00:00", exclSun: false, expectedObligations: 1 },
    { kind: "TEAM", freq: "WEEKLY", via: "HTTP", offset: 1, time: "19:30:00", exclSun: true, expectedObligations: 1 },
    { kind: "USER_SET", freq: "MONTHLY", via: "HTTP", offset: 2, time: "20:00:00", exclSun: false, expectedObligations: 2 },
    { kind: "GROUP", freq: "ONCE", via: "HTTP", offset: 0, time: "23:59:59", exclSun: false, expectedObligations: 2 },
    { kind: "GROUP", freq: "DAILY", via: "SQL", offset: 0, time: "17:00:00", exclSun: false, expectedObligations: 2 },
    { kind: "USER", freq: "ONCE", via: "HTTP", offset: 1, time: "21:00:00", exclSun: true, expectedObligations: 1 },
  ];

  for (const tc of datelessCases) {
    const tpl = await createPublishedTemplate(
      engine,
      `WP106_DL_${tc.kind}_${tc.freq}_${tc.via}`,
      `Date-less ${tc.kind} ${tc.freq}`,
      { frequency: tc.freq },
    );
    const idempKey = nextKey(`dl-${tc.kind}-${tc.freq}`);
    let assignmentId;

    if (tc.via === "SQL") {
      const res = tc.kind === "GROUP"
        ? await engine.serviceRpc(
            "work_report_create_group_assignment",
            [
              OWNER.auth, OWNER.app, tpl.template_id, grp1.group_id,
              tc.freq, true, tc.offset, tc.time, tc.exclSun, null, null, idempKey,
            ],
            CREATE_GROUP_ASSIGNMENT_CASTS,
          )
        : await engine.serviceRpc(
            "work_report_create_assignment",
            [
              OWNER.auth, OWNER.app, tpl.template_id, tc.kind,
              tc.kind === "USER" ? EMP_1.app : null,
              tc.kind === "TEAM" ? TEAM_B : null,
              tc.kind === "USER_SET" ? [EMP_1.app, EMP_2.app] : null,
              tc.freq, true, tc.offset, tc.time, tc.exclSun, null, null, idempKey,
            ],
            CREATE_ASSIGNMENT_CASTS,
          );
      assert.equal(res.version, 1);
      assignmentId = res.assignment_id;
    } else {
      const payload = {
        template_id: tpl.template_id,
        target_kind: tc.kind,
        target_user_id: tc.kind === "USER" ? EMP_1.app : null,
        target_team_id: tc.kind === "TEAM" ? TEAM_B : null,
        target_user_ids: tc.kind === "USER_SET" ? [EMP_1.app, EMP_2.app] : [],
        ...(tc.kind === "GROUP" ? { target_group_id: grp1.group_id } : {}),
        frequency: tc.freq,
        is_mandatory: true,
        due_day_offset: tc.offset,
        due_time_local: tc.time,
        exclude_sundays: tc.exclSun,
        idempotency_key: idempKey,
      };
      const httpRes = await callCreateAssignmentHttp(engine, OWNER, payload);
      assert.equal(httpRes.status, 200, `Date-less HTTP ${tc.kind}/${tc.freq} failed: ${JSON.stringify(httpRes.body)}`);
      assert.equal(httpRes.body.ok, true);
      assert.equal(httpRes.body.version, 1);
      assignmentId = httpRes.body.assignment_id;
    }

    const { rows: [asgnRow] } = await engine.query(
      `select effective_from::text, effective_to::text, state, is_current, due_day_offset, due_time_local::text, exclude_sundays
         from public.work_report_assignments where assignment_id = $1::uuid`,
      [assignmentId],
    );
    assert.equal(asgnRow.effective_from, todayVn, `${tc.kind}/${tc.freq}: server sets effective_from = today_vn`);
    assert.equal(asgnRow.effective_to, null, `${tc.kind}/${tc.freq}: server sets effective_to = null`);
    assert.equal(asgnRow.state, "ACTIVE");
    assert.equal(asgnRow.is_current, true);
    assert.equal(asgnRow.due_day_offset, tc.offset);
    assert.equal(asgnRow.due_time_local, tc.time);
    assert.equal(asgnRow.exclude_sundays, tc.exclSun);

    const { rows: [expectedPeriod] } = await engine.query(
      `select p.period_key,
              p.period_start_date::text as period_start,
              p.period_end_date::text as period_end,
              public.work_report_due_at(p.period_end_date, $3::int, $4::time, $5::boolean)::text as expected_due_at
         from public.work_report_period($1::text, $2::date) p`,
      [tc.freq, todayVn, tc.offset, tc.time, tc.exclSun],
    );
    const obs = await fetchAssignmentObligations(engine, assignmentId);
    assert.equal(obs.length, tc.expectedObligations, `${tc.kind}/${tc.freq}: immediately materializes today_vn`);
    for (const ob of obs) {
      assert.equal(ob.period_type, tc.freq);
      assert.equal(ob.period_key, expectedPeriod.period_key);
      assert.equal(ob.period_start_date, expectedPeriod.period_start);
      assert.equal(ob.period_end_date, expectedPeriod.period_end);
      assert.equal(ob.due_at, expectedPeriod.expected_due_at);
      assert.equal(ob.obligation_status, "ACTIVE");
    }
  }

  // Confirm historical assignment & submitted obligation stayed untouched
  {
    const { rows: [histRow] } = await engine.query(
      "select effective_from::text, effective_to::text from public.work_report_assignments where assignment_id = $1::uuid",
      [histAsgn.assignment_id],
    );
    assert.equal(histRow.effective_from, D_HIST);
    assert.equal(histRow.effective_to, null);
    const { rows: [histSub] } = await engine.query(
      "select state from public.work_report_submissions where obligation_id = $1::uuid",
      [histOb.obligation_id],
    );
    assert.equal(histSub.state, "COMPLETED");
  }

  // =========================================================================
  // Phase E: Scenario 3 — Legacy client new-write rules (SQL RPC & HTTP API)
  // =========================================================================
  // E1. effective_from = today_vn, effective_to = null -> 200 ok (USER via HTTP + GROUP via SQL)
  {
    const tplLegOk = await createPublishedTemplate(engine, "WP106_LEG_OK", "Legacy Today OK");
    const legOkHttp = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplLegOk.template_id,
      target_kind: "USER",
      target_user_id: EMP_2.app,
      target_team_id: null,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      effective_from: todayVn,
      effective_to: null,
      idempotency_key: nextKey("leg-ok-http"),
    });
    assert.equal(legOkHttp.status, 200);
    assert.equal(legOkHttp.body.ok, true);
    const { rows: [legRow] } = await engine.query(
      "select effective_from::text, effective_to::text from public.work_report_assignments where assignment_id = $1::uuid",
      [legOkHttp.body.assignment_id],
    );
    assert.equal(legRow.effective_from, todayVn);
    assert.equal(legRow.effective_to, null);

    const tplLegGrpOk = await createPublishedTemplate(engine, "WP106_LEG_G_OK", "Legacy Group Today OK");
    const legGrpRes = await engine.serviceRpc(
      "work_report_create_group_assignment",
      [
        OWNER.auth, OWNER.app, tplLegGrpOk.template_id, grp1.group_id,
        "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("leg-g-ok"),
      ],
      CREATE_GROUP_ASSIGNMENT_CASTS,
    );
    assert.equal(legGrpRes.version, 1);
  }

  // E2. effective_from = yesterday or tomorrow, or effective_to != null -> 400 WORK_REPORT_ASSIGNMENT_INVALID
  const tplLegReject = await createPublishedTemplate(engine, "WP106_LEG_REJ", "Legacy Reject");
  const invalidLegacyInputs = [
    { label: "yesterday", effective_from: D0, effective_to: null },
    { label: "tomorrow", effective_from: D2, effective_to: null },
    { label: "effective_to=today", effective_from: todayVn, effective_to: todayVn },
    { label: "effective_to=tomorrow", effective_from: todayVn, effective_to: D2 },
    { label: "from=null,to=today", effective_from: null, effective_to: todayVn },
  ];
  for (const inv of invalidLegacyInputs) {
    // SQL RPC (USER)
    await assert.rejects(
      () =>
        engine.serviceRpc(
          "work_report_create_assignment",
          [
            OWNER.auth, OWNER.app, tplLegReject.template_id, "USER", EMP_2.app, null, null,
            "DAILY", true, 0, "18:00:00", false, inv.effective_from, inv.effective_to, nextKey(`inv-sql-u-${inv.label}`),
          ],
          CREATE_ASSIGNMENT_CASTS,
        ),
      (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_INVALID"),
      `SQL USER must reject ${inv.label} with 22023 WORK_REPORT_ASSIGNMENT_INVALID`,
    );
    // SQL RPC (GROUP)
    await assert.rejects(
      () =>
        engine.serviceRpc(
          "work_report_create_group_assignment",
          [
            OWNER.auth, OWNER.app, tplLegReject.template_id, grp1.group_id,
            "DAILY", true, 0, "18:00:00", false, inv.effective_from, inv.effective_to, nextKey(`inv-sql-g-${inv.label}`),
          ],
          CREATE_GROUP_ASSIGNMENT_CASTS,
        ),
      (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_INVALID"),
      `SQL GROUP must reject ${inv.label} with 22023 WORK_REPORT_ASSIGNMENT_INVALID`,
    );
    // HTTP API (USER & GROUP)
    const httpUserErr = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplLegReject.template_id,
      target_kind: "USER",
      target_user_id: EMP_2.app,
      target_team_id: null,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      effective_from: inv.effective_from,
      effective_to: inv.effective_to,
      idempotency_key: nextKey(`inv-http-u-${inv.label}`),
    });
    assert.equal(httpUserErr.status, 400, `HTTP USER ${inv.label} -> 400`);
    assert.equal(httpUserErr.body.code, "WORK_REPORT_ASSIGNMENT_INVALID", `HTTP USER ${inv.label} code`);

    const httpGrpErr = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplLegReject.template_id,
      target_kind: "GROUP",
      target_user_id: null,
      target_team_id: null,
      target_group_id: grp1.group_id,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      effective_from: inv.effective_from,
      effective_to: inv.effective_to,
      idempotency_key: nextKey(`inv-http-g-${inv.label}`),
    });
    assert.equal(httpGrpErr.status, 400, `HTTP GROUP ${inv.label} -> 400`);
    assert.equal(httpGrpErr.body.code, "WORK_REPORT_ASSIGNMENT_INVALID", `HTTP GROUP ${inv.label} code`);
  }

  // =========================================================================
  // Phase F: Scenario 5 — Post-migration midnight retry (D0 -> D1) for BOTH
  //          date-less & legacy payloads + USER_SET dedup check
  // =========================================================================
  // F1. Date-less USER_SET midnight retry (D0 -> D1)
  {
    const tplMidDlUset = await createPublishedTemplate(engine, "WP106_MID_DL_US", "Midnight Dateless USER_SET");
    const kMidDlUset = nextKey("mid-dl-uset");
    const createdHttp = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplMidDlUset.template_id,
      target_kind: "USER_SET",
      target_user_id: null,
      target_team_id: null,
      target_user_ids: [EMP_1.app, EMP_2.app],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      idempotency_key: kMidDlUset,
    });
    assert.equal(createdHttp.status, 200);

    // Simulate midnight passing from D0 -> D1 by moving the committed D0 record to D0
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [createdHttp.body.assignment_id, D0],
    );
    await engine.query(
      `update public.work_report_obligations
          set period_key = $2, period_start_date = $3::date, period_end_date = $3::date
        where assignment_id = $1::uuid`,
      [createdHttp.body.assignment_id, D0, D0],
    );

    // Replay at D1 with SAME idempotency_key + SAME date-less payload (HTTP API & SQL RPC)
    const replayHttp = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplMidDlUset.template_id,
      target_kind: "USER_SET",
      target_user_id: null,
      target_team_id: null,
      target_user_ids: [EMP_1.app, EMP_2.app],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      idempotency_key: kMidDlUset,
    });
    assert.equal(replayHttp.status, 200);
    assert.deepEqual(replayHttp.body, createdHttp.body, "Date-less USER_SET midnight replay via HTTP returns cached result");

    const replaySql = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplMidDlUset.template_id, "USER_SET", null, null, [EMP_1.app, EMP_2.app],
        "DAILY", true, 0, "18:00:00", false, null, null, kMidDlUset,
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    assert.deepEqual(replaySql, { assignment_id: createdHttp.body.assignment_id, version: 1 });

    const { rows: usetRows } = await engine.query(
      "select assignment_id, effective_from::text from public.work_report_assignments where template_id = $1::uuid",
      [tplMidDlUset.template_id],
    );
    assert.equal(usetRows.length, 1, "Exact 1 USER_SET assignment (0 duplicates across midnight retry)");
    assert.equal(usetRows[0].effective_from, D0, "effective_from remains D0 after midnight replay");

    // Different payload with same idempotency_key on USER_SET -> rejected 22023
    await assert.rejects(
      () =>
        engine.serviceRpc(
          "work_report_create_assignment",
          [
            OWNER.auth, OWNER.app, tplMidDlUset.template_id, "USER_SET", null, null, [EMP_1.app],
            "DAILY", true, 0, "18:00:00", false, null, null, kMidDlUset,
          ],
          CREATE_ASSIGNMENT_CASTS,
        ),
      (err) => err?.code === "22023",
      "Same idempotency_key + different payload on USER_SET rejected (22023)",
    );
    await assert.rejects(
      () =>
        engine.serviceRpc(
          "work_report_create_assignment",
          [
            OWNER.auth, OWNER.app, tplMidDlUset.template_id, "USER_SET", null, null, [EMP_1.app, EMP_2.app],
            "DAILY", true, 0, "18:00:00", false, D1, null, kMidDlUset,
          ],
          CREATE_ASSIGNMENT_CASTS,
        ),
      (err) => err?.code === "22023",
      "Same idempotency_key + legacy D1 dates on date-less key rejected (22023)",
    );
    const { rows: usetRowsAfterReject } = await engine.query(
      "select assignment_id from public.work_report_assignments where template_id = $1::uuid",
      [tplMidDlUset.template_id],
    );
    assert.equal(usetRowsAfterReject.length, 1, "Still exact 1 USER_SET assignment after rejected mismatched retry");
  }

  // F1b. USER_SET persisted with lost response -> edit deadline -> revert to old deadline -> re-confirm
  //      Reuses exact same key + payload, replays original assignment (exact 1 row in DB); real payload edit creates 2nd with new key
  {
    const tplUsetRevert = await createPublishedTemplate(engine, "WP106_USET_REVERT", "USER_SET Edit Revert Replay");
    let seq = 0;
    const nextUiKey = () => `uset-revert-${++seq}`;
    let pending = null;

    const baseUiInput = {
      template_id: tplUsetRevert.template_id,
      target_kind: "USER_SET",
      target_user_id: null,
      target_team_id: null,
      target_group_id: null,
      target_user_ids: [EMP_1.app, EMP_2.app],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
    };

    // 1. User confirms and submits -> DB commits assignment, simulate lost HTTP response (pending NOT cleared)
    pending = resolveAssignmentCreateAttempt(pending, baseUiInput, nextUiKey);
    const firstSubmit = await callCreateAssignmentHttp(engine, OWNER, pending.payload);
    assert.equal(firstSubmit.status, 200);
    assert.equal(seq, 1);

    // 2. User edits deadline (due_day_offset: 2, due_time_local: "20:00:00") without submitting -> pending remains intact,
    //    then returns deadline to original (due_day_offset: 0, due_time_local: "18:00:00") and re-confirms
    const revertedAttempt = resolveAssignmentCreateAttempt(
      pending,
      { ...baseUiInput, due_day_offset: 0, due_time_local: "18:00:00" },
      nextUiKey,
    );
    assert.equal(revertedAttempt.idempotency_key, pending.idempotency_key, "Reverted deadline reuses exact pending idempotency key");
    assert.deepEqual(revertedAttempt.payload, pending.payload, "Reverted deadline reuses exact pending payload");
    assert.equal(seq, 1, "Re-confirming reverted values does not generate a new key");

    const replaySubmit = await callCreateAssignmentHttp(engine, OWNER, revertedAttempt.payload);
    assert.equal(replaySubmit.status, 200);
    assert.deepEqual(replaySubmit.body, firstSubmit.body, "Lost-response retry after edit+revert returns original assignment");

    const { rows: rowsAfterRevert } = await engine.query(
      "select assignment_id::text from public.work_report_assignments where template_id = $1::uuid",
      [tplUsetRevert.template_id],
    );
    assert.equal(rowsAfterRevert.length, 1, "Exact 1 USER_SET assignment exists after lost-response -> edit -> revert -> re-confirm");

    // 3. Real deadline change (user submits edited deadline for EMP_2 only so unique active target constraint is not violated) ->
    //    rotates to a new idempotency key and persists distinct assignment
    const realChangeAttempt = resolveAssignmentCreateAttempt(
      pending,
      {
        ...baseUiInput,
        target_user_ids: [EMP_2.app],
        due_day_offset: 1,
        due_time_local: "19:30:00",
      },
      nextUiKey,
    );
    assert.notEqual(realChangeAttempt.idempotency_key, pending.idempotency_key, "Changed payload generates new idempotency key");
    assert.equal(seq, 2);
    const secondSubmit = await callCreateAssignmentHttp(engine, OWNER, realChangeAttempt.payload);
    assert.equal(secondSubmit.status, 200);
    assert.notEqual(secondSubmit.body.assignment_id, firstSubmit.body.assignment_id);

    const { rows: rowsAfterRealEdit } = await engine.query(
      `select assignment_id::text, due_day_offset, due_time_local::text
         from public.work_report_assignments
        where template_id = $1::uuid
        order by created_at asc, assignment_id asc`,
      [tplUsetRevert.template_id],
    );
    assert.equal(rowsAfterRealEdit.length, 2);
    const secondRow = rowsAfterRealEdit.find((r) => r.assignment_id === secondSubmit.body.assignment_id);
    assert.equal(secondRow?.due_day_offset, 1);
    assert.equal(secondRow?.due_time_local, "19:30:00");
  }

  // F2. Date-less GROUP midnight retry (D0 -> D1)
  {
    const tplMidDlGrp = await createPublishedTemplate(engine, "WP106_MID_DL_GRP", "Midnight Dateless GROUP");
    const kMidDlGrp = nextKey("mid-dl-grp");
    const grpCreated = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplMidDlGrp.template_id,
      target_kind: "GROUP",
      target_user_id: null,
      target_team_id: null,
      target_group_id: grp1.group_id,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      idempotency_key: kMidDlGrp,
    });
    assert.equal(grpCreated.status, 200);
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [grpCreated.body.assignment_id, D0],
    );
    const grpReplaySql = await engine.serviceRpc(
      "work_report_create_group_assignment",
      [
        OWNER.auth, OWNER.app, tplMidDlGrp.template_id, grp1.group_id,
        "DAILY", true, 0, "18:00:00", false, null, null, kMidDlGrp,
      ],
      CREATE_GROUP_ASSIGNMENT_CASTS,
    );
    assert.deepEqual(grpReplaySql, { assignment_id: grpCreated.body.assignment_id, version: 1 });
    const { rows: grpRows } = await engine.query(
      "select effective_from::text from public.work_report_assignments where template_id = $1::uuid",
      [tplMidDlGrp.template_id],
    );
    assert.equal(grpRows.length, 1);
    assert.equal(grpRows[0].effective_from, D0);
  }

  // F3. Legacy D0 payload midnight retry (D0 -> D1) for USER & GROUP
  {
    const tplMidLegUser = await createPublishedTemplate(engine, "WP106_MID_LEG_U", "Midnight Legacy USER");
    const kMidLegUser = nextKey("mid-leg-user");
    const seededAsgnId = nextUuid();
    await engine.query(
      `insert into public.work_report_assignments (
         assignment_id, template_id, template_version_id, target_kind, target_user_id,
         frequency, is_mandatory, due_day_offset, due_time_local, exclude_sundays,
         effective_from, effective_to, assigned_by_user_id
       ) values ($1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, 'DAILY', true, 0, '18:00:00'::time, false, $5::date, null, $6::uuid)`,
      [seededAsgnId, tplMidLegUser.template_id, tplMidLegUser.draft_version_id, EMP_1.app, D0, OWNER.app],
    );
    const { rows: [{ h }] } = await engine.query(
      `select public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
         'template_id', $1::uuid,
         'target_kind', 'USER',
         'target_user_id', $2::uuid,
         'target_team_id', null::uuid,
         'target_user_ids', null::uuid[],
         'frequency', 'DAILY',
         'is_mandatory', true,
         'due_day_offset', 0,
         'due_time_local', '18:00:00'::time without time zone,
         'exclude_sundays', false,
         'effective_from', $3::date,
         'effective_to', null::date
       )) as h`,
      [tplMidLegUser.template_id, EMP_1.app, D0],
    );
    const legResultJson = { assignment_id: seededAsgnId, version: 1 };
    await engine.query(
      "select public.direct_entry_idempotency_begin($1::uuid, 'work_report_assignment_create', $2, $3)",
      [OWNER.app, kMidLegUser, h],
    );
    await engine.query(
      "select public.direct_entry_idempotency_finish($1::uuid, 'work_report_assignment_create', $2, $3::jsonb)",
      [OWNER.app, kMidLegUser, JSON.stringify(legResultJson)],
    );

    // Retry at D1 with SAME legacy D0 payload -> replays cached { assignment_id, version: 1 }!
    const legReplaySql = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplMidLegUser.template_id, "USER", EMP_1.app, null, null,
        "DAILY", true, 0, "18:00:00", false, D0, null, kMidLegUser,
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    assert.deepEqual(legReplaySql, legResultJson, "Post-migration legacy D0 midnight retry (SQL) replays cached result");

    const legReplayHttp = await callCreateAssignmentHttp(engine, OWNER, {
      template_id: tplMidLegUser.template_id,
      target_kind: "USER",
      target_user_id: EMP_1.app,
      target_team_id: null,
      target_user_ids: [],
      frequency: "DAILY",
      is_mandatory: true,
      due_day_offset: 0,
      due_time_local: "18:00:00",
      exclude_sundays: false,
      effective_from: D0,
      effective_to: null,
      idempotency_key: kMidLegUser,
    });
    assert.equal(legReplayHttp.status, 200);
    assert.deepEqual(legReplayHttp.body, { ok: true, ...legResultJson });

    await assert.rejects(
      () =>
        engine.serviceRpc(
          "work_report_create_assignment",
          [
            OWNER.auth, OWNER.app, tplMidLegUser.template_id, "USER", EMP_1.app, null, null,
            "DAILY", true, 0, "18:00:00", false, D1, null, kMidLegUser,
          ],
          CREATE_ASSIGNMENT_CASTS,
        ),
      (err) => err?.code === "22023",
      "Legacy D0 key replayed with recomputed D1 date rejected (22023)",
    );
  }

  // =========================================================================
  // Phase G: Scenario 6 — WP10-6 pause-reactivate / revoke fixture checks & WP9/WP8D behavior
  // =========================================================================
  // G1. WP10-6 Pause-Reactivate across D_P0 -> D_P1 -> D_P2 -> D_P3 (todayVn)
  {
    const D_P3 = todayVn;
    const D_P0 = addDaysIso(D_P3, -3);
    const D_P1 = addDaysIso(D_P3, -2);
    const D_P2 = addDaysIso(D_P3, -1);

    const tplPause = await createPublishedTemplate(engine, "WP106_PAUSE_A", "Pause Reactivate Check");
    const asgnPause = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplPause.template_id, "USER", EMP_PAUSE.app, null, null,
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("pause-create"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    // Simulate creation at D_P0
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnPause.assignment_id, D_P0],
    );
    await engine.query(
      "delete from public.work_report_obligations where assignment_id = $1::uuid and period_start_date = $2::date",
      [asgnPause.assignment_id, D_P3],
    );
    await engine.query(
      "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
      [asgnPause.assignment_id, D_P0],
    );

    const pausedState = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnPause.assignment_id, 1, "PAUSED", nextKey("pause-set"),
    ]);
    assert.equal(pausedState.state, "PAUSED");

    for (const dPaused of [D_P1, D_P2]) {
      await engine.serviceRpc("work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPaused]);
      await engine.query(
        "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 7)",
        [EMP_PAUSE.app, dPaused],
      );
    }
    const whilePaused = await fetchAssignmentObligations(engine, asgnPause.assignment_id);
    assert.deepEqual(whilePaused.map((r) => r.period_start_date), [D_P0], "0 rows created while PAUSED");

    const reactivated = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnPause.assignment_id, 2, "ACTIVE", nextKey("pause-react"),
    ]);
    assert.equal(reactivated.state, "ACTIVE");
    const afterReactivate = await fetchAssignmentObligations(engine, asgnPause.assignment_id);
    assert.deepEqual(
      afterReactivate.map((r) => r.period_start_date),
      [D_P0, D_P3],
      "Reactivating immediately materializes todayVn (D_P3)",
    );

    // Employee personal list runs cleanly (note: WP10-6 Slice 1 preserves current 7-day lookback behavior)
    const myObs = await engine.serviceRpc("work_report_list_my_obligations", [
      EMP_PAUSE.auth, EMP_PAUSE.app, null,
    ]);
    assert.ok(myObs.items.some((i) => i.period_start_date === D_P3));
  }

  // G2. WP10-6 Revoke impact across NOT_STARTED / DRAFT / PENDING_REVIEW / REJECTED / APPROVED + READ ONLY probe
  {
    const tplRev = await createPublishedTemplate(engine, "WP106_REV_B", "Revoke Impact Check", {
      frequency: "DAILY",
      requiresReview: true,
    });
    const R_D0 = todayVn;
    const R_M4 = addDaysIso(R_D0, -4);
    const R_M3 = addDaysIso(R_D0, -3);
    const R_M2 = addDaysIso(R_D0, -2);
    const R_M1 = addDaysIso(R_D0, -1);

    const asgnRev = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplRev.template_id, "USER", EMP_REVOKE.app, null, null,
        "DAILY", true, 10, "23:59:59", false, null, null, nextKey("rev-create"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [asgnRev.assignment_id, R_M4],
    );
    for (const d of [R_M4, R_M3, R_M2, R_M1]) {
      await engine.query(
        "select public.work_report__internal_materialize_assignment_for_date($1::uuid, $2::date)",
        [asgnRev.assignment_id, d],
      );
    }
    const revObs = await fetchAssignmentObligations(engine, asgnRev.assignment_id);
    const obByDate = Object.fromEntries(revObs.map((r) => [r.period_start_date, r.obligation_id]));

    const subApp = await engine.serviceRpc("work_report_submit", [
      EMP_REVOKE.auth, EMP_REVOKE.app, obByDate[R_M4],
      JSON.stringify({ calls_made: 40, interested_candidates: 10, workers_started: 4, notes: "Approved" }),
      null, nextKey("rev-sub-app"),
    ]);
    await engine.serviceRpc("work_report_decide_review", [
      OWNER.auth, OWNER.app, obByDate[R_M4], "APPROVED", null, subApp.version, nextKey("rev-dec-app"),
    ]);

    const subRet = await engine.serviceRpc("work_report_submit", [
      EMP_REVOKE.auth, EMP_REVOKE.app, obByDate[R_M3],
      JSON.stringify({ calls_made: 30, interested_candidates: 8, workers_started: 2, notes: "Rejected" }),
      null, nextKey("rev-sub-ret"),
    ]);
    await engine.serviceRpc("work_report_decide_review", [
      OWNER.auth, OWNER.app, obByDate[R_M3], "REJECTED", "Bổ sung", subRet.version, nextKey("rev-dec-ret"),
    ]);

    await engine.serviceRpc("work_report_submit", [
      EMP_REVOKE.auth, EMP_REVOKE.app, obByDate[R_M2],
      JSON.stringify({ calls_made: 20, interested_candidates: 5, workers_started: 1, notes: "Pending" }),
      null, nextKey("rev-sub-pend"),
    ]);

    const draftSub = await engine.serviceRpc("work_report_save_draft", [
      EMP_REVOKE.auth, EMP_REVOKE.app, obByDate[R_M1],
      JSON.stringify({ calls_made: 15, interested_candidates: 3, workers_started: null, notes: "Draft" }),
      null, nextKey("rev-draft"),
    ]);

    const revokedRes = await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, asgnRev.assignment_id, 1, "REVOKED", nextKey("rev-do"),
    ]);
    assert.equal(revokedRes.state, "REVOKED");

    const afterRevObs = await fetchAssignmentObligations(engine, asgnRev.assignment_id);
    const statusByDate = Object.fromEntries(afterRevObs.map((r) => [r.period_start_date, r.obligation_status]));
    assert.equal(statusByDate[R_D0], "CANCELLED");
    assert.equal(statusByDate[R_M1], "CANCELLED");
    assert.equal(statusByDate[R_M2], "ACTIVE");
    assert.equal(statusByDate[R_M3], "ACTIVE");
    assert.equal(statusByDate[R_M4], "ACTIVE");

    await assert.rejects(
      () =>
        engine.serviceRpc("work_report_save_draft", [
          EMP_REVOKE.auth, EMP_REVOKE.app, obByDate[R_M1],
          JSON.stringify({ calls_made: 99, interested_candidates: 9, workers_started: 0, notes: "Blocked" }),
          draftSub.version, nextKey("rev-draft-blocked"),
        ]),
      (err) => err?.code === "42501",
      "save_draft on CANCELLED obligation after revoke denied (42501)",
    );

    const countsBeforeRo = await countWrTables(engine);
    const roProbe = await engine.serviceRpc(
      "work_report_has_active_obligations",
      [EMP_REVOKE.auth, EMP_REVOKE.app],
      ["uuid", "uuid"],
      { readOnly: true },
    );
    assert.strictEqual(roProbe.has_active_obligations, true);
    assert.deepEqual(await countWrTables(engine), countsBeforeRo, "READ ONLY probe performs 0 writes");
  }

  // G3. WP9/WP8D behavior on top of #244:
  //     - Blocked targets (INACTIVE Person, DISABLED) rejected on date-less creation
  //     - ONCE singleton + REVOKED -> ACTIVE same-assignment restore preserved
  //     - As-of team transfer zero retroactive obligations + READ ONLY probe parity
  {
    const tplBlocked = await createPublishedTemplate(engine, "WP106_WP9_BLK", "WP9 Blocked Targets");
    for (const blocked of [EMP_INACTIVE, EMP_DISABLED]) {
      await assert.rejects(
        () =>
          engine.serviceRpc(
            "work_report_create_assignment",
            [
              OWNER.auth, OWNER.app, tplBlocked.template_id, "USER", blocked.app, null, null,
              "DAILY", true, 0, "18:00:00", false, null, null, nextKey("wp9-blk-u"),
            ],
            CREATE_ASSIGNMENT_CASTS,
          ),
        (err) => err?.code === "22023" || err?.code === "42501",
        `WP9 blocked target ${blocked.email} rejected on date-less USER assignment`,
      );
      await assert.rejects(
        () =>
          engine.serviceRpc(
            "work_report_create_assignment",
            [
              OWNER.auth, OWNER.app, tplBlocked.template_id, "USER_SET", null, null, [EMP_1.app, blocked.app],
              "DAILY", true, 0, "18:00:00", false, null, null, nextKey("wp9-blk-us"),
            ],
            CREATE_ASSIGNMENT_CASTS,
          ),
        (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_TARGET_INVALID"),
        `WP9 blocked target ${blocked.email} rejected on date-less USER_SET assignment`,
      );
    }

    // READ ONLY nav probe on EMP_INACTIVE returns strict false with 0 writes
    const countsBefore = await countWrTables(engine);
    const inactiveProbe = await engine.serviceRpc(
      "work_report_has_active_obligations",
      [EMP_INACTIVE.auth, EMP_INACTIVE.app],
      ["uuid", "uuid"],
      { readOnly: true },
    );
    assert.strictEqual(inactiveProbe.has_active_obligations, false);
    assert.deepEqual(await countWrTables(engine), countsBefore);

    // ONCE singleton & REVOKED -> ACTIVE same-assignment restore with date-less creation
    const tplOnceRestore = await createPublishedTemplate(engine, "WP106_WP9_ONCE", "WP9 ONCE Restore", {
      frequency: "ONCE",
    });
    const onceAsgn = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplOnceRestore.template_id, "USER", EMP_ONCE.app, null, null,
        "ONCE", true, 0, "18:00:00", false, null, null, nextKey("wp9-once-c"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    const [origOb] = await fetchAssignmentObligations(engine, onceAsgn.assignment_id);
    assert.equal(origOb.period_key, `ONCE-${todayVn}`);

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceAsgn.assignment_id, 1, "REVOKED", nextKey("wp9-once-rev"),
    ]);
    const roRevoked = await engine.serviceRpc(
      "work_report_has_active_obligations",
      [EMP_ONCE.auth, EMP_ONCE.app],
      ["uuid", "uuid"],
      { readOnly: true },
    );
    assert.strictEqual(roRevoked.has_active_obligations, false);

    await engine.serviceRpc("work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceAsgn.assignment_id, 2, "ACTIVE", nextKey("wp9-once-act"),
    ]);
    const restoredObs = await fetchAssignmentObligations(engine, onceAsgn.assignment_id);
    assert.equal(restoredObs.length, 1);
    assert.equal(restoredObs[0].obligation_id, origOb.obligation_id);
    assert.equal(restoredObs[0].obligation_status, "ACTIVE");
    const roRestored = await engine.serviceRpc(
      "work_report_has_active_obligations",
      [EMP_ONCE.auth, EMP_ONCE.app],
      ["uuid", "uuid"],
      { readOnly: true },
    );
    assert.strictEqual(roRestored.has_active_obligations, true);

    // As-of team transfer: EMP_XFER moves TEAM_A -> TEAM_B effective todayVn; TEAM_B assignment from today-10 produces 0 retroactive rows
    const tplTeamB = await createPublishedTemplate(engine, "WP106_WP9_TB", "WP9 Team B Transfer");
    const tbAsgn = await engine.serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, tplTeamB.template_id, "TEAM", null, TEAM_B, null,
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("wp9-tb"),
      ],
      CREATE_ASSIGNMENT_CASTS,
    );
    await engine.query(
      "update public.work_report_assignments set effective_from = $2::date where assignment_id = $1::uuid",
      [tbAsgn.assignment_id, addDaysIso(todayVn, -10)],
    );
    await engine.query(
      "update public.recruiter_team_memberships set is_current = false, valid_to = $1::date where recruiter_id = $2::uuid and is_current",
      [todayVn, EMP_XFER.rec],
    );
    await engine.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::date, true)",
      [EMP_XFER.rec, TEAM_B, todayVn],
    );
    await engine.serviceRpc("work_report_list_my_obligations", [EMP_XFER.auth, EMP_XFER.app, null]);
    const { rows: xferRows } = await engine.query(
      `select period_start_date::text as start_date, snapshot_team_id::text as team_id
         from public.work_report_obligations
        where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid`,
      [tbAsgn.assignment_id, EMP_XFER.app],
    );
    assert.equal(xferRows.length, 1, "Team transfer yields ONLY todayVn obligation for Team B (0 retroactive rows)");
    assert.equal(xferRows[0].start_date, todayVn);
    assert.equal(xferRows[0].team_id, TEAM_B);
  }
}

test("WP10-6 #1 (PGlite): Migration #244 hygiene, atomic rollback zero drift, signature/overload/owner/ACL (+0 net RPCs)", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP10_6_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("\r\n"), false, "WP10-6 migration must use LF line endings");
  assert.equal(sql.replace(/--[^\n]*/g, "").includes("@"), false, "WP10-6 SQL statements must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(sql), false, "WP10-6 migration must contain zero SAVEPOINT");
  assert.equal(/'40001'/.test(sql), false, "WP10-6 migration must contain zero '40001'");
  assert.equal(/alter default privileges/i.test(sql), false, "WP10-6 migration must contain zero ALTER DEFAULT PRIVILEGES");

  const engine = await createPgliteEngine();
  try {
    await engine.exec(ROLE_PREAMBLE);
    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const wp106Idx = files.indexOf(WP10_6_MIGRATION_NAME);
    assert.ok(wp106Idx > 0, "WP10-6 migration #244 must exist");
    const preApplied = files.slice(0, wp106Idx);
    for (const name of preApplied) {
      await engine.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const preFlags = new Map(preApplied.map((n) => [n, true]));
    const preCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, preFlags);
    assert.equal(preCheck.ok, true, `pre-check failed: ${preCheck.reason}`);

    const preMeta = await inspectAssignmentCreateRpcMeta(engine);

    // Atomic rollback leaves zero drift
    const stripped = sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
    await engine.exec("begin;");
    await engine.exec(stripped);
    await engine.exec("rollback;");

    const afterRollbackMeta = await inspectAssignmentCreateRpcMeta(engine);
    assert.deepEqual(afterRollbackMeta, preMeta, "Atomic rollback must leave both RPCs and ACLs unchanged");

    // Apply #244 cleanly
    await engine.exec(sql);
    const postFlags = new Map([...preFlags, [WP10_6_MIGRATION_NAME, true]]);
    const postCheck = await verifyS0T1CSecurityPostconditions(engine, s0Sql, postFlags);
    assert.equal(postCheck.ok, true, `post-check failed: ${postCheck.reason}`);
    assert.equal(postCheck.details.actualServiceCount, preCheck.details.actualServiceCount, "exact +0 net service_role RPCs");
    assert.equal(postCheck.details.exposedClientOrPublicCount, 0, "zero client/PUBLIC EXECUTE grants");

    const { rows: [baseTblOwner] } = await engine.query(
      "select relowner from pg_catalog.pg_class where oid = 'public.work_report_assignments'::pg_catalog.regclass",
    );
    const postMeta = await inspectAssignmentCreateRpcMeta(engine);
    for (const m of postMeta) {
      assert.equal(m.overload_count, 1);
      assert.equal(m.proowner, baseTblOwner.relowner);
      assert.equal(m.prosecdef, true);
      assert.ok(m.proconfig.includes("search_path=pg_catalog, public"));
      assert.equal(m.pub_exec, false);
      assert.equal(m.anon_exec, false);
      assert.equal(m.auth_exec, false);
      assert.equal(m.svc_exec, true);
    }
  } finally {
    await engine.close();
  }
});

test("WP10-6 #2 (PGlite): Immediate assignment creation, legacy rules, pre/post midnight replay, USER_SET dedup, WP10-6 & WP9/WP8D checks", async () => {
  const engine = await createPgliteEngine();
  try {
    await runWp106DualEngineMatrix(engine);
  } finally {
    await engine.close();
  }
});

test("WP10-6 #3 (Real PostgreSQL 18): Immediate assignment creation, legacy rules, pre/post midnight replay, USER_SET dedup, WP10-6 & WP9/WP8D checks", async () => {
  const engine = await createPg18Engine();
  try {
    console.log(`[WP10-6] Running real DB suite on engine: ${engine.name}`);
    await runWp106DualEngineMatrix(engine);
  } finally {
    await engine.close();
  }
});
