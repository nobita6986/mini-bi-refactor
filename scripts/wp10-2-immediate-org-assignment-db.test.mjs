/**
 * WP10-2 — Immediate-Effective Organizational Assignment Sequential & Security Suite (PGlite).
 *
 * Verifies against the FULL migration chain (through 20261124120000_wp10_2_immediate_org_assignment_guards.sql):
 *   1. ACL + SECURITY DEFINER + search_path + non-escalation of all 12 service_role RPCs and 6 internal fns.
 *   2. Custom department (system_key IS NULL) created via org_department_create_department_admin + API-created G1
 *      blocks create_person_admin, assign_person_member_admin, and transfer_person_member_admin (T0 #2).
 *   3. Bidirectional Org <-> Team/Leader guards across G1, G2, G3 (link/create/assign/transfer/end/update/unlink/
 *      accounting/assign_team_membership/move_team_membership/designate_team_leader/unassign/revoke).
 *   4. Cross-midnight lost-response same-key retry on server-date flow (`null` valid_from/valid_to/effective_date) (T0 #3).
 *   5. Account-disable suspension Ca S1..S3: suspended links & TL assignments continue blocking Org exits/changes,
 *      while re-enable restores TL only when Org §2.3 still holds.
 *   6. Defensive fixtures Ca D1 (drifted pre-existing G1), Ca D2 (error precedence: PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT
 *      before PERSON_INACTIVE), and Ca D3 BOTH branches on same-day TL revoke (valid Org restores A + grants; drifted
 *      Org closes B with 0-length cancel marker & closes B's grants while A + grants remain closed) (T0 #4).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  computeAssignAccountingMemberFingerprint,
  computeAssignPersonMemberFingerprint,
  computeCreateDepartmentFingerprint,
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
const WP10_2_MIGRATION_NAME = "20261124120000_wp10_2_immediate_org_assignment_guards.sql";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);";

const OWNER = {
  auth: "10200000-0000-4000-8000-00000000a001",
  app: "10200000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-2",
};
const LUANPT = {
  auth: "10200000-0000-4000-8000-00000000a002",
  app: "10200000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT WP10-2",
};
const LIENVU = {
  auth: "10200000-0000-4000-8000-00000000a003",
  app: "10200000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu WP10-2",
};
const NGATTT = {
  auth: "10200000-0000-4000-8000-00000000a004",
  app: "10200000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT WP10-2",
};

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `10210000-0000-4000-8000-${hex}`;
}

async function serviceQuery(db, sql, params = []) {
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const res = await db.query(sql, params);
    await db.exec("commit");
    return res;
  } catch (error) {
    await db.exec("rollback").catch(() => {});
    throw error;
  }
}

async function setBusinessDate(db, isoDate) {
  await db.exec(`
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

async function seedLegacyAdmin(db, user) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed)
     values ($1::uuid, $2::uuid, $3, true, false)`,
    [user.app, user.auth, user.name],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedPlainAccount(db, loginPrefix, displayName) {
  const authId = nextUuid();
  const appId = nextUuid();
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    authId,
    `${loginPrefix}@hrpartner.local`,
  ]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, true, 1)`,
    [appId, authId, displayName],
  );
  return { auth: authId, app: appId, login: loginPrefix, name: displayName };
}

async function seedBootstrappedDb() {
  const db = new PGlite();
  await db.exec(ROLE_PREAMBLE);
  const files = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const groupsIdx = files.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
  assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
  assert.ok(files.includes(WP10_2_MIGRATION_NAME), "WP10-2 migration must exist");

  for (let i = 0; i < groupsIdx; i += 1) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }
  await seedLegacyAdmin(db, OWNER);
  await seedLegacyAdmin(db, LUANPT);
  await seedLegacyAdmin(db, LIENVU);
  await seedLegacyAdmin(db, NGATTT);

  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");

  // Also grant OWNER direct capabilities for team/recruiter/person legacy helpers where checked before groups
  for (let i = groupsIdx; i < files.length; i += 1) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, files[i]), "utf8"));
  }
  await setBusinessDate(db, "2026-11-24");
  return db;
}

const CREATE_DEPT_SQL =
  "select public.org_department_create_department_admin($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7) as data";
const CREATE_PERSON_SQL =
  "select public.org_department_create_person_admin($1::uuid, $2::uuid, $3, $4, $5::date, $6::uuid, $7::uuid, $8::int, $9::uuid, $10, $11::uuid, $12) as data";
const UPDATE_PERSON_SQL =
  "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6, $7::date, $8, $9, $10::uuid, $11) as data";
const ASSIGN_MEMBER_SQL =
  "select public.org_department_assign_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const TRANSFER_MEMBER_SQL =
  "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, $7, $8::uuid, $9) as data";
const END_MEMBER_SQL =
  "select public.org_department_end_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::uuid, $8) as data";
const LINK_ACCOUNT_PERSON_SQL =
  "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::int, $7::uuid, $8, $9::uuid, $10) as data";
const UNLINK_ACCOUNT_PERSON_SQL =
  "select public.org_department_unlink_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::uuid, $7, $8::uuid, $9) as data";
const ASSIGN_ACCOUNTING_SQL =
  "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, $5::date, $6, $7::uuid, $8) as data";
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

test("WP10-2 DB: ACL postconditions, bidirectional guards, custom dept (system_key IS NULL), cross-midnight replay, Ca S1-S3, and Ca D1-D3", async () => {
  const db = await seedBootstrappedDb();
  try {
    // -------------------------------------------------------------------------
    // 1. Verify RPC ACLs & internal helpers
    // -------------------------------------------------------------------------
    const serviceRpcs = [
      "public.org_department_link_account_person_admin(uuid,uuid,uuid,uuid,integer,integer,uuid,text,uuid,text)",
      "public.org_department_create_person_admin(uuid,uuid,text,text,date,uuid,uuid,integer,uuid,text,uuid,text)",
      "public.direct_entry_account_operation_link_recruiter(uuid,uuid,uuid,integer,uuid,integer,text,text)",
      "public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)",
      "public.org_department_unlink_account_person_admin(uuid,uuid,uuid,integer,integer,uuid,text,uuid,text)",
      "public.org_department_assign_person_member_admin(uuid,uuid,uuid,uuid,integer,text,uuid,text)",
      "public.org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)",
      "public.org_department_transfer_person_member_admin(uuid,uuid,uuid,uuid,integer,uuid,text,uuid,text)",
      "public.org_department_end_person_member_admin(uuid,uuid,uuid,uuid,integer,text,uuid,text)",
      "public.org_department_update_person_admin(uuid,uuid,uuid,integer,text,text,date,text,text,uuid,text)",
      "public.direct_entry_assign_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)",
      "public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)",
    ];
    const internalFns = [
      "public.org_department__internal_person_is_active_in_recruitment(uuid,timestamptz)",
      "public.org_department__internal_subject_has_blocking_team_assignment(uuid[],uuid[],date)",
      "public.org_department__internal_person_has_blocking_team_assignment(uuid,date)",
      "public.org_department__internal_recruiter_org_allows_recruitment_team(uuid,uuid,timestamptz)",
      "public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)",
      "public.direct_entry_mutate_app_user_status(uuid,uuid,uuid,integer,text,text,boolean)",
    ];

    const { rows: aclRows } = await db.query(
      `select p.oid::regprocedure::text as sig,
              p.prosecdef,
              coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') as cfg,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_catalog.pg_proc p
        where p.oid = any(
          array(
            select pg_catalog.to_regprocedure(s)
              from unnest($1::text[]) as s
          )
        )`,
      [[...serviceRpcs, ...internalFns]],
    );
    assert.equal(aclRows.length, serviceRpcs.length + internalFns.length);
    for (const row of aclRows) {
      assert.equal(row.prosecdef, true, `${row.sig} must be SECURITY DEFINER`);
      assert.equal(row.cfg, "search_path=pg_catalog, public", `${row.sig} search_path`);
      assert.equal(row.pub_exec, false, `${row.sig} PUBLIC revoked`);
      assert.equal(row.anon_exec, false, `${row.sig} anon revoked`);
      assert.equal(row.auth_exec, false, `${row.sig} authenticated revoked`);
      const expectSvc = !row.sig.includes("__internal_")
        && !row.sig.startsWith("direct_entry_apply_team_leader_mutation")
        && !row.sig.startsWith("direct_entry_mutate_app_user_status");
      assert.equal(row.svc_exec, expectSvc, `${row.sig} service_role grant mismatch`);
    }

    // service_role cannot directly execute internal helpers
    await assert.rejects(
      () => serviceQuery(
        db,
        "select public.org_department__internal_person_has_blocking_team_assignment($1::uuid, '2026-11-24'::date)",
        [nextUuid()],
      ),
      (err) => err?.code === "42501",
    );

    // -------------------------------------------------------------------------
    // Seed system departments + custom department + two recruitment teams
    // -------------------------------------------------------------------------
    const { rows: deptRows } = await db.query(
      "select department_id::text as id, system_key from public.organization_departments where system_key in ('RECRUITMENT', 'MARKETING', 'ACCOUNTING')",
    );
    const deptByKey = Object.fromEntries(deptRows.map((r) => [r.system_key, r.id]));
    assert.ok(deptByKey.RECRUITMENT && deptByKey.MARKETING && deptByKey.ACCOUNTING);

    const { rows: [customDeptRes] } = await serviceQuery(db, CREATE_DEPT_SQL, [
      OWNER.auth,
      OWNER.app,
      "CUSTOM_OPS",
      "Vận hành Dự án",
      "Custom non-recruitment dept",
      nextUuid(),
      computeCreateDepartmentFingerprint({
        actor_app_user_id: OWNER.app,
        code: "CUSTOM_OPS",
        name: "Vận hành Dự án",
        reason: "Custom non-recruitment dept",
      }),
    ]);
    const customDeptId = customDeptRes.data.department.department_id;
    const { rows: [customDeptDb] } = await db.query(
      "select system_key, is_active from public.organization_departments where department_id = $1::uuid",
      [customDeptId],
    );
    assert.equal(customDeptDb.system_key, null, "Custom department MUST have system_key IS NULL");
    assert.equal(customDeptDb.is_active, true);

    const TEAM_A = nextUuid();
    const TEAM_B = nextUuid();
    await db.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'WP10_TEAM_A', 'Đội Tuyển Dụng A', true, 1),
              ($2::uuid, 'WP10_TEAM_B', 'Đội Tuyển Dụng B', true, 1)`,
      [TEAM_A, TEAM_B],
    );

    // -------------------------------------------------------------------------
    // 2. Standard Org -> Team/Leader + Custom Dept (system_key IS NULL) x 3 (T0 #2)
    // -------------------------------------------------------------------------
    // (a) Create Person in RECRUITMENT + linked Account + create personnel via /from-account RPC
    const accRec = await seedPlainAccount(db, "wp10.rec1", "Tuyển Dụng 1");
    const createRecRes = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth,
      OWNER.app,
      "EMP-WP10-01",
      accRec.name,
      "2026-10-01",
      deptByKey.RECRUITMENT,
      accRec.app,
      1,
      null,
      "Onboard RECRUITMENT",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-01",
        full_name: accRec.name,
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.RECRUITMENT,
        account_ref: accRec.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Onboard RECRUITMENT",
      }),
    ])).rows[0].data;
    const personRec = createRecRes.person.person_id;
    const recMembershipId = createRecRes.person.active_department.membership_id;

    // Create recruiter profile via /from-account RPC (valid_from = null -> server date 2026-11-24)
    const fromAcc1 = (await serviceQuery(db, CREATE_PERSONNEL_FROM_ACC_SQL, [
      OWNER.auth,
      OWNER.app,
      accRec.app,
      createRecRes.person.active_account_link.account_version,
      accRec.login,
      "STAFF",
      null,
      "Activate recruiter",
      nextUuid(),
    ])).rows[0].data;
    const recruiter1 = fromAcc1.recruiter_id;

    // Non-RECRUITMENT Person (no G1/G2/G3 yet): creating plain HRP recruiter succeeds, then Team/Leader assignment is blocked!
    const accMkt = await seedPlainAccount(db, "wp10.mkt1", "Marketing 1");
    const createMktRes = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth,
      OWNER.app,
      "EMP-WP10-02",
      accMkt.name,
      "2026-10-01",
      deptByKey.MARKETING,
      accMkt.app,
      1,
      null,
      "Onboard MARKETING",
      nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-02",
        full_name: accMkt.name,
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.MARKETING,
        account_ref: accMkt.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Onboard MARKETING",
      }),
    ])).rows[0].data;
    const recMkt = (await serviceQuery(db, CREATE_PERSONNEL_FROM_ACC_SQL, [
      OWNER.auth,
      OWNER.app,
      accMkt.app,
      createMktRes.person.active_account_link.account_version,
      accMkt.login,
      "STAFF",
      null,
      "Plain HRP recruiter on Marketing person",
      nextUuid(),
    ])).rows[0].data.recruiter_id;
    await assert.rejects(
      () => serviceQuery(db, ASSIGN_TEAM_SQL, [
        OWNER.auth, OWNER.app, recMkt, TEAM_A, null, 1, "Blocked team assign for Marketing", nextUuid(),
      ]),
      (err) => err?.code === "23514",
    );
    await assert.rejects(
      () => serviceQuery(db, DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, TEAM_B, accMkt.app, null, 1, "Blocked TL designate for Marketing", nextUuid(),
      ]),
      (err) => err?.code === "23514",
    );

    // Non-RECRUITMENT Person WITH pre-existing G2/G3 on Account (even without recruiter_id) MUST block create_personnel with PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT!
    const accMktBlocked = await seedPlainAccount(db, "wp10.mktblk", "Marketing Blocked");
    const createMktBlockedRes = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, "EMP-WP10-02B", accMktBlocked.name, "2026-10-01", deptByKey.MARKETING,
      accMktBlocked.app, 1, null, "Onboard MARKETING for create_personnel guard", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-02B",
        full_name: accMktBlocked.name,
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.MARKETING,
        account_ref: accMktBlocked.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "Onboard MARKETING for create_personnel guard",
      }),
    ])).rows[0].data;
    const dummyRec = nextUuid();
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, active, version) values ($1::uuid, 'Dummy G3 Rec', true, 1)",
      [dummyRec],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current, suspended_by_account_disable)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-11-24', null, false, true)`,
      [TEAM_B, accMktBlocked.app, dummyRec],
    );
    await assert.rejects(
      () => serviceQuery(db, CREATE_PERSONNEL_FROM_ACC_SQL, [
        OWNER.auth,
        OWNER.app,
        accMktBlocked.app,
        createMktBlockedRes.person.active_account_link.account_version,
        accMktBlocked.login,
        "STAFF",
        null,
        "Blocked create personnel when Account holds suspended G3 on Marketing",
        nextUuid(),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // Assign Team A to recruiter1 (p_valid_from = null -> 2026-11-24), and test Cross-Midnight Retry!
    const crossMidnightAssignKey = nextUuid();
    const tmAssign1 = (await serviceQuery(db, ASSIGN_TEAM_SQL, [
      OWNER.auth,
      OWNER.app,
      recruiter1,
      TEAM_A,
      null,
      1,
      "Assign Team A immediate",
      crossMidnightAssignKey,
    ])).rows[0].data;
    assert.equal(tmAssign1.valid_from, "2026-11-24");

    // Advance clock past midnight (2026-11-25) and replay lost response with p_valid_from = null & same key (T0 #3)!
    await setBusinessDate(db, "2026-11-25");
    const tmAssignReplay = (await serviceQuery(db, ASSIGN_TEAM_SQL, [
      OWNER.auth,
      OWNER.app,
      recruiter1,
      TEAM_A,
      null,
      1,
      "Assign Team A immediate",
      crossMidnightAssignKey,
    ])).rows[0].data;
    assert.deepEqual(tmAssignReplay, tmAssign1, "Cross-midnight lost-response replay must return Day-1 result");
    await setBusinessDate(db, "2026-11-24");

    // Designate recruiter1 as Team A Leader (p_effective_date = null) and verify Cross-Midnight Replay!
    const crossMidnightTlKey = nextUuid();
    const tlDesignate1 = (await serviceQuery(db, DESIGNATE_TL_SQL, [
      OWNER.auth,
      OWNER.app,
      TEAM_A,
      accRec.app,
      null,
      1,
      "Designate Team A Leader",
      crossMidnightTlKey,
    ])).rows[0].data;
    assert.equal(tlDesignate1.valid_from, "2026-11-24");
    await setBusinessDate(db, "2026-11-25");
    const tlDesignateReplay = (await serviceQuery(db, DESIGNATE_TL_SQL, [
      OWNER.auth,
      OWNER.app,
      TEAM_A,
      accRec.app,
      null,
      1,
      "Designate Team A Leader",
      crossMidnightTlKey,
    ])).rows[0].data;
    assert.deepEqual(tlDesignateReplay, tlDesignate1, "Cross-midnight TL replay must return Day-1 result");
    await setBusinessDate(db, "2026-11-24");

    // Active G1 + G2 MUST block ALL Org exits / transitions:
    // - transfer to CUSTOM_OPS (system_key IS NULL) — T0 #2
    // - transfer to MARKETING
    // - end RECRUITMENT membership
    // - assign_accounting_member
    // - update_person_admin(INACTIVE)
    // - unlink_account_person_admin
    const { rows: [p1Cur] } = await db.query(
      `select p.version as pv, l.link_id, u.version as av
         from public.organization_persons p
         join public.organization_account_person_links l on l.person_id = p.person_id and l.ended_at is null
         join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
        where p.person_id = $1::uuid`,
      [personRec],
    );
    await assert.rejects(
      () => serviceQuery(db, TRANSFER_MEMBER_SQL, [
        OWNER.auth, OWNER.app, personRec, customDeptId, p1Cur.pv, recMembershipId, "Transfer custom", nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, personRec, {
          target_department_ref: customDeptId,
          expected_person_version: p1Cur.pv,
          expected_current_membership_id: recMembershipId,
          reason: "Transfer custom",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, TRANSFER_MEMBER_SQL, [
        OWNER.auth, OWNER.app, personRec, deptByKey.MARKETING, p1Cur.pv, recMembershipId, "Transfer mkt", nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, personRec, {
          target_department_ref: deptByKey.MARKETING,
          expected_person_version: p1Cur.pv,
          expected_current_membership_id: recMembershipId,
          reason: "Transfer mkt",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, END_MEMBER_SQL, [
        OWNER.auth, OWNER.app, deptByKey.RECRUITMENT, recMembershipId, p1Cur.pv, "End RECRUITMENT", nextUuid(),
        computeEndPersonMemberFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: deptByKey.RECRUITMENT,
          membership_id: recMembershipId,
          expected_person_version: p1Cur.pv,
          reason: "End RECRUITMENT",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, ASSIGN_ACCOUNTING_SQL, [
        OWNER.auth, OWNER.app, accRec.app, 0, null, "Assign Accounting", nextUuid(),
        computeAssignAccountingMemberFingerprint({
          actor_app_user_id: OWNER.app,
          account_ref: accRec.app,
          expected_pair_version: 0,
          effective_from: null,
          reason: "Assign Accounting",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, UPDATE_PERSON_SQL, [
        OWNER.auth, OWNER.app, personRec, p1Cur.pv, "EMP-WP10-01", accRec.name, "2026-10-01", "INACTIVE", "Deactivate", nextUuid(),
        computeUpdatePersonFingerprint(OWNER.app, personRec, {
          expected_person_version: p1Cur.pv,
          employee_code: "EMP-WP10-01",
          full_name: accRec.name,
          joined_on: "2026-10-01",
          status: "INACTIVE",
          reason: "Deactivate",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, UNLINK_ACCOUNT_PERSON_SQL, [
        OWNER.auth, OWNER.app, accRec.app, p1Cur.av, p1Cur.pv, p1Cur.link_id, "Unlink", nextUuid(),
        computeUnlinkAccountPersonFingerprint(OWNER.app, accRec.app, {
          expected_account_version: p1Cur.av,
          expected_person_version: p1Cur.pv,
          expected_link_id: p1Cur.link_id,
          reason: "Unlink",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // -------------------------------------------------------------------------
    // Test remaining two IS DISTINCT FROM 'RECRUITMENT' operations (T0 #2):
    //   create_person_admin(..., CUSTOM_OPS, recruiter_id=recWithApiG1)
    //   assign_person_member_admin(..., CUSTOM_OPS, personId)
    // Seed unlinked recruiter with API-created G1 (via RECRUITMENT person -> or unlinked pre-WP10 legacy API G1)
    // -------------------------------------------------------------------------
    const accCustG1 = await seedPlainAccount(db, "wp10.custg1", "Custom Guard G1");
    const recCustG1 = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, $2, $3, 'STAFF', true, 1)`,
      [recCustG1, accCustG1.name, accCustG1.login],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
      [recCustG1],
    );
    // Create temporary RECRUITMENT Person to obtain genuine API G1, OR test assign_person_member_admin on unassigned person
    const tmpUnassignedPerson = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, "EMP-WP10-UNASS", "Unassigned G1", "2026-10-01", deptByKey.RECRUITMENT, null, null, recCustG1,
      "Temp RECRUITMENT for API G1", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-UNASS",
        full_name: "Unassigned G1",
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.RECRUITMENT,
        account_ref: null,
        expected_account_version: null,
        recruiter_id: recCustG1,
        reason: "Temp RECRUITMENT for API G1",
      }),
    ])).rows[0].data.person;
    await serviceQuery(db, ASSIGN_TEAM_SQL, [
      OWNER.auth, OWNER.app, recCustG1, TEAM_B, null, 2, "API G1 before detach check", nextUuid(),
    ]);
    // Transfer tmpUnassignedPerson to customDeptId blocked by API G1!
    await assert.rejects(
      () => serviceQuery(db, TRANSFER_MEMBER_SQL, [
        OWNER.auth, OWNER.app, tmpUnassignedPerson.person_id, customDeptId, tmpUnassignedPerson.version,
        tmpUnassignedPerson.active_department.membership_id, "Transfer to custom blocked", nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, tmpUnassignedPerson.person_id, {
          target_department_ref: customDeptId,
          expected_person_version: tmpUnassignedPerson.version,
          expected_current_membership_id: tmpUnassignedPerson.active_department.membership_id,
          reason: "Transfer to custom blocked",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // Build an unassigned Person linked to a Recruiter holding API G1 (detach simulated via pre-existing G1 fixture)
    const recCreateCustG1 = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, 'Legacy API G1', 'legacy.apig1', 'STAFF', true, 1)`,
      [recCreateCustG1],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
      [recCreateCustG1],
    );
    await serviceQuery(db, ASSIGN_TEAM_SQL, [
      OWNER.auth, OWNER.app, recCreateCustG1, TEAM_B, null, 1, "API G1 on unmapped recruiter", nextUuid(),
    ]);

    // (2a) create_person_admin into CUSTOM_OPS (system_key IS NULL) MUST block!
    await assert.rejects(
      () => serviceQuery(db, CREATE_PERSON_SQL, [
        OWNER.auth, OWNER.app, "EMP-WP10-C1", "Create Custom G1", "2026-10-01", customDeptId, null, null, recCreateCustG1,
        "Create into custom dept", nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: "EMP-WP10-C1",
          full_name: "Create Custom G1",
          joined_on: "2026-10-01",
          initial_department_ref: customDeptId,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: recCreateCustG1,
          reason: "Create into custom dept",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // Also verify create_person_admin with initial_department_id = null blocks when recruiter has G1
    await assert.rejects(
      () => serviceQuery(db, CREATE_PERSON_SQL, [
        OWNER.auth, OWNER.app, "EMP-WP10-C1N", "Null Dept Custom G1", "2026-10-01", null, null, null, recCreateCustG1,
        "Create null dept with G1", nextUuid(),
        computeCreatePersonFingerprint(OWNER.app, {
          employee_code: "EMP-WP10-C1N",
          full_name: "Null Dept Custom G1",
          joined_on: "2026-10-01",
          initial_department_ref: null,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: recCreateCustG1,
          reason: "Create null dept with G1",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // (2b) Defensive fixture: Person created without dept + drifted G1 -> assign_person_member_admin into CUSTOM_OPS blocks, into RECRUITMENT heals!
    const recAssignCustG1 = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, 'Assign Custom G1', 'assign.custg1', 'STAFF', true, 1)`,
      [recAssignCustG1],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
      [recAssignCustG1],
    );
    const createdNullDept = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, "EMP-WP10-C2", "Unassigned Custom G1", "2026-10-01", null, null, null, recAssignCustG1,
      "Create unassigned", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-C2",
        full_name: "Unassigned Custom G1",
        joined_on: "2026-10-01",
        initial_department_ref: null,
        account_ref: null,
        expected_account_version: null,
        recruiter_id: recAssignCustG1,
        reason: "Create unassigned",
      }),
    ])).rows[0].data.person;
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-11-24', true)`,
      [recAssignCustG1, TEAM_B],
    );
    await assert.rejects(
      () => serviceQuery(db, ASSIGN_MEMBER_SQL, [
        OWNER.auth, OWNER.app, customDeptId, createdNullDept.person_id, createdNullDept.version, "Assign custom", nextUuid(),
        computeAssignPersonMemberFingerprint({
          actor_app_user_id: OWNER.app,
          department_id: customDeptId,
          person_id: createdNullDept.person_id,
          expected_person_version: createdNullDept.version,
          reason: "Assign custom",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    const healedNullDept = (await serviceQuery(db, ASSIGN_MEMBER_SQL, [
      OWNER.auth, OWNER.app, deptByKey.RECRUITMENT, createdNullDept.person_id, createdNullDept.version, "Heal to RECRUITMENT", nextUuid(),
      computeAssignPersonMemberFingerprint({
        actor_app_user_id: OWNER.app,
        department_id: deptByKey.RECRUITMENT,
        person_id: createdNullDept.person_id,
        expected_person_version: createdNullDept.version,
        reason: "Heal to RECRUITMENT",
      }),
    ])).rows[0].data;
    assert.equal(healedNullDept.membership.department_id, deptByKey.RECRUITMENT);

    // -------------------------------------------------------------------------
    // 3. Account Disable Suspension Ca S1..S3
    // -------------------------------------------------------------------------
    await serviceQuery(db, DISABLE_USER_SQL, [
      OWNER.auth, OWNER.app, accRec.app, p1Cur.av, "Disable user suspends link and TL", nextUuid(),
    ]);
    // Verify suspended link & TL STILL block transfer/end/deactivate/unlink!
    await assert.rejects(
      () => serviceQuery(db, TRANSFER_MEMBER_SQL, [
        OWNER.auth, OWNER.app, personRec, deptByKey.MARKETING, p1Cur.pv, recMembershipId, "Transfer while suspended", nextUuid(),
        computeTransferPersonDepartmentFingerprint(OWNER.app, personRec, {
          target_department_ref: deptByKey.MARKETING,
          expected_person_version: p1Cur.pv,
          expected_current_membership_id: recMembershipId,
          reason: "Transfer while suspended",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    await assert.rejects(
      () => serviceQuery(db, UNLINK_ACCOUNT_PERSON_SQL, [
        OWNER.auth, OWNER.app, accRec.app, p1Cur.av + 1, p1Cur.pv, p1Cur.link_id, "Unlink while suspended", nextUuid(),
        computeUnlinkAccountPersonFingerprint(OWNER.app, accRec.app, {
          expected_account_version: p1Cur.av + 1,
          expected_person_version: p1Cur.pv,
          expected_link_id: p1Cur.link_id,
          reason: "Unlink while suspended",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    // Re-enable while Org valid -> TL restored cleanly!
    await serviceQuery(db, ENABLE_USER_SQL, [
      OWNER.auth, OWNER.app, accRec.app, p1Cur.av + 1, "Enable restores valid TL", nextUuid(),
    ]);
    const { rows: [tlAfterEnable] } = await db.query(
      `select is_current, suspended_by_account_disable from public.direct_entry_team_leader_assignments
        where team_id = $1::uuid and leader_app_user_id = $2::uuid and valid_to is null`,
      [TEAM_A, accRec.app],
    );
    assert.deepEqual(tlAfterEnable, { is_current: true, suspended_by_account_disable: false });

    // Disable again, simulate Org drift (person -> INACTIVE), then re-enable -> TL NOT restored and closed safely!
    await serviceQuery(db, DISABLE_USER_SQL, [
      OWNER.auth, OWNER.app, accRec.app, p1Cur.av + 2, "Disable before drift fixture", nextUuid(),
    ]);
    await db.query(
      "update public.organization_persons set status = 'INACTIVE', deactivated_at = now() where person_id = $1::uuid",
      [personRec],
    );
    await serviceQuery(db, ENABLE_USER_SQL, [
      OWNER.auth, OWNER.app, accRec.app, p1Cur.av + 3, "Enable with drifted Org", nextUuid(),
    ]);
    const { rows: [tlAfterDriftEnable] } = await db.query(
      `select is_current, suspended_by_account_disable, valid_to::text from public.direct_entry_team_leader_assignments
        where team_id = $1::uuid and leader_app_user_id = $2::uuid order by created_at desc limit 1`,
      [TEAM_A, accRec.app],
    );
    assert.equal(tlAfterDriftEnable.is_current, false);
    assert.equal(tlAfterDriftEnable.suspended_by_account_disable, false);
    assert.equal(tlAfterDriftEnable.valid_to, "2026-11-24");

    // -------------------------------------------------------------------------
    // 4. Defensive Fixtures: Ca D1 (drifted G1) & Ca D2 (error precedence)
    // -------------------------------------------------------------------------
    // Ca D1: personRec is INACTIVE and still has G1 (recruiter1 in TEAM_A). Move to TEAM_B blocked; Unassign allowed!
    await assert.rejects(
      () => serviceQuery(db, MOVE_TEAM_SQL, [
        OWNER.auth, OWNER.app, recruiter1, TEAM_B, null, 2, "Move while drifted INACTIVE", nextUuid(),
      ]),
      (err) => err?.code === "23514",
    );
    const unassignDrifted = (await serviceQuery(db, UNASSIGN_TEAM_SQL, [
      OWNER.auth, OWNER.app, recruiter1, null, 2, "Close drifted G1", nextUuid(),
    ])).rows[0].data;
    assert.equal(unassignDrifted.valid_to, "2026-11-24");

    // Ca D2: Error precedence — linking Account + Recruiter with active G1 to an INACTIVE Person
    // raises PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT BEFORE PERSON_INACTIVE!
    const inactivePerson = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, "EMP-WP10-INACT", "Inactive Target", "2026-10-01", deptByKey.RECRUITMENT, null, null, null,
      "Inactive person setup", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-INACT",
        full_name: "Inactive Target",
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.RECRUITMENT,
        account_ref: null,
        expected_account_version: null,
        recruiter_id: null,
        reason: "Inactive person setup",
      }),
    ])).rows[0].data.person;
    await serviceQuery(db, UPDATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, inactivePerson.person_id, inactivePerson.version, "EMP-WP10-INACT", "Inactive Target",
      "2026-10-01", "INACTIVE", "Set INACTIVE before link", nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, inactivePerson.person_id, {
        expected_person_version: inactivePerson.version,
        employee_code: "EMP-WP10-INACT",
        full_name: "Inactive Target",
        joined_on: "2026-10-01",
        status: "INACTIVE",
        reason: "Set INACTIVE before link",
      }),
    ]);
    const recPrecLinkAcc = nextUuid();
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, 'Legacy Prec G1', 'legacy.precg1', 'STAFF', true, 1)`,
      [recPrecLinkAcc],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
      [recPrecLinkAcc],
    );
    await serviceQuery(db, ASSIGN_TEAM_SQL, [
      OWNER.auth, OWNER.app, recPrecLinkAcc, TEAM_B, null, 1, "Legacy API G1 before link prec", nextUuid(),
    ]);
    const accLinkPrec = await seedPlainAccount(db, "wp10.linkprec", "Link Prec");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-11-24', true)`,
      [accLinkPrec.app, recPrecLinkAcc],
    );
    await assert.rejects(
      () => serviceQuery(db, LINK_ACCOUNT_PERSON_SQL, [
        OWNER.auth, OWNER.app, accLinkPrec.app, inactivePerson.person_id, 1, inactivePerson.version + 1, recPrecLinkAcc,
        "Blocked link to inactive person", nextUuid(),
        computeLinkAccountPersonFingerprint(OWNER.app, accLinkPrec.app, {
          person_id: inactivePerson.person_id,
          expected_account_version: 1,
          expected_person_version: inactivePerson.version + 1,
          confirmed_recruiter_id: recPrecLinkAcc,
          reason: "Blocked link to inactive person",
        }),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );
    // Test direct_entry_account_operation_link_recruiter error precedence with active G1 on recCreateCustG1 -> inactive Person!
    const accInactiveLinked = await seedPlainAccount(db, "wp10.inactlink", "Inactive Linked");
    const accInactPerson = (await serviceQuery(db, CREATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, "EMP-WP10-INL", accInactiveLinked.name, "2026-10-01", deptByKey.RECRUITMENT,
      accInactiveLinked.app, 1, null, "RECRUITMENT before INACTIVE", nextUuid(),
      computeCreatePersonFingerprint(OWNER.app, {
        employee_code: "EMP-WP10-INL",
        full_name: accInactiveLinked.name,
        joined_on: "2026-10-01",
        initial_department_ref: deptByKey.RECRUITMENT,
        account_ref: accInactiveLinked.app,
        expected_account_version: 1,
        recruiter_id: null,
        reason: "RECRUITMENT before INACTIVE",
      }),
    ])).rows[0].data.person;
    await serviceQuery(db, UPDATE_PERSON_SQL, [
      OWNER.auth, OWNER.app, accInactPerson.person_id, accInactPerson.version, "EMP-WP10-INL", accInactiveLinked.name,
      "2026-10-01", "INACTIVE", "Deactivate before link_recruiter", nextUuid(),
      computeUpdatePersonFingerprint(OWNER.app, accInactPerson.person_id, {
        expected_person_version: accInactPerson.version,
        employee_code: "EMP-WP10-INL",
        full_name: accInactiveLinked.name,
        joined_on: "2026-10-01",
        status: "INACTIVE",
        reason: "Deactivate before link_recruiter",
      }),
    ]);
    await assert.rejects(
      () => serviceQuery(db, LINK_RECRUITER_SQL, [
        OWNER.auth, OWNER.app, recCreateCustG1, 2, accInactiveLinked.app, accInactPerson.active_account_link.account_version,
        "Precedence test", nextUuid(),
      ]),
      (err) => err?.code === "PT409" && err?.message?.includes("PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT"),
    );

    // -------------------------------------------------------------------------
    // 5. Defensive Fixture Ca D3 (BOTH branches on same-day TL revoke — T0 #4):
    //    Day 0 (2026-11-23): Leader A designated on TEAM_B
    //    Day 1 (2026-11-24): Leader A replaced by Leader B
    //    Revoke B on Day 1:
    //      Branch 1: A's Org is valid (ACTIVE + RECRUITMENT) -> B closes 0-length + grants closed; A + grants restored!
    //      Branch 2: A's Org drifted (via fixture to INACTIVE) -> Revoke B STILL SUCCEEDS, closes B with 0-length
    //                cancel marker & closes B's grants, while A & A's grants REMAIN CLOSED!
    // -------------------------------------------------------------------------
    async function setupLeaderPairForD3(tag, driftBeforeRevoke) {
      const tId = nextUuid();
      await db.query(
        `insert into public.teams (team_id, code, display_name, active, version)
         values ($1::uuid, $2, $3, true, 1)`,
        [tId, `WP10_D3_${tag}`, `D3 Team ${tag}`],
      );
      const userA = await seedPlainAccount(db, `d3.${tag}.a`, `Leader A ${tag}`);
      const userB = await seedPlainAccount(db, `d3.${tag}.b`, `Leader B ${tag}`);
      const mkRecruiter = async (u, code) => {
        const p = (await serviceQuery(db, CREATE_PERSON_SQL, [
          OWNER.auth, OWNER.app, code, u.name, "2026-10-01", deptByKey.RECRUITMENT, u.app, 1, null,
          "D3 onboard", nextUuid(),
          computeCreatePersonFingerprint(OWNER.app, {
            employee_code: code,
            full_name: u.name,
            joined_on: "2026-10-01",
            initial_department_ref: deptByKey.RECRUITMENT,
            account_ref: u.app,
            expected_account_version: 1,
            recruiter_id: null,
            reason: "D3 onboard",
          }),
        ])).rows[0].data.person;
        const r = (await serviceQuery(db, CREATE_PERSONNEL_FROM_ACC_SQL, [
          OWNER.auth, OWNER.app, u.app, p.active_account_link.account_version, u.login, "TEAM_LEADER", null,
          "D3 activate", nextUuid(),
        ])).rows[0].data;
        await serviceQuery(db, ASSIGN_TEAM_SQL, [
          OWNER.auth, OWNER.app, r.recruiter_id, tId, null, 1, "D3 team member", nextUuid(),
        ]);
        return { personId: p.person_id, recruiterId: r.recruiter_id };
      };

      await setBusinessDate(db, "2026-11-23");
      const metaA = await mkRecruiter(userA, `EMP-D3-${tag}-A`);
      await mkRecruiter(userB, `EMP-D3-${tag}-B`);
      await serviceQuery(db, DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, tId, userA.app, null, 1, "Day 0 designate A", nextUuid(),
      ]);

      await setBusinessDate(db, "2026-11-24");
      await serviceQuery(db, DESIGNATE_TL_SQL, [
        OWNER.auth, OWNER.app, tId, userB.app, null, 2, "Day 1 replace A with B", nextUuid(),
      ]);

      if (driftBeforeRevoke) {
        await db.query(
          "update public.organization_persons set status = 'INACTIVE', deactivated_at = now() where person_id = $1::uuid",
          [metaA.personId],
        );
      }

      const revokeRes = (await serviceQuery(db, REVOKE_TL_SQL, [
        OWNER.auth, OWNER.app, tId, null, 3, `Day 1 revoke B (${tag})`, nextUuid(),
      ])).rows[0].data;

      const { rows: assigns } = await db.query(
        `select leader_app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_team_leader_assignments
          where team_id = $1::uuid order by valid_from asc`,
        [tId],
      );
      const { rows: scopeGrants } = await db.query(
        `select app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_scope_grants
          where team_id = $1::uuid and scope_kind = 'team' order by valid_from asc, app_user_id::text`,
        [tId],
      );
      const { rows: capGrants } = await db.query(
        `select app_user_id::text as uid, valid_from::text, valid_to::text, is_current
           from public.direct_entry_capability_grants
          where app_user_id = any($1::uuid[]) and capability = 'team_manager_assign'
          order by valid_from asc, app_user_id::text`,
        [[userA.app, userB.app]],
      );
      return { revokeRes, assigns, scopeGrants, capGrants, userA, userB };
    }

    // D3 Branch 1: A's Org is valid -> A & grants RESTORED
    const d3Valid = await setupLeaderPairForD3("VALID", false);
    assert.equal(d3Valid.revokeRes.valid_from, "2026-11-24");
    assert.equal(d3Valid.revokeRes.valid_to, "2026-11-24");
    const rowAValid = d3Valid.assigns.find((a) => a.uid === d3Valid.userA.app);
    const rowBValid = d3Valid.assigns.find((a) => a.uid === d3Valid.userB.app);
    assert.deepEqual(rowAValid, { uid: d3Valid.userA.app, valid_from: "2026-11-23", valid_to: null, is_current: true });
    assert.deepEqual(rowBValid, { uid: d3Valid.userB.app, valid_from: "2026-11-24", valid_to: "2026-11-24", is_current: false });
    assert.equal(d3Valid.scopeGrants.find((g) => g.uid === d3Valid.userA.app)?.is_current, true);
    assert.equal(d3Valid.scopeGrants.find((g) => g.uid === d3Valid.userA.app)?.valid_to, null);
    assert.equal(d3Valid.scopeGrants.find((g) => g.uid === d3Valid.userB.app)?.is_current, false);
    assert.equal(d3Valid.capGrants.find((g) => g.uid === d3Valid.userA.app)?.is_current, true);
    assert.equal(d3Valid.capGrants.find((g) => g.uid === d3Valid.userB.app)?.is_current, false);

    // D3 Branch 2: A's Org drifted (INACTIVE) -> B still closes with 0-length cancel marker, A & grants STAY CLOSED!
    const d3Drifted = await setupLeaderPairForD3("DRIFT", true);
    assert.equal(d3Drifted.revokeRes.valid_from, "2026-11-24");
    assert.equal(d3Drifted.revokeRes.valid_to, "2026-11-24");
    const rowADrifted = d3Drifted.assigns.find((a) => a.uid === d3Drifted.userA.app);
    const rowBDrifted = d3Drifted.assigns.find((a) => a.uid === d3Drifted.userB.app);
    assert.deepEqual(rowADrifted, {
      uid: d3Drifted.userA.app,
      valid_from: "2026-11-23",
      valid_to: "2026-11-24",
      is_current: false,
    });
    assert.deepEqual(rowBDrifted, {
      uid: d3Drifted.userB.app,
      valid_from: "2026-11-24",
      valid_to: "2026-11-24",
      is_current: false,
    });
    assert.equal(d3Drifted.scopeGrants.find((g) => g.uid === d3Drifted.userA.app)?.is_current, false);
    assert.equal(d3Drifted.scopeGrants.find((g) => g.uid === d3Drifted.userA.app)?.valid_to, "2026-11-24");
    assert.equal(d3Drifted.scopeGrants.find((g) => g.uid === d3Drifted.userB.app)?.is_current, false);
    assert.equal(d3Drifted.capGrants.find((g) => g.uid === d3Drifted.userA.app)?.is_current, false);
    assert.equal(d3Drifted.capGrants.find((g) => g.uid === d3Drifted.userB.app)?.is_current, false);
  } finally {
    await db.close();
  }
});
