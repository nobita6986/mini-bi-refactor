/**
 * WP10-7 Slice 3C — Retire Legacy Grant Mirror Writes & `not authz_managed` Fallback Reads
 * Real Isolated PostgreSQL 18 Upgrade (0..3B -> 3C), Failure Gates, Before/After Parity,
 * Full-Row Legacy Immutability, #47/#42/Ops-Scripts Verification, and Concurrency Barriers.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies ALL mandatory WP10-7 Slice 3C contract requirements:
 *   1. Hygiene (LF, 0 `@`, 0 `SAVEPOINT`, 0 `'40001'`, 0 `ALTER DEFAULT PRIVILEGES`),
 *      atomic rollback zero drift, Pre-DDL fail-closed blocks (active `authz_managed=false`,
 *      disabled `authz_managed=false` re-enable trap, and `LEGACY_BRIDGE` grant),
 *      and clean `runMigrationApply` (`0..3B -> 3C`).
 *   2. Post-DDL invariants:
 *      - `direct_entry_app_users.authz_managed` `DEFAULT true` + `NOT NULL`.
 *      - All account creation paths (`finalize_create`, `create_personnel`, `link_recruiter`,
 *        direct INSERT omitting `authz_managed`) yield `authz_managed=true` & 0 legacy writes.
 *      - `pg_proc` scan (exact 3D Section 1/5 query): `blocking_static_procs=0`,
 *        `blocking_dynamic_execute_procs=0`, `10` `PLANNED_3D_DROP_FUNCTION`, `2` shared trim.
 *      - All 5 shared trigger functions intact & bound; `+0` net `service_role` RPCs (`310`,
 *        `0` client/PUBLIC `EXECUTE`); `SECURITY DEFINER` + `search_path=pg_catalog, public`;
 *        bootstrap executor owner preserved; legacy predicates fail-closed.
 *   3. Before/After 3C permissions parity (`BEFORE_3C == AFTER_3C` across Menu, 5 Page Guards,
 *      7 API endpoints, 12+ module RPCs):
 *      - Active `authz_managed=true` (Owner/Admin, HR/Catalog, Uploader, PM, PA)
 *      - Disabled -> re-enabled (keep groups & revoke 1 group while disabled -> re-enable)
 *      - Multi-group overlapping caps (`DUAL_A + DUAL_B` -> remove `DUAL_A`)
 *      - Contextual-only 0-group accounts (PM `project_admin`, PA `vendor_finance_view`, TL)
 *      - Post-#48 Team Leader (candidate list, designate, replace, revoke, `v_restore`,
 *        disable/enable, Work Reports, Leave, Attendance, `#42` move/unassign `PT409`)
 *      - PR #49 `direct_entry_input_catalog_unscoped_v42` & fail-closed hypothetical unmanaged check
 *   4. Full-row bit-for-bit immutability of ALL 3 legacy tables (`direct_entry_capability_grants`,
 *      `direct_entry_scope_grants`, `work_report_team_leader_capability_grants`) via `row_count` +
 *      canonical `sha256` + full `SELECT *` comparison on a fixture seeded with non-empty
 *      legacy & pre-3B TL bridge rows BEFORE running group assign/update/remove, account
 *      disable/enable, entity disable, PM assign/unassign, and TL designate/replace/revoke/
 *      `v_restore` (including replacing & revoking the pre-3B TL).
 *   5. `#47` historical Leave/Explanation routing (`designate`/`replace` vs `transition`-only),
 *      `#42` blocks, `resolveOperator` (`t0-operator-import.mjs`), `REPAIR_ACTOR_SQL`
 *      (`p2-de-reporting-dimension-repair.mjs`), and PG18 barrier concurrency (`0` `40P01`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideDirectEntryPageAccess,
  decideProjectOperationsPageAccess,
  decideWorkerOperationsPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import {
  hasAnyValidPairedGrant,
  projectClientCapabilities,
  projectClientScopes,
  resolveActor,
} from "../src/lib/auth/direct-entry-v2.ts";
import { createAuthSessionResponse } from "../src/lib/auth/auth-session-core.ts";
import {
  assignAccountGroupAdmin,
  removeAccountGroupAdmin,
} from "../src/lib/admin/permission-group-api.ts";
import { createServicePermissionGroupRepository } from "../src/lib/admin/permission-group-repository.ts";
import {
  projectAttendanceExplanationApprovalInbox,
  projectSubmitAttendanceExplanationResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { mutateAccount } from "../src/lib/direct-entry/app-user-access-api.ts";
import { createAccountAccessRepository } from "../src/lib/direct-entry/app-user-access-repository.ts";
import { getInputCatalog, getOwnDrafts } from "../src/lib/direct-entry/draft-api.ts";
import { createDirectEntrySessionResponse } from "../src/lib/direct-entry/session-bootstrap.ts";
import { listOwnSubmissions } from "../src/lib/direct-entry/submission-read-api.ts";
import { createSubmissionReadRepository } from "../src/lib/direct-entry/submission-read-repository.ts";
import { listWorkers } from "../src/lib/direct-entry/worker-directory-api.ts";
import { createWorkerDirectoryRepository } from "../src/lib/direct-entry/worker-directory-repository.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import {
  decideNavEntryVisibility,
  hasActiveDepartmentHeadRole,
  resolveWorkReportManagementPath,
} from "../src/lib/navigation/registry-capability.ts";
import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import {
  migrationChecksum,
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  runMigrationApply,
} from "./lib/migration-validation.mjs";
import { REPAIR_ACTOR_SQL } from "./lib/p2-de-reporting-dimension-repair.mjs";
import { resolveOperator } from "./lib/t0-operator-import.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_7_3B_MIGRATION_NAME =
  "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";
const WP10_7_3C_MIGRATION_NAME =
  "20261127020000_wp10_7_3c_retire_legacy_grant_mirror_and_fallback.sql";
const EXPECTED_TL_GUARD_MSG = "recruiter holds active or restorable team leader assignment";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const NAV_ENTRIES_META = [
  { id: "dashboard", path: "/dashboard", capability: "any", desktop: true },
  { id: "direct-entry", path: "/direct-entry", capability: "entry_admin", desktop: true },
  { id: "worker-operations", path: "/direct-entry/workers", capability: "worker_operations", desktop: true },
  { id: "change-requests", path: "/direct-entry/change-requests", capability: "change_requests", desktop: false },
  { id: "work-reports", path: "/work-reports", capability: "work_reports", desktop: true },
  { id: "leave", path: "/leave", capability: "leave", desktop: true },
  { id: "recruitment-posts", path: "/recruitment-posts", capability: "any", desktop: true },
  { id: "finance", path: "/finance", capability: "finance", desktop: true },
  { id: "salary-advances", path: "/salary-advances", capability: "salary_advances", desktop: true },
  { id: "project-operations", path: "/direct-entry/projects", capability: "project_admin", desktop: true },
  { id: "leave-admin", path: "/leave/admin", capability: "leave_admin", desktop: true },
  { id: "work-report-management", path: "/work-reports/assignments", capability: "work_report_management", desktop: true },
  { id: "attendance-report", path: "/admin/attendance", capability: "attendance_report", desktop: true },
  { id: "admin", path: "/admin", capability: "admin_area", desktop: true },
];

const OWNER = {
  auth: "96100000-0000-4000-8000-00000000a001",
  app: "96100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-3C",
};
const LUANPT = {
  auth: "96100000-0000-4000-8000-00000000a002",
  app: "96100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "96100000-0000-4000-8000-00000000a003",
  app: "96100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "96100000-0000-4000-8000-00000000a004",
  app: "96100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const CORE_3C_PROCS = [
  "direct_entry_authz__internal_sync_legacy_grants",
  "work_report_sync_team_leader_capabilities",
  "direct_entry_has_capability",
  "direct_entry_has_scope",
  "direct_entry_assert_actor",
  "direct_entry_authz__internal_resolve_effective_grants",
  "direct_entry_resolve_actor_context",
  "direct_entry_authz_assign_group_member_admin",
  "direct_entry_authz_remove_group_member_admin",
  "direct_entry_authz_update_group_admin",
  "direct_entry_account_operation_finalize_create",
  "direct_entry_account_operation_link_recruiter",
  "direct_entry_account_operation_create_personnel",
  "direct_entry_mutate_app_user_status",
  "direct_entry_clear_authority_on_disable",
  "direct_entry_lock_project_team_manager_context",
  "direct_entry_list_team_leader_candidates",
  "direct_entry_apply_team_leader_mutation",
  "direct_entry_input_catalog_unscoped_v42",
  "direct_entry_catalog_bootstrap_plan",
  "direct_entry_apply_catalog_bootstrap",
];

const SHARED_TRIGGER_FNS = [
  "direct_entry_guard_effective_interval",
  "direct_entry_set_current_on_insert",
  "direct_entry_reject_system_vendor_business_team",
  "direct_entry_team_leader_marker",
  "direct_entry_clear_authority_on_disable",
];

let seq = 1;
function nextUuid() {
  return `96110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `wp10_7_3c_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}
function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}
function stripOuterBeginCommit(sql) {
  return sql
    .replace(/^\s*(?:--[^\n]*\n|\s)*begin\s*;/i, "")
    .replace(/commit\s*;\s*$/i, "")
    .trim();
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

async function beginServiceTx(client) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role",
  );
}

function settleInTx(client, queryPromise) {
  return queryPromise.then(
    async (value) => {
      await client.query("commit");
      return { status: "fulfilled", value };
    },
    async (reason) => {
      await client.query("rollback").catch(() => {});
      return { status: "rejected", reason };
    },
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select a.pid,
              a.application_name,
              a.wait_event_type,
              a.wait_event,
              l.locktype,
              l.mode,
              coalesce(l.relation::regclass::text, l.locktype) as relation_name
         from pg_stat_activity a
         join pg_locks l
           on l.pid = a.pid
          and l.granted = false
        where a.application_name = $1
          and a.state = 'active'
          and a.wait_event_type = 'Lock'
        limit 1`,
      [appName],
    );
    if (rows.length === 1) {
      return rows[0];
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const { rows: snap } = await observer.query(
    `select pid, application_name, state, wait_event_type, wait_event, left(query, 120) as query_prefix
       from pg_stat_activity
      where application_name = $1`,
    [appName],
  );
  throw new Error(`Timed out waiting for ${appName} to block on Lock. Snapshot: ${JSON.stringify(snap)}`);
}

function assertNotDeadlock(res, label) {
  if (res?.status === "rejected") {
    assert.notEqual(res.reason?.code, "40P01", `${label} raised 40P01 deadlock: ${res.reason?.message}`);
  }
}

async function setBusinessDate(client, isoDate) {
  assert.match(isoDate, /^\d{4}-\d{2}-\d{2}$/);
  await client.query(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${isoDate}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);
}

describe("WP10-7 Slice 3C (PG18): Retire legacy grant mirror writes and fallback reads", () => {
  const clients = [];
  let tmpDir = "";
  let migrationDirThrough3c;
  let pgData = "";
  let pgLog = "";
  let pgCtl = null;
  let port = 0;
  let started = false;

  let setup = null;
  let observer = null;
  let w1 = null;
  let w2 = null;

  let inOuterTx = false;
  let spSeq = 1;

  let files = [];
  let wp1073cSql = "";
  let wp1073cStrippedSql = "";
  let wp1073cIdx = -1;

  let todayStr = "";
  let yesterdayVn = "";
  let tomorrowStr = "";
  let leaveDay1 = "";
  let yearMonth = "";
  let leaveYear = 2026;
  let atIso = "";

  let TEAM_A = "";
  let TEAM_B = "";
  let TEAM_PRE_3B = "";
  let PRJ_1 = "wp10-7-3c-prj-1";
  let deptByKey = {};
  let grpByCode = {};
  let GRP_DUAL_A = "";
  let GRP_DUAL_B = "";
  let GRP_CATALOG_ONLY = "";
  let GRP_TEAM_SCOPE = "";
  let wrTpl = null;
  let wrTplTeam = null;
  let sampleEntryId = "";

  let HR_OP = null;
  let UPLOADER = null;
  let PM_USER = null;
  let CTX_PM = null;
  let PA_USER = null;
  let CTX_TL = null;
  let LOCK_KEEP = null;
  let LOCK_REVOKE = null;
  let lockRevMem1 = null;
  let MULTI_GRP = null;
  let multiMemA = null;
  let TL_POST3B = null;
  let TL_REPLACE = null;
  let PRE_3B_TL = null;
  let PRE_3B_REPLACE = null;

  let before3CSnap = null;
  let pre3cCatalogSnap = null;

  async function beginOuterTx() {
    assert.equal(inOuterTx, false, "Already inside outer tx");
    await setup.query("begin");
    inOuterTx = true;
  }

  async function rollbackOuterTx() {
    assert.equal(inOuterTx, true, "Not inside outer tx");
    await setup.query("rollback");
    inOuterTx = false;
  }

  async function serviceRpc(fnName, args = [], casts = [], client = setup) {
    const placeholders = args.map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`)).join(", ");
    const sql = `select public.${fnName}(${placeholders}) as data`;
    if (client === setup && inOuterTx) {
      const sp = `sp_rpc_${spSeq++}`;
      await setup.query(`savepoint ${sp}`);
      try {
        await setup.query("set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
        const res = await setup.query(sql, args);
        await setup.query("reset role");
        await setup.query(`release savepoint ${sp}`);
        return res.rows[0]?.data;
      } catch (err) {
        await setup.query(`rollback to savepoint ${sp}`).catch(() => {});
        await setup.query("reset role").catch(() => {});
        throw err;
      }
    }
    await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
    try {
      const res = await client.query(sql, args);
      await client.query("commit");
      return res.rows[0]?.data;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    }
  }

  async function serviceRpcNamed(fnName, namedArgs = {}) {
    const entries = Object.entries(namedArgs);
    const placeholders = entries.map(([k], i) => `${k} => $${i + 1}`).join(", ");
    const values = entries.map(([, v]) => v);
    const sql = `select public.${fnName}(${placeholders}) as data`;
    if (inOuterTx) {
      const sp = `sp_nrpc_${spSeq++}`;
      await setup.query(`savepoint ${sp}`);
      try {
        await setup.query("set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
        const res = await setup.query(sql, values);
        await setup.query("reset role");
        await setup.query(`release savepoint ${sp}`);
        return { data: res.rows[0]?.data, error: null };
      } catch (err) {
        await setup.query(`rollback to savepoint ${sp}`).catch(() => {});
        await setup.query("reset role").catch(() => {});
        return { data: null, error: { code: err?.code, message: err?.message, detail: err?.detail } };
      }
    }
    await setup.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role");
    try {
      const res = await setup.query(sql, values);
      await setup.query("commit");
      return { data: res.rows[0]?.data, error: null };
    } catch (err) {
      await setup.query("rollback").catch(() => {});
      return { data: null, error: { code: err?.code, message: err?.message, detail: err?.detail } };
    }
  }

  async function tryServiceRpc(fnName, args = [], casts = [], client = setup) {
    try {
      const data = await serviceRpc(fnName, args, casts, client);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: err?.code ?? "ERR", message: err?.message ?? String(err) };
    }
  }

  async function seedLegacyAdmin(user) {
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, true, false, 1)`,
      [user.app, user.auth, user.name],
    );
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, '2026-01-01', true)`,
      [user.app],
    );
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true)`,
        [user.app, cap],
      );
    }
  }

  async function seedAccount(slug, displayName, { authzManaged = true, enabled = true } = {}) {
    const auth = nextUuid();
    const app = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, `${slug}@hrpartner.local`]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, $4, $5, 1)`,
      [app, auth, displayName, enabled, authzManaged],
    );
    return { auth, app, slug, name: displayName };
  }

  async function getAccountRow(appUserId, queryClient = setup) {
    const { rows: [r] } = await queryClient.query(
      "select version, enabled, authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid",
      [appUserId],
    );
    return r;
  }

  async function getTeamVersion(teamId, queryClient = setup) {
    const { rows: [r] } = await queryClient.query("select version from public.teams where team_id = $1::uuid", [teamId]);
    return r.version;
  }

  async function getRecruiterVersion(recruiterId, queryClient = setup) {
    const { rows: [r] } = await queryClient.query("select version from public.recruiters where recruiter_id = $1::uuid", [recruiterId]);
    return r.version;
  }

  async function seedRecruiterPerson(
    slug,
    displayName,
    teamId,
    deptId,
    { position = "STAFF", authzManaged = true, groupId = null, withLeaveProfile = false } = {},
  ) {
    const acc = await seedAccount(slug, displayName, { authzManaged });
    const rec = nextUuid();
    const code = `R3C_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}_${seq}`;
    await setup.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, $4, true)`,
      [rec, displayName, code, position],
    );
    await setup.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [rec],
    );
    await setup.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [acc.app, rec],
    );
    if (teamId) {
      await setup.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [rec, teamId],
      );
    }
    let personId = null;
    if (deptId) {
      const empCode = `PER-${code}`;
      const pRes = await serviceRpc("org_department_create_person_admin", [
        OWNER.auth,
        OWNER.app,
        empCode,
        displayName,
        "2026-01-01",
        deptId,
        acc.app,
        1,
        rec,
        `Seed person ${slug}`,
        nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: empCode,
          full_name: displayName,
          joined_on: "2026-01-01",
          initial_department_ref: deptId,
          account_ref: acc.app,
          expected_account_version: 1,
          recruiter_id: rec,
          reason: `Seed person ${slug}`,
        }),
      ]);
      personId = pRes.person.person_id;
    }
    if (groupId && authzManaged) {
      const { version } = await getAccountRow(acc.app);
      const idemp = nextUuid();
      await serviceRpc(
        "direct_entry_authz_assign_group_member_admin",
        [OWNER.auth, OWNER.app, acc.app, groupId, version, `Assign group ${slug}`, idemp, sha256(`grp:${acc.app}:${groupId}:${idemp}`)],
        ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
      );
    }
    if (withLeaveProfile) {
      await serviceRpc(
        "leave_management_upsert_employee_profile_admin",
        [
          OWNER.auth,
          OWNER.app,
          acc.app,
          "OFFICIAL",
          null,
          "2026-01-01",
          "2026-01-01",
          null,
          0,
          0,
          `Leave profile ${slug}`,
          nextKey(`lv_${slug}`),
          sha256(`lv:${acc.app}:${seq}`),
        ],
        ["uuid", "uuid", "uuid", "text", "text", "date", "date", "date", "integer", "integer", "text", "text", "text"],
      );
    }
    return { ...acc, rec, code, personId };
  }

  async function apiAssignGroup(targetAppUserId, groupId, reason) {
    const { version } = await getAccountRow(targetAppUserId);
    const ownerCtx = await serviceRpc("direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
    const ownerTs = await resolveActor({
      session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
      repository: { loadByAuthSubject: async () => ownerCtx },
      at: atIso,
    });
    const repo = createServicePermissionGroupRepository((name, args) => serviceRpcNamed(name, args));
    const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/groups`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
        "sec-fetch-site": "same-origin",
        "idempotency-key": nextUuid(),
      },
      body: JSON.stringify({ group_id: groupId, expected_account_version: version, reason }),
    });
    const res = await assignAccountGroupAdmin(req, targetAppUserId, "true", {
      resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
      repository: repo,
    });
    const body = await res.json();
    assert.equal(res.status, 201, `assignAccountGroupAdmin failed: ${res.status} ${JSON.stringify(body)}`);
    return body.membership;
  }

  async function apiRemoveGroup(targetAppUserId, membershipId, reason) {
    const { version } = await getAccountRow(targetAppUserId);
    const ownerCtx = await serviceRpc("direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
    const ownerTs = await resolveActor({
      session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
      repository: { loadByAuthSubject: async () => ownerCtx },
      at: atIso,
    });
    const repo = createServicePermissionGroupRepository((name, args) => serviceRpcNamed(name, args));
    const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/groups/${membershipId}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
        "sec-fetch-site": "same-origin",
        "idempotency-key": nextUuid(),
      },
      body: JSON.stringify({ expected_account_version: version, reason }),
    });
    const res = await removeAccountGroupAdmin(req, targetAppUserId, membershipId, "true", {
      resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
      repository: repo,
    });
    const body = await res.json();
    assert.equal(res.status, 200, `removeAccountGroupAdmin failed: ${res.status} ${JSON.stringify(body)}`);
    return body.membership;
  }

  async function apiToggleAccount(targetAppUserId, action, reason) {
    const { version } = await getAccountRow(targetAppUserId);
    const ownerCtx = await serviceRpc("direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
    const ownerTs = await resolveActor({
      session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
      repository: { loadByAuthSubject: async () => ownerCtx },
      at: atIso,
    });
    const repo = createAccountAccessRepository((name, args) => serviceRpcNamed(name, args));
    const idempKey = nextUuid();
    const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
        "sec-fetch-site": "same-origin",
        "idempotency-key": idempKey,
      },
      body: JSON.stringify({ expected_version: version, reason, idempotency_key: idempKey }),
    });
    const res = await mutateAccount(req, targetAppUserId, action, "true", {
      resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
      repository: repo,
    });
    const body = await res.json();
    assert.equal(res.status, 200, `mutateAccount(${action}) failed: ${res.status} ${JSON.stringify(body)}`);
    return body;
  }

  async function getLegacyRowCounts(appUserId = null) {
    const cond = appUserId ? "where app_user_id = $1::uuid" : "";
    const params = appUserId ? [appUserId] : [];
    const { rows: [c] } = await setup.query(`select count(*)::int as n from public.direct_entry_capability_grants ${cond}`, params);
    const { rows: [s] } = await setup.query(`select count(*)::int as n from public.direct_entry_scope_grants ${cond}`, params);
    const { rows: [b] } = appUserId
      ? await setup.query(
          `select count(*)::int as n
             from public.work_report_team_leader_capability_grants x
             join public.direct_entry_team_leader_assignments a on a.assignment_id = x.leader_assignment_id
            where a.leader_app_user_id = $1::uuid`,
          [appUserId],
        )
      : await setup.query("select count(*)::int as n from public.work_report_team_leader_capability_grants");
    return { cap: c.n, scope: s.n, bridge: b.n };
  }

  async function captureFullLegacyTableSnapshot(queryClient = setup) {
    const { rows: fpRows } = await queryClient.query(`
      WITH cap_manifest AS (
        SELECT 'direct_entry_capability_grants'::text AS table_name,
               count(*)::int AS row_count,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
                 pg_catalog.string_agg(
                   cg.grant_id::text || '|' || cg.app_user_id::text || '|' || cg.capability || '|' || cg.valid_from::text
                   || '|' || coalesce(cg.valid_to::text, '')
                   || '|' || pg_catalog.to_char(cg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   || '|' || cg.is_current::text || '|' || cg.suspended_by_account_disable::text,
                   E'\\n' ORDER BY cg.grant_id ASC
                 ), ''
               ), 'UTF8')), 'hex') AS canonical_sha256
        FROM public.direct_entry_capability_grants cg
      ),
      scope_manifest AS (
        SELECT 'direct_entry_scope_grants'::text AS table_name,
               count(*)::int AS row_count,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
                 pg_catalog.string_agg(
                   sg.grant_id::text || '|' || sg.app_user_id::text || '|' || sg.scope_kind
                   || '|' || coalesce(sg.team_id::text, '')
                   || '|' || sg.valid_from::text || '|' || coalesce(sg.valid_to::text, '')
                   || '|' || pg_catalog.to_char(sg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   || '|' || sg.is_current::text || '|' || sg.suspended_by_account_disable::text,
                   E'\\n' ORDER BY sg.grant_id ASC
                 ), ''
               ), 'UTF8')), 'hex') AS canonical_sha256
        FROM public.direct_entry_scope_grants sg
      ),
      bridge_manifest AS (
        SELECT 'work_report_team_leader_capability_grants'::text AS table_name,
               count(*)::int AS row_count,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
                 pg_catalog.string_agg(
                   x.leader_assignment_id::text || '|' || x.capability || '|' || x.capability_grant_id::text,
                   E'\\n' ORDER BY x.leader_assignment_id ASC, x.capability ASC
                 ), ''
               ), 'UTF8')), 'hex') AS canonical_sha256
        FROM public.work_report_team_leader_capability_grants x
      )
      SELECT * FROM cap_manifest
      UNION ALL SELECT * FROM scope_manifest
      UNION ALL SELECT * FROM bridge_manifest
    `);
    const fingerprints = Object.fromEntries(fpRows.map((r) => [r.table_name, { row_count: r.row_count, canonical_sha256: r.canonical_sha256 }]));

    const { rows: capRows } = await queryClient.query(`
      select grant_id::text, app_user_id::text, capability, valid_from::text, valid_to::text,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc,
             is_current, suspended_by_account_disable
        from public.direct_entry_capability_grants
       order by grant_id asc
    `);
    const { rows: scopeRows } = await queryClient.query(`
      select grant_id::text, app_user_id::text, scope_kind, team_id::text, valid_from::text, valid_to::text,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc,
             is_current, suspended_by_account_disable
        from public.direct_entry_scope_grants
       order by grant_id asc
    `);
    const { rows: bridgeRows } = await queryClient.query(`
      select leader_assignment_id::text, capability, capability_grant_id::text
        from public.work_report_team_leader_capability_grants
       order by leader_assignment_id asc, capability asc
    `);
    return { fingerprints, capRows, scopeRows, bridgeRows };
  }

  async function captureTargetFunctionCatalog(queryClient = observer) {
    const { rows: fnRows } = await queryClient.query(
      `select p.proname,
              pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_args,
              pg_catalog.pg_get_userbyid(p.proowner) as owner,
              p.prosecdef,
              p.proconfig,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
              pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')),
                'hex'
              ) as funcdef_sha256
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])
        order by p.proname asc, identity_args asc`,
      [CORE_3C_PROCS],
    );
    const { rows: svcRows } = await queryClient.query(`
      select p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       order by sig asc
    `);
    const { rows: [colDef] } = await queryClient.query(`
      select c.column_default, c.is_nullable
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = 'direct_entry_app_users'
         and c.column_name = 'authz_managed'
    `);
    return {
      functions: fnRows,
      serviceRoleSignatures: svcRows.map((r) => r.sig),
      authzManagedDefault: colDef?.column_default ?? null,
      authzManagedNullable: colDef?.is_nullable ?? null,
    };
  }

  async function evaluateActorSurface(user) {
    const rpcCtx = await serviceRpc("direct_entry_resolve_actor_context", [user.auth], ["uuid"]);
    const tsActorRes = await resolveActor({
      session: { auth_subject: user.auth, provider: "supabase", authenticated_at: atIso },
      repository: { loadByAuthSubject: async () => rpcCtx },
      at: atIso,
    });

    const navActor = tsActorRes.ok
      ? {
          capabilities: tsActorRes.actor.capabilities,
          scopes: tsActorRes.actor.scopes.map((s) => ({ kind: s.kind })),
          ...(tsActorRes.actor.effective_grants !== undefined ? { effective_grants: tsActorRes.actor.effective_grants } : {}),
          ...(tsActorRes.actor.effective_report_review_scopes !== undefined
            ? { effective_report_review_scopes: tsActorRes.actor.effective_report_review_scopes }
            : {}),
          ...(tsActorRes.actor.allowed_worker_tabs !== undefined ? { allowed_worker_tabs: tsActorRes.actor.allowed_worker_tabs } : {}),
          hasAttendanceDepartmentHeadAccess: hasActiveDepartmentHeadRole(tsActorRes.actor),
        }
      : null;

    const menu = NAV_ENTRIES_META.filter((entry) => {
      if (!entry.desktop) return false;
      if (navActor === null && entry.id !== "dashboard") return false;
      return decideNavEntryVisibility({
        capabilityKey: entry.capability,
        actor: navActor,
        viewport: "desktop",
        entryVisibleInViewport: entry.desktop,
      });
    }).map((e) => (e.id === "work-report-management" ? `${e.id}(${resolveWorkReportManagementPath(navActor)})` : e.id));

    const pages = {
      directEntry: decideDirectEntryPageAccess({ uiEnabled: true, actor: tsActorRes }),
      workers: decideWorkerOperationsPageAccess({ uiEnabled: true, actor: tsActorRes }),
      projects: decideProjectOperationsPageAccess({ uiEnabled: true, actor: tsActorRes }),
      adminArea: decideAdminAreaAccess({ actor: tsActorRes }),
      accountAccess: decideAccountAccessPageAccess({ actor: tsActorRes }),
    };

    const resolveSession = async () => ({ actor: tsActorRes, response_headers: {} });
    const writeRepo = createDirectEntryWriteRepository((name, args) => serviceRpcNamed(name, args));
    const workerRepo = createWorkerDirectoryRepository((name, args) => serviceRpcNamed(name, args));
    const submissionRepo = createSubmissionReadRepository((name, args) => serviceRpcNamed(name, args));

    const authSessionResp = await createAuthSessionResponse(resolveSession);
    const authSessionBody = await authSessionResp.json();
    const deSessionResp = await createDirectEntrySessionResponse("true", resolveSession);
    const deSessionBody = await deSessionResp.json();
    const catalogResp = await getInputCatalog(todayStr, "true", { resolveSession, repository: writeRepo });
    const catalogBody = await catalogResp.json();
    const draftsResp = await getOwnDrafts("true", { resolveSession, repository: writeRepo });
    const draftsBody = await draftsResp.json();
    const submissionsResp = await listOwnSubmissions(
      new Request("http://localhost/api/direct-entry/submissions"),
      "true",
      { resolveSession, repository: submissionRepo },
    );
    const submissionsBody = await submissionsResp.json();
    const workersAllResp = await listWorkers(
      new Request("http://localhost/api/direct-entry/workers?scope=all"),
      "true",
      { resolveSession, repository: workerRepo },
    );
    const workersAllBody = await workersAllResp.json();
    const workersTeamResp = await listWorkers(
      new Request("http://localhost/api/direct-entry/workers?scope=team"),
      "true",
      { resolveSession, repository: workerRepo },
    );
    const workersTeamBody = await workersTeamResp.json();

    return {
      rpc: {
        enabled: rpcCtx?.enabled ?? null,
        capabilities: [...(rpcCtx?.capabilities ?? [])].sort(),
        team_scopes: (rpcCtx?.team_scope_grants ?? []).map((g) => g.team_id).sort(),
        all_scope_count: (rpcCtx?.all_scope_grants ?? []).length,
        allowed_worker_tabs: [...(rpcCtx?.allowed_worker_tabs ?? [])].sort(),
        review_scopes: (rpcCtx?.effective_report_review_scopes ?? []).map((s) => `${s.kind}:${s.team_id ?? "ALL"}`).sort(),
        assigned_roles: (rpcCtx?.assigned_roles ?? []).map((r) => `${r.role_code}${r.scope_id ? `@${r.scope_id}` : ""}`).sort(),
        effective_grants: (rpcCtx?.effective_grants ?? []).map((g) => `${g.capability}@${g.scope_kind}:${g.scope_id ?? "NULL"}`).sort(),
      },
      ts_actor: tsActorRes.ok
        ? {
            ok: true,
            client_capabilities: [...projectClientCapabilities(tsActorRes.actor)].sort(),
            client_scopes: projectClientScopes(tsActorRes.actor).map((s) => `${s.kind}:${s.reference === user.app ? "SELF" : s.reference}`).sort(),
            has_doc_upload_paired: hasAnyValidPairedGrant(tsActorRes.actor, "document_upload", ["OWN", "ALL"]),
          }
        : { ok: false, reason: tsActorRes.reason },
      menu,
      pages,
      api: {
        auth_session: { status: authSessionResp.status, ok: authSessionBody.ok, code: authSessionBody.code ?? null },
        direct_entry_session: { status: deSessionResp.status, ok: deSessionBody.ok, code: deSessionBody.code ?? null },
        uploader_catalog: { status: catalogResp.status, ok: catalogBody.ok, code: catalogBody.code ?? null },
        uploader_drafts: { status: draftsResp.status, ok: draftsBody.ok, code: draftsBody.code ?? null },
        workers_uploader: { status: submissionsResp.status, ok: submissionsBody.ok, code: submissionsBody.code ?? null },
        workers_all: { status: workersAllResp.status, ok: workersAllBody.ok, code: workersAllBody.code ?? null },
        workers_team: { status: workersTeamResp.status, ok: workersTeamBody.ok, code: workersTeamBody.code ?? null },
      },
    };
  }

  async function runTlFullSurface(tlUser, label) {
    const surface = await evaluateActorSurface(tlUser);
    const wrOpts = await tryServiceRpc("work_report_list_assignment_options", [tlUser.auth, tlUser.app, null], ["uuid", "uuid", "uuid"]);
    const wrRev = await tryServiceRpc("work_report_list_pending_reviews", [tlUser.auth, tlUser.app, null, null, 20], ["uuid", "uuid", "uuid", "text", "integer"]);

    await setup.query("savepoint sp_3c_tl_asgn");
    const wrCreate = await tryServiceRpc(
      "work_report_create_assignment",
      [tlUser.auth, tlUser.app, wrTplTeam.template_id, "TEAM", null, TEAM_A, null, "DAILY", true, 0, "23:59:59", false, todayStr, null, nextKey("tl_asgn")],
      ["uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]", "text", "boolean", "integer", "time", "boolean", "date", "date", "text"],
    );
    let wrDecideOk = false;
    if (wrCreate.ok) {
      const { rows: [obRow] } = await setup.query(
        "select obligation_id from public.work_report_obligations where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid",
        [wrCreate.data.assignment_id, UPLOADER.app],
      );
      assert.ok(obRow, `Missing obligation for wrTplTeam assignment ${wrCreate.data.assignment_id}`);
      const sub = await serviceRpc(
        "work_report_submit",
        [UPLOADER.auth, UPLOADER.app, obRow.obligation_id, JSON.stringify({ calls: 10 }), null, nextKey("tl_sub")],
        ["uuid", "uuid", "uuid", "jsonb", "integer", "text"],
      );
      const dec = await tryServiceRpc(
        "work_report_decide_review",
        [tlUser.auth, tlUser.app, obRow.obligation_id, "APPROVED", null, sub.version, nextKey("tl_dec")],
        ["uuid", "uuid", "uuid", "text", "text", "integer", "text"],
      );
      assert.equal(dec.ok, true, `decide_review failed: ${JSON.stringify(dec)}`);
      wrDecideOk = dec.ok && dec.data?.state === "APPROVED";
    }
    await setup.query("rollback to savepoint sp_3c_tl_asgn");
    await setup.query("release savepoint sp_3c_tl_asgn");

    const wrAnal = await tryServiceRpc(
      "work_report_analytics_overview",
      [tlUser.auth, tlUser.app, wrTpl.template_id, null, todayStr, todayStr, TEAM_A, null, "final"],
      ["uuid", "uuid", "uuid", "uuid", "date", "date", "uuid", "uuid", "text"],
    );
    const wrMyOb = await tryServiceRpc("work_report_list_my_obligations", [tlUser.auth, tlUser.app, null], ["uuid", "uuid", "text"]);
    const wrHasOb = await tryServiceRpc("work_report_has_active_obligations", [tlUser.auth, tlUser.app], ["uuid", "uuid"]);
    const wrRead = await tryServiceRpc(
      "work_report_list_readable_submissions",
      [tlUser.auth, tlUser.app, null, null, null, null, null, null, null, null, 20],
      ["uuid", "uuid", "uuid", "uuid", "date", "date", "uuid", "uuid", "text", "text", "integer"],
    );

    const lvSummary = await tryServiceRpc("leave_management_get_my_summary", [UPLOADER.auth, UPLOADER.app, leaveYear], ["uuid", "uuid", "integer"]);
    await setup.query("savepoint sp_3c_tl_lv_exp");
    const lvReq = await tryServiceRpc("leave_management_create_request", [
      UPLOADER.auth,
      UPLOADER.app,
      JSON.stringify([{ leave_date: leaveDay1, session_code: "AM", leave_type: "UNPAID" }]),
      `${label} leave`,
      nextKey("tl_lv"),
      sha256(`tl_lv:${seq}`),
    ]);
    let lvApproveOk = false;
    if (lvReq.ok) {
      const lvDec = await tryServiceRpc("leave_management_decide_request", [
        tlUser.auth,
        tlUser.app,
        lvReq.data.request.request_id,
        "APPROVE",
        1,
        `${label} approve leave`,
        nextKey("tl_lv_app"),
        sha256(`tl_lv_app:${seq}`),
      ]);
      lvApproveOk = lvDec.ok && lvDec.data?.request?.status === "APPROVED";
    }
    const expRaw = await tryServiceRpc("attendance_submit_explanation", [
      UPLOADER.auth,
      UPLOADER.app,
      yesterdayVn,
      "SLOT_1",
      `${label} exp`,
      nextUuid(),
      sha256(`tl_exp:${seq}`),
    ]);
    let expApproveOk = false;
    if (expRaw.ok) {
      const exp = projectSubmitAttendanceExplanationResult(expRaw.data);
      const expInbox = projectAttendanceExplanationApprovalInbox(
        await serviceRpc("attendance_list_explanation_approval_inbox", [tlUser.auth, tlUser.app, "PENDING", 50, 0]),
      );
      if (exp.explanation.route_kind === "TEAM_LEADER" && expInbox.items.some((i) => i.explanation_id === exp.explanation.explanation_id)) {
        const expDec = await tryServiceRpc("attendance_decide_explanation", [
          tlUser.auth,
          tlUser.app,
          exp.explanation.explanation_id,
          "APPROVE",
          1,
          `${label} approve exp`,
          nextUuid(),
          sha256(`tl_exp_app:${seq}`),
        ]);
        expApproveOk = expDec.ok && expDec.data?.explanation?.status === "APPROVED";
      }
    }
    await setup.query("rollback to savepoint sp_3c_tl_lv_exp");
    await setup.query("release savepoint sp_3c_tl_lv_exp");

    const attAdmin = await tryServiceRpc(
      "attendance_admin_report",
      [tlUser.auth, tlUser.app, todayStr, todayStr, 1, 20, null, null],
      ["uuid", "uuid", "date", "date", "integer", "integer", "text", "uuid"],
    );
    const attMatrix = await tryServiceRpc(
      "attendance_monthly_matrix_report",
      [tlUser.auth, tlUser.app, yearMonth, null, null, null, 1, 20],
      ["uuid", "uuid", "text", "uuid", "uuid", "text", "integer", "integer"],
    );

    const recVer = await getRecruiterVersion(tlUser.rec);
    const moveBlocked = await tryServiceRpc(
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, tlUser.rec, TEAM_B, todayStr, recVer, "Try move active TL", nextKey("mv_blk")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    const unassignBlocked = await tryServiceRpc(
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, tlUser.rec, todayStr, recVer, "Try unassign active TL", nextKey("un_blk")],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );

    return {
      surface,
      wr: {
        opts: wrOpts.ok,
        rev: wrRev.ok,
        create_asgn: wrCreate.ok,
        decide_review: wrDecideOk,
        anal: wrAnal.ok,
        my_ob: wrMyOb.ok,
        has_ob: wrHasOb.ok ? wrHasOb.data.has_active_obligations : "ERR",
        readable: wrRead.ok,
      },
      leave_primary_approver_is_tl:
        lvSummary.ok &&
        ((lvSummary.data?.routing ?? lvSummary.data?.approval_route)?.primary_approver_app_user_id === tlUser.app),
      leave_approve_ok: lvApproveOk,
      exp_approve_ok: expApproveOk,
      att_admin: attAdmin.ok,
      att_matrix: attMatrix.ok,
      pr42_move_blocked_code: moveBlocked.ok ? "UNEXPECTED_OK" : moveBlocked.code,
      pr42_unassign_blocked_code: unassignBlocked.ok ? "UNEXPECTED_OK" : unassignBlocked.code,
    };
  }

  async function runParityProfilesScenario(mode) {
    const out = {};
    await beginOuterTx();
    try {
      if (mode === "AFTER_3C") {
        // Prove zero reliance on legacy tables by wiping pre-existing legacy rows for managed parity actors inside this tx
        const managedIds = [
          OWNER.app, HR_OP.app, UPLOADER.app, PM_USER.app, CTX_PM.app, PA_USER.app,
          CTX_TL.app, LOCK_KEEP.app, LOCK_REVOKE.app, MULTI_GRP.app, TL_POST3B.app, TL_REPLACE.app,
        ];
        await setup.query("delete from public.work_report_team_leader_capability_grants where leader_assignment_id in (select assignment_id from public.direct_entry_team_leader_assignments where leader_app_user_id = any($1::uuid[]))", [managedIds]);
        await setup.query("delete from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])", [managedIds]);
        await setup.query("delete from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])", [managedIds]);
      }

      // 1. Active authz_managed=true roles (OWNER, HR_OP, UPLOADER, PM_USER, PA_USER) + 12 module RPCs
      const surfaces = {};
      for (const [k, u] of [
        ["OWNER", OWNER],
        ["HR_OP", HR_OP],
        ["UPLOADER", UPLOADER],
        ["PM_USER", PM_USER],
        ["PA_USER", PA_USER],
      ]) {
        surfaces[k] = await evaluateActorSurface(u);
      }
      const rpcs = {
        uploader_read_entry: (await tryServiceRpc("direct_entry_read_projection", [UPLOADER.auth, UPLOADER.app, sampleEntryId], ["uuid", "uuid", "uuid"])).ok,
        uploader_list_workers: (await tryServiceRpc("direct_entry_list_workers", [UPLOADER.auth, UPLOADER.app, "recruited"], ["uuid", "uuid", "text"])).ok,
        pm_list_managed: (await tryServiceRpc("direct_entry_list_workers", [PM_USER.auth, PM_USER.app, "managed"], ["uuid", "uuid", "text"])).ok,
        owner_reporting_facts: (await tryServiceRpc("direct_entry_reporting_scoped_facts", [OWNER.auth, OWNER.app, JSON.stringify({})], ["uuid", "uuid", "jsonb"])).ok,
        hr_list_personnel: (await tryServiceRpc("direct_entry_list_personnel_admin", [HR_OP.auth, HR_OP.app, null, false, 1, 20], ["uuid", "uuid", "text", "boolean", "integer", "integer"])).ok,
        hr_list_teams: (await tryServiceRpc("direct_entry_list_teams_admin", [HR_OP.auth, HR_OP.app, null, false, 1, 20], ["uuid", "uuid", "text", "boolean", "integer", "integer"])).ok,
        owner_wr_templates: (await tryServiceRpc("work_report_list_templates", [OWNER.auth, OWNER.app], ["uuid", "uuid"])).ok,
        uploader_wr_obligations: (await tryServiceRpc("work_report_list_my_obligations", [UPLOADER.auth, UPLOADER.app, null], ["uuid", "uuid", "text"])).ok,
        owner_leave_access: (await tryServiceRpc("leave_management_get_actor_access", [OWNER.auth, OWNER.app], ["uuid", "uuid"])).ok,
        pa_vfin_access: (await serviceRpc("vendor_finance_get_actor_access", [PA_USER.auth, PA_USER.app], ["uuid", "uuid"])).can_view,
        owner_vfin_access: (await serviceRpc("vendor_finance_get_actor_access", [OWNER.auth, OWNER.app], ["uuid", "uuid"])).can_record,
        owner_salary_advance: (await serviceRpc("salary_advance_get_actor_access", [OWNER.auth, OWNER.app], ["uuid", "uuid"])).can_access,
      };
      for (const [rk, rv] of Object.entries(rpcs)) {
        assert.equal(rv, true, `${mode}: Profile 1 RPC ${rk} expected true, got ${rv}`);
      }
      out.profile1 = { surfaces, rpcs };

      // 2a. Disabled -> Re-enabled (keep groups)
      await apiToggleAccount(LOCK_KEEP.app, "disable", `${mode} lock keep`);
      const lk2aLocked = await evaluateActorSurface(LOCK_KEEP);
      await apiToggleAccount(LOCK_KEEP.app, "enable", `${mode} unlock keep`);
      const lk2aUnlocked = await evaluateActorSurface(LOCK_KEEP);
      out.profile2a = {
        locked: lk2aLocked,
        unlocked: lk2aUnlocked,
        legacy_rows_after: await getLegacyRowCounts(LOCK_KEEP.app),
      };

      // 2b. Disabled -> Revoke Group 1 while disabled -> Re-enabled
      await apiToggleAccount(LOCK_REVOKE.app, "disable", `${mode} lock revoke`);
      await apiRemoveGroup(LOCK_REVOKE.app, lockRevMem1.membership_id, `${mode} revoke G1 while disabled`);
      await apiToggleAccount(LOCK_REVOKE.app, "enable", `${mode} unlock revoke`);
      out.profile2b = {
        unlocked: await evaluateActorSurface(LOCK_REVOKE),
        legacy_rows_after: await getLegacyRowCounts(LOCK_REVOKE.app),
      };

      // 3. Multi-group overlapping caps (DUAL_A + DUAL_B -> remove DUAL_A)
      const multiBoth = await evaluateActorSurface(MULTI_GRP);
      await apiRemoveGroup(MULTI_GRP.app, multiMemA.membership_id, `${mode} remove DUAL_A`);
      const multiAfter = await evaluateActorSurface(MULTI_GRP);
      out.profile3 = {
        both: multiBoth,
        after_remove_a: multiAfter,
        legacy_rows_after: await getLegacyRowCounts(MULTI_GRP.app),
      };

      // 4. Contextual-only 0-group accounts (CTX_PM with project_admin, PA_USER with vendor_finance_view, CTX_TL on TEAM_B)
      const tvB0 = await getTeamVersion(TEAM_B);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, CTX_TL.app, todayStr, tvB0, `${mode} designate CTX_TL`, nextKey("ctx_tl_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const ctxPmManagedRes = await tryServiceRpc("direct_entry_list_workers", [CTX_PM.auth, CTX_PM.app, "managed"], ["uuid", "uuid", "text"]);
      out.profile4_contextual = {
        ctx_pm: await evaluateActorSurface(CTX_PM),
        ctx_pm_managed: ctxPmManagedRes,
        pa: await evaluateActorSurface(PA_USER),
        ctx_tl: await evaluateActorSurface(CTX_TL),
      };
      const tvB1 = await getTeamVersion(TEAM_B);
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, todayStr, tvB1, `${mode} revoke CTX_TL`, nextKey("ctx_tl_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      // 5. Post-#48 Team Leader full lifecycle (candidates, designate, disable/enable, replace, same-day revoke + v_restore)
      const cands = await serviceRpc(
        "direct_entry_list_team_leader_candidates",
        [OWNER.auth, OWNER.app, TEAM_A, null, 1, 25],
        ["uuid", "uuid", "uuid", "text", "integer", "integer"],
      );
      assert.equal(cands.candidates.some((c) => c.app_user_id === TL_POST3B.app), true, `${mode}: TL_POST3B candidate visible`);

      // Designate TL_POST3B yesterday so we can test v_restore on same-day revoke of TL_REPLACE today!
      await setBusinessDate(setup, yesterdayVn);
      const tvA0 = await getTeamVersion(TEAM_A);
      const desRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, TL_POST3B.app, yesterdayVn, tvA0, `${mode} designate TL`, nextKey("tl_d")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await setBusinessDate(setup, todayStr);
      const tlActive = await runTlFullSurface(TL_POST3B, `${mode}-active`);
      const tlLegacyAfterDes = await getLegacyRowCounts(TL_POST3B.app);

      await apiToggleAccount(TL_POST3B.app, "disable", `${mode} disable TL`);
      const tlLocked = await evaluateActorSurface(TL_POST3B);
      await apiToggleAccount(TL_POST3B.app, "enable", `${mode} enable TL`);
      const tlReenabled = await runTlFullSurface(TL_POST3B, `${mode}-reenabled`);
      const tlLegacyAfterReen = await getLegacyRowCounts(TL_POST3B.app);

      const tvA1 = await getTeamVersion(TEAM_A);
      const repRes = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, TL_REPLACE.app, todayStr, tvA1, `${mode} replace TL`, nextKey("tl_r")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const tlReplacedSurface = await evaluateActorSurface(TL_REPLACE);

      const tvA2 = await getTeamVersion(TEAM_A);
      const revRes = await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, tvA2, `${mode} revoke TL_REPLACE (v_restore)`, nextKey("tl_v")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const tlRestoredSurface = await evaluateActorSurface(TL_POST3B);

      out.profile5_tl = {
        designate_change: desRes.change,
        active: tlActive,
        locked: tlLocked,
        reenabled: tlReenabled,
        replace_change: repRes.change,
        replaced_surface: tlReplacedSurface,
        revoke_change: revRes.change,
        restored_surface: tlRestoredSurface,
        legacy_after_designate: tlLegacyAfterDes,
        legacy_after_reenable: tlLegacyAfterReen,
      };
    } finally {
      await rollbackOuterTx();
      await setBusinessDate(setup, todayStr);
    }
    return out;
  }

  before(async () => {
    const initdb = binary("initdb");
    pgCtl = binary("pg_ctl");
    assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb and pg_ctl binaries are required");

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-3c-pg18-"));
    pgData = path.join(tmpDir, "pgdata");
    pgLog = path.join(tmpDir, "postgres.log");
    port = await freePort();

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

    setup = await connect(port, "wp10-7-3c-setup");
    observer = await connect(port, "wp10-7-3c-observer");
    w1 = await connect(port, "wp10-7-3c-w1");
    w2 = await connect(port, "wp10-7-3c-w2");
    clients.push(setup, observer, w1, w2);

    await setup.query(ROLE_PREAMBLE);

    files = (await readdir(MIGRATION_DIR))
      .filter((f) => f.endsWith(".sql") && f <= WP10_7_3C_MIGRATION_NAME)
      .sort();
    migrationDirThrough3c = path.join(tmpDir, "migrations");
    await mkdir(migrationDirThrough3c);
    for (const name of files) {
      await copyFile(path.join(MIGRATION_DIR, name), path.join(migrationDirThrough3c, name));
    }
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const wp1073bIdx = files.indexOf(WP10_7_3B_MIGRATION_NAME);
    wp1073cIdx = files.indexOf(WP10_7_3C_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(wp1073bIdx > groupsIdx, "WP10-7 Slice 3B migration must exist");
    assert.ok(wp1073cIdx > wp1073bIdx, "WP10-7 Slice 3C migration must follow 3B");

    wp1073cSql = await readFile(path.join(MIGRATION_DIR, WP10_7_3C_MIGRATION_NAME), "utf8");
    wp1073cStrippedSql = stripOuterBeginCommit(wp1073cSql);

    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await seedLegacyAdmin(OWNER);
    await seedLegacyAdmin(LUANPT);
    await seedLegacyAdmin(LIENVU);
    await seedLegacyAdmin(NGATTT);

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i < wp1073cIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    await setup.query(`
      create table if not exists public.schema_migrations (
        version     text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);
    for (let i = 0; i < wp1073cIdx; i += 1) {
      const fname = files[i];
      const sqlText = await readFile(path.join(MIGRATION_DIR, fname), "utf8");
      await setup.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2) on conflict (version) do nothing",
        [fname, migrationChecksum(sqlText)],
      );
    }

    const { rows: [dates] } = await observer.query(`
      with d as (
        select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as today_vn
      ),
      workdays as (
        select gs::date as wd
          from d, generate_series(d.today_vn - 20, d.today_vn - 1, interval '1 day') as gs
         where extract(dow from gs) <> 0
         order by gs desc
      )
      select today_vn::text,
             (select wd::text from workdays limit 1) as yesterday_vn,
             (today_vn + 1)::text as tomorrow_vn,
             (today_vn + 2)::text as leave_d1,
             to_char(today_vn, 'YYYY-MM') as ym,
             extract(year from today_vn)::int as leave_year
        from d
    `);
    await setBusinessDate(setup, dates.today_vn);
    todayStr = dates.today_vn;
    yesterdayVn = dates.yesterday_vn;
    tomorrowStr = dates.tomorrow_vn;
    leaveDay1 = dates.leave_d1;
    yearMonth = dates.ym;
    leaveYear = dates.leave_year;
    atIso = `${todayStr}T09:00:00Z`;

    TEAM_A = nextUuid();
    TEAM_B = nextUuid();
    TEAM_PRE_3B = nextUuid();
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'team_3c_a', 'Đội 3C A', true, 1),
              ($2::uuid, 'team_3c_b', 'Đội 3C B', true, 1),
              ($3::uuid, 'team_3c_pre3b', 'Đội 3C Pre-3B', true, 1)`,
      [TEAM_A, TEAM_B, TEAM_PRE_3B],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự án WP10-7 3C', true, 1)`,
      [PRJ_1],
    );
    await setup.query("insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)");
    for (const tid of [TEAM_A, TEAM_B]) {
      await setup.query(
        `insert into public.direct_entry_project_team_scopes
           (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
         values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)`,
        [PRJ_1, tid, OWNER.app],
      );
    }

    const { rows: depts } = await setup.query(
      "select department_id::text, system_key from public.organization_departments where is_active = true",
    );
    deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));
    const { rows: grps } = await setup.query(
      "select group_id::text, code from public.authz_user_groups where active = true",
    );
    grpByCode = Object.fromEntries(grps.map((g) => [g.code, g.group_id]));

    async function createCustomGroup(code, name, deptKey, teamId, caps) {
      const res = await serviceRpc(
        "direct_entry_authz_create_group_admin",
        [
          OWNER.auth, OWNER.app, code, name, `WP10-7 3C ${code}`,
          deptByKey[deptKey], teamId, caps, JSON.stringify([]),
          `Create ${code}`, nextUuid(), sha256(`grp3c:${code}`),
        ],
        ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
      );
      return res.group?.group_id ?? res.group_id;
    }

    GRP_DUAL_A = await createCustomGroup(
      "WP107_3C_DUAL_A", "Nhóm Kép 3C A", "RECRUITMENT", null,
      ["entry_create", "entry_own", "submission_create", "document_upload", "catalog_master_manage"],
    );
    GRP_DUAL_B = await createCustomGroup(
      "WP107_3C_DUAL_B", "Nhóm Kép 3C B", "RECRUITMENT", null,
      ["entry_create", "entry_own", "submission_create", "report_assign", "report_review"],
    );
    GRP_CATALOG_ONLY = await createCustomGroup(
      "WP107_3C_CATALOG", "Nhóm Danh mục 3C", "ACCOUNTING", null,
      ["catalog_master_manage"],
    );
    GRP_TEAM_SCOPE = await createCustomGroup(
      "WP107_3C_TEAM_SCOPE", "Nhóm Team Scope 3C", "RECRUITMENT", TEAM_A,
      ["entry_team"],
    );

    const wrSchema = {
      version: "work-report-schema/1.0",
      sections: [{
        section_key: "kpi", label: "KPI", description: null, sort_order: 10,
        fields: [{
          field_key: "calls", section_key: "kpi", sort_order: 10, label: "Cuộc gọi", description: null,
          field_type: "integer", required: true, default_value: 0,
          validation: { min_value: 0, max_value: 1000, allow_zero: true }, options: null,
          is_metric: true,
          metric_spec: {
            metric_key: "calls", unit: "cuộc", aggregations: ["SUM"],
            null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO",
            compatible_group: "wp107_3c_calls_v1",
          },
          is_dimension: false,
        }],
      }],
    };
    const wrMetrics = {
      version: "work-report-metrics/1.0",
      metrics: [{
        metric_key: "calls", field_key: "calls", field_type: "integer", unit: "cuộc",
        aggregations: ["SUM"], null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO",
        compatible_group: "wp107_3c_calls_v1",
      }],
    };
    wrTpl = await serviceRpc("work_report_create_template", [
      OWNER.auth, OWNER.app, "WP107_3C_TPL", "WP107_3C_TPL", "Mẫu 3C", "DAILY",
      JSON.stringify(wrSchema), JSON.stringify(wrMetrics), nextKey("tpl"),
    ]);
    await setup.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [wrTpl.draft_version_id],
    );
    await serviceRpc("work_report_publish_template", [
      OWNER.auth, OWNER.app, wrTpl.template_id, wrTpl.draft_version_id, wrTpl.version, nextKey("pub"),
    ]);

    wrTplTeam = await serviceRpc("work_report_create_template", [
      OWNER.auth, OWNER.app, "WP107_3C_TPL_TEAM", "WP107_3C_TPL_TEAM", "Mẫu 3C Team", "DAILY",
      JSON.stringify(wrSchema), JSON.stringify(wrMetrics), nextKey("tpl_t"),
    ]);
    await setup.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [wrTplTeam.draft_version_id],
    );
    await serviceRpc("work_report_publish_template", [
      OWNER.auth, OWNER.app, wrTplTeam.template_id, wrTplTeam.draft_version_id, wrTplTeam.version, nextKey("pub_t"),
    ]);

    HR_OP = await seedAccount("hr.3c", "HR Operator 3C");
    await apiAssignGroup(HR_OP.app, grpByCode.HR_CATALOG_OPERATOR, "Assign HR_OP");

    UPLOADER = await seedRecruiterPerson("uploader.3c", "Uploader 3C", TEAM_A, deptByKey.RECRUITMENT, {
      position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
    });
    const { rows: [ltRow] } = await setup.query(
      "select labor_type_key from public.direct_entry_labor_types where active = true order by sort_order, labor_type_key limit 1",
    );
    const validLaborType = ltRow?.labor_type_key ?? "official";
    const createdBatch = await serviceRpc(
      "direct_entry_create_batch",
      [
        UPLOADER.auth, UPLOADER.app,
        JSON.stringify([{
          project_id: PRJ_1,
          first_work_date: todayStr,
          employee_code: `hrp-${todayStr.slice(0, 4)}-960001`,
          worker_details: {
            display_name: "Nguyen Van 3C",
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          recruiter_id: UPLOADER.rec,
          labor_type: validLaborType,
        }]),
        nextKey("batch"),
      ],
      ["uuid", "uuid", "jsonb", "text"],
    );
    sampleEntryId = createdBatch.entry_ids[0];
    await serviceRpc(
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, wrTpl.template_id, "USER", UPLOADER.app, null, null,
        "DAILY", true, 0, "18:00:00", false, null, null, nextKey("asgn_up"),
      ],
      ["uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]", "text", "boolean", "integer", "time", "boolean", "date", "date", "text"],
    );

    PM_USER = await seedRecruiterPerson("pm.3c", "PM 3C", TEAM_A, deptByKey.RECRUITMENT, {
      position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    await serviceRpc(
      "direct_entry_assign_project_manager",
      [OWNER.auth, OWNER.app, PRJ_1, PM_USER.rec, todayStr, 1, "Seed PM 3C", nextKey("pm")],
      ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
    );

    // Contextual-only 0-group PM
    CTX_PM = await seedRecruiterPerson("ctx.pm.3c", "Contextual PM 3C", TEAM_A, deptByKey.RECRUITMENT, {
      position: "STAFF", authzManaged: true, groupId: null,
    });
    await serviceRpc(
      "direct_entry_assign_project_manager",
      [OWNER.auth, OWNER.app, PRJ_1, CTX_PM.rec, todayStr, 2, "Seed Contextual PM 3C", nextKey("ctx_pm")],
      ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
    );

    // Contextual-only 0-group PA
    PA_USER = await seedAccount("pa.3c", "PA 3C");
    await serviceRpc("org_department_create_person_admin", [
      OWNER.auth, OWNER.app, "PER-PA-3C", "PA 3C", "2026-01-01",
      deptByKey.ACCOUNTING, PA_USER.app, 1, null, "Seed PA person", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "PER-PA-3C",
        full_name: "PA 3C",
        joined_on: "2026-01-01",
        initial_department_ref: deptByKey.ACCOUNTING,
        account_ref: PA_USER.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Seed PA person",
      }),
    ]);
    await serviceRpc(
      "vendor_finance_assign_project_accountant_admin",
      [OWNER.auth, OWNER.app, PRJ_1, PA_USER.app, 0, todayStr, "Seed PA 3C", nextUuid(), sha256(`pa:${PA_USER.app}`)],
      ["uuid", "uuid", "text", "uuid", "integer", "date", "text", "uuid", "text"],
    );

    // Contextual-only 0-group TL candidate
    CTX_TL = await seedRecruiterPerson("ctx.tl.3c", "Contextual TL 3C", TEAM_B, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: null,
    });

    LOCK_KEEP = await seedAccount("lock.keep.3c", "Locked Keep 3C");
    await apiAssignGroup(LOCK_KEEP.app, grpByCode.RECRUITER_OPERATIONS, "Lock keep G1");
    await apiAssignGroup(LOCK_KEEP.app, GRP_CATALOG_ONLY, "Lock keep G2");

    LOCK_REVOKE = await seedAccount("lock.revoke.3c", "Locked Revoke 3C");
    lockRevMem1 = await apiAssignGroup(LOCK_REVOKE.app, grpByCode.RECRUITER_OPERATIONS, "Lock revoke G1");
    await apiAssignGroup(LOCK_REVOKE.app, GRP_CATALOG_ONLY, "Lock revoke G2");

    MULTI_GRP = await seedAccount("multi.grp.3c", "Multi-Group 3C");
    multiMemA = await apiAssignGroup(MULTI_GRP.app, GRP_DUAL_A, "Multi G1");
    await apiAssignGroup(MULTI_GRP.app, GRP_DUAL_B, "Multi G2");

    TL_POST3B = await seedRecruiterPerson("tl.post3b.3c", "TL Post-3B 3C", TEAM_A, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    TL_REPLACE = await seedRecruiterPerson("tl.replace.3c", "TL Replace 3C", TEAM_A, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });

    // Pre-3B TL fixture: designated on TEAM_PRE_3B with pre-3B legacy scope/cap/4 bridge rows
    PRE_3B_TL = await seedRecruiterPerson("pre3b.tl.3c", "Pre-3B TL 3C", TEAM_PRE_3B, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    PRE_3B_REPLACE = await seedRecruiterPerson("pre3b.rep.3c", "Pre-3B Replace 3C", TEAM_PRE_3B, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    await setBusinessDate(setup, yesterdayVn);
    const pre3bDes = await serviceRpc(
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_PRE_3B, PRE_3B_TL.app, yesterdayVn, 1, "Seed Pre-3B TL", nextKey("pre3b_des")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    await setBusinessDate(setup, todayStr);
    await setup.query("begin; set local direct_entry.team_leader_marker = 'on'");
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, $3::date, true)`,
      [PRE_3B_TL.app, TEAM_PRE_3B, yesterdayVn],
    );
    await setup.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'team_manager_assign', $2::date, true)`,
      [PRE_3B_TL.app, yesterdayVn],
    );
    for (const cap of ["report_view", "report_analytics_view", "report_assign", "report_review"]) {
      const { rows: [cg] } = await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, $3::date, true)
         returning grant_id`,
        [PRE_3B_TL.app, cap, yesterdayVn],
      );
      await setup.query(
        `insert into public.work_report_team_leader_capability_grants (leader_assignment_id, capability, capability_grant_id)
         values ($1::uuid, $2, $3::uuid)`,
        [pre3bDes.assignment_id, cap, cg.grant_id],
      );
    }
    await setup.query("commit");
  });

  after(async () => {
    for (const c of clients) {
      await c?.query("rollback").catch(() => {});
      await c?.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("1. Hygiene, pre-3C baseline parity capture, atomic rollback zero drift, pre-DDL block gates, and clean 0..3B -> 3C apply", async () => {
    // 1a. Hygiene checks on 3C migration
    assert.equal(wp1073cSql.includes("\r\n"), false, "3C migration must use LF line endings");
    assert.equal(wp1073cSql.includes("@"), false, "3C migration must contain zero '@' characters");
    assert.equal(/\bsavepoint\b/i.test(wp1073cSql), false, "3C migration must contain zero SAVEPOINT");
    assert.equal(/'40001'/.test(wp1073cSql), false, "3C migration must contain zero '40001'");
    assert.equal(/alter\s+default\s+privileges/i.test(wp1073cSql), false, "3C migration must contain zero ALTER DEFAULT PRIVILEGES");

    // 1b. Capture BEFORE_3C parity snapshot (on real pre-3C schema with mirror ON & legacy fallback intact)
    before3CSnap = await runParityProfilesScenario("BEFORE_3C");

    // 1c. Capture pre-3C catalog snapshot & test atomic rollback zero drift
    pre3cCatalogSnap = await captureTargetFunctionCatalog(observer);
    assert.equal(pre3cCatalogSnap.authzManagedDefault, "false");
    assert.equal(pre3cCatalogSnap.authzManagedNullable, "NO");

    await setup.query("begin");
    await setup.query(wp1073cStrippedSql);
    await setup.query("rollback");

    const afterRollbackSnap = await captureTargetFunctionCatalog(observer);
    assert.deepEqual(afterRollbackSnap, pre3cCatalogSnap, "Atomic rollback of 3C migration must leave zero catalog drift");
    const { rows: migRowsAfterRb } = await observer.query(
      "select 1 from public.schema_migrations where version = $1",
      [WP10_7_3C_MIGRATION_NAME],
    );
    assert.equal(migRowsAfterRb.length, 0);

    // 1d. Pre-DDL block checks BEFORE DDL:
    //   (i) Active authz_managed=false blocked (55000)
    await setup.query("begin");
    try {
      await seedAccount("blk.active.unmanaged", "Blocked Active Unmanaged", { authzManaged: false, enabled: true });
      await assert.rejects(
        () => setup.query(wp1073cStrippedSql),
        (err) => err?.code === "55000" && /WP10_7_3C_PREFLIGHT_BLOCKED.*unmanaged account\(s\) remain \(active=1, disabled=0\)/.test(err?.message),
      );
    } finally {
      await setup.query("rollback");
    }

    //   (ii) Disabled authz_managed=false re-enable trap blocked BEFORE DDL (55000)
    await setup.query("begin");
    try {
      const trap = await seedAccount("blk.disabled.unmanaged", "Blocked Disabled Trap", { authzManaged: false, enabled: false });
      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
         values ($1::uuid, 'entry_create', '2026-01-01', false, true)`,
        [trap.app],
      );
      await assert.rejects(
        () => setup.query(wp1073cStrippedSql),
        (err) => err?.code === "55000" && /WP10_7_3C_PREFLIGHT_BLOCKED.*unmanaged account\(s\) remain \(active=0, disabled=1\)/.test(err?.message),
      );
    } finally {
      await setup.query("rollback");
    }

    //   (iii) LEGACY_BRIDGE effective grant blocked BEFORE DDL (55000) even when all accounts are authz_managed=true
    await setup.query("begin");
    try {
      await setup.query(`
        create or replace function public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id uuid)
        returns jsonb
        language sql
        stable
        security definer
        set search_path = pg_catalog, public
        as $fn$
          select case
            when p_app_user_id = '${HR_OP.app}'::uuid then '[{"capability":"entry_admin","scope_kind":"ALL","scope_id":null,"source_type":"LEGACY_BRIDGE","source_id":"probe","scope_label":"ALL"}]'::jsonb
            else '[]'::jsonb
          end
        $fn$;
      `);
      await assert.rejects(
        () => setup.query(wp1073cStrippedSql),
        (err) => err?.code === "55000" && /WP10_7_3C_PREFLIGHT_BLOCKED.*LEGACY_BRIDGE effective grant row\(s\) remain/.test(err?.message),
      );
    } finally {
      await setup.query("rollback");
    }

    // Confirm pre-DDL blocks left authz_managed default & functions 100% untouched
    assert.deepEqual(await captureTargetFunctionCatalog(observer), pre3cCatalogSnap);

    // 1e. Clean apply 0..3B -> 3C via runMigrationApply
    const applyRes = await runMigrationApply({
      directory: migrationDirThrough3c,
      loadConfig: async () => ({
        databaseUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
        projectRef: "local",
      }),
      createClient: (databaseUrl) =>
        new Client({
          connectionString: databaseUrl,
          application_name: "wp10-7-3c-apply",
          connectionTimeoutMillis: 5000,
        }),
      log: () => {},
      errorLog: () => {},
    });
    assert.equal(applyRes.appliedCount, 1);
  });

  it("2. Post-DDL invariants: DEFAULT true, new account RPCs/insert (0 legacy writes), pg_proc scan, 5 shared triggers, & +0 net RPCs", async () => {
    const post3cCatalogSnap = await captureTargetFunctionCatalog(observer);
    assert.equal(post3cCatalogSnap.authzManagedDefault, "true");
    assert.equal(post3cCatalogSnap.authzManagedNullable, "NO");
    assert.deepEqual(
      post3cCatalogSnap.serviceRoleSignatures,
      pre3cCatalogSnap.serviceRoleSignatures,
      "3C migration must add +0 net service_role RPCs",
    );
    assert.equal(post3cCatalogSnap.serviceRoleSignatures.length, 310);

    // Verify 0 client/PUBLIC EXECUTE across all public procs, SECURITY DEFINER + search_path, & bootstrap owner
    const { rows: [aclCheck] } = await observer.query(`
      select
        count(*) filter (where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))::int as svc_cnt,
        count(*) filter (
          where pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
             or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
             or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        )::int as client_cnt
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind in ('f', 'p')
    `);
    assert.equal(aclCheck.svc_cnt, 310);
    assert.equal(aclCheck.client_cnt, 0);

    for (const fn of post3cCatalogSnap.functions) {
      assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
      assert.ok(fn.proconfig.includes("search_path=pg_catalog, public"), `${fn.proname} must lock search_path`);
      assert.equal(fn.public_exec, false);
      assert.equal(fn.anon_exec, false);
      assert.equal(fn.auth_exec, false);
      if (fn.proname === "direct_entry_catalog_bootstrap_plan" || fn.proname === "direct_entry_apply_catalog_bootstrap") {
        assert.equal(fn.owner, "direct_entry_catalog_bootstrap_executor");
      }
    }

    // 5 shared trigger functions intact & bound
    const { rows: sharedFns } = await observer.query(
      `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by p.proname`,
      [SHARED_TRIGGER_FNS],
    );
    assert.equal(sharedFns.length, 5, "All 5 shared trigger functions must remain intact for Slice 3D");

    const { rows: [tlTrg] } = await observer.query(`
      select count(*)::int as n
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname = 'public'
         and c.relname = 'direct_entry_team_leader_assignments'
         and t.tgname = 'work_report_sync_team_leader_capabilities'
    `);
    assert.equal(tlTrg.n, 1);

    // Exact pg_proc dependency scan (3D Section 1/5): blocking_static_procs=0, blocking_dynamic_execute_procs=0
    const { rows: [procScan] } = await observer.query(`
      with app_procs as (
        select
          n.nspname as schema_name,
          p.proname as proc_name,
          pg_catalog.regexp_replace(
            coalesce(p.prosrc, ''),
            $rx$('([^']|'')*'|--[^\\r\\n]*|/\\*.*?\\*/)$rx$,
            ' ',
            'g'
          ) as norm_no_strings,
          pg_catalog.regexp_replace(
            pg_catalog.regexp_replace(
              coalesce(p.prosrc, ''),
              $rx$(--[^\\r\\n]*|/\\*.*?\\*/)$rx$,
              ' ',
              'g'
            ),
            '''''',
            '''',
            'g'
          ) as no_comments_norm_quotes
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname <> 'pg_catalog'
          and n.nspname <> 'information_schema'
          and n.nspname not like 'pg\\_%' escape '\\'
          and n.nspname not in (
            'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',
            'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
            'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'
          )
          and p.prokind in ('f', 'p')
      )
      select
        count(*) filter (
          where (
            ap.norm_no_strings ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\\M'
          )
          and not (
            ap.schema_name = 'public'
            and ap.proc_name in (
              'direct_entry_authz__internal_sync_legacy_grants',
              'work_report_sync_team_leader_capabilities',
              'direct_entry_has_capability',
              'direct_entry_has_scope',
              'direct_entry__internal_capability_grant_effective',
              'direct_entry__internal_team_scope_grant_effective',
              'direct_entry_assert_actor',
              'direct_entry__internal_reconcile_cancelled_team_leaders',
              'direct_entry_transition_legacy_team_leaders',
              'direct_entry_seed_team_scope_grants',
              'direct_entry_guard_effective_interval'
            )
          )
        )::int as blocking_static_procs,
        count(*) filter (
          where ap.norm_no_strings ~* '\\mexecute\\M'
            and ap.no_comments_norm_quotes ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\\M'
        )::int as blocking_dynamic_execute_procs
      from app_procs ap
    `);
    assert.equal(procScan.blocking_static_procs, 0, "blocking_static_procs must be 0 post-3C");
    assert.equal(procScan.blocking_dynamic_execute_procs, 0, "blocking_dynamic_execute_procs must be 0 post-3C");

    // Fail-closed legacy predicates
    const { rows: [predCheck] } = await setup.query(`
      select public.direct_entry_has_capability($1::uuid, 'entry_admin') as has_cap,
             public.direct_entry_has_scope($1::uuid, 'all') as has_scope
    `, [OWNER.app]);
    assert.equal(predCheck.has_cap, false);
    assert.equal(predCheck.has_scope, false);
    await assert.rejects(
      () => setup.query("select public.direct_entry_assert_actor($1::uuid, $2::uuid, 'entry_admin')", [OWNER.auth, OWNER.app]),
      (err) => err?.code === "42501",
    );

    // New account creation RPCs & direct INSERT omitting authz_managed -> authz_managed=true & 0 legacy writes
    const countsBefore = await getLegacyRowCounts();
    await beginOuterTx();
    try {
      // (a) Direct INSERT omitting authz_managed
      const directAuth = nextUuid();
      const directApp = nextUuid();
      await setup.query("insert into auth.users (id, email) values ($1::uuid, 'direct.omitted@hrpartner.vn')", [directAuth]);
      const { rows: [directRow] } = await setup.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
         values ($1::uuid, $2::uuid, 'Direct Omitted Default', true)
         returning authz_managed`,
        [directApp, directAuth],
      );
      assert.equal(directRow.authz_managed, true);

      // (b) finalize_create -> create_personnel
      const login1 = "new3c.pers";
      const begin1 = await serviceRpc("direct_entry_account_operation_begin", [
        OWNER.auth, OWNER.app, "CREATE_ACCOUNT", login1, "New 3C Personnel", null, "Test finalize_create", nextKey("beg1"),
      ]);
      await serviceRpc("direct_entry_account_operation_claim", [
        OWNER.auth, OWNER.app, begin1.intent_id, begin1.intent_token,
      ]);
      const auth1 = nextUuid();
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth1, `${login1}@hrpartner.vn`]);
      const fin1 = await serviceRpc("direct_entry_account_operation_finalize_create", [
        OWNER.auth, OWNER.app, begin1.intent_id, begin1.intent_token, auth1, nextKey("fin1"),
      ]);
      assert.equal((await getAccountRow(fin1.app_user_id)).authz_managed, true);

      const cp1 = await serviceRpc("direct_entry_account_operation_create_personnel", [
        OWNER.auth, OWNER.app, fin1.app_user_id, 1, login1, "STAFF", todayStr, "Create personnel post-3C", nextKey("cp1"),
      ]);
      assert.ok(cp1.recruiter_id);
      assert.equal((await getAccountRow(fin1.app_user_id)).authz_managed, true);
      const { rows: cpAudit } = await setup.query(
        `select action, capability
           from public.direct_entry_audit_events
          where resource_ref = $1
            and action in ('capability_default_grant', 'scope_default_grant')`,
        [fin1.app_user_id],
      );
      assert.ok(cpAudit.some((r) => r.action === "capability_default_grant" && r.capability === "entry_create"));
      assert.ok(cpAudit.some((r) => r.action === "scope_default_grant"));

      // (c) finalize_create -> link_recruiter
      const login2 = "new3c.link";
      const begin2 = await serviceRpc("direct_entry_account_operation_begin", [
        OWNER.auth, OWNER.app, "CREATE_ACCOUNT", login2, "New 3C Linker", null, "Test link_recruiter", nextKey("beg2"),
      ]);
      await serviceRpc("direct_entry_account_operation_claim", [
        OWNER.auth, OWNER.app, begin2.intent_id, begin2.intent_token,
      ]);
      const auth2 = nextUuid();
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth2, `${login2}@hrpartner.vn`]);
      const fin2 = await serviceRpc("direct_entry_account_operation_finalize_create", [
        OWNER.auth, OWNER.app, begin2.intent_id, begin2.intent_token, auth2, nextKey("fin2"),
      ]);
      const unlinkedRec = nextUuid();
      await setup.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
         values ($1::uuid, 'Unlinked 3C Rec', $2, 'STAFF', true, 1)`,
        [unlinkedRec, login2],
      );
      await setup.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2026-01-01', true)`,
        [unlinkedRec],
      );
      await serviceRpc("direct_entry_account_operation_link_recruiter", [
        OWNER.auth, OWNER.app, unlinkedRec, 1, fin2.app_user_id, 1, "Link recruiter post-3C", nextKey("lr2"),
      ]);
      assert.equal((await getAccountRow(fin2.app_user_id)).authz_managed, true);

      // (d) Direct call to no-op sync_legacy_grants writes 0 rows
      await setup.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [fin1.app_user_id]);

      const countsAfter = await getLegacyRowCounts();
      assert.deepEqual(countsAfter, countsBefore, "New account creation paths must write 0 rows to all 3 legacy tables");
    } finally {
      await rollbackOuterTx();
    }
  });

  it("3. Before/After 3C permissions parity (A1..A5) + PR #49 unscoped catalog + fail-closed legacy fallback", async () => {
    const after3CSnap = await runParityProfilesScenario("AFTER_3C");

    // 3a. Active authz_managed=true accounts (OWNER, HR_OP, UPLOADER, PM_USER, PA_USER) + 12 RPCs
    for (const roleKey of ["OWNER", "HR_OP", "UPLOADER", "PM_USER", "PA_USER"]) {
      assert.deepEqual(after3CSnap.profile1.surfaces[roleKey], before3CSnap.profile1.surfaces[roleKey], `Profile 1 parity mismatch for ${roleKey}`);
    }
    assert.deepEqual(after3CSnap.profile1.rpcs, before3CSnap.profile1.rpcs, "Profile 1 RPC parity mismatch");

    // 3b. Disabled -> re-enabled (keep groups & revoke 1 group while disabled -> re-enable)
    assert.deepEqual(after3CSnap.profile2a.locked, before3CSnap.profile2a.locked, "Profile 2a locked mismatch");
    assert.deepEqual(after3CSnap.profile2a.unlocked, before3CSnap.profile2a.unlocked, "Profile 2a unlocked mismatch");
    assert.deepEqual(after3CSnap.profile2a.legacy_rows_after, { cap: 0, scope: 0, bridge: 0 });
    assert.deepEqual(after3CSnap.profile2b.unlocked, before3CSnap.profile2b.unlocked, "Profile 2b unlocked mismatch");
    assert.equal(after3CSnap.profile2b.unlocked.rpc.capabilities.includes("entry_create"), false);
    assert.equal(after3CSnap.profile2b.unlocked.rpc.capabilities.includes("catalog_master_manage"), true);
    assert.deepEqual(after3CSnap.profile2b.legacy_rows_after, { cap: 0, scope: 0, bridge: 0 });

    // 3c. Multi-group overlapping caps (DUAL_A + DUAL_B -> remove DUAL_A)
    assert.deepEqual(after3CSnap.profile3.both, before3CSnap.profile3.both, "Profile 3 both groups mismatch");
    assert.deepEqual(after3CSnap.profile3.after_remove_a, before3CSnap.profile3.after_remove_a, "Profile 3 after remove DUAL_A mismatch");
    assert.deepEqual(after3CSnap.profile3.after_remove_a.rpc.capabilities, ["entry_create", "entry_own", "report_assign", "report_review", "submission_create"]);
    assert.deepEqual(after3CSnap.profile3.legacy_rows_after, { cap: 0, scope: 0, bridge: 0 });

    // 3d. Contextual-only 0-group accounts (CTX_PM, PA_USER, CTX_TL)
    assert.deepEqual(after3CSnap.profile4_contextual, before3CSnap.profile4_contextual, "Contextual-only 0-group parity mismatch");
    assert.equal(after3CSnap.profile4_contextual.ctx_pm_managed.ok, true, `ctx_pm_managed failed: ${JSON.stringify(after3CSnap.profile4_contextual.ctx_pm_managed)}`);
    assert.deepEqual(after3CSnap.profile4_contextual.ctx_pm.rpc.assigned_roles, [`PROJECT_MANAGER@${PRJ_1}`]);
    assert.deepEqual(after3CSnap.profile4_contextual.ctx_pm.rpc.allowed_worker_tabs, ["managed", "recruited", "uploader"]);
    assert.deepEqual(after3CSnap.profile4_contextual.pa.rpc.assigned_roles, [`PROJECT_ACCOUNTANT@${PRJ_1}`]);
    assert.equal(after3CSnap.profile4_contextual.pa.rpc.effective_grants.includes(`vendor_finance_view@CONTEXT_PROJECT:${PRJ_1}`), true);
    assert.equal(after3CSnap.profile4_contextual.ctx_tl.rpc.capabilities.includes("report_review"), true);

    // 3e. Post-#48 Team Leader full lifecycle + Work Reports + Leave + Attendance + #42
    assert.deepEqual(after3CSnap.profile5_tl.active, before3CSnap.profile5_tl.active, "Profile 5 TL active mismatch");
    assert.deepEqual(after3CSnap.profile5_tl.locked, before3CSnap.profile5_tl.locked, "Profile 5 TL locked mismatch");
    assert.deepEqual(after3CSnap.profile5_tl.reenabled, before3CSnap.profile5_tl.reenabled, "Profile 5 TL re-enabled mismatch");
    assert.deepEqual(after3CSnap.profile5_tl.replaced_surface, before3CSnap.profile5_tl.replaced_surface, "Profile 5 TL replace mismatch");
    assert.deepEqual(after3CSnap.profile5_tl.restored_surface, before3CSnap.profile5_tl.restored_surface, "Profile 5 TL v_restore mismatch");
    assert.equal(after3CSnap.profile5_tl.active.wr.decide_review, true);
    assert.equal(after3CSnap.profile5_tl.active.leave_primary_approver_is_tl, true);
    assert.equal(after3CSnap.profile5_tl.active.leave_approve_ok, true);
    assert.equal(after3CSnap.profile5_tl.active.exp_approve_ok, true);
    assert.equal(after3CSnap.profile5_tl.active.pr42_move_blocked_code, "PT409");
    assert.equal(after3CSnap.profile5_tl.active.pr42_unassign_blocked_code, "PT409");
    assert.deepEqual(after3CSnap.profile5_tl.legacy_after_designate, { cap: 0, scope: 0, bridge: 0 });
    assert.deepEqual(after3CSnap.profile5_tl.legacy_after_reenable, { cap: 0, scope: 0, bridge: 0 });

    // 3f. PR #49 unscoped catalog read gate (post-20261127020000), catalog bootstrap & fail-closed authz_managed=false
    const unscopedCatRpc = await serviceRpc(
      "direct_entry_input_catalog",
      [UPLOADER.auth, UPLOADER.app, todayStr],
      ["uuid", "uuid", "date"],
    );
    assert.ok(Array.isArray(unscopedCatRpc.projects));
    assert.ok(Array.isArray(unscopedCatRpc.recruiters));
    const { rows: [{ cat: unscopedCatInternal }] } = await setup.query(
      "select public.direct_entry_input_catalog_unscoped_v42($1::uuid, $2::uuid, $3::date) as cat",
      [UPLOADER.auth, UPLOADER.app, todayStr],
    );
    assert.ok(Array.isArray(unscopedCatInternal.projects));

    const bootPlan = await serviceRpc("direct_entry_catalog_bootstrap_plan", [OWNER.auth, OWNER.app], ["uuid", "uuid"]);
    assert.equal(bootPlan.catalog_empty, false);

    const expectUnscopedSqlError = async (authSubject, appUserId, effectiveDate, expectedCode) => {
      await setup.query("savepoint sp_unscoped_err");
      try {
        await assert.rejects(
          () => setup.query(
            "select public.direct_entry_input_catalog_unscoped_v42($1::uuid, $2::uuid, $3::date)",
            [authSubject, appUserId, effectiveDate],
          ),
          (err) => err?.code === expectedCode,
        );
      } finally {
        await setup.query("rollback to savepoint sp_unscoped_err; release savepoint sp_unscoped_err");
      }
    };

    const assertCatalogReadable = async (actor, expectedOuterProjectIds, label) => {
      const outerCat = await serviceRpc(
        "direct_entry_input_catalog",
        [actor.auth, actor.app, todayStr],
        ["uuid", "uuid", "date"],
      );
      assert.ok(Array.isArray(outerCat.recruiters), `${label}: outer catalog recruiters missing`);
      assert.ok(Array.isArray(outerCat.banks), `${label}: outer catalog banks missing`);
      assert.ok(Array.isArray(outerCat.labor_types), `${label}: outer catalog labor_types missing`);
      assert.deepEqual(
        (outerCat.projects ?? []).map((p) => p.project_id).sort(),
        [...expectedOuterProjectIds].sort(),
        `${label}: outer catalog projects mismatch`,
      );
      const { rows: [{ cat: innerCat }] } = await setup.query(
        "select public.direct_entry_input_catalog_unscoped_v42($1::uuid, $2::uuid, $3::date) as cat",
        [actor.auth, actor.app, todayStr],
      );
      assert.ok(Array.isArray(innerCat.projects) && innerCat.projects.length >= 1, `${label}: inner unscoped catalog projects missing`);
      assert.ok(Array.isArray(innerCat.recruiters), `${label}: inner unscoped catalog recruiters missing`);
    };

    const assertCatalogDenied = async (actor, label) => {
      const res = await tryServiceRpc(
        "direct_entry_input_catalog",
        [actor.auth, actor.app, todayStr],
        ["uuid", "uuid", "date"],
      );
      assert.equal(res.ok, false, `${label}: direct_entry_input_catalog must be denied`);
      assert.equal(res.code, "42501", `${label}: expected 42501`);
      await expectUnscopedSqlError(actor.auth, actor.app, todayStr, "42501");
    };

    await beginOuterTx();
    try {
      // Null p_effective_date -> 22023 on both outer and unscoped_v42
      const nullDateErr = await tryServiceRpc(
        "direct_entry_input_catalog",
        [CTX_PM.auth, CTX_PM.app, null],
        ["uuid", "uuid", "date"],
      );
      assert.equal(nullDateErr.ok, false);
      assert.equal(nullDateErr.code, "22023");
      await expectUnscopedSqlError(CTX_PM.auth, CTX_PM.app, null, "22023");

      // Seed a second active project PRJ_2 outside CTX_PM scope to verify PM scoping & write restriction
      const prj2 = "wp10-7-3c-prj-2";
      await setup.query(
        `insert into public.direct_entry_projects (project_id, display_name, active, version)
         values ($1, 'Dự án WP10-7 3C Phụ', true, 1)`,
        [prj2],
      );
      await setup.query(
        `insert into public.direct_entry_project_team_scopes
           (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
         values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)`,
        [prj2, TEAM_B, OWNER.app],
      );

      // Pure active CTX_PM (0 groups, project_admin on PRJ_1 only) & pure active CTX_TL (0 groups)
      await assertCatalogReadable(CTX_PM, [PRJ_1], "pure CTX_PM");
      await setup.query("savepoint sp_pm_create_auth");
      await assert.rejects(
        () => setup.query(
          "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, $4::date)",
          [CTX_PM.auth, CTX_PM.app, prj2, todayStr],
        ),
        (err) => err?.code === "42501",
      );
      await setup.query("rollback to savepoint sp_pm_create_auth; release savepoint sp_pm_create_auth");

      await apiToggleAccount(CTX_PM.app, "disable", "Disable CTX_PM for PR49 catalog gate");
      await assertCatalogDenied(CTX_PM, "disabled CTX_PM");
      await apiToggleAccount(CTX_PM.app, "enable", "Re-enable CTX_PM after PR49 catalog gate");
      await assertCatalogReadable(CTX_PM, [PRJ_1], "re-enabled CTX_PM");

      const tvB = await getTeamVersion(TEAM_B);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_B, CTX_TL.app, todayStr, tvB, "PR49 catalog check CTX_TL", nextKey("pr49_tl")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await assertCatalogReadable(CTX_TL, [], "pure CTX_TL");
      await apiToggleAccount(CTX_TL.app, "disable", "Disable CTX_TL for PR49 catalog gate");
      await assertCatalogDenied(CTX_TL, "disabled CTX_TL");

      // Denied real-table actors without catalog capabilities
      await assertCatalogDenied(HR_OP, "HR_OP");
      await assertCatalogDenied(PA_USER, "PA_USER");

      // Pure entry_privileged_edit (ALL / OWN / active non-__system_vendor__ CONTEXT_TEAM) & pure Full Admin (0 entry_create/entry_own),
      // plus rejected scopes (CONTEXT_DEPARTMENT, inactive team, __system_vendor__)
      const privAll = await seedAccount("pr49.priv.all.3c", "PR49 Priv ALL");
      const privOwn = await seedAccount("pr49.priv.own.3c", "PR49 Priv OWN");
      const privTeam = await seedAccount("pr49.priv.team.3c", "PR49 Priv TEAM_A");
      const pureFullAdmin = await seedAccount("pr49.pure.admin.3c", "PR49 Pure Full Admin");
      const privDept = await seedAccount("pr49.priv.dept.3c", "PR49 Priv Dept");
      const privInact = await seedAccount("pr49.priv.inact.3c", "PR49 Priv Inactive Team");
      const privSysVen = await seedAccount("pr49.priv.sysven.3c", "PR49 Priv System Vendor");

      const inactTeamId = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'team_3c_inact', 'Đội 3C Inactive', false, 1)",
        [inactTeamId],
      );
      const { rows: [sysVenRow] } = await setup.query(
        "select public.direct_entry_system_vendor_team_id() as team_id",
      );
      assert.ok(sysVenRow?.team_id, "__system_vendor__ team id must exist");

      await setup.query(`
        create or replace function public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id uuid)
        returns jsonb
        language sql
        stable
        security definer
        set search_path = pg_catalog, public
        as $function$
          select case
            when not exists (
              select 1 from public.direct_entry_app_users u
               where u.app_user_id = p_app_user_id and u.enabled and coalesce(u.authz_managed, false)
            ) then '[]'::jsonb
            when p_app_user_id = '${privAll.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"ALL","scope_id":null}]'::jsonb
            when p_app_user_id = '${privOwn.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"OWN","scope_id":null}]'::jsonb
            when p_app_user_id = '${privTeam.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${TEAM_A}"}]'::jsonb
            when p_app_user_id = '${pureFullAdmin.app}'::uuid then
              '[{"capability":"entry_admin","scope_kind":"ALL","scope_id":null},{"capability":"recruiter_master_manage","scope_kind":"ALL","scope_id":null},{"capability":"team_master_manage","scope_kind":"ALL","scope_id":null}]'::jsonb
            when p_app_user_id = '${privDept.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_DEPARTMENT","scope_id":"${deptByKey.RECRUITMENT}"}]'::jsonb
            when p_app_user_id = '${privInact.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${inactTeamId}"}]'::jsonb
            when p_app_user_id = '${privSysVen.app}'::uuid then
              '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${sysVenRow.team_id}"}]'::jsonb
            else '[]'::jsonb
          end
        $function$
      `);

      await assertCatalogReadable(privAll, [], "pure entry_privileged_edit ALL");
      await assertCatalogReadable(privOwn, [], "pure entry_privileged_edit OWN");
      await assertCatalogReadable(privTeam, [], "pure entry_privileged_edit active CONTEXT_TEAM");
      await assertCatalogReadable(pureFullAdmin, [PRJ_1, prj2], "pure Full Admin");

      await assertCatalogDenied(privDept, "CONTEXT_DEPARTMENT entry_privileged_edit");
      await assertCatalogDenied(privInact, "inactive team CONTEXT_TEAM entry_privileged_edit");
      await assertCatalogDenied(privSysVen, "__system_vendor__ CONTEXT_TEAM entry_privileged_edit");

      // Hypothetical authz_managed=false with full legacy grants (incl. entry_privileged_edit) MUST stay fail-closed 42501
      const legacyOnly = await seedAccount("hypo.unmanaged.3c", "Hypothetical Unmanaged", { authzManaged: false, enabled: true });
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'all', null, '2026-01-01', true)`,
        [legacyOnly.app],
      );
      for (const cap of ["entry_admin", "entry_create", "entry_privileged_edit", "recruiter_master_manage", "team_master_manage", "report_review"]) {
        await setup.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2026-01-01', true)`,
          [legacyOnly.app, cap],
        );
      }
      const { rows: [eff] } = await setup.query(
        "select public.direct_entry_authz__internal_resolve_effective_grants($1::uuid) as g",
        [legacyOnly.app],
      );
      assert.deepEqual(eff.g, [], "Hypothetical authz_managed=false must resolve [] post-3C");

      await assert.rejects(
        () => serviceRpc("direct_entry_resolve_actor_context", [legacyOnly.auth], ["uuid"]),
        (err) => err?.code === "42501",
      );

      await assertCatalogDenied(legacyOnly, "hypothetical authz_managed=false");

      const bootErr = await tryServiceRpc("direct_entry_catalog_bootstrap_plan", [legacyOnly.auth, legacyOnly.app], ["uuid", "uuid"]);
      assert.equal(bootErr.ok, false);
      assert.equal(bootErr.code, "42501");
    } finally {
      await rollbackOuterTx();
    }
  });

  it("4. Full-row bit-for-bit immutability of ALL 3 legacy tables across group, account/entity disable, PM, and TL (incl. pre-3B TL replace/revoke)", async () => {
    // Seed additional rich historical/cancellation/future legacy rows so all 3 tables have diverse non-empty rows
    await setup.query("begin; set local direct_entry.team_leader_marker = 'on'");
    await setup.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
       values ($1::uuid, 'payment_view', $2::date, $3::date, false, false),
              ($1::uuid, 'payment_edit', $3::date, $3::date, false, false),
              ($1::uuid, 'pii_export', $4::date, null, false, false)`,
      [HR_OP.app, yesterdayVn, todayStr, tomorrowStr],
    );
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable)
       values ($1::uuid, 'team', $2::uuid, $3::date, $4::date, false, false),
              ($1::uuid, 'team', $2::uuid, $4::date, $4::date, false, false),
              ($1::uuid, 'team', $2::uuid, $5::date, null, false, false)`,
      [HR_OP.app, TEAM_B, yesterdayVn, todayStr, tomorrowStr],
    );
    await setup.query("commit");

    const beforeSnap = await captureFullLegacyTableSnapshot(setup);
    assert.ok(beforeSnap.capRows.length >= 10);
    assert.ok(beforeSnap.scopeRows.length >= 5);
    assert.equal(beforeSnap.bridgeRows.length, 4, "Pre-3B TL must contribute 4 non-empty bridge rows");

    await beginOuterTx();
    try {
      // 4a. Group assign -> update -> remove
      const mem = await apiAssignGroup(HR_OP.app, GRP_CATALOG_ONLY, "Immutability test assign group");
      const { rows: [grpRow] } = await setup.query(
        "select version from public.authz_user_groups where group_id = $1::uuid",
        [GRP_CATALOG_ONLY],
      );
      const updKey = nextUuid();
      await serviceRpc(
        "direct_entry_authz_update_group_admin",
        [
          OWNER.auth, OWNER.app, GRP_CATALOG_ONLY, grpRow.version, "Nhóm Danh mục 3C Updated",
          "Updated post-3C", deptByKey.ACCOUNTING, null, true, ["catalog_master_manage", "audit_view"],
          JSON.stringify([]), "Immutability test update group", updKey, sha256(updKey),
        ],
        ["uuid", "uuid", "uuid", "integer", "text", "text", "uuid", "uuid", "boolean", "text[]", "jsonb", "text", "uuid", "text"],
      );
      await apiRemoveGroup(HR_OP.app, mem.membership_id, "Immutability test remove group");

      // 4b. Account disable -> enable (including PRE_3B_TL who has legacy + bridge rows!)
      await apiToggleAccount(PRE_3B_TL.app, "disable", "Immutability disable pre-3B TL");
      await apiToggleAccount(PRE_3B_TL.app, "enable", "Immutability enable pre-3B TL");
      await apiToggleAccount(LOCK_KEEP.app, "disable", "Immutability disable LOCK_KEEP");
      await apiToggleAccount(LOCK_KEEP.app, "enable", "Immutability enable LOCK_KEEP");

      // 4c. Entity disables (fires direct_entry_clear_authority_on_disable() on teams, recruiters, projects, vendors)
      const entTeam = nextUuid();
      const entRec = nextUuid();
      const entVendor = "vnd-3c-disable-probe";
      const entProj = "prj-3c-disable-probe";
      await setup.query("insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'team_dis_3c', 'Disable Team', true, 1)", [entTeam]);
      await setup.query("insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version) values ($1::uuid, 'Disable Rec', 'dis.rec.3c', 'STAFF', true, 1)", [entRec]);
      await setup.query("insert into public.vendors (vendor_id, display_name, active, version) values ($1, 'Disable Vendor', true, 1)", [entVendor]);
      await setup.query("insert into public.direct_entry_projects (project_id, display_name, active, version) values ($1, 'Disable Prj', true, 1)", [entProj]);
      await setup.query("update public.teams set active = false where team_id = $1::uuid", [entTeam]);
      await setup.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [entRec]);
      await setup.query("update public.vendors set active = false where vendor_id = $1", [entVendor]);
      await setup.query("update public.direct_entry_projects set active = false where project_id = $1", [entProj]);

      // 4d. PM assign -> unassign
      const pmAsg = await serviceRpc(
        "direct_entry_assign_project_manager",
        [OWNER.auth, OWNER.app, PRJ_1, UPLOADER.rec, todayStr, 3, "Immutability PM assign", nextKey("imm_pm_a")],
        ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
      );
      const pmAsgObj = pmAsg.assignment ?? pmAsg;
      await serviceRpc(
        "direct_entry_unassign_project_manager",
        [OWNER.auth, OWNER.app, pmAsgObj.assignment_id, pmAsgObj.version, 4, "Immutability PM unassign", nextKey("imm_pm_u")],
        ["uuid", "uuid", "uuid", "integer", "integer", "text", "text"],
      );

      // 4e. TL designate -> replace -> same-day revoke (v_restore) -> revoke on TEAM_A
      await setBusinessDate(setup, yesterdayVn);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, TL_POST3B.app, yesterdayVn, await getTeamVersion(TEAM_A), "Imm TL designate", nextKey("imm_tl_d")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await setBusinessDate(setup, todayStr);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, TL_REPLACE.app, todayStr, await getTeamVersion(TEAM_A), "Imm TL replace", nextKey("imm_tl_r")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, await getTeamVersion(TEAM_A), "Imm TL v_restore", nextKey("imm_tl_vr")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, await getTeamVersion(TEAM_A), "Imm TL revoke", nextKey("imm_tl_rv")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      // 4f. CRITICAL: Replace AND Revoke PRE_3B_TL (who originally had scope('team') + cap('team_manager_assign') + 4 wr_bridge rows!)
      // Proves #48's old UPDATE close/restore writes on legacy tables are GONE and legacy tables stay bit-for-bit identical!
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_PRE_3B, PRE_3B_REPLACE.app, todayStr, await getTeamVersion(TEAM_PRE_3B), "Imm replace PRE_3B_TL", nextKey("imm_pre_rep")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      // Same-day revoke of PRE_3B_REPLACE triggers v_restore of PRE_3B_TL!
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_PRE_3B, todayStr, await getTeamVersion(TEAM_PRE_3B), "Imm v_restore PRE_3B_TL", nextKey("imm_pre_vr")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      // Final revoke of PRE_3B_TL
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_PRE_3B, todayStr, await getTeamVersion(TEAM_PRE_3B), "Imm revoke PRE_3B_TL", nextKey("imm_pre_rv")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      const afterSnap = await captureFullLegacyTableSnapshot(setup);
      assert.deepEqual(afterSnap.fingerprints, beforeSnap.fingerprints, "Canonical row_count + sha256 of ALL 3 legacy tables must be 100% immutable");
      assert.deepEqual(afterSnap.capRows, beforeSnap.capRows, "Full SELECT * of direct_entry_capability_grants must be bit-for-bit identical");
      assert.deepEqual(afterSnap.scopeRows, beforeSnap.scopeRows, "Full SELECT * of direct_entry_scope_grants must be bit-for-bit identical");
      assert.deepEqual(afterSnap.bridgeRows, beforeSnap.bridgeRows, "Full SELECT * of work_report_team_leader_capability_grants must be bit-for-bit identical");
    } finally {
      await rollbackOuterTx();
      await setBusinessDate(setup, todayStr);
    }
  });

  it("5. #47 historical Leave/Explanation routing, #42 blocks, resolveOperator & REPAIR_ACTOR_SQL, and PG18 concurrency (0 40P01)", async () => {
    // 5a. #47 historical Leave/Explanation routing across D -> D+1 (designate/replace vs transition-only)
    const { rows: [clockDates] } = await observer.query(
      "select (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text as day_d",
      [todayStr],
    );
    const dayD = clockDates.day_d;
    const dayDPlus1 = addDaysIso(dayD, 1);

    await beginOuterTx();
    try {
      const T_CLK = nextUuid();
      const T_TRANS = nextUuid();
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, 'team_3c_clk', 'Team 3C Clock', true, 1),
                ($2::uuid, 'team_3c_trans', 'Team 3C Trans', true, 1)`,
        [T_CLK, T_TRANS],
      );
      const lClk = await seedRecruiterPerson("lclk.3c", "Leader Clock 3C", T_CLK, deptByKey.RECRUITMENT, {
        position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });
      const mClk = await seedRecruiterPerson("mclk.3c", "Member Clock 3C", T_CLK, deptByKey.RECRUITMENT, {
        position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });
      const lTrans = await seedRecruiterPerson("ltrans.3c", "Leader Trans 3C", T_TRANS, deptByKey.RECRUITMENT, {
        position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });
      const mTrans = await seedRecruiterPerson("mtrans.3c", "Member Trans 3C", T_TRANS, deptByKey.RECRUITMENT, {
        position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });

      // Designate on day D, revoke on day D+1
      await setBusinessDate(setup, dayD);
      const desClk = await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, T_CLK, lClk.app, dayD, 1, "47 designate at D", nextKey("47_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      await setBusinessDate(setup, dayDPlus1);
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, T_CLK, dayDPlus1, 2, "47 revoke at D+1", nextKey("47_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );

      // Historical D -> TEAM_LEADER; current D+1 -> ADMIN_BOD_FALLBACK
      const { rows: [clkEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff_d,
                public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $3::date) as eff_d1,
                public.leave_management__internal_resolve_routing($4::uuid, $2::date) as route_d,
                public.leave_management__internal_resolve_routing($4::uuid, $3::date) as route_d1`,
        [desClk.assignment_id, dayD, dayDPlus1, mClk.app],
      );
      assert.equal(clkEval.eff_d, true);
      assert.equal(clkEval.eff_d1, false);
      assert.equal(clkEval.route_d.route_kind, "TEAM_LEADER");
      assert.equal(clkEval.route_d.primary_approver_app_user_id, lClk.app);
      assert.equal(clkEval.route_d1.route_kind, "ADMIN_BOD_FALLBACK");
      assert.equal(clkEval.route_d1.primary_approver_app_user_id, null);

      const repMonthD = await serviceRpc(
        "leave_management_monthly_report",
        [OWNER.auth, OWNER.app, dayD.slice(0, 7), null, mClk.name, 50, 0],
        ["uuid", "uuid", "text", "text", "text", "integer", "integer"],
      );
      const rowD = repMonthD.rows.find((r) => r.app_user_id === mClk.app);
      assert.equal(rowD.routing.route_kind, "TEAM_LEADER");
      assert.equal(rowD.routing.primary_approver_app_user_id, lClk.app);

      // Attendance Explanation routing across yesterdayVn (TL active) vs todayStr (TL revoked)
      const T_EXP_CLK = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'team_3c_exp_clk', 'Team 3C Exp Clock', true, 1)",
        [T_EXP_CLK],
      );
      const lExp = await seedRecruiterPerson("lexp.3c", "Leader Exp 3C", T_EXP_CLK, deptByKey.RECRUITMENT, {
        position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });
      const mExp = await seedRecruiterPerson("mexp.3c", "Member Exp 3C", T_EXP_CLK, deptByKey.RECRUITMENT, {
        position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS, withLeaveProfile: true,
      });
      await setBusinessDate(setup, yesterdayVn);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, T_EXP_CLK, lExp.app, yesterdayVn, 1, "Exp designate yesterday", nextKey("exp_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const expAtD = projectSubmitAttendanceExplanationResult(
        await serviceRpc("attendance_submit_explanation", [
          mExp.auth, mExp.app, yesterdayVn, "SLOT_1", "Exp at yesterday", nextUuid(), sha256("exp_d"),
        ]),
      );
      assert.equal(expAtD.explanation.route_kind, "TEAM_LEADER");
      assert.equal(expAtD.explanation.primary_approver.app_user_id, lExp.app);

      await setBusinessDate(setup, todayStr);
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, T_EXP_CLK, todayStr, 2, "Exp revoke today", nextKey("exp_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const expAtD1 = projectSubmitAttendanceExplanationResult(
        await serviceRpc("attendance_submit_explanation", [
          mExp.auth, mExp.app, yesterdayVn, "SLOT_2", "Exp at today", nextUuid(), sha256("exp_d1"),
        ]),
      );
      assert.equal(expAtD1.explanation.route_kind, "ADMIN_BOD_FALLBACK");

      // Closed 'transition'-only provenance (evaluated at clock = dayDPlus1 so dayD is historical) -> #47 keeps ADMIN_BOD_FALLBACK & false
      await setBusinessDate(setup, dayDPlus1);
      const transAsgId = nextUuid();
      await setup.query("set local direct_entry.team_leader_marker = 'on'");
      await setup.query(
        `insert into public.direct_entry_team_leader_assignments (
           assignment_id, team_id, leader_app_user_id, leader_recruiter_id,
           valid_from, valid_to, is_current, suspended_by_account_disable
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, false, false)`,
        [transAsgId, T_TRANS, lTrans.app, lTrans.rec, dayD, dayDPlus1],
      );
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable)
         values ($1::uuid, 'team', $2::uuid, $3::date, $4::date, false, false)`,
        [lTrans.app, T_TRANS, dayD, dayDPlus1],
      );
      await setup.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
         values ($1::uuid, 'team_manager_assign', $2::date, $3::date, false, false)`,
        [lTrans.app, dayD, dayDPlus1],
      );
      await setup.query(
        `insert into public.direct_entry_team_leader_revisions (
           team_id, version, actor_user_id, action, before_snapshot, after_snapshot
         ) values ($1::uuid, 1, $2::uuid, 'transition', null, $3::jsonb)`,
        [
          T_TRANS,
          OWNER.app,
          JSON.stringify({
            team_id: T_TRANS,
            leader_app_user_id: lTrans.app,
            leader_recruiter_id: lTrans.rec,
            valid_from: dayD,
            valid_to: dayDPlus1,
            version: 1,
            change: "transition",
          }),
        ],
      );
      const { rows: [transEval] } = await setup.query(
        `select public.direct_entry__internal_team_leader_assignment_effective($1::uuid, $2::date) as eff_d,
                public.leave_management__internal_resolve_routing($3::uuid, $2::date) as route_d`,
        [transAsgId, dayD, mTrans.app],
      );
      assert.equal(transEval.eff_d, false, "Closed transition-only assignment must remain false at D post-3C");
      assert.equal(transEval.route_d.route_kind, "ADMIN_BOD_FALLBACK");

      // 5b. #42 blocks (active & suspended TL -> PT409, succeeds after revoke)
      await setBusinessDate(setup, todayStr);
      await serviceRpc(
        "direct_entry_designate_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, TL_POST3B.app, todayStr, await getTeamVersion(TEAM_A), "42 probe", nextKey("42_des")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const rv = await getRecruiterVersion(TL_POST3B.rec);
      const mvAct = await tryServiceRpc(
        "direct_entry_move_team_membership",
        [OWNER.auth, OWNER.app, TL_POST3B.rec, TEAM_B, todayStr, rv, "42 move active", nextKey("42_m1")],
        ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(mvAct.code, "PT409");
      assert.equal(mvAct.message, EXPECTED_TL_GUARD_MSG);

      await apiToggleAccount(TL_POST3B.app, "disable", "42 suspend TL");
      const unSusp = await tryServiceRpc(
        "direct_entry_unassign_team_membership",
        [OWNER.auth, OWNER.app, TL_POST3B.rec, todayStr, rv, "42 unassign suspended", nextKey("42_u1")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(unSusp.code, "PT409");
      assert.equal(unSusp.message, EXPECTED_TL_GUARD_MSG);

      await apiToggleAccount(TL_POST3B.app, "enable", "42 enable TL");
      await serviceRpc(
        "direct_entry_revoke_team_leader",
        [OWNER.auth, OWNER.app, TEAM_A, todayStr, await getTeamVersion(TEAM_A), "42 revoke TL", nextKey("42_rev")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      const unOk = await serviceRpc(
        "direct_entry_unassign_team_membership",
        [OWNER.auth, OWNER.app, TL_POST3B.rec, todayStr, rv, "42 unassign after revoke", nextKey("42_u_ok")],
        ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
      );
      assert.equal(unOk.team_id, TEAM_A);

      // 5c. Ops scripts against real post-3C PG18: resolveOperator & REPAIR_ACTOR_SQL
      const opOwner = await resolveOperator(setup, OWNER.email);
      assert.equal(opOwner.ok, true);
      assert.equal(opOwner.operator.app_user_id, OWNER.app);

      const opHr = await resolveOperator(setup, HR_OP.app);
      assert.equal(opHr.ok, false);
      assert.equal(opHr.code, "OPERATOR_NOT_AUTHORIZED");

      const teamScopeUser = await seedAccount("team.scope.3c", "Team Scope 3C");
      await apiAssignGroup(teamScopeUser.app, GRP_TEAM_SCOPE, "Assign team-scoped entry_team");
      const opTeamScope = await resolveOperator(setup, teamScopeUser.app);
      assert.equal(opTeamScope.ok, false, "Team-scoped account without entry_admin+ALL must be rejected by resolveOperator");
      assert.equal(opTeamScope.code, "OPERATOR_NOT_AUTHORIZED");

      const opUploader = await resolveOperator(setup, UPLOADER.app);
      assert.equal(opUploader.ok, false);
      assert.equal(opUploader.code, "OPERATOR_NOT_AUTHORIZED");

      const disabledAdmin = await seedAccount("dis.admin.3c", "Disabled Admin 3C");
      await apiAssignGroup(disabledAdmin.app, grpByCode.SYSTEM_ADMIN, "Assign SYSTEM_ADMIN");
      await apiToggleAccount(disabledAdmin.app, "disable", "Disable admin for ops probe");
      const opDisabled = await resolveOperator(setup, disabledAdmin.app);
      assert.equal(opDisabled.ok, false);
      assert.equal(opDisabled.code, "OPERATOR_NOT_FOUND");

      const { rows: [repOwner] } = await setup.query(REPAIR_ACTOR_SQL, [OWNER.app]);
      assert.equal(repOwner.app_user_id, OWNER.app);
      assert.equal(repOwner.capability, "recruiter_master_manage");

      const { rows: [repHr] } = await setup.query(REPAIR_ACTOR_SQL, [HR_OP.app]);
      assert.equal(repHr.app_user_id, HR_OP.app);
      assert.equal(repHr.capability, "recruiter_master_manage");

      const { rows: [repUploader] } = await setup.query(REPAIR_ACTOR_SQL, [UPLOADER.app]);
      assert.equal(repUploader.capability, null);

      const { rows: repDisabled } = await setup.query(REPAIR_ACTOR_SQL, [disabledAdmin.app]);
      assert.equal(repDisabled.length, 0);
    } finally {
      await rollbackOuterTx();
      await setBusinessDate(setup, todayStr);
    }

    // 5d. Real PG18 Barrier Concurrency (committed transactions across w1 & w2, 0 40P01)
    const ASSIGN_GROUP_SQL =
      "select public.direct_entry_authz_assign_group_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6, $7::uuid, $8) as data";
    const DISABLE_SQL =
      "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::integer, $5, $6) as data";
    const DESIGNATE_SQL =
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7, $8) as data";
    const MOVE_SQL =
      "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7, $8) as data";

    // Barrier 1: assign_group_member vs disable_app_user (both orders, genuine Lock wait, 0 40P01)
    const cg1 = await seedAccount("conc.grp1.3c", "Conc Group 1");
    await beginServiceTx(w1);
    const idempG1 = nextUuid();
    await w1.query(ASSIGN_GROUP_SQL, [OWNER.auth, OWNER.app, cg1.app, GRP_CATALOG_ONLY, 1, "Barrier grp first", idempG1, sha256(idempG1)]);
    await beginServiceTx(w2);
    const pDisAfterGrp = settleInTx(
      w2,
      w2.query(DISABLE_SQL, [OWNER.auth, OWNER.app, cg1.app, 1, "Barrier dis after grp", nextKey("c_d_g1")]),
    );
    const waitDg1 = await waitUntilBlocked(observer, "wp10-7-3c-w2");
    assert.equal(waitDg1.wait_event_type, "Lock");
    await w1.query("commit");
    const rDg1 = await pDisAfterGrp;
    assertNotDeadlock(rDg1, "Disable after assign_group");
    assert.equal(rDg1.status, "rejected");
    assert.equal(rDg1.reason?.code, "PT409");

    const cg2 = await seedAccount("conc.grp2.3c", "Conc Group 2");
    await beginServiceTx(w1);
    await w1.query(DISABLE_SQL, [OWNER.auth, OWNER.app, cg2.app, 1, "Barrier dis first", nextKey("c_dis_g2")]);
    await beginServiceTx(w2);
    const idempG2 = nextUuid();
    const pGrpAfterDis = settleInTx(
      w2,
      w2.query(ASSIGN_GROUP_SQL, [OWNER.auth, OWNER.app, cg2.app, GRP_CATALOG_ONLY, 1, "Barrier grp after dis", idempG2, sha256(idempG2)]),
    );
    const waitGd2 = await waitUntilBlocked(observer, "wp10-7-3c-w2");
    assert.equal(waitGd2.wait_event_type, "Lock");
    await w1.query("commit");
    const rGd2 = await pGrpAfterDis;
    assertNotDeadlock(rGd2, "Assign group after disable");
    assert.equal(rGd2.status, "rejected");

    // Barrier 2: designate_team_leader vs disable_app_user (designate first -> disable suspends cleanly, 0 40P01)
    const T_CONC_1 = nextUuid();
    const T_CONC_2 = nextUuid();
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'team_3c_conc1', 'Team 3C Conc 1', true, 1),
              ($2::uuid, 'team_3c_conc2', 'Team 3C Conc 2', true, 1)`,
      [T_CONC_1, T_CONC_2],
    );
    const ct1 = await seedRecruiterPerson("conc.tl1.3c", "Conc TL 1", T_CONC_1, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    const ct1Ver = (await getAccountRow(ct1.app)).version;

    await beginServiceTx(w1);
    await w1.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_CONC_1, ct1.app, todayStr, 1, "Conc des before dis", nextKey("c_des1")]);
    await beginServiceTx(w2);
    const pDisAfterDes = settleInTx(
      w2,
      w2.query(DISABLE_SQL, [OWNER.auth, OWNER.app, ct1.app, ct1Ver, "Conc dis after des", nextKey("c_dis_des")]),
    );
    const waitDad = await waitUntilBlocked(observer, "wp10-7-3c-w2");
    assert.equal(waitDad.wait_event_type, "Lock");
    await w1.query("commit");
    const rDad = await pDisAfterDes;
    assertNotDeadlock(rDad, "Disable after designate");
    assert.equal(rDad.status, "fulfilled");

    // Barrier 3: designate_team_leader vs move_team_membership (designate first -> move PT409, 0 40P01)
    const ct2 = await seedRecruiterPerson("conc.tl2.3c", "Conc TL 2", T_CONC_2, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    await beginServiceTx(w1);
    await w1.query(DESIGNATE_SQL, [OWNER.auth, OWNER.app, T_CONC_2, ct2.app, todayStr, 1, "Conc des before move", nextKey("c_des2")]);
    await beginServiceTx(w2);
    const pMoveAfterDes = settleInTx(
      w2,
      w2.query(MOVE_SQL, [OWNER.auth, OWNER.app, ct2.rec, T_CONC_1, todayStr, 1, "Conc move after des", nextKey("c_mv2")]),
    );
    const waitMad = await waitUntilBlocked(observer, "wp10-7-3c-w2");
    assert.equal(waitMad.wait_event_type, "Lock");
    await w1.query("commit");
    const rMad = await pMoveAfterDes;
    assertNotDeadlock(rMad, "Move after designate");
    assert.equal(rMad.status, "rejected");
    assert.equal(rMad.reason?.code, "PT409");
    assert.equal(rMad.reason?.message, EXPECTED_TL_GUARD_MSG);

    // Barrier 4: Promise.all concurrent designate race (0 40P01, 1 winner, 1 PT409)
    for (let trial = 0; trial < 3; trial += 1) {
      const tRace = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, $2, $3, true, 1)",
        [tRace, `team_3c_race_${trial}`, `Team 3C Race ${trial}`],
      );
      const rA = await seedRecruiterPerson(`race3c.a${trial}`, `Race 3C A${trial}`, tRace, deptByKey.RECRUITMENT, {
        position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
      });
      const rB = await seedRecruiterPerson(`race3c.b${trial}`, `Race 3C B${trial}`, tRace, deptByKey.RECRUITMENT, {
        position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
      });
      const [res1, res2] = await Promise.all([
        tryServiceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, tRace, rA.app, todayStr, 1, `Race 1 ${trial}`, nextKey(`r1_${trial}`)], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"], w1),
        tryServiceRpc("direct_entry_designate_team_leader", [OWNER.auth, OWNER.app, tRace, rB.app, todayStr, 1, `Race 2 ${trial}`, nextKey(`r2_${trial}`)], ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"], w2),
      ]);
      assert.notEqual(res1.code, "40P01");
      assert.notEqual(res2.code, "40P01");
      assert.equal(Number(res1.ok) + Number(res2.ok), 1, `Trial ${trial}: exactly 1 designate must win`);
      assert.equal((res1.ok ? res2 : res1).code, "PT409");
    }
  });
});
