/**
 * WP10 — Cross-Department Recruitment (Tuyển dụng liên phòng ban) Real PG18 Acceptance & Security Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated PostgreSQL 18 cluster.
 * Verifies all 5 Owner acceptance + negative security + Leave/Explanation routing + Org transfer + PG18 concurrency cases:
 *   - Case 1: Marketing/IT/Accounting active Org + Recruiter + HRP + active Team + entry_create/entry_own
 *             -> appears in Người tuyển catalog, creates & submits Direct Entry (incl. Marketing -> `marketing` team),
 *             counted once in recruitment reporting, and respects TL scope.
 *   - Case 2: Negative — Org-only / missing Recruiter / missing HRP / missing Team peers NEVER auto-granted
 *             entry_create/entry_own, NEVER in Người tuyển, and rejected on catalog/Direct Entry.
 *   - Case 3: Disabled/paused Marketing Recruiter (disable, INACTIVE person, unlinked Source C, ended Org)
 *             blocks team/catalog; re-enable/restore unlocks immediately; TL revoke in Marketing Org restores G1+TL.
 *   - Case 4: Leave & Attendance Explanation routing for cross-dept Recruitment TL routes to primary dept's
 *             Org Department Head (`organization_department_heads`, `DEPARTMENT_HEAD`, NOT `ADMIN_BOD_DIRECT`), preserves `PENDING` snapshots,
 *             while `RECRUITMENT` TL still routes `ADMIN_BOD_DIRECT`.
 *   - Case 5: Admin Org transfer between active non-RECRUITMENT departments preserves active team/TL & unblocked state,
 *             while end-membership / INACTIVE / unlink still fail closed (`PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT`),
 *             plus real PG18 lock-wait concurrency proofs (`0 40P01`).
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
  computeAssignPersonMemberFingerprint,
  computeDesignateHeadFingerprint,
  computeEndPersonMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUnlinkAccountPersonFingerprint,
  computeUpdatePersonFingerprint,
} from "../src/lib/organization/person-contract.ts";
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const CROSS_DEPT_MIGRATION_NAME = "20261125120000_cross_department_recruitment_guards.sql";

const OWNER = {
  auth: "30100000-0000-4000-8000-00000000a001",
  app: "30100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner CrossDept",
};
const LUANPT = {
  auth: "30100000-0000-4000-8000-00000000a002",
  app: "30100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "30100000-0000-4000-8000-00000000a003",
  app: "30100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "30100000-0000-4000-8000-00000000a004",
  app: "30100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `30110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}

function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
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

async function serviceRpc(client, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
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
      `select a.pid, a.application_name, a.wait_event_type, a.wait_event, l.locktype, l.mode
         from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and l.granted = false
        where a.application_name = $1 and a.state = 'active' and a.wait_event_type = 'Lock'
        limit 1`,
      [appName],
    );
    if (rows.length === 1) return rows[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${appName} to block on Lock`);
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

function makeFullProfileRow({
  projectId,
  recruiterId,
  code,
  name,
  cccd,
  firstWorkDate = "2026-11-24",
}) {
  return {
    project_id: projectId,
    first_work_date: firstWorkDate,
    employee_code: code,
    recruiter_id: recruiterId,
    labor_type: "TEMPORARY",
    display_name: name,
    worker_details: {
      gender: { state: "provided", value: "OTHER" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: cccd },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
  };
}

test("WP10 Cross-Department Recruitment (PG18): Cases 1-5 (Direct Entry, Negative Peer, Pause/Restore, Leave/Explanations, Org Transfer & Concurrency)", async () => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-cross-dept-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], { ignoreOutput: true });
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

    const setup = await connect(port, "wp10-xd-setup");
    const observer = await connect(port, "wp10-xd-observer");
    const w1 = await connect(port, "wp10-xd-w1");
    const w2 = await connect(port, "wp10-xd-w2");
    clients.push(setup, observer, w1, w2);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    // The negative peer case also verifies the pre-drop legacy grant rows.
    const files = (await readdir(MIGRATION_DIR))
      .filter((f) => f.endsWith(".sql") && f <= "20261127020000_wp10_7_3c_retire_legacy_grant_mirror_and_fallback.sql")
      .sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(files.includes(CROSS_DEPT_MIGRATION_NAME), "Cross-dept recruitment migration must exist");

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

    // Seed teams (`marketing` + `sales_rec` + `tl_restore_team`), projects, project-team scopes, banks
    const TEAM_MKT = nextUuid();
    const TEAM_SALES = nextUuid();
    const TEAM_TL_RESTORE = nextUuid();
    const PRJ_1 = "xd-prj-1";
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'marketing', 'Marketing Team', true, 1),
              ($2::uuid, 'sales_rec', 'Sales Recruitment Team', true, 1),
              ($3::uuid, 'tl_restore', 'TL Restore Team', true, 1)`,
      [TEAM_MKT, TEAM_SALES, TEAM_TL_RESTORE],
    );
    await setup.query(
      "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project CrossDept', true)",
      [PRJ_1],
    );
    await setup.query(
      "insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)",
    );
    for (const tid of [TEAM_MKT, TEAM_SALES, TEAM_TL_RESTORE]) {
      await setup.query(
        "insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id) values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)",
        [PRJ_1, tid, OWNER.app],
      );
    }

    const { rows: deptRows } = await setup.query(
      "select department_id, system_key from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING')",
    );
    const deptByKey = Object.fromEntries(deptRows.map((d) => [d.system_key, d.department_id]));
    assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.IT && deptByKey.ACCOUNTING);

    async function onboardPersonWithRecruiter(tag, deptKey, { position = "STAFF", teamId = null, assignTeam = true } = {}) {
      const acc = await seedPlainAccount(setup, `xd.${tag}`, `User ${tag}`);
      const empCode = `EMP-XD-${tag.toUpperCase()}`;
      const p = (
        await serviceRpc(setup, "org_department_create_person_admin", [
          OWNER.auth,
          OWNER.app,
          empCode,
          acc.name,
          "2026-01-01",
          deptByKey[deptKey],
          acc.app,
          1,
          null,
          `Onboard ${tag}`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: acc.name,
            joined_on: "2026-01-01",
            initial_department_ref: deptByKey[deptKey],
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${tag}`,
          }),
        ])
      ).person;
      const cp = await serviceRpc(setup, "direct_entry_account_operation_create_personnel", [
        OWNER.auth,
        OWNER.app,
        acc.app,
        p.active_account_link.account_version,
        acc.login,
        position,
        null,
        `Create recruiter ${tag}`,
        nextUuid(),
      ]);
      if (assignTeam && teamId) {
        await serviceRpc(setup, "direct_entry_assign_team_membership", [
          OWNER.auth,
          OWNER.app,
          cp.recruiter_id,
          teamId,
          null,
          cp.version,
          `Assign ${tag} to team`,
          nextUuid(),
        ]);
      }
      const { rows: [pRef] } = await observer.query("select version from public.organization_persons where person_id = $1::uuid", [p.person_id]);
      const { rows: [uRef] } = await observer.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [acc.app]);
      return {
        acc,
        person: { ...p, version: pRef.version },
        recruiterId: cp.recruiter_id,
        accountVersion: uRef.version,
      };
    }

    // =========================================================================
    // CASE 1: Marketing/IT/Accounting active Org + Recruiter + HRP + Team + entry_create/entry_own
    // =========================================================================
    const mktStaff = await onboardPersonWithRecruiter("mkt1", "MARKETING", { teamId: TEAM_MKT });
    const itStaff = await onboardPersonWithRecruiter("it1", "IT", { teamId: TEAM_MKT });
    const acctStaff = await onboardPersonWithRecruiter("acct1", "ACCOUNTING", { teamId: TEAM_MKT });
    const salesRecStaff = await onboardPersonWithRecruiter("salesrec", "RECRUITMENT", { teamId: TEAM_SALES });

    const mktTl = await onboardPersonWithRecruiter("mkttl", "MARKETING", { position: "TEAM_LEADER", teamId: TEAM_MKT });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_MKT,
      mktTl.acc.app,
      null,
      1,
      "Designate Marketing user as TL of marketing team",
      nextUuid(),
    ]);

    // Verify grants & Người tuyển catalog
    const { rows: mktGrants } = await observer.query(
      `select g->>'capability' as capability, g->>'scope_kind' as scope_kind
         from jsonb_array_elements(public.direct_entry_authz__internal_resolve_effective_grants($1::uuid)) as g
        where g->>'capability' in ('entry_create', 'entry_own', 'submission_create')`,
      [mktStaff.acc.app],
    );
    assert.deepEqual(
      mktGrants.map((g) => `${g.capability}:${g.scope_kind}`).sort(),
      ["entry_create:OWN", "entry_own:OWN", "submission_create:OWN"],
    );

    const mktCatalog = await serviceRpc(setup, "direct_entry_input_catalog", [
      mktStaff.acc.auth,
      mktStaff.acc.app,
      "2026-11-24",
    ]);
    for (const s of [mktStaff, itStaff, acctStaff]) {
      const found = mktCatalog.recruiters.find((r) => r.recruiter_id === s.recruiterId);
      assert.ok(found, `Cross-dept recruiter ${s.acc.login} must appear in Người tuyển catalog`);
      assert.equal(found.provider_type, "hrp");
      assert.equal(found.team_id, TEAM_MKT);
    }

    // Marketing staff creates & submits Direct Entry on `marketing` team
    const mktBatch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      mktStaff.acc.auth,
      mktStaff.acc.app,
      "worker-profile/1.2",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_1,
          recruiterId: mktStaff.recruiterId,
          code: "hrp-2026-100001",
          name: "Worker From Marketing",
          cccd: "079200000001",
        }),
      ]),
      nextUuid(),
    ]);
    assert.equal(mktBatch.state, "DRAFT");
    const mktSubmitted = await serviceRpc(setup, "direct_entry_transition_submission", [
      mktStaff.acc.auth,
      mktStaff.acc.app,
      mktBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    assert.equal(mktSubmitted.state, "SUBMITTED");

    // Sales Recruitment staff submits entry on `sales_rec` team (for TL scope isolation check)
    const salesBatch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      salesRecStaff.acc.auth,
      salesRecStaff.acc.app,
      "worker-profile/1.2",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_1,
          recruiterId: salesRecStaff.recruiterId,
          code: "hrp-2026-100002",
          name: "Worker From Sales",
          cccd: "079200000002",
        }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(setup, "direct_entry_transition_submission", [
      salesRecStaff.acc.auth,
      salesRecStaff.acc.app,
      salesBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);

    // Reporting counts Marketing entry ONCE (1) & respects TL scope
    const { rows: mktFactRows } = await observer.query(
      "select entry_id::text, recruited_count, team_id::text from public.direct_entry_reporting_facts_v01 where entry_id = $1::uuid",
      [mktBatch.entry_ids[0]],
    );
    assert.equal(mktFactRows.length, 1);
    assert.equal(mktFactRows[0].recruited_count, 1);
    assert.equal(mktFactRows[0].team_id, TEAM_MKT);

    const tlFacts = await serviceRpc(setup, "direct_entry_reporting_scoped_facts", [
      mktTl.acc.auth,
      mktTl.acc.app,
      JSON.stringify({}),
    ]);
    assert.equal(tlFacts.audience.audience, "team");
    assert.deepEqual(tlFacts.audience.team_ids, [TEAM_MKT]);
    assert.deepEqual(
      tlFacts.facts.map((f) => f.entry_id),
      [mktBatch.entry_ids[0]],
      "Marketing TL must see ONLY marketing team Direct Entry and NOT sales_rec",
    );
    assert.equal(tlFacts.facts.reduce((sum, f) => sum + f.recruited_count, 0), 1);

    const mktBucketKey = `team.${Buffer.from("marketing", "utf8").toString("base64url")}`;
    const drillDown = await serviceRpc(setup, "direct_entry_reporting_team_drill_down", [
      OWNER.auth,
      OWNER.app,
      mktBucketKey,
      JSON.stringify({}),
      null,
      25,
    ]);
    assert.equal(drillDown.total, 1);
    assert.equal(drillDown.rows[0].recruited_count, 1);
    assert.equal(drillDown.rows[0].recruiter_display, mktStaff.acc.name);

    const matrixCat = await serviceRpc(setup, "direct_entry_reporting_detailed_matrix_catalog", [OWNER.auth, OWNER.app]);
    assert.ok(matrixCat.recruiters.some((r) => r.recruiter_id === mktStaff.recruiterId && r.is_active_hrp));

    // =========================================================================
    // CASE 2 (Negative Security): Org-only / missing HRP / missing Team peers
    // =========================================================================
    const mktOrgOnly = await seedPlainAccount(setup, "xd.mktorgonly", "Mkt Org Only");
    await serviceRpc(setup, "org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      "EMP-XD-ORGONLY",
      mktOrgOnly.name,
      "2026-01-01",
      deptByKey.MARKETING,
      mktOrgOnly.app,
      1,
      null,
      "Org-only peer",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-XD-ORGONLY",
        full_name: mktOrgOnly.name,
        joined_on: "2026-01-01",
        initial_department_ref: deptByKey.MARKETING,
        account_ref: mktOrgOnly.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Org-only peer",
      }),
    ]);

    const { rows: orgOnlyCaps } = await observer.query(
      `select g->>'capability' as capability
         from jsonb_array_elements(public.direct_entry_authz__internal_resolve_effective_grants($1::uuid)) as g
        where g->>'capability' in ('entry_create', 'entry_own')`,
      [mktOrgOnly.app],
    );
    assert.equal(orgOnlyCaps.length, 0, "Org-only Marketing peer must NEVER receive entry_create or entry_own");
    const { rows: orgOnlyLeg } = await observer.query(
      `select capability from public.direct_entry_capability_grants
        where app_user_id = $1::uuid and is_current = true and capability in ('entry_create', 'entry_own')`,
      [mktOrgOnly.app],
    );
    assert.equal(orgOnlyLeg.length, 0);

    await assert.rejects(
      () => serviceRpc(setup, "direct_entry_input_catalog", [mktOrgOnly.auth, mktOrgOnly.app, "2026-11-24"]),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "direct_entry_create_full_profile_batch", [
          mktOrgOnly.auth,
          mktOrgOnly.app,
          "worker-profile/1.2",
          JSON.stringify([
            makeFullProfileRow({
              projectId: PRJ_1,
              recruiterId: mktStaff.recruiterId,
              code: "hrp-2026-100099",
              name: "Forbidden Peer",
              cccd: "079200000099",
            }),
          ]),
          nextUuid(),
        ]),
      (err) => err?.code === "42501",
    );

    // IT peer missing active HRP (ended HRP) + Accounting peer missing active Team
    const itNoHrp = await onboardPersonWithRecruiter("itnohrp", "IT", { teamId: TEAM_MKT });
    await setup.query(
      "update public.recruiter_provider_memberships set valid_from = '2026-01-01', valid_to = '2026-11-24', is_current = false where recruiter_id = $1::uuid",
      [itNoHrp.recruiterId],
    );
    const acctNoTeam = await onboardPersonWithRecruiter("acctnoteam", "ACCOUNTING", { assignTeam: false });

    const ownerCat = await serviceRpc(setup, "direct_entry_input_catalog", [OWNER.auth, OWNER.app, "2026-11-24"]);
    assert.equal(ownerCat.recruiters.some((r) => r.recruiter_id === itNoHrp.recruiterId), false, "Missing HRP excluded from catalog");
    assert.equal(ownerCat.recruiters.some((r) => r.recruiter_id === acctNoTeam.recruiterId), false, "Missing team excluded from catalog");

    for (const badRec of [itNoHrp.recruiterId, acctNoTeam.recruiterId]) {
      await assert.rejects(
        () =>
          serviceRpc(setup, "direct_entry_create_full_profile_batch", [
            OWNER.auth,
            OWNER.app,
            "worker-profile/1.2",
            JSON.stringify([
              makeFullProfileRow({
                projectId: PRJ_1,
                recruiterId: badRec,
                code: `hrp-2026-${String(200000 + seq).padStart(6, "0")}`,
                name: "Invalid Recruiter",
                cccd: `079200000${String(seq).padStart(3, "0")}`,
              }),
            ]),
            nextUuid(),
          ]),
        (err) => err?.code === "22023" && err?.message?.includes("RECRUITER_MEMBERSHIP_INVALID"),
      );
    }

    // =========================================================================
    // CASE 3: Disabled / Paused Marketing Recruiter + Unlink/End/INACTIVE + TL Restore
    // =========================================================================
    const mktPaused = await onboardPersonWithRecruiter("mktpaused", "MARKETING", { teamId: TEAM_TL_RESTORE });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_TL_RESTORE,
      mktPaused.acc.app,
      null,
      1,
      "Designate paused test TL",
      nextUuid(),
    ]);

    // 3a. Account disable -> blocked from catalog & TL suspended; re-enable -> unlocks & restores!
    await serviceRpc(setup, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      mktPaused.acc.app,
      mktPaused.accountVersion,
      "Pause Marketing recruiter",
      nextUuid(),
    ]);
    await assert.rejects(
      () => serviceRpc(setup, "direct_entry_input_catalog", [mktPaused.acc.auth, mktPaused.acc.app, "2026-11-24"]),
      (err) => err?.code === "42501",
    );
    const { rows: [suspTlRow] } = await observer.query(
      "select is_current, suspended_by_account_disable from public.direct_entry_team_leader_assignments where team_id = $1::uuid and leader_app_user_id = $2::uuid order by created_at desc limit 1",
      [TEAM_TL_RESTORE, mktPaused.acc.app],
    );
    assert.deepEqual(suspTlRow, { is_current: false, suspended_by_account_disable: true });

    await serviceRpc(setup, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      mktPaused.acc.app,
      mktPaused.accountVersion + 1,
      "Re-enable Marketing recruiter",
      nextUuid(),
    ]);
    const restoredCat = await serviceRpc(setup, "direct_entry_input_catalog", [mktPaused.acc.auth, mktPaused.acc.app, "2026-11-24"]);
    assert.ok(restoredCat.recruiters.some((r) => r.recruiter_id === mktPaused.recruiterId));

    // 3b. Revoking same-day replacement TL while previous TL belongs to MARKETING Org restores G1 + TL!
    const mktTlNext = await onboardPersonWithRecruiter("mkttlnext", "MARKETING", { teamId: TEAM_TL_RESTORE });
    await setBusinessDate(setup, "2026-11-25");
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_TL_RESTORE,
      mktTlNext.acc.app,
      null,
      2,
      "Replace TL in Marketing",
      nextUuid(),
    ]);
    await serviceRpc(setup, "direct_entry_revoke_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_TL_RESTORE,
      null,
      3,
      "Revoke replacement TL -> restore Marketing prev TL",
      nextUuid(),
    ]);
    const { rows: [tlRestoredRow] } = await observer.query(
      "select leader_app_user_id::text as uid, is_current from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current = true",
      [TEAM_TL_RESTORE],
    );
    assert.equal(tlRestoredRow.uid, mktPaused.acc.app);
    const { rows: [rtmRestoredRow] } = await observer.query(
      "select count(*)::int as cnt from public.recruiter_team_memberships where recruiter_id = $1::uuid and team_id = $2::uuid and is_current = true",
      [mktPaused.recruiterId, TEAM_TL_RESTORE],
    );
    assert.equal(rtmRestoredRow.cnt, 1, "recruiter_team_memberships preserved & active after TL revoke");

    // 3c. Close TL + G1 -> test INACTIVE person, ended Org membership, and unlinked Source C block team assignment; restore unlocks!
    await setBusinessDate(setup, "2026-11-24");
    await serviceRpc(setup, "direct_entry_revoke_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_TL_RESTORE,
      null,
      4,
      "Clear TL for pause/restore check",
      nextUuid(),
    ]);
    await serviceRpc(setup, "direct_entry_unassign_team_membership", [
      OWNER.auth,
      OWNER.app,
      mktPaused.recruiterId,
      null,
      2,
      "Unassign G1 before Org pause tests",
      nextUuid(),
    ]);

    // INACTIVE person blocks team assign (`23514`), restore ACTIVE unlocks immediately
    await serviceRpc(setup, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      mktPaused.person.person_id,
      mktPaused.person.version,
      mktPaused.person.employee_code,
      mktPaused.person.full_name,
      "2026-01-01",
      "INACTIVE",
      "Set INACTIVE",
      nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, mktPaused.person.person_id, {
        expected_person_version: mktPaused.person.version,
        employee_code: mktPaused.person.employee_code,
        full_name: mktPaused.person.full_name,
        joined_on: "2026-01-01",
        status: "INACTIVE",
        reason: "Set INACTIVE",
      }),
    ]);
    await assert.rejects(
      () =>
        serviceRpc(setup, "direct_entry_assign_team_membership", [
          OWNER.auth,
          OWNER.app,
          mktPaused.recruiterId,
          TEAM_TL_RESTORE,
          null,
          3,
          "Blocked while person INACTIVE",
          nextUuid(),
        ]),
      (err) => err?.code === "23514",
    );
    await serviceRpc(setup, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      mktPaused.person.person_id,
      mktPaused.person.version + 1,
      mktPaused.person.employee_code,
      mktPaused.person.full_name,
      "2026-01-01",
      "ACTIVE",
      "Restore ACTIVE",
      nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, mktPaused.person.person_id, {
        expected_person_version: mktPaused.person.version + 1,
        employee_code: mktPaused.person.employee_code,
        full_name: mktPaused.person.full_name,
        joined_on: "2026-01-01",
        status: "ACTIVE",
        reason: "Restore ACTIVE",
      }),
    ]);

    // Ended Org membership blocks team assign (`23514`), restore membership unlocks
    await serviceRpc(setup, "org_department_end_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      deptByKey.MARKETING,
      mktPaused.person.active_department.membership_id,
      mktPaused.person.version + 2,
      "End Org membership",
      nextUuid(),
      computeEndPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.MARKETING,
        membership_id: mktPaused.person.active_department.membership_id,
        expected_person_version: mktPaused.person.version + 2,
        reason: "End Org membership",
      }),
    ]);
    await assert.rejects(
      () =>
        serviceRpc(setup, "direct_entry_assign_team_membership", [
          OWNER.auth,
          OWNER.app,
          mktPaused.recruiterId,
          TEAM_TL_RESTORE,
          null,
          3,
          "Blocked while Org membership ended",
          nextUuid(),
        ]),
      (err) => err?.code === "23514",
    );
    await serviceRpc(setup, "org_department_assign_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      deptByKey.MARKETING,
      mktPaused.person.person_id,
      mktPaused.person.version + 3,
      "Restore Marketing Org",
      nextUuid(),
      computeAssignPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.MARKETING,
        person_id: mktPaused.person.person_id,
        expected_person_version: mktPaused.person.version + 3,
        reason: "Restore Marketing Org",
      }),
    ]);

    // Source C (unlinked account with historical ended Org Person link and no active person link) blocks team assign (`23514`),
    // then re-linking to active MARKETING Person unlocks immediately!
    const accSrcC = await seedPlainAccount(setup, "xd.srcc", "Source C Mkt");
    const pSrcC = (
      await serviceRpc(setup, "org_department_create_person_admin", [
        OWNER.auth,
        OWNER.app,
        "EMP-XD-SRCC",
        accSrcC.name,
        "2026-01-01",
        deptByKey.MARKETING,
        accSrcC.app,
        1,
        null,
        "Onboard Source C test",
        nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: "EMP-XD-SRCC",
          full_name: accSrcC.name,
          joined_on: "2026-01-01",
          initial_department_ref: deptByKey.MARKETING,
          account_ref: accSrcC.app,
          expected_account_version: 1,
          recruiter_id: null,
          reason: "Onboard Source C test",
        }),
      ])
    ).person;
    await serviceRpc(setup, "org_department_unlink_account_person_admin", [
      OWNER.auth,
      OWNER.app,
      accSrcC.app,
      pSrcC.active_account_link.account_version,
      pSrcC.version,
      pSrcC.active_account_link.link_id,
      "Unlink before creating personnel -> Source C",
      nextUuid(),
      computeUnlinkAccountPersonFingerprint(OWNER.app, accSrcC.app, {
        expected_account_version: pSrcC.active_account_link.account_version,
        expected_person_version: pSrcC.version,
        expected_link_id: pSrcC.active_account_link.link_id,
        reason: "Unlink before creating personnel -> Source C",
      }),
    ]);
    const cpSrcC = await serviceRpc(setup, "direct_entry_account_operation_create_personnel", [
      OWNER.auth,
      OWNER.app,
      accSrcC.app,
      pSrcC.active_account_link.account_version + 1,
      accSrcC.login,
      "STAFF",
      null,
      "Create personnel while Source C unlinked",
      nextUuid(),
    ]);
    await assert.rejects(
      () =>
        serviceRpc(setup, "direct_entry_assign_team_membership", [
          OWNER.auth,
          OWNER.app,
          cpSrcC.recruiter_id,
          TEAM_TL_RESTORE,
          null,
          cpSrcC.version,
          "Blocked while Source C unlinked",
          nextUuid(),
        ]),
      (err) => err?.code === "23514",
    );
    await serviceRpc(setup, "org_department_link_account_person_admin", [
      OWNER.auth,
      OWNER.app,
      accSrcC.app,
      pSrcC.person_id,
      cpSrcC.app_user_version,
      pSrcC.version + 1,
      cpSrcC.recruiter_id,
      "Re-link restores active Marketing Org",
      nextUuid(),
      computeLinkAccountPersonFingerprint(OWNER.app, accSrcC.app, {
        person_id: pSrcC.person_id,
        expected_account_version: cpSrcC.app_user_version,
        expected_person_version: pSrcC.version + 1,
        confirmed_recruiter_id: cpSrcC.recruiter_id,
        reason: "Re-link restores active Marketing Org",
      }),
    ]);
    const unlockedAssign = await serviceRpc(setup, "direct_entry_assign_team_membership", [
      OWNER.auth,
      OWNER.app,
      cpSrcC.recruiter_id,
      TEAM_TL_RESTORE,
      null,
      cpSrcC.version,
      "Unlocked after re-link",
      nextUuid(),
    ]);
    assert.equal(unlockedAssign.team_id, TEAM_TL_RESTORE);

    // =========================================================================
    // CASE 4: Leave & Attendance Explanation routing for cross-dept Recruitment TL
    // =========================================================================
    async function onboardOrgDeptHead(tag, deptKey, displayName) {
      const acc = await seedPlainAccount(setup, tag, displayName);
      const empCode = `EMP-XD-${tag.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      const created = (
        await serviceRpc(setup, "org_department_create_person_admin", [
          OWNER.auth,
          OWNER.app,
          empCode,
          acc.name,
          "2026-01-01",
          deptByKey[deptKey],
          acc.app,
          1,
          null,
          `Onboard ${deptKey} Head`,
          nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: empCode,
            full_name: acc.name,
            joined_on: "2026-01-01",
            initial_department_ref: deptByKey[deptKey],
            account_ref: acc.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: `Onboard ${deptKey} Head`,
          }),
        ])
      ).person;
      const { rows: [dRow] } = await observer.query(
        "select version from public.organization_departments where department_id = $1::uuid",
        [deptByKey[deptKey]],
      );
      await serviceRpc(setup, "org_department_designate_head_admin", [
        OWNER.auth,
        OWNER.app,
        deptByKey[deptKey],
        created.person_id,
        dRow.version,
        null,
        `Designate ${deptKey} Head`,
        nextUuid(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: deptByKey[deptKey],
          person_id: created.person_id,
          expected_department_version: dRow.version,
          expected_current_head_assignment_id: null,
          reason: `Designate ${deptKey} Head`,
        }),
      ]);
      return acc;
    }

    const mktApprover = await onboardOrgDeptHead("xd.mktapp", "MARKETING", "Marketing Approver");
    const itApprover = await onboardOrgDeptHead("xd.itapp", "IT", "IT Approver");
    const acctApprover = await onboardOrgDeptHead("xd.acctapp", "ACCOUNTING", "Accounting Approver");

    const itTl = await onboardPersonWithRecruiter("ittl", "IT", { position: "TEAM_LEADER", teamId: TEAM_SALES });
    const TEAM_ACCT_TL = nextUuid();
    await setup.query("insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'acct_tl_team', 'Acct TL Team', true, 1)", [TEAM_ACCT_TL]);
    const acctTl = await onboardPersonWithRecruiter("accttl", "ACCOUNTING", { position: "TEAM_LEADER", teamId: TEAM_ACCT_TL });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_ACCT_TL, acctTl.acc.app, null, 1, "ACCT TL", nextUuid(),
    ]);
    const TEAM_REC_TL = nextUuid();
    await setup.query("insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'rec_tl_team', 'Rec TL Team', true, 1)", [TEAM_REC_TL]);
    const recTl = await onboardPersonWithRecruiter("rectl", "RECRUITMENT", { position: "TEAM_LEADER", teamId: TEAM_REC_TL });
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_REC_TL, recTl.acc.app, null, 1, "RECRUITMENT TL", nextUuid(),
    ]);
    // Also designate itTl on TEAM_SALES
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth, OWNER.app, TEAM_SALES, itTl.acc.app, null, 1, "IT TL", nextUuid(),
    ]);

    for (const [user, uk] of [
      [mktTl, "MARKETING"],
      [itTl, "IT"],
      [acctTl, "ACCOUNTING"],
      [recTl, "RECRUITMENT"],
    ]) {
      await serviceRpc(setup, "leave_management_upsert_employee_profile_admin", [
        OWNER.auth,
        OWNER.app,
        user.acc.app,
        "OFFICIAL",
        uk,
        "2025-01-01",
        "2025-03-01",
        null,
        0,
        0,
        `Leave profile ${uk}`,
        `lp-${user.acc.app}`,
        sha256(`lp-${user.acc.app}`),
      ]);
    }

    const { rows: [{ today_vn: todayVn, y: yesterdayVn, d1: leaveDay1, d2: leaveDay2 }] } = await observer.query(
      `select (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1)::text as y,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 2)::text as d1,
              ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date + 4)::text as d2`,
    );

    // Direct routing snapshot checks
    const { rows: [mktSnap] } = await observer.query(
      "select routing, routed_department_id::text from public.leave_management__internal_resolve_routing_snapshot($1::uuid, $2::date)",
      [mktTl.acc.app, todayVn],
    );
    assert.equal(mktSnap.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktSnap.routing.primary_approver_app_user_id, mktApprover.app);
    assert.equal(mktSnap.routed_department_id, deptByKey.MARKETING);

    const { rows: [itSnap] } = await observer.query(
      "select routing, routed_department_id::text from public.leave_management__internal_resolve_routing_snapshot($1::uuid, $2::date)",
      [itTl.acc.app, todayVn],
    );
    assert.equal(itSnap.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(itSnap.routing.primary_approver_app_user_id, itApprover.app);
    assert.equal(itSnap.routed_department_id, deptByKey.IT);

    const { rows: [acctSnap] } = await observer.query(
      "select routing, routed_department_id::text from public.leave_management__internal_resolve_routing_snapshot($1::uuid, $2::date)",
      [acctTl.acc.app, todayVn],
    );
    assert.equal(acctSnap.routing.route_kind, "DEPARTMENT_HEAD");
    assert.equal(acctSnap.routing.primary_approver_app_user_id, acctApprover.app);
    assert.equal(acctSnap.routed_department_id, deptByKey.ACCOUNTING);

    const { rows: [recSnap] } = await observer.query(
      "select routing, routed_department_id::text from public.leave_management__internal_resolve_routing_snapshot($1::uuid, $2::date)",
      [recTl.acc.app, todayVn],
    );
    assert.equal(recSnap.routing.route_kind, "ADMIN_BOD_DIRECT", "RECRUITMENT TL must still route ADMIN_BOD_DIRECT");
    assert.equal(recSnap.routing.primary_approver_app_user_id, null);

    // mktTl creates Leave Request #1 and Attendance Explanation #1 -> routed to mktApprover (DEPARTMENT_HEAD)
    const mktLeave1 = await serviceRpc(setup, "leave_management_create_request", [
      mktTl.acc.auth,
      mktTl.acc.app,
      JSON.stringify([{ leave_date: leaveDay1, session_code: "AM", leave_type: "UNPAID" }]),
      "Cross-dept TL Leave request",
      `xd-leave1-${seq++}`,
      sha256("xd-leave1"),
    ]);
    assert.equal(mktLeave1.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktLeave1.request.primary_approver_app_user_id, mktApprover.app);

    const mktExp1 = await serviceRpc(setup, "attendance_submit_explanation", [
      mktTl.acc.auth,
      mktTl.acc.app,
      yesterdayVn,
      "SLOT_1",
      "Cross-dept TL Attendance explanation",
      nextUuid(),
      sha256("xd-exp1"),
    ]);
    assert.equal(mktExp1.explanation.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktExp1.explanation.primary_approver.app_user_id, mktApprover.app);

    const mktLeaveInbox = await serviceRpc(setup, "leave_management_list_approval_inbox", [
      mktApprover.auth, mktApprover.app, "PENDING", 50, 0,
    ]);
    assert.ok(mktLeaveInbox.items.some((r) => r.request_id === mktLeave1.request.request_id));
    const mktExpInbox = await serviceRpc(setup, "attendance_list_explanation_approval_inbox", [
      mktApprover.auth, mktApprover.app, "PENDING", 50, 0,
    ]);
    assert.ok(mktExpInbox.items.some((e) => e.explanation_id === mktExp1.explanation.explanation_id));

    // =========================================================================
    // CASE 5: Admin Org Transfer across active non-RECRUITMENT depts + PENDING snapshot preservation + Concurrency
    // =========================================================================
    // Transfer mktTl (MARKETING -> IT -> ACCOUNTING) while keeping active `marketing` team + TL!
    const { rows: [mktTlCur] } = await observer.query(
      `select p.version as pv, m.membership_id as mid, u.version as av, l.link_id
         from public.organization_persons p
         join public.organization_person_department_memberships m on m.person_id = p.person_id and m.ended_at is null
         join public.organization_account_person_links l on l.person_id = p.person_id and l.ended_at is null
         join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
        where p.person_id = $1::uuid`,
      [mktTl.person.person_id],
    );
    const trToIt = await serviceRpc(setup, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      mktTl.person.person_id,
      deptByKey.IT,
      mktTlCur.pv,
      mktTlCur.mid,
      "Transfer Marketing TL to IT",
      nextUuid(),
      computeTransferPersonDepartmentFingerprint(OWNER.app, mktTl.person.person_id, {
        target_department_ref: deptByKey.IT,
        expected_person_version: mktTlCur.pv,
        expected_current_membership_id: mktTlCur.mid,
        reason: "Transfer Marketing TL to IT",
      }),
    ]);
    assert.equal(trToIt.active_membership.department_id, deptByKey.IT);

    // Existing PENDING Leave #1 & Explanation #1 MUST keep frozen MARKETING approver snapshot,
    // while NEW Leave #2 routes to IT approver!
    const { rows: [frozenLeave1] } = await observer.query(
      "select primary_approver_app_user_id::text, routed_department_id::text, status from public.leave_requests where request_id = $1::uuid",
      [mktLeave1.request.request_id],
    );
    assert.deepEqual(frozenLeave1, {
      primary_approver_app_user_id: mktApprover.app,
      routed_department_id: deptByKey.MARKETING,
      status: "PENDING",
    });
    const { rows: [frozenExp1] } = await observer.query(
      "select primary_approver_app_user_id::text, routed_department_id::text, status from public.attendance_explanations where explanation_id = $1::uuid",
      [mktExp1.explanation.explanation_id],
    );
    assert.deepEqual(frozenExp1, {
      primary_approver_app_user_id: mktApprover.app,
      routed_department_id: deptByKey.MARKETING,
      status: "PENDING",
    });

    const mktLeave2 = await serviceRpc(setup, "leave_management_create_request", [
      mktTl.acc.auth,
      mktTl.acc.app,
      JSON.stringify([{ leave_date: leaveDay2, session_code: "AM", leave_type: "UNPAID" }]),
      "Leave request after transfer to IT",
      `xd-leave2-${seq++}`,
      sha256("xd-leave2"),
    ]);
    assert.equal(mktLeave2.request.route_kind, "DEPARTMENT_HEAD");
    assert.equal(mktLeave2.request.primary_approver_app_user_id, itApprover.app);

    // Transfer IT -> ACCOUNTING and verify team + TL + Direct Entry remain intact
    const trToAcct = await serviceRpc(setup, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      mktTl.person.person_id,
      deptByKey.ACCOUNTING,
      trToIt.person_version,
      trToIt.active_membership.membership_id,
      "Transfer IT TL to ACCOUNTING",
      nextUuid(),
      computeTransferPersonDepartmentFingerprint(OWNER.app, mktTl.person.person_id, {
        target_department_ref: deptByKey.ACCOUNTING,
        expected_person_version: trToIt.person_version,
        expected_current_membership_id: trToIt.active_membership.membership_id,
        reason: "Transfer IT TL to ACCOUNTING",
      }),
    ]);
    assert.equal(trToAcct.active_membership.department_id, deptByKey.ACCOUNTING);

    const { rows: [tlIntact] } = await observer.query(
      `select (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $1::uuid and team_id = $2::uuid and is_current = true) as g1,
              (select count(*)::int from public.direct_entry_team_leader_assignments where leader_app_user_id = $3::uuid and team_id = $2::uuid and is_current = true) as g2`,
      [mktTl.recruiterId, TEAM_MKT, mktTl.acc.app],
    );
    assert.deepEqual(tlIntact, { g1: 1, g2: 1 });

    // End membership, INACTIVE person, and unlink STILL fail closed with PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT
    await assert.rejects(
      () =>
        serviceRpc(setup, "org_department_end_person_member_admin", [
          OWNER.auth,
          OWNER.app,
          deptByKey.ACCOUNTING,
          trToAcct.active_membership.membership_id,
          trToAcct.person_version,
          "Fail closed end",
          nextUuid(),
          computeEndPersonMemberFingerprint({
            actor_app_user_id: OWNER.app,
            department_id: deptByKey.ACCOUNTING,
            membership_id: trToAcct.active_membership.membership_id,
            expected_person_version: trToAcct.person_version,
            reason: "Fail closed end",
          }),
        ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "org_department_update_person_admin", [
          OWNER.auth,
          OWNER.app,
          mktTl.person.person_id,
          trToAcct.person_version,
          mktTl.person.employee_code,
          mktTl.person.full_name,
          "2026-01-01",
          "INACTIVE",
          "Fail closed INACTIVE",
          nextUuid(),
          computeUpdatePersonFingerprint(OWNER.app, mktTl.person.person_id, {
            expected_person_version: trToAcct.person_version,
            employee_code: mktTl.person.employee_code,
            full_name: mktTl.person.full_name,
            joined_on: "2026-01-01",
            status: "INACTIVE",
            reason: "Fail closed INACTIVE",
          }),
        ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () =>
        serviceRpc(setup, "org_department_unlink_account_person_admin", [
          OWNER.auth,
          OWNER.app,
          mktTl.acc.app,
          mktTlCur.av,
          trToAcct.person_version,
          mktTlCur.link_id,
          "Fail closed unlink",
          nextUuid(),
          computeUnlinkAccountPersonFingerprint(OWNER.app, mktTl.acc.app, {
            expected_account_version: mktTlCur.av,
            expected_person_version: trToAcct.person_version,
            expected_link_id: mktTlCur.link_id,
            reason: "Fail closed unlink",
          }),
        ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // Real PG18 Concurrency: transfer(MARKETING -> IT) vs assign_team_membership (both orders, 0 40P01)
    for (const order of ["transfer_first", "assign_first"]) {
      const s = await onboardPersonWithRecruiter(`conc.${order}`, "MARKETING", { assignTeam: false });
      const trParams = [
        OWNER.auth,
        OWNER.app,
        s.person.person_id,
        deptByKey.IT,
        s.person.version,
        s.person.active_department.membership_id,
        `Conc ${order} transfer`,
        nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, s.person.person_id, {
          target_department_ref: deptByKey.IT,
          expected_person_version: s.person.version,
          expected_current_membership_id: s.person.active_department.membership_id,
          reason: `Conc ${order} transfer`,
        }),
      ];
      const assignParams = [OWNER.auth, OWNER.app, s.recruiterId, TEAM_MKT, null, 1, `Conc ${order} assign`, nextUuid()];
      await beginServiceTx(w1);
      if (order === "transfer_first") {
        await w1.query("select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9)", trParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query("select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8)", assignParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-xd-w2");
        assert.equal(waitInfo.wait_event_type, "Lock");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `Conc ${order}`);
        assert.equal(r2.status, "fulfilled");
      } else {
        await w1.query("select public.direct_entry_assign_team_membership($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7, $8)", assignParams);
        await beginServiceTx(w2);
        const p2 = settleInTx(w2, w2.query("select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9)", trParams));
        const waitInfo = await waitUntilBlocked(observer, "wp10-xd-w2");
        assert.equal(waitInfo.wait_event_type, "Lock");
        await w1.query("commit");
        const r2 = await p2;
        assertNotDeadlock(r2, `Conc ${order}`);
        assert.equal(r2.status, "fulfilled");
      }
      const { rows: [postConc] } = await observer.query(
        `select (select d.system_key from public.organization_person_department_memberships m join public.organization_departments d on d.department_id = m.department_id where m.person_id = $1::uuid and m.ended_at is null) as dept_key,
                (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $2::uuid and team_id = $3::uuid and is_current = true) as g1`,
        [s.person.person_id, s.recruiterId, TEAM_MKT],
      );
      assert.deepEqual(postConc, { dept_key: "IT", g1: 1 });
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
