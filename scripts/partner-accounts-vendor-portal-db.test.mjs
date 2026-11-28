/**
 * Partner Accounts & Vendor Portal — Isolated PostgreSQL 18 Acceptance & Concurrency Suite.
 *
 * Pure ESM (`node --conditions=react-server --test scripts/partner-accounts-vendor-portal-db.test.mjs`)
 * running against a dedicated native PostgreSQL 18 cluster (`initdb` + `pg_ctl`) with full
 * migration replay, covering:
 *   1. Cross-catalog code uniqueness (`vendors` <-> `collaborators`), case/whitespace folding,
 *      inactive retention, code immutability, and real 2-connection PostgreSQL concurrency.
 *   2. Address & phone validation, catalog RPC updates, `partner_portal_update_profile`, and
 *      `direct_entry_app_users.display_name` synchronization.
 *   3. Legacy conflict preflight (`partner_account_preflight_conflicts_admin`) +
 *      `audit-partner-account-conflicts.mjs` + `partner_account_provision_begin` conflict refusal.
 *   4. Full DB provisioning, resumable begin, activation attempt lockout & rotation, replay rejection,
 *      first-password-change gate, deactivate/reactivate sync, and internal BI isolation guards.
 *   5. Two-Vendor same-project scoping (`V1`, `V2` on `PRJ_SHARED`), summary/workers parity,
 *      exclusions (draft/voided/deleted/HRP/vendor_id IS NULL), strict 7-field worker projection
 *      (zero PII), and fail-closed access for CTV / BI employees.
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
import { auditPartnerAccountConflicts } from "./audit-partner-account-conflicts.mjs";
import { runMigrationApply } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

let seq = 1;
function nextUuid() {
  return `98300000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `partner_db_${prefix}_${seq++}`;
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

describe("Partner Accounts & Vendor Portal — PG18 Integration & Concurrency Suite", () => {
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
  let OWNER = null;
  let HR_OP = null;
  let BI_RECRUITER = null;
  let TEAM_1 = "";
  let PRJ_SHARED = "prj_partner_shared";
  let PRJ_V1_ONLY = "prj_partner_v1_only";

  async function serviceRpcOn(client, fnName, args = [], casts = []) {
    const placeholders = args
      .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
      .join(", ");
    const sql = `select public.${fnName}(${placeholders}) as data`;
    await client.query("begin; set local statement_timeout = '15s'; set local role service_role");
    try {
      const res = await client.query(sql, args);
      await client.query("commit");
      return res.rows[0]?.data;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    }
  }

  async function serviceRpc(fnName, args = [], casts = []) {
    return serviceRpcOn(setup, fnName, args, casts);
  }

  async function tryServiceRpcOn(client, fnName, args = [], casts = []) {
    try {
      const data = await serviceRpcOn(client, fnName, args, casts);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, code: err?.code ?? "ERR", message: err?.message ?? String(err) };
    }
  }

  async function tryServiceRpc(fnName, args = [], casts = []) {
    return tryServiceRpcOn(setup, fnName, args, casts);
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
    const code = `PA_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)}_${seq}`;
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

    if (actorForCreate && deptId) {
      const empCode = `EMP-${code}`;
      await serviceRpc("org_department_create_person_admin", [
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
    } else if (deptId) {
      const personId = nextUuid();
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
      const { rows: [uRow] } = await setup.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [acc.app],
      );
      const idemp = nextUuid();
      await serviceRpc(
        "direct_entry_authz_assign_group_member_admin",
        [actorForCreate.auth, actorForCreate.app, acc.app, groupId, uRow.version, `Assign ${slug}`, idemp, sha256(`grp:${acc.app}:${groupId}:${idemp}`)],
        ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
      );
    }

    return { ...acc, rec, code };
  }

  before(async () => {
    const initdb = binary("initdb");
    pgCtl = binary("pg_ctl");
    assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb and pg_ctl binaries are required");

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "partner-portal-pg18-"));
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

    setup = await connect(port, "partner-setup");
    clients.push(setup);

    await setup.query(
      "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const applyRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl, projectRef: "pg18partner", usesPooler: false }),
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
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'partner_team_1', 'Đội Partner 1', true, 1)`,
      [TEAM_1],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự án Chung', true, 1), ($2, 'Dự án Riêng V1', true, 1)`,
      [PRJ_SHARED, PRJ_V1_ONLY],
    );
    await setup.query(
      `insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
       values ($1, $3::uuid, '2025-01-01', true, 1, $4::uuid),
              ($2, $3::uuid, '2025-01-01', true, 1, $4::uuid)`,
      [PRJ_SHARED, PRJ_V1_ONLY, TEAM_1, OWNER.app],
    );

    HR_OP = await seedPersonWithAccount({
      slug: "hrop",
      displayName: "HR Catalog Op",
      deptId: deptByKey.RECRUITMENT,
      withRecruiter: false,
      groupId: grpByCode.HR_CATALOG_OPERATOR,
      actorForCreate: OWNER,
    });

    BI_RECRUITER = await seedPersonWithAccount({
      slug: "nvtd1",
      displayName: "NVTD Nội Bộ",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_1,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
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

  it("1. Cross-catalog code uniqueness, inactive retention, immutability, and real PG18 concurrency", async () => {
    // Vendor -> Collaborator blocked
    const v1 = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND01", "Vendor 01", "2025-01-01", "Create VND01", nextKey("v1")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    assert.equal(v1.vendor_id, "VND01");
    assert.equal(v1.partner_account.canonical_code, "vnd01");
    assert.equal(v1.partner_account.account_state, "UNPROVISIONED");

    for (const collidingCode of ["VND01", "vnd01", " vnd01 "]) {
      const err = await tryServiceRpc(
        "direct_entry_create_collaborator",
        [HR_OP.auth, HR_OP.app, 0, collidingCode, "CTV Colliding", "Try collide", nextKey("c_col")],
        ["uuid", "uuid", "integer", "text", "text", "text", "text"],
      );
      assert.equal(err.ok, false, `Collaborator ${JSON.stringify(collidingCode)} must conflict with VND01`);
      assert.equal(err.code, "PT409");
      assert.match(err.message, /PARTNER_CODE_CONFLICT/);
    }

    // Collaborator -> Vendor blocked (case-only + whitespace)
    const c1 = await serviceRpc(
      "direct_entry_create_collaborator",
      [HR_OP.auth, HR_OP.app, 0, "ctv_01", "CTV 01", "Create ctv_01", nextKey("c1")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    assert.equal(c1.collaborator_id, "ctv_01");

    for (const collidingCode of ["CTV_01", "ctv_01", " CTV_01 "]) {
      const err = await tryServiceRpc(
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, collidingCode, "Vendor Colliding", "2025-01-01", "Try collide", nextKey("v_col")],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      );
      assert.equal(err.ok, false, `Vendor ${JSON.stringify(collidingCode)} must conflict with ctv_01`);
      assert.equal(err.code, "PT409");
      assert.match(err.message, /PARTNER_CODE_CONFLICT/);
    }

    // Direct SQL INSERT with leading/trailing spaces is also blocked by trigger
    await assert.rejects(
      () =>
        setup.query(
          "insert into public.collaborators (collaborator_id, display_name, active, version) values (' vnd01 ', 'Raw Trim Collide', true, 1)",
        ),
      (err) => err?.code === "PT409" && /PARTNER_CODE_CONFLICT/.test(err.message),
    );

    // Inactive Vendor & inactive Collaborator retain their codes (still block reuse)
    const vTemp = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_RET", "Vendor Retain", "2025-01-01", "Create VND_RET", nextKey("v_ret")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, "VND_RET", false, vTemp.version, "Deactivate VND_RET", nextKey("v_ret_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    const reuseInactiveVendor = await tryServiceRpc(
      "direct_entry_create_collaborator",
      [OWNER.auth, OWNER.app, 0, "vnd_ret", "CTV Reuse Inactive", "Try reuse", nextKey("c_reuse")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    assert.equal(reuseInactiveVendor.ok, false);
    assert.equal(reuseInactiveVendor.code, "PT409");
    assert.match(reuseInactiveVendor.message, /PARTNER_CODE_CONFLICT/);

    const cTemp = await serviceRpc(
      "direct_entry_create_collaborator",
      [OWNER.auth, OWNER.app, 0, "CTV_RET", "CTV Retain", "Create CTV_RET", nextKey("c_ret")],
      ["uuid", "uuid", "integer", "text", "text", "text", "text"],
    );
    await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "CTV_RET", false, cTemp.version, "Deactivate CTV_RET", nextKey("c_ret_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    const reuseInactiveCtv = await tryServiceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "ctv_ret", "Vendor Reuse Inactive", "2025-01-01", "Try reuse", nextKey("v_reuse")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    assert.equal(reuseInactiveCtv.ok, false);
    assert.equal(reuseInactiveCtv.code, "PT409");
    assert.match(reuseInactiveCtv.message, /PARTNER_CODE_CONFLICT/);

    // Code immutability on UPDATE (PARTNER_CODE_IMMUTABLE)
    await assert.rejects(
      () => setup.query("update public.vendors set vendor_id = 'VND01_RENAMED' where vendor_id = 'VND01'"),
      (err) => err?.code === "22023" && /PARTNER_CODE_IMMUTABLE/.test(err.message),
    );
    await assert.rejects(
      () => setup.query("update public.collaborators set collaborator_id = 'CTV_01_RENAMED' where collaborator_id = 'ctv_01'"),
      (err) => err?.code === "22023" && /PARTNER_CODE_IMMUTABLE/.test(err.message),
    );

    // Real PostgreSQL concurrency: two parallel transactions attempting to create Vendor and Collaborator
    // with the same case-normalized code simultaneously
    const connA = await connect(port, "partner-race-a");
    const connB = await connect(port, "partner-race-b");
    clients.push(connA, connB);

    const raceCode = "RACE_CODE_01";
    const [resVendor, resCtv] = await Promise.all([
      tryServiceRpcOn(
        connA,
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, raceCode, "Race Vendor", "2025-01-01", "Race V", nextKey("race_v")],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      ),
      tryServiceRpcOn(
        connB,
        "direct_entry_create_collaborator",
        [HR_OP.auth, HR_OP.app, 0, raceCode.toLowerCase(), "Race CTV", "Race C", nextKey("race_c")],
        ["uuid", "uuid", "integer", "text", "text", "text", "text"],
      ),
    ]);

    const raceOutcomes = [resVendor, resCtv];
    assert.equal(raceOutcomes.filter((r) => r.ok).length, 1, "Exactly one concurrent create must succeed");
    const loser = raceOutcomes.find((r) => !r.ok);
    assert.equal(loser.code, "PT409");
    assert.match(loser.message, /PARTNER_CODE_CONFLICT/);

    // Also verify two parallel Vendor creates with case-different codes
    const [vRace1, vRace2] = await Promise.all([
      tryServiceRpcOn(
        connA,
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, "RACE_VV_02", "Race VV A", "2025-01-01", "Race VV A", nextKey("race_va")],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      ),
      tryServiceRpcOn(
        connB,
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, "race_vv_02", "Race VV B", "2025-01-01", "Race VV B", nextKey("race_vb")],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      ),
    ]);
    assert.equal([vRace1, vRace2].filter((r) => r.ok).length, 1, "Exactly one concurrent vendor create must succeed");
    const vLoser = [vRace1, vRace2].find((r) => !r.ok);
    assert.equal(vLoser.code, "PT409");
    assert.match(vLoser.message, /PARTNER_CODE_CONFLICT/);
  });

  it("2. Address & phone validation, catalog updates, and display_name sync", async () => {
    // Legacy/omitted address & phone default to null
    const vLegacy = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_ADDR_01", "Vendor Address 01", "2025-01-01", "No addr/phone", nextKey("va_cr")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    assert.equal(vLegacy.address, null);
    assert.equal(vLegacy.phone, null);

    // Invalid address (control char / > 500) & invalid phone (< 6 chars / non-phone chars) rejected
    const badAddr = await tryServiceRpc(
      "direct_entry_update_vendor",
      [OWNER.auth, OWNER.app, "VND_ADDR_01", vLegacy.version, "Vendor Address 01", "Bad addr", nextKey("va_bad_a"), "Line\nBreak", null],
      ["uuid", "uuid", "text", "integer", "text", "text", "text", "text", "text"],
    );
    assert.equal(badAddr.ok, false);
    assert.equal(badAddr.code, "22023");

    const badPhoneShort = await tryServiceRpc(
      "direct_entry_create_collaborator",
      [HR_OP.auth, HR_OP.app, 0, "CTV_BAD_PH", "CTV Bad Phone", "Bad phone", nextKey("ca_bad_p"), "123 St", "12345"],
      ["uuid", "uuid", "integer", "text", "text", "text", "text", "text", "text"],
    );
    assert.equal(badPhoneShort.ok, false);
    assert.equal(badPhoneShort.code, "22023");

    const badPhoneChars = await tryServiceRpc(
      "direct_entry_create_collaborator",
      [HR_OP.auth, HR_OP.app, 0, "CTV_BAD_PH2", "CTV Bad Phone 2", "Bad phone", nextKey("ca_bad_p2"), "123 St", "abc@12345"],
      ["uuid", "uuid", "integer", "text", "text", "text", "text", "text", "text"],
    );
    assert.equal(badPhoneChars.ok, false);
    assert.equal(badPhoneChars.code, "22023");

    // Valid create + update via catalog RPCs
    const vUpdated = await serviceRpc(
      "direct_entry_update_vendor",
      [OWNER.auth, OWNER.app, "VND_ADDR_01", vLegacy.version, "Vendor Address Updated", "Set contact", nextKey("va_up"), "  12 Nguyễn Trãi, Q.1  ", " +84 901-234-567 "],
      ["uuid", "uuid", "text", "integer", "text", "text", "text", "text", "text"],
    );
    assert.equal(vUpdated.display_name, "Vendor Address Updated");
    assert.equal(vUpdated.address, "12 Nguyễn Trãi, Q.1");
    assert.equal(vUpdated.phone, "+84 901-234-567");

    const cCreated = await serviceRpc(
      "direct_entry_create_collaborator",
      [HR_OP.auth, HR_OP.app, 0, "CTV_ADDR_01", "CTV Addr 01", "Create with contact", nextKey("ca_cr"), "  45 Lê Lợi  ", " 0987 654 321 "],
      ["uuid", "uuid", "integer", "text", "text", "text", "text", "text", "text"],
    );
    assert.equal(cCreated.address, "45 Lê Lợi");
    assert.equal(cCreated.phone, "0987 654 321");

    const cUpdated = await serviceRpc(
      "direct_entry_update_collaborator",
      [HR_OP.auth, HR_OP.app, "CTV_ADDR_01", cCreated.version, "CTV Addr Updated", "Update contact", nextKey("ca_up"), null, "(028) 3812-3456"],
      ["uuid", "uuid", "text", "integer", "text", "text", "text", "text", "text"],
    );
    assert.equal(cUpdated.display_name, "CTV Addr Updated");
    assert.equal(cUpdated.address, null);
    assert.equal(cUpdated.phone, "(028) 3812-3456");
  });

  it("3. Legacy conflict preflight, audit-partner-account-conflicts.mjs, and provision_begin refusal", async () => {
    // Create a clean UNPROVISIONED vendor for auth email collision testing
    await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_EMAIL_COL", "Vendor Email Collision", "2025-01-01", "Seed email collision vendor", nextKey("vec")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );

    // Seed synthetic legacy cross-catalog duplicate (temporarily disabling catalog guard triggers)
    const dupCode = "LEGACY_DUP_01";
    await setup.query("alter table public.vendors disable trigger vendors_partner_code_before_guard; alter table public.vendors disable trigger vendors_partner_code_after_insert;");
    await setup.query("alter table public.collaborators disable trigger collaborators_partner_code_before_guard; alter table public.collaborators disable trigger collaborators_partner_code_after_insert;");
    await setup.query(
      "insert into public.vendors (vendor_id, display_name, active, version) values ($1, 'Legacy Dup Vendor', true, 1)",
      [dupCode],
    );
    await setup.query(
      "insert into public.collaborators (collaborator_id, display_name, active, version) values ($1, 'Legacy Dup CTV', true, 1)",
      [dupCode.toLowerCase()],
    );
    await setup.query("alter table public.vendors enable trigger vendors_partner_code_before_guard; alter table public.vendors enable trigger vendors_partner_code_after_insert;");
    await setup.query("alter table public.collaborators enable trigger collaborators_partner_code_before_guard; alter table public.collaborators enable trigger collaborators_partner_code_after_insert;");

    // Seed BI auth.users email collision (vnd_email_col@hrpartner.vn)
    const collidingAuthId = nextUuid();
    await setup.query(
      "insert into auth.users (id, email) values ($1::uuid, 'vnd_email_col@hrpartner.vn')",
      [collidingAuthId],
    );

    // 3a. SQL preflight report detects both conflicts
    const sqlReport = await serviceRpc(
      "partner_account_preflight_conflicts_admin",
      [OWNER.auth, OWNER.app],
      ["uuid", "uuid"],
    );
    assert.equal(sqlReport.has_conflicts, true);
    assert.ok(sqlReport.cross_catalog_duplicates.some((d) => d.canonical_code === "legacy_dup_01"));
    assert.ok(sqlReport.auth_email_collisions.some((e) => e.canonical_code === "vnd_email_col" && e.email === "vnd_email_col@hrpartner.vn"));

    // 3b. CLI module auditPartnerAccountConflicts detects both conflicts
    const cliReport = await auditPartnerAccountConflicts(setup, { manageTransaction: true });
    assert.equal(cliReport.schema_ready, true);
    assert.equal(cliReport.has_conflicts, true);
    assert.ok(cliReport.cross_catalog_duplicates.some((d) => d.canonical_code === "legacy_dup_01"));
    assert.ok(cliReport.auth_email_collisions.some((e) => e.canonical_code === "vnd_email_col"));

    // 3c. provision_begin refuses cross-catalog duplicate (PARTNER_CODE_CONFLICT)
    const beginCrossErr = await tryServiceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", dupCode, "Try provision dup", nextKey("pb_dup")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    assert.equal(beginCrossErr.ok, false);
    assert.equal(beginCrossErr.code, "PT409");
    assert.match(beginCrossErr.message, /PARTNER_CODE_CONFLICT/);

    // 3d. provision_begin refuses auth.users email collision (PARTNER_AUTH_EMAIL_CONFLICT)
    const beginEmailErr = await tryServiceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND_EMAIL_COL", "Try provision email col", nextKey("pb_ecol")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    assert.equal(beginEmailErr.ok, false);
    assert.equal(beginEmailErr.code, "PT409");
    assert.match(beginEmailErr.message, /PARTNER_AUTH_EMAIL_CONFLICT/);

    // 3e. provision_begin refuses live BI CREATE_ACCOUNT intent collision (PARTNER_LOGIN_CONFLICT)
    await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_INTENT_COL", "Vendor Intent Collision", "2025-01-01", "Seed intent collision vendor", nextKey("vic")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    await setup.query(
      `insert into public.direct_entry_account_operation_intents
         (kind, state, login_id, display_name, idempotency_key)
       values ('CREATE_ACCOUNT', 'IN_FLIGHT', 'vnd_intent_col', 'BI Collision', $1)`,
      [nextKey("bi_intent")],
    );
    const beginIntentErr = await tryServiceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND_INTENT_COL", "Try provision intent col", nextKey("pb_icol")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    assert.equal(beginIntentErr.ok, false);
    assert.equal(beginIntentErr.code, "PT409");
    assert.match(beginIntentErr.message, /PARTNER_LOGIN_CONFLICT/);

    // Clean up synthetic conflicts so subsequent tests can run cleanly
    await setup.query("delete from auth.users where id = $1::uuid", [collidingAuthId]);
    await setup.query("delete from public.direct_entry_account_operation_intents where login_id = 'vnd_intent_col'");
    await setup.query("delete from public.vendors where vendor_id = $1", [dupCode]);
    await setup.query("delete from public.collaborators where collaborator_id = $1", [dupCode.toLowerCase()]);
  });

  it("4. Full provisioning, resumable begin, activation lockout/rotate, password-change gate, deactivate/reactivate & BI isolation", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Provision V1 (VND01) with resumable begin
    const v1Begin1 = await serviceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND01", "Provision VND01", nextKey("p_b1")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    assert.equal(v1Begin1.resumed, false);
    assert.equal(v1Begin1.canonical_code, "vnd01");
    assert.equal(v1Begin1.auth_email, "vnd01@hrpartner.vn");

    // Incomplete attempt -> second begin with different idempotency_key resumes same intent
    const v1BeginResumed = await serviceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND01", "Resume VND01", nextKey("p_b2")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    assert.equal(v1BeginResumed.resumed, true);
    assert.equal(v1BeginResumed.intent_id, v1Begin1.intent_id);
    assert.equal(v1BeginResumed.intent_token, v1Begin1.intent_token);

    const v1AuthSub = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, 'vnd01@hrpartner.vn')", [v1AuthSub]);
    const actCode1 = "ACTIVATE-CODE-ONE-123";
    const v1Fin = await serviceRpc(
      "partner_account_provision_finalize",
      [OWNER.auth, OWNER.app, "VENDOR", "VND01", v1Begin1.intent_id, v1Begin1.intent_token, v1AuthSub, sha256(actCode1), expiresAt, nextKey("p_f1")],
      ["uuid", "uuid", "text", "text", "uuid", "uuid", "uuid", "text", "timestamptz", "text"],
    );
    assert.equal(v1Fin.account_state, "PENDING_ACTIVATION");
    assert.equal(v1Fin.must_change_password, true);
    const v1AppUserId = v1Fin.app_user_id;

    // Actor resolution before activation: enabled=false & PENDING_ACTIVATION, BI arrays empty
    const actorBeforeAct = await serviceRpc("direct_entry_resolve_actor_context", [v1AuthSub], ["uuid"]);
    assert.equal(actorBeforeAct.enabled, false);
    assert.equal(actorBeforeAct.partner_account.account_state, "PENDING_ACTIVATION");
    assert.deepEqual(actorBeforeAct.capabilities, []);
    assert.deepEqual(actorBeforeAct.effective_grants, []);
    assert.deepEqual(actorBeforeAct.assigned_roles, []);

    // direct_entry_enable_app_user MUST refuse enabling unactivated partner account
    const { rows: [v1AppRow] } = await setup.query(
      "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
      [v1AppUserId],
    );
    const enableUnactErr = await tryServiceRpc(
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, v1AppUserId, v1AppRow.version, "Bypass activation", nextKey("en_unact")],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );
    assert.equal(enableUnactErr.ok, false);
    assert.equal(enableUnactErr.code, "PT409");
    assert.match(enableUnactErr.message, /PARTNER_ENABLE_REQUIRES_ACTIVATED_ACTIVE_PARTNER/);

    // Deactivating & reactivating an UNACTIVATED vendor keeps app_user enabled=false and PENDING_ACTIVATION
    await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_UNACT", "Unactivated Vendor", "2025-01-01", "Seed", nextKey("v_ua")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    const uaBeg = await serviceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND_UNACT", "Provision unact", nextKey("ua_b")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    const uaAuth = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, 'vnd_unact@hrpartner.vn')", [uaAuth]);
    const uaFin = await serviceRpc(
      "partner_account_provision_finalize",
      [OWNER.auth, OWNER.app, "VENDOR", "VND_UNACT", uaBeg.intent_id, uaBeg.intent_token, uaAuth, sha256("UNACT-CODE-123"), expiresAt, nextKey("ua_f")],
      ["uuid", "uuid", "text", "text", "uuid", "uuid", "uuid", "text", "timestamptz", "text"],
    );
    const deactUa = await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, "VND_UNACT", false, 1, "Deactivate unactivated", nextKey("ua_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(deactUa.partner_account.account_state, "PENDING_ACTIVATION");
    const reactUa = await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, "VND_UNACT", true, deactUa.version, "Reactivate unactivated", nextKey("ua_on")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(reactUa.partner_account.account_state, "PENDING_ACTIVATION");
    const { rows: [uaUserRow] } = await setup.query(
      "select enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [uaFin.app_user_id],
    );
    assert.equal(uaUserRow.enabled, false, "Reactivating unactivated vendor must NOT enable login");

    // Wrong activation token increments activation_attempts up to 5 and locks further attempts
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failAct = await serviceRpc(
        "partner_account_activate",
        ["VND01", sha256(`WRONG-CODE-${attempt}`)],
        ["text", "text"],
      );
      assert.deepEqual(failAct, { ok: false, error_code: "PARTNER_ACTIVATION_INVALID" });
    }
    const { rows: [after5Fails] } = await setup.query(
      "select activation_attempts from public.partner_accounts where app_user_id = $1::uuid",
      [v1AppUserId],
    );
    assert.equal(after5Fails.activation_attempts, 5);

    // Even the previously valid code is now locked out!
    const lockedOutRes = await serviceRpc(
      "partner_account_activate",
      ["vnd01", sha256(actCode1)],
      ["text", "text"],
    );
    assert.deepEqual(lockedOutRes, { ok: false, error_code: "PARTNER_ACTIVATION_INVALID" });

    // Rotate activation code resets attempts and works
    const actCode2 = "ACTIVATE-CODE-TWO-456";
    const rotated = await serviceRpc(
      "partner_account_rotate_activation_admin",
      [OWNER.auth, OWNER.app, "VENDOR", "VND01", sha256(actCode2), expiresAt, "Rotate locked activation", nextKey("rot_1")],
      ["uuid", "uuid", "text", "text", "text", "timestamptz", "text", "text"],
    );
    assert.equal(rotated.activation_attempts, 0);

    const actOk = await serviceRpc(
      "partner_account_activate",
      ["  VND01 ", sha256(actCode2)],
      ["text", "text"],
    );
    assert.equal(actOk.ok, true);
    assert.equal(actOk.account_state, "ACTIVE_MUST_CHANGE_PASSWORD");
    assert.equal(actOk.must_change_password, true);

    // Replay of the same activation code fails
    const replayErr = await serviceRpc(
      "partner_account_activate",
      ["vnd01", sha256(actCode2)],
      ["text", "text"],
    );
    assert.deepEqual(replayErr, { ok: false, error_code: "PARTNER_ACTIVATION_INVALID" });

    // Before first password change: profile read works with must_change_password=true; mutations & vendor reads reject with PARTNER_PASSWORD_CHANGE_REQUIRED
    const profilePreChange = await serviceRpc(
      "partner_portal_get_profile",
      [v1AuthSub, v1AppUserId],
      ["uuid", "uuid"],
    );
    assert.equal(profilePreChange.must_change_password, true);

    for (const [fn, args, casts] of [
      ["partner_portal_update_profile", [v1AuthSub, v1AppUserId, "Vendor 01 Edit", "Addr", "0901234567", 1, nextKey("pre_up")], ["uuid", "uuid", "text", "text", "text", "integer", "text"]],
      ["partner_vendor_recruitment_summary", [v1AuthSub, v1AppUserId, null, null, null, "month"], ["uuid", "uuid", "date", "date", "text", "text"]],
      ["partner_vendor_list_workers", [v1AuthSub, v1AppUserId, null, null, null, null, 1, 25], ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"]],
    ]) {
      const err = await tryServiceRpc(fn, args, casts);
      assert.equal(err.ok, false, `${fn} must reject before password change`);
      assert.equal(err.code, "42501");
      assert.match(err.message, /PARTNER_PASSWORD_CHANGE_REQUIRED/);
    }

    // Mark password changed -> unlocks portal
    const marked = await serviceRpc(
      "partner_account_mark_password_changed",
      [v1AuthSub, v1AppUserId],
      ["uuid", "uuid"],
    );
    assert.equal(marked.account_state, "ACTIVE");
    assert.equal(marked.must_change_password, false);
    assert.ok(marked.password_changed_at);

    // Self-edit profile syncs display_name to direct_entry_app_users and keeps code immutable
    const selfUpdated = await serviceRpc(
      "partner_portal_update_profile",
      [v1AuthSub, v1AppUserId, "Vendor 01 Tự Cập Nhật", "99 Hai Bà Trưng", "0909888777", 1, nextKey("self_up")],
      ["uuid", "uuid", "text", "text", "text", "integer", "text"],
    );
    assert.equal(selfUpdated.display_name, "Vendor 01 Tự Cập Nhật");
    assert.equal(selfUpdated.address, "99 Hai Bà Trưng");
    assert.equal(selfUpdated.phone, "0909888777");
    assert.equal(selfUpdated.code, "VND01");
    assert.equal(selfUpdated.version, 2);

    const { rows: [syncedUser1] } = await setup.query(
      "select display_name from public.direct_entry_app_users where app_user_id = $1::uuid",
      [v1AppUserId],
    );
    assert.equal(syncedUser1.display_name, "Vendor 01 Tự Cập Nhật");

    // Admin catalog update also syncs direct_entry_app_users.display_name
    await serviceRpc(
      "direct_entry_update_vendor",
      [OWNER.auth, OWNER.app, "VND01", selfUpdated.version, "Vendor 01 Admin Sync", "Sync name", nextKey("adm_sync"), "99 Hai Bà Trưng", "0909888777"],
      ["uuid", "uuid", "text", "integer", "text", "text", "text", "text", "text"],
    );
    const { rows: [syncedUser2] } = await setup.query(
      "select display_name from public.direct_entry_app_users where app_user_id = $1::uuid",
      [v1AppUserId],
    );
    assert.equal(syncedUser2.display_name, "Vendor 01 Admin Sync");

    // Internal BI isolation guards:
    // 1. authz_user_group_members trigger forbids adding partner app_user_id to internal group
    await assert.rejects(
      () =>
        setup.query(
          "insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason) values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Try leak')",
          [grpByCode.RECRUITER_OPERATIONS, v1AppUserId],
        ),
      (err) => err?.code === "PT409" && /PARTNER_INTERNAL_GROUP_FORBIDDEN/.test(err.message),
    );
    // 2. hr_bulletin__internal_assert_active_actor (via hr_bulletin_list_mobile_feed) rejects partner account
    const bulletinErr = await tryServiceRpc(
      "hr_bulletin_list_mobile_feed",
      [v1AuthSub, v1AppUserId, null, 10, null, null, null, 0],
      ["uuid", "uuid", "text", "integer", "boolean", "timestamptz", "uuid", "integer"],
    );
    assert.equal(bulletinErr.ok, false);
    assert.equal(bulletinErr.code, "42501");
    assert.match(bulletinErr.message, /BULLETIN_ACTOR_FORBIDDEN/);
    // 3. direct_entry_assert_actor_mapping rejects partner account
    const mappingErr = await tryServiceRpc(
      "direct_entry_list_own_drafts",
      [v1AuthSub, v1AppUserId],
      ["uuid", "uuid"],
    );
    assert.equal(mappingErr.ok, false);
    assert.equal(mappingErr.code, "42501");
    // 4. attendance__internal_is_non_employee_account flags partner account; work_report_assert_actor rejects with 42501
    const { rows: [nonEmpPartner] } = await setup.query(
      "select public.attendance__internal_is_non_employee_account($1::uuid, now()) as flagged",
      [v1AppUserId],
    );
    assert.equal(nonEmpPartner.flagged, true, "Partner account must be flagged non-employee");
    const { rows: [nonEmpOwner] } = await setup.query(
      "select public.attendance__internal_is_non_employee_account($1::uuid, now()) as flagged",
      [OWNER.app],
    );
    assert.equal(nonEmpOwner.flagged, false, "BI employee must not be flagged non-employee");
    await assert.rejects(
      () =>
        setup.query(
          "select public.work_report_assert_actor($1::uuid, $2::uuid, null)",
          [v1AuthSub, v1AppUserId],
        ),
      (err) => err?.code === "42501" && /WORK_REPORT_ACTOR_DENIED/.test(err.message),
    );

    // Deactivating Vendor atomically disables direct_entry_app_users.enabled=false & SUSPENDED
    const deactV1 = await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, "VND01", false, 3, "Suspend VND01", nextKey("v1_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(deactV1.partner_account.account_state, "SUSPENDED");
    assert.equal(deactV1.partner_account.app_user_id, v1AppUserId);

    const resolvedSuspended = await serviceRpc("direct_entry_resolve_actor_context", [v1AuthSub], ["uuid"]);
    assert.equal(resolvedSuspended.enabled, false);
    assert.equal(resolvedSuspended.partner_account.account_state, "SUSPENDED");

    // direct_entry_enable_app_user refuses enabling while parent Vendor is inactive
    const { rows: [v1SuspUser] } = await setup.query(
      "select version, enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
      [v1AppUserId],
    );
    assert.equal(v1SuspUser.enabled, false);
    const enableParentOffErr = await tryServiceRpc(
      "direct_entry_enable_app_user",
      [OWNER.auth, OWNER.app, v1AppUserId, v1SuspUser.version, "Try enable while parent off", nextKey("en_poff")],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );
    assert.equal(enableParentOffErr.ok, false);
    assert.equal(enableParentOffErr.code, "PT409");
    assert.match(enableParentOffErr.message, /PARTNER_ENABLE_REQUIRES_ACTIVATED_ACTIVE_PARTNER/);

    // Reactivating Vendor reuses EXACT app_user_id and restores enabled=true & ACTIVE
    const reactV1 = await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, "VND01", true, deactV1.version, "Reactivate VND01", nextKey("v1_on")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(reactV1.partner_account.account_state, "ACTIVE");
    assert.equal(reactV1.partner_account.app_user_id, v1AppUserId);
    const resolvedReactivated = await serviceRpc("direct_entry_resolve_actor_context", [v1AuthSub], ["uuid"]);
    assert.equal(resolvedReactivated.enabled, true);
    assert.equal(resolvedReactivated.partner_account.account_state, "ACTIVE");

    // Provision, activate, mark password changed, deactivate & reactivate Collaborator (ctv_01)
    const cBeg = await serviceRpc(
      "partner_account_provision_begin",
      [OWNER.auth, OWNER.app, "COLLABORATOR", "ctv_01", "Provision ctv_01", nextKey("c_b1")],
      ["uuid", "uuid", "text", "text", "text", "text"],
    );
    const cAuthSub = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, 'ctv_01@hrpartner.vn')", [cAuthSub]);
    const cCode = "CTV-ACTIVATE-789";
    const cFin = await serviceRpc(
      "partner_account_provision_finalize",
      [OWNER.auth, OWNER.app, "COLLABORATOR", "ctv_01", cBeg.intent_id, cBeg.intent_token, cAuthSub, sha256(cCode), expiresAt, nextKey("c_f1")],
      ["uuid", "uuid", "text", "text", "uuid", "uuid", "uuid", "text", "timestamptz", "text"],
    );
    await serviceRpc("partner_account_activate", ["ctv_01", sha256(cCode)], ["text", "text"]);
    await serviceRpc("partner_account_mark_password_changed", [cAuthSub, cFin.app_user_id], ["uuid", "uuid"]);
    const cDeact = await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "ctv_01", false, 1, "Suspend ctv_01", nextKey("c_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(cDeact.partner_account.account_state, "SUSPENDED");
    const cReact = await serviceRpc(
      "direct_entry_set_collaborator_active",
      [OWNER.auth, OWNER.app, "ctv_01", true, cDeact.version, "Reactivate ctv_01", nextKey("c_on")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );
    assert.equal(cReact.partner_account.account_state, "ACTIVE");
    assert.equal(cReact.partner_account.app_user_id, cFin.app_user_id);
  });

  it("5. Two-Vendor same-project scoping, exclusions, strict 7-field zero-PII worker rows & CTV/BI fail-closed", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    async function provisionActiveVendor(code, name) {
      const v = await serviceRpc(
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, code, name, "2025-01-01", `Create ${code}`, nextKey(`cr_${code}`)],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      );
      const beg = await serviceRpc(
        "partner_account_provision_begin",
        [OWNER.auth, OWNER.app, "VENDOR", code, `Provision ${code}`, nextKey(`pb_${code}`)],
        ["uuid", "uuid", "text", "text", "text", "text"],
      );
      const authSub = nextUuid();
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        authSub,
        `${code.toLowerCase()}@hrpartner.vn`,
      ]);
      const actCode = `ACT-${code}-SECRET`;
      const fin = await serviceRpc(
        "partner_account_provision_finalize",
        [OWNER.auth, OWNER.app, "VENDOR", code, beg.intent_id, beg.intent_token, authSub, sha256(actCode), expiresAt, nextKey(`pf_${code}`)],
        ["uuid", "uuid", "text", "text", "uuid", "uuid", "uuid", "text", "timestamptz", "text"],
      );
      await serviceRpc("partner_account_activate", [code, sha256(actCode)], ["text", "text"]);
      await serviceRpc("partner_account_mark_password_changed", [authSub, fin.app_user_id], ["uuid", "uuid"]);
      return {
        vendor_id: v.vendor_id,
        recruiter_id: v.recruiter_id,
        auth_subject: authSub,
        app_user_id: fin.app_user_id,
      };
    }

    const V1 = await provisionActiveVendor("V1_PORTAL", "Vendor Portal 1");
    const V2 = await provisionActiveVendor("V2_PORTAL", "Vendor Portal 2");

    // Resolve active CTV_01 (already provisioned in test 4)
    const { rows: [ctvRow] } = await setup.query(
      `select pa.app_user_id, u.auth_subject
         from public.partner_accounts pa
         join public.direct_entry_app_users u on u.app_user_id = pa.app_user_id
        where pa.canonical_code = 'ctv_01'`,
    );

    let empCounter = 810001;
    async function seedEntry({
      projectId,
      firstWorkDate,
      fullName,
      recruiterId,
      submit = true,
      status = null,
      softDelete = false,
      voided = false,
      clearVendorId = false,
      nationalId = null,
      phone = null,
    }) {
      const empCode = `hrp-${firstWorkDate.slice(0, 4)}-${empCounter++}`;
      const res = await serviceRpc(
        "direct_entry_create_batch",
        [
          OWNER.auth,
          OWNER.app,
          JSON.stringify([
            {
              project_id: projectId,
              first_work_date: firstWorkDate,
              employee_code: empCode,
              worker_details: {
                display_name: fullName,
                date_of_birth: { state: "unknown" },
                national_id: nationalId
                  ? { state: "provided", value: nationalId }
                  : { state: "omitted" },
                address: { state: "provided", value: "99 Secret Address" },
                phone: phone ? { state: "provided", value: phone } : { state: "unknown" },
              },
              recruiter_id: recruiterId,
              labor_type: "TEMPORARY",
            },
          ]),
          nextKey("seed_e"),
        ],
        ["uuid", "uuid", "jsonb", "text"],
      );
      const entryId = res.entry_ids[0];
      if (submit) {
        await serviceRpc(
          "direct_entry_transition_submission",
          [OWNER.auth, OWNER.app, res.submission_id, 1, "SUBMITTED", nextUuid()],
          ["uuid", "uuid", "uuid", "integer", "text", "text"],
        );
      }
      if (status === "OFF") {
        await setup.query(
          `insert into public.direct_entry_employment_status_events (
             entry_id, status, effective_date, leave_date, leave_reason_text,
             version, actor_user_id, reason_id
           ) values (
             $1::uuid, 'OFF', $2::date, $2::date, 'Nghỉ việc',
             2, $3::uuid, public.direct_entry_reason($3::uuid, 'Seed status OFF')
           )`,
          [entryId, firstWorkDate, OWNER.app],
        );
      }
      if (softDelete) {
        await setup.query("update public.direct_entries set deleted_at = now(), version = version + 1 where entry_id = $1::uuid", [entryId]);
      }
      if (voided) {
        await setup.query(
          `update public.direct_entries
              set voided_at = now(),
                  voided_by_user_id = $2::uuid,
                  void_reason_id = public.direct_entry_reason($2::uuid, 'Seed void'),
                  version = version + 1
            where entry_id = $1::uuid`,
          [entryId, OWNER.app],
        );
      }
      if (clearVendorId) {
        await setup.query("alter table public.direct_entries disable trigger direct_entry_validate_identity");
        try {
          await setup.query("update public.direct_entries set vendor_id = null, version = version + 1 where entry_id = $1::uuid", [entryId]);
        } finally {
          await setup.query("alter table public.direct_entries enable trigger direct_entry_validate_identity");
        }
      }
      return { entryId, empCode };
    }

    // V1 active submitted entries: 3 on PRJ_SHARED (2 in 2026-10: ON + OFF; 1 in 2026-11: UNCONFIRMED) + 1 on PRJ_V1_ONLY (2026-11: ON)
    const v1a = await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-10-05", fullName: "Nguyễn Văn Alpha", recruiterId: V1.recruiter_id, status: "ON", nationalId: "079099001122", phone: "0901112233" });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-10-12", fullName: "Trần Thị Beta", recruiterId: V1.recruiter_id, status: "OFF" });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-03", fullName: "Lê Văn Gamma", recruiterId: V1.recruiter_id });
    await seedEntry({ projectId: PRJ_V1_ONLY, firstWorkDate: "2026-11-07", fullName: "Phạm Minh Delta", recruiterId: V1.recruiter_id, status: "ON" });

    // V1 exclusions on PRJ_SHARED (DRAFT, voided, soft-deleted)
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-08", fullName: "V1 Draft Excluded", recruiterId: V1.recruiter_id, submit: false });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-09", fullName: "V1 Voided Excluded", recruiterId: V1.recruiter_id, voided: true });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-10", fullName: "V1 Deleted Excluded", recruiterId: V1.recruiter_id, softDelete: true });

    // V2 active submitted entries on PRJ_SHARED (2 entries: ON + UNCONFIRMED)
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-10-20", fullName: "V2 Worker Một", recruiterId: V2.recruiter_id, status: "ON" });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-11", fullName: "V2 Worker Hai", recruiterId: V2.recruiter_id });

    // HRP entry & vendor_id IS NULL entry on PRJ_SHARED (excluded from BOTH V1 and V2)
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-12", fullName: "HRP Excluded", recruiterId: BI_RECRUITER.rec, status: "ON" });
    await seedEntry({ projectId: PRJ_SHARED, firstWorkDate: "2026-11-13", fullName: "Null Vendor Excluded", recruiterId: V1.recruiter_id, clearVendorId: true });

    // Verify V1 summary (unfiltered)
    const v1Summary = await serviceRpc(
      "partner_vendor_recruitment_summary",
      [V1.auth_subject, V1.app_user_id, null, null, null, "month"],
      ["uuid", "uuid", "date", "date", "text", "text"],
    );
    assert.equal(v1Summary.vendor_id, V1.vendor_id);
    assert.equal(v1Summary.total_workers, 4);
    assert.equal(v1Summary.on_count, 3);
    assert.equal(v1Summary.off_count, 1);
    assert.equal(v1Summary.unconfirmed_count, 0);
    assert.equal(v1Summary.available_projects.length, 2);
    assert.deepEqual(
      v1Summary.by_period.map((p) => [p.period_key, p.total_workers]),
      [["2026-10", 2], ["2026-11", 2]],
    );

    // Verify V1 summary filtered by PRJ_SHARED & day grouping & date range
    const v1Filtered = await serviceRpc(
      "partner_vendor_recruitment_summary",
      [V1.auth_subject, V1.app_user_id, "2026-10-01", "2026-10-31", PRJ_SHARED, "day"],
      ["uuid", "uuid", "date", "date", "text", "text"],
    );
    assert.equal(v1Filtered.total_workers, 2);
    assert.equal(v1Filtered.on_count, 1);
    assert.equal(v1Filtered.off_count, 1);
    assert.equal(v1Filtered.unconfirmed_count, 0);
    assert.deepEqual(
      v1Filtered.by_period.map((p) => p.period_key),
      ["2026-10-05", "2026-10-12"],
    );

    // Verify V1 worker list pagination & parity with summary
    const v1Page1 = await serviceRpc(
      "partner_vendor_list_workers",
      [V1.auth_subject, V1.app_user_id, null, null, null, null, 1, 2],
      ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
    );
    const v1Page2 = await serviceRpc(
      "partner_vendor_list_workers",
      [V1.auth_subject, V1.app_user_id, null, null, null, null, 2, 2],
      ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
    );
    assert.equal(v1Page1.total, v1Summary.total_workers);
    assert.equal(v1Page1.items.length, 2);
    assert.equal(v1Page2.items.length, 2);
    assert.deepEqual(v1Page1.available_projects, v1Summary.available_projects);

    // Search by worker name and employee_code
    const searchByName = await serviceRpc(
      "partner_vendor_list_workers",
      [V1.auth_subject, V1.app_user_id, "Alpha", null, null, null, 1, 25],
      ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
    );
    assert.equal(searchByName.total, 1);
    assert.equal(searchByName.items[0].entry_id, v1a.entryId);

    const searchByCode = await serviceRpc(
      "partner_vendor_list_workers",
      [V1.auth_subject, V1.app_user_id, v1a.empCode, null, null, null, 1, 25],
      ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
    );
    assert.equal(searchByCode.total, 1);
    assert.equal(searchByCode.items[0].entry_id, v1a.entryId);

    // Strict 7-field zero-PII assertion on every worker item
    const ALLOWED_WORKER_KEYS = [
      "employee_code",
      "employment_status",
      "entry_id",
      "first_work_date",
      "full_name",
      "project_id",
      "project_name",
    ];
    for (const row of [...v1Page1.items, ...v1Page2.items]) {
      assert.deepEqual(Object.keys(row).sort(), ALLOWED_WORKER_KEYS);
      const serialized = JSON.stringify(row);
      assert.equal(serialized.includes("079099001122"), false, "CCCD must NEVER appear");
      assert.equal(serialized.includes("0901112233"), false, "Phone must NEVER appear");
      assert.equal(serialized.includes("99 Secret Address"), false, "Worker address must NEVER appear");
    }

    // Verify V2 scoping: sees ONLY V2's 2 entries on PRJ_SHARED (never V1, never PRJ_V1_ONLY, never vendor_id IS NULL)
    const v2Summary = await serviceRpc(
      "partner_vendor_recruitment_summary",
      [V2.auth_subject, V2.app_user_id, null, null, null, "month"],
      ["uuid", "uuid", "date", "date", "text", "text"],
    );
    assert.equal(v2Summary.vendor_id, V2.vendor_id);
    assert.equal(v2Summary.total_workers, 2);
    assert.equal(v2Summary.on_count, 2);
    assert.equal(v2Summary.unconfirmed_count, 0);
    assert.deepEqual(v2Summary.available_projects.map((p) => p.project_id), [PRJ_SHARED]);

    const v2Workers = await serviceRpc(
      "partner_vendor_list_workers",
      [V2.auth_subject, V2.app_user_id, null, null, null, null, 1, 25],
      ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
    );
    assert.equal(v2Workers.total, 2);
    assert.equal(v2Workers.items.every((w) => w.full_name.startsWith("V2 Worker")), true);

    // CTV & BI employee calling Vendor Portal RPCs fail closed (42501)
    for (const denied of [
      { label: "CTV", auth: ctvRow.auth_subject, app: ctvRow.app_user_id },
      { label: "BI employee", auth: OWNER.auth, app: OWNER.app },
    ]) {
      const sumErr = await tryServiceRpc(
        "partner_vendor_recruitment_summary",
        [denied.auth, denied.app, null, null, null, "month"],
        ["uuid", "uuid", "date", "date", "text", "text"],
      );
      assert.equal(sumErr.ok, false, `${denied.label} must be denied on recruitment summary`);
      assert.equal(sumErr.code, "42501");

      const listErr = await tryServiceRpc(
        "partner_vendor_list_workers",
        [denied.auth, denied.app, null, null, null, null, 1, 25],
        ["uuid", "uuid", "text", "text", "date", "date", "integer", "integer"],
      );
      assert.equal(listErr.ok, false, `${denied.label} must be denied on list workers`);
      assert.equal(listErr.code, "42501");
    }
  });
});
