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
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { computeCreateDepartmentFingerprint } from "../src/lib/departments/department-contract.ts";
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
const UNASSIGN_TEAM_SQL =
  "select public.direct_entry_unassign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7) as data";
const DESIGNATE_TL_SQL =
  "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8) as data";
const REVOKE_TL_SQL =
  "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7) as data";
const DISABLE_USER_SQL =
  "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6) as data";

test("WP10-2 Real PG18 Concurrency: C0-C5b bidirectional lock serialization, suspended links, same-day revoke v_restore, and 0 40P01 deadlocks", async () => {
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
    const w1 = await connect(port, "wp10-2-w1");
    const w2 = await connect(port, "wp10-2-w2");
    clients.push(setup, observer, w1, w2);

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
        assert.equal(r2.status, "fulfilled", "Plain HRP recruiter creation in CUSTOM_OPS allowed per Direction 3");
        const recId = r2.value.rows[0].data.recruiter_id;
        await assert.rejects(
          () => serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, 1, "C0 post check", nextUuid()]),
          (err) => err?.code === "23514",
        );
      }
    }

    // -------------------------------------------------------------------------
    // C1 (both orders): assign_team_membership vs link_recruiter on MARKETING Account
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
        await assert.rejects(
          () =>
            serviceQuery(setup, LINK_RECRUITER_SQL, [
              OWNER.auth,
              OWNER.app,
              recId,
              2,
              acc.app,
              pMkt.active_account_link.account_version,
              "C1 retry fresh ver",
              nextUuid(),
            ]),
          (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
        );
        const { rows: links } = await observer.query(
          "select count(*)::int as cnt from public.direct_entry_app_user_recruiter_links where recruiter_id = $1::uuid and is_current = true",
          [recId],
        );
        assert.equal(links[0].cnt, 0);
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
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true",
          [recId],
        );
        assert.equal(teamRows[0].cnt, 0);
        const { rows: [recCur] } = await observer.query(
          "select version from public.recruiters where recruiter_id = $1::uuid",
          [recId],
        );
        await assert.rejects(
          () => serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recId, TEAM_A, null, recCur.version, "C1 assign retry after link", nextUuid()]),
          (err) => err?.code === "23514",
        );
      }
    }

    // -------------------------------------------------------------------------
    // C2 (both orders): transfer(ACCOUNTING) vs assign_team_membership (no optimistic version conflict!)
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
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.match(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);
        const { rows: [curMem] } = await observer.query(
          "select department_id from public.organization_person_department_memberships where person_id = $1::uuid and ended_at is null",
          [s.person.person_id],
        );
        assert.equal(curMem.department_id, deptByKey.RECRUITMENT);
      } else {
        await w1.query(TRANSFER_MEMBER_SQL, transferParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_A, null, 1, "C2 assign", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C2 transfer_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "23514");
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and is_current = true",
          [s.recruiterId],
        );
        assert.equal(teamRows[0].cnt, 0);
      }
    }

    // -------------------------------------------------------------------------
    // C3 (both orders): CUSTOM_OPS transfer & update_person(INACTIVE) vs assign_team_membership
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
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.match(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);
      } else {
        await w1.query(TRANSFER_MEMBER_SQL, customParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, s.recruiterId, TEAM_B, null, 1, "C3a assign", nextUuid()]));
        await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, "C3a custom_transfer_first");
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "23514");
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
        await assert.rejects(
          () => serviceQuery(setup, ASSIGN_TEAM_SQL, [OWNER.auth, OWNER.app, recSusp, TEAM_A, null, 1, "C4 link_first retry", nextUuid()]),
          (err) => err?.code === "23514",
        );

        const { rows: openLinks } = await observer.query(
          "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and person_id = $2::uuid and ended_at is null",
          [accSusp.app, pMkt.person_id],
        );
        const { rows: teamRows } = await observer.query(
          "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid",
          [recSusp],
        );
        assert.equal(openLinks[0].cnt, 1);
        assert.equal(teamRows[0].cnt, 0);
        console.log(
          `[PG18 C4 link_first] wait=${JSON.stringify(waitInfo)} winner=LINK_ACCOUNT_PERSON loser=ASSIGN_TEAM(PT409 post_lock_completeness -> 23514 on retry, rolled_back) openLinks=1 teamRows=0`,
        );
      } else {
        await w1.query(ASSIGN_TEAM_SQL, assignParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query(LINK_ACCOUNT_PERSON_SQL, linkParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-2-w2");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `C4 ${order}`);
        assert.equal(r2.status, "rejected");
        assert.equal(r2.reason?.code, "PT409");
        assert.match(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);

        const { rows: openLinks } = await observer.query(
          "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid or person_id = $2::uuid",
          [accSusp.app, pMkt.person_id],
        );
        const { rows: teamRows } = await observer.query(
          "select is_current, valid_to from public.recruiter_team_memberships where recruiter_id = $1::uuid",
          [recSusp],
        );
        assert.equal(openLinks[0].cnt, 0);
        assert.equal(teamRows.length, 1);
        assert.equal(teamRows[0].is_current, true);
        console.log(
          `[PG18 C4 assign_first] wait=${JSON.stringify(waitInfo)} winner=ASSIGN_TEAM loser=LINK_ACCOUNT_PERSON(PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT rolled_back) openLinks=0 activeG1=1`,
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
    //   A keeps active G1 on TEAM; race `revoke(B)` vs `transfer(pA, ACCOUNTING)` and vs `unassign(recA)`.
    // -------------------------------------------------------------------------
    {
      // C5a Order 1: revoke(B) uncommitted holds P(A) -> transfer(pA, ACCOUNTING) waits on Lock -> rejects PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT
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
      assert.equal(r2.status, "rejected");
      assert.equal(r2.reason?.code, "PT409");
      assert.match(r2.reason?.message ?? "", /PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT/);

      const st = await inspectC5State(c5a1.tId, c5a1.metaA.acc.app, c5a1.metaB.acc.app, c5a1.metaA.person.person_id);
      assert.equal(st.deptA, "RECRUITMENT");
      assert.equal(st.tlaRows.find((r) => r.uid === c5a1.metaA.acc.app)?.is_current, true);
      assert.deepEqual(st.tlaRows.find((r) => r.uid === c5a1.metaB.acc.app)?.valid_to, "2026-11-24");
      assert.equal(st.sgRows.find((r) => r.uid === c5a1.metaA.acc.app)?.is_current, true);
      assert.equal(st.sgRows.find((r) => r.uid === c5a1.metaB.acc.app)?.is_current, false);
      assert.equal(st.cgRows.find((r) => r.uid === c5a1.metaA.acc.app)?.is_current, true);
      assert.equal(st.cgRows.find((r) => r.uid === c5a1.metaB.acc.app)?.is_current, false);
      console.log(
        `[PG18 C5a Order 1 revoke_first] wait=${JSON.stringify(waitInfo)} winner=REVOKE(v_restore=true, A+SG+CG restored, B closed 0-len) loser=TRANSFER(PT409 rolled_back) deptA=RECRUITMENT`,
      );
    }

    {
      // C5a Order 2 (T0 note): while A keeps active G1, transfer(pA, ACCOUNTING) upfront is rejected immediately by G1, then revoke(B) commits restoring A
      const c5a2 = await setupC5Team("5A2");
      await assert.rejects(
        () =>
          serviceQuery(setup, TRANSFER_MEMBER_SQL, [
            OWNER.auth,
            OWNER.app,
            c5a2.metaA.person.person_id,
            deptByKey.ACCOUNTING,
            c5a2.pARow.pv,
            c5a2.pARow.membership_id,
            "C5a2 transfer blocked by G1",
            nextUuid(),
            computeTransferPersonDepartmentFingerprint(OWNER.app, c5a2.metaA.person.person_id, {
              target_department_ref: deptByKey.ACCOUNTING,
              expected_person_version: c5a2.pARow.pv,
              expected_current_membership_id: c5a2.pARow.membership_id,
              reason: "C5a2 transfer blocked by G1",
            }),
          ]),
        (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
      );
      await serviceQuery(setup, REVOKE_TL_SQL, [OWNER.auth, OWNER.app, c5a2.tId, null, 3, "C5a2 revoke B after rejected transfer", nextUuid()]);
      const st = await inspectC5State(c5a2.tId, c5a2.metaA.acc.app, c5a2.metaB.acc.app, c5a2.metaA.person.person_id);
      assert.equal(st.deptA, "RECRUITMENT");
      assert.equal(st.tlaRows.find((r) => r.uid === c5a2.metaA.acc.app)?.is_current, true);
      assert.equal(st.sgRows.find((r) => r.uid === c5a2.metaA.acc.app)?.is_current, true);
      assert.equal(st.cgRows.find((r) => r.uid === c5a2.metaA.acc.app)?.is_current, true);
      console.log("[PG18 C5a Order 2 transfer_first_blocked_by_G1] pre-check=TRANSFER_REJECTED(PT409 rolled_back) followUp=REVOKE(v_restore=true, A+SG+CG restored)");
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
        assert.equal(r2.status, "fulfilled", "Close-only unassign blocks on R(recA) and closes G1 after revoke commits with 0 40P01");
        const st = await inspectC5State(c5au.tId, c5au.metaA.acc.app, c5au.metaB.acc.app, c5au.metaA.person.person_id);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaA.acc.app)?.is_current, true);
        assert.equal(st.tlaRows.find((r) => r.uid === c5au.metaB.acc.app)?.valid_to, "2026-11-24");
        console.log(`[PG18 C5a-unassign ${order}] wait=${JSON.stringify(waitInfo)} winner=REVOKE(A+SG+CG restored, B closed 0-len) unassign=FULFILLED(0 40P01)`);
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
        assert.equal(st.sgRows.find((r) => r.uid === c5au.metaA.acc.app)?.is_current, false);
        assert.equal(st.sgRows.find((r) => r.uid === c5au.metaB.acc.app)?.is_current, false);
        assert.equal(st.cgRows.find((r) => r.uid === c5au.metaA.acc.app)?.is_current, false);
        assert.equal(st.cgRows.find((r) => r.uid === c5au.metaB.acc.app)?.is_current, false);
        console.log(`[PG18 C5a-unassign ${order}] wait=${JSON.stringify(waitInfo)} winner=UNASSIGN revoke=SUCCEEDED(v_restore=false, both A & B+grants closed)`);
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
      assert.equal(st.sgRows.find((r) => r.uid === c5b.metaA.acc.app)?.is_current, false);
      assert.equal(st.sgRows.find((r) => r.uid === c5b.metaB.acc.app)?.is_current, false);
      assert.equal(st.cgRows.find((r) => r.uid === c5b.metaA.acc.app)?.is_current, false);
      assert.equal(st.cgRows.find((r) => r.uid === c5b.metaB.acc.app)?.is_current, false);
      console.log(`[PG18 C5b pure-API ${order}] wait=${JSON.stringify(waitInfo)} outcome=(deptA=ACCOUNTING, v_restore=false, both A & B + grants closed)`);
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
      assert.equal(st.sgRows.find((r) => r.uid === c5bDrift.metaA.acc.app)?.is_current, false);
      assert.equal(st.sgRows.find((r) => r.uid === c5bDrift.metaB.acc.app)?.is_current, false);
      assert.equal(st.cgRows.find((r) => r.uid === c5bDrift.metaA.acc.app)?.is_current, false);
      assert.equal(st.cgRows.find((r) => r.uid === c5bDrift.metaB.acc.app)?.is_current, false);
      console.log(
        `[PG18 C5b defensive-drift] wait=${JSON.stringify(waitInfo)} outcome=REVOKE_SUCCEEDED(v_restore=false, A+SG+CG stay closed, B closed 0-len+grants closed)`,
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
