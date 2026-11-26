/**
 * WP10-2 — Immediate-Effective Organizational Assignment Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test`) against an isolated PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 * Forces `SET LOCAL ROLE service_role`, `deadlock_timeout = '100ms'`, `statement_timeout = '8s'`, and verifies
 * genuine lock-wait via BOTH `pg_stat_activity.wait_event_type = 'Lock'` AND `pg_locks.granted = false`.
 *
 * Covers (all with ZERO `40P01` deadlocks):
 *   - C0: `direct_entry_account_operation_create_personnel` vs `org_department_transfer_person_member_admin` (`CUSTOM_OPS`), both orders
 *   - C1: `direct_entry_assign_team_membership` vs `direct_entry_account_operation_link_recruiter` (on MARKETING-linked account), both orders
 *   - C2: `org_department_transfer_person_member_admin` (`ACCOUNTING`) vs `direct_entry_assign_team_membership`, both orders (post-lock cross-domain guard)
 *   - C3: `org_department_transfer_person_member_admin` (`CUSTOM_OPS`, `system_key IS NULL`) & `org_department_update_person_admin('INACTIVE')` vs `direct_entry_assign_team_membership`, both orders
 *   - C4 (`F-01`): Suspended verified link (`verified=true, is_current=false, suspended_by_account_disable=true` via API `disable`)
 *                 — `org_department_link_account_person_admin` vs `direct_entry_assign_team_membership` on same `recruiter_id`, both orders
 *   - C5a (`F-03`, pure API): Same-day `revoke` (`v_old = B`, `v_previous = A` with valid `G1`) vs `transfer(pA, ACCOUNTING)` (both orders per T0 note)
 *                            and mutual lock-wait `revoke(B)` vs `unassign_team_membership(recA)` (both orders)
 *   - C5b (`F-03`): Pure API `revoke(B)` vs `transfer(pA, ACCOUNTING)` after `unassign(recA)` (both orders),
 *                   plus a clearly labeled defensive drifted-Org lock-wait proof where `A` still holds `G1` while `pA` turns `INACTIVE`.
 *   - P2 (Tier U advisory-before-row lock ordering, `A.app < B.app`, Admin A unmapped + legacy unmapped Recruiter B):
 *                   Barrier 1 (`designate_team_leader(A->B)` vs `create_person_admin(A, recB)`),
 *                   Barrier 2 (held `advisory(B)` + `A FOR UPDATE NOWAIT` proves no reverse row lock + `PT409 RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT`),
 *                   and Disable/Enable Tier-U parity (`direct_entry_disable_app_user` + `direct_entry_enable_app_user`).
 *   - F-01 (Round 2: post-Tier-2b `direct_entry_idempotency_begin`, pure actor Tier 2b `FOR SHARE`, zero premature `FOR KEY SHARE`):
 *                   1) T1A `link_recruiter` vs `designate_team_leader` repro (`A` `NOWAIT` succeeds on `P_X` wait, `0` `40P01`, `w1` rolls back cleanly),
 *                   2) Post-lock `NOWAIT` on `actor` for `create_personnel`, `assign_team_membership`, `move_team_membership`,
 *                   3) Active G1+G2 TL Admin `actor` operating on `MARKETING` & `RECRUITMENT` targets without G1/G2/G3 self-block,
 *                   4) Concurrent same-key single write + different-payload rejection (`22023`) + cross-midnight replay across all 4 RPCs.
 *   - P2-end-accounting (`org_department_end_accounting_member` Tier-U ascending row lock `[actor, target]` vs `create_personnel`, `A < B`):
 *                   1) End-first barrier (`wH` holds `membership_B`, `w1` ends `B` as `A`, `w2` creates personnel for `A` as `B`) -> both succeed (`0` `40P01`), replay & OCC intact,
 *                   2) Create-personnel-first barrier (`wH` holds `B2`, `w2` creates personnel for `A2` as `B2`, `w1` ends `B2` as `A2`) -> both succeed (`0` `40P01`),
 *                   3) Same-account dedupe (`actor = target = C` ends own Accounting membership cleanly).
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
  computeAssignAccountingMemberFingerprint,
  computeCreateDepartmentFingerprint,
  computeEndAccountingMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUpdatePersonFingerprint,
} from "../src/lib/organization/person-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP10_2_MIGRATION_NAME = "20261124120000_wp10_2_immediate_org_assignment_guards.sql";

const OWNER = {
  auth: "20200000-0000-4000-8000-00000000a001",
  app: "20200000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-2 PG18",
};
const LUANPT = {
  auth: "20200000-0000-4000-8000-00000000a002",
  app: "20200000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT PG18",
};
const LIENVU = {
  auth: "20200000-0000-4000-8000-00000000a003",
  app: "20200000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu PG18",
};
const NGATTT = {
  auth: "20200000-0000-4000-8000-00000000a004",
  app: "20200000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT PG18",
};

const TEAM_A = "20220000-0000-4000-8000-000000000001";
const TEAM_B = "20220000-0000-4000-8000-000000000002";

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `20230000-0000-4000-8000-${hex}`;
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

async function serviceQuery(client, sql, params = []) {
  await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function beginServiceTx(client) {
  await client.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'; set local role service_role");
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

async function setBusinessDate(setup, isoDate) {
  await setup.query(`
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

async function seedLegacyAdmin(client, user) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed)
     values ($1::uuid, $2::uuid, $3, true, false)`,
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

async function seedPlainUnlinkedHrpRecruiter(client, codePrefix, displayName) {
  const recruiterId = nextUuid();
  await client.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
     values ($1::uuid, $2, $3, 'STAFF', true, 1)`,
    [recruiterId, displayName, codePrefix],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
     values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
    [recruiterId],
  );
  return recruiterId;
}

const CREATE_DEPT_SQL =
  "select public.org_department_create_department_admin($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7) as data";
const CREATE_PERSON_SQL =
  "select public.org_department_create_person_admin($1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7::uuid, $8::int, $9::uuid, $10, $11::uuid, $12) as data";
const UPDATE_PERSON_SQL =
  "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7::date, $8, $9, $10::uuid, $11) as data";
const TRANSFER_MEMBER_SQL =
  "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data";
const LINK_ACCOUNT_PERSON_SQL =
  "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::int, $7::uuid, $8, $9::uuid, $10) as data";
const CREATE_PERSONNEL_FROM_ACC_SQL =
  "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7::date, $8, $9) as data";
const LINK_RECRUITER_SQL =
  "select public.direct_entry_account_operation_link_recruiter($1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6::int, $7, $8) as data";
const ASSIGN_TEAM_SQL =
  "select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const MOVE_TEAM_SQL =
  "select public.direct_entry_move_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const UNASSIGN_TEAM_SQL =
  "select public.direct_entry_unassign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7) as data";
const DESIGNATE_TL_SQL =
  "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const REVOKE_TL_SQL =
  "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7) as data";
const DISABLE_USER_SQL =
  "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const ENABLE_USER_SQL =
  "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";
const ASSIGN_GROUP_MEMBER_SQL =
  "select public.direct_entry_authz_assign_group_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const ASSIGN_ACCOUNTING_SQL =
  "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6::text, $7::uuid, $8::text) as data";
const END_ACCOUNTING_SQL =
  "select public.org_department_end_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6::text, $7::uuid, $8::text) as data";

test("WP10-2 Real PG18 Concurrency: C0-C5b + P2 Tier-U barriers + F-01 idempotency lock-order & cross-midnight replay, 0 40P01", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required for WP10-2 PG18 concurrency suite");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-2-pg18-"));
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
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "wp10-2-setup");
    const observer = await connect(port, "wp10-2-observer");
    const wH = await connect(port, "wp10-2-wh");
    const w1 = await connect(port, "wp10-2-w1");
    const w2 = await connect(port, "wp10-2-w2");
    clients.push(setup, observer, wH, w1, w2);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(files.includes(WP10_2_MIGRATION_NAME), "WP10-2 migration must exist");

    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
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

    for (let i = groupsIdx; i < files.length; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }
    await setBusinessDate(setup, "2026-11-24");

    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'WP10_PG_A', 'PG Team A', true, 1),
              ($2::uuid, 'WP10_PG_B', 'PG Team B', true, 1)`,
      [TEAM_A, TEAM_B],
    );

    const { rows: deptRows } = await setup.query(
      "select department_id, system_key from public.organization_departments where system_key is not null",
    );
    const deptByKey = Object.fromEntries(deptRows.map((d) => [d.system_key, d.department_id]));
    const customDeptId = (
      await serviceQuery(setup, CREATE_DEPT_SQL, [
        OWNER.auth,
        OWNER.app,
        "CUSTOM_OPS",
        "Custom Ops Unit",
        "Create custom dept for concurrency",
        nextUuid(),
        computeCreateDepartmentFingerprint({
          actor_app_user_id: OWNER.app,
          code: "CUSTOM_OPS",
          name: "Custom Ops Unit",
          reason: "Create custom dept for concurrency",
        }),
      ])
    ).rows[0].data.department.department_id;

    async function makeActiveRecruitmentAccountPerson(tag) {
      const acc = await seedPlainAccount(setup, `pg.${tag}`, `User ${tag}`);
      const code = `EMP-${tag.toUpperCase()}`;
      const person = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          code,
          acc.name,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          acc.app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: code,
            full_name: acc.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ])
      ).rows[0].data.person;
      const recruiter = (
        await serviceQuery(setup, CREATE_PERSONNEL_FROM_ACC_SQL, [
          OWNER.auth,
          OWNER.app,
          acc.app,
          person.active_account_link.account_version,
          acc.login,
          "STAFF",
          null,
          `Create recruiter ${tag}`,
          nextUuid(),
        ])
      ).rows[0].data;
      const { rows: [pRefreshed] } = await observer.query(
        "select version from public.organization_persons where person_id = $1::uuid",
        [person.person_id],
      );
      person.version = pRefreshed.version;
      return { acc, person, recruiterId: recruiter.recruiter_id };
    }

    // -------------------------------------------------------------------------
    // C0 (both orders): create_personnel vs transfer_person_member_admin(CUSTOM_OPS)
    // -------------------------------------------------------------------------
    for (const order of ["create_first", "transfer_first"]) {
      const tag = `c0.${order}`;
      const acc = await seedPlainAccount(setup, tag, `C0 ${order}`);
      const code = `EMP-C0-${order.toUpperCase()}`;
      const person = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          code,
          acc.name,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          acc.app,
          1,
          null,
          "C0 setup",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: code,
            full_name: acc.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "C0 setup",
          }),
        ])
      ).rows[0].data.person;

      const transferParams = [
        OWNER.auth,
        OWNER.app,
        person.person_id,
        customDeptId,
        person.version,
        person.active_department.membership_id,
        `C0 ${order} transfer`,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, person.person_id, {
          target_department_ref: customDeptId,
          expected_person_version: person.version,
          expected_current_membership_id: person.active_department.membership_id,
          reason: `C0 ${order} transfer`,
        }),
      ];
      const createPersonnelParams = [
        OWNER.auth,
        OWNER.app,
        acc.app,
        person.active_account_link.account_version,
        acc.login,
        "STAFF",
        null,
        `C0 ${order} create`,
        nextUuid(),
      ];

      await beginServiceTx(w1);
      if (order === "create_first") {
        await w1.query(CREATE_PERSONNEL_FROM_ACC_SQL, createPersonnelParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(TRANSFER_MEMBER_SQL, transferParams));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C0 create_first");
      } else {
        await w1.query(TRANSFER_MEMBER_SQL, transferParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(CREATE_PERSONNEL_FROM_ACC_SQL, createPersonnelParams));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C0 transfer_first");
        assert.equal(r2.status, "fulfilled", "Plain HRP recruiter creation in CUSTOM_OPS allowed");
        const recId = r2.value.rows[0].data.recruiter_id;
        const c0Assign = (await serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, 1, "C0 post check", nextUuid()])).rows[0].data;
        assert.equal(c0Assign.team_id, TEAM_A);
      }
    }

    // -------------------------------------------------------------------------
    // C1 (both orders): assign_team_membership vs link_recruiter on MARKETING Account (cross-dept allowed!)
    // -------------------------------------------------------------------------
    for (const order of ["assign_first", "link_first"]) {
      const recId = await seedPlainUnlinkedHrpRecruiter(setup, `c1.${order}`, `C1 Rec ${order}`);
      const acc = await seedPlainAccount(setup, `c1.${order}`, `C1 User ${order}`);
      const code = `EMP-C1-${order.toUpperCase()}`;
      const pMkt = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          code,
          acc.name,
          "2026-10-01",
          deptByKey.MARKETING,
          acc.app,
          1,
          null,
          "C1 mkt person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: code,
            full_name: acc.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.MARKETING,
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "C1 mkt person",
          }),
        ])
      ).rows[0].data.person;

      await beginServiceTx(w1);
      if (order === "assign_first") {
        await w1.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, 1, "C1 assign", nextUuid()]);
        await beginServiceTx(w2);
        const p2 = settleInTx(
          w2,
          w2.query(LINK_RECRUITER_SQL, [
            OWNER.auth,
            OWNER.app,
            recId,
            1,
            acc.app,
            pMkt.active_account_link.account_version,
            "C1 link mkt",
            nextUuid(),
          ]),
        );
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C1 assign_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.doesNotMatch(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);
        const c1Retry = (
          await serviceQuery(setup, LINK_RECRUITER_SQL, [
            OWNER.auth,
            OWNER.app,
            recId,
            2,
            acc.app,
            pMkt.active_account_link.account_version,
            "C1 retry fresh ver cross-dept",
            nextUuid(),
          ])
        ).rows[0].data;
        assert.equal(c1Retry.recruiter_id, recId);
        const { rows: links } = await observer.query(
          "select count(*)::int as cnt from public.direct_entry_app_user_recruiter_links where recruiter_id = $1::uuid and is_current = true",
          [recId],
        );
        assert.equal(links[0].cnt, 1);
      } else {
        await w1.query(LINK_RECRUITER_SQL, [
          OWNER.auth,
          OWNER.app,
          recId,
          1,
          acc.app,
          pMkt.active_account_link.account_version,
          "C1 link first",
          nextUuid(),
        ]);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, 1, "C1 assign waits", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C1 link_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        const { rows: [recCur] } = await observer.query(
          "select version from public.recruiters where recruiter_id = $1::uuid",
          [recId],
        );
        const c1LinkRetry = (
          await serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, recCur.version, "C1 assign retry after cross-dept link", nextUuid()])
        ).rows[0].data;
        assert.equal(c1LinkRetry.team_id, TEAM_A);
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true",
          [recId],
        );
        assert.equal(teamRows[0].cnt, 1);
      }
    }

    // -------------------------------------------------------------------------
    // C2 (both orders): transfer(ACCOUNTING) vs assign_team_membership (cross-dept allowed, 0 40P01!)
    // -------------------------------------------------------------------------
    for (const order of ["assign_first", "transfer_first"]) {
      const s = await makeActiveRecruitmentAccountPerson(`c2.${order}`);
      const transferParams = [
        OWNER.auth,
        OWNER.app,
        s.person.person_id,
        deptByKey.ACCOUNTING,
        s.person.version,
        s.person.active_department.membership_id,
        `C2 ${order} transfer`,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, s.person.person_id, {
          target_department_ref: deptByKey.ACCOUNTING,
          expected_person_version: s.person.version,
          expected_current_membership_id: s.person.active_department.membership_id,
          reason: `C2 ${order} transfer`,
        }),
      ];
      await beginServiceTx(w1);
      if (order === "assign_first") {
        await w1.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_A, null, 1, "C2 assign", nextUuid()]);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(TRANSFER_MEMBER_SQL, transferParams));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C2 assign_first");
        assert.equal(r2.status, "fulfilled", "Cross-dept transfer to ACCOUNTING succeeds with active G1");
        const { rows: [curMem] } = await observer.query(
          "select department_id from public.organization_person_department_memberships where person_id = $1::uuid and ended_at is null",
          [s.person.person_id],
        );
        assert.equal(curMem.department_id, deptByKey.ACCOUNTING);
      } else {
        await w1.query(TRANSFER_MEMBER_SQL, transferParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_A, null, 1, "C2 assign", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C2 transfer_first");
        assert.equal(r2.status, "fulfilled", "Cross-dept assign_team succeeds after transfer to ACCOUNTING");
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true",
          [s.recruiterId],
        );
        assert.equal(teamRows[0].cnt, 1);
      }
    }

    // -------------------------------------------------------------------------
    // C3 (both orders): CUSTOM_OPS transfer (cross-dept allowed) & update_person(INACTIVE) (still blocked!) vs assign_team_membership
    // -------------------------------------------------------------------------
    for (const order of ["assign_first", "custom_transfer_first"]) {
      const s = await makeActiveRecruitmentAccountPerson(`c3a.${order}`);
      const customParams = [
        OWNER.auth,
        OWNER.app,
        s.person.person_id,
        customDeptId,
        s.person.version,
        s.person.active_department.membership_id,
        `C3a ${order}`,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, s.person.person_id, {
          target_department_ref: customDeptId,
          expected_person_version: s.person.version,
          expected_current_membership_id: s.person.active_department.membership_id,
          reason: `C3a ${order}`,
        }),
      ];
      await beginServiceTx(w1);
      if (order === "assign_first") {
        await w1.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_B, null, 1, "C3a assign", nextUuid()]);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(TRANSFER_MEMBER_SQL, customParams));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C3a assign_first");
        assert.equal(r2.status, "fulfilled", "Cross-dept transfer to CUSTOM_OPS succeeds with active G1");
      } else {
        await w1.query(TRANSFER_MEMBER_SQL, customParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_B, null, 1, "C3a assign", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C3a custom_transfer_first");
        assert.equal(r2.status, "fulfilled", "Cross-dept assign_team succeeds after transfer to CUSTOM_OPS");
      }
    }

    for (const order of ["assign_first", "inactive_first"]) {
      const s = await makeActiveRecruitmentAccountPerson(`c3b.${order}`);
      const updateParams = [
        OWNER.auth,
        OWNER.app,
        s.person.person_id,
        s.person.version,
        s.person.employee_code,
        s.person.full_name,
        "2026-10-01",
        "INACTIVE",
        `C3b ${order}`,
        nextUuid(),
        computeUpdatePersonFingerprint(OWNER.app, s.person.person_id, {
          expected_person_version: s.person.version,
          employee_code: s.person.employee_code,
          full_name: s.person.full_name,
          joined_on: "2026-10-01",
          status: "INACTIVE",
          reason: `C3b ${order}`,
        }),
      ];
      await beginServiceTx(w1);
      if (order === "assign_first") {
        await w1.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_A, null, 1, "C3b assign", nextUuid()]);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(UPDATE_PERSON_SQL, updateParams));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C3b assign_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.match(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);
      } else {
        await w1.query(UPDATE_PERSON_SQL, updateParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_A, null, 1, "C3b assign", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C3b inactive_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "23514");
      }
    }

    // -------------------------------------------------------------------------
    // C4 (BOTH ORDERS — T0 #4 / F-01):
    //   Suspended verified link (`verified=true, is_current=false, suspended_by_account_disable=true`
    //   created via API `direct_entry_disable_app_user`) connecting `accSusp <-> recSusp`.
    //   Race: `org_department_link_account_person_admin(accSusp, personMkt)` vs `direct_entry_assign_team_membership(recSusp)`.
    // -------------------------------------------------------------------------
    for (const order of ["link_first", "assign_first"]) {
      const accSusp = await seedPlainAccount(setup, `c4.${order}`, `C4 Susp ${order}`);
      const recSusp = await seedPlainUnlinkedHrpRecruiter(setup, `c4.${order}`, `C4 Rec ${order}`);
      await setup.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-11-23', true)`,
        [accSusp.app, recSusp],
      );
      await serviceQuery(setup, DISABLE_USER_SQL, [
        OWNER.auth,
        OWNER.app,
        accSusp.app,
        1,
        `C4 disable creates suspended verified link (${order})`,
        nextUuid(),
      ]);
      const { rows: [suspRow] } = await observer.query(
        `select verified, is_current, suspended_by_account_disable
           from public.direct_entry_app_user_recruiter_links
          where app_user_id = $1::uuid and recruiter_id = $2::uuid`,
        [accSusp.app, recSusp],
      );
      assert.deepEqual(suspRow, { verified: true, is_current: false, suspended_by_account_disable: true });

      const pMkt = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          `EMP-C4-${order.toUpperCase()}`,
          `C4 Mkt ${order}`,
          "2026-10-01",
          deptByKey.MARKETING,
          null,
          null,
          null,
          `C4 mkt setup (${order})`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: `EMP-C4-${order.toUpperCase()}`,
            full_name: `C4 Mkt ${order}`,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.MARKETING,
            account_ref: null,
            expected_account_version: null,
            recruiter_id: null,
            reason: `C4 mkt setup (${order})`,
          }),
        ])
      ).rows[0].data.person;

      const linkParams = [
        OWNER.auth,
        OWNER.app,
        accSusp.app,
        pMkt.person_id,
        2, // version bumped to 2 by DISABLE_USER_SQL
        pMkt.version,
        null,
        `C4 ${order} link`,
        nextUuid(),
        computeLinkAccountPersonFingerprint(OWNER.app, accSusp.app, {
          person_id: pMkt.person_id,
          expected_account_version: 2,
          expected_person_version: pMkt.version,
          confirmed_recruiter_id: null,
          reason: `C4 ${order} link`,
        }),
      ];
      const assignParams = [OWNER.auth, OWNER.app, recSusp, TEAM_A, null, 1, `C4 ${order} assign`, nextUuid()];

      await beginServiceTx(w1);
      if (order === "link_first") {
        await w1.query(LINK_ACCOUNT_PERSON_SQL, linkParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, assignParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `C4 ${order}`);
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        const c4Retry = (
          await serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recSusp, TEAM_A, null, 1, "C4 link_first retry", nextUuid()])
        ).rows[0].data;
        assert.equal(c4Retry.team_id, TEAM_A);

        const { rows: openLinks } = await observer.query(
          "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and person_id = $2::uuid and ended_at is null",
          [accSusp.app, pMkt.person_id],
        );
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true",
          [recSusp],
        );
        assert.equal(openLinks[0].cnt, 1);
        assert.equal(teamRows[0].cnt, 1);
        console.log(
          `[PG18 C4 link_first] wait=${JSON.stringify(waitInfo)} winner=LINK_ACCOUNT_PERSON loser=ASSIGN_TEAM(PT409 post_lock_completeness -> SUCCEEDED on retry for active MARKETING) openLinks=1 teamRows=1`,
        );
      } else {
        await w1.query(ASSIGN_TEAM_SQL, assignParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(LINK_ACCOUNT_PERSON_SQL, linkParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `C4 ${order}`);
        assert.equal(r2.status, "fulfilled", "Cross-dept link_account_person to active MARKETING succeeds after assign_team");

        const { rows: openLinks } = await observer.query(
          "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and person_id = $2::uuid and ended_at is null",
          [accSusp.app, pMkt.person_id],
        );
        const { rows: teamRows } = await observer.query(
          "select is_current, valid_to from public.recruiter_team_memberships where recruiter_id = $1::uuid",
          [recSusp],
        );
        assert.equal(openLinks[0].cnt, 1);
        assert.equal(teamRows.length, 1);
        assert.equal(teamRows[0].is_current, true);
        console.log(
          `[PG18 C4 assign_first] wait=${JSON.stringify(waitInfo)} winner=ASSIGN_TEAM link=LINK_ACCOUNT_PERSON(FULFILLED for active MARKETING) openLinks=1 activeG1=1`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // Helper for C5a & C5b: Set up Day 0 (2026-11-23) A as TL on dedicated team -> Day 1 (2026-11-24) B replaces A
    // -------------------------------------------------------------------------
    async function setupC5Team(tag) {
      const tId = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, $2, $3, true, 1)",
        [tId, `WP10_C5_${tag}`, `C5 Team ${tag}`],
      );
      await setBusinessDate(setup, "2026-11-23");
      const metaA = await makeActiveRecruitmentAccountPerson(`c5.${tag}.a`);
      const metaB = await makeActiveRecruitmentAccountPerson(`c5.${tag}.b`);
      await serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, metaA.recruiterId, tId, null, 1, "C5 A G1", nextUuid()]);
      await serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, metaB.recruiterId, tId, null, 1, "C5 B G1", nextUuid()]);
      await serviceQuery(setup, DESIGNATE_TL_SQL, [OWNER.auth, OWNER.app, tId, metaA.acc.app, null, 1, "Day 0 designate A", nextUuid()]);

      await setBusinessDate(setup, "2026-11-24");
      await serviceQuery(setup, DESIGNATE_TL_SQL, [OWNER.auth, OWNER.app, tId, metaB.acc.app, null, 2, "Day 1 replace A with B", nextUuid()]);
      const { rows: [pARow] } = await observer.query(
        `select p.version as pv, m.membership_id
           from public.organization_persons p
           join public.organization_person_department_memberships m
             on m.person_id = p.person_id and m.ended_at is null
          where p.person_id = $1::uuid`,
        [metaA.person.person_id],
      );
      return { tId, metaA, metaB, pARow };
    }

    async function inspectC5State(teamId, appA, appB, personA) {
      const { rows: tlaRows } = await observer.query(
        `select leader_app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_team_leader_assignments
          where team_id = $1::uuid order by created_at asc`,
        [teamId],
      );
      const { rows: sgRows } = await observer.query(
        `select app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_scope_grants
          where team_id = $1::uuid and scope_kind = 'team' order by created_at asc`,
        [teamId],
      );
      const { rows: cgRows } = await observer.query(
        `select app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_capability_grants
          where app_user_id = any($1::uuid[]) and capability = 'team_manager_assign'
          order by created_at asc`,
        [[appA, appB]],
      );
      const { rows: [deptRow] } = await observer.query(
        `select d.system_key
           from public.organization_person_department_memberships m
           join public.organization_departments d on d.department_id = m.department_id
          where m.person_id = $1::uuid and m.ended_at is null`,
        [personA],
      );
      return { tlaRows, sgRows, cgRows, deptA: deptRow?.system_key ?? null };
    }

    // -------------------------------------------------------------------------
    // C5a (BOTH ORDERS + mutual G1 unassign race — pure API):
    //   A keeps active G1 on TEAM; race `revoke(B)` vs `transfer(pA, ACCOUNTING)` (both succeed & restore A!)
    //   and vs `unassign(recA)`.
    // -------------------------------------------------------------------------
    {
      // C5a Order 1: revoke(B) uncommitted holds P(A) -> transfer(pA, ACCOUNTING) waits on Lock -> succeeds cleanly and A+SG+CG stay restored!
      const c5a1 = await setupC5Team("5A1");
      const transferA = [
        OWNER.auth,
        OWNER.app,
        c5a1.metaA.person.person_id,
        deptByKey.ACCOUNTING,
        c5a1.pARow.pv,
        c5a1.pARow.membership_id,
        "C5a1 transfer A to ACCOUNTING",
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, c5a1.metaA.person.person_id, {
          target_department_ref: deptByKey.ACCOUNTING,
          expected_person_version: c5a1.pARow.pv,
          expected_current_membership_id: c5a1.pARow.membership_id,
          reason: "C5a1 transfer A to ACCOUNTING",
        }),
      ];
      await beginServiceTx(w1);
      await w1.query(REVOKE_TL_SQL, [OWNER.auth, OWNER.app, c5a1.tId, null, 3, "C5a1 revoke B", nextUuid()]);
      await beginServiceTx(w2);
      const p2 = settleInTx(w2, w2.query(TRANSFER_MEMBER_SQL, transferA));
      const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
      await w1.query("commit");
      const r2 = await p2;
      assertNotDeadlock(r2, "C5a Order 1");
      assert.equal(r2.status, "fulfilled", "Cross-dept transfer(pA, ACCOUNTING) succeeds after revoke(B)");

      const st = await inspectC5State(c5a1.tId, c5a1.metaA.acc.app, c5a1.metaB.acc.app, c5a1.metaA.person.person_id);
      assert.equal(st.deptA, "ACCOUNTING");
      assert.equal(st.tlaRows.find((r) => r.uid === c5a1.metaA.acc.app)?.is_current, true);
      assert.deepEqual(st.tlaRows.find((r) => r.uid === c5a1.metaB.acc.app)?.valid_to, "2026-11-24");
      assert.equal(st.sgRows.length, 0);
      assert.equal(st.cgRows.length, 0);
      console.log(
        `[PG18 C5a Order 1 revoke_first] wait=${JSON.stringify(waitInfo)} winner=REVOKE(v_restore=true, A restored, B closed 0-len, 0 legacy TL grants) transfer=FULFILLED(deptA=ACCOUNTING)`,
      );
    }

    {
      // C5a Order 2: transfer(pA, ACCOUNTING) succeeds upfront, then revoke(B) commits restoring A cleanly!
      const c5a2 = await setupC5Team("5A2");
      await serviceQuery(setup, TRANSFER_MEMBER_SQL, [
        OWNER.auth,
        OWNER.app,
        c5a2.metaA.person.person_id,
        deptByKey.ACCOUNTING,
        c5a2.pARow.pv,
        c5a2.pARow.membership_id,
        "C5a2 transfer A to ACCOUNTING",
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, c5a2.metaA.person.person_id, {
          target_department_ref: deptByKey.ACCOUNTING,
          expected_person_version: c5a2.pARow.pv,
          expected_current_membership_id: c5a2.pARow.membership_id,
          reason: "C5a2 transfer A to ACCOUNTING",
        }),
      ]);
      await serviceQuery(setup, REVOKE_TL_SQL, [OWNER.auth, OWNER.app, c5a2.tId, null, 3, "C5a2 revoke B after cross-dept transfer", nextUuid()]);
      const st = await inspectC5State(c5a2.tId, c5a2.metaA.acc.app, c5a2.metaB.acc.app, c5a2.metaA.person.person_id);
      assert.equal(st.deptA, "ACCOUNTING");
      assert.equal(st.tlaRows.find((r) => r.uid === c5a2.metaA.acc.app)?.is_current, true);
      assert.equal(st.sgRows.length, 0);
      assert.equal(st.cgRows.length, 0);
      console.log("[PG18 C5a Order 2 transfer_first_cross_dept] transfer=FULFILLED(deptA=ACCOUNTING) followUp=REVOKE(v_restore=true, A restored)");
    }

    // Genuine 2-order Lock wait on C5a: revoke(B) vs unassign_team_membership(recA)
    for (const order of ["revoke_first", "unassign_first"]) {
      const c5au = await setupC5Team(`5AU_${order}`);
      const revokeParams = [OWNER.auth, OWNER.app, c5au.tId, null, 3, `C5a ${order} revoke`, nextUuid()];
      const unassignParams = [OWNER.auth, OWNER.app, c5au.metaA.recruiterId, null, 2, `C5a ${order} unassign`, nextUuid()];
      await beginServiceTx(w1);
      if (order === "revoke_first") {
        await w1.query(REVOKE_TL_SQL, revokeParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(UNASSIGN_TEAM_SQL, unassignParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C5a unassign revoke_first");
        assert.equal(r2.status, "rejected", "Unassign blocks on canonical lock and rejects with PT409 after revoke restores A as active TL (0 40P01)");
        assert.equal(r2.reason?.code, "PT409");
        assert.match(r2.reason?.message ?? "", /recruiter holds active or restorable team leader assignment/i);
        const st = await inspectC5State(c5au.tId, c5au.metaA.acc.app, c5au.metaB.acc.app, c5au.metaA.person.person_id);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaA.acc.app)?.is_current, true);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaB.acc.app)?.valid_to, "2026-11-24");
        assert.equal(st.sgRows.length, 0);
        assert.equal(st.cgRows.length, 0);
        const { rows: memRows } = await observer.query(
          `select team_id::text as team_id, is_current, valid_to
             from public.recruiter_team_memberships
            where recruiter_id = $1::uuid`,
          [c5au.metaA.recruiterId],
        );
        assert.equal(memRows.length, 1);
        assert.equal(memRows[0].team_id, c5au.tId);
        assert.equal(memRows[0].is_current, true);
        assert.equal(memRows[0].valid_to, null);
        console.log(`[PG18 C5a-unassign ${order}] wait=${JSON.stringify(waitInfo)} winner=REVOKE(A restored, B closed 0-len) unassign=REJECTED(PT409 active TL, G1 intact, 0 40P01)`);
      } else {
        await w1.query(UNASSIGN_TEAM_SQL, unassignParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(REVOKE_TL_SQL, revokeParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C5a unassign_first");
        assert.equal(r2.status, "fulfilled", "Revoke B still succeeds with v_restore=false when A lost G1");
        const st = await inspectC5State(c5au.tId, c5au.metaA.acc.app, c5au.metaB.acc.app, c5au.metaA.person.person_id);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaA.acc.app)?.is_current, false);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaB.acc.app)?.is_current, false);
        assert.equal(st.sgRows.length, 0);
        assert.equal(st.cgRows.length, 0);
        console.log(`[PG18 C5a-unassign ${order}] wait=${JSON.stringify(waitInfo)} winner=UNASSIGN revoke=SUCCEEDED(v_restore=false, both A & B closed)`);
      }
    }

    // -------------------------------------------------------------------------
    // C5b (BOTH ORDERS pure API after G1 unassign + separate defensive drift Lock-wait proof):
    // -------------------------------------------------------------------------
    for (const order of ["transfer_first", "revoke_first"]) {
      const c5b = await setupC5Team(`5B_${order}`);
      // Close A's G1 cleanly via API so transfer(pA, ACCOUNTING) is legally eligible before racing revoke(B)
      await serviceQuery(setup, UNASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, c5b.metaA.recruiterId, null, 2, "C5b close A G1", nextUuid()]);
      const transferParams = [
        OWNER.auth,
        OWNER.app,
        c5b.metaA.person.person_id,
        deptByKey.ACCOUNTING,
        c5b.pARow.pv,
        c5b.pARow.membership_id,
        `C5b ${order} transfer`,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, c5b.metaA.person.person_id, {
          target_department_ref: deptByKey.ACCOUNTING,
          expected_person_version: c5b.pARow.pv,
          expected_current_membership_id: c5b.pARow.membership_id,
          reason: `C5b ${order} transfer`,
        }),
      ];
      const revokeParams = [OWNER.auth, OWNER.app, c5b.tId, null, 3, `C5b ${order} revoke`, nextUuid()];
      await beginServiceTx(w1);
      let waitInfo;
      if (order === "transfer_first") {
        await w1.query(TRANSFER_MEMBER_SQL, transferParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(REVOKE_TL_SQL, revokeParams));
        waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `C5b ${order}`);
        assert.equal(r2.status, "fulfilled");
      } else {
        await w1.query(REVOKE_TL_SQL, revokeParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(TRANSFER_MEMBER_SQL, transferParams));
        waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `C5b ${order}`);
        assert.equal(r2.status, "fulfilled");
      }
      const st = await inspectC5State(c5b.tId, c5b.metaA.acc.app, c5b.metaB.acc.app, c5b.metaA.person.person_id);
      assert.equal(st.deptA, "ACCOUNTING");
      assert.equal(st.tlaRows.find((r) => r.uid === c5b.metaA.acc.app)?.is_current, false);
      assert.equal(st.tlaRows.find((r) => r.uid === c5b.metaB.acc.app)?.is_current, false);
      assert.equal(st.sgRows.length, 0);
      assert.equal(st.cgRows.length, 0);
      console.log(`[PG18 C5b pure-API ${order}] wait=${JSON.stringify(waitInfo)} outcome=(deptA=ACCOUNTING, v_restore=false, both A & B closed)`);
    }

    // Defensive drift Lock-wait proof (distinct from pure API tests):
    // A still holds G1, w1 locks P(A) FOR UPDATE and drifts status -> INACTIVE, while w2 runs revoke(B) and blocks on P(A).
    {
      const c5bDrift = await setupC5Team("5B_DRIFT");
      await w1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await w1.query("select public.org_department__internal_lock_person($1::uuid)", [c5bDrift.metaA.person.person_id]);
      await w1.query(
        "update public.organization_persons set status = 'INACTIVE', deactivated_at = now() where person_id = $1::uuid",
        [c5bDrift.metaA.person.person_id],
      );
      await beginServiceTx(w2);
      const p2 = settleInTx(
        w2,
        w2.query(REVOKE_TL_SQL, [OWNER.auth, OWNER.app, c5bDrift.tId, null, 3, "C5b drift revoke waits on P(A)", nextUuid()]),
      );
      const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
      await w1.query("commit");
      const r2 = await p2;
      assertNotDeadlock(r2, "C5b drift");
      assert.equal(r2.status, "fulfilled", "Revoke(B) MUST succeed cleanly even when P(A) drifted INACTIVE mid-race");
      const st = await inspectC5State(c5bDrift.tId, c5bDrift.metaA.acc.app, c5bDrift.metaB.acc.app, c5bDrift.metaA.person.person_id);
      assert.equal(st.tlaRows.find((r) => r.uid === c5bDrift.metaA.acc.app)?.is_current, false);
      assert.equal(st.tlaRows.find((r) => r.uid === c5bDrift.metaB.acc.app)?.is_current, false);
      assert.equal(st.tlaRows.find((r) => r.uid === c5bDrift.metaB.acc.app)?.valid_to, "2026-11-24");
      assert.equal(st.sgRows.length, 0);
      assert.equal(st.cgRows.length, 0);
      console.log(
        `[PG18 C5b defensive-drift] wait=${JSON.stringify(waitInfo)} outcome=REVOKE_SUCCEEDED(v_restore=false, A stays closed, B closed 0-len)`,
      );
    }

    // -------------------------------------------------------------------------
    // P2 (T0 finding): Tier U advisory-before-row lock ordering (`A.app < B.app`).
    //   - A is an active SYSTEM_ADMIN (with synced legacy grants) and NO Org Person link.
    //   - B is an eligible legacy Recruiter (unmapped `recruiters` + `hrp` + verified link + G1, NO Org Person).
    // -------------------------------------------------------------------------
    const { rows: [sysAdminGroup] } = await setup.query(
      "select group_id from public.authz_user_groups where code = 'SYSTEM_ADMIN' and active = true",
    );
    assert.ok(sysAdminGroup?.group_id, "SYSTEM_ADMIN permission group must exist");

    async function seedP2AdminAndLegacyLeaderPair(tag) {
      const A = await seedPlainAccount(setup, `p2.${tag}.a`, `P2 Admin ${tag}`);
      const B = await seedPlainAccount(setup, `p2.${tag}.b`, `P2 Legacy TL ${tag}`);
      assert.ok(A.app < B.app, `Expected A.app (${A.app}) < B.app (${B.app})`);

      const assignAdminRes = (
        await serviceQuery(setup, ASSIGN_GROUP_MEMBER_SQL, [
          OWNER.auth,
          OWNER.app,
          A.app,
          sysAdminGroup.group_id,
          1,
          `Assign SYSTEM_ADMIN to P2 ${tag} A`,
          nextUuid(),
          createHash("sha256").update(`p2:${tag}:assign-admin:${A.app}`).digest("hex"),
        ])
      ).rows[0].data;
      const accVersionA = assignAdminRes.account_version;
      assert.equal(accVersionA, 2);

      const { rows: [authzA] } = await observer.query(
        `select public.direct_entry_authz__internal_has_paired_capability($1::uuid, 'team_master_manage', 'ALL', null) as has_tm,
                public.direct_entry_authz__internal_has_paired_capability($1::uuid, 'entry_admin', 'ALL', null) as has_ea,
                (select count(*)::int from public.organization_account_person_links where app_user_id = $1::uuid) as person_links`,
        [A.app],
      );
      assert.deepEqual(authzA, { has_tm: true, has_ea: true, person_links: 0 });

      const teamId = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, $2, $3, true, 1)",
        [teamId, `WP10_P2_${tag.toUpperCase()}`, `P2 Team ${tag}`],
      );

      const recB = await seedPlainUnlinkedHrpRecruiter(setup, `p2.${tag}.recb`, `P2 Legacy Rec ${tag}`);
      await setup.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-11-23', true)`,
        [B.app, recB],
      );
      await serviceQuery(setup, ASSIGN_TEAM_SQL, [
        OWNER.auth,
        OWNER.app,
        recB,
        teamId,
        null,
        1,
        `P2 ${tag} B G1`,
        nextUuid(),
      ]);

      const { rows: [orgB] } = await observer.query(
        `select (select count(*)::int from public.organization_persons where recruiter_id = $1::uuid) as rec_persons,
                (select count(*)::int from public.organization_account_person_links where app_user_id = $2::uuid) as b_links`,
        [recB, B.app],
      );
      assert.deepEqual(orgB, { rec_persons: 0, b_links: 0 });

      return { A, B, accVersionA, teamId, recB };
    }

    function buildCreatePersonParamsForP2(tag, pair) {
      const code = `EMP-P2-${tag.toUpperCase()}`;
      const fullName = `P2 Conflict Person ${tag}`;
      const reason = `P2 create person conflict (${tag})`;
      return {
        code,
        params: [
          OWNER.auth,
          OWNER.app,
          code,
          fullName,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          pair.A.app,
          pair.accVersionA,
          pair.recB,
          reason,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: code,
            full_name: fullName,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: pair.A.app,
            expected_account_version: pair.accVersionA,
            recruiter_id: pair.recB,
            reason,
          }),
        ],
      };
    }

    async function assertNoOrgSideEffects(pair, empCode) {
      const { rows: [orgState] } = await observer.query(
        `select (select count(*)::int from public.organization_persons where recruiter_id = $1::uuid or lower(employee_code) = lower($2)) as persons,
                (select count(*)::int from public.organization_account_person_links where app_user_id = any($3::uuid[])) as links`,
        [pair.recB, empCode, [pair.A.app, pair.B.app]],
      );
      assert.deepEqual(orgState, { persons: 0, links: 0 });
    }

    async function assertActiveTeamLeaderWithGrants(pair) {
      const { rows: tlaRows } = await observer.query(
        `select leader_app_user_id::text as uid, leader_recruiter_id::text as rid, is_current, valid_to::text
           from public.direct_entry_team_leader_assignments
          where team_id = $1::uuid`,
        [pair.teamId],
      );
      assert.equal(tlaRows.length, 1);
      assert.deepEqual(tlaRows[0], {
        uid: pair.B.app,
        rid: pair.recB,
        is_current: true,
        valid_to: null,
      });

      const { rows: sgRows } = await observer.query(
        `select app_user_id::text as uid, scope_kind, team_id::text as tid, is_current
           from public.direct_entry_scope_grants
          where team_id = $1::uuid and scope_kind = 'team' and is_current = true`,
        [pair.teamId],
      );
      assert.equal(sgRows.length, 0);

      const { rows: cgRows } = await observer.query(
        `select app_user_id::text as uid, capability, is_current
           from public.direct_entry_capability_grants
          where app_user_id = $1::uuid and capability = 'team_manager_assign' and is_current = true`,
        [pair.B.app],
      );
      assert.equal(cgRows.length, 0);
    }

    // P2 Barrier 1 (Direct RPC-vs-RPC race, A.app < B.app)
    {
      const p2b1 = await seedP2AdminAndLegacyLeaderPair("b1");
      const { code, params: createParams } = buildCreatePersonParamsForP2("b1", p2b1);

      await beginServiceTx(w1);
      await w1.query(DESIGNATE_TL_SQL, [
        p2b1.A.auth,
        p2b1.A.app,
        p2b1.teamId,
        p2b1.B.app,
        null,
        1,
        "P2 Barrier 1 designate TL B",
        nextUuid(),
      ]);

      await beginServiceTx(w2);
      const p2 = settleInTx(w2, w2.query(CREATE_PERSON_SQL, createParams));
      const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
      assert.equal(waitInfo.wait_event_type, "Lock");

      await w1.query("commit");
      const r2 = await p2;
      assertNotDeadlock(r2, "P2 Barrier 1");
      assert.equal(r2.status, "rejected");
      assert.equal(r2.reason?.code, "PT409");
      assert.match(r2.reason?.message ?? "", /RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT/);

      await assertNoOrgSideEffects(p2b1, code);
      await assertActiveTeamLeaderWithGrants(p2b1);
      console.log(
        `[PG18 P2 Barrier1] A=${p2b1.A.app} B=${p2b1.B.app} wait=${JSON.stringify(waitInfo)} winner=DESIGNATE_TL(B+SG+CG) loser=CREATE_PERSON(PT409:RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT rolled_back) deadlocks=0`,
      );
    }

    // P2 Barrier 2 (Deterministic deadlock-trap proof matching T0's exact interleaving, A2.app < B2.app)
    {
      const p2b2 = await seedP2AdminAndLegacyLeaderPair("b2");
      const { code, params: createParams } = buildCreatePersonParamsForP2("b2", p2b2);

      await w1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await w1.query("select public.org_department__internal_lock_app_user($1::uuid)", [p2b2.B.app]);

      await beginServiceTx(w2);
      const p2 = settleInTx(
        w2,
        w2.query(DESIGNATE_TL_SQL, [
          p2b2.A.auth,
          p2b2.A.app,
          p2b2.teamId,
          p2b2.B.app,
          null,
          1,
          "P2 Barrier 2 designate TL B2",
          nextUuid(),
        ]),
      );

      const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
      assert.equal(waitInfo.wait_event_type, "Lock");
      assert.equal(waitInfo.locktype, "advisory", `Expected advisory lock wait on B2, got ${JSON.stringify(waitInfo)}`);

      const { rows: nowaitRows } = await w1.query(
        "select app_user_id::text as app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update nowait",
        [p2b2.A.app],
      );
      assert.equal(nowaitRows.length, 1);
      assert.equal(nowaitRows[0].app_user_id, p2b2.A.app);

      await w1.query("savepoint sp_p2_b2");
      await w1.query("set local role service_role");
      await assert.rejects(
        () => w1.query(CREATE_PERSON_SQL, createParams),
        (err) => {
          assert.notEqual(err?.code, "40P01", `Unexpected 40P01 in w1 create_person_admin: ${err?.message}`);
          return err?.code === "PT409" && /RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT/.test(err?.message ?? "");
        },
      );
      await w1.query("rollback to savepoint sp_p2_b2");
      await w1.query("release savepoint sp_p2_b2");

      await w1.query("commit");
      const r2 = await p2;
      assertNotDeadlock(r2, "P2 Barrier 2");
      assert.equal(r2.status, "fulfilled", `Expected designate TL B2 to commit cleanly after w1 release, got ${r2.reason?.message}`);

      await assertNoOrgSideEffects(p2b2, code);
      await assertActiveTeamLeaderWithGrants(p2b2);
      console.log(
        `[PG18 P2 Barrier2] A2=${p2b2.A.app} B2=${p2b2.B.app} wait=${JSON.stringify(waitInfo)} nowaitA2=SUCCEEDED createPerson=PT409:RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT designate=FULFILLED(B2+SG+CG) deadlocks=0`,
      );
    }

    // P2 Disable/Enable Tier-U parity (A3.app < B3.app)
    {
      const p2b3 = await seedP2AdminAndLegacyLeaderPair("b3");
      const { code: codeDis, params: createParamsDis } = buildCreatePersonParamsForP2("b3_dis", p2b3);

      // Disable Barrier 2: w1 holds advisory(B3), w2 disable_app_user blocks on advisory(B3),
      // while w1 acquires A3 FOR UPDATE NOWAIT and create_person_admin(A3, recB3) raises PT409 RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT.
      await w1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await w1.query("select public.org_department__internal_lock_app_user($1::uuid)", [p2b3.B.app]);

      await beginServiceTx(w2);
      const pDis = settleInTx(
        w2,
        w2.query(DISABLE_USER_SQL, [p2b3.A.auth, p2b3.A.app, p2b3.B.app, 1, "P2 disable B3", nextUuid()]),
      );
      const waitDis = await waitUntilBlocked(observer, "wp10-2-w2");
      assert.equal(waitDis.wait_event_type, "Lock");
      assert.equal(waitDis.locktype, "advisory", `Expected advisory lock wait on B3 during disable, got ${JSON.stringify(waitDis)}`);

      const { rows: nowaitDisRows } = await w1.query(
        "select app_user_id::text as app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update nowait",
        [p2b3.A.app],
      );
      assert.equal(nowaitDisRows.length, 1);
      assert.equal(nowaitDisRows[0].app_user_id, p2b3.A.app);

      await w1.query("savepoint sp_p2_dis");
      await w1.query("set local role service_role");
      await assert.rejects(
        () => w1.query(CREATE_PERSON_SQL, createParamsDis),
        (err) => {
          assert.notEqual(err?.code, "40P01", `Unexpected 40P01 in w1 create_person_admin during disable: ${err?.message}`);
          return err?.code === "PT409" && /RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT/.test(err?.message ?? "");
        },
      );
      await w1.query("rollback to savepoint sp_p2_dis");
      await w1.query("release savepoint sp_p2_dis");

      await w1.query("commit");
      const rDis = await pDis;
      assertNotDeadlock(rDis, "P2 Disable Barrier 2");
      assert.equal(rDis.status, "fulfilled", `Expected disable B3 to commit cleanly, got ${rDis.reason?.message}`);
      await assertNoOrgSideEffects(p2b3, codeDis);

      const { rows: [bAfterDis] } = await observer.query(
        `select u.enabled, u.version, l.verified, l.is_current, l.suspended_by_account_disable
           from public.direct_entry_app_users u
           join public.direct_entry_app_user_recruiter_links l on l.app_user_id = u.app_user_id
          where u.app_user_id = $1::uuid and l.recruiter_id = $2::uuid`,
        [p2b3.B.app, p2b3.recB],
      );
      assert.deepEqual(bAfterDis, {
        enabled: false,
        version: 2,
        verified: true,
        is_current: false,
        suspended_by_account_disable: true,
      });

      // Enable Barrier 2: w1 holds advisory(B3), w2 enable_app_user blocks on advisory(B3),
      // while w1 immediately acquires A3 FOR UPDATE NOWAIT.
      await w1.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await w1.query("select public.org_department__internal_lock_app_user($1::uuid)", [p2b3.B.app]);

      await beginServiceTx(w2);
      const pEn = settleInTx(
        w2,
        w2.query(ENABLE_USER_SQL, [p2b3.A.auth, p2b3.A.app, p2b3.B.app, 2, "P2 enable B3", nextUuid()]),
      );
      const waitEn = await waitUntilBlocked(observer, "wp10-2-w2");
      assert.equal(waitEn.wait_event_type, "Lock");
      assert.equal(waitEn.locktype, "advisory", `Expected advisory lock wait on B3 during enable, got ${JSON.stringify(waitEn)}`);

      const { rows: nowaitEnRows } = await w1.query(
        "select app_user_id::text as app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update nowait",
        [p2b3.A.app],
      );
      assert.equal(nowaitEnRows.length, 1);
      assert.equal(nowaitEnRows[0].app_user_id, p2b3.A.app);

      await w1.query("commit");
      const rEn = await pEn;
      assertNotDeadlock(rEn, "P2 Enable Barrier 2");
      assert.equal(rEn.status, "fulfilled", `Expected enable B3 to commit cleanly, got ${rEn.reason?.message}`);

      // Enable Barrier 1 (RPC-vs-RPC): disable B3 again, then race enable_app_user(w1) vs create_person_admin(A3, recB3)(w2)
      await serviceQuery(setup, DISABLE_USER_SQL, [p2b3.A.auth, p2b3.A.app, p2b3.B.app, 3, "P2 re-disable B3", nextUuid()]);
      const { code: codeEnRace, params: createParamsEnRace } = buildCreatePersonParamsForP2("b3_en", p2b3);

      await beginServiceTx(w1);
      await w1.query(ENABLE_USER_SQL, [p2b3.A.auth, p2b3.A.app, p2b3.B.app, 4, "P2 enable race B3", nextUuid()]);

      await beginServiceTx(w2);
      const pEnRace = settleInTx(w2, w2.query(CREATE_PERSON_SQL, createParamsEnRace));
      const waitEnRace = await waitUntilBlocked(observer, "wp10-2-w2");
      assert.equal(waitEnRace.wait_event_type, "Lock");

      await w1.query("commit");
      const rEnRace = await pEnRace;
      assertNotDeadlock(rEnRace, "P2 Enable Barrier 1");
      assert.equal(rEnRace.status, "rejected");
      assert.equal(rEnRace.reason?.code, "PT409");
      assert.match(rEnRace.reason?.message ?? "", /RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT/);
      await assertNoOrgSideEffects(p2b3, codeEnRace);

      const { rows: [bAfterEn] } = await observer.query(
        `select u.enabled, u.version, l.verified, l.is_current, l.suspended_by_account_disable
           from public.direct_entry_app_users u
           join public.direct_entry_app_user_recruiter_links l on l.app_user_id = u.app_user_id
          where u.app_user_id = $1::uuid and l.recruiter_id = $2::uuid`,
        [p2b3.B.app, p2b3.recB],
      );
      assert.deepEqual(bAfterEn, {
        enabled: true,
        version: 5,
        verified: true,
        is_current: true,
        suspended_by_account_disable: false,
      });

      console.log(
        `[PG18 P2 Disable/Enable] A3=${p2b3.A.app} B3=${p2b3.B.app} disableWait=${JSON.stringify(waitDis)} enableWait=${JSON.stringify(waitEn)} enableRaceWait=${JSON.stringify(waitEnRace)} nowaitA3=SUCCEEDED(disable+enable) createPerson=PT409:RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT deadlocks=0`,
      );
    }

    // -------------------------------------------------------------------------
    // F-01 (Round 2): Post-Tier-2b `direct_entry_idempotency_begin` & pure actor Tier 2b `FOR SHARE`
    // -------------------------------------------------------------------------
    async function checkUserRowNowaitUnlocked(client, appUserId) {
      await client.query("begin");
      try {
        const { rows } = await client.query(
          "select app_user_id::text as app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update nowait",
          [appUserId],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].app_user_id, appUserId);
      } finally {
        await client.query("rollback").catch(() => {});
      }
    }

    async function seedF01SystemAdmin(tag, { withRecruitmentTLTeamId = null } = {}) {
      const acc = await seedPlainAccount(setup, `f01.${tag}`, `F01 Admin ${tag}`);
      const assignRes = (
        await serviceQuery(setup, ASSIGN_GROUP_MEMBER_SQL, [
          OWNER.auth,
          OWNER.app,
          acc.app,
          sysAdminGroup.group_id,
          1,
          `Assign SYSTEM_ADMIN to F01 ${tag}`,
          nextUuid(),
          createHash("sha256").update(`f01:${tag}:admin:${acc.app}`).digest("hex"),
        ])
      ).rows[0].data;
      let accVersion = assignRes.account_version;
      let person = null;
      let recruiterId = null;

      if (withRecruitmentTLTeamId) {
        const empCode = `EMP-F01-ADM-${tag.toUpperCase()}`;
        person = (
          await serviceQuery(setup, CREATE_PERSON_SQL, [
            OWNER.auth,
            OWNER.app,
            empCode,
            acc.name,
            "2026-10-01",
            deptByKey.RECRUITMENT,
            acc.app,
            accVersion,
            null,
            `Create F01 Admin person ${tag}`,
            nextUuid(),
            computeCreatePersonFingerprint(OWNER.app, {
              employee_code: empCode,
              full_name: acc.name,
              joined_on: "2026-10-01",
              initial_department_ref: deptByKey.RECRUITMENT,
              account_ref: acc.app,
              expected_account_version: accVersion,
              recruiter_id: null,
              reason: `Create F01 Admin person ${tag}`,
            }),
          ])
        ).rows[0].data.person;
        accVersion = person.active_account_link.account_version;
        recruiterId = (
          await serviceQuery(setup, CREATE_PERSONNEL_FROM_ACC_SQL, [
            OWNER.auth,
            OWNER.app,
            acc.app,
            accVersion,
            acc.login,
            "STAFF",
            null,
            `Create F01 Admin recruiter ${tag}`,
            nextUuid(),
          ])
        ).rows[0].data.recruiter_id;
        await serviceQuery(setup, ASSIGN_TEAM_SQL, [
          OWNER.auth,
          OWNER.app,
          recruiterId,
          withRecruitmentTLTeamId,
          null,
          1,
          `Assign F01 Admin ${tag} G1`,
          nextUuid(),
        ]);
        const { rows: [teamRow] } = await observer.query(
          "select version from public.teams where team_id = $1::uuid",
          [withRecruitmentTLTeamId],
        );
        await serviceQuery(setup, DESIGNATE_TL_SQL, [
          OWNER.auth,
          OWNER.app,
          withRecruitmentTLTeamId,
          acc.app,
          null,
          teamRow.version,
          `Designate F01 Admin ${tag} TL`,
          nextUuid(),
        ]);
        const { rows: [accRow] } = await observer.query(
          "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
          [acc.app],
        );
        accVersion = accRow.version;
      }

      return { acc, accVersion, person, recruiterId };
    }

    // F-01 (1): Port T1A's `link_recruiter` vs `designate_team_leader` P2 idempotency repro
    {
      const teamF01Link = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'WP10_F01_LINK_T1', 'F01 Link Team 1', true, 1)",
        [teamF01Link],
      );
      const adminA = await seedF01SystemAdmin("repro_a", { withRecruitmentTLTeamId: teamF01Link });

      const rec1 = await seedPlainUnlinkedHrpRecruiter(setup, "f01.repro.r1", "F01 Repro Rec 1");
      const rec2 = await seedPlainUnlinkedHrpRecruiter(setup, "f01.repro.r2", "F01 Repro Rec 2");
      const p1 = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-R1",
          "F01 Repro Rec 1",
          "2026-10-01",
          deptByKey.RECRUITMENT,
          null,
          null,
          rec1,
          "F01 candidate 1",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-R1",
            full_name: "F01 Repro Rec 1",
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: null,
            expected_account_version: null,
            recruiter_id: rec1,
            reason: "F01 candidate 1",
          }),
        ])
      ).rows[0].data.person;
      const p2 = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-R2",
          "F01 Repro Rec 2",
          "2026-10-01",
          deptByKey.RECRUITMENT,
          null,
          null,
          rec2,
          "F01 candidate 2",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-R2",
            full_name: "F01 Repro Rec 2",
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: null,
            expected_account_version: null,
            recruiter_id: rec2,
            reason: "F01 candidate 2",
          }),
        ])
      ).rows[0].data.person;

      const [pXInfo, pBInfo] =
        p1.person_id < p2.person_id
          ? [{ person: p1, recId: rec1, codePrefix: "f01.repro.r1" }, { person: p2, recId: rec2, codePrefix: "f01.repro.r2" }]
          : [{ person: p2, recId: rec2, codePrefix: "f01.repro.r2" }, { person: p1, recId: rec1, codePrefix: "f01.repro.r1" }];
      const P_X = pXInfo.person.person_id;
      const recX = pXInfo.recId;
      const P_B = pBInfo.person.person_id;
      const recB = pBInfo.recId;
      assert.ok(P_X < P_B, `Expected P_X (${P_X}) < P_B (${P_B})`);

      const B = await seedPlainAccount(setup, pBInfo.codePrefix, pBInfo.person.full_name);
      await serviceQuery(setup, LINK_ACCOUNT_PERSON_SQL, [
        OWNER.auth,
        OWNER.app,
        B.app,
        P_B,
        1,
        pBInfo.person.version,
        recB,
        "Link F01 B to P_B",
        nextUuid(),
        computeLinkAccountPersonFingerprint(OWNER.app, B.app, {
          person_id: P_B,
          expected_account_version: 1,
          expected_person_version: pBInfo.person.version,
          confirmed_recruiter_id: recB,
          reason: "Link F01 B to P_B",
        }),
      ]);
      await serviceQuery(setup, LINK_RECRUITER_SQL, [
        OWNER.auth,
        OWNER.app,
        recB,
        1,
        B.app,
        2,
        "Verify F01 recB on B",
        nextUuid(),
      ]);
      await serviceQuery(setup, ASSIGN_TEAM_SQL, [
        OWNER.auth,
        OWNER.app,
        recB,
        teamF01Link,
        null,
        1,
        "Assign F01 recB to T1",
        nextUuid(),
      ]);
      const { rows: [bAccRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [B.app],
      );
      const { rows: [t1PreRow] } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamF01Link],
      );
      assert.equal(t1PreRow.version, 2);

      const linkKey = nextUuid();
      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [P_X]);

      await beginServiceTx(w1);
      const pLink = settleInTx(
        w1,
        w1.query(LINK_RECRUITER_SQL, [
          adminA.acc.auth,
          adminA.acc.app,
          recX,
          1,
          B.app,
          bAccRow.version,
          "F01 link_recruiter repro",
          linkKey,
        ]),
      );

      const waitW1OnPx = await waitUntilBlocked(observer, "wp10-2-w1");
      assert.equal(waitW1OnPx.wait_event_type, "Lock");
      assert.equal(waitW1OnPx.locktype, "advisory");

      // Crucial F-01 proof: while w1 waits on P_X, A & B have NO premature FOR KEY SHARE / FOR UPDATE locks
      await checkUserRowNowaitUnlocked(observer, adminA.acc.app);
      await checkUserRowNowaitUnlocked(observer, B.app);

      const { rows: [idemDuringWait] } = await observer.query(
        `select count(*)::int as cnt
           from public.direct_entry_rpc_idempotency
          where app_user_id = $1::uuid and action = 'account_recruiter_link_create' and idempotency_key = $2`,
        [adminA.acc.app, linkKey],
      );
      assert.equal(idemDuringWait.cnt, 0);

      // w2 designates B as TL on teamF01Link (writes A outgoing + B incoming) without blocking on A!
      await beginServiceTx(w2);
      const designateRes = await w2.query(DESIGNATE_TL_SQL, [
        OWNER.auth,
        OWNER.app,
        teamF01Link,
        B.app,
        null,
        2,
        "F01 designate B TL on T1",
        nextUuid(),
      ]);
      assert.equal(designateRes.rows[0].data.leader_app_user_id, B.app);

      // Release wH on P_X so w1 advances to P_B and blocks cleanly on w2's advisory(P_B)
      await wH.query("commit");
      const waitW1OnPb = await waitUntilBlocked(observer, "wp10-2-w1");
      assert.equal(waitW1OnPb.wait_event_type, "Lock");

      await w2.query("commit");
      const rLink = await pLink;
      assertNotDeadlock(rLink, "F01 link_recruiter vs designate_team_leader");
      assert.equal(rLink.status, "rejected");
      assert.equal(rLink.reason?.code, "PT409");
      assert.match(rLink.reason?.message ?? "", /RECRUITER_IDENTITY_CONFLICT/);

      // Verify full DB outcomes & complete rollback of loser w1
      const { rows: [t1PostRow] } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamF01Link],
      );
      assert.equal(t1PostRow.version, 3);
      const { rows: tlaF01Rows } = await observer.query(
        `select leader_app_user_id::text as uid, leader_recruiter_id::text as rid, is_current, valid_to::text
           from public.direct_entry_team_leader_assignments
          where team_id = $1::uuid
          order by created_at asc`,
        [teamF01Link],
      );
      assert.equal(tlaF01Rows.length, 2);
      assert.deepEqual(
        tlaF01Rows.find((r) => r.uid === adminA.acc.app),
        { uid: adminA.acc.app, rid: adminA.recruiterId, is_current: false, valid_to: "2026-11-24" },
      );
      assert.deepEqual(
        tlaF01Rows.find((r) => r.uid === B.app),
        { uid: B.app, rid: recB, is_current: true, valid_to: null },
      );
      const { rows: sgF01Rows } = await observer.query(
        `select app_user_id::text as uid, is_current
           from public.direct_entry_scope_grants
          where team_id = $1::uuid and scope_kind = 'team'
          order by created_at asc`,
        [teamF01Link],
      );
      assert.equal(sgF01Rows.length, 0);
      const { rows: cgF01Rows } = await observer.query(
        `select app_user_id::text as uid, is_current
           from public.direct_entry_capability_grants
          where app_user_id = any($1::uuid[]) and capability = 'team_manager_assign'
          order by created_at asc`,
        [[adminA.acc.app, B.app]],
      );
      assert.equal(cgF01Rows.length, 0);

      const { rows: bLinksPost } = await observer.query(
        `select recruiter_id::text as rid, verified, is_current
           from public.direct_entry_app_user_recruiter_links
          where app_user_id = $1::uuid or recruiter_id = $2::uuid`,
        [B.app, recX],
      );
      assert.deepEqual(bLinksPost, [{ rid: recB, verified: true, is_current: true }]);
      const { rows: [idemPost] } = await observer.query(
        `select count(*)::int as cnt
           from public.direct_entry_rpc_idempotency
          where app_user_id = $1::uuid and action = 'account_recruiter_link_create' and idempotency_key = $2`,
        [adminA.acc.app, linkKey],
      );
      assert.equal(idemPost.cnt, 0);

      console.log(
        `[PG18 F01 link_recruiter] A=${adminA.acc.app} B=${B.app} waitPx=${JSON.stringify(waitW1OnPx)} nowaitA_B=SUCCEEDED(0_55P03) waitPb=${JSON.stringify(waitW1OnPb)} winner=DESIGNATE_TL(B,v3) loser=LINK_RECRUITER(PT409:RECRUITER_IDENTITY_CONFLICT,rolled_back) deadlocks=0`,
      );
    }

    // F-01 (2): Post-lock NOWAIT / zero premature FOR KEY SHARE on actor for the other 3 RPCs
    {
      const adminA2 = await seedF01SystemAdmin("nowait_a2");
      const tgt = await seedPlainAccount(setup, "f01.nowait.tgt", "F01 Nowait Target");
      const teamM1 = nextUuid();
      const teamM2 = nextUuid();
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, 'WP10_F01_M1', 'F01 Team M1', true, 1),
                ($2::uuid, 'WP10_F01_M2', 'F01 Team M2', true, 1)`,
        [teamM1, teamM2],
      );
      const pTgt = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-NW-TGT",
          tgt.name,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          tgt.app,
          1,
          null,
          "F01 nowait target person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-NW-TGT",
            full_name: tgt.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: tgt.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "F01 nowait target person",
          }),
        ])
      ).rows[0].data.person;
      const tgtVer = pTgt.active_account_link.account_version;

      // 2a. direct_entry_account_operation_create_personnel
      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pTgt.person_id]);
      await beginServiceTx(w1);
      const pCp = settleInTx(
        w1,
        w1.query(CREATE_PERSONNEL_FROM_ACC_SQL, [
          adminA2.acc.auth,
          adminA2.acc.app,
          tgt.app,
          tgtVer,
          tgt.login,
          "STAFF",
          null,
          "F01 create_personnel nowait",
          nextUuid(),
        ]),
      );
      const waitCp = await waitUntilBlocked(observer, "wp10-2-w1");
      assert.equal(waitCp.wait_event_type, "Lock");
      assert.equal(waitCp.locktype, "advisory");
      await checkUserRowNowaitUnlocked(observer, adminA2.acc.app);
      await checkUserRowNowaitUnlocked(observer, tgt.app);
      await wH.query("commit");
      const rCp = await pCp;
      assertNotDeadlock(rCp, "F01 create_personnel nowait");
      assert.equal(rCp.status, "fulfilled");
      const recTgtId = rCp.value.rows[0].data.recruiter_id;

      // 2b. direct_entry_assign_team_membership
      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pTgt.person_id]);
      await beginServiceTx(w1);
      const pAt = settleInTx(
        w1,
        w1.query(ASSIGN_TEAM_SQL, [
          adminA2.acc.auth,
          adminA2.acc.app,
          recTgtId,
          teamM1,
          null,
          1,
          "F01 assign_team nowait",
          nextUuid(),
        ]),
      );
      const waitAt = await waitUntilBlocked(observer, "wp10-2-w1");
      assert.equal(waitAt.wait_event_type, "Lock");
      assert.equal(waitAt.locktype, "advisory");
      await checkUserRowNowaitUnlocked(observer, adminA2.acc.app);
      await checkUserRowNowaitUnlocked(observer, tgt.app);
      await wH.query("commit");
      const rAt = await pAt;
      assertNotDeadlock(rAt, "F01 assign_team nowait");
      assert.equal(rAt.status, "fulfilled");
      assert.equal(rAt.value.rows[0].data.recruiter_version, 2);

      // 2c. direct_entry_move_team_membership
      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pTgt.person_id]);
      await beginServiceTx(w1);
      const pMv = settleInTx(
        w1,
        w1.query(MOVE_TEAM_SQL, [
          adminA2.acc.auth,
          adminA2.acc.app,
          recTgtId,
          teamM2,
          null,
          2,
          "F01 move_team nowait",
          nextUuid(),
        ]),
      );
      const waitMv = await waitUntilBlocked(observer, "wp10-2-w1");
      assert.equal(waitMv.wait_event_type, "Lock");
      assert.equal(waitMv.locktype, "advisory");
      await checkUserRowNowaitUnlocked(observer, adminA2.acc.app);
      await checkUserRowNowaitUnlocked(observer, tgt.app);
      await wH.query("commit");
      const rMv = await pMv;
      assertNotDeadlock(rMv, "F01 move_team nowait");
      assert.equal(rMv.status, "fulfilled");
      assert.equal(rMv.value.rows[0].data.recruiter_version, 3);

      const { rows: mvRows } = await observer.query(
        `select team_id::text as tid, is_current
           from public.recruiter_team_memberships
          where recruiter_id = $1::uuid
          order by created_at asc`,
        [recTgtId],
      );
      assert.deepEqual(mvRows, [
        { tid: teamM1, is_current: false },
        { tid: teamM2, is_current: true },
      ]);

      console.log(
        `[PG18 F01 3-RPC-nowait] actor=${adminA2.acc.app} cpWait=${waitCp.locktype} atWait=${waitAt.locktype} mvWait=${waitMv.locktype} nowaitActor=SUCCEEDED(all3,0_55P03) finalTeam=${teamM2}(v3) deadlocks=0`,
      );
    }

    // F-01 (3): Active G1 + G2 TL Admin actor operating on MARKETING & RECRUITMENT targets without self-block
    {
      const teamActor = nextUuid();
      const teamTarget2 = nextUuid();
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, 'WP10_F01_ACT_T1', 'F01 Actor TL Team', true, 1),
                ($2::uuid, 'WP10_F01_ACT_T2', 'F01 Target Team 2', true, 1)`,
        [teamActor, teamTarget2],
      );
      const adminTl = await seedF01SystemAdmin("tl_actor", { withRecruitmentTLTeamId: teamActor });

      // Target 1: MARKETING person + account (no team assignment) -> actor calls create_personnel
      const mkt1 = await seedPlainAccount(setup, "f01.mkt1", "F01 Mkt User 1");
      const pMkt1 = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-MKT1",
          mkt1.name,
          "2026-10-01",
          deptByKey.MARKETING,
          mkt1.app,
          1,
          null,
          "F01 mkt1 person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-MKT1",
            full_name: mkt1.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.MARKETING,
            account_ref: mkt1.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "F01 mkt1 person",
          }),
        ])
      ).rows[0].data.person;
      const cpMktRes = (
        await serviceQuery(setup, CREATE_PERSONNEL_FROM_ACC_SQL, [
          adminTl.acc.auth,
          adminTl.acc.app,
          mkt1.app,
          pMkt1.active_account_link.account_version,
          mkt1.login,
          "STAFF",
          null,
          "F01 actor G1/G2 non-self-block create_personnel",
          nextUuid(),
        ])
      ).rows[0].data;
      assert.ok(cpMktRes.recruiter_id);

      // Target 2: MARKETING person + account + unlinked HRP recruiter -> actor calls link_recruiter
      const recMkt2 = await seedPlainUnlinkedHrpRecruiter(setup, "f01.mkt2", "F01 Mkt User 2");
      const mkt2 = await seedPlainAccount(setup, "f01.mkt2", "F01 Mkt User 2");
      const pMkt2 = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-MKT2",
          mkt2.name,
          "2026-10-01",
          deptByKey.MARKETING,
          mkt2.app,
          1,
          null,
          "F01 mkt2 person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-MKT2",
            full_name: mkt2.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.MARKETING,
            account_ref: mkt2.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "F01 mkt2 person",
          }),
        ])
      ).rows[0].data.person;
      const lrMktRes = (
        await serviceQuery(setup, LINK_RECRUITER_SQL, [
          adminTl.acc.auth,
          adminTl.acc.app,
          recMkt2,
          1,
          mkt2.app,
          pMkt2.active_account_link.account_version,
          "F01 actor G1/G2 non-self-block link_recruiter",
          nextUuid(),
        ])
      ).rows[0].data;
      assert.equal(lrMktRes.recruiter_id, recMkt2);

      // Target 3: RECRUITMENT target -> actor calls assign_team_membership & move_team_membership
      const rec3Meta = await makeActiveRecruitmentAccountPerson("f01.rec3");
      const atRec3Res = (
        await serviceQuery(setup, ASSIGN_TEAM_SQL, [
          adminTl.acc.auth,
          adminTl.acc.app,
          rec3Meta.recruiterId,
          teamActor,
          null,
          1,
          "F01 actor assign rec3",
          nextUuid(),
        ])
      ).rows[0].data;
      assert.equal(atRec3Res.team_id, teamActor);
      const mvRec3Res = (
        await serviceQuery(setup, MOVE_TEAM_SQL, [
          adminTl.acc.auth,
          adminTl.acc.app,
          rec3Meta.recruiterId,
          teamTarget2,
          null,
          atRec3Res.recruiter_version,
          "F01 actor move rec3",
          nextUuid(),
        ])
      ).rows[0].data;
      assert.equal(mvRec3Res.team_id, teamTarget2);

      // Verify actor's own G1 + G2 TL assignment remained intact
      const { rows: [actorState] } = await observer.query(
        `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid and team_id = $2::uuid and is_current = true) as g1,
                (select count(*)::int from public.direct_entry_team_leader_assignments where leader_app_user_id = $3::uuid and team_id = $2::uuid and is_current = true) as g2`,
        [adminTl.recruiterId, teamActor, adminTl.acc.app],
      );
      assert.deepEqual(actorState, { g1: 1, g2: 1 });

      console.log(
        `[PG18 F01 actor-not-self-blocked] actor=${adminTl.acc.app}(G1=1,G2=1) createPersonnelMkt=${cpMktRes.recruiter_id} linkRecruiterMkt=${lrMktRes.link_id} assignMoveRec=${teamTarget2}`,
      );
    }

    // F-01 (4): Concurrent same-key single write + different-payload rejection + cross-midnight replay (all 4 RPCs)
    {
      const adminIdem = await seedF01SystemAdmin("idem_a");
      const teamIdem1 = nextUuid();
      const teamIdem2 = nextUuid();
      await setup.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, 'WP10_F01_IDEM_T1', 'F01 Idem Team 1', true, 1),
                ($2::uuid, 'WP10_F01_IDEM_T2', 'F01 Idem Team 2', true, 1)`,
        [teamIdem1, teamIdem2],
      );

      // 4a. create_personnel: concurrent same-key (2026-11-24) -> diff-payload 22023 -> cross-midnight replay (2026-11-25)
      await setBusinessDate(setup, "2026-11-24");
      const uCp = await seedPlainAccount(setup, "f01.idem.cp", "F01 Idem CP User");
      const pCp = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-IDEM-CP",
          uCp.name,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          uCp.app,
          1,
          null,
          "F01 idem cp person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-IDEM-CP",
            full_name: uCp.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: uCp.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "F01 idem cp person",
          }),
        ])
      ).rows[0].data.person;
      const uCpInitVer = pCp.active_account_link.account_version;
      const keyCp = nextUuid();
      const cpParams = [
        adminIdem.acc.auth,
        adminIdem.acc.app,
        uCp.app,
        uCpInitVer,
        uCp.login,
        "STAFF",
        null,
        "F01 concurrent same-key cp",
        keyCp,
      ];

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pCp.person_id]);
      await beginServiceTx(w1);
      const pCp1 = settleInTx(w1, w1.query(CREATE_PERSONNEL_FROM_ACC_SQL, cpParams));
      await beginServiceTx(w2);
      const pCp2 = settleInTx(w2, w2.query(CREATE_PERSONNEL_FROM_ACC_SQL, cpParams));
      await waitUntilBlocked(observer, "wp10-2-w1");
      await waitUntilBlocked(observer, "wp10-2-w2");
      await wH.query("commit");
      const [rCp1, rCp2] = await Promise.all([pCp1, pCp2]);
      assertNotDeadlock(rCp1, "F01 same-key cp 1");
      assertNotDeadlock(rCp2, "F01 same-key cp 2");
      assert.equal(rCp1.status, "fulfilled");
      assert.equal(rCp2.status, "fulfilled");
      assert.deepEqual(rCp1.value.rows[0].data, rCp2.value.rows[0].data);
      const recCpId = rCp1.value.rows[0].data.recruiter_id;

      const { rows: [cpDbCheck] } = await observer.query(
        `select (select count(*)::int from public.recruiters where lower(personnel_code) = $1) as rec_cnt,
                (select version from public.direct_entry_app_users where app_user_id = $2::uuid) as acc_ver,
                (select count(*)::int from public.direct_entry_audit_events where action = 'personnel_created' and resource_ref = $3) as audit_cnt`,
        [uCp.login, uCp.app, recCpId],
      );
      assert.deepEqual(cpDbCheck, { rec_cnt: 1, acc_ver: uCpInitVer + 1, audit_cnt: 1 });

      await assert.rejects(
        () =>
          serviceQuery(setup, CREATE_PERSONNEL_FROM_ACC_SQL, [
            adminIdem.acc.auth,
            adminIdem.acc.app,
            uCp.app,
            uCpInitVer,
            uCp.login,
            "TEAM_LEADER",
            null,
            "F01 concurrent same-key cp",
            keyCp,
          ]),
        (err) => err?.code === "22023" && /idempotency key reused with different input/.test(err?.message ?? ""),
      );
      const { rows: [cpPostDiff] } = await observer.query(
        "select version, (select count(*)::int from public.recruiters where lower(personnel_code) = $1) as rec_cnt from public.direct_entry_app_users where app_user_id = $2::uuid",
        [uCp.login, uCp.app],
      );
      assert.deepEqual(cpPostDiff, { version: uCpInitVer + 1, rec_cnt: 1 });

      await setBusinessDate(setup, "2026-11-25");
      const cpMidnight = (await serviceQuery(setup, CREATE_PERSONNEL_FROM_ACC_SQL, cpParams)).rows[0].data;
      assert.deepEqual(cpMidnight, rCp1.value.rows[0].data);

      // 4b. link_recruiter: concurrent same-key (2026-11-25) -> diff-payload 22023 -> cross-midnight replay (2026-11-26)
      const recLr = await seedPlainUnlinkedHrpRecruiter(setup, "f01.idem.lr", "F01 Idem LR User");
      const uLr = await seedPlainAccount(setup, "f01.idem.lr", "F01 Idem LR User");
      const pLr = (
        await serviceQuery(setup, CREATE_PERSON_SQL, [
          OWNER.auth,
          OWNER.app,
          "EMP-F01-IDEM-LR",
          uLr.name,
          "2026-10-01",
          deptByKey.RECRUITMENT,
          uLr.app,
          1,
          null,
          "F01 idem lr person",
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: "EMP-F01-IDEM-LR",
            full_name: uLr.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: uLr.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "F01 idem lr person",
          }),
        ])
      ).rows[0].data.person;
      const uLrInitVer = pLr.active_account_link.account_version;
      const keyLr = nextUuid();
      const lrParams = [
        adminIdem.acc.auth,
        adminIdem.acc.app,
        recLr,
        1,
        uLr.app,
        uLrInitVer,
        "F01 concurrent same-key lr",
        keyLr,
      ];

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pLr.person_id]);
      await beginServiceTx(w1);
      const pLr1 = settleInTx(w1, w1.query(LINK_RECRUITER_SQL, lrParams));
      await beginServiceTx(w2);
      const pLr2 = settleInTx(w2, w2.query(LINK_RECRUITER_SQL, lrParams));
      await waitUntilBlocked(observer, "wp10-2-w1");
      await waitUntilBlocked(observer, "wp10-2-w2");
      await wH.query("commit");
      const [rLr1, rLr2] = await Promise.all([pLr1, pLr2]);
      assertNotDeadlock(rLr1, "F01 same-key lr 1");
      assertNotDeadlock(rLr2, "F01 same-key lr 2");
      assert.equal(rLr1.status, "fulfilled");
      assert.equal(rLr2.status, "fulfilled");
      assert.deepEqual(rLr1.value.rows[0].data, rLr2.value.rows[0].data);

      const { rows: [lrDbCheck] } = await observer.query(
        `select (select count(*)::int from public.direct_entry_app_user_recruiter_links where app_user_id = $1::uuid and is_current = true) as link_cnt,
                (select version from public.direct_entry_app_users where app_user_id = $1::uuid) as acc_ver,
                (select count(*)::int from public.direct_entry_audit_events where action = 'link_create' and resource_ref = $1::text) as audit_cnt`,
        [uLr.app],
      );
      assert.deepEqual(lrDbCheck, { link_cnt: 1, acc_ver: uLrInitVer + 1, audit_cnt: 1 });

      await assert.rejects(
        () =>
          serviceQuery(setup, LINK_RECRUITER_SQL, [
            adminIdem.acc.auth,
            adminIdem.acc.app,
            recLr,
            1,
            uLr.app,
            uLrInitVer,
            "F01 diff lr reason",
            keyLr,
          ]),
        (err) => err?.code === "22023" && /idempotency key reused with different input/.test(err?.message ?? ""),
      );
      const { rows: [lrPostDiff] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [uLr.app],
      );
      assert.equal(lrPostDiff.version, uLrInitVer + 1);

      await setBusinessDate(setup, "2026-11-26");
      const lrMidnight = (await serviceQuery(setup, LINK_RECRUITER_SQL, lrParams)).rows[0].data;
      assert.deepEqual(lrMidnight, rLr1.value.rows[0].data);

      // 4c. assign_team_membership: concurrent same-key (2026-11-26, explicit date) -> diff-payload 22023 -> cross-midnight replay (2026-11-27)
      const keyAt = nextUuid();
      const atParams = [
        adminIdem.acc.auth,
        adminIdem.acc.app,
        recLr,
        teamIdem1,
        "2026-11-26",
        1,
        "F01 concurrent same-key assign",
        keyAt,
      ];

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pLr.person_id]);
      await beginServiceTx(w1);
      const pAt1 = settleInTx(w1, w1.query(ASSIGN_TEAM_SQL, atParams));
      await beginServiceTx(w2);
      const pAt2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, atParams));
      await waitUntilBlocked(observer, "wp10-2-w1");
      await waitUntilBlocked(observer, "wp10-2-w2");
      await wH.query("commit");
      const [rAt1, rAt2] = await Promise.all([pAt1, pAt2]);
      assertNotDeadlock(rAt1, "F01 same-key assign 1");
      assertNotDeadlock(rAt2, "F01 same-key assign 2");
      assert.equal(rAt1.status, "fulfilled");
      assert.equal(rAt2.status, "fulfilled");
      assert.deepEqual(rAt1.value.rows[0].data, rAt2.value.rows[0].data);

      const { rows: [atDbCheck] } = await observer.query(
        `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid) as mem_cnt,
                (select version from public.recruiters where recruiter_id = $1::uuid) as rec_ver,
                (select count(*)::int from public.direct_entry_audit_events where action = 'team_membership_assign' and resource_ref = $1::text) as audit_cnt`,
        [recLr],
      );
      assert.deepEqual(atDbCheck, { mem_cnt: 1, rec_ver: 2, audit_cnt: 1 });

      await assert.rejects(
        () =>
          serviceQuery(setup, ASSIGN_TEAM_SQL, [
            adminIdem.acc.auth,
            adminIdem.acc.app,
            recLr,
            teamIdem2,
            "2026-11-26",
            1,
            "F01 concurrent same-key assign",
            keyAt,
          ]),
        (err) => err?.code === "22023" && /idempotency key reused with different input/.test(err?.message ?? ""),
      );
      const { rows: [atPostDiff] } = await observer.query(
        `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid) as mem_cnt,
                (select version from public.recruiters where recruiter_id = $1::uuid) as rec_ver`,
        [recLr],
      );
      assert.deepEqual(atPostDiff, { mem_cnt: 1, rec_ver: 2 });

      await setBusinessDate(setup, "2026-11-27");
      const atMidnight = (await serviceQuery(setup, ASSIGN_TEAM_SQL, atParams)).rows[0].data;
      assert.deepEqual(atMidnight, rAt1.value.rows[0].data);

      // 4d. move_team_membership: concurrent same-key (2026-11-27, explicit date) -> diff-payload 22023 -> cross-midnight replay (2026-11-28)
      const keyMv = nextUuid();
      const mvParams = [
        adminIdem.acc.auth,
        adminIdem.acc.app,
        recLr,
        teamIdem2,
        "2026-11-27",
        2,
        "F01 concurrent same-key move",
        keyMv,
      ];

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select public.org_department__internal_lock_person($1::uuid)", [pLr.person_id]);
      await beginServiceTx(w1);
      const pMv1 = settleInTx(w1, w1.query(MOVE_TEAM_SQL, mvParams));
      await beginServiceTx(w2);
      const pMv2 = settleInTx(w2, w2.query(MOVE_TEAM_SQL, mvParams));
      await waitUntilBlocked(observer, "wp10-2-w1");
      await waitUntilBlocked(observer, "wp10-2-w2");
      await wH.query("commit");
      const [rMv1, rMv2] = await Promise.all([pMv1, pMv2]);
      assertNotDeadlock(rMv1, "F01 same-key move 1");
      assertNotDeadlock(rMv2, "F01 same-key move 2");
      assert.equal(rMv1.status, "fulfilled");
      assert.equal(rMv2.status, "fulfilled");
      assert.deepEqual(rMv1.value.rows[0].data, rMv2.value.rows[0].data);

      const { rows: [mvDbCheck] } = await observer.query(
        `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true and team_id = $2::uuid) as cur_t2,
                (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid) as mem_cnt,
                (select version from public.recruiters where recruiter_id = $1::uuid) as rec_ver,
                (select count(*)::int from public.direct_entry_audit_events where action = 'team_membership_move' and resource_ref = $1::text) as audit_cnt`,
        [recLr, teamIdem2],
      );
      assert.deepEqual(mvDbCheck, { cur_t2: 1, mem_cnt: 2, rec_ver: 3, audit_cnt: 1 });

      await assert.rejects(
        () =>
          serviceQuery(setup, MOVE_TEAM_SQL, [
            adminIdem.acc.auth,
            adminIdem.acc.app,
            recLr,
            teamIdem1,
            "2026-11-27",
            2,
            "F01 concurrent same-key move",
            keyMv,
          ]),
        (err) => err?.code === "22023" && /idempotency key reused with different input/.test(err?.message ?? ""),
      );
      const { rows: [mvPostDiff] } = await observer.query(
        `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid) as mem_cnt,
                (select version from public.recruiters where recruiter_id = $1::uuid) as rec_ver`,
        [recLr],
      );
      assert.deepEqual(mvPostDiff, { mem_cnt: 2, rec_ver: 3 });

      await setBusinessDate(setup, "2026-11-28");
      const mvMidnight = (await serviceQuery(setup, MOVE_TEAM_SQL, mvParams)).rows[0].data;
      assert.deepEqual(mvMidnight, rMv1.value.rows[0].data);

      console.log(
        `[PG18 F01 idempotency-midnight] cp(v=${cpDbCheck.acc_ver},cnt=1,22023=OK,midnight=2026-11-25) lr(v=${lrDbCheck.acc_ver},cnt=1,22023=OK,midnight=2026-11-26) assign(v=2,cnt=1,22023=OK,midnight=2026-11-27) move(v=3,cnt=2,22023=OK,midnight=2026-11-28) deadlocks=0`,
      );
    }

    // -------------------------------------------------------------------------
    // P2-end-accounting: `org_department_end_accounting_member` Tier-U [actor, target]
    // vs `direct_entry_account_operation_create_personnel` (`A < B`) + same-account dedupe
    // -------------------------------------------------------------------------
    {
      await setBusinessDate(setup, "2026-11-24");

      async function seedAccountingCrossAdminPair(tag) {
        const A = await seedPlainAccount(setup, `p2end.${tag}.a`, `P2 End Admin A ${tag}`);
        const B = await seedPlainAccount(setup, `p2end.${tag}.b`, `P2 End Admin B ${tag}`);
        assert.ok(A.app < B.app, `Expected A.app < B.app (${A.app} vs ${B.app})`);

        for (const acc of [A, B]) {
          const rSys = (
            await serviceQuery(setup, ASSIGN_GROUP_MEMBER_SQL, [
              OWNER.auth,
              OWNER.app,
              acc.app,
              sysAdminGroup.group_id,
              1,
              `Assign SYSTEM_ADMIN ${acc.login}`,
              nextUuid(),
              createHash("sha256").update(`p2end:${tag}:sysadmin:${acc.app}`).digest("hex"),
            ])
          ).rows[0].data;
          acc.version = rSys.account_version;
        }

        const empCode = `EMP-P2END-${tag.toUpperCase()}-A`;
        const personA = (
          await serviceQuery(setup, CREATE_PERSON_SQL, [
            OWNER.auth,
            OWNER.app,
            empCode,
            A.name,
            "2026-10-01",
            deptByKey.RECRUITMENT,
            A.app,
            A.version,
            null,
            `Onboard ${A.login}`,
            nextUuid(),
            computeCreatePersonFingerprint(OWNER.app, {
              employee_code: empCode,
              full_name: A.name,
              joined_on: "2026-10-01",
              initial_department_ref: deptByKey.RECRUITMENT,
              account_ref: A.app,
              expected_account_version: A.version,
              recruiter_id: null,
              reason: `Onboard ${A.login}`,
            }),
          ])
        ).rows[0].data.person;
        A.version = personA.active_account_link.account_version;

        const assignB = (
          await serviceQuery(setup, ASSIGN_ACCOUNTING_SQL, [
            OWNER.auth,
            OWNER.app,
            B.app,
            0,
            null,
            `Assign Accounting ${B.login}`,
            nextUuid(),
            computeAssignAccountingMemberFingerprint({
              actor_app_user_id: OWNER.app,
              account_ref: B.app,
              expected_pair_version: 0,
              effective_from: null,
              reason: `Assign Accounting ${B.login}`,
            }),
          ])
        ).rows[0].data;

        return { A, B, personA, membershipBId: assignB.membership.membership_id };
      }

      // Case 1: End-first barrier (`wH` locks membership_B; `w1` end(A->B) blocks on wH; `w2` create_personnel(B->A) blocks on w1)
      const c1 = await seedAccountingCrossAdminPair("case1");
      const endKey1 = nextUuid();
      const endReason1 = "P2-end Case 1 A ends B accounting";
      const endFp1 = computeEndAccountingMemberFingerprint({
        actor_app_user_id: c1.A.app,
        membership_id: c1.membershipBId,
        expected_pair_version: 1,
        effective_to: null,
        reason: endReason1,
      });

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query(
        "select membership_id from public.organization_department_memberships where membership_id = $1::uuid for update",
        [c1.membershipBId],
      );

      await beginServiceTx(w1);
      const pEnd1 = settleInTx(
        w1,
        w1.query(END_ACCOUNTING_SQL, [c1.A.auth, c1.A.app, c1.membershipBId, 1, null, endReason1, endKey1, endFp1]),
      );
      const waitEndFirst1 = await waitUntilBlocked(observer, "wp10-2-w1");

      await beginServiceTx(w2);
      const pCreate2 = settleInTx(
        w2,
        w2.query(CREATE_PERSONNEL_FROM_ACC_SQL, [
          c1.B.auth,
          c1.B.app,
          c1.A.app,
          c1.A.version,
          c1.A.login,
          "STAFF",
          null,
          "P2-end Case 1 B creates personnel for A",
          nextUuid(),
        ]),
      );
      const waitCreateSecond1 = await waitUntilBlocked(observer, "wp10-2-w2");

      await wH.query("commit");
      const [rEnd1, rCreate1] = await Promise.all([pEnd1, pCreate2]);
      assertNotDeadlock(rEnd1, "P2-end Case 1 end_accounting_member");
      assertNotDeadlock(rCreate1, "P2-end Case 1 create_personnel");
      assert.equal(rEnd1.status, "fulfilled");
      assert.equal(rCreate1.status, "fulfilled");
      assert.equal(rEnd1.value.rows[0].data.replayed, false);
      assert.equal(rEnd1.value.rows[0].data.membership.valid_to, "2026-11-24");
      assert.equal(rEnd1.value.rows[0].data.membership.version, 2);

      const recA1 = rCreate1.value.rows[0].data.recruiter_id;
      const { rows: [c1Db] } = await observer.query(
        `select m.valid_to::text as valid_to,
                m.revoked_by_user_id::text as revoked_by_user_id,
                m.version as mem_ver,
                (select count(*)::int from public.organization_department_audit_events where membership_id = m.membership_id and action = 'ACCOUNTING_MEMBER_ENDED') as end_audit_cnt,
                (select count(*)::int from public.organization_department_idempotency where actor_user_id = $2::uuid and idempotency_key = $3::uuid and action = 'ACCOUNTING_MEMBER_ENDED') as end_idem_cnt,
                (select count(*)::int from public.recruiters r where r.recruiter_id = $4::uuid and r.personnel_code = $5 and r.active = true) as rec_cnt,
                (select count(*)::int from public.direct_entry_app_user_recruiter_links l where l.app_user_id = $2::uuid and l.recruiter_id = $4::uuid and l.is_current = true and l.verified = true) as url_cnt,
                (select count(*)::int from public.direct_entry_audit_events ae where ae.action = 'personnel_created' and ae.resource_ref = $4::text) as cp_audit_cnt,
                (select count(*)::int from public.direct_entry_audit_events ae where ae.action = 'link_create' and ae.resource_ref = $2::text) as link_audit_cnt
           from public.organization_department_memberships m
          where m.membership_id = $1::uuid`,
        [c1.membershipBId, c1.A.app, endKey1, recA1, c1.A.login],
      );
      assert.deepEqual(c1Db, {
        valid_to: "2026-11-24",
        revoked_by_user_id: c1.A.app,
        mem_ver: 2,
        end_audit_cnt: 1,
        end_idem_cnt: 1,
        rec_cnt: 1,
        url_cnt: 1,
        cp_audit_cnt: 1,
        link_audit_cnt: 1,
      });

      const replayEnd1 = (
        await serviceQuery(setup, END_ACCOUNTING_SQL, [
          c1.A.auth,
          c1.A.app,
          c1.membershipBId,
          1,
          null,
          endReason1,
          endKey1,
          endFp1,
        ])
      ).rows[0].data;
      assert.equal(replayEnd1.replayed, true);
      assert.deepEqual(replayEnd1.membership, rEnd1.value.rows[0].data.membership);

      await assert.rejects(
        () =>
          serviceQuery(setup, END_ACCOUNTING_SQL, [
            c1.A.auth,
            c1.A.app,
            c1.membershipBId,
            1,
            null,
            endReason1,
            nextUuid(),
            endFp1,
          ]),
        (err) => err?.code === "PT409" && /DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT/.test(err?.message ?? ""),
      );

      // Case 2: Create-personnel-first barrier (`wH` locks B2; `w2` create_personnel(B2->A2) holds A2 and blocks on B2; `w1` end(A2->B2) blocks on A2)
      const c2 = await seedAccountingCrossAdminPair("case2");
      const endKey2 = nextUuid();
      const endReason2 = "P2-end Case 2 A2 ends B2 accounting";
      const endFp2 = computeEndAccountingMemberFingerprint({
        actor_app_user_id: c2.A.app,
        membership_id: c2.membershipBId,
        expected_pair_version: 1,
        effective_to: null,
        reason: endReason2,
      });

      await wH.query("begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '8s'");
      await wH.query("select app_user_id from public.direct_entry_app_users where app_user_id = $1::uuid for update", [
        c2.B.app,
      ]);

      await beginServiceTx(w2);
      const pCreateFirst2 = settleInTx(
        w2,
        w2.query(CREATE_PERSONNEL_FROM_ACC_SQL, [
          c2.B.auth,
          c2.B.app,
          c2.A.app,
          c2.A.version,
          c2.A.login,
          "STAFF",
          null,
          "P2-end Case 2 B2 creates personnel for A2",
          nextUuid(),
        ]),
      );
      const waitCreateFirst2 = await waitUntilBlocked(observer, "wp10-2-w2");

      await beginServiceTx(w1);
      const pEndSecond2 = settleInTx(
        w1,
        w1.query(END_ACCOUNTING_SQL, [c2.A.auth, c2.A.app, c2.membershipBId, 1, null, endReason2, endKey2, endFp2]),
      );
      const waitEndSecond2 = await waitUntilBlocked(observer, "wp10-2-w1");

      await wH.query("commit");
      const [rCreate2, rEnd2] = await Promise.all([pCreateFirst2, pEndSecond2]);
      assertNotDeadlock(rCreate2, "P2-end Case 2 create_personnel");
      assertNotDeadlock(rEnd2, "P2-end Case 2 end_accounting_member");
      assert.equal(rCreate2.status, "fulfilled");
      assert.equal(rEnd2.status, "fulfilled");
      assert.equal(rEnd2.value.rows[0].data.membership.valid_to, "2026-11-24");
      assert.equal(rEnd2.value.rows[0].data.membership.version, 2);

      const recA2 = rCreate2.value.rows[0].data.recruiter_id;
      const { rows: [c2Db] } = await observer.query(
        `select m.valid_to::text as valid_to,
                m.revoked_by_user_id::text as revoked_by_user_id,
                m.version as mem_ver,
                (select count(*)::int from public.organization_department_audit_events where membership_id = m.membership_id and action = 'ACCOUNTING_MEMBER_ENDED') as end_audit_cnt,
                (select count(*)::int from public.recruiters r where r.recruiter_id = $3::uuid and r.personnel_code = $4 and r.active = true) as rec_cnt,
                (select count(*)::int from public.direct_entry_app_user_recruiter_links l where l.app_user_id = $2::uuid and l.recruiter_id = $3::uuid and l.is_current = true and l.verified = true) as url_cnt,
                (select count(*)::int from public.direct_entry_audit_events ae where ae.action = 'personnel_created' and ae.resource_ref = $3::text) as cp_audit_cnt
           from public.organization_department_memberships m
          where m.membership_id = $1::uuid`,
        [c2.membershipBId, c2.A.app, recA2, c2.A.login],
      );
      assert.deepEqual(c2Db, {
        valid_to: "2026-11-24",
        revoked_by_user_id: c2.A.app,
        mem_ver: 2,
        end_audit_cnt: 1,
        rec_cnt: 1,
        url_cnt: 1,
        cp_audit_cnt: 1,
      });

      // Case 3: Same-account dedupe (`actor = target = C` ends own Accounting membership cleanly)
      const C = await seedPlainAccount(setup, "p2end.self.c", "P2 End Self Admin C");
      await serviceQuery(setup, ASSIGN_GROUP_MEMBER_SQL, [
        OWNER.auth,
        OWNER.app,
        C.app,
        sysAdminGroup.group_id,
        1,
        "Assign SYSTEM_ADMIN P2-end self C",
        nextUuid(),
        createHash("sha256").update(`p2end:self:${C.app}`).digest("hex"),
      ]);
      const membershipCId = (
        await serviceQuery(setup, ASSIGN_ACCOUNTING_SQL, [
          OWNER.auth,
          OWNER.app,
          C.app,
          0,
          null,
          "Assign Accounting self C",
          nextUuid(),
          computeAssignAccountingMemberFingerprint({
            actor_app_user_id: OWNER.app,
            account_ref: C.app,
            expected_pair_version: 0,
            effective_from: null,
            reason: "Assign Accounting self C",
          }),
        ])
      ).rows[0].data.membership.membership_id;

      const endKeySelf = nextUuid();
      const endReasonSelf = "P2-end Case 3 C ends own accounting";
      const endFpSelf = computeEndAccountingMemberFingerprint({
        actor_app_user_id: C.app,
        membership_id: membershipCId,
        expected_pair_version: 1,
        effective_to: null,
        reason: endReasonSelf,
      });
      const selfRes = (
        await serviceQuery(setup, END_ACCOUNTING_SQL, [
          C.auth,
          C.app,
          membershipCId,
          1,
          null,
          endReasonSelf,
          endKeySelf,
          endFpSelf,
        ])
      ).rows[0].data;
      assert.equal(selfRes.replayed, false);
      assert.equal(selfRes.membership.valid_to, "2026-11-24");
      assert.equal(selfRes.membership.version, 2);

      const selfReplay = (
        await serviceQuery(setup, END_ACCOUNTING_SQL, [
          C.auth,
          C.app,
          membershipCId,
          1,
          null,
          endReasonSelf,
          endKeySelf,
          endFpSelf,
        ])
      ).rows[0].data;
      assert.equal(selfReplay.replayed, true);
      assert.deepEqual(selfReplay.membership, selfRes.membership);

      console.log(
        `[PG18 P2-end-accounting] c1(A=${c1.A.app},B=${c1.B.app},waitEnd=${waitEndFirst1.wait_event},waitCreate=${waitCreateSecond1.wait_event},memVer=${c1Db.mem_ver},rec=${c1Db.rec_cnt}) c2(A2=${c2.A.app},B2=${c2.B.app},waitCreate=${waitCreateFirst2.wait_event},waitEnd=${waitEndSecond2.wait_event},memVer=${c2Db.mem_ver},rec=${c2Db.rec_cnt}) c3(self=${C.app},memVer=${selfRes.membership.version},replayed=true) deadlocks=0`,
      );
    }
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
