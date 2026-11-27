/**
 * Vendor Referrer Attribution — Real Isolated PostgreSQL 18 Acceptance Suite.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Covers:
 *   1. Clean apply including Bản tin HRPartner (via `runMigrationApply` + idempotent re-run),
 *      `vendor_referrer_links` / `vendor_referrer_audit_events` FORCE RLS + 0 policies + 0 grants,
 *      7 service_role-only RPCs (`EXECUTE` only to `service_role`/owner), 4 internal helpers
 *      with 0 EXECUTE and the combined S0-T1-C RPC allowlist.
 *   2. Permission Group capability #30 (`vendor_referrer_manage`): rejected on team groups &
 *      non-BoD department groups (Recruitment/Accounting/Marketing/IT), allowed on `SYSTEM_ADMIN`
 *      and `MANAGEMENT_BOD` department groups, exposed in `direct_entry_resolve_actor_context`;
 *      strict BoD double-key gate rejecting all 7 unauthorized personas (`42501`) and allowing
 *      ONLY active `MANAGEMENT_BOD` + `vendor_referrer_manage @ ALL`.
 *   3. Referrer eligibility & cross-department rule (Recruitment/Marketing/IT HRP recruiters),
 *      rejecting inactive vendor (`22023`), inactive person, missing `recruiter_id`, `vendor`-provider
 *      recruiter, ended Org department membership, and multi-person recruiter collision.
 *   4. One NVTD -> many vendors, interval history, mid-period replace, same-day double replace (`[D, D)`
 *      empty interval + zero double-counting on `D`), revoke -> `unassigned_vendor_turns`,
 *      idempotency replay + conflict (`22023`), OCC mismatch (`PT409`), real 2-connection race (`0`
 *      `40P01`, `0` overlapping intervals), and direct SQL trigger overlap (`23P01`) + immutability (`55000`).
 *   5. Monthly report counting, exclusions (draft, deleted, voided, `hrp`), two unallocated buckets
 *      (`unassigned_vendor_turns` vs `unresolved_vendor_turns` when `first_work_date < rpm.valid_from`),
 *      exact conservation equation, filters (`month`/`referrer_person_id`/`vendor_id`/`project_id`),
 *      and Dashboard parity (`direct_entries` + `direct_entry_reporting_facts_v01` untouched).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

import { computeCreatePersonFingerprint } from "../src/lib/organization/person-contract.ts";
import {
  buildS0T1CAppliedFlags,
  HR_BULLETINS_MIGRATION_NAME,
  HR_BULLETINS_RPC_SIGNATURES,
  runMigrationApply,
  S0_T1_C_MIGRATION_NAME,
  VENDOR_REFERRER_ATTRIBUTION_MIGRATION_NAME,
  VENDOR_REFERRER_ATTRIBUTION_RPC_SIGNATURES,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const INTERNAL_HELPERS = [
  "public.org_department__internal_user_is_active_bod(uuid, timestamp with time zone)",
  "public.direct_entry_vendor_referrer__internal_assert_bod_actor(uuid, uuid, timestamp with time zone)",
  "public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(uuid, timestamp with time zone)",
  "public.direct_entry_vendor_referrer__internal_guard_link()",
];

let seq = 1;
function nextUuid() {
  return `97100000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function nextKey(prefix) {
  return `vr_db_${prefix}_${seq++}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}
function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
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

describe("Vendor Referrer Attribution — PG18 Acceptance Suite", () => {
  const clients = [];
  let tmpDir = "";
  let pgData = "";
  let pgLog = "";
  let pgCtl = null;
  let port = 0;
  let started = false;

  let setup = null;
  let c1 = null;
  let c2 = null;

  let today = "";
  let dMinus10 = "";
  let dMinus8 = "";
  let dMinus4 = "";
  let dMinus2 = "";
  let dMinus15 = "";
  let dPlus1 = "";

  let deptByKey = {};
  let grpByCode = {};

  let OWNER = null; // SYSTEM_ADMIN + MANAGEMENT_BOD
  let BOD_CUSTOM = null; // Custom MANAGEMENT_BOD group + vendor_referrer_manage
  let ADMIN_NON_BOD = null; // SYSTEM_ADMIN, NOT in MANAGEMENT_BOD
  let BOD_NO_CAP = null; // MANAGEMENT_BOD, WITHOUT vendor_referrer_manage
  let HR_OP = null; // HR_CATALOG_OPERATOR
  let ACCOUNTING_OP = null; // ACCOUNTING_OPERATIONS
  let TL_USER = null; // Team Leader
  let EMP_USER = null; // Regular RECRUITER_OPERATIONS
  let DISABLED_BOD = null; // SYSTEM_ADMIN + MANAGEMENT_BOD, enabled = false

  let TEAM_A = "";
  let PRJ_1 = "vr-prj-1";
  let PRJ_2 = "vr-prj-2";
  let SYS_VENDOR_TEAM_ID = "";

  let NVTD_REC = null;
  let NVTD_MKT = null;
  let NVTD_IT = null;
  let NVTD_4 = null;

  let VENDOR_A = null;
  let VENDOR_B = null;
  let VENDOR_C = null;
  let VENDOR_INACTIVE = null;

  async function serviceRpc(fnName, args = [], casts = [], client = setup) {
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

  async function tryServiceRpc(fnName, args = [], casts = [], client = setup) {
    try {
      const data = await serviceRpc(fnName, args, casts, client);
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

  async function seedAppUser(slug, displayName, { enabled = true } = {}) {
    const auth = nextUuid();
    const app = nextUuid();
    await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
      auth,
      `${slug}@hrpartner.local`,
    ]);
    await setup.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
       values ($1::uuid, $2::uuid, $3, $4, true, 1)`,
      [app, auth, displayName, enabled],
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
    providerType = "hrp",
    teamId = null,
    groupId = null,
    enabled = true,
    actorForCreate = null,
  }) {
    const acc = await seedAppUser(slug, displayName, { enabled });
    let rec = null;
    const code = `VR_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)}_${seq}`;
    if (withRecruiter) {
      rec = nextUuid();
      await setup.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [rec, displayName, code],
      );
      if (providerType === "hrp") {
        await setup.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
           values ($1::uuid, 'hrp', '2025-01-01', true)`,
          [rec],
        );
      } else if (providerType === "vendor") {
        await setup.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, valid_to, is_current)
           values ($1::uuid, 'hrp', '2025-01-01', '2025-06-01', false)`,
          [rec],
        );
        await setup.query(
          `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
           values ($1::uuid, 'vendor', $2, '2025-06-01', true)`,
          [rec, VENDOR_A.vendor_id],
        );
      }
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

  async function seedDirectEntry({
    creatorAppUserId,
    projectId,
    firstWorkDate,
    recruiterId,
    teamId,
    providerType,
    submissionState = "SUBMITTED",
    deletedAt = null,
    voidedAt = null,
    bypassValidationTrigger = false,
  }) {
    const candId = nextUuid();
    const subId = nextUuid();
    const entryId = nextUuid();
    const empCode = `hrp-${firstWorkDate.slice(0, 4)}-${String(seq++).padStart(6, "0")}`;

    await setup.query("begin");
    try {
      await setup.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [candId]);
      await setup.query(
        "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
        [subId, creatorAppUserId],
      );

      if (bypassValidationTrigger) {
        await setup.query("alter table public.direct_entries disable trigger direct_entry_validate_identity");
      }
      try {
        await setup.query(
          `insert into public.direct_entries (
             entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
             employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type,
             voided_at, voided_by_user_id
           ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7, $8::jsonb, $9::uuid, $10::uuid, $11, 'TEMPORARY', $12::timestamptz, $13::uuid)`,
          [
            entryId,
            subId,
            candId,
            creatorAppUserId,
            projectId,
            firstWorkDate,
            empCode,
            JSON.stringify({
              display_name: `Worker ${empCode}`,
              date_of_birth: { state: "unknown" },
              national_id: { state: "omitted" },
              address: { state: "unknown" },
              phone: { state: "unknown" },
            }),
            recruiterId,
            teamId,
            providerType,
            voidedAt,
            voidedAt ? creatorAppUserId : null,
          ],
        );
      } finally {
        if (bypassValidationTrigger) {
          await setup.query("alter table public.direct_entries enable trigger direct_entry_validate_identity");
        }
      }
      if (submissionState === "SUBMITTED") {
        await setup.query(
          "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = version + 1 where submission_id = $1::uuid",
          [subId],
        );
      }
      await setup.query("commit");
    } catch (err) {
      await setup.query("rollback").catch(() => {});
      throw err;
    }
    if (deletedAt) {
      await setup.query(
        "update public.direct_entries set deleted_at = $2::timestamptz, version = version + 1 where entry_id = $1::uuid",
        [entryId, deletedAt],
      );
    }
    return entryId;
  }

  before(async () => {
    const initdb = binary("initdb");
    pgCtl = binary("pg_ctl");
    assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb and pg_ctl binaries are required");

    tmpDir = await mkdtemp(path.join(os.tmpdir(), "vr-attribution-pg18-"));
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

    setup = await connect(port, "vr-setup");
    c1 = await connect(port, "vr-race-1");
    c2 = await connect(port, "vr-race-2");
    clients.push(setup, c1, c2);

    await setup.query(
      "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const applyRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl, projectRef: "pg18test", usesPooler: false }),
      createClient: (url) => new Client({ connectionString: url }),
      log: () => {},
    });
    const allMigs = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.equal(applyRes.totalCount, allMigs.length);
    assert.equal(applyRes.appliedCount, allMigs.length, "Full migration chain must apply cleanly from scratch");
    assert.equal(applyRes.skippedCount, 0);
    assert.ok(allMigs.includes(VENDOR_REFERRER_ATTRIBUTION_MIGRATION_NAME));
    assert.ok(allMigs.indexOf(HR_BULLETINS_MIGRATION_NAME) >= 0);
    assert.ok(allMigs.indexOf(HR_BULLETINS_MIGRATION_NAME) < allMigs.indexOf(VENDOR_REFERRER_ATTRIBUTION_MIGRATION_NAME));

    // Idempotent second run skips all applied migrations & verifies checksums/postconditions
    const rerunRes = await runMigrationApply({
      directory: MIGRATION_DIR,
      loadConfig: async () => ({ databaseUrl, projectRef: "pg18test", usesPooler: false }),
      createClient: (url) => new Client({ connectionString: url }),
      log: () => {},
    });
    assert.equal(rerunRes.appliedCount, 0);
    assert.equal(rerunRes.skippedCount, allMigs.length);

    // Compute Vietnam business dates
    const { rows: [dRow] } = await setup.query(
      "select public.direct_entry_authorization_date()::text as today",
    );
    today = dRow.today;
    dMinus15 = addDaysIso(today, -15);
    dMinus10 = addDaysIso(today, -10);
    dMinus8 = addDaysIso(today, -8);
    dMinus4 = addDaysIso(today, -4);
    dMinus2 = addDaysIso(today, -2);
    dPlus1 = addDaysIso(today, 1);

    const { rows: depts } = await setup.query(
      "select department_id::text, system_key from public.organization_departments where is_active = true",
    );
    deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));
    assert.ok(deptByKey.MANAGEMENT_BOD && deptByKey.RECRUITMENT && deptByKey.ACCOUNTING && deptByKey.MARKETING && deptByKey.IT);

    const { rows: grps } = await setup.query(
      "select group_id::text, code from public.authz_user_groups where active = true",
    );
    grpByCode = Object.fromEntries(grps.map((g) => [g.code, g.group_id]));
    assert.ok(grpByCode.SYSTEM_ADMIN && grpByCode.HR_CATALOG_OPERATOR && grpByCode.RECRUITER_OPERATIONS && grpByCode.ACCOUNTING_OPERATIONS && grpByCode.LEAVE_BOD_APPROVER);

    // Seed Owner (SYSTEM_ADMIN + MANAGEMENT_BOD)
    OWNER = await seedPersonWithAccount({
      slug: "owner",
      displayName: "Owner BoD",
      deptId: deptByKey.MANAGEMENT_BOD,
      withRecruiter: false,
    });
    await setup.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason, is_protected, protected_reason)
       values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Seed Owner', true, 'PROTECTED_OWNER_ADMIN')`,
      [grpByCode.SYSTEM_ADMIN, OWNER.app],
    );

    // Seed team, projects, and system vendor team id
    TEAM_A = nextUuid();
    await setup.query(
      "insert into public.teams (team_id, code, display_name, active, version) values ($1::uuid, 'vr_team_a', 'Đội VR A', true, 1)",
      [TEAM_A],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự án VR 1', true, 1), ($2, 'Dự án VR 2', true, 1)`,
      [PRJ_1, PRJ_2],
    );
    await setup.query(
      `insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
       values ($1, $3::uuid, '2025-01-01', true, 1, $4::uuid), ($2, $3::uuid, '2025-01-01', true, 1, $4::uuid)`,
      [PRJ_1, PRJ_2, TEAM_A, OWNER.app],
    );
    const { rows: [svt] } = await setup.query(
      "select public.direct_entry_system_vendor_team_id()::text as team_id",
    );
    SYS_VENDOR_TEAM_ID = svt.team_id;

    // Seed HR_OP & Vendors via direct_entry_create_vendor
    HR_OP = await seedPersonWithAccount({
      slug: "hrop",
      displayName: "HR Catalog Operator",
      deptId: deptByKey.RECRUITMENT,
      withRecruiter: false,
      groupId: grpByCode.HR_CATALOG_OPERATOR,
      actorForCreate: OWNER,
    });

    VENDOR_A = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_ALPHA", "Vendor Alpha", dMinus10, "Seed Vendor A", nextKey("va")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    VENDOR_B = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_BETA", "Vendor Beta", dMinus10, "Seed Vendor B", nextKey("vb")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    VENDOR_C = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_GAMMA", "Vendor Gamma", dMinus10, "Seed Vendor C", nextKey("vc")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    VENDOR_INACTIVE = await serviceRpc(
      "direct_entry_create_vendor",
      [OWNER.auth, OWNER.app, 0, "VND_DEAD", "Vendor Inactive", dMinus10, "Seed Vendor Dead", nextKey("vd")],
      ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
    );
    await serviceRpc(
      "direct_entry_set_vendor_active",
      [OWNER.auth, OWNER.app, VENDOR_INACTIVE.vendor_id, false, VENDOR_INACTIVE.version, "Deactivate vendor", nextKey("vd_off")],
      ["uuid", "uuid", "text", "boolean", "integer", "text", "text"],
    );

    // Seed remaining authorization personas
    ADMIN_NON_BOD = await seedPersonWithAccount({
      slug: "admin_non_bod",
      displayName: "Admin Non-BoD",
      deptId: deptByKey.RECRUITMENT,
      withRecruiter: false,
      groupId: grpByCode.SYSTEM_ADMIN,
      actorForCreate: OWNER,
    });
    BOD_NO_CAP = await seedPersonWithAccount({
      slug: "bod_no_cap",
      displayName: "BoD Without Capability",
      deptId: deptByKey.MANAGEMENT_BOD,
      withRecruiter: false,
      groupId: grpByCode.LEAVE_BOD_APPROVER,
      actorForCreate: OWNER,
    });
    ACCOUNTING_OP = await seedPersonWithAccount({
      slug: "acct",
      displayName: "Accounting User",
      deptId: deptByKey.ACCOUNTING,
      withRecruiter: false,
      groupId: grpByCode.ACCOUNTING_OPERATIONS,
      actorForCreate: OWNER,
    });
    EMP_USER = await seedPersonWithAccount({
      slug: "emp",
      displayName: "Regular Employee",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
    TL_USER = await seedPersonWithAccount({
      slug: "tl",
      displayName: "Team Leader User",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
      groupId: grpByCode.RECRUITER_OPERATIONS,
      actorForCreate: OWNER,
    });
    await serviceRpc(
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, TL_USER.app, today, 1, "Designate TL", nextKey("tl_des")],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    DISABLED_BOD = await seedPersonWithAccount({
      slug: "dis_bod",
      displayName: "Disabled BoD",
      deptId: deptByKey.MANAGEMENT_BOD,
      withRecruiter: false,
      groupId: grpByCode.SYSTEM_ADMIN,
      actorForCreate: OWNER,
    });
    await serviceRpc(
      "direct_entry_disable_app_user",
      [OWNER.auth, OWNER.app, DISABLED_BOD.app, await getAccountVersion(DISABLED_BOD.app), "Disable BoD user", nextKey("dis_bod")],
      ["uuid", "uuid", "uuid", "integer", "text", "text"],
    );

    // Seed cross-department eligible HRP recruiters
    NVTD_REC = await seedPersonWithAccount({
      slug: "nvtd_rec",
      displayName: "NVTD Tuyển Dụng",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
      actorForCreate: OWNER,
    });
    NVTD_MKT = await seedPersonWithAccount({
      slug: "nvtd_mkt",
      displayName: "NVTD Marketing",
      deptId: deptByKey.MARKETING,
      actorForCreate: OWNER,
    });
    NVTD_IT = await seedPersonWithAccount({
      slug: "nvtd_it",
      displayName: "NVTD IT",
      deptId: deptByKey.IT,
      actorForCreate: OWNER,
    });
    NVTD_4 = await seedPersonWithAccount({
      slug: "nvtd_4",
      displayName: "NVTD Thứ Tư",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
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

  it("1. Migration hygiene, FORCE RLS, 0 policies/grants, 7 service_role RPCs, and combined S0-T1-C allowlist", async () => {
    const sqlText = await readFile(path.join(MIGRATION_DIR, VENDOR_REFERRER_ATTRIBUTION_MIGRATION_NAME), "utf8");
    assert.equal(sqlText.includes("\r"), false, "Vendor referrer migration must use strict LF");
    assert.equal(sqlText.replace(/--[^\n]*/g, "").includes("@"), false, "Zero literal '@' in migration SQL");
    assert.equal(/\bsavepoint\b/i.test(sqlText), false, "Zero SAVEPOINT in migration SQL");
    assert.equal(/\balter\s+default\s+privileges\b/i.test(sqlText), false, "Zero ALTER DEFAULT PRIVILEGES");
    assert.equal(/\bbtree_gist\b/i.test(sqlText), false, "Zero btree_gist dependency");

    const { rows: tables } = await setup.query(
      `select c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              (select count(*)::int from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policy_count,
              pg_catalog.has_table_privilege('public', c.oid, 'SELECT') as pub_sel,
              pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
              pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
              pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') as svc_sel,
              pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT') as svc_ins,
              pg_catalog.has_table_privilege('service_role', c.oid, 'UPDATE') as svc_upd,
              pg_catalog.has_table_privilege('service_role', c.oid, 'DELETE') as svc_del
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('vendor_referrer_links', 'vendor_referrer_audit_events')
        order by c.relname`,
    );
    assert.equal(tables.length, 2);
    for (const t of tables) {
      assert.equal(t.relrowsecurity, true, `${t.relname} RLS enabled`);
      assert.equal(t.relforcerowsecurity, true, `${t.relname} FORCE RLS enabled`);
      assert.equal(t.policy_count, 0, `${t.relname} must have 0 RLS policies`);
      assert.equal(t.pub_sel, false, `${t.relname} public SELECT revoked`);
      assert.equal(t.anon_sel, false, `${t.relname} anon SELECT revoked`);
      assert.equal(t.auth_sel, false, `${t.relname} authenticated SELECT revoked`);
      assert.equal(t.svc_sel, false, `${t.relname} service_role SELECT revoked`);
      assert.equal(t.svc_ins, false, `${t.relname} service_role INSERT revoked`);
      assert.equal(t.svc_upd, false, `${t.relname} service_role UPDATE revoked`);
      assert.equal(t.svc_del, false, `${t.relname} service_role DELETE revoked`);
    }

    for (const sig of VENDOR_REFERRER_ATTRIBUTION_RPC_SIGNATURES) {
      const { rows: [fn] } = await setup.query(
        `select p.prosecdef,
                p.proconfig,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
           from pg_catalog.pg_proc p
          where p.oid = $1::pg_catalog.regprocedure`,
        [sig],
      );
      assert.ok(fn, `Missing RPC ${sig}`);
      assert.equal(fn.prosecdef, true, `${sig} SECURITY DEFINER`);
      assert.ok((fn.proconfig ?? []).includes("search_path=pg_catalog, public"), `${sig} locked search_path`);
      assert.equal(fn.svc_exec, true, `${sig} service_role EXECUTE`);
      assert.equal(fn.pub_exec, false, `${sig} public EXECUTE revoked`);
      assert.equal(fn.anon_exec, false, `${sig} anon EXECUTE revoked`);
      assert.equal(fn.auth_exec, false, `${sig} authenticated EXECUTE revoked`);
    }

    for (const sig of INTERNAL_HELPERS) {
      const { rows: [fn] } = await setup.query(
        `select p.prosecdef,
                p.proconfig,
                pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec,
                pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
           from pg_catalog.pg_proc p
          where p.oid = $1::pg_catalog.regprocedure`,
        [sig],
      );
      assert.ok(fn, `Missing internal helper ${sig}`);
      assert.equal(fn.prosecdef, true, `${sig} SECURITY DEFINER`);
      assert.ok((fn.proconfig ?? []).includes("search_path=pg_catalog, public"), `${sig} locked search_path`);
      assert.equal(fn.svc_exec, false, `${sig} service_role EXECUTE revoked`);
      assert.equal(fn.pub_exec, false, `${sig} public EXECUTE revoked`);
      assert.equal(fn.anon_exec, false, `${sig} anon EXECUTE revoked`);
      assert.equal(fn.auth_exec, false, `${sig} authenticated EXECUTE revoked`);
    }

    const s0Sql = await readFile(path.join(MIGRATION_DIR, S0_T1_C_MIGRATION_NAME), "utf8");
    const allMigs = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const postcond = await verifyS0T1CSecurityPostconditions(
      setup,
      s0Sql,
      buildS0T1CAppliedFlags(new Set(allMigs)),
    );
    assert.equal(postcond.ok, true, `S0-T1-C postcondition failed: ${postcond.reason}`);
    const expectedServiceCount = 317 + HR_BULLETINS_RPC_SIGNATURES.length;
    assert.equal(postcond.details.expectedServiceCount, expectedServiceCount);
    assert.equal(postcond.details.actualServiceCount, expectedServiceCount);
    assert.equal(postcond.details.exposedClientOrPublicCount, 0);
    assert.equal(postcond.details.unsafeSecdefSearchPathCount, 0);
  });

  it("2. Permission Groups ceiling & Strict BoD Authorization Double-Key across all 7 RPCs", async () => {
    // Reject vendor_referrer_manage on team group (via create_group_admin, update_group_admin, and trigger)
    const teamGroupCreateErr = await tryServiceRpc(
      "direct_entry_authz_create_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        "TEAM_VR_BAD",
        "Nhóm tổ sai quyền",
        "",
        deptByKey.RECRUITMENT,
        TEAM_A,
        ["vendor_referrer_manage"],
        null,
        "Test team group rejection",
        nextUuid(),
        sha256("team_vr_bad"),
      ],
      ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
    );
    assert.equal(teamGroupCreateErr.ok, false);
    assert.equal(teamGroupCreateErr.code, "22023");
    assert.match(teamGroupCreateErr.message, /GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP/);

    // Create a clean team group, then try update_group_admin adding vendor_referrer_manage
    const cleanTeamGroup = await serviceRpc(
      "direct_entry_authz_create_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        "TEAM_VR_CLEAN",
        "Nhóm tổ sạch",
        "",
        deptByKey.RECRUITMENT,
        TEAM_A,
        ["entry_team"],
        null,
        "Create clean team group",
        nextUuid(),
        sha256("team_vr_clean"),
      ],
      ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
    );
    const teamGroupUpdateErr = await tryServiceRpc(
      "direct_entry_authz_update_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        cleanTeamGroup.group_id,
        cleanTeamGroup.version,
        "Nhóm tổ sạch",
        "",
        deptByKey.RECRUITMENT,
        TEAM_A,
        true,
        ["entry_team", "vendor_referrer_manage"],
        null,
        "Test update team group rejection",
        nextUuid(),
        sha256("team_vr_upd_bad"),
      ],
      ["uuid", "uuid", "uuid", "integer", "text", "text", "uuid", "uuid", "boolean", "text[]", "jsonb", "text", "uuid", "text"],
    );
    assert.equal(teamGroupUpdateErr.ok, false);
    assert.equal(teamGroupUpdateErr.code, "22023");
    assert.match(teamGroupUpdateErr.message, /GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP/);

    // Direct SQL trigger check on team group
    await assert.rejects(
      setup.query(
        "insert into public.authz_user_group_capabilities (group_id, capability, reason) values ($1::uuid, 'vendor_referrer_manage', 'Direct trigger probe')",
        [cleanTeamGroup.group_id],
      ),
      (err) => err?.code === "22023" && /GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP/.test(err.message),
    );

    // Reject vendor_referrer_manage on non-BoD department groups (Recruitment, Accounting, Marketing, IT)
    for (const deptKey of ["RECRUITMENT", "ACCOUNTING", "MARKETING", "IT"]) {
      const deptErr = await tryServiceRpc(
        "direct_entry_authz_create_group_admin",
        [
          OWNER.auth,
          OWNER.app,
          `DEPT_${deptKey}_VR_BAD`,
          `Nhóm ${deptKey} sai quyền`,
          "",
          deptByKey[deptKey],
          null,
          ["vendor_referrer_manage"],
          null,
          `Reject ${deptKey}`,
          nextUuid(),
          sha256(`dept_bad_${deptKey}`),
        ],
        ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
      );
      assert.equal(deptErr.ok, false, `${deptKey} must reject vendor_referrer_manage`);
      assert.equal(deptErr.code, "22023");
      assert.match(deptErr.message, /GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP/);
    }

    // Also test direct SQL trigger check on non-BoD department group (HR_CATALOG_OPERATOR)
    await assert.rejects(
      setup.query(
        "insert into public.authz_user_group_capabilities (group_id, capability, reason) values ($1::uuid, 'vendor_referrer_manage', 'Direct dept trigger probe')",
        [grpByCode.HR_CATALOG_OPERATOR],
      ),
      (err) => err?.code === "22023" && /GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP/.test(err.message),
    );

    // SYSTEM_ADMIN has vendor_referrer_manage seeded, and MANAGEMENT_BOD department group allows it
    const bodGroup = await serviceRpc(
      "direct_entry_authz_create_group_admin",
      [
        OWNER.auth,
        OWNER.app,
        "BOD_VENDOR_REFERRER",
        "BoD Người giới thiệu Vendor",
        "Quản lý người giới thiệu Vendor",
        deptByKey.MANAGEMENT_BOD,
        null,
        ["vendor_referrer_manage"],
        null,
        "Create BoD vendor referrer group",
        nextUuid(),
        sha256("bod_vr_ok"),
      ],
      ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
    );
    assert.deepEqual(bodGroup.capabilities, ["vendor_referrer_manage"]);

    BOD_CUSTOM = await seedPersonWithAccount({
      slug: "bod_custom",
      displayName: "Custom BoD User",
      deptId: deptByKey.MANAGEMENT_BOD,
      withRecruiter: false,
      groupId: bodGroup.group_id,
      actorForCreate: OWNER,
    });

    // direct_entry_resolve_actor_context exposes vendor_referrer_manage cleanly
    const ownerCtx = await serviceRpc("direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
    assert.ok(ownerCtx.capabilities.includes("vendor_referrer_manage"));
    assert.ok(ownerCtx.capabilities.includes("bulletin_manage"));
    assert.ok(ownerCtx.effective_grants.some(
      (g) => g.capability === "bulletin_manage" && g.scope_kind === "ALL" && g.scope_id === null,
    ));
    assert.ok(
      ownerCtx.effective_grants.some(
        (g) => g.capability === "vendor_referrer_manage" && g.scope_kind === "ALL" && g.scope_id === null,
      ),
    );
    const bulletinArchive = await serviceRpc("hr_bulletin_list_archive", [OWNER.auth, OWNER.app], ["uuid", "uuid"]);
    assert.equal(bulletinArchive.can_manage, true);

    const bodCustomCtx = await serviceRpc("direct_entry_resolve_actor_context", [BOD_CUSTOM.auth], ["uuid"]);
    assert.deepEqual(bodCustomCtx.capabilities, ["vendor_referrer_manage"]);

    // Allowed BoD actors succeed on get_actor_access
    for (const allowed of [OWNER, BOD_CUSTOM]) {
      const access = await serviceRpc("direct_entry_vendor_referrer_get_actor_access", [allowed.auth, allowed.app], ["uuid", "uuid"]);
      assert.deepEqual(access, {
        can_manage: true,
        can_view_report: true,
        has_capability: true,
        is_active_bod: true,
      });
    }

    // All 7 unauthorized personas fail closed (get_actor_access.can_manage = false AND 6 operational RPCs raise 42501)
    const deniedPersonas = [
      { label: "Admin in SYSTEM_ADMIN but NOT active in MANAGEMENT_BOD", user: ADMIN_NON_BOD, expCap: true, expBod: false },
      { label: "MANAGEMENT_BOD member WITHOUT vendor_referrer_manage", user: BOD_NO_CAP, expCap: false, expBod: true },
      { label: "HR operator", user: HR_OP, expCap: false, expBod: false },
      { label: "Accounting / Vendor Finance", user: ACCOUNTING_OP, expCap: false, expBod: false },
      { label: "Team Leader", user: TL_USER, expCap: false, expBod: false },
      { label: "Regular Employee", user: EMP_USER, expCap: false, expBod: false },
      { label: "Disabled BoD user", user: DISABLED_BOD, expCap: null, expBod: null },
    ];

    for (const p of deniedPersonas) {
      if (p.user !== DISABLED_BOD) {
        const acc = await serviceRpc("direct_entry_vendor_referrer_get_actor_access", [p.user.auth, p.user.app], ["uuid", "uuid"]);
        assert.equal(acc.can_manage, false, `${p.label}: can_manage=false`);
        assert.equal(acc.can_view_report, false, `${p.label}: can_view_report=false`);
        assert.equal(acc.has_capability, p.expCap, `${p.label}: has_capability`);
        assert.equal(acc.is_active_bod, p.expBod, `${p.label}: is_active_bod`);
      } else {
        const accErr = await tryServiceRpc("direct_entry_vendor_referrer_get_actor_access", [p.user.auth, p.user.app], ["uuid", "uuid"]);
        assert.equal(accErr.ok, false);
        assert.equal(accErr.code, "42501");
      }

      const calls = [
        ["direct_entry_vendor_referrer_list_candidates", [p.user.auth, p.user.app, null, 50], ["uuid", "uuid", "text", "integer"]],
        ["direct_entry_vendor_referrer_list_vendors", [p.user.auth, p.user.app, null, false, 1, 25], ["uuid", "uuid", "text", "boolean", "integer", "integer"]],
        ["direct_entry_vendor_referrer_get_history", [p.user.auth, p.user.app, VENDOR_A.vendor_id], ["uuid", "uuid", "text"]],
        ["direct_entry_vendor_referrer_assign", [p.user.auth, p.user.app, VENDOR_A.vendor_id, NVTD_REC.personId, today, null, "Denied probe", nextKey("den_a")], ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"]],
        ["direct_entry_vendor_referrer_revoke", [p.user.auth, p.user.app, VENDOR_A.vendor_id, today, null, "Denied probe", nextKey("den_r")], ["uuid", "uuid", "text", "date", "uuid", "text", "text"]],
        ["direct_entry_vendor_referrer_monthly_report", [p.user.auth, p.user.app, "ALL", null, null, null], ["uuid", "uuid", "text", "uuid", "text", "text"]],
      ];
      for (const [fn, args, casts] of calls) {
        const res = await tryServiceRpc(fn, args, casts);
        assert.equal(res.ok, false, `${p.label}: ${fn} must reject`);
        assert.equal(res.code, "42501", `${p.label}: ${fn} expected 42501, got ${res.code} (${res.message})`);
      }
    }
  });

  it("3. Referrer eligibility, cross-department rule (Recruitment/Marketing/IT), and Vendor lifecycle", async () => {
    // Seed 5 ineligible persons
    const inactivePerson = await seedPersonWithAccount({
      slug: "inelig_inactive",
      displayName: "Ineligible Inactive Person",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
      actorForCreate: OWNER,
    });
    await setup.query(
      "update public.organization_persons set status = 'INACTIVE', deactivated_at = now() where person_id = $1::uuid",
      [inactivePerson.personId],
    );

    const noRecruiterPerson = await seedPersonWithAccount({
      slug: "inelig_norec",
      displayName: "Ineligible No Recruiter",
      deptId: deptByKey.MARKETING,
      withRecruiter: false,
      actorForCreate: OWNER,
    });

    const vendorRecruiterPerson = await seedPersonWithAccount({
      slug: "inelig_vendor_rec",
      displayName: "Ineligible Vendor Recruiter",
      deptId: deptByKey.RECRUITMENT,
      providerType: "vendor",
    });

    const endedDeptPerson = await seedPersonWithAccount({
      slug: "inelig_ended_dept",
      displayName: "Ineligible Ended Dept",
      deptId: deptByKey.IT,
      actorForCreate: OWNER,
    });
    await setup.query(
      "update public.organization_person_department_memberships set ended_at = now(), ended_reason = 'Ended dept membership', ended_by_app_user_id = $2::uuid, version = version + 1 where person_id = $1::uuid and ended_at is null",
      [endedDeptPerson.personId, OWNER.app],
    );

    const sharedRecParent = await seedPersonWithAccount({
      slug: "inelig_coll_a",
      displayName: "Ineligible Collision A",
      deptId: deptByKey.RECRUITMENT,
      teamId: TEAM_A,
      actorForCreate: OWNER,
    });
    const sharedRecSecondId = nextUuid();
    await setup.query(
      `insert into public.organization_persons (person_id, employee_code, full_name, joined_on, status, recruiter_id, version)
       values ($1::uuid, 'EMP-COLL-B', 'Ineligible Collision B', '2025-01-01', 'ACTIVE', null, 1)`,
      [sharedRecSecondId],
    );
    await setup.query(
      "update public.organization_account_person_links set ended_at = now(), ended_reason = 'Re-link probe', ended_by_app_user_id = $2::uuid, version = version + 1 where app_user_id = $1::uuid and ended_at is null",
      [sharedRecParent.app, OWNER.app],
    );
    await setup.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, reason)
       values ($1::uuid, $2::uuid, now(), 'Collision probe')`,
      [sharedRecParent.app, sharedRecSecondId],
    );
    const sharedRecCloneId = sharedRecSecondId;

    // list_candidates includes cross-department eligible HRP recruiters (RECRUITMENT, MARKETING, IT), excludes all ineligible
    const candList = await serviceRpc(
      "direct_entry_vendor_referrer_list_candidates",
      [BOD_CUSTOM.auth, BOD_CUSTOM.app, null, 200],
      ["uuid", "uuid", "text", "integer"],
    );
    const candIds = new Set(candList.items.map((c) => c.person_id));
    assert.ok(candIds.has(NVTD_REC.personId), "RECRUITMENT HRP recruiter eligible");
    assert.ok(candIds.has(NVTD_MKT.personId), "MARKETING HRP recruiter eligible");
    assert.ok(candIds.has(NVTD_IT.personId), "IT HRP recruiter eligible");
    assert.ok(candIds.has(NVTD_4.personId), "NVTD_4 eligible");

    for (const badId of [
      inactivePerson.personId,
      noRecruiterPerson.personId,
      vendorRecruiterPerson.personId,
      endedDeptPerson.personId,
      sharedRecParent.personId,
      sharedRecCloneId,
    ]) {
      assert.equal(candIds.has(badId), false, `Ineligible person ${badId} must not appear in candidates`);
      const err = await tryServiceRpc(
        "direct_entry_vendor_referrer_assign",
        [OWNER.auth, OWNER.app, VENDOR_C.vendor_id, badId, today, null, "Try ineligible", nextKey("inelig")],
        ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
      );
      assert.equal(err.ok, false);
      assert.equal(err.code, "22023");
      assert.match(err.message, /VENDOR_REFERRER_CANDIDATE_INELIGIBLE/);
    }

    // Reject assign on inactive vendor
    const inactiveVendorErr = await tryServiceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_INACTIVE.vendor_id, NVTD_REC.personId, today, null, "Inactive vendor", nextKey("inact_v")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(inactiveVendorErr.ok, false);
    assert.equal(inactiveVendorErr.code, "22023");
    assert.match(inactiveVendorErr.message, /VENDOR_REFERRER_VENDOR_INACTIVE/);

    // list_vendors respects include_inactive
    const activeOnly = await serviceRpc(
      "direct_entry_vendor_referrer_list_vendors",
      [OWNER.auth, OWNER.app, null, false, 1, 50],
      ["uuid", "uuid", "text", "boolean", "integer", "integer"],
    );
    assert.equal(activeOnly.items.some((v) => v.vendor_id === VENDOR_INACTIVE.vendor_id), false);
    const withInactive = await serviceRpc(
      "direct_entry_vendor_referrer_list_vendors",
      [OWNER.auth, OWNER.app, null, true, 1, 50],
      ["uuid", "uuid", "text", "boolean", "integer", "integer"],
    );
    assert.equal(withInactive.items.some((v) => v.vendor_id === VENDOR_INACTIVE.vendor_id), true);
  });

  it("4. 1 NVTD -> many vendors, mid-period replace, same-day double replace, revoke, idempotency, OCC, 2-conn race & SQL triggers", async () => {
    // 1 NVTD (NVTD_REC) assigned concurrently to VENDOR_A (D-10) and VENDOR_B (D-10)
    const assignA = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_REC.personId, dMinus10, null, "Assign A initial", nextKey("a1")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(assignA.action, "ASSIGN");
    assert.equal(assignA.replayed, false);

    // Idempotency replay on assign (exact same key + payload)
    const replayKey = nextKey("b_idem");
    const assignB = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_B.vendor_id, NVTD_REC.personId, dMinus10, null, "Assign B initial", replayKey],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    const assignBReplay = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_B.vendor_id, NVTD_REC.personId, dMinus10, null, "Assign B initial", replayKey],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(assignBReplay.replayed, true);
    assert.equal(assignBReplay.current_link.link_id, assignB.current_link.link_id);

    // Idempotency conflict (same key + different payload -> 22023)
    const idemConflict = await tryServiceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_B.vendor_id, NVTD_MKT.personId, dMinus10, assignB.current_link.link_id, "Different reason", replayKey],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(idemConflict.ok, false);
    assert.equal(idemConflict.code, "22023");

    // Same referrer rejected (22023)
    const sameRefErr = await tryServiceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_REC.personId, dMinus4, assignA.current_link.link_id, "Same referrer", nextKey("same")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(sameRefErr.ok, false);
    assert.equal(sameRefErr.code, "22023");
    assert.match(sameRefErr.message, /VENDOR_REFERRER_SAME_REFERRER/);

    // Future date rejected (22023)
    const futureErr = await tryServiceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_MKT.personId, dPlus1, assignA.current_link.link_id, "Future date", nextKey("fut")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(futureErr.ok, false);
    assert.equal(futureErr.code, "22023");

    // OCC expected_current_link_id mismatch -> PT409
    const occErr = await tryServiceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_MKT.personId, dMinus4, nextUuid(), "Stale OCC", nextKey("occ")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(occErr.ok, false);
    assert.equal(occErr.code, "PT409");

    // Mid-period replace on VENDOR_A: NVTD_REC (D-10) -> NVTD_MKT (D-4)
    const repA1 = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_MKT.personId, dMinus4, assignA.current_link.link_id, "Mid-period replace to MKT", nextKey("a_rep1")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(repA1.action, "REPLACE");
    assert.equal(repA1.replaced_link_id, assignA.current_link.link_id);

    // Same-day double replace on VENDOR_A (both default effective_date = today = D):
    // NVTD_MKT -> NVTD_IT (on today), THEN NVTD_IT -> NVTD_4 (on today)
    const repA2 = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [BOD_CUSTOM.auth, BOD_CUSTOM.app, VENDOR_A.vendor_id, NVTD_IT.personId, null, repA1.current_link.link_id, "Same-day replace 1", nextKey("a_rep2")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    const repA3 = await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id, NVTD_4.personId, null, repA2.current_link.link_id, "Same-day replace 2", nextKey("a_rep3")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    assert.equal(repA2.current_link.effective_from, today);
    assert.equal(repA3.current_link.effective_from, today);

    // Check history on VENDOR_A: 4 links (superseded same-day link has effective_from === today, effective_to === today -> [D, D) empty interval)
    const histA = await serviceRpc(
      "direct_entry_vendor_referrer_get_history",
      [OWNER.auth, OWNER.app, VENDOR_A.vendor_id],
      ["uuid", "uuid", "text"],
    );
    assert.equal(histA.links.length, 4);
    const sameDaySuperseded = histA.links.find((l) => l.link_id === repA2.current_link.link_id);
    assert.equal(sameDaySuperseded.is_current, false);
    assert.equal(sameDaySuperseded.effective_from, today);
    assert.equal(sameDaySuperseded.effective_to, today);
    assert.deepEqual(
      histA.audit_events.map((e) => e.action).reverse(),
      ["ASSIGN", "REPLACE", "REPLACE", "REPLACE"],
    );

    // Revoke VENDOR_B at D-4 (so D-8 counts for NVTD_REC, D-2 falls into unassigned_vendor_turns)
    const revB = await serviceRpc(
      "direct_entry_vendor_referrer_revoke",
      [OWNER.auth, OWNER.app, VENDOR_B.vendor_id, dMinus4, assignB.current_link.link_id, "Revoke B at D-4", nextKey("b_rev")],
      ["uuid", "uuid", "text", "date", "uuid", "text", "text"],
    );
    assert.equal(revB.action, "REVOKE");
    assert.equal(revB.current_link, null);
    assert.equal(revB.revoked_link_id, assignB.current_link.link_id);
    const histB = await serviceRpc(
      "direct_entry_vendor_referrer_get_history",
      [OWNER.auth, OWNER.app, VENDOR_B.vendor_id],
      ["uuid", "uuid", "text"],
    );
    assert.equal(histB.vendor.current_link, null);
    assert.equal(histB.links.length, 1);
    assert.equal(histB.links[0].effective_to, dMinus4);
    assert.equal(histB.audit_events[0].action, "REVOKE");

    // Direct SQL trigger checks: overlapping INSERT -> 23P01, historical UPDATE -> 55000, DELETE -> 55000
    await assert.rejects(
      setup.query(
        `insert into public.vendor_referrer_links (vendor_id, referrer_person_id, effective_from, effective_to, is_current, reason, created_by_app_user_id)
         values ($1, $2::uuid, $3::date, null, false, 'Overlap probe', $4::uuid)`,
        [VENDOR_A.vendor_id, NVTD_REC.personId, dMinus8, OWNER.app],
      ),
      (err) => err?.code === "23P01" && /VENDOR_REFERRER_LINK_OVERLAP/.test(err.message),
    );
    await assert.rejects(
      setup.query(
        "update public.vendor_referrer_links set ended_reason = 'Tamper' where link_id = $1::uuid",
        [assignA.current_link.link_id],
      ),
      (err) => err?.code === "55000",
    );
    await assert.rejects(
      setup.query("delete from public.vendor_referrer_links where link_id = $1::uuid", [assignA.current_link.link_id]),
      (err) => err?.code === "55000",
    );
    await assert.rejects(
      setup.query("delete from public.vendor_referrer_audit_events where vendor_id = $1", [VENDOR_A.vendor_id]),
      (err) => err?.code === "55000",
    );

    // Real 2-connection concurrency race on VENDOR_C (Promise.all across c1 & c2)
    for (let trial = 0; trial < 3; trial += 1) {
      const vRace = await serviceRpc(
        "direct_entry_create_vendor",
        [OWNER.auth, OWNER.app, 0, `VND_RACE_${trial}`, `Vendor Race ${trial}`, dMinus10, "Seed race vendor", nextKey(`vr_${trial}`)],
        ["uuid", "uuid", "integer", "text", "text", "date", "text", "text"],
      );
      const [r1, r2] = await Promise.all([
        tryServiceRpc(
          "direct_entry_vendor_referrer_assign",
          [OWNER.auth, OWNER.app, vRace.vendor_id, NVTD_REC.personId, today, null, "Race 1", nextKey(`race1_${trial}`)],
          ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
          c1,
        ),
        tryServiceRpc(
          "direct_entry_vendor_referrer_assign",
          [BOD_CUSTOM.auth, BOD_CUSTOM.app, vRace.vendor_id, NVTD_MKT.personId, today, null, "Race 2", nextKey(`race2_${trial}`)],
          ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
          c2,
        ),
      ]);
      assert.notEqual(r1.code, "40P01", "Zero deadlocks allowed");
      assert.notEqual(r2.code, "40P01", "Zero deadlocks allowed");
      assert.equal(Number(r1.ok) + Number(r2.ok), 1, `Trial ${trial}: exactly 1 concurrent assign wins`);
      const loser = r1.ok ? r2 : r1;
      assert.ok(loser.code === "PT409" || loser.code === "40001", `Unexpected loser code: ${loser.code} (${loser.message})`);

      const { rows: [cnt] } = await setup.query(
        "select count(*)::int as n from public.vendor_referrer_links where vendor_id = $1 and is_current = true",
        [vRace.vendor_id],
      );
      assert.equal(cnt.n, 1);
    }
  });

  it("5. Monthly report counting, exclusions, two unallocated buckets, conservation, filters & Dashboard parity", async () => {
    // Attributed submitted Vendor entries on VENDOR_A across intervals:
    // D-8 -> NVTD_REC (PRJ_1)
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: dMinus8,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });
    // D-2 -> NVTD_MKT (PRJ_2)
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_2,
      firstWorkDate: dMinus2,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });
    // today (D) -> exclusively 1 turn for NVTD_4 (same-day double replace, zero double-count!)
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });

    // VENDOR_B: D-8 -> attributed to NVTD_REC; D-2 (after revoke at D-4) -> unassigned_vendor_turns
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: dMinus8,
      recruiterId: VENDOR_B.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_2,
      firstWorkDate: dMinus2,
      recruiterId: VENDOR_B.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });

    // VENDOR_C (never assigned) -> unassigned_vendor_turns
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: VENDOR_C.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
    });

    // Unresolved Vendor turn: first_work_date (D-15) predates recruiter_provider_memberships.valid_from (D-10)
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: dMinus15,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
      bypassValidationTrigger: true,
    });

    // Excluded entries: DRAFT, soft-deleted, voided, and HRP-provider
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "DRAFT",
    });
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
      deletedAt: `${today}T01:00:00Z`,
    });
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: VENDOR_A.recruiter_id,
      teamId: SYS_VENDOR_TEAM_ID,
      providerType: "vendor",
      submissionState: "SUBMITTED",
      voidedAt: `${today}T02:00:00Z`,
    });
    await seedDirectEntry({
      creatorAppUserId: OWNER.app,
      projectId: PRJ_1,
      firstWorkDate: today,
      recruiterId: NVTD_REC.rec,
      teamId: TEAM_A,
      providerType: "hrp",
      submissionState: "SUBMITTED",
    });

    // Snapshot direct_entries + direct_entry_reporting_facts_v01 before an additional referrer mutation
    const { rows: [dashBefore] } = await setup.query(
      `select count(*)::int as total_vendor_turns,
              count(distinct e.recruiter_id)::int as vendor_recruiters
         from public.direct_entry_reporting_facts_v01 f
         join public.direct_entries e on e.entry_id = f.entry_id
        where e.voided_at is null
          and f.provider_type_key = 'vendor'`,
    );

    // Full ALL-period report verification
    const allReport = await serviceRpc(
      "direct_entry_vendor_referrer_monthly_report",
      [OWNER.auth, OWNER.app, "ALL", null, null, null],
      ["uuid", "uuid", "text", "uuid", "text", "text"],
    );
    assert.equal(allReport.reconciliation.total_vendor_turns, 7);
    assert.equal(allReport.reconciliation.attributed_turns, 4, "NVTD_REC(2) + NVTD_MKT(1) + NVTD_4(1) = 4");
    assert.equal(allReport.reconciliation.unassigned_vendor_turns, 2, "VENDOR_B post-revoke + VENDOR_C");
    assert.equal(allReport.reconciliation.unresolved_vendor_turns, 1, "D-15 entry before valid_from");
    assert.equal(
      allReport.reconciliation.attributed_turns +
        allReport.reconciliation.unassigned_vendor_turns +
        allReport.reconciliation.unresolved_vendor_turns,
      allReport.reconciliation.total_vendor_turns,
      "Exact conservation equation",
    );
    assert.equal(
      allReport.reconciliation.matched_vendor_turns,
      allReport.reconciliation.attributed_turns + allReport.reconciliation.unassigned_vendor_turns,
    );

    const byRefMap = Object.fromEntries(allReport.by_referrer.map((r) => [r.referrer_person_id, r.turns]));
    assert.equal(byRefMap[NVTD_REC.personId], 2);
    assert.equal(byRefMap[NVTD_MKT.personId], 1);
    assert.equal(byRefMap[NVTD_4.personId], 1);
    assert.equal(byRefMap[NVTD_IT.personId], undefined, "Superseded same-day NVTD_IT gets 0 turns");

    // Dashboard parity check: direct_entry_reporting_facts_v01 & direct_entry_reporting_scoped_facts
    assert.equal(allReport.reconciliation.total_vendor_turns, dashBefore.total_vendor_turns);
    const scopedDash = await serviceRpc(
      "direct_entry_reporting_scoped_facts",
      [OWNER.auth, OWNER.app, JSON.stringify({ provider: "vendor" })],
      ["uuid", "uuid", "jsonb"],
    );
    assert.equal(scopedDash.facts.length, allReport.reconciliation.total_vendor_turns);

    // Mutate VENDOR_C referrer -> verify direct_entries and Dashboard facts remain 100% untouched
    await serviceRpc(
      "direct_entry_vendor_referrer_assign",
      [OWNER.auth, OWNER.app, VENDOR_C.vendor_id, NVTD_IT.personId, today, null, "Assign C after report", nextKey("c_after")],
      ["uuid", "uuid", "text", "uuid", "date", "uuid", "text", "text"],
    );
    const { rows: [dashAfter] } = await setup.query(
      `select count(*)::int as total_vendor_turns,
              count(distinct e.recruiter_id)::int as vendor_recruiters
         from public.direct_entry_reporting_facts_v01 f
         join public.direct_entries e on e.entry_id = f.entry_id
        where e.voided_at is null
          and f.provider_type_key = 'vendor'`,
    );
    assert.deepEqual(dashAfter, dashBefore, "Referrer attribution never mutates Dashboard facts");

    // Filter checks: referrer_person_id, vendor_id, project_id, and specific month
    const filteredByRef = await serviceRpc(
      "direct_entry_vendor_referrer_monthly_report",
      [OWNER.auth, OWNER.app, "ALL", NVTD_REC.personId, null, null],
      ["uuid", "uuid", "text", "uuid", "text", "text"],
    );
    assert.equal(filteredByRef.filtered_summary.attributed_turns, 2);
    assert.equal(filteredByRef.reconciliation.total_vendor_turns, 7, "Period reconciliation remains un-filtered total");

    const filteredByVendorAndProject = await serviceRpc(
      "direct_entry_vendor_referrer_monthly_report",
      [OWNER.auth, OWNER.app, "ALL", null, VENDOR_A.vendor_id, PRJ_1],
      ["uuid", "uuid", "text", "uuid", "text", "text"],
    );
    assert.equal(filteredByVendorAndProject.filtered_summary.attributed_turns, 2, "VENDOR_A on PRJ_1: D-8 + today");

    const monthToday = today.slice(0, 7);
    const monthReport = await serviceRpc(
      "direct_entry_vendor_referrer_monthly_report",
      [OWNER.auth, OWNER.app, monthToday, null, null, null],
      ["uuid", "uuid", "text", "uuid", "text", "text"],
    );
    assert.equal(monthReport.month, monthToday);
    assert.equal(
      monthReport.reconciliation.attributed_turns +
        monthReport.reconciliation.unassigned_vendor_turns +
        monthReport.reconciliation.unresolved_vendor_turns,
      monthReport.reconciliation.total_vendor_turns,
      "Month conservation equation holds",
    );
  });
});
