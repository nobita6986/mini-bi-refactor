/**
 * Hotfix — Direct Entry Catalog Read for `entry_privileged_edit`, Team Leader,
 * Project Manager, and Full Admin without `entry_create`/`entry_own`.
 *
 * Isolated Real PostgreSQL 18 Acceptance Suite (`initdb` + `pg_ctl`).
 *
 * Verifies BEFORE (`pre-20261127010000`) vs AFTER (`20261127010000_hf_direct_entry_catalog_privileged_edit_read.sql`):
 *   1. Pure single-role allowed actors (`authz_managed = true`, ZERO `entry_create`/`entry_own`):
 *      - `entry_privileged_edit` at `ALL`, `OWN`, `CONTEXT_TEAM` (active non-`__system_vendor__`)
 *      - Pure active Team Leader, pure active Project Manager (`PRJ_1` only), pure Full Admin (`PRJ_1` + `PRJ_2`)
 *      - Legacy (`authz_managed = false`) `entry_privileged_edit` with valid vs missing/invalid scope
 *   2. Denied actors (`42501`):
 *      - `entry_privileged_edit` with inactive team, `__system_vendor__`, or `CONTEXT_DEPARTMENT`
 *      - `HR_ONLY`, `EMP_STALE`, org-only member, view-only actor (`document_view` + `audit_view`)
 *      - Disabled (`enabled = false`) for every newly allowed role (with re-enable recovery check)
 *      - Revoked Team Leader & revoked Project Manager even with historical `p_effective_date = D-1`
 *   3. Write guards & batch creation unchanged (before & after):
 *      - Out-of-scope `direct_entry_privileged_edit` rejected `42501`
 *      - `direct_entry_create_authority` & `direct_entry_create_full_profile_batch` reject pure
 *        `entry_privileged_edit`, pure TL, and pure Full Admin (`42501`); pure PM allowed ONLY for `PRJ_1`
 *   4. Document upload rules preserved:
 *      - Pure PM draft self-upload allowed on own `DRAFT` in `PRJ_1` without `document_upload`
 *      - Pure PM rejected (`42501`) on someone else's `DRAFT` or `SUBMITTED` entry without `document_upload`
 *      - Pure `entry_privileged_edit` without `document_upload` rejected (`42501`)
 *   5. ACL checks on `direct_entry_input_catalog` & `direct_entry_input_catalog_unscoped_v42`.
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
import { PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const HF_MIGRATION_NAME = "20261127010000_hf_direct_entry_catalog_privileged_edit_read.sql";

const OWNER = {
  auth: "97100000-0000-4000-8000-00000000a001",
  app: "97100000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner HF Catalog",
};
const LUANPT = {
  auth: "97100000-0000-4000-8000-00000000a002",
  app: "97100000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "97100000-0000-4000-8000-00000000a003",
  app: "97100000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "97100000-0000-4000-8000-00000000a004",
  app: "97100000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

const PRJ_1 = "hf-cat-prj-1";
const PRJ_2 = "hf-cat-prj-2";

let seq = 1;
let cccdSeq = 1000;
let empCodeSeq = 500001;

function nextUuid() {
  return `97110000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `hf_cat_${prefix}_${seq++}`;
}
function nextCccd() {
  return `079090${String(cccdSeq++).padStart(6, "0")}`;
}
function nextEmployeeCode(year = "2026") {
  return `hrp-${year}-${String(empCodeSeq++).padStart(6, "0")}`;
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

async function expectServiceRpcError(client, fnName, args, expectedCode, expectedPattern, casts = []) {
  let caught = null;
  try {
    await serviceRpc(client, fnName, args, casts);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected ${fnName} to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode} on ${fnName}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message on ${fnName}: ${caught.message}`);
  }
  return caught;
}

async function expectInternalError(client, sql, params, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await client.query(sql, params);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected query to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message: ${caught.message}`);
  }
  return caught;
}

function makeFullProfileRow({
  projectId = PRJ_1,
  recruiterId,
  code = nextEmployeeCode("2026"),
  name = "Nguyen Van Test",
  cccd = nextCccd(),
  firstWorkDate = "2026-03-01",
} = {}) {
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

test("HF Direct Entry Catalog Read (PG18): entry_privileged_edit, TL, PM, Full Admin, write/upload guards & ACLs", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hf-cat-priv-edit-pg18-"));
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

    const setup = await connect(port, "hf-cat-setup");
    const observer = await connect(port, "hf-cat-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const hfIdx = files.indexOf(HF_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(hfIdx > groupsIdx, `${HF_MIGRATION_NAME} must exist after PR28`);

    // -------------------------------------------------------------------------
    // Bootstrap baseline up to pre-20261127010000
    // -------------------------------------------------------------------------
    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    for (const adm of [OWNER, LUANPT, LIENVU, NGATTT]) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [adm.auth, adm.email]);
      await setup.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
         values ($1::uuid, $2::uuid, $3, true, false, 1)`,
        [adm.app, adm.auth, adm.name],
      );
      await setup.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'all', null, '2026-01-01', true)`,
        [adm.app],
      );
      for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
        await setup.query(
          `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
           values ($1::uuid, $2, '2026-01-01', true)`,
          [adm.app, cap],
        );
      }
    }

    const plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    for (let i = groupsIdx; i < hfIdx; i += 1) {
      await setup.query(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
    }

    const { rows: [dateRow] } = await observer.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    const todayIso = dateRow.today;
    const yesterdayIso = addDaysIso(todayIso, -1);

    const { rows: [sysVendorTeam] } = await setup.query(
      "select public.direct_entry_system_vendor_team_id() as team_id",
    );
    assert.ok(sysVendorTeam?.team_id, "__system_vendor__ team must exist");

    const { rows: [recDept] } = await observer.query(
      "select department_id from public.organization_departments where system_key = 'RECRUITMENT' and is_active = true",
    );
    assert.ok(recDept?.department_id, "RECRUITMENT department must exist");

    const TEAM_1 = nextUuid();
    const TEAM_2 = nextUuid();
    const TEAM_INACTIVE = nextUuid();

    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'hf_cat_t1', 'Team 1 HF Catalog', true, 1),
              ($2::uuid, 'hf_cat_t2', 'Team 2 HF Catalog', true, 1),
              ($3::uuid, 'hf_cat_tinact', 'Team Inactive HF Catalog', false, 1)`,
      [TEAM_1, TEAM_2, TEAM_INACTIVE],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'HF Catalog Project 1', true, 1),
              ($2, 'HF Catalog Project 2', true, 1)`,
      [PRJ_1, PRJ_2],
    );
    await setup.query(
      `insert into public.direct_entry_project_team_scopes
         (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
       values ($1, $2::uuid, '2026-01-01', true, 1, $5::uuid),
              ($3, $4::uuid, '2026-01-01', true, 1, $5::uuid)`,
      [PRJ_1, TEAM_1, PRJ_2, TEAM_2, OWNER.app],
    );
    await setup.query(
      `insert into public.direct_entry_banks (bank_id, display_name, active)
       values ('vcb', 'Vietcombank', true)
       on conflict (bank_id) do update set active = true`,
    );
    await setup.query(
      `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
       values ('TEMPORARY', 'Thời vụ', 'thoi_vu', 10, true)
       on conflict (labor_type_key) do update set active = true`,
    );

    // -------------------------------------------------------------------------
    // Actor seeding & assertion helpers
    // -------------------------------------------------------------------------
    async function seedUser(loginPrefix, displayName, { authzManaged = true, enabled = true } = {}) {
      const auth = nextUuid();
      const app = nextUuid();
      const email = `${loginPrefix}@hrpartner.local`;
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, email]);
      await setup.query(
        `insert into public.direct_entry_app_users
           (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
         values ($1::uuid, $2::uuid, $3, $4, $5, 1)`,
        [app, auth, displayName, enabled, authzManaged],
      );
      return { auth, app, email, name: displayName, recruiter: null };
    }

    async function seedRecruiterAndTeam(user, teamId) {
      const recruiterId = nextUuid();
      await setup.query(
        "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
        [recruiterId, user.name],
      );
      await setup.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
        [recruiterId],
      );
      await setup.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
        [recruiterId, teamId],
      );
      await setup.query(
        "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
        [user.app, recruiterId],
      );
      user.recruiter = recruiterId;
      return recruiterId;
    }

    async function assignGroupMember(user, groupCode, reason) {
      const { rows: [grpRow] } = await observer.query(
        "select group_id from public.authz_user_groups where code = $1",
        [groupCode],
      );
      assert.ok(grpRow?.group_id, `Permission group ${groupCode} must exist`);
      const { rows: [uRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [user.app],
      );
      const key = nextUuid();
      return serviceRpc(setup, "direct_entry_authz_assign_group_member_admin", [
        OWNER.auth,
        OWNER.app,
        user.app,
        grpRow.group_id,
        uRow.version,
        reason,
        key,
        sha256(`assign-group:${user.app}:${groupCode}:${key}`),
      ]);
    }

    async function createGroupAndAssign(user, { code, name, teamId = null, capabilities, reason }) {
      const keyCreate = nextUuid();
      await serviceRpc(
        setup,
        "direct_entry_authz_create_group_admin",
        [
          OWNER.auth,
          OWNER.app,
          code,
          name,
          reason,
          recDept.department_id,
          teamId,
          capabilities,
          "[]",
          reason,
          keyCreate,
          sha256(`create-group:${code}:${keyCreate}`),
        ],
        ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
      );
      return assignGroupMember(user, code, reason);
    }

    async function assertZeroCreateOwnGrants(user, label) {
      const { rows: [row] } = await observer.query(
        "select public.direct_entry_authz__internal_resolve_effective_grants($1::uuid) as grants",
        [user.app],
      );
      const grants = row.grants ?? [];
      const hasCreateOrOwn = grants.some(
        (g) => g.capability === "entry_create" || g.capability === "entry_own",
      );
      assert.equal(hasCreateOrOwn, false, `${label} must have ZERO entry_create/entry_own grants`);
      return grants;
    }

    async function setUserEnabled(user, enabled, reason) {
      const { rows: [uRow] } = await observer.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [user.app],
      );
      const fnName = enabled ? "direct_entry_enable_app_user" : "direct_entry_disable_app_user";
      return serviceRpc(setup, fnName, [
        OWNER.auth,
        OWNER.app,
        user.app,
        uRow.version,
        reason,
        nextKey(enabled ? "en" : "dis"),
      ]);
    }

    async function getTeamVersion(teamId) {
      const { rows: [row] } = await observer.query(
        "select version from public.teams where team_id = $1::uuid",
        [teamId],
      );
      return row.version;
    }

    async function getProjectVersion(projectId) {
      const { rows: [row] } = await observer.query(
        "select version from public.direct_entry_projects where project_id = $1",
        [projectId],
      );
      return row.version;
    }

    async function callCatalog(user, effectiveDate = "2026-03-01") {
      return serviceRpc(
        setup,
        "direct_entry_input_catalog",
        [user.auth, user.app, effectiveDate],
        ["uuid", "uuid", "date"],
      );
    }

    async function expectCatalogDenied(user, effectiveDate = "2026-03-01") {
      return expectServiceRpcError(
        setup,
        "direct_entry_input_catalog",
        [user.auth, user.app, effectiveDate],
        "42501",
        /actor capability denied/,
        ["uuid", "uuid", "date"],
      );
    }

    function assertValidCatalogShape(catalog, expectedProjectIds) {
      assert.ok(Array.isArray(catalog.recruiters) && catalog.recruiters.length >= 2, "recruiters must be populated");
      assert.ok(Array.isArray(catalog.banks) && catalog.banks.length >= 1, "banks must be populated");
      assert.ok(Array.isArray(catalog.labor_types) && catalog.labor_types.length >= 1, "labor_types must be populated");
      const actualProjectIds = (catalog.projects ?? []).map((p) => p.project_id).sort();
      assert.deepEqual(actualProjectIds, [...expectedProjectIds].sort(), "projects list mismatch");
    }

    // -------------------------------------------------------------------------
    // Seed all test actors
    // -------------------------------------------------------------------------
    const recT1 = await seedUser("hf.rec.t1", "Recruiter Team 1");
    await seedRecruiterAndTeam(recT1, TEAM_1);
    await assignGroupMember(recT1, "RECRUITER_OPERATIONS", "Baseline recruiter T1");

    const recT2 = await seedUser("hf.rec.t2", "Recruiter Team 2");
    await seedRecruiterAndTeam(recT2, TEAM_2);
    await assignGroupMember(recT2, "RECRUITER_OPERATIONS", "Baseline recruiter T2");

    // Pure single-role managed actors (ZERO entry_create/entry_own)
    const pureTl = await seedUser("hf.pure.tl", "Pure Team Leader T1");
    await seedRecruiterAndTeam(pureTl, TEAM_1);
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      pureTl.app,
      null,
      await getTeamVersion(TEAM_1),
      "Designate pure TL for TEAM_1",
      nextUuid(),
    ]);
    await assertZeroCreateOwnGrants(pureTl, "pureTl");

    const purePm = await seedUser("hf.pure.pm", "Pure Project Manager PRJ_1");
    await seedRecruiterAndTeam(purePm, TEAM_1);
    await serviceRpc(setup, "direct_entry_assign_project_manager", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      purePm.recruiter,
      null,
      await getProjectVersion(PRJ_1),
      "Assign pure PM for PRJ_1",
      nextUuid(),
    ]);
    await assertZeroCreateOwnGrants(purePm, "purePm");

    // Actors for pure entry_privileged_edit (ALL, OWN, CONTEXT_TEAM), pure Full Admin, and invalid scopes
    // (evaluated via effective-grant resolution in dedicated subtests with zero entry_create/entry_own)
    const privAll = await seedUser("hf.priv.all", "Pure Priv Edit ALL");
    const privOwn = await seedUser("hf.priv.own", "Pure Priv Edit OWN");
    const privTeam = await seedUser("hf.priv.team", "Pure Priv Edit CONTEXT_TEAM");
    const pureFullAdmin = await seedUser("hf.pure.fulladmin", "Pure Full Admin No Create");
    const privInactiveTeam = await seedUser("hf.priv.inact", "Priv Edit Inactive Team");
    const privSysVendor = await seedUser("hf.priv.sysven", "Priv Edit System Vendor Team");
    const privDeptScope = await seedUser("hf.priv.dept", "Priv Edit CONTEXT_DEPARTMENT");

    // Legacy (authz_managed = false) pure entry_privileged_edit actors
    const legacyPrivAll = await seedUser("hf.leg.priv.all", "Legacy Priv Edit Valid ALL", { authzManaged: false });
    await setup.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true)",
      [legacyPrivAll.app],
    );
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true)",
      [legacyPrivAll.app],
    );

    const legacyPrivOwn = await seedUser("hf.leg.priv.own", "Legacy Priv Edit Valid OWN", { authzManaged: false });
    await setup.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true)",
      [legacyPrivOwn.app],
    );
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'own', null, '2026-01-01', true)",
      [legacyPrivOwn.app],
    );

    const legacyPrivTeam = await seedUser("hf.leg.priv.team", "Legacy Priv Edit Valid Active Team", { authzManaged: false });
    await setup.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true)",
      [legacyPrivTeam.app],
    );
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
      [legacyPrivTeam.app, TEAM_1],
    );

    const legacyPrivNoScope = await seedUser("hf.leg.priv.noscope", "Legacy Priv Edit No Scope", { authzManaged: false });
    await setup.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true)",
      [legacyPrivNoScope.app],
    );

    const legacyPrivBadTeam = await seedUser("hf.leg.priv.badteam", "Legacy Priv Edit Inactive Team", { authzManaged: false });
    await setup.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, 'entry_privileged_edit', '2026-01-01', true)",
      [legacyPrivBadTeam.app],
    );
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
      [legacyPrivBadTeam.app, TEAM_INACTIVE],
    );

    // Unauthorized / lacking-permission actors
    const hrOnly = await seedUser("hf.hr.only", "HR Operator Only");
    await assignGroupMember(hrOnly, "HR_CATALOG_OPERATOR", "HR_ONLY actor");

    const empStale = await seedUser("hf.emp.stale", "Employee Base Stale Legacy");
    for (const cap of ["entry_create", "entry_own", "entry_privileged_edit"]) {
      await setup.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [empStale.app, cap],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true)",
      [empStale.app],
    );

    const orgOnly = await seedUser("hf.org.only", "Org Only Member");
    const orgEmpCode = `EMP-ORG-${empCodeSeq++}`;
    await serviceRpc(setup, "org_department_create_person_admin", [
      OWNER.auth,
      OWNER.app,
      orgEmpCode,
      orgOnly.name,
      "2024-01-01",
      recDept.department_id,
      orgOnly.app,
      1,
      null,
      "Onboard org-only member",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: orgEmpCode,
        full_name: orgOnly.name,
        joined_on: "2024-01-01",
        initial_department_ref: recDept.department_id,
        account_ref: orgOnly.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Onboard org-only member",
      }),
    ]);

    const viewOnly = await seedUser("hf.view.only", "View Only Actor");
    await createGroupAndAssign(viewOnly, {
      code: "HF_VIEW_ONLY",
      name: "HF View Only",
      capabilities: ["document_view", "audit_view"],
      reason: "View-only capabilities without entry_create/entry_own/entry_privileged_edit",
    });

    // Seed baseline entries in TEAM_1/PRJ_1 and TEAM_2/PRJ_2 for write & upload guard checks
    const batchT1P1 = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      recT1.auth,
      recT1.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ projectId: PRJ_1, recruiterId: recT1.recruiter, name: "Worker T1 P1" })]),
      nextUuid(),
    ]);
    const entryT1P1 = batchT1P1.entry_ids[0];
    await serviceRpc(setup, "direct_entry_transition_submission", [
      recT1.auth,
      recT1.app,
      batchT1P1.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);

    const draftT1P1Batch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      recT1.auth,
      recT1.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ projectId: PRJ_1, recruiterId: recT1.recruiter, name: "Other Draft T1 P1" })]),
      nextUuid(),
    ]);
    const otherDraftT1P1 = draftT1P1Batch.entry_ids[0];

    const batchT2P2 = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
      recT2.auth,
      recT2.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ projectId: PRJ_2, recruiterId: recT2.recruiter, name: "Worker T2 P2" })]),
      nextUuid(),
    ]);
    const entryT2P2 = batchT2P2.entry_ids[0];
    await serviceRpc(setup, "direct_entry_transition_submission", [
      recT2.auth,
      recT2.app,
      batchT2P2.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);

    async function withEffectiveGrantsForPureEditAndAdmin(fn) {
      const { rows: [origResolveFn] } = await observer.query(
        "select pg_catalog.pg_get_functiondef('public.direct_entry_authz__internal_resolve_effective_grants(uuid)'::regprocedure) as fn_def",
      );
      assert.ok(origResolveFn?.fn_def, "Original direct_entry_authz__internal_resolve_effective_grants(uuid) must exist");
      try {
        await setup.query(
          `create or replace function public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id uuid)
           returns jsonb
           language sql
           stable
           security definer
           set search_path = pg_catalog, public
           as $function$
             select case
               when not exists (
                 select 1 from public.direct_entry_app_users u
                  where u.app_user_id = p_app_user_id and u.enabled
               ) then '[]'::jsonb
               when p_app_user_id = '${OWNER.app}'::uuid then
                 '[{"capability":"entry_admin","scope_kind":"ALL","scope_id":null},{"capability":"recruiter_master_manage","scope_kind":"ALL","scope_id":null},{"capability":"team_master_manage","scope_kind":"ALL","scope_id":null}]'::jsonb
               when p_app_user_id = '${privAll.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"ALL","scope_id":null}]'::jsonb
               when p_app_user_id = '${privOwn.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"OWN","scope_id":null}]'::jsonb
               when p_app_user_id = '${privTeam.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${TEAM_1}"}]'::jsonb
               when p_app_user_id = '${pureFullAdmin.app}'::uuid then
                 '[{"capability":"entry_admin","scope_kind":"ALL","scope_id":null},{"capability":"recruiter_master_manage","scope_kind":"ALL","scope_id":null},{"capability":"team_master_manage","scope_kind":"ALL","scope_id":null}]'::jsonb
               when p_app_user_id = '${privDeptScope.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_DEPARTMENT","scope_id":"${recDept.department_id}"}]'::jsonb
               when p_app_user_id = '${privInactiveTeam.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${TEAM_INACTIVE}"}]'::jsonb
               when p_app_user_id = '${privSysVendor.app}'::uuid then
                 '[{"capability":"entry_privileged_edit","scope_kind":"CONTEXT_TEAM","scope_id":"${sysVendorTeam.team_id}"}]'::jsonb
               else '[]'::jsonb
             end
           $function$`,
        );
        for (const [label, actor] of [
          ["privAll", privAll],
          ["privOwn", privOwn],
          ["privTeam", privTeam],
          ["pureFullAdmin", pureFullAdmin],
        ]) {
          await assertZeroCreateOwnGrants(actor, label);
        }
        return await fn();
      } finally {
        await setup.query(origResolveFn.fn_def);
      }
    }

    async function verifyRealRoleWriteAndUploadGuards(phaseLabel) {
      // Out-of-scope direct_entry_privileged_edit -> 42501
      await expectServiceRpcError(
        setup,
        "direct_entry_privileged_edit",
        [purePm.auth, purePm.app, entryT2P2, 1, JSON.stringify({ labor_type: "TEMPORARY" }), `${phaseLabel} out-of-scope PM edit`, nextKey("oos_pm")],
        "42501",
      );
      await expectServiceRpcError(
        setup,
        "direct_entry_privileged_edit",
        [pureTl.auth, pureTl.app, entryT2P2, 1, JSON.stringify({ labor_type: "TEMPORARY" }), `${phaseLabel} out-of-scope TL edit`, nextKey("oos_tl")],
        "42501",
      );

      // Pure TL cannot create workers
      await expectInternalError(
        setup,
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date)",
        [pureTl.auth, pureTl.app, PRJ_1],
        "42501",
        /worker create authority denied/,
      );
      await expectServiceRpcError(
        setup,
        "direct_entry_create_full_profile_batch",
        [pureTl.auth, pureTl.app, "worker-profile/1.2", JSON.stringify([makeFullProfileRow({ projectId: PRJ_1, recruiterId: recT1.recruiter })]), nextUuid()],
        "42501",
        /worker create authority denied/,
      );

      // Pure PM create authority: allowed for PRJ_1, denied for PRJ_2
      const pmCreateAuthP1 = (
        await observer.query(
          "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date) as auth",
          [purePm.auth, purePm.app, PRJ_1],
        )
      ).rows[0].auth;
      assert.equal(pmCreateAuthP1, "manager", `${phaseLabel}: PM create authority for PRJ_1 must be 'manager'`);

      await expectInternalError(
        setup,
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date)",
        [purePm.auth, purePm.app, PRJ_2],
        "42501",
        /worker create authority denied/,
      );
      await expectServiceRpcError(
        setup,
        "direct_entry_create_full_profile_batch",
        [purePm.auth, purePm.app, "worker-profile/1.2", JSON.stringify([makeFullProfileRow({ projectId: PRJ_2, recruiterId: recT2.recruiter })]), nextUuid()],
        "42501",
        /worker create authority denied/,
      );

      // Upload rules: Pure PM draft self-upload allowed in PRJ_1 without document_upload
      const pmOwnBatch = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
        purePm.auth,
        purePm.app,
        "worker-profile/1.2",
        JSON.stringify([makeFullProfileRow({ projectId: PRJ_1, recruiterId: purePm.recruiter, name: `PM Own Draft ${phaseLabel}` })]),
        nextUuid(),
      ]);
      assert.equal(pmOwnBatch.state, "DRAFT");
      const pmOwnEntryId = pmOwnBatch.entry_ids[0];

      const pmOwnUploadScope = (
        await observer.query(
          "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid) as s",
          [purePm.auth, purePm.app, pmOwnEntryId],
        )
      ).rows[0].s;
      assert.equal(pmOwnUploadScope, "project", `${phaseLabel}: pure PM own DRAFT self-upload exception must hold`);

      const reserved = await serviceRpc(setup, "direct_entry_reserve_document_direct_upload", [
        purePm.auth,
        purePm.app,
        pmOwnEntryId,
        1,
        "CCCD_FRONT",
        nextUuid(),
        2048,
        "image/jpeg",
        null,
      ]);
      await serviceRpc(setup, "direct_entry_finalize_document_direct_upload", [
        purePm.auth,
        purePm.app,
        pmOwnEntryId,
        reserved.document_id,
        reserved.entry_version,
        nextUuid(),
        "validated",
        sha256(`pm-own-draft-${phaseLabel}-${reserved.document_id}`),
        2048,
        "image/jpeg",
      ]);

      // Pure PM cannot upload to someone else's DRAFT or SUBMITTED entry without document_upload
      for (const targetEntryId of [otherDraftT1P1, entryT1P1]) {
        await expectInternalError(
          setup,
          "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
          [purePm.auth, purePm.app, targetEntryId],
          "42501",
          /capability denied/,
        );
        await expectServiceRpcError(
          setup,
          "direct_entry_reserve_document_direct_upload",
          [purePm.auth, purePm.app, targetEntryId, 1, "CCCD_FRONT", nextUuid(), 2048, "image/jpeg", "Should fail"],
          "42501",
          /capability denied/,
        );
      }
    }

    async function verifyPrivAndAdminWriteAndUploadGuards(phaseLabel) {
      // Out-of-scope direct_entry_privileged_edit -> 42501
      await expectServiceRpcError(
        setup,
        "direct_entry_privileged_edit",
        [privTeam.auth, privTeam.app, entryT2P2, 1, JSON.stringify({ labor_type: "TEMPORARY" }), `${phaseLabel} out-of-scope team edit`, nextKey("oos_team")],
        "42501",
      );
      await expectServiceRpcError(
        setup,
        "direct_entry_privileged_edit",
        [privOwn.auth, privOwn.app, entryT1P1, 1, JSON.stringify({ labor_type: "TEMPORARY" }), `${phaseLabel} out-of-scope own edit`, nextKey("oos_own")],
        "42501",
      );

      // direct_entry_create_authority & direct_entry_create_full_profile_batch remain rejected 42501
      for (const actor of [privAll, privOwn, privTeam, pureFullAdmin]) {
        await expectInternalError(
          setup,
          "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date)",
          [actor.auth, actor.app, PRJ_1],
          "42501",
          /worker create authority denied/,
        );
        await expectServiceRpcError(
          setup,
          "direct_entry_create_full_profile_batch",
          [actor.auth, actor.app, "worker-profile/1.2", JSON.stringify([makeFullProfileRow({ projectId: PRJ_1, recruiterId: recT1.recruiter })]), nextUuid()],
          "42501",
          /worker create authority denied/,
        );
      }

      // Pure entry_privileged_edit without document_upload is rejected (42501)
      for (const privActor of [privAll, privOwn, privTeam]) {
        for (const targetEntryId of [otherDraftT1P1, entryT1P1]) {
          await expectInternalError(
            setup,
            "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
            [privActor.auth, privActor.app, targetEntryId],
            "42501",
            /capability denied/,
          );
          await expectServiceRpcError(
            setup,
            "direct_entry_reserve_document_direct_upload",
            [privActor.auth, privActor.app, targetEntryId, 1, "CCCD_FRONT", nextUuid(), 2048, "image/jpeg", "Should fail"],
            "42501",
            /capability denied/,
          );
        }
      }
    }

    // -------------------------------------------------------------------------
    // BEFORE migration 20261127010000: all newly allowed roles MUST fail catalog
    // -------------------------------------------------------------------------
    await t.test("Pre-20261127010000 baseline: new roles denied on catalog, RECRUITER allowed, write/upload guards active", async () => {
      const recCatalog = await callCatalog(recT1);
      assertValidCatalogShape(recCatalog, []);

      for (const actor of [pureTl, purePm, legacyPrivAll, legacyPrivOwn, legacyPrivTeam]) {
        await expectCatalogDenied(actor);
      }
      await verifyRealRoleWriteAndUploadGuards("pre-migration");

      await withEffectiveGrantsForPureEditAndAdmin(async () => {
        for (const actor of [privAll, privOwn, privTeam, pureFullAdmin]) {
          await expectCatalogDenied(actor);
        }
        await verifyPrivAndAdminWriteAndUploadGuards("pre-migration");
      });
    });

    // -------------------------------------------------------------------------
    // Apply 20261127010000_hf_direct_entry_catalog_privileged_edit_read.sql
    // -------------------------------------------------------------------------
    await setup.query(await readFile(path.join(MIGRATION_DIR, HF_MIGRATION_NAME), "utf8"));

    await t.test("Post-20261127010000 (real tables): pure TL, pure PM (PRJ_1 filtered), and legacy entry_privileged_edit succeed", async () => {
      // p_effective_date IS NULL still fails 22023
      await expectServiceRpcError(
        setup,
        "direct_entry_input_catalog",
        [purePm.auth, purePm.app, null],
        "22023",
        /effective date required/,
        ["uuid", "uuid", "date"],
      );

      // d) Pure active Team Leader -> allowed (projects: [])
      assertValidCatalogShape(await callCatalog(pureTl), []);
      // e) Pure active Project Manager (PRJ_1 only, PRJ_2 filtered out!)
      assertValidCatalogShape(await callCatalog(purePm), [PRJ_1]);
      // g) Legacy (authz_managed = false) pure entry_privileged_edit with valid scope (all, own, active team)
      assertValidCatalogShape(await callCatalog(legacyPrivAll), []);
      assertValidCatalogShape(await callCatalog(legacyPrivOwn), []);
      assertValidCatalogShape(await callCatalog(legacyPrivTeam), []);
    });

    await t.test("Post-20261127010000 (real tables): denied actors (invalid legacy scopes, HR_ONLY, EMP_STALE, org-only, view-only, disabled & revoked TL/PM)", async () => {
      // Invalid legacy scopes
      for (const actor of [legacyPrivNoScope, legacyPrivBadTeam]) {
        await expectCatalogDenied(actor);
      }

      // Unauthorized / lacking-permission actors
      for (const actor of [hrOnly, empStale, orgOnly, viewOnly]) {
        await expectCatalogDenied(actor);
      }

      // Disabled account (enabled = false) for pure TL & pure PM (plus re-enable recovery)
      for (const [label, actor, expectedProjects] of [
        ["pureTl", pureTl, []],
        ["purePm", purePm, [PRJ_1]],
      ]) {
        await setUserEnabled(actor, false, `Disable ${label} for catalog check`);
        await expectCatalogDenied(actor);
        await setUserEnabled(actor, true, `Re-enable ${label} after catalog check`);
        assertValidCatalogShape(await callCatalog(actor), expectedProjects);
      }

      // Revoked TL & revoked PM (simulated clock D-1 -> D): historical p_effective_date = D-1 STILL fails 42501!
      const { rows: [origClockFn] } = await observer.query(
        "select pg_catalog.pg_get_functiondef('public.direct_entry_authorization_date()'::regprocedure) as fn_def",
      );
      assert.ok(origClockFn?.fn_def, "Original direct_entry_authorization_date() must exist");

      const setAuthDateClock = async (isoDate) => {
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
      };

      const revokedTlTeam = nextUuid();
      await setup.query(
        "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'hf_cat_rev_tl', 'Revoked TL Team', true, 1)",
        [revokedTlTeam],
      );
      const revokedTl = await seedUser("hf.rev.tl", "Revoked TL Actor");
      await seedRecruiterAndTeam(revokedTl, revokedTlTeam);

      const revokedPm = await seedUser("hf.rev.pm", "Revoked PM Actor");
      await seedRecruiterAndTeam(revokedPm, TEAM_1);

      try {
        await setAuthDateClock(yesterdayIso);

        await serviceRpc(
          setup,
          "direct_entry_designate_team_leader",
          [
            OWNER.auth,
            OWNER.app,
            revokedTlTeam,
            revokedTl.app,
            yesterdayIso,
            await getTeamVersion(revokedTlTeam),
            "Designate revokedTl on D-1",
            nextKey("des_rev_tl"),
          ],
          ["uuid", "uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );

        const pmAssignRes = await serviceRpc(
          setup,
          "direct_entry_assign_project_manager",
          [
            OWNER.auth,
            OWNER.app,
            PRJ_1,
            revokedPm.recruiter,
            yesterdayIso,
            await getProjectVersion(PRJ_1),
            "Assign revokedPm on D-1",
            nextKey("asg_rev_pm"),
          ],
          ["uuid", "uuid", "text", "uuid", "date", "int", "text", "text"],
        );

        assertValidCatalogShape(await callCatalog(revokedTl, yesterdayIso), []);
        assertValidCatalogShape(await callCatalog(revokedPm, yesterdayIso), [PRJ_1]);

        await setAuthDateClock(todayIso);

        await serviceRpc(
          setup,
          "direct_entry_revoke_team_leader",
          [
            OWNER.auth,
            OWNER.app,
            revokedTlTeam,
            todayIso,
            await getTeamVersion(revokedTlTeam),
            "Revoke revokedTl on D",
            nextKey("rev_tl"),
          ],
          ["uuid", "uuid", "uuid", "date", "int", "text", "text"],
        );

        await serviceRpc(
          setup,
          "direct_entry_unassign_project_manager",
          [
            OWNER.auth,
            OWNER.app,
            pmAssignRes.assignment_id,
            1,
            await getProjectVersion(PRJ_1),
            "Unassign revokedPm on D",
            nextKey("rev_pm"),
          ],
          ["uuid", "uuid", "uuid", "int", "int", "text", "text"],
        );

        // Historical p_effective_date = D-1 AND current todayIso MUST BOTH fail 42501!
        await expectCatalogDenied(revokedTl, yesterdayIso);
        await expectCatalogDenied(revokedTl, todayIso);
        await expectCatalogDenied(revokedPm, yesterdayIso);
        await expectCatalogDenied(revokedPm, todayIso);
      } finally {
        await setup.query(origClockFn.fn_def);
      }
    });

    await t.test("Post-20261127010000 (real tables): TL/PM write guards, batch creation & upload rules unchanged", async () => {
      await verifyRealRoleWriteAndUploadGuards("post-migration");

      const pmEditRes = await serviceRpc(setup, "direct_entry_privileged_edit", [
        purePm.auth,
        purePm.app,
        entryT1P1,
        1,
        JSON.stringify({ labor_type: "TEMPORARY" }),
        "In-scope PRJ_1 PM direct edit",
        nextKey("ok_pm_edit"),
      ]);
      assert.equal(pmEditRes.version, 2);
    });

    await t.test("Post-20261127010000 (pure entry_privileged_edit ALL/OWN/CONTEXT_TEAM & pure Full Admin): catalog, invalid scopes, disabled, write/upload guards", async () => {
      await withEffectiveGrantsForPureEditAndAdmin(async () => {
        // a) Pure entry_privileged_edit @ ALL
        assertValidCatalogShape(await callCatalog(privAll), []);
        // b) Pure entry_privileged_edit @ OWN
        assertValidCatalogShape(await callCatalog(privOwn), []);
        // c) Pure entry_privileged_edit @ CONTEXT_TEAM (active non-__system_vendor__)
        assertValidCatalogShape(await callCatalog(privTeam), []);
        // f) Pure Full Admin (NO entry_create/entry_own) sees ALL active projects
        assertValidCatalogShape(await callCatalog(pureFullAdmin), [PRJ_1, PRJ_2]);

        // Denied invalid scopes: inactive team, __system_vendor__, CONTEXT_DEPARTMENT
        for (const actor of [privInactiveTeam, privSysVendor, privDeptScope]) {
          await expectCatalogDenied(actor);
        }

        // Disabled account (enabled = false) for entry_privileged_edit & Full Admin (with recovery)
        for (const [label, actor, expectedProjects] of [
          ["privAll", privAll, []],
          ["pureFullAdmin", pureFullAdmin, [PRJ_1, PRJ_2]],
        ]) {
          await setUserEnabled(actor, false, `Disable ${label} for catalog check`);
          await expectCatalogDenied(actor);
          await setUserEnabled(actor, true, `Re-enable ${label} after catalog check`);
          assertValidCatalogShape(await callCatalog(actor), expectedProjects);
        }

        // Write guards, create_authority/batch rejections & upload rejections unchanged
        await verifyPrivAndAdminWriteAndUploadGuards("post-migration");

        // Positive sanity: in-scope direct edit still works for privAll and privTeam
        const privAllEdit = await serviceRpc(setup, "direct_entry_privileged_edit", [
          privAll.auth,
          privAll.app,
          entryT1P1,
          2,
          JSON.stringify({ labor_type: "TEMPORARY" }),
          "In-scope ALL privileged edit",
          nextKey("ok_priv_all"),
        ]);
        assert.equal(privAllEdit.version, 3);

        const privTeamEdit = await serviceRpc(setup, "direct_entry_privileged_edit", [
          privTeam.auth,
          privTeam.app,
          entryT1P1,
          3,
          JSON.stringify({ labor_type: "TEMPORARY" }),
          "In-scope TEAM_1 privileged edit",
          nextKey("ok_priv_team"),
        ]);
        assert.equal(privTeamEdit.version, 4);
      });
    });

    await t.test("Post-20261127010000: ACL & security metadata verification", async () => {
      const { rows } = await observer.query(`
        select p.proname,
               p.prosecdef,
               p.proconfig,
               pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
               pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
               pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
               pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('direct_entry_input_catalog', 'direct_entry_input_catalog_unscoped_v42')
         order by p.proname
      `);
      assert.equal(rows.length, 2, "Both catalog functions must have single overloads");

      const outer = rows.find((r) => r.proname === "direct_entry_input_catalog");
      const inner = rows.find((r) => r.proname === "direct_entry_input_catalog_unscoped_v42");

      assert.equal(outer.prosecdef, true);
      assert.deepEqual(outer.proconfig, ["search_path=pg_catalog, public"]);
      assert.equal(outer.pub_exec, false);
      assert.equal(outer.anon_exec, false);
      assert.equal(outer.auth_exec, false);
      assert.equal(outer.svc_exec, true);

      assert.equal(inner.prosecdef, true);
      assert.deepEqual(inner.proconfig, ["search_path=pg_catalog, public"]);
      assert.equal(inner.pub_exec, false);
      assert.equal(inner.anon_exec, false);
      assert.equal(inner.auth_exec, false);
      assert.equal(inner.svc_exec, false);
    });
  } finally {
    await Promise.allSettled(clients.map((c) => c.end()));
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
