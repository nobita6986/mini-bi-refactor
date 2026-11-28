/**
 * Collaborators (CTV) End-to-End Integration — Isolated PostgreSQL 18 Suite.
 *
 * Pure ESM (`node --conditions=react-server --test scripts/collaborators-integration-db.test.mjs`)
 * running against a dedicated native PostgreSQL 18 cluster (`initdb` + `pg_ctl`) with full
 * migration replay, testing strict E2E flow:
 *   1. Catalog & AuthZ (Branch A): `direct_entry_assert_catalog_operator`, 5 collaborator admin RPCs,
 *      active-only CTV exposure in `direct_entry_input_catalog`, Vendor/CTV independence & zero
 *      `recruiters` shadow rows.
 *   2. Direct Entry Write/Edit/CR & Historical Preservation (Branch B): real write RPCs
 *      (`create_batch`, `create_full_profile_batch`, `create_draft_row`, `update_own_draft_row`,
 *      `privileged_edit`, `create_change_request` + `approve_change_request`), many-to-many NVTD<->CTV,
 *      source switches (`CTV->HRP`, `HRP->CTV`, `CTV->Vendor`), deactivated CTV preservation on
 *      reads/exports/history/non-source edits/legacy CRs & retroactive `first_work_date`.
 *   3. Reporting & `10 = 6 + 4` Reconciliation (Branch C): `direct_entry_reporting_scoped_options`,
 *      `direct_entry_reporting_scoped_facts`, `buildDetailedRecruitmentMatrix` across Day/Week/Month,
 *      `hrp`/`hrp_direct`/`hrp_ctv`/`vendor` channels, collaborator filters (incl. deactivated CTV),
 *      `all`/`team`/`own` scopes, and Vendor Referrer / Vendor Finance isolation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import {
  buildDetailedRecruitmentMatrix,
  formatDetailedMatrixMetricCell,
} from "../src/lib/reporting/detailed-recruitment-matrix.ts";
import { parseReportingFilters } from "../src/lib/reporting/p1-filter.ts";
import { runMigrationApply } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

let seq = 1;
function nextUuid() {
  return `98200000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `ctv_db_${prefix}_${seq++}`;
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
function workerDetailsPayload(displayName) {
  return {
    display_name: displayName,
    date_of_birth: { state: "unknown" },
    national_id: { state: "omitted" },
    address: { state: "unknown" },
    phone: { state: "unknown" },
  };
}

describe("Collaborators (CTV) E2E — PG18 Integration Suite", () => {
  const clients = [];
  let tmpDir = "";
  let pgData = "";
  let pgLog = "";
  let pgCtl = null;
  let port = 0;
  let started = false;
  let setup = null;

  let deptByKey = {};
  let grpByCode = {};

  let OWNER = null; // SYSTEM_ADMIN + MANAGEMENT_BOD
  let HR_OP = null; // HR_CATALOG_OPERATOR
  let ACCOUNTING_OP = null; // ACCOUNTING_OPERATIONS
  let TL_TEAM1 = null; // Team Leader of TEAM_1
  let EMP_TEAM1 = null; // Regular RECRUITER_OPERATIONS in TEAM_1 (NVTD 1)
  let EMP_TEAM1_B = null; // Second HRP recruiter in TEAM_1 (NVTD 2)
  let EMP_TEAM2 = null; // HRP recruiter in TEAM_2
  let PM_PROPOSER = null; // Assigned Project Manager for PRJ_1

  let TEAM_1 = "";
  let TEAM_2 = "";
  let PRJ_1 = "ctv-prj-1";
  let PRJ_2 = "ctv-prj-2";

  let VENDOR_1 = null;

  async function serviceRpc(fnName, args = [], casts = []) {
    const placeholders = args
      .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
      .join(", ");
    const sql = `select public.${fnName}(${placeholders}) as data`;
    await setup.query("begin; set local statement_timeout = '15s'; set local role service_role");
    try {
      const res = await setup.query(sql, args);
      await setup.query("commit");
      return res.rows[0]?.data;
    } catch (err) {
      await setup.query("rollback").catch(() => {});
      throw err;
    }
  }

  async function tryServiceRpc(fnName, args = [], casts = []) {
    try {
      const data = await serviceRpc(fnName, args, casts);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: err?.code ?? "ERR", message: err?.message ?? String(err) };
    }
  }

  async function getAccountVersion(appUserId) {
    const { rows: [r] } = await setup.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [appUserId],
    );
    return r.version;
  }

  async function seedAppUser(slug, displayName) {
    const auth = nextUuid();
    const app = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
      auth,
      `${slug}@hrpartner.local`,
    ]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, true, true, 1)`,
      [app, auth, displayName],
    );
    return { auth, app, slug, name: displayName };
  }

  async function assignGroup(actor, targetAppUserId, groupId, reason) {
    const ver = await getAccountVersion(targetAppUserId);
    const idemp = nextUuid();
    return serviceRpc(
      "direct_entry_authz_assign_group_member_admin",
      [actor.auth, actor.app, targetAppUserId, groupId, ver, reason, idemp, sha256(`grp:${targetAppUserId}:${groupId}:${idemp}`)],
      ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
    );
  }

  async function seedPersonWithAccount({
    slug,
    displayName,
    deptId,
    withRecruiter = true,
    teamId = null,
    groupId = null,
    actorForCreate = null,
  }) {
    const acc = await seedAppUser(slug, displayName);
    let rec = null;
    const code = `CTV_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)}_${seq}`;
    if (withRecruiter) {
      rec = nextUuid();
      await setup.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [rec, displayName, code],
      );
      await setup.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2025-01-01', true)`,
        [rec],
      );
      if (teamId) {
        await setup.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2025-01-01', true)`,
          [rec, teamId],
        );
      }
      await setup.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2025-01-01', true)`,
        [acc.app, rec],
      );
    }

    let personId = null;
    if (actorForCreate && deptId) {
      const empCode = `EMP-${code}`;
      const pRes = await serviceRpc("org_department_create_person_admin", [
        actorForCreate.auth,
        actorForCreate.app,
        empCode,
        displayName,
        "2025-01-01",
        deptId,
        acc.app,
        1,
        rec,
        `Seed ${slug}`,
        nextUuid(),
        computeCreatePersonFingerprint(actorForCreate.app, {
          employee_code: empCode,
          full_name: displayName,
          joined_on: "2025-01-01",
          initial_department_ref: deptId,
          account_ref: acc.app,
          expected_account_version: 1,
          recruiter_id: rec,
          reason: `Seed ${slug}`,
        }),
      ]);
      personId = pRes.person.person_id;
    } else if (deptId) {
      personId = nextUuid();
      const empCode = `EMP-${code}`;
      await setup.query(
        `insert into public.organization_persons (person_id, employee_code, full_name, joined_on, status, recruiter_id, version)
         values ($1::uuid, $2, $3, '2025-01-01', 'ACTIVE', $4::uuid, 1)`,
        [personId, empCode, displayName, rec],
      );
      await setup.query(
        `insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason)
         values ($1::uuid, $2::uuid, '2025-01-01T00:00:00Z', 'Seed account-person link')`,
        [acc.app, personId],
      );
      await setup.query(
        `insert into public.organization_person_department_memberships (person_id, department_id, started_at, reason)
         values ($1::uuid, $2::uuid, '2025-01-01T00:00:00Z', 'Seed person department membership')`,
        [personId, deptId],
      );
    }

    if (groupId && actorForCreate) {
      await assignGroup(actorForCreate, acc.app, groupId, `Assign ${slug}`);
    }

    return { ...acc, rec, personId, code };
  }

  before(async () => {
    const initdb = binary("initdb");
    pgCtl = binary("pg_ctl");
    assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb and pg_ctl binaries are required");

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ctv-integration-pg18-"));
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

    setup = await connect(port, "ctv-setup");
    clients.push(setup);

    await setup.query(
      "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const applyRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl, projectRef: "pg18ctv", usesPooler: false }),
      createClient: (url) => new Client({ connectionString: url }),
      log: () => {},
    });
    const allMigs = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.equal(applyRes.totalCount, allMigs.length);
    assert.equal(applyRes.appliedCount, allMigs.length);

    const { rows: depts } = await setup.query(
      "select department_id::text, system_key from public.organization_departments where is_active = true",
    );
    deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));

    const { rows: grps } = await setup.query(
      "select group_id::text, code from public.authz_user_groups where active = true",
    );
    grpByCode = Object.fromEntries(grps.map((g) => [g.code, g.group_id]));

    OWNER = await seedPersonWithAccount({
      slug: "owner",
      displayName: "Owner Admin",
      deptId: deptByKey.MANAGEMENT_BOD,
      withRecruiter: false,
    });
    await setup.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason, is_protected, protected_reason)
       values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Seed Owner', true, 'PROTECTED_OWNER_ADMIN')`,
      [grpByCode.SYSTEM_ADMIN, OWNER.app],
    );

    TEAM_1 = nextUuid();
    TEAM_2 = nextUuid();
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'ctv_team_1', 'Đội CTV 1', true, 1),
              ($2::uuid, 'ctv_team_2', 'Đội CTV 2', true, 1)`,
      [TEAM_1, TEAM_2],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự án CTV 1', true, 1), ($2, 'Dự án CTV 2', true, 1)`,
      [PRJ_1, PRJ_2],
    );
    await setup.query(
      `insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
       values
         ($1, $3::uuid, '2025-01-01', true, 1, $5::uuid),
         ($2, $3::uuid, '2025-01-01', true, 1, $5::uuid),
         ($1, $4::uuid, '2025-01-01', true, 1, $5::uuid)`,
      [PRJ_1, PRJ_2, TEAM_1, TEAM_2, OWNER.app],
    );

    HR_OP = await seedPersonWithAccount({
      slug: "hrop",
      displayName: "HR Catalog Op",
      deptId: deptByKey.RECRUITMENT,
      withRecruiter: false,
      groupId: grpByCode.HR_CATALOG_OPERATOR,
      actorForCreate: OWNER,
    });
    ACCOUNTING_OP = await seedPersonWithAccount({
      slug: "acct",
      displayName: "Accounting Op",
      deptId: deptByKey.ACCOUNTING,
      withRecruiter: false,
      groupId: grpByCode.ACCOUNTING_OPERATIONS,
      actorForCreate: OWNER,
    });

    EMP_TEAM1 = await seedPersonWithAccount({
      slug: "nvtd_t1a",
      displayName: "Nguyễn Tuyển Một",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_1,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
    EMP_TEAM1_B = await seedPersonWithAccount({
      slug: "nvtd_t1b",
      displayName: "Trần Tuyển Hai",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_1,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
    EMP_TEAM2 = await seedPersonWithAccount({
      slug: "nvtd_t2",
      displayName: "Lê Tuyển Ba",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_2,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });

    TL_TEAM1 = await seedPersonWithAccount({
      slug: "tl_t1",
      displayName: "Team Leader 1",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_1,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
    const { rows: [dRow] } = await setup.query("select public.direct_entry_authorization_date()::text as today");
    await serviceRpc(
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_1, TL_TEAM1.app, dRow.today, 1, "Designate TL1", nextKey("tl1")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );

    PM_PROPOSER = await seedPersonWithAccount({
      slug: "pm_cr",
      displayName: "PM Proposer",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_1,
      groupId: grpByCode.SYSTEM_ADMIN,
      actorForCreate: OWNER,
    });
    await setup.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current, created_by_user_id)
       values ($1, $2::uuid, '2025-01-01', true, $3::uuid)`,
      [PRJ_1, PM_PROPOSER.rec, OWNER.app],
    );

    VENDOR_1 = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_CTV_ISO", "Vendor Cô Lập", "2025-01-01", "Seed Vendor 1", nextKey("v1")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
  });

  after(async () => {
    for (const c of clients) {
      await c?.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: "ignore",
      });
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("1. Danh mục & Phân quyền (Branch A): catalog_master_manage authz, input catalog active filter & Vendor/CTV independence", async () => {
    // Unauthorized personas rejected with 42501 across collaborator admin RPCs
    for (const denied of [EMP_TEAM1, TL_TEAM1, ACCOUNTING_OP]) {
      for (const [fn, args, casts] of [
        ["direct_entry_list_collaborators_admin", [denied.auth, denied.app, null, false, 1, 25], ["uuid", "uuid", "text", "boolean", "integer", "integer"]],
        ["direct_entry_create_collaborator", [denied.auth, denied.app, 0, "CTV_DENIED", "CTV Denied", "No access", nextKey("den_c")], ["uuid", "uuid", "integer", "text", "text", "text", "text"]],
        ["direct_entry_get_collaborator_admin", [denied.auth, denied.app, "CTV_DENIED"], ["uuid", "uuid", "text"]],
        ["direct_entry_update_collaborator", [denied.auth, denied.app, "CTV_DENIED", 1, "New Name", "No access", nextKey("den_u")], ["uuid", "uuid", "text", "integer", "text", "text", "text"]],
        ["direct_entry_set_collaborator_active", [denied.auth, denied.app, "CTV_DENIED", false, 1, "No access", nextKey("den_s")], ["uuid", "uuid", "text", "boolean", "integer", "text", "text"]],
      ]) {
        const res = await tryServiceRpc(fn, args, casts);
        assert.equal(res.ok, false, `${denied.slug} must fail on ${fn}`);
        assert.equal(res.code, "42501");
      }
    }

    // HR_CATALOG_OPERATOR (catalog_master_manage @ ALL) and Full Admin succeed
    const ctvMain = await serviceRpc(
      "direct_entry_create_collaborator",
      [HR_OP.auth, HR_OP.app, 0, "CTV_01", "CTV Minh Anh", "Create CTV_01", nextKey("c1")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    assert.equal(ctvMain.collaborator_id, "CTV_01");
    assert.equal(ctvMain.active, true);
    assert.equal(ctvMain.version, 1);

    const ctvAlt = await serviceRpc(
      "direct_entry_create_collaborator",
      [OWNER.auth, OWNER.app, 0, "CTV_02", "CTV Bảo Châu", "Create CTV_02", nextKey("c2")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    assert.equal(ctvAlt.collaborator_id, "CTV_02");
    const ctvHist = await serviceRpc(
      "direct_entry_create_collaborator",
      [OWNER.auth, OWNER.app, 0, "CTV_HIST_03", "CTV Lịch Sử", "Create CTV_HIST_03", nextKey("c3")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    assert.equal(ctvHist.collaborator_id, "CTV_HIST_03");

    // Update display name under OCC + verify list/get admin projections
    const updatedAlt = await serviceRpc(
      "direct_entry_update_collaborator",
      [HR_OP.auth, HR_OP.app, "CTV_02", 1, "CTV Bảo Châu Mới", "Rename CTV_02", nextKey("c2u")],
      ["uuid", "uuid", "text", "integer", "text", "text", "text"],
    );
    assert.equal(updatedAlt.display_name, "CTV Bảo Châu Mới");
    assert.equal(updatedAlt.version, 2);

    // Cross-catalog uniqueness: same canonical code (including case-variants) cannot exist in both collaborators and vendors
    const SHARED_CODE = "SHARED_DUAL_01";
    const { rows: [recCountBefore] } = await setup.query("select count(*)::int as n from public.recruiters");
    const sharedCtv = await serviceRpc(
      "direct_entry_create_collaborator",
      [OWNER.auth, OWNER.app, 0, SHARED_CODE, "CTV Trùng Mã", "Create shared code CTV", nextKey("sc_c")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    const { rows: [recCountAfterCtv] } = await setup.query("select count(*)::int as n from public.recruiters");
    assert.equal(recCountAfterCtv.n, recCountBefore.n, "Creating collaborator must NEVER create a recruiters shadow row");
    assert.equal(sharedCtv.collaborator_id, SHARED_CODE);

    const crossCatalogConflict = await tryServiceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, SHARED_CODE.toLowerCase(), "Vendor Trùng Mã CTV", "2025-01-01", "Attempt duplicate code Vendor", nextKey("sc_v_conflict")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    assert.equal(crossCatalogConflict.ok, false, "Creating Vendor with Collaborator code must fail closed");
    assert.equal(crossCatalogConflict.code, "PT409");
    assert.match(String(crossCatalogConflict.message), /PARTNER_CODE_CONFLICT/);

    const DISTINCT_VENDOR_CODE = "VND_DUP_CHECK_01";
    const distinctVendor = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, DISTINCT_VENDOR_CODE, "Vendor Riêng Mã", "2025-01-01", "Create distinct code Vendor", nextKey("sc_v")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    assert.equal(distinctVendor.vendor_id, DISTINCT_VENDOR_CODE);

    // Deactivating distinctVendor leaves sharedCtv active
    await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, DISTINCT_VENDOR_CODE, false, distinctVendor.version, "Deactivate distinct Vendor", nextKey("sc_vd")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    const sharedCtvRead = await serviceRpc(
      "direct_entry_get_collaborator_admin",
      [OWNER.auth, OWNER.app, SHARED_CODE],
      ["uuid", "uuid", "text"],
    );
    assert.equal(sharedCtvRead.active, true, "Deactivating vendor leaves collaborator active");

    // Deactivate sharedCtv -> omitted from direct_entry_input_catalog while CTV_01/CTV_02/CTV_HIST_03 remain active
    await serviceRpc(
      "direct_entry_set_collaborator_active",
      [HR_OP.auth, HR_OP.app, SHARED_CODE, false, sharedCtv.version, "Deactivate shared CTV", nextKey("sc_cd")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    const { rows: [recCountEnd] } = await setup.query("select count(*)::int as n from public.recruiters");
    assert.equal(recCountEnd.n, recCountAfterCtv.n + 1, "Only vendor creation added a recruiter row");

    const catalog = await serviceRpc(
      "direct_entry_input_catalog",
      [EMP_TEAM1.auth, EMP_TEAM1.app, "2026-11-28"],
      ["uuid", "uuid", "date"],
    );
    const catCtvIds = new Set(catalog.collaborators.map((c) => c.collaborator_id));
    assert.equal(catCtvIds.has("CTV_01"), true);
    assert.equal(catCtvIds.has("CTV_02"), true);
    assert.equal(catCtvIds.has("CTV_HIST_03"), true);
    assert.equal(catCtvIds.has(SHARED_CODE), false, "Deactivated CTV must be omitted from input catalog");
  });

  it("2. Lưu hồ sơ & Sửa/CR & Bảo toàn lịch sử (Branch B): write RPCs, M:N, source switch, deactivation & retroactive edit", async () => {
    // Reject non-existent and inactive CTV on batch create (23514)
    const missingCtvErr = await tryServiceRpc(
      "direct_entry_create_batch",
      [
        OWNER.auth,
        OWNER.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-10",
            employee_code: "hrp-2026-900001",
            worker_details: workerDetailsPayload("Bad Missing CTV"),
            recruiter_id: EMP_TEAM1.rec,
            labor_type: "TEMPORARY",
            collaborator_id: "CTV_NON_EXISTENT",
          },
        ]),
        nextKey("bad_miss"),
      ],
      ["uuid", "uuid", "jsonb", "text"],
    );
    assert.equal(missingCtvErr.ok, false);
    assert.equal(missingCtvErr.code, "23514");

    const inactiveCtvErr = await tryServiceRpc(
      "direct_entry_create_batch",
      [
        OWNER.auth,
        OWNER.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-10",
            employee_code: "hrp-2026-900002",
            worker_details: workerDetailsPayload("Bad Inactive CTV"),
            recruiter_id: EMP_TEAM1.rec,
            labor_type: "TEMPORARY",
            collaborator_id: "SHARED_DUAL_01",
          },
        ]),
        nextKey("bad_inact"),
      ],
      ["uuid", "uuid", "jsonb", "text"],
    );
    assert.equal(inactiveCtvErr.ok, false);
    assert.equal(inactiveCtvErr.code, "23514");

    // Reject Vendor recruiter + collaborator_id (23514)
    const vendorWithCtvErr = await tryServiceRpc(
      "direct_entry_create_full_profile_batch",
      [
        OWNER.auth,
        OWNER.app,
        "worker-profile/1.0",
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-10",
            employee_code: "hrp-2026-900003",
            recruiter_id: VENDOR_1.recruiter_id,
            labor_type: "TEMPORARY",
            collaborator_id: "CTV_01",
            display_name: "Bad Vendor With CTV",
            worker_details: {},
          },
        ]),
        nextUuid(),
      ],
      ["uuid", "uuid", "text", "jsonb", "text"],
    );
    assert.equal(vendorWithCtvErr.ok, false);
    assert.equal(vendorWithCtvErr.code, "23514");

    // Many-to-many via direct_entry_create_batch + direct_entry_create_draft_row + direct_entry_create_full_profile_batch:
    // NVTD 1 uses CTV_01 and CTV_02; NVTD 2 shares CTV_01
    const batch1 = await serviceRpc(
      "direct_entry_create_batch",
      [
        OWNER.auth,
        OWNER.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-10",
            employee_code: "hrp-2026-900010",
            worker_details: workerDetailsPayload("Worker M2N 1"),
            recruiter_id: EMP_TEAM1.rec,
            labor_type: "TEMPORARY",
            collaborator_id: "CTV_01",
          },
        ]),
        nextKey("m2n_b1"),
      ],
      ["uuid", "uuid", "jsonb", "text"],
    );
    const entryNvtd1Ctv1 = batch1.entry_ids[0];

    const { rows: [draftRow2] } = await setup.query(
      "select public.direct_entry_create_draft_row($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text) as data",
      [
        OWNER.auth,
        OWNER.app,
        batch1.submission_id,
        1,
        JSON.stringify({
          project_id: PRJ_1,
          first_work_date: "2026-11-10",
          employee_code: "hrp-2026-900011",
          worker_details: workerDetailsPayload("Worker M2N 2"),
          recruiter_id: EMP_TEAM1.rec,
          labor_type: "TEMPORARY",
          collaborator_id: "CTV_02",
        }),
        nextKey("m2n_dr2"),
      ],
    );
    const entryNvtd1Ctv2 = draftRow2.data.entry_id;

    // Check draft list projection includes collaborator_id & collaborator_display_name
    const ownDrafts = await serviceRpc(
      "direct_entry_list_own_drafts",
      [OWNER.auth, OWNER.app],
      ["uuid", "uuid"],
    );
    const draft1Proj = ownDrafts.drafts.find((d) => d.entry_id === entryNvtd1Ctv1);
    assert.equal(draft1Proj.collaborator_id, "CTV_01");
    assert.equal(draft1Proj.collaborator_display_name, "CTV Minh Anh");

    // Atomic storage check on DB
    const { rows: [stored1] } = await setup.query(
      "select provider_type, vendor_id, collaborator_id from public.direct_entries where entry_id = $1::uuid",
      [entryNvtd1Ctv1],
    );
    assert.deepEqual(stored1, { provider_type: "hrp", vendor_id: null, collaborator_id: "CTV_01" });

    // Source switches via direct_entry_update_own_draft_row (direct_entry_update_draft_row) on entryNvtd1Ctv2:
    // CTV -> HRP clears collaborator_id
    await serviceRpc(
      "direct_entry_update_own_draft_row",
      [OWNER.auth, OWNER.app, entryNvtd1Ctv2, 1, JSON.stringify({ collaborator_id: null }), nextKey("sw_c2h")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text"],
    );
    // HRP -> CTV requires active CTV (inactive fails, active succeeds)
    const hrpToInactiveErr = await tryServiceRpc(
      "direct_entry_update_own_draft_row",
      [OWNER.auth, OWNER.app, entryNvtd1Ctv2, 2, JSON.stringify({ collaborator_id: "SHARED_DUAL_01" }), nextKey("sw_bad")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text"],
    );
    assert.equal(hrpToInactiveErr.ok, false);
    assert.equal(hrpToInactiveErr.code, "23514");
    await serviceRpc(
      "direct_entry_update_own_draft_row",
      [OWNER.auth, OWNER.app, entryNvtd1Ctv2, 2, JSON.stringify({ collaborator_id: "CTV_02" }), nextKey("sw_h2c")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text"],
    );
    // CTV -> Vendor clears collaborator_id and sets vendor_id
    await serviceRpc(
      "direct_entry_update_own_draft_row",
      [OWNER.auth, OWNER.app, entryNvtd1Ctv2, 3, JSON.stringify({ recruiter_id: VENDOR_1.recruiter_id }), nextKey("sw_c2v")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text"],
    );
    const { rows: [afterVendorSwitch] } = await setup.query(
      "select provider_type, vendor_id, collaborator_id from public.direct_entries where entry_id = $1::uuid",
      [entryNvtd1Ctv2],
    );
    assert.deepEqual(afterVendorSwitch, {
      provider_type: "vendor",
      vendor_id: VENDOR_1.vendor_id,
      collaborator_id: null,
    });
    // Switch back to EMP_TEAM1 + CTV_02 before deleting/submitting so test 3 stays clean
    await serviceRpc(
      "direct_entry_update_own_draft_row",
      [OWNER.auth, OWNER.app, entryNvtd1Ctv2, 4, JSON.stringify({ recruiter_id: EMP_TEAM1.rec, collaborator_id: "CTV_02" }), nextKey("sw_v2c")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text"],
    );

    // Full profile batch for NVTD 2 sharing CTV_01 + historical entry on CTV_HIST_03
    const fpBatch = await serviceRpc(
      "direct_entry_create_full_profile_batch",
      [
        OWNER.auth,
        OWNER.app,
        "worker-profile/1.0",
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-11",
            employee_code: "hrp-2026-900012",
            recruiter_id: EMP_TEAM1_B.rec,
            labor_type: "TEMPORARY",
            collaborator_id: "CTV_01",
            display_name: "Worker NVTD2 Shared CTV1",
            worker_details: {},
          },
          {
            project_id: PRJ_1,
            first_work_date: "2026-11-11",
            employee_code: "hrp-2026-900013",
            recruiter_id: EMP_TEAM1.rec,
            labor_type: "TEMPORARY",
            collaborator_id: "CTV_HIST_03",
            display_name: "Worker Hist CTV3",
            worker_details: {},
          },
        ]),
        nextUuid(),
      ],
      ["uuid", "uuid", "text", "jsonb", "text"],
    );
    const entryHistId = fpBatch.entry_ids[1];
    await serviceRpc(
      "direct_entry_transition_submission",
      [OWNER.auth, OWNER.app, fpBatch.submission_id, 1, "SUBMITTED", nextUuid()],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );

    // Check revisions & audit events recorded collaborator_id snapshot
    const { rows: revs } = await setup.query(
      "select version, after_snapshot->>'collaborator_id' as col_id from public.direct_entry_revisions where entry_id = $1::uuid order by version",
      [entryNvtd1Ctv2],
    );
    assert.deepEqual(
      revs.map((r) => r.col_id),
      ["CTV_02", null, "CTV_02", null, "CTV_02"],
    );

    // Deactivate CTV_HIST_03
    await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "CTV_HIST_03", false, 1, "Deactivate historical CTV", nextKey("deact_hist")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );

    // New assignment of deactivated CTV_HIST_03 fails across create & privileged_edit
    const newAssignDeactErr = await tryServiceRpc(
      "direct_entry_privileged_edit",
      [OWNER.auth, OWNER.app, fpBatch.entry_ids[0], 1, JSON.stringify({ collaborator_id: "CTV_HIST_03" }), "Try deactivated CTV", nextKey("pe_deact_bad")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text", "text"],
    );
    assert.equal(newAssignDeactErr.ok, false);
    assert.equal(newAssignDeactErr.code, "23514");

    // Existing saved entry still shows collaborator_id & collaborator_display_name in read_projection, list_workers, export, and edit history snapshot
    const readProj = await serviceRpc(
      "direct_entry_read_projection",
      [OWNER.auth, OWNER.app, entryHistId],
      ["uuid", "uuid", "uuid"],
    );
    assert.equal(readProj.collaborator_id, "CTV_HIST_03");
    assert.equal(readProj.collaborator_display_name, "CTV Lịch Sử");

    const listWorkers = await serviceRpc(
      "direct_entry_list_workers",
      [OWNER.auth, OWNER.app, "all", null, null, null, null, 25, "900013", null, null, "hrp_ctv", null],
      ["uuid", "uuid", "text", "text", "uuid", "text", "text", "integer", "text", "date", "date", "text", "text"],
    );
    assert.equal(listWorkers.items.length, 1);
    assert.equal(listWorkers.items[0].collaborator_id, "CTV_HIST_03");
    assert.equal(listWorkers.items[0].collaborator_display_name, "CTV Lịch Sử");

    const exportWorkers = await serviceRpc(
      "direct_entry_export_workers",
      [OWNER.auth, OWNER.app, "all", null, null, null, "Export CTV check", "900013", null, null, "hrp_ctv", null],
      ["uuid", "uuid", "text", "text", "uuid", "text", "text", "text", "date", "date", "text", "text"],
    );
    assert.equal(exportWorkers.status, "ok");
    assert.equal(exportWorkers.rows.length, 1);
    assert.equal(exportWorkers.rows[0].collaborator_id, "CTV_HIST_03");
    assert.equal(exportWorkers.rows[0].collaborator_display_name, "CTV Lịch Sử");

    const { rows: [histSnap] } = await setup.query(
      "select public.worker_edit_history_snapshot($1::uuid) as snap",
      [entryHistId],
    );
    assert.equal(histSnap.snap.collaborator_id, "CTV_HIST_03");
    assert.equal(histSnap.snap.collaborator_name, "CTV Lịch Sử");

    // Non-source retroactive first_work_date edit via privileged_edit preserves deactivated CTV_HIST_03
    await serviceRpc(
      "direct_entry_privileged_edit",
      [OWNER.auth, OWNER.app, entryHistId, 1, JSON.stringify({ first_work_date: "2026-10-15" }), "Retroactive date on deactivated CTV", nextKey("pe_retro")],
      ["uuid", "uuid", "uuid", "integer", "jsonb", "text", "text"],
    );
    const { rows: [afterRetro] } = await setup.query(
      "select first_work_date::text as first_work_date, collaborator_id, version from public.direct_entries where entry_id = $1::uuid",
      [entryHistId],
    );
    assert.equal(afterRetro.first_work_date, "2026-10-15");
    assert.equal(afterRetro.collaborator_id, "CTV_HIST_03");

    // Legacy CR omitting collaborator_id approves cleanly and preserves deactivated CTV_HIST_03
    const legacyCr = await serviceRpc(
      "direct_entry_create_change_request",
      [
        PM_PROPOSER.auth,
        PM_PROPOSER.app,
        JSON.stringify([
          {
            entry_id: entryHistId,
            target_kind: "ENTRY_FIELD",
            expected_version: afterRetro.version,
            proposal: { first_work_date: "2026-10-16" },
          },
        ]),
        "Legacy CR without collaborator_id",
        nextKey("cr_leg"),
      ],
      ["uuid", "uuid", "jsonb", "text", "text"],
    );
    const crRead = await serviceRpc(
      "direct_entry_read_change_request",
      [OWNER.auth, OWNER.app, legacyCr.request_id],
      ["uuid", "uuid", "uuid"],
    );
    assert.equal(crRead.items[0].proposal.collaborator_id, undefined);
    await serviceRpc(
      "direct_entry_approve_change_request",
      [OWNER.auth, OWNER.app, legacyCr.request_id, 1, "Approve legacy CR", nextKey("cr_leg_ok")],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );
    const { rows: [afterCr] } = await setup.query(
      "select first_work_date::text as first_work_date, collaborator_id from public.direct_entries where entry_id = $1::uuid",
      [entryHistId],
    );
    assert.equal(afterCr.first_work_date, "2026-10-16");
    assert.equal(afterCr.collaborator_id, "CTV_HIST_03");

    // Soft-delete test 2 entries so test 3 starts with a crisp 10 = 6 + 4 reporting dataset
    await setup.query(
      "update public.direct_entries set deleted_at = now(), version = version + 1 where entry_id = any($1::uuid[])",
      [[entryNvtd1Ctv1, entryNvtd1Ctv2, fpBatch.entry_ids[0], entryHistId]],
    );
  });

  it("3. Báo cáo & Đối soát 10 = 6 + 4 (Branch C): Day/Week/Month matrix, channels, filters, scopes & Vendor isolation", async () => {
    // Seed NVTD_MAIN (EMP_TEAM1) with 10 turns = 6 HRP direct + 4 CTV across 2026-10 and 2026-11:
    // - 2026-10-05: 2 HRP direct (direct-only bucket: ctv = 0 -> renders "2", never "2 (0)")
    // - 2026-10-12: 2 HRP direct + 2 CTV (CTV_01 active)
    // - 2026-11-02: 2 HRP direct + 2 CTV (CTV_HIST_03 deactivated, preserved as historical CTV!)
    // Plus 2 turns for EMP_TEAM2 (1 direct + 1 CTV_01 on 2026-11-03) and 1 Vendor turn (VENDOR_1 on 2026-11-02).
    const ctvHistReenable = await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "CTV_HIST_03", true, 2, "Re-enable to seed historical CTV turns", nextKey("reenable_hist")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );

    let empSeq = 910001;
    async function seedSubmittedRow({ firstWorkDate, recruiterId, collaboratorId = null, projectId = PRJ_1 }) {
      const code = `hrp-${firstWorkDate.slice(0, 4)}-${empSeq++}`;
      const res = await serviceRpc(
        "direct_entry_create_batch",
        [
          OWNER.auth,
          OWNER.app,
          JSON.stringify([
            {
              project_id: projectId,
              first_work_date: firstWorkDate,
              employee_code: code,
              worker_details: workerDetailsPayload(`Worker ${code}`),
              recruiter_id: recruiterId,
              labor_type: "TEMPORARY",
              ...(collaboratorId ? { collaborator_id: collaboratorId } : {}),
            },
          ]),
          nextKey("rep_seed"),
        ],
        ["uuid", "uuid", "jsonb", "text"],
      );
      await serviceRpc(
        "direct_entry_transition_submission",
        [OWNER.auth, OWNER.app, res.submission_id, 1, "SUBMITTED", nextUuid()],
        ["uuid", "uuid", "uuid", "integer", "text", "text"],
      );
      return res.entry_ids[0];
    }

    // 6 HRP direct + 4 CTV = 10 turns for EMP_TEAM1
    await seedSubmittedRow({ firstWorkDate: "2026-10-05", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-10-05", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-10-12", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-10-12", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-10-12", recruiterId: EMP_TEAM1.rec, collaboratorId: "CTV_01" });
    await seedSubmittedRow({ firstWorkDate: "2026-10-12", recruiterId: EMP_TEAM1.rec, collaboratorId: "CTV_01" });
    await seedSubmittedRow({ firstWorkDate: "2026-11-02", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-11-02", recruiterId: EMP_TEAM1.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-11-02", recruiterId: EMP_TEAM1.rec, collaboratorId: "CTV_HIST_03" });
    await seedSubmittedRow({ firstWorkDate: "2026-11-02", recruiterId: EMP_TEAM1.rec, collaboratorId: "CTV_HIST_03" });

    // Deactivate CTV_HIST_03 again before reading reporting options & facts
    await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "CTV_HIST_03", false, ctvHistReenable.version, "Deactivate CTV_HIST_03 for reporting", nextKey("deact_rep")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );

    // Team 2 & Vendor turns for isolation / scope verification
    await seedSubmittedRow({ firstWorkDate: "2026-11-03", recruiterId: EMP_TEAM2.rec });
    await seedSubmittedRow({ firstWorkDate: "2026-11-03", recruiterId: EMP_TEAM2.rec, collaboratorId: "CTV_01" });
    await seedSubmittedRow({ firstWorkDate: "2026-11-02", recruiterId: VENDOR_1.recruiter_id });

    // Options check: deactivated CTV_HIST_03 remains visible in direct_entry_reporting_scoped_options
    const scopedOpts = await serviceRpc(
      "direct_entry_reporting_scoped_options",
      [OWNER.auth, OWNER.app],
      ["uuid", "uuid"],
    );
    const optCtvIds = new Set(scopedOpts.collaborators.map((c) => c.key));
    assert.equal(optCtvIds.has("CTV_01"), true);
    assert.equal(optCtvIds.has("CTV_HIST_03"), true, "Deactivated historical CTV must remain in reporting options");

    const ownerFacts = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [OWNER.auth, OWNER.app, JSON.stringify({ from: "2026-10-01", to: "2026-11-30" })],
      ["uuid", "uuid", "jsonb"],
    );
    const tlFacts = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [TL_TEAM1.auth, TL_TEAM1.app, JSON.stringify({ from: "2026-10-01", to: "2026-11-30" })],
      ["uuid", "uuid", "jsonb"],
    );
    const ownFacts = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [EMP_TEAM1.auth, EMP_TEAM1.app, JSON.stringify({ from: "2026-10-01", to: "2026-11-30" })],
      ["uuid", "uuid", "jsonb"],
    );

    assert.equal(ownerFacts.facts.length, 13, "all scope: 10 + 2 (team2) + 1 (vendor)");
    assert.equal(tlFacts.facts.length, 10, "team scope: strictly TEAM_1 (10 turns, excludes TEAM_2 & Vendor)");
    assert.equal(ownFacts.facts.length, 10, "own scope: strictly EMP_TEAM1 (10 turns = 6 + 4)");
    assert.equal(new Set(ownFacts.facts.map((f) => f.entry_id)).size, 10, "Each entry counted once");
    assert.equal(ownFacts.facts.filter((f) => f.recruitment_channel === "hrp_direct").length, 6);
    assert.equal(ownFacts.facts.filter((f) => f.recruitment_channel === "hrp_ctv").length, 4);

    // Build matrix for EMP_TEAM1 (10 = 6 + 4) across Day / Week / Month
    const emp1Key = EMP_TEAM1.name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    const matrixCatalog = {
      teams: [{ teamId: TEAM_1, teamCode: "ctv_team_1", displayName: "Đội CTV 1" }],
      recruiters: [
        {
          recruiterId: EMP_TEAM1.rec,
          recruiterKey: emp1Key,
          displayName: EMP_TEAM1.name,
          personnelCode: EMP_TEAM1.code,
          active: true,
          isActiveHrp: true,
          currentTeamIds: [TEAM_1],
          workStartDate: "2025-01-01",
        },
      ],
    };

    for (const resolution of ["day", "week", "month"]) {
      const hrpFilter = parseReportingFilters({ from: "2026-10-01", to: "2026-11-30", provider: "hrp" });
      assert.equal(hrpFilter.ok, true);
      const hrpMatrix = buildDetailedRecruitmentMatrix({
        facts: tlFacts.facts,
        catalog: matrixCatalog,
        filters: hrpFilter.filters,
        resolution,
      });
      assert.equal(hrpMatrix.rows.length, 1);
      const r = hrpMatrix.rows[0];
      assert.equal(r.total, 10, `${resolution}: total === 10`);
      assert.equal(r.ctvTotal, 4, `${resolution}: ctvTotal === 4`);
      assert.equal(hrpMatrix.grandTotal, 10);
      assert.equal(hrpMatrix.grandCtvTotal, 4);

      assert.equal(formatDetailedMatrixMetricCell(r.total, r.ctvTotal, { showCtv: false, provider: "hrp" }), "10");
      assert.equal(formatDetailedMatrixMetricCell(r.total, r.ctvTotal, { showCtv: true, provider: "hrp" }), "10 (4)");

      // Direct-only bucket (2026-10-05) must render "2", NEVER "2 (0)"
      const directOnlyIdx = hrpMatrix.buckets.findIndex(
        (b) => b.startDate <= "2026-10-05" && b.endDate >= "2026-10-05",
      );
      assert.ok(directOnlyIdx >= 0);
      if (resolution === "day" || resolution === "week") {
        assert.equal(r.counts[directOnlyIdx], 2);
        assert.equal(r.ctvCounts[directOnlyIdx], 0);
        assert.equal(
          formatDetailedMatrixMetricCell(r.counts[directOnlyIdx], r.ctvCounts[directOnlyIdx], { showCtv: true, provider: "hrp" }),
          "2",
          `${resolution}: direct-only bucket never renders (0)`,
        );
      } else {
        // Month 2026-10: 4 direct + 2 CTV = 6 (2); Month 2026-11: 2 direct + 2 CTV = 4 (2)
        assert.equal(formatDetailedMatrixMetricCell(r.counts[0], r.ctvCounts[0], { showCtv: true, provider: "hrp" }), "6 (2)");
        assert.equal(formatDetailedMatrixMetricCell(r.counts[1], r.ctvCounts[1], { showCtv: true, provider: "hrp" }), "4 (2)");
      }
    }

    // Channel split: hrp_direct = 6, hrp_ctv = 4 (no parens even with showCtv=true)
    const directOnlyMatrix = buildDetailedRecruitmentMatrix({
      facts: tlFacts.facts,
      catalog: matrixCatalog,
      filters: { from: "2026-10-01", to: "2026-11-30", provider: "hrp_direct" },
      resolution: "month",
    });
    assert.equal(directOnlyMatrix.grandTotal, 6);
    assert.equal(
      formatDetailedMatrixMetricCell(directOnlyMatrix.rows[0].total, directOnlyMatrix.rows[0].ctvTotal, { showCtv: true, provider: "hrp_direct" }),
      "6",
    );

    const ctvOnlyMatrix = buildDetailedRecruitmentMatrix({
      facts: tlFacts.facts,
      catalog: matrixCatalog,
      filters: { from: "2026-10-01", to: "2026-11-30", provider: "hrp_ctv" },
      resolution: "month",
    });
    assert.equal(ctvOnlyMatrix.grandTotal, 4);
    assert.equal(
      formatDetailedMatrixMetricCell(ctvOnlyMatrix.rows[0].total, ctvOnlyMatrix.rows[0].ctvTotal, { showCtv: true, provider: "hrp_ctv" }),
      "4",
    );

    // Vendor channel isolation: only the 1 Vendor turn
    const vendorFacts = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [OWNER.auth, OWNER.app, JSON.stringify({ from: "2026-10-01", to: "2026-11-30", provider: "vendor" })],
      ["uuid", "uuid", "jsonb"],
    );
    assert.equal(vendorFacts.facts.length, 1);
    assert.equal(vendorFacts.facts[0].recruitment_channel, "vendor");

    // Collaborator filter alone and combined with recruiter (including deactivated historical CTV_HIST_03)
    const byHistCtvAlone = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [OWNER.auth, OWNER.app, JSON.stringify({ from: "2026-10-01", to: "2026-11-30", collaborator: "CTV_HIST_03" })],
      ["uuid", "uuid", "jsonb"],
    );
    assert.equal(byHistCtvAlone.facts.length, 2);

    const byActiveCtvCombined = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [
        OWNER.auth,
        OWNER.app,
        JSON.stringify({
          from: "2026-10-01",
          to: "2026-11-30",
          recruiter: emp1Key,
          collaborator: "CTV_01",
        }),
      ],
      ["uuid", "uuid", "jsonb"],
    );
    assert.equal(byActiveCtvCombined.facts.length, 2, "recruiter + collaborator filter excludes TEAM_2's CTV_01 turn");

    // Vendor Referrer Monthly Report & Vendor Finance exclude all CTV/HRP turns completely
    const vrReport = await serviceRpc(
      "direct_entry_vendor_referrer_monthly_report",
      [OWNER.auth, OWNER.app, "ALL", null, null, null],
      ["uuid", "uuid", "text", "uuid", "text", "text"],
    );
    assert.equal(vrReport.reconciliation.total_vendor_turns, 1, "Vendor Referrer excludes all 12 HRP/CTV turns");

    const vfinVendors = await serviceRpc(
      "vendor_finance_list_vendors",
      [OWNER.auth, OWNER.app, null, "all", "all", null, null, "all", "all", 1, 50],
      ["uuid", "uuid", "text", "text", "text", "text", "uuid", "text", "text", "integer", "integer"],
    );
    const vfinVendorIds = new Set(vfinVendors.vendors.map((v) => v.vendor_id));
    assert.equal(vfinVendorIds.has("VND_CTV_ISO"), true);
    assert.equal(vfinVendorIds.has("CTV_01"), false);
    assert.equal(vfinVendorIds.has("CTV_02"), false);
    assert.equal(vfinVendorIds.has("CTV_HIST_03"), false);

    const vfinMonthly = await serviceRpc(
      "vendor_finance_get_monthly_report",
      [OWNER.auth, OWNER.app, "2026-11", null, null, null, "all"],
      ["uuid", "uuid", "text", "text", "uuid", "text", "text"],
    );
    assert.equal(Array.isArray(vfinMonthly.rows), true);
    assert.equal(
      [...vfinMonthly.rows, ...(vfinMonthly.legacy_unallocated_rows ?? [])].some((r) =>
        ["CTV_01", "CTV_02", "CTV_HIST_03"].includes(r.vendor_id),
      ),
      false,
      "Vendor Finance monthly report excludes all CTVs",
    );
  });
});
